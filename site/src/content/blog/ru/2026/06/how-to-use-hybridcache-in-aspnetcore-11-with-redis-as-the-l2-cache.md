---
title: "Как использовать HybridCache в ASP.NET Core 11 с Redis в качестве кеша L2"
description: "Подключите HybridCache к Redis-кешу L2 в ASP.NET Core 11: зарегистрируйте сервис, добавьте распределённый кеш StackExchange Redis и позвольте GetOrCreateAsync дать вам двухуровневый кеш со встроенной защитой от лавины и инвалидацией по тегам."
pubDate: 2026-06-07
template: how-to
tags:
  - "aspnetcore"
  - "dotnet"
  - "performance"
lang: "ru"
translationOf: "2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache"
translatedBy: "claude"
translationDate: 2026-06-07
---

Чтобы использовать HybridCache с Redis в качестве кеша второго уровня в ASP.NET Core 11, установите `Microsoft.Extensions.Caching.Hybrid`, вызовите `builder.Services.AddHybridCache()`, а затем зарегистрируйте `IDistributedCache` на базе Redis с помощью `AddStackExchangeRedisCache(...)`. HybridCache автоматически подхватывает этот `IDistributedCache` как свой L2. После этого каждый вызов `GetOrCreateAsync` сначала читает L1 (память в процессе), затем обращается к L2 (Redis) и вызывает вашу фабрику только при полном промахе. Вы получаете защиту от лавины кеша и инвалидацию по тегам бесплатно, без шаблонного кода cache-aside. Эта статья проходит через полную настройку, опции, которые действительно важны, и подвох с несколькими экземплярами, на котором спотыкаются многие.

Все примеры ориентированы на .NET 11, ASP.NET Core 11 и C# 14 и используют `Microsoft.Extensions.Caching.Hybrid` 9.x (пакет вышел в GA вместе с .NET 9 и это тот же пакет, который вы используете в .NET 11). Сама библиотека поддерживает среды выполнения вплоть до .NET Framework 4.7.2 и .NET Standard 2.0, поэтому тот же код работает и в более старых хостах.

## Зачем вообще нужен HybridCache

Если вы раньше выпускали распределённый кеш, вы писали этот цикл вручную: проверить `IMemoryCache`, промах, проверить `IDistributedCache` (Redis), промах, десериализовать, обратиться к базе данных, сериализовать, записать обратно в оба слоя, вернуть. Умножьте это на каждое кешируемое значение, и вы получите кучу почти идентичного кода cache-aside, каждая копия со своей тонкой ошибкой. Две классические ошибки: отсутствующая защита от лавины (сотня запросов одновременно попадает на просроченный ключ и все колотят по базе данных) и несогласованная сериализация между двумя слоями.

HybridCache сводит всё это к одному вызову. Это двухуровневый кеш: L1 -- это `MemoryCache` в процессе (быстрый, на каждый сервер, теряется при перезапуске), а L2 -- это любой `IDistributedCache`, который вы регистрируете (Redis, SQL Server, Postgres, Garnet). Ключевой момент для этой статьи: вы не настраиваете L2 напрямую в HybridCache. HybridCache обнаруживает `IDistributedCache` из контейнера внедрения зависимостей. Зарегистрируйте распределённый кеш Redis, и HybridCache автоматически использует его как L2.

## Подключение Redis в качестве кеша L2

Вот сквозная настройка в виде пронумерованной процедуры.

1. Установите два пакета. Первый приносит HybridCache; второй -- это `IDistributedCache` для Redis на базе StackExchange.

   ```dotnetcli
   dotnet add package Microsoft.Extensions.Caching.Hybrid
   dotnet add package Microsoft.Extensions.Caching.StackExchangeRedis
   ```

2. Сохраните строку подключения Redis в конфигурации. Держите её вне системы контроля версий с помощью файла user-secrets в разработке:

   ```json
   {
     "ConnectionStrings": {
       "RedisConnectionString": "localhost:6379"
     }
   }
   ```

3. Зарегистрируйте `IDistributedCache` для Redis. Это L2. `AddStackExchangeRedisCache` помещает `IDistributedCache` во внедрение зависимостей, опираясь на ваш экземпляр Redis.

   ```csharp
   // .NET 11, ASP.NET Core 11, C# 14
   var builder = WebApplication.CreateBuilder(args);

   builder.Services.AddStackExchangeRedisCache(options =>
   {
       options.Configuration =
           builder.Configuration.GetConnectionString("RedisConnectionString");
   });
   ```

