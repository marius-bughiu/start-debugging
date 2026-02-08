---
title: "Implicit Span conversions in C# 14 – First-class support for Span and ReadOnlySpan"
description: "C# 14 introduces a significant enhancement for high-performance code: first-class language support for spans. In particular, it adds new implicit conversions between Span<T>, ReadOnlySpan<T>, and arrays (T[]). This change makes it much easier to work with these types that represent safe, contiguous memory slices without extra allocations. In this article, we’ll explore what span conversions…"
pubDate: 2025-04-06
tags:
  - "14"
  - "c-sharp"
  - "net"
  - "net-10"
---
**C# 14** introduces a significant enhancement for high-performance code: first-class language support for spans. In particular, it adds new **implicit conversions** between **`Span<T>`**, **`ReadOnlySpan<T>`**, and arrays (`T[]`). This change makes it much easier to work with these types that represent safe, contiguous memory slices without extra allocations. In this article, we’ll explore what span conversions are, how C# 14 changed the rules, and why it matters for your code.

## Background: What are `Span<T>` and `ReadOnlySpan<T>`?

`Span<T>` and `ReadOnlySpan<T>` are stack-only (by-reference) structures that allow you to refer to a contiguous region of memory (for example, a segment of an array, string, or unmanaged memory) in a safe way. They were introduced in C# 7.2 and have become widely used in .NET for **high-performance, zero-allocation** scenarios. Because they are implemented as **`ref struct`** types, spans can only exist on the stack (or within another ref struct), which ensures that they **cannot outlive the memory they point to**, preserving safety. In practice, `Span<T>` is used for mutable memory slices, while `ReadOnlySpan<T>` is used for read-only memory slices.

**Why use spans?** They enable you to work with subarrays, substrings, or buffers **without copying data or allocating new memory**. This yields better performance and lower GC pressure, all while **maintaining type safety and bounds checking** (unlike raw pointers). For example, parsing a large text or binary buffer can be done with spans to avoid creating numerous small strings or byte arrays. Many .NET APIs (file I/O, parsers, serializers, etc.) now offer span-based overloads for efficiency. However, until C# 14, the language itself didn’t fully understand the relationship between spans and arrays, which led to some boilerplate in code.

## Before C# 14: Manual conversions and overloads

In earlier C# versions, spans did have user-defined conversion operators to and from arrays. For instance, you could **implicitly convert** a `T[]` array to a `Span<T>` or to a `ReadOnlySpan<T>` using the overloads defined in the .NET runtime. Likewise, a `Span<T>` could implicitly convert to a `ReadOnlySpan<T>`. _So why was there a problem?_ The issue was that these were library-defined conversions, not built-in language conversions. The C# compiler did **not** treat `Span<T>`, `ReadOnlySpan<T>`, and `T[]` as related types in certain scenarios. This led to a few pain points for developers before C# 14:

-   **Extension methods on Spans/arrays:** If you wrote an extension method that takes a `ReadOnlySpan<T>` as its `this` parameter, you could not call it directly on an array or on a `Span<T>` variable. The compiler wouldn’t consider the array-to-span conversion when binding an extension method receiver. In practice, this meant you often needed to provide **duplicate overloads** for arrays and spans, or call an extension by manually converting the array first. For example, the BCL (Base Class Library) had to offer certain utility methods (like those in `MemoryExtensions`) in multiple forms – one for `ReadOnlySpan<T>`, one for `Span<T>`, and one for `T[]` – to ensure they were usable in all cases.
-   **Generic methods and type inference:** Similar friction existed with generic methods. If you had a generic method `Foo<T>(Span<T> data)`, and you tried to pass an array (say `int[]`) to it, the compiler could not infer `T` because it didn’t see an exact `Span<T>` at the call site – you would have to explicitly specify the type parameter or call `.AsSpan()` on the array. The user-defined implicit conversion from `T[]` to `Span<T>` wasn’t considered during **type inference**, making the code less ergonomic.
-   **Needing explicit conversions:** In many cases, developers had to insert manual conversions like calling `myArray.AsSpan()` or `new ReadOnlySpan<char>(myString)` to get a span out of an array or string. While these are not terribly complicated, they add noise to the code and rely on the developer to know when to convert. IDEs wouldn’t always suggest these, since the type relationships were not known to the compiler’s conversion rules.

## Implicit Span conversions in C# 14

