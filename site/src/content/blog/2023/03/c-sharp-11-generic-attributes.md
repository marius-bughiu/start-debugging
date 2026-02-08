---
title: "C# 11 – Generic attributes"
description: "Learn how to define and use generic attributes in C# 11, including restrictions on type arguments and common error messages."
pubDate: 2023-03-21
updatedDate: 2023-11-05
tags:
  - "c-sharp"
---
All right folks, generic attributes are finally a thing in C#! 🥳

You can define one just as you would define any other generic class:

```cs
public class GenericAttribute<T> : Attribute { }
```

And use it like you would use any other attribute:

```cs
[GenericAttribute<string>]
public class MyClass { }
```

## Generic attribute restrictions

When applying the attribute, all the generic type arguments must be provided. In other words, the generic attribute must be fully constructed.

For example, this will not work:

```cs
public class MyGenericType<T>
{
    [GenericAttribute<T>()]
    public string Foo { get; set; }
}
```

Types which require metadata annotations are not allowed as generic attribute type arguments. Let’s look at some examples of what’s not allowed and the alternatives:

-   `dynamic` is not allowed. Use `object` instead
-   nullable reference types are not allowed. Instead of `string?` you can simply use `string`
-   tuple types using C# tuple syntax are not allowed. You can use `ValueTuple` instead (e.g. `ValueTuple<string, int>` instead of `(string foo, int bar)`)

## Errors

> CS8968 ‘T’: an attribute type argument cannot use type parameters

This error means that you haven’t specified all the type arguments for your attribute. Generic attributes have to be fully constructed, meaning that you cannot use **T**\-parameters when applying them (see the examples above).

> CS8970 Type ‘string’ cannot be used in this context because it cannot be represented in metadata.

Nullable reference types are not allowed as type parameters in generic attributes. Use `string` instead of `string?`.

> CS8970 Type ‘dynamic’ cannot be used in this context because it cannot be represented in metadata.

`dynamic` cannot be used as a type argument for a generic attribute. Use `object` instead.

> CS8970 Type ‘(string foo, int bar)’ cannot be used in this context because it cannot be represented in metadata.

Tuples are not allowed as a type parameter in generic attributes. Use the equivalent `ValueTuple` instead.
