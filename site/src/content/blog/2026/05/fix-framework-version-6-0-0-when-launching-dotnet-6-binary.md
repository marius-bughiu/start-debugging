---
title: "Fix: framework_version=6.0.0 was not found when launching a .NET 6 binary"
description: "The .NET 6 runtime is gone or mismatched. Either install net6.0 again, roll forward to net8.0 via runtimeconfig, retarget the csproj, or ship self-contained."
pubDate: 2026-05-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-6"
  - "runtime"
  - "deployment"
---

The fix: a .NET 6 binary that prints `framework_version=6.0.0` and refuses to start is telling you the .NET 6 runtime is missing from the box, not that your app is broken. On a server still allowed to keep `net6.0`, install the Microsoft.NETCore.App 6.0 runtime and the launch error disappears. On a server that has moved on to net8.0 or net10.0, either set `rollForward` to `Major` in `runtimeconfig.json`, retarget the project to a supported framework, or publish self-contained so the binary carries its own runtime. A `MissingMethodException` immediately after that fix is the same problem with a delayed fuse: roll-forward let the app boot on a newer runtime, but a transitive assembly hard-binds to a method that .NET 6 had and the newer runtime renamed.

```text
You must install or update .NET to run this application.

App: /opt/myapp/MyApp
Architecture: x64
Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
.NET location: /usr/share/dotnet

The following frameworks were found:
  8.0.15 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]
  10.0.0 at [/usr/share/dotnet/shared/Microsoft.NETCore.App]

Learn more:
https://aka.ms/dotnet/app-launch-failed

To install missing framework, download:
https://aka.ms/dotnet-core-applaunch?framework=Microsoft.NETCore.App&framework_version=6.0.0&arch=x64&rid=linux-x64&os=linux
```

This guide is written for the situation that exists in May 2026: .NET 6 reached end of support on 2024-11-12, so production images, package managers, and base layers that auto-update have started uninstalling it. The same binary that ran in production for two years now fails to start with the message above. The behaviour is identical whether the host is `dotnet.exe MyApp.dll` on Windows, the apphost stub on Linux, or `dotnet exec` on macOS. The runtime probing rules described here are the ones in the .NET 6, .NET 8, and .NET 10 hosts; nothing about them changed between versions.

## Two errors, one root cause

The error appears in two shapes that look unrelated, and the second one is what trips most teams.

Shape one is the host-fxr error above. The host opens `MyApp.runtimeconfig.json`, reads the `tfm` and `framework` block, and decides it needs `Microsoft.NETCore.App` version 6.0.0. It then walks the install paths and finds either nothing or only newer SxS folders. The launch URL embeds the framework name and version as query parameters, which is why every search for `framework_version=6.0.0` lands on the same problem.

Shape two is `MissingMethodException` at runtime. The host found a compatible framework, the process started, then a `JIT_GetMethodCall` lookup failed:

```text
System.MissingMethodException: Method not found: 'System.String System.String.IsNullOrEmpty(System.String)'
   at MyApp.Services.RequestPipeline.HandleAsync(HttpContext ctx)
```

That happens when the app booted on a newer runtime, but one of the loaded assemblies was compiled against a .NET 6 reference assembly and references a method whose signature changed in .NET 8 or .NET 10. Roll-forward got you past the launch check, and the cost was a delayed binding error in user code. Both messages mean the .NET 6 runtime is not on this machine.

## Why your binary asks for 6.0.0 specifically

The version string `6.0.0` is not the runtime version installed when you built the project. It is the floor declared by the `<TargetFramework>` you compiled against. When you `dotnet publish` a `net6.0` project, MSBuild writes `MyApp.runtimeconfig.json` that looks like this:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    },
    "configProperties": {
      "System.Runtime.TieredCompilation": true
    }
  }
}
```

The host uses that `version` field as a minimum, not as an exact match. With the default `rollForward` policy of `Minor`, it accepts any 6.x but never 7.x or higher. With `Major`, it accepts 7.x, 8.x, 10.x. With `LatestPatch`, it only accepts 6.0.x. The reason your search query reads `framework_version=6.0.0` is that the host echoes the floor it asked for, even when no 6.x at all is installed.

Run `dotnet --list-runtimes` on the failing host. If you see `Microsoft.NETCore.App 8.0.15` and `10.0.0` but no 6.x line, that is the diagnosis. The line that should be there is `Microsoft.NETCore.App 6.0.x [/usr/share/dotnet/shared/Microsoft.NETCore.App]`.

## Minimal repro

Build a `net6.0` console app, publish framework-dependent, run it on a host that has only newer runtimes installed.

```xml
<!-- MyApp.csproj, .NET SDK 8.0.300+ still builds net6.0 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net6.0</TargetFramework>
  </PropertyGroup>
