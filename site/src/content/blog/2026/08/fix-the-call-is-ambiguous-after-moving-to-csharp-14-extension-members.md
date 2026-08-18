---
title: "Fix: The call is ambiguous between the following methods or properties after moving to C# 14 extension members"
description: "CS0121 after moving an extension method into a C# 14 extension block: the compiler still emits the old static form. Delete the duplicate or qualify the call."
pubDate: 2026-08-18
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "extension-members"
---

You moved a `this`-parameter extension method into a C# 14 `extension` block, kept the original around "just in case", and now every call site fails with CS0121. The fix is to delete one of the two declarations, because they are not two different things: the compiler lowers an extension block method into exactly the same static method with a `this` parameter that you already had. If you cannot delete either one (the other lives in a NuGet package), qualify the call with the containing static class: `MyExtensions.WordCount(s)` instead of `s.WordCount()`.

```
error CS0121: The call is ambiguous between the following methods or properties:
'New.StringExtensions2.extension(string).WordCount()' and 'Old.StringExtensions.WordCount(string)'
```

Note the shape of the message. One candidate is printed as `extension(string).WordCount()` and the other as `WordCount(string)`. That asymmetry is the whole diagnosis: Roslyn is telling you one candidate came from an extension block and the other from a classic `this`-parameter method, and it cannot pick between them. Everything below was verified on .NET SDK 10.0.201 with `<LangVersion>14.0</LangVersion>`.

## Why does CS0121 fire when both syntaxes are in scope?

C# 14 did not introduce a second, separate lookup mechanism for extension members. An extension block is a declaration syntax, and the compiler lowers it into a static class member that is indistinguishable from what `this string s` produces. When two `using` directives each bring a class into scope and both classes contribute a `WordCount(string)` candidate with identical applicability, overload resolution has no tiebreaker left, so it reports CS0121.

This is not a new rule. The same error has always fired when two libraries define the same extension method on the same type. What is new is that migrating your own code now creates the collision, because a half-finished migration leaves both forms alive at once.

## What does the compiler actually emit for an extension block?

This is the part worth internalising, because it explains every symptom on this page. Take a single block with one method and one property:

```csharp
// .NET 10.0.201, C# 14
namespace Lib;

public static class StringExtensions
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
        public bool IsBlank => string.IsNullOrWhiteSpace(s);
    }
}
```

Reflecting over the compiled `Lib.StringExtensions` in the same solution prints:

```
METHOD Int32 WordCount(String s) [Extension]
METHOD Boolean get_IsBlank(String s)
NESTED <G>$34505F560D9EACF86A87F3ED1F85E448 ext-attr=True
CLASS ext-attr=True
```

Three things fall out of that dump:

1. `WordCount` is emitted as a public static method taking the receiver as its first parameter, carrying `[ExtensionAttribute]`. It *is* a classic extension method in metadata. That is why it collides with a hand-written `this` method, and why writing both is a duplicate rather than a compatibility layer.
2. The property lowers to `get_IsBlank(String s)`, a public static method **without** `[ExtensionAttribute]`. Properties are not classic extension methods, so they are found by a different lookup path and they fail with a different diagnostic (see below).
3. The `<G>$<hash>` nested type is the content-based marker type the compiler generates per extension block. The hash is derived from the block's content, which is why two blocks with identical receivers and members in the same class collide with CS9329.

Because the lowered method really is a normal extension method, a project pinned to `<LangVersion>13.0</LangVersion>` can still consume it. I verified this with a project reference from a C# 13 app to a C# 14 library: `"a b c".WordCount()` and `StringExtensions.WordCount("a b c")` both compile and print `3`. Adding `"a b c".IsBlank` to the same file fails with `error CS9260: Feature 'extensions' is not available in C# 13.0`. Extension *methods* declared in a block are consumable from older language versions; extension *properties* are not.

## Minimal repro: two static classes, one method name

```csharp
// Old.cs -- .NET 10.0.201, C# 14
namespace Old;

public static class StringExtensions
{
    public static int WordCount(this string s) => s.Split(' ').Length;
}
```

```csharp
// New.cs -- .NET 10.0.201, C# 14
namespace New;

public static class StringExtensions2
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using Old;
using New;

System.Console.WriteLine("a b c".WordCount()); // CS0121
```

`dotnet build` fails on the call site, not on either declaration. That matters: the declarations are individually legal, so the error only appears in files that have both namespaces imported. A partially migrated solution will therefore build in some projects and fail in others, which reads like a flaky build until you look at the `using` lists.

The same thing happens across assemblies, which is the version most people actually hit. A library ships extension blocks, you keep a local `this`-method shim you wrote before the upgrade, and any file importing both namespaces breaks:

```
error CS0121: The call is ambiguous between the following methods or properties:
'Lib.StringExtensions.extension(string).WordCount()' and 'App.Compat.MyStringExtensions.WordCount(string)'
```

## How do I fix CS0121 when I own both declarations?

