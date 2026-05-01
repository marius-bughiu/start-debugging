---
title: "Как использовать OpenTelemetry с .NET 11 и бесплатным бэкендом"
description: "Подключите трейсы, метрики и логи OpenTelemetry в приложение ASP.NET Core .NET 11 через OTLP-экспортёр и отправляйте данные на бесплатный самохостинг-бэкенд: standalone Aspire Dashboard для локальной разработки, Jaeger и SigNoz для самохостинговой продакшн-среды и OpenTelemetry Collector, когда нужны и тот и другой."
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "observability"
  - "opentelemetry"
lang: "ru"
translationOf: "2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend"
translatedBy: "claude"
translationDate: 2026-05-01
---

Чтобы добавить OpenTelemetry в приложение ASP.NET Core .NET 11 и отправлять данные на что-то бесплатное, установите `OpenTelemetry.Extensions.Hosting` 1.15.3 и `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3, зарегистрируйте SDK через `services.AddOpenTelemetry().WithTracing(...).WithMetrics(...).UseOtlpExporter()`, выставьте `OTEL_EXPORTER_OTLP_ENDPOINT` на ваш collector или бэкенд и запустите standalone Aspire Dashboard из Docker-образа `mcr.microsoft.com/dotnet/aspire-dashboard` как локальный просмотрщик. Aspire Dashboard говорит OTLP/gRPC на порту `4317` и OTLP/HTTP на порту `4318`, ничего не стоит и отображает трейсы, структурированные логи и метрики в одном UI. Для самохостинговой observability в продакшене замените место назначения на Jaeger 2.x (только трейсы) или SigNoz 0.x (трейсы, метрики, логи) и поставьте перед ними OpenTelemetry Collector, чтобы можно было разветвлять и фильтровать. Это руководство написано под .NET 11 preview 3, C# 14 и OpenTelemetry .NET 1.15.3.

## Почему OpenTelemetry, а не SDK от вендоров

Каждый серьёзный observability-продукт для .NET до сих пор поставляет собственный SDK: Application Insights, Datadog, New Relic, Dynatrace, собственный клиент Honeycomb, и так далее. Все они делают примерно одно и то же: цепляются к ASP.NET Core, HttpClient и EF Core, батчат данные, отправляют в своём wire-формате. Проблема начинается в тот момент, когда вы хотите сменить вендора, запустить два параллельно или просто посмотреть данные локально, никому не платя. Каждое переписывание превращается в отдельный многонедельный проект, потому что вызовы инструментирования разбросаны по сотням файлов.

OpenTelemetry заменяет эту картину единым вендор-нейтральным SDK и единым wire-форматом (OTLP). Инструментируете один раз. Экспортёр -- отдельный пакет, заменяемый на старте. Одну и ту же телеметрию можно отправлять в Aspire Dashboard во время локальной разработки, в Jaeger на staging и в платный бэкенд на продакшене -- всё это без изменения прикладного кода. ASP.NET Core 11 даже включает нативные примитивы tracing OpenTelemetry, поэтому спаны самого фреймворка попадают в тот же пайплайн, что и ваши собственные (см. [изменения по нативному tracing OpenTelemetry в .NET 11](/ru/2026/04/aspnetcore-11-native-opentelemetry-tracing/) о том, что было поднято в апстрим).

Номера версий, которые стоит запомнить на 2026 год: `OpenTelemetry` 1.15.3, `OpenTelemetry.Extensions.Hosting` 1.15.3, `OpenTelemetry.Exporter.OpenTelemetryProtocol` 1.15.3, инструментирование ASP.NET Core 1.15.0 и инструментирование HttpClient 1.15.0. Aspire Dashboard выходит из `mcr.microsoft.com/dotnet/aspire-dashboard:9.5` на момент написания.

## Поднимите бесплатный бэкенд за 30 секунд

До любого кода нужно поднять бэкенд. Standalone Aspire Dashboard -- наименее затратный вариант для локальной разработки. Он выставляет OTLP-приёмник, индексирует трейсы, метрики и логи в памяти и даёт Blazor-UI на порту `18888`:

```bash
# Aspire Dashboard 9.5, default ports
docker run --rm \
  --name aspire-dashboard \
  -p 18888:18888 \
  -p 4317:18889 \
  -p 4318:18890 \
  -e DASHBOARD__OTLP__AUTHMODE=ApiKey \
  -e DASHBOARD__OTLP__PRIMARYAPIKEY=local-dev-key \
  mcr.microsoft.com/dotnet/aspire-dashboard:9.5
