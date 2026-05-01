---
title: "Как писать интеграционные тесты против настоящего SQL Server с помощью Testcontainers"
description: "Полное руководство по запуску интеграционных тестов ASP.NET Core против настоящего SQL Server 2022 с использованием Testcontainers 4.11 и EF Core 11: настройка WebApplicationFactory, IAsyncLifetime, подмена регистрации DbContext, применение миграций, параллелизм, очистка через Ryuk и подводные камни CI."
pubDate: 2026-05-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "sql-server"
lang: "ru"
translationOf: "2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers"
translatedBy: "claude"
translationDate: 2026-05-01
---

Чтобы запустить интеграционные тесты против настоящего SQL Server из тестового проекта на .NET 11, установите `Testcontainers.MsSql` 4.11.0, соберите `WebApplicationFactory<Program>`, владеющую `MsSqlContainer`, запустите контейнер в `IAsyncLifetime.InitializeAsync`, переопределите регистрацию `DbContext` в `ConfigureWebHost`, чтобы она указывала на `container.GetConnectionString()`, и примените миграции один раз перед первым тестом. Используйте `IClassFixture<T>`, чтобы xUnit делил один контейнер между тестами в классе. Зафиксируйте образ SQL Server на конкретном теге, по умолчанию `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04`, и позвольте Ryuk утилизировать контейнер, если ваш процесс упадёт. Это руководство написано для .NET 11 preview 3, C# 14, EF Core 11, xUnit 2.9 и Testcontainers 4.11. На .NET 8, 9 и 10 шаблон тот же, меняются только версии пакетов.

## Почему настоящий SQL Server, а не in-memory провайдер

EF Core поставляется с in-memory провайдером и вариантом SQLite-in-memory, которые выглядят как SQL Server до тех пор, пока не перестают. У in-memory провайдера вообще нет реляционного поведения: ни транзакций, ни принуждения внешних ключей, ни токенов конкуренции `RowVersion`, ни трансляции SQL. SQLite — настоящий реляционный движок, но с другим диалектом SQL, другим способом квотинга идентификаторов и другим decimal-типом. Те самые проблемы, которые ваши интеграционные тесты должны ловить — отсутствующий индекс, нарушение уникального ограничения, обрезка `nvarchar` или потеря точности у `DateTime2`, — молча маскируются.

Официальная документация EF Core несколько лет назад добавила предупреждение «не тестируйте против in-memory», а рекомендуемый командой шаблон на странице [testing without your production database system](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) звучит как «поднимите настоящий в контейнере». Testcontainers превращает это в один вызов метода. Цена — холодный старт скачивания и запуска образа SQL Server (порядка 8–12 секунд при тёплом Docker daemon), зато каждое утверждение после этого проверяет тот же движок, что и в продакшене.

## Зафиксируйте образ, не оставляйте плавающим

До любого кода определитесь с тегом образа. Документация Testcontainers по умолчанию использует `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04`, и это правильный выбор по той же причине, по которой вы не плавите `:latest` в продакшене: CI-пайплайн, который работал вчера, должен работать сегодня. Новый cumulative update — это не бесплатное обновление в вашем тестовом пайплайне, потому что каждый CU может изменить оптимизатор, поправить схемы `sys.dm_*` и поднять минимальный уровень патча для инструментов вроде `sqlpackage`.

Образ `2022-CU14-ubuntu-22.04` весит около 1,6 ГБ в сжатом виде, и первый pull на свежем CI-раннере — самая медленная часть набора. Кешируйте этот слой в CI: в GitHub Actions есть `docker/setup-buildx-action` с `cache-from`, в Azure DevOps можно кешировать `~/.docker` с тем же эффектом. После первого тёплого кеша pull занимает около 2 секунд.

Если нужны возможности SQL Server 2025 (векторный поиск, `JSON_CONTAINS`, см. [SQL Server 2025 JSON contains in EF Core 11](/ru/2026/04/efcore-11-json-contains-sql-server-2025/)), поднимите тег до `2025-CU2-ubuntu-22.04`. Иначе оставайтесь на 2022, потому что developer-образ для 2022 наиболее широко протестирован мейнтейнерами Testcontainers.

## Нужные пакеты

Три пакета покрывают happy path:

```xml
<!-- .NET 11, xUnit-based test project -->
<ItemGroup>
  <PackageReference Include="Testcontainers.MsSql" Version="4.11.0" />
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
</ItemGroup>
```

`Testcontainers.MsSql` тянет базовый пакет `Testcontainers` и `MsSqlBuilder`. `Microsoft.AspNetCore.Mvc.Testing` поставляет `WebApplicationFactory<TEntryPoint>`, который поднимает весь ваш DI-контейнер и HTTP-пайплайн против `TestServer`. `Microsoft.EntityFrameworkCore.SqlServer` — то, на что уже ссылается ваш продакшен-код; тестовый проект подтягивает его, чтобы фикстура могла применять миграции.

Если тесты на xUnit, добавьте также `xunit` 2.9.x и `xunit.runner.visualstudio` 2.8.x. На NUnit или MSTest тот же фабричный шаблон работает, меняются только имена хуков жизненного цикла.

