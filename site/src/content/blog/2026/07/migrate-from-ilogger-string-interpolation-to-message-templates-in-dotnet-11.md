---
title: "Migrate from ILogger string interpolation to structured logging message templates in .NET 11"
description: "A step-by-step guide to converting $-interpolated ILogger calls into message templates and [LoggerMessage] source-generated methods on .NET 11: what breaks, how to sweep a codebase with CA2254, how to verify the JSON state, and how to roll back."
pubDate: 2026-07-25
updatedDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "logging"
  - "observability"
---

Every `_logger.LogInformation($"Order {orderId} failed for {customerId}")` in your codebase is throwing away the two fields you will want when the pager goes off. This guide converts a .NET 11 codebase (SDK 11.0.100-preview.6, C# 14) from interpolated log calls to message templates, and then converts the hot paths to `[LoggerMessage]` source-generated methods. On a mid-sized service the template sweep is a half-day of mostly mechanical edits driven by CA2254, and the source-generator pass is another day if you do it properly. Nothing about it is risky: the fix is non-breaking, every step is independently revertible, and the payoff is that your log backend can finally filter on `OrderId` instead of grepping rendered sentences.

## Why interpolation loses the data you actually need

- **The structure is gone before the logger sees it.** `$"Order {orderId} failed"` is compiled to a `string.Concat` or `DefaultInterpolatedStringHandler` call at the call site. By the time `ILogger.Log` runs, there is no `orderId` property, just a sentence. `{OriginalFormat}` in the log state ends up holding the fully rendered text, so every distinct order ID produces a distinct "template" in your aggregator.
- **Cardinality explodes in the wrong place.** Seq, Loki, Elastic, and every OTLP backend group and index on the template plus its named properties. Interpolated calls give you one unique template per invocation, which is exactly the shape those systems are worst at.
- **The string is built even when the level is off.** `_logger.LogDebug($"Payload: {Serialize(request)}")` allocates the string and runs `Serialize` on every request, in production, with `Debug` disabled. Microsoft's own [library authoring guidance](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance) calls this out explicitly. The proposal to add interpolated string handler overloads to `LoggerExtensions` ([dotnet/runtime#111283](https://github.com/dotnet/runtime/issues/111283)) was closed as not planned, so this is not going to be fixed under you.
- **Braces in your data can throw.** More on this in the gotchas, but an interpolated string whose value contains `{` or `}` can throw a `FormatException` from inside the logging pipeline.

If you have not decided where the logs are going yet, sort that out first. [Structured logging with Serilog and Seq](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) and [OpenTelemetry with .NET 11 and a free backend](/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) both assume the templates in this guide are already correct.

## What the two forms actually produce

Here is the smallest repro. Same intent, two call styles, run through the `JsonConsole` formatter on .NET 11.

```csharp
// .NET 11 preview 6, C# 14
int orderId = 4711;
string customerId = "acme-inc";

// Interpolated: the template IS the rendered sentence.
_logger.LogInformation($"Order {orderId} failed for {customerId}");

// Message template: placeholders survive as named properties.
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", orderId, customerId);
```

The first call emits state with a single useless entry:

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "{OriginalFormat}": "Order 4711 failed for acme-inc"
  }
}
```

The second call emits the fields:

```json
{
  "LogLevel": "Information",
  "Message": "Order 4711 failed for acme-inc",
  "State": {
    "Message": "Order 4711 failed for acme-inc",
    "OrderId": 4711,
    "CustomerId": "acme-inc",
    "{OriginalFormat}": "Order {OrderId} failed for {CustomerId}"
  }
}
```

The rendered `Message` is identical. Everything that makes the log queryable lives in the difference.

## What breaks

| Area | Change | Severity |
| --- | --- | --- |
| Call sites with `$"..."` | Must become a constant template plus arguments | high (volume, not risk) |
| Log queries and dashboards | Saved searches that match on rendered text keep working; new property filters need building | medium |
| Alert rules keyed on `{OriginalFormat}` | The template string changes, so exact-match rules on the old rendered text stop matching | medium |
| String concatenation in templates | `"Order " + id + " failed"` is the same defect and is caught by the same rule | medium |
| `[LoggerMessage]` conversion | Containing class and method must become `partial`; method must return `void` | low |
| `EventId` values | Duplicate IDs across the assembly produce generator warnings | low |
| Serilog `@` destructuring | `{@Order}` semantics differ from `Microsoft.Extensions.Logging` state enumeration | low |

Nothing here is a runtime breaking change. The Roslyn rule that drives the sweep, [CA2254](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254), is explicitly documented as a non-breaking fix.

## Pre-flight checklist

- .NET SDK 11.0.100-preview.6 or later installed (`dotnet --list-sdks`). Everything in this guide also works on .NET 8, 9, and 10.
- `<LangVersion>` at 9 or higher. The `[LoggerMessage]` generator refuses to run below C# 9. On .NET 11 you get C# 14 by default.
- `Microsoft.Extensions.Logging.Abstractions` referenced in every project that will declare `[LoggerMessage]` methods. Projects using `Microsoft.NET.Sdk.Web` get it transitively.
- `<EnableNETAnalyzers>true</EnableNETAnalyzers>` and `<AnalysisLevel>latest</AnalysisLevel>` in `Directory.Build.props`, otherwise CA2254 never fires.
- A clean `git status` and a green test run before you start. The sweep touches hundreds of lines and you want a trivial revert.

## Migration steps

The order matters: get the analyzer screaming first, fix everything it finds, and only then reach for the source generator on the paths where allocation actually costs you something.

1. **Turn CA2254 into a build error.** Add the rule to `.editorconfig` at `warning` first to see the blast radius, then raise it to `error` once the count reaches zero. Verify: `dotnet build` reports a non-zero CA2254 count on the first run.
2. **Convert interpolated and concatenated calls to message templates.** Move every value out of the string and into an argument, with a PascalCase placeholder name. Verify: `dotnet build` reports zero CA2254 diagnostics.
3. **Fix argument order, because binding is positional.** `LoggerExtensions` binds arguments to placeholders left to right, not by name. Verify: run the app and confirm each property in the JSON state holds the value its name promises.
4. **Add `[LoggerMessage]` methods for hot paths.** Convert per-request and per-item log calls into `partial` methods on a `partial` class so the template is parsed once at compile time. Verify: `dotnet build` is clean and the generated file appears under `obj/**/Microsoft.Extensions.Logging.Generators/`.
5. **Assign a stable `EventId` per message and keep them unique.** Verify: no `SYSLIB` duplicate-event-ID warnings in the build log.
6. **Use `SkipEnabledCheck` plus a manual guard where argument evaluation is expensive.** Verify: set the category to `Information` and confirm the expensive call does not run.
7. **Expand objects with `[LogProperties]` instead of `ToString()`.** Verify: the object's public properties appear as individual entries in the log state, not as one flattened string.

### 1. Turn CA2254 into a build error

CA2254 is enabled as a suggestion by default from .NET 10 onwards, which means it is invisible in CI. Promote it:

```ini
# .editorconfig -- .NET 11, analyzers at latest
[*.{cs,vb}]

