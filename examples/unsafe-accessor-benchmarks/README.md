# UnsafeAccessor and reflection benchmarks

Requires the .NET 8 SDK/runtime. Package version: BenchmarkDotNet 0.15.8.

```sh
dotnet run -c Release -- --verify
dotnet run -c Release -- --job Dry --filter '*'
dotnet run -c Release -- --filter '*'
```

`--verify` checks that all five call paths return the same result. `Dry` is an execution smoke check, not a stable timing experiment. The final command runs ordinary measurements and writes environment details and reports under `BenchmarkDotNet.Artifacts/`.

The public/private methods contain the same operation and disable inlining. A parameter supplies the input; each benchmark returns its result. Cached delegates are included alongside reflection lookup, cached reflection, direct calls, and an unsafe accessor. The reflection cases also perform argument-array/boxing work, which the allocation report exposes.

These cases answer a narrower question than a whole application's performance. Runtime, architecture, inlining, workload and allocation choices affect results. No universal “zero overhead” or speedup number is asserted.
