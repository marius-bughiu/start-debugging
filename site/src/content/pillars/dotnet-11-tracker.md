---
title: "The .NET 11 tracker"
description: "Every preview, every feature, every breaking change - one place to bookmark for the .NET 11 release cycle."
tagline: "One bookmark for the whole .NET 11 cycle."
pubDate: 2026-04-18
updatedDate: 2026-06-21
indexTags:
  - ".net 11"
  - "dotnet 11"
  - ".net 11 preview"
  - "dotnet-11"
  - "dotnet"
  - ".net"
---

This pillar collects everything I've written about **.NET 11**: previews, runtime changes, GC updates, JIT work, and the new BCL surface. Bookmark this page and I'll keep it current as each preview drops.

## What to read first

If you're new to the .NET 11 story, start with the posts tagged **".net 11 preview"** near the top of the list; each covers a single preview's highlights, and older posts stay useful because the feature set is cumulative. Preview 5 is the newest drop: [System.Text.Json finally writes JSON Lines](/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/), [LINQ gains FullJoin and selector-free joins](/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/), and [X25519 key agreement lands in-box](/2026/06/dotnet-11-x25519-key-agreement-preview-5/) are the BCL highlights. From Preview 4, [MAUI switches to CoreCLR by default on Android, iOS, and Mac Catalyst](/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) and [.NET 11 adds deadlock-free Process output capture](/2026/05/dotnet-11-process-api-deadlock-free-capture/) are the headline behavioural changes. The breaking change to know before you upgrade is [the minimum CPU baseline rising to x86-64-v2](/2026/06/dotnet-11-minimum-cpu-baseline-x86-64-v2/), which can refuse to start on older hardware.

If you're here to upgrade rather than browse, start from the checklists: [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) for an LTS-to-LTS jump, or [Migrate from .NET Framework 4.8 to .NET 11 in 2026](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) for the old framework.

## What's on this page

The table below is auto-generated from posts tagged with any of: `.net 11`, `dotnet 11`, `.net 11 preview`, `dotnet`, `.net`, newest first.

For a quick reference instead of chronological coverage, see the companion "EF Core 11 cheat sheet" and "C# 14 features" pillars.
