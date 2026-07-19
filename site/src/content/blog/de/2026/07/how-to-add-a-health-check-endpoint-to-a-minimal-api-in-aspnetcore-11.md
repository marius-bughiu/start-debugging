---
title: "So fügen Sie einer Minimal API in ASP.NET Core 11 einen Health-Check-Endpunkt hinzu"
description: "Ein vollständiger, funktionierender Leitfaden zu Health Checks in einer ASP.NET Core 11 Minimal API: AddHealthChecks und MapHealthChecks, eigene IHealthCheck-Klassen, die Healthy/Degraded/Unhealthy zurückgeben, die EF Core-Sonde AddDbContextCheck, tag-basierte Liveness- und Readiness-Endpunkte für Kubernetes, ein JSON-ResponseWriter, ResultStatusCodes, das Absichern des Endpunkts mit RequireAuthorization und RequireHost sowie das Pushen von Ergebnissen mit IHealthCheckPublisher."
pubDate: 2026-07-19
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "health-checks"
lang: "de"
translationOf: "2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-19
---

Um einer Minimal API in ASP.NET Core 11 einen Health-Check-Endpunkt hinzuzufügen, rufen Sie `builder.Services.AddHealthChecks()` auf, um den Dienst zu registrieren, verketten optional `.AddCheck(...)`-Aufrufe, um zu beschreiben, was "healthy" für Ihre Anwendung bedeutet, und rufen dann `app.MapHealthChecks("/healthz")` auf, um einen Endpunkt bereitzustellen. Rufen Sie diese URL auf und Sie erhalten `200 OK` mit dem Body `Healthy`, wenn alle Prüfungen bestehen, oder `503 Service Unavailable`, wenn eine Prüfung `Unhealthy` meldet. Dieses zweizeilige Setup ist das vollständige Minimum. Dieser Beitrag führt es von diesem Minimum zu einem produktionsreifen Setup: ein eigener `IHealthCheck`, der tatsächlich eine Abhängigkeit prüft, die integrierte Datenbanksonde von EF Core, getrennte Liveness- und Readiness-Endpunkte, die für Kubernetes verdrahtet sind, ein JSON-Antwort-Body, korrekte HTTP-Statuscodes und das Absichern des Endpunkts. Er zielt auf .NET 11 (zum Zeitpunkt des Schreibens Preview 6, GA im November 2026) mit `Microsoft.NET.Sdk.Web` und C# 14, aber die Health-Checks-API ist seit ASP.NET Core 2.2 stabil, sodass jedes Beispiel hier unverändert unter .NET 8, 9 und 10 läuft.

## Wozu ein Health-Check-Endpunkt tatsächlich dient

Ein Health-Check-Endpunkt ist eine URL, die ein Orchestrator, ein Load Balancer oder ein Verfügbarkeitsmonitor abfragen kann, um zu fragen: "Soll ich Traffic an diese Instanz senden?" Die Antwort ist bewusst grob: ein aggregierter Status, der aus einer Menge registrierter Prüfungen berechnet wird und als HTTP-Statuscode bereitgestellt wird, sodass alles, was HTTP spricht, ihn ohne Parsen eines Body konsumieren kann. Kubernetes nutzt ihn, um zu entscheiden, ob ein Pod neu gestartet oder Anfragen dorthin geroutet werden. Ein Azure App Service oder eine AWS-Target-Group nutzt ihn, um eine nicht gesunde Instanz aus der Rotation zu nehmen. Ein Werkzeug wie Uptime Kuma nutzt ihn, um Sie zu benachrichtigen.

Der zentrale Designpunkt ist, dass ein Health Check kein Metrik-Endpunkt und kein Diagnose-Dashboard ist. Er beantwortet eine Frage schnell, idealerweise in wenigen Millisekunden, und seine Prüfungen sollten nur die Dinge testen, die tatsächlich bestimmen, ob dieser Prozess Anfragen bedienen kann: Ist die Datenbank erreichbar, antwortet eine kritische nachgelagerte API, hat die Anwendung ihre Startarbeit abgeschlossen. Langsame oder nicht essenzielle Sonden hineinzustapeln macht ein Liveness-Signal zur Belastung, denn ein langsamer Health Check unter Last verursacht die kaskadierenden Neustarts, die er verhindern sollte.

