---
title: "Как настроить структурированное журналирование с Serilog и Seq в .NET 11"
description: "Полное руководство по подключению Serilog 4.x и Seq 2025.2 к приложению .NET 11 ASP.NET Core: AddSerilog против UseSerilog, двухэтапное журналирование при старте, конфигурация через JSON, обогатители, журналирование запросов, корреляция трассировок OpenTelemetry, API-ключи и продакшн-нюансы вокруг буферизации, хранения и уровня сигнала."
pubDate: 2026-05-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "logging"
  - "serilog"
  - "seq"
lang: "ru"
translationOf: "2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-01
---

Чтобы отправлять структурированные журналы из приложения .NET 11 ASP.NET Core в Seq, установите `Serilog.AspNetCore` 10.0.0 и `Serilog.Sinks.Seq` 9.0.0, зарегистрируйте конвейер вызовом `services.AddSerilog((sp, lc) => lc.ReadFrom.Configuration(...).WriteTo.Seq("http://localhost:5341"))` и включите журналирование запросов хоста через `app.UseSerilogRequestLogging()`. Настройте всё через `appsettings.json`, чтобы в продакшне можно было менять минимальный уровень без повторного развёртывания. Запустите Seq локально как Docker-образ `datalust/seq` с `ACCEPT_EULA=Y` и пробросом портов, а сток направьте на `http://localhost:5341`. Это руководство написано для .NET 11 preview 3 и C# 14, но каждый фрагмент работает и на .NET 8, 9 и 10.

## Почему Serilog плюс Seq, а не "просто `ILogger`"

`Microsoft.Extensions.Logging` подходит для hello-world демонстраций и юнит-тестов. Для продакшна его недостаточно. `ILogger<T>.LogInformation("Order {OrderId} for {CustomerId} took {Elapsed} ms", id, customer, ms)` структурирован в точке вызова, но провайдер консоли по умолчанию схлопывает эти свойства в одну строку и выбрасывает структуру. Как только в продакшне что-то идёт не так, вы снова grep-аете tarball.

Serilog сохраняет структуру. Каждый вызов сериализует именованные плейсхолдеры в JSON-свойства и пересылает их в любой настроенный сток. Seq это принимающая сторона: самостоятельно размещаемый сервер журналов, который индексирует эти свойства, чтобы вы могли написать `select count(*) from stream where StatusCode >= 500 and Endpoint = '/api/orders' group by time(1m)` и получить ответ за миллисекунды. Эта связка уже десять лет является выбором по умолчанию в мире .NET, потому что обе её части написаны людьми, которые ими реально пользуются.

Номера версий, которые стоит запомнить на 2026 год: Serilog 4.3.1, Serilog.AspNetCore 10.0.0, Serilog.Sinks.Seq 9.0.0 и Seq 2025.2. Старшие номера отслеживают Microsoft.Extensions.Logging, поэтому на .NET 11 вы остаётесь на ветке 10.x для `Serilog.AspNetCore` и на ветке 9.x для `Serilog.Sinks.Seq`, пока Microsoft не выпустит новый мажор.

## Запустите Seq локально за 30 секунд

Перед написанием кода поднимите экземпляр Seq. Однострочник Docker это то, чем пользуется большинство команд, в том числе в CI:

```bash
# Seq 2025.2, default ports
docker run \
  --name seq \
  -d \
  --restart unless-stopped \
  -e ACCEPT_EULA=Y \
  -p 5341:80 \
  -p 5342:443 \
  -v seq-data:/data \
  datalust/seq:2025.2
```

`5341` это порт HTTP-приёма и UI, `5342` это HTTPS. Именованный том `seq-data` сохраняет события между перезапусками контейнера. На Windows альтернативой является MSI-установщик с datalust.co; он поставляет тот же движок и те же порты по умолчанию. Бесплатный тариф безлимитен для одного пользователя; командное лицензирование подключается, как только вы добавляете аутентифицированные учётные записи. Откройте `http://localhost:5341` в браузере, нажмите "Settings", "API Keys" и создайте ключ. Он понадобится и для авторизации приёма, и для любых дашбордов только для чтения, которые вы подключите позже.

## Установите пакеты

Для базового сценария достаточно трёх пакетов:

```bash
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Sinks.Seq --version 9.0.0
dotnet add package Serilog.Settings.Configuration --version 9.0.0
```

