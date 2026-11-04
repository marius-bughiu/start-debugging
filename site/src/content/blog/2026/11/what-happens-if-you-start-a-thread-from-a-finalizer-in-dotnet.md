---
title: "What happens if you start a thread from a finalizer in .NET?"
description: "Starting a thread inside a finalizer works, but the new thread is a normal-priority foreground thread that resurrects the object, outlives GC.WaitForPendingFinalizers, can crash the process, and may touch objects that were already finalized. Blocking on it hangs shutdown. Eight cases reproduced on .NET 10 with real output, plus the safe handoff pattern."
pubDate: 2026-11-04
tags:
  - "csharp"
  - "dotnet"
  - "garbage-collection"
  - "threading"
---

**Short answer:** it works. `new Thread(...).Start()` inside a finalizer is legal, the runtime does not stop you, and the thread runs. But the thread you get is an ordinary foreground thread with `Normal` priority, not a copy of the finalizer thread, so it keeps the process alive after `Main` returns. If its delegate captures `this`, the object is resurrected and stays alive until the thread ends, and the finalizer will not run a second time. `GC.WaitForPendingFinalizers()` returns without waiting for it, any exception it throws terminates the process, and any finalizable object it touches (a `FileStream`, a `SafeHandle`) may already have been finalized in the same pass. The real trap is waiting for it: if the finalizer joins the thread and that thread needs the finalizer queue, the finalizer thread is stuck forever, and because CoreCLR raises `ProcessExit` on the finalizer thread, the process can then never shut down, not even through `Environment.Exit`. Everything below was run on the .NET 10 SDK 10.0.302 (runtime 10.0.10, C# 14) on macOS arm64.

## Why the question comes up at all

Finalizers exist to release unmanaged resources when someone forgot to call `Dispose`. Sooner or later a finalizer needs to do something slow: release a lease on a remote service, flush a buffer, log the leak. The C# guide on [finalizers](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/finalizers) and the [supplemental remarks for `Object.Finalize`](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-object-finalize) both say the same thing: finalizers run on a single dedicated thread, so a slow or blocking finalizer delays every other finalizer in the process. "Then I will start a thread and do the slow part there" is the obvious workaround, and it mostly does what you want. The problems are all in the details of what kind of thread you get and what the object graph looks like at that moment.

All the experiments share this harness. The `Alloc` helper allocates the object in a non-inlined method so the JIT cannot keep it alive in a register of `Main`:

```csharp
// .NET 10, C# 14 -- dotnet new console, Release build, TieredPGO off
using System.Runtime.CompilerServices;

[MethodImpl(MethodImplOptions.NoInlining)]
static void Alloc(Func<object> f) => f();

static void Collect() { GC.Collect(); GC.WaitForPendingFinalizers(); }
```

## The thread you start is not a finalizer thread

First, what does the finalizer thread look like, and what does a thread started from it inherit?

```csharp
// .NET 10, C# 14
class Spawner
{
    ~Spawner()
    {
        var self = Thread.CurrentThread;
        Console.WriteLine($"~Spawner on thread {Environment.CurrentManagedThreadId}, name='{self.Name}', " +
            $"IsBackground={self.IsBackground}, IsThreadPool={self.IsThreadPoolThread}, priority={self.Priority}");
        var t = new Thread(() =>
        {
            var me = Thread.CurrentThread;
            Console.WriteLine($"  worker on thread {Environment.CurrentManagedThreadId}, " +
                $"IsBackground={me.IsBackground}, priority={me.Priority}");
        });
        Console.WriteLine($"  new Thread().IsBackground before Start = {t.IsBackground}");
        t.Start();
        Console.WriteLine("~Spawner returned");
    }
}

// Main:
Alloc(() => new Spawner());
Collect();
Console.WriteLine("Main: WaitForPendingFinalizers returned");
Thread.Sleep(500);
```

Output:

```text
Runtime 10.0.10, main thread 1
~Spawner on thread 2, name='', IsBackground=True, IsThreadPool=False, priority=Highest
  new Thread().IsBackground before Start = False
~Spawner returned
Main: WaitForPendingFinalizers returned
  worker on thread 4, IsBackground=False, priority=Normal
```

The finalizer thread is a background thread running at `Highest` priority. CoreCLR sets both explicitly in [`finalizerthread.cpp`](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/finalizerthread.cpp): it boosts itself to `THREAD_PRIORITY_HIGHEST` and calls `SetBackground(TRUE)`. None of that transfers to a `new Thread`. A managed thread is foreground by default ([`Thread.IsBackground`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.thread.isbackground)) and starts at `Normal`, whoever creates it. So the work you move off the finalizer thread now runs at lower priority than it would have, and it counts as a foreground thread for process lifetime.

## A foreground worker keeps the process alive

That second point shows up as soon as the work takes a while. Here the worker sleeps for two seconds, once as a foreground thread and once with `IsBackground = true`:

```csharp
// .NET 10, C# 14
class LongSpawner(bool background)
{
    ~LongSpawner()
    {
        var t = new Thread(() =>
        {
            Thread.Sleep(2000);
            Console.WriteLine("  worker finished after 2 s");
        }) { IsBackground = background };
        t.Start();
    }
}

// Main:
Alloc(() => new LongSpawner(background: false)); // or true
Collect();
Console.WriteLine("Main returning");
```

```text
### foreground
Main returning
  worker finished after 2 s
real 2.05

### background
Main returning
real 0.04
```

The foreground worker holds the process open for its full two seconds after `Main` returned. The background one is simply killed at exit, and its work never happens. Neither is obviously right: a lease release that silently never runs is a bug, and so is a "cleanup" thread that turns a 40 ms tool into a 2 second one. Pick deliberately.

Also remember the other half of process exit: .NET Core and .NET 5+ do not run finalizers when the process ends (see the `Object.Finalize` remarks linked above). An object that is still uncollected when `Main` returns never runs its finalizer, so it never starts the thread at all.

## Capturing `this` resurrects the object

A lambda that reads a field closes over `this`. Starting a thread with that lambda roots the object again from inside its own finalizer, which is textbook resurrection (the case [`WeakReference`'s `trackResurrection` flag](https://learn.microsoft.com/en-us/dotnet/api/system.weakreference.-ctor) exists for). Short and long weak references show exactly when the object is really gone:

```csharp
// .NET 10, C# 14
class Resurrector
{
    public static int FinalizerRuns;
    public static readonly ManualResetEventSlim Release = new();
    public string Name = "resurrected";
    ~Resurrector()
    {
        Interlocked.Increment(ref FinalizerRuns);
        new Thread(() => { Release.Wait(); Console.WriteLine($"  worker still sees this.Name = {Name}"); }).Start();
    }
}

[MethodImpl(MethodImplOptions.NoInlining)]
static WeakReference Make(out WeakReference longWr)
{
    var r = new Resurrector();
    longWr = new WeakReference(r, trackResurrection: true);
    return new WeakReference(r);
}

// Main:
var wr = Make(out var longWr);
Collect();
Console.WriteLine($"after GC #1: short alive={wr.IsAlive}, long alive={longWr.IsAlive}");
Thread.Sleep(300);
Collect();
Console.WriteLine($"after GC #2: short alive={wr.IsAlive}, long alive={longWr.IsAlive}, finalizer runs={Resurrector.FinalizerRuns}");
Resurrector.Release.Set();
Thread.Sleep(200);
Collect(); Collect();
Console.WriteLine($"after thread exit: long alive={longWr.IsAlive}, finalizer runs={Resurrector.FinalizerRuns}");
```

```text
after GC #1: short alive=False, long alive=True
after GC #2: short alive=False, long alive=True, finalizer runs=1
  worker still sees this.Name = resurrected
after thread exit: long alive=False, finalizer runs=1
```

The short weak reference is cleared the moment the object is queued for finalization, as always. The long one stays alive across a second full GC because the running thread holds the object. When the thread ends the object is collected for good, and the finalizer count is still 1: the runtime unregistered it before running `~Resurrector`, so a resurrected object is never finalized again unless you call [`GC.ReRegisterForFinalize(this)`](https://learn.microsoft.com/en-us/dotnet/api/system.gc.reregisterforfinalize). If the background work fails and you were counting on "the finalizer will try again later", it will not.

Resurrection is legal, but it has a cost: everything the object references is promoted along with it and survives at least one more collection. If you are hunting a slow leak of a type that has a finalizer, this is one of the patterns worth searching a dump for; the walkthrough in [diagnosing a managed memory leak with dotnet-gcdump and dotnet-dump](/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) shows how to get from a growing heap to the roots.

## The objects you reach may already be finalized

When an object becomes unreachable, everything only it referenced becomes unreachable in the same collection. All of their finalizers are queued together, in no defined order, and [`CriticalFinalizerObject`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.constrainedexecution.criticalfinalizerobject) types such as `SafeHandle` are finalized after the ordinary ones. Your thread starts while that batch is still being processed:

```csharp
// .NET 10, C# 14
class LogFlusher
{
    private readonly FileStream _fs;
    public LogFlusher(string path) =>
        _fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read, 1, FileOptions.None);

    ~LogFlusher()
    {
        new Thread(() =>
        {
            Thread.Sleep(100);
            try { _fs.Write("flushed from finalizer thread\n"u8); _fs.Flush(); Console.WriteLine("  worker wrote OK"); }
            catch (Exception ex) { Console.WriteLine($"  worker: {ex.GetType().Name}: {ex.Message}"); }
        }).Start();
    }
}

// Main:
string path = Path.Combine(Path.GetTempPath(), "fin-demo.txt");
Alloc(() => new LogFlusher(path));
Collect();
Thread.Sleep(500);
Console.WriteLine($"file length: {new FileInfo(path).Length}");
```

```text
  worker: ObjectDisposedException: Cannot access a closed file.
file length: 0
```

Capturing `this` resurrected `_fs` too, but resurrection only keeps memory alive. It does not cancel finalizers that were already queued. The `FileStream` and its `SafeFileHandle` were in the same batch, they ran, and the handle was closed by the time the worker wrote. The `Thread.Sleep(100)` makes the race deterministic here; without it you get a race that passes most of the time and fails in production. The rule from the [Dispose pattern guidance](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-dispose) (do not touch other managed objects from the finalizer path) applies just as much to a thread you start from it.

## `GC.WaitForPendingFinalizers` does not wait for it

Tests and shutdown code often call `GC.Collect(); GC.WaitForPendingFinalizers();` and assume cleanup is done afterwards. It is done only as far as the finalizer thread is concerned:

```csharp
// .NET 10, C# 14
class SlowSpawner
{
    public static volatile bool Done;
    ~SlowSpawner() => new Thread(() => { Thread.Sleep(1000); Done = true; }).Start();
}

// Main:
Alloc(() => new SlowSpawner());
var sw = System.Diagnostics.Stopwatch.StartNew();
Collect();
Console.WriteLine($"WaitForPendingFinalizers returned after {sw.ElapsedMilliseconds} ms, worker done={SlowSpawner.Done}");
Thread.Sleep(1500);
Console.WriteLine($"after 1.5 s, worker done={SlowSpawner.Done}");
```

```text
WaitForPendingFinalizers returned after 0 ms, worker done=False
after 1.5 s, worker done=True
```

A test that asserts "the lease was released" right after `WaitForPendingFinalizers` becomes flaky the day someone moves the work onto a thread.

## An exception in the thread kills the process

An exception thrown directly in a finalizer has terminated the process since .NET 2.0. Moving the work to a thread does not soften that, because an unhandled exception on any thread is fatal:

```csharp
// .NET 10, C# 14
class Thrower
{
    ~Thrower() => new Thread(() => throw new InvalidOperationException("boom from a thread started in a finalizer")).Start();
}

// Main:
AppDomain.CurrentDomain.UnhandledException += (_, e) =>
    Console.WriteLine($"UnhandledException on thread {Environment.CurrentManagedThreadId}: " +
        $"{((Exception)e.ExceptionObject).Message}, terminating={e.IsTerminating}");
Alloc(() => new Thrower());
Collect();
Thread.Sleep(1000);
Console.WriteLine("Main: still alive?");
```

```text
UnhandledException on thread 4: boom from a thread started in a finalizer, terminating=True
Unhandled exception. System.InvalidOperationException: boom from a thread started in a finalizer
   at Thrower.<>c.<Finalize>b__0_0() in .../Program.cs:line 127
   at System.Threading.Thread.StartCallback()
exit=134
```

"Main: still alive?" never prints. Exit code 134 is `SIGABRT` on macOS and Linux; on Windows the same crash shows up as `0xE0434352`. Wrap the body of any thread you start from a finalizer in a `try`/`catch` that logs and swallows.

The same goes for `Task.Run` or `ThreadPool.QueueUserWorkItem` from a finalizer: `QueueUserWorkItem` crashes the same way, and a faulted `Task` that nobody awaits does not crash but quietly raises `TaskScheduler.UnobservedTaskException` later, which is usually worse. The differences between those three are covered in [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/).

## Ambient context does not come along

The finalizer thread has no relationship to the code that allocated the object, so there is no `ExecutionContext` to flow:

```csharp
// .NET 10, C# 14
static class Ambient { public static readonly AsyncLocal<string?> Value = new(); }

class CtxSpawner
{
    ~CtxSpawner()
    {
        Console.WriteLine($"finalizer sees AsyncLocal = '{Ambient.Value.Value ?? "null"}'");
        new Thread(() => Console.WriteLine($"  worker sees AsyncLocal = '{Ambient.Value.Value ?? "null"}'")).Start();
    }
}

// Main:
Ambient.Value.Value = "set on main";
Alloc(() => new CtxSpawner());
Collect();
```

```text
finalizer sees AsyncLocal = 'null'
  worker sees AsyncLocal = 'null'
```

No tenant ID, no `Activity`, no logging scope, no culture set via `AsyncLocal`. If the cleanup needs any of that, copy it into a field in the constructor. Why `AsyncLocal` behaves this way in general is explained in [what AsyncLocal is and why values don't flow back to the caller](/2026/11/what-is-asynclocal-and-why-doesnt-a-value-set-in-an-awaited-method-flow-back/).

## Joining the thread can hang the process forever

Starting a thread and then calling `Join` on it from the finalizer defeats the purpose, but it happens, usually because someone wanted a timeout around a call. It turns into a permanent hang when the worker needs the finalizer thread for anything, directly (`GC.WaitForPendingFinalizers`) or indirectly (a library call that does it, a lock held by another finalizer):

```csharp
// .NET 10, C# 14
class Joiner
{
    ~Joiner()
    {
        var t = new Thread(() => GC.WaitForPendingFinalizers()) { IsBackground = true };
        t.Start();
        t.Join(); // the worker waits for the finalizer queue, which is waiting for us
    }
}

class Victim
{
    public static volatile bool Ran;
    ~Victim() => Ran = true;
}

// Main:
Alloc(() => new Joiner());
GC.Collect();
Thread.Sleep(200);                  // the finalizer thread is now stuck in ~Joiner
Alloc(() => new Victim());
GC.Collect();
var t = new Thread(GC.WaitForPendingFinalizers) { IsBackground = true };
t.Start();
Console.WriteLine($"WaitForPendingFinalizers finished within 3 s = {t.Join(3000)}, Victim finalized = {Victim.Ran}");
Console.WriteLine("returning from Main");   // second run: Environment.Exit(0) instead
```

```text
### return from Main
WaitForPendingFinalizers finished within 3 s = False, Victim finalized = False
returning from Main
STILL RUNNING after 8 s, killing
exit=137

### Environment.Exit(0)
WaitForPendingFinalizers finished within 3 s = False, Victim finalized = False
calling Environment.Exit(0)
STILL RUNNING after 8 s, killing
exit=137
```

(The 8 second watchdog and `kill -9` came from the shell script driving the runs; exit 137 is that `SIGKILL`.)

Every other finalizer in the process stops: `Victim` is never finalized, so every `SafeHandle` and native buffer that relies on finalization now leaks. The worker is a background thread, so it is not what blocks exit. What blocks exit is the runtime itself. During shutdown CoreCLR calls [`FinalizerThread::RaiseShutdownEvents`](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/finalizerthread.h), which sets a quit flag, wakes the finalizer thread, and then waits on `hEventFinalizerToShutDown` with `INFINITE`. The finalizer thread only sets that event after it leaves its loop and runs `AppDomain::RaiseExitProcessEvent()`, which is where `AppDomain.ProcessExit` handlers execute. A finalizer thread stuck inside `~Joiner` never gets there, so returning from `Main` hangs, and so does `Environment.Exit(0)`, which goes through the same shutdown path. Only an external kill ends it.

That is the strongest reason never to block in a finalizer, whether on a `Join`, a `Task.Wait()`, a lock, or `.Result`. A deadlock elsewhere costs you one request; a deadlock on the finalizer thread costs you every pending finalizer and the ability to exit. The usual suspects for async deadlocks are covered in [fixing deadlocks when calling .Result or .Wait()](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

## What to do instead: hand off plain data to a worker you already own

If the cleanup genuinely has to happen off the finalizer thread, do not create a thread per finalized object. Start one worker once, and let finalizers do nothing but enqueue plain data that is not itself finalizable:

```csharp
// .NET 10, C# 14
using System.Collections.Concurrent;

static class CleanupQueue
{
    private static readonly BlockingCollection<int> s_queue = new();
    public static readonly ConcurrentBag<int> Released = new();

    static CleanupQueue()
    {
        new Thread(() =>
        {
            foreach (int id in s_queue.GetConsumingEnumerable())
            {
                try { Released.Add(id); } // real code: call the remote "release lease" API here
                catch (Exception ex) { Console.Error.WriteLine($"cleanup of {id} failed: {ex}"); }
            }
        }) { IsBackground = true, Name = "cleanup-worker" }.Start();
    }

    public static void Enqueue(int id) => s_queue.Add(id);
}

class Leased(int id)
{
    private readonly int _id = id; // plain data only, no other finalizable objects
    ~Leased() => CleanupQueue.Enqueue(_id);
}

// Main:
for (int i = 0; i < 3; i++) Alloc(() => new Leased(42 + i));
Collect();
Thread.Sleep(200);
Console.WriteLine($"released ids: {string.Join(", ", CleanupQueue.Released.OrderBy(x => x))}");
```

```text
released ids: 42, 43, 44
```

This avoids every problem above. The finalizer does a non-blocking `Add` and returns in microseconds. Nothing captures `this`, so nothing is resurrected. The queue holds an `int`, not a `FileStream`, so there is no already-finalized object to trip over. Exceptions are caught on a thread you named and control, and you decide once whether that thread is background (lose pending work at exit) or foreground (finish it, with a bounded wait you implement in a `ProcessExit` handler). In an ASP.NET Core app the same idea fits naturally into a hosted service reading from a `Channel<T>`, as in [running fire-and-forget work safely with BackgroundService](/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

Better still, make the finalizer path a fallback that rarely runs. Implement `IDisposable` (or [`IAsyncDisposable` for genuinely asynchronous cleanup](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)), call `GC.SuppressFinalize(this)` in `Dispose`, and wrap native handles in a `SafeHandle` subclass so the only finalizer in your design is the one the runtime already gets right. Then the finalizer is a leak detector that logs "you forgot to dispose `Leased` 43" and enqueues the release, not the primary cleanup mechanism.

## The checklist

- Starting a thread from a finalizer works. The new thread is foreground and `Normal` priority; it inherits nothing from the finalizer thread.
- A lambda that touches a field resurrects the object until the thread ends, and the finalizer will not run again.
- Other finalizable objects the thread touches may already be finalized, including `SafeHandle`s.
- `GC.WaitForPendingFinalizers` does not wait for the thread; an unhandled exception in it terminates the process; `AsyncLocal` values do not flow into it.
- Never block the finalizer thread on that thread (or anything else). On CoreCLR a stuck finalizer thread blocks `ProcessExit` and therefore every normal shutdown, `Environment.Exit` included.
- If you need background cleanup, enqueue plain data to a single long-lived worker, and make `Dispose` the normal path.

### Read next

- [Diagnosing a managed memory leak with dotnet-gcdump and dotnet-dump](/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)
- [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/)
- [How to implement and consume IAsyncDisposable with await using](/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)
- [What AsyncLocal<T> is and why a value set in an awaited method doesn't flow back](/2026/11/what-is-asynclocal-and-why-doesnt-a-value-set-in-an-awaited-method-flow-back/)

### Sources

- [Supplemental API remarks for `Object.Finalize`](https://learn.microsoft.com/en-us/dotnet/fundamentals/runtime-libraries/system-object-finalize) (finalizer thread, no finalization at process exit in .NET Core)
- [Finalizers (C# programming guide)](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/finalizers)
- [Implement a Dispose method](https://learn.microsoft.com/en-us/dotnet/standard/garbage-collection/implementing-dispose)
- [`CriticalFinalizerObject`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.constrainedexecution.criticalfinalizerobject) and [`GC.ReRegisterForFinalize`](https://learn.microsoft.com/en-us/dotnet/api/system.gc.reregisterforfinalize)
- CoreCLR [`finalizerthread.cpp`](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/finalizerthread.cpp) and [`finalizerthread.h`](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/finalizerthread.h) at tag v10.0.0 (priority boost, `SetBackground(TRUE)`, `RaiseExitProcessEvent`, `RaiseShutdownEvents`)
