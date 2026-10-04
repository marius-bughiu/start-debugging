---
title: "How to set PostgreSQL session parameters such as search_path or statement_timeout on every EF Core connection with Npgsql"
description: "A SET statement run once is wiped by DISCARD ALL the moment Npgsql returns the connection to its pool. Put search_path and statement_timeout in the startup packet with the Search Path and Options connection string keywords, fall back to ALTER ROLE or a ConnectionOpened interceptor, and know why UsePhysicalConnectionInitializer silently loses its SET."
pubDate: 2026-10-04
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "dotnet-10"
  - "how-to"
---

Short answer: do not run `SET statement_timeout = ...` once and expect it to stick. Npgsql sends `DISCARD ALL` every time a pooled connection is reused, which resets every session setting back to its default. Put the settings into the connection's startup packet instead: `Search Path=tenant_a,public` for the schema search path, and `Options=-c statement_timeout=5s -c lock_timeout=1s` for any other parameter. PostgreSQL treats startup parameters as the session defaults, so `DISCARD ALL` resets back to *your* values, and EF Core needs no extra code at all. If you cannot touch the connection string, use `ALTER ROLE app_user SET ...` on the server, or a `DbConnectionInterceptor` that runs `SET` in `ConnectionOpenedAsync` (one extra round trip per open).

Everything below was run on .NET 10 (SDK 10.0.302) with `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (EF Core 10.0.4, Npgsql 10.0.3) against PostgreSQL 18.4, with `log_statement=all` turned on so every statement Npgsql sent shows up in the server log. The outputs quoted are from those runs.

## Why a one-off SET disappears

Npgsql pools physical connections. When you dispose an `NpgsqlConnection` (or EF Core closes one after a query), the physical connection goes back to the pool, and Npgsql marks it for a reset. The reset is a `DISCARD ALL`, which PostgreSQL defines as `CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; DEALLOCATE ALL; UNLISTEN *; ...`. `RESET ALL` is the part that matters here: every `SET` you ran in that session is gone.

Here is the smallest repro. The pool is capped at one connection, so the second open is guaranteed to get the same physical session:

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

Same backend process, and both settings are back to the server defaults. The server log shows why:

```text
[95652] execute <unnamed>: SET search_path = tenant_a
[95652] execute <unnamed>: SET statement_timeout = '1s'
[95652] statement: DISCARD ALL
[95652] execute <unnamed>: SHOW search_path
```

Note that `DISCARD ALL` is not sent when you close the connection. Npgsql defers it and writes it in front of the next command on that physical connection, so it does not cost an extra round trip. It also runs whether or not you changed anything, so you cannot dodge it by being careful.

With EF Core this bites harder than with raw ADO.NET, because EF Core opens and closes the connection around each operation. A `DbContext` that runs a query and then a `SqlQueryRaw` call opens the connection twice, and each open can land on a freshly reset session.

## Option 1: the Search Path connection string keyword

For the schema search path specifically, Npgsql has a dedicated keyword. It is sent as a startup parameter, not as a `SET`:

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Search Path=tenant_a,public");

await using var c = await ds.OpenConnectionAsync();
// SHOW search_path            -> tenant_a,public
// SELECT count(*) FROM orders -> 1 (resolves to tenant_a.orders)
```

There is no `SET` in the server log for this connection at all. The value travels in the startup packet, and PostgreSQL uses it as the session default.

## Option 2: Options=-c for any other parameter

The `Options` keyword is passed through as the PostgreSQL `options` startup parameter, which accepts the same `-c name=value` syntax as the `postgres` command line. That covers `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `work_mem`, `search_path`, and anything else that a regular user is allowed to `SET`:

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

This is the property that makes the startup packet the right place. `RESET ALL` returns each parameter to the value it would have had if no `SET` had run in this session, and for a startup parameter that value is the one you passed. So a request that temporarily raises the timeout cannot leak it into the next request, and the next request still gets your default rather than the server's.

If you build connection strings in code, use `NpgsqlConnectionStringBuilder` so the quoting is handled for you. The space-separated `Options` value gets quoted:

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

## Wiring it into EF Core

Because the settings live in the connection string, EF Core needs nothing special. Pass the string to `UseNpgsql`, or register an `NpgsqlDataSource` and pass that:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(
    builder.Configuration.GetConnectionString("Orders")));

// appsettings.json
// "ConnectionStrings": {
//   "Orders": "Host=db;Database=orders;Username=app;Search Path=tenant_b,public;Options=-c statement_timeout=5s -c lock_timeout=1s"
// }
```

Running a query through that context confirms the timeout is in effect on every connection EF Core opens:

```csharp
var st = await db.Database
    .SqlQueryRaw<string>("SELECT current_setting('statement_timeout') AS \"Value\"")
    .SingleAsync();
// 5s
```

