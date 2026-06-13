---
title: "Hangfire vs Quartz.NET vs IHostedService for scheduled LLM jobs"
description: "Use Quartz.NET when an LLM job must run on a real cron and never overlap itself, Hangfire when each run must survive a restart and retry on rate limits, and a plain BackgroundService only for a loose in-process loop. A decision matrix with the cron and concurrency gotchas that pick for you."
pubDate: 2026-06-13
template: vs
tags:
  - "comparison"
  - "llm"
  - "ai-agents"
  - "dotnet"
  - "hangfire"
  - "quartz-net"
---

If you are running an LLM call on a schedule from a .NET 11 app -- a nightly digest that summarises yesterday's tickets, a 6am agent that triages new GitHub issues, a recurring eval that scores model output -- the short answer is: reach for **Quartz.NET** when the firing schedule is the hard part and a run must never overlap the previous one, **Hangfire** when each run must survive a deploy and retry itself after a `rate_limit_error`, and a plain **`BackgroundService`** only when the cadence is loose ("roughly every 10 minutes") and losing a run on restart is fine. The trap people fall into is using a `BackgroundService` with a `PeriodicTimer` for everything, then hand-rolling cron math, restart durability, and an overlap guard badly. LLM jobs make those three concerns sharp because a single run is slow (seconds to minutes), costs real money per fire, and breaks under concurrency in ways a fast CPU-bound job does not.

All examples target .NET 11 and C# 14. Quartz.NET examples use Quartz 3.18.x (`Quartz.Extensions.Hosting`); Hangfire examples use Hangfire 1.8.x. Model IDs are `claude-sonnet-4-6` and `claude-opus-4-7`; the scheduling argument is the same whichever provider you call.

This post is the scheduling-specific cousin of the broader [BackgroundService vs IHostedService vs Hangfire decision matrix](/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/). That post answers "what runs background work in-process versus durably." This one answers a narrower question: given that the work is *one LLM call on a calendar schedule*, which scheduler do you pick, and what bites you.

## The feature matrix

Read the "Cron scheduling" and "Prevents overlapping runs" rows first. For LLM jobs, those two split the field more than durability does.

| Concern for a scheduled LLM job        | BackgroundService           | Quartz.NET 3.18              | Hangfire 1.8                   |
| -------------------------------------- | --------------------------- | --------------------------- | ------------------------------ |
| Built into .NET 11                     | yes                         | no (NuGet)                  | no (NuGet + storage)           |
| Extra infrastructure                   | none                        | none (in-memory store)      | SQL Server / Redis / Postgres  |
| Real cron expressions                  | no (you compute next fire)  | yes (Quartz cron, 6-7 field)| yes (Cronos, 5-field)          |
| Prevents the job overlapping itself    | you write the lock          | `[DisallowConcurrentExecution]` | `[DisableConcurrentExecution]` (caveats) |
| Survives a process restart             | no                          | only with `AdoJobStore`     | yes (always)                   |
| Automatic retry on `rate_limit_error`  | you write it                | you write it (or `IJobExecutionContext`) | yes, configurable backoff |
| Skips missed fires after downtime      | n/a                         | misfire instructions        | `MisfireHandlingMode.Ignorable`|
| Runs once across N replicas            | runs on every replica       | clustered store needed      | shared storage, runs once      |
| Dashboard / run history                | none                        | none (logs only)            | built-in dashboard             |
| Timezone-aware cron                    | you handle DST              | `InTimeZone(...)`           | `RecurringJobOptions.TimeZone` |

`BackgroundService` is the wrong default for *scheduled* LLM work, and the table shows why: every row that matters for a calendar job is "you write it." It earns its place only for the loose-loop case at the end.

## Why LLM jobs stress the scheduler differently

A scheduled job that increments a counter forgives a sloppy scheduler. A scheduled LLM call does not, for three reasons:

- **Each run is slow.** Summarising a 50k-token context on `claude-opus-4-7` is seconds to minutes, not milliseconds. A schedule of "every 5 minutes" plus a run that occasionally takes 8 minutes means fires *will* pile up unless the scheduler blocks overlap. Two copies of the same digest job running at once double your spend and can write conflicting results.
- **Each run costs money.** A duplicate fire is not a wasted CPU slice; it is a second billable API call against the same input tokens. Misfire handling stops being a tidy-up detail and becomes a budget control. If the box was down at 2am, do you really want six skipped nightly runs all firing at once when it comes back?
- **Each run fails in a retryable way.** `rate_limit_error` (HTTP 429) and transient `overloaded_error` (HTTP 529) are normal in a long agent loop, not exceptional. The scheduler's retry policy is doing real work here. I covered the retry side in depth in [fixing rate_limit_error in a long agent loop](/2026/05/fix-rate-limit-error-on-claude-sonnet-4-6-in-a-long-agent-loop/); the question on this page is which scheduler gives you that retry for free.

