---
title: "Fix: There is already an object named 'X' in the database after resetting EF Core migrations"
description: "After you delete the Migrations folder and scaffold a new InitialCreate, EF Core does not know your tables exist. Drop a dev database, or record the new migration in __EFMigrationsHistory without running it."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "dotnet"
---

You deleted the `Migrations` folder, ran `dotnet ef migrations add InitialCreate`, and now `dotnet ef database update` fails with `There is already an object named 'Blogs' in the database`. EF Core decides what to run by comparing migration IDs in your assembly with the rows in `__EFMigrationsHistory`. Your new `InitialCreate` has a new timestamp, so EF Core treats it as pending and tries to `CREATE TABLE` on tables that already exist. If the database is disposable, drop it (`dotnet ef database drop --force`) and update again. If it holds data, delete the old history rows and insert one row for the new migration ID so EF Core records it as applied without executing it. Everything below was measured on EF Core 10.0.12 with `dotnet-ef` 10.0.12 on .NET 10 (SDK 10.0.302), and the logic is unchanged in EF Core 11.0.0-rc.1.

## The error in context

On SQL Server this is engine error 2714, surfaced as a `SqlException` from `dotnet ef database update` or from `Database.Migrate()` at startup. No SQL Server instance was available for this post, so the block below is the SQLite run with the SQL Server DDL and engine message substituted:

```text
Applying migration '20261006110224_InitialCreate'.
Failed executing DbCommand (12ms) [Parameters=[], CommandType='Text', CommandTimeout='30']
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
Microsoft.Data.SqlClient.SqlException (0x80131904): There is already an object named 'Blogs' in the database.
```

The same root cause shows up with different text on other providers. The SQLite line is copied from the repro run for this post; the PostgreSQL and MySQL lines are the engine errors for the same `CREATE TABLE` statement:

```text
SQLite:      SQLite Error 1: 'table "Blogs" already exists'.
PostgreSQL:  42P07: relation "Blogs" already exists
MySQL:       Table 'Blogs' already exists        (error 1050)
SQL Server:  There is already an object named 'Blogs' in the database.   (error 2714)
```

The key line is the first one: `Applying migration '..._InitialCreate'`. If EF Core is applying your initial migration against a database that already has your schema, you are on the right page.

## Why EF Core tries to create tables that already exist

EF Core does not inspect your schema to decide which migrations to run. It runs one query, `SELECT MigrationId FROM __EFMigrationsHistory`, and compares the result with the migrations compiled into your assembly. Any migration whose ID is not in the table is pending, and pending migrations execute their `Up()` method in full.

A migration ID is the file name prefix: a UTC timestamp plus the name you typed, for example `20261006110224_InitialCreate`. When you reset migrations, the new `InitialCreate` gets a fresh timestamp. The old rows (`20261006110219_InitialCreate`, `20261006110221_AddPublished`) are still in the history table, but EF Core silently ignores rows that do not match any migration in the assembly. It does not warn about them. So from EF Core's point of view the database has never seen your new migration, and the first `CreateTable` in it hits a table that is already there.

The same mismatch happens in a few situations that are not a deliberate reset:

1. **The database was created by `EnsureCreated()`**. `EnsureCreated()` builds the schema straight from the model and never creates `__EFMigrationsHistory`. The first `Migrate()` creates an empty history table, considers every migration pending, and fails on the first table.
2. **The database came from somewhere else**: a restored backup from another app, a DB-first schema, a script run by a DBA. Same picture, tables exist, history does not.
3. **The history table moved**. `MigrationsHistoryTable("__MyHistory", "app")` added or changed after deployment, or a different login whose default schema is not `dbo` on SQL Server. EF Core looks in the new location, finds nothing, and starts from zero.
4. **Two migrations create the same table**. Two branches each added a migration that creates `AuditLog`, and both got merged. The first one succeeds, the second throws 2714.

## Minimal repro on EF Core 10

This is the exact sequence I ran, using SQLite so it is reproducible on any machine:

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new AppDb();

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Post { public int Id { get; set; } public string Title { get; set; } = ""; public int BlogId { get; set; } }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=app.db");
}
```

```bash
# dotnet-ef 10.0.12
dotnet ef migrations add InitialCreate
# add a DateTime Published property to Post
dotnet ef migrations add AddPublished
dotnet ef database update            # applies both, history has 2 rows

