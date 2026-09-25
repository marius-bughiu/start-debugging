---
title: "Refit 16.1はページングループを自動生成: PagedEnumerable、[Paged]、[PageToken]"
description: "Refit 16.1.0では、インターフェースのメソッドがPagedEnumerable<TPage, TItem>を返せるようになり、ソースジェネレーターがカーソル、オフセット、レスポンスヘッダー、次へのリンクに対応したページ単位のリクエストループを生成します。宣言方法、列挙の挙動、メンバー名のタイプミスで発生するRF013ビルドエラーについて解説します。"
pubDate: 2026-09-25
tags:
  - "refit"
  - "httpclient"
  - "dotnet"
  - "csharp"
  - "source-generators"
lang: "ja"
translationOf: "2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable"
translatedBy: "claude"
translationDate: 2026-09-25
---

[Refit 16.1.0](https://github.com/reactiveui/refit/releases/tag/v16.1.0)は2026年9月21日にリリースされ、その目玉機能は、ほとんどのRefitユーザーが書いたことのある定型コード、つまりリストエンドポイントを囲む`while (cursor != null)`ループを取り除くものです。Refitのメソッドは`PagedEnumerable<TPage, TItem>`を返せるようになり、ソースジェネレーターがページごとに1回リクエストを送るループを書いてくれます。この設計は[PR #2332](https://github.com/reactiveui/refit/pull/2332)にあります。

## ページングメソッドを宣言する

ページの形は2つの属性で表します。`[Paged]`は継続トークンを保持するメンバーの名前を指定し、`[PageToken]`はそれを送り返すパラメーターに付けます。

```csharp
public interface IOrdersApi
{
    [Get("/orders")]
    [Paged(Next = nameof(OrderPage.NextCursor))]
    PagedEnumerable<OrderPage, Order> ListOrders(
        [AliasAs("limit")] int pageSize,
        [PageToken] string? cursor = null);
}

public sealed class OrderPage
{
    public List<Order> Items { get; set; } = [];
    public string? NextCursor { get; set; }
}
```

ここで`Items`は省略可能です。ページ型に該当アイテム型のシーケンスがちょうど1つだけある場合、ジェネレーターがそれを自動的に選びます。`NextCursor`がnullまたは空になるとシーケンスは終了します。トークンパラメーターは他のパラメーターと同様にバインドされるため、`[Header]`や`[Query]`を付ければクエリ文字列以外の場所に移動できます。

呼び出す側は普通に`await foreach`を書くだけで、リクエストはアイテムを消費するタイミングでしか送信されません。3件ずつ7件の注文を返すフェイクハンドラーに対してこれを実行してみました。

```csharp
await foreach (var order in api.ListOrders(pageSize: 3))
    Console.WriteLine(order.Id);

// Requests sent:
//   /orders?limit=3
//   /orders?limit=3&cursor=3
//   /orders?limit=3&cursor=6
```

途中で列挙を止めればリクエストも止まります。.NET 10で`await api.ListOrders(3).FirstAsync(o => o.Id == 2)`を実行したところ、リクエストはちょうど1回でした。

## ページ、上限、プリフェッチ

`PagedEnumerable<TPage, TItem>`は`IAsyncEnumerable<TItem>`に、いくつかの追加メンバーを加えたものです。

- `AsPages()`は、アイテムに加えて`IsTruncated`や合計件数が必要な場合に、ページオブジェクト自体を返します。
- `WithMaxPages(n)`は、1回の列挙で送信できるリクエスト数の上限を設定します。
- `WithPrefetch()`は、現在のページを処理している間に次のページをリクエストします。
- `ToObservable()`と`ToPageObservable()`は、Rxで利用する場合向けです。

```csharp
await foreach (var page in api.ListOrders(3).WithMaxPages(2).AsPages())
    Console.WriteLine($"{page.Items.Count} items, next={page.NextCursor}");
```

## ヘッダー、オフセット、次へのリンク

`[Paged]`は他のページングスタイルにも対応しています。

- `NextHeader = "x-ms-continuation"`は、レスポンスヘッダーから継続トークンを読み取ります（Cosmos DBのスタイル）。ページ型は`ApiResponse<T>`である必要があります。
- `NextHeader = "Link"`は`rel="next"`のリレーションを読み取ります。これはGitHubのページングの方式です。
- `Total = nameof(Result.Total)`は、Jiraのようなオフセットページングに切り替え、`int`型のトークンを使います。
- `Next`をGraphの`@odata.nextLink`のような絶対URLに向けると、リンクをたどるようになります。

リンクをたどるにはセキュリティ上の制約があります。`Origins = ["https://api.github.com"]`、`SameOrigin = true`、`AnyOrigin = true`のいずれかで、リンクが指してよいオリジンを明示しなければなりません。それ以外のオリジンへのリンクはリクエストされることなく`InvalidOperationException`をスローするため、悪意あるサーバーが指定したホストに`Authorization`ヘッダーが転送されることはありません。

## ミスがあればビルドが失敗する

メンバー名はコンパイル時に直接のプロパティアクセスへと解決され、リフレクションは使われません。タイプミスがあると`RF013`エラーになります。

```text
error RF013: Method 'ListOrders' cannot be generated as a paged method:
'NextCusor' is not a readable public or internal property or field of 'OrderPage'.
```

また、ページングメソッドはジェネリックにしたり、独自の`CancellationToken`を宣言したりすることもできません。トークンは列挙処理側から渡されるためです。リフレクションベースのリクエストビルダーはページング戻り値を拒否するため、この機能はソース生成されたクライアントでのみ動作します。ジェネレーターがインラインで生成できないページングメソッドは`RF007`として報告されます。

Refitと自前実装の型付きクライアントを比較検討しているなら、[HttpClient vs HttpClientFactory vs Refit: .NET 11 ではどれを使うべきか](/ja/2026/05/httpclient-vs-httpclientfactory-vs-refit/)を参照してください。ページングは、自前実装のクライアントが制御性で勝っていた部分の一つでした。Refitは今やそのループを代わりに生成してくれるようになり、ページの形が間違っていればビルドエラーで教えてくれます。
