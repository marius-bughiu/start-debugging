---
title: "Как использовать scoped-сервисы внутри BackgroundService в ASP.NET Core 11"
description: "BackgroundService является синглтоном, поэтому не может напрямую внедрить scoped-сервис вроде DbContext. Внедрите IServiceScopeFactory, открывайте один scope на единицу работы через CreateAsyncScope, разрешайте сервис внутри него и освобождайте scope по завершении работы."
pubDate: 2026-05-31
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
  - "backgroundservice"
lang: "ru"
translationOf: "2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-05-31
---

`BackgroundService` регистрируется как синглтон, поэтому при попытке напрямую внедрить в его конструктор scoped-сервис вроде `DbContext` либо при запуске выбрасывается `Cannot consume scoped service 'X' from singleton 'Y'`, либо, что хуже, этот scoped-экземпляр привязывается ко времени жизни всего процесса. Решение состоит в том, чтобы внедрить `IServiceScopeFactory`, открывать новый scope через `CreateAsyncScope()` для каждой единицы работы внутри `ExecuteAsync`, разрешать scoped-сервис из провайдера этого scope и освобождать scope по завершении работы. Это руководство написано для .NET 11 (на момент написания preview 4, общая доступность запланирована на ноябрь 2026 года), `Microsoft.Extensions.Hosting` 11.0.0 и EF Core 11. Контракты `BackgroundService` и `IServiceScopeFactory` стабильны со времён .NET Core 3.1, поэтому все приведённые здесь паттерны без изменений применимы и к .NET 6, 8 и 10.

## Почему BackgroundService не может просто внедрить scoped-сервис

Каждый размещённый сервис, который вы регистрируете через `AddHostedService<T>`, является синглтоном. Это не значение по умолчанию, которое можно переопределить: `AddHostedService<T>` и `AddSingleton<IHostedService, T>` разрешаются в одну и ту же регистрацию, и хост получает экземпляр из **корневого** провайдера во время `StartAsync`. У корневого провайдера нет окружающего scope.

Scoped-сервис, по определению, живёт один раз на scope. В веб-запросе этот scope создаётся и освобождается на каждый запрос. `BackgroundService` работает на протяжении всего времени жизни хоста, полностью вне какого-либо запроса. Поэтому нет scope, относительно которого среда выполнения могла бы разрешить scoped-зависимость. Если вы напишете конструктор вроде `OrderWorker(AppDbContext db)`, произойдёт одно из двух:

- В `Development` `WebApplication.CreateBuilder` включает `ValidateScopes`, валидатор call site обходит граф во время сборки, видит scoped-сервис, втекающий в синглтон, и выбрасывает `Cannot consume scoped service ...`. Если это именно то исключение, с которым вы сюда попали, отдельное руководство [нельзя использовать scoped-сервис из синглтона](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/) разбирает каждую его разновидность.
- В `Production` проверка scope по умолчанию выключена, поэтому тот же код собирается и выполняется. `DbContext` оказывается захваченным на всё время жизни процесса. Его трекер изменений накапливает каждую когда-либо загруженную сущность, его соединение никогда не возвращается в пул корректно, и рано или поздно вы сталкиваетесь с `ObjectDisposedException` или устаревшими чтениями.

Ни один из этих исходов вам не нужен. Правильная модель такова: синглтон-воркер владеет циклом и отменой, а каждая итерация заимствует короткоживущий scope для выполнения настоящей работы.

## Настройка scoped-разрешения в четыре шага

Собственное [руководство Microsoft по worker-сервисам](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) рекомендует делегировать настоящую работу scoped-сервису, а сам `BackgroundService` держать тонким. Вот полная форма в четыре шага.

1. **Зарегистрируйте scoped-сервис** через `AddScoped`, ровно так же, как для потребителя, привязанного к запросу. Ничего особенного не требуется, потому что он используется в фоновом контексте.
2. **Зарегистрируйте воркер** через `AddHostedService<T>`. Он остаётся синглтоном; не пытайтесь сделать его scoped.
3. **Внедрите `IServiceScopeFactory`** (не scoped-сервис и не `IServiceProvider`) в конструктор воркера.
4. **Открывайте один scope на единицу работы** внутри `ExecuteAsync` через `CreateAsyncScope()`, разрешайте scoped-сервис из `scope.ServiceProvider`, выполняйте работу и позвольте `await using` освободить scope.

### Шаги 1 и 2: регистрация

```csharp
// .NET 11, C# 14 - Program.cs
using App.Workers;

var builder = WebApplication.CreateBuilder(args);

// The scoped unit of work. Registered exactly like any request-scoped service.
builder.Services.AddScoped<IOrderProcessor, OrderProcessor>();

// The worker stays a singleton. AddHostedService always registers a singleton.
builder.Services.AddHostedService<OrderWorker>();

var app = builder.Build();
app.Run();
```

### Шаги 3 и 4: воркер

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace App.Workers;

