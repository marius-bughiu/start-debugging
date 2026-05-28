---
title: "Migrate from .NET 8 to .NET 11: the full checklist"
description: "A version-pinned migration checklist from .NET 8 LTS to .NET 11 LTS, covering SDK install, csproj target framework, breaking changes in ASP.NET Core, EF Core, System.Text.Json, and the C# 14 overload-resolution shift, with rollback notes."
pubDate: 2026-05-28
updatedDate: 2026-05-28
template: migration
tags:
  - "migration"
  - "dotnet-8"
  - "dotnet-11"
  - "csharp-14"
  - "ef-core-11"
---

Skipping two LTS cycles in one go is the cheapest .NET upgrade most teams will do this decade. .NET 8 leaves standard support in November 2026, .NET 11 is the current LTS, and the path between them rolls through three sets of breaking changes (.NET 9, 10, 11) plus three C# language versions (C# 13, 14, with C# 12 already shipped in 8). A weekend of focused work is usually enough for a small service. A medium-sized monolith with EF Core, custom middleware, and a couple of source generators tends to cost three to five days. Codebases that pin `BinaryFormatter`, lean on `System.Web.HttpContext` shims, or run on in-process Azure Functions cost more, and that pain shows up first.

This post uses `net8.0` as the source and `net11.0` as the target. Every code block pins versions explicitly so steps stay reproducible after a few patch releases.

## Why migrate now

- .NET 8 standard support ends 2026-11-10. After that, no security patches, no servicing. Production code on 8 becomes audit-exposed three weeks before Black Friday.
- .NET 11 ships meaningful runtime wins for free: dynamic PGO is on by default, the new tiered JIT handles `async` state machines without the historical penalty, and Native AOT now supports ASP.NET Core minimal APIs and most of EF Core's read path.
- The `System.Threading.Lock` type introduced in .NET 9 removes a class of monitor-reentrancy footguns. Skipping the migration leaves the old `lock(object)` pattern on the table.
- C# 14 brings stable `field` keyword in properties and `partial` constructors. Useful, but not the reason to migrate; treat them as bonuses.

## What breaks

| Area                    | Change                                                                          | Severity   |
| ----------------------- | ------------------------------------------------------------------------------- | ---------- |
| `lock(object)`          | New `System.Threading.Lock` type changes monitor semantics when adopted         | low        |
| `BinaryFormatter`       | Removed entirely in .NET 9. No opt-in switch                                    | high       |
| `System.Text.Json`      | Default `JsonNumberHandling` for `JsonObject` round-trips changed in .NET 10    | medium     |
| EF Core query pipeline  | Primitive-collection translation changed in EF Core 10; some LINQ now throws    | high       |
| ASP.NET Core middleware | `UseExceptionHandler` overload signatures shifted in .NET 10                    | low        |
| Native AOT trim warnings| Several `System.Reflection.Emit` paths newly emit `IL2026` warnings             | medium     |
| C# 14 overload resolution| Span overloads now win over array overloads in ambiguous cases                | medium     |
| `IWebHostBuilder`       | Already deprecated in 8, removed in 11. Move to `WebApplication.CreateBuilder`  | high       |
| `dotnet ef` tool        | Major version bump required (`dotnet tool update --global dotnet-ef --version 11.*`) | low    |
| Azure Functions         | In-process model removed; isolated worker is mandatory                          | high       |

The full upstream list lives in the [.NET 11 breaking changes documentation](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0). Read it once start to finish before you touch a `.csproj`.

## Pre-flight checklist

Run this before changing any target framework.

1. Install the .NET 11 SDK on every dev machine and CI runner. Verify with `dotnet --list-sdks` and confirm `11.0.x` appears. The SDK is side-by-side, so .NET 8 keeps working.
2. Pin the SDK in `global.json` so CI does not silently roll forward:
   ```json
   // global.json, repo root
   {
     "sdk": {
       "version": "11.0.100",
       "rollForward": "latestFeature"
     }
   }
   ```
3. Capture a baseline: run `dotnet test` on .NET 8 and store the results. You want a clean green before you start so the first red after upgrade is unambiguous.
4. Snapshot the production runtime: dump `dotnet --info` from a live host. If anything links against a runtime older than 8.0.0 (an old self-contained publish, a third-party plugin), find it now.
5. Inventory NuGet packages with `dotnet list package --outdated --include-transitive`. Anything that pins `Microsoft.*` to `8.0.x` will need a major bump; anything pinning to `7.*` or older is a red flag.
6. Branch the migration. One PR per logical step is easier to revert than one giant green-light PR.

