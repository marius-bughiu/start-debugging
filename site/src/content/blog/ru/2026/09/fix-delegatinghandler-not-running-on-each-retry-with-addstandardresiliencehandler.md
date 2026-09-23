---
title: "Исправление: собственный DelegatingHandler не запускается повторно при каждом retry с AddStandardResilienceHandler"
description: "DelegatingHandler, зарегистрированный до AddStandardResilienceHandler, выполняется один раз на логический запрос, а не на каждую повторную попытку. Перенесите его после обработчика устойчивости и сделайте идемпотентным, потому что retry повторно отправляет тот же HttpRequestMessage. Проверено на Microsoft.Extensions.Http.Resilience 10.10.0 и 8.10.0."
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "httpclient"
  - "resilience"
  - "polly"
  - "aspnetcore"
lang: "ru"
translationOf: "2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler"
translatedBy: "claude"
translationDate: 2026-09-23
---

**Коротко:** `IHttpClientFactory` строит цепочку обработчиков в порядке регистрации, и первый зарегистрированный оказывается самым внешним. Если вызвать `AddHttpMessageHandler<MyHandler>()` *до* `AddStandardResilienceHandler()`, ваш обработчик находится снаружи цикла повторов и выполняется ровно один раз, сколько бы попыток Polly ни сделал под ним. Зарегистрируйте его *после* обработчика устойчивости, и он будет выполняться на каждой попытке. Затем исправьте вторую ошибку, которую этот перенос обнажает: стандартный retry повторно отправляет **тот же самый** объект `HttpRequestMessage`, поэтому любой `request.Headers.Add(...)` в обработчике уровня попытки накапливает дублирующиеся значения, а тело `StreamContent` без поддержки перемотки выбрасывает `InvalidOperationException: The stream was already consumed` на второй попытке.

Всё, что описано ниже, измерено файловым пробным приложением на .NET 10.0.10 (SDK 10.0.302) с `Microsoft.Extensions.Http.Resilience` 10.10.0, текущей стабильной версией, и повторено на 8.10.0. Обе версии дали идентичный вывод, так что это не регрессия и не то, что изменится после обновления пакета. Так устроен конвейер.

## Почему обработчик выполняется только один раз

`AddStandardResilienceHandler` не является настройкой клиента. Это ещё один `DelegatingHandler` типа `ResilienceHandler`, добавленный в тот же упорядоченный список, в который добавляет `AddHttpMessageHandler`. Документация ASP.NET Core формулирует правило одной строкой: обработчики [можно регистрировать в том порядке, в котором они должны выполняться](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware), и каждый оборачивает следующий.

Внутри `ResilienceHandler.SendAsync` конвейер Polly выполняет callback, который вызывает `base.SendAsync(request, ...)`, то есть следующий обработчик вниз по цепочке. Когда стратегия повторов решает попробовать снова, она вызывает этот callback ещё раз. Поэтому заново выполняются только обработчики, расположенные **ниже** `ResilienceHandler`. Всё, что выше, уже один раз вызвало `base.SendAsync` и просто ждёт итогового результата.

В этом и состоит вся ошибка. В руководствах и старом коде сквозные обработчики часто регистрируют первыми, а устойчивость прикручивают в конце, потому что так естественно читается:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<SigningHandler>();

builder.Services.AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"))
    .AddHttpMessageHandler<SigningHandler>()   // outermost: runs once
    .AddStandardResilienceHandler();           // retries happen below this line
```

Если `SigningHandler` проставляет метку времени и подпись HMAC, каждая повторная попытка уходит с подписью, вычисленной для первой попытки. Если он получает короткоживущий токен, повтор после медленного ответа 503 может уйти с уже истёкшим токеном. Если он пишет в журнал "sending request", вы видите одну строку журнала на три сетевых вызова.

## Измеренная цепочка обработчиков

Я получил `IHttpMessageHandlerFactory.CreateHandler("c")` и прошёл по `InnerHandler` до первичного обработчика. Первичным была заглушка, которая дважды возвращает `503`, а затем `200`, и задержки повторов были выставлены в ноль, чтобы проба выполнялась мгновенно. `CountingHandler` записывает в журнал каждый вызов, который через него проходит.

Регистрация **до** `AddStandardResilienceHandler`:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> CountingHandler -> ResilienceHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #1 X-Attempt=[]
CountingHandler #1 <- 200
```

В сеть ушло три запроса. Обработчик выполнился один раз и увидел только итоговый `200`.

