---
title: "Как добавить Aspire в существующее решение ASP.NET Core без его перестройки"
description: "Добавление Aspire 13.4 в унаследованное решение ASP.NET Core: два новых проекта и три строки на сервис. aspire init, связывание AppHost через AddProject и WithReference, сохранение существующих launchSettings.json и строк подключения, а также подводные камни с резилентностью, health-эндпоинтами и прокси в первый же день."
pubDate: 2026-07-26
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "aspnetcore"
  - "dotnet-11"
  - "opentelemetry"
  - "devops"
lang: "ru"
translationOf: "2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it"
translatedBy: "claude"
translationDate: 2026-07-26
---

Aspire добавляется в существующее решение ASP.NET Core двумя новыми проектами рядом с теми, что у вас уже есть, а не переносом чего-либо. Проект `AppHost` оркестрирует ваши сервисы во время разработки, библиотека классов `ServiceDefaults` несёт общую настройку телеметрии и резилентности, а каждый существующий сервис получает ровно одну ссылку на проект плюс две строки в `Program.cs`. Структура папок, пространства имён, `launchSettings.json`, строки подключения, Dockerfile и пайплайн CI остаются такими, какие есть. Эта статья проходит весь путь на Aspire 13.4.6 (текущий стабильный релиз, опубликованный 2026-06-20) для .NET 10 и .NET 11 Preview 6.

Две вещи изменились по сравнению с руководствами, которые вы, скорее всего, нашли первыми. Aspire убрал ".NET" из названия вместе с Aspire 13 в ноябре 2025 года, а шаг `dotnet workload install aspire` исчез ещё в Aspire 9.0. Всё теперь приходит через NuGet и SDK для MSBuild, так что если старый workload всё ещё стоит на машине, `dotnet workload uninstall aspire` стоит выполнить первым делом. Если хочется концептуального обзора перед механикой, старый [обзор того, что такое Aspire](/ru/2023/11/what-is-net-aspire/) по-прежнему актуален.

## Что реально появляется в репозитории

Честная опись для решения с API и воркером:

```
MyApp.sln
  src/MyApp.Api/            <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.Worker/         <- unchanged except 1 ProjectReference + 2 lines
  src/MyApp.AppHost/        <- new
  src/MyApp.ServiceDefaults/<- new
  aspire.config.json        <- new, points the CLI at the AppHost
```

Ни один проект не перемещается. Пространства имён не меняются. Не меняется и то, как `dotnet publish` собирает образы контейнеров, потому что AppHost -- это оркестратор времени разработки, и он не входит в то, что вы разворачиваете. Именно последний пункт понимают неправильно чаще всего: AppHost не работает в production. Он запускает ваши процессы локально, внедряет в них конфигурацию и питает дашборд.

## Шаги для добавления Aspire в существующее решение

1. Установите Aspire CLI как глобальный инструмент и убедитесь, что он видит ваш SDK.
2. Выполните `aspire init` из корня решения, чтобы он обнаружил `.sln` и сгенерировал AppHost на основе проекта.
3. Добавьте ссылку на проект из AppHost на каждый сервис, который он должен запускать, а затем объявите эти сервисы через `AddProject` в `Program.cs` AppHost.
4. Сошлитесь на `ServiceDefaults` из каждого сервиса и вызовите `AddServiceDefaults()` и `MapDefaultEndpoints()`.
5. Опишите существующую инфраструктуру: контейнеры для того, что не жалко гонять локально, `AddConnectionString` для всего, что должно остаться внешним.
6. Выполните `aspire run` и проверьте, что каждый сервис по-прежнему стартует с теми конечными точками, которые у него были раньше.

Остальная часть статьи -- эти шесть шагов с кодом, а затем то, что ломается.

## Установка CLI

Начиная с Aspire 13.3 CLI поставляется как глобальный инструмент .NET, скомпилированный через NativeAOT, а значит, без workload и без зависимости от Visual Studio:

```bash
dotnet tool install -g Aspire.Cli
aspire doctor
```

`aspire doctor` появился в 13.4, и его стоит запустить раньше всего остального. Он печатает версию CLI, видимые ему SDK и, что важнее всего, разошлись ли версии вашего CLI и вашего `Aspire.AppHost.Sdk`. Расхождение версий между ними -- самый частый источник "у меня всё работало" в репозитории с Aspire.

## Генерация AppHost

Из каталога, где лежит ваш `.sln`:

```bash
aspire init
```

