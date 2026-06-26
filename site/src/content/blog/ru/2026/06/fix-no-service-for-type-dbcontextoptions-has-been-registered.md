---
title: "Исправление: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered"
description: "EF Core выбрасывает это, когда AddDbContext не вызывался, вызван после Build или конструктор контекста принимает не тот DbContextOptions. Регистрируйте до Build и используйте DbContextOptions<ВашКонтекст>."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "dependency-injection"
lang: "ru"
translationOf: "2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered"
translatedBy: "claude"
translationDate: 2026-06-26
---

Исправление: у контейнера внедрения зависимостей запросили `DbContextOptions` во время сборки вашего `DbContext`, а отдать ему было нечего. Почти всегда это значит, что `AddDbContext<ВашКонтекст>(...)` не вызывался, был вызван после `builder.Build()`, находится в методе `ConfigureServices`, который больше не выполняется, либо конструктор вашего контекста объявляет параметр, который контейнер не регистрирует. Добавьте `builder.Services.AddDbContext<ВашКонтекст>(...)` до `Build()` и задайте конструктору параметр `DbContextOptions<ВашКонтекст>`, а не неуниверсальный `DbContextOptions`.

```text
System.InvalidOperationException: No service for type 'Microsoft.EntityFrameworkCore.DbContextOptions' has been registered.
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

Ту же первопричину можно увидеть и через путь активации, в универсальной форме имени типа с обратной кавычкой:

```text
System.InvalidOperationException: Unable to resolve service for type 'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to activate 'MyApp.Data.AppDbContext'.
   at Microsoft.Extensions.DependencyInjection.ActivatorUtilities.GetService(...)
```

Это руководство написано для .NET 11, EF Core 11.0.0 (`Microsoft.EntityFrameworkCore` 11.0.0) и `Microsoft.Extensions.DependencyInjection` 11.0.0. Описанное здесь поведение стабильно начиная с EF Core 3.0, поэтому решения одинаково применимы к EF Core 6, 8 и 10.

## Две формы сообщения это одна и та же ошибка

Контейнер .NET выдаёт две разные фразы для одного и того же базового сбоя, и какую из них вы получите, зависит от того, как началось разрешение:

- `No service for type 'X' has been registered.` приходит из `GetRequiredService<X>()`. Что-то запросило `X` у провайдера напрямую, а `X` не было в коллекции.
- `Unable to resolve service for type 'X' while attempting to activate 'Y'.` приходит из `ActivatorUtilities`. Контейнер собирал `Y`, наткнулся на параметр конструктора типа `X` и не смог его удовлетворить.

В обоих случаях здесь `X` это `DbContextOptions` (или его универсальная форма `DbContextOptions<AppDbContext>`, которую среда выполнения печатает как ``DbContextOptions`1[AppDbContext]``). `Y`, если оно есть, это ваш контекст. Прочитайте имена типов, прежде чем что-то менять: ошибка про объект параметров, который нужен EF Core для настройки контекста, а не про сам контекст.

## Что на самом деле регистрирует AddDbContext

Чтобы понять исправление, нужно понять, что `AddDbContext<TContext>` помещает в контейнер. Внутри он регистрирует две вещи для параметров (`Microsoft.EntityFrameworkCore.EntityFrameworkServiceCollectionExtensions`, метод `AddCoreServices`):

```csharp
// EF Core 11.0.0 - paraphrased from AddCoreServices
serviceCollection.TryAdd(
    new ServiceDescriptor(
        typeof(DbContextOptions<TContextImplementation>),
        CreateDbContextOptions<TContextImplementation>,
        optionsLifetime));

serviceCollection.Add(
    new ServiceDescriptor(
        typeof(DbContextOptions),
        p => p.GetRequiredService<DbContextOptions<TContextImplementation>>(),
        optionsLifetime));
```

Отсюда вытекают два факта, объясняющие каждую разновидность ошибки:

