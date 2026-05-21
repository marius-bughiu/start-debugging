---
title: "IEnumerable vs IAsyncEnumerable vs IQueryable in C#: which one should the method return?"
description: "Three sequence interfaces, three execution models. Use IQueryable when a database can translate the query, IAsyncEnumerable when the producer is async and you want to stream, IEnumerable for everything else in memory."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "csharp"
  - "linq"
  - "ef-core"
  - "async"
  - "dotnet-11"
---

If you are picking between `IEnumerable<T>`, `IAsyncEnumerable<T>`, and `IQueryable<T>` for a method signature in C# 14 / .NET 11, the rule is almost mechanical. Return `IQueryable<T>` only when the consumer can compose more `Where`/`Select`/`OrderBy` calls and the underlying provider (EF Core 11, LINQ to SQL, an OData client) can translate them into the remote query. Return `IAsyncEnumerable<T>` when the producer does I/O per item or per batch and you want the consumer to start processing before the producer is done. Return `IEnumerable<T>` for everything that is already in memory or that you have decided to fully materialize at the boundary. The mistake to avoid is leaking `IQueryable<T>` out of a repository: every subsequent `.Where(...)` becomes part of the SQL whether you wanted it to or not, and "where does this query actually run" becomes a question you have to answer with the debugger.

This post is the long version. Every example targets `<TargetFramework>net11.0</TargetFramework>` with `<LangVersion>14.0</LangVersion>` and, where relevant, `Microsoft.EntityFrameworkCore 11.0.0`.

## Three interfaces, three execution models

The three interfaces look similar on paper. They all expose a single sequence of `T`. The difference is where the work happens and when.

- `IEnumerable<T>` is a pull-based, synchronous sequence. `MoveNext` runs in the calling thread. The producer is a method that yields items, a `List<T>`, a `T[]`, or a LINQ-to-objects chain. The producer cannot await anything.
- `IAsyncEnumerable<T>` is a pull-based, asynchronous sequence. `MoveNextAsync` returns a `ValueTask<bool>`, which lets the producer await between items. The consumer iterates with `await foreach`. Introduced in C# 8 / .NET Core 3.0; first-class in modern LINQ via the `System.Linq.Async` package and EF Core's `AsAsyncEnumerable`.
- `IQueryable<T>` is an expression-tree builder. Every `Where`, `Select`, or `OrderBy` you chain onto an `IQueryable<T>` appends a node to an expression tree. The tree is only translated into something executable (a SQL statement, an OData URL, a Cosmos query) when you call a terminal operator (`ToList`, `FirstOrDefault`, `Count`, `ToListAsync`). Until then, no I/O has happened.

The most important consequence: an `IEnumerable<T>` returned by an EF Core call has already left the database. An `IQueryable<T>` returned by the same call has not. That single fact is responsible for more "why is this query slow" tickets than any other single cause in EF Core code.

## Feature matrix

| Capability                                       | `IEnumerable<T>`         | `IAsyncEnumerable<T>`        | `IQueryable<T>`                     |
| ------------------------------------------------ | ------------------------ | ---------------------------- | ----------------------------------- |
| Execution model                                  | sync pull                | async pull                   | deferred, translated by a provider  |
| Where does the work run                          | calling thread, in-memory| producer side, awaitable     | remote provider (DB, OData, Cosmos) |
| Can `await` between items                        | no                       | yes                          | n/a (no per-item work)              |
| LINQ operators available                         | LINQ to Objects          | LINQ to Objects (Async)      | provider-specific subset            |
| Composable after return                          | yes (in-memory)          | yes (in-memory)              | yes (translated remotely)           |
| Streams without buffering                        | yes (lazy `yield return`)| yes                          | depends on the provider             |
| Cancellation                                     | none, the loop is sync   | `CancellationToken` per item | per query via `ToListAsync(token)`  |
| Risk when returned from a repository             | low                      | medium (lifetime of provider)| high (caller can append SQL)        |
| Best fit                                         | in-memory collections    | remote streams, server-sent  | repository-internal query objects   |
| Materializes when                                | on each `MoveNext`       | on each `await MoveNextAsync`| on terminal operator                |

