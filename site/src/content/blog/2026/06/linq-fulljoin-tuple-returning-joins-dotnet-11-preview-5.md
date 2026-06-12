---
title: "LINQ Gets FullJoin and Selector-Free Joins in .NET 11 Preview 5"
description: ".NET 11 Preview 5 adds a brand-new FullJoin operator to LINQ plus tuple-returning overloads for Join, LeftJoin, RightJoin, and GroupJoin that drop the result selector entirely."
pubDate: 2026-06-12
tags:
  - "dotnet-11"
  - "csharp"
  - "linq"
  - "performance"
---

The [.NET 11 Preview 5 library notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md) round out a story that started in .NET 10. That release gave LINQ `LeftJoin` and `RightJoin` so you no longer had to fake an outer join with `GroupJoin` plus `SelectMany` plus `DefaultIfEmpty`. Preview 5 adds the missing fourth corner, `FullJoin`, and quietly fixes the most annoying part of every join: the result selector.

## The Result Selector Was Always Boilerplate

Every join overload before this took four arguments: the inner sequence, the outer key, the inner key, and a result selector that told LINQ how to combine a matched pair. Nine times out of ten that selector just glued the two items together into an anonymous type or a tuple:

```csharp
var pairs = catalog.Join(
    sales,
    p => p.Sku,
    s => s.Sku,
    (product, sale) => (product, sale));

foreach (var (product, sale) in pairs)
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

That last lambda carries no logic. It exists only to satisfy the signature. Preview 5 adds tuple-returning overloads for `Join`, `LeftJoin`, `RightJoin`, and `GroupJoin` that infer the obvious shape and let you drop it:

```csharp
foreach (var (product, sale) in catalog.Join(sales, p => p.Sku, s => s.Sku))
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

`Join` now returns `IEnumerable<(TOuter, TInner)>`. `GroupJoin` returns `IEnumerable<(TOuter, IEnumerable<TInner>)>`. The left and right variants return the outer or inner side as nullable, exactly as SQL would. The overloads exist on `Enumerable`, `Queryable`, and `AsyncEnumerable`, so the same call shape works on in-memory collections, EF Core query trees, and async streams.

## FullJoin Completes the Set

The genuinely new operator is `FullJoin` ([dotnet/runtime #127236](https://github.com/dotnet/runtime/pull/127236)). A full outer join returns every element from both sequences, pairing the ones whose keys match and leaving the unmatched ones with a `null` partner. Reconciling two lists, say a product catalog against a sales feed, used to mean two passes or a hand-built dictionary lookup. Now it is one call:

```csharp
foreach (var (product, sale) in catalog.FullJoin(sales, p => p.Sku, s => s.Sku))
{
    if (product is null)
        Console.WriteLine($"Sale for unknown SKU {sale!.Sku}");
    else if (sale is null)
        Console.WriteLine($"No sales for {product.Name}");
    else
        Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
}
```

Both sides of the tuple are nullable here because either can be absent, and the C# nullable annotations make the compiler nudge you toward handling both gaps.

## Worth Knowing Before You Lean On It

These are LINQ method-syntax additions only. There is no `full join` query keyword, and the existing query-comprehension forms are untouched. For the EF Core providers, whether `FullJoin` translates to a `FULL OUTER JOIN` or falls back to client evaluation depends on the provider catching up, so check your generated SQL before assuming it runs in the database. As with the rest of Preview 5, including the new [System.Text.Json JSON Lines support](/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/), the signatures can still shift before the November stable release. But the shape is clean enough that you can start deleting result-selector lambdas today.
