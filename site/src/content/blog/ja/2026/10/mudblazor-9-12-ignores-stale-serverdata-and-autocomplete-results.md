---
title: "MudBlazor 9.12: 遅い ServerData と Autocomplete の検索が新しい結果を上書きしなくなりました"
description: "MudBlazor 9.12.0 は、MudAutocomplete、MudDataGrid、MudTable に長年あった競合状態を修正します。これまでは最後に開始した検索ではなく、最後に完了した検索の結果が採用されていました。修正の仕組みと、ServerData や SearchFunc のコードに生じる変更点を紹介します。"
pubDate: 2026-10-29
tags:
  - "blazor"
  - "mudblazor"
  - "aspnet-core"
  - "dotnet"
  - "async"
lang: "ja"
translationOf: "2026/10/mudblazor-9-12-ignores-stale-serverdata-and-autocomplete-results"
translatedBy: "claude"
translationDate: 2026-10-29
---

[MudBlazor 9.12.0](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0) が 2026年10月29日にリリースされました。アップグレードする価値のある変更は、[issue #3722](https://github.com/MudBlazor/MudBlazor/issues/3722) 以来、形を変えながら未解決のままだった競合状態の修正です。`MudAutocomplete`、`ServerData` を使う `MudDataGrid`、`ServerData` を使う `MudTable` はいずれも、ユーザーが最後に *開始した* リクエストではなく、最後に *完了した* リクエストの結果を保持していました。

## 範囲の広い検索が勝ってしまう理由

オートコンプリートに "App" と入力し、デバウンス時間を超えて待ってから "le Pie" と続けて入力したとします。この時点で 2 つの検索が実行中です。短いクエリのほうが一致する行が多いため、たいていはこちらが遅くなります。9.11 以前では、先に "Apple Pie" の結果が表示され、その後に "App" の結果が届いて置き換えてしまいます。ユーザーには、テキストボックスの内容と一致しない一覧が表示されることになります。

グリッドのフィルターやページングでも同じことが起きていました。フィルターを素早く 2 回変更すると、古くて遅い `ServerData` の呼び出しが、新しいページを上書きすることがありました。

## 9.12 が古い結果を判定する方法

[PR #13944](https://github.com/MudBlazor/MudBlazor/pull/13944) では 2 つの異なる方式を使っています。`MudAutocomplete` では、各検索にバージョン番号を割り当てます。新しい検索に置き換えられた検索は、アイテム、返されたアイテム数、ポップオーバーに触れる前に処理を打ち切ります。

```csharp
var searchVersion = ++_searchVersion;
// ... await SearchFunc(text, token) ...
if (searchVersion != _searchVersion)
{
    return;
}
```

このチェックは 2 回実行され、2 回目は `ReturnedItemsCountChanged` の後に行われます。ハンドラー側で処理を中断している間に、新しい検索が完了する可能性があるためです。これは重要な点です。多くの `SearchFunc` の実装は `CancellationToken` を完全に無視しているため、キャンセルだけではこの問題を解決できませんでした。

`MudDataGrid` は、すでに `ServerData` に渡しているトークンを利用します。新しい読み込みによってキャンセルされた場合、古い読み込みは、例外を投げたとしてもデータの代入や `Loading` の解除を行わずに戻ります。

```csharp
catch (Exception) when (token.IsCancellationRequested)
{
    // A newer load cancelled this one, and it owns the data and the loading state.
    return;
}
```

例外の型を意図的に無視しているのは、データソースがキャンセルされたリクエストを独自の失敗として報告することが多いためです (`HttpRequestException` や、プロバイダー固有の `DbException` など)。[PR #14053](https://github.com/MudBlazor/MudBlazor/pull/14053) は同じルールを `MudTable` にも適用します。その後の修正では、ページのリセット中もローディングインジケーターを維持することや、すでに閉じられた、選択済みの、またはクリアされたオートコンプリートのメニューを、遅れて届いた検索が再び開かないようにすることも行われています。

## コードに生じる変更点

PR では、2 つの動作変更が明記されています。

- 新しい検索に置き換えられたオートコンプリートの検索は、`ReturnedItemsCountChanged` を発生させなくなります。
- 新しい読み込みに置き換えられても、`ReloadServerData()` は例外をスローしなくなります。

`TaskCanceledException` を握りつぶすために `ReloadServerData()` を `try/catch` で囲んでいた場合、そのコードは不要になります。ただし、トークンは引き続き渡すようにしてください。実際に停止するキャンセル済みリクエストのほうが、MudBlazor が黙って破棄するリクエストよりもコストが低いためです。

```csharp
private async Task<GridData<Order>> LoadOrders(GridState<Order> state, CancellationToken ct)
{
    var page = await Http.GetFromJsonAsync<PagedResult<Order>>(
        $"api/orders?page={state.Page}&size={state.PageSize}", ct);
    return new GridData<Order> { Items = page!.Items, TotalItems = page.Total };
}
```

`VirtualizeServerData` のパスはこの修正の対象外です。仮想化された各リクエストにはすでに専用のトークンがあるためです。

## 9.12.0 のその他のアップグレード時の注意点

`MudDataGrid` の列挙型の列に、`Value` がコレクションになる "is any of" フィルターが追加されました。そのため、演算子で分岐する `ServerData` ハンドラーでは、新しい case を追加するか、`Column.FilterOperators` で非表示にする必要があります。また、`MudStep.Title` や `MudDatePicker.MinDate` などをコンポーネント参照経由で読み取ると、アナライザー診断 `MUD0012` が発生するようになりました。代わりに `GetState(x => x.Title)` を使用してください。折れ線グラフの null ポイントや `MudText.Truncate` を含む全項目は、[リリースノート](https://github.com/MudBlazor/MudBlazor/releases/tag/v9.12.0)で確認できます。

```bash
dotnet add package MudBlazor --version 9.12.0
```
