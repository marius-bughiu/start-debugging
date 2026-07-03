---
title: "How to use named query filters for soft delete and multi-tenancy in EF Core 11"
description: "Apply two independent global query filters to the same entity in EF Core 11: a soft-delete filter and a tenant filter, each named so you can disable one without the other via IgnoreQueryFilters."
pubDate: 2026-07-03
template: how-to
tags:
  - "dotnet"
  - "efcore"
  - "csharp"
---

To run a soft-delete filter and a multi-tenancy filter on the same entity in EF Core 11, give each one a name: call `HasQueryFilter("SoftDeletionFilter", e => !e.IsDeleted)` and `HasQueryFilter("TenantFilter", e => e.TenantId == _tenantId)` in `OnModelCreating`. Both are applied to every query by default. When an admin screen needs to see soft-deleted rows, disable just that one filter with `IgnoreQueryFilters(["SoftDeletionFilter"])`, and the tenant filter stays on so you never leak another tenant's data. Named query filters landed in EF Core 10 and are the standard way to stack filters in EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14). This post shows the full setup: wiring the tenant id onto the context, auto-stamping deletes, disabling filters selectively, and the join gotcha that quietly drops rows.

## Why one filter per entity was never enough

A global query filter is an extra `Where` clause that EF Core injects into every query for an entity type. Two use cases dominate. Soft delete keeps rows in the table with an `IsDeleted` flag instead of issuing `DELETE`, so you get an audit trail and an undo path. Multi-tenancy stores many customers' rows in one table with a `TenantId` column, and the filter guarantees a query only ever sees the current tenant's rows. Both are exactly the kind of cross-cutting predicate you never want to hand-write on every `Where`, because the one place you forget is a data-leak bug.

The problem before EF Core 10 was that each entity type could hold exactly one filter. Calling `HasQueryFilter` twice did not stack the predicates, it silently replaced the first:

```csharp
// EF Core 9 and earlier -- the second call WINS, soft delete is lost
modelBuilder.Entity<Invoice>().HasQueryFilter(i => !i.IsDeleted);
modelBuilder.Entity<Invoice>().HasQueryFilter(i => i.TenantId == _tenantId);
// Result: only the tenant filter is active. Deleted rows come back.
```

The workaround was to `&&` everything into a single expression:

```csharp
// EF Core 9 -- works, but the two concerns are now welded together
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

That compiles and filters correctly, but it has one sharp edge: you cannot turn off half of it. `IgnoreQueryFilters()` is all-or-nothing. The moment an admin report needs to include soft-deleted invoices, you call `IgnoreQueryFilters()`, and now the tenant filter is gone too. In a multi-tenant system that is not an inconvenience, it is a security incident. Named filters exist precisely to make "disable one, keep the other" possible.

## Defining two named filters on one entity

In EF Core 11, `HasQueryFilter` has an overload that takes a filter key as its first argument. Provide a name and the calls compose instead of overwriting:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
public class Invoice
{
    public int Id { get; set; }
    public int TenantId { get; set; }
    public bool IsDeleted { get; set; }
    public decimal Amount { get; set; }
}

public class BillingContext(string tenantId) : DbContext
{
    private readonly int _tenantId = int.Parse(tenantId);

    public DbSet<Invoice> Invoices => Set<Invoice>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == _tenantId);
    }
}
```

Now a plain query is filtered by both predicates:

```csharp
// SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
var invoices = await context.Invoices.ToListAsync();
```

Both predicates land in the same SQL `WHERE` clause, combined with `AND`, exactly as the `&&` version produced. The difference is entirely in what you can do next: each predicate now has a handle you can grab by name.

One rule the compiler will not catch: you cannot mix a named and an unnamed filter on the same entity type. Once any filter on `Invoice` has a name, they all must. An unnamed `HasQueryFilter(i => ...)` on an entity that already has named filters throws at model-building time. Pick one style per entity and stick to it.

