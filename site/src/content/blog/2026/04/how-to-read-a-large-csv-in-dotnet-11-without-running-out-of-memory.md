---
title: "How to read a large CSV in .NET 11 without running out of memory"
description: "Stream a multi-gigabyte CSV in .NET 11 without OutOfMemoryException. File.ReadLines, CsvHelper, Sylvan, and Pipelines compared with code and measurements."
pubDate: 2026-04-24
tags:
  - "dotnet-11"
  - "csharp-14"
  - "performance"
  - "csv"
  - "streaming"
---

If your process dies with `OutOfMemoryException` while reading a CSV, the fix is almost always the same one sentence: stop materialising the file, start streaming it. On .NET 11 and C# 14, `File.ReadLines` covers 80% of cases, `CsvHelper.GetRecords<T>()` covers typed parsing without buffering, and `Sylvan.Data.Csv` plus `System.IO.Pipelines` give you the last order of magnitude when the file is in the 5-50 GB range. The worst thing you can do is call `File.ReadAllLines` or `File.ReadAllText` on anything bigger than a few megabytes, because both load the whole payload into a `string[]` that has to live on the Large Object Heap until the GC is convinced nobody is touching it.

This post walks through the four techniques in order of complexity, shows what each one actually allocates, and highlights the gotchas that will bite you when the CSV has quoted multi-line fields, a BOM, or needs to be cancelled mid-read. Versions used throughout: .NET 11, C# 14, `CsvHelper 33.x`, `Sylvan.Data.Csv 1.4.x`.

## Why your CSV reader is allocating gigabytes

A 2 GB UTF-8 CSV becomes a roughly 4 GB `string` in memory, because .NET strings are UTF-16. `File.ReadAllLines` goes further and also allocates a `string` per line, plus the `string[]` array that holds them. On a file with 20 million rows you end up with 20 million heap objects, the top-level array on the Large Object Heap, and a generation 2 GC pause in the tens of seconds when the pressure finally forces a collection. On 32-bit processes or constrained containers the process just dies.

The fix is to read one record at a time and let each record become eligible for garbage collection before the next one is parsed. That is the definition of streaming, and every technique below is a different point on the ergonomics vs throughput curve.

## The one-line upgrade: `File.ReadLines`

`File.ReadAllLines` returns `string[]`. `File.ReadLines` returns `IEnumerable<string>` and reads lazily. Swapping one for the other is often enough.

```csharp
// .NET 11, C# 14
using System.Globalization;

int rowCount = 0;
decimal total = 0m;

foreach (string line in File.ReadLines("orders.csv"))
{
    if (rowCount++ == 0) continue; // header

    ReadOnlySpan<char> span = line;
    int firstComma = span.IndexOf(',');
    int secondComma = span[(firstComma + 1)..].IndexOf(',') + firstComma + 1;

    ReadOnlySpan<char> amountSlice = span[(secondComma + 1)..];
    total += decimal.Parse(amountSlice, CultureInfo.InvariantCulture);
}

Console.WriteLine($"{rowCount - 1} rows, total = {total}");
```

Steady-state allocation here is one `string` per line plus whatever the `decimal.Parse` overload needs. Peak working set stays flat at a few megabytes regardless of file size, because the enumerator reads through a 4 KB `StreamReader` buffer under the hood.

Two caveats that will bite you if you rely on this for real data.

First, `File.ReadLines` has no awareness of CSV quoting. A cell containing `"first line\r\nsecond line"` becomes two records. If your data comes from Excel, Salesforce exports, or anywhere humans type, you will hit this within a week.

Second, the enumerator opens the file and holds the handle until you dispose the enumerator or iterate it to completion. If you break out of the loop early, the handle is released when the enumerator is finalised, which is non-deterministic. Wrap the usage in an explicit `IEnumerator<string>` with `using` if that matters for your scenario.

## Async streaming with `StreamReader.ReadLineAsync`

If you are reading from a network share, an S3 bucket, or anywhere with latency, the synchronous `foreach` blocks a thread per file. `StreamReader.ReadLineAsync` (overloaded in .NET 7+ to return `ValueTask<string?>`) and `IAsyncEnumerable<string>` are the right primitives.

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<string> ReadLinesAsync(
    string path,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    using var stream = new FileStream(
        path,
        new FileStreamOptions
        {
            Access = FileAccess.Read,
            Mode = FileMode.Open,
            Share = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
            BufferSize = 64 * 1024,
        });

    using var reader = new StreamReader(stream);

    while (await reader.ReadLineAsync(ct) is { } line)
    {
        yield return line;
    }
}
```

Two production-relevant knobs are set here. `FileOptions.SequentialScan` tells the OS to use aggressive read-ahead and drop pages after you move past them, which keeps the page cache from thrashing when the file is bigger than RAM. `BufferSize = 64 * 1024` is four times the default and measurably reduces syscall count on NVMe storage; going higher than 64 KB rarely helps.

If you need to honour cancellation deterministically, combine this with a `CancellationTokenSource` that has a timeout. For a longer discussion of how to wire cancellation through an async pipeline without deadlocking, see [cancelling a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Typed parsing without buffering: CsvHelper's `GetRecords<T>()`

Raw lines are fine for trivially-shaped data. For anything with nullable columns, quoted delimiters, or headers you want mapped to a POCO, CsvHelper is the default. The key point is that `GetRecords<T>()` returns `IEnumerable<T>` and reuses a single record instance across the enumeration. If you materialise that enumerable with `.ToList()`, you have defeated the entire library.

```csharp
// .NET 11, C# 14, CsvHelper 33.x
using System.Globalization;
using CsvHelper;
using CsvHelper.Configuration;

