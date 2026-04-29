---
title: "Monitorar jobs em segundo plano no .NET 9 e .NET 10 sem Hangfire: saúde + métricas + alertas"
description: "Monitore jobs BackgroundService no .NET 9 e .NET 10 sem Hangfire usando health checks de heartbeat, métricas de duração e alertas de falha, com um exemplo de código prático."
pubDate: 2026-01-10
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "pt-br"
translationOf: "2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts"
translatedBy: "claude"
translationDate: 2026-04-30
---
Essa pergunta apareceu hoje no r/dotnet: "Como vocês monitoram e alertam sobre jobs em segundo plano no .NET (sem Hangfire)?". O erro principal é achar que "o serviço está no ar" significa "o job está rodando". Para trabalho em segundo plano, você precisa de um sinal de vida atrelado ao progresso do job.

Discussão de origem: [https://www.reddit.com/r/dotnet/comments/1q86tv7/how\_do\_you\_monitor\_alert\_on\_background\_jobs\_in/](https://www.reddit.com/r/dotnet/comments/1q86tv7/how_do_you_monitor_alert_on_background_jobs_in/)

## Os três sinais que importam

-   **Liveness**: o loop do job continua se movendo (heartbeats).
-   **Correção**: as falhas são rastreadas, não engolidas.
-   **Latência**: o trabalho está terminando dentro do seu SLO.

Se você só tem logs, vai ficar cego em incidentes do tipo "está lento, mas não morto". Adicione um health check e pelo menos uma métrica.

## Um padrão simples: heartbeat + último erro + métrica de duração

Isto funciona no .NET 9 / .NET 10 com um `BackgroundService` simples:

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

Conecte tudo:

-   Registre um singleton `JobState`.
-   Adicione o serviço hospedado.
-   Adicione `HealthChecks` e exponha `/health`.
-   Exporte métricas via OpenTelemetry se você tiver, ou no mínimo varra os logs para contar falhas.

## Sobre o que alertar (a parte que as pessoas pulam)

-   **Health Unhealthy** por mais de X minutos.
-   **p95 do histograma de duração** ultrapassa o seu SLO.
-   **Taxa de erros** ultrapassa um limiar (contagem de exceções por intervalo).

Se você fizer apenas uma coisa, faça o health check de heartbeat. Ele transforma "o processo está vivo?" em "o job está vivo?", que é a pergunta de verdade.

Leitura adicional: [https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks](https://learn.microsoft.com/aspnet/core/host-and-deploy/health-checks)