## Getting the tenant id onto the context

A soft-delete filter is a constant expression, but a tenant filter needs a runtime value, and the filter can only read state that lives on the context instance. The cleanest wiring is to resolve the current tenant once when the context is constructed. In an ASP.NET Core app, that usually means reading it from the authenticated user and handing it to the context through DI:

```csharp
// .NET 11 -- resolve tenant per request and feed it to the context
builder.Services.AddScoped<ITenantProvider, HttpTenantProvider>();

builder.Services.AddDbContext<BillingContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
});

// A small provider that pulls the tenant from the current principal
public sealed class HttpTenantProvider(IHttpContextAccessor accessor) : ITenantProvider
{
    public int TenantId =>
        int.Parse(accessor.HttpContext!.User.FindFirstValue("tenant_id")!);
}
```

Then reference the provider from the context. Reading the tenant lazily inside the filter (rather than caching it in a field) matters more than it looks, and the next section explains why:

```csharp
// EF Core 11 -- the filter closes over a field EF re-reads on each query
public class BillingContext(DbContextOptions<BillingContext> options,
                            ITenantProvider tenant) : DbContext(options)
{
    private int TenantId => tenant.TenantId;

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Invoice>()
            .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
            .HasQueryFilter("TenantFilter", i => i.TenantId == TenantId);
    }
}
```

EF Core evaluates the tenant expression at query time, not at model-building time, so the property is read for each query and translated into a parameter. That keeps the compiled query plan reusable across tenants while still isolating rows.

### The DbContext pooling trap

If you use `AddDbContextPool`, be careful: a pooled context is reused across requests, and its constructor does not run again on reuse. A tenant id captured into a field in the constructor will be stale for the second request that gets that pooled instance. Either avoid pooling for a tenant-scoped context, or resolve the tenant through a scoped provider read at query time as shown above, never a value frozen at construction. This is the single most common way named-tenant filters leak data in production.

## Soft-deleting without touching every call site

The filter hides deleted rows, but something still has to set `IsDeleted = true`. You do not want that scattered across services. Override `SaveChangesAsync` and convert deletes into updates at the choke point every write passes through:

```csharp
// EF Core 11 -- intercept deletes and turn them into soft deletes
public override async Task<int> SaveChangesAsync(CancellationToken ct = default)
{
    ChangeTracker.DetectChanges();

    foreach (var entry in ChangeTracker.Entries<Invoice>()
                 .Where(e => e.State == EntityState.Deleted))
    {
        entry.State = EntityState.Modified;
        entry.CurrentValues["IsDeleted"] = true;
    }

    return await base.SaveChangesAsync(ct);
}
```

Now `context.Invoices.Remove(invoice)` followed by `SaveChangesAsync` issues an `UPDATE` that flips the flag, and the query filter makes the row vanish from ordinary reads. If you already run an `ISaveChangesInterceptor` for audit stamping, that is an even better home for this logic. See [how to use EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) for the interceptor version, which keeps `SaveChanges` untouched and survives being called from any repository.

## Disabling one filter, keeping the other

This is the whole point of naming. `IgnoreQueryFilters` accepts a collection of filter names, and only those are switched off:

```csharp
// EF Core 11 -- see deleted invoices, but STILL scoped to the current tenant
var withDeleted = await context.Invoices
    .IgnoreQueryFilters(["SoftDeletionFilter"])
    .ToListAsync();
// SQL: WHERE TenantId = @__tenantId   (soft-delete predicate dropped, tenant kept)
```

The tenant filter is untouched, so an admin viewing "all invoices including deleted" never sees another customer's data. The parameterless `IgnoreQueryFilters()` still exists and still disables everything, which you almost never want on a tenant-filtered entity. Treat the parameterless call as a code smell on any table that carries a tenant column.

### Name your filters with constants, not string literals

Filter names are magic strings, and a typo in `IgnoreQueryFilters(["SoftDeletonFilter"])` fails silently by disabling nothing. Pin the names down once:

```csharp
// EF Core 11 -- one source of truth for filter names
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant = nameof(Tenant);
}

modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant, i => i.TenantId == TenantId);
```

Then wrap the ignore call in an extension method so no caller ever types a filter name at all:

```csharp
// EF Core 11 -- intent-revealing API, filter name hidden
public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> query)
    => query.IgnoreQueryFilters([InvoiceFilters.SoftDelete]);

// Call site reads like English and cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

## The required-navigation join that silently drops rows

The nastiest gotcha with query filters has nothing to do with naming, and it bites hardest in multi-tenant models where every table carries a filter. When a filtered entity sits on the required side of a navigation, EF Core translates an `Include` into an `INNER JOIN`. If the filter removes the parent row, the inner join removes the child too, and you get fewer results than you expected.

Consider a filtered `Blog` with required `Post` children:

```csharp
// EF Core 11 -- required navigation plus a filter on the principal
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired();
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));

var allPosts = await db.Posts.ToListAsync();                       // returns 6
var withBlog = await db.Posts.Include(p => p.Blog).ToListAsync();  // returns 3
```

The second query drops every post whose blog was filtered out, because the `INNER JOIN` demands a matching blog row. The Microsoft docs call this out directly: using a required navigation to reach an entity that has a global query filter "may lead to unexpected results." There are two fixes. Make the navigation optional so EF emits a `LEFT JOIN`:

```csharp
// EF Core 11 -- LEFT JOIN keeps the children even when the parent is filtered
modelBuilder.Entity<Blog>().HasMany(b => b.Posts).WithOne(p => p.Blog).IsRequired(false);
```

Or, better for multi-tenancy, apply the same filter consistently to both ends so the child rows that would dangle are removed at their source:

```csharp
// EF Core 11 -- matching filters on both entities keep the two queries in sync
modelBuilder.Entity<Blog>().HasQueryFilter("UrlFilter", b => b.Url.Contains("fish"));
modelBuilder.Entity<Post>().HasQueryFilter("UrlFilter", p => p.Blog.Url.Contains("fish"));
```

The consistent-filter approach is the right default when your tenant column lives on every table: a `TenantFilter` on both `Blog` and `Post` means neither an `INNER JOIN` nor a `LEFT JOIN` can surface a cross-tenant row.

## Limits worth knowing before you commit

A few constraints shape how far you can push this. Filters can only be defined on the root entity type of an inheritance hierarchy, so you cannot put a different filter on each derived type in a table-per-hierarchy mapping. EF Core does not detect cycles in filter definitions, so a filter on `Blog` that references `Post` whose filter references `Blog` can loop forever during translation, define them carefully. And if you configure entities through `IEntityTypeConfiguration<T>` classes instead of directly in `OnModelCreating`, there is no context instance to read the tenant from inside `Configure`; the documented workaround is to add a private context field to the configuration class and reference it from the filter expression.

One performance note: because the tenant value becomes a query parameter, the soft-delete and tenant predicates do not fragment your query plan cache the way an inlined constant would. That keeps named filters cheap even under heavy multi-tenant load. If you are auditing query counts while adding filters, cross-check with [how to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), since a filter that reaches through a navigation can add a join you did not plan for.

Named query filters turn global filters from a blunt instrument into a composable one. Two predicates, two names, and the ability to lift exactly one of them for exactly one query is the difference between a soft-delete toggle and an accidental tenant breach.

## Related

- [How to use EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [How to use ExecuteUpdate and ExecuteDelete for bulk writes in EF Core 11](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)
- [Fix: FOREIGN KEY constraint failed when deleting an entity in EF Core 11](/2026/06/fix-foreign-key-constraint-failed-when-deleting-an-entity-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [How to do keyset (cursor) pagination in EF Core 11](/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/)

## Sources

- [Global Query Filters, EF Core documentation (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10, Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)