Delete the `this`-parameter version. That is the whole fix, and it is not a compromise: as shown above, the extension block still emits an `[ExtensionAttribute]`-marked static method with the identical signature, so every existing call site keeps working, including the fully qualified `MyExtensions.WordCount(s)` form and callers on older language versions.

```csharp
// .NET 10.0.201, C# 14 -- one declaration, both call shapes still work
namespace Lib;

public static class StringExtensions
{
    extension(string s)
    {
        public int WordCount() => s.Split(' ').Length;
    }
}

// both of these compile:
// "a b c".WordCount()
// StringExtensions.WordCount("a b c")
```

The migration rule to write on the whiteboard: **an extension block replaces the old method, it does not sit alongside it.** Every "keep the old one for compatibility" instinct is wrong here, because binary and source compatibility are already preserved by the lowering.

## How do I disambiguate when the duplicate lives in a NuGet package?

You cannot delete a declaration you do not own, so pick one of these, in order of preference.

**Call the static method directly.** Both candidates expose a static form, so name the class you want:

```csharp
// .NET 10.0.201, C# 14
System.Console.WriteLine(New.StringExtensions2.WordCount("a b c")); // extension block version
System.Console.WriteLine(Old.StringExtensions.WordCount("a b c"));  // this-parameter version
```

This compiles cleanly. It is verbose at the call site but it is unambiguous, greppable, and survives future package upgrades.

**Drop the `using` and switch to a namespace alias.** Extension members are only brought into scope by a plain `using` of the namespace. A namespace alias imports the *names* without contributing extension candidates:

```csharp
// .NET 10.0.201, C# 14
using OldAlias = Old; // types reachable as OldAlias.StringExtensions, but no extension candidates
using New;

System.Console.WriteLine("x".WordCount()); // binds to New, prints 2
```

I ran this exact file and it prints `2`. This is the cleanest option when a file needs types from a namespace but not its extensions. Watch out for `global using` directives in `GlobalUsings.cs` or `<Using Include="..."/>` items in the csproj, because those import extensions into every file in the project and are the usual reason the ambiguity appears in a file whose own `using` list looks innocent.

**Give the two members different names.** If you own the newer one and it is not yet published, renaming is cheaper than teaching the whole team a disambiguation rule.

## Can I mark the old method `[Obsolete]` to break the tie?

No. Obsolescence is not an overload resolution tiebreaker. The candidate stays applicable and the error is identical:

```csharp
// .NET 10.0.201, C# 14 -- still CS0121
[System.Obsolete("Use Lib")]
public static int WordCount(this string s) => 1;
```

`[Obsolete]` is useful for telling consumers to stop calling something, but it does nothing for the compiler's candidate set. The same goes for `[EditorBrowsable(EditorBrowsableState.Never)]`, which only hides members from IntelliSense.

## When do I get CS0111 instead of CS0121?

Because both declarations are in the *same* static class. Then it is not an ambiguous call, it is a duplicate member:

```csharp
// .NET 10.0.201, C# 14
namespace A;

public static class E1
{
    public static int WordCount(this string s) => 1;

    extension(string s)
    {
        public int WordCount() => 2; // CS0111
    }
}
```

```
error CS0111: Type 'E1' already defines a member called 'WordCount' with the same parameter types
```

CS0111 is reported on the declaration, before any call site exists. It is the friendlier of the two errors because it proves the equivalence directly: the compiler considers `WordCount(this string)` and the block's `WordCount()` to have the same parameter types. If you are migrating a class one method at a time, this is the error you will see first.

## What if the ambiguity is on an extension property (CS9339)?

Extension properties get their own diagnostic, because they are not `[ExtensionAttribute]` methods in metadata and are resolved through extension member lookup rather than plain overload resolution:

```csharp
// N1.cs -- .NET 10.0.201, C# 14
namespace N1;

public static class E
{
    extension(System.Text.StringBuilder b)
    {
        public int Cap { get => b.Capacity; set => b.Capacity = value; }
    }
}
```

```csharp
// N2.cs -- .NET 10.0.201, C# 14
namespace N2;

public static class E
{
    extension(System.Text.StringBuilder b)
    {
        public int Cap { get => b.Capacity; set => b.Capacity = value; }
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using N1;
using N2;

var sb = new System.Text.StringBuilder();
sb.Cap = 64; // CS9339
```

```
error CS9339: The extension resolution is ambiguous between the following members:
'N1.E.extension(System.Text.StringBuilder).Cap' and 'N2.E.extension(System.Text.StringBuilder).Cap'
```

The fix is the same shape but you have to name the accessor, since there is no property syntax that carries the class name:

```csharp
// .NET 10.0.201, C# 14 -- disambiguated, prints 64
N1.E.set_Cap(sb, 64);
System.Console.WriteLine(N1.E.get_Cap(sb));
```