Регистрация **после** `AddStandardResilienceHandler`:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #2 <- 503
CountingHandler #3 <- 503
CountingHandler #4 <- 200
```

Теперь он выполняется на каждой попытке и видит каждый `503`. Обратите внимание, где находится собственный `LoggingHttpMessageHandler` фабрики: всегда самым внутренним, сразу над первичным обработчиком. Поэтому встроенная категория журнала `System.Net.Http.HttpClient.<name>.ClientHandler` уже показывает одну запись на попытку, а обработчик, зарегистрированный первым, показывает одну запись на вызов. Если ваши журналы и ваш обработчик расходятся в количестве запросов, причина именно в этом.

## Исправление в три шага

1. Для каждого обработчика решите, относится ли его работа к **логическому вызову** или к **каждой попытке**. Подпись, получение токена, журналирование и метрики по попыткам относятся к попытке. Ключ идемпотентности, correlation ID, который должен оставаться стабильным между повторами, и всё, что должно произойти ровно один раз, относятся к вызову.
2. Регистрируйте обработчики уровня попытки **после** `AddStandardResilienceHandler()` (или `AddResilienceHandler(...)`), а обработчики уровня вызова до него.
3. Сделайте каждый обработчик уровня попытки безопасным для многократного выполнения над одним и тем же `HttpRequestMessage`: заменяйте заголовки вместо добавления и убедитесь, что тело запроса можно прочитать больше одного раза.

Регистрация для примера с платежами становится такой:

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<IdempotencyKeyHandler>();
builder.Services.AddTransient<SigningHandler>();

var payments = builder.Services
    .AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"));

payments.AddHttpMessageHandler<IdempotencyKeyHandler>(); // once per call: same key on every retry
payments.AddStandardResilienceHandler();
payments.AddHttpMessageHandler<SigningHandler>();        // once per attempt: fresh signature
```

Сохраните `IHttpClientBuilder` в переменной. Прицепить `.AddHttpMessageHandler<T>()` к `AddStandardResilienceHandler()` нельзя, потому что тот возвращает `IHttpStandardResiliencePipelineBuilder`, а не построитель клиента. Такая попытка ломает сборку:

```text
error CS1929: 'IHttpStandardResiliencePipelineBuilder' does not contain a definition for
'AddHttpMessageHandler' and the best extension method overload
'HttpClientBuilderExtensions.AddHttpMessageHandler<SigningHandler>(IHttpClientBuilder)'
requires a receiver of type 'Microsoft.Extensions.DependencyInjection.IHttpClientBuilder'
```

Подозреваю, что именно эта ошибка компилятора и есть настоящая причина, по которой так много кода регистрирует обработчики первыми: fluent-цепочка компилируется только в неправильном порядке, поэтому устойчивость ставят последней и идут дальше. Второй вызов `AddHttpClient<PaymentsClient>()` для того же клиента тоже работает, так как возвращает построитель для того же имени, но переменная делает порядок наглядным.

С ключом идемпотентности ошибаются в обратную сторону. Если ради исправления подписи перенести *все* обработчики внутрь retry, обработчик, генерирующий `Idempotency-Key: Guid.NewGuid()`, начнёт отправлять разный ключ на каждой попытке, и сервер больше не сможет отличить повтор от нового платежа. Весь смысл ключа в том, что он остаётся неизменным между повторами, поэтому ему место снаружи цикла.

## Retry повторно отправляет тот же HttpRequestMessage

Это меня удивило. Я ожидал, что обработчик устойчивости клонирует запрос на каждую попытку. Для стандартного обработчика (с retry) это не так. Проба записывала хеш-код запроса на каждой попытке, и каждый раз это был один и тот же объект. Обработчик уровня попытки, использующий `Headers.Add`, в итоге даёт вот что:

```text
chain: ... -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
CountingHandler #5 X-Attempt=[1]
CountingHandler #6 X-Attempt=[1,1]
CountingHandler #7 X-Attempt=[1,1,1]
```

К третьей попытке у заголовка три значения. Для заголовка подписи это означает, что сервер получает `X-Signature: abc, def, ghi` и отклоняет запрос. Код в `ResilienceHandler` это подтверждает: callback конвейера вызывает `GetRequestMessage(context, state.request)`, который возвращает исходный запрос, если только внешняя стратегия не положила в контекст другой. Так делает только hedging.

Решение в том, чтобы записывать заголовки с семантикой "установить". `Authorization` является однозначным типизированным свойством, поэтому присваивание заменяет старое значение. Для собственных заголовков сначала удаляйте:

