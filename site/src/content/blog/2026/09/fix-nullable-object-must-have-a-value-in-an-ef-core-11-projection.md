---
title: "Fix: InvalidOperationException: Nullable object must have a value in an EF Core 11 projection"
description: "EF Core throws this when a Select reads a SQL NULL into a non-nullable int, decimal or DateTime. Cast the member to its nullable type and add ?? default, or guard the navigation with a null check."
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
---

EF Core throws `InvalidOperationException: Nullable object must have a value` when the SQL it generated for your `Select` returns `NULL` in a column that your projection assigns to a non-nullable value type (`int`, `decimal`, `DateTime`, `Guid`, a struct). The usual culprits are an optional navigation (`o.Customer.Rating` on an order with no customer), `Max`/`Min`/`Average` over an empty collection, and a whole DTO taken from the empty side of a `DefaultIfEmpty` join. The fix is to make the nullability visible in the LINQ: cast to the nullable type (`(int?)o.Customer.Rating`) and supply a default with `?? 0`, or write `o.Customer == null ? 0 : o.Customer.Rating`. All results below were measured on `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 on .NET 11 RC 1 and compared against EF Core 10.0.12. One case is new in EF Core 11: projecting a JSON complex collection alongside a collection navigation. That is a real regression, covered in its own section.

## The error in context

For the runtime case, the exception comes from the compiled shaper, not from your code or the database driver. That makes the stack trace look useless:

```
System.InvalidOperationException: Nullable object must have a value.
   at lambda_method272(Closure, QueryContext, DbDataReader, ResultContext, SingleQueryResultCoordinator)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.Enumerator.MoveNext()
   at System.Collections.Generic.List`1..ctor(IEnumerable`1 collection)
```

`lambda_method` is the materializer EF Core compiled for your projection. It reads each column as a nullable value, then calls `.Value` to put it into your non-nullable member. When the column is `NULL`, `Nullable<T>.Value` throws, and you get the same message you would see from `((int?)null).Value` in plain C#. The query translated fine and the SQL ran fine. What failed is the conversion from row to object.

If the top frames are ``System.Nullable`1.get_Value()`` and `SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension` instead, the query failed at compile time, before any SQL ran. Even `ToQueryString()` throws. That is the EF Core 11 regression covered in the JSON complex collection section below.

## Why this happens

LINQ-to-Objects and SQL disagree about what "missing" means. In C#, `order.Customer.Rating` on a null `Customer` throws a `NullReferenceException`, and `new List<decimal>().Max()` throws `Sequence contains no elements`. In SQL, a `LEFT JOIN` with no match produces `NULL` columns, and `MAX` over zero rows returns `NULL`. EF Core translates to the SQL semantics, so no exception fires at the database. The `NULL` then comes back to a CLR member that cannot hold it.

EF Core already compensates in several places. `Sum` is wrapped in `COALESCE(..., 0)`, a scalar `FirstOrDefault()` in a subquery is wrapped in `ISNULL`, and entity materialization checks key columns before building an object. The error shows up in the gaps it does not cover. Those gaps are the same in EF Core 10 and 11, apart from one fix and one regression.

## Minimal repro

The model has orders with an optional customer, and one customer ("Bob") with no orders at all:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (same model on EF Core 10.0.12)
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
    public List<Order> Orders { get; set; } = [];
}

public class Order
{
    public int Id { get; set; }
    public decimal Total { get; set; }
    public int? CustomerId { get; set; }     // optional relationship
    public Customer? Customer { get; set; }
}

// seed: Ana (Rating 5) with one order, Bob with none, plus one guest order with CustomerId = null
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer!.Rating })
    .ToList(); // InvalidOperationException: Nullable object must have a value.
```

The `!` quiets the nullable warning. It does nothing at runtime. EF Core generates a plain `LEFT JOIN`:

```sql
-- EF Core 11 RC 1, SQL Server provider, via ToQueryString()
SELECT [o].[Id], [c].[Rating]
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

The guest order's row has `NULL` in `[c].[Rating]`, and the anonymous type's `int Rating` cannot take it. A named DTO (`new OrderDto { Rating = o.Customer!.Rating }`) and a bare scalar (`Select(o => o.Customer!.Rating)`) fail in the same way.

## Fixes, in order of preference

### 1. Cast to the nullable type, then pick a default

This is the most common fix and the cheapest SQL:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = (int?)o.Customer!.Rating ?? 0 })
    .ToList(); // { Id = 1, Rating = 0 } | { Id = 2, Rating = 5 }
```

```sql
SELECT [o].[Id], ISNULL([c].[Rating], 0)
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

If "no customer" and "rating 0" mean different things to your caller, drop the `?? 0` and make the DTO member `int?`. That keeps the difference, which is usually more honest than inventing a zero.

### 2. Guard the navigation explicitly

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer == null ? 0 : o.Customer.Rating })
    .ToList();
