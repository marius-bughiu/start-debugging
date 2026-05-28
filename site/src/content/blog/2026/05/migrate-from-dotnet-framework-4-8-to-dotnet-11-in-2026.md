---
title: "Migrate from .NET Framework 4.8 to .NET 11 in 2026"
description: "A version-pinned migration playbook for moving a .NET Framework 4.8 codebase to .NET 11 LTS in 2026, covering the SDK-style csproj rewrite, System.Web to ASP.NET Core, WCF, EF6 to EF Core 11, BinaryFormatter removal, AppDomain replacements, and a realistic rollback plan."
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "dotnet-framework"
  - "dotnet-11"
  - "aspnet-core"
  - "ef-core-11"
---

Moving a .NET Framework 4.8 codebase to .NET 11 is not a version bump. It is a re-platforming exercise that touches the project format, the web stack, the data access layer, the hosting model, and a long tail of APIs that quietly disappeared between 2017 and 2026. The official .NET Framework 4.8 servicing window is still open in 2026, but the runtime has not received a feature update since 2019, every modern Azure App Service plan is on the Core stack by default, and almost every NuGet package worth depending on has dropped `net48` targets. The realistic effort for a typical line-of-business app is two to six weeks for a small service, two to four months for a medium codebase with WCF, EF6, and a WebForms or MVC 5 front end. WebForms apps stay where they are or get rewritten; there is no in-place port. This post pins `net48` as the source and `net11.0` as the target, and assumes the project is on Windows.

## Why migrate now

- .NET Framework 4.8 has been in maintenance only since the 4.8.1 release in August 2022. No new APIs, no new C# language features. The .NET 11 runtime ships dynamic PGO on by default, the modernised tiered JIT, and Native AOT for ASP.NET Core minimal APIs.
- Every new Microsoft framework (Aspire, Microsoft Agent Framework, Semantic Kernel 1.x, Azure Functions isolated worker) targets `net8.0` or newer and will not be backported. Staying on 4.8 means none of these are reachable from your own process.
- Cloud cost. .NET 11's runtime memory footprint for an idle ASP.NET Core minimal API is roughly 35 to 50 percent of an ASP.NET 4.8 worker process at comparable load, which translates directly to smaller App Service plans or larger pod density in Kubernetes.
- Hiring and tooling. Roslyn analyzers, source generators, and the modern `dotnet` CLI assume an SDK-style project. The C# language version on `net48` is capped at C# 7.3 unless you fight the compiler, which leaves a decade of language features off the table.

If the codebase is a Windows desktop app (WinForms or WPF) that only runs on Windows and has no plans to deploy elsewhere, the question is fair. The answer is still usually yes, because the supported life of net48 ends with Windows 10's extended support window, and tooling support is already thin.

## What breaks

| Area                          | Change                                                                                              | Severity   |
| ----------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| Project format                | `packages.config` and the old csproj XML are unsupported by the .NET 11 SDK                          | high       |
| `System.Web`                  | Removed entirely. `HttpContext.Current`, modules, handlers, WebForms have no .NET 11 equivalent     | high       |
| WCF server                    | `System.ServiceModel` on the server side is unsupported. Use CoreWCF or rewrite to gRPC or HTTP     | high       |
| WCF client                    | Supported via `System.ServiceModel.*` 6.x NuGet packages, with limited bindings                     | medium     |
| Entity Framework 6            | Runs on .NET 11 with EF6 6.5.0 or later, but new development should use EF Core 11                  | medium     |
| `AppDomain`                   | Only the default `AppDomain` exists. No `CreateDomain`, no unloadable plugin containers              | high       |
| `BinaryFormatter`             | Removed in .NET 9, no opt-in switch                                                                  | high       |
| .NET Remoting                 | Gone. No replacement; rewrite to a network protocol you actually want                                | high       |
| Code Access Security          | Gone. `[SecurityCritical]`, `PermissionSet`, sandboxing all removed                                  | high       |
| `web.config`                  | Configuration moves to `appsettings.json`. `system.web` sections do not apply                        | high       |
| `app.config`                  | Most settings still work via `Microsoft.Extensions.Configuration.Xml`, but binding redirects are gone | medium    |
| WPF and WinForms              | Supported on .NET 11, Windows only. Most third-party controls need a 6.x or later build              | medium     |
| `System.Drawing.Common`       | Cross-platform support removed in .NET 6. Windows-only since                                         | medium     |

