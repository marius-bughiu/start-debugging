---
title: "How to write a static extension member that applies to every enum type in C# 14"
description: "Declare a generic extension block with a struct, Enum constraint and you get Status.Values, Status.Count, and Status.Parse on every enum in your solution. The receiver shape, the CS0704 and CS0428 traps, and why you must cache Enum.GetValues."
pubDate: 2026-08-23
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
  - "enums"
---

C# 14 lets you write a single extension block that adds static members to *every* enum type at once. The shape is `extension<TEnum>(TEnum) where TEnum : struct, Enum`, declared inside a non-generic static class, with the receiver parameter name omitted because the members are static. That gives you `Status.Values`, `Status.Count`, and `Status.Parse("active")` on every enum in your solution without writing a line per enum. Everything below was compiled and run against the .NET SDK 10.0.201 on runtime 10.0.5.

The catch is that three separate things will bite you: the type parameter is unreachable from inside a generic method, any member name that `System.Enum` already owns is silently shadowed, and the obvious implementation allocates a fresh array on every single call.

## Why the receiver has to be `TEnum`, not `Enum`

The instinct is to write `extension(Enum)` and be done, since every enum derives from `System.Enum`. That compiles, and it even resolves from a concrete enum type name:

```csharp
// .NET 10, C# 14 -- compiles and runs, but is a dead end
public static class B
{
    extension(Enum)
    {
        public static string Label => "Label:System.Enum";
    }
}

// both of these print "Label:System.Enum"
Console.WriteLine(Status.Label);
Console.WriteLine(Enum.Label);
```

Static extension members declared on the base type really are reachable through a derived enum's type name. But there is no type parameter in that block, so you cannot call any of the generic `Enum` APIs. `Enum.GetValues<TEnum>()`, `Enum.Parse<TEnum>`, and `Enum.TryParse<TEnum>` are exactly the APIs you want, and all of them need a `TEnum`. Without one you are back to reflection over `typeof`, boxing every value into `object`.

So the receiver has to carry the type parameter. The next instinct is `where TEnum : Enum`, which also compiles until you actually use it:

```csharp
extension<TEnum>(TEnum) where TEnum : Enum
{
    public static TEnum[] Values => Enum.GetValues<TEnum>();
}
```

```
error CS0453: The type 'TEnum' must be a non-nullable value type in order to use it
as parameter 'TEnum' in the generic type or method 'Enum.GetValues<TEnum>()'
```

`Enum` as a constraint permits `System.Enum` itself, which is an abstract reference type. The generic `Enum` helpers are all constrained to `struct, Enum`, so your block has to match. That leaves exactly one working shape.

## Declare the block in three steps

1. **Create a top-level, non-generic `static class`.** Extension blocks are only legal there. The class name never appears at the call site, so pick something descriptive like `EnumExtensions`.
2. **Write `extension<TEnum>(TEnum) where TEnum : struct, Enum` and omit the receiver parameter name.** MS Learn is explicit that "the extension parameter doesn't need to include the parameter name if the only members are static". Dropping the name is what signals that this block holds static members; a named receiver is for instance members.
3. **Declare `public static` members inside the block.** They bind against the concrete enum you name at the call site, so `TEnum` is inferred as `Status` when you write `Status.Values`.

```csharp
// .NET 10, C# 14
public static class EnumExtensions
{
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static TEnum[] Values => Enum.GetValues<TEnum>();
        public static int Count => Enum.GetValues<TEnum>().Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status { Draft = 1, Active = 2, Archived = 4 }
public enum Color { Red, Green, Blue }

Console.WriteLine(Status.Count);              // 3
Console.WriteLine(string.Join(",", Status.Values));  // Draft,Active,Archived
Console.WriteLine(Color.Parse("green"));      // Green
Console.WriteLine(Color.TryParse("BLUE", out var c));  // True
```

One block, and every enum in the compilation gained four static members. That is the whole payoff, and it is the part that genuinely was not expressible before C# 14. If you want a refresher on the surrounding feature, the [C# 14 extension members overview](/2026/02/csharp-14-extension-members/) covers operators and the non-generic cases, and [declaring extension properties](/2026/06/how-to-declare-extension-properties-in-csharp-14/) goes deeper on the property-specific rules.

## What the compiler actually emits

Extension blocks are not a runtime feature. Everything lowers to ordinary static methods on the enclosing static class, plus a compiler-generated marker type that carries the extension metadata. Reflecting over the class at runtime shows it:

```
--- emitted members on EnumExtensions ---
  NestedType <G>$1AEBB925A470955AA56007A9C9196757`1
  Method   get_Count
  Method   get_Values
  Method   Parse
  Method   TryParse