Когда `aspire init` находит файл решения, он создаёт AppHost на основе проекта и добавляет его в решение. Когда не находит (например, в полиглотном репозитории), он вместо этого создаёт однофайловый `apphost.cs` с директивами `#:sdk` и `#:package`. Для существующего решения ASP.NET Core вам нужна форма на основе проекта, потому что именно она даёт сгенерированное пространство имён `Projects` и интегрированную с IDE отладку сразу по всем сервисам.

Если не хочется пользоваться CLI, шаблоны делают ту же работу:

```bash
dotnet new aspire-apphost -o src/MyApp.AppHost
dotnet new aspire-servicedefaults -o src/MyApp.ServiceDefaults
dotnet sln add src/MyApp.AppHost src/MyApp.ServiceDefaults
```

Файл проекта AppHost невелик, и это единственное место, где фигурирует SDK Aspire:

```xml
<!-- src/MyApp.AppHost/MyApp.AppHost.csproj -- Aspire 13.4.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <Sdk Name="Aspire.AppHost.Sdk" Version="13.4.6" />

  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <IsAspireHost>true</IsAspireHost>
    <Nullable>enable</Nullable>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.AppHost" Version="13.4.6" />
  </ItemGroup>
</Project>
```

Обратите внимание на `TargetFramework`. AppHost может нацеливаться на более новый TFM, чем сервисы, которые он запускает, потому что запускает он их отдельными процессами. Решение, застрявшее на `net8.0` для своих сервисов, всё равно может иметь AppHost на `net10.0`.

## Подключение существующих проектов

Добавьте ссылки из AppHost на сервисы, а затем объявите их:

```bash
dotnet add src/MyApp.AppHost reference src/MyApp.Api src/MyApp.Worker
```

```csharp
// src/MyApp.AppHost/Program.cs -- Aspire 13.4.6
var builder = DistributedApplication.CreateBuilder(args);

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithExternalHttpEndpoints();

builder.AddProject<Projects.MyApp_Worker>("worker")
    .WithReference(api)
    .WaitFor(api);

builder.Build().Run();
```

Тип `Projects.MyApp_Api` генерируется SDK Aspire из элементов `ProjectReference`, где точки заменены на подчёркивания. Вы его не пишете, и до первой сборки он не существует.

Вот та часть, которая делает подход неинвазивным, и она плохо задокументирована: Aspire читает ваш существующий `Properties/launchSettings.json`. Запуская ресурс-проект, он выбирает профиль по приоритету: аргумент `launchProfileName`, если вы его передали, затем профиль, имя которого совпадает с собственным `DOTNET_LAUNCH_PROFILE` AppHost, затем первый профиль в файле, затем вообще никакой профиль. Он разбирает `applicationUrl` выбранного профиля и превращает его в `ASPNETCORE_URLS`, а `environmentVariables` этого профиля применяет без изменений. Ваши существующие профили продолжают работать. Если у сервиса профиль "IIS Express" стоит в файле первым, а вам нужен профиль Kestrel, укажите его явно:

```csharp
builder.AddProject<Projects.MyApp_Api>("api", launchProfileName: "https");
```

Передача `launchProfileName: null` запускает проект вообще без профиля -- самый чистый вариант для воркера, у которого нет осмысленного `launchSettings.json`.

## Две строки на сервис

`ServiceDefaults` -- это обычная библиотека классов, помеченная как `IsAspireSharedProject`. Сошлитесь на неё из каждого сервиса и вызовите её методы:

```csharp
// src/MyApp.Api/Program.cs -- ASP.NET Core on .NET 10 / .NET 11 Preview 6
var builder = WebApplication.CreateBuilder(args);

builder.AddServiceDefaults();   // <- added

builder.Services.AddControllers();
// ... everything you already had, untouched

var app = builder.Build();

app.MapDefaultEndpoints();      // <- added

app.MapControllers();
app.Run();
```

`AddServiceDefaults()` делает четыре вещи: настраивает журналирование, метрики и трассировку OpenTelemetry (запросы к health-проверкам отфильтровываются из трассировок); регистрирует liveness-проверку; регистрирует обнаружение сервисов; и применяет `ConfigureHttpClientDefaults`, чтобы каждый `HttpClient` получил стандартный обработчик резилентности и разрешение имён через обнаружение сервисов. `MapDefaultEndpoints()` отображает `/health` (должны пройти все проверки) и `/alive` (только проверки с тегом `live`), причём шаблон закрывает обе конечные точки проверкой на среду разработки.

