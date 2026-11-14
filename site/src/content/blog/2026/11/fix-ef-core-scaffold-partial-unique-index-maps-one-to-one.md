---
title: "Fix: EF Core scaffold maps a PostgreSQL partial unique index as one-to-one instead of one-to-many"
description: "dotnet ef dbcontext scaffold treats any unique index on the FK columns as one-to-one, even with a WHERE filter. Override VisitForeignKey in a custom IScaffoldingModelFactory, or add the filter column to the index key. INCLUDE does not help."
pubDate: 2026-11-14
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "postgresql"
  - "npgsql"
  - "scaffolding"
---

**Short answer:** EF Core's reverse engineering marks a foreign key as unique (one-to-one) when the dependent table has *any* unique index over exactly the FK columns, and it never looks at the index's `WHERE` filter. So `CREATE UNIQUE INDEX ... ON target_request (target_id) WHERE is_active = true` scaffolds `Target.TargetRequest` instead of `Target.TargetRequests`. The cleanest fix is a custom `IScaffoldingModelFactory` in your startup project that overrides `VisitForeignKey` and clears `IsUnique` when every matching unique index is filtered. If you can change the schema, adding `is_active` to the index key also works. Adding it as an `INCLUDE` column does not, because Npgsql drops included columns when it reads indexes.

This is not cosmetic. With the scaffolded one-to-one model, a plain `Include(t => t.TargetRequest).ToList()` marks every request except one as `Deleted`, and the next `SaveChanges()` removes them from the database. Everything below was reproduced on macOS with .NET SDK 10.0.302, EF Core 10.0.15 with `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3, and again on .NET SDK 11.0.100 with EF Core 11.0.0-rc.3.26522.148 and Npgsql 11.0.0-rc.3 (the newest Npgsql provider at the time of writing pins that exact EF Core build). Both versions produce byte-identical scaffolded code.

## The error in context

The schema comes from a [Stack Overflow question](https://stackoverflow.com/questions/79901383): one target has many requests, but only one of them may be active at a time.

```sql
-- PostgreSQL
create schema if not exists trgt;

create table trgt.target (
    id serial primary key,
    name varchar(255) not null
);

create table trgt.target_request (
    id serial primary key,
    target_id integer not null,
    is_active boolean not null,
    constraint fk_target_request_target
        foreign key (target_id) references trgt.target(id) on delete cascade
);

create unique index ux_target_request_active_per_target
    on trgt.target_request (target_id)
    where is_active = true;
```

Scaffolding it with `dotnet ef dbcontext scaffold "..." Npgsql.EntityFrameworkCore.PostgreSQL --schema trgt --data-annotations --no-onconfiguring` produces a reference navigation where you expect a collection:

```csharp
// Scaffolded by EF Core 10.0.15 / 11.0.0-rc.3 with Npgsql
[Table("target", Schema = "trgt")]
public partial class Target
{
    [Key]
    [Column("id")]
    public int Id { get; set; }

    [Column("name")]
    [StringLength(255)]
    public string Name { get; set; } = null!;

    [InverseProperty("Target")]
    public virtual TargetRequest? TargetRequest { get; set; }
}
```

And in the context:

```csharp
// Scaffolded by EF Core 10.0.15 / 11.0.0-rc.3 with Npgsql
entity.HasIndex(e => e.TargetId, "ux_target_request_active_per_target")
    .IsUnique()
    .HasFilter("(is_active = true)");

entity.HasOne(d => d.Target).WithOne(p => p.TargetRequest)
    .HasConstraintName("fk_target_request_target");
```

Drop the index and scaffold again, and you get the expected `ICollection<TargetRequest> TargetRequests` with `WithMany`. The index is the only thing that changes the cardinality.

## Why this happens

The decision lives in `RelationalScaffoldingModelFactory.VisitForeignKey` in `Microsoft.EntityFrameworkCore.Design`. After it creates the foreign key, it does this (same code at the `v10.0.9` and `v11.0.0` tags of [dotnet/efcore](https://github.com/dotnet/efcore/blob/v11.0.0/src/EFCore.Design/Scaffolding/Internal/RelationalScaffoldingModelFactory.cs)):

```csharp
// EF Core 10 / 11, RelationalScaffoldingModelFactory.VisitForeignKey (excerpt)
var dependentKey = dependentEntityType.FindKey(dependentProperties);
var dependentIndexes = dependentEntityType.GetIndexes()
    .Where(i => i.Properties.SequenceEqual(dependentProperties));
