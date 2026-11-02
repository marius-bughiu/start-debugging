---
title: "What Does EF Core Write Back Into an Entity After SaveChangesAsync?"
description: "After SaveChangesAsync, EF Core 11 copies store-generated keys, defaults, computed columns and concurrency tokens back into your entities, fixes up foreign keys and navigations, and resets every entry to Unchanged. Here is exactly what gets written, when, what the SQL looks like, and four cases where the value on your entity is not what is in the database."
pubDate: 2026-11-02
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "change-tracking"
  - "concurrency"
---

Short answer: after a successful `SaveChangesAsync`, EF Core 11 writes three kinds of things back into your tracked entities. First, every column the model marks as store-generated (identity keys, `HasDefaultValueSql` defaults, computed columns, `ValueGeneratedOnAddOrUpdate` concurrency tokens) is read back from the database in the same round trip, via `RETURNING` on SQLite and `OUTPUT` on SQL Server, and copied onto the entity. Second, the real key values replace the temporary ones, and every foreign key that pointed at a temporary key is fixed up to the real value. Third, `AcceptAllChanges` runs: Added and Modified entries become Unchanged, original values are reset to the current values, and Deleted entries are detached. Anything EF Core did not ask the database for, such as a column an `AFTER` trigger changed, is not refreshed, and the entity silently holds a stale value.