```

Контейнер внутри выставляет `18889` для OTLP/gRPC и `18890` для OTLP/HTTP, а вы маппите их на стандартные `4317`/`4318` снаружи, чтобы любой OpenTelemetry SDK с дефолтными настройками их нашёл. Установка `DASHBOARD__OTLP__AUTHMODE=ApiKey` заставляет клиентов прикреплять ключ в заголовке `x-otlp-api-key`, что важно в момент, когда вы биндите dashboard на не-loopback адрес. Откройте `http://localhost:18888` -- увидите пустые вкладки Traces, Metrics и Structured Logs, ожидающие данных. Dashboard хранит всё в памяти процесса, поэтому рестарт стирает состояние: это инструмент разработки, а не долгосрочное хранилище.

Если предпочитаете не запускать ничего локально, у Jaeger 2.x та же эргономика, но только для трейсов:

```bash
# Jaeger 2.0 all-in-one
docker run --rm \
  --name jaeger \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  jaegertracing/jaeger:2.0.0
```

Jaeger 2.x сам по себе является тонкой обёрткой над OpenTelemetry Collector с бэкендом хранения Cassandra/Elasticsearch/Badger и принимает OTLP нативно. SigNoz, который добавляет метрики и логи поверх ClickHouse, ставится через Docker Compose, а не одной командой; склонируйте `https://github.com/SigNoz/signoz` и запустите `docker compose up`.

## Установите SDK и пакеты инструментирования

Для минимального API ASP.NET Core 11 четыре пакета покрывают happy path. Метапакет `OpenTelemetry.Extensions.Hosting` подтягивает SDK; OTLP-экспортёр обеспечивает транспорт; а два пакета инструментирования покрывают две поверхности, нужные любому веб-приложению: входящий HTTP и исходящий HTTP.

```bash
# OpenTelemetry .NET 1.15.3, .NET 11
dotnet add package OpenTelemetry.Extensions.Hosting --version 1.15.3
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol --version 1.15.3
dotnet add package OpenTelemetry.Instrumentation.AspNetCore --version 1.15.0
dotnet add package OpenTelemetry.Instrumentation.Http --version 1.15.0
```

Если вы также используете EF Core, добавьте `OpenTelemetry.Instrumentation.EntityFrameworkCore` 1.15.0-beta.1. Обратите внимание на суффикс `-beta.1`: эта линия официально всё ещё в превью, но все команды, с которыми я работал, относятся к ней как к стабильной. Инструментирование цепляется к diagnostic source EF Core и эмитит один спан на `SaveChanges`, query и DbCommand.

## Подключите трейсы, метрики и логи в Program.cs

SDK -- это одна регистрация. Начиная с OpenTelemetry .NET 1.8, `UseOtlpExporter()` -- это сквозной хелпер, регистрирующий OTLP-экспортёр для трейсов, метрик и логов одним вызовом, заменяющий старый пер-пайплайновый `AddOtlpExporter()`:

```csharp
// .NET 11, C# 14, OpenTelemetry 1.15.3
using OpenTelemetry.Logs;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenTelemetry()
    .ConfigureResource(r => r
        .AddService(
            serviceName: "orders-api",
            serviceVersion: typeof(Program).Assembly.GetName().Version?.ToString() ?? "0.0.0",
            serviceInstanceId: Environment.MachineName))
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddSource("Orders.*"))
    .WithMetrics(m => m
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddRuntimeInstrumentation()
        .AddMeter("Orders.*"))
    .WithLogging()
    .UseOtlpExporter();

var app = builder.Build();

app.MapGet("/orders/{id:int}", (int id) => new { id, status = "ok" });
app.Run();
```

