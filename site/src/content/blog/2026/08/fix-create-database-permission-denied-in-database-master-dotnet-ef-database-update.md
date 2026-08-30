---
title: "Fix: CREATE DATABASE permission denied in database 'master' when running dotnet ef database update"
description: "EF Core's Migrate() always checks whether the database exists and creates it if not, from a hardcoded master connection. Grant CREATE ANY DATABASE, fix the login's access to the existing database, or ship an idempotent SQL script instead."
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
---

`dotnet ef database update` is not trying to create your database because you asked it to. Every call to `Migrate()` starts with `if (!_databaseCreator.Exists()) _databaseCreator.Create()`, and there is no switch to turn that off. So either your login genuinely cannot create databases (grant it `CREATE ANY DATABASE` in `master`, or add it to `##MS_DatabaseManager##`), or the database already exists and the login cannot open it, which EF Core misreads as "does not exist". Check the second case first: `SELECT DB_ID('YourDb')` as `sa`, then `SELECT DB_ID('YourDb')` as the migration login. If the first returns a number and the second returns `NULL`, the fix is a database user, not a server permission. For production, stop running `Migrate()` with a privileged login at all and hand a DBA the output of `dotnet ef migrations script --idempotent`, which contains no `CREATE DATABASE` at all.

Everything below was verified against `Microsoft.EntityFrameworkCore.SqlServer` 10.0.11 and the `dotnet-ef` 10.0.11 CLI on the .NET SDK 10.0.302. The `Migrator.Migrate` and `SqlServerDatabaseCreator` code paths quoted here are unchanged across EF Core 8, 9, 10 and 11, so the behaviour and every fix apply to all four. Where a claim comes from SQL Server documentation rather than from a run on this machine, I say so.

## The error in context

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

That trace is assembled from the EF Core call chain below rather than captured on this machine, which has no SQL Server instance; the frame names and the error numbers come from the shipped source and from SQL Server's documented errors. Two frames matter. `SqlServerDatabaseCreator.Create()` tells you EF decided the database was missing. `Error Number:262` is the SQL Server permission error, not a connection error, which means the login authenticated fine and got as far as running a statement.

## Why dotnet ef database update touches master at all

Nothing in your `Program.cs` or your connection string mentions `master`. EF puts it there. The relevant code is the first thing `Migrate()` does, in [`Migrator.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs):

```csharp
// Microsoft.EntityFrameworkCore.Relational 10.0.11, Migrator.Migrate
if (!_databaseCreator.Exists())
{
    _databaseCreator.Create();
}
```

There is no option, no `DbContextOptionsBuilder` flag, and no environment variable that skips it. `dotnet ef database update` goes through exactly this method, and so does `context.Database.Migrate()` at application startup and a migration bundle produced by `dotnet ef migrations bundle`.

`Create()` then builds its own connection. From [`SqlServerConnection.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs):

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

`InitialCatalog = "master"` is hardcoded. That is where the `in database 'master'` in the message comes from. On that connection EF runs the T-SQL its own generator emits for a `SqlServerCreateDatabaseOperation`:

```sql
-- what EF Core 10.0.11 sends on the master connection
CREATE DATABASE [Shop];
GO
IF SERVERPROPERTY('EngineEdition') <> 5
BEGIN
    ALTER DATABASE [Shop] SET READ_COMMITTED_SNAPSHOT ON;
END;
```

The reason you get a *permission* error rather than a *login* error is that every SQL Server login can open `master`. The `guest` user's `CONNECT` permission can be revoked "within any database other than `master` or `tempdb`", per the [principals documentation](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine). So EF connects successfully, then trips on the statement.

## The existence check is looser than you think

Here is the part that sends most people down the wrong path. `SqlServerDatabaseCreator.Exists()` does not query `sys.databases`. It opens a connection to the target database and runs `SELECT 1`, and it treats three `SqlException` numbers as proof that the database is absent:

```csharp
// Microsoft.EntityFrameworkCore.SqlServer 10.0.11
private static bool IsDoesNotExist(SqlException exception)
    => exception.Number is 4060 or 1832 or 5120;
```

Error 4060 is `Cannot open database "Shop" requested by the login. The login failed.` SQL Server raises it both when the database is missing **and** when the login has no user mapped in a database that exists, or when the database is offline, restoring, or in `SINGLE_USER` mode. EF cannot tell those apart, so it concludes the database is missing and goes off to create it. You then get error 262 about `master`, when the actual problem is a missing `CREATE USER` in `Shop`.

