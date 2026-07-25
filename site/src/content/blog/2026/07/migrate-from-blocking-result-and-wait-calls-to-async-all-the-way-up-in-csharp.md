---
title: "Migrate from blocking .Result/.Wait() calls to async all the way up in a legacy C# codebase"
description: "A staged playbook for removing sync-over-async from an existing .NET codebase: inventory with analyzers, measure ThreadPool starvation, convert one call chain at a time, and ratchet the count to zero on .NET 11."
pubDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
---

Removing sync-over-async from a real codebase is not a find-and-replace. Budget one to three sprints for a service of a few hundred thousand lines, and expect the work to be shaped like a series of vertical slices rather than a single big-bang PR. What breaks is mostly signatures: every method that stops blocking has to return `Task`, which propagates up through interfaces, constructors, `Dispose`, `lock` blocks, and your public API surface. It is worth doing when you are seeing ThreadPool starvation under load or hard deadlocks on a UI thread, and it is worth deferring when the blocking call is in a CLI tool that runs once and exits. This playbook targets .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14); every tool mentioned works back to .NET 6, with the runtime tracing step requiring .NET 9 or later.

## Why the blocking calls have to go

- **Thread pool starvation disappears.** Each `.Result` on a request path parks a pool thread. Microsoft's own [ThreadPool starvation tutorial](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-threadpool-starvation) measures the same endpoint at 3.48 s average latency under 125 concurrent connections while blocking, and 532 ms after the call is awaited. That is not a tuning delta, it is a different application.
- **Hard deadlocks become impossible, not unlikely.** On a WPF, WinForms, or classic ASP.NET thread, blocking on a task whose continuation needs that thread is a circular wait. The mechanism is covered in [why blocking on an async method deadlocks](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/); removing the block removes the class of bug.
- **Memory drops with the thread count.** A pool that has stabilized at 130 threads to compensate for blocking is holding 130 stacks. Going async typically returns the count to a small multiple of the core count.
- **Cancellation starts working.** A blocked thread cannot observe a `CancellationToken`. Once the chain is async, timeouts and client disconnects actually propagate.

## What breaks when you go async

| Area                          | Change                                                                                     | Severity |
| ----------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| Public API surface            | `T Get()` becomes `Task<T> GetAsync()`: source and binary breaking for downstream consumers | high     |
| Interfaces you do not own     | A third-party or framework interface method cannot be given a `Task` return type            | high     |
| Constructors, property getters| Neither can be `async`; the work moves to a factory method or a lazy initializer             | high     |
| `lock` statements             | `await` inside `lock` is compiler error `CS1996`; needs `SemaphoreSlim`                     | medium   |
| Exception handling            | `AggregateException` stops appearing, so `catch (AggregateException)` silently stops matching| medium   |
| `TransactionScope`            | Does not flow across `await` unless constructed with `TransactionScopeAsyncFlowOption.Enabled`| medium  |
| `IDisposable`                 | Async cleanup in `Dispose` needs `IAsyncDisposable` and `await using`                        | medium   |
| Test suite                    | Sync test methods calling now-async code become `async Task`                                 | low      |

The high-severity rows are the ones that decide your sequencing. Everything else is mechanical.

## Pre-flight checklist

- The solution builds clean on .NET 6 or later. Nothing here requires .NET 11, but the runtime tracing step needs .NET 9+ for the `WaitHandleWait` event.
- `Microsoft.VisualStudio.Threading.Analyzers` added to every project, or at least to the projects on the hot path. This is the package that finds blocking calls in synchronous methods, which the built-in .NET analyzers do not.
- `dotnet-counters`, `dotnet-trace`, and `dotnet-stack` installed as global tools.
- A load test that reproduces the symptom. Without it you cannot prove the migration worked, and you cannot prove it did not regress.
- A branch strategy that allows many small PRs. One 400-file PR that changes every signature in the solution will not get reviewed.

## Migration steps

1. **Build the inventory with analyzers, not grep.**

   `grep -r "\.Result"` finds property accesses on anything named Result and misses synchronous I/O entirely. Turn on the two rules that actually understand the pattern:

   ```ini
   # .editorconfig -- .NET 11 SDK 11.0.0
   [*.cs]
   # Avoid problematic synchronous waits (.Result, .Wait(), GetAwaiter().GetResult())
   dotnet_diagnostic.VSTHRD002.severity = warning
   # Call async methods when in an async method
   dotnet_diagnostic.VSTHRD103.severity = warning
   # Built-in equivalent; off by default through .NET 10
   dotnet_diagnostic.CA1849.severity = warning
   ```

   The distinction matters in a legacy codebase. [CA1849](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1849) only fires inside a `Task`-returning method, so in code where nothing is async yet it reports almost nothing. `VSTHRD002` fires on the blocking call wherever it lives, which is exactly the population you are trying to count.

   **Verify**: build the solution and count the `VSTHRD002` lines in the output. Save that number. It is your burn-down chart.

