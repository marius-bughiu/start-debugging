---
title: "Fix: EF Core MigrateAsync and CanConnectAsync keep retrying on 'Login failed for user' for 60 seconds"
description: "EF Core's SQL Server existence check retries error 18456 for a full minute, with or without EnableRetryOnFailure. Fail fast, cap RetryTimeout, or wait for EF Core 12."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-10"
  - "csharp"
---

If `Database.MigrateAsync()`, `EnsureCreatedAsync()` or `CanConnectAsync()` hangs for about a minute before throwing `Login failed for user` (or before returning `false`), the retrying comes from EF Core itself, not from `EnableRetryOnFailure`. `SqlServerDatabaseCreator` treats SQL error 18456 as retryable in its existence check and keeps reconnecting every 500 ms until its one-minute `RetryTimeout` expires. Turning retries off changes nothing. There are three workarounds: open the connection yourself before migrating so a bad password fails on the first attempt, lower `RetryTimeout`, or give health checks a timeout. The real fix ([dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927)) only ships in EF Core 12. I measured all of this on EF Core 10.0.12 and 11.0.0-rc.1, and they behave identically.

## The error in context

The exception is the plain SQL Server login failure. What gives it away is how long it takes to arrive:

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Login failed for user 'app'.
Error Number:18456,State:1,Class:14
```

Typical symptoms:

- A container that runs migrations at startup with a wrong password in its connection string sits silently for 60 seconds before it crashes, so the orchestrator's startup probe often kills it first and you never see the exception.
- `/health` backed by `AddDbContextCheck<T>()` takes a full minute to report `Unhealthy` when the credentials are wrong, and the load balancer's probe times out long before that.
- The SQL Server error log (or Azure SQL auditing) shows a burst of more than a hundred `Login failed for user` entries from one process start.
- Integration tests that assert "bad credentials make `CanConnectAsync` return `false`" pass, but each one takes a minute.

A normal query with the same connection string fails on the first attempt. The slow path is limited to the APIs that ask "does this database exist?"

## Why EF Core retries a login failure

`CanConnectAsync`, `MigrateAsync`, `EnsureCreatedAsync` and `EnsureDeletedAsync` all start by calling `IRelationalDatabaseCreator.ExistsAsync()`. For SQL Server that is [`SqlServerDatabaseCreator`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), and its existence check is a loop of its own:

```csharp
// EF Core 10.0.12 and 11.0.0-rc.1, SqlServerDatabaseCreator (abridged)
public virtual TimeSpan RetryDelay { get; set; } = TimeSpan.FromMilliseconds(500);
public virtual TimeSpan RetryTimeout { get; set; } = TimeSpan.FromMinutes(1);

// inside ExistsAsync: open the connection, run SELECT 1, and on SqlException:
if (!retryOnNotExists && IsDoesNotExist(e)) // 4060, 1832, 5120
    return false;
if (DateTime.UtcNow > giveUp || !RetryOnExistsFailure(e))
    throw;
await Task.Delay(RetryDelay, ct);

private bool RetryOnExistsFailure(SqlException exception)
    => (exception.Number is 203 && exception.InnerException is Win32Exception)
       || exception.Number is 233 or -2 or 4060 or 1832 or 5120 or 18456;
```

Error 18456 was added to that list in EF Core 6.0 by [dotnet/efcore#25832](https://github.com/dotnet/efcore/pull/25832). It was a workaround for [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644): Azure SQL can briefly answer `Login failed` right after `CREATE DATABASE`, so `EnsureCreated` and the first `Migrate` against a new database failed at random. The workaround was needed only in the post-creation check (`CreateAsync` calls `ExistsAsync(retryOnNotExists: true)`), but the same method is used for every existence check. So a password that is simply wrong gets treated as "the database is still warming up" and retried for a full minute. [dotnet/efcore#38886](https://github.com/dotnet/efcore/issues/38886), opened on 2026-08-31, reported exactly that.

This also explains why `EnableRetryOnFailure` looks guilty but isn't. The loop runs inside a single execution-strategy operation. When the minute is up, the strategy asks `SqlServerTransientExceptionDetector.ShouldRetryOn(18456)`, gets `false` (18456 is not in that list), and rethrows. With retries on or off, the timing is the same. `errorNumbersToAdd` doesn't matter either, unless you add 18456 to it, which would make things worse.

`CanConnectAsync` then wraps the whole thing in a `try/catch` that turns any exception except cancellation into `false`. That's why the health-check variant never throws: it just takes a minute to say no.

## Minimal repro without a SQL Server

You don't need a server to see this. A `DbConnectionInterceptor` that throws a `SqlException` numbered 18456 on every physical open stands in for a server with bad credentials. The `SqlException` is built by reflection, because its constructors are internal. The probe counts open attempts and times each call:

```csharp
// .NET 10, EF Core 10.0.12 (also run on .NET 11 RC 1 with EF Core 11.0.0-rc.1.26425.128)
public class FailingOpen(int number) : DbConnectionInterceptor
{
    int _attempts;
    public int Attempts => _attempts;

