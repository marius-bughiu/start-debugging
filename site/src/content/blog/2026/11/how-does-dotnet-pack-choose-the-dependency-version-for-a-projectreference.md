---
title: "How does dotnet pack choose the dependency version for a ProjectReference?"
description: "dotnet pack turns every ProjectReference into a NuGet dependency whose minimum version is the referenced project's PackageVersion, or 1.0.0 when it has none. Here is the MSBuild target that computes it, what changes it, and how to emit an exact or capped range."
pubDate: 2026-11-26
tags:
  - "nuget"
  - "msbuild"
  - "dotnet"
  - "dotnet-11"
  - "dotnet-cli"
---

When you run `dotnet pack` on a project that has a `<ProjectReference>`, NuGet writes that reference into the `.nuspec` as a package dependency. The version is the referenced project's `$(PackageVersion)`, evaluated at pack time, which defaults to `$(Version)` and falls back to the literal `1.0.0` when nothing is set. It is written as a minimum-only range (`version="2.3.4"` means `>= 2.3.4`), and there is no supported `ProjectReference` metadata for an exact or capped range. You can still get one by changing the referenced project's `PackageVersion`, or by rewriting the internal item NuGet uses, as shown below. Every result in this post comes from packing a two-project solution with .NET SDK 11.0.100 on macOS 27 (arm64) and reading the generated `.nuspec`.

That is the short answer. The longer one matters because the "evaluated at pack time" part has consequences: global `-p:` properties leak into the dependency, a version stamped by a custom target may or may not be seen depending on `--no-build`, and the package ID comes from a different place than the version.

## The target that does the work

Pack logic ships inside the SDK as `NuGet.Build.Tasks.Pack.targets`. On SDK 11.0.100 it lives at `sdk/11.0.100/NuGet.Build.Tasks.Pack.targets`, and two targets answer the question. The first one, `_GetProjectReferenceVersions`, reads the project references out of `project.assets.json` and asks each referenced project for its version:

```xml
<!-- .NET SDK 11.0.100, NuGet.Build.Tasks.Pack.targets (abridged) -->
<Target Name="_GetProjectReferenceVersions"
        Condition="'$(NuspecFile)' == ''"
        DependsOnTargets="_GetAbsoluteOutputPathsForPack;$(GetPackageVersionDependsOn)">
  <GetProjectReferencesFromAssetsFileTask ...>
    <Output TaskParameter="ProjectReferences" ItemName="_ProjectReferencesFromAssetsFile" />
  </GetProjectReferencesFromAssetsFileTask>

  <MSBuild Projects="@(_ProjectReferencesFromAssetsFile)"
           Targets="_GetProjectVersion"
           SkipNonexistentTargets="true"
           SkipNonexistentProjects="true">
    <Output TaskParameter="TargetOutputs" ItemName="_ProjectReferencesWithVersions" />
  </MSBuild>
</Target>
```

The second one runs inside the referenced project:

```xml
<Target Name="_GetProjectVersion" DependsOnTargets="$(GetPackageVersionDependsOn)"
        Returns="@(_ProjectReferenceWithVersion)">
  <ItemGroup>
    <_ProjectReferenceWithVersion Include="$(MSBuildProjectFullPath)">
      <ProjectVersion Condition="'$(PackageVersion)' != ''">$(PackageVersion)</ProjectVersion>
      <ProjectVersion Condition="'$(PackageVersion)' == ''">1.0.0</ProjectVersion>
    </_ProjectReferenceWithVersion>
  </ItemGroup>
</Target>
```

The same file defaults `PackageVersion` to `$(Version)` when it is empty, and the .NET SDK builds `Version` from `VersionPrefix` and `VersionSuffix`. So the chain is `PackageVersion`, then `Version`, then `VersionPrefix[-VersionSuffix]`, then `1.0.0`.

On the C# side, `PackTaskLogic` in [NuGet.Client](https://github.com/NuGet/NuGet.Client/blob/dev/src/NuGet.Core/NuGet.Build.Tasks.Pack/PackTaskLogic.cs) turns the result into a dependency. It starts with the version recorded in the assets file and replaces it with the pack-time value when one exists:

