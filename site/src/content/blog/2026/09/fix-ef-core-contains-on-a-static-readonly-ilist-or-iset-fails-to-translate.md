---
title: "Fix: EF Core `Contains` on a static readonly `IList<T>` or `ISet<T>` could not be translated"
description: "EF Core 8, 9 and 10 fail to translate Contains when the list is a static readonly field typed as IList, ICollection, ISet or IReadOnlySet. Call Enumerable.Contains explicitly, or upgrade to EF Core 11."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
---

If `Where(x => AllowedCodes.Contains(x.Code))` throws `The LINQ expression ... could not be translated` with `Translation of method 'System.Linq.Enumerable.Contains' failed`, look at how `AllowedCodes` is declared. It is almost certainly a `static readonly` field typed as `IList<T>`, `ICollection<T>`, `ISet<T>`, `IReadOnlySet<T>`, `IImmutableSet<T>` or `FrozenSet<T>`. The quickest fix that keeps the SQL the same is to call the LINQ operator explicitly: `Enumerable.Contains(AllowedCodes, x.Code)`. The real fix is EF Core 11, where dotnet/efcore#36757 corrected the query-root check that rejects these shapes. I measured every variant below with `Microsoft.EntityFrameworkCore.Sqlite` 8.0.21, 9.0.19, 10.0.12 and 11.0.0-rc.1.26425.128. The first three fail the same way. EF Core 11 RC 1 translates all of them.

## The error in context

Here is the exception from EF Core 10.0.12 on .NET 10 for a `static readonly IList<string>`:

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => (IList<string>)List<string> { "Open", "Pending" }
        .Contains(o.Status))' could not be translated. Additional information: Translation of method 'System.Linq.Enumerable.Contains' failed. If this method can be mapped to your custom function, see https://go.microsoft.com/fwlink/?linkid=2132413 for more information. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
   at Microsoft.EntityFrameworkCore.Query.QueryableMethodTranslatingExpressionVisitor.Translate(Expression expression)
   at Microsoft.EntityFrameworkCore.Query.QueryCompilationContext.CreateQueryExecutorExpression[TResult](Expression query)
```

There are two clues in that message. The first is the cast. The collection shows up as `(IList<string>)List<string> { "Open", "Pending" }`, which means EF already evaluated your field to its value, a constant, and wrapped it in a cast back to the declared type. The second is the method name. You wrote `IList<T>.Contains`, an instance method, yet the message names `Enumerable.Contains`. EF rewrites `ICollection<T>.Contains` calls into the LINQ operator before it translates them. So the method is not the problem. The problem is the argument EF passes to it.

When the field is typed as `IReadOnlySet<T>` or `IImmutableSet<T>`, the method name in the message changes to `System.Collections.Generic.IReadOnlySet<string>.Contains` or `System.Collections.Immutable.IImmutableSet<string>.Contains`. Those interfaces do not inherit from `ICollection<T>`, so EF never rewrites the call. It is the same bug with a different message.

## Why a static readonly field breaks and a local does not

There are two steps to this, and the bug only appears when both happen.

**Step 1: EF inlines `static readonly` fields as constants.** Before translation, EF's funcletizer walks the query and evaluates anything that does not depend on the database. Captured locals, instance fields and static properties become query parameters. A static field that is `readonly` (`FieldInfo.IsInitOnly`) is treated as a value that cannot change, so EF evaluates it once and inlines it as a constant. In EF Core 10 you can see this in [`ExpressionTreeFuncletizer.VisitMember`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs): the static member is marked as a captured variable "unless the captured variable is init-only". When EF builds that constant, it types it by the runtime type of the value (`List<string>`), then adds a `Convert` node back to the declared type (`IList<string>`) whenever the two differ.

**Step 2: the query-root check only strips one kind of cast.** To translate `Contains` over an in-memory collection, EF turns the collection into an inline query root and then into `IN (...)`. In EF Core 8, 9 and 10, [`QueryRootProcessor.VisitQueryRootCandidate`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) unwraps a `Convert` only when the target type is exactly `IEnumerable<T>`:

```csharp
// EF Core 10.0.x, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.GetGenericTypeDefinition() == typeof(IEnumerable<>))
{
    candidateExpression = convertExpression.Operand;
}
```

A `Convert` to `IList<string>` does not match, so the collection is never recognized as a query root and the `Contains` falls through to "could not be translated".

With that in mind, the pass/fail pattern makes sense:

- `List<T>`, `HashSet<T>` and `T[]` fields work because the declared type equals the runtime type. EF adds no `Convert`.
- `IEnumerable<T>`, `IReadOnlyList<T>` and `IReadOnlyCollection<T>` fields work because none of them declares its own `Contains`. The call binds to `Enumerable.Contains`, the compiler converts the argument to `IEnumerable<T>`, and the constant EF produces is cast to `IEnumerable<T>`, the one shape the old check accepts.
- `IList<T>`, `ICollection<T>`, `ISet<T>`, `IReadOnlySet<T>` and `IImmutableSet<T>` fail because they declare `Contains`. C# prefers the instance method over the extension, so the cast stays at the interface type.
- `FrozenSet<T>` fails even though it is a concrete class, because it is abstract. The runtime value is an internal subclass, which again produces a `Convert`. That was the case reported in dotnet/efcore#36496, and the PR that fixed it fixed the interfaces too.
- A captured local, a non-readonly static field and a static property all work because they become parameters, not constants, and the parameter path never had this bug.

This is not a regression. The original report of the `IReadOnlySet<T>` variant goes back to EF Core 7, and dotnet/efcore#38839 reproduces it on 7.0.20 through 10.0.11.

## Minimal repro

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
db.Database.EnsureDeleted();
db.Database.EnsureCreated();
db.Orders.AddRange(
    new Order { Status = "Open" },
    new Order { Status = "Pending" },
    new Order { Status = "Shipped" });
db.SaveChanges();

// Throws InvalidOperationException on EF Core 8, 9 and 10
var active = db.Orders
    .Where(o => OrderRules.ActiveStatuses.Contains(o.Status))
    .ToList();

Console.WriteLine(active.Count);

public static class OrderRules
{
    public static readonly IList<string> ActiveStatuses = new List<string> { "Open", "Pending" };
}

public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlite("Data Source=shop.db");
}
```

