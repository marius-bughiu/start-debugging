---
title: "C# 14: nameof support for unbound generic types"
description: "C# 14 enhances the nameof expression to support unbound generic types like List<> and Dictionary<,>, eliminating the need for placeholder type arguments."
pubDate: 2025-04-07
tags:
  - "csharp-14"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
---
C# 14 introduces several small but helpful improvements to the language. One of these new features is an enhancement to the `nameof` expression – it now supports _unbound generic types_. In simple terms, you no longer need to plug in a placeholder type argument just to get the name of a generic type. This update removes a little annoyance that C# developers have faced for years and makes code using `nameof` cleaner and easier to maintain.

## What are unbound generic types?

In C#, a _generic type_ is a class or struct that has type parameters (for example, `List<T>` or `Dictionary<TKey, TValue>`). An **unbound generic type** is the generic type definition itself, with no specific type arguments supplied. You can recognize an unbound generic by the empty angle brackets (like `List<>`) or commas inside angle brackets indicating the number of type parameters (like `Dictionary<,>` for two type parameters). It represents the generic type _in general_, without saying what `T` or `TKey`/`TValue` are. We cannot instantiate an unbound generic type directly because it isn’t fully specified, but we can use it in certain contexts (such as reflection via `typeof`). For example, `typeof(List<>)` returns a `System.Type` object for the open generic `List` type.

Before C# 14, the language did **not** allow unbound generic types to be used in most expressions. They mainly appeared in reflection or attribute scenarios. If you wanted to refer to a generic type by name in code, you typically had to supply concrete type arguments, making it a _closed_ generic type. For instance, `List<int>` or `Dictionary<string, int>` are _closed generic types_ because all their type parameters are specified. Until now, C# developers often picked an arbitrary type (like `object` or `int`) just to satisfy the syntax when all they really wanted was the generic type’s name itself.

## How `nameof` worked before C# 14

The `nameof` expression is a compile-time feature that produces the name of a variable, type, or member as a string. It’s commonly used to avoid hard-coding identifiers in strings (for example, for argument validation or property change notifications). Prior to C# 14, `nameof` had a limitation when working with generics: you **could not** use an unbound generic type as the argument. The argument to `nameof` had to be a valid expression or type identifier in code, which meant generic types needed concrete type arguments. In practice, this meant that to get the name of a generic type, you had to provide a dummy type parameter.

For example, suppose you wanted the string `"List"` (the name of the generic class `List<T>`). In C# 13 or earlier, you would have to write something like:

```cs
string typeName = nameof(List<int>);  // evaluates to "List"
```

Here we used `List<int>` with an arbitrary type argument (`int`) even though the choice of type is irrelevant to the result. If you tried to use an unbound form like `List<>` without a type argument, the code would not compile. The compiler would complain about an “unbound generic name” or similar error, because it wasn’t allowed in a context expecting an expression. In other words, you _had_ to specify a type parameter to make it a valid expression for `nameof`, even though `nameof` ultimately ignores the type argument and only cares about the name `"List"`.

This requirement was simply a quirk of the language rules. It could lead to awkward or brittle code. For instance, developers often used a placeholder like `object` or `int` for the type parameter just to use `nameof`. If later the generic type got a new constraint (say `T` had to be a reference type or inherit a certain class), the `nameof` usage might break because the dummy type no longer satisfied the constraints. In some advanced cases, finding a suitable type to plug in was non-trivial (for example, if `T` was constrained to an internal class or an interface that no existing type implemented, you’d have to create a dummy class just to satisfy the generic parameter in order to use `nameof`). All of this was extra hassle for something that doesn’t actually affect the outcome of `nameof`.

## `nameof` with unbound generics in C# 14

C# 14 fixes this issue by allowing unbound generic types to be used directly in `nameof` expressions. Now, the argument to `nameof` can be a generic type definition without specifying its type parameters. The result is exactly what you’d expect: `nameof` returns the name of the generic type. This means you can finally write `nameof(List<>)` and get the string `"List"` without needing any dummy type argument.

To illustrate the change, let’s compare how we would get the name of a generic type before and after C# 14:

**Before C# 14:**

```cs
// Using a closed generic type (with a type argument) to get the name:
Console.WriteLine(nameof(List<int>));    // Output: "List"

// The following was not allowed in C# 13 and earlier – it would cause a compile error:
// Console.WriteLine(nameof(List<>));    // Error: Unbound generic type not allowed
```

**In C# 14 and later:**

