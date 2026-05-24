---
title: "Polly против resilience handlers в .NET 11: что выбрать?"
description: "Используйте resilience handler из Microsoft.Extensions.Http.Resilience для вызовов через HttpClient, потому что это Polly с понимающими HTTP значениями по умолчанию и телеметрией в одну строку. Обращайтесь к ResiliencePipeline из Polly напрямую только тогда, когда защищаете нечто, не являющееся HttpClient."
pubDate: 2026-05-24
tags:
  - "comparison"
  - "polly"
  - "resilience"
  - "httpclient"
  - "dotnet"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/05/polly-vs-resilience-handlers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-24
---

Формулировка "Polly против resilience handlers" слегка неверна, и понять почему -- это и есть весь ответ. Resilience handler, `AddStandardResilienceHandler` из пакета `Microsoft.Extensions.Http.Resilience`, не является альтернативой Polly. Это Polly, обёрнутый в понимающий HTTP и дружественный к внедрению зависимостей слой, который напрямую подключается к `IHttpClientFactory`. Поэтому настоящий вопрос не в том, "какая библиотека", а в том, "на каком слое я настраиваю устойчивость". Для нового кода на .NET 11 в 2026 году: если то, что вы защищаете, является вызовом через `HttpClient`, используйте resilience handler, потому что он даёт вам стратегии Polly с понимающими HTTP значениями по умолчанию, телеметрией и привязкой конфигурации в одну строку. Обращайтесь к API `ResiliencePipeline` из Polly напрямую только тогда, когда операция не является запросом через `HttpClient`: запрос к базе данных, публикация в брокер сообщений, вручную вызываемый вызов gRPC или произвольный делегат.

Все примеры здесь нацелены на `<TargetFramework>net11.0</TargetFramework>` с .NET 11 SDK и C# 14. "Polly" означает Polly v8 (пакет `Polly.Core`, 8.6.6 на NuGet), чьё API `ResiliencePipeline` заменило старые типы `Policy`. "Resilience handler" означает `Microsoft.Extensions.Http.Resilience` 10.6.0, который зависит от `Microsoft.Extensions.Resilience` и от Polly. Оба они -- один и тот же движок, рассматриваемый с двух высот.

## Таблица возможностей с первого взгляда

Это та таблица, ради которой вы пришли. Колонки -- это два способа, которыми вы фактически подключаете устойчивость, а строки -- это решения, которые меняют, какой из них вы выбираете.

| Аспект | Polly `ResiliencePipeline` | Resilience handler (`Microsoft.Extensions.Http.Resilience`) |
| ------- | ------------------------- | ---------------------------------------------------------- |
| Что оборачивает | Любой делегат или операцию | Только запросы через `HttpClient` |
| Построен на | `Polly.Core` (движок) | `Polly.Core`, обёрнутый |
| Как выполняется | Вы явно вызываете `pipeline.ExecuteAsync(...)` | Прозрачно, внутри конвейера `HttpMessageHandler` |
| Понимающие HTTP значения по умолчанию (5xx, 408, 429) | Вы пишете `ShouldHandle` сами | Встроено |
| Разумный конвейер по умолчанию в одну строку | Нет, вы собираете его | Да, `AddStandardResilienceHandler()` |
| Телеметрия (метрики + трассировки) | Через `Microsoft.Extensions.Resilience` или вручную | Встроено |
| Привязка конфигурации + горячая перезагрузка | Вручную | Первоклассная (`EnableReloads`) |
| Интеграция с внедрением зависимостей | `ResiliencePipelineRegistry<TKey>` | `IHttpClientBuilder` |
| Пакет NuGet | `Polly.Core` 8.6.6 | `Microsoft.Extensions.Http.Resilience` 10.6.0 |
| Лучше всего для | Вызовы к БД, очереди, gRPC, произвольный код | Именованные или типизированные вызовы через `HttpClient` |

Закономерность в таблице в том, что resilience handler -- это правая колонка, которая наследует движок слева и добавляет сверху знание HTTP, телеметрию и подключение к внедрению зависимостей. Цена движения вправо в том, что вы отказываетесь от универсальности: handler выполняется только против `HttpClient`.

## Почему resilience handler -- это просто Polly в форме

Когда вы вызываете `AddStandardResilienceHandler`, пакет строит `ResiliencePipeline<HttpResponseMessage>` из Polly и устанавливает его как `DelegatingHandler` в конвейер обработчиков сообщений, который `IHttpClientFactory` собирает для этого клиента. Каждая повторная попытка, каждое срабатывание circuit breaker, каждый тайм-аут выполняется `Polly.Core`. В .NET нет второго движка устойчивости. Microsoft не переписывала повторные попытки заново; она взяла Polly v8, дала ему настроенные под HTTP значения по умолчанию, подключила его к системе параметров и выдала вокруг него совместимые с OpenTelemetry метрики и трассировки.

