---
title: "Fix: CS8509 or CS0161 on a switch that is exhaustive over a C# 15 union type"
description: "Switch on the union value, not .Value, and use a switch expression or add case null to a switch statement. Statements need null coverage that expressions only warn about."
pubDate: 2026-10-01
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "pattern-matching"
---

Switch on the union value itself, not on its `.Value` property, and prefer a switch expression. If you need a switch statement in a method that returns, add a `case null:` arm (or a `throw` after the switch): the compiler only treats a switch statement over a union as complete when the null `Value` of a `default` union is covered. All behaviour below was measured on the .NET 11 RC1 SDK (`11.0.100-rc.1.26425.128`, C# 15, no `LangVersion` override needed).

## The error in context

You declared a union, you matched every case type, and the compiler still says you did not:

```text
warning CS8509: The switch expression does not handle all possible values of its input type (it is not exhaustive). For example, the pattern '_' is not covered.
error CS0161: 'Pets.Describe(Pet)': not all code paths return a value
error CS0165: Use of unassigned local variable 's'
warning CS8655: The switch expression does not handle some null inputs (it is not exhaustive). For example, the pattern 'null' is not covered.
error CS8780: A variable may not be declared within a 'not' or an 'or' pattern or a union matching involving matching against either the instance, or its underlying value.
```

They are five different symptoms of the same misunderstanding: union exhaustiveness in C# 15 is a property of **union matching**, and union matching only kicks in under specific conditions. Step outside those conditions and you are back to plain `object` pattern matching, where two type patterns are never exhaustive.

## Why the compiler does not see your switch as exhaustive

The C# 15 [unions specification](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#union-exhaustiveness) says it in one line: a union type is assumed to be "exhausted" by its case types, so a `switch` expression is exhaustive if it handles all of the union's case types. Everything else follows from the fine print.

1. **The input must be the union value.** Union matching only happens "when the input value of a pattern is of a union type or of a nullable of a union type". Switching on `pet.Value` (typed `object?`) or on a union that was boxed into `object` gives the compiler no case list, so it asks for `_`.
2. **Switch statements are stricter than switch expressions.** A switch expression with an unhandled `null` compiles with a CS8655 warning. A switch statement used for definite assignment or return-path analysis only counts as complete when `null` is also covered, so the end of the `switch` stays reachable and you get CS0161 or CS0165.
3. **A union `Value` can always be null.** `public union Pet(Cat, Dog)` lowers to a struct with a `public object? Value { get; }`. `default(Pet)` holds `null`, and so does `new Pet((Cat)null!)`. The spec lists this under [well-formedness](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#well-formedness): `Value` is "null or a value of a case type".
4. **Type parameters do not unwrap.** A case type `T` in `union Result<T>(T, Exception)` cannot be pattern-matched with a designation, because the compiler cannot prove whether `T v` should test the union instance or its contents. That is CS8780.

## Minimal repro

```csharp
// .NET 11 RC1 SDK 11.0.100-rc.1.26425.128, C# 15, <Nullable>enable</Nullable>
public record Cat(string Name);
public record Dog(string Name);
public union Pet(Cat, Dog);
public union MaybePet(Cat?, Dog);
public union Result<T>(T, Exception);

static class Pets
{
    // OK: no diagnostics
    static string A(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: pattern '_' is not covered
    static string B(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

    // CS0161: not all code paths return a value
    static string Describe(Pet p)
    {
        switch (p)
        {
            case Cat c: return c.Name;
            case Dog d: return d.Name;
        }
    }

    // CS8655: pattern 'null' is not covered (Cat? is a nullable case type)
    static string D(MaybePet p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8509: a union boxed into object is just an object
    static string E(object o) => o switch { Cat c => c.Name, Dog d => d.Name };

    // CS8655: Nullable<Pet> can be null
    static string F(Pet? p) => p switch { Cat c => c.Name, Dog d => d.Name };

    // CS8780 on 'TV v'
    static string I<TV>(Result<TV> r) => r switch { TV v => v!.ToString()!, Exception e => e.Message };
}
```

Method `A` is the reference point: the union value goes straight into a switch expression, every case type has an arm, and the compiler is silent. Every other method breaks one of the four rules above.

## Fix, in detail

Work through these in order. The first one fixes most real-world reports.

### 1. Match the union, not `.Value`

`Value` is declared as `object?`. The moment you dereference it, you have thrown away the union type and its case list. Pattern matching on the union already unwraps the contents for you: `p is Cat c` is compiled as a test on `p.Value`, so there is no reason to reach for `.Value` yourself.

```csharp
// .NET 11 RC1, C# 15
// Before: CS8509
static string Name(Pet p) => p.Value switch { Cat c => c.Name, Dog d => d.Name };

// After: exhaustive, no default arm
static string Name(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };
```

The same applies to a union that travels through an `object`, `IUnion`, or a generic `T` parameter. Per the spec's [resolved question](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#resolved-confirm-that-a-type-parameter-is-never-a-union-type-even-when-constrained-to-one), a type parameter is never a union type, even when constrained to one. In RC1, `static string L<TU>(TU u) where TU : struct, IUnion => u switch { Cat c => ..., Dog d => ... }` does not even get to exhaustiveness: it fails with CS8121, "An expression of type 'TU' cannot be handled by a pattern of type 'Cat'". Keep the concrete union type in the signature.

One partial exception: property patterns on `Value` do pick up union knowledge in RC1. `r switch { { Value: TV v } => ..., { Value: Exception e } => ... }` produced only CS8655, not CS8509. The spec still lists "Should direct Value property matching follow Union rules?" as an open question, so do not build on it.

### 2. Prefer a switch expression; give a switch statement a `case null`

This is the CS0161 / CS0165 case and the most surprising one, because the identical arms work as an expression. I measured three variants on RC1:

```csharp
// .NET 11 RC1, C# 15
public union Pet(Cat, Dog);
public closed class Shape;
public sealed class Sq : Shape;
public sealed class Ci : Shape;

// error CS0161
static string S1(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; } }

// compiles
static string S2(Pet p) { switch (p) { case Cat c: return c.Name; case Dog d: return d.Name; case null: return "none"; } }

// compiles: bool is exhaustive for statements
static int S3(bool b) { switch (b) { case true: return 1; case false: return 0; } }

// error CS0161: closed hierarchies behave like unions here
static int S4(Shape s) { switch (s) { case Sq: return 1; case Ci: return 0; } }
```

`S3` proves the compiler does do exhaustiveness for switch statements. What it does not do is ignore an uncovered `null`. A switch expression downgrades the missing `null` to a nullable warning (and, for a union whose case types are all non-nullable, to nothing at all). A switch statement uses the full exhaustiveness answer for reachability, and that answer includes `null`. Turning `#nullable disable` on does not change it: the RC1 compiler still reports CS0161 for both the union and the closed class.

You have three clean fixes, in order of preference:

```csharp
// .NET 11 RC1, C# 15
using System.Diagnostics;

// a) Use an expression. Most switch statements that only return can be one.
static string Describe(Pet p) => p switch { Cat c => c.Name, Dog d => d.Name };

// b) Cover null explicitly. Use this when a default union is a legitimate state.
static string Describe2(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
        case null: return "no pet";
    }
}

// c) Keep the statement and declare the end unreachable.
static string Describe3(Pet p)
{
    switch (p)
    {
        case Cat c: return c.Name;
        case Dog d: return d.Name;
    }
    throw new UnreachableException();
}
```

Avoid `default:` as the fix. It compiles, but it also swallows the next case type you add to the union, which is the one diagnostic you actually wanted to keep.

The CS0165 variant is the same issue in assignment form: `string s; switch (p) { case Cat c: s = ...; break; case Dog d: s = ...; break; } return s;` fails because the end of the switch is reachable with `s` unassigned. The same three fixes apply.

### 3. Handle null where the type says it can be null

CS8655 is the compiler being right. You get it in two situations:

- One of the case types is nullable, as in `union MaybePet(Cat?, Dog)`. The spec rule: the default null state of `Value` is "maybe null" if any case type is "maybe null".
- The input is `Pet?` (a `Nullable<Pet>`), which can be `null` on its own.

Add a `null` arm. On a union, `null` matches both a null instance and a union whose `Value` is null:

```csharp
// .NET 11 RC1, C# 15
static string D(MaybePet p) => p switch
{
    Cat c => c.Name,
    Dog d => d.Name,
    null => "none",
};
```

If the nullable case type was accidental, remove the `?` from the union declaration instead.

### 4. Drop the designation on type-parameter case types

For `union Result<T>(T, Exception)` the arm `T v` fails with CS8780 regardless of constraint. I tried unconstrained, `where T : notnull`, `where T : class`, and `where T : struct`: all four report CS8780 on RC1. What works is a type pattern without a variable, or catching the generic case last with `var`:

```csharp
// .NET 11 RC1, C# 15
public union Result<T>(T, Exception);

// Exhaustive and clean with notnull: prints "v:5" for new Result<int>(5)
static string W4<TV>(Result<TV> r) where TV : notnull =>
    r switch { TV => "v:" + r.Value, Exception => "e" };

// Match the concrete case first, let var take the rest
static string W3<TV>(Result<TV> r) =>
    r switch { Exception e => e.Message, var other => other.Value!.ToString()! };
```

Without the `notnull` constraint, the `TV =>` form still compiles but adds CS8655, because `TV` could be a nullable type. Note that `var` does not unwrap a union: `other` is the `Result<TV>`, not its contents, which is why you read `.Value` from it.

## The runtime half: a default union still throws

Silencing the compiler is not the same as handling every value. A union whose case types are all non-nullable gets no warning when you switch over `default`:

```csharp
// .NET 11 RC1, C# 15
public union Result2(int, Exception);

static string Show(Result2 r) => r switch { int v => v.ToString(), Exception e => e.Message };

Show(default); // System.Runtime.CompilerServices.SwitchExpressionException at runtime
```

The spec's resolved question "Default nullable state of `Value` property" acknowledges that `default(U).Value` is `null` while the nullable analysis only looks at the case types. In practice, a default union appears when it is a field that was never assigned, an array element, a `default` return in generic code, or a deserialized payload that did not populate the union. If any of those paths exist, add the `null` arm even though the compiler is not asking for one, or validate at the boundary. The same thinking applies to [non-nullable properties that are never set in a constructor](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/): the annotation describes intent, not a runtime guarantee.

## Gotchas and lookalikes

- **CS8846** ("However, a pattern with a 'when' clause might successfully match this value") means one case type is only covered under a `when` guard. Add an unguarded arm for that type. It is not a union bug.
- **CS8509 naming a concrete type**, like "the pattern 'Dog' is not covered", is the honest version of the error: you really are missing a case type. This is the diagnostic that fires everywhere when someone adds a case to a shared union, and the reason to avoid `default` and `_` arms.
- **Case types that are interfaces or base classes** are exhausted by that type, not by its subtypes. For `union Shape(IShape, string)`, arms for `Circle` and `Square` do not cover `IShape`. If you want subtype exhaustiveness, make the base a [closed class hierarchy](/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/) and add it as the case type.
- **Older previews.** If you are still on .NET 11 Preview 2 with hand-declared `UnionAttribute` and `IUnion` types, as described in the [original union types announcement](/2026/04/csharp-15-union-types-dotnet-11-preview-2/), exhaustiveness diagnostics changed between previews. Upgrade to RC1 before chasing any of the errors above.
- **Analyzers and generated code.** Code that receives unions as `object`, such as a JSON converter or a model binder, falls under rule 1. The serializer and binding behaviour is covered in [serializing C# union types with System.Text.Json](/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) and [where union binding works in ASP.NET Core 11](/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/).

## Related

- [C# 15 union types are here](/2026/04/csharp-15-union-types-dotnet-11-preview-2/) for the declaration syntax and implicit conversions.
- [C# 15 closed class hierarchies](/2026/06/csharp-15-closed-class-hierarchies-dotnet-11-preview-5/), which share the switch-statement behaviour measured above.
- [Serializing C# union types with System.Text.Json](/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) for unions that cross a wire boundary.
- [Returning multiple values from a method in C#](/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) if you are weighing a `Result<T>` union against tuples or out parameters.
- [Fix CS8618 for non-nullable properties](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/) for the nullable-analysis side of the same story.

## Sources

- [C# 15 unions specification (csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md): union matching, exhaustiveness, nullability, lowering, and the resolved questions quoted above.
- [Union types reference on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/union).
- [Pattern matching warnings, including CS8509, CS8655 and CS8846](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/pattern-matching-warnings).
- All diagnostics and runtime results reproduced locally with the .NET 11 RC1 SDK `11.0.100-rc.1.26425.128` on macOS, `net11.0`, `<Nullable>enable</Nullable>`.
