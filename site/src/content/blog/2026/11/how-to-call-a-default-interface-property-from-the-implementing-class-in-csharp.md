---
title: "How to use an interface's default property implementation from the class that implements it in C#"
description: "A default interface member is only reachable through the interface type, so new C().MyProperty fails with CS1061, a class property replaces the default, and ((I)this).MyProperty recurses forever. Here are the patterns that work on .NET 11 / C# 15, including a C# 14 extension property and a protected static helper, verified on SDK 11.0.100."
pubDate: 2026-11-23
tags:
  - "csharp"
  - "dotnet"
  - "interfaces"
  - "csharp-14"
---

A default interface member belongs to the interface, not to the class. If the class declares nothing, the default body runs, but you can only reach it through an expression of the interface type: `I x = new C(); x.MyProperty`. The moment the class declares its own public `MyProperty`, that member implicitly implements `I.MyProperty` and the default is gone, which is why `public int MyProperty => ((I)this).MyProperty;` calls itself until the process dies. There is still no `base(I).MyProperty` in C# 15. To expose the default on the class, leave the class silent and add a C# 14 extension property on `I`; to reuse the default from an override, move the body into a `protected static` helper on the interface. Every example below was compiled and run with the .NET 11 SDK (11.0.100, C# 15, `net11.0`) on macOS arm64.

## The three attempts that all fail

