---
title: "Wie Sie einen globalen Exception-Filter in ASP.NET Core 11 hinzufügen"
description: "Ein vollständiger Leitfaden zur globalen Ausnahmebehandlung in ASP.NET Core 11: warum IExceptionFilter das falsche Werkzeug ist, wie IExceptionHandler und UseExceptionHandler zusammenarbeiten, ProblemDetails-Antworten, Multi-Handler-Ketten und die Breaking Change in .NET 10 zur Unterdrückung von Diagnostics."
pubDate: 2026-04-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "error-handling"
lang: "de"
translationOf: "2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-04-26
---

Um jede unbehandelte Ausnahme in einer ASP.NET Core 11-Anwendung abzufangen und in eine saubere HTTP-Antwort umzuwandeln, implementieren Sie `IExceptionHandler`, registrieren ihn mit `services.AddExceptionHandler<T>()` und platzieren `app.UseExceptionHandler()` früh in der Middleware-Pipeline. Der alte MVC-`IExceptionFilter` greift nur für Controller-Aktionen, übersieht also Minimal-API-Endpunkte, Middleware-Ausnahmen, Model-Binding-Fehler und alles, was vor dem MVC-Lauf geworfen wird. Der handlerbasierte Ansatz ersetzt ihn pipelineweit, integriert sich mit `ProblemDetails` für RFC-7807-Antworten und funktioniert auf Native AOT, Minimal APIs und Controllern gleichermaßen. Alles in diesem Leitfaden zielt auf .NET 11 (Preview 3) mit `Microsoft.NET.Sdk.Web` und C# 14, aber die API ist seit .NET 8 stabil und die Muster gelten unverändert in .NET 9 und .NET 10.

## "Exception-Filter" ist der Suchbegriff, aber Sie wollen fast nie einen

Wenn Entwickler fragen, wie man einen "globalen Exception-Filter" hinzufügt, ist das suchmaschinenführende Ergebnis meist eine Stack-Overflow-Antwort von 2017, die auf `IExceptionFilter` und `MvcOptions.Filters.Add<T>` verweist. Der Code kompiliert noch und läuft noch, aber er ist seit ASP.NET Core 8 nicht mehr die richtige Antwort.

`IExceptionFilter` lebt in `Microsoft.AspNetCore.Mvc.Filters`. Er gehört zur MVC-Pipeline, was drei Dinge bedeutet:

1. Er fängt nur Ausnahmen ab, die innerhalb einer MVC-Aktion, eines MVC-Filters oder eines Result-Executors geworfen werden. Alles, was früher in der Pipeline geworfen wird (Model-Binding-Fehler, Authentifizierungsfehler, Routing-404), erreicht ihn nie.
2. Er sieht keine Ausnahmen aus Minimal-API-Endpunkten (`app.MapGet("/", ...)`). Minimal APIs laufen nicht durch `MvcRoutedActionInvoker`, daher schweigen MVC-Filter für sie.
3. Er läuft, nachdem das Model Binding bereits einen `ModelState`-Fehler erzeugt hat, sodass ein fehlerhafter Request-Body bereits ein 400 vom Framework zurückgibt, bevor Ihr Filter die Ausnahme überhaupt sieht, die Sie übersetzen wollten.

Das moderne Äquivalent ist `IExceptionHandler`, eingeführt in `Microsoft.AspNetCore.Diagnostics` 8.0 und unverändert in .NET 11. Er läuft aus dem `UseExceptionHandler`-Middleware heraus, das ganz oben in der Pipeline sitzt, sodass ein einzelner Handler Controller, Minimal APIs, gRPC, SignalR-Negotiation, statische Dateien und vom Middleware geworfene Ausnahmen an einer Stelle abdeckt. Das ist gemeint, wenn von "global" die Rede ist.

Der Rest dieses Leitfadens ist der `IExceptionHandler`-Weg. Der letzte Abschnitt behandelt die wenigen Fälle, in denen ein MVC-Filter immer noch das richtige Werkzeug ist.

## Der minimale IExceptionHandler

`IExceptionHandler` ist ein Interface mit nur einer Methode:

```csharp
// .NET 11, C# 14
namespace Microsoft.AspNetCore.Diagnostics;

public interface IExceptionHandler
{
    ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken);
}
```

Geben Sie `true` zurück, wenn Sie die Antwort geschrieben haben und das Middleware stoppen soll. Geben Sie `false` zurück, um zum nächsten Handler in der Kette weiterzureichen (oder, falls keiner sie behandelt, an die Standard-Fehlerantwort des Frameworks).

Ein funktionierender Handler, der "jede Ausnahme in ein 500 mit JSON-Body übersetzt", ist etwa 30 Zeilen lang:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