## Migration steps

1. **Bump the target framework.** Open every `.csproj` and change the `TargetFramework` (or `TargetFrameworks`) value. Verify with `dotnet build` and treat the first round of compile errors as the migration's true scope.

   ```xml
   <!-- src/MyApi.csproj, .NET 11 -->
   <Project Sdk="Microsoft.NET.Sdk.Web">
     <PropertyGroup>
       <TargetFramework>net11.0</TargetFramework>
       <LangVersion>14.0</LangVersion>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
   </Project>
   ```

   Verification: `dotnet build` exits 0 for at least the leaf projects, or fails with errors you recognise.

2. **Update all `Microsoft.*` NuGet packages to the 11.x line.** Do this as one batch with `dotnet add package` per project rather than touching `Directory.Packages.props` blindly. The runtime, ASP.NET Core, EF Core, and `Microsoft.Extensions.*` packages all version-lockstep with the SDK.

   ```bash
   # .NET 11
   dotnet add package Microsoft.AspNetCore.OpenApi --version 11.0.0
   dotnet add package Microsoft.EntityFrameworkCore.SqlServer --version 11.0.0
   dotnet add package Microsoft.Extensions.Hosting --version 11.0.0
   ```

   Verification: `dotnet restore` succeeds and `dotnet list package` shows no `8.0.x` left under the `Microsoft.*` namespace.

3. **Remove `BinaryFormatter` usage.** If the codebase serialises anything with `BinaryFormatter`, replace it now. `System.Text.Json`, MessagePack, or `protobuf-net` are the usual replacements depending on whether you need a JSON wire format or a binary one. There is no compatibility flag in .NET 9 or later; the type is gone.

   Verification: `grep -r "BinaryFormatter" src/` returns nothing. If you need to read legacy `BinaryFormatter` blobs from storage, write a one-shot .NET 8 migration tool to convert them before turning off the .NET 8 environment.

4. **Replace `IWebHostBuilder` with `WebApplication.CreateBuilder`.** The old generic-host shim was deprecated in .NET 6 and removed in .NET 11. Any `Program.cs` that still calls `Host.CreateDefaultBuilder().ConfigureWebHostDefaults(...)` will not compile.

   ```csharp
   // Program.cs, .NET 11, C# 14
   var builder = WebApplication.CreateBuilder(args);
   builder.Services.AddOpenApi();
   builder.Services.AddDbContext<AppDb>(o =>
       o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

   var app = builder.Build();
   app.MapOpenApi();
   app.MapControllers();
   app.Run();
   ```

   Verification: the app starts under `dotnet run` and the `/openapi/v1.json` endpoint responds with HTTP 200.

5. **Audit `System.Text.Json` for behaviour changes.** The default handling of `JsonObject` number round-trips changed in .NET 10 so that integers no longer lose precision when re-serialised, and the polymorphic deserialiser is stricter about unknown discriminators by default. If you maintain a public API contract, run your contract tests and read failures carefully. The contract often did not change, but a previously silent mismatch now throws. The companion post on the [JSON value could not be converted to System.DateTime fix](/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) covers the most common conversion failure mode.

   Verification: `dotnet test` for any project that exercises serialisation against fixture JSON files exits clean.

6. **Migrate EF Core queries that use primitive collections.** EF Core 10 reworked how `List<int>.Contains(x)` translates so that parameterised collections produce a single SQL parameter rather than expanding into an `IN` clause. That fixed the plan-cache bloat issue, but it broke a small set of queries that combined `Contains` with other server-evaluated expressions. Re-run all EF Core integration tests and inspect any query that now throws `InvalidOperationException: The LINQ expression ... could not be translated`. The escape hatch is to materialise the collection with `.ToList()` before the join.

   Verification: every integration test exercising raw LINQ over `DbSet<T>` passes; spot-check generated SQL with `LogTo(Console.WriteLine, LogLevel.Information)` on a representative query.

7. **Adopt `System.Threading.Lock` selectively, not blanket-replace.** Replacing `private readonly object _gate = new();` with `private readonly System.Threading.Lock _gate = new();` is correct in most cases, but it changes whether reentrancy from the same thread is observable. Walk the code paths first. A deeper trade-off comparison is in [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/).

   Verification: code review explicitly covers every `lock(...)` site that was changed; no functional change in the test suite.

