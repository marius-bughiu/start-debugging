---
title: "Perfetto + dotnet-trace: a practical profiling loop for .NET 9/.NET 10"
description: "The fastest way to get unstuck on “it’s slow” in .NET is to stop guessing and start looking at a timeline. A neat write-up making the rounds this week shows a clean workflow: capture traces with dotnet-trace, then inspect them in Perfetto (the same trace viewer ecosystem many people know from Android and Chromium land):…"
pubDate: 2026-01-21
updatedDate: 2026-01-23
tags:
  - "net"
  - "net-10"
  - "net-9"
  - "performance"
---
The fastest way to get unstuck on “it’s slow” in .NET is to stop guessing and start looking at a timeline. A neat write-up making the rounds this week shows a clean workflow: capture traces with `dotnet-trace`, then inspect them in Perfetto (the same trace viewer ecosystem many people know from Android and Chromium land): `https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/`.

## Why Perfetto is worth adding to your toolbox

If you already use `dotnet-counters` or a profiler, Perfetto is not a replacement. It is a complement:

-   You get a visual timeline that makes concurrency issues (thread pool spikes, lock contention symptoms, async waterfalls) much easier to reason about.
-   You can share a trace file with another engineer without asking them to install your IDE or your commercial profiler.

For .NET 9 and .NET 10 apps, this is especially useful when you are trying to validate that a “small” change did not accidentally introduce extra allocations, extra threads, or a new sync bottleneck.

## The capture loop (repro first, trace second)

The trick is to treat tracing as a loop, not a one-off:

-   Make the slowdown reproducible (same endpoint, same payload, same dataset).
-   Capture 10-30 seconds around the interesting window.
-   Inspect, form a hypothesis, change one thing, repeat.

Here’s the minimal capture sequence using the global tool:

```bash
dotnet tool install --global dotnet-trace

# Find the PID of the target process (pick one)
dotnet-trace ps

# Capture an EventPipe trace (default providers are usually a good starting point)
dotnet-trace collect --process-id 12345 --duration 00:00:15 --output app.nettrace
```

You will end up with `app.nettrace`. From there, follow the conversion/open steps in the source post above (the exact “open in Perfetto” path depends on which Perfetto UI you use and what conversion step you choose).

## What to look for when you open the trace

Start with questions you can answer in minutes:

-   **CPU usage**: Are you CPU-bound (hot methods) or waiting (blocking, sleeping, I/O)?
-   **Thread pool behavior**: Do you see bursts of worker threads that correlate with latency spikes?
-   **GC correlation**: Do pause windows line up with the slow request or only with background activity?

Once you find a suspicious window, jump back to code and add a surgical change (for example: reduce allocations, avoid sync-over-async, remove a lock from the request hot path, or batch expensive calls).

## One pragmatic pattern: trace in Release, without losing symbols

If you can, run the slow path in Release (closer to production), but still keep enough info to reason about frames. In SDK-style projects, PDBs are produced by default; for a profiling session you usually want predictable output paths:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
    <Configuration>Release</Configuration>
    <DebugType>portable</DebugType>
  </PropertyGroup>
</Project>
```

Keep it boring: stable input, stable configuration, short traces, repeat.

If you want the detailed Perfetto steps and screenshots, the original post is the best reference to keep open while you run the loop: `https://dfamonteiro.com/posts/using-dotnet-trace-with-perfetto/`.
