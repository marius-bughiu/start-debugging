---
title: "How to keep separate migrations folders for multiple DbContexts in one EF Core project"
description: "Pass --output-dir once per DbContext and EF Core keeps every later migration in that folder and namespace. Why the default layout is lopsided, the CS0111 collision you get from a shared folder, how to move existing migrations, and when to split the history table."
pubDate: 2026-10-26
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "migrations"
  - "dotnet"
---

**Short answer:** create the first migration of each context with its own `--output-dir`, for example `dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog` and the same for `OrdersDbContext` with `Data/Migrations/Orders`. EF Core derives the namespace from that folder (`Shop.Data.Migrations.Catalog`), and every later `migrations add` for the same context goes next to the previous migration and snapshot automatically, so you never have to pass `--output-dir` again. Don't point two contexts at the same folder: identically named migrations become one partial class and the build fails with CS0111. Everything below was run on EF Core 10.0.14 with `dotnet-ef` 10.0.14 on .NET 10 (SDK 10.0.302) against SQLite. I diffed the scaffolding code on the `release/11.0` branch too, and the folder and namespace logic is unchanged in EF Core 11.

## What EF Core does when you don't choose

A lot of people never decide on a layout. They add a second `DbContext` to the project, hit the first error, add `--context`, and move on. It's worth seeing what that produces, because it explains most of the confusing folder structures I see in real repos.

Here is the setup used throughout this post: one console project called `Shop`, two contexts, both pointing at the same SQLite file.

```csharp
// .NET 10, EF Core 10.0.14
// Data/Contexts.cs
using Microsoft.EntityFrameworkCore;

namespace Shop.Data;

public class Product { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Order { public int Id { get; set; } public int ProductId { get; set; } public int Quantity { get; set; } }

public class CatalogDbContext(DbContextOptions<CatalogDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
}

public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

```csharp
// .NET 10, EF Core 10.0.14
// Program.cs
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Shop.Data;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db"));
builder.Services.AddDbContext<OrdersDbContext>(o => o.UseSqlite("Data Source=shop.db"));
using var host = builder.Build();
```

Without `--context`, the tool refuses to guess:

```text
$ dotnet ef migrations add InitialCreate
More than one DbContext was found. Specify which one to use. Use the '-Context' parameter for PowerShell commands and the '--context' parameter for dotnet commands.
```

Add `--context` for each and let EF Core pick the folder:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext
dotnet ef migrations add InitialCreate --context OrdersDbContext
```

The result is lopsided:

```text
Migrations/
  20261026120305_InitialCreate.cs              namespace Shop.Migrations        (Catalog)
  20261026120305_InitialCreate.Designer.cs
  CatalogDbContextModelSnapshot.cs
  OrdersDb/
    20261026120307_InitialCreate.cs            namespace Shop.Migrations.OrdersDb
    20261026120307_InitialCreate.Designer.cs
    OrdersDbContextModelSnapshot.cs
```

The first context to get a migration owns `Migrations/`. The second one gets a subfolder named after the context with the `Context` suffix stripped, so `OrdersDbContext` becomes `OrdersDb`. That is not a bug, it's deliberate code in `MigrationsScaffolder`: when you don't pass an output directory and the default `Migrations` namespace already contains migrations whose `[DbContext]` attribute points at a different context, EF Core switches to `<RootNamespace>.Migrations.<ContextNameWithoutSuffix>`. A context whose name doesn't end in `Context` gets `<Name>Migrations` instead. This logic has been there since EF Core 3.1 and is still there in 11.

It works, but it is order-dependent. Clone the repo fresh, delete the migrations, and run the commands in the other order and the folders swap. And the asymmetry (one context at the root, one nested inside it) makes `Migrations/` look like it belongs to both. Being explicit costs one flag, once.

## The explicit layout with --output-dir

Start clean and give each context its own folder on its first migration:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Data/Migrations/Orders
```

```text
Data/
  Contexts.cs
  Migrations/
    Catalog/
      20261026120357_InitialCreate.cs           namespace Shop.Data.Migrations.Catalog
      20261026120357_InitialCreate.Designer.cs
      CatalogDbContextModelSnapshot.cs
    Orders/
      20261026120359_InitialCreate.cs           namespace Shop.Data.Migrations.Orders
      20261026120359_InitialCreate.Designer.cs
      OrdersDbContextModelSnapshot.cs
```

The `--output-dir` value is relative to the project directory, and EF Core turns the path segments into the sub-namespace, so `Data/Migrations/Catalog` becomes `Shop.Data.Migrations.Catalog` (the root namespace comes from the project's `RootNamespace`). If you want a namespace that doesn't mirror the folder, add `--namespace`:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext \
  --output-dir Data/Migrations/Catalog \
  --namespace Shop.Catalog.Migrations
```

In the Visual Studio Package Manager Console the same options are `-Context`, `-OutputDir` and `-Namespace`:

```powershell
# EF Core 10.0.14 PMC tools
Add-Migration InitialCreate -Context CatalogDbContext -OutputDir Data\Migrations\Catalog
Add-Migration InitialCreate -Context OrdersDbContext -OutputDir Data\Migrations\Orders
```

## You only pass --output-dir once

This is the part most answers on the internet leave out, and it's why people end up with scripts that repeat `--output-dir` forever. After the first migration, the folder sticks. I changed the `Product` entity and added a second migration with no output directory at all:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add AddPrice --context CatalogDbContext
```

```text
Data/Migrations/Catalog/20261026120401_AddPrice.cs
Data/Migrations/Catalog/20261026120401_AddPrice.Designer.cs
```

Two rules in `MigrationsScaffolder` make this work:

1. **Namespace**: when no output directory is given, the new migration reuses the namespace of the context's last migration type, and the snapshot reuses the namespace of the existing snapshot class.
2. **Directory**: `Save` searches the project directory recursively for the previous migration's file (`<PreviousMigrationId>.cs`) and writes the new files into the same folder. The snapshot is found the same way, by its file name `CatalogDbContextModelSnapshot.cs`.

So the source of truth is wherever the files currently live. That has two practical consequences. First, there is no need to put an output directory in a script or in EF Core 11's `.config/dotnet-ef.json` (which has no output-dir key anyway). Second, you can move migrations later and EF Core will follow, which is the next section.

If you pass `--output-dir` explicitly on a later migration, it wins for the migration files, but the snapshot is still written wherever the existing snapshot file is. Pointing a later migration somewhere else therefore splits a context across two folders. Avoid that.

## Don't share one folder between contexts

What if you pass the same `--output-dir` for both contexts? EF Core lets you, with a warning:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Migrations
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Migrations
```

```text
The namespace 'Shop.Migrations' contains migrations for a different DbContext. This can result in conflicting migration names. It's recommend to put migrations for different DbContext classes into different namespaces.
Done. To undo this action, use 'ef migrations remove'
```

The warning is underselling it. Both contexts now have a `partial class InitialCreate` in `Shop.Migrations`. The file names differ because the timestamps differ, but C# merges the partial declarations into one class, and the next build fails:

```text
error CS0111: Type 'InitialCreate' already defines a member called 'Up' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'Down' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'BuildTargetModel' with the same parameter types
error CS0579: Duplicate 'Migration' attribute
```

EF Core's own duplicate-name check (`The name 'InitialCreate' is used by an existing migration.`) only looks at migrations of the same context, so it can't catch this. You'll hit it with any name both teams happen to pick: `InitialCreate`, `AddIndexes`, `Cleanup`. One folder and one namespace per context makes the collision impossible.

## Moving migrations you already have

If your project already has the lopsided default layout, or everything in one folder, you can reorganize without touching the database. EF Core finds migrations by reflection: any type deriving from `Migration` with a `[DbContext(typeof(X))]` attribute and a `[Migration("<id>")]` attribute belongs to context `X`. Folder and namespace are irrelevant at runtime, and the migration ID in the history table doesn't change.

The steps for each context:

1. Move the context's migration files (`<id>_<Name>.cs` and `<id>_<Name>.Designer.cs`) and its `<Context>ModelSnapshot.cs` into the new folder. The plain `.cs` file has no `[DbContext]` attribute, so match on the migration ID rather than grepping for the context name, or you'll leave half of each migration behind.
2. Change the `namespace` line in every moved file, including the snapshot, to the new namespace.
3. Build, then run `dotnet ef migrations list --context <Context>` to confirm the same IDs show up.
4. Add the next migration without `--output-dir` and check it lands in the new folder.

I did exactly this on the broken shared-folder project above: moved the three `OrdersDbContext` files into `Migrations/Orders`, changed `namespace Shop.Migrations` to `namespace Shop.Migrations.Orders`, and the build went green. `migrations list --context OrdersDbContext` still listed `20261026120430_InitialCreate`, and a new `AddPlacedAt` migration landed in `Migrations/Orders` with the `Shop.Migrations.Orders` namespace without any extra flags.

Do the move in one commit, with no other changes, so the diff is pure renames plus one-line namespace edits. Code review is trivial and `git log --follow` keeps working.

## The shared __EFMigrationsHistory table

Folders are a source-code concern. In the database, both contexts write to the same history table by default, because the table name doesn't depend on the context. After applying both:

```bash
# dotnet-ef 10.0.14
dotnet ef database update --context CatalogDbContext
dotnet ef database update --context OrdersDbContext
```

```text
sqlite> select * from __EFMigrationsHistory;
20261026120357_InitialCreate|10.0.14
20261026120401_AddPrice|10.0.14
20261026120359_InitialCreate|10.0.14
```

There is no context column. Each context reads every row and only cares about the IDs that match its own migrations, which is why this works fine most of the time. The ID format is `yyyyMMddHHmmss_Name` at one-second resolution, so two contexts only clash if someone scaffolds the same migration name for both in the same second, which a script that loops over contexts can do.

