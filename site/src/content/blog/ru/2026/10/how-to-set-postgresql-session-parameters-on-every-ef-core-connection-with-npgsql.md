---
title: "Как задать параметры сеанса PostgreSQL, такие как search_path или statement_timeout, для каждого подключения EF Core с Npgsql"
description: "Однократно выполненный SET стирается командой DISCARD ALL в тот момент, когда Npgsql возвращает подключение в пул. Передайте search_path и statement_timeout в стартовом пакете через ключевые слова строки подключения Search Path и Options, а при необходимости используйте ALTER ROLE или перехватчик ConnectionOpened, и узнайте, почему UsePhysicalConnectionInitializer молча теряет свой SET."
pubDate: 2026-10-04
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "dotnet-10"
  - "how-to"
lang: "ru"
translationOf: "2026/10/how-to-set-postgresql-session-parameters-on-every-ef-core-connection-with-npgsql"
translatedBy: "claude"
translationDate: 2026-10-04
---

Короткий ответ: не выполняйте `SET statement_timeout = ...` один раз в расчёте на то, что значение сохранится. Npgsql отправляет `DISCARD ALL` при каждом повторном использовании подключения из пула, и это возвращает все настройки сеанса к значениям по умолчанию. Вместо этого передайте настройки в стартовом пакете подключения: `Search Path=tenant_a,public` для пути поиска схем и `Options=-c statement_timeout=5s -c lock_timeout=1s` для любого другого параметра. PostgreSQL считает стартовые параметры значениями сеанса по умолчанию, поэтому `DISCARD ALL` сбрасывает настройки обратно к *вашим* значениям, а EF Core не требует никакого дополнительного кода. Если вы не можете менять строку подключения, используйте `ALTER ROLE app_user SET ...` на сервере или `DbConnectionInterceptor`, который выполняет `SET` в `ConnectionOpenedAsync` (один дополнительный сетевой обмен на каждое открытие).

Всё ниже запускалось на .NET 10 (SDK 10.0.302) с `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (EF Core 10.0.4, Npgsql 10.0.3) и PostgreSQL 18.4, при включённом `log_statement=all`, чтобы каждая команда, отправленная Npgsql, попадала в журнал сервера. Приведённые результаты взяты из этих запусков.

## Почему разовый SET пропадает

Npgsql использует пул физических подключений. Когда вы освобождаете `NpgsqlConnection` (или EF Core закрывает подключение после запроса), физическое подключение возвращается в пул, и Npgsql помечает его для сброса. Сброс выполняется командой `DISCARD ALL`, которую PostgreSQL определяет как `CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; DEALLOCATE ALL; UNLISTEN *; ...`. Здесь важна часть `RESET ALL`: каждый `SET`, выполненный в этом сеансе, исчезает.

Вот минимальный пример. Пул ограничен одним подключением, поэтому второе открытие гарантированно получает тот же физический сеанс:

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Maximum Pool Size=1");

int pid1, pid2;
await using (var c = await ds.OpenConnectionAsync())
{
    pid1 = c.ProcessID;
    await new NpgsqlCommand("SET search_path = tenant_a; SET statement_timeout = '1s'", c)
        .ExecuteNonQueryAsync();
}
await using (var c = await ds.OpenConnectionAsync())
{
    pid2 = c.ProcessID;
    // same physical=True search_path="$user", public statement_timeout=0
}
```

Тот же серверный процесс, и обе настройки вернулись к значениям сервера по умолчанию. Журнал сервера показывает почему:

```text
[95652] execute <unnamed>: SET search_path = tenant_a
[95652] execute <unnamed>: SET statement_timeout = '1s'
[95652] statement: DISCARD ALL
[95652] execute <unnamed>: SHOW search_path
```

Обратите внимание, что `DISCARD ALL` не отправляется при закрытии подключения. Npgsql откладывает его и записывает перед следующей командой на этом физическом подключении, поэтому дополнительного сетевого обмена не возникает. Он также выполняется независимо от того, меняли ли вы что-нибудь, так что избежать его аккуратностью нельзя.

С EF Core это бьёт сильнее, чем с чистым ADO.NET, потому что EF Core открывает и закрывает подключение вокруг каждой операции. `DbContext`, который выполняет запрос, а затем вызов `SqlQueryRaw`, открывает подключение дважды, и каждое открытие может попасть на свежесброшенный сеанс.

## Вариант 1: ключевое слово Search Path в строке подключения

