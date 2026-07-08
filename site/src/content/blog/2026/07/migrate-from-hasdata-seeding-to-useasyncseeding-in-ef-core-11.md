---
title: "Migrate from HasData seeding to UseAsyncSeeding in EF Core 11"
description: "A step-by-step guide to moving seed data off HasData and onto UseSeeding and UseAsyncSeeding in EF Core 11, including the DeleteData migration trap that wipes your existing rows if you skip it."
pubDate: 2026-07-08
updatedDate: 2026-07-08
template: migration
tags:
  - "migration"
  - "efcore"
  - "dotnet"
---

Moving seed data from `HasData` to `UseSeeding`/`UseAsyncSeeding` in EF Core 11 is a half-day job for a typical app, and the one thing that will bite you is not the new API: it is that deleting a `HasData` call makes the next `dotnet ef migrations add` emit a `DeleteData` statement that removes those exact rows from every database the migration runs against. If you delete the `HasData` and add the `UseSeeding` in the same deployment without thinking about ordering, you can wipe reference data in production. This guide walks the migration in the order that avoids that, using .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0), and C# 14. Budget an afternoon for a medium app, most of it spent auditing which seeds should have moved years ago.

Is it worth it? For anything dynamic, key-generated, computed, or conditional: yes, and it was overdue. For a genuinely static three-row lookup table, leave it on `HasData`. The goal here is not "delete every `HasData`", it is "move the seeds that never belonged in the model."

## Why move off HasData at all

`HasData` bakes your seed data into the model snapshot. That single design fact is the root of every reason to leave:

- **Non-deterministic values generate phantom migrations.** A `DateTime.UtcNow`, a `Guid.NewGuid()`, or a hashed password inside a `HasData` row makes the model diff never match, so EF believes the model changed on every build and either warns with `PendingModelChangesWarning` or spews an endless trickle of no-op migrations. This is the wall most teams hit, often mid-way through a [migration from EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).
- **Database-generated keys are impossible.** `HasData` requires every primary key spelled out by hand. Identity columns and sequences are off the table, so you end up inventing keys and praying they never collide with real inserts.
- **No conditional logic, no navigation graphs, no transforms.** "Seed a demo tenant only in Development" or "insert this object graph through its navigation properties" cannot be expressed in `HasData` at all.
- **The seed is part of your schema diff whether you want it or not.** Every value edit becomes an `UpdateData` in a migration, which is a feature for country codes and a nuisance for anything you would rather manage as code.

The EF team renamed `HasData` to "model-managed data" precisely to discourage its use as a general seeding tool. `UseSeeding` and `UseAsyncSeeding`, introduced in EF Core 9 and current in EF Core 11, are plain application code that runs against a live `DbContext`, with none of those limits. If you are still deciding which seeds to move, the [HasData vs UseSeeding decision matrix](/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) draws the line row by row.

## What breaks

| Area | Change | Severity |
| ---- | ------ | -------- |
| Existing databases | Removing a `HasData` call generates `DeleteData`, which deletes the seeded rows on migration | high |
| Idempotency | `HasData` was diffed automatically; `UseSeeding` runs every time and needs a hand-written existence check | high |
| Two code paths | Tooling calls sync `UseSeeding`, async startup calls `UseAsyncSeeding`; implement only one and the other silently no-ops | high |
| Source control | Seed values leave the migration snapshot and live in startup code; they are no longer captured in the migration history | medium |
| Referential integrity | Data other tables' foreign keys depend on now lands in a startup callback, not inside the migration transaction | medium |
| Test setup | Tests that relied on `HasData` running via `EnsureCreated` still work, but only if both overloads are implemented | low |

The top row is the one that ends up in an incident report. Everything else is mechanical.

## Pre-flight checklist

Before you touch a line of seeding code:

- **Confirm your EF Core version is 9.0 or later.** `UseSeeding`/`UseAsyncSeeding` do not exist before EF Core 9. Run `dotnet list package | findstr EntityFrameworkCore` and confirm 11.0 (or at minimum 9.0).
- **Inventory every `HasData` call.** Grep the codebase: `grep -rn "HasData" .` (or `findstr /s HasData *.cs` on Windows). For each one, decide keep or move using the rule below.
- **Classify each seed.** Keep on `HasData` if the data is small, fixed, deterministic, hand-keyed, and something the schema is meaningless without (order-status enums, ISO country codes). Move to `UseSeeding` if it has database-generated keys, computed or non-deterministic values, conditional logic, navigation properties, or external transforms.
- **Back up production, or rehearse on a restored copy.** You are about to generate a migration that issues `DELETE` statements. Do not discover its behavior in production.
- **Have a staging database that already has the `HasData` rows applied.** You need to see what the removal migration does to a database that was seeded the old way, not just an empty one.