# CA2254: Template should be a static expression
dotnet_diagnostic.CA2254.severity = warning
```

Build and count what you are dealing with:

```bash
dotnet build -warnaserror:CA2254 --no-incremental
```

Do not enable CA1848 yet. That rule fires on every `LogInformation` call in the codebase, including the correct ones, and it will bury the CA2254 signal. It comes back in step 4.

### 2. Convert to message templates

The mechanical transformation, three common shapes:

```csharp
// .NET 11, C# 14 -- before
_logger.LogInformation($"Order {order.Id} failed for {order.CustomerId}");
_logger.LogWarning("Retry " + attempt + " of " + maxAttempts);
_logger.LogError(ex, $"Import of {file.Name} aborted after {sw.ElapsedMilliseconds} ms");

// after
_logger.LogInformation("Order {OrderId} failed for {CustomerId}", order.Id, order.CustomerId);
_logger.LogWarning("Retry {Attempt} of {MaxAttempts}", attempt, maxAttempts);
_logger.LogError(ex, "Import of {FileName} aborted after {ElapsedMs} ms", file.Name, sw.ElapsedMilliseconds);
```

Three naming rules that pay for themselves later:

- PascalCase placeholders. Microsoft's own guidance recommends it, and it keeps property names consistent between hand-written templates and generated ones.
- The same concept gets the same name everywhere. If it is `OrderId` in one service it is `OrderId` in all of them, otherwise cross-service queries need an `or` clause per spelling.
- Never put the exception in the template. `LogError(ex, "...")` passes it through the dedicated `Exception` parameter, and the provider decides how to render it.

### 3. Argument binding is positional, not by name

This is the one bug the sweep can introduce, and CA2254 will not catch it:

```csharp
// .NET 11 -- compiles, no analyzer warning, WRONG
_logger.LogInformation("Order {OrderId} for {CustomerId}", customerId, orderId);
```

`Microsoft.Extensions.Logging` maps placeholders to arguments in order. The names are labels for the resulting properties, not a binding key. The log line renders the customer ID under `OrderId` and nobody notices until a query returns nonsense three weeks later. Read every converted line once with this specific failure in mind, and prefer converting a whole method at a time rather than accepting bulk find-and-replace output.

The `[LoggerMessage]` generator in step 4 does not have this problem: it matches template placeholders to parameter names case-insensitively, so parameter order is irrelevant there.

### 4. Add [LoggerMessage] on the hot paths

Message templates fixed the structure. They did not fix the per-call cost: `LoggerExtensions.LogInformation` still boxes value types into `object`, allocates a `params object?[]`, and re-parses the template on every call. The [`[LoggerMessage]` source generator](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) removes all three by emitting a strongly typed `LoggerMessage.Define` wrapper at compile time.

```csharp
// .NET 11 preview 6, C# 14
using Microsoft.Extensions.Logging;

