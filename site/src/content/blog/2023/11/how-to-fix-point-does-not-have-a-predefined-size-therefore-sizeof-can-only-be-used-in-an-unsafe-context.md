---
title: "How to fix: ‘Point’ does not have a predefined size, therefore sizeof can only be used in an unsafe context"
description: "Fix the C# error where sizeof cannot be used with Point outside an unsafe context. Two solutions: enabling unsafe code or using Marshal.SizeOf instead."
pubDate: 2023-11-09
tags:
  - "csharp"
  - "dotnet"
---
The error you’re encountering is because in C#, `sizeof` can only be used with types that have a predefined size known at compile-time, and the `Point` structure is not one of those types unless you’re in an unsafe context.

There are two ways you can resolve this.

## Use `unsafe` code

This would allow the use of the `sizeof` operator with types of any size. To do this, you’ll need to mark your method with the `unsafe` keyword, and you’ll also need to enable unsafe code in your project’s build settings.

Basically, your method signature changes to this:

```cs
public static unsafe void YourMethod()
{
    // ... your unsafe code
    // IntPtr sizeOfPoint = (IntPtr)sizeof(Point);
}
```

And for allowing unsafe code, you go to project properties, and into the `Build` tab, and check the “Allow unsafe code” option. Once you’ve done this, the compilation error should be gone.

## Use `Marshal.SizeOf`

`Marshal.SizeOf` is safe and doesn’t require unsafe context. The `SizeOf` method returns the unmanaged size of an object in bytes.

All you need to do is replace `sizeof(Point)` with `Marshal.SizeOf(typeof(Point))`. Like so:

```cs
IntPtr sizeOfPoint = (IntPtr)Marshal.SizeOf(typeof(Point));
```

`Marshal.SizeOf` is part of the `System.Runtime.InteropServices` namespace, so ensure you have the using directive for it at the top of your file:

```cs
using System.Runtime.InteropServices;
```

One thing to note is that `Marshal.SizeOf` does come with a very slight performance penalty compared to the unsafe `sizeof`. That is something you might want to take into consideration when choosing the solution that best suits your needs.