Вот почему "следует ли мне использовать Polly или resilience handler?" -- это ошибка категории для HTTP-кода. Использовать handler -- значит использовать Polly. Решение в том, хотите ли вы удобный слой в форме HTTP или вам нужен сырой движок, потому что ваша операция не является HTTP.

## Когда resilience handler -- правильный выбор

Для любой устойчивости, которая лежит на `HttpClient`, разрешённом через `IHttpClientFactory`, handler побеждает. Стандартный handler -- это одна строка поверх типизированного клиента:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // rate limiter, total timeout, retry, breaker, attempt timeout
```

Этот один вызов складывает пять стратегий с понимающими HTTP значениями по умолчанию: он уже знает, что HTTP 500+, 408 и 429 являются временными, что `HttpRequestException` и `TimeoutRejectedException` из Polly следует повторять, и что заголовок `Retry-After` следует учитывать. Вы не писали предикат `ShouldHandle` ни для чего из этого. Это современная замена ручному подключению политик Polly к клиенту, и это правильное значение по умолчанию почти для всего серверного HTTP-кода.

Когда значения по умолчанию не совсем подходят, вы не спускаетесь к сырому Polly. Вы остаётесь в слое handler и настраиваете, потому что handler предоставляет те же параметры Polly через специфичные для HTTP типы параметров. Используйте `AddResilienceHandler`, чтобы построить именованный, полностью настраиваемый конвейер:

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

httpClientBuilder.AddResilienceHandler("CustomPipeline", static builder =>
{
    builder.AddRetry(new HttpRetryStrategyOptions
    {
        BackoffType = DelayBackoffType.Exponential,
        MaxRetryAttempts = 5,
        UseJitter = true
    });

    builder.AddCircuitBreaker(new HttpCircuitBreakerStrategyOptions
    {
        SamplingDuration = TimeSpan.FromSeconds(10),
        FailureRatio = 0.2,
        MinimumThroughput = 3,
        ShouldHandle = static args => ValueTask.FromResult(args is
        {
            Outcome.Result.StatusCode:
                HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
        })
    });

    builder.AddTimeout(TimeSpan.FromSeconds(5));
});
```

Обратите внимание на типы: `HttpRetryStrategyOptions` и `HttpCircuitBreakerStrategyOptions`. Это версии с привкусом HTTP типов `RetryStrategyOptions<T>` и `CircuitBreakerStrategyOptions<T>` из Polly, несущие удобства вроде `DisableForUnsafeHttpMethods()`, которые имеют смысл только для HTTP. Вы по-прежнему в Polly, просто в той части Polly, которая понимает `HttpResponseMessage`.

Handler также привязывается к конфигурации и перезагружается во время выполнения. Привяжите `HttpStandardResilienceOptions` к секции `appsettings.json`, вызовите `EnableReloads` внутри перегрузки `AddResilienceHandler`, которая предоставляет `ResilienceHandlerContext`, и изменение JSON перенастроит живой конвейер без перезапуска. Эту обвязку не бесплатно писать вручную против сырого Polly, и handler даёт её вам.

## Что на самом деле настраивает стандартный handler

Читатели приходят к этому сравнению, потому что хотят знать, что делает `AddStandardResilienceHandler`, прежде чем довериться ему. Конфигурация по умолчанию связывает в цепочку пять стратегий, от самой внешней до самой внутренней. Числа ниже -- это значения по умолчанию .NET 11 / `Microsoft.Extensions.Http.Resilience` 10.6.0:

| Порядок | Стратегия | По умолчанию |
| ----- | -------- | ------- |
| 1 | Rate limiter | Permit: `1_000`, Queue: `0` |
| 2 | Общий тайм-аут запроса | 30s на все попытки |
| 3 | Retry | Макс. попыток: `3`, экспоненциальный backoff, jitter включён, базовая задержка 2s |
| 4 | Circuit breaker | Доля отказов: 10%, мин. пропускная способность: `100`, выборка 30s, размыкание 5s |
| 5 | Тайм-аут на попытку | 10s на отдельную попытку |

