---
title: "Fix: CS1660 Cannot convert lambda expression to type because it is not a delegate type, on a C# 15 union"
description: "A lambda or method group has no type, so no union conversion exists. Cast to the delegate case type, use new(...), or assign a typed local first."
pubDate: 2026-11-24
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-15"
  - "dotnet-11"
  - "unions"
---

Give the lambda a delegate type before it reaches the union: cast it to the case type (`(Func<int>)(() => 42)`), call the constructor with `new(() => 42)`, or assign it to a `Func<int>` (or `var`) local first and assign that local to the union. C# 15 union conversions only exist from expressions that already have a standard implicit conversion to a case type, and a lambda or method group gets its delegate type through a different kind of conversion. Everything below was compiled and run on the .NET 11 GA SDK `11.0.100` (runtime `11.0.0`, C# 15, no `LangVersion` override).

## The error in context

You declare a union with a delegate case, the integer case converts fine, and the lambda does not:

```csharp
// .NET 11 SDK 11.0.100, C# 15
public union ValueSource(int, Func<int>);

ValueSource src1 = 42;             // OK
ValueSource src2 = () => 42;       // error CS1660
ValueSource src3 = IntSource.Get;  // error CS0428
```

```text
error CS1660: Cannot convert lambda expression to type 'ValueSource' because it is not a delegate type
error CS0428: Cannot convert method group 'Get' to non-delegate type 'ValueSource'. Did you intend to invoke the method?
```

