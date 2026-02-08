---
title: "C# 14 Extension Members: Extension Properties, Operators, and Static Extensions"
description: "C# 14 introduces extension members, allowing you to add extension properties, operators, and static members to existing types using the new extension keyword."
pubDate: 2026-02-08
tags:
  - "c-sharp"
  - "14"
  - "net-10"
  - "extension-members"
---

C# 14 ships with .NET 10 and brings the most requested evolution to extension methods since their introduction in C# 3.0. You can now define extension properties, extension operators, and static extension members using the new `extension` keyword.

## From Extension Methods to Extension Blocks

Previously, adding functionality to a type you don't own meant creating a static class with static methods and a `this` modifier. That pattern worked for methods but left properties and operators out of reach.

C# 14 introduces **extension blocks**, a dedicated syntax that groups related extension members together:

```csharp
public static class StringExtensions
{
    extension(string s)
    {
        public bool IsNullOrEmpty => string.IsNullOrEmpty(s);

        public int WordCount => s.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length;
    }
}
```

The `extension(string s)` block declares that all members inside extend `string`. You can now access these as properties:

```csharp
string title = "Hello World";
Console.WriteLine(title.IsNullOrEmpty);  // False
Console.WriteLine(title.WordCount);       // 2
```

## Extension Operators

Operators were previously impossible to add to types you don't control. C# 14 changes that:

```csharp
public static class PointExtensions
{
    extension(Point p)
    {
        public static Point operator +(Point a, Point b)
            => new Point(a.X + b.X, a.Y + b.Y);

        public static Point operator -(Point a, Point b)
            => new Point(a.X - b.X, a.Y - b.Y);
    }
}
```

Now `Point` instances can use `+` and `-` even though the original type didn't define them.

## Static Extension Members

Extension blocks also support static members that appear as static members of the extended type:

```csharp
public static class GuidExtensions
{
    extension(Guid)
    {
        public static Guid Empty2 => Guid.Empty;

        public static Guid CreateDeterministic(string input)
        {
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes(input));
            return new Guid(hash.AsSpan(0, 16));
        }
    }
}
```

Call it as if it were a static member of `Guid`:

```csharp
var id = Guid.CreateDeterministic("user@example.com");
```

## What's Not Supported Yet

C# 14 focuses on methods, properties, and operators. Fields, events, indexers, nested types, and constructors are not supported in extension blocks. These may arrive in future C# versions.

## When to Use Extension Members

Extension properties shine when you have computed values that feel like natural properties of a type. The `string.WordCount` example reads better than `string.GetWordCount()`. Extension operators work well for mathematical or domain types where operators make semantic sense.

The feature is available now in .NET 10. Update your project to `<LangVersion>14</LangVersion>` or `<LangVersion>latest</LangVersion>` to start using extension blocks.

For complete documentation, see [Extension members on Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/whats-new/tutorials/extension-members).