Distinguish the two cases before you touch any permission. Connect as an administrator and run:

```sql
-- as sa or a sysadmin
SELECT DB_ID('Shop') AS db_id, state_desc, user_access_desc
FROM sys.databases WHERE name = 'Shop';
```

Then connect with the exact credentials from the migration connection string and run:

```sql
-- as the migration login
SELECT DB_ID('Shop') AS visible_to_me;
```

A row from the first query plus `NULL` from the second means the database exists and your login cannot see it. That is the next section. Nothing from the first query means it really is missing, which is the section after.

## Fix 1: the database exists, the login cannot open it

This is the common shape in CI and in freshly restored environments: someone restored a `.bak` or created the database from a script, and the server-level login exists but has no matching database user, or has one orphaned by SID after a restore.

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

If the user already exists but was orphaned by a restore, re-point it at the login instead of recreating it:

```sql
USE [Shop];
GO
ALTER USER [app] WITH LOGIN = [app];
GO
```

`db_ddladmin` is what migrations need: `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX`, and the `__EFMigrationsHistory` table that EF creates on first run. `db_owner` also works and is what most people reach for, but it is more than migrations require.

Two variants raise 4060 for reasons a user account will not fix. If `state_desc` is not `ONLINE`, bring the database online. If `user_access_desc` is `SINGLE_USER`, run `ALTER DATABASE [Shop] SET MULTI_USER;`. In both cases EF will otherwise keep trying to create a database that is sitting right there.

## Fix 2: the database is genuinely missing and you want EF to create it

This is the right fix for a developer machine, a throwaway CI container, or any environment where the migration login is allowed to own its database.

The least-privilege option on SQL Server 2022 (16.x) and later, and on Azure SQL Database, is the `##MS_DatabaseManager##` fixed server role. Per the [server-level roles documentation](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles), its members "can create databases, and delete databases they own", and it carries the server-level permissions `CREATE ANY DATABASE` and `ALTER ANY DATABASE`:

```sql
-- SQL Server 2022 (16.x)+ and Azure SQL Database
ALTER SERVER ROLE [##MS_DatabaseManager##] ADD MEMBER [app];
```

On SQL Server 2019 (15.x) and earlier there is no such role, so grant the server-scoped permission directly. This is the version to prefer over `dbcreator`, because `dbcreator` members "can create, alter, drop, and restore **any** database", including ones your migration has no business touching:

```sql
-- SQL Server 2016 (13.x) and later, including 2019 (15.x) where no role exists
USE master;
GO
GRANT CREATE ANY DATABASE TO [app];
GO
```

`CREATE DATABASE` and `CREATE ANY DATABASE` are not interchangeable, and mixing them up is a common second failure. `CREATE DATABASE` is a *database-scoped* permission in `master`, so it can only be granted to a database user, which means the login needs a user in `master` first:

```sql
-- the CREATE DATABASE variant needs a user in master
USE master;
GO
CREATE USER [app] FOR LOGIN [app];
GRANT CREATE DATABASE TO [app];
GO
```

`CREATE ANY DATABASE` is server-scoped and is granted to the login itself, which is why it needs no user in `master`. The [CREATE DATABASE documentation](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) lists `CREATE DATABASE`, `CREATE ANY DATABASE`, or `ALTER ANY DATABASE` as sufficient.

On Azure SQL Database the older path is the `dbmanager` database role in `master`, which the docs still list as a valid principal for `CREATE DATABASE`:

```sql
-- Azure SQL Database, connected to master
CREATE USER [app] FROM LOGIN [app];
ALTER ROLE dbmanager ADD MEMBER [app];
GO
```

Be careful with this one on Azure. EF emits a bare `CREATE DATABASE [Shop];` with no `EDITION` or `SERVICE_OBJECTIVE`, so the server picks the default tier and starts billing for it. That is precisely the complaint in [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251), "EF Core automatically creates expensive database when executing migrations", which the team closed as not planned. Do not grant database creation rights to a deployment login pointed at an Azure SQL server unless you are happy for a typo in a database name to provision a new billable database.

## Fix 3: take the creation step out of the deployment entirely

If the login is deliberately unprivileged, no amount of granting is the right answer. Stop running `Migrate()` in that environment and apply SQL instead. The generated script never contains `CREATE DATABASE`, because the script generator operates on migrations only and never calls `IRelationalDatabaseCreator`:

