---
title: "Playwright .NET 1.64 で Locator.Within() が追加、その正体は逆順に読む Locator チェーンです"
description: "Microsoft.Playwright 1.64 で Locator.Within() が追加され、'このボタンを、あのダイアログの中で' と書けるようになりました。簡単な検証で、親ごとの Nth() の解決も含めて parent.Locator(child) とまったく同じロケーターを組み立てることを確認しました。"
pubDate: 2026-10-23
tags:
  - "dotnet"
  - "playwright"
  - "testing"
  - "csharp"
lang: "ja"
translationOf: "2026/10/playwright-dotnet-1-64-locator-within-is-locator-chaining-read-backwards"
translatedBy: "claude"
translationDate: 2026-10-23
---

[Microsoft.Playwright 1.64.0](https://github.com/microsoft/playwright-dotnet/releases/tag/v1.64.0) は 2026-10-21 に NuGet で公開され、翌日には同梱の Node.js を 24.22.1 に更新した 1.64.1 が続きました。このリリースには Chromium 156、Firefox 157、WebKit 27.2、WebMCP のテスト、VP9 のスクリーンキャストが含まれますが、多くのテストスイートが最初に触れる API は [`Locator.Within()`](https://playwright.dev/dotnet/docs/api/class-locator#locator-within) でしょう。

## 子が先、親が後

`Within(ILocator)` は、引数に一致する各要素の中で、現在のロケーターの要素に一致するロケーターを返します。ポイントは読む順序です。ロケーターがすでに 2 つあるなら、外側から内側へチェーンを組み立てる代わりに、"このボタンを、あのダイアログの中で" と書けるようになりました。

```csharp
var save = page.GetByRole(AriaRole.Button, new() { Name = "Save" });
var dialog = page.GetByTestId("settings-dialog");

// 1.64+
await save.Within(dialog).ClickAsync();

// Before 1.64
await dialog.Locator(save).ClickAsync();
```

`Nth()` や `First` のような相対ロケーターは親ごとに個別に解決されます。これによって列単位のクエリが機能します。

```csharp
var thirdColumn = page.GetByRole(AriaRole.Cell).Nth(2)
    .Within(page.GetByRole(AriaRole.Row));

await Expect(thirdColumn).ToHaveTextAsync(new[] { "Apple", "Banana", "Cherry" });
```

## 実際に何になるのか

両方の書き方を、.NET SDK 10.0.302 上の `Microsoft.Playwright` 1.64.1 と Chromium 156 で実行しました。3 行のテーブルと、"Save" ボタンが 2 つ (ダイアログ内に 1 つ、フォーム内に 1 つ) あるページを使っています。結果は次のとおりです。

| ロケーター | 一致 |
| --- | --- |
| `cells.Nth(2)` | `Apple` |
| `cells.Nth(2).Within(rows)` | `Apple, Banana, Cherry` |
| `rows.Locator(cells.Nth(2))` | `Apple, Banana, Cherry` |
| `rows.Locator("td").Nth(2)` | `Apple` |
| `save` | `Save, Save` |
| `save.Within(dialog)` | `Save` |

決め手は `ToString()` です。`cells.Nth(2).Within(rows)` は `GetByRole(AriaRole.Row).Locator(GetByRole(AriaRole.Cell).Nth(2))` を出力し、従来のチェーンと 1 文字も違いません。`Within()` は新しいマッチングエンジンではありません。既存の `Locator(ILocator)` オーバーロードの引数を入れ替えたもので、エラーメッセージや trace viewer のエントリにはチェーン形式が表示されます。

実務上の帰結は 2 つあります。

- **移行すべき動作変更はありません。** スイートですでに `parent.Locator(childLocator)` を使っているなら、親ごとの `Nth()` のセマンティクスは以前からありました。`Within()` への切り替えは純粋に読みやすさの問題で、特に子ロケーターを公開して呼び出し側にスコープを選ばせる page object で効果があります。
- **本当の落とし穴は、相変わらず `Nth()` の位置です。** `rows.Locator("td").Nth(2)` は平坦化された結果に `Nth(2)` を適用するので、セルが 1 つだけ返ります。親ごとに 1 つずつ一致させたいときは、`Nth()` を内側のロケーターに付けてください (`Within()` を使えば自然とそうなります)。

## 同じリリースの破壊的変更

1.64 では可視性も変わりました。それ自体が非表示の iframe (たとえば `visibility: hidden`) の中にある要素は、アクション、`IsVisibleAsync()`、`ToBeVisibleAsync()` で非表示として扱われるようになりました。テストが誤って非表示のフレーム越しにクリックしていた場合、今後は可視性の待機でタイムアウトします。アップグレード前に確認すべきなのは、`Within()` よりもこちらです。

アップグレード方法:

```bash
dotnet add package Microsoft.Playwright --version 1.64.1
pwsh bin/Debug/net10.0/playwright.ps1 install
```

なお、インストール手順は古い Playwright バージョンのブラウザービルドのうち未使用と判断したものを削除するため、古いバージョンを使う別のプロジェクトでは、そのプロジェクト側のインストールを再実行する必要があるかもしれません。エージェント主導の UI テストに Playwright を使っているなら、[コーディングエージェントがセレクターを改名したときの自己修復型 E2E テスト](/2026/09/self-healing-e2e-tests-when-a-coding-agent-renames-selectors/) のセレクター規律が、こうしたスコープ付きロケーターとよく合います。