public partial class OrderProcessor(ILogger<OrderProcessor> logger, OrderPipeline pipeline)
{
    public async Task ProcessAsync(Order order, CancellationToken ct)
    {
        try
        {
            await pipeline.RunAsync(order, ct);
            OrderProcessed(order.Id, order.CustomerId);
        }
        catch (PaymentDeclinedException ex)
        {
            OrderFailed(ex, order.Id, order.CustomerId);
        }
    }

    [LoggerMessage(
        EventId = 1001,
        Level = LogLevel.Information,
        Message = "Order {OrderId} processed for {CustomerId}")]
    private partial void OrderProcessed(int orderId, string customerId);

    [LoggerMessage(
        EventId = 1002,
        Level = LogLevel.Warning,
        Message = "Order {OrderId} failed for {CustomerId}")]
    private partial void OrderFailed(Exception ex, int orderId, string customerId);
}
```

Since .NET 9 the generator will read the `ILogger` from a primary constructor parameter, which is why the example above has no explicit `_logger` field. If both a field and a primary constructor parameter exist, the field wins.

The constraints worth memorising, from the [source generation docs](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator): methods must be `partial` and return `void`, names and parameter names must not start with an underscore, and parameters cannot use `params`, `scoped`, or `out`, or be `ref struct` types. Static methods must take the `ILogger` as a parameter; add `this` to make them extension methods.

Now turn on CA1848 for the projects you have converted, scoped so it does not flood the rest:

```ini
# .editorconfig, in the hot-path project folder only
[*.cs]
# CA1848: Use the LoggerMessage delegates
dotnet_diagnostic.CA1848.severity = warning
```

CA1848 is not enabled by default even in .NET 10 and later, and it is deliberately aggressive: it flags every `LogInformation`-style call. Enable it per project, not solution-wide, unless you genuinely intend to source-generate every message.

### 5. Keep event IDs stable and unique

`EventId` is the stable identity of a log message. It survives template rewording, which makes it the right thing for alert rules to key on. Put the IDs in one place per assembly so collisions are obvious:

```csharp
// .NET 11 -- one file, one range per subsystem
internal static class LogEvents
{
    public const int OrderProcessed = 1001;
    public const int OrderFailed    = 1002;
    public const int PaymentRetried = 1003;
}
```

The generator warns on duplicate event IDs within a class. It does not warn across classes, so the constants file is doing real work.

### 6. SkipEnabledCheck for expensive arguments

By default the generated method calls `ILogger.IsEnabled` before doing anything, so a disabled level costs one virtual call. What it cannot do is stop your caller from computing the arguments. When an argument is expensive, hoist the guard:

```csharp
// .NET 11, C# 14
[LoggerMessage(
    EventId = 2001,
    Level = LogLevel.Debug,
    Message = "Request body: {Body}",
    SkipEnabledCheck = true)]
private partial void RequestBody(string body);

// call site
if (logger.IsEnabled(LogLevel.Debug))
{
    RequestBody(await SerializeAsync(request, ct));  // only runs when Debug is on
}
```

This is the pattern that recovers the throughput interpolated `LogDebug` calls were quietly costing you.

### 7. Expand objects with [LogProperties]

`Message = "Processing {Order}"` with an `Order` parameter gives you one property holding `ToString()` output. To get the object's fields as separate properties, add `Microsoft.Extensions.Telemetry.Abstractions` and annotate the parameter:

```csharp
// .NET 11, Microsoft.Extensions.Telemetry.Abstractions
[LoggerMessage(
    EventId = 1004,
    Level = LogLevel.Information,
    Message = "Processing order")]
