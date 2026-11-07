---
title: "Copilot's Upgrade Agent Now Migrates .NET Apps to Windows Arm64: What It Is Actually Looking For"
description: "On November 5, 2026 Microsoft added a Windows Arm64 migration scenario to the GitHub Copilot upgrade agent. Here is what the blockers look like in a real .NET project, what the agent can and cannot verify, and how to check the result yourself."
pubDate: 2026-11-07
tags:
  - "dotnet"
  - "github-copilot"
  - "arm64"
  - "modernization"
  - "windows"
---

On November 5, 2026 the .NET team [announced](https://devblogs.microsoft.com/dotnet/modernize-dotnet-apps-for-windows-arm64/) a new scenario in the GitHub Copilot upgrade agent: migrating .NET applications from Windows x64 or x86 to Windows Arm64. You pick the upgrade agent in the agent picker, ask for an Arm64 migration, choose the ".NET Arm64 migration" scenario, and the agent produces an assessment, a plan, and then code, dependency, and project changes.

It follows the same Assess, Plan, Execute shape as the rest of the modernization tooling, and as with [the earlier assessment-first workflow](/2026/04/github-copilot-modernization-assessment-dotnet/), the assessment is the part worth reading closely.

## Managed code is rarely the problem

Pure IL compiled as AnyCPU already runs natively on Arm64 under .NET 8, 9, 10, and the upcoming .NET 11. The blockers are the places where a project pins an architecture or drags in native code. The announcement lists them: architecture-specific build settings, native dependencies without Arm64 binaries, packages that need newer versions, platform assumptions spread across projects, and configuration that only targets x64 or x86.

In a `.csproj` that usually looks like this:

```xml
<!-- Before: pinned to x64, runs under emulation on Arm64 Windows -->
<PropertyGroup>
  <TargetFramework>net10.0-windows</TargetFramework>
  <PlatformTarget>x64</PlatformTarget>
  <RuntimeIdentifier>win-x64</RuntimeIdentifier>
</PropertyGroup>

<!-- After: native Arm64, with x64 still available for existing machines -->
<PropertyGroup>
  <TargetFramework>net10.0-windows</TargetFramework>
  <RuntimeIdentifiers>win-x64;win-arm64</RuntimeIdentifiers>
</PropertyGroup>
```

The settings are the easy part. The hard part is a NuGet package that ships `runtimes/win-x64/native/foo.dll` and nothing under `runtimes/win-arm64/native/`. The build succeeds, and the failure only shows up at runtime as a `DllNotFoundException` or a `BadImageFormatException` the first time a P/Invoke touches that library. You can find these candidates without any agent by searching the restore output:

```powershell
Select-String -Path .\obj\project.assets.json -Pattern 'runtimes/win-(x64|x86)/native' |
  ForEach-Object { $_.Line.Trim() } | Sort-Object -Unique
```

Any package that appears there with no matching `win-arm64` entry needs an update, a replacement, or a conversation with its maintainer.

## A build is not a migration

Microsoft is explicit about the limits. The agent builds the migrated components for Windows Arm64, and runs tests only "when matching hardware or CI runners are available." A green build proves the project graph resolves for `win-arm64`. It does not prove a native dependency loads, that a COM component is registered for the right architecture, or that interop code written for x86 no longer assumes 4-byte pointers.

Microsoft also scopes the scenario to compatibility and correctness, not Arm64 performance tuning. Measure performance after the app is validated.

A cheap guard for the validation run is to log the actual process architecture at startup, so emulated x64 runs do not pass silently:

```csharp
using System.Runtime.InteropServices;

Console.WriteLine(
    $"OS: {RuntimeInformation.OSArchitecture}, " +
    $"Process: {RuntimeInformation.ProcessArchitecture}");
// Expect "OS: Arm64, Process: Arm64" for a native run.
// "Process: X64" on an Arm64 OS means you are under emulation.
```

On GitHub Actions, the `windows-11-arm` runner label gives you real Arm64 hardware for that test pass, which is also what the agent needs to execute tests rather than stop at a build.

## Timing matters this month

.NET 8 and .NET 9 reach end of support on November 10, 2026, the same day .NET 11 launches. If an Arm64 move is on the roadmap, combining it with the runtime upgrade means one round of dependency updates instead of two. Start with the agent's assessment, cross-check it against `project.assets.json`, and do not count anything as done until it has run on Arm64 hardware. More scenarios are listed at [aka.ms/upgrade-agent](https://aka.ms/upgrade-agent).
