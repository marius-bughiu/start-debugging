---
title: "Fix: \"413 Request Entity Too Large\" beim Hochladen einer Datei an einen ASP.NET-Core-Endpunkt"
description: "Kestrel begrenzt den Anfragekörper standardmäßig auf 30.000.000 Bytes und liefert 413, wenn Sie das überschreiten. Erhöhen Sie MaxRequestBodySize global, pro Endpunkt oder in der web.config hinter IIS."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "file-upload"
lang: "de"
translationOf: "2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-17
---

Ein Upload liefert `413 Request Entity Too Large`, weil Kestrel jeden Anfragekörper standardmäßig auf 30.000.000 Bytes (etwa 28,6 MiB) begrenzt und Ihre Datei größer ist. Erhöhen Sie das Limit dort, wo es tatsächlich greift: Setzen Sie `MaxRequestBodySize` in Kestrel global, wenden Sie `[RequestSizeLimit]` oder `[DisableRequestSizeLimit]` auf eine Controller-Action an, erhöhen Sie `FormOptions.MultipartBodyLengthLimit` für Formular-Posts, und erhöhen Sie hinter IIS `maxAllowedContentLength` in der `web.config`. Verifiziert mit ASP.NET Core 11 auf .NET 11 mit C# 14; die Limits und Standardwerte sind von .NET 8 bis .NET 11 identisch.

## Der Fehler im Kontext

Es gibt zwei Wege, auf denen er auftritt. Der erste ist die HTTP-Antwort, die der Client sieht:

```
HTTP/1.1 413 Request Entity Too Large
Content-Length: 0
Connection: close
Date: Fri, 17 Jul 2026 10:04:11 GMT
```

Der zweite ist die Logzeile, die Kestrel auf dem Server schreibt und die Ihnen genau sagt, welches Limit ausgelöst wurde:

```
Microsoft.AspNetCore.Server.Kestrel.Core.BadHttpRequestException:
Request body too large. The max request body size is 30000000 bytes.
```

Diese `30000000` ist der Hinweis. Wenn Sie nichts geändert haben, ist die Zahl in der Meldung der Framework-Standard, und die Lösung besteht darin, das Limit in der Schicht zu erhöhen oder zu entfernen, die es besitzt. Ist die Zahl eine andere, hat jemand bereits ein Limit konfiguriert und Sie stoßen daran. So oder so ist die Ursache dieselbe: Der Anfragekörper hat ein konfiguriertes Maximum überschritten, und der Server hat die Verbindung abgewiesen, bevor Ihr Handler ihn zu Ende lesen konnte.

## Warum das passiert

Ein Upload kann durch vier verschiedene Limits blockiert werden, und sie liegen an verschiedenen Stellen. Die Lösung richtig zu treffen bedeutet zu wissen, welches Ihren `413` erzeugt hat.

- **Kestrels `MaxRequestBodySize`** begrenzt den gesamten Anfragekörper standardmäßig auf 30.000.000 Bytes. Überschreiten Sie es, wirft Kestrel `BadHttpRequestException` und liefert `413`. Das ist dasjenige, das die exakte Meldung oben erzeugt.
- **`FormOptions.MultipartBodyLengthLimit`** begrenzt die Länge eines Multipart-Formularkörpers standardmäßig auf 134.217.728 Bytes (128 MiB). Überschreiten Sie es, wirft der Formular-Reader `InvalidDataException`, was als `400 Bad Request` erscheint, nicht als `413`. Die beiden werden ständig verwechselt.
- **IIS' `maxAllowedContentLength`** (wenn Sie hinter IIS hosten) begrenzt die Anfrage auf der Ebene der IIS-Anfragefilterung, standardmäßig 30.000.000 Bytes, bevor die Anfrage Ihre Anwendung überhaupt erreicht. IIS liefert dafür seinen eigenen Fehler, sodass das alleinige Erhöhen des Kestrel-Limits hinter IIS nichts bewirkt.
- **Ein Reverse Proxy** (nginx, YARP, ein API-Gateway, ein Cloud-Loadbalancer) kann sein eigenes Körperlimit erzwingen und `413` liefern, bevor Kestrel die Anfrage überhaupt sieht.

Funktioniert die Anfrage direkt gegen Kestrel, scheitert aber hinter einem Proxy oder IIS, liegt das zu ändernde Limit nicht in Ihrem C#-Code. Prüfen Sie zuerst die äußerste Schicht.

## Minimale Reproduktion

