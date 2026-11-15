---
title: "Visual Studio 2026 LTSC 18.11: two years of fixes, no new features"
description: "Visual Studio 2026 LTSC 18.11 shipped on November 10, 2026 with support through November 14, 2028. What the channel freezes, how to switch to it, and how to pin Build Tools and the .NET 10 SDK on CI."
pubDate: 2026-11-15
tags:
  - "visual-studio"
  - "dotnet"
  - "dotnet-10"
  - "ci"
---

On the same day .NET 11 went GA, Microsoft opened the first long-term servicing channel for Visual Studio 2026: [LTSC 18.11](https://devblogs.microsoft.com/visualstudio/announcing-visual-studio-2026-ltsc-1811/). The headline change is the length. LTSC 18.11 is supported through November 14, 2028, two years instead of the one year that was announced earlier. The current build on the channel is 18.11.4, released November 10, 2026, while the Stable channel moved on to 18.12.

## What LTSC 18.11 actually freezes

LTSC is not a separate product. The announcement describes it as "a new support and servicing channel for Visual Studio 2026", containing everything that shipped in 18.0 through 18.10. From here on it receives security and critical fixes only. No feature updates are planned, so anything that lands in 18.12 and later (Copilot changes included) stays on Stable.

The toolsets inside the channel are the long-term ones:

- .NET 10 LTS, which is itself supported until November 2028
- MSVC 14.50 and 14.52

That alignment is the point. A team that standardized on .NET 10 LTS can now hold the IDE and the compiler toolchain still for the same window, instead of taking a monthly feature update on Stable to stay supported. Teams moving to .NET 11 (see [what to change for .NET 11 GA](/2026/11/dotnet-11-is-generally-available-what-to-change-in-your-project/)) belong on Stable: LTSC 18.11 lists .NET 10 LTS as its toolset, and new tooling for newer releases lands on Stable.

The [servicing page](https://learn.microsoft.com/visualstudio/releases/2026/servicing-vs) spells out the wider policy: for Visual Studio 2026 and later, the only older releases that get servicing are LTSC releases. Stable itself is supported as an 18.x feature update line through November 2027. LTSC is offered for Enterprise, Professional, and Build Tools (Community has to stay current within 180 days), and existing 2026 product keys work on both channels.

## Switching an existing install

The [18.11 release notes](https://learn.microsoft.com/visualstudio/releases/2026/release-notes-v18.11) document the switch through the installer UI: open Visual Studio Installer, choose **More** > **Update settings**, set **Update channel** to **LTSC version 18.11**, then run **Update** to land on 18.11.4. If your Stable install is already past 18.11, the notes route you through **More** > **Rollback to previous version** first, or you can install LTSC side by side.

## Pinning LTSC on build agents

The release notes also publish channel-specific bootstrappers that always install the latest LTSC 18.11 build:

- `https://aka.ms/vs/18/release.ltsc.18.11/vs_Enterprise.exe`
- `https://aka.ms/vs/18/release.ltsc.18.11/vs_Professional.exe`
- `https://aka.ms/vs/18/release.ltsc.18.11/vs_BuildTools.exe`

For a Windows build image, that makes a reproducible Build Tools install a short script using the standard bootstrapper switches:

```powershell
$bootstrapper = "$env:TEMP\vs_BuildTools.exe"
Invoke-WebRequest "https://aka.ms/vs/18/release.ltsc.18.11/vs_BuildTools.exe" -OutFile $bootstrapper

& $bootstrapper --quiet --wait --norestart --nocache `
  --add Microsoft.VisualStudio.Workload.ManagedDesktopBuildTools `
  --add Microsoft.VisualStudio.Workload.VCTools `
  --includeRecommended
```

Pair it with a `global.json` so `dotnet` on that agent resolves to a .NET 10 feature band and rolls forward only on patches:

```json
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestPatch"
  }
}
```

Without that file, a machine that also has a .NET 11 SDK from another install picks the newest SDK, and the LTSC pin on the IDE side no longer describes what actually builds your code.

## Who should move

Stable remains Microsoft's recommended channel, and it is where every new feature lands. LTSC 18.11 is for regulated environments, long-lived build images, and teams that ship on .NET 10 LTS until 2028 and want security fixes without UI or tooling churn. Staying current on LTSC servicing updates is still required to remain supported, so "frozen" means no new features, not no updates.
