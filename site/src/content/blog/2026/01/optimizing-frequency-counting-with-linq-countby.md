---
title: "Optimizing Frequency Counting with LINQ CountBy"
description: "Replace GroupBy with CountBy in .NET 9 for cleaner, more efficient frequency counting. Reduces allocations from O(N) to O(K) by skipping intermediate grouping structures."
pubDate: 2026-01-01
tags:
  - "dotnet"
  - "dotnet-9"
---
One of the most common operations in data processing is calculating the frequency of items in a collection. For years, C# developers have relied on the `GroupBy` pattern to achieve this. While functional, it often incurs unnecessary overhead by allocating bucket objects for groups that are immediately discarded after counting.

With .NET 9, the System.Linq namespace introduces `CountBy`, a specialized method that streamlines this operation significantly.

## The Legacy Overhead

Prior to .NET 9, counting occurrences usually required a verbose chain of LINQ calls. You had to group the elements, then project them into a new type containing the key and the count.

```cs
// Before: Verbose and allocates group buckets
var logLevels = new[] { "INFO", "ERROR", "INFO", "WARN", "ERROR", "INFO" };

var frequency = logLevels
    .GroupBy(level => level)
    .Select(group => new { Level = group.Key, Count = group.Count() })
    .ToDictionary(x => x.Level, x => x.Count);
```

This approach works, but it’s heavy. The `GroupBy` iterator builds internal data structures to hold the elements of each group, even though we only care about the count. For large datasets, this puts unnecessary pressure on the Garbage Collector.

## Streamlining with CountBy

.NET 9 adds `CountBy` directly to `IEnumerable<T>`. This method returns a collection of `KeyValuePair<TKey, int>`, stripping away the need for intermediate grouping structures.

```cs
// After: Clean, intent-revealing, and efficient
var logLevels = new[] { "INFO", "ERROR", "INFO", "WARN", "ERROR", "INFO" };

foreach (var (level, count) in logLevels.CountBy(level => level))
{
    Console.WriteLine($"{level}: {count}");
}
```

The syntax is not just cleaner; it explicitly declares the intent: we are counting by a key.

## Performance Implications

Under the hood, `CountBy` is optimized to avoid allocating the grouping buckets that `GroupBy` requires. In a traditional `GroupBy` scenario, the runtime often has to create a `Grouping<TKey, TElement>` object for every unique key, and internally maintains a collection of elements for that key. If you have 1 million items and 100 unique keys, `GroupBy` might still do significant work organizing those 1 million items into lists.

`CountBy`, however, only needs to track the counter. It effectively behaves like a `Dictionary<TKey, int>` accumulator. It iterates the source once, increments the counter for the key, and discards the element itself. This turns an O(N) space operation (in terms of keeping elements) into something closer to O(K) space, where K is the number of unique keys.

For high-throughput scenarios—such as analyzing server logs, processing transaction streams, or aggregating sensor data—this difference is non-trivial. It reduces GC pressure by discarding the heavy “bucket” objects immediately.

### Edge Cases and Keys

Like `GroupBy`, `CountBy` relies on the default equality comparer for the key type unless specified otherwise. If you are counting by a custom object key, ensure `GetHashCode` and `Equals` are correctly overridden, or provide a custom `IEqualityComparer<TKey>`.

```cs
// Handling case-insensitivity explicitly
var frequency = logLevels.CountBy(level => level, StringComparer.OrdinalIgnoreCase);
```

### When to Stick with GroupBy

It is worth noting that `CountBy` is strictly for counting. If you need the actual elements (e.g., “give me the first 5 errors”), you still need `GroupBy`. But for histograms, frequency maps, and analytics, `CountBy` in .NET 9 is the superior tool.

By adopting `CountBy`, you reduce verbosity and improve allocation patterns in your LINQ pipelines, making it a default choice for frequency analysis in modern C# codebases.
