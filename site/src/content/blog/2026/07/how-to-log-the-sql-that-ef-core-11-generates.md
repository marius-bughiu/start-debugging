---
title: "How to log the SQL that EF Core 11 generates"
description: "See the exact SQL Entity Framework Core 11 sends to your database, with parameter values, using LogTo, Microsoft.Extensions.Logging, and ToQueryString."
pubDate: 2026-07-19
tags:
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "logging"
---

The fastest way to see the SQL that Entity Framework Core 11 generates is to call `LogTo(Console.WriteLine)` on your `DbContextOptionsBuilder`. That prints every command EF Core sends to the database, at `Information` level, under the `Microsoft.EntityFrameworkCore.Database.Command` category. In an ASP.NET Core app you usually do not even need that: set `Microsoft.EntityFrameworkCore.Database.Command` to `Information` in `appsettings.json` and the SQL flows through the logging you already have. To see the actual parameter values instead of `?`, add `EnableSensitiveDataLogging()`. To grab the SQL for a single query without running it, call `.ToQueryString()`.

This post covers all of those, when each one is the right tool, and the gotchas that trip people up: why you see nothing by default, why parameters are redacted, and why you should never ship `EnableSensitiveDataLogging` to production. Everything here is current for EF Core 11 and C# 14 on .NET 11.

## Why you see no SQL by default

EF Core does not log anything unless you tell it where to send the logs. This is deliberate. Building a log message has a cost, so EF Core skips the work entirely when there is no sink configured. That is a change in mindset from EF6, where `Database.Log` could be attached at any time. In EF Core, logging is configured once, at context initialization, and the framework generates messages only when a sink is present.

Every SQL command EF Core executes is logged as a single event: `RelationalEventId.CommandExecuted`, event ID `20101`, in the category `Microsoft.EntityFrameworkCore.Database.Command`, at `LogLevel.Information`. That last detail matters. If your logging is filtered to `Warning` and above, which is a common production default, the SQL is generated internally but never reaches your sink. Seeing the SQL is almost always a question of lowering the level for that one category, not of turning on some special switch.

## The one-liner: LogTo

`LogTo` is EF Core's built-in "simple logging". It needs no NuGet package and no dependency injection. It takes an `Action<string>` that EF Core calls once per log message.

```csharp
// EF Core 11, C# 14, .NET 11
public sealed class AppDbContext : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=Shop;Trusted_Connection=True")
            .LogTo(Console.WriteLine);

    public DbSet<Order> Orders => Set<Order>();
}
```

Run a query and you get the command, its parameters, timing, and the SQL text:

```output
info: RelationalEventId.CommandExecuted[20101] (Microsoft.EntityFrameworkCore.Database.Command)
      Executed DbCommand (3ms) [Parameters=[@__customerId_0='?' (DbType = Int32)], CommandType='Text', CommandTimeout='30']
      SELECT [o].[Id], [o].[CustomerId], [o].[Total]
      FROM [Orders] AS [o]
      WHERE [o].[CustomerId] = @__customerId_0
```

`OnConfiguring` still runs even when you build the context through `AddDbContext` or pass a prebuilt `DbContextOptions`, so this is the single place to put logging config regardless of how the context is constructed. If you already register options in `Program.cs`, you can chain `LogTo` there instead:

```csharp
// EF Core 11, .NET 11 - Program.cs
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .LogTo(Console.WriteLine, LogLevel.Information));
```

The second argument raises the minimum level. By default `LogTo` emits everything at `Debug` and above, which is noisy. Passing `LogLevel.Information` trims it down to database access plus a few housekeeping messages, which is usually what you actually want when you are chasing a query.

## Showing parameter values instead of question marks

Notice the `@__customerId_0='?'` in the output above. EF Core redacts parameter values by default because they can be personal or sensitive data that must not end up in a log file. When you are debugging locally and need to see what value was actually sent, turn on sensitive data logging:

```csharp
// EF Core 11 - only ever do this in Development
optionsBuilder
    .UseSqlServer(connectionString)
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging();
```

