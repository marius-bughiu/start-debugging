---
title: "Исправление: A second operation was started on this context instance before a previous operation completed"
description: "EF Core выбрасывает это исключение, когда два await выполняются параллельно на одном DbContext. Ожидайте каждый вызов последовательно или получайте новый DbContext на каждую конкурентную единицу работы через IDbContextFactory."
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
lang: "ru"
translationOf: "2026/05/fix-second-operation-was-started-on-this-context-instance"
translatedBy: "claude"
translationDate: 2026-05-07
---

Решение: `DbContext` не является потокобезопасным, и в каждый момент на нём может быть в работе только один запрос, сохранение или обход отслеживателя изменений. Исключение означает, что две операции на одном экземпляре наложились, почти всегда потому что `Task` была запущена без `await`, тело `Parallel.ForEachAsync` разделяло контекст, или захваченное поле было затронуто двумя запросами одновременно. Либо ожидайте первый вызов прежде чем запускать второй, либо выдавайте каждой конкурентной единице работы свой собственный `DbContext` через `IDbContextFactory<T>`.

```text
System.InvalidOperationException: A second operation was started on this context instance before a previous operation completed. This is usually caused by different threads concurrently using the same instance of DbContext. For more information on how to avoid threading issues with DbContext, see https://go.microsoft.com/fwlink/?linkid=2097913.
   at Microsoft.EntityFrameworkCore.Internal.ConcurrencyDetector.EnterCriticalSection()
   at Microsoft.EntityFrameworkCore.Query.Internal.QueryCompiler.ExecuteAsync[TResult](Expression query, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.EntityQueryProvider.ExecuteAsync[TResult](Expression expression, CancellationToken cancellationToken)
   at System.Linq.AsyncEnumerable.ToListAsync[TSource](IAsyncEnumerable`1 source, CancellationToken cancellationToken)
```

Это руководство написано против .NET 11 preview 4 и `Microsoft.EntityFrameworkCore` 11.0.0-preview.4. Текст и лежащий в основе `ConcurrencyDetector` остаются неизменными со времён EF Core 2.0; меняются только внутренние детали окружающей трассы стека от релиза к релизу. Исключение выбрасывается из `ConcurrencyDetector.EnterCriticalSection`, который защищает каждый публичный асинхронный API на `DbContext`. Никакой гонки на стороне EF Core нет, детектор прав: он поймал, что вы пытаетесь прогнать две операции через одну карту идентичности и одну открытую команду.

## Почему DbContext однопоточный по дизайну

`DbContext` хранит приватную машину состояний: карту идентичности отслеживаемых сущностей, ожидающий список изменений, открытое `DbConnection`, и максимум одно `DbCommand` в работе. Провайдеры ADO.NET не разрешают две команды на одном соединении, если только не включён MARS, но даже с MARS мутации отслеживателя изменений между двумя запросами конкурировали бы друг с другом произвольным образом. Вместо того чтобы синхронизировать всё внутри и платить за это в каждом вызове, EF Core говорит нет: одна операция на экземпляр за раз. `ConcurrencyDetector` — это удобное для отладки принуждение к этому контракту, а не причина проблемы.

Этот контракт действует для каждого метода `*Async`: `ToListAsync`, `FirstOrDefaultAsync`, `SaveChangesAsync`, `AnyAsync`, `CountAsync`, `Database.ExecuteSqlAsync`, плюс синхронные братья, если вы подмешиваете `.Result` или `.GetAwaiter().GetResult()` в ту же точку вызова. Если две из них наложатся на одном `DbContext`, вторая выбросит.

## Минимальная репродукция

Самая короткая надёжная репродукция — `Task.WhenAll` на одном контексте:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class Report(AppDb db)
{
    public async Task<(int customers, int orders)> Counts()
    {
        var customersTask = db.Customers.CountAsync();
        var ordersTask = db.Orders.CountAsync();

        await Task.WhenAll(customersTask, ordersTask); // throws
        return (await customersTask, await ordersTask);
    }
}
```

Оба вызова `CountAsync` стартуют почти одновременно; второй входит в `ConcurrencyDetector.EnterCriticalSection`, пока первый ещё внутри, и детектор выбрасывает. Решение — не вводить блокировки, а признать, что вам нужны были две независимые единицы работы, а инструмент был только один.

Более тонкая репродукция — забытый `await`:

```csharp
// .NET 11, EF Core 11.0.0 -- still wrong
public async Task ProcessOrder(int id)
{
    var orderTask = db.Orders.FirstOrDefaultAsync(o => o.Id == id);
    var auditTask = db.AuditLog.AddAsync(new AuditEntry(id)); // no await
    await db.SaveChangesAsync(); // throws
}
```

`AddAsync` возвращает `ValueTask`. Без ожидания вы фактически не закончили добавление, но вызов уже коснулся отслеживателя изменений. Затем `SaveChangesAsync` запускается против отслеживателя посреди мутации, и детектор срабатывает. Та же первопричина: две операции накладываются на одном экземпляре.