newForeignKey.IsUnique = dependentKey != null
    || dependentIndexes.Any(i => i.IsUnique);
```

`i.IsUnique` is true for a partial index, and `i.GetFilter()` is never consulted. A unique FK becomes a one-to-one relationship, `AddNavigationProperties` skips the pluralizer because the FK is unique, and the code generator emits `WithOne`.

This is a known, long-standing bug: [dotnet/efcore#11298](https://github.com/dotnet/efcore/issues/11298), "Scaffold-DbContext generates incorrect nav property on foreign key with filtered unique index", opened in March 2018 and still open in the Backlog milestone. The logic is in the provider-agnostic design package, so SQL Server filtered indexes (`CREATE UNIQUE INDEX ... WHERE [IsActive] = 1`) hit exactly the same path. PostgreSQL users just run into it more because partial unique indexes are the idiomatic way to express "one active row per parent" there.

## Why the one-to-one model loses data

It is tempting to leave the scaffolded model alone and load requests with a separate query. The problem is that EF Core now believes at most one `TargetRequest` row can point at a given `Target`, and its change tracker enforces that belief on whatever the query returns.

To check this without a PostgreSQL server, the same schema (partial unique index included) was created in SQLite with `Microsoft.EntityFrameworkCore.Sqlite` 10.0.15, seeded with one target and three requests (ids 1 and 2 inactive, id 3 active), and mapped twice: once exactly as the scaffolder maps it (`WithOne`) and once as one-to-many. Relationship fix-up and cascade handling are done by EF Core's change tracker, not the provider, so the behaviour carries over to Npgsql.

```csharp
// .NET 10, EF Core 10.0.15, Microsoft.EntityFrameworkCore.Sqlite 10.0.15
// OneToOneContext maps: HasOne(d => d.Target).WithOne(p => p.TargetRequest)
var single = ctx.Targets.Include(t => t.TargetRequest).Single();
// InvalidOperationException: Sequence contains more than one element

var list = ctx.Targets.Include(t => t.TargetRequest).ToList();
// list.Count == 3, but all three entries are the same Target instance
// target.TargetRequest.Id == 3
// Tracked requests: 1:Deleted, 2:Deleted, 3:Unchanged

list[0].Name = "alpha (renamed)";
ctx.SaveChanges();
// DELETE FROM "target_request" ... runs twice
// Rows left in target_request: 3
```

Three separate failures come out of one wrong cardinality:

1. **`Single()` throws.** A reference `Include` is translated as a `LEFT JOIN` with no collection buffering, so one target with three requests comes back as three rows, and `Single()` sees three results.
2. **`ToList()` returns duplicates.** You get the same `Target` instance three times.
3. **Fix-up deletes rows.** Each joined row replaces `target.TargetRequest`. Because the relationship is required (`target_id` is `NOT NULL`), the replaced request becomes an orphan, and EF Core's default `DeleteOrphansTiming` (`Immediate`) marks it `Deleted`. Rename the target, call `SaveChanges()`, and the two inactive requests are gone.

Replacing the reference by hand does the same thing: `ctx.Entry(target).Reference(t => t.TargetRequest).Load()` picks request 1, assigning a new `TargetRequest` to the navigation and saving deletes request 1. Which request survives depends on row order, so this can pass a test suite and fail in production.

With the one-to-many mapping the same data behaves correctly: `Include(t => t.TargetRequests)` loads all three, adding another inactive request saves fine, and adding a second active request is rejected by the database: `SQLite Error 19: 'UNIQUE constraint failed: target_request.target_id'`. On PostgreSQL the partial index rejects it the same way with a `23505 unique_violation`.

## Minimal repro

You do not need a database to see the scaffolder's decision. `dotnet ef dbcontext scaffold` reads the schema into a `DatabaseModel` and hands it to `IScaffoldingModelFactory`. Building that `DatabaseModel` by hand, mirroring what `NpgsqlDatabaseModelFactory` produces for the schema above, and running it through the real design-time services gives the same output as the command line:

```csharp
// .NET 10, EF Core 10.0.15, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
// Microsoft.EntityFrameworkCore.Design referenced with IncludeAssets="all"; NoWarn EF1001
var services = new ServiceCollection();
new NpgsqlDesignTimeServices().ConfigureDesignTimeServices(services);
services.AddEntityFrameworkDesignTimeServices();
using var sp = services.BuildServiceProvider();

