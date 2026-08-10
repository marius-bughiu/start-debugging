---
title: "Как переопределить обработчик отказоустойчивости, который регистрирует Aspire"
description: "AddServiceDefaults в Aspire применяет стандартный обработчик отказоустойчивости к каждому HttpClient. Повторный вызов AddStandardResilienceHandler не заменяет его, а добавляет второй обработчик поверх первого. Здесь разобраны три реальных способа переопределения, недокументированное имя настроек -standard и бесконечный тайм-аут, который вы получаете, если просто удалить обработчик."
pubDate: 2026-08-10
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "resilience"
  - "polly"
  - "how-to"
lang: "ru"
translationOf: "2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers"
translatedBy: "claude"
translationDate: 2026-08-10
---

Метод `AddServiceDefaults()` в Aspire вызывает `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())`, из-за чего перед каждым `HttpClient` в процессе оказываются повторные попытки, circuit breaker, ограничитель частоты запросов и общий тайм-аут запроса в 30 секунд. Повторный вызов `AddStandardResilienceHandler()` для отдельного клиента это не заменяет. Он добавляет второй обработчик поверх первого, так что один логический запрос может превратиться в шестнадцать физических. Есть ровно три способа действительно переопределить значение по умолчанию: отредактировать `ServiceDefaults/Extensions.cs`, если этот проект принадлежит вам, вызвать `RemoveAllResilienceHandlers()` на конкретном `IHttpClientBuilder` перед добавлением своего обработчика или перенастроить именованный экземпляр настроек, который читает стандартный обработчик и который буквально называется `-standard`.

Каждое описанное ниже поведение проверено запуском кода, а не чтением документации. Тестовый проект нацелен на `net10.0`, SDK 10.0.201 и `Microsoft.Extensions.Http.Resilience` 10.8.0, и именно этот пакет подтягивает шаблон ServiceDefaults из Aspire 13.4.6. Логика отказоустойчивости живёт в этом пакете, а не в самом Aspire, поэтому те же правила действуют для любого приложения с `IHttpClientFactory`, которое использует `ConfigureHttpClientDefaults`.

## Что AddServiceDefaults на самом деле ставит перед вашим HttpClient

Сгенерированный файл `ServiceDefaults/Extensions.cs` содержит следующее:

```csharp
// Aspire 13.4.6 ServiceDefaults template
public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder)
    where TBuilder : IHostApplicationBuilder
{
    builder.ConfigureOpenTelemetry();
    builder.AddDefaultHealthChecks();
    builder.Services.AddServiceDiscovery();

    builder.Services.ConfigureHttpClientDefaults(http =>
    {
        // Turn on resilience by default
        http.AddStandardResilienceHandler();

        // Turn on service discovery by default
        http.AddServiceDiscovery();
    });

    return builder;
}
```

`AddStandardResilienceHandler()` собирает пять стратегий Polly v8, от внешней к внутренней: ограничитель частоты (1000 разрешений, очередь 0), общий тайм-аут запроса в 30 секунд, стратегию повторов (3 повтора, экспоненциальный backoff с джиттером, базовая задержка 2 секунды), circuit breaker (доля отказов 10 процентов, минимальная пропускная способность 100, окно выборки 30 секунд, размыкание на 5 секунд) и тайм-аут отдельной попытки в 10 секунд. Повторы и размыкание цепи срабатывают на HTTP 5xx, 408, 429, `HttpRequestException` и `TimeoutRejectedException` из Polly.

В этом методе есть ещё одна строка, которая важнее любого из значений по умолчанию:

```csharp
// ResilienceHttpClientBuilderExtensions.StandardResilience.cs, dotnet/extensions
// Disable the HttpClient timeout to allow the timeout strategies to control the timeout.
_ = builder.ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan);
```

Добавление стандартного обработчика полностью отключает `HttpClient.Timeout` и передаёт управление тайм-аутами стратегиям Polly. Запомните это, потому что этот эффект переживает удаление обработчика. Я вернусь к нему в разделе о подводных камнях.