internal sealed class GlobalExceptionHandler(
    ILogger<GlobalExceptionHandler> logger,
    IProblemDetailsService problemDetailsService) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogError(exception, "Unhandled exception on {Path}", httpContext.Request.Path);

        httpContext.Response.StatusCode = StatusCodes.Status500InternalServerError;

        return await problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = httpContext,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.6.1",
                Title = "An unexpected error occurred",
                Status = StatusCodes.Status500InternalServerError,
            },
        });
    }
}
```

Zwei Details sind hier wichtig. Erstens ist der Handler `sealed` und nutzt Dependency Injection per Primary Constructor, was dem Idiom von C# 12+ entspricht. Zweitens delegieren wir den eigentlichen Antwort-Body an `IProblemDetailsService`, statt selbst `httpContext.Response.WriteAsJsonAsync(...)` aufzurufen. Genau diese Änderung sorgt dafür, dass die Antwort den `Accept`-Header des Clients, die registrierten `IProblemDetailsWriter`-Instanzen und jeden konfigurierten `CustomizeProblemDetails`-Callback respektiert. Dazu kommen wir im Abschnitt zu ProblemDetails zurück.

## Den Handler in Program.cs verdrahten

Drei Zeilen fügen den Handler hinzu. Die Reihenfolge des Middleware ist wichtig:

```csharp
// .NET 11, C# 14, Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();

var app = builder.Build();

app.UseExceptionHandler();   // must come before UseAuthorization, MapControllers, etc.
app.UseStatusCodePages();    // optional, formats 4xx the same way

app.MapControllers();
app.Run();
```

`AddExceptionHandler<T>` registriert den Handler als Singleton, was vom Framework erzwungen wird. Wenn Ihr Handler Scoped-Services benötigt (einen `DbContext`, einen request-scoped Logger), injizieren Sie `IServiceProvider` und erzeugen pro Aufruf einen Scope, statt den Scoped-Service im Konstruktor zu beziehen:

```csharp
// .NET 11, C# 14
internal sealed class DbBackedExceptionHandler(IServiceScopeFactory scopes) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<AuditDbContext>();
        db.Failures.Add(new FailureRecord(ctx.TraceIdentifier, ex.GetType().FullName!));
        await db.SaveChangesAsync(ct);
        return false; // let another handler write the response
    }
}
```

`UseExceptionHandler()` ohne Argumente verwendet die registrierte `IExceptionHandler`-Kette. Die Überladung, die einen `string`-Pfad oder ein `Action<IApplicationBuilder>` annimmt, ist das ältere reine Middleware-Modell und umgeht die Handler-Kette. Wählen Sie das eine oder das andere, nicht beides.

## ProblemDetails kostenlos, sobald Sie es verdrahten

`AddProblemDetails()` registriert den Standard-`IProblemDetailsService` und einen `IProblemDetailsWriter` für `application/problem+json`. Sobald es registriert ist, passieren drei Dinge automatisch:

1. `UseExceptionHandler()` schreibt einen `ProblemDetails`-Body für unbehandelte Ausnahmen, wenn kein `IExceptionHandler` die Antwort beansprucht.
2. `UseStatusCodePages()` schreibt einen `ProblemDetails`-Body für 4xx-Antworten ohne Body.
3. Ihr eigener Handler kann `problemDetailsService.TryWriteAsync(...)` aufrufen, um dieselbe Content Negotiation und Anpassung kostenlos zu erhalten.

Der nützlichste Anpassungspunkt ist `CustomizeProblemDetails`, der ausgeführt wird, nachdem Ihr Handler das Objekt gebaut hat und bevor es geschrieben wird. Eine typische Site fügt den Trace Identifier hinzu, damit der Support einen für den Benutzer sichtbaren Fehler mit einem Logeintrag korrelieren kann:

```csharp
// .NET 11, C# 14
builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = ctx =>
    {
        ctx.ProblemDetails.Extensions["traceId"] = ctx.HttpContext.TraceIdentifier;
        ctx.ProblemDetails.Extensions["requestId"] =
            Activity.Current?.Id ?? ctx.HttpContext.TraceIdentifier;
    };
});
```

Setzen Sie keine Exception-Messages oder Stack Traces in die Antwort in der Produktion. Sie verraten interne Struktur (Tabellennamen, Dateipfade, Drittanbieter-API-URLs), die ein Angreifer zu einer gezielteren Sondierung verketten kann. Bedingen Sie jede `ex.Message`-Wiedergabe an `IHostEnvironment.IsDevelopment()`.

## Mehrere Handler, geordnet nach Ausnahmetyp

Das Exception-Middleware iteriert die registrierten Handler in der Registrierungsreihenfolge, bis einer `true` zurückgibt. Das ist der richtige Ort für eine Übersetzung pro Ausnahmetyp:

```csharp
// .NET 11, C# 14
internal sealed class ValidationExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not FluentValidation.ValidationException ve) return false;

        ctx.Response.StatusCode = StatusCodes.Status400BadRequest;

        var errors = ve.Errors
            .GroupBy(e => e.PropertyName)
            .ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage).ToArray());

        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new HttpValidationProblemDetails(errors)
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.1",
                Title = "One or more validation errors occurred",
                Status = StatusCodes.Status400BadRequest,
            },
        });
    }
}

