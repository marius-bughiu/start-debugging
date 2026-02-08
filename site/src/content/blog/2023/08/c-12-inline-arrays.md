---
title: "C# 12 – Inline arrays"
description: "Inline arrays enable you to create an array of fixed size in a struct type. Such a struct, with an inline buffer, should provide performance comparable to an unsafe fixed size buffer. Inline arrays are mostly to be used by the runtime team and some library authors to improve performance in certain scenarios. You likely…"
pubDate: 2023-08-31
updatedDate: 2023-11-05
tags:
  - "csharp"
---
Inline arrays enable you to create an array of fixed size in a `struct` type. Such a struct, with an inline buffer, should provide performance comparable to an unsafe fixed size buffer.

Inline arrays are mostly to be used by the runtime team and some library authors to improve performance in certain scenarios. You likely won’t declare your own inline arrays, but you will use them transparently when they are exposed as `Span<T>` or `ReadOnlySpan<T>` objects by the runtime.

## How to declare an inline array

You can declare an inline array by creating a struct and wrapping it with the `InlineArray` attribute, which takes in the array length as a parameter in the constructor.

```cs
[System.Runtime.CompilerServices.InlineArray(10)]
public struct MyInlineArray
{
    private int _element;
}
```

Note: the name of the private member is irrelevant. You can use `private int _abracadabra`; if you wish. What matters is the type, as that decides the type of your array.

## InlineArray usage

You can use an inline array similar to any other array, but with some small differences. Let’s take an example:

```cs
var arr = new MyInlineArray();

for (int i = 0; i < 10; i++)
{
    arr[i] = i;
}

foreach (var item in arr)
{
    Console.WriteLine(item);
}
```

First thing to note is that during the initialization, we do not specify the size. Inline arrays are fixed size and their length is defined through the `InlineArray` attribute that’s applied to the `struct`. Besides that, everything looks as it would if you were using a normal array, but there’s actually more.

### InlineArray doesn’t have a Length property

Some of you might have noticed that in the `for` loop above we iterated until `10` instead of `arr.Length` – and that is because inline arrays don’t have a `Length` property exposed like normal arrays do.

It gets even weirder…

### InlineArray does not implement IEnumerable

And as a result, you cannot call `GetEnumerator` on an inline array. The main drawback of this is that you cannot use LINQ on inline arrays – at least not at the moment, this is something which might change in the future.

Despite not implementing `IEnumerable`, you can still use them inside a `foreach` loop.

```cs
foreach (var item in arr) { }
```

In a similar fashion, you can also use the spread operator in combination with inline arrays.

```cs
int[] m = [1, 2, 3, ..arr];
```
