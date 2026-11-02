---
title: ".NET 8 GetGenericTypeDefinition の性能: 再現可能なベンチマーク"
description: "BenchmarkDotNet で GetGenericTypeDefinition の反復呼び出しを再現し、固定の高速化倍率を仮定せず .NET ランタイムを比較します。"
pubDate: 2023-11-05
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/11/net-8-performance-10x-faster-getgenerictypedefinition"
translatedBy: "claude"
translationDate: 2026-05-01
---
Microsoft は .NET 8 のジェネリック型情報処理の改善として、`GetGenericTypeDefinition` の結果を `Type` オブジェクトにキャッシュする最適化などを説明しています。これは特定のランタイム最適化であり、すべてのリフレクション処理に同じ倍率が適用されるという意味ではありません。

**2026年11月2日訂正:** 元の実行成果物とソースリポジトリが利用できないため、以前の「10倍」というタイトルと出所を確認できない時間表を削除しました。過去の URL は維持し、このサイトで実行可能なベンチマークを管理します。

## ベンチマークを復元する

[ソースプロジェクトをダウンロード](/examples/generic-type-definition-benchmarks.zip)できます。.NET 7 と .NET 8 の両方を対象にビルドし、BenchmarkDotNet 0.13.12 を固定しています。中心となる処理は次のとおりです。

```cs
public class GenericTypeBenchmarks
{
    private readonly Type _type = typeof(List<int>);

    [Benchmark]
    public Type GetGenericTypeDefinition() => _type.GetGenericTypeDefinition();
}
```

完全版には imports と runner があります。機能確認と通常の測定を実行します。

```sh
dotnet run -c Release -f net8.0 -- --verify
dotnet run -c Release -f net8.0 -- --filter '*'
```

機能確認では戻り値が `typeof(List<>)` であることを検証します。Dry ジョブは短時間の実行確認には使えますが、その時間は信頼できる性能結果ではありません。

## .NET 7 と .NET 8 を比較する

両方のランタイムをインストールし、明示的に選択します。

```sh
dotnet run -c Release -f net8.0 -- --runtimes net7.0 net8.0 --filter '*'
```

過去の比較を行うには、実際にそれぞれのランタイムが必要です。.NET 8 対象のアプリを新しいランタイムで実行しても .NET 8 の測定を再現したことにはなりません。結果を公開する際は、生成された環境情報とレポートも保存してください。

このベンチマークは既知の `Type` に対する反復呼び出しを測ります。型のロード、キャッシュしない探索、アプリ全体を測るものではありません。Microsoft の [.NET 8 性能分析](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/)は最適化と独自の測定を説明しており、その結果はこのプロジェクトの動作確認とは別です。

別のリフレクション処理については [UnsafeAccessor の比較](/ja/2023/11/net-8-performance-unsafeaccessor-vs-reflection/)を参照してください。
