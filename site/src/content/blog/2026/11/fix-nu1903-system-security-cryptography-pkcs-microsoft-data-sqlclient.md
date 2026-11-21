---
title: "Fix: warning NU1903 Package 'System.Security.Cryptography.Pkcs' 9.0.18 has a known high severity vulnerability (Microsoft.Data.SqlClient 7.1.1)"
description: "Microsoft.Data.SqlClient 7.1.1 pulls System.Security.Cryptography.Pkcs 9.0.18, which is hit by CVE-2026-84008. Upgrade to SqlClient 7.1.2, or pin Pkcs 9.0.21+ directly or with CPM transitive pinning."
pubDate: 2026-11-21
template: error-page
tags:
  - "errors"
  - "nuget"
  - "sql-server"
  - "security"
  - "dotnet-10"
---

The fix: upgrade `Microsoft.Data.SqlClient` from 7.1.1 to 7.1.2 (released November 13, 2026). 7.1.2 raises its `System.Security.Cryptography.Pkcs` floor from 9.0.18 to 9.0.21, the first patched 9.x version for CVE-2026-84008 and CVE-2026-70162, and the `NU1903`/`NU1902` warnings go away with no other change. If you cannot move off 7.1.1 yet, add a direct `PackageReference` to `System.Security.Cryptography.Pkcs` 9.0.21 or later (10.0.15 works too), or pin it through Central Package Management transitive pinning. Do not add that pin to a WPF or Windows Forms project: there the package is already pruned and the pin only earns you `NU1510`.

Everything below was reproduced on macOS with the .NET SDK 10.0.302 (NuGet audit data from nuget.org as of 2026-11-21), against `net10.0`, `net10.0-windows` (with `EnableWindowsTargeting` so restore runs off Windows), and `net8.0` class libraries. Only `dotnet restore` and `dotnet build` were exercised; nothing here connects to SQL Server, because the warning is a restore-time graph problem and has nothing to do with the database.

## The error in context

A new `net10.0` library that does nothing except reference the SQL Server driver produces two audit warnings on restore:

```text
App.csproj : warning NU1902: Package 'System.Security.Cryptography.Pkcs' 9.0.18 has a known moderate severity vulnerability, https://github.com/advisories/GHSA-2fmv-rv2c-59x7
App.csproj : warning NU1903: Package 'System.Security.Cryptography.Pkcs' 9.0.18 has a known high severity vulnerability, https://github.com/advisories/GHSA-846f-f764-76mx
```

With `TreatWarningsAsErrors` (common in CI) the build fails outright:

```text
App.csproj : error NU1902: Warning As Error: Package 'System.Security.Cryptography.Pkcs' 9.0.18 has a known moderate severity vulnerability, https://github.com/advisories/GHSA-2fmv-rv2c-59x7
App.csproj : error NU1903: Warning As Error: Package 'System.Security.Cryptography.Pkcs' 9.0.18 has a known high severity vulnerability, https://github.com/advisories/GHSA-846f-f764-76mx
Build FAILED.
```

You never referenced `System.Security.Cryptography.Pkcs`, which is the confusing part. `dotnet nuget why` shows where it comes from:

```text
$ dotnet nuget why App.csproj System.Security.Cryptography.Pkcs

  [net10.0]
  └── Microsoft.Data.SqlClient (v7.1.1)
      └── System.Security.Cryptography.Pkcs (v9.0.18)
```

## Why Microsoft.Data.SqlClient 7.1.1 drags in a vulnerable Pkcs

Both advisories were published on October 13, 2026 and are .NET denial-of-service bugs in `System.Security.Cryptography.Pkcs`. The GitHub Advisory Database (which is what NuGet Audit reads) lists the same affected ranges for both:

| Pkcs line | Vulnerable | First patched |
| --- | --- | --- |
| 8.0.x | 8.0.0 to 8.0.1 | 8.0.2 |
| 9.0.x | 9.0.0 to 9.0.20 | 9.0.21 |
| 10.0.x | 10.0.0 to 10.0.12 | 10.0.13 |
| 11.0 previews | preview.1 to rc.1 | 11.0.0-rc.2 |

`Microsoft.Data.SqlClient` 7.1.1 was built before those fixes existed. Its nuspec declares `System.Security.Cryptography.Pkcs` `9.0.18` for the `net9.0` group (which a `net10.0` project picks, since 7.1.x has no `net10.0` group) and `8.0.1` for `net8.0`, `net462`, and `netstandard2.0`. Every one of those is inside a vulnerable range.