The matrix is the post. Everything below is the reasoning.

## When `IEnumerable<T>` is the right return type

`IEnumerable<T>` is the default for "I have items, give me a sequence". It is sync, it has every LINQ-to-Objects operator, and it composes cheaply. Use it for:

- A method that yields from an in-memory collection or a pure computation.
- A method that has already materialized the data and now returns a view onto it (`return list.Where(x => x.IsActive);`).
- A method that walks a synchronous source like a file you read with `File.ReadLines` or a deserialized DOM.

The trap is using `IEnumerable<T>` as the return type of a repository method that wraps an async I/O call. That forces the repository to do `.ToList()` internally and lose the streaming property, or it forces the caller into `.Result` and a thread-pool block. Both are wrong. If the source is async, the signature should be `IAsyncEnumerable<T>` or `Task<List<T>>`, not `IEnumerable<T>`.

```csharp
// .NET 11, C# 14
public static IEnumerable<string> ReadLowercaseLines(string path)
{
    foreach (var line in File.ReadLines(path))
    {
        yield return line.ToLowerInvariant();
    }
}
```

`File.ReadLines` returns an `IEnumerable<string>` that lazily reads the file. The transform stays lazy. Nothing forces the file to be fully loaded before the first item reaches the caller.

The `yield return` keyword is what makes this work. It tells the compiler to generate a state machine that returns items one at a time, suspending the method between yields. It is the synchronous mirror of `await foreach` plus `yield return` together.

## When `IAsyncEnumerable<T>` is the right return type

`IAsyncEnumerable<T>` is what you reach for when the producer needs to await between items. The cardinal example is a paged HTTP endpoint: you fetch page 1, yield each item, fetch page 2, yield each item. You want the consumer to start work on page 1 while page 2 is still in flight. You also want a `CancellationToken` plumbed in so the consumer can stop the producer cleanly.

Use it for:

- Paged remote sources (HTTP APIs that return pages, Server-Sent Events, message queue consumers).
- EF Core 11 queries that stream results to a CSV or to another HTTP response without materializing into memory.
- Any producer where backpressure matters: the consumer reads, processes, and only then asks for the next item.

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<Order> FetchAllAsync(
    HttpClient http,
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    string? next = "/api/orders?page=1";
    while (next is not null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var page = await http.GetFromJsonAsync<PageOf<Order>>(next, cancellationToken)
                   ?? throw new InvalidOperationException("page was null");
        foreach (var order in page.Items)
        {
            yield return order;
        }
        next = page.NextLink;
    }
}
```

Two details that catch people. First, `[EnumeratorCancellation]` is required to wire the token from `WithCancellation(...)` at the call site into the iterator. Without it, calling `await foreach (var x in source.WithCancellation(token))` silently drops the token. Second, an async iterator method cannot use `try/catch` around a `yield return` for an exception that comes from a downstream operator; the exception flows through the consumer, not the producer. Wrap the I/O calls explicitly when you need retry logic.

For EF Core 11, the equivalent on a `DbSet<T>` is `AsAsyncEnumerable`:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
await foreach (var order in db.Orders
    .Where(o => o.Status == "shipped")
    .AsAsyncEnumerable()
    .WithCancellation(cancellationToken))
{
    await sink.WriteAsync(order, cancellationToken);
}
```

That keeps the SQL data reader open and pulls rows on demand. The full set never sits in `List<Order>`. For details on the EF Core specifics, see [how to use IAsyncEnumerable with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/).

## When `IQueryable<T>` is the right return type

`IQueryable<T>` is the right shape inside a repository or a query-building helper, where the caller is still expected to compose. It is the wrong shape across a network boundary or out of a layer that the next caller might not understand.

Use it for:

- A `Queryable` extension that takes an existing `IQueryable<T>` and adds a `Where` clause: `q.WhereActive()`. The provider translates the predicate; you never run on materialized data.
- A repository method that exposes a narrow, project-specific query that the caller will further filter, page, or count: `IQueryable<Invoice> Unpaid(int customerId)`.
- A library API where the consumer is expected to build expressions, like an OData controller or a custom search DSL.

