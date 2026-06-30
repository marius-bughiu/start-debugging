---
title: "HasData vs UseSeeding for seeding data in EF Core 11: which should you use?"
description: "Use HasData only for fixed, model-owned reference data. Use UseSeeding and UseAsyncSeeding for everything else in EF Core 11. A side-by-side comparison with the rules that force the decision."
pubDate: 2026-06-30
template: vs
tags:
  - "comparison"
  - "efcore"
  - "dotnet"
---

For seeding data in EF Core 11, use `HasData` only for small, fixed, deterministic reference tables that you want versioned inside your migrations (country codes, currencies, enum-like lookup rows). Use `UseSeeding` and `UseAsyncSeeding` for everything else: anything with database-generated keys, computed or non-deterministic values, conditional logic, navigation properties, or rows that depend on what is already in the database. The EF team renamed `HasData` to "model-managed data" precisely to discourage using it as a general seeding tool. This post uses .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0), and C# 14.

If you only remember one line: `HasData` participates in the model and the migration diff, `UseSeeding` runs as ordinary code against a live `DbContext`. Almost every painful seeding bug comes from picking the first when you needed the second.

## The feature matrix

This is the table you came for. Every row is a real constraint, not a vibe.

| Feature                          | `HasData` (model-managed data) | `UseSeeding` / `UseAsyncSeeding` |
| -------------------------------- | ------------------------------ | -------------------------------- |
| Configured on                    | `OnModelCreating` (the model)  | `DbContextOptionsBuilder`        |
| When it runs                     | Inside migration SQL (`InsertData`) | On `Migrate`/`EnsureCreated` and `dotnet ef database update` |
| Primary keys                     | Must be specified by hand      | Database-generated keys are fine |
| Non-deterministic values         | Forbidden (re-diffs every build) | Allowed (`Guid.NewGuid()`, `DateTime.UtcNow`) |
| Navigation properties            | No, foreign keys only          | Yes, full graph inserts          |
| Conditional logic                | No                             | Yes, you write the `if`          |
| External calls / transforms      | No                             | Yes (hashing, HTTP, file reads)  |
| Idempotency                      | Automatic (diffed by EF)       | You write the existence check    |
| Captured in source control       | Yes, in the migration snapshot | No, it is startup code           |
| Updates existing rows            | Yes, via migration diff        | Only if you write the update     |
| Available since                  | EF Core 1.0 (was `HasData`)    | EF Core 9, current in EF Core 11 |

The single most important row is "non-deterministic values". `HasData` is compared against the model snapshot on every build, so a `DateTime.UtcNow` or `Guid.NewGuid()` in your seed makes the model look changed every time, and EF throws `PendingModelChangesWarning` or generates an endless trickle of pointless migrations. That is the wall most people hit, usually during a [migration from EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## When to pick HasData

`HasData` is the right tool when the data is genuinely part of your schema's meaning. The mental test: would you be comfortable hard-coding these rows in a constant, and will they almost never change?

- **Fixed lookup tables.** ISO country codes, currency codes, US states, order-status enums backed by a table. The keys are stable, you assign them yourself, and you want the values to ship and version with the schema. In EF Core 11 you configure it in `OnModelCreating`:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderStatus>().HasData(
        new OrderStatus { Id = 1, Name = "Pending" },
        new OrderStatus { Id = 2, Name = "Shipped" },
        new OrderStatus { Id = 3, Name = "Delivered" });
}
```

- **Data you want diffed and migrated automatically.** Change `"Shipped"` to `"Dispatched"` and the next `dotnet ef migrations add` emits an `UpdateData` call. You get versioned, reviewable, auditable changes to the seed in the same place as the schema. That is a real advantage `UseSeeding` does not give you for free.

- **Data the schema is meaningless without.** If a foreign key in another table points at `OrderStatus.Id = 2` and the row is missing, your app is broken. Baking it into the migration guarantees it lands in lockstep with the schema, inside the same transaction.

The keys must be set explicitly and the values must be deterministic. No `Guid.NewGuid()`, no `DateTime.Now`, no navigation properties (set the foreign key column directly). Break any of those and `HasData` will fight you on every build.

## When to pick UseSeeding and UseAsyncSeeding

`UseSeeding` is the recommended general-purpose mechanism in EF Core 11. It is plain application code with a live `DbContext`, so the limits of `HasData` simply do not exist. Reach for it whenever any of these is true:

- **The database generates the key.** Identity columns, sequences, `newsequentialid()`: with `HasData` you would have to invent keys by hand and pray they never collide with real inserts. `UseSeeding` lets the database assign them.

- **The value is computed or non-deterministic.** Hashing a default admin password, stamping `CreatedAt = DateTime.UtcNow`, generating a `Guid` token. None of this survives the model diff, so it has to run at execution time:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .UseAsyncSeeding(async (context, _, ct) =>
        {
            if (!await context.Set<User>().AnyAsync(u => u.Email == "admin@example.com", ct))
            {
                context.Set<User>().Add(new User
                {
                    Email = "admin@example.com",
                    PasswordHash = PasswordHasher.Hash("change-me"), // runtime transform
                    CreatedAt = DateTime.UtcNow                        // non-deterministic
                });
                await context.SaveChangesAsync(ct);
            }
        })
        .UseSeeding((context, _) =>
        {
            if (!context.Set<User>().Any(u => u.Email == "admin@example.com"))
            {
                context.Set<User>().Add(new User
                {
                    Email = "admin@example.com",
                    PasswordHash = PasswordHasher.Hash("change-me"),
                    CreatedAt = DateTime.UtcNow
                });
                context.SaveChanges();
            }
        }));
```

