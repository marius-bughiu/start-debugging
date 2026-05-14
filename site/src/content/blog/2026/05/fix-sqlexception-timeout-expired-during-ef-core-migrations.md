---
title: "Fix: SqlException: Timeout expired during EF Core migrations"
description: "Migrations use the design-time DbContext, not your runtime CommandTimeout. Set the timeout via UseSqlServer(o => o.CommandTimeout(...)), the connection string Command Timeout, or Database.SetCommandTimeout before Migrate()."
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
---

The fix: `dotnet ef database update` connects through the design-time `DbContext`, runs each migration step as a single command, and inherits the SQL Server provider's default `CommandTimeout` of 30 seconds. Long migrations (large `AlterColumn`, index rebuilds, backfills) blow past 30 seconds and SqlClient throws `Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired`. Set the timeout in three places, in this order of preference: a provider-level `o.CommandTimeout(600)` on `UseSqlServer`, a `Command Timeout=600` in the connection string used at design time, or apply migrations from your application with `context.Database.SetCommandTimeout(TimeSpan.FromMinutes(10))` before calling `Migrate()`. The `dotnet ef database update` CLI itself has no `--command-timeout` flag in EF Core 11, which is the single fact that wastes the most time when chasing this error.

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

This guide is written against .NET 11 preview 4, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.4, `Microsoft.Data.SqlClient` 6.0.x, and `dotnet-ef` 11.0.0-preview.4. The error message has been stable across SqlClient versions, only the namespace shifted from `System.Data.SqlClient` to `Microsoft.Data.SqlClient` when the provider switched in EF Core 3.0. The `Error Number:-2` is the canonical signal: a value of `-2` in `SqlException.Number` is the client-side command timeout, not a server-side fault. If you see `Error Number:1222` or another positive code, you are looking at a different problem (lock wait, login failure) that the rest of this post does not solve.

## Why migrations time out where runtime queries do not

There are two `DbContext` instances in play during a migration. The one your ASP.NET Core app uses at runtime, configured by `AddDbContext`, and the one `dotnet ef` builds at design time. They are not the same instance and they do not necessarily share configuration. EF Core's migration tooling discovers a `DbContext` through one of three mechanisms documented in the [EF Core CLI reference](https://learn.microsoft.com/en-us/ef/core/cli/dotnet): it calls a public static `CreateHostBuilder(string[])` in your `Program` class, it looks for an `IDesignTimeDbContextFactory<TContext>`, or it falls back to running your app's host so `AddDbContext` registers the context. In every path it builds a fresh `DbContext` and uses that for migrations.

The SQL Server provider's default `CommandTimeout` is the underlying `SqlCommand` default, which is 30 seconds. A `SetCommandTimeout` you call somewhere in a request pipeline runs on the runtime instance, not the design-time one. An `AlterColumn` that takes 90 seconds because the table has 8 million rows ends up dispatched as a single command on a `DbCommand` whose `CommandTimeout` is 30, and SqlClient cancels it after 30 seconds.

Two things make this fail harder than it should. First, a migration commits its row to `__EFMigrationsHistory` only on success. If the command times out partway through, you can end up with a partially applied schema, the migration row missing, and the next `dotnet ef database update` retrying the same long operation from scratch. Second, EF Core 9 and later wrap each migration in a transaction by default unless you opt out. When the command timeout fires, SQL Server rolls the whole migration back, which is the safer outcome but also the one that costs you another 30 seconds of wall time on the next attempt.

The CLI side of the story is plain. `dotnet ef database update` accepts `--connection`, `--context`, `--project`, `--startup-project`, and the common options. There is no `--command-timeout`. The EF Core team has tracked this as [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) for years; the canonical answer remains "set it in the `DbContext` configuration."

## Minimal repro

A table with enough rows that any `AlterColumn` will take more than 30 seconds is enough.

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

Add a migration that widens `Reference` from `nvarchar(50)` to `nvarchar(450)` so SQL Server has to rewrite every row instead of doing a metadata-only change:

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

Run `dotnet ef database update` against an `Orders` table with a few million rows. With the default 30-second timeout, the command throws the exact stack trace at the top of this post.

## Fix, in detail

Pick the option that matches how migrations are applied in your project. The ranking below is by maintainability, not by ease.

### 1. Set CommandTimeout on the provider in your DbContext config

This is the canonical fix. It pins the timeout to the `DbContext` so every code path, design-time and runtime, gets the same value.

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

The second argument to `UseSqlServer` is an `Action<SqlServerDbContextOptionsBuilder>`. `CommandTimeout(int seconds)` lives on [SqlServerDbContextOptionsBuilder](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout). It sets the `CommandTimeout` for every `DbCommand` EF Core builds on this context, including the ones the migration runner dispatches.

If you have an `IDesignTimeDbContextFactory<OrdersContext>` for tooling, set it there too. `dotnet ef` prefers `IDesignTimeDbContextFactory<T>` over `CreateHostBuilder` when both are present, so this override takes effect for design-time runs:

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

### 2. Put `Command Timeout` in the connection string

