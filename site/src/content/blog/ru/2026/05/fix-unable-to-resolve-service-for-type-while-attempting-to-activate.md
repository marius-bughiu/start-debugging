---
title: "Исправление: Unable to resolve service for type 'X' while attempting to activate 'Y'"
description: "ASP.NET Core выбрасывает это исключение, когда конструктор запрашивает тип, который никогда не был зарегистрирован, был зарегистрирован в другом контейнере или был добавлен после построения хоста. Три конкретных исправления покрывают почти все случаи."
pubDate: 2026-05-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "ru"
translationOf: "2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate"
translatedBy: "claude"
translationDate: 2026-05-10
---

Исправление: `ActivatorUtilities` из ASP.NET Core прошёлся по конструктору `Y`, запросил у `IServiceProvider` тип `X` и не получил ничего. Либо вы забыли вызвать `services.AddScoped<X, XImpl>()` (или `AddSingleton` / `AddTransient`), либо зарегистрировали реализацию, но запросили интерфейс или базовый класс, о которых контейнер не знает, либо регистрация живёт в другом `IServiceCollection`, чем тот, который хост на самом деле построил. Добавьте недостающую регистрацию в `Program.cs` до `builder.Build()` и дважды проверьте, что имена типов точно совпадают.

```text
System.InvalidOperationException: Unable to resolve service for type 'MyApp.Data.IUserRepository' while attempting to activate 'MyApp.Api.Controllers.UsersController'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.ConstructorMatcher.CreateInstance(IServiceProvider provider)
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.CreateInstance(IServiceProvider provider, Type instanceType, Object[] parameters)
   at Microsoft.AspNetCore.Mvc.Controllers.ServiceBasedControllerActivator.Create(ControllerContext context)
   at Microsoft.AspNetCore.Mvc.Controllers.ControllerActivatorProvider.<>c__DisplayClass4_0.<CreateActivator>b__0(ControllerContext controllerContext)
   at Microsoft.AspNetCore.Mvc.Infrastructure.ControllerActionInvoker.Next(State& next, Scope& scope, Object& state, Boolean& isCompleted)
```

Это руководство написано для .NET 11 preview 4, `Microsoft.AspNetCore.App` 11.0.0-preview.4 и `Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4. Текст исключения стабилен с ASP.NET Core 2.1, поэтому каждое исправление ниже чисто применяется вплоть до .NET Core 3.1, .NET 5, 6, 8 и 10.

Два имени типов в сообщении — самая полезная часть: **первое** имя (`X`) — это тип, который контейнер не смог найти, а **второе** имя (`Y`) — это потребитель, который его запросил. Прочитайте их именно в этом порядке, прежде чем что-либо делать, потому что поисковый запрос, который привёл вас сюда, в половине случаев совпадёт с неправильной половиной сообщения.

## Почему контейнер не смог найти тип

Три причины объясняют почти все случаи:

1. **Для этого типа вообще ничего не зарегистрировано.** Вы написали `public UsersController(IUserRepository repo)`, но никогда не вызывали `services.AddScoped<IUserRepository, UserRepository>()`. У контейнера нет сопоставления интерфейса с реализацией.
2. **Вы зарегистрировали неправильный ключ.** Вы вызвали `services.AddScoped<UserRepository>()` (конкретный тип), но контроллер запрашивает `IUserRepository` (интерфейс). Контейнер разрешает только то, что вы зарегистрировали, по точному типу, использованному как обобщённый параметр или аргумент `serviceType`.
3. **Вы зарегистрировали в другой `IServiceCollection`.** Часто встречается в тестах, где тестовый хост строит свою собственную коллекцию, или в необычных случаях, когда вы изменяете `builder.Services` после `builder.Build()`. Хост делает снимок коллекции в момент сборки.

Существует горстка менее распространённых вариантов, которые стоит назвать: открытый обобщённый тип, зарегистрированный без соответствующего закрытого типа (`AddScoped(typeof(IRepo<>), typeof(Repo<>))` нормально; `AddScoped<IRepo<User>>(...)` — это не та же регистрация), `keyed` сервис, запрошенный потребителем без ключа, и `Action` или фабричный делегат, переданный в конструктор, который внедрение зависимостей не может синтезировать. Сначала разберитесь с первыми тремя.

## Минимальное воспроизведение

Это самый маленький минимальный API на .NET 11, который выбрасывает исключение:

```csharp
// .NET 11 preview 4, Microsoft.AspNetCore.App 11.0.0-preview.4
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);

