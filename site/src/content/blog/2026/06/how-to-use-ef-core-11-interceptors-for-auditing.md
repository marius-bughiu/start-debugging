---
title: "How to use EF Core 11 interceptors for auditing"
description: "Stamp CreatedBy/ModifiedOn columns and write a full change-trail with an ISaveChangesInterceptor in EF Core 11, including the DI lifetime, current-user, and ExecuteUpdate gotchas."
pubDate: 2026-06-08
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
---

To audit changes in EF Core 11, implement `ISaveChangesInterceptor` (or derive from the no-op `SaveChangesInterceptor` base class), override `SavingChangesAsync` to walk `context.ChangeTracker.Entries()` before the write hits the database, and register it with `optionsBuilder.AddInterceptors(...)`. Inside the interceptor you either stamp audit columns (`CreatedBy`, `CreatedOnUtc`, `ModifiedBy`, `ModifiedOnUtc`) on entities that implement an `IAuditable` marker, or build a separate change-trail row per modified property. The whole thing runs inside the same transaction as your `SaveChanges`, so an audit failure rolls the business write back with it. This post uses .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0), and C# 14.

Interceptors are the right tool here precisely because they sit at the choke point every write must pass through. You cannot forget to call them, you cannot bypass them from a forgotten repository method, and they see the fully-populated `ChangeTracker` with original and current values for every property. That is exactly the data an audit log needs.

## Why an interceptor beats overriding SaveChanges

The folklore answer to "stamp my timestamps" is to override `SaveChanges` on a base `DbContext`:

```csharp
// The pattern people reach for first -- it works, but it has problems
public override int SaveChanges()
{
    foreach (var entry in ChangeTracker.Entries<IAuditable>())
    {
        if (entry.State == EntityState.Added)
            entry.Entity.CreatedOnUtc = DateTime.UtcNow;
    }
    return base.SaveChanges();
}
```

This couples auditing to your `DbContext` subclass. The moment you have a second context, a library that ships its own context, or a test that uses a bare `DbContext`, the behaviour silently disappears. It also forces you to override both `SaveChanges` and `SaveChangesAsync` by hand, and it gives you nowhere clean to inject the current user without making the context aware of HTTP concerns.

An `ISaveChangesInterceptor` is a separate, testable, single-responsibility class. You register it once, it applies to every context it is attached to, and EF Core calls the sync or async variant automatically depending on which `SaveChanges` overload the caller used. The official EF Core docs describe interceptors as the supported hook for exactly this kind of cross-cutting concern, see the [Microsoft Learn interceptors guide](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors).

## The interceptor surface you actually use

`ISaveChangesInterceptor` defines six methods, three sync and three async:

- `SavingChanges` / `SavingChangesAsync` -- fire before EF generates and sends the SQL. This is where audit work belongs, because the `ChangeTracker` still reflects what the application set.
- `SavedChanges` / `SavedChangesAsync` -- fire after a successful write. Use these to capture database-generated values (identity keys, computed columns) that were not known before the write.
- `SaveChangesFailed` / `SaveChangesFailedAsync` -- fire when the write throws, so you can mark an in-flight audit row as failed.

You rarely implement the interface directly. Derive from `SaveChangesInterceptor`, which provides no-op virtual implementations of all six, and override only what you need.

```csharp
// .NET 11, EF Core 11, C# 14
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class AuditableEntityInterceptor : SaveChangesInterceptor
{
    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
        DbContextEventData eventData,
        InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    public override InterceptionResult<int> SavingChanges(
        DbContextEventData eventData,
        InterceptionResult<int> result)
    {
        StampAuditColumns(eventData.Context);
        return base.SavingChanges(eventData, result);
    }

    private static void StampAuditColumns(DbContext? context)
    {
        if (context is null) return;
        // implementation below
    }
}
```

Two details that trip people up. First, `eventData.Context` is nullable, so guard it. Second, you must override both `SavingChanges` and `SavingChangesAsync`; EF Core does not route one to the other. If you only override the async version and somewhere in your code path calls the synchronous `SaveChanges()`, your audit logic never runs. Overriding both with a shared private method is the safe default. If you want to force everything onto the async path, throw `NotSupportedException` from the sync override so a stray synchronous call fails loudly instead of silently skipping the audit.

The `InterceptionResult<int>` return value is how you would suppress or replace the save. For auditing you almost never want that, so passing the incoming `result` straight through (which `base.Saving...` does) is correct.

## Stamping audit columns on auditable entities

The lightweight pattern: a marker interface plus shadow or real properties. Define the contract once.

```csharp
// .NET 11, C# 14
public interface IAuditable
{
    DateTime CreatedOnUtc { get; set; }
    string? CreatedBy { get; set; }
    DateTime? ModifiedOnUtc { get; set; }
    string? ModifiedBy { get; set; }
}
```

