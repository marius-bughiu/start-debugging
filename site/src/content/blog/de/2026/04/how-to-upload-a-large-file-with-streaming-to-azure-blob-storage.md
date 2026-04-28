---
title: "Wie Sie eine große Datei per Streaming in Azure Blob Storage hochladen"
description: "Laden Sie mehrere GB große Dateien aus .NET 11 in Azure Blob Storage hoch, ohne sie in den Speicher zu laden. BlockBlobClient.UploadAsync mit StorageTransferOptions, MultipartReader für ASP.NET Core Uploads, und die Buffering-Fallen, die Ihre Nutzlast auf den LOH legen."
pubDate: 2026-04-28
tags:
  - "azure"
  - "dotnet"
  - "dotnet-11"
  - "aspnet-core"
  - "streaming"
lang: "de"
translationOf: "2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage"
translatedBy: "claude"
translationDate: 2026-04-28
---

Öffnen Sie die Quelle als `Stream` und übergeben Sie sie direkt an `BlockBlobClient.UploadAsync(Stream, BlobUploadOptions)` mit gesetzten `StorageTransferOptions`. Das Azure SDK zerlegt den Stream in Block-Blob-Blöcke, staged sie parallel und bestätigt die Blockliste, wenn der Stream endet. Sie allokieren niemals ein `byte[]`, das größer als `MaximumTransferSize` ist, und der Quellstream wird genau einmal vorwärts gelesen. Die Muster, die das stillschweigend brechen, sind: den Anfragerumpf in einen `MemoryStream` zu kopieren "um die Länge zu kennen", `IFormFile.OpenReadStream` aufzurufen, nachdem ASP.NET Core das Formular bereits in den Speicher gepuffert hat, und `MaximumConcurrency` zu vergessen, was Sie 4 MiB pro Aufruf in einem einzigen Thread an einen Dienst senden lässt, der gerne zwanzig parallele Block-Stagings akzeptieren würde.

Dieser Beitrag richtet sich an `Azure.Storage.Blobs` 12.22+, .NET 11 und ASP.NET Core 11. Die hier verwendeten Block-Blob-Protokollgrenzen (4000 MiB pro Block, 50 000 Blöcke, ~190.7 TiB pro Blob insgesamt) erfordern x-ms-version `2019-12-12` oder neuer, was das SDK standardmäßig aushandelt.

## Der Standard-Upload-Pfad ist bereits Streaming, mehr oder weniger

`BlobClient.UploadAsync(Stream)` macht das Richtige für einen Stream unbekannter Länge: Es liest bis zu `InitialTransferSize` Bytes, und wenn der Stream innerhalb dieses Fensters endete, gibt es eine einzige `PUT Blob`-Anfrage aus. Andernfalls wechselt es zu staged Block-Uploads, liest jeweils `MaximumTransferSize` Bytes und ruft `PUT Block` parallel bis zu `MaximumConcurrency` auf. Sobald der Quellstream 0 Bytes zurückgibt, gibt es `PUT Block List` aus, um die Reihenfolge zu bestätigen.

Die Standardwerte in 12.22 sind `InitialTransferSize = 256 MiB`, `MaximumTransferSize = 8 MiB`, `MaximumConcurrency = 8`. Zwei Dinge sind daran für große Uploads falsch. Erstens bedeutet `InitialTransferSize = 256 MiB`, dass das SDK intern bis zu 256 MiB puffert, bevor es entscheidet, ob ein einziger PUT verwendet wird, selbst wenn Sie ihm einen 50 GiB Stream übergeben haben, der offensichtlich nicht passt. Zweitens ist `MaximumConcurrency = 8` für eine 1 Gbps-Leitung zu einem kollokierten Storage-Konto in Ordnung, aber ein Engpass für regionsübergreifende Uploads, bei denen jeder PUT Round-Trip 80-200 ms kostet.

```csharp
// .NET 11, Azure.Storage.Blobs 12.22
var transferOptions = new StorageTransferOptions
{
    InitialTransferSize = 8 * 1024 * 1024,   // 8 MiB. Always go via block uploads for large files.
    MaximumTransferSize = 8 * 1024 * 1024,   // 8 MiB blocks. Sweet spot for most networks.
    MaximumConcurrency  = 16                  // Parallel PUT Block calls.
};

var uploadOptions = new BlobUploadOptions
{
    TransferOptions = transferOptions,
    HttpHeaders     = new BlobHttpHeaders { ContentType = "application/octet-stream" }
};

await using FileStream source = File.OpenRead(localPath);
await blobClient.UploadAsync(source, uploadOptions, cancellationToken);
```

