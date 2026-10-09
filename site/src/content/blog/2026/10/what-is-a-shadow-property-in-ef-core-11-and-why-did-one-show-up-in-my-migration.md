---
title: "What Is a Shadow Property in EF Core 11, and Why Did One Show Up in My Migration?"
description: "A shadow property is a column EF Core tracks without a matching CLR property. Here is why EF Core 11 creates them (missing FK properties, misnamed FKs, type mismatches, split relationships), how to spot the BlogId1 kind in a migration, how to fix each cause, and how to use shadow properties on purpose."
pubDate: 2026-10-09
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "migrations"
  - "relationships"
---

Short answer: a shadow property is a property that exists in the EF Core model, and usually as a column in the database, but has no matching property on your entity class. EF Core 11 creates one for you whenever a relationship needs a foreign key and it cannot find a CLR property to use. When that happens because your class simply has no FK property, the shadow column is harmless. When it happens because you *have* an FK property that EF Core could not use (wrong name, wrong type, `[NotMapped]`, or a relationship that got configured twice), you get a column like `BlogId1` or `OwnerId` next to the one you meant, and the fix is to tell EF Core which property is the foreign key with `HasForeignKey`.

Everything below was run against `Microsoft.EntityFrameworkCore.Sqlite` 11.0.0-rc.1.26425.128 on the .NET 11 RC1 SDK (11.0.100-rc.1.26425.128), C# 14. The model output and warnings are copied from real runs, not paraphrased.

## What EF Core means by "shadow"

Every property in an EF Core model has metadata: a name, a CLR type, nullability, whether it is a key or FK. For most properties there is also a backing member on the class, a C# property or field, that EF Core reads and writes when it materializes entities or saves changes. A shadow property has the metadata but no member. Its value lives only in the change tracker.

That is the entire definition, per the [shadow and indexer properties documentation](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties). EF Core does not care how the property came to exist. You can declare one deliberately, or conventions can create one during model building. The second case is the one that surprises people, because the first place it becomes visible is a migration that adds a column you never wrote.

You can see which properties are shadow properties by dumping the model. `Model.ToDebugString()` marks them with `(no field, ...)` and `Shadow`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Infrastructure;

using var db = new AppDbContext();
Console.WriteLine(db.Model.ToDebugString(MetadataDebugStringOptions.ShortDefault));
```

Keep that one-liner around. It is the fastest way to answer "where did this column come from?" without reading the migration snapshot.

## Case 1: the navigation has no FK property (expected, harmless)

The most common shadow property is the one EF Core creates when you model a relationship with navigations only:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
}
```

There is a one-to-many relationship here, so the `Post` table needs a foreign key column. `Post` has no `BlogId`, so EF Core invents one. The debug view shows it:

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    BlogId (no field, int?) Shadow FK Index
    Title (string) Required
  Foreign keys:
    Post {'BlogId'} -> Blog {'Id'} ClientSetNull ToDependent: Posts
```

And the generated table:

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "Title" TEXT NOT NULL,
    "BlogId" INTEGER NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id")
);
```

The name follows the convention `<navigation or principal type name><principal key name>`, here `Blog` + `Id`. Two details matter. First, the shadow FK is `int?`, so the relationship is optional and the delete behavior is `ClientSetNull`, not `Cascade`. If you expected required semantics, add a real `int BlogId` property or call `.IsRequired()` on the relationship. Second, EF Core logs this at Debug level only, as `CoreEventId.ShadowPropertyCreated` (event 10600):

```text
The property 'Post.BlogId' was created in shadow state because there are no eligible CLR members with a matching name.
```

You will not see that in a default console log. That is intentional: this is a legitimate modeling choice, and plenty of codebases keep FK values out of their domain classes.

## Case 2: the FK property has a non-conventional name (silent, and wrong)

This is the one that produces a "mystery column" in a migration with no warning at all:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class User
{
    public int Id { get; set; }
}