```csharp
// NuGet.Client, PackTaskLogic.cs (dev branch, abridged)
var versionToUse = new VersionRange(targetLibrary.Version);

// Use the project reference version obtained at build time if it exists,
// otherwise fallback to the one in assets file.
if (projectRefToVersionMap.TryGetValue(projectReference.ProjectPath, out var projectRefVersion))
{
    versionToUse = VersionRange.Parse(projectRefVersion, allowFloating: false);
}
```

Two details in that snippet drive everything later in this post. `new VersionRange(version)` creates a minimum-inclusive range with no upper bound, which is why the nuspec says `version="2.3.4"` and not `[2.3.4]`. And the pack-time string goes through `VersionRange.Parse`, so it does not have to be a plain version: any range syntax NuGet understands is accepted, except floating ones.

## A minimal repro you can poke at

Two class libraries, `App` references `Lib`:

```xml
<!-- src/Lib/Lib.csproj, .NET SDK 11.0.100 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Version>2.3.4</Version>
  </PropertyGroup>
</Project>
```

```xml
<!-- src/App/App.csproj, .NET SDK 11.0.100 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Version>1.0.0</Version>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Lib/Lib.csproj" />
  </ItemGroup>
</Project>
```

Pack `App` and print the dependency lines from the nuspec inside the `.nupkg`:

```bash
dotnet pack src/App -o out
unzip -p out/App.1.0.0.nupkg '*.nuspec' | grep '<dependency '
```

```xml
<dependency id="Lib" version="2.3.4" exclude="Build,Analyzers" />
```

`exclude="Build,Analyzers"` is the default `PrivateAssets` for a reference, the same thing you get from a `PackageReference`. Now change `Lib.csproj` one variable at a time. These are the results from SDK 11.0.100:

| Setting in `Lib.csproj` or on the command line | Dependency written into `App.nuspec` |
| --- | --- |
| No version properties at all | `version="1.0.0"` |
| `<Version>2.3.4</Version>` | `version="2.3.4"` |
| `<VersionPrefix>2.3.4</VersionPrefix><VersionSuffix>beta.1</VersionSuffix>` | `version="2.3.4-beta.1"` plus warning NU5104 |
| `<Version>2.3.4</Version><PackageVersion>5.0.0</PackageVersion>` | `version="5.0.0"` |
| `<PackageId>Contoso.Lib</PackageId>` | `id="Contoso.Lib"` |
| `<IsPackable>false</IsPackable>`, no version | `id="Lib" version="1.0.0"`, no warning |
| `dotnet pack src/App -p:Version=9.9.9` | `App.9.9.9.nupkg` depending on `Lib 9.9.9` |
| `dotnet pack src/App --version-suffix rc.2` with `VersionPrefix` 2.3.4 in Lib | `version="2.3.4-rc.2"` plus NU5104 |

The `1.0.0` row is the one that bites people. A library with no version properties produces a perfectly valid package that depends on `Lib >= 1.0.0`, and if you never publish `Lib` at all, consumers get an NU1101 or NU1102 restore failure that has nothing to do with their own code.

The `IsPackable` row is the same trap in a different shape. `IsPackable=false` stops `Lib` from producing a `.nupkg`, but it does not stop `App` from declaring a dependency on it. Pack prints no warning. If `Lib` is supposed to be internal, see the `PrivateAssets` section below.

## Global properties flow into the referenced project

The two command-line rows deserve a closer look. `-p:Version=9.9.9` is a global property, and MSBuild passes global properties to every project it touches through the `<MSBuild>` task, including the `_GetProjectVersion` call. So the property versions `App` and also overrides whatever `Lib.csproj` says. That is convenient when you version a whole repo in lockstep and wrong when you do not.

`--version-suffix rc.2` is the sneakier one. It sets `VersionSuffix` globally. In the repro, `App` has an explicit `<Version>1.0.0</Version>`, which wins over `VersionPrefix` and `VersionSuffix`, so `App` stays stable at 1.0.0. `Lib` uses `VersionPrefix`, so it picks up the suffix. The result is a stable package depending on a prerelease, and NuGet warns:

