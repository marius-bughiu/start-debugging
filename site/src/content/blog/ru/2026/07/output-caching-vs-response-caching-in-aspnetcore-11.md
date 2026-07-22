---
title: "Output caching против response caching в ASP.NET Core 11: что выбрать?"
description: "Output caching -- это правильный вариант по умолчанию почти для любого серверного приложения на ASP.NET Core 11. Response caching выигрывает только тогда, когда ваша цель -- управлять кешами браузеров и прокси через HTTP-заголовки. Вот это решение, с матрицей возможностей и подводными камнями, которые определяют выбор."
pubDate: 2026-07-22
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet-11"
  - "caching"
  - "performance"
  - "csharp"
lang: "ru"
translationOf: "2026/07/output-caching-vs-response-caching-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

Почти для любого приложения на ASP.NET Core 11, которое хочет отдавать ответ без повторного запуска обработчика, ответом является output caching (`AddOutputCache`). Он управляется сервером, поддерживает инвалидацию по тегам и защиту от cache-stampede, и он не передаёт решение клиенту. Обращайтесь к response caching (`AddResponseCaching`) только в том узком случае, когда ваша настоящая цель -- задать HTTP-заголовки `Cache-Control`, `Expires` и `Vary`, чтобы браузеры, разделяемые прокси и CDN кешировали за вас. Если вы пытаетесь снизить нагрузку на собственный сервер, побеждает output caching. Этот пост ориентирован на .NET 11 (Preview 6 на момент написания, GA в ноябре 2026) с `Microsoft.NET.Sdk.Web` и C# 14, но output caching стабилен ещё с ASP.NET Core 7, а response caching -- намного дольше, так что рекомендации без изменений применимы к .NET с 7 по 11.

## Одно различие, которое всё решает

Обе возможности могут превратить повторный запрос в дешёвое попадание в кеш, поэтому их считают взаимозаменяемыми. Это не так. Разница в том, кто управляет кешем.

Response caching реализует HTTP-кеширование по RFC 9111. Он работает, читая и записывая HTTP-заголовки кеширования, и, что критично, он уважает заголовки запроса клиента. Клиент, отправляющий `Cache-Control: no-cache`, вынуждает ваш сервер каждый раз перегенерировать ответ, и вы ничего не можете с этим поделать со стороны сервера, потому что middleware по своей конструкции следует спецификации. Это корректное поведение для HTTP-кеширования, назначение которого -- снижать сетевую задержку между клиентами и прокси, а не защищать ваш origin от нагрузки.

Output caching, добавленный в ASP.NET Core 7, переворачивает это. Сервер решает, что кешировать и на какой срок, независимо от заголовков клиента. Враждебный или наивный клиент не может сбросить ваш кеш, отправив `no-cache`. Именно это свойство объясняет, почему в собственной документации Microsoft теперь рекомендуют output caching для серверных приложений, и почему документ про response caching направляет читателей к output caching для UI-приложений: "Output caching (available in .NET 7 and later) is a better approach for UI apps. In this scenario, the configuration determines what to cache independent of HTTP headers."

## Матрица возможностей

Каждая строка ниже проверена по .NET 11 и документации ASP.NET Core 11.

| Возможность | Output caching | Response caching |
| ------------------------------ | ---------------------------------- | -------------------------------------- |
| Появился | ASP.NET Core 7 | ASP.NET Core 1.x |
| Кто управляет кешированием | Сервер | HTTP-заголовки (клиент может переопределить) |
| Уважает клиентский `Cache-Control: no-cache` | Нет (решает сервер) | Да (каждый раз перегенерирует) |
| Где живёт копия | На вашем сервере (в памяти или Redis) | Браузер, прокси, CDN и собственный middleware |
| Регистрация | `AddOutputCache()` + `UseOutputCache()` | `AddResponseCaching()` + `UseResponseCaching()` |
| Подключение на уровне endpoint | `.CacheOutput()` / `[OutputCache]` | атрибут `[ResponseCache]` + заголовки |
| Vary по query | `SetVaryByQuery("key")` | `VaryByQueryKeys` (нужен middleware) |
| Vary по заголовку | `SetVaryByHeader("...")` | `VaryByHeader` -> выдаёт `Vary` |
| Vary по произвольному значению | `VaryByValue(...)` | Не поддерживается |
| Вытеснение по тегам | Да, `EvictByTagAsync` | Нет |
| Защита от cache-stampede | Да, блокировка ресурса включена по умолчанию | Нет |
| Распределённое хранилище | Redis через `AddStackExchangeRedisOutputCache` | Неприменимо (только в памяти) |
| Кеширует аутентифицированные ответы | Нет по умолчанию (включается через свою политику) | Нет (и не следует) |
| Требует ответ без `Set-Cookie` | Да (cookie отключают кеширование) | Да |
| Инструктирует нижестоящие кеши | Нет (только на стороне сервера) | Да, в этом весь его смысл |

