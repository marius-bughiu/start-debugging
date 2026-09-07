---
title: "How to find the async void handlers causing ANRs in a .NET MAUI Android app"
description: "Play Console tells you your ANR rate is over 0.47% and hands you a native stack full of libcoreclr.so frames. Here is how to get from that useless trace to the exact async void event handler that blocked the main thread, using a Looper printer, a SynchronizationContext wrapper that names the state machine, and dotnet-trace over dsrouter."
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "maui"
  - "android"
  - "async"
  - "performance"
  - "how-to"
---

Short answer: the ANR trace you get from Google Play will not name your C# method, so stop reading it as if it will. Enumerate every `async void` in the codebase with VSTHRD100, narrow to the ones wired to UI events, then install two things in a Release build: an `Android.Util.IPrinter` on the main `Looper` that times every main-thread message, and a `SynchronizationContext` wrapper that reads the boxed async state machine off the posted continuation so the log line says `MainPage+<OnSyncClicked>d__7` instead of an anonymous Runnable. The first catches work done before the first `await`, the second catches work done after it. Between them you get a method name.

This post targets .NET 11 (`11.0.100-preview.7`, released 2026-08-11, GA scheduled 2026-11-10) with .NET MAUI 11 on `net11.0-android`, where CoreCLR is the only mobile runtime. Everything here also works on .NET 10 with Mono; the differences are called out where they matter.

## Why `async void` shows up in ANR reports at all

`async void` does not block a thread by itself. It causes ANRs indirectly, through three mechanisms that all end at the same place.

**The synchronous prefix runs on the caller's thread.** An `async` method does not yield at the opening brace. It runs straight through until it hits an `await` on something that has not already completed. In a click handler on the Android main thread, every line before that first real suspension point is main-thread work, and the `async` keyword in the signature makes it look like it is not.

```csharp
// MainPage.xaml.cs, .NET 11, net11.0-android, MAUI 11
private async void OnSyncClicked(object sender, EventArgs e)
{
    using var db = new SqliteConnection(_dbPath);   // opens the file, ~40 ms cold
    var orders = db.Query<Order>(
        "select * from Orders where Status = 0");    // 3-9 s on a 40k-row table
    await RenderAsync(orders);                       // the first real await, far too late
}
```

Five seconds of that and Android's input dispatcher gives up. The `await` on the last line is doing nothing for you.

**It removes the caller's ability to wait, so someone adds a block.** Because an `async void` method returns nothing awaitable, the moment a second piece of code needs its result, the path of least resistance is `.Result` or `.Wait()`. On a thread with a `SynchronizationContext` that marshals continuations back to itself, that is the [classic async deadlock](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/), and on Android the deadlocked thread is the one Android is timing.

```csharp
private async void OnRefreshClicked(object sender, EventArgs e)
{
    // The handler could not be awaited, so this got "fixed" by blocking.
    var settings = _settings.LoadAsync().Result;   // main thread parked, permanently
    await ReloadAsync(settings);
}
```

