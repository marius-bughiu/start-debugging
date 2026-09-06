---
title: "The async and concurrency cheat sheet"
description: "Async and concurrency in C# and .NET in one place: async void vs async Task, ConfigureAwait, cancellation, ValueTask, Channels, locking, and the deadlocks each one causes."
tagline: "Every await decision, and the deadlock it avoids."
pubDate: 2026-09-06
updatedDate: 2026-09-06
indexTags:
  - "async"
  - "concurrency"
  - "threading"
---

This pillar collects everything on the site about **asynchronous and concurrent code** - the `async`/`await` decisions in C#, cancellation, the .NET 11 runtime-async work, the locking and channel primitives, and the deadlocks and exceptions each wrong turn produces.

## What to read first

Start with the two calls you make daily: [async void vs async Task](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) and [.Result vs .Wait() vs GetAwaiter().GetResult() vs await](/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/), then [the deadlock blocking causes](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) and [migrating a legacy codebase to async all the way up](/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/). [ConfigureAwait(false) vs default in .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/) answers whether any of that still matters on modern hosts.

For return types, [what ValueTask is and when it's worth it](/2026/06/what-is-valuetask-and-when-is-it-worth-it/), [IEnumerable vs IAsyncEnumerable vs IQueryable](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/), and [returning a Task directly vs an async passthrough](/2026/09/return-task-directly-vs-async-await-passthrough-in-a-csharp-repository-method/) cover the signature choices. For running work in parallel, [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) decides, with [the AggregateException WhenAll throws](/2026/08/fix-aggregateexception-one-or-more-errors-occurred-when-awaiting-task-whenall/) as the gotcha. For coordination, [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) and [Channels instead of BlockingCollection](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) are the primitives. For shutdown, [propagating a CancellationToken](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) and [CancelAfter timeouts](/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/) are the pair.

## What's on this page

The list below auto-collects posts tagged with any of: `async`, `concurrency`, `threading` - which pulls in the Dart and Flutter async posts too. Newest first.

Companion pillars: [C# 14 features](/pillars/csharp-14-features/) and [the .NET 11 tracker](/pillars/dotnet-11-tracker/).