## Почему второй обработчик не заменяет первый

Интуиция, что регистрация для отдельного клиента переопределяет регистрацию значений по умолчанию, здесь не работает. И `ConfigureHttpClientDefaults`, и `AddHttpClient(name)` пишут в один и тот же упорядоченный список `HttpClientFactoryOptions.HttpMessageHandlerBuilderActions`, а `AddStandardResilienceHandler` в итоге вызывает `AddHttpMessageHandler`, который добавляет элемент в конец. Никакой дедупликации не происходит.

Я зарегистрировал блок значений по умолчанию, затем обработчик для конкретного клиента и прошёл по построенной цепочке обработчиков через `IHttpMessageHandlerFactory.CreateHandler`:

```text
A stacked: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
           -> ResilienceHandler -> ResilienceHandler
           -> LoggingHttpMessageHandler -> SocketsHttpHandler
```

Два экземпляра `ResilienceHandler`. Это не косметический дубликат. Внешняя стратегия повторов даёт до 4 попыток, и каждая из них проходит через внутреннюю стратегию повторов, которая даёт свои 4, так что один вызов из вашего кода может превратиться в 16 запросов к той самой зависимости, которую вы пытались защитить. Оба ограничителя частоты списывают по разрешению, а два circuit breaker наблюдают разные срезы одного и того же трафика. В рамках всё это удерживает только внешний общий тайм-аут в 30 секунд. В результате вы получаете запрос, падающий через 30 секунд после того, как он завалил нижестоящий сервис, вместо настроенного поведения, которое вы рассчитывали получить.

То же самое произойдёт, если вы сами вызовете `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())` в `Program.cs` поверх `AddServiceDefaults()`. Я проверил: цепочка показывает два обработчика у каждого клиента в процессе.

## Шаги для переопределения без наслоения обработчиков

1. **Определите область действия.** Если новые настройки должны применяться ко всем исходящим вызовам сервиса, меняйте `ServiceDefaults/Extensions.cs`. Если медленная или неидемпотентная только одна зависимость, делайте это для конкретного клиента и не трогайте значения по умолчанию.
2. **Сначала удалить, потом добавить.** На нужном `IHttpClientBuilder` сначала вызовите `RemoveAllResilienceHandlers()`, затем `AddStandardResilienceHandler(...)`. Порядок регистрации внутри одного builder определяет результат.
3. **Подавите `EXTEXP0001`.** `RemoveAllResilienceHandlers` помечен атрибутом `[Experimental]`, и диагностика выдаётся как ошибка, а не как предупреждение, поэтому без `#pragma warning disable` или записи `NoWarn` сборка не пройдёт.
4. **Держите тайм-ауты согласованными.** `TotalRequestTimeout` должен быть больше `AttemptTimeout`, а `CircuitBreaker.SamplingDuration` должен быть минимум вдвое больше `AttemptTimeout`, иначе хост выбросит исключение при старте.
5. **Проверяйте цепочку, а не намерение.** Разрешите `IHttpMessageHandlerFactory` в тесте и посчитайте экземпляры `ResilienceHandler` в построенном конвейере.

## Изменение для всего сервиса в ServiceDefaults

Если проект `ServiceDefaults` ваш, правка этого блока и есть честное решение. Microsoft поставляет ровно такую форму в шаблоне чата `Microsoft.Extensions.AI`, где эндпоинт Ollama регулярно отвечает минутами и тайм-аут попытки в 10 секунд убивал бы каждый запрос:

```csharp
// Microsoft.Extensions.Http.Resilience 10.8.0, .NET 10
public static IServiceCollection AddOllamaResilienceHandler(this IServiceCollection services)
{
    services.ConfigureHttpClientDefaults(http =>
    {
#pragma warning disable EXTEXP0001 // RemoveAllResilienceHandlers is experimental
        http.RemoveAllResilienceHandlers();
#pragma warning restore EXTEXP0001

        http.AddStandardResilienceHandler(config =>
        {
            config.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);

            // Must be at least double the AttemptTimeout to pass options validation
            config.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
            config.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        });
    });

    return services;
}
```