4. Зарегистрируйте HybridCache. Он найдёт `IDistributedCache` из шага 3 и будет использовать его как L2. Без зарегистрированного `IDistributedCache` HybridCache всё равно работает как кеш в процессе только с L1, поэтому эта единственная строка -- единственное, что "включает" двухуровневое поведение.

   ```csharp
   // .NET 11, ASP.NET Core 11
   builder.Services.AddHybridCache();

   var app = builder.Build();
   ```

Это вся проводка. Порядок между шагами 3 и 4 не имеет значения, потому что внедрение зависимостей разрешает `IDistributedCache` лениво, когда HybridCache впервые в нём нуждается. У HybridCache нет вызова `UseRedis()` и нет настройки L2, указывающей на Redis. Обнаружение неявное, через `IDistributedCache`, и именно поэтому тот же код HybridCache работает с Redis, SQL Server или вообще без L2 без изменения единой строки.

## Чтение и запись с GetOrCreateAsync

`GetOrCreateAsync` -- это API, который вы будете использовать в 95% случаев. Внедрите `HybridCache` и вызовите его с ключом и фабрикой:

```csharp
// .NET 11, C# 14
public sealed class ProductService(HybridCache cache, ProductDbContext db)
{
    public async Task<Product?> GetProductAsync(int id, CancellationToken ct = default)
    {
        return await cache.GetOrCreateAsync(
            $"product:{id}",                       // unique cache key
            async cancel => await db.Products
                .AsNoTracking()
                .FirstOrDefaultAsync(p => p.Id == id, cancel),
            cancellationToken: ct);
    }
}
```

При первом вызове для `product:42` HybridCache промахивается по L1, промахивается по L2, запускает фабрику, сериализует результат, записывает его и в Redis, и в кеш в процессе, и возвращает. Следующий вызов на том же сервере попадает в L1 и никогда не обращается к Redis. Вызов на другом сервере вашего кластера промахивается по L1, но попадает в L2 (Redis), поэтому пропускает базу данных и заполняет свой собственный L1. В этом и выгода двух уровней: горячие ключи остаются в процессе, тёплые ключи остаются в Redis, и база данных видит промах только тогда, когда оба слоя холодные.

Обратите внимание на интерполированную строку, передаваемую прямо внутри вызова. Документация рекомендует писать ключ встроенно вот так, а не строить его сначала в локальной переменной, потому что это позволяет будущим версиям библиотеки избегать выделения строки в некоторых случаях. Есть также вторая перегрузка `GetOrCreateAsync`, которая принимает кортеж `state` плюс `static`-лямбду, что избегает выделений замыкания на горячих путях:

```csharp
// .NET 11, C# 14 - allocation-conscious overload
return await cache.GetOrCreateAsync(
    $"product:{id}",
    (db, id),
    static async (state, cancel) => await state.db.Products
        .AsNoTracking()
        .FirstOrDefaultAsync(p => p.Id == state.id, cancel),
    cancellationToken: ct);
```

По умолчанию используйте перегрузку без состояния. Прибегайте к перегрузке с состоянием только тогда, когда профилировщик скажет вам, что выделение замыкания имеет значение, что редко по сравнению со стоимостью обращения к базе данных.

## Защита от лавины -- это та функция, которую вы на самом деле покупаете

Это та часть, которую трудно сделать правильно вручную. Когда популярный ключ истекает и приходит всплеск запросов, наивный cache-aside позволяет каждому запросу промахнуться и одновременно вызвать фабрику. HybridCache гарантирует, что для заданного ключа на заданном сервере фабрику запускает только один вызывающий. Остальные ожидают того же результата.

```csharp
// 100 concurrent requests for the same cold key
// -> exactly 1 factory invocation, 99 awaiters share the result
var tasks = Enumerable.Range(0, 100)
    .Select(_ => service.GetProductAsync(42, ct));
var results = await Task.WhenAll(tasks);
```

Одна тонкость: передаваемый вами `CancellationToken` представляет совмещённую отмену всех ожидающих в очереди вызывающих. Фабрика продолжает работать, пока хотя бы один вызывающий всё ещё хочет результат, поэтому отключение одного клиента не отменит общую работу для всех остальных.

Честная оговорка: эта защита действует на каждый экземпляр. HybridCache не поставляет распределённую блокировку, поэтому в кластере из трёх серверов холодный ключ может вызвать до трёх вызовов фабрики, по одному на сервер, а не один на весь парк. Для большинства рабочих нагрузок это нормально. Если вам действительно нужен single-flight на уровне кластера, нужна внешняя распределённая блокировка или сторонний кеш вроде FusionCache, который добавляет её сверху. Не предполагайте, что "защита от лавины" означает "один запрос к базе данных на всех серверах".

## Истечение: два часовых механизма, которыми вы управляете

`HybridCacheEntryOptions` предоставляет две настройки истечения, и их путаница -- самая частая ошибка конфигурации:

- `Expiration` -- это общее время жизни, включая копию в L2 (Redis).
- `LocalCacheExpiration` -- это время жизни L1 в процессе. Обычно оно короче, чем `Expiration`.

```csharp
// .NET 11 - global defaults
builder.Services.AddHybridCache(options =>
{
    options.MaximumPayloadBytes = 1024 * 1024; // 1 MB, the default
    options.MaximumKeyLength = 1024;           // chars, the default
    options.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(5),       // L2 + overall
        LocalCacheExpiration = TimeSpan.FromMinutes(1) // L1 only
    };
});
```

Держать `LocalCacheExpiration` короче, чем `Expiration`, -- это осознанный приём: он ограничивает, как долго один сервер может отдавать устаревшие данные из собственной памяти, при этом позволяя Redis хранить значение дольше для совместного использования между серверами. Короткий L1 плюс более длинный L2 означает, что окно устаревания одного сервера мало, но кластер в целом всё равно избегает базы данных. Вы можете переопределить эти значения для каждого вызова, передав `HybridCacheEntryOptions` в `GetOrCreateAsync`.

Свойство `Flags` в `HybridCacheEntryOptions` позволяет отключить уровень для конкретной записи, например `HybridCacheEntryFlags.DisableLocalCacheWrite`, чтобы пропустить L1 для редко читаемого, но большого значения, или `DisableDistributedCache`, чтобы держать что-то только в процессе. Прибегайте к этим опциям хирургически; значения по умолчанию верны для большинства записей.

## Инвалидация по ключу и по тегу

Когда лежащие в основе данные меняются, удалите запись. По ключу:

```csharp
await cache.RemoveAsync($"product:{id}", ct);
```

Теги -- более мощный инструмент. Прикрепите теги при создании записи, а затем инвалидируйте целую группу одним вызовом:

```csharp
// .NET 11, C# 14
public async Task<Product?> GetProductAsync(int id, CancellationToken ct = default)
{
    var options = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(10),
        LocalCacheExpiration = TimeSpan.FromMinutes(2)
    };
    var tags = new[] { "products", $"category:{await GetCategoryAsync(id, ct)}" };

    return await cache.GetOrCreateAsync(
        $"product:{id}",
        async cancel => await db.Products
            .AsNoTracking()
            .FirstOrDefaultAsync(p => p.Id == id, cancel),
        options,
        tags,
        cancellationToken: ct);
}

// Invalidate every product in one category after a bulk price update
public ValueTask InvalidateCategoryAsync(int categoryId, CancellationToken ct = default)
    => cache.RemoveByTagAsync($"category:{categoryId}", ct);
```

Это заменяет старый приём отслеживания того, какие ключи принадлежат какой группе, в отдельном словаре. `RemoveByTagAsync("products")` инвалидирует всё, помеченное тегом `products`, одним вызовом. Есть подстановочный знак: `RemoveByTagAsync("*")` логически инвалидирует весь кеш, даже записи без тегов. Сопоставление по glob не поддерживается, поэтому `RemoveByTagAsync("foo*")` не удаляет ключи, начинающиеся с `foo`.

Вот нюанс, который удивляет людей. Ни `IMemoryCache`, ни `IDistributedCache` не понимают теги, поэтому инвалидация по тегу -- это логическая операция, а не физическое удаление. HybridCache не лезет в Redis и не удаляет помеченные ключи. Вместо этого он фиксирует, что тег был инвалидирован, и при следующем чтении любой записи с этим тегом трактует значение как промах и заново его получает. Байты остаются в Redis и в памяти, пока не истекут естественным образом. Для корректности это нормально. Для учёта памяти Redis это означает, что инвалидация по тегу не освобождает место немедленно.

## Подвох с несколькими экземплярами, на который попадаются все

Прочитайте это дважды, если вы запускаете более одного сервера. Когда вы вызываете `RemoveAsync` или `RemoveByTagAsync`, запись инвалидируется на текущем сервере и в L2 (Redis). Она не инвалидируется в L1 (память в процессе) других серверов. Каждый из этих серверов будет продолжать отдавать свою собственную кешированную копию, пока эта копия не исчерпает свой `LocalCacheExpiration`.

Так что если у вас пять серверов и вы удаляете `product:42` на сервере A, серверы с B по E всё ещё могут возвращать старый продукт из своей локальной памяти на протяжении до `LocalCacheExpiration`. Это самая важная причина держать `LocalCacheExpiration` коротким для данных, которые инвалидируются явно. Если вам нужна почти мгновенная межсерверная инвалидация, вам придётся транслировать её самостоятельно, например сообщением publish/subscribe Redis, которое каждый сервер обрабатывает, вызывая свой собственный `RemoveAsync`. HybridCache не выполняет это распространение за вас из коробки.

