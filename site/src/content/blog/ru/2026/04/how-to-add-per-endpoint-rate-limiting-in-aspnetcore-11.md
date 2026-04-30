---
title: "Как добавить ограничение скорости для отдельных endpoint в ASP.NET Core 11"
description: "Полное руководство по ограничению скорости (rate limiting) для отдельных endpoint в ASP.NET Core 11: когда выбирать fixed window против sliding window, token bucket или concurrency, чем отличаются RequireRateLimiting и [EnableRateLimiting], партиционирование по пользователю или IP, callback OnRejected и ловушка распределённого развёртывания, в которую попадают все."
pubDate: 2026-04-30
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "rate-limiting"
lang: "ru"
translationOf: "2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

Чтобы ограничить скорость для конкретной конечной точки в ASP.NET Core 11, зарегистрируйте именованную политику в `AddRateLimiter`, вызовите `app.UseRateLimiter()` после маршрутизации и присоедините политику к endpoint с помощью `RequireRateLimiting("name")` для minimal API или `[EnableRateLimiting("name")]` для action MVC. Среда выполнения поставляет четыре встроенных алгоритма в `Microsoft.AspNetCore.RateLimiting`: fixed window, sliding window, token bucket и concurrency. Middleware возвращает `429 Too Many Requests`, когда запрос отклонён, и предоставляет callback `OnRejected` для пользовательских ответов, включая `Retry-After`. Это руководство охватывает .NET 11 preview 3 с C# 14, но API стабилен с .NET 7, и каждый пример кода компилируется без изменений на .NET 8, 9 и 10.

## Почему «глобальное» ограничение скорости редко то, что вам нужно

Самая простая конфигурация - один глобальный ограничитель, который отбрасывает запросы, когда весь процесс превышает бюджет, - привлекательна примерно десять секунд. Затем вы понимаете, что endpoint логина и статичная health-проба делят этот бюджет. Ботнет, бьющий в `/login`, с радостью положит `/health`, и ваш балансировщик нагрузки уберёт инстанс из ротации, потому что дешёвая проба начала возвращать 429.

Ограничение скорости по endpoint решает это. Каждый endpoint объявляет собственную политику с лимитами, настроенными под его реальную стоимость: `/login` получает строгий token bucket по IP, `/api/search` получает щедрое sliding window, endpoint загрузки файлов получает ограничитель concurrency, а `/health` не получает ничего. Глобальный ограничитель, если вы его сохраните, становится подстраховкой от злоупотреблений на уровне протокола, а не основной защитой.

Middleware `Microsoft.AspNetCore.RateLimiting` вышел из preview в .NET 7 и с тех пор получал только улучшения качества жизни. В .NET 11 он является полноправной частью фреймворка, без дополнительного пакета NuGet для установки.

## Минимальный Program.cs

Вот минимальная настройка, которая добавляет две различные политики по endpoint, применяет одну к endpoint минимального API и оставляет остальную часть приложения без троттлинга.

```csharp
// .NET 11 preview 3, C# 14
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    options.AddFixedWindowLimiter(policyName: "search", o =>
    {
        o.PermitLimit = 30;
        o.Window = TimeSpan.FromSeconds(10);
        o.QueueLimit = 0;
    });

    options.AddTokenBucketLimiter(policyName: "login", o =>
    {
        o.TokenLimit = 5;
        o.TokensPerPeriod = 5;
        o.ReplenishmentPeriod = TimeSpan.FromMinutes(1);
        o.QueueLimit = 0;
        o.AutoReplenishment = true;
    });
});

var app = builder.Build();

app.UseRateLimiter();

app.MapGet("/api/search", (string q) => Results.Ok(new { q }))
   .RequireRateLimiting("search");

app.MapPost("/api/login", (LoginRequest body) => Results.Ok())
   .RequireRateLimiting("login");

app.MapGet("/health", () => Results.Ok("ok"));

app.Run();

record LoginRequest(string Email, string Password);
```

Две вещи, на которые стоит обратить внимание. Первое: `RejectionStatusCode` по умолчанию равен `503 Service Unavailable`, что неверно почти для любого публичного API. Установите его в `429` один раз в `AddRateLimiter` и забудьте. Второе: `app.UseRateLimiter()` должен идти после `app.UseRouting()`, если вы вызываете маршрутизацию явно, потому что middleware читает метаданные endpoint, чтобы решить, какая политика применяется. Встроенный `WebApplication` добавляет маршрутизацию автоматически перед терминальным middleware, поэтому явный вызов `UseRouting` нужен только если у вас есть другой middleware, который должен сидеть между маршрутизацией и rate limiting.

## RequireRateLimiting против [EnableRateLimiting]

В ASP.NET Core есть два одинаково правильных способа присоединить политику к endpoint, и они существуют, потому что у minimal API и MVC разные истории с метаданными.

