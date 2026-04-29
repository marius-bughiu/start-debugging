---
title: "Monitorea trabajos en segundo plano en .NET 9 y .NET 10 sin Hangfire: salud + métricas + alertas"
description: "Monitorea trabajos BackgroundService en .NET 9 y .NET 10 sin Hangfire usando health checks de heartbeat, métricas de duración y alertas de fallo, con un ejemplo de código práctico."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "es"
translationOf: "2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts"
translatedBy: "claude"
translationDate: 2026-04-30
---
Esta pregunta apareció hoy en r/dotnet: "¿Cómo monitoreas y alertas sobre trabajos en segundo plano en .NET (sin Hangfire)?" El error principal es pensar que "el servicio está arriba" significa "el trabajo está corriendo". Para el trabajo en segundo plano necesitas una señal de vida atada al progreso del trabajo.

Discusión origen: [https://www.reddit.com/r/dotnet/comments/1q86tv7/how\_do\_you\_monitor\_alert\_on\_background\_jobs\_in/](https://www.reddit.com/r/dotnet/comments/1q86tv7/how_do_you_monitor_alert_on_background_jobs_in/)

## Las tres señales que importan

-   **Liveness**: el bucle del trabajo sigue moviéndose (heartbeats).
-   **Corrección**: los fallos se rastrean, no se tragan.
-   **Latencia**: el trabajo termina dentro de tu SLO.

Si solo tienes registros, estarás a ciegas durante incidentes de "es lento pero no está muerto". Añade un health check y al menos una métrica.

## Un patrón simple: heartbeat + último error + métrica de duración

Esto funciona en .NET 9 / .NET 10 con un `BackgroundService` plano:

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

Conéctalo todo:

-   Registra un singleton `JobState`.
-   Añade el servicio hospedado.
-   Añade `HealthChecks` y expón `/health`.
-   Exporta métricas con OpenTelemetry si lo tienes, o como mínimo escanea los registros para contar fallos.

## Sobre qué alertar (la parte que la gente se salta)

-   **Health en Unhealthy** durante más de X minutos.
-   **El p95 del histograma de duración** cruza tu SLO.
-   **Tasa de errores** supera un umbral (cuenta excepciones por intervalo).

Si haces solo una cosa, haz el health check de heartbeat. Convierte "¿está vivo el proceso?" en "¿está vivo el trabajo?", que es la pregunta real.

Lectura adicional: [https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks](https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks)
