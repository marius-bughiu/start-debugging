---
title: ".NET 11 Preview 5 で LINQ に FullJoin とセレクター不要の join が追加"
description: ".NET 11 Preview 5 は LINQ に全く新しい FullJoin 演算子を追加し、さらに Join、LeftJoin、RightJoin、GroupJoin に対して結果セレクターを完全に省けるタプルを返すオーバーロードを追加します。"
pubDate: 2026-06-12
tags:
  - "dotnet-11"
  - "csharp"
  - "linq"
  - "performance"
lang: "ja"
translationOf: "2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-12
---

[.NET 11 Preview 5 のライブラリ ノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/libraries.md)は、.NET 10 で始まったストーリーを締めくくります。あのリリースは LINQ に `LeftJoin` と `RightJoin` をもたらし、outer join を `GroupJoin` と `SelectMany` と `DefaultIfEmpty` で偽装する必要がなくなりました。Preview 5 は欠けていた 4 つ目の角である `FullJoin` を追加し、ついでにすべての join で最も煩わしい部分、つまり結果セレクターを修正します。

## 結果セレクターは常に定型コードでした

これまでの join の各オーバーロードは 4 つの引数を取りました。内側のシーケンス、外側のキー、内側のキー、そして一致したペアをどう結合するかを LINQ に伝える結果セレクターです。10 回のうち 9 回、そのセレクターは 2 つの項目を匿名型かタプルに貼り合わせるだけでした。

```csharp
var pairs = catalog.Join(
    sales,
    p => p.Sku,
    s => s.Sku,
    (product, sale) => (product, sale));

foreach (var (product, sale) in pairs)
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

この最後のラムダはロジックを一切持ちません。シグネチャを満たすためだけに存在します。Preview 5 は `Join`、`LeftJoin`、`RightJoin`、`GroupJoin` に対して、明白な形を推論してそれを省略できる、タプルを返すオーバーロードを追加します。

```csharp
foreach (var (product, sale) in catalog.Join(sales, p => p.Sku, s => s.Sku))
    Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
```

`Join` は今や `IEnumerable<(TOuter, TInner)>` を返します。`GroupJoin` は `IEnumerable<(TOuter, IEnumerable<TInner>)>` を返します。左と右のバリアントは、SQL がそうするのとまったく同じように、外側または内側を null 許容として返します。これらのオーバーロードは `Enumerable`、`Queryable`、`AsyncEnumerable` に存在するため、同じ呼び出しの形がインメモリのコレクション、EF Core のクエリツリー、非同期ストリームで機能します。

## FullJoin がセットを完成させる

本当に新しい演算子が `FullJoin` ([dotnet/runtime #127236](https://github.com/dotnet/runtime/pull/127236)) です。full outer join は両方のシーケンスからすべての要素を返し、キーが一致するものをペアにし、一致しないものには `null` の相手を残します。2 つのリストの突き合わせ、たとえば製品カタログと販売フィードの照合は、これまで 2 回のパスか手作りのディクショナリ検索を意味しました。今では 1 回の呼び出しです。

```csharp
foreach (var (product, sale) in catalog.FullJoin(sales, p => p.Sku, s => s.Sku))
{
    if (product is null)
        Console.WriteLine($"Sale for unknown SKU {sale!.Sku}");
    else if (sale is null)
        Console.WriteLine($"No sales for {product.Name}");
    else
        Console.WriteLine($"{product.Name}: sold {sale.Quantity}");
}
```

ここではどちらの側も欠けうるため、タプルの両側が null 許容です。そして C# の null 許容型の注釈が、両方のギャップを処理するようコンパイラーがあなたを促します。

## これに頼る前に知っておくべきこと

これらは LINQ のメソッド構文への追加のみです。`full join` というクエリのキーワードはなく、既存のクエリ式の形は手つかずのままです。EF Core のプロバイダーでは、`FullJoin` が `FULL OUTER JOIN` に変換されるか、クライアント評価にフォールバックするかは、プロバイダーが追いつくかどうかに依存します。そのため、データベースで実行されると仮定する前に、生成された SQL を確認してください。Preview 5 の他の部分と同様に、新しい [System.Text.Json の JSON Lines サポート](/ja/2026/06/system-text-json-json-lines-serialization-dotnet-11-preview-5/)を含め、シグネチャは 11 月の安定版リリースまでにまだ変わる可能性があります。しかし形は十分にきれいなので、今日から結果セレクターのラムダを削除し始められます。
