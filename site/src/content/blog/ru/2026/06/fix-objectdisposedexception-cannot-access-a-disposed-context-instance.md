---
title: "Исправление: ObjectDisposedException: Cannot access a disposed context instance"
description: "Ваша задача fire-and-forget захватила DbContext с областью запроса, который область DI уже освободила. Создайте новый контекст внутри задачи через IServiceScopeFactory или IDbContextFactory."
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
lang: "ru"
translationOf: "2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance"
translatedBy: "claude"
translationDate: 2026-06-02
---

Исправление: задача fire-and-forget захватила `DbContext` (или другой сервис с областью), который жил в области DI, освобождённой до завершения задачи. Запрос вернулся, ASP.NET Core освободил область и её `DbContext`, а ваша отсоединённая задача затем обратилась к мёртвому экземпляру. Не захватывайте контекст с областью: внутри задачи создайте собственную область через `IServiceScopeFactory.CreateAsyncScope` и создайте из неё новый `DbContext`, либо внедрите `IDbContextFactory<T>` и вызовите `CreateDbContextAsync`.

```text
System.ObjectDisposedException: Cannot access a disposed context instance. A common cause of this error is disposing a context instance that was resolved from dependency injection and then later trying to use the same context instance elsewhere in your application. This may occur if you are calling Dispose() on the context instance, or wrapping it in a using statement. If you are using dependency injection, you should let the dependency injection container take care of disposing context instances.
Object name: 'AppDb'.
   at Microsoft.EntityFrameworkCore.DbContext.CheckDisposed()
   at Microsoft.EntityFrameworkCore.DbContext.get_DbContextDependencies()
   at Microsoft.EntityFrameworkCore.DbContext.Set[TEntity]()
   at Microsoft.EntityFrameworkCore.Internal.InternalDbSet`1.get_EntityQueryable()
```

Это руководство написано для .NET 11 preview 4 и `Microsoft.EntityFrameworkCore` 11.0.0-preview.4, но текст сообщения и проверка `CheckDisposed` остаются стабильными со времён EF Core 3.0. Исключение возникает из `DbContext.CheckDisposed()`, который выполняется в начале каждого публичного члена: `Set<T>`, `SaveChangesAsync`, `Database`, трекер изменений, всё. К моменту, когда вы его видите, объект действительно уже исчез. EF Core не находится в состоянии гонки и не ведёт себя неправильно; что-то освободило контекст, а потом код всё равно к нему обратился.

## Что на самом деле означает "освобождён" здесь

`DbContext`, созданный из внедрения зависимостей, принадлежит области, из которой он был создан. В ASP.NET Core фреймворк создаёт одну область DI на HTTP-запрос и освобождает её, когда ответ завершён. Освобождение области освобождает каждый `IDisposable`, который она создала, включая ваш `DbContext`. После этого внутренний провайдер сервисов контекста разбирается, его `DbConnection` возвращается в пул, а `_disposed` устанавливается в `true`. Любой последующий вызов достигает `CheckDisposed()` и выбрасывает исключение.

Ошибка почти никогда не связана с тем, что вы сами пишете `using` или вызываете `Dispose()` (хотя это другой способ её вызвать). На практике дело в жизненном цикле: код пережил область, которой принадлежал контекст. Самая распространённая форма с большим отрывом -- задача fire-and-forget, запущенная из запроса, которая захватила контекст этого запроса.

## Минимальное воспроизведение

Контроллер запускает фоновую работу, не ожидая её, и лямбда замыкается над внедрённым `DbContext`:

```csharp
// .NET 11, C# 14, EF Core 11.0.0 -- wrong
public class OrdersController(AppDb db) : ControllerBase
{
    [HttpPost("orders")]
    public IActionResult Create(OrderDto dto)
    {
        var order = new Order(dto);
        db.Orders.Add(order);

        // fire-and-forget: not awaited, escapes the request lifetime
        _ = Task.Run(async () =>
        {
            await Task.Delay(2000);            // simulate slow work
            db.AuditLog.Add(new Audit(order)); // db is disposed by now
            await db.SaveChangesAsync();        // throws ObjectDisposedException
        });

        return Accepted();
    }
}
```

Последовательность: `Create` возвращает `Accepted()` почти сразу, ASP.NET Core освобождает область запроса (и `db` вместе с ней), а через две секунды отсоединённая задача просыпается и вызывает контекст, флаг `_disposed` которого уже установлен. `Add` может даже показаться успешным в зависимости от тайминга, но `SaveChangesAsync` надёжно выбрасывает исключение, потому что обращается к освобождённым зависимостям.

То же самое происходит с `ContinueWith`, с обработчиком событий `async void`, захватывающим контекст, с колбэком `Timer`, замыкающимся над ним, и с `BackgroundService`, который один раз создал контекст с областью в конструкторе и переиспользует его навсегда.

## Исправление 1: создайте область внутри задачи и создайте новый контекст

Это правильный ответ, когда фоновой работе нужны сервисы с областью помимо чистого доступа к данным. Внедрите `IServiceScopeFactory` (синглтон, всегда безопасно захватывать) и откройте область внутри тела задачи:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class OrdersController(AppDb db, IServiceScopeFactory scopeFactory)
    : ControllerBase
{
    [HttpPost("orders")]
    public async Task<IActionResult> Create(OrderDto dto)
    {
        var order = new Order(dto);
        db.Orders.Add(order);
        await db.SaveChangesAsync();     // the request's own work, awaited

        var orderId = order.Id;          // capture a value, not the context

        _ = Task.Run(async () =>
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var bgDb = scope.ServiceProvider.GetRequiredService<AppDb>();
            bgDb.AuditLog.Add(new Audit(orderId));
            await bgDb.SaveChangesAsync();
        });

        return Accepted();
    }
}
```