Порядок имеет значение. Общий тайм-аут (30s) располагается снаружи повторных попыток, поэтому три повторные попытки, каждая из которых достигает тайм-аута на попытку в 10s, не могут выполняться вечно: вся операция ограничена 30s. Circuit breaker располагается внутри retry, поэтому он считает отказы отдельных попыток, и как только 10% из не менее чем 100 выбранных вызовов терпят неудачу в течение 30s, он размыкается на 5s и замыкает накоротко всё, что ниже. Если запомнить только одно о значениях по умолчанию: повторные попытки ограничены реальным временем в 30s, а не только числом.

## Когда обращаться к Polly напрямую

Handler перестаёт быть вариантом в тот момент, когда то, что вы защищаете, не является вызовом через `HttpClient`. Нет `AddStandardResilienceHandler` для запроса к базе данных, `ServiceBusSender.SendMessageAsync`, вызова к Redis или блока бизнес-логики, который иногда выбрасывает исключение. Для них вы строите `ResiliencePipeline` из Polly и вызываете его явно:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - resilience around a non-HTTP operation
using Polly;
using Polly.Retry;

ResiliencePipeline pipeline = new ResiliencePipelineBuilder()
    .AddRetry(new RetryStrategyOptions
    {
        MaxRetryAttempts = 3,
        BackoffType = DelayBackoffType.Exponential,
        UseJitter = true,
        // Only retry the transient failures this dependency actually throws
        ShouldHandle = new PredicateBuilder().Handle<TimeoutException>()
    })
    .AddTimeout(TimeSpan.FromSeconds(5))
    .Build();

await pipeline.ExecuteAsync(
    async token => await SaveOrderAsync(order, token),
    cancellationToken);
```

Форма -- это тот же движок, который вы видели внутри handler: `AddRetry`, `AddTimeout`, `AddCircuitBreaker`, тот же `DelayBackoffType` и `ShouldHandle`. Меняется то, что вы сами вызываете `ExecuteAsync`, сами выбираете, что считается временным отказом (здесь `TimeoutException`, потому что нет HTTP-кода состояния для проверки), и конвейер может обернуть буквально любой делегат.

Для типизированных результатов используйте обобщённый builder, чтобы конвейер мог рассуждать о возвращаемом значении, а не только об исключениях:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - a pipeline that inspects the result
using Polly;

ResiliencePipeline<DbResult> pipeline = new ResiliencePipelineBuilder<DbResult>()
    .AddRetry(new()
    {
        MaxRetryAttempts = 3,
        ShouldHandle = static args => ValueTask.FromResult(
            args.Outcome.Result is { Status: DbStatus.Throttled })
    })
    .Build();

DbResult result = await pipeline.ExecuteAsync(
    async token => await QueryAsync(token),
    cancellationToken);
```

В приложении с внедрением зависимостей вы не создаёте конвейеры в местах вызова. Вы регистрируете их один раз через `AddResiliencePipeline`, и они попадают в `ResiliencePipelineRegistry<TKey>`, чтобы вы могли разрешать их где угодно через `ResiliencePipelineProvider<TKey>`:

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - register once, resolve anywhere
using Microsoft.Extensions.DependencyInjection;
using Polly;
using Polly.Registry;

builder.Services.AddResiliencePipeline("db-writes", static b =>
{
    b.AddRetry(new()).AddTimeout(TimeSpan.FromSeconds(5));
});