Стоит подсветить три вещи. Во-первых, `ConfigureResource` на практике не опционален: без `service.name` любой бэкенд свалит всё под `unknown_service:dotnet`, что становится непригодным для работы в момент появления второго приложения. Во-вторых, `AddSource("Orders.*")` -- это то, что выводит наружу ваши собственные экземпляры `ActivitySource`; если вы создаёте один как `new ActivitySource("Orders.Checkout")`, он должен совпадать с зарегистрированным глобом, иначе спаны никуда не уходят. В-третьих, `WithLogging()` привязывает `Microsoft.Extensions.Logging` к тому же пайплайну, и вызов `ILogger<T>` пишет структурированные OpenTelemetry-записи лога с прикреплёнными текущими trace ID и span ID. Именно это заставляет работать ссылку "View structured logs for this trace" в Aspire Dashboard.

## Настраивайте экспортёр через переменные окружения, а не через код

Стандартный OTLP-экспортёр читает место назначения, протокол и заголовки из переменных окружения, определённых спецификацией OpenTelemetry. Хардкодить их внутри `UseOtlpExporter(o => o.Endpoint = ...)` -- плохой запах, потому что это привязывает бинарь к конкретному бэкенду. Используйте переменные окружения, и один и тот же образ будет работать на ноутбуке разработчика, в CI и в продакшене без пересборки:

```bash
# Talk to a local Aspire Dashboard over gRPC
export OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:4317"
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
export OTEL_EXPORTER_OTLP_HEADERS="x-otlp-api-key=local-dev-key"
export OTEL_SERVICE_NAME="orders-api"
export OTEL_RESOURCE_ATTRIBUTES="deployment.environment=dev"
```

Два значения ставят в тупик большинство людей. `OTEL_EXPORTER_OTLP_PROTOCOL` по умолчанию равен `grpc` на .NET 8+, но `http/protobuf` на сборках под .NET Standard 2.0, потому что SDK на современных таргетах поставляется с собственным gRPC-клиентом, а на Framework откатывается на HTTP. Если вы мостите оба, выставляйте значение явно. И `OTEL_EXPORTER_OTLP_HEADERS` принимает разделённый запятыми список пар `ключ=значение`. Бэкенды, аутентифицирующиеся bearer-токенами, используют это для `Authorization=Bearer ...`. API-ключ Aspire Dashboard -- это `x-otlp-api-key`, а не более привычный `Authorization`.

При миграции с локальной разработки на развёрнутый бэкенд меняется только endpoint и заголовок аутентификации. Бинарь приложения остаётся тем же.

## Добавьте собственный спан через ActivitySource

Пакеты инструментирования автоматически покрывают входящий и исходящий HTTP, плюс EF Core, если вы добавили этот пакет. Всё остальное -- на вас. .NET поставляет `System.Diagnostics.ActivitySource` как кросс-runtime примитив для спанов; OpenTelemetry .NET адаптирует этот тип напрямую, не вводя собственный. Создайте по одному на логическую область, зарегистрируйте префикс в `AddSource` и вызывайте `StartActivity` там, где нужен спан:

```csharp
// Orders/CheckoutService.cs -- .NET 11, C# 14
using System.Diagnostics;

public sealed class CheckoutService(IOrdersRepository orders, IPaymentClient payments)
{
    private static readonly ActivitySource Source = new("Orders.Checkout");

    public async Task<CheckoutResult> CheckoutAsync(int orderId, CancellationToken ct)
    {
        using var activity = Source.StartActivity("checkout", ActivityKind.Internal);
        activity?.SetTag("order.id", orderId);

        var order = await orders.GetAsync(orderId, ct);
        activity?.SetTag("order.line_count", order.Lines.Count);

        var receipt = await payments.ChargeAsync(order, ct);
        activity?.SetTag("payment.provider", receipt.Provider);

        return new CheckoutResult(receipt.Id);
    }
}
```

