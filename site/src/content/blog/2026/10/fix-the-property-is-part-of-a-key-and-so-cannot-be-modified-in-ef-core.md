---
title: "Fix: The property 'X' is part of a key and so cannot be modified or marked as modified in EF Core"
description: "EF Core never updates a key value on a tracked entity. Stop copying the key from DTOs, use a unique index instead of an alternate key, and change a real key by inserting a new row and deleting the old one. Tested on EF Core 10.0.14."
pubDate: 2026-10-27
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "change-tracker"
  - "dotnet-10"
---

**Short answer:** EF Core treats every key property (primary key, alternate key, and any foreign key that is also part of the primary key) as read-only once the entity has been saved, and the change tracker throws as soon as it notices a new value. Find what is writing the key: usually a DTO mapper or `CurrentValues.SetValues` copying an `Id` of `0`, a natural column configured with `HasAlternateKey`, or a child row with a composite key being moved to another parent. Stop writing it, switch the alternate key to a unique index, or, when the key really must change, add a new entity with the new key and remove the old one in the same `SaveChanges`.

Everything below was reproduced on .NET 10 (SDK 10.0.302) with `Microsoft.EntityFrameworkCore.Sqlite` 10.0.14 against an in-memory SQLite database. The check that throws lives in `InternalEntryBase.SetPropertyModified` and is unchanged on the EF Core `main` branch that ships as EF Core 11, so the same rules apply to the .NET 11 release candidates.

## The error in context

```
System.InvalidOperationException: The property 'Blog.Id' is part of a key and so cannot be modified or marked as modified. To change the principal of an existing entity with an identifying foreign key, first delete the dependent and invoke 'SaveChanges', and then associate the dependent with the new principal.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.InternalEntryBase.SetPropertyModified(IProperty property, Boolean changeState, Boolean isModified, Boolean isConceptualNull, Boolean acceptChanges)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.DetectValueChange(IInternalEntry entry, IProperty property)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntryBase entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.ChangeDetector.LocalDetectChanges(InternalEntityEntry entry)
```

The property name in the message tells you which key EF is protecting. `Blog.Id` is a primary key. Something like `Blog.Slug` means an alternate key. `OrderLine.OrderId` means a foreign key that is also part of a composite primary key, which is the "identifying foreign key" the second sentence of the message talks about.

## Why EF Core refuses to change a key

A tracked entity is identified by its key. The `DbContext` keeps an identity map from key values to entity instances, uses the original key in the `WHERE` clause of the `UPDATE`, and fixes up navigations by matching foreign keys to principal keys. If the key could change in place, all three would have to be rewritten mid-flight, plus every dependent row in the database. EF Core does not support that, and the request to add it, [dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073), is still open.

The guard is metadata-driven. Every key property gets `PropertySaveBehavior.Throw` as its after-save behavior, and the change tracker checks it whenever a property on an `Unchanged` or `Modified` entity is about to be flagged as modified:

```csharp
// EF Core source, src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs (simplified)
if (changeState
    && !isConceptualNull
    && isModified
    && !StateManager.SavingChanges
    && property.IsKey()
    && property.GetAfterSaveBehavior() == PropertySaveBehavior.Throw)
{
    throw new InvalidOperationException(CoreStrings.KeyReadOnly(property.Name, StructuralType.DisplayName()));
}
```

Two consequences matter for debugging. First, entities in the `Added` state return before this check, so changing the key of an entity you have not saved yet is fine. Second, with the default snapshot change tracking the exception is not thrown at the line that assigns the key. It is thrown at the next `DetectChanges`, which runs inside `SaveChanges`, `ChangeTracker.HasChanges()`, `ChangeTracker.Entries()`, and similar calls. In my repro, `blog.Id = 99;` completed silently and the very next `db.ChangeTracker.HasChanges()` threw. If your stack trace points at `SaveChangesAsync` in a repository, the real culprit is somewhere earlier in the request.

You also cannot opt out. Trying to flip the save behavior on a key property fails while the model is being built:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().Property(b => b.Id).Metadata
    .SetAfterSaveBehavior(PropertySaveBehavior.Save);
