---
title: ".NET 8 GetGenericTypeDefinition performance: a reproducible benchmark"
description: "Reproduce repeated GetGenericTypeDefinition calls with BenchmarkDotNet and compare selected .NET runtimes without assuming a fixed speedup."
pubDate: 2023-11-05
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
---
Microsoft documented improvements to generic type-information handling in .NET 8, including caching the result of `GetGenericTypeDefinition` on the `Type` object. That is a specific runtime optimization, not a fixed multiplier for every reflection workload.

**Correction — November 2, 2026:** The old “10x” title and unattributed timing table were removed because the original run artifacts and source repository are unavailable. The historical URL is preserved, and a runnable benchmark is now maintained with this site.

## Restore the benchmark

[Download the source project](/examples/generic-type-definition-benchmarks.zip). It builds for .NET 7 and .NET 8 and pins BenchmarkDotNet 0.13.12. The core workload is:

```cs
public class GenericTypeBenchmarks
{
    private readonly Type _type = typeof(List<int>);

    [Benchmark]
    public Type GetGenericTypeDefinition() => _type.GetGenericTypeDefinition();
}
```

The complete project includes the imports and runner. Run its functional check and normal measurements:

```sh
dotnet run -c Release -f net8.0 -- --verify
dotnet run -c Release -f net8.0 -- --filter '*'
```

The functional check verifies that the result is `typeof(List<>)`. A Dry job can check execution quickly, but its timing is not a reliable performance result.

## Compare .NET 7 and .NET 8

Install both runtimes, then select them explicitly:

```sh
dotnet run -c Release -f net8.0 -- --runtimes net7.0 net8.0 --filter '*'
```

The historical comparison requires those actual runtimes; running a .NET 8-targeted application on a newer runtime does not reproduce .NET 8 measurements. Keep the generated environment details and reports with any result you publish.

This benchmark measures repeated calls on a known `Type`. It does not measure type loading, uncached discovery or a whole application. Microsoft's [.NET 8 performance analysis](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/) explains the optimization and reports its own measurements; those results are separate from this project's verification.

For a different reflection workload, see [the UnsafeAccessor comparison](/2023/11/net-8-performance-unsafeaccessor-vs-reflection/).
