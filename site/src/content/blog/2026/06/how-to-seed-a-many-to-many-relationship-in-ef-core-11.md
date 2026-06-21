---
title: "How to seed a many-to-many relationship in EF Core 11"
description: "Seed the join table of a many-to-many relationship in EF Core 11: the implicit shadow keys you must name yourself, the UsingEntity HasData pattern, and the runtime UseSeeding alternative that works with skip navigations."
pubDate: 2026-06-21
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
---

To seed a many-to-many relationship in EF Core 11, you do not seed the skip navigation. You seed the join table directly, because `HasData` cannot populate a navigation. With the default implicit join (no class for the join entity), reach into the relationship with `UsingEntity` and call `HasData` on the join entity, passing anonymous objects whose property names are the shadow foreign keys EF generates -- for a `Post.Tags` / `Tag.Posts` relationship those are `PostsId` and `TagsId`. You must also seed both ends (`Post` and `Tag`) with fixed primary key values, because migration-managed seeding requires every key spelled out by hand. If you would rather seed at runtime against live data, use `UseSeeding`/`UseAsyncSeeding` and load the entities so you can add to the skip navigation normally. This post uses .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0), and C# 14.

The reason this trips so many people is that a many-to-many relationship has no third class in the typical model. You write `Post` with a `List<Tag>` and `Tag` with a `List<Post>`, and EF conjures the join table for you. That convenience evaporates the moment you want seed data, because `HasData` operates on entity types and their keys, and the join "entity" you need to target is invisible in your code.

## Why HasData cannot just seed the navigation

Start with the model everyone actually writes:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Post
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public List<Tag> Tags { get; } = [];
}

public class Tag
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; } = [];
}
```

EF Core maps this by convention to three tables: `Posts`, `Tags`, and a join table named `PostTag` with two columns, `PostsId` and `TagsId`. Those column names are not arbitrary. The shadow foreign key that points back to the `Posts` table is named after the navigation that targets posts (`Tag.Posts`), and likewise `TagsId` comes from `Post.Tags`. You never declared those properties; EF created them as shadow properties on a shared-type entity type it manages for you.

`HasData` is the migration-time seeding mechanism. It works by attaching rows to a specific entity type, computing inserts by diffing against the model snapshot. There is no entity type in your code for the association between a post and a tag, so there is nothing for `HasData` to attach to. You cannot write `post.Tags.Add(tag)` in `OnModelCreating` either: model building configures the shape of the model, it does not run against a `DbContext`, and skip navigations are not populated there. The association lives in the join table, and the join table is what you have to seed.

This is the same family of limitation that makes `HasData` awkward generally: it needs deterministic, explicitly-keyed data and it is owned by migrations rather than your application. If that tradeoff is new to you, the broader picture is in [how to seed data with UseSeeding and UseAsyncSeeding in EF Core 11](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/), which covers when migration-managed `HasData` is the wrong tool entirely.

## Seeding the implicit join with UsingEntity and HasData

The migration-time approach has three parts, and skipping any one of them leaves you with a broken seed. Here is the full procedure.

1. **Seed both principal entity types** with `HasData`, giving every row a fixed primary key. EF will not generate keys for seed data, so you assign them.
2. **Reach into the join entity** with `UsingEntity`, naming the join table explicitly so the configuration is stable.
3. **Call `HasData` on the join entity**, passing anonymous objects whose property names match the shadow foreign keys (`PostsId`, `TagsId`).

Put together, the configuration in `OnModelCreating` looks like this:

```csharp
// .NET 11, EF Core 11, C# 14 -- seeding an implicit (unmapped) join table
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Post>().HasData(
        new Post { Id = 1, Title = "Span<T> in depth" },
        new Post { Id = 2, Title = "EF Core 11 changes" });

    modelBuilder.Entity<Tag>().HasData(
        new Tag { Id = 1, Name = "dotnet" },
        new Tag { Id = 2, Name = "performance" },
        new Tag { Id = 3, Name = "efcore" });

    modelBuilder.Entity<Post>()
        .HasMany(p => p.Tags)
        .WithMany(t => t.Posts)
        .UsingEntity(
            "PostTag",
            r => r.HasOne(typeof(Tag)).WithMany().HasForeignKey("TagsId"),
            l => l.HasOne(typeof(Post)).WithMany().HasForeignKey("PostsId"),
            j => j.HasData(
                new { PostsId = 1, TagsId = 1 },   // "Span<T>" tagged "dotnet"
                new { PostsId = 1, TagsId = 2 },   // "Span<T>" tagged "performance"
                new { PostsId = 2, TagsId = 1 },   // "EF Core 11" tagged "dotnet"
                new { PostsId = 2, TagsId = 3 })); // "EF Core 11" tagged "efcore"
}
```

The property names in the anonymous objects are the contract here. They must be exactly `PostsId` and `TagsId`, matching the shadow foreign keys EF declared. Misspell one, pluralize it differently, or use the singular `PostId` and migration generation throws `The seed entity for entity type 'PostTag' cannot be added because the value 'PostId' is not present`, because that property does not exist on the join entity.

Run `dotnet ef migrations add SeedPostTags` and the generated migration inserts the posts, the tags, and four rows into `PostTag`. From then on, every `dotnet ef database update` applies that data once, and EF tracks it in the model snapshot so it knows not to re-insert.

You can name the join entity without naming the table by passing only the lambda configuration, but I recommend always passing the explicit `"PostTag"` name string. The default name is derived from your type names, and if you ever rename `Post` to `Article`, an unnamed join silently renames the table and orphans your existing data. Pinning the name makes the rename a deliberate, reviewable change.

## When you have a join class with a payload

If your join table carries extra columns -- a `CreatedOn` timestamp, a sort order, a "primary tag" flag -- you will have a real class for it, and the foreign keys follow the singular convention `PostId` / `TagId` rather than the doubled `PostsId` / `TagsId` of the implicit case. That difference catches people who graduate from an implicit join to an explicit one.

```csharp
// .NET 11, EF Core 11, C# 14 -- join entity with payload
public class PostTag
{
    public int PostId { get; set; }
    public int TagId { get; set; }
    public DateTime TaggedOn { get; set; }
}
```

Now you seed the join entity the same way you seed any entity, because it is a normal entity type:

```csharp
modelBuilder.Entity<Post>()
    .HasMany(p => p.Tags)
    .WithMany(t => t.Posts)
    .UsingEntity<PostTag>();