2. **Capture a baseline under load before changing a line.**

   Run your load test and watch the pool:

   ```bash
   dotnet-counters monitor -n YourApp System.Runtime
   ```

   On .NET 9 and later the counters to read are `dotnet.thread_pool.thread.count`, `dotnet.thread_pool.queue.length`, and `dotnet.thread_pool.work_item.count`. The signal for starvation is a thread count climbing slowly while CPU sits well under 100%. A count that stabilizes above roughly three times the processor count means code is blocking pool threads and the runtime is compensating by creating more.

   **Verify**: record the stabilized thread count, the p95 latency, and the requests per second. You will compare against these in the verification step.

3. **Find the blocking calls that source analysis cannot see.**

   Analyzers cannot flag `File.ReadAllText`, `SqlCommand.ExecuteReader`, or a `SemaphoreSlim.Wait()` buried in a dependency you do not have source for. .NET 9 added the `WaitHandleWait` event for exactly this:

   ```bash
   dotnet trace collect -n YourApp --clrevents waithandle --clreventlevel verbose --duration 00:00:30
   ```

   Open the resulting `.nettrace` in PerfView or the community .NET Events Viewer and expand the `WaitHandleWaitStart` stacks. Any stack whose base frames mention `ThreadPoolWorkQueue.Dispatch` or `WorkerThread.WorkerThreadStart` is a pool thread being blocked, and the frame above the wait names your method.

   **Verify**: every stack in the trace either maps to a call site already in your step 1 inventory, or gets added to it.

4. **Convert one call chain end to end, not one file.**

   Pick the single hottest entry point from step 3. Start at the leaf (the method that actually calls `HttpClient` or EF Core), give it an async twin, and walk up the stack converting each caller until you reach a method that can `await` without a caller of its own: a controller action, a `BackgroundService.ExecuteAsync`, an event handler, or `Main`.

   ```csharp
   // .NET 11, C# 14 -- before: the block is three frames below the controller
   public IActionResult GetOrder(int id)
   {
       var order = _repository.Get(id);          // sync wrapper
       return Ok(order);
   }

   // after: no wrapper, no block, Task all the way to the framework
   public async Task<IActionResult> GetOrderAsync(int id, CancellationToken ct)
   {
       var order = await _repository.GetAsync(id, ct);
       return Ok(order);
   }
   ```

   Partial conversion is worse than none on this path. One remaining `.Result` anywhere in the synchronous segment reintroduces both the deadlock and the parked thread, so a slice is only done when it reaches an entry point.

   **Verify**: re-run step 3's trace against just that endpoint. Zero `WaitHandleWait` events on pool threads for that stack.

