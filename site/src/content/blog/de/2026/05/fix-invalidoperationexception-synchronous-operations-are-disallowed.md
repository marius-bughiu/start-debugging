---
title: "Behebung: InvalidOperationException: Synchronous operations are disallowed"
description: "Ersetzen Sie den Aufruf von Stream.Read oder Write durch ReadAsync/WriteAsync. Als letztes Mittel setzen Sie AllowSynchronousIO bei Kestrel, IIS oder pro Anfrage über IHttpBodyControlFeature."
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
  - "kestrel"
lang: "de"
translationOf: "2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed"
translatedBy: "claude"
translationDate: 2026-05-12
---

Die Behebung: ASP.NET Core 3.0 und höher deaktivieren synchrone Lese- und Schreibvorgänge auf `HttpRequest.Body` und `HttpResponse.Body` standardmäßig. Daher wirft jeder Code, der `Stream.Read`, `Stream.Write`, `Stream.Flush`, `StreamReader.ReadToEnd`, `StreamWriter.Write` oder `JsonSerializer.Deserialize(stream)` aufruft, eine `InvalidOperationException: Synchronous operations are disallowed`. Die saubere Behebung besteht darin, den Aufruf durch sein asynchrones Äquivalent (`ReadAsync`, `WriteAsync`, `DeserializeAsync`) zu ersetzen und mit `await` zu warten. Wenn Sie den Aufrufer nicht ändern können, aktivieren Sie `AllowSynchronousIO = true` bei Kestrel oder IIS, oder schalten Sie `IHttpBodyControlFeature.AllowSynchronousIO` nur für die problematische Anfrage um.

```text
System.InvalidOperationException: Synchronous operations are disallowed. Call ReadAsync or set AllowSynchronousIO to true instead.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpRequestStream.Read(Byte[] buffer, Int32 offset, Int32 count)
   at System.IO.Stream.CopyTo(Stream destination, Int32 bufferSize)
   at Newtonsoft.Json.JsonSerializer.DeserializeInternal(JsonReader reader, Type objectType)
   at MyApp.LegacyHandler.Parse(HttpRequest request)
```

Diese Anleitung bezieht sich auf ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4) und Kestrel 11.0.0-preview.4. Die Prüfung ist seit 3.0.0-preview3 (Februar 2019) in Kraft und gilt für Kestrel, HTTP.sys, IIS in-process und `TestServer`. Der Text der Exception ist über alle Versionen hinweg identisch; nur die Standard-Server und die umliegenden Komfort-APIs haben sich geändert.

## Warum der Server synchrone E/A standardmäßig blockiert

Jeder blockierte Thread innerhalb eines Request-Handlers ist ein Thread, der dem Rest der Anwendung nicht zur Verfügung steht. Ein synchroner `Stream.Read` auf einer langsamen Client-Verbindung kann einen Thread aus dem Thread-Pool sekundenlang blockieren. Unter Last gehen dem Pool die Threads aus, die Latenz der Anfragen steigt sprunghaft, und der Prozess wirkt schließlich aufgehängt, obwohl die CPU im Leerlauf ist. Dieses Muster, Thread-Pool-Verhungerung, war für eine lange Reihe von Produktionsvorfällen in ASP.NET Core 1.x und 2.x verantwortlich, bei denen Anwendungen bei stoßweisem Verkehr einfrieren.

Das Release 3.0 hat `AllowSynchronousIO` in allen eingebauten Servern von `true` auf `false` gesetzt. Die Laufzeit lehnt synchrone Aufrufe jetzt aktiv ab, anstatt sie still blockieren zu lassen. Die Exception ist kein Bug, sondern der Server sagt Ihnen, dass der Aufruf einen Thread für die gesamte Dauer des Netzwerk-Lese- oder -Schreibvorgangs blockiert hätte. Sobald Sie das verstanden haben, ist die "Lösung" nicht mehr "Prüfung ausschalten", sondern "Thread nicht mehr blockieren".

