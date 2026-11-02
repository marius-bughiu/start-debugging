---
title: "List<T> vs Span<T> vs ReadOnlySpan<T> in C#: when to reach for which"
description: "Choose List<T> for a growable collection, Span<T> for a mutable view, and ReadOnlySpan<T> for reading contiguous memory. Understand lifetime and async limits."
pubDate: 2026-05-25
updatedDate: 2026-11-02
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
---

`List<T>` owns a growable collection. `Span<T>` is a fixed-length view over contiguous storage, and `ReadOnlySpan<T>` prevents writing through that view. They solve different problems: replacing a list with a span does not make ownership, growth or lifetime management disappear.

**Correction — November 2, 2026:** removed unverified .NET 11 benchmark numbers and corrected span-return, field and version claims. The examples below were checked with SDK 10.0.302 and C# 14; no universal speedup is claimed.

## Choose by ownership and lifetime

| Need | Suitable starting point |
| --- | --- |
| Append items while building a collection | `List<T>` |
| Read or modify an existing contiguous region synchronously | `Span<T>` |
| Read a contiguous region without writing through the view | `ReadOnlySpan<T>` |
| Keep a view in an ordinary class or across `await` | `Memory<T>` / `ReadOnlyMemory<T>` |

A span does not own its buffer. Array-backed spans can be returned when the backing storage has a valid lifetime. A span over a method's `stackalloc` buffer cannot be returned. A span may be a field of another `ref struct`, but not an ordinary class or struct. It cannot be boxed or captured by a lambda.

Starting with C# 13, ref-struct locals can be used in async methods where they do not remain live across an `await`. Use a memory-based view for data that must survive that boundary. Read-only access through a view does not make the underlying buffer immutable; another alias may still modify it.

## Mutation without copying

```csharp
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

var values = new List<int> { 3, 9, 4 };
Span<int> view = CollectionsMarshal.AsSpan(values);
view[1] = 20;
Console.WriteLine(values[1]); // 20

int[] array = { 10, 20, 30 };
Span<int> tail = Tail(array);
tail[0] = 99;
Console.WriteLine(array[1]); // 99

static Span<int> Tail(int[] source) => source.AsSpan(1);
```

Both views share their original storage. `Tail` is a valid span return; it does not refer to a local stack buffer. With `CollectionsMarshal.AsSpan`, do not add or remove list items while the view is in use, even when an operation would not resize the backing array. Prefer the ordinary list API unless a measured need justifies this lower-level access.

## Read-only input

```csharp
using System;

ReadOnlySpan<char> text = "2026-05-25".AsSpan(0, 4);
ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(int.Parse(text)); // 2026
Console.WriteLine(method.Length);   // 3
```

Strings provide `ReadOnlySpan<char>`, while a UTF-8 literal provides `ReadOnlySpan<byte>`. A mutable span converts to a read-only span; the reverse conversion is unavailable. Accept the read-only form when your method does not need to modify elements.

C# 14 shipped with .NET 10. Basic array-to-span implicit conversions existed earlier; C# 14 added language-level support in more binding situations, including generic inference and extension-method receivers. C# 13's `allows ref struct` permits ref-struct generic arguments only when the generic API explicitly opts in; it does not make `List<Span<int>>` legal.

## Measure the operation you are changing

Span slicing can avoid a copy or a substring allocation. It does not guarantee that every loop beats a list loop: JIT optimizations, runtime version, data size and the actual work matter. A returned `string`, newly created array or list still allocates even when a span is used along the way. Keep a benchmark's complete source, configuration and output before publishing timings.

For buffers needed across asynchronous work, see [array-to-ReadOnlyMemory conversion](/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/). For parsing and scratch buffers, see [when spans can improve performance](/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).

## Sources

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
