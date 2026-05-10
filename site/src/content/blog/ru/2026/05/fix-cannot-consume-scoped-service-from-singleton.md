---
title: "Решение: Cannot consume scoped service 'X' from singleton 'Y'"
description: "Валидация области в ASP.NET Core выбрасывает это, когда singleton захватил бы scoped-зависимость на весь процесс. Сделайте потребителя scoped или внедрите IServiceScopeFactory и создавайте область по требованию."
pubDate: 2026-05-10
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "ru"
translationOf: "2026/05/fix-cannot-consume-scoped-service-from-singleton"
translatedBy: "claude"
translationDate: 2026-05-10
---

Решение: валидатор области ASP.NET Core заблокировал захваченную зависимость. Singleton `Y` запросил у корневого провайдера scoped-сервис `X`, что привязало бы `X` ко всему процессу и полностью обошло жизненный цикл на уровне запроса. Либо измените `Y` на scoped (предпочтительно, когда `Y` потребляется внутри области запроса), либо оставьте `Y` как singleton и внедрите `IServiceScopeFactory`, создавая новую область каждый раз, когда нужен `X`. Конкретно для `DbContext` используйте `IDbContextFactory<T>`.

```text
System.InvalidOperationException: Cannot consume scoped service 'MyApp.Data.AppDbContext' from singleton 'MyApp.Workers.OrderProcessor'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.CallSiteValidator.ValidateCallSite(ServiceCallSite callSite)
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProvider.GetService(Type serviceType, ServiceProviderEngineScope serviceProviderEngineScope)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.Hosting.Internal.Host.StartAsync(CancellationToken cancellationToken)
```

Это руководство написано для .NET 11 preview 4, `Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4 и `Microsoft.Extensions.Hosting` 11.0.0-preview.4. Текст исключения и валидатор, который его выбрасывает, стабильны с .NET Core 2.0, поэтому каждое решение ниже без изменений применимо к .NET Core 3.1, .NET 5, 6, 8, 10 и 11.

Два имени типов в сообщении --- первое, что нужно прочитать: **первое** имя --- это **scoped**-сервис, а **второе** имя --- это потребитель **singleton**, который его запросил. Ошибка всегда называет их именно в таком порядке, хотя поисковики в половине случаев выводят вас на не ту половину сообщения.

## Почему валидация области отвергает эту комбинацию

Singleton живёт один раз на процесс. Scoped-сервис живёт один раз на область запроса (или один раз на вызов `IServiceScopeFactory.CreateScope()`). Если singleton сохраняет ссылку на scoped-сервис в поле, эта scoped-инстанция переживает все последующие запросы, сводя на нет весь смысл scoped-времени жизни: состояние на запрос, пул соединений на область, отслеживание изменений на область, изоляцию по арендатору на область.

Опция `ValidateScopes` в ASP.NET Core ловит это во время разрешения, обходя граф call site до того, как конструктор успеет выполниться. В `Development` `WebApplication.CreateBuilder` включает `ValidateScopes` автоматически; в `Production` --- нет, и именно поэтому некоторые команды видят исключение только локально и отправляют captive-баг в production, где он проявляется как устаревшие данные, утечки соединений или `ObjectDisposedException` на `DbContext`, который уже был освобождён вместе с исходной областью запроса.

Этот баг принимает ровно четыре формы:

1. **Параметр конструктора singleton --- scoped.** Самый распространённый случай. Конструктор `BackgroundService` (singleton) запрашивает `IUserRepository` (scoped).
2. **Параметр конструктора singleton сам является singleton, но транзитивно зависит от scoped.** Singleton `IFooFactory` принимает singleton `IFooDeps`, который принимает scoped `IUnitOfWork`. Валидатор идёт по графу.
3. **Singleton разрешает scoped напрямую через `IServiceProvider`.** `_provider.GetRequiredService<IUserRepository>()` изнутри singleton, где `_provider` --- **корневой** провайдер. У провайдера нет области, поэтому валидатор выбрасывает исключение.
4. **Hosted-сервис / воркер очереди / коллбек таймера, работающий вне какого-либо запроса.** Хост вызывает singleton из потока, в котором нет окружающей области, поэтому любое scoped-разрешение идёт против корневого.

Первые три падают при старте или при первом вызове. Четвёртый падает в момент срабатывания таймера. Одно и то же исключение, разные пути отладки.

## Минимальное воспроизведение

Самое маленькое консольное приложение .NET 11, которое выбрасывает это исключение:

```csharp
// .NET 11 preview 4, Microsoft.Extensions.Hosting 11.0.0-preview.4
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddScoped<IUserRepository, UserRepository>();
builder.Services.AddHostedService<OrderProcessor>();