public sealed record Order(int Id, string Sku, decimal Amount, DateTime PlacedAt);

static async Task ProcessAsync(string path, CancellationToken ct)
{
    var config = new CsvConfiguration(CultureInfo.InvariantCulture)
    {
        HasHeaderRecord = true,
        MissingFieldFound = null,   // tolerate missing optional columns
        BadDataFound = null,        // silently skip malformed quotes; log these in prod
    };

    using var reader = new StreamReader(path);
    using var csv = new CsvReader(reader, config);

    await foreach (Order order in csv.GetRecordsAsync<Order>(ct))
    {
        // process one record; do NOT cache `order`, it is reused under synchronous mode
    }
}
```

`GetRecordsAsync<T>` returns `IAsyncEnumerable<T>` and internally uses `ReadAsync`, so a slow disk or network stream does not starve the thread pool. Because the type is a `record` with an explicit constructor, CsvHelper generates per-column setters once via reflection and then reuses the path for every row. On a 1 GB orders file with 12 columns this parses at roughly 600 K rows per second on a modern laptop with working set pinned under 30 MB.

The caveat that catches people coming from `DataTable`: the object you get inside the loop is the same instance every iteration when CsvHelper is using its reuse path. If you need to capture rows into a downstream queue, clone them explicitly or project to a new record with `with` expressions.

## Maximum throughput: Sylvan.Data.Csv and `DbDataReader`

CsvHelper is convenient. It is not the fastest. When you need to push 100 MB/s through a single core, `Sylvan.Data.Csv` is the library that ships a `DbDataReader` over a CSV with almost no allocation per cell. It avoids the `string` per field by exposing `GetFieldSpan` and parses numbers directly out of the underlying `char` buffer.

```csharp
// .NET 11, C# 14, Sylvan.Data.Csv 1.4.x
using Sylvan.Data.Csv;

using var reader = CsvDataReader.Create(
    "orders.csv",
    new CsvDataReaderOptions
    {
        HasHeaders = true,
        BufferSize = 0x10000, // 64 KB
    });

int idOrd     = reader.GetOrdinal("id");
int skuOrd    = reader.GetOrdinal("sku");
int amountOrd = reader.GetOrdinal("amount");

long rows = 0;
decimal total = 0m;

while (reader.Read())
{
    rows++;
    // GetFieldSpan avoids allocating a string for fields you never need as a string
    ReadOnlySpan<char> amountSpan = reader.GetFieldSpan(amountOrd);
    total += decimal.Parse(amountSpan, provider: CultureInfo.InvariantCulture);

    // GetString only when you actually need the managed string
    string sku = reader.GetString(skuOrd);
    _ = sku;
}
```

On the same 1 GB file this hits roughly 2.5 M rows/s and allocates under 1 MB for the entire run, dominated by the buffer itself. The trick is `GetFieldSpan` plus overloads like `decimal.Parse(ReadOnlySpan<char>, ...)` that do not require an intermediate string. .NET 11's parsing primitives are designed around this pattern, and combining them with a reader that exposes spans directly eliminates the per-cell allocation entirely.

Because `CsvDataReader` inherits `DbDataReader`, you can also feed it straight into `SqlBulkCopy`, a Dapper `Execute`, or an EF Core `ExecuteSqlRaw`, which is how you move a 10 GB CSV into SQL Server without ever materialising it in managed memory. If your end state is a database, you can often skip the parsing loop entirely.

## The last 10%: `System.IO.Pipelines` with UTF-8 parsing

When the bottleneck becomes the UTF-16 conversion itself, drop to byte-level parsing with `System.IO.Pipelines`. The idea is to keep the file's bytes as UTF-8 all the way through, slice the buffer on `,` and `\n` boundaries, and use `Utf8Parser.TryParse` or `int.TryParse(ReadOnlySpan<byte>, ...)` (added in .NET 7 and tuned further in .NET 11) to parse values without any allocation.

```csharp
// .NET 11, C# 14
using System.Buffers;
using System.Buffers.Text;
using System.IO.Pipelines;

static async Task<decimal> SumAmountsAsync(Stream source, CancellationToken ct)
{
    var reader = PipeReader.Create(source);
    decimal total = 0m;
    bool headerSkipped = false;

    while (true)
    {
        ReadResult result = await reader.ReadAsync(ct);
        ReadOnlySequence<byte> buffer = result.Buffer;

        while (TryReadLine(ref buffer, out ReadOnlySequence<byte> line))
        {
            if (!headerSkipped) { headerSkipped = true; continue; }
            total += ParseAmount(line);
        }

        reader.AdvanceTo(buffer.Start, buffer.End);

        if (result.IsCompleted) break;
    }

    await reader.CompleteAsync();
    return total;
}