Ничто из этого не является специфичным для Aspire во время выполнения. Сервис, вызывающий `AddServiceDefaults()`, прекрасно работает вне AppHost, под `dotnet run`, в контейнере, в вашем существующем развёртывании Kubernetes. Он просто экспортирует телеметрию OTLP туда, куда указывает `OTEL_EXPORTER_OTLP_ENDPOINT`: в дашборд, когда его запустил AppHost, и в ваш настоящий коллектор, когда нет. Если коллектора ещё нет, [разбор бесплатного бэкенда OpenTelemetry](/ru/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) покрывает другой конец этой трубы.

## Описание уже имеющейся инфраструктуры

Именно здесь унаследованный проект сильнее всего расходится с туториалами с нуля, которые всегда начинают с того, что упаковывают всё в контейнеры. Обычно вы так не можете. Общий SQL Server для разработки является общим не просто так, а в очереди лежат данные.

Для зависимостей, которые не жалко гонять локально, добавьте интеграцию и отдайте контейнер под управление Aspire:

```bash
aspire add redis
```

```csharp
var cache = builder.AddRedis("cache");

var api = builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(cache)
    .WaitFor(cache);
```

`WithReference(cache)` внедряет `ConnectionStrings__cache` в процесс API. Ваш существующий вызов `builder.Configuration.GetConnectionString("cache")` читает это значение без изменений, потому что переменные окружения имеют более высокий приоритет, чем `appsettings.json`, в конфигурации по умолчанию. В этом и весь фокус: Aspire не просит ваш код менять способ чтения конфигурации, он просто поставляет значения с более высоким приоритетом. То же самое, если вы настраиваете [HybridCache с Redis в роли L2](/ru/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/): ресурс кеша даёт строку подключения, а остальная ваша настройка не меняется.

Для зависимостей, которые должны остаться внешними, `AddConnectionString` создаёт ресурс, опирающийся на конфигурацию самого AppHost, а не на контейнер:

```csharp
// Reads ConnectionStrings:orders from the AppHost's appsettings.json or user secrets
var orders = builder.AddConnectionString("orders");

builder.AddProject<Projects.MyApp_Api>("api")
    .WithReference(orders);
```

Реальное значение положите в user secrets самого AppHost, а не в `appsettings.json`:

```bash
dotnet user-secrets --project src/MyApp.AppHost set "ConnectionStrings:orders" "Server=dev-sql;Database=Orders;..."
```

Сервис видит `ConnectionStrings__orders`, и больше ничего не меняется. Если сервис ищет имя, которое AppHost никогда не объявлял, вы получите знакомый сбой при старте, разобранный в статье [не найдена строка подключения с именем DefaultConnection](/ru/2026/05/fix-no-connection-string-named-defaultconnection/); имя ресурса в `AddConnectionString` должно точно совпадать с ключом, который запрашивает ваш код.

Вызовы между сервисами устроены так же. `WithReference(api)` внедряет `services__api__https__0` и `services__api__http__0`, а обнаружение сервисов разрешает логическое имя:

```csharp
builder.Services.AddHttpClient<OrdersClient>(
    c => c.BaseAddress = new("https+http://api"));
```

`https+http://` означает "предпочесть HTTPS, откатиться на HTTP". Разрешается это только в проекте, где зарегистрировано обнаружение сервисов, что `AddServiceDefaults()` делает за вас. Используйте эту схему в проекте, пропустившем `AddServiceDefaults()`, и получите `UriFormatException` на первом же запросе, а не при старте.

## Запуск

```bash
aspire run
```

CLI находит AppHost через `aspire.config.json`, поднимает все ресурсы и печатает URL дашборда. В Visual Studio или Rider назначьте AppHost стартовым проектом и нажмите F5; конфигурации запуска нескольких проектов больше не нужны.

Что удивляет тех, кто приходит из руководств образца 2023 года: Docker запускать не нужно, пока вы фактически не объявили ресурс-контейнер. AppHost, состоящий из одних вызовов `AddProject`, стартует без установленной среды выполнения контейнеров вообще. Это делает первый коммит безопасным: можно внести AppHost с нулём контейнерных ресурсов, получить дашборд и распределённую трассировку, а зависимости упаковать в контейнеры позже или никогда.

## Что ломается в первый день