## Класс фабрики

Фабрика интеграционных тестов делает три вещи: владеет временем жизни контейнера, выставляет строку подключения в DI хоста и применяет схему до запуска любого теста. Вот полная реализация для гипотетического `OrdersDbContext`:

```csharp
// .NET 11, C# 14, EF Core 11, Testcontainers 4.11
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.MsSql;
using Xunit;

public sealed class OrdersApiFactory
    : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly MsSqlContainer _sql = new MsSqlBuilder()
        .WithImage("mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04")
        .WithPassword("Strong!Passw0rd_for_tests")
        .Build();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<OrdersDbContext>>();
            services.AddDbContext<OrdersDbContext>(opts =>
                opts.UseSqlServer(_sql.GetConnectionString()));
        });
    }

    public async Task InitializeAsync()
    {
        await _sql.StartAsync();

        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider
            .GetRequiredService<OrdersDbContext>();
        await db.Database.MigrateAsync();
    }

    public new async Task DisposeAsync()
    {
        await _sql.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

Стоит обратить внимание на три детали. Контейнер создаётся в инициализаторе поля, но запускается только в `InitializeAsync`, потому что xUnit вызывает этот метод ровно один раз на фикстуру. Хост (а значит, и DI-контейнер) собирается `WebApplicationFactory` лениво, в первый раз когда читается `Services` или вызывается `CreateClient`, поэтому к моменту, когда `InitializeAsync` зовёт `Services.CreateScope()`, SQL-контейнер уже поднят и строка подключения подключена. Строка `RemoveAll<DbContextOptions<OrdersDbContext>>` обязательна: без неё остаются две регистрации, и `services.AddDbContext` становится второй, что молча сохраняет обе в зависимости от порядка резолвера.

Вызов `WithPassword` задаёт пароль SA. Политика паролей SQL Server требует минимум восьми символов и сочетания заглавных, строчных, цифр и символов; если вы зададите слабее, контейнер запустится, но движок не пройдёт health-проверки. По умолчанию SA-пароль Testcontainers — `yourStrong(!)Password`, он уже соответствует политике, поэтому пропустить `.WithPassword` тоже допустимо.

## Использование фабрики в тестовом классе

`IClassFixture<T>` из xUnit — правильный скоуп для большинства случаев. Он создаёт фикстуру один раз, гоняет каждый тестовый метод класса против одного и того же SQL-контейнера, а потом утилизирует:

```csharp
// .NET 11, xUnit 2.9
public sealed class OrdersApiTests : IClassFixture<OrdersApiFactory>
{
    private readonly OrdersApiFactory _factory;
    private readonly HttpClient _client;

