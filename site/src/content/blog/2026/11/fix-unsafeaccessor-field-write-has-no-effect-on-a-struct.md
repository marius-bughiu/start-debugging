---
title: "Fix: UnsafeAccessor field write has no effect on a struct"
description: "Declare the struct target as ref in the UnsafeAccessor signature and pass the real storage location, not a copy. A by-value target throws BadImageFormatException on .NET 8 to 11."
pubDate: 2026-11-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "unsafeaccessor"
---

An `[UnsafeAccessor]` field accessor for a struct must take the struct by `ref` (`static extern ref int GetX(ref GridPoint target)`), and you must hand it the actual storage location: a local, an array element, a class field, `CollectionsMarshal.AsSpan(list)[i]` or `Unsafe.Unbox<T>(box)`. If the value 99 you wrote "disappears", the accessor wrote into a copy, almost always one made by a property getter, a list indexer, an unboxing cast or a `var copy = ...` line before the call. A by-value target parameter does not silently copy: on .NET 8, 9, 10 and 11 it throws `BadImageFormatException: Invalid usage of UnsafeAccessorAttribute`. Every result below was run on CoreCLR 8.0.34, 9.0.23, 10.0.10 and 11.0.0, plus Native AOT 10.0.15 and 11.0.0, on macOS arm64.

## The error in context

