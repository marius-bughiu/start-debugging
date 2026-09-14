---
title: "ZIP-Dateien in .NET 11 asynchron mit den ZipArchive-Async-APIs erstellen und extrahieren"
description: "ZipFile.CreateFromDirectoryAsync, ExtractToDirectoryAsync, ZipArchive.CreateAsync und ZipArchiveEntry.OpenAsync ohne verstecktes synchrones I/O verwenden. Gemessen auf .NET 11 RC 1 und .NET 10.0.12, einschließlich des .NET 10-Bugs, der Kestrel weiterhin blockiert."
pubDate: 2026-09-14
template: how-to
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "async"
lang: "de"
translationOf: "2026/09/how-to-create-and-extract-zip-files-asynchronously-with-ziparchive-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-14
---

**Kurze Antwort:** Für ganze Ordner rufen Sie `await ZipFile.CreateFromDirectoryAsync(dir, zipPathOrStream, ct)` und `await ZipFile.ExtractToDirectoryAsync(zipPathOrStream, dir, ct)` auf. Für die Kontrolle über jeden einzelnen Eintrag öffnen Sie das Archiv mit `await ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding: null, ct)` statt mit dem Konstruktor, öffnen Einträge mit `await entry.OpenAsync(ct)` und geben sowohl den Eintrags-Stream als auch das Archiv mit `await using` frei. Lassen Sie eines dieser drei `await`s weg, fällt `System.IO.Compression` stillschweigend auf synchrones I/O zurück. Die asynchronen APIs kamen mit .NET 10, aber .NET 10 (auch noch in 10.0.12) schreibt synchron, wenn ein Eintrags-Stream freigegeben wird, selbst unter `await using`. Erst .NET 11 (gemessen auf RC 1, `11.0.0-rc.1.26425.128`) ist durchgehend asynchron.

Alles Folgende lief auf einem Apple M4 gegen zwei Laufzeiten: .NET 10.0.12 (das aktuelle Servicing-Release, kompiliert mit SDK 10.0.302) und .NET 11 RC 1. Die Testprogramme verpacken den Ziel-Stream in einen `Stream`, der bei jedem synchronen `Read`, `Write` und `Flush` eine Ausnahme wirft. Das ist derselbe Vertrag, den Kestrel für Anfrage- und Antworttexte durchsetzt, sodass jeder versteckte synchrone Aufruf als Ausnahme sichtbar wird statt als blockierter Thread, der Ihnen nie auffällt.

## Die asynchrone API und warum es keinen asynchronen Konstruktor gibt

