---
title: "What is tiered compilation and how do I reason about it?"
description: "Tiered compilation lets the .NET JIT compile every method twice: once fast and unoptimized to get your app running, then again with full optimizations once the runtime knows a method is hot. Here is how tier 0, tier 1, on-stack replacement, and Dynamic PGO fit together, and how to observe and tune them."
pubDate: 2026-07-11
tags:
  - "dotnet"
  - "performance"
  - "jit"
  - "dotnet-11"
  - "csharp"
---

Tiered compilation is the .NET runtime's strategy of compiling each method more than once. The first time a method runs, the JIT (just-in-time) compiler produces "tier 0" code quickly and with almost no optimization, so your app starts fast. If that method later proves hot (called at least 30 times, or spinning in a long loop), a background thread recompiles it as fully optimized "tier 1" code and quietly swaps it in. You get startup speed and steady-state throughput from the same binary, without choosing between them. It has been on by default since .NET Core 3.0, and in .NET 8 and later it also feeds a profiler (Dynamic PGO) that makes the tier 1 code smarter than a static compiler could. This post explains the moving parts and how to reason about them when you profile or benchmark.

Everything here targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK (`11.0.100`), but the mechanics have been stable since .NET 7, when on-stack replacement and quick-jitting of loops became the default on x64 and arm64. Where a behavior depends on a specific version, I call it out.

## Why the runtime compiles the same method twice

A JIT compiler faces a dilemma every time it sees a method for the first time. It can compile that method slowly and produce excellent machine code, which is great for a method that runs a million times but wasteful for a method that runs once during startup. Or it can compile quickly and produce mediocre code, which is great for startup but leaves throughput on the table for hot paths.

Ahead-of-time compilers dodge this by optimizing everything up front, and pay for it with build time and larger binaries. A pure JIT that always optimizes pays for it with slow startup, because a real application JIT-compiles thousands of methods before it serves its first request. Tiered compilation refuses to pick. It compiles fast first so the process gets moving, then it watches which methods actually matter and re-compiles only those with the expensive optimizer. The vast majority of methods in any process run a handful of times and never earn tier 1 at all, so the optimizer's budget goes where it pays off.

## Tier 0 and tier 1: what "quick" and "optimized" actually mean

Tier 0 is produced by "quick JIT". The compiler skips most optimizations: no aggressive inlining, no loop unrolling, minimal register allocation. It emits straightforward machine code in a fraction of the time a full compile would take. The resulting code is correct and often several times slower than optimized code, but it exists almost immediately.

Tier 1 is the full optimizer. It inlines, it eliminates bounds checks where it can prove they are redundant, it hoists invariants out of loops, and (as of .NET 8) it uses profile data collected while tier 0 ran. Tier 1 compilation is much slower to produce, which is exactly why the runtime only spends it on methods that have proven they are worth it.

There is a third source of code that participates in the same system: ReadyToRun (R2R). Framework assemblies ship with precompiled R2R code so the runtime does not have to JIT `string.Substring` on every launch. R2R code is treated like a pre-baked tier that can still be replaced by an even better tier 1 version once the method turns out to be hot in your specific workload. That is why disabling tiered compilation can occasionally make an app slower rather than faster: you lose the ability to re-optimize framework methods with your profile.

## The call-count threshold and the tiering delay

A method does not jump to tier 1 the moment it gets warm. Two mechanisms gate the promotion.

First, a call counter. Each tier 0 method has a counter, and once it has been called 30 times (the default value of `DOTNET_TC_CallCountThreshold`), it is queued for tier 1 recompilation. Thirty is deliberately low; the point is to catch anything that runs repeatedly without waiting for it to run thousands of times in slow code.

Second, a startup delay. The runtime does not start counting calls immediately, because during startup almost every method is being called for the first time and none of them are steady-state hot yet. There is roughly a 100ms timer that resets every time a new tier 0 method is JIT-compiled. Only once that timer elapses without new tier 0 compilations, meaning the JIT storm of startup has settled, does call counting begin in earnest. This is why startup itself stays in cheap tier 0 code and the optimizer does not thrash on methods that only ever ran during initialization.

