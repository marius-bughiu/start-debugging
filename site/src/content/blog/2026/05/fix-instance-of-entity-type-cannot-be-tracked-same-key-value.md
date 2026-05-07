---
title: "Fix: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"
description: "EF Core 11 throws when two objects share a primary key inside one DbContext. Detach the old one or update it in place. AsNoTracking on the read prevents the collision."
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "change-tracker"
---

The fix: a `DbContext` already has an entity with this primary key in its change tracker, and you handed it a second instance with the same key. Either update the tracked instance in place with `SetValues`, detach it before attaching yours, or read with `AsNoTracking` so nothing got tracked in the first place. Long-lived contexts and "load then `Update(newDto)`" patterns are the usual culprits.

```text
System.InvalidOperationException: The instance of entity type 'Customer' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked. When attaching existing entities, ensure that only one entity instance with a given key value is attached. Consider using 'DbContextOptions.EnableSensitiveDataLogging' to see the conflicting key values.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.ThrowIdentityConflict(InternalEntityEntry entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.Add(...)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.StateManager.StartTracking(...)
   at Microsoft.EntityFrameworkCore.DbContext.SetEntityState(...)
   at Microsoft.EntityFrameworkCore.DbContext.Update[TEntity](TEntity entity)
```

This guide is written against .NET 11 preview 4 and `Microsoft.EntityFrameworkCore` 11.0.0-preview.4. The behaviour has been identical since EF Core 2.0; only the stack-trace internals shift between releases. The exception comes from the `IdentityMap<T>` invariant: a `DbContext` keeps at most one tracked instance per `(EntityType, PrimaryKey)` pair, and any second instance is rejected on the spot.

## Why the identity map exists

EF Core's change tracker is built around a single rule: for each entity type, every primary-key value maps to at most one CLR object. That rule is what lets `SaveChanges` decide whether a row is `Added`, `Modified`, or `Unchanged` without ambiguity, and what makes navigation fix-up work when you load related data in pieces. Two objects with the same key would mean two competing answers for "what is the current state of customer 42?", so the change tracker refuses to take the second one. The exception you are looking at is that refusal, and it is raised before your `SaveChanges` call ever runs, the moment the `DbContext` notices the conflict during `Attach`, `Update`, `Add`, or any operation that walks a graph.

## A minimal repro

The failure mode is almost always shaped like this: an HTTP handler reads an entity to validate a request, then re-creates the same entity from a DTO and asks EF Core to update it.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public record CustomerDto(int Id, string Name, string Email);

public class CustomersController(AppDb db) : ControllerBase
{
    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, CustomerDto dto)
    {
        var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
        if (existing is null) return NotFound();

        var updated = new Customer
        {
            Id = dto.Id,
            Name = dto.Name,
            Email = dto.Email
        };

        db.Update(updated); // throws: id is already tracked from the read above
        await db.SaveChangesAsync();
        return NoContent();
    }
}
```

The first `FirstOrDefaultAsync` call attaches `existing` (id 42) in `Unchanged` state. `db.Update(updated)` then tries to attach a different CLR object with id 42. The change tracker rejects it. The exception text mentions "another instance with the same key value" which is precise but easy to misread on a tired afternoon: the "two instances" are the one EF Core already knows about and the one you are handing it now.

## Three fixes, ranked

Run them in this order. The first two avoid the problem entirely; the third is for cases where you genuinely cannot.

### 1. Update the tracked entity in place with SetValues

If you already loaded the row, the change tracker is your friend. Mutate the tracked instance and let EF Core compute the diff:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
    if (existing is null) return NotFound();

    db.Entry(existing).CurrentValues.SetValues(dto);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`CurrentValues.SetValues` copies matching property names from the source object onto the tracked entity and marks only the columns that actually changed as `Modified`. The generated `UPDATE` statement only touches dirty columns. This is the cleanest pattern for "edit existing row from a DTO" because it stays inside the identity map and produces minimal SQL.

### 2. Read with AsNoTracking, then Update

If you only loaded the row to check existence, do that without tracking:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var exists = await db.Customers
        .AsNoTracking()
        .AnyAsync(c => c.Id == id);
    if (!exists) return NotFound();

    var updated = new Customer { Id = dto.Id, Name = dto.Name, Email = dto.Email };
    db.Update(updated);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`AnyAsync` does not materialise an entity, so nothing gets tracked. `db.Update(updated)` attaches the new instance in `Modified` state and EF Core writes every property as a single `UPDATE` round-trip. The trade-off compared to fix 1 is that every column is written on the wire, dirty or not, because EF Core has no original values to diff against. For wide tables this is wasteful; for narrow tables it is the simplest code.

For broader patterns around what does and does not track, see the rundown in [tracking and the change tracker entries API](/2026/04/efcore-11-changetracker-getentriesforstate/).

### 3. Detach the existing entity, then attach yours

When you cannot avoid the dual-instance situation (a long-lived context, a third-party library that loads behind your back), detach the conflicting entry first:

```csharp
// .NET 11, EF Core 11.0.0
public async Task ReplaceCustomer(int id, Customer incoming)
{
    var local = db.ChangeTracker.Entries<Customer>()
        .FirstOrDefault(e => e.Entity.Id == id);

    if (local is not null)
        local.State = EntityState.Detached;

    db.Update(incoming);
    await db.SaveChangesAsync();
}
```

`ChangeTracker.Entries<T>()` is in-memory and does not hit the database. Setting `State = Detached` removes the entry from the identity map, which frees the key for the new instance. This is the escape hatch, not the default, because it leaves you reasoning about which instance "wins" if any other code holds a reference to the detached one.

EF Core 11 also exposes `db.Entry(local.Entity).State = EntityState.Detached` directly when you already have the offending object on hand. Both forms do the same thing: pull the entry out of the identity map.

## Common shapes that trigger this

### A DbContext registered as Singleton or captive in a Singleton

The vast majority of "but my code only updates once" reports turn out to be a `DbContext` lifetime mismatch. A `DbContext` is meant to be `Scoped`, that is, one per request. If it is registered as `Singleton` (or injected into one), every request piles entities onto the same identity map and the second update of the same key throws.

```csharp
// Bad: long-lived AppDb captures the change tracker for the lifetime of the host
builder.Services.AddSingleton<AppDb>();

