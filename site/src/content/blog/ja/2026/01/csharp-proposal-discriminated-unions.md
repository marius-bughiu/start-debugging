---
title: "C# プロポーザル: 判別共用体"
description: "C# の判別共用体プロポーザルを概観します。union キーワード、網羅的なパターンマッチング、そしてこれが OneOf ライブラリやクラス階層をどう置き換えうるかを取り上げます。"
pubDate: 2026-01-02
updatedDate: 2026-01-04
tags:
  - "csharp"
  - "csharp-proposals"
lang: "ja"
translationOf: "2026/01/csharp-proposal-discriminated-unions"
translatedBy: "claude"
translationDate: 2026-05-01
---
C# 機能の "聖杯" は何年も議論されてきました。`OneOf` のようなサードパーティライブラリや冗長なクラス階層に頼ってきた長い年月の後、ついに将来のバージョンの C# で **判別共用体 (Discriminated Unions, DUs)** がネイティブにサポートされそうです。

## 問題: "いずれか" を表現する

ある関数で、汎用の `Success` 結果 _または_ 特定の `Error` を返したいとき、選択肢はどれもよくありませんでした。

1.  **例外を投げる** (制御フローとしてはコストが高い)。
2.  **`object` を返す** (型安全性が失われる)。
3.  **クラス階層を使う** (冗長で、他の継承者も許してしまう)。

## 解決策: `union` 型

このプロポーザルでは `union` キーワードが導入され、コンパイラがすべての可能なケースを把握している閉じた型階層を定義できるようになります。

```cs
// Define a union
public union Result<T>
{
    Success(T Value),
    Error(string Message, int Code)
}
```

これは内部的に高度に最適化された構造体レイアウトを生成し、Rust の enum の動作に似ています。

## 網羅的なパターンマッチング

DUs の真の力は、それらを利用するときに発揮されます。switch 式は **網羅的** でなければなりません。ケースを忘れるとコードはコンパイルされません。

```cs
public string HandleResult(Result<int> result) => result switch
{
    Result.Success(var val) => $"Got value: {val}",
    Result.Error(var msg, _) => $"Failed: {msg}",
    // Compiler Error: No default case needed, but all cases must be covered!
};
```

## なぜ重要なのか

採用されれば、この機能は .NET におけるエラー処理を根本から変えるでしょう。クラス割り当てによるランタイムオーバーヘッドや複雑な visitor パターンによる認知的負荷なしに、ドメインの状態 (たとえば `Loading`, `Loaded`, `Error`) を正確にモデル化できるようになります。
