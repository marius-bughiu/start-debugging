---
title: "Behebung: System.InvalidOperationException: Headers are read-only, response has already started"
description: "Sie haben einen Header, einen Statuscode oder einen Content-Type gesetzt, nachdem der Body bereits geleert war. Setzen Sie alle Header vor der ersten Schreiboperation, oder sichern Sie mit HttpResponse.HasStarted und OnStarting ab."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
lang: "de"
translationOf: "2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-07-17
---

Die Behebung: Etwas hat bereits in den Response-Body geschrieben, wodurch die Header zum Client geleert und schreibgeschützt wurden, und dann versuchte Ihr Code, einen Header, einen Statuscode oder einen Content-Type zu setzen. In ASP.NET Core müssen `HttpResponse.StatusCode`, `HttpResponse.ContentType` und alles in `HttpResponse.Headers` gesetzt werden, **bevor** das erste Byte des Bodys geschrieben wird. Verschieben Sie alle Header- und Status-Zuweisungen vor jedes `WriteAsync`, `Redirect` oder nachgelagerte Middleware, die den Body schreibt. Wenn Sie die Reihenfolge nicht steuern können, sichern Sie die Zuweisung mit `if (!context.Response.HasStarted)` ab oder registrieren Sie die Arbeit in `HttpResponse.OnStarting`, damit sie im Moment vor dem Leeren der Header läuft. Dieser Leitfaden ist gegen ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4), C# 14 und Kestrel 11.0.0-preview.4 geschrieben; das Verhalten ist bis ASP.NET Core 3.0 identisch.

```text
System.InvalidOperationException: Headers are read-only, response has already started.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpResponseHeaders.ThrowHeadersReadOnlyException()
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpHeaders.Microsoft.AspNetCore.Http.IHeaderDictionary.set_Item(String key, StringValues value)
   at MyApp.SecurityHeadersMiddleware.InvokeAsync(HttpContext context)
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.ProcessRequests[TContext](IHttpApplication`1 application)
```

Der Stack Trace endet fast immer in `ThrowHeadersReadOnlyException` innerhalb von Kestrel (oder dem Äquivalent in HTTP.sys und IIS). Der Frame direkt darüber ist die Zeile, die die Mutation versucht hat. Dieser Frame ist Ihr Übeltäter: Er setzt einen Header, `StatusCode`, `ContentType` oder ruft `Redirect` auf, nachdem die Antwort bereits begonnen hat.

## Warum das Setzen eines Headers nach der ersten Schreiboperation unmöglich ist

HTTP ist auf der Leitung geordnet: Statuszeile, dann Header, dann eine Leerzeile und dann der Body. Sobald der Server den Header-Block an den Client gesendet hat, kann er ihn nicht zurücknehmen. ASP.NET Core bildet dies ab, indem es die Header-Sammlung in dem Moment schreibgeschützt macht, in dem die Antwort beginnt, und wirft eine Ausnahme, anstatt Ihre Änderung stillschweigend zu verwerfen, denn ein stillschweigend ignorierter Sicherheitsheader oder Content-Type ist ein weit schlimmerer Bug als eine laute Ausnahme.

Zwei Dinge starten die Antwort. Die Dokumentation sagt es unverblümt: "An app can't modify headers after the response has started. Once the response starts, the headers are sent to the client. A response is started by flushing the response body or calling `HttpResponse.StartAsync(CancellationToken)`." Das erste davon ist das, was die Leute beißt, weil es implizit ist. Das Schreiben des Bodys leert ihn: "Unless response buffering is enabled, all write operations (for example, `WriteAsync`) flush the response body internally and mark the response as started. Response buffering is disabled by default." Das erste `WriteAsync`, das erste `CopyToAsync` in `Response.Body`, das erste `FlushAsync` auf `Response.BodyWriter` und das Zurückgeben eines Ergebnisses, das Inhalt streamt, setzen `HttpResponse.HasStarted` auf `true` und frieren die Header ein.

Deshalb sind `HttpResponse.StatusCode`, `HttpResponse.ContentType` und `HttpResponse.Headers` jeweils als "Must be set before writing to the response body." dokumentiert. Das sind keine Hinweise. Es ist der Vertrag, und die Ausnahme ist dessen Durchsetzung.

## Ein minimaler Repro

Die kleinste Version schreibt den Body und versucht dann, einen Header zu setzen:

```csharp
// ASP.NET Core 11, C# 14
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/broken", async (HttpContext context) =>
{
    await context.Response.WriteAsync("Processing...");   // flushes: HasStarted is now true
    context.Response.Headers["X-Trace-Id"] = "abc123";     // throws: headers are read-only
});