## Три решения, в порядке приоритета

Применяйте их в этом порядке. Первое — правильный ответ в 90% случаев; третье — аварийный выход для действительно конкурентной работы.

### 1. Ожидайте последовательно, когда вам нужно только одно соединение

Если вам на самом деле не нужно, чтобы запросы шли параллельно, не запускайте их параллельно. Затраты по часам на два последовательных вызова `CountAsync` редко стоят бага:

```csharp
// .NET 11, EF Core 11.0.0
public async Task<(int customers, int orders)> Counts()
{
    var customers = await db.Customers.CountAsync();
    var orders = await db.Orders.CountAsync();
    return (customers, orders);
}
```

Для одного обработчика запроса, разговаривающего с одной базой данных, это почти всегда верно. Второй запрос идёт по тому же уже открытому соединению, так что нет затрат на второй round-trip помимо самого запроса. Прибегайте к параллелизму только тогда, когда измерили, что два запроса к одному и тому же бэкенду экономят реальное время, что встречается редко, потому что сама база данных всё равно сериализует команды по соединению.

### 2. Используйте IDbContextFactory для действительно конкурентных единиц работы

Когда вам нужно, чтобы два запроса шли одновременно (чаще всего в `BackgroundService`, задаче `Hangfire`, CLI-инструменте, обрабатывающем батчи, или сценариях fan-out), выдавайте каждой задаче свой собственный `DbContext`:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class Report(IDbContextFactory<AppDb> factory)
{
    public async Task<(int customers, int orders)> Counts()
    {
        var customersTask = CountAsync(db => db.Customers);
        var ordersTask = CountAsync(db => db.Orders);

        await Task.WhenAll(customersTask, ordersTask);
        return (await customersTask, await ordersTask);
    }

    private async Task<int> CountAsync<T>(Func<AppDb, IQueryable<T>> set)
    {
        await using var db = await factory.CreateDbContextAsync();
        return await set(db).CountAsync();
    }
}
```

Каждая конкурентная операция теперь получает свой собственный контекст, своё собственное соединение из пула и свой собственный отслеживатель изменений. Нет разделяемого изменяемого состояния, так что детектору не на что жаловаться. `AddDbContextFactory` — это поддерживаемая регистрация; не пытайтесь вручную делать `new` для `DbContext`, чтобы обойти жизненный цикл, это обходит разрешение опций и пулинг.

Если вам также нужны экземпляры из пула для дешёвого создания, регистрируйте `AddPooledDbContextFactory`. О компромиссах пуловых фабрик в тестовых сетапах [паттерн съёмной пуловой фабрики](/ru/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) описывает подвох с состоянием, утекающим между арендами.

### 3. Разрешайте свежий scope на каждую операцию

В управляемом фреймворком scoped-жизненном цикле (по умолчанию для ASP.NET Core) решение — создавать дочерний scope для каждой параллельной ветви:

```csharp
// .NET 11, EF Core 11.0.0
public class Report(IServiceScopeFactory scopes)
{
    public async Task ProcessAll(IEnumerable<int> ids)
    {
        await Parallel.ForEachAsync(ids, async (id, ct) =>
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            var order = await db.Orders.FirstOrDefaultAsync(o => o.Id == id, ct);
            // ... process order ...
        });
    }
}
```

`CreateAsyncScope` строит свежий DI-scope, поэтому разрешение `AppDb` из него возвращает другой экземпляр, чем внешний request scope и чем каждая другая итерация. Это правильная форма для `Parallel.ForEachAsync` против EF Core. Паттерн фабрики из решения 2 предпочтительнее, когда работа — это чистый доступ к данным; паттерн scope лучше, когда телу цикла нужны и другие scoped сервисы.

## Распространённые формы, которые это вызывают

### Разделение request DbContext с Task.Run

Классическая ошибка ASP.NET Core: обработчик запроса запускает fire-and-forget фоновую задачу, которая захватывает request-scoped `DbContext`:

```csharp
// .NET 11, EF Core 11.0.0 -- wrong
[HttpPost]
public IActionResult QueueWork()
{
    _ = Task.Run(async () =>
    {
        await db.AuditLog.AddAsync(new AuditEntry("queued"));
        await db.SaveChangesAsync();
    });
    return Accepted();
}
```

Здесь накладываются два режима отказа. Во-первых, запрос возвращается и DI-scope удаляет `DbContext`, пока фоновая задача всё ещё выполняется, поэтому вы также видите `ObjectDisposedException`. Во-вторых, если любой другой путь кода в запросе всё ещё использует контекст, оба потока конкурируют за него и детектор выбрасывает. Решение то же, что в #2: внедрите `IDbContextFactory<AppDb>`, или передайте работу настоящему фоновому механизму (`IHostedService`, channels, очередь задач), который владеет собственным scope. [Описание Channels как замены BlockingCollection](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) покрывает паттерн in-process очереди.

### Стриминг IAsyncEnumerable через HTTP-границу

Если вы возвращаете `IAsyncEnumerable<T>` из контроллера, который опирается на запрос EF Core, ASP.NET Core перебирает его по мере сериализации ответа. Если что-то ещё в этом scope обращается к тому же `DbContext`, пока сериализация идёт, детектор выбрасывает. Легко словить, когда middleware позже добавляет аудит-строку в callback `OnStarting`, пока тело всё ещё стримится.

Решение — материализовать enumerable, или гарантировать, что streaming-эндпоинт владеет единственным доступом к этому контексту на время жизни ответа. [Описание `IAsyncEnumerable` с EF Core](/ru/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) проходит модель стриминга и жизненные циклы, которые с ней работают.

### Захваченный DbContext в обработчике события или статическом поле

`DbContext`, сохранённый в статическом поле, или захваченный в обработчике события, подписанном при старте, будет переиспользоваться на каждом событии. Два события, приходящие близко друг к другу, наложатся на нём. То же решение: внедряйте фабрику, не захватывайте.

### Singleton-scoped DbContext

`DbContext`, зарегистрированный как `Singleton` (по ошибке или через `AddSingleton<MyService>`, где `MyService` внедряет `AppDb`), оказывается общим между запросами. Конкурентность тогда гарантирована при любой реальной нагрузке. [Руководство по коллизии карты идентичности](/ru/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) проходит ту же ловушку Singleton/Scoped с угла дублирующегося ключа; обе ошибки исходят из одной первопричины.

### Смешивание sync и async в одной точке вызова

`db.SaveChanges()`, за которым идёт ранее запущенный (и не ожидаемый) асинхронный запрос в работе, вызовет детектор, как только вы наконец сделаете `await` для асинхронного. Это обычно появляется в legacy-путях кода, где кто-то добавил `_ = SomethingAsync()`, чтобы подавить предупреждение компилятора. Подавив предупреждение, подавили и баг; решение — сделать ему `await`.

### Переиспользование DbContext между попытками retry в Polly

Если вы оборачиваете вызов в `Polly`, и retry запускается, пока `Task` предыдущей попытки ещё жива (отмена не пропагировалась чисто), обе попытки трогают один и тот же контекст. Сочетайте retry с `IDbContextFactory<T>`, чтобы каждая попытка получала свежий контекст, или убедитесь, что предыдущая попытка полностью отменена (`ct.ThrowIfCancellationRequested()` проходит по вызову EF Core), прежде чем повторять. [Руководство по отмене без deadlock](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) покрывает дисциплину отмены, которая делает это безопасным.

## Варианты, похожие на эту ошибку, но не она

### "There is already an open DataReader associated with this Connection which must be closed first"

Другое исключение, то же семейство. Это исходит из ADO.NET, когда MARS выключен, и вы попытались запустить второй reader на том же соединении. EF Core скрывает это большую часть времени, но сырая работа с `db.Database.GetDbConnection()` обходит детектор и всплывает с базовой ошибкой. Решение той же формы (одна операция за раз, или одно соединение на операцию), но включение `MultipleActiveResultSets=True` в строке соединения SQL Server позволит выполнять вложенные ридеры, если вам действительно нужно.

### "ObjectDisposedException: Cannot access a disposed context"

Означает, что DI-scope уже удалил `DbContext`, пока захваченная задача пыталась его использовать. Обычно fire-and-forget `Task.Run` из HTTP-обработчика, или `BackgroundService`, который захватил scoped контекст при старте. Решение — разрешать контекст внутри задачи, а не снаружи.

### "The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"

Конфликт карты идентичности, однопоточная форма. Два CLR-объекта, один и тот же первичный ключ, один и тот же контекст. Решение подробно проходит [руководство по отслеживанию сущностей](/ru/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/).

### "InvalidOperationException: Synchronous operations are disallowed"

Kestrel отвергает `Stream.Read` вместо `Stream.ReadAsync` на теле ответа. Другой стек, другое решение (`AllowSynchronousIO = true` или переход на async-API). Не проблема `DbContext`.

## Связанное

Для более широкой гигиены EF Core см. [руководство по обнаружению N+1](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) и [руководство по compiled queries на горячих путях](/ru/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) для дизайна запросов, как только модель конкурентности будет правильной. Для тестовых фикстур, которые передают вашему коду реальную базу данных, не разделяя контекст между потоками, [руководство по Testcontainers против реального SQL Server](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) — это самый чистый сетап. [Пост по обнаружению N+1](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) также покрывает хуки логгера EF Core 11, которые вы можете перепрофилировать, чтобы помечать забытые `await` в CI.

## Источники

- [Avoiding DbContext threading issues](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#avoiding-dbcontext-threading-issues), документация EF Core.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`AddDbContextFactory` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), Microsoft Learn.
- [`ConcurrencyDetector` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/ConcurrencyDetector.cs), dotnet/efcore на GitHub.
- [`IServiceScopeFactory.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn.
