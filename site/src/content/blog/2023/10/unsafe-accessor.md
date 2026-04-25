---
title: "C# UnsafeAccessor: private members without reflection (.NET 8)"
description: "Use the `[UnsafeAccessor]` attribute in .NET 8 to read private fields and call private methods at zero overhead — no reflection, fully AOT-compatible."
pubDate: 2023-10-31
updatedDate: 2023-11-05
tags:
  - "dotnet"
  - "dotnet-8"
---
Reflection allows you to obtain type information at runtime and to access private members of a class using that information. This can be particularly useful when dealing with classes outside of your control – provided by a third-party package. While powerful, reflection is also very slow, which is one of the main deterrents in using it. No more.

.NET 8 introduces a new way to access private members with zero overhead through the use of the `UnsafeAccessor` attribute. The attribute can be applied to an `extern static` method. The implementation for the method will be provided by the runtime based on attribute information and method signature. If no match is found for the information provided, the method call will throw either a `MissingFieldException` or a `MissingMethodException`.

Let’s look at a few examples of how to use `UnsafeAccessor`. Let’s consider the following class with private members:

```cs
class Foo
{
    private Foo() { }
    private Foo(string value) 
    {
        InstanceProperty = value;
    }

    private string InstanceProperty { get; set; } = "instance-property";
    private static string StaticProperty { get; set; } = "static-property";

    private int instanceField = 1;
    private static int staticField = 2;

    private string InstanceMethod(int value) => $"instance-method:{value}";
    private static string StaticMethod(int value) => $"static-method:{value}";
}
```

## Creating object instances using private constructors

As described above, we start by declaring the `static extern` methods.

-   we annotate the methods with the `UnsafeAccessor` attribute: `[UnsafeAccessor(UnsafeAccessorKind.Constructor)]`
-   and we match the signatures of the constructors. In the case of constructors, the return type must be the type of the class we’re redirecting to (`Foo`). The list of parameters must be a match as well.
-   the name of the extern method doesn’t need to match anything or to follow any convention. One important thing you will notice is that you can not have two `extern static` methods with the same name but different parameters – similar to overloading – so you will need to provide unique names for each overload

You should end up with this:

```cs
[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructor();

[UnsafeAccessor(UnsafeAccessorKind.Constructor)]
extern static Foo PrivateConstructorWithParameters(string value);
```

Creating object instances using the private constructors is trivial at this point.

```cs
var instance1 = PrivateConstructor();
var instance2 = PrivateConstructorWithParameters("bar");
```

## Invoke private instance methods

The first argument of the `extern static` method will be an object instance of the type containing the private method. The rest of the arguments must match the signature of the method we’re targeting. The return type must match as well.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "InstanceMethod")]
extern static string InstanceMethod(Foo @this, int value);

Console.WriteLine(InstanceMethod(instance1, 42)); 
// Output: "instance-method:42"
```

## Get / Set private instance properties

You’ll notice that there’s no `UnsafeAccessorKind.Property`. That’s because, similar to instance methods, instance properties can be accessed using their getter and setter methods:

-   `get_{PropertyName}`
-   `set_{PropertyName}`

```cs
[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "get_InstanceProperty")]
extern static string InstanceGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.Method, Name = "set_InstanceProperty")]
extern static void InstanceSetter(Foo @this, string value);

Console.WriteLine(InstanceGetter(instance1));
// Output: "instance-property"

InstanceSetter(instance1, "bar");

Console.WriteLine(InstanceGetter(instance1));
// Output: "bar"
```

## Static methods and properties

They behave identically to the instance members, the only difference being that you have to specify `UnsafeAccessorKind.StaticMethod` in the `UnsafeAccessor` attribute. You even need to provide an object instance of that type when making the call.

What about `static` classes? Static classes are not currently supported by `UnsafeAccessor`s. There’s currently an API proposal that aims to bridge the gap, targeting .NET 9: [\[API Proposal\]: UnsafeAccessorTypeAttribute for static or private type access](https://github.com/dotnet/runtime/issues/90081)

```cs
[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "StaticMethod")]
extern static string StaticMethod(Foo @this, int value);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "get_StaticProperty")]
extern static string StaticGetter(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticMethod, Name = "set_StaticProperty")]
extern static void StaticSetter(Foo @this, string value);
```

## Private fields

Fields are a bit more special when it comes to the syntax of the `extern static` method. We no longer have getter and setter methods available to us, so instead we’ll use the `ref` keyword to get a reference to the field which we can use both to read and write the value.

```cs
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "instanceField")]
extern static ref int InstanceField(Foo @this);

[UnsafeAccessor(UnsafeAccessorKind.StaticField, Name = "staticField")]
extern static ref int StaticField(Foo @this);

// Read the field value
var x = InstanceField(instance1);
var y = StaticField(instance1);

// Update the field value
InstanceField(instance1) = 3;
StaticField(instance1) = 4;
```

Want to give this feature a spin? You can [find all the examples above on GitHub](https://github.com/Start-Debugging/dotnet-samples/blob/main/unsafe-accessor/UnsafeAccessor/Program.cs).
