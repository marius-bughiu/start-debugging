---
title: "Named query filters vs a single global query filter in EF Core 11: which should you use?"
description: "Both produce the same SQL. Reach for named filters only when you need to disable one predicate independently; a single combined filter is simpler for one concern in EF Core 11."
pubDate: 2026-07-07
template: vs
tags:
  - "comparison"
  - "efcore"
  - "dotnet"
---

If you have one filtering concern on an entity, use a single unnamed `HasQueryFilter(e => ...)`. If you have two or more concerns that must be lifted independently at query time, for example a soft-delete filter and a tenant filter where an admin screen needs to see deleted rows but never another tenant's rows, use named filters. That is the entire decision. The generated SQL is identical either way; the only thing that changes is whether `IgnoreQueryFilters` can switch off half of your predicate. Named query filters landed in EF Core 10 and are the standard multi-filter mechanism in EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0, .NET 11, C# 14).

Everything below is about that one axis: granularity of disabling. Because both approaches translate to the same `WHERE` clause, there is no performance story here and no ecosystem story. The comparison is purely about how much control you need over turning filters off.

## The two shapes side by side

A global query filter is a predicate EF Core injects into every LINQ query for an entity type. Before EF Core 10 you got exactly one per entity, so a second concern meant `&&`:

```csharp
// EF Core 9 style -- one unnamed filter, two concerns welded with &&
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);
```

The named overload takes a string key first, and repeated calls compose instead of overwriting:

```csharp
// EF Core 11 -- two named filters on the same entity
modelBuilder.Entity<Invoice>()
    .HasQueryFilter("SoftDeletionFilter", i => !i.IsDeleted)
    .HasQueryFilter("TenantFilter",       i => i.TenantId == _tenantId);
```

Run a plain query against either configuration and you get the same rows and the same SQL:

```sql
-- Identical for both the && filter and the two named filters
SELECT ... FROM Invoices WHERE NOT IsDeleted AND TenantId = @__tenantId
```

That is the important thing to internalize before you pick: named filters are not "more powerful filtering." They filter exactly the same. What you are buying with the extra ceremony is a named handle you can grab later.

## Feature matrix

| Feature                                   | Single global filter                     | Named filters                                  |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Filters per entity (EF Core 11)           | one unnamed predicate                    | many, each with a name                         |
| Combine multiple concerns                 | `&&` into one expression                 | one `HasQueryFilter` call per concern          |
| Generated SQL                             | `AND`-joined `WHERE`                     | identical `AND`-joined `WHERE`                 |
| `IgnoreQueryFilters()` (no args)          | drops the whole filter                   | drops every named filter                       |
| `IgnoreQueryFilters(["Name"])`            | not applicable                           | drops only that predicate                      |
| Mix named and unnamed on one entity       | n/a                                      | throws at model build; pick one style          |
| Available since                           | EF Core 2.0                              | EF Core 10                                      |
| Query-plan cache impact                   | parameterized, one plan                  | parameterized, one plan                        |
| Ceremony                                  | lowest                                   | filter-name constants, extension helpers       |

The only row that ever changes an outcome is the `IgnoreQueryFilters(["Name"])` row. Every other difference is cosmetic or a constraint you work around once.

## When to use a single global filter

Reach for the plain unnamed filter when the extra addressability buys you nothing:

- **One concern per entity.** A read-only lookup table that only ever needs `!IsArchived` has nothing to disable selectively. `HasQueryFilter(x => !x.IsArchived)` is the whole story, and a name would be dead weight.
- **You always want all-or-nothing.** If the only time you ever bypass the filter is an admin or migration path that legitimately wants to see everything, parameterless `IgnoreQueryFilters()` is exactly right. Naming would let you do less than you want, not more.
- **Multiple concerns that are never lifted apart.** Two predicates combined with `&&` are fine when no code path needs one on and the other off. A `!IsDeleted && OrgId == _orgId` filter on an internal tool where you never expose "show deleted" is simpler as one expression.
- **You are on EF Core 9 or earlier.** The named overload does not exist before EF Core 10, so a single `&&` filter is the only in-box option. If you are still combining concerns this way, see [migrate EF Core 6 to EF Core 11: breaking changes that actually bite](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) before you split them.

The single filter's advantage is that it has no magic strings. There is no `IgnoreQueryFilters(["SoftDeletonFilter"])` typo waiting to silently disable nothing, because there is no name to misspell.

## When to use named filters

Name your filters the moment two concerns need different lifetimes in a single query:

- **Soft delete plus multi-tenancy on the same table.** This is the canonical case. An admin report needs deleted invoices visible, but must stay scoped to the current tenant. With `IgnoreQueryFilters(["SoftDeletionFilter"])` the tenant predicate survives, so you cannot turn a reporting screen into a cross-tenant data breach. The full wiring is in [how to use named query filters for soft delete and multi-tenancy in EF Core 11](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).
- **A "toggleable" concern next to a "never off" concern.** Any time one predicate is a security boundary (tenant, ownership, row-level authorization) and another is a convenience (soft delete, published/draft state), naming lets you expose the convenience toggle without ever handing callers a way to drop the boundary.
- **You want an intent-revealing API for the bypass.** With names you can wrap the ignore behind an extension method so no caller types a filter string:

```csharp
// EF Core 11 -- filter name hidden behind a readable call site
public static class InvoiceFilters
{
    public const string SoftDelete = nameof(SoftDelete);
    public const string Tenant     = nameof(Tenant);
}

public static IQueryable<Invoice> IncludeDeleted(this IQueryable<Invoice> q)
    => q.IgnoreQueryFilters([InvoiceFilters.SoftDelete]); // tenant filter stays on

// Reads like English, cannot leak tenants
var report = await context.Invoices.IncludeDeleted().ToListAsync();
```

- **Filters live in separate configuration classes.** If soft delete comes from a shared `IEntityTypeConfiguration<T>` convention and the tenant filter is app-specific, two named calls keep them decoupled instead of forcing one class to own a combined `&&` expression.

## Why there is no benchmark section

A vs post normally owes you numbers. This one does not, and the reason is worth stating plainly so you do not go hunting for a difference that is not there. Both approaches lower to the same predicate tree, so EF Core emits the same `WHERE` clause and the query planner sees the same SQL. The tenant value becomes a query parameter in both cases, which means neither approach fragments your plan cache the way an inlined constant would. There is no per-query cost to naming a filter; the name exists only in the model metadata, not in the translated query. If you were hoping named filters were also a performance lever, they are not. Pick on the disabling-granularity axis alone. If you are measuring query counts while adding any filter, the thing that actually moves the needle is joins, covered in [how to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).

## The gotchas that pick for you

Three constraints can force the decision regardless of which you would prefer on style grounds.

**You cannot mix named and unnamed filters on one entity.** Once any filter on `Invoice` has a name, they all must. Adding an unnamed `HasQueryFilter(i => ...)` to an entity that already has a named filter throws at model-building time. So the choice is per entity, not per filter: decide the style once, and if you ever expect a second independently-toggled concern, start named.

**Parameterless `IgnoreQueryFilters()` still nukes everything.** Naming your filters does not make the old parameterless call safe. `context.Invoices.IgnoreQueryFilters().ToListAsync()` drops the tenant filter too. On any table carrying a tenant column, treat the argument-less overload as a code smell and always pass the explicit list of names you mean to disable. This single habit is the difference between a soft-delete toggle and an accidental cross-tenant read.

**Magic-string filter names fail silently.** `IgnoreQueryFilters(["SoftDeletonFilter"])` with a typo disables nothing and throws no error, because EF has no way to know you meant a real filter. If you go named, pin the names in `const` fields (as in the snippet above) so a typo is a compile error, not a production leak. A single unnamed filter has no such trap, which is a genuine point in its favor when you only have one concern.

One gotcha applies equally to both and is not a tiebreaker: a filter on the required side of a navigation turns `Include` into an `INNER JOIN`, so a filtered-out parent silently drops its children. That behavior is identical whether the predicate is named or combined with `&&`. The fix, a `LEFT JOIN` via an optional navigation or a matching filter on both ends, is the same in either world and is walked through in the [named query filters how-to](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/).

## Migrating from a combined filter to named filters

If you already ship a `!IsDeleted && TenantId == x` filter and now need to expose "show deleted" without dropping tenant scoping, the migration is mechanical. Split the one expression into two named calls:

```csharp
// Before -- one filter, cannot disable half of it
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(i => !i.IsDeleted && i.TenantId == _tenantId);

// After -- two named filters, soft delete now independently ignorable
modelBuilder.Entity<Invoice>()
    .HasQueryFilter(InvoiceFilters.SoftDelete, i => !i.IsDeleted)
    .HasQueryFilter(InvoiceFilters.Tenant,     i => i.TenantId == _tenantId);
```

Nothing about the default query behavior changes; the same rows come back and the same SQL is generated. The only new capability is that `IgnoreQueryFilters([InvoiceFilters.SoftDelete])` now exists as a targeted bypass. Because you cannot mix styles, do this split for the whole entity in one edit, and audit every existing `IgnoreQueryFilters()` call site on that entity: any parameterless call that used to mean "show deleted admin view" was already dropping the tenant filter, and splitting the filter is the moment to make those calls explicit.

## The call

Default to a single unnamed global query filter. It is the lower-ceremony option, it has no magic strings, and for the common case of one concern per entity it is strictly the right choice. Upgrade to named filters the instant a second concern needs to be toggled independently of the first, which in practice almost always means "soft delete alongside a tenant or ownership boundary." The rule of thumb: if you can imagine a query that wants one predicate off and the other on, name them now; otherwise combine with `&&` and move on. The SQL will not know the difference, but your future self debugging why an admin report leaked another tenant's invoices very much will.

## Related

- [How to use named query filters for soft delete and multi-tenancy in EF Core 11](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [How to use EF Core 11 interceptors for auditing](/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/)
- [EF Core ExecuteUpdate vs loading entities and SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)

## Sources

- [Global Query Filters, EF Core documentation (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/filters)
- [What's New in EF Core 10 (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [Named Query Filters in EF 10: multiple query filters per entity, Milan Jovanovic](https://www.milanjovanovic.tech/blog/named-query-filters-in-ef-10-multiple-query-filters-per-entity/)
- [Named global query filters in Entity Framework Core 10, Tim Deschryver](https://timdeschryver.dev/blog/named-global-query-filters-in-entity-framework-core-10)
- [Add ability to configure multiple query filters on a given DbSet, dotnet/efcore issue #33432](https://github.com/dotnet/efcore/issues/33432)