## Schritte zum Hinzufügen eines Health-Check-Endpunkts

1. Registrieren Sie den Dienst mit `builder.Services.AddHealthChecks()`, was einen `IHealthChecksBuilder` zurückgibt.
2. Verketten Sie `.AddCheck(...)`- oder `.AddCheck<T>(...)`-Aufrufe an diesen Builder für jede Abhängigkeit, die Sie prüfen möchten.
3. Bauen Sie die Anwendung und rufen Sie `app.MapHealthChecks("/healthz")` auf, um den Endpunkt zu mappen.
4. Übergeben Sie optional ein `HealthCheckOptions`, um Prüfungen nach Tag zu filtern, die Antwort zu formen oder Statuscodes umzumappen.
5. Verketten Sie optional `.RequireAuthorization()` oder `.RequireHost(...)`, um zu steuern, wer ihn erreichen kann.

Der Rest dieses Artikels erweitert jeden dieser Schritte zu funktionierendem Code.

## Der zweizeilige Ausgangspunkt

Hier ist das Kleinste, das funktioniert. `AddHealthChecks` ohne registrierte Prüfungen ist immer noch nützlich: Es gibt Ihnen einen Liveness-Endpunkt, der `Healthy` zurückgibt, solange der Prozess läuft und die Anfrage-Pipeline sich dreht.

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHealthChecks();

var app = builder.Build();

app.MapHealthChecks("/healthz");

app.Run();
```

Ein `GET /healthz` gibt jetzt `200 OK` mit dem Klartext-Body `Healthy` zurück. Es sind keine Prüfungen registriert, also gibt es nichts, was fehlschlagen kann. Dies allein beantwortet "Ist der Prozess am Leben und bedient HTTP", was genau das ist, was eine Kubernetes-Liveness-Sonde will. Alles ab diesem Punkt handelt davon, Prüfungen zu registrieren, die etwas anderes als gesund melden können, und davon, zu formen, wie der Endpunkt kommuniziert.

## Eine eigene Prüfung mit IHealthCheck schreiben

Eine echte Prüfung prüft eine Abhängigkeit und meldet einen von drei Zuständen. Implementieren Sie `IHealthCheck`, dessen einzige Methode ein `HealthCheckResult` zurückgibt:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class QueueDepthHealthCheck : IHealthCheck
{
    private readonly IMessageQueue _queue;

    public QueueDepthHealthCheck(IMessageQueue queue) => _queue = queue;

    public async Task<HealthCheckResult> CheckHealthAsync(
        HealthCheckContext context,
        CancellationToken cancellationToken = default)
    {
        try
        {
            var depth = await _queue.GetApproximateDepthAsync(cancellationToken);

            if (depth > 10_000)
            {
                return HealthCheckResult.Unhealthy(
                    $"Queue backlog is {depth} messages.");
            }

            if (depth > 1_000)
            {
                // Still serving, but the backlog is a warning sign.
                return HealthCheckResult.Degraded(
                    $"Queue backlog is {depth} messages.",
                    data: new Dictionary<string, object> { ["depth"] = depth });
            }

            return HealthCheckResult.Healthy($"Queue depth {depth}.");
        }
        catch (Exception ex)
        {
            // Could not even reach the queue: that is unhealthy, not an unhandled 500.
            return HealthCheckResult.Unhealthy("Queue is unreachable.", ex);
        }
    }
}
```

Die drei Factory-Methoden entsprechen den drei Mitgliedern des `HealthStatus`-Enums. `Healthy` bedeutet voll betriebsbereit. `Unhealthy` bedeutet, dass diese Instanz ihre Aufgabe nicht erfüllen kann und aus der Rotation genommen oder neu gestartet werden sollte. `Degraded` ist die interessante Mitte: Die Anwendung bedient noch Anfragen, aber etwas stimmt nicht (eine langsame Abhängigkeit, ein wachsender Backlog), und standardmäßig gibt ein degradiertes Ergebnis weiterhin `200 OK` zurück. Das ist beabsichtigt: In der Regel wollen Sie nicht, dass ein Orchestrator einen Pod neu startet, nur weil sich eine Queue füllt. Das optionale `data`-Dictionary fährt im Report mit und erscheint in einem JSON-Antwort-Body, was für ein Dashboard nützlich ist, ohne die Bestanden/Nicht-bestanden-Entscheidung zu ändern.

