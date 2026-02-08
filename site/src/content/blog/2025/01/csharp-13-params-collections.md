---
title: "C# 13: Use params collections with any recognized collection type"
description: "C# 13 extends the params modifier beyond arrays to support Span, ReadOnlySpan, IEnumerable, and other collection types, reducing boilerplate and improving flexibility."
pubDate: 2025-01-02
updatedDate: 2025-01-07
tags:
  - "13"
  - "c-sharp"
  - "net"
  - "net-9"
---
The `params` modifier in C# has traditionally been associated with array types, allowing methods to accept a variable number of arguments. However, [starting with C# 13](/2025/01/how-to-switch-to-c-13/), you can now use params collections with a variety of collection types, broadening its applicability and making your code even more versatile.

## Supported collection types

The `params` modifier now works with several recognized collection types, including:

-   `System.Span<T>`
-   `System.ReadOnlySpan<T>`
-   types implementing `System.Collections.Generic.IEnumerable<T>` that also have an `Add` method.

Additionally, you can use `params` with the following system interfaces:

-   `System.Collections.Generic.IEnumerable<T>`
-   `System.Collections.Generic.IReadOnlyCollection<T>`
-   `System.Collections.Generic.IReadOnlyList<T>`
-   `System.Collections.Generic.ICollection<T>`
-   `System.Collections.Generic.IList<T>`

## A practical example: using Spans with `params`

One of the exciting possibilities with this enhancement is the ability to use spans as `params` parameters. Here’s an example:

```cs
public void Concat<T>(params ReadOnlySpan<T> items)
{
    for (int i = 0; i < items.Length; i++)
    {
        Console.Write(items[i]);
        Console.Write(" ");
    }

    Console.WriteLine();
}
```

In this method, `params` enables you to pass a variable number of spans into the `Concat` method. The method processes each span in sequence, demonstrating the enhanced flexibility of the `params` modifier.

## Comparison with C# 12.0

In earlier versions of C#, the `params` keyword only supported arrays, requiring developers to manually convert other collection types into arrays before passing them to a method that used `params`. This process added unnecessary boilerplate code, such as creating temporary arrays or calling conversion methods explicitly.

**Example without the new feature (Pre-C# 13)**

```cs
void PrintValues(params int[] values)
{
    foreach (var value in values)
    {
        Console.WriteLine(value);
    }
}

var list = new List<int> { 1, 2, 3 };

// Manual conversion to array
PrintValues(list.ToArray());
```

**Example with the new feature (C# 13)**

```cs
void PrintValues(params IEnumerable<int> values)
{
    foreach (var value in values)
    {
        Console.WriteLine(value);
    }
}

var list = new List<int> { 1, 2, 3 };

// No conversion needed
PrintValues(list);
```

The new feature reduces boilerplate by:

1.  **Eliminating manual conversion** – no need to explicitly convert collections like `List<T>` or `IEnumerable<T>` to arrays.
2.  **Making code** **simpler** – method calls become cleaner and more readable, directly accepting compatible collection types.
3.  **Improving maintainability** – reduces repetitive and error-prone code, focusing only on the logic instead of handling conversions.

## Compiler behavior and overload resolution

The introduction of params collections means adjustments in compiler behavior, particularly concerning overload resolution. When a method includes a `params` parameter of a non-array collection type, the compiler evaluates the applicability of both the normal and expanded forms of the method.

## Error handling and best practices

Whenever using `params`, it’s important to adhere to best practices in order to prevent common errors:

-   **parameter positioning** – ensure that the `params` parameter is the last in the formal parameter list
-   **modifier restrictions** – avoid combining `params` with modifiers such as `in`, `ref`, or `out`
-   **default values** – do not assign default values to `params` parameters, as this is not permitted

For more details you can check out the [feature specification](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-13.0/params-collections).
