---
title: "The .NET 11 tracker"
description: "Every preview, every feature, every breaking change - one place to bookmark for the .NET 11 release cycle."
tagline: "One bookmark for the whole .NET 11 cycle."
pubDate: 2026-04-18
updatedDate: 2026-09-13
indexTags:
  - ".net 11"
  - "dotnet 11"
  - ".net 11 preview"
  - "dotnet-11"
  - "dotnet"
  - ".net"
---

This pillar collects everything I've written about **.NET 11**: previews, runtime changes, GC and JIT work, and the new BCL surface. I keep it current as each preview and release candidate drops.

## What to read first

New here? Start at the top: each post covers one change, and older ones stay useful. RC 1 is newest: [dotnet publish container images are now reproducible](/2026/09/dotnet-11-rc-1-reproducible-container-images-source-date-epoch/), so the same commit gives the same digest, [Process can SIGTERM a child without P/Invoke](/2026/09/dotnet-11-rc-1-process-signal-exit-status/), and [SignalR swaps an expiring token without dropping the connection](/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/). From Preview 7, [MSBuild server on by default](/2026/08/msbuild-server-on-by-default-dotnet-11-preview-7/) and [encrypted ZIPs in System.IO.Compression](/2026/08/dotnet-11-preview-7-password-protected-zip-archives/) still matter. The breaking change to know first is [the minimum CPU baseline rising to x86-64-v2](/2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2/), which won't start on older hardware.

Upgrading? Start from the checklists: [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) for an LTS-to-LTS jump, or [.NET Framework 4.8 to .NET 11](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) for the old framework. With versions scattered across csproj files, [move to Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) first. On the test side, the SDK's default runner changed: [migrate from VSTest to Microsoft.Testing.Platform](/2026/09/migrate-from-vstest-to-microsoft-testing-platform-in-dotnet-11/) covers the opt-in and the exit codes that turn a green CI job red.

## What's on this page

The table below auto-collects posts tagged with any of: `.net 11`, `dotnet 11`, `.net 11 preview`, `dotnet-11`, `dotnet`, `.net`, newest first.

For quick reference instead of chronology, see the companion [EF Core 11 cheat sheet](/pillars/efcore-11-cheat-sheet/), [C# 14 features](/pillars/csharp-14-features/), and [async and concurrency](/pillars/async-and-concurrency-in-csharp/) pillars.
