---
title: "TPH vs TPT vs TPC inheritance mapping in EF Core 11: which should you pick?"
description: "On EF Core 11, default to TPH for almost every hierarchy, reach for TPC only when you mostly query one leaf type and a benchmark proves it wins, and use TPT only when an external constraint forces you to."
pubDate: 2026-07-22
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
---

On EF Core 11 (with .NET 11 and C# 14), map a class hierarchy with **table-per-hierarchy (TPH)** unless you have a measured reason not to. TPH puts the whole hierarchy in one table with a discriminator column, so reads are single-table scans with no joins. Reach for **table-per-concrete-type (TPC)** only when your code overwhelmingly queries a single leaf type and a benchmark on your data shows it beating TPH. Use **table-per-type (TPT)** only when an external constraint forces it, because Microsoft's own benchmark puts TPT at roughly twice the time and nearly double the allocations of TPH for a base-type query. The one-line rule: TPH by default, TPC for leaf-heavy workloads that measure faster, TPT never by choice.

This post is the decision, not the full configuration walkthrough. If you want the discriminator API, shared columns, and the nullable-column mechanics in depth, read [how to configure table-per-hierarchy (TPH) inheritance mapping in EF Core 11](/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/). Here we put the three strategies side by side, show the schema each one generates, and name the constraints that make the choice for you.

## The one-screen feature matrix

Take a two-level hierarchy: a base `Blog` and a derived `RssBlog` that adds an `RssUrl`. The three strategies map it to three completely different schemas, and every tradeoff below flows from that shape.

| Dimension                              | TPH                          | TPT                                | TPC                                   |
| -------------------------------------- | ---------------------------- | ---------------------------------- | ------------------------------------- |
| Tables generated                       | one, whole hierarchy         | one per type (abstract included)   | one per concrete type only            |
| Discriminator column                   | yes                          | no                                 | no                                    |
| Derived-type columns                   | nullable, shared table       | own table, can be `NOT NULL`       | own table, can be `NOT NULL`          |
| Base-type query (`context.Blogs`)      | single `SELECT`, no join     | `LEFT JOIN` across all tables      | `UNION ALL` across concrete tables    |
| Single-leaf query (`OfType<RssBlog>`)  | discriminator predicate      | join base + leaf table             | single table, no filter               |
| Storage shape                          | wide, sparse, many nulls     | normalized, no nulls               | denormalized, columns repeated        |
| Key generation                         | any (Identity fine)          | any (Identity on base)             | shared sequence, no plain Identity    |
| FK constraint to the base type         | yes                          | yes                                | no (key lives in leaf table)          |
| Complex types / JSON columns           | yes                          | yes (new in EF Core 11)            | yes (new in EF Core 11)               |
| Base-type read: relative speed         | fastest (baseline)           | ~2x slower                         | ~same as TPH                          |
| Microsoft's stance                     | recommended default          | "only if constrained to"           | good for single-leaf queries          |

The pattern is not subtle. TPH wins or ties on almost every row that matters, TPC matches it except when you query across types, and TPT trades a cleaner-looking schema for joins that cost you at query time. Three of those cells changed in EF Core 11: complex types and JSON columns now work on TPT and TPC hierarchies, which was previously unsupported and pushed people back to owned entities for any inherited value object. That closes one of the last non-performance reasons to avoid TPT and TPC, but it does not change the performance verdict.

## What each strategy actually writes to the database

The schemas make the abstract tradeoffs concrete. TPH is one table with a discriminator and nullable derived columns:

```sql
-- TPH: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL IDENTITY,
    [Url] nvarchar(max) NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [RssUrl] nvarchar(max) NULL,          -- nullable: base Blogs have no RssUrl
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);
```

TPT splits every type into its own table, linked by a foreign key on the shared primary key:

```sql
-- TPT: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL IDENTITY,
    [Url] nvarchar(max) NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);

CREATE TABLE [RssBlogs] (
    [BlogId] int NOT NULL,
    [RssUrl] nvarchar(max) NULL,
    CONSTRAINT [PK_RssBlogs] PRIMARY KEY ([BlogId]),
    CONSTRAINT [FK_RssBlogs_Blogs_BlogId] FOREIGN KEY ([BlogId])
        REFERENCES [Blogs] ([BlogId]) ON DELETE NO ACTION
);
```

TPC gives every concrete type a self-contained table with every inherited column repeated, keyed off a shared sequence:

```sql
-- TPC: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL DEFAULT (NEXT VALUE FOR [BlogSequence]),
    [Url] nvarchar(max) NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);

CREATE TABLE [RssBlogs] (
    [BlogId] int NOT NULL DEFAULT (NEXT VALUE FOR [BlogSequence]),
    [Url] nvarchar(max) NULL,             -- inherited column, repeated here
    [RssUrl] nvarchar(max) NULL,
    CONSTRAINT [PK_RssBlogs] PRIMARY KEY ([BlogId])
);
```

Configuring each one is a single line on the root entity. TPH is the default and needs nothing; TPT and TPC opt in with a mapping strategy call:

```csharp
// EF Core 11: choosing a strategy on the root entity type
modelBuilder.Entity<Blog>().UseTphMappingStrategy(); // default, can be omitted
modelBuilder.Entity<Blog>().UseTptMappingStrategy(); // one table per type
modelBuilder.Entity<Blog>().UseTpcMappingStrategy(); // one table per concrete type
```

## When to pick TPH

TPH is the right answer for the large majority of hierarchies. Choose it when:

- **You query across the hierarchy.** Any code that reads the base type (a list of all `Payment` rows, a dashboard that mixes `CardPayment` and `BankTransferPayment`) is one indexed table scan under TPH. There is no join and no `UNION`. This is the single most common access pattern, and it is exactly where TPT falls down.
- **The hierarchy is shallow or the derived types add few columns.** Two or three subtypes each adding a handful of properties produce a table that is only mildly sparse. Databases handle empty columns well, and on SQL Server you can mark rarely-populated TPH columns as [sparse columns](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns) to reclaim the space.
- **You want the simplest writes.** A TPH insert is one row in one table. `ExecuteUpdate` and `ExecuteDelete` against a derived type apply the discriminator predicate for you and touch a single table, which is the clean bulk-write path described in [how to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/).
- **You need a foreign key to the base type.** Because every row lives in one table, a relationship that points at the base type gets a real FK constraint. TPC cannot enforce that constraint, as covered below.

The one cost you accept is that a property required on a derived type still maps to a nullable column, because sibling rows leave it empty. If database-enforced non-null on derived properties is a hard requirement, that is the classic reason to leave TPH, and it points at TPT.

## When to pick TPC

TPC is the specialist. It matches TPH on cross-type queries closely and pulls ahead in one specific shape:

- **You almost always query a single leaf type.** If your hot path is `context.RssBlogs.Where(...)` and rarely `context.Blogs`, TPC reads one self-contained table with no discriminator filter and no join. Microsoft's guidance is explicit: TPC excels "when querying for entities of a single leaf type." Measure it against TPH on your data before you commit, because the win is workload-dependent.
- **You want non-null derived columns without TPT's joins.** Each TPC table holds all of a concrete type's columns inline, so a required derived property can be `NOT NULL` in its own table, and reading that type is still single-table. That is the property TPT buys with a join and TPC buys without one.

The price is a denormalized schema and awkward keys. TPC cannot use a plain `Identity` column, because there is no single table to own the sequence; EF Core 11 defaults to a shared database sequence (`NEXT VALUE FOR [BlogSequence]`) so keys stay unique across sibling tables. On SQLite, which has no sequences, integer key generation is unavailable for TPC and you fall back to client-side GUIDs. And because a base-type primary key can live in any concrete table, a foreign key that references the base type cannot be enforced by a database constraint at all. If all your writes go through EF Core with navigations, that is usually fine, but it is a real loss of database-level integrity.

## When to pick TPT (and why the answer is usually "don't")

TPT produces the schema that looks most like your class diagram: one table per type, joined on the key. That aesthetic is the trap. Reach for TPT only when:

- **An external constraint dictates the schema.** A DBA mandates a normalized table per type, a legacy schema you cannot change already looks this way, or another system reads the per-type tables directly. These are the "constrained to do so by external factors" cases Microsoft names.
- **You genuinely need per-type tables with FK constraints and non-null derived columns and cross-type queries are rare.** This is a narrow intersection, and even then you should benchmark against TPC first.

Do not pick TPT because it feels cleaner. Every base-type query joins across the whole set of tables, and joins are one of the primary sources of relational performance problems. The numbers back this up, which is the next section.

## The benchmark: TPT costs roughly 2x

This is not hand-waving. Microsoft's own inheritance benchmark sets up a 7-type hierarchy, seeds 5000 rows per type (35000 rows total), and loads every row from the database. The results:

| Method | Mean      | Allocated |
| ------ | --------- | --------- |
| TPH    | 149.0 ms  | 40 MB     |
| TPT    | 312.9 ms  | 75 MB     |
| TPC    | 158.2 ms  | 46 MB     |

TPT is roughly 2.1x slower than TPH and allocates nearly double the memory, because loading the hierarchy joins seven tables together. TPC lands within about 6 percent of TPH on this all-types query, and it would pull ahead of TPH on a single-leaf query where it reads one table and TPH still scans the shared table with a discriminator filter. The methodology matters: this is a base-type query that touches every table, which is TPC's weakest case and TPT's, so the gap you see on your workload depends on how often you query across types versus one leaf. The takeaway is stable across runs though: TPT pays a join tax that TPH and TPC do not, and no schema-aesthetics argument buys that back.

Run the benchmark against your own model before you make an irreversible call. Changing an inheritance strategy after you have production data means a schema migration that moves rows between tables, so this is a decision worth measuring once, early.

## The gotchas that pick for you

Three constraints can decide the strategy regardless of preference.

The first is **database-enforced non-null on a derived property**. TPH cannot do it, because the shared column has to be nullable for sibling rows. If you need the database (not just your application) to guarantee that every `CardPayment` has a `Last4`, you need that column in its own table, which means TPT or TPC.

The second is **key generation on your database**. TPC needs sequences for integer keys. On SQL Server that is automatic, but on SQLite you cannot use integer identity keys with TPC at all and must switch to GUIDs. If you are on SQLite and want integer keys, TPC is off the table.

The third is **foreign-key integrity to the base type**. If other tables reference your base type and you want the database to enforce those references, TPC cannot give you the constraint. TPH and TPT can. This alone rules out TPC for many normalized schemas.

One thing that is the same across all three: you cannot change an entity's type at runtime. Turning a `CardPayment` into a `BankTransferPayment` is a delete plus insert in every strategy, because the discriminator (or the table itself) encodes the type. That is a modeling reality, not a differentiator.

## The recommendation, stated plainly

Default to TPH. It is the fastest for the common cross-type query, the simplest to write against, the only strategy with zero key-generation friction, and Microsoft's recommended default for a wide range of scenarios. Reach for TPC only when your workload is dominated by single-leaf-type queries and a benchmark on your data shows it beating TPH, and accept the denormalized schema, shared-sequence keys, and missing base-type FK constraint that come with it. Use TPT only when an external factor leaves you no choice, and go in knowing you are paying a roughly 2x query tax for a schema that looks tidier.

The mental model is the same one the numbers enforce: one table is fast, many tables joined are slow, and many tables not joined are fast but denormalized. If this decision is part of a broader version bump, the inheritance and mapping changes tend to surface alongside the ones in the [EF Core 6 to EF Core 11 migration guide](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Related reading

- [How to configure table-per-hierarchy (TPH) inheritance mapping in EF Core 11](/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) is the full TPH walkthrough: discriminator API, shared columns, and the nullable-column rule.
- [Complex types vs owned entities in EF Core 11](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) covers value-object mapping, which now works inside TPT and TPC hierarchies.
- [How to map and query JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) explains the JSON storage that inheritance hierarchies gained in EF Core 11.
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) shows the single-table bulk-write path TPH makes clean.
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11) helps catch the join-heavy query patterns TPT can encourage.

## Sources

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Modeling for performance: inheritance mapping (with the TPH/TPT/TPC benchmark)](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core inheritance benchmark source](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Benchmarks/Inheritance.cs)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [SQL Server sparse columns](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns)
