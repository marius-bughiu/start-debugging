---
title: "Wie man eine große CSV in .NET 11 liest, ohne den Speicher zu sprengen"
description: "Streamen Sie eine mehrere Gigabyte große CSV in .NET 11 ohne OutOfMemoryException. File.ReadLines, CsvHelper, Sylvan und Pipelines im Vergleich, mit Code und Messungen."
pubDate: 2026-04-24
tags:
  - "dotnet-11"
  - "csharp-14"
  - "performance"
  - "csv"
  - "streaming"
lang: "de"
translationOf: "2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory"
translatedBy: "claude"
translationDate: 2026-04-24
---

Wenn Ihr Prozess beim Lesen einer CSV mit `OutOfMemoryException` stirbt, ist die Lösung fast immer derselbe Satz: hören Sie auf, die Datei zu materialisieren, fangen Sie an, sie zu streamen. Auf .NET 11 und C# 14 deckt `File.ReadLines` 80 % der Fälle ab, `CsvHelper.GetRecords<T>()` deckt typisiertes Parsen ohne Pufferung ab, und `Sylvan.Data.Csv` plus `System.IO.Pipelines` liefern Ihnen die letzte Größenordnung, wenn die Datei im Bereich von 5-50 GB liegt. Das Schlimmste, was Sie tun können, ist `File.ReadAllLines` oder `File.ReadAllText` auf etwas Größerem als ein paar Megabyte aufzurufen, weil beide die gesamte Nutzlast in eine `string[]` laden, die auf dem Large Object Heap leben muss, bis der GC überzeugt ist, dass niemand mehr daran rührt.

Dieser Beitrag geht durch die vier Techniken in der Reihenfolge der Komplexität, zeigt, was jede tatsächlich allokiert, und hebt die Fallstricke hervor, die Sie beißen werden, wenn die CSV mehrzeilige Felder mit Anführungszeichen, ein BOM hat oder mitten im Lesen abgebrochen werden muss. Verwendete Versionen durchgängig: .NET 11, C# 14, `CsvHelper 33.x`, `Sylvan.Data.Csv 1.4.x`.

## Warum Ihr CSV-Reader Gigabytes allokiert

Eine 2 GB große UTF-8 CSV wird zu einer ungefähr 4 GB großen `string` im Speicher, weil .NET-Strings UTF-16 sind. `File.ReadAllLines` geht weiter und allokiert zusätzlich eine `string` pro Zeile sowie das `string[]`-Array, das sie hält. Bei einer Datei mit 20 Millionen Zeilen landen Sie bei 20 Millionen Heap-Objekten, dem Top-Level-Array auf dem Large Object Heap und einer Gen-2-GC-Pause im Bereich von zehn Sekunden, wenn der Druck endlich eine Sammlung erzwingt. Auf 32-Bit-Prozessen oder eingeschränkten Containern stirbt der Prozess einfach.

Die Lösung ist, einen Datensatz auf einmal zu lesen und jeden Datensatz für Garbage Collection in Frage kommen zu lassen, bevor der nächste geparst wird. Das ist die Definition von Streaming, und jede Technik unten ist ein anderer Punkt auf der Ergonomie-vs-Throughput-Kurve.

## Das Ein-Zeilen-Upgrade: `File.ReadLines`

`File.ReadAllLines` gibt `string[]` zurück. `File.ReadLines` gibt `IEnumerable<string>` zurück und liest faul. Eines durch das andere zu ersetzen reicht oft.

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

Die Steady-State-Allokation hier ist eine `string` pro Zeile plus das, was die `decimal.Parse`-Überladung benötigt. Das Peak-Working-Set bleibt unabhängig von der Dateigröße bei wenigen Megabyte flach, weil der Enumerator durch einen 4 KB `StreamReader`-Puffer im Hintergrund liest.

Zwei Vorbehalte, die Sie beißen werden, wenn Sie sich auf das für echte Daten verlassen.