C# 14 addresses these issues by introducing **built-in implicit span conversions** at the language level. The compiler now directly recognizes certain conversions between arrays and span types, often called **“first-class span support.”** In practical terms, this means you can freely pass arrays or even strings to APIs that expect spans, and vice versa, without explicit casts or overloads. The language specification describes the new _implicit span conversion_ as allowing `T[]`, `Span<T>`, `ReadOnlySpan<T>`, and even `string` to be converted between each other in specific ways. The supported implicit conversions include:

-   **Array to Span:** Any one-dimensional array `T[]` can implicitly convert to `Span<T>`. For example, an `int[]` will be accepted wherever a `Span<int>` is expected, with no extra syntax.
-   **Array to ReadOnlySpan:** Any `T[]` can also implicitly convert to `ReadOnlySpan<T>` (or to a covariant equivalent `ReadOnlySpan<U>` if `T` is convertible to `U`). This means you can supply an array to a method that wants a read-only span of the same element type. (Covariance here is similar to array covariance – e.g., a `String[]` can convert to `ReadOnlySpan<object>` because `string` is an `object` – but this is a more advanced scenario.)
-   **Span to ReadOnlySpan:** A `Span<T>` can implicitly be treated as a `ReadOnlySpan<T>` (or `ReadOnlySpan<U>` for compatible reference types). In other words, you can pass a mutable span to something that only reads it. This conversion was possible before, but now it’s a standard conversion that the compiler will consider in more contexts (not just via a user-defined operator).
-   **String to ReadOnlySpan:** A `string` can now implicitly convert to a `ReadOnlySpan<char>`. This is extremely handy for treating string data as read-only spans of characters. (Under the hood, this is safe because the span points to the string’s internal memory, and strings are immutable in C#.) In the past, you had to call `.AsSpan()` on a string or use `MemoryExtensions` to achieve this; now it happens automatically when needed.

These conversions are now part of the **compiler’s built-in conversion rules** (added to the set of _standard implicit conversions_ in the language spec). Crucially, because the compiler understands these relationships, it will consider them during **overload resolution**, **extension method binding**, and **type inference**. In short, C# 14 “knows” that `T[]`, `Span<T>`, and `ReadOnlySpan<T>` are interchangeable to a degree, which results in more intuitive code. As the official docs put it: C# 14 recognizes the relationship between these types and allows more natural programming with them, making span types usable as extension method receivers and improving generic inference.

## Before and after C# 14

Let’s see how code becomes cleaner with implicit span conversions, compared to older C# versions.

### 1\. Extension methods on Span vs Array

Consider an extension method defined for `ReadOnlySpan<T>` (for example, a simple check to see if a span starts with a given element). In C# 13 or earlier, you **could not call** that extension on an array directly, even though an array can be viewed as a span, because the compiler didn’t apply the conversion for the extension receiver. You would have had to call `.AsSpan()` or write a separate overload. In C# 14, it works naturally:

```cs
// Extension method defined on ReadOnlySpan<T>
public static class SpanExtensions {
    public static bool StartsWith<T>(this ReadOnlySpan<T> span, T value) 
        where T : IEquatable<T>
    {
        return span.Length != 0 && EqualityComparer<T>.Default.Equals(span[0], value);
    }
}

int[] arr = { 1, 2, 3 };
Span<int> span = arr;        // Array to Span<T> (always allowed)
// C# 13 and earlier:
// bool result1 = arr.StartsWith(1);    // Compile-time error (not recognized)
// bool result2 = span.StartsWith(1);   // Compile-time error for Span<T> receiver
// (Had to call arr.AsSpan() or define another overload for arrays/spans)
bool result = arr.StartsWith(1);       // C# 14: OK - arr converts to ReadOnlySpan<int> implicitly
Console.WriteLine(result);            // True, since 1 is the first element
```

In the snippet above, `arr.StartsWith(1)` would not compile in older C# (error CS8773) because the extension method expects a `ReadOnlySpan<int>` **receiver**. C# 14 allows the compiler to implicitly convert the `int[]` (`arr`) to a `ReadOnlySpan<int>` to match the extension’s receiver parameter. The same goes for a `Span<int>` variable calling a `ReadOnlySpan<T>` extension – the `Span<T>` can convert to `ReadOnlySpan<T>` on the fly. This means we no longer need to write duplicate extension methods (one for `T[]`, one for `Span<T>`, etc.) or manually convert to call them. The code is both clearer and leaner.

### 2\. Generic method type inference with Spans

Implicit span conversions also help with **generic methods**. Suppose we have a generic method that operates on a span of any type:

```cs
// A generic method that prints the first element of a span
void PrintFirstElement<T>(Span<T> data) {
    if (data.Length > 0)
        Console.WriteLine($"First: {data[0]}");
}

// Before C# 14:
int[] numbers = { 10, 20, 30 };
// PrintFirstElement(numbers);        // ❌ Cannot infer T in C# 13 (array isn't Span<T>)
PrintFirstElement<int>(numbers);      // ✅ Had to explicitly specify <int>, or do PrintFirstElement(numbers.AsSpan())

// In C# 14:
PrintFirstElement(numbers);           // ✅ Implicit conversion allows T to be inferred as int
```

Prior to C# 14, the call `PrintFirstElement(numbers)` wouldn’t compile because the type argument `T` could not be inferred – the parameter is `Span<T>`, and an `int[]` isn’t directly a `Span<T>`. You had to either provide the `<int>` type parameter or convert the array to a `Span<int>` yourself. With C# 14, the compiler sees that `int[]` can convert to `Span<int>` and thus infers `T` = `int` automatically. This makes generic utilities that work on spans much more convenient to use, especially when dealing with array inputs.

### 3\. Passing strings to Span APIs

Another common scenario is dealing with strings as read-only spans of characters. Many parsing and text-processing APIs use `ReadOnlySpan<char>` for efficiency. In earlier C# versions, if you wanted to call such an API with a `string`, you needed to call `.AsSpan()` on the string. C# 14 removes that requirement:

```cs
void ProcessText(ReadOnlySpan<char> text)
{
    // Imagine this method parses or examines the text without allocating.
    Console.WriteLine(text.Length);
}

string title = "Hello, World!";
// Before C# 14:
ProcessText(title.AsSpan());   // Had to convert explicitly.
// C# 14 and later:
ProcessText(title);            // Now implicit: string -> ReadOnlySpan<char>

ReadOnlySpan<char> span = title;         // Implicit conversion on assignment
ReadOnlySpan<char> subSpan = title[7..]; // Slicing still yields a ReadOnlySpan<char>
Console.WriteLine(span[0]);   // 'H'
```

The ability to treat a `string` as a `ReadOnlySpan<char>` implicitly is part of the new span conversion support. This is especially useful in real-world code: for example, methods like `int.TryParse(ReadOnlySpan<char>, ...)` or `Span<char>.IndexOf` can now be called with a string argument directly. It improves code readability by removing clutter (`AsSpan()` calls) and ensures that no unnecessary string allocations or copies are happening. The conversion is done in a zero-cost manner – it simply provides a window into the original string’s memory.

## Real-world use cases benefiting from Span conversions

The implicit span conversions in C# 14 aren’t just a theoretical language tweak – they have practical impact on various programming scenarios:

-   **High-performance parsing and text processing:** Libraries or applications that parse text (e.g. CSV/JSON parsers, compilers) often use `ReadOnlySpan<char>` to avoid making substrings. With implicit conversion, such APIs can accept `string` input seamlessly. For instance, a JSON parser might have a single method `Parse(ReadOnlySpan<char> json)` that callers can now feed with either a `string`, a `char[]`, or a slice of a larger buffer, all without extra overloads or copying.
-   **Memory-efficient APIs:** In .NET, it’s common to find APIs that process data in chunks -for example, reading from a file or network into a buffer. These APIs might use `Span<byte>` for input/output to avoid allocations. Thanks to C# 14, if you have existing data in a `byte[]`, you can pass it to a span-based API directly. Conversely, if an API returns a `Span<T>` or `ReadOnlySpan<T>`, you can easily pass that to another component expecting an array or read-only span. The **ergonomics** encourage developers to use spans, resulting in less memory churn. In short, you can design a single span-centric API that naturally works with arrays and strings, making your codebase cleaner.
-   **Interop and unsafe scenarios:** When interacting with unmanaged code or hardware interfaces, you often deal with raw buffers. Spans are a safe way to represent these buffers in C#. For example, you might call a native method that fills a byte array; with implicit conversions, you could have your P/Invoke signature use `Span<byte>` and still call it with a regular `byte[]`. This provides the safety of spans (avoiding buffer overruns, etc.) while remaining convenient. In low-level scenarios (like parsing binary protocols or image data), being able to treat different memory sources uniformly as spans simplifies the code.
-   **General .NET library usage:** The .NET BCL itself will benefit. The team can now provide a single overload for methods that deal with spans, rather than multiple overloads for arrays, spans, and read-only spans. For example, `.StartsWith()` extension for spans (as we saw) or methods in `System.MemoryExtensions` can be defined once on `ReadOnlySpan<T>` and automatically work for `T[]` and `Span<T>` inputs. This reduces API surface area and potential for inconsistency. As developers, when you see a method signature like `public void Foo(ReadOnlySpan<byte> data)`, you no longer have to wonder if there’s an array version of `Foo` -you can just pass a `byte[]` to it in C# 14 and it will work.

## Benefits of implicit Span conversions

**Improved readability:** The most immediate benefit of this feature is cleaner code. You write what feels natural – pass an array or string to a span-consuming API – and it just works. There’s less cognitive load because you don’t need to remember to call conversion helpers or to include multiple overloads. Extension methods chaining becomes more intuitive. Overall, code that uses spans becomes easier to read and write, looking more like “regular” C# code. This encourages best practices (using spans for performance) by lowering the friction to do so.

**Fewer mistakes:** By letting the compiler handle the conversions, there’s less room for error. For example, a developer might forget to call `.AsSpan()` and accidentally call a less efficient overload; in C# 14, the intended span overload is chosen automatically whenever applicable. It also means consistent behavior – the conversion is guaranteed to be safe (no data copy, no null issues except where appropriate). Tools and IDEs can now properly suggest span-based overloads because the types are compatible. All implicit conversions are designed to be harmless: they don’t change the data or incur runtime cost – they just reinterpret an existing memory buffer in a span wrapper.

**Safety and performance:** Spans were created to improve performance **safely**, and C# 14’s update continues that philosophy. The implicit conversions do not undermine type safety – you still cannot implicitly convert incompatible types (e.g., an `int[]` to a `Span<long>` would only be allowed explicitly if at all, since that requires actual re-interpretation). The span types themselves ensure that you can’t accidentally mutate something that should be read-only (if you convert an array to `ReadOnlySpan<T>`, the API you call can’t modify your array). Additionally, because spans are stack-only, the compiler will enforce that you don’t store them in long-lived variables (like fields) that could outlive the data. By making spans easier to use, C# 14 effectively promotes writing high-performance code without resorting to unsafe pointers, maintaining memory safety guarantees that C# developers expect.

**Extension methods and generics:** As highlighted, spans can now participate fully in extension method resolution and generic type inference. This means fluent APIs and LINQ-like patterns that might use extension methods can work directly with spans/arrays interchangeably. Generic algorithms (for sorting, searching, etc.) can be written with spans and still be invoked with array arguments without fuss. The end result is that you can unify code paths – you don’t need one path for arrays and another for spans; one span-based implementation covers all, which is both safer (less code to get wrong) and faster (one optimized code path).

## Conclusions

The introduction of implicit span conversions in C# 14 is a boon for developers writing performance-sensitive code. It **closes the gap** between arrays, strings, and span types by teaching the compiler to understand their relationships. Compared to earlier versions, you no longer have to sprinkle your code with manual `.AsSpan()` calls or maintain parallel method overloads for spans and arrays. Instead, you write a single clear API and rely on the language to do the right thing when you pass different data types to it.

In practice, this means more expressive and concise code when handling memory slices. Whether you are parsing text, processing binary data, or just trying to avoid unnecessary allocations in everyday code, C# 14’s first-class span support makes Span-based programming more _natural_. It’s a great example of a language feature that improves both developer productivity and runtime performance, all while keeping code safe and robust. With spans now seamlessly converting from arrays and strings, you can embrace these high-performance types throughout your codebase with even less friction than before.

**Sources:**

-   [C# 14 Feature Specification – _First-class Span types_](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/first-class-span-types#:~:text=recognize%20the%20relationship%20between%20%60ReadOnlySpan,a%20lot%20of%20duplicate%20surface)
-   [_What’s new in C# 14: More implicit conversions for Span<T>_](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/csharp-14#implicit-span-conversions#:~:text=%60Span,with%20generic%20type%20inference%20scenarios)
-   [What’s new in C# 14](/2024/12/csharp-14/)
