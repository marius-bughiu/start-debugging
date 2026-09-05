---
title: "What is an EF Core interceptor and when do I need one?"
description: "An EF Core interceptor is a class EF calls before and after operations like executing a command or SaveChanges, and it can modify or suppress them, not just observe. Here are the seven interception points in EF Core 11, the registration and lifetime rules, and the cases where a query filter or plain logging is the better answer."
pubDate: 2026-09-05
tags:
  - "ef-core"
  - "dotnet-11"
  - "csharp"
  - "aspnetcore"
---

An EF Core interceptor is a class you register on a `DbContext` that EF calls before and after a specific operation: creating or executing a command, opening a connection, starting a transaction, calling `SaveChanges`, materializing an entity from query results, compiling a LINQ query, or resolving an identity conflict. The part that matters, and the part that separates interceptors from logging, is that most interception points let you **change or suppress** the operation rather than just watch it. You need one when a concern must apply to every context in the application, cannot be expressed in the model, and has to alter behaviour: stamping audit columns, appending a query hint, resolving a connection string per tenant, swallowing a concurrency exception you have decided is benign. If all you want is to see the SQL, you want logging, and an interceptor is the wrong tool.

Everything below targets EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14). The interception surface itself did not change in EF Core 11: the seven interfaces have been stable since EF Core 7 added `IIdentityResolutionInterceptor`. What did change around it is worth knowing, and I cover that in the gotchas.

## The seven interception points

Every interceptor implements one or more interfaces derived from `IInterceptor`, all in the `Microsoft.EntityFrameworkCore.Diagnostics` namespace:

| Interface | What it intercepts | Singleton |
| --- | --- | --- |
| `IDbCommandInterceptor` | Command creation, execution, failures, disposing the `DbDataReader` | No |
| `IDbConnectionInterceptor` | Creating, opening, and closing connections; connection failures | No |
| `IDbTransactionInterceptor` | Creating, using, committing, and rolling back transactions; savepoints | No |
| `ISaveChangesInterceptor` | `SavingChanges` / `SavedChanges` / `SaveChangesFailed`, optimistic concurrency | No |
| `IMaterializationInterceptor` | Creating, initializing, and finalizing entity instances from query results | Yes |
| `IQueryExpressionInterceptor` | The LINQ expression tree, before the query is compiled | Yes |
| `IIdentityResolutionInterceptor` | Identity conflicts when the context starts tracking a new instance | Yes |

The first three are relational-only; database interception is not available on non-relational providers such as the Azure Cosmos DB provider. The `Singleton` column is not cosmetic, and I come back to it below because getting it wrong is the most common way to make an interceptor quietly wreck performance.

For the four non-singleton interfaces there are no-op base classes: `DbCommandInterceptor`, `DbConnectionInterceptor`, `DbTransactionInterceptor`, and `SaveChangesInterceptor`. Inherit from those and override only the two or three methods you care about, rather than implementing 20 interface members by hand.

## The shape of a method pair, and what "suppress" means

Every interception point comes in a before/after pair, and each half comes in sync and async variants. `ReaderExecuting` runs before the query is sent to the database; `ReaderExecuted` runs after it returns. `SavingChanges` runs before the save; `SavedChanges` runs after a successful one.

The "before" methods return an `InterceptionResult` or `InterceptionResult<T>`, and that return value is the control channel:

- Return the `result` argument unchanged and EF carries on as normal. This is the observe-only case.
- Return `InterceptionResult.Suppress()` and EF skips the operation entirely. Used on operations with no return value, for example the `ThrowingConcurrencyException` interception point, where suppressing means "do not throw `DbUpdateConcurrencyException`."
- Return `InterceptionResult<T>.SuppressWithResult(value)` and EF skips the operation and uses your value instead. Used on operations that produce something, for example returning a fabricated `DbDataReader` from a cache instead of executing SQL.

That is the whole mental model. Logging tells you what EF did; an interceptor gets a veto.

Here is a minimal, genuinely useful command interceptor: log any command that takes longer than a threshold, with the part of EF that issued it.

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore.Relational 11.0
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging;

public sealed class SlowCommandInterceptor(ILogger<SlowCommandInterceptor> logger)
    : DbCommandInterceptor
{
    private static readonly TimeSpan Threshold = TimeSpan.FromMilliseconds(200);

    public override DbDataReader ReaderExecuted(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result)
    {
        Report(command, eventData);
        return result;
    }

    public override ValueTask<DbDataReader> ReaderExecutedAsync(
        DbCommand command,
        CommandExecutedEventData eventData,
        DbDataReader result,
        CancellationToken cancellationToken = default)
    {
        Report(command, eventData);
        return new ValueTask<DbDataReader>(result);
    }

    private void Report(DbCommand command, CommandExecutedEventData eventData)
    {
        if (eventData.Duration < Threshold)
        {
            return;
        }

        logger.LogWarning(
            "Slow command ({DurationMs} ms, source {Source}): {Sql}",
            (int)eventData.Duration.TotalMilliseconds,
            eventData.CommandSource,
            command.CommandText);
    }
}
```

Two details in there are the ones people miss. First, both the sync and async overrides are implemented. EF calls whichever matches the call the application made, so implementing only `ReaderExecuted` means your interceptor silently does nothing in an async codebase. Second, `eventData.CommandSource` tells you whether the command came from a query, from `SaveChanges`, from `ExecuteUpdate`, or from a migration, which is usually the filter you actually want.

## Registering an interceptor

Registration happens when the context is configured, through `DbContextOptionsBuilder.AddInterceptors`:

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
builder.Services.AddDbContext<AppDbContext>((sp, options) =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .AddInterceptors(sp.GetRequiredService<SlowCommandInterceptor>()));
```