The pattern that bites is exposing `IQueryable<T>` from a service layer that the caller assumes returns in-memory data:

```csharp
// Anti-pattern: do not return IQueryable<T> from a public service
public IQueryable<Order> GetRecentOrders() => _db.Orders.Where(o => o.At > _start);

// Caller, miles away
var bad = service.GetRecentOrders()
                 .Where(o => SomeLocalMethod(o))   // EF Core throws: not translatable
                 .OrderBy(o => o.Total)
                 .Take(50)
                 .ToList();
```

`SomeLocalMethod` is a C# method that EF Core cannot translate. The `Where` call appends an expression that the provider cannot lower to SQL, and at materialization you get an exception. Or worse, in a provider that silently falls back to client evaluation, you accidentally pull every row over the wire to filter in process. EF Core 11 throws by default; older code with `AsEnumerable` switches inserted in the middle of a chain is even harder to read.

The fix is to materialize at the boundary:

```csharp
// .NET 11, C# 14
public async Task<IReadOnlyList<Order>> GetRecentOrdersAsync(
    int count, CancellationToken ct)
{
    return await _db.Orders
        .Where(o => o.At > _start)
        .OrderByDescending(o => o.At)
        .Take(count)
        .ToListAsync(ct);
}
```

The method now returns a concrete, materialized collection. The caller cannot accidentally append SQL. If the caller wants a different filter, they ask for it explicitly via a parameter or a new method. This is the same rationale that drives [how to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): be explicit about where the query boundary sits.

## The benchmark: streaming a million rows three ways

A real number. The setup: 1,000,000 narrow rows (a `Guid Id`, an `int Status`, a `DateTime At`) in SQL Server 2022. The consumer counts rows that pass a filter (`Status == 1`) and writes a sum of timestamps. We do it three ways:

- `IEnumerable<T>` produced by `ToList()` then enumerated.
- `IAsyncEnumerable<T>` produced by `AsAsyncEnumerable()`.
- `IQueryable<T>` consumed inside the same method via `await Where(...).CountAsync()`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0, BenchmarkDotNet 0.14.0
[MemoryDiagnoser]
public class SequenceShapes
{
    private AppDb _db = null!;

    [GlobalSetup] public void Setup() => _db = AppDb.Connect();

