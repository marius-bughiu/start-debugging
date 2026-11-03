---
title: "What does [CallerArgumentExpression] capture, and how do I use it in my own guard methods?"
description: "[CallerArgumentExpression] makes the C# compiler pass the source text of an argument as a string. Verified on .NET 10 and C# 14: what exactly gets captured (whitespace, comments, parentheses, line breaks), when you get null instead, how to write NotNull, Positive and That guards, and the overload trap that silently disables it."
pubDate: 2026-11-03
tags:
  - "csharp"
  - "dotnet"
  - "attributes"
  - "exceptions"
---

**Short answer:** `[CallerArgumentExpression("value")]` on an optional `string?` parameter tells the C# compiler to pass the source text of the argument given for `value`, as a string literal baked in at the call site. Call `Guard.NotNull(user.Address)` and the second parameter arrives as `"user.Address"`, not as `"value"` and not as the runtime value. It is the attribute behind `ArgumentNullException.ThrowIfNull` (.NET 6+), and you can put it on your own guard methods with one extra parameter. Everything below was checked on the .NET 10 SDK 10.0.302 (runtime 10.0.10, C# 14) unless a section says otherwise.

The feature shipped with C# 10 and .NET 6. The attribute type itself, `System.Runtime.CompilerServices.CallerArgumentExpressionAttribute`, has been in the base class library since .NET Core 3.0, which matters later when we get to `netstandard2.0`.

## The minimal guard, and what the compiler rewrites it into

```csharp
// .NET 10 (SDK 10.0.302), C# 14
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;

public static class Guard
{
    public static T NotNull<T>(
        [NotNull] T? value,
        [CallerArgumentExpression(nameof(value))] string? paramName = null)
        where T : class
        => value ?? throw new ArgumentNullException(paramName);
}

// call site
var user = new User("Ada", null);
Guard.NotNull(user.Address);
// ArgumentNullException: Value cannot be null. (Parameter 'user.Address')
```

There is no reflection, no stack walk, and no `Expression<T>` tree. At the call site the compiler sees that you omitted `paramName`, looks up the parameter named by the attribute (`value`), takes the syntax of the argument you passed for it, and emits the call as if you had written `Guard.NotNull(user.Address, "user.Address")`. That is why the cost is the same as passing a string literal, and why it works across assembly boundaries: the attribute only has to be visible to the compiler building the *caller*.

Three rules make it work:

1. The parameter must be optional (have a default, usually `null`). A required parameter is always supplied by the caller, so there is nothing for the compiler to fill in.
2. Its type must accept a `string`. `string?` is the usual choice.
3. The constructor argument must name another parameter of the same method. Since C# 11 you can write `nameof(value)` there instead of the string `"value"`, which survives renames.

## What exactly gets captured

The [feature specification](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-10.0/caller-argument-expression) says the compiler passes the argument's text. "Text" has a few sharp edges, so here is what a probe method returned for different arguments:

```csharp
// .NET 10 (SDK 10.0.302), C# 14
static string? Echo(object? value,
    [CallerArgumentExpression(nameof(value))] string? expression = null) => expression;
```

| Call | `expression` |
|---|---|
| `Echo(user.Address?.City)` | `user.Address?.City` |
| `Echo(  retries   *  2  )` | `retries   *  2` |
| `Echo(retries /* inline comment */ + 1)` | `retries /* inline comment */ + 1` |
| `Echo(/* lead */ retries /* trail */)` | `retries` |
| `Echo((retries))` | `retries` |
| `Echo(((retries > 0)))` | `retries > 0` |
| `Echo(1 + 1)` | `1 + 1` |
| `Echo("literal")` | `"literal"` (quotes included) |
| `Echo(@"a ""b"" c")` | `@"a ""b"" c"` |
| `Echo($"{retries} tries")` | `$"{retries} tries"` |
| `Echo(() => retries > 0)` | `() => retries > 0` |
| `Echo(retries is > 0 and < 10)` | `retries is > 0 and < 10` |
| `Echo((object)d)` | `(object)d` |

The pattern:

- **Leading and trailing whitespace and comments are trimmed.** Everything between the first and last token is kept verbatim, including doubled spaces and inline comments.
- **Redundant outer parentheses are stripped.** `((x > 0))` becomes `x > 0`. Parentheses that are part of the expression, like the cast `(object)d`, stay.
- **Nothing is evaluated or folded.** `1 + 1` is `"1 + 1"`, not `"2"`. A string literal is captured with its quotes and its `@` or `$` prefix, exactly as written.
- **Line breaks and indentation survive.** A fluent chain split over lines comes through as one string with embedded newlines and the original leading spaces:

```csharp
// .NET 10 (SDK 10.0.302), C# 14
Echo(
    user
        .Name
        .Length);
// "user\n        .Name\n        .Length"
```

If you put the captured text into a single-line log format, normalise whitespace yourself. The compiler will not do it for you.

## When you get null instead of the expression

The parameter is only filled when the compiler binds a direct call and the caller omits the argument. Everything else leaves you with the default value:

```csharp
// .NET 10 (SDK 10.0.302), C# 14
Echo(retries, "explicit");                          // "explicit": the caller wins
Echo(expression: "named first", value: retries);    // "named first"
Echo(retries, null);                                // null: an explicit null is still explicit

delegate string? EchoDel(object? value, string? expression = null);
EchoDel del = Echo;
del(retries);                                       // null: the delegate's Invoke has no attribute

typeof(Program).GetMethod(...).Invoke(null, [retries, Type.Missing]); // null: reflection
```

Two cases are worth knowing:

- **`dynamic` arguments still work.** `Echo(d)` where `d` is `dynamic` returned `"d"`. The text is known at compile time even though the binding happens at run time.
- **A wrong parameter name is a warning, not an error.** `[CallerArgumentExpression("valeu")]` produces CS8963 and the parameter silently stays `null`. Pointing the attribute at its own parameter produces CS8965, same result. `nameof` eliminates the first one entirely, which is the main reason to prefer it.

Because `null` is always a possible value, your guard should not assume the expression is there. `paramName ?? nameof(value)` is a cheap fallback for the delegate and reflection paths.

## Extension methods and C# 14 extension members capture the receiver

The `this` parameter of a classic extension method is an ordinary parameter as far as the attribute is concerned, so the receiver text is captured:

```csharp
// .NET 10 (SDK 10.0.302), C# 14
static class Ext
{
    public static string? EchoExt(this object? value,
        [CallerArgumentExpression(nameof(value))] string? e = null) => e;

    extension(object? target)
    {
        public string? EchoBlock([CallerArgumentExpression(nameof(target))] string? e = null) => e;
    }
}

retries.EchoExt();     // "retries"
name.EchoBlock();      // "name"
```

The second form uses a C# 14 [extension block](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-14.0/extensions). The attribute can name the receiver parameter declared on the `extension(...)` line, and the compiler fills it with the receiver expression. That makes a fluent `customer.Email.MustNotBeEmpty()` style possible that still reports `customer.Email` in the exception.

## Three guards worth copying

Here is a guard class that covers the common cases. Each one returns the validated value so it can be used inline in a constructor assignment.

```csharp
// .NET 10 (SDK 10.0.302), C# 14
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;

public static class Guard
{
    public static T NotNull<T>([NotNull] T? value,
        [CallerArgumentExpression(nameof(value))] string? paramName = null) where T : class
        => value ?? throw new ArgumentNullException(paramName);

    public static int Positive(int value,
        [CallerArgumentExpression(nameof(value))] string? paramName = null)
        => value > 0
            ? value
            : throw new ArgumentOutOfRangeException(paramName, value, $"{paramName} must be positive.");

    public static void That([DoesNotReturnIf(false)] bool condition,
        [CallerArgumentExpression(nameof(condition))] string? expression = null)
    {
        if (!condition)
            throw new InvalidOperationException($"Check failed: {expression}");
    }
}
```

Run against `retries = -3`, these produced:

```text
ArgumentNullException: Value cannot be null. (Parameter 'user.Address')
ArgumentOutOfRangeException: retries must be positive. (Parameter 'retries')
Actual value was -3.
InvalidOperationException: Check failed: retries > 0
```

