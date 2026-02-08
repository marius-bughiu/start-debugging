---
title: ".NET 8 performance: 10x faster GetGenericTypeDefinition"
description: "Benchmarking GetGenericTypeDefinition in .NET 8 vs .NET 7 shows nearly 10x faster performance. See benchmark code and results using BenchmarkDotNet."
pubDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
---
.NET 8 brings some neat performance improvements for existing APIs that handle type information. One such API that has seen a significant improvement is `GetGenericTypeDefinition`.

In my benchmarks, the .NET 8 implementation is almost 10 times faster compared to the .NET 7 version.

```plaintext
| Method                   | Runtime  | Mean      | Error     | StdDev    |
|------------------------- |--------- |----------:|----------:|----------:|
| GetGenericTypeDefinition | .NET 7.0 | 13.078 ns | 0.0505 ns | 0.0422 ns |
| GetGenericTypeDefinition | .NET 8.0 |  1.611 ns | 0.0091 ns | 0.0076 ns |
```

You can run this benchmark yourself if you’d like using `BenchmarkDotNet`:

```cs
[SimpleJob(RuntimeMoniker.Net70)]
[SimpleJob(RuntimeMoniker.Net80)]
public class Benchmarks
{
    private readonly Type _type = typeof(List<int>);

    [Benchmark]
    public Type GetGenericTypeDefinition() => _type.GetGenericTypeDefinition();
}
```
```cs
BenchmarkRunner.Run<Benchmarks>();
```

Or if you’re looking for a ready-to-run sample, you can [clone this repository](https://github.com/Start-Debugging/dotnet-samples/tree/main/reflection) and run the `GetGenericTypeDefinitionBenchmarks`.
