---
title: "How to use records with EF Core 11 correctly"
description: "A practical guide to mixing C# records and EF Core 11. Where records fit, where they break change tracking, and how to model value objects, entities, and projections without fighting the framework."
pubDate: 2026-04-21
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "records"
  - "dotnet-11"
  - "how-to"
---

Short answer: on EF Core 11 and C# 14, use `record class` types for projections, DTOs, and complex types (value objects), and prefer a plain `class` with init-only properties and a binding constructor for tracked entities. `record struct` is fine as a complex type but never as a tracked entity. The friction people hit almost always comes from trying to use positional records as full entities and then being surprised when `with` expressions, value equality, or read-only primary keys collide with EF Core's identity tracking. The fix is not a setting, it is knowing which shape of record belongs in which seat.

This post covers the three seats (entity, complex type, projection), shows the constructor-binding rules that actually ship in EF Core 11, and walks through the specific gotchas that trip people up: store-generated keys, the `with` expression, navigation properties, value-equality pitfalls, and JSON-mapped records.

## Why records and EF Core have a reputation for fighting

C# records were designed to make immutable, value-equal data types easy. Two instances of a `record Address(string City, string Zip)` are equal when their fields are equal, not when they are the same reference. That is exactly the right semantic for a value object.

EF Core's change tracker is built on the opposite assumption. The [ChangeTracker](https://learn.microsoft.com/en-us/ef/core/change-tracking/) stores a snapshot of each entity's property values when the entity is first attached, and [identity resolution](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution) says that within a single `DbContext` there is exactly one CLR instance per primary key. Both rely on reference identity, not value identity. If you stamp a `record` with a primary key and then mutate it by producing a new instance via `with`, you now have two CLR references that compare equal but are not the same tracked entity. The change tracker either throws because the PK is already tracked, or silently ignores your edits.

The official C# documentation has stated for years that "record types aren't appropriate for use as entity types in Entity Framework Core." That warning is a blunt summary of the situation above, not a hard prohibition. You can use records as entities, and EF Core 11 still supports every mechanism needed to do so. You just have to pick the non-positional, init-only shape and play by the constructor-binding rules in [the EF Core constructor docs](https://learn.microsoft.com/en-us/ef/core/modeling/constructors).

## Seat 1: records as complex types (the sweet spot)

EF Core 8 introduced `ComplexProperty`, and EF Core 11 made complex types stable enough to recommend as the default replacement for owned entities in most cases. Complex types are exactly where records shine: a complex type has no identity of its own, its value equality lines up with the database semantics, and it is meant to be replaced wholesale when any field changes.

```csharp
// .NET 11, C# 14, EF Core 11
public record Address(string Street, string City, string PostalCode);

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public Address ShippingAddress { get; set; } = new("", "", "");
    public Address BillingAddress { get; set; } = new("", "", "");
}

// OnModelCreating
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress);
    b.ComplexProperty(c => c.BillingAddress);
});
```

What makes this work:

- `Address` is a positional `record class`. EF Core maps positional records out of the box for complex types because the primary constructor matches the property names one-to-one.
- `Address` does not need its own primary key, because complex types do not have identity.
- Replacing a customer's `ShippingAddress` with `customer.ShippingAddress = customer.ShippingAddress with { City = "Cluj" };` updates the tracked entity the way you expect. EF Core sees the `Customer` snapshot diverge from its previous values and marks the three mapped columns dirty.

If you need a value type, a `record struct` is also valid for a complex property and avoids the extra heap allocation per row. The trade-off is the usual one: larger field sets hurt on copy, and you lose the ability to add a parameterless constructor for EF conventions without going out of your way.

```csharp
// .NET 11, C# 14
public readonly record struct Money(decimal Amount, string Currency);
```

Use `record struct` for small, fixed-shape values (money, coordinates, date ranges). Use `record class` for everything else.

## Seat 2: records as entities (works, but needs discipline)

If you want an immutable-looking entity, the shape that survives change tracking is a `record class` with **non-positional** init-only properties and a binding constructor that EF Core can call during materialization.

```csharp
// .NET 11, C# 14, EF Core 11
public record class BlogPost
{
    // EF binds to this ctor during materialization
    public BlogPost(int id, string title, DateTime publishedAt)
    {
        Id = id;
        Title = title;
        PublishedAt = publishedAt;
    }

    // Parameterless ctor lets EF (and serializers) create instances
    // before setting properties one at a time when needed.
    private BlogPost() { }

    public int Id { get; init; }
    public string Title { get; init; } = "";
    public DateTime PublishedAt { get; init; }

    // Navigation props cannot be bound via constructor.
    public List<Comment> Comments { get; init; } = new();
}
```