```bash
dotnet ef migrations script --idempotent --output migrate.sql
```

On EF Core 10.0.11 that produces exactly this for a single initial migration:

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

Not one reference to `master`. The `--idempotent` flag makes the script safe to run against a database at any migration level, which is what you want when a DBA applies it by hand. The EF team says as much in the [applying migrations documentation](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying): `dotnet ef database update` "applies SQL commands directly by the tool, without giving the developer a chance to inspect or modify them", and the docs explicitly flag that calling `Migrate()` at startup "requires elevated access to modify the database schema", which conflicts with least privilege in production.

The workflow becomes: create the database once, by hand or through Terraform or Bicep, grant the app login `db_ddladmin` inside it, and apply `migrate.sql` in the release pipeline. The application login never needs a single permission in `master`.

## Migration bundles do not get you out of this

A common misreading is that `dotnet ef migrations bundle` sidesteps the problem because it is a standalone executable with no SDK dependency. It does not. The bundle calls `Migrate()`, so it runs the same `Exists()`/`Create()` pair and fails with the same error 262 under an unprivileged login. Bundles solve the "no SDK on the deployment agent" problem, not the permission problem. If your target environment forbids `CREATE DATABASE`, bundles need the same treatment as the CLI: make the database exist first and make the login able to open it. The mechanics of that pipeline are in [applying EF Core 11 migrations in production with dotnet ef migrations bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## Variants that produce a similar error

**`CREATE TABLE permission denied in database 'master'.`** Same error number, different statement. This one means your connection string has no `Database=` or `Initial Catalog=` at all, so SQL Server dropped you into the login's default database, which for `sa` is `master`. EF is not creating anything; it is running your migration against `master`. Add the database to the connection string.

**`EnsureCreated()` instead of migrations.** `Database.EnsureCreated()` raises the identical error for the identical reason, and it is worse: it creates the schema without a `__EFMigrationsHistory` table, so migrations can never be applied to that database afterwards. If you find `EnsureCreated()` in `Program.cs` next to a migrations folder, delete the call.

**LocalDB.** `(localdb)\MSSQLLocalDB` runs as your Windows account, which owns the instance, so 262 there almost always means you are connected to a shared instance or a real SQL Server that you thought was LocalDB. Check the server name in the connection string that the tool actually loaded, with `dotnet ef database update -v`.

**A timeout that looks like a permission failure.** If the message is `Execution Timeout Expired` rather than error 262, the login is fine and the migration itself is slow. That is a different problem, covered in [SqlException: Timeout expired during EF Core migrations](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

**No connection at all.** If `dotnet ef` never reaches SQL Server, you will see `Unable to create an object of type 'DbContext'` instead, which is a design-time discovery failure rather than a permission one. That is covered in [dotnet ef migrations add fails with "Unable to create an object of type DbContext"](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

The broader lesson is that EF Core's migration pipeline was designed for the developer inner loop, where owning your database is the normal case, and the auto-create step was never made optional. [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839), which asked for exactly that so a migrator app would not need database creation rights, was closed as not planned. Treat `Migrate()` as a development convenience and SQL scripts as the deployment mechanism, and error 262 stops being something you can hit in production.

## Related

- [How to apply EF Core 11 migrations in production with dotnet ef migrations bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Fix: SqlException: Timeout expired during EF Core migrations](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Fix: dotnet ef migrations add fails with "Unable to create an object of type DbContext"](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Fix: dotnet tool install --global dotnet-ef throws an error](/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [How to rename a table in an EF Core 11 migration without losing data](/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)

## Sources

- [Migrator.cs, `Migrate(string? targetMigration)`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) - the unconditional `Exists()`/`Create()` pair
- [SqlServerDatabaseCreator.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) - `IsDoesNotExist` and the `SELECT 1` existence probe
- [SqlServerConnection.cs, `CreateMasterConnection`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs) - the hardcoded `InitialCatalog = "master"`
- [CREATE DATABASE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) - required permissions on SQL Server and Azure SQL Database
- [Server-level roles](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles) - `##MS_DatabaseManager##` and `dbcreator`
- [Principals (Database Engine)](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine) - why `guest` cannot be revoked in `master`
- [Applying migrations - EF Core](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) - scripts, bundles, and the least-privilege warning
- [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839) - "Database Migrate fails to execute for manually created database", closed as not planned
- [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251) - "EF Core automatically creates expensive database when executing migrations", closed as not planned
