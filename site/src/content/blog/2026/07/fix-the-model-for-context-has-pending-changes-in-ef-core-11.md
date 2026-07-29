---
title: "Fix: \"The model for context 'X' has pending changes\" in EF Core 11"
description: "EF Core throws PendingModelChangesWarning when your model no longer matches the last migration snapshot. Add the migration, or fix the false positive behind it."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "migration"
---

Run `dotnet ef migrations add <Name>` and then `dotnet ef database update`. Since EF Core 9.0, `Migrate()`, `MigrateAsync()`, and `dotnet ef database update` compare your current model against the snapshot written by the last migration and throw `PendingModelChangesWarning` if they differ, and the overwhelmingly common cause is a model change with no migration behind it. If the migration you just generated is empty, or is identical every time you regenerate it, you have a false positive: non-deterministic `HasData` values, a missing model snapshot, Identity options that only exist in the startup project, or a snapshot produced by an older EF Core version. This post targets EF Core 11.0 on .NET 11 (preview 6 at the time of writing, GA in November 2026) with C# 14, and everything applies unchanged back to EF Core 9.0, where the throw was introduced.

## The error in context

The runtime exception, thrown from a `Database.Migrate()` call at startup:

```
Microsoft.EntityFrameworkCore.Migrations[20409]
System.InvalidOperationException: An error was generated for warning 'Microsoft.EntityFrameworkCore.Migrations.PendingModelChangesWarning': The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes. This exception can be suppressed or logged by passing event ID 'RelationalEventId.PendingModelChangesWarning' to the 'ConfigureWarnings' method in 'DbContext.OnConfiguring' or 'AddDbContext'.
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.ValidateMigrations(String targetMigration)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.Migrate(DatabaseFacade databaseFacade)
```

The same failure from the CLI is shorter, and the exit code is non-zero:

```
Build started...
Build succeeded.
The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes.
```

Event ID `20409` is `RelationalEventId.PendingModelChangesWarning` (`CoreEventId.RelationalBaseId + 409`), in the `Microsoft.EntityFrameworkCore.Migrations` logger category. On EF Core 9.0.0 the message had no `aka.ms` link, which is the only wording difference between 9.0 and 11.0.

## Why this happens

The check compares two models: the design-time model EF builds from your `DbContext` right now, and the model snapshot serialized into `Migrations/AppDbContextModelSnapshot.cs` when you last ran `migrations add`. It does **not** look at your database. That is the single most useful thing to know about this error, because it means a perfectly up-to-date database will not save you, and a stale one will not cause the error.

The comparison is the same one that powers migration scaffolding. From EF Core's own `Migrator` implementation:

```csharp
// efcore/src/EFCore.Relational/Migrations/Internal/Migrator.cs, EF Core 11
public bool HasPendingModelChanges()
    => _migrationsModelDiffer.HasDifferences(
        FinalizeModel(_migrationsAssembly.ModelSnapshot?.Model)?.GetRelationalModel(),
        _designTimeModel.Model.GetRelationalModel());
```

Two things follow from that shape. First, the diff runs over the *relational* model, so it sees column types, lengths, nullability, indexes, and constraint names, not just your entity classes. A `HasMaxLength(128)` that used to be `450` is a pending change even though no C# property changed. Second, if `ModelSnapshot` is `null`, the source model is `null` and every table in your model reads as a difference.

The EF team's motivation was straightforward: silently applying migrations while the model has drifted past them produces a database that does not match the code, and that failure surfaces much later as a missing-column exception in production. Before EF Core 9.0, `Migrate()` applied the migrations it had and returned without a word.

## Minimal repro

Two files and one forgotten command:

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public string? Slug { get; set; }   // added after the last migration
}