Изменились две вещи. Задача захватывает `orderId` (`int`), а не `DbContext`. И она создаёт совершенно новый `AppDb` из области, которой владеет, поэтому освобождение этой области привязано к завершению задачи, а не к HTTP-запросу. `CreateAsyncScope` (вместо синхронного `CreateScope`) важен, потому что `DbContext` реализует `IAsyncDisposable`; использование асинхронной области освобождает его по асинхронному пути и избегает предупреждения sync-over-async от анализаторов.

Также никогда не захватывайте экземпляры сущностей через границу. Объект `order` отслеживается контекстом запроса; передача его в контекст новой области приглашает коллизию "instance of entity type cannot be tracked". Передайте ключ и перезагрузите или переприсоедините внутри задачи.

## Исправление 2: внедряйте IDbContextFactory, когда работа -- чистый доступ к данным

Если отсоединённой работе нужен только `DbContext` и ничего больше с областью, `IDbContextFactory<T>` чище, чем поднимать целую область DI. Зарегистрируйте её рядом с (или вместо) контекстом с областью:

```csharp
// .NET 11, EF Core 11.0.0 -- Program.cs
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class OrdersController(IDbContextFactory<AppDb> factory) : ControllerBase
{
    [HttpPost("orders")]
    public async Task<IActionResult> Create(OrderDto dto)
    {
        int orderId;
        await using (var db = await factory.CreateDbContextAsync())
        {
            var order = new Order(dto);
            db.Orders.Add(order);
            await db.SaveChangesAsync();
            orderId = order.Id;
        }

        _ = Task.Run(async () =>
        {
            await using var bgDb = await factory.CreateDbContextAsync();
            bgDb.AuditLog.Add(new Audit(orderId));
            await bgDb.SaveChangesAsync();
        });

        return Accepted();
    }
}
```

`IDbContextFactory<T>` регистрируется как синглтон, поэтому захватывать её в замыкании безопасно. Каждый `CreateDbContextAsync` выдаёт вам контекст, жизненным циклом которого вы управляете через `await using`. Фабрика полностью обходит область запроса, что и нужно отсоединённой задаче. Если вы также вызываете `AddDbContextFactory`, учтите, что в EF Core 11 одна и та же регистрация может удовлетворить как внедрение `AppDb` с областью, так и внедрение фабрики, поэтому вам не нужно выбирать одно глобально. Прибегайте к `AddPooledDbContextFactory`, если стоимость создания всплывает в профиле, но сбрасывайте любое состояние на контекст между арендами.

## Исправление 3: перестаньте запускать и забывать -- передайте работу настоящему фоновому механизму

`Task.Run` из обработчика запроса -- неправильный инструмент, даже когда вы исправили жизненный цикл контекста: у работы нет повтора, нет обратного давления, нет обработки корректного завершения, а поток, на котором она выполняется, конкурирует с обработкой запросов. Долговечное исправление -- поставить сообщение в очередь и позволить hosted service обработать её в собственной области. `Channel<T>` -- самый лёгкий вариант в процессе:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public sealed record AuditWork(int OrderId);

public class AuditQueue
{
    private readonly Channel<AuditWork> _channel =
        Channel.CreateUnbounded<AuditWork>();

    public ValueTask Enqueue(AuditWork work) => _channel.Writer.WriteAsync(work);
    public IAsyncEnumerable<AuditWork> Reader(CancellationToken ct) =>
        _channel.Reader.ReadAllAsync(ct);
}

