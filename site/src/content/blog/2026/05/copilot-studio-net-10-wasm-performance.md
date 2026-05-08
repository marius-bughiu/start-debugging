---
title: "Copilot Studio's .NET 10 WebAssembly upgrade: 20% cold path, 5% warm"
description: "Microsoft moved Copilot Studio's WASM engine from .NET 8 to .NET 10. The dual JIT/AOT package, fingerprinting, and WasmStripILAfterAOT explain the numbers."
pubDate: 2026-05-08
tags:
  - "dotnet"
  - "webassembly"
  - "performance"
  - "blazor"
---

On May 7, 2026, Daniel Roth published a [Copilot Studio case study](https://devblogs.microsoft.com/dotnet/copilot-studio-dotnet-10-migration/) on the .NET blog. The headline: Copilot Studio's WebAssembly runtime, shipped as an NPM package and embedded in many Microsoft 365 surfaces, is now running on .NET 10 in production. Cold-path execution is about 20% faster, warm path about 5% faster, and the migration itself was largely a `<TargetFramework>` bump.

The interesting parts are how Copilot Studio packages two engines into one bundle, and what changed in .NET 10's WebAssembly tooling that made the new build smaller in places it matters and slightly bigger in places it does not.

## Two engines, one package

Copilot Studio does not pick JIT or AOT. It ships both in the same NPM package and lets the page load them in parallel.

The JIT engine boots first and starts handling user interactions immediately. The AOT engine, which is larger and slower to download, finishes loading in the background. As soon as it is ready, the runtime hands the active session over to AOT and the JIT engine is dropped. The user sees a fast first response and then a quietly faster experience for the rest of the conversation.

That dual-load is why Copilot Studio cares so much about asset sharing between the two engines. Anything they can both reference, they should not download twice.

## What .NET 10 actually changed

Two changes in the .NET 10 WebAssembly workload account for most of the delta.

First, **automatic asset fingerprinting**. On .NET 8, the team had to run a custom PowerShell step to append a SHA256 hash to each WASM and DLL filename so caches and integrity checks would behave. On .NET 10 that is built in, and the publish output already names files like `dotnet.runtime.{hash}.js` without any custom MSBuild glue.

Second, **`WasmStripILAfterAOT` is on by default**. After AOT compilation, the original IL for compiled methods is no longer shipped. That trims the AOT payload, but it also reduces the number of files the JIT and AOT engines can share, because AOT-only files no longer carry the IL the JIT engine would need.

```xml
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <RunAOTCompilation>true</RunAOTCompilation>
  <!-- Defaults to true on net10.0; shown here for clarity. -->
  <WasmStripILAfterAOT>true</WasmStripILAfterAOT>
</PropertyGroup>
```

On .NET 8, 59 files were shared between Copilot Studio's JIT and AOT engines. On .NET 10 that dropped to 22. The package as a whole grew by about 15%. That is the cost of stripping IL from AOT methods: the dual-engine model loses some of its dedup wins.

## Reading the numbers honestly

Microsoft is up front about the tradeoff. AOT downloads are about 6% slower on a fast LAN, which works out to roughly 200 ms, and about 17% slower on a 4G link, about 5 seconds. That penalty is paid in the background while JIT is already serving the user, so it does not show up in time-to-interactive. It does show up if a user disconnects mid-load or runs Copilot Studio in a constrained network.

In return:

- Cold execution path: ~20% faster.
- Warm execution path: ~5% faster.
- No code changes beyond the framework bump.

For a workload that runs inside Microsoft 365 surfaces and gets hit constantly, a 20% gain on the cold path on every interaction matters more than five seconds of background download.

## What this means for your Blazor WebAssembly app

If you ship a Blazor WebAssembly or .NET WASM app and you are still on .NET 8, the migration is cheap. Bump `TargetFramework` to `net10.0`, restore, publish, and let the new fingerprinting and AOT defaults run. If you have a custom hashing or IL-stripping step in your pipeline, delete it.

If you do not ship dual JIT and AOT engines (most apps do not), you will not see the 15% package growth Copilot Studio saw. You will get the IL-stripping savings without the dedup loss. That is the configuration .NET 10's defaults are tuned for.

The full case study, including the deployment details and how Copilot Studio measures these numbers in production, is on the [.NET blog](https://devblogs.microsoft.com/dotnet/copilot-studio-dotnet-10-migration/).