```text
warning NU5104: A stable release of a package should not have a prerelease dependency.
Either modify the version spec of dependency "Lib [2.3.4-rc.2, )" or update the version field in the nuspec.
```

Notice the `[2.3.4-rc.2, )` notation in the warning. That is the internal form of the minimum-only range the nuspec writes as a bare version.

## Versions computed by a target, and why --no-build matters

Tools such as MinVer and Nerdbank.GitVersioning do not hardcode `Version`. They compute it in a target. Whether pack sees the computed value depends on how the target is wired, because `_GetProjectVersion` only runs the targets in `$(GetPackageVersionDependsOn)` before reading `PackageVersion`.

Here is a version-stamping target attached to the build instead:

```xml
<!-- src/Lib/Lib.csproj, .NET SDK 11.0.100 -->
<PropertyGroup>
  <Version>2.3.4</Version>
</PropertyGroup>
<Target Name="StampVersion" BeforeTargets="BeforeBuild">
  <PropertyGroup>
    <Version>7.7.7</Version>
    <PackageVersion>7.7.7</PackageVersion>
  </PropertyGroup>
</Target>
```

Results:

- `dotnet pack src/App`: dependency `Lib 7.7.7`. Pack builds `Lib` first, the target runs in that project instance, and the later `_GetProjectVersion` call reuses the same instance, so it sees the updated property.
- `dotnet build src/App` followed by `dotnet pack src/App --no-build`: dependency `Lib 2.3.4`. Nothing builds `Lib` during pack, `StampVersion` never runs, and the static value wins.

That is a classic "works on my machine, wrong in CI" split, because CI pipelines usually build once and pack with `--no-build`. The fix is to hook the target into the property pack actually calls:

```xml
<!-- src/Lib/Lib.csproj, .NET SDK 11.0.100 -->
<PropertyGroup>
  <Version>2.3.4</Version>
  <GetPackageVersionDependsOn>$(GetPackageVersionDependsOn);StampVersion</GetPackageVersionDependsOn>
</PropertyGroup>
<Target Name="StampVersion">
  <PropertyGroup>
    <Version>7.7.7</Version>
    <PackageVersion>7.7.7</PackageVersion>
  </PropertyGroup>
</Target>
```

With that change both the one-step and the `--no-build` pack produce `Lib 7.7.7`.

MinVer already does this. Its `build/MinVer.targets` (checked in MinVer 8.0.0, the current stable) contains:

```xml
<GetPackageVersionDependsOn>$(GetPackageVersionDependsOn);MinVer</GetPackageVersionDependsOn>
```

So with MinVer on `Lib`, the dependency follows the git tag in both modes. That is also its downside: tag a commit `2.3.4`, add one commit to `Lib`, pack `App`, and the dependency becomes `Lib 2.3.5-alpha.0.1` with an NU5104 warning, a version that was never published. The [MinVer post on releasing several packages from one repo](/2026/05/independently-release-multiple-nuget-packages-with-minver-and-trusted-publishing/) covers that case and pins the dependency to the last released tag.

## The package ID comes from restore, the version from pack

The table shows that `PackageId` is honoured: set `<PackageId>Contoso.Lib</PackageId>` and the dependency becomes `Contoso.Lib`. But it is not read at the same time as the version. The ID is the library name recorded in `project.assets.json` at restore time, while the version is re-evaluated at pack time.

You can see the difference by changing the ID and skipping restore:

```bash
# Lib.csproj: add <PackageId>Contoso.Lib</PackageId> after a previous restore
dotnet pack src/App --no-restore -o out
unzip -p out/App.1.0.0.nupkg '*.nuspec' | grep '<dependency '
```

```xml
<dependency id="Lib" version="2.3.4" exclude="Build,Analyzers" />
```

