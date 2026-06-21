---
title: "C# 15 Closed Class Hierarchies: The closed Keyword in .NET 11 Preview 5"
description: "C# 15 adds the closed modifier in .NET 11 Preview 5, giving class hierarchies compile-time exhaustiveness in switch expressions. Here is how it works and the one gotcha."
pubDate: 2026-06-21
tags:
  - "csharp"
  - "dotnet"
  - "csharp-15"
  - "dotnet-11"
---

[.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) shipped on June 9, 2026, and tucked into the C# 15 language work is a feature that quietly fixes one of the oldest gaps in the type system: there was no way to tell the compiler "this base class has exactly these subtypes." Now there is. The new `closed` modifier declares a closed class hierarchy, and switch expressions over it get full exhaustiveness checking at compile time.

This is the companion piece to [type unions](/2026/04/csharp-15-union-types-dotnet-11-preview-2/). Unions compose unrelated types; closed hierarchies lock down an inheritance tree you already own. Together they give C# a complete exhaustiveness story.

## What closed actually does

Mark a base class `closed` and the compiler only allows direct subtypes that live in the same assembly. Because the set of subtypes is now known and finite, the compiler can verify that a `switch` handles every reachable case.

```csharp
public closed record class GateState;
public record class Closed : GateState;
public record class Open(float Percent) : GateState;

static string Describe(GateState state) => state switch
{
    Closed => "closed",
    Open(var percent) => $"{percent}% open"
};
```

No `default` arm, no discard pattern, no `throw new InvalidOperationException("unreachable")`. The compiler already knows `Closed` and `Open` are the only options. Add a third subtype later and every non-exhaustive switch lights up with a warning, which is exactly the refactoring safety net that sealed-class-plus-visitor patterns never gave you.

## The rules that bite

A few constraints are worth committing to memory:

- A `closed` class is **implicitly abstract**. You cannot instantiate the base directly, and you cannot combine `closed` with `sealed`, `static`, or an explicit `abstract` modifier.
- Direct subtypes must be declared in the **same assembly**. Cross-assembly inheritance is blocked, which is what makes the closed set knowable.
- It applies to classes and `record class`, but **not structs**.

## The one gotcha in Preview 5

Here is the part that will trip you up. The compiler emits a `System.Runtime.CompilerServices.ClosedAttribute` marker, but the runtime in Preview 5 does not ship that attribute yet. Until it does, every project using `closed` has to declare the attribute itself:

```csharp
namespace System.Runtime.CompilerServices;

[AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)]
public sealed class ClosedAttribute : Attribute { }
```

Drop that into any file in the project and the feature compiles. Expect it to disappear in a later preview once the BCL carries the type. This is the usual preview tax, so do not bake the shim into a shared library you plan to ship.

Closed hierarchies, closed enums, and union types are all gated behind `<LangVersion>preview</LangVersion>` in C# 15 today, heading for general availability with .NET 11 in November 2026. If you have ever written a switch with an unreachable default just to satisfy the compiler, this is the feature that finally deletes it. Full details are in the [Preview 5 C# release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/csharp.md).
