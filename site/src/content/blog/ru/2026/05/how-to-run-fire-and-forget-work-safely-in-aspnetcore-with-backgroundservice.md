---
title: "Как безопасно выполнять fire-and-forget работу в ASP.NET Core с помощью BackgroundService"
description: "Вызов Task.Run из контроллера теряет работу при остановке, проглатывает исключения и захватывает уже освобождённые scoped-сервисы. Безопасный паттерн - ограниченная очередь Channel, которую опустошает BackgroundService, открывая новый scope для каждой единицы работы и завершая выполняемую работу в StopAsync."
pubDate: 2026-05-31
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "backgroundservice"
  - "async"
lang: "ru"
translationOf: "2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice"
translatedBy: "claude"
translationDate: 2026-05-31
---

В тот момент, когда вы хотите, чтобы HTTP-запрос возвращался немедленно, пока некоторая более медленная работа (отправка письма, запись аудит-записи, вызов webhook) продолжает выполняться, очевидным ходом является `_ = Task.Run(() => DoTheWorkAsync())` внутри контроллера. Оно компилируется, ответ быстрый, и в демонстрации выглядит так, будто работает. В продакшене оно теряет работу при каждом развёртывании, проглатывает все исключения и обращается к scoped-сервисам, которые уже были освобождены. Безопасная замена - это ограниченная очередь `Channel<T>`, зарегистрированная как singleton и опустошаемая единственным `BackgroundService`, который открывает свежий DI-scope для каждой единицы работы, перехватывает и журналирует исключения для каждого элемента и завершает выполняемую работу во время корректной остановки. Это руководство написано для .NET 11 (preview 4 на момент написания, общая доступность запланирована на ноябрь 2026 года), `Microsoft.Extensions.Hosting` 11.0.0 и `System.Threading.Channels` из встроенной BCL. Контракты очереди и `BackgroundService` стабильны со времён .NET Core 3.1, поэтому каждый паттерн здесь применяется без изменений к .NET 6, 8 и 10.

## Почему `Task.Run` в обработчике запроса - это ловушка

Привлекательность `Task.Run` в том, что он возвращается мгновенно, и фреймворк никогда не блокируется на нём. Именно в этом и проблема: фреймворк никогда не блокируется на нём, никогда его не отслеживает и никогда его не ждёт.

Отсюда следуют три конкретных сбоя:

- **Потерянная работа при остановке.** Когда хост останавливается (развёртывание, scale-in, упавший соседний pod, запускающий поэтапный перезапуск), он не знает, что ваша отсоединённая `Task` существует. Он перестаёт принимать запросы, ждёт те запросы, о которых знает, и сворачивает процесс. Любая работа `Task.Run`, всё ещё выполняемая, убивается посреди исполнения. В нагруженном сервисе каждое развёртывание молча отбрасывает горстку писем или аудит-строк.
- **Проглоченные исключения.** Ненаблюдаемое исключение в отсоединённой `Task` не роняет приложение и не доходит до вашего конвейера журналирования. Оно всплывает, если вообще всплывает, в потоке финализатора как `TaskScheduler.UnobservedTaskException` спустя долгое время после исчезновения запроса. В первый раз вы узнаёте, что работа падает, когда клиент спрашивает, где его письмо.
- **Захваченные, освобождённые зависимости.** Это тонкий момент. Если ваш контроллер замыкает внедрённый `DbContext` или любой scoped-сервис, этот сервис привязан к scope запроса. ASP.NET Core освобождает scope запроса в тот момент, когда ответ записан. Тело вашего `Task.Run`, всё ещё выполняемое, теперь обращается к освобождённому `DbContext` и бросает `ObjectDisposedException: Cannot access a disposed context instance`, или хуже - состязается с освобождением и портит состояние.

Есть также измерение нагрузки: контроллер, запускающий `Task.Run` на каждом запросе, конкурирует за тот же пул потоков, который обслуживает ваши запросы, так что всплеск трафика превращается в голодание пула потоков. Если вам нужен полный разбор того, чем `Task.Run` отличается от других примитивов выгрузки, сравнение в [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/ru/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) охватывает, когда каждый из них уместен. Для обработчиков запросов ответ таков: ни один из них напрямую.

Fire-and-forget приемлем только тогда, когда потеря работы при перезапуске действительно допустима. Паттерн ниже не делает работу долговечной (для этого нужна внешняя очередь вроде Azure Storage Queues или хранилище заданий на базе базы данных), но он исправляет три других проблемы и даёт работе в памяти чистое опустошение при остановке.

## Форма безопасного паттерна

Собственное [руководство Microsoft по фоновым задачам в очереди](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) описывает каноническую структуру, и она состоит из трёх частей:

1. **Очередь единиц работы**, основанная на ограниченном `Channel<Func<CancellationToken, ValueTask>>`, зарегистрированная как singleton, чтобы производители и потребитель разделяли один экземпляр.
2. Единственный **потребитель `BackgroundService`**, который циклически извлекает по одной единице работы за раз, открывает DI-scope, выполняет её и перехватывает исключения для каждого элемента.
3. **Производители** (контроллеры, обработчики minimal API, другие сервисы), которые внедряют интерфейс очереди и ставят делегат в очередь вместо его выполнения встроенным образом.

Обработчик запроса возвращается в тот момент, когда единица работы поставлена в очередь. Сама работа выполняется на потребителе, полностью отвязанная от времени жизни запроса. Давайте построим каждую часть.

## Шаг 1: определить и реализовать ограниченную очередь

Очередь предоставляет две операции: постановку в очередь (вызывается производителями) и извлечение (вызывается потребителем). Единица работы - это `Func<CancellationToken, ValueTask>`, чтобы потребитель мог передать свой собственный токен отмены в момент выполнения.

```csharp
// .NET 11, C# 14 - IBackgroundTaskQueue.cs
public interface IBackgroundTaskQueue
{
    ValueTask QueueBackgroundWorkItemAsync(Func<CancellationToken, ValueTask> workItem);

    ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken);
}
```

Реализация оборачивает ограниченный channel. Ограничение channel не является опциональным в продакшен-сервисе: неограниченная очередь под производителем, который обгоняет потребителя, - это утечка памяти с лишними шагами.

```csharp
// .NET 11, C# 14 - BackgroundTaskQueue.cs
using System.Threading.Channels;

public sealed class BackgroundTaskQueue : IBackgroundTaskQueue
{
    private readonly Channel<Func<CancellationToken, ValueTask>> _queue;

    public BackgroundTaskQueue(int capacity)
    {
        // BoundedChannelFullMode.Wait makes QueueBackgroundWorkItemAsync await
        // a free slot once the queue is full, applying back pressure to producers
        // instead of dropping work or growing without bound.
        var options = new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait
        };
        _queue = Channel.CreateBounded<Func<CancellationToken, ValueTask>>(options);
    }

    public async ValueTask QueueBackgroundWorkItemAsync(
        Func<CancellationToken, ValueTask> workItem)
    {
        ArgumentNullException.ThrowIfNull(workItem);
        await _queue.Writer.WriteAsync(workItem);
    }

    public async ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken)
    {
        var workItem = await _queue.Reader.ReadAsync(cancellationToken);
        return workItem;
    }
}
```

Выбор `BoundedChannelFullMode` - это реальное проектное решение. `Wait` (выше) применяет back pressure к производителю, что для обработчика запроса означает, что вызов постановки в очередь ожидает, пока не появится место. Если вы предпочитаете сбрасывать нагрузку, а не заставлять запрос ждать, используйте `BoundedChannelFullMode.DropWrite` и проверяйте возвращаемое значение `TryWrite`. Что бы вы ни выбрали, делайте это осознанно. Если channels для вас в новинку, [использование Channels вместо BlockingCollection](/ru/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) объясняет модель reader/writer и почему `Channel<T>` является правильным асинхронным примитивом производитель-потребитель в современном .NET.

## Шаг 2: BackgroundService, который опустошает очередь

Потребитель - это единственный `BackgroundService`. Его единственная задача - извлекать по одной единице работы за раз и выполнять её внутри try/catch, чтобы единственная отравленная единица работы не могла убить цикл.

```csharp
// .NET 11, C# 14 - QueuedHostedService.cs
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

public sealed class QueuedHostedService(
    IBackgroundTaskQueue taskQueue,
    ILogger<QueuedHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is running.");
        await BackgroundProcessing(stoppingToken);
    }

    private async Task BackgroundProcessing(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var workItem = await taskQueue.DequeueAsync(stoppingToken);

            try
            {
                await workItem(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Expected during shutdown; let the loop unwind.
                break;
            }
            catch (Exception ex)
            {
                // The whole point: one failing item is logged, not lost, and the
                // loop survives to process the next item.
                logger.LogError(ex, "Error occurred executing background work item.");
            }
        }
    }

    public override async Task StopAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is stopping.");
        await base.StopAsync(stoppingToken);
    }
}
```

