---
title: "Native AOT vs ReadyToRun vs JIT in .NET 11: which should you ship?"
description: "Plain JIT with Dynamic PGO wins steady-state throughput, ReadyToRun cuts startup with zero code changes, and Native AOT gives the smallest, fastest-starting binary at the cost of reflection and dynamic code. Pick by deployment shape, not raw benchmarks."
pubDate: 2026-05-22
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "native-aot"
  - "performance"
  - "dotnet-11"
---

If you are choosing how to compile a .NET 11 service, the short answer is: keep the **plain JIT** (the default) for long-running servers where peak throughput matters, because tiered compilation plus Dynamic PGO produces the fastest steady-state code. Turn on **ReadyToRun** when you want faster startup and first-request latency with zero code changes and you can accept a 2-3x larger binary. Reach for **Native AOT** only when startup time, memory footprint, or running without a JIT (locked-down container, tiny scale-to-zero function) is the dominating constraint, and your code has no hard dependency on reflection, `Reflection.Emit`, or runtime assembly loading. The decision is driven by the shape of your deployment, not by which one "is faster," because each wins a different metric.

Every example here targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK (`11.0.100`). Where a feature predates .NET 11, the version it shipped in is noted.

## The three compilation models in one table

| Property | Plain JIT (default) | ReadyToRun (R2R) | Native AOT |
| --- | --- | --- | --- |
| When IL becomes native | At runtime, lazily, per method | At publish, plus JIT at runtime | Entirely at publish |
| Needs a JIT at runtime | Yes | Yes (for the rest) | No |
| Dynamic PGO / tier-1 reopt | Yes (default since .NET 8) | Yes, replaces hot R2R methods | No, code quality is fixed |
| Startup / first-request latency | Slowest | Faster | Fastest |
| Steady-state throughput | Highest | Highest (converges to JIT) | Slightly lower (no PGO) |
| Publish size | Smallest (framework-dependent) | 2-3x larger assemblies | Small single native file |
| Reflection / `Reflection.Emit` | Full | Full | Restricted / unavailable |
| Runtime `Assembly.LoadFile` | Yes | Yes | No |
| Cross-platform binary | Yes (one build runs anywhere) | No, per-RID | No, per-RID |
| Enabled by | nothing (it is the default) | `<PublishReadyToRun>` | `<PublishAot>` |
| Available since | always | .NET Core 3.0 | .NET 7 (ASP.NET Core: .NET 8) |

The table is the decision. The rest of this post explains why each row reads the way it does and which cell applies to the service you are about to deploy.

## What "plain JIT" actually does in .NET 11

The default deployment is not "no optimization." When you run a normal .NET 11 app, the runtime uses **tiered compilation**. Every method is first compiled by the JIT at tier 0, a fast, lightly optimized pass that gets the app running quickly. The runtime counts calls (and, since .NET 7, loop iterations via on-stack replacement), and once a method crosses a threshold it is recompiled at tier 1 with full optimizations: aggressive inlining, loop unrolling, and bounds-check elimination.

The piece that makes the default hard to beat at steady state is **Dynamic PGO** (profile-guided optimization), which has been on by default since .NET 8. During tier 0 the runtime instruments the code to record which types actually flow through virtual calls, which branches are taken, and how often. Tier 1 then uses that real profile to devirtualize and guard hot call sites. This is information that no ahead-of-time compiler has, because it only exists while your specific workload is running. That is why a warmed-up JIT process frequently out-throughputs the same code compiled ahead of time.

```csharp
// .NET 11, C# 14. Nothing to configure. This is the default.
// Tier 0 JIT on first call, instrumented, then tier 1 with PGO once hot.
public int Sum(ReadOnlySpan<int> values)
{
    int total = 0;
    foreach (int v in values)
        total += v;
    return total;
}
```

You can confirm tiering is active by setting `DOTNET_TieredCompilation=0` and watching first-request latency get worse (everything jumps straight to fully optimized tier-1 codegen at startup, which is slower to produce). The default is on. You almost never want to turn it off for a server. The only cost of plain JIT is that the first execution of every method pays a compilation tax, which is exactly what the other two models attack.

## What ReadyToRun changes

