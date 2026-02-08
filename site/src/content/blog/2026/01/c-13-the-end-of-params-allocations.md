---
title: "C# 13: The End of `params` Allocations"
description: "For over two decades, the params keyword in C# has come with a hidden tax: implicit array allocations. Every time you called a method like string.Format or your own helper with a variable number of arguments, the compiler silently created a new array. In high-performance scenarios (hot paths), these allocations added up, triggering unnecessary Garbage…"
pubDate: 2026-01-02
tags:
  - "net"
  - "net-9"
---
For over two decades, the `params` keyword in C# has come with a hidden tax: implicit array allocations. Every time you called a method like `string.Format` or your own helper with a variable number of arguments, the compiler silently created a new array. In high-performance scenarios (hot paths), these allocations added up, triggering unnecessary Garbage Collection (GC) pressure.

With C# 13 and .NET 9, that tax is finally being repealed. You can now use `params` with collection types other than arrays, including `Span<T>` and `ReadOnlySpan<T>`.

## The Array Tax

Consider a typical logging method before C# 13.

```cs
// Old C# way
public void Log(string message, params object[] args)
{
    // ... logic
}

// Usage
Log("User {0} logged in", userId); // Allocates new object[] { userId }
```

Even if you passed a single integer, the runtime had to allocate an array on the heap. For libraries like Serilog or ASP.NET Core logging, this meant finding creative workarounds or overloading methods with 1, 2, 3… arguments to avoid the array.

## Zero-Allocation with `params ReadOnlySpan<T>`

C# 13 allows the `params` modifier on any type that supports collection expressions. The most impactful change is support for `ReadOnlySpan<T>`.

```cs
// C# 13 way
public void Log(string message, params ReadOnlySpan<object> args)
{
    // ... logic using span
}

// Usage
// Compiler uses stack allocation or shared buffers!
Log("User {0} logged in", userId);
```

When you call this new method, the compiler is smart enough to pass the arguments using a stack-allocated buffer (via `stackalloc`) or other optimizations, completely bypassing the heap.

## Beyond Arrays

It’s not just about performance. `params` now supports `List<T>`, `HashSet<T>`, and `IEnumerable<T>`. This improves API flexibility, allowing you to define the _intent_ of the data structure rather than forcing an array.

```cs
public void ProcessTags(params HashSet<string> tags) 
{
    // O(1) lookups immediately available
}

ProcessTags("admin", "editor", "viewer");
```

## When to Switch

If you are maintaining a library or a performance-sensitive application running on .NET 9, audit your `params` methods.

1.  Change `params T[]` to `params ReadOnlySpan<T>` if you only need to read the data.
2.  Change to `params IEnumerable<T>` if you need deferred execution or generic flexibility.

This small change in signature can significantly reduce memory traffic across your application’s lifetime.