```

The `<G>$<hash>` nested type is the grouping type the compiler uses to record the receiver and its constraints. The members themselves are flat static methods, which is why extension blocks are binary compatible with the old `this`-parameter extension methods and why there is no dispatch cost at runtime.

That flat emission has a direct consequence, and it is the first thing that will surprise you.

## An extension block is not a scope

MS Learn states the rule plainly: "An extension doesn't introduce a scope for member declarations. All members declared in a single class, even if in multiple extensions, must have unique signatures." So an instance member and a static member with the same name collide even though they live in different blocks:

```csharp
public static class E2
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Tag => "instance";
    }
    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static string Tag => "static";   // CS0102
    }
}
```

```
error CS0102: The type 'E2' already contains a definition for 'Tag'
```

Split them across two static classes and the collision moves to the call site instead, where C# 14 has a dedicated diagnostic:

```
error CS9339: The extension resolution is ambiguous between the following members:
'C1.extension<Status>(Status).Count' and 'C2.extension<Status>(Status).Count'
```

CS9339 is worth recognising on sight, because a generic enum block applies to every enum in scope. Two libraries that both ship a `Values` extension will collide on every enum you own, and neither one is at fault. The same family of problems shows up when you move an old-style extension method into a block and forget to delete the original, which produces [CS0121 ambiguity after moving to extension members](/2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members/).

## `TEnum.Values` does not compile inside a generic method

This one costs the most time. The extension member resolves fine against a concrete enum name, but not against a type parameter:

```csharp
public static int CountOf<TEnum>() where TEnum : struct, Enum
{
    return TEnum.Values.Length;   // CS0704
}
```

```
error CS0704: Cannot do non-virtual member lookup in 'TEnum' because it is a type parameter
```

Static extension members are resolved by name lookup on a type, and a type parameter is not a type for that purpose. Only static *abstract* interface members participate in member lookup through a type parameter, and extension members are not interface members. There is no syntax that fixes this.

The practical answer is to keep the real implementation in a plain generic helper class and let the extension block be a thin facade over it. Generic code calls the helper directly; application code calls the pretty extension member. That split is also what solves the allocation problem below, so you get it for free.

## `Enum.GetValues<TEnum>()` allocates a new array on every call

`Enum.GetValues<TEnum>()` returns a fresh `TEnum[]` every time, because handing out a cached mutable array would let any caller corrupt it. A property that calls it per access turns a lookup into an allocation. Measured on runtime 10.0.5, Release build, one million accesses of a five-member enum, indexing into the result so the JIT cannot hoist the call:

| Implementation | Time | Allocated | Per op |
| --- | --- | --- | --- |
| `Enum.GetValues<TEnum>()` per access | 27.8 ms | 48,000,832 bytes | 48 B |
| static generic cache | 0.7 ms | 0 bytes | 0 B |

48 bytes per operation is the array header plus five 4-byte values, rounded to alignment. The number scales with the enum, so a 30-member enum costs more. Across three runs the uncached version measured 26.8 ms to 29.5 ms and the cached version 0.7 ms every time.

The fix is a static generic class. The CLR gives you one instance of its static fields per closed generic type, so `EnumInfo<Status>` and `EnumInfo<Color>` get separate storage, each initialised exactly once on first use:

```csharp
// .NET 10, C# 14
internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();
}
```

`ImmutableArray<TEnum>` matters here rather than `TEnum[]`: a cached array handed out from a property is mutable by every caller, and one `Values[0] = ...` silently poisons the cache for the whole process. `FrozenSet` is the right shape for membership checks, since it pays a higher build cost once in exchange for faster reads, which is exactly the tradeoff a per-type static cache wants. The [Dictionary vs FrozenDictionary benchmark](/2024/04/net-8-performance-dictionary-vs-frozendictionary/) has the numbers behind that choice.

## Names that `System.Enum` already owns are shadowed

Extension members are a fallback. Name lookup finds real members first, and only reaches for extensions when nothing applicable exists. `System.Enum` already declares `IsDefined`, so an extension member of that name never gets considered:

```csharp
extension<TEnum>(TEnum value) where TEnum : struct, Enum
{
    public bool IsDefined => Enum.IsDefined(value);
    public bool IsKnown => Enum.IsDefined(value);
}

Status s = Status.Active;
bool a = s.IsKnown;     // fine
bool b = s.IsDefined;   // CS0428
```

```
error CS0428: Cannot convert method group 'IsDefined' to non-delegate type 'bool'.
Did you intend to invoke the method?
```

The compiler found the `Enum.IsDefined` method group and stopped looking. The error message is actively misleading, because it suggests you forgot parentheses when the real problem is that your extension property is unreachable by that name. The same thing happens to static extension members: `Status.IsDefined` declared as a static extension property produces the identical CS0428.

Note that this is about names, not signatures. `GetValues` as an extension *method* works fine:

```csharp
extension<TEnum>(TEnum) where TEnum : struct, Enum
{
    public static TEnum[] GetValues() => Enum.GetValues<TEnum>();  // compiles
}

