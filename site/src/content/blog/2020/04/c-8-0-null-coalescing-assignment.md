---
title: "C# 8.0 Null-coalescing assignment ??="
description: "The operator enables you to assign the right-hand operand value to the left-hand operand only if the left-hand operand value evaluates to null. Let’s take a very basic example: In the example above we declare a nullable int variable i and then make two null-coalescing assignments on it. During the first assignment i will evaluate…"
pubDate: 2020-04-05
updatedDate: 2023-11-05
tags:
  - "c-sharp"
---
The operator enables you to assign the right-hand operand value to the left-hand operand only if the left-hand operand value evaluates to null.

Let’s take a very basic example:

```cs
int? i = null;

i ??= 1;
i ??= 2;
```

In the example above we declare a nullable `int` variable `i` and then make two null-coalescing assignments on it. During the first assignment `i` will evaluate to `null`, which means that `i` will be assigned the value of `1`. On the next assignment `i` will be `1` – which is not `null` – so the assignment will be skipped.

As expected, the right-hand operand value will only be evaluated if the lef-hand operand is `null`.

```cs
int? i = null;

i ??= Method1();
i ??= Method2(); // Method2 is never called because i != null
```

## Use cases

The operator helps simplify the code and make it more readable in situations where you would normally go through different `if` branches until a certain variable’s value is set.

One such example could be caching. In the example below, the call to `GetUserFromServer` would only be made when the `user` is still null after attempting to retrieve it from cache.

```cs
var user = GetUserFromCache(userId);
user ??= GetUserFromServer(userId);
```