Для minimal API и групп endpoint правильный вызов - это fluent-метод `RequireRateLimiting` на `IEndpointConventionBuilder`:

```csharp
// .NET 11, C# 14
var api = app.MapGroup("/api/v1").RequireRateLimiting("search");

api.MapGet("/products", (...) => ...);          // inherits "search"
api.MapGet("/orders", (...) => ...);            // inherits "search"
api.MapPost("/login", (...) => ...)
   .RequireRateLimiting("login");               // overrides to "login"
```

Метаданные на уровне endpoint выигрывают у метаданных на уровне группы, поэтому переопределение в `/login` делает то, что вы ожидаете: применяется только самая специфичная политика на endpoint.

Для контроллеров MVC правильный вызов - форма с атрибутом:

```csharp
// .NET 11, C# 14
[ApiController]
[Route("api/[controller]")]
[EnableRateLimiting("search")]
public class ProductsController : ControllerBase
{
    [HttpGet]
    public IActionResult List() => Ok(/* ... */);

    [HttpGet("{id}")]
    [EnableRateLimiting("hot")]    // narrower policy for a hot endpoint
    public IActionResult Get(int id) => Ok(/* ... */);

    [HttpPost("import")]
    [DisableRateLimiting]          // bypass entirely for an internal endpoint
    public IActionResult Import() => Ok();
}
```

`[EnableRateLimiting]` и `[DisableRateLimiting]` следуют стандартным правилам разрешения атрибутов ASP.NET Core: уровень action выигрывает у уровня контроллера, а `DisableRateLimiting` всегда выигрывает. Смешивать fluent и атрибутный стили нормально - конвейер метаданных читает оба одинаково.

Распространённая ошибка - ставить `[EnableRateLimiting]` на endpoint minimal API через `.WithMetadata(new EnableRateLimitingAttribute("search"))`. Это работает, но `RequireRateLimiting("search")` короче и яснее.

## Выбор алгоритма

Четыре встроенных алгоритма отвечают на четыре разных формы вопроса «как часто слишком часто», и неправильный выбор проявляется либо как всплески трафика, пробивающие ваш лимит, либо как легитимные пользователи, получающие 429 во время обычных всплесков.

**Fixed window** считает запросы в неперекрывающихся временных бакетах. `PermitLimit = 100, Window = 1s` означает до 100 запросов в каждой выровненной по часам секунде. Дёшево вычислять и легко рассуждать, но позволяет всплеск из 200 запросов на границе окна: 100 в последней миллисекунде одного окна, 100 в первой миллисекунде следующего. Используйте для лимитов по стоимости, где всплеск приемлем, или для некритичной защиты от злоупотреблений, где вы не хотите тратить CPU на отслеживание.

**Sliding window** делит окно на сегменты и катит их вперёд. `PermitLimit = 100, Window = 1s, SegmentsPerWindow = 10` означает 100 запросов в любом 1-секундном срезе, оцениваемом с шагом 100ms. Это устраняет граничный всплеск ценой большего учёта на запрос. Это разумное значение по умолчанию для публичных endpoint на чтение.

**Token bucket** пополняет `TokensPerPeriod` токенов каждый `ReplenishmentPeriod`, до `TokenLimit`. Каждый запрос забирает токен. Всплески разрешены до `TokenLimit`, затем скорость стабилизируется на скорости пополнения. Это правильная модель для любого endpoint, где вы хотите разрешить небольшой всплеск (залогиненный пользователь открывает пять вкладок), но ограничить устойчивую скорость (никакого скрапинга). Login, сброс пароля и endpoint отправки писем - все кандидаты на token bucket.

**Concurrency** ограничивает количество запросов в обработке одновременно, независимо от длительности. `PermitLimit = 4` означает максимум четыре одновременных запроса; пятый либо встаёт в очередь, либо отклоняется. Используйте для endpoint, обращающихся к медленному downstream-ресурсу: больших загрузок файлов, дорогой генерации отчётов или любого endpoint, где стоимость - это время по часам на воркере, а не количество запросов.

Опции `QueueLimit` и `QueueProcessingOrder` общие для всех четырёх. `QueueLimit = 0` означает «отклонять немедленно при достижении лимита», что вам нужно для большинства HTTP API, потому что клиенты всё равно повторят попытку после 429. Ненулевые лимиты очереди имеют смысл для concurrency-ограничителей, где работа короткая и поставить в очередь на 200ms дешевле, чем отправлять клиента в цикл повторов.

## Партиционирование: на пользователя, на IP, на арендатора

Один общий бакет на endpoint - редко то, что вам нужно. Если `/api/search` глобально позволяет 30 запросов за 10 секунд, один шумный клиент блокирует всех остальных. Партиционированные ограничители дают каждому «ключу» собственный бакет.