If you want the history separated, for example because the two contexts map to different schemas or are owned by different teams, configure a per-context table:

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db",
    sql => sql.MigrationsHistoryTable("__CatalogMigrationsHistory")));
```

`MigrationsHistoryTable` also takes a schema on providers that support schemas, such as SQL Server: `sql.MigrationsHistoryTable("__EFMigrationsHistory", "catalog")`.

Here is the trap: doing this on a database that already has migrations applied. The new table is empty, so EF Core thinks nothing has run and replays `InitialCreate`:

```text
$ dotnet ef database update --context CatalogDbContext
SQLite Error 1: 'table "Products" already exists'.
```

Copy the context's rows into the new table before you update. On SQLite:

```sql
-- SQLite, run once per database before deploying the history table change
CREATE TABLE "__CatalogMigrationsHistory" (
    "MigrationId" TEXT NOT NULL CONSTRAINT "PK___CatalogMigrationsHistory" PRIMARY KEY,
    "ProductVersion" TEXT NOT NULL);

INSERT INTO "__CatalogMigrationsHistory"
SELECT "MigrationId", "ProductVersion" FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');

DELETE FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');
```

After that, `database update --context CatalogDbContext` is a no-op and `migrations list` shows both migrations as applied. For a fresh database, nothing special is needed: the generated script starts with `CREATE TABLE IF NOT EXISTS "__CatalogMigrationsHistory"`. If you deploy with an idempotent script or a migration bundle, run the copy before it, in every environment.

## When both contexts map the same table

Separate folders don't stop two contexts from generating DDL for the same table. Suppose `OrdersDbContext` needs read access to products and you add `public DbSet<Product> Products => Set<Product>();` to it. The next migration for `OrdersDbContext` contains a `CreateTable(name: "Products", ...)`, which fails at deploy time because `CatalogDbContext` already created it.

Pick one owner and exclude the table from the other context's migrations:

```csharp
// .NET 10, EF Core 10.0.14
public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Product> Products => Set<Product>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
        => modelBuilder.Entity<Product>()
            .ToTable("Products", t => t.ExcludeFromMigrations());
}
```

With that in place, the same `migrations add` produced an empty `Up` method. The entity is still part of the model, so queries and change tracking work; only migrations ignore the table. Remember that a schema change to `Product` now has to be migrated through `CatalogDbContext`, and `OrdersDbContext` picks it up through the shared entity class.

## Other commands need --context too

Every migrations command operates on one context, so once there are two, `--context` is required on all of them, not only `add`:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations list   --context OrdersDbContext
dotnet ef migrations remove --context OrdersDbContext
dotnet ef migrations script --context OrdersDbContext --idempotent -o orders.sql
dotnet ef migrations bundle --context OrdersDbContext -o efbundle-orders
dotnet ef database update   --context OrdersDbContext
```

`migrations remove` deletes the last migration's files from wherever they are (it searches the project by file name) and rewrites the snapshot in its existing folder, so it respects your layout too. At runtime, call `Database.MigrateAsync()` once per context, in the order your schema needs (owner of shared tables first).

If typing `--context` gets old, EF Core 11 can read a default `context` from `.config/dotnet-ef.json`. Flags still override it, so you'd set the context you migrate most often and pass `--context` for the other one.

## A separate migrations project per context

Folders inside one project are enough for most apps. When the contexts are deployed separately, or one team must not be able to touch the other's migrations, move each context's migrations into its own class library and tell EF Core where to find them:

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlServer(catalogConnection,
    sql => sql.MigrationsAssembly("Shop.Migrations.Catalog")));
```

Then run `dotnet ef migrations add` with `--project Shop.Migrations.Catalog --startup-project Shop --context CatalogDbContext`. The trade-off is one more project per context and a reference from the startup project to each migrations project, so they get loaded at runtime. The [official guide to a separate migrations project](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects) covers the wiring.

## Related

- [Fix: The model for context has pending changes in EF Core 11](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), which also bites when you add a migration for the wrong context.
- [Stop retyping --project and --startup-project with .config/dotnet-ef.json](/2026/06/efcore-11-dotnet-ef-json-config-file/) in EF Core 11.
- [How to apply EF Core 11 migrations in production with migration bundles](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), one bundle per context.
- [Fix: There is already an object named 'X' in the database after resetting migrations](/2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations/), the same history-table mechanics from another angle.
- [Fix: dotnet ef migrations add "Unable to create an object of type DbContext"](/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) for when the design-time tools can't build either context.

## Sources

- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), Microsoft Learn: `--context`, `--output-dir`, `--namespace`.
- [Using a Separate Migrations Project](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects), Microsoft Learn.
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn.
- [Entity types: excluding from migrations](https://learn.microsoft.com/en-us/ef/core/modeling/entity-types#excluding-from-migrations), Microsoft Learn.
- [`MigrationsScaffolder.cs` on release/10.0](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Migrations/Design/MigrationsScaffolder.cs), the namespace defaulting, foreign-migrations check and directory reuse described above.
