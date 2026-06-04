---
title: "Migrate EF Core 6 to EF Core 11: breaking changes that actually bite"
description: "A version-pinned migration guide from EF Core 6.0 to EF Core 11.0, walking the breaking changes across EF7, 8, 9, 10, and 11 that break real apps: Encrypt=True, OPENJSON Contains, PendingModelChangesWarning, the native json column, and the SqlClient 7.0 split."
pubDate: 2026-06-04
updatedDate: 2026-06-04
template: migration
tags:
  - "migration"
  - "ef-core"
  - "ef-core-6"
  - "ef-core-11"
  - "dotnet-11"
---

Moving from EF Core 6.0 to EF Core 11.0 is five major versions in one jump, and the painful parts are almost never the API renames. They are the silent behavior changes: a connection string that worked for years now throws an SSL error, a `Contains` query that suddenly times out on an old SQL Server, and a deploy that aborts because EF decided your model has pending changes. Budget half a day for a small service and two to four days for a monolith with a non-trivial model, custom value converters, and a database-first scaffolding flow. Nothing here is a one-way door at the database level, but two changes (the `Encrypt` default in EF Core 7 and the `PendingModelChangesWarning` throw in EF Core 9) will stop your app from starting on day one if you do not plan for them.

This guide pins `Microsoft.EntityFrameworkCore` 6.0 as the source and 11.0 as the target, running on .NET 11. Because EF Core's target framework floor rises along the way (EF Core 7 needs .NET 6, EF Core 8 and 9 need .NET 8, EF Core 10 needs .NET 10, EF Core 11 needs .NET 11), this is also a runtime migration. If you have not moved the runtime yet, do that first using the [.NET 8 to .NET 11 checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) and come back.

## Why migrate now

- EF Core 6.0 left support in November 2024. You are running an unsupported data layer against a supported runtime, which is the worst of both worlds for security review.
- EF Core 11 ships real query wins for free: the `OPENJSON`-based `Contains` translation (refined three times since EF 8), better cardinality estimates from multiple scalar parameters, and the native SQL Server `json` column type with first-class indexing.
- `ExecuteUpdate` and `ExecuteDelete`, added in EF Core 7 and improved every release since, turn set-based writes into a single SQL statement. If you are still loading entities to mutate them, you are leaving one to two orders of magnitude on the table. See [ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) for the benchmark.
- The migration guardrails that landed in EF 9 (pending-model-changes detection) and EF 11 (no-migrations detection) catch a whole class of "the database and the model silently drifted" production incidents.

## What breaks

This is the cumulative list across all five versions. Severity is how likely it is to break a typical app, not how hard the fix is.

| Area | Change | Version | Severity |
| ---- | ------ | ------- | -------- |
| SQL Server connections | `Encrypt` defaults to `true`; untrusted certs throw | EF 7 | high |
| SaveChanges with triggers | OUTPUT-clause path breaks on tables with triggers or some computed columns | EF 7 | high |
| Optional relationships | Orphaned dependents are no longer auto-deleted on sever | EF 7 | medium |
| `Contains` over a list | Translated via `OPENJSON`; fails below SQL Server 2016 / compat level 130 | EF 8 | high |
| `Contains` performance | `OPENJSON` plan can regress badly on some workloads | EF 8 | high |
| Enums in JSON columns | Stored as `int` by default instead of `string` | EF 8 | high |
| String keys on SQL Server | Compared case-insensitively in the change tracker | EF 8 | medium |
| Applying migrations | `PendingModelChangesWarning` now throws on `Migrate()` | EF 9 | high |
| Migrations in a transaction | External transaction around `Migrate()` now throws | EF 9 | high |
| `EF.Constant` / `EF.Parameter` | Throw `InvalidCastException` inside compiled queries | EF 9 | low |
| EF tools, multi-target projects | `--framework` now required | EF 10 | medium |
| Parameterized collections | Default translation is now multiple scalar parameters | EF 10 | low |
| SQL Server JSON storage | `nvarchar(max)` JSON migrates to native `json` at compat 170 / Azure SQL | EF 10 | low |
| Migrate with no migrations | Throws by default instead of logging | EF 11 | low |
| `Microsoft.Data.SqlClient` 7.0 | Entra ID auth dependencies split into a separate package | EF 11 | medium |

The authoritative per-version lists are linked at the end. Read the [EF 7](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes), [EF 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes), and [EF 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) pages before you start; those three carry the high-severity changes.

## Pre-flight checklist

1. Move the runtime to .NET 11 and confirm a clean `dotnet test` on the old EF Core 6 packages first. You want one variable changing at a time, so the first red after the EF bump is unambiguous.
2. Inventory your provider. SQL Server, SQLite, PostgreSQL (Npgsql), and Cosmos each have their own breaking changes. This guide focuses on SQL Server and calls out SQLite where it differs.
3. Check your SQL Server version and compatibility level. The EF 8 `Contains` change needs compat level 130 or higher:
   ```sql
   -- run against your target database
   SELECT name, compatibility_level FROM sys.databases;
   ```