```csharp
// .NET 10, C# 14
public sealed class SigningHandler(ISigner signer, TimeProvider clock) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var timestamp = clock.GetUtcNow().ToUnixTimeSeconds().ToString();

        request.Headers.Remove("X-Timestamp");
        request.Headers.Remove("X-Signature");
        request.Headers.Add("X-Timestamp", timestamp);
        request.Headers.Add("X-Signature", await signer.SignAsync(request, timestamp, cancellationToken));

        return await base.SendAsync(request, cancellationToken);
    }
}
```

С `Remove` и последующим `Add` проба показала `X-Attempt=[1]`, `[2]`, `[3]` на трёх попытках: одно значение, обновляемое каждый раз. То же касается обработчика токенов: `request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);` уже безопасно повторять.

## Тела запросов должны быть воспроизводимыми

Раз повторно уходит тот же `HttpRequestMessage`, повторно уходит и тот же `HttpContent`. `StringContent`, `ByteArrayContent`, `JsonContent` и `FormUrlEncodedContent` хранятся в памяти и могут сериализоваться сколько угодно раз. Первичный обработчик пробы копировал тело через `CopyToAsync`, как это делает `SocketsHttpHandler`, и POST со `StringContent` дошёл целым на всех трёх попытках.

`StreamContent` поверх потока без перемотки (сетевого потока, pipe, пересылаемой загрузки) этого не переживает:

```text
primary #1 body='{"a":1}'
primary #2 InvalidOperationException: The stream was already consumed. It cannot be read again.
```

`InvalidOperationException` не входит в число исключений, которые стандартный retry считает временными, поэтому вызов падает на второй попытке с этим исключением, а не повторяется. Поток с поддержкой перемотки работает, потому что `StreamContent` перед каждой отправкой возвращается к начальной позиции.

Вариантов три:

```csharp
// .NET 10, C# 14
// Option 1: buffer it (fine for small bodies)
var content = new StreamContent(uploadStream);
await content.LoadIntoBufferAsync(cancellationToken);   // probe: all 3 attempts sent the full body

// Option 2: copy to a seekable stream first
var ms = new MemoryStream();
await uploadStream.CopyToAsync(ms, cancellationToken);
ms.Position = 0;
var seekable = new StreamContent(ms);

// Option 3: do not retry this request at all
builder.Services.AddHttpClient("uploads")
    .AddStandardResilienceHandler()
    .Configure(o => o.Retry.DisableForUnsafeHttpMethods());
```

Для больших загрузок вариант 3 обычно самый честный ответ. Буферизовать тело размером 500 MB в памяти ради возможности повтора хуже, чем просто показать ошибку. `DisableForUnsafeHttpMethods` к тому же вообще не даёт стандартному обработчику повторять `POST`, `PUT`, `PATCH` и `DELETE`, что для неидемпотентных конечных точек обычно и нужно.

## Aspire и ConfigureHttpClientDefaults уже помещают ваш обработчик внутрь