Fluent-перегрузка `AddPolicy` принимает `HttpContext` и возвращает `RateLimitPartition<TKey>`:

```csharp
// .NET 11, C# 14
options.AddPolicy("per-user-search", context =>
{
    var key = context.User.Identity?.IsAuthenticated == true
        ? context.User.FindFirst("sub")?.Value ?? "anon"
        : context.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    return RateLimitPartition.GetSlidingWindowLimiter(key, _ => new SlidingWindowRateLimiterOptions
    {
        PermitLimit = 60,
        Window = TimeSpan.FromMinutes(1),
        SegmentsPerWindow = 6,
        QueueLimit = 0
    });
});
```

Фабрика вызывается один раз на ключ партиции. Среда выполнения кеширует получившийся ограничитель в `PartitionedRateLimiter`, поэтому последующие запросы с тем же ключом переиспользуют тот же экземпляр ограничителя. Использование памяти масштабируется с количеством различных ключей, которые вы когда-либо увидите, поэтому стоит вытеснять простаивающие ограничители: фреймворк делает это автоматически, когда ограничитель простаивал в течение `IdleTimeout` (по умолчанию 1 минута), но вы можете настроить через перегрузки `RateLimitPartition.GetSlidingWindowLimiter(key, factory)`.

Две ловушки партиционирования:

1. **`RemoteIpAddress` равен `null` за reverse proxy**, если вы не вызовете `app.UseForwardedHeaders()` с настроенным `ForwardedHeaders.XForwardedFor` и списком `KnownProxies` или `KnownNetworks`. Без этого каждый запрос получает ключ партиции `"unknown"`, и у вас снова глобальный ограничитель.
2. **Аутентифицированные и анонимные пользователи смешиваются в одной партиции**, если вы делаете ключ только из `sub`. Используйте префикс вроде `"user:"` или `"ip:"`, чтобы разлогиненный атакующий не мог столкнуться с бакетом реального пользователя.

Для более сложных политик (на арендатора, на API-ключ, несколько связанных ограничителей) реализуйте `IRateLimiterPolicy<TKey>` и зарегистрируйте через `options.AddPolicy<string, MyPolicy>("name")`. Интерфейс политики даёт вам тот же метод `GetPartition` плюс callback `OnRejected`, ограниченный областью этой политики.

## Настройка ответа об отклонении

Стандартный ответ 429 - это пустое тело без заголовка `Retry-After`. Это нормально для внутренних API, но публичные клиенты (браузеры, SDK, сторонние интеграции) ожидают подсказку. Callback `OnRejected` запускается после того, как ограничитель отклонил, но до того, как ответ будет записан:

```csharp
// .NET 11, C# 14
options.OnRejected = async (context, cancellationToken) =>
{
    if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
    {
        context.HttpContext.Response.Headers.RetryAfter =
            ((int)retryAfter.TotalSeconds).ToString();
    }

    context.HttpContext.Response.ContentType = "application/problem+json";
    await context.HttpContext.Response.WriteAsJsonAsync(new
    {
        type = "https://tools.ietf.org/html/rfc6585#section-4",
        title = "Too Many Requests",
        status = 429,
        detail = "Rate limit exceeded. Retry after the indicated period."
    }, cancellationToken);
};
```

Две детали, в которых легко ошибиться. Первое: `MetadataName.RetryAfter` заполняется только token bucket и пополняющими ограничителями, не fixed window и sliding window. Sliding window-ограничители могут вычислить retry-after из `Window / SegmentsPerWindow`, но математику делать вам самим. Второе: callback `OnRejected` запускается на пути middleware ограничителя скорости, а не внутри endpoint, поэтому доступ к специфичным для endpoint сервисам через `context.HttpContext.RequestServices` работает, но доступ к фильтрам контроллера или контексту action - нет, они ещё не привязаны.

Если вы хотите `OnRejected` на политику, а не глобальный, реализуйте `IRateLimiterPolicy<TKey>` и переопределите `OnRejected` на политике. Callback уровня политики запускается в дополнение к глобальному, поэтому будьте осторожны, чтобы не записать тело ответа дважды.

## Ловушка распределённого развёртывания

Каждый пример кода выше хранит состояние rate limit в памяти процесса. Это нормально, когда вы запускаете один инстанс, и катастрофично, когда вы масштабируетесь горизонтально. Три реплики за балансировщиком нагрузки с `PermitLimit = 100` за 10 секунд на самом деле позволяют 300 запросов за 10 секунд, потому что каждая реплика считает независимо. Sticky-сессии помогают только если ваш хеш равномерно распределяет ключи партиций, чего обычно не происходит.

В `Microsoft.AspNetCore.RateLimiting` нет встроенного распределённого rate limiter. Поддерживаемые варианты на момент .NET 11:

