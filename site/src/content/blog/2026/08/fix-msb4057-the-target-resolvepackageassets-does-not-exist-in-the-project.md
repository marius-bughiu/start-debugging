---
title: "Fix: MSB4057 The target \"ResolvePackageAssets\" does not exist in the project in .NET MAUI"
description: "MSB4057 means a target ran against the outer cross-targeting build of a multi-targeted MAUI project. Pass a TFM, or guard the target with a TargetFramework condition."
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "dotnet-maui"
  - "msbuild"
  - "dotnet-10"
---

`ResolvePackageAssets` is not missing and your packages are not broken. The target ran against the **outer (cross-targeting) build** of a multi-targeted project, and the .NET SDK does not import `ResolvePackageAssets` there. Either pin a single framework (`dotnet build -f net10.0-android -t:ResolvePackageAssets`), or, if a NuGet package's `.targets` file is calling it, guard that target with `Condition="'$(TargetFramework)' != ''"` so it only runs in the inner builds. Deleting `bin` and `obj` will not help.

Everything below is verified on .NET SDK 10.0.201 (MSBuild 18.3.0) with the `maui-android` / `maui-ios` / `maui-maccatalyst` 10.0.20 workloads. The cross-targeting mechanism is unchanged in .NET 11.

## The error in context

```text
C:\src\MauiApp1\MauiApp1.csproj : error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

Build FAILED.
    0 Warning(s)
    1 Error(s)
```

When a NuGet package is the trigger, the error carries a file and column instead of the project path, which is the tell that a `.targets` file, not you, asked for it:

```text
C:\Users\me\.nuget\packages\ikvm.maven.sdk\1.9.2\buildTransitive\IKVM.Maven.Sdk.targets(37,64):
  error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

## Why MSB4057 fires on a multi-targeted project

A MAUI app has `TargetFrameworks` (plural):

```xml
<!-- .NET 10, MAUI 10 app csproj, from dotnet new maui -->
<TargetFrameworks>net10.0-android</TargetFrameworks>
<TargetFrameworks Condition="!$([MSBuild]::IsOSPlatform('linux'))">$(TargetFrameworks);net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
<TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net10.0-windows10.0.19041.0</TargetFrameworks>
```

MSBuild builds that project **twice over**: one outer pass that does nothing but fan out, and one inner pass per framework. The SDK decides which one you are in with a single property, set in `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets`:

```xml
<!-- .NET SDK 10.0.201, Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets -->
<PropertyGroup Condition="'$(TargetFrameworks)' != '' and '$(TargetFramework)' == ''">
  <IsCrossTargetingBuild>true</IsCrossTargetingBuild>
</PropertyGroup>

<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.CrossTargeting.targets"
        Condition="'$(IsCrossTargetingBuild)' == 'true'"/>
<Import Project="$(MSBuildThisFileDirectory)..\targets\Microsoft.NET.Sdk.targets"
        Condition="'$(IsCrossTargetingBuild)' != 'true'"/>
```

That last pair is the whole story. `ResolvePackageAssets` is defined in `Microsoft.PackageDependencyResolution.targets`, which is imported by `Microsoft.NET.Sdk.targets`, which is imported **only when `IsCrossTargetingBuild` is not true**. In the outer build you get `Microsoft.NET.Sdk.CrossTargeting.targets` instead, and the complete set of targets available to you shrinks to this:

- From `Microsoft.Common.CrossTargeting.targets`: `Build`, `Clean`, `Rebuild`, `DispatchToInnerBuilds`, `GetTargetFrameworks`, `GetTargetFrameworksWithPlatformFromInnerBuilds`, `InitializeSourceControlInformation`
- From `Microsoft.NET.Sdk.CrossTargeting.targets`: `Publish`, `GetAllRuntimeIdentifiers`, `GetPackagingOutputs`
- From `Microsoft.NET.Sdk.Workloads.CrossTargeting.targets`: `_GetRequiredWorkloads`

Ask for anything outside that list against the outer build and MSBuild raises MSB4057. `ResolvePackageAssets`, `GetTargetPath`, `GetCopyToOutputDirectoryItems`, `ComputeFilesToPublish` are all outside it. This is also why the same error text shows up as `The target "GetTargetPath" does not exist in the project` when the .NET Aspire AppHost tries to orchestrate a MAUI project: same mechanism, different target name.

## Minimal repro

You do not need MAUI to see it. Any project with plural `TargetFrameworks` behaves identically, which makes this a two-file repro:

```xml
<!-- MultiLib/MultiLib.csproj, .NET SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFrameworks>net10.0;net9.0</TargetFrameworks>
  </PropertyGroup>
</Project>
```

```bash
# .NET SDK 10.0.201
# outer build: no -f, so TargetFramework is empty
dotnet build -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.

