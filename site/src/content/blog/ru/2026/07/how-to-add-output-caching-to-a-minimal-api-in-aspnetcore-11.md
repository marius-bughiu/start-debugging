---
title: "Как добавить кеширование выходных данных в minimal API на ASP.NET Core 11"
description: "Полное рабочее руководство по кешированию выходных данных в minimal API на ASP.NET Core 11: AddOutputCache и UseOutputCache, CacheOutput на конечных точках и MapGroup, именованные и базовые политики, Expire, VaryByQuery и VaryByHeader, вытеснение по тегам с EvictByTagAsync, защита от cache stampede, повторная валидация через ETag и хранилище на Redis."
pubDate: 2026-07-12
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "performance"
  - "caching"
lang: "ru"
translationOf: "2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

Чтобы добавить кеширование выходных данных в minimal API на ASP.NET Core 11, нужны ровно три составные части: зарегистрировать сервисы через `builder.Services.AddOutputCache()`, добавить middleware через `app.UseOutputCache()` и пометить нужные для кеширования конечные точки вызовом `.CacheOutput()`. Этого достаточно, чтобы закешировать весь HTTP-ответ в памяти и отдавать его повторно, не запуская обработчик заново. Всё остальное (окна истечения, ключи кеша по запросу, инвалидация по тегам, хранилище на Redis) является уточнением. Этот пост проходит весь путь от начала до конца. Он ориентирован на .NET 11 (Preview 5 на момент написания, GA в ноябре 2026) с `Microsoft.NET.Sdk.Web` и C# 14, но API кеширования выходных данных стабилен со времён ASP.NET Core 7, поэтому каждый шаг здесь работает без изменений на .NET 8, 9 и 10.

## Кеширование выходных данных это не кеширование ответов

Первое, что нужно уяснить, потому что на этом спотыкаются почти все: кеширование выходных данных (output caching) и кеширование ответов (response caching) это разные возможности, решающие разные задачи.

Кеширование ответов (`AddResponseCaching`) это более старый middleware. Он участвует в HTTP-кешировании: читает и пишет заголовки `Cache-Control`, `Vary` и `Expires` и кеширует только тогда, когда ответ явно соглашается на это правильными заголовками. По сути это разделяемый прокси-кеш, живущий внутри вашего приложения, и его легко настроить неправильно, потому что случайный `Set-Cookie` или отсутствующий `Cache-Control: public` тихо отключает его.

Кеширование выходных данных (`AddOutputCache`, добавлено в ASP.NET Core 7) управляется сервером. Сервер решает, что и на какой срок кешировать, независимо от заголовков запроса клиента. Оно поддерживает вариацию ключа кеша по произвольным значениям, вытеснение по тегам, позволяющее очистить группу записей при изменении исходных данных, и встроенную защиту от cache stampede. Для API, где обе стороны под вашим контролем, кеширование выходных данных почти всегда именно то, что нужно. Этот пост целиком посвящён кешированию выходных данных.

## Подключаем три составные части

Кеширование выходных данных входит в общий фреймворк, поэтому для варианта с хранением в памяти не нужно устанавливать NuGet-пакет. Зарегистрируйте сервисы и добавьте middleware:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/time", () => new { now = DateTime.UtcNow })
    .CacheOutput();

