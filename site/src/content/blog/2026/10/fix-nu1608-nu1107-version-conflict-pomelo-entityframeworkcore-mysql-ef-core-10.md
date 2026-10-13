---
title: "Fix: NU1608 / NU1107 version conflict between Pomelo.EntityFrameworkCore.MySql and EF Core 10"
description: "Pomelo 9.0.0 only allows EF Core Relational 9.0.x and has no EF Core 10 build. Keep every EF Core package on 9.0.x, or switch to Microting.EntityFrameworkCore.MySql 10.0.x. Suppressing the warning crashes at startup."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "dotnet-10"
  - "nuget"
  - "mysql"
---

**Short answer:** `Pomelo.EntityFrameworkCore.MySql` 9.0.0 is still the newest release on nuget.org (October 2026), and it declares `Microsoft.EntityFrameworkCore.Relational` as `[9.0.0, 9.0.999]`. Any EF Core 10 package in the graph either collides with that range (`NU1107`, a restore error) or wins over it (`NU1608`, a warning). There is no Pomelo build for EF Core 10, not even on the nightly feed. You have two working options: keep every EF Core and Identity package on 9.0.x (it runs fine on `net10.0`), or swap Pomelo for the `Microting.EntityFrameworkCore.MySql` 10.0.x fork. Do not `NoWarn` the `NU1608`: the app compiles and then dies inside `UseMySql` with a `MissingMethodException`.

Everything below was reproduced on macOS with .NET SDK 10.0.302, EF Core 10.0.13 and 9.0.21, Pomelo 9.0.0, Microting 10.0.12, and Oracle's `MySql.EntityFrameworkCore` 10.0.9.

## The error in context

You get one of two shapes depending on which EF Core 10 package you added. If something else pulls EF Core 10 in transitively, typically `Microsoft.EntityFrameworkCore.Design` or ASP.NET Core Identity, restore fails hard:

```text
error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 10.0.13 directly to project App to resolve this issue.
error NU1107:  App -> Microsoft.EntityFrameworkCore.Design 10.0.13 -> Microsoft.EntityFrameworkCore.Relational (>= 10.0.13)
error NU1107:  App -> Pomelo.EntityFrameworkCore.MySql 9.0.0 -> Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999).
```

If you follow that advice and reference `Microsoft.EntityFrameworkCore.Relational` 10.0.13 directly, the error becomes a warning, because a direct reference always wins over a transitive range:

```text
warning NU1608: Detected package version outside of dependency constraint: Pomelo.EntityFrameworkCore.MySql 9.0.0 requires Microsoft.EntityFrameworkCore.Relational (>= 9.0.0 && <= 9.0.999) but version Microsoft.EntityFrameworkCore.Relational 10.0.13 was resolved.
```

And this is what that "fixed" build does at runtime, on the very first line that configures the context:

```text
Unhandled exception. System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NullButNotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.MySqlDbContextOptionsBuilderExtensions.UseMySql(DbContextOptionsBuilder optionsBuilder, String connectionString, ServerVersion serverVersion, Action`1 mySqlOptionsAction)
```

The NuGet message literally tells you to do the thing that produces the crash. That is why this error keeps showing up in issue trackers months after .NET 10 shipped.

## Why this happens

EF Core providers are compiled against the internals of one major EF Core version. Pomelo encodes that in its nuspec with an upper bound:

```xml
<!-- Pomelo.EntityFrameworkCore.MySql 9.0.0 nuspec -->
<group targetFramework="net8.0">
  <dependency id="Microsoft.EntityFrameworkCore.Relational" version="[9.0.0, 9.0.999]" include="All" />
  <dependency id="MySqlConnector" version="2.4.0" exclude="Build,Analyzers" />