Keep those three in mind through the code below. They are why the recommendation lands where it does.

## Quartz.NET: when the schedule is the hard part

Quartz.NET is a scheduling engine first. Its cron support is the richest of the three, and `[DisallowConcurrentExecution]` is the cleanest answer to "this slow job must never run twice at once." Register it through the hosted-service integration:

```csharp
// .NET 11, C# 14 -- Program.cs, Quartz 3.18.x
builder.Services.AddQuartz(q =>
{
    var jobKey = new JobKey("nightly-digest");
    q.AddJob<NightlyDigestJob>(opts => opts.WithIdentity(jobKey));

    q.AddTrigger(opts => opts
        .ForJob(jobKey)
        .WithIdentity("nightly-digest-trigger")
        .WithCronSchedule("0 0 2 * * ?", x => x          // 02:00 every day -- note: SECONDS field first
            .InTimeZone(TimeZoneInfo.Utc)
            .WithMisfireHandlingInstructionDoNothing())); // missed a fire? skip it, wait for tomorrow
});

// WaitForJobsToComplete lets an in-flight LLM call finish on shutdown instead of being torn off mid-request.
builder.Services.AddQuartzHostedService(opts => opts.WaitForJobsToComplete = true);
```

The job implements `IJob`, and the attribute is what guarantees a slow run never overlaps the next scheduled fire:

```csharp
// .NET 11, C# 14 -- Quartz 3.18.x
[DisallowConcurrentExecution] // keyed by JobKey: a second fire waits until this one finishes
public sealed class NightlyDigestJob(
    IClaudeClient claude,
    IDigestStore store,
    ILogger<NightlyDigestJob> logger) : IJob
{
    public async Task Execute(IJobExecutionContext context)
    {
        var ct = context.CancellationToken; // tripped on shutdown; flow it into the API call
        var input = await store.GetYesterdaysTicketsAsync(ct);

        // claude-opus-4-7 summarisation -- the slow, billable part
        var digest = await claude.SummariseAsync(input, model: "claude-opus-4-7", ct);

        await store.SaveDigestAsync(digest, ct);
        logger.LogInformation("Digest built: {Tokens} input tokens", digest.InputTokens);
    }
}
```

Two Quartz details that matter specifically for LLM work:

- **`[DisallowConcurrentExecution]` is keyed by `JobKey`.** If the 2am run is still talking to the API at 2:08 and you also have a "catch up every 5 minutes" trigger on the same job, the 2:05 fire blocks until the 2:00 one returns. That is exactly the behaviour you want for an expensive call. It does *not* serialise across a cluster unless you run a clustered `AdoJobStore`.
- **Misfire instructions decide what downtime costs you.** `WithMisfireHandlingInstructionDoNothing()` means a fire missed while the host was down is simply skipped; the job waits for its next scheduled slot. The alternative, `WithMisfireHandlingInstructionFireAndProceed()`, fires once immediately on recovery then resumes the schedule. For a billable LLM job you almost always want `DoNothing` -- a surprise catch-up run, or worse a flurry of them, is real money. The default "smart policy" can fire catch-ups, so set this explicitly.

The cost of Quartz: by default the store is in-memory, so a restart loses scheduled state and any not-yet-fired triggers. To make schedules survive a restart you must configure the ADO.NET job store (`AdoJobStore`) against a database, at which point you are carrying the same operational weight as Hangfire without the dashboard. If durability is the headline requirement, that is a signal to use Hangfire instead.

## Hangfire: when each run must survive a deploy and retry itself

Hangfire writes every job to storage before running it and retries failures automatically. For a scheduled LLM job, "retry on 429 with backoff" and "do not lose the run if we deploy mid-call" come out of the box.

```csharp
// .NET 11, C# 14 -- Hangfire 1.8.x, Program.cs
builder.Services.AddHangfire(cfg => cfg
    .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
    .UseSimpleAssemblyNameTypeSerializer()
    .UseRecommendedSerializerSettings()
    .UseSqlServerStorage(builder.Configuration.GetConnectionString("HangfireDb")));

builder.Services.AddHangfireServer();

var app = builder.Build();

// Cron here is 5-field Cronos, NOT Quartz's 6-field. "0 2 * * *" = 02:00 daily.
RecurringJob.AddOrUpdate<IDigestService>(
    "nightly-digest",
    s => s.BuildAsync(CancellationToken.None),
    "0 2 * * *",
    new RecurringJobOptions
    {
        TimeZone = TimeZoneInfo.Utc,
        MisfireHandling = MisfireHandlingMode.Ignorable // skip missed fires, added in 1.8
    });
```