Обратите внимание: это второй блок `ConfigureHttpClientDefaults`, вызываемый после `AddServiceDefaults()`. Удаление выполняется раньше повторного добавления, потому что действия выполняются в порядке регистрации, так что в итоге остаётся один обработчик с вашими настройками. Шаблон также заново добавляет `AddServiceDiscovery()` внутри этого блока, что излишне: `RemoveAllResilienceHandlers` удаляет только обработчики типа `ResilienceHandler`, а повторное добавление service discovery даёт вам два обработчика service discovery.

## Переопределение одного клиента без правки ServiceDefaults

Это как раз тот случай, который встречается на практике: одна зависимость медленная, либо один эндпоинт принимает `POST`, который нельзя повторять, а остальной сервис должен сохранить значения по умолчанию от Aspire.

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.8.0
builder.AddServiceDefaults();

builder.Services.AddHttpClient("reports", client =>
    {
        client.BaseAddress = new Uri("https+http://reporting");
    })
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(o =>
    {
        o.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);
        o.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
        o.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        o.Retry.DisableForUnsafeHttpMethods();
    });
```

Здесь есть две неочевидные детали.

Первая: порядок вызовов `AddServiceDefaults()` и `AddHttpClient(...)` не имеет значения. `ConfigureHttpClientDefaults` вставляет свои регистрации в отслеживаемую позицию коллекции сервисов, чтобы значения по умолчанию всегда выполнялись до конфигурации именованных клиентов. Я зарегистрировал именованный клиент первым, а блок значений по умолчанию вторым, и клиент `reports` всё равно получил ровно один `ResilienceHandler` с трёхминутным тайм-аутом попытки, тогда как посторонний клиент сохранил стандартные 10 секунд. А вот внутри одной цепочки builder порядок важен: поставьте `RemoveAllResilienceHandlers()` после `AddStandardResilienceHandler()` для того же клиента, и получите клиент вообще без отказоустойчивости.

Вторая: `DisableForUnsafeHttpMethods()` отключает повторы для `POST`, `PATCH`, `PUT`, `DELETE` и `CONNECT`. Стандартный обработчик по умолчанию повторяет все методы, а это готовая ошибка с дублированием данных на неидемпотентном эндпоинте. `DisableFor(HttpMethod.Post, HttpMethod.Delete)` даёт более узкий вариант.

## Недокументированное имя настроек: `-standard`

`AddStandardResilienceHandler` не использует экземпляр настроек по умолчанию. Он вычисляет имя настроек как `$"{httpClientName}-{pipelineIdentifier}"` с идентификатором `standard`, а затем читает этот именованный экземпляр через `IOptionsMonitor<HttpStandardResilienceOptions>`. Для клиента с именем `slow` имя настроек будет `slow-standard`. Внутри `ConfigureHttpClientDefaults` свойство `Name` у builder равно null, поэтому интерполяция строки даёт `-standard`, с ведущим дефисом и пустотой перед ним.

У этого есть острый край. Вызов `Configure<HttpStandardResilienceOptions>`, который выглядит правильным, не делает ничего:

```csharp
builder.Services.ConfigureHttpClientDefaults(h => h.AddStandardResilienceHandler());
builder.Services.Configure<HttpStandardResilienceOptions>(o => o.Retry.MaxRetryAttempts = 9);
```

```text
options[''].MaxRetryAttempts          = 9
options['-standard'].MaxRetryAttempts = 3
```

Ваше значение попадает в безымянный экземпляр, который ни один обработчик никогда не читает, а обработчик сохраняет значение по умолчанию 3. Ни исключения, ни записи в журнале. Если вы когда-нибудь "настраивали" отказоустойчивость и наблюдали нулевой эффект, причина почти наверняка в этом. Это же объясняет, почему стандартный обработчик невосприимчив к обычному `Configure`, хотя `HttpStandardResilienceOptions` является самым обычным классом настроек. [Разница между интерфейсами доступа к настройкам](/ru/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) здесь ни при чём; дело в имени.

Знание имени даёт третий способ переопределения, полезный, когда `ServiceDefaults` править нельзя (общий пакет, чужой шаблон), а перечислять каждый клиент не хочется:

```csharp
// Retunes the handler that AddServiceDefaults already registered.
builder.Services.Configure<HttpStandardResilienceOptions>("-standard", o =>
{
    o.AttemptTimeout.Timeout = TimeSpan.FromSeconds(20);
    o.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(60);
    o.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(90);
});
```

На старте это разрешается в `attempt=00:00:20 total=00:01:30`, и в цепочке остаётся один обработчик. Это строковый литерал, привязанный к детали реализации, поэтому оставьте рядом комментарий, но работает он корректно и наслоения не создаёт.

Для настроек отдельного клиента, которым место в конфигурации, а не в коде, привяжите секцию. `AddStandardResilienceHandler(IConfigurationSection)` это реальная перегрузка, которая перенаправляет в `.Configure(section)` на правильно именованном экземпляре настроек:

```json
{
  "Resilience": {
    "Slow": {
      "AttemptTimeout": { "Timeout": "00:03:00" },
      "TotalRequestTimeout": { "Timeout": "00:10:00" },
      "CircuitBreaker": { "SamplingDuration": "00:10:00" },
      "Retry": { "MaxRetryAttempts": 2 }
    }
  }
}
```

```csharp
builder.Services.AddHttpClient("slow")
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(builder.Configuration.GetSection("Resilience:Slow"));
```

Привязанные значения приходят ровно такими, как записаны, а поскольку стандартный обработчик вызывает `context.EnableReloads`, правка этих значений в `appsettings.json` пересобирает конвейер без перезапуска.

## Подводные камни, которые больно бьют

**Некорректные тайм-ауты падают на старте, а не на первом запросе.** Оба валидатора регистрируются через `AddOptionsWithValidateOnStart`, поэтому несогласованность выбрасывает исключение при запуске хоста. Если задать только `AttemptTimeout` в 3 минуты и не трогать остальное, получится вот это:

```text
Microsoft.Extensions.Options.OptionsValidationException: Total request timeout resilience
strategy must have a greater timeout than the attempt resilience strategy. Total Request
Timeout: 30s, Attempt Timeout: 180s; The sampling duration of circuit breaker strategy needs
to be at least double of an attempt timeout strategy’s timeout interval, in order to be
effective. Sampling Duration: 30s,Attempt Timeout: 180s
```

Правило удвоения задано жёстко зашитым множителем 2 в `HttpStandardResilienceOptionsCustomValidator`. Повышение `AttemptTimeout` всегда означает повышение и `TotalRequestTimeout`, и `CircuitBreaker.SamplingDuration`. Если вам нужна такая же проверка для собственных настроек, тот же механизм доступен через [проверку настроек при старте с `IValidateOptions<T>`](/ru/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/).

**Удаление обработчика оставляет вас вообще без тайм-аута.** Это худший из случаев. `RemoveAllResilienceHandlers()` убирает экземпляры `ResilienceHandler`, но не отменяет `ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan)`, который зарегистрировал `AddStandardResilienceHandler`. Клиент, собранный как `AddHttpClient("bare").RemoveAllResilienceHandlers()` и без замены, даёт:

```text
bare client chain:   LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
                     -> LoggingHttpMessageHandler -> SocketsHttpHandler
