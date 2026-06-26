---
title: "Fix: FOREIGN KEY constraint failed when deleting an entity in EF Core 11"
description: "EF Core throws FOREIGN KEY constraint failed because the parent still has dependents the database refuses to orphan. Load the children, make the relationship optional, or configure OnDelete."
pubDate: 2026-06-26
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
---

The fix: you are deleting a principal (parent) row that still has dependent (child) rows pointing at it, and the database will not orphan them. You have three real options, in order: load the dependents into the context before `SaveChanges` so EF Core can cascade the delete itself; make the relationship optional (nullable foreign key) so the children's FK can be set to null; or configure `OnDelete(DeleteBehavior.Cascade)` and recreate the schema so the database deletes the children for you. Pick the one that matches what should happen to the children.

```text
Microsoft.EntityFrameworkCore.DbUpdateException: An error occurred while saving the entity changes. See the inner exception for details.
 ---> Microsoft.Data.Sqlite.SqliteException (0x80004005): SQLite Error 19: 'FOREIGN KEY constraint failed'.
   at Microsoft.Data.Sqlite.SqliteException.ThrowExceptionForRC(int rc, sqlite3 db)
   at Microsoft.EntityFrameworkCore.Update.ReaderModificationCommandBatch.ExecuteAsync(...)
```

This is a runtime database error, raised by `SaveChanges`/`SaveChangesAsync` and wrapped in a `DbUpdateException`. The exact wording is the SQLite provider's. On SQL Server the same situation produces `The DELETE statement conflicted with the REFERENCE constraint "FK_..."`, on PostgreSQL it is `23503: update or delete on table "..." violates foreign key constraint`, and on MySQL it is `Cannot delete or update a parent row: a foreign key constraint fails`. Different text, identical cause. This guide is written against .NET 11, C# 14, `Microsoft.EntityFrameworkCore` 11.0.0, and `Microsoft.Data.Sqlite` 11.0.0. The behaviour is unchanged from EF Core 7, so it applies back to that release.

## Why the database refuses the delete

EF Core models a relationship with a foreign key: the dependent row stores the primary key of its principal. When you delete the principal, every dependent FK that pointed at it now references a row that no longer exists. That is a referential integrity violation, and a relational database stops it at the constraint.

There are only two legal ways out, and the database can only pick one if you tell it which:

1. Delete the dependents too (cascade delete).
2. Set the dependents' foreign key to null (only possible if the column is nullable).

If you delete the principal without arranging either of those, the database throws. The reason this surfaces so often is that EF Core's *default* configuration depends on whether the relationship is required or optional, and on whether the dependents are loaded into the context at the time you call `SaveChanges`. Those two switches decide whether EF Core fixes things up in memory before sending SQL, or hands the problem straight to the database, which then refuses it.

A subtle aggravating factor: SQLite does not enforce foreign keys at all unless `PRAGMA foreign_keys = ON`, which `Microsoft.Data.Sqlite` sets by default. Developers who tested on an older setup, or on the EF Core in-memory provider (which does not enforce constraints), are often surprised the first time a real SQLite or SQL Server database rejects the delete.

## The smallest repro

A required one-to-many: `Blog` has many `Post`, and `Post.BlogId` is non-nullable, so the relationship is required.

```csharp
// .NET 11, C# 14, EF Core 11.0.0, Microsoft.Data.Sqlite 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = new();
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }            // non-nullable => required relationship
    public Blog Blog { get; set; } = null!;
}

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();

    public AppDb(DbContextOptions<AppDb> options) : base(options) { }
}
```

Now delete a blog that has posts, without loading those posts:

```csharp
// .NET 11, EF Core 11.0.0 -- throws DbUpdateException -> "FOREIGN KEY constraint failed"
var blog = await db.Blogs.SingleAsync(b => b.Id == 1);   // no Include(b => b.Posts)
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

EF Core only knows about the blog. It emits a single `DELETE FROM Blogs WHERE Id = 1`. The posts still reference blog 1, and the database aborts the statement. The error is correct: you asked to delete a row that other rows depend on, and you did not say what to do with them.

Note the contrast. With a required relationship the default delete behavior is `Cascade`, but "cascade" can be applied two ways: by EF Core (in memory, requires the children to be loaded) or by the database (requires `ON DELETE CASCADE` on the constraint). If the schema was created without `ON DELETE CASCADE` and the children are not loaded, neither mechanism fires, and you land on this error.

## Fix 1: load the dependents so EF Core can cascade

The most portable fix, and the one that works regardless of how the database constraint was created. Pull the children into the context with `Include`, and EF Core will issue `DELETE` statements for them before deleting the parent.

```csharp
// .NET 11, EF Core 11.0.0 -- EF Core deletes posts, then the blog
var blog = await db.Blogs
    .Include(b => b.Posts)
    .SingleAsync(b => b.Id == 1);

