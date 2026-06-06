---
title: "Миграция с IWebHostBuilder на WebApplication.CreateBuilder в .NET 11"
description: "Пошаговая миграция со старой модели хостинга на основе Startup.cs и WebHostBuilder на минимальную модель хостинга с WebApplication.CreateBuilder, включая устаревание ASPDEPR008, порядок middleware, IStartupFilter и то, как сохранить работоспособность тестов."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "aspnetcore-11"
  - "dotnet-11"
  - "minimal-hosting"
lang: "ru"
translationOf: "2026/06/migrate-from-iwebhostbuilder-to-webapplication-createbuilder"
translatedBy: "claude"
translationDate: 2026-06-06
---

Если ваш `Program.cs` всё ещё вызывает `Host.CreateDefaultBuilder(args).ConfigureWebHostDefaults(web => web.UseStartup<Startup>())`, вы используете устаревшую модель хостинга, и компилятор уже начал предупреждать вас об этом. Начиная с .NET 10, типы `WebHost`, `WebHostBuilder` и `IWebHost` помечены как устаревшие с диагностикой `ASPDEPR008`, и это устаревание переносится в .NET 11. Замена -- это минимальная модель хостинга, построенная вокруг `WebApplication.CreateBuilder(args)`, которая используется по умолчанию во всех шаблонах проектов начиная с ASP.NET Core 6.0. В этом посте выполняется миграция приложения на основе `Startup` на минимальный хостинг с целевой платформой `net11.0`, охватывая те детали, на которых реально спотыкаются: порядок middleware, потерянная DI-область на старте, `IStartupFilter` и сохранение работоспособности тестов на `WebApplicationFactory`.

Для небольшого сервиса миграция механическая (час или два), а для монолита с собственным middleware, реализациями `IStartupFilter` и большим `ConfigureServices` -- полдня. В поведении вашего приложения ничего менять не нужно. Вы переносите те же регистрации и тот же конвейер middleware в более плоский файл. Единственное реальное семантическое отличие -- это DI-область на старте, о которой пойдёт речь ниже.

## Почему мигрировать сейчас

- `WebHost` / `WebHostBuilder` / `IWebHost` выдают предупреждения сборки `ASPDEPR008` начиная с .NET 10. Если вы собираете с `TreatWarningsAsErrors`, ваш переход на .NET 11 не скомпилируется, пока вы не уйдёте от них.
- Минимальная модель хостинга -- это то, куда направляются все новые инвестиции в ASP.NET Core. Такие возможности, как Native AOT для minimal API, облегчённый `WebApplication.CreateSlimBuilder` и `CreateEmptyBuilder`, существуют только на новом пути.
- Два файла начальной загрузки сливаются в один. `Startup.cs` плюс служебный метод `CreateHostBuilder` превращается в единый читаемый `Program.cs`, а конфигурация, сервисы и конвейер читаются сверху вниз.
- Это открывает путь к minimal API. Нельзя чисто вызвать `app.MapGet(...)` в кодовой базе, чей конвейер живёт внутри сигнатуры `Startup.Configure(IApplicationBuilder, IWebHostEnvironment)`.

## Что ломается

| Область                    | Изменение                                                                                    | Серьёзность |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| `WebHost` / `IWebHost`     | Устарели начиная с .NET 10 (`ASPDEPR008`). Предупреждения или ошибки при `TreatWarningsAsErrors` | высокая  |
| `Startup` через `builder.Host`| `WebApplicationBuilder.Host.ConfigureWebHostDefaults(...UseStartup<T>())` бросает исключение во время выполнения | высокая  |
| DI-область на старте        | Нет области вокруг поставщика сервисов во время старта; разрешение scoped-сервисов теперь бросает исключение    | средняя  |
| Порядок middleware         | Тело `Configure` нужно заново выразить после `builder.Build()`, в том же порядке              | средняя  |
| `IStartupFilter`           | Всё ещё работает, но теперь выполняется вокруг конвейера минимального хостинга; проверьте порядок | низкая   |
| `IHostingStartup`          | Всё ещё поддерживается, но для некоторых сборок читает `WebApplicationBuilder` иначе          | низкая   |
| `IWebHostBuilder` (интерфейс)| Сохраняется через `builder.WebHost` для узкой конфигурации (`UseKestrel`, `UseUrls`); не исчез | низкая   |

