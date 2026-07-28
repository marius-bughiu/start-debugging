---
title: "How to apply EF Core 11 migrations in production with dotnet ef migrations bundle"
description: "A complete guide to deploying EF Core 11 schema changes with migration bundles: building efbundle in CI, the appsettings.json trap with named connection strings, self-contained bundles and the Alpine musl RID, migration locking since EF Core 9, rolling back with a target migration, and why per-migration transactions do not save you on MySQL."
pubDate: 2026-07-28
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "migrations"
  - "devops"
---

To apply EF Core 11 migrations to a production database, build a migration bundle in CI with `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle`, publish that single executable as a build artifact, and run it as its own deployment step with `./efbundle --connection "$CONNECTION_STRING"`. The bundle carries your compiled migrations and the EF Core runtime inside one file. The machine that runs it needs no .NET SDK, no `dotnet-ef` tool, and no access to your source code, and your application never needs schema-altering permissions on the database. This post targets EF Core 11 and .NET 11 (preview 6 at the time of writing, GA in November 2026) with C# 14. Bundles have existed since EF Core 6, so everything here works on EF Core 6 through 11, and I flag the version floors where behaviour differs.

## What is actually wrong with the other three strategies

Every .NET team ends up picking one of four ways to get schema changes into production, and three of them have a failure mode that only shows up under load or under pressure.

**Calling `Database.Migrate()` at startup** is the one that hurts most often. Microsoft's own guidance calls it inappropriate for production, and the reasons compound: your app process needs `db_ddladmin` or equivalent forever, not just during deploys; the migration runs with no human looking at the SQL; and rollback means shipping a new build. Since EF Core 9 the concurrency hazard is at least handled, because `Migrate()` and `MigrateAsync()` acquire a database-wide lock before applying anything, so ten replicas rolling out simultaneously will serialise instead of corrupting each other. That fixed the worst symptom but none of the structural problems.

**Running `dotnet ef database update` on the deployment agent** means installing the .NET SDK and the `dotnet-ef` tool on that agent, checking out the source, and building the project just to apply a `CREATE INDEX`. If that agent is your production box, you have now put a compiler on it.

**Generating a SQL script** with `dotnet ef migrations script --idempotent` is the strategy Microsoft still recommends first, and it has a genuine advantage: a DBA can read it before it runs. The cost is that you now need a tool to execute it, and, as the EF team put it in the docs, the transaction handling and continue-on-error behaviour of those tools is inconsistent and sometimes unexpected. `sqlcmd` will happily keep going after statement 40 of 120 fails, leaving your schema somewhere between two migrations with no record of where.

Bundles remove that class of problem: the executable applies migrations through the same EF Core code path as `dotnet ef database update`, with the same transaction semantics, and it either reports success or a non-zero exit code.

## The four-step pipeline

Here is the whole deployment shape, and the rest of the post is detail on each step.

1. **Verify the model and the migrations agree.** Run `dotnet ef migrations has-pending-model-changes` in CI. It exits non-zero if someone changed an entity and forgot to run `migrations add`.
2. **Build the bundle once**, in CI, from the same commit that produced your application binaries: `dotnet ef migrations bundle --self-contained -r linux-x64 -o ./artifacts/efbundle --force`.
3. **Publish `efbundle` as a build artifact**, alongside any `appsettings.json` it needs.
4. **Run it as a discrete deployment step**, before the new application version starts serving: `./efbundle --connection "$CONNECTION_STRING"`.

## Building the bundle

The command is a design-time command, so it needs `Microsoft.EntityFrameworkCore.Design` referenced by the startup project and a working `dotnet ef` install:

```bash
# EF Core 11, .NET 11
dotnet tool install --global dotnet-ef
dotnet ef migrations bundle
```

```output
Build started...
Build succeeded.
Building bundle...
Done. Migrations Bundle: /src/App.Api/efbundle
```

By default the output lands next to the startup project and is named `efbundle` (`efbundle.exe` on Windows), built for the RID of the machine doing the building. The options are short enough to list in full:

| Option | Short | What it does |
| --- | --- | --- |
| `--output <FILE>` | `-o` | Path of the executable to create. |
| `--force` | `-f` | Overwrite an existing bundle. |
| `--self-contained` | | Bundle the .NET runtime too, so the target machine needs no runtime installed. |
| `--target-runtime <RID>` | `-r` | The runtime identifier to build for. |

Plus the usual design-time options: `--project`, `--startup-project`, `--context`, `--configuration`, `--framework`, `--no-build`.

In a real solution the context lives in a class library and the host lives elsewhere, so CI runs something closer to this:

```bash
# EF Core 11, .NET 11 - context in a class library, host in the API project
dotnet ef migrations bundle \
  --project src/App.Infrastructure \
  --startup-project src/App.Api \
  --context AppDbContext \
  --configuration Release \
  --self-contained -r linux-x64 \
  -o ./artifacts/efbundle \
  --force
```

EF Core 11 lets you stop repeating most of that. Drop a `.config/dotnet-ef.json` file at the repository root and `dotnet ef` walks up from the working directory to find it:

```json
{
  "project": "src/App.Infrastructure",
  "startupProject": "src/App.Api",
  "context": "AppDbContext",
  "configuration": "Release"
}
```

Explicit command-line options still win over the file, so a developer can override any of it locally. This is new in EF Core 11 and is the single best reason to upgrade the tool on your build agents.

## What the bundle does at run time

Run the executable and it applies every migration in the assembly that is not already recorded in `__EFMigrationsHistory`:

```bash
./efbundle --connection "Server=prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true"
```

```output
Applying migration '20260721104512_AddOrderIndexes'.
Applying migration '20260726091133_AddCustomerTier'.
Done.
```

Run it a second time and it does nothing, which is exactly what you want from a deployment step that might get retried:

```output
No migrations were applied. The database is already up to date.
Done.
```

Its full surface is one argument and four options. The argument is the target migration: pass a migration name or ID to migrate up or **down** to that point, and pass `0` to revert every migration. The options are `--connection`, `--verbose` (`-v`), `--no-color`, and `--prefix-output`. That is all. There is no `--timeout` flag, which is why a long-running index build on a large table needs `Command Timeout=600` set inside the connection string itself; I covered that failure mode in detail when writing about [the timeout that kills EF Core migrations mid-deploy](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

`--prefix-output` is worth turning on in CI: it tags each line with its severity, which gives your log aggregator something to filter on.

## The appsettings.json trap

This is the failure that costs teams an afternoon, and it is not obvious from the docs.

If your `DbContext` is configured with a **named** connection string, for example `optionsBuilder.UseSqlServer("name=ConnectionStrings:DefaultConnection")`, the bundle still needs an `appsettings.json` in its working directory containing that key. Even when you pass `--connection` on the command line. Without it you get:

```output
A named connection string was used, but the name 'ConnectionStrings:DefaultConnection'
was not found in the application's configuration. Note that named connection strings
are only supported when using 'IConfiguration' and a service provider, such as in a
typical ASP.NET Core application.
```

The value in that file is irrelevant, because `--connection` overrides it; the *key* just has to exist for configuration binding to succeed. This was reported as [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) and closed as not planned, so plan around it rather than waiting for a fix. Two ways out:

- Ship a stub `appsettings.json` next to the bundle in your artifact, with a placeholder value under the expected key.
- Or stop using a named connection string in the design-time path, so the bundle has nothing to resolve.

The EF Core docs are blunt about the general case too: do not forget to copy `appsettings.json` alongside your bundle, because the bundle relies on its presence in the execution directory. If your configuration is split by environment, set `ASPNETCORE_ENVIRONMENT` (or `DOTNET_ENVIRONMENT` for a non-web host) before running the bundle and copy the matching `appsettings.Production.json` too. The bundle has no `--environment` flag of its own.

My preference is to sidestep configuration entirely: pass the full connection string with `--connection`, sourced from your secret store at deploy time, and keep a stub `appsettings.json` only to satisfy the binder. It makes the bundle a pure function of its arguments, which is what you want when the same artifact promotes through staging and production.

## Self-contained bundles, and the Alpine gotcha

`--self-contained -r linux-x64` produces an executable that carries the .NET runtime with it. That is the right default for containerised deployments, because it means your migration step can run in a minimal image that has no .NET installed at all.

The RID has to match the target's libc, not just its architecture. A `linux-x64` self-contained bundle targets glibc and will not run on Alpine or any other musl-based image; you want `linux-musl-x64` there. The failure is a confusing "not found" or loader error rather than a clear message, so pin the RID deliberately:

```bash
# EF Core 11, .NET 11 - for an Alpine-based runner
dotnet ef migrations bundle --self-contained -r linux-musl-x64 -o ./artifacts/efbundle --force
```

Globalization is the second Alpine trip-hazard. A self-contained bundle expects ICU, and Alpine images need `icu-libs` installed. Adding `apk add --no-cache icu-libs` to the migration image is cheaper than debugging `Couldn't find a valid ICU package installed on the system` inside a deployment window.

If your production runner already has the matching .NET runtime, drop `--self-contained` and get a much smaller artifact. In a Kubernetes init container or a Job that runs before the rollout, the self-contained version usually wins anyway, because it decouples the migration step from the runtime version of your app image. The same reasoning applies when you are [building the app image itself with `dotnet publish /t:PublishContainer`](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/): keep the schema step and the app step as separate artifacts.

## Migration locking, and what it does not cover

Since EF Core 9, applying migrations acquires a database-wide lock first. This applies to `dotnet ef database update`, to `Update-Database`, to `Migrate()` and `MigrateAsync()`, and to migration bundles. The lock is held for the whole operation, including any seeding code that runs as part of it, so if you seed with [`UseSeeding` and `UseAsyncSeeding`](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) that work is covered too.

What the lock does **not** cover is SQL scripts, because those execute outside EF Core entirely. If half your pipeline runs a bundle and half runs a generated script, you have no mutual exclusion between them. Pick one.

The locking mechanism is provider-specific and has sharp edges. On SQLite it is implemented with a lock table that can be left behind if the process dies mid-migration, which then blocks every subsequent migration until you clear it manually. That matters if you run integration tests against SQLite and kill the test host.

There is one more limitation worth knowing before you design around this: you cannot wrap `MigrateAsync` in an explicit transaction. Since EF Core 9 that throws.

## Transactions are per migration, not per bundle

A common misreading is that a bundle applies all pending migrations atomically. It does not. EF Core wraps **each migration** in its own transaction. Three pending migrations means three transactions. If the second one fails, the first stays applied and recorded in `__EFMigrationsHistory`, and the third never runs.

That is usually the behaviour you want, since re-running the bundle picks up exactly where it stopped. But it means "the deploy failed, roll back the database" is not a single operation, and you should reason about the intermediate states your schema can occupy.

Two provider-specific caveats sharpen this:

- On databases without transactional DDL, notably MySQL, a failed migration can leave partial schema changes behind with no rollback at all. Each DDL statement implicitly commits. On MySQL, treat every migration as if it were non-transactional and keep migrations small enough to reason about by hand.
- Some operations cannot run inside a transaction even on SQL Server or PostgreSQL, for example creating an index concurrently. For those, pass `suppressTransaction: true` to `migrationBuilder.Sql(...)` and accept that the statement is not covered.

```csharp
// EF Core 11, C# 14 - a statement that must not run inside the migration transaction
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql(
        "CREATE INDEX CONCURRENTLY IX_Orders_CustomerId ON \"Orders\" (\"CustomerId\");",
        suppressTransaction: true);
}
```

## Rolling back

The bundle takes a target migration as its positional argument, and migrating "down" is the same command with an earlier target:

```bash
# EF Core 11 - revert to the state right after AddOrderIndexes
./efbundle 20260721104512_AddOrderIndexes

# EF Core 11 - revert everything. Read that twice before running it.
./efbundle 0
```

For this to work, the bundle you run must *contain* the migrations you are reverting to, which is an argument for keeping every bundle artifact you have ever deployed rather than only the latest. The `Down` methods also have to be correct, and they are the least-tested code in most repositories. A `Down` that drops a column is not a rollback; it is data loss with extra steps. This is exactly the review that generating a script buys you, and there is nothing stopping you from producing both artifacts in CI: run the bundle in the pipeline, and attach `dotnet ef migrations script --idempotent -o schema.sql` to the same build for the DBA to read.

## Catching the mismatch before deploy

Since EF Core 9, `Migrate()` throws when the model has pending changes relative to the last migration (`RelationalEventId.PendingModelChangesWarning`). You do not want to discover that during a deploy. Put the check in CI instead:

```bash
# EF Core 11 - fails the build if an entity changed without a migration
dotnet ef migrations has-pending-model-changes \
  --project src/App.Infrastructure \
  --startup-project src/App.Api
```

The command was added in EF Core 8 and exits non-zero when the model and the migrations have drifted. Pair it with the build of the bundle in the same job, so the artifact and the check come from one commit.

While you are hardening the pipeline, two related failure modes are worth pre-empting: `dotnet ef` needing a design-time factory when [it cannot create your DbContext](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/), and the behaviour changes that bite when [upgrading from EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Where `database update --add` fits, and where it does not

EF Core 11 added `dotnet ef database update <NAME> --add`, which scaffolds a migration and applies it in one command, using Roslyn to compile the migration at run time. It is a genuinely nice inner-loop tool, and I wrote about [the single-step migration workflow](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) when it landed. It is also the exact opposite of what you want in production: it generates and applies schema changes with no artifact and no review step in between. Use it while prototyping, and keep the bundle for anything with real data behind it. The same goes for the other EF Core 11 tooling additions, `--connection` on `database drop` and `migrations remove` and `--offline` on `migrations remove`: developer-loop conveniences, not deployment tools.

If a bundle applies migrations and something looks wrong afterwards, reproduce it locally with logging turned up, which is a matter of [getting EF Core 11 to log the SQL it generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) against a scratch copy of the schema.

## Related

- [Fix: SqlException Timeout expired during EF Core migrations](/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Fix: dotnet ef migrations add fails with "Unable to create an object of type DbContext"](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [Migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [EF Core 11 lets you create and apply a migration in one command](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [How to publish a .NET 11 app as a container image with dotnet publish /t:PublishContainer](/2026/07/how-to-publish-a-dotnet-11-app-as-a-container-image-with-publishcontainer/)

## Sources

- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) covers all four deployment strategies, the `efbundle` argument and option tables, and migration locking.
- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) is the authority on `dotnet ef migrations bundle` options and the new EF Core 11 `.config/dotnet-ef.json` configuration file.
- [Introducing DevOps-friendly EF Core Migration Bundles](https://devblogs.microsoft.com/dotnet/introducing-devops-friendly-ef-core-migration-bundles/) is the original announcement and explains the design intent.
- [dotnet/efcore#32009](https://github.com/dotnet/efcore/issues/32009) documents the named-connection-string requirement for `appsettings.json`, closed as not planned.
- [Managing Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) describes per-migration transactions and `suppressTransaction`.
- [SQLite provider limitations](https://learn.microsoft.com/en-us/ef/core/providers/sqlite/limitations) covers abandoned migration locks.
