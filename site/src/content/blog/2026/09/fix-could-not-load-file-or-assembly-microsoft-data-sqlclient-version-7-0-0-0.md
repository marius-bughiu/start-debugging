---
title: "Fix: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0' after updating EF Core"
description: "EF Core 11 is compiled against Microsoft.Data.SqlClient 7.0.0.0, but a 6.x copy won the restore or the deploy. Remove the old SqlClient pin and redeploy the full output."
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet"
  - "dotnet-11"
---

**Short answer:** `Microsoft.EntityFrameworkCore.SqlServer` 11 (checked on `11.0.0-rc.1.26425.128`, .NET 11 RC 1) is compiled against `Microsoft.Data.SqlClient, Version=7.0.0.0` and requires the 7.0.2 package or newer. The exception means the process found a 6.x SqlClient, or none at all. Delete the leftover `Microsoft.Data.SqlClient` 6.x reference (or its `PackageVersion` in `Directory.Packages.props`), remove any `NoWarn` for `NU1605`, rebuild, and redeploy the entire output folder, `runtimes/` included.

The rest of this post shows where the 6.x copy comes from, how to find it in under a minute, and the two lookalike errors that land people on the wrong fix. Every scenario below was reproduced on macOS with the .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) and SDK 10.0.302; no database is needed to trigger it.

## The error in context

EF Core does not touch SqlClient when you register the context. The load happens the first time the provider builds its type mappings, which is the first query, `SaveChanges`, `MigrateAsync`, or `Database.GetDbConnection()`. Here is the exception chain my repro printed, outermost first:

```text
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerTypeMappingSource' threw an exception.
System.TypeInitializationException: The type initializer for 'Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerVectorTypeMapping' threw an exception.
System.IO.FileNotFoundException: Could not load file or assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5'. The system cannot find the file specified.
```

If your logs only show the outer `TypeInitializationException`, unwrap `InnerException` twice. The `FileNotFoundException` at the bottom is the real error.