// InvalidOperationException: The property 'Blog.Id' must be marked as read-only after it has been
// saved because it is part of a key. Key properties are always read-only once an entity has been
// saved for the first time.
```

## Minimal repro

```csharp
// .NET 10, C# 14, EF Core 10.0.14, Microsoft.EntityFrameworkCore.Sqlite
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

using var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();

using (var db = new AppDb(conn))
{
    db.Database.EnsureCreated();
    db.Blogs.Add(new Blog { Id = 1, Name = "Start Debugging" });
    db.SaveChanges();
}

using (var db = new AppDb(conn))
{
    var blog = db.Blogs.Single(b => b.Id == 1);
    blog.Id = 99;       // no exception here
    db.SaveChanges();   // InvalidOperationException: The property 'Blog.Id' is part of a key...
}

class AppDb(SqliteConnection c) : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite(c);
    protected override void OnModelCreating(ModelBuilder mb) =>
        mb.Entity<Blog>().Property(b => b.Id).ValueGeneratedNever();
}

class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}
```

Nobody writes `blog.Id = 99` on purpose, so the rest of this post is about the four places the write actually comes from, ranked by how often I see them.

## Fix 1: stop copying the key from a DTO

This is the most common cause by far. A PUT endpoint loads the entity, then copies the incoming model over it:

```csharp
// .NET 10, EF Core 10.0.14
public record BlogDto(int Id, string Name);

var blog = await db.Blogs.SingleAsync(b => b.Id == id);
db.Entry(blog).CurrentValues.SetValues(dto);   // dto.Id is 0 because the client never sent it
await db.SaveChangesAsync();                    // throws: 'Blog.Id' is part of a key
```

`PropertyValues.SetValues` copies every property whose name matches, keys included. When the DTO's `Id` matches the tracked one, nothing changes and the save succeeds; I confirmed that `SetValues` with `Id = 1` on the row with `Id = 1` saves cleanly. When the client omits the id from the body, or the route id and body id disagree, the key changes and EF throws. Notice the stack trace for this case is different: because `SetValues` goes through the change tracker directly, the exception is raised inside `SetValues` itself (`ChangeDetector.PropertyChanged`), not at `SaveChanges`.

Pick one source of truth for the id, usually the route, and never let the body overwrite it:

```csharp
// .NET 10, EF Core 10.0.14
app.MapPut("/blogs/{id:int}", async (int id, BlogDto dto, AppDb db) =>
{
    if (dto.Id != 0 && dto.Id != id)
        return Results.BadRequest("Route id and body id differ.");

    var blog = await db.Blogs.SingleOrDefaultAsync(b => b.Id == id);
    if (blog is null) return Results.NotFound();

    db.Entry(blog).CurrentValues.SetValues(dto with { Id = id });
    await db.SaveChangesAsync();
    return Results.NoContent();
});
```

Better still, use an update DTO that has no `Id` property at all, so there is nothing to copy. With AutoMapper, the equivalent is `.ForMember(d => d.Id, o => o.Ignore())` on the DTO-to-entity map, and it is worth adding `ForMember(...Ignore())` for every key column, including foreign keys that are part of a composite key.

The same mistake happens with manual "copy all properties" helpers and reflection-based patchers. If you write one, filter out `entry.Metadata.FindPrimaryKey()!.Properties` and anything where `property.IsKey()` is true.

## Fix 2: use a unique index, not an alternate key, for natural identifiers

The second shape is a column that you think of as "unique", such as a slug, an email, or an SKU, configured as an alternate key:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasAlternateKey(b => b.Slug);

var blog = db.Blogs.Single();
blog.Slug = "new-slug";
db.SaveChanges();   // InvalidOperationException: The property 'Blog.Slug' is part of a key...
```

