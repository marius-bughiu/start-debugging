---
title: "C# 14: Simplified parameters with modifiers in lambdas"
description: "C# 14 allows using ref, out, in, scoped, and ref readonly modifiers on implicitly typed lambda parameters, eliminating the need to explicitly declare parameter types."
pubDate: 2025-04-09
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
---
Lambda expressions have been a core feature of C# for many years, allowing developers to write inline functions or callbacks in a concise way. In C#, a lambda can have **explicitly typed parameters** (where you specify each parameter’s type) or **implicitly typed parameters** (where the types are inferred from context). Prior to C# 14, if you wanted to use certain parameter modifiers in a lambda (such as passing by reference or output parameters), you were forced to explicitly declare the parameter types. This often led to more verbose lambda syntax in scenarios where those modifiers were needed.

C# 14 introduces a new feature that addresses this limitation: **simple lambda parameters with modifiers**. This feature allows you to use parameter modifiers like `ref`, `in`, `out`, `scoped`, and `ref readonly` in a lambda expression **without** having to explicitly write out the parameter types. In simpler terms, you can now add these modifiers to “untyped” lambda parameters (parameters whose types are inferred), making lambdas with special parameter passing modes easier to write and read.

## Lambdas in C# 13 and earlier

In C# 13 and all earlier versions, lambda parameters could be either explicitly typed or implicitly typed, but there was a catch when using parameter modifiers. If any lambda parameter needed a modifier (for example, an `out` parameter or a `ref` parameter), the C# compiler required **all** parameters in that lambda to have an explicit type declared. You could not apply `ref`, `in`, `out`, `scoped`, or `ref readonly` to a lambda parameter unless you also wrote out the type of that parameter.

For example, imagine a delegate type that has an `out` parameter:

```cs
// A delegate that tries to parse a string into T, returning true on success.
delegate bool TryParse<T>(string text, out T result);
```

If you wanted to assign a lambda to this delegate in C# 13, you had to explicitly include the types for both parameters because one of them uses the `out` modifier. A valid lambda assignment in C# 13 would look like this:

```cs
// C# 13 and earlier: must explicitly specify types when using 'out'
TryParse<int> parseOld = (string text, out int result) => Int32.TryParse(text, out result);
```

Here we explicitly wrote `string` for the `text` parameter and `int` for the `result` parameter. If we tried to omit the types, the code would not compile. In other words, something like `(text, out result) => ...` was **not** allowed in C# 13, because the presence of `out` on `result` demanded that `result`‘s type (`int` in this case) be explicitly stated. This requirement applied to any of the modifiers `ref`, `in`, `out`, `ref readonly`, and `scoped` in lambda parameter lists.

## Lambda parameter modifiers in C# 14

C# 14 removes that restriction and makes lambdas more flexible. You can now add parameter modifiers to lambda parameters without providing the parameter’s type explicitly. The compiler will infer the types from the context (such as the delegate or expression tree type the lambda is being converted to) while still allowing the parameter modifiers. This improvement means less boilerplate and more readable code when working with delegates or expressions that involve by-reference or scoped parameters.

**Supported modifiers:** You can use the following modifiers on implicitly typed lambda parameters starting in C# 14:

-   `ref` – pass the argument by reference, allowing the lambda to read or modify the caller’s variable.
-   `out` – pass the argument by reference, designated for output; the lambda must assign a value to this parameter before returning.
-   `in` – pass the argument by reference as read-only; the lambda can read the value but cannot modify it.
-   `ref readonly` – pass by reference in a read-only manner (essentially similar to `in`, introduced to support certain scenarios with value types).
-   `scoped` – indicate that a parameter (typically a ref struct like `Span<T>`) is scoped to the caller, preventing it from being captured or stored beyond the call.

These modifiers were previously only usable if you explicitly typed the parameters in the lambda. Now you can write them in a lambda’s parameter list without types.

One important caveat is that the `params` modifier is **not** included in this new capability. If a lambda has a `params` parameter (for a variable number of arguments), you still need to explicitly specify the parameter’s type. In short, `params` still requires an explicitly typed parameter list in lambdas.