```

EF Core turns the null check into a test on the joined key, which is the correct "did the join match" signal even when the member itself is a nullable column:

```sql
SELECT [o].[Id], CASE
    WHEN [c].[Id] IS NULL THEN 0
    ELSE [c].[Rating]
END
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

Use this form when you project several members from the same optional navigation, or when the member is a string or other reference type and you want a non-null DTO property.

### 3. Aggregates over possibly empty collections

`Sum` is safe. `Max`, `Min` and `Average` are not. On EF Core 11 RC 1 and 10.0.12 alike:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
db.Customers.Select(c => new { c.Name, Biggest = c.Orders.Max(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Avg = c.Orders.Average(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Sum = c.Orders.Sum(o => o.Total) });          // Bob = 0.0
db.Customers.Select(c => new { c.Name, Last = c.Orders.OrderBy(o => o.Id)
                                                .Select(o => o.Total).FirstOrDefault() }); // Bob = 0.0
```

The generated SQL shows why. `Sum` gets `COALESCE(SUM([o].[Total]), 0.0)`, and the `FirstOrDefault` subquery gets `ISNULL((SELECT TOP(1) ...), 0.0)`. `MAX` and `AVG` come through bare. The fix is the same cast, done inside the aggregate selector:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Customers.Select(c => new
{
    c.Name,
    Biggest  = c.Orders.Max(o => (decimal?)o.Total) ?? 0m,
    Smallest = c.Orders.Min(o => (decimal?)o.Total) ?? 0m,
    Avg      = c.Orders.Average(o => (decimal?)o.Total) ?? 0m,
}).ToList(); // Bob: 0, 0, 0
```

`c.Orders.Select(o => o.Total).DefaultIfEmpty().Max()` also works, but it compiles to a `LEFT JOIN` against a one-row `SELECT 1 AS empty` derived table. The nullable cast is simpler SQL for the same answer.

### 4. `DefaultIfEmpty` joins that project a DTO

This is the shape from [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915): a manual left join where the inner side is a projected DTO rather than an entity.

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows =
    (from o in db.Orders
     join c in db.Customers.Select(c => new CustomerDto { Id = c.Id, Rating = c.Rating })
         on o.CustomerId equals c.Id into cs
     from c in cs.DefaultIfEmpty()
     select new { o.Id, Customer = c })
    .ToList(); // throws on EF Core 11 RC 1 and 10.0.12
```

LINQ-to-Objects would give you `Customer = null` for the guest order. EF Core instead tries to build a `CustomerDto` from all-`NULL` columns. Join the entity and build the DTO after the join, behind a null check:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows =
    (from o in db.Orders
     join c in db.Customers on o.CustomerId equals c.Id into cs
     from c in cs.DefaultIfEmpty()
     select new
     {
         o.Id,
         Customer = c == null ? null : new CustomerDto { Id = c.Id, Rating = c.Rating }
     })
    .ToList(); // { Id = 1, Customer = null } | { Id = 2, Customer = CustomerDto 1 Rating=5 }
```

With an entity on the inner side, EF Core can check the key column to decide whether the row matched. With a plain projected DTO it has nothing to check. The EF team tracks that exact variant as [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608), still open, and says it needs the navigation-expansion rework to fix.

## What EF Core 11 already fixed: `LeftJoin` against a `GroupBy`

One family did get better in EF Core 11. A `LeftJoin` (the operator added in .NET 10, see [LINQ's join operators in .NET 10 and 11](/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/)) against a grouped aggregate, reported as [dotnet/efcore#38055](https://github.com/dotnet/efcore/issues/38055):

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var counts = db.Orders.GroupBy(o => o.CustomerId, (k, g) => new { CustomerId = k, Count = g.Count() });

var rows = db.Customers
    .LeftJoin(counts, c => (int?)c.Id, g => g.CustomerId, (c, g) => new { c, g })
    .Select(x => new { x.c.Name, Count = x.g == null ? 0 : x.g.Count })
    .ToList();
// EF Core 10.0.12: InvalidOperationException: Nullable object must have a value.
// EF Core 11 RC 1: { Name = Ana, Count = 1 } | { Name = Bob, Count = 0 }
```

EF Core 11 now puts a synthetic column in the inner subquery and gates the object on it:

```sql
SELECT [c].[Name], [o0].[CustomerId], [o0].[Count], [o0].[marker]
FROM [Customers] AS [c]
LEFT JOIN (
    SELECT [o].[CustomerId], COUNT(*) AS [Count], 1 AS [marker]
    FROM [Orders] AS [o]
    GROUP BY [o].[CustomerId]
) AS [o0] ON [c].[Id] = [o0].[CustomerId]
```

`[marker]` is `NULL` only when the join found no match, so `x.g == null` finally means what it says. This came in [dotnet/efcore#38479](https://github.com/dotnet/efcore/pull/38479) (merged June 2026), with follow-ups for value-type projections ([#38555](https://github.com/dotnet/efcore/pull/38555)) and later joins ([#38499](https://github.com/dotnet/efcore/pull/38499)). None of these were backported to 10.0.x. On EF Core 10, cast inside the grouping (`Count = (int?)g.Count()`) and read `x.g!.Count ?? 0`, which works on both versions and produces `ISNULL([o0].[Count], 0)`.

## EF Core 11 RC 1 regression: JSON complex collection plus a collection navigation

This one is not a data problem at all. Projecting a JSON-mapped complex collection (`ComplexCollection(...).ToJson()`, see [mapping JSON columns in EF Core 11](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)) together with a collection navigation in the same `Select` throws while the query is compiled:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
modelBuilder.Entity<Parent>(e =>
{
    e.ComplexCollection(p => p.Items).ToJson();
    e.HasMany(p => p.Links).WithMany(l => l.Parents);
});

var dtos = db.Parents
    .Select(p => new ParentDto
    {
        Name = p.Name,
        Items = p.Items,                                  // JSON complex collection
        Links = p.Links.Select(l => l.Name).ToList(),     // collection navigation
    })
    .ToList();
// EF Core 10.0.12: works
// EF Core 11 RC 1: InvalidOperationException: Nullable object must have a value.
//   at System.Nullable`1.get_Value()
//   at ...SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension(Expression expression)
```

Each half works on its own. `AsSplitQuery()` does not help, because the failure happens before EF Core decides how to split. This is [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928), labelled a regression since 11.0.0-preview.1. The fix, [dotnet/efcore#38932](https://github.com/dotnet/efcore/pull/38932), merged to `main` on 2026-09-09. The `release/11.0` backport, [#38948](https://github.com/dotnet/efcore/pull/38948), was still open on 2026-09-14, so RC 1 has the bug and the fix should land in a later RC or GA. Until then, either load the entity with `Include` and map in memory:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var dtos = (await db.Parents.Include(p => p.Links).AsNoTracking().ToListAsync())
    .Select(p => new ParentDto { Name = p.Name, Items = p.Items, Links = p.Links.Select(l => l.Name).ToList() })
    .ToList();
```

or run two projections (one for the JSON column, one for the navigation) and stitch them by key. Both work on RC 1. The `Include` version loads every `Link` column, so for wide tables use the two-query version.

## Lookalikes that land here

- **`The data is NULL at ordinal 1. This method can't be called on NULL values`** (SQLite) or **`SqlNullValueException: Data is Null`** (SQL Server): a column that is nullable in the database but mapped to a non-nullable property, typical for database-first models and views. The provider throws while reading the column, before EF Core's shaper sees it. Measured on SQLite only. The fix is the model: make the property `int?`, or fix the column. Neither `(int?)p.Stock` nor `(int?)p.Stock ?? -1` in the projection helps (both still throw on EF Core 11 RC 1), because EF Core trusts the model and reads the column with `GetInt32`.
- **`Sequence contains no elements`**: the LINQ-to-Objects version of the same empty-set problem, or a `First()`/`Single()` that ran in memory. See [the dedicated post](/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/).
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`** wrapping `Nullable object must have a value`: that is your own `maybe!.Value` being evaluated client-side as a parameter, before any SQL. It is covered in [the parameter-evaluation post](/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/).

## Finding the offending column quickly

The shaper stack trace never names the member. Two fast ways to find it:

1. Call `query.ToQueryString()` and look for a column from the nullable side of a `LEFT JOIN`, `OUTER APPLY`, or a bare `MAX`/`MIN`/`AVG` subquery. [Logging the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) covers the other options.
2. Temporarily change the projection to `(int?)` / `(decimal?)` for every value-type member, run it, and see which one comes back `null`. That member is the one to fix.

If `ToQueryString()` itself throws, the problem is at compile time. On EF Core 11 RC 1, check for the JSON-plus-navigation shape above. If translation rather than materialization fails, you will usually see a different message, covered in [the "could not be translated" guide](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

A note on method: every row count and exception above came from executing the queries against SQLite in memory, on both EF Core versions. The SQL Server SQL was generated with `ToQueryString()`, not executed. The materializer that throws is provider-agnostic, so the same projections fail identically on SQL Server, but I did not run a SQL Server instance for this post.

## Sources

- [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928): JSON complex collection plus collection navigation regression; fix [#38932](https://github.com/dotnet/efcore/pull/38932), backport [#38948](https://github.com/dotnet/efcore/pull/38948).
- [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915) and [#38055](https://github.com/dotnet/efcore/issues/38055): left-joined non-entity projections; partial fix in [#38479](https://github.com/dotnet/efcore/pull/38479).
- [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608): the plain projected-DTO `DefaultIfEmpty` variant that is still open.
- [dotnet/efcore#33802](https://github.com/dotnet/efcore/issues/33802): inconsistent behaviour of aggregates over empty collections.
- [dotnet/efcore#35950](https://github.com/dotnet/efcore/issues/35950): the EF Core 9 `DefaultIfEmpty` `COALESCE` regression, fixed in EF Core 10.
- [Complex query operators in EF Core](https://learn.microsoft.com/ef/core/querying/complex-query-operators) on Microsoft Learn.
