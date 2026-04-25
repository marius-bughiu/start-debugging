---
title: "How to profile a .NET app with dotnet-trace and read the output"
description: "A complete guide to profiling .NET 11 apps with dotnet-trace: install, pick the right profile, capture from startup, and read the .nettrace output in PerfView, Visual Studio, Speedscope, or Perfetto."
pubDate: 2026-04-25
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "diagnostics"
  - "profiling"
---

To profile a .NET app with `dotnet-trace`, install the global tool with `dotnet tool install --global dotnet-trace`, find the target PID with `dotnet-trace ps`, then run `dotnet-trace collect --process-id <PID>`. With no flags, .NET 10/11 versions of the tool default to the `dotnet-common` and `dotnet-sampled-thread-time` profiles, which together cover the same ground the old `cpu-sampling` profile used to. Press Enter to stop the capture and `dotnet-trace` writes a `.nettrace` file. To read it, open it in Visual Studio or PerfView on Windows, or convert it to a Speedscope or Chromium file with `dotnet-trace convert` and view it in [speedscope.app](https://www.speedscope.app/) or `chrome://tracing` / Perfetto. This article uses dotnet-trace 9.0.661903 against .NET 11 (preview 3), but the workflow has been stable since .NET 5.

## What dotnet-trace actually captures

`dotnet-trace` is a managed-only profiler that talks to a .NET process over the [diagnostic port](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port) and asks the runtime to stream events through [EventPipe](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe). No native profiler is attached, no process is restarted, and no admin privileges are required (the `collect-linux` verb is the exception, more on that later). The output is a `.nettrace` file: a binary stream of events plus rundown information (type names, JIT IL-to-native maps) emitted at the end of the session.

That managed-only contract is the whole reason teams pick `dotnet-trace` over PerfView, ETW, or `perf record`. You get JIT-resolved managed call stacks, GC events, allocation samples, ADO.NET commands, and `EventSource`-based custom events from a single tool that runs identically on Windows, Linux, and macOS. What you do not get from the cross-platform `collect` verb are native frames, kernel stacks, or events from non-.NET processes.

## Install and capture your first trace

Install once per machine:

```bash
# Verified against dotnet-trace 9.0.661903, .NET 11 preview 3
dotnet tool install --global dotnet-trace
```

The tool picks up the highest .NET runtime on the machine. If you only have .NET 6 installed it still works, but you will not see the .NET 10/11 profile names introduced in 2025. Run `dotnet-trace --version` to confirm what you have.

Now find a PID. The tool's own `ps` verb is the safest option because it prints only managed processes that expose a diagnostic endpoint:

```bash
dotnet-trace ps
# 21932 dotnet  C:\Program Files\dotnet\dotnet.exe   run --configuration Release
# 36656 dotnet  C:\Program Files\dotnet\dotnet.exe
```

Capture for 30 seconds against the first PID:

```bash
dotnet-trace collect --process-id 21932 --duration 00:00:00:30
```

The console will print which providers got enabled, the output filename (default: `<appname>_<yyyyMMdd>_<HHmmss>.nettrace`), and a live KB counter. Press Enter early if you want to stop before the duration is up. Stopping is not instant: the runtime has to flush rundown information for every JIT-compiled method that appeared in the trace, which on a large app can take tens of seconds. Resist the urge to Ctrl+C twice.

## Pick the right profile

The whole reason `dotnet-trace` feels confusing the first time is that "what events should I capture?" has many right answers. The tool ships with named profiles so you do not have to memorize keyword bitmasks. As of dotnet-trace 9.0.661903, the `collect` verb supports:

- `dotnet-common`: lightweight runtime diagnostics. GC, AssemblyLoader, Loader, JIT, Exceptions, Threading, JittedMethodILToNativeMap, and Compilation events at the `Informational` level. Equivalent to `Microsoft-Windows-DotNETRuntime:0x100003801D:4`.
- `dotnet-sampled-thread-time`: samples managed thread stacks at roughly 100 Hz to identify hotspots over time. Uses the runtime's sample profiler with managed stacks.
- `gc-verbose`: GC collections plus sampled object allocations. Heavier than `dotnet-common` but the only way to find allocation hotspots without a memory profiler.
- `gc-collect`: GC collections only, very low overhead. Good for "is the GC pausing me?" without affecting steady-state throughput.
- `database`: ADO.NET and Entity Framework command events. Useful for catching N+1 queries.

When you run `dotnet-trace collect` with no flags, the tool now picks `dotnet-common` plus `dotnet-sampled-thread-time` by default. This combo replaces the old `cpu-sampling` profile, which sampled all threads regardless of CPU usage and led people to misread idle threads as hot. If you need the exact old behavior for back-compat with older traces, use `--profile dotnet-sampled-thread-time --providers "Microsoft-Windows-DotNETRuntime:0x14C14FCCBD:4"`.

You can stack profiles with commas:

```bash
dotnet-trace collect -p 21932 --profile dotnet-common,gc-verbose,database --duration 00:00:01:00
```

For anything more bespoke, use `--providers`. The format is `Provider[,Provider]` where each provider is `Name[:Flags[:Level[:KeyValueArgs]]]`. For example, to capture only contention events at verbose level:

```bash
dotnet-trace collect -p 21932 --providers "Microsoft-Windows-DotNETRuntime:0x4000:5"
```

If you want a friendlier syntax for runtime keywords, `--clrevents gc+contention --clreventlevel informational` is equivalent to `--providers Microsoft-Windows-DotNETRuntime:0x4001:4` and is much easier to read in scripts.

## Capture from startup

Half of the interesting performance issues happen in the first 200 ms before you can even copy a PID. .NET 5 added two ways to attach `dotnet-trace` before the runtime starts servicing requests.

The simplest is to let `dotnet-trace` launch the child process:

```bash
dotnet-trace collect --profile dotnet-common,dotnet-sampled-thread-time -- dotnet exec ./bin/Debug/net11.0/MyApp.dll arg1 arg2
```

By default, child stdin/stdout are redirected. Pass `--show-child-io` if you need to interact with the app on the console. Use `dotnet exec <app.dll>` or a published self-contained binary instead of `dotnet run`: the latter forks build/launcher processes that can connect to the tool first and leave your real app suspended at runtime.

The more flexible option is the diagnostic port. In one shell:

```bash
dotnet-trace collect --diagnostic-port myport.sock
# Waiting for connection on myport.sock
# Start an application with the following environment variable:
# DOTNET_DiagnosticPorts=/home/user/myport.sock
```

In another shell, set the environment variable and launch normally:

```bash
export DOTNET_DiagnosticPorts=/home/user/myport.sock
./MyApp arg1 arg2
```

The runtime suspends until the tool is ready, then starts as usual. This pattern composes with containers (mount the socket into the container), with services that you cannot easily wrap, and with multi-process scenarios where you only want to trace one specific child.

## Stop on a specific event

Long traces are noisy. If you only care about the slice between "JIT started compiling X" and "request finished", `dotnet-trace` can stop the moment a specific event fires:

```bash
dotnet-trace collect -p 21932 \
  --stopping-event-provider-name Microsoft-Windows-DotNETRuntime \
  --stopping-event-event-name Method/JittingStarted \
  --stopping-event-payload-filter MethodNamespace:MyApp.HotPath,MethodName:Render
```

The event stream is parsed asynchronously, so a few extra events leak through after the match before the session actually closes. That is normally not a problem when you are looking at hotspots.

## Read the .nettrace output

A `.nettrace` file is the canonical format. Three viewers handle it directly, and two more become available after a one-line conversion.

### PerfView (Windows, free)

[PerfView](https://github.com/microsoft/perfview) is the original tool the .NET runtime team uses. Open the `.nettrace` file, double-click "CPU Stacks" if you captured `dotnet-sampled-thread-time`, or "GC Heap Net Mem" / "GC Stats" if you captured `gc-verbose` or `gc-collect`. The "Exclusive %" column tells you where managed threads spent their time; "Inclusive %" tells you which call stack reached the hot frame.

PerfView is dense. The two clicks worth memorizing are: right-click a frame and pick "Set As Root" to drill in, and use the "Fold %" textbox to collapse small frames so the hot path is readable. If the trace was truncated by an unhandled exception, launch PerfView with the `/ContinueOnError` flag and you can still inspect what happened up to the crash.

### Visual Studio Performance Profiler

Visual Studio 2022/2026 opens `.nettrace` files directly via File > Open. The CPU Usage view is the friendliest UI for someone who has never used PerfView, with a flame graph, a "Hot Path" pane, and source-line attribution if your PDBs are nearby. The downside is that Visual Studio has fewer view types than PerfView, so allocation profiling and GC analysis are usually clearer in PerfView.

### Speedscope (cross-platform, browser)

The fastest way to look at a trace from Linux or macOS is to convert it to Speedscope and open the result in the browser. You can either ask `dotnet-trace` to write Speedscope directly:

```bash
dotnet-trace collect -p 21932 --format Speedscope --duration 00:00:00:30
```

Or convert an existing `.nettrace`:

```bash
dotnet-trace convert myapp_20260425_120000.nettrace --format Speedscope -o myapp.speedscope.json
```

Drag the resulting `.speedscope.json` into [speedscope.app](https://www.speedscope.app/). The "Sandwich" view is the killer feature: it sorts methods by total time and lets you click any one to see the callers and callees inline. It is the closest you will get to PerfView on a Mac. Note that the conversion is lossy: rundown metadata, GC events, and exception events are dropped. Keep the original `.nettrace` next to it if you might want to look at allocations later.

### Perfetto / chrome://tracing

`--format Chromium` produces a JSON file you can drop into `chrome://tracing` or [ui.perfetto.dev](https://ui.perfetto.dev/). This view shines for concurrency questions: thread pool spikes, async waterfalls, and lock contention symptoms read more naturally on a timeline than in a flame graph. The community write-up [Using dotnet-trace with Perfetto](https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/) walks through a full loop, and we covered [a practical Perfetto + dotnet-trace workflow](/2026/01/perfetto-dotnet-trace-a-practical-profiling-loop-for-net-9-net-10/) in more detail earlier this year.

### dotnet-trace report (CLI)

If you are on a headless server or just want a quick sanity check, the tool itself can summarize a trace:

```bash
dotnet-trace report myapp_20260425_120000.nettrace topN -n 20
```

This prints the top 20 methods by exclusive CPU time. Add `--inclusive` to switch to inclusive time and `-v` to print full parameter signatures. It is not a substitute for a viewer, but it is enough to answer "did the deploy regress something obvious?" without leaving SSH.

## Gotchas that bite first-time users

A handful of edge cases account for most of the "why is my trace empty?" reports.

- The buffer is 256 MB by default. High event-rate scenarios (every method in a tight loop, allocation sampling on a streaming workload) overflow that buffer and drop events silently. Increase it with `--buffersize 1024`, or narrow the providers.
- On Linux and macOS, `--name` and `--process-id` require the target app and `dotnet-trace` to share the same `TMPDIR` environment variable. If they do not match, the connection times out with no useful error. Containers and `sudo` invocations are the usual culprits.
- The trace is incomplete if the target app crashes mid-capture. The runtime truncates the file to avoid corruption. Open it in PerfView with `/ContinueOnError` and read what is there: it usually has enough to find the cause.
- `dotnet run` spawns helper processes that connect to a `--diagnostic-port` listener before your real app does. Use `dotnet exec MyApp.dll` or a published self-contained binary when you are tracing from startup.
- The default `--resume-runtime true` lets the app start as soon as the session is ready. If you want the app to stay suspended (rare, mostly for debuggers), pass `--resume-runtime:false`.
- For .NET 10 on Linux kernel 6.4+, the new `collect-linux` verb captures kernel events, native frames, and machine-wide samples, but it requires root and writes a preview-format `.nettrace` that not every viewer supports yet. Use it when you genuinely need native frames; default to `collect` for everything else.

## Where to go next

`dotnet-trace` is the right tool for "what is my app doing right now?". For continuous metrics (RPS, GC heap size, thread pool queue length) without producing a file at all, reach for `dotnet-counters`. For memory leak hunts that need an actual heap dump, reach for `dotnet-gcdump`. The three tools share the diagnostic-port plumbing, so the install / `ps` / `collect` muscle memory carries over.

If you write code that runs in production, you also want a tracing-friendly mental model of the language. Our notes on [cancelling long-running tasks without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), [streaming files from ASP.NET Core endpoints without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/), and [reading large CSV files in .NET 11 without running out of memory](/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) all show patterns that look very different in a `dotnet-trace` flame graph than the naive versions, and that is a good thing.

The `.nettrace` format is open: if you want to script analysis, [Microsoft.Diagnostics.Tracing.TraceEvent](https://www.nuget.org/packages/Microsoft.Diagnostics.Tracing.TraceEvent) reads the same files programmatically. That is how PerfView itself works under the hood, and how you build a one-off report when none of the existing viewers ask the question you actually have.

## Sources

- [dotnet-trace diagnostic tool reference](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace) (MS Learn, last updated 2026-03-19)
- [EventPipe documentation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe)
- [Diagnostic port documentation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostic-port)
- [Well-known event providers in .NET](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/well-known-event-providers)
- [PerfView on GitHub](https://github.com/microsoft/perfview)
- [Speedscope](https://www.speedscope.app/)
- [Perfetto UI](https://ui.perfetto.dev/)