The rules from [the constructor-binding docs](https://learn.microsoft.com/en-us/ef/core/modeling/constructors), applied to records:

1. If EF Core finds a constructor whose parameter names and types match mapped properties, it uses that constructor during materialization. Pascal-cased properties can match camel-cased parameters.
2. Navigation properties (collections, references) cannot be bound through the constructor. Keep them out of the primary constructor and initialize them with a default.
3. Properties without any setter are not mapped by convention. `init` counts as a setter, so init-only properties are mapped. A property declared as `public string Title { get; }` with no setter at all is treated as a computed property and skipped.
4. Store-generated keys need a writable key. `init` is writable at object-initialization time, which is when EF Core sets it, so `int Id { get; init; }` works for store-generated identity columns.

Why not use a positional record for the entity itself? Two reasons.

First, a positional record has an **implicit compiler-generated property set** with `init` setters, but it also has a protected `<Clone>$` method and a copy constructor that `with` expressions use. The moment you call `post with { Title = "New title" }`, you get a brand new `BlogPost` instance that has the same primary key as the tracked one. If you try to `context.Update(newPost)` you will hit `InvalidOperationException: The instance of entity type 'BlogPost' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked.` Identity resolution is doing its job; you gave it two references to what it thinks is the same row.

Second, positional records generate a value-based `Equals` and `GetHashCode`. EF Core's change tracker, relationship fixup, and `DbSet.Find` all lean on reference identity. Value equality does not break these outright, but it creates surprising behaviors: two freshly loaded entities from different queries can hash-equal while being different tracked instances, and `HashSet<BlogPost>` collapses them. Keep value equality away from anything that has an identity.

A record class with explicit properties, as above, avoids both pitfalls. You get the immutability and the nice `ToString`, and you give up `with`-based mutation (which is the feature you did not want on a tracked entity anyway).

### Updating an immutable-style entity

Because the entity is "immutable," the update path cannot be "mutate, then SaveChanges." The two workable patterns on EF Core 11:

```csharp
// .NET 11, EF Core 11
// Pattern A: load, assign to a local with init setters cleared.
// Requires exposing init setters on the class.
var post = await db.BlogPosts.SingleAsync(p => p.Id == id);

// This mutates the tracked instance. Works because 'init' is
// a settable accessor from EF Core's point of view, and nothing
// stops you from assigning through reflection or source-gen.
// If you want real immutability, use Pattern B.
db.Entry(post).Property(p => p.Title).CurrentValue = "New title";
await db.SaveChangesAsync();

// Pattern B: detach the old, attach a freshly-constructed one,
// mark the touched columns modified. No 'with' expression.
var updated = new BlogPost(post.Id, "New title", post.PublishedAt);
db.Entry(post).State = EntityState.Detached;
db.Attach(updated);
db.Entry(updated).Property(p => p.Title).IsModified = true;
await db.SaveChangesAsync();
```

Pattern A is what most teams end up with: they use records for the ergonomic `ToString`, deconstruction, and per-field equality on reads, and accept that the write path goes through the change tracker mutating the init properties via EF Core's metadata. That is not a violation of immutability at the language level, it is just how EF Core binds properties. There is a long-running EF Core issue tracking first-class support for immutable updates ([efcore#11457](https://github.com/dotnet/efcore/issues/11457)) if you want the full story.

## Seat 3: records as projections and DTOs (always safe)

Any time a record is materialized outside the change tracker, none of the above issues apply. Record projections are the most boring and the most useful pattern:

```csharp
// .NET 11, C# 14, EF Core 11
public record PostSummary(int Id, string Title, DateTime PublishedAt);

// No tracking, no identity, no ChangeTracker snapshot.
var summaries = await db.BlogPosts
    .AsNoTracking()
    .Select(p => new PostSummary(p.Id, p.Title, p.PublishedAt))
    .ToListAsync();
```

EF Core 11's query pipeline happily binds to positional records in projections. You can ship these straight out of a web API with `System.Text.Json`, which has supported record serialization since .NET 5 and positional-record deserialization since .NET 7.

The same argument applies to input DTOs on commands: accept a positional record from the controller, validate it, map it to the entity shape above, and let EF Core track the entity. Keeping the wire type (record) separate from the persistence type (class with init) removes the whole category of bugs this post is about.

For more on records as return shapes, see the [decision matrix at the end of the multiple-values post](/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/).

## Store-generated keys and init-only properties

This is the single most common place people get stuck. If `Id` is declared as `public int Id { get; }` with no setter, EF Core will not map it, and migrations will complain about a missing key. If it is `public int Id { get; init; }`, it is mapped and writable during object initialization, which is exactly when EF Core sets the value it read from the database.

For inserts, EF Core also needs to write the generated value back to the entity after `SaveChanges`. It does this through the property's setter, which for init-only properties still works because EF Core uses property-access metadata rather than the public C# syntax. Confirmed as of EF Core 11; this has been stable since EF Core 5.

What does not work: `public int Id { get; } = GetNextId();` with a field initializer and no setter. EF Core sees no setter, does not map the property, and you get either a missing-key build error or an unintended shadow key.

## The `with` expression is a foot-gun on tracked entities

When the entity is a `record` (positional or not) with a primary-constructor copy, `with` produces a clone that compares equal to the original but is a different CLR reference. EF Core treats it as "same key, different instance," which triggers identity resolution. The safe rule:

```csharp
// .NET 11, EF Core 11
// BAD: creates a second instance with the same PK.
var edited = post with { Title = "New" };
db.Update(edited); // throws InvalidOperationException on SaveChanges

// GOOD: mutate the tracked instance.
post.Title = "New"; // via init (within EF) or a regular setter
await db.SaveChangesAsync();
```

If you genuinely want "detach, clone, re-attach" semantics, go through `db.Entry(post).State = EntityState.Detached;` first, then attach the clone and mark properties as `IsModified`. Most of the time you do not want that. You want Pattern A from the previous section.

Complex types do not have this problem. A `with` on an `Address` inside a `Customer` produces a new value, you assign it back to `customer.ShippingAddress`, and EF Core compares field by field against the snapshot. That is the whole point of complex types.

## Value equality vs identity in hot paths

If you insist on a positional-record entity, remember that value equality leaks into every collection backed by `GetHashCode`. A `HashSet<BlogPost>` will collapse two "different entities with the same data." A dictionary keyed on the entity will behave unpredictably if two different PKs happen to contain the same payload. The standard workaround is to override `Equals` and `GetHashCode` on the record to key off the primary key alone, which defeats the whole reason you chose a record in the first place.

The change tracker itself, as of EF Core 11, still uses reference identity internally. You can check [the change-tracking source](https://github.com/dotnet/efcore) for the details, but the short version is: EF Core does not accidentally "merge" two entities just because they are value-equal. It does, however, surface that merging through `DbSet.Find`, `FirstOrDefault` on a tracked query, and relationship fixup, which is why teams still see weird behavior they cannot immediately explain.

Again, the fix is not to argue with the runtime. It is to keep value equality on value types (complex types, DTOs) and leave entity types with default reference equality.

## JSON columns and records

EF Core 7 added JSON column mapping, and EF Core 11 extends it further with [JSON_CONTAINS translation on SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) and complex types inside JSON documents. Positional records are an ergonomic fit for owned JSON types:

```csharp
// .NET 11, C# 14, EF Core 11
public record TagSet(List<string> Tags, DateTime UpdatedAt);

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public TagSet Metadata { get; set; } = new(new(), DateTime.UtcNow);
}

// OnModelCreating
modelBuilder.Entity<Article>()
    .OwnsOne(a => a.Metadata, b => b.ToJson());
```

The record is a complex property stored as JSON. You replace it wholesale via `article.Metadata = article.Metadata with { Tags = [..article.Metadata.Tags, "net11"] };` and EF Core serializes the whole subtree on `SaveChanges`. No identity tracking, no `with`-vs-mutation debate.

## Putting it together

A realistic domain, end to end:

```csharp
// .NET 11, C# 14, EF Core 11
// Complex types (records)
public record Address(string Street, string City, string PostalCode);
public readonly record struct Money(decimal Amount, string Currency);

// Entity (class with init-only properties + binding ctor)
public class Order
{
    public Order(int id, string customerName, Money total, Address shipTo)
    {
        Id = id;
        CustomerName = customerName;
        Total = total;
        ShipTo = shipTo;
    }

    private Order() { } // EF fallback

    public int Id { get; init; }
    public string CustomerName { get; init; } = "";
    public Money Total { get; init; }
    public Address ShipTo { get; init; } = new("", "", "");

    public List<OrderLine> Lines { get; init; } = new();
}

// Projection/DTO (positional record)
public record OrderSummary(int Id, string CustomerName, decimal Total);

// Input command (positional record, validated before mapping)
public record CreateOrder(string CustomerName, Money Total, Address ShipTo);
```

That is the whole rule of thumb: classes for things with identity, records for things that are defined by their data. EF Core 11's constructor binding, complex-type mapping, and JSON mapping all support this split without any extra configuration beyond `ComplexProperty` or `OwnsOne(..ToJson())` where appropriate.

## Related reading

- [EF Core 11 adds GetEntriesForState to skip DetectChanges](/2026/04/efcore-11-changetracker-getentriesforstate/) covers the change tracker internals this post leans on.
- [EF Core 11 prunes unnecessary reference joins in split queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) is a good companion if your entities lean heavily on navigations.
- [EF Core 11 translates Contains to JSON_CONTAINS on SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) ties into the JSON-mapped-record pattern above.
- [How to return multiple values from a method in C# 14](/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) goes deeper on when records win over tuples and classes at the method-return level.

## Sources

- [EF Core constructors and property binding](https://learn.microsoft.com/en-us/ef/core/modeling/constructors)
- [EF Core change tracking overview](https://learn.microsoft.com/en-us/ef/core/change-tracking/)
- [EF Core identity resolution](https://learn.microsoft.com/en-us/ef/core/change-tracking/identity-resolution)
- [What's new in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [C# record types reference](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/types/records)
- [Support immutable entity updates (efcore#11457)](https://github.com/dotnet/efcore/issues/11457)
- [Document record types as entities (EntityFramework.Docs#4438)](https://github.com/dotnet/EntityFramework.Docs/issues/4438)
