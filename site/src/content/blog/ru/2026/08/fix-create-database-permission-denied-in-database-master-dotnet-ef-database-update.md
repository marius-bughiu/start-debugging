---
title: "Исправление: CREATE DATABASE permission denied in database 'master' при запуске dotnet ef database update"
description: "Migrate() в EF Core всегда проверяет наличие базы данных и создаёт её через жёстко зашитое подключение к master. Выдайте CREATE ANY DATABASE, почините доступ логина к существующей базе или выпускайте идемпотентный SQL-скрипт."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
lang: "ru"
translationOf: "2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update"
translatedBy: "claude"
translationDate: 2026-08-30
---

`dotnet ef database update` пытается создать вашу базу данных вовсе не потому, что вы его об этом просили. Каждый вызов `Migrate()` начинается с `if (!_databaseCreator.Exists()) _databaseCreator.Create()`, и переключателя, который бы это отключил, не существует. Значит, либо ваш логин действительно не может создавать базы данных (выдайте ему `CREATE ANY DATABASE` в `master` или добавьте его в `##MS_DatabaseManager##`), либо база уже существует, а логин не может её открыть, что EF Core ошибочно трактует как "не существует". Второй случай проверяйте первым: `SELECT DB_ID('YourDb')` под `sa`, затем `SELECT DB_ID('YourDb')` под логином миграций. Если первый запрос вернул число, а второй `NULL`, лечится это пользователем базы данных, а не серверным разрешением. В продакшене вообще не запускайте `Migrate()` под привилегированным логином, а отдайте администратору баз данных вывод `dotnet ef migrations script --idempotent`, в котором нет ни одного `CREATE DATABASE`.

Всё изложенное ниже проверено на `Microsoft.EntityFrameworkCore.SqlServer` 10.0.11 и CLI `dotnet-ef` 10.0.11 поверх .NET SDK 10.0.302. Приведённые здесь участки кода `Migrator.Migrate` и `SqlServerDatabaseCreator` не менялись в EF Core 8, 9, 10 и 11, поэтому и поведение, и все способы исправления применимы ко всем четырём версиям. Там, где утверждение взято из документации SQL Server, а не из запуска на этой машине, я об этом говорю.

## Ошибка в контексте

```text
Build started...
Build succeeded.
Microsoft.Data.SqlClient.SqlException (0x80131904): CREATE DATABASE permission denied in database 'master'.
   at Microsoft.Data.SqlClient.SqlConnection.OnError(SqlException exception, Boolean breakConnection, Action`1 wrapCloseInAction)
   ...
   at Microsoft.EntityFrameworkCore.Migrations.Internal.MigrationCommandExecutor.ExecuteNonQuery(...)
   at Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerDatabaseCreator.Create()
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
ClientConnectionId:...
Error Number:262,State:1,Class:14
CREATE DATABASE permission denied in database 'master'.
```

Этот стек собран из приведённой ниже цепочки вызовов EF Core, а не снят на этой машине, где нет экземпляра SQL Server; имена кадров и номера ошибок взяты из опубликованных исходников и из документированных ошибок SQL Server. Важны два кадра стека. `SqlServerDatabaseCreator.Create()` говорит, что EF решил, будто база отсутствует. `Error Number:262` это ошибка разрешений SQL Server, а не ошибка подключения, то есть логин прошёл аутентификацию и дошёл до выполнения инструкции.

## Почему dotnet ef database update вообще трогает master

Ни в вашем `Program.cs`, ни в строке подключения `master` не упоминается. Его подставляет EF. Нужный код это первое, что делает `Migrate()`, в [`Migrator.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs):

```csharp
// Microsoft.EntityFrameworkCore.Relational 10.0.11, Migrator.Migrate
if (!_databaseCreator.Exists())
{
    _databaseCreator.Create();
}
```

Нет ни опции, ни флага `DbContextOptionsBuilder`, ни переменной окружения, которая бы это пропустила. `dotnet ef database update` проходит ровно через этот метод, и то же самое делают `context.Database.Migrate()` при старте приложения и бандл миграций, собранный командой `dotnet ef migrations bundle`.

