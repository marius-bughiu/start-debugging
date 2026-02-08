---
title: ".NET 10: Stack allocation of arrays of value types"
description: "In .NET 10, the JIT can stack-allocate small fixed-size arrays of value types, eliminating heap allocations and delivering up to 60% faster performance compared to .NET 9."
pubDate: 2025-04-12
tags:
  - "net"
  - "net-10"
---
Starting with .NET 9, the JIT compiler got smarter about how it allocates memory for objects. If it can tell that an object won’t be used after the method where it was created ends, it can put that object on the stack instead of the heap. This is a big win for performance because the garbage collector doesn’t have to keep track of it. On top of that, stack allocation can help the JIT apply even more optimizations, like replacing the whole object with just its individual fields or values. This makes using reference types a lot cheaper in terms of performance.

In .NET 10, this feature was expanded to include small, fixed-size arrays of value types. The JIT will stack-allocate these arrays when it knows they only live as long as the method they’re in.

Take this example:

```cs
static void Sum()
{
    int[] numbers = {1, 2, 3};
    int sum = 0;

    for (int i = 0; i < numbers.Length; i++)
    {
        sum += numbers[i];
    }

    Console.WriteLine(sum);
}
```

Here, the `numbers` array has only three integers, and it’s only used inside the `Sum` method. Since the JIT knows its size and scope at compile time, it can safely put the array on the stack. That means no heap allocation and better performance.

## Benchmarks

Comparing .NET 9 vs .NET 10 we can clearly see that for the scenario above **nothing gets allocated on the heap anymore**. This also results in a quite significant performance improvement, with **.NET 10 being 60% faster** on the benchmarked scenario.

```clean
| Method        | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|-------------- |---------- |---------:|------:|-------:|----------:|------------:|
| AllocateArray | .NET 10.0 | 3.041 ns |  0.40 |      - |         - |        0.00 |
| AllocateArray | .NET 9.0  | 7.675 ns |  1.00 | 0.0067 |      56 B |        1.00 |
```

In case you’d like to run the benchmark yourself, you can find the code below:

```cs
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net90, baseline: true)]
[SimpleJob(RuntimeMoniker.Net10_0)]
[HideColumns("Job", "Error", "StdDev", "RatioSD")]
public class ArrayAllocationBenchmarks
{
    [Benchmark]
    public int AllocateArray()
    {
        int total = 0;

        int[] numbers = { 1, 2, 3, 4, 5, 6, 7 };
        for (int i = 0; i < numbers.Length; i++)
        {
            total += numbers[i];
        }

        return total;
    }
}

internal class Program
{
    static void Main(string[] args)
    {
        BenchmarkRunner.Run<ArrayAllocationBenchmarks>();
    }
}
```