If you cannot edit the `DbContext` (you are migrating someone else's package, or your design-time discovery uses a connection string passed by CI), set the timeout in the connection string and SqlClient applies it to every command:

```text
Server=tcp:prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true;Command Timeout=600
```

The `Command Timeout` keyword is supported by `Microsoft.Data.SqlClient` and propagates to `SqlCommand.CommandTimeout`. CI pipelines that ship a migration bundle and pass `--connection` get this for free:

```bash
./efbundle --connection "Server=...;Command Timeout=600"
```

The bundle executable has no `--timeout` flag of its own (see [the `dotnet ef migrations bundle` reference](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#dotnet-ef-migrations-bundle)). The connection string is the only knob the bundle exposes.

### 3. Apply migrations from code with `SetCommandTimeout`

If you call `context.Database.Migrate()` from your app (a common pattern for self-hosted services and integration tests), set the timeout on the live `Database` facade right before the call. `SetCommandTimeout` mutates the runtime command timeout on the context's connection:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
using var scope = app.Services.CreateScope();
var db = scope.ServiceProvider.GetRequiredService<OrdersContext>();

db.Database.SetCommandTimeout(TimeSpan.FromMinutes(10));
await db.Database.MigrateAsync();
```

`Database.SetCommandTimeout` is documented on [RelationalDatabaseFacadeExtensions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout). It accepts an `int` (seconds) or `TimeSpan`. The value persists for the lifetime of the context, so a single set is enough to cover a full `MigrateAsync` call. This is the right pattern for [integration tests that spin up a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), since the test orchestrator owns the application of the migration.

## Gotchas and variants the search traffic blends together

### "Timeout expired" with `Error Number != -2`

If `SqlException.Number` is not `-2`, your problem is not a client-side command timeout. The two most common alternates that ship the same prose are:

- `Error Number:1222` is a lock wait timeout. Another session holds a lock on the object you are trying to alter and SQL Server's `LOCK_TIMEOUT` setting fired. Raising `CommandTimeout` will hit the same wall; the fix is to find the blocker (`sp_who2`, `sys.dm_exec_requests`).
- `Error Number:-2` with `State:0,Class:11` and a `ClientConnectionId` is the canonical SqlClient client-side command timeout that this post fixes.

### Connection Timeout vs Command Timeout

`Connection Timeout=30` (also spelled `Connect Timeout`) in the connection string is how long SqlClient waits to open the TCP connection. It does not affect how long a single command may run. If you only changed `Connection Timeout` and not `Command Timeout`, you have changed the wrong knob. Pre-EF Core 11 docs sometimes use the two interchangeably in prose; the actual property names are unambiguous.

### Migrations that wrap multiple `AlterColumn` calls

EF Core groups the operations in a single `Up` method into one transaction by default. The 30-second timer is per `DbCommand`, not per migration, but a single `AlterColumn` on a hot table is easily one long command. If you have several long operations in one migration, raising `CommandTimeout` once is enough; you do not need to split the migration. When you do want to split it, the [EF Core 11 single-step migration commands like `dotnet ef migrations update --add`](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) let you stage the work more cleanly.

### Azure SQL throttles the long migration

If you raise the timeout to 30 minutes and the migration still fails at around 60 seconds with the same message, you are not hitting the client timeout, you are hitting the Azure SQL gateway. The gateway holds idle TCP sessions but can drop sessions during failover, throttling, or service updates. Two mitigations: turn the operation into an online index rebuild with `WITH (ONLINE = ON)` so the long lock breaks into shorter ones, and enable [`EnableRetryOnFailure`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.enableretryonfailure) so the migration runner retries the operation under the same transient-fault policy your app already uses:

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

### "It works on my machine, fails in CI"

Two specific causes. First, your local SQL Server is small and the table has 200 rows, so the `AlterColumn` completes in 200 ms. CI runs against a staging database with the real row count, where the same command takes minutes. Second, your local app uses the runtime `DbContext` configuration with a generous `CommandTimeout`, while CI runs `dotnet ef database update` and discovers a different design-time `DbContext` that does not have your override. The [design-time `DbContext` discovery rules](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) explain why CI ends up with a different context than your app does at runtime.

### Async vs sync timeout behavior

`SqlException.Number == -2` fires identically for `ExecuteNonQuery` and `ExecuteNonQueryAsync`. Switching to `MigrateAsync` does not save you, it only frees the calling thread. `SetCommandTimeout` is the only knob that matters here.

### Migrations history table is half-written

If the command killed the connection mid-flight and you are stuck on the next run because EF Core thinks the migration was applied, look at `__EFMigrationsHistory`. If the row is missing but the column change is partially applied, you can either roll back the partial DDL manually with a single `ALTER` and rerun the migration, or insert the row in `__EFMigrationsHistory` and write a follow-up migration that finishes the work. Do not delete unrelated rows from that table, EF Core uses them to figure out which `Down()` operations to run.

## Related

- [Fix: dotnet ef migrations add fails with "Unable to create an object of type DbContext"](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) for the upstream design-time discovery problem.
- [EF Core 11 single-step migrations with dotnet ef migrations update --add](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) if a long migration is easier to split than to raise the timeout for.
- [Write integration tests against a real SQL Server with Testcontainers](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), since `Database.SetCommandTimeout` plus `MigrateAsync` is the standard test-setup pattern.
- [Fix: A second operation was started on this context instance](/2026/05/fix-second-operation-was-started-on-this-context-instance/) for a different timing-shaped exception that often gets searched alongside this one.
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) for the kind of runtime regression that puts so much load on the database that even small migrations start timing out.

## Sources

- [EF Core CLI reference](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) - the canonical list of `dotnet ef` options.
- [SqlServerDbContextOptionsBuilder.CommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout) API docs.
- [RelationalDatabaseFacadeExtensions.SetCommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout) API docs.
- [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) "Allow customizing migration commands timeout" tracks why no CLI flag exists.
- [dotnet/efcore#22887](https://github.com/dotnet/efcore/issues/22887) covers the migration-bundle case and the connection-string workaround.
