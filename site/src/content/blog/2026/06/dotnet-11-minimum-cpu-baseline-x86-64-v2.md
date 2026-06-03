---
title: ".NET 11 Raises the Minimum CPU Baseline to x86-64-v2"
description: ".NET 11 Preview 4 drops support for pre-2013 x86/x64 chips and bumps the JIT baseline to x86-64-v2. Here is what breaks, why, and how to check your hardware before you upgrade."
pubDate: 2026-06-03
tags:
  - "dotnet"
  - "performance"
  - "native-aot"
---

If you maintain CI runners, Docker base images, or anything running on older bare metal, .NET 11 has a breaking change that does not show up as a compiler error. It shows up at startup, on the target machine, as a refusal to run. Starting with .NET 11 Preview 4, the runtime raises the minimum guaranteed instruction set on x86/x64 from `x86-64-v1` to `x86-64-v2`, and Arm64 gets a smaller bump too.

## What the new baseline actually requires

`x86-64-v1` only guaranteed `CMOV`, `CX8`, `SSE`, and `SSE2`. `x86-64-v2` adds `CX16`, `POPCNT`, `SSE3`, `SSSE3`, `SSE4.1`, and `SSE4.2`. This applies to the JIT and AOT minimum on all three operating systems (Apple, Linux, Windows). In practice the last chips that fail this bar went out of support around 2013, and the level is already required by Windows 11 and by every x86/x64 CPU officially supported on Windows 10.

On Arm64, the Windows JIT/AOT minimum moves from `armv8.0-a` to `armv8.0-a + LSE`. Linux and Apple keep their existing JIT minimums, so a Raspberry Pi that only provides `AdvSimd` still runs.

ReadyToRun (R2R) targets move further. On Windows and Linux the R2R target is now `x86-64-v3`, which assumes `AVX`, `AVX2`, `BMI1`, `BMI2`, `F16C`, `FMA`, `LZCNT`, and `MOVBE`. Apple's R2R target is unchanged. R2R is a codegen target, not a hard requirement: a CPU below `x86-64-v3` but at or above `x86-64-v2` still runs, it just pays extra startup jitting because the precompiled code cannot be used.

## The failure mode

When the CPU is below the new floor, the app does not start. You get a message like this instead:

```text
The current CPU is missing one or more of the baseline instruction sets.
```

There is no project-level switch to lower the floor. The JIT/AOT minimum is the minimum.

## Check before you ship

On Linux with glibc you can ask the dynamic loader which micro-architecture levels the machine supports:

```bash
/lib64/ld-linux-x86-64.so.2 --help | grep -A4 "Subdirectories"
```

The output marks each level as `(supported)` or not:

```text
  x86-64-v4 (not searched)
  x86-64-v3 (supported, searched)
  x86-64-v2 (supported, searched)
```

If `x86-64-v2` is missing from the supported list, .NET 11 will not run on that host. The usual offenders are old build agents, budget VPS instances pinned to ancient host CPUs, and emulated environments. AOT publish targets the same baseline, so a Native AOT binary built for `linux-x64` carries the same requirement.

## Why Microsoft pulled the floor up

Supporting hardware below what the host OS itself requires adds real maintenance cost to the runtime, and it forces AOT codegen to default to a lowest common denominator that leaves performance on the table. Raising the baseline lets the JIT and crossgen2 assume `POPCNT`, `SSE4.2`, and friends are always present, so the generated code is leaner without a runtime feature check. For the overwhelming majority of machines, including every Windows 11 box, nothing changes except faster code.

The one group that needs to act is anyone still targeting genuinely old silicon. Audit your runners and base images now, while .NET 11 is in preview, rather than discovering the message in production in November. If you are planning the jump, fold this into your [.NET 8 to .NET 11 migration checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/).

Source: [What's new in the .NET 11 runtime](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/runtime) and the [minimum hardware requirements compatibility note](https://learn.microsoft.com/en-us/dotnet/core/compatibility/jit/11/minimum-hardware-requirements).
