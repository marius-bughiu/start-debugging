---
title: "Переход с Serilog на журналирование OpenTelemetry в .NET 11"
description: "Пошаговое руководство по переводу приложения на .NET 11 с Serilog на журналирование OpenTelemetry: низкорисковый мост Serilog.Sinks.OpenTelemetry, полный переход на Microsoft.Extensions.Logging, что ломается, как проверить и как откатиться."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "serilog"
  - "opentelemetry"
  - "dotnet-11"
  - "logging"
  - "observability"
lang: "ru"
translationOf: "2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-05
---

Если ваша команда стандартизировалась на OpenTelemetry для трассировок и метрик, то выбивается из общего ряда обычно журналирование, которое по-прежнему проходит через Serilog и файловый или Seq sink. Это руководство переводит приложение на .NET 11 (OpenTelemetry .NET SDK 1.15.x, Serilog 4.x) с такой разрозненной конфигурации на журналирование OpenTelemetry. Есть два пути: мост на один вечер, который сохраняет Serilog и меняет только sink, и полный переход на `Microsoft.Extensions.Logging`, который полностью убирает Serilog. Мост обратим одним коммитом и почти ничего не ломает. Полная миграция занимает день или два на реальной кодовой базе, затрагивает каждый `BeginScope` и каждый шаблон сообщения и оправдана только в том случае, если удаление зависимости от Serilog и объединение на одном API журналирования -- это реальная цель, а не просто приятное дополнение.

## Зачем вообще переводить журналирование на OpenTelemetry

- **Один конвейер для трёх сигналов.** Трассировки, метрики и журналы покидают процесс через один и тот же экспортёр OTLP и попадают в один и тот же бэкенд, коррелированные по `TraceId` и `SpanId`. Не нужно эксплуатировать отдельную конечную точку Seq рядом с бэкендом трассировок.
- **Независимый от вендора формат передачи.** OTLP -- это стабильный протокол. Вы можете направить одно и то же приложение на Aspire Dashboard локально, на самостоятельно развёрнутый Jaeger или SigNoz, либо на коммерческий бэкенд, изменив одну конечную точку, а не подменяя пакет sink.
- **Автоматическая корреляция с трассировкой.** Журналы, испускаемые внутри активного `Activity`, несут идентификаторы трассировки и span без обогатителя, поэтому запрос "покажи мне каждую строку журнала для этого запроса" работает между сервисами.
- **Меньше движущихся частей в CI и проде.** Отказ от инициализации Serilog и конфигурации sink убирает целый класс инцидентов "журналы тихо прекратились", вызванных буферизацией sink и ошибками сброса при завершении работы.

Если вы ещё не подключили трассировки OpenTelemetry, сделайте это сначала: [использование OpenTelemetry с .NET 11 и бесплатным бэкендом](/ru/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) описывает настройку экспортёра и бэкенда, которую это руководство предполагает уже выполненной.

## Что ломается

| Область | Изменение | Серьёзность |
| --- | --- | --- |
| Конфигурация sink | Файловый/консольный/Seq sink заменяются экспортёром OTLP или `Serilog.Sinks.OpenTelemetry` | высокая (полный) / низкая (мост) |
| Статический `Log.Logger` + `CreateBootstrapLogger()` | Удаляется при полной миграции; нет двухэтапного журналирования при запуске | высокая (только полный) |
| Обогатители `LogContext.PushProperty` | Заменяются на `ILogger.BeginScope` плюс `IncludeScopes = true` | средняя (только полный) |
| Оператор деструктуризации `{@Order}` | Нет эквивалента в `Microsoft.Extensions.Logging`; журналируйте скалярные поля или сериализуйте явно | средняя (только полный) |
| `UseSerilogRequestLogging()` | Заменяется инструментацией OTel в ASP.NET Core или `AddHttpLogging` | средняя (только полный) |
| Блок конфигурации `MinimumLevel` | Переходит в секцию `Logging:LogLevel` в `appsettings.json` | низкая (только полный) |
| Названия уровней серьёзности | Serilog `Verbose` отображается на OTel `Trace`; `Information` остаётся | низкая |

Столбец "мост" важен: если вы выбираете путь A, применяется только первая строка, и серьёзность низкая. Всё остальное -- забота полной миграции.