internal sealed class NotFoundExceptionHandler(IProblemDetailsService pds) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext ctx, Exception ex, CancellationToken ct)
    {
        if (ex is not EntityNotFoundException) return false;

        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return await pds.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = ctx,
            Exception = ex,
            ProblemDetails = new ProblemDetails
            {
                Type = "https://tools.ietf.org/html/rfc9110#section-15.5.5",
                Title = "Resource not found",
                Status = StatusCodes.Status404NotFound,
            },
        });
    }
}
```

Registrieren Sie sie in Prioritätsreihenfolge. Der Catch-all-500-Handler kommt zuletzt:

```csharp
// .NET 11, C# 14
builder.Services.AddExceptionHandler<ValidationExceptionHandler>();
builder.Services.AddExceptionHandler<NotFoundExceptionHandler>();
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
```

Das Middleware iteriert die Singletons genau in dieser Reihenfolge. Gibt `ValidationExceptionHandler` `false` zurück, wird der nächste Handler gefragt. Gibt `GlobalExceptionHandler` `true` zurück, läuft kein weiterer Handler.

Widerstehen Sie der Versuchung, einen Mega-Handler mit einem riesigen `switch` zu schreiben. Pro-Ausnahme-Handler sind einfacher zu unit-testen (jeder ist eine kleine Klasse, die ein Fake annimmt), einfacher zu löschen, wenn ein Ausnahmetyp verschwindet, und einfacher bedingt zu verdrahten (z. B. `ValidationExceptionHandler` nur dann zu registrieren, wenn FluentValidation im Projekt ist).

## Middleware-Reihenfolge, die den Handler bricht

Der häufigste Fehler ist, `UseExceptionHandler()` an die falsche Stelle zu setzen. Die Regel lautet: Es muss vor jedem Middleware kommen, das eine Ausnahme werfen könnte, die Sie abfangen möchten. In der Praxis bedeutet das, es sollte das erste umgebungsunabhängige Middleware sein.

```csharp
// Wrong: a NullReferenceException from authentication never reaches the handler.
app.UseAuthentication();
app.UseAuthorization();
app.UseExceptionHandler();   // too late
app.MapControllers();

