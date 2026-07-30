---
title: "Fix: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design"
description: "Add Microsoft.EntityFrameworkCore.Design to the startup project that dotnet ef builds, not the project holding your DbContext, and pass -s in layered solutions."
pubDate: 2026-07-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
---

Add the package to the **startup project**, which is the project `dotnet ef` builds and runs, not the class library that holds your `DbContext`: `dotnet add package Microsoft.EntityFrameworkCore.Design`. In a layered solution, also tell the tools which project that is with `-s ./src/Api`. Since `Microsoft.EntityFrameworkCore.Tools` 10.0.6 the Design package is no longer pulled in for you.

```text
Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design. This package is required for the Entity Framework Core Tools to work. Ensure your startup project is correct, install the package, and try again.
```

This post is written against EF Core 11.0.0-preview.6 (`11.0.0-preview.6.26359.118`, 2026-07-14), the .NET 11 SDK preview 6, and C# 14, with notes on EF Core 9 and 10 where the tooling behaves differently. The current stable line is 10.0.10. The error string itself has not changed since EF Core 2.1, but **how** the tools decide the package is missing changed substantially in EF Core 10, and that determines which of the fixes below applies to you.

## What the tools are actually complaining about

The message reads like a static check on your `.csproj`. It is not. It is a load failure, reported after the fact.

Here is the real sequence when you run `dotnet ef migrations add Init`:

1. `dotnet-ef` runs a metadata build of the startup project. On EF Core 10 and 11 that is `dotnet build --no-restore /getProperty:AssemblyName /getProperty:OutputPath ... /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems`.
2. It scans the returned `RuntimeCopyLocalItems` for a `FullPath` containing `Microsoft.EntityFrameworkCore.Design` and keeps that absolute path.
3. It builds the startup project, then shells out to `ef.dll`, passing the path it found as `--design-assembly`, along with the project's `.deps.json` and `.runtimeconfig.json` so the tool process emulates your app's assembly loading.
4. `ef.dll` loads `Microsoft.EntityFrameworkCore.Design.dll` into an `AssemblyLoadContext`: from that path if it got one, otherwise by plain assembly name.
5. If step 4 throws a `FileNotFoundException` and the missing assembly name is exactly `Microsoft.EntityFrameworkCore.Design`, the tool swallows it and prints the friendly message above, naming the startup assembly.

Two consequences fall straight out of that. First, the project named in the message is the **startup** project, so if that name surprises you, your problem is step 1, not a missing package. Second, a `PackageReference` that exists but does not produce a copy-local runtime asset is invisible to step 2, which is why people paste their `.csproj` into issue reports and insist the package is right there.

EF Core 9 and earlier worked differently: `dotnet-ef` injected an embedded `EntityFrameworkCore.targets` file into the project and `ef.dll` resolved Design by assembly name through the startup project's `.deps.json`. That distinction matters for one specific failure mode covered below.

## Minimal repro

A two-project layered solution, which is the layout that produces this error most often:

```text
Shop.sln
  src/Shop.Api/Shop.Api.csproj          <- startup project, has Program.cs
  src/Shop.Data/Shop.Data.csproj        <- has AppDbContext and Migrations/
```

```xml
<!-- src/Shop.Data/Shop.Data.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

```xml
<!-- src/Shop.Api/Shop.Api.csproj - .NET 11, EF Core 11.0.0-preview.6 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../Shop.Data/Shop.Data.csproj" />
  </ItemGroup>
</Project>
```

```bash
# .NET 11 SDK preview 6
cd src/Shop.Data
dotnet ef migrations add Init -s ../Shop.Api
# Your startup project 'Shop.Api' doesn't reference Microsoft.EntityFrameworkCore.Design.
```

The Design package is referenced. It is referenced in the wrong project, and it cannot travel.

## Fix 1: reference Design in the startup project

This is the fix in almost every case. Run it from the startup project directory:

```bash
# .NET 11 SDK preview 6, EF Core 11
dotnet add src/Shop.Api/Shop.Api.csproj package Microsoft.EntityFrameworkCore.Design
```

NuGet writes this, because Design is marked `developmentDependency` in its nuspec:

```xml
<!-- src/Shop.Api/Shop.Api.csproj - EF Core 11.0.0-preview.6 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>all</PrivateAssets>
  <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