The recompilation happens on a background thread borrowed from the thread pool, working in slices of about 10ms at a time so it never monopolizes a worker. Your hot method keeps running its tier 0 code until the optimized version is ready, at which point the runtime atomically redirects future calls to the tier 1 code. Nothing blocks, and no in-flight call is interrupted.

```csharp
// .NET 11, C# 14.
// Call this in a tight loop and the runtime will promote it to tier 1
// after ~30 calls, once startup has settled. You will not see the
// promotion in the method's behavior, only in its speed.
static long SumOfSquares(int n)
{
    long acc = 0;
    for (int i = 0; i < n; i++)
        acc += (long)i * i;
    return acc;
}
```

## On-stack replacement: escaping a hot loop that never returns

The call-count mechanism has an obvious hole. What about a method that is called exactly once but then spins in a loop for the entire life of the process? Think of `Main`, or a worker that loops over a queue forever. Its call count is 1, so it would be stuck in slow tier 0 code permanently.

On-stack replacement (OSR) closes that hole. When quick JIT emits tier 0 code for a method that contains a loop, it also inserts a small counter at the loop's back edge (the jump back to the top). If that back edge executes enough times, the runtime compiles an optimized version of the method and transfers execution into it mid-flight, replacing the running stack frame in place. The loop that started in tier 0 finishes in tier 1 without the method ever returning.