app.Run();
```

Обратите внимание на три вещи. Во-первых, `AddOutputCache()` и `UseOutputCache()` сами по себе не делают ничего: они делают кеширование доступным, но ничего не кешируют, пока конечная точка на это не согласится. Во-вторых, `.CacheOutput()` без аргументов применяет политику по умолчанию, которая кеширует на 60 секунд. Обратитесь к `/time` дважды в течение минуты и получите обратно ту же метку времени, потому что второй запрос ни разу не запустит вашу лямбду.

В-третьих, и именно это вызывает баги в продакшене: порядок middleware имеет значение. `UseOutputCache()` должен стоять после `UseCors()`, после `UseAuthentication()` и после `UseAuthorization()`. Если он выполняется до авторизации, middleware может отдать ответ, закешированный для анонимного пользователя, аутентифицированному, или наоборот. В приложениях на Razor Pages и контроллерах он также должен идти после `UseRouting()`. Хост minimal `WebApplication` подключает маршрутизацию за вас, но если вы добавляете аутентификацию, за порядок отвечаете вы:

```csharp
// .NET 11, C# 14 -- correct ordering with auth
app.UseAuthentication();
app.UseAuthorization();
app.UseOutputCache();   // after auth, not before
```

## Задаём окно истечения именованной политикой

Окно по умолчанию в 60 секунд редко бывает тем, что нужно. Чтобы управлять им, вызовите `.CacheOutput()` со встроенным построителем или один раз определите именованную политику и ссылайтесь на неё по имени. Именованные политики сохраняют читаемость `Program.cs`, когда несколько конечных точек используют одни и те же настройки:

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddPolicy("Short", policy => policy.Expire(TimeSpan.FromSeconds(10)));
    options.AddPolicy("Long", policy => policy.Expire(TimeSpan.FromMinutes(30)));
});
```

Затем выбирайте политику для каждой конечной точки по имени:

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices).CacheOutput("Short");
app.MapGet("/catalog", GetCatalog).CacheOutput("Long");
```

Если вы предпочитаете держать конфигурацию рядом с конечной точкой, встроенная форма делает то же самое без зарегистрированной политики:

```csharp
// .NET 11, C# 14
app.MapGet("/prices", GetPrices)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(10)));
```

Существует также атрибут `[OutputCache]`, если вы предпочитаете атрибуты на обработчике, это та форма, которую используют контроллеры. На конечной точке minimal API это выглядит как `app.MapGet("/x", [OutputCache(PolicyName = "Short")] () => ...)`, но текучий `.CacheOutput("Short")` читается лучше и является соглашением, которому следует большинство кода на minimal API.

## Кешируем целую группу маршрутов сразу

Повторять `.CacheOutput()` на каждой конечной точке быстро надоедает. Поскольку `MapGroup` возвращает `RouteGroupBuilder`, разделяющий соглашения, вы можете прикрепить кеширование выходных данных к группе, и каждая конечная точка внутри его унаследует. Это чисто сочетается с модулями конечных точек по ресурсам, описанными в [организации конечных точек minimal API с MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/):

```csharp
// .NET 11, C# 14
var catalog = app.MapGroup("/catalog")
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)).Tag("catalog"));

catalog.MapGet("/", GetAllProducts);
catalog.MapGet("/{id:int}", GetProduct);
```

Обе конечные точки теперь кешируются на пять минут и несут тег `catalog`, что важно для шага инвалидации ниже.

## Управляем ключом кеша, чтобы не отдать неправильный ответ

По умолчанию ключом кеша является полный URL: схема, хост, порт, путь и вся строка запроса. Это значит, что `/search?q=widgets` и `/search?q=gadgets` автоматически являются отдельными записями, что обычно правильно. Но два случая требуют явной обработки.

Первый: вы хотите варьировать по конкретному значению запроса и игнорировать остальные. `SetVaryByQuery` ограничивает ключ теми ключами запроса, которые вы называете, чтобы параметры отслеживания вроде `utm_source` не дробили ваш кеш на тысячи почти одинаковых записей:

```csharp
// .NET 11, C# 14 -- cache per culture, ignore everything else in the query
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy
        .Expire(TimeSpan.FromMinutes(10))
        .SetVaryByQuery("culture"));
```

Второй: вы отдаёте разное содержимое в зависимости от заголовка запроса, такого как `Accept-Language` или пользовательский заголовок версии API. Используйте `SetVaryByHeader`, чтобы каждое значение заголовка получало собственную запись:

```csharp
// .NET 11, C# 14
app.MapGet("/articles", GetArticles)
    .CacheOutput(policy => policy.SetVaryByHeader("Accept-Language"));