db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

With the posts tracked, EF Core sees that deleting the blog severs a required relationship, applies the cascade in memory, and orders the SQL correctly: delete the posts first, then the blog. This works because EF Core "always applies configured cascading behaviors to tracked entities," independent of the database schema.

The cost is obvious: you load every dependent row into memory just to delete it. For a blog with ten posts that is fine. For a parent with a hundred thousand children it is a memory and round-trip problem, and you want Fix 3 (database cascade) or a set-based bulk delete instead. EF Core 11's [`ExecuteDelete` for bulk writes](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) deletes children in a single SQL statement without materializing them, which is the right tool when the child set is large. Just remember `ExecuteDelete` bypasses the change tracker, so you delete children explicitly before the parent rather than relying on cascade.

## Fix 2: make the relationship optional so the FK can be nulled

Use this when the child can legitimately exist without the parent. Make the foreign key nullable, and the default behavior for an optional relationship becomes `ClientSetNull`: EF Core sets the dependents' FK to null instead of deleting them.

```csharp
// .NET 11, EF Core 11.0.0 -- optional relationship
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int? BlogId { get; set; }           // nullable => optional relationship
    public Blog? Blog { get; set; }
}
```

After a migration that makes the `BlogId` column nullable, deleting a blog with its posts loaded produces `UPDATE Posts SET BlogId = NULL ...` for each post, then `DELETE FROM Blogs ...`. The posts survive, detached from any blog.

```csharp
// .NET 11, EF Core 11.0.0 -- posts kept, FK set to null
var blog = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);
db.Blogs.Remove(blog);
await db.SaveChangesAsync();
```

Two caveats. First, this is a semantic decision, not a trick to silence the error: only make a relationship optional if an orphaned child is genuinely valid in your domain. A `Post` with no `Blog` may be nonsense. Second, with `ClientSetNull` (the default) EF Core still needs the dependents loaded to null their FKs; if they are not loaded, you get a `DbUpdateException` again. To push the null-out into the database so it works without loading, configure `OnDelete(DeleteBehavior.SetNull)`, which emits `ON DELETE SET NULL` on the constraint.

```csharp
// .NET 11, EF Core 11.0.0 -- database nulls the FK on delete, no need to load children
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.SetNull);
}
```

## Fix 3: configure the database to cascade the delete

Use this when the children should die with the parent and you do not want to load them first. Configure `DeleteBehavior.Cascade` and create or migrate the schema so the constraint carries `ON DELETE CASCADE`. The database then deletes the dependents itself when you delete the principal.

```csharp
// .NET 11, EF Core 11.0.0 -- ON DELETE CASCADE in the database
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne(p => p.Blog)
        .HasForeignKey(p => p.BlogId)
        .OnDelete(DeleteBehavior.Cascade);
}
```

For a required relationship this is already the convention default, but the constraint only carries `ON DELETE CASCADE` if the database was *created or migrated with that configuration in place*. This is the trap that catches most people: they add `OnDelete(Cascade)` (or rely on the default), the build succeeds, and the delete still fails, because the running database was created before the cascade was configured and the existing constraint has no cascade clause. Configuration in `OnModelCreating` changes the model, not the live database. You must generate and apply a migration:

```bash
# .NET 11 SDK, EF Core tools 11.0.0
dotnet ef migrations add ConfigurePostCascade
dotnet ef database update
```

Verify the constraint actually carries the cascade. On SQLite, inspect the foreign key list:

```sql
-- run against the SQLite database file
SELECT * FROM pragma_foreign_key_list('Posts');
-- the "on_delete" column should read CASCADE, not NO ACTION
```

After that, `db.Blogs.Remove(blog); await db.SaveChangesAsync();` deletes the blog with no `Include`, and the database removes the posts in the same operation.

