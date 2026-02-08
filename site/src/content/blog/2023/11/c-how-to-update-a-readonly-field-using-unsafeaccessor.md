---
title: "C# How to update a readonly field using UnsafeAccessor"
description: "Unsafe accessors can be used to access private members of a class, just like you would with reflection. And the same can be said about changing the value of a readonly field. Let’s assume the following class: Let’s say that for some reason you want to change the value of that read-only field. You could…"
pubDate: 2023-11-02
tags:
  - "c-sharp"
  - "net"
  - "net-8"
---
Unsafe accessors can be used to access private members of a class, just like you would with reflection. And the same can be said about changing the value of a readonly field.

Let’s assume the following class:

```cs
class Foo
{
    public readonly int readonlyField = 3;
}
```

Let’s say that for some reason you want to change the value of that read-only field. You could already do that with reflection, of course:

```cs
var instance = new Foo();

typeof(Foo)
    .GetField("readonlyField", BindingFlags.Instance | BindingFlags.Public)
    .SetValue(instance, 42);

Console.WriteLine(instance.readonlyField); // 42
```

But the same can be achieved using the `UnsafeAccessorAttribute` without the performance penalty associated with reflection. Modifying read only fields is no different than modifying any other field when it comes to unsafe accessors.

```cs
var instance = new Foo();

[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "readonlyField")]
extern static ref int ReadonlyField(Foo @this);

ReadonlyField(instance) = 42;

Console.WriteLine(instance.readonlyField); // 42
```

This code is also [available on GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/24d4273803c67824b2885b6f18cb8d535ec75657/unsafe-accessor/UnsafeAccessor/Program.cs#L74) in case you want to take it for a spin.
