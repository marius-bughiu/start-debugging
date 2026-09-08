---
title: "Rider 2026.3 EAP: dotCover Finally Measures TUnit Coverage"
description: "The Rider 2026.3 Early Access Program opened on September 7, 2026. Buried under rainbow brackets is the one line that changes a build: dotCover now reports coverage for TUnit tests, given Microsoft.Testing.Platform 2.3.0 and one package reference."
pubDate: 2026-09-08
tags:
  - "dotnet"
  - "testing"
  - "rider"
  - "code-coverage"
  - "tooling"
---

JetBrains opened the [Rider 2026.3 Early Access Program](https://blog.jetbrains.com/dotnet/2026/09/07/rider-2026-3-eap/) on September 7, 2026. The headline features are the ones that screenshot well: rainbow brackets (off by default, under Settings | Editor | General | Appearance), a filter bar in the completion popup, and a dedicated Game Development plugin category. The change that actually unblocks a repo is two sentences further down: Rider's dotCover integration now measures coverage for unit tests written with TUnit.

## Why TUnit projects reported nothing

TUnit is a Microsoft.Testing.Platform native test framework. It has no VSTest adapter, which is the whole point: the test project builds an executable that owns its own entry point and talks the MTP protocol, rather than being hosted by `vstest.console`. That is the same architecture shift behind [the move from VSTest to Microsoft.Testing.Platform in .NET 11](/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/).

dotCover's in-IDE coverage runner attached to the VSTest host. With no VSTest host in the picture, "Cover Unit Tests" on a TUnit project either produced an empty report or refused to start, and JetBrains tracked it as [DCVR-12871](https://youtrack.jetbrains.com/projects/DCVR/issues/DCVR-12871). Teams that wanted numbers fell back to `dotnet test --coverage` with `Microsoft.Testing.Extensions.CodeCoverage` and read a Cobertura file, which works fine in CI and is useless when you want green and red gutters next to the line you are editing.

## Turning it on

Coverage is not automatic on upgrade. Two prerequisites, both explicit in the EAP announcement.

First, the test project needs the profiler framework package:

```xml
<ItemGroup>
  <PackageReference Include="TUnit" />
  <PackageReference Include="JetBrains.dotCover.Framework" />
</ItemGroup>
```

Second, the platform floor is `Microsoft.Testing.Platform` 2.3.0 or later. That is the same 2.3.0 that shipped [streaming TRX and GitHub Actions annotations](/2026/08/microsoft-testing-platform-2-3-github-actions-annotations/) in July 2026, so most repos on a current TUnit are already above the line. Check what you actually restored rather than what you declared:

```bash
dotnet list package --include-transitive | grep Microsoft.Testing.Platform
```

Then make sure Rider is driving MTP at all: Settings | Build, Execution, Deployment | Unit Testing | Testing Platform, and check "Enable Test Platform support". Without that box, Rider still routes through its legacy runner and you are back to an empty report.

## The other one worth the EAP risk

Data breakpoints stopped being a Watches-window ritual. You can right-click a variable in the editor and configure one there, or create one straight from the Breakpoints tool window by typing a memory address and a region size. Read and write access, conditions, and logging are all supported. For chasing a field that some other thread is stomping on, that is a materially shorter path than the old flow.

EAP builds are free while the program runs and they do expire, so treat this as a way to unblock a TUnit repo's coverage story now rather than a machine you ship from.