static bool TryReadLine(ref ReadOnlySequence<byte> buffer, out ReadOnlySequence<byte> line)
{
    SequencePosition? position = buffer.PositionOf((byte)'\n');
    if (position is null) { line = default; return false; }

    line = buffer.Slice(0, position.Value);
    buffer = buffer.Slice(buffer.GetPosition(1, position.Value));
    return true;
}

static decimal ParseAmount(ReadOnlySequence<byte> line)
{
    ReadOnlySpan<byte> span = line.IsSingleSegment ? line.FirstSpan : line.ToArray();
    int c1 = span.IndexOf((byte)',');
    int c2 = span[(c1 + 1)..].IndexOf((byte)',') + c1 + 1;
    ReadOnlySpan<byte> amount = span[(c2 + 1)..];

    Utf8Parser.TryParse(amount, out decimal value, out _);
    return value;
}
```

This is verbose, it does not handle quoted fields, and you should not reach for it unless you have measured a real bottleneck. What you get in return is throughput within 10% of what the underlying storage can deliver, because the managed code is doing essentially no work beyond comma-hunting. A related trick that helps when the hot path has a small set of delimiters or sentinel bytes is [`SearchValues<T>` introduced in .NET 10](/2026/01/net-10-performance-searchvalues/), which vectorises the scan for any byte in a set.

## Gotchas that will bite you in production

Multi-line quoted fields break any line-based approach. A proper CSV parser tracks a "inside quotes" state across line boundaries. `File.ReadLines`, `StreamReader.ReadLine`, and the hand-rolled `Pipelines` sample above all get this wrong. CsvHelper and Sylvan handle it. If you are writing your own parser for performance reasons, you are also signing up to implement RFC 4180 yourself.

The UTF-8 BOM (`0xEF 0xBB 0xBF`) appears at the start of files produced by Excel and many Windows tools. `StreamReader` strips it by default; `PipeReader.Create(FileStream)` does not. Check for it explicitly before your first field parse, or your first header name will look like `\uFEFFid` and your ordinal lookup will throw.

`File.ReadLines` and the CsvHelper flow above hold the file handle open for the life of the enumerator. If you need to delete or rename the file while the caller is iterating (for example, a watched inbox directory), pass `FileShare.ReadWrite | FileShare.Delete` when you open the `FileStream` manually.

Parallel processing of CSV rows is tempting and usually wrong unless your per-row work is genuinely CPU-bound. Parsing is I/O bound, and the parser itself is not thread-safe. The correct pattern is to parse on a single thread and publish rows to a `Channel<T>` that fan-outs to workers. The [`IAsyncEnumerable<T>` walkthrough for EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) shows the same single-producer, multi-consumer pattern against a database source; the shape transfers directly.

If the file is compressed, do not decompress to disk first. Chain the decompression stream into your parser:

```csharp
// .NET 11, C# 14
using var file = File.OpenRead("orders.csv.zst");
using var zstd = new ZstandardStream(file, CompressionMode.Decompress);
using var reader = new StreamReader(zstd);
// feed `reader` to CsvReader or parse lines directly
```

For context on the new built-in Zstandard support, see [.NET 11's native Zstandard compression](/2026/04/dotnet-11-zstandard-compression-system-io/). Before .NET 11 you needed the `ZstdNet` NuGet package; the System.IO.Compression version is significantly faster and avoids a P/Invoke dependency.

Cancellation matters more than you think. A 20 GB CSV parse is a several-minute operation. If the caller gives up, you want the enumerator to notice on the next record and throw `OperationCanceledException`, not run to completion. All the async variants above thread a `CancellationToken` through; for the synchronous `File.ReadLines` loop, check `ct.ThrowIfCancellationRequested()` inside the loop body at a sensible interval (every 1000 rows, not every row).

## Picking the right tool

If your CSV is under 100 MB and trivially shaped, use `File.ReadLines` plus `string.Split` or `ReadOnlySpan<char>` slicing. If it has quoting, nullability, or you want typed records, use CsvHelper's `GetRecordsAsync<T>`. If throughput dominates and your data is well-formed, use Sylvan's `CsvDataReader` and parse directly from spans. Only drop to `System.IO.Pipelines` when you have measured a specific bottleneck in the UTF-16 conversion and have the budget to maintain a custom parser.

The common thread across all four: never buffer the whole file. The moment you call `ToList`, `ReadAllLines`, or `ReadAllText`, you have given up the streaming property and your memory footprint now grows with the input. On a 20 GB file in a 4 GB container, that ends one way.

## Sources

- [File.ReadLines on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.readlines)
- [FileStreamOptions on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestreamoptions)
- [CsvHelper documentation](https://joshclose.github.io/CsvHelper/)
- [Sylvan.Data.Csv on GitHub](https://github.com/MarkPflug/Sylvan)
- [System.IO.Pipelines in .NET](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [Utf8Parser on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.text.utf8parser)
