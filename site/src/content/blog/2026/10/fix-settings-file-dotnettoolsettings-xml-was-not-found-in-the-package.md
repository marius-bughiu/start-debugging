---
title: "Fix: Settings file 'DotnetToolSettings.xml' was not found in the package"
description: "The tool package targets a newer .NET than the SDK running the install, or it is not a .NET tool at all. Use a newer SDK, pin a tool version with a compatible tools folder, or force --framework."
pubDate: 2026-10-12
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "dotnet-tools"
  - "ef-core"
---

The package is almost never broken, and clearing the NuGet cache will not help. This message means the SDK running `dotnet tool install` found no `tools/<tfm>/` folder it is allowed to use. The usual cause is a tool built only for a newer .NET than the SDK itself, for example `dotnet-ef` 10.0.0/10.0.1 or 11.0 on SDK 8 or 9. Run `dotnet --version` in the folder where the install fails. Then either move to an SDK at least as new as the tool's target framework, or pin a tool version that ships an older `tools/` folder (`dotnet-ef` 10.0.2 and later ship `net8.0` again). If the package is not a .NET tool at all (`Microsoft.EntityFrameworkCore.Tools`, `Microsoft.EntityFrameworkCore.Design`), install `dotnet-ef` instead. Everything below was reproduced on 2026-10-12 with SDK 8.0.425, 9.0.318, and 10.0.302 on macOS arm64, against live nuget.org.

## The error in context

`dotnet tool install` (global, `--tool-path`, or local) prints this, even on a clean machine where nothing was installed before:

```
Tool 'dotnet-ef' failed to update due to the following:
The settings file in the tool's NuGet package is invalid: Settings file 'DotnetToolSettings.xml' was not found in the package.
Tool 'dotnet-ef' failed to install. Contact the tool author for assistance.
```

"Failed to update" is misleading. It appears on a first install too. `dotnet tool restore` and `dotnet dnx` hit the same code path but do not wrap the exception, so in a repo with a tool manifest you get the raw form instead:

```
Unhandled exception: Settings file 'DotnetToolSettings.xml' was not found in the package.
```

Both forms exit with code 1. Nothing else in the output tells you which framework the SDK was looking for, which is why people end up deleting caches and reinstalling SDKs at random.

## Why this happens

A .NET tool package keeps its payload under `tools/<target framework>/<rid>/`, and `DotnetToolSettings.xml` lives in that folder. The file exists, but only inside a framework folder. The SDK does not search the whole package for it. It builds a synthetic assets file with NuGet's asset-selection rules and asks for the item under the **nearest compatible framework folder**. In the .NET 10 SDK source (`ToolPackageDownloader.CreateAssetFile`), the target framework comes from the runtime the CLI is running on:

```csharp
// dotnet/sdk, release/10.0.3xx: src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs
currentTargetFramework = new NuGetFramework(
    FrameworkConstants.FrameworkIdentifiers.NetCoreApp,
    new Version(Environment.Version.Major, Environment.Version.Minor));
```

SDK 9.0.318 runs on the .NET 9 runtime, so it asks for `net9.0`. A package that only contains `tools/net10.0/any/` has no compatible folder, so the selected item list is empty. `ToolPackageInstance.DeserializeToolConfiguration` then throws `MissingToolSettingsFile`, which is the message you see. In practice the text means "no `tools/` folder targets a framework this SDK can run".

Two consequences surprise people:

1. **Installed runtimes do not count.** I added the .NET 10.0.12 runtime next to SDK 9.0.318 and the plain install of `dotnet-ef` 10.0.1 still failed with the same message. Only the SDK's own runtime version matters.
2. **The package type check comes later, and only in SDK 10.** SDK 10 checks the nuspec's `packageType` first and prints a clear "is not a .NET tool" for non-tool packages. SDK 8 and 9 skip that check and fall through to the same misleading message.

So there are three real causes behind one string, ranked by how often they show up:

- **The tool targets a newer .NET than your SDK.** This is the usual one after a new major release (`dotnet-ef` 10.0.0/10.0.1, `AzureSignTool` 7.0.0, any tool built only for `net10.0` or `net11.0`).
- **The tool is a .NET 10 RID-specific (platform-specific) tool.** Its root package also only has a `tools/net10.0/` folder, so older SDKs fail the same way.
- **The package is not a tool.** It is a library or an MSBuild/PowerShell package, installed with `dotnet tool install` by mistake.

## Minimal repro

These commands use `--tool-path` so nothing touches your global tools folder. Each block shows the SDK version that ran it.

```bash
# SDK 9.0.318 (also identical on SDK 8.0.425)
dotnet tool install dotnet-ef --version 10.0.1 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --version 11.0.0-rc.1.26425.128 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install AzureSignTool --version 7.0.0 --tool-path ./tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.  exit 1

dotnet tool install dotnet-ef --tool-path ./tools
# Tool 'dotnet-ef' (version '10.0.12') was successfully installed.  exit 0
```