Der kleinste Endpunkt, der den standardmäßigen `413` reproduziert. Keine eigenen Limits, nur die Framework-Standardwerte:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/upload", async (HttpRequest request) =>
{
    // Reading the body is what trips the limit
    using var reader = new StreamReader(request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});

app.Run();
```

Senden Sie etwas Größeres als 30.000.000 Bytes, und der Lesevorgang wirft die Exception:

```bash
# .NET 11 -- generate a 40 MB file and POST it
head -c 40000000 /dev/urandom > big.bin
curl -i -X POST http://localhost:5000/upload \
  -H "Content-Type: application/octet-stream" \
  --data-binary @big.bin
# -> HTTP/1.1 413 Request Entity Too Large
```

Die 40-MB-Nutzlast bleibt unter dem 128-MiB-Multipart-Limit (sie ist ohnehin nicht Multipart), sprengt aber die 30-MB-Obergrenze des Kestrel-Körpers, also erhalten Sie `413`, nicht `400`.

## Erhöhen Sie das Limit dort, wo es greift

Arbeiten Sie diese je nachdem durch, woher Ihr `413` kommt. Die meisten selbst gehosteten Kestrel-Anwendungen brauchen nur das erste.

### 1. Erhöhen oder entfernen Sie das globale Kestrel-Limit

Konfigurieren Sie `KestrelServerOptions.Limits.MaxRequestBodySize` beim Start. Setzen Sie eine konkrete Byteanzahl oder `null`, um die Obergrenze ganz zu entfernen:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // 200 MB ceiling for the whole app
    options.Limits.MaxRequestBodySize = 200 * 1024 * 1024;
});

var app = builder.Build();
```

Bevorzugen Sie eine echte Obergrenze gegenüber `null`. Eine unbegrenzte Körpergröße ist ein Denial-of-Service-Vektor: Ein einziger Client kann Gigabytes in Ihren Prozess streamen und Speicher oder Datenträger erschöpfen. Wählen Sie den größten legitimen Upload, den Sie erwarten, und rechnen Sie Reserve dazu, statt die Schutzmaßnahme zu deaktivieren.

### 2. Setzen Sie ein Limit pro Endpunkt an Controllern mit Attributen

Wenn nur ein Endpunkt große Uploads akzeptiert, erhöhen Sie nicht das globale Limit der ganzen Anwendung. Verwenden Sie an einer Controller-Action oder einer Razor Page `[RequestSizeLimit(bytes)]`, um eine konkrete Obergrenze zu setzen, oder `[DisableRequestSizeLimit]`, um es nur für diese Action zu entfernen. Beide Attribute implementieren `IRequestSizeLimitMetadata`, das die MVC-Pipeline pro Anfrage liest:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
[ApiController]
[Route("api/[controller]")]
public sealed class FilesController : ControllerBase
{
    [HttpPost("upload")]
    [RequestSizeLimit(200 * 1024 * 1024)]   // 200 MB, this action only
    public async Task<IResult> Upload(IFormFile file)
    {
        await using var stream = System.IO.File.Create(
            Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return Results.Ok(new { file.FileName, file.Length });
    }
}
```

Tauschen Sie `[RequestSizeLimit(...)]` gegen `[DisableRequestSizeLimit]`, wenn die Action beliebig große Körper akzeptieren muss und Sie eine andere Schutzmaßnahme (Streaming, eine Kontingentprüfung) vorgesehen haben.

### 3. Setzen Sie das Limit pro Anfrage in Minimal APIs

Minimal APIs berücksichtigen `[RequestSizeLimit]` nicht so wie Controller, weil es in der Pipeline keinen MVC-Resource-Filter gibt, der es liest. Setzen Sie das Limit imperativ über `IHttpMaxRequestBodySizeFeature`, bevor irgendetwas den Körper liest:

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload", async (HttpContext context) =>
{
    var sizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (sizeFeature is not null && !sizeFeature.IsReadOnly)
    {
        sizeFeature.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
    }

    using var reader = new StreamReader(context.Request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});
```

Prüfen Sie zuerst `IsReadOnly`. Sobald der Server begonnen hat, den Körper zu lesen, ist das Limit gesperrt, und eine Zuweisung wirft `InvalidOperationException`. Deshalb funktioniert diese Technik auch nicht mit einem `IFormFile`-Parameter an einer Minimal API: Das Model Binding liest den Multipart-Körper, bevor Ihr Handler läuft, sodass die Feature bereits schreibgeschützt ist, wenn Sie sie berühren können (das ist die Wurzel des dotnet/aspnetcore-Issues #50871, bei dem große Multipart-Uploads an eine Minimal API stillschweigend `200` mit einer abgeschnittenen Datei lieferten). Binden Sie für Minimal-API-Uploads `HttpContext` oder `HttpRequest`, erhöhen Sie das Limit und lesen Sie dann das Formular selbst mit `request.ReadFormAsync()`, oder setzen Sie ein gruppenweites Limit mit einer kleinen Middleware auf einer `MapGroup`.

### 4. Erhöhen Sie das Multipart-Formularlimit für Formular-Posts

Ist Ihr `413` in Wirklichkeit ein `400` mit einer `InvalidDataException` über die Länge eines Multipart-Körpers, dann ist das ausgelöste Limit `FormOptions.MultipartBodyLengthLimit`, nicht das von Kestrel. Erhöhen Sie es global über Options oder pro Controller-Action mit `[RequestFormLimits]`:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- global, in Program.cs
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 200 * 1024 * 1024;   // 200 MB
});
```

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- per action
[HttpPost("upload")]
[RequestSizeLimit(200 * 1024 * 1024)]
[RequestFormLimits(MultipartBodyLengthLimit = 200 * 1024 * 1024)]
public async Task<IResult> Upload(IFormFile file) { /* ... */ }
```

