---
title: ".NET 8 の性能: UnsafeAccessor とリフレクション"
description: "観測可能な処理で UnsafeAccessor、リフレクション、キャッシュしたリフレクションとデリゲート、直接呼び出しを比較する .NET 8 ベンチマーク。"
pubDate: 2023-11-01
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/11/net-8-performance-unsafeaccessor-vs-reflection"
translatedBy: "claude"
translationDate: 2026-05-01
---
`UnsafeAccessor` は、リフレクションによる検索や `MethodInfo.Invoke` を使わずに既知のメンバーへ結び付きます。有用な比較には、結果を観測できる処理と、各呼び出し経路が行う仕事の説明が必要です。

**2026年11月2日訂正:** 以前のソースリポジトリは利用できません。機能確認、割り当て診断、キャッシュしたデリゲート、インライン化しない同等の対象メソッドを持つ例を復元しました。以前のゼロに近い時間は一律のオーバーヘッドゼロを証明せず、再現可能な測定値としては掲載しません。

## ダウンロードと実行

[ベンチマークのソースをダウンロード](/examples/unsafe-accessor-benchmarks.zip)できます。.NET 8 を対象に、BenchmarkDotNet 0.15.8 を固定しています。

```sh
dotnet run -c Release -- --verify
dotnet run -c Release -- --job Dry --filter '*'
dotnet run -c Release -- --filter '*'
```

最初のコマンドは、5つの経路すべてで入力 `42` に対して `59` が返ることを確認します。2つ目は1回の反復による実行確認です。通常の測定には最後のコマンドを使い、時間を解釈する前に生成された環境情報とレポートを保存してください。

## 比較するもの

1. **直接呼び出し:** public メソッドを呼びます。
2. **Unsafe accessor:** 同じ処理を行う private メソッドに結び付きます。
3. **リフレクションの検索と呼び出し:** 操作ごとにメソッドを検索して実行します。
4. **キャッシュしたリフレクション:** `MethodInfo` を再利用しますが、引数の object 配列は渡します。
5. **キャッシュしたデリゲート:** private メソッド用のオープンインスタンスデリゲートを再利用します。

2つの対象メソッドは入力とインスタンスフィールドの和を返し、`MethodImplOptions.NoInlining` を指定しています。各ベンチマークも結果を返します。入力は BenchmarkDotNet のパラメーターなので、定数を返すだけのインライン化されたメソッドに例が縮退することを避けます。

`MemoryDiagnoser` は、リフレクション側の引数配列や boxing を含む割り当てを報告します。経路ごとの処理内容は異なるため、時間差をアクセス制御の検査だけに帰属させられません。

## 検証と解釈

復元したプロジェクトは macOS arm64 の .NET 8.0.33 で実行し、機能確認と5つすべての BenchmarkDotNet Dry ジョブに成功しました。Dry の時間は性能表として公開しません。測定の仕組みが実行できることの確認であり、安定したナノ秒単位の推定ではないためです。

インライン化、ランタイム版、アーキテクチャ、対象処理、キャッシュ、割り当てはすべて結果に影響します。極端に短い値は、JIT が処理を除去したか、測定が有効な分解能を下回った可能性もあります。すべての accessor 操作が無料という証拠ではありません。

accessor はシグネチャをコンパイル時に知る必要もあります。型やメンバーを実行時に発見する場合にはリフレクションが引き続き役立ちます。[メンバーアクセス例](/ja/2023/10/unsafe-accessor/)と [Microsoft の API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.unsafeaccessorattribute)で違いを確認してください。
