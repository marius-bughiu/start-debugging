---
title: "The type or namespace name InterceptsLocationAttribute could not be found"
description: "If you’re just getting started with interceptors, you might be getting one of the following errors: Error CS0246 The type or namespace name ‘InterceptsLocationAttribute’ could not be found (are you missing a using directive or an assembly reference?) Error CS0246 The type or namespace name ‘InterceptsLocation’ could not be found (are you missing a using…"
pubDate: 2023-09-14
updatedDate: 2023-11-05
tags:
  - "c-sharp"
  - "net"
  - "net-8"
---
If you’re just getting started with interceptors, you might be getting one of the following errors:

> Error CS0246 The type or namespace name ‘InterceptsLocationAttribute’ could not be found (are you missing a using directive or an assembly reference?)

> Error CS0246 The type or namespace name ‘InterceptsLocation’ could not be found (are you missing a using directive or an assembly reference?)

The reason for this is that the attribute is not defined yet anywhere, so you will have to define it yourself. Do not worry, the compiler will properly detect your attribute and apply the expected behavior.

Here’s an `InterceptsLocation` attribute definition that you can use:

```cs
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    sealed class InterceptsLocationAttribute(string filePath, int line, int character) : Attribute
    {
    }
}
```

### Error CS8652 The feature ‘primary constructors’ is currently in Preview and _unsupported_. To use Preview features, use the ‘preview’ language version.

This means that you are using .NET 8, but you haven’t switched yet to C# 12. You can either [switch to C# 12](/2023/06/how-to-switch-to-c-12/) or defined the attribute without using primary constructors, like so:

```cs
namespace System.Runtime.CompilerServices
{
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = true)]
    sealed class InterceptsLocationAttribute : Attribute
    {
        public InterceptsLocationAttribute(string filePath, int line, int character)
        {
            
        }
    }
}
```
