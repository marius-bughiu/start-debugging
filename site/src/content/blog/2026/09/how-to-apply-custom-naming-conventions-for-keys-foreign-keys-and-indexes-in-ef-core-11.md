---
title: "How to apply custom naming conventions for primary keys, foreign keys, and indexes in EF Core 11 migrations"
description: "Rename every PK_, FK_, AK_ and IX_ that EF Core 11 generates with one IModelFinalizingConvention, keep explicit names winning, stay under the identifier length limit, and avoid the clustered-index rebuild the next migration scaffolds on an existing database."
pubDate: 2026-09-19
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
---

Short answer: write one class that implements `IModelFinalizingConvention`, loop over every entity type's declared keys, foreign keys and indexes, and set the names through the convention builders (`key.Builder.HasName(...)`, `fk.Builder.HasConstraintName(...)`, `index.Builder.HasDatabaseName(...)`). Register it in `ConfigureConventions` with `configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention())`. Because the builders record the name as `Convention`-sourced, any name you set explicitly with the Fluent API or `[Index(Name = ...)]` still wins. On a new database that is the whole job. On an existing one, the next migration drops and re-adds every primary key and foreign key just to rename it, so hand-edit that migration into renames.

Everything in this post was run on the .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`) with `Microsoft.EntityFrameworkCore.SqlServer` `11.0.0-rc.1.26425.128`. The DDL and migration SQL shown are the real output of `Database.GenerateCreateScript()` and `IMigrationsSqlGenerator` against a SQL Server model. No database server was involved, so there are no timings here, only the SQL EF Core would send.

## The names EF Core 11 picks by default

Start with a small model: a `Blog` with a unique `Slug` alternate key, `Post` pointing at `Blog` and optionally at `Author`, a unique index on `Author.Email`, a composite index on `Post`, and a skip-navigation many-to-many between `Post` and `Tag`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public string Slug { get; set; } = "";
    public List<Post> Posts { get; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
    public int? AuthorId { get; set; }
    public Author? Author { get; set; }
    public List<Tag> Tags { get; } = [];
}

public class Author { public int Id { get; set; } public string Email { get; set; } = ""; }
public class Tag { public int Id { get; set; } public string Name { get; set; } = ""; public List<Post> Posts { get; } = []; }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    public DbSet<Author> Authors => Set<Author>();
    public DbSet<Tag> Tags => Set<Tag>();

    protected override void OnModelCreating(ModelBuilder mb)
    {
        mb.Entity<Blog>().HasAlternateKey(b => b.Slug);
        mb.Entity<Author>().HasIndex(a => a.Email).IsUnique();
        mb.Entity<Post>().HasIndex(p => new { p.BlogId, p.Title });
    }
}
```

