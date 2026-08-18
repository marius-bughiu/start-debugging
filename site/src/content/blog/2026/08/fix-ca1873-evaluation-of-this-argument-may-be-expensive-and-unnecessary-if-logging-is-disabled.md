---
title: "Fix: CA1873 \"Evaluation of this argument may be expensive and unnecessary if logging is disabled\""
description: "CA1873 fires on the implicit params object[] allocation, so almost every LogDebug call trips it. Fix it with [LoggerMessage] or an IsEnabled guard."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "logging"
  - "analyzers"
  - "performance"
---

CA1873 is a Performance analyzer that ships enabled in the .NET 10 SDK as a **suggestion**, not a warning, so it shows up in Visual Studio, Rider, and `dotnet format` but leaves `dotnet build` clean. It fires on the implicit `params object?[]` array that every `ILogger.LogDebug` style call allocates, which means it triggers on essentially every structured logging call with at least one argument, even a plain string. The real fix is `[LoggerMessage]` source generation; the quick fix is an `IsEnabled` guard whose level matches the call exactly.

The diagnostic text you are searching for:

```text
warning CA1873: Evaluation of this argument may be expensive and unnecessary if logging is disabled
```

Everything below was verified against SDK `10.0.201`, `Microsoft.Extensions.Logging` 10.0.0, and C# 14, with the analyzer source read from `dotnet/sdk`.

## What makes CA1873 invisible in dotnet build?

Because its default severity in .NET 10 is suggestion (info), and info-level diagnostics are not printed by `dotnet build` and are not affected by `TreatWarningsAsErrors`.

A project with a dozen `LogDebug` calls builds completely clean:

```text
    0 Warning(s)
    0 Error(s)
```

Turn it into a real warning in one of two ways:

```xml
<!-- .NET 10 SDK 10.0.201: promotes every "All"-mode analyzer, CA1873 included -->
<PropertyGroup>
  <AnalysisMode>All</AnalysisMode>
</PropertyGroup>
```

```ini
# .editorconfig, targeted at just this rule
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = warning
```

The same project then reports 12 CA1873 warnings. If you are wiring analyzer severities into CI, the tradeoffs are covered in [keeping TreatWarningsAsErrors out of your inner-loop builds](/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/).

## How can an obviously cheap argument still trigger CA1873?

This is the part that sends people to search engines. The rule does not only look at your argument. It looks at the **implicit `params object?[]` array** the compiler creates to pass that argument, and a non-empty array creation is itself reported as expensive.

`LoggerExtensions.LogDebug` has no non-params overload that takes message arguments:

```csharp
// Microsoft.Extensions.Logging.Abstractions 10.0.0
public static void LogDebug(this ILogger logger, string? message, params object?[] args);
```

So `_logger.LogDebug("v {V}", x)` compiles to an `object[1]` allocation regardless of what `x` is. The analyzer's expense check treats any array creation as a violation unless the array is empty:

```csharp
// dotnet/sdk, AvoidPotentiallyExpensiveCallWhenLogging.cs
static bool IsEmptyImplicitParamsArrayCreation(IArrayCreationOperation arrayCreationOperation) =>
    arrayCreationOperation.IsImplicit &&
    arrayCreationOperation.DimensionSizes.Length == 1 &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.HasValue &&
    arrayCreationOperation.DimensionSizes[0].ConstantValue.Value is int size &&
    size == 0;
```

I built a matrix to confirm what actually trips it. Every one of these produced CA1873 on SDK 10.0.201:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Logging.Abstractions 10.0.0
public void StringProp(Order o) => _logger.LogDebug("v {V}", o.Name);      // CA1873
public void IntProp(Order o)    => _logger.LogDebug("v {V}", o.Id);        // CA1873
public void StringField()       => _logger.LogDebug("v {V}", _nameField);  // CA1873
public void StringLocal()       { var s = "a"; _logger.LogDebug("v {V}", s); }  // CA1873
public void StringParam(string s) => _logger.LogDebug("v {V}", s);         // CA1873
public void ConstInt()          => _logger.LogDebug("v {V}", 42);          // CA1873
```

Only a call with no message arguments at all escapes, because then the implicit params array has length zero:

```csharp
public void LiteralOnly() => _logger.LogDebug("nothing to see");           // clean
```

That is the whole surprise. There is nothing wrong with `o.Name`. A November 2025 change titled "Reduce noise from CA1873" specifically exempted property accesses, `GetType`, `GetHashCode`, and `Stopwatch.GetTimestamp` from the expense check, but that exemption applies to the array's *elements*, while the array allocation itself is still flagged. For the params-based overloads the noise reduction is invisible.

## What is the minimal repro?

```csharp
// .NET 10 (SDK 10.0.201), C# 14
// dotnet new console + Microsoft.Extensions.Logging.Abstractions 10.0.0
using Microsoft.Extensions.Logging;

