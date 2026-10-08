---
title: "AddDbContextPool или AddDbContextFactory для параллельного выполнения запросов EF Core"
description: "AddDbContextPool выдаёт один scoped DbContext на область DI, поэтому не может выполнять два запроса одновременно. AddDbContextFactory и AddPooledDbContextFactory дают контекст на каждый вызов, а именно это нужно параллельным запросам. Замеры на EF Core 11 RC 1: пулированная фабрика создаёт контекст за 342 нс и 40 Б против 17 мкс и 44 КБ."
pubDate: 2026-10-08
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "dependency-injection"
lang: "ru"
translationOf: "2026/10/adddbcontextpool-vs-adddbcontextfactory-for-running-ef-core-queries-in-parallel"
translatedBy: "claude"
translationDate: 2026-10-08
---

Если вы хотите выполнять запросы EF Core параллельно, одного `AddDbContextPool` недостаточно: он регистрирует ваш `DbContext` как scoped-сервис, поэтому всё в рамках одного запроса (одной области DI) использует единственный экземпляр, а один `DbContext` не может выполнять две операции одновременно. `AddDbContextFactory` регистрирует singleton `IDbContextFactory<T>`, который выдаёт новый контекст на каждый вызов, и это ровно та форма, которая нужна для `Task.WhenAll`. Если нужно и то и другое, регистрируйте `AddPooledDbContextFactory`: это тот же API фабрики поверх того же пула, который использует `AddDbContextPool`, так что каждая параллельная ветка берёт собственный переиспользованный экземпляр.

Всё ниже измерено на EF Core 11.0.0-rc.1.26425.128 с SDK 11.0.100-rc.1.26425.128 и `Microsoft.EntityFrameworkCore.Sqlite` на Apple M4. Тот же набор тестов я прогнал на EF Core 10.0.12 с .NET 10.0.10: регистрации, поведение переиспользования и размер пула совпали, а время оказалось в том же диапазоне (14.3 мкс и 43 КБ на непулированный контекст, 357 нс и 40 Б на пулированный).

## Сравнение в одной таблице

| | `AddDbContextPool<T>` | `AddDbContextFactory<T>` | `AddPooledDbContextFactory<T>` |
| --- | --- | --- | --- |
| Что внедряется | `T` (scoped) | `IDbContextFactory<T>` (singleton) | `IDbContextFactory<T>` (singleton) |
| Также регистрирует `T` как scoped | Да, это основной сервис | Да | Да |
| Контекстов на область DI | 1 | Сколько создадите | Сколько создадите |
| Безопасно для `Task.WhenAll` в одном запросе | Нет | Да | Да |
| Экземпляры переиспользуются после `Dispose` | Да | Нет | Да |
| Стоимость создания и освобождения (замер) | н/д через область DI | 17,250 ns, 44,888 B | 342 ns, 40 B |
| Конструктор может принимать scoped-сервисы | Нет | Да | Нет |
| `OnConfiguring` выполняется | Один раз на пулированный экземпляр | Для каждого экземпляра | Один раз на пулированный экземпляр |
| Размер пула по умолчанию | 1024 | н/д | 1024 |

Строка про безопасность в параллельном режиме и есть тема этого поста, и определяется она временем жизни, а не пулингом. Пулинг определяет лишь то, насколько дорог каждый контекст.

## Почему один DbContext не может выполнять два запроса одновременно

`DbContext` владеет трекером изменений, подключением и, во время запроса, открытым ридером данных. Ничто из этого не потокобезопасно, и EF Core даже не пытается это исправить. Вместо этого у него есть детектор параллелизма, который выбрасывает исключение, как только вторая операция стартует при незавершённой первой. Это исключение я подробно разобрал в [посте про "A second operation was started on this context instance"](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/), но здесь важна короткая версия: параллелизм в EF Core всегда означает один контекст на каждую параллельную операцию.

Именно здесь `AddDbContextPool` сбивает людей с толку. Кажется, что он должен помогать с параллелизмом ("пул контекстов"), но пул разделяется между областями, а не внутри одной. Вот что на самом деле лежит в контейнере после каждого вызова, выгрузка из `ServiceCollection` на EF Core 11 RC 1:

```text
--- AddDbContextPool
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Scoped    IScopedDbContextLease<AppDb>
  Scoped    AppDb
--- AddDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextFactorySource<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
--- AddPooledDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
```