Если проект использует `ServiceDefaults` из .NET Aspire, этой ошибки у вас может и не быть. `AddServiceDefaults()` вызывает `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())`, а действия по умолчанию всегда выполняются раньше собственной конфигурации именованного или типизированного клиента. Я зарегистрировал обработчик устойчивости через `ConfigureHttpClientDefaults`, а `CountingHandler` на именованном клиенте:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
CountingHandler #8 <- 503
CountingHandler #9 <- 503
CountingHandler #10 <- 200
```

Каждый обработчик конкретного клиента оказывается внутри retry, независимо от порядка `AddServiceDefaults()` и `AddHttpClient(...)` в `Program.cs`. Для подписи и токенов это правильное поведение по умолчанию, а для ключей идемпотентности неправильное. Если в приложении Aspire нужен обработчик уровня вызова, придётся удалить обработчик устойчивости по умолчанию для этого клиента и добавить его заново после вашего обработчика, как описано в статье [как переопределить обработчик устойчивости по умолчанию, который регистрирует Aspire](/ru/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/). Второй вызов `AddStandardResilienceHandler()` не заменяет первый, а добавляется поверх.

## Hedging ведёт себя иначе

`AddStandardHedgingHandler()` является исключением из правила "тот же объект запроса". При hedging одновременно может выполняться несколько попыток, поэтому он делает снимок исходного запроса и отправляет клон на каждую попытку. Цепочка к тому же содержит два экземпляра `ResilienceHandler`: один для конвейера hedging и один для стратегий уровня конечной точки:

```text
chain: ... -> ResilienceHandler -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
final: 503, primary calls: 2
CountingHandler #16 req@9c43c1 X-Attempt=[1]
CountingHandler #17 req@17e61ce X-Attempt=[1]
```

Два разных объекта запроса, у каждого ровно одно значение заголовка, даже с версией обработчика на `Headers.Add`. Обработчики, зарегистрированные после обработчика hedging, по-прежнему выполняются на каждой попытке. Но не полагайтесь на клонирование: код, корректный только при hedging, сломается в тот день, когда кто-нибудь вернёт стандартный обработчик.

## Что ещё меняется, когда обработчик оказывается внутри

Перенос обработчика под обработчик устойчивости подчиняет его **тайм-ауту попытки** (по умолчанию 10 секунд) и помещает в поле зрения **circuit breaker**. Три последствия:

- Медленная работа в обработчике расходует время каждой попытки. Конечная точка токенов, отвечающая 8 секунд, оставляет 2 секунды на сам запрос, прежде чем попытка завершится по тайм-ауту. Кешируйте токены и обновляйте их заранее до истечения, а не на пути запроса.
- Исключения, которые выбрасывает ваш обработчик, становятся результатами, которые оценивают retry и circuit breaker. `HttpRequestException`, выброшенный вашим обработчиком, повторяется и считается сбоем для breaker. Для сбоев, которые повтор не исправит, например отсутствующей конфигурации, выбрасывайте что-то невременное (или возвращайте ответ).
- Обработчик, который прерывает цепочку и возвращает собственный `HttpResponseMessage` (скажем, попадание в кеш), тоже подпадает под `ShouldHandle` у retry. Синтетический `503`, возвращённый изнутри цикла, повторяется так же, как настоящий.

Экземпляры `DelegatingHandler`, зарегистрированные через `AddHttpMessageHandler<T>()`, должны быть transient, и это не меняется. Фабрика создаёт одну цепочку на время жизни обработчика (по умолчанию две минуты) и переиспользует её для разных запросов, поэтому состояние отдельного запроса хранится в `HttpRequestMessage` (`request.Options`), а не в полях обработчика.

## Как проверить собственную цепочку

Не доверяйте коду регистрации, проверяйте построенную цепочку. Этот тест подходит для любого клиента:

```csharp
// .NET 10, xUnit v3, Microsoft.Extensions.Http.Resilience 10.10.0
[Fact]
public void SigningHandler_runs_inside_the_retry()
{
    var services = new ServiceCollection();
    services.AddTransient<SigningHandler>();
    services.AddSingleton<ISigner, FakeSigner>();
    services.AddSingleton(TimeProvider.System);
    var payments = services.AddHttpClient("payments");
    payments.AddStandardResilienceHandler();
    payments.AddHttpMessageHandler<SigningHandler>();

    using var sp = services.BuildServiceProvider();
    var handler = sp.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler("payments");

    var names = new List<string>();
    for (HttpMessageHandler? h = handler; h is not null; h = (h as DelegatingHandler)?.InnerHandler)
        names.Add(h.GetType().Name);

    Assert.True(names.IndexOf(nameof(ResilienceHandler)) < names.IndexOf(nameof(SigningHandler)));
}
```

Для поведенческого теста замените первичный обработчик заглушкой, которая падает фиксированное число раз, тем же приёмом, что и в статье [модульное тестирование кода, использующего HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/), и проверьте, что число вызовов вашего обработчика равно числу попыток.

## Связанные материалы

- [Polly против обработчиков устойчивости в .NET 11](/ru/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) объясняет пять стратегий внутри `AddStandardResilienceHandler` и их порядок.
- [Как переопределить обработчик устойчивости по умолчанию, который регистрирует Aspire](/ru/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/): удаление и повторное добавление обработчика для отдельного клиента.
- [HttpClient против HttpClientFactory против Refit](/ru/2026/05/httpclient-vs-httpclientfactory-vs-refit/) рассказывает, как фабрика собирает конвейеры из `DelegatingHandler`.
- [Исправление TaskCanceledException: A task was canceled в HttpClient](/ru/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) на случай, когда вызов обрывает тайм-аут попытки, а не ваш обработчик.
- [Polly 8.8 перезагружает конвейер устойчивости из вашего собственного IOptionsMonitor](/ru/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/), если вы настраиваете параметры повторов во время выполнения.

## Источники

- [Make outgoing HTTP requests: outgoing request middleware](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware), Microsoft Learn
- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/dotnet/core/resilience/http-resilience), Microsoft Learn
- [`ResilienceHandler.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHandler.cs) в dotnet/extensions
- [`Microsoft.Extensions.Http.Resilience` на NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience), проверены версии 10.10.0 и 8.10.0
- [`HttpContent.LoadIntoBufferAsync`](https://learn.microsoft.com/dotnet/api/system.net.http.httpcontent.loadintobufferasync), Microsoft Learn
