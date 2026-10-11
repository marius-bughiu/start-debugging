---
title: "Quartz.NET 4.4: задания сообщают о своём результате, а проверка работоспособности замечает, когда они перестают выполняться"
description: "Quartz.NET 4.4.0 позволяет заданию записать в context.Result объект JobRunReport (Succeeded, Failed, Cancelled или Skipped, с кратким описанием и метриками), хранит результат по каждому заданию в истории выполнения и добавляет проверки работоспособности RequireSuccessWithin, которые переходят в состояние Degraded, когда ночное задание перестаёт завершаться успешно."
pubDate: 2026-10-11
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "health-checks"
  - "background-jobs"
lang: "ru"
translationOf: "2026/10/quartz-net-4-4-job-outcomes-and-per-job-health-checks"
translatedBy: "claude"
translationDate: 2026-10-11
---

Quartz.NET [v4.4.0](https://github.com/quartznet/quartznet/releases/tag/v4.4.0) вышел 2026-10-07. Главные цифры относятся к кластеризации (триггеры, срок которых уже наступил, срабатывают в той же транзакции, которая их захватывает, а на PostgreSQL при 20 триггерах в секунду от 95 до 99 % срабатываний укладываются в 50 мс, тогда как в 4.3.0 было 54 %), но изменение, которое чаще всего пригодится в прикладном коде, скромнее: задание наконец может сказать, чего достиг его запуск, а ваша конечная точка проверки работоспособности может на это реагировать.

## "Не выбросило исключение" не значит "сработало"

До версии 4.3 Quartz знал два исхода: задание выбросило исключение или не выбросило. Задание очистки, которому нечего было очищать, синхронизация, которая завершилась досрочно из-за пустой страницы от внешнего API, и запуск, выполнивший реальную работу, выглядели в истории одинаково. А ночное задание, у которого триггер три дня стоял на паузе или пропускал срабатывания (misfire), не было заметно вовсе, потому что ничего не падало.

## Передача результата через JobRunReport

В 4.4 задание записывает в `context.Result` объект `JobRunReport`. Доступны четыре результата (`Succeeded`, `Failed`, `Cancelled`, `Skipped`), необязательное краткое описание до 1000 символов и метрики, которые хранятся как AOT-совместимый JSON размером не более 4000 символов:

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

Записываемый результат определяется в фиксированном порядке: отменённое срабатывание получает `Cancelled`, задание, выбросившее исключение, получает `Failed`, иначе берётся то, что вы положили в `context.Result`, а если там пусто, то `Succeeded`. Вернуть `JobRunReport.Failed(...)` не то же самое, что выбросить исключение. Только выброшенное исключение запускает политику повторных попыток и продолжения `OnFailure`, поэтому сообщайте о сбое через отчёт тогда, когда повтор не поможет.

История хранит `JobRunStatus` для каждого задания (`LastSucceededAtUtc`, `ConsecutiveFailures`, `LastFailureMessage`, счётчики запусков и сбоев), срок хранения можно задавать отдельно для каждого результата, а у метрики `quartz.job.execution.duration` появился тег `quartz.job.result`, так что на панелях OpenTelemetry можно отделять пропущенные запуски от настоящих.

## Проверка работоспособности для каждого задания

Именно эту часть я бы включил уже сегодня. `RequireSuccessWithin` помечает задание как нездоровое, если оно не завершалось успешно в течение заданного окна. Это ловит тихие случаи: триггер на паузе, пропущенное срабатывание, задание, которое раз за разом пропускается из-за вето.

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

Статус по умолчанию равен `Degraded`, а запуск со статусом `Skipped` считается успешным, поэтому ветка "делать нечего" из задания выше никого не разбудит ночью. Список также можно привязать к конфигурации через `RequiredJobs`. Если история выполнения выключена, хост завершится с ошибкой при запуске, а не будет сообщать о проверке, которая никогда не сможет пройти.

## Обновление с версии 4.3

Выпуск аддитивный: код для 4.3 компилируется без изменений, а у каждого нового члена интерфейса есть реализация по умолчанию. Если вы используете постоянное хранилище заданий с включённой историей выполнения, запустите скрипт `4.4/add_execution_outcome_<dialect>.sql` до старта первого узла с версией 4.4. Кроме того, в выпуск вошли атрибут `[RetryPolicy]` для классов заданий, метод `q.RunAtStartup(jobKey)` и управление схемой через Weasel для MySQL, Oracle и Firebird; всё это описано в [руководстве по миграции](https://www.quartz-scheduler.net/documentation/quartz-4.x/migration-guide.html#upgrading-from-4-3-to-4-4) и в [практическом руководстве по результатам заданий](https://www.quartz-scheduler.net/documentation/quartz-4.x/how-tos/job-outcomes.html).

Если вы всё ещё на 4.2, то [анализатор cron и генератор исходного кода `[QuartzJob]` из версии 4.2](/ru/2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors/) достанутся вам в придачу.