Status[] all = Status.GetValues();   // resolves to your extension
```

`Enum.GetValues` exists, but no overload of it is applicable with zero arguments, so lookup falls through to the extension. Relying on that is fragile. The safe rule is to avoid every name already on `System.Enum`: `IsDefined`, `Parse`, `TryParse`, `GetName`, `GetNames`, `GetValues`, `GetUnderlyingType`, `Format`, `ToObject`, `HasFlag`, and `CompareTo`. Picking `Values`, `Count`, `Names`, and `IsKnown` sidesteps the whole category.

`Parse` and `TryParse` are the awkward exceptions, because those are the names callers expect. They do currently resolve, for the same zero-applicable-overload reason as `GetValues`. If you want to be conservative, name them `ParseName` and `TryParseName`.

## The `[Flags]` decomposition trap

If you add a member that splits a flags value into its parts, the obvious implementation is wrong for any enum with a zero member:

```csharp
[Flags]
public enum Access { None = 0, Read = 1, Write = 2, Admin = Read | Write }

public ImmutableArray<TEnum> NaiveFlags =>
    [.. EnumInfo<TEnum>.Values.Where(f => value.HasFlag(f))];
```

```
naive : [None, Read, Write, Admin]
```

`HasFlag` is a subset test, so `x.HasFlag(None)` is true for every `x`, and composite members like `Admin` match too. Filtering to single-bit members fixes both problems at once:

```csharp
// .NET 10, C# 14 -- add to EnumInfo<TEnum>; needs using System.Numerics;
public static readonly ImmutableArray<TEnum> SingleBitFlags =
    [.. Enum.GetValues<TEnum>().Where(v =>
        BitOperations.PopCount(Convert.ToUInt64(v)) == 1)];

public ImmutableArray<TEnum> Flags =>
    [.. EnumInfo<TEnum>.SingleBitFlags.Where(f => value.HasFlag(f))];
```

```
fixed : [Read, Write]
none  : []
read  : [Read]
```

`Convert.ToUInt64` boxes, but it runs once per enum type inside the static initialiser, not per call.

## The version worth shipping

Putting the pieces together: a generic helper holding the caches, one static block for the type-level members, one instance block for the value-level members, and no name that `System.Enum` already owns.

```csharp
// .NET 10, C# 14
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.ComponentModel;
using System.Reflection;

internal static class EnumInfo<TEnum> where TEnum : struct, Enum
{
    public static readonly ImmutableArray<TEnum> Values = [.. Enum.GetValues<TEnum>()];
    public static readonly FrozenSet<TEnum> Defined = Enum.GetValues<TEnum>().ToFrozenSet();

    public static readonly FrozenDictionary<TEnum, string> Descriptions =
        Enum.GetValues<TEnum>()
            .DistinctBy(v => v)
            .ToFrozenDictionary(
                v => v,
                v => typeof(TEnum).GetField(v.ToString())
                        ?.GetCustomAttribute<DescriptionAttribute>()?.Description
                     ?? v.ToString());
}

public static class EnumExtensions
{
    extension<TEnum>(TEnum value) where TEnum : struct, Enum
    {
        public string Description => EnumInfo<TEnum>.Descriptions[value];
        public bool IsKnown => EnumInfo<TEnum>.Defined.Contains(value);
    }

    extension<TEnum>(TEnum) where TEnum : struct, Enum
    {
        public static ImmutableArray<TEnum> Values => EnumInfo<TEnum>.Values;
        public static int Count => EnumInfo<TEnum>.Values.Length;
        public static TEnum Parse(string name) => Enum.Parse<TEnum>(name, ignoreCase: true);
        public static bool TryParse(string name, out TEnum result)
            => Enum.TryParse(name, ignoreCase: true, out result);
    }
}
```

```csharp
public enum Status
{
    [Description("Not yet published")] Draft,
    [Description("Live")]              Active,
    Archived,
}
```

```
Status.Count      : 3
Status.Values     : [Draft, Active, Archived]
Description       : Not yet published
Description (none): Archived
IsKnown           : True / False
Parse             : Active
TryParse bad input: False
```

The `DistinctBy(v => v)` in the dictionary builder is not decoration. `Enum.GetValues` returns one entry per *member*, and two members can share a value (`Alias = Active`), which would throw a duplicate key exception without it. That is the same aliasing detail that makes enum persistence tricky, covered in [storing an enum as a string in EF Core 11](/2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter/).

Reflection in `Descriptions` means this pattern needs a trimming annotation if you publish with trimming or Native AOT enabled. Drop the `Description` member if you target either, or feed the strings from a source generator instead.

One boundary worth stating: extension members are resolved at compile time against a name you write in source. If your enum type is only known as a `Type` at runtime, none of this applies and you are back to the non-generic reflection APIs. Extension blocks make enums nicer to work with in code you compile, not in code you discover.

## Sources

- [Extension member declarations, C# reference](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/extension) on MS Learn, updated 2026-08-13
- [C# 14: Exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/) on the .NET Blog
- [Enum.GetValues&lt;TEnum&gt;()](https://learn.microsoft.com/en-us/dotnet/api/system.enum.getvalues) API reference
- [FrozenSet&lt;T&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.collections.frozen.frozenset-1) API reference