Именно для пути поиска схем в Npgsql есть отдельное ключевое слово. Оно отправляется как стартовый параметр, а не как `SET`:

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Search Path=tenant_a,public");

await using var c = await ds.OpenConnectionAsync();
// SHOW search_path            -> tenant_a,public
// SELECT count(*) FROM orders -> 1 (resolves to tenant_a.orders)
```

В журнале сервера для этого подключения вообще нет `SET`. Значение передаётся в стартовом пакете, и PostgreSQL использует его как значение сеанса по умолчанию.

## Вариант 2: Options=-c для любого другого параметра

Ключевое слово `Options` передаётся как стартовый параметр PostgreSQL `options`, который принимает тот же синтаксис `-c name=value`, что и командная строка `postgres`. Это покрывает `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `work_mem`, `search_path` и всё остальное, что обычному пользователю разрешено менять через `SET`:

```csharp
// .NET 10, Npgsql 10.0.3
var cs = "Host=localhost;Port=55432;Username=postgres;Database=postgres;" +
         "Options=-c statement_timeout=2s -c search_path=tenant_a,public -c lock_timeout=500ms";
var ds = NpgsqlDataSource.Create(cs);

await using (var c = await ds.OpenConnectionAsync())
{
    // statement_timeout=2s search_path=tenant_a,public lock_timeout=500ms
    await new NpgsqlCommand("SET statement_timeout = '9s'", c).ExecuteNonQueryAsync();
    // statement_timeout=9s
}
await using (var c = await ds.OpenConnectionAsync())
{
    // statement_timeout=2s   <- DISCARD ALL reset it to the startup value, not to 0
}
```

Именно это свойство делает стартовый пакет правильным местом. `RESET ALL` возвращает каждый параметр к значению, которое он имел бы, если бы в этом сеансе не выполнялся ни один `SET`, а для стартового параметра это значение, которое вы передали. Поэтому запрос, временно увеличивший тайм-аут, не может передать его следующему запросу, и следующий запрос по-прежнему получает ваше значение по умолчанию, а не серверное.

Если вы собираете строки подключения в коде, используйте `NpgsqlConnectionStringBuilder`, чтобы экранирование выполнялось автоматически. Значение `Options` с пробелами берётся в кавычки:

```csharp
// .NET 10, Npgsql 10.0.3
var csb = new NpgsqlConnectionStringBuilder("Host=localhost;Port=55432;Username=postgres;Database=sp_demo")
{
    SearchPath = "tenant_b,public",
    Options = "-c statement_timeout=5s -c lock_timeout=1s",
    ApplicationName = "orders-api",
};
// Host=localhost;Port=55432;Username=postgres;Database=sp_demo;Search Path=tenant_b,public;
// Options="-c statement_timeout=5s -c lock_timeout=1s";Application Name=orders-api
```

## Подключение к EF Core

Поскольку настройки живут в строке подключения, EF Core не требует ничего особенного. Передайте строку в `UseNpgsql` или зарегистрируйте `NpgsqlDataSource` и передайте его:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(
    builder.Configuration.GetConnectionString("Orders")));

// appsettings.json
// "ConnectionStrings": {
//   "Orders": "Host=db;Database=orders;Username=app;Search Path=tenant_b,public;Options=-c statement_timeout=5s -c lock_timeout=1s"
// }
```

Запрос через этот контекст подтверждает, что тайм-аут действует на каждом подключении, которое открывает EF Core:

```csharp
var st = await db.Database
    .SqlQueryRaw<string>("SELECT current_setting('statement_timeout') AS \"Value\"")
    .SingleAsync();
// 5s
```

Когда тайм-аут срабатывает, PostgreSQL отменяет команду на сервере, и вы получаете `PostgresException` с `SqlState` `57014` и сообщением `canceling statement due to statement timeout`. Подключение остаётся открытым и пригодным к использованию. Это отличается от собственного `Command Timeout` в Npgsql (по умолчанию 30 секунд), который контролируется клиентом: по его истечении Npgsql отменяет запрос и выбрасывает `NpgsqlException` с вложенным `TimeoutException`, без `SqlState`. Держите `Command Timeout` немного выше `statement_timeout`, чтобы срабатывал серверный лимит: он даёт чистую ошибку и не зависит от того, заметит ли клиент превышение.

## Вариант 3: ALTER ROLE или ALTER DATABASE на сервере

Если строка подключения принадлежит кому-то другому (платформенной команде, хранилищу секретов, которое вы не можете менять под каждое приложение), перенесите значения по умолчанию на сервер:

```sql
-- PostgreSQL 18
ALTER ROLE app_user SET search_path = tenant_a, public;
ALTER ROLE app_user SET statement_timeout = '15s';

