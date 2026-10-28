---
title: "Исправление: Cannot access a disposed object. Object name: 'IServiceProvider'"
description: "Код получил сервис из области DI или корневого провайдера после его освобождения. Сохраняйте IServiceScopeFactory вместо IServiceProvider и создавайте новую область там, где выполняется работа."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "aspnetcore"
  - "dependency-injection"
lang: "ru"
translationOf: "2026/10/fix-cannot-access-a-disposed-object-object-name-iserviceprovider"
translatedBy: "claude"
translationDate: 2026-10-28
---

Суть исправления: что-то вызвало `GetService`, `GetRequiredService` или `CreateScope` у `IServiceProvider`, область которого (или весь контейнер) уже была освобождена. Обычно это задача "выстрелил и забыл", захватившая `HttpContext.RequestServices`, сервис, сохранивший `IServiceProvider` области ради "ленивого" получения зависимостей, или фоновый цикл, продолжающий работать после остановки хоста. Перестаньте хранить `IServiceProvider`. Внедряйте `IServiceScopeFactory`, вызывайте `CreateAsyncScope()` в том месте, где работа действительно выполняется, и получайте все зависимости из этой новой области.

```text
System.ObjectDisposedException: Cannot access a disposed object.
Object name: 'IServiceProvider'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ThrowHelper.ThrowObjectDisposedException()
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

Каждый фрагмент кода и каждая строка вывода в этой статье получены из воспроизведения на .NET 10 (среда выполнения 10.0.10, `Microsoft.Extensions.DependencyInjection` из общего фреймворка, ASP.NET Core 10.0.10). Проверка, которая выбрасывает это исключение, идентична в ветке `release/11.0` репозитория `dotnet/runtime`, поэтому тот же анализ применим к .NET 11.

## Почему контейнер выбрасывает исключение, а не возвращает null

В `Microsoft.Extensions.DependencyInjection` каждая область представлена объектом `ServiceProviderEngineScope`. Он одновременно реализует `IServiceScope`, `IServiceProvider` и `IServiceScopeFactory`, а `IServiceProvider`, который вы получаете из `scope.ServiceProvider`, и есть сам объект области. Когда область освобождается, она освобождает все созданные ею `IDisposable`/`IAsyncDisposable`, затем устанавливает закрытый флаг `_disposed`. С этого момента `GetService`, `GetKeyedService` и `GetRequiredKeyedService` начинаются с одной и той же проверки:

```csharp
// dotnet/runtime, release/10.0
// src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs
public object? GetService(Type serviceType)
{
    if (_disposed)
    {
        ThrowHelper.ThrowObjectDisposedException();
    }

    return RootProvider.GetService(ServiceIdentifier.FromServiceType(serviceType), this);
}

// ThrowHelper.cs
internal static void ThrowObjectDisposedException()
{
    throw new ObjectDisposedException(nameof(IServiceProvider));
}
```

Именно из-за `nameof(IServiceProvider)` имя объекта всегда равно `'IServiceProvider'`, независимо от того, попали ли вы на область запроса, на область, созданную вручную, или на корневой `ServiceProvider`. У корневого провайдера есть собственный флаг `_disposed`, и он проходит через тот же вспомогательный метод, поэтому по одному сообщению не понять, *какой* именно провайдер освобождён. Это показывает трассировка стека: `ServiceProviderEngineScope.GetService` означает область, а кадр в `ServiceProvider.CreateScope` или `ServiceProvider.GetService` означает, что корневой контейнер уничтожен, а это почти всегда значит, что хост был освобождён.

Два следствия такого устройства важны при отладке:

1. **Исключение выбрасывает только получение сервиса.** Экземпляр, который вы получили до завершения области, остаётся обычным объектом. Если у него есть собственная защита от повторного использования после освобождения (`DbContext`, `HttpClient`, `CancellationTokenSource`), то при обращении к нему вы получите `ObjectDisposedException` *этого* типа с его собственным именем объекта, а не это.
2. **Провайдер не "сломан", он завершён.** Оживить освобождённую область нельзя. Исправление всегда одно: использовать область, время жизни которой покрывает работу.

## Четыре сценария, которые это вызывают

Я воспроизвёл каждый из них в одном консольном приложении (`Microsoft.NET.Sdk.Web`, `net10.0`). Все четыре вывели в точности приведённое выше сообщение.

### 1. Провайдер области, который выходит за пределы своего `using`

Минимально возможное воспроизведение. Переменная живёт дольше области:

```csharp
// .NET 10, C# 14
var services = new ServiceCollection();
services.AddScoped<Repo>();
using var root = services.BuildServiceProvider();