A few design choices in there are deliberate:

- **`[NotNull]` on `value`** tells the nullable analysis that after `Guard.NotNull(x)` returns, `x` is not null, so you do not get CS8602 on the next line. The same goes for `[DoesNotReturnIf(false)]` on `That`. If your guard does not return the value, these attributes are the only thing keeping the flow analysis happy. The related trap with `[MemberNotNull]` is covered in [why `[MemberNotNull]` has no effect on a static factory method](/2026/10/fix-membernotnull-has-no-effect-on-a-static-factory-method/).
- **`where T : class`** keeps value types out of `NotNull`, which would otherwise box and could never be null anyway.
- **`That` captures a whole condition**, not a parameter name. This is the case `nameof` can never handle: `Guard.That(order.Lines.Count <= MaxLines)` reports the whole comparison.

Before writing your own, check whether the BCL already has it. Reflection over the .NET 10.0.10 runtime shows these throw helpers carry the attribute:

| Method | Since |
|---|---|
| `ArgumentNullException.ThrowIfNull(object?)` | .NET 6 |
| `ArgumentException.ThrowIfNullOrEmpty(string?)` | .NET 7 |
| `ArgumentException.ThrowIfNullOrWhiteSpace(string?)` | .NET 8 |
| `ArgumentOutOfRangeException.ThrowIfNegative`, `ThrowIfZero`, `ThrowIfGreaterThan` and friends | .NET 8 |

`ObjectDisposedException.ThrowIf` does not use it; it takes the instance or type instead. The [2023 post on throwing if null](/2023/03/c-best-way-to-throw-exception-if-null/) covers the null case on its own.

## Debug.Assert, Trace.Assert, and the overload trap

`Debug.Assert(bool condition, string? message)` and `Trace.Assert(bool, string?)` put the attribute on `message`, pointing at `condition`. A custom `TraceListener` that records `Fail(message)` showed:

```csharp
// .NET 10 (SDK 10.0.302), C# 14, Debug configuration
Trace.Assert(retries > 0);        // Fail("retries > 0")
Debug.Assert(retries > 0);        // Fail("retries > 0")
Trace.Assert(retries > 0, null);  // Fail("")
```

The interesting part is that the one-argument `Debug.Assert(bool condition)` overload still exists. Normally C# prefers an overload whose parameters are all supplied over one that needs a default filled in, so `Debug.Assert(x)` should bind to the old overload and never see the expression. Reflection shows why it does not:

```text
Debug.Assert(bool) attrs: [ConditionalAttribute("DEBUG")], [OverloadResolutionPriorityAttribute(-1)]
```