var model = sp.GetRequiredService<IScaffoldingModelFactory>()
    .Create(databaseModel, new ModelReverseEngineerOptions());

var fk = model.FindEntityType("TargetRequest")!.GetForeignKeys().Single();
Console.WriteLine($"IsUnique={fk.IsUnique}, nav={fk.PrincipalToDependent?.Name}");
```

The index in the `DatabaseModel` is `IsUnique = true`, `Filter = "(is_active = true)"` (PostgreSQL's `pg_get_expr` returns the predicate in parentheses, which is why the scaffolded `HasFilter` has them), with `target_id` as its only column. Each schema variant gives:

| Index on `trgt.target_request` | FK unique? | Scaffolded navigation on `Target` |
| --- | --- | --- |
| none | no | `ICollection<TargetRequest> TargetRequests` |
| `(target_id) WHERE is_active = true` | yes | `TargetRequest? TargetRequest` |
| `(target_id) INCLUDE (is_active) WHERE is_active = true` | yes | `TargetRequest? TargetRequest` |
| `(target_id, is_active) WHERE is_active = true` | no | `ICollection<TargetRequest> TargetRequests` |
| `(target_id) WHERE ...` plus the custom factory below | no | `ICollection<TargetRequest> TargetRequests` |

EF Core 10.0.15 and 11.0.0-rc.3 produced identical results for every row.

## Fix 1: a custom IScaffoldingModelFactory (no schema change)

`RelationalScaffoldingModelFactory` is public (in an `Internal` namespace, hence warning `EF1001`) and `VisitForeignKey` is `protected virtual`. Call the base implementation, then undo the uniqueness when it came only from filtered indexes:

```csharp
// .NET 10, EF Core 10.0.15 (also verified against EF Core 11.0.0-rc.3)
// Put this in the startup project that `dotnet ef` builds.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Design.Internal;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Scaffolding;
using Microsoft.EntityFrameworkCore.Scaffolding.Internal;
using Microsoft.EntityFrameworkCore.Scaffolding.Metadata;
using Microsoft.Extensions.DependencyInjection;

public class FilteredIndexDesignTimeServices : IDesignTimeServices
{
    public void ConfigureDesignTimeServices(IServiceCollection services)
        => services.AddSingleton<IScaffoldingModelFactory, FilteredIndexAwareScaffoldingModelFactory>();
}

