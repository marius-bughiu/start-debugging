---
title: "C# 12 – Default values for parameters in lambda expressions"
description: "C# 12 lets you specify default parameter values and params arrays in lambda expressions, just like in methods and local functions."
pubDate: 2023-05-09
updatedDate: 2023-11-05
tags:
  - "csharp"
---
Starting with C# version 12, you can specify default values for your parameters in lambda expressions. The syntax and the restrictions on the default parameter values are the same as for methods and local functions.

Let’s take an example:

```cs
var incrementBy = (int source, int increment = 1) => source + increment;
```

This lambda can now be consumed as follows:

```cs
Console.WriteLine(incrementBy(3)); 
Console.WriteLine(incrementBy(3, 2));
```

## params array in lambda expressions

You can also declare lambda expressions with a **params** array as parameter:

```cs
var sum = (params int[] values) =>
{
    int sum = 0;
    foreach (var value in values) 
    {
        sum += value;
    }

    return sum;
};
```

And consume them like any other function:

```cs
var empty = sum();
Console.WriteLine(empty); // 0

var sequence = new[] { 1, 2, 3, 4, 5 };
var total = sum(sequence);

Console.WriteLine(total); // 15
```

## Error CS8652

> The feature ‘lambda optional parameters’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

Your project needs to be targeting .NET 8 and C# 12 or newer in order to use the lambda optional parameters feature. If you're not sure how to switch to C# 12, check out this article: [How to switch to C# 12](/2023/06/how-to-switch-to-c-12/).