Registrieren Sie die Klasse und geben Sie ihr einen Namen und optional einen Fehlerstatus und Tags:

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck<QueueDepthHealthCheck>(
        "queue",
        failureStatus: HealthStatus.Unhealthy,
        tags: ["ready"]);
```

Die Konstruktor-Abhängigkeit (`IMessageQueue`) wird aus der Dependency Injection aufgelöst, sodass Ihre Prüfung jeden registrierten Dienst injizieren kann. Wenn Sie literale Konstruktor-Argumente übergeben müssen, die nicht im Container sind, verwenden Sie stattdessen `AddTypeActivatedCheck<T>(...)` und liefern ein `args`-Array.

Für eine wegwerfbare Inline-Prüfung, die keine Klasse verdient, genügt die Lambda-Form:

```csharp
// .NET 11, C# 14
builder.Services.AddHealthChecks()
    .AddCheck("self", () => HealthCheckResult.Healthy(), tags: ["live"]);
```

## Die Datenbank mit AddDbContextCheck prüfen

Das mit Abstand häufigste, was Teams in einer Readiness-Sonde wollen, ist "kann ich die Datenbank erreichen". Dafür müssen Sie keinen `IHealthCheck` schreiben. Fügen Sie das Paket `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore` hinzu und verwenden Sie das integrierte `AddDbContextCheck<TContext>`:

```csharp
// .NET 11, C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("DefaultConnection")));

builder.Services.AddHealthChecks()
    .AddDbContextCheck<AppDbContext>("database", tags: ["ready"]);
```

Unter der Haube ruft dies `DbContext.Database.CanConnectAsync` auf, was eine Verbindung öffnet und wieder schließt, ohne eine Abfrage auszuführen. Das ist der richtige Standard: Es ist günstig und verifiziert genau das, worum sich eine Readiness-Sonde kümmert, dass die Connection-Zeichenfolge auflöst und der Server Verbindungen akzeptiert. Wenn Sie etwas Stärkeres brauchen, hat `AddDbContextCheck` eine Überladung, die eine eigene Testabfrage entgegennimmt, aber für den häufigen Fall ist `CanConnectAsync` das, was Sie wollen. Für tiefere Verdrahtung zum Vorbereiten von EF Core vor der ersten Nutzung siehe [wie Sie das Modell von EF Core vor der ersten Abfrage aufwärmen](/de/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/); eine Prüfung, die `CanConnectAsync` ausführt, ist ein natürlicher Ort, an dem dieses Aufwärmen bereits geschehen sein sollte.

Community-Pakete unter `AspNetCore.Diagnostics.HealthChecks` (das Xabaril-Projekt) liefern fertige Prüfungen für Redis, RabbitMQ, PostgreSQL, Blob Storage und Dutzende weitere Abhängigkeiten mit demselben `.Add...`-Muster, sodass Sie selten eine Sonde für einen bekannten Dienst von Hand schreiben müssen.

## Getrennte Liveness- und Readiness-Endpunkte

Kubernetes unterscheidet zwei Sonden, und sie zu vermischen ist der häufigste Health-Check-Fehler. Eine Liveness-Sonde beantwortet "hängt dieser Prozess fest und braucht einen Neustart"; wenn sie fehlschlägt, tötet Kubernetes den Pod. Eine Readiness-Sonde beantwortet "ist diese Instanz jetzt bereit, Traffic zu empfangen"; wenn sie fehlschlägt, hört Kubernetes auf, dorthin zu routen, lässt sie aber laufen. Sie wollen nicht, dass eine kurzzeitig nicht erreichbare Datenbank einen Pod-Neustart auslöst, denn ein Neustart kann die Datenbank nicht reparieren und entfernt nur Kapazität. Also gehört die Datenbankprüfung zu Readiness, nicht zu Liveness.

Der Mechanismus sind Tags plus das `Predicate` in `HealthCheckOptions`. Registrieren Sie die Prüfungen mit Tags, dann mappen Sie zwei Endpunkte, die jeweils auf die richtige Menge filtern:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

app.MapHealthChecks("/health/live", new HealthCheckOptions
{
    // Liveness: run no dependency checks. If the pipeline responds, we are alive.
    Predicate = _ => false
});

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    // Readiness: only the checks tagged "ready" (database, queue, downstreams).
    Predicate = check => check.Tags.Contains("ready")
});
```