- **You need conditional or data-dependent logic.** "Seed a demo tenant only in `Development`", or "only insert these rows if the table is empty". That is an ordinary `if`, which `HasData` cannot express at all.

- **You are inserting an object graph through navigation properties.** A blog with three posts, an order with line items, or [a many-to-many relationship](/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/). With `UseSeeding` you build the graph in C# and let `SaveChanges` figure out the foreign keys. With `HasData` you would hand-wire every join row.

The catch is the one most people miss: you have to implement **both** overloads, and the existence check is on you. EF Core tooling (`dotnet ef database update`) only calls the synchronous `UseSeeding`; your runtime path calls `UseAsyncSeeding`. Implement one and not the other and seeding silently does nothing from whichever path you forgot. For the full mechanics, see [how to seed data with UseSeeding and UseAsyncSeeding](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).

## What actually happens on disk

The clearest way to see the difference is to look at what each one produces.

`HasData` materializes into your migration. After `dotnet ef migrations add SeedStatuses`, the generated `Up` method contains literal SQL-shaped calls:

```csharp
// .NET 11, EF Core 11 generated migration
migrationBuilder.InsertData(
    table: "OrderStatuses",
    columns: new[] { "Id", "Name" },
    values: new object[,]
    {
        { 1, "Pending" },
        { 2, "Shipped" },
        { 3, "Delivered" }
    });
```

The data is now a versioned artifact. It runs once, inside the migration's transaction, and EF tracks it in the model snapshot so a later edit produces an `UpdateData`. That is exactly why a non-deterministic value is poison here: the snapshot would never match, so EF would believe the model changed on every single build.

`UseSeeding` produces nothing on disk. It is a callback that fires after the schema is up to date, on every `Migrate`, `EnsureCreated`, or `dotnet ef database update`, including runs where no migration was applied. Because it runs unconditionally, the existence check is not optional housekeeping, it is the only thing standing between you and duplicate rows. EF Core 11 does protect the callback with the same migration locking mechanism it uses for migrations, so two app instances starting at once will not both run the seed concurrently, but locking does not make a missing `if` idempotent.

## The gotcha that picks for you

A few constraints override preference entirely. If any of these applies, the decision is made for you:

- **Database-generated keys force `UseSeeding`.** If you cannot or will not hard-code primary keys, `HasData` is off the table. It has no way to seed a row whose key the database assigns.

- **Non-deterministic or computed values force `UseSeeding`.** A hashed password, a timestamp, a random token: the moment one appears, `HasData` turns every build into a phantom migration. This is the most common reason teams rip `HasData` out.

- **A fixed enum-table that other rows point at favors `HasData`.** When referential integrity depends on the seed existing before any real data, you want it inside the migration transaction, not in a startup callback that could throw and leave the schema half-seeded.

- **A required, database-generated key with a `HasData` row triggers an error.** If you try to seed an entity through `HasData` without supplying its key, EF throws `The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'`. That error is EF telling you that you picked the wrong mechanism: see [the fix for that exact message](/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/).

You can absolutely use both in one app. A common, healthy split: `HasData` for the three lookup tables your schema cannot function without, and `UseSeeding` for the demo data, the default admin, and anything tenant-specific. They do not conflict, because they run at different stages.

## The recommendation, restated

Default to `UseSeeding` and `UseAsyncSeeding` in EF Core 11. They are the recommended mechanism, they handle the dynamic, key-generated, conditional data that real applications actually seed, and they fail loudly instead of silently corrupting your migration history. Reserve `HasData` for the narrow case it was renamed to serve: small, fixed, deterministic reference data with hand-assigned keys that you genuinely want versioned and diffed alongside your schema.

The trap to avoid is the historical default. For years `HasData` was the only built-in option, so codebases reached for it reflexively and then drowned in phantom migrations and `PendingModelChangesWarning`. If you are starting fresh on EF Core 11, invert that instinct: `UseSeeding` first, `HasData` only when you can name why the data belongs in the model. If you maintain `records`-based entities, the same split applies cleanly, since [records work fine with EF Core 11](/2026/04/how-to-use-records-with-ef-core-11-correctly/) under both mechanisms.

## Related

- [How to seed data with UseSeeding and UseAsyncSeeding in EF Core 11](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)
- [How to seed a many-to-many relationship in EF Core 11](/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [Fix: the seed entity cannot be added because a non-zero value is required for property Id](/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/)
- [Migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/)

## Sources

- [Data Seeding - EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)
- [What's New in EF Core 9: UseSeeding and UseAsyncSeeding, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [DbContextOptionsBuilder.UseSeeding, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding)