`get_` and `set_` accessor methods are exactly what the block lowers to, so calling them is not a hack, it is calling the real member. It is ugly enough that you should treat it as a temporary unblock while you remove one of the duplicates. If you are still deciding how to shape these declarations, the rules for [declaring extension properties in C# 14](/2026/06/how-to-declare-extension-properties-in-csharp-14/) cover why auto-properties are rejected and what the accessors can do.

## Does a more specific receiver type break the tie?

Yes, and this is why only some of your call sites break. Overload resolution still prefers the better conversion from the receiver, and that comparison happens across both syntaxes. An extension block on `string` beats a `this`-parameter method on `IEnumerable<char>`:

```csharp
// Old.cs -- .NET 10.0.201, C# 14
namespace Old;

public static class E
{
    public static string Describe(this System.Collections.Generic.IEnumerable<char> s) => "IEnumerable<char>";
}
```

```csharp
// New.cs -- .NET 10.0.201, C# 14
namespace New;

public static class E
{
    extension(string s)
    {
        public string Describe() => "string";
    }
}
```

```csharp
// Use.cs -- .NET 10.0.201, C# 14
using Old;
using New;

System.Console.WriteLine("x".Describe()); // prints: string
```

A generic `this`-parameter method loses to a concrete extension block on the same receiver, and still wins for every other receiver type:

```csharp
// .NET 10.0.201, C# 14
// G1.E: public static string Kind<T>(this T value) => "generic this-method";
// G2.E: extension(string s) { public string Kind() => "extension block on string"; }

System.Console.WriteLine("x".Kind()); // extension block on string
System.Console.WriteLine(42.Kind());  // generic this-method
```

So a migration that changes a receiver from `IEnumerable<T>` to a concrete type will silently move some call sites to the new implementation without any error at all. That is a behaviour change hiding inside what looks like a syntax refactor, and it is worth a test rather than a compile.

## Does an instance method break the tie?

An instance member always wins over any extension member, in either syntax, with no diagnostic. If a type gains an instance method with a matching signature in a later version of a dependency, both of your extension declarations become unreachable and nothing warns you:

```csharp
// .NET 10.0.201, C# 14
public class Order { public decimal Total() => 10m; }
public static class E1 { public static decimal Total(this Order o) => 20m; }
public static class E2 { extension(Order o) { public decimal Total() => 30m; } }

// new Order().Total() prints 10
```

That program compiles without a warning and prints `10`. It is the mirror image of CS0121: two ambiguous extension members are noisy, two shadowed ones are silent. This is the same class of upgrade hazard as the [C# 14 overload resolution breaking change with spans](/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/), where a new implicit conversion quietly re-binds existing calls.

## What migration order avoids the error entirely?

1. Move the declarations, do not copy them. Cut the `this` method out of the static class and paste the body into an `extension` block in the same class. CS0111 will catch you immediately if you fumble that step, which is why doing the migration inside one class is safer than starting a new one.
2. Migrate a whole static class at a time. Half-migrated classes are fine; half-migrated *namespaces* with a parallel "V2" class are where CS0121 comes from.
3. Never create a `New` or `V2` extension class next to the old one. There is nothing to keep compatible, so the parallel class only buys you an ambiguity.
4. After the move, build the solution with `dotnet build` before touching call sites. Every call site that still compiles is proof the lowering matched.
5. Run the tests, not just the compiler. The receiver-specificity rules above mean a migration can change which implementation runs without breaking the build.

If you are doing this as part of a larger jump, the [.NET 8 to .NET 11 migration checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) sequences the language version bump against the runtime and package upgrades, which is the order that keeps this error from arriving alongside twenty others.

## Related

- [C# 14 extension members: extension properties, operators, and static extensions](/2026/02/csharp-14-extension-members/) for the full feature surface, including the operator and static member forms this post does not cover.
- [How to declare extension properties in C# 14](/2026/06/how-to-declare-extension-properties-in-csharp-14/) for the accessor rules behind the `get_` and `set_` disambiguation trick.
- [C# 15 extension indexers in .NET 11 Preview 6](/2026/07/csharp-15-extension-indexers-dotnet-11-preview-6/) for where the extension block syntax goes next.
- [Fix: C# 14 overload resolution breaking change with Span and ReadOnlySpan](/2026/05/fix-csharp-14-overload-resolution-breaking-change-with-spans/) for the other C# 14 change that re-binds existing call sites.
- [Migrate from .NET 8 to .NET 11: full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) for sequencing the language version bump.

## Sources

- [Resolve errors and warnings related to extension declarations](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/extension-declarations) on MS Learn, which lists CS9339 and the CS93xx family of extension block diagnostics.
- [Extension methods](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/classes-and-structs/extension-methods) on MS Learn, for the two declaration syntaxes and the disambiguation guidance.
- [C# 14: exploring extension members](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/) on the .NET Blog, which documents the lowering to `get_`-prefixed static methods and confirms the design goal that converting an extension method to the new syntax does not break its consumers.
- [Extensions discussion](https://github.com/dotnet/csharplang/discussions/8696) in dotnet/csharplang, the design thread for the feature.
