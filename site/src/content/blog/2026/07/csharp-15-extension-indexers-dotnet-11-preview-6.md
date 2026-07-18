---
title: "C# 15 Extension Indexers Round Out Extension Members in .NET 11 Preview 6"
description: "Extension indexers landed in .NET 11 Preview 6, letting you add this[...] access to types you do not own. They complete the extension members story that started with methods and properties in C# 14."
pubDate: 2026-07-18
tags:
  - "dotnet-11"
  - "csharp"
  - "csharp-15"
  - "extension-members"
---

.NET 11 Preview 6 shipped on July 14, 2026, and buried in the C# section of the release notes is the piece that finally makes extension members feel complete: extension indexers. Extension methods have been around since C# 3.0, extension properties arrived with the [extension block in C# 14](/2026/06/how-to-declare-extension-properties-in-csharp-14/), and now you can bolt `this[...]` access onto a type you do not own.

## What was missing until now

The obvious workaround has always been a plain extension method. If you wanted index-from-the-end semantics on an `IReadOnlyList<T>`, which does not carry an indexer that understands `Index`, you wrote something like this:

```csharp
public static class ReadOnlyListExtensions
{
    public static T At<T>(this IReadOnlyList<T> list, Index index)
        => list[index.GetOffset(list.Count)];
}

// call site
IReadOnlyList<string> log = ["start", "work", "done"];
Console.WriteLine(log.At(^1));   // done
Console.WriteLine(log.At(^2));   // work
```

It works, but the call site reads `log.At(^1)` instead of the `log[^1]` syntax that every other list-like type gives you. You lose the square-bracket notation, and you lose it in list patterns too.

## The extension indexer version

C# 15 lets you declare the indexer inside an `extension` block, exactly the way you would declare an instance indexer:

```csharp
public static class ReadOnlyListExtensions
{
    extension<T>(IReadOnlyList<T> list)
    {
        public T this[Index index] => list[index.GetOffset(list.Count)];
    }
}

// call site
IReadOnlyList<string> log = ["start", "work", "done"];
Console.WriteLine(log[^1]);   // done
Console.WriteLine(log[^2]);   // work
```

The receiver captured by the `extension<T>(IReadOnlyList<T> list)` header is in scope inside the body, so the indexer forwards to `list` directly. The call site now uses real indexer syntax, and because the compiler treats it as an indexer, it participates in list patterns and range expressions the same way a built-in one would.

Extension indexers are not limited to the one-parameter, get-only shape. They support multiple parameters and both `get` and `set` accessors, so you can project a two-dimensional lookup onto a flat backing store or expose a writable view over a type that only offers method-based access.

## Turning it on

This is still a preview language feature, so it does not light up on the default language version. Add the following to your `.csproj`:

```xml
<LangVersion>preview</LangVersion>
```

Extension indexers are the last of the three classic member kinds to reach extension blocks, which means the mental model is now uniform: methods, properties, and indexers all declare the same way inside `extension(...)`. If you have been reaching for wrapper types or awkward `.At()` helpers to paper over a missing indexer, Preview 6 is the release that lets you delete them. See the [C# section of the Preview 6 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/csharp.md) for the full write-up.