## Предполётный чек-лист

- **Установлен .NET 11 SDK.** Подтвердите командой `dotnet --version` (ожидается `11.0.x`).
- **Трассировки OpenTelemetry уже экспортируются по OTLP.** Это руководство переиспользует этот экспортёр и ресурс.
- **Бэкенд, который принимает журналы OTLP.** Aspire Dashboard, SigNoz и Seq -- все принимают OTLP/HTTP. Seq предоставляет конечную точку приёма OTLP по адресу `/ingest/otlp/v1/logs`, поэтому вы можете сохранить Seq в качестве назначения даже после отказа от Serilog Seq sink.
- **Зелёный набор тестов и чистое рабочее дерево** перед началом, чтобы `git diff` показывал только изменения миграции.
- **Знайте свою конечную точку и протокол OTLP.** gRPC по умолчанию -- это `http://localhost:4317`; HTTP/protobuf по умолчанию -- это `http://localhost:4318`. HTTP-экспортёр добавляет `/v1/logs` к базовой конечной точке.

## Шаги миграции

### 1. Зафиксируйте версии пакетов

Определите путь, затем установите соответствующие пакеты. Оба пути нацелены на одну и ту же линейку SDK.

```xml
<!-- .NET 11, both routes -->
<!-- Route A (bridge): keep Serilog, swap the sink -->
<PackageReference Include="Serilog.AspNetCore" Version="9.0.0" />
<PackageReference Include="Serilog.Sinks.OpenTelemetry" Version="4.2.0" />

<!-- Route B (full): Microsoft.Extensions.Logging + OpenTelemetry -->
<PackageReference Include="OpenTelemetry.Extensions.Hosting" Version="1.15.3" />
<PackageReference Include="OpenTelemetry.Exporter.OpenTelemetryProtocol" Version="1.15.3" />
```

Проверка: `dotnet restore` проходит успешно и `dotnet build` чист до того, как вы измените какой-либо код.

### 2a. Путь A -- замена Serilog sink на OTLP

Это низкорисковый путь. Сохраните каждый обогатитель, шаблон сообщения и вызов `LogContext`, которые у вас уже есть. Замените только конфигурацию sink.

```csharp
// .NET 11, C# 14, Serilog 4.x, Serilog.Sinks.OpenTelemetry 4.2.0
using Serilog;
using Serilog.Sinks.OpenTelemetry;

Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .WriteTo.OpenTelemetry(options =>
    {
        options.Endpoint = "http://localhost:4318/v1/logs";
        options.Protocol = OtlpProtocol.HttpProtobuf;
        options.ResourceAttributes = new Dictionary<string, object>
        {
            ["service.name"] = "orders-api",
            ["service.version"] = "2.4.0"
        };
    })
    .CreateLogger();
```

Sink читает `Activity.Current` и автоматически внедряет `TraceId` и `SpanId` в каждую запись журнала (`IncludedData.TraceIdField` и `SpanIdField` включены по умолчанию), поэтому корреляция между сигналами работает без дополнительного обогатителя. Ваши шаблоны `_logger.LogInformation("Placed order {OrderId}", id)` проходят без изменений.

Проверка: запустите приложение, выполните один запрос и убедитесь, что строка журнала появляется в вашем бэкенде OTLP с тем же `TraceId`, что и у трассировки запроса.

### 2b. Путь B -- переход на Microsoft.Extensions.Logging

Удалите `UseSerilog()` / `AddSerilog()` и инициализацию `Log.Logger` из `Program.cs`. Подключите OpenTelemetry к встроенному построителю журналирования.

```csharp
// .NET 11, C# 14, OpenTelemetry .NET SDK 1.15.3
using OpenTelemetry.Logs;
using OpenTelemetry.Resources;

var builder = WebApplication.CreateBuilder(args);

builder.Logging.AddOpenTelemetry(options =>
{
    options.IncludeScopes = true;            // keep BeginScope properties
    options.IncludeFormattedMessage = true;  // populate the log body
    options.ParseStateValues = true;         // capture structured attributes
    options.SetResourceBuilder(
        ResourceBuilder.CreateDefault()
            .AddService("orders-api", serviceVersion: "2.4.0"));
    options.AddOtlpExporter(o =>
    {
        o.Endpoint = new Uri("http://localhost:4318");
    });
});

var app = builder.Build();
```

