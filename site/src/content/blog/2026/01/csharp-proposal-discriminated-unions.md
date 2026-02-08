---
title: "C# Proposal: Discriminated Unions"
description: "A look at the C# discriminated unions proposal: the union keyword, exhaustive pattern matching, and how it could replace OneOf libraries and class hierarchies."
pubDate: 2026-01-02
updatedDate: 2026-01-04
tags:
  - "csharp"
  - "csharp-proposals"
---
The “holy grail” of C# features has been in talks for years now. And after years of relying on third-party libraries like `OneOf` or verbose class hierarchies, it looks like we may finally get native support for **Discriminated Unions (DUs)** in a future version of C#.

## The Problem: Representing “One Of”

If you wanted a function to return _either_ a generic `Success` result _or_ a specific `Error`, you had bad options:

1.  **Throw exceptions** (expensive for control flow).
2.  **Return `object`** (lost type safety).
3.  **Use a class hierarchy** (verbose and allows other inheritors).

## The Solution: `union` Types

The proposal introduces the `union` keyword, allowing you to define closed type hierarchies where the compiler knows every possible case.

```cs
// Define a union
public union Result<T>
{
    Success(T Value),
    Error(string Message, int Code)
}
```

This generates a highly optimized struct layout under the hood, similar to how Rust enums work.

## Exhaustive Pattern Matching

The real power of DUs comes when you consume them. The switch expression **must** be exhaustive. If you forget a case, the code won’t compile.

```cs
public string HandleResult(Result<int> result) => result switch
{
    Result.Success(var val) => $"Got value: {val}",
    Result.Error(var msg, _) => $"Failed: {msg}",
    // Compiler Error: No default case needed, but all cases must be covered!
};
```

## Why This Matters

If accepted, this feature would fundamentally change error handling in .NET. You could model domain states precisely (e.g., `Loading`, `Loaded`, `Error`) without the runtime overhead of class allocations or the cognitive overhead of complex visitor patterns.