    public override ValueTask<InterceptionResult> ConnectionOpeningAsync(
        DbConnection c, ConnectionEventData e, InterceptionResult r, CancellationToken ct = default)
    {
        Interlocked.Increment(ref _attempts);
        throw FakeSql.Create(number, "Login failed for user 'app'.");
    }
}

public class Shop(FailingOpen interceptor, bool retry) : DbContext
{
    public DbSet<Product> Products => Set<Product>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlServer(
                "Server=db.invalid;Database=Shop;User Id=app;Password=wrong;Encrypt=False",
                sql => { if (retry) sql.EnableRetryOnFailure(); })
            .AddInterceptors(interceptor);
}
```

Results, identical on EF Core 10.0.12 (SqlClient 6.0) and EF Core 11.0.0-rc.1 (SqlClient 7.0):

| Call | Error | `EnableRetryOnFailure` | Open attempts | Elapsed | Outcome |
|---|---|---|---|---|---|
| `CanConnectAsync()` | 18456 | off | 121 | 60.4 s | `false` |
| `CanConnectAsync()` | 18456 | on | 121 | 60.2 s | `false` |
| `MigrateAsync()` | 18456 | on | 121 | 60.2 s | `SqlException` 18456 |
| `EnsureCreatedAsync()` | 18456 | on | 121 | 60.2 s | `SqlException` 18456 |
| `Products.ToListAsync()` | 18456 | on | 1 | 0.1 s | `SqlException` 18456 |
| `CanConnectAsync()` | 4060 | on | 1 | 0.0 s | `false` |

The interceptor fails instantly, so 121 attempts is the ceiling: one every 500 ms for 60 seconds. Against a real server every attempt also pays for a TCP connection, TLS and a login round trip, so you'll see fewer attempts, but the minute is the same. The last row shows the asymmetry: a *missing database* (4060) short-circuits to `false` immediately, while a *wrong password* is the case that retries.

## Fix, in detail

In order of preference.

### 1. Fix the credentials, using the server-side state code

The minute of retries only makes the real problem slower to find. The client always reports `State:1`. The server writes the real reason to its error log as a state code (in Azure SQL, auditing records it):

| State | Meaning |
|---|---|
| 2, 5 | The login does not exist |
| 6 | A Windows login name was used with SQL authentication |
| 7 | The login is disabled (and the password is wrong) |
| 8 | Wrong password |
| 18 | The password must be changed |
| 38, 40 | The login is valid but cannot open the requested database |
| 58 | SQL authentication used against a server in Windows-only mode |

The full list is on the [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error) page. States 38 and 40 are worth knowing, because they look like a credentials problem but are really a permissions or database-name problem. They're the cousins of the 4060 case covered in [the CREATE DATABASE permission denied post](/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/).

### 2. Fail fast before migrating

If you run migrations at startup, open the connection yourself first. `OpenConnectionAsync` does not go through the existence loop, so a wrong password throws on the first attempt. When the connection is already open, `MigrateAsync` reuses it:

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
static async Task MigrateFailFastAsync(DbContext db, CancellationToken ct = default)
{
    var opened = false;
    try
    {
        await db.Database.OpenConnectionAsync(ct);
        opened = true;
    }
    catch (SqlException ex) when (ex.Number == 4060)
    {
        // Database missing (or no user for this login in it): let MigrateAsync decide.
    }

    try
    {
        await db.Database.MigrateAsync(ct);
    }
    finally
    {
        if (opened) await db.Database.CloseConnectionAsync();
    }
}
```

The probe measured 1 attempt and 0.0 s to the `SqlException` 18456, with `EnableRetryOnFailure` on. The `catch` for 4060 matters. If your migrations are expected to *create* the database (local development, a first deployment), the pre-open fails with 4060 because the database isn't there yet. Swallowing it lets `MigrateAsync` take the normal create path, including the post-creation retry that Azure SQL actually needs. If your databases are always provisioned separately, drop the `catch` and let 4060 fail the startup too.

For production pipelines, the better long-term move is to take migrations out of application startup entirely and run a [migrations bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) as a deployment step. It hits the same loop, but a pipeline step that fails after a minute is much less painful than a crash-looping pod.

### 3. Cap `RetryTimeout`

`RetryTimeout` and `RetryDelay` are public settable properties on `SqlServerDatabaseCreator`, which lives in an `.Internal` namespace. Using it raises the EF1001 analyzer warning, and its shape can change between releases:

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
#pragma warning disable EF1001 // Internal EF Core API usage.
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;

