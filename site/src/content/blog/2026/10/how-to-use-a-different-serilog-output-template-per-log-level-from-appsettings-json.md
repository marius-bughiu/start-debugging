---
title: "How to use a different Serilog output template per log level from appsettings.json"
description: "outputTemplate is fixed per sink, so per-level formatting needs either an ExpressionTemplate with {#if @l ...} blocks or two Logger sub-loggers with ByIncludingOnly / ByExcluding filters. Both configured purely from appsettings.json, tested on Serilog 4.4, Serilog.Settings.Configuration 10.0.1 and Serilog.Expressions 5.0."
pubDate: 2026-10-26
template: how-to
tags:
  - "dotnet"
  - "csharp"
  - "logging"
  - "serilog"
  - "aspnet-core"
---

A Serilog `outputTemplate` belongs to a sink, not to a level, so there is no `"outputTemplate": { "Error": "..." }` setting. You have two clean ways to get per-level formatting from `appsettings.json` alone. The first is to swap `outputTemplate` for a `formatter` of type `Serilog.Templates.ExpressionTemplate` (from the `Serilog.Expressions` package) and branch inside the template with `{#if @l in ['Error', 'Fatal']} ... {#else} ... {#end}`. The second is to write to two `"Name": "Logger"` sub-loggers, each with a `Filter` (`ByIncludingOnly` / `ByExcluding` on `@l`) and its own plain `outputTemplate`. Do not just add a second sink with `restrictedToMinimumLevel`: that is a lower bound, so every error is written twice. Everything below was run on .NET 10.0.302 SDK with Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0, Serilog.Sinks.Console 6.1.1 and Serilog.Sinks.File 7.0.0. The same JSON works unchanged on .NET 11.

## Why outputTemplate cannot vary by level

`outputTemplate` is a constructor argument of the console and file sinks. Internally the sink builds one `MessageTemplateTextFormatter` from that string and uses it for every event it receives. Serilog.Settings.Configuration just calls `WriteTo.Console(outputTemplate: "...")` for you, so whatever you put in JSON maps one-to-one to that single formatter. The level is available *inside* the template as `{Level}`, but a classic message template has no conditionals: it can print the level, it cannot change shape because of it.

So per-level output needs one of two things:

1. a formatter that can make decisions itself, which is what `ExpressionTemplate` is, or
2. separate pipelines, each with its own formatter, and a filter in front of each so an event enters exactly one of them.

Typical reasons to want this: short single-line output for `Debug` and `Information` in the console, but full timestamps, extra context properties and the stack trace for `Error` and `Fatal`; or a dedicated `errors.log` with a richer layout than the main log.

## The naive config that duplicates errors

This is the configuration most people try first, and the reason the question gets asked:

```json
// appsettings.json, Serilog 4.4.0, Serilog.Settings.Configuration 10.0.1
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } },
      { "Name": "Console", "Args": { "restrictedToMinimumLevel": "Error", "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj} ({SourceContext}){NewLine}{Exception}" } }
    ]
  }
}
```

The test program logs one event per level, with an exception on the `Error`:

```csharp
// Program.cs, .NET 10, Serilog 4.4.0
using Microsoft.Extensions.Configuration;
using Serilog;

var config = new ConfigurationBuilder().AddJsonFile(args[0]).Build();
Log.Logger = new LoggerConfiguration().ReadFrom.Configuration(config).CreateLogger();

var orderId = 42;
Log.Debug("Cache warm for {Region}", "eu-west");
Log.Information("Order {OrderId} accepted", orderId);
Log.Warning("Order {OrderId} took {Elapsed} ms", orderId, 1830);
try { throw new InvalidOperationException("Payment gateway timed out"); }
catch (Exception ex) { Log.Error(ex, "Order {OrderId} failed", orderId); }
Log.Fatal("Shutting down: {Reason}", "unrecoverable");
Log.CloseAndFlush();
```