The generated SQL Server DDL uses four patterns:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, default names
CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [AK_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [FK_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [FK_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE UNIQUE INDEX [IX_Authors_Email] ON [Authors] ([Email]);
CREATE INDEX [IX_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
```

So the defaults are `PK_{table}`, `AK_{table}_{columns}`, `FK_{dependent table}_{principal table}_{columns}` and `IX_{table}_{columns}`, with a unique index getting the same `IX_` prefix as a non-unique one. Note that the pattern uses the *table* name (`Blogs`, from the `DbSet`), not the CLR type name. Parts of the Microsoft Learn docs describe the primary key default as `PK_<type name>`, which is only true when the two happen to match.

Teams usually want to change this for one of three reasons: a DBA standard (`pk_`, `fk_`, `ux_` for unique indexes), a PostgreSQL database where everything else is lower case, or an existing schema created by another tool whose names EF Core should adopt instead of fight.

## One-off names: HasName, HasConstraintName, HasDatabaseName

If only a handful of objects need a specific name, the Fluent API has a method per object type:

```csharp
// .NET 11, EF Core 11 - per-object names
mb.Entity<Blog>().HasKey(b => b.Id).HasName("pk_blog");
mb.Entity<Blog>().HasAlternateKey(b => b.Slug).HasName("ak_blog_slug");

mb.Entity<Post>()
    .HasOne(p => p.Blog).WithMany(b => b.Posts)
    .HasForeignKey(p => p.BlogId)
    .HasConstraintName("fk_post_blog");

mb.Entity<Author>().HasIndex(a => a.Email).IsUnique().HasDatabaseName("ux_author_email");
```

For indexes there is also the attribute form, `[Index(nameof(Email), IsUnique = true, Name = "ux_author_email")]`. The attribute's `Name` becomes the database name.

This does not scale. Every new entity needs the same three calls, the join table of a skip navigation is easy to forget, and the day somebody adds an index without the call you are back to `IX_`. That is what a convention is for.

## A model finalizing convention that names everything

The EF Core docs on [model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) describe two kinds of custom conventions. Interactive ones react to each model change as it happens. *Model finalizing* ones run once, after `OnModelCreating` and all the built-in conventions have finished, and see the near-final model. Constraint names depend on table names and column names, which can change right up to the end of model building, so a finalizing convention is the right hook. Running earlier means naming an index after a column that a later `HasColumnName` renames.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using Microsoft.EntityFrameworkCore.Metadata.Conventions;

public sealed class ConstraintNamingConvention : IModelFinalizingConvention
{
    public void ProcessModelFinalizing(
        IConventionModelBuilder modelBuilder,
        IConventionContext<IConventionModelBuilder> context)
    {
        var maxLength = modelBuilder.Metadata.GetMaxIdentifierLength();

        foreach (var entityType in modelBuilder.Metadata.GetEntityTypes())
        {
            var table = entityType.GetTableName();
            if (table is null) continue; // views, keyless query types, TPC abstract roots
            var store = StoreObjectIdentifier.Table(table, entityType.GetSchema());

            foreach (var key in entityType.GetDeclaredKeys())
            {
                var name = key.IsPrimaryKey()
                    ? $"pk_{table}"
                    : $"ak_{table}_{Columns(key.Properties, store)}";
                key.Builder.HasName(Truncate(name, maxLength));
            }

            foreach (var fk in entityType.GetDeclaredForeignKeys())
            {
                var principalTable = fk.PrincipalEntityType.GetTableName();
                if (principalTable is null) continue;
                var name = $"fk_{table}_{principalTable}_{Columns(fk.Properties, store)}";
                fk.Builder.HasConstraintName(Truncate(name, maxLength));
            }

            foreach (var index in entityType.GetDeclaredIndexes())
            {
                var prefix = index.IsUnique ? "ux" : "ix";
                var name = $"{prefix}_{table}_{Columns(index.Properties, store)}";
                index.Builder.HasDatabaseName(Truncate(name, maxLength));
            }
        }
    }

    static string Columns(IEnumerable<IConventionPropertyBase> props, StoreObjectIdentifier store)
        => string.Join("_", props.Select(p =>
            (p as IConventionProperty)?.GetColumnName(store) ?? p.Name));

    static string Truncate(string name, int maxLength)
    {
        if (name.Length <= maxLength) return name;
        // keep names unique after truncation: prefix + 8 hex chars of a stable hash
        var hash = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(
                System.Text.Encoding.UTF8.GetBytes(name)))[..8].ToLowerInvariant();
        return $"{name[..(maxLength - 9)]}_{hash}";
    }
}
```

Register it on the context:

```csharp
// .NET 11, EF Core 11
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
    => configurationBuilder.Conventions.Add(_ => new ConstraintNamingConvention());
```

`Conventions.Add` takes a factory rather than an instance so a convention can pull services from EF Core's internal service provider. This one has no dependencies, hence the discarded `_` parameter.

The same model now produces:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, with ConstraintNamingConvention
CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]),
CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug])
CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE
CONSTRAINT [pk_PostTag] PRIMARY KEY ([PostsId], [TagsId]),
CONSTRAINT [fk_PostTag_Tags_TagsId] FOREIGN KEY ([TagsId]) REFERENCES [Tags] ([Id]) ON DELETE CASCADE
CREATE INDEX [ix_Posts_BlogId_Title] ON [Posts] ([BlogId], [Title]);
CREATE INDEX [ix_PostTag_TagsId] ON [PostTag] ([TagsId]);
```

The implicit `PostTag` join table is covered without any extra code because it is a real (shared-type) entity type in the model, and `GetEntityTypes()` returns it.

A few details in that code are deliberate.

**Use the convention builders, not the setters.** `key.Builder.HasName(...)` sets the name with `ConfigurationSource.Convention`. EF Core tracks where every piece of configuration came from, and a convention-sourced value never overrides a `DataAnnotation` or `Explicit` one. In the repro I kept the unique index explicitly named `.HasDatabaseName("UX_Authors_Email_Legacy")` in `OnModelCreating`, and the output still contains `CREATE UNIQUE INDEX [UX_Authors_Email_Legacy]` while every other index got the `ix_`/`ux_` treatment. If you call the mutable setters instead (`IMutableKey.SetName`) in a loop at the end of `OnModelCreating`, you lose that precedence and silently overwrite names a colleague set on purpose.

**Use the column name for the store object, not the property name.** `GetColumnName(StoreObjectIdentifier)` returns what is actually in the table, including `HasColumnName` overrides and owned-type prefixes like `Where_City`. Naming an index after the CLR property produces names that do not match the columns they cover.

**`Properties` is `IConventionPropertyBase` on EF Core 11.** On EF Core 11 RC 1, `IConventionKey.Properties` is typed as `IReadOnlyList<IConventionPropertyBase>`, so a helper declared as `IEnumerable<IConventionProperty>` fails to compile with CS1503. The cast in `Columns` handles that and falls back to the member name for anything that is not a plain scalar property.

## Rolling it out: new database vs existing database

The naming convention changes the model, so `dotnet ef migrations add` sees a diff. What that diff contains is the part that bites.

1. **New project or no deployed database yet.** Add the convention before the first migration. `InitialCreate` contains the new names and nothing else needs to happen.
2. **Existing database, small tables.** Scaffold the migration, read it, and apply it. EF Core rebuilds the keys, which is fine when the tables are small.
3. **Existing database, large tables.** Scaffold the migration, then replace the drop/add pairs with renames before anyone applies it.

To see exactly what step 3 is about, I diffed the default-named model against the convention-named model with `IMigrationsModelDiffer`, the same component `migrations add` uses. Indexes come out as cheap renames:

```sql
-- EF Core 11.0.0-rc.1: RenameIndexOperation on SQL Server
EXEC sp_rename N'[Posts].[IX_Posts_BlogId_Title]', N'ix_Posts_BlogId_Title', 'INDEX';
EXEC sp_rename N'[PostTag].[IX_PostTag_TagsId]', N'ix_PostTag_TagsId', 'INDEX';
```

Primary keys, alternate keys and foreign keys do not. There is no `RenamePrimaryKey` or `RenameForeignKey` migration operation, so the differ emits a drop and an add for each one, 24 operations for this five-table model:

```sql
-- EF Core 11.0.0-rc.1: what the scaffolded migration does to keys
ALTER TABLE [Posts] DROP CONSTRAINT [FK_Posts_Blogs_BlogId];
ALTER TABLE [Posts] DROP CONSTRAINT [PK_Posts];
ALTER TABLE [Blogs] DROP CONSTRAINT [AK_Blogs_Slug];
ALTER TABLE [Blogs] DROP CONSTRAINT [PK_Blogs];
-- ...
ALTER TABLE [Posts] ADD CONSTRAINT [pk_Posts] PRIMARY KEY ([Id]);
ALTER TABLE [Blogs] ADD CONSTRAINT [ak_Blogs_Slug] UNIQUE ([Slug]);
ALTER TABLE [Blogs] ADD CONSTRAINT [pk_Blogs] PRIMARY KEY ([Id]);
ALTER TABLE [Posts] ADD CONSTRAINT [fk_Posts_Blogs_BlogId] FOREIGN KEY ([BlogId]) REFERENCES [Blogs] ([Id]) ON DELETE CASCADE;
```

On SQL Server the primary key is the clustered index by default. Dropping it converts the table to a heap and rewrites every nonclustered index; adding it back sorts and rewrites the table again, then rewrites the nonclustered indexes a second time. Re-adding each foreign key validates every existing row. On a table with tens of millions of rows this is a long, log-heavy operation, inside the migration transaction, to change the case of a prefix. The same drop-and-add pattern shows up when you [rename a table in an EF Core 11 migration](/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/), and the fix is the same: rename the constraints in place.

On SQL Server, replace the scaffolded `DropForeignKey`/`DropPrimaryKey`/`DropUniqueConstraint` and matching `Add*` calls in `Up` with `sp_rename`, which renames a constraint as a metadata change. Renaming a primary key or unique constraint with `sp_rename` also renames its backing index.

```csharp
// .NET 11, EF Core 11 - hand-edited Up() for SQL Server
protected override void Up(MigrationBuilder migrationBuilder)
{
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Blogs]', N'pk_Blogs', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[AK_Blogs_Slug]', N'ak_Blogs_Slug', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[PK_Posts]', N'pk_Posts', 'OBJECT';");
    migrationBuilder.Sql("EXEC sp_rename N'[dbo].[FK_Posts_Blogs_BlogId]', N'fk_Posts_Blogs_BlogId', 'OBJECT';");
    // ...one line per key and foreign key

    // the scaffolded index renames are already fine, keep them
    migrationBuilder.RenameIndex(
        name: "IX_Posts_BlogId_Title", table: "Posts", newName: "ix_Posts_BlogId_Title");
}
```

On PostgreSQL the equivalent is `ALTER TABLE "Posts" RENAME CONSTRAINT "PK_Posts" TO "pk_Posts";`, which also renames the index behind a primary key or unique constraint. Npgsql already scaffolds `ALTER INDEX ... RENAME TO` for the plain indexes.

Write the inverse `sp_rename` calls into `Down` too. The scaffolded `Down` still contains drop/add pairs, and leaving it that way means a rollback performs the rebuild you just avoided. The model snapshot is unaffected by this hand edit: it records the new names either way, so the next `migrations add` produces an empty diff. If it does not, you missed a constraint, and the startup check will tell you with [the pending model changes exception](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/). Apply the edited migration through a reviewed script or a [migrations bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), not from `Database.Migrate()` at app startup.

## Gotchas: shared tables, length limits, and the snake_case package

**Name from the table, never from the entity type.** An owned type stored in its owner's table, table splitting, and TPH all put several entity types in one table, and each of them has its own primary key metadata. They must agree on the constraint name. In the repro I switched the primary key pattern to `pk_{entityType.ClrType.Name}` on a model with an owned `Address` inside `Media`, and model validation failed immediately:

```text
InvalidOperationException: The table 'Media' cannot be used for entity type 'Media' since it is being used
for entity type 'Address' and the name 'pk_Media' of the primary key {'Id'} does not match the name
'pk_Address' of the primary key {'MediaId'}.
```

Deriving the name from `GetTableName()` sidesteps this, because every entity type in the shared table resolves to the same table. The same repro with `pk_{table}` produced one `pk_Media` constraint, and the TPH foreign keys declared on the derived `Photo` and `Clip` types came out as `fk_Media_Author_PhotographerId` and `fk_Media_Author_EditorId` on the shared table. The [TPH mapping guide](/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) covers why derived-type columns end up nullable there.

**Respect the identifier length limit, and keep truncated names unique.** `IConventionModel.GetMaxIdentifierLength()` returns the provider's limit: 128 on SQL Server and 32767 on SQLite in my repro. PostgreSQL truncates identifiers at 63 bytes. A composite index on long column names blows past 63 easily, and if you just chop the string, two indexes that differ only at the end collapse to the same name. EF Core then fails validation because two indexes on one table map to the same name with different columns. The `Truncate` helper keeps a prefix and appends eight hex characters of a SHA-256 of the full name. With a 40-character limit, `ix_customer_order_line_items_warehouse_location_id_created_at` and `..._updated_at` became `ix_customer_order_line_items_wa_0e2c7d55` and `ix_customer_order_line_items_wa_a5c1910c`. Use a stable hash, never `string.GetHashCode()`, which is randomized per process in .NET and would produce a different name, and a new migration, on every build.

**Finalizing conventions run in the order you add them.** If you also have a convention that renames tables or columns (for example to snake_case), add it *before* the constraint naming convention in `ConfigureConventions`. Otherwise the constraint names are computed from the old table names.

**`EFCore.NamingConventions` is not an EF Core 11 package yet.** The popular community package that turns everything into snake_case, including key and index names, is at 10.0.1 as of today, and its nuspec pins `Microsoft.EntityFrameworkCore.Relational` to `[10.0.1, 11.0.0)`. Referencing it next to EF Core 11 gives you NuGet's NU1608 "outside of dependency constraint" warning and a package that was never tested against the 11.0 metadata API, which, as the `IConventionPropertyBase` change shows, did move. A 60-line convention that you own has no such problem.

**Scaffolded (database-first) models ignore all of this.** `dotnet ef dbcontext scaffold` reads real names from the database and writes explicit `HasName`/`HasDatabaseName` calls, and explicit beats convention. That is the correct behaviour, but do not expect the convention to "fix" a reverse-engineered model.

**Check the result, not the code.** `Database.GenerateCreateScript()` on a context with a dummy connection string prints the full DDL without touching a server, and `dotnet ef migrations script` shows what a pending migration will run. Both are faster than reading the model snapshot. For the runtime side, [logging the SQL EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) shows constraint names in any `DbUpdateException` that references them.

## Related

- [How to rename a table in an EF Core 11 migration without losing data](/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)
- [Fix: the model for context 'X' has pending changes in EF Core 11](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [How to apply EF Core 11 migrations in production with migrations bundles](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [How to configure table-per-hierarchy (TPH) inheritance mapping in EF Core 11](/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/)
- [Complex types vs owned entities in EF Core 11](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)

## Sources

- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) on Microsoft Learn: `ConfigureConventions`, `IModelFinalizingConvention`, configuration sources and convention builders
- [Keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys) and [Indexes and constraints](https://learn.microsoft.com/en-us/ef/core/modeling/indexes) on Microsoft Learn for `HasName` and `HasDatabaseName`
- [sys.sp_rename](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-rename-transact-sql) for renaming constraints in place on SQL Server
- [ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html) (`RENAME CONSTRAINT`) and [identifier length](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-IDENTIFIERS) in the PostgreSQL docs
- [EFCore.NamingConventions on NuGet](https://www.nuget.org/packages/EFCore.NamingConventions), version 10.0.1 dependency ranges
