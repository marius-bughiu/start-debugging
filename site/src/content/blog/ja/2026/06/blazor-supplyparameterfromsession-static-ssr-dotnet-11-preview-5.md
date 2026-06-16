---
title: ".NET 11 Preview 5 で Blazor static SSR に [SupplyParameterFromSession] が追加"
description: "静的サーバーレンダリングの Blazor でセッション状態を読むには、HttpContext.Session にアクセスして手動でシリアライズする必要がありました。.NET 11 Preview 5 は [SupplyParameterFromSession] を追加し、コンポーネントのプロパティをセッションキーに直接バインドします。"
pubDate: 2026-06-16
tags:
  - "blazor"
  - "dotnet-11"
  - "aspnetcore"
  - "ssr"
  - "csharp"
lang: "ja"
translationOf: "2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5"
translatedBy: "claude"
translationDate: 2026-06-16
---

2026-06-09 にリリースされた [.NET 11 Preview 5](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/) は、Blazor の静的サーバーサイドレンダリング (static SSR) がクエリ文字列とフォームデータについてすでに持っていた「supply parameter from X」属性のファミリーを完成させます。新しいものは `[SupplyParameterFromSession]` で、コンポーネントのプロパティを ASP.NET Core のサーバーセッション内のキーにバインドします。複数ステップのウィザードの状態を static SSR のページ読み込みをまたいで運んだことがあるなら、これがなぜ重要かが分かるでしょう。

## なぜセッションが厄介だったのか

Static SSR は SignalR の circuit も WebAssembly のペイロードもない素の HTML をレンダリングするため、ナビゲーションを生き延びるメモリ内のコンポーネント状態はありません。Blazor はすでに、リクエストごとの明白な 2 つの入力に型付きで宣言的なアクセスを提供していました。URL 用の `[SupplyParameterFromQuery]` と POST ボディ用の `[SupplyParameterFromForm]` です。セッションが欠けていた部分でした。それを読むには、`HttpContext` をコンポーネントにカスケードし、自分で `HttpContext.Session` を通り、両側で手動のキー文字列と手動のシリアライズを行っていました。

```csharp
@inject IHttpContextAccessor Http

@code {
    private int CurrentStep;

    protected override void OnInitialized()
    {
        var raw = Http.HttpContext?.Session.GetString("checkout-step");
        CurrentStep = raw is null ? 0 : JsonSerializer.Deserialize<int>(raw);
    }
}
```

セッションに触れるすべてのコンポーネントがこの儀式を繰り返し、キー文字列はずれを待つだけの文字列ベースの契約でした。

## この属性が置き換えるもの

Preview 5 は読み取りをプロパティ宣言に折りたたみます。属性はセッションキー用の `Name` を取り、`System.Text.Json` を使って値をシリアライズおよびデシリアライズするため、文字列だけでなく JSON で往復できる任意の型で機能します。

```csharp
@code {
    [SupplyParameterFromSession(Name = "checkout-step")]
    public int CurrentStep { get; set; }
}
```

フレームワークはセッションから `checkout-step` を読み取り、`int` にデシリアライズして、コンポーネントがレンダリングされる前に代入します。プロパティに代入し直すと新しい値がセッションに書き込まれるため、ウィザードは取得・変更・シリアライズ・書き込みのダンスではなく 1 行でステップを進められます。

配管は ASP.NET Core 標準のセッション ミドルウェアなので、引き続き `Program.cs` で設定します。

```csharp
builder.Services.AddDistributedMemoryCache();
builder.Services.AddSession();

// ...
app.UseSession();
```

## どこに収まるか

これは Preview 5 における static SSR の複数の改善パスの 1 つです。同じリリースで登場した [static SSR フォーム向けのクライアントサイド検証](/ja/2026/06/blazor-static-ssr-client-side-validation-dotnet-11-preview-5/)と自然に組み合わさります。フォームの作業状態をセッションキーにバインドし、ブラウザーで検証し、チェックアウトフロー全体を通して安価なレンダリングモードを保てます。QuickGrid の並べ替えとページネーションも static SSR で動作するようになり、「インタラクティブな感触、circuit ゼロ」というパターンは広がり続けています。

試すには、.NET 11 Preview 5 SDK をインストールし、`net11.0` をターゲットにして、完全な一覧については [ASP.NET Core Preview 5 のリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview5/aspnetcore.md)を確認してください。