The last line matters. Plain `dotnet tool install dotnet-ef` resolves to 10.0.12 today and works on SDK 8 and 9. The failure only appears when a version is pinned, in a `dotnet-tools.json` manifest or a CI script written in November 2025 for example. Here is the `tools/` layout of each `dotnet-ef` version I checked on nuget.org:

| dotnet-ef version | tools folder | Installs on SDK 8 / 9 | Installs on SDK 10 |
|---|---|---|---|
| 8.0.21 | `tools/net8.0/any/` | yes | yes |
| 9.0.10 | `tools/net8.0/any/` | yes | yes |
| 10.0.0, 10.0.1 | `tools/net10.0/any/` | **no** | yes |
| 10.0.2 to 10.0.12 | `tools/net8.0/any/` | yes | yes |
| 11.0.0-rc.1.26425.128 | `tools/net10.0/any/` | **no** | yes |

The same thing happens one major up. I repacked a trivial tool so its only folder was `tools/net11.0/any/`, and SDK 10.0.302 rejected it with the identical message. `dotnet dnx` on SDK 10 printed the "Unhandled exception" form for the same package.

## Fix, in detail

### 1. Check which SDK actually runs in that folder

`global.json` picks the SDK per directory, so the SDK that runs `dotnet tool restore` in your repo may not be the newest one installed:

```bash
# Any SDK. Run in the directory where the install fails.
dotnet --version
dotnet --list-sdks
cat global.json 2>/dev/null
```

If `dotnet --version` prints `8.0.x` or `9.0.x` and the tool targets `net10.0`, that is your answer. On CI the same mismatch comes from a runner image that only has the old SDK, or from `actions/setup-dotnet` reading a `global.json` that pins 8.0. The [CI walkthrough for "the command dotnet could not be found"](/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/) covers how the runner picks its SDK.

### 2. Recommended: run the tool with an SDK at least as new as its target

```json
// global.json, .NET 10 SDK. rollForward keeps you on the newest 10.0 feature band.
{
  "sdk": {
    "version": "10.0.100",
    "rollForward": "latestFeature"
  }
}
```

A .NET 10 SDK builds `net8.0` and `net9.0` projects without any change, so bumping the SDK does not force you to retarget your app. That is the cleanest fix because every other tool in your manifest benefits too. If you are planning the full move anyway, the [.NET 8 to .NET 11 checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) lists the SDK-level breaking changes to expect.

### 3. If you cannot change the SDK: pin a tool version with a compatible folder

For `dotnet-ef`, any 10.0.2 or later build ships `tools/net8.0/` and installs on SDK 8 and 9:

```bash
# SDK 8.0.425 or 9.0.318
dotnet tool install --global dotnet-ef --version 10.0.12
```

```json
// .config/dotnet-tools.json, works with SDK 8, 9 and 10
{
  "version": 1,
  "isRoot": true,
  "tools": {
    "dotnet-ef": { "version": "10.0.12", "commands": [ "dotnet-ef" ], "rollForward": false }
  }
}
```

The tool still needs a runtime it can run on. The `net8.0` build of `dotnet-ef` 10.0.12 ran fine on SDK 8.0.425 with only the .NET 8 runtime installed. For other tools, look inside the package before you pin. The "Frameworks" tab on nuget.org shows it, or you can list the archive directly:

```bash
# Any OS with curl and unzip. Replace the id and version.
curl -sL https://api.nuget.org/v3-flatcontainer/dotnet-ef/10.0.1/dotnet-ef.10.0.1.nupkg -o t.nupkg
unzip -l t.nupkg | grep DotnetToolSettings
#   tools/net10.0/any/DotnetToolSettings.xml
```

If every version you can use only has a newer folder, go back to fix 2.

### 4. Escape hatch: force the framework with `--framework`

`dotnet tool install` and `dotnet tool update` take `--framework`, and that value replaces `Environment.Version` in the asset selection above. If the newer runtime is installed side by side, an old SDK can install a newer portable tool:

```bash
# SDK 9.0.318 with the .NET 10.0.12 runtime installed next to it
dotnet tool install --global dotnet-ef --version 10.0.1 --framework net10.0
# Tool 'dotnet-ef' (version '10.0.1') was successfully installed.
dotnet-ef --version
# 10.0.1
```

Without the .NET 10 runtime the install still "succeeds", but the tool fails on its first run. On SDK 8.0.425 with only .NET 8 present, `dotnet-ef` reported "You must install or update .NET to run this application" and asked for `Microsoft.NETCore.App` 10.0.0. `dotnet tool restore` has no `--framework` option, so this only helps global and `--tool-path` installs. Treat it as a stopgap, not a pipeline fix.

### 5. If the package is not a tool: install the right package

`Microsoft.EntityFrameworkCore.Tools` is the Package Manager Console package for Visual Studio, and `Microsoft.EntityFrameworkCore.Design` is the design-time library your startup project references. Neither is a .NET tool. What each SDK prints depends on the version:

```bash
# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Settings file 'DotnetToolSettings.xml' was not found in the package.

# SDK 8.0.425 and 9.0.318
dotnet tool install --global Microsoft.EntityFrameworkCore.Design
# Unhandled exception: System.IO.DirectoryNotFoundException: Could not find a part
# of the path '.../microsoft.entityframeworkcore.design/10.0.12/tools'.

# SDK 10.0.302
dotnet tool install --global Microsoft.EntityFrameworkCore.Tools
# Package microsoft.entityframeworkcore.tools is not a .NET tool.
```

The CLI tool is `dotnet-ef`. Add `Microsoft.EntityFrameworkCore.Design` to your startup project as a normal `PackageReference`. If `dotnet ef` later complains about that, the fix is in [your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

## Gotchas and lookalike errors

**RID-specific .NET 10 tools hide a better message.** .NET 10 lets authors ship [platform-specific tools](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools): a small root package whose `DotnetToolSettings.xml` uses `Version="2"` and points at per-RID packages. I packed one with `<RuntimeIdentifiers>osx-arm64;linux-x64;win-x64</RuntimeIdentifiers>` on SDK 10.0.302. SDK 8.0.425 and 9.0.318 both rejected it with the generic "was not found" text, because the root package only has a `net10.0` folder. Microsoft backported a clearer error to SDK 8.0.21 ([dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414)), but you only reach it once the folder resolves. With `--framework net10.0`, SDK 9.0.318 printed "Format version is higher than supported. This tool may not be supported in this SDK version. Update your SDK." `--framework` cannot rescue a RID-specific tool. The only fix is a .NET 10 SDK.

**Clearing caches does not fix this.** `dotnet nuget locals all --clear` is the most common advice for this message. It cannot help in any of the three cases above, because the package was downloaded correctly. The file is in the package, just not in a folder your SDK selects. A truncated download is possible in theory, but it is far down the list. Check `dotnet --version` and the package's `tools/` folder before you reach for the cache.

**"Tool 'dotnet-ef' is already installed", "is not found in NuGet feeds" and shim conflicts are different failures** with different flags. All six are covered in [every way dotnet tool install --global dotnet-ef fails](/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/).

**The install worked but `dotnet ef` is "not found".** That is a `PATH` problem, not a package problem. See [fixing "dotnet ef" not found](/2023/06/how-to-fix-command-dotnet-ef-not-found/).

**Tool authors can avoid this for their users.** Multi-target the tool (`<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` with `<PackAsTool>true</PackAsTool>`) so older SDKs find a folder they can run, as `dotnet-ef` did from 10.0.2 on. For RID-specific tools, Andrew Lock documents a compromise root package that also carries a framework-dependent build for old SDKs. The SDK team agrees the message is unhelpful. [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172) and [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878) are both still open as of this writing.

## Related

- [Fix: dotnet tool install --global dotnet-ef throws an error](/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/), for the other install failures and the runtime mismatch that only shows after a successful install.
- [How to fix "dotnet ef" not found](/2023/06/how-to-fix-command-dotnet-ef-not-found/), for the `PATH` side of the same tool.
- [Fix: the command dotnet could not be found on CI](/2026/05/fix-the-command-dotnet-could-not-be-found-on-ci/), for how CI runners choose and expose an SDK.
- [Fix: your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/), for the package people try to install as a tool by mistake.
- [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), if the SDK bump is part of a larger upgrade.

## Sources

- [dotnet/sdk `ToolPackageDownloader.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageDownloader.cs) and [`ToolPackageInstance.cs`](https://github.com/dotnet/sdk/blob/release/10.0.3xx/src/Cli/dotnet/ToolPackage/ToolPackageInstance.cs), for the framework selection and the `MissingToolSettingsFile` throw.
- [dotnet/sdk#38172](https://github.com/dotnet/sdk/issues/38172), "Installing a tool that targets a framework not installed gives a non-actionable error message".
- [dotnet/sdk#51878](https://github.com/dotnet/sdk/issues/51878), the `AzureSignTool` 7.0.0 report and the explanation that the regression dates from .NET 7, when tool downloads stopped going through restore.
- [dotnet/sdk#50414](https://github.com/dotnet/sdk/pull/50414), the 8.0.4xx backport of the "Format version is higher than supported" error.
- [Create RID-specific, self-contained, and AOT .NET tools](https://learn.microsoft.com/en-us/dotnet/core/tools/rid-specific-tools) on Microsoft Learn.
- [dotnet tool install](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-tool-install), for `--framework`, `--tool-path`, and manifest behavior.
- Andrew Lock, [Supporting platform-specific .NET tools on old SDKs](https://andrewlock.net/exploring-dotnet-10-preview-features-8-supporting-platform-specific-dotnet-tools-on-old-sdks/), for the version 1 vs version 2 `DotnetToolSettings.xml` schemas.