// Notice: no services.AddScoped<IUserRepository, UserRepository>();

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}
```

```csharp
// .NET 11 preview 4
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("users")]
public sealed class UsersController(IUserRepository repo) : ControllerBase
{
    [HttpGet("{id:int}")]
    public IActionResult Get(int id) => Ok(repo.GetName(id));
}
```

Сделайте `GET /users/1`, и запрос упадёт с исключением из раздела выше. Контейнер никогда не видел `IUserRepository`, поэтому когда `ServiceBasedControllerActivator` из MVC пытается построить контроллер, параметр конструктора нельзя удовлетворить.

## Исправление первое: зарегистрируйте недостающий сервис

Первое, что стоит попробовать, и ответ в 80% случаев:

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

Выберите время жизни, которое соответствует тому, как используется сервис:

- `AddScoped` — правильное значение по умолчанию для всего, что касается состояния на запрос (`DbContext` из EF Core, обёртка над `HttpContext` accessor, резолвер арендатора). Один экземпляр на область запроса.
- `AddSingleton` — для не имеющего состояния или потокобезопасного общего состояния (кеши, опции, HTTP-клиенты через `IHttpClientFactory`). Один экземпляр на процесс.
- `AddTransient` — для дешёвых, не имеющих состояния объектов, новую копию которых вы хотите каждый раз (`IValidator<T>`, мапперы). Новый экземпляр на разрешение.

Ошибётесь здесь — и сегодняшнее исключение поменяете на завтрашнее `InvalidOperationException: Cannot consume scoped service ... from singleton ...`, или хуже того, на тихую ошибку потоковой безопасности, когда два запроса делят один `DbContext`. Официальные рекомендации в [документации Microsoft.Extensions.DependencyInjection](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines) — это эталон; по умолчанию используйте `AddScoped` при сомнениях, если существует область запроса.

## Исправление второе: зарегистрируйте тип сервиса, который конструктор на самом деле запрашивает

Если регистрация есть, но исключение всё равно происходит — значит, зарегистрированный тип и потребляемый тип не совпадают. Сверьте конструктор с регистрацией:

```csharp
// Wrong: only the concrete type is registered
builder.Services.AddScoped<UserRepository>();

// Right: register both the interface and the implementation,
// or just the interface mapped to the implementation
builder.Services.AddScoped<IUserRepository, UserRepository>();
```

Контейнер не выполняет вывод интерфейсов. Если `UserRepository` реализует `IUserRepository`, регистрация только `UserRepository` не регистрирует `IUserRepository`. Если потребитель запрашивает интерфейс, регистрируйте интерфейс.

Если вам действительно нужны оба ("внедри `UserRepository` здесь, но `IUserRepository` там"), зарегистрируйте оба и перенаправьте интерфейс на конкретный класс:

```csharp
// .NET 11 preview 4
builder.Services.AddScoped<UserRepository>();
builder.Services.AddScoped<IUserRepository>(sp => sp.GetRequiredService<UserRepository>());
```

Этот шаблон важен для размещённых сервисов и шаблона опций, где потребители иногда запрашивают конкретный `MyOptions`, а иногда `IOptions<MyOptions>`.

## Исправление третье: регистрируйте до того, как хост будет построен

`builder.Build()` — это граница отсечения. Всё, что вы добавляете в `builder.Services` после этого момента, тихо отбрасывается для запущенного хоста:

```csharp
// .NET 11 preview 4
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

// Too late. The container was snapshotted in builder.Build().
builder.Services.AddScoped<IUserRepository, UserRepository>();

