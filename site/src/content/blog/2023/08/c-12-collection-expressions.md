---
title: "C# 12 – Collection expressions"
description: "C# 12 introduces a new simplified syntax for creating arrays. It looks like this: It’s important to note that the array type needs to be specified explicitly, so you cannot use var for declaring the variable. Similarly, if you wanted to create a Span<int>, you can do: Multi-dimensional arrays The advantages of this terse syntax…"
pubDate: 2023-08-30
updatedDate: 2023-11-05
tags:
  - "csharp"
---
C# 12 introduces a new simplified syntax for creating arrays. It looks like this:

```cs
int[] foo = [1, 2, 3];
```

It’s important to note that the array type needs to be specified explicitly, so you cannot use `var` for declaring the variable.

Similarly, if you wanted to create a `Span<int>`, you can do:

```cs
Span<int> bar = [1, 2, 3];
```

## Multi-dimensional arrays

The advantages of this terse syntax become even more obvious when defining multi-dimensional arrays. Let’s take a two-dimensional array as an example. This is how you would define it without the new syntax:

```cs
int[][] _2d = new int[][] { new int[] { 1, 2, 3 }, new int[] { 4, 5, 6 }, new int[] { 7, 8, 9 } };
```

And with the new syntax:

```cs
int[][] _2d = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
```

A lot more simple and intuitive, isn't it?

## Merged arrays using the spread operator

With the new syntax comes a new spread operator as well – `..` – which replaces the argument it's applied to with its elements, effectively allowing you to merge collections together. Let’s look at a few examples.

Starting with the most simple one – merging multiple arrays into one:

```cs
int[] a1 = [1, 2, 3];
int[] a2 = [4, 5, 6];
int[] a3 = [7, 8, 9];

int[] merged = [..a1, ..a2, ..a3];
```

The spread operator can be applied to any `IEnumerable`, and can be used to combine different `IEnumerable`s into a single collection.

```cs
int[] a1 = [1, 2, 3];
List<int> a2 = [4, 5, 6];
Span<int> a3 = [7, 8, 9];

Collection<int> merged = [..a1, ..a2, ..a3];
```

You can also use the spread operator in combination with individual elements, in order to create a new collection with additional items at either end of an existing collection.

```cs
int[] merged = [1, 2, 3, ..a2, 10, 11, 12];
```

### Error CS9176

> Error CS9176 There is no target type for the collection expression.

In the case of collection expressions you cannot use `var` and you must explicitly specify the variable type. Let’s look at an example:

```cs
// Wrong - triggers CS9176
var foo = [1, 2, 3];

// Correct
int[] foo = [1, 2, 3];
```

### Error CS0029

> Error CS0029 Cannot implicitly convert type ‘int\[\]’ to ‘System.Index’

This can happen when trying to use the spread operator in the old collection initializer syntax, which is not supported. Instead, you should use the simplified syntax when using the spread operator.

```cs
// Wrong - triggers CS0029
var a = new List<int> { 1, 2, 3, ..a1, 4, 5 };

// Correct
List<int> a = [1, 2, 3, .. a1, 4, 5];
```

### Error CS8652

> Error CS8652 The feature ‘collection expressions’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

> Error CS8652 The feature ‘collection literals’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

These errors mean that your project does not use C# 12 yet, so you cannot use the new language features. If you wish to switch to C# 12 and don’t know how, check out [our guide to switching your project to C# 12](/2023/06/how-to-switch-to-c-12/).