Обратите внимание на последнюю строку. *Интерфейс* `IWebHostBuilder` не удалён. `WebApplicationBuilder` предоставляет его как `builder.WebHost`, так что вы по-прежнему можете вызывать `builder.WebHost.ConfigureKestrel(...)`. Устарели именно отдельная начальная загрузка `WebHost.CreateDefaultBuilder()` и `IWebHost`, который она строит. Цель миграции -- `WebApplication.CreateBuilder`, а не удаление каждого типа, в имени которого есть `WebHost`.

## Предполётный чек-лист

1. Установите .NET 11 SDK на каждой машине разработчика и на CI-раннере. Проверьте через `dotnet --list-sdks` и убедитесь, что `11.0.x` присутствует.
2. Убедитесь, что проект уже нацелен на `net6.0` или новее. Минимальная модель хостинга не существует до .NET 6, поэтому приложению на .NET 5 или ранее сначала нужно поднять платформу. См. [чек-лист перехода с .NET 8 на .NET 11](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), если вы заодно пересекаете LTS-версии, или [руководство по переходу с .NET Framework 4.8 на .NET 11](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) для более крупного скачка.
3. Проведите инвентаризацию своего класса `Startup`. Перечислите каждую строку в `ConfigureServices` и каждый вызов middleware в `Configure`, по порядку. Порядок в `Configure` -- это контракт, который вы обязаны сохранить.
4. Найдите grep-ом реализации `IStartupFilter` и сборки `IHostingStartup`. Они выполняются вне `Startup`, и о них легко забыть.
5. Зафиксируйте чистую базовую точку, чтобы у вас был откат одной командой.

## До: приложение на основе Startup

Вот форма, которую разделяет почти каждое приложение до 6.0. Два файла, где обвязка хоста отделена от конфигурации сервисов и конвейера.

```csharp
// Program.cs -- legacy generic host, ASP.NET Core 3.1 / 5.0 style
// Builds with ASPDEPR008 warnings on .NET 10/11 if WebHost APIs are used
public class Program
{
    public static void Main(string[] args) =>
        CreateHostBuilder(args).Build().Run();

    public static IHostBuilder CreateHostBuilder(string[] args) =>
        Host.CreateDefaultBuilder(args)
            .ConfigureWebHostDefaults(webBuilder =>
            {
                webBuilder.UseStartup<Startup>();
            });
}
```

```csharp
// Startup.cs -- legacy services + pipeline split
public class Startup
{
    public Startup(IConfiguration configuration) => Configuration = configuration;

    public IConfiguration Configuration { get; }

    public void ConfigureServices(IServiceCollection services)
    {
        services.AddControllers();
        services.AddDbContext<AppDbContext>(o =>
            o.UseSqlServer(Configuration.GetConnectionString("DefaultConnection")));
        services.AddScoped<IOrderService, OrderService>();
        services.AddSwaggerGen();
    }

    public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
    {
        if (env.IsDevelopment())
        {
            app.UseDeveloperExceptionPage();
            app.UseSwagger();
            app.UseSwaggerUI();
        }

        app.UseHttpsRedirection();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.UseEndpoints(endpoints => endpoints.MapControllers());
    }
}
```

## Шаги миграции

### 1. Перенесите ConfigureServices в builder

Создайте builder, затем скопируйте каждую строку из `Startup.ConfigureServices` дословно, заменяя `services` на `builder.Services`. `IConfiguration` доступен как `builder.Configuration`, поэтому поиск строки подключения переносится без изменений.

```csharp
// Program.cs -- .NET 11, minimal hosting model
var builder = WebApplication.CreateBuilder(args);

// formerly Startup.ConfigureServices, services -> builder.Services
builder.Services.AddControllers();
builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("DefaultConnection")));
builder.Services.AddScoped<IOrderService, OrderService>();
builder.Services.AddSwaggerGen();
```

Проверка: выполните `dotnet build`. Проект должен скомпилироваться с регистрациями сервисов на месте, прежде чем вы тронете конвейер. Если регистрация не может разрешить `builder.Configuration`, значит вы скопировали ссылку на поле `Configuration`, которого больше нет; замените её на `builder.Configuration`.

### 2. Постройте приложение и заново выразите конвейер в том же порядке

Вызовите `builder.Build()`, затем переведите `Startup.Configure` строку за строкой. `IApplicationBuilder app` становится `WebApplication app`, а `env.IsDevelopment()` становится `app.Environment.IsDevelopment()`. Порядок middleware должен в точности совпадать с оригиналом, потому что порядок -- это и есть конвейер.