## Migration steps

The order matters. Doing this in the wrong sequence is exactly how you delete production reference data.

### 1. Write the UseSeeding and UseAsyncSeeding callbacks first

Add the new seeding path before you remove anything. Both overloads, identical logic, existence check at the top of each. Factor the body into shared methods so the sync and async versions cannot drift:

```csharp
// Program.cs -- .NET 11, ASP.NET Core 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(builder.Configuration.GetConnectionString("Default"))
        .UseSeeding((context, _) => SeedStatuses(context))
        .UseAsyncSeeding((context, _, ct) => SeedStatusesAsync(context, ct)));

static void SeedStatuses(DbContext context)
{
    string[] required = ["Pending", "Shipped", "Delivered"];
    var existing = context.Set<OrderStatus>()
        .Where(s => required.Contains(s.Name))
        .Select(s => s.Name)
        .ToHashSet();

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new OrderStatus { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<OrderStatus>().AddRange(missing);
        context.SaveChanges();
    }
}

static async Task SeedStatusesAsync(DbContext context, CancellationToken ct)
{
    string[] required = ["Pending", "Shipped", "Delivered"];
    var existing = await context.Set<OrderStatus>()
        .Where(s => required.Contains(s.Name))
        .Select(s => s.Name)
        .ToListAsync(ct);

    var missing = required
        .Where(name => !existing.Contains(name))
        .Select(name => new OrderStatus { Name = name })
        .ToList();

    if (missing.Count > 0)
    {
        context.Set<OrderStatus>().AddRange(missing);
        await context.SaveChangesAsync(ct);
    }
}
```

Note that this version no longer hard-codes `Id`. The database assigns it. That is the whole point: if you were previously assigning keys by hand in `HasData`, existing foreign-key references may point at those specific values, which is what makes step 2 delicate.

**Verify:** run the app against an empty local database with the `HasData` calls still present. It should start cleanly with no duplicate rows. The existence check should make a second startup a no-op (one read query, zero writes).

### 2. Decide how to preserve existing rows before removing HasData

This is the step everyone skips and regrets. When you delete a `HasData` call and run `dotnet ef migrations add`, EF generates a `DeleteData` in the `Up` method for every previously-seeded row:

```csharp
// .NET 11, EF Core 11 -- what removing HasData generates
migrationBuilder.DeleteData(
    table: "OrderStatuses",
    keyColumn: "Id",
    keyValues: new object[] { 1, 2, 3 });
```

On an existing database, that `DELETE` runs. If other tables have foreign keys pointing at those rows, the delete either fails with a `FOREIGN KEY constraint failed` error or, worse, cascades. You have three safe options:

- **A. Keep the keys stable and let the seed re-insert.** If the rows are pure reference data with no incoming foreign keys, letting the migration delete them and having `UseSeeding` re-insert them on the next startup is fine, but the new keys will differ (database-generated), so this is only safe when nothing references the old keys.
- **B. Hand-edit the generated migration to remove the `DeleteData`.** After `dotnet ef migrations add RemoveStatusSeed`, open the generated file and delete the `DeleteData` call (and the matching `InsertData` in `Down`). The rows stay put; only the model snapshot stops tracking them. This is the safest option when foreign keys reference the seeded rows and you want to leave them untouched.
- **C. Preserve keys in the new seeder.** If you must keep the exact key values (because foreign keys depend on them), keep assigning them explicitly in `UseSeeding` and still hand-edit out the `DeleteData`. You lose the database-generated-key benefit for this table, but you keep referential integrity.

For anything with incoming foreign keys, option B is almost always what you want. The rows do not need to move; only the ownership of them does.

**Verify:** after generating the removal migration, read the generated file before applying it. Confirm the `DeleteData` calls target exactly the rows you expect, and that you have chosen and applied A, B, or C for each table.

### 3. Remove the HasData calls from OnModelCreating

Now delete the `HasData` block for the seeds you are moving:

```csharp
// Before -- .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderStatus>().HasData(
        new OrderStatus { Id = 1, Name = "Pending" },
        new OrderStatus { Id = 2, Name = "Shipped" },
        new OrderStatus { Id = 3, Name = "Delivered" });
}

// After -- the HasData block is gone; seeding lives in UseSeeding now
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    // OrderStatus seeding moved to UseSeeding in Program.cs
}
```

**Verify:** the project still compiles, and `dotnet ef migrations has-pending-model-changes` reports a pending change (the removed seed) that you are about to capture.

### 4. Generate and review the removal migration

```bash
# .NET 11, EF Core 11
dotnet ef migrations add RemoveOrderStatusSeed
```