Если ваше приложение уже вызывает `builder.Services.AddOpenTelemetry()` для трассировок и метрик, предпочтите единую форму, чтобы все три сигнала разделяли один ресурс и экспортёр:

```csharp
// .NET 11, OpenTelemetry .NET SDK 1.15.3
builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r.AddService("orders-api", serviceVersion: "2.4.0"))
    .WithTracing(t => t.AddAspNetCoreInstrumentation())
    .WithMetrics(m => m.AddAspNetCoreInstrumentation())
    .UseOtlpExporter(); // one call: configures OTLP for traces, metrics, AND logs

// Logs still need the provider on the logging builder:
builder.Logging.AddOpenTelemetry(o =>
{
    o.IncludeScopes = true;
    o.IncludeFormattedMessage = true;
    o.ParseStateValues = true;
});
```

`UseOtlpExporter()` (добавлен в SDK 1.8) регистрирует экспортёр OTLP сразу для каждого сигнала, поэтому вам не нужно повторять конечную точку три раза.

Проверка: `dotnet run`, затем убедитесь, что строка `ILogger` достигает бэкенда с правильным `service.name` и заполненным телом.

### 3. Перевод обогатителей в области (только путь B)

У `LogContext.PushProperty("UserId", id)` из Serilog нет эквивалента в `Microsoft.Extensions.Logging`. Используйте `ILogger.BeginScope`, и свойства попадут в запись OTLP, потому что вы установили `IncludeScopes = true`.

```csharp
// Before (Serilog)
using (LogContext.PushProperty("UserId", userId))
{
    _logger.LogInformation("Loaded cart");
}

// After (.NET 11, Microsoft.Extensions.Logging)
using (_logger.BeginScope(new Dictionary<string, object> { ["UserId"] = userId }))
{
    _logger.LogInformation("Loaded cart");
}
```

Проверка: испущенная запись журнала несёт `UserId` как атрибут. Если он отсутствует, вы забыли `IncludeScopes = true`.

### 4. Замена журналирования запросов (только путь B)

`app.UseSerilogRequestLogging()` производил одну сводную строку журнала на запрос. С OpenTelemetry инструментация ASP.NET Core уже испускает HTTP-серверный span на каждый запрос, что является лучшим примитивом для вопроса "что произошло в этом запросе". Если вам всё же нужна строка журнала, добавьте HTTP-журналирование:

```csharp
// .NET 11
builder.Services.AddHttpLogging(o => { });
// ...
app.UseHttpLogging();
```

Проверка: каждый запрос производит HTTP-серверный span (и опциональную запись HTTP-журнала), коррелированный по `TraceId`.

### 5. Перенос конфигурации уровней в appsettings