// Right: the handler wraps everything that follows.
app.UseExceptionHandler();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
```

Das einzige, was legitimerweise vor `UseExceptionHandler` läuft, ist die Developer Exception Page in Nicht-Produktivumgebungen:

```csharp
// .NET 11, C# 14
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
}
else
{
    app.UseExceptionHandler();
    app.UseHsts();
}
```

Wenn Sie beide registrieren, gewinnt die Developer Page in dev, weil sie die Anfrage kurzschließt, bevor das Handler-Middleware läuft. Das ist normalerweise erwünscht: Die Dev-Seite zeigt den Stack Trace und das Quellcode-Snippet, was der ganze Sinn des lokalen Ausführens ist.

## Die Breaking Change zur Diagnostics-Unterdrückung in .NET 10

In .NET 8 und 9 hat `UseExceptionHandler` die unbehandelte Ausnahme immer auf `Error`-Level geloggt und die Activity `Microsoft.AspNetCore.Diagnostics.HandlerException` emittiert, unabhängig davon, ob Ihr `IExceptionHandler` `true` zurückgab. Das machte doppeltes Logging einfach: Ihr Handler loggte, und das Framework auch.

Ab .NET 10 (und in .NET 11 beibehalten) unterdrückt das Framework seine eigenen Diagnostics für jede Ausnahme, die ein Handler durch Rückgabe von `true` beansprucht hat. Ihr Handler ist nun in diesem Fall allein verantwortlich für das Logging. Ausnahmen, die unbehandelt durchfallen, emittieren weiterhin das Framework-Log.

Das ist eine Verhaltensänderung, die Sie still treffen kann. Wenn Sie einen Grafana-Alert auf `aspnetcore.diagnostics.handler.unhandled_exceptions` haben und auf .NET 10 oder neuer aktualisieren, fällt die Metrik für behandelte Ausnahmen auf null und Ihr Dashboard wird flach. Die Lösung ist:

```csharp
// Opt back in to the .NET 8/9 behaviour.
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = _ => false,
});
```

Oder, bevorzugt, das Dashboard löschen und sich auf das Logging Ihres Handlers verlassen. Doppeltes Zählen war schon immer ein Bug.

Der Callback erhält einen `ExceptionHandlerDiagnosticsContext` mit der Ausnahme, der Anfrage und einem Flag dafür, ob ein Handler die Antwort beansprucht hat, sodass Sie selektiv unterdrücken können, etwa keine `OperationCanceledException` von einer vom Client abgebrochenen Anfrage zu loggen:

```csharp
// .NET 11, C# 14
app.UseExceptionHandler(new ExceptionHandlerOptions
{
    SuppressDiagnosticsCallback = ctx =>
        ctx.Exception is OperationCanceledException &&
        ctx.HttpContext.RequestAborted.IsCancellationRequested,
});
```

Siehe die [Breaking-Change-Notiz auf Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed) für die genaue Semantik.

## Wann IExceptionFilter immer noch das richtige Werkzeug ist

Es gibt zwei enge Fälle, in denen das MVC-`IExceptionFilter` immer noch korrekt ist:

1. Sie wollen eine Ausnahme nur für einen bestimmten Controller oder eine bestimmte Aktion übersetzen und den Filter über Action-Attribute auffindbar machen. `[TypeFilter(typeof(MyExceptionFilter))]` an der Controller-Klasse begrenzt das Verhalten, ohne die globale Pipeline zu verschmutzen. Das ist eher ein Action-Filter für einen einzelnen, eigentümlichen Endpunkt als etwas wirklich "Globales".
2. Sie benötigen Zugriff auf den MVC-`ActionContext` (z. B. den `IModelMetadataProvider` für die Parameter der Aktion). `IExceptionHandler` sieht nur den `HttpContext`, sodass diese Metadaten dort nicht verfügbar sind.

Außerhalb davon gewinnt `IExceptionHandler`. Er funktioniert für Minimal APIs, läuft vor dem MVC und komponiert sauber mit mehreren registrierten Handlern. Behandeln Sie den MVC-Filter als action-scoped Werkzeug, nicht als globales.

## Ein häufiger Fehler: Werfen aus einem benutzerdefinierten IProblemDetailsWriter

Wenn Sie einen benutzerdefinierten `IProblemDetailsWriter` implementieren (z. B. um einen herstellerspezifischen Fehlerumschlag auszugeben), werfen Sie nicht aus `WriteAsync`. Das Exception-Middleware fängt diese Ausnahme ebenfalls ab, recursiert zurück in dieselbe Handler-Kette, und Sie erhalten entweder einen Stack Overflow oder, mit Glück, ein leeres 500 ohne Body. Wickeln Sie die Body-Schreiblogik in ein try/catch und geben Sie `false` aus `CanWrite` zurück, wenn sich der Writer in einem schlechten Zustand befindet. Dieselbe Regel gilt für Handler-Code: Werfen Sie nicht aus `TryHandleAsync`. Geben Sie stattdessen `false` zurück.

Eine sichere Form:

```csharp
// .NET 11, C# 14
public async ValueTask<bool> TryHandleAsync(
    HttpContext ctx, Exception ex, CancellationToken ct)
{
    try
    {
        ctx.Response.StatusCode = MapStatus(ex);
        await pds.TryWriteAsync(BuildContext(ctx, ex));
        return true;
    }
    catch
    {
        return false; // let the framework default kick in
    }
}
```

## Verwandt

- [Benutzerdefinierter JsonConverter in System.Text.Json](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) zum Serialisieren des `ProblemDetails.Extensions`-Dictionarys, wie Ihre Clients es erwarten.
- [Eine Datei aus einem ASP.NET-Core-Endpunkt ohne Buffering streamen](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) behandelt eine weitere Subtilität der Middleware-Reihenfolge in derselben Pipeline.
- [Eine länger laufende Task ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) für die `OperationCanceledException`-Muster, auf denen der obige Diagnostics-Callback basiert.
- [Stark typisierte Clients aus einer OpenAPI-Spezifikation in .NET 11 generieren](/de/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/), wenn Sie das `ProblemDetails`-Schema an Konsumenten veröffentlichen.

## Quellen

- Microsoft Learn, [Fehler in ASP.NET Core behandeln](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling?view=aspnetcore-10.0).
- Microsoft Learn, [Fehler in ASP.NET-Core-APIs behandeln](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/error-handling-api?view=aspnetcore-10.0).
- Microsoft Learn Breaking Change, [Exception-Diagnostics werden unterdrückt, wenn IExceptionHandler.TryHandleAsync true zurückgibt](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/exception-handler-diagnostics-suppressed).
- ASP.NET Core Release Notes, [.NET 10 preview 7 ASP.NET Core](https://github.com/dotnet/core/blob/main/release-notes/10.0/preview/preview7/aspnetcore.md).
- GitHub-Diskussion, [IExceptionHandler in .NET 8 für globales Exception Handling](https://github.com/dotnet/aspnetcore/discussions/54613).