```cs
// We can use an unbound generic type directly:
Console.WriteLine(nameof(List<>));       // Output: "List"
Console.WriteLine(nameof(Dictionary<,>)); // Output: "Dictionary"
```

As shown above, `nameof(List<>)` now evaluates to `"List"`, and similarly `nameof(Dictionary<,>)` gives `"Dictionary"`. We no longer need to provide a fake type argument just to use `nameof` with a generic type.

This improvement isn’t limited to just getting the name of the type itself. You can also use it to get the names of members on an unbound generic type, just like you would on a normal type. For example, `nameof(List<>.Count)` is now a valid expression in C# 14, and it will produce the string `"Count"`. In earlier versions, you would have written `nameof(List<int>.Count)` or some other concrete type in place of `<int>` to achieve the same result. C# 14 lets you omit the type arguments in these contexts as well. In general, any place where you would use `nameof(SomeGenericType<...>.MemberName)`, you can now leave the generic type unbound if you don’t have a specific type to use or don’t want to commit to one.

It’s worth noting that this feature is purely about convenience and code clarity. The output of the `nameof` expression hasn’t changed – it’s still just the identifier name. What changed is that the language rules now permit a broader set of inputs for `nameof`. This brings `nameof` in line with `typeof`, which already allowed open generic types. In essence, the C# language is acknowledging that specifying a type parameter in these cases was an unnecessary requirement all along.

## Why is this useful?

Allowing unbound generic types in `nameof` might seem like a small tweak, but it has some practical benefits:

-   **Cleaner and clearer code:** You no longer have to insert irrelevant type arguments in your code just to satisfy the compiler. `nameof(List<>)` clearly expresses “I want the name of the generic type `List`,” whereas `nameof(List<int>)` might make a reader momentarily wonder “why `int`?”. Removing the noise makes the intent of the code more obvious.
-   **No more dummy types or workarounds:** In pre-C# 14 code, developers often used placeholder types like `object` or created dummy implementations to use in `nameof` for generics. This is no longer necessary. Your code can directly reference the generic type’s name without any workaround, reducing clutter and odd dependencies.
-   **Improved maintainability:** Using unbound generics in `nameof` makes your code less fragile in the face of changes. If the generic type gains new type parameter constraints or other modifications, you won’t have to revisit every `nameof` usage to ensure your chosen type argument still fits. For example, if you had `nameof(MyGeneric<object>)` and later `MyGeneric<T>` adds a `where T : struct` constraint, that code would no longer compile. With `nameof(MyGeneric<>)`, it will continue to work regardless of such changes, since it doesn’t rely on a specific type argument at all.
-   **Consistency with other language features:** This change makes `nameof` more consistent with how other metaprogramming features like `typeof` work. Since you could already do `typeof(GenericType<>)` to reflect an open generic type, it’s intuitive that you should also be able to do `nameof(GenericType<>)` to get its name. The language now feels more consistent and logical.
-   **Minor convenience in reflection or code generation scenarios:** If you are writing libraries or frameworks that deal with types and names (for example, generating documentation, error messages, or doing model binding where you log type names), you can now retrieve generic type names more directly. It’s a minor convenience, but it can simplify code that builds strings of type names or uses `nameof` for logging and exceptions involving generic classes.

## Conclusion

Support for unbound generic types in the `nameof` expression is a welcome improvement in C# 14 that makes the language a bit more developer-friendly. By allowing constructs like `nameof(List<>)`, C# eliminates an old annoyance and lets developers express their intent without unnecessary boilerplate. This change benefits all C# users – beginners can avoid confusion when using `nameof` with generics, and seasoned developers get more streamlined code that is resilient to future changes. It’s a great example of the C# team addressing a “papercut” in the language and improving consistency. As you adopt C# 14, keep this feature in mind whenever you need the name of a generic type, and enjoy writing cleaner, more concise code.

## References

1.  [What’s new in C# 14 | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14#:~:text=Beginning%20with%20C,name)
2.  [Generics and attributes – C# | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/advanced-topics/reflection-and-attributes/generics-and-attributes#:~:text=constructed%20generic%20types%2C%20not%20on,Dictionary)
3.  [The nameof expression – evaluate the text name of a symbol – C# reference | Microsoft Learn](https://msdn.microsoft.com/en-us/library/dn986596.aspx#:~:text=Console.WriteLine%28nameof%28List,%2F%2F%20output%3A%20List)
4.  [Unbound generic types in `nameof` – C# feature specifications (preview) | Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/unbound-generic-types-in-nameof#:~:text=Motivation)
5.  [What’s new in C# 14 | StartDebugging.NET](/2024/12/csharp-14/)
