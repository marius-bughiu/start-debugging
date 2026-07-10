---
title: "Что такое контракт IHostedService и когда его использовать?"
description: "IHostedService -- это интерфейс из двух методов (StartAsync/StopAsync), которые универсальный хост .NET вызывает при запуске и корректном завершении. Вот что гарантирует контракт, когда реализовывать его напрямую и какие изменения поведения в .NET 10 и 11 застают людей врасплох."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "aspnetcore"
  - "csharp"
lang: "ru"
translationOf: "2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it"
translatedBy: "claude"
translationDate: 2026-07-10
---

`IHostedService` -- это интерфейс из двух методов, который универсальный хост .NET использует для запуска и остановки долгоживущей работы вместе с вашим приложением. У него ровно два члена, `StartAsync(CancellationToken)` и `StopAsync(CancellationToken)`, и хост вызывает их в чётко определённых точках: `StartAsync` до того, как приложение начнёт обслуживать запросы, `StopAsync` во время корректного завершения. Вы реализуете его напрямую, когда вам нужен точный контроль над упорядоченными шагами запуска или завершения. Для непрерывных циклов вам почти всегда нужен `BackgroundService` -- небольшой абстрактный класс, который реализует `IHostedService` за вас. В этой статье объясняется, что на самом деле гарантирует контракт, когда обращаться к сырому интерфейсу и какие изменения поведения в .NET 10 и .NET 11 заставляют людей спотыкаться.

Всё здесь ориентировано на .NET 11 и C# 14 с `Microsoft.Extensions.Hosting` 11.0.x. Там, где поведение изменилось в конкретной версии, я указываю на это.

## Контракт -- это два метода и обещание последовательности

Вот весь интерфейс целиком:

```csharp
// .NET 11, C# 14 -- Microsoft.Extensions.Hosting.Abstractions
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

Это вся поверхность. Полезным его делает не форма методов, а гарантии, которыми хост оборачивает их:

- Хост ожидает (`await`) `StartAsync` у каждой зарегистрированной размещённой службы **до** того, как приложение будет считаться запущенным. В приложении ASP.NET Core это означает до того, как Kestrel примет первый запрос.
- По умолчанию службы запускаются **последовательно, в порядке регистрации**. Хост не вызывает `StartAsync` следующей службы, пока `Task`, возвращённый текущей, не завершится.
- При завершении хост вызывает `StopAsync` у каждой службы в **обратном** порядке регистрации и ждёт до `HostOptions.ShutdownTimeout` (по умолчанию 30 секунд), пока они завершатся.

Обещание последовательности -- вот причина, по которой это важно. Если вам нужно "прогрей этот кеш до того, как какой-либо запрос сможет попасть на холодный путь" или "открой это соединение до того, как запустится потребитель очереди", то `StartAsync` -- правильный крючок, потому что хост не продолжит, пока он не вернёт управление.

## Почему StartAsync должен быть быстрым

Поскольку запуск по умолчанию последователен, медленный `StartAsync` задерживает каждую службу, зарегистрированную после него, и задерживает выход всего приложения в онлайн. Это самая распространённая ошибка с сырым интерфейсом: поместить долгоживущий цикл прямо внутрь `StartAsync` и никогда не возвращать управление.

```csharp
// .NET 11, C# 14 -- WRONG: the host never finishes starting
public sealed class BrokenWorker : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // This loop never returns, so StartAsync never completes,
        // so the host never starts, so no requests are served.
        while (!ct.IsCancellationRequested)
        {
            await DoWorkAsync();
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Решение -- относиться к `StartAsync` как к "запусти работу и верни управление". Запустите цикл как фоновую `Task`, сохраните ссылку на неё и ожидайте эту ссылку в `StopAsync`:

```csharp
// .NET 11, C# 14 -- correct raw IHostedService with a background loop
public sealed class QueueDrainService(ILogger<QueueDrainService> logger) : IHostedService
{
    private readonly CancellationTokenSource _stopping = new();
    private Task? _loop;

    public Task StartAsync(CancellationToken ct)
    {
        // Return quickly. Capture the loop task; do not await it here.
        _loop = RunAsync(_stopping.Token);
        return Task.CompletedTask;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await DrainOnceAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _stopping.Cancel();
        // Wait for the loop to unwind, but respect the shutdown deadline.
        if (_loop is not null)
            await _loop.WaitAsync(ct).ConfigureAwait(false);
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Если этот шаблон выглядит как шаблонный код, то в этом и суть: это тот шаблонный код, ради устранения которого существует `BackgroundService`.

## Где место у BackgroundService

`BackgroundService` -- это абстрактный класс в том же пространстве имён, который реализует `IHostedService` и даёт вам единственный метод для переопределения:

```csharp
// .NET 11, C# 14 -- the shape BackgroundService hands you
public sealed class QueueDrainService(ILogger<QueueDrainService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await DrainOnceAsync(stoppingToken); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Базовый класс сохраняет задачу, возвращённую `ExecuteAsync`, отменяет `stoppingToken`, когда хост останавливается, и ожидает ваш цикл в собственном `StopAsync`. Это тот же жизненный цикл, что и в сыром примере выше, но без обвязки.

Итак, практическое правило таково: **реализуйте `IHostedService` напрямую только тогда, когда вам нужно, чтобы работа завершилась внутри `StartAsync` до выхода приложения в онлайн, или упорядоченная работа завершения внутри `StopAsync`.** Для непрерывного цикла, которому просто нужно работать, пока работает приложение, используйте `BackgroundService`. Если вам нужно более глубокое сравнение, включающее системы устойчивых задач, смотрите [матрицу решения для BackgroundService, IHostedService и Hangfire](/ru/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/).

## Изменение в .NET 10, которое увело ExecuteAsync с основного потока

До .NET 10 в `BackgroundService` была тонкая ловушка: синхронная часть `ExecuteAsync`, то есть всё до первого `await`, выполнялась в основном потоке во время запуска и блокировала запуск других служб. Только код после первого `await` перемещался в фоновый поток.

Начиная с .NET 10, [`BackgroundService` выполняет весь `ExecuteAsync` в фоновом потоке](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task), поэтому ни одна его часть не блокирует запуск других служб. Это долгожданное исправление, но оно меняет предположение, на которое опирался некоторый код. Если вы намеренно выполняли работу по настройке до первого `await`, чтобы она шла во время запуска, то теперь эта работа находится вне пути запуска.

Если вам снова нужно, чтобы что-то выполнялось синхронно во время запуска, документация перечисляет варианты: сделайте это в конструкторе, переопределите `StartAsync` и выполните перед `base.StartAsync`, реализуйте `IHostedLifecycleService` (ниже) или спуститесь до сырого `IHostedService`. У сырого интерфейса этой неоднозначности никогда не было, что является ещё одной причиной использовать его, когда порядок запуска действительно важен.

## IHostedLifecycleService для более детальных крючков

Когда двух крючков `StartAsync` недостаточно, в .NET 8 добавили `IHostedLifecycleService`, который расширяет `IHostedService` ещё четырьмя обратными вызовами:

```csharp
// .NET 11, C# 14 -- extends IHostedService with pre/post hooks
public interface IHostedLifecycleService : IHostedService
{
    Task StartingAsync(CancellationToken cancellationToken);
    Task StartedAsync(CancellationToken cancellationToken);
    Task StoppingAsync(CancellationToken cancellationToken);
    Task StoppedAsync(CancellationToken cancellationToken);
}
```

Хост вызывает их вокруг двух центральных методов в таком порядке: `StartingAsync` у всех служб, затем `StartAsync` у всех служб, затем `StartedAsync` у всех служб. Завершение зеркалит это: `StoppingAsync`, затем `StopAsync`, затем `StoppedAsync`. Отличие от простого `IHostedService` в том, что эти фазы выполняются как *пакеты* по всем службам, поэтому `StartingAsync` -- это место для работы, которая должна произойти до `StartAsync` **любой** службы, а не только своей.

Это редко нужно. Обращайтесь к нему, когда у вас есть межслужебные ограничения порядка, например "каждая служба должна завершить свою предзапусковую работу до того, как любая из них откроет сетевой слушатель". Для обычного случая достаточно простого `IHostedService` или `BackgroundService`.

## Регистрация размещённых служб

Регистрация -- это одна строка, а время жизни DI фиксировано:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueueDrainService>();
builder.Services.AddHostedService<CacheWarmer>();

var app = builder.Build();
app.Run();
```

`AddHostedService<T>` регистрирует тип как **singleton** `IHostedService`. У этого есть последствие, на которое люди постоянно натыкаются: вы не можете внедрить службу с областью (scoped, например пулированный `DbContext`) напрямую в конструктор размещённой службы, потому что singleton не может зависеть от службы с областью. Вместо этого внедрите `IServiceScopeFactory` и создавайте область на каждую единицу работы. Эта конкретная ловушка и её точное сообщение об исключении разбираются в статье [почему нельзя использовать службу с областью из singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/), а правильный шаблон работы с областями -- в [как использовать службы с областью внутри BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

Порядок регистрации -- это порядок вызовов `StartAsync` и обратный порядок вызовов `StopAsync`, поэтому регистрируйте первыми те службы, от запуска которых зависят другие.

## Уважайте токены отмены

Оба метода получают `CancellationToken`, и они означают разное.

Токен, переданный в `StartAsync`, сигнализирует о том, что запуск прерывается. На практике он срабатывает редко, но вам всё равно следует прокидывать его через любые асинхронные вызовы, которые вы делаете, чтобы Ctrl+C во время медленного запуска действительно отменял его.

Токен, переданный в `StopAsync`, -- вот тот, что важен. Он отменяется, когда истекает срок корректного завершения (`HostOptions.ShutdownTimeout`, по умолчанию 30 секунд). Если ваш `StopAsync` игнорирует его и продолжает ждать, хост всё равно в итоге снесёт процесс, и незавершённая работа будет потеряна. Поэтому ваша логика завершения должна останавливаться *незамедлительно*, когда этот токен срабатывает, сбрасывая или ставя контрольную точку на то, что успевает, вместо попытки закончить всё.

```csharp
// .NET 11, C# 14 -- extend the shutdown window when your drain is slow
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(60));
```

Увеличивайте таймаут только если вашей работе действительно нужно больше времени, чтобы чисто опустошиться. Правильная отмена по токену -- более важная привычка, и она сочетается с тем, чтобы верно выполнять отмену во всём остальном асинхронном коде, что является отдельной темой в статье [как отменить долго выполняющуюся Task без взаимной блокировки](/ru/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Изменение в .NET 11, касающееся кодов выхода при сбоях

Вот изменение поведения, которое с наибольшей вероятностью удивит вас при обновлении. Когда `BackgroundService` выбрасывает необработанное исключение из `ExecuteAsync`, а `HostOptions.BackgroundServiceExceptionBehavior` оставлено на значении по умолчанию `StopHost`, хост останавливается. Это значение по умолчанию действует с .NET 6 (до этого значением по умолчанию было `Ignore`, которое молча оставляло вас с зомби-хостом, выглядевшим живым, но не делавшим работы).

Что изменилось в .NET 11 Preview 3 -- это код выхода. Раньше задача, возвращённая `RunAsync`, `StopAsync` или `WaitForShutdownAsync`, завершалась *успешно*, даже если служба упала, поэтому процесс обычно выходил с кодом ноль, и ваш оркестратор считал, что всё в порядке. Начиная с .NET 11, [эти методы теперь завершаются с исключением](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure), поэтому процесс выходит с ненулевым кодом. Одна упавшая служба перебрасывает своё исключение; несколько сбоев возвращаются как `AggregateException`.

Это почти всегда то поведение, которое вам нужно: упавший фоновый рабочий не должен сообщать об успехе. Но если у вас был код, полагавшийся на старое поведение молчаливого успеха, теперь вы увидите ненулевой выход и, возможно, необработанное исключение на верхнем уровне `Program.cs`. Рекомендуемое Microsoft действие -- ничего не делать и позволить упасть громко. Если вам действительно нужно старое поведение, оберните `await host.RunAsync()` в try/catch или верните поведение исключений на `Ignore` и примите компромисс:

```csharp
// .NET 11, C# 14 -- opt back into the old, quieter behavior (usually a mistake)
builder.Services.Configure<HostOptions>(o =>
    o.BackgroundServiceExceptionBehavior =
        BackgroundServiceExceptionBehavior.Ignore);
```

Я бы не стал обращаться к `Ignore`. Размещённая служба, которая может упасть и оставить хост работающим, но бездействующим, гораздо труднее диагностируется, чем та, что валит процесс и перезапускается вашим оркестратором. Лучшее исправление -- перехватывать и логировать внутри вашего цикла, как это делают предыдущие примеры, чтобы одна неудачная итерация никогда не превращалась в необработанное исключение.

## Когда сырой интерфейс -- правильный выбор

Собирая всё вместе, реализуйте `IHostedService` напрямую, когда:

- У вас есть работа запуска, которая **должна завершиться до того, как приложение начнёт обслуживать трафик**: прогреть кеш, выполнить проверку схемы или миграции, установить пул соединений. Поместите её в `StartAsync` и позвольте гарантии последовательного запуска сделать своё дело.
- У вас есть работа завершения, которая должна выполняться в **определённом порядке**: сбросить буфер, снять регистрацию с конечной точки обнаружения служб, отправить финальную метрику. Поместите её в `StopAsync`.
- Вы хотите, чтобы обвязка была явной, потому что жизненный цикл необычен, и вы предпочли бы читать его, а не полагаться на базовый класс.

Используйте `BackgroundService` для гораздо более распространённого случая цикла, который работает на протяжении всей жизни приложения. Используйте `IHostedLifecycleService` только когда вам нужны пакетные фазы предзапуска или послезавершения по нескольким службам. И что бы вы ни выбрали, уважайте токены отмены, держите `StartAsync` быстрым и позволяйте сбоям выходить на поверхность. О связанных шаблонах смотрите [как безопасно выполнять работу по принципу fire-and-forget с BackgroundService](/ru/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Источники

- [IHostedService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedservice)
- [IHostedLifecycleService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedlifecycleservice)
- [Breaking change: BackgroundService runs all of ExecuteAsync as a Task (.NET 10)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task)
- [Breaking change: IHost.RunAsync and IHost.StopAsync throw when a BackgroundService fails (.NET 11)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure)
- [BackgroundServiceExceptionBehavior Enum -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.backgroundserviceexceptionbehavior)
