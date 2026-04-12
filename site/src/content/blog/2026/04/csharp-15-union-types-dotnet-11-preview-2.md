---
title: "C# 15 Union Types Are Here: Type Unions Ship in .NET 11 Preview 2"
description: "C# 15 introduces the union keyword for type unions with exhaustive pattern matching and implicit conversions. Available now in .NET 11 Preview 2."
pubDate: 2026-04-08
tags:
  - "csharp"
  - "dotnet"
  - "csharp-15"
  - "dotnet-11"
---

After years of proposals, workarounds, and third-party libraries like `OneOf`, C# 15 ships the `union` keyword in [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/csharp-15-union-types/). These are **type unions**: they compose existing types into a single closed type with compiler-enforced exhaustive pattern matching. No base classes, no visitor pattern, no runtime guesswork.

## What type unions look like

A union declares that a value is exactly one of a fixed set of types:

```csharp
public union Shape(Circle, Rectangle, Triangle);
```

`Shape` can hold a `Circle`, a `Rectangle`, or a `Triangle`, and nothing else. The compiler generates implicit conversions from each case type, so assignment is straightforward:

```csharp
Shape shape = new Circle(Radius: 5.0);
```

No explicit cast, no factory method. The conversion just works.

## Exhaustive pattern matching

The real payoff comes at consumption. A `switch` expression over a union must handle every case, or the compiler errors out:

```csharp
double Area(Shape shape) => shape switch
{
    Circle c    => Math.PI * c.Radius * c.Radius,
    Rectangle r => r.Width * r.Height,
    Triangle t  => 0.5 * t.Base * t.Height,
};
```

No default branch needed. If you later add `Polygon` to the union, every `switch` that doesn't handle it will break at compile time. That is the safety guarantee that class hierarchies and `OneOf<T1, T2>` can not provide at the language level.

## Unions can carry logic

You are not limited to a one-liner declaration. Unions support methods, properties, and generics:

```csharp
public union Result<T>(T, ErrorInfo)
{
    public string Describe() => Value switch
    {
        T val       => $"Success: {val}",
        ErrorInfo e => $"Error {e.Code}: {e.Message}",
    };
}
```

The `Value` property gives access to the underlying instance. Combined with generics, this makes `Result<T>` patterns first-class without external dependencies.

## How this differs from the earlier proposal

Back in January 2026, we [covered the discriminated union proposal](/2026/01/csharp-proposal-discriminated-unions/) that defined members inside the union itself (closer to F# or Rust enums). The shipped C# 15 design takes a different direction: **type unions compose existing types** rather than declaring new ones inline. This means your `Circle`, `Rectangle`, and `Triangle` are regular classes or records you already have. The union just groups them.

## Getting started

Install the [.NET 11 Preview 2 SDK](https://dotnet.microsoft.com/download/dotnet/11.0), target `net11.0`, and set `<LangVersion>preview</LangVersion>` in your project file. Note that in Preview 2, the `UnionAttribute` and `IUnion<T>` interface are not in the runtime yet: you need to declare them in your project. Later previews will include them out of the box.

Type unions are the single biggest type-system addition to C# since nullable reference types. If you have been modeling "one-of" relationships with inheritance trees or tuple hacks, now is a good time to prototype with the real thing.
