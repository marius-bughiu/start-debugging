---
title: "LINQ CountBy で頻度カウントを最適化する"
description: ".NET 9 で GroupBy を CountBy に置き換え、よりクリーンで効率的な頻度カウントを実現します。中間のグルーピング構造を省くことで、割り当てを O(N) から O(K) に削減します。"
pubDate: 2026-01-01
tags:
  - "dotnet"
  - "dotnet-9"
lang: "ja"
translationOf: "2026/01/optimizing-frequency-counting-with-linq-countby"
translatedBy: "claude"
translationDate: 2026-05-01
---
データ処理で最も一般的な操作のひとつが、コレクション内の要素の出現頻度を計算することです。長年、C# 開発者はこれを実現するために `GroupBy` パターンに頼ってきました。機能的ではあるものの、カウント直後に破棄されるグループのためにバケットオブジェクトを割り当ててしまい、不要なオーバーヘッドを生むことがよくあります。

.NET 9 では System.Linq 名前空間に `CountBy` が導入され、この処理を大幅に効率化します。

## レガシーなオーバーヘッド

.NET 9 以前は、出現回数のカウントには通常、冗長な LINQ 呼び出しの連鎖が必要でした。要素をグループ化したうえで、キーと件数を含む新しい型に射影しなければなりませんでした。

```cs
// Before: Verbose and allocates group buckets
var logLevels = new[] { "INFO", "ERROR", "INFO", "WARN", "ERROR", "INFO" };

var frequency = logLevels
    .GroupBy(level => level)
    .Select(group => new { Level = group.Key, Count = group.Count() })
    .ToDictionary(x => x.Level, x => x.Count);
```

このアプローチは動作しますが、重たいです。`GroupBy` のイテレーターは、件数だけが必要なケースでも各グループの要素を保持するために内部データ構造を構築します。データ量が大きいと、これがガベージコレクションに不要な負荷をかけます。

## CountBy で簡素化

.NET 9 は `CountBy` を `IEnumerable<T>` に直接追加します。このメソッドは `KeyValuePair<TKey, int>` のコレクションを返すため、中間のグルーピング構造を必要としません。

```cs
// After: Clean, intent-revealing, and efficient
var logLevels = new[] { "INFO", "ERROR", "INFO", "WARN", "ERROR", "INFO" };

foreach (var (level, count) in logLevels.CountBy(level => level))
{
    Console.WriteLine($"{level}: {count}");
}
```

構文がよりクリーンになっただけでなく、意図が明示的になっています。私たちはキーごとにカウントしているのです。

## パフォーマンスへの影響

内部的に `CountBy` は、`GroupBy` が必要とするグルーピングのバケットを割り当てないように最適化されています。従来の `GroupBy` のシナリオでは、ランタイムは一意のキーごとに `Grouping<TKey, TElement>` オブジェクトを生成し、そのキーに属する要素のコレクションを内部で保持することが多くあります。100 万件の要素と 100 個の一意キーがあると、`GroupBy` はそれら 100 万件をリストに整理する大きな処理をすることになります。

`CountBy` はカウンターだけ追跡すればよく、実質的に `Dictionary<TKey, int>` のアキュムレーターのように振る舞います。ソースを 1 度だけ走査し、キーに対応するカウンターをインクリメントし、要素自体は破棄します。これにより、要素を保持するという意味で O(N) の空間操作が、一意キー数を K として O(K) 空間に近づきます。

サーバーログの解析、トランザクションストリームの処理、センサーデータの集計のような高スループットのシナリオでは、この差は無視できません。重い "バケット" オブジェクトを直ちに捨てることで、GC への圧力が下がります。

### エッジケースとキー

`GroupBy` と同様、`CountBy` も特に指定がなければキー型のデフォルト等価比較子に依存します。カスタムオブジェクトをキーにする場合は、`GetHashCode` と `Equals` が正しくオーバーライドされていることを確認するか、独自の `IEqualityComparer<TKey>` を渡してください。

```cs
// Handling case-insensitivity explicitly
var frequency = logLevels.CountBy(level => level, StringComparer.OrdinalIgnoreCase);
```

### GroupBy を使い続けるべきとき

`CountBy` は厳密にカウント専用です。実際の要素が必要 (たとえば「最初の 5 件のエラーをくれ」) な場合は、引き続き `GroupBy` が必要です。しかしヒストグラム、頻度マップ、アナリティクス用途では、.NET 9 の `CountBy` のほうが優れたツールです。

`CountBy` を採用することで、冗長さを減らし、LINQ パイプラインの割り当てパターンを改善できます。モダンな C# コードベースで頻度分析を行うときの既定の選択肢になるでしょう。
