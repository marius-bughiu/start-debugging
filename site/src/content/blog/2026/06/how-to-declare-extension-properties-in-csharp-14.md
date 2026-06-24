---
title: "How to declare extension properties in C# 14"
description: "Extension properties land in C# 14 through the new extension block. Declare get-only, settable, static, and generic extension properties, why auto-properties are rejected, and how the compiler lowers them to get_/set_ accessors."
pubDate: 2026-06-24
template: how-to
tags:
  - "how-to"
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "extension-members"
---

Short answer: declare an extension property inside an `extension` block in a static class. Name the receiver to add an instance property (`extension(string s) { public int WordCount => ...; }`), omit the name to add a static one (`extension(Point) { public static Point Origin => ...; }`). The property body is the getter; add a `set` accessor for a writable property. The one rule that trips everyone up: there are no extension fields, so an auto-property like `public int Count { get; set; }` will not compile. Every accessor must compute or forward to real storage.

This feature ships in C# 14, which requires the .NET 10 SDK or later (it works the same under the .NET 11 SDK). Set `<LangVersion>14</LangVersion>` or `<LangVersion>latest</LangVersion>` in your `.csproj`. Extension properties are one part of the broader extension members feature; this post is the focused guide to the property half. If you want the wider tour that also covers operators and static members, read the [C# 14 extension members overview](/2026/02/csharp-14-extension-members/).

## Why you could never write `string.WordCount` before C# 14

Extension methods have existed since C# 3.0, but they only ever extended one member kind: methods. If you wanted to add a computed value to a type you don't own, you had to spell it as a method call:

```csharp
// Before C# 14 - the only option was a method
public static class StringExtensions
{
    public static int WordCount(this string s) =>
        s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
}

// Call site reads like a function, not a property
int n = "hello there world".WordCount();
```

That trailing `()` is the tell. `WordCount` is conceptually a property of the string, but the language forced it into method shape. Auto-properties, computed properties, and indexers on types you don't control were simply out of reach. C# 14 closes that gap with the `extension` block, a container that can hold properties, operators, and static members alongside the old `this`-style methods.

## Declare an extension property in three steps

1. Create a non-generic, top-level static class to hold the extension. This is the same containment rule as classic extension methods: the class cannot be nested and cannot be generic.
2. Open an `extension` block and declare the receiver. Write `extension(string s)` to name the instance the property extends, or `extension(string)` with no name for a static property on the type itself.
3. Declare the property inside the block with an expression-bodied getter (or a full `get`/`set` body). Reference the receiver parameter by the name you gave it in step 2.

Put together, the `WordCount` example becomes a real property:

```csharp
// .NET 11, C# 14 - an instance extension property
public static class StringExtensions
{
    extension(string s)
    {
        public bool IsBlank => string.IsNullOrWhiteSpace(s);

        public int WordCount =>
            s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

Now the call site loses the parentheses and reads exactly like a built-in member:

```csharp
string title = "hello there world";
Console.WriteLine(title.WordCount);  // 3
Console.WriteLine(title.IsBlank);    // False
```

The receiver name (`s` here) is in scope for every member inside the block, so related properties share one declaration of what they extend. That is the whole point of the block: it groups members by the type they augment instead of repeating `this string` on every signature.

## Settable extension properties need somewhere to put the value

Extension properties are not read-only by default. You can add a `set` accessor, but because the runtime gives an extension no place to store data, the setter has to forward the value into storage that already exists on the receiver. A clean case is exposing an alternate view over a field the type already holds:

```csharp
// .NET 11, C# 14 - a get/set extension property over existing state
public class Sensor
{
    public double Celsius { get; set; }
}

public static class SensorExtensions
{
    extension(Sensor sensor)
    {
        public double Fahrenheit
        {
            get => sensor.Celsius * 9 / 5 + 32;
            set => sensor.Celsius = (value - 32) * 5 / 9;
        }
    }
}
```

The setter reads `value` like any property setter and writes through to the real `Celsius` field:

```csharp
var s = new Sensor { Celsius = 20 };
Console.WriteLine(s.Fahrenheit);  // 68
s.Fahrenheit = 212;
Console.WriteLine(s.Celsius);     // 100
```

What you cannot do is ask the compiler to invent storage for you. This is the single most common compile error people hit:

```csharp
public static class SensorExtensions
{
    extension(Sensor sensor)
    {
        // ERROR: an extension property cannot be an auto-property,
        // because there is no backing field to generate.
        public string Label { get; set; }
    }
}
```

There are no extension fields in C# 14, so there is no backing field to synthesize. Every accessor must have a body that computes a value or routes it through members the receiver already owns. If you genuinely need to attach new state to instances of a type you don't own, an extension property is the wrong tool; reach for a `ConditionalWeakTable<TKey, TValue>` keyed by the instance and expose it through the getter and setter.

## Mutating a struct needs a `ref` receiver

The `Sensor` example works because `Sensor` is a class, so the setter mutates the object everyone shares. For a value type, the receiver is copied by default, and a setter would silently mutate that throwaway copy. Declare the receiver `ref` to write back to the original, exactly as `this ref` worked for mutating extension methods:

```csharp
// .NET 11, C# 14 - ref receiver so the setter mutates the caller's struct
public static class PointExtensions
{
    extension(ref System.Drawing.Point p)
    {
        public int ManhattanLength
        {
            get => Math.Abs(p.X) + Math.Abs(p.Y);
        }
    }
}
```

A `ref` receiver also means the property can only be used on an addressable variable, not on a temporary like the result of a method call. That restriction is the same one `ref` extension methods have always carried, and it is what keeps the mutation safe.

## Static extension properties drop the receiver name

Omit the parameter name and the block extends the type itself rather than an instance. This is how you add named constants or factory-style values that read as static members of a type you don't own:

```csharp
// .NET 11, C# 14 - a static extension property on a type you don't own
using System.Drawing;