Now the parameter is materialized:

```output
Executed DbCommand (2ms) [Parameters=[@__customerId_0='42' (DbType = Int32)], ...]
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[CustomerId] = @__customerId_0
```

Gate this behind an environment check so it never activates in production. A leaked query log with real key values is a genuine data-exposure risk:

```csharp
// EF Core 11, .NET 11
optionsBuilder.UseSqlServer(connectionString);
if (builder.Environment.IsDevelopment())
{
    optionsBuilder
        .LogTo(Console.WriteLine, LogLevel.Information)
        .EnableSensitiveDataLogging();
}
```

While you are here, `EnableDetailedErrors()` is a useful companion. EF Core skips per-value try-catch blocks for performance, which makes some errors (for example a `NULL` coming back for a non-nullable property) hard to pin to a specific field. `EnableDetailedErrors()` reintroduces those checks and gives you a message that names the offending property. It is a debugging aid, not a production setting.

## The ASP.NET Core way: Microsoft.Extensions.Logging

In an ASP.NET Core app you rarely need `LogTo` at all. `AddDbContext` and `AddDbContextPool` automatically wire EF Core into the app's `Microsoft.Extensions.Logging` pipeline, so EF Core's SQL flows through the same logger, providers, and filters as the rest of your application. You control it entirely from `appsettings.json` by setting the level for the command category:

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore.Database.Command": "Information"
    }
  }
}
```

That single line is the whole trick. The category is hierarchical, so `Microsoft.EntityFrameworkCore.Database.Command` targets exactly the executed-command events and nothing else. Put it in `appsettings.Development.json` to see SQL locally while keeping production quiet, then flip it without a redeploy when you need to diagnose something in a running environment.

If you prefer to keep everything in code, or you are in a console app using the generic host, register an `ILoggerFactory` and hand it to EF Core with `UseLoggerFactory`. Store the factory as a single shared instance; creating one per context leaks memory and defeats internal caching.

```csharp
// EF Core 11, .NET 11
public static readonly ILoggerFactory DbLoggerFactory =
    LoggerFactory.Create(b => b.AddConsole().AddFilter(
        "Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Information));

protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder
        .UseSqlServer(connectionString)
        .UseLoggerFactory(DbLoggerFactory);
```

Because this path is standard `Microsoft.Extensions.Logging`, any provider plugs in the same way. If you route logs through Serilog, the EF Core SQL lands in your sinks with no extra EF-specific setup. That is the same pipeline covered in [structured logging with Serilog and Seq](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/); EF Core is just another category feeding it.

## Filtering down to only the SQL

`LogTo` gives you three ways to narrow the stream to just the commands you care about. The most readable is by category. Use the strongly-typed `DbLoggerCategory` names so you are not hard-coding strings:

```csharp
// EF Core 11 - only database interactions
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { DbLoggerCategory.Database.Command.Name },
    LogLevel.Information);
```

You can also filter by event ID when you want one precise event and nothing else. For raw SQL only, that is `RelationalEventId.CommandExecuted`:

```csharp
// EF Core 11 - only the executed-command event
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { RelationalEventId.CommandExecuted });
```

And for anything the built-in options cannot express, pass a predicate over `(eventId, logLevel)`. This filters in EF Core's hot path, before the message string is built, so it is cheaper than filtering inside your delegate:

```csharp
// EF Core 11 - custom filter
optionsBuilder.LogTo(
    Console.WriteLine,
    (eventId, level) => eventId == RelationalEventId.CommandExecuted);
```

Filtering here is how you keep query logs readable when you are hunting a specific problem, such as spotting the repeated identical `SELECT` that signals a lazy-loading loop. If that is what you are chasing, the category filter plus a scan of the output is exactly the manual version of [detecting N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).

## Sending logs to a file

`LogTo` takes any `Action<string>`, so writing to a file is just a matter of pointing it at a `StreamWriter`. Dispose the writer when the context is disposed so the file closes cleanly:

```csharp
// EF Core 11, .NET 11
public sealed class AppDbContext : DbContext
{
    private readonly StreamWriter _log = new("ef-sql.log", append: true);

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer(connectionString)
            .LogTo(_log.WriteLine, LogLevel.Information);