Die API geht auf [dotnet/runtime#1541](https://github.com/dotnet/runtime/issues/1541) zurück, eine Anfrage noch aus der corefx-Zeit, und wurde in [PR #114421](https://github.com/dotnet/runtime/pull/114421) für .NET 10 implementiert. Die [genehmigte Form](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236) ist kleiner als der ursprüngliche Vorschlag, und die Begründung erklärt die meisten Fallstricke:

- Der `ZipArchive`-Konstruktor führt I/O aus (im Lesemodus liest er den End-of-Central-Directory-Datensatz), und auf Konstruktoren kann man nicht warten. Deshalb gibt es die statische Factory `ZipArchive.CreateAsync`.
- Es gibt kein `GetEntriesAsync`. `CreateAsync` soll das zentrale Verzeichnis lesen, bevor es zurückkehrt, sodass die synchrone Eigenschaft `Entries` nur zurückgibt, was bereits im Speicher liegt.
- Es gibt kein `CreateEntryAsync` oder `DeleteAsync`, weil `CreateEntry` und `Delete` kein I/O ausführen.
- `ZipArchive` implementiert `IAsyncDisposable`, weil das Freigeben eines beschreibbaren Archivs das zentrale Verzeichnis schreibt.

So bilden sich die synchronen Aufrufe auf ihre asynchronen Versionen ab (alle akzeptieren ein optionales `CancellationToken`):

| Synchron | Asynchron (.NET 10+) |
| --- | --- |
| `new ZipArchive(stream, mode, ...)` | `ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding, ct)` |
| `archive.Dispose()` | `archive.DisposeAsync()` |
| `entry.Open()` | `entry.OpenAsync(ct)` |
| `ZipFile.Open` / `OpenRead` | `ZipFile.OpenAsync` / `OpenReadAsync` |
| `ZipFile.CreateFromDirectory` | `ZipFile.CreateFromDirectoryAsync` (Pfad oder `Stream` als Ziel) |
| `ZipFile.ExtractToDirectory` | `ZipFile.ExtractToDirectoryAsync` (Pfad oder `Stream` als Quelle) |
| `archive.CreateEntryFromFile` | `archive.CreateEntryFromFileAsync` |
| `archive.ExtractToDirectory` | `archive.ExtractToDirectoryAsync` |
| `entry.ExtractToFile` | `entry.ExtractToFileAsync` |

.NET 11 fügt weitere Überladungen hinzu: `OpenAsync(ReadOnlySpan<char> password, ...)`, `OpenAsync(FileAccess, ...)`, `CreateEntryFromFileAsync` mit Passwort und `ZipEncryptionMethod` sowie Überladungen mit `ZipFileCreationOptions` / `ZipExtractionOptions` für die Verzeichnis-Hilfsmethoden. Ich habe sie alle per Reflection über `System.IO.Compression` auf beiden Laufzeiten ermittelt. Die Passwortseite behandelt [der Beitrag zu verschlüsselten ZIPs in .NET 11](/de/2026/08/dotnet-11-preview-7-password-protected-zip-archives/).

## Schritte zu durchgehend asynchronem Code

1. Verwenden Sie die Verzeichnis-Hilfsmethoden `ZipFile.*Async`, wenn Sie keine Kontrolle über einzelne Einträge brauchen.
2. Andernfalls erstellen Sie das Archiv mit `await ZipArchive.CreateAsync(...)` oder `await ZipFile.OpenAsync(...)`, niemals mit `new ZipArchive(...)`.
3. Öffnen Sie jeden Eintrag mit `await entry.OpenAsync(ct)`, oder verwenden Sie `CreateEntryFromFileAsync` / `ExtractToFileAsync`.
4. Geben Sie jeden Eintrags-Stream mit `await using` frei, bevor das Archiv freigegeben wird.
5. Geben Sie das Archiv mit `await using` frei.
6. Reichen Sie ein einziges `CancellationToken` durch alles hindurch, und legen Sie fest, was eine abgebrochene Extraktion auf der Festplatte hinterlassen soll.

## Einen ganzen Ordner zippen und entpacken

Wenn das Archiv ein Verzeichnis abbilden soll, erledigen die statischen Hilfsmethoden alles:

```csharp
// .NET 10+, C# 14 (tested on .NET 11 RC 1 and .NET 10.0.12)
using System.IO.Compression;

using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));

// Folder -> .zip file
await ZipFile.CreateFromDirectoryAsync(
    "out/reports", "reports.zip",
    CompressionLevel.Optimal, includeBaseDirectory: false,
    cancellationToken: cts.Token);

// .zip file -> folder
await ZipFile.ExtractToDirectoryAsync(
    "reports.zip", "in/reports",
    overwriteFiles: true, cancellationToken: cts.Token);
```

Beide Hilfsmethoden haben auch `Stream`-Überladungen. Damit zippen Sie direkt in einen Netzwerk-Stream oder entpacken einen Upload ohne temporäre Datei. [Der .NET 8-Beitrag zu ZIP-Dateien in einen Stream](/de/2023/11/c-zip-files-to-stream/) hat die synchronen `Stream`-Überladungen vorgestellt, und die asynchronen Versionen haben dieselbe Form plus ein Token.

## Ein Archiv Eintrag für Eintrag aufbauen

Sobald Sie filtern, umbenennen oder Inhalte erzeugen müssen, steigen Sie auf `ZipArchive` um. Hier zählen alle drei `await`s:

```csharp
// .NET 11 RC 1, C# 14
using System.IO.Compression;
using System.Text;

static async Task WriteExportAsync(Stream destination, IEnumerable<string> files, CancellationToken ct)
{
    await using ZipArchive zip = await ZipArchive.CreateAsync(
        destination, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);

    // Files from disk, renamed and filtered
    foreach (string path in files.Where(f => !f.EndsWith(".tmp")))
    {
        await zip.CreateEntryFromFileAsync(
            path, $"data/{Path.GetFileName(path)}", CompressionLevel.Fastest, ct);
    }

    // Generated content
    ZipArchiveEntry manifest = zip.CreateEntry("manifest.txt", CompressionLevel.Optimal);
    await using (Stream s = await manifest.OpenAsync(ct))
    {
        await s.WriteAsync(Encoding.UTF8.GetBytes($"created={DateTime.UtcNow:O}\n"), ct);
    }
}
```

Begrenzen Sie den Eintrags-Stream wie oben auf einen eigenen `await using`-Block, damit er freigegeben wird, bevor der nächste Eintrag entsteht. Im `Create`-Modus kann immer nur ein Eintrag geöffnet sein, und das Freigeben des Eintrags-Streams schreibt den letzten komprimierten Block sowie die Größen und die CRC des Eintrags.

Lesen funktioniert genauso. `Entries` ist eine gewöhnliche Eigenschaft, und unter .NET 11 führt sie nach `CreateAsync` kein I/O mehr aus:

```csharp
// .NET 11 RC 1, C# 14
await using ZipArchive zip = await ZipFile.OpenReadAsync("reports.zip", ct);

foreach (ZipArchiveEntry entry in zip.Entries)
{
    if (entry.FullName.EndsWith('/')) continue; // directory entry

    await using Stream source = await entry.OpenAsync(ct);
    await using FileStream target = new(
        Path.Combine("in", entry.Name), FileMode.Create, FileAccess.Write,
        FileShare.None, bufferSize: 81920, FileOptions.Asynchronous);
    await source.CopyToAsync(target, ct);
}
```

Wenn Sie Pfade aus `entry.FullName` selbst schreiben, übernehmen Sie auch die Pfadvalidierung, die `ExtractToDirectoryAsync` sonst für Sie erledigt. Die Hilfsmethode verweigert Einträge, die außerhalb des Zielverzeichnisses landen würden, während selbst geschriebener Code einfach tut, was `Path.Combine` ihm vorgibt.

## Was jedes `await` tatsächlich bringt, gemessen

Hier ist die Testmatrix. "Wirft" bedeutet, dass der Archivcode mindestens einen synchronen Aufruf auf einem Stream ausgeführt hat, der solche Aufrufe verbietet. Die Streams sind nicht seekfähig, sofern die Zeile nichts anderes angibt, genau wie ein Kestrel-Body.

| Szenario | .NET 10.0.12 | .NET 11 RC 1 |
| --- | --- | --- |
| `new ZipArchive` (Create) + `Open()` + `using` | wirft | wirft |
| `CreateAsync` + `OpenAsync` + überall `await using` | **wirft** | funktioniert |
| Wie oben, aber `using` beim Archiv | wirft | wirft |
| Wie oben, aber `using` beim Eintrags-Stream | wirft | wirft |
| `ZipFile.CreateFromDirectoryAsync(dir, stream)` | **wirft** | funktioniert |
| `new ZipArchive` (Read) | wirft | wirft |
| `CreateAsync` (Read) | funktioniert | funktioniert |
| `CreateAsync` (Read), seekfähiger Stream | **wirft** | funktioniert |
| `CreateAsync` (Read), seekfähig, synchrones `entry.Open()` | wirft | wirft |
| `ZipFile.ExtractToDirectoryAsync(stream, dir)` | funktioniert | funktioniert |
| `CreateAsync` (Update) auf einem nicht seekfähigen Stream | `ArgumentException` | `ArgumentException` |

Zwei Erkenntnisse. Erstens sind die Zeilen, die unter .NET 11 werfen, allesamt Fälle, in denen Sie einen synchronen Aufruf stehen gelassen haben: den Konstruktor, `Open()` im Lesemodus oder ein einfaches `using`. `Dispose()` muss komprimierte Daten schreiben und das zentrale Verzeichnis anlegen, und das kann es nicht asynchron tun. Zweitens sind die fett markierten Zeilen Bugs in .NET 10, nicht Ihre Fehler.

## Der .NET 10-Bug: `await using` schreibt trotzdem synchron

Unter .NET 10 überschreibt der interne `WrappedStream`, den `OpenAsync` im Create-Modus zurückgibt, `DisposeAsync` nicht. Das Basis-`Stream.DisposeAsync` ruft `Dispose()` auf, sodass die gesamte darunterliegende Kette synchron freigegeben wird und `DeflateStream` seinen letzten Block mit einem synchronen `Write` schreibt. Der Stack aus meinem Test unter .NET 10.0.12:

```text
at System.IO.Compression.DeflateStream.PurgeBuffers(Boolean disposing)
at System.IO.Compression.DeflateStream.Dispose(Boolean disposing)
at System.IO.Compression.CheckSumAndSizeWriteStream.Dispose(Boolean disposing)
at System.IO.Compression.ZipArchiveEntry.DirectToArchiveWriterStream.Dispose(Boolean disposing)
at System.IO.Compression.WrappedStream.Dispose(Boolean disposing)
```

Der Bug auf der Leseseite ist ähnlich: Bei einem seekfähigen Stream liest `CreateAsync` in .NET 10 nur den End-of-Central-Directory-Datensatz und verschiebt das zentrale Verzeichnis auf den ersten Zugriff auf `Entries`, der `ReadCentralDirectory()` synchron ausführt. Nicht seekfähige Streams entgehen diesem Bug zufällig, weil `CreateAsync` sie zuerst mit asynchronen Lesevorgängen in einen `MemoryStream` kopiert.

Beide wurden als [dotnet/runtime#121624](https://github.com/dotnet/runtime/issues/121624) ("Asynchronous Zip Methods still have synchronous calls") gemeldet und in [PR #121938](https://github.com/dotnet/runtime/pull/121938) behoben, gemergt am 2025-12-01 mit dem Meilenstein 11.0.0. Der Fix umfasst 18 Zeilen: ein echtes `DisposeAsync` in `WrappedStream` plus ein vorgezogenes `EnsureCentralDirectoryReadAsync` in `CreateAsync` für den Lesemodus. Einen Backport nach `release/10.0` gibt es nicht. Die .NET 10-Servicing-Releases bis 10.0.12 schlagen weiterhin fehl, was ich auf 10.0.10 und 10.0.12 reproduziert habe.

Mit einem `FileStream` würden Sie das nie bemerken, weil ein synchroner Schreibvorgang nur kurz einen Thread-Pool-Thread blockiert. Bei Kestrel ist das anders.

## Ein ZIP von einem ASP.NET Core-Endpunkt streamen

Das ist der Fall, der die meisten wirklich interessiert: das Archiv direkt in `Response.Body` aufbauen, ohne temporäre Datei und ohne `MemoryStream`.

```csharp
// .NET 11 RC 1, ASP.NET Core 11 minimal API
using System.IO.Compression;

app.MapGet("/export", async (HttpContext ctx, CancellationToken ct) =>
{
    ctx.Response.ContentType = "application/zip";
    ctx.Response.Headers.ContentDisposition = "attachment; filename=\"export.zip\"";

    await using ZipArchive zip = await ZipArchive.CreateAsync(
        ctx.Response.Body, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);

    foreach (string file in Directory.EnumerateFiles(exportFolder))
        await zip.CreateEntryFromFileAsync(file, Path.GetFileName(file), CompressionLevel.Fastest, ct);
});
```

Ich habe das mit einem Ordner aus 100 Dateien (je 64 KB) auf beiden Laufzeiten ausgeführt:

- **.NET 11 RC 1:** `200`, 3.499.034 Bytes, und `unzip -l` listet alle 100 Dateien auf.
- **.NET 10.0.10:** `200`, **130 Bytes**. Der lokale Header des ersten Eintrags wurde gesendet, dann traf `DisposeAsync` auf den synchronen Schreibvorgang, Kestrel protokollierte `InvalidOperationException: Synchronous operations are disallowed. Call WriteAsync or set AllowSynchronousIO to true instead.`, und die Verbindung wurde getrennt. `unzip -t` meldet `invalid compressed data to inflate`.

Das zweite Ergebnis ist das gefährliche. Der Statuscode war bereits gesendet, also sieht der Client einen erfolgreichen Download einer beschädigten Datei. Derselbe Endpunkt mit `new ZipArchive(...)` schlägt auf beiden Laufzeiten fehl, aber immerhin mit einem `500`, bevor Bytes geschrieben werden. Mehr zu dieser Ausnahme finden Sie unter [die Behebung von "Synchronous operations are disallowed"](/de/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).

Wenn Sie auf .NET 10 festsitzen, bauen Sie das Archiv in einer asynchronen temporären Datei auf und kopieren es anschließend hinaus:

```csharp
// .NET 10 workaround (verified on 10.0.10): the ZIP code does sync I/O against the temp file, never against Kestrel
app.MapGet("/export", async (HttpContext ctx, CancellationToken ct) =>
{
    await using var tmp = new FileStream(Path.GetTempFileName(), FileMode.Create, FileAccess.ReadWrite,
        FileShare.None, bufferSize: 81920, FileOptions.Asynchronous | FileOptions.DeleteOnClose);

    await using (ZipArchive zip = await ZipArchive.CreateAsync(tmp, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct))
    {
        foreach (string file in Directory.EnumerateFiles(exportFolder))
            await zip.CreateEntryFromFileAsync(file, Path.GetFileName(file), CompressionLevel.Fastest, ct);
    }

    tmp.Position = 0;
    ctx.Response.ContentType = "application/zip";
    ctx.Response.ContentLength = tmp.Length;
    await tmp.CopyToAsync(ctx.Response.Body, ct);
});
```

Das lieferte unter .NET 10.0.10 ein gültiges Archiv mit 3,5 MB, und Sie erhalten zusätzlich einen echten `Content-Length`. Die Alternative, `IHttpBodyControlFeature.AllowSynchronousIO = true` für die Anfrage zu setzen, funktioniert, blockiert aber pro Download einen Thread. Wie Sie große Antworten vom Heap fernhalten, beschreibt [eine Datei von einem ASP.NET Core-Endpunkt ohne Pufferung streamen](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/).

## Ein hochgeladenes ZIP aus dem Anfragetext extrahieren

Die andere Richtung funktioniert auf beiden Laufzeiten, weil der Anfragetext nicht seekfähig ist:

```csharp
// .NET 10+ (tested on 10.0.10 and 11 RC 1)
app.MapPost("/import", async (HttpRequest req, CancellationToken ct) =>
{
    await using ZipArchive zip = await ZipArchive.CreateAsync(
        req.Body, ZipArchiveMode.Read, leaveOpen: false, entryNameEncoding: null, ct);

    long total = 0;
    foreach (ZipArchiveEntry entry in zip.Entries)
    {
        await using Stream s = await entry.OpenAsync(ct);
        var buffer = new byte[81920];
        int read;
        while ((read = await s.ReadAsync(buffer, ct)) > 0) total += read;
    }
    return Results.Ok(new { entries = zip.Entries.Count, bytes = total });
});
```

Das Hochladen des Archivs mit 100 Dateien lieferte `{"entries":100,"bytes":6553600}`, während die Version mit `new ZipArchive(req.Body, ZipArchiveMode.Read)` `500` mit der `ReadAsync`-Variante derselben Ausnahme zurückgab. Es gibt einen Haken: Der Index eines ZIPs steht am Ende der Datei, daher kopiert der Lesemodus über einem nicht seekfähigen Stream zuerst **das gesamte Archiv in den Speicher**. Mein 32 MB großes Testarchiv brauchte 253 asynchrone Lesevorgänge, bevor der erste Eintrag verfügbar war. Streamen Sie bei großen Uploads den Body zuerst in eine temporäre Datei mit `FileOptions.Asynchronous` (und prüfen Sie Ihre [Größenlimits für Anfragen](/de/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/)) und öffnen Sie dann diese. Denken Sie nur daran, dass unter .NET 10 eine seekfähige Quelle das synchrone Lesen von `Entries` zurückbringt.

## Fallstricke, die Sie vor dem Release kennen sollten

**Ein Abbruch hinterlässt ein halb extrahiertes Verzeichnis.** Ich habe `ExtractToDirectoryAsync` bei einem Archiv mit 1.000 Einträgen nach 20 ms abgebrochen. Es warf `OperationCanceledException` mit 129 Dateien auf der Festplatte, eine davon abgeschnitten (unter .NET 10.0.12 waren es 181 Dateien). Ein zweiter Aufruf ohne `overwriteFiles: true` scheitert dann mit `IOException: The file '.../f539.bin' already exists.` Wenn unvollständige Ausgaben eine Rolle spielen, extrahieren Sie in ein temporäres Nachbarverzeichnis und verschieben es mit `Directory.Move` erst an seinen Platz, wenn der Task abgeschlossen ist. Wie das Token weitergereicht wird, behandelt [ein CancellationToken durch asynchrone Methoden weiterreichen](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

**Asynchron ist nicht schneller.** Es gibt Threads frei, während auf I/O gewartet wird, und das ist alles. Zippen von 1.000 Dateien (64 MB) und Extrahieren des Ergebnisses, Median aus 7 `Stopwatch`-Läufen auf einer lokalen SSD (kein BenchmarkDotNet-Lauf):

| Vorgang | .NET 11 RC 1 synchron | .NET 11 RC 1 asynchron | .NET 10.0.12 synchron | .NET 10.0.12 asynchron |
| --- | --- | --- | --- | --- |
| `CreateFromDirectory` | 249 ms | 268 ms | 252 ms | 259 ms |
| `ExtractToDirectory` | 103 ms | 108 ms | 84 ms | 101 ms |

Komprimierung ist CPU-Arbeit, und asynchrones Datei-I/O auf einer schnellen lokalen Festplatte verursacht etwas Overhead. Setzen Sie die asynchronen APIs auf Servern und in UI-Threads ein, wo ein blockierter Thread etwas kostet. Ein Konsolenwerkzeug, das eine Build-Ausgabe zippt, gewinnt dadurch nichts.

**Der Update-Modus ist weiterhin ein Sonderfall.** `ZipArchiveMode.Update` benötigt einen Stream, der lesen, schreiben und suchen kann (`ArgumentException: Update mode requires a stream with read, write, and seek capabilities.`), und lädt Einträge in den Speicher, sobald Sie sie öffnen. Er funktioniert mit `CreateAsync` und `await using` auf einem seekfähigen Stream, aber bei großen Archiven ist es meist günstiger, ein neues Archiv zu schreiben.

**Synchrones `Open()` ist nicht immer harmlos.** Unter .NET 11 funktionierte ein synchrones `entry.Open()` im Create-Modus in meinem Test zufällig, weil das Öffnen eines neuen Eintrags kein I/O ausführt. Im Lesemodus wirft es auf beiden Laufzeiten bei einem Stream ohne synchrone Operationen. Verwenden Sie einfach überall `OpenAsync` und ersparen Sie sich die Buchführung.

**Implementieren Sie `IAsyncDisposable` selbst?** Der .NET 10-Bug ist ein Lehrbuchbeispiel für einen Wrapper, der vergessen hat, `DisposeAsync` weiterzuleiten. [IAsyncDisposable implementieren und verwenden](/de/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) zeigt, wie Sie das richtig machen.

### Weiterlesen

- [Fix: InvalidOperationException: Synchronous operations are disallowed in ASP.NET Core](/de/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)
- [Eine Datei von einem ASP.NET Core-Endpunkt ohne Pufferung streamen](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)
- [System.IO.Compression liest und schreibt verschlüsselte ZIPs in .NET 11](/de/2026/08/dotnet-11-preview-7-password-protected-zip-archives/)
- [IAsyncDisposable mit await using in C# implementieren und verwenden](/de/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)

### Quellen

- [dotnet/runtime#1541: Add async ZipFile APIs](https://github.com/dotnet/runtime/issues/1541) und die [genehmigte API-Form](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236)
- [dotnet/runtime PR #114421: Zip async implementation](https://github.com/dotnet/runtime/pull/114421)
- [dotnet/runtime#121624: Asynchronous Zip Methods still have synchronous calls](https://github.com/dotnet/runtime/issues/121624)
- [dotnet/runtime PR #121938: Fix async ZipArchive calling non-async Stream methods](https://github.com/dotnet/runtime/pull/121938)
- [ZipArchive.CreateAsync auf Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.ziparchive.createasync)
- [ZipFile.ExtractToDirectoryAsync auf Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zipfile.extracttodirectoryasync)