`Predicate = _ => false` bedeutet "keine Prüfungen einbeziehen", sodass `/health/live` in dem Moment, in dem die Anfrage den Endpunkt erreicht, auf `Healthy` kurzschließt. `/health/ready` führt nur die Prüfungen aus, die Sie mit `ready` getaggt haben. Richten Sie Ihre Kubernetes-`livenessProbe` auf `/health/live` und Ihre `readinessProbe` auf `/health/ready`, und die beiden Belange bleiben sauber getrennt.

## JSON statt Klartext zurückgeben

Der Standard-Antwort-Body ist das einzelne Wort `Healthy`, `Degraded` oder `Unhealthy`. Das genügt für eine Sonde, ist aber für einen Menschen, der debuggt, warum Readiness fehlschlägt, nutzlos. Liefern Sie einen `ResponseWriter`, um JSON mit Detail pro Prüfung auszugeben:

```csharp
// .NET 11, C# 14
using System.Text.Json;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.Extensions.Diagnostics.HealthChecks;

static Task WriteJsonResponse(HttpContext context, HealthReport report)
{
    context.Response.ContentType = "application/json; charset=utf-8";

    var payload = new
    {
        status = report.Status.ToString(),
        totalDurationMs = report.TotalDuration.TotalMilliseconds,
        checks = report.Entries.Select(e => new
        {
            name = e.Key,
            status = e.Value.Status.ToString(),
            description = e.Value.Description,
            durationMs = e.Value.Duration.TotalMilliseconds
        })
    };

    return context.Response.WriteAsync(JsonSerializer.Serialize(payload));
}

app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResponseWriter = WriteJsonResponse
});
```

Jetzt gibt eine fehlgeschlagene Readiness-Prüfung einen Body zurück, der die Prüfung, ihren Status, ihre Beschreibung und wie lange sie gedauert hat benennt, sodass Sie auf einen Blick sehen, dass "database" der Eintrag ist, der `Unhealthy` wurde. Das `HealthReport`-Objekt stellt `Status` (das Aggregat), `TotalDuration` und ein `Entries`-Dictionary bereit, das nach den von Ihnen registrierten Prüfungsnamen indexiert ist. Beachten Sie, dass der Statuscode getrennt vom Body gesteuert wird: Ein `503` kann dieses JSON problemlos tragen.

## Den Statuscode steuern

Standardmäßig mappt das Framework `Healthy` und `Degraded` auf `200 OK` und `Unhealthy` auf `503 Service Unavailable`. Dieses Mapping ist das, was Load Balancer erwarten, ändern Sie es also nur, wenn Sie einen bestimmten Grund haben. Wenn Sie es tun, ist `ResultStatusCodes` der Regler:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready"),
    ResultStatusCodes =
    {
        [HealthStatus.Healthy] = StatusCodes.Status200OK,
        [HealthStatus.Degraded] = StatusCodes.Status200OK,
        [HealthStatus.Unhealthy] = StatusCodes.Status503ServiceUnavailable
    }
});
```

Eine Feinheit, die es sich zu verinnerlichen lohnt: Da `Degraded` standardmäßig `200` zurückgibt, behandelt ein Load Balancer eine degradierte Instanz als gesund und sendet ihr weiterhin Traffic. Das ist meist richtig, aber wenn Ihre Definition von "degradiert" schwerwiegend genug ist, dass Sie sie aus der Rotation nehmen wollen, mappen Sie entweder `Degraded` hier auf `503` oder geben `Unhealthy` aus der Prüfung statt `Degraded` zurück. Lassen Sie die Absicht nicht mehrdeutig.

Ein weiterer Standard, den man kennen sollte: Health-Check-Antworten setzen No-Cache-Header, damit ein Zwischen-Proxy kein veraltetes `Healthy` ausliefern kann, während die Instanz tatsächlich fehlschlägt. Falls Sie jemals Caching brauchen, schaltet `AllowCachingResponses = true` in den Optionen es ab, aber bei einer Sonde wollen Sie das fast nie.

## Den Endpunkt absichern

Ein Gesundheitsendpunkt, der detailliertes JSON zurückgibt, ist eine kleine Angriffsfläche für Informationspreisgabe: Er benennt Ihre Abhängigkeiten und kann Fehlerdetails verraten. Es gibt zwei saubere Wege, ihn einzuschränken. `RequireHost` beschränkt den Endpunkt auf einen bestimmten Host oder Port, was der Standardtrick ist, um Gesundheit nur auf einem internen Management-Port bereitzustellen, der nicht öffentlich geroutet wird:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready", new HealthCheckOptions
{
    Predicate = check => check.Tags.Contains("ready")
})
.RequireHost("*:8081");
```