Let’s revisit the earlier example using the `TryParse<T>` delegate to see how C# 14 simplifies the syntax. We can now omit the type names and still use the `out` modifier:

```cs
// C# 14: type inference with 'out' parameter
TryParse<int> parseNew = (text, out result) => Int32.TryParse(text, out result);
```

This lambda is assigned to `TryParse<int>`, so the compiler knows that `text` is a `string` and `result` is an `int` from the delegate’s definition. We were able to write `(text, out result) => ...` without specifying the types explicitly, and it compiles and works correctly. The `out` modifier is applied to `result` even though we didn’t write `int`. C# 14 infers that for us, which makes the lambda declaration shorter and avoids repeating information that the compiler already knows.

The same principle applies for other modifiers. Consider a delegate that takes a reference parameter:

```cs
// A delegate that doubles an integer in place.
delegate void Doubler(ref int number);
```

In C# 13, to create a lambda matching this delegate, you would have to include the type with the `ref` modifier:

```cs
// C# 13: explicit type needed for 'ref' parameter
Doubler makeDoubleOld = (ref int number) => number *= 2;
```

With C# 14, you can leave out the type and just write the modifier and parameter name:

```cs
// C# 14: implicit type with 'ref' parameter
Doubler makeDoubleNew = (ref number) => number *= 2;
```

Here, the context (the `Doubler` delegate that takes a `ref int` and returns void) tells the compiler that `number` is an `int`, so we don’t need to spell it out. We simply use `ref number` in the lambda parameter list.

You can also use multiple modifiers together or other forms of these modifiers in the same way. For instance, if you have a delegate with a `ref readonly` parameter or a `scoped` parameter, C# 14 lets you write those without explicit types as well. For example:

```cs
// A delegate with an 'in' (readonly ref) parameter
delegate void PrintReadOnly(in DateTime value);

// C# 14: using 'in' without explicit type
PrintReadOnly printDate = (in value) => Console.WriteLine(value);
```

Similarly, if we have a delegate with a `scoped` parameter:

```cs
// A delegate that takes a scoped Span<int>
delegate int SumElements(scoped Span<int> data);

// C# 14: using 'scoped' without explicit type
SumElements sum = (scoped data) =>
{
    int total = 0;
    foreach (int x in data)
        total += x;
    return total;
};
```

Here, `data` is known to be a `Span<int>` (a stack-only type) from the delegate, and we mark it as `scoped` without writing the type name. This ensures `data` can’t be captured outside the lambda (following the semantics of `scoped`), just as it would if we had written `(scoped Span<int> data)`.

## What benefits does it bring?

Allowing simple lambda parameters with modifiers makes code cleaner and reduces repetition. In previous C# versions, using by-reference or scoped parameters in lambdas meant writing out types that the compiler could already figure out. Now you can let the compiler handle the types while you still express the intent (for example, that a parameter is passed by reference or is an output). This leads to more concise lambdas that are easier to read, especially when delegate signatures are complex or use generic types.

It’s worth noting that this feature doesn’t change the runtime behavior of lambdas or how those modifiers work; it only changes the syntax you use to declare lambda parameters. The lambda will still follow the same rules for `ref`, `out`, `in`, etc., as if you had written them with explicit types. The `scoped` modifier continues to enforce that the value is not captured beyond the lambda’s execution. The key improvement is simply that your source code is less cluttered with type names.

This feature in C# 14 aligns lambda syntax with the convenience of type inference found elsewhere in the language. You can now write lambdas with `ref` and other modifiers in a more natural way, similar to how you’ve been able to omit types in lambdas for years when no modifiers were involved. Just remember that if you need a `params` array in a lambda, you’ll still have to write out the type as before.

## References

-   [What’s new in C# 14 | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14)
-   [Simple lambda parameters with modifiers | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/simple-lambda-parameters-with-modifiers)
-   [What’s new in C# 14 | StartDebugging.NET](/2024/12/csharp-14/)
