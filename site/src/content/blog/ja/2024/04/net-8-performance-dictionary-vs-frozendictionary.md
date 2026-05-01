---
title: ".NET 8 ToFrozenDictionary: Dictionary と FrozenDictionary の比較"
description: ".NET 8 の `ToFrozenDictionary()` を使って Dictionary を FrozenDictionary に変換し、読み取りを高速化します。ベンチマーク、使いどころ、ビルド時のトレードオフを解説します。"
pubDate: 2024-04-27
updatedDate: 2025-03-27
tags:
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2024/04/net-8-performance-dictionary-vs-frozendictionary"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET 8 では、読み取り操作のパフォーマンスを向上させる新しい辞書型が導入されました。ただし、コレクションを作成した後はキーや値を一切変更できないという制約があります。この型は、最初の利用時に値を埋めて、その後は長時間動作するサービスの間ずっと保持しておくようなコレクションに特に適しています。

これが数値的にどういう意味を持つか見てみましょう。私が知りたいのは次の 2 点です。

-   辞書の作成パフォーマンス（読み取り最適化のための処理がここに影響する可能性が高いため）
-   リスト内のランダムなキーに対する読み取りパフォーマンス

## 作成時のパフォーマンスへの影響

このテストでは、事前にインスタンス化した `KeyValuePair<string, string>` を 10,000 個用意し、3 種類の辞書を作成します。

-   通常の辞書: `new Dictionary(source)`
-   フリーズされた辞書: `source.ToFrozenDictionary(optimizeForReading: false)`
-   読み取り最適化されたフリーズ辞書: `source.ToFrozenDictionary(optimizeForReading: true)`

そして、それぞれの操作にかかる時間を BenchmarkDotNet で計測します。結果は以下の通りです。

```plaintext
|                              Method |       Mean |    Error |   StdDev |
|------------------------------------ |-----------:|---------:|---------:|
|                          Dictionary |   284.2 us |  1.26 us |  1.05 us |
|        FrozenDictionaryNotOptimized |   486.0 us |  4.71 us |  4.41 us |
| FrozenDictionaryOptimizedForReading | 4,583.7 us | 13.98 us | 12.39 us |
```

最適化なしの段階でも、`FrozenDictionary` の作成には通常の辞書の作成のおよそ 2 倍の時間がかかることが分かります。しかし本当のインパクトは、データを読み取り用に最適化したときに現れます。このシナリオでは `16x` の増加となります。それだけの価値はあるのでしょうか。読み取りはどれくらい速いのでしょうか。

## フリーズ辞書の読み取りパフォーマンス

辞書の '中央' から 1 つのキーを取得する最初のシナリオでは、次のような結果になります。

```plaintext
|                              Method |      Mean |     Error |    StdDev |
|------------------------------------ |----------:|----------:|----------:|
|                          Dictionary | 11.609 ns | 0.0170 ns | 0.0142 ns |
|        FrozenDictionaryNotOptimized | 10.203 ns | 0.0218 ns | 0.0193 ns |
| FrozenDictionaryOptimizedForReading |  4.789 ns | 0.0121 ns | 0.0113 ns |
```

要するに、`FrozenDictionary` は通常の `Dictionary` より `2.4x` ほど速いようです。かなりの改善です。

ここで重要なのは、単位が異なる点です。作成側はマイクロ秒単位で、合計でおよそ 4299 us（マイクロ秒）失っています。これを ns（ナノ秒）に換算すると 4,299,000 ns になります。つまり、`FrozenDictionary` を使うことでパフォーマンス上の利益を得るには、少なくとも 630,351 回の読み取り操作を行う必要があります。かなりの読み取り回数です。

さらにいくつかのテストシナリオで、パフォーマンスへの影響を見てみましょう。

### シナリオ 2: 小さな辞書 (100 件)

小さい辞書を扱う場合でも、倍率はほぼ同じようです。コスト対効果の観点からは、4800 回ほどの読み取りで利益が出始めるようで、少しだけ早くなります。

```plaintext
|                                     Method |      Mean |     Error |    StdDev |
|------------------------------------------- |----------:|----------:|----------:|
|                          Dictionary_Create |  1.477 us | 0.0033 us | 0.0028 us |
| FrozenDictionaryOptimizedForReading_Create | 31.922 us | 0.1346 us | 0.1259 us |
|                            Dictionary_Read | 10.788 ns | 0.0156 ns | 0.0122 ns |
|   FrozenDictionaryOptimizedForReading_Read |  4.444 ns | 0.0155 ns | 0.0129 ns |
```