5. **Delete the synchronous twin rather than keeping both.**

   The tempting shortcut is to leave `Get()` in place as `GetAsync().GetAwaiter().GetResult()` so nothing else has to change. That is the sync wrapper Stephen Toub argues against in [Should I expose synchronous wrappers for asynchronous methods?](https://devblogs.microsoft.com/dotnet/should-i-expose-synchronous-wrappers-for-asynchronous-methods/), and in a migration it is actively harmful: the wrapper is where your remaining blocking calls hide, and it lets callers opt out of the work forever.

   If you genuinely own both a sync and an async consumer and cannot drop either, use the flag-argument pattern the BCL uses rather than a wrapper:

   ```csharp
   // .NET 11, C# 14 -- one implementation, two entry points, no sync-over-async
   public int Read(byte[] buffer) => ReadCoreAsync(buffer, sync: true).GetAwaiter().GetResult();
   public Task<int> ReadAsync(byte[] buffer) => ReadCoreAsync(buffer, sync: false);

   private async Task<int> ReadCoreAsync(byte[] buffer, bool sync)
   {
       // Every I/O call inside branches on `sync`, so the synchronous path
       // never awaits an incomplete task and cannot deadlock.
       return sync ? _stream.Read(buffer) : await _stream.ReadAsync(buffer);
   }
   ```

   **Verify**: the sync entry point no longer appears in a `WaitHandleWait` trace, because it never waits on an incomplete task.

6. **Handle the seams that truly cannot be async.**

   Three come up in every migration. A constructor cannot be `async`, so move initialization into a static factory (`public static async Task<Foo> CreateAsync()`) or a `Lazy<Task<T>>` field that callers await. A `Dispose` that does async cleanup should implement `IAsyncDisposable` and be consumed with [await using](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/). A `lock` block containing new async work fails to compile with `CS1996`, because a monitor must be released on the thread that took it:

   ```csharp
   // .NET 11, C# 14 -- lock cannot span an await; SemaphoreSlim can
   private readonly SemaphoreSlim _gate = new(1, 1);

   public async Task<Config> LoadAsync(CancellationToken ct)
   {
       await _gate.WaitAsync(ct);
       try { return _cached ??= await FetchAsync(ct); }
       finally { _gate.Release(); }
   }
   ```

   **Verify**: the project compiles with no `CS1996` and no new `async void` outside event handlers.

7. **Thread the CancellationToken through while the signatures are already open.**

   Adding `CancellationToken ct = default` costs nothing on a signature you are changing anyway, and it is painful to retrofit later. Pass it to every async call in the chain, not just the outermost one, following the rules in [propagating a CancellationToken through async methods](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

   **Verify**: cancel a request mid-flight (kill the client connection) and confirm the database call is actually abandoned rather than running to completion.

8. **Ratchet the analyzer so the count can only go down.**

   Once a project reaches zero, lock it:

   ```xml
   <!-- Directory.Build.props -- .NET 11 SDK 11.0.0 -->
   <PropertyGroup>
     <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
     <WarningsAsErrors>$(WarningsAsErrors);VSTHRD002;CA1849</WarningsAsErrors>
   </PropertyGroup>
   ```

   For projects still mid-migration, keep the rules at `warning` and fail CI on a count increase instead of on any warning at all. A ratchet that blocks new debt while old debt burns down is the only version of this that teams actually keep.

   **Verify**: add a deliberate `.Result` in a converted project and confirm the build fails.

## Verifying the migration actually worked

Signatures compiling is not evidence. Run the same load test from step 2 and compare four numbers:

- **ThreadPool thread count** should stabilize near a small multiple of the core count instead of climbing into the hundreds.
- **p95 latency under load** should approach the single-request latency. The starvation tutorial's endpoint went from 3.48 s back to roughly its unloaded 500 ms.
- **Throughput** should rise, often by an order of magnitude, because the same threads now serve many more requests.
- **`WaitHandleWait` events on pool threads** should be near zero for converted paths.

Then run the functional checks: `dotnet test` with zero failures, a cancellation test that proves a client disconnect aborts the downstream call, and a manual pass over any `catch (AggregateException)` blocks in the touched code, since those no longer match anything once the blocking calls are gone.

## Rolling back

Per-slice, this migration reverses cleanly: each vertical slice is a self-contained PR, and reverting it restores the blocking call and its signatures. That is the main argument for slicing by call chain rather than by layer.

What does not roll back cleanly is a published library. Changing `T Get()` to `Task<T> GetAsync()` is a binary breaking change for every consumer that compiled against the old assembly, so for a NuGet package this is a major-version migration and the revert has to be a new release, not a `git revert`. Decide before you start whether the package ships both surfaces for one major version (using the flag-argument pattern in step 5, never a sync wrapper) or breaks in one go.

## Gotchas that cost us time

**`async void` sneaks back in through lambdas.** A lambda passed to a parameter typed `Action` becomes `async void`, so exceptions inside it crash the process instead of surfacing on a task. `List<T>.ForEach(async x => ...)` and `Parallel.ForEach` with an async body are the two common carriers. `VSTHRD101` catches the delegate case; the boundary between legitimate and broken usage is in [when async void is correct and when it is a trap](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

**`.Select(async x => ...)` produces `IEnumerable<Task>`, not results.** It compiles, it looks converted, and nothing awaits it. Follow it with `await Task.WhenAll(...)` or switch the enumeration to [IAsyncEnumerable](/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/).

**`TransactionScope` silently stops flowing.** The default constructor does not flow the ambient transaction across an `await`, so the code after the first await runs outside the transaction with no error. Construct it with `TransactionScopeAsyncFlowOption.Enabled`.

**ASP.NET Core throws before you finish.** Converting the outer layers can surface `InvalidOperationException: Synchronous operations are disallowed` from a sync `Stream.Read` further down, because `AllowSynchronousIO` defaults to false. That exception is a map to remaining work, not a reason to flip the switch back on; the details are in [fixing synchronous operations are disallowed](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).

**Blocking a `ValueTask` is undefined, not just slow.** If a converted leaf returns `ValueTask<T>` and some caller upstream is still blocking, `.Result` on it is undefined behaviour rather than a deadlock risk. Convert with `.AsTask()` at that boundary until the caller is done, and read the restrictions in [what ValueTask costs you](/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

**Do not use `ConfigureAwait(false)` as a substitute for finishing.** It defuses the deadlock inside a library you own, but it does nothing about the parked thread, and on ASP.NET Core there is no context to opt out of anyway. It is a mitigation for code you cannot change, not a migration strategy.

The measure of success is not that the analyzer count hit zero. It is that the pool thread count stopped climbing under load, and that a cancelled request now actually cancels something.

## Related

- [Fix: deadlock when calling .Result or .Wait() on an async method in C#](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#](/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)
- [How to propagate a CancellationToken through async methods in .NET 11](/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [When async void is correct and when it is a trap in C#](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)

## Sources

- [Debug ThreadPool starvation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-threadpool-starvation) -- Microsoft Learn
- [CA1849: Call async methods when in an async method](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1849) -- Microsoft Learn
- [VSTHRD002: Avoid problematic synchronous waits](https://microsoft.github.io/vs-threading/analyzers/VSTHRD002.html) -- Microsoft.VisualStudio.Threading
- [Should I expose synchronous wrappers for asynchronous methods?](https://devblogs.microsoft.com/dotnet/should-i-expose-synchronous-wrappers-for-asynchronous-methods/) -- Stephen Toub
- [CS1996: Cannot await in the body of a lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs1996) -- Microsoft Learn
- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
