---
title: "Blazor SSR が .NET 11 でついに TempData を獲得"
description: ".NET 11 Preview 2 の ASP.NET Core が Blazor の静的サーバーサイドレンダリングに TempData をもたらし、回避策なしで flash メッセージと Post-Redirect-Get フローを可能にします。"
pubDate: 2026-04-13
tags:
  - "blazor"
  - "aspnet-core"
  - "dotnet-11"
  - "ssr"
lang: "ja"
translationOf: "2026/04/blazor-ssr-tempdata-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-25
---

Blazor の静的 SSR アプリを構築したことがあるなら、ほぼ確実に同じ壁にぶつかったでしょう。リダイレクトするフォーム POST の後、次のページに 1 回限りのメッセージを渡す組み込みの方法がありません。MVC と Razor Pages は 10 年以上 `TempData` を持っていました。Blazor SSR にはなかったのです、[.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) まで。

## Blazor SSR で TempData がどう動作するか

`Program.cs` で `AddRazorComponents()` を呼び出すと、TempData は自動的に登録されます。追加のサービス配線はありません。任意の静的 SSR コンポーネント内で、カスケードパラメータとして取得します。

```csharp
@code {
    [CascadingParameter]
    public ITempData? TempData { get; set; }

    private void HandleSubmit()
    {
        // Store a flash message before redirecting
        TempData?.Set("StatusMessage", "Record saved.");
        Navigation.NavigateTo("/dashboard", forceLoad: true);
    }
}
```

ターゲットページで値を読み取ります。`Get` を呼び出すと、エントリはストアから削除されます。

```csharp
@code {
    [CascadingParameter]
    public ITempData? TempData { get; set; }

    private string? StatusMessage;

    protected override void OnInitialized()
    {
        StatusMessage = TempData?.Get<string>("StatusMessage");
    }
}
```

これが古典的な Post-Redirect-Get パターンで、カスタムステート管理なしで Blazor SSR で動作するようになりました。

## Peek と Keep

`ITempData` は MVC の TempData ライフサイクルを反映する 4 つのメソッドを提供します。

- `Get<T>(key)` は値を読み、削除のためにマークします。
- `Peek<T>(key)` はマークせずに読むので、値は次のリクエストまで生き残ります。
- `Keep()` はすべての値を保持します。
- `Keep(key)` は特定の値を保持します。

これらは flash メッセージが 1 回の読み取り後に消えるか、2 度目のリダイレクトまで残るかを制御します。

## ストレージプロバイダー

デフォルトでは、TempData は `CookieTempDataProvider` を介して cookie ベースです。値は ASP.NET Core Data Protection で暗号化されるため、改ざん保護が標準で得られます。サーバーサイドストレージを好む場合は `SessionStorageTempDataProvider` に交換します。

```csharp
builder.Services.AddSession();
builder.Services
    .AddSingleton<ITempDataProvider, SessionStorageTempDataProvider>();
```

## 落とし穴: 静的 SSR のみ

TempData はインタラクティブな Blazor Server や Blazor WebAssembly のレンダリングモードでは動作しません。それは静的 SSR にスコープされており、各ナビゲーションは完全な HTTP リクエストです。インタラクティブなシナリオでは、`PersistentComponentState` または独自のカスケード状態が依然として正しいツールです。

これは小さな追加ですが、よくある「なぜ Blazor は Razor Pages にできることができないのか?」という不満の 1 つを取り除きます。[.NET 11 Preview 2](https://dotnet.microsoft.com/download/dotnet/11.0) を入手して、次の SSR フォームフローで試してみてください。