`Serilog.AspNetCore` подтягивает `Serilog`, `Serilog.Extensions.Hosting` и консольный сток. `Serilog.Sinks.Seq` это HTTP-сток, который пакетирует события и отправляет в endpoint приёма Seq. `Serilog.Settings.Configuration` это мост, позволяющий описать весь конвейер в `appsettings.json`, а именно так его и стоит запускать в продакшне.

## Минимальный Program.cs

Вот наименьшая жизнеспособная конфигурация для минимального API на .NET 11. Она использует API `AddSerilog`, который стал единственной поддерживаемой точкой входа после того, как Serilog.AspNetCore 8.0.0 удалил устаревшее расширение `IWebHostBuilder.UseSerilog()`.

```csharp
// .NET 11 preview 3, C# 14
// Serilog 4.3.1, Serilog.AspNetCore 10.0.0, Serilog.Sinks.Seq 9.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.Seq("http://localhost:5341"));

var app = builder.Build();

app.UseSerilogRequestLogging();

app.MapGet("/api/orders/{id:int}", (int id, ILogger<Program> log) =>
{
    log.LogInformation("Fetching order {OrderId}", id);
    return Results.Ok(new { id, total = 99.95m });
});

app.Run();
```

Полезную работу делают пять строк. `ReadFrom.Configuration` загружает минимальные уровни и переопределения из `appsettings.json`. `ReadFrom.Services` позволяет стокам разрешать scoped-зависимости, что становится важно, когда вы начинаете писать собственные обогатители. `Enrich.FromLogContext` это то, что позволяет в middleware выполнить `using (LogContext.PushProperty("CorrelationId", id))` и автоматически проставить эту метку каждой строке журнала внутри блока. `WriteTo.Console` сохраняет скорость локальной разработки. `WriteTo.Seq` это собственно сток.

`UseSerilogRequestLogging` заменяет стандартное middleware журналирования запросов ASP.NET Core одним структурированным событием на запрос. Вместо трёх-четырёх строк на запрос вы получаете одну строку с `RequestPath`, `StatusCode`, `Elapsed` и любыми свойствами, которые вы добавите через коллбэк `EnrichDiagnosticContext`. Меньше шума, больше сигнала.

## Перенесите конфигурацию в appsettings.json

Хардкод `http://localhost:5341` подходит для демо и неприемлем для продакшна. Перенесите всё описание конвейера в `appsettings.json`, чтобы менять детальность без повторного развёртывания:

```json
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Sinks.Seq" ],
    "MinimumLevel": {
      "Default": "Information",
      "Override": {
        "Microsoft.AspNetCore": "Warning",
        "Microsoft.EntityFrameworkCore.Database.Command": "Warning",
        "System.Net.Http.HttpClient": "Warning"
      }
    },
    "Enrich": [ "FromLogContext", "WithMachineName", "WithThreadId" ],
    "WriteTo": [
      { "Name": "Console" },
      {
        "Name": "Seq",
        "Args": {
          "serverUrl": "http://localhost:5341",
          "apiKey": "REPLACE_WITH_API_KEY"
        }
      }
    ],
    "Properties": {
      "Application": "Orders.Api"
    }
  }
}
```

Несколько важных деталей. Массив `Using` это то, что `Serilog.Settings.Configuration` 9.x использует для загрузки сборок стоков; без него парсер JSON не знает, какая сборка содержит `WriteTo.Seq`. Карта `Override` это самая недооценённая возможность Serilog: она позволяет держать глобальный уровень на `Information`, при этом фиксируя журнал команд EF Core на `Warning`, чтобы не утонуть в SQL на нагруженном сервере. Добавляйте `WithMachineName` и `WithThreadId` только если установлены `Serilog.Enrichers.Environment` и `Serilog.Enrichers.Thread`; иначе уберите их, иначе конфигурация упадёт при старте с тихой ошибкой "method not found".

Свойство `Application` это ключ к использованию одного экземпляра Seq для многих сервисов. Прокидывайте имя каждого приложения через `Properties` и получите бесплатный фильтр в UI Seq: `Application = 'Orders.Api'`.

## Журналирование при старте: поймайте падение до того, как журналирование заработает

У конфигурации, управляемой настройками, есть одно слабое место. Если `appsettings.json` некорректен, хост падает раньше, чем настроенные стоки оживут, и вы не получите ничего. Официальный паттерн, который документирует `Serilog.AspNetCore`, это двухэтапный старт: установить минимальный логгер до построения хоста, а затем заменить его, когда конфигурация загружена.

