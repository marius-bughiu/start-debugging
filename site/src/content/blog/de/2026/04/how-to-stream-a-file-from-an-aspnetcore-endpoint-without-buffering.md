---
title: "Wie man eine Datei von einem ASP.NET Core Endpunkt ohne Pufferung streamt"
description: "Grosse Dateien aus ASP.NET Core 11 ohne Laden in den Arbeitsspeicher ausliefern. Drei Stufen: PhysicalFileResult fur Dateien auf der Festplatte, Results.Stream fur beliebige Streams und Response.BodyWriter fur generierten Inhalt -- mit Code fur jeden Fall."
pubDate: 2026-04-24
tags:
  - "aspnet-core"
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "streaming"
lang: "de"
translationOf: "2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering"
translatedBy: "claude"
translationDate: 2026-04-24
---

Verwenden Sie `PhysicalFileResult` (oder `Results.File(path, contentType)` in Minimal APIs) fur Dateien, die sich bereits auf der Festplatte befinden -- Kestrel ruft intern den `sendfile`-Syscall des Betriebssystems auf, sodass die Dateibytes niemals in den verwalteten Arbeitsspeicher gelangen. Fur Streams, die nicht auf der Festplatte existieren -- Azure Blob, ein S3-Objekt, ein dynamisch generiertes Archiv -- geben Sie einen `FileStreamResult` oder `Results.Stream(factory, contentType)` zuruck und offnen den zugrundeliegenden `Stream` verzogernd innerhalb des Factory-Delegates. Fur vollstandig generierte Inhalte schreiben Sie direkt in `HttpContext.Response.BodyWriter`. In allen drei Fallen ist das eine Muster, das die Skalierbarkeit stillschweigend zerstort: den Inhalt zunachst in einen `MemoryStream` zu kopieren -- das ladt den gesamten Payload in den verwalteten Heap, typischerweise auf den Large Object Heap, bevor ein einziges Byte den Client erreicht.

Dieser Beitrag richtet sich an .NET 11 und ASP.NET Core 11 (Preview 3). Alles in den Stufen 1 und 2 funktioniert seit .NET 6; der `BodyWriter`-Ansatz wurde mit den stabilen `System.IO.Pipelines`-APIs in .NET 5 ergonomisch und hat sich seitdem nicht geandert.

## Warum Response-Pufferung anders ist als man denkt

Wenn man von "einer Datei streamen" spricht, meint man normalerweise "nicht alles in den Arbeitsspeicher lesen". Das ist richtig, aber es gibt einen zweiten Teil: die Antwort auch nicht puffern. Die Output-Cache- und Response-Komprimierungs-Middleware von ASP.NET Core kann die Pufferung transparent wieder einfuhren. Wer `AddResponseCompression` verwendet und es nicht angepasst hat, wird feststellen: Kleine Dateien (unter dem Standard-Schwellenwert von 256 Bytes) werden niemals komprimiert, aber grosse Dateien werden vollstandig in einen `MemoryStream` gepuffert, bevor die komprimierten Bytes geschrieben werden. Die Losung fur grosse Dateien ist entweder die Komprimierung auf der CDN-Ebene oder eine konservative Konfiguration von `MimeTypes` in `ResponseCompressionOptions` mit dem Ausschluss binarer Inhaltstypen aus der Komprimierung.