One platform limitation worth knowing before you reach for cascade everywhere: SQL Server rejects multiple cascade paths to the same table. If two required relationships would both cascade-delete into one table, creating the schema fails with `Introducing FOREIGN KEY constraint '...' on table '...' may cause cycles or multiple cascade paths`. The fix there is to make one relationship optional, or set one to `ClientCascade` so EF Core (not SQL Server) handles that leg of the cascade with the children loaded. SQLite and PostgreSQL do not have this restriction.

## Variants that land on this same error

### Self-referencing hierarchies (tree tables)

A `Category` with a nullable `ParentId` pointing back at `Category` hits this constantly. Deleting a parent category whose children are not loaded fails the FK check. Because SQL Server forbids a self-referencing cascade that could cycle, you usually cannot rely on `ON DELETE CASCADE` here at all; load the subtree and let EF Core delete it, or delete bottom-up with `ExecuteDelete`.

### Many-to-many join rows

With a skip navigation (`Blog` has many `Tag` through an implicit join table), deleting a `Blog` requires the join rows to go first. EF Core handles this automatically when the blog is loaded with its `Tags`, but a bare `Remove` without loading the navigation leaves the join rows orphaned and the delete fails. Either load the skip navigation or `ExecuteDelete` the join rows. The mechanics of join entities are covered in [seeding a many-to-many relationship in EF Core 11](/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/).

### "It worked on the in-memory provider"

The EF Core in-memory database does not enforce foreign keys or cascade deletes, so a delete that "passes" in a unit test can fail against a real SQLite or SQL Server database. This is one of several reasons the in-memory provider is a poor stand-in for relational behaviour; prefer SQLite in-memory or a real database for delete-path tests. See [mocking DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) for tracking-aware test patterns, and note that the relationship-fixup rules here interact with [AsNoTracking vs AsNoTrackingWithIdentityResolution](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/): a no-tracking query will not let EF Core cascade in memory, because nothing is tracked to cascade.

### The error fires only after an upgrade

If a delete that used to work starts throwing after moving runtime or provider versions, check whether a default `DeleteBehavior` or an FK nullability changed in your model snapshot. The breaking-change surface is catalogued in [migrating EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/); diff your generated migrations to see whether the cascade clause moved.

### The delete is inside a retrying execution strategy

If you wrap the delete in a manual transaction while using `EnableRetryOnFailure`, you can get a *different* exception that masks this one. That interaction is its own error, covered in [the execution strategy does not support user-initiated transactions](/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/).

## Confirming the fix

Reproduce the delete against the real provider, not the in-memory one, and watch the generated SQL. Turn on sensitive logging in development so the parameter values and statement order are visible:

```csharp
// .NET 11, EF Core 11.0.0 -- dev only; never enable sensitive logging in production
var options = new DbContextOptionsBuilder<AppDb>()
    .UseSqlite("Data Source=app.db")
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging()
    .Options;
```

If the fix worked you will see either `DELETE FROM Posts ...` before `DELETE FROM Blogs ...` (Fix 1 or Fix 3) or `UPDATE Posts SET BlogId = NULL ...` before the blog delete (Fix 2). If you still see a lone `DELETE FROM Blogs ...` followed by the exception, the dependents were neither loaded nor handled by the database, and you have applied the configuration to the model but not to the live schema. Re-run `dotnet ef database update` and re-check `pragma_foreign_key_list`.

The mental model worth keeping: this error is the database asking you to decide the fate of the children before you delete the parent. Delete them with it (cascade), keep them and cut the link (set null), or pull them into the context so EF Core can decide row by row. The error is not EF Core being difficult; it is referential integrity doing exactly its job.

## Sources

- [Cascade Delete](https://learn.microsoft.com/en-us/ef/core/saving/cascade-delete), EF Core docs, on `DeleteBehavior`, required vs optional defaults, and the loaded-vs-not-loaded behavior tables.
- [Relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships), EF Core docs, on how required and optional relationships are inferred from FK nullability.
- [Microsoft.Data.Sqlite foreign keys](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/foreign-keys), on `PRAGMA foreign_keys` enforcement.
- [SQLite result and error codes](https://www.sqlite.org/rescode.html), on `SQLITE_CONSTRAINT_FOREIGNKEY` (extended code 787).
