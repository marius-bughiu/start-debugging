---
title: "Polly 8.8.1: The Circuit Breaker No Longer Keeps the First Caller's AsyncLocal Values Alive"
description: "Polly.Core 8.8.1 starts the circuit breaker's background loop under ExecutionContext.SuppressFlow, so a long-lived pipeline stops pinning the AsyncLocal values of whoever built it. A 15-line repro shows the leak on 8.8.0 and the fix on 8.8.1."
pubDate: 2026-10-27
tags:
  - "polly"
  - "resilience"
  - "dotnet"
  - "csharp"
  - "memory-leaks"
---

[Polly 8.8.1](https://github.com/App-vNext/Polly/releases/tag/8.8.1) shipped on October 26, 2026, and the headline fix is a memory leak that is easy to have without knowing it. Every circuit breaker strategy built with Polly.Core 8.8.0 or earlier kept the `ExecutionContext` of the code that built it alive for the lifetime of the pipeline. That includes every `AsyncLocal<T>` value that was set at that moment.

## Why a circuit breaker captured your context

The circuit breaker uses an internal `ScheduledTaskExecutor` to run its state-change callbacks (`OnOpened`, `OnClosed`, `OnHalfOpened`) off the hot path. Its constructor started a processing loop with `Task.Run(StartProcessingAsync)`. `Task.Run` flows the current `ExecutionContext` by default, and the loop then waits on a `SemaphoreSlim` until the pipeline is disposed.

So whoever happened to trigger the build donated their ambient state to a task that never finishes. For a pipeline in a `ResiliencePipelineRegistry`, or one that `Microsoft.Extensions.Http.Resilience` builds for a named `HttpClient`, "the lifetime of the pipeline" means the lifetime of the app. [Issue #3275](https://github.com/App-vNext/Polly/issues/3275) describes the worst case: in a Blazor Server app, the first user's circuit builds the pipeline, an `AsyncLocal`-based accessor carries that circuit's services, and the circuit is never collected after the user leaves.

## Reproducing it in a file-based app

This runs as-is with `dotnet run repro.cs` on the .NET 10 SDK. Change the package version to compare:

```csharp
#:package Polly.Core@8.8.0
using System.Runtime.CompilerServices;
using Polly;

AsyncLocal<object?> current = new();

var (pipeline, value) = Build();
for (int i = 0; i < 3; i++) { GC.Collect(); GC.WaitForPendingFinalizers(); }
GC.KeepAlive(pipeline);
Console.WriteLine($"alive: {value.IsAlive}");

[MethodImpl(MethodImplOptions.NoInlining)]
(ResiliencePipeline, WeakReference) Build()
{
    object payload = new byte[1024];
    current.Value = payload; // whatever the first caller's flow carries
    var p = new ResiliencePipelineBuilder().AddCircuitBreaker(new()).Build();
    current.Value = null;
    return (p, new WeakReference(payload));
}
```

On my machine (SDK 10.0.302), `Polly.Core@8.8.0` prints `alive: True` and `Polly.Core@8.8.1` prints `alive: False`. Clearing the `AsyncLocal` afterwards does not help on 8.8.0, because the background task holds a snapshot of the context taken when it started, not a live view of it.

## The fix

[PR #3284](https://github.com/App-vNext/Polly/pull/3284) is three lines:

```csharp
public ScheduledTaskExecutor()
{
    using (ExecutionContext.SuppressFlow())
    {
        ProcessingTask = Task.Run(StartProcessingAsync);
    }
}
```

There is one behavior change to know about: your state-change callbacks no longer see the builder's `AsyncLocal` values. They never reliably saw the values of the request that actually tripped the breaker anyway, only those of the code that built the pipeline. If you relied on that, for example reading `Activity.Current` or a tenant accessor inside `OnOpened`, pass what you need through `ResilienceContext` or the callback arguments instead.

## What to do

Update `Polly.Core` (and `Polly.Extensions` if you reference it directly) to 8.8.1. `Microsoft.Extensions.Http.Resilience` pulls Polly transitively, so add an explicit reference if your lock file is still on 8.8.0:

```xml
<PackageReference Include="Polly.Core" Version="8.8.1" />
```

If you cannot upgrade yet, the workaround from the issue is to build the pipelines eagerly at startup inside `ExecutionContext.SuppressFlow()`, before any request can be the one that builds them.

The same release also speeds up pipeline execution ([#3287](https://github.com/App-vNext/Polly/pull/3287)) and fixes a related cleanup gap in the registry ([#3288](https://github.com/App-vNext/Polly/pull/3288)): when two callers raced to initialize the same key, the losing pipeline was discarded but kept its resources and reload registrations. It now goes through the same async disposal path that reloads use, which matters if you adopted [Polly 8.8's `EnableReloadsWithMonitor`](/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/).
