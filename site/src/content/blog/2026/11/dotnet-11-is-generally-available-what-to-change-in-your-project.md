---
title: ".NET 11 Is Generally Available: What to Change in Your Project Today"
description: ".NET 11.0.0 and SDK 11.0.100 shipped on November 10, 2026 as an STS release supported until November 14, 2028. The retarget steps, what C# 15 turns on by default, what is still preview, and the CPU baseline check to do first."
pubDate: 2026-11-11
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp-15"
  - "migration"
---

.NET 11 shipped on November 10, 2026. The [release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/11.0.0/11.0.0.md) list runtime 11.0.0 and SDK 11.0.100, and Visual Studio 18.12.0 bundles both. It is a Standard Term Support release: the [dotnet/core release page](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md) puts its end of support at November 14, 2028. The same day, .NET 8 and .NET 9 left support, which we covered in [.NET 8 and .NET 9 reach end of support on November 10, 2026](/2026/11/dotnet-8-and-dotnet-9-reach-end-of-support-on-november-10-2026/). So if you were on 9, you now have to pick between .NET 10 (LTS, supported until November 2028) and .NET 11 (STS, also supported until November 2028).

## Installing the SDK does not upgrade anything

The [announcement](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11/) is explicit that installing SDK 11.0.100 does not retarget your app. You still need to make the change yourself:

```json
// global.json, only if your repo pins the SDK
{
  "sdk": {
    "version": "11.0.100",
    "rollForward": "latestFeature"
  }
}
```

```xml
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <!-- MAUI and Windows projects keep their suffixes: net11.0-android, net11.0-windows10.0.19041.0 -->
</PropertyGroup>
```

Then update `Microsoft.*` packages and workloads to the 11.0.0 versions. If you tested on an RC, also move every RC package off `11.0.0-rc.*`. A leftover `Microsoft.EntityFrameworkCore 11.0.0-rc.3` next to a GA runtime is the easiest mismatch to miss. EF Core 11 requires .NET 11, so check that your database provider has shipped an 11.x build before you bump it.

## Check the CPU baseline before you deploy

The announcement names one breaking change ahead of all the others: updated minimum CPU requirements. On x64, .NET 11 needs x86-64-v2 (SSE4.2, POPCNT, and CX16, among others), and on Windows Arm64 it needs LSE. The [runtime what's new page](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-11/runtime#updated-minimum-hardware-requirements) has the full list. A CPU below the baseline doesn't produce a build error. The runtime refuses to start on that machine. Modern servers are fine. The risky hosts are old build agents, budget VPS instances, and VMs pinned to a restricted CPU model. Run a `net11.0` build on your oldest production node before rolling out anywhere else.

## What you get by default, and what stays opt-in

Once a project targets `net11.0`, the default language version is C# 15. Union types, `closed` class hierarchies, collection expression arguments, extension indexers, and labeled `break`/`continue` all work without `LangVersion` changes:

```csharp
public union LookupResult(Product, NotFound);

string Describe(LookupResult r) => r switch
{
    Product p => p.Name,
    NotFound => "missing",
    null => "unset", // default(LookupResult) has a null Value
}; // no discard arm needed: the case types are exhaustive

var names = new HashSet<string>([with(StringComparer.OrdinalIgnoreCase), "Alice", "ALICE", "Bob"]);
Console.WriteLine(names.Count); // 2
```

Also on by default: the native AOT CLI host and a warm MSBuild server, OpenAPI 3.2 for generated ASP.NET Core documents, and CoreCLR as the .NET MAUI runtime on every platform.

Several headline features are still opt-in or preview at GA:

- **Runtime async** stays a preview feature. Turn it on with `<Features>runtime-async=on</Features>`. You no longer need `EnablePreviewFeatures`.
- **C# memory safety** work remains in preview.
- **`Microsoft.AspNetCore.Components.AI`** stays prerelease for the whole .NET 11 lifetime.
- **Blazor circuit pause on inactive tabs** needs an extra package and configuration.
- **SQL Server vector search in EF Core 11** is experimental.
- **`dotnetup`**, the new user-level toolchain manager, is a public preview.

If you set OpenAPI clients or snapshot tests against 3.1 documents, pin the version explicitly before upgrading, or regenerate your snapshots.

## STS or LTS

Both .NET 10 and .NET 11 are now supported until November 2028, so the support window no longer decides it. Pick .NET 11 if you want C# 15 unions or the SDK speedups now. Stay on .NET 10 if your hosts can't meet the new CPU baseline or your providers haven't shipped 11.x packages. The full list is in the [.NET 11 breaking changes](https://learn.microsoft.com/dotnet/core/compatibility/11) page, and that is the page to read before you change the `TargetFramework`.