public class AppDbContext : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=.;Database=Demo;Trusted_Connection=True;Encrypt=False");
}
```

```csharp
// Program.cs, .NET 11
using var db = new AppDbContext();
db.Database.Migrate();   // throws PendingModelChangesWarning
```

Add `Slug`, skip `dotnet ef migrations add AddBlogSlug`, and the next `Migrate()` throws. The database is irrelevant here: drop it, recreate it, or point at a fresh server, and you get the identical exception.

## Fix, in order of likelihood

**1. Add the migration you forgot.** This is the correct fix in the vast majority of cases:

```bash
dotnet ef migrations add AddBlogSlug
```

Then apply it with `dotnet ef database update`, or let `Migrate()` do it on the next start. EF Core 11 also collapses those two steps into one, which is useful when the app is running in a container you cannot rebuild: `dotnet ef database update AddBlogSlug --add` scaffolds the migration, compiles it with Roslyn, and applies it in a single command. That is covered in more depth in the writeup on [creating and applying a migration in one step](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/).

**2. Regenerate a missing or hand-edited snapshot.** If someone hand-wrote a migration class, or deleted `AppDbContextModelSnapshot.cs`, or resolved a merge conflict in it by taking one side wholesale, the snapshot no longer describes the model the migrations produce. Run `dotnet ef migrations add` once with the tooling: the generated migration will contain the real drift, and the snapshot is rewritten as a side effect. Never edit the snapshot by hand to make the error go away, because the next scaffolded migration diffs against whatever you left there.

**3. Replace non-deterministic `HasData` values with constants.** A `Guid.NewGuid()` or `DateTime.UtcNow` inside a seed object is evaluated every time the model is built, so the model genuinely differs from the snapshot on every run. EF Core detects this specific case and follows the error with a second diagnostic:

> The model for context '{contextType}' changes each time it is built. This is usually caused by dynamic values used in a 'HasData' call (e.g. `new DateTime()`, `Guid.NewGuid()`). Add a new migration and examine its contents to locate the cause, and replace the dynamic call with a static, hardcoded value.

The fix is to hardcode the values:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<Blog>().HasData(new Blog
{
    Id = 1,
    Name = "Start Debugging",
    // Not Guid.NewGuid(), not DateTime.UtcNow.
    PublicId = Guid.Parse("9e4f49fe-0786-44c6-9061-53d2aa84fab3"),
    CreatedUtc = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
});
```

Regenerate the migration after fixing the model, since the previous one captured a random value. If the data genuinely has to be dynamic, it does not belong in the model at all: move it to `UseSeeding`/`UseAsyncSeeding`, which runs outside the snapshot. The full procedure is in [migrating from HasData seeding to UseAsyncSeeding](/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/), and the tradeoffs are laid out in [HasData vs UseSeeding](/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/).

**4. Give the EF tools the same configuration your app has.** ASP.NET Core Identity is the classic case. Options such as `Stores.SchemaVersion` or `Stores.MaxLengthForKeys` change the model, they are set in the app's DI container, and the EF tools do not see them if you run the tools against the `DbContext` project alone. The snapshot then describes a different model than the running app builds. Either pass the app as the startup project:

```bash
dotnet ef migrations add AddBlogSlug --project src/Data --startup-project src/Web
```

or implement `IDesignTimeDbContextFactory<T>` next to the context so both paths build the model identically:

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbContextDesignTimeFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var services = new ServiceCollection();
        services.AddDefaultIdentity<ApplicationUser>(options =>
            {
                options.Stores.SchemaVersion = IdentitySchemaVersions.Version2;
                options.Stores.MaxLengthForKeys = 256;
            })
            .AddEntityFrameworkStores<AppDbContext>();

        var optionsBuilder = new DbContextOptionsBuilder<AppDbContext>();
        optionsBuilder.UseApplicationServiceProvider(services.BuildServiceProvider());
        optionsBuilder.UseSqlServer();
        return new AppDbContext(optionsBuilder.Options);
    }
}
```

**5. Regenerate a snapshot written by an older EF Core version.** Snapshot generation improves between releases, so a snapshot produced by EF Core 6 can diff against an EF Core 11 model even with no code change. EF Core detects this too, with `RelationalEventId.OldMigrationVersion` (`20414`): "Pending model changes were detected for context '{contextType}', but the model snapshot was created with EF Core version '{efVersion}'." Add an empty migration to rewrite the snapshot at the current version, review that its `Up` is genuinely empty, and keep it. This is a routine step in a [migration from EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**6. Suppress it, but only for the two cases where it is a real false positive.** If your migrations are generated or chosen dynamically by replacing EF services, or you have verified there is nothing left to migrate, suppress the specific event:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<AppDbContext>(options => options
    .UseSqlServer(connectionString)
    .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)));
```

Use `w.Log(RelationalEventId.PendingModelChangesWarning)` instead if you want it in the logs rather than silenced. Suppression is also the only lever when the last migration was generated for a different provider than the one applying it (SQLite locally, SQL Server in production), but Microsoft explicitly calls that unsupported and likely to stop working, so generate a separate set of migrations per provider instead.

## How to tell which cause you have

Start with the command, not the exception. `dotnet ef migrations has-pending-model-changes` has existed since EF Core 8.0 and exits non-zero when the model has drifted, which makes it the right thing to run in CI before a deploy:

```bash
dotnet ef migrations has-pending-model-changes
```

The programmatic equivalent, `context.Database.HasPendingModelChanges()`, turns the same check into a test that fails on the pull request that forgot the migration:

```csharp
// .NET 11, EF Core 11.0.0, xUnit v3
[Fact]
public void Model_has_no_pending_changes()
{
    using var context = new AppDbContext();
    Assert.False(context.Database.HasPendingModelChanges());
}
```

