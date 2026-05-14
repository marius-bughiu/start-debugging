---
title: "Исправление: SqlException: Timeout expired при миграциях EF Core"
description: "Миграции используют DbContext времени проектирования, а не ваш CommandTimeout времени выполнения. Установите таймаут через UseSqlServer(o => o.CommandTimeout(...)), Command Timeout в строке подключения или Database.SetCommandTimeout перед Migrate()."
pubDate: 2026-05-14
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "migrations"
lang: "ru"
translationOf: "2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations"
translatedBy: "claude"
translationDate: 2026-05-14
---

Исправление: `dotnet ef database update` подключается через `DbContext` времени проектирования, выполняет каждый шаг миграции как одну команду и наследует стандартный `CommandTimeout` в 30 секунд от провайдера SQL Server. Длительные миграции (большие `AlterColumn`, перестроение индексов, заполнение данных) превышают 30 секунд, и SqlClient бросает `Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired`. Установите таймаут в трёх местах в этом порядке предпочтения: `o.CommandTimeout(600)` на уровне провайдера в `UseSqlServer`, `Command Timeout=600` в строке подключения, используемой во время проектирования, или применяйте миграции из вашего приложения с помощью `context.Database.SetCommandTimeout(TimeSpan.FromMinutes(10))` перед вызовом `Migrate()`. У CLI `dotnet ef database update` нет флага `--command-timeout` в EF Core 11, и именно этот факт чаще всего отнимает время при поиске причины ошибки.

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired.
The timeout period elapsed prior to completion of the operation or the server is not responding.
 ---> System.ComponentModel.Win32Exception (258): The wait operation timed out.
   at Microsoft.Data.SqlClient.SqlCommand.<>c.<ExecuteDbDataReaderAsync>b__214_0(Task`1 result)
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReader(RelationalCommandParameterObject parameterObject)
   at Microsoft.EntityFrameworkCore.Migrations.MigrationCommandExecutor.ExecuteNonQuery(IEnumerable`1 migrationCommands, IRelationalConnection connection, MigrationExecutionState executionState, Boolean commitTransaction, Nullable`1 isolationLevel)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.Design.Internal.MigrationsOperations.UpdateDatabase(String targetMigration, String connectionString, String contextType)
ClientConnectionId:7c2f9aa3-...
Error Number:-2,State:0,Class:11
```

Это руководство написано для .NET 11 preview 4, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.4, `Microsoft.Data.SqlClient` 6.0.x и `dotnet-ef` 11.0.0-preview.4. Сообщение об ошибке стабильно между версиями SqlClient, изменилось только пространство имён с `System.Data.SqlClient` на `Microsoft.Data.SqlClient`, когда провайдер сменился в EF Core 3.0. `Error Number:-2` это канонический сигнал: значение `-2` в `SqlException.Number` означает таймаут команды на стороне клиента, а не серверную ошибку. Если вы видите `Error Number:1222` или другой положительный код, это другая проблема (ожидание блокировки, ошибка входа), которую остальная часть этой статьи не решает.

## Почему миграции истекают там, где запросы времени выполнения нет

Во время миграции в игре две экземпляра `DbContext`. Тот, который ваше приложение ASP.NET Core использует во время выполнения, настроенный через `AddDbContext`, и тот, который `dotnet ef` строит во время проектирования. Это не один и тот же экземпляр, и они не обязательно разделяют конфигурацию. Инструменты миграций EF Core обнаруживают `DbContext` через один из трёх механизмов, документированных в [справочнике CLI EF Core](https://learn.microsoft.com/ru-ru/ef/core/cli/dotnet): он вызывает публичный статический `CreateHostBuilder(string[])` в вашем классе `Program`, ищет `IDesignTimeDbContextFactory<TContext>` или возвращается к запуску хоста вашего приложения, чтобы `AddDbContext` зарегистрировал контекст. В каждом пути он создаёт новый `DbContext` и использует его для миграций.

Стандартный `CommandTimeout` провайдера SQL Server это базовое значение `SqlCommand`, которое равно 30 секундам. `SetCommandTimeout`, который вы вызываете где-то в конвейере запроса, выполняется на экземпляре времени выполнения, а не на экземпляре времени проектирования. `AlterColumn`, который занимает 90 секунд, потому что таблица содержит 8 миллионов строк, в конечном итоге отправляется как одна команда через `DbCommand`, чей `CommandTimeout` равен 30, и SqlClient отменяет её через 30 секунд.

Две вещи делают это хуже, чем должно быть. Во-первых, миграция записывает свою строку в `__EFMigrationsHistory` только при успехе. Если команда истекает на полпути, вы можете получить частично применённую схему, отсутствие строки миграции и следующий `dotnet ef database update`, повторяющий ту же длинную операцию с нуля. Во-вторых, EF Core 9 и более поздние версии по умолчанию оборачивают каждую миграцию в транзакцию, если вы не отказались от этого. Когда срабатывает таймаут команды, SQL Server откатывает всю миграцию, что является более безопасным результатом, но также таким, который стоит вам ещё 30 секунд реального времени при следующей попытке.

CLI-сторона истории проста. `dotnet ef database update` принимает `--connection`, `--context`, `--project`, `--startup-project` и общие опции. `--command-timeout` нет. Команда EF Core отслеживает это как [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) уже годами; канонический ответ остаётся "настройте это в конфигурации `DbContext`."

## Минимальное воспроизведение

Достаточно таблицы с количеством строк, при котором любой `AlterColumn` займёт больше 30 секунд.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class Order
{
    public int Id { get; set; }
    public string Reference { get; set; } = "";
    public decimal Total { get; set; }
}

public class OrdersContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer(
            "Server=localhost;Database=Orders;Integrated Security=true;Encrypt=false");
}
```

Добавьте миграцию, которая расширяет `Reference` с `nvarchar(50)` до `nvarchar(450)`, чтобы SQL Server пришлось переписать каждую строку, а не делать изменение только метаданных:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public partial class WidenReference : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AlterColumn<string>(
            name: "Reference",
            table: "Orders",
            type: "nvarchar(450)",
            maxLength: 450,
            nullable: false,
            oldClrType: typeof(string),
            oldType: "nvarchar(50)",
            oldMaxLength: 50);
    }
}
```

Запустите `dotnet ef database update` против таблицы `Orders` с несколькими миллионами строк. С таймаутом по умолчанию 30 секунд команда бросает в точности ту трассировку стека, которая в начале этой статьи.

## Исправление в деталях

Выберите вариант, соответствующий тому, как миграции применяются в вашем проекте. Рейтинг ниже по поддерживаемости, а не по простоте.

### 1. Настройте CommandTimeout на провайдере в конфигурации DbContext

Это каноническое исправление. Оно прикрепляет таймаут к `DbContext`, чтобы каждый путь кода, время проектирования и время выполнения, получал одно и то же значение.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class OrdersContext : DbContext
{
    public OrdersContext(DbContextOptions<OrdersContext> options) : base(options) { }
}

// Program.cs
builder.Services.AddDbContext<OrdersContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("Orders"),
        sql => sql.CommandTimeout(600))); // 10 minutes