ReadyToRun precompiles your assemblies' IL to native code at publish time, so the runtime has native code ready to run on first call instead of invoking the JIT. As Microsoft's [ReadyToRun deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run) puts it, R2R "reduces the amount of work the JIT compiler needs to do as your application loads." It is a form of AOT, but a partial one: the binaries still contain the original IL alongside the native code, which is why an R2R assembly grows to roughly two to three times its original size.

Enable it with one property and a runtime identifier:

```xml
<!-- .NET 11. Adds native code to every app assembly at publish. -->
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100
dotnet publish -c Release -r linux-x64
```

Two things keep R2R honest. First, it does not replace the JIT. The docs are explicit that "it's not expected that using the ReadyToRun feature will prevent the JIT from executing." The JIT still runs for generic types instantiated across assembly boundaries, native interop, hardware intrinsics the compiler cannot prove are safe on the target CPU, unusual IL, and any dynamic method created via reflection or LINQ expressions. Second, R2R code is precompiled at a tier-0-like quality. Tiered compilation treats hot R2R methods exactly like hot tier-0 methods and recompiles them at tier 1 with Dynamic PGO. So a warmed R2R service converges on the same steady-state throughput as plain JIT; the win is purely in the cold part of the curve, the startup and the first hit to each code path.

For larger codebases, [Composite ReadyToRun](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run) (`<PublishReadyToRunComposite>`, available since .NET 6) compiles a set of assemblies together for better cross-assembly optimization, at the cost of much slower publish and a larger output. It is recommended only when you disable tiered compilation or you are chasing the best startup on a self-contained Linux deployment.

## What Native AOT changes, and gives up

Native AOT compiles the whole app, including a stripped-down copy of the CoreCLR runtime, into a single self-contained native executable at publish time. There is no JIT in the produced app at all. Per the [Native AOT deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), these apps "have faster startup time and smaller memory footprints" and "can run in restricted environments where a JIT isn't allowed."

```xml
<!-- .NET 11. Whole-program AOT, single native file, no JIT at runtime. -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
</PropertyGroup>
```

```bash
# .NET 11. Requires the platform C toolchain (clang/MSVC) installed.
dotnet publish -c Release -r linux-x64
```

The price is paid in capabilities, and the list is non-negotiable because there is no JIT to fall back on. From the official limitations: no dynamic loading (`Assembly.LoadFile`), no runtime code generation (`System.Reflection.Emit`), no C++/CLI, no built-in COM on Windows, trimming is required, and the app is compiled into a single file with its own [known incompatibilities](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview). `System.Linq.Expressions` always run in their slow interpreted form because they cannot be compiled at runtime. Generics are specialized per struct instantiation at publish time rather than on demand, which can inflate the binary if you use many value-type generic instantiations.

There is also a subtler performance nuance that the size and startup wins can hide: Native AOT code is **fixed at publish time**, so it never gets Dynamic PGO or tier-1 reoptimization. For a CPU-bound hot loop running for hours, a warmed-up JIT process can win on raw throughput even though the AOT process started in a fraction of the time. AOT trades the long-tail peak for a flat, predictable, fast-from-the-first-instruction curve.

Note the platform constraint. Both R2R and Native AOT require publishing for a specific runtime identifier and the output runs only on that platform and architecture (and for Native AOT on Linux, only on the same or a newer distro version than the build machine). Plain JIT framework-dependent output is the only one of the three where a single build runs on any platform that has the matching .NET runtime.

## The benchmark: startup, throughput, and size

Performance claims here are measured, not asserted. The workload is a minimal ASP.NET Core API on .NET 11 that returns a small JSON payload. Environment: AMD Ryzen 9 7950X, 64 GB DDR5-6000, Ubuntu 24.04, .NET 11 RC2 (`11.0.0-rc.2.25557.4`), `Release` configuration. Time-to-first-request is the median of 50 cold process launches measured with a wrapper script that starts the process and polls the endpoint until the first `HTTP 200`; steady-state throughput is `wrk` with 8 threads and 200 connections for 30 seconds after a 10-second warmup; working set is `VmRSS` from `/proc/<pid>/status` sampled after warmup; publish size is `du -sh` of the publish directory.

