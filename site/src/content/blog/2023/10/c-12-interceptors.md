---
title: "C# 12 – Interceptors"
description: "Learn about C# 12 interceptors, an experimental .NET 8 compiler feature that lets you replace method calls at compile time using the InterceptsLocation attribute."
pubDate: 2023-10-12
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
---
Interceptors are an experimental compiler feature introduced in .NET 8, meaning it may change or be removed in a future release of the framework. To see what else is new in .NET 8, check out our [What’s new in .NET 8](/2023/06/whats-new-in-net-8/) page.

To enable the feature, you’ll need to turn on a feature flag by adding `<Features>InterceptorsPreview</Features>` to your `.csproj` file.

## What is an interceptor?

An interceptor is a method which can replace a call to an interceptable method with a call to itself. The link between the two methods is made declaratively, using the `InterceptsLocation` attribute, and the substitution is done during the compilation process, with the runtime knowing nothing about it.

Interceptors can be used in combination with source generators to modify existing code by adding new code to a compilation which completely replaces the intercepted method.

## Getting started

Before you start using interceptors, you will need to first declare the `InterceptsLocationAttribute` in the project where you plan to do the intercepting. That is because the feature is still in preview, and the attribute is not yet shipped with .NET 8.

Here’s the implementation for reference:

```cs
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    sealed class InterceptsLocationAttribute : Attribute
    {
        public InterceptsLocationAttribute(string filePath, int line, int column)
        {
            
        }
    }
}
```

Now let’s look at a quick example of how it works. We start with a very simple setup containing a class `Foo`, with an `Interceptable` method, and a few calls to that method that we’ll want to intercept a bit later.

```cs
var foo = new Foo();

foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(1); // "interceptable 1"
foo.Interceptable(2); // "interceptable 2"
foo.Interceptable(1); // "interceptable 1"

class Foo
{
    public void Interceptable(int param)
    {
        Console.WriteLine($"interceptable {param}");
    }
}
```

Next, we need to do the actual intercepting:

```cs
static class MyInterceptor
{
    [InterceptsLocation(@"C:\test\Program.cs", line: 5, column: 5)]
    public static void InterceptorA(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor A: {param}");
    }

    [InterceptsLocation(@"C:\test\Program.cs", line: 6, column: 5)]
    [InterceptsLocation(@"C:\test\Program.cs", line: 7, column: 5)]
    public static void InterceptorB(this Foo foo, int param)
    {
        Console.WriteLine($"interceptor B: {param}");
    }
}
```

Make sure to update the file path (`C:\test\Program.cs`) with the location of your interceptable source code file. When you’re done, run everything again, and the output of the `Interceptable(...)` calls above should change to this:

```plaintext
interceptable 1
interceptor A: 1
interceptor B: 2
interceptor B: 1
```

So what kind of black magic did we just do? Let’s dive a bit into some details.

### Interceptor method signature

The first thing to notice is the signature of the interceptor method: it’s an extension method having the `this` parameter of the same type as the interceptable method’s owner.

```cs
public static void InterceptorA(this Foo foo, int param)
```

This is a preview limitation which will be removed before the feature exits preview.

### The `filePath` parameter

Represents the path to the source code file that needs to be intercepted.

When applying the attribute in source generators, make sure to normalize the file path by applying the same path transformation that is performed by the compiler:

```cs
string GetInterceptorFilePath(SyntaxTree tree, Compilation compilation)
{
    return compilation.Options.SourceReferenceResolver?.NormalizePath(tree.FilePath, baseFilePath: null) ?? tree.FilePath;
}
```

### The `line` and the `column`

They are 1-indexed locations pointing to the exact place where the interceptable method is invoked.

In the case of the `column`, the location of the call represents the position of the first letter of the interceptable method name. For example:

-   for `foo.Interceptable(...)` it would be the position of letter `I`. Assuming no spaces before the code, that would be `5`.
-   for `System.Console.WriteLine(...)` it would be the position of the letter `W`. Assuming no spaces before the code, the `column` would be `16`

### Limitations

Interceptors only work for ordinary methods. You cannot at the moment intercept constructors, properties or local functions, though the list of supported members might change in the future.