Erstens: `File.ReadLines` hat keine Kenntnis von CSV-Quoting. Eine Zelle, die `"first line\r\nsecond line"` enthält, wird zu zwei Datensätzen. Wenn Ihre Daten aus Excel, Salesforce-Exports oder von irgendwo kommen, wo Menschen tippen, treffen Sie das innerhalb einer Woche.

Zweitens: Der Enumerator öffnet die Datei und hält das Handle, bis Sie den Enumerator entsorgen oder ihn vollständig iterieren. Wenn Sie die Schleife früh verlassen, wird das Handle freigegeben, wenn der Enumerator finalisiert wird, was nicht-deterministisch ist. Wickeln Sie die Verwendung in einen expliziten `IEnumerator<string>` mit `using` ein, wenn das für Ihr Szenario wichtig ist.

## Asynchrones Streaming mit `StreamReader.ReadLineAsync`

Wenn Sie von einer Netzwerkfreigabe, einem S3-Bucket oder irgendwo mit Latenz lesen, blockiert das synchrone `foreach` einen Thread pro Datei. `StreamReader.ReadLineAsync` (in .NET 7+ überladen, um `ValueTask<string?>` zurückzugeben) und `IAsyncEnumerable<string>` sind die richtigen Primitive.

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

Hier sind zwei produktionsrelevante Stellschrauben gesetzt. `FileOptions.SequentialScan` weist das OS an, aggressives Read-Ahead zu verwenden und Pages zu verwerfen, nachdem Sie an ihnen vorbei sind, was den Page-Cache vom Thrashing abhält, wenn die Datei größer als der RAM ist. `BufferSize = 64 * 1024` ist viermal der Default und reduziert messbar die Syscall-Anzahl auf NVMe-Storage; höher als 64 KB hilft selten.