The Stack Overflow question this page answers ([UnsafeAccessor not updating private field when targeting a struct in .NET 8](https://stackoverflow.com/questions/79883039)) reports this output:

```text
Expected: 99, Actual: 10
```

Running the code from that question, unchanged, on .NET 10.0.10 gives something else:

```text
Unhandled exception. System.BadImageFormatException: Invalid usage of UnsafeAccessorAttribute.
   at Program2.GetX(GridPoint target)
   at Program.<Main>$(String[] args) in q.cs:line 5
```

Under Native AOT the message is the generic `BadImageFormatException: Format of the executable (.exe) or library (.dll) is invalid.`, thrown from the same call. So there are two symptoms that people search for, and they have the same root: the accessor never got a reference to the struct you care about. The by-value signature is rejected outright, and the `ref` signature fed with a copy runs fine and mutates the copy.

## Why a struct target has to be passed by reference

`UnsafeAccessorKind.Field` makes the runtime generate a method body that does one thing: load the first argument and return the address of the named field on it (`ldarg.0; ldflda _x; ret`). For a class, the first argument is already a reference to the object on the heap, so any copy of the reference points at the same field. For a struct, the first argument *is* the value. If it arrived by value, the field address would point into the accessor's own argument slot, which is dead as soon as the call returns. A `ref int` into a dead stack slot is not a "lost write", it is a dangling pointer.

The runtime refuses to build that. The [UnsafeAccessorAttribute reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) states the rule directly: "The first argument must be passed as `ref` for instance fields and methods on structs." The check is in the binder itself, not only in the docs. In CoreCLR's `unsafeaccessors.cpp` (and `prestub.cpp` on .NET 8 and 9) the `Field` case throws `COR_E_BADIMAGEFORMAT` when `firstArgType.IsValueType() && !firstArgType.IsByRef()`, and the `Method` case has the same test. Mono's `emit_unsafe_accessor_field_wrapper` in `marshal-lightweight.c` emits the same `BadImageFormatException` for a by-value value-type target, so Blazor WebAssembly and other Mono-hosted apps are no different.

Two details of that check matter when you debug:

1. It runs when the accessor is first called, not when the assembly loads. The program starts fine and only the first call throws, so an accessor on a code path your test never hits will pass every build.
2. The C# compiler cannot catch it. `static extern ref int GetX(GridPoint target)` is a perfectly legal declaration as far as Roslyn is concerned; the rule lives in the runtime.

The accepted answer on the question explains the symptom as "a defensive copy of the data on the stack." That describes what would happen if the runtime allowed by-value targets, and its fix (add `ref`) is correct, but on every runtime tested here the by-value version never gets far enough to write anything. If your program prints `Actual: 10` with no exception, look for a copy *before* the call, which is what the next section reproduces.

## Minimal repro of both symptoms

One multi-targeted console project (`net8.0;net9.0;net10.0;net11.0`, built with SDK 11.0.100) runs every case. The core types:

```csharp
// .NET 8.0.34 / 9.0.23 / 10.0.10 / 11.0.0, C# 12+
using System.Runtime.CompilerServices;

public struct GridPoint
{
    private int _x;
    public int X => _x;
    public GridPoint(int x) => _x = x;
    private void SetXCore(int value) => _x = value;
}

public sealed class Holder
{
    public GridPoint Field = new(10);
    public readonly GridPoint ReadonlyField = new(10);
    public GridPoint Prop { get; set; } = new(10);
}

static class Acc
{
    // Wrong: by-value target. Throws BadImageFormatException on first call.
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "_x")]
    public static extern ref int GetX_ByValue(GridPoint target);

    // Right: by-ref target.
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "_x")]
    public static extern ref int GetX(ref GridPoint target);

    // Same rule for instance methods on a struct.
    [UnsafeAccessor(UnsafeAccessorKind.Method, Name = "SetXCore")]
    public static extern void SetX(ref GridPoint target, int value);
}
```

And the silent version, which compiles, runs and loses the write:

```csharp
// .NET 8.0.34 / 9.0.23 / 10.0.10 / 11.0.0
var h = new Holder();
var copy = h.Prop;            // the getter returns a copy
Acc.GetX(ref copy) = 99;      // writes 99 into 'copy'
Console.WriteLine(h.Prop.X);  // 10
```

`ref h.Prop` does not compile (CS0206, a property cannot be passed as `ref`), so code that starts from a property naturally grows a local copy, and the accessor faithfully updates that local. The same thing happens with `list[0]` (`List<T>`'s indexer is a method that returns a copy) and with `(GridPoint)boxed`.

## Results across runtimes

Each row writes 99 through the accessor and reads the value back from the original location. The four CoreCLR versions and the two Native AOT builds produced identical results for every row, except the generic case on .NET 8, which predates generic accessor support.

| Case | What was passed as the target | Result |
|---|---|---|
| By-value field accessor | `GetX_ByValue(p)` | `BadImageFormatException` |
| By-value method accessor | `SetX_ByValue(p, 99)` | `BadImageFormatException` |
| `ref` field accessor on a local | `GetX(ref p)` | 99 |
| `in` field accessor on a local | `GetX_In(in p)` | 99 |
| `ref` method accessor | `SetX(ref p, 99)` | 99 |
| Struct in a class field | `GetX(ref h.Field)` | 99 |
| Struct behind an auto-property, via a local copy | `var c = h.Prop; GetX(ref c)` | 10 (write lost) |
| Struct behind an auto-property, via its backing field | `GetX(ref PropBackingField(h))` | 99 |
| `List<T>` element via the indexer | `var c = list[0]; GetX(ref c)` | 10 (write lost) |
| `List<T>` element via `CollectionsMarshal.AsSpan` | `GetX(ref AsSpan(list)[0])` | 99 |
| Array element | `GetX(ref arr[0])` | 99 |
| Boxed struct via a cast | `var c = (GridPoint)box; GetX(ref c)` | 10 (write lost) |
| Boxed struct via `Unsafe.Unbox` | `GetX(ref Unsafe.Unbox<GridPoint>(box))` | 99 |
| `readonly struct` field | `GetY(ref r)` | 99 |
| Struct in a `readonly` class field | `GetX(ref Unsafe.AsRef(in h.ReadonlyField))` | 99 |
| Generic struct `Wrapper<T>` | `GenAcc<int>.Value(ref w)` | 99 (.NET 9+), `BadImageFormatException` on .NET 8 |

Every "write lost" row has a `ref` accessor that worked correctly. The bug is upstream of the accessor.

## Fix, step by step

### 1. Make the target parameter `ref`

```csharp
// .NET 8+
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "_x")]
static extern ref int GetX(ref GridPoint target);

var p = new GridPoint(10);
GetX(ref p) = 99;
Console.WriteLine(p.X); // 99
```

This alone fixes the `BadImageFormatException`. Do it for `UnsafeAccessorKind.Method` accessors on structs too, including property getters and setters (`get_X` / `set_X`), since those are instance methods. `StaticField` and `StaticMethod` accessors do not care: the first argument only names the type and its value is ignored, so passing `default` by value is fine.

### 2. Pass the real storage location, not a copy

Find where the struct actually lives and take a reference to that place:

- **A local or parameter**: `ref p`.
- **A field of a class**: `ref holder.Field`. If the field is `readonly`, `ref holder.Field` is CS0192; use `ref Unsafe.AsRef(in holder.Field)`. That writes into a `readonly` field, which is exactly as dangerous as it sounds (see the [readonly field accessor write-up](/2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor/)).
- **An array element**: `ref arr[i]`. Arrays return element references directly.
- **A `List<T>` element**: `ref CollectionsMarshal.AsSpan(list)[i]`. Do not add or remove items while you hold that reference; a resize moves the backing array and your reference then points at the old one.
- **A boxed struct** (stored in an `object` field, a non-generic collection, an `IComparable` variable): `ref Unsafe.Unbox<GridPoint>(box)`. This mutates the box in place. A cast creates a new copy every time.

### 3. If the struct sits behind a property, go through its backing field

An auto-property's backing field is named `<Name>k__BackingField`, so a second accessor gives you a `ref` to it, and accessors compose:

```csharp
// .NET 8+
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "<Prop>k__BackingField")]
static extern ref GridPoint PropBackingField(Holder target);

var h = new Holder();
GetX(ref PropBackingField(h)) = 99;
Console.WriteLine(h.Prop.X); // 99
```

For a hand-written property, read the library's source or decompile it to find the field name. Backing field names are an implementation detail and can change between library versions; a renamed field surfaces as `MissingFieldException` on first call, which is at least loud. The [backing field accessor post](/2023/11/c-access-private-property-backing-field-using-unsafe-accessor/) covers that pattern on classes.

The other route, calling the property getter, modifying the result and calling the setter, works only if the property has a setter you can reach, and it is a read-modify-write rather than an in-place change.

### 4. For generic structs, use a generic accessor class (.NET 9+)

```csharp
// .NET 9+ (generic UnsafeAccessor support)
var w = new Wrapper<int>(10);
GenAcc<int>.Value(ref w) = 99;   // w.Get() == 99

public struct Wrapper<T>
{
    private T _value;
    public Wrapper(T value) => _value = value;
    public T Get() => _value;
}

static class GenAcc<T>
{
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "_value")]
    public static extern ref T Value(ref Wrapper<T> target);
}
```

The same code on .NET 8.0.34 throws `BadImageFormatException`, because generic parameters on accessors only became supported in .NET 9. That exception text is identical to the by-value one, so check your target framework before you go hunting for a missing `ref`.

## Gotchas and variants

**`in` works, and that is surprising.** An accessor declared `ref int GetX(in GridPoint target)` binds and returns a writable `ref int`, and the write lands in the caller's variable (99 on every runtime above). The runtime only checks that the target is a byref; the read-only promise of `in` is a C# convention the runtime does not enforce here. Do not use `in` on mutating accessors: it tells readers the opposite of what the code does, and if the caller passes an rvalue the compiler materializes a temporary and your write goes into it.

**A `readonly struct` is not protected either.** `GetY(ref r) = 99` on a `readonly struct ReadOnlyPoint` with a `private readonly int _y` worked on every runtime. `readonly` is a compile-time contract. The JIT may still assume immutability in places, so reads elsewhere are not guaranteed to observe the write the way you expect.

**The struct type is `internal` to another assembly.** This is the scenario in the original question ("an internal struct inside a third-party library"). You cannot write `ref Settings` in your accessor signature because you cannot name the type. .NET 10 added [`UnsafeAccessorTypeAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessortypeattribute) to address inaccessible types, but it does not cover value types: an accessor with `[UnsafeAccessorType("ThirdParty.Settings, Lib")] ref object target` throws `NotSupportedException: ValueTypes are not supported with UnsafeAccessorTypeAttribute.` on .NET 10.0.10 and 11.0.0. The docs also rule out field accessors whose field type is inaccessible, so you cannot get a `ref Settings` out of the owning class either. The fallback is reflection with an explicit write-back:

```csharp
// .NET 8+; Settings is internal to the library, Client holds it in a private field
using System.Reflection;

const BindingFlags F = BindingFlags.Instance | BindingFlags.NonPublic;
var settingsField = typeof(ThirdParty.Client).GetField("_settings", F)!;
var retriesField = settingsField.FieldType.GetField("_retries", F)!;

object boxed = settingsField.GetValue(client)!; // boxed copy of the struct
retriesField.SetValue(boxed, 99);               // mutates the box only
settingsField.SetValue(client, boxed);          // copy the box back into the client
```

Without the last line, the client still reports `retries=3`: `FieldInfo.SetValue` on a boxed struct changes the box, not the field you read it from. Under Native AOT this reflection path came back with `NullReferenceException` because the trimmer removed the private fields (IL2075 warnings at publish time), so it needs `[DynamicallyAccessedMembers]` annotations before it is AOT-safe.

**The write works, but a later read shows the old value.** Check whether the code that reads it got its own copy earlier, for example a `foreach` iteration variable over a `List<GridPoint>` or a LINQ projection. Structs are copied on every assignment; a copy taken before the write never sees it.

**`MissingFieldException` instead.** The accessor resolved the type but not the name: wrong field name, a field that lives on a base type (accessors do not walk the hierarchy), or a field type in the signature that does not match exactly. That is a different problem from the one on this page; the [UnsafeAccessor guide](/2023/10/unsafe-accessor/) covers the binding rules.

## Related

- [C# UnsafeAccessor: private members without reflection](/2023/10/unsafe-accessor/) for constructor, method, property and static-member accessors.
- [Updating a readonly field with UnsafeAccessor](/2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor/) and its limits.
- [UnsafeAccessor vs reflection benchmark](/2023/11/net-8-performance-unsafeaccessor-vs-reflection/), if you are deciding whether the reflection fallback is fast enough.
- [Record vs class vs struct in C#](/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/) for why struct copies show up in so many places.
- [What ref-safe-context means for ref locals](/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/), useful when you start holding `ref` returns from accessors in locals.

## Sources

- [UnsafeAccessorAttribute API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) (the struct `ref` rule and generic support since .NET 9).
- [UnsafeAccessorTypeAttribute API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessortypeattribute) (.NET 10, "Value types are not supported").
- CoreCLR binder: [`src/coreclr/vm/unsafeaccessors.cpp` at v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/coreclr/vm/unsafeaccessors.cpp) and [`prestub.cpp` at v8.0.0](https://github.com/dotnet/runtime/blob/v8.0.0/src/coreclr/vm/prestub.cpp).
- Mono implementation: [`src/mono/mono/metadata/marshal-lightweight.c` at v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/mono/mono/metadata/marshal-lightweight.c).
- [Stack Overflow question 79883039](https://stackoverflow.com/questions/79883039) and its accepted answer.
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan) and [Unsafe.Unbox](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafe.unbox).