private partial void ProcessingOrder([LogProperties] Order order);
```

Each public property of `Order` lands in the log state as `order.Id`, `order.CustomerId`, and so on. The same package is what enables redaction of classified parameters, which is the correct answer when someone asks you to log a request object that contains an email address.

## Verification

Run this checklist after each phase, not once at the end:

- `dotnet build -warnaserror:CA2254` exits zero.
- `dotnet test` passes with no new failures. Tests that assert on rendered log text are the usual casualty; rewrite them to assert on the state properties instead.
- Switch the console formatter to JSON (`"Console": { "FormatterName": "json" }` in `appsettings.Development.json`), hit one representative endpoint, and read the emitted `State` object. Every value you care about must appear as its own key, and `{OriginalFormat}` must contain placeholders rather than data.
- Grep the build output for `SYSLIB1015` (parameter with no matching placeholder) and `SYSLIB0025` (exception included in the template). Both are warnings you should fix rather than suppress.
- Confirm the generated source exists: `obj/Debug/net11.0/generated/Microsoft.Extensions.Logging.Generators/`. If the folder is empty, the attribute is on a non-`partial` member and the generator silently did nothing useful.
- Deploy to staging and compare log volume. It should be unchanged. A drop means a level guard got tightened by accident.

## Rollback plan

Every step is independently revertible with `git revert`, and no step changes a public API or a wire format. There is one caveat worth stating loudly: the moment your log backend starts indexing the new property names, dashboards and alerts built on them break if you revert the code. Roll back code first, then dashboards, and keep both changes in separate commits so the order is available to you.

The `.editorconfig` severity bump is also worth keeping even if you revert the code changes. Leaving CA2254 at `warning` stops new interpolated calls arriving while you decide.

## Gotchas we hit

**Braces in data throw a FormatException.** The interpolated form has a failure mode most teams meet in production first. `Microsoft.Extensions.Logging` treats the `message` argument as a format string and runs it through `LogValuesFormatter`, which rewrites `{Name}` to `{0}` and calls `string.Format`. If your interpolated result contains braces, for example because you logged a JSON payload, the formatter sees placeholders with no matching arguments and throws (`aspnet/Logging#351` is the canonical report). Message templates are immune: the JSON is an argument, never part of the format string.

```csharp
// .NET 11 -- throws FormatException at runtime when json contains { }
_logger.LogInformation($"Response: {json}");

// safe
_logger.LogInformation("Response: {Json}", json);
```

**Serilog's `{@Property}` is not a Microsoft.Extensions.Logging feature.** If you are on Serilog, `{@Order}` destructures the object into a structured value. The `[LoggerMessage]` generator will accept the template, but the `@` is Serilog's convention, handled by `Serilog.Extensions.Logging`. Do not assume it does anything on a plain OTLP or console provider. Use `[LogProperties]` when you want provider-independent expansion.

**Tests that assert on log text.** `Assert.Contains("Order 4711 failed", sink.Messages)` keeps passing through the migration, because the rendered message does not change. That is a trap: it means you can convert the codebase without your tests ever proving the properties exist. Add at least one test per subsystem that asserts on the state key.

**EF Core's own logs are already templated.** Do not "fix" them. If you are trying to get readable SQL out of the provider, [logging the SQL EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) is a configuration problem, not a call-site problem.

**A backend migration is a different job.** Converting call sites does not move logs anywhere. If OTLP is the destination, do this migration first so the templates are right, then follow [moving from Serilog to OpenTelemetry logging](/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/). Doing both at once means you cannot tell which change broke a dashboard.

## Sources

- [Compile-time logging source generation](https://learn.microsoft.com/en-us/dotnet/core/extensions/logger-message-generator), Microsoft Learn
- [High-performance logging in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/high-performance-logging), Microsoft Learn
- [Logging guidance for .NET library authors](https://learn.microsoft.com/en-us/dotnet/core/extensions/logging/library-guidance), Microsoft Learn
- [CA2254: Template should be a static expression](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2254), Microsoft Learn
- [CA1848: Use the LoggerMessage delegates](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1848), Microsoft Learn
- [API proposal: interpolated string overloads of ILogger extensions](https://github.com/dotnet/runtime/issues/111283), dotnet/runtime, closed as not planned
- [LogInformation(string) throws FormatException](https://github.com/aspnet/Logging/issues/351), aspnet/Logging
- [.NET 11 Preview 6 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-6/), .NET Blog