public class Post
{
    public int Id { get; set; }
    public int OwnerUserId { get; set; }
    public User Owner { get; set; } = null!;
}
```

You meant `OwnerUserId` to be the foreign key for `Owner`. EF Core's FK discovery convention only matches names of the form `<navigation name><principal key name>` (`OwnerId`), `<principal type name><principal key name>` (`UserId`), or `<principal entity type name>Id`. `OwnerUserId` matches none of them, so EF Core treats it as an ordinary `int` column and creates a shadow FK `OwnerId`:

```text
EntityType: Post
  Properties:
    Id (int) Required PK AfterSave:Throw ValueGenerated.OnAdd
    OwnerId (no field, int) Shadow Required FK Index
    OwnerUserId (int) Required
```

```sql
CREATE TABLE "Posts" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Posts" PRIMARY KEY AUTOINCREMENT,
    "OwnerUserId" INTEGER NOT NULL,
    "OwnerId" INTEGER NOT NULL,
    CONSTRAINT "FK_Posts_User_OwnerId" FOREIGN KEY ("OwnerId") REFERENCES "User" ("Id") ON DELETE CASCADE
);
```

Your code sets `post.OwnerUserId = 42`, saves, and nothing links. The relationship lives in `OwnerId`, which your code never touches. EF Core again logs only the Debug-level `ShadowPropertyCreated` event, so the first symptom is usually a join that returns nothing or a migration diff someone happens to read carefully.

The fix is to name the FK explicitly:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>()
        .HasOne(p => p.Owner)
        .WithMany()
        .HasForeignKey(p => p.OwnerUserId);
}
```

or with the data annotation on the navigation: `[ForeignKey(nameof(OwnerUserId))] public User Owner { get; set; }`. After that, the model has a single FK, `OwnerUserId`, and the shadow column is gone. If a migration with `OwnerId` already shipped, the next migration will drop `OwnerId` and add the FK constraint to `OwnerUserId`. Check whether any rows were written through the old column before you let it drop.

## Case 3: the FK property has the wrong type (BlogId1)

Now the famous `1` suffix:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Blog
{
    public int Id { get; set; }
    public List<Post> Posts { get; set; } = [];
}

public class Post
{
    public int Id { get; set; }
    public string BlogId { get; set; } = "";   // principal key is int
    public Blog Blog { get; set; } = null!;
}
```

`BlogId` has the conventional name, but it is a `string` and `Blog.Id` is an `int`. EF Core cannot use an incompatible property as the FK. It also cannot name the shadow property `BlogId`, because that name is taken, so it uniquifies it to `BlogId1`. This time EF Core logs a Warning, `CoreEventId.ShadowForeignKeyPropertyCreated` (event 10625):

```text
warn: CoreEventId.ShadowForeignKeyPropertyCreated[10625]
      The foreign key property 'Post.BlogId1' was created in shadow state because a conflicting property
      with the simple name 'BlogId' exists in the entity type, but is either not mapped, is already used
      for another relationship, or is incompatible with the associated primary key type.
```

The message lists the three causes that lead to a numbered shadow FK. Type mismatch is one. The other two follow.

## Case 4: the relationship got configured twice (BlogId and BlogId1)

This one comes from Fluent API that names only one side of the relationship:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}

protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasMany(b => b.Posts)
        .WithOne()                       // no navigation passed
        .HasForeignKey(p => p.BlogId);
}
```

`WithOne()` with no argument tells EF Core "this relationship has no navigation on the `Post` side." But `Post.Blog` exists, so conventions build a *second* relationship from it. `BlogId` is already used by the first one, so the second gets `BlogId1`:

```text
Foreign keys:
  Post {'BlogId'} -> Blog {'Id'} Required Cascade ToDependent: Posts
  Post {'BlogId1'} -> Blog {'Id'} Required Cascade ToPrincipal: Blog
```

