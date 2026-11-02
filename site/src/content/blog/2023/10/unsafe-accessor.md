---
title: "C# UnsafeAccessor: private members without reflection (.NET 8)"
description: "Use .NET 8 UnsafeAccessor to access known private constructors, methods, properties and fields, with tested examples and version limitations."
pubDate: 2023-10-31
updatedDate: 2026-11-02
tags:
  - "dotnet"
  - "dotnet-8"
---
`UnsafeAccessorAttribute`, introduced in .NET 8, lets a `static extern` method bind to a known inaccessible member. The runtime supplies its implementation. It is useful when the declaring type and member signature are known at compile time; it does not replace reflection for runtime discovery.

**Correction — November 2, 2026:** The original article incorrectly ruled out overloads and required an instance for static access. Those claims are corrected below. The restored example was executed on .NET 8.0.33; performance is discussed separately rather than described as universally zero overhead.

## Download the complete example

[Download the runnable source ZIP](/examples/unsafe-accessor.zip), or open the [example instructions](/examples/#unsafe-accessor). It includes the project, declaring types, imports and checks for every access pattern below.

```sh
dotnet run -c Release
```

The program checks expected values and exits unsuccessfully if they differ. Its successful run prints:

```text
PASS: constructors, instance/static members, field access, readonly accessor observation
```

## Private constructors and overloads

In a helper class, ordinary C# method overloads are allowed. A constructor accessor returns the declaring type and takes the target constructor's parameters:

```cs
using System.Runtime.CompilerServices;

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create();

    [UnsafeAccessor(UnsafeAccessorKind.Constructor)]
    internal static extern Foo Create(string value);
}
```

These declarations bind to `Foo()` and `Foo(string)`. The ZIP contains the complete `Foo` type. An example expressed as top-level local functions has different C# naming rules from methods in a helper class; that is not an `UnsafeAccessor` restriction.

## Instance methods and properties

The first parameter identifies the declaring type and supplies the instance. The remaining parameter and return types must match the target member. Properties are accessed through their accessor methods:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
internal static extern string CallInstance(Foo instance, int value);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
internal static extern string GetProperty(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
internal static extern void SetProperty(Foo instance, string value);
```

The sample verifies the private method result, reads the initial property value, writes it and reads it again. For instance members on a struct, the first parameter must be passed by `ref`.

## Static members

Use `StaticMethod` or `StaticField`. The first parameter still identifies the declaring type, but its **value is unused** and may be null:

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
internal static extern string CallStatic(Foo? typeMarker, int value);

var result = Accessors.CallStatic(null, 42);
```

This example uses a non-static declaring class. C# does not allow a static class as a parameter type; do not infer that every static-class API can be accessed using this .NET 8 pattern.

## Fields

A field accessor returns a reference. The sample reads and writes both instance and static fields:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
internal static extern ref int InstanceField(Foo instance);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
internal static extern ref int StaticField(Foo? typeMarker);
```

For the special case of readonly fields, see [the readonly-accessor example](/2023/11/c-how-to-update-a-readonly-field-using-unsafeaccessor/). Accessing a field by reference does not make arbitrary mutation of immutable state a supported design.

## Limits and performance

Only the specified declaring type is searched; the runtime does not walk its inheritance hierarchy. Missing field/method bindings throw when used. Incorrect signatures and constraints can produce other binding failures. Generic-parameter support was added in .NET 9, so generic examples need a separate version check.

An accessor can avoid reflection lookup and `Invoke` argument handling, but the cost of the target operation and the generated code still matter. The [restored benchmark](/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) includes direct access, cached reflection and a cached delegate, with observable work.

Source: [Microsoft's UnsafeAccessorAttribute reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute).
