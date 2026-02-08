---
title: ".NET Framework 3.5 is going “standalone” on new Windows builds (what breaks in automation)"
description: "Microsoft changed something that a lot of devs and IT folks automated and then forgot about: starting with Windows 11 Insider Preview Build 27965, .NET Framework 3.5 is no longer included as an optional Windows component. If you need it, you now have to obtain it as a standalone installer. This is a .NET Framework…"
pubDate: 2026-02-07
tags:
  - "net"
  - "windows"
---
Microsoft changed something that a lot of devs and IT folks automated and then forgot about: starting with **Windows 11 Insider Preview Build 27965**, **.NET Framework 3.5 is no longer included as an optional Windows component**. If you need it, you now have to obtain it as a **standalone installer**.

This is a .NET Framework story, but it will hit teams building modern services in **.NET 10** and **C# 14** because the pain shows up in places like fresh developer machines, ephemeral CI agents, golden images, and locked down networks.

## The key detail: “NetFx3” is not guaranteed anymore

From the post:

-   The change applies to **Build 27965 and future platform releases** of Windows.
-   It **does not affect Windows 10** or earlier Windows 11 releases through **25H2**.
-   It is tied to lifecycle reality: **.NET Framework 3.5 approaches end of support on January 9, 2029**.

If your scripts assume “enable the feature and Windows will handle it”, expect breakage on the newer line.

## What your provisioning should do now

Treat .NET Framework 3.5 as a dependency you explicitly provision and verify. At minimum:

-   Detect Windows build versions that are on the new behavior.
-   Verify whether `NetFx3` can be queried and enabled on that machine.
-   If not, follow the official guidance for the standalone installer and compatibility notes.

Here is a practical guardrail you can drop into build agent provisioning or a “preflight” step:

```powershell
# Works on Windows PowerShell 5.1 and PowerShell 7+
$os = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$build = [int]$os.CurrentBuildNumber

Write-Host "Windows build: $build"

# Query feature state (if the OS exposes it this way)
dism /online /Get-FeatureInfo /FeatureName:NetFx3

if ($build -ge 27965) {
  Write-Host ".NET Framework 3.5 is obtained via standalone installer on this Windows line."
  Write-Host "Official guidance (installers + compatibility + migration paths):"
  Write-Host "https://go.microsoft.com/fwlink/?linkid=2348700"
}
```

This does not install anything by itself. It makes the failure explicit, early, and easy to interpret when a machine image silently changed under you.

## The “why” you should act on now

Even if you plan to migrate, you probably still have:

-   Internal tools or vendor apps that require 3.5
-   Test suites that spin up old utilities
-   Customers with long upgrade cycles

So the immediate win is not “stay on 3.5”. The immediate win is making your environment predictable while you work towards supported targets.

Sources:

-   .NET Blog post: [https://devblogs.microsoft.com/dotnet/dotnet-framework-3-5-moves-to-standalone-deployment-in-new-versions-of-windows/](https://devblogs.microsoft.com/dotnet/dotnet-framework-3-5-moves-to-standalone-deployment-in-new-versions-of-windows/)
-   Microsoft Learn guidance link (from the post): [https://go.microsoft.com/fwlink/?linkid=2348700](https://go.microsoft.com/fwlink/?linkid=2348700)
