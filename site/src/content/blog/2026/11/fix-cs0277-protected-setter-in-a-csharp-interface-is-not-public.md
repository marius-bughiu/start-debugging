---
title: "Fix: CS0277 'does not implement interface member Offset.set. Offset.set is not public' with a protected setter"
description: "A class can only implicitly implement an interface accessor with a public accessor. Declare the interface property get-only and put the protected setter on the class, or implement the property explicitly."
pubDate: 2026-11-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "interfaces"
---

Make the interface property get-only (`float Offset { get; }`) and declare `public float Offset { get; protected set; }` on the class. That compiles on every C# version and gives derived classes the setter you wanted. `protected` on an interface member does not mean "protected in implementing classes": it means "usable inside this interface and interfaces that derive from it", and a class can only satisfy it with a `public` accessor (C# 10 and later) or an explicit implementation. Everything below was compiled with the .NET 11 SDK (11.0.100, C# 15) on macOS arm64.

## The error in context

```
error CS0277: 'Stat' does not implement interface member 'IStat.Offset.set'. 'Stat.Offset.set' is not public.
```

The code that produces it is the natural first attempt at "every implementation must have an `Offset` that only subclasses can change", the shape asked about in [this Stack Overflow question](https://stackoverflow.com/questions/80011658):

```csharp
// .NET 11, C# 15 -- fails with CS0277
public interface IStat
{
    public float Offset { get; protected set; }
}

public class Stat : IStat
{
    public float Offset { get; protected set; } = 0.0f;
}
```

The generic version from the question (`IStat<T>` with `T Offset { get; protected set; }`, implemented as `IStat<float>`) fails with the same message, `'Stat' does not implement interface member 'IStat<float>.Offset.set'`. Making the interface accessor `internal set` and the class accessor `internal set` fails the same way too. The access modifier is the problem, not generics.

## Why a protected interface setter cannot be implemented by a protected class setter

There are two separate rules colliding here.

**Rule 1: implicit implementation needs a public member.** When the compiler maps `IStat.Offset.set` to something on `Stat`, it only considers public members of the class as implicit implementations. `Stat.Offset.set` is `protected`, so it is not a candidate, the interface accessor stays unimplemented, and you get CS0277. This is the same rule that has always required `public` on a method that implements an interface method; accessors are just members too.

**Rule 2: `protected` on an interface member is about derived interfaces.** C# 8 allowed access modifiers on interface members as part of [default interface methods](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-8.0/default-interface-methods.md). A `protected` interface member is accessible inside the declaring interface and inside interfaces that derive from it. A class that implements the interface is not a "derived type" for this purpose in any useful way. You can see this in what the compiler says when the implementing class tries to use the protected setter through the interface:

```csharp
// .NET 11, C# 15 -- both lines fail
public interface IStat
{
    public float Offset { get; protected set; }
}

public class Stat : IStat
{
    public float Offset { get; set; }
    public void Reset() => ((IStat)this).Offset = 0f;
    // CS1540: Cannot access protected member 'IStat.Offset' via a qualifier of type 'IStat';
    //         the qualifier must be of type 'Stat' (or derived from it)
}

public static class Program
{
    public static void Main()
    {
        IStat i = new Stat();
        i.Offset = 4f;
        // CS0272: The property or indexer 'IStat.Offset' cannot be used in this context
        //         because the set accessor is inaccessible
    }
}
```

CS1540 is the classic "protected access must go through your own type" error, and here it can never be satisfied: an expression of type `Stat` never finds `IStat.Offset` through member lookup, because classes do not inherit interface members. The same thing happens with a protected member that has a default body. Calling it unqualified from the implementing class gives `CS0103: The name 'Raw' does not exist in the current context`. The [C# standard's interface chapter](https://github.com/dotnet/csharpstandard/blob/draft-v8/standard/interfaces.md) states it directly: members with an implementation in the interface "are not found through member lookup on a variable of type C".

So the intent "protected throughout all implementations" cannot be expressed on an interface at all. An interface describes what callers can do with an object. An accessor that no caller and no implementer can reach is not part of that contract.

## Fix 1 (recommended): get-only interface, protected setter on the class

This is the fix most people actually want. The interface promises only what outside code can see, which is a readable `Offset`. Each class decides how it is written.

```csharp
// .NET 11, C# 15 -- compiles and runs, prints 3 then 7
using System;

public interface IStat
{
    float Offset { get; }
}

public class Stat : IStat
{
    public float Offset { get; protected set; }
}

public class BuffedStat : Stat
{
    public void Apply(float delta) => Offset += delta;   // derived classes can set it
}

public class InitStat : IStat
{
    public float Offset { get; init; }                   // set once, at construction
}

public class PrivateProtectedStat : IStat
{
    public float Offset { get; private protected set; } // derived classes in the same assembly only
}

public static class Program
{
    public static void Main()
    {
        var b = new BuffedStat();
        b.Apply(3f);
        IStat i = b;
        Console.WriteLine(i.Offset);                            // 3
        Console.WriteLine(new InitStat { Offset = 7f }.Offset); // 7
    }
}
```

A get-only interface property is satisfied by any class property with a public getter, whatever the setter looks like. You can pick `protected set`, `private protected set`, `private set`, `init`, or a public `set`, per class. Outside code that tries `new Stat().Offset = 1f` gets `CS0272 ... the set accessor is inaccessible`, which is exactly the guarantee the original code was aiming for.

What you lose: the interface no longer forces implementers to have a setter at all. If that matters, you need a base class (Fix 3), because an interface has no way to force a non-public member onto a class. If the reason you wanted the setter in the contract was "the value must always be provided", consider `required` on the class property instead; [CS9035 and how required members behave](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/) covers what that enforces.

## Fix 2: explicit implementation, when derived interfaces need the setter

`protected` interface members do have a real use: they let a derived interface write default implementations that use a member outside code cannot touch. If that is your design, keep the protected setter on the interface and implement the property explicitly in the class:

```csharp
// .NET 11, C# 15 -- compiles and runs, prints 3.5
using System;

public interface IStat
{
    public float Offset { get; protected set; }
}

public interface IDerivedStat : IStat
{
    void Nudge(float by) => Offset += by;   // a derived interface CAN use the protected setter
}

public class Stat : IDerivedStat
{
    float IStat.Offset { get; set; }        // explicit implementation, no access modifier
}

public static class Program
{
    public static void Main()
    {
        IDerivedStat s = new Stat();
        s.Nudge(2.5f);
        s.Nudge(1f);
        Console.WriteLine(s.Offset);        // 3.5
    }
}
```

A few things are worth knowing about this shape:

- Do not put `protected` on the explicit implementation. `float IStat.Offset { get; protected set; }` fails with `CS0106: The modifier 'protected' is not valid for this item`. Explicit implementations never carry access modifiers; their accessibility comes from the interface.
- The class itself cannot call the setter. `Stat` has no `Offset` member of its own, and casting `this` to `IStat` hits the CS1540 shown above. Only the interface's own default members and derived interfaces can write it.
- Reflection confirms the shape the compiler emitted. On .NET 11, `typeof(IStat).GetProperty("Offset").SetMethod` reports `IsFamily=True` (that is `protected` in IL) and `IsAbstract=True`, and `GetInterfaceMap` maps both accessors to private methods named `IStat.get_Offset` and `IStat.set_Offset` on `Stat`.

The same thing works if the default member lives on the declaring interface itself, for example `void Add(float d) => Offset += d;` inside `IStat`. That ran and printed `2.5` after `Add(2f)` and `Add(0.5f)` in the test project.

## Fix 3: use an abstract base class when you need the protected contract

If "every implementation has a setter only subclasses can call" is a hard requirement, that is a class-hierarchy contract, and C# expresses it with a base class:

```csharp
// .NET 11, C# 15 -- compiles and runs, prints 1.5
using System;

public abstract class StatBase
{
    public float Offset { get; protected set; }
}

public sealed class Stat : StatBase
{
    public void Apply(float d) => Offset += d;
}

public static class Program
{
    public static void Main()
    {
        var s = new Stat();
        s.Apply(1.5f);
        Console.WriteLine(s.Offset);   // 1.5
    }
}
```

You can combine this with Fix 1: keep `IStat { float Offset { get; } }` for consumers and have `StatBase : IStat`. Consumers depend on the interface, implementers inherit the protected setter from the base class.

## The "just make the class setter public" fix, and why it depends on C# 10

The question notes that removing `protected` from the class property makes the error go away. That is true, with two caveats.

First, it only compiles on C# 10 or later. A public class accessor implicitly implementing a non-public interface accessor is a language feature Roslyn tracks as `IDS_FeatureImplicitImplementationOfNonPublicMembers`, gated on C# 10 in [MessageID.cs](https://github.com/dotnet/roslyn/blob/main/src/Compilers/CSharp/Portable/Errors/MessageID.cs). The original C# 8 design decision recorded in the [default interface methods proposal](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-8.0/default-interface-methods.md) was "You can only implement non-public interface members explicitly". Building the public-setter version with `<LangVersion>8.0</LangVersion>` or `9.0` gives:

```
error CS8704: 'Stat' does not implement interface member 'IStat.Offset.set'. 'Stat.Offset.set' cannot implicitly implement a non-public member in C# 9.0. Please use language version '10.0' or greater.
```

With `<LangVersion>10.0</LangVersion>` and later it compiles. Projects that target `net6.0` or newer default to C# 10 or higher, so you usually only see CS8704 in projects that pin an older `LangVersion`.

Second, it defeats the purpose. The class setter is now public, so `new Stat().Offset = 4f` compiles from anywhere. The `protected` on the interface only stops writes through an `IStat`-typed reference. If that is acceptable, Fix 1 gets you the same thing with a simpler interface.

## Gotchas and lookalike errors

- **CS8707 on .NET Standard 2.0 or .NET Framework.** `protected`, `protected internal` and `private protected` interface members need runtime support for default interface members. Targeting `netstandard2.0` adds `CS8707: Target runtime doesn't support 'protected', 'protected internal', or 'private protected' accessibility for a member of an interface.` on top of CS0277. `netstandard2.1` and `netcoreapp3.0`+ only report CS0277. If your library multi-targets `netstandard2.0`, Fix 1 or Fix 3 is the only portable choice.
- **CS8703 on C# 7.3.** `The modifier 'protected' is not valid for this item in C# 7.3`. Any modifier on an interface member needs C# 8.
- **CS0106 on explicit implementations.** Covered above: remove the access modifier from `float IStat.Offset { get; set; }`.
- **CS0737** is the method equivalent: a non-public class method that should implement a public interface method. The fix is the same family: make it public or implement it explicitly.
- **Changing an interface is a breaking change.** Removing the setter from a published interface (Fix 1) breaks consumers that wrote through it, and adding a protected setter to an existing interface breaks implementers. [The difference between source-breaking and binary-breaking changes](/2026/10/what-is-the-difference-between-a-source-breaking-and-a-binary-breaking-change-in-a-dotnet-library/) is worth reading before you reshape a public contract.
- **Backing-field logic.** If the protected setter in your class needs validation, the C# 14 `field` keyword lets you keep an auto-property shape: `public float Offset { get; protected set => field = Math.Max(0, value); }` (checked on .NET 11: a derived class setting `-5` reads back `0`). See [the field keyword and field-backed properties](/2025/04/c-14-the-field-keyword-and-field-backed-properties/).

## How these results were checked

Each snippet above was compiled as its own file in a single console project targeting `net11.0` with SDK 11.0.100 (default C# 15) on macOS 27 arm64, using `dotnet build -p:CaseFile=<file>`. The C# 8, 9 and 10 results come from the same project with `-p:LangVersion=...`. The `netstandard2.0` and `netstandard2.1` results come from a separate class library that multi-targets both. Runtime outputs (`3`, `7`, `3.5`, `2.5`, `1.5`) are from `dotnet run` with invariant globalization. Error text is copied from compiler output. If you just moved a project to .NET 11, [what changes when you retarget](/2026/11/dotnet-11-is-generally-available-what-to-change-in-your-project/) covers the language version bump.

## Related

- [Fix CS9035: required member must be set in the object initializer](/2026/07/fix-cs9035-required-member-must-be-set-in-the-object-initializer/)
- [C# 14: the field keyword and field-backed properties](/2025/04/c-14-the-field-keyword-and-field-backed-properties/)
- [Source-breaking vs binary-breaking changes in a .NET library](/2026/10/what-is-the-difference-between-a-source-breaking-and-a-binary-breaking-change-in-a-dotnet-library/)
- [Access a private property's backing field with UnsafeAccessor](/2023/11/c-access-private-property-backing-field-using-unsafe-accessor/)
- [.NET 11 is generally available: what to change in your project](/2026/11/dotnet-11-is-generally-available-what-to-change-in-your-project/)

## Sources

- [Stack Overflow: Why does a class property with a non-public setter fail to implement an interface property?](https://stackoverflow.com/questions/80011658)
- [C# 8 default interface methods proposal](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-8.0/default-interface-methods.md), section "Overriding non-public interface members (closed)", which also records the original "implement non-public members explicitly" decision
- [C# standard, chapter 19: Interfaces](https://github.com/dotnet/csharpstandard/blob/draft-v8/standard/interfaces.md)
- [Roslyn `MessageID.cs`](https://github.com/dotnet/roslyn/blob/main/src/Compilers/CSharp/Portable/Errors/MessageID.cs), `IDS_FeatureImplicitImplementationOfNonPublicMembers` mapped to `LanguageVersion.CSharp10`
- [Explicit interface implementation (C# programming guide)](https://learn.microsoft.com/en-us/dotnet/csharp/programming-guide/interfaces/explicit-interface-implementation)
- [Interfaces in C# (fundamentals)](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/types/interfaces)
