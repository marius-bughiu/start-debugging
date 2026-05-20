---
title: "NuGet Package Pruning Is On by Default in .NET 10"
description: "NuGet Package Pruning shipped on-by-default for net10.0 projects, cutting transitive vulnerability reports by 70% and restore times by up to 50%."
pubDate: 2026-05-20
tags:
  - "dotnet"
  - "dotnet-10"
  - "nuget"
  - "security"
---

Nikolche Kolev [announced](https://devblogs.microsoft.com/dotnet/nuget-package-pruning-in-dotnet-10/) that NuGet Package Pruning is enabled by default for any project targeting `net10.0` or later. The change ships in the .NET 10 SDK and resets a default that has been quietly causing noisy `dotnet list package --vulnerable` output for years: the runtime libraries are already in the shared framework, so listing them again as NuGet dependencies just creates phantom CVEs.

## What Pruning Actually Removes

The .NET SDK ships a per-target-framework manifest of packages the runtime already provides, along with the highest version each framework supplies. During restore, NuGet drops any transitive package whose version is at or below the runtime's. Direct references are not deleted, but they get rewritten with `PrivateAssets='all'` and `IncludeAssets='none'` so the runtime copy wins, and NuGet emits the new **NU1510** warning when the reference is entirely redundant.

The blog cites two concrete numbers: 70% fewer transitive vulnerability reports for projects on the new defaults, and up to 50% lower restore time per project once the graph stops chasing packages the runtime already owns.

## What's On by Default

In a `net10.0` project, the SDK now behaves as if you wrote:

```xml
<PropertyGroup>
  <RestoreEnablePackagePruning>true</RestoreEnablePackagePruning>
  <NuGetAuditMode>all</NuGetAuditMode>
</PropertyGroup>
```

`NuGetAuditMode=all` also flips from `direct` to `all`, so the remaining transitive set still gets audited. Pruning and auditing are designed to compose: pruning cuts the graph down to what is actually shipped on top of the runtime, and the audit runs against that smaller graph.

In a multi-targeted project, if any TFM is `net10.0` or later, pruning is applied to every TFM in the project. That avoids the surprise where one head silently restores differently from another.

## A Concrete Before / After

A common pattern is a console app that pulls in `Microsoft.Extensions.AI` and `NuGet.Protocol`. On .NET 9 you would see `System.Formats.Asn1 6.0.0` surface in audit output via a deep transitive path, even though `net10.0` ships a newer `System.Formats.Asn1` in the shared framework. After upgrading the TFM:

```xml
<TargetFramework>net10.0</TargetFramework>
```

`System.Formats.Asn1`, `System.Diagnostics.DiagnosticSource`, `System.Text.Json`, and `System.Threading.Channels` all disappear from the resolved graph. Their CVE entries stop showing up in `dotnet list package --vulnerable` because they were never going to be loaded at runtime in the first place.

## Opting Out

The escape hatches both exist:

```xml
<PropertyGroup>
  <RestoreEnablePackagePruning>false</RestoreEnablePackagePruning>
  <NuGetAuditMode>direct</NuGetAuditMode>
</PropertyGroup>
```

You would do that on a library that genuinely needs to ship its own `System.Text.Json` for downlevel consumers, or on a CI job that still has tooling pinned to a pre-10 SDK reading the lock file.

If you have been carrying `<NoWarn>NU1903;NU1904</NoWarn>` to silence transitive vulnerability warnings on shared-framework packages, this is the release where you get to delete it. Bump the TFM, run restore once, and check whether the audit report shrank.