</Project>
```

```csharp
// MyApp/Program.cs, .NET 6, C# 10
Console.WriteLine($"Running on .NET {Environment.Version}");
```

```bash
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
./out/MyApp
# You must install or update .NET to run this application.
# Framework: 'Microsoft.NETCore.App', version '6.0.0' (x64)
```

The bug surfaces the same way in a Docker image that switched its base from `mcr.microsoft.com/dotnet/aspnet:6.0` to `mcr.microsoft.com/dotnet/aspnet:8.0` without a project retarget. The `net6.0` tag in `runtimeconfig.json` outlives the base image bump.

## Fix one, recommended: retarget the project

The supported answer in 2026 is to stop shipping `net6.0`. .NET 6 stopped getting security patches in November 2024, .NET 7 in May 2024, and .NET 9 in May 2026. The only currently supported branches are `net8.0` (LTS, supported through November 2026), `net10.0` (LTS, supported through November 2028), and the in-development `net11.0` previews.

Change the project file, restore, and republish:

```xml
<!-- MyApp.csproj, .NET SDK 10.0.x -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

```bash
dotnet restore
dotnet publish -c Release -r linux-x64 --self-contained false -o ./out
```

`runtimeconfig.json` now declares `version: 10.0.0`, and a host with `Microsoft.NETCore.App 10.0.0` installed launches it without complaint. This is the only fix that also eliminates the `MissingMethodException` variant, because the app is now compiled against the same reference assemblies as the runtime it will run on.

If the project depends on a package that has not shipped a `net10.0` build, you usually have two outs: bump the package version, or set `<TargetFrameworks>net6.0;net10.0</TargetFrameworks>` and ship the multi-targeted output. The host on the new server picks `net10.0`, the legacy host on the old server picks `net6.0`, and both keep working until you fully retire the 6.x boxes.

## Fix two, low-friction: roll forward to a newer runtime

When retargeting is blocked (vendor binary you cannot recompile, slow release train, legal review on every assembly), force the .NET 6 binary to start on a newer runtime by changing its `rollForward` policy. There are two places to set it.

In the project before publish:

```xml
<!-- MyApp.csproj, still net6.0 -->
<PropertyGroup>
  <TargetFramework>net6.0</TargetFramework>
  <RollForward>Major</RollForward>
</PropertyGroup>
```

Or on the already-published artifact, by editing `MyApp.runtimeconfig.json` next to the binary:

```json
{
  "runtimeOptions": {
    "tfm": "net6.0",
    "rollForward": "Major",
    "framework": {
      "name": "Microsoft.NETCore.App",
      "version": "6.0.0"
    }
  }
}
```

Or without touching the file, by setting the environment variable for one launch:

```bash
DOTNET_ROLL_FORWARD=Major ./out/MyApp
```

`Major` accepts any newer major version. `LatestMajor` does the same but always picks the highest installed major, which is what production fleets that span multiple runtime majors usually want. Restart the process and the launch error is gone.

Roll-forward is the fix that produces `MissingMethodException` later. If any package in your dependency graph compiled against the .NET 6 reference assemblies and called a method that was removed or renamed in .NET 8 or .NET 10, the JIT discovers it the first time that code path runs. There is no workaround for that case other than updating the offending package or going back to fix one.

## Fix three, last resort: install the .NET 6 runtime

When the box must keep an unsupported runtime, install it explicitly. Microsoft still hosts the .NET 6 runtime downloads, marked end-of-life, at the same URL the launch error linked to.

On Debian and Ubuntu, the package is `dotnet-runtime-6.0`:

```bash
sudo apt-get install -y dotnet-runtime-6.0
dotnet --list-runtimes
# Microsoft.NETCore.App 6.0.36 [/usr/share/dotnet/shared/Microsoft.NETCore.App]
# Microsoft.NETCore.App 8.0.15 [...]
# Microsoft.NETCore.App 10.0.0 [...]
```

On Windows, install via `winget install Microsoft.DotNet.Runtime.6` or the standalone MSI. On a Docker image, change `FROM mcr.microsoft.com/dotnet/aspnet:8.0` back to `FROM mcr.microsoft.com/dotnet/aspnet:6.0` or use the multi-version image at `mcr.microsoft.com/dotnet/runtime-deps:6.0` with an explicit `dotnet-runtime-6.0` install layer.

Set `dotnet-runtime-6.0` to hold so the next unattended upgrade does not remove it again:

```bash
sudo apt-mark hold dotnet-runtime-6.0
```

This is a stay-of-execution, not a fix. The runtime no longer receives security patches, so any CVE in `System.Net.Http` or `System.Text.Json` 6.x stays unpatched on that host. Treat it as a deadline extension while you complete fix one.

## Fix four, isolation: publish self-contained