When the timeout fires, PostgreSQL cancels the statement on the server and you get a `PostgresException` with `SqlState` `57014` and the message `canceling statement due to statement timeout`. The connection stays open and usable. That is different from Npgsql's own `Command Timeout` (default 30 seconds), which is enforced by the client: when it expires, Npgsql cancels the query and throws an `NpgsqlException` wrapping a `TimeoutException`, with no `SqlState`. Keep `Command Timeout` a little higher than `statement_timeout` so the server-side limit, which gives you a clean error and does not depend on the client noticing, is the one that trips.

## Option 3: ALTER ROLE or ALTER DATABASE on the server

If the connection string is owned by someone else (a platform team, a secret store you cannot change per app), push the defaults to the server:

```sql
-- PostgreSQL 18
ALTER ROLE app_user SET search_path = tenant_a, public;
ALTER ROLE app_user SET statement_timeout = '15s';

-- or scoped to one database
ALTER ROLE app_user IN DATABASE orders SET statement_timeout = '15s';
```

A new connection as `app_user` came back with `search_path=tenant_a, public` and `statement_timeout=15s`, with zero client-side configuration. These role defaults survive `DISCARD ALL` too, since they are part of the session's starting state.

Precedence matters when you combine approaches. The same role connecting with `Options=-c statement_timeout=3s` got `3s`: startup parameters override role and database defaults, which in turn override `postgresql.conf`. That gives you a useful layering: a conservative default on the role, and a per-application override in the connection string where one service legitimately needs longer queries (a reporting job, a migration runner).

Avoid setting `statement_timeout` globally in `postgresql.conf`. The PostgreSQL docs warn against it because it also applies to maintenance sessions, `pg_dump`, and your own `psql` sessions.

## Option 4: a DbConnectionInterceptor that runs SET on every open

Sometimes the value is not static. A multi-tenant app that picks the schema per request, or a setting derived from the current user, cannot live in a fixed connection string. EF Core's [interceptors](/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) give you a hook that runs right after every open:

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

Override both the sync and async methods. EF Core calls whichever matches the API you used, and forgetting the sync one means `db.Orders.Count()` silently runs without your settings.

This works, and the log shows exactly what it costs. Two `DbContext` instances, each running one LINQ query and one raw SQL query, produced four opens and four `SET` pairs:

```text
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT count(*)::int ...
[95655] statement: DISCARD ALL
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT s."Value" ...
```

Every open pays one extra round trip. On a local socket that is noise; against a managed database in another availability zone it can be the same order of magnitude as the query itself. For static values, Options 1 to 3 are strictly better. For per-request values, consider whether the parameter really needs to be session-wide, or whether a `SET LOCAL` inside the transaction you are already running is enough.

## The trap: UsePhysicalConnectionInitializer

`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer` looks like the obvious fit. It runs a callback once when a physical connection is first created, which sounds like "once per session, no per-open overhead". Here is what actually happens:

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

The initializer runs once, as promised, and the first open sees `4s`. Then the connection goes back to the pool, `DISCARD ALL` wipes the `SET`, and the initializer never runs again because the physical connection still exists. Every request after the first one runs without a timeout. Npgsql's own XML documentation on the method warns about this: settings applied there get reverted by `DISCARD ALL` unless you turn the reset off.

The fix is to pair it with `No Reset On Close=true`. In EF Core, `ConfigureDataSource` lets you reach the builder without leaving `UseNpgsql`:

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

One `SET`, no `DISCARD ALL` in the log, and the setting holds across contexts. The price is that *nothing* gets reset any more. If any code path runs `SET` (a migration helper, a diagnostic query, a library), that value now leaks to every later user of that physical connection, along with temp tables and `LISTEN` registrations. Use this combination only when you control every statement that runs on the pool. If a static value is all you need, the connection string is simpler and safer.

## Per-query overrides with SET LOCAL

Raising the timeout for one known-slow operation does not need a session change at all. `SET LOCAL` lasts until the end of the current transaction:

```csharp
// .NET 10, EF Core 10.0.4
await using var tx = await db.Database.BeginTransactionAsync();
await db.Database.ExecuteSqlRawAsync("SET LOCAL statement_timeout = '60s'");
await db.Database.ExecuteSqlRawAsync("REFRESH MATERIALIZED VIEW sales_summary");
await tx.CommitAsync();
// after commit: statement_timeout is back to the session default
```

In the probe, `SHOW statement_timeout` returned `100ms` inside the transaction and `0` right after the commit, on the same connection, with no `DISCARD ALL` needed. This is also the only approach that works through PgBouncer in transaction mode, covered next.

## Gotchas with poolers, migrations, and timeouts