`StartActivity` возвращает `null`, когда не подключён ни один listener, поэтому вызовы `?.SetTag` -- это не оборонная паранойя, а способ избежать NullReferenceException в сборке с отключённым OpenTelemetry. Теги следуют семантическим конвенциям OpenTelemetry там, где они есть (`http.request.method`, `db.system`, `messaging.destination.name`); для доменно-специфичных значений вроде `order.id` пространствуйте их собственным префиксом, чтобы они оставались запрашиваемыми и не сталкивались с конвенциями.

Тот же паттерн применяется к метрикам через `System.Diagnostics.Metrics.Meter`. Создавайте по одному на область, регистрируйте через `AddMeter` и используйте `Counter<T>`, `Histogram<T>` или `ObservableGauge<T>` для записи значений.

## Коррелируйте OTLP-логи с трейсами

Причина регистрировать `WithLogging()`, а не только `WithTracing()`, -- корреляция. Каждый вызов `ILogger<T>` внутри активного спана автоматически получает `TraceId` и `SpanId` спана, прикреплённые как поля OTLP-записи лога, и Aspire Dashboard рендерит это как кликабельную ссылку из вида трейса. Та же корреляция работает в любом OpenTelemetry-совместимом бэкенде.

Если вы уже используете Serilog и не хотите от него отказываться, не нужно. Пакет `Serilog.Sinks.OpenTelemetry` пишет события Serilog как OTLP-записи логов, а провайдер логирования OpenTelemetry SDK можно пропустить в `WithLogging()`. Пост о структурированном логировании на этом сайте даёт более полную трактовку [настройки Serilog с Seq в .NET 11](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/), и те же правила корреляции трейсов применяются при замене Seq на OTLP.

Для чистого `Microsoft.Extensions.Logging` рецепт короче: добавьте `WithLogging()` в пайплайн OpenTelemetry и отключите дефолтный консольный провайдер в продакшене. `LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` уже структурирован, и OpenTelemetry сериализует именованные плейсхолдеры как атрибуты OTLP-лога. Консольный провайдер, наоборот, схлопывает их обратно в одну строку, а это ровно та регрессия, от которой вы пытались уйти.

## Поставьте OpenTelemetry Collector впереди в продакшене

В продакшене вы очень редко хотите, чтобы приложение разговаривало с observability-бэкендом напрямую. Вы хотите Collector посередине -- отдельный процесс, принимающий OTLP, применяющий sampling, чистящий PII, батчующий, ретраящий и разветвляющий данные на одно или несколько мест назначения. Образ Collector -- `otel/opentelemetry-collector-contrib:0.111.0`, и минимальная конфигурация, принимающая OTLP и пересылающая в Jaeger плюс хостед-бэкенд, выглядит так:

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 5s
    send_batch_size: 512
  attributes/scrub:
    actions:
      - key: http.request.header.authorization
        action: delete
      - key: user.email
        action: hash

exporters:
  otlp/jaeger:
    endpoint: jaeger:4317
    tls:
      insecure: true
  otlp/honeycomb:
    endpoint: api.honeycomb.io:443
    headers:
      x-honeycomb-team: ${env:HONEYCOMB_API_KEY}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch, attributes/scrub]
      exporters: [otlp/jaeger, otlp/honeycomb]