Blockgrößen zwischen 4 MiB und 16 MiB sind der Sweet Spot für Standard-Storage-Konten. Kleinere Blöcke verschwenden Round-Trips am `PUT Block`-Overhead; größere Blöcke machen Wiederholungen teuer, weil ein vorübergehender 503 das SDK zwingt, den gesamten Block erneut zu senden.

## Die Block-Blob-Grenzen entscheiden die Blockgröße für Sie

Azure-Block-Blobs haben harte Grenzen, die eine "stream es einfach"-Mentalität irgendwann erreicht. Es gibt 50 000 Blöcke pro Blob, jeder Block ist höchstens 4000 MiB groß, und die maximale Blob-Größe beträgt 190.7 TiB (50 000 x 4000 MiB). Für einen 200 GiB Upload würden 4 MiB Blöcke 51 200 Blöcke benötigen, einen über dem Limit. Daher:

- Bis ~195 GiB: jede Blockgröße ab 4 MiB funktioniert.
- 195 GiB bis ~390 GiB: mindestens 8 MiB.
- 1 TiB: mindestens 21 MiB. Der SDK-Standard von 8 MiB schlägt mitten im Upload mit `BlockCountExceedsLimit` fehl.

Das SDK erhöht die Blockgröße nicht für Sie. Wenn Sie die Quelllänge im Voraus kennen, berechnen Sie die erforderliche Blockgröße und setzen Sie `MaximumTransferSize` entsprechend:

```csharp
// .NET 11
static long PickBlockSize(long contentLength)
{
    const long maxBlocks = 50_000;
    const long minBlock  = 4 * 1024 * 1024;          // 4 MiB
    const long maxBlock  = 4000L * 1024 * 1024;      // 4000 MiB

    long required = (contentLength + maxBlocks - 1) / maxBlocks;
    long rounded  = ((required + minBlock - 1) / minBlock) * minBlock;
    return Math.Clamp(rounded, minBlock, maxBlock);
}
```

Bei Uploads unbekannter Länge (ein generiertes Archiv, ein serverseitiger Fan-In) verwenden Sie standardmäßig 16 MiB Blöcke. Das gibt Spielraum bis ~780 GiB, ohne das Limit später anheben zu müssen.

## ASP.NET Core: streamen Sie den Anfragerumpf, nicht `IFormFile`

Die häufigste Art, diese ganze Pipeline zu ruinieren, ist `IFormFile`. Wenn ein Multipart-Upload eintrifft, liest der `FormReader` von ASP.NET Core den gesamten Rumpf in die Form-Collection, bevor Ihre Action läuft. Alles unter `FormOptions.MemoryBufferThreshold` (Standard 64 KiB pro Formularwert, aber der Dateiteil folgt `MultipartBodyLengthLimit` von 128 MiB) geht in den Speicher; alles darüber geht in einen `Microsoft.AspNetCore.WebUtilities.FileBufferingReadStream`, der eine temporäre Datei auf der Festplatte ist. So oder so ist der Upload, wenn Ihr Handler läuft, bereits einmal gelesen und irgendwohin kopiert worden. `IFormFile.OpenReadStream()` ist jetzt ein `FileStream` über dieser temporären Kopie.

Das tötet drei Dinge auf einmal. Sie zahlen Disk-I/O für einen Puffer, den Sie nicht brauchen. Die Anfrage dauert doppelt so lange, weil die Bytes vom Socket zur temporären Datei wandern, dann von der temporären Datei zum SDK zu Azure. Und `MultipartBodyLengthLimit` setzt standardmäßig eine 128 MiB-Obergrenze auf jeden Upload.

Die Lösung ist, das Formular-Binding zu deaktivieren und den Multipart-Stream selbst mit `MultipartReader` zu lesen:

```csharp
// .NET 11, ASP.NET Core 11
[HttpPost("upload")]
[DisableFormValueModelBinding]
[RequestSizeLimit(50L * 1024 * 1024 * 1024)]      // 50 GiB
[RequestFormLimits(MultipartBodyLengthLimit = 50L * 1024 * 1024 * 1024)]
public async Task<IActionResult> Upload(CancellationToken ct)
{
    if (!MediaTypeHeaderValue.TryParse(Request.ContentType, out var mediaType) ||
        !mediaType.MediaType.Equals("multipart/form-data", StringComparison.OrdinalIgnoreCase))
    {
        return BadRequest("Expected multipart/form-data.");
    }

    string boundary = HeaderUtilities.RemoveQuotes(mediaType.Boundary).Value!;
    var reader = new MultipartReader(boundary, Request.Body);

    MultipartSection? section;
    while ((section = await reader.ReadNextSectionAsync(ct)) != null)
    {
        var contentDisposition = section.GetContentDispositionHeader();
        if (contentDisposition is null || !contentDisposition.IsFileDisposition()) continue;

        string fileName = Path.GetFileName(contentDisposition.FileName.Value!);
        var blob = _container.GetBlockBlobClient(fileName);

        var options = new BlobUploadOptions
        {
            TransferOptions = new StorageTransferOptions
            {
                InitialTransferSize = 8 * 1024 * 1024,
                MaximumTransferSize = 16 * 1024 * 1024,
                MaximumConcurrency  = 16
            },
            HttpHeaders = new BlobHttpHeaders
            {
                ContentType = section.ContentType ?? "application/octet-stream"
            }
        };

        await blob.UploadAsync(section.Body, options, ct);
    }

    return Ok();
}
```

`section.Body` ist ein netzwerkgestützter Stream, der direkt aus dem Anfragerumpf liest. Das Azure SDK liest daraus, schneidet in Blöcke und lädt hoch. Der Speicher bleibt durch `MaximumTransferSize * MaximumConcurrency` begrenzt (256 MiB im obigen Beispiel). Das Attribut `[DisableFormValueModelBinding]` ist ein kleines benutzerdefiniertes Filter, das die Standard-Form-Value-Provider des Frameworks entfernt, damit MVC nicht versucht, den Rumpf zu binden, bevor Ihre Action läuft:

```csharp
// .NET 11, ASP.NET Core 11
public class DisableFormValueModelBindingAttribute : Attribute, IResourceFilter
{
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        var factories = context.ValueProviderFactories;
        factories.RemoveType<FormValueProviderFactory>();
        factories.RemoveType<FormFileValueProviderFactory>();
        factories.RemoveType<JQueryFormValueProviderFactory>();
    }

    public void OnResourceExecuted(ResourceExecutedContext context) { }
}
```

`[RequestSizeLimit]` und `[RequestFormLimits]` sind beide erforderlich: Das erste ist Kestrels per-Request-Body-Cap, das zweite ist `FormOptions.MultipartBodyLengthLimit`. Eines davon zu vergessen lehnt den Upload bei 30 MiB bzw. 128 MiB ab, mit einer Fehlermeldung, die Multipart nicht erwähnt.

## Authentifizierung ohne SAS

`DefaultAzureCredential` aus `Azure.Identity` ist der richtige Standard für jeden Dienst, der in Azure läuft (App Service, AKS, Functions, Container Apps). Der Container braucht die Rolle `Storage Blob Data Contributor` auf dem Storage-Konto. Lokal funktioniert derselbe Code gegen `az login` oder das Azure-Konto von VS Code.

```csharp
// .NET 11, Azure.Identity 1.13+, Azure.Storage.Blobs 12.22+
var serviceUri = new Uri($"https://{accountName}.blob.core.windows.net");
var service    = new BlobServiceClient(serviceUri, new DefaultAzureCredential());
var container  = service.GetBlobContainerClient("uploads");
await container.CreateIfNotExistsAsync(cancellationToken: ct);

var blob = container.GetBlockBlobClient(blobName);
```

Vermeiden Sie es, Verbindungszeichenfolgen mit dem Kontoschlüssel in App-Einstellungen zu speichern. Der Schlüssel authentifiziert auf Storage-Konto-Ebene, was bedeutet, dass ein geleakter Schlüssel vollen Zugriff auf jeden Container und jeden Blob gibt, einschließlich Löschen. Dieselben Upload-Pfade funktionieren mit `BlobSasBuilder`, wenn ein Browser direkt hochlädt, ohne über Ihren Server zu gehen.

