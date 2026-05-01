---
title: "Desempenho do .NET 8: GetGenericTypeDefinition 10x mais rápido"
description: "Benchmarks de GetGenericTypeDefinition no .NET 8 contra o .NET 7 mostram desempenho quase 10x melhor. Veja o código do benchmark e os resultados com BenchmarkDotNet."
pubDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "pt-br"
translationOf: "2023/11/net-8-performance-10x-faster-getgenerictypedefinition"
translatedBy: "claude"
translationDate: 2026-05-01
---
O .NET 8 traz boas melhorias de desempenho para APIs existentes que lidam com informações de tipo. Uma dessas APIs que recebeu uma melhoria significativa é `GetGenericTypeDefinition`.

Nos meus benchmarks, a implementação do .NET 8 é quase 10 vezes mais rápida em comparação com a versão do .NET 7.

```plaintext
| Method                   | Runtime  | Mean      | Error     | StdDev    |
|------------------------- |--------- |----------:|----------:|----------:|
| GetGenericTypeDefinition | .NET 7.0 | 13.078 ns | 0.0505 ns | 0.0422 ns |
| GetGenericTypeDefinition | .NET 8.0 |  1.611 ns | 0.0091 ns | 0.0076 ns |
```

Se quiser, você pode rodar esse benchmark por conta própria usando `BenchmarkDotNet`:

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

Ou, se preferir um exemplo pronto para executar, você pode [clonar este repositório](https://github.com/Start-Debugging/dotnet-samples/tree/main/reflection) e rodar o `GetGenericTypeDefinitionBenchmarks`.