</group>
```

NuGet resolves one version of each package per project. When two paths into the graph disagree:

- **Both transitive, ranges don't overlap** (`Design 10 -> Relational >= 10.0.13` vs `Pomelo -> Relational <= 9.0.999`): NuGet cannot pick, so it fails with `NU1107`.
- **One direct reference wins** (you reference Relational 10.0.13 yourself, or Central Package Management pins it): NuGet honors the direct version and warns with `NU1608` that Pomelo's constraint was violated.

The upper bound is not paranoia. Pomelo 9.0.0 calls helpers like `Check.NullButNotEmpty`, which in EF Core 9 forward to `AbstractionsStrings.ArgumentIsEmpty(object)`. EF Core 10 changed those internal resource methods, so the IL in Pomelo's assembly points at a method that no longer exists. The JIT only discovers that when the method is first called, which is why the build is green and the crash happens at startup.

The reason this is still a problem in October 2026, almost a year after EF Core 10 went GA: Pomelo's [EF Core 10 tracking issue #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007) is open with over 120 reactions, the last maintainer comment (October 2025) promised a release "soon", and several community PRs for EF Core 10 sit unmerged. I checked both the nuget.org listing and Pomelo's Azure DevOps nightly feed: the newest build on either is a `9.0.1-servicing` CI package from August 2025. There is nothing 10.x to upgrade to.

## Minimal repro

Three `net10.0` projects, each with Pomelo 9.0.0 plus one EF Core 10 package:

```xml
<!-- .NET SDK 10.0.302. Swap the second reference to get each outcome. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <OutputType>Exe</OutputType>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
    <!-- NU1107: -->
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13" />
    <!-- NU1107 too: Microsoft.AspNetCore.Identity.EntityFrameworkCore 10.0.13 -->
    <!-- NU1608 + crash: Microsoft.EntityFrameworkCore.Relational 10.0.13 -->
    <!-- No warning at all + crash: Microsoft.EntityFrameworkCore 10.0.13 -->
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 9.0.x or 10.0.x depending on the graph above
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<Shop>()
    .UseMySql("Server=localhost;Database=shop;User=root;Password=x",
              new MySqlServerVersion(new Version(8, 4, 0)))
    .Options;

using var db = new Shop(options);
Console.WriteLine(db.Orders.Where(o => o.Total > 10m).ToQueryString());

public class Order { public int Id { get; set; } public decimal Total { get; set; } }
public class Shop(DbContextOptions<Shop> o) : DbContext(o)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

The last variant in that list deserves its own warning. If you add `Microsoft.EntityFrameworkCore` 10.0.13 (not Relational), restore is silent. `Microsoft.EntityFrameworkCore.Relational` 9.0.0 only says `Microsoft.EntityFrameworkCore >= 9.0.0`, with no upper bound, so NuGet happily resolves EF Core 10.0.13 next to Relational 9.0.0. `dotnet nuget why` shows it:

```text
[net10.0]
 └── Pomelo.EntityFrameworkCore.MySql (v9.0.0)
     └── Microsoft.EntityFrameworkCore.Relational (v9.0.0)
```

No `NU1608`, no `NU1107`, and the exact same `MissingMethodException` at runtime. If you are seeing that exception without any NuGet warning, this is why.

## Fix, in detail

### 1. Find every package that drags EF Core 10 in

Before changing anything, find out who asked for 10.x. On a project that restores (the `NU1608` case), `dotnet nuget why` gives you the path:

```bash
dotnet nuget why src/App/App.csproj Microsoft.EntityFrameworkCore.Relational
```

On a project stuck at `NU1107`, the error itself lists both paths. The usual suspects on a `net10.0` app:

- `Microsoft.EntityFrameworkCore.Design` and `Microsoft.EntityFrameworkCore.Tools`, bumped by Dependabot or Renovate.
- `Microsoft.AspNetCore.Identity.EntityFrameworkCore`, because the Identity template uses the framework version (10.0.x).
- `Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore`, `Microsoft.EntityFrameworkCore.InMemory` or `.Sqlite` in a test project that references the app.
- A third-party library that already moved to EF Core 10 (bulk extensions, auditing, multi-tenancy).
- A `Directory.Packages.props` that pins all `Microsoft.EntityFrameworkCore.*` packages to one shared version property.

That last one is the trap with Central Package Management: a single `$(EfCoreVersion)` bumped to 10.0.x silently turns a transitive Relational into a pinned one, so you get `NU1608` instead of `NU1107` and lose the hard stop.

### 2. Option A: stay on EF Core 9.0.x on .NET 10

EF Core 9 targets `net8.0`, so it runs on the .NET 10 runtime without complaint. Pin every EF Core package, plus Identity if you use it, to the same 9.0.x patch:

```xml
<!-- .NET 10 app, EF Core 9.0.21, Pomelo 9.0.0 -->
<ItemGroup>
  <PackageReference Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="9.0.21">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
  <PackageReference Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="9.0.21" />
</ItemGroup>
```

With Central Package Management, split the property so the provider's world is explicit:

```xml
<!-- Directory.Packages.props, .NET 10 solution with Pomelo 9.0.0 -->
<PropertyGroup>
  <!-- Pomelo 9.0.0 caps Relational at 9.0.999. Do not bump until the provider moves. -->
  <EfCoreVersion>9.0.21</EfCoreVersion>
</PropertyGroup>
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Relational" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Microsoft.AspNetCore.Identity.EntityFrameworkCore" Version="$(EfCoreVersion)" />
  <PackageVersion Include="Pomelo.EntityFrameworkCore.MySql" Version="9.0.0" />
</ItemGroup>
```

I ran the repro program with this graph on `net10.0`: EF Core and Relational both report `9.0.21.0`, model building, `ToQueryString()` and `GenerateCreateScript()` all work, and the Identity 9.0.21 project restores and runs cleanly. Tell Dependabot to leave the 9.x line alone (an `ignore` rule for `Microsoft.EntityFrameworkCore*` with `update-types: ["version-update:semver-major"]`), or it will reopen the same PR every week.

The catch is the calendar. EF Core 9 ships with the .NET 9 STS support window, which ends on [November 10, 2026](https://dotnet.microsoft.com/platform/support/policy/dotnet-core). After that date there are no security patches for EF Core 9 packages (EF Core 8 LTS ends the same day). Option A is a bridge, not a destination.

### 3. Option B: switch to Microting.EntityFrameworkCore.MySql 10.0.x

[Microting.EntityFrameworkCore.MySql](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql) is a fork of Pomelo that has shipped EF Core 10 builds since February 2026 and also has an `11.0.0-preview.1`. The 10.0.12 nuspec targets `net10.0` with `Microsoft.EntityFrameworkCore.Relational [10.0.12, 10.0.999]` and `MySqlConnector 2.6.2`. It is the option most people in the Pomelo tracking issue have moved to.

```xml
<!-- .NET 10, EF Core 10.0.13, Microting 10.0.12 -->
<ItemGroup>
  <PackageReference Include="Microting.EntityFrameworkCore.MySql" Version="10.0.12" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.13">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

The `UseMySql(...)` extension and `MySqlServerVersion`/`ServerVersion.AutoDetect` live in the `Microsoft.EntityFrameworkCore` namespace in both packages, so my repro `Program.cs` compiled unchanged after the swap and printed the same MySQL SQL as Pomelo 9.0.0 with EF Core 9:

```text
SELECT `o`.`Id`, `o`.`Customer`, `o`.`Total`
FROM `Orders` AS `o`
WHERE (`o`.`Total` > 10.0) AND (`o`.`Customer` LIKE 'A%')
ORDER BY `o`.`Id`
LIMIT 5
```

What you do need to change:

1. Rename every `using Pomelo.EntityFrameworkCore.MySql.*;` to `using Microting.EntityFrameworkCore.MySql.*;`. The fork renamed both the assembly and the namespaces (for example `Pomelo.EntityFrameworkCore.MySql.Infrastructure` becomes `Microting.EntityFrameworkCore.MySql.Infrastructure`).
2. Replace the plugin packages too: `Pomelo.EntityFrameworkCore.MySql.Json.Microsoft` becomes `Microting.EntityFrameworkCore.MySql.Json.Microsoft`, and the same for `.Json.Newtonsoft` and `.NetTopologySuite`. Leaving one Pomelo plugin behind brings Pomelo 9.0.0 and the `NU1107` right back.
3. Update the provider name in scaffolding commands: `dotnet ef dbcontext scaffold "<conn>" Microting.EntityFrameworkCore.MySql`.
4. Upgrade the `dotnet-ef` tool to 10.0.x so it matches the runtime EF Core version.
5. Run `dotnet ef migrations add ProviderSwapCheck` against your existing migrations. If the generated migration is empty, the model snapshot is compatible; delete it with `dotnet ef migrations remove`. If it is not empty, read it before you ship anything: that diff is exactly what would run against production.

Be honest with yourself about what this is: a community fork maintained by one company, not an official provider. Pin the exact version, read its release notes before bumping, and watch both repositories. If Pomelo ships 10.0.0 later, moving back is the same rename in reverse.

### 4. Option C: Oracle's MySql.EntityFrameworkCore

Oracle's provider, [MySql.EntityFrameworkCore](https://www.nuget.org/packages/MySql.EntityFrameworkCore), has had EF Core 10 builds since 10.0.0-rc and is at 10.0.9. Its nuspec uses plain lower bounds (`Microsoft.EntityFrameworkCore.Relational >= 10.0.9`), so it never triggers this conflict. It is a different provider, not a fork, and the API differs:

```csharp
// .NET 10, EF Core 10.0.13, MySql.EntityFrameworkCore 10.0.9
options.UseMySQL(connectionString); // capital SQL, no ServerVersion argument
```

It also translates queries differently. The same `Customer.StartsWith("A")` filter from the repro becomes a `LIKE CONCAT('A', '%')` plus a `LEFT(...) = CONVERT(... USING utf8mb4) COLLATE utf8mb4_bin` comparison, where Pomelo and Microting emit `LIKE 'A%'`. Type mappings and migration annotations differ too, so expect a non-empty migration diff and plan a real migration review. Pick this if you want a vendor-backed provider and can afford that review; otherwise Option B is the smaller change.

### 5. What not to do

- **Don't add `<NoWarn>NU1608</NoWarn>`.** The repro shows the result: a clean build and a `MissingMethodException` on the first `UseMySql` call. If `TreatWarningsAsErrors` is what surfaced the `NU1608`, it did its job.
- **Don't reference `Microsoft.EntityFrameworkCore.Relational` 10.x directly** because the `NU1107` message suggests it. That converts the error into the crash.
- **Don't mix majors inside a solution.** A test project on EF Core 10 InMemory that references an app on EF Core 9 pulls both into the test's graph, and you get `NU1107` (or the silent mismatch) only in the test project.

## Gotchas and lookalike errors

- **`MissingMethodException` with no NuGet warning**: the `Microsoft.EntityFrameworkCore` 10 + Relational 9.0.0 graph from the repro. Run `dotnet nuget why <project> Microsoft.EntityFrameworkCore.Relational` and look for a 9.x Relational next to a 10.x EF Core.
- **`NU1107` or `NU1608` naming `Pomelo.EntityFrameworkCore.MySql.Json.Microsoft`**: the plugin packages repeat the same `Microsoft.EntityFrameworkCore.Relational [9.0.0, 9.0.999]` constraint and depend on Pomelo 9.0.0 themselves. Move them in lockstep with the main package.
- **`NU1605` (detected package downgrade)**: a different problem. Something in the graph wants a newer version than you pinned directly. It often appears right after you apply Option A, when a transitive package still wants EF Core 10. Fix it by finding and pinning that package, not by downgrading further.
- **`dotnet ef` warns that the tools version is newer than the runtime**: harmless on its own, but after Option A keep the `dotnet-ef` tool on the same major as the app's EF Core packages so design-time behavior matches what runs in production.
- **Npgsql or SQL Server packages on 10.x in the same solution**: fine as long as they are in different projects that never share a graph. One project, one EF Core major.

## Related

- If `NU1608` only surfaced because warnings fail your build, see [TreatWarningsAsErrors without sabotaging dev builds](/2026/01/treatwarningsaserrors-without-sabotaging-dev-builds-net-10/) for keeping that strict without hiding real problems.
- For the shared version property pattern used in Option A, see [migrating a .NET solution to Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/).
- .NET 10 also changed which transitive packages show up in your graph at all: [NuGet package pruning is on by default in .NET 10](/2026/05/nuget-package-pruning-default-net-10/).
- When the `dotnet-ef` tool and the SDK disagree instead, read [the DotnetToolSettings.xml fix](/2026/10/fix-settings-file-dotnettoolsettings-xml-was-not-found-in-the-package/).
- Planning the eventual jump past EF Core 9: [Migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Sources

- [Pomelo EF Core 10 support tracking issue #2007](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql/issues/2007)
- [Pomelo.EntityFrameworkCore.MySql README: compatibility table and nightly feeds](https://github.com/PomeloFoundation/Pomelo.EntityFrameworkCore.MySql)
- [Pomelo.EntityFrameworkCore.MySql 9.0.0 on NuGet](https://www.nuget.org/packages/Pomelo.EntityFrameworkCore.MySql/9.0.0)
- [Microting.EntityFrameworkCore.MySql on NuGet](https://www.nuget.org/packages/Microting.EntityFrameworkCore.MySql) and [its README on the namespace rename](https://github.com/microting/Pomelo.EntityFrameworkCore.MySql)
- [MySql.EntityFrameworkCore on NuGet](https://www.nuget.org/packages/MySql.EntityFrameworkCore)
- [NuGet warning NU1608](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1608) and [NuGet error NU1107](https://learn.microsoft.com/nuget/reference/errors-and-warnings/nu1107)
- [.NET and .NET Core support policy](https://dotnet.microsoft.com/platform/support/policy/dotnet-core)
