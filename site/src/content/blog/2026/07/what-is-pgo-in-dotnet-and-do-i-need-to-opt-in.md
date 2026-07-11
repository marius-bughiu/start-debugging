---
title: "What is PGO in .NET and do I need to opt in?"
description: "PGO (profile-guided optimization) lets the .NET JIT specialize hot code for the types and branches your workload actually hits. Dynamic PGO has been on by default since .NET 8, so on .NET 8 and later you do not need to opt in. Here is what it does, how to see its effect, and the rare cases where you touch the knob."
pubDate: 2026-07-11
tags:
  - "dotnet"
  - "performance"
  - "jit"
  - "dotnet-11"
  - "csharp"
---

PGO stands for profile-guided optimization: the compiler collects a profile of how your code actually runs, then uses that profile to generate faster machine code for the paths that matter. In .NET the JIT does this at runtime, a mode called Dynamic PGO, and the short answer to "do I need to opt in?" is no, not anymore. Dynamic PGO has been enabled by default since .NET 8, so on .NET 8, .NET 9, .NET 10, and .NET 11 you already have it. You only reach for the switch if you are on .NET 6 or 7 (where it was off by default), or if you have an unusual, ultra-short-lived workload where you want to turn it off. This post explains what the profile buys you, how to confirm it is running, and the handful of cases where the knob is worth touching.

Everything here targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK (`11.0.100`), but the default-on behavior has held since .NET 8, and the underlying mechanism has been stable since .NET 7 hardened it. Where a behavior depends on a specific version, I call it out.

## What "profile-guided" actually means

A traditional optimizing compiler has to guess. When it sees a virtual method call, it cannot know which concrete type will show up at runtime, so it emits a general indirect call. When it sees an `if`, it does not know which branch is hot, so it lays out both as if they were equally likely. When it sees a loop, it does not know whether it runs twice or two million times. Those guesses are usually fine and occasionally leave a lot of performance on the floor.

Profile-guided optimization removes the guessing. It runs the program, records what really happened at each of those decision points, and feeds that data back into the optimizer. Now the compiler knows that a particular call site was `List<int>` 98% of the time, that a particular branch is taken once in a thousand iterations, that a particular loop is genuinely hot. It can specialize the code for reality instead of hedging for every possibility.

Classic ahead-of-time PGO does this in two separate builds: an instrumented build you run against a representative workload to produce a profile, then a second build that consumes the profile. That is how C and C++ toolchains have done it for decades, and it is powerful but awkward, because you have to capture a workload that resembles production and rebuild. .NET's Dynamic PGO folds both phases into a single running process, which is what makes it something you can just leave on.

## How Dynamic PGO rides on tiered compilation

Dynamic PGO is not a separate pass bolted onto the runtime. It piggybacks on the machinery the JIT already uses to compile hot methods twice. If you have not internalized that two-pass model yet, the post on [what tiered compilation is and how to reason about it](/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) is the prerequisite; the very short version is that methods first compile as fast, unoptimized "tier 0" code and only the hot ones get recompiled as fully optimized "tier 1" code in the background.

Dynamic PGO exploits that first pass. When it is active, the tier 0 code the JIT emits is not merely unoptimized, it is instrumented. The compiler inserts cheap probes that count how often each basic block executes and, at virtual and interface call sites, build a small histogram of which concrete types actually arrive. While your app warms up, that tier 0 code is quietly gathering a profile of your specific workload. When a method is later promoted to tier 1, the optimizer reads the profile it collected and specializes the tier 1 code accordingly.

That timing is the whole trick. The profile is collected from the real workload, on the real machine, moments before the optimized code is produced, so there is no separate instrumented build and no representative-workload problem. The cost is that instrumented tier 0 code is slightly slower and slightly larger than plain tier 0, which matters only for the brief window before promotion.

## The optimization that pays for the rest: guarded devirtualization

The single most valuable thing Dynamic PGO enables is guarded devirtualization (GDV). Virtual and interface calls are expensive not because the indirect jump itself is slow, but because the JIT cannot inline through them, and inlining is where most other optimizations get their leverage. If the compiler cannot see into a call, it cannot fold constants across it, hoist work out of it, or eliminate redundant checks around it.

With a type profile in hand, the JIT can insert a fast path. It emits an explicit check for the type that dominated the profile, and if the check passes, it runs an inlined, fully-optimized copy of that method's body; if it fails, it falls back to the normal virtual call. Consider a loop over an `IEnumerable<int>` that is really always a `List<int>`:

```csharp
// .NET 11, C# 14.
// Dynamic PGO learns that `items` is a List<int> at this call site
// and inlines the enumerator's MoveNext/Current behind a type guard.
static long Sum(IEnumerable<int> items)
{
    long total = 0;
    foreach (int x in items) // virtual GetEnumerator/MoveNext without PGO
        total += x;
    return total;
}
```

