---
title: ".NET Extensions 10.11: буферизованные логи наконец сохраняют свои scope"
description: "Microsoft.Extensions.Telemetry 10.11.0, вышедший 2026-10-15, добавляет в глобальную буферизацию логов и буферизацию на уровне запроса экспериментальную опцию IncludeScopes, чтобы OrderId и TenantId из BeginScope переживали Flush(), а не терялись молча."
pubDate: 2026-10-16
tags:
  - "dotnet"
  - "logging"
  - "observability"
  - "aspnetcore"
  - "csharp"
lang: "ru"
translationOf: "2026/10/dotnet-extensions-10-11-log-buffering-keeps-scopes-with-includescopes"
translatedBy: "claude"
translationDate: 2026-10-16
---

[.NET Extensions 10.11.0](https://github.com/dotnet/extensions/releases/tag/v10.11.0) появился в NuGet 2026-10-15. Большинство исправлений для ИИ мелкие, но одно изменение в телеметрии закрывает пробел, существовавший с момента появления буферизации логов: буферизованные записи теряли все значения из `ILogger.BeginScope`. Вы буферизовали логи уровня `Information`, возникало исключение, вы вызывали `Flush()`, и записи выходили без `OrderId`, `TenantId` или ID запроса, которые вы положили в scope. То есть без того самого контекста, который нужен для отладки сбоя.

## Как выглядел flush раньше

Буферизация логов находится в `Microsoft.Extensions.Telemetry` (глобальный буфер) и `Microsoft.AspNetCore.Diagnostics.Middleware` (буфер на запрос). Записи, подходящие под правило, хранятся в кольцевом буфере и пишутся только при вызове `Flush()`. Вот минимальный repro с JSON-логгером консоли, который обычно выводит scope, когда включён `IncludeScopes`:

```csharp
var builder = Host.CreateApplicationBuilder();
builder.Logging.ClearProviders();
builder.Logging.AddJsonConsole(o => o.IncludeScopes = true);
builder.Logging.AddGlobalBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true; // new in 10.11.0, EXTEXP0003
});
using var host = builder.Build();
var logger = host.Services.GetRequiredService<ILogger<Program>>();
var buffer = host.Services.GetRequiredService<GlobalLogBuffer>();

using (logger.BeginScope(new Dictionary<string, object?> { ["OrderId"] = 4711, ["TenantId"] = "contoso" }))
{
    logger.LogInformation("Reserving stock for {Sku}", "SKU-42");
    buffer.Flush();
}
```

Я запускал его как файловое приложение на SDK 10.0.302. С `Microsoft.Extensions.Telemetry` 10.10.0 (без строки `IncludeScopes`, которая там не компилируется) в выведенной записи нет и следа scope, хотя flush происходит внутри него:

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

В 10.11.0 с `IncludeScopes = true`:

```text
{"EventId":0,"LogLevel":"Information","Category":"Program","Message":"Reserving stock for SKU-42","Exception":"","State":{"Message":null,"Sku":"SKU-42","OrderId":"4711","TenantId":"contoso","{OriginalFormat}":"Reserving stock for {Sku}"}}
```

## Как это работает

[PR #7813](https://github.com/dotnet/extensions/pull/7813) захватывает scope в момент буферизации записи, а не во время flush, и это именно то, что нужно: к моменту вызова `Flush()` исходный scope обычно уже давно закрыт. Буферы получают `IExternalScopeProvider` из DI (общий с `ExtendedLoggerFactory`) и копируют пары имя/значение каждого scope в запись.

Несколько деталей, которые стоит знать:

- Scope попадают в запись как **атрибуты**, а не как scope. Провайдеры `IBufferedLogger` видят их в `BufferedLogRecord.Attributes`; остальные провайдеры получают их внутри состояния, передаваемого в `ILogger.Log`. Поэтому выше они оказались в `State`, а не в массиве `Scopes`.
- Захватываются только scope, реализующие `IEnumerable<KeyValuePair<string, object?>>`. Простой строковый scope вроде `BeginScope("Checkout")` пропускается, а пары `{OriginalFormat}` отбрасываются. Scope из `ActivityTrackingOptions` (trace ID, span ID) включаются.
- По умолчанию опция выключена, она экспериментальная под `EXTEXP0003` и привязывается из конфигурации. Опции перечитываются для каждой буферизуемой записи, поэтому перезагрузка конфигурации действует сразу.

Для буферизации на запрос в ASP.NET Core тот же переключатель есть в `PerRequestLogBufferingOptions`:

```csharp
builder.Logging.AddPerIncomingRequestBuffer(o =>
{
    o.Rules.Add(new LogBufferingFilterRule(logLevel: LogLevel.Information));
    o.IncludeScopes = true;
});
```

## Что ещё в 10.11.0

Релиз исправляет `ArgumentNullException` в буферизации на запрос в конце запроса (#7811) и состояние гонки в буферизации, вызванное кэшем селектора правил (#7803). Если вы используете экспериментальный обогатитель задержек HTTP, `AddHttpLatencyTelemetry` теперь называется `AddHttpServerLatencyTelemetry` (#7730). Со стороны ИИ `FunctionInvocationContext.Terminate` теперь учитывается, когда функция выбрасывает исключение (#7801), а `ChatResponseUpdate.Clone` сохраняет `ContinuationToken` (#7699). Предыдущим релизом в этой серии был [Microsoft.Extensions.AI 10.10.1](/ru/2026/09/microsoft-extensions-ai-10-10-1-fixes-openai-2-14-typeloadexception/).

Чтобы обновиться:

```bash
dotnet add package Microsoft.Extensions.Telemetry --version 10.11.0
```

Если вы буферизуете логи и коррелируете их по значениям scope, включите `IncludeScopes`. Без этой опции логи, которые вы сбрасываете при сбое, приходят без тех ID, по которым их нужно сопоставлять.