# inner build: -f selects one framework
dotnet build -t:ResolvePackageAssets -f net10.0
# Build succeeded.
```

The same two commands against a stock `dotnet new maui` app fail and succeed the same way, with `-f net10.0-android`.

## How do I confirm I am in an outer build?

Before you start editing project files, prove which build you are in. The `-getProperty` switch evaluates the project without building it, so it is instant even on a MAUI app:

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:IsCrossTargetingBuild -getProperty:TargetFramework
```

On a MAUI app with no framework selected:

```json
{
  "Properties": {
    "IsCrossTargetingBuild": "true",
    "TargetFramework": ""
  }
}
```

`IsCrossTargetingBuild: true` confirms MSB4057 is the cross-targeting problem and not a typo. Add `-p:TargetFramework=net10.0-android` and the same command returns an empty `IsCrossTargetingBuild`, which means the inner build has the full SDK target set. To see the frameworks you can choose from, ask for them directly:

```bash
# .NET SDK 10.0.201
dotnet msbuild -getProperty:TargetFrameworks
# net10.0-android;net10.0-ios;net10.0-maccatalyst;net10.0-windows10.0.19041.0
```

If `IsCrossTargetingBuild` comes back empty and you still get MSB4057, skip ahead to the non-SDK-style project section: that is a different root cause with the same error code.

## How do I stop a NuGet package's .targets file from breaking the outer build?

This is the fix for the overwhelming majority of MAUI reports, because it is the one you hit without asking for any target by name. A NuGet package (or your own `Directory.Build.targets`) hooks `AfterTargets="Build"` and declares a dependency on `ResolvePackageAssets`. In the inner builds that is fine. Then the outer `Build` target runs, `AfterTargets="Build"` fires again, and the dependency does not resolve:

```xml
<!-- Directory.Build.targets, broken on a multi-targeted project -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

A plain `dotnet build` against `MultiLib` above produces exactly this, and the ordering is the giveaway:

```text
ran for TF=[net9.0]
ran for TF=[net10.0]
Directory.Build.targets(4,11): error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
Build FAILED.
```

Both inner builds succeeded, then the outer pass failed. If your build log shows per-framework work completing and *then* MSB4057, this is your case. Add the guard:

```xml
<!-- Directory.Build.targets, fixed. .NET SDK 10.0.201 -->
<Project>
  <Target Name="MyPackageCopyJars"
          AfterTargets="Build"
          DependsOnTargets="ResolvePackageAssets"
          Condition="'$(TargetFramework)' != ''">
    <Message Importance="high" Text="ran for TF=[$(TargetFramework)]" />
  </Target>
</Project>
```

Now the same build reports `ran for TF=[net9.0]`, `ran for TF=[net10.0]`, `Build succeeded.` The condition is the canonical SDK idiom for "inner build only", and it is what the package should have shipped. If the offending target lives inside a package under `~/.nuget/packages/<id>/<ver>/build*/`, do not edit it in place: the next restore overwrites your change. File the bug upstream and disable the import locally in the meantime.

## How do I invoke a single target from the CLI?

If you are the one typing `-t:`, name a framework:

```bash
# .NET SDK 10.0.201, MAUI 10
dotnet build -t:ResolvePackageAssets -f net10.0-android
```

This matters for scripts and CI steps that call individual targets to inspect a build. `dotnet build` and `dotnet publish` with no `-t:` are safe on their own, because `Build` and `Publish` both exist in the cross-targeting set and know how to fan out.

## How do I call a target on another project with the MSBuild task?

When one project drives a target on another (custom tooling, an SDK's orchestration targets, a packaging step), the `MSBuild` task inherits the same rule. This fails:

```xml
<!-- broken: no framework selected on the callee -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj" Targets="GetTargetPath">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

```text
MultiLib.csproj : error MSB4057: The target "GetTargetPath" does not exist in the project.
```

Set the property on the call and it resolves:

```xml
<!-- fixed. .NET SDK 10.0.201 -->
<Target Name="ProbeRef" AfterTargets="Build">
  <MSBuild Projects="..\MultiLib\MultiLib.csproj"
           Targets="GetTargetPath"
           Properties="TargetFramework=net10.0">
    <Output TaskParameter="TargetOutputs" ItemName="_Probed" />
  </MSBuild>
</Target>
```

If you do not want to hardcode a framework, call `GetTargetFrameworks` first (it exists in the outer build, which is precisely what it is for), then loop over the result.

## Do I need to change a ProjectReference to a multi-targeted project?

An ordinary `ProjectReference` to a multi-targeted project does **not** produce MSB4057. MSBuild negotiates a compatible framework automatically, and a `net10.0` console app referencing the `net10.0;net9.0` library above builds clean. You only need to intervene when negotiation cannot pick a winner, which is common when a test or tooling project references a MAUI app head. Use `SetTargetFramework`:

```xml
<!-- .NET SDK 10.0.201 -->
<ItemGroup>
  <ProjectReference Include="..\MultiLib\MultiLib.csproj"
                    SetTargetFramework="TargetFramework=net9.0" />
</ItemGroup>
```

That forces the reference to a single inner build, and `MultiLib.dll` lands in the consumer's output directory as expected. If instead of MSB4057 you see `NETSDK1005: Assets file doesn't have a target for ...`, that is negotiation failing rather than a missing target, and `SetTargetFramework` is still the fix.

## What if the project is not SDK-style at all?

There is a second, unrelated route to the same error code. A legacy `.csproj` that imports `Microsoft.CSharp.targets` directly never imports the .NET SDK targets, so `ResolvePackageAssets` does not exist in **any** pass:

```xml
<!-- legacy non-SDK csproj -->
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>
  </PropertyGroup>
  <Import Project="$(MSBuildToolsPath)\Microsoft.CSharp.targets" />
</Project>
```

```bash
# .NET SDK 10.0.201
dotnet msbuild -t:ResolvePackageAssets
# error MSB4057: The target "ResolvePackageAssets" does not exist in the project.
```

This is what bites people who add an SDK-aware NuGet package (IKVM.Maven.SDK is the recurring example) to an old class library, or who keep a Xamarin-era binding project in a MAUI solution. `IsCrossTargetingBuild` is empty here, so the diagnostic above tells the two cases apart in one command. The fix is to convert the project to SDK style, or to stop referencing packages that assume SDK targets. Migrating those leftovers is usually the right call anyway if you are already moving from Xamarin.Forms 5.0 to .NET MAUI 11.

## Gotchas and lookalikes that land on this page by mistake

**MSB4018: The "ResolvePackageAssets" task failed unexpectedly.** Different error, different cause. The target exists and *ran*; the task threw. That is usually a corrupt `project.assets.json` or an unreadable package in the global cache, and it is the one case where deleting `obj/` and re-running `dotnet restore` genuinely helps.

**"The ResolvePackageAssets task was not given a value for the required parameter TargetFramework."** Also an inner/outer confusion, but it means the target was reached with an empty `TargetFramework` rather than not found. Same fix: select a framework.

**MSB4057 from `dotnet ef` on .NET 10.** Tracked as a `dotnet-ef` 10 tooling regression in [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230), fixed for the 10.0.2 milestone. If you hit it, pin the tool rather than reshaping your project:

```bash
# workaround for the dotnet-ef 10 regression
dotnet tool update --global dotnet-ef --version 9.0.10
```

**MSB4057 naming a target you wrote yourself.** Then it really is a missing or misspelled target, which is the case [MSB4057 in the MSBuild docs](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057) describes. Check `BeforeTargets`, `AfterTargets`, `DependsOnTargets`, and `CallTarget` spellings, and check that no `Condition` on the target definition excluded it.

**Aspire orchestration of a MAUI head.** [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043) is the same outer-build problem surfacing as `The target "GetTargetPath" does not exist`. There is no clean fix from your side: a MAUI app is not a servable Aspire resource, so remove it from the AppHost and reference a shared single-targeted class library instead.

## Which targets belong in the inner build?

Anything that reaches into a project for compiler inputs, package assets, or output paths belongs in the inner build. If a target of yours touches `ResolvePackageAssets`, `@(ReferencePath)`, or `$(TargetPath)`, it needs `Condition="'$(TargetFramework)' != ''"`. That single line prevents most of the MSB4057 reports in MAUI repos, and it costs nothing on single-targeted projects, where `TargetFramework` is always set.

For related build failures on the same stack, see the write-ups on [why MSB3027 reports it could not copy a file after ten retries](/2026/05/fix-msbuild-msb3027-could-not-copy-exceeded-retry-count/), [what to check when a Gradle build fails to produce an .apk in MAUI Android](/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/), [resolving a type or namespace error after adding a project reference](/2026/05/fix-the-type-or-namespace-name-could-not-be-found-after-project-reference/), and [the full Xamarin.Forms to .NET MAUI 11 migration checklist](/2026/05/migrate-from-xamarin-forms-to-maui-11/).

## Sources

- [MSB4057 diagnostic code](https://learn.microsoft.com/en-us/visualstudio/msbuild/errors/msb4057), MSBuild docs
- `Sdks/Microsoft.NET.Sdk/Sdk/Sdk.targets` and `Microsoft.Common.CrossTargeting.targets`, .NET SDK 10.0.201
- [ikvmnet/ikvm-maven#76](https://github.com/ikvmnet/ikvm-maven/issues/76), MSB4057 from a package `.targets` file on a non-SDK project
- [microsoft/aspire#3043](https://github.com/microsoft/aspire/issues/3043), the `GetTargetPath` variant on a MAUI head
- [dotnet/efcore#37230](https://github.com/dotnet/efcore/issues/37230), the `dotnet-ef` 10 regression