```sql
CREATE TABLE "Post" (
    "Id" INTEGER NOT NULL CONSTRAINT "PK_Post" PRIMARY KEY AUTOINCREMENT,
    "BlogId" INTEGER NOT NULL,
    "BlogId1" INTEGER NOT NULL,
    CONSTRAINT "FK_Post_Blogs_BlogId" FOREIGN KEY ("BlogId") REFERENCES "Blogs" ("Id") ON DELETE CASCADE,
    CONSTRAINT "FK_Post_Blogs_BlogId1" FOREIGN KEY ("BlogId1") REFERENCES "Blogs" ("Id") ON DELETE CASCADE
);
```

Two required FKs to the same table, and `blog.Posts` and `post.Blog` no longer describe the same link. The fix is to pass the navigation so both ends belong to one relationship: `.WithOne(p => p.Blog)`. With that change the model is back to a single `BlogId` FK with `Inverse: Posts`.

A useful difference to know: if you drop the `HasForeignKey(p => p.BlogId)` call from that broken configuration, EF Core 11 does not quietly create `BlogId1`. It throws during model finalization instead:

```text
System.InvalidOperationException: Both relationships between 'Post' and 'Blog.Posts' and between 'Post.Blog'
and 'Blog' could use {'BlogId'} as the foreign key. To resolve this, configure the foreign key properties
explicitly in 'OnModelCreating' on at least one of the relationships.
```

So when you hit that exception, the right reaction is not to add a `HasForeignKey` until it goes away. That converts the exception into the `BlogId1` schema above. Find the relationship that is missing its navigation and fix that.

## Case 5: the FK property is not mapped

The third cause in the warning is a property EF Core is not allowed to use:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
public class Post
{
    public int Id { get; set; }
    [NotMapped] public int BlogId { get; set; }
    public Blog Blog { get; set; } = null!;
}
```

The result is a table with only a `BlogId1` column, plus the same 10625 warning. The same thing happens with `modelBuilder.Entity<Post>().Ignore(p => p.BlogId)`. If you want the CLR property to be the FK, remove the ignore. If you want it to be an unmapped helper, rename it so it does not collide with the conventional FK name.

## How to catch accidental shadow FKs before they ship

Reading every migration diff works until it doesn't. Two cheaper guards:

Turn the warning into an exception. Cases 3, 4, and 5 all raise `ShadowForeignKeyPropertyCreated`, and EF Core can be told to throw on it:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
using Microsoft.EntityFrameworkCore.Diagnostics;

protected override void OnConfiguring(DbContextOptionsBuilder options) => options
    .UseSqlite("Data Source=app.db")
    .ConfigureWarnings(w => w.Throw(CoreEventId.ShadowForeignKeyPropertyCreated));
```

Accessing `db.Model` now fails with `An error was generated for warning 'Microsoft.EntityFrameworkCore.Model.Validation.ShadowForeignKeyPropertyCreated'`, and since `dotnet ef migrations add` builds the model too, the bad migration never gets created. Do not do the same for `ShadowPropertyCreated` unless you have zero intentional shadow properties, because it also fires for the harmless Case 1.

Assert on the model in a test. Case 2 never raises a warning, so a unit test that walks the model is the only automatic net:

```csharp
// .NET 11, EF Core 11.0.0-rc.1, xUnit
[Fact]
public void No_unexpected_shadow_foreign_keys()
{
    using var db = new AppDbContext();
    var allowed = new HashSet<string> { "Post.BlogId" };   // the ones you chose on purpose

    var shadowFks = db.Model.GetEntityTypes()
        .SelectMany(e => e.GetProperties())
        .Where(p => p.IsShadowProperty() && p.IsForeignKey())
        .Select(p => $"{p.DeclaringType.ClrType.Name}.{p.Name}")
        .Where(name => !allowed.Contains(name))
        .ToList();

    Assert.Empty(shadowFks);
}
```

