---
title: "How to write reusable LINQ predicates that EF Core can translate in Where, Select, and OrderBy"
description: "A bool helper method throws \"could not be translated\". An Expression<Func<T, bool>> does not. Here is how to compose, nest, and reuse expression trees in EF Core 11 without LINQKit, with the real SQL for every case."
pubDate: 2026-08-23
tags:
  - "ef-core"
  - "linq"
  - "csharp"
  - "dotnet"
---

The rule is short: EF Core can only translate what is still an expression tree when it reaches the provider. A `static bool IsActive(Customer c)` helper compiles to a method call node and throws at runtime; the same logic stored as `static readonly Expression<Func<Customer, bool>> IsActive` translates cleanly and can be composed, nested, and rebound onto other entity types. The part most guidance gets wrong is that you need LINQKit's `AsExpandable()` to compose those trees. You do not: `Expression.Invoke` has translated since EF Core 3.1, and every SQL snippet below came out of EF Core 11.0.0-preview.7.26381.103 on the SQL Server provider via `ToQueryString()`.

## Why the bool helper method throws and the expression does not

Start with the shape almost everyone reaches for first, because it reads well:

```csharp
// EF Core 11.0.0-preview.7, C# 14
static bool IsActiveMethod(Customer c) => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(c => IsActiveMethod(c));
```

The C# compiler turns that lambda into an expression tree whose body is a `MethodCallExpression` pointing at `IsActiveMethod`. EF Core has no way to look inside a compiled method body, so translation stops:

```
System.InvalidOperationException
The LINQ expression 'DbSet<Customer>()
    .Where(c => Helpers.IsActiveMethod(c))' could not be translated. Either rewrite
the query in a form that can be translated, or switch to client evaluation explicitly
by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'.
```