При `AddDbContextPool` сервис `AppDb` имеет время жизни scoped и берётся из пула через `IScopedDbContextLease<AppDb>`. Разрешите его дважды в одной области и получите один и тот же объект. `IDbContextFactory<AppDb>` в контейнере нет вообще, так что запросить второй экземпляр тоже не получится.

## Параллельный запрос, который падает с AddDbContextPool

Вот минимальный пример. Контроллер или endpoint минимального API получает scoped-контекст и пытается разветвить работу:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextPool<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (AppDb db) =>
{
    // Both queries use the same pooled instance: this throws.
    var ordersTask = db.Orders.CountAsync();
    var customersTask = db.Customers.CountAsync();
    await Task.WhenAll(ordersTask, customersTask);
    return new { Orders = ordersTask.Result, Customers = customersTask.Result };
});
```

На SQL Server или PostgreSQL, где асинхронные вызовы по-настоящему уступают управление на время ожидания сети, второй запрос стартует до завершения первого, и EF Core выбрасывает исключение:

```text
InvalidOperationException: A second operation was started on this context instance
before a previous operation completed. This is usually caused by different threads
concurrently using the same instance of DbContext.
```

Две детали из тестов. Во-первых, асинхронные методы SQLite завершаются синхронно, поэтому наивная версия выше на SQLite не пересекается во времени и "работает", а значит набор тестов на SQLite плохо ловит эту ошибку. Чтобы запросы пересеклись, мне пришлось обернуть оба в `Task.Run`. Во-вторых, если гонка случается при самом первом использовании свежего контекста, вы получите другое сообщение, "An attempt was made to use the context instance while it is being configured", потому что оба потока пытаются инициализировать контекст одновременно. Та же ошибка, то же исправление.

## Ветвление запросов с AddDbContextFactory

Версия с фабрикой даёт каждой ветке собственный экземпляр:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (IDbContextFactory<AppDb> factory, CancellationToken ct) =>
{
    async Task<int> CountOrders()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Orders.CountAsync(ct);
    }

    async Task<int> CountCustomers()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Customers.CountAsync(ct);
    }

    var orders = CountOrders();
    var customers = CountCustomers();
    await Task.WhenAll(orders, customers);
    return new { Orders = orders.Result, Customers = customers.Result };
});
```

Каждая локальная функция создаёт контекст, выполняет один запрос и освобождает его. Ничего не разделяется, поэтому гоняться не за что. В моём тестовом наборе та же схема с четырьмя ветками (`Task.WhenAll` над четырьмя вызовами `CountAsync`, по одному на регион) при каждом запуске возвращала `250,250,250,250`.

Обратите внимание, что `AddDbContextFactory` также зарегистрировал `AppDb` как scoped. Существующий код, который внедряет `AppDb` напрямую, продолжает работать, так что регистрацию можно заменить, не трогая каждый конструктор в приложении, а фабрику должны принимать только endpoints, которые ветвят работу.

## AddPooledDbContextFactory: и то и другое сразу

`AddDbContextFactory` создаёт совершенно новый контекст при каждом вызове `CreateDbContext`. Обычно эта стоимость мала по сравнению с обращением к базе данных, но на нагруженном endpoint, который разветвляется на пять или десять запросов, она складывается. `AddPooledDbContextFactory` сохраняет форму фабрики, но берёт экземпляры из пула:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddPooledDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

Вызывающий код идентичен коду из предыдущего раздела, потому что вы по-прежнему внедряете `IDbContextFactory<AppDb>`. Реализация за ним теперь `PooledDbContextFactory<AppDb>` вместо `DbContextFactory<AppDb>`, а `Dispose` возвращает экземпляр в пул, а не выбрасывает его. Я проверил это напрямую: создаём контекст, освобождаем, создаём другой, и `ReferenceEquals` возвращает `true` для пулированной фабрики и `false` для обычной.

Вот что это даёт, измерено простым циклом (200,000 итераций для создания и освобождения, 20,000 для создания, запроса и освобождения, с прогревом, один поток, для аллокаций `GC.GetAllocatedBytesForCurrentThread`):

| Операция | `AddDbContextFactory` | `AddPooledDbContextFactory` |
| --- | --- | --- |
| `CreateDbContext` + обращение к `Model` + `Dispose` | 17,250 ns, 44,888 B | 342 ns, 40 B |
| Создание + `FirstOrDefault` по ключу (SQLite, без отслеживания) + `Dispose` | 49.7 us, 62,461 B | 20.0 us, 11,710 B |

