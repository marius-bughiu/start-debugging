---
title: "Мониторинг фоновых задач в .NET 9 и .NET 10 без Hangfire: здоровье + метрики + оповещения"
description: "Мониторинг задач BackgroundService в .NET 9 и .NET 10 без Hangfire с помощью heartbeat-проверок здоровья, метрик длительности и оповещений о сбоях, с практическим примером кода."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "ru"
translationOf: "2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts"
translatedBy: "claude"
translationDate: 2026-04-30
---
Сегодня в r/dotnet всплыл вопрос: "Как вы мониторите и оповещаете о фоновых задачах в .NET (без Hangfire)?". Главная ошибка — считать, что "сервис поднят" равно "задача работает". Для фоновой работы нужен сигнал жизни, привязанный к её прогрессу.

Источник обсуждения: [https://www.reddit.com/r/dotnet/comments/1q86tv7/how\_do\_you\_monitor\_alert\_on\_background\_jobs\_in/](https://www.reddit.com/r/dotnet/comments/1q86tv7/how_do_you_monitor_alert_on_background_jobs_in/)

## Три важных сигнала

-   **Liveness**: цикл задачи всё ещё движется (heartbeats).
-   **Корректность**: сбои отслеживаются, а не проглатываются.
-   **Задержка**: работа укладывается в ваш SLO.

Если у вас только журналы, вы будете слепы во время инцидентов "медленно, но не мертво". Добавьте проверку здоровья и хотя бы одну метрику.

## Простой шаблон: heartbeat + последняя ошибка + метрика длительности

Это работает в .NET 9 / .NET 10 с обычным `BackgroundService`:

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

Подключите всё:

-   Зарегистрируйте singleton `JobState`.
-   Добавьте hosted-сервис.
-   Добавьте `HealthChecks` и выставьте `/health`.
-   Экспортируйте метрики через OpenTelemetry, если он у вас есть, или хотя бы парсите журналы для подсчёта сбоев.

## На что оповещать (часть, которую обычно пропускают)

-   **Health в состоянии Unhealthy** дольше X минут.
-   **p95 гистограммы длительности** пересекает ваш SLO.
-   **Уровень ошибок** превышает порог (счёт исключений за интервал).

Если делать только что-то одно — делайте heartbeat-проверку здоровья. Она превращает "жив ли процесс?" в "жива ли задача?", и это и есть настоящий вопрос.

Дополнительно: [https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks](https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks)