**Стандартный обработчик резилентности меняет поведение вашего HTTP.** `AddServiceDefaults()` применяет его к каждому `HttpClient` в процессе, а это повторы, circuit breaker и общий тайм-аут запроса. Если у вас есть клиент, которому законно нужны две минуты, или уже написаны свои пайплайны Polly, теперь слоёв два. Уберите свой либо ограничьте область действия умолчаний, но не оставляйте оба.

**Дублирующиеся health-эндпоинты.** Если вы уже сами отображаете `/health`, `MapDefaultEndpoints()` даст вторую регистрацию на том же маршруте. Выберите что-то одно. [Разбор health-проверок в minimal API](/ru/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) объясняет, что оставить, если нужен более богатый вывод, чем стандартный.

**Двойная регистрация OpenTelemetry.** `ConfigureOpenTelemetry` в `ServiceDefaults` добавляется поверх всего, что вы уже зарегистрировали. Если в вашем `Program.cs` есть собственный `AddOpenTelemetry().WithTracing(...)`, вы получите дублирующуюся инструментацию, а с Serilog в связке -- ещё и дублирующиеся записи журнала. Удалите свою версию и настраивайте вместо неё вариант из `ServiceDefaults`: ради этого общий проект и существует.

**Конечные точки по умолчанию проксируются.** Aspire ставит обратный прокси перед каждой конечной точкой, поэтому порт, на который приходит браузер, -- не тот порт, к которому привязался Kestrel. Это незаметно, пока что-нибудь внешнее не зафиксирует порт: URI перенаправления OIDC, зарегистрированный у вашего поставщика удостоверений, вебхук из песочницы платёжного сервиса, зашитый URL в мобильном клиенте. Отключается для отдельной конечной точки:

```csharp
builder.AddProject<Projects.MyApp_Api>("api")
    .WithEndpoint("https", e => e.IsProxied = false);
```

**Ваш CI теперь собирает AppHost.** `dotnet build MyApp.sln` подхватывает новый проект, которому нужно восстановить `Aspire.AppHost.Sdk` из NuGet. На закрытом фиде с явным белым списком пакетов это падает, причём ошибка выглядит как ошибка разрешения SDK, а не как отсутствие пакета, что диагностируется дольше, чем следовало бы. Либо внесите SDK и пакеты хостинга в белый список, либо исключите AppHost из сборки CI фильтром решения. Больше в вашем пайплайне развёртывания менять нечего, потому что вы по-прежнему публикуете те же проекты сервисов тем же способом.

**Пользователям Postgres на 13.4:** образ по умолчанию перешёл с 17.6 на 18.3 и не подключится к существующему тому данных 17.x. Зафиксируйте тег через `WithImageTag`, если локальные данные вам дороги.

## Похожие статьи

- [Что такое .NET Aspire?](/ru/2023/11/what-is-net-aspire/) -- концептуальная модель AppHost и интеграций.
- [Как добавить health-эндпоинт в minimal API на ASP.NET Core 11](/ru/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/), если `MapDefaultEndpoints` конфликтует с тем, что у вас уже есть.
- [Как использовать OpenTelemetry с .NET 11 и бесплатным бэкендом](/ru/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) -- куда уходят трассировки, когда вы выходите за пределы дашборда.
- [Fix: не найдена строка подключения с именем 'DefaultConnection'](/ru/2026/05/fix-no-connection-string-named-defaultconnection/) -- сценарий отказа при несовпадении имени ресурса.
- [Изолированный режим Aspire 13.2 и параллельные экземпляры AppHost](/ru/2026/04/aspire-13-2-isolated-mode-parallel-apphost-instances/), если двум разработчикам или двум веткам нужно запускать один и тот же AppHost одновременно.

## Источники

- [Add Aspire to an existing app](https://aspire.dev/get-started/add-aspire-existing-app/), документация Aspire.
- [C# service defaults](https://aspire.dev/get-started/csharp-service-defaults/), документация Aspire.
- [C# launch profiles in the Aspire AppHost](https://aspire.dev/integrations/dotnet/launch-profiles/), документация Aspire.
- [External parameters and secrets in the AppHost](https://aspire.dev/fundamentals/external-parameters/), документация Aspire.
- [Service discovery](https://aspire.dev/fundamentals/service-discovery/), документация Aspire.
- [What's new in Aspire 13.3](https://aspire.dev/whats-new/aspire-13-3/) и [What's new in Aspire 13.4](https://aspire.dev/whats-new/aspire-13-4/), документация Aspire.
- [Aspire releases](https://github.com/microsoft/aspire/releases) на GitHub -- версия 13.4.6 и её дата.