IServiceProvider leaked;
using (var scope = root.CreateScope())
{
    leaked = scope.ServiceProvider;
}

leaked.GetRequiredService<Repo>(); // ObjectDisposedException: 'IServiceProvider'
```

Никто не пишет такое намеренно, но в замаскированном виде оно встречается постоянно: вспомогательный метод, делающий `using var scope = ...; return scope.ServiceProvider;`, или `async`-метод, который создаёт область через `using var`, а затем возвращает `Task` или `IAsyncEnumerable`, продолжающий получать сервисы из неё после того, как синхронная часть метода уже вернула управление.

### 2. Задача "выстрелил и забыл", захватившая `HttpContext.RequestServices`

С этим сценарием сюда попадает большинство. ASP.NET Core лениво создаёт область запроса в `RequestServicesFeature` и регистрирует эту возможность через `Response.RegisterForDisposeAsync`, поэтому область освобождается сразу после завершения ответа. Отделённая задача, взявшая `RequestServices`, проигрывает гонку:

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- wrong
app.MapPost("/orders/{id}/export", (int id, HttpContext ctx) =>
{
    var sp = ctx.RequestServices;
    _ = Task.Run(async () =>
    {
        await Task.Delay(200);                       // the response is already sent
        var exporter = sp.GetRequiredService<OrderExporter>(); // throws
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

В моём воспроизведении конечная точка вернула `202`, а через 200 мс задача записала в журнал `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.` Поскольку исключение возникает в ненаблюдаемой задаче, его часто видно только в журналах, а иногда и вовсе не видно, и симптом выглядит так: "экспорт молча не выполняется". То же самое происходит, когда задача захватывает `IServiceProvider` через внедрение в конструктор контроллера или позже читает `IHttpContextAccessor.HttpContext.RequestServices` (где вы можете получить и `null`, потому что контекст уже переиспользован).

### 3. Сервис, который сохраняет `IServiceProvider` на потом

Вариант "локатор служб". Временный (transient) или областной (scoped) сервис принимает `IServiceProvider` в конструкторе, чтобы получать зависимости по требованию:

```csharp
// .NET 10, C# 14 -- wrong
class ReportBuilder(IServiceProvider sp)
{
    public void Build() => sp.GetRequiredService<Repo>().Save();
}

ReportBuilder rb;
using (var scope = root.CreateScope())
    rb = scope.ServiceProvider.GetRequiredService<ReportBuilder>();