Open the generated migration and apply your decision from step 2. If you chose option B, delete the `DeleteData` from `Up` and the corresponding `InsertData` from `Down`. Leave the model snapshot changes intact; those are correct and necessary.

**Verify:** `dotnet ef migrations script` against your staging database and read the SQL. Confirm no unexpected `DELETE FROM OrderStatuses` survives if you meant to preserve the rows.

### 5. Apply against staging and confirm data survives

```bash
# .NET 11, EF Core 11
dotnet ef database update
```

Then start the app so `UseAsyncSeeding` runs.

**Verify:** query the table. The reference rows are present exactly once. Start the app a second time and confirm no duplicates appeared, which proves the existence check works. If foreign keys reference the rows, confirm those relationships are intact.

## Post-migration smoke test

Run this checklist against staging before you ship:

- `dotnet build` succeeds with no `PendingModelChangesWarning`.
- `dotnet ef migrations has-pending-model-changes` reports nothing pending.
- The app starts via its async path (`await context.Database.MigrateAsync()`) and the seeded rows exist once.
- `dotnet ef database update` on a fresh database also seeds correctly (this exercises the sync `UseSeeding`, which the tooling calls).
- Restarting the app inserts nothing new (idempotency holds).
- Foreign-key relationships that pointed at the old seed keys still resolve.
- No table shows the phantom-migration symptom: adding a fresh migration produces no seed-related `InsertData`/`DeleteData`.

## Rollback plan

This migration is reversible, but read the fine print. If you chose option B (hand-edited the `DeleteData` out), the schema-level `Down` is a no-op for the data, so rolling the migration back leaves the rows in place and simply restores the model snapshot. Re-adding the `HasData` block and generating a new migration returns you to the old world, though EF will want to `InsertData` any rows that are missing.

If you chose option A (let the delete-and-reseed happen), rollback is riskier: the rows now have database-generated keys, so reverting to a `HasData` model that expects fixed keys will mismatch. In that case, do not attempt an in-place rollback of live data. Restore from the backup you took in the pre-flight step. This is why the pre-flight backup is not optional.

## Gotchas we hit

- **The delete cascaded through a foreign key.** An `Order` table referenced `OrderStatus.Id`. The removal migration's `DeleteData` triggered a `FOREIGN KEY constraint failed`, which at least fails loudly. If the relationship had been configured with cascade delete, it would have quietly taken orders with it. Option B (edit out the `DeleteData`) is the fix. See the [FOREIGN KEY constraint failed fix](/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/) for the mechanics of why the delete propagates.
- **Only the async overload was implemented, so `dotnet ef database update` seeded nothing.** The tooling calls the synchronous `UseSeeding`. The app worked in production (async startup path) but CI's `database update` produced an empty lookup table and the integration tests failed. Implement both, always.
- **The existence check queried a `DateTime`, not a key.** Someone wrote the guard as `if (!context.Set<User>().Any(u => u.CreatedAt == seedTime))`. Because `CreatedAt` was `DateTime.UtcNow`, the check never matched and the seeder inserted a new admin on every startup. Guard on a stable natural key (the email, the status name), never on a non-deterministic column. The full pattern is in [how to seed data with UseSeeding and UseAsyncSeeding](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).
- **Seeding on every instance's startup needed write permission everywhere.** `UseSeeding` runs on `Migrate` in every replica. If your production app pods run with read-mostly database permissions, the seed callback throws. For production, prefer a one-shot initialization step at deploy time over per-startup seeding; `UseSeeding` shines for local dev and tests.
- **A partial move left one `HasData` row that other seeds depended on.** Migrating half the seeds meant a startup-callback insert referenced a lookup row that the removal migration had just deleted. Move dependent seeds together, or keep the lookup on `HasData` and only move the dependent data.

If your entities are records, none of this changes: [records work correctly with EF Core 11](/2026/04/how-to-use-records-with-ef-core-11-correctly/) under both `HasData` and `UseSeeding`. And if you are tightening the data layer while you are in here, the same "what runs and when" discipline shows up in [EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/).

## Related

- [HasData vs UseSeeding for seeding data in EF Core 11](/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/)
- [How to seed data with UseSeeding and UseAsyncSeeding in EF Core 11](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)
- [Migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix: FOREIGN KEY constraint failed when deleting an entity in EF Core 11](/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [How to use records with EF Core 11 correctly](/2026/04/how-to-use-records-with-ef-core-11-correctly/)

## Sources

- [Data Seeding - EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)
- [What's New in EF Core 9: UseSeeding and UseAsyncSeeding, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [DbContextOptionsBuilder.UseSeeding, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding)