```csharp
// .NET 11 preview 3, C# 14
using Serilog;

Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .WriteTo.Console()
    .WriteTo.Seq("http://localhost:5341")
    .CreateBootstrapLogger();

try
{
    var builder = WebApplication.CreateBuilder(args);

    builder.Services.AddSerilog((services, lc) => lc
        .ReadFrom.Configuration(builder.Configuration)
        .ReadFrom.Services(services)
        .Enrich.FromLogContext()
        .WriteTo.Console()
        .WriteTo.Seq("http://localhost:5341"));

    var app = builder.Build();

    app.UseSerilogRequestLogging();
    app.MapGet("/", () => "ok");

    app.Run();
}
catch (Exception ex) when (ex is not HostAbortedException)
{
    Log.Fatal(ex, "Host terminated unexpectedly");
    throw;
}
finally
{
    Log.CloseAndFlush();
}
```

`CreateBootstrapLogger` возвращает логгер, который одновременно пригоден к использованию сейчас и заменяем позже, поэтому статический `Log.Logger` продолжает работать после того, как `AddSerilog` подменяет реализацию. `Log.CloseAndFlush()` в блоке `finally` это то, что гарантирует, что пакет в памяти `Serilog.Sinks.Seq` действительно сбросится до выхода процесса. Пропустите его, и потеряете последние несколько секунд журналов при штатной остановке, а это именно то окно, в котором живут интересные события.

## Журналирование запросов, которое реально полезно

`UseSerilogRequestLogging` пишет одно событие на запрос с уровнем `Information` для 2xx и 3xx, `Warning` для 4xx и `Error` для 5xx. Значения по умолчанию разумны. Чтобы довести до продакшн-уровня, переопределите шаблон сообщения и обогатите каждое событие идентификатором пользователя и trace id:

```csharp
// .NET 11 preview 3, C# 14
app.UseSerilogRequestLogging(options =>
{
    options.MessageTemplate =
        "HTTP {RequestMethod} {RequestPath} responded {StatusCode} in {Elapsed:0} ms";

    options.EnrichDiagnosticContext = (diagnosticContext, httpContext) =>
    {
        diagnosticContext.Set("UserId", httpContext.User?.FindFirst("sub")?.Value);
        diagnosticContext.Set("ClientIp", httpContext.Connection.RemoteIpAddress?.ToString());
        diagnosticContext.Set("TraceId", System.Diagnostics.Activity.Current?.TraceId.ToString());
    };
});
```

Строка `TraceId` это самый ценный обогатитель, который можно добавить. В сочетании со сбором trace id, появившимся в Serilog 3.1, каждое событие журнала, которое ваш код пишет внутри запроса, будет нести тот же `TraceId`, что и сам запрос. В Seq можно кликнуть по любому событию и перейти к "show all events with this TraceId", чтобы получить полную цепочку вызовов одним запросом.

## Подключите корреляцию трассировок OpenTelemetry

Если вы также экспортируете трассировки через OpenTelemetry, не добавляйте отдельный экспортёр для журналов. Serilog уже понимает `Activity.Current` и автоматически записывает `TraceId` и `SpanId`, когда они есть. Нативная трассировка OpenTelemetry в ASP.NET Core 11 означает, что трассировки начинаются на входящем запросе и распространяются через `HttpClient`, EF Core и любые другие инструментированные библиотеки. Serilog подхватывает тот же контекст `Activity`, поэтому каждое событие журнала оказывается скоррелировано с трассировкой без какой-либо дополнительной настройки на стороне журналирования. Прочитайте [нативный конвейер трассировки OpenTelemetry в .NET 11](/ru/2026/04/aspnetcore-11-native-opentelemetry-tracing/) для конфигурации со стороны трассировок.

Чтобы отправлять эти трассировки в Seq, а не в отдельный бэкенд, установите `Serilog.Sinks.Seq` плюс поддержку OTLP, которая поставляется в Seq 2025.2, и направьте экспортёр OpenTelemetry на `http://localhost:5341/ingest/otlp/v1/traces`. Seq будет показывать трассировки и журналы в одном UI, объединяя их по `TraceId`.

## Уровни, сэмплирование и "нас будят зря"

Уровень `Information` по умолчанию на нагруженном API будет производить сотни событий в секунду. Объёмом управляют две ручки.

Первая это карта `MinimumLevel.Override`, показанная выше. Поднимите шумные журналы фреймворка до `Warning` и снизите поток на порядок, не теряя журналы собственного приложения. Всегда переопределяйте `Microsoft.AspNetCore` на `Warning`, как только включите `UseSerilogRequestLogging`, иначе строка на запрос будет приходить дважды: один раз от фреймворка, один раз от Serilog.

