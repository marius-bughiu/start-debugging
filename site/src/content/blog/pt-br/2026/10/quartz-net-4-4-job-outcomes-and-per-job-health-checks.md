---
title: "Quartz.NET 4.4: jobs informam o que alcançaram, e um health check percebe quando eles param"
description: "O Quartz.NET 4.4.0 permite que um job defina context.Result como um JobRunReport (Succeeded, Failed, Cancelled ou Skipped, com resumo e métricas), mantém isso por job no histórico de execução e adiciona health checks RequireSuccessWithin que ficam degraded quando um job noturno deixa de ter sucesso."
pubDate: 2026-10-11
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "health-checks"
  - "background-jobs"
lang: "pt-br"
translationOf: "2026/10/quartz-net-4-4-job-outcomes-and-per-job-health-checks"
translatedBy: "claude"
translationDate: 2026-10-11
---

O Quartz.NET [v4.4.0](https://github.com/quartznet/quartznet/releases/tag/v4.4.0) foi lançado em 2026-10-07. Os números de destaque são sobre clustering (triggers que já estão vencidos disparam na transação que os adquire, e no PostgreSQL 95 a 99 % dos disparos a 20 triggers por segundo ocorrem em até 50 ms, contra 54 % no 4.3.0), mas a mudança que a maior parte do código de aplicação vai usar é menor: um job finalmente pode dizer o que a sua execução alcançou, e o seu endpoint de health pode agir com base nisso.

## "Não lançou exceção" não é "funcionou"

Até o 4.3, o Quartz conhecia dois resultados: o job lançou exceção, ou não lançou. Um job de limpeza que não encontrou nada para limpar, uma sincronização que desistiu porque a API de origem devolveu uma página vazia e uma execução que fez trabalho real pareciam idênticos no histórico. E um job noturno cujo trigger foi pausado ou sofreu misfire por três dias não parecia nada, porque nada falhou.

## Informando um resultado com JobRunReport

No 4.4, um job define `context.Result` como um `JobRunReport`. Há quatro resultados (`Succeeded`, `Failed`, `Cancelled`, `Skipped`), um resumo opcional de até 1.000 caracteres e métricas armazenadas como JSON seguro para AOT, limitado a 4.000 caracteres:

```csharp
public sealed class ReleaseStaleReservationsJob : IJob
{
    public async ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
    {
        int scanned = await CountReservations(cancellationToken);
        int released = await ReleaseStale(cancellationToken);

        context.Result = released == 0
            ? JobRunReport.Skipped("no stale reservations").With("scanned", scanned)
            : JobRunReport.Succeeded($"released {released}")
                .With("scanned", scanned)
                .With("released", released);
    }
}
```

O resultado registrado segue uma ordem fixa: um disparo cancelado é `Cancelled`, um job que lançou exceção é `Failed`, caso contrário vale o que você colocou em `context.Result`, e na ausência disso, `Succeeded`. Informar `JobRunReport.Failed(...)` não é o mesmo que lançar uma exceção. Somente uma exceção lançada aciona a política de retry e as continuações `OnFailure`, então informe uma falha quando tentar de novo não ajudaria.

O histórico mantém um `JobRunStatus` por job (`LastSucceededAtUtc`, `ConsecutiveFailures`, `LastFailureMessage`, contagens de execuções e falhas), a retenção pode variar conforme o resultado, e a métrica `quartz.job.execution.duration` ganha uma tag `quartz.job.result`, para que seus dashboards de OpenTelemetry separem execuções ignoradas das reais.

## Um health check por job

Esta é a parte que eu ativaria hoje. `RequireSuccessWithin` marca um job como unhealthy quando ele não teve sucesso dentro de uma janela, o que captura o caso silencioso: um trigger pausado, um misfire, um job que continua sendo ignorado por um veto.

```csharp
builder.Services.AddQuartzExecutionHistory();

builder.Services.AddHealthChecks().AddQuartz(options =>
{
    // Degraded once the nightly report has not succeeded for 26 hours.
    options.RequireSuccessWithin(new JobKey("nightly-report", "reports"), TimeSpan.FromHours(26));

    // Unhealthy, so the node leaves rotation, after 90 minutes without a ledger close.
    options.RequireSuccessWithin(
        new JobKey("ledger-close", "billing"),
        TimeSpan.FromMinutes(90),
        HealthStatus.Unhealthy);
});
```

O status padrão é `Degraded`, e uma execução `Skipped` conta como sucesso, então o caminho "nada a fazer" do job acima não acorda ninguém. A lista também pode ser vinculada a partir da configuração por meio de `RequiredJobs`. Se o histórico de execução estiver desativado, o host falha na inicialização em vez de reportar um check que nunca pode passar.

## Atualizando a partir do 4.3

A versão é aditiva: o código do 4.3 compila sem alterações, e todo novo membro de interface tem uma implementação padrão. Se você usa um job store persistente com o histórico de execução ativado, execute o script `4.4/add_execution_outcome_<dialect>.sql` antes de o primeiro nó 4.4 iniciar. A versão também adiciona um atributo `[RetryPolicy]` em classes de job, `q.RunAtStartup(jobKey)` e gerenciamento de schema com Weasel para MySQL, Oracle e Firebird, tudo descrito no [guia de migração](https://www.quartz-scheduler.net/documentation/quartz-4.x/migration-guide.html#upgrading-from-4-3-to-4-4) e no [how-to de job outcomes](https://www.quartz-scheduler.net/documentation/quartz-4.x/how-tos/job-outcomes.html).

Se você ainda está no 4.2, o [analisador de cron e o gerador de código-fonte `[QuartzJob]` do 4.2](/pt-br/2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors/) vêm de brinde.