```

Для всего, что URL и заголовки не могут выразить, `VaryByValue` позволяет вычислить фрагмент ключа из `HttpContext`. Именно так вы варьируете по идентификатору арендатора, разрешённому из claim, или по A/B-корзине:

```csharp
// .NET 11, C# 14 -- separate cache entry per tenant
app.MapGet("/dashboard", GetDashboard)
    .CacheOutput(policy => policy.VaryByValue(context =>
        new KeyValuePair<string, string>(
            "tenant", context.User.FindFirst("tenant")?.Value ?? "public")));
```

Одно предостережение по поводу `VaryByValue` на данных для конкретного пользователя: кеширование выходных данных по умолчанию вообще отказывается кешировать ответы на аутентифицированные запросы, именно чтобы избежать утечки ответа одного пользователя другому. Если вы намеренно это переопределяете (см. раздел о пользовательской политике), вариация по значению для каждого пользователя это то, что держит записи раздельными, и ошибка здесь это баг утечки данных, а не баг производительности. Относитесь к аутентифицированному кешированию выходных данных как к продвинутому случаю и тестируйте его жёстко.

## Инвалидируем по требованию с помощью тегов

Истечение по времени это грубый инструмент. Если ваш каталог меняется дважды в день, а вы кешируете на пять минут, вы каждый раз отдаёте устаревшие данные до пяти минут и бессмысленно перезагружаете их остальное время. Теги это исправляют: прикрепите тег к записям кеша, затем вытесните по тегу в тот момент, когда исходные данные меняются.

Выше на группе вы видели `.Tag("catalog")`. Чтобы очистить его, внедрите `IOutputCacheStore` и вызовите `EvictByTagAsync`. Естественное место для этого внутри операции записи, изменившей данные, а не отдельная административная конечная точка:

```csharp
// .NET 11, C# 14
app.MapPost("/catalog", async (Product product, AppDbContext db, IOutputCacheStore cache) =>
{
    db.Products.Add(product);
    await db.SaveChangesAsync();

    // The catalog changed, so drop every cached catalog response.
    await cache.EvictByTagAsync("catalog", default);

    return Results.Created($"/catalog/{product.Id}", product);
});
```

Теперь кеш отдаёт мгновенные чтения и остаётся свежим: истечение через пять минут (или даже через час) является страховочной сеткой, а настоящая инвалидация происходит ровно тогда, когда происходит запись. Если вы привязываете вызов `EvictByTagAsync` к тому же `SaveChanges`, который меняет строку, читатели никогда не видят данные старше последней успешной записи. Это хорошо сочетается с выявлением запросов, стоящих за этими записями; если конечная точка чтения достаточно медленна, чтобы вы потянулись за кешированием, стоит сначала исключить [N+1 запрос в EF Core](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), потому что кеширование медленного запроса лишь скрывает проблему.

Теги можно регистрировать декларативно и на базовой политике, что помечает каждую подходящую конечную точку, не трогая каждую по отдельности:

```csharp
// .NET 11, C# 14
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy
        .With(c => c.HttpContext.Request.Path.StartsWithSegments("/catalog"))
        .Tag("catalog"));
});
```

## Базовые политики по умолчанию применяются везде

`AddBasePolicy` отличается от `AddPolicy` одним важным моментом: базовая политика применяется ко всем конечным точкам (или ко всем конечным точкам, соответствующим её предикату `With`) без какого-либо вызова `.CacheOutput()` на конечной точке. Именно так вы задаёте схему истечения или тегирования по умолчанию для всего приложения:

```csharp
// .NET 11, C# 14 -- cache everything for 30 seconds unless overridden
builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

Действуйте здесь обдуманно. Сплошная базовая политика с радостью закеширует конечные точки, которые вы никогда не собирались кешировать. Ограничьте её через `.With(...)` префиксом пути или предпочтите явные вызовы `.CacheOutput()` для каждой конечной точки, если ваш API смешивает кешируемые чтения и некешируемые записи, что делает большинство API.

