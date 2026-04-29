---
title: "Hintergrundjobs in .NET 9 und .NET 10 ohne Hangfire überwachen: Health + Metriken + Alerts"
description: "Überwachen Sie BackgroundService-Jobs in .NET 9 und .NET 10 ohne Hangfire mit Heartbeat-Health-Checks, Dauer-Metriken und Fehler-Alerts -- mit einem praktischen Codebeispiel."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "de"
translationOf: "2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts"
translatedBy: "claude"
translationDate: 2026-04-30
---
Diese Frage tauchte heute in r/dotnet auf: "Wie überwachen und alarmieren Sie Hintergrundjobs in .NET (ohne Hangfire)?" Der Hauptfehler ist, anzunehmen, dass "der Dienst läuft" gleichbedeutend ist mit "der Job läuft". Für Hintergrundarbeit brauchen Sie ein Lebenszeichen, das an den Fortschritt des Jobs gekoppelt ist.

Quelle der Diskussion: [https://www.reddit.com/r/dotnet/comments/1q86tv7/how\_do\_you\_monitor\_alert\_on\_background\_jobs\_in/](https://www.reddit.com/r/dotnet/comments/1q86tv7/how_do_you_monitor_alert_on_background_jobs_in/)

## Die drei Signale, die zählen

-   **Liveness**: Die Job-Schleife bewegt sich noch (Heartbeats).
-   **Korrektheit**: Fehler werden erfasst, nicht verschluckt.
-   **Latenz**: Die Arbeit endet innerhalb Ihres SLO.

Wenn Sie nur Logs haben, sind Sie blind in "es ist langsam, aber nicht tot"-Vorfällen. Ergänzen Sie einen Health-Check und mindestens eine Metrik.

## Ein einfaches Muster: Heartbeat + letzter Fehler + Dauer-Metrik

Das funktioniert in .NET 9 / .NET 10 mit einem schlichten `BackgroundService`:

```cs
using System.Diagnostics;
using System.Diagnostics.Metrics;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Diagnostics.HealthChecks;
using Microsoft.Extensions.Logging;

public sealed class JobState
{
    public DateTimeOffset LastSuccessUtc { get; private set; } = DateTimeOffset.MinValue;
    public Exception? LastError { get; private set; }

    public void MarkSuccess() { LastSuccessUtc = DateTimeOffset.UtcNow; LastError = null; }
    public void MarkFailure(Exception ex) { LastError = ex; }
}

public sealed class MyJob : BackgroundService
{
    private static readonly Meter Meter = new("MyApp.Jobs", "1.0");
    private static readonly Histogram<double> DurationMs = Meter.CreateHistogram<double>("myjob.duration_ms");
    private readonly JobState _state;
    private readonly ILogger<MyJob> _logger;

    public MyJob(JobState state, ILogger<MyJob> logger) { _state = state; _logger = logger; }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var start = Stopwatch.GetTimestamp();
            try
            {
                await DoWorkOnce(stoppingToken);
                _state.MarkSuccess();
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                _state.MarkFailure(ex);
                _logger.LogError(ex, "Background job failed.");
            }
            finally
            {
                var elapsedMs = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
                DurationMs.Record(elapsedMs);
            }

            await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);
        }
    }

    private static Task DoWorkOnce(CancellationToken ct) => Task.CompletedTask;
}

public sealed class JobHealthCheck(JobState state) : IHealthCheck
{
    private readonly JobState _state = state;

    public Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken)
    {
        var age = DateTimeOffset.UtcNow - _state.LastSuccessUtc;
        if (age <= TimeSpan.FromMinutes(2))
            return Task.FromResult(HealthCheckResult.Healthy("Job heartbeat OK."));

        var msg = _state.LastError is null
            ? $"No successful run in {age.TotalSeconds:n0}s."
            : $"Last error: {_state.LastError.GetType().Name}. No success in {age.TotalSeconds:n0}s.";

        return Task.FromResult(HealthCheckResult.Unhealthy(msg));
    }
}
```

Verdrahten Sie es:

-   Registrieren Sie einen Singleton `JobState`.
-   Fügen Sie den Hosted Service hinzu.
-   Fügen Sie `HealthChecks` hinzu und stellen Sie `/health` bereit.
-   Exportieren Sie Metriken über OpenTelemetry, falls vorhanden, oder zählen Sie Fehler zumindest aus den Logs.

## Worauf zu alarmieren ist (der Teil, den die meisten überspringen)

-   **Health ist Unhealthy** länger als X Minuten.
-   **p95 des Dauer-Histogramms** überschreitet Ihr SLO.
-   **Fehlerrate** überschreitet einen Schwellenwert (Ausnahmen pro Intervall zählen).

Wenn Sie nur eine Sache machen, machen Sie den Heartbeat-Health-Check. Er verwandelt "läuft der Prozess?" in "läuft der Job?" -- die eigentliche Frage.

Weiterführend: [https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks](https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks)