</PackageReference>
```

Read that `IncludeAssets` list carefully, because it explains both halves of the problem:

- `runtime` **is** in the list. That is what puts `Microsoft.EntityFrameworkCore.Design.dll` in your `bin` folder and therefore into `RuntimeCopyLocalItems`, which is what the tools look for. Do not remove it.
- `compile` is **not** in the list. You cannot reference Design types from your application code, which is intentional: it is a design-time package and nothing in your shipping code should bind to it.
- `PrivateAssets: all` means the reference **does not flow transitively**. That is the entire reason Fix 1 exists as a separate step from having the package in your data project.

## Fix 2: point the tools at the right startup project

If the project name in the error is not the project you meant, the package is fine and the target is wrong. The rule from the EF Core CLI docs: the *target project* is where files get written (`--project`, `-p`, defaults to the current directory), and the *startup project* is the one the tools build and execute to discover your connection string and model (`--startup-project`, `-s`, also defaults to the current directory).

```bash
# EF Core 11, run from the repository root
dotnet ef migrations add Init -p src/Shop.Data -s src/Shop.Api
```

Typing that on every command is how teams end up with the package bolted onto the wrong project just to make the error go away. EF Core 11 adds a config file for exactly this, discovered by walking up from the current directory to the first `.config/dotnet-ef.json` it finds:

```json
{
  "project": "src/Shop.Data",
  "startupProject": "src/Shop.Api"
}
```

Relative paths resolve against the parent of the `.config` directory, so put the file at your repository root and every `dotnet ef` invocation from any subdirectory picks it up. Explicit command-line options still win over the file. Only the documented keys are accepted: `project`, `startupProject`, `context`, `framework`, `configuration`, `runtime`, `verbose`, `noColor`, `prefixOutput`. An unknown key is a hard error, not a warning, so a typo like `startProject` fails the command outright.

## Fix 3: stop trying to make the data project's reference flow

Every so often someone finds this trick and it does work:

```xml
<!-- src/Shop.Data/Shop.Data.csproj - do not do this -->
<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118">
  <PrivateAssets>none</PrivateAssets>
</PackageReference>
```

Setting `PrivateAssets` to `none` makes the reference flow into `Shop.Api` transitively, and the error disappears. It also drags Roslyn into every project that references your data layer, because Design depends on `Microsoft.CodeAnalysis.CSharp` and `Microsoft.CodeAnalysis.CSharp.Workspaces` (5.0.0 or later on the 10.0.10 package), plus `Microsoft.Build.Framework`, `Humanizer.Core`, `Mono.TextTemplating`, and `Newtonsoft.Json`. You have moved a code-generation toolchain into your runtime dependency graph to save one line in one `.csproj`. Take the explicit reference in the startup project instead.

## The version-mismatch variant since Tools 10.0.6

If you install `Microsoft.EntityFrameworkCore.Tools` (the Package Manager Console module) and expect it to bring Design along, that assumption expired. Before 10.0.6, Tools depended on a matching Design version. That broke restore for projects targeting `net8.0`, because Design 10.0.x only targets `net10.0`, so the EF team lowered the floor to Design 8.0.0 in Tools 10.0.6. On the EF Core 11 branch, `Microsoft.EntityFrameworkCore.Tools` carries no `PackageReference` to Design at all.

The practical result is that NuGet can now resolve an old Design version that satisfies the floor, and the symptom is not this error, it is:

```text
System.MissingMethodException: Method not found ...
System.TypeLoadException: Could not load type ...
```

The fix is an explicit, version-matched reference. With central package management, pin it once:

```xml
<!-- Directory.Packages.props - EF Core 11.0.0-preview.6 -->
<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-preview.6.26359.118" />
    <PackageVersion Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0-preview.6.26359.118" />
  </ItemGroup>
</Project>
```

Central package management is also its own trap here: a `PackageVersion` entry in `Directory.Packages.props` is not a reference. The startup project still needs `<PackageReference Include="Microsoft.EntityFrameworkCore.Design" />` with no `Version` attribute. Keep `dotnet-ef` itself in step too, since a 10.x tool driving an 11.x Design assembly is a separate class of failure:

```bash
dotnet tool update --global dotnet-ef --version 11.0.0-preview.6.26359.118
```

## When the reference is right there and it still fails

Run the same query the tools run and look at the answer yourself. The `-getItem` switch needs the .NET 8 SDK or later:

```bash
# .NET 11 SDK preview 6
dotnet build src/Shop.Api/Shop.Api.csproj --no-restore \
  /t:ResolvePackageAssets /getItem:RuntimeCopyLocalItems
