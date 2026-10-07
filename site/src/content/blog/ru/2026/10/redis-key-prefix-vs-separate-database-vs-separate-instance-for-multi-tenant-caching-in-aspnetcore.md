---
title: "Префикс ключа, отдельная база данных или отдельный экземпляр Redis для мультитенантного кеширования в ASP.NET Core"
description: "Почти для любого мультитенантного приложения ASP.NET Core используйте префикс тенанта на одном общем Redis, выносите на отдельный экземпляр только тенантов с договорными требованиями к изоляции или шумной нагрузкой и не используйте нумерованные базы данных: Redis Cluster, Azure Managed Redis и Redis Cloud поддерживают только базу 0."
pubDate: 2026-10-07
template: vs
tags:
  - "comparison"
  - "redis"
  - "aspnetcore"
  - "dotnet"
  - "caching"
  - "multi-tenancy"
lang: "ru"
translationOf: "2026/10/redis-key-prefix-vs-separate-database-vs-separate-instance-for-multi-tenant-caching-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-10-07
---

Для мультитенантного приложения ASP.NET Core поместите всех тенантов на один общий Redis и изолируйте их префиксом ключа вроде `t:{tenantId}:`. Это работает на любой топологии Redis, напрямую подключается к `HybridCache` и `IDistributedCache`, а сам префикс всё равно нужен, потому что внутрипроцессный L1 у `HybridCache` общий для всех тенантов. Выделяйте тенанту собственный экземпляр Redis только тогда, когда этого требуют договор, граница соответствия нормативным требованиям или шумная нагрузка. Избегайте нумерованных баз данных (`SELECT 3`): Redis Cluster, Azure Managed Redis и Redis Cloud поддерживают только базу 0, а изоляция, которую они дают, слабее, чем кажется.

Всё ниже проверено компиляцией на .NET SDK 10.0.302 с целевой платформой `net10.0`, с пакетами `Microsoft.Extensions.Caching.StackExchangeRedis` 10.0.12, `Microsoft.Extensions.Caching.Hybrid` 10.10.0 и `StackExchange.Redis` 3.3.1. Те же API есть в пакетах 11.0.0-rc.1 для .NET 11.

## Три варианта бок о бок

| | Префикс ключа, общий экземпляр | Нумерованная база данных на тенанта | Экземпляр на тенанта |
| --- | --- | --- | --- |
| Как разделяются тенанты | `t:42:` перед каждым ключом | `SELECT 42` в подключении | Разные хосты и учётные данные |
| Работает на Redis Cluster / Azure Managed Redis / Redis Cloud | Да | Нет, только база 0 | Да |
| Максимум тенантов | Не ограничен | 16 по умолчанию (настройка `databases`) | Ваш бюджет |
| Лимит памяти и вытеснение | Общие | Общие (`maxmemory` задаётся на сервер) | Раздельные |
| Изоляция CPU и задержки | Нет | Нет | Полная |
| Контроль доступа по тенантам | Шаблоны ключей ACL `~t:42:*` (Redis 7+) | Только Valkey 9.1+ (правило `db=`) | Раздельные учётные данные |
| Очистка одного тенанта | `SCAN` + `DEL` или тег `HybridCache` | `FLUSHDB` | Удалить экземпляр |
| Работает с одним `AddHybridCache()` | Да | Нужен маршрутизирующий `IDistributedCache` | Нужен маршрутизирующий `IDistributedCache` |
| Подключения на экземпляр приложения | 1 мультиплексор | 1 мультиплексор на каждую используемую базу | 1 мультиплексор на тенанта |
| Стоимость | Самая низкая | Самая низкая | Самая высокая |

Нумерованные базы данных выглядят золотой серединой. На практике они разделяют с подходом на префиксах все важные ограничения и добавляют собственные, которых у префиксов нет.

## Почему нумерованные базы данных являются ловушкой

