---
title: "Fix: warning NU1903 'Microsoft.Build.Tasks.Core' 17.14.8 has a known high severity vulnerability breaks dotnet ef migrations"
description: "EF Core 10 preview and RC Design packages pull Microsoft.Build.Tasks.Core 17.14.8. Upgrade Design and Tools to 10.0.2 or later, or pin MSBuild and System.Security.Cryptography.* with CPM transitive pinning."
pubDate: 2026-11-13
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "nuget"
  - "dotnet-10"
---

The fix: upgrade `Microsoft.EntityFrameworkCore.Design` and `Microsoft.EntityFrameworkCore.Tools` to the current 10.0.x patch (10.0.15 at the time of writing; 10.0.2 is the first version whose graph is clean). The vulnerable `Microsoft.Build.Tasks.Core` 17.14.8 is a dependency of the EF Core 10 preview and RC Design packages, NuGet Audit reports it as `NU1903`, and two things turn that warning into a failed migration: `TreatWarningsAsErrors` in the CLI, and Visual Studio's Package Manager Console, where the EF Core 10 PowerShell module stops on any line the build writes to stderr. If you cannot upgrade, pin the patched MSBuild packages **and** `System.Security.Cryptography.Xml`/`Pkcs` with Central Package Management transitive pinning, because pinning MSBuild alone just moves the warning to the crypto packages.

Everything below was reproduced on macOS with the .NET SDK 10.0.302 (MSBuild 18.6.11, NuGet 7.6.0), `dotnet-ef` 10.0.15 as a local tool, a `net10.0` console app with `Microsoft.EntityFrameworkCore.Sqlite` 10.0.15, and the GitHub Advisory Database as NuGet saw it on 2026-11-13. The Package Manager Console part was not run (it needs Windows and Visual Studio); it is explained from the EF Core 10 PowerShell module source and the error text in the original report, and the exact stderr behavior it reacts to was measured.

## The error in context

In Visual Studio's Package Manager Console, `Add-Migration` or `Update-Database` stops before EF does anything:

```text
The running command stopped because the preference variable "ErrorActionPreference" or common parameter
is set to Stop: C:\src\App\App.csproj : warning NU1903: Package 'Microsoft.Build.Tasks.Core' 17.14.8
has a known high severity vulnerability, https://github.com/advisories/GHSA-w3q9-fxm7-j8fq
```

From the CLI with `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` the same advisory surfaces as a restore error, and `dotnet ef` cannot even read the project:

```text
// .NET SDK 10.0.302, dotnet-ef 10.0.15, EF Core Design 10.0.0-rc.2.25502.107
App.csproj : error NU1903: Warning As Error: Package 'Microsoft.Build.Tasks.Core' 17.14.8 has a known high severity vulnerability, https://github.com/advisories/GHSA-w3q9-fxm7-j8fq
App.csproj : error NU1903: Warning As Error: Package 'Microsoft.Build.Utilities.Core' 17.14.8 has a known high severity vulnerability, https://github.com/advisories/GHSA-w3q9-fxm7-j8fq
Unable to retrieve project metadata. Ensure it's an SDK-style project.
```

Without `TreatWarningsAsErrors`, `dotnet ef migrations add` prints the warnings and succeeds. That difference is the whole story: the advisory is the same, only the host's tolerance for warnings changes.

## Why EF Core tooling pulls in MSBuild 17.14.8