Die Ankündigung des Runtime-Teams unter [aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644) listet die betroffenen Server und den empfohlenen Ausweg über `IHttpBodyControlFeature` auf.

## Eine minimale Reproduktion

```csharp
// ASP.NET Core 11, C# 14, Newtonsoft.Json 13.0.4
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/legacy", (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = reader.ReadToEnd();                      // throws
    return Results.Ok(json.Length);
});

app.Run();
```

`StreamReader.ReadToEnd` ruft intern `Stream.Read` auf. Kestrels `HttpRequestStream` überschreibt `Read`, um sofort zu werfen, wenn `AllowSynchronousIO` `false` ist. Die gleiche Form des Fehlers tritt bei jedem dieser Aufrufer auf:

- `JsonSerializer.Deserialize<T>(request.Body)` aus `System.Text.Json`.
- `JsonSerializer.Create().Deserialize(...)` aus `Newtonsoft.Json`, wenn `request.Body` übergeben wird.
- `request.Body.CopyTo(target)` zum Weiterleiten eines Request-Bodys.
- `response.Body.Write(buffer, 0, count)` aus einer benutzerdefinierten Middleware.
- `XmlSerializer.Deserialize(request.Body)`.
- Jede Drittanbieterbibliothek, die intern `Stream.Read` oder `Stream.Write` auf dem Request-/Response-Stream aufruft.

Der Stack Trace ist hier Ihr Freund: Lesen Sie ihn von unten nach oben, um die synchrone API zu finden, die im Server-Stream gelandet ist.

## Behebung 1: auf die asynchrone API umstellen (empfohlen)

Dies ist die einzige Behebung, die das eigentliche Problem tatsächlich löst. Fast jede gängige API hat ein asynchrones Pendant.

```csharp
// ASP.NET Core 11, C# 14
app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = await reader.ReadToEndAsync();
    return Results.Ok(json.Length);
});
```

Für JSON bevorzugen Sie den Streaming-Deserialisierer von `System.Text.Json`, der den vollständigen Payload nie als String materialisiert:

```csharp
// ASP.NET Core 11, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

app.MapPost("/orders", async (HttpRequest request) =>
{
    var order = await JsonSerializer.DeserializeAsync<Order>(
        request.Body,
        cancellationToken: request.HttpContext.RequestAborted);
    return Results.Ok(order);
});

record Order(string Sku, int Quantity);
```

Wenn Sie ein Modell in einer Minimal-API lesen, ist die einfachste Behebung, das Framework binden zu lassen. `[FromBody]`-Parameter in Minimal-APIs und MVC deserialisieren beide asynchron, sodass die Prüfung auf synchrone E/A nie ausgelöst wird.

```csharp
app.MapPost("/orders", (Order order) => Results.Ok(order));
```

Für Newtonsoft.Json ist das Migrationsziel `System.Text.Json` und sein asynchroner Deserialisierer. Wenn Sie nicht migrieren können, lesen Sie den Body zunächst asynchron in einen `MemoryStream` und übergeben Sie diesen Puffer dann an Newtonsoft:

```csharp
// ASP.NET Core 11, Newtonsoft.Json 13.0.4
using Newtonsoft.Json;

app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var ms = new MemoryStream();
    await request.Body.CopyToAsync(ms);
    ms.Position = 0;

    using var reader = new StreamReader(ms);
    using var jsonReader = new JsonTextReader(reader);
    var serializer = new JsonSerializer();
    var order = serializer.Deserialize<Order>(jsonReader);
    return Results.Ok(order);
});
```

Newtonsofts synchrones `Deserialize` arbeitet jetzt auf einem `MemoryStream`, nicht auf Kestrels Request-Stream, also besteht die Prüfung. Dieses Muster eignet sich auch, um nur synchrone Parser von Drittanbietern zu umhüllen. Für eine längerfristige Planung sehen Sie sich den Ansatz der [Migration von Newtonsoft.Json zu System.Text.Json](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) an.