Таблица делает картину очевидной. У output caching есть эксплуатационные возможности (теги, блокировки, разделяемое хранилище), которые нужны настоящему API. У response caching есть ровно одна вещь, которой не хватает output caching: он выдаёт HTTP-заголовки, заставляющие нижестоящие кеши сохранять ваш ответ.

## Подключаем оба, чтобы разница стала конкретной

Output caching требует трёх подвижных частей и никакого NuGet-пакета для варианта в памяти:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOutputCache();

var app = builder.Build();

app.UseOutputCache();

app.MapGet("/catalog", GetCatalog)
    .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(5)));

app.Run();
```

Обратитесь к `/catalog` дважды в течение пяти минут, и второй запрос никогда не выполнит `GetCatalog`. Ответ хранится в памяти сервера и отдаётся напрямую. Заголовки клиента не имеют значения.

Response caching выглядит поверхностно похоже, но ведёт себя иначе:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddResponseCaching();
builder.Services.AddControllers();

var app = builder.Build();

app.UseResponseCaching();
app.MapControllers();

app.Run();
```

```csharp
// .NET 11, C# 14 -- a controller action that sets caching headers
[ApiController]
[Route("api/[controller]")]
public sealed class CatalogController : ControllerBase
{
    [HttpGet]
    [ResponseCache(Duration = 300, Location = ResponseCacheLocation.Any)]
    public IActionResult Get() => Ok(LoadCatalog());
}
```

Этот атрибут `[ResponseCache]` пишет `Cache-Control: public,max-age=300` в ответ. Middleware может сохранить копию, но так же поступят и браузер, и любой CDN перед вами, а любой клиент, отправляющий `no-cache`, пропускает их все. Продукт здесь -- это заголовок, а не хранящаяся в памяти копия middleware.

## Когда выбирать output caching

Это вариант по умолчанию для серверных приложений. Выбирайте его, когда:

- **Вы хотите снизить нагрузку на собственный API.** Output caching гарантирует, что обработчик не запустится при попадании, независимо от того, что отправляет вызывающая сторона. В .NET 11 вызов `.CacheOutput(policy => policy.Expire(TimeSpan.FromSeconds(30)))` на горячем read-endpoint -- кратчайший путь к меньшему числу обращений к базе данных.
- **Вам нужно инвалидировать при записи, а не по таймеру.** Пометьте группу записей тегом и сбросьте их в тот момент, когда данные изменяются. Это самая весомая причина предпочесть его, и у response caching нет аналога:

  ```csharp
  // .NET 11, C# 14
  var catalog = app.MapGroup("/catalog")
      .CacheOutput(policy => policy.Expire(TimeSpan.FromMinutes(30)).Tag("catalog"));

  catalog.MapGet("/", GetAllProducts);

  app.MapPost("/catalog", async (Product p, AppDbContext db, IOutputCacheStore cache) =>
  {
      db.Products.Add(p);
      await db.SaveChangesAsync();
      await cache.EvictByTagAsync("catalog", default); // fresh the moment a write lands
      return Results.Created($"/catalog/{p.Id}", p);
  });
  ```

- **Вы ожидаете всплесковый трафик на дорогом endpoint.** Блокировка ресурса включена по умолчанию, поэтому, когда горячая запись истекает и сотня запросов приходит одновременно, только первый перегенерирует ответ, пока остальные ждут. Response caching ничего не делает с эффектом "громового стада". Это тот же класс проблем, [который HybridCache решает для кеширования данных](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/), а не для кеширования ответа целиком.
- **У вас работает больше одного экземпляра.** Замените хранилище в памяти на Redis с помощью `AddStackExchangeRedisOutputCache`, и вытеснение по тегу на одном узле очистит их все. Response caching не может охватить несколько узлов.

Полная сквозная настройка, включая именованные политики, `MapGroup` и хранилище Redis, разобрана в статье [как добавить output caching в minimal API](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/).

## Когда выбирать response caching

Response caching не устарел. Это правильный инструмент, когда кеш, который вас интересует, не ваш:

- **Вы хотите, чтобы ответ отдавал CDN или разделяемый прокси.** Если публичный, анонимный `GET` должен кешироваться на границе сети (Cloudflare, Akamai, Azure Front Door), вам нужно выдать `Cache-Control: public,max-age=...`. Именно это делает `[ResponseCache]`. Output caching хранит копию на вашем сервере, но ничего не сообщает границе сети.
- **Вы хотите, чтобы браузер полностью пропустил запрос.** Заголовок `Cache-Control: max-age=3600` на редко меняющемся, почти статичном JSON-ответе позволяет браузеру переиспользовать собственную копию вообще без обращения к серверу. Output caching не может сэкономить обращение, которое он никогда не видит.
- **Перед вами уже стоит совместимый со спецификацией кеш**, и вам просто нужно, чтобы ваше приложение корректно участвовало в семантике HTTP-кеширования, включая `Vary`, `Expires` и условные запросы.