### シナリオ 3: 異なる位置のキーを読み取る

このシナリオでは、取得するキー（内部データ構造内での位置）によってパフォーマンスが影響を受けるかどうかをテストします。結果から見るに、読み取りパフォーマンスにはまったく影響がありません。

```plaintext
|                                     Method |      Mean |     Error |    StdDev |
|------------------------------------------- |----------:|----------:|----------:|
|  FrozenDictionaryOptimizedForReading_First |  4.314 ns | 0.0102 ns | 0.0085 ns |
| FrozenDictionaryOptimizedForReading_Middle |  4.311 ns | 0.0079 ns | 0.0066 ns |
|   FrozenDictionaryOptimizedForReading_Last |  4.314 ns | 0.0180 ns | 0.0159 ns |
```

### シナリオ 4: 大きな辞書 (1,000 万件)

大きな辞書の場合でも、読み取りパフォーマンスはほぼ変わりません。辞書サイズが `1000x` になっているにもかかわらず、読み取り時間の増加は 18% です。一方、純粋なパフォーマンス上の利益を得るために必要な目標読み取り回数は大きく増えて 2,135,735,439 回、つまり 20 億回を超える読み取りになります。

```plaintext
|                                     Method |        Mean |     Error |    StdDev |
|------------------------------------------- |------------:|----------:|----------:|
|                          Dictionary_Create |    905.1 ms |   2.56 ms |   2.27 ms |
| FrozenDictionaryOptimizedForReading_Create | 13,886.4 ms | 276.22 ms | 483.77 ms |
|                            Dictionary_Read |   11.203 ns | 0.2601 ns | 0.3472 ns |
|   FrozenDictionaryOptimizedForReading_Read |    5.125 ns | 0.0295 ns | 0.0230 ns |
```

### シナリオ 5: 複雑なキー

ここの結果は非常に興味深いものです。私たちのキーは次のような形をしています。

```cs
public class MyKey
{
    public string K1 { get; set; }

    public string K2 { get; set; }
}
```

ご覧のとおり、このケースでは通常の `Dictionary` と比べて読み取りのパフォーマンス改善はほとんどなく、辞書の作成は約 4 倍遅くなっています。

```plaintext
|                                     Method |     Mean |     Error |    StdDev |
|------------------------------------------- |---------:|----------:|----------:|
|                          Dictionary_Create | 247.7 us |   3.27 us |   3.05 us |
| FrozenDictionaryOptimizedForReading_Create | 991.2 us |   8.75 us |   8.18 us |
|                            Dictionary_Read | 6.344 ns | 0.0602 ns | 0.0533 ns |
|   FrozenDictionaryOptimizedForReading_Read | 6.041 ns | 0.0954 ns | 0.0845 ns |
```

### シナリオ 6: record を使う

では、`class` の代わりに `record` を使うとどうでしょうか。もっと高速になるはずですよね。どうやらそうではないようです。さらに奇妙なことに、読み取り時間は `6 ns` から `44 ns` に跳ね上がります。

```plaintext
|                                     Method |       Mean |    Error |   StdDev |
|------------------------------------------- |-----------:|---------:|---------:|
|                          Dictionary_Create |   654.1 us |  2.29 us |  2.14 us |
| FrozenDictionaryOptimizedForReading_Create | 1,761.4 us |  8.67 us |  8.11 us |
|                            Dictionary_Read |   45.37 ns | 0.088 ns | 0.082 ns |
|   FrozenDictionaryOptimizedForReading_Read |   44.44 ns | 0.120 ns | 0.107 ns |
```

## まとめ

テストしたシナリオに基づくと、改善が見られたのは `string` キーを使ったときだけでした。これまで試した他のケースは、いずれも通常の `Dictionary` と同じ読み取りパフォーマンスにとどまり、その上で作成時のオーバーヘッドが追加で乗っています。

`FrozenDictionary` のキーに `string` を使う場合でも、その辞書のライフタイムでどれだけ読み取りを行うのかを考慮する必要があります。なぜなら作成にはオーバーヘッドが伴うからです。10,000 件のテストでは、そのオーバーヘッドはおよそ 4,299,000 ns でした。読み取りパフォーマンスは `11.6 ns` から `4.8 ns` への低下で `2.4x` の改善が得られましたが、それでも辞書に対しておおよそ 630,351 回の読み取り操作を行ってはじめて純粋なパフォーマンス上の利益が出る計算になります。