-- or scoped to one database
ALTER ROLE app_user IN DATABASE orders SET statement_timeout = '15s';
```

Новое подключение от имени `app_user` получило `search_path=tenant_a, public` и `statement_timeout=15s` без какой-либо настройки на стороне клиента. Эти значения роли тоже переживают `DISCARD ALL`, так как входят в начальное состояние сеанса.

При сочетании подходов важен приоритет. Та же роль с `Options=-c statement_timeout=3s` получила `3s`: стартовые параметры переопределяют значения роли и базы данных, которые, в свою очередь, переопределяют `postgresql.conf`. Это даёт удобное разделение на уровни: консервативное значение по умолчанию на роли и переопределение для конкретного приложения в строке подключения там, где сервису законно нужны более долгие запросы (задача отчётности, исполнитель миграций).

Не задавайте `statement_timeout` глобально в `postgresql.conf`. Документация PostgreSQL предостерегает от этого, потому что значение применяется и к служебным сеансам, `pg_dump` и вашим собственным сеансам `psql`.

## Вариант 4: DbConnectionInterceptor, который выполняет SET при каждом открытии

Иногда значение не статично. Мультитенантное приложение, выбирающее схему на каждый запрос, или настройка, зависящая от текущего пользователя, не могут жить в фиксированной строке подключения. [Перехватчики](/ru/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) EF Core дают точку расширения, которая срабатывает сразу после каждого открытия:

```csharp
// .NET 10, EF Core 10.0.4
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class SessionSettingsInterceptor : DbConnectionInterceptor
{
    const string Sql = "SET statement_timeout = '5s'; SET lock_timeout = '1s'";

    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        cmd.ExecuteNonQuery();
    }

    public override async Task ConnectionOpenedAsync(
        DbConnection connection, ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }
}

// registration
builder.Services.AddDbContext<AppDbContext>(o => o
    .UseNpgsql(connectionString)
    .AddInterceptors(new SessionSettingsInterceptor()));