```

`OTEL_EXPORTER_OTLP_ENDPOINT` приложения теперь указывает на Collector, а не на конкретный бэкенд. Смена места назначения -- это переконфигурация и рестарт Collector, а не передеплой каждого сервиса. Этот же паттерн помогает удерживать объём трейсов в разумных пределах: поставьте процессор `attributes/scrub` перед каждым экспортёром -- и вы перестанете случайно отправлять заголовки авторизации третьей стороне с первого же дня.

## Подводные камни, о которых не предупреждает документация

Три вещи кусают людей по дороге к работающему пайплайну.

Во-первых, **дефолты gRPC и HTTP не совпадают между runtime-ами**. На .NET 8 и выше SDK поставляется со встроенным gRPC-клиентом, и `OTEL_EXPORTER_OTLP_PROTOCOL` по умолчанию равен `grpc`. На .NET Framework 4.8 и .NET Standard 2.0 дефолт -- `http/protobuf`, чтобы избежать зависимости от `Grpc.Net.Client`. Если одно решение таргетит и то и другое, выставляйте протокол явно, иначе вы увидите разное поведение одного и того же кода из двух сборок.

Во-вторых, **атрибуты ресурса глобальны, а не пер-пайплайновые**. `ConfigureResource` выполняется один раз, и результат прикрепляется к каждому трейсу, метрике и записи лога этого процесса. Попытка задать пер-запросный атрибут через API ресурса молча ничего не делает; то, что вам нужно там, -- это `Activity.SetTag` на активном спане или запись `Baggage`, пропагирующаяся через вызов. CVE по DoS через baggage в Aspire 13.2.4, описанная в [разборе CVE по baggage в OpenTelemetry .NET](/ru/2026/04/aspire-13-2-4-opentelemetry-cve-2026-40894-baggage-dos/), напоминает, что baggage парсится жадно на каждом запросе и потому является полезным, но острым инструментом.

В-третьих, **OTLP-экспортёр повторяет попытки в фоне молча**. Когда бэкенд лежит, экспортёр продолжает батчить события в памяти и повторять с экспоненциальным backoff до настраиваемого предела. Обычно это то, что нужно; удивляет другое: возвращение Collector или dashboard в строй не вызывает мгновенный flush. Если вы запускаете интеграционный тест и утверждаете "трейс X пришёл в Aspire Dashboard за 100 мс", задайте экспортёру расписание `BatchExportProcessor` короче дефолтных 5 секунд или вызывайте `TracerProvider.ForceFlush()` явно перед утверждением.

## Куда двигаться дальше

Ценность OpenTelemetry растёт вместе с поверхностью, которую вы инструментируете. Стартовая точка -- ASP.NET Core плюс HttpClient плюс EF Core. Дальше дополнения с наибольшим рычагом -- фоновые сервисы (каждый `IHostedService` должен стартовать `Activity` на единицу работы) и исходящие message-брокеры (инструментирование `OpenTelemetry.Instrumentation.MassTransit` и Confluent.Kafka покрывает большинство команд). Для более глубокого профилирования единиц работы, когда спаны уже привели вас на правильную минуту, [руководство по dotnet-trace на этом сайте](/ru/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) проходит по инструменту, который чаще всего подхватывает там, где OpenTelemetry заканчивается, а [пост про глобальный фильтр исключений](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) покрывает сторону ASP.NET Core по чистому захвату ошибок в тот же пайплайн.

Конечное состояние, к которому стоит стремиться: один пайплайн, один wire-формат и одно место, куда смотреть в первую очередь, когда что-то идёт не так. OpenTelemetry плюс Aspire Dashboard плюс Collector впереди приведут вас туда по цене одного docker pull.

Sources:

- [OpenTelemetry .NET Exporters documentation](https://opentelemetry.io/docs/languages/dotnet/exporters/)
- [OTLP Exporter for OpenTelemetry .NET](https://github.com/open-telemetry/opentelemetry-dotnet/blob/main/src/OpenTelemetry.Exporter.OpenTelemetryProtocol/README.md)
- [Use OpenTelemetry with the standalone Aspire Dashboard - .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-otlp-example)
- [.NET Observability with OpenTelemetry](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/observability-with-otel)
- [OpenTelemetry.Exporter.OpenTelemetryProtocol on NuGet](https://www.nuget.org/packages/OpenTelemetry.Exporter.OpenTelemetryProtocol)
