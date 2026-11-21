---
title: "How to call an IBinaryInteger<T> method from generic INumber<T> code in C#"
description: "A generic method constrained to INumber<T> cannot call a helper constrained to IBinaryInteger<T> or IFloatingPoint<T>: the compiler reports CS0314 and there is no cast that fixes it. Five working ways to dispatch anyway (type switch, cached delegate, strategy class, plain reflection, staying on INumberBase<T>), benchmarked on .NET 11.0.0 and checked under Native AOT."
pubDate: 2026-11-21
tags:
  - "dotnet"
  - "csharp"
  - "dotnet-11"
  - "generic-math"
  - "native-aot"
---

You cannot narrow a generic constraint inside a method. If your code is constrained to `where T : INumber<T>` and you want to call a helper constrained to `where T : IBinaryInteger<T>`, the compiler stops you with CS0314, and no runtime check or cast changes that, because `IBinaryInteger<T>` is only a legal type when `T` already satisfies it. The fix is to move the call somewhere the stronger constraint exists: either close over concrete types (`if (typeof(T) == typeof(int)) return (T)(object)ParseInt<int>(s);`), or build the constrained instantiation once with reflection and cache it in a static generic class (`DelegateDispatch<T>.Parse`). On .NET 11.0.0 the type switch costs nothing over a direct call, a cached delegate or strategy object adds about 1.5 ns, and uncached `MethodInfo.Invoke` is roughly 40x slower and allocates. Everything below was compiled with SDK 11.0.100 and run on .NET 11.0.0 (macOS 27 arm64, Apple M4), including a Native AOT publish.

