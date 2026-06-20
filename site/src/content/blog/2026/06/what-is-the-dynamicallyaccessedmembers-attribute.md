---
title: "What is the DynamicallyAccessedMembers attribute?"
description: "DynamicallyAccessedMembers tells the .NET trimmer and AOT compiler which members of a Type you reach by reflection, so they are kept instead of trimmed away. It turns a silent runtime MissingMethodException into a build-time IL2070 warning. Here is what the attribute does, how the data-flow analysis behind it works, and how to annotate parameters, fields, and generic type parameters correctly."
pubDate: 2026-06-20
tags:
  - "dotnet"
  - "trimming"
  - "native-aot"
  - "csharp"
  - "dotnet-11"
---

`[DynamicallyAccessedMembers]` is the attribute you put on a `Type` (or a `string` type name) to tell the .NET trimmer and the Native AOT compiler "I am going to reach these members by reflection, so do not delete them." It is the contract that lets static analysis follow reflection it cannot otherwise see. Without it, the trimmer removes any member it cannot prove is reachable, and your `type.GetMethod("Run").Invoke(...)` throws a `MissingMethodException` at runtime in the published app even though it worked in `dotnet run`. With it, the same code either compiles clean or gives you a precise build-time warning (`IL2070`, `IL2075`, `IL2077`, and friends) pointing at the exact spot where an unannotated `Type` flows into a reflection call. The attribute lives in `System.Diagnostics.CodeAnalysis`, shipped in `System.Runtime.dll`, and has been stable since .NET 5. Everything below targets the .NET 11 SDK (`11.0.100`) and C# 14, but the mechanics apply from .NET 6 onward, where trim analysis warnings were first emitted.

## Why the trimmer needs a hint at all

Trimming, and the [Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) build that requires it, work by reachability analysis. The trimmer starts at your entry point, walks every method call, field access, and type reference it can see statically, marks everything it touches as "kept," and deletes the rest. This is how a self-contained app shrinks from 70 MB to 15 MB: the framework is enormous and your app uses a sliver of it.

Reflection breaks the walk. When you write `type.GetMethods()`, the trimmer has no idea which type `type` holds at runtime, so it cannot know which methods to keep. It has two options: keep every method of every type that could possibly flow into that call (which defeats trimming entirely), or keep nothing and let you find out at runtime. It does neither. Instead, the BCL methods that reflect are themselves annotated, and the trimmer demands that the `Type` you hand them carries a matching promise. `[DynamicallyAccessedMembers]` is how you make that promise.

Look at the signature of `Type.GetMethods()` in the .NET source and you will see the instance method is effectively annotated to require `PublicMethods` on `this`. So this innocent helper produces a warning:

```csharp
// .NET 11, C# 14. Compiled with <PublishTrimmed>true</PublishTrimmed>.
static void UseMethods(Type type)
{
    // warning IL2070: 'this' argument does not satisfy
    // 'DynamicallyAccessedMemberTypes.PublicMethods' in call to
    // 'System.Type.GetMethods()'. The parameter 'type' of method
    // 'UseMethods(Type)' does not have matching annotations.
    foreach (var method in type.GetMethods())
    {
        // ...
    }
}
```

The trimmer is saying: I am about to let you enumerate the public methods of whatever `type` is, but nobody promised those methods would survive trimming. Annotate the source of the `Type` so the promise is in the type system.

## The fix: state the requirement on the parameter

The fix is to copy the requirement onto the parameter that supplies the `Type`:

```csharp
// .NET 11, C# 14.
using System.Diagnostics.CodeAnalysis;

static void UseMethods(
    [DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)] Type type)
{
    foreach (var method in type.GetMethods()) // no warning
    {
        // ...
    }
}
```

Now `UseMethods` is satisfied internally, but the requirement does not vanish. It moves to the callers. Anyone calling `UseMethods` must hand it a `Type` that is itself known to keep its public methods. That is the whole model: the attribute does not preserve anything by itself. It is a flow annotation that pushes the obligation up the call chain until it reaches a point where the concrete type is known.

## Where the obligation actually ends

The requirement stops propagating in one of two places. The first is `typeof`. When you write `typeof(Customer)`, the trimmer knows the exact type and can preserve whatever the destination demands:

```csharp
// .NET 11. typeof gives the trimmer a concrete type, so it keeps
// Customer's public methods and the call is clean.
UseMethods(typeof(Customer));
```