var host = builder.Build();
await host.RunAsync();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}

public sealed class OrderProcessor(IUserRepository repo) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            Console.WriteLine(repo.GetName(1));
            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddHostedService<T>` регистрирует `OrderProcessor` как singleton. Конструктор требует `IUserRepository`, который scoped. Сборщик хоста вызывает `GetRequiredService` на корневом провайдере во время `StartAsync`, валидатор обходит call site, видит ребро scoped-в-singleton и выбрасывает исключение.

## Решение первое: сделайте потребителя scoped, когда он умещается в запрос

Самое чистое решение, когда потребитель достигается **на запрос**. Контроллер, обработчик минимального API endpoint, MVC-фильтр, метод хаба SignalR --- все они работают внутри существующей области. Если вы случайно зарегистрировали их как singleton, измените регистрацию:

```csharp
// .NET 11 preview 4
// Wrong: pulls AppDbContext into a process-wide singleton
builder.Services.AddSingleton<IOrderService, OrderService>();

// Right: scoped matches DbContext lifetime
builder.Services.AddScoped<IOrderService, OrderService>();
```

Это решение не работает для hosted-сервисов, таймеров и фоновых очередей. Вокруг них нет области, поэтому перевод их в scoped ничего не даёт (хост всё равно разрешает их из корневого провайдера). Для таких случаев используйте решение два.

Когда вы меняете регистрацию с singleton на scoped, проверьте места вызова на ссылки, сохранённые в полях. Любой другой singleton, принимавший `IOrderService` в конструкторе, теперь сам провалит валидацию области, и цепочка размотается вверх, пока не дойдёт до сервиса, который укладывается в область запроса.

## Решение второе: внедрите IServiceScopeFactory и открывайте область на единицу работы

Когда потребитель **обязан** оставаться singleton, принимайте `IServiceScopeFactory` и создавайте новую область каждый раз, когда выполняете работу. Это канонический паттерн для `BackgroundService` и любого потребителя на уровне процесса:

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using var scope = scopeFactory.CreateScope();
            var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();

            Console.WriteLine(repo.GetName(1));

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

Три правила, чтобы применить этот паттерн правильно:

- **Одна область на единицу работы**, а не одна область на процесс. Весь смысл в том, что каждая итерация получает свежий `DbContext`, свежий трекер изменений, свежее соединение. Освобождение области в конце итерации высвобождает scoped-сервисы.
- **Разрешайте через `ServiceProvider` области**, а не через сохранённый корневой провайдер. `scope.ServiceProvider.GetRequiredService<T>()` корректно; `_rootProvider.GetRequiredService<T>()` --- исходный баг.
- **Не храните scoped-сервисы в полях** singleton. Инстанция, которую вы разрешили внутри области, не должна пережить область. Если её надо передать в другой метод, передайте параметром и дайте ей выйти из области вместе с `using`.

Для `IAsyncDisposable`-сервисов в .NET 11 (большинство современных конфигураций `DbContext`) предпочитайте асинхронную disposable-форму:

```csharp
// .NET 11 preview 4
await using var scope = scopeFactory.CreateAsyncScope();
var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();
```

`CreateAsyncScope` возвращает `AsyncServiceScope`, который освобождает scoped-сервисы через `DisposeAsync`, если те его реализуют. Для пуленых инстанций `DbContext` это важно: синхронное освобождение асинхронного ресурса в .NET 11 по умолчанию выбрасывает исключение.

## Решение третье: используйте IDbContextFactory именно для DbContext

EF Core поставляет типизированную фабрику ровно для этого сценария. Зарегистрируйте её вместо (или вместе с) scoped `DbContext`:

```csharp
// .NET 11 preview 4, Microsoft.EntityFrameworkCore 11.0.0-preview.4
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process pending...

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddDbContextFactory` регистрирует `IDbContextFactory<AppDbContext>` как **singleton**, а фабрика выдаёт свежие инстанции `DbContext` по требованию. Никакого несоответствия областей, никакого захваченного `DbContext`, никаких церемоний с областями в воркере. Это паттерн, который Microsoft рекомендует для Blazor Server, hosted-сервисов и любого кода, не привязанного к запросу, который общается с EF Core. Полное руководство --- в [документации фабрики DbContext](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).

Можно зарегистрировать одновременно `AddDbContext` и `AddDbContextFactory`, если у вас смешанные потребители --- одни привязаны к запросу, другие нет. Используйте `AddDbContextFactory<T>(..., ServiceLifetime.Scoped)`, чтобы сделать саму фабрику scoped, если нужен пулинг вместе со scoping, но проверьте, что времена жизни сходятся у потребителя.

## Решение четвёртое: ValidateOnBuild ловит это при старте, а не на первом запросе

После того как вы применили реальное решение из перечисленных выше, включите проверку во время сборки, чтобы следующий captive-баг падал быстро:

```csharp
// .NET 11 preview 4
builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateScopes = true;
    options.ValidateOnBuild = true;
});
```

`ValidateScopes = true` заставляет среду выполнения прогонять каждое разрешение через валидатор call site, даже в production. `ValidateOnBuild = true` делает это **один раз** в момент `host.Build()` для каждой регистрации в контейнере. Хост откажется стартовать, если какая-либо регистрация выбросит исключение при первом разрешении.

Цена --- одноразовый проход валидации при старте. Выгода --- следующий разработчик, внёсший captive-зависимость, увидит сбой во время локального старта или в CI, а не на production-трафике.

Чего **не** стоит делать, даже если результаты поиска подсказывают: отключать `ValidateScopes`, чтобы заглушить исключение. Отключение проверки не чинит баг. Оно его прячет. Scoped-сервис всё так же привязывается к жизненному циклу singleton; вам просто перестают об этом сообщать. Устаревшие данные, утечки соединений и `ObjectDisposedException` дальше по процессу гарантированы.

## Варианты, похожие на ту же ошибку, но решаемые иначе

Несколько сообщений об ошибках обладают семейным сходством и тратят время, если относиться к ним одинаково:

- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`**: отсутствует регистрация, а не несоответствие времени жизни. Другая причина --- другое решение. Разобрано в [статье про unable to resolve service](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- **`Cannot resolve scoped service 'X' from root provider`**: потребитель напрямую обратился к **корневому** `IServiceProvider` (`app.Services.GetRequiredService<X>()` для scoped `X`). Решение такое же, как для случая с singleton: сначала откройте область.
- **`A circular dependency was detected for the service of type 'X'`**: со временем жизни всё в порядке, но граф call site содержит цикл. Ищите сервис, который принимает себя самого или своего соседа в конструкторе.
- **`Cannot access a disposed object. Object name: 'AppDbContext'`**: захваченный scoped-сервис, который **уже** обошёл валидацию областей (потому что валидация была отключена или сервис был разрешён через невалидируемый путь) и теперь используется после освобождения исходной области. Решение --- открыть свежую область в месте вызова.

## Почему это бьёт по hosted-сервисам сильнее всего

`AddHostedService<T>` и `AddSingleton<IHostedService, T>` --- одна и та же регистрация: каждый hosted-сервис --- singleton. Хост разрешает их из корневого провайдера во время `StartAsync`. Если конструктор вашего hosted-сервиса принимает что-либо, что трогает базу данных, обращается к резолверу арендатора или оборачивает `HttpContext`, оно будет scoped, и валидатор выбросит исключение.

Та же ловушка существует для:

- **Потребителей `IHttpClientFactory`, разрешающих scoped delegating handlers из singleton.** Сам `IHttpClientFactory` --- singleton, но per-request handlers могут быть зарегистрированы как scoped. Разрешение именованного клиента из singleton запускает валидатор.
- **Резилентных пайплайнов Polly**, зарегистрированных как scoped (это значение по умолчанию в .NET 11) и потребляемых из singleton.
- **`IOptionsSnapshot<T>`**, который **scoped**. Singleton, зависящий от `IOptionsSnapshot<T>`, провалит валидацию. Используйте `IOptionsMonitor<T>` (singleton) вместо него. Изменение --- одна строчка в конструкторе.
- **MediatR / `ISender`, зарегистрированных как scoped.** `Mediator.Send` из hosted-сервиса должен выполняться внутри области.
- **Перехватчиков EF Core**, удерживающих захваченный `IServiceProvider`. Используйте перегрузки регистрации, дружественные к областям, а не захваченный корневой провайдер.

## Граничные случаи, которые стоит назвать

- **`IServiceProvider`, внедрённый в singleton**. Допустимо, но провайдер, который вы получаете, --- это **корневой** провайдер. Разрешение чего-либо scoped из него выбрасывает то же исключение. Если нужно разрешать scoped, запросите вместо него `IServiceScopeFactory` и вызывайте `CreateScope()`.
- **Фабрики `Func<T>`, зарегистрированные вручную**. Если `T` --- scoped, и фабрика захвачена singleton, при инспекции она выглядит нормально, но падает при первом вызове вне области. Замените ручную фабрику на `IServiceScopeFactory` плюс `GetRequiredService<T>()`.
- **Тестовые хосты, отключающие валидацию областей**. `WebApplicationFactory<T>` оставляет валидацию включённой по умолчанию начиная с .NET 8+. Если ваши тесты проходят, а production падает, проверьте, не добавили ли вы `ValidateScopes = false` в тестовый хост.
- **Сборки Native AOT и trimmed**. Валидация областей работает на том же стандартном контейнере, поэтому AOT не меняет это правило. Триммер может удалить тип, используемый только через рефлексию в захваченной фабрике; симптом там --- `Unable to resolve`, а не captive-исключение.
- **Generic hosted services**. `AddHostedService<MyHostedService<MyArg>>()` всё так же singleton. Валидатор инспектирует конструктор замкнутого generic, поэтому параметр конструктора `IRepo<MyArg>`, зарегистрированный как scoped, запускает тот же путь ошибки.

## Связанное

- Дополняющая ошибка регистрации к этой: [unable to resolve service for type while attempting to activate](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- Рабочий пример паттерна singleton-с-фабрикой-областей: [running a Semantic Kernel plugin from a BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- Следующее исключение EF Core, с которым вы столкнётесь, если `DbContext` случайно переживёт свою область: [a second operation was started on this context instance](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/).
- Подмены DI на время теста, не ломающие валидацию областей: [integration tests against a real SQL Server with Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Конфигурационный режим сбоя, часто соседствующий с багами времени жизни: [no connection string named 'DefaultConnection' could be found](/ru/2026/05/fix-no-connection-string-named-defaultconnection/).

## Источники

- Microsoft Learn, [Dependency injection guidelines: scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines#scope-validation).
- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection).
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor).
- Исходный код ASP.NET Core, [`CallSiteValidator.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/CallSiteValidator.cs), где срабатывает проверка captive-зависимости.
- Исходный код ASP.NET Core, [`ServiceProviderEngineScope.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs), где принудительно соблюдается различие корневого провайдера и области.