One thing to know before you start: `Version=7.0.0.0` is an **assembly** version, not a package version. SqlClient pins `AssemblyVersion` to `Major.0.0.0` for every release in a major line, so the 7.0.3 package ships a DLL whose assembly version is `7.0.0.0` (file version `7.0.3.26253`). The maintainers confirmed this is deliberate in [dotnet/SqlClient#4310](https://github.com/dotnet/SqlClient/issues/4310). Any 7.x package satisfies the reference. You do not need to hunt down "exactly 7.0.0".

## Why this happens

The runtime binds by assembly version, and it only rolls forward, never back. When EF Core 11 asks for `7.0.0.0` and the only `Microsoft.Data.SqlClient.dll` on the probing path is a 6.x build (assembly version `6.0.0.0`), the load fails. It fails with the misleading "cannot find the file specified" even when a 6.x file sits at the exact path the `.deps.json` points to. I tested that explicitly: dropping the 6.1.6 DLL over the 7.0.2 one in the output produces the identical message.

This is what each package compiles against, read straight from the assembly metadata in the NuGet packages:

| Package | SqlClient package dependency | Assembly reference in the DLL |
| --- | --- | --- |
| `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10, 10.0.11, 10.0.12 | `>= 6.1.x` (10.0.12: `>= 6.1.6`) | `Microsoft.Data.SqlClient 6.0.0.0` |
| `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 | `>= 7.0.2` | `Microsoft.Data.SqlClient 7.0.0.0` |

So on EF Core 10 the provider itself never asks for 7.0.0.0. On EF Core 11 it always does. Ranked by how often I see them, the ways a 6.x copy wins anyway are:

1. **A leftover direct reference to `Microsoft.Data.SqlClient` 6.x, with the downgrade warning silenced.** Lots of EF Core 8 to 10 projects added an explicit SqlClient reference to pick up a fix or Entra ID support. After the EF bump that pin is a downgrade. NuGet reports it as `NU1605`, which the SDK treats as an error, unless the project has `<NoWarn>NU1605</NoWarn>` from some earlier conflict.
2. **The deployment drops or replaces the DLL.** SqlClient has no portable implementation. The real assemblies live under `runtimes/unix/lib/net9.0/` and `runtimes/win/lib/net9.0/`. A Dockerfile or copy script that only takes `*.dll` from the root of `bin/`, or that unzips a new build over an old folder, leaves the app with no 7.x SqlClient.
3. **A plug-in host loads your data layer dynamically.** The host process has no `.deps.json` entry for SqlClient, so its default load context cannot resolve the plug-in's dependencies.

## Minimal repro

A console app that was on EF Core 10 with a SqlClient pin, updated to EF Core 11 RC 1. The `NoWarn` is the line that turns a build error into a runtime crash:

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <NoWarn>$(NoWarn);NU1605</NoWarn>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
    <PackageReference Include="Microsoft.Data.SqlClient" Version="6.1.6" />
  </ItemGroup>
</Project>
```

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
using Microsoft.EntityFrameworkCore;

var options = new DbContextOptionsBuilder<ShopDb>()
    .UseSqlServer("Server=localhost;Database=Shop;User ID=sa;Password=x;TrustServerCertificate=True")
    .Options;

using var db = new ShopDb(options);
// Throws the FileNotFoundException above; no server connection is attempted.
Console.WriteLine(db.Database.GetDbConnection().GetType().Assembly.GetName());

class ShopDb(DbContextOptions<ShopDb> options) : DbContext(options);
```

Remove the `NoWarn` line and the build stops at restore instead, which is what you want:

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to 6.1.6. Reference the package directly from the project to select a different version.
error NU1605:  app -> Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128 -> Microsoft.Data.SqlClient (>= 7.0.2)
error NU1605:  app -> Microsoft.Data.SqlClient (>= 6.1.6)
```

With the pin removed, the same program prints `Microsoft.Data.SqlClient, Version=7.0.0.0, Culture=neutral, PublicKeyToken=23ec7fc2d6eaa4a5`.

## Fix, in detail

### 1. Find out who ships the 6.x copy

Do not guess. Ask NuGet for the dependency graph of the startup project, not the class library:

```bash
# .NET SDK 10.0.302 or .NET 11 RC 1 SDK
dotnet nuget why src/Shop.Api/Shop.Api.csproj Microsoft.Data.SqlClient
dotnet list src/Shop.Api/Shop.Api.csproj package --include-transitive
```

`dotnet nuget why` prints a tree per target framework, so a direct 6.x reference, or a package that drags one in, is visible at a glance. Then check what actually got written for the runtime, since that is what the host reads:

```bash
# .NET 11 RC 1 SDK
grep -A3 '"Microsoft.Data.SqlClient/' src/Shop.Api/bin/Release/net11.0/Shop.Api.deps.json
```

If the `.deps.json` says `7.0.x` and the app still fails, the problem is the deployment (step 4), not the restore.

### 2. Remove or raise the SqlClient pin

If nothing in your code needs a specific SqlClient version, delete the direct reference and let EF Core bring the version it was built against. If you want to keep it explicit, raise it to the current 7.x:

```xml
<!-- .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 -->
<ItemGroup>
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <!-- Was 6.1.6. Any 7.x works; 7.0.3 is the latest stable at the time of writing. -->
  <PackageReference Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

With [Central Package Management](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/) and transitive pinning, the pin lives in `Directory.Packages.props`, and the restore error has a different code:

```text
error NU1109: Detected package downgrade: Microsoft.Data.SqlClient from 7.0.2 to centrally defined 6.1.6. Update the centrally managed package version to a higher version.
```

Update the `PackageVersion` entry itself:

```xml
<!-- .NET 11 RC 1, Directory.Packages.props -->
<ItemGroup>
  <PackageVersion Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0-rc.1.26425.128" />
  <PackageVersion Include="Microsoft.Data.SqlClient" Version="7.0.3" />
</ItemGroup>
```

### 3. Stop suppressing NU1605

Search the solution for `NU1605` in `NoWarn`, including `Directory.Build.props`. That suppression is the only reason this ever reaches runtime from a normal build. With it gone, the next person who reintroduces a downgrade gets a restore error with the exact package path instead of a production crash.

### 4. Redeploy the whole output, including `runtimes/`

For a framework-dependent build without a RID, SqlClient's real implementation sits under `runtimes/<os>/lib/net9.0/`, and the `.deps.json` points there. I deleted that one file from a working build and got the same `FileNotFoundException`, and deleting the whole `runtimes/` folder does the same. If your Dockerfile or pipeline copies selectively, switch to copying the full publish folder:

```dockerfile
# .NET 11 RC 1 images
FROM mcr.microsoft.com/dotnet/sdk:11.0 AS build
WORKDIR /src
COPY . .
RUN dotnet publish src/Shop.Api/Shop.Api.csproj -c Release -r linux-x64 --self-contained false -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:11.0
WORKDIR /app
COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "Shop.Api.dll"]
```

Publishing with a RID (`-r linux-x64`) flattens the platform-specific SqlClient into the root next to `Microsoft.Data.SqlClient.Extensions.Abstractions.dll` and `Microsoft.Data.SqlClient.Internal.Logging.dll`, which makes the layout much harder to break. For IIS, Azure App Service zip deploy, or xcopy deployments, deploy into a clean folder, so a 6.x DLL from the previous release cannot survive next to the new `.deps.json`. If you are unsure which of `dotnet build` and `dotnet publish` output you should be shipping, [the difference between the two](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) matters here.

### 5. Add the Azure extension if you use Entra ID

Moving to SqlClient 7.0 is listed as a medium-impact change in the [EF Core 11 breaking changes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes). Entra ID authentication (`Active Directory Default`, managed identity, service principal) moved out of the core package. Once the load error is fixed, a connection string that uses it needs one more reference:

```xml
<!-- .NET 11 RC 1, Microsoft.Data.SqlClient 7.x -->
<PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.3" />
```

Keep this package on the same version as `Microsoft.Data.SqlClient`. From 7.0.2 onward, SqlClient, `Extensions.Azure` and `Extensions.Abstractions` ship in lockstep, and SqlClient 7.0.2 requires `Extensions.Abstractions` in the range `[7.0.2, 8.0.0)`. NuGet has no 7.0.0 of the Azure package: its versions go 1.0.0, 7.0.2, 7.0.3, so a `Version="7.0.0"` you copied from a doc snippet does not resolve to that exact version. Without the package, 7.0 throws an actionable error that names it, so you will not be left guessing. The [EF Core 6 to 11 migration guide](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) covers this alongside the other SqlClient-driven changes.

### 6. Plug-in hosts: load through an `AssemblyLoadContext`

If a host with no reference to EF Core loads your data layer with `Assembly.LoadFrom`, the host's default context has no `.deps.json` entry for SqlClient. The maintainers' answer in [#4310](https://github.com/dotnet/SqlClient/issues/4310) is the standard plug-in pattern. Build the plug-in with `<EnableDynamicLoading>true</EnableDynamicLoading>` and load it through a context that reads the plug-in's own `.deps.json`:

```csharp
// .NET 11 RC 1
using System.Reflection;
using System.Runtime.Loader;

sealed class PluginLoadContext(string pluginPath) : AssemblyLoadContext(isCollectible: false)
{
    private readonly AssemblyDependencyResolver _resolver = new(pluginPath);

    protected override Assembly? Load(AssemblyName name)
    {
        var path = _resolver.ResolveAssemblyToPath(name);
        return path is null ? null : LoadFromAssemblyPath(path);
    }

    protected override IntPtr LoadUnmanagedDll(string unmanagedDllName)
    {
        var path = _resolver.ResolveUnmanagedDllToPath(unmanagedDllName);
        return path is null ? IntPtr.Zero : LoadUnmanagedDllFromPath(path);
    }
}

// var asm = new PluginLoadContext(pluginPath).LoadFromAssemblyPath(pluginPath);
```

In my test the same plug-in failed under `Assembly.LoadFrom` and loaded `Microsoft.Data.SqlClient, Version=7.0.0.0` cleanly through this context. The resolver matters for SqlClient in particular. It maps the request to the correct `runtimes/<os>/` file instead of the root-level placeholder assembly.

## Gotchas and lookalikes

**"But I am still on EF Core 10."** Then EF is not the one asking for 7.0.0.0. The 10.0.10 through 10.0.12 provider DLLs all reference `6.0.0.0`. That is why [dotnet/efcore#38845](https://github.com/dotnet/efcore/issues/38845), which reported this error after moving from 10.0.10 to 10.0.11, was closed without a repro. Something else in the graph is compiled against 7.x. Aspire is a common source. `Aspire.Microsoft.EntityFrameworkCore.SqlServer` 13.5.3 depends on `Microsoft.Data.SqlClient >= 7.0.1` and EF Core 10.0.11 at the same time, so `dotnet nuget why` on an Aspire service shows SqlClient resolved to 7.0.1 under an EF Core 10 app. That combination is fine: EF Core 10.0.12 initialized its type mappings and created a `SqlConnection` on both SqlClient 7.0.0 and 7.0.3 in my test. It only breaks when a 6.x pin or a stale deployment wins, which brings you back to steps 1 to 4.

**`Could not load type 'Microsoft.Data.SqlClient.SqlAuthenticationMethod' from assembly 'Microsoft.Data.SqlClient, Version=7.0.0.0'`.** This is a different failure with the same version string. The file loaded fine, but a library compiled against 6.x (SQL Server Management Objects 181.x was the common one) looked for a type that 7.0.0 moved to `Microsoft.Data.SqlClient.Extensions.Abstractions`. SqlClient 7.0.1 added type forwards for `SqlAuthenticationMethod`, `SqlAuthenticationProvider` and three related types ([#4117](https://github.com/dotnet/SqlClient/pull/4117)), so updating SqlClient to 7.0.1 or later fixes it.

**`PlatformNotSupportedException: Microsoft.Data.SqlClient is not supported on this platform.`** The file was found, but it was the wrong one. The package's root `lib/` assembly is a placeholder, and the working implementation lives under `runtimes/`. My plug-in host hit exactly this with `Assembly.LoadFrom`, because the plug-in's root folder contained the placeholder. The fix is the same `AssemblyLoadContext` as in step 6, or a full deployment with the RID-specific assets.

**A different assembly name in the message.** If the error names your own library or another package, the SqlClient specifics above do not apply. The general playbook for [a "Could not load file or assembly" error in a published app](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/) covers host tracing and trimming. For the EF tooling version of a mismatch, where `dotnet ef` fails rather than your app, see [the MissingMethodException after upgrading EF Core Tools](/2026/09/fix-missingmethodexception-argumentisempty-after-upgrading-ef-core-tools/).

## Related

- [Migrate a .NET solution to Central Package Management with Directory.Packages.props](/2026/08/migrate-a-dotnet-solution-to-central-package-management-with-directory-packages-props/)
- [Migrate EF Core 6 to EF Core 11: the breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix FileNotFoundException "Could not load file or assembly" in a published app](/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)
- [The native json column vs nvarchar(max) in SQL Server with EF Core 11](/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/), which shows SqlClient 7's `SqlDbType.Json` in action
- [What is the difference between dotnet build and dotnet publish](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/)

## Sources

- [Breaking changes in EF Core 11: Microsoft.Data.SqlClient has been updated to 7.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Microsoft.Data.SqlClient 7.0.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md) and [7.0.1 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.1.md)
- [dotnet/SqlClient#4310: assembly version stays 7.0.0.0 across 7.x, plug-in loading guidance](https://github.com/dotnet/SqlClient/issues/4310)
- [dotnet/efcore#38845: the EF Core 10.0.11 report](https://github.com/dotnet/efcore/issues/38845)
- [dotnet/SqlClient#4064](https://github.com/dotnet/SqlClient/issues/4064) and [#4117](https://github.com/dotnet/SqlClient/pull/4117): the `SqlAuthenticationMethod` type forwards
- [NuGet warning NU1605](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1605) and [error NU1109](https://learn.microsoft.com/en-us/nuget/reference/errors-and-warnings/nu1109)
- [Create a .NET application with plugins](https://learn.microsoft.com/en-us/dotnet/core/tutorials/creating-app-with-plugin-support) and [Default probing](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/default-probing)