8. **Re-run trim and AOT analyzers.** If the project sets `<PublishAot>true</PublishAot>` or `<TrimMode>full</TrimMode>`, .NET 11 emits new warnings around `System.Reflection.Emit` paths that were silent under .NET 8. The fix is usually adding `[DynamicallyAccessedMembers]` annotations or registering a JSON source generator. The [Native AOT vs ReadyToRun vs JIT comparison](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) covers when each model is worth its cost.

   Verification: `dotnet publish -c Release` emits zero `IL2026` or `IL3050` warnings on the leaf project; the resulting native binary boots locally.

9. **Adjust C# 14 overload-resolution surprises.** C# 14 changed the resolution rules so that overloads accepting `ReadOnlySpan<T>` are preferred over overloads accepting `T[]` when both apply. Most code is unaffected. The cases that break are usually mocks, fluent assertion libraries, and custom extension methods that were written assuming the array overload would win. The compiler emits a clear diagnostic; the fix is generally a cast. The [C# 14 overload resolution breaking change with spans](/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) walks through the diagnostic and the cast pattern.

   Verification: `dotnet build` is warning-clean at `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`.

10. **Update CI runner images.** Bump the GitHub Actions `actions/setup-dotnet` `dotnet-version` to `11.0.x`, update any Dockerfile base image to `mcr.microsoft.com/dotnet/sdk:11.0` and `mcr.microsoft.com/dotnet/aspnet:11.0`, and remove pins on the .NET 8 SDK image. Self-hosted runners need the SDK installed manually before CI passes.

    Verification: a pipeline run on a feature branch is green end to end, including the publish step.

## Verification (smoke checklist)

After the steps above, the app should pass every line of this list before the migration PR merges:

- `dotnet --list-sdks` shows 11.0.x as the version actually used by the build (`dotnet --version` from the repo root prints `11.0.x`).
- `dotnet restore && dotnet build -c Release` exits 0 with zero warnings.
- `dotnet test -c Release` is green and the test count matches the .NET 8 baseline.
- `dotnet publish -c Release` produces an artefact that boots locally and serves `/health`.
- One representative read path and one representative write path are exercised against a staging environment; latency p50/p95 is within 10 percent of the .NET 8 baseline.
- Logs show no first-chance `BinaryFormatter`, `IWebHostBuilder`, or `IL2026` references.

If any of those fail, stop. Do not merge a partially migrated codebase.

## Rollback

This migration is reversible until the first production deploy that takes a write under .NET 11. Until then, revert the `global.json`, `TargetFramework`, and NuGet bumps in one commit. After the first .NET 11 production write, rolling back is technically possible but rarely worth it: schema changes you may have made under EF Core 11's translator, JSON outputs serialised under the new defaults, and any `System.Threading.Lock` adoption all need separate reasoning. Plan to fix forward.

## Gotchas we hit

- **A NuGet package that targets `net8.0` only is not necessarily broken on net11.0**, but it will silently load the .NET Standard 2.0 facade if the package exposes one. That sometimes pulls older `System.*` dependencies back in. `dotnet list package --include-transitive` after the bump is non-optional.
- **`Microsoft.Data.SqlClient` versions matter.** EF Core 11 wants `Microsoft.Data.SqlClient` 7.x or later. An older transitive pin will compile, then fail at runtime on TLS 1.3 negotiation against newer SQL Server boxes.
- **Source generators built on Roslyn 4.6 emit warnings on the Roslyn that ships with .NET 11.** Most resolve by bumping the generator's `Microsoft.CodeAnalysis.CSharp` reference. If you ship your own generator, do this in a separate PR.
- **In-process Azure Functions are gone.** If a single function project still uses the in-process model on .NET 8, .NET 11 will not run it. Move to the isolated worker model first, then bump.
- **`HttpClient` cancellation semantics on .NET 11** correctly throw `TaskCanceledException` whose `CancellationToken` matches the supplied token, where previously some paths threw with `CancellationToken.None`. Catch blocks that pattern-match the token will need a small adjustment; the rationale is in the [async void vs async Task in C#](/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) discussion.

## Related

- [ConfigureAwait(false) vs default in .NET 11](/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [EF Core 11 vs Dapper for bulk inserts: real benchmark](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)
- [Minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)

## Sources

- [.NET 11 breaking changes](https://learn.microsoft.com/en-us/dotnet/core/compatibility/11.0)
- [.NET release schedule and support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core)
- [EF Core 10 and 11 breaking changes](https://learn.microsoft.com/en-us/ef/core/what-is-new/)
- [C# 14 language reference](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
- [`System.Threading.Lock` API reference](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lock)