public class FilteredIndexAwareScaffoldingModelFactory(
    IOperationReporter reporter,
    ICandidateNamingService candidateNamingService,
    IPluralizer pluralizer,
    ICSharpUtilities cSharpUtilities,
    IScaffoldingTypeMapper scaffoldingTypeMapper,
    IModelRuntimeInitializer modelRuntimeInitializer)
    : RelationalScaffoldingModelFactory(
        reporter, candidateNamingService, pluralizer, cSharpUtilities,
        scaffoldingTypeMapper, modelRuntimeInitializer)
{
    protected override IMutableForeignKey? VisitForeignKey(ModelBuilder modelBuilder, DatabaseForeignKey foreignKey)
    {
        var fk = base.VisitForeignKey(modelBuilder, foreignKey);
        if (fk is { IsUnique: true }
            && fk.DeclaringEntityType.FindKey(fk.Properties) is null)
        {
            // The FK was made unique only because of unique indexes on the same columns.
            // If every one of them is filtered (partial), the column is not unique across all rows.
            var uniqueIndexes = fk.DeclaringEntityType.GetIndexes()
                .Where(i => i.IsUnique && i.Properties.SequenceEqual(fk.Properties))
                .ToList();
            if (uniqueIndexes.Count > 0
                && uniqueIndexes.All(i => i.GetFilter() is { } filter && !IsNotNullOnly(filter)))
            {
                fk.IsUnique = false;
            }
        }
        return fk;
    }

    // "[TargetId] IS NOT NULL" (what EF Core's SQL Server migrations put on a unique index
    // over a nullable FK) still means one-to-one, so leave those alone.
    private static bool IsNotNullOnly(string filter)
        => filter.Split(" AND ", StringSplitOptions.TrimEntries)
            .All(part => part.Trim('(', ')', ' ')
                .EndsWith("IS NOT NULL", StringComparison.OrdinalIgnoreCase));
}
```

Why this works: `VisitForeignKeys` first visits every foreign key and only afterwards calls `AddNavigationProperties`, which decides between a reference and a pluralized collection by reading `foreignKey.IsUnique`. Flipping the flag right after the base call is early enough that naming, `[InverseProperty]`, and the `WithMany` call all come out as if the index were not there. The index itself is untouched, so the generated context still contains:

```csharp
// Scaffolded with FilteredIndexAwareScaffoldingModelFactory, EF Core 10.0.15
entity.HasIndex(e => e.TargetId, "ux_target_request_active_per_target")
    .IsUnique()
    .HasFilter("(is_active = true)");

entity.HasOne(d => d.Target).WithMany(p => p.TargetRequests)
    .HasConstraintName("fk_target_request_target");
```

Running `Database.GenerateCreateScript()` against that context with Npgsql 10.0.3 emits `CREATE UNIQUE INDEX ux_target_request_active_per_target ON trgt.target_request (target_id) WHERE (is_active = true);`, so migrations built from the scaffolded model keep the constraint.

Two wiring details matter:

- **`AddSingleton`, not `TryAddSingleton`.** `dotnet ef` registers the provider's and EF Core's own design-time services before calling yours, so a `TryAdd` silently loses to the built-in factory. The same trap is covered in [replacing the scaffolding pluralizer with IPluralizer](/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/).
- **The Design package needs compile assets.** The default `Microsoft.EntityFrameworkCore.Design` reference from `dotnet add package` excludes `compile`, so `RelationalScaffoldingModelFactory` will not resolve. Use `<PackageReference Include="Microsoft.EntityFrameworkCore.Design" Version="10.0.15" PrivateAssets="all" />` without the `IncludeAssets` line, in the [startup project that dotnet ef builds](/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/).

The `IsNotNullOnly` guard is there because the rule "filtered unique index means not one-to-one" is wrong in one common case. When EF Core's SQL Server provider creates an optional one-to-one relationship, it puts a unique index on the nullable FK with the filter `[TargetId] IS NOT NULL`, since SQL Server otherwise allows only one `NULL`. That index is a genuine one-to-one, and the repro confirms the guarded factory keeps it as `TargetRequest? TargetRequest`. If your database uses other filters that you do want to read as one-to-one, tighten the check, for example by matching specific index names.

Because the factory overrides an internal API, re-check it after every EF Core major upgrade. The same source file compiled and produced the same output against EF Core 10.0.15 and 11.0.0-rc.3.

## Fix 2: put the filter column in the index key

If you own the schema, this is a one-line change and needs no tooling:

```sql
-- PostgreSQL: same constraint, scaffolds as one-to-many
drop index trgt.ux_target_request_active_per_target;
create unique index ux_target_request_active_per_target
    on trgt.target_request (target_id, is_active)
    where is_active = true;
