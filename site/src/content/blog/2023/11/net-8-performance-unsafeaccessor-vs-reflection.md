---
title: ".NET 8 Performance: UnsafeAccessor vs. Reflection"
description: "Run a reproducible .NET 8 benchmark comparing UnsafeAccessor, reflection, cached reflection, cached delegates and direct calls with observable work."
pubDate: 2023-11-01
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
---
An `UnsafeAccessor` binds to a known member without reflection lookup or `MethodInfo.Invoke`. A useful comparison must keep the target work observable and explain what each path does.

**Correction — November 2, 2026:** The old source repository is unavailable. The sample is restored here with a functional check, allocation diagnostics, cached delegates and matching non-inlined target methods. The previous near-zero timings do not establish universal zero overhead and are no longer presented as reproducible measurements.

## Download and run

[Download the benchmark source](/examples/unsafe-accessor-benchmarks.zip). It targets .NET 8 and pins BenchmarkDotNet 0.15.8.

```sh
dotnet run -c Release -- --verify
dotnet run -c Release -- --job Dry --filter '*'
dotnet run -c Release -- --filter '*'
```

The first command verifies that all five call paths return `59` for input `42`. The second is a one-iteration execution smoke check. Use the final command for ordinary measurements and preserve its generated environment and report files before interpreting timings.

## What is compared

1. **Direct call:** invokes a public method.
2. **Unsafe accessor:** binds to a private method with the same operation.
3. **Reflection lookup and invoke:** finds the method and invokes it for each operation.
4. **Cached reflection:** reuses `MethodInfo`, but still supplies an object argument array.
5. **Cached delegate:** reuses an open instance delegate for the private method.

The two target methods return the input plus an instance field and use `MethodImplOptions.NoInlining`. Each benchmark returns the result. The input is a BenchmarkDotNet parameter, which avoids reducing the demonstration to a constant-returning, inlined method.

`MemoryDiagnoser` reports allocations, including argument-array/boxing work in the reflection cases. Those paths do different work; a timing difference is not solely an access-control check.

## Verification and interpretation

The restored project was executed with .NET 8.0.33 on macOS arm64. Its functional verification and all five BenchmarkDotNet Dry jobs passed. Dry-job timings are deliberately not published as a performance table: they validate the harness, not a stable nanosecond estimate.

Inlining, runtime version, architecture, target work, caching and allocations all affect results. A tiny measured value can mean the JIT eliminated the work or the measurement is below the harness's useful resolution. It is not proof that every accessor operation is free.

An accessor also needs the member signature at compile time. Reflection remains useful when the type/member is discovered at runtime. See [the member-access examples](/2023/10/unsafe-accessor/) and [Microsoft's API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute) for that distinction.
