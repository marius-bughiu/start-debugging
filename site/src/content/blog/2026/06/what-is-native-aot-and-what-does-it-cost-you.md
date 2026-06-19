---
title: "What is Native AOT and what does it cost you?"
description: "Native AOT compiles your .NET app to a single self-contained native binary with no JIT, buying fast startup and a small memory footprint. The price is a C toolchain at build time, slower publishes, per-RID builds, no reflection or Reflection.Emit, mandatory trimming, and no Dynamic PGO. Here is the full ledger."
pubDate: 2026-06-19
tags:
  - "dotnet"
  - "native-aot"
  - "performance"
  - "dotnet-11"
  - "csharp"
---

Native AOT is a .NET publishing model that compiles your entire app, plus a stripped-down copy of the runtime, into a single self-contained native executable ahead of time. The produced app has no JIT compiler, so it starts fast and uses less memory, and it runs on machines that do not have the .NET runtime installed. The cost is paid in three currencies: build-time friction (you need a C toolchain, publishes are slower, and every build targets one OS-plus-architecture), capability loss at runtime (no reflection-heavy code, no `System.Reflection.Emit`, no dynamic assembly loading, trimming is mandatory), and a small, often invisible throughput hit because AOT code never gets profile-guided reoptimization. Whether that trade is worth it depends entirely on the shape of your deployment, not on a benchmark number. This post is the full ledger so you can decide before you flip the switch.

Everything here targets `<TargetFramework>net11.0</TargetFramework>` with the .NET 11 SDK (`11.0.100`). Native AOT itself shipped in .NET 7, and ASP.NET Core support landed in .NET 8, so the mechanics below apply from .NET 8 onward unless a version is called out.

## What "ahead of time" actually means here

A normal .NET app ships as IL (intermediate language). At runtime, the JIT (just-in-time) compiler turns that IL into native machine code lazily, one method at a time, the first time each method runs. That is why a fresh .NET process is a little slow on its first few requests: it is compiling itself as it goes. The runtime, the GC, and the JIT all have to be present on the machine for this to work.

Native AOT removes the JIT from the equation entirely. When you run `dotnet publish` with `<PublishAot>true</PublishAot>`, the SDK runs ILC, the AOT compiler, which compiles all of your IL, all of your dependencies' IL, and a trimmed-down version of the CoreCLR runtime, into one native binary. As Microsoft's [Native AOT deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) puts it, these apps "have faster startup time and smaller memory footprints" and "can run in restricted environments where a JIT isn't allowed."

The minimal opt-in is a single MSBuild property and a runtime identifier:

```xml
<!-- .NET 11, C# 14. Enables ILC at publish and turns on AOT analysis while editing. -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100. The -r RID is mandatory: AOT output is platform-specific.
dotnet publish -c Release -r linux-x64
```

The output in the publish directory is a single executable that contains everything it needs to run, "including a stripped-down version of the coreclr runtime." There is no separate runtime to install, and there is no JIT inside the binary. That sentence is the whole feature, and also the whole cost. Every limitation below follows from "there is no JIT at runtime."

## The build-time bill

Before you write a line of code, Native AOT changes what your build machine and CI need.

**You need a native C toolchain.** ILC produces object code that has to be linked into a real OS executable by a platform linker, so the [prerequisites](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) are non-negotiable per OS. On Windows you need Visual Studio 2022 or later with the "Desktop development with C++" workload. On Linux you install clang and the zlib dev headers (`sudo apt-get install clang zlib1g-dev` on Ubuntu, `sudo dnf install clang zlib-devel` on Fedora and RHEL, `sudo apk add clang build-base zlib-dev` on Alpine). On macOS you need the Command Line Tools for Xcode. A plain `dotnet` SDK image is no longer enough for your build agents; you have to bake the toolchain into the CI image too.

**Publishes are slower.** Whole-program compilation plus trimming plus native linking is dramatically more work than emitting IL. A publish that takes a few seconds for a framework-dependent app can take minutes under AOT, and it scales with the size of your dependency graph. This is a per-publish tax, not a per-run one, but it is real enough that you usually do not run AOT on every inner-loop build, only at publish.

