---
title: "C# – Best way to Throw Exception If Null"
description: "Use ArgumentNullException.ThrowIfNull in .NET 6+ for concise null checks, or use throw expressions in C# 7+ for older frameworks."
pubDate: 2023-03-11
updatedDate: 2023-11-05
tags:
  - "csharp"
---
.NET 6 introduced a few new helper methods to deal with throwing exceptions, and one of them is **ThrowIfNull**. The usage is simple:

```cs
ArgumentNullException.ThrowIfNull(myParam);
```

The method will throw an **ArgumentNullException** when **myParam** is **null**. It will do nothing otherwise.

ThrowIfNull can take in two parameters:

-   **object? argument** – the reference type object that needs to be checked if null
-   Optional: **string? paramName** – the name of the parameter being checked.

**Note:** paramName uses **CallerArgumentExpressionAttribute** to retrieve the name of your parameter automatically, so in most scenarios you will not need to provide it as the framework will be able to correctly determine the argument name by itself.

## Throw expressions

If you are not yet on .NET 6 or newer, but you can use C# 7+, then you can use throw expressions to make your code more readable:

```cs
var myVar = myParam ?? throw new ArgumentNullException(nameof(myParam), "Parameter is required.");
```

Alternatively, you could choose to define your own implementation of ThrowIfNull, like so:

```cs
/// <summary>Throws an <see cref="ArgumentNullException"/> if <paramref name="argument"/> is null.</summary>
/// <param name="argument">The reference type argument to validate as non-null.</param>
/// <param name="paramName">The name of the parameter with which <paramref name="argument"/> corresponds.</param>
public static void ThrowIfNull([NotNull] object? argument, [CallerArgumentExpression("argument")] string? paramName = null)
{
    if (argument is null)
    {
        throw new ArgumentNullException(paramName);
    }
}
```