app.MapControllers();
app.Run();
```

Переставьте порядок так, чтобы каждая регистрация выполнялась до `Build`. Этот шаблон чаще всего кусается, когда рефакторинг переносит вызов `Add*` в метод, а метод вызывается не оттуда. Удобный шаблон — поместить каждый вызов `services.Add*` внутрь метода-расширения для `IServiceCollection` и вызывать его из одного места рядом с началом `Program.cs`:

```csharp
// .NET 11 preview 4
public static class DependencyInjectionExtensions
{
    public static IServiceCollection AddDataServices(this IServiceCollection services)
    {
        services.AddScoped<IUserRepository, UserRepository>();
        services.AddScoped<IOrderRepository, OrderRepository>();
        return services;
    }
}

// Program.cs
builder.Services.AddDataServices();
var app = builder.Build();
```

В интеграционных тестах против `WebApplicationFactory<TEntryPoint>` эквивалентное правило: `ConfigureTestServices` запускается до того, как тестовый хост будет построен. Если вы изменяете контейнер из тела тестового метода после `factory.CreateClient()`, вы изменяете отброшенную коллекцию.

## Варианты, которые выглядят как та же ошибка

Несколько похожих ошибок решаются по-разному и тратят время, если относиться к ним как к одному и тому же багу:

- **`Cannot consume scoped service '<X>' from singleton '<Y>'`**. Регистрация существует, но время жизни неправильное. Исправление — сделать `Y` scoped или взять `IServiceScopeFactory` / `IServiceProvider` в `Y` и создавать область по требованию. Рассмотрено в [проблеме захвата singleton-в-scoped](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- **`No service for type 'IOptions<MyOptions>' has been registered`**. Та же первопричина, другое сообщение: вы пропустили `services.Configure<MyOptions>(...)` или `services.AddOptions<MyOptions>().Bind(...)`. Добавление `Configure` бесплатно регистрирует `IOptions<MyOptions>`.
- **`Implementation type 'X' can't be converted to service type 'Y'`**. Вы написали `services.AddScoped(typeof(IFoo), typeof(Bar))`, и `Bar` не реализует `IFoo`. Компилятор не может это поймать, потому что оба аргумента — `Type`. Исправьте тип или используйте обобщённую перегрузку.
- **`A suitable constructor for type 'X' could not be located`**. Тип зарегистрирован, но внедрение зависимостей не может его построить: каждый параметр публичного конструктора должен быть разрешим, и должен быть ровно один конструктор (или `[ActivatorUtilitiesConstructor]` на выбранном). Это не ошибка `Unable to resolve service`.
- **Keyed services**: в .NET 8 и более поздних версиях `AddKeyedScoped<IFoo, Foo>("primary")` требует `[FromKeyedServices("primary")] IFoo foo` у потребителя. Запрос обычного `IFoo` выбросит исключение разрешения сервиса, даже если keyed-регистрация существует. Эти два пространства имён разделены.

## Как подтвердить, что регистрация подключена правильно

Три быстрые проверки превосходят любое количество догадок:

1. **`IServiceProvider.GetService<T>()` из консоли разработки.** Поместите однострочник сразу после `app.Build()` и до `app.Run()`:

   ```csharp
   // .NET 11 preview 4 - remove before commit
   using (var scope = app.Services.CreateScope())
   {
       var repo = scope.ServiceProvider.GetService<IUserRepository>();
       Console.WriteLine(repo is null ? "NOT REGISTERED" : repo.GetType().FullName);
   }
   ```

   Если `GetService<T>()` возвращает `null`, регистрация отсутствует или scoped к другому контейнеру. `GetRequiredService<T>()` бросит то же `InvalidOperationException`, которое вы отлаживаете.