Это цифры для локального файла SQLite, где работа самой базы почти бесплатна, а настройка контекста доминирует. На реальном SQL Server по сети время запроса заглушит эти 17 мкс, поэтому официальная документация описывает пулинг как средство для "high-performance scenarios". Разница в аллокациях при этом не уменьшается с задержкой: 44 КБ мусора на контекст, умноженные на десять параллельных веток и на вашу частоту запросов, это реальное давление на сборщик мусора. [Документация EF Core по расширенной производительности](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics) приводит ту же картину для SQL Server: 50.38 КБ аллокаций без пулинга против 4.63 КБ с ним.

Та же документация отмечает, что разрешение пулированного контекста через DI "incurs a slight overhead" по сравнению с прямым вызовом пулированной фабрики, так что фабрика быстрее из двух пулированных вариантов, даже когда параллелизм не нужен.

## Можно зарегистрировать оба и делить один пул

Выбирать не обязательно. Вызов `AddDbContextPool<AppDb>`, а затем `AddPooledDbContextFactory<AppDb>` с теми же параметрами работает, и они делят один `IDbContextPool<AppDb>`. Я проверил это так: взял контекст из фабрики, освободил его, затем разрешил `AppDb` из новой области, и это был тот же экземпляр. Так большая часть приложения внедряет `AppDb` как обычно, а несколько endpoints с ветвлением внедряют фабрику, и платить за два пула не приходится.

В EF Core 11 есть также перегрузка `AddPooledDbContextFactory<T>()` без параметров, которая читает конфигурацию из `OnConfiguring` самого контекста; я описывал её в [посте про EF Core 11 Preview 3, RemoveDbContext и пулированную фабрику](/ru/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).

## Параллелизм ограничивает не пул контекстов, а пул подключений

Размер `poolSize` по умолчанию равен 1024 и для `AddDbContextPool`, и для `AddPooledDbContextFactory`. Это максимальное число экземпляров, которые пул хранит, а не максимум живых экземпляров. Когда я задал `poolSize: 2` и взял пять контекстов одновременно, я получил пять разных экземпляров. После освобождения всех пяти и повторного взятия пяти ровно два вернулись из первой партии. Иными словами, при переполнении создаются новые контексты, а лишние при возврате просто отбрасываются. Пул никогда не блокирует.

Реальный потолок для параллельных запросов задаёт пул подключений ADO.NET под ним. EF Core открывает подключение прямо перед каждым запросом и закрывает сразу после, и каждому параллельному запросу нужно своё подключение. У `Microsoft.Data.SqlClient` по умолчанию `Max Pool Size=100`, у Npgsql тоже 100. Разветвите 20 запросов на запрос при 10 одновременных запросах, и вы уже ждёте подключений, что проявляется как тайм-аут получения подключения из пула, а не как ошибка EF. Если вы ветвите работу по списку идентификаторов, ограничивайте степень параллелизма через `Parallel.ForEachAsync`, а не бросайте всё в `Task.WhenAll`; компромиссы разобраны в [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/ru/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
await Parallel.ForEachAsync(regionIds,
    new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },
    async (regionId, token) =>
    {
        await using var db = await factory.CreateDbContextAsync(token);
        totals[regionId] = await db.Orders
            .Where(o => o.RegionId == regionId)
            .SumAsync(o => o.Total, token);
    });
```

`totals` здесь должен быть `ConcurrentDictionary<int, decimal>` или массивом заранее нужного размера, поскольку тело цикла выполняется параллельно.

## Подводные камни, которые касаются только пулированных вариантов

### Scoped-зависимости конструктора разрешаются из корневого провайдера

Это меня удивило. Пулированный контекст создаётся один раз и переиспользуется между областями, поэтому его зависимости в конструкторе не могут приходить из области запроса. В EF Core 11 RC 1 пулированный контекст с конструктором вида `TenantDb(DbContextOptions<TenantDb> options, Tenant tenant)`, где `Tenant` имеет время жизни scoped, ведёт себя так:

- При включённой проверке областей (по умолчанию в среде `Development`) его разрешение выбрасывает `InvalidOperationException: Cannot resolve scoped service 'Tenant' from root provider.`
- При выключенной проверке областей (по умолчанию в `Production`) всё молча проходит. Контекст получает экземпляр `Tenant` из корневого провайдера, который не совпадает с `Tenant`, разрешаемым областью запроса, и тот же захваченный экземпляр сопровождает пулированный контекст во все последующие запросы.

Так ошибка, которую вы никогда не видите локально, превращается в утечку данных между арендаторами в продакшене. У обычного `AddDbContextFactory` такой проблемы нет, потому что он каждый раз строит новый контекст. Если нужно состояние на запрос вместе с пулингом, документированный шаблон такой: scoped-обёртка над фабрикой, которая берёт контекст из пулированной фабрики и выставляет свойство:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public sealed class TenantDbFactory(
    IDbContextFactory<TenantDb> pooled, ITenant tenant) : IDbContextFactory<TenantDb>
{
    public TenantDb CreateDbContext()
    {
        var db = pooled.CreateDbContext();
        db.TenantId = tenant.Id; // reset on every rent, never trust the previous value
        return db;
    }
}

builder.Services.AddPooledDbContextFactory<TenantDb>(o => o.UseSqlServer(cs));
builder.Services.AddScoped<TenantDbFactory>();
```