If you control the build but not the deploy target, ship the runtime inside the artifact. A self-contained publish puts `Microsoft.NETCore.App` files next to your DLLs and the host never asks the system for a runtime.

```bash
dotnet publish -c Release -r linux-x64 \
  --self-contained true \
  -p:PublishSingleFile=true \
  -p:PublishTrimmed=false \
  -o ./out
```

The output grows by about 70 MB and there is no need to install anything on the deploy box. This works for `net6.0` too, but the SDK that builds it has to still resolve the `net6.0` ref pack; .NET SDK 10.0.x can still target `net6.0` as of writing, so the build is fine on a fresh SDK.

Self-contained is the right answer for one-off tools, CI scripts, sidecars, and anywhere you cannot dictate the host environment. It is the wrong answer for fleets where shared runtime patching is part of the security posture, because each app now owns its own copy of `System.Net.Http` and has to be rebuilt every time a CVE drops.

## Diagnose before you fix

The host has a verbose mode that prints exactly what it is searching for and where. Set `COREHOST_TRACE=1` (and optionally `COREHOST_TRACEFILE=/tmp/host.log`) and rerun the failing binary:

```bash
COREHOST_TRACE=1 COREHOST_TRACEFILE=/tmp/host.log ./out/MyApp
grep -E "version|framework|rollForward" /tmp/host.log
```

The log lists every framework version the host considered, which `rollForward` policy was applied, and which paths were probed. If the log says it found 8.0.15 but rejected it because `rollForward=LatestPatch` was set, you know to flip the policy. If the log says it found nothing under `/usr/share/dotnet/shared/Microsoft.NETCore.App`, you know to install or relocate.

For the `MissingMethodException` shape, the stack trace names the assembly that bound to the wrong method. Open the published folder, run `dotnet --info` against the host to confirm the runtime version, and inspect the offending DLL with `ildasm` or `dotnet-ildasm` to confirm it references a 6.0 reference assembly. Replace the package with one that has a `net8.0` or `net10.0` build, or use binding redirects via `<AssemblyLoadContext>` if you must keep both.

## Gotchas and lookalikes

The `framework_version` parameter in the URL is **not** the runtime version installed; it is the floor the app asked for. Searching for "install .NET 6.0.0" specifically is a dead end, because the patch shipped is something like 6.0.36. Install the latest 6.0.x, not 6.0.0.

A `MissingMethodException` on `Microsoft.AspNetCore.App` rather than `Microsoft.NETCore.App` follows the same logic, but it points at the ASP.NET Core shared framework. Same fix paths, same `rollForward` knob, different shared framework name in the .deps.json.

`dotnet --info` lists SDKs and runtimes. The runtime your app uses is the one listed under "Microsoft.NETCore.App". If only "Microsoft.AspNetCore.App 6.0.x" is installed, ASP.NET Core apps will boot but console apps still report the original error, because the ASP.NET shared framework depends on the .NET runtime but is not the same install.

On Windows, the apphost is `MyApp.exe`, not `dotnet.exe`. The error message is identical, the troubleshooting is identical, and `where dotnet` answers the wrong question. Use `MyApp.exe --info` to confirm which host is running.

If the binary launches from inside an Azure App Service or Functions host, the platform sets the runtime path for you. The fix is the App Service configuration "Stack" version, not the local file. The related variant for App Service is covered in [The specified version of Microsoft.NetCore.App or Microsoft.AspNetCore.App was not found](/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) which walks the same root cause with the Azure portal in front.

## Related

- [Fix: Could not load file or assembly in a published app](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) when the host found the runtime but a project DLL is missing from the publish folder.
- [Azure App Service: Microsoft.NetCore.App not found](/2020/12/azure-the-specified-version-of-microsoft-netcore-app-or-microsoft-aspnetcore-app-was-not-found/) for the same root cause when the platform owns the host.
- [Fix: The command 'dotnet' could not be found on CI](/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/) when the runtime is not even on the PATH.
- [Fix: The type or namespace name could not be found after a ProjectReference](/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/) when retargeting introduces a `NU1201` TargetFramework mismatch.
- [Fix: PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) for the related class of runtime-host errors that surface only after publish.

## Sources

- [.NET 6 end of support announcement](https://learn.microsoft.com/en-us/lifecycle/announcements/dotnet-6-end-of-support) and the .NET release schedule for what is still patched.
- [Framework-dependent apps roll forward](https://learn.microsoft.com/en-us/dotnet/core/versions/selection#framework-dependent-apps-roll-forward) for the full `rollForward` policy table.
- [Self-contained deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/) for the `--self-contained` publish flow.
- [.NET runtime configuration settings](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/) for the full `runtimeconfig.json` schema.
- [dotnet/runtime issue #79286](https://github.com/dotnet/runtime/issues/79286) for the canonical thread on the host's framework resolution logic and the trace flag.