NuGet resolves the lowest version that satisfies a dependency's `>=` constraint, so nothing in your project ever pulls a newer Pkcs on its own. The published 7.1.1 package cannot be changed after the fact, so the only ways out are a new SqlClient version with a higher floor, or a higher floor that you declare yourself. That is exactly what the SqlClient maintainers said in [dotnet/SqlClient#4843](https://github.com/dotnet/SqlClient/issues/4843): bump the dependency in the next release, and add a direct reference in the meantime. The same issue confirms the 6.1 line was affected; 6.1.8 now declares Pkcs 8.0.2 / 9.0.21.

## Minimal repro

```xml
<!-- .NET SDK 10.0.302, Microsoft.Data.SqlClient 7.1.1 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.Data.SqlClient" Version="7.1.1" />
  </ItemGroup>
</Project>
```

```bash
dotnet restore --force
dotnet list package --vulnerable --include-transitive
```

The second command lists the transitive package with both advisories:

```text
   [net10.0]:
   Transitive Package                       Resolved   Severity   Advisory URL
   > System.Security.Cryptography.Pkcs      9.0.18     High       https://github.com/advisories/GHSA-846f-f764-76mx
                                                       Moderate   https://github.com/advisories/GHSA-2fmv-rv2c-59x7
```

## Fix 1: upgrade to Microsoft.Data.SqlClient 7.1.2

