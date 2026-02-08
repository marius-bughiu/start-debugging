---
title: "C# – ref readonly parameters"
description: "The ref readonly modifier enables a more transparent way of passing read-only references to a method. Passing of readonly references was already possible in C# by using the in modifier ever since version 7.2, but that syntax had some limitations, or rather too little constraints. So how does the new modifier work? Let’s assume the…"
pubDate: 2023-10-28
updatedDate: 2023-11-01
tags:
  - "c-sharp"
  - "net"
---
The `ref readonly` modifier enables a more transparent way of passing read-only references to a method. Passing of readonly references was already possible in C# by using the `in` modifier ever since version 7.2, but that syntax had some limitations, or rather too little constraints.

So how does the new modifier work? Let’s assume the following method signature:

```cs
void FooRef(ref readonly int bar) { }
```

Simply calling the method by passing an integer variable or a value, will result in a compiler **warning**. Note, this is only a warning, it highlights an ambiguity in your implementation, but it will still allow your code to run if you insist.

```cs
var x = 42;

FooRef(x);
FooRef(42);
```

-   `FooRef(x)` will trigger warning CS9192: Argument 1 should be passed with ‘ref’ or ‘in’ keyword
-   `FooRef(42)` will trigger warning CS9193: Argument 1 should be a variable because it is passed to a ‘ref readonly’ parameter

Let’s take them one by one.

## `FooRef(x)` – using `ref` or `in`

This is one of the improvements over using the `in` modifier. `ref readonly` make it explicit to the caller that the value is being passed as a reference. With `in`, this was not transparent to the caller and could lead to confusion.

To fix CS9192, simply change the call to explicitly specify `FooRef(ref x)` or `FooRef(in x)`. The two annotations are mostly equivalent, the main difference being that `in` is more permissive and allows for unassignable values to be passed, while `ref` requires an assignable variables.

For example:

```cs
readonly int y = 43;

FooRef(in y);
FooRef(ref y);
```

`FooRef(in y)` will work without any issues, while `FooRef(y)` will trigger a compiler error saying that the ref value must be an assignable variable.

## `FooRef(42)` – only variables are allowed

This is the other improvement which `ref readonly` brings over `in` – it will start complaining when you try to pass it an `lvalue` – a value without a location. This plays hand in hand with the warning above, because if you try to use `FooRef(ref 42)` you will instantly get a compiler error saying CS1510: A ref or out value must be an assignable variable.