HttpClient('bare').Timeout = -00:00:00.0010000
```

Эта отрицательная миллисекунда и есть `Timeout.InfiniteTimeSpan`. Ни обработчика отказоустойчивости, ни стандартных 100 секунд у `HttpClient`, вообще никакого тайм-аута. Зависшая зависимость теперь держит пул потоков запросов, пока не сработает токен отмены, который вы, надеюсь, передали. Если вы удаляете обработчик и не добавляете новый, задайте `client.Timeout` явно. Смежный сценарий, где тайм-аут всё-таки срабатывает, разобран в статье о том, [почему HttpClient выбрасывает TaskCanceledException](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

**Удаление ограничено типом, а не цепочкой.** Реализация проходит по дополнительным обработчикам в обратном порядке и убирает только те, для которых верно `is ResilienceHandler`. Собственные типы `DelegatingHandler`, обработчики аутентификации и обработчик service discovery остаются на месте. Я подтвердил это маркерным обработчиком, зарегистрированным в блоке значений по умолчанию: после `RemoveAllResilienceHandlers()` на именованном клиенте маркер всё ещё там. Так что не добавляйте service discovery повторно после удаления.

**Клиентам gRPC нужен `Grpc.Net.ClientFactory` 2.64.0 или новее.** Сочетание стандартного обработчика со старым `AddGrpcClient` выбрасывает `System.InvalidOperationException: The ConfigureHttpClient method isn't supported when creating gRPC clients`. Для этого есть проверка на этапе сборки, подавляемая через `<SuppressCheckGrpcNetClientFactoryVersion>`.