Without PGO the `foreach` goes through interface dispatch on every element. With PGO the JIT guesses `List<int>`, guards the guess with one type check, and inlines the enumerator so the loop body becomes tight, allocation-free integer arithmetic. As of .NET 8 the JIT can even emit more than one guard at a site that sees two dominant types, though multiple GDV is off by default and gated behind a configuration flag. The .NET team measured framework methods where GDV alone cut execution time by roughly 40%, and reported real production wins: [Bing's migration to .NET 8](https://devblogs.microsoft.com/dotnet/bing-on-dotnet-8-the-impact-of-dynamic-pgo/) attributed a 13% drop in CPU cycles per query, a 20% reduction in queries impacted by gen0/gen1 GC, and some internal latencies falling by over 25%, largely to Dynamic PGO being on by default.

## Do I need to opt in? The version-by-version answer

Here is the part the search query is really asking about.

- **.NET 8, 9, 10, and 11**: no. Dynamic PGO is on by default. You do nothing. If you have `<TieredCompilation>` at its default (enabled), you already have PGO.
- **.NET 7**: it exists and works well, but it is off by default. Opt in with the setting below if you want it.
- **.NET 6**: it was introduced here as an experiment, off by default, and less mature. You can opt in, but treat it as preview-quality.
- **.NET 5 and earlier**: Dynamic PGO does not exist.

To turn it on where it is not the default, set the MSBuild property in your project file:

```xml
<!-- .NET 7 (or .NET 6). Opts into Dynamic PGO, which is off by default there. -->
<!-- Unnecessary on .NET 8+, where it is already enabled. -->
<PropertyGroup>
  <TieredPGO>true</TieredPGO>
</PropertyGroup>
```

Or set the environment variable, which is handy for A/B testing without a rebuild:

```bash
# Enable Dynamic PGO for a single run (any supported .NET version).
DOTNET_TieredPGO=1 ./myapp
```

The MSBuild property, the `runtimeconfig.json` key (`System.Runtime.TieredPGO`), and the `DOTNET_TieredPGO` environment variable all control the same switch, documented in Microsoft's [compilation config settings](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation) reference. Because Dynamic PGO depends on tiered compilation, disabling tiered compilation (`DOTNET_TieredCompilation=0`) also disables Dynamic PGO as a side effect; there is no profile pass if there is no tier 0.

## When you might legitimately turn it off

Leaving PGO on is the right call for almost every app, but there is one honest exception: a process that exits before its hot methods ever reach tier 1. A short-lived CLI, a serverless function that handles one request and dies, an AWS Lambda with an aggressive timeout. In those workloads the instrumented tier 0 code runs, pays the small profiling tax, and the process shuts down before any tier 1 recompilation happens, so you paid for a profile you never spent.

```xml
<!-- .NET 11, C# 14. Turns Dynamic PGO OFF. -->
<!-- Only sensible for ultra-short-lived processes that never reach tier 1. -->
<PropertyGroup>
  <TieredPGO>false</TieredPGO>
</PropertyGroup>
```

Even here, do not assume; measure. Many cold-start-sensitive workloads get a bigger win from a completely different strategy, such as ReadyToRun images or Native AOT, than from toggling PGO. The trade-offs for cold start specifically are worked through in the guide on [reducing cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/). And if you are considering giving up the JIT entirely, note that [Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) code never gets Dynamic PGO's runtime re-optimization at all, because there is no tier 0 profiling pass in an ahead-of-time binary.

## Static PGO: the profile the framework ships with

Dynamic PGO is not the only PGO in .NET. The framework's own precompiled ReadyToRun images are built with static PGO: Microsoft collects a profile offline, stores it as an `.mibc` file, and feeds it to the `crossgen2` compiler so that even the ahead-of-time framework code is laid out according to a representative profile. That is why `string`, `List<T>`, and the rest of the base class library arrive already tuned before your app runs a single line.

You can do the same for your own AOT or ReadyToRun builds: capture a profile with the tooling, produce an `.mibc`, and pass it to `crossgen2`. This is a niche, advanced workflow, mostly relevant if you publish Native AOT and want profile-informed layout without a JIT at runtime. For the vast majority of server and desktop apps that keep the JIT, Dynamic PGO gives you the same class of benefit automatically and adapts to the actual workload rather than a canned profile, which is strictly better than a static profile baked in at build time. The choice between JIT-with-PGO and the AOT models is the subject of [Native AOT vs ReadyToRun vs plain JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).

## How to confirm PGO is actually doing something

Because PGO is silent by design, the natural question is how you know it is working. Two approaches.

The first is to look at the machine code. Setting `DOTNET_JitDisasm` to a method name dumps the tier 1 assembly, and a method that has been through GDV shows a telltale shape: a type comparison, a fast inlined path, and a fall-through call. If you disable PGO and re-dump, the guard and the inlined body disappear and you are left with a plain virtual call. That before-and-after is the clearest proof the profile changed the output.

```bash
# .NET 11 SDK 11.0.100. Dump the JIT's assembly for a specific method,
# then compare with DOTNET_TieredPGO=0 to see the guarded fast path vanish.
DOTNET_JitDisasm=Sum DOTNET_TieredPGO=1 ./myapp
```

The second approach is to measure throughput properly, which means measuring steady-state tier 1 code and not the tier 0 warmup that precedes it. Do not hand-roll a `Stopwatch` loop; use [BenchmarkDotNet](https://benchmarkdotnet.org/), which warms up until timings stabilize and can run the same benchmark with PGO on and off so you compare like with like. If you want to watch the tiering and JIT events flow past in a real process, the post on [profiling a .NET app with dotnet-trace](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) walks through capturing the runtime provider that reports each method's optimization tier.

The mental model to keep: PGO is the reason .NET's "compile hot methods twice" design produces code a static compiler cannot match, because the second compile is informed by a profile of your real workload. On .NET 8 and later it is already on, already adapting, and already paying for itself. You do not need to opt in. You only need to know it is there, so that when you benchmark, you measure the optimized tier and credit the profile with the speed it earned.

## Related

- [What is tiered compilation and how do I reason about it?](/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)
- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs plain JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [How to profile a .NET app with dotnet-trace and read the output](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Sources

- [Compilation config settings, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)
- [Dynamic PGO design doc, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/DynamicPgo.md)
- [Performance Improvements in .NET 8, .NET Blog](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/)
- [Bing on .NET 8: The Impact of Dynamic PGO, .NET Blog](https://devblogs.microsoft.com/dotnet/bing-on-dotnet-8-the-impact-of-dynamic-pgo/)
