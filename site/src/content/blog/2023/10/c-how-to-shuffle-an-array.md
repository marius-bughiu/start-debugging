---
title: "C# – How to shuffle an array?"
description: "The easiest way to shuffle an array in C# is using Random.Shuffle. This method has been introduced in .NET 8 and works both with arrays and spans. The suffling is done in-place (the existing array/span is modified, as opposed to creating a new one and leaving the source unchanged). In terms of signatures, we’ve got:…"
pubDate: 2023-10-26
updatedDate: 2023-11-01
tags:
  - "net"
  - "net-8"
---
The easiest way to shuffle an array in C# is using `Random.Shuffle`. This method has been introduced in .NET 8 and works both with arrays and spans.

The suffling is done in-place (the existing array/span is modified, as opposed to creating a new one and leaving the source unchanged).

In terms of signatures, we’ve got:

```cs
public void Shuffle<T> (Span<T> values);
public void Shuffle<T> (T[] values);
```

And for a simple usage example:

```cs
int[] foo = [1, 2, 3];
Random.Shared.Shuffle(trainingData); // [2, 1, 3]
```
