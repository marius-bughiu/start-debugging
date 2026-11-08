---
title: "How to tell the C# nullable analyzer a member is not null when HasValue is true"
description: "Put [MemberNotNullWhen(true, nameof(X), nameof(Y))] on the HasValue property itself, naming the members that become non-null. It works for nullable value types and reference types, but the compiler barely checks the getter, ignores base-class members, and never notices when the state changes afterwards. Verified on .NET 10 SDK 10.0.302 and .NET 11 RC3."
pubDate: 2026-11-08
template: how-to
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "nullable"
  - "how-to"
---

Put `[MemberNotNullWhen(true, nameof(X), nameof(Y))]` from `System.Diagnostics.CodeAnalysis` on the `HasValue` property (not on `X` or `Y`), listing every member that is guaranteed non-null when the property returns `true`. After `if (!obj.HasValue) return;` the compiler then treats `obj.X` and `obj.Y` as non-null, so `X.Value` stops raising `CS8629` and `Name.Length` stops raising `CS8602`. The attribute is public in .NET 5 and later; on `netstandard2.0`/`2.1` or .NET Framework you declare an `internal` copy yourself. Everything below was compiled with the .NET 10 SDK 10.0.302 (C# 14, Roslyn 5.6.0) and the .NET 11 SDK 11.0.100-rc.3.26522.148 (C# 15, Roslyn 5.12.0), with identical diagnostics on both.

## Why the analyzer cannot see through HasValue

Nullable analysis is flow analysis over the method you are in. It tracks the null state of each local, field and property it touches, and it learns from tests it can see: `x is not null`, `x.HasValue`, `x != null`. A call into another member is opaque. When you write `if (!HasValue) return null;`, the compiler sees "some `bool` property returned `true`", nothing more. It does not inline the getter, so it never learns that `HasValue => Position.HasValue` implies anything about `X => Position?.x`.

This is the situation from a [Stack Overflow question](https://stackoverflow.com/questions/79896016) asked in February 2026. A Unity-style tile class wraps a `Vector2Int?` and exposes convenience properties:

```csharp
// .NET 10 SDK 10.0.302, C# 14, <Nullable>enable</Nullable>
public readonly record struct Vector2Int(int x, int y);

public class Tile
{
    public Vector2Int? Position { get; set; }

    public bool HasValue => Position.HasValue;

    public int? X => Position?.x;
    public int? Y => Position?.y;

    public (float, float)? Iso()
    {
        if (!HasValue) return null;
        return (0.5f * (X.Value - Y.Value), 0.25f * (X.Value + Y.Value));
    }
}
```

`dotnet build` reports:

```
Repro.cs(18,25): warning CS8629: Nullable value type may be null.
Repro.cs(18,35): warning CS8629: Nullable value type may be null.
```

Only two warnings, on the first `X.Value` and the first `Y.Value`. After a successful `.Value` read the analyzer marks that property as non-null for the rest of the method, which is a useful detail when you are counting warnings to see whether a fix worked.

The asker had found `MemberNotNullWhenAttribute` but believed it was internal. It is not. The confusion is common because many libraries ship an `internal` polyfill of it (more on that below), and "Go to definition" in such a project lands on the internal copy.

## Annotating the HasValue property

The attribute goes on the member that does the checking, and its arguments name the members that become safe:

1. Add `using System.Diagnostics.CodeAnalysis;`.
2. Put `[MemberNotNullWhen(true, ...)]` on `HasValue`, passing `nameof` for each member that is non-null whenever `HasValue` returns `true`. The constructor takes `params string[]`, so one attribute can name several members.
3. Include the backing member (`Position`) as well as the computed ones, so callers can use either.
4. Rebuild with `--no-incremental` and confirm the `CS8629`/`CS8602` warnings at the call sites are gone.

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public readonly record struct Vector2Int(int x, int y);

public class Tile
{
    public Vector2Int? Position { get; set; }

    [MemberNotNullWhen(true, nameof(Position), nameof(X), nameof(Y))]
    public bool HasValue => Position.HasValue;

    public int? X => Position?.x;
    public int? Y => Position?.y;

    public (float, float)? Iso()
    {
        if (!HasValue) return null;
        return (0.5f * (X.Value - Y.Value), 0.25f * (X.Value + Y.Value));
    }
}
```

This builds with zero warnings. Note the order of ideas, because the accepted answer on Stack Overflow had to correct exactly this: the asker wrote `[MemberNotNullWhen(true, nameof(HasValue))]` and intended to put it on `X`. The attribute describes what a `bool`-returning member guarantees about *other* members, so it always sits on the `bool` member.

Writing the attribute three times, once per member, is equivalent; `AllowMultiple = true` is set on the attribute. One attribute with three names is just shorter.

## It works for Nullable&lt;T&gt; and for reference types

The question is about `int?`, which is `Nullable<int>`, a value type. People sometimes assume the nullable *reference type* attributes do nothing for value types. They do: the analyzer tracks "may be null" for `Nullable<T>` members and the attribute updates that state, which is why `CS8629` disappears above. The same attribute on a `string?` property removes `CS8602` on `Name.Length`.

For a result type, the `false` form reads better:

```csharp
// .NET 10 SDK 10.0.302, C# 14
using System.Diagnostics.CodeAnalysis;

public struct Result
{
    public string? Error { get; init; }

    [MemberNotNullWhen(false, nameof(Error))]
    public bool IsSuccess => Error is null;
}

static int Describe(Result r) => r.IsSuccess ? 0 : r.Error.Length; // no warning
```

That compiles clean with `Result` as a `struct` too, so the receiver being a value type does not matter. If you already use the Try pattern with `[NotNullWhen(true)] out` parameters, as covered in [Try pattern vs throwing exceptions](/2026/10/try-pattern-vs-throwing-exceptions-for-expected-failures-in-csharp/), `[MemberNotNullWhen]` is the same idea for members of `this` instead of out parameters.

## Call sites the analyzer follows, and the one it does not

Once `HasValue` is annotated, every way of observing its result that the compiler can see as a branch works. Each of these compiled without a warning on both SDKs:

```csharp
// .NET 10 SDK 10.0.302, C# 14 -- all warning-free
static int OtherInstance(Tile t) { if (t.HasValue) return t.X.Value; return 0; }
static int Pattern(Tile t) { if (t is { HasValue: true }) return t.X.Value; return 0; }
static int Assert(Tile t) { Debug.Assert(t.HasValue); return t.X.Value; }
static int Throw(Tile t) { if (!t.HasValue) throw new InvalidOperationException(); return t.X.Value; }
static int NullCond(Tile? t) { if (t?.HasValue == true) return t.X.Value; return 0; }
static int Ternary(Tile t) => t.HasValue ? t.X.Value : 0;
static int Neg(Tile t) { if (t.HasValue == false) return 0; return t.X.Value; }
static async Task<int> AfterAwait(Tile t) { if (!t.HasValue) return 0; await Task.Yield(); return t.X.Value; }
```

The attribute applies to whatever receiver you call it on, so `t.HasValue` informs `t.X`, not only `this.X`. `Debug.Assert` works because its condition parameter is marked `[DoesNotReturnIf(false)]`.

The one pattern that fails is storing the result first:

```csharp
// .NET 10 SDK 10.0.302, C# 14
static int LocalBool(Tile t)
{
    bool ok = t.HasValue;
    if (ok) return t.X.Value; // warning CS8629: Nullable value type may be null.
    return 0;
}
```

The analyzer does not remember that `ok` came from `HasValue`. Test the property directly in the condition, or use a pattern.

## The compiler barely checks your getter

`[MemberNotNullWhen]` is a promise, and the compiler verifies much less of it than you might expect. These are the cases from a test class with `string? Name`, `string? Other` and `int? Count`:

```csharp
// .NET 10 SDK 10.0.302, C# 14
[MemberNotNullWhen(true, nameof(Name))]
public bool ConstTrue => true;                                  // CS8775

[MemberNotNullWhen(true, nameof(Name))]
public bool Inverted => Name is null;                           // CS8775

[MemberNotNullWhen(true, nameof(Count))]
public bool CountInverted => !Count.HasValue;                   // CS8775

[MemberNotNullWhen(true, nameof(Name))]
public bool WrongMember => Other is not null;                   // no warning

[MemberNotNullWhen(true, nameof(Name), nameof(Other))]
public bool OnlyOne => Name is not null;                        // no warning, Other never tested

[MemberNotNullWhen(true, nameof(Name))]
public bool Coin => Random.Shared.Next(2) == 0;                 // no warning
```

The warning text is `CS8775: Member 'Name' must have a non-null value when exiting with 'true'.` The pattern in the results: the compiler flags a literal `return true` when the member is still maybe-null on that path, and it flags a returned condition that tests the named member with the wrong polarity. It does not flag a condition that tests a different member, forgets one of several names, or computes `true` from something unrelated. In those cases the attribute is simply trusted.

The original `Tile` example falls in the trusted category for `X` and `Y`: `Position.HasValue` says nothing about the computed properties, yet there is no `CS8775`. That is fine there because `X` really is non-null whenever `Position` has a value, but nothing would catch a refactor that breaks the relationship. A unit test that asserts `X is not null` when `HasValue` is true is cheap insurance for these annotations.

## The analyzer's knowledge goes stale

Flow analysis does not know that `X` depends on `Position`, and it does not invalidate property state when you call a method. This compiles without a single warning:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public class Tile
{
    public Vector2Int? Position { get; set; }

    [MemberNotNullWhen(true, nameof(Position), nameof(X))]
    public bool HasValue => Position.HasValue;
    public int? X => Position?.x;
    public void Clear() => Position = null;
}

var t = new Tile { Position = new(3, 4) };
if (!t.HasValue) return;
t.Clear();
Console.WriteLine(t.X.Value); // no warning
```

and running it throws:

```
Unhandled exception. System.InvalidOperationException: Nullable object must have a value.
   at System.Nullable`1.get_Value()
```

Assigning `t.Position = null;` directly between the check and the read is only half-caught: `t.Position.Value` then warns, but `t.X.Value` still does not, because the analyzer has no link between the two properties. This is the general trade-off of nullable analysis rather than a bug in the attribute, but `[MemberNotNullWhen]` on computed properties makes it easier to hit, because the "real" state lives somewhere the analyzer is not looking. The same stale-read shape shows up at runtime in other forms, for example [`Nullable object must have a value` in an EF Core projection](/2026/09/fix-nullable-object-must-have-a-value-in-an-ef-core-11-projection/).

Lambdas created inside the guarded block also inherit the "not null" state (`Func<int> f = () => t.X.Value;` does not warn), even though the lambda may run much later, after the state changed.

## Which members you can name

Some combinations are rejected with a warning, and one is silently ignored. All verified on both SDKs:

| Annotated member | Named member | Result |
| --- | --- | --- |
| instance property | instance field or property of the same type | works |
| static property | static field or property | works |
| instance property | static field or property | works |
| static property | instance field or property | silently ignored, callers still get `CS8602` |
| property in a derived class | property declared in the base class | `CS8776: Member 'Name' cannot be used in this attribute.` |
| any | misspelled string, or a method (`nameof(ToString)`) | `CS8776` |

The base-class rule is the one that surprises people. Members named by `[MemberNotNull]` and `[MemberNotNullWhen]` must be declared on the same type as the annotated member, so a `HasName` property added in a derived class cannot vouch for an inherited `Name`. Either move the `bool` property to the base class or expose the check there and call it. The static-naming-instance case is the same rule that makes [`[MemberNotNull]` do nothing on a static factory method](/2026/10/fix-membernotnull-has-no-effect-on-a-static-factory-method/): a static member has no `this` to describe.

## Interfaces, overrides and implementations

The attribute is read from the member the call binds to:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public interface ITile
{
    int? X { get; }

    [MemberNotNullWhen(true, nameof(X))]
    bool HasValue { get; }
}

public class TileImpl : ITile
{
    public int? X { get; set; }
    public bool HasValue => X.HasValue; // no attribute here
}

static int ViaInterface(ITile t) => t.HasValue ? t.X.Value : 0;    // no warning
static int ViaClass(TileImpl t) => t.HasValue ? t.X.Value : 0;     // CS8629
```

Annotating the interface does not carry over to the implementing class when callers hold the concrete type, so repeat the attribute on the implementation. A `virtual` property behaves differently: an `override` that omits the attribute still gave warning-free call sites through a reference typed as the derived class in these builds, so the base declaration is honoured for overrides.

## Polyfilling for netstandard2.0, netstandard2.1 and .NET Framework

`MemberNotNullWhenAttribute` shipped in .NET 5. A multi-targeted library that includes `netstandard2.0` or `netstandard2.1` fails on those targets:

```
Lib/Tile.cs(6,6): error CS0246: The type or namespace name 'MemberNotNullWhen' could not be found
```

`netstandard2.1` has `[NotNullWhen]` and friends, but not the member variants. The compiler matches these attributes by full name, not by assembly, so you can declare your own copy in the right namespace and it behaves like the real one:

```csharp
// Polyfill, compiled only for targets that lack the attribute
#if !NET5_0_OR_GREATER
namespace System.Diagnostics.CodeAnalysis
{
    [AttributeUsage(AttributeTargets.Method | AttributeTargets.Property, Inherited = false, AllowMultiple = true)]
    internal sealed class MemberNotNullWhenAttribute : Attribute
    {
        public MemberNotNullWhenAttribute(bool returnValue, string member)
        {
            ReturnValue = returnValue;
            Members = new[] { member };
        }

        public MemberNotNullWhenAttribute(bool returnValue, params string[] members)
        {
            ReturnValue = returnValue;
            Members = members;
        }

        public bool ReturnValue { get; }
        public string[] Members { get; }
    }
}
#endif
```

With that file added to a library targeting `netstandard2.0;netstandard2.1;net8.0`, all three targets build. The `internal` attribute also works across the assembly boundary: a `net10.0` console app referencing the `netstandard2.0` build of the library compiled `if (t.HasValue) Console.WriteLine(t.X.Value + 1);` without a warning, printed `5`, and got `CS8629` back as soon as the attribute was commented out in the library. The attribute is stored in the library's metadata, and the consuming compiler only cares about its name.

Keep the polyfill `internal` so it never leaks into your public API. One of the Stack Overflow answers also suggests marking it with `[Microsoft.CodeAnalysis.Embedded]`, to avoid clashes when `InternalsVisibleTo` exposes your copy to another assembly that declares its own (that scenario was not part of the builds above). If you would rather not maintain the file, the [PolySharp](https://github.com/Sergio0694/PolySharp) source generator (1.16.0 at the time of writing) emits these nullable attributes for the targets that need them.

## When an attribute is the wrong tool

Two of the Stack Overflow answers argue for not needing the attribute at all, and they have a point for the original code. If the only reason for `HasValue`, `X` and `Y` is to compute something from `Position`, pattern-match once and work with the non-nullable value:

```csharp
// .NET 10 SDK 10.0.302, C# 14
public (float, float)? Iso() =>
    Position is { } p ? (0.5f * (p.x - p.y), 0.25f * (p.x + p.y)) : null;
```

The analyzer fully understands this, nothing can go stale between the check and the use, and there is no promise to keep in sync. Reach for `[MemberNotNullWhen]` when the `bool` member is part of a public API that callers branch on, such as `HasValue`, `IsSuccess`, `IsLoaded` or `TryInitialize()`, and you want their code to be warning-free without `!`. For the constructor-time version of the same problem, where the warning is `CS8618` rather than a dereference warning, see [fixing CS8618 on non-nullable properties](/2026/07/fix-cs8618-non-nullable-property-must-contain-a-non-null-value-when-exiting-constructor/). And when the goal is just to assign through a possibly-null receiver, C# 14 now has [null-conditional assignment](/2026/02/csharp-14-null-conditional-assignment/).

## Sources

- Microsoft Learn, [Attributes for null-state static analysis](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/attributes/nullable-analysis) (the "Helper methods: MemberNotNull and MemberNotNullWhen" section).
- Microsoft Learn, [MemberNotNullWhenAttribute class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.membernotnullwhenattribute).
- Stack Overflow, [How to indicate that a C# field is not null by return value from another getter](https://stackoverflow.com/questions/79896016) and its answers.
- [PolySharp](https://github.com/Sergio0694/PolySharp) on GitHub.
