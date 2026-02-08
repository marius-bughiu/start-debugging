---
title: "C# language version history"
description: "The evolution of C# has transformed it into a modern, high-performance language. This guide tracks every major milestone. The Early Years (C# 1.0 – 1.2) C# launched in 2002 as a primary language for the .NET Framework. It felt like Java but with a focus on Windows development. Version 1.2 arrived shortly after with small…"
pubDate: 2024-12-01
updatedDate: 2026-02-08
tags:
  - "csharp"
  - "dotnet"
---
The evolution of C# has transformed it into a modern, high-performance language. This guide tracks every major milestone.

## The Early Years (C# 1.0 – 1.2)

C# launched in 2002 as a primary language for the .NET Framework. It felt like Java but with a focus on Windows development. Version 1.2 arrived shortly after with small improvements like `IDisposable` support in foreach loops.

The language had the following goals:

> -   It is intended to be simple, modern, general purpose, and object oriented programming language.
> -   It should include strong type checking, array bound checking, detection of attempts to use uninitialized variables, source code portability and automatic garbage collection.
> -   It is intended for use in developing software components than can take advantage of distributed environments.
> -   As programmer portability is very much important, especially for those programmers already familiar with C & C++, C# is best suitable.
> -   Provide support for internationalization, as it was very important.
> -   It is intended to be suitable for writing applications for both hosted and embedded systems.
> 
> [Source: C# design goals](https://feeldotneteasy.blogspot.com/2011/01/c-design-goals.html)

## Major Productivity Shifts (C# 2.0 – 5.0)

These versions introduced the features we use most today.

-   **C# 2.0:** Generics, anonymous methods, and nullable types changed how we handle data.
-   **C# 3.0:** LINQ, lambda expressions, and extension methods made querying data much easier.
-   **C# 4.0:** This version added the `dynamic` keyword and optional parameters.
-   **C# 5.0:** The `async` and `await` keywords revolutionized asynchronous programming.

## The Modern Compiler Era (C# 6.0 – 9.0)

With the Roslyn compiler, updates became faster and more frequent.

-   **C# 6.0 & 7.0:** These versions focused on "syntactic sugar" like expression-bodied members and tuples.
-   **C# 8.0:** Nullable reference types helped developers avoid common null-pointer exceptions.
-   **C# 9.0:** Records and top-level statements simplified data modeling and reduced boilerplate code.

## Recent Advancements (C# 10.0 – 13.0)

The language now evolves annually alongside .NET.

-   **C# 10 & 11:** Global using directives and raw string literals improved developer productivity.
-   **C# 12 & 13:** Primary constructors for classes and ref struct improvements kept the language competitive.

## What’s New in C# 14?

Released with .NET 10, C# 14 introduces several quality-of-life improvements.

### The field Keyword

You no longer need to manually declare backing fields for properties. The `field` keyword allows you to access the compiler-generated field directly inside accessors.

```csharp
public string Name { 
    get => field; 
    set => field = value ?? "Unknown"; 
}
```

### Extension Members

C# 14 expands extension methods. You can now define extension properties, static members, and even operators within a new `extension` block.

### Other Key Features

-   **Null-Conditional Assignment:** Use `?.=` to assign values only if the target is not null.
-   **Implicit Span Conversions:** Arrays and strings now convert to spans more naturally.
-   **Lambda Modifiers:** You can use `ref`, `in`, and `out` on lambda parameters without explicit types.
-   **Partial Constructors:** Source generators can now define signatures for constructors in partial classes.