An alternate key is a key in every sense that matters to EF, so it is read-only after save. The EF Core docs say it directly: "In EF, alternate keys are read-only". If all you need is uniqueness in the database, configure a unique index instead:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<Blog>().HasIndex(b => b.Slug).IsUnique();
```

With that one-line change the same code saved and the row read back with `Slug = "new-slug"`. The database still enforces uniqueness, you just lose the ability to point a foreign key at `Slug`.

Watch for alternate keys you did not declare. `HasPrincipalKey(x => x.Slug)` on a relationship makes EF create one by convention, because a foreign key has to target a key. If the message names a property you never called `HasAlternateKey` on, search the model configuration for `HasPrincipalKey`, or inspect `db.Model.FindEntityType(typeof(Blog))!.GetKeys()` at runtime. Switching that relationship to target the primary key is the clean fix. Migration-wise, going from alternate key to unique index replaces an `AK_` unique constraint with an `IX_` unique index; check the generated migration before applying it.

## Fix 3: move a dependent with a composite key by deleting and re-adding it

The message's second sentence is about this case. Say an order line is keyed by `(OrderId, LineNumber)` and `OrderId` is also the foreign key to `Order`. That is an identifying relationship: the line's identity includes its parent. Moving it to another order means changing its primary key, and every way of expressing that throws:

```csharp
// .NET 10, EF Core 10.0.14
modelBuilder.Entity<OrderLine>().HasKey(l => new { l.OrderId, l.LineNumber });

var line = db.OrderLines.Single();
line.OrderId = 2;                     // throws at SaveChanges
// line.Order = order2;               // throws during fix-up
// order2.Lines.Add(line);            // throws during fix-up
db.SaveChanges();
```

All three variants produced `The property 'OrderLine.OrderId' is part of a key` in my repro. The navigation and collection versions throw from relationship fix-up, which sets the foreign key for you.

The fix is to treat the move as what it really is: a delete of one row and an insert of another.

```csharp
// .NET 10, EF Core 10.0.14
var line = await db.OrderLines.SingleAsync(l => l.OrderId == 1 && l.LineNumber == 1);

db.OrderLines.Remove(line);
db.OrderLines.Add(new OrderLine
{
    OrderId = 2,
    LineNumber = 1,
    Sku = line.Sku,
});

await db.SaveChangesAsync();
```

The message suggests calling `SaveChanges` after the delete and before the insert. On EF Core 10 that was not necessary for any case I tried: removing the old line and adding the new one in a single `SaveChanges` worked both when the new key was different (`2/1`) and when it was identical (`1/1` with a new `Sku`), and both statements ran in the same transaction. A single `SaveChanges` is also safer, because a crash between two saves would leave the line deleted and not re-created.

If lines move between parents regularly, the model is telling you something. Give `OrderLine` its own surrogate key (`int Id`) and make `OrderId` a normal, non-key foreign key. Then `line.OrderId = 2` is an ordinary update. Keep `(OrderId, LineNumber)` unique with a unique index if you need that constraint.

## Fix 4: re-key a principal by inserting a copy and re-pointing its children

Sometimes the primary key itself must change: a legacy natural key was entered wrong, or two systems are being merged. Inside the change tracker the pattern is the same as fix 3, with one extra step for the children:

```csharp
// .NET 10, EF Core 10.0.14
var old = await db.Blogs.Include(b => b.Posts).SingleAsync(b => b.Id == 1);

var replacement = new Blog { Id = 99, Name = old.Name, Slug = old.Slug + "-moved" };
db.Blogs.Add(replacement);

foreach (var post in old.Posts.ToList())
    post.Blog = replacement;          // Post.BlogId is a plain FK, not part of Post's key

db.Blogs.Remove(old);
await db.SaveChangesAsync();
```

EF Core works out the command order (insert the new blog, update the posts, delete the old blog) and runs it in one transaction. In the repro this left one blog with `Id = 99` and the post's `BlogId` set to `99`. Note the slug was changed in the copy: if `Slug` had a unique index, the insert of an identical value can collide with the old row that has not been deleted yet. Either give the copy a temporary value and fix it afterwards, or use the set-based approach below.

### The set-based escape hatch: ExecuteUpdate

`ExecuteUpdate` translates straight to SQL and never touches the change tracker, so the key guard does not apply:

```csharp
// .NET 10, EF Core 10.0.14
var rows = await db.Blogs
    .Where(b => b.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Id, 99));