## Сериализация и большие объекты

Для хранения в L2 значения должны сериализоваться. HybridCache обрабатывает `string` и `byte[]` внутренне и по умолчанию использует `System.Text.Json` для всего остального. Вы можете подставить типизированный или универсальный сериализатор (protobuf, MessagePack, XML), сцепив его с `AddHybridCache`:

```csharp
// .NET 11 - custom serializer for one type
builder.Services
    .AddHybridCache()
    .AddSerializer<Product, ProtobufProductSerializer>();
```

Два предела, которые стоит запомнить. `MaximumPayloadBytes` по умолчанию равен 1 МБ; значения больше этого логируются и молча не кешируются, поэтому слишком большой объект становится постоянным промахом, который всегда попадает в вашу фабрику. `MaximumKeyLength` по умолчанию равен 1024 символам; более длинные ключи полностью обходят кеш. Если вы строите ключи из пользовательского ввода, ограничьте их длину и никогда не доверяйте сырым пользовательским строкам в качестве ключей, как для того, чтобы оставаться под пределом, так и для того, чтобы избежать атаки отказа в обслуживании путём затопления кеша.

Если ваш кешируемый тип неизменяем, вы можете сказать HybridCache пропускать защитную десериализацию на каждый вызов и отдавать общий экземпляр, что сокращает нагрузку на процессор и выделения для больших или горячих объектов. Пометьте тип как `sealed` и примените `[ImmutableObject(true)]`:

```csharp
// .NET 11, C# 14 - safe to reuse the same instance across callers
[ImmutableObject(true)]
public sealed record Product(int Id, string Name, decimal Price);
```

Делайте это только тогда, когда объект действительно никогда не изменяется после создания; иначе вы заново вводите ошибки конкурентности, от которых вас защищает поведение по умолчанию. Конкретно для Redis пакет `Microsoft.Extensions.Caching.StackExchangeRedis` может реализовать `IBufferDistributedCache`, что позволяет HybridCache избегать выделений `byte[]` на пути L2. Это стоит включить на сервисах с высокой пропускной способностью.

## Где HybridCache встаёт рядом с тем, что вы уже используете

HybridCache не заменяет ни `IMemoryCache`, ни `IDistributedCache`; он располагается поверх них и оркеструет оба. Если вы всё ещё пишете cache-aside вручную поверх `IMemoryCache` или наблюдаете за коэффициентом попаданий в кеш с помощью нового встроенного счётчика, описанного в [первоклассных метриках OpenTelemetry для MemoryCache в .NET 11](/ru/2026/06/dotnet-11-memorycache-opentelemetry-metrics/), HybridCache -- это слой, который связывает уровни в процессе и распределённый одним согласованным API. Он естественно сочетается с историей устойчивости в [Polly против встроенных обработчиков устойчивости в .NET 11](/ru/2026/05/polly-vs-resilience-handlers-in-dotnet-11/), поскольку и кеширование, и повтор защищают медленную зависимость.

Кеширование -- также самое дешёвое решение проблем запросов, которые вы можете увидеть в [обнаружении запросов N+1 в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): как только запрос корректен, кеширование его результата убирает его с горячего пути, что дополняет [скомпилированные запросы для горячих путей EF Core](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). А поскольку сериализация L2 по умолчанию идёт через `System.Text.Json`, те же правила из [написания пользовательского JsonConverter в System.Text.Json](/ru/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) применимы к чему угодно, что вы кешируете и что требует пользовательской сериализации.

Ментальная модель, которую стоит удержать: HybridCache даёт вам двухуровневый кеш, защиту от лавины на каждый сервер и логическую инвалидацию по тегам, всё за `GetOrCreateAsync`. Redis становится L2 в тот момент, когда вы регистрируете `IDistributedCache`. Две вещи, которые он не делает, -- single-flight на уровне кластера и межсерверная инвалидация L1 -- это именно те две вещи, вокруг которых стоит проектировать: с коротким `LocalCacheExpiration` и, если нужно, вашей собственной инвалидацией через publish/subscribe.

## Источники

- [Библиотека HybridCache в ASP.NET Core, Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid?view=aspnetcore-10.0)
- [Hello HybridCache! Streamlining Cache Management for ASP.NET Core Applications, .NET Blog](https://devblogs.microsoft.com/dotnet/hybrid-cache-is-now-ga/)
- [Справочник по API IBufferDistributedCache](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.caching.distributed.ibufferdistributedcache)
- [Интеграция FusionCache с HybridCache](https://github.com/ZiggyCreatures/FusionCache/blob/main/docs/MicrosoftHybridCache.md)
</content>
