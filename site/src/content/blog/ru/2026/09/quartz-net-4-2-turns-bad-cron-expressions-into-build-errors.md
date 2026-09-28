---
title: "Quartz.NET 4.2 превращает некорректные cron-выражения в ошибки сборки"
description: "Quartz.NET 4.2.0 поставляется с анализатором Roslyn, который отклоняет непарсящиеся cron-литералы как QZ0001 на этапе компиляции, а также с генератором исходного кода, который превращает атрибуты [QuartzJob] и [CronTrigger] в регистрацию AddDeclaredJobs(). Разбираем, что он проверяет, как выглядит сгенерированный код и как от этого отказаться."
pubDate: 2026-09-28
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "source-generators"
  - "roslyn-analyzers"
lang: "ru"
translationOf: "2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors"
translatedBy: "claude"
translationDate: 2026-09-28
---

Большинство пользователей Quartz.NET хотя бы раз отправляли в продакшен cron-выражение, которое нормально выглядело при код-ревью, а при старте приложения выбрасывало `FormatException`. [Quartz.NET 4.2.0](https://github.com/quartznet/quartznet/releases/tag/v4.2.0), выпущенный 25 сентября 2026 года и дополненный патчем 4.2.1 27 сентября, переносит этот сбой на этап компиляции. Пакет `Quartz` теперь содержит собственный анализатор и генератор исходного кода, и для этого не нужно устанавливать ничего дополнительно.

## QZ0001: парсер cron-выражений запускается во время сборки

Анализатор проверяет каждый cron-литерал или константу, переданную в `WithCronSchedule`, `CronScheduleBuilder.Create`, конструкторы `CronExpression`, `CronCalendar` и `CronTriggerImpl`. Он не использует отдельную грамматику: анализатор подключает исходники собственного парсера планировщика, а корпус из 128 выражений на паритетность следит за тем, чтобы оба оставались согласованными. Если компилятор принимает литерал, планировщик тоже его примет.

```csharp
q.AddTrigger(t => t
    .ForJob(jobKey)
    .WithCronSchedule("0 12 * * 1-5"));
// error QZ0001, reported on the literal with the parser's own message
```

Этот пример - классическая ошибка: пятиполевое crontab-выражение, скопированное из Linux. Quartz читает шесть или семь полей (секунды идут первыми) и требует `?` в одном из двух полей дня, поэтому версия для Quartz выглядит так: `"0 0 12 ? * MON-FRI"`. Если вам действительно нужна Unix-грамматика, передайте `CronFormat.Unix` как литерал, и анализатор будет валидировать выражение по ней.

Вместе с этим правилом поставляются еще три:

- **QZ0002** (ошибка): значение `[JobTimeout("...")]`, которое не парсится или отрицательно.
- **QZ0003** (предупреждение): `[PersistJobDataAfterExecution]` без `[DisallowConcurrentExecution]`, когда два одновременных запуска могут перезаписать друг другу карту данных задачи.
- **QZ0004** (информация): метод `Execute`, который никогда не проверяет свой `CancellationToken`.

## Декларирование задачи прямо на классе

Вторая половина фичи - это генератор, который читает `[QuartzJob]` и `[CronTrigger]` с ваших типов `IJob`:

```csharp
[QuartzJob(Name = "cleanup", Group = "maintenance")]
[CronTrigger("0 0 0/6 * * ?")]
[CronTrigger("0 0 12 ? * MON-FRI", Name = "cleanup-weekday-noon", TimeZone = "Europe/Helsinki")]
public sealed class CleanupJob : IJob
{
    public ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
        => default;
}

services.AddQuartz(q => q.AddDeclaredJobs());
services.AddQuartzHostedService();
```

`AddDeclaredJobs()` генерируется в вашу сборку как `internal`-расширение для `IQuartzBuilder`. Он содержит именно те вызовы `AddJob<T>` и `AddTrigger<T>`, которые вы бы написали вручную, поэтому никакого сканирования сборок не происходит и нечего закреплять (root) для trimming или Native AOT. Cron-строки в атрибутах проходят через QZ0001 так же, как любой другой литерал. Установите `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>`, если хотите посмотреть на сгенерированный `QuartzDeclaredJobs.g.cs`.

У генератора есть собственные защитные проверки: `QZ1001` отклоняет атрибут на типе, который не является конкретным `IJob`, `QZ1002` отклоняет два объявления с одинаковой идентичностью, а `QZ1003` отклоняет `[CronTrigger]` без `[QuartzJob]`. Задача без триггера принудительно получает `Durable = true`, чтобы хранилище не удалило ее сразу же.

## Заметки по обновлению

Анализатор включен по умолчанию, а значит существующий проект с некорректным литералом перестанет собираться. Это и есть цель, но также стоит следить за QZ0003 при `TreatWarningsAsErrors`. Чтобы полностью отключить анализатор, добавьте в файл проекта следующее:

```xml
<PropertyGroup>
  <DisableQuartzAnalyzers>true</DisableQuartzAnalyzers>
</PropertyGroup>
```

В заметках о выпуске отмечается, что `ExcludeAssets="analyzers"` в ссылке на пакет не отключает анализатор на SDK .NET 10. Отдельные уровни серьезности все еще можно настроить в `.editorconfig`.

Если вы используете постоянное хранилище задач (persistent job store), 4.2 также требует применения миграции `database/migrations/4.2/add_continuations_<dialect>.sql` перед запуском первого узла версии 4.2 - из-за новой функции продолжений триггеров (trigger continuations). А если вы включаете новую историю выполнения на основе базы данных на схеме, созданной из `tables_sqlServerMOT.sql` или `tables_sqlServer_Below2016.sql`, переходите сразу на [4.2.1](https://github.com/quartznet/quartznet/releases/tag/v4.2.1), которая исправляет отсутствующий столбец `RETRY_ATTEMPT`.

Если вы еще решаете, подходит ли Quartz в качестве планировщика в принципе, я сравнил его с альтернативами в статье [Hangfire vs Quartz.NET vs IHostedService](/2026/06/hangfire-vs-quartz-net-vs-ihostedservice-for-scheduled-llm-jobs/).
