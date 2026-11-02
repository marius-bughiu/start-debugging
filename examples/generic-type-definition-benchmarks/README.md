# GetGenericTypeDefinition benchmark

Requires the .NET 8 SDK/runtime. Package version: BenchmarkDotNet 0.13.12.

```sh
dotnet run -c Release -f net8.0 -- --verify
dotnet run -c Release -f net8.0 -- --job Dry --filter '*'
dotnet run -c Release -f net8.0 -- --filter '*'
```

For the historical comparison, install both .NET 7 and .NET 8 runtimes, then run:

```sh
dotnet run -c Release -f net8.0 -- --runtimes net7.0 net8.0 --filter '*'
```

The source stores `typeof(List<int>)` once and returns its generic type definition. This measures repeated calls on a known type, not first-use discovery, type loading, or an entire reflection-heavy application. `--verify` checks the result is `typeof(List<>)`. A `Dry` job validates execution only; use ordinary measurement jobs and preserve their environment/report output before drawing a timing conclusion.

Microsoft documented caching improvements in its [.NET 8 performance analysis](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/). That does not imply a fixed multiplier on every machine.