## Что политика по умолчанию будет и не будет кешировать

Даже после того как вы согласовали конечную точку, кеширование выходных данных применяет ограничители. Из коробки оно кеширует только когда:

- Статус ответа `HTTP 200`.
- Метод запроса `GET` или `HEAD`.
- Ответ не устанавливает cookie (любой `Set-Cookie` отключает кеширование для этого ответа).
- Запрос не аутентифицирован.

Эти правила и есть причина, по которой `.CacheOutput()` на конечной точке `POST`, похоже, ничего не делает: `POST` по умолчанию исключён. Они существуют, чтобы уберечь вас от случайного кеширования чего-то небезопасного. Если вам действительно нужно закешировать `POST`, или закешировать ответы `301`, или закешировать аутентифицированные ответы, вы пишете пользовательскую `IOutputCachePolicy` и соглашаетесь на это явно:

```csharp
// .NET 11, C# 14 -- excerpt of a custom policy that allows POST
public sealed class CachePostPolicy : IOutputCachePolicy
{
    public static readonly CachePostPolicy Instance = new();

    ValueTask IOutputCachePolicy.CacheRequestAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
    {
        var request = context.HttpContext.Request;
        var attempt = HttpMethods.IsGet(request.Method)
                   || HttpMethods.IsHead(request.Method)
                   || HttpMethods.IsPost(request.Method);

        context.EnableOutputCaching = true;
        context.AllowCacheLookup = attempt;
        context.AllowCacheStorage = attempt;
        context.AllowLocking = true;
        context.CacheVaryByRules.QueryKeys = "*";
        return ValueTask.CompletedTask;
    }

    ValueTask IOutputCachePolicy.ServeFromCacheAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;

    ValueTask IOutputCachePolicy.ServeResponseAsync(
        OutputCacheContext context, CancellationToken cancellationToken)
        => ValueTask.CompletedTask;
}
```

Зарегистрируйте её как именованную политику через `options.AddPolicy("CachePost", CachePostPolicy.Instance)` и выберите через `.CacheOutput("CachePost")`. Кеширование `POST` необычно, и у вас должна быть конкретная причина, но точка расширения на месте.

## Защита от stampede включена по умолчанию

Когда горячая запись кеша истекает и сотня запросов приходит одновременно, наивный кеш даёт всем ста промахнуться и одновременно молотить по вашей базе данных. Это и есть cache stampede, или thundering herd. Кеширование выходных данных смягчает это блокировкой ресурса: когда запись генерируется, конкурентные запросы к тому же ключу ждут завершения первого, вместо того чтобы каждый генерировал свой. Это включено по умолчанию и является одним из конкретных преимуществ перед самописным кодом на `IMemoryCache`, который так не делает, если вы не построите это сами.

Блокировку можно отключить для отдельной политики через `SetLocking(false)`, если конечная точка дёшева в генерации и вы предпочли бы, чтобы запросы не ждали:

```csharp
// .NET 11, C# 14
app.MapGet("/cheap", GetCheapThing)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(5)).SetLocking(false));
```

Оставьте её включённой для всего дорогого. Защита от stampede это ровно то, что нужно под нагрузкой, и это тот же класс задач, который [HybridCache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) решает для кеширования данных, а не кеширования целого ответа.

## Дешёвая повторная валидация через ETag

Кеширование выходных данных также сотрудничает с условными HTTP-запросами. Если ваш обработчик устанавливает заголовок `ETag`, middleware ответит на совпадающий `If-None-Match` статусом `304 Not Modified` и пустым телом вместо повторной отправки всей полезной нагрузки. Для большого ответа, отдаваемого клиенту, у которого он уже есть, это превращает полную передачу в несколько байт:

```csharp
// .NET 11, C# 14
app.MapGet("/report", async (HttpContext context) =>
{
    context.Response.Headers.ETag = $"\"{ComputeReportVersion()}\"";
    await WriteReport(context);
}).CacheOutput();
```

Никакой дополнительной настройки, кроме включения кеширования выходных данных, не нужно. То же работает с `If-Modified-Since` относительно времени создания записи кеша.

## Настраиваем лимиты и, когда масштабируетесь вширь, переходим на Redis

Два лимита `OutputCacheOptions` стоит знать до релиза. `MaximumBodySize` по умолчанию 64 MB: ответ больше этого никогда не кешируется, что является разумным умолчанием, но тихим, если вы недоумевали, почему большой экспорт никогда не кешируется. `SizeLimit` по умолчанию 100 MB общего хранилища кеша, после чего новые записи ждут вытеснения старых. `DefaultExpirationTimeSpan` это те 60 секунд, которые вы получаете, когда политика не задаёт явный `Expire`.

Хранилище по умолчанию это память в процессе, что означает, что у каждого экземпляра сервера свой кеш, и он испаряется при перезапуске. За балансировщиком нагрузки с несколькими экземплярами это часто нормально для конечных точек с преобладанием чтения, но это значит, что вытеснение по `tag` на одном узле не очищает остальные. Когда вам нужен разделяемый кеш, переживающий перезапуски и вытесняющий согласованно между узлами, добавьте хранилище на Redis. Это отдельный пакет:

```bash
dotnet add package Microsoft.AspNetCore.OutputCaching.StackExchangeRedis
```

```csharp
// .NET 11, C# 14
builder.Services.AddStackExchangeRedisOutputCache(options =>
{
    options.Configuration = builder.Configuration.GetConnectionString("Redis");
    options.InstanceName = "MyApp";
});

builder.Services.AddOutputCache(options =>
{
    options.AddBasePolicy(policy => policy.Expire(TimeSpan.FromSeconds(30)));
});
```

Обратите внимание, что метод называется `AddStackExchangeRedisOutputCache`, а не похоже названный `AddStackExchangeRedisCache`, используемый для `IDistributedCache`. Это различие важно, потому что Microsoft явно не рекомендует подкреплять кеширование выходных данных обычным `IDistributedCache`: этому интерфейсу не хватает атомарных операций, от которых зависит вытеснение по тегам, поэтому теги не вытеснялись бы надёжно. Используйте встроенное хранилище output cache на Redis или пользовательский `IOutputCacheStore`, а не `IDistributedCache`.

## Форма, которую стоит запомнить

Кеширование выходных данных в minimal API сводится к небольшому, компонуемому набору частей. Зарегистрируйте через `AddOutputCache`, вставьте `UseOutputCache` после middleware аутентификации и согласуйте конечные точки через `.CacheOutput()` или `.CacheOutput()` на уровне группы. Тянитесь за `Expire`, чтобы задать окно, за `SetVaryByQuery` и `SetVaryByHeader`, чтобы держать ключи правильными, и за `Tag` плюс `EvictByTagAsync`, чтобы инвалидировать в тот миг, когда ваши данные меняются, а не выжидать таймер. Оставьте защиту от stampede включённой для дорогой работы, уважайте ограничители по умолчанию, которые держат аутентифицированные и несущие cookie ответы вне кеша, и заменяйте хранилище в памяти на Redis только тогда, когда у вас действительно работает больше одного экземпляра. Это покрывает подавляющее большинство реальных API, и каждая строка выше работает на .NET с 8 по 11 без изменений.

## Related

- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to add per-endpoint rate limiting in ASP.NET Core 11](/2026/04/how-to-add-per-endpoint-rate-limiting-in-aspnetcore-11/)

## Sources

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [IOutputCacheStore.EvictByTagAsync (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.ioutputcachestore.evictbytagasync)
- [OutputCachePolicyBuilder (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.outputcaching.outputcachepolicybuilder)