Wenn Sie Cancellation deterministisch berücksichtigen müssen, kombinieren Sie das mit einer `CancellationTokenSource` mit Timeout. Für eine längere Diskussion, wie man Cancellation durch eine Async-Pipeline ohne Deadlock fädelt, siehe [eine lang laufende Task in C# ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Typisiertes Parsen ohne Pufferung: CsvHelpers `GetRecords<T>()`

Rohe Zeilen sind in Ordnung für trivial geformte Daten. Für alles mit nullbaren Spalten, gequoteten Trennzeichen oder Headern, die Sie auf eine POCO mappen wollen, ist CsvHelper der Default. Der zentrale Punkt ist, dass `GetRecords<T>()` `IEnumerable<T>` zurückgibt und eine einzige Datensatz-Instanz über die Enumeration wiederverwendet. Wenn Sie diese Enumerable mit `.ToList()` materialisieren, haben Sie die ganze Library zunichtegemacht.

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

`GetRecordsAsync<T>` gibt `IAsyncEnumerable<T>` zurück und verwendet intern `ReadAsync`, sodass eine langsame Disk oder ein Netzwerkstream den Thread Pool nicht aushungert. Da der Typ ein `record` mit explizitem Konstruktor ist, generiert CsvHelper einmalig per Reflection Setter pro Spalte und verwendet danach denselben Pfad für jede Zeile. Auf einer 1 GB Orders-Datei mit 12 Spalten parst das auf einem modernen Laptop ungefähr 600 K Zeilen pro Sekunde mit einem Working Set, das unter 30 MB festgepinnt bleibt.

Der Vorbehalt, der Leute aus dem `DataTable`-Lager erwischt: Das Objekt, das Sie innerhalb der Schleife bekommen, ist in jeder Iteration dieselbe Instanz, wenn CsvHelper seinen Wiederverwendungspfad nutzt. Wenn Sie Zeilen in eine nachgelagerte Queue erfassen müssen, klonen Sie sie explizit oder projizieren Sie auf einen neuen Record mit `with`-Ausdrücken.

## Maximaler Throughput: Sylvan.Data.Csv und `DbDataReader`

CsvHelper ist bequem. Es ist nicht das Schnellste. Wenn Sie 100 MB/s durch einen einzelnen Core schieben müssen, ist `Sylvan.Data.Csv` die Library, die einen `DbDataReader` über eine CSV liefert, mit fast keiner Allokation pro Zelle. Sie vermeidet die `string` pro Feld, indem sie `GetFieldSpan` exponiert, und parst Zahlen direkt aus dem darunterliegenden `char`-Puffer.

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

Auf derselben 1 GB Datei trifft das ungefähr 2,5 M Zeilen/s und allokiert unter 1 MB für den ganzen Lauf, dominiert vom Puffer selbst. Der Trick ist `GetFieldSpan` plus Überladungen wie `decimal.Parse(ReadOnlySpan<char>, ...)`, die keinen Zwischenstring erfordern. Die Parsing-Primitive von .NET 11 sind um dieses Muster herum entworfen, und sie mit einem Reader zu kombinieren, der direkt Spans exponiert, eliminiert die Allokation pro Zelle vollständig.

Da `CsvDataReader` von `DbDataReader` erbt, können Sie ihn auch direkt in `SqlBulkCopy`, ein Dapper-`Execute` oder ein EF Core `ExecuteSqlRaw` einspeisen, was der Weg ist, eine 10 GB CSV in SQL Server zu bewegen, ohne sie jemals im verwalteten Speicher zu materialisieren. Wenn Ihr Endzustand eine Datenbank ist, können Sie die Parsing-Schleife oft ganz überspringen.

## Die letzten 10 %: `System.IO.Pipelines` mit UTF-8-Parsing

Wenn der Bottleneck die UTF-16-Konvertierung selbst wird, gehen Sie auf Byte-Level-Parsing mit `System.IO.Pipelines` runter. Die Idee ist, die Bytes der Datei den ganzen Weg als UTF-8 zu halten, den Puffer an `,` und `\n` zu zerschneiden, und `Utf8Parser.TryParse` oder `int.TryParse(ReadOnlySpan<byte>, ...)` (in .NET 7 hinzugefügt und in .NET 11 weiter verfeinert) zu verwenden, um Werte ohne Allokation zu parsen.

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

Das ist ausführlich, behandelt keine gequoteten Felder, und Sie sollten danach nicht greifen, es sei denn, Sie haben einen echten Bottleneck gemessen. Was Sie dafür bekommen, ist Throughput innerhalb von 10 % dessen, was die zugrundeliegende Speicherung liefern kann, weil der verwaltete Code im Wesentlichen keine Arbeit jenseits der Komma-Suche macht. Ein verwandter Trick, der hilft, wenn der Hot Path eine kleine Menge an Trennzeichen oder Sentinel-Bytes hat, ist [`SearchValues<T>`, eingeführt in .NET 10](/2026/01/net-10-performance-searchvalues/), das den Scan für ein beliebiges Byte aus einer Menge vektorisiert.

## Fallstricke, die Sie in Produktion beißen werden

Mehrzeilige gequotete Felder brechen jeden zeilenbasierten Ansatz. Ein korrekter CSV-Parser verfolgt einen "innerhalb von Anführungszeichen"-Zustand über Zeilengrenzen hinweg. `File.ReadLines`, `StreamReader.ReadLine` und das oben handgeschriebene `Pipelines`-Beispiel machen das alle falsch. CsvHelper und Sylvan handhaben es. Wenn Sie Ihren eigenen Parser aus Performance-Gründen schreiben, melden Sie sich auch dafür an, RFC 4180 selbst zu implementieren.

Das UTF-8 BOM (`0xEF 0xBB 0xBF`) erscheint am Anfang von Dateien, die von Excel und vielen Windows-Tools produziert werden. `StreamReader` entfernt es standardmäßig; `PipeReader.Create(FileStream)` nicht. Prüfen Sie es explizit vor Ihrem ersten Feld-Parse, sonst sieht Ihr erster Header-Name wie `\uFEFFid` aus und Ihr Ordinal-Lookup wirft.

`File.ReadLines` und der CsvHelper-Flow oben halten das Datei-Handle für die Lebensdauer des Enumerators offen. Wenn Sie die Datei löschen oder umbenennen müssen, während der Aufrufer iteriert (zum Beispiel ein überwachtes Inbox-Verzeichnis), übergeben Sie `FileShare.ReadWrite | FileShare.Delete`, wenn Sie den `FileStream` manuell öffnen.

Parallele Verarbeitung von CSV-Zeilen ist verlockend und meist falsch, es sei denn, Ihre Pro-Zeile-Arbeit ist tatsächlich CPU-bound. Parsing ist I/O-bound, und der Parser selbst ist nicht thread-safe. Das richtige Muster ist, auf einem einzelnen Thread zu parsen und Zeilen an einen `Channel<T>` zu publizieren, der zu Workern auffächert. Der [`IAsyncEnumerable<T>`-Walkthrough für EF Core 11](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) zeigt dasselbe Single-Producer-Multi-Consumer-Muster gegen eine Datenbankquelle; die Form überträgt sich direkt.

Wenn die Datei komprimiert ist, dekomprimieren Sie sie nicht zuerst auf Disk. Ketten Sie den Dekompressionsstream in Ihren Parser:

```csharp
// .NET 11, C# 14
using var file = File.OpenRead("orders.csv.zst");
using var zstd = new ZstandardStream(file, CompressionMode.Decompress);
using var reader = new StreamReader(zstd);
// feed `reader` to CsvReader or parse lines directly
```

Für Kontext zur neuen built-in Zstandard-Unterstützung siehe [die native Zstandard-Kompression von .NET 11](/2026/04/dotnet-11-zstandard-compression-system-io/). Vor .NET 11 brauchten Sie das NuGet-Paket `ZstdNet`; die System.IO.Compression-Version ist deutlich schneller und vermeidet eine P/Invoke-Abhängigkeit.

Cancellation ist wichtiger, als Sie denken. Ein 20 GB CSV-Parse ist eine Operation von mehreren Minuten. Wenn der Aufrufer aufgibt, wollen Sie, dass der Enumerator es beim nächsten Datensatz bemerkt und `OperationCanceledException` wirft, nicht bis zum Ende läuft. Alle Async-Varianten oben fädeln einen `CancellationToken`; für die synchrone `File.ReadLines`-Schleife prüfen Sie `ct.ThrowIfCancellationRequested()` innerhalb des Schleifenkörpers in einem vernünftigen Intervall (alle 1000 Zeilen, nicht jede Zeile).

## Das richtige Werkzeug wählen

Wenn Ihre CSV unter 100 MB und trivial geformt ist, verwenden Sie `File.ReadLines` plus `string.Split` oder `ReadOnlySpan<char>`-Slicing. Hat sie Quoting, Nullability oder wollen Sie typisierte Records, verwenden Sie CsvHelpers `GetRecordsAsync<T>`. Dominiert Throughput und Ihre Daten sind wohlgeformt, verwenden Sie Sylvans `CsvDataReader` und parsen Sie direkt aus Spans. Steigen Sie nur auf `System.IO.Pipelines` ab, wenn Sie einen spezifischen Bottleneck in der UTF-16-Konvertierung gemessen haben und das Budget haben, einen eigenen Parser zu pflegen.

Der gemeinsame Faden über alle vier: nie die ganze Datei puffern. In dem Moment, in dem Sie `ToList`, `ReadAllLines` oder `ReadAllText` aufrufen, haben Sie die Streaming-Eigenschaft aufgegeben, und Ihr Speicher-Footprint wächst jetzt mit der Eingabe. Bei einer 20 GB Datei in einem 4 GB Container endet das auf eine Weise.

## Quellen

- [File.ReadLines auf MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.readlines)
- [FileStreamOptions auf MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestreamoptions)
- [CsvHelper-Dokumentation](https://joshclose.github.io/CsvHelper/)
- [Sylvan.Data.Csv auf GitHub](https://github.com/MarkPflug/Sylvan)
- [System.IO.Pipelines in .NET](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [Utf8Parser auf MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.text.utf8parser)