The second is a public API boundary. If the `Type` comes from a parameter, a field, or a method return value, you annotate that location too, and the chain continues outward. Here is the field case, which is the one people miss:

```csharp
// .NET 11, C# 14.
static Type _type = typeof(Customer);

static void UseMethodsHelper()
{
    // warning IL2077: 'type' argument does not satisfy
    // 'DynamicallyAccessedMemberTypes.PublicMethods' in call to 'UseMethods(Type)'.
    // The field '_type' does not have matching annotations.
    UseMethods(_type);
}
```

The field carries no promise, so passing it into an annotated parameter warns. Annotate the field, and now the trimmer enforces the promise at every assignment into that field instead:

```csharp
// .NET 11, C# 14.
[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
static Type _type = typeof(Customer); // assignment of a concrete type: clean

static void UseMethodsHelper() => UseMethods(_type); // clean
```

Assign something the trimmer cannot reason about (an unannotated `Type` parameter, a `Type.GetType("…")` from a runtime string) into that annotated field and you get a warning at the assignment. The promise is now load-bearing in both directions.

## The DynamicallyAccessedMemberTypes flags

The single constructor argument is a `[Flags]` enum, so you combine values with `|` to keep exactly what your reflection touches and nothing more. The core values and their numeric flags:

| Value | What it preserves |
| --- | --- |
| `None` | Nothing. |
| `PublicParameterlessConstructor` | The default public constructor (what `Activator.CreateInstance(type)` needs). |
| `PublicConstructors` | All public constructors. |
| `NonPublicConstructors` | All non-public constructors. |
| `PublicMethods` / `NonPublicMethods` | Public / non-public methods. |
| `PublicFields` / `NonPublicFields` | Public / non-public fields. |
| `PublicProperties` / `NonPublicProperties` | Public / non-public properties. |
| `PublicEvents` / `NonPublicEvents` | Public / non-public events. |
| `PublicNestedTypes` / `NonPublicNestedTypes` | Nested types. |
| `Interfaces` | Interfaces the type implements. |
| `All` | Everything (value `-1`). |

The rule is to ask for the minimum. If all you do is `Activator.CreateInstance(type)`, request `PublicParameterlessConstructor`, not `All`. Every flag you add is members the trimmer is forbidden from deleting, which is binary size you pay for in the final app. `All` is the lazy answer that quietly undoes most of trimming's benefit for that type.

.NET 9 and 10 added a second family of `...WithInherited` and `All...` flags, for example `AllMethods`, `AllConstructors`, and `NonPublicMethodsWithInherited`. The plain `PublicMethods` flag already includes inherited public methods because they are part of the type's public surface, but the non-public variants historically did not walk base classes. The `WithInherited` flags close that gap when you reflect over inherited private or protected members. Reach for them only when your reflection actually crosses the inheritance boundary.

## Annotating generic type parameters and return values

The attribute is not limited to parameters and fields. Its `AttributeUsage` covers parameters, fields, properties, return values, generic parameters, classes, interfaces, structs, and methods. Two of these are worth calling out.

A generic type parameter can carry the requirement, which is how you write a reflection-backed factory that stays trim-safe:

```csharp
// .NET 11, C# 14.
using System.Diagnostics.CodeAnalysis;

static T Create<[DynamicallyAccessedMembers(
    DynamicallyAccessedMemberTypes.PublicParameterlessConstructor)] T>()
{
    return Activator.CreateInstance<T>(); // clean
}

// The constraint flows to the call site. typeof is implicit in the type argument.
var c = Create<Customer>(); // trimmer keeps Customer's parameterless ctor
```

Applying the attribute to a method is a documented special case: it is treated as applying to the `this` parameter, so it only makes sense on instance methods of a type assignable to `Type`. The return-value target lets a method promise something about the `Type` it hands back:

```csharp
// .NET 11, C# 14. The caller can reflect over public methods of the returned Type.
[return: DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicMethods)]
static Type ResolveHandler(string name) =>
    name == "customer" ? typeof(Customer) : typeof(Order);
```

## When the pattern genuinely cannot be annotated

Sometimes the data flow is real and correct but the analyzer cannot follow it, for example a `Type[]` where you know by construction that every element keeps its constructor but the trimmer cannot see that invariant. For these, `[UnconditionalSuppressMessage]` silences a specific warning and, unlike `[SuppressMessage]`, is persisted in IL so trim analysis respects it:

```csharp
// .NET 11, C# 14.
[UnconditionalSuppressMessage("ReflectionAnalysis", "IL2063",
    Justification = "The array only ever holds types stored through the annotated setter.")]
get => _types[i];
```

This is a promise you are making on your honor. The docs are blunt that it is only valid to suppress when the reflected-on members are genuine reflection targets elsewhere in the program, because members that are not visible reflection targets can be inlined, renamed, or moved by the optimizer, and your suppressed code will then break in a way no warning predicted.

The other escape hatch is `[DynamicDependency]`, which keeps named members but does not inform the analysis. It is a last resort for patterns that even `[DynamicallyAccessedMembers]` cannot express, such as loading a member by string from a separate assembly:

```csharp
// .NET 11, C# 14.
[DynamicDependency("Helper", "MyType", "MyAssembly")]
static void RunHelper()
{
    var helper = Assembly.Load("MyAssembly").GetType("MyType").GetMethod("Helper");
    helper.Invoke(null, null);
}
```

If you find yourself reaching for either escape hatch across many call sites, that is the signal that the API is fundamentally reflection-shaped and should be replaced with compile-time code generation. Reflection-based serializers and mappers are the canonical example: instead of annotating your way around `GetProperties()` walks, you adopt a source generator that emits the access code at build time. If that term is new, [what a source generator is and when you need one](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) is the primer, and it is the reason source-generated `System.Text.Json` exists.

## How this relates to RequiresUnreferencedCode

It is easy to confuse `[DynamicallyAccessedMembers]` with `[RequiresUnreferencedCode]`. They solve adjacent problems. `[DynamicallyAccessedMembers]` is for analyzable reflection: you know exactly which members of a `Type` you touch, so you state it and the trimmer keeps them. `[RequiresUnreferencedCode]` is for reflection that cannot be made trim-safe at all, an admission that the method does something the trimmer cannot model. Annotating a method with it does not fix anything; it propagates an `IL2026` warning to every caller, the same way `[DynamicallyAccessedMembers]` propagates its requirement, until the warning reaches a public API where the library author can document the limitation. Use `[DynamicallyAccessedMembers]` when you can express the requirement and fall back to `[RequiresUnreferencedCode]` only when you genuinely cannot.

The practical workflow is the same one that governs the whole trimming and AOT story: turn on the analyzer, treat every `IL2xxx` warning as a real defect rather than noise, and drive the count to zero before you ship. Set `<IsTrimmable>true</IsTrimmable>` on a library to get warnings scoped to that project, or build a small trimming test app with `<PublishTrimmed>true</PublishTrimmed>` and a `TrimmerRootAssembly` entry to see every warning across the dependency graph. A clean build is the contract. When an AOT-incompatible call slips past the analyzer and only fails at runtime, you are back to debugging a [PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/), which is exactly the silent failure these annotations exist to prevent. And if you are wiring this up for a real web service, [how to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) walks the clean-build recipe end to end.

The mental model that makes all of this click: `[DynamicallyAccessedMembers]` does not preserve code. It propagates a requirement along the flow of a `Type` value, from the reflection call back to wherever that `Type` was born, and the preservation happens only at the `typeof` or concrete assignment where the requirement finally lands. Get that flow right and trimming stops being a source of mysterious production-only crashes and becomes a compiler feature you can actually trust.

## Related

- [What is Native AOT and what does it cost you?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/) explains why trimming is mandatory under AOT and what else you give up.
- [What is a source generator and when do I need one?](/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) covers the compile-time codegen that replaces reflection you cannot annotate.
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) is the clean-build walkthrough where these warnings show up in practice.
- [Fix: PlatformNotSupportedException in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) is the runtime failure that an annotated, warning-free build prevents.

## Sources

- [DynamicallyAccessedMembersAttribute Class](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicallyaccessedmembersattribute), MS Learn (definition, AttributeUsage targets, the method-is-this special case).
- [DynamicallyAccessedMemberTypes Enum](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.codeanalysis.dynamicallyaccessedmembertypes), MS Learn (the full flags list including the .NET 9/10 WithInherited additions).
- [Prepare .NET libraries for trimming](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/prepare-libraries-for-trimming), MS Learn (IL2070/IL2077 examples, UnconditionalSuppressMessage, DynamicDependency, recommendations).
- [Introduction to trim warnings](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/fixing-warnings), MS Learn (warning catalog and the data-flow model).
