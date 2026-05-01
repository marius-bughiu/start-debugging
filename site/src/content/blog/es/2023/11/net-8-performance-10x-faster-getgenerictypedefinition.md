---
title: "Rendimiento de .NET 8: GetGenericTypeDefinition 10 veces más rápido"
description: "Las pruebas de GetGenericTypeDefinition en .NET 8 frente a .NET 7 muestran un rendimiento casi 10 veces mayor. Mira el código del benchmark y los resultados con BenchmarkDotNet."
pubDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/11/net-8-performance-10x-faster-getgenerictypedefinition"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 trae buenas mejoras de rendimiento para APIs existentes que manejan información de tipos. Una de esas APIs que ha visto una mejora significativa es `GetGenericTypeDefinition`.

En mis benchmarks, la implementación de .NET 8 es casi 10 veces más rápida en comparación con la versión de .NET 7.

```plaintext
| Method                   | Runtime  | Mean      | Error     | StdDev    |
|------------------------- |--------- |----------:|----------:|----------:|
| GetGenericTypeDefinition | .NET 7.0 | 13.078 ns | 0.0505 ns | 0.0422 ns |
| GetGenericTypeDefinition | .NET 8.0 |  1.611 ns | 0.0091 ns | 0.0076 ns |
```

Si quieres, puedes ejecutar este benchmark tú mismo usando `BenchmarkDotNet`:

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

O, si prefieres una muestra lista para ejecutar, puedes [clonar este repositorio](https://github.com/Start-Debugging/dotnet-samples/tree/main/reflection) y correr `GetGenericTypeDefinitionBenchmarks`.