public class AuditWorker(AuditQueue queue, IServiceScopeFactory scopeFactory)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var work in queue.Reader(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            db.AuditLog.Add(new Audit(work.OrderId));
            await db.SaveChangesAsync(stoppingToken);
        }
    }
}
```

Зарегистрируйте `AuditQueue` как синглтон, а `AuditWorker` через `AddHostedService`. Контроллер теперь просто вызывает `await queue.Enqueue(new AuditWork(orderId))` и возвращается. Каждая единица работы получает свою область и свой контекст внутри воркера, работа переживает возврат запроса, а завершение обрабатывается чисто, потому что цикл учитывает `stoppingToken`. Это паттерн, который полностью раскрывает [руководство по безопасному fire-and-forget с BackgroundService](/ru/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/), а [руководство по Channels как замене BlockingCollection](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) подробно объясняет сторону очереди.

## Почему BackgroundService, внедряющий DbContext, падает при запуске

Более тонкая версия: вы внедряете `AppDb` прямо в конструктор `BackgroundService` и сначала получаете другую ошибку.

```csharp
// .NET 11, EF Core 11.0.0 -- wrong, fails to start
public class AuditWorker(AppDb db) : BackgroundService { /* ... */ }
```

`BackgroundService` -- синглтон. Внедрение `AppDb` с областью в синглтон срабатывает валидатором области DI при запуске с "Cannot consume scoped service 'AppDb' from singleton". Если вы как-то это подавите (не следует), синглтон удерживал бы один контекст в течение всей жизни процесса, и вы снова получили бы `ObjectDisposedException` или ошибки потоков при первом же пересечении двух итераций. Исправление -- тот же паттерн `CreateAsyncScope` из Исправления 1. Пост об [ошибке сервиса с областью из синглтона](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/) и [руководство по сервисам с областью внутри BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) оба объясняют, почему синглтоны не могут удерживать состояние с областью.

## Освобождение, которое вы вызвали сами

Две формы, не являющиеся fire-and-forget, дают идентичное сообщение:

Вы обернули контекст, созданный через DI, в `using`. Если `AppDb` пришёл из внедрения через конструктор, им владеет контейнер; блок `using` освобождает его слишком рано, и следующий вызов члена в том же запросе выбрасывает исключение. Позвольте контейнеру освободить его -- уберите `using`. Освобождайте только те контексты, которые создали сами через `new` или через фабрику.

Вы вернули `IEnumerable<T>` или `IQueryable<T>` из метода, и вызывающая сторона перечисляет его после того, как контекст уже исчез. Отложенный LINQ не выполняется до перечисления; если контекст метода был ограничен `using` или запросом, который уже завершился, перечисление достигает освобождённого контекста. Материализуйте внутри метода через `ToListAsync` или держите контекст живым на время перечисления.

## Варианты, которые выглядят так, но таковыми не являются

### "A second operation was started on this context instance before a previous operation completed"

То же семейство, другая причина: две операции пересеклись на живом (не освобождённом) контексте, обычно забытый `await` или `Task.WhenAll` над одним контекстом. Исправление тоже -- один контекст на операцию, подробно в [руководстве по second-operation-started](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/).

### "Cannot access a disposed object. Object name: 'IServiceProvider'"

Освобождена вся область или корневой провайдер, а не только контекст. Та же корневая причина (жизненный цикл), но это означает, что вы захватили `IServiceProvider`/`IServiceScope` и использовали его после освобождения. Создайте всё нужное до завершения области или держите область живой на время работы.

### "The ConnectionString property has not been initialized"

Контекст, созданный через `new` без настроенного провайдера, не проблема освобождения. Вы обошли DI и забыли `OnConfiguring` или опции. Используйте фабрику или DI вместо `new AppDb()`.

### "ObjectDisposedException" на CancellationTokenSource

`CancellationTokenSource`, освобождённый, пока токен из него ещё используется. Не связано с EF Core, хотя тип исключения совпадает. Посмотрите на строку `Object name:` -- она называет освобождённый объект, и это ваш самый быстрый сигнал для сортировки.

## Связанное

Для более широкой картины выполнения отсоединённой работы без утечки состояния с областью руководства по [безопасным паттернам fire-and-forget](/ru/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) и [сервисам с областью внутри BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) -- два, которые стоит прочитать дальше. Если ваш fire-and-forget начинался как `async void`, [разбор async void против async Task](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) объясняет, почему это полностью проглатывает исключение. А когда отсоединённой задаче нужно чисто остановиться при завершении, [руководство по отмене без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) раскрывает дисциплину токенов.

## Источники

- [DbContext lifetime, configuration, and initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), документация EF Core.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`DbContext.CheckDisposed` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/DbContext.cs), dotnet/efcore на GitHub.
- [Consuming a scoped service in a background task](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service), документация .NET.
- [`ServiceProviderServiceExtensions.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn.
