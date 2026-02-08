---
title: "Monitor Background Jobs in .NET 9 and .NET 10 Without Hangfire: Health + Metrics + Alerts"
description: "Monitor BackgroundService jobs in .NET 9 and .NET 10 without Hangfire using heartbeat health checks, duration metrics, and failure alerts with a practical code example."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
---
This question came up today in r/dotnet: “How do you monitor and alert on background jobs in .NET (without Hangfire)?” The main mistake is thinking “the service is up” means “the job is running”. For background work you need a liveness signal that is tied to job progress.

Source discussion: [https://www.reddit.com/r/dotnet/comments/1q86tv7/how\_do\_you\_monitor\_alert\_on\_background\_jobs\_in/](https://www.reddit.com/r/dotnet/comments/1q86tv7/how_do_you_monitor_alert_on_background_jobs_in/)

## The three signals that matter

-   **Liveness**: the job loop is still moving (heartbeats).
-   **Correctness**: failures are tracked, not swallowed.
-   **Latency**: the work is finishing within your SLO.

If you only have logs, you will be blind during “it is slow but not dead” incidents. Add a health check and at least one metric.

## A simple pattern: heartbeat + last error + duration metric

This works in .NET 9 / .NET 10 with a plain `BackgroundService`:

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

Wire it up:

-   Register a singleton `JobState`.
-   Add the hosted service.
-   Add `HealthChecks` and expose `/health`.
-   Export metrics via OpenTelemetry if you have it, or at least scrape logs for failure counts.

## What to alert on (the part people skip)

-   **Health is Unhealthy** for more than X minutes.
-   **Duration histogram p95** crosses your SLO.
-   **Error rate** exceeds a threshold (count exceptions per interval).

If you do only one thing, do the heartbeat check. It turns “is the process alive?” into “is the job alive?”, which is the actual question.

Further reading: [https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks](https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks)