**Every build is per-RID.** AOT output runs only on the operating system and CPU architecture you compiled for. A binary built for `win-x64` does not run on `linux-arm64`, full stop. Worse on Linux specifically: a binary built on a given distro version runs only on that version or newer. The docs are explicit that "a Native AOT binary produced on Ubuntu 20.04 is going to run on Ubuntu 20.04 and later, but it isn't going to run on Ubuntu 18.04." If you ship to several platforms you need a build matrix, one publish per RID. .NET 9 widened the supported targets to include Windows/Linux x86 and 32-bit Arm in addition to the x64 and Arm64 that .NET 8 supported.

Contrast this with a framework-dependent JIT app, where a single build runs on any machine that has the matching .NET runtime. That portability is one of the things you are trading away.

## The runtime capabilities you give up

This is the part that decides most projects, because the losses are not "slower," they are "does not work, and the publish step will warn you about it." Since there is no JIT, anything that depends on generating or discovering code at runtime is off the table. Straight from the [official limitations](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/):

- **No dynamic loading**, for example `Assembly.LoadFile`. Plugin architectures that scan a folder for DLLs and load them at runtime cannot work, because the code was never compiled into the binary.
- **No runtime code generation**, for example `System.Reflection.Emit`. This quietly takes out a surprising amount of the ecosystem: dynamic proxy libraries (Castle DynamicProxy), some mocking frameworks, and any serializer or mapper that emits IL for speed.
- **No C++/CLI** and, on Windows, **no built-in COM**.
- **Trimming is required.** The trimmer removes any code it cannot prove is reachable. Unbounded reflection (`Type.GetType("SomeName")` from a string, `GetProperties()` walks, `Activator.CreateInstance(someType)`) defeats that analysis, so reflection-heavy code either needs annotations or has to be replaced with a source generator.
- **Single-file packaging is implied**, which carries its own [known incompatibilities](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview) (APIs that assume a `.dll` on disk, `Assembly.Location` returning empty, and so on).
- **`System.Linq.Expressions` always run interpreted.** They cannot be compiled at runtime because that needs the JIT, so expression-tree-heavy code keeps working but runs slower than on a JIT host.

The most important practical rule: **the compiler tells you.** "The publish process analyzes the entire project and its dependencies for possible limitations. Warnings are issued for each limitation the published app might encounter at runtime." Those warnings are IL2026 (requires unreferenced code, a trimming problem) and IL3050 (requires dynamic code, an AOT problem). Treat a clean `dotnet publish` with zero IL2026/IL3050 warnings as your go/no-go signal, not the documentation. If you cannot get to zero, do not ship AOT.

The way you get to zero is almost always by replacing reflection with compile-time code generation. Source-generated `System.Text.Json` is the canonical example: instead of reflecting over your DTO at runtime, a generator emits the serialization code at build time. If the term is new to you, [what a source generator is and when you need one](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) is the right primer, because under AOT they stop being a nice-to-have and become the only way some libraries function at all.

## The throughput cost nobody mentions

There is one cost that the startup-and-size headlines hide. A JIT process does not just compile your code once. Since .NET 8, **Dynamic PGO** (profile-guided optimization) is on by default: while your app runs, the runtime records which types actually flow through virtual calls and which branches are hot, then recompiles those methods at tier 1 using that real profile. That is information no ahead-of-time compiler can have, because it only exists while your specific workload is running.

Native AOT code is fixed at publish time. It never gets tier-1 reoptimization and never gets PGO. For a CPU-bound hot loop running for hours, a warmed-up JIT process can out-throughput the same code compiled with AOT, even though the AOT process started in a fraction of the time. AOT trades the long-tail peak for a flat, predictable, fast-from-the-first-instruction curve. The measured gap is small (a few percent in a JSON API benchmark), but it is real and it runs the opposite direction from everything else AOT gives you. The full numbers live in the [Native AOT vs ReadyToRun vs JIT comparison](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), which benchmarks startup, throughput, and size head to head.

