---
title: "C# 14 user-defined compound assignment operators: in-place += without the extra allocation"
description: "C# 14 lets you overload +=, -=, *=, and friends as void instance methods that mutate the receiver in place, cutting allocations for large value holders like BigInteger-style buffers and tensors."
pubDate: 2026-04-14
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-10"
  - "performance"
  - "operators"
---

One of the quieter additions in C# 14 is finally getting paved into the language reference: user-defined compound assignment operators. Up until .NET 10, writing `x += y` on a custom type always compiled down to `x = x + y`, which meant your `operator +` had to allocate and return a brand new instance even when the caller was about to throw the old one away. With C# 14 you can now overload `+=` directly as a `void` instance method that mutates the receiver in place.

The motivation is simple: for types that carry a lot of data (a `BigInteger`-style buffer, a tensor, a pooled byte accumulator), producing a fresh destination, walking it, and copying memory is the expensive part of every `+=`. If the original value is not used after the assignment, that copy is pure waste. The [feature specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/user-defined-compound-assignment) spells this out explicitly.

## How the new operator is declared

A compound assignment operator in C# 14 is not static. It takes a single parameter, returns `void`, and lives on the instance:

```csharp
public sealed class Accumulator
{
    private readonly List<int> _values = new();

    public int Sum { get; private set; }

    // Classic binary operator, still required if you want x + y to work.
    public static Accumulator operator +(Accumulator left, int value)
    {
        var result = new Accumulator();
        result._values.AddRange(left._values);
        result._values.Add(value);
        result.Sum = left.Sum + value;
        return result;
    }

    // New in C# 14: instance operator, no allocation, no static modifier.
    public void operator +=(int value)
    {
        _values.Add(value);
        Sum += value;
    }
}
```

The compiler emits the instance method under the name `op_AdditionAssignment`. When the caller writes `acc += 5`, the language now prefers the instance operator if one is available; if it is not, the old `x = x + y` rewrite is still the fallback. That means existing code continues to compile, and you can add a `+=` overload later without breaking the `+` overload.

## When it matters

The payoff shows up on reference types that own internal buffers and on struct types used through a mutable storage location. A naive `Matrix operator +(Matrix, Matrix)` has to allocate a whole new matrix for every `m += other` call in a hot loop. The instance version can add into `this` and return nothing:

```csharp
public sealed class Matrix
{
    private readonly double[] _data;
    public int Rows { get; }
    public int Cols { get; }

    public void operator +=(Matrix other)
    {
        if (other.Rows != Rows || other.Cols != Cols)
            throw new ArgumentException("Shape mismatch.");

        var span = _data.AsSpan();
        var otherSpan = other._data.AsSpan();
        for (int i = 0; i < span.Length; i++)
            span[i] += otherSpan[i];
    }
}
```

Prefix `++` and `--` follow the same pattern with `public void operator ++()`. Postfix `x++` still goes through the static version when the result is used, because the pre-increment value cannot be produced after an in-place mutation.

## Things worth knowing

The language does not enforce consistency between `+` and `+=`, so you can ship one without the other. The LDM [looked at this in April 2025](https://github.com/dotnet/csharplang/blob/main/meetings/2025/LDM-2025-04-02.md) and decided against mandatory pairing. `checked` variants work the same way: declare `public void operator checked +=(int y)` alongside the regular one. `readonly` is allowed on structs but, as the spec notes, it rarely makes sense given the whole point of the method is to mutate the instance.

The feature ships with C# 14 on .NET 10, usable today in Visual Studio 2026 or the .NET 10 SDK. For existing libraries exposing big-data value types, retrofitting an instance `+=` is one of the cheapest performance wins available in this release. See the full overview in [What's new in C# 14](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14).
