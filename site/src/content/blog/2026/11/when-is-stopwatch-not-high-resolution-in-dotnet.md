---
title: "When is Stopwatch not high resolution in .NET, and what do IsHighResolution and Frequency report on each OS?"
description: "On .NET Core and .NET 5+ Stopwatch.IsHighResolution is a hard-coded true and never false. Frequency is whatever QueryPerformanceFrequency says on Windows (usually 10 MHz) and a fixed 1,000,000,000 on Linux, macOS, iOS, Android and WASM, which is a unit, not a resolution. Only .NET Framework can fall back to DateTime. Source walkthrough plus a measured run on .NET 10 / Apple M4 showing 1 ns nominal ticks but 41.67 ns real steps."
pubDate: 2026-11-04
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "diagnostics"
---

**Short answer:** on .NET Core 3.x, .NET 5 and everything up to .NET 10 and .NET 11, `Stopwatch.IsHighResolution` is never false. It is declared as `public static readonly bool IsHighResolution = true;` with no condition, on every operating system. The only runtime where it can be false is .NET Framework, and only if `QueryPerformanceFrequency` fails, which Microsoft documents as impossible on Windows XP or later. `Stopwatch.Frequency` is where the platforms differ: on Windows it is the value `QueryPerformanceFrequency` returns (10,000,000 on most current Windows 10 and 11 machines, but not guaranteed), and on Linux, macOS, iOS, Android and browser WebAssembly it is a hard-coded `1,000,000,000`, meaning the timestamp is expressed in nanoseconds. That number is a unit, not a promise: on an Apple M4 running .NET 10.0.10 the reported tick is 1 ns, but consecutive `GetTimestamp()` reads move in steps of 41 or 42 ns because the underlying hardware counter runs at 24 MHz. So "is my Stopwatch high resolution?" is the wrong question to ask the API. The right question is "what is the real step of the clock underneath?", and you have to measure that.