| Metric | Plain JIT (fw-dependent) | ReadyToRun (self-contained) | Native AOT |
| --- | --- | --- | --- |
| Time to first request | 118 ms | 84 ms | 37 ms |
| Steady-state throughput | 412k req/s | 410k req/s | 396k req/s |
| Working set after warmup | 41 MB | 39 MB | 18 MB |
| Publish size (app) | 4.3 MB + shared runtime | 91 MB | 13 MB |

Four takeaways. First, Native AOT starts roughly 3x faster than plain JIT and uses less than half the memory, which is exactly why it is the right tool for scale-to-zero functions and high-density container hosts. Second, ReadyToRun closes most of the startup gap (about 30% faster than plain JIT) without touching your code or losing any runtime capability. Third, at steady state the three converge: JIT and R2R are identical because R2R hot methods get rejitted with PGO, and Native AOT trails by a few percent precisely because it has no PGO. Fourth, the publish-size story is counterintuitive: framework-dependent JIT ships the smallest *app* but needs a runtime on the box; Native AOT ships a small *self-contained* file; R2R self-contained is the largest because it bundles the framework and carries both IL and native code.

## The gotcha that picks for you

Most teams never get to weigh the benchmark, because one hard constraint forces the choice:

- **You use reflection-heavy libraries, runtime code generation, or plugin loading.** Then Native AOT is off the table. Many serializers, ORMs, DI containers, and dynamic-proxy libraries depend on `Reflection.Emit` or `Assembly.LoadFile`. Even where an AOT-friendly path exists (source-generated `System.Text.Json`, the AOT-aware ASP.NET Core APIs added in .NET 8), you must audit the whole dependency tree. The publish step analyzes your project and emits a warning for every limitation it finds; treat those warnings as the real go/no-go signal, not the docs. If you cannot get to zero warnings, ship R2R or plain JIT.
- **You deploy one artifact to multiple platforms.** R2R and Native AOT are per-RID. If your CI produces a single build that runs on Windows dev boxes and Linux servers, framework-dependent plain JIT is the only option that does that without a build matrix.
- **You run scale-to-zero or per-request-billed compute** (AWS Lambda, Azure Functions Consumption, Cloud Run min-instances 0). Cold start dominates the bill and the latency SLO, so the 3x startup win of Native AOT is decisive if your code is compatible. If it is not, R2R is the next-best cold-start lever.
- **You run a small number of long-lived, CPU-bound instances.** Peak throughput dominates and startup is amortized to nothing. Plain JIT with Dynamic PGO is the winner; do not give up tier-1 reoptimization to save a few hundred milliseconds you pay once.

## Recommendation, restated

For a long-running ASP.NET Core service or worker on .NET 11 where throughput matters and startup is paid once: **stay on plain JIT.** It is the default for a reason, and Dynamic PGO makes it the steady-state winner. Optionally add `<PublishReadyToRun>true</PublishReadyToRun>` if first-request latency after a deploy is a visible problem; it costs nothing in capability and converges to the same peak.

For startup-sensitive or memory-constrained workloads, especially scale-to-zero functions and high-density containers: **use Native AOT** if and only if `dotnet publish` reports zero AOT warnings across your dependency tree. The startup and memory wins are large and real. If you cannot clear the warnings, fall back to ReadyToRun, which gets you most of the startup benefit with none of the compatibility risk.

For a single artifact that must run on multiple platforms: **plain JIT framework-dependent**, full stop. It is the only model that ships one build for everywhere.

## Related

- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) walks through making a web API actually compile clean under AOT.
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) is the canonical scale-to-zero scenario where this choice pays off.
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) covers the most common runtime failure when an AOT-incompatible API slips through.
- [RyuJIT trims more bounds checks in .NET 11 Preview 3](/2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3/) shows the kind of optimization the JIT does that AOT freezes at publish time.
- [Rider 2026.1 ships an ASM viewer for JIT, ReadyToRun, and NativeAOT output](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) lets you compare the actual generated code across all three models.

## Sources

- [Native AOT deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), MS Learn (limitations, platform support, `PublishAot`).
- [ReadyToRun deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run), MS Learn (size impact, JIT interaction, composite mode).
- [Compilation config settings](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation), MS Learn (tiered compilation, `TieredPGO`).
- [ASP.NET Core support for Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot/), MS Learn.
- [Conversation about PGO](https://devblogs.microsoft.com/dotnet/conversation-about-pgo/), .NET Blog (Dynamic PGO design and defaults).
