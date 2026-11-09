---
title: ".NET 8 and .NET 9 Reach End of Support on November 10, 2026: What Changes Tomorrow"
description: ".NET 8 (LTS) and .NET 9 (STS) both leave support on November 10, 2026. What stops, what keeps running, why the two end on the same day, and the minimal steps to move a project to .NET 10."
pubDate: 2026-11-09
tags:
  - "dotnet"
  - "dotnet-10"
  - "dotnet-8"
  - "dotnet-9"
  - "migration"
---

Tomorrow, November 10, 2026, is the last day Microsoft supports .NET 8 or .NET 9. Both versions reach end of support on the same Patch Tuesday, as announced in the [.NET Blog post by Rahul Bhandari](https://devblogs.microsoft.com/dotnet/dotnet-8-9-end-of-support/) and reflected on the [official .NET support policy page](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core). If you still have services on `net8.0` or `net9.0`, this is the day they stop getting security fixes.

## Why an LTS and an STS release end on the same day

.NET 8 is an LTS release that shipped on November 14, 2023, with 36 months of support. .NET 9 is an STS release that shipped on November 12, 2024. Under the old policy it would have ended in May 2026, but STS releases now get 24 months instead of 18, which moves .NET 9's end date to November 10, 2026. Microsoft aligns end-of-life dates with Patch Tuesday, so both land on the same day.

Both versions have been in the "maintenance" phase for the last six months, which means they only received security fixes. After tomorrow they get nothing.

## What actually stops

According to the announcement:

- Apps built on .NET 8 or .NET 9 keep running. Nothing is switched off.
- No new security updates will ship for either version. November 10 may bring one final patch, but only if there is a known critical issue.
- Microsoft technical support ends for apps on those versions.
- A future Visual Studio 2022 servicing update will mark the .NET 8 and .NET 9 components as out of support. Existing installs are not touched.

The real risk is the first CVE disclosed after November 10. Framework-dependent apps on Windows stop receiving patches through Microsoft Update, and self-contained apps keep shipping whatever runtime they were last published with.

## Moving a project to .NET 10

The recommended target is .NET 10, an LTS release supported until November 14, 2028. For most projects the change starts in the project file:

```xml
<!-- Before -->
<PropertyGroup>
  <TargetFramework>net8.0</TargetFramework>
</PropertyGroup>

<!-- After -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
</PropertyGroup>
```

Multi-targeting libraries can drop `net8.0` and `net9.0` from the list. Keep a `netstandard2.0` target if older consumers still depend on it:

```xml
<!-- Before -->
<TargetFrameworks>net8.0;net9.0;netstandard2.0</TargetFrameworks>

<!-- After -->
<TargetFrameworks>net10.0;netstandard2.0</TargetFrameworks>
```

The project file is only part of the change. Pin the SDK in `global.json` so CI and developer machines agree:

```json
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
```

Then update everything that carries its own runtime version: container base images (`mcr.microsoft.com/dotnet/aspnet:8.0` becomes `:10.0`), `actions/setup-dotnet` or Azure Pipelines `UseDotNet` tasks, and the runtime stack configured on your hosting environment. To find out what a build agent or server still has installed, run:

```bash
dotnet --list-runtimes
dotnet --list-sdks
```

Before you flip the target, read the [.NET 10 breaking changes](https://learn.microsoft.com/dotnet/core/compatibility/10.0) list. The post links the [.NET Upgrade Assistant](https://learn.microsoft.com/dotnet/core/porting/upgrade-assistant-overview) for larger solutions, and the GitHub Copilot upgrade agent covers the same ground (it recently picked up [Windows Arm64 migration](/2026/11/copilot-upgrade-agent-adds-windows-arm64-migration-for-dotnet-apps/)). For third-party software built on .NET 8 or 9, the official advice is to ask the vendor for a .NET 10 build.

## The calendar from here

The support policy page lists November 10 as the end date for .NET 11 RC3 as well, and .NET Conf 2026, where .NET 11 is set to launch, opens the same day. That makes tomorrow a handoff day: two versions leave support while the next STS arrives. If you skip .NET 11, the next upgrade comes when .NET 12 (LTS) ships in November 2027. Either way, `net10.0` is the only safe target left for anything that has to stay patched.
