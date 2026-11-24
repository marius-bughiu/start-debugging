---
title: "Fix: You must install or update .NET to run this application, with a .NET 11 RC runtime installed"
description: "An app built with the .NET 11 GA SDK asks for runtime 11.0.0, and 11.0.0-rc.2 sorts below it, so no roll-forward setting helps. Install the GA runtime or publish self-contained."
pubDate: 2026-11-24
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "linux"
---

An app built with the .NET 11 GA SDK (11.0.100) asks for runtime `11.0.0`. A release candidate such as `11.0.0-rc.2.26504.105` is an earlier version than `11.0.0` under SemVer, so the host refuses it, and no `RollForward` value or environment variable changes that. Install the 11.0.0 runtime next to the RC (from your distro feed once it lands, or with `dotnet-install.sh`), or publish self-contained. Everything below was reproduced with .NET 11.0.0 GA and 11.0.0-rc.2.26504.105 on 2026-11-24.

## The error, as Linux prints it

This shows up most often right after the November 10, 2026 GA: the app runs on a developer machine, gets published, and fails on a server whose package feed still carries the release candidate. The output names the missing version and, helpfully, lists the RC it rejected:

```text
You must install or update .NET to run this application.

App: /srv/webapp/WebApp.dll
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '11.0.0' (x64)
.NET location: /usr/lib64/dotnet/

The following frameworks were found:
  10.0.13 at [/usr/lib64/dotnet/shared/Microsoft.NETCore.App]
  11.0.0-rc.2.26504.105 at [/usr/lib64/dotnet/shared/Microsoft.NETCore.App]

Learn more:
https://aka.ms/dotnet/app-launch-failed

To install missing framework, download:
https://aka.ms/dotnet-core-applaunch?framework=Microsoft.NETCore.App&framework_version=11.0.0&arch=x64&rid=linux-x64&os=linux
```