**It is re-entrant.** Nothing stops a second tap from starting a second invocation while the first is suspended. Two overlapping runs contend on the same `SemaphoreSlim` or `SQLiteConnection`, and the contention shows up as a main-thread stall that reproduces only under a fast double-tap. If you want the full treatment of when the construct is legitimate, see [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## What Android is actually measuring

Knowing the exact budget tells you which handlers are worth investigating. Per the [Android ANR documentation](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs):

| Trigger | Timeout |
| --- | --- |
| Input dispatch (touch, key) | 5 seconds |
| Broadcast receiver, `FLAG_RECEIVER_FOREGROUND` set | 10 s on Android 13 and lower, 10-20 s on Android 14+ |
| Broadcast receiver, background priority | 60 s on Android 13 and lower, 60-120 s on Android 14+ |
| Foreground service `onCreate` / `onStartCommand` / `onBind` | 20 seconds |
| Background service | 200 seconds |

Input dispatch is the one that bites MAUI apps, and it is the one users see, because by definition the app was in the foreground and being touched. The stakes are set by Play: the user-perceived ANR rate is a core vital with a bad-behaviour threshold of 0.47% overall, evaluated over a rolling 28-day window, and crossing it makes your app less discoverable across all devices ([Play Console technical quality requirements](https://support.google.com/googleplay/android-developer/answer/17492799)).

## Why the trace Play hands you is not enough

Pull the ANR record and look at the main thread. On a device you can reach:

```sh
# Everything in the device's dropbox, newest last
adb shell dumpsys dropbox --print data_app_anr | tail -300

# Or the full set, which is what you want for a device that has been running a while
adb bugreport anr.zip
unzip -o anr.zip -d anr && ls anr/FS/data/anr/
```

The header tells you the trigger:

```
ANR in com.example.orders (com.example.orders/crc64e1fb321c08285b90.MainActivity)
PID: 14882
Reason: Input dispatching timed out (Waited 5003ms for MotionEvent)
```

The main-thread stack, however, is dumped by ART, which symbolicates Java frames. Your handler is not a Java frame. On a CoreCLR Android app you get something shaped like this:

```
"main" prio=5 tid=1 Native
  #00 pc 00000000000a1b3c  /apex/com.android.runtime/lib64/bionic/libc.so (syscall+28)
  #01 pc 00000000004f21d8  /data/app/.../lib/arm64/libcoreclr.so (???)
  #02 pc 00000000004e0a44  /data/app/.../lib/arm64/libcoreclr.so (???)
  at crc64e1fb321c08285b90.MainActivity.n_onCreate(Native method)
  at android.os.Handler.dispatchMessage(Handler.java:106)
  at android.os.Looper.loop(Looper.java:294)
```

That is the whole story you get: unnamed native frames inside `libcoreclr.so` (`libmonosgen-2.0.so` if you are still on Mono under .NET 10). It is not useless. It sorts the problem into one of three buckets:

- Frames sitting in `syscall`, `futex_wait`, or `pthread_cond_wait` under the runtime: the main thread is **blocked**, which means a lock, a `.Result`, a `.Wait()`, or a `SemaphoreSlim.Wait()`.
- Frames churning inside `libcoreclr.so` with no syscall on top: the main thread is **running managed code**, which means CPU-bound work in a handler.
- `android.os.MessageQueue.nativePollOnce` at the top: the main thread was **idle** when the dump was taken. The ANR is somewhere else, or the dump arrived late. Android documents this explicitly, and chasing your handlers on this signature is wasted effort.

There is a fourth shape worth recognising before you start: a stack parked inside `coreclr_initialize` immediately after a cold start. That is not your code, it is the CoreCLR startup regression tracked in [dotnet/android#10588](https://github.com/dotnet/android/issues/10588), where a large app that launched in one second under Mono can take around six under CoreCLR and exceed the OS budget. Those cluster separately in vitals under `handleBindApplication`. If that is your shape, the fix is the startup work covered in [migrating a MAUI Android app from Mono to CoreCLR](/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/), not handler triage.

## The five-step triage workflow

1. **Enumerate every `async void` declaration and delegate in the solution.** Add `Microsoft.VisualStudio.Threading.Analyzers` and turn VSTHRD100 (async void methods) and VSTHRD101 (async void delegates and lambdas) into build warnings. This gives you the complete candidate set in one build, including the `async` lambdas assigned to `EventHandler` that a text search misses.
2. **Rank the candidates by whether they can run on the main thread.** Only handlers reachable from a UI event, a `Loaded`/`Appearing` lifecycle callback, or a `MainThread.BeginInvokeOnMainThread` body can produce an input-dispatch ANR. Everything else is a correctness problem, not an ANR.
3. **Instrument the main `Looper` in a Release build** so every main-thread message that exceeds a threshold is logged with its duration. This catches the synchronous prefix, which never touches the `SynchronizationContext` and is therefore invisible to every other technique here.
4. **Wrap the main-thread `SynchronizationContext`** so slow resumed continuations log the name of the async state machine that owns them. This is the step that turns a duration into a method name.
5. **Confirm with `dotnet-trace` over `dotnet-dsrouter`** and read the flame graph for the main thread, so the fix is measured rather than assumed.

## Step 1 and 2: the static pass

```xml
<!-- MyApp.csproj, .NET 11 -->
<ItemGroup>
  <PackageReference Include="Microsoft.VisualStudio.Threading.Analyzers" Version="17.14.15">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

```ini
# .editorconfig
dotnet_diagnostic.VSTHRD100.severity = warning   # Avoid async void methods
dotnet_diagnostic.VSTHRD101.severity = warning   # Avoid unsupported async delegates
```

Then dump the list:

```sh
dotnet build -c Release -f net11.0-android -warnaserror:none \
  | grep -E 'VSTHRD10[01]' | sort -u
```

Expect noise. VSTHRD100 fires on legitimate event handlers as well, which is the long-running complaint in [microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510): the analyzer has no way to know that a method whose signature is `(object, EventArgs)` is required to be `void`. Do not suppress it and move on. The point of step 1 is the inventory, and step 2 is where you filter it, by hand, to the handlers that can execute on the main thread. On a typical mid-sized MAUI app a 60-item VSTHRD100 list collapses to 8 or 10 real candidates.

`AsyncFixer03` from the AsyncFixer package reports the same fire-and-forget shape if you would rather not take the vs-threading dependency. Either works; do not run both, or you will triage every finding twice.

## Step 3: time every main-thread message

`Looper.setMessageLogging` writes a line at the start and end of each message dispatch. Subtracting the timestamps gives you the exact duration of every unit of main-thread work, including the synchronous prefix of a handler.

```csharp
// Platforms/Android/MainThreadWatchdog.cs, .NET 11, net11.0-android
using Android.OS;
using Android.Util;

sealed class MainThreadWatchdog(long thresholdMs) : Java.Lang.Object, IPrinter
{
    private long _startedAt;
    private string? _current;

    public void Println(string? message)
    {
        if (string.IsNullOrEmpty(message))
            return;

        // Looper emits ">>>>> Dispatching to <handler> <callback>: <what>"
        // then "<<<<< Finished to <handler> <callback>".
        if (message[0] == '>')
        {
            _current = message;
            _startedAt = SystemClock.UptimeMillis();
            return;
        }

        var elapsed = SystemClock.UptimeMillis() - _startedAt;
        if (elapsed >= thresholdMs)
            Log.Warn("anr-hunt", $"main thread busy {elapsed} ms: {_current}");
        _current = null;
    }
}
```

Install it early, and only in a build you intend to throw away:

```csharp
// Platforms/Android/MainActivity.cs
protected override void OnCreate(Bundle? savedInstanceState)
{
    base.OnCreate(savedInstanceState);
#if ANR_HUNT
    Looper.MainLooper!.SetMessageLogging(new MainThreadWatchdog(thresholdMs: 300));
#endif
}
```

Then watch it under real use:

```sh
adb logcat -s anr-hunt:W
```

A 300 ms threshold is aggressive on purpose. An input-dispatch ANR needs 5000 ms, but a handler that costs 400 ms on your development phone will cost several seconds on a four-year-old device with a cold page cache, and those devices are where your vitals number comes from.

What this gives you is a duration and a Looper target string. What it does not give you is a C# method name: a continuation posted by the runtime arrives as a generic `Java.Lang.IRunnable` wrapper, so the `<callback>` field reads as an opaque `crc64...` type. That is what step 4 is for.

## Step 4: name the state machine

`Task` posts its continuations through `SynchronizationContext.Post`, and on the Android main thread that context is the one that marshals back to the main `Handler`. Wrap it and you can inspect the posted state before handing it on.

The subtlety is that the `SendOrPostCallback` delegate is not your method. The runtime uses a single shared static callback and passes the real continuation in `state`, as an `Action` whose target is the boxed async state machine. That box is a generic type whose type argument is the compiler-generated struct for your method, and its name contains the original method name.

```csharp
// Platforms/Android/AnrHuntingSyncContext.cs, .NET 11
using System.Diagnostics;
using Android.Util;

sealed class AnrHuntingSyncContext(SynchronizationContext inner, long thresholdMs)
    : SynchronizationContext
{
    public override void Post(SendOrPostCallback d, object? state)
    {
        var origin = Describe(d, state);
        inner.Post(_ =>
        {
            var sw = Stopwatch.StartNew();
            d(state);
            if (sw.ElapsedMilliseconds >= thresholdMs)
                Log.Warn("anr-hunt", $"continuation {sw.ElapsedMilliseconds} ms: {origin}");
        }, null);
    }

    public override SynchronizationContext CreateCopy() =>
        new AnrHuntingSyncContext(inner.CreateCopy(), thresholdMs);

    // Best effort. Reads the boxed state machine the runtime passes as `state`;
    // this is an implementation detail, so fall back to the delegate's method.
    private static string Describe(SendOrPostCallback d, object? state)
    {
        if (state is Action a && a.Target is { } box)
        {
            var t = box.GetType();
            if (t.IsGenericType)
                // AsyncStateMachineBox`1[MyApp.MainPage+<OnSyncClicked>d__7]
                return t.GetGenericArguments()[0].FullName ?? t.Name;
            return t.FullName ?? t.Name;
        }
        return $"{d.Method.DeclaringType?.FullName}.{d.Method.Name}";
    }
}
```

Install it on the main thread, after MAUI has set up its own context:

```csharp
// Platforms/Android/MainActivity.cs
protected override void OnCreate(Bundle? savedInstanceState)
{
    base.OnCreate(savedInstanceState);
#if ANR_HUNT
    Looper.MainLooper!.SetMessageLogging(new MainThreadWatchdog(300));
    SynchronizationContext.SetSynchronizationContext(
        new AnrHuntingSyncContext(SynchronizationContext.Current!, thresholdMs: 300));
#endif
}
```

The log line you are hunting for looks like this, and it is the whole point of the exercise:

```
W anr-hunt: continuation 4412 ms: MyApp.MainPage+<OnSyncClicked>d__7
```

Three constraints, all of which matter:

- Only continuations whose `await` captured the context **after** you installed the wrapper go through it. Install it in `OnCreate`, before the first page is built.
- `MainThread.BeginInvokeOnMainThread` and MAUI's `IDispatcher` post to the Android `Handler` directly, not through the `SynchronizationContext`, so they bypass this wrapper entirely. The Looper printer from step 3 still sees them, which is why you run both.
- Code that awaits with [`ConfigureAwait(false)`](/2026/05/configureawait-false-vs-default-in-dotnet-11/) does not capture the context at all, and its continuation is correctly invisible here. That is the behaviour you want: it is not resuming on the main thread.

## Step 5: confirm with `dotnet-trace`

Once you have a suspect, measure it. Under CoreCLR on .NET 11 the diagnostic component is built into the runtime, so `EnableDiagnostics` is not required (on .NET 10 with Mono it is, and it ships `libmono-component-diagnostics_tracing.so` into the package).

```sh
# .NET 11, dotnet-trace and dotnet-dsrouter 9.0.652701 or newer
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-dsrouter

# Physical Android device. Use 10.0.2.2 instead of 127.0.0.1 on an emulator.
dotnet build -t:Run -c Release -f net11.0-android \
  -p:DiagnosticAddress=127.0.0.1 -p:DiagnosticPort=9000 \
  -p:DiagnosticSuspend=false -p:DiagnosticListenMode=connect

dotnet-trace collect --dsrouter android --format speedscope
```

Navigate to the screen, tap the button, press Enter to stop, and open the `.speedscope.json` at [speedscope.app](https://speedscope.app/). Select the main thread, switch to the sandwich view, and sort by self time. The frame you are looking for is `MainPage.OnSyncClicked` with a wide, contiguous block, and directly under it whatever is actually costing the time.

Profile `Release` builds only. Debug builds on Android run under the interpreter (`UseInterpreter=true`) for hot reload, and the timings you get from them are fiction.

## The fixes, in the order you should try them

Once the handler is named, the repair is almost always one of four things.

**Make the handler a shim over a `Task`-returning method.** The event signature forces `void`, but nothing forces the body to be long.

```csharp
// The only line allowed to be async void.
private void OnSyncClicked(object sender, EventArgs e) => _ = SyncAsync();

private async Task SyncAsync()
{
    _syncButton.IsEnabled = false;                    // re-entrancy guard
    try
    {
        var orders = await Task.Run(() => _repo.LoadPendingOrders());
        await RenderAsync(orders);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "sync failed");           // an async void body cannot do this
    }
    finally
    {
        _syncButton.IsEnabled = true;
    }
}
```

**Push the synchronous prefix onto the thread pool.** `Task.Run` is the right tool here specifically because the work is CPU-bound or blocking-IO-bound and is currently running on the UI thread. That is the case `Task.Run` exists for.

**Delete the blocking call.** If the handler contains `.Result`, `.Wait()`, or `GetAwaiter().GetResult()`, none of the instrumentation above matters until that is gone. The mechanical version of this is covered in [migrating from blocking .Result/.Wait() calls to async all the way up](/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/).

**Bind to a command instead of an event.** `AsyncRelayCommand` from the MVVM Community Toolkit returns a `Task` that the framework observes, which removes the `async void` from your code entirely and gives you `IsRunning` for free as the re-entrancy guard.

## Gotchas that waste an afternoon

**A fire-and-forget `_ =` discard still swallows exceptions.** The shim above logs inside `SyncAsync`, which is what makes it safe. A bare `_ = SomethingAsync()` with no `try` inside is the same unobserved-exception hazard as `async void`, just quieter, and the compiler will not warn because the discard suppresses [CS4014](/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/).

**`StrictMode` will not find this.** `StrictMode.ThreadPolicy` with `DetectAll()` catches disk and network access on the main thread, which is a useful adjacent check, but it is blind to CPU-bound managed work and to a thread blocked on a managed lock. Both of those are ANR causes.

**Your ANR cluster may not be a handler at all.** Check the vitals cluster's top frame before spending a day on this. `handleBindApplication` means slow startup. `nativePollOnce` means the main thread was idle. Only the busy or blocked shapes point at a handler.

**Ship the instrumentation nowhere.** The `Looper` printer allocates a string per message and the `SynchronizationContext` wrapper adds a `Stopwatch` and a closure per posted continuation. Both are cheap enough to leave on during a debugging session on a Release build, and both are unacceptable in production. Gate them behind an MSBuild-defined constant (`<DefineConstants>$(DefineConstants);ANR_HUNT</DefineConstants>` in a dedicated build configuration) so the code cannot reach the Play Store by accident.

**Watch the API level.** Broadcast receiver budgets tightened on Android 14, and a receiver that was comfortably inside 10 seconds can now be starved into the 10-20 second window under CPU pressure. If you recently retargeted, cross-check against [what changes at API level 36](/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).

The pattern behind all of it is that `async void` is not the bug. It is the construct that makes the bug invisible: it removes the return value that would have let a caller wait, the exception path that would have told you it failed, and the compiler warning that would have flagged it. Naming the state machine is how you get the visibility back.

## Related

- [async void vs async Task in C#: when each is correct](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Fix: deadlock when calling .Result or .Wait() on an async method in C#](/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Migrate a .NET MAUI Android app from Mono to CoreCLR in .NET 11](/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/)
- [ConfigureAwait(false) vs default in .NET 11: does it still matter?](/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Migrate from blocking .Result/.Wait() calls to async all the way up in a legacy C# codebase](/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)

## Sources

- [Diagnose and fix ANRs, Android Developers](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs)
- [ANRs, Android app quality documentation](https://developer.android.com/topic/performance/vitals/anr)
- [Play Console technical quality requirements](https://support.google.com/googleplay/android-developer/answer/17492799)
- [Performance profiling in .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/profiling)
- [dotnet-dsrouter documentation, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter)
- [Tracing .NET for Android applications, dotnet/android](https://github.com/dotnet/android/blob/main/Documentation/guides/tracing.md)
- [VSTHRD100 and VSTHRD101 analyzer documentation, microsoft/vs-threading](https://github.com/microsoft/vs-threading/blob/main/docfx/analyzers/index.md)
- [VSTHRD100 false positive on event handlers, microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510)
- [CoreCLR ANR while running large app, dotnet/android#10588](https://github.com/dotnet/android/issues/10588)
- [Capture and read bug reports, Android Studio documentation](https://developer.android.com/studio/debug/bug-report)
