---
title: "Migrate from .NET 8 to .NET 11: the full checklist"
description: "Plan a .NET 8 migration using the current .NET 11 RC3 status, an exact SDK pin, verified compatibility guidance, deployment checks, and rollback."
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
---

**Correction — 2 November 2026:** .NET 11 was incorrectly described as a released LTS version. This checklist also corrects SDK pinning, package selection, hosting, serialization, EF collection queries, locking, and rollback advice. Earlier claims of migration results were not supported by recorded tests.

.NET 8 support ends on **10 November 2026**. The [current support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) lists .NET 10 as LTS and .NET 11 RC3 as a go-live prerelease. .NET 11 is an STS release line. If the goal is a supported LTS destination now, assess .NET 10; if you need .NET 11, explicitly accept its current release status and plan the next servicing update. An SDK upgrade alone does not upgrade deployed applications.

## 1. Capture the baseline and select the SDK

Record the deployed runtime, build SDK, operating system, package graph, test results, and representative production behavior. A green baseline helps find regressions but doesn't prove later failures are caused by the migration.

```bash
dotnet --info
dotnet --list-sdks
dotnet --version
dotnet list package --include-transitive
dotnet test -c Release
```

Run these commands from the solution directory with the intended SDK selected. [SDK selection](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json) is separate from the target framework. For an evaluation pinned to the full RC3 SDK version listed on the [download page](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), `global.json` is:

```json
{
  "sdk": {
    "version": "11.0.100-rc.3.26522.148",
    "rollForward": "disable",
    "allowPrerelease": true
  }
}
```

`disable` requires that exact SDK; `latestFeature` would allow later feature bands. Install the selected SDK on CI as well. This RC3 pin was checked against published metadata, not installed or executed for this article. Update it deliberately when moving to another release.

## 2. Retarget and review dependencies individually

For a minimal web project, the target shape is:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

This is a .NET 11 project definition, not a project tested here on .NET 11. Leave the language version at its SDK/TFM default unless the project has a reason to pin it. C# 14 belongs to .NET 10; don't present it as .NET 11's new language version.

Do **not** update every `Microsoft.*` package to version 11. Products have independent version lines. Check each package's supported target frameworks, dependencies, provider compatibility, and release status. Align EF Core packages, provider, design package, and tools as their documentation requires. Review `Directory.Packages.props` when central package management is enabled. A package targeting `net8.0` can remain compatible; NuGet does not automatically prefer an older .NET Standard asset just because the app targets a newer runtime.

## 3. Review every intervening change list

Read the [.NET 9](https://learn.microsoft.com/en-us/dotnet/core/compatibility/9.0), [.NET 10](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10.0), and [.NET 11](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11) compatibility lists, plus your framework/provider notes. The .NET 11 list explicitly remains a work in progress.

- **BinaryFormatter:** Since .NET 9, the built-in implementation throws; the API types still exist. Prefer another format. The [migration guide](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/) also describes reading NRBF payloads without constructing arbitrary serialized types. Conversion is not inherently restricted to running the old application on .NET 8.
- **Hosting:** `WebHostBuilder`, `IWebHost`, and `WebHost` were [marked obsolete in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/webhostbuilder-deprecated?view=aspnetcore-10.0). That is not evidence that all `IWebHostBuilder` or `ConfigureWebHostDefaults` code was removed. Prefer `WebApplication.CreateBuilder` for new code, and handle actual diagnostics.
- **EF queries:** For SQL Server, EF8 introduced the JSON-parameter collection strategy; [EF10's newer default uses scalar parameters](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection). Inspect SQL and execution plans against your real provider/database. Adding `ToList()` indiscriminately can move work into memory; it isn't a general translation fix.
- **Serialization and compilation:** Test real JSON contracts, dates, numeric values, enum handling, and polymorphism. Investigate specific compiler diagnostics, including span conversion changes, instead of assuming every array overload loses to a span overload.
- **Locks:** `System.Threading.Lock` and Monitor are both reentrant. A statically typed `Lock` uses a different mechanism from a reference cast to `object`; don't mix them for the same protected state. Changing locks is optional, not a retargeting requirement.
- **Hosted services:** Azure Functions has its own [support matrix](https://learn.microsoft.com/en-us/azure/azure-functions/dotnet-isolated-process-guide#supported-versions). At this review it lists .NET 10 as the highest isolated-worker target, and in-process support ends on 10 November 2026. Don't infer .NET 11 support from SDK availability.

## 4. Verify the deployed artifact

This complete `Program.cs` provides a small smoke endpoint; it does not configure a production application's authentication, controllers, or database:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

The health sample was built, published, and called successfully on .NET 8.0.33 and 10.0.10. `--self-contained false` requires a compatible runtime on the host. For self-contained deployment, choose a real target RID and `--self-contained true`; test that artifact on the destination OS. `/health` is not added automatically to arbitrary projects.

Beyond a smoke endpoint, exercise authentication, authorization, read/write contracts, database transactions, background jobs, and rollback in staging. Measure performance against an agreed workload. If using trimming or AOT, resolve the actual publish warnings and run the published result; annotations cannot make arbitrary runtime code generation work under Native AOT.

## 5. Keep rollback compatible

Retain the previous deployable artifact and configuration. Database schema, persisted payloads, messages, and authentication state determine whether old and new versions can coexist. A first write does not automatically make rollback impossible, and an SDK change alone does not create a database migration. Use compatible schema changes and rehearse traffic reversal before cutover.

**Verification limits:** No .NET 11 migration, EF/database upgrade, Azure deployment, or performance comparison was executed. The portable smoke sample and selected runtime corrections were tested on .NET 8/10; version-specific guidance was checked against primary documentation.

## Further primary references

- [System.Threading.Lock](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock?view=net-10.0)
- [C# 14 span overload resolution](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)
