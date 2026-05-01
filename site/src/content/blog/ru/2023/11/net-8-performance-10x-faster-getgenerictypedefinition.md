---
title: "Производительность .NET 8: GetGenericTypeDefinition в 10 раз быстрее"
description: "Бенчмарки GetGenericTypeDefinition в .NET 8 по сравнению с .NET 7 показывают почти 10-кратный рост производительности. Смотрите код бенчмарка и результаты, полученные с помощью BenchmarkDotNet."
pubDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/11/net-8-performance-10x-faster-getgenerictypedefinition"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 приносит хорошие улучшения производительности для существующих API, работающих с информацией о типах. Один из таких API, получивший значительный прирост, — это `GetGenericTypeDefinition`.

В моих бенчмарках реализация в .NET 8 почти в 10 раз быстрее по сравнению с версией в .NET 7.

```plaintext
| Method                   | Runtime  | Mean      | Error     | StdDev    |
|------------------------- |--------- |----------:|----------:|----------:|
| GetGenericTypeDefinition | .NET 7.0 | 13.078 ns | 0.0505 ns | 0.0422 ns |
| GetGenericTypeDefinition | .NET 8.0 |  1.611 ns | 0.0091 ns | 0.0076 ns |
```

При желании этот бенчмарк можно запустить самостоятельно с помощью `BenchmarkDotNet`:

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

Или, если нужен готовый к запуску пример, вы можете [клонировать этот репозиторий](https://github.com/Start-Debugging/dotnet-samples/tree/main/reflection) и запустить `GetGenericTypeDefinitionBenchmarks`.