public class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order)
    {
        // CA1873: Evaluation of this argument may be expensive
        // and unnecessary if logging is disabled
        logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
    }
}
```

With `<AnalysisMode>All</AnalysisMode>` or an explicit severity in `.editorconfig`, that single call reports CA1873.

## How do I fix CA1873 properly?

Use the `[LoggerMessage]` source generator. It emits a strongly typed method with no params array and no boxing, so there is nothing left for the analyzer to flag and nothing for the runtime to allocate when the level is disabled.

```csharp
// .NET 10, C# 14. The class must be partial.
public partial class OrderService(ILogger<OrderService> logger)
{
    public void Process(Order order) => LogOrder(order.Id, order.Customer);

    [LoggerMessage(Level = LogLevel.Debug, Message = "Order {OrderId} for {Customer}")]
    private partial void LogOrder(int orderId, string customer);
}
```

The generated method checks `IsEnabled` before touching its arguments, so the analyzer stays quiet and the call is free when Debug is off. This is the same mechanism behind [replacing new Regex(...) with the GeneratedRegex source generator](/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/); if the pattern is unfamiliar, start with [what a source generator is and when you need one](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/).

## When is an IsEnabled guard enough?

When you want a one-line change and do not want to restructure the class into a partial type. The analyzer recognises the guard and suppresses the diagnostic:

```csharp
// .NET 10, C# 14
if (logger.IsEnabled(LogLevel.Debug))
{
    logger.LogDebug("Order {OrderId} for {Customer}", order.Id, order.Customer);
}
```

Two constraints, both of which I verified produce a diagnostic when violated:

**The level must match exactly.** Guarding a `LogDebug` with `IsEnabled(LogLevel.Information)` still reports CA1873, because the analyzer compares the constant in the guard against the level of the call:

```csharp
if (logger.IsEnabled(LogLevel.Information))
{
    logger.LogDebug("v {V}", order.Describe());   // CA1873, levels differ
}
```

**The guard must be inline.** Hoisting it behind a property or helper defeats the check entirely, because the analyzer walks enclosing operations looking for a literal `ILogger.IsEnabled` invocation:

```csharp
private bool DebugOn => logger.IsEnabled(LogLevel.Debug);

public void Process(Order order)
{
    if (DebugOn) { logger.LogDebug("v {V}", order.Describe()); }   // CA1873
}
```

## How much does the unguarded call actually cost?

Enough to matter in a hot path, and nothing at all outside one. Measured with BenchmarkDotNet 0.15.4 on .NET 10.0.5, Intel Core Ultra 7 265KF, with the minimum level set to `Information` so the Debug call is disabled:

| Method | Mean | Ratio | Allocated |
| --- | ---: | ---: | ---: |
| Unguarded | 13.22 ns | 1.00 | 64 B |
| Guarded | 0.27 ns | 0.02 | 0 B |
| SourceGenerated | 0.51 ns | 0.04 | 0 B |

The 64 bytes are the `object[2]` array plus the boxed `int`. Both fixes drop it to zero. Note the ratio, not just the nanoseconds: 13 ns per call is irrelevant on a request handler that runs a database query, and very relevant in a loop that runs a million times. That is exactly why the rule ships as a suggestion rather than a warning.

## Which log levels does CA1873 check?

By default, Information and below. The design rationale from the analyzer's own commit history is that hot paths log at Debug and Trace, while Warning and Error are rare enough that per-call overhead does not matter.

There is also an undocumented `.editorconfig` knob to change the threshold:

```ini
# Not listed on the CA1873 docs page. Values: trace, debug, information, warning, error, critical
[*.{cs,vb}]
dotnet_code_quality.CA1873.max_log_level = warning
```

Sweeping every value on SDK 10.0.201 gives this, and it exposes a bug:

| `max_log_level` | Levels that report CA1873 |
| --- | --- |
| `trace` | Trace, **Critical** |
| `debug` | Trace, Debug, **Critical** |
| `information` (default) | Trace, Debug, Information, **Critical** |
| `warning` | Trace, Debug, Information, Warning, Critical |
| `error` | all six |

`LogCritical` reports at every threshold, including `trace`. That is an off-by-one: the shipped comparison excludes Critical from the range it bails out on.

```csharp
// dotnet/sdk commit 574cda32, "CA1873: Fix log level comparison"
-                    logLevel < LogLevelCritical &&
+                    logLevel <= LogLevelCritical &&
```

The fix landed in `dotnet/sdk` on 2026-06-19, after SDK 10.0.201 shipped. Until you move to an SDK that carries it, `LogCritical` calls will keep reporting CA1873 no matter how you configure `max_log_level`. Suppress those individually rather than disabling the rule.

## Known false positive: guarded source-generated calls

If you wrap a source-generated log method in an `IsEnabled` check, the analyzer still reports CA1873. This is tracked as an open issue against the analyzer, and it reproduces on SDK 10.0.201:

```csharp
// .NET 10, C# 14. Guarded, source-generated, still reports CA1873.
if (logger.IsEnabled(LogLevel.Information))
{
    LogKeys([.. dictionary.Select(p => p.Key)]);
}