Everything below was run against `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.3.26522.148 on the .NET 11 RC3 SDK (11.0.100-rc.3.26522.148), C# 15, with the bundled SQLite (`SQLitePCLRaw.bundle_e_sqlite3` 3.0.5). The console output and SQL are copied from real runs. The behaviour is the same in EF Core 8, 9 and 10 for everything except where noted.

## The model used for every experiment

One `Blog` with every flavour of generated value, a `Post` that depends on it, and a `Tag` with a client-generated `Guid` key:

```csharp
// .NET 11 RC3, C# 15, Microsoft.EntityFrameworkCore.Sqlite 11.0.0-rc.3.26522.148
public class Blog
{
    public int Id { get; set; }                 // identity (AUTOINCREMENT)
    public string Name { get; set; } = "";
    public DateTime CreatedUtc { get; set; }    // HasDefaultValueSql
    public bool IsActive { get; set; }          // HasDefaultValue(true)
    public string? Slug { get; set; }           // stored computed column
    public long Version { get; set; }           // concurrency token, bumped by a trigger
    public List<Post> Posts { get; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public int BlogId { get; set; }
    public Blog? Blog { get; set; }
}

public class Tag
{
    public Guid Id { get; set; }
    public string Label { get; set; } = "";
}

protected override void OnModelCreating(ModelBuilder mb)
{
    mb.Entity<Blog>(b =>
    {
        b.HasIndex(x => x.Name).IsUnique();
        b.Property(x => x.CreatedUtc).HasDefaultValueSql("CURRENT_TIMESTAMP");
        b.Property(x => x.IsActive).HasDefaultValue(true);
        b.Property(x => x.Slug).HasComputedColumnSql("lower(replace(Name, ' ', '-'))", stored: true);
        b.Property(x => x.Version).HasDefaultValue(1L).IsConcurrencyToken().ValueGeneratedOnAddOrUpdate();
    });
}
```

After `EnsureCreated`, a trigger bumps `Version` on every update, the way many legacy schemas do it:

```sql
CREATE TRIGGER BumpVersion AFTER UPDATE ON Blogs
BEGIN
    UPDATE Blogs SET Version = OLD.Version + 1 WHERE Id = NEW.Id;
END;
```

What EF Core decided about each property is visible in the model, and it is the single best predictor of what will be written back:

```text
model: Id ValueGenerated=OnAdd Sentinel=0
model: CreatedUtc ValueGenerated=OnAdd Sentinel=01/01/0001 00:00:00
model: IsActive ValueGenerated=OnAdd Sentinel=True
model: Name ValueGenerated=Never Sentinel=null
model: Slug ValueGenerated=OnAddOrUpdate Sentinel=null
model: Version ValueGenerated=OnAddOrUpdate Sentinel=0
```

Print it yourself with `db.Model.FindEntityType(typeof(Blog))!.GetProperties()` and the `ValueGenerated` and `Sentinel` properties. `OnAdd` properties are candidates for read-back after an insert, `OnAddOrUpdate` after an insert and an update, and `Never` is never read back.

## Before SaveChangesAsync: temporary keys live in the change tracker, not on your object

```csharp
var blog = new Blog { Name = "Start Debugging" };
var post = new Post { Title = "Hello" };
blog.Posts.Add(post);
var tag = new Tag { Label = "ef-core" };
db.Add(blog);
db.Add(tag);

var idEntry = db.Entry(blog).Property(b => b.Id);
var fkEntry = db.Entry(post).Property(p => p.BlogId);
```

```text
after Add: blog.Id=0, tracker CurrentValue=-2147482647, IsTemporary=True
after Add: post.BlogId=0, tracker=-2147482647, IsTemporary=True, post.Blog set=True
after Add: tag.Id=4f26de8d-a3e3-4253-a7fb-d1c39f9e43ea (Guid, client-generated)
after Add: blog.CreatedUtc=01/01/0001 00:00:00, blog.IsActive=False, blog.Slug=null
```

Four things to notice:

- `blog.Id` is still `0`. EF Core generated a temporary key (`-2147482647`) so it can identify the entity and relate the post to it, but the docs are explicit that "temporary values are stored in the change tracker and not set onto entity instances directly". `PropertyEntry.IsTemporary` tells you which values are placeholders.
- `post.BlogId` is also `0` on the object and the same temporary value in the tracker. The foreign key was fixed up the moment `Add` ran `DetectChanges`, just not onto the CLR property yet.
- `post.Blog` is already set. Navigation fix-up does not wait for the database at all: as soon as both entities are tracked, EF Core points the reference navigation at its principal.
- `tag.Id` is already a real `Guid`. Client-generated keys are generated by a value generator at `Add` time, so there is nothing to write back for them later.

Store-generated defaults (`CreatedUtc`, `Slug`) are still CLR defaults. EF Core cannot know them until the database runs the `INSERT`.

## During SaveChangesAsync: generated columns come back in the same statement

With `LogTo` on the `Database.Command` category you can see that EF Core does not issue extra `SELECT`s for the generated values. It asks for them in the `INSERT` itself:

```sql
INSERT INTO "Blogs" ("IsActive", "Name")
VALUES (@p0, @p1)
RETURNING "Id", "CreatedUtc", "Slug", "Version";

INSERT INTO "Tags" ("Id", "Label")
VALUES (@p0, @p1);

INSERT INTO "Post" ("BlogId", "Title")
VALUES (@p2, @p3)
RETURNING "Id";
```

The ordering matters. EF Core sorts the commands topologically, inserts `Blogs` first, reads the real `Id`, and only then binds `@p2` (the post's `BlogId`) to that value. The `Tags` insert has no `RETURNING` because nothing on `Tag` is store-generated. The `RETURNING` list for `Blogs` is exactly the set of `OnAdd` and `OnAddOrUpdate` properties from the model dump, minus the ones EF Core sent a value for.

On SQL Server the same idea is expressed with `OUTPUT INSERTED.[Id], ...` on the `INSERT`, which is why identity values come back without a second round trip on either provider.

## After SaveChangesAsync: values copied, entries accepted

```text
after Save: blog.Id=1, IsTemporary=False, state=Unchanged
after Save: post.Id=1, post.BlogId=1
after Save: blog.CreatedUtc=02/11/2026 12:05:54, blog.Slug=start-debugging, blog.Version=1
```

Every value from `RETURNING` is now on the CLR object: the identity key, the defaulted timestamp, the computed slug and the initial version. `post.BlogId` has gone from `0` to `1` because EF Core propagated the real principal key to every dependent that referenced the temporary one. Both entries are `Unchanged`.

The same applies to updates. Changing `Name` and saving again produces:

```sql
UPDATE "Blogs" SET "Name" = @p0
WHERE "Id" = @p1 AND "Version" = @p2
RETURNING "Slug", "Version";
```

```text
before Save OriginalValue=Start Debugging; after Save OriginalValue=Start Debugging Blog
after Save: blog.Slug=start-debugging-blog, blog.Version=1
```

Two write-backs happened. The recomputed `Slug` was read back because it is `OnAddOrUpdate`. And the original value of `Name` was overwritten with the current value, which is what `AcceptAllChanges` does: the snapshot EF Core will diff against next time is now the saved state. That is also why the concurrency token's original value is what ends up in the next `WHERE "Version" = @p2`.

Deletes are the mirror image:

```text
after Save: post state=Detached, blog.Posts.Count=0, post.Blog null=False
```

The deleted `Post` is detached, and it was removed from the principal's `Posts` collection. Its own `Blog` reference is left alone, though. If you keep a deleted entity around, do not assume its navigations were cleared.

## Trap 1: an AFTER trigger changes a column, and the entity keeps the old value

Look at the update output again: `blog.Version=1`. The database disagrees:

```text
in database: Version=2
second update: DbUpdateConcurrencyException: The database operation was expected to affect 1 row(s), but actually affected 0 row(s); ...
after Reload Version=2
```

SQLite's `RETURNING` reports the row as the `UPDATE` statement wrote it, before the `AFTER` trigger ran. EF Core faithfully copied `1` back onto the entity, the trigger moved the row to `2`, and the next save sent `WHERE "Version" = 1`, matched zero rows, and threw a concurrency exception for a conflict that never existed.

Declaring the trigger with `tb.HasTrigger("BumpVersion")` made no difference on SQLite in my runs: the SQL and the stale value were identical with and without it. What fixes it is turning off `RETURNING` for that table:

```csharp
// EF Core 8+, SQLite provider
mb.Entity<Blog>().ToTable(tb => tb.UseSqlReturningClause(false));
```

EF Core then reads the generated values with a separate `SELECT` in the same command, after the triggers have fired:

```sql
UPDATE "Blogs" SET "Name" = @p0
WHERE "Id" = @p1 AND "Version" = @p2;
SELECT "Slug", "Version"
FROM "Blogs"
WHERE changes() = 1 AND "Id" = @p1;
```

```text
after Save: blog.Slug=start-debugging-blog, blog.Version=2
second update ok, Version=3
```

The EF Core 7 breaking-changes page documents this for SQLite tables with `AFTER` triggers and virtual tables. SQL Server has the related problem the other way round: `OUTPUT` without `INTO` is not allowed on a table with triggers, so the save fails outright instead of returning stale data, and the fix is `tb.UseSqlOutputClause(false)` (or `HasTrigger` on EF Core 7). If your concurrency tokens are trigger-maintained, read the [rowversion concurrency walkthrough](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) for the native alternative that avoids triggers entirely.

## Trap 2: a bool with a database default of true never gets the default

The model dump showed `IsActive ValueGenerated=OnAdd Sentinel=True`. Since EF Core 8, a `bool` with a database default of `true` gets `true` as its sentinel, the value that means "not set, let the database decide". Every other value is sent explicitly. The CLR default `false` is not the sentinel, so it is always sent:

```text
first blog IsActive in database=False
set IsActive=false, after Save IsActive=False
in database: IsActive=False
```

The first blog never touched `IsActive`, and it was stored as `false`, not the `DEFAULT 1` in the table definition. That is the correct reading of "the CLR value wins", but if you expected the database default to apply to objects you did not touch, it never will through EF Core. Either initialise the property in C# (`public bool IsActive { get; set; } = true;`) or make it `bool?` (or a nullable backing field) so `null` can mean "use the default". The same thinking applies to any non-nullable type whose CLR default is a valid business value.

## Trap 3: a failed save writes nothing back, and keys stay temporary

Insert two blogs with the same name, which violates the unique index:

```text
DbUpdateException: SQLite Error 19: 'UNIQUE constraint failed: Blogs.Name'.
after failure: a.Id=0, tracker=-2147482645, IsTemporary=True, state=Added
rows in Blogs named A: 0
```

The first row was inserted successfully before the second failed, but `SaveChangesAsync` runs in a transaction, so the whole thing rolled back. EF Core also did not write that first row's generated `Id` onto the entity: `a` is still `Added` with a temporary key, ready to be retried after you fix the data. This is the behaviour you want, but it means code that logs `entity.Id` in a `catch` block logs `0`. If you need retry semantics around this, the [concurrent unique insert fix](/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/) shows how to recover cleanly.

## Trap 4: acceptAllChangesOnSuccess: false defers the write-back too

`SaveChangesAsync(acceptAllChangesOnSuccess: false)` is meant for coordinating a save with another resource: you save, do something else, and call `ChangeTracker.AcceptAllChanges()` once everything succeeded. The surprise is how much of the write-back it defers:

```csharp
var b = new Blog { Name = "Deferred" };
db.Add(b);
await db.SaveChangesAsync(acceptAllChangesOnSuccess: false);
// inspect, then:
db.ChangeTracker.AcceptAllChanges();
```

```text
after Save(false): tracker=3, b.Id=0, state=Added, IsTemporary=False
after AcceptAllChanges: b.Id=3, state=Unchanged
```

The row is in the database and the tracker knows the real key (`3`, no longer temporary), but `b.Id` on your object is still `0` until `AcceptAllChanges` runs. Code that reads the new ID between the two calls, for example to put it in an outbox message, gets `0`. Read it from `db.Entry(b).Property(x => x.Id).CurrentValue` instead, or call `AcceptAllChanges` first.

## What is never written back

To summarise the boundary:

- Columns the model does not mark as generated (`ValueGenerated=Never`). If a trigger or a default changes a plain column, EF Core does not know and does not ask. Map it with `ValueGeneratedOnAdd` / `ValueGeneratedOnAddOrUpdate` if you want it refreshed, or call `ReloadAsync`.
- Anything on entities that were not part of this save. Rows changed by a cascade in the database are not refreshed in memory, beyond EF Core applying its own cascade rules to tracked entities.
- Changes made by `ExecuteUpdateAsync` or `ExecuteDeleteAsync`. Those bypass the change tracker entirely, as covered in the [ExecuteUpdate vs SaveChanges comparison](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/).
- Entities loaded with `AsNoTracking`. There is no entry to accept and nothing to copy values into. If you attach one later, see [the identity resolution trade-offs](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/) and the classic [same key value tracking error](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/).

If the keys are coming from a sequence rather than identity, the write-back works the same way, but the value is fetched before the insert; the [database sequence key post](/2026/08/how-to-generate-a-primary-key-from-a-database-sequence-on-insert-in-ef-core-11/) shows that SQL.

## Reproducing this

Create a console project targeting `net11.0`, reference `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.3.26522.148, paste the model above into a `DbContext` that uses an open `SqliteConnection("Data Source=:memory:")`, call `EnsureCreated`, create the trigger with `ExecuteSqlRaw`, and print the values shown in each section. Add `o.LogTo(Console.WriteLine, [DbLoggerCategory.Database.Command.Name], LogLevel.Information)` in `OnConfiguring` to see the `RETURNING` clauses. To compare the trigger fix, toggle `tb.UseSqlReturningClause(false)` inside `ToTable` and run again.

## Sources

- [Generated values](https://learn.microsoft.com/en-us/ef/core/modeling/generated-properties), EF Core docs: default values, computed columns, overriding generation.
- [Additional change tracking features: temporary values](https://learn.microsoft.com/en-us/ef/core/change-tracking/miscellaneous#temporary-values), EF Core docs.
- [Explicitly tracking entities: generated key values](https://learn.microsoft.com/en-us/ef/core/change-tracking/explicit-tracking#generated-key-values), EF Core docs.
- [EF Core 7 breaking changes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/breaking-changes): "SQLite tables with AFTER triggers and virtual tables now require special EF Core configuration" and "SQL Server tables with triggers or certain computed columns now require special EF Core configuration".
- [OUTPUT clause (Transact-SQL), Triggers section](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql), which states the enabled-trigger restriction for `OUTPUT` without `INTO`.
- [EF Core 8 breaking changes: boolean columns with a database generated value](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes), which explains the automatic `true` sentinel.
- [`DbContext.SaveChangesAsync(bool, CancellationToken)`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontext.savechangesasync) API reference.
- [SQLite `RETURNING` clause](https://www.sqlite.org/lang_returning.html), which documents that values reflect the statement, not later trigger changes.
