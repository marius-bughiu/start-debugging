---
title: "Quartz.NET 4.2 Turns Bad Cron Expressions into Build Errors"
description: "Quartz.NET 4.2.0 ships a Roslyn analyzer that rejects unparseable cron literals as QZ0001 at compile time, plus a source generator that turns [QuartzJob] and [CronTrigger] attributes into an AddDeclaredJobs() registration. Here is what it checks, what the generated code looks like, and how to opt out."
pubDate: 2026-09-28
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "source-generators"
  - "roslyn-analyzers"
---

Most Quartz.NET users have shipped a cron expression that looked fine in review and threw a `FormatException` at startup. [Quartz.NET 4.2.0](https://github.com/quartznet/quartznet/releases/tag/v4.2.0), released on September 25, 2026 and followed by the 4.2.1 patch on September 27, moves that failure to the compiler. The `Quartz` package now carries its own analyzer and source generator, with no extra package to install.

## QZ0001: the cron parser runs at build time

The analyzer inspects every cron literal or constant passed to `WithCronSchedule`, `CronScheduleBuilder.Create`, the `CronExpression` constructors, `CronCalendar` and `CronTriggerImpl`. It does not use a second grammar: it links the scheduler's own parser sources, and a parity corpus of 128 expressions keeps the two in agreement. If the compiler accepts a literal, the scheduler accepts it too.

```csharp
q.AddTrigger(t => t
    .ForJob(jobKey)
    .WithCronSchedule("0 12 * * 1-5"));
// error QZ0001, reported on the literal with the parser's own message
```

That example is the classic mistake: a five-field crontab expression copied from Linux. Quartz reads six or seven fields (seconds first) and wants `?` in one of the two day fields, so the Quartz version is `"0 0 12 ? * MON-FRI"`. If you really mean the Unix grammar, pass `CronFormat.Unix` as a literal and the analyzer validates against that instead.

Three more rules ship alongside it:

- **QZ0002** (error): a `[JobTimeout("...")]` value that does not parse or is negative.
- **QZ0003** (warning): `[PersistJobDataAfterExecution]` without `[DisallowConcurrentExecution]`, where two concurrent firings can overwrite each other's job data map.
- **QZ0004** (info): an `Execute` method that never observes its `CancellationToken`.

## Declaring the job on its class

The second half of the feature is a generator that reads `[QuartzJob]` and `[CronTrigger]` from your `IJob` types:

```csharp
[QuartzJob(Name = "cleanup", Group = "maintenance")]
[CronTrigger("0 0 0/6 * * ?")]
[CronTrigger("0 0 12 ? * MON-FRI", Name = "cleanup-weekday-noon", TimeZone = "Europe/Helsinki")]
public sealed class CleanupJob : IJob
{
    public ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
        => default;
}

services.AddQuartz(q => q.AddDeclaredJobs());
services.AddQuartzHostedService();
```

`AddDeclaredJobs()` is generated into your assembly as an `internal` extension on `IQuartzBuilder`. It contains the exact `AddJob<T>` and `AddTrigger<T>` calls you would have written by hand, so there is no assembly scanning and nothing to root for trimming or Native AOT. The cron strings in the attributes go through QZ0001 like any other literal. Set `<EmitCompilerGeneratedFiles>true</EmitCompilerGeneratedFiles>` if you want to read the generated `QuartzDeclaredJobs.g.cs`.

The generator has its own guard rails: `QZ1001` rejects the attribute on a type that is not a concrete `IJob`, `QZ1002` rejects two declarations with the same identity, and `QZ1003` rejects a `[CronTrigger]` without `[QuartzJob]`. A job with no trigger is forced to `Durable = true` so the store does not delete it immediately.

## Upgrade notes

The analyzer is on by default, which means an existing project with a broken literal stops building. That is the intent, but also watch QZ0003 under `TreatWarningsAsErrors`. To turn the whole thing off, set this in the project file:

```xml
<PropertyGroup>
  <DisableQuartzAnalyzers>true</DisableQuartzAnalyzers>
</PropertyGroup>
```

The release notes point out that `ExcludeAssets="analyzers"` on the package reference does not disable it on the .NET 10 SDK. Individual severities can still be tuned in `.editorconfig`.

If you use a persistent job store, 4.2 also requires the `database/migrations/4.2/add_continuations_<dialect>.sql` migration before the first 4.2 node starts, because of the new trigger continuations feature. And if you enable the new database-backed execution history on a schema created from `tables_sqlServerMOT.sql` or `tables_sqlServer_Below2016.sql`, go straight to [4.2.1](https://github.com/quartznet/quartznet/releases/tag/v4.2.1), which fixes the missing `RETRY_ATTEMPT` column.

If you are still deciding whether Quartz is the right scheduler at all, I compared it with the alternatives in [Hangfire vs Quartz.NET vs IHostedService](/2026/06/hangfire-vs-quartz-net-vs-ihostedservice-for-scheduled-llm-jobs/).