The ID is stale until the next restore. This matters when the ID is injected by something that runs after restore, which is the scenario in [NuGet/Home#12544](https://github.com/NuGet/Home/issues/12544), still open. Keep `PackageId` as a static property in the project file or in `Directory.Build.props`, and do not pack with `--no-restore` right after renaming a package.

## Emitting an exact or capped range

The second half of the Stack Overflow question is whether the consuming project can write something like `Version="14.0.1-beta2"` on the reference. There is no such metadata. `ProjectReference` supports `IncludeAssets`, `ExcludeAssets` and `PrivateAssets` for packing, as the [NuGet pack and restore targets docs](https://learn.microsoft.com/nuget/reference/msbuild-targets#project-to-project-references) list, and the request for an upper bound, [NuGet/Home#5556](https://github.com/NuGet/Home/issues/5556), has been open since July 2017. You have three working options.

### Option 1: control the referenced project's PackageVersion

If you only need a different single version, change it where pack reads it. The accepted answer on [Stack Overflow](https://stackoverflow.com/questions/80014046) suggests a conditional property in the referenced project:

```xml
<!-- src/Lib/Lib.csproj -->
<PropertyGroup Condition="'$(LibPackageVersion)' != ''">
  <PackageVersion>$(LibPackageVersion)</PackageVersion>
</PropertyGroup>
```

```bash
dotnet pack src/App -p:LibPackageVersion=2.3.0
```

Because `LibPackageVersion` is a global property it reaches `Lib`, and only `Lib` reads it. This still gives you a minimum-only range.

### Option 2: rewrite the version pack computed

Since `PackTaskLogic` passes the string through `VersionRange.Parse`, you can put a range into the `ProjectVersion` metadata after `_GetProjectReferenceVersions` fills it. This target lets each `ProjectReference` opt in with a `PackVersion` metadata value of your choosing:

```xml
<!-- src/App/App.csproj, .NET SDK 11.0.100 -->
<ItemGroup>
  <ProjectReference Include="../Lib/Lib.csproj" PackVersion="[2.3.0, 3.0.0)" />
  <ProjectReference Include="../Other/Other.csproj" />
</ItemGroup>

<!-- _ProjectReferencesWithVersions is an internal NuGet item.
     Re-test this target whenever you upgrade the SDK. -->
<Target Name="ApplyPackVersionOverrides" AfterTargets="_GetProjectReferenceVersions">
  <ItemGroup>
    <_PackVersionOverride Include="@(ProjectReference->'%(FullPath)')"
                          Condition="'%(ProjectReference.PackVersion)' != ''" />
    <_ProjectReferencesWithVersions Remove="@(_PackVersionOverride)" />
    <_ProjectReferencesWithVersions Include="@(_PackVersionOverride)"
                                    ProjectVersion="%(_PackVersionOverride.PackVersion)" />
  </ItemGroup>
</Target>
```

The item identity is the referenced project's full path, which is why the target transforms `ProjectReference` with `%(FullPath)` before removing and re-adding. Result on SDK 11.0.100, with and without `--no-build`:

```xml
<dependency id="Lib" version="[2.3.0, 3.0.0)" exclude="Build,Analyzers" />
<dependency id="Other" version="1.0.0" exclude="Build,Analyzers" />
```

References without `PackVersion` keep the default behaviour. A few things to know before you adopt it:

- An exact pin is `[2.3.4]`. A blanket "pin every project reference exactly" variant is a one-liner inside the same target: `<_ProjectReferencesWithVersions ProjectVersion="[%(ProjectVersion)]" />`, which produced `version="[2.3.4]"` in the repro.
- Floating versions are rejected. `PackVersion="2.*"` fails the pack with `error : '2.*' is not a valid version string.`, because the parse uses `allowFloating: false`.
- The target relies on an underscore-prefixed item and target name. NuGet does not promise to keep them. It has been stable for years, but treat it as a build customization you own.
- Exact pins between your own packages make every patch of `Lib` force a release of `App`. A capped range like `[2.3.0, 3.0.0)` is usually the better tradeoff if you follow SemVer. If you are unsure what counts as a breaking change across that boundary, the post on [source-breaking vs binary-breaking changes](/2026/10/what-is-the-difference-between-a-source-breaking-and-a-binary-breaking-change-in-a-dotnet-library/) is the checklist to run before raising a major version.

### Option 3: stop treating the reference as a dependency

`PrivateAssets="all"` on the `ProjectReference` removes it from the dependency list entirely. In the repro, the nuspec had no `<dependency>` line for `Lib`. But the resulting package contained only `lib/net11.0/App.dll`, not `Lib.dll`, so a consumer would compile and then throw `FileNotFoundException` at run time. If the goal is to embed `Lib` inside `App`'s package, you have to add `Lib.dll` to the package yourself (for example through `TargetsForTfmSpecificBuildOutput`), because the `dotnet pack` equivalent of `nuget.exe pack -IncludeReferencedProjects` is still the open request [NuGet/Home#3891](https://github.com/NuGet/Home/issues/3891). The NuGet code even carries a `TODO: Implement <TreatAsPackageReference>false</TreatAsPackageReference>` comment pointing at it.

## Gotchas that are easy to miss

- **A `.nuspec` file switches all of this off.** `_GetProjectReferenceVersions` has `Condition="'$(NuspecFile)' == ''"`. When you pack from a hand-written nuspec, the dependencies are whatever that file says.
- **Restore must have run.** The project reference list comes from `project.assets.json`. If the assets file is missing (for example `dotnet pack --no-restore` on a clean checkout), pack fails with `error MSB4018` wrapping `The assets file produced by restore does not exist. Try restoring the project again.` rather than guessing.
- **Central Package Management does not apply.** `Directory.Packages.props` versions `PackageReference` items only. A `ProjectReference` dependency never reads a `PackageVersion` item from it, so [moving a solution to Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) will not change these ranges.
- **Lockstep versioning is the simplest fix.** If all packages in a repo ship together, set `<Version>` once in `Directory.Build.props` or pass `-p:Version=` in CI. Every dependency then matches the version you are publishing, and the ranges are correct by construction.
- **Publish in dependency order.** Whatever range you choose, the referenced package has to exist on the feed when consumers restore. If you use [nuget.org staged publishing](/2026/11/nuget-org-staged-publishing-dotnet-package-stage-push/), stage and release `Lib` before `App`.
- **When in doubt, read the binlog.** `dotnet pack -bl` records the `_GetProjectVersion` call for each reference with the exact `ProjectVersion` it returned. The [binlog MCP server](/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/) can answer "why is this dependency 1.0.0" from that file.

## How this was checked

All results above come from two scratch solutions packed with .NET SDK 11.0.100 on macOS 27.0.1 (arm64): one with only a cleared local `nuget.config` for the static-property cases, one using MinVer 8.0.0 from nuget.org inside a throwaway git repository for the tag-based cases. Each case was packed into an empty output folder and checked with `unzip -p <nupkg> '*.nuspec'`. The target source quoted is the file shipped with that SDK. The `PackTaskLogic` excerpt is from the NuGet.Client `dev` branch, read, not executed separately. Nothing was published to a feed, and no consumer restore was run against the generated packages.

## Sources

- [NuGet pack and restore as MSBuild targets](https://learn.microsoft.com/nuget/reference/msbuild-targets), MS Learn
- [`PackTaskLogic.cs`](https://github.com/NuGet/NuGet.Client/blob/dev/src/NuGet.Core/NuGet.Build.Tasks.Pack/PackTaskLogic.cs), NuGet.Client
- [NuGet/Home#5556: upper limit version for ProjectReference in dotnet pack](https://github.com/NuGet/Home/issues/5556)
- [NuGet/Home#12544: get ProjectReference package ID at pack time](https://github.com/NuGet/Home/issues/12544)
- [NuGet/Home#3891: IncludeReferencedProjects for the pack target](https://github.com/NuGet/Home/issues/3891)
- [Stack Overflow question 80014046](https://stackoverflow.com/questions/80014046)
- [MinVer](https://github.com/adamralph/minver)