    public override void Dispose()
    {
        base.Dispose();
        _log.Dispose();
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _log.DisposeAsync();
    }
}
```

For a leaner file, ask for single-line output and UTC timestamps through `DbContextLoggerOptions`:

```csharp
// EF Core 11 - compact one-line-per-message format
optionsBuilder.LogTo(
    _log.WriteLine,
    LogLevel.Information,
    DbContextLoggerOptions.UtcTime | DbContextLoggerOptions.SingleLine);
```

For anything beyond a throwaway debugging file, prefer routing through `Microsoft.Extensions.Logging` and a real file sink. `LogTo` to a `StreamWriter` is fine for a quick look; it is not a production logging strategy.

## Getting the SQL for one query without running it

Sometimes you do not want a firehose of every command. You have one LINQ query and you want to see the SQL it will produce. `ToQueryString()` renders the SQL for an `IQueryable` without executing it against the database:

```csharp
// EF Core 11, C# 14
var query = db.Orders
    .Where(o => o.Total > 100)
    .OrderByDescending(o => o.Total);

Console.WriteLine(query.ToQueryString());
```

```output
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[Total] > 100.0
ORDER BY [o].[Total] DESC
```

This is the tool to reach for when you are refining a query in a test or a scratch endpoint, because there is no log configuration to set up and no other noise. It only works for queries (`IQueryable`), not for `SaveChanges`, `ExecuteUpdate`, or `ExecuteDelete`; for those, fall back to `LogTo` or the command category. If you are reasoning about the SQL that bulk operations emit, the shapes shown in [ExecuteUpdate and ExecuteDelete for bulk writes](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) are what you will see in the command log.

## Gotchas worth knowing

**`CommandExecuted` fires after the round trip.** The `20101` event carries the timing, so it is logged once the command returns. If a query hangs, you will not see its SQL in the executed log because it never completed. Watch for `CommandExecuting` (`20100`) if you need the SQL before execution, or use `ToQueryString()` to inspect it statically.

**Configuration is fixed at initialization.** You cannot attach or detach `LogTo` after the context is built. If you want a runtime toggle, capture the delegate and null-check it: `optionsBuilder.LogTo(s => _sink?.Invoke(s))`, then set `_sink` on demand. This mirrors the old EF6 `Database.Log` behavior.

**Do not call `LogTo` twice with the intent of adding sinks.** A second call replaces the configuration rather than adding to it. To fan out to multiple destinations, write a delegate that forwards to each.

**Sensitive data logging and detailed errors are both development-only.** `EnableSensitiveDataLogging` puts real parameter values, including keys and personal data, into your logs. `EnableDetailedErrors` adds per-read overhead. Guard both behind an environment check. This is also where an unexpectedly noisy log can leak more than you intend, so review what your sinks retain.

**The category, not a flag, is your production control.** In a deployed app, leave EF Core wired into `Microsoft.Extensions.Logging` and drive visibility purely through the `Microsoft.EntityFrameworkCore.Database.Command` level. You get SQL on demand by changing one config value, and you never ship a `LogTo(Console.WriteLine)` that you forgot to remove.

Reading the generated SQL is the first move in almost every EF Core performance investigation, from a query that silently evaluates on the client to a migration that emits more than you expected. Once you can see it, the fixes in [the LINQ expression could not be translated](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) and the breaking-change notes in [migrating EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) become a lot easier to apply, because you are debugging the actual SQL rather than guessing at it.

## Sources

- [EF Core simple logging (LogTo) - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/simple-logging)
- [Using Microsoft.Extensions.Logging with EF Core - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/extensions-logging)
- [ToQueryString / viewing generated SQL - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/#viewing-generated-sql)
- [RelationalEventId.CommandExecuted - .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationaleventid.commandexecuted)