// elsewhere, injected ResiliencePipelineProvider<string> provider
ResiliencePipeline pipeline = provider.GetPipeline("db-writes");
await pipeline.ExecuteAsync(static async ct => await DoWorkAsync(ct), ct);
```

Если вы также подключите `Microsoft.Extensions.Resilience`, эти зарегистрированные конвейеры получат ту же обработку телеметрии, которой наслаждается HTTP-handler, так что конвейер, не являющийся HTTP, всё равно может выдавать метрики и трассировки. Это наиболее близкое к "опыту handler" для кода, не являющегося HTTP, и правильный инструмент, когда вы хотите устойчивости вокруг вашего слоя данных или обмена сообщениями, а не вашего исходящего HTTP.

## Один быстрее другого?

Нет, и сам вопрос выдаёт заблуждение. Поскольку resilience handler выполняет `ResiliencePipeline` из Polly под капотом, накладные расходы на вызов "handler" и "сырого Polly" -- это один и тот же движок, выполняющий одни и те же стратегии. Нет налога Polly, которого вы избегаете, собирая конвейер вручную, и нет налога handler, который вы платите за удобство. Polly v8 был специально переписан, чтобы сократить выделения памяти по сравнению с v7, и обе точки входа опираются на эту переработку.

Различается не пропускная способность, а то, что вы получаете вокруг выполнения: handler бесплатно добавляет телеметрию, привязку конфигурации и гарантии времени жизни `IHttpClientFactory`, тогда как сырой конвейер даёт вам это, только если вы их подключите. Если вы хотите реальное число для своей рабочей нагрузки, запустите BenchmarkDotNet против собственного делегата с конвейером и без него; не выбирайте между этими двумя на основе производительности, потому что производительность не является осью, которая их разделяет.

## Деталь, которая решает за вас

Несколько жёстких ограничений улаживают выбор прежде, чем в дело вступает предпочтение.

**Handler работает только на `HttpClient` через `IHttpClientFactory`.** Если ваш код не проходит через `AddHttpClient` и внедрённый клиент, добавлять handler некуда. Статический одиночный `HttpClient`, `DbContext`, производитель Kafka: ни один из них не может принять resilience handler. Они принимают конвейер Polly или ничего. Этот единственный факт решает большинство реальных случаев.

**Не складывайте resilience handlers.** Руководство Microsoft однозначно: добавляйте ровно один resilience handler на клиент. Если вам нужна другая форма, сначала вызовите `RemoveAllResilienceHandlers()`, а затем добавьте свой собственный. Складывание стандартного handler и пользовательского вкладывает два полных конвейера и создаёт счётчики повторных попыток и тайм-ауты, которые перемножаются способами, которых никто не намеревался.

**Повторные попытки с неидемпотентными глаголами дублируют данные.** Стандартный handler по умолчанию повторяет каждый HTTP-метод. Повторённый `POST`, который уже достиг сервера, может вставить одну и ту же запись дважды. Вызовите `options.Retry.DisableForUnsafeHttpMethods()`, чтобы пропустить повторные попытки для `POST`, `PATCH`, `PUT`, `DELETE` и `CONNECT`, или `DisableFor(HttpMethod.Post, ...)` для конкретного списка. Это забота слоя handler, с которой сырой Polly не может помочь, потому что сырой Polly не знает, что такое HTTP-глагол.

**Polly выбрасывает `TimeoutRejectedException`, а не `TimeoutException`.** Если вы пишете предикат `ShouldHandle` в retry и ожидаете перехватить отказ стратегии тайм-аута, помните, что он всплывает как `TimeoutRejectedException` из Polly. Неправильная обработка этого -- частый источник [TaskCanceledException о том, что задача была отменена](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/), всплывающей там, где вы ожидали повторную попытку.

## Решение, в одну строку

Для нового кода на .NET 11 в 2026 году: если вы добавляете устойчивость к `HttpClient`, разрешённому через `IHttpClientFactory`, используйте resilience handler, потому что `AddStandardResilienceHandler` -- это Polly с понимающими HTTP значениями по умолчанию, телеметрией и привязкой конфигурации в одну строку, а `AddResilienceHandler` позволяет настраивать, не покидая этот слой. Спускайтесь к API `ResiliencePipeline` из Polly напрямую только тогда, когда операция не является вызовом через `HttpClient`: доступ к базе данных, брокеры сообщений, gRPC, который вы вызываете вручную, или произвольные делегаты. Вы никогда на самом деле не выбираете между двумя библиотеками устойчивости, потому что она только одна. Вы выбираете, использовать ли Polly через дверь в форме HTTP или через дверь общего назначения, и вид операции, которую вы защищаете, выбирает дверь за вас.

## Связанное

- [HttpClient против HttpClientFactory против Refit: что выбрать в .NET 11?](/ru/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [Исправление: TaskCanceledException, задача была отменена в HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Как отменить долго выполняющуюся Task в C# без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Как использовать OpenTelemetry с .NET 11 и бесплатным бэкендом](/ru/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [Как писать модульные тесты для кода, использующего HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## Источники

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler`, `AddResilienceHandler`, значения по умолчанию стандартного конвейера и список временных результатов.
- [Introduction to resilient app development](https://learn.microsoft.com/en-us/dotnet/core/resilience/) - как `Microsoft.Extensions.Resilience` строится на Polly и добавляет телеметрию.
- [Polly docs: Resilience pipelines](https://www.pollydocs.org/pipelines/) - `ResiliencePipelineBuilder`, `ExecuteAsync` и registry.
- [Polly docs: Advanced dependency injection](https://www.pollydocs.org/advanced/dependency-injection/) - `AddResiliencePipeline`, `ResiliencePipelineRegistry` и динамические перезагрузки.
- [Polly v7 to v8 migration guide](https://www.pollydocs.org/migration-v8.html) - почему API `Policy` было заменено на `ResiliencePipeline`.
- [Microsoft.Extensions.Http.Resilience on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience) - текущая версия пакета и его зависимости.
</content>