Now fill in `StampAuditColumns`. The key call is `ChangeTracker.Entries<IAuditable>()`, which returns only the tracked entities that implement the interface, already partitioned by `EntityState`.

```csharp
// .NET 11, EF Core 11, C# 14
private void StampAuditColumns(DbContext? context)
{
    if (context is null) return;

    var now = _timeProvider.GetUtcNow().UtcDateTime; // TimeProvider, .NET 8+
    var user = _currentUser.UserId ?? "system";

    foreach (var entry in context.ChangeTracker.Entries<IAuditable>())
    {
        switch (entry.State)
        {
            case EntityState.Added:
                entry.Entity.CreatedOnUtc = now;
                entry.Entity.CreatedBy = user;
                break;

            case EntityState.Modified:
                entry.Entity.ModifiedOnUtc = now;
                entry.Entity.ModifiedBy = user;
                break;

            case EntityState.Deleted:
                // optional: convert hard delete to soft delete here
                break;
        }
    }
}
```

A subtlety worth calling out: an entity whose only changed property is owned-collection membership, or whose change is to a related entity, can show up as `Modified` here. If you want to ignore "modified only because a child changed" you can additionally check `entry.Properties.Any(p => p.IsModified)`. For most audit-column use cases the plain `State` check is what you want.

Inject `TimeProvider` rather than calling `DateTime.UtcNow` directly. It makes the interceptor unit-testable with a fake clock, which matters because the timestamp is the thing you most want to assert on in tests.

## Registering the interceptor with the right lifetime

Here is the gotcha that produces the most bug reports. The interceptor needs the current user, which usually comes from `IHttpContextAccessor`. That makes the interceptor effectively scoped (per-request). But the naive `AddInterceptors(new AuditableEntityInterceptor())` creates a singleton-ish instance with no DI.

Register the interceptor in DI and resolve it when configuring the context:

```csharp
// .NET 11, ASP.NET Core 11 -- Program.cs
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<ICurrentUser, HttpContextCurrentUser>();
builder.Services.AddScoped<AuditableEntityInterceptor>();

builder.Services.AddDbContext<AppDbContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(
        sp.GetRequiredService<AuditableEntityInterceptor>());
});
```

Because `AddDbContext` is scoped by default and the configuration callback receives the request-scoped `IServiceProvider`, resolving a scoped interceptor here gives each request its own instance with the correct `ICurrentUser`. If you register the interceptor as a singleton while it depends on `IHttpContextAccessor`, you will either capture a stale `HttpContext` or trip the "Cannot consume scoped service from singleton" validation. If you have seen that exact message, the [fix for cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) walks through why the container rejects it.

Read the user through the accessor at the moment `SavingChanges` runs, not in the constructor, so the lookup always reflects the active request:

```csharp
// .NET 11, C# 14
public sealed class HttpContextCurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    public string? UserId =>
        accessor.HttpContext?.User.FindFirst("sub")?.Value;
}
```

## Writing a full change-trail, not just timestamps

Stamping columns answers "who touched this row and when." A change-trail answers "what exactly changed." For that you walk the modified properties and record original versus current values. EF Core gives you both through `PropertyEntry`.

```csharp
// .NET 11, EF Core 11, C# 14
private static List<AuditTrail> BuildTrail(DbContext context, DateTime now, string user)
{
    var trail = new List<AuditTrail>();

    foreach (var entry in context.ChangeTracker.Entries())
    {
        if (entry.Entity is AuditTrail) continue; // never audit the audit table
        if (entry.State is EntityState.Detached or EntityState.Unchanged) continue;

        var record = new AuditTrail
        {
            TableName = entry.Metadata.GetTableName(),
            Action = entry.State.ToString(),
            UserId = user,
            TimestampUtc = now,
            Changes = new Dictionary<string, object?>()
        };

        foreach (var prop in entry.Properties)
        {
            if (entry.State == EntityState.Added)
                record.Changes[prop.Metadata.Name] = prop.CurrentValue;
            else if (entry.State == EntityState.Modified && prop.IsModified)
                record.Changes[prop.Metadata.Name] =
                    new { Old = prop.OriginalValue, New = prop.CurrentValue };
            else if (entry.State == EntityState.Deleted)
                record.Changes[prop.Metadata.Name] = prop.OriginalValue;
        }

        trail.Add(record);
    }

    return trail;
}
```

Serialize `Changes` to a JSON column and you have a queryable history. Note `entry.Properties` only enumerates scalar properties; navigations and owned types need `entry.References` and `entry.Collections` if you care about them.

## The temporary-key problem and why SavedChanges exists