The advisory is [GHSA-w3q9-fxm7-j8fq](https://github.com/advisories/GHSA-w3q9-fxm7-j8fq) (CVE-2025-55247), a denial of service in MSBuild published on 2025-10-15. It covers `Microsoft.Build`, `Microsoft.Build.Tasks.Core` and `Microsoft.Build.Utilities.Core` 17.14.0 through 17.14.8, patched in 17.14.28 (and 17.12.50, 17.11.48, 17.10.46, 17.8.43 for the older lines).

`dotnet nuget why` shows who brings it in:

```text
// dotnet nuget why App.csproj Microsoft.Build.Tasks.Core
  [net10.0]
  └── Microsoft.EntityFrameworkCore.Design (v10.0.0-rc.2.25502.107)
      ├── Microsoft.Build.Tasks.Core (v17.14.8)
      └── Microsoft.CodeAnalysis.Workspaces.MSBuild (v4.14.0)
          └── Microsoft.Build.Tasks.Core (v17.14.8)
```

Reading the nuspec of each Design version on nuget.org gives a clear timeline for the `net10.0` dependency group:

| `Microsoft.EntityFrameworkCore.Design` | MSBuild packages it depends on |
|---|---|
| 9.0.x | `Microsoft.Build.Framework` 17.8.3 only (no Tasks.Core) |
| 10.0.0-rc.1 / rc.2 | Framework, Tasks.Core, Utilities.Core **17.14.8** |
| 10.0.0, 10.0.1 | Framework, Tasks.Core, Utilities.Core 17.14.28 |
| 10.0.2 through 10.0.15 | `Microsoft.Build.Framework` 18.0.2 only |
| 11.0.0 | `Microsoft.Build.Framework` 18.9.6 only |

The original report on the EF Core repo, [dotnet/efcore#36997](https://github.com/dotnet/efcore/issues/36997), was filed against SDK 10.0 RC2 templates with individual auth. As Viktor Hofer notes there, the dependency really comes from Roslyn's `Microsoft.CodeAnalysis.Workspaces.MSBuild`, and it was fixed in the 10.0 release branch before GA. Anyone who installed a 10.0 preview or RC of `Microsoft.EntityFrameworkCore.Tools` and never updated it is still on 17.14.8. `Tools` depends on the matching `Design`, so the vulnerable version follows you even if `Design` is not in your csproj.

## Why the Package Manager Console stops on a warning

EF Core 10 added a step to the `EntityFrameworkCore.psm1` module that ships in the Tools package. Diffing the module from Tools 9.0.10 against 10.0.0-rc.2 shows this new block in the function that invokes `ef.dll`:

```powershell
# EntityFrameworkCore.psm1, Microsoft.EntityFrameworkCore.Tools 10.0.0-rc.2.25502.107
$references = (dotnet build $startupProject.FullName /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems) -join "`n" | ConvertFrom-Json
```

The module also starts with `$ErrorActionPreference = 'Stop'`. When MSBuild is asked for `-getItem`, it writes the JSON to stdout and moves every logger message, including restore warnings, to stderr. Measured on the repro project:

```bash
# .NET SDK 10.0.302, Design 10.0.0-rc.2.25502.107, no TreatWarningsAsErrors
dotnet build App.csproj /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems > out.txt 2> err.txt
# exit code 0
# out.txt: 1164 lines of JSON, no NU19xx lines
# err.txt: every NU1902/NU1903 line from NuGet Audit
```

In the Package Manager Console host, output a native command writes to stderr becomes a PowerShell error record, and with the preference set to `Stop` the first one aborts the command. That is why the message quotes the NU1903 line verbatim, and why the failure is new in EF Core 10: the 9.0 module never ran this build. The consequence is wider than this one advisory. Any NuGet Audit warning in the startup project's graph, from any package, will break PMC migrations on EF Core 10 Tools. So the target state for PMC is not "no errors" but "nothing on stderr".

## Minimal repro

```xml
<!-- App.csproj -- .NET SDK 10.0.302, EF Core Design 10.0.0-rc.2 (repro of the failure) -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.15" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.0-rc.2.25502.107" PrivateAssets="all" />
  </ItemGroup>
</Project>
```

```csharp
// Program.cs -- .NET 10, EF Core 10
using Microsoft.EntityFrameworkCore;

Console.WriteLine("hello");

public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=app.db");
}
```

```bash
dotnet new tool-manifest
dotnet tool install dotnet-ef --version 10.0.15
dotnet ef migrations add Initial   # fails: NU1903 as error, "Unable to retrieve project metadata"
```

On 2026-11-13 this project reports 15 audit lines, not 2. `Microsoft.Build.Tasks.Core` 17.14.x depends on `System.Security.Cryptography.Xml` 9.0.0 and `System.Security.Cryptography.Pkcs` 9.0.0, and both have collected advisories during 2026 (for example [GHSA-w3x6-4m5h-cxqf](https://github.com/advisories/GHSA-w3x6-4m5h-cxqf), patched in 9.0.15 / 10.0.6, and [GHSA-846f-f764-76mx](https://github.com/advisories/GHSA-846f-f764-76mx), patched in 9.0.21 / 10.0.13). The exact count depends on the date you restore, because NuGet Audit downloads the vulnerability database on each restore.

## Fix 1: upgrade Design and Tools to the current 10.0.x

This is the only fix that also removes the vulnerable code from the build, and it is a one-line change per package. Keep `Design` and `Tools` on the same version as your EF Core runtime packages:

```xml
<!-- .NET 10, EF Core 10.0.15 -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.15" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.15" PrivateAssets="all" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.15" PrivateAssets="all" />
</ItemGroup>
```

With `TreatWarningsAsErrors` still on, restore succeeded, the `-getItem` build wrote nothing to stderr, and `dotnet ef migrations add Initial` produced the migration. The graph now has `Microsoft.Build.Framework` 18.0.2 and `Microsoft.CodeAnalysis.Workspaces.MSBuild` 5.0.0, and no `Tasks.Core` at all.

Two traps. First, 10.0.0 and 10.0.1 are not enough today: they have the patched MSBuild 17.14.28, but that version still depends on `System.Security.Cryptography.Xml` and `Pkcs` 9.0.0, so the same project fails with 13 `NU1902`/`NU1903` errors instead of 15. Design 10.0.2 restored clean in the same test; take the latest patch anyway. Second, upgrade `dotnet-ef` itself too (`dotnet tool update dotnet-ef`), and in Visual Studio restart the Package Manager Console after updating the Tools package so the new module is loaded. If an EF Core upgrade then fails at runtime with a `MissingMethodException`, the tools and the runtime packages are out of step; see [the ArgumentIsEmpty MissingMethodException fix](/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/).

## Fix 2: pin the patched transitive packages with CPM

If something blocks the EF upgrade (a provider that only supports a specific 10.0 RC, for instance), raise the floor of the transitive packages instead. With [Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) and transitive pinning, a `PackageVersion` that no project references directly still wins over a lower transitive version:

```xml
<!-- Directory.Packages.props -- .NET SDK 10.0.302, NuGet 7.6.0 -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
    <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.15" />
    <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.0-rc.2.25502.107" />
    <!-- transitive pins: never referenced by a project, only raise the floor -->
    <PackageVersion Include="Microsoft.Build.Tasks.Core" Version="17.14.28" />
    <PackageVersion Include="Microsoft.Build.Utilities.Core" Version="17.14.28" />
    <PackageVersion Include="System.Security.Cryptography.Xml" Version="10.0.15" />
    <PackageVersion Include="System.Security.Cryptography.Pkcs" Version="10.0.15" />
  </ItemGroup>
</Project>
```

The csproj keeps `<PackageReference Include="Microsoft.EntityFrameworkCore.Design" PrivateAssets="all" />` without a version. Result on the repro: restore exit code 0, zero audit lines, empty stderr from the `-getItem` build, `dotnet ef migrations add` succeeded, and `dotnet nuget why` shows `Microsoft.Build.Tasks.Core (v17.14.28)` under both paths. Without CPM, the same versions as direct `PackageReference` items with `PrivateAssets="all"` give the same result.

Pinning only the two MSBuild packages is the answer most people try first, and on 2026-11-13 it fails: restore still reports 13 errors, now all for the crypto packages pulled in by 17.14.28. Pins are a maintenance cost, so delete them once you can move to Fix 1. Mixing an RC `Design` with 10.0.15 runtime packages works for migrations here, but it is not a supported combination.

## Fix 3: narrow the audit instead of silencing it

When you need migrations to run today and the upgrade is scheduled, these settings were tested in the repro. "PMC-safe" means the `-getItem` build wrote nothing to stderr.

| Setting | CLI with TreatWarningsAsErrors | PMC-safe | Notes |
|---|---|---|---|
| `NoWarn="NU1903;NU1902"` on the Design `PackageReference` | fails | no | Package-level `NoWarn` does not cover audit warnings raised for its transitive dependencies |
| `<NoWarn>$(NoWarn);NU1902;NU1903</NoWarn>` in the project | passes | yes | Hides every future high and moderate advisory in that project |
| `<WarningsNotAsErrors>$(WarningsNotAsErrors);NU1902;NU1903</WarningsNotAsErrors>` | passes | no | Fixes CI, still breaks PMC because the warnings are still printed |
| `<NuGetAuditMode>direct</NuGetAuditMode>` | passes | yes | Stops auditing every transitive package, not just this one |
| `<NuGetAuditSuppress Include="https://github.com/advisories/GHSA-w3q9-fxm7-j8fq" />` | fails | no | Correctly scoped, but the crypto advisories remain; add one item per advisory URL |
| `PrivateAssets="all"` on Design | fails | no | Already the default from `dotnet add package`; controls flow to consumers, not auditing |

`NuGetAuditSuppress` is the right tool if you want a suppression you can review later, because it names each advisory and nothing else. It needs NuGet 6.11 (SDK 8.0.400) or later. In practice, suppressing 13 advisory URLs one by one to keep an RC package is more work than Fix 1. If you do turn off transitive auditing, note that .NET 10 changed the default `NuGetAuditMode` to `all`, a change covered in [NuGet package pruning in .NET 10](/2026/05/nuget-package-pruning-default-net-10/); pruning does not help here, because MSBuild and `System.Security.Cryptography.Xml` are not part of the shared framework.

The answer on the Stack Overflow thread that suggests `Update-Database -ErrorAction Ignore` was not tested here (it needs PMC). It would override the module's `Stop` preference for that call, but it also hides real failures, so a migration that never ran can report success. Treat it as a last resort, not a fix.

## Lookalikes that land here

- **`NU1903` for `SQLitePCLRaw.lib.e_sqlite3` 2.1.11.** Same mechanism, different source: EF Core Sqlite RC packages carry the old native SQLite bundle ([dotnet/efcore#38467](https://github.com/dotnet/efcore/issues/38467)). The repro showed it disappear once `Microsoft.EntityFrameworkCore.Sqlite` was on 10.0.15.
- **`NU1903` for `Microsoft.OpenApi`.** That one comes from ASP.NET Core OpenAPI, covered in [the OpenApiReference post](/2026/08/fix-the-type-or-namespace-name-openapireference-could-not-be-found/).
- **`NU1608` / `NU1107` while upgrading EF Core.** A version conflict, not an advisory. A provider caps the EF version; see [the Pomelo and EF Core 10 conflict fix](/2026/10/fix-nu1608-nu1107-version-conflict-pomelo-entityframeworkcore-mysql-ef-core-10/).
- **`Unable to create a 'DbContext' of type ...`.** The project builds, but EF cannot construct the context at design time. See [the dotnet ef unable-to-create-DbContext fix](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

## Related

- [Migrate a .NET solution to Central Package Management with Directory.Packages.props](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/), including transitive pinning.
- [NuGet package pruning is on by default in .NET 10](/2026/05/nuget-package-pruning-default-net-10/), and how it interacts with `NuGetAuditMode`.
- [Fix MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' after upgrading EF Core Tools](/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/).
- [Fix NU1608 / NU1107 between Pomelo and EF Core 10](/2026/10/fix-nu1608-nu1107-version-conflict-pomelo-entityframeworkcore-mysql-ef-core-10/).

## Sources

- [GHSA-w3q9-fxm7-j8fq / CVE-2025-55247](https://github.com/advisories/GHSA-w3q9-fxm7-j8fq), affected and patched MSBuild versions.
- [dotnet/efcore#36997](https://github.com/dotnet/efcore/issues/36997), the NU1903 report against 10.0 RC2 and the release-branch fix.
- [Auditing package dependencies for security vulnerabilities](https://learn.microsoft.com/nuget/concepts/auditing-packages) on Microsoft Learn (`NuGetAudit`, `NuGetAuditMode`, `NuGetAuditLevel`, `NuGetAuditSuppress`).
- [Central Package Management: transitive pinning](https://learn.microsoft.com/nuget/consume-packages/central-package-management#transitive-pinning) on Microsoft Learn.
- [`dotnet nuget why`](https://learn.microsoft.com/dotnet/core/tools/dotnet-nuget-why) command reference.
- Stack Overflow: [.NET migrations with vulnerabilities](https://stackoverflow.com/questions/79808947).