`IsShadowProperty()` and `IsForeignKey()` are part of the public metadata API on `IReadOnlyProperty`, so this needs no internal access and no database.

## Using shadow properties on purpose

Once you know what they are, shadow properties are a clean tool for data that belongs in the table but not on the domain object. Audit timestamps are the classic case:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().Property<DateTime>("LastUpdated");
}

public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<Post>()
                 .Where(e => e.State is EntityState.Added or EntityState.Modified))
    {
        entry.Property("LastUpdated").CurrentValue = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

The `Post` class stays free of persistence concerns, and the table gets a `"LastUpdated" TEXT NOT NULL` column (on SQLite). Reading and writing go through the change tracker, `db.Entry(post).Property<DateTime>("LastUpdated").CurrentValue`, and querying goes through `EF.Property`:

```csharp
// .NET 11, EF Core 11.0.0-rc.1
var recent = await db.Posts
    .Where(p => EF.Property<DateTime>(p, "LastUpdated") > DateTime.UtcNow.AddDays(-1))
    .OrderBy(p => EF.Property<DateTime>(p, "LastUpdated"))
    .ToListAsync();
```

which translates to a plain column reference:

```sql
SELECT "p"."Id", "p"."LastUpdated", "p"."Title"
FROM "Posts" AS "p"
WHERE "p"."LastUpdated" > rtrim(rtrim(strftime('%Y-%m-%d %H:%M:%f', 'now', CAST(-1.0 AS TEXT) || ' days'), '0'), '.')
```

For anything more than a single entity, put the stamping logic in a `SaveChangesInterceptor` rather than overriding `SaveChanges` in every context.

## Gotchas worth knowing

- **Shadow values are lost on detach.** The value only exists in the change tracker. Queries with `AsNoTracking()` still return shadow columns in the SQL, but you have no way to read them from the materialized object. Project them explicitly with `EF.Property` in a `Select` if you need them.
- **Shadow FKs and disconnected graphs.** If you attach a `Post` with only a navigation set, EF Core fills the shadow FK from the navigation on `SaveChanges`. If you attach a `Post` with no navigation and no FK property, there is nothing to fill it with, and you must set it through `Entry(...).Property("BlogId").CurrentValue`.
- **Renaming fixes are migrations, not just code.** Fixing Case 2, 3, or 4 changes the schema. EF Core will generate a drop for the shadow column. If production data was written through it, copy it into the real FK column inside the migration before the drop.
- **Indexer properties are the cousin, not the same thing.** Property bags (`Dictionary<string, object>` entity types) use indexer properties, which have a CLR accessor, the indexer. They are not shadow properties, even though they also have no named C# property.

## Related

- If the shadow column first appeared as an unexplained migration, [fixing "the model for context has pending changes" in EF Core 11](/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) covers how the snapshot diff works.
- For the audit pattern done properly, see [using EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).
- To see the `BlogId1` column in the actual SQL EF Core emits, [logging the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) shows every option.
- A required shadow FK with `Cascade` changes delete behavior; [fixing FOREIGN KEY constraint failed on delete](/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/) explains how EF Core picks it.
- If you are renaming FKs anyway, [custom naming conventions for keys, foreign keys, and indexes in EF Core 11](/2026/09/how-to-apply-custom-naming-conventions-for-keys-foreign-keys-and-indexes-in-ef-core-11/) shows how to do it model-wide.

## Sources

- [Shadow and Indexer Properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties), EF Core docs.
- [Foreign and principal keys in relationships](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/foreign-and-principal-keys), EF Core docs, for the FK discovery naming rules.
- [CoreEventId.ShadowForeignKeyPropertyCreated](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.coreeventid.shadowforeignkeypropertycreated), API reference.
- [Microsoft.EntityFrameworkCore 11.0.0-rc.1.26425.128](https://www.nuget.org/packages/Microsoft.EntityFrameworkCore/11.0.0-rc.1.26425.128) on NuGet, the version used for every run in this post.