```

Второй аргумент `UseSqlServer` это `Action<SqlServerDbContextOptionsBuilder>`. `CommandTimeout(int seconds)` живёт в [SqlServerDbContextOptionsBuilder](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout). Он устанавливает `CommandTimeout` для каждого `DbCommand`, который EF Core создаёт на этом контексте, включая те, которые отправляет исполнитель миграций.

Если у вас есть `IDesignTimeDbContextFactory<OrdersContext>` для инструментов, настройте его и там. `dotnet ef` предпочитает `IDesignTimeDbContextFactory<T>` перед `CreateHostBuilder`, когда оба присутствуют, поэтому это переопределение вступает в силу для запусков времени проектирования:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class OrdersContextFactory : IDesignTimeDbContextFactory<OrdersContext>
{
    public OrdersContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("ORDERS_CONNECTION")
            ?? "Server=localhost;Database=Orders;Integrated Security=true;Encrypt=false";

        var options = new DbContextOptionsBuilder<OrdersContext>()
            .UseSqlServer(connectionString, sql => sql.CommandTimeout(600))
            .Options;

        return new OrdersContext(options);
    }
}
```

### 2. Поместите `Command Timeout` в строку подключения

Если вы не можете отредактировать `DbContext` (вы мигрируете чужой пакет, или обнаружение времени проектирования использует строку подключения, передаваемую CI), установите таймаут в строке подключения, и SqlClient применит его к каждой команде:

```text
Server=tcp:prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true;Command Timeout=600
```

Ключевое слово `Command Timeout` поддерживается `Microsoft.Data.SqlClient` и распространяется на `SqlCommand.CommandTimeout`. CI-конвейеры, отправляющие пакет миграции и передающие `--connection`, получают это бесплатно:

```bash
./efbundle --connection "Server=...;Command Timeout=600"
```

У исполняемого файла пакета нет собственного флага `--timeout` (см. [справочник `dotnet ef migrations bundle`](https://learn.microsoft.com/ru-ru/ef/core/cli/dotnet#dotnet-ef-migrations-bundle)). Строка подключения это единственная регулировка, которую пакет предоставляет.

### 3. Применяйте миграции из кода с помощью `SetCommandTimeout`

Если вы вызываете `context.Database.Migrate()` из вашего приложения (распространённый шаблон для самостоятельно размещаемых сервисов и интеграционных тестов), установите таймаут на живом фасаде `Database` непосредственно перед вызовом. `SetCommandTimeout` изменяет таймаут команды времени выполнения на подключении контекста:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
using var scope = app.Services.CreateScope();
var db = scope.ServiceProvider.GetRequiredService<OrdersContext>();

db.Database.SetCommandTimeout(TimeSpan.FromMinutes(10));
await db.Database.MigrateAsync();
```

`Database.SetCommandTimeout` документирован в [RelationalDatabaseFacadeExtensions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout). Он принимает `int` (секунды) или `TimeSpan`. Значение сохраняется на время жизни контекста, поэтому одной установки достаточно, чтобы покрыть полный вызов `MigrateAsync`. Это правильный шаблон для [интеграционных тестов, которые поднимают реальный SQL Server с Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), поскольку оркестратор тестов владеет применением миграции.

## Тонкости и варианты, которые поисковый трафик смешивает

### "Timeout expired" с `Error Number != -2`

Если `SqlException.Number` не `-2`, ваша проблема не таймаут команды на стороне клиента. Две наиболее распространённые альтернативы, которые приходят с тем же текстом:

- `Error Number:1222` это таймаут ожидания блокировки. Другая сессия удерживает блокировку на объекте, который вы пытаетесь изменить, и сработала настройка `LOCK_TIMEOUT` в SQL Server. Увеличение `CommandTimeout` упрётся в ту же стену; исправление в том, чтобы найти блокировщика (`sp_who2`, `sys.dm_exec_requests`).
- `Error Number:-2` с `State:0,Class:11` и `ClientConnectionId` это канонический клиентский таймаут команды SqlClient, который исправляет эта статья.

### Connection Timeout vs Command Timeout

`Connection Timeout=30` (также пишется как `Connect Timeout`) в строке подключения это то, как долго SqlClient ждёт открытия TCP-подключения. Это не влияет на то, как долго может выполняться одна команда. Если вы изменили только `Connection Timeout` и не `Command Timeout`, вы покрутили не ту ручку. Документация до EF Core 11 иногда использует эти два взаимозаменяемо в прозе; фактические имена свойств однозначны.

### Миграции, оборачивающие несколько вызовов `AlterColumn`

EF Core группирует операции одного метода `Up` в одну транзакцию по умолчанию. Таймер в 30 секунд применяется к каждому `DbCommand`, а не к каждой миграции, но один `AlterColumn` на горячей таблице легко становится длинной командой. Если у вас несколько длинных операций в одной миграции, достаточно увеличить `CommandTimeout` один раз; вам не нужно разбивать миграцию. Когда вы всё-таки хотите её разбить, [команды одношаговой миграции EF Core 11, такие как `dotnet ef migrations update --add`](/ru/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/), позволяют чище распределить работу.

### Azure SQL троттлит длинную миграцию

Если вы поднимаете таймаут до 30 минут, а миграция всё равно падает примерно через 60 секунд с тем же сообщением, вы не упираетесь в клиентский таймаут, вы упираетесь в шлюз Azure SQL. Шлюз удерживает простаивающие TCP-сессии, но может отбрасывать сессии во время failover, троттлинга или обновлений сервиса. Два смягчения: превратите операцию в онлайн-перестроение индекса с `WITH (ONLINE = ON)`, чтобы длинная блокировка разбилась на более короткие, и включите [`EnableRetryOnFailure`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.enableretryonfailure), чтобы исполнитель миграций повторил операцию по той же политике временных сбоев, которую уже использует ваше приложение:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
options.UseSqlServer(connectionString, sql =>
{
    sql.CommandTimeout(1800);              // 30 minutes
    sql.EnableRetryOnFailure(
        maxRetryCount: 3,
        maxRetryDelay: TimeSpan.FromSeconds(30),
        errorNumbersToAdd: null);
});
```

### "Работает на моей машине, падает в CI"

Две конкретные причины. Во-первых, ваш локальный SQL Server маленький, и в таблице 200 строк, поэтому `AlterColumn` завершается за 200 мс. CI работает против staging-базы данных с реальным количеством строк, где та же команда занимает минуты. Во-вторых, ваше локальное приложение использует конфигурацию `DbContext` времени выполнения с щедрым `CommandTimeout`, тогда как CI запускает `dotnet ef database update` и обнаруживает другой `DbContext` времени проектирования, в котором нет вашего переопределения. [Правила обнаружения `DbContext` времени проектирования](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) объясняют, почему CI в итоге получает контекст, отличающийся от того, который ваше приложение использует во время выполнения.

### Поведение таймаута async vs sync

`SqlException.Number == -2` срабатывает одинаково для `ExecuteNonQuery` и `ExecuteNonQueryAsync`. Переключение на `MigrateAsync` вас не спасёт, оно лишь освобождает вызывающий поток. `SetCommandTimeout` это единственная ручка, которая здесь имеет значение.

### Таблица истории миграций записана наполовину

Если команда оборвала подключение посреди работы, и вы застряли на следующем запуске, потому что EF Core думает, что миграция была применена, посмотрите в `__EFMigrationsHistory`. Если строка отсутствует, но изменение столбца применено частично, вы можете либо вручную откатить частичный DDL одной командой `ALTER` и снова запустить миграцию, либо вставить строку в `__EFMigrationsHistory` и написать последующую миграцию, которая завершит работу. Не удаляйте несвязанные строки из этой таблицы, EF Core использует их, чтобы определить, какие операции `Down()` запускать.

## Связанное

- [Исправление: dotnet ef migrations add падает с "Unable to create an object of type DbContext"](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) для вышестоящей проблемы обнаружения времени проектирования.
- [Одношаговые миграции EF Core 11 с dotnet ef migrations update --add](/ru/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/), если длинную миграцию проще разбить, чем поднимать таймаут.
- [Написание интеграционных тестов против реального SQL Server с Testcontainers](/ru/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), поскольку `Database.SetCommandTimeout` плюс `MigrateAsync` это стандартный шаблон настройки тестов.
- [Исправление: A second operation was started on this context instance](/ru/2026/05/fix-second-operation-was-started-on-this-context-instance/) для другого исключения, связанного с таймингом, которое часто ищут вместе с этим.
- [Как обнаружить запросы N+1 в EF Core 11](/ru/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) для типа регрессии времени выполнения, который создаёт такую нагрузку на базу данных, что даже маленькие миграции начинают истекать.

## Источники

- [Справочник CLI EF Core](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) - канонический список опций `dotnet ef`.
- [SqlServerDbContextOptionsBuilder.CommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout) документация API.
- [RelationalDatabaseFacadeExtensions.SetCommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout) документация API.
- [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) "Allow customizing migration commands timeout" отслеживает, почему нет CLI-флага.
- [dotnet/efcore#22887](https://github.com/dotnet/efcore/issues/22887) описывает случай пакета миграций и обходной путь через строку подключения.