    public OrdersApiTests(OrdersApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Post_creates_order_and_returns_201()
    {
        var response = await _client.PostAsJsonAsync("/orders",
            new { customerId = "C-101", amount = 49.99m });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    [Fact]
    public async Task Get_returns_persisted_order()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        db.Orders.Add(new Order { Id = "O-1", CustomerId = "C-101" });
        await db.SaveChangesAsync();

        var response = await _client.GetAsync("/orders/O-1");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
```

Если для каждого теста нужен свежий контейнер (например, тест переписывает схему), используйте `IAsyncLifetime` напрямую на тестовом классе вместо `IClassFixture`. Это редкость; в девяти случаях из десяти вы хотите заплатить цену холодного старта один раз на класс, а состояние сбрасывать через truncate таблиц, а не через ребут.

## Сбрасывайте состояние между тестами, не перезапускайте контейнер

Честная цена тестов с «настоящим SQL Server» — утечка состояния: тест A вставляет строки, тест B проверяет count и получает неправильный ответ. Есть три решения по возрастанию скорости:

1. **Truncate в начале каждого теста.** Дешевле всего. Держите `static readonly string[] TablesInTruncationOrder` и запускайте `TRUNCATE TABLE` для каждой. Это и рекомендуют мейнтейнеры Testcontainers в их примере для ASP.NET Core.
2. **Заворачивать каждый тест в транзакцию и делать rollback в конце.** Работает, если тестируемый код сам не вызывает `BeginTransaction`. EF Core 11 по-прежнему не разрешает вложенные транзакции на SQL Server без вызова `EnlistTransaction`.
3. **Использовать `Respawn`** ([пакет на NuGet](https://www.nuget.org/packages/Respawn)). Один раз генерирует скрипт truncate, читая information schema, кеширует и запускает перед каждым тестом. На это переходят большинство крупных команд после нескольких сотен тестов.

Что бы вы ни выбрали, **не** вызывайте `EnsureDeletedAsync` и `MigrateAsync` между тестами. Раннер миграций EF Core тратит однозначные секунды даже на маленькую схему; помножьте на 200 тестов, и набор переедет с 30 секунд на 30 минут. О компромиссах времени жизни DbContext в тестах см. [removing pooled DbContextFactory in EF Core 11 test swaps](/ru/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) и связанные заметки про [warming up the EF Core model](/ru/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/).

## Параллельный запуск тестов

xUnit по умолчанию запускает тестовые классы параллельно. С одним контейнером на class fixture это значит N классов поднимают M контейнеров одновременно, где M ограничено памятью вашего Docker-хоста. SQL Server в простое съедает примерно 1,5 ГБ ОЗУ на инстанс, поэтому 16 ГБ раннер GitHub Actions упирается примерно в восемь параллельных классов до начала свопа.

Две распространённые крутилки:

```xml
<!-- xunit.runner.json in the test project, copy to output -->
{
  "parallelizeTestCollections": true,
  "maxParallelThreads": 4
}
```

```csharp
// or, opt-out per assembly
[assembly: CollectionBehavior(MaxParallelThreads = 4)]
```

Если вы используете атрибут `[Collection]`, чтобы делить один контейнер между несколькими классами, эти классы сериализуются. Иногда это правильный компромисс: тёплый контейнер, медленнее по wall-clock на тест, заметно меньше давление на ОЗУ.

## Что делает Ryuk и почему лучше его не выключать

Testcontainers поставляет sidecar по имени Ryuk (образ `testcontainers/ryuk`). При запуске .NET-процесса Ryuk цепляется к Docker daemon и следит за родительским процессом. Если ваш test runner упал, паникует или его убили `kill -9`, Ryuk замечает, что родителя нет, и утилизирует помеченные контейнеры. Без Ryuk упавший прогон тестов оставляет осиротевшие контейнеры SQL Server, и следующий прогон ловит конфликт портов или нехватку ОЗУ.

Ryuk включён по умолчанию. Отключение (`TESTCONTAINERS_RYUK_DISABLED=true`) иногда советуют в ограниченных CI-окружениях, но это перекладывает бремя очистки на CI. Если приходится отключать, добавьте post-job шаг, который запускает `docker container prune -f --filter "label=org.testcontainers=true"`.

## Подводные камни CI

Раннеры GitHub Actions поставляются с предустановленным Docker на Linux-раннерах (`ubuntu-latest`), но не на macOS и Windows. Зафиксируйте Linux для SQL-контейнера или платите цену `docker/setup-docker-action`. Linux-агенты Microsoft в Azure DevOps работают так же; на self-hosted Windows-агентах нужен Docker Desktop с бэкендом WSL2 и образ SQL Server, совместимый с архитектурой хоста.

Ещё одно, что кусает команды, — часовой пояс и культура. Базовый образ Ubuntu — UTC; если ваши тесты сравнивают с `DateTime.Now`, локально они проходят, а в CI падают. Используйте `DateTime.UtcNow` везде или внедрите `TimeProvider` (встроенный в .NET 8 и новее) и подавайте детерминированное время.

## Проверяем, что контейнер действительно стартовал

Если тест падает с `A network-related or instance-specific error occurred`, контейнер не успел подняться до того, как EF Core открыл соединение. У модуля MsSql Testcontainers встроена стратегия ожидания, которая опрашивает движок, пока он не ответит, поэтому такое случается, только если вы её заменили. Подтвердить можно так:

```csharp
// peek at the dynamic host port
var port = _sql.GetMappedPublicPort(MsSqlBuilder.MsSqlPort);
Console.WriteLine($"SQL is listening on localhost:{port}");
```

Стратегия ожидания использует `sqlcmd` внутри контейнера; если в вашем образе SQL Server нет `sqlcmd` (старые образы), передайте `.WithWaitStrategy(Wait.ForUnixContainer().UntilCommandIsCompleted("/opt/mssql-tools18/bin/sqlcmd", "-Q", "SELECT 1"))` для переопределения.

## Где этого уже мало

Testcontainers даёт вам настоящий SQL Server. Он не даёт Always On, шардированной маршрутизации и полнотекстового поиска по нескольким файлам. Если ваша продакшен-БД — настроенный кластер, ваши интеграционные тесты гоняются против одного узла, и в наборе остаётся известный пробел в покрытии. Зафиксируйте его и пишите более узкие, целевые тесты против staging-окружения для специфики кластера, см. [unit testing code that uses HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/) для шаблона, который обрабатывает вызовы staging-API.

Чему in-memory провайдер научил поколение .NET-команд: «работает локально» — это не сигнал к деплою. Настоящая база, настоящий порт, настоящие байты на проводе, оплачено 10 секундами холодного старта. Дешёвая страховка.

## По теме

- [How to mock DbContext without breaking change tracking](/ru/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Removing pooled DbContextFactory for cleaner test swaps in EF Core 11](/ru/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [Warm up the EF Core model before the first query](/ru/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)
- [Single-step migrations with `dotnet ef update --add` in EF Core 11](/ru/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Unit-testing code that uses HttpClient](/ru/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## Источники

- [Microsoft SQL Server module (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/modules/mssql/)
- [ASP.NET Core example (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/examples/aspnet/)
- [Testcontainers.MsSql 4.11.0 on NuGet](https://www.nuget.org/packages/Testcontainers.MsSql)
- [Choosing a testing strategy (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy)
- [Respawn package on NuGet](https://www.nuget.org/packages/Respawn)
