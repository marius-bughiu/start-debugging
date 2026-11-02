---
title: "C# How to update a readonly field using UnsafeAccessor"
description: "A runnable .NET 8 example of a readonly field exposed by UnsafeAccessor, with explicit limits on mutation and observable runtime behavior."
pubDate: 2023-11-02
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
---
A .NET 8 unsafe accessor can expose an instance field by reference, including a field declared `readonly`. Writing through that reference bypasses normal C# assignment rules. It does not change the field's declaration or establish general guarantees about optimized reads of immutable state.

**Correction — November 2, 2026:** The unavailable sample has been restored. The old blanket performance claim and unconditional direct-read result were removed; the verified example observes the value through the accessor.

## Runnable example

[Download the complete example](/examples/unsafe-accessor.zip). It includes private-member demonstrations and this focused readonly case:

```cs
using System.Runtime.CompilerServices;

var holder = new ReadonlyHolder();
Accessors.ReadonlyField(holder) = 42;
Console.WriteLine(Accessors.ReadonlyField(holder)); // 42 in the verified run

internal sealed class ReadonlyHolder
{
    public readonly int Value = 3;
}

internal static class Accessors
{
    [UnsafeAccessor(UnsafeAccessorKind.Field, Name = "Value")]
    internal static extern ref int ReadonlyField(ReadonlyHolder instance);
}
```

Run the downloaded project with `dotnet run -c Release`. The full example checks the initial value, performs the write and checks the accessor result on .NET 8.0.33.

## What this establishes

The accessor signature matches the field's declaring type, name and type. Returning `ref int` permits the assignment shown above. It does not make writes through unrelated references, concurrent mutation or every JIT/AOT optimization behave identically. A direct read elsewhere should not be used as a universal promise that mutation is supported.

For application state, prefer initialization in the constructor or an explicitly mutable API. Instance-field reflection writes and static readonly fields also have different runtime restrictions; they are not interchangeable cases.

See [the member-access guide](/2023/10/unsafe-accessor/) for ordinary accessors and [the benchmark project](/2023/11/net-8-performance-unsafeaccessor-vs-reflection/) for a measured comparison of call paths. The [official API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) describes binding signatures and version limits.