**PgBouncer rejects unknown startup parameters.** By default PgBouncer only accepts startup parameters it tracks, and it raises an error for everything else, including `options`. You either add `options` to `ignore_startup_parameters` (and then PgBouncer silently drops your settings) or move the defaults to `ALTER ROLE`. PostgreSQL 18 reports `search_path` back to the client, so PgBouncer tracks it out of the box on 18. In transaction or statement mode, Npgsql's docs also tell you to set `No Reset On Close=true` because `DISCARD ALL` makes no sense when PgBouncer can hand the next transaction to a different backend. In that mode, any `SET` outside a transaction is effectively random, so use `SET LOCAL` or role defaults.

**search_path decides where unqualified tables get created.** With `Search Path=tenant_b,public` and no `HasDefaultSchema`, `EnsureCreatedAsync` created `Widgets` in `tenant_b`. The Npgsql provider creates `__EFMigrationsHistory` with `CREATE TABLE IF NOT EXISTS` unqualified as well, so a migration runner whose connection string carries a different `search_path` than the app will create a second history table and try to re-run every migration. Either pin the schema in the model (`modelBuilder.HasDefaultSchema("tenant_b")` and `MigrationsHistoryTable("__EFMigrationsHistory", "tenant_b")`) or make sure the runner uses the exact same connection string. Also note that `EnsureCreated` checks whether the database has *any* user tables, not just ones in your search path: in a database that already had `tenant_a.orders`, it skipped creation entirely and the first insert failed with `42P01: relation "Widgets" does not exist`.

**Migrations need their own timeout.** A 5 second `statement_timeout` in the shared connection string will kill a long `CREATE INDEX` during deployment. Give the migration runner its own connection string with `Options=-c statement_timeout=0` (startup parameters win over role defaults), and see [the guide to EF Core migration timeouts](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) for the client-side half of the problem.

**lock_timeout is usually the one you actually want.** A query stuck behind a lock is the common production incident, and `statement_timeout` only catches it once the whole budget is spent. `lock_timeout=1s` fails fast with `55P03` while letting legitimately long queries run. PostgreSQL 17 added `transaction_timeout` too, which caps the whole transaction rather than each statement.

**Some parameters cannot be set this way.** Server-wide parameters are rejected in `options`: `-c shared_buffers=1GB` fails with `55P02 parameter "shared_buffers" cannot be changed without restarting the server`, and a `sighup` parameter such as `log_checkpoints` fails with `55P02 ... cannot be changed now`. Superuser-only parameters fail for a normal role: `-c log_statement=none` as `app_user` gave `42501 permission denied to set parameter "log_statement"`. In every case `OpenAsync` throws, so you find out on the first request rather than running silently with the wrong settings.

## Picking the approach

For a fixed value, use the connection string: `Search Path` for schemas, `Options=-c ...` for everything else. It costs nothing per open, survives the pool reset, and works for EF Core, Dapper, and raw Npgsql alike. Use `ALTER ROLE ... SET` when the connection string is not yours, or as a safety net underneath. Reach for a `ConnectionOpened` interceptor only when the value depends on runtime state, and accept the extra round trip. `UsePhysicalConnectionInitializer` with `No Reset On Close=true` is a niche tool for pools whose every statement you control.

### Read next

- [What is an EF Core interceptor and when do I need one?](/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) explains the interceptor pipeline the `ConnectionOpened` approach hooks into.
- [How to use EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) shows a `SaveChanges` interceptor end to end.
- [How to use named query filters for soft delete and multi-tenancy in EF Core 11](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) is the row-level alternative to schema-per-tenant `search_path` switching.
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) helps confirm what reaches the server from the client side.
- [How to atomically append to a PostgreSQL jsonb array with EF Core and Npgsql](/2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql/) is another Npgsql-specific pattern tested against PostgreSQL 18.

### Sources

- [Connection String Parameters](https://www.npgsql.org/doc/connection-string-parameters.html), Npgsql documentation (`Search Path`, `Options`, `No Reset On Close`, `Command Timeout`)
- [Compatibility notes: pgbouncer](https://www.npgsql.org/doc/compatibility.html), Npgsql documentation
- [`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer`](https://github.com/npgsql/npgsql/blob/main/src/Npgsql/NpgsqlDataSourceBuilder.cs), npgsql/npgsql (XML remarks on `DISCARD ALL`)
- [`NpgsqlHistoryRepository.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Migrations/Internal/NpgsqlHistoryRepository.cs), npgsql/efcore.pg
- [DISCARD](https://www.postgresql.org/docs/current/sql-discard.html), PostgreSQL documentation
- [Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html), PostgreSQL documentation (`statement_timeout`, `lock_timeout`, `transaction_timeout`, `search_path`)
- [ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html), PostgreSQL documentation
- [Connection interception](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors#connection-interception), EF Core documentation
- [PgBouncer configuration](https://www.pgbouncer.org/config.html) (`track_extra_parameters`, `ignore_startup_parameters`)