Read the [.NET Framework to .NET porting overview](https://learn.microsoft.com/en-us/dotnet/core/porting/) and the [.NET 11 breaking changes list](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0) once before you touch a `.csproj`. The first list is the longer of the two by far.

## Pre-flight checklist

Run these before you change a single project file.

1. Install the .NET 11 SDK on every dev machine and CI runner. Verify with `dotnet --list-sdks` and confirm `11.0.x` appears. Keep the .NET Framework 4.8 developer pack installed so the old solution still opens in Visual Studio.
2. Install the .NET Upgrade Assistant CLI and run it in analysis mode first. It does not migrate code; it produces an actionable report.
   ```bash
   # .NET 11, upgrade-assistant 0.6.x
   dotnet tool install --global upgrade-assistant
   upgrade-assistant analyze MySolution.sln
   ```
3. Run the .NET Portability Analyzer or `apiport` against the compiled assemblies. Anything flagged as "not portable" is migration work that the upgrade-assistant tool will not do for you.
4. Capture a baseline. Run the existing test suite on .NET Framework 4.8 and store the result. A clean green on the old runtime means the first red on .NET 11 is unambiguously a migration regression.
5. Inventory third-party NuGet packages. Anything that ships only `net48` or `net472` assemblies is a blocker. Replacements: `log4net` 2.0.16, `Newtonsoft.Json` 13.x, `AutoMapper` 13.x, `Dapper` 2.1.x all multi-target and work on .NET 11. Anything else needs an upgrade ticket against the vendor.
6. Branch the migration. Plan for at least one PR per project, and a separate PR for the test projects. A single mega-PR for a medium codebase is unreviewable.

## Migration steps

1. **Convert every `.csproj` to SDK style.** Replace the old XML with the SDK-style header. The new format infers files, drops most assembly references, and uses `PackageReference` instead of `packages.config`. The `try-convert` tool (bundled with the .NET Upgrade Assistant) handles the mechanical part.

   ```xml
   <!-- src/MyApi.csproj, .NET 11, after conversion -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="11.0.0" />
       <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     </ItemGroup>
   </Project>
   ```

   Verification: `dotnet build` exits with errors that name removed APIs rather than parser errors against the project file itself. Delete `packages.config` after the conversion succeeds.

2. **Delete `BinaryFormatter` usage everywhere.** The type was removed in .NET 9 with no compatibility switch. Replace it with `System.Text.Json`, MessagePack, or `protobuf-net` depending on whether you need a JSON or binary wire format. If you have stored blobs serialised with `BinaryFormatter`, write a one-shot conversion utility that still runs on .NET Framework 4.8 to translate them into the new format before you decommission the old environment. Doing this conversion from .NET 11 is not possible.

   Verification: `grep -r "BinaryFormatter" src/` is empty. Any blob storage that previously held binary-formatted payloads has been re-serialised and the new format round-trips through a unit test.

3. **Rewrite the web stack from `System.Web` to ASP.NET Core 11.** This is the largest single piece of work. MVC 5 controllers map almost one-for-one to ASP.NET Core controllers, but routing attributes, model binding, action filters, and dependency injection all differ. `HttpContext.Current` is gone; controllers and middleware receive `HttpContext` explicitly. `Application_Start` in `Global.asax` becomes startup code in `Program.cs`. WebAPI 2 controllers are very close to ASP.NET Core controllers but inherit from `ControllerBase` rather than `ApiController`.

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddControllers();
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.UseAuthentication();
   app.UseAuthorization();
   app.MapControllers();
   app.MapOpenApi();
   app.Run();
   ```

   WebForms (`.aspx`) has no migration path. Either keep the WebForms app on .NET Framework 4.8 for the rest of its life behind a reverse proxy, or rewrite the affected pages as Blazor, MVC, or Razor Pages. The [Blazor Server vs Blazor WebAssembly vs Blazor United](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) comparison is the right starting point if Blazor is on the table.

   Verification: every controller has at least one integration test that exercises an HTTP route against `WebApplicationFactory<Program>` and asserts both status code and response body.

4. **Move `web.config` to `appsettings.json`.** Connection strings, custom appSettings, and logging configuration move to JSON. `system.web` sections do not apply. `system.webServer` sections that configure IIS still apply if you host behind IIS via the in-process module, but most production deployments now use Kestrel directly. Authentication settings move from `<authentication>` and `<authorization>` web.config sections to `builder.Services.AddAuthentication(...)` and the authorization policy API.

   ```json
   // appsettings.json, .NET 11
   {
     "ConnectionStrings": {
       "Default": "Server=.;Database=App;Trusted_Connection=True;TrustServerCertificate=True;"
     },
     "Logging": {
       "LogLevel": { "Default": "Information", "Microsoft.AspNetCore": "Warning" }
     }
   }
   ```

   Verification: the app reads every previously-config-driven value through `IConfiguration` or the strongly typed `IOptions<T>` pattern; no calls to `ConfigurationManager.AppSettings` survive in production code.

5. **Handle WCF.** Server-side WCF is unsupported on .NET 11. Two realistic paths:
   - **CoreWCF** (the community-maintained port). Add `CoreWCF.Primitives`, `CoreWCF.Http`, and the bindings you actually use. Most `BasicHttpBinding` and `NetTcpBinding` services migrate with a contract reference and a `UseServiceModel` configuration call. Streaming, transactions, and message-level security have varying degrees of support; check the [CoreWCF compatibility matrix](https://github.com/CoreWCF/CoreWCF) before you commit.
   - **Rewrite to gRPC or an HTTP API.** Higher ceiling, more work. The right call when the WCF interface was only ever consumed by clients you control.

   Client-side WCF is supported via the `System.ServiceModel.*` 6.x NuGet packages with `BasicHttpBinding`, `NetTcpBinding` (limited), and `WSHttpBinding` (transport security only). If your client uses `WSFederationHttpBinding` or message-level security, you will rewrite the consumer.

   Verification: every WCF endpoint has a contract test that runs the .NET 11 client against either the new CoreWCF host or the rewritten replacement, and asserts the same payloads as the old .NET Framework client.

6. **Move Entity Framework 6 to EF Core 11 (when worth it).** EF6 runs on .NET 11 via the `EntityFramework` 6.5.0 package, so a strict lift-and-shift is possible. But EF6 receives no new features, the `DbContext` API in EF Core is closer to what you want for ASP.NET Core dependency injection, and EF Core 11's compiled queries and primitive-collection translation are meaningfully faster. For most teams the right call is to ship the migration on EF6 first, then move to EF Core in a follow-up PR. The [EF Core compiled queries vs raw SQL vs Dapper](/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) post quantifies the hot-path gains.

   Verification: the chosen ORM passes the same integration test suite that ran under EF6 on .NET Framework, including any tests that asserted generated SQL.

7. **Replace `AppDomain.CreateDomain` plugin loaders.** `AppDomain` is no longer an isolation boundary on .NET 11; only the default domain exists. Plugin systems that previously loaded assemblies into a child `AppDomain` for unload semantics or fault isolation must move to `AssemblyLoadContext` with `isCollectible: true` and call `Unload()` when finished. Out-of-process plugins via `dotnet` worker processes are the safer pattern when the plugin is untrusted.

   Verification: a unit test loads a plugin assembly, calls into it, unloads the `AssemblyLoadContext`, and asserts that a `WeakReference` to the context becomes `null` after a `GC.Collect()` cycle.

8. **Audit C# language version bumps.** Going from C# 7.3 to C# 14 is twelve language releases in one step. Most of it is additive and safe, but nullable reference types (introduced in C# 8) will flag thousands of warnings on legacy code if you turn `<Nullable>enable</Nullable>` on globally. The realistic path is `<Nullable>annotations</Nullable>` first (annotations only, no diagnostics), then file-by-file conversion using `#nullable enable` pragmas. C# 14's overload-resolution change around span overloads is documented in the [C# 14 overload resolution breaking change with spans](/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) fix post.

   Verification: `dotnet build -warnaserror` is clean on the agreed nullable scope before merging.

9. **Update CI runner images.** Bump GitHub Actions `actions/setup-dotnet` to `dotnet-version: 11.0.x`, update any Dockerfile base image to `mcr.microsoft.com/dotnet/sdk:11.0` and `mcr.microsoft.com/dotnet/aspnet:11.0`, and remove the old .NET Framework MSBuild image. If any project still has to build under .NET Framework (for example, the one-shot `BinaryFormatter` conversion tool from step 2), keep a single `windows-2022` runner with the .NET Framework 4.8 developer pack installed and gate it on a path filter.

   Verification: a pipeline run on a feature branch is green end to end, including `dotnet publish`, container image build, and smoke deploy to a staging environment.

## Verification (smoke checklist)

After the steps above, the app should pass every line of this list before the migration PR merges:

- `dotnet --list-sdks` shows `11.0.x` and `dotnet --version` from the repo root prints `11.0.x`.
- `dotnet restore && dotnet build -c Release` exits 0 with zero warnings on the nullable scope you agreed.
- `dotnet test -c Release` is green and the test count matches (or exceeds) the .NET Framework 4.8 baseline.
- `dotnet publish -c Release` produces a self-contained artefact that boots on a clean staging host without the .NET Framework 4.8 redistributable installed.
- Every HTTP route has at least one integration test against `WebApplicationFactory<Program>`.
- Logs show no first-chance `BinaryFormatter`, `IWebHostBuilder`, `HttpContext.Current`, or `ConfigurationManager` references in production code paths.
- A staging deploy serves the golden path; p50/p95 latency is within 20 percent of the .NET Framework baseline on equivalent hardware.

If any of those fail, stop. A partial migration to .NET 11 is worse than a clean .NET Framework 4.8 deploy because it commits to both runtimes.

## Rollback

The migration is reversible only as long as the database schema and any wire formats have not changed. The runtime swap itself is reversible: revert the `.csproj` changes and reinstall the .NET Framework 4.8 redistributable on the host. The decisions that make rollback expensive are usually orthogonal:

- A new EF Core 11 migration ran against the production database. Roll back the schema first.
- JSON payloads were re-serialised under `System.Text.Json` defaults that differ from `Newtonsoft.Json`. Downstream consumers that pattern-match on field ordering or null handling will see drift.
- Authentication moved from `FormsAuthentication` cookies to ASP.NET Core's data-protection cookies. Existing sessions are invalidated either way.

The pragmatic plan is to keep the .NET Framework deploy warm in a separate slot for one week after cutover, and to gate the cutover behind a feature flag at the load balancer rather than at deploy time. Fix forward after that window.

## Gotchas we hit

- **`HttpClient` on .NET 11 enforces TLS server-name indication strictly.** Calls to internal services that present a certificate without a matching SAN fail with `AuthenticationException`. Either fix the certificate or set `SslOptions.RemoteCertificateValidationCallback` deliberately. The .NET Framework defaults were looser, and that masked the SAN gap.
- **`DateTime.Parse` on .NET 11 is stricter about ambiguous formats than .NET Framework 4.8.** Code that round-tripped `DateTime` through string without an explicit `IFormatProvider` will start throwing `FormatException` on input it accepted before. Always pass `CultureInfo.InvariantCulture` and a known format. The [JSON value could not be converted to System.DateTime fix](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) covers the most common variant when the date arrives through JSON.
- **`Microsoft.Data.SqlClient` replaces `System.Data.SqlClient` in any modern path.** EF Core 11 wants `Microsoft.Data.SqlClient` 7.x or later. A transitive pin to the old `System.Data.SqlClient` will compile but fail at runtime on TLS 1.3 negotiation against newer SQL Server boxes.
- **Configuration binding is case-sensitive in JSON, case-insensitive in `app.config`.** A property named `MaxRetries` in `appsettings.json` does not bind from a `maxretries` key. The .NET Framework `ConfigurationManager` did not care.
- **`HostingEnvironment.MapPath` is gone.** Replace with `IWebHostEnvironment.ContentRootPath` and `Path.Combine`. The `~/` virtual path syntax is not understood by anything in ASP.NET Core.
- **WCF datacontract surrogates do not round-trip identically through CoreWCF.** If you depend on `IDataContractSurrogate`, write a contract test that asserts the exact wire format before and after the migration, not just object equality.

## Related

- [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)
- [System.Text.Json vs Newtonsoft.Json in 2026](/2026/05/system-text-json-vs-newtonsoft-json-in-2026/)
- [EF Core 11 vs Dapper for bulk inserts: real benchmark](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)

## Sources

- [.NET Framework to .NET porting overview](https://learn.microsoft.com/en-us/dotnet/core/porting/)
- [.NET 11 breaking changes](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [.NET Upgrade Assistant documentation](https://learn.microsoft.com/en-us/dotnet/core/porting/upgrade-assistant-overview)
- [CoreWCF project and compatibility matrix](https://github.com/CoreWCF/CoreWCF)
- [Migrate from ASP.NET to ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/migration/proper-to-2x/)
- [AssemblyLoadContext API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.loader.assemblyloadcontext)