```csharp
// .NET 11, minimal hosting model -- continued
var app = builder.Build();

// formerly Startup.Configure, same order
if (app.Environment.IsDevelopment())
{
    app.UseDeveloperExceptionPage();
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseHttpsRedirection();
app.UseAuthentication();
app.UseAuthorization();

app.MapControllers();

app.Run();
```

Две вещи сократились. `UseRouting` и `UseEndpoints` больше не требуются: минимальный хост добавляет middleware маршрутизации автоматически, а `app.MapControllers()` заменяет блок `UseEndpoints(e => e.MapControllers())`. Если у вас есть middleware, которое должно выполняться *между* маршрутизацией и выполнением конечной точки (например, собственное middleware, читающее метаданные сопоставленной конечной точки), оставьте явный вызов `app.UseRouting()` и разместите это middleware после него. Иначе уберите оба.

Проверка: `dotnet run`, затем обратитесь к известному маршруту. Ответ 200 на действии контроллера подтверждает, что конвейер собран. 404 на каждом маршруте обычно означает, что `MapControllers` отсутствует или стоит перед терминальным middleware.

### 3. Удалите Startup.cs и обвязку CreateHostBuilder

Как только `Program.cs` содержит всё, удалите `Startup.cs` и старый метод `CreateHostBuilder`. Не пытайтесь сохранить `Startup` живым, вызывая `builder.Host.ConfigureWebHostDefaults(web => web.UseStartup<Startup>())`. Это бросает исключение во время выполнения: минимальный хостинг запрещает настраивать веб-хост через `builder.Host` или `builder.WebHost`, как только вы перешли на `WebApplicationBuilder`.

Если вы не можете удалить `Startup` за один проход (огромный `ConfigureServices`, который вы хотите мигрировать инкрементально), переходный шаблон -- инстанцировать его вручную, а не пропускать через хост:

```csharp
// .NET 11 -- temporary bridge, not the WebApplicationBuilder.Host path
var builder = WebApplication.CreateBuilder(args);
var startup = new Startup(builder.Configuration);
startup.ConfigureServices(builder.Services);

var app = builder.Build();
startup.Configure(app, app.Environment); // Configure must accept IApplicationBuilder
app.Run();
```

Это компилируется, потому что `WebApplication` реализует `IApplicationBuilder` и `IEndpointRouteBuilder`. Воспринимайте это как леса для одного PR, а не как конечную точку назначения.

Проверка: найдите в решении `UseStartup`, `WebHost.CreateDefaultBuilder` и `ConfigureWebHostDefaults`. Ноль совпадений означает, что устаревшая начальная загрузка ушла и `ASPDEPR008` не сработает.

### 4. Перенесите конфигурацию хоста и Kestrel на builder

Всё, что вы настраивали на старом `IWebHostBuilder` (лимиты Kestrel, URL, корень контента), переносится на `builder.WebHost`, который по-прежнему предоставляет поверхность `IWebHostBuilder`. Заботы generic host (журналирование, интеграция с Serilog, `UseWindowsService`) переносятся на `builder.Host`.

```csharp
// .NET 11 -- host/web host configuration on the new builder
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 50 * 1024 * 1024);
builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));
```

Проверка: убедитесь, что настроенный лимит вступает в силу (тело запроса сверх лимита возвращает `413`), и что ваш приёмник журналирования по-прежнему получает записи.

## Проверка

Пройдите этот чек-лист после миграции перед слиянием:

- `dotnet build` выдаёт ноль предупреждений `ASPDEPR008` и ноль ссылок на `UseStartup`.
- `dotnet run` запускается и обслуживает известный маршрут с ожидаемым кодом статуса.
- `dotnet test` проходит, включая любые интеграционные тесты на `WebApplicationFactory` (см. подводный камень ниже).
- Зависящее от middleware поведение по-прежнему работает от начала до конца: запросы аутентификации, перенаправление на HTTPS, предварительные запросы CORS, ответы обработчика исключений.
- Тело запроса сверх вашего лимита Kestrel по-прежнему возвращает `413`, подтверждая, что конфигурация хоста мигрировала.

## План отката

Эта миграция обратима, пока вы не удалили `Startup.cs`. Безопасная последовательность -- выполнить шаги 1 и 2 в ветке, убедиться, что тесты проходят, и только потом удалить устаревшие файлы отдельным коммитом. Если что-то регрессирует после удаления, выполните `git revert` коммита удаления, чтобы восстановить `Startup.cs` и старый `Program.cs`. Поскольку шаблон `Startup` всё ещё работает на .NET 11 (он только предупреждает, он не удалён), временный откат позволяет продолжать поставку, пока вы отлаживаете. Точка невозврата -- полное удаление начальной загрузки generic host; держите её в отдельном коммите.