Блок `MinimumLevel` из Serilog заменяется стандартной секцией `Logging:LogLevel`, которую провайдер OpenTelemetry учитывает как любой другой.

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning"
    }
  }
}
```

Проверка: установите категорию в `Warning`, убедитесь, что её строки `Information` перестают появляться в бэкенде.

## Чек-лист проверки

Запустите его после любого пути, прежде чем удалять старые пакеты:

- `dotnet build` чист без неожиданных предупреждений `Serilog`.
- `dotnet test` проходит без единого сбоя.
- Запрос производит записи журнала в бэкенде с непустым телом (`IncludeFormattedMessage` работает).
- Эти записи разделяют `TraceId` запроса (корреляция работает).
- Структурированные свойства (`OrderId`, значения областей) появляются как атрибуты, а не запекаются в строку сообщения (`ParseStateValues` и `IncludeScopes` работают).
- Объём журналов в бэкенде соответствует ожиданиям; никакой фильтр уровней тихо не отбрасывает и не переполняет.
- Сброс при завершении: остановите приложение в середине запроса и убедитесь, что последние строки всё ещё доходят (пакетный обработчик сбрасывает буфер при освобождении).

## План отката

**Путь A обратим одним коммитом.** Верните блок `WriteTo.OpenTelemetry(...)` обратно к вашей старой конфигурации `WriteTo.Seq(...)` / `WriteTo.File(...)` и удалите пакет `Serilog.Sinks.OpenTelemetry`. Ничего больше не изменилось, поэтому поверхности риска нет.

**Путь B обратим, но не тривиально.** Держите пакеты Serilog установленными, а старую инициализацию `Program.cs` -- в истории git до тех пор, пока новый конвейер не отработает в продакшене один цикл релиза. Если вам нужно откатиться, восстановите `UseSerilog()`, инициализацию `Log.Logger` и преобразуйте вызовы `BeginScope` обратно в `LogContext.PushProperty`. Поскольку переход затрагивает области и журналирование запросов по всей кодовой базе, относитесь к откату как к собственной небольшой миграции, а не к однострочному переключателю. Не удаляйте пакеты Serilog из `.csproj`, пока проверка не пройдёт в продакшене.

## Подводные камни, на которые мы наткнулись

**Пустые тела журналов в бэкенде.** Если `IncludeFormattedMessage` оставлен в значении по умолчанию `false`, запись OTLP отправляется со структурированными атрибутами, но без отрендеренного сообщения, и некоторые бэкенды показывают пустую строку. Включите его. Сочетайте его с `ParseStateValues = true`, чтобы именованные плейсхолдеры (`{OrderId}`) также попадали как атрибуты, а не только внутрь форматированной строки.

**Свойства областей исчезают.** `IncludeScopes` по умолчанию равен `false`. Каждое значение `BeginScope`, а также всё, что ASP.NET Core помещает в область запроса, отбрасывается, пока вы не включите его. Это самый частый отчёт "моя миграция потеряла половину контекста журнала".

**Нет деструктуризации `{@Object}`.** `_logger.LogInformation("Got {@Order}", order)` из Serilog сериализовал весь объект. `Microsoft.Extensions.Logging` трактует `@` как литеральный текст. Журналируйте скалярные поля, по которым вы действительно делаете запросы, или сериализуйте явно с помощью `System.Text.Json`. Сброс целых объектов также взрывает кардинальность атрибутов, за которую некоторые бэкенды берут плату.

**Потеря двухэтапного журналирования при запуске.** `CreateBootstrapLogger()` из Serilog захватывал сбои, происходящие до построения хоста. Провайдер OpenTelemetry существует только после `builder.Build()`, поэтому самые ранние исключения при запуске уходят только в консоль. Если наблюдаемость на самом раннем этапе запуска важна, сохраните минимальный консольный логгер на это время.

**Сюрпризы при отображении серьёзности.** Serilog `Verbose` становится OTel `Trace`, а `Fatal` становится `Critical`. Если вы фильтруете или оповещаете по названиям серьёзности ниже по потоку, обновите эти правила. `Debug`, `Information`, `Warning` и `Error` отображаются один к одному.

Если вы всё равно приводите журналирование в порядок, стоит пересмотреть то, как вы испускаете структурированные данные в первую очередь; [настройка структурированного журналирования с Serilog и Seq в .NET 11](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) описывает шаблоны сообщений, которые чисто переносятся в `ILogger`, а [нативная трассировка OpenTelemetry в ASP.NET Core 11](/ru/2026/04/aspnetcore-11-native-opentelemetry-tracing/) объясняет, почему вам могут не понадобиться дополнительные пакеты инструментации, как только вы перейдёте на единый конвейер. Для фоновых заданий и хостируемых сервисов [мониторинг фоновых заданий без Hangfire](/ru/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) показывает ту же корреляцию, работающую вне пути запроса, а [уведомление о baggage в OpenTelemetry для Aspire 13.2.4](/ru/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/) -- это напоминание держать пакеты OTel пропатченными.

Выбирайте мост, если только удаление Serilog не является реальной целью. Он даёт вам журналы OTLP и корреляцию с трассировкой уже сегодня вечером, а полный переход вы сможете выполнить позже, когда у вас будет спокойный спринт, чтобы как следует перевести области и журналирование запросов.

## Источники

- [Документация по журналам OpenTelemetry .NET](https://opentelemetry.io/docs/languages/dotnet/logs/)
- [Serilog.Sinks.OpenTelemetry на GitHub](https://github.com/serilog/serilog-sinks-opentelemetry)
- [Экспортёр OTLP для OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [Наблюдаемость .NET с OpenTelemetry (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol на NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