This is the real fix. The [7.1.2 release notes](https://github.com/dotnet/SqlClient/releases/tag/v7.1.2) list "Updated dependencies to address CVE-2026-84008": Pkcs 8.0.2 for `net462`/`net8.0`/`netstandard2.0` and the .NET 9 dependencies moved to 9.0.21.

```xml
<!-- .NET SDK 10.0.302, Microsoft.Data.SqlClient 7.1.2 -->
<ItemGroup>
  <PackageReference Include="Microsoft.Data.SqlClient" Version="7.1.2" />
</ItemGroup>
```

Restore is clean, and `project.assets.json` now resolves `System.Security.Cryptography.Pkcs/9.0.21`. The release notes also ask you to keep any SqlClient companion packages you reference directly on matching 7.1.2 versions; the assembly version stays `7.0.0.0`, so .NET Framework apps need no new binding redirects.

If some other package also depends on Pkcs 9.0.x, upgrading SqlClient still fixes the whole graph, because NuGet picks one version per package per target framework. With `Microsoft.Data.SqlClient` 7.1.2 and `NuGet.Packaging` 7.3.1 (which also wants Pkcs 9.0.18, the second path reported in #4843) in the same project, both arrows resolve to 9.0.21:

```text
  [net10.0]
  ├── Microsoft.Data.SqlClient (v7.1.2)
  │   └── System.Security.Cryptography.Pkcs (v9.0.21)
  └── NuGet.Packaging (v7.3.1)
      └── System.Security.Cryptography.Pkcs (v9.0.21)
```

Note that `dotnet nuget why` prints the *resolved* version on every edge, not what each package asked for. Read the nuspec, or the `dependencies` block in `obj/project.assets.json`, if you need the requested floor.

## Fix 2: pin Pkcs directly when you cannot upgrade SqlClient

If 7.1.2 is blocked (a lock file you cannot touch this week, a companion package that has not caught up), lift the floor yourself:

```xml
<!-- .NET SDK 10.0.302, Microsoft.Data.SqlClient 7.1.1 -->
<ItemGroup>
  <PackageReference Include="Microsoft.Data.SqlClient" Version="7.1.1" />
  <PackageReference Include="System.Security.Cryptography.Pkcs" Version="9.0.21" />
</ItemGroup>
```

Both 9.0.21 and 10.0.15 restored without warnings against SqlClient 7.1.1 on `net10.0`. Staying on 9.0.x keeps you on the same major the driver was compiled against, which is the conservative choice; 10.0.x is what the upcoming SqlClient 8.0 (`8.0.0-preview1.26313.4`, which targets `net10.0` and declares Pkcs 10.0.13) will bring anyway.

A floating version such as `9.0.*` also works and picks up future patches, but two restores a week apart can then produce different graphs. Prefer an exact version and let Dependabot or Renovate move it.

Remove the pin once you are on SqlClient 7.1.2 or later. A stale pin is harmless while it is higher than what SqlClient wants, but it becomes a build break if it falls below the floor, see `NU1605` further down.

## Fix 3: pin it centrally with CPM transitive pinning

In a solution that already uses [Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/), you do not need a `PackageReference` in every project. Turn on transitive pinning and list the patched version once:

```xml
<!-- Directory.Packages.props, .NET SDK 10.0.302 -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
    <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.Data.SqlClient" Version="7.1.1" />
    <PackageVersion Include="System.Security.Cryptography.Pkcs" Version="10.0.15" />
  </ItemGroup>
</Project>
```

The project file keeps only `<PackageReference Include="Microsoft.Data.SqlClient" />`. Restore is clean and resolves `System.Security.Cryptography.Pkcs/10.0.15` even though no project references it. Without `CentralPackageTransitivePinningEnabled`, a `PackageVersion` for a package nobody references directly does nothing: the same props file minus that one property restores Pkcs 9.0.18 again, with both warnings.

## Fix 4: suppress the advisory (only if you have assessed it)

`NuGetAuditSuppress` silences a specific advisory URL without changing the graph:

```xml
<!-- .NET SDK 10.0.302, Microsoft.Data.SqlClient 7.1.1 -->
<ItemGroup>
  <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-846f-f764-76mx" />
  <NuGetAuditSuppress Include="https://github.com/advisories/GHSA-2fmv-rv2c-59x7" />
</ItemGroup>
```

Restore is clean, but you are still shipping Pkcs 9.0.18. That is only reasonable when you have checked that the vulnerable code path is unreachable in your app, and with a patched SqlClient available there is little reason left to do it. It is better than `<NoWarn>NU1903</NoWarn>` though: `NoWarn` hides every future high-severity advisory too, while a suppression is tied to one advisory and needs revisiting only for that one.

## Why the warning disappears when you add UseWPF

The Stack Overflow question that put this on the queue noticed something odd: the same `net10.0-windows` library stops warning as soon as `<UseWPF>true</UseWPF>` is added, and `System.Security.Cryptography.Pkcs` vanishes from `project.assets.json`. That is reproducible and it is not a fluke; it is [package pruning](/2026/05/nuget-package-pruning-default-net-10/), on by default when targeting .NET 10.

`UseWPF` (or `UseWindowsForms`) adds a framework reference to `Microsoft.WindowsDesktop.App`, and that shared framework ships its own `System.Security.Cryptography.Pkcs.dll` (alongside `System.Security.Cryptography.Xml`, `ProtectedData`, and `System.Configuration.ConfigurationManager`). Because the assembly is already supplied by the framework, restore prunes the NuGet package out of the graph. You can see the pruning list the SDK computes:

```bash
# .NET SDK 10.0.302, net10.0-windows + UseWPF + EnableWindowsTargeting
dotnet msbuild -t:CollectPrunePackageReferences -getItem:PrunePackageReference
```

For the WPF project that list has 287 entries, including `System.Security.Cryptography.Pkcs` with version `9.0.32767`, meaning "any 9.x and below". For plain `net10.0` and for `net10.0-windows` without `UseWPF` it has 272 entries and no Pkcs at all, which is why those projects keep the warning.

So in a WPF or Windows Forms app on .NET 10, the vulnerable 9.0.18 never ships: at runtime the app uses the framework's copy, and that copy is patched by installing the current Windows Desktop runtime (the November 2026 servicing release is 10.0.15). That moves the fix from your project file to your runtime update process, which is the usual story for anything in a shared framework.

Two consequences worth knowing:

- **Do not add the direct pin to a WPF project.** Pinning Pkcs 9.0.21 there restores fine, but you get `warning NU1510: PackageReference System.Security.Cryptography.Pkcs will not be pruned. Consider removing this package from your dependencies, as it is likely unnecessary.` The framework already supplies the assembly, so the pin adds a package reference that does nothing useful and that you have to keep patching.
- **Pruning stops at 9.x.** With `Microsoft.Data.SqlClient` `8.0.0-preview1.26313.4`, which asks for Pkcs 10.0.13, the same WPF project resolves `System.Security.Cryptography.Pkcs/10.0.13` from NuGet, because 10.0.13 is above the `9.0.32767` pruning ceiling. A future Pkcs 10.0.x advisory would therefore show up in WPF projects too.

## Why net8.0 projects with the same graph stay quiet

Retarget the repro from `net10.0` to `net8.0` and restore is silent, even though SqlClient 7.1.1 hands `net8.0` Pkcs 8.0.1, which is also vulnerable. `dotnet list package --vulnerable --include-transitive` still reports both advisories for it.

The difference is `NuGetAuditMode`. The .NET 10 SDK's `NuGet.targets` sets it to `all` (audit transitive packages) only when the project targets .NET 10 or later, and to `direct` otherwise:

```xml
<!-- NuGet.targets, .NET SDK 10.0.302 -->
<NuGetAuditMode Condition=" '$(NuGetAuditMode)' == ''
                AND '$(NuGetExeSkipSdkAnalysisLevelCheck)' != 'true'
                AND '$(TargetFrameworkIdentifier)' == '.NETCoreApp'
                AND $([MSBuild]::VersionGreaterThanOrEquals('$(TargetFrameworkVersion)', '10.0'))">all</NuGetAuditMode>
<NuGetAuditMode Condition=" '$(NuGetAuditMode)' == '' ">direct</NuGetAuditMode>
```

`dotnet msbuild -getProperty:NuGetAuditMode` returns `direct` for the `net8.0` project and `all` for `net10.0`, and `dotnet restore -p:NuGetAuditMode=all` brings both warnings back on `net8.0`. That is why this warning often appears "out of nowhere" right after a project is retargeted to .NET 10: the graph did not change, the audit scope did. If you maintain `net8.0` or `net9.0` projects, set `<NuGetAuditMode>all</NuGetAuditMode>` in `Directory.Build.props` so they see the same advisories, and upgrade to SqlClient 7.1.2 there too (it moves `net8.0` to Pkcs 8.0.2).

## Gotchas and lookalikes

- **NU1605 after pinning too low.** A pin is a floor, not an override. With SqlClient 7.1.2 and a leftover `System.Security.Cryptography.Pkcs` `9.0.18` reference, restore fails with `error NU1605: Warning As Error: Detected package downgrade: System.Security.Cryptography.Pkcs from 9.0.21 to 9.0.18`, and it still prints the `NU1903` you were trying to fix. Delete the pin after upgrading.
- **The warning shows up locally but not on CI (or the reverse).** Audit data comes from the package sources (or the `<auditSources>` you configure) in the nuget.config that restore actually uses. A private feed that proxies nuget.org may not serve vulnerability data, in which case NuGet reports `NU1905` instead of the advisories. Compare the effective nuget.config on both machines before assuming the graphs differ.
- **Same advisory, different parent.** EF Core 10 preview and RC Design packages trip the same Pkcs advisory through MSBuild; that case and its additional Package Manager Console failure are covered in [the NU1903 Microsoft.Build.Tasks.Core post](/2026/11/fix-nu1903-microsoft-build-tasks-core-17-14-8-breaks-dotnet-ef-migrations/).
- **A dedicated audit pipeline.** If audit warnings breaking every build is the real pain, the NuGet docs show how to treat `NU1900` to `NU1905` as errors only when an `AuditPipeline` property is set, so feature builds keep compiling while one pipeline gates on vulnerabilities.

## Related

- [NuGet package pruning is on by default in .NET 10](/2026/05/nuget-package-pruning-default-net-10/) explains the pruning that makes the WPF case behave differently.
- [Migrating a solution to Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) covers `Directory.Packages.props` and transitive pinning in depth.
- [Fix: NU1903 for Microsoft.Build.Tasks.Core 17.14.8 in dotnet ef migrations](/2026/11/fix-nu1903-microsoft-build-tasks-core-17-14-8-breaks-dotnet-ef-migrations/) is the EF tooling flavor of the same audit failure.
- [Fix: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'](/2026/09/fix-could-not-load-file-or-assembly-microsoft-data-sqlclient-version-7-0-0-0/) helps if the SqlClient upgrade itself goes sideways with EF Core.

## Sources

- [dotnet/SqlClient#4843: Using a vulnerable version of System.Security.Cryptography.Pkcs](https://github.com/dotnet/SqlClient/issues/4843)
- [Microsoft.Data.SqlClient 7.1.2 release notes](https://github.com/dotnet/SqlClient/releases/tag/v7.1.2)
- [GHSA-846f-f764-76mx (CVE-2026-84008)](https://github.com/advisories/GHSA-846f-f764-76mx) and [GHSA-2fmv-rv2c-59x7 (CVE-2026-70162)](https://github.com/advisories/GHSA-2fmv-rv2c-59x7)
- [Auditing package dependencies for security vulnerabilities](https://learn.microsoft.com/en-us/nuget/concepts/auditing-packages) (NuGetAuditMode, NuGetAuditSuppress, audit pipelines)
- [Central Package Management: transitive pinning](https://learn.microsoft.com/en-us/nuget/consume-packages/central-package-management#transitive-pinning)
- [PrunePackageReference](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#prunepackagereference), [NU1510](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1510), and [NU1605](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1605)
- [Stack Overflow: NuGet vulnerable with Microsoft.Data.SqlClient 7.1.1 depending on System.Security.Cryptography.Pkcs 9.0.18](https://stackoverflow.com/questions/80013443)
