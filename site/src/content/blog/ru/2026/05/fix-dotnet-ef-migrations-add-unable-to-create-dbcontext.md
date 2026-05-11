---
title: "Fix: dotnet ef migrations add падает с 'Unable to create an object of type DbContext'"
description: "Инструменты EF Core времени проектирования не смогли создать экземпляр вашего DbContext. Предоставьте host через WebApplication.CreateBuilder, укажите правильный startup project или реализуйте IDesignTimeDbContextFactory."
pubDate: 2026-05-11
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
lang: "ru"
translationOf: "2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext"
translatedBy: "claude"
translationDate: 2026-05-11
---

Решение: `dotnet ef` запускает ваше приложение во время проектирования, чтобы обнаружить `DbContext`. Он не смог этого сделать, потому что точка входа не вернула host, который инструмент мог бы проинспектировать, или у вашего `DbContext` есть параметры конструктора, которые без host разрешить нельзя. В веб-приложении убедитесь, что `Program.cs` собирает и использует (или возвращает) `WebApplication`. В библиотеке классов или тестовом проекте добавьте реализацию `IDesignTimeDbContextFactory<TContext>`. Затем запустите снова с `--startup-project`, указывающим на host-проект, а не на проект данных.

```text
Unable to create an object of type 'AppDbContext'. For the different patterns supported at design time, see https://go.microsoft.com/fwlink/?linkid=851728
```

Это руководство написано для `Microsoft.EntityFrameworkCore.Design` 11.0.0-preview.4, `dotnet-ef` 11.0.0-preview.4 и SDK .NET 11 preview 4. То же поведение действует вплоть до EF Core 3.1: правила обнаружения во время проектирования не меняли форму с момента введения generic host. Если вы всё ещё на EF Core 6 или 8, все решения ниже работают, отличаются только пространства имён.

## Как инструменты времени проектирования находят ваш DbContext

Когда вы запускаете `dotnet ef migrations add Init`, инструмент не сканирует ваш код статически. Он собирает ваш проект, загружает получившуюся сборку и ищет одну из четырёх вещей, в таком порядке:

1. Реализацию `IDesignTimeDbContextFactory<TContext>` в startup project.
2. Host, возвращаемый из `Program.Main` или предоставленный через неявный шаблон билдера `WebApplication`. Инструмент вызывает на нём `IHost.Services.GetRequiredService<TContext>()`.
3. `DbContext` с публичным конструктором без параметров. Инструмент вызывает `new TContext()` напрямую.
4. `DbContext` с `OnConfiguring`, который не зависит от внедряемых сервисов.

Если ни один из путей не даёт экземпляр, вы получаете ошибку `Unable to create an object of type 'X'`. Гиперссылка в сообщении ведёт на документацию по design-time, где перечислены те же четыре пути.

## Почему это происходит в типичном веб-приложении

Большинство проектов спотыкается на пути 2. Инструмент может вызвать ваш `Program.cs`, но не находит host для инспекции. В 2026 году путь 2 чаще всего ломают три вещи:

1. `Program.cs` собирает `WebApplication`, но завершается до того, как инструмент успевает прочитать `Services`, из-за порядка top-level statements.
2. `DbContext` зарегистрирован в сборке, отличной от той, что передана как `--startup-project`. Инструмент запустил не тот проект.
3. Конструктор `DbContext` принимает пользовательский тип (резолвер арендатора, часы, сервис feature flag), который контейнер внедрения зависимостей не может разрешить без фактического выполнения `app.Run()`.

Первый -- тихий убийца. С top-level statements компилятор синтезирует `Program.Main`, чей тип возврата и последняя инструкция важны для EF Core. Если `app.Run()` -- последнее выражение, инструмент читает host через рефлексию по синтетическому классу `Program`. Если вы обернули вызов run в условный оператор или делаете ранний `return`, host никогда не достигает инструмента.

## Минимальное воспроизведение

Это наименьший проект, который воспроизводит ошибку. Один проект `WebApi`, один `DbContext` с внедрённой зависимостью, без design-time factory.

```csharp
// AppDbContext.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

public sealed class AppDbContext : DbContext
{
    private readonly ITenantResolver _tenant;

    public AppDbContext(DbContextOptions<AppDbContext> options, ITenantResolver tenant)
        : base(options)
    {
        _tenant = tenant;
    }

    public DbSet<Order> Orders => Set<Order>();
}

public interface ITenantResolver { string Current { get; } }
public sealed class Order { public int Id { get; set; } public string TenantId { get; set; } = ""; }
```

```csharp
// Program.cs - .NET 11
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

if (args.Contains("--migrate-only"))
{
    return; // <-- design-time tool reads this path, never reaches app.Run()
}

app.Run();
```

Запуск `dotnet ef migrations add Init` против этого проекта выводит ошибку. Регистрация `ITenantResolver` происходит только после `builder.Build()`, но ранний `return` обрывает синтезированный `Main`, и инспекция host у EF Core видит частично инициализированное состояние. Код обнаружения также пробует `new AppDbContext()`, что не получается, потому что конструктор требует двух аргументов.

