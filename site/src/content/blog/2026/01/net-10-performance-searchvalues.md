---
title: ".NET 10 Performance: SearchValues"
description: "In .NET 8, Microsoft introduced SearchValues<T>, a specialized type that optimized searching for a set of values (like bytes or chars) within a span. It vectorized the search, making it significantly faster than IndexOfAny. In .NET 10, this power has been extended to strings. SearchValues<string> allows you to search for multiple substrings simultaneously with incredible…"
pubDate: 2026-01-04
tags:
  - "net"
  - "net-10"
---
In .NET 8, Microsoft introduced `SearchValues<T>`, a specialized type that optimized searching for a _set_ of values (like bytes or chars) within a span. It vectorized the search, making it significantly faster than `IndexOfAny`.

In .NET 10, this power has been extended to strings. `SearchValues<string>` allows you to search for multiple substrings simultaneously with incredible performance.

## The Use Case: Parsing and Filtering

Imagine you are writing a parser or a sanitizer that needs to check if a text contains any of a specific list of forbidden words or tokens.

**The Old Way (Slow)**

```cs
private static readonly string[] Forbidden = { "drop", "delete", "truncate" };

public bool ContainsSqlInjection(ReadOnlySpan<char> input)
{
    foreach (var word in Forbidden)
    {
        if (input.Contains(word, StringComparison.OrdinalIgnoreCase))
            return true;
    }
    return false;
}
```

This is O(N \* M) where N is input length and M is the number of words. It scans the string repeatedly.

## The New Way: SearchValues

With .NET 10, you can pre-compute the search strategy.

```php
using System.Buffers;

// 1. Create the optimized searcher (do this once, statically)
private static readonly SearchValues<string> SqlTokens = 
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);

public bool ContainsSqlInjection(ReadOnlySpan<char> input)
{
    // 2. Search for ANY of them in one pass
    return input.ContainsAny(SqlTokens);
}
```

## Performance Impact

Under the hood, `SearchValues.Create` analyzes the patterns.

-   If they share common prefixes, it builds a trie-like structure.
-   It uses Aho-Corasick or Teddy algorithms depending on the pattern density.
-   It leverages SIMD (AVX-512) to match multiple characters in parallel.

For a set of 10-20 keywords, `SearchValues` can be **50x faster** than a loop or a Regex.

## Finding the Location

You aren’t limited to a boolean check. You can find _where_ the match occurred:

```cs
int index = input.IndexOfAny(SqlTokens);
if (index >= 0)
{
    Console.WriteLine($"Found distinct token at index {index}");
}
```

## Summary

`SearchValues<string>` in .NET 10 brings high-performance text searching to the masses without requiring external libraries. If you are doing any kind of text processing, log analysis, or security filtering, replace your `foreach` loops with `SearchValues` immediately.
