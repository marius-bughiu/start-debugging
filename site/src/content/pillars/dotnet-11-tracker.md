---
title: "The .NET 11 tracker"
description: "Every preview, every feature, every breaking change - one place to bookmark for the .NET 11 release cycle."
tagline: "One bookmark for the whole .NET 11 cycle."
pubDate: 2026-04-18
updatedDate: 2026-08-30
indexTags:
  - ".net 11"
  - "dotnet 11"
  - ".net 11 preview"
  - "dotnet-11"
  - "dotnet"
  - ".net"
---

This pillar collects everything I've written about **.NET 11**: previews, runtime changes, GC updates, JIT work, and the new BCL surface. I keep it current as each preview drops.

## What to read first

New here? Start at the top: each post covers one change, and older ones stay useful because the feature set is cumulative. Preview 7, out August 11, is newest: [MSBuild server is on by default](/2026/08/msbuild-server-on-by-default-dotnet-11-preview-7/), so back-to-back builds reuse a warm worker, [System.IO.Compression reads and writes encrypted ZIPs](/2026/08/dotnet-11-preview-7-password-protected-zip-archives/), [C# 15 gets labeled `break` and `continue`](/2026/08/csharp-15-labeled-break-and-continue-dotnet-11-preview-7/), and [Blazor Server circuits pause themselves when the tab goes idle](/2026/08/blazor-auto-pause-idle-circuits-dotnet-11-preview-7/). From Preview 6, the changes that still matter are [automatic CSRF protection on by default](/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/) and [union types in System.Text.Json](/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/). Outside the previews, [Aspire 13.5 puts a real terminal in the dashboard](/2026/08/aspire-13-5-withterminal-interactive-shells-in-the-dashboard/). The breaking change to know before upgrading is [the minimum CPU baseline rising to x86-64-v2](/2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2/), which can refuse to start on older hardware.

Upgrading rather than browsing? Start from the checklists: [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) for an LTS-to-LTS jump, or [Migrate from .NET Framework 4.8 to .NET 11 in 2026](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) for the old framework. With versions scattered across csproj files, [move to Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) first.

## What's on this page

The table below auto-collects posts tagged with any of: `.net 11`, `dotnet 11`, `.net 11 preview`, `dotnet-11`, `dotnet`, `.net`, newest first.

For quick reference instead of chronology, see the companion "EF Core 11 cheat sheet" and "C# 14 features" pillars.