## Решение 1 -- сделайте host обнаружимым (рекомендуется для веб-приложений)

Самое чистое решение -- позволить `Program.cs` закончить инициализацию host без условных ранних возвратов. Design-time host factory EF Core использует `HostFactoryResolver`, чтобы пройти по скомпилированному `Program.Main` и получить ссылку на `IHost`. Всё, что мешает этому проходу, мешает и EF Core найти контекст.

```csharp
// Program.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddScoped<ITenantResolver, HttpHeaderTenantResolver>();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

var app = builder.Build();

app.MapGet("/", () => "ok");

app.Run();
```

Одного такого изменения обычно достаточно. Подтвердите флагом `--verbose`:

```bash
dotnet ef migrations add Init --verbose
```

Вы должны увидеть строки вроде `Finding design-time services...`, `Using application service provider from Microsoft.Extensions.Hosting.IHostBuilder.` и `Using DbContext factory 'AppDbContext'.` Если `--verbose` сообщает `No host builder was found`, путь 2 всё ещё сломан, и вам нужно решение 2 или решение 3.

Если вам действительно нужен переключатель `--migrate-only` (консольный раннер, который завершается до `app.Run()` в production), поместите его после построения host, но **верните host** вместо void, чтобы синтезированный `Main` по-прежнему заканчивался ссылкой на host:

```csharp
// Program.cs - .NET 11
var app = builder.Build();
app.MapGet("/", () => "ok");

if (args.Contains("--migrate-only"))
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}

app.Run();
```

Инструмент времени проектирования по-прежнему видит `app.Run()` как терминальную инструкцию и может проинспектировать `app.Services` до его вызова.

## Решение 2 -- укажите правильный startup project

Решение с проектом `Web`, который ссылается на библиотеку классов `Data`, -- вторая по частоте причина. Люди запускают `dotnet ef migrations add Init` изнутри `Data/`, где живёт `DbContext`, ожидая, что инструмент использует host, зарегистрированный в `Web`. Этого не будет. Инструмент собирает **текущий** проект (или тот, что указан в `--project`) и ищет host внутри **той самой** сборки.

```bash
# Run from the solution root, EF Core 11.0.0-preview.4 / .NET 11
dotnet ef migrations add Init \
  --project src/Data/Data.csproj \
  --startup-project src/Web/Web.csproj
```

`--project` -- куда записываются файлы миграции. `--startup-project` -- где живёт host. Оба флага обязательны, когда это не один и тот же проект. Многие команды делают для этого alias в `Directory.Build.props` или в `Makefile`, чтобы длинный вызов никогда не приходилось набирать.

Вы можете проверить, какую сборку инструмент действительно загрузил, командой `dotnet ef dbcontext info --startup-project src/Web/Web.csproj`. Она печатает разрешённое имя типа, провайдера и источник строки подключения. Если `info` работает, а `migrations add` падает, у вас проблема с конструктором, а не с обнаружением: переходите к решению 3.

## Решение 3 -- реализуйте IDesignTimeDbContextFactory

Для библиотек классов без host (типичная компоновка для упакованного слоя данных, тестового проекта или общего hosted-проекта Blazor WebAssembly) `Program.Main` для инспекции просто нет. Добавьте factory в тот же проект, где `DbContext`:

```csharp
// DesignTimeDbContextFactory.cs - .NET 11, EF Core 11.0.0-preview.4
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<AppDbContext>()
            .UseSqlServer("Server=(localdb)\\MSSQLLocalDB;Database=design-time;Trusted_Connection=True;TrustServerCertificate=True")
            .Options;

        return new AppDbContext(options, new DesignTimeTenantResolver());
    }

    private sealed class DesignTimeTenantResolver : ITenantResolver
    {
        public string Current => "design-time";
    }
}
```

Обнаружение EF Core проверяет наличие `IDesignTimeDbContextFactory<TContext>` **до** того, как обходит host, поэтому эта реализация также переопределяет всё остальное. Это делает её самым надёжным решением, но у неё есть цена: строка подключения дублируется. Читайте её из `appsettings.json`, если хотите этого избежать:

```csharp
// EF Core 11.0.0-preview.4 - read connection string from config
public AppDbContext CreateDbContext(string[] args)
{
    var config = new ConfigurationBuilder()
        .SetBasePath(Directory.GetCurrentDirectory())
        .AddJsonFile("appsettings.json", optional: false)
        .AddJsonFile($"appsettings.{Environment.GetEnvironmentVariable("DOTNET_ENVIRONMENT") ?? "Development"}.json", optional: true)
        .AddEnvironmentVariables()
        .Build();

    var options = new DbContextOptionsBuilder<AppDbContext>()
        .UseSqlServer(config.GetConnectionString("Default"))
        .Options;

    return new AppDbContext(options, new DesignTimeTenantResolver());
}
```

Напоминание о копировании файлов: `appsettings.json` должен быть установлен в `Copy if newer` в проекте, который запускает инструмент, иначе рабочий каталог его не будет содержать. Если вы прошли ошибку обнаружения и упёрлись в `null` строку подключения, это та же ловушка, разобранная в каноническом материале о [ошибке No connection string named DefaultConnection](/ru/2026/05/fix-no-connection-string-named-defaultconnection/).