This comes from [a Stack Overflow question](https://stackoverflow.com/questions/80009314) that had no answers at the time of writing. The asker has an interface with a default property and tried three ways to get at it from the class:

```csharp
// .NET 11 SDK 11.0.100, C# 15
public interface I
{
    int MyProperty => 10;
}
```

Each attempt fails for a different reason, and the reasons explain the whole feature.

### Attempt 1: declare the property on the class, get 0

```csharp
// .NET 11 SDK 11.0.100, C# 15
var c = new C();
Console.WriteLine($"c.MyProperty      = {c.MyProperty}");
Console.WriteLine($"((I)c).MyProperty = {((I)c).MyProperty}");

public interface I
{
    int MyProperty => 10;
}

public class C : I
{
    public int MyProperty { get; } // implicitly implements I.MyProperty
}
```

Output:

```
c.MyProperty      = 0
((I)c).MyProperty = 0
```

Both lines print `0`, not `10`. A public instance member with a matching name and signature is an implicit implementation of the interface member. The auto-property is not a "shadow" that sits next to the default; it replaces the default for every caller, including callers that go through `I`. An interface's default body is only the fallback used when the most specific implementation in the class hierarchy is the interface's own.

### Attempt 2: declare nothing, get CS1061

```csharp
// .NET 11 SDK 11.0.100, C# 15
var c = new C();
Console.WriteLine(c.MyProperty);

public interface I
{
    int MyProperty => 10;
}

public class C : I { }
```

```
Program.cs(3,21): error CS1061: 'C' does not contain a definition for 'MyProperty' and no accessible extension method 'MyProperty' accepting a first argument of type 'C' could be found
```

This is the design, not a bug. Default interface members are not inherited by classes. The [default interface methods specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-8.0/default-interface-methods) says a class does not inherit members from its interfaces, and that stays true when those members have bodies. The member exists, the runtime will dispatch to it, but member lookup on `C` does not find it. The reason is versioning: default interface members were added (C# 8, .NET Core 3.0) so a library could add a member to a published interface without breaking implementers. If adding `int MyProperty => 10;` to `I` suddenly put a new public member on every class that implements `I`, it could collide with, or silently change overload resolution for, existing members of those classes. Keeping the default visible only through `I` avoids that. The same rule is behind the warning in our post on [source-breaking versus binary-breaking changes in a .NET library](/2026/10/what-is-the-difference-between-a-source-breaking-and-a-binary-breaking-change-in-a-dotnet-library/).

### Attempt 3: forward with a cast, get a stack overflow

```csharp
// .NET 11 SDK 11.0.100, C# 15
Console.WriteLine(new C().MyProperty);

public interface I
{
    int MyProperty => 10;
}

public class C : I
{
    public int MyProperty => ((I)this).MyProperty;
}
```

```
Stack overflow.
Repeated 261273 times:
--------------------------------
   at C.get_MyProperty()
--------------------------------
   at Program.<Main>$(System.String[])
```

This one combines the first two lessons. Because `C.MyProperty` is public and matches, it is the implementation of `I.MyProperty`. Casting `this` to `I` does not change which implementation the runtime picks; interface dispatch on a `C` instance lands on `C.get_MyProperty` again. The getter calls itself, and the process is killed with an uncatchable `StackOverflowException`. Casting to the interface is a way to choose which *slot* you call, not which *body* runs. It only reaches the default body when the class has no implementation of that slot.

## Call it through the interface type

If you only need the value in calling code, keep the class empty and type the variable, parameter, or field as the interface:

```csharp
// .NET 11 SDK 11.0.100, C# 15
I asInterface = new C();
Console.WriteLine(asInterface.MyProperty); // 10

public interface I
{
    int MyProperty => 10;
}

public class C : I { }
```

This is the intended usage. Code that depends on `I` rather than on `C` never notices whether the member has a default body or a class implementation. If you find yourself needing the property on the concrete type a lot, the question is usually whether a default member was the right tool (more on that at the end).

## Use the default from inside the class

Inside `C`, `this` is a `C`, so `this.MyProperty` hits the same CS1061. A private property typed as the interface gives you a short handle that reads cleanly at every call site:

```csharp
// .NET 11 SDK 11.0.100, C# 15
Console.WriteLine(new C().Describe()); // MyProperty is 10

public interface I
{
    int MyProperty => 10;
}

public class C : I
{
    // No MyProperty member here, so I.MyProperty keeps its default body.
    private I Self => this;

    public string Describe() => $"MyProperty is {Self.MyProperty}";
}
```

`((I)this).MyProperty` inline is the same thing with more punctuation. Both are safe here for exactly one reason: `C` does not implement `MyProperty`. Add a public `MyProperty` to `C` later and `Self.MyProperty` starts calling that instead, so do not combine this pattern with a class member of the same name.

## Put the default on the class's public surface with a C# 14 extension property

This is the closest thing to what the asker wanted: `new C().MyProperty` returns `10` and the class declares nothing. C# 14 added [extension members](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/extension), including extension properties, and an extension property on `I` is found for any type that converts to `I`:

```csharp
// .NET 11 SDK 11.0.100, C# 15 (extension blocks need C# 14+)
var c = new C();
Console.WriteLine(c.MyProperty); // 10

public interface I
{
    int MyProperty => 10;
}

public class C : I { }

public static class IExtensions
{
    extension(I source)
    {
        public int MyProperty => source.MyProperty;
    }
}
```

Why this does not recurse: member lookup on `c` (type `C`) finds no instance member called `MyProperty`, so the compiler falls back to extensions and binds to `IExtensions.MyProperty`. Inside the extension, `source` is typed `I`, where instance lookup does find `I.MyProperty`, and instance members always win over extensions. So the extension forwards once to the real interface member, and the runtime dispatches to the default body (or to a class implementation, if a type provides one).

Two details matter in practice:

- If `C` later declares its own `MyProperty`, the extension is simply never chosen for `C`, and callers get the class's value with no ambiguity. That is the same "instance beats extension" rule covered in [how to declare extension properties in C# 14](/2026/06/how-to-declare-extension-properties-in-csharp-14/).
- If a type implements two interfaces and you write same-named extension properties for both, calls on that type become ambiguous. That failure mode, and how to resolve it, is the subject of [fixing "The call is ambiguous" after moving to C# 14 extension members](/2026/08/fix-the-call-is-ambiguous-after-moving-to-csharp-14-extension-members/).

On C# 13 or older, a classic extension method (`public static int GetMyProperty(this I source) => source.MyProperty;`) does the same job, just without property syntax. For the broader feature, see the overview of [C# 14 extension members](/2026/02/csharp-14-extension-members/).

## Override the property but still reuse the default: a protected static helper

The hard case is the one people actually hit: the class wants its own `MyProperty`, but computed *from* the default, for example `default + 1`. In a class hierarchy you would write `base.MyProperty + 1`. For interfaces, the equivalent `base(I).MyProperty` was designed for C# 8 and then cut. It does not exist in C# 15, even with `<LangVersion>preview</LangVersion>` on SDK 11.0.100:

```
Program.cs(3,47): error CS0175: Use of keyword 'base' is not valid in this context
Program.cs(3,52): error CS0119: 'I' is a type, which is not valid in the given context
```

The champion issue, [dotnet/csharplang#2337 "base(T) phase two"](https://github.com/dotnet/csharplang/issues/2337), records the 2019 design discussion and was closed in December 2024 without the feature shipping. Since there is no syntax to call "the interface's body" once a class has claimed the slot, give the body a name of its own. Interfaces can contain static members since C# 8, and a `protected` static member of an interface is accessible to classes that implement it:

```csharp
// .NET 11 SDK 11.0.100, C# 15
var c = new C();
Console.WriteLine($"c.MyProperty       = {c.MyProperty}");
Console.WriteLine($"((I)c).MyProperty  = {((I)c).MyProperty}");
Console.WriteLine($"new D().MyProperty = {new D().MyProperty}");

public interface I
{
    protected static int DefaultMyProperty() => 10;

    int MyProperty => DefaultMyProperty();
}

public class C : I
{
    // Overrides the default, but builds on it.
    public int MyProperty => I.DefaultMyProperty() + 1;
}

public class D : I
{
    // Re-exposes the default on the class's public surface.
    public int MyProperty => I.DefaultMyProperty();
}
```

```
c.MyProperty       = 11
((I)c).MyProperty  = 11
new D().MyProperty = 10
```

`protected` keeps the helper out of everyone else's IntelliSense. A static class that does not implement `I` gets this when it tries to call it:

```
Program.cs(9,34): error CS0122: 'I.DefaultMyProperty()' is inaccessible due to its protection level
```

When the default body needs other interface members, pass the instance in: `protected static int DefaultMyProperty(I self) => self.Other * 2;`. Be careful what you call on `self` inside that helper. If the helper reads `self.MyProperty`, and the class's `MyProperty` calls the helper, you have rebuilt attempt 3.

This is also the pattern to use if you own the interface and expect implementers to want "base" behavior. If you do not own the interface, you cannot add the helper, and the only options left are duplicating the default body or not implementing the member at all.

## Structs: the default body runs on a boxed copy

Everything above uses classes. With a struct, reaching a default member means boxing, and a default body that mutates state mutates the box:

```csharp
// .NET 11 SDK 11.0.100, C# 15
var counter = new Counter();
((ICounter)counter).Increment();
Console.WriteLine($"after cast call     : {counter.Count}");

ICounter boxed = counter;
boxed.Increment();
boxed.Increment();
Console.WriteLine($"boxed copy          : {boxed.Count}, original: {counter.Count}");

IncrementInPlace(ref counter);
Console.WriteLine($"generic ref helper  : {counter.Count}");

static void IncrementInPlace<T>(ref T value) where T : struct, ICounter => value.Increment();

public interface ICounter
{
    int Count { get; set; }
    void Increment() => Count++;
}

public struct Counter : ICounter
{
    public int Count { get; set; }
}
```

```
after cast call     : 0
boxed copy          : 2, original: 0
generic ref helper  : 0
```

The first line is the expected boxing surprise: the cast creates a copy on the heap and `Increment` updates that copy. The last line is the one that catches people who know the usual trick. A generic method constrained to `struct, ICounter` normally calls interface members on the struct in place, with no box, via a `constrained.` call. That works when the struct implements the member itself. When the member resolves to a default interface body, the body's `this` is an interface reference, so the runtime boxes the value to make the call and the increment is lost even through `ref T`. If a struct needs a mutating member, implement it on the struct; do not leave it to a default body. If you are deciding between a struct and a class for a type like this in the first place, the [record vs class vs struct decision matrix](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) covers the tradeoffs.

## Target runtime: CS8701 on .NET Framework and .NET Standard 2.0

Default interface members need runtime support, which arrived in .NET Core 3.0. Raising `LangVersion` does not help on older targets. A `netstandard2.0` class library with the same interface fails on SDK 11.0.100:

```
I.cs(3,23): error CS8701: Target runtime doesn't support default interface implementation.
```

The same applies to any .NET Framework target. If your interface lives in a library that multi-targets `netstandard2.0`, either restrict default members to the modern targets with `#if NET` or keep the shared logic in a static helper class instead.

## Picking the right pattern

- You only consume the value: type the variable as `I`. No extra code.
- The class's own methods need the default: a private `I Self => this;` and no same-named member on the class.
- Callers of the concrete type need `c.MyProperty`: a C# 14 extension property on `I`, class stays silent.
- The class wants to override and build on the default: move the default body into a `protected static` helper on the interface and call it from both places.
- Many implementers want shared state or "base" behavior: that is what an abstract base class is for. Default interface members cannot hold instance fields, cannot be called with `base`, and are invisible on the class. They are a versioning tool for adding members to published interfaces, and they work best when implementers never need to think about them.

The C# docs tutorial on [updating interfaces with default interface methods](https://learn.microsoft.com/en-us/dotnet/csharp/advanced-topics/interface-implementation/default-interface-methods-versions) shows that versioning scenario end to end, including the "call it through the interface" rule from the second attempt above.

## Sources

- [Stack Overflow: How to implement the default implementation of an interface in a class?](https://stackoverflow.com/questions/80009314)
- [Default interface methods, C# 8 feature specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-8.0/default-interface-methods)
- [Tutorial: Update interfaces with default interface methods](https://learn.microsoft.com/en-us/dotnet/csharp/advanced-topics/interface-implementation/default-interface-methods-versions)
- [Extension declarations (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/extension)
- [dotnet/csharplang#2337: Champion "base(T) phase two"](https://github.com/dotnet/csharplang/issues/2337)