For inserted rows with database-generated keys, `prop.CurrentValue` during `SavingChanges` is a temporary placeholder, not the real identity value. EF Core has not talked to the database yet. If your audit trail records the primary key of new rows, capturing it in `SavingChanges` writes the wrong value.

This is the entire reason `SavedChanges` exists. The clean pattern is two-phase: build the audit rows in `SavingChanges`, hold them on the interceptor instance, then resolve the now-real key values and persist the trail in `SavedChangesAsync`.

```csharp
// .NET 11, EF Core 11, C# 14
private readonly List<(EntityEntry Entry, AuditTrail Record)> _pending = [];

public override ValueTask<InterceptionResult<int>> SavingChangesAsync(
    DbContextEventData eventData, InterceptionResult<int> result,
    CancellationToken ct = default)
{
    _pending.Clear();
    var ctx = eventData.Context!;
    foreach (var entry in ctx.ChangeTracker.Entries())
        // ... stash (entry, partial record) into _pending
    return base.SavingChangesAsync(eventData, result, ct);
}

public override async ValueTask<int> SavedChangesAsync(
    SaveChangesCompletedEventData eventData, int result,
    CancellationToken ct = default)
{
    foreach (var (entry, record) in _pending)
        record.EntityId = entry.Property("Id").CurrentValue?.ToString();

    // persist _pending to the audit store now that keys are real
    return await base.SavedChangesAsync(eventData, result, ct);
}
```

Because the interceptor now holds per-save state in `_pending`, it must be scoped or transient, never a shared singleton. A singleton would interleave `_pending` across concurrent requests and corrupt the trail. This is one more reason the DI registration above uses `AddScoped`.

If you walk the `ChangeTracker` in a hot path and have profiled `DetectChanges` showing up, EF Core 11's [`GetEntriesForState` API skips the full DetectChanges scan](/2026/04/efcore-11-changetracker-getentriesforstate/) when you only need entries in a specific state.

## The gotcha that silently skips your audit: ExecuteUpdate and ExecuteDelete

`SaveChangesInterceptor` only fires for `SaveChanges` and `SaveChangesAsync`. The bulk operations `ExecuteUpdate` and `ExecuteDelete` translate directly to a single SQL statement and never load entities into the `ChangeTracker`, so they completely bypass your auditing interceptor. This is by design and it is a frequent source of "why is this change not in the audit log" confusion.

```csharp
// This UPDATE is NOT audited -- it never touches the ChangeTracker
await db.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Cancelled));
```

If a code path must be audited, either route it through tracked entities and `SaveChanges`, or audit the bulk operation explicitly at the call site. The trade-offs between the two write styles are covered in the guide on [ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Pick the bulk path for throughput, accept that it is outside the interceptor, and make that an explicit decision rather than a surprise.

## Soft deletes from the same hook

Because the interceptor sees `EntityState.Deleted` entries before the SQL is generated, it is the natural place to convert a hard delete into a soft delete. Flip the state to `Modified` and set your flag:

```csharp
// .NET 11, EF Core 11, C# 14
case EntityState.Deleted when entry.Entity is ISoftDeletable sd:
    entry.State = EntityState.Modified;
    sd.IsDeleted = true;
    sd.DeletedOnUtc = now;
    sd.DeletedBy = user;
    break;
```

Pair this with a global query filter (`modelBuilder.Entity<T>().HasQueryFilter(e => !e.IsDeleted)`) so soft-deleted rows disappear from normal queries. Just remember the interceptor and the filter are two halves of one feature: the interceptor writes the flag, the filter hides it.

## Verifying it works

Interceptors are easy to unit-test because they are plain classes. Construct one with a fake `TimeProvider` and `ICurrentUser`, add an entity to a context configured with the interceptor, call `SaveChangesAsync`, and assert the stamped values. For end-to-end coverage, an in-memory or SQLite context with the interceptor registered through `AddInterceptors` exercises the real EF pipeline. If you build that test harness around a faked context, the rules for keeping change tracking intact are in [how to mock DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/), and if your audit writes start throwing about concurrent context use, see [a second operation was started on this context instance](/2026/05/fix-second-operation-was-started-on-this-context-instance/).

The short version: derive from `SaveChangesInterceptor`, override both `SavingChanges` and `SavingChangesAsync`, walk `ChangeTracker.Entries()` for the data, register the interceptor as scoped through DI so it can read the current user, use `SavedChangesAsync` when you need real keys, and remember that `ExecuteUpdate`/`ExecuteDelete` route around the whole thing. That covers the great majority of real-world .NET auditing requirements without a single line of audit code leaking into your domain logic.

Primary source: the [EF Core interceptors documentation](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors) on Microsoft Learn, which includes the canonical separate-audit-database sample this post builds on.
