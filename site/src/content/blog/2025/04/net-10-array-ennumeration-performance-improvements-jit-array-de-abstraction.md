---
title: ".NET 10: Array Enumeration Performance Improvements (JIT Array De-Abstraction)"
description: "In .NET 10, the JIT compiler reduces the overhead of iterating arrays through interfaces. See benchmarks comparing .NET 9 vs .NET 10 with foreach, IEnumerable, and conditional escape analysis."
pubDate: 2025-04-06
tags:
  - "net"
  - "net-10"
  - "performance"
---
In .NET 10 Preview 1, the JIT compiler got better at optimizing how arrays are used with interfaces, especially when looping through them using `foreach`. This was the first step toward reducing the extra cost that comes with using enumerators to go through arrays. Preview 2 builds on this work with even more improvements.

Take a look at the following example:

```cs
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net90)]
public class ArrayDeAbstraction
{
    static readonly int[] array = new int[512];

    [Benchmark(Baseline = true)]
    public int Enumeration()
    {
        int sum = 0;
        foreach (int i in array) sum += i;
        return sum;
    }

    [Benchmark]
    public int EnumerationViaInterface()
    {
        IEnumerable<int> o = array;
        int sum = 0;
        foreach (int i in o) sum += i;
        return sum;
    }
}
```

In the first method, the array type is known at compile time, so the JIT can generate fast code. In the second method, the array is treated as an `IEnumerable<int>`, which hides the actual type. This adds some extra work like creating an object and using virtual method calls. In .NET 9, this had a big impact on performance:

```clean
| Method                   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------:|------:|-------:|----------:|------------:|
| Enumeration             | 303.6 ns |  1.00 |      - |         - |        0.00 |
| EnumerationViaInterface | 616.1 ns |  2.03 | 0.0153 |      32 B |        1.00 |
```

Thanks to further improvements in .NET 10, such as better inlining, smarter memory use, and improved loop handling, that extra allocation is now gone and performance is much better:

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 216.2 ns |  0.35 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 615.8 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

The goal is to close the gap entirely, even in more complex cases. Here’s a tougher example:

```cs
[MemoryDiagnoser]
[SimpleJob(RuntimeMoniker.Net90, baseline: true)]
[SimpleJob(RuntimeMoniker.Net10_0)]
[HideColumns("Job", "Error", "StdDev", "RatioSD")]
public class ArrayDeAbstraction
{
    static readonly int[] array = new int[512];

    [MethodImpl(MethodImplOptions.NoInlining)]
    IEnumerable<int> GetOpaqueArray() => array;

    [Benchmark]
    public int EnumerationViaInterface()
    {
        IEnumerable<int> o = GetOpaqueArray();
        int sum = 0;
        foreach (int i in o) sum += i;
        return sum;
    }
}
```

In this case, the method returns an `IEnumerable<int>` without revealing it’s actually an array. The JIT doesn’t know the real type, so it can’t optimize as well. However, using PGO (Profile-Guided Optimization), the JIT can guess the likely type and create a faster path when the guess is right.

In .NET 9, the JIT couldn’t put the enumerator on the stack. That’s due to something called “escape analysis,” which checks if an object might be used outside the current method. If it might, the JIT plays it safe and puts it on the heap. But in .NET 10, there’s a new feature called **conditional escape analysis**. It’s smarter about figuring out _when_ something escapes. If the JIT sees that the object only escapes on certain paths (like when the type isn’t what we expect), it can create a separate fast path where the object is kept on the stack.

Thanks to this, we get much better results in .NET 10 compared to .NET 9:

```clean
| Method                   | Runtime   | Mean     | Ratio | Gen0   | Allocated | Alloc Ratio |
|------------------------- |---------- |---------:|------:|-------:|----------:|------------:|
| EnumerationViaInterface | .NET 10.0 | 162.5 ns |  0.26 |      - |         - |        0.00 |
| EnumerationViaInterface | .NET 9.0  | 617.5 ns |  1.00 | 0.0153 |      32 B |        1.00 |
```

As you can see, .NET is getting smarter about how it handles array iteration, even when it’s wrapped behind interfaces. This leads to better performance and lower memory use, especially in real-world code where these patterns are common.