`RequireAuthorization` stellt den Endpunkt hinter Ihre Autorisierungsrichtlinien, die sich mit jeder von Ihnen konfigurierten Authentifizierung kombinieren. Wenn Sie bereits JWT-Bearer-Authentifizierung ausführen, ist das Aufsetzen auf den Gesundheitsendpunkt ein einziger Aufruf:

```csharp
// .NET 11, C# 14
app.MapHealthChecks("/health/ready")
    .RequireAuthorization();
```

Ein Wort der Vorsicht: Verlangen Sie keine Autorisierung auf dem Endpunkt, den Ihr Orchestrator abfragt, denn der Orchestrator wird kein Token vorlegen und die Sonde wird fehlschlagen. Halten Sie die einfachen Liveness/Readiness-Endpunkte offen (schränken Sie sie stattdessen per Host oder Netzwerk ein) und stellen Sie den detaillierten, JSON-ausgebenden Endpunkt hinter Autorisierung, falls Sie ihn überhaupt bereitstellen. Die Mechanik zum Aufsetzen der Token-Seite wird in [wie Sie JWT-Bearer-Authentifizierung in einer Minimal API in ASP.NET Core 11 einrichten](/de/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/) behandelt.

## Ergebnisse pushen, statt auf Abfrage zu warten

Alles oben ist pull-basiert: Etwas ruft Ihren Endpunkt auf. Das Framework unterstützt auch push-basiertes Reporting über `IHealthCheckPublisher`, das die registrierten Prüfungen auf einem Timer ausführt und den aggregierten `HealthReport` an Ihren Code übergibt, damit Sie ihn an ein Monitoring-System weiterleiten, eine Metrik ausgeben oder einen Alarm protokollieren können:

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.Diagnostics.HealthChecks;

public sealed class LoggingHealthCheckPublisher : IHealthCheckPublisher
{
    private readonly ILogger<LoggingHealthCheckPublisher> _logger;

    public LoggingHealthCheckPublisher(ILogger<LoggingHealthCheckPublisher> logger)
        => _logger = logger;

    public Task PublishAsync(HealthReport report, CancellationToken cancellationToken)
    {
        if (report.Status != HealthStatus.Healthy)
        {
            _logger.LogWarning(
                "Health degraded: {Status} across {Count} checks.",
                report.Status, report.Entries.Count);
        }
        return Task.CompletedTask;
    }
}

