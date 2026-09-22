---
title: "OpenTelemetry .NET 1.19.1 исправляет NotSupportedException для шаблонов с подстановочными знаками на net8.0"
description: "OpenTelemetry 1.19.0 перевёл регулярное выражение для шаблонов источников на RegexOptions.NonBacktracking, и на net8.0 оно выбрасывает исключение, как только зарегистрировано достаточно источников. Версия 1.19.1, вышедшая 2026-09-21, возвращает скомпилированное регулярное выражение с тайм-аутом сопоставления."
pubDate: 2026-09-22
tags:
  - "dotnet"
  - "opentelemetry"
  - "observability"
  - "dotnet-8"
lang: "ru"
translationOf: "2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8"
translatedBy: "claude"
translationDate: 2026-09-22
---

[OpenTelemetry .NET 1.19.1](https://github.com/open-telemetry/opentelemetry-dotnet/releases/tag/core-1.19.1) вышел 2026-09-21, через три дня после 1.19.0. В нём ровно одно заметное изменение, и если ваше приложение нацелено на `net8.0` и регистрирует длинный список источников активностей или счётчиков, именно оно отделяет работающий `TracerProvider` от падения при запуске.

## Что сломал 1.19.0

SDK превращает имена из `AddSource("...")` и `AddMeter("...")` в одно регулярное выражение, если хотя бы одно из них содержит `*` или `?`. [PR #7760](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7760), влитый в 1.19.0, укрепил это выражение: на современном .NET оно стало собираться с `RegexOptions.NonBacktracking`. Намерение было хорошим: никакого катастрофического возврата, какой бы шаблон ни оказался в списке.

Проблема в том, что движок без возврата компилирует шаблон в автомат с жёстким ограничением размера, и на .NET 8 это ограничение составляет 1000 узлов (10 000 на .NET 9 и новее). Одна ветвь альтернативы на каждый источник набирается быстро. Дистрибутив Grafana OpenTelemetry, который заранее регистрирует десятки источников, упёрся в него сразу, как сообщается в [issue #7787](https://github.com/open-telemetry/opentelemetry-dotnet/issues/7787):

```text
System.NotSupportedException : The specified pattern with RegexOptions.NonBacktracking
could result in an automata as large as '1285' nodes, which is larger than the configured
limit of '1000'.
   at OpenTelemetry.WildcardHelper.GetWildcardRegex(IEnumerable`1 patterns)
   at OpenTelemetry.Trace.TracerProviderSdk..ctor(IServiceProvider serviceProvider, Boolean ownsServiceProvider)
```

Обратите внимание на триггер: один подстановочный знак в любом месте списка затягивает в регулярное выражение все имена источников. На `net8.0` достаточно такой конфигурации, если список достаточно длинный:

```csharp
builder.Services.AddOpenTelemetry()
    .WithTracing(tracing => tracing
        .AddSource("MyCompany.Orders", "MyCompany.Billing", "MyCompany.Shipping")
        .AddSource(internalSourceNames)   // a few hundred names from config
        .AddSource("AWSSDK.*")            // one wildcard switches on regex mode
        .AddOtlpExporter());
```

Сборки `net9.0`, `net10.0` и .NET Framework исключения не получали. Однако цену они всё равно платили: в PR отмечено, что `Regex` без возврата удерживает примерно в 35 раз больше памяти, чем обычный, поэтому наборы тестов и хосты, создающие много провайдеров за время жизни процесса, могли столкнуться с `OutOfMemoryException`.

## Что 1.19.1 делает вместо этого

[PR #7788](https://github.com/open-telemetry/opentelemetry-dotnet/pull/7788) убирает `NonBacktracking` на всех целевых фреймворках и возвращает скомпилированное регулярное выражение, сохраняя защиту за счёт тайм-аута сопоставления:

```csharp
var pattern = "^(?:" + convertedPattern + ")$";

return new Regex(pattern, RegexOptions.Compiled | RegexOptions.IgnoreCase, RegexMatchTimeout);
// RegexMatchTimeout = TimeSpan.FromSeconds(1)
```

`WildcardHelper.IsMatch` перехватывает `RegexMatchTimeoutException` и возвращает `false`, так что патологический шаблон означает, что один источник не прослушивается, а не зависший поток. То же изменение касается имён инструментов с подстановочными знаками в `AddView`, где на современном .NET тоже использовался `NonBacktracking`.

## Обновление

Обновляйте все основные пакеты OpenTelemetry вместе, поскольку их версии идут синхронно:

```bash
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.19.1
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.19.1
```

Если вы на 1.18.x, версию 1.19.0 можно пропустить целиком. Если вы уже развернули 1.19.0 на `net8.0` и исключения не было, сегодня вы укладываетесь в лимит узлов, но добавление ещё нескольких источников позже обрушило бы запуск, так что обновитесь всё равно. Чтобы освежить в памяти общую настройку, мой разбор [использования OpenTelemetry с .NET 11 и бесплатным бэкендом](/ru/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) по-прежнему актуален без изменений.

Более общий урок стоит запомнить: `RegexOptions.NonBacktracking` не является бесплатным переключателем безопасности. Он меняет риск возврата на ограничение размера автомата и больший расход памяти, а на .NET 8 это ограничение достаточно мало, чтобы упереться в него при обычной конфигурации.