var creator = (SqlServerDatabaseCreator)db.GetService<IRelationalDatabaseCreator>();
creator.RetryTimeout = TimeSpan.FromSeconds(5);
await db.Database.MigrateAsync();
#pragma warning restore EF1001
```

The probe measured 11 attempts and 5.0 s for `MigrateAsync` with this in place. The same timeout bounds the post-creation check, so on Azure SQL don't set it to zero if `EnsureCreated` or `Migrate` creates the database. A few seconds keeps the #15644 workaround alive and gets rid of the minute. The creator is a scoped service, so set it on each context instance that runs migrations, not once at startup.

### 4. Give database health checks a timeout

`AddDbContextCheck<T>()` runs `CanConnectAsync` by default, and [`HealthCheckRegistration.Timeout`](https://github.com/dotnet/aspnetcore/blob/main/src/HealthChecks/Abstractions/src/HealthCheckRegistration.cs) defaults to `Timeout.InfiniteTimeSpan`. Unlike `AddCheck`, `AddDbContextCheck` has no `timeout` parameter, so do two things: replace the test with one that skips the existence loop, and set the registration's timeout through `HealthCheckServiceOptions`:

```csharp
// .NET 10, ASP.NET Core 10.0, Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore 10.0.12
builder.Services.AddHealthChecks()
    .AddDbContextCheck<Shop>(customTestQuery: async (db, ct) =>
    {
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();
        return true;
    });

// The registration is named after the context type unless you pass a name.
builder.Services.Configure<HealthCheckServiceOptions>(o =>
    o.Registrations.Single(r => r.Name == nameof(Shop)).Timeout = TimeSpan.FromSeconds(5));
```

`DbContextHealthCheck` catches whatever the test throws and reports `Unhealthy` with the exception attached, so a wrong password now shows up as `Login failed for user 'app'.` in the health report instead of a bare failure a minute later. The timeout is the backstop for everything else, such as a server that accepts the TCP connection and never answers. The general setup is covered in [adding a health check endpoint to a minimal API](/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/).

### 5. Upgrade when EF Core 12 ships

[dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927), merged on 2026-09-10 and milestoned 12.0.0, passes `retryOnNotExists` through to `RetryOnExistsFailure` so 18456 is retried only after the provider has just created the database:

```csharp
// EF Core main (12.0), after dotnet/efcore#38927
|| (exception.Number is 233 or -2 or 4060 or 1832 or 5120)
|| (retryOnLoginFailure && exception.Number is 18456))
```

As of today the change is not on `release/10.0` or `release/11.0` (both still have the old one-line check), so EF Core 11.0 GA will most likely ship with the one-minute retry. I didn't run an EF Core 12 daily build. The PR adds sync and async regression tests for both paths, so the workarounds above are what you have on 10 and 11.

## Gotchas and lookalikes

**A cancellation token changes the outcome, not just the timing.** `CanConnectAsync(ct)` rethrows cancellation, so with a 5-second `CancellationTokenSource` the probe got a `TaskCanceledException` after 10 attempts, not `false`. Code that only checks the boolean needs a `catch (OperationCanceledException)`.

**The synchronous path blocks a thread.** `Database.Migrate()` and `CanConnect()` use `Thread.Sleep(RetryDelay)` in the same loop, so the minute is spent holding a thread-pool thread. That's another reason to run migrations outside request-serving code.

**Error 4060 is retried by `EnableRetryOnFailure`, just not here.** 4060 (`Cannot open database "Shop" requested by the login`) *is* in the transient list. `CanConnectAsync` returns `false` for it immediately, but a normal query with the default `EnableRetryOnFailure()` (6 retries, 30 s maximum delay) made 7 attempts over 57.9 s before throwing `RetryLimitExceededException`. If a query-time "login failed" takes about a minute, look at the inner exception's number before blaming the creator loop. And if you're tuning the strategy anyway, [the execution strategy and user transactions post](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) covers the other trap it sets.

**Failed-login noise has side effects.** Every retry is a real failed login on the server. With `CHECK_POLICY = ON`, SQL logins follow the Windows account lockout policy, and Azure SQL auditing records each attempt. A minute of retries can lock the account, and after that even the correct password fails, with error 18486 ("the account is currently locked out") instead of 18456.

**Timeouts are a different problem.** If the minute ends in `Timeout expired` rather than `Login failed`, you're looking at command or gateway timeouts during a long migration, which is covered in [SqlException timeout expired during EF Core migrations](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

## Related

- [Fix: CREATE DATABASE permission denied in database 'master' during dotnet ef database update](/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [How to apply EF Core 11 migrations in production with a migrations bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Fix: SqlException timeout expired during EF Core migrations](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Fix: The configured execution strategy does not support user-initiated transactions](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [How to add a health check endpoint to a minimal API in ASP.NET Core 11](/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/)

## Sources

- [dotnet/efcore#38886: CanConnectAsync / MigrateAsync retries on authentication failure instead of throwing](https://github.com/dotnet/efcore/issues/38886) and the fix, [dotnet/efcore#38927: Restrict SQL Server login failure retries to post-creation checks](https://github.com/dotnet/efcore/pull/38927).
- [dotnet/efcore#25832: Update SQL Server transient error list](https://github.com/dotnet/efcore/pull/25832), which added 18456 for [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644).
- [`SqlServerDatabaseCreator.cs` at v10.0.12](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), [at v11.0.0-rc.1](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), and [`SqlServerTransientExceptionDetector.cs`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerTransientExceptionDetector.cs).
- [Connection resiliency](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) (Microsoft Learn, EF Core).
- [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error) (Microsoft Learn, SQL Server).
- [`DbContextHealthCheck.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/HealthChecks.EntityFrameworkCore/src/DbContextHealthCheck.cs) in dotnet/aspnetcore.