1. Универсальный `DbContextOptions<TContext>` это настоящая регистрация. Он добавляется через `TryAdd`, поэтому для этого закрытого типа побеждает первый вызов.
2. Неуниверсальный `DbContextOptions` это переадресатор, добавляемый через `Add` (безусловно). Под капотом он просто вызывает `GetRequiredService<DbContextOptions<TContext>>()`. Поскольку это `Add`, а не `TryAdd`, каждый вызов `AddDbContext` добавляет ещё один переадресатор, и при разрешении неуниверсального `DbContextOptions` **побеждает зарегистрированный последним**.

Так что если вы никогда не вызываете `AddDbContext`, ни одной из регистраций не существует, и запрос любой из форм выбрасывает исключение. А если вы регистрируете два контекста, но один из них принимает неуниверсальный `DbContextOptions`, этот контекст незаметно получает параметры другого контекста. Оба случая разобраны ниже.

## Минимальное воспроизведение

Наименьшая программа на .NET 11, выбрасывающая ошибку из-за полного отсутствия регистрации:

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.AspNetCore.App 11.0.0
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

// No builder.Services.AddDbContext<AppDbContext>(...) here.
builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();

public sealed class AppDbContext : DbContext
{
    public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
    public DbSet<Product> Products => Set<Product>();
}

public sealed class Product
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

[ApiController]
[Route("products")]
public sealed class ProductsController(AppDbContext db) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(db.Products.Count());
}
```

Обратитесь к `GET /products`, и MVC попросит контейнер активировать `ProductsController`, которому нужен `AppDbContext`, которому нужен `DbContextOptions<AppDbContext>`. Его никто не зарегистрировал, поэтому вы получаете форму активации ошибки. Это в точности то, с чем вы сталкиваетесь сразу после скаффолдинга контроллера в Visual Studio для контекста, который вы ещё не подключили в `Program.cs`.

## Решение один: зарегистрируйте контекст до сборки хоста

Ответ в подавляющем большинстве случаев. Добавьте регистрацию в `Program.cs` и убедитесь, что она выполняется до `builder.Build()`:

```csharp
// .NET 11, EF Core 11.0.0
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? throw new InvalidOperationException("Connection string 'DefaultConnection' not found.");

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseSqlServer(connectionString));

var app = builder.Build();
```

`builder.Build()` делает снимок коллекции сервисов. Всё, что вы добавите в `builder.Services` после этой строки, работающий хост молча игнорирует, так что это неверно:

```csharp
// .NET 11 - bug: registration after Build is discarded
var app = builder.Build();
builder.Services.AddDbContext<AppDbContext>(options => options.UseSqlServer(cs)); // too late
app.Run();
```

Если вы на более старой модели `Startup`, регистрация принадлежит `ConfigureServices`, и классическая версия этой ошибки это вторая перегрузка `ConfigureServices` или закомментированная строка `services.AddDbContext`, которую кто-то отключил при отладке и не восстановил. Найдите `AddDbContext` по всему проекту и убедитесь, что найденный вызов действительно находится на пути кода, который выполняет хост.

Если вы собираете `DbContext` вне конвейера запросов, то же правило действует внутри любого собранного вами провайдера. Разрешение контекста с областью видимости (scoped) `DbContext` из корневого провайдера или до `app.Run()` без создания области завершается ошибкой по той же причине:

```csharp
// .NET 11 - resolve a scoped DbContext correctly outside a request
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await db.Database.MigrateAsync();
}
```

## Решение два: задайте конструктору DbContextOptions<ВашКонтекст>

Если регистрация присутствует, а ошибка всё равно возникает, посмотрите на конструктор. Регистрация DI в EF Core создаёт `DbContextOptions<AppDbContext>`, поэтому именно этот параметр конструктор и должен объявлять:

```csharp
// Right: generic, tied to this specific context type
public AppDbContext(DbContextOptions<AppDbContext> options) : base(options) { }
```

Неуниверсальная версия компилируется и при единственном зарегистрированном контексте даже работает, потому что описанный выше переадресатор её разрешает. Но она хрупкая:

```csharp
// Risky: non-generic. Works with one context, breaks with two.
public AppDbContext(DbContextOptions options) : base(options) { }
```

Как только регистрируется второй контекст, оба вызова `AddDbContext` добавляют неуниверсальный переадресатор `DbContextOptions`, побеждает последний, и ваш контекст получает не те параметры, обычно не ту строку подключения или даже не того поставщика базы данных. Сбой может проявиться как ошибка `No service` при частичной регистрации или, что хуже, как контекст, незаметно обращающийся не к той базе данных. Документация Microsoft высказывается об этом прямо:

> Большинство подклассов `DbContext`, принимающих `DbContextOptions`, должны использовать универсальный вариант `DbContextOptions<TContext>`. Это гарантирует, что из внедрения зависимостей разрешаются правильные параметры для конкретного подтипа `DbContext`, даже когда зарегистрировано несколько подтипов `DbContext`.

У неуниверсальной формы есть одно законное применение: базовый класс, предназначенный для наследования. База принимает неуниверсальный `DbContextOptions`, чтобы каждый конкретный подкласс мог передать свой собственный `DbContextOptions<TConcrete>`:

```csharp
// .NET 11, EF Core 11.0.0 - base class shared by several contexts
public abstract class AppDbContextBase : DbContext
{
    protected AppDbContextBase(DbContextOptions options) : base(options) { }
}