public sealed class OrderWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<OrderWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("OrderWorker started.");

        while (!stoppingToken.IsCancellationRequested)
        {
            // One scope per iteration: a fresh DbContext, change tracker, and
            // connection scope every time, disposed at the end of the block.
            await using var scope = scopeFactory.CreateAsyncScope();

            var processor = scope.ServiceProvider
                .GetRequiredService<IOrderProcessor>();

            await processor.ProcessPendingAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}
```

Scoped-сервис, который содержит всю настоящую логику и scoped-зависимости:

```csharp
// .NET 11, C# 14
namespace App.Workers;

public interface IOrderProcessor
{
    Task ProcessPendingAsync(CancellationToken cancellationToken);
}

public sealed class OrderProcessor(
    AppDbContext db,                 // scoped, injected normally now
    ILogger<OrderProcessor> logger) : IOrderProcessor
{
    public async Task ProcessPendingAsync(CancellationToken cancellationToken)
    {
        var pending = await db.Orders
            .Where(o => o.Status == OrderStatus.Pending)
            .ToListAsync(cancellationToken);

        foreach (var order in pending)
        {
            order.Status = OrderStatus.Processed;
        }

        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Processed {Count} orders.", pending.Count);
    }
}
```

`OrderProcessor` внедряет `AppDbContext` напрямую, потому что сам он scoped и разрешается только внутри scope. Синглтон-воркер никогда не видит `DbContext`. Это разделение и есть весь приём: несоответствие времён жизни исчезает в тот момент, когда scoped-граф разрешается из настоящего scope, а не из корня.

## CreateAsyncScope против CreateScope

Для почти всего современного кода используйте `CreateAsyncScope()`, а не `CreateScope()`. Разница в освобождении.

`CreateScope()` возвращает `IServiceScope`, который освобождает свои scoped-сервисы синхронно через `IDisposable.Dispose()`. `CreateAsyncScope()` возвращает `AsyncServiceScope`, который освобождает через `IAsyncDisposable.DisposeAsync()`, когда сервис его реализует, и откатывается к синхронному освобождению, когда нет.

Это важно, потому что `DbContext` из EF Core в .NET 11 реализует `IAsyncDisposable`, и несколько конфигураций (pooled-контексты, контексты, удерживающие открытое `DbConnection`) выбросят исключение при синхронном освобождении. Если вы напишете `using var scope = scopeFactory.CreateScope();`, а scope содержит контекст, требующий асинхронного освобождения, то в конце блока вы получите исключение, не имеющее никакого отношения к вашей настоящей работе.

```csharp
// .NET 11 - prefer this
await using var scope = scopeFactory.CreateAsyncScope();

// Only use the sync form when nothing in the scope needs async disposal
using var syncScope = scopeFactory.CreateScope();
```

Стоимость `CreateAsyncScope()` по сравнению с `CreateScope()` фактически нулевая, когда ничто не требует асинхронного освобождения, поэтому нет причин по умолчанию прибегать к синхронной версии.

## Один scope на единицу работы, а не один на процесс

Самая распространённая ошибка после перехода на `IServiceScopeFactory` — вынести scope наружу из цикла:

```csharp
// .NET 11 - WRONG. The scope lives for the whole process.
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    await using var scope = scopeFactory.CreateAsyncScope();      // created once
    var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();

    while (!stoppingToken.IsCancellationRequested)
    {
        await processor.ProcessPendingAsync(stoppingToken);       // same DbContext forever
        await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
    }
}
```

Это компилируется, проходит проверку scope и заново вводит ровно тот баг, который вы пытались исправить. `DbContext`, разрешённый единожды, теперь живёт всё время жизни воркера. Его трекер изменений растёт без ограничений на каждой итерации, запросы замедляются по мере разрастания отслеживаемого графа, а единственный неудачный `SaveChanges` может оставить контекст в состоянии, отравляющем каждую последующую итерацию. Вы также снова открываете дверь к [ошибке "вторая операция на экземпляре контекста"](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/), как только две итерации перекрываются.

Создавайте scope **внутри** цикла. Scope дёшев. Смысл паттерна в том, чтобы каждая единица работы получала чистый лист: свежий контекст, свежий трекер изменений и соединение, взятое из пула и возвращённое в конце итерации.

## Scoped-сервисы в воркере, осушающем очередь

Scope на итерацию естественно обобщается на воркер, осушающий `Channel<T>`. Каждый извлечённый из очереди элемент — это собственная единица работы, поэтому каждый получает свой собственный scope:

```csharp
// .NET 11, C# 14
using System.Threading.Channels;

public sealed class OrderQueueWorker(
    Channel<int> queue,
    IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var orderId in queue.Reader.ReadAllAsync(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider
                .GetRequiredService<IOrderProcessor>();

            await processor.ProcessOneAsync(orderId, stoppingToken);
        }
    }
}
```

`ReadAllAsync` уже учитывает токен отмены, поэтому цикл аккуратно разворачивается при завершении. Каждое сообщение обрабатывается изолированно, и отравляющее сообщение, выбрасывающее исключение внутри одного scope, не повреждает контекст, используемый в следующем.

## EF Core: IServiceScopeFactory против IDbContextFactory

Когда единственная нужная вам scoped-зависимость — это `DbContext`, EF Core предлагает более прямой инструмент: `IDbContextFactory<T>`. Зарегистрируйте его через `AddDbContextFactory`, который регистрирует фабрику как синглтон, и внедрите фабрику прямо в воркер:

```csharp
// .NET 11, EF Core 11 - Program.cs
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11, EF Core 11
public sealed class OrderWorker(
    IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process...
            await db.SaveChangesAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}