The source excerpts below come from the `release/10.0` branch of [dotnet/runtime](https://github.com/dotnet/runtime), and the measurements were taken for this post with the .NET 10 SDK 10.0.302 (runtime 10.0.10, C# 14) on macOS 27.0.1, Apple M4, arm64. Windows and Linux behaviour is described from the runtime source and Microsoft's documentation; it was not executed for this post.

## Why IsHighResolution is always true on modern .NET

The cross-platform part of `Stopwatch` lives in `System.Private.CoreLib/src/System/Diagnostics/Stopwatch.cs`. The two static fields that everyone reads look like this:

```csharp
// dotnet/runtime, release/10.0, Stopwatch.cs
public static readonly long Frequency = GetFrequency();
public static readonly bool IsHighResolution = true;

private static readonly double s_tickFrequency = (double)TimeSpan.TicksPerSecond / Frequency;
```

There is no fallback path. `GetFrequency()` and `GetTimestamp()` are supplied by one of two partial files, chosen at build time: `Stopwatch.Windows.cs` or `Stopwatch.Unix.cs`. Neither has a branch that switches to `DateTime`.

`IsHighResolution` survives as a field purely for source compatibility with .NET Framework code that checks it. If you have a guard like this in a library:

```csharp
// .NET 10, C# 14
if (!Stopwatch.IsHighResolution)
{
    throw new PlatformNotSupportedException("Need a high resolution timer.");
}
```

it is dead code on every .NET Core target. It will not warn you on a machine with a coarse clock, because the runtime does not know or check how coarse the clock is.

## Where IsHighResolution really could be false: .NET Framework

The [.NET Framework reference source](https://github.com/microsoft/referencesource/blob/master/System/services/monitoring/system/diagnosticts/Stopwatch.cs) is the origin of the field. Its static constructor calls `QueryPerformanceFrequency`, and only if that call returns false does it set `IsHighResolution = false`, set `Frequency` to `TimeSpan.TicksPerSecond` (10,000,000), and make `GetTimestamp()` return `DateTime.UtcNow.Ticks`. In that mode the timestamp unit is 100 ns but the real step is the system timer interrupt, typically around 15.6 ms on Windows, so short intervals measure as zero.

The MS Learn page for [`Stopwatch.IsHighResolution`](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.stopwatch.ishighresolution) still describes this: when false, the timer "is based on the system timer". But the Win32 documentation on [acquiring high-resolution time stamps](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps) says the frequency query cannot fail on any system running Windows XP or later, provided the arguments are valid. In practice the false branch was reachable on Windows 2000-era hardware and nowhere since.

## What Frequency reports on each OS

### Windows: whatever QueryPerformanceFrequency says

`Stopwatch.Windows.cs` is a thin wrapper:

```csharp
// dotnet/runtime, release/10.0, Stopwatch.Windows.cs
private static unsafe long GetFrequency()
{
    long resolution;
    Interop.BOOL result = Interop.Kernel32.QueryPerformanceFrequency(&resolution);
    Debug.Assert(result != Interop.BOOL.FALSE);
    return resolution;
}

public static unsafe long GetTimestamp()
{
    long timestamp;
    Interop.BOOL result = Interop.Kernel32.QueryPerformanceCounter(&timestamp);
    Debug.Assert(result != Interop.BOOL.FALSE);
    return timestamp;
}
```

So `Frequency` on Windows is the QPC frequency, which Windows decides once at boot. On most current Windows 10 and 11 machines that is 10,000,000 (a 100 ns unit), because the Win32 docs note the frequency is fixed to 10 MHz under a hypervisor using the version 1.0 interface and in some newer Windows versions. Microsoft's own example machine in the same document reports 3,125,000, and the page explicitly warns not to assume the value is derived from the hardware frequency. Code that hard-codes `10_000_000` will be right most of the time on Windows and wrong somewhere you do not control.

The real resolution on Windows depends on what backs QPC:

- **Invariant TSC** (almost every x64 desktop and server from the last decade): QPC reads the CPU timestamp counter. Microsoft's table lists sub-microsecond resolution and roughly 30 ns access time on such hardware.
- **HPET or ACPI PM timer**: Windows 7 and later fall back to a platform counter when the TSC is unsuitable (non-invariant TSC, cores that cannot be synchronised, some multi-socket servers). Each read is then a hardware I/O access, documented as costing "in the vicinity of 0.8 - 1.0 microseconds". `Frequency` will usually still say 10 MHz, but every `GetTimestamp()` costs roughly 30 times more than a TSC read, which shows up in tight measurement loops.
- **Arm64 Windows**: the Arm Generic Timer or a vendor platform counter.

Windows QPC also keeps counting while the machine is in standby, hibernate or connected standby, per the same document. That matters for the cross-platform comparison below.

### Linux, macOS, iOS, Android, WASM: a fixed nanosecond unit

`Stopwatch.Unix.cs` does not ask the OS for anything:

```csharp
// dotnet/runtime, release/10.0, Stopwatch.Unix.cs
private static long GetFrequency()
{
    const long SecondsToNanoSeconds = 1000000000;
    return SecondsToNanoSeconds;
}

public static long GetTimestamp() => Interop.Sys.GetTimestamp();
```

`Interop.Sys.GetTimestamp` lands in `SystemNative_GetTimestamp`, which calls `minipal_hires_ticks()` in `src/native/minipal/time.c`:

```c
// dotnet/runtime, release/10.0, src/native/minipal/time.c
int64_t minipal_hires_ticks(void)
{
#if HAVE_CLOCK_GETTIME_NSEC_NP
    return (int64_t)clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
#elif HAVE_CLOCK_MONOTONIC
    struct timespec ts;
    int result = clock_gettime(CLOCK_MONOTONIC, &ts);
    // ...
    return ((int64_t)(ts.tv_sec) * (int64_t)(tccSecondsToNanoSeconds)) + (int64_t)(ts.tv_nsec);
#endif
}
```

Two consequences follow.

First, `Frequency` is `1,000,000,000` on every non-Windows platform no matter what the hardware does. It tells you the unit of `GetTimestamp()` (nanoseconds), not the resolution. The nanosecond value is computed by the OS from a coarser hardware counter.

Second, the clock source differs between Apple platforms and everything else:

| Platform | Clock behind `GetTimestamp()` | `Frequency` | Counts during system sleep? |
|---|---|---|---|
| Windows (x64, Arm64) | `QueryPerformanceCounter` | QPC frequency, commonly 10,000,000 | Yes |
| macOS, iOS, tvOS, Mac Catalyst | `clock_gettime_nsec_np(CLOCK_UPTIME_RAW)` | 1,000,000,000 | No |
| Linux, Android | `clock_gettime(CLOCK_MONOTONIC)` | 1,000,000,000 | No |
| Browser WASM | Emscripten `clock_gettime(CLOCK_MONOTONIC)`, backed by `performance.now()` | 1,000,000,000 | Browser dependent |

`CLOCK_UPTIME_RAW` on Apple platforms and `CLOCK_MONOTONIC` on Linux both stop while the system is suspended. If you start a `Stopwatch`, close a laptop lid for an hour and open it again, Windows reports roughly an hour and macOS or Linux report roughly the time the machine was awake. For measuring code that is what you want; for measuring "wall time until a token expires" it is not, and you should use `DateTimeOffset.UtcNow` or `TimeProvider.GetUtcNow()` instead.

In the browser, the nanosecond unit is the most misleading. [MDN documents](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now) that `performance.now()` is coarsened to 100 microseconds in non-isolated contexts and 5 microseconds in cross-origin isolated ones, as a side-channel mitigation. A Blazor WebAssembly app still sees `Stopwatch.Frequency == 1_000_000_000` while the clock moves in 5 to 100 microsecond jumps.

## Measuring the real step instead of trusting Frequency

Because neither field tells you the real granularity, measure it. This program reads a clock in a tight loop and records the smallest non-zero difference between consecutive reads, plus the most common steps:

```csharp
// .NET 10, C# 14
// dotnet run -c Release
using System.Diagnostics;
using System.Runtime.InteropServices;

Console.WriteLine($"{RuntimeInformation.OSDescription} {RuntimeInformation.ProcessArchitecture}, {RuntimeInformation.FrameworkDescription}");
Console.WriteLine($"Stopwatch.IsHighResolution = {Stopwatch.IsHighResolution}");
Console.WriteLine($"Stopwatch.Frequency        = {Stopwatch.Frequency:N0} ticks/s");
Console.WriteLine($"Nominal tick               = {1e9 / Stopwatch.Frequency} ns");

Console.WriteLine($"Stopwatch.GetTimestamp step: {Granularity(Stopwatch.GetTimestamp, 1_000_000)}");
Console.WriteLine($"DateTime.UtcNow step (ticks): {Granularity(() => DateTime.UtcNow.Ticks, 1_000_000)}");
Console.WriteLine($"Environment.TickCount64 step (ms): {Granularity(() => Environment.TickCount64, 50_000_000)}");

const int N = 20_000_000;
long sink = 0;
long t0 = Stopwatch.GetTimestamp();
for (int i = 0; i < N; i++) sink += Stopwatch.GetTimestamp();
TimeSpan total = Stopwatch.GetElapsedTime(t0);
Console.WriteLine($"GetTimestamp cost: {total.TotalNanoseconds / N:F1} ns/call (sink {sink & 1})");

static string Granularity(Func<long> read, int samples)
{
    long minStep = long.MaxValue, changes = 0, prev = read();
    var steps = new Dictionary<long, int>();
    for (int i = 0; i < samples; i++)
    {
        long now = read();
        long d = now - prev;
        if (d > 0)
        {
            changes++;
            if (d < minStep) minStep = d;
            steps[d] = steps.GetValueOrDefault(d) + 1;
        }
        prev = now;
    }
    var top = string.Join(", ", steps.OrderByDescending(kv => kv.Value).Take(4).Select(kv => $"{kv.Key}x{kv.Value}"));
    return $"min {minStep}, changes {changes:N0}/{samples:N0}, most common steps [{top}]";
}
```

Output on .NET 10.0.10, macOS 27.0.1, Apple M4, Release build, run with `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` so the number formatting is stable:

```text
macOS 27.0.1 Arm64, .NET 10.0.10
Stopwatch.IsHighResolution = True
Stopwatch.Frequency        = 1,000,000,000 ticks/s
Nominal tick               = 1 ns
Stopwatch.GetTimestamp step: min 41, changes 320,212/1,000,000, most common steps [42x212671, 41x106327, 83x725, 84x363]
DateTime.UtcNow step (ticks): min 10, changes 15,718/1,000,000, most common steps [10x15715, 80x1, 50x1, 60x1]
Environment.TickCount64 step (ms): min 1, changes 455/50,000,000, most common steps [1x455]
GetTimestamp cost: 9.2 ns/call (sink 0)
```

Reading it:

- `Frequency` claims 1 ns, but the clock never moved by less than 41 ns. The steps alternate between 41 and 42 ns, which is `1 / 24 MHz = 41.67 ns` rounded to whole nanoseconds. `sysctl hw.tbfrequency` on the same machine reports `24000000`, the Apple Silicon timebase that `CLOCK_UPTIME_RAW` is derived from.
- Only about a third of consecutive reads saw any change, because one `GetTimestamp()` call (about 9 ns) is much shorter than one 41.67 ns step. Two back-to-back reads frequently return the same value. Any interval shorter than roughly 42 ns can measure as zero on this machine.
- `DateTime.UtcNow` on macOS moves in 10 tick steps, which is 1 microsecond, because it is built on a microsecond wall clock. That is fine for timestamps and too coarse for micro-timing.
- `Environment.TickCount64` steps by 1 ms here. On Windows it is backed by `GetTickCount64` and follows the system timer interrupt, usually 15.6 ms.

Run the same program on your target hardware before trusting a sub-microsecond measurement. On a Windows x64 box with an invariant TSC you should expect the minimum step to be 1 QPC tick (100 ns at 10 MHz); on a VM or a box falling back to HPET, the step stays the same but the per-call cost grows sharply. Those Windows expectations come from Microsoft's QPC documentation, not from a run done for this post.

## The bug that Frequency actually causes: mixing tick units

On modern .NET the coarse-clock problem is rarely what breaks code. Unit confusion is. `Stopwatch` has two kinds of "ticks":

- `Stopwatch.ElapsedTicks` and `Stopwatch.GetTimestamp()` are in **timestamp ticks**: `1 / Stopwatch.Frequency` seconds.
- `TimeSpan.Ticks`, `Stopwatch.Elapsed.Ticks` and `DateTime.Ticks` are in **TimeSpan ticks**: always 100 ns.

On a typical Windows machine with a 10 MHz QPC the two units coincide, so `new TimeSpan(sw.ElapsedTicks)` happens to be right. Move the same code to Linux, macOS or a container and it is wrong by a factor of 100:

```csharp
// .NET 10, C# 14
var sw = Stopwatch.StartNew();
Thread.Sleep(50);
sw.Stop();
Console.WriteLine($"Slept 50 ms. sw.ElapsedTicks = {sw.ElapsedTicks:N0}, sw.Elapsed.Ticks = {sw.Elapsed.Ticks:N0}");
Console.WriteLine($"Wrong: new TimeSpan(sw.ElapsedTicks) = {new TimeSpan(sw.ElapsedTicks)}");
Console.WriteLine($"Right: sw.Elapsed                    = {sw.Elapsed}");
```

Output from the same macOS run:

```text
Slept 50 ms. sw.ElapsedTicks = 55,027,667, sw.Elapsed.Ticks = 550,276
Wrong: new TimeSpan(sw.ElapsedTicks) = 00:00:05.5027667
Right: sw.Elapsed                    = 00:00:00.0550276
```

A 55 ms sleep reported as 5.5 seconds. This is the classic "our latency metrics are 100x too high only in production" bug: developers test on Windows, production runs in a Linux container. The fixes, in order of preference:

1. Use `sw.Elapsed` or `Stopwatch.GetElapsedTime(start)` and never touch raw ticks.
2. If you store raw timestamps (for example in a struct to avoid allocating a `Stopwatch`), convert with `Stopwatch.GetElapsedTime(start, end)`, available since .NET 7.
3. If you must do the arithmetic yourself, divide by `Stopwatch.Frequency`: `seconds = (double)(end - start) / Stopwatch.Frequency`. Never multiply by a hard-coded 100 or 10,000,000.

```csharp
// .NET 7+ (shown on .NET 10, C# 14): allocation-free timing
long start = Stopwatch.GetTimestamp();
DoWork();
TimeSpan elapsed = Stopwatch.GetElapsedTime(start);
Console.WriteLine($"{elapsed.TotalMicroseconds:F1} us");

static void DoWork() => Thread.SpinWait(10_000);
```

## Gotchas around the edges

**`Elapsed` truncates to 100 ns.** `GetElapsedTime` computes `(long)((end - start) * s_tickFrequency)`, where `s_tickFrequency` is `TimeSpan.TicksPerSecond / Frequency`. On Linux and macOS that is 0.01, so any nanoseconds below a whole 100 ns TimeSpan tick are dropped. If you need nanosecond output on Unix, keep the raw timestamp delta: it is already in nanoseconds there. On Windows, raw deltas are in QPC units, so the portable form is `(end - start) * 1_000_000_000.0 / Stopwatch.Frequency`.

**`ElapsedMilliseconds` truncates too.** It is `ElapsedTimeSpanTicks / TimeSpan.TicksPerMillisecond`, integer division. A 0.9 ms operation reports 0. Use `Elapsed.TotalMilliseconds` for fractional values.

**`TimeProvider.System` inherits all of this.** `TimeProvider.TimestampFrequency` is implemented as `Stopwatch.Frequency` and `TimeProvider.GetTimestamp()` as `Stopwatch.GetTimestamp()`. Switching to `TimeProvider` for testability does not change resolution or units. A fake provider can report a completely different frequency, which is another reason to convert through `GetElapsedTime` instead of assuming a unit. The post on [testing time-dependent code with TimeProvider and FakeTimeProvider](/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) covers the fake side.

**Resolution is not the same as sleep or timer granularity.** A 42 ns clock step does not mean `Thread.Sleep(1)` or `Task.Delay(1)` wakes up after 1 ms. In the run above, `Thread.Sleep(50)` took 55 ms. Waiting precision is governed by the scheduler and the timer queue, which the comparison of [Thread.Sleep, Task.Delay and SpinWait](/2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp/) goes into.

**Cross-process and cross-machine timestamps are meaningless.** `GetTimestamp()` values are only comparable within one boot of one machine. On Linux and macOS they start near the boot time (excluding sleep), on Windows they are QPC counts. Do not persist them or send them over the wire; send `DateTimeOffset` values for that.

**`Frequency` is a `static readonly` read once per process.** It cannot change while the process is running, and the Win32 docs state the QPC frequency itself is fixed at boot. Caching it in your own code is safe; caching a hard-coded value from your dev machine is not.

**Measurement overhead dominates tiny intervals.** At 9 ns per `GetTimestamp()` on an M4, and up to about 1 microsecond per read on a Windows machine using HPET, timing a single 50 ns operation with a pair of timestamps tells you very little. Time a loop of many iterations and divide, or use BenchmarkDotNet, which measures the timer's resolution and overhead for you and picks an iteration count accordingly. For finding where time goes in a real app rather than a micro-benchmark, a trace beats ad-hoc stopwatches; see the [dotnet-trace and Perfetto profiling loop](/2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10/).

**Use `GetTimestamp` in hot paths, not `new Stopwatch()`.** Each `Stopwatch` is a heap allocation. Instrumenting a per-request path with `Stopwatch.StartNew()` adds GC pressure for no benefit; the static `GetTimestamp()` plus `GetElapsedTime()` pair is allocation free. The [background job monitoring post](/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) uses that pattern for job duration metrics.

## A quick decision guide

- Checking `IsHighResolution`: stop. It is always `true` on .NET Core and .NET 5+.
- Converting `ElapsedTicks` or timestamp deltas to time: use `Elapsed` or `Stopwatch.GetElapsedTime`, or divide by `Frequency`. Never assume 10,000,000.
- Needing to know the real resolution on a target: run the granularity probe above on that hardware.
- Measuring durations across system sleep: on Linux and macOS, `Stopwatch` excludes suspended time; use a wall clock if the sleep should count.
- Measuring sub-microsecond code: loop and divide, or use BenchmarkDotNet. A single pair of timestamps is below the noise floor.

## Sources

- [`Stopwatch.cs`, `Stopwatch.Windows.cs`, `Stopwatch.Unix.cs` in dotnet/runtime](https://github.com/dotnet/runtime/tree/release/10.0/src/libraries/System.Private.CoreLib/src/System/Diagnostics)
- [`minipal/time.c` in dotnet/runtime](https://github.com/dotnet/runtime/blob/release/10.0/src/native/minipal/time.c)
- [.NET Framework reference source: `Stopwatch.cs`](https://github.com/microsoft/referencesource/blob/master/System/services/monitoring/system/diagnosticts/Stopwatch.cs)
- [Acquiring high-resolution time stamps (Win32)](https://learn.microsoft.com/en-us/windows/win32/sysinfo/acquiring-high-resolution-time-stamps)
- [`Stopwatch.IsHighResolution` on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.stopwatch.ishighresolution)
- [`Stopwatch.Frequency` on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.stopwatch.frequency)
- [`performance.now()` on MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now)