```

Every row in the index has `is_active = true`, so uniqueness on `(target_id, is_active)` is the same constraint as uniqueness on `target_id`. The scaffolder compares the index columns with the FK columns using `SequenceEqual`, so a two-column index no longer matches and the FK stays non-unique. The cost is a slightly wider index, which for a `boolean` column is negligible.

## The INCLUDE workaround does not work with Npgsql

One answer on the Stack Overflow thread suggests `create unique index ... (target_id) include (is_active) where is_active = true`. That fails with the Npgsql provider. In `NpgsqlDatabaseModelFactory`, only the first `indnkeyatts` columns are added to `DatabaseIndex.Columns`; the included columns are collected and then discarded, with the line that would store them commented out ("Scaffolding included/covered properties is currently blocked", see [npgsql/efcore.pg#2194](https://github.com/npgsql/efcore.pg/issues/2194)). That code is the same at the `v10.0.3` and `v11.0.0-rc.3` tags. The scaffolder therefore sees a unique index on `(target_id)` alone, and you get the one-to-one model again. As a bonus, the scaffolded `HasIndex` loses the `INCLUDE`, so a migration generated from that model would recreate the index without it.

## Other options and lookalikes

- **EF Core Power Tools.** The accepted Stack Overflow answer points out that [EF Core Power Tools](https://github.com/ErikEJ/EFCorePowerTools/wiki/Reverse-Engineering) can exclude specific indexes from reverse engineering. That yields a collection, but the scaffolded model then has no `HasIndex` for the partial index, so it will not appear in migrations.
- **Editing generated code by hand.** Changing `WithOne` to `WithMany` in the scaffolded files works until the next `--force` scaffold overwrites it. Patching it in `OnModelCreatingPartial` is awkward too: the generated entity class still declares the reference property, so you end up reconfiguring the relationship around a navigation you do not want.
- **T4 templates.** Customizing `EntityType.t4` or `DbContext.t4` changes how a navigation is printed, not whether the model contains a reference or a collection. The cardinality is decided before templates run, so override the factory instead.
- **A unique index that is not filtered.** If the index has no `WHERE`, the relationship really is one-to-one and the scaffolder is right.

Once the relationship is one-to-many, read the active request with a filtered include, `ctx.Targets.Include(t => t.TargetRequests.Where(r => r.IsActive))`, or with a computed `[NotMapped]` property in a partial class next to the scaffolded entity.

## Related

- [What decides whether EF Core scaffolds a SQL Server `date` as `DateOnly` or `DateTime`](/2026/10/what-decides-whether-ef-core-scaffolds-a-sql-server-date-as-dateonly-or-datetime/) uses the same database-free scaffolding harness.
- [Custom table-name pluralization with IPluralizer](/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/) shows the other common `IDesignTimeServices` override.
- [Fix: Your startup project doesn't reference Microsoft.EntityFrameworkCore.Design](/2026/07/fix-startup-project-doesnt-reference-microsoft-entityframeworkcore-design/) covers where design-time code has to live.
- [What EF Core writes back into an entity after SaveChangesAsync](/2026/11/what-does-ef-core-write-back-into-an-entity-after-savechangesasync/) explains more of the change-tracker behaviour behind the orphan deletes.
- [How to add a unique index on a JSON-mapped property in EF Core 11](/2026/09/how-to-add-a-unique-index-on-a-json-mapped-property-in-ef-core-11/) is another case where an EF index does not enforce what it looks like.

## Sources

- [dotnet/efcore#11298: Scaffold-DbContext generates incorrect nav property on foreign key with filtered unique index](https://github.com/dotnet/efcore/issues/11298)
- [`RelationalScaffoldingModelFactory.cs` at v11.0.0](https://github.com/dotnet/efcore/blob/v11.0.0/src/EFCore.Design/Scaffolding/Internal/RelationalScaffoldingModelFactory.cs)
- [`NpgsqlDatabaseModelFactory.cs` in npgsql/efcore.pg](https://github.com/npgsql/efcore.pg/blob/main/src/EFCore.PG/Scaffolding/Internal/NpgsqlDatabaseModelFactory.cs)
- [Stack Overflow: EF Core scaffold, unique index with WHERE condition produces a 1:1 mapping instead of 1:n](https://stackoverflow.com/questions/79901383)
- [Reverse engineering (scaffolding) in EF Core](https://learn.microsoft.com/en-us/ef/core/managing-schemas/scaffolding/)
- [Design-time services in EF Core](https://learn.microsoft.com/en-us/ef/core/cli/services)
- [Cascade delete and orphan deletion timing](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete)