modelBuilder.Entity<PostTag>().HasData(
    new PostTag { PostId = 1, TagId = 1, TaggedOn = new DateTime(2026, 6, 1) },
    new PostTag { PostId = 1, TagId = 2, TaggedOn = new DateTime(2026, 6, 1) },
    new PostTag { PostId = 2, TagId = 3, TaggedOn = new DateTime(2026, 6, 2) });
```

Note the `DateTime` is a hardcoded constant, not `DateTime.UtcNow`. Seed data must be deterministic: a value that changes on every build makes the model look modified, and EF emits a `PendingModelChangesWarning` and wants to scaffold a new migration every time. This is one of the rough edges that bites during a [migration from EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/), where stricter model-change detection turns yesterday's silent re-seed into a build warning. If you need an insertion timestamp, configure a database default with `HasDefaultValueSql("GETUTCDATE()")` on the property and leave it out of the seed object entirely.

## A caveat about the implicit join type

The EF team is explicit about this in the docs: the implicit join entity is currently represented by `Dictionary<string, object>`, but you must not depend on that. A future EF Core release may change the runtime type for performance. This matters for seeding in one practical way. Do not try to seed by constructing a `Dictionary<string, object>` yourself or by referencing the type directly. Stick to the anonymous-object form inside `UsingEntity(...).HasData(...)`. The anonymous object is matched by property name against the join entity's properties, so it is insulated from whatever concrete CLR type EF uses under the hood.

If you find yourself wanting to reference the join type, that is the signal to promote it to a real class as in the previous section. A named class is the supported way to get a stable, referenceable join entity, and it makes seeding, querying, and adding payload columns straightforward.

## Seeding at runtime with UseSeeding instead

Migration-managed `HasData` is the right tool for small, fixed reference associations that ship with your schema -- a known set of system tags wired to known posts. It is the wrong tool for anything dynamic, anything keyed by the database, or anything you would rather express as "add this tag to this post" against live objects. For that, seed at runtime with `UseSeeding` and `UseAsyncSeeding`, where you have a real `DbContext` and can use the skip navigation the way it was meant to be used.

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedPostTags(context))
        .UseAsyncSeeding(async (context, _, ct) => await SeedPostTagsAsync(context, ct)));

static void SeedPostTags(DbContext context)
{
    var post = context.Set<Post>()
        .Include(p => p.Tags)
        .FirstOrDefault(p => p.Title == "EF Core 11 changes");
    if (post is null) return;

    var efcore = context.Set<Tag>().FirstOrDefault(t => t.Name == "efcore");
    if (efcore is not null && !post.Tags.Any(t => t.Id == efcore.Id))
    {
        post.Tags.Add(efcore);   // EF inserts the join row for you
        context.SaveChanges();
    }
}

static async Task SeedPostTagsAsync(DbContext context, CancellationToken ct)
{
    var post = await context.Set<Post>()
        .Include(p => p.Tags)
        .FirstOrDefaultAsync(p => p.Title == "EF Core 11 changes", ct);
    if (post is null) return;

    var efcore = await context.Set<Tag>().FirstOrDefaultAsync(t => t.Name == "efcore", ct);
    if (efcore is not null && !post.Tags.Any(t => t.Id == efcore.Id))
    {
        post.Tags.Add(efcore);
        await context.SaveChangesAsync(ct);
    }
}
```