## Behebung 2: AllowSynchronousIO serverweit aktivieren

Wenn Sie an eine Bibliothek gebunden sind, die keinerlei asynchrone API hat, können Sie synchrone E/A am Server wieder aktivieren. Dies ist ein globaler Ausweg und sollte mit einem nachverfolgten Plan zur Entfernung gekoppelt werden. Die Konfiguration hängt davon ab, welchen Server Sie betreiben.

**Kestrel:**

```csharp
// ASP.NET Core 11
builder.WebHost.ConfigureKestrel(options =>
{
    options.AllowSynchronousIO = true;
});
```

**IIS in-process:**

```csharp
// ASP.NET Core 11
builder.Services.Configure<IISServerOptions>(options =>
{
    options.AllowSynchronousIO = true;
});
```

**HTTP.sys:**

```csharp
// ASP.NET Core 11
builder.WebHost.UseHttpSys(options =>
{
    options.AllowSynchronousIO = true;
});
```

Die offizielle Kestrel-Dokumentation bestätigt, dass die Eigenschaft auf `KestrelServerOptions` liegt und standardmäßig `false` ist; siehe [Configure options for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io). Wird die Option überall gesetzt, verschwindet die Prüfung, doch das Risiko der Thread-Verhungerung, das der Standard verhindern soll, kehrt zurück. Betrachten Sie das Flag als Hinweis "ich bin mit der Migration auf asynchron noch nicht fertig", nicht als dauerhafte Konfiguration.

## Behebung 3: synchrone E/A für eine einzelne Anfrage aktivieren

Wenn nur ein Endpunkt eine synchrone Abhängigkeit hat, sollten Sie nicht den serverweiten Schalter umlegen. Verwenden Sie `IHttpBodyControlFeature`, um sich nur für diese eine Anfrage anzumelden, idealerweise innerhalb einer Middleware, die auf die genaue Route begrenzt ist.

```csharp
// ASP.NET Core 11
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/legacy/export", (HttpContext ctx) =>
{
    var feature = ctx.Features.Get<IHttpBodyControlFeature>();
    if (feature is not null)
    {
        feature.AllowSynchronousIO = true;
    }

    using var writer = new StreamWriter(ctx.Response.Body);
    writer.Write("<huge legacy XML payload>");
    return Results.Empty;
});
```

Die Feature muss vor dem ersten Aufruf umgeschaltet werden, der sonst werfen würde. Wenn Sie den Body zuerst lesen und dann das Flag setzen, ist der Lesevorgang bereits fehlgeschlagen. In MVC entspricht dies einem Filter, der in `OnActionExecuting` läuft und die Feature umschaltet, bevor der Model Binder den Body liest.

Dieser Ansatz pro Anfrage hält den Rest der Anwendung durch den Standard geschützt. Es ist die richtige Antwort, wenn Sie einen Legacy-Endpunkt haben, der von modernen, asynchronen Endpunkten umgeben ist.

## Stolpersteine und ähnliche Fälle

**Die Exception verbirgt manchmal ein anderes Problem.** Eine Antwort mit `Response.Body.Write(...)` nach `await Response.WriteAsync(...)` kann dieselbe Exception werfen, obwohl der Entwickler dachte, alles sei asynchron. Das Problem ist meist ein versteckter `Flush`-Aufruf in einem Logger oder ein `JsonSerializer`, der das Cancellation-Token nicht akzeptiert. Lesen Sie den vollständigen Stack Trace, nicht nur den obersten Frame.

**`HttpRequest.ReadFormAsync` ist die sichere Form für Formulardaten.** Ein häufiger Weg in diesen Fehler ist `request.Form["..."]`, ein synchroner Accessor, der intern `Read` aufruft. Wechseln Sie zu `await request.ReadFormAsync()` und greifen Sie dann auf das resultierende `IFormCollection` zu.

