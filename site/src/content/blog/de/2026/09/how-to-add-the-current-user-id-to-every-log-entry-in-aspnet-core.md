---
title: "So fügen Sie die aktuelle Benutzer-ID jedem Log-Eintrag in ASP.NET Core hinzu"
description: "Eine BeginScope-Middleware verpasst das Fehler-Log des Exception Handlers und die Zeile Request finished. Registrieren Sie einen ILogEnricher, der den Benutzer aus IHttpContextAccessor liest, öffnen Sie einen Scope nur dann, wenn Arbeit die Anfrage verlässt, und achten Sie darauf, dass AddSerilog von Serilog die Anreicherung stillschweigend aushebelt."
pubDate: 2026-09-21
template: how-to
tags:
  - "aspnet-core"
  - "dotnet-10"
  - "logging"
  - "observability"
  - "opentelemetry"
  - "serilog"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core"
translatedBy: "claude"
translationDate: 2026-09-21
---

Kurz gesagt: Übergeben Sie die Benutzer-ID nicht an jeden `LogInformation`-Aufruf, und hören Sie nicht bei einer Middleware auf, die die Pipeline in `ILogger.BeginScope` einhüllt. Dieser Scope deckt nur Log-Aufrufe ab, die *innerhalb* von ihm stattfinden, und verpasst damit genau die zwei Zeilen, die Sie am dringendsten brauchen, wenn etwas kaputtgeht: den Fehler von `ExceptionHandlerMiddleware` und den Hosting-Eintrag "Request finished". Fügen Sie stattdessen `Microsoft.Extensions.Telemetry` hinzu, rufen Sie `builder.Logging.EnableEnrichment()` auf und registrieren Sie mit `builder.Services.AddLogEnricher<UserIdEnricher>()` einen `ILogEnricher`, der `ClaimTypes.NameIdentifier` aus `IHttpContextAccessor` liest. Er läuft einmal pro Log-Datensatz, für jede Kategorie, auch für die des Frameworks selbst. Nicht helfen kann er nur bei Arbeit, die die Anfrage überdauert. Erfassen Sie die ID also, bevor Sie Arbeit an `Task.Run` oder eine Queue übergeben, und öffnen Sie dort einen Scope.

Alles Folgende lief auf .NET 10 (SDK 10.0.302, ASP.NET Core Runtime 10.0.10) mit `Microsoft.Extensions.Telemetry` 10.10.0, `OpenTelemetry.Extensions.Hosting` und `OpenTelemetry.Exporter.Console` 1.19.1 sowie `Serilog.AspNetCore` 10.0.0. Die Ergebnistabelle stammt aus echten Anfragen gegen eine kleine Test-App, nicht aus der Lektüre der Dokumentation.

## Warum eine BeginScope-Middleware richtig aussieht und es nicht ist

Die Antwort, die Sie auf StackOverflow zuerst finden, ist eine Middleware wie diese:

```csharp
// .NET 10, ASP.NET Core 10: the common approach, and its gap
app.UseExceptionHandler("/error");
app.UseAuthentication();

app.Use(async (ctx, next) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);
    if (userId is null) { await next(ctx); return; }

    var logger = ctx.RequestServices.GetRequiredService<ILoggerFactory>()
        .CreateLogger("UserScope");
    using (logger.BeginScope(new Dictionary<string, object?> { ["UserId"] = userId }))
    {
        await next(ctx);
    }
});

app.UseAuthorization();
```

Für Ihren eigenen Code funktioniert das. Ein `log.LogInformation("Loading orders")` innerhalb eines Endpunkts erscheint mit `"UserId":"u-42"` in seinen Scopes. Das Problem ist struktureller Natur. Logging-Scopes leben in einem `AsyncLocal` und hängen sich daher an Log-Aufrufe, die erfolgen, während der `using`-Block auf dem Stack liegt. Zwei wichtige Log-Zeilen werden geschrieben, nachdem dieser Block bereits freigegeben wurde:

- `UseExceptionHandler` sitzt außerhalb der Scope-Middleware (das muss so sein, sonst kann er keine Ausnahmen aus der Authentifizierung abfangen). Wenn er "An unhandled exception has occurred while executing the request." protokolliert, hat sich die Ausnahme bereits durch Ihr `using` abgewickelt, und der Scope ist weg.
- "Request finished ... 500" wird von `Microsoft.AspNetCore.Hosting.Diagnostics` geschrieben, das die gesamte Middleware-Pipeline umschließt. Keine Middleware, die Sie schreiben, kann einen Scope darum legen.