Change `IList<string>` to `List<string>`, remove `readonly`, or turn the field into a `{ get; }` property, and the same query runs. That is usually how people find the bug: a code review suggests "expose the interface, not the concrete type" or "make that field readonly", and a query that has worked for months breaks.

## What each declaration does on EF Core 8, 9, 10 and 11

I ran one probe per shape against SQLite on each EF version. EF Core 8 and 9 packages ran on the .NET 10 runtime. EF Core 11 RC 1 ran on .NET 11 RC 1. "Constant" means EF inlined the values into the SQL. "Parameter" means it sent them as parameters.

| Declaration | EF 8.0.21 | EF 9.0.19 | EF 10.0.12 | EF 11 RC 1 |
|---|---|---|---|---|
| `static readonly IList<T>` | fails | fails | fails | constant |
| `static readonly ICollection<T>` | fails | fails | fails | constant |
| `static readonly ISet<T>` | fails | fails | fails | constant |
| `static readonly IReadOnlySet<T>` | fails | fails | fails | constant |
| `static readonly IImmutableSet<T>` | fails | fails | fails | constant |
| `static readonly FrozenSet<T>` | fails | fails | fails | constant |
| `static readonly IReadOnlyList<T>`, `IReadOnlyCollection<T>`, `IEnumerable<T>` | constant | constant | constant | constant |
| `static readonly List<T>`, `HashSet<T>`, `T[]` | constant | constant | constant | constant |
| `static IList<T>` (not readonly) or static property | parameter | parameter | parameter | parameter |
| captured local `IList<T>` | parameter | parameter | parameter | parameter |
| `EF.Constant(localIList).Contains(...)` | fails | constant | constant | constant |

The last row is a lookalike worth knowing about. On EF Core 8, forcing a local `IList<T>` into a constant with `EF.Constant` hits the same bug. From EF Core 9 onward, `EF.Constant` goes through a different path and works.

## The fixes, in order of preference

### 1. Upgrade to EF Core 11