Далее `Create()` строит собственное подключение. Из [`SqlServerConnection.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs):

```csharp
// Microsoft.EntityFrameworkCore.SqlServer 10.0.11
public virtual ISqlServerConnection CreateMasterConnection()
{
    var connectionStringBuilder = new SqlConnectionStringBuilder(GetValidatedConnectionString())
        { InitialCatalog = "master" };
    connectionStringBuilder.Remove("AttachDBFilename");
    ...
}
```

`InitialCatalog = "master"` зашит в код. Отсюда и берётся `in database 'master'` в сообщении. По этому подключению EF выполняет T-SQL, который его собственный генератор выдаёт для `SqlServerCreateDatabaseOperation`:

```sql
-- what EF Core 10.0.11 sends on the master connection
CREATE DATABASE [Shop];
GO
IF SERVERPROPERTY('EngineEdition') <> 5
BEGIN
    ALTER DATABASE [Shop] SET READ_COMMITTED_SNAPSHOT ON;
END;
```

Ошибка оказывается именно про *разрешения*, а не про *логин*, потому что открыть `master` может любой логин SQL Server. Разрешение `CONNECT` у пользователя `guest` можно отозвать "в любой базе данных, кроме `master` и `tempdb`", как сказано в [документации о субъектах безопасности](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine). Поэтому EF успешно подключается и спотыкается уже на самой инструкции.

## Проверка существования устроена грубее, чем кажется

Вот та часть, которая уводит большинство не туда. `SqlServerDatabaseCreator.Exists()` не обращается к `sys.databases`. Он открывает подключение к целевой базе и выполняет `SELECT 1`, а три номера `SqlException` считает доказательством того, что базы нет:

```csharp
// Microsoft.EntityFrameworkCore.SqlServer 10.0.11
private static bool IsDoesNotExist(SqlException exception)
    => exception.Number is 4060 or 1832 or 5120;
```

Ошибка 4060 это `Cannot open database "Shop" requested by the login. The login failed.` SQL Server поднимает её и когда базы нет, **и** когда у логина нет сопоставленного пользователя в существующей базе, и когда база отключена, восстанавливается или находится в режиме `SINGLE_USER`. Различить эти случаи EF не может, поэтому решает, что базы нет, и идёт её создавать. В итоге вы получаете ошибку 262 про `master`, хотя реальная проблема это отсутствующий `CREATE USER` в `Shop`.

Разделите эти два случая, прежде чем трогать хоть одно разрешение. Подключитесь администратором и выполните:

```sql
-- as sa or a sysadmin
SELECT DB_ID('Shop') AS db_id, state_desc, user_access_desc
FROM sys.databases WHERE name = 'Shop';
```

Затем подключитесь ровно с теми учётными данными, что стоят в строке подключения миграций, и выполните:

```sql
-- as the migration login
SELECT DB_ID('Shop') AS visible_to_me;
```

Строка в первом запросе плюс `NULL` во втором означают, что база существует, а ваш логин её не видит. Это следующий раздел. Пустой результат первого запроса означает, что базы действительно нет, и это раздел после следующего.

## Способ 1: база существует, логин не может её открыть

Такая картина типична для CI и для только что восстановленных окружений: кто-то развернул `.bak` или создал базу скриптом, серверный логин есть, а соответствующего пользователя базы нет, либо он осиротел по SID после восстановления.

```sql
-- SQL Server 2019+ / Azure SQL MI; run in the target database
USE [Shop];
GO
CREATE USER [app] FOR LOGIN [app];
ALTER ROLE db_ddladmin ADD MEMBER [app];   -- schema changes
ALTER ROLE db_datareader ADD MEMBER [app];
ALTER ROLE db_datawriter ADD MEMBER [app];
GO
```

Если пользователь уже есть, но осиротел после восстановления, перепривяжите его к логину вместо пересоздания:

```sql
USE [Shop];
GO
ALTER USER [app] WITH LOGIN = [app];
GO
```

`db_ddladmin` это ровно то, что нужно миграциям: `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX` и таблица `__EFMigrationsHistory`, которую EF создаёт при первом запуске. `db_owner` тоже работает и именно к нему тянется большинство, но он даёт больше, чем миграциям требуется.

Два варианта дают 4060 по причинам, которые пользователем базы не лечатся. Если `state_desc` не `ONLINE`, переведите базу в оперативный режим. Если `user_access_desc` равен `SINGLE_USER`, выполните `ALTER DATABASE [Shop] SET MULTI_USER;`. Иначе в обоих случаях EF продолжит пытаться создать базу, которая уже стоит прямо перед ним.

## Способ 2: базы действительно нет и вы хотите, чтобы её создал EF

Это правильное решение для машины разработчика, одноразового контейнера в CI и любого окружения, где логину миграций позволено владеть своей базой.

Наименее привилегированный вариант на SQL Server 2022 (16.x) и новее, а также в Azure SQL Database, это фиксированная серверная роль `##MS_DatabaseManager##`. Согласно [документации о серверных ролях](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles), её участники могут "create databases, and delete databases they own", и она несёт серверные разрешения `CREATE ANY DATABASE` и `ALTER ANY DATABASE`:

```sql
-- SQL Server 2022 (16.x)+ and Azure SQL Database
ALTER SERVER ROLE [##MS_DatabaseManager##] ADD MEMBER [app];
```

На SQL Server 2019 (15.x) и старше такой роли нет, поэтому выдавайте серверное разрешение напрямую. Этот вариант предпочтительнее `dbcreator`, потому что участники `dbcreator` могут "create, alter, drop, and restore **any** database", включая те, до которых вашей миграции нет никакого дела:

```sql
-- SQL Server 2016 (13.x) and later, including 2019 (15.x) where no role exists
USE master;
GO
GRANT CREATE ANY DATABASE TO [app];
GO
```

`CREATE DATABASE` и `CREATE ANY DATABASE` не взаимозаменяемы, и путаница между ними это распространённый второй провал. `CREATE DATABASE` это разрешение *уровня базы данных* в `master`, поэтому выдать его можно только пользователю базы данных, а значит логину сначала нужен пользователь в `master`:

```sql
-- the CREATE DATABASE variant needs a user in master
USE master;
GO
CREATE USER [app] FOR LOGIN [app];
GRANT CREATE DATABASE TO [app];
GO
```

`CREATE ANY DATABASE` имеет серверную область действия и выдаётся самому логину, поэтому пользователь в `master` ему не нужен. [Документация CREATE DATABASE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) называет достаточными `CREATE DATABASE`, `CREATE ANY DATABASE` или `ALTER ANY DATABASE`.

В Azure SQL Database более старый путь это роль базы данных `dbmanager` в `master`, которую документация до сих пор перечисляет как допустимого субъекта для `CREATE DATABASE`:

```sql
-- Azure SQL Database, connected to master
CREATE USER [app] FROM LOGIN [app];
ALTER ROLE dbmanager ADD MEMBER [app];
GO
```

В Azure с этим стоит быть осторожнее. EF отправляет голый `CREATE DATABASE [Shop];` без `EDITION` и без `SERVICE_OBJECTIVE`, поэтому сервер выбирает уровень по умолчанию и начинает его тарифицировать. Ровно об этом говорится в [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251), "EF Core automatically creates expensive database when executing migrations", который команда закрыла как не запланированный. Не выдавайте права на создание баз логину развёртывания, направленному на сервер Azure SQL, если вас не устраивает, что опечатка в имени базы развернёт новую платную базу данных.

## Способ 3: убрать шаг создания из развёртывания целиком

Если логин намеренно лишён привилегий, никакие выданные разрешения не будут правильным ответом. Перестаньте запускать `Migrate()` в этом окружении и применяйте SQL. Сгенерированный скрипт никогда не содержит `CREATE DATABASE`, потому что генератор скриптов работает только с миграциями и никогда не обращается к `IRelationalDatabaseCreator`:

```bash
dotnet ef migrations script --idempotent --output migrate.sql
```

На EF Core 10.0.11 для одной начальной миграции получается ровно это:

```sql
IF OBJECT_ID(N'[__EFMigrationsHistory]') IS NULL
BEGIN
    CREATE TABLE [__EFMigrationsHistory] (
        [MigrationId] nvarchar(150) NOT NULL,
        [ProductVersion] nvarchar(32) NOT NULL,
        CONSTRAINT [PK___EFMigrationsHistory] PRIMARY KEY ([MigrationId])
    );
END;
GO

BEGIN TRANSACTION;
IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260830061302_InitialCreate'
)
BEGIN
    CREATE TABLE [Customers] (
        [Id] int NOT NULL IDENTITY,
        [Name] nvarchar(max) NOT NULL,
        CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
    );
END;
...
COMMIT;
GO
```

Ни одного упоминания `master`. Флаг `--idempotent` делает скрипт безопасным для применения к базе на любом уровне миграций, а это именно то, что нужно, когда его применяет вручную администратор баз данных. Команда EF пишет об этом в [документации о применении миграций](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying): `dotnet ef database update` "applies SQL commands directly by the tool, without giving the developer a chance to inspect or modify them", а документация прямо отмечает, что вызов `Migrate()` при старте "requires elevated access to modify the database schema", что конфликтует с принципом наименьших привилегий в продакшене.

Схема работы становится такой: создать базу один раз, вручную или через Terraform либо Bicep, выдать логину приложения `db_ddladmin` внутри неё и применять `migrate.sql` в релизном конвейере. Логину приложения не нужно ни одно разрешение в `master`.

## Бандлы миграций от этого не спасают

Распространённое заблуждение состоит в том, что `dotnet ef migrations bundle` обходит проблему, раз это самостоятельный исполняемый файл без зависимости от SDK. Не обходит. Бандл вызывает `Migrate()`, а значит проходит ту же пару `Exists()`/`Create()` и падает с той же ошибкой 262 под непривилегированным логином. Бандлы решают проблему "на агенте развёртывания нет SDK", а не проблему разрешений. Если целевое окружение запрещает `CREATE DATABASE`, бандлам нужно то же лечение, что и CLI: сначала сделать базу существующей, а логин способным её открыть. Механика такого конвейера описана в [применении миграций EF Core 11 в продакшене через dotnet ef migrations bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Похожие по виду, но другие ошибки

**`CREATE TABLE permission denied in database 'master'.`** Тот же номер ошибки, другая инструкция. Здесь в строке подключения вообще нет ни `Database=`, ни `Initial Catalog=`, поэтому SQL Server поместил вас в базу по умолчанию для логина, а у `sa` это `master`. EF ничего не создаёт, он выполняет вашу миграцию в `master`. Добавьте базу в строку подключения.

**`EnsureCreated()` вместо миграций.** `Database.EnsureCreated()` даёт точно такую же ошибку по точно такой же причине, и это хуже: он создаёт схему без таблицы `__EFMigrationsHistory`, поэтому применить миграции к такой базе потом уже невозможно. Если вы нашли вызов `EnsureCreated()` в `Program.cs` рядом с папкой миграций, удалите его.

**LocalDB.** `(localdb)\MSSQLLocalDB` работает под вашей учётной записью Windows, которой принадлежит экземпляр, поэтому 262 там почти всегда означает, что вы подключены к общему экземпляру или к настоящему SQL Server, который приняли за LocalDB. Проверьте имя сервера в той строке подключения, которую инструмент реально загрузил, командой `dotnet ef database update -v`.

**Таймаут, похожий на отказ в правах.** Если в сообщении `Execution Timeout Expired`, а не ошибка 262, с логином всё в порядке, а медленная сама миграция. Это другая проблема, разобранная в [SqlException: Timeout expired во время миграций EF Core](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

**Подключения нет вовсе.** Если `dotnet ef` вообще не доходит до SQL Server, вы увидите `Unable to create an object of type 'DbContext'`, а это сбой обнаружения на этапе проектирования, а не разрешений. Об этом написано в [dotnet ef migrations add падает с "Unable to create an object of type DbContext"](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

Общий вывод в том, что конвейер миграций EF Core проектировался под внутренний цикл разработчика, где владение собственной базой это норма, а шаг автоматического создания так и не сделали необязательным. [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839), где просили именно об этом, чтобы приложению-мигратору не требовались права на создание баз, закрыт как не запланированный. Относитесь к `Migrate()` как к удобству разработки, а к SQL-скриптам как к механизму развёртывания, и ошибка 262 перестанет быть тем, на что можно наткнуться в продакшене.

## Связанные материалы

- [Как применять миграции EF Core 11 в продакшене через dotnet ef migrations bundle](/ru/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Исправление: SqlException: Timeout expired во время миграций EF Core](/ru/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Исправление: dotnet ef migrations add падает с "Unable to create an object of type DbContext"](/ru/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Исправление: dotnet tool install --global dotnet-ef выдаёт ошибку](/ru/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [Как переименовать таблицу в миграции EF Core 11 без потери данных](/ru/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)

## Источники

- [Migrator.cs, `Migrate(string? targetMigration)`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) - безусловная пара `Exists()`/`Create()`
- [SqlServerDatabaseCreator.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) - `IsDoesNotExist` и проверка существования через `SELECT 1`
- [SqlServerConnection.cs, `CreateMasterConnection`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs) - зашитый в код `InitialCatalog = "master"`
- [CREATE DATABASE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) - необходимые разрешения в SQL Server и Azure SQL Database
- [Server-level roles](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles) - `##MS_DatabaseManager##` и `dbcreator`
- [Principals (Database Engine)](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine) - почему `guest` нельзя отозвать в `master`
- [Applying migrations - EF Core](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) - скрипты, бандлы и предупреждение о наименьших привилегиях
- [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839) - "Database Migrate fails to execute for manually created database", закрыт как не запланированный
- [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251) - "EF Core automatically creates expensive database when executing migrations", закрыт как не запланированный
