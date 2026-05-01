---
title: ".NET 8 Performance: GetGenericTypeDefinition 10x schneller"
description: "Benchmarks von GetGenericTypeDefinition in .NET 8 im Vergleich zu .NET 7 zeigen eine fast 10x bessere Leistung. Sehen Sie sich den Benchmark-Code und die Ergebnisse mit BenchmarkDotNet an."
pubDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/11/net-8-performance-10x-faster-getgenerictypedefinition"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 bringt einige saubere Performance-Verbesserungen für bestehende APIs, die mit Typinformationen umgehen. Eine solche API, die deutlich schneller geworden ist, ist `GetGenericTypeDefinition`.

In meinen Benchmarks ist die .NET 8-Implementierung im Vergleich zur .NET 7-Version fast 10-mal schneller.

```plaintext
| Method                   | Runtime  | Mean      | Error     | StdDev    |
|------------------------- |--------- |----------:|----------:|----------:|
| GetGenericTypeDefinition | .NET 7.0 | 13.078 ns | 0.0505 ns | 0.0422 ns |
| GetGenericTypeDefinition | .NET 8.0 |  1.611 ns | 0.0091 ns | 0.0076 ns |
```

Sie können diesen Benchmark mit `BenchmarkDotNet` selbst ausführen:

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

Oder, wenn Sie ein lauffertiges Beispiel suchen, können Sie [dieses Repository klonen](https://github.com/Start-Debugging/dotnet-samples/tree/main/reflection) und die `GetGenericTypeDefinitionBenchmarks` ausführen.