rm -rf Migrations                    # the "reset"
dotnet ef migrations add InitialCreate
dotnet ef database update            # SQLite Error 1: 'table "Blogs" already exists'.
```

After the failure, `dotnet ef migrations list` shows exactly what EF Core believes:

```text
20261006110224_InitialCreate (Pending)
```

The two old rows are still in the history table. EF Core 10 also wraps each migration in its own transaction, so on SQLite and SQL Server the failed `InitialCreate` rolls back cleanly and leaves nothing half-applied. MySQL is the exception, because DDL there commits implicitly.

## Fix 1: drop the database when the data does not matter

For a local development database, the reset you actually wanted is "migrations and database start over together". The [official docs](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations) describe exactly that: delete the `Migrations` folder and drop the database.

```bash
# dotnet-ef 10.0.12
dotnet ef database drop --force
dotnet ef database update
```

This is the right answer for a laptop database or a throwaway container. Do not reach for it on anything shared: it deletes the database, data included.

## Fix 2: record the new baseline without running it

If the database has data you care about, you want the opposite: keep the schema, and tell EF Core that the new `InitialCreate` is already applied. This is what the docs call squashing migrations. EF Core has no built-in command for it (the request has been open for years as [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174)), so it is a manual edit of the history table.

1. Back up the database.
2. Make sure the database is at the **last old migration** before you reset. If it is behind, apply the missing old migrations first, using the old code from source control. A baseline only works if the new `InitialCreate` describes the schema that is really there.
3. Delete the `Migrations` folder and run `dotnet ef migrations add InitialCreate`.
4. Run `dotnet ef migrations script 0 InitialCreate` and copy the `INSERT INTO [__EFMigrationsHistory]` statement from the end of the output. It has the exact migration ID and product version.
5. Replace the old history rows with that one row.

On SQL Server, step 5 looks like this:

```sql
-- SQL Server, EF Core 10.0.12 history table
BEGIN TRANSACTION;

DELETE FROM [__EFMigrationsHistory];

INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
VALUES (N'20261006110224_InitialCreate', N'10.0.12');

COMMIT;
```

Then confirm EF Core agrees:

```bash
# dotnet-ef 10.0.12
dotnet ef migrations list                      # 20261006110224_InitialCreate, no "(Pending)"
dotnet ef migrations has-pending-model-changes # "No changes have been made to the model since the last migration."
```

In my repro, after the baseline I added a `Url` property to `Blog`, scaffolded `AddBlogUrl`, and `dotnet ef database update` applied only that migration. That is the state you want: the history has one baseline row, and new migrations flow normally on top of it.

Deleting the old rows is not strictly required, because EF Core ignores rows it does not recognize. Delete them anyway. If someone later checks out an old commit and runs `database update` against this database, stale rows make EF Core think old migrations are applied, which is a confusing failure to debug.

## Baselining more than one environment

A squash is easy on one database and error-prone on five. Every existing environment needs the row swap, and every new environment needs the full `InitialCreate` to run. The safest way to get both is a guard that only rewrites history when it finds the old chain, and does nothing otherwise.

As a SQL script that you run once per environment, before deploying the squashed code:

```sql
-- SQL Server, run before deploying the squashed migrations
BEGIN TRANSACTION;

IF EXISTS (SELECT 1 FROM [__EFMigrationsHistory]
           WHERE [MigrationId] = N'20261006110221_AddPublished')
   AND NOT EXISTS (SELECT 1 FROM [__EFMigrationsHistory]
                   WHERE [MigrationId] = N'20261006110224_InitialCreate')
BEGIN
    DELETE FROM [__EFMigrationsHistory];
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20261006110224_InitialCreate', N'10.0.12');
END;

COMMIT;
```

The guard is on the **last** old migration, not the first. A database that never reached `AddPublished` does not have the schema your new `InitialCreate` describes, so it should not be baselined. It should be brought up to date with the old code first.

If you apply migrations from the app at startup, the same guard fits in front of `Migrate()`. I tested this against three databases: one at the old `AddPublished` state, the same database on a second run, and a brand new empty file. All three ended with `InitialCreate, AddBlogUrl` applied and the correct schema.

```csharp
// .NET 10, EF Core 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new AppDb();
BaselineSquashedMigrations(db);
db.Database.Migrate();

