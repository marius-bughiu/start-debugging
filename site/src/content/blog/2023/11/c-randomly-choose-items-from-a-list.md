---
title: "C# Randomly choose items from a list"
description: "In C#, you can randomly select items from a list using Random.GetItems, a method introduced in .NET 8. Learn how it works with practical examples."
pubDate: 2023-11-12
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
---
In C#, you can randomly select items from a list using `Random.GetItems`, a method introduced in .NET 8.

```cs
public T[] GetItems<T>(T[] choices, int length)
```

The method takes in two parameters:

-   `choices` – the list of items to choose from / the list of possibilities.
-   `length` – how many items to pick.

There are two important things to note about this method:

-   the resulting list can contain duplicates, it is not a list of unique picks.
-   this opens up the `length` parameter to be larger than the length of the list of choices.

With all this being said, let’s take a few examples. Let’s assume the following array of choices:

```cs
string[] fruits =
[
    "apple",
    "banana",
    "orange",
    "kiwi"
];
```

For selecting 2 random fruits from that list, we simply call:

```cs
var chosen = Random.Shared.GetItems(fruits, 2);
```

Now, as I’ve said before, the two chosen fruits are not necessarily unique. You could end up for example with `[ "kiwi", "kiwi" ]` as your `chosen` array. You can test this out easily with a do-while:

```cs
string[] chosen = null;

do
    chosen = Random.Shared.GetItems(fruits, 2);
while (chosen[0] != chosen[1]);

// At this point, you will have the same fruit twice
```

And this opens the method up for selecting more items than you actually have in the list. In our example we have only 4 fruits to choose from, but we can ask `GetItems` to choose 10 fruits for us, and it will happily do it.

```cs
var chosen = Random.Shared.GetItems(fruits, 10);
// [ "kiwi", "banana", "kiwi", "orange", "apple", "orange", "apple", "orange", "kiwi", "apple" ]
```