```

Переопределите и синхронный, и асинхронный методы. EF Core вызывает тот, который соответствует использованному вами API, и если забыть синхронный, `db.Orders.Count()` молча выполнится без ваших настроек.

Это работает, а журнал точно показывает, чего это стоит. Два экземпляра `DbContext`, каждый из которых выполнил один запрос LINQ и один запрос на чистом SQL, дали четыре открытия и четыре пары `SET`:

```text
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT count(*)::int ...
[95655] statement: DISCARD ALL
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT s."Value" ...
```

Каждое открытие платит одним дополнительным сетевым обменом. На локальном сокете это шум, но с управляемой базой данных в другой зоне доступности он может быть того же порядка, что и сам запрос. Для статичных значений варианты с 1 по 3 строго лучше. Для значений, зависящих от запроса, подумайте, действительно ли параметр должен действовать на весь сеанс, или достаточно `SET LOCAL` внутри транзакции, которую вы и так выполняете.

## Ловушка: UsePhysicalConnectionInitializer

`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer` выглядит очевидным решением. Он один раз вызывает обратный вызов при первом создании физического подключения, что звучит как "один раз на сеанс, без накладных расходов на каждое открытие". Вот что происходит на самом деле:

```csharp
// .NET 10, Npgsql 10.0.3
var b = new NpgsqlDataSourceBuilder(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Maximum Pool Size=1");
b.UsePhysicalConnectionInitializer(
    conn => { using var cmd = new NpgsqlCommand("SET statement_timeout = '4s'", conn); cmd.ExecuteNonQuery(); },
    async conn => { await using var cmd = new NpgsqlCommand("SET statement_timeout = '4s'", conn); await cmd.ExecuteNonQueryAsync(); });
var ds = b.Build();

// open 0: statement_timeout=4s inits=1
// open 1: statement_timeout=0  inits=1
// open 2: statement_timeout=0  inits=1
```

Инициализатор выполняется один раз, как и обещано, и первое открытие видит `4s`. Затем подключение возвращается в пул, `DISCARD ALL` стирает `SET`, а инициализатор больше не запускается, потому что физическое подключение уже существует. Каждый запрос после первого выполняется без тайм-аута. Собственная XML-документация Npgsql к этому методу предупреждает об этом: настройки, применённые там, откатываются командой `DISCARD ALL`, если не отключить сброс.

Решение: сочетать его с `No Reset On Close=true`. В EF Core `ConfigureDataSource` позволяет добраться до построителя, не покидая `UseNpgsql`:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
options.UseNpgsql(
    "Host=localhost;Port=55432;Username=postgres;Database=sp_demo;No Reset On Close=true",
    o => o.ConfigureDataSource(ds => ds.UsePhysicalConnectionInitializer(
        conn => { using var cmd = new NpgsqlCommand("SET search_path = tenant_b, public", conn); cmd.ExecuteNonQuery(); },
        async conn => { await using var cmd = new NpgsqlCommand("SET search_path = tenant_b, public", conn); await cmd.ExecuteNonQueryAsync(); })));

// ctx 0: widgets=1 search_path=tenant_b, public inits=1
// ctx 1: widgets=1 search_path=tenant_b, public inits=1
// ctx 2: widgets=1 search_path=tenant_b, public inits=1
```

Один `SET`, ни одного `DISCARD ALL` в журнале, и настройка сохраняется между контекстами. Цена в том, что *ничего* больше не сбрасывается. Если какой-либо путь кода выполняет `SET` (вспомогательная функция миграции, диагностический запрос, библиотека), это значение теперь утекает ко всем последующим пользователям этого физического подключения, вместе с временными таблицами и регистрациями `LISTEN`. Используйте эту комбинацию только тогда, когда вы контролируете каждую команду, выполняемую в пуле. Если вам нужно лишь статичное значение, строка подключения проще и безопаснее.

## Переопределения для отдельных запросов через SET LOCAL

Чтобы увеличить тайм-аут для одной заведомо медленной операции, менять сеанс вообще не нужно. `SET LOCAL` действует до конца текущей транзакции:

```csharp
// .NET 10, EF Core 10.0.4
await using var tx = await db.Database.BeginTransactionAsync();
await db.Database.ExecuteSqlRawAsync("SET LOCAL statement_timeout = '60s'");
await db.Database.ExecuteSqlRawAsync("REFRESH MATERIALIZED VIEW sales_summary");
await tx.CommitAsync();
// after commit: statement_timeout is back to the session default
```

В пробном запуске `SHOW statement_timeout` вернул `100ms` внутри транзакции и `0` сразу после фиксации, на том же подключении, без необходимости в `DISCARD ALL`. Это также единственный подход, который работает через PgBouncer в режиме транзакций, о чём речь ниже.

## Подводные камни: пулеры, миграции и тайм-ауты

**PgBouncer отклоняет неизвестные стартовые параметры.** По умолчанию PgBouncer принимает только те стартовые параметры, которые он отслеживает, и выдаёт ошибку для всех остальных, включая `options`. Вы либо добавляете `options` в `ignore_startup_parameters` (и тогда PgBouncer молча отбрасывает ваши настройки), либо переносите значения по умолчанию в `ALTER ROLE`. PostgreSQL 18 сообщает `search_path` обратно клиенту, поэтому PgBouncer отслеживает его из коробки на 18. В режиме транзакций или команд документация Npgsql также советует задать `No Reset On Close=true`, потому что `DISCARD ALL` теряет смысл, когда PgBouncer может передать следующую транзакцию другому серверному процессу. В этом режиме любой `SET` вне транзакции фактически случаен, поэтому используйте `SET LOCAL` или значения роли по умолчанию.

**search_path определяет, где создаются неквалифицированные таблицы.** При `Search Path=tenant_b,public` и без `HasDefaultSchema` метод `EnsureCreatedAsync` создал `Widgets` в `tenant_b`. Провайдер Npgsql создаёт `__EFMigrationsHistory` через `CREATE TABLE IF NOT EXISTS` тоже без указания схемы, поэтому исполнитель миграций, у которого в строке подключения другой `search_path`, чем у приложения, создаст вторую таблицу истории и попытается заново выполнить все миграции. Либо зафиксируйте схему в модели (`modelBuilder.HasDefaultSchema("tenant_b")` и `MigrationsHistoryTable("__EFMigrationsHistory", "tenant_b")`), либо убедитесь, что исполнитель использует в точности ту же строку подключения. Также учтите, что `EnsureCreated` проверяет, есть ли в базе данных *какие-либо* пользовательские таблицы, а не только в вашем пути поиска: в базе, где уже была `tenant_a.orders`, создание было пропущено целиком, и первая вставка завершилась ошибкой `42P01: relation "Widgets" does not exist`.

**Миграциям нужен собственный тайм-аут.** `statement_timeout` в 5 секунд в общей строке подключения убьёт долгий `CREATE INDEX` во время развёртывания. Дайте исполнителю миграций собственную строку подключения с `Options=-c statement_timeout=0` (стартовые параметры побеждают значения роли по умолчанию), а о клиентской половине проблемы читайте в [руководстве по тайм-аутам миграций EF Core](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

**lock_timeout обычно тот, что вам действительно нужен.** Запрос, застрявший за блокировкой, это типичный инцидент в продакшене, а `statement_timeout` ловит его только после исчерпания всего бюджета. `lock_timeout=1s` быстро завершается ошибкой `55P03`, позволяя при этом выполняться законно долгим запросам. В PostgreSQL 17 добавили и `transaction_timeout`, который ограничивает всю транзакцию, а не каждую команду.

**Некоторые параметры так задать нельзя.** Параметры всего сервера отклоняются в `options`: `-c shared_buffers=1GB` завершается ошибкой `55P02 parameter "shared_buffers" cannot be changed without restarting the server`, а параметр `sighup`, такой как `log_checkpoints`, завершается ошибкой `55P02 ... cannot be changed now`. Параметры только для суперпользователя не проходят для обычной роли: `-c log_statement=none` от имени `app_user` дал `42501 permission denied to set parameter "log_statement"`. Во всех случаях `OpenAsync` выбрасывает исключение, так что вы узнаете об этом на первом же запросе, а не будете молча работать с неверными настройками.

## Выбор подхода

Для фиксированного значения используйте строку подключения: `Search Path` для схем, `Options=-c ...` для всего остального. Это ничего не стоит при открытии, переживает сброс пула и работает одинаково для EF Core, Dapper и чистого Npgsql. Используйте `ALTER ROLE ... SET`, когда строка подключения не ваша, или как страховочную сетку под ней. Обращайтесь к перехватчику `ConnectionOpened` только тогда, когда значение зависит от состояния во время выполнения, и смиритесь с дополнительным сетевым обменом. `UsePhysicalConnectionInitializer` с `No Reset On Close=true` это нишевый инструмент для пулов, где вы контролируете каждую команду.

### Читайте дальше

- [What is an EF Core interceptor and when do I need one?](/ru/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) объясняет конвейер перехватчиков, в который встраивается подход с `ConnectionOpened`.
- [How to use EF Core 11 interceptors for auditing](/ru/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) показывает перехватчик `SaveChanges` от начала до конца.
- [How to use named query filters for soft delete and multi-tenancy in EF Core 11](/ru/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) это построчная альтернатива переключению `search_path` в схеме на каждого арендатора.
- [How to log the SQL that EF Core 11 generates](/ru/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) помогает подтвердить со стороны клиента, что именно доходит до сервера.
- [How to atomically append to a PostgreSQL jsonb array with EF Core and Npgsql](/ru/2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql/) это ещё один специфичный для Npgsql приём, проверенный на PostgreSQL 18.

### Источники

- [Connection String Parameters](https://www.npgsql.org/doc/connection-string-parameters.html), документация Npgsql (`Search Path`, `Options`, `No Reset On Close`, `Command Timeout`)
- [Compatibility notes: pgbouncer](https://www.npgsql.org/doc/compatibility.html), документация Npgsql
- [`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer`](https://github.com/npgsql/npgsql/blob/main/src/Npgsql/NpgsqlDataSourceBuilder.cs), npgsql/npgsql (XML-примечания о `DISCARD ALL`)
- [`NpgsqlHistoryRepository.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Migrations/Internal/NpgsqlHistoryRepository.cs), npgsql/efcore.pg
- [DISCARD](https://www.postgresql.org/docs/current/sql-discard.html), документация PostgreSQL
- [Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html), документация PostgreSQL (`statement_timeout`, `lock_timeout`, `transaction_timeout`, `search_path`)
- [ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html), документация PostgreSQL
- [Connection interception](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors#connection-interception), документация EF Core
- [PgBouncer configuration](https://www.pgbouncer.org/config.html) (`track_extra_parameters`, `ignore_startup_parameters`)
