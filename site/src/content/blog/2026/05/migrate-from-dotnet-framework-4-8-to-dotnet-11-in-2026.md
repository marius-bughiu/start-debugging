---
title: "Migrate from .NET Framework 4.8 to .NET 11 in 2026"
description: "Plan a .NET Framework 4.8 migration with accurate support status, incremental ASP.NET boundaries, dependency checks, configuration, and rollback."
pubDate: 2026-05-28
updatedDate: 2026-11-02
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
---

**Correction — 2 November 2026:** This guide corrects .NET 11's release/support status, .NET Framework lifecycle claims, configuration binding, serialization, tooling, and deployment advice. Unsupported migration-duration, memory-saving, and “gotchas we hit” claims have been removed.

Moving from .NET Framework 4.8 to modern .NET can require a new application host and changes to libraries, deployment, and data contracts. It is not an in-place runtime update. First identify why the migration is needed and which part can move independently.

As of this review, [.NET 11 RC3 is a go-live prerelease](https://dotnet.microsoft.com/en-us/download/dotnet/11.0), .NET 11 is an STS line, and .NET 10 is the released LTS option. [.NET Framework support follows the underlying Windows product](https://learn.microsoft.com/en-us/lifecycle/faq/dotnet-framework); there is no single .NET Framework 4.8 end date tied to every installation of Windows 10. Check the actual server/desktop OS and its supported Framework version.

## Inventory before changing project files

Build and test the existing application on its supported Windows environment. Keep its developer/reference packs and build tooling available throughout migration. Record authentication, session state, Windows integrations, native libraries, scheduled work, database providers, and persisted formats. Package compatibility depends on APIs and assets, not a universal rule that every `net48` library is unusable.

The [Upgrade Assistant overview](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview) now marks that tool deprecated and points to the GitHub Copilot modernization agent. Automated assistance is optional; review its changes and test them. Don't follow an old unpinned tool-install command as if it guaranteed support for .NET 11.

Separate project-format cleanup from runtime migration when possible. Converting to SDK style doesn't translate `System.Web`, WCF service hosting, COM dependencies, or custom MSBuild tasks. Keep a working baseline and migrate leaf libraries before their callers.

## Choose a migration boundary

| Existing dependency | Work to plan |
| --- | --- |
| ASP.NET MVC 5 / Web API 2 | Adapt routes, filters, model binding, authentication, sessions, and hosting |
| Web Forms / System.Web | Retain behind an incremental boundary or replace the affected UI; ASP.NET Core doesn't run Web Forms |
| WCF server | Evaluate CoreWCF for actual bindings/features, or design another service contract |
| WCF client | Check current System.ServiceModel client packages and the service's security requirements |
| EF6 | Verify modern-runtime/provider support; an EF Core rewrite can be a separate project |
| WPF / WinForms | Use Windows targets and verify controls, COM/native dependencies, and deployment |
| Extra AppDomains / Remoting / CAS | Redesign loading, communication, and isolation |

Microsoft's [ASP.NET migration guide](https://learn.microsoft.com/en-us/aspnet/core/migration/fx-to-core/?view=aspnetcore-10.0) supports incremental migration. Moving routes behind a proxy can preserve a working legacy application while new routes move. Partial migration is a valid strategy when authentication, routing, data ownership, and rollback are deliberately managed.

[CoreWCF](https://github.com/CoreWCF/CoreWCF) is not a guarantee that every WCF feature or wire contract is identical. Test the bindings and authentication you actually use. [EF6 has supported modern .NET since 6.3](https://learn.microsoft.com/en-us/ef/ef6/what-is-new/); select a current compatible version/provider and test it instead of treating 6.5.0 as a universal minimum. EF Core is not a drop-in replacement for EF6.

## Start the new host with a small working slice

For an ASP.NET Core evaluation targeting .NET 11, the basic project is:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
```

Use an installed, explicitly selected SDK and compatible package versions. The [.NET 8 to 11 checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) shows the current RC3 SDK pin. A Windows desktop project instead needs the appropriate Windows TFM and desktop settings; don't replace every project with `Microsoft.NET.Sdk.Web`.

This complete `Program.cs` is a smoke test, not a migrated application:

```csharp
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.Run();
```

It was built, published, and called on .NET 8 and 10 during this correction. A real MVC application must register controllers before mapping them. Authentication requires an actual scheme and service configuration; adding `UseAuthentication()` alone does not migrate Forms Authentication.

## Preserve configuration and data semantics

A small `appsettings.json` example:

```json
{
  "Migration": {
    "MaxRetries": 3
  }
}
```

.NET's [JSON configuration provider uses case-insensitive keys](https://learn.microsoft.com/en-us/dotnet/core/extensions/configuration-providers). This is different from rules for arbitrary JSON serialization. Review provider precedence and secret storage. XML configuration support doesn't automatically reproduce all `app.config` sections or binding redirects. `System.Configuration.ConfigurationManager` can be a compatibility option for supported APIs; deleting every use is not a universal migration requirement. IIS `web.config` still matters for IIS hosting.

For `BinaryFormatter`, the built-in implementation throws from .NET 9 onward, but the type remains. Use a supported serializer or evaluate the [NRBF reader](https://learn.microsoft.com/en-us/dotnet/standard/serialization/binaryformatter-migration-guide/) to extract legacy data without instantiating arbitrary encoded types. Conversion is not limited to executing the old unsafe deserializer on Framework 4.8.

`AssemblyLoadContext` supports assembly loading and cooperative unloading; it does not recreate an AppDomain security boundary. References, running code, and event handlers can prevent unloading. A single garbage-collection cycle is not proof of success. Use a suitable process/container boundary for untrusted code, with appropriate permissions.

Keep certificate validation enabled. Investigate the actual certificate, hostname, trust chain, SQL client settings, and platform when TLS fails. Do not work around a migration by accepting every certificate. Test explicit date formats/cultures and serializer contracts instead of assuming a blanket .NET 11 parsing change.

## Deploy and rehearse rollback

```bash
dotnet restore
dotnet build -c Release --no-restore
dotnet test -c Release --no-build
dotnet publish -c Release --self-contained false
```

The publish command explicitly creates a framework-dependent application. A self-contained deployment needs `--self-contained true` and an appropriate RID; it is not the default consequence of `dotnet publish`. Keep Windows CI for remaining Framework projects and validate the modern artifact on its real target platform.

Test authorization failures as well as successful requests, session behavior, database writes, serialized messages, background work, and desktop integrations. Keep the old deployment available, use backward-compatible database/data changes, and rehearse switching traffic back. A rollback requires the old application artifact and configuration, not merely reinstalling the Framework redistributable.

**Verification limits:** No Windows/.NET Framework application, .NET 11 SDK, WCF service, EF provider migration, or production deployment was tested here. The portable smoke endpoint and case-insensitive JSON configuration were checked on .NET 8 and 10. Estimate effort and performance from your own representative slice.

## Further primary references

- [AssemblyLoadContext](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext)
- [.NET Framework technologies unavailable on .NET](https://learn.microsoft.com/en-us/dotnet/core/porting/net-framework-tech-unavailable)
- [.NET application publishing](https://learn.microsoft.com/en-us/dotnet/core/deploying/)