4. Grep for `Database.Migrate(` and `MigrateAsync(`. Every call site is a candidate for the EF 9 pending-changes throw and the EF 9 explicit-transaction throw.
5. Grep for `.HasConversion<string>()` on enums and for any enum properties mapped into JSON-mapped owned types. Those are the EF 8 enum-in-JSON change.
6. Note whether you use Entra ID (Azure AD) authentication in any connection string (`Authentication=Active Directory Default`, managed identity, service principal). That is the EF 11 SqlClient split.
7. Branch the migration and back up the database. Schema-altering migrations (discriminator max length, native `json`) are generated automatically and should be reviewed before they run against production.

## Migration steps

1. **Bump every EF Core package to 11.0 in one move.** Do not climb one version at a time; the breaking changes are cumulative and documented per version, so a single jump with the docs open is faster than five intermediate compiles. Update `Microsoft.EntityFrameworkCore`, the provider (`Microsoft.EntityFrameworkCore.SqlServer`), and `Microsoft.EntityFrameworkCore.Design`. Verify with `dotnet restore` and `dotnet build`, and treat the first compile errors as the true scope.
   ```xml
   <!-- src/MyApp.csproj, EF Core 11 on .NET 11 -->
   <ItemGroup>
     <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
     <PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="11.0.0" PrivateAssets="all" />
   </ItemGroup>
   ```

2. **Update the `dotnet ef` tool to a matching major version.** The 6.x tool cannot read an 11.0 model. Verify with `dotnet ef --version` and confirm `11.0.x`.
   ```bash
   dotnet tool update --global dotnet-ef --version 11.*
   ```

3. **Fix the `Encrypt=True` default before anything else.** This is the EF Core 7 change that lives in `Microsoft.Data.SqlClient`, not EF, so there is no EF-side switch. On a dev box without a trusted server certificate, your first connection throws an SSL error. For local development, add `TrustServerCertificate=True`; in production, install a valid certificate. Verify by opening one connection: `dotnet ef dbcontext info` should connect without an SSL provider error.
   ```text
   Server=localhost;Database=App;Trusted_Connection=True;TrustServerCertificate=True
   ```

4. **Handle the migration guardrails at every `Migrate()` call.** EF Core 9 throws `PendingModelChangesWarning` if the model differs from the last migration, and EF Core 11 throws `MigrationsNotFound` if there are no migrations at all. If you manage schema with migrations, the fix is to add the missing migration. If you manage schema another way (Dapper, DACPAC, hand-written SQL) and only call `Migrate()` out of habit, remove the call or suppress the warnings. Verify by running `dotnet ef migrations has-pending-model-changes` and getting a clean result.
   ```csharp
   // EF Core 11. Only suppress if you intentionally manage schema elsewhere.
   protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
       => optionsBuilder.ConfigureWarnings(w =>
       {
           w.Ignore(RelationalEventId.PendingModelChangesWarning);
           w.Ignore(RelationalEventId.MigrationsNotFound);
       });
   ```

5. **Remove any explicit transaction wrapped around `Migrate()`.** The common "resilient migration" pattern (begin transaction, migrate, commit, inside an execution strategy) throws `MigrationsUserTransactionWarning` in EF Core 9 because EF now manages the transaction and the database lock itself. Delete the wrapper and call `MigrateAsync` directly. Verify the app starts and applies migrations once.
   ```csharp
   // EF Core 9+. EF manages the transaction and execution strategy.
   await dbContext.Database.MigrateAsync(cancellationToken);
   ```

6. **Confirm SQL Server compatibility level for the `Contains` change.** If `sys.databases` reports a level below 130, the EF Core 8 `OPENJSON` translation will fail at runtime. Raise the level if you can, or pin the translation mode. Verify by running a query that uses `.Where(x => list.Contains(x.Id))` and confirming valid SQL.
   ```csharp
   // EF Core 10+: pick the translation strategy explicitly.
   // Constant = pre-EF8 inlining, Parameter = OPENJSON, MultipleParameters = EF10 default.
   protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
       => optionsBuilder.UseSqlServer(connectionString,
           o => o.UseParameterizedCollectionMode(ParameterTranslationMode.MultipleParameters));
   ```

7. **Pin enum-in-JSON storage if you rely on string values.** EF Core 8 changed enums inside JSON-mapped owned types from strings to integers. Existing documents written by EF 6 hold strings; after the upgrade EF reads them as integers and fails. Force the string conversion to keep old data readable. Verify by round-tripping one entity with an enum property in a JSON column.
   ```csharp
   protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
       => configurationBuilder.Properties<OrderStatus>().HaveConversion<string>();
   ```