    [Benchmark]
    public long Materialize_Then_Enumerate()
    {
        var rows = _db.Events.ToList();              // pull all 1,000,000
        long sum = 0; long count = 0;
        foreach (var r in rows)
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark]
    public async Task<long> StreamAsync()
    {
        long sum = 0; long count = 0;
        await foreach (var r in _db.Events.AsAsyncEnumerable())
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark(Baseline = true)]
    public async Task<long> Queryable_Aggregate()
    {
        var count = await _db.Events.Where(e => e.Status == 1).CountAsync();
        var sum   = await _db.Events.Where(e => e.Status == 1)
                                    .SumAsync(e => (long)e.At.Ticks);
        return sum + count;
    }
}
```

Methodology: BenchmarkDotNet 0.14.0, .NET 11.0.0 RTM, EF Core 11.0.0, SQL Server 2022 16.0.4135 on the same machine over loopback. Windows 11 24H2, AMD Ryzen 9 7900X, 64 GB DDR5. Numbers are a single representative run.

| Method                          | Mean         | Allocated   |
| ------------------------------- | ------------ | ----------- |
| Queryable_Aggregate (baseline)  | 38 ms        | 1.4 KB      |
| StreamAsync                     | 1,210 ms     | 410 MB      |
| Materialize_Then_Enumerate      | 1,380 ms     | 432 MB      |

The pattern is consistent with how the three interfaces work. `IQueryable<T>` lets the database do the count and the sum and ship two scalars back. `IAsyncEnumerable<T>` saves you about 12 percent of wall time over `ToList`-then-loop, and it saves the spike-shaped memory profile (the `List<Event>` allocation in `Materialize_Then_Enumerate` is visible in `dotnet-counters` as a single `gen2` spike). But both lose to the queryable form by 30x because the work belonged on the database, not in the client.

The takeaway is not "always use IQueryable". It is: if the operation can be expressed in the provider's query language, do not pull the rows out. If you must pull rows out (CSV export, transformation that does not translate, downstream service that wants individual items), pick `IAsyncEnumerable<T>` over a materialized `IEnumerable<T>`.

## The gotchas that pick for you

A few things make the decision for you regardless of preference.

- **`IQueryable<T>` requires a live provider.** Returning `IQueryable<T>` from a method whose `DbContext` is disposed when the method returns is a use-after-free in disguise. The expression tree still exists, but the moment the caller materializes it, `ObjectDisposedException` flies. Either keep the context alive for the duration of the queryable, or materialize before returning.

- **`IAsyncEnumerable<T>` requires `[EnumeratorCancellation]`.** Without it, the cancellation token a caller passes via `.WithCancellation(token)` never reaches the producer. The compiler will not warn you; the bug is silent and the token is ignored. Roslyn analyzer `CA1068` catches the missing parameter; `CA2016` catches the missing token plumbing to async calls inside.

- **LINQ operators differ.** `Skip`, `Take`, `OrderBy`, `Select`, `Where`, `First`, `Count` exist on all three. But `IAsyncEnumerable<T>` needs the `System.Linq.Async` package for `WhereAsync`, `SelectAwait`, `SelectMany`, `GroupBy`, and friends. `IQueryable<T>` only supports the subset that its provider can translate; everything else either throws (EF Core 11) or silently falls back to client evaluation (some older providers).

- **`IQueryable<T>` leaks the persistence model.** If the caller can write `.Where(...)`, the caller is writing SQL. Refactoring a column name in the entity becomes a search-the-whole-codebase change because every queryable consumer is touching that column. A repository that returns materialized DTOs hides the schema; one that returns `IQueryable<Entity>` does not.

- **Mixing them inside a chain.** Calling `.AsEnumerable()` or `.AsAsyncEnumerable()` in the middle of an `IQueryable<T>` chain converts the rest to in-memory evaluation. Every `Where` after that point runs on the client. This is sometimes what you want (a complex predicate that does not translate); it is often a performance bug. Make the switch explicit and put a comment next to it.

- **`yield return` inside `using` is fine, but the resource lives as long as the iterator does.** A sync iterator that opens a `FileStream` and yields lines holds the file open until the consumer disposes the enumerator or finishes iterating. The same applies, with worse failure modes, to async iterators that hold a `DbDataReader`. Always iterate to completion or call `await foreach` inside a using/awaiting block.

## The opinionated recommendation, restated

Default to `IEnumerable<T>` for in-memory work. Reach for `IAsyncEnumerable<T>` the moment the producer needs to `await`, and plumb `[EnumeratorCancellation]` from day one. Keep `IQueryable<T>` inside the repository or query-builder layer; convert to a materialized `IReadOnlyList<T>` or to `IAsyncEnumerable<T>` before crossing a service boundary.

Two corollaries worth committing to muscle memory:

- "Return the lowest power that the caller needs". A method that conceptually returns a list should return `IReadOnlyList<T>`, not `IQueryable<T>`. Power that the caller does not need is power the caller can misuse.
- "Materialization is a boundary". Decide where it happens once, in one place, and write the rest of the layer to that contract. Codebases where every method returns `IQueryable<T>` "just in case" end up with `.ToList()` calls sprinkled randomly and a slow query budget no one owns.

## Related

- [How to use IAsyncEnumerable with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [EF Core 11 vs Dapper for bulk inserts: a real benchmark](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## Sources

- [IQueryable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.linq.iqueryable-1)
- [IAsyncEnumerable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1)
- [Generate asynchronous streams (async iterators) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream)
- [EnumeratorCancellationAttribute -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute)
- [Client vs server evaluation -- EF Core docs](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [System.Linq.Async on NuGet](https://www.nuget.org/packages/System.Linq.Async)