## Решение 4 -- ловушка контракта args

Если у вас уже есть design-time factory, а ошибку в CI вы всё ещё видите, проверьте параметр `args`. Инструмент EF Core передаёт собственный список аргументов в `CreateDbContext(string[] args)`. Код, путающий их с `args` приложения и отвергающий неизвестные флаги, выбросит исключение до того, как контекст будет возвращён. Затем инструмент сообщает об этом броске как о провале обнаружения:

```csharp
// Wrong - throws on EF Core's own args
public AppDbContext CreateDbContext(string[] args)
{
    if (args.Length != 2) throw new ArgumentException("expected env and db");
    ...
}
```

Либо уберите валидацию, либо примите, что design-time `args` непрозрачны, и опирайтесь вместо них на `Environment.GetEnvironmentVariable`.

## Ошибки, похожие на эту, но другие

- **`Could not load file or assembly 'Microsoft.EntityFrameworkCore.Design'`**. Вы забыли добавить пакет `Microsoft.EntityFrameworkCore.Design` в startup project. Он должен быть подключён именно там, даже если `DbContext` живёт в другом месте, потому что инструмент загружает его из bin-папки стартовой сборки.
- **`No project was found`**. Вы запустили `dotnet ef` из папки без `.csproj`. Запускайте из корня проекта или передавайте `--project`.
- **`The command 'dotnet-ef' could not be found`**. Отсутствует локальный манифест инструментов. Выполните `dotnet new tool-manifest` и `dotnet tool install dotnet-ef --version 11.0.0-preview.4`. Фиксация версии важна: глобальный `dotnet-ef`, поставленный годы назад, тихо разъедется со средой выполнения.
- **`Cannot consume scoped service from singleton`**. Обнаружение сработало, но регистрация внедрения зависимостей неверна. Это другая ошибка, и её разбирает [решение по lifetime scoped vs singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- **`A second operation was started on this context instance`**. Тоже другая ошибка, но пользователи EF Core находят её через ту же поисковую кроличью нору. [Статья о конкурентности DbContext](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/) проходит по ней шаг за шагом.

## Контрольный список отладки, если ни одно из решений не помогло

Если вы попробовали все четыре, а инструмент по-прежнему не находит ваш контекст, пройдите этот контрольный список по порядку. Это тот же список, который рекомендует triage-метка "design-time" команды EF Core на GitHub.

1. `dotnet build` проходит без предупреждений о недостающих сборках. Инструмент работает против вашего build output, зелёная сборка -- обязательное условие.
2. `dotnet ef dbcontext list --startup-project src/Web/Web.csproj` печатает имя вашего контекста. Если и это падает, сборка ни разу не загрузила контекст. Скорее всего, отсутствует `AddDbContext`.
3. `dotnet ef dbcontext info` печатает провайдера и строку подключения. Если это успешно, а `migrations add` падает, конструктор вашего `DbContext` бросает исключение при фактическом вызове. Добавьте журналирование.
4. `TargetFramework` startup project совпадает со средой выполнения инструмента `dotnet-ef`. Инструменты EF Core 11 нацелены на .NET 11. Они не могут инспектировать проект, нацеленный только на `netstandard2.0`.
5. В startup project подключены и `Microsoft.EntityFrameworkCore.Design`, и пакет провайдера (`Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.EntityFrameworkCore.PostgreSQL` и т. д.).
6. `Program.cs` -- точка входа. Если у вас несколько методов `Main` или вы используете настройки `OutputType`, скрывающие её, обнаружение проваливается.

Как только `dotnet ef dbcontext info` работает от начала до конца, все остальные команды тоже будут работать. Это лучший smoke-тест и он быстрее, чем запускать настоящую миграцию.

## Связанные материалы

- [Однашаговый рабочий процесс миграций в EF Core 11](/ru/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) рассказывает про `dotnet ef migrations update --add` -- новый объединённый команду, введённую для рутинных обновлений схемы.
- Для ошибок области внедрения зависимостей во время выполнения смотрите [решение scoped service из singleton](/ru/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- Если `GetConnectionString` возвращает null во время проектирования, смотрите [статью об отсутствующей строке подключения](/ru/2026/05/fix-no-connection-string-named-defaultconnection/).
- Чтобы тестировать слой данных, вообще не задевая обнаружение времени проектирования, [интеграционные тесты с Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) держат тестовый проект независимым от тулчейна миграций.
- Чтобы прогреть создание модели до первого запроса, [прогрев модели EF Core](/ru/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) разбирает связанную проблему холодного пути.

## Источники

- [Design-time DbContext Creation - EF Core docs](https://learn.microsoft.com/en-us/ef/core/cli/dbcontext-creation)
- [EF Core Tools Reference - dotnet ef](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [HostFactoryResolver source on dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Hosting/src/Internal/HostFactoryResolver.cs)
- [EF Core issue 21025: design-time discovery on top-level statements](https://github.com/dotnet/efcore/issues/21025)
- [WebApplication and the generic host - ASP.NET Core docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis)