**Logging-Middleware, die `Response.Body.Seek` oder `CopyTo` aufruft.** Benutzerdefinierte Response-Capture-Middleware löst diese Prüfung fast immer aus. Ersetzen Sie `CopyTo` durch `CopyToAsync` und tauschen Sie blockierende Lesevorgänge auf dem Wrapper-Stream durch die asynchronen Überladungen aus.

**Die Prüfung wird unter TestServer in manchen Szenarien nicht ausgelöst.** `TestServer` richtet nicht immer dieselbe `IHttpBodyControlFeature` ein wie Kestrel. Code, der in Tests funktioniert, kann in der Produktion werfen. Führen Sie lokal einen Smoke-Test gegen Kestrel durch, bevor Sie ausliefern.

**Setzen von `AllowSynchronousIO = true` bringt nicht jeden async-bezogenen Fehler zum Schweigen.** Es ändert nur die Prüfung auf synchrone E/A. `TaskCanceledException` durch eine Client-Trennung ist ein anderes Problem; siehe den Beitrag zu [TaskCanceledException: A task was canceled in HttpClient](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) für diese Fehlerfamilie.

**JSON-spezifische Ähnlichkeiten.** Eine `JsonException: The JSON value could not be converted to System.DateTime` ist ein Formatfehler beim Deserialisieren, kein E/A-Fehler, auch wenn beide innerhalb eines Request-Handlers auftauchen. Wenn Ihr Stack-Frame in `System.Text.Json` endet, sehen Sie sich stattdessen den [Leitfaden zur DateTime-Deserialisierung](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) an.

**`DisposeAsync` ist wichtig.** Ein synchrones `Dispose` auf einem Stream, den der Server Ihnen übergeben hat, kann implizit `Flush` aufrufen, also einen Schreibvorgang. Verwenden Sie `await using` für jeden Stream, den Sie aus dem `HttpContext` erhalten.

```csharp
// ASP.NET Core 11
await using var writer = new StreamWriter(response.Body);
await writer.WriteAsync("done");
```

Das Muster `await using` ist eine dieser kleinen Gewohnheiten, die sich beim ersten Mal auszahlen, wenn sie eine Anfrage vor dieser Exception bewahren.

## Verwandt

- [Eine Datei aus einem ASP.NET Core-Endpunkt ohne Puffern streamen](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) behandelt die asynchronen Muster, die die Laufzeit beim Schreiben großer Antworten erwartet.
- [Eine große Datei per Streaming zu Azure Blob Storage hochladen](/de/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) ist der passende Leitfaden für die Schreibseite.
- [Unit-Tests für Code, der HttpClient verwendet, schreiben](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/) zeigt die asynchrone Test-Infrastruktur, die Sie um jeden Handler herum haben möchten, der Request- oder Response-Bodies anfasst.
- [Behebung: A second operation was started on this context instance before a previous operation completed](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/) ist der EF Core-Verwandte dieses Fehlers: ein weiterer Fall, in dem die Laufzeit einen Sync-über-Async-Fehler abfängt.
- [Behebung: TaskCanceledException: A task was canceled in HttpClient](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) für die verwandte Timeout-Familie auf der Client-Seite.

## Quellen

- [Configure options for the ASP.NET Core Kestrel web server, Synchronous I/O](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io) (MS Learn, .NET 10 / 11)
- [Announcement: AllowSynchronousIO disabled in all servers, dotnet/aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644)
- [ASP.NET Core breaking changes for versions 3.0 and 3.1](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnetcore)
- [API-Referenz `KestrelServerOptions.AllowSynchronousIO`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.server.kestrel.core.kestrelserveroptions.allowsynchronousio)
- [Interface `IHttpBodyControlFeature`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpbodycontrolfeature)
