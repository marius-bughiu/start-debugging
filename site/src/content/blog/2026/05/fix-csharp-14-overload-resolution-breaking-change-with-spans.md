---
title: "Fix: C# 14 overload resolution breaking change with Span and ReadOnlySpan"
description: "After upgrading to C# 14 / .NET 10, calls like array.Contains, x.Reverse(), and MemoryMarshal.Cast suddenly bind to different overloads or stop compiling. Here is what changed and how to pin the old behaviour where it matters."
pubDate: 2026-05-19
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet-10"
  - "spans"
  - "breaking-changes"
---

You upgrade a project to C# 14 (shipped with .NET 10, Roslyn 4.13, Visual Studio 17.13) and one of three things happens: an `Expression<Func<int[], int, bool>>` that used to compile and run now throws at runtime, a call to `MemoryMarshal.Cast(array)` stops compiling with an ambiguity error, or an `xUnit` `Assert.Equal([2], myArray)` flips from "passes" to "ambiguous match between Assert.Equal overloads". They are all the same breaking change. C# 14's first-class span types make `T[]` implicitly convertible to `Span<T>` and `ReadOnlySpan<T>` during overload resolution, type inference, and extension method binding, and that flips which overload wins in code that used to be unambiguous.

This post walks through the four scenarios I have actually hit in real .NET 10 upgrades, shows the minimal repro for each, and gives the recommended fix. All examples target `<LangVersion>14.0</LangVersion>` and `<TargetFramework>net10.0</TargetFramework>` unless noted.

## Why C# 14 picks different overloads now

In C# 13 and earlier, the user-defined implicit conversions from `T[]` to `Span<T>` and `ReadOnlySpan<T>` (declared in the runtime via `op_Implicit`) were treated as library-defined, not language-defined. The compiler did not consider them during overload resolution, type inference, or extension method binding. That is why, before .NET 10, you had to write `myArray.AsSpan().BinarySearch(...)` when you wanted the span overload of a method that also had an `IEnumerable<T>` overload. The compiler would silently pick the non-span overload because it could not see the conversion.

C# 14's [first-class span types proposal](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md) promotes those conversions to the language. Concretely, after the upgrade the compiler considers these conversions during overload resolution:

- `T[]` to `Span<T>`
- `T[]` to `ReadOnlySpan<T>`
- `T[]` to `ReadOnlySpan<U>` where `T` is reference-convertible to `U`
- `Span<T>` to `ReadOnlySpan<T>`
- `string` to `ReadOnlySpan<char>`

It also adds tie-breaking rules: when both a `Span<T>` and a `ReadOnlySpan<T>` overload are applicable for the same argument, `ReadOnlySpan<T>` is preferred. The reason for that preference comes up later (covariant arrays), so keep it in mind.