The retry policy is the reason to pick Hangfire for LLM jobs. Decorate the method and Hangfire re-enqueues on failure with increasing delays:

```csharp
// .NET 11, C# 14 -- Hangfire 1.8.x
public sealed class DigestService(IClaudeClient claude, IDigestStore store) : IDigestService
{
    // Retry 429/529 a few times with backoff; OnAttemptsExceeded leaves it failed in the dashboard.
    [AutomaticRetry(Attempts = 4, DelaysInSeconds = new[] { 30, 120, 300, 900 })]
    [DisableConcurrentExecution(timeoutInSeconds: 600)]
    public async Task BuildAsync(CancellationToken ct)
    {
        var input = await store.GetYesterdaysTicketsAsync(ct);
        var digest = await claude.SummariseAsync(input, model: "claude-sonnet-4-6", ct);
        await store.SaveDigestAsync(digest, ct);
    }
}
```

The honest caveat: `[DisableConcurrentExecution]` in Hangfire is a distributed lock held in storage, and it is weaker than Quartz's in-process guard. If a recurring job runs every minute but a run takes longer than the cron interval, or the storage connection that holds the lock drops, you can still see overlapping executions -- a [documented, long-standing edge case](https://github.com/HangfireIO/Hangfire/issues/1457). For a once-a-day digest this never bites. For a "check every minute" agent loop that occasionally runs long, do not rely on `DisableConcurrentExecution` alone; widen the interval or add an application-level idempotency key.

Hangfire's other LLM-relevant win is the dashboard. When a nightly summarisation silently produces garbage, being able to open `/jobs`, see the failed attempt, and read the exception with its stack trace is worth a lot more than grepping logs. Lock that endpoint down in production.

## BackgroundService: only for the loose in-process loop

A plain `BackgroundService` has no cron, no persistence, and no overlap guard. You write all three. For a scheduled LLM job that is usually the wrong trade, but it is the right tool when the cadence is loose and a missed run is harmless -- "poll for new documents roughly every 10 minutes and summarise any you find."

```csharp
// .NET 11, C# 14 -- the loose-loop case only
public sealed class SummariserLoop(
    IServiceScopeFactory scopeFactory,
    ILogger<SummariserLoop> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(10));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var svc = scope.ServiceProvider.GetRequiredService<IDigestService>();
                await svc.BuildAsync(stoppingToken); // overlap is impossible here: one loop, awaited
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Summariser tick failed; will retry next tick");
            }
        }
    }
}
```

Because the loop awaits each call before the next tick, this single instance cannot overlap itself -- you get the concurrency property for free *as long as you run one replica*. Scale to three replicas and you have three uncoordinated loops calling the API in parallel. A `BackgroundService` is a singleton, so inject `IServiceScopeFactory` and open a scope per tick rather than a scoped `DbContext` directly; the details are in [using scoped services inside a BackgroundService](/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/). And flow `stoppingToken` into the API call so a deploy [cancels the in-flight request cleanly](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) instead of leaking it.

## When to pick each

**Pick Quartz.NET when:**

- The schedule is genuinely calendar-based ("first weekday of the month at 6am", "every weekday at 09:30 Europe/London") and you want timezone- and DST-correct firing without hand-rolled date math.
- A slow run must never overlap the next fire, and you want that guarantee in-process and immediate rather than via a storage lock. `[DisallowConcurrentExecution]` is the strongest of the three.
- You do not need durable run history -- in-memory scheduling is acceptable, or you are willing to configure `AdoJobStore`.

**Pick Hangfire when:**

- A run must survive a restart or deploy, full stop. The job is written to storage before it runs.
- You want automatic retry with backoff for `rate_limit_error` / `overloaded_error` without writing a Polly policy yourself.
- You want a dashboard to see which scheduled LLM runs succeeded, failed, and why -- and single execution across replicas without building a distributed lock.

**Pick a `BackgroundService` when:**

- The cadence is loose and approximate, not a real cron, and a skipped or lost run costs nothing.
- You run a single instance (or the work is idempotent) and want zero new infrastructure.
- The work is a continuous poll-and-summarise loop, not a "fire at 02:00" calendar event.

## The dollars-per-misfire picture

Performance throughput is the wrong lens for scheduled LLM jobs; the cost that matters is dollars per accidental or duplicated run. A single nightly digest sending tens of thousands of input tokens against `claude-opus-4-7` is a non-trivial line item, and the failure modes each have a price:

| Failure mode                      | BackgroundService           | Quartz.NET                    | Hangfire                       |
| --------------------------------- | --------------------------- | ----------------------------- | ------------------------------ |
| Overlapping runs (double billing) | possible across replicas    | blocked in-process            | mostly blocked; storage caveat |
| Catch-up flood after downtime     | n/a (no schedule state)     | `DoNothing` misfire = skipped | `Ignorable` = skipped          |
| Lost run on deploy                | yes (re-driven next tick)   | yes (unless `AdoJobStore`)    | no -- re-run from storage      |
| Wasted spend on un-retried 429    | unless you add Polly        | unless you add Polly          | retried automatically          |

The structural point: with the wrong scheduler the expensive failure is not slowness, it is paying twice. Quartz removes the overlap charge; Hangfire removes the lost-run and un-retried charge. If your input is large and repetitive across runs, the bigger lever is upstream of all three: see when [prompt caching pays off on Sonnet 4.6 versus Opus 4.7](/2026/06/prompt-caching-on-claude-sonnet-4-6-vs-claude-opus-4-7-when-it-pays-off/), because caching a stable system prompt across scheduled runs can dwarf the scheduler choice on the bill.

## The gotcha that picks for you

Two things end the debate before preference enters.

1. **The cron dialects are not the same string.** Quartz cron is 6 or 7 fields and starts with **seconds** (`0 0 2 * * ?` is 02:00:00 daily). Hangfire cron is 5-field Cronos and starts with **minutes** (`0 2 * * *` is the same time). Paste a Quartz expression into Hangfire and it either throws or, worse, parses into a wrong-but-valid time and fires at an hour you did not intend -- the kind of bug you find on the bill. Whichever you pick, validate the expression against that library's parser, not a generic online cron tool.

2. **"Must survive a restart" versus "must never overlap" usually points at different tools.** If the dominant requirement is durability -- the 2am run absolutely must happen even if you deploy at 01:59 -- Hangfire is the answer and its concurrency lock is good enough for a daily job. If the dominant requirement is strict no-overlap on a fast cadence -- an expensive job fired every few minutes that must serialise perfectly -- Quartz's in-process `[DisallowConcurrentExecution]` is stronger, and you add durability only if you actually need it via `AdoJobStore`. Trying to get bulletproof both-at-once from one library is where people overbuild. Pick the dominant axis.

## The recommendation, restated

Default to **Quartz.NET** for scheduled LLM jobs where the calendar schedule and strict non-overlap are the hard parts, and accept the in-memory store unless you specifically need durable schedule state. Move to **Hangfire** the moment a run must survive a restart or you want automatic 429 retries and a dashboard for free -- the database it brings is the price of those guarantees, and for once-a-day jobs its concurrency caveat never bites. Use a plain **`BackgroundService`** only for a single-instance, loss-tolerant, loose-cadence loop, and know that you are signing up to write the cron, the retry, and the overlap guard yourself. If your scheduled job is really "run Claude Code on a timer" rather than "call the API from .NET," that is a different shape entirely -- see [scheduling a recurring Claude Code task that triages GitHub issues](/2026/04/how-to-schedule-a-recurring-claude-code-task-that-triages-github-issues/). And for the broader, non-LLM background-work decision, the full [BackgroundService vs IHostedService vs Hangfire matrix](/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/) covers the durability axis in more depth.

## Sources

- [Quartz.NET hosted services integration](https://www.quartz-scheduler.net/documentation/quartz-3.x/packages/hosted-services-integration.html) -- Quartz.NET docs
- [Quartz.NET CronTrigger tutorial](https://www.quartz-scheduler.net/documentation/quartz-3.x/tutorial/crontriggers.html) -- Quartz.NET docs
- [DisallowConcurrentExecution](https://www.quartz-scheduler.org/api/2.3.0/org/quartz/DisallowConcurrentExecution.html) -- Quartz API reference
- [Performing recurrent tasks (RecurringJob, cron, misfire)](https://docs.hangfire.io/en/latest/background-methods/performing-recurrent-tasks.html) -- Hangfire docs
- [DisableConcurrentExecution does not fully prevent overlap on recurring jobs](https://github.com/HangfireIO/Hangfire/issues/1457) -- Hangfire issue
- [Concurrency and rate limiting](https://docs.hangfire.io/en/latest/background-processing/throttling.html) -- Hangfire docs
- [Quartz.Extensions.Hosting on NuGet](https://www.nuget.org/packages/Quartz.Extensions.Hosting/) -- version reference