Then scaffold a migration and read it. The generated `Up` method is the diff, in plain terms: an `AddColumn` tells you which property you forgot, an `AlterColumn` with `maxLength: 128` against a legacy `nvarchar(450)` column tells you the model and the database schema disagree on width, and an `InsertData` with a fresh GUID every time tells you cause 3. Delete the migration with `dotnet ef migrations remove` if it turns out to be spurious.

If the scaffolded migration is empty and the error still fires, EF's own comparison is seeing something the scaffolder is not emitting. Mirror what `HasPendingModelChanges` does and print the raw operations:

```csharp
// .NET 11, EF Core 11.0.0. Uses EF internals: pin your EF version if you keep this.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

using var context = new AppDbContext();

var differ = context.GetService<IMigrationsModelDiffer>();
var initializer = context.GetService<IModelRuntimeInitializer>();
var snapshot = context.GetService<IMigrationsAssembly>().ModelSnapshot?.Model;

var source = snapshot is null ? null : initializer.Initialize(snapshot).GetRelationalModel();
var target = context.GetService<IDesignTimeModel>().Model.GetRelationalModel();

foreach (var operation in differ.GetDifferences(source, target))
{
    Console.WriteLine(operation.GetType().Name);
}
```

`IMigrationsModelDiffer` is a public interface but an internal-use service, so treat this as a debugging tool rather than production code.

## Gotchas and variants

**Rolling back stopped triggering it in 9.0.2.** EF Core 9.0.0 and 9.0.1 threw `PendingModelChangesWarning` even when you targeted an explicit older migration, which made rollback impossible without suppressing the warning. That was fixed in 9.0.2: the check now runs only when no target migration is specified, so `dotnet ef database update AddBlogSlug` and `dotnet ef database update 0` work with pending changes present.

**"No migrations were found in assembly" is the EF Core 11 sibling, not the same error.** `RelationalEventId.MigrationsNotFound` (`20406`) used to be an informational log and throws by default starting in EF Core 11.0. It fires when there are no migrations at all, typically because you call `Migrate()` out of habit while managing the schema with DACPACs or hand-written SQL. Remove the `Migrate()` call, or suppress that separate event with `w.Ignore(RelationalEventId.MigrationsNotFound)`.

**Multiple `DbContext` types need one migration each.** Adding a migration for `AppDbContext` does nothing for `AuditDbContext`. The exception names the context, so read it: `dotnet ef migrations add <Name> --context AuditDbContext`.

**Multi-targeted projects need `--framework` since EF Core 10.** If your project uses `<TargetFrameworks>`, the tools error out with "The project targets multiple frameworks" before they ever get to the model comparison. Pass `--framework net11.0`.

**`EnsureCreated()` never throws this.** It does not use migrations at all, so it neither reads the snapshot nor applies migration history. If you mix `EnsureCreated()` in tests with `Migrate()` in production, only the production path fails.

**The database schema is still not verified.** Passing this check means your model matches your last migration. It says nothing about whether the migration was applied, or whether someone hand-edited a column in production. Applying schema changes in a discrete deployment step, as described in [applying EF Core 11 migrations with a migration bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), is what closes that gap.

## Related

- [Applying EF Core 11 migrations in production with a migration bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) - where the `has-pending-model-changes` check belongs in a deployment pipeline.
- [Creating and applying a migration in one command](/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) - the EF Core 11 `--add` option.
- [Migrating from HasData seeding to UseAsyncSeeding](/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/) - the permanent fix for seed data that keeps re-triggering this error.
- [HasData vs UseSeeding in EF Core 11](/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) - which seeding mechanism belongs in the model and which does not.
- [Migrating EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) - the other breaking changes that surface during the same upgrade.

## Sources

- [Breaking changes in EF Core 9: exception is thrown when applying migrations if there are pending model changes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) - the authoritative list of causes and mitigations, including the Identity design-time factory sample.
- [Breaking changes in EF Core 11: EF Core now throws by default when no migrations are found](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes) - the `MigrationsNotFound` change.
- [Managing migrations: checking for pending model changes](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) - `has-pending-model-changes` and `HasPendingModelChanges()`.
- [dotnet/efcore#35285: background and information around the 9.0 PendingModelChangesWarning error](https://github.com/dotnet/efcore/issues/35285) - the EF team's own triage of the false positives.
- [dotnet/efcore#35342](https://github.com/dotnet/efcore/issues/35342) and its fix in 9.0.2 - the rollback regression.
- [Migrator.cs in dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) and [RelationalStrings.resx](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Properties/RelationalStrings.resx) - the comparison itself and the exact message text.