app.Run();
```

Der `WriteAsync`-Aufruf leert den Body und sendet die Header. Die nächste Zeile versucht, `X-Trace-Id` hinzuzufügen, und Kestrel wirft `InvalidOperationException: Headers are read-only, response has already started`. Dieselbe Form erscheint mit einem Statuscode:

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-status", async (HttpContext context) =>
{
    await context.Response.WriteAsync("partial output");
    context.Response.StatusCode = 500;   // throws for the same reason
});
```

Und sie erscheint mit einem Redirect, denn `Redirect` setzt sowohl den `Location`-Header als auch einen 302-Status:

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-redirect", async (HttpContext context) =>
{
    await context.Response.WriteAsync("about to redirect");
    context.Response.Redirect("/login");   // throws: Location header is read-only
});
```

## Ordnen Sie um, damit die Header zuerst kommen

Die primäre Behebung, und die, zu der Sie greifen sollten, wann immer der Code unter Ihrer Kontrolle steht, besteht darin, jeden Header, den Statuscode und den Content-Type zu setzen, bevor Sie irgendetwas in den Body schreiben. In einem Endpunkt oder Controller ist das üblicherweise eine einzeilige Verschiebung:

```csharp
// ASP.NET Core 11, C# 14 -- correct order
app.MapGet("/fixed", async (HttpContext context) =>
{
    context.Response.StatusCode = 200;
    context.Response.ContentType = "text/plain";
    context.Response.Headers["X-Trace-Id"] = "abc123";   // set before any write

    await context.Response.WriteAsync("Processing...");  // now safe to flush
});
```

Ziehen Sie es vor, ein `IResult` (Minimal APIs) oder ein `IActionResult` (MVC) zurückzugeben, statt von Hand in `Response.Body` zu schreiben. `Results.Text`, `Results.Json`, `Results.File` und `TypedResults` bauen die gesamte Antwort auf, Header inklusive, und schreiben erst dann, sodass sie nie über diesen Fehler stolpern. Der Griff zu [einer typisierten Results-Union aus einem Minimal-API-Endpunkt](/de/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) hält Status und Header deklarativ und beseitigt die Gefahr der manuellen Reihenfolge vollständig.

## Sichern Sie Middleware mit HasStarted ab

Der schwierigere Fall ist Middleware, die `await next(context)` ausführt und dann die Antwort anfassen möchte. Wenn `next` zurückkehrt, hat ein nachgelagerter Endpunkt üblicherweise bereits den Body geschrieben, sodass die Antwort begonnen hat und jede Header-Änderung eine Ausnahme wirft. Dies ist die häufigste Quelle dieses Fehlers, und der klassische Übeltäter ist eine "Security Headers"- oder "Correlation Id"-Middleware, die so geschrieben ist:

```csharp
// ASP.NET Core 11, C# 14 -- broken middleware
app.Use(async (context, next) =>
{
    await next(context);   // endpoint writes the body here; response starts
    context.Response.Headers["X-Frame-Options"] = "DENY";   // throws
});
```

Es gibt zwei korrekte Muster, und die Wahl hängt davon ab, ob Sie den Header bedingungslos setzen müssen.

**Registrieren Sie die Arbeit in `OnStarting`.** `HttpResponse.OnStarting` nimmt einen Callback entgegen, den der Server genau einmal ausführt, unmittelbar bevor er die Header leert, egal ob der Body von Ihrer Middleware oder von etwas Nachgelagertem geschrieben wird. Registrieren Sie ihn vor dem Aufruf von `next`, und der Header wird im letzten sicheren Moment geschrieben:

```csharp
// ASP.NET Core 11, C# 14 -- correct: set headers just before they flush
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Frame-Options"] = "DENY";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        return Task.CompletedTask;
    });

    await next(context);
});
```

Dies ist das richtige Werkzeug für querschnittliche Response-Header, denn es funktioniert selbst dann, wenn der nachgelagerte Code sofort mit dem Streamen beginnt. Es ist derselbe Mechanismus, den die eigene Header-Middleware von ASP.NET Core intern verwendet.

**Sichern Sie mit `HasStarted` ab.** Wenn der Header nur dann von Bedeutung ist, wenn die Antwort sich noch nicht festgelegt hat (zum Beispiel ein Exception-Handler, der einen Fehlschlag in einen 500 verwandeln möchte), prüfen Sie zuerst `HttpResponse.HasStarted` und überspringen Sie die Mutation, wenn sie `true` ist:

```csharp
// ASP.NET Core 11, C# 14 -- defensive guard
app.Use(async (context, next) =>
{
    try
    {
        await next(context);
    }
    catch (Exception)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.Clear();
            context.Response.StatusCode = 500;
            await context.Response.WriteAsync("Something went wrong.");
        }
        throw;   // nothing safe to do if the response already started
    }
});
```

`HttpResponse.Clear()` setzt den Statuscode, die Header und jeden gepufferten Body zurück, funktioniert aber nur, solange `HasStarted` `false` ist. Sobald der Body zu streamen begonnen hat, gibt es wirklich nichts, was Sie tun können, um den Status oder die Header zu ändern, und der ehrliche Schritt ist, die Ausnahme propagieren zu lassen oder `HttpContext.Abort()` aufzurufen, um die Verbindung zu trennen, sodass der Client eine kaputte Antwort statt einer Lüge sieht. Deshalb prüfen der eingebaute Exception-Handler und [ein globaler Exception-Filter in ASP.NET Core 11](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) beide `HasStarted`, bevor sie einen Problem-Details-Body schreiben, und werfen erneut, wenn es bereits zu spät ist.

## Puffern Sie den Body, wenn Middleware ihn umschreiben muss

Manche Middleware muss die nachgelagerte Antwort wirklich lesen oder transformieren, HTML minifizieren, ein Script-Tag injizieren oder Inhalt komprimieren, und erst dann einen `Content-Length`- oder `Content-Encoding`-Header setzen. Das können Sie nicht tun, wenn der Body bereits zum Client geleert wurde. Die Behebung besteht darin, den Response-Body gegen einen Puffer auszutauschen, den Nachgelagerten in den Puffer schreiben zu lassen, dann Ihre Header zu setzen und den Puffer in den echten Body zu kopieren:

```csharp
// ASP.NET Core 11, C# 14 -- buffer downstream output, then set headers
app.Use(async (context, next) =>
{
    var originalBody = context.Response.Body;
    using var buffer = new MemoryStream();
    context.Response.Body = buffer;

    await next(context);   // downstream writes into the MemoryStream, not the socket

    // Response has NOT started: the real body was never touched.
    context.Response.Headers["Content-Length"] = buffer.Length.ToString();
    buffer.Position = 0;
    context.Response.Body = originalBody;
    await buffer.CopyToAsync(originalBody);
});
```

Da die nachgelagerte Schreiboperation in einen `MemoryStream` und nicht in die Verbindung ging, bleibt `HasStarted` `false`, und die Header-Zuweisungen sind erfolgreich. Dies ist die manuelle Version dessen, was antworttransformierende Middleware tut; der vom Framework unterstützte Weg besteht darin, über `IHttpResponseBodyFeature` zu arbeiten, statt `Response.Body` direkt zuzuweisen, aber das Pufferungsprinzip ist dasselbe. Wenn Ihr Ziel speziell Komprimierung ist, bauen Sie es nicht selbst: Greifen Sie zu [Response-Komprimierung in einer ASP.NET Core 11 API](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), die die Aushandlung und den `Content-Encoding`-Header für Sie erledigt, ohne die gesamte Antwort im Speicher zu puffern.

## Fallstricke und Verwechslungen

**`Response.Redirect` zählt als Header-Schreiboperation.** Ein Redirect setzt den `Location`-Header und einen 3xx-Status, sodass sein Aufruf nach jeder Body-Schreiboperation genau diese Ausnahme wirft. Wenn Sie sich dabei ertappen, aus einer Aktion heraus umzuleiten, die bereits Ausgabe geschrieben hat, ist der eigentliche Bug, dass die Entscheidung zur Umleitung zu spät getroffen wurde; verschieben Sie sie vor die erste Schreiboperation.

**Streaming-Endpunkte haben ein winziges Header-Fenster.** Wenn Sie [eine Datei aus einem Endpunkt ohne Pufferung streamen](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/), beginnt die Antwort in dem Moment, in dem der erste Chunk geleert wird. Jeder `Content-Disposition` oder `Content-Type`, den Sie möchten, muss vor jenem ersten `WriteAsync` gesetzt werden. Tritt mitten im Stream ein Fehler auf, können Sie nicht auf einen 500 umschalten, weil der 200-Header-Block bereits auf der Leitung ist; die Verbindung endet einfach. Entwerfen Sie Streaming-Handler so, dass sie alles validieren und alle Header im Voraus setzen.

**Dies ist nicht der Fehler zur synchronen I/O.** `Headers are read-only, response has already started` handelt von der *Reihenfolge*, nicht von synchron versus asynchron. Wenn Ihre Meldung stattdessen `Synchronous operations are disallowed` lautet, ist das ein anderes Problem mit einer anderen Behebung, behandelt in [InvalidOperationException: Synchronous operations are disallowed](/de/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed). Verwechseln Sie die beiden nicht; das Umstellen von `WriteAsync` auf `Write` hilft hier nicht, und das Umordnen hilft dort nicht.

**Blazor und Identity legen es indirekt offen.** Interaktive Blazor-Komponenten und ASP.NET Core Identity-Flows lösen dies manchmal aus Framework-Code aus, typischerweise wenn eine Komponente versucht, ein Cookie zu setzen oder umzuleiten, nachdem das Rendern begonnen hat, oder wenn eine Render-Mode-Diskrepanz die Ausgabe erzwingt, bevor die Authentifizierung läuft. Wenn der Stack Trace ins Blazor-Rendern statt in Ihre eigene Middleware zeigt, suchen Sie nach einem `NavigationManager.NavigateTo` oder einer Cookie-Schreiboperation, die nach dem ersten Rendern geschieht, und sehen Sie [a render mode is not supported by the parent component's render mode](/de/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor) für das benachbarte Render-Mode-Problem.

**Die Middleware-Reihenfolge entscheidet, wer gewinnt.** Eine Header-setzende Middleware funktioniert nur, wenn sie ihren `OnStarting`-Callback registriert oder ihre Header setzt, bevor die terminale Middleware den Body schreibt. Wenn Ihre benutzerdefinierte Header-Middleware für die Pfade, die sie treffen, *nach* `UseStaticFiles` oder der Endpunkt-Middleware in der Pipeline sitzt, ist es bereits zu spät. Registrieren Sie querschnittliche Response-Middleware früh in `Program.cs`.

**Doppelte Schreiboperationen in Ausnahmepfaden.** Ein häufiger Produktionsauslöser ist Code, der eine Teilerfolg-Antwort schreibt, dann auf eine Ausnahme stößt, und ein äußerer Handler versucht, sie mit einem Fehler zu überschreiben. Die erste Schreiboperation hat die Antwort bereits gestartet. Validieren und sammeln Sie alles, was fehlschlagen kann, bevor Sie das erste Byte schreiben, damit die Schreiboperation das Letzte ist, was der Handler tut, nicht das Erste.

## Verwandte Beiträge

- [So fügen Sie einen globalen Exception-Filter in ASP.NET Core 11 hinzu](/de/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) zeigt die `HasStarted`-Absicherung in einem echten Exception-Handler.
- [So streamen Sie eine Datei aus einem ASP.NET Core-Endpunkt ohne Pufferung](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) erklärt genau, wann eine gestreamte Antwort ihre Header festlegt.
- [So fügen Sie Response-Komprimierung zu einer ASP.NET Core 11 API hinzu](/de/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) ist der unterstützte Weg, den Body ohne manuelle Pufferung zu transformieren.
- [So geben Sie eine typisierte Results-Union aus einem Minimal-API-Endpunkt zurück](/de/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/) hält Status und Header deklarativ, sodass die Reihenfolge nicht schiefgehen kann.
- [Behebung: InvalidOperationException: Synchronous operations are disallowed](/de/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed) ist die andere InvalidOperationException, die ähnlich aussieht, es aber nicht ist.

## Quellen

- [Use HttpContext in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/use-http-context?view=aspnetcore-10.0), Microsoft Learn, für die Regel, dass Header, `StatusCode` und `ContentType` vor dem Schreiben gesetzt werden müssen, den exakten Ausnahmetext und den Hinweis, dass `WriteAsync` die Antwort leert und startet, weil die Pufferung standardmäßig deaktiviert ist.
- [HttpResponse.HasStarted](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.hasstarted), .NET API-Dokumentation, zum Erkennen, ob die Antwort sich festgelegt hat.
- [HttpResponse.OnStarting](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.onstarting), .NET API-Dokumentation, zum Registrieren von Arbeit, die unmittelbar vor dem Leeren der Header läuft.
- [Write custom ASP.NET Core middleware](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/write?view=aspnetcore-10.0), Microsoft Learn, zur Pipeline-Reihenfolge, die bestimmt, wer den Body zuerst schreibt.