```

On a blog with no posts this returned `1` and the row's id became `99`. On a blog that had a post referencing it, SQLite answered with `SQLite Error 19: 'FOREIGN KEY constraint failed'`, which is exactly what any database will do unless the foreign key was declared with `ON UPDATE CASCADE`. EF Core's fluent API has `OnDelete` but no equivalent for updates, so you would have to add the cascade with `migrationBuilder.Sql(...)` in a migration. For a one-off data fix that is usually not worth it; insert, re-point, delete is easier to reason about.

Two caveats if you do use `ExecuteUpdate` on keys. Any entity already tracked by the same context still has the old key, so do the update in a fresh context or detach first. And it bypasses `SaveChanges` interceptors and audit logic, which is probably the point but should be a deliberate choice.

## Gotchas and lookalikes

**Setting `IsModified` on a key throws immediately.** Code that loops over `entry.Properties` and sets `IsModified = true` on all of them fails on the first key property. `db.Entry(blog).Property(b => b.Id).IsModified = true` threw in the repro without any `SaveChanges` call. Skip properties where `p.Metadata.IsKey()` is true. Setting the whole entry to `EntityState.Modified` is fine (it saved cleanly in the repro), because EF marks only non-key properties.

**`Update()` on a detached object with a different id is a different error.** `db.Update(new Blog { Id = 2, ... })` does not try to change a key. It sends `UPDATE ... WHERE Id = 2`, and when that row does not exist you get `DbUpdateConcurrencyException: The database operation was expected to affect 1 row(s), but actually affected 0 row(s)`. Same root mistake (wrong id from the client), different symptom.

**Two instances with the same key is also a different error.** If you fix this error by attaching a second object with the new key while the old one is still tracked, you may run into [the "cannot be tracked because another instance with the same key value is already being tracked" error](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) instead. [Checking whether an entity is already tracked](/2026/10/how-to-check-whether-an-entity-is-already-tracked-by-the-dbcontext-in-ef-core/) before attaching avoids both.

**Changing a key on an `Added` entity is fine.** Until the first `SaveChanges`, the key is not yet "saved", so `var b = new Blog { Id = 5 }; db.Add(b); b.Id = 6;` inserts a row with `Id = 6`. This matters for code that assigns a provisional id and corrects it before saving.

## Related

If you end up changing keys with set-based statements, the walkthrough of [ExecuteUpdate and ExecuteDelete for bulk writes](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) covers the API and its interaction with tracked entities, and the comparison of [ExecuteUpdate versus loading entities and calling SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) explains when each is the right tool. When the delete half of a re-key fails because children still point at the old row, see [the foreign key constraint failed fix](/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/). To see exactly which entries are about to be saved before the exception fires, [`ChangeTracker.GetEntriesForState`](/2026/04/efcore-11-changetracker-getentriesforstate/) is the cheapest way to dump them.

## Sources

- [`KeyReadOnly` resource string](https://github.com/dotnet/efcore/blob/main/src/EFCore/Properties/CoreStrings.resx) and [`InternalEntryBase.SetPropertyModified`](https://github.com/dotnet/efcore/blob/main/src/EFCore/ChangeTracking/Internal/InternalEntryBase.cs), dotnet/efcore source.
- [Support modifying the value of primary or alternate key properties, dotnet/efcore#4073](https://github.com/dotnet/efcore/issues/4073), open feature request.
- [Keys: alternate keys](https://learn.microsoft.com/en-us/ef/core/modeling/keys#alternate-keys), EF Core docs.
- [Indexes: index uniqueness](https://learn.microsoft.com/en-us/ef/core/modeling/indexes#index-uniqueness), EF Core docs.
- [Change detection and notifications](https://learn.microsoft.com/en-us/ef/core/change-tracking/change-detection), EF Core docs.
- [`PropertyValues.SetValues`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues), Microsoft Learn.
- [ExecuteUpdate and ExecuteDelete](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete), EF Core docs.