Try/catch для каждого элемента - это разница между этим и `Task.Run`. С `Task.Run` исключение остаётся ненаблюдаемым. Здесь каждый сбой попадает в `ILogger` с трассировкой стека, и потребитель продолжает опустошение. Это также причина, по которой единица работы - это `Func`, возвращающий `ValueTask`, а не делегат `async void`: тело `async void` бросает в пустоту, и вы снова возвращаетесь к проглоченным исключениям. Если различие между `async void` и `async Task` для вас размыто, [async void vs async Task в C#](/ru/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) точно излагает, почему `async void` зарезервирован для обработчиков событий и ничего больше.

## Шаг 3: зарегистрировать всё

Очередь - это singleton (один общий экземпляр), потребитель - это hosted service, и вы выбираете ёмкость. Ёмкость должна отражать, сколько работы вы готовы держать в памяти одновременно.

```csharp
// .NET 11, C# 14 - Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueuedHostedService>();
builder.Services.AddSingleton<IBackgroundTaskQueue>(_ =>
{
    // Tune to your workload. 100 means at most 100 queued items before
    // producers start waiting (with BoundedChannelFullMode.Wait).
    const int queueCapacity = 100;
    return new BackgroundTaskQueue(queueCapacity);
});

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();
```

## Шаг 4: постановка в очередь из обработчика запроса, со scope на каждую единицу работы

Теперь производитель. Контроллер внедряет `IBackgroundTaskQueue` и ставит делегат в очередь. Критическая деталь: делегат **не** должен замыкать ни один scoped-сервис из запроса. Scope запроса уже исчез к моменту выполнения работы. Вместо этого захватывайте только простые данные (идентификатор заказа, строку) и разрешайте scoped-сервисы из свежего scope внутри делегата с помощью `IServiceScopeFactory`.

```csharp
// .NET 11, C# 14 - OrdersController.cs
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

[ApiController]
[Route("orders")]
public sealed class OrdersController(
    IBackgroundTaskQueue queue,
    IServiceScopeFactory scopeFactory) : ControllerBase
{
    [HttpPost("{id:int}/confirm")]
    public async Task<IActionResult> Confirm(int id)
    {
        // Capture only the id - a value type, not a scoped service.
        await queue.QueueBackgroundWorkItemAsync(async token =>
        {
            // Fresh scope per work item: a clean DbContext, resolved and disposed here.
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
            await processor.ConfirmAsync(id, token);
        });

        // Returns immediately; the confirmation runs on the consumer.
        return Accepted();
    }
}
```

`HTTP 202 Accepted` здесь - честный код состояния: вы приняли запрос к обработке, а не завершили его. Возврат `200 OK` подразумевал бы, что работа сделана, чего нет.

Правило одного scope на единицу работы - это та же дисциплина, которая нужна вам везде, где singleton касается scoped-сервисов. Открытие одного `CreateAsyncScope()` на единицу работы, разрешение внутри него и его освобождение по завершении работы подробно рассмотрено в [использовании scoped-сервисов внутри BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/). Причина, по которой `await using` и `CreateAsyncScope()` важны (а не синхронный `CreateScope()`), в том, что `DbContext` из EF Core реализует `IAsyncDisposable` и может бросить исключение при синхронном освобождении.

Если вы пропустите scope и вместо этого захватите `DbContext` запроса напрямую в делегате, вы воспроизведёте в точности ту самую ошибку освобождённой зависимости из начала этой статьи, и часто [ошибку о второй операции на экземпляре контекста](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/), когда более поздний запрос переиспользует контекст, который фреймворк считает освобождённым. А если вы попытаетесь внедрить scoped-сервис прямо в singleton-потребителя, чтобы "упростить" вещи, вы столкнётесь при запуске с [невозможностью потребить scoped-сервис из singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

## Корректная остановка: опустошение против отказа

Именно здесь паттерн оправдывает свою ценность по сравнению с `Task.Run`. `BackgroundService` участвует в последовательности остановки хоста. Когда хост останавливается, он сигнализирует `stoppingToken`, и хост ждёт до таймаута остановки (30 секунд по умолчанию), пока `StopAsync` не вернётся.

Стоит осознанно подойти к двум вариантам поведения:

**Перестать принимать, завершить текущий элемент.** С циклом выше `DequeueAsync(stoppingToken)` бросает `OperationCanceledException`, как только срабатывает токен, цикл прерывается, и любая единица работы, выполняемая в данный момент, завершается (потому что мы делаем `await workItem(stoppingToken)` перед возвратом к циклу). Элементы, всё ещё лежащие в channel, отбрасываются. Для fire-and-forget в памяти это принятый компромисс.

**Дать выполняемой работе достаточно времени.** Если ваши единицы работы могут выполняться дольше пары секунд, поднимите таймаут остановки, чтобы хост не убивал наполовину завершённый элемент:

```csharp
// .NET 11, C# 14 - Program.cs
builder.Services.Configure<HostOptions>(options =>
{
    options.ShutdownTimeout = TimeSpan.FromSeconds(60);
});
```

Производитель, которому нужно, чтобы работа была привязана ко времени жизни приложения, а не к запросу, может принять `IHostApplicationLifetime` и ставить в очередь против `ApplicationStopping`, но для работы, инициированной запросом, `stoppingToken` потребителя - правильный сигнал. Что бы вы ни делали, пробрасывайте токен до самого конца вашей единицы работы. Единица работы, которая игнорирует токен и блокируется, будет удерживать всю остановку в заложниках на весь таймаут. Для работы, которую действительно нельзя отменить кооперативно, [отмена долго выполняющейся Task без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) рассматривает варианты.

## Параллельная обработка элементов без разделения scope

Цикл единственного потребителя обрабатывает по одному элементу за раз. Если ваши единицы работы независимы и вам нужна пропускная способность, вы можете выполнять несколько одновременно, но каждый параллельный элемент должен получить свой собственный scope, потому что `DbContext` и DI-scope не являются потокобезопасными. Ограничьте параллелизм с помощью `SemaphoreSlim`, чтобы всплеск постановок в очередь не мог насытить пул потоков:

```csharp
// .NET 11, C# 14 - inside BackgroundProcessing
private readonly SemaphoreSlim _concurrency = new(initialCount: 4);

private async Task BackgroundProcessing(CancellationToken stoppingToken)
{
    while (!stoppingToken.IsCancellationRequested)
    {
        var workItem = await taskQueue.DequeueAsync(stoppingToken);
        await _concurrency.WaitAsync(stoppingToken);

        // Fire each item on its own task; the semaphore caps concurrency at 4.
        _ = Task.Run(async () =>
        {
            try
            {
                await workItem(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error executing background work item.");
            }
            finally
            {
                _concurrency.Release();
            }
        }, stoppingToken);
    }
}
```

Обратите внимание, что `Task.Run` здесь приемлем в том смысле, в котором он не был приемлем в контроллере: он находится внутри отслеживаемого `BackgroundService`, каждое исключение перехватывается и журналируется, параллелизм ограничен, и каждая единица работы уже создаёт свой собственный scope внутренне. То, что делало `Task.Run` опасным в обработчике запроса (отсутствие отслеживания, отсутствие обработки исключений, захваченный scope запроса), здесь отсутствует. Компромисс в том, что параллельная обработка усложняет историю остановки, потому что выполняемые задачи больше не ожидаются циклом. Если вам нужны и параллелизм, и чистое опустошение, отслеживайте незавершённые задачи в `List<Task>` и делайте `await Task.WhenAll` для них в `StopAsync`.

## Когда очереди Channel недостаточно

Этот паттерн держит всё в памяти процесса. Это его сила (ноль внешней инфраструктуры) и его предел. Тянитесь к чему-то более тяжёлому, когда:

- **Работа должна пережить перезапуск.** Если потеря работы в очереди при развёртывании недопустима, вам нужна долговечность, которую channel дать не может. Сохраните задание в таблицу базы данных или отправьте его в Azure Storage Queues / Amazon SQS, и пусть `BackgroundService` (или отдельный процесс-воркер) извлекает оттуда. Форма постановки/потребления остаётся идентичной; меняется только хранилище-бэкенд.
- **Вы запускаете несколько экземпляров и нуждаетесь в exactly-once.** Очередь в памяти - на каждый экземпляр. Три pod'а означают три независимые очереди. Общая долговечная очередь с lease по таймауту видимости - это способ координации.
- **Вам нужны повторы, планирование или дашборды.** В этот момент библиотека вроде Hangfire или размещённая платформа заданий оправдывает свою сложность. Не пересобирайте планировщик заданий поверх channel.

Для долгоживущих воркеров, которые вы держите в продакшене, сочетайте очередь с наблюдаемостью, чтобы застрявший или молча падающий потребитель всплыл прежде, чем пользователи заметят; подход в [мониторинге фоновых заданий без Hangfire](/ru/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) применяется напрямую к этому потребителю.

Ментальная модель, которая удерживает всё это корректным: задача обработчика запроса - *принять* работу и вернуться, singleton-потребитель *владеет циклом и отменой*, а каждая единица работы *владеет свежим scope для своего собственного состояния*. В тот момент, когда вы схлопываете эти обязанности (выполняя работу встроенно, захватывая scope запроса или отсоединяя неотслеживаемую `Task`), один из трёх сбоев из начала этой статьи возвращается.

## Источники

- Microsoft Learn, [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) (обновлено 2026-05-05), канонический паттерн фоновых задач в очереди, на котором построен этот пост.
- Microsoft Learn, [System.Threading.Channels](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) для `BoundedChannelOptions` и `BoundedChannelFullMode`.
- Microsoft Learn, [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout) для настройки окна корректной остановки.
- Microsoft Learn, [`AsyncServiceScope` и `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope) для освобождения scope на каждую единицу работы.
