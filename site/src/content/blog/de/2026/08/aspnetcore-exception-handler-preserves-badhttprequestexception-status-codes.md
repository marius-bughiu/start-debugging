---
title: "ASP.NET Core macht aus 413 kein 500 mehr in UseExceptionHandler"
description: "Ein am 2026-08-19 in dotnet/aspnetcore main integrierter PR sorgt dafür, dass ExceptionHandlerMiddleware BadHttpRequestException.StatusCode beachtet, statt ihn mit 500 zu überschreiben."
pubDate: 2026-08-20
tags:
  - "aspnetcore"
  - "dotnet"
  - "error-handling"
  - "dotnet-11"
lang: "de"
translationOf: "2026/08/aspnetcore-exception-handler-preserves-badhttprequestexception-status-codes"
translatedBy: "claude"
translationDate: 2026-08-20
---

Wenn Sie `app.UseExceptionHandler()` in der Produktion einsetzen, taucht jede von Kestrel wegen Überlänge abgelehnte Anfrage in Ihrer Telemetrie als Serverfehler auf. [PR #68632](https://github.com/dotnet/aspnetcore/pull/68632) ist am 2026-08-19 in `main` von `dotnet/aspnetcore` gelandet und behebt das. Er schließt [Issue #43831](https://github.com/dotnet/aspnetcore/issues/43831) aus dem September 2022.

## Der 500, der eigentlich ein 413 war

`ExceptionHandlerMiddleware` setzt den Statuscode der Antwort, bevor es Ihren Handler aufruft, und bis zu diesem PR war 500 fest verdrahtet, sobald `ExceptionHandlerOptions.StatusCodeSelector` null war. `BadHttpRequestException` trägt einen eigenen `StatusCode`, und dieser Wert wurde verworfen.

So sieht das aus, geprüft gegen ASP.NET Core 10.0.0 auf SDK 10.0.201:

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 100);

var app = builder.Build();
app.UseExceptionHandler();

app.MapPost("/upload", async (HttpContext ctx) =>
{
    using var ms = new MemoryStream();
    await ctx.Request.Body.CopyToAsync(ms);   // throws when the body exceeds 100 bytes
    return Results.Ok(ms.Length);
});

app.Run();
```

Senden Sie 500 Bytes per `POST` an `/upload`. Die Ausnahme, die die Middleware erreicht, ist `BadHttpRequestException` mit `StatusCode = 413` und der Meldung "Request body too large. The max request body size is 100 bytes." Zurück kommt tatsächlich:

```
HTTP/1.1 500 Internal Server Error
Content-Type: application/problem+json

{"type":"https://tools.ietf.org/html/rfc9110#section-15.6.1",
 "title":"An error occurred while processing your request.","status":500,...}
```

Dem Client wird gesagt, er habe den Server zerstört. Ihre 5xx-Dashboards sehen das genauso. Es ist dieselbe Art von Verwirrung wie bei [413 Request Entity Too Large beim Datei-Upload](/de/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/), nur dass hier der korrekte Status nie auf die Leitung gelangt.

## Was sich geändert hat

Die Middleware führt jetzt einen Mustervergleich auf der Ausnahme durch, bevor sie auf 500 zurückfällt:

```csharp
context.Response.StatusCode = _options.StatusCodeSelector?.Invoke(edi.SourceException)
    ?? (edi.SourceException switch
    {
        BadHttpRequestException badHttpRequestException => badHttpRequestException.StatusCode,
        _ => DefaultStatusCode,
    });
```

Drei Details lohnen sich. `StatusCodeSelector` hat weiterhin Vorrang, wenn Sie einen setzen, bestehende Überschreibungen behalten also ihr Verhalten. Eigene `ExceptionHandler` Delegates und `IExceptionHandler` Services können den Code danach weiterhin ändern. Und ein 404, den eine `BadHttpRequestException` transportiert, gilt nun als beabsichtigt statt als falsch konfigurierter Handler und braucht kein `AllowStatusCode404Response = true` mehr, um zu überleben.

Der Umfang ist bewusst eng: nur `BadHttpRequestException` wird neu abgebildet. Ein Aufruf von `Request.ReadFormAsync()` mit einem `text/plain` Body wirft `InvalidOperationException` ("Incorrect Content-Type"), und das liefert davor wie danach 500. Das Model Binding der Minimal APIs bleibt ebenfalls unberührt, denn ein fehlerhafter JSON-Body wird vom Request Delegate in einen nackten 400 verwandelt, bevor überhaupt eine Ausnahme entweicht.

Zum Zeitpunkt des Schreibens liegt der Commit nur in `main`. Er ist nicht im Branch `release/11.0-rc1`, erwarten Sie ihn also in einem späteren .NET 11 Build und nicht in RC1. Wer heute auf .NET 8 bis 11 unterwegs ist, behilft sich weiterhin mit einem `StatusCodeSelector`, der die Ausnahme selbst auspackt.