The process exits with code `150`. The `dotnet --list-runtimes` output on such a box looks like this, which is exactly the state from the [Stack Overflow question](https://stackoverflow.com/questions/80017018) behind this post (a Blazor app upgraded to .NET 11 and deployed to CentOS Stream 10, where `sudo dnf install aspnetcore-runtime-11.0` installed RC2):

```text
Microsoft.AspNetCore.App 10.0.13 [/usr/lib64/dotnet/shared/Microsoft.AspNetCore.App]
Microsoft.AspNetCore.App 11.0.0-rc.2.26504.105 [/usr/lib64/dotnet/shared/Microsoft.AspNetCore.App]
Microsoft.NETCore.App 10.0.13 [/usr/lib64/dotnet/shared/Microsoft.NETCore.App]
Microsoft.NETCore.App 11.0.0-rc.2.26504.105 [/usr/lib64/dotnet/shared/Microsoft.NETCore.App]
```

At a glance, "11.0 is installed" looks true. It is not, as far as the host is concerned.

## Why 11.0.0-rc.2 does not satisfy 11.0.0

A framework-dependent app does not carry the runtime. At build time the SDK writes the version it needs into `<app>.runtimeconfig.json`, and at launch `hostfxr` searches `shared/Microsoft.NETCore.App/` (and `shared/Microsoft.AspNetCore.App/` for web apps) for a compatible version. The SDK 11.0.100 writes `11.0.0` for a `net11.0` project:

```json
// WebApp.runtimeconfig.json, produced by dotnet publish with SDK 11.0.100
{
  "runtimeOptions": {
    "tfm": "net11.0",
    "frameworks": [
      { "name": "Microsoft.NETCore.App", "version": "11.0.0" },
      { "name": "Microsoft.AspNetCore.App", "version": "11.0.0" }
    ]
  }
}
```

Roll-forward only ever moves up. The [version selection docs](https://learn.microsoft.com/en-us/dotnet/core/versions/selection) say so directly: lower versions are not considered. And the [framework resolution design document](https://github.com/dotnet/runtime/blob/main/docs/design/features/framework-version-resolution.md) defines the ordering: a pre-release version sorts before the same version without a pre-release label, so `11.0.0-rc.2.26504.105 < 11.0.0`. The RC is not a candidate under any policy, the same way `10.0.13` is not.

You don't have to take that on faith. Turning on host tracing shows the resolver's reasoning:

```bash
# .NET 11.0.0-rc.2.26504.105 host, app built with SDK 11.0.100
COREHOST_TRACE=1 COREHOST_TRACEFILE=/tmp/host.txt dotnet WebApp.dll
grep -A6 "Attempting FX roll forward" /tmp/host.txt
```

```text
Attempting FX roll forward starting from version='[11.0.0]', apply_patches=1, version_compatibility_range=minor, roll_to_highest_version=0, prefer_release=1
'Roll forward' enabled with version_compatibility_range [minor]. Looking for the lowest release greater than or equal version to [11.0.0]
No match greater than or equal to [11.0.0] found.
'Roll forward' enabled with version_compatibility_range [minor]. Looking for the lowest release/pre-release greater than or equal version to [11.0.0]
No match greater than or equal to [11.0.0] found.
Framework reference didn't resolve to any available version.
It was not possible to find any compatible framework version
```

Two passes, and the second one already includes pre-releases. It still finds nothing, because nothing on disk is greater than or equal to `11.0.0`.

## Minimal repro

The repro used for this post ran on macOS 27 (arm64). The host resolution logic lives in `hostfxr` and is the same code on Linux; only the paths and the RID in the error differ. Commands:

```bash
# 1. A "server" that only has the RC2 runtimes (plus 10.0.13, like the SO question)
curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
bash dotnet-install.sh --runtime aspnetcore --version 11.0.0-rc.2.26504.105 --install-dir ./rc2 --no-path
bash dotnet-install.sh --runtime aspnetcore --version 10.0.13 --install-dir ./rc2 --no-path

# 2. An app built with the GA SDK 11.0.100
dotnet new web -n WebApp -o WebApp
dotnet publish WebApp -c Release -o out-fdd

# 3. Run it against the RC-only install
./rc2/dotnet out-fdd/WebApp.dll           # You must install or update .NET ... exit 150
DOTNET_ROOT=$PWD/rc2 ./out-fdd/WebApp     # same error through the apphost
```

The `--runtime aspnetcore` installs bring the matching `Microsoft.NETCore.App`, which is why `--list-runtimes` shows both frameworks.

## Fix 1: install the 11.0.0 runtime next to the RC

This is the real fix for a framework-dependent deployment. Runtimes install side by side, so the RC can stay until you remove it.

On CentOS Stream and RHEL, .NET ships in the AppStream repositories, and [Microsoft's RHEL install page](https://learn.microsoft.com/en-us/dotnet/core/install/linux-rhel) lists .NET 11 as supported on RHEL 8, 9, 10 and CentOS Stream 9 and 10. The catch is timing: the distro builds the GA packages after Microsoft releases them, and in the SO question the feed still held RC2 a week after GA. Check what the repository actually offers before reinstalling:

```bash
# CentOS Stream 10 / RHEL 10, dnf
dnf list --showduplicates 'aspnetcore-runtime-11.0' 'dotnet-runtime-11.0'
sudo dnf upgrade --refresh 'aspnetcore-runtime-11.0'
dotnet --list-runtimes
```

The same Learn page warns that a package manager may treat a non-preview release as older than a preview it already installed. If `dnf upgrade` reports nothing to do while a GA build is listed, remove the RC package and install again instead of fighting the version comparison.

If you cannot wait for the distro, install the GA runtime with the script. It does not need root when it targets your own directory, and it does not install system dependencies (glibc, libicu, openssl-libs and friends are already there if the RC ran):

```bash
# .NET 11.0.0 GA runtime, scripted install, no package manager
curl -sSL https://dot.net/v1/dotnet-install.sh -o dotnet-install.sh
bash dotnet-install.sh --runtime aspnetcore --channel 11.0 --install-dir /opt/dotnet11
export DOTNET_ROOT=/opt/dotnet11
/opt/dotnet11/dotnet --list-runtimes
```

In the repro, adding `11.0.0` into the same directory as the RC produced this list, and the unchanged `out-fdd` build served `Hello World!`:

```text
Microsoft.AspNetCore.App 10.0.13 [.../rc2ga/shared/Microsoft.AspNetCore.App]
Microsoft.AspNetCore.App 11.0.0-rc.2.26504.105 [.../rc2ga/shared/Microsoft.AspNetCore.App]
Microsoft.AspNetCore.App 11.0.0 [.../rc2ga/shared/Microsoft.AspNetCore.App]
Microsoft.NETCore.App 10.0.13 [.../rc2ga/shared/Microsoft.NETCore.App]
Microsoft.NETCore.App 11.0.0-rc.2.26504.105 [.../rc2ga/shared/Microsoft.NETCore.App]
Microsoft.NETCore.App 11.0.0 [.../rc2ga/shared/Microsoft.NETCore.App]
```

Two things to watch with a second install location. First, `dotnet` on `PATH` must be the one under `/opt/dotnet11`, or a systemd unit must call `/opt/dotnet11/dotnet WebApp.dll` explicitly. Second, an apphost (`./WebApp`) looks at `DOTNET_ROOT`, then at the registered install location in `/etc/dotnet/install_location`, then at the default path, so set `Environment=DOTNET_ROOT=/opt/dotnet11` in the unit file if you launch the apphost. Don't drop script-installed files into `/usr/lib64/dotnet`: that directory belongs to the RPMs, and the next `dnf` transaction will not know about them.

## Fix 2: publish self-contained

A self-contained app ships its own runtime and never asks the shared install for anything, so the server's RC becomes irrelevant:

```bash
# .NET 11 SDK 11.0.100, Linux x64 target
dotnet publish -c Release -r linux-x64 --self-contained -o out-sc
```

The generated `runtimeconfig.json` switches from `frameworks` to `includedFrameworks`, which is how the host knows not to resolve anything:

```json
// out-sc/WebApp.runtimeconfig.json
{
  "runtimeOptions": {
    "tfm": "net11.0",
    "includedFrameworks": [
      { "name": "Microsoft.NETCore.App", "version": "11.0.0" },
      { "name": "Microsoft.AspNetCore.App", "version": "11.0.0" }
    ]
  }
}
```

In the repro, the osx-arm64 self-contained build started and answered requests with `DOTNET_ROOT` deliberately pointed at the RC-only install. The cost is size and patching: the framework-dependent `dotnet new web` output was 128 KB, the `linux-x64` self-contained output 107 MB in 336 files. You also own servicing now. When 11.0.1 ships with security fixes, the server's `dnf upgrade` does nothing for this app; you have to rebuild and redeploy. Trimming (`-p:PublishTrimmed=true`) shrinks the output but needs trim-safe code, which many Blazor Server and MVC apps are not.

## Fix 3: stay on net10.0 until the feed catches up

If the upgrade to .NET 11 is not urgent, retargeting to `net10.0` produces a runtimeconfig that asks for `10.0.0`, which rolls forward to the `10.0.13` already on the server. In the repro the retargeted app ran on the RC2-only install without changes. This is a reasonable stopgap for a week or two. It is not a fix if you already use .NET 11 APIs or C# 15 features that need the 11 runtime.

## What does not work: RollForward and DOTNET_ROLL_FORWARD_TO_PRERELEASE

The first instinct is to relax roll-forward. Each of these was tested against the RC2-only install, and each still failed with the same message:

```bash
# All fail: there is no runtime >= 11.0.0 on disk
DOTNET_ROLL_FORWARD=LatestMajor dotnet WebApp.dll
dotnet exec --roll-forward LatestMajor WebApp.dll
DOTNET_ROLL_FORWARD_TO_PRERELEASE=1 dotnet WebApp.dll
DOTNET_ROLL_FORWARD=LatestMajor DOTNET_ROLL_FORWARD_TO_PRERELEASE=1 dotnet WebApp.dll
```

The trace for the last one shows the host doing exactly what was asked, looking for the highest release or pre-release, and still coming back empty:

```text
Attempting FX roll forward starting from version='[11.0.0]', apply_patches=1, version_compatibility_range=major, roll_to_highest_version=1, prefer_release=0
'Roll forward' enabled with version_compatibility_range [major]. Looking for the highest release/pre-release greater than or equal version to [11.0.0]
No match greater than or equal to [11.0.0] found.
```

`DOTNET_ROLL_FORWARD_TO_PRERELEASE` is documented as enabling roll-forward "to a pre-release version from a release version" on the [environment variables page](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-environment-variables). That helps when a release `11.0.0` request could land on something like `11.0.1-preview`, a higher version. It cannot turn a lower version into a match. The same goes for `<RollForward>` in the csproj and `rollForward` in `runtimeconfig.json`: they decide how far up the host may go, never down.

## The hack that runs, and why not to ship it

Editing the published `runtimeconfig.json` to request the RC exactly does make the app start:

```json
// out-hack/WebApp.runtimeconfig.json, hand-edited. Do not ship this.
{ "name": "Microsoft.NETCore.App", "version": "11.0.0-rc.2.26504.105" },
{ "name": "Microsoft.AspNetCore.App", "version": "11.0.0-rc.2.26504.105" }
```

The `dotnet new web` app served `Hello World!` on RC2 with this change. That proves only that a hello-world endpoint does not touch anything that changed between RC2 and GA. Your code was compiled against the 11.0.0 reference assemblies, and an API, behaviour fix, or security patch that landed after RC2 can surface as a `MissingMethodException` or a silent difference at run time. RC builds are also not a supported production runtime, so the server is unpatched either way. Treat this as a diagnostic, not a deployment.

The reverse direction works on its own, which is why the problem is easy to miss in testing: the same hand-edited config, run on a machine with only the 11.0.0 GA runtime, rolled forward from `11.0.0-rc.2.26504.105` to `11.0.0` and started normally. An app built with an RC SDK runs on a GA server; an app built with the GA SDK does not run on an RC server.

## Gotchas and lookalikes

- **The CI agent is fine, the server is not.** The GA SDK on your build agent says nothing about the target. Run `dotnet --list-runtimes` on the target host as part of the deploy, and fail early if `Microsoft.AspNetCore.App 11.0.` with no pre-release label is missing.
- **Two frameworks, two checks.** A web app needs both `Microsoft.NETCore.App` and `Microsoft.AspNetCore.App` at `11.0.0` or later. Installing `dotnet-runtime-11.0` GA alone still fails on the ASP.NET Core framework, and the error then names `Microsoft.AspNetCore.App`.
- **Docker images.** Pinning `mcr.microsoft.com/dotnet/aspnet:11.0-preview` or an RC tag reproduces the same failure in a container. Move base images to `aspnet:11.0`, the GA tag, alongside the SDK.
- **Old runtime, not prerelease.** If the found list has only older majors (say `6.0.36` for a `net8.0` app), it is the same mechanism with no RC involved, covered in [the framework_version=6.0.0 fix](/2026/05/fix-framework-version-6-0-0-when-launching-dotnet-6-binary/).
- **No `dotnet` at all.** A missing host on a build agent fails earlier, before any framework lookup; see [the command 'dotnet' could not be found on CI](/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/).

## Related

- [.NET 11 is generally available: what to change in your project today](/2026/11/dotnet-11-is-generally-available-what-to-change-in-your-project/) covers the GA versions and moving RC packages off `11.0.0-rc.*`.
- [Migrating from .NET 8 to .NET 11](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) lists the runtime and container checks for a full upgrade.
- [dotnetup installs the SDK your global.json pins](/2026/10/dotnetup-public-preview-installs-the-sdk-your-global-json-pins/) is the newer way to keep SDK versions straight on build machines.

## Sources

- [Select the .NET version to use](https://learn.microsoft.com/en-us/dotnet/core/versions/selection) (roll-forward policies and precedence)
- [.NET environment variables](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-environment-variables) (`DOTNET_ROLL_FORWARD`, `DOTNET_ROLL_FORWARD_TO_PRERELEASE`)
- [Framework version resolution design](https://github.com/dotnet/runtime/blob/main/docs/design/features/framework-version-resolution.md) (pre-release ordering)
- [Install .NET on RHEL and CentOS Stream](https://learn.microsoft.com/en-us/dotnet/core/install/linux-rhel)
- [dotnet-install scripts reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-install-script)
- [Stack Overflow: Upgraded Blazor web app to .NET 11, app launch fails](https://stackoverflow.com/questions/80017018)
