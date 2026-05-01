---
title: ".NET 8 のパフォーマンス: GetGenericTypeDefinition が 10 倍高速に"
description: ".NET 8 と .NET 7 で GetGenericTypeDefinition をベンチマークすると、ほぼ 10 倍のパフォーマンス向上が見られます。BenchmarkDotNet によるベンチマークコードと結果を紹介します。"
pubDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/11/net-8-performance-10x-faster-getgenerictypedefinition"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 では、型情報を扱う既存の API にうれしいパフォーマンス改善が入っています。その中でも大きく改善された API のひとつが `GetGenericTypeDefinition` です。

私のベンチマークでは、.NET 8 の実装は .NET 7 のバージョンと比べてほぼ 10 倍高速です。

```plaintext
| Method                   | Runtime  | Mean      | Error     | StdDev    |
|------------------------- |--------- |----------:|----------:|----------:|
| GetGenericTypeDefinition | .NET 7.0 | 13.078 ns | 0.0505 ns | 0.0422 ns |
| GetGenericTypeDefinition | .NET 8.0 |  1.611 ns | 0.0091 ns | 0.0076 ns |
```

このベンチマークは、`BenchmarkDotNet` を使って自分で実行することもできます。

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

そのまま動かせるサンプルが欲しい場合は、[このリポジトリをクローン](https://github.com/Start-Debugging/dotnet-samples/tree/main/reflection)して `GetGenericTypeDefinitionBenchmarks` を実行してください。