Та же ловушка со scoped-сервисом в singleton встречается и за пределами EF; [пост про "Cannot consume scoped service from singleton"](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/) объясняет, почему контейнер это отвергает.

### Ваши собственные поля не сбрасываются

EF Core сбрасывает собственное состояние, когда пулированный контекст возвращается: трекер изменений очищается (я добавил сущность, освободил контекст, взял снова, и `ChangeTracker.Entries()` был пуст). Поля и свойства, которые вы добавили в подкласс `DbContext`, не затрагиваются. `public string? Note`, которому я присвоил `"dirty"` перед освобождением, при следующем взятии всё ещё содержал `"dirty"`. Всё, что относится к запросу, нужно присваивать при каждом взятии, как в обёртке выше. То же относится к `DbConnection`, который вы открыли вручную: закройте его до возврата контекста.

### OnConfiguring выполняется один раз

Поскольку экземпляр переиспользуется, `OnConfiguring` выполняется только при первом создании пулированного экземпляра. Не читайте там текущего пользователя, арендатора или культуру.

### Возвращает экземпляр именно Dispose

С пулированной фабрикой контекст, который вы забыли освободить, никогда не возвращается. Это не утечка в классическом смысле, поскольку сборщик мусора его всё равно соберёт, но вы теряете выгоду пулинга, и пул тихо наполняется новыми экземплярами. Всегда используйте `await using`.

## Что выбрать

- **Только последовательные запросы, обычное приложение**: `AddDbContext` или `AddDbContextPool`. Внедряйте `AppDb`, ожидайте каждый запрос по очереди. Пулинг даёт дешёвый выигрыш, если у контекста нет зависимостей в конструкторе и состояния на запрос.
- **Некоторые endpoints ветвят работу параллельно**: регистрируйте `AddPooledDbContextFactory` (или `AddDbContextPool` плюс `AddPooledDbContextFactory` с теми же параметрами). Внедряйте `AppDb` там, где работа последовательная, и `IDbContextFactory<AppDb>` там, где ветвите.
- **Контексту нужны scoped-сервисы в конструкторе**: `AddDbContextFactory` без пулинга. Либо перенесите это состояние в свойство, которое выставляет scoped-обёртка, и сохраните пулинг.
- **Singleton-сервисы, hosted-сервисы, компоненты Blazor Server**: фабрика, по причинам из [поста про использование IDbContextFactory из singleton в Blazor](/ru/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/). Пулированная, если контекст это позволяет.

Последняя альтернатива, если вы уже используете `AddDbContextPool` и не хотите второй регистрации: создавайте дочернюю область на каждую параллельную ветку через `IServiceScopeFactory.CreateAsyncScope()` и разрешайте из неё `AppDb`. Каждая область берёт из пула собственный экземпляр, и мой тест с четырьмя ветками вернул те же `250,250,250,250`. Это работает, но церемоний больше, чем при внедрении фабрики, и каждая ветка к тому же разрешает всё остальное в этой области.

Практическое правило: параллелизму нужен контекст на каждую операцию, и напрямую его дают только две фабрики. Пулинг решает независимый вопрос, насколько дёшев каждый из этих контекстов, и в EF Core 11 пулированная фабрика делает создание примерно в 50 раз дешевле, пока в конструкторе контекста нет состояния на запрос.

## Источники

- [Advanced Performance Topics: DbContext pooling (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [DbContext Lifetime, Configuration, and Initialization: using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)
- [`EntityFrameworkServiceCollectionExtensions` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions)
- [Sample: AspNetContextPoolingWithState (dotnet/EntityFramework.Docs)](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Performance/AspNetContextPoolingWithState)
- [SQL Server connection pooling (ADO.NET)](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql-server-connection-pooling)