Собственная [документация по `SELECT`](https://redis.io/docs/latest/commands/select/) у Redis говорит прямо: базы данных нужны для разделения ключей "within the same application", а не для запуска несвязанных нагрузок на одном сервере. Затем там добавлено, что "Redis Cluster only supports database zero". Одна эта фраза исключает значительную часть рынка управляемых сервисов:

- **Azure Managed Redis** "internally configured to use clustering, across all tiers and SKUs" согласно [странице об архитектуре](https://learn.microsoft.com/en-us/azure/redis/architecture) и работает на Redis Enterprise.
- **Redis Software и Redis Cloud** вообще не поддерживают общие базы данных. На странице `SELECT` сказано, что команда "supported solely for compatibility" и там ничего не выполняет. Если ваш код полагается на `SELECT` для изоляции и вы переезжаете на один из этих сервисов, все тенанты молча окажутся в одном пространстве ключей. Это худший возможный сценарий отказа для мультитенантности: ошибок нет, просто данные утекают между тенантами.
- **Redis OSS в режиме кластера** (включая большинство управляемых предложений с режимом кластера) отклоняет всё, кроме базы 0.

Единственное исключение, Valkey: в [Valkey 9.0](https://www.linuxfoundation.org/press/valkey-9.0-delivers-performance-and-resiliency-for-real-time-workloads) добавили нумерованные базы данных в режиме кластера, а [Valkey 9.1 добавил правила ACL `db=`](https://valkey.io/commands/acl-setuser/), так что пользователя можно ограничить определёнными базами. Если вы используете Valkey 9.1+ и не планируете с него уходить, базы данных становятся оправданными. Во всех остальных случаях выбор баз данных привязывает вашу модель мультитенантности к одной топологии хостинга.

Даже там, где базы данных работают, они не изолируют то, из-за чего тенанты на самом деле конфликтуют. `maxmemory` и политика вытеснения применяются ко всему серверу, поэтому один тенант, заполняющий свою базу, вытесняет ключи всех остальных. Redis выполняет команды в одном главном потоке, поэтому тенант, запустивший медленный `KEYS *`, останавливает все базы. А при значении по умолчанию `databases 16` тенанты закончатся раньше, чем клиенты.

Другая практическая проблема находится на стороне .NET. `RedisCache`, реализация `IDistributedCache` за `AddStackExchangeRedisCache`, вызывает `connection.GetDatabase()` без аргументов, как видно в [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs). Он всегда работает с `DefaultDatabase` подключения. Чтобы попасть в базу 7, нужен `RedisCache`, созданный из `ConfigurationOptions` с `DefaultDatabase = 7`, то есть отдельный `ConnectionMultiplexer` на каждую используемую базу, а это именно те накладные расходы, которых общий мультиплексор должен был избежать.

## Подход с префиксом ключа, сделанный правильно

`RedisCacheOptions.InstanceName` описан как способ разделить "a single backend cache for use with multiple apps/services". Это префикс на уровне всего процесса, поэтому используйте его для имени приложения, а тенанта добавляйте в каждый ключ:

```csharp
// .NET 10, ASP.NET Core 10
// Microsoft.Extensions.Caching.StackExchangeRedis 10.0.12
// Microsoft.Extensions.Caching.Hybrid 10.10.0, StackExchange.Redis 3.3.1
using Microsoft.Extensions.Caching.Hybrid;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

var mux = await ConnectionMultiplexer.ConnectAsync(
    builder.Configuration.GetConnectionString("redis")!);
builder.Services.AddSingleton<IConnectionMultiplexer>(mux);

builder.Services.AddStackExchangeRedisCache(o =>
{
    // share the multiplexer instead of opening a second connection
    o.ConnectionMultiplexerFactory = () => Task.FromResult<IConnectionMultiplexer>(mux);
    o.InstanceName = "myapp:"; // note the trailing delimiter
});
builder.Services.AddHybridCache();

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ITenantContext, ClaimTenantContext>();
builder.Services.AddScoped<TenantCache>();

var app = builder.Build();

app.MapGet("/products/{id:int}", async (int id, TenantCache cache) =>
    await cache.GetOrCreateAsync($"product:{id}",
        ct => ValueTask.FromResult($"product {id}")));

app.Run();
```

Тенант берётся из доверенного источника, никогда из заголовка или строки запроса, которыми управляет клиент. Здесь это claim аутентифицированного пользователя:

```csharp
// .NET 10, C# 14
public interface ITenantContext { string TenantId { get; } }

public sealed class ClaimTenantContext(IHttpContextAccessor accessor) : ITenantContext
{
    public string TenantId =>
        accessor.HttpContext?.User.FindFirst("tenant_id")?.Value
        ?? throw new InvalidOperationException("No tenant on this request.");
}
```

Главное, что код приложения никогда не формирует сырой ключ кеша. Он идёт через обёртку в области видимости запроса, которая каждый раз добавляет тенанта, так что разработчик не сможет об этом забыть:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.Hybrid 10.10.0
public sealed class TenantCache(HybridCache cache, ITenantContext tenant)
{
    private string Key(string key) => $"t:{tenant.TenantId}:{key}";
    private string TenantTag => $"tenant:{tenant.TenantId}";

    public ValueTask<T> GetOrCreateAsync<T>(
        string key,
        Func<CancellationToken, ValueTask<T>> factory,
        HybridCacheEntryOptions? options = null,
        IEnumerable<string>? tags = null,
        CancellationToken ct = default) =>
        cache.GetOrCreateAsync(
            Key(key),
            factory,
            static (f, c) => f(c),
            options,
            [TenantTag, .. (tags ?? []).Select(t => $"{TenantTag}:{t}")],
            ct);

    public ValueTask RemoveAsync(string key, CancellationToken ct = default) =>
        cache.RemoveAsync(Key(key), ct);

    // logical wipe of everything this tenant cached
    public ValueTask InvalidateTenantAsync(CancellationToken ct = default) =>
        cache.RemoveByTagAsync(TenantTag, ct);
}
```

В Redis запись о продукте для тенанта 42 превращается в хеш `myapp:t:42:product:7`. Теги тоже получают префикс: теги `HybridCache` являются глобальными строками, поэтому вызов `RemoveByTagAsync("products")` без префикса от одного тенанта сделал бы недействительными записи продуктов всех тенантов.

Если вы используете `IDatabase` напрямую для счётчиков, блокировок или множеств, в StackExchange.Redis та же идея встроена через `StackExchange.Redis.KeyspaceIsolation`:

```csharp
// StackExchange.Redis 3.3.1
using StackExchange.Redis.KeyspaceIsolation;

IDatabase tenantDb = mux.GetDatabase().WithKeyPrefix($"myapp:t:{tenantId}:");
await tenantDb.StringIncrementAsync("logins"); // writes myapp:t:42:logins
```

## Проблема L1, которая решает спор

Вот деталь, которая делает префикс обязательным при любом выбранном варианте. `HybridCache` является двухуровневым кешем, а его L1 это внутрипроцессный `MemoryCache`, общий для всех запросов в процессе. Допустим, вы направляете тенанта 42 на его собственный экземпляр Redis и оставляете ключ кеша простым `product:7`. Поиск в L2 попадёт на правильный сервер, но поиск в L1 происходит первым, и `product:7` от тенанта 41 уже лежит в памяти. Тенант 42 получает продукт тенанта 41.

Так что отдельные базы данных и отдельные экземпляры не отменяют необходимость в ключах с привязкой к тенанту. Они добавляют второй механизм изоляции поверх того, который всё равно придётся построить. Когда префикс уже есть, остаётся лишь вопрос, нужно ли некоторым тенантам нечто большее, чем разделение на уровне ключей.

То же относится и к кешированию вывода. У `AddStackExchangeRedisOutputCache` есть собственный `InstanceName`, а ключ кеша должен зависеть от тенанта (`VaryByValue` по claim тенанта) независимо от того, где хранятся записи.

## Когда отдельный экземпляр является правильным решением

Отдельный Redis на каждого тенанта не вариант по умолчанию, но это законный уровень. Выбирайте его, когда:

- **Этого требует договор или регулятор.** Размещение данных в определённом регионе, ключ шифрования, управляемый клиентом, или условие "никакой общей инфраструктуры" в корпоративном соглашении. Префиксы ключей не удовлетворят аудитора, который спрашивает о физическом разделении.
- **Нагрузка одного тенанта достаточно велика, чтобы вредить остальным.** Тенант с 40 ГБ горячих данных или пакетным заданием со всплесками вытеснит ключи всех остальных при общем `maxmemory`. Вынос такого тенанта возвращает остальным предсказуемый процент попаданий.
- **Нужна политика вытеснения или сохранение данных для каждого тенанта.** Настройки `maxmemory-policy`, AOF и RDB действуют на весь сервер.
- **Отключение тенанта должно быть доказуемо полным.** Удаление экземпляра доказать проще, чем "мы просканировали и удалили каждый ключ".

Обычная схема это модель пула с премиальным выделением: все на общем экземпляре с префиксами, а короткий список тенантов сопоставлен выделенным экземплярам. Поскольку `AddHybridCache()` подключает ровно один L2, маршрутизация должна находиться в `IDistributedCache`, который выбирает бэкенд при каждом вызове:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.StackExchangeRedis 10.0.12
using System.Collections.Concurrent;
using Microsoft.Extensions.Caching.Distributed;
using Microsoft.Extensions.Caching.StackExchangeRedis;

public sealed class TenantRoutingCache(
    IHttpContextAccessor accessor,
    IConfiguration config,
    [FromKeyedServices("shared")] IDistributedCache shared) : IDistributedCache
{
    private readonly ConcurrentDictionary<string, IDistributedCache> _dedicated = new();

    private IDistributedCache Current()
    {
        var tenant = accessor.HttpContext?.User.FindFirst("tenant_id")?.Value;
        var cs = tenant is null ? null : config[$"Tenants:{tenant}:Redis"];
        if (cs is null) return shared;

        return _dedicated.GetOrAdd(tenant!, _ => new RedisCache(
            new RedisCacheOptions { Configuration = cs, InstanceName = "myapp:" }));
    }

    public byte[]? Get(string key) => Current().Get(key);
    public Task<byte[]?> GetAsync(string key, CancellationToken token = default) =>
        Current().GetAsync(key, token);
    public void Set(string key, byte[] value, DistributedCacheEntryOptions options) =>
        Current().Set(key, value, options);
    public Task SetAsync(string key, byte[] value, DistributedCacheEntryOptions options,
        CancellationToken token = default) => Current().SetAsync(key, value, options, token);
    public void Refresh(string key) => Current().Refresh(key);
    public Task RefreshAsync(string key, CancellationToken token = default) =>
        Current().RefreshAsync(key, token);
    public void Remove(string key) => Current().Remove(key);
    public Task RemoveAsync(string key, CancellationToken token = default) =>
        Current().RemoveAsync(key, token);
}
```

Зарегистрируйте общий `RedisCache` как сервис с ключом, а маршрутизатор как `IDistributedCache` без ключа, который разрешает `HybridCache`. Ключи по-прежнему несут префикс тенанта из `TenantCache`, что защищает L1. Об этом маршрутизаторе стоит знать две вещи: он зависит от `HttpContext`, поэтому фоновые задания должны задавать тенанта иным способом (подойдёт `AsyncLocal`, устанавливаемый исполнителем заданий), и он обходит быстрый путь `IBufferDistributedCache` у `RedisCache`, потому что реализует только базовый интерфейс. Для нескольких премиальных тенантов этот компромисс приемлем.

Каждый выделенный `RedisCache` владеет одним мультиплексором. Мультиплексор рассчитан на совместное использование и долгую жизнь, поэтому кешируйте эти экземпляры на всё время жизни процесса и никогда не создавайте их на каждый запрос. При 20 выделенных тенантах и 10 подах приложения вы держите 200 дополнительных подключений к Redis, и именно здесь модель экземпляра на тенанта перестаёт масштабироваться, поэтому она должна оставаться уровнем, а не вариантом по умолчанию.

## Подводные камни префиксов ключей

**Всегда заканчивайте префикс разделителем.** `RedisCache` склеивает `InstanceName` и ключ без разделителя. В [руководстве по ключам HybridCache](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid) приведён классический пример: `order{customerId}{orderId}` превращает клиента 42 с заказом 123 и клиента 421 с заказом 23 в один и тот же `order42123`. То же происходит с тенантами: тенант `7` с ключом `42:profile` и тенант `74` с ключом `2:profile` коллизируют, если писать `t{tenant}{key}`. Используйте `t:{tenant}:` и убедитесь, что идентификаторы тенантов не могут содержать `:`.

**Удаление ключей тенанта это сканирование, а не команда.** `RemoveByTagAsync($"tenant:{id}")` самый дешёвый вариант, но это логическая инвалидация: в документации сказано, что значения остаются в Redis "until they expire in the usual way". Когда данные нужно физически удалить (отключение тенанта, стирание по GDPR), сканируйте каждый первичный узел:

```csharp
// StackExchange.Redis 3.3.1
public static async Task<long> PurgeTenantAsync(IConnectionMultiplexer mux, string tenantId)
{
    var db = mux.GetDatabase();
    long deleted = 0;
    foreach (var endpoint in mux.GetEndPoints())
    {
        var server = mux.GetServer(endpoint);
        if (server.IsReplica) continue;

        await foreach (var key in server.KeysAsync(pattern: $"myapp:t:{tenantId}:*", pageSize: 500))
        {
            // one DEL per key: in a cluster, keys from one node can span many hash slots
            if (await db.KeyDeleteAsync(key)) deleted++;
        }
    }
    return deleted;
}
```

`KeysAsync` под капотом использует `SCAN`, а в кластере он видит только ключи на своём узле, поэтому цикл проходит по каждой конечной точке. [Документация StackExchange.Redis](https://seredis.dev/KeysScan) по-прежнему предостерегает от запуска этого на нагруженных рабочих серверах, поэтому делайте это в фоновом задании с умеренным размером страницы.

**Не используйте хеш-теги для тенантов.** Запись ключей как `{t:42}:product:7` заставляет все ключи тенанта попасть в один хеш-слот, что разрешает операции над несколькими ключами, но и привязывает всего тенанта к одному шарду. Ваш крупнейший тенант становится горячим шардом. Не заключайте тенанта в фигурные скобки, если вам действительно не нужны транзакции над несколькими ключами.

**Добавьте ACL, если у тенантов есть прямой доступ к Redis.** Обычно с Redis общается только ваше приложение, поэтому префикс обеспечивается ревью кода и обёрткой `TenantCache`. Если специфичный для тенанта воркер получает собственные учётные данные, шаблоны ключей ACL в Redis 7 применяют префикс на стороне сервера: `ACL SETUSER tenant42 on >secret ~myapp:t:42:* +@read +@write`.

**Длина префикса это накладные расходы на каждый ключ.** `myapp:t:` плюс идентификатор тенанта в виде GUID составляют 44 байта ещё до самого ключа. В кеше с десятками миллионов мелких записей это заметный объём памяти. Короткий целочисленный идентификатор или идентификатор в системе счисления с основанием 36 делает его пренебрежимым и удерживает вас далеко от лимита `MaximumKeyLength` в 1024 символа у `HybridCache`.

## Рекомендация и её причины

Используйте префикс ключа на общем Redis. Он работает на любой топологии, от локального контейнера до Azure Managed Redis с кластеризацией OSS, это единственный вариант, который сочетается с единственным вызовом `AddHybridCache()`, и тенант в любом случае должен быть в ключе из-за общего L1. Добавьте уровень выделенных экземпляров, маршрутизируемый через `IDistributedCache` вроде приведённого выше, для тенантов, чьи договоры или нагрузки оправдывают плату за изоляцию. Пропустите нумерованные базы данных, если только вы не привязаны к Valkey 9.1+: они дают `FLUSHDB` и подсчёт ключей по базам в `INFO keyspace`, но делят память и CPU со всеми остальными тенантами и исчезают в тот момент, когда вы переходите на кластерный или корпоративный Redis.

## Связанные материалы

- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/ru/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/) описывает базовую настройку, на которой строится эта статья.
- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/ru/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) объясняет разделение L1/L2, из-за которого ключи тенанта обязательны.
- [Output caching in a minimal API](/ru/2026/07/how-to-add-output-caching-to-a-minimal-api-in-aspnetcore-11/) показывает `VaryByValue` для записей кеша вывода по тенантам.
- [Keyed services in .NET dependency injection](/ru/2026/06/how-to-register-and-resolve-keyed-services-in-dotnet-11-dependency-injection/) показывает, как регистрируются рядом общий и маршрутизируемый кеши.
- [Named query filters in EF Core 11](/ru/2026/07/named-query-filters-vs-a-single-global-query-filter-in-ef-core-11/) это аналог изоляции тенантов на стороне базы данных.

## Источники

- [Команда Redis `SELECT`](https://redis.io/docs/latest/commands/select/), включая примечания о кластере и Redis Software.
- [Архитектура Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/architecture) для деталей о кластеризации и политике кластера.
- [Valkey `ACL SETUSER`](https://valkey.io/commands/acl-setuser/) для шаблонов ключей и правил `db=` в версии 9.1.
- [RedisCacheOptions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCacheOptions.cs) и [RedisCache.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Caching/StackExchangeRedis/src/RedisCache.cs) о том, как применяются `InstanceName` и база данных.
- [Библиотека HybridCache в ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/hybrid) для рекомендаций по ключам и семантики инвалидации по тегам.
- [StackExchange.Redis: KEYS, SCAN, FLUSHDB и др.](https://seredis.dev/KeysScan) о сканировании в кластерах.
