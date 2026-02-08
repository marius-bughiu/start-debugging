---
title: ".NET Performance: ToList vs ToArray"
description: ".NET 9 significantly improves ToArray performance using InlineArray, making it faster and more memory-efficient than ToList. See benchmarks comparing .NET 8 vs .NET 9."
pubDate: 2025-01-06
updatedDate: 2025-04-04
tags:
  - "c-sharp"
  - "net"
  - "net-9"
  - "performance"
---
.NET 9 brings significant improvements to LINQ’s `ToArray` method, both in terms of speed, as well as memory allocation. To achieve this, the new implementation makes use of new runtime features such as `InlineArray` to significantly reduce memory allocations and improve speed, especially when dealing with an `IEnumerable<T>` of unknown length. If you’re curious about the implementation, you can [check out the PR on GitHub](https://github.com/dotnet/runtime/pull/96570).

## .NET 8 vs .NET 9

First, let’s look at the `ToArray` performance improvement between .NET 8 and .NET 9:

```bash
| Method  | Runtime  | Count  | Mean          | Ratio | Allocated | Alloc Ratio |
|-------- |--------- |------- |--------------:|------:|----------:|------------:|
| ToArray | .NET 8.0 | 10     |     115.61 ns |  1.00 |     256 B |        1.00 |
| ToArray | .NET 9.0 | 10     |      71.91 ns |  0.62 |     104 B |        0.41 |
|         |          |        |               |       |           |             |
| ToArray | .NET 8.0 | 1000   |   3,209.52 ns |  1.00 |    8536 B |        1.00 |
| ToArray | .NET 9.0 | 1000   |   2,625.86 ns |  0.82 |    4064 B |        0.48 |
|         |          |        |               |       |           |             |
| ToArray | .NET 8.0 | 100000 | 545,642.89 ns |  1.00 |  925132 B |        1.00 |
| ToArray | .NET 9.0 | 100000 | 362,780.53 ns |  0.67 |  400148 B |        0.43 |

BenchmarkDotNet v0.14.0, Windows 11 (10.0.26100.2605)
AMD Zen 2, 1 CPU, 8 logical and 4 physical cores
  .NET 8.0 : .NET 8.0.11 (8.0.1124.51707), X64 RyuJIT AVX2
  .NET 9.0 : .NET 9.0.0 (9.0.24.52809), X64 RyuJIT AVX2
```

While the results vary slightly depending on the number of items in the iterator, you still get an up to 38% reduction in CPU time and a whopping 57% in allocated memory. That’s quite good!

## ToList vs ToArray

Now, traditionally `ToList` was faster when dealing with collections of unknown sizes because it was skipping that final array allocation, while `ToArray` was more efficient in terms of memory usage. Starting with .NET 9, that is no longer the case, with `ToArray` being more efficient from both perspectives.

```bash
| Method  | Runtime  | Count  | Mean          | Ratio | Allocated | Alloc Ratio |
|-------- |--------- |------- |--------------:|------:|----------:|------------:|
| ToList  | .NET 9.0 | 10     |      81.44 ns |  1.00 |     256 B |        1.00 |
| ToArray | .NET 9.0 | 10     |      71.91 ns |  0.88 |     104 B |        0.40 |
|         |          |        |               |       |           |             |
| ToList  | .NET 9.0 | 1000   |   2,942.87 ns |  1.00 |    8464 B |        1.00 |
| ToArray | .NET 9.0 | 1000   |   2,625.86 ns |  0.89 |    4064 B |        0.48 |
|         |          |        |               |       |           |             |
| ToList  | .NET 9.0 | 100000 | 494,497.60 ns |  1.00 | 1049112 B |        1.00 |
| ToArray | .NET 9.0 | 100000 | 362,780.53 ns |  0.73 |  400148 B |        0.38 |

BenchmarkDotNet v0.14.0, Windows 11 (10.0.26100.2605)
AMD Zen 2, 1 CPU, 8 logical and 4 physical cores
  .NET 8.0 : .NET 8.0.11 (8.0.1124.51707), X64 RyuJIT AVX2
  .NET 9.0 : .NET 9.0.0 (9.0.24.52809), X64 RyuJIT AVX2
```

Overall we’re looking at a 10 to 30% speed difference and around 60% less memory being allocated, depending on the number of elements.

## Running the benchmark

You can run this benchmark yourself if you’d like using `BenchmarkDotNet`.

```cs
[SimpleJob(RuntimeMoniker.Net80, baseline: true)]
[SimpleJob(RuntimeMoniker.Net90)]
[MemoryDiagnoser(false)]
[HideColumns("Job", "Error", "StdDev", "RatioSD")]
public class Benchmarks
{
    [Params(10, 1000, 100000)]
    public int Count;

    [Benchmark]
    public List<int> ToList() => GetItems(Count).ToList();

    [Benchmark]
    public int[] ToArray() => GetItems(Count).ToArray();

    private IEnumerable<int> GetItems(int count)
    {
        for (int i = 0; i < count; i++)
        {
            yield return 1;
        }
    }
}
```
```cs
BenchmarkRunner.Run<Benchmarks>();
```