static void BaselineSquashedMigrations(AppDb db)
{
    const string lastOldMigration = "20261006110221_AddPublished";
    const string newBaseline = "20261006110224_InitialCreate";

    // Returns every row in __EFMigrationsHistory, including IDs that no longer exist in the assembly.
    // Returns an empty list when the history table does not exist yet (fresh database).
    var applied = db.Database.GetAppliedMigrations().ToHashSet();
    if (!applied.Contains(lastOldMigration) || applied.Contains(newBaseline))
        return;

    using var tx = db.Database.BeginTransaction();
    db.Database.ExecuteSql($"DELETE FROM __EFMigrationsHistory");
    db.Database.ExecuteSql(
        $"INSERT INTO __EFMigrationsHistory (MigrationId, ProductVersion) VALUES ({newBaseline}, {"10.0.12"})");
    tx.Commit();
}
```

The table name is unquoted here so the same code works on SQL Server and SQLite. On PostgreSQL it must be quoted as `"__EFMigrationsHistory"`, because the identifier is case sensitive there. Run this in a single migration step (a job, an init container, or one instance), not in every replica. `Migrate()` takes a migration lock since EF Core 9, but this helper runs before that lock is acquired. If you deploy with bundles instead, run the SQL version before the bundle, as covered in [applying EF Core migrations in production with migration bundles](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/). Remove the helper once every environment has been baselined.

## The empty Up() trick, and why I avoid it

A common Stack Overflow answer says: comment out the body of `Up()` in the new `InitialCreate`, run `database update` so the row gets recorded, then restore the body. It works for one database on one machine. It is also exactly how a broken migration gets committed: forget to restore the body, and every new environment gets an empty schema with a history row claiming it is complete. The SQL baseline does the same thing to the database without touching the migration file, so there is nothing to forget.

## Gotchas and lookalikes

**Custom code in old migrations is gone.** Any `migrationBuilder.Sql(...)` you wrote for views, stored procedures, triggers, or seed rows lived in the deleted files. The new `InitialCreate` only contains what the model knows about. Copy those blocks into the new migration by hand, or new environments will be missing objects that production has.

**Schema drift makes the baseline lie.** If someone added an index or a column directly in production, the new `InitialCreate` does not contain it, and the baseline records a schema that does not match. Before you baseline, compare the output of `dotnet ef migrations script 0 InitialCreate` against the real schema (SSMS schema compare, `pg_dump --schema-only`, or `sqlite3 .schema`).

**`EnsureCreated()` next to `Migrate()`.** If you got here because the database was created by `EnsureCreated()`, remove that call before doing anything else. It never creates the history table, so the two can never coexist. The same advice appears in the post on [`CREATE DATABASE permission denied` during `dotnet ef database update`](/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/), which is another symptom of mixing the two.

**Startup throws a different error first.** Since EF Core 9, `Migrate()` refuses to run when the model has changes that are not captured in a migration. If you see `The model for context has pending changes` instead, fix that first, as described in [the pending model changes post](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), then come back.

**Partially applied migration after a timeout.** If the 2714 shows up on a migration that is not your initial one, the cause may be a migration that died halfway. That case is covered in [fixing SqlException timeouts during EF Core migrations](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/), including how to repair the history row.

**`--idempotent` scripts do not save you.** `dotnet ef migrations script --idempotent` wraps each migration in `IF NOT EXISTS (SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'...')`. It checks the migration ID, not the table, so a new `InitialCreate` ID still runs its `CREATE TABLE` and fails the same way.

**`dotnet ef migrations add` fails before you even get here.** If the tool cannot build your context during the reset, that is a design-time configuration problem, covered in [fixing "Unable to create an object of type DbContext"](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Related

- [How to apply EF Core 11 migrations in production with dotnet ef migrations bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Fix: The model for context has pending changes in EF Core 11](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [Fix: SqlException: Timeout expired during EF Core migrations](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Fix: CREATE DATABASE permission denied in database 'master'](/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [Fix: dotnet ef migrations add "Unable to create an object of type DbContext"](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)

## Sources

- [Managing Migrations: Resetting all migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations), Microsoft Learn.
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn.
- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying), Microsoft Learn.
- [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174), the open feature request for squashing migrations.
- [`HistoryRepository.cs` on the release/10.0 branch](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Relational/Migrations/HistoryRepository.cs), which shows the history table name and schema defaults.