public sealed class CatalogDbContext : AppDbContextBase
{
    public CatalogDbContext(DbContextOptions<CatalogDbContext> options) : base(options) { }
}

public sealed class OrdersDbContext : AppDbContextBase
{
    public OrdersDbContext(DbContextOptions<OrdersDbContext> options) : base(options) { }
}
```

Каждый конкретный контекст по-прежнему предоставляет универсальный конструктор, поэтому DI передаёт ему правильные параметры; база лишь даёт конструктор, к которому подключаются подклассы. Контекст, который нужно и создавать напрямую, и наследовать, должен предоставлять оба конструктора: универсальный public и неуниверсальный protected.

## Решение три: инструменты времени разработки (миграции и скаффолдинг)

Отдельная разновидность этой ошибки возникает только при запуске `dotnet ef`:

```text
Unable to create a 'DbContext' of type ''. The exception 'Unable to resolve service for type
'Microsoft.EntityFrameworkCore.DbContextOptions`1[MyApp.Data.AppDbContext]' while attempting to
activate 'MyApp.Data.AppDbContext'.' was thrown while attempting to create an instance.
```

Во время разработки работающего веб-хоста нет, поэтому EF Core не может извлечь параметры из DI-контейнера вашего приложения. Он всё равно пытается собрать контекст и спотыкается на параметре опций. Два надёжных решения:

1. Дайте EF найти хост вашего приложения. Если ваш `DbContext` находится в стартовом проекте и `Program.cs` вызывает `AddDbContext`, инструменты EF могут использовать поставщик сервисов приложения. Держите проект времени разработки и времени выполнения одним и тем же или передайте `--startup-project`.
2. Предоставьте явную фабрику. Реализуйте `IDesignTimeDbContextFactory<TContext>` рядом с контекстом. EF обнаруживает её автоматически и использует вместо угадывания:

```csharp
// .NET 11, EF Core 11.0.0 - found automatically by dotnet ef
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class AppDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=DesignTime;ConnectRetryCount=0")
            .Options;

        return new AppDbContext(options);
    }
}
```

Фабрика собирает `DbContextOptions<AppDbContext>` вручную, поэтому команды времени разработки никогда не касаются DI вашего приложения. Это каноническое решение, когда контекст находится в библиотеке классов без собственного стартового хоста. О более широкой версии этого сбоя см. отдельный разбор о том, [почему `dotnet ef migrations add` сообщает "Unable to create an object of type DbContext"](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Создание контекста вручную

Если вы вообще не используете DI, неуниверсальная регистрация `DbContextOptions` не важна. Соберите параметры сами и передайте их в конструктор:

```csharp
// .NET 11, EF Core 11.0.0 - no DI container involved
var options = new DbContextOptionsBuilder<AppDbContext>()
    .UseSqlServer(connectionString)
    .Options;