## Fortschritt, Wiederholungen und Wiederaufnahme

Das SDK ruft `IProgress<long>` nach jedem Block auf. Verwenden Sie es für die UI, aber nicht für die Buchhaltung: Der Wert sind die kumulativ übertragenen Bytes, einschließlich Bytes, die wiederholt wurden.

```csharp
// .NET 11
var progress = new Progress<long>(bytes =>
{
    Console.WriteLine($"{bytes:N0} bytes transferred");
});

var options = new BlobUploadOptions
{
    TransferOptions  = transferOptions,
    ProgressHandler  = progress
};
```

Die Transportschicht wiederholt `PUT Block` automatisch mit exponentiellem Backoff (`RetryOptions` Standard sind 3 Wiederholungen, 0,8 s initiale Verzögerung). Für einen mehrstündigen Upload in einem instabilen Netzwerk erhöhen Sie `RetryOptions.MaxRetries` und `NetworkTimeout` in `BlobClientOptions`, bevor Sie den Client konstruieren:

```csharp
// .NET 11
var clientOptions = new BlobClientOptions
{
    Retry =
    {
        MaxRetries     = 10,
        Delay          = TimeSpan.FromSeconds(2),
        MaxDelay       = TimeSpan.FromSeconds(60),
        Mode           = RetryMode.Exponential,
        NetworkTimeout = TimeSpan.FromMinutes(10)
    }
};

var service = new BlobServiceClient(serviceUri, new DefaultAzureCredential(), clientOptions);
```

`UploadAsync` ist nicht über Prozessneustarts hinweg wiederaufnehmbar. Wenn der Prozess stirbt, verbleiben die staged-aber-nicht-bestätigten Blöcke bis zu sieben Tage auf dem Storage-Konto und werden dann per Garbage Collection entfernt. Um manuell wieder aufzunehmen, verwenden Sie `BlockBlobClient.GetBlockListAsync(BlockListTypes.Uncommitted)`, um zu entdecken, was staged wurde, streamen Sie die Quelle ab diesem Offset und rufen Sie `CommitBlockListAsync` mit der zusammengeführten Liste auf. Die meisten Apps brauchen das nicht; den Upload bei Byte 0 neu zu starten ist einfacher und der Parallelismus des SDK macht es günstig.

## CancellationToken: überall weiterreichen

Das `CancellationToken`, das Sie an `UploadAsync` übergeben, wird bei jedem staged Block respektiert, aber nur zwischen Blöcken. Ein einzelner `PUT Block` wird nicht im Flug abgebrochen; das SDK wartet, bis er fertig ist (oder fehlschlägt), bevor es das Token beobachtet. Für einen 16 MiB Block auf einer 1 Gbps-Leitung sind das ~130 ms, was in Ordnung ist. Auf einer 10 Mbps-Leitung sind es 13 Sekunden. Wenn ein schnelles Abbrechen wichtig ist, reduzieren Sie `MaximumTransferSize` auf 4 MiB, damit der schlimmste Fall an Block im Flug klein ist.