The output:

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23 ERR] Order 42 failed
[09:04:23 ERR] Order 42 failed ()
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23 FTL] Shutting down: unrecoverable
[09:04:23 FTL] Shutting down: unrecoverable ()
```

`restrictedToMinimumLevel` only means "this level and above". The first sink has no upper bound, so `Error` and `Fatal` land in both. There is no `restrictedToMaximumLevel` argument. You need a real filter or a real conditional.

## Option 1: one sink, an ExpressionTemplate with #if blocks

`Serilog.Expressions` ships `ExpressionTemplate`, an `ITextFormatter` whose template language supports `{#if <expr>}`, `{#else if <expr>}`, `{#else}` and `{#end}`. The current level is `@l`. Serilog.Settings.Configuration can construct it straight from JSON because the console and file sinks have an overload that takes an `ITextFormatter formatter`, and the settings reader binds an object with a `type` key to that type's constructor.

1. Add the packages:

```bash
# .NET 10 SDK; package versions as of October 2026
dotnet add package Serilog.AspNetCore --version 10.0.0
dotnet add package Serilog.Expressions --version 5.0.0
```

`Serilog.AspNetCore` 10.0.0 brings in Serilog 4.x, Serilog.Settings.Configuration and the console and file sinks. In a plain console or worker app use `Serilog.Extensions.Hosting` (or the individual packages, as in the test project) instead.

2. Replace `outputTemplate` with a `formatter` object:

```json
// appsettings.json, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Console",
        "Args": {
          "formatter": {
            "type": "Serilog.Templates.ExpressionTemplate, Serilog.Expressions",
            "template": "{#if @l = 'Debug'}  dbg {@m}\n{#else if @l in ['Information', 'Warning']}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#else}[{@t:yyyy-MM-dd HH:mm:ss.fff} {@l:u3}] {@m} {Rest()}\n{#if @x is not null}{@x}{#end}{#end}"
          }
        }
      }
    ]
  }
}
```

3. Run it. Three different layouts come out of one sink:

```text
  dbg Cache warm for eu-west
[09:04:47 INF] Order 42 accepted
[09:04:47 WRN] Order 42 took 1830 ms
[2026-10-26 09:04:47.048 ERR] Order 42 failed {"OrderId":42}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[2026-10-26 09:04:47.051 FTL] Shutting down: unrecoverable {"Reason":"unrecoverable"}
```

The template syntax is not the classic one, so translate as you go:

| Classic `outputTemplate` | `ExpressionTemplate` |
| --- | --- |
| `{Timestamp:HH:mm:ss}` | `{@t:HH:mm:ss}` |
| `{Level:u3}` | `{@l:u3}` |
| `{Message:lj}` | `{@m}` (already renders strings without quotes) |
| `{Exception}` | `{@x}` |
| `{NewLine}` | a literal `\n` in the JSON string |
| `{Properties:j}` | `{Rest()}` or `{Rest(true)}` |
| `{SourceContext}` | `{SourceContext}` (unchanged) |

Two details from that table matter in practice. `{NewLine}` does not exist in expression templates; the `\n` in the JSON string is a real newline after JSON parsing, which is exactly what you want, so do not double-escape it. And `{@x}` already ends with a newline, so `{@x}\n` prints an empty line after every stack trace.

### Only show context properties when there are any

`Rest()` returns the event properties the *expression template* did not reference. It still includes the ones that appear in the message text, which is why `{"OrderId":42}` shows up above even though the message already says "Order 42". `Rest(true)` also excludes properties referenced in the message template, and you can guard it so an empty `{}` never prints:

```json
"template": "{#if @l in ['Error', 'Fatal']}[{@t:HH:mm:ss.fff} {@l:u3}] {@m}{#if Rest(true) <> {}} {Rest(true)}{#end}\n{@x}{#else}[{@t:HH:mm:ss} {@l:u3}] {@m}\n{#end}"
```

With a `TenantId` pushed through `LogContext` around the `Log.Error` call, that produces:

```text
[09:05:30 DBG] Cache warm for eu-west
[09:05:30 INF] Order 42 accepted
[09:05:30 WRN] Order 42 took 1830 ms
[09:05:30.374 ERR] Order 42 failed {"TenantId":"acme"}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 13
[09:05:30.383 FTL] Shutting down: unrecoverable
```

The `Fatal` line has no trailing braces because its only property, `Reason`, is already in the message.

## Option 2: two sub-loggers, each with its own outputTemplate

If you want to keep classic `outputTemplate` strings, or the two layouts go to different sinks (console vs file, Seq vs file), use the `Logger` sink. It creates a sub-logger with its own `Filter`, `WriteTo` and `Enrich` sections. The filter expressions again come from `Serilog.Expressions`, which adds `ByIncludingOnly(string expression)` and `ByExcluding(string expression)`.

1. Make the two filters complementary so each event goes to exactly one sub-logger:

```json
// appsettings.json, Serilog.Settings.Configuration 10.0.1, Serilog.Expressions 5.0.0
{
  "Serilog": {
    "Using": [ "Serilog.Sinks.Console", "Serilog.Expressions" ],
    "MinimumLevel": "Debug",
    "WriteTo": [
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByExcluding", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}" } } ]
          }
        }
      },
      {
        "Name": "Logger",
        "Args": {
          "configureLogger": {
            "Filter": [ { "Name": "ByIncludingOnly", "Args": { "expression": "@l in ['Error', 'Fatal']" } } ],
            "WriteTo": [ { "Name": "Console", "Args": { "outputTemplate": "[{Timestamp:HH:mm:ss.fff} {Level:u3}] {Message:lj} {Properties:j}{NewLine}{Exception}" } } ]
          }
        }
      }
    ]
  }
}
```

2. Run it. No duplicates, and the error branch gets milliseconds, properties and the exception:

```text
[09:04:23 DBG] Cache warm for eu-west
[09:04:23 INF] Order 42 accepted
[09:04:23 WRN] Order 42 took 1830 ms
[09:04:23.840 ERR] Order 42 failed {}
System.InvalidOperationException: Payment gateway timed out
   at Program.<Main>$(String[] args) in .../Program.cs:line 11
[09:04:23.842 FTL] Shutting down: unrecoverable {}
```

The `{}` is the classic `{Properties:j}` behaviour: it lists only the properties that are not already in the message, and there are none here. Unlike `Rest(true)`, it cannot be made conditional, which is one practical reason to prefer Option 1 for console output.

### When restrictedToMinimumLevel alone is enough

If the second layout only needs "this level and above" *and* it goes to a different destination, no filter is needed. A dedicated error file is the common case:

```json
// appsettings.json, Serilog.Sinks.File 7.0.0
{
  "Name": "File",
  "Args": {
    "path": "logs/errors-.log",
    "rollingInterval": "Day",
    "restrictedToMinimumLevel": "Error",
    "outputTemplate": "{Timestamp:o} [{Level:u3}] {Message:lj}{NewLine}{Properties:j}{NewLine}{Exception}"
  }
}
```

The duplication problem from the naive config only exists when both outputs end up in the same place.

## Wiring it into ASP.NET Core or a worker

Nothing about the template choice changes the hosting code. With Serilog.AspNetCore 10.0.0:

```csharp
// Program.cs, ASP.NET Core on .NET 10 / .NET 11, Serilog.AspNetCore 10.0.0
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSerilog((services, lc) => lc
    .ReadFrom.Configuration(builder.Configuration)
    .ReadFrom.Services(services));

var app = builder.Build();
app.MapGet("/", (ILogger<Program> log) =>
{
    log.LogError("Something failed for {OrderId}", 42);
    return "ok";
});
app.Run();
```

Because the formatter lives in configuration, you can give `appsettings.Development.json` a compact single-line template and `appsettings.Production.json` a JSON formatter, without touching code. The [Serilog plus Seq setup post](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) covers the bootstrap logger and `Log.CloseAndFlush()` around this.

## Gotchas found while testing

**Level comparisons are case-sensitive.** `@l = 'error'` is `false` for an `Error` event. Use the exact names `Verbose`, `Debug`, `Information`, `Warning`, `Error`, `Fatal`, or add the `ci` modifier: `@l = 'error' ci` evaluated to `true` in the test. `{#if}` also needs a real Boolean `true`; a non-Boolean value is not "truthy".

**A sub-logger cannot be more verbose than its parent.** With the root `"MinimumLevel": "Information"` and `"MinimumLevel": "Debug"` inside `configureLogger`, the sub-logger still printed nothing below `INF`. Events are dropped by the root logger before the `Logger` sink ever sees them. Set the root minimum to the lowest level any branch needs and raise it per branch.

**Missing properties leave their surrounding text behind.** Both template styles render a property the event does not have as nothing: the naive config's `({SourceContext})` printed `()`, and in an `ExpressionTemplate`, `(OrderId={OrderId})` on the `Fatal` event printed `(OrderId=)`. Only the expression template can fix it: wrap optional properties in `{#if OrderId is not null} ... {#end}`.

**Unknown names fail silently.** `"Enrich": [ "WithMachineName" ]` without the `Serilog.Enrichers.Environment` package installed did not throw. The only trace was this, after enabling `Serilog.Debugging.SelfLog.Enable(Console.Error)`:

```text
Unable to find a method called WithMachineName. Candidate methods are:
...
```

The same applies to a mistyped sink name or a filter name when `Serilog.Expressions` is not referenced. Turn on `SelfLog` the first time a template change appears to do nothing.

**Keep the `Using` section if you publish single-file.** Serilog.Settings.Configuration auto-discovers any dependency with "Serilog" in its name through the `.deps.json`, so the test project worked without `Using` at all. The project README notes that auto-discovery does not work in bundled (single-file) mode, so list `"Serilog.Expressions"` and every sink assembly explicitly.

**Environment variables override array entries by index.** A per-level template is a long string in `WriteTo:0:Args:formatter:template`. Overriding it from a container uses `Serilog__WriteTo__0__Args__formatter__template`, and the index shifts if someone reorders `WriteTo`. If templates differ per environment, prefer an `appsettings.{Environment}.json` file.

## Which option to pick

Use the `ExpressionTemplate` when the layouts share one destination, typically the console. It is one sink, one pass over the event, and it can do things sub-loggers cannot, such as hiding empty property bags. Use sub-loggers when the layouts go to different sinks or need different enrichers, or when a team prefers classic templates that everyone can read. Either way, the filter or condition must be written on `@l`; there is no level-keyed template setting to find.

## Related reading

- Start with [structured logging with Serilog and Seq in .NET 11](/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) if Serilog is not wired in yet.
- To make the per-level layout show who triggered an error, [add the current user ID to every log entry in ASP.NET Core](/2026/09/how-to-add-the-current-user-id-to-every-log-entry-in-aspnet-core/) with `LogContext`.
- Properties that appear in `Rest()` or `{Properties:j}` can leak secrets; [redact sensitive values with `[LogProperties]`](/2026/08/how-to-redact-sensitive-values-from-logs-with-logproperties-in-dotnet/) before they reach any template.
- `{@m}` and `{Message:lj}` only stay structured if call sites use message templates, which is what [migrating from `ILogger` string interpolation to message templates](/2026/07/migrate-from-ilogger-string-interpolation-to-message-templates-in-dotnet-11/) fixes.
- If you are leaving Serilog for OpenTelemetry instead, see [migrating from Serilog to OpenTelemetry logging](/2026/06/migrate-from-serilog-to-opentelemetry-logging-in-dotnet-11/).

## Sources

- [Serilog.Expressions README](https://github.com/serilog/serilog-expressions): `ExpressionTemplate`, `@l`/`@x` built-ins, `#if`/`#else if`, `Rest([deep])` and the `ci` modifier.
- [Serilog.Settings.Configuration README](https://github.com/serilog/serilog-settings-configuration): `Using` and auto-discovery (including the bundled-mode limitation), complex `formatter` binding with `type`, and sub-logger configuration.
- [Serilog wiki: Configuration Basics](https://github.com/serilog/serilog/wiki/Configuration-Basics): sub-loggers and why they cannot lower the parent's minimum level.
- [Serilog.Sinks.Console](https://github.com/serilog/serilog-sinks-console) and [Serilog.Sinks.File](https://github.com/serilog/serilog-sinks-file): `outputTemplate`, `formatter` and `restrictedToMinimumLevel` parameters.
- [Serilog.AspNetCore](https://github.com/serilog/serilog-aspnetcore): `AddSerilog` with `ReadFrom.Configuration` and `ReadFrom.Services`.