One more size nuance: generics. "Generic parameters substituted with struct type arguments have specialized code generated for each instantiation." A JIT generates those on demand; AOT pre-generates all of them. If you instantiate many value-type generics, the binary grows. AOT binaries are small in the common case (a minimal API lands around 10-13 MB), but a generic-heavy library can inflate that more than you expect.

## What the cost buys you

The benefits are genuine and, for the right workload, decisive. Startup is the headline: a Native AOT minimal API starts roughly three times faster than the same app on plain JIT, because there is no JIT warm-up and no assembly loading. Memory footprint drops by more than half, because the process is not carrying a JIT, the IL, or the metadata needed to compile it. And because the output is self-contained, the deploy unit is a single small binary with no runtime to install, which is why teams cut container image sizes substantially by switching.

The other benefit is categorical rather than quantitative: AOT apps "can run in restricted environments where a JIT isn't allowed." Some locked-down container runtimes and security policies forbid the writable-executable memory pages a JIT needs. AOT is the only .NET deployment model that runs there at all.

This is why the sweet spot is scale-to-zero and high-density compute. On a per-request-billed function (AWS Lambda, Azure Functions Consumption, Cloud Run scaled to zero), cold start dominates both the latency SLO and the bill, so a 3x startup win is worth a lot of build-time pain. The [.NET 11 AWS Lambda cold-start playbook](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) walks the exact AOT-on-Lambda path. On a long-lived, CPU-bound service with a handful of instances, startup is amortized to nothing and you would be giving up Dynamic PGO for a benefit you pay for once, so plain JIT usually wins.

## How to decide without guessing

Run the analysis before you commit to anything. The cheapest test is to set `<PublishAot>true</PublishAot>` and run a publish against your real dependency graph:

```bash
# .NET 11. Surfaces every IL2026 / IL3050 across your whole dependency tree.
dotnet publish -c Release -r linux-x64 -o ./publish
```

If that comes back with warnings you cannot annotate away, AOT is not viable for this codebase yet, and you have your answer for the cost of one publish. ASP.NET Core sharpens the point: MVC controllers (`AddControllers`), Razor Pages, and server-side SignalR hubs are not AOT-compatible in .NET 11, while minimal APIs and gRPC are. If you want the full clean-build recipe (the `CreateSlimBuilder` host, source-generated JSON, the library-project gotchas), [how to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) is the step-by-step. And when an AOT-incompatible API slips past the analyzer and only blows up at runtime, [fixing the PlatformNotSupportedException that results](/2026/05/fix-platformnotsupportedexception-in-native-aot/) covers the most common failure.

A short decision rule: reach for Native AOT when startup time, memory footprint, deploy size, or running without a JIT is the constraint that dominates, **and** `dotnet publish` reports zero AOT warnings across your dependency tree. Stay on plain JIT when peak steady-state throughput matters more than startup, when you ship one artifact to multiple platforms, or when any load-bearing dependency needs reflection or `Reflection.Emit` that you cannot replace. Native AOT is not a faster `dotnet publish`; it is a different deployment contract, and the costs above are the terms of that contract. Read them before you sign.

## Related

- [Native AOT vs ReadyToRun vs JIT in .NET 11: which should you ship?](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) puts hard benchmark numbers behind the startup, throughput, and size trade-offs.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) is the clean-build walkthrough once you have decided to ship it.
- [What is a source generator and when do I need one?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) explains the compile-time codegen that replaces the reflection AOT forbids.
- [How to reduce cold-start time for a .NET 11 AWS Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) is the scale-to-zero scenario where AOT's startup win pays for itself.
- [Fix: PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) covers the runtime failure when an AOT-incompatible API slips through a clean build.

## Sources

- [Native AOT deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), MS Learn (prerequisites, limitations, per-RID and platform restrictions, single-file and generics behavior).
- [ASP.NET Core support for Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot/), MS Learn (supported and unsupported web features).
- [Trimming incompatibilities](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/incompatibilities), MS Learn (why trimming is required and what it breaks).
- [Conversation about PGO](https://devblogs.microsoft.com/dotnet/conversation-about-pgo/), .NET Blog (Dynamic PGO design and why AOT forgoes it).