Response-Pufferung tritt auch innerhalb des Frameworks auf, wenn Sie ein `IResult` oder `ActionResult` von einer Controller-Action zuruckgeben: Das Framework schreibt zuerst Status und Header, dann ruft es `ExecuteAsync` am Ergebnis auf, wo die eigentliche Byte-Ubertragung stattfindet. In .NET 6 rief `Results.File(path, ...)` `PhysicalFileResultExecutor.WriteFileAsync` auf, das an `IHttpSendFileFeature.SendFileAsync` delegierte -- den Zero-Copy-Pfad. In .NET 7 fuhrte ein Refactoring eine Regression ein, bei der `Results.File` den `FileStream` in einen `StreamPipeWriter` wrappte, `IHttpSendFileFeature` umging und den Kernel dazu veranlasste, Dateiseiten unnotigerweise in den Userspace zu kopieren (nachverfolgt als [Issue #45037](https://github.com/dotnet/aspnetcore/issues/45037)). Diese Regression wurde behoben, zeigt aber, dass der "richtige" Ergebnistyp fur die Leistung wichtig ist, nicht nur fur die Korrektheit.

## Stufe 1: Dateien bereits auf der Festplatte

Fur Dateien auf der Festplatte ist der richtige Ruckgabetyp `PhysicalFileResult` in MVC-Controllern oder `Results.File(physicalPath, contentType)` in Minimal APIs. Beide akzeptieren einen physischen Pfad-String anstelle eines `Stream`, was dem Executor ermoglicht zu prufen, ob `IHttpSendFileFeature` im aktuellen Transport verfugbar ist. Kestrel unter Linux stellt dieses Feature bereit und verwendet `sendfile(2)` -- die Bytes gehen vom OS-Page-Cache direkt in den Socket-Puffer, ohne jemals in den .NET-Prozess kopiert zu werden. Unter Windows verwendet Kestrel `TransmitFile` uber einen I/O-Completion-Port mit demselben Effekt.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API
app.MapGet("/downloads/{filename}", (string filename, IWebHostEnvironment env) =>
{
    string physicalPath = Path.Combine(env.ContentRootPath, "downloads", filename);

    if (!File.Exists(physicalPath))
        return Results.NotFound();

    return Results.File(
        physicalPath,
        contentType: "application/octet-stream",
        fileDownloadName: filename,
        enableRangeProcessing: true);
});
```

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller
[HttpGet("downloads/{filename}")]
public IActionResult Download(string filename)
{
    string physicalPath = Path.Combine(_env.ContentRootPath, "downloads", filename);

    if (!System.IO.File.Exists(physicalPath))
        return NotFound();

    return PhysicalFile(
        physicalPath,
        "application/octet-stream",
        fileDownloadName: filename,
        enableRangeProcessing: true);
}
```

Zwei Hinweise zum Pfad. Erstens: Ubergeben Sie vom Benutzer bereitgestellte Dateinamen nicht ohne Validierung direkt an `Path.Combine`. Der obige Code ist ein Grundgerust -- prufen Sie, dass der aufgeloste Pfad noch innerhalb des erlaubten Verzeichnisses liegt, bevor Sie `File.Exists` aufrufen. Zweitens: `IWebHostEnvironment.ContentRootPath` wird zum Arbeitsverzeichnis der App aufgelost, nicht zu `wwwroot`. Fur offentliche statische Assets ubernimmt die Static-File-Middleware mit `app.UseStaticFiles()` bereits Range-Anfragen und ETags -- bevorzugen Sie diese gegenuber einem manuellen Endpunkt fur Dateien in `wwwroot`.

## Stufe 2: Streaming aus einem beliebigen Stream

Das S3-Objekt, der Azure Blob, die `varbinary(max)`-Spalte der Datenbank -- all diese liefern einen `Stream` zuruck, der keinen entsprechenden Pfad auf der Festplatte hat, sodass `PhysicalFileResult` nicht anwendbar ist. Der richtige Typ ist hier `FileStreamResult` in Controllern oder `Results.Stream` in Minimal APIs.

Das entscheidende Detail ist, den `Stream` verzogernd zu offnen. `Results.Stream` akzeptiert eine Factory-Uberladung `Func<Stream>`; verwenden Sie diese, damit der Stream nicht geoffnet wird, bevor die Antwortheader geschrieben und die Verbindung als lebendig bestatigt wurde. Wenn der Factory eine Ausnahme wirft (zum Beispiel weil der Blob nicht mehr existiert), kann das Framework noch ein 404 zuruckgeben, bevor die Header bestatigt werden.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- Streaming aus Azure Blob Storage
app.MapGet("/blobs/{blobName}", async (
    string blobName,
    BlobServiceClient blobService,
    CancellationToken ct) =>
{
    var container = blobService.GetBlobContainerClient("exports");
    var blob = container.GetBlobClient(blobName);

    if (!await blob.ExistsAsync(ct))
        return Results.NotFound();

    BlobProperties props = await blob.GetPropertiesAsync(cancellationToken: ct);

    return Results.Stream(
        streamWriterCallback: async responseStream =>
        {
            await blob.DownloadToAsync(responseStream, ct);
        },
        contentType: props.ContentType,
        fileDownloadName: blobName,
        lastModified: props.LastModified,
        enableRangeProcessing: false); // Azure verarbeitet Ranges am Ursprung; doppelte Verarbeitung deaktivieren
});
```

`Results.Stream` hat zwei Uberladungen: eine akzeptiert direkt einen `Stream`, die andere einen Callback `Func<Stream, Task>` (oben gezeigt). Bevorzugen Sie die Callback-Form, wenn die Quelle ein Netzwerk-Stream ist, da das I/O aufgeschoben wird, bis das Framework bereit ist, den Antwortkorper zu schreiben. Der Callback erhalt den Antwortkorper-`Stream` als Argument; schreiben Sie Ihre Quelldaten hinein.

Fur Controller erfordert `FileStreamResult`, dass Sie den Stream direkt ubergeben. Offnen Sie ihn so spat wie moglich in der Action-Methode und verwenden Sie `FileOptions.Asynchronous | FileOptions.SequentialScan` beim Offnen von `FileStream`-Instanzen, um das Blockieren des Thread-Pools zu vermeiden:

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller -- Streaming vom lokalen Dateisystem via FileStreamResult
[HttpGet("exports/{id}")]
public async Task<IActionResult> GetExport(Guid id, CancellationToken ct)
{
    string? path = await _exportService.GetPathAsync(id, ct);

    if (path is null)
        return NotFound();

    var fs = new FileStream(
        path,
        new FileStreamOptions
        {
            Mode    = FileMode.Open,
            Access  = FileAccess.Read,
            Share   = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
            BufferSize = 64 * 1024,
        });

    return new FileStreamResult(fs, "application/octet-stream")
    {
        FileDownloadName    = $"{id}.bin",
        EnableRangeProcessing = true,
    };
}
```

Das Framework gibt `fs` nach dem Senden der Antwort frei. Ein `using`-Block darum ist nicht notig.

## Stufe 3: Generierten Inhalt in den Response-Pipe schreiben

Manchmal existiert der Inhalt nirgendwo -- er wird spontan generiert: ein Bericht als PDF gerendert, ein CSV aus Abfrageergebnissen zusammengestellt, ein ZIP aus ausgewahlten Dateien erstellt. Der naive Ansatz ist, in einen `MemoryStream` zu rendern und ihn dann als `FileStreamResult` zuruckzugeben. Das funktioniert, aber der gesamte Payload muss im Arbeitsspeicher liegen, bevor der Client das erste Byte erhalt. Bei einem 200-MB-Export sind das 200 MB auf dem Large Object Heap pro gleichzeitiger Anfrage.

Der richtige Ansatz ist, direkt in `HttpContext.Response.BodyWriter` zu schreiben, der ein `PipeWriter` ist, der durch einen Pool von 4-KB-Puffern unterstutzt wird. Das Framework schreibt inkrementell in den Socket; die Speichernutzung wird durch das In-Flight-Fenster begrenzt, nicht durch die Dateigrosse.

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- Streaming eines generierten CSV-Berichts
app.MapGet("/reports/{year:int}", async (
    int year,
    ReportService reports,
    HttpContext ctx,
    CancellationToken ct) =>
{
    ctx.Response.ContentType = "text/csv";
    ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"report-{year}.csv\"";

    var writer = ctx.Response.BodyWriter;

    await writer.WriteAsync("id,date,amount\n"u8.ToArray(), ct);

    await foreach (ReportRow row in reports.GetRowsAsync(year, ct))
    {
        string line = $"{row.Id},{row.Date:yyyy-MM-dd},{row.Amount:F2}\n";
        await writer.WriteAsync(Encoding.UTF8.GetBytes(line), ct);
    }

    await writer.CompleteAsync();
    return Results.Empty;
});
```

Beachten Sie die Verwendung von `"id,date,amount\n"u8.ToArray()` -- ein UTF-8-String-Literal aus C# 11, das ein `byte[]` ohne Allokation erzeugt. Fur die Zeilen allokiert `Encoding.UTF8.GetBytes(line)` noch immer; um das zu eliminieren, fordern Sie einen Puffer direkt vom Writer an:

```csharp
// .NET 11, C# 14 -- allokationsfreies Schreiben mit PipeWriter.GetMemory
await foreach (ReportRow row in reports.GetRowsAsync(year, ct))
{
    string line = $"{row.Id},{row.Date:yyyy-MM-dd},{row.Amount:F2}\n";
    int byteCount = Encoding.UTF8.GetByteCount(line);
    Memory<byte> buffer = writer.GetMemory(byteCount);
    int written = Encoding.UTF8.GetBytes(line, buffer.Span);
    writer.Advance(written);
    await writer.FlushAsync(ct);
}
```

`GetMemory` / `Advance` / `FlushAsync` ist das kanonische `PipeWriter`-Muster. `FlushAsync` gibt ein `FlushResult` zuruck, das anzeigt, ob der nachgelagerte Konsument abgebrochen oder abgeschlossen hat (`FlushResult.IsCompleted`); bei einem gut funktionierenden Client ist das wahrend eines Downloads selten der Fall, aber die Prufung innerhalb der Schleife ermoglicht einen fruhen Ausstieg, wenn der Client die Verbindung trennt.

Da Sie den Antwortkorper direkt schreiben, konnen Sie nach dem ersten `FlushAsync`-Aufruf, der die Header festschreibt, keinen Statuscode mehr zuruckgeben. Setzen Sie `ctx.Response.StatusCode` bevor Sie Bytes schreiben. Wenn Ihr Service-Aufruf auf eine Weise fehlschlagen kann, die einen 500 erzeugen sollte, prufen Sie das, bevor Sie `BodyWriter` beruhren.

Fur die ZIP-Generierung speziell erlaubt .NET 11 (uber `System.IO.Compression`) das Erstellen eines `ZipArchive`, das in jeden beschreibbaren Stream schreibt. Ubergeben Sie einen `StreamWriter`, der `ctx.Response.Body` wrappt (nicht direkt `BodyWriter`, da `ZipArchive` einen `Stream` erwartet, keinen `PipeWriter`). Der Ansatz wird im Artikel [C# ZIP files to Stream](/2023/11/c-zip-files-to-stream/) behandelt, der die neue `CreateFromDirectory`-Uberladung aus .NET 8 verwendet. Fur Zstandard-komprimierte Exporte verketten Sie den Komprimierungs-Stream vor dem Antwortkorper -- das neue integrierte `ZstandardStream` in [.NET 11's Zstandard-Komprimierungsunterstutzung](/2026/04/dotnet-11-zstandard-compression-system-io/) vermeidet eine NuGet-Abhangigkeit.

## Range-Anfragen: Wiederaufnehmbare Downloads kostenlos

`EnableRangeProcessing = true` in `FileStreamResult` oder `Results.File` weist ASP.NET Core an, `Range`-Anfrage-Header zu analysieren und mit `206 Partial Content` zu antworten. Das Framework ubernimmt alles: den `Range`-Header analysieren, im Stream suchen (fur suchbare Streams), die Antwort-Header `Content-Range` und `Accept-Ranges` setzen und nur den angeforderten Byte-Bereich senden.

Fur `PhysicalFileResult` ist die Range-Verarbeitung immer verfugbar, da das Framework den Datei-Handle kontrolliert. Fur `FileStreamResult` funktioniert die Range-Verarbeitung nur, wenn `Stream.CanSeek` `true` ist. Azure Blob-Streams, die von `BlobClient.OpenReadAsync` zuruckgegeben werden, sind suchbar; rohe `HttpResponseMessage.Content`-Streams in der Regel nicht. Wenn Suchen nicht verfugbar ist, setzen Sie `EnableRangeProcessing = false` (der Standard) und liefern Sie entweder ohne Range-Unterstutzung oder puffern Sie den relevanten Bereich selbst.

## Haufige Fehler, die die Pufferung stillschweigend wieder einfuhren

**`byte[]` von einer Controller-Action zuruckgeben.** ASP.NET Core wickelt es in einen `FileContentResult` ein, was fur kleine Dateien in Ordnung ist, aber fur grosse Dateien fatal ist, da das Byte-Array allokiert wird, bevor die Action-Methode zuruckkehrt.

**`stream.ToArray()` oder `MemoryStream.GetBuffer()` an einem Quell-Stream aufrufen.** Beide materialisieren den gesamten Stream. Wenn Sie das vor dem Aufruf von `Results.Stream` tun, negieren Sie das Streaming.

**`Response.ContentLength` falsch setzen.** Wenn `ContentLength` gesetzt ist, aber der Stream weniger Bytes liefert (weil Sie fruhzeitig abgebrochen haben), protokolliert Kestrel einen Verbindungsfehler. Wenn er zu klein ist, hort der Client nach `ContentLength` Bytes auf zu lesen und betrachtet den Download moglicherweise als abgeschlossen, obwohl noch Bytes vorhanden sind. Fur dynamisch generierten Inhalt, bei dem die Lange vorab nicht bekannt ist, lassen Sie `ContentLength` weg und uberlassen Sie dem Client die Verwendung von Chunked-Encoding.

**Abbruch vergessen.** Ein 2-GB-Export dauert Minuten. Das Weitergeben von `CancellationToken` durch die Flush-Schleife des `PipeWriter` ermoglicht es dem Server, sofort zu bereinigen, wenn der Client die Verbindung schliesst. Den Artikel [Wie man eine langfristige Task in C# ohne Deadlock abbricht](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) enthalt die Abbruchmuster, die Deadlocks beim Stream-Teardown verhindern.

**`IAsyncEnumerable<byte[]>` von einem Controller verwenden.** Der JSON-Formatter von ASP.NET Core versucht, die Byte-Arrays als Base64-JSON-Token zu serialisieren, anstatt sie direkt zu schreiben. Verwenden Sie `IAsyncEnumerable` nur auf der Anwendungsschicht, um eine niedrigere Schreibschleife zu speisen; geben Sie es nicht direkt als Action-Ergebnis fur binare Inhalte zuruck.

**Gepufferter komprimierter Ausgang.** `AddResponseCompression` mit den Standardeinstellungen puffert die gesamte Antwort zur Komprimierung, was fur Text-Inhaltstypen alles oben Gesagte ruckgangig macht. Schliessen Sie Ihren Download-Inhaltstyp aus der Komprimierung aus, komprimieren Sie die Quelle vor dem Streaming (verketten Sie einen `DeflateStream` oder `ZstandardStream` vor dem Response-Pipe), oder komprimieren Sie vorab auf dem CDN.

## Das richtige Niveau wahlen

Datei auf der Festplatte mit bekanntem Pfad: `Results.File(physicalPath, contentType, enableRangeProcessing: true)`.

Blob oder externer Stream: `Results.Stream(callback, contentType)` oder `FileStreamResult` mit einem suchbaren Stream.

Generierter Inhalt: In `ctx.Response.BodyWriter` schreiben, Header vor dem ersten `FlushAsync` setzen und `CancellationToken` durch die Schleife weitergeben.

Der gemeinsame Faden ist, die Pipeline offen zu halten und Daten durch sie fliessen zu lassen. In dem Moment, wo Sie den gesamten Payload puffern, sind Sie von einem O(1)-Speicher-Endpunkt zu einem O(N)-Speicher-Endpunkt ubergegangen, und unter gleichzeitiger Last stapeln sich diese N-Werte, bis der Prozess abstirzt.

Aus demselben Grund, aus dem Streaming hier wichtig ist, ist es auch beim Lesen grosser Eingaben wichtig: Der Artikel [Wie man eine grosse CSV-Datei in .NET 11 liest, ohne den Arbeitsspeicher zu erschopfen](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) zeigt denselben Kompromiss von der Einlesseite.

## Quellen

- [FileStreamResult auf MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.filestreamresult)
- [Results.Stream auf MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.results.stream)
- [IHttpSendFileFeature.SendFileAsync auf MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpsendfilefeature.sendfileasync)
- [System.IO.Pipelines auf MS Learn](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [dotnet/aspnetcore Issue #45037 -- Results.File-Regression in .NET 7](https://github.com/dotnet/aspnetcore/issues/45037)
- [dotnet/aspnetcore Issue #55606 -- Ubermassiges I/O in FileStreamResult](https://github.com/dotnet/aspnetcore/issues/55606)
- [Response-Komprimierung in ASP.NET Core auf MS Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression)