## Подводные камни, на которые мы наткнулись

**DI-область на старте исчезла.** Старый generic host создавал DI-область во время построения поставщика сервисов, поэтому код, разрешавший scoped-сервис во время старта, случайно работал. Минимальный хостинг этого не делает. Если вы разрешали `DbContext` в `Configure`, чтобы выполнить миграцию или шаг наполнения данными, вы теперь получаете `Cannot resolve scoped service '...' from root provider`. Оберните работу на старте в явную область:

```csharp
// .NET 11 -- explicit scope for startup-time scoped resolution
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    db.Database.Migrate();
}
app.Run();
```

Это самая частая поломка во время выполнения при миграции. Общее правило и его варианты рассмотрены в [разрешении scoped-сервисов из синглтона](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) и в [использовании scoped-сервисов внутри BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

**У `WebApplicationFactory<TStartup>` больше нет `Startup`, на который можно указать.** Интеграционным тестам, ссылавшимся на `WebApplicationFactory<Startup>`, нужен новый тип точки входа. Точка входа минимального хоста -- это автоматически сгенерированный класс `Program`, но он `internal`, поэтому тестовый проект его не видит. Откройте его, добавив частичное объявление в конце `Program.cs`:

```csharp
// Program.cs -- end of file, .NET 11
public partial class Program { }
```

Затем измените тестовую фабрику на `WebApplicationFactory<Program>`. Без частичного объявления вы получите `'Program' is inaccessible due to its protection level` в тестовом проекте.

**`IStartupFilter` всё ещё работает, но порядок сдвигается.** Фильтры, зарегистрированные через `services.AddTransient<IStartupFilter, MyFilter>()`, продолжают выполняться, оборачивая настроенный конвейер. При минимальном хостинге нет явного метода `Configure`, который они могли бы обернуть, поэтому фильтр, предполагавший, что он выполняется до настройки маршрутизации, теперь может выполняться в слегка иной позиции. Если вы использовали `IStartupFilter` исключительно для внедрения middleware из библиотеки, проверьте, где это middleware оказывается относительно ваших вызовов `app.Use...`, и переупорядочьте, если запрос ведёт себя иначе.

**Middleware, читающему сопоставленную конечную точку, нужен явный `UseRouting`.** Удаление `UseRouting` нормально для общего случая, но если у вас есть middleware, вызывающее `context.GetEndpoint()`, оно должно стоять после выполнения маршрутизации. Заново добавьте `app.UseRouting()` перед этим middleware и держите `app.MapControllers()` после него. Для более глубокого сравнения двух стилей конечных точек см. [minimal API против контроллеров в ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/).

**Зависящая от порядка регистрация именованных опций.** Небольшое число команд полагалось на то, что `ConfigureServices` выполняется до `IHostingStartup` библиотеки. Минимальный хост вычисляет `builder.Services` энергично при `builder.Build()`, поэтому если вы зарегистрировали сервис после вызова библиотечного расширения, захватившего коллекцию, тайминг может отличаться. Это редкость, но если настроенная опция возвращается null после миграции, проверьте, не зарегистрировали ли вы её после потребляющего вызова `Add...`.

Как только вы перешли на `WebApplication.CreateBuilder`, открывается остальная современная поверхность: конечные точки minimal API рядом с вашими контроллерами, `CreateSlimBuilder` для Native AOT и более чистая обработка исключений, показанная в [добавлении глобального обработчика исключений в ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/). Миграция хостинга -- это ворота; всё остальное оттуда инкрементально.

## Источники

- [WebHostBuilder, IWebHost, and WebHost are obsolete](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/10/webhostbuilder-deprecated) (критические изменения .NET, диагностика `ASPDEPR008`)
- [Migrate from ASP.NET Core in .NET 5 to .NET 6](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60) (оригинальное руководство по миграции на минимальный хостинг)
- [Code samples migrated to the new minimal hosting model](https://learn.microsoft.com/en-us/aspnet/core/migration/50-to-60-samples) (примеры `Startup` до/после)
- [Deprecating WebHostBuilder, IWebHost, and WebHost](https://github.com/dotnet/aspnetcore/discussions/63480) (обсуждение dotnet/aspnetcore #63480)