- **Поднимите лимит на балансировщик нагрузки.** NGINX `limit_req`, AWS WAF rate-based rules, Azure Front Door rate limiting, Cloudflare Rate Limiting Rules. Это правильный ответ для грубой защиты от злоупотреблений на сетевом краю.
- **Используйте библиотеку с поддержкой Redis.** `RateLimit.Redis` (sample от Microsoft на GitHub) и `AspNetCoreRateLimit.Redis` оба реализуют `PartitionedRateLimiter<HttpContext>` поверх Redis sorted set или атомарного инкремента. Round-trip к Redis добавляет 0.5-2ms на запрос, что приемлемо для endpoint, не находящихся на горячем пути.
- **Комбинируйте оба.** Край применяет щедрый лимит; приложение применяет лимит на пользователя в Redis; in-process остаётся для backpressure на медленные downstream через ограничитель concurrency.

Не реализуйте свой собственный распределённый ограничитель поверх `IDistributedCache` и `INCRBY`, если только вы не прочитали [пост блога Cloudflare о распределённых счётчиках со скользящим окном](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) и не имеете твёрдого мнения о расхождении часов.

## Тестирование endpoint с rate limit

Интеграционные тесты с `WebApplicationFactory<TEntryPoint>` работают, но rate limiter по умолчанию не сбрасывается между тестами. Две стратегии:

1. **Переопределите политику в тестовом хосте.** Внедрите разрешительный ограничитель (`PermitLimit = int.MaxValue`) для тестовой среды и напишите отдельный набор тестов, которые явно бьют в ограничитель с реальной политикой.
2. **Отключите ограничитель для тестируемого endpoint.** Оберните ваши вызовы `MapGroup`/`RequireRateLimiting` в `if (!env.IsEnvironment("Testing"))` или используйте `[DisableRateLimiting]` в тестовых переопределениях.

Middleware также предоставляет `RateLimiterOptions.GlobalLimiter` для партиционированного ограничителя верхнего уровня, который запускается на каждом запросе перед политиками по endpoint. Это правильное место для шлюза по IP вида «ты явно бот» и правильное место для добавления заголовка `Retry-After` при каждом отклонении независимо от того, какая именованная политика сработала. Не используйте его как замену политикам по endpoint; они композируются, не заменяют друг друга.

## Когда встроенного middleware недостаточно

Middleware покрывает 90% случаев. Оставшиеся 10% обычно включают одно из:

- **Лимиты по стоимости**: каждый запрос потребляет N токенов в зависимости от вычисленной стоимости (поиск с 5 фасетами стоит больше, чем плоский список). У middleware нет хука для переменного потребления токенов, поэтому вы оборачиваете endpoint ручным вызовом `RateLimiter.AcquireAsync(permitCount)` внутри обработчика.
- **Мягкие лимиты с деградацией**: вместо возврата 429 вы отдаёте кешированный или прореженный ответ. Реализуйте это в endpoint, а не в middleware: проверьте `context.Features.Get<IRateLimitFeature>()` (добавлено middleware в .NET 9) и ветвитесь на этом.
- **Экспозиция метрик по маршруту**: middleware эмитит `aspnetcore.rate_limiting.request_lease.duration` и подобные метрики через meter `Microsoft.AspNetCore.RateLimiting`. Подключите через `OpenTelemetry`, чтобы получить счётчики 429 по политике в вашем дашборде. Встроенные счётчики не разбиваются по endpoint; если вам это нужно, тегайте meter сами в `OnRejected`.

## Связанное

- [Как добавить глобальный фильтр исключений в ASP.NET Core 11](/ru/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) охватывает правила порядка middleware, которые также применяются к `UseRateLimiter`.
- [Как использовать Native AOT с minimal API ASP.NET Core](/ru/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) для последствий trim-безопасности `IRateLimiterPolicy<T>`.
- [Как юнит-тестировать код, использующий HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/) для шаблона тестового хоста, упомянутого выше.
- [Как добавить потоки аутентификации OpenAPI в Swagger UI в .NET 11](/ru/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) для истории с ключом партиции, когда API-ключи несут идентичность пользователя.
- [Как сгенерировать строго типизированный клиентский код из OpenAPI-спецификации в .NET 11](/ru/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/) для потребительской стороны контракта 429.

## Источники

- [Middleware ограничения скорости в ASP.NET Core](https://learn.microsoft.com/aspnet/core/performance/rate-limit) на MS Learn.
- [Справочник API `Microsoft.AspNetCore.RateLimiting`](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.ratelimiting).
- [Исходный код пакета `System.Threading.RateLimiting`](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.RateLimiting) для базовых примитивов ограничителя.
- [RFC 6585 раздел 4](https://www.rfc-editor.org/rfc/rfc6585#section-4) для канонического определения `429 Too Many Requests` и заголовка `Retry-After`.