builder.Services.AddSingleton<IHealthCheckPublisher, LoggingHealthCheckPublisher>();
builder.Services.Configure<HealthCheckPublisherOptions>(options =>
{
    options.Delay = TimeSpan.FromSeconds(5);   // Wait before the first run.
    options.Period = TimeSpan.FromSeconds(30); // Then run every 30 seconds.
    options.Predicate = check => check.Tags.Contains("ready");
});
```

Der Publisher läuft auf einem gehosteten Hintergrunddienst, den das Framework registriert, sobald irgendein `IHealthCheckPublisher` im Container ist, sodass Sie periodische Ausführung erhalten, ohne Ihren eigenen Timer zu verdrahten. Dies ist der idiomatische Ort, um Gesundheit in eine Metrik-Pipeline einzuspeisen; wenn Sie bereits Telemetrie exportieren, kombinieren Sie es mit [OpenTelemetry in .NET 11](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/), damit der degradierte Status neben Ihren Traces erscheint. Es verträgt sich auch gut mit jeglicher [Überwachung von Hintergrundaufgaben](/de/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/), die Sie bereits ausführen, da ein Publisher einfach ein weiterer Konsument desselben Reports ist.

## MapHealthChecks versus UseHealthChecks, und wo die Prüfungen laufen

Ältere Tutorials verwenden `app.UseHealthChecks("/healthz")`, was Middleware ist, die die Pipeline kurzschließt, wenn der Pfad passt. `MapHealthChecks` ist das routing-bewusste Äquivalent und das, was man in jeder modernen Minimal API bevorzugen sollte, weil es am Endpunkt-Routing teilnimmt, was `RequireAuthorization`, `RequireHost` und `RequireCors` überhaupt erst funktionieren lässt. Diese Endpunkt-Konventionen haben in der Middleware-Form keine Bedeutung. Unter .NET 8 und höher können Sie außerdem `.ShortCircuit()` an einen gemappten Gesundheitsendpunkt anhängen, um den Rest der Middleware-Pipeline für diese Anfrage zu überspringen und bei einer hochfrequenten Sonde ein wenig Overhead zu sparen.

Eine betriebliche Erinnerung: Die Prüfungen werden innerhalb der Anfrage ausgeführt, die den Endpunkt getroffen hat, und verwenden für diese Anfrage aufgelöste scoped Dienste. Wenn eine Prüfung eine scoped Abhängigkeit wie einen `DbContext` benötigt, funktioniert diese Auflösung einfach, weil der Endpunkt in einem Request-Scope läuft. Dies ist derselbe Scoping-Belang, der jene beißt, die scoped Dienste aus langlebigen Singletons beziehen, genau die Falle, die [scoped Dienste innerhalb eines BackgroundService verwenden](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) zu lösen versucht; ein Health Check trifft sie nie, weil er bereits einen Request-Scope hat.

## Die Form, die man sich merken sollte

Ein Health-Check-Endpunkt ist `AddHealthChecks()` zum Registrieren des Dienstes, `.AddCheck<T>(...)` (oder `.AddDbContextCheck<T>()`, oder ein Lambda) für jede prüfenswerte Abhängigkeit, und `MapHealthChecks("/path")` zur Bereitstellung. Geben Sie `Healthy`, `Degraded` oder `Unhealthy` aus jeder Prüfung zurück, und denken Sie daran, dass `Unhealthy` ein `503` ist, während die beiden anderen standardmäßig `200` sind. Trennen Sie Liveness von Readiness mit Tags und einem `Predicate`, damit eine wackelige Datenbank nie einen gesunden Pod neu startet, fügen Sie einen `ResponseWriter` hinzu, wenn ein Mensch das Ergebnis lesen muss, sichern Sie den Endpunkt mit `RequireHost` statt Autorisierung auf dem Sondenpfad, und greifen Sie zu `IHealthCheckPublisher`, wenn Sie Push statt Pull wollen. Das ist die vollständige Oberfläche, und jede Zeile oben läuft unter .NET 8 bis .NET 11 unverändert.

## Verwandt

- [So verwenden Sie scoped Dienste innerhalb eines BackgroundService in ASP.NET Core 11](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)
- [So organisieren Sie Minimal-API-Endpunkte mit MapGroup in ASP.NET Core 11](/de/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [So richten Sie JWT-Bearer-Authentifizierung in einer Minimal API in ASP.NET Core 11 ein](/de/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)
- [So verwenden Sie OpenTelemetry mit .NET 11 und einem kostenlosen Backend](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [So wärmen Sie das Modell von EF Core vor der ersten Abfrage auf](/de/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)

## Quellen

- [Health checks in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/host-and-deploy/health-checks)
- [IHealthCheck interface (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.diagnostics.healthchecks.ihealthcheck)
- [HealthCheckOptions (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.diagnostics.healthchecks.healthcheckoptions)
- [AddDbContextCheck extension (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkcorehealthchecksbuilderextensions.adddbcontextcheck)
- [AspNetCore.Diagnostics.HealthChecks (Xabaril, GitHub)](https://github.com/Xabaril/AspNetCore.Diagnostics.HealthChecks)
