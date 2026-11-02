---
title: "C# 13: Use params collections with any recognized collection type"
description: "C# 13 permits params collections beyond arrays. See element arguments, normal versus expanded calls, supported collection shapes and allocation caveats."
pubDate: 2025-01-02
updatedDate: 2026-11-02
tags:
  - "csharp-13"
  - "csharp"
  - "dotnet"
  - "dotnet-9"
---

C# 13 extends `params` beyond one-dimensional arrays to recognized collection types. The expanded call passes individual **elements**, not a variable number of spans.

**Correction — November 2, 2026:** corrected the element-versus-span explanation and collection requirements. Passing a list to an ordinary `IEnumerable<T>` parameter was already possible before C# 13. Both examples below were checked with SDK 10.0.302 and `LangVersion` 13.

## Span parameters

```csharp
using System;

Print(1, 2, 3); // Expanded form: three int elements.
int[] data = { 4, 5 };
Print(data);    // Normal form: an existing buffer.

static void Print(params ReadOnlySpan<int> values)
{
    foreach (int value in values)
        Console.WriteLine(value);
}
```

The normal form passes an existing value convertible to the declared parameter type. The expanded form supplies elements from which the compiler constructs the parameter collection. A `ReadOnlySpan<T>` parameter can avoid an array allocation in suitable calls; this is not an allocation-free guarantee for every type or call.

## Which collections qualify?

Supported shapes include `Span<T>`, `ReadOnlySpan<T>`, the recognized generic collection interfaces, and collection-expression-compatible builder types. Constructible collection types need the required accessible parameterless constructor and suitable instance `Add` method, along with enumeration support. Implementing `IEnumerable<T>` and merely having any method named `Add` is not sufficient.

The supported interfaces include `IEnumerable<T>`, `IReadOnlyCollection<T>`, `IReadOnlyList<T>`, `ICollection<T>` and `IList<T>`.

```csharp
using System;
using System.Collections.Generic;

var values = new List<int> { 1, 2, 3 };
Print(values);  // Normal form.
Print(4, 5, 6); // Expanded form: enabled by params collections in C# 13.

static void Print(params IEnumerable<int> values)
{
    foreach (int value in values)
        Console.WriteLine(value);
}
```

The first call did not need this language feature: a non-`params` `IEnumerable<int>` parameter also accepts the list in older C#. C# 13 adds the expanded `Print(4, 5, 6)` form for that parameter type. Constructing an interface-backed collection for an expanded call can allocate.

Keep `params` last, do not give it a default value, and do not combine it with `ref`, `in` or `out`. Adding a params-collection overload can change overload resolution when callers recompile; check your API's actual call sites.

For the difference between owning a collection and viewing its storage, see [List, Span and ReadOnlySpan](/2026/05/list-vs-span-vs-readonlyspan-in-csharp/).

## Sources

- [C# 13 params collections specification](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/params-collections.md)
- [C# method parameters: params modifier](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/method-parameters#params-modifier)
