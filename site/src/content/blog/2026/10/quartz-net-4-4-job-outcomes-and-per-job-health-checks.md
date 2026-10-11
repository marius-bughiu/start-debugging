---
title: "Quartz.NET 4.4: Jobs Report What They Achieved, and a Health Check Notices When They Stop"
description: "Quartz.NET 4.4.0 lets a job set context.Result to a JobRunReport (Succeeded, Failed, Cancelled or Skipped, with a summary and metrics), keeps that per job in the execution history, and adds RequireSuccessWithin health checks that degrade when a nightly job stops succeeding."
pubDate: 2026-10-11
tags:
  - "quartz-net"
  - "dotnet"
  - "csharp"
  - "health-checks"
  - "background-jobs"
---

Quartz.NET [v4.4.0](https://github.com/quartznet/quartznet/releases/tag/v4.4.0) shipped on October 7, 2026. The headline numbers are about clustering (triggers that are already due now fire in the transaction that acquires them, and on PostgreSQL 95 to 99 % of firings at 20 triggers a second land within 50 ms, up from 54 % on 4.3.0), but the change most application code will use is smaller: a job can finally say what its run achieved, and your health endpoint can act on it.

## "It didn't throw" is not "it worked"

Until 4.3, Quartz knew two outcomes: the job threw, or it did not. A cleanup job that found nothing to clean, a sync that bailed because the upstream API returned an empty page, and a run that did real work all looked identical in the history. And a nightly job whose trigger got paused or misfired for three days looked like nothing at all, because nothing failed.

## Reporting a result with JobRunReport

In 4.4 a job sets `context.Result` to a `JobRunReport`. There are four results (`Succeeded`, `Failed`, `Cancelled`, `Skipped`), an optional summary of up to 1,000 characters, and metrics stored as AOT-safe JSON capped at 4,000 characters:

```csharp
public sealed class ReleaseStaleReservationsJob : IJob
{
    public async ValueTask Execute(IJobExecutionContext context, CancellationToken cancellationToken = default)
    {
        int scanned = await CountReservations(cancellationToken);
        int released = await ReleaseStale(cancellationToken);

        context.Result = released == 0
            ? JobRunReport.Skipped("no stale reservations").With("scanned", scanned)
            : JobRunReport.Succeeded($"released {released}")
                .With("scanned", scanned)
                .With("released", released);
    }
}
```

The recorded result follows a fixed order: a cancelled firing is `Cancelled`, a job that threw is `Failed`, otherwise whatever you put in `context.Result`, otherwise `Succeeded`. Reporting `JobRunReport.Failed(...)` is not the same as throwing. Only a thrown exception drives the retry policy and `OnFailure` continuations, so report a failure when retrying would not help.

The history keeps a `JobRunStatus` per job (`LastSucceededAtUtc`, `ConsecutiveFailures`, `LastFailureMessage`, run and failure counts), retention can differ by result, and the `quartz.job.execution.duration` metric gains a `quartz.job.result` tag so your OpenTelemetry dashboards can split skipped runs from real ones.

## A health check per job

This is the part I would turn on today. `RequireSuccessWithin` reports a job as unhealthy once it has not succeeded within a window, which catches the silent case: a paused trigger, a misfire, a job that keeps getting skipped by a veto.

```csharp
builder.Services.AddQuartzExecutionHistory();

builder.Services.AddHealthChecks().AddQuartz(options =>
{
    // Degraded once the nightly report has not succeeded for 26 hours.
    options.RequireSuccessWithin(new JobKey("nightly-report", "reports"), TimeSpan.FromHours(26));

    // Unhealthy, so the node leaves rotation, after 90 minutes without a ledger close.
    options.RequireSuccessWithin(
        new JobKey("ledger-close", "billing"),
        TimeSpan.FromMinutes(90),
        HealthStatus.Unhealthy);
});
```

The default status is `Degraded`, and a `Skipped` run counts as a success, so the "nothing to do" path from the job above does not page anyone. The list can also be bound from configuration through `RequiredJobs`. If the execution history is off, the host fails at startup rather than reporting a check that can never pass.

## Upgrading from 4.3

The release is additive: 4.3 code compiles unchanged, and every new interface member has a default implementation. If you use a persistent job store with the execution history on, run the `4.4/add_execution_outcome_<dialect>.sql` script before the first 4.4 node starts. The release also adds a `[RetryPolicy]` attribute on job classes, `q.RunAtStartup(jobKey)`, and Weasel schema management for MySQL, Oracle and Firebird, all covered in the [migration guide](https://www.quartz-scheduler.net/documentation/quartz-4.x/migration-guide.html#upgrading-from-4-3-to-4-4) and the [job outcomes how-to](https://www.quartz-scheduler.net/documentation/quartz-4.x/how-tos/job-outcomes.html).

If you are still on 4.2, the [cron analyzer and `[QuartzJob]` source generator from 4.2](/2026/09/quartz-net-4-2-turns-bad-cron-expressions-into-build-errors/) come along for free.