OSR is what makes it safe to quick-jit methods with loops in the first place. Before OSR shipped, the runtime refused to apply quick JIT to any method containing a loop (the old `TieredCompilationQuickJitForLoops` default of `false`), because a long loop stuck in unoptimized code was a real performance cliff. [PR #65675 in dotnet/runtime](https://github.com/dotnet/runtime/pull/65675) flipped both `DOTNET_TC_QuickJitForLoops` and `DOTNET_TC_OnStackReplacement` on by default for x64 and arm64 in .NET 7, so today almost every method starts in tier 0 and the runtime relies on OSR to rescue anything caught in a long loop. The result was a roughly 25% startup improvement in JIT-heavy apps and 10-30% better time-to-first-request in the TechEmpower benchmarks, per the [.NET 7 performance writeup](https://devblogs.microsoft.com/dotnet/performance_improvements_in_net_7/).

## Dynamic PGO: the tier 0 pass also profiles

Here is the part that surprises people. In .NET 8 and later, Dynamic PGO (profile-guided optimization) is on by default, and it is what makes the whole two-pass design more than just "compile twice."

When Dynamic PGO is active, the tier 0 code is not only unoptimized, it is also instrumented. It records cheap facts about how the method actually behaves: which concrete types show up at a virtual call site, which branch of an `if` is taken most often, how many times a loop iterates. When the method is promoted to tier 1, the optimizer reads that profile and specializes the code for what really happened at runtime. A virtual call whose target was `List<int>` 99% of the time gets that path inlined with a type check guarding it (guarded devirtualization). A branch that is almost never taken gets moved out of the hot path.

This is optimization a static compiler cannot do, because it depends on data that only exists while your specific workload runs. It is also why tiered compilation plus Dynamic PGO can beat a fully-optimized-from-the-start configuration on real throughput, not just startup. You can turn it off to compare:

```xml
<!-- .NET 11, C# 14. Disables Dynamic PGO. Default is enabled since .NET 8. -->
<PropertyGroup>
  <TieredPGO>false</TieredPGO>
</PropertyGroup>
```

The trade-off is that the instrumented tier 0 code is slightly slower and slightly larger than plain tier 0, and the tier 1 result is better. For a server that runs for hours, that is an easy win. For a short-lived function that exits before anything reaches tier 1, the instrumentation is pure cost with no payoff, which is one reason cold-start-sensitive workloads sometimes tune this off. There is a fuller treatment of that scenario in the guide on [reducing cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## How to see tiering actually happen

Reasoning about tiered compilation is much easier once you can watch it. The runtime emits ETW/EventPipe events for every JIT compilation, tagged with the tier, so `dotnet-trace` can show you the transitions:

```bash
# .NET 11 SDK 11.0.100. Capture JIT and tiering events for a running process.
dotnet-trace collect --process-id 1234 \
  --providers Microsoft-Windows-DotNETRuntime:0x1000:5
```

The `MethodJittingStarted` and `MethodLoadVerbose` events carry an optimization-tier field, so a method appearing twice, first as tier 0 then as tier 1, is the promotion you are looking for. For a walkthrough of reading these traces, see the post on [profiling a .NET app with dotnet-trace](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/).

If you want to see the machine code the JIT produced at each tier, `DOTNET_JitDisasmSummary=1` prints one line per method with its tier, and setting `DOTNET_JitDisasm` to a method name dumps the actual assembly. Tooling like the [Rider 2026.1 disassembly viewer](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) surfaces the same output without wrestling environment variables. Comparing tier 0 and tier 1 disassembly of the same method is the fastest way to build intuition for what "optimized" buys you.

## The benchmarking trap everyone hits

The single most common mistake with tiered compilation is measuring tier 0 code by accident. If you write a stopwatch loop that runs your method a few thousand times and averages the result, the early iterations run in slow tier 0, the promotion happens partway through, and your average is a meaningless blend of two different pieces of code.

The fix is to warm up. Run the method enough times to trigger promotion, wait for the background compilation to complete, and only then start timing. This is exactly what [BenchmarkDotNet](https://benchmarkdotnet.org/) does for you: it runs a warmup phase, detects when timings stabilize, and measures steady-state tier 1 code. Do not hand-roll a microbenchmark with `Stopwatch` and trust the number; you are almost certainly measuring the wrong tier. If you must, you can force the issue by setting `DOTNET_TieredCompilation=0` so everything compiles straight to optimized code, but that changes startup behavior and is not how your app runs in production either.

## The knobs, and when you should actually touch them

The defaults are good. The .NET team tunes them against a huge suite of real applications, and the honest answer for most projects is to leave every setting alone. That said, the levers exist for a reason:

- `TieredCompilation` (env `DOTNET_TieredCompilation`, default on): turn it off only to force fully optimized code everywhere, at the cost of much slower startup. Occasionally useful for a latency-critical service that can afford a long warmup and wants zero tier-0 jitter, but measure before committing.
- `TieredCompilationQuickJit` (env `DOTNET_TC_QuickJit`, default on): disabling this makes tier 0 use the full optimizer, which mostly defeats the purpose.
- `TieredCompilationQuickJitForLoops` (env `DOTNET_TC_QuickJitForLoops`, default on since .NET 7 on x64/arm64): paired with OSR, rarely worth changing.
- `TieredPGO` (env `DOTNET_TieredPGO`, default on since .NET 8): the one you might legitimately turn off for ultra-short-lived processes, or on for a .NET 6/7 app that predates the default flip.

All of these map to MSBuild properties in the `.csproj` and to `System.Runtime.*` keys in `runtimeconfig.json`, documented in Microsoft's [compilation config settings](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation) reference. If you are weighing tiered JIT against giving up the JIT entirely, the trade-offs live in [Native AOT vs ReadyToRun vs plain JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) and in the deeper look at [what Native AOT costs you](/2026/06/what-is-native-aot-and-what-does-it-cost-you/), since AOT code never gets Dynamic PGO's re-optimization at all.

The mental model to keep: your process starts in cheap, fast-to-produce tier 0 code that is quietly taking notes; a small number of methods prove they are hot; a background thread rewrites exactly those methods with the full optimizer informed by the notes; and OSR catches anything stuck in a loop that call-counting would miss. Once you can see that happening in a trace, tiered compilation stops being a black box and starts being a tool you can reason about.

## Related

- [Native AOT vs ReadyToRun vs plain JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [How to profile a .NET app with dotnet-trace and read the output](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [Rider 2026.1's ASM viewer for JIT and Native AOT disassembly](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/)

## Sources

- [Compilation config settings, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)
- [Tiered compilation design doc, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/tiered-compilation.md)
- [On-stack replacement design doc, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/OnStackReplacement.md)
- [Enable QJFL and OSR by default for x64 and arm64, PR #65675](https://github.com/dotnet/runtime/pull/65675)
- [Performance Improvements in .NET 7, .NET Blog](https://devblogs.microsoft.com/dotnet/performance_improvements_in_net_7/)
- [Dynamic PGO design doc, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/DynamicPgo.md)