Вторая это сэмплирование. Встроенного сэмплера в Serilog нет, но сток Seq можно обернуть в предикат `Filter.ByExcluding`, чтобы отбрасывать малоценные события до того, как они покинут процесс:

```csharp
// .NET 11, C# 14: drop /health probe noise
.Filter.ByExcluding(le =>
    le.Properties.TryGetValue("RequestPath", out var p) &&
    p is ScalarValue { Value: string path } &&
    path.StartsWith("/health", StringComparison.OrdinalIgnoreCase))
```

Для трафика большого объёма лучшим ответом будет оставить `Information` для журнала запросов и поднять всё остальное до `Warning`, а затем использовать функцию "signal" в Seq, чтобы пометить ту небольшую долю, по которой действительно нужно поднимать алерты.

## Продакшн-нюансы

Несколько проблем настигают каждую команду, которая впервые отправляет в продакшн Serilog плюс Seq.

**Пакетная отправка стока скрывает простои.** `Serilog.Sinks.Seq` буферизует события до 2 секунд или 1000 событий перед сбросом. Если Seq недоступен, сток повторяет попытки с экспоненциальной задержкой, но буфер ограничен. При длительном простое Seq вы будете молча терять события. В продакшн-развёртываниях нужно задавать `bufferBaseFilename`, чтобы сток сначала сбрасывал на диск и переигрывал, когда Seq возвращается в строй:

```json
{
  "Name": "Seq",
  "Args": {
    "serverUrl": "https://seq.internal",
    "apiKey": "...",
    "bufferBaseFilename": "/var/log/myapp/seq-buffer"
  }
}
```

**Синхронные вызовы в сток Seq не бесплатны.** Хотя сток асинхронный, вызов `LogInformation` выполняет работу на вызывающем потоке, чтобы отрендерить шаблон сообщения и положить его в канал. На горячем пути это видно в профилях. Используйте `Async` ([`Serilog.Sinks.Async`](https://github.com/serilog/serilog-sinks-async)), чтобы обернуть сток Seq в выделенный фоновый поток, и поток запроса будет возвращаться мгновенно.

**API-ключи в `appsettings.json` это утечка, ждущая своего часа.** Перенесите их в user secrets в разработке и в хранилище секретов (Key Vault, AWS Secrets Manager) в продакшне. Serilog читает любого провайдера конфигурации, который зарегистрирует хост, поэтому единственное, что вы меняете, это откуда берётся значение.

**Хранение в Seq не бесконечно.** Том Docker `seq-data` по умолчанию растёт, пока диск не заполнится, и тогда Seq начнёт отбрасывать приёмные данные. Настройте политики хранения в UI Seq в разделе "Settings", "Data". Хорошая стартовая точка это 30 дней для `Information` и 90 дней для `Warning` и выше.

**`UseSerilogRequestLogging` должен идти до `UseEndpoints` и после `UseRouting`.** Если разместить его раньше, он не увидит сопоставленную конечную точку, и `RequestPath` будет содержать сырой URL вместо шаблона маршрута, что делает дашборды Seq гораздо менее полезными.

## Где это место в вашем стеке

Serilog плюс Seq это нога журналов в трёхногом стеке наблюдаемости: журналы (Serilog/Seq), трассировки (OpenTelemetry) и исключения ([глобальные обработчики исключений](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)). Когда в продакшн-API что-то идёт не так, вы начинаете в Seq, находите упавший запрос, копируете `TraceId` и переходите либо в просмотр трассировки, либо к исходному коду, который выбросил исключение. Этот круговой маршрут и есть весь смысл. Если вы не можете пройти его меньше чем за минуту, ваше журналирование не отрабатывает свою работу.

Если вы выслеживаете конкретное замедление, а не ошибку времени выполнения, продолжайте с [циклом профилирования через `dotnet-trace`](/ru/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/). Seq отлично отвечает на "что произошло", `dotnet-trace` подходящий инструмент для "почему это медленно". А если ответом окажется "мы сериализуем слишком много на запрос", руководство по [пользовательскому JsonConverter](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) покрывает сторону System.Text.Json.

Ссылки на источники:

- [Serilog.AspNetCore release notes](https://github.com/serilog/serilog-aspnetcore/releases)
- [Serilog.Sinks.Seq on NuGet](https://www.nuget.org/packages/Serilog.Sinks.Seq/)
- [Seq documentation](https://docs.datalust.co/docs)
- [Datalust seq-extensions-logging](https://github.com/datalust/seq-extensions-logging)