2. **Проверяйте области при старте.** Передайте `ValidateScopes = true` и `ValidateOnBuild = true` фабрике провайдера сервисов, и хост откажется запускаться, если хоть одна регистрация сломана:

   ```csharp
   // .NET 11 preview 4
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

   `ValidateOnBuild` проходит каждую регистрацию один раз во время сборки и быстро падает, если параметр конструктора нельзя удовлетворить. В среде разработки ASP.NET Core включает это для вас, поэтому исключение часто появляется в момент запуска приложения, а не в момент попадания на endpoint.

3. **Распечатайте регистрации.** Когда регистрация выглядит правильно, но исключение всё равно срабатывает, дампите саму коллекцию до `Build`:

   ```csharp
   // .NET 11 preview 4
   foreach (var sd in builder.Services.Where(s => s.ServiceType.Name.Contains("UserRepository")))
   {
       Console.WriteLine($"{sd.Lifetime}: {sd.ServiceType.FullName} -> {sd.ImplementationType?.FullName ?? "factory"}");
   }
   ```

   Это ловит случай, когда вы зарегистрировали `MyApp.OldNamespace.IUserRepository`, а контроллер импортирует `MyApp.NewNamespace.IUserRepository`. Сообщение исключения показывает полное пространство имён, но глаз скользит мимо.

## Крайние случаи, которые ловят опытных разработчиков

Несколько шаблонов запускают это исключение в коде, который при осмотре выглядит правильно:

- **`IConfiguration`, внедрённый в callback `Configure<TOptions>`**. Callback запускается лениво. Если вы ссылаетесь на сервис внутри callback, который позже удалён, исключение срабатывает в первый раз, когда опции разрешаются, а не при старте.
- **Фоновые сервисы, которые разрешают scoped-зависимости в своём конструкторе**. `BackgroundService` — это singleton. Его конструктор не может запросить `IUserRepository`, если последний scoped. Внедрите `IServiceScopeFactory`, создайте область внутри `ExecuteAsync` и разрешайте из области.
- **Обобщённые размещённые сервисы**. `services.AddHostedService<MyHostedService<MyArg>>()` требует, чтобы закрытый обобщённый `MyHostedService<MyArg>` был конструируем через DI, что означает, что `MyArg` тоже должен быть разрешим. Открытым обобщённым нужен `services.AddTransient(typeof(IRepo<>), typeof(Repo<>))`.
- **Контейнеры DI, сгенерированные исходным кодом**. Strawberry Shake, Refit и генераторы исходного кода gRPC иногда регистрируют своих собственных клиентов через `IServiceCollection`. Если вы вызываете их `Add*` расширение после `Build`, применяется то же правило тихого отбрасывания.
- **Сборки Native AOT**. Дружественный к trimming контейнер по умолчанию в .NET 11 всё ещё разрешает через рефлексию по умолчанию. Если вы публикуете с `<PublishTrimmed>true</PublishTrimmed>`, и trimmer удаляет тип реализации, вы увидите исключение разрешения сервиса во время выполнения, хотя исходный код компилируется нормально. Исправление — `[DynamicDependency]` или регистрация типа через типизированную фабрику.

## Связанное

- Чисто связать журналирование и DI вместе: [структурированное журналирование с Serilog и Seq в .NET 11](/ru/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).
- Следующее исключение, с которым вы столкнётесь после этого, если выберете неправильное время жизни: [singleton, потребляющий scoped DbContext](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/).
- Связанное неправильное использование EF Core, которое всплывает, когда DI передаёт один и тот же `DbContext` двум запросам: [a second operation was started on this context instance](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/).
- Подмены DI во время теста, которые обходят это исключение, регистрируя fake: [пуловая фабрика DbContext в тестах EF Core 11](/ru/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).
- Для связанного режима отказа `IConfiguration`: [no connection string named 'DefaultConnection' could be found](/ru/2026/05/fix-no-connection-string-named-defaultconnection/).

## Источники

- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection).
- Microsoft Learn, [Dependency injection guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines).
- Microsoft Learn, [Keyed services in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#keyed-services).
- Microsoft Learn, [Use scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-usage#scope-validation).
- Исходный код ASP.NET Core, [`ActivatorUtilities.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection.Abstractions/src/ActivatorUtilities.cs), где выбрасывается исключение.