```

Правило выбора простое. Если вашей единице работы нужен **только** `DbContext`, используйте `IDbContextFactory<T>`: нет церемонии scope, и фабрика выдаёт вам свежий, корректно освобождаемый контекст на каждый вызов. Если вашей единице работы нужен граф scoped-сервисов (репозиторий, резолвер арендатора, `IOptionsSnapshot<T>`, доменный сервис, который сам зависит от контекста), используйте `IServiceScopeFactory`, чтобы весь граф разрешался согласованно внутри одного scope. Вы можете зарегистрировать `AddDbContext` для привязанного к запросам кода и `AddDbContextFactory` для воркера в одном приложении.

## Scope не потокобезопасен: параллелизму нужен один scope на задачу

Если вы обрабатываете элементы параллельно, не разделяйте один scope между параллельными задачами. `DbContext` не потокобезопасен, как и разрешение scope. Дайте каждой параллельной ветви свой собственный scope:

```csharp
// .NET 11, C# 14
await Parallel.ForEachAsync(
    orderIds,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 4,
        CancellationToken = stoppingToken
    },
    async (orderId, ct) =>
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var processor = scope.ServiceProvider
            .GetRequiredService<IOrderProcessor>();
        await processor.ProcessOneAsync(orderId, ct);
    });
```

Каждый вызов тела получает независимый scope, независимый `DbContext` и независимый трекер изменений, что и есть ровно та изоляция, которая нужна для конкурентной работы.

## Корректное завершение и StopAsync

`stoppingToken` сигнализируется, когда хост начинает завершение работы. Передача его в каждый асинхронный вызов внутри scope (запрос, `SaveChanges`, `Task.Delay`) — это то, что позволяет воркеру быстро останавливаться, а не блокировать завершение до тайм-аута завершения хоста (по умолчанию 30 секунд).

Если при остановке хоста нужно выполнить очистку, переопределите `StopAsync` и вызовите базовую реализацию:

```csharp
// .NET 11, C# 14
public override async Task StopAsync(CancellationToken cancellationToken)
{
    logger.LogInformation("OrderWorker stopping, draining in-flight work.");
    await base.StopAsync(cancellationToken);
}
```

Одна тонкость: длинный блокирующий вызов внутри цикла, игнорирующий `stoppingToken`, не будет прерван, и хост ждёт полный тайм-аут завершения, прежде чем разрушить процесс. Если ваша единица работы может выполняться долго, пробросьте токен на всю глубину. По смежному вопросу остановки работы, не сотрудничающей с отменой, см. [отмена длительной Task в C# без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking).

## Ошибки, переживающие проверку scope

Все они компилируются и проходят `ValidateScopes`, поэтому их стоит назвать поимённо:

- **Внедрение `IServiceProvider` вместо `IServiceScopeFactory`.** Провайдер, внедрённый в синглтон, — это корневой провайдер. Разрешение scoped-сервиса из него выбрасывает исключение или захватывает его, в зависимости от настроек проверки. Всегда внедряйте `IServiceScopeFactory` и вызывайте `CreateAsyncScope()`.
- **Разрешение из захваченного корневого провайдера внутри scope.** Пишите `scope.ServiceProvider.GetRequiredService<T>()`, а не `_rootProvider.GetRequiredService<T>()`. Разрешение из корня внутри открытого вами scope полностью обесценивает scope.
- **Хранение разрешённого scoped-сервиса в поле.** Экземпляр не должен переживать scope. Передавайте его как параметр метода и позвольте ему выйти из scope вместе с `await using`.
- **Забытый `await using`.** Простое `var scope = scopeFactory.CreateAsyncScope();` без освобождения утекает scope и каждый содержащийся в нём сервис на всё время жизни процесса.

Для воркеров, которые вы намерены запускать в продакшене, сочетайте этот паттерн с надлежащей наблюдаемостью, чтобы зависший или молча падающий цикл проявил себя; подход из [мониторинга фоновых задач без Hangfire](/ru/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts) применим напрямую. А полный проработанный пример того же паттерна scope factory вокруг нетривиальной зависимости см. в [запуск плагина Semantic Kernel из BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).

Ментальная модель, удерживающая это в правильном русле: синглтон владеет циклом и отменой; scope владеет работой и состоянием на единицу. Держите эти две обязанности раздельно — и ошибки времени жизни вообще не появятся.

## Источники

- Microsoft Learn, [Use scoped services within a BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) (обновлено 2026-05-27), канонический учебник по worker-сервисам.
- Microsoft Learn, [Dependency injection in .NET: service lifetimes](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#service-lifetimes).
- Microsoft Learn, [`AsyncServiceScope` and `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope).
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- .NET Blog, [.NET 11 Preview 1 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/).