8. **Add a migration for the schema changes EF now wants.** EF Core 8 gives TPH discriminator columns a bounded max length, and EF Core 10 maps JSON columns to the native `json` type on Azure SQL or compatibility level 170. Generate the migration, read it, and only then apply it. Verify with a review of the generated `AlterColumn` operations.
   ```bash
   dotnet ef migrations add UpgradeToEfCore11
   dotnet ef migrations script --idempotent --output migrate.sql
   ```

9. **Split out Entra ID authentication if you use it.** EF Core 11 moves to `Microsoft.Data.SqlClient` 7.0, which drops Azure auth dependencies from the core package. If a connection string uses `Active Directory` authentication, add the extensions package. Verify by connecting with the managed identity in a deployed environment, not just locally.
   ```xml
   <PackageReference Include="Microsoft.Data.SqlClient.Extensions.Azure" Version="7.0.0" />
   ```

## Verification

Run this smoke test after the migration, in order:

1. `dotnet build` is clean, including the `Microsoft.EntityFrameworkCore.Design` reference resolving (the EF 11 tools no longer pull it in transitively).
2. `dotnet ef migrations has-pending-model-changes` reports no pending changes.
3. The app starts and `Migrate()` (if you call it) applies cleanly, with no `PendingModelChangesWarning` or `MigrationsNotFound`.
4. `dotnet test` is green. Pay attention to tests that assert on generated SQL strings; the `Contains` and parameterized-collection translations changed, so snapshot assertions will need updating.
5. Run a query that filters by a `Contains` over a list and confirm it executes, not just compiles.
6. Spot-check a JSON-mapped entity with an enum, and a string-keyed entity used in a relationship, for correct values.

## Rollback plan

The package and code changes are reversible: revert the branch, restore EF Core 6.0 packages, and downgrade the `dotnet-ef` tool. The risk is the schema migration from step 8. The discriminator max-length and native `json` alterations change the database, and EF Core 6.0 will not know about a migration stamped by EF Core 11. If you must be able to roll back the runtime after applying that migration, generate a down-script first (`dotnet ef migrations script UpgradeToEfCore11 PreviousMigration`) and keep it with the release. Without that script, the schema change is effectively one-way for an EF 6 binary.

## Gotchas we hit

**The `Contains` timeout is the sneakiest one.** The query compiles, returns correct results, and passes every test on a small dataset. Then a production table with millions of rows hits the `OPENJSON` plan and the query times out. The EF team refined this three times: EF 8 introduced `OPENJSON`, EF 9 added `TranslateParameterizedCollectionsToConstants`, and EF 10 changed the default to multiple scalar parameters. If you see a regression, the per-query escape hatch is `EF.Constant(list).Contains(...)` to inline the values for that one query while leaving the global default alone. The [N+1 detection guide](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) and [query splitting guide](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) cover the adjacent query-shape traps worth checking in the same pass.

**Case-insensitive string keys silently change matching.** EF Core 8 made the SQL Server provider compare string key values case-insensitively in the change tracker, to match how SQL Server matches foreign keys. If your code relied on `"ABC"` and `"abc"` being distinct keys in memory, the change tracker now treats them as the same entity. The fix is a custom case-sensitive `ValueComparer` on those keys, but first confirm you actually depend on it; most apps want the new behavior.

**The pending-changes throw fires on dynamic seed data.** A model that seeds with `HasData` using `DateTime.UtcNow` or `Guid.NewGuid()` looks "modified" to EF on every build, so EF 9 throws `PendingModelChangesWarning` even though you changed nothing. Replace the dynamic values with static constants in the seed, or move to the EF 9 seeding pattern. This one is easy to misdiagnose as a real migration bug.

**Database-first scaffolding output changes shape.** If you re-scaffold from the database, EF 8 now generates `DateOnly` and `TimeOnly` for `date` and `time` columns, drops the nullable wrapper on boolean columns with a default, and names navigations differently for composite foreign keys. None of these break a running app, but they produce a large, noisy diff that is easy to mistake for a mistake. Re-scaffold in its own commit so the diff is reviewable.

Five major versions sounds heavier than it is. Two changes will stop your app cold on the first run (the `Encrypt` default and the migration throw), and one is a latent performance trap (the `Contains` translation). Plan for those three, generate and read the one schema migration, and the rest is package bumps and a green test run. For the broader runtime side of the same upgrade, the [.NET 8 to .NET 11 checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) covers the framework, ASP.NET Core, and C# 14 changes that travel alongside this one.

## Sources

- [Breaking changes in EF Core 7.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes)
- [Breaking changes in EF Core 8.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes)
- [Breaking changes in EF Core 9.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes)
- [Breaking changes in EF Core 10.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [Breaking changes in EF Core 11.0](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes)
- [Microsoft.Data.SqlClient 7.0 release notes](https://github.com/dotnet/SqlClient/blob/main/release-notes/7.0/7.0.0.md)