Two things to notice. First, you `Include(p => p.Tags)` so the existing associations are loaded; without that, the `!post.Tags.Any(...)` guard sees an empty collection and you risk a duplicate-key insert on the join table. Second, the existence check is mandatory, because these callbacks run on every `Migrate`, `EnsureCreated`, or `dotnet ef database update`, not just the first. Add the tag unconditionally and you will hit a primary-key violation on `PostTag` the second time the seeder runs. The full rules for when these callbacks fire, and why you have to implement both the sync and async overloads, are in the [UseSeeding deep dive](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).

The payoff is that `post.Tags.Add(efcore)` is the natural API. EF's change tracker sees a new entry in the skip navigation and emits the join-table insert itself. You never name `PostsId` or `TagsId`, you never construct an anonymous object, and the code reads like the rest of your application. The cost is that this runs at startup against a live database rather than being baked into a migration, so it is best for development, tests, and idempotent reference data rather than production schema-versioned data.

## Mistakes that produce confusing errors

A few failure modes recur, and the error messages do not always point at the real cause.

Seeding only the join rows and forgetting to seed the principals gives you a foreign-key violation at `database update` time, because `PostsId = 1` references a `Posts` row that does not exist. Always seed both ends with the same fixed keys you reference in the join.

Using the wrong shadow-key names -- `PostId` instead of `PostsId` for the implicit join -- fails at migration scaffolding with a message about a property that is not present on the join entity. The doubled form (`PostsId`, `TagsId`) is for the implicit, unmapped join; the singular form (`PostId`, `TagId`) is for an explicit join class. They are not interchangeable.

Letting a payload column default to a non-deterministic value such as `DateTime.UtcNow` in the seed object produces an endless stream of "model changed" migrations. Hardcode the value or push it to a database default.

Finally, if your principal entity has no key defined at all -- a keyless or misconfigured type -- the seed never gets that far; you will see [the entity type requires a primary key to be defined](/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) first. Fix the model before you worry about the seed data.

The decision between the two approaches comes down to ownership. If the associations are part of your schema's identity and should travel inside migrations, seed the join entity with `UsingEntity(...).HasData(...)` and accept the hand-keyed bookkeeping. If they are runtime data you would rather express against live objects, use `UseSeeding` and add to the skip navigation. Most real applications end up using `HasData` for a handful of system associations and `UseSeeding` for everything else, and that split is exactly what the EF team designed the two mechanisms to cover.

Sources: the EF Core [many-to-many relationships documentation](https://learn.microsoft.com/en-us/ef/core/modeling/relationships/many-to-many) on Microsoft Learn details the implicit join, the `PostsId`/`TagsId` shadow keys, the `UsingEntity` overloads, and the warning against depending on `Dictionary<string, object>`; the EF Core [data seeding documentation](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding) covers `HasData` versus `UseSeeding`/`UseAsyncSeeding` and the determinism requirement; the GitHub discussion in [dotnet/efcore#23363](https://github.com/dotnet/efcore/issues/23363) shows the community-confirmed `UsingEntity(...).HasData(...)` pattern for seeding the join table.