rb.Build(); // ObjectDisposedException: 'IServiceProvider'
```

`IServiceProvider`, внедрённый в областной или временный сервис, это область, из которой он был получен, а не корень. Как только `ReportBuilder` передаётся чему-то, что живёт дольше области (кешу-синглтону, подписке на событие синглтона, статическому полю, `Lazy<T>`, фабрике `Func<T>`, зарегистрированной как `sp => () => sp.GetRequiredService<T>()`), следующее ленивое получение сервиса выбросит исключение. Если вы встречали [ошибку захваченной зависимости "Cannot consume scoped service from singleton"](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/), это её родственник времени выполнения: проверка областей ловит захваченные *сервисы* на этапе построения, но не видит захваченный *провайдер*.

### 4. Фоновый цикл, переживающий хост

Корневой провайдер освобождается вместе с хостом. `BackgroundService.StopAsync` отменяет токен остановки и ждёт `ExecuteAsync`, но только до истечения `HostOptions.ShutdownTimeout` (по умолчанию 30 секунд начиная с .NET 6). Цикл, игнорирующий токен, продолжает работать после того, как хост пошёл дальше и освободил контейнер:

```csharp
// .NET 10 -- wrong: ignores stoppingToken
class StubbornWorker(IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            using var scope = scopes.CreateScope(); // throws once the host is disposed
            scope.ServiceProvider.GetRequiredService<Repo>().Save();
            await Task.Delay(250);
        }
    }
}
```

При `ShutdownTimeout`, равном 1 секунде, `StopAsync` вернул управление, выполнился `host.Dispose()`, и следующая итерация вывела `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.`. Заметьте, что этот воркер всё делает правильно в отношении областей. Ошибка только в проигнорированном токене отмены. Тот же сбой проявляется с обратными вызовами `System.Threading.Timer`, потребителями `Channel`, запущенными через `Task.Run`, и обработчиками шины сообщений, которые продолжают работать после остановки. В тестах он проявляется, когда `WebApplicationFactory<T>` или фикстура хоста освобождается, пока тест (или фоновая задача, запущенная тестом) всё ещё получает сервисы из `factory.Services`.

## Исправление 1: сохраняйте `IServiceScopeFactory`, а не `IServiceProvider`

Для сценариев 2 и 3 это и есть исправление. `IServiceScopeFactory` в контейнере особенный: `ServiceProvider` регистрирует его как константный call site, указывающий на **корневую** область, поэтому неважно, откуда вы его получаете. Даже `IServiceScopeFactory`, внедрённый в конечную точку с областью запроса, привязан к корневому контейнеру и продолжает работать после завершения запроса. Создавайте область внутри отделённой работы, чтобы время жизни области в точности совпадало со временем жизни работы:

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- right
app.MapPost("/orders/{id}/export", (int id, IServiceScopeFactory scopes) =>
{
    _ = Task.Run(async () =>
    {
        await using var scope = scopes.CreateAsyncScope();
        var exporter = scope.ServiceProvider.GetRequiredService<OrderExporter>();
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

В воспроизведении та же задержка в 200 мс, которая ломала версию с `RequestServices`, здесь привела к записи `good: ok` в журнал. Предпочитайте `CreateAsyncScope()` с `await using`: если какой-либо сервис в области реализует только `IAsyncDisposable`, синхронный `Dispose()` области выбросит `InvalidOperationException` с требованием использовать `DisposeAsync`. Почему так, разбирает [руководство по `IAsyncDisposable` и `await using`](/ru/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/).

Не передавайте через область и данные, привязанные к запросу. Скопируйте нужное (идентификаторы, имя пользователя, идентификатор корреляции) в локальные переменные до запуска задачи. Сам `HttpContext` небезопасно трогать после завершения ответа.

Для варианта с локатором служб внедрите `IServiceScopeFactory` в `ReportBuilder` и создавайте область на каждый вызов `Build()`, а лучше внедрите `Repo` напрямую и предоставьте контейнеру управление временем жизни. Если зависимость действительно необязательна или дорога в создании, регистрация по ключу или через фабрику, получающую сервис из новой области, чище, чем хранение провайдера.

## Исправление 2: перенесите работу в настоящий механизм фоновой обработки

`Task.Run` из обработчика запроса и есть корень проблемы в сценарии 2. Никто не отслеживает задачу, никто не наблюдает её исключение, и ничто не останавливает её при завершении работы. Поместите элемент работы в `Channel<T>` и разбирайте очередь в `BackgroundService`, который создаёт одну область на элемент:

```csharp
// .NET 10, C# 14
public sealed class ExportQueue
{
    private readonly Channel<int> _channel = Channel.CreateUnbounded<int>();
    public ValueTask EnqueueAsync(int orderId) => _channel.Writer.WriteAsync(orderId);
    public IAsyncEnumerable<int> ReadAllAsync(CancellationToken ct) => _channel.Reader.ReadAllAsync(ct);
}

public sealed class ExportWorker(ExportQueue queue, IServiceScopeFactory scopes, ILogger<ExportWorker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var id in queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<OrderExporter>().ExportAsync(id, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Export of order {OrderId} failed", id);
            }
        }
    }
}

