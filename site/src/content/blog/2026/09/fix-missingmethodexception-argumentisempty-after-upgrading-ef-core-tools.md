---
title: "Fix: MissingMethodException 'AbstractionsStrings.ArgumentIsEmpty' after upgrading EF Core Tools"
description: "dotnet ef throws MissingMethodException on ArgumentIsEmpty because Tools 10.0.6 stopped pulling a matching Microsoft.EntityFrameworkCore.Design. Pin Design explicitly to your EF Core version."
pubDate: 2026-09-08
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "entity-framework"
  - "dotnet"
  - "dotnet-10"
  - "nuget"
---

Add an explicit `PackageReference` for `Microsoft.EntityFrameworkCore.Design` pinned to the same version as the rest of your EF Core packages, in the **startup project**, then restore. `Microsoft.EntityFrameworkCore.Tools` 10.0.6, 10.0.7 and 10.0.8 lowered their dependency on Design to `>= 8.0.0`, so NuGet happily resolves Design 8.0.0 next to an EF Core 10 runtime and the design-time assembly calls a method that no longer exists. Upgrading Tools to 10.0.9 or later also fixes it, because 10.0.9 restored per-framework version alignment.

## The error in context

Running `dotnet ef migrations add` against a broken package graph:

```
Build started...
Build succeeded.
System.MissingMethodException: Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
   at Microsoft.EntityFrameworkCore.Utilities.Check.NotEmpty(String value, String parameterName)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.AddMigration.<>c__DisplayClass0_0.<.ctor>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.<>c__DisplayClass3_0`1.<Execute>b__0()
   at Microsoft.EntityFrameworkCore.Design.OperationExecutor.OperationBase.Execute(Action action)