[LoggerMessage(Level = LogLevel.Information, Message = "keys {Keys}")]
private partial void LogKeys(string[] keys);
```

The guard only registers when it wraps a recognised `ILogger` call. A generated method is an ordinary method as far as the analyzer is concerned, so the collection expression argument is evaluated on its own merits and flagged. Suppress this one locally until the fix ships:

```csharp
#pragma warning disable CA1873
    LogKeys([.. dictionary.Select(p => p.Key)]);
#pragma warning restore CA1873
```

## Lookalikes that land on this page by mistake

**CA1848** ("For improved performance, use the LoggerMessage delegates") fires on the same call sites and has the same fix, but it is about the message template parsing cost on every call, not about argument evaluation. You will usually see both together, and `[LoggerMessage]` clears both.

**CA2254** ("The logging message template should not vary between calls") is about string interpolation destroying your structured fields. If that is what you are actually chasing, see [migrating from ILogger string interpolation to message templates](/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/), which also covers `SkipEnabledCheck` and `[LogProperties]`.

## Should you just turn it off?

For a codebase that logs at Information on request paths and does not have measured hot loops, yes. Set it to `none` and revisit when you have a profile that says logging overhead matters:

```ini
[*.{cs,vb}]
dotnet_diagnostic.CA1873.severity = none
```

The more useful middle ground is leaving it at its default suggestion severity and applying `[LoggerMessage]` opportunistically. You get the IDE nudge on the call sites you touch, no CI noise, and zero-allocation logging accumulates over time instead of arriving as a 400-file refactor. The allocation win is real, it is just not urgent, and the params array behind it is the same one C# 13 [started eliminating for other APIs](/2026/01/c-13-the-end-of-params-allocations/).

## Related

- [Migrate from ILogger string interpolation to structured logging message templates in .NET 11](/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/)
- [How to redact sensitive values from logs with LogProperties in .NET](/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/)
- [What is a source generator and when do I need one?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [TreatWarningsAsErrors without sabotaging dev builds (.NET 10)](/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/)
- [C# 13: The End of params Allocations](/2026/01/c-13-the-end-of-params-allocations/)

## Sources

- [CA1873: Avoid potentially expensive logging](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1873) on MS Learn
- [Add CA1873: Avoid potentially expensive logging](https://github.com/dotnet/roslyn-analyzers/pull/7290), the original analyzer PR
- [Reduce noise from CA1873](https://github.com/dotnet/sdk/commit/bb4aee4d), which added the `max_log_level` option and the property-access exemption
- [CA1873: Fix log level comparison](https://github.com/dotnet/sdk/commit/574cda32), the `LogCritical` off-by-one fix
- [CA1873 false positives when the log message is wrapped in an IsEnabled check](https://github.com/dotnet/roslyn-analyzers/issues/7690)
- [LoggerMessageAttribute](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.logging.loggermessageattribute) API reference