Resolving the interceptor from the service provider is what lets it take constructor dependencies, which is how it gets an `ILogger` above. Register the interceptor itself first (`builder.Services.AddSingleton<SlowCommandInterceptor>()` here, since it holds no per-request state).

`OnConfiguring` works too, and it still runs even when `AddDbContext` is used, so it is a reasonable place to attach interceptors that must apply no matter how the context is constructed. One interceptor instance can implement several of the interfaces at once; register it once and EF routes each event to the right interface.

## A SaveChanges interceptor, end to end

The most common real interceptor is the one that stamps audit columns. It is worth writing out in full because the sync/async pairing and the change-tracker call are both easy to get wrong.

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public interface IAuditable
{
    DateTimeOffset CreatedUtc { get; set; }
    DateTimeOffset ModifiedUtc { get; set; }
}

public sealed class TimestampInterceptor(TimeProvider clock) : SaveChangesInterceptor
{
    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        Stamp(eventData.Context);
        return result;
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        Stamp(eventData.Context);
        return new ValueTask<InterceptionResult<int>>(result);
    }

    private void Stamp(DbContext? context)
    {
        if (context is null)
        {
            return;
        }

        // The docs' own auditing sample calls DetectChanges here rather than
        // assuming the states are already current. Do the same.
        context.ChangeTracker.DetectChanges();

        var now = clock.GetUtcNow();

        foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
        {
            switch (entry.State)
            {
                case EntityState.Added:
                    entry.Entity.CreatedUtc = now;
                    entry.Entity.ModifiedUtc = now;
                    break;
                case EntityState.Modified:
                    entry.Entity.ModifiedUtc = now;
                    break;
            }
        }
    }
}
```

Taking `TimeProvider` rather than reading `DateTimeOffset.UtcNow` directly is what makes this testable; the same reasoning applies anywhere in a .NET 11 codebase, and it pairs with [testing time-dependent code with FakeTimeProvider](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/). If you want the full version of this pattern, including writing a change trail and handling the current user, I wrote that up separately in [using EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).

## Suppressing an operation: the concurrency case

The clearest demonstration of the veto is `ISaveChangesInterceptor.ThrowingConcurrencyException`. EF calls it immediately before it would throw `DbUpdateConcurrencyException`. If two requests race to delete the same row, the loser sees zero rows affected and gets an exception, even though the desired end state (the row is gone) was reached:

```csharp
// .NET 11, C# 14 -- Microsoft.EntityFrameworkCore 11.0
public sealed class SuppressDeleteConcurrencyInterceptor : ISaveChangesInterceptor
{
    public InterceptionResult ThrowingConcurrencyException(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result)
        => eventData.Entries.All(e => e.State == EntityState.Deleted)
            ? InterceptionResult.Suppress()
            : result;