Für einen großen Upload müssen Sie in der Regel beide erhöhen: `MaxRequestBodySize` regelt die gesamte Anfrage, und `MultipartBodyLengthLimit` regelt den Formularkörper darin. Setzen Sie sie auf denselben Wert.

### 5. Erhöhen Sie hinter IIS maxAllowedContentLength in der web.config

Wenn Sie hinter IIS hosten (in-process oder out-of-process), erzwingt das IIS-Anfragefilterungsmodul `maxAllowedContentLength`, standardmäßig 30.000.000 Bytes, bevor die Anfrage Kestrel erreicht. Das Erhöhen des Kestrel-Limits bewirkt nichts, solange Sie nicht auch dieses erhöhen. Fügen Sie es der `web.config` hinzu:

```xml
<!-- web.config -- value is in bytes; 200 MB here -->
<system.webServer>
  <security>
    <requestFiltering>
      <requestLimits maxAllowedContentLength="209715200" />
    </requestFiltering>
  </security>
</system.webServer>
```

Das In-process-Hostingmodul hat ein zweites, separates Limit, das Sie im Code über `IISServerOptions` setzen können:

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- in-process IIS hosting
builder.Services.Configure<IISServerOptions>(options =>
{
    options.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
});
```

Hinter IIS müssen Sie unter Umständen alle drei aufeinander abstimmen: `maxAllowedContentLength` in der `web.config`, `IISServerOptions.MaxRequestBodySize` und Kestrels `MaxRequestBodySize`. Die Anfrage wird von demjenigen abgewiesen, das am kleinsten ist.

### 6. Erhöhen Sie die Obergrenze an Ihrem Reverse Proxy

Sitzt ein Proxy vor der Anwendung, hat er sein eigenes Limit und liefert `413`, bevor Ihre Anwendung beteiligt ist. In nginx heißt die Direktive `client_max_body_size` (standardmäßig 1 MiB, weit kleiner als Kestrels Standard und eine häufige Überraschung):

```nginx
# nginx.conf -- allow 200 MB uploads through the proxy
client_max_body_size 200M;
```

Suchen Sie für YARP, ein API-Gateway oder einen Cloud-Loadbalancer die entsprechende Einstellung für die Anfragegröße in der Konfiguration dieser Schicht. Das Erhöhen der anwendungsseitigen Limits hilft nicht, solange der Proxy den Körper nicht durchlässt.

## Fallstricke und Varianten

- **`413` ist nicht `400`.** Ein `413 Request Entity Too Large` kommt von Kestrels `MaxRequestBodySize`. Ein `400 Bad Request` mit `InvalidDataException: Multipart body length limit ... exceeded` kommt von `FormOptions.MultipartBodyLengthLimit`. Das sind verschiedene Limits mit verschiedenen Standardwerten (30 MB gegenüber 128 MiB). Lesen Sie den Exception-Typ, nicht nur den Statuscode.
- **HttpSys liefert `500`, nicht `413`.** Wenn Sie auf `HttpSys` statt Kestrel hosten, erzeugt das Überschreiten von `HttpSysOptions.MaxRequestBodySize` einen `500 Internal Server Error`, nicht einen `413`. Gleiche Grundursache, andere Oberfläche.
- **Bytes, keine Mebibytes.** Der Standard ist `30000000` (dreißig Millionen) Bytes, also etwa 28,6 MiB, nicht 30 MiB. Wenn Sie ein Limit aus "Megabytes" berechnen, entscheiden Sie, ob Sie `1024 * 1024` oder `1000 * 1000` meinen, und bleiben Sie konsistent, damit eine 30-MB-Datei nicht an einem "30-MB"-Limit scheitert.
- **Greifen Sie in der Produktion nicht zu `null`.** Das vollständige Entfernen des Limits macht jeden Upload-Endpunkt zu einem Ziel für Speicher- oder Datenträgererschöpfung. Kombinieren Sie ein großzügiges Limit mit Streaming, damit Sie die ganze Datei nie puffern. Siehe [wie man eine Datei aus einem ASP.NET-Core-Endpunkt ohne Puffern streamt](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) und [wie man eine große Datei per Streaming in Azure Blob Storage hochlädt](/de/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/).
- **Blazor Server und SignalR haben ihr eigenes Limit.** Ein großer Upload über einen SignalR- oder Blazor-Server-Circuit ist durch `HubOptions.MaximumReceiveMessageSize` (standardmäßig 32 KB) begrenzt, nicht durch `MaxRequestBodySize`. Das ist eine andere Lösung an einer anderen Stelle.
- **Der Client kann die Verbindung zuerst schließen.** Ein `413` kommt oft mit `Connection: close`, und manche HTTP-Clients melden das als Socket-Fehler statt als sauberen `413`. Protokollieren Sie die serverseitige `BadHttpRequestException`, um die echte Ursache zu bestätigen, statt der Fehlerzeichenkette des Clients zu vertrauen.

Das mentale Modell: Ein Upload durchläuft einen Stapel von Größen-Toren (Proxy, IIS, Kestrel-Körpergröße, Multipart-Formulargröße) und wird vom ersten abgewiesen, das er überschreitet. Finden Sie die Schicht, die Ihren `413` erzeugt hat, erhöhen Sie dieses Limit auf einen echten, begrenzten Wert und koppeln Sie es mit Streaming, damit ein größeres Limit nicht zu einer größeren Belastung wird.

## Verwandt

- [Wie man eine Datei aus einem ASP.NET-Core-Endpunkt ohne Puffern streamt](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/), um große Dateien auszuliefern, ohne sie in den Speicher zu laden.
- [Wie man eine große Datei per Streaming in Azure Blob Storage hochlädt](/de/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/), um große Uploads direkt in den Blob Storage zu schieben.
- [Fix: "415 Unsupported Media Type" von einem Minimal-API-Endpunkt in ASP.NET Core 11](/de/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) für den Geschwisterfehler, wenn der Content-Type der Anfrage falsch ist.
- [Wie man Validierungs-Fehlerantworten von Minimal APIs mit IProblemDetailsService in ASP.NET Core 11 anpasst](/de/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/), um aus einem nackten Statuscode einen nützlichen Fehlerkörper zu machen.
- [Wie man Antwortkomprimierung zu einer ASP.NET-Core-11-API hinzufügt](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) als Gegenstück auf der Ausgangsseite zu den Eingangskörperlimits.

## Quellen

- ASP.NET Announcements, [New default 30 MB (~28.6 MiB) max request body size limit](https://github.com/aspnet/Announcements/issues/267) (Standard von 30.000.000 Bytes bei Kestrel und HttpSys, `413` bei Kestrel und `500` bei HttpSys, `MaxRequestBodySize`, `IHttpMaxRequestBodySizeFeature`, `[RequestSizeLimit]` / `[DisableRequestSizeLimit]`, Verhalten bei IIS).
- Microsoft Learn, [Upload files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads?view=aspnetcore-10.0) (Standard von 134.217.728 Bytes bei `FormOptions.MultipartBodyLengthLimit`, `[RequestFormLimits]`, `IISServerOptions.MaxRequestBodySize`, `maxAllowedContentLength` in der `web.config`).
- Microsoft Learn, [IRequestSizeLimitMetadata.MaxRequestBodySize](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.metadata.irequestsizelimitmetadata.maxrequestbodysize?view=aspnetcore-10.0) (die Metadata-Schnittstelle, die die Größenlimit-Attribute implementieren).
- dotnet/aspnetcore, [Minimal API endpoints accepting IFormFile terminating with HTTP 200 for large files](https://github.com/dotnet/aspnetcore/issues/50871) (warum `IHttpMaxRequestBodySizeFeature` nicht gesetzt werden kann, nachdem der Multipart-Körper an einer Minimal API gebunden wurde).