Das Fehler-Log, also genau der Eintrag, den der Support nach Benutzer-ID durchsucht, ist damit der Eintrag ohne Benutzer-ID. Die Scope-Middleware über `UseExceptionHandler` zu verschieben, behebt das auch nicht, denn der Benutzer ist erst bekannt, wenn die Authentifizierung gelaufen ist.

Dasselbe `AsyncLocal`-Verhalten hat einen Vorteil, der dem Enricher fehlt: Ein Scope fließt mit dem `ExecutionContext` in `Task.Run` und andere Fortsetzungen, sodass Fire-and-Forget-Arbeit, die innerhalb der Anfrage gestartet wird, die ID behält, selbst nachdem die Antwort gesendet wurde.

## Was jeder Ansatz tatsächlich markiert

Ich habe in jeder Konfiguration drei Anfragen mit einem authentifizierten Benutzer `u-42` gegen dieselbe App geschickt: an einen Endpunkt, der protokolliert, an einen Endpunkt, der eine Ausnahme wirft, und an einen Endpunkt, der ein `Task.Run` startet, das 300 ms nach dem Senden der Antwort protokolliert. Die Ausgabe lief über `AddJsonConsole` mit `IncludeScopes = true` und wurde anschließend mit dem OpenTelemetry-Konsolenexporter wiederholt.

| Log-Eintrag | Middleware `BeginScope` | `ILogEnricher` | Enricher + Scope bei Übergabe |
| --- | --- | --- | --- |
| "Request starting" (Hosting) | nein | nein | nein |
| Eigenes `LogInformation` des Endpunkts | ja | ja | ja |
| Fehler von `ExceptionHandlerMiddleware` | **nein** | ja | ja |
| "Request finished" (Hosting) | **nein** | ja | ja |
| `Task.Run`-Log nach der Antwort | ja | **nein** | ja |

"Request starting" lässt sich konstruktionsbedingt nicht markieren: Der Eintrag wird geschrieben, bevor die Authentifizierung läuft, es gibt also noch keinen Benutzer. Verlassen Sie sich auf die gemeinsame `TraceId`, um ihn mit dem Rest der Anfrage zu verknüpfen.

## Schritt 1: den Enricher hinzufügen

Log-Anreicherung ist Teil der `dotnet/extensions`-Bibliotheken. `ILogEnricher` und `AddLogEnricher` liegen in `Microsoft.Extensions.Telemetry.Abstractions`; `EnableEnrichment()` liegt in `Microsoft.Extensions.Telemetry`, das die Abstraktionen referenziert, daher genügt ein Paket:

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.10.0
```

Der Enricher selbst besteht aus ein paar Zeilen:

```csharp
// .NET 10, Microsoft.Extensions.Telemetry 10.10.0
using System.Security.Claims;
using Microsoft.Extensions.Diagnostics.Enrichment;

public sealed class UserIdEnricher(IHttpContextAccessor accessor) : ILogEnricher
{
    public void Enrich(IEnrichmentTagCollector collector)
    {
        var userId = accessor.HttpContext?.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (userId is not null)
        {
            collector.Add("user.id", userId);
        }
    }
}
```

Anschließend verdrahten Sie ihn in `Program.cs`:

```csharp
// .NET 10, ASP.NET Core 10, Microsoft.Extensions.Telemetry 10.10.0
var builder = WebApplication.CreateBuilder(args);

builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();