**`RemoveAllResilienceHandlers` экспериментален.** `EXTEXP0001` выдаётся анализатором в `Microsoft.Extensions.Http.Resilience` 10.8.0 именно как ошибка, поэтому pragma обязательна, а не желательна. Форма API стабильна с версии 9.0, но аннотация означает, что команда оставляет за собой право её изменить.

Правило, которое покрывает всё перечисленное: обработчик отказоустойчивости это обработчик сообщений, а обработчики сообщений композируются, а не заменяют друг друга. Как только это усвоено, вопрос "как переопределить значение по умолчанию от Aspire" перестаёт быть загадкой и превращается в "удалить, затем добавить, именно в этом порядке и на нужном builder".

## Связанные статьи

- [Polly против обработчиков отказоустойчивости в .NET 11](/ru/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) объясняет, на каком уровне вообще стоит настраивать отказоустойчивость.
- [Добавление Aspire в существующее решение ASP.NET Core](/ru/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) описывает, что ещё включает `AddServiceDefaults()`.
- [HttpClient против HttpClientFactory и Refit](/ru/2026/05/httpclient-vs-httpclientfactory-vs-refit/) о том, как вообще строится цепочка обработчиков.
- [IOptions против IOptionsSnapshot и IOptionsMonitor в .NET 11](/ru/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) о мониторе, через который стандартный обработчик читает свои именованные настройки.
- [Aspire против Docker Compose для локальной разработки нескольких сервисов](/ru/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/), если вы ещё решаете, стоит ли брать Aspire.

## Источники

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) на MS Learn, откуда взяты таблица значений по умолчанию стандартного обработчика и известные проблемы.
- [`ResilienceHttpClientBuilderExtensions.StandardResilience.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHttpClientBuilderExtensions.StandardResilience.cs) в dotnet/extensions, откуда взяты имя настроек и бесконечный тайм-аут клиента.
- [`HttpStandardResilienceOptionsCustomValidator.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/Internal/Validators/HttpStandardResilienceOptionsCustomValidator.cs), откуда взяты точные правила проверки и тексты сообщений.
- [`OllamaResilienceHandlerExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/ProjectTemplates/Microsoft.Extensions.AI.Templates/templates/AIChatWeb-CSharp/AIChatWeb-CSharp.Web/OllamaResilienceHandlerExtensions.cs), собственное переопределение стандарта Aspire от Microsoft.
- [Aspire service defaults](https://aspire.dev/get-started/csharp-service-defaults/), исходный код сгенерированного `AddServiceDefaults`.