Dieselbe Warnung gilt, wenn Sie `NetworkTimeout` sehr hoch setzen. `CancellationToken` unterbricht keinen hängenden Socket: das Timeout schon. Halten Sie `NetworkTimeout` kleiner als Ihre akzeptable Abbruchlatenz. Das Muster für kooperatives Abbrechen ist dasselbe, das im Detail in [eine lang laufende Task in C# ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) behandelt wird: Geben Sie das Token nach unten weiter, lassen Sie `OperationCanceledException` propagieren, und räumen Sie in `finally` auf.

## Den Upload verifizieren

Bei Block-Blobs wird der MD5 pro Block vom Dienst automatisch verifiziert, wenn Sie `TransactionalContentHash` setzen, aber das SDK setzt ihn nur für den Single-PUT-Pfad, nicht für den staged Block-Pfad. Um die Integrität von Ende zu Ende mit gechunkten Uploads zu verifizieren, setzen Sie den Whole-Blob-Hash in `BlobHttpHeaders.ContentHash`. Der Dienst speichert ihn und gibt ihn bei `Get Blob Properties` zurück, validiert ihn aber **nicht** beim Upload. Sie müssen ihn auf dem Client berechnen und beim Download erneut prüfen.

```csharp
// .NET 11
using var sha = SHA256.Create();
await using var hashed = new CryptoStream(source, sha, CryptoStreamMode.Read, leaveOpen: true);

await blob.UploadAsync(hashed, options, ct);

byte[] hash = sha.Hash!;
await blob.SetHttpHeadersAsync(new BlobHttpHeaders { ContentHash = hash }, cancellationToken: ct);
```

Die Quelle in einen `CryptoStream` zu wickeln, fügt CPU-Kosten hinzu (~600 MB/s SHA-256 auf moderner Hardware), ist aber die einzige Möglichkeit, den Hash ohne Buffering zu berechnen. Lassen Sie es weg, wenn der Kanal HTTPS ist und Sie Azures Transport-Integrität vertrauen.

## Dinge, die stillschweigend puffern

Selbst mit dem richtigen SDK-Aufruf werden drei Muster das Speicherproblem wiederbeleben, das Sie zu vermeiden versuchten:

1. `Stream.CopyToAsync(memoryStream)` "um Header zu inspizieren". Tun Sie das nicht für irgendetwas Größeres als ein paar MiB. Wenn Sie die führenden Bytes brauchen, lesen Sie in eine stack-allokierte `Span<byte>` und setzen Sie `Stream.Position = 0` nur, wenn der Stream Seek unterstützt. Die meisten netzwerkgestützten Streams tun das nicht, in welchem Fall Sie einen kleinen `BufferedStream` verwenden.
2. Den Anfragerumpf loggen. Body-Capture-Middleware von Serilog/NLog kann die gesamte Nutzlast puffern, um sie loggbar zu machen. Deaktivieren Sie das für Upload-Routen.
3. Nach dem Upload ein `IActionResult` zurückgeben, indem Sie `Response.Body`-Header setzen. Der `ObjectResult`-Formatter des Frameworks kann ein Status-Objekt zurück in eine gepufferte Antwort serialisieren. Geben Sie nach einem Streaming-Upload `Results.Ok()` oder `NoContent()` zurück, kein großes Objekt.

Die "ist es wirklich Streaming?"-Sanity-Prüfung ist, das Working Set des Prozesses während eines 5 GiB-Uploads zu beobachten. Mit dem SDK und `StorageTransferOptions` wie in diesem Beitrag konfiguriert sollte das Working Set um `MaximumTransferSize * MaximumConcurrency + ~50 MiB` Overhead schweben. Alles, was linear mit der Upload-Größe wächst, ist irgendwo in Ihrer Pipeline ein Bug.

## Verwandt

- [Eine Datei aus einem ASP.NET Core Endpunkt ohne Buffering streamen](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) behandelt das Spiegelbild auf der Download-Seite zu diesem Beitrag.
- [Eine große CSV in .NET 11 lesen, ohne den Speicher zu sprengen](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) durchläuft Streaming mit begrenztem Puffer für das Parsen, was sich gut mit dem Upload-Muster hier zusammenfügt, wenn auf dem Weg zum Blob Storage transformiert wird.
- [Eine lang laufende Task in C# ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) geht tiefer auf die `CancellationToken`-Propagation ein, was für jeden mehrminütigen Upload wichtig ist.
- [`IAsyncEnumerable<T>` mit EF Core 11 verwenden](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) für den Streaming-Export-Fall, in dem Zeilen aus EF Core direkt in einen Blob fließen.

## Quelllinks

- [Azure.Storage.Blobs 12.22 Release Notes](https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/storage/Azure.Storage.Blobs/CHANGELOG.md)
- [Skalierbarkeitsziele für Block-Blobs](https://learn.microsoft.com/en-us/rest/api/storageservices/scalability-targets-for-the-azure-blob-storage-service)
- [Put Block REST API](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block)
- [`StorageTransferOptions`-Referenz](https://learn.microsoft.com/en-us/dotnet/api/azure.storage.storagetransferoptions)
- [ASP.NET Core Leitfaden für große Datei-Uploads](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads)
