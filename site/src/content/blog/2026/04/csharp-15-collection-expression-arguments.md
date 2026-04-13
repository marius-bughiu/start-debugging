---
title: "C# 15 Collection Expression Arguments: Pass Constructors Inline with with(...)"
description: "C# 15 adds the with(...) element to collection expressions, letting you pass capacity, comparers, and other constructor arguments directly in the initializer."
pubDate: 2026-04-13
tags:
  - "csharp-15"
  - "dotnet-11"
  - "collection-expressions"
---

Collection expressions landed in C# 12 and have been absorbing new capabilities ever since. C# 15, shipping with [.NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview), adds a missing piece: you can now pass arguments to the collection's constructor or factory method with a `with(...)` element placed at the start of the expression.

## Why this matters

Before C# 15, collection expressions inferred the target type and called its default constructor. If you needed a case-insensitive `HashSet<string>` or a `List<T>` pre-sized for a known capacity, you had to fall back to a traditional initializer or a two-step setup:

```csharp
// C# 14 and earlier: no way to pass a comparer via collection expression
var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Hello", "HELLO" };

// Or the awkward two-step
List<string> names = new(capacity: 100);
names.AddRange(source);
```

Both patterns break the concise flow that collection expressions were designed for.

## Inline constructor arguments with `with(...)`

C# 15 lets you write this instead:

```csharp
string[] values = ["one", "two", "three"];

// Pre-allocate capacity
List<string> names = [with(capacity: values.Length * 2), .. values];

// Case-insensitive set in a single expression
HashSet<string> set = [with(StringComparer.OrdinalIgnoreCase), "Hello", "HELLO", "hello"];
// set.Count == 1
```

The `with(...)` element must appear first. After it, the rest of the expression works exactly like any other collection expression: literals, spreads, and nested expressions all compose normally.

## Dictionaries get the same treatment

The feature really shines with `Dictionary<TKey, TValue>`, where comparers are common but previously forced you off collection expressions entirely:

```csharp
Dictionary<string, int> headers = [
    with(StringComparer.OrdinalIgnoreCase),
    KeyValuePair.Create("Content-Length", 512),
    KeyValuePair.Create("content-length", 1024)  // overwrites the first entry
];
// headers.Count == 1
```

Without `with(...)`, you could not pass a comparer through a collection expression at all. The only option was a constructor call followed by manual adds.

## Constraints to know

A few rules to keep in mind:

- `with(...)` must be the **first** element in the expression.
- It is not supported on arrays or span types (`Span<T>`, `ReadOnlySpan<T>`), since those don't have constructors with configuration parameters.
- Arguments cannot have `dynamic` type.

## A natural evolution

C# 12 gave us the syntax. C# 13 extended `params` to accept collection expressions. C# 14 broadened implicit span conversions. Now C# 15 removes the last common reason to abandon collection expressions: constructor configuration. If you are already on [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) or later, you can try this today with `<LangVersion>preview</LangVersion>` in your project file.

Full spec: [Collection expression arguments proposal](https://github.com/dotnet/csharplang/blob/main/proposals/collection-expression-arguments.md).