public static class PointExtensions
{
    extension(Point)
    {
        public static Point Origin => Point.Empty;
    }
}
```

The call site looks like a static member that was always there:

```csharp
Point start = Point.Origin;
```

Static and instance members can live in separate blocks inside the same class. Use a named receiver block for the instance members and a bare-type block for the static ones; the compiler is happy with both styles side by side in one static class.

## Generic extension properties: every type parameter must reach the receiver

Put the type parameters on the `extension` keyword and they flow to every member inside the block. This lets you add properties to open generic types like `IReadOnlyList<T>`:

```csharp
// .NET 11, C# 14 - generic extension properties
public static class ListExtensions
{
    extension<T>(IReadOnlyList<T> list)
    {
        public bool IsEmpty => list.Count == 0;

        public T? LastOrDefaultValue =>
            list.Count > 0 ? list[^1] : default;
    }
}
```

There is one hard constraint the compiler enforces: every type parameter declared on the block must be used by the receiver type. `extension<T>(IReadOnlyList<T> list)` is legal because `T` appears in `IReadOnlyList<T>`. A block like `extension<T>(string s)` that declares `T` but never uses it in the receiver is a compile error, because the compiler has nothing to infer `T` from at the call site. Constraints go on the block too:

```csharp
public static class ComparableExtensions
{
    extension<T>(IReadOnlyList<T> list) where T : IComparable<T>
    {
        public T Max
        {
            get
            {
                var max = list[0];
                for (int i = 1; i < list.Count; i++)
                    if (list[i].CompareTo(max) > 0) max = list[i];
                return max;
            }
        }
    }
}
```

## How the compiler lowers an extension property, and how to disambiguate

An extension property is pure compile-time sugar. The compiler turns the block into ordinary static accessor methods in a hidden nested type: a getter named `get_PropertyName` and, if present, a setter named `set_PropertyName`, each taking the receiver as its first argument. When you write `title.WordCount`, the compiler rewrites it to a call to that generated `get_WordCount` accessor. The lowered type-parameter order is receiver parameters first, then any method parameters, which matters only if you inspect the generated metadata.

Two consequences follow from this. First, resolution uses the same scoping rules as extension methods: the candidate in the nearest enclosing namespace or `using` wins, and when two extension properties of the same name are equally in scope you get an ambiguity error rather than a silent pick. You resolve it by narrowing the `using` directives, or by qualifying through the static class so the compiler knows which accessor you mean. Second, because the property exists only at the call site, it never appears in runtime reflection on the extended type: `typeof(string).GetProperty("WordCount")` returns `null`. Extension properties are a language convenience, not a runtime modification of the type, so anything that reflects over real members (serializers, data binding, ORMs) will not see them.

## Nullability is yours to declare

Because you write the receiver parameter yourself, you decide whether the property accepts a null receiver. Annotate the receiver nullable to write a property that is safe to call on a null reference, something an ordinary instance property can never be:

```csharp
// .NET 11, C# 14 - a null-tolerant extension property
public static class StringExtensions
{
    extension(string? s)
    {
        public bool HasText => !string.IsNullOrWhiteSpace(s);
    }
}

string? maybe = null;
Console.WriteLine(maybe.HasText);  // False, no NullReferenceException
```

This pairs well with the call-site null handling that arrived alongside it; see [C# 14 null-conditional assignment](/2026/02/csharp-14-null-conditional-assignment/) for the `?.` and `?[]` improvements on the left-hand side of an assignment.

## The edge cases worth knowing before you ship

A few rules and limits save you a confusing compiler error:

- **No fields, no auto-properties, no events, no constructors.** C# 14 extension blocks support methods, properties, indexers, and operators. Fields are explicitly excluded, which is exactly why auto-properties are rejected.
- **The container must be a non-generic, non-nested static class.** Put your type parameters on the `extension` block, not on the class.
- **A name collision with a real member loses.** If the extended type already has a `WordCount` property, the real one always wins and your extension property is never considered. Extensions only fill gaps; they never override.
- **Indexers follow the same shape.** You can declare `public T this[int i] => ...` inside an instance `extension` block, which gives you extension indexers on types that lack them.

Extension properties are the most ergonomic slice of the extension members work, and they compose cleanly with the rest of C# 14. If you are adding computed members to a type you control versus one you don't, weigh them against the other shaping tools in the release: the [extension-member trick for returning multiple values](/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) and the [user-defined compound assignment operators](/2026/04/csharp-14-user-defined-compound-assignment-operators/) both lean on the same syntax family.

## Sources

- [Explore extension members in C# 14 (Microsoft Learn tutorial)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members)
- [C# 14: Exploring extension members (.NET Blog)](https://devblogs.microsoft.com/dotnet/csharp-exploring-extension-members/)
- [Andrew Lock: C# 14 extension members, AKA extension everything](https://andrewlock.net/exploring-dotnet-10-preview-features-3-csharp-14-extensions-members/)