The runtime demoted the old overload with `[OverloadResolutionPriority(-1)]` (C# 13 / .NET 9) so the compiler picks the new one, while already-compiled code that references `Assert(bool)` keeps working. [Reports against net9.0](https://community.sonarsource.com/t/false-positive-on-s3236-when-calling-debug-assert-with-message/138761) show the attributed signature arriving in .NET 9.

Your own library hits the same problem the moment you retrofit the attribute onto a published API:

```csharp
// .NET 10 (SDK 10.0.302), C# 14
static class V1Kept
{
    public static string? Check(bool condition) => "<v1 overload>";
    public static string? Check(bool condition,
        [CallerArgumentExpression(nameof(condition))] string? expression = null) => expression;
}

static class Prioritized
{
    [OverloadResolutionPriority(-1)]
    public static string? Check(bool condition) => "<v1 overload>";
    public static string? Check(bool condition,
        [CallerArgumentExpression(nameof(condition))] string? expression = null) => expression;
}

V1Kept.Check(retries > 0);       // "<v1 overload>": the new parameter is never used
Prioritized.Check(retries > 0);  // "retries > 0"
```

You have three options. Replace the old method outright, which is a binary break: callers compiled against `Check(bool)` throw `MissingMethodException` until they recompile (the [source vs binary breaking change post](/2026/10/what-is-the-difference-between-a-source-breaking-and-a-binary-breaking-change-in-a-dotnet-library/) walks through why adding an optional parameter counts). Keep both and accept that nobody gets the expression, which is pointless. Or keep both and demote the old one with `[OverloadResolutionPriority(-1)]`, which is what the BCL did. The third option needs callers on a C# 13 or newer compiler; older compilers ignore the priority and still bind to the old overload.

## Using it from netstandard2.0 or .NET Framework

The attribute type is missing from `netstandard2.0` and .NET Framework. Building the guard above for `netstandard2.0` fails with:

```text
error CS0246: The type or namespace name 'CallerArgumentExpressionAttribute' could not be found
```

The compiler matches the attribute by its full name, not by assembly, so an `internal` copy in your project is enough. This built cleanly for `netstandard2.0` with `<LangVersion>14</LangVersion>`:

```csharp
// netstandard2.0, C# 14 (SDK 10.0.302)
#if !NETCOREAPP3_0_OR_GREATER
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Parameter, AllowMultiple = false, Inherited = false)]
    internal sealed class CallerArgumentExpressionAttribute : Attribute
    {
        public CallerArgumentExpressionAttribute(string parameterName) => ParameterName = parameterName;
        public string ParameterName { get; }
    }
}
#endif
```

Packages like PolySharp generate the same thing for you. Keep it `internal`: a public copy in a shared library collides with the real type in consumers that also see the BCL one.

The other dependency is the *caller's* compiler. The attribute has no runtime component, so what matters is whether the compiler building the calling project knows about it. With SDK 10.0.302, a project forced to `<LangVersion>9</LangVersion>` still filled the parameter (`"retries > 0"`) with no diagnostic, so the language version setting does not gate it on a current compiler. A genuinely old compiler is a different story: Visual Studio 2019's Roslyn predates the feature, and the [common "always null" Stack Overflow report](https://stackoverflow.com/questions/70263804/callerargumentexpression-is-always-null-c-10) comes from exactly that setup. If your `netstandard2.0` package has consumers on old toolchains, they get `null`, which is one more reason for the `?? nameof(value)` fallback.

## Cost and when not to bother

Every call site embeds its own string literal, so a guard called from 2,000 places with 2,000 different arguments adds up to 2,000 strings to the caller assembly's user-string heap (identical text is stored once per assembly). For guards this is negligible and far cheaper than building a message at run time. It becomes noticeable only if you capture long lambdas or multi-line expressions in a hot generated file.

It is also the wrong tool when the value you want is a *name* that is not in the source. For `[LoggerMessage]`-style structured logging you want stable template names, not expression text, and for expected failures, a `TryX` method is usually better than any throw helper; see [the Try pattern vs throwing exceptions](/2026/10/try-pattern-vs-throwing-exceptions-for-expected-failures-in-csharp/). Test frameworks have adopted it where it helps most: MSTest 4 and NUnit 4 echo the failing expression in assertion messages, which the [xUnit v3 vs NUnit vs MSTest comparison](/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/) shows side by side.

### Read next

- [C# throw if null: ArgumentNullException.ThrowIfNull](/2023/03/c-best-way-to-throw-exception-if-null/)
- [Fix: `[MemberNotNull]` has no effect on a static factory method](/2026/10/fix-membernotnull-has-no-effect-on-a-static-factory-method/)
- [Source-breaking vs binary-breaking changes in a .NET library](/2026/10/what-is-the-difference-between-a-source-breaking-and-a-binary-breaking-change-in-a-dotnet-library/)
- [What is `[ModuleInitializer]` in C# and when should a library use it?](/2026/11/what-is-moduleinitializer-in-csharp-and-when-should-a-library-use-it/)

### Sources

- [C# 10 feature specification: CallerArgumentExpression](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-10.0/caller-argument-expression)
- [Caller information attributes (MS Learn)](https://learn.microsoft.com/dotnet/csharp/language-reference/attributes/caller-information)
- [`CallerArgumentExpressionAttribute` API reference](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.callerargumentexpressionattribute)
- [`OverloadResolutionPriorityAttribute` API reference](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.overloadresolutionpriorityattribute)
- [JetBrains: Caller argument expressions in C# 10](https://blog.jetbrains.com/dotnet/2021/11/04/caller-argument-expressions-in-csharp-10/)