    public ValueTask<InterceptionResult> ThrowingConcurrencyExceptionAsync(
        ConcurrencyExceptionEventData eventData,
        InterceptionResult result,
        CancellationToken cancellationToken = default)
        => new(ThrowingConcurrencyException(eventData, result));
}
```

`eventData.Entries` gives you the `EntityEntry` objects involved, so the decision is made on real state rather than on a string match against an exception message. On a relational provider you can cast `eventData` to `RelationalConcurrencyExceptionEventData` and read the offending `Command` as well.

## When you do not need an interceptor

Interceptors are the heaviest hook EF offers, and reaching for one first is a common mistake. Before writing one, check whether a lighter mechanism covers the case.

**You want to see the SQL.** Use `Microsoft.Extensions.Logging` or `LogTo` simple logging. The docs are explicit that interceptors are not the logging mechanism, and a logging pipeline gives you levels, filters, and sinks for free. If you are chasing query counts rather than query text, the approach in [detecting N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) is closer to what you want, and general structured-logging setup is covered in [Serilog and Seq on .NET 11](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/).

**You want a callback on save or on tracking, and sync is fine.** `DbContext` exposes plain .NET events: `SavingChanges`, `SavedChanges`, `SaveChangesFailed`, `ChangeTracker.Tracked`, and `ChangeTracker.StateChanged`. They register per context instance and can be attached at any time, which makes them simpler than an interceptor. The catch is that events are sync only, so they cannot perform non-blocking I/O. Interceptors can, because the async halves return `ValueTask`.

**You want the same information for every context in the process.** That is a `DiagnosticListener` subscription on the `"Microsoft.EntityFrameworkCore"` source, not an interceptor. Diagnostic listeners are process-wide and observe-only; interceptors are per-context and can modify. Pick based on both axes, not just one.

**You want to filter every query for soft deletes or tenancy.** That is a query filter, not an `IQueryExpressionInterceptor`. Writing an `ExpressionVisitor` to inject a `Where` clause is a large amount of fragile code to reimplement something the model already does, and EF Core 10 and 11 support several independently disableable filters per entity, which is the case people used to hand-roll. See [named query filters for soft delete and multi-tenancy](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

**You want to transform a property value on the way in and out.** That is a value converter.

**The behaviour applies to exactly one `DbContext` subclass and only on save.** Overriding `SaveChangesAsync` is simpler, easier to read in a stack trace, and easier to test. Reach for `ISaveChangesInterceptor` when the logic must apply across several context types, or when it needs to live in a shared library that does not own the context class.

## Gotchas that cost real time

**Singleton interceptors and `ManyServiceProvidersCreatedWarning`.** `IMaterializationInterceptor`, `IQueryExpressionInterceptor`, and `IIdentityResolutionInterceptor` are registered in EF's *internal* service provider. Each distinct instance you pass to `AddInterceptors` causes a new internal provider to be built, so passing `new MyMaterializationInterceptor()` inside an `AddDbContext` lambda that runs per scope will eventually trip `ManyServiceProvidersCreatedWarning` and tank performance. Hold one instance in a static field or resolve a singleton from DI. Because they are shared, these interceptors must be thread-safe and should hold no mutable state; get at scoped things through the `Context` property on the event data instead.

**Scoped dependencies in a `SaveChanges` interceptor.** The non-singleton interceptors are free of the above constraint, but if yours depends on something scoped (a current-user accessor, a tenant resolver), it must itself be scoped and resolved through the `(sp, options)` overload of `AddDbContext`. Registering it as a singleton and injecting a scoped service is the classic route to [cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

**`ExecuteUpdate` and `ExecuteDelete` never reach a `SaveChanges` interceptor.** Set-based operations bypass the change tracker and go straight to SQL, so audit stamping, soft-delete rewriting, and domain-event dispatch hung off `SavingChanges` are all skipped. This is by design and it is the single most common way an audit trail develops silent holes. The trade-off is laid out in [ExecuteUpdate and ExecuteDelete for bulk writes](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). An `IDbCommandInterceptor` still sees these commands, because everything eventually becomes a `DbCommand`.

**`ConnectionCreating` and `ConnectionCreated` only fire when EF creates the connection.** If your application constructs the `DbConnection` and hands it to EF, those two interception points never run. `ConnectionOpening` still does.

**`IIdentityResolutionInterceptor` does not fire for query results.** As of EF Core 11 it is only invoked from `Update`, `Attach`, and similar tracking calls, not for entities coming back from a query. That is tracked as [dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574) and may change. If you just want "last write wins" on attach, the built-in `UpdatingIdentityResolutionInterceptor` saves you writing one.

**Expression tree interception is a last resort.** `IQueryExpressionInterceptor` is powerful and the docs' own example, adding a stable secondary sort, ends with the observation that adding `.ThenBy(e => e.Id)` to the query directly is simpler, easier to understand, and always works. That is the right instinct. An `ExpressionVisitor` that silently rewrites every query in the application is a debugging problem you inherit forever.

**Interceptors run in order, and can see each other's decisions.** Injected interceptors from extensions run first, in service-provider resolution order, then application interceptors. A later interceptor can check `InterceptionResult<T>.HasResult` to see whether an earlier one already suppressed the operation, which matters if you stack them.

**One EF Core 11 addition worth knowing.** `ChangeTracker.GetEntriesForState(added, modified, deleted, unchanged)` is a state-filtered enumerator that skips the implicit `DetectChanges` pass `Entries()` performs. It exists precisely for hot paths like `SaveChanges` interceptors and audit hooks, where the same scan otherwise runs twice per save. Details and the trade-off are in [EF Core 11 adds GetEntriesForState](/2026/04/efcore-11-changetracker-getentriesforstate/).

## The short version

Write an interceptor when you need to *change* what EF does, across every context, at a point the model cannot express. Use logging when you need to see what it did, .NET events when you need a simple sync callback on one context, a diagnostic listener when you need process-wide observation, and a query filter or value converter when the concern is really about the model. Implement both the sync and async halves of whatever pair you override, keep singleton interceptors stateless and shared, and remember that anything routed around `SaveChanges` is also routed around your `ISaveChangesInterceptor`.

## Related

- [How to use EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core 11 adds GetEntriesForState to skip DetectChanges](/2026/04/efcore-11-changetracker-getentriesforstate/)
- [How to use named query filters for soft delete and multi-tenancy in EF Core 11](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/)

## Sources

- [Interceptors -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors)
- [.NET events -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/events)
- [Using diagnostic listeners -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/diagnostic-listeners)
- [IIdentityResolutionInterceptor Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.iidentityresolutioninterceptor)
- [CommandExecutedEventData Class -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.commandexecutedeventdata)
- [What's New in EF Core 11 -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Identity resolution interceptor is not called for query results -- dotnet/efcore #37574](https://github.com/dotnet/efcore/issues/37574)