builder.Services.AddAuthentication(/* your scheme */);
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseExceptionHandler("/error");
app.UseAuthentication();
app.UseAuthorization();
```

Eine Middleware ist nicht nötig. `EnableEnrichment()` tauscht die Standard-`LoggerFactory` gegen die erweiterte aus `Microsoft.Extensions.Telemetry` aus, die jeden registrierten `ILogEnricher` einmal pro Log-Datensatz aufruft und die Tags an den State des Datensatzes anhängt. Weil der Enricher den Benutzer im Moment des Log-Aufrufs liest und nicht in dem Moment, in dem ein Scope geöffnet wurde, findet er den Benutzer auch dann noch, wenn der Exception Handler und die Hosting-Diagnose ihre Einträge schreiben: `HttpContext` lebt, bis die Anfrage abgeschlossen ist.

In der JSON-Konsolenausgabe erscheint das Tag in `State`, neben den Parametern der Message Template, statt unter `Scopes`:

```json
{"EventId":1,"LogLevel":"Error","Category":"Microsoft.AspNetCore.Diagnostics.ExceptionHandlerMiddleware","Message":"An unhandled exception has occurred while executing the request.","State":{"user.id":"u-42","exception.type":"System.InvalidOperationException","{OriginalFormat}":"An unhandled exception has occurred while executing the request."}}
```

Hier wurden Ausnahmetext und Scopes gekürzt. Beachten Sie das kostenlose Tag `exception.type`: Der erweiterte Logger fügt es jedem Datensatz hinzu, der eine Ausnahme trägt, wodurch "alle Fehler dieses Benutzers, gruppiert nach Ausnahmetyp" zu einer einzigen Abfrage wird.

Ein paar Details sind hier wichtig:

- `AddLogEnricher<T>` registriert den Enricher als **Singleton** (`AddSingleton<ILogEnricher, T>()` im Quellcode). Injizieren Sie nur Singletons. `IHttpContextAccessor` ist ein Singleton, das ein `AsyncLocal` liest, und genau deshalb funktioniert es; ein Scoped Service wie Ihr `DbContext` oder ein Benutzerdienst pro Anfrage würde einmalig aus dem Root Provider erfasst.
- Eine doppelte Registrierung führt ihn doppelt aus, weil `AddSingleton` verwendet wird und nicht `TryAddEnumerable`.
- Der Enricher läuft für jeden Log-Datensatz im Prozess, einschließlich Start und Hintergrunddiensten. Halten Sie ihn allokationsfrei und lassen Sie ihn stillschweigend zurückkehren, wenn `HttpContext` null ist.

## Schritt 2: die ID über die Anfragegrenze hinweg mitnehmen

`IHttpContextAccessor.HttpContext` wird null, sobald die Anfrage beendet ist, daher kann der Enricher keine Arbeit markieren, die die Anfrage überdauert. Das ist die letzte Zeile der Tabelle. Erfassen Sie die ID, solange Sie die Anfrage noch haben, und öffnen Sie einen Scope innerhalb der Hintergrundarbeit:

```csharp
// .NET 10, ASP.NET Core 10
app.MapPost("/reports", (HttpContext ctx, ILogger<Program> log) =>
{
    var userId = ctx.User.FindFirstValue(ClaimTypes.NameIdentifier);

    _ = Task.Run(async () =>
    {
        using var scope = log.BeginScope("user.id:{user.id}", userId);
        await Task.Delay(300);
        log.LogInformation("Background work finished");
    });

    return Results.Accepted();
});
```

Mit dieser Änderung kam die Hintergrundzeile mit dem Scope `{"Message":"user.id:u-42","user.id":"u-42"}` heraus, sodass jede Zeile der Tabelle markiert ist, außer "Request starting". Verwenden Sie denselben Schlüssel wie der Enricher, damit Ihre Abfragen kein `OR` brauchen.

Zwei Anmerkungen zu diesem Snippet. Erstens: Verwenden Sie die Message-Template-Überladung von `BeginScope`. Ein bloßer `Dictionary<string, object?>`-Scope funktioniert zwar, aber die Konsolen- und OpenTelemetry-Exporter geben dessen `ToString()`, also ``System.Collections.Generic.Dictionary`2[System.String,System.Object]``, als Scope-Nachricht aus. Zweitens: `Task.Run` aus einem Endpunkt ist nur ein Platzhalter für eine Übergabe. Für echte Fire-and-Forget-Arbeit legen Sie die Benutzer-ID auf das Arbeitselement, das Sie an einen `BackgroundService` einreihen, und öffnen den Scope, wenn der Worker es aus der Queue holt. Das Muster und seine Fallstricke behandelt [Fire-and-Forget-Arbeit sicher mit BackgroundService ausführen](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Schritt 3: sicherstellen, dass Ihr Sink es auch anzeigt

Wo das Tag landet, hängt vom Provider ab.

**Konsolenformatierer.** Angereicherte Tags sind Teil des States, daher zeigt `AddJsonConsole` sie auch mit `IncludeScopes = false` an. Der Übergabe-Scope aus Schritt 2 braucht `IncludeScopes = true`, was bei jedem Konsolenformatierer standardmäßig ausgeschaltet ist. Der einfache Konsolenformatierer gibt weder State-Eigenschaften noch, ohne `IncludeScopes`, Scopes aus. Verwenden Sie also den JSON-Formatierer oder einen richtigen Sink.

**OpenTelemetry.** Mit `builder.Logging.AddOpenTelemetry(o => { o.IncludeScopes = true; o.AddConsoleExporter(); })` wurde das angereicherte Tag zu einem regulären Attribut des Log-Datensatzes (`LogRecord.Attributes: user.id: u-42`) beim Endpunkt-Log, beim Fehler des Exception Handlers und bei "Request finished", während der Übergabe-Scope als `[Scope.3]:UserId: u-42` in `ScopeValues` ankam. Ohne `IncludeScopes = true` werden Scope-Werte verworfen, sodass die Hintergrundzeile ihre ID verlieren würde. Wenn Sie ohnehin auf OpenTelemetry umsteigen, behandelt [die Migration des Loggings von Serilog zu OpenTelemetry](/de/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/) die Exporter-Seite.

**Serilog: die Falle.** Diese hat mich am meisten Zeit gekostet. `Serilog.AspNetCore` empfiehlt `builder.Services.AddSerilog(...)`, das Serilogs eigene `ILoggerFactory` registriert. `EnableEnrichment()` ersetzt ebenfalls `ILoggerFactory`. Die letzte Registrierung gewinnt, und keine von beiden sagt es Ihnen:

| Registrierung | Ergebnis |
| --- | --- |
| `Services.AddSerilog(...)`, dann `EnableEnrichment()` | **Überhaupt keine Log-Ausgabe**: Die erweiterte Factory gewinnt und hat keine Provider |
| `EnableEnrichment()`, dann `Services.AddSerilog(...)` | Logs funktionieren, aber der Enricher läuft nie; nirgends ein `user.id` |
| `EnableEnrichment()` plus `builder.Logging.AddSerilog(logger)` | Funktioniert in beliebiger Reihenfolge; `user.id` in jeder Zeile, die der Enricher abdeckt |

Die erste Zeile ist keine Redewendung. Die App hat Anfragen bedient und null Bytes nach stdout geschrieben. Die funktionierende Kombination registriert Serilog als `ILoggerProvider` unter der Microsoft-Factory:

```csharp
// .NET 10, Serilog.AspNetCore 10.0.0, Microsoft.Extensions.Telemetry 10.10.0
using Serilog;
using Serilog.Formatting.Compact;

var serilog = new LoggerConfiguration()
    .MinimumLevel.Information()
    .Enrich.FromLogContext()
    .WriteTo.Console(new CompactJsonFormatter())
    .CreateLogger();

builder.Logging.ClearProviders();
builder.Logging.AddSerilog(serilog, dispose: true);
builder.Logging.EnableEnrichment();
builder.Services.AddHttpContextAccessor();
builder.Services.AddLogEnricher<UserIdEnricher>();
```

Serilog macht aus dem angereicherten Tag eine vollwertige `user.id`-Eigenschaft und übernimmt auch `BeginScope`-Werte, sodass der Scope aus Schritt 2 unverändert funktioniert. Der Preis: `Services.AddSerilog` ist auch das, was Serilogs `IDiagnosticContext` registriert, das `UseSerilogRequestLogging` benötigt. Wenn Sie von dieser Middleware abhängen, behalten Sie `Services.AddSerilog`, lassen `EnableEnrichment` weg und gehen den Serilog-Weg: Schieben Sie die ID mit `LogContext.PushProperty("UserId", userId)` in einer Middleware nach `UseAuthentication` in den Kontext und fügen Sie sie mit `options.EnrichDiagnosticContext = (dc, http) => dc.Set("UserId", http.User.FindFirstValue(ClaimTypes.NameIdentifier))` dem Abschlussereignis hinzu. Ich habe die `PushProperty`-Middleware allein gemessen, und sie hat genau dieselben Lücken wie `BeginScope` (keine ID beim Fehler des Exception Handlers oder bei "Request finished"), weshalb der Diagnostic-Context-Callback wichtig ist. Das grundlegende Serilog-Setup finden Sie in [strukturiertes Logging mit Serilog und Seq](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

## Fallstricke, die in der Produktion zuschlagen

**Die Benutzer-ID ist ein personenbezogenes Datum.** Unter der DSGVO macht eine stabile Konto-ID an jeder Log-Zeile diese Logs zu personenbezogenen Daten, was sich auf Aufbewahrung und Lesezugriff auswirkt. Protokollieren Sie eine undurchsichtige interne ID, niemals eine E-Mail-Adresse oder einen `name`-Claim, und wenn Ihr Compliance-Team es verlangt, hashen oder schwärzen Sie sie auf der Logging-Ebene. Die Redaction-Unterstützung von .NET kann das pro Eigenschaft erledigen; siehe [sensible Werte mit LogProperties schwärzen](/de/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/).

**Wählen Sie den richtigen Claim.** `ClaimTypes.NameIdentifier` ist das, was ASP.NET Core Identity und Cookie-Authentifizierung befüllen. JWT Bearer bildet den `sub`-Claim des Tokens nur dann auf `NameIdentifier` ab, solange `JwtBearerOptions.MapInboundClaims` `true` ist, was der Standard ist. Viele APIs schalten das ab, um die rohen JWT-Claim-Namen zu behalten, und ab dann kommt das Subject als `sub` an und der obige Enricher protokolliert stillschweigend nichts. Lesen Sie `User.FindFirstValue("sub") ?? User.FindFirstValue(ClaimTypes.NameIdentifier)`, wenn Sie nicht sicher sind, was Sie bekommen.

**Die Authentifizierung muss vor dem Log-Aufruf laufen, nicht vor der Registrierung.** Der Enricher liest `HttpContext.User` verzögert, daher markiert er alles, was nach dem Durchlauf der Authentifizierungs-Middleware protokolliert wird, egal wo diese Middleware sitzt. Wenn Sie sich auf die automatische Authentifizierungs-Middleware verlassen, die `WebApplication` hinzufügt, sobald Authentifizierungsdienste registriert sind, und `UseAuthentication` nicht selbst aufrufen, läuft sie früh in der Pipeline und Sie sind abgedeckt.

**Interaktives Blazor und SignalR.** `IHttpContextAccessor` ist in interaktiven Blazor-Server-Komponenten keine verlässliche Quelle für den aktuellen Benutzer; die ASP.NET-Core-Dokumentation rät, es beim interaktiven Rendering zu vermeiden. Für Circuits und Hub-Aufrufe holen Sie den Benutzer aus `AuthenticationStateProvider` oder `HubCallerContext.User` und öffnen stattdessen einen Scope um die Arbeit.

**Enricher laufen pro Datensatz, also halten Sie sie günstig.** Ein Claim-Lookup über eine Handvoll Claims ist trivial, aber lösen Sie in `Enrich` keine Dienste auf, fragen Sie keine Datenbank ab und allokieren Sie keine Strings. Ist ein Wert für den Prozess konstant (Version, Region), verwenden Sie `IStaticLogEnricher`, der einmal läuft.

**Setzen Sie die ID nicht zusätzlich in Ihre Message Templates.** `LogInformation("User {UserId} loaded orders", userId)` dupliziert die Eigenschaft und spaltet, wenn die Schlüssel sich unterscheiden, Ihre Abfragen auf. Halten Sie Templates beim Ereignis; den Rest dieser Disziplin finden Sie unter [von String-Interpolation zu Message Templates wechseln](/de/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/).

### Weiterlesen

- [So richten Sie strukturiertes Logging mit Serilog und Seq in .NET 11 ein](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/)
- [Migration von Serilog zu OpenTelemetry-Logging in .NET 11](/de/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/)
- [So schwärzen Sie sensible Werte in Logs mit LogProperties in .NET](/de/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [So führen Sie Fire-and-Forget-Arbeit sicher in ASP.NET Core mit BackgroundService aus](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)

### Quellen

- [Übersicht über Log-Anreicherung](https://learn.microsoft.com/dotnet/core/enrichment/overview) und [Benutzerdefinierter Log-Enricher](https://learn.microsoft.com/dotnet/core/enrichment/custom-enricher) auf Microsoft Learn
- [`EnrichmentServiceCollectionExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Telemetry.Abstractions/Enrichment/EnrichmentServiceCollectionExtensions.cs) in dotnet/extensions (Singleton-Registrierung)
- [Logging in .NET: Log-Scopes](https://learn.microsoft.com/dotnet/core/extensions/logging#log-scopes)
- [Zugriff auf HttpContext in ASP.NET Core](https://learn.microsoft.com/aspnet/core/fundamentals/http-context) (einschließlich der Hinweise zu interaktivem Blazor)
- [Serilog.AspNetCore README](https://github.com/serilog/serilog-aspnetcore)
- [OpenTelemetry .NET logs: IncludeScopes](https://github.com/open-telemetry/opentelemetry-dotnet/tree/main/docs/logs)