That is the documented behaviour: EF Core supports partial client evaluation only in the top-level projection, and throws for anything untranslatable elsewhere in the query, per the [client vs. server evaluation guidance](https://learn.microsoft.com/en-us/ef/core/querying/client-eval). If you have hit this before in other shapes, the full triage list lives in [the "LINQ expression could not be translated" post](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/).

Store the same logic as an expression instead and nothing about the call site changes:

```csharp
static readonly Expression<Func<Customer, bool>> IsActive =
    c => !c.IsDeleted && c.Orders.Count > 0;

db.Customers.Where(IsActive);
```

```sql
SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId])
```

`Queryable.Where` takes `Expression<Func<T, bool>>`, so passing the field directly hands EF the whole tree. The same holds when the predicate arrives as a method parameter, which is the basis of every specification-style abstraction:

```csharp
static IQueryable<Customer> Filter(IQueryable<Customer> q, Expression<Func<Customer, bool>> p)
    => q.Where(p);
```

That produced identical SQL in the probe. The moment the predicate becomes a `Func<>` rather than an `Expression<Func<>>`, you are back to the exception.

## Composing predicates: Expression.Invoke translates in EF Core 11

The interesting case is combining two predicates that were written independently. The obvious attempt fails:

```csharp
db.Customers.Where(c => IsActive.Compile()(c) && c.Country == "NL");
```

```
The LINQ expression 'DbSet<Customer>()
    .Where(c => Invoke(Func<Customer, bool>, c) && c.Country == "NL")'
could not be translated.
```

`Compile()` runs at query-build time and drops a `Func<Customer, bool>` constant into the tree. EF sees an opaque delegate and gives up. This is the failure that sends people to LINQKit.

But building the invocation as an expression node rather than a delegate call works today:

```csharp
static Expression<Func<T, bool>> And<T>(
    Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = Expression.Parameter(typeof(T), "x");
    return Expression.Lambda<Func<T, bool>>(
        Expression.AndAlso(Expression.Invoke(a, p), Expression.Invoke(b, p)), p);
}

static Expression<Func<Customer, bool>> InCountry(string country) => c => c.Country == country;

db.Customers.Where(And(IsActive, InCountry("NL")));
```

```sql
DECLARE @c nvarchar(4000) = N'NL';

SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId]) AND [c].[Country] = @c
```

No `AsExpandable()`, no extra package. EF Core's query pipeline reduces `InvocationExpression` nodes before translation. The regression that broke this in EF Core 3.0 was tracked as [dotnet/efcore#17791](https://github.com/dotnet/efcore/issues/17791) and fixed for 3.1, but a lot of advice on the web still predates the fix.

Two details worth knowing about that `And` helper. First, a `true` or `false` seed, the thing `PredicateBuilder` starts from, costs nothing: `And<Customer>(c => true, InCountry("NL"))` and `Or<Customer>(c => false, InCountry("NL"))` both emitted exactly the `WHERE [c].[Country] = @c` above, with no `1 = 1` residue. EF's expression simplifier folds the constant away, so you can write the accumulator loop naively.

Second, `Expression.Invoke` is not your only option. Rebinding parameters with an `ExpressionVisitor` produces a flatter tree:

```csharp
sealed class Rebind(ParameterExpression from, Expression to) : ExpressionVisitor
{
    protected override Expression VisitParameter(ParameterExpression node)
        => node == from ? to : base.VisitParameter(node);
}

public static Expression<Func<T, bool>> And<T>(
    this Expression<Func<T, bool>> a, Expression<Func<T, bool>> b)
{
    var p = a.Parameters[0];
    var right = new Rebind(b.Parameters[0], p).Visit(b.Body)!;
    return Expression.Lambda<Func<T, bool>>(Expression.AndAlso(a.Body, right), p);
}
```

Both versions generated byte-identical SQL in the probe. Prefer the visitor when you want to inspect or further transform the combined tree yourself, since there is no invocation layer in the way. Prefer `Expression.Invoke` when you want twelve lines fewer.

## Rebinding a predicate onto a different entity type

The visitor pays for itself the moment you want to apply a `Customer` predicate to an `Order` query. You are not composing two predicates over the same parameter here, you are substituting the parameter with a member path:

```csharp
public static Expression<Func<TOuter, bool>> On<TOuter, TInner>(
    this Expression<Func<TInner, bool>> inner,
    Expression<Func<TOuter, TInner>> path)
{
    var body = new Rebind(inner.Parameters[0], path.Body).Visit(inner.Body)!;
    return Expression.Lambda<Func<TOuter, bool>>(body, path.Parameters[0]);
}

db.Orders.Where(IsActive.On((Order o) => o.Customer));
```

```sql
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
INNER JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
WHERE [c].[IsDeleted] = CAST(0 AS bit) AND EXISTS (
    SELECT 1
    FROM [Orders] AS [o0]
    WHERE [c].[Id] = [o0].[CustomerId])
```

One definition of "active customer", enforced from both directions, with the join written for you. If the rule is more like a permanent filter than a reusable building block, consider whether it belongs in [a named query filter](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) instead, so callers cannot forget it.

## Reusable projections in Select

Projections follow the same rule, with one extra failure mode. Passing the expression straight to `Select` works:

```csharp
static readonly Expression<Func<Customer, CustomerDto>> ToDto =
    c => new CustomerDto(c.Id, c.Name, c.Orders.Count);

db.Customers.Select(ToDto);
```

```sql
SELECT [c].[Id], [c].[Name], (
    SELECT COUNT(*)
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId])
FROM [Customers] AS [c]
```

Nesting it inside a larger projection with `Compile()` does not, and the exception is different from the one in `Where` because projections allow partial client evaluation:

```csharp
db.Orders.Select(o => new { o.Id, Cust = ToDto.Compile()(o.Customer) });
```

```
System.InvalidOperationException
The client projection contains a reference to a constant expression of
'System.Func<Customer, CustomerDto>'. This could potentially cause a memory leak;
consider assigning this constant to a local variable and using the variable in the
query instead.
```

That is EF telling you the compiled query plan would capture your delegate forever. Build the nesting as an expression node instead and it translates:

```csharp
var p = Expression.Parameter(typeof(Order), "o");
var ctor = typeof(OrderDto).GetConstructor([typeof(int), typeof(CustomerDto)])!;
var body = Expression.New(ctor,
    Expression.Property(p, nameof(Order.Id)),
    Expression.Invoke(ToDto, Expression.Property(p, nameof(Order.Customer))));

db.Orders.Select(Expression.Lambda<Func<Order, OrderDto>>(body, p));
```

```sql
SELECT [o].[Id], [c].[Id], [c].[Name], (
    SELECT COUNT(*)
    FROM [Orders] AS [o0]
    WHERE [c].[Id] = [o0].[CustomerId])
FROM [Orders] AS [o]
INNER JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

The `Expression.Invoke(ToDto, memberPath)` idiom is the whole trick: it applies a reusable lambda to a sub-expression rather than to the root parameter.

## Applying a reusable predicate inside a navigation with AsQueryable()

`ICollection<T>.Any(Func<T, bool>)` is the `IEnumerable` overload, so passing a stored expression to a navigation property does not compile, and passing a bool method does compile but fails to translate:

```csharp
db.Customers.Where(c => c.Orders.Any(o => IsBigOrderMethod(o)));
// InvalidOperationException: ... .Any(o => Helpers.IsBigOrderMethod(o))' could not be translated
```

Insert `AsQueryable()` and you get the `Queryable` overload, which takes an expression:

```csharp
static readonly Expression<Func<Order, bool>> IsBigOrder = o => o.Total > 1000m;

db.Customers.Where(c => c.Orders.AsQueryable().Any(IsBigOrder));
```

```sql
SELECT [c].[Id], [c].[Country], [c].[IsDeleted], [c].[Name]
FROM [Customers] AS [c]
WHERE EXISTS (
    SELECT 1
    FROM [Orders] AS [o]
    WHERE [c].[Id] = [o].[CustomerId] AND [o].[Total] > 1000.0)
```

`AsQueryable()` on a navigation is free inside a query tree: EF strips it during translation. The same trick works for `All`, `Count`, and `Select` over the collection. `All(IsBigOrder)` translated to `NOT EXISTS (... AND [o].[Total] <= 1000.0)`, `Count(IsBigOrder)` to a filtered correlated `COUNT(*)`, and `Select(OrderDtoExpr).ToList()` to a `LEFT JOIN` with an `ORDER BY [c].[Id]` for the collection shaper.

## Sort keys as parameters, including the boxing case

Sorting is where reuse usually means "the column comes from a query string". `Queryable.OrderBy` is generic over the key type, so a pass-through helper keeps the key strongly typed:

```csharp
public static IOrderedQueryable<T> OrderByKey<T, TKey>(
    this IQueryable<T> q, Expression<Func<T, TKey>> key) => q.OrderBy(key);

static readonly Dictionary<string, Expression<Func<Customer, string>>> SortKeys = new()
{
    ["name"] = c => c.Name,
    ["country"] = c => c.Country,
};

db.Customers.OrderByKey(SortKeys["name"]);   // ORDER BY [c].[Name]
```

If the columns have different CLR types you will be tempted by `Expression<Func<T, object>>`, which forces a `Convert(c.Id, Object)` node for value types. EF Core 11 does handle it:

```csharp
Expression<Func<Customer, object>> key = c => c.Id;
db.Customers.OrderBy(key);   // ORDER BY [c].[Id]
```

The boxing conversion is stripped during translation. It is still worth avoiding, because `object` keys silently accept things that will not translate and you lose the compile-time check on the key type. A `Dictionary<string, Expression<Func<T, TKey>>>` per key type, or a small switch that calls `OrderByKey` with the right generic argument, keeps the mistake impossible. If the sort is feeding a paged endpoint, note that a stable ordering is a hard requirement for [keyset pagination](/2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11/).

## The Expression.Constant trap that inlines your parameters

This is the bug that only shows up in production, and only in the query plan cache. When you write a factory as a lambda, the captured argument becomes a closure field, and EF parameterizes it:

```csharp
static Expression<Func<Customer, bool>> InCountry(string c) => x => x.Country == c;
// WHERE [c].[Country] = @c   with DECLARE @c nvarchar(4000) = N'NL';
```

When you hand-build the same tree, the natural thing to write is `Expression.Constant(c)`, and EF faithfully emits a literal:

```csharp
var body = Expression.Equal(
    Expression.Property(p, nameof(Customer.Country)),
    Expression.Constant(c));       // <- inlined, not parameterized
// WHERE [c].[Country] = N'NL'
```

Every distinct country now produces a distinct SQL string, a distinct EF query cache entry, and a distinct SQL Server plan. On a dynamic filter builder that is a plan cache flood. Two fixes, both verified against EF Core 11:

```csharp
// 1. EF.Parameter<T>, added in EF Core 9, forces parameterization of a constant
var efParameter = typeof(EF).GetMethod(nameof(EF.Parameter))!.MakeGenericMethod(typeof(string));
var value = Expression.Call(efParameter, Expression.Constant(c));
// WHERE [c].[Country] = @p

// 2. read the value through a field on a captured object, exactly like a compiler closure
sealed class Box { public string? Value; }
var value = Expression.Field(Expression.Constant(new Box { Value = c }), nameof(Box.Value));
// WHERE [c].[Country] = @Value
```

`EF.Constant<T>` (EF Core 8.0.2) does the opposite when you genuinely want the literal, for example to let the optimizer see a selective value. The pair is documented in [what's new in EF Core 9](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew). When you are unsure which side of this you landed on, the fastest check is to [log the SQL EF Core generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) and look for `DECLARE @`.

## Compile() belongs outside the query, and it is expensive

The one legitimate use of `Compile()` is running the same predicate against in-memory objects, for example to validate a change before saving it. Compiling is not cheap. In a warmed `Stopwatch` loop on .NET 11.0.100-preview.7 (coarse loop timings, not BenchmarkDotNet), calling `pred.Compile()(customer)` cost about 47.7 microseconds per operation, while invoking a delegate compiled once cost about 2.7 nanoseconds. The exact figures will move on your hardware; the four orders of magnitude will not. Cache the delegate next to the expression:

```csharp
public static class CustomerRules
{
    public static readonly Expression<Func<Customer, bool>> IsActive =
        c => !c.IsDeleted && c.Orders.Count > 0;

    public static readonly Func<Customer, bool> IsActiveFunc = IsActive.Compile();
}
```

Use `IsActive` for `IQueryable<Customer>` and `IsActiveFunc` for anything already in memory. That split is the practical version of the `IEnumerable` versus `IQueryable` boundary described in [choosing the right return type](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/), and it is also why an entity property like `public bool IsActive => !IsDeleted && Orders.Count > 0` throws "Translation of member 'IsActive' on entity type 'Customer' failed" the first time somebody uses it in a `Where`. Computed CLR properties have no tree for EF to read.

One last note on plans. Every distinct expression tree shape is a distinct EF compiled-query cache entry, so a predicate builder that assembles a different tree per request will not reuse a plan even when the SQL text ends up identical. If a specific composed query dominates a hot path, pin it with [a compiled query](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) rather than rebuilding the tree on every call.

## Where these belong in a real codebase

Two shapes cover almost everything, and the choice is about who owns the rule.

If the rule belongs to the entity, a static class next to it is enough. `CustomerRules.IsActive`, `OrderRules.IsBig`, one file, no interfaces. Callers write `db.Customers.Where(CustomerRules.IsActive)` and the definition has exactly one home. This is the version to reach for first, and most teams never need more.

If the rule belongs to a use case rather than an entity, a specification object earns its keep: a small type exposing `Expression<Func<T, bool>> Criteria` plus optional includes and ordering, with `And`, `Or`, and `Not` implemented on top of the composition helpers above. The value is not the abstraction, it is that a use case can be passed around, unit tested against in-memory objects through the cached `Compile()` delegate, and translated to SQL by the same tree.

Whichever you pick, do not build an abstraction over `Where` itself. Chained calls already compose:

```csharp
db.Customers.Where(IsActive).Where(InCountry("NL"));
```

That emitted exactly the same SQL as the `And`-composed single predicate, down to the parameter name. Each `Where` wraps the previous one in the tree, and EF flattens the chain into a single `WHERE` with `AND`. So the composition helpers are only needed when the operator is `Or`, when you are rebinding onto another entity type, or when you are assembling a predicate from a collection whose length is not known at compile time. Extension methods over `IQueryable<T>` handle the plain `And` case with no expression code at all:

```csharp
public static IQueryable<Customer> ActiveOnly(this IQueryable<Customer> q)
    => q.Where(c => !c.IsDeleted && c.Orders.Count > 0);

public static IQueryable<Customer> InCountry(this IQueryable<Customer> q, string country)
    => q.Where(c => c.Country == country);

db.Customers.ActiveOnly().InCountry("NL");
```

Same SQL again. The one thing you give up is the ability to pull the predicate back out and use it against an in-memory list, which is exactly the trade-off the `Expression<Func<T, bool>>` version buys you.

## Related

- [Fix: "The LINQ expression could not be translated" in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [How to use named query filters for soft delete and multi-tenancy in EF Core 11](/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/)
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

## Sources

- [Client vs. server evaluation](https://learn.microsoft.com/en-us/ef/core/querying/client-eval), EF Core documentation
- [dotnet/efcore#17791: 3.0 regression, translate Expression.Invoke](https://github.com/dotnet/efcore/issues/17791)
- [What's new in EF Core 9: EF.Parameter and EF.Constant](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [Queryable.Where and Queryable.OrderBy](https://learn.microsoft.com/en-us/dotnet/api/system.linq.queryable), .NET API reference
- All SQL captured with `ToQueryString()` against `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.7.26381.103 on .NET SDK 11.0.100-preview.7.26381.103, no database connection required