The fix is [dotnet/efcore#36757](https://github.com/dotnet/efcore/pull/36757), merged into `main` on 2025-09-24 and shipped in EF Core 11. It changes the check to unwrap any `Convert` whose target is assignable to `IEnumerable`, and it does so recursively:

```csharp
// EF Core 11.0, src/EFCore/Query/QueryRootProcessor.cs
if (expression is UnaryExpression { NodeType: ExpressionType.Convert } convertExpression
    && convertExpression.Type.IsAssignableTo(typeof(IEnumerable)))
{
    return VisitQueryRootCandidate(convertExpression.Operand, elementClrType);
}
```

It was not backported. The `release/10.0` branch still has the `typeof(IEnumerable<>)` comparison, and 10.0.12 still fails. dotnet/efcore#35024 (the `IList`/`ICollection` report) is milestoned 11.0.0, and #38839 was closed as a duplicate of it. If you are on EF Core 10 LTS, plan to use one of the rewrites below until you move to 11.

### 2. Call `Enumerable.Contains` explicitly

This is the one-line fix I recommend on EF Core 8, 9 and 10, because it keeps exactly the SQL you would get on EF Core 11:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var active = db.Orders
    .Where(o => Enumerable.Contains(OrderRules.ActiveStatuses, o.Status))
    .ToList();

// WHERE "o"."Status" IN ('Open', 'Pending')
```

Calling the static method directly makes the compiler convert the field to `IEnumerable<string>`, so EF's constant arrives cast to `IEnumerable<T>` and passes the old check. It worked on all six failing shapes in my runs, including `IReadOnlySet<T>` and `IImmutableSet<T>`. `OrderRules.ActiveStatuses.AsEnumerable().Contains(o.Status)` does the same thing if you prefer method syntax. `OrderRules.ActiveStatuses.Any(s => s == o.Status)` also translates to the same `IN` list, but it reads worse and I would not use it just to get around this.

One trade-off: on an `ISet<T>` or `FrozenSet<T>`, `Enumerable.Contains` in plain LINQ-to-Objects would skip the hash lookup. Inside an EF query that does not matter, because the call is never executed in .NET. It only describes the SQL.

### 3. Change the declared type

If the collection is only used in queries, declare it as `IReadOnlyCollection<T>`, `IReadOnlyList<T>` or an array. All three are read-only and all three translate on every version:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore 10.0.12
public static class OrderRules
{
    public static readonly IReadOnlyList<string> ActiveStatuses = ["Open", "Pending"];
}
```

Do not switch to `FrozenSet<T>` to get "real" immutability. On EF Core 8 through 10 it fails for the reason described above.

### 4. Let EF parameterize the values instead

Copying the field into a local, or turning it into a `static` property, makes EF send the values as parameters instead of constants:

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
var statuses = OrderRules.ActiveStatuses;
var active = db.Orders.Where(o => statuses.Contains(o.Status)).ToList();

// EF Core 10: WHERE "o"."Status" IN (@statuses1, @statuses2)
// EF Core 8/9 on SQLite: WHERE "o"."Status" IN (SELECT "s"."value" FROM json_each(@__statuses_0) AS "s")
```

This works, but it changes the SQL. Remember why the constant path exists: the values never change, so inlining them gives the database a fixed literal list, which is the best shape for index use and plan caching. For a short list of status codes, constants are the better SQL. Use this option when the list really can change at runtime, not only to work around the translation bug. If you want to see what EF generates in each case, [log the SQL EF Core generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) before and after the change.

## Variants that land on this page by mistake

- **`Translation of method 'System.MemoryExtensions.Contains' failed`** on an array after moving to C# 14. That is the first-class span overload resolution change, not this bug. See [the C# 14 span overload resolution fix](/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/).
- **A generic "could not be translated" on a method you wrote yourself**, such as `ids.HasItem(x.Id)`. EF cannot see inside your method, whatever collection type you use. The general causes and rewrites are in [the LINQ expression could not be translated in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), and the way to reuse predicate logic safely is in [writing reusable LINQ predicates EF Core can translate](/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/).
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`**. That happens when the funcletizer runs your field or property getter and the getter throws. It fails at the same stage but for a different reason. See [the parameter expression evaluation fix](/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/).
- **The same `static readonly IList<T>` inside a compiled query** (`EF.CompileQuery`). Compiled queries go through the same funcletizer and query-root steps. I confirmed they fail the same way on EF Core 10.0.12, and `Enumerable.Contains` fixes them too. See [how to use compiled queries for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).

## Related

- [Fix: The LINQ expression could not be translated in EF Core 11](/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [How to write reusable LINQ predicates EF Core can translate](/2026/08/how-to-write-reusable-linq-predicates-ef-core-can-translate/)
- [How to log the SQL that EF Core 11 generates](/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Fix the C# 14 overload resolution breaking change with spans](/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)

## Sources

- [dotnet/efcore#35024: Query could not be translated when using a static ICollection/IList field](https://github.com/dotnet/efcore/issues/35024), milestone 11.0.0.
- [dotnet/efcore#38839: Contains on a constant collection fails when declared as ICollection/IList/ISet/IReadOnlySet/IImmutableSet](https://github.com/dotnet/efcore/issues/38839), closed as a duplicate, with a 7.0.20 to 10.0.11 version matrix.
- [dotnet/efcore#36757: Fix handling of readonly fields using abstract classes (i.e. FrozenSet) in parameters for primitive collections](https://github.com/dotnet/efcore/pull/36757), the fix, merged 2025-09-24.
- [`QueryRootProcessor.cs` on `release/10.0`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/QueryRootProcessor.cs) and [`ExpressionTreeFuncletizer.cs` on `release/10.0`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore/Query/Internal/ExpressionTreeFuncletizer.cs).
- [What's new in EF Core 10: improved translation for parameterized collections](https://learn.microsoft.com/ef/core/what-is-new/ef-core-10.0/whatsnew#improved-translation-for-parameterized-collection).