CS1660 is the lambda flavour, CS0428 is the method group flavour. Same root cause, same fixes. This exact pair was asked on [Stack Overflow](https://stackoverflow.com/questions/80017970) shortly after .NET 11 shipped, and it surprises people because the [union docs](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/union#union-conversions) say an implicit union conversion exists "from each case type to the union type". `Func<int>` is a case type. So why does it not convert?

## Why a lambda does not convert to a union

Three rules from the spec stack up:

1. **A lambda has no type of its own.** A lambda expression or method group is an expression without a type. It becomes a delegate only through an [anonymous function conversion or a method group conversion](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/conversions#107-anonymous-function-conversions) to a specific delegate type. Since C# 10 a lambda can have a *natural type* (`var f = () => 42;` infers `Func<int>`), but that natural type is only used when there is no target type.
2. **Those conversions are not standard implicit conversions.** The [list of standard implicit conversions](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/conversions#1042-standard-implicit-conversions) is identity, numeric, reference, boxing, nullable, null literal, and a few others. Anonymous function and method group conversions are not on it.
3. **Union conversions are defined in terms of standard implicit conversions.** The [C# 15 unions specification](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#union-conversions) says there is a union conversion to `U` from an expression `E` "if there's a standard implicit conversion from `E` to a type `C` and `C` is a parameter type of a union creation member of `U`".

Put together: `42` has a standard implicit conversion (identity) to `int`, so the union conversion exists. `() => 42` has no standard implicit conversion to `Func<int>`, so the compiler finds no conversion to `ValueSource` at all, falls back to the generic "this target is not a delegate" diagnostic, and reports CS1660.

The spec also says a union conversion "is executed by calling the union's creation member", so `ValueSource s = 42;` lowers to `new ValueSource(42)`. That describes code generation, not applicability. The lowering only happens after the conversion has been classified, and the classification step is where the lambda is rejected. That is why `new ValueSource(() => 42)` compiles: it is ordinary overload resolution against the generated constructors, where the lambda is target-typed by each constructor's parameter.

This is not a union-specific limitation. User-defined implicit operators have had the same rule since C# 1. A class with `public static implicit operator Plain(Func<int> f)` also gives `error CS1660: Cannot convert lambda expression to type 'Plain' because it is not a delegate type` for `Plain p = () => 1;`. The unions spec describes union conversion as "just another form of an implicit user-defined conversion", and it inherited this rule along with the rest.

## Minimal repro

Every position where a lambda is target-typed to the union fails the same way. This file produces five CS1660/CS0428 errors on SDK 11.0.100:

```csharp
// .NET 11 SDK 11.0.100, C# 15, <Nullable>enable</Nullable>
ValueSource src1 = 42;
ValueSource src2 = () => 42;             // CS1660 (local initializer)
ValueSource src3 = IntSource.Get;        // CS0428 (method group)
Use(() => 42);                           // CS1660 (argument)
static ValueSource Make() => () => 42;   // CS1660 (return)
ValueSource src4 = true ? 1 : () => 2;   // CS1660 (conditional branch)

static void Use(ValueSource s) { }

public union ValueSource(int, Func<int>);
public class IntSource { public static int Get() => 42; }
```

The variations people reach for next fail the same way:

```csharp
// .NET 11 SDK 11.0.100, C# 15 -- all still CS1660
ValueSource a = int () => 42;                  // explicit lambda return type
ValueSource b = static () => 42;               // static lambda
ValueSource c = (ValueSource)(() => 42);       // cast straight to the union
```

The explicit return type is the interesting one. `int () => 42` has a natural type of `Func<int>`, but in the presence of a target type the compiler still classifies it as an anonymous function conversion to that target. The cast to `ValueSource` fails too, because the spec says there are "no explicit union conversions beyond the implicit union conversions".

## Fixes, in order of preference

All of these compiled and printed the expected values in one console app on SDK 11.0.100 / runtime 11.0.0.

### 1. Target-typed `new(...)` at the call site

```csharp
// .NET 11 SDK 11.0.100, C# 15
ValueSource s2 = new(() => 2);
ValueSource s3 = new ValueSource(IntSource.Get);
```

This is the cleanest fix when you are already on a line that names the union. `new(...)` goes through overload resolution on the generated constructors (`ValueSource(int)` and `ValueSource(Func<int>)`), and the lambda converts to the `Func<int>` parameter the normal way. Method groups work the same way.

### 2. Cast the lambda to the case type

```csharp
// .NET 11 SDK 11.0.100, C# 15
ValueSource s1 = (Func<int>)(() => 1);
Use((Func<int>)IntSource.Get);
```

Once the expression is a `Func<int>`, the conversion to the union is an identity conversion to the case type followed by a union conversion, which the spec allows. Use this in argument position where `new(...)` would need the union's name anyway, or when the union has several delegate cases and you want to be explicit about which one you mean.

### 3. Give the lambda a type in a local first

```csharp
// .NET 11 SDK 11.0.100, C# 15
Func<int> f = () => 4;
ValueSource s4 = f;

var nat = () => 5;           // natural type: Func<int>
ValueSource s5 = nat;

var mg = IntSource.Get;      // natural type of a method group: Func<int>
ValueSource s6 = mg;
```

The local is an expression with a real type, so the union conversion applies. The `var` form relies on C# 10 natural types and stops working when the natural type is not what the union expects. A method group with several overloads has no natural type, so `var mg = Overloaded.Get;` fails with CS8917 before the union is even involved. A lambda whose parameters have no types (`x => x + 1`) has no natural type either, and needs the `Func<int, int>` local.

### 4. Add a named factory to the union body

```csharp
// .NET 11 SDK 11.0.100, C# 15
public union ValueSource(int, Func<int>)
{
    public static ValueSource From(Func<int> factory) => new(factory);
}

ValueSource s7 = ValueSource.From(() => 7);
```

A union declaration can have a body with static members, so a factory method is a natural API for the delegate case. It reads better than a cast at every call site and gives you a place to document what the delegate means (lazy value, callback, and so on).

What does **not** work is adding `public static implicit operator ValueSource(Func<int> f) => new(f);` to the union body. It compiles, but `ValueSource a = () => 42;` still reports CS1660, for the same "user-defined conversions need a typed source" reason as the `Plain` class above.

## Generic unions: inference breaks before the lambda does

If the union is generic, there is a second wall. With `public union Deferred<T>(T, Func<T>);` and a generic consumer:

```csharp
// .NET 11 SDK 11.0.100, C# 15
static void Take<T>(Deferred<T> d) { }

Take(42);            // CS0411: type arguments cannot be inferred
Take<int>(() => 42); // CS1660: lambda to 'Deferred<int>'
Take<int>(8);        // OK
```

Type inference does not look through union conversions. `42` is an `int`, not a `Deferred<T>`, so there is nothing to infer `T` from and you get CS0411 even for the non-lambda case. Once you supply `T`, the lambda case fails with CS1660 for the reason above.

The fix is a non-generic static class with a generic factory, which moves inference onto a parameter typed `Func<T>`:

```csharp
// .NET 11 SDK 11.0.100, C# 15
public union Deferred<T>(T, Func<T>);

public static class Deferred
{
    public static Deferred<T> Lazy<T>(Func<T> factory) => new(factory);
}

Take(Deferred.Lazy(() => 10));        // T inferred as int, prints "lazy 10"
Take(new Deferred<int>(() => 9));     // explicit, prints "lazy 9"
```

Inference works on `Lazy<T>(Func<T>)` because lambda return types do participate in method type inference. The return value is already a `Deferred<int>`, so `Take` infers from it with an identity conversion.

## Gotchas and lookalikes

**Two delegate cases that the same lambda fits.** With `public union FuncOrExpr(Func<int>, Expression<Func<int>>);`, even `new FuncOrExpr(() => 42)` fails with `error CS0121: The call is ambiguous between ... FuncOrExpr(Func<int>) and ... FuncOrExpr(Expression<Func<int>>)`. This is the ambiguity one of the Stack Overflow answers predicted for a hypothetical lambda-to-union conversion, and it is already real for the constructor. Cast to the case you want: `(Func<int>)(() => 1)` stores a `Func<int>`, `(Expression<Func<int>>)(() => 2)` stores an expression tree.

**Collection expressions fail too, with a different error.** `public union Many(int, int[]); Many m = [1, 2, 3];` gives `error CS9174: Cannot initialize type 'Many' with a collection expression because the type is not constructible.` Collection expression conversions are not standard implicit conversions either. Use `new Many([1, 2, 3])` or `(int[])[1, 2, 3]`. If you want the background on how collection expressions pick their target, see [C# 12 collection expressions](/2023/08/c-12-collection-expressions/).

**`null` with more than one reference case gives a misleading error.** `public union Opt(string, Func<int>); Opt o = null;` reports `error CS0037: Cannot convert null to 'Opt' because it is a non-nullable value type`. The null literal has a standard implicit conversion to both `string` and `Func<int>`, so there is no single creation member to call. With exactly one reference case (`public union OneRef(string, int)`), `OneRef r = null;` compiles (with a CS8604 nullability warning) and produces a union whose `Value` is `null`. Write `(string?)null` to pick the `string` constructor (on a non-nullable `string` case that compiles with the same CS8604 warning), or `default` for an empty union.

**Reading the delegate back out.** Once the value is in, pattern matching on the union is exhaustive over its cases, so a switch expression needs no discard arm:

```csharp
// .NET 11 SDK 11.0.100, C# 15
static int Read(ValueSource s) => s switch
{
    int i => i,
    Func<int> fn => fn(),
};
```

If you switch on `s.Value` instead, you lose exhaustiveness. That and the `case null` rule for switch statements are covered in [the CS8509 and CS0161 fix for union switches](/2026/10/fix-cs8509-cs0161-switch-exhaustive-over-csharp-15-union-type/).

## How the repro was checked

The four console projects behind this post target `net11.0` with `<Nullable>enable</Nullable>` and `<ImplicitUsings>enable</ImplicitUsings>`, built with `dotnet build` and run with `dotnet run` on SDK 11.0.100 (runtime Microsoft.NETCore.App 11.0.0) on macOS arm64. The error texts above are copied from that compiler output. The fixes project printed `1 2 3 4 5 3 7` for the seven `ValueSource` values, `eager 8`, `lazy 9`, `lazy 10` for the generic cases, and `True` for the null `OneRef`. Behaviour was not checked against earlier .NET 11 previews or RCs.

## Related

- [C# 15 union types ship in .NET 11 Preview 2](/2026/04/csharp-15-union-types-dotnet-11-preview-2/) covers the `union` declaration syntax and what the compiler generates.
- [Fix: CS8509 or CS0161 on a switch that is exhaustive over a C# 15 union type](/2026/10/fix-cs8509-cs0161-switch-exhaustive-over-csharp-15-union-type/) is the next error you are likely to hit after construction works.
- [Serializing C# union types with System.Text.Json](/2026/07/serialize-csharp-union-types-with-system-text-json-dotnet-11-preview-6/) is worth reading before you put a delegate case like `Func<int>` into a union that also crosses a wire.
- [Where C# unions bind in ASP.NET Core 11](/2026/09/csharp-unions-in-aspnetcore-11-where-binding-works/) shows which request sources accept union parameters.
- [The original discriminated unions proposal](/2026/01/csharp-proposal-discriminated-unions/) for the design history.

## Sources

- [C# 15 unions feature specification: union conversions](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-15.0/unions.md#union-conversions)
- [Union types reference on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/union#union-conversions)
- [C# specification: standard implicit conversions](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/conversions#1042-standard-implicit-conversions)
- [C# specification: anonymous function conversions](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/language-specification/conversions#107-anonymous-function-conversions)
- [Stack Overflow: Why can I not assign a delegate or lambda to a C# 15+ union type?](https://stackoverflow.com/questions/80017970)