```

If `Microsoft.EntityFrameworkCore.Design.dll` is not in that JSON, EF Core 10 and 11 cannot see it, no matter what the `.csproj` says. The usual culprits are asset-flow attributes someone copied from an analyzer-only package:

- `<ExcludeAssets>runtime</ExcludeAssets>` or `<ExcludeAssets>all</ExcludeAssets>` on the Design reference.
- An `<IncludeAssets>` list that drops `runtime`, for example `build; analyzers`.
- `<PackageReference ... GeneratePathProperty="true" ExcludeAssets="all" />`, a pattern that shows up when someone wants only the package's tools directory.

Add `-v` for the tool's own account of what it resolved. Verbose output prints the full metadata build command and the design assembly path it settled on, which turns a guessing game into a two-line diagnosis:

```bash
dotnet ef migrations add Init -s src/Shop.Api -v
```

The one case where a correct `.csproj` genuinely was not enough: on EF Core 9 with certain .NET 9 SDK builds, [dotnet/sdk#45259](https://github.com/dotnet/sdk/pull/45259) stopped emitting `PackageReference` entries marked `PrivateAssets="all"` into `.deps.json`. Since EF Core 9's `ef.dll` resolved Design by assembly name through that file, the tools lost the package ([dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265), with [#35544](https://github.com/dotnet/efcore/issues/35544) as one of its duplicates). It was fixed in EF Core 10 by [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527), which registers an `AssemblyLoadContext.Resolving` handler that probes the app base path, alongside the explicit `--design-assembly` path described earlier. If you are stuck on an EF Core 9 project hitting this, upgrading the global `dotnet-ef` tool to 10 or later is enough, because the tools are version-independent of the runtime packages they drive.

## Gotchas and lookalikes

**Scaffolded projects that shipped without the package.** Early .NET 11 preview 3 SDK builds generated `dotnet new mvc --auth Individual` projects with no Design reference, a regression from preview 2 tracked as [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750). It stopped reproducing as of SDK `11.0.100-preview.3.26166.111`. If a project was scaffolded during that window, the template is the culprit and Fix 1 is all you need.

**A `netstandard2.0` class library as the startup project.** The tools have to execute application code, which requires a real runtime, and .NET Standard is a specification rather than an implementation. Adding Design will not help. Create a throwaway console project that references the library and use it as `-s`.

**A platform-specific target framework.** With `net11.0-android` or `net11.0-ios` you get a different message about a platform-specific framework, and the documented answer is to implement `IDesignTimeDbContextFactory<TContext>` so the tools never need to boot your app.

**`NETSDK1004` in verbose output.** The metadata build runs with `--no-restore`. If the project was never restored, `dotnet-ef` reports that a restore is required rather than a missing package. Run `dotnet restore` and retry.

**Multi-targeting.** `dotnet-ef` picks the first target framework and re-invokes itself. If Design is conditioned on one TFM and the first one is not it, pass `--framework net11.0` explicitly.

**`Unable to create an object of type 'AppDbContext'`.** Different error, different cause. The Design assembly loaded fine and then the tools could not instantiate your context. That is covered in [the guide to design-time DbContext discovery](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/).

**CI containers.** The `dotnet/sdk` image, not `dotnet/aspnet`, and `dotnet tool install --global dotnet-ef` before any `dotnet ef` call. If your pipeline only needs to apply migrations rather than create them, skip the tool entirely and ship a migration bundle.

## The layout that never hits this

Four rules, and this error stops appearing in your solution:

1. `Microsoft.EntityFrameworkCore.Design` is referenced by the startup project, with the default `PrivateAssets` and `IncludeAssets` that `dotnet add package` writes.
2. The provider package (`Microsoft.EntityFrameworkCore.SqlServer`, `Npgsql.EntityFrameworkCore.PostgreSQL`, and so on) is reachable from the startup project, transitively through the data project is fine.
3. All EF Core package versions and the `dotnet-ef` tool version match, ideally pinned in `Directory.Packages.props`.
4. `.config/dotnet-ef.json` records `project` and `startupProject` so nobody has to remember `-p` and `-s`.

## Related

- [Why the design-time tools cannot instantiate your DbContext](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) covers the error you hit immediately after fixing this one.
- [Shipping schema changes with migration bundles](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) is the design-time command this package also gates, and the way to keep `dotnet-ef` off production machines.
- [The PendingModelChangesWarning and what it actually detects](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) is the next thing CI will tell you about once migrations run.
- [Registering DbContextOptions correctly](/2026/06/fix-no-service-for-type-dbcontextoptions-has-been-registered/) explains the DI-side failure that looks similar in a layered solution.
- [Breaking changes moving from EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) includes the tooling changes worth knowing before you upgrade.

## Sources

- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), including the target-versus-startup project rules and the EF Core 11 `dotnet-ef.json` configuration file.
- [Design-time tools architecture](https://learn.microsoft.com/en-us/ef/core/miscellaneous/internals/tools) for the `dotnet-ef` to `ef.dll` to `EFCore.Design.dll` chain.
- [`src/dotnet-ef/Project.cs`](https://github.com/dotnet/efcore/blob/main/src/dotnet-ef/Project.cs) and [`src/ef/Commands/ProjectCommandBase.cs`](https://github.com/dotnet/efcore/blob/main/src/ef/Commands/ProjectCommandBase.cs) for the `RuntimeCopyLocalItems` lookup and the exact point where the `FileNotFoundException` becomes this message.
- [Announcement: Microsoft.EntityFrameworkCore.Tools 10.0.6 Design package dependency change](https://github.com/dotnet/efcore/issues/38124).
- [dotnet/efcore#35265](https://github.com/dotnet/efcore/issues/35265) and [dotnet/efcore#35527](https://github.com/dotnet/efcore/pull/35527) for the `.deps.json` and `PrivateAssets` regression.
- [dotnet/aspnetcore#65750](https://github.com/dotnet/aspnetcore/issues/65750) for the .NET 11 preview 3 template regression.