The Roslyn team documented this as a [behavioural breaking change](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution) and another entry in the [compiler breaking changes since C# 13](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010) list. There is no single compiler error code that fires for "this resolution changed". Some scenarios still compile silently but bind differently, some now produce `CS0121` "the call is ambiguous", and some throw at runtime. The fixes depend on which bucket you are in.

## Bucket 1: Expression lambdas now call `MemoryExtensions` instead of `Enumerable`

This is the nastiest one because it compiles fine and only breaks at runtime when the expression tree is interpreted instead of compiled to IL.

```csharp
// C# 14, .NET 10
using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;

Expression<Func<int[], int, bool>> e = (array, num) => array.Contains(num);
var fn = e.Compile(preferInterpretation: true);
fn(new[] { 1, 2, 3 }, 2); // throws at runtime
```

In C# 13, `array.Contains(num)` inside the expression tree bound to `System.Linq.Enumerable.Contains<T>(IEnumerable<T>, T)`. In C# 14, the compiler now sees that `int[]` implicitly converts to `ReadOnlySpan<int>`, so the better-match overload is `System.MemoryExtensions.Contains<T>(ReadOnlySpan<T>, T)`. The expression tree gets built around `MemoryExtensions.Contains`. When you ask for interpretation (`preferInterpretation: true`), the LINQ expression interpreter cannot handle `ReadOnlySpan<T>` parameters in arbitrary method calls and either throws a `NotSupportedException` or, in some EF Core providers that translate the tree, a `System.InvalidOperationException` about an unsupported method.

The fix is to bind the non-span overload explicitly inside the lambda. There are three idioms that work:

```csharp
// .NET 10, C# 14
M((array, num) => ((IEnumerable<int>)array).Contains(num)); // cast forces Enumerable.Contains
M((array, num) => array.AsEnumerable().Contains(num));      // ditto, slightly less ugly
M((array, num) => Enumerable.Contains(array, num));         // explicit static call, no extension lookup

void M(Expression<Func<int[], int, bool>> e) => e.Compile(preferInterpretation: true);
```

All three force the compiler to bind `Enumerable.Contains` instead of `MemoryExtensions.Contains`. The cast version is the cheapest at runtime (the expression tree just contains a cast node) and is the one I reach for first.

If you maintain a library that builds expression trees on behalf of callers, audit any `IQueryable.Provider.Execute` paths and any code that uses `Compile(preferInterpretation: true)`. EF Core 9 and later compile to IL, so most EF Core queries are not affected, but any third-party expression interpreter is.

## Bucket 2: `xUnit` Assert.Equal becomes ambiguous

If you have ever written this in an xUnit test, you have a tripwire:

```csharp
// .NET 10, C# 14, xUnit 2.9+
var x = new long[] { 1 };
Assert.Equal([2], x);
// CS0121: The call is ambiguous between the following methods or properties:
// 'Assert.Equal<T>(T[], T[])' and 'Assert.Equal<T>(ReadOnlySpan<T>, Span<T>)'
```

Both overloads are applicable. The collection expression `[2]` can target-type to `long[]` or to `Span<long>`. The variable `x` is `long[]`, which implicitly converts to either `T[]` or `Span<T>`. No single best overload exists, so you get `CS0121`.

The recommended workaround is to disambiguate one of the arguments:

```csharp
// .NET 10, C# 14
var x = new long[] { 1 };
Assert.Equal([2], x.AsSpan());   // binds to (ReadOnlySpan<T>, Span<T>)
// or
Assert.Equal<long>([2], x);      // generic argument disambiguates to (T[], T[]) when no Span overload matches T
```

A subtler variant trips when you mix `T[]` and `ArraySegment<T>`:

```csharp
// .NET 10, C# 14
var y = new int[] { 1, 2 };
var s = new ArraySegment<int>(y, 1, 1);
Assert.Equal(y, s); // previously bound to Assert.Equal<T>(T, T), now ambiguous with Assert.Equal<T>(Span<T>, Span<T>)
Assert.Equal(y.AsSpan(), s); // workaround
```

`ArraySegment<int>` has an implicit conversion to both `Span<int>` and `ReadOnlySpan<int>`, and `int[]` now does too, so the span overload becomes applicable and competes with the generic `T, T` one.

If you own the API surface (you wrote `Assert.Equal`), the right fix is to apply [`OverloadResolutionPriorityAttribute`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute) to one of the overloads to bias resolution. xUnit shipped this in 2.9.x for exactly this reason. If you cannot recompile the API, you have to disambiguate at the call site.

## Bucket 3: covariant arrays throw `ArrayTypeMismatchException`

This is the bug that actually deletes data and the reason the language committee made `ReadOnlySpan<T>` win over `Span<T>` in C# 14 ties.

```csharp
// .NET 10, C# 14
using System;
using System.Collections.Generic;
using System.Linq;

string[] s = new[] { "a" };
object[] o = s; // array variance: legal since C# 1

C.R(o);             // C# 13: prints 1 (IEnumerable overload). C# 14: ArrayTypeMismatchException
C.R(o.AsEnumerable()); // workaround

static class C
{
    public static void R<T>(IEnumerable<T> e) => Console.Write(1);
    public static void R<T>(Span<T> s)        => Console.Write(2);
}
```

What happens: `object[] o` is really a `string[]` under the hood. In C# 13, the only applicable overload was `R<T>(IEnumerable<T>)`, so it printed `1`. In C# 14, `R<T>(Span<T>)` is also applicable because `T[]` now implicitly converts to `Span<T>`. The compiler picks the span overload (it is "more specific"), inserts a `Span<object>(o)` constructor call, and the constructor throws `System.ArrayTypeMismatchException` at runtime because you cannot write `object` into a backing `string[]`.

This is why the C# 14 tie-breaking rules prefer `ReadOnlySpan<T>` over `Span<T>`: a `ReadOnlySpan<T>` cannot write into the backing array, so it is safe with covariant arrays. The recommended fix when you control the API is to add a `ReadOnlySpan<T>` overload:

```csharp
// .NET 10, C# 14
static class C
{
    public static void R<T>(IEnumerable<T> e)    => Console.Write(1);
    public static void R<T>(Span<T> s)           => Console.Write(2);
    public static void R<T>(ReadOnlySpan<T> s)   => Console.Write(3); // wins over Span<T> in C# 14
}
```

Now `C.R(o)` prints `3` (no exception). When you cannot add an overload, the call-site fix is `o.AsEnumerable()` or `((IEnumerable<object>)o)`.

## Bucket 4: `MemoryMarshal.Cast` and the ReadOnlySpan tie-break

The `ReadOnlySpan<T>` preference also breaks some library patterns where the writer intended you to opt in to one overload by passing a `Span<T>`:

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

double[] x = new double[0];
Span<ulong> y = MemoryMarshal.Cast<double, ulong>(x);
// CS0029: Cannot implicitly convert type 'ReadOnlySpan<ulong>' to 'Span<ulong>'
Span<ulong> z = MemoryMarshal.Cast<double, ulong>(x.AsSpan()); // workaround
```

`MemoryMarshal.Cast` has both `Cast<TFrom, TTo>(Span<TFrom>)` and `Cast<TFrom, TTo>(ReadOnlySpan<TFrom>)`. In C# 13, passing a `double[]` resolved through the user-defined conversion to `Span<TFrom>` because there was no tie-break and `Span<T>` was the "direct" target. In C# 14, both overloads are applicable through the new built-in conversions, the `ReadOnlySpan<T>` overload wins the tie-break, and the result is no longer assignable to a `Span<ulong>` local. You either call `.AsSpan()` explicitly to skip the array-to-span conversion (it produces a `Span<double>` directly, which only matches the `Span` overload) or change the local's type to `ReadOnlySpan<ulong>` if you do not need mutability.

## The `Enumerable.Reverse` corner case for downlevel targets

There is one extra trap that only affects an unsupported configuration but is worth flagging because it shows up in legacy migration projects. If you set `<LangVersion>14.0</LangVersion>` but target an older TFM such as `net8.0` with a `System.Memory` reference, this happens:

```csharp
// LangVersion 14, TargetFramework net8.0 (unsupported)
int[] x = new[] { 1, 2, 3 };
var y = x.Reverse(); // C# 13: Enumerable.Reverse, returns IEnumerable<int>
                     // C# 14: MemoryExtensions.Reverse, void in-place reverse
```

`MemoryExtensions.Reverse(Span<T>)` reverses in place and returns `void`, while `Enumerable.Reverse(IEnumerable<T>)` returns the reversed sequence. The semantics flip and `y` is no longer iterable. On `net10.0` this is patched by a new `Enumerable.Reverse(this T[])` overload that takes precedence, so the break only surfaces when you mix new compiler with old BCL. The right fix is to upgrade the TFM, but if you cannot, call `Enumerable.Reverse(x)` explicitly or define your own `Reverse(this T[])` extension in your namespace.

## Detecting this before runtime

A few practical mitigations for an upgrade in flight:

- Set `<LangVersion>13.0</LangVersion>` on individual projects while you triage. C# 14 features unrelated to spans (lambda parameter modifiers, partial constructors, `field` keyword) will be disabled but resolution stays predictable.
- Turn on Roslyn analyzer [CA1872](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1872) and the ReSharper/Rider inspection ["C# 14 breaking change in overload resolution with span parameters"](https://www.jetbrains.com/help/resharper/CSharp14OverloadResolutionWithSpanBreakingChange.html). The Rider inspection specifically highlights call sites where the new conversions change which overload is selected.
- Audit `Compile(preferInterpretation: true)` and any third-party expression tree consumer (e.g. older EF6 providers, Marten 6.x, Linq2DB pre-5.x). They are the highest-risk spots because the change is silent at compile time.
- Search for `Assert.Equal(`, `Assert.Contains(`, and similar collection-typed assertions in your test suite. Upgrade xUnit to a version with `OverloadResolutionPriorityAttribute` annotations (xUnit 2.9.x or newer).

If you are an API author, the cleanest long-term fix is to add `ReadOnlySpan<T>` overloads alongside any existing `Span<T>` ones and apply `[OverloadResolutionPriority(1)]` to the one you want callers to bind to. The attribute is honoured by the C# 13 and C# 14 compilers (it is ignored on older `LangVersion` settings, which is the one wrinkle), so it covers most migration scenarios.

## Related

If you want the background on why these conversions exist in the first place, the deep dive on [implicit Span conversions in C# 14 and first-class support for Span and ReadOnlySpan](/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) covers the full conversion table and the motivation. The broader [what's new in C# 14](/2024/12/csharp-14/) post lists the other breaking changes you should expect on the same upgrade, including the `scoped` lambda parameter modifier and the `field` contextual keyword. For an upcoming-language preview, [C# 15 collection expression arguments](/2026/04/csharp-15-collection-expression-arguments/) builds on top of these span rules and is worth reading once you are comfortable with how the compiler picks between span and non-span targets.

## Sources

- [Breaking change: C# 14 overload resolution with span parameters (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/csharp-overload-resolution)
- [C# compiler breaking changes since C# 13 (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/breaking-changes/compiler%20breaking%20changes%20-%20dotnet%2010)
- [First-class span types proposal (dotnet/csharplang)](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [Issue dotnet/docs#43952: covariant array overload selection](https://github.com/dotnet/docs/issues/43952)
- [OverloadResolutionPriorityAttribute (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute)
- [Rider inspection: C# 14 overload resolution with span parameters (JetBrains)](https://www.jetbrains.com/help/rider/CSharp14OverloadResolutionWithSpanBreakingChange.html)