using var db = new AppDbContext(options);
```

Это правильная форма для консольного инструмента, теста или фоновой утилиты, у которой нет `IServiceProvider`. Обратите внимание, что построитель тоже универсальный: `DbContextOptionsBuilder<AppDbContext>` создаёт `DbContextOptions<AppDbContext>`, который соответствует универсальному конструктору.

## Похожие случаи, которые попадают на эту страницу по ошибке

Несколько похожих случаев ищутся одинаково, но решаются по-разному:

- **`No connection string named 'DefaultConnection' could be found`.** Контекст зарегистрирован нормально; не удался поиск строки подключения. Другой уровень, другое решение. См. [ошибку строки подключения DefaultConnection](/ru/2026/05/fix-no-connection-string-named-defaultconnection/).
- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`, где X это ваш собственный сервис, а не `DbContextOptions`.** Это простая отсутствующая регистрация в вашем коде, а не проблема подключения EF Core. См. [общую ошибку разрешения сервиса](/ru/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/).
- **`Cannot consume scoped service 'AppDbContext' from singleton 'Y'`.** Контекст зарегистрирован правильно; его захватывает singleton. Решение это область видимости, а не регистрация.
- **`A second operation was started on this context instance`.** Контекст разрешился нормально, но используется из нескольких потоков или неправильно ожидается (await).
- **`AddDbContextPool` и `AddDbContextFactory`.** Оба регистрируют `DbContextOptions<TContext>` так же, как `AddDbContext`, поэтому правило конструктора идентично: контексты из пула и созданные фабрикой тоже требуют универсального параметра `DbContextOptions<TContext>`. Если вы подменяете контекст в тестах через фабрику из пула, см. [удаление фабрики DbContext из пула для подмены в тестах в EF Core 11](/ru/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/).

## Проверка подключения за десять секунд

Когда регистрация выглядит правильной, но ошибка не уходит, докажите это из области видимости, а не гадайте:

```csharp
// .NET 11 - remove before commit
using (var scope = app.Services.CreateScope())
{
    var options = scope.ServiceProvider.GetService<DbContextOptions<AppDbContext>>();
    Console.WriteLine(options is null ? "OPTIONS NOT REGISTERED" : "options OK");

    var ctx = scope.ServiceProvider.GetService<AppDbContext>();
    Console.WriteLine(ctx is null ? "CONTEXT NOT REGISTERED" : ctx.GetType().FullName);
}
```

Если строка опций печатает `OPTIONS NOT REGISTERED`, значит `AddDbContext` никогда не выполнялся на этом провайдере, и вы в Решении один. Если опции разрешаются, а контекст нет, то параметр конструктора неверный, и вы в Решении два. Можно также включить проверку во время сборки, чтобы хост отказывался запускаться со сломанным графом вместо сбоя на первом запросе:

```csharp
// .NET 11
builder.Host.UseDefaultServiceProvider(o =>
{
    o.ValidateScopes = true;
    o.ValidateOnBuild = true;
});
```

`ValidateOnBuild` один раз обходит каждую регистрацию и падает рано, превращая 500 во время выполнения в ошибку запуска, которую невозможно пропустить. Сочетайте универсальный конструктор с `AddDbContext` до `Build`, и ошибка `DbContextOptions` больше не вернётся. О шаблонах за модульными тестами, которые собирают контексты вообще без DI, сопутствующий материал о [мокировании DbContext без поломки отслеживания изменений](/ru/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) разбирает компромиссы.

## Источники

- Microsoft Learn, [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), включая раздел `DbContextOptions` versus `DbContextOptions<TContext>`.
- Microsoft Learn, [Design-time DbContext Creation](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation) и `IDesignTimeDbContextFactory<TContext>`.
- Исходный код EF Core, [`EntityFrameworkServiceCollectionExtensions.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore/Extensions/EntityFrameworkServiceCollectionExtensions.cs), где `AddCoreServices` регистрирует универсальные и неуниверсальные опции.
- Issue dotnet/efcore [#32936](https://github.com/dotnet/efcore/issues/32936) про ошибку активации во время разработки и решение с фабрикой.