The question comes up regularly, most recently on [Stack Overflow](https://stackoverflow.com/questions/80011917): a `Data<T> where T : INumber<T>` class wants to parse integers one way (accept a `0x` prefix) and floating-point values another way (reject `NaN` and `Infinity`), and the two helpers are naturally written against `IBinaryInteger<T>` and `IFloatingPoint<T>`.

## Why the compiler refuses: CS0314 and self-referencing interfaces

Here is the code most people write first:

```csharp
// .NET 11, C# 14
using System.Numerics;

static class Assistant
{
    public static T ParseInt<T>(string s) where T : IBinaryInteger<T> => T.Parse(s, null);
    public static T ParseFloat<T>(string s) where T : IFloatingPoint<T> => T.Parse(s, null);
}

static class Data<T> where T : INumber<T>
{
    public static T Work(string s)
    {
        if (typeof(T).IsAssignableTo(typeof(IBinaryInteger<>)))
            return Assistant.ParseInt<T>(s);
        if (T is IBinaryInteger<T>)
            return default!;
        return Assistant.ParseFloat<T>(s);
    }
}
```

SDK 11.0.100 reports:

```text
Program.cs(17,30): error CS0314: The type 'T' cannot be used as type parameter 'T' in the generic type or method 'Assistant.ParseInt<T>(string)'. There is no boxing conversion or type parameter conversion from 'T' to 'System.Numerics.IBinaryInteger<T>'.
Program.cs(18,13): error CS0119: 'T' is a type, which is not valid in the given context
Program.cs(18,33): error CS0314: The type 'T' cannot be used as type parameter 'TSelf' in the generic type or method 'IBinaryInteger<TSelf>'. There is no boxing conversion or type parameter conversion from 'T' to 'System.Numerics.IBinaryInteger<T>'.
Program.cs(20,26): error CS0314: The type 'T' cannot be used as type parameter 'T' in the generic type or method 'Assistant.ParseFloat<T>(string)'. There is no boxing conversion or type parameter conversion from 'T' to 'System.Numerics.IFloatingPoint<T>'.
```

The third error is the interesting one. Every [generic math interface](https://learn.microsoft.com/dotnet/standard/generics/math) is self-referencing: [`IBinaryInteger<TSelf>`](https://learn.microsoft.com/dotnet/api/system.numerics.ibinaryinteger-1) is declared with `where TSelf : IBinaryInteger<TSelf>`. So `IBinaryInteger<T>` is not even a type you are allowed to write unless `T` already satisfies `IBinaryInteger<T>`. You cannot test `x is IBinaryInteger<T>`, you cannot cast to it, and an `if` around the call does not help because constraints are checked at compile time, per method, and C# 14 has no flow-sensitive constraint narrowing.

The runtime check people try first also lies to you:

```text
typeof(int).IsAssignableTo(typeof(IBinaryInteger<>)) = False
```

`typeof(IBinaryInteger<>)` is the open generic definition, and no concrete type implements an open definition. You have to walk the interfaces and compare generic definitions. That check is needed by several of the solutions below, so cache it once per closed type:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;
using System.Numerics;

public static class NumberKind<[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.Interfaces)] T>
    where T : INumber<T>
{
    public static readonly bool IsBinaryInteger = Implements(typeof(IBinaryInteger<>));
    public static readonly bool IsFloatingPoint = Implements(typeof(IFloatingPoint<>));

    static bool Implements(Type openInterface) =>
        typeof(T).GetInterfaces().Any(i => i.IsGenericType && i.GetGenericTypeDefinition() == openInterface);
}
```

The `[DynamicallyAccessedMembers]` attribute only matters for trimming and Native AOT (more on that below). On .NET 11.0.0 this classifies the built-in types as you would expect, with two that surprise people: `BigInteger` is an `IBinaryInteger<T>`, and `decimal` is an `IFloatingPoint<T>` (as are `Half` and `NFloat`).

```text
NumberKind<int>:        int=True  float=False
NumberKind<double>:     int=False float=True
NumberKind<decimal>:    int=False float=True
NumberKind<Half>:       int=False float=True
NumberKind<BigInteger>: int=True  float=False
```

## The helpers used in every example

To make the comparison fair, every approach below calls the same two constrained helpers. The integer one accepts a `0x` prefix, the floating-point one rejects non-finite values:

```csharp
// .NET 11, C# 14
using System.Globalization;
using System.Numerics;

public static class Assistant
{
    public static T ParseInt<T>(string s) where T : IBinaryInteger<T>
    {
        ReadOnlySpan<char> text = s.AsSpan().Trim();
        return text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
            ? T.Parse(text[2..], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture)
            : T.Parse(text, NumberStyles.Integer, CultureInfo.InvariantCulture);
    }

    public static T ParseFloat<T>(string s) where T : IFloatingPoint<T>
    {
        T x = T.Parse(s.AsSpan().Trim(), NumberStyles.Float, CultureInfo.InvariantCulture);
        if (T.IsNaN(x) || T.IsInfinity(x))
            throw new FormatException($"'{s}' is not a finite number.");
        return x;
    }
}
```

## Option 1: a closed type switch that the JIT folds away

If you know the set of types you support, write the dispatch against concrete types and launder the result through `object`:

```csharp
// .NET 11, C# 14
public static class SwitchDispatch
{
    public static T Parse<T>(string s) where T : INumber<T>
    {
        if (typeof(T) == typeof(int)) return (T)(object)Assistant.ParseInt<int>(s);
        if (typeof(T) == typeof(long)) return (T)(object)Assistant.ParseInt<long>(s);
        if (typeof(T) == typeof(byte)) return (T)(object)Assistant.ParseInt<byte>(s);
        if (typeof(T) == typeof(double)) return (T)(object)Assistant.ParseFloat<double>(s);
        if (typeof(T) == typeof(float)) return (T)(object)Assistant.ParseFloat<float>(s);
        if (typeof(T) == typeof(decimal)) return (T)(object)Assistant.ParseFloat<decimal>(s);
        throw new NotSupportedException(typeof(T).ToString());
    }
}
```

This looks like it boxes, but it does not. All the BCL numeric types are structs, so the JIT compiles a separate copy of `Parse<T>` for each one, evaluates every `typeof(T) == typeof(X)` as a constant, deletes the dead branches, and removes the `(T)(object)` round trip. The benchmark below shows `Switch_Int` at 3.045 ns against 3.049 ns for calling `Assistant.ParseInt<int>` directly, with zero bytes allocated. The BCL uses the same trick internally in many generic numeric paths.

The cost is the closed list. `SwitchDispatch.Parse<short>("7")` throws `NotSupportedException: System.Int16` at runtime, so a missing type is a bug you only find when someone uses it. This is also the only option with zero reflection, which makes it the safest choice for trimmed and Native AOT apps.

## Option 2: build the constrained call once and cache a delegate

When you want any `INumber<T>` to work, use reflection exactly once per `T` and store the result in a static field of a generic class. The runtime initializes `DelegateDispatch<int>` and `DelegateDispatch<double>` separately, so each closed type gets its own cached delegate:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;
using System.Numerics;

public static class DelegateDispatch<[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.Interfaces)] T>
    where T : INumber<T>
{
    public static readonly Func<string, T> Parse = Create();

    static Func<string, T> Create()
    {
        string name = NumberKind<T>.IsBinaryInteger ? nameof(Assistant.ParseInt)
                    : NumberKind<T>.IsFloatingPoint ? nameof(Assistant.ParseFloat)
                    : throw new NotSupportedException($"{typeof(T)} is neither an integer nor a floating-point type.");
        return typeof(Assistant).GetMethod(name)!
            .MakeGenericMethod(typeof(T))
            .CreateDelegate<Func<string, T>>();
    }
}

// usage inside INumber<T> code:
T value = DelegateDispatch<T>.Parse(text);
```

`MakeGenericMethod` validates the constraints at runtime, which is exactly the check the compiler could not do. After the first call the cost is a static field read and a delegate invocation: 4.7 ns for `int` and 22.8 ns for `double` in the benchmark, against 3.0 ns and 20.9 ns for direct calls. It handles `Int128`, `UInt128`, `BigInteger`, `Half` and `NFloat` without any extra code.

One detail: if `T` is neither kind (a custom `INumber<T>` you wrote yourself, for example), the exception is thrown from a static initializer, so callers see a `TypeInitializationException` wrapping your `NotSupportedException`, and every later access to `DelegateDispatch<T>` rethrows it. If that matters, make `Create` return a delegate that throws instead of throwing directly.

## Option 3: a strategy class that carries the stronger constraint

The accepted Stack Overflow answer moves the constrained code into small classes whose own type parameter has the stronger constraint, then picks one with `MakeGenericType`. It is the same idea as option 2 expressed with virtual dispatch, and it scales better when you have several operations per number kind (parse, format, clamp, and so on) instead of one:

```csharp
// .NET 11, C# 14
using System.Diagnostics.CodeAnalysis;
using System.Numerics;

public abstract class NumberParser<[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.Interfaces)] T>
    where T : INumber<T>
{
    public abstract T Parse(string s);

    public static readonly NumberParser<T> Instance = Create();

    static NumberParser<T> Create()
    {
        Type open = NumberKind<T>.IsBinaryInteger ? typeof(IntegerParser<>)
                  : NumberKind<T>.IsFloatingPoint ? typeof(FloatParser<>)
                  : throw new NotSupportedException(typeof(T).ToString());
        return (NumberParser<T>)Activator.CreateInstance(open.MakeGenericType(typeof(T)))!;
    }
}

sealed class IntegerParser<[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.Interfaces)] T>
    : NumberParser<T> where T : IBinaryInteger<T>
{
    public override T Parse(string s) => Assistant.ParseInt<T>(s);
}

sealed class FloatParser<[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.Interfaces)] T>
    : NumberParser<T> where T : IFloatingPoint<T>
{
    public override T Parse(string s) => Assistant.ParseFloat<T>(s);
}
```

Measured cost is in the same range as the delegate: 4.5 ns for `int`, 22.3 ns for `double`. Inside `IntegerParser<T>` you are back in a fully constrained world, so you can call `T.LeadingZeroCount`, `T.DivRem` or anything else on `IBinaryInteger<T>` without further tricks.

## Option 4: plain reflection on every call (do not ship this)

The second Stack Overflow answer starts with the obvious version, `MakeGenericMethod(typeof(T)).Invoke(...)` on every call, before improving it into option 2. For completeness, here it is with the `MethodInfo` definitions cached in fields:

```csharp
// .NET 11, C# 14
using System.Numerics;
using System.Reflection;

public static class ReflectionDispatch
{
    static readonly MethodInfo ParseIntDef = typeof(Assistant).GetMethod(nameof(Assistant.ParseInt))!;
    static readonly MethodInfo ParseFloatDef = typeof(Assistant).GetMethod(nameof(Assistant.ParseFloat))!;

    public static T Parse<T>(string s) where T : INumber<T>
    {
        MethodInfo def = NumberKind<T>.IsBinaryInteger ? ParseIntDef : ParseFloatDef;
        return (T)def.MakeGenericMethod(typeof(T)).Invoke(null, [s])!;
    }
}
```

It works, but it costs 120 to 145 ns and 256 bytes per call, and exceptions arrive wrapped: `ReflectionDispatch.Parse<int>("oops")` throws `TargetInvocationException` instead of the `FormatException` your callers expect. As the next section shows, it is also the one variant that breaks under Native AOT.

## Option 5: do you need the narrower interface at all?

One answer on the original question makes a fair point: `INumber<T>` already inherits `INumberBase<T>`, which exposes `Parse(ReadOnlySpan<char>, NumberStyles, IFormatProvider)`, `IsNaN` and `IsInfinity`. For many algorithms you never need to dispatch:

```csharp
// .NET 11, C# 14
using System.Globalization;
using System.Numerics;

public static class BaseOnly
{
    public static T Parse<T>(string s) where T : INumber<T>
    {
        ReadOnlySpan<char> text = s.AsSpan().Trim();
        if (text.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            return T.Parse(text[2..], NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
        T x = T.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture);
        if (T.IsNaN(x) || T.IsInfinity(x))
            throw new FormatException($"'{s}' is not a finite number.");
        return x;
    }
}
```

It compiles and handles the happy path for both kinds. The edges are where it leaks, and they are exactly the cases the original helpers were written for:

```text
BaseOnly<double>("0x1F") -> ArgumentException: With the AllowHexSpecifier bit set in the enum bit field, the only other valid bits that can be combined into the enum value must be a subset of HexFloat (...). AllowExponent is required when AllowHexSpecifier is specified. (Parameter 'style')
BaseOnly<int>("2.5")     -> OverflowException: Value was either too large or too small for an Int32.
BaseOnly<int>("1e3")     -> 1000
```

`NumberStyles` flags mean different things for different types, so one style string cannot serve both kinds. Using `NumberStyles.Float` for integers also accepts exponents (`"1e3"` becomes `1000`) and reports a fractional input as an overflow rather than a format error. It was also the slowest non-reflection path for `int` in the benchmark: 17.2 ns against 3.0 ns for the helper that parses the same input with `NumberStyles.Integer`. The hex message is new in .NET 11: .NET 11 added [hexadecimal floating-point parsing with `NumberStyles.HexFloat`](/2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat/), so `double.Parse("0x1Fp0", NumberStyles.HexFloat)` returns `31`, but plain `AllowHexSpecifier` on a `double` still throws. On .NET 10.0.14 the same call throws with "The number styles AllowHexSpecifier and AllowBinarySpecifier are not supported on floating point data types."

So option 5 is right when your logic really is kind-agnostic, and wrong when the whole point is to treat integers and floats differently.

## Benchmark: what each dispatch costs on .NET 11

[BenchmarkDotNet](https://benchmarkdotnet.org/) 0.15.8 on .NET 11.0.0, Apple M4, macOS 27.0.1. Version 0.15.8 does not recognise the `net11.0` moniker for its out-of-process toolchain, so this run used `--inProcess` (InProcessEmitToolchain). Inputs are `"123456"` for `int` and `"1234.5"` for `double`.

```text
| Method            | Mean       | Ratio | Allocated |
|------------------ |-----------:|------:|----------:|
| Direct_Int        |   3.049 ns |  1.00 |         - |
| Switch_Int        |   3.045 ns |  1.00 |         - |
| Delegate_Int      |   4.739 ns |  1.55 |         - |
| Strategy_Int      |   4.484 ns |  1.47 |         - |
| BaseOnly_Int      |  17.200 ns |  5.64 |         - |
| Reflection_Int    | 119.609 ns | 39.24 |     256 B |
| Direct_Double     |  20.899 ns |  6.86 |         - |
| Switch_Double     |  21.059 ns |  6.91 |         - |
| Delegate_Double   |  22.793 ns |  7.48 |         - |
| Strategy_Double   |  22.311 ns |  7.32 |         - |
| Reflection_Double | 144.728 ns | 47.48 |     256 B |
```

The ratio column is relative to `Direct_Int`. Read it per type: for `double`, the delegate and strategy versions add under 2 ns to a 21 ns parse. Unless the dispatched operation is itself only a few nanoseconds, options 1 to 3 are all effectively free. Only per-call reflection is a real cost.

## What Native AOT does with each option

Dispatching through reflection raises the obvious question for [Native AOT](/2026/06/what-is-native-aot-and-what-does-it-cost-you/): there is no JIT to create `ParseInt<UInt128>` at runtime if the compiler did not generate it ahead of time. I published the same code with `<PublishAot>true</PublishAot>` (`dotnet publish -c Release -r osx-arm64`, SDK 11.0.100) and looked at both the warnings and the runtime behaviour.

Without the `[DynamicallyAccessedMembers]` annotations, the build warns about `GetInterfaces()`:

```text
Numbers.cs(34,9): warning IL2090: 'this' argument does not satisfy 'DynamicallyAccessedMemberTypes.Interfaces' in call to 'System.Type.GetInterfaces()'. The generic parameter 'T' of 'NumberKind<T>' does not have matching annotations.
```

Annotating `T` with `DynamicallyAccessedMemberTypes.Interfaces` fixes it, and the annotation has to be repeated on every generic type that passes its `T` into `NumberKind<T>`, including the strategy subclasses (otherwise you get IL2091). That is why the attributes appear in every listing above.

With the annotations in place, the only remaining warnings point at option 4:

```text
Numbers.cs(47,19): warning IL2060: Call to 'System.Reflection.MethodInfo.MakeGenericMethod(params Type[])' can not be statically analyzed. It's not possible to guarantee the availability of requirements of the generic method.
Numbers.cs(47,19): warning IL3050: Using member 'System.Reflection.MethodInfo.MakeGenericMethod(params Type[])' which has 'RequiresDynamicCodeAttribute' can break functionality when AOT compiling. The native code for this instantiation might not be available at runtime.
```

The delegate (option 2) and strategy (option 3) versions produce no warnings. In those, the AOT compiler can see which method or type definition is being instantiated (a `GetMethod` call with one of two constant names, or `typeof(IntegerParser<>)`) and that the argument is `typeof(T)` of the enclosing generic, so it generates the instantiations for every `T` it sees used. In option 4 the `MethodInfo` comes out of a static field, so the analysis gives up. The published binary bears that out. In the first AOT run, where nothing else in the program used `ParseInt<UInt128>`:

```text
IsDynamicCodeSupported=False
Delegate<Half>      -> 2.5
Strategy<decimal>   -> 2.5
Reflection<int>     -> 31
Reflection<UInt128> -> NotSupportedException: 'Assistant.ParseInt[System.UInt128](System.String)' is missing native code. MethodInfo.MakeGenericMethod() is not compatible with AOT compilation. Inspect and fix AOT related warnings that were generated when the app was published.
```

`Reflection<int>` only worked because other code in the same program (the type switch) already called `Assistant.ParseInt<int>`, so its native code existed by accident. In a second publish that added `DelegateDispatch<UInt128>`, `NumberParser<sbyte>` and `NumberParser<NFloat>`, all three worked, even though nothing called the helpers with those types directly.

The rule of thumb: if the IL3050 warning is gone, the pattern is safe under AOT; if it is there, believe it. This is the same reasoning behind other AOT failures such as [`PlatformNotSupportedException` in Native AOT](/2026/05/fix-platformnotsupportedexception-in-native-aot/) and [reflection-based serialization being disabled](/2026/07/fix-reflection-based-serialization-has-been-disabled-for-this-application/): code that works under the JIT can still be missing from the AOT binary.

## Which one to pick

- **A small, fixed set of types** (your library supports `int`, `long` and `double`): use the type switch. Zero overhead, zero reflection, AOT-clean. Add a unit test per supported type so a missing branch shows up in CI.
- **Any `INumber<T>`, one operation**: cache a delegate in a static generic class.
- **Any `INumber<T>`, several operations per kind**: use strategy classes. Inside them you have the full `IBinaryInteger<T>` or `IFloatingPoint<T>` surface.
- **Logic that does not really differ per kind**: stay on `INumberBase<T>` and skip dispatch, but test the edge inputs, because `NumberStyles` semantics differ between integer and floating-point types.
- **Never**: uncached `MethodInfo.Invoke` per call. It is about 40x slower, allocates, wraps exceptions, and is the variant that fails under Native AOT.

The underlying limitation is the language, not the library: C# 14 cannot say "if `T` is also an `IBinaryInteger<T>`, treat it as one in this block". Until it can, every solution is a way of getting to a place where the stronger constraint was declared up front. If you go further and make the dispatched methods themselves generic virtuals, note that the [.NET 11 JIT now devirtualizes generic virtual methods](/2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods/) in more cases, so measure on .NET 11 rather than reusing older numbers.

## Sources

- [Stack Overflow: Downcast generic interface (INumber<T>) to derived generic interface (IBinaryInteger<T>)](https://stackoverflow.com/questions/80011917)
- [Generic math in .NET (Microsoft Learn)](https://learn.microsoft.com/dotnet/standard/generics/math)
- [`IBinaryInteger<TSelf>` interface](https://learn.microsoft.com/dotnet/api/system.numerics.ibinaryinteger-1) and [`IFloatingPoint<TSelf>` interface](https://learn.microsoft.com/dotnet/api/system.numerics.ifloatingpoint-1)
- [Introduction to AOT warnings (IL3050)](https://learn.microsoft.com/dotnet/core/deploying/native-aot/fixing-warnings)
- [Prepare .NET libraries for trimming (`DynamicallyAccessedMembers`)](https://learn.microsoft.com/dotnet/core/deploying/trimming/prepare-libraries-for-trimming)
- [dotnet/runtime#124139: hexadecimal floating-point parsing and formatting](https://github.com/dotnet/runtime/pull/124139)