Method not found: 'System.String Microsoft.EntityFrameworkCore.Diagnostics.AbstractionsStrings.ArgumentIsEmpty(System.Object)'.
```

The exact same package graph produces a completely different exception from `dotnet ef database update` or `dotnet ef migrations list`:

```
System.TypeLoadException: Method 'Identifier' in type 'Microsoft.EntityFrameworkCore.Design.Internal.CSharpHelper' from assembly 'Microsoft.EntityFrameworkCore.Design, Version=8.0.26.0, Culture=neutral, PublicKeyToken=adb9793829ddae60' does not have an implementation.
   at Microsoft.EntityFrameworkCore.Design.DesignTimeServiceCollectionExtensions.<>c__DisplayClass0_0.<AddEntityFrameworkDesignTimeServices>b__0(ServiceCollectionMap services)
   at Microsoft.EntityFrameworkCore.Infrastructure.EntityFrameworkServicesBuilder.TryAddProviderSpecificServices(Action`1 serviceMap)
```

In Visual Studio's Package Manager Console the same thing surfaces from `Add-Migration` and `Update-Database`. Both messages have one cause. The `TypeLoadException` is the more useful of the two, because it prints the offending assembly version right in the message.

## Why this happens

`Microsoft.EntityFrameworkCore.Design` is the assembly that actually implements migrations scaffolding and reverse engineering. Neither `dotnet ef` nor the Package Manager Console ships it: they load it out of your startup project's resolved dependency graph. So the Design version is whatever NuGet picked, and NuGet picks the lowest version that satisfies every constraint.

Until 10.0.5, `Microsoft.EntityFrameworkCore.Tools` declared a dependency on `Microsoft.EntityFrameworkCore.Design` with a floor equal to its own version, so referencing Tools was enough to drag in a matching Design. In 10.0.6 that floor dropped to `8.0.0`. You can read the change straight off the NuGet catalog:

| Tools version | Published | Design dependency |
| --- | --- | --- |
| 10.0.5 | 2026-03-12 | `net8.0` -> `[10.0.5, )` |
| 10.0.6 | 2026-04-14 | `net8.0` -> `[8.0.0, )` |
| 10.0.7 | 2026-04-21 | `net8.0` -> `[8.0.0, )` |
| 10.0.8 | 2026-05-12 | `net8.0` -> `[8.0.0, )` |
| 10.0.9 | 2026-06-09 | `net8.0` -> `[8.0.26, )`, `net9.0` -> `[9.0.15, )`, `net10.0` -> `[10.0.9, )` |
| 10.0.10 | 2026-07-14 | same shape, `net10.0` -> `[10.0.10, )` |
| 10.0.11 | 2026-08-11 | same shape, `net10.0` -> `[10.0.11, )` |

The reason for the 10.0.6 change was legitimate. The Tools package targets `net8.0` and is meant to be usable from `net8.0`, `net9.0` and `net10.0` projects, but Design 10.0.x only ships a `net10.0` asset, so a single high floor broke restore for projects on older frameworks. Lowering the floor to `8.0.0` fixed restore and broke everyone whose EF Core runtime was 9.x or 10.x, because a single `net8.0` dependency group applies to every consuming framework. Tools 10.0.9 solved it properly with three dependency groups, one per target framework.

The failure is a plain binary compatibility break. `Check.NotEmpty` in EF Core 10 calls `AbstractionsStrings.ArgumentIsEmpty(object)`; the 8.x and 9.x builds of that resource class expose a different signature. The JIT resolves the call at the first execution of `AddMigrationImpl` and throws.

## Minimal repro

Two package references and a `DbContext` are enough. This is the whole project, verified on SDK 10.0.302 with `dotnet-ef` 10.0.11 on 2026-09-08:

```xml
<!-- SDK 10.0.302. Reproduces the failure exactly as written. -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 10, EF Core 10.0.11
using Microsoft.EntityFrameworkCore;

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlite("Data Source=app.db");
}
```

After `dotnet restore`, the graph looks like this:

```
$ dotnet list package --include-transitive
   > Microsoft.EntityFrameworkCore              10.0.11
   > Microsoft.EntityFrameworkCore.Abstractions 10.0.11
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

Everything runtime-side is 10.0.11 and the design-time assembly is 8.0.0. `dotnet ef migrations add Initial` then throws.

## Fix, in detail

### 1. Pin Design explicitly in the startup project

This is the fix the EF team recommends, and it is the one that keeps working no matter what future Tools releases declare:

```xml
<!-- SDK 10.0.302, EF Core 10.0.11. Version must match your other EF Core packages. -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

`PrivateAssets=all` keeps the design-time assembly out of your published output, which is why the metadata block is worth typing out rather than using the bare one-liner. With this in place, `dotnet ef migrations add Initial` succeeds even with Tools still on 10.0.6.

The word **startup** matters. `dotnet ef` builds and loads the startup project, not the project that holds your `DbContext`. In a solution where `Data` owns the context and `Api` is the entry point, pinning Design inside `Data` does nothing, because `PrivateAssets=all` stops it flowing across the project reference:

```
$ dotnet list Api/Api.csproj package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       8.0.0
```

The command still fails with the same `MissingMethodException`. Move the reference into `Api` and it passes. If you keep design-time packages in the context project by convention, add the reference in both.

### 2. Or upgrade Tools to 10.0.9 or later

If you would rather not add a package reference, upgrading the Tools package is enough on its own, because 10.0.9 restored per-framework alignment:

```
$ dotnet list package --include-transitive | grep Design
   > Microsoft.EntityFrameworkCore.Design       10.0.9
```

The caveat: you get the Tools package's floor, not your EF Core version. Tools 10.0.9 next to EF Core 10.0.11 gives you Design 10.0.9, which works, but it is a version skew you did not choose. Fix 1 is still the better habit.

### 3. Or roll Tools back to 10.0.5

Downgrading to 10.0.5 restores the old matching-version dependency and is a valid emergency stop if you are mid-release and cannot touch project files broadly. It is a dead end though: 10.0.5 predates several months of tooling fixes, and any later upgrade puts you straight back into the broken window unless you also do fix 1.

### 4. Central Package Management

Under CPM the version lives in `Directory.Packages.props`, and the same rule applies: declare Design there and reference it from the startup project.

```xml
<!-- Directory.Packages.props, EF Core 10.0.11 -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Sqlite" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.11" />
  <PackageVersion Include="Microsoft.EntityFrameworkCore.Tools" Version="10.0.11" />
</ItemGroup>
```

A `PackageVersion` entry alone does not add the package. It only sets the version if something references it. If Design reaches the graph transitively through Tools, `CentralPackageTransitivePinningEnabled` set to `true` will lift the transitive Design to the version you declared, which is a reasonable second line of defence for a large solution.

## How to confirm which Design version the tool will load

Do not trust `dotnet ef --version`. It reports the global tool, which is independent of the project graph:

```
$ dotnet ef --version
Entity Framework Core .NET Command-line Tools
10.0.11
```

That prints 10.0.11 while the project loads Design 8.0.0. Two commands give the real answer. The first shows the resolved version and who asked for it:

```
$ dotnet nuget why . Microsoft.EntityFrameworkCore.Design
Project 'EfToolsRepro' has the following dependency graph(s) for
'Microsoft.EntityFrameworkCore.Design':

  [net10.0]
  └── Microsoft.EntityFrameworkCore.Tools (v10.0.6)
      └── Microsoft.EntityFrameworkCore.Design (v8.0.0)
```

`dotnet nuget why` needs the .NET 9 SDK or later and is the fastest way to find out which package is dragging the old Design in, which is not always Tools. Any library in your solution that references Design directly with an old floor can do the same thing.

The second check reads the build output, which is what the tooling actually resolves against:

```
$ grep -o '"Microsoft.EntityFrameworkCore.Design/[0-9.]*"' bin/Debug/net10.0/Api.deps.json
"Microsoft.EntityFrameworkCore.Design/8.0.0"
```

Note that the Design assembly itself is not copied to `bin`. It is resolved from the NuGet global packages folder through the entry in `deps.json`, so looking for the DLL next to your executable tells you nothing.

## Gotchas and lookalike errors

**Some commands still work, which is why people rule out a package problem too early.** With Design 8.0.26 alongside EF Core 10.0.11, `dotnet ef dbcontext info` prints the context, provider and data source without complaint, and `dotnet ef dbcontext script` emits correct SQL. Only the code paths that touch the mismatched types blow up. Do not conclude that your tooling is aligned because one command returned successfully.

**Read the `AddMigrationImpl` signature in the stack trace.** It fingerprints the loaded Design version without any further investigation. Design 9.x has a `Boolean dryRun` parameter that 8.x and 10.x do not:

```
// Design 9.0.15
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace, Boolean dryRun)

// Design 8.0.26
at ...OperationExecutor.AddMigrationImpl(String name, String outputDir, String contextType, String namespace)
```

**"Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design" is a different error with an adjacent cause.** That one means Design is absent entirely rather than present at the wrong version. It is worth knowing that `Microsoft.EntityFrameworkCore.Tools` 11.0.0-preview.7.26381.103, published 2026-08-11, declares an empty `net10.0` dependency group: no Design dependency at all. If you carry the habit of referencing only Tools into an EF Core 11 upgrade, you will meet [the startup project doesn't reference Design error](/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/) instead of this one. The explicit pin from fix 1 covers both.

**"Unable to create an object of type 'DbContext'" is unrelated.** That is a design-time factory or host-builder problem, not a version mismatch. If your stack trace mentions `DbContextActivator` or a missing `IDesignTimeDbContextFactory`, you want [the DbContext creation troubleshooting path](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) rather than this page.

**`MissingMethodException` at application runtime rather than at design time.** If the exception fires from your web app rather than from `dotnet ef`, the culprit is usually a library compiled against a different EF Core major version, not the Design package. The diagnosis is the same, though: run `dotnet nuget why` on `Microsoft.EntityFrameworkCore` and look for a package holding an old floor.

**A migrations bundle inherits the problem.** Since `dotnet ef migrations bundle` runs the same design-time stack to build the executable, a broken graph can produce a bundle from a stale model or fail outright. Fix the reference before you generate the artifact you plan to run against production, as described in the [migrations bundle deployment walkthrough](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/).

## What to do on an EF Core 11 upgrade

EF Core 11 is in preview as of September 2026 and ships with .NET 11 in November 2026. Because the only SDK on this machine is 10.0.302, every command output above was produced against EF Core 10.0.11, not 11. What is verifiable today from the NuGet catalog is the dependency shape: Tools 11.0.0-preview.7 has no package dependencies whatsoever. Treat `Microsoft.EntityFrameworkCore.Design` as a package you always declare yourself, at the exact version of your other EF Core packages, and this class of failure stops being possible regardless of what Tools declares. That is a one-line change worth making before you start [the broader .NET 11 migration work](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), because a migrations command that fails halfway through an upgrade is very hard to attribute to a NuGet floor.

The general rule this incident illustrates: keep every `Microsoft.EntityFrameworkCore.*` package on one version, including the ones you never `using`. EF Core does not support mixing majors across its own assemblies, and the tooling gives you no warning when NuGet quietly resolves a graph that mixes them.

## Related

- [Fix: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/)
- [Fix: dotnet tool install --global dotnet-ef throws an error](/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [Fix: dotnet ef migrations add fails with "Unable to create an object of type DbContext"](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [How to apply EF Core 11 migrations in production with a migrations bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Fix: "The model for context 'X' has pending changes" in EF Core 11](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)

## Sources

- [dotnet/efcore#38124, Announcement: Microsoft.EntityFrameworkCore.Tools 10.0.6 Design package dependency change](https://github.com/dotnet/efcore/issues/38124)
- [dotnet/efcore#38107, Add-Migration exception: AbstractionsStrings.ArgumentIsEmpty](https://github.com/dotnet/efcore/issues/38107)
- [dotnet/efcore#38123, closed as a duplicate of 38107, with the TypeLoadException variant](https://github.com/dotnet/efcore/issues/38123)
- [Microsoft.EntityFrameworkCore.Tools on NuGet, dependency groups per version](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore.Tools/)
- [Entity Framework Core tools reference for the .NET CLI](https://learn.microsoft.com/en-us/ef/core/cli/dotnet)
- [dotnet nuget why command reference](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-nuget-why)