// Good: scoped per request, change tracker resets between requests
builder.Services.AddDbContext<AppDb>(o => o.UseSqlServer(cs));
```

If you genuinely need a context inside a `Singleton` (for example, a `BackgroundService` or a Hangfire job), inject `IDbContextFactory<AppDb>` and create a fresh context per unit of work:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class CustomerSyncService(IDbContextFactory<AppDb> factory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            // ... work with db ...
        }
    }
}
```

### Eager-loaded graphs that meet a manually attached entity

If you load a customer with its orders eagerly, then later try to `Attach(customer)` from somewhere else (another query result, a serialised request body, a cache hit), the orders graph collides with anything already tracked. Either pull the read-side query down to `AsNoTracking()` so the graph is not in the map, or use `db.Entry(customer).State = EntityState.Modified` only on the root and walk the children explicitly.

### Mocked DbContext in tests

If you are using a mocked `DbContext` to write tests, the mock often does not implement the identity map correctly, so production hits this error and tests pass. The reverse also happens: a real in-memory provider tracks entities the mock did not, and the test fails for reasons that have nothing to do with the system under test. The fix is to test against a real provider; the [DbContext mocking pitfalls](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) guide covers what the mock does and does not give you.

### EnableSensitiveDataLogging is your debugger

The exception message says "Consider using `DbContextOptions.EnableSensitiveDataLogging` to see the conflicting key values" for a reason. Without it, EF Core hides the actual primary key in the error to avoid leaking PII into logs. Enable it locally to see which row is the duplicate:

```csharp
// .NET 11, EF Core 11.0.0 -- development only
builder.Services.AddDbContext<AppDb>(o => o
    .UseSqlServer(cs)
    .EnableSensitiveDataLogging()
    .EnableDetailedErrors());
```

Never ship this in production; the same flag will print parameter values into your logs on every command.

## Variants that look like this error but are not

### "Cannot insert explicit value for identity column"

Different exception, different cause: SQL Server rejects a non-zero primary key on an `IDENTITY` column. The fix is `SET IDENTITY_INSERT ON` or, more commonly, do not assign the key on insert. The change tracker is not involved.

### "An attempt was made to use the model while it was being created"

This is a startup ordering bug, typically caused by a static `DbContext` field or by reading from the model inside `OnModelCreating`. The identity map is also not involved.

### "A second operation was started on this context instance before a previous operation completed"

This is concurrency, not key conflict. A scoped `DbContext` is not thread-safe; two parallel `await`s on the same instance produce this exception. Distinct error, and distinct fix (`IDbContextFactory` again, or serialise the work).

## Related

For the broader EF Core context, see the rundown of [N+1 query detection](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), the guide to [compiled queries on hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/), and the walkthrough of [records as EF Core entities](/2026/04/how-to-use-records-with-ef-core-11-correctly/) which has its own identity-map gotchas around `with` expressions. When you hit this error in startup code rather than a request handler, the [DefaultConnection lookup checklist](/2026/05/fix-no-connection-string-named-defaultconnection/) covers the configuration side. For test fixtures that hand a real database to your code, the [Testcontainers walkthrough](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) is the cleanest setup.

## Sources

- [Tracking and No-Tracking Queries](https://learn.microsoft.com/en-us/ef/core/querying/tracking), EF Core docs.
- [Change Tracker API](https://learn.microsoft.com/en-us/ef/core/change-tracking/), EF Core docs.
- [Working with disconnected entity graphs](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), EF Core docs.
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`PropertyValues.SetValues` method](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues), Microsoft Learn.