// Program.cs
builder.Services.AddSingleton<ExportQueue>();
builder.Services.AddHostedService<ExportWorker>();
app.MapPost("/orders/{id}/export", async (int id, ExportQueue queue) =>
{
    await queue.EnqueueAsync(id);
    return Results.Accepted();
});
```

Полный шаблон, включая ограниченные каналы и противодавление, описан в статье [как безопасно запускать работу "выстрелил и забыл" через BackgroundService](/ru/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/). Подход "область на итерацию" подробно разобран в статье [об использовании областных сервисов внутри BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

## Исправление 3: учитывайте токен остановки, чтобы ничего не работало после освобождения

В сценарии 4 код работы с областями в порядке, а ошибка в времени жизни цикла. Передавайте `stoppingToken` в каждый await и в условие цикла, чтобы цикл завершался до истечения `ShutdownTimeout`:

```csharp
// .NET 10 -- right
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
    while (await timer.WaitForNextTickAsync(stoppingToken))
    {
        await using var scope = scopes.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<Repo>().SaveAsync(stoppingToken);
    }
}
```

`PeriodicTimer.WaitForNextTickAsync` выбрасывает `OperationCanceledException` при отмене, а `BackgroundService` считает отмену, совпадающую с токеном остановки, штатным завершением. Если отдельная единица работы законно занимает больше 30 секунд, увеличьте `HostOptions.ShutdownTimeout`, а не игнорируйте токен: иначе хост освободит контейнер прямо у вас из-под ног. [Статья о контракте IHostedService](/ru/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) подробно описывает точный порядок запуска и остановки.

Для интеграционных тестов убедитесь, что тест дожидается каждой запущенной им задачи до выполнения `DisposeAsync` фикстуры, и получайте сервисы для каждого теста из `factory.Services.CreateAsyncScope()`, а не напрямую из `factory.Services`.

## Подводные камни и похожие ошибки

**Гонка внутри получения сервиса.** `ServiceProviderEngineScope.CaptureDisposable` проверяет `_disposed` под блокировкой после создания освобождаемого сервиса. Если область была освобождена *в тот момент*, когда ваш сервис создавался в другом потоке, контейнер освобождает только что созданный экземпляр и затем выбрасывает то же самое исключение. Поэтому вы можете увидеть его на пути выполнения, который микросекундой раньше выглядел нормально. Это та же ошибка: два потока расходятся во мнении о времени жизни области.

**`app.Services` после возврата из `app.Run`.** Всё, что в `Program.cs` выполняется после `app.Run()` или `await app.RunAsync()` (код очистки, финальный сброс буферов), выполняется после освобождения хоста. Получите нужное до вызова `Run` или перенесите логику в обратный вызов `IHostApplicationLifetime.ApplicationStopping`.

**`IServiceProvider` в синглтоне это корень.** Внедрение `IServiceProvider` в синглтон даёт корневой провайдер, который освобождается только вместе с хостом, поэтому при нормальной работе это исключение он не выбросит. Зато при выключенном `ValidateScopes` он с готовностью выдаст областные сервисы из корневой области, превращая их в случайные синглтоны. Используйте `IServiceScopeFactory` и здесь.

**"Cannot access a disposed context instance".** Если в вашем сообщении имя объекта совпадает с типом вашего `DbContext` (`Object name: 'AppDb'`), то освобождены сервисы области, а не провайдер, и исправление состоит в новом контексте на каждую операцию: см. [руководство по освобождённому DbContext](/ru/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/).

**`Object name: 'System.Net.Http.HttpClient'` или `CancellationTokenSource`.** Тот же тип исключения, другой владелец. Такие ошибки возникают из-за освобождения полученного вами экземпляра, а не из-за получения сервиса после освобождения.

## Связанные материалы

- [Fix: Cannot consume scoped service from singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/) о версии с захваченными временами жизни на этапе построения.
- [How to use scoped services inside a BackgroundService](/ru/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) о шаблоне "область на единицу работы".
- [How to run fire-and-forget work safely with BackgroundService](/ru/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) о замене `Task.Run` в обработчиках.
- [Fix: Cannot access a disposed context instance](/ru/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) о варианте той же ошибки времени жизни в EF Core.
- [How to write integration tests with WebApplicationFactory](/ru/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) о времени жизни фикстур в тестах.

## Источники

- [`ServiceProviderEngineScope.cs` в `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs) (защита `_disposed` и `CaptureDisposable`).
- [`ThrowHelper.cs` в `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ThrowHelper.cs) (`new ObjectDisposedException(nameof(IServiceProvider))`).
- [`ServiceProvider.cs` в `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceProvider.cs) (`IServiceScopeFactory` зарегистрирован как константа, привязанная к корневой области).
- [`RequestServicesFeature.cs` в `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http/src/Features/RequestServicesFeature.cs) (область запроса освобождается через `RegisterForDisposeAsync`).
- [Dependency injection guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines) на Microsoft Learn.
- [Use scoped services within a BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) на Microsoft Learn.
- Справочник по API [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout).