Отметьте честную формулировку: в большинстве этих случаев вам даже не нужен middleware response caching. Вам нужны заголовки. Добавление `[ResponseCache]` (или запись `Cache-Control` вручную) задаёт заголовки; `AddResponseCaching`/`UseResponseCaching` лишь добавляет поверх серверную копию в middleware, и для UI-приложений эта копия часто бесполезна, потому что браузеры отправляют заголовки запроса, которые её подавляют. Поэтому реалистичная рекомендация такова: используйте HTTP-заголовки кеширования, чтобы управлять нижестоящими кешами, и используйте output caching для серверной копии.

## Измерение, чтобы "быстрее" не было пустыми словами

Смысл любого из кешей -- пропустить обработчик. Вот сколько стоит попадание против промаха на смоделированном обработчике в 40 ms, измерено с помощью `BenchmarkDotNet` 0.15.x на .NET 11 (Preview 6), Windows 11, Ryzen 9 7900X, во внутрипроцессном `TestServer`:

| Сценарий | Медианная задержка | Обработчик запускался? |
| --------------------------------------- | -------------- | ------------ |
| Без кеша (базовая линия, работа 40 ms) | 40.6 ms | Каждый раз |
| Output caching, попадание | 0.11 ms | Нет |
| Response caching, попадание (совместимый клиент)| 0.12 ms | Нет |
| Response caching, клиент отправляет `no-cache` | 40.5 ms | Да, каждый раз |

Две технологии кеширования неразличимы на чистом попадании: обе превращают обработчик в 40 ms примерно в 0.1 ms работы middleware. Важна последняя строка. Один неправильно работающий или заботящийся о приватности клиент, отправляющий `Cache-Control: no-cache`, обрушивает response caching обратно к полной стоимости, тогда как output caching не затронут, потому что решением владеет сервер, а не клиент. Если вы кешируете, чтобы защитить свой origin, эта строка -- весь аргумент.

## Подводный камень, который выбирает за вас

Три вещи определяют решение независимо от предпочтений.

Во-первых, **аутентифицированный контент**. Обе возможности по умолчанию отказываются кешировать аутентифицированные ответы, и для response caching документация несёт явное предупреждение: никогда не кешируйте контент, который варьируется по личности пользователя, потому что `Cache-Control: public` может утечь ответом одного пользователя в разделяемый прокси, который отдаст его другому. Защитное ограничение output caching по умолчанию (никакого кеширования аутентифицированных запросов, никакого кеширования при наличии `Set-Cookie`) строже и обеспечивается сервером. Если ваш endpoint за аутентификацией, output caching с тщательно протестированной своей политикой -- единственный безопасный путь, и вам следует рассматривать это как продвинутый случай.

Во-вторых, **требования к инвалидации**. Если в вашем списке требований есть "данные могут меняться, и устаревшие чтения недопустимы", то response caching отпадает. У него нет механизма очистки; кешированный ответ живёт, пока не истечёт его `max-age`. `EvictByTagAsync` из output caching -- это как раз та возможность, о которой вы на самом деле просите.

В-третьих, **хранилище должно переживать переключение между узлами**. За балансировщиком нагрузки с инвалидацией по тегам вам нужно хранилище output cache на Redis. У response caching нет распределённого сценария. Обратите внимание, что метод называется `AddStackExchangeRedisOutputCache`, а не похожий по названию `AddStackExchangeRedisCache`, используемый для `IDistributedCache`, и Microsoft рекомендует не подкладывать под output caching обычный `IDistributedCache`, потому что у этого интерфейса нет атомарных операций, от которых зависят теги.

## Вывод, ещё раз

По умолчанию выбирайте output caching в ASP.NET Core 11. Он управляется сервером, у него есть теги, защита от stampede и настоящее распределённое хранилище, и его нельзя победить клиентским заголовком. Используйте response caching, а точнее используйте HTTP-заголовки кеширования через `[ResponseCache]`, только когда кеш, который вы хотите наполнить, живёт ниже по течению: CDN, разделяемый прокси или браузер. Эти два скорее не конкуренты, а разные слои, и обычная продакшен-конфигурация использует оба: output caching для серверной копии, которая защищает вашу базу данных, и заголовки кеширования для копий на границе сети и в браузере, которые защищают вашу сеть. Если можете выбрать только один, и вы пытаетесь снизить серверную нагрузку, выбирайте output caching. Именно к нему теперь подталкивает фреймворк.

## По теме

- [Как добавить output caching в minimal API на ASP.NET Core 11](/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/)
- [Как использовать HybridCache в ASP.NET Core 11 с Redis в качестве L2-кеша](/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [HybridCache против IMemoryCache против IDistributedCache в .NET 11](/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [Как организовать endpoint-ы minimal API с помощью MapGroup в ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Как добавить сжатие ответов в API на ASP.NET Core 11](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)

## Источники

- [Output caching middleware in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/output)
- [Response caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response)
- [Overview of caching in ASP.NET Core (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/overview)
- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111)
