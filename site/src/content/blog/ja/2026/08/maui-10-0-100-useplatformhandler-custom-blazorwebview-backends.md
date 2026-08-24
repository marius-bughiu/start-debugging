---
title: ".NET MAUI 10.0.100 がカスタム BlazorWebView バックエンド向けに UsePlatformHandler を追加"
description: "MAUI 10.0.100 で MauiBlazorWebViewBuilderExtensions.UsePlatformHandler が導入されました。AddMauiBlazorWebView() が登録するものをすべて作り直すことなく BlazorWebViewHandler を差し替えられる正式な拡張ポイントです。2 つのオーバーロードと、1 つの呼び出し順序の落とし穴を解説します。"
pubDate: 2026-08-24
tags:
  - "dotnet"
  - "maui"
  - "blazor"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/08/maui-10-0-100-useplatformhandler-custom-blazorwebview-backends"
translatedBy: "claude"
translationDate: 2026-08-24
---

.NET MAUI 10.0.100 は [2026-08-20 にリリースされ](https://github.com/dotnet/maui/releases/tag/10.0.100)、209 件のコミットを含んでいます。その大半はサービスリリースらしい内容です。`CollectionView` のスクロール回帰、Android の Shell フライアウトにおけるセーフエリアのインセット、非表示にしても消えてくれない iOS の `ActivityIndicator` などです。しかしこのリストには、本当に新しいパブリック API が 1 つ紛れ込んでいます。それが `MauiBlazorWebViewBuilderExtensions.UsePlatformHandler` で、Blazor Hybrid の登場以来ずっと行き詰まっていた種類のプロジェクトを解放するものです。

## AddMauiBlazorWebView() がカスタムプラットフォームにとって行き止まりだった理由

`AddMauiBlazorWebView()` は 2 つの仕事をします。すべての BlazorWebView が必要とする共通の下回り (JSInterop、ナビゲーション、静的アセットの解決) を登録し、さらに `IBlazorWebView` のハンドラーとして `BlazorWebViewHandler` をハードコードします。

問題は 2 つ目の仕事でした。MAUI がハンドラーを提供していないプラットフォーム向けのバックエンドを作る場合、動機となった例は Linux 向けの GTK レンダラーですが、組み込みのハンドラーはそのまま使えず、しかも差し替えるための拡張ポイントがありませんでした。[issue #34103](https://github.com/dotnet/maui/issues/34103) には、開発者が落ち着いた回避策が書かれています。`AddMauiBlazorWebView()` を完全に飛ばし、内部サービスをすべて手作業で登録し直し、上流でその登録内容が変わるたびに追随するというものです。

## 新しい拡張ポイント

[PR #34225](https://github.com/dotnet/maui/pull/34225) は `IMauiBlazorWebViewBuilder` に 2 つの拡張メソッドを追加します。

```csharp
public static IMauiBlazorWebViewBuilder UsePlatformHandler<THandler>(
    this IMauiBlazorWebViewBuilder builder)
    where THandler : IViewHandler, new();

public static IMauiBlazorWebViewBuilder UsePlatformHandler(
    this IMauiBlazorWebViewBuilder builder,
    Func<IServiceProvider, IViewHandler> factory);
```

`MauiProgram.cs` では、これまでの回避策がチェーン 1 回分にまで縮みます。

```csharp
builder.Services
    .AddMauiBlazorWebView()
    .UsePlatformHandler<GtkBlazorWebViewHandler>();
```

`AddMauiBlazorWebView()` が登録する内容はそのまま残り、変わるのはハンドラーだけです。内部的にこのメソッドは `ConfigureMauiHandlers(h => h.AddHandler<IBlazorWebView, THandler>())` に転送しており、これは組み込みの登録が書き込むのと同じハンドラーコレクションです。

ジェネリック制約に注目してください。`where THandler : IViewHandler, new()` です。型パラメーターにはさらに `[DynamicallyAccessedMembers(DynamicallyAccessedMemberTypes.PublicConstructors)]` が付いており、トリミングされたビルドや NativeAOT ビルドでトリマーがパラメーターなしコンストラクターを黙って削除せず保持するようになっています。コンストラクター引数が必要なハンドラーは、ファクトリー版のオーバーロードを使います。

## 呼び出し順序が鋭い落とし穴

差し替えは最後の登録が勝つ方式であり、これは両刃です。`UsePlatformHandler` は `AddMauiBlazorWebView()` の後に呼ぶ必要があり、そうでなければ何も起こりません。さらに厄介なのは、下流のライブラリが起動パイプラインの後ろの方で `AddMauiBlazorWebView()` を再び呼ぶと、その 2 回目の呼び出しが既定のハンドラーを再登録し、エラーも警告もないまま自分のバックエンドが消えてしまう点です。MAUI Blazor の構成を複数のソースから組み立てる場合は、`UsePlatformHandler` を最後に呼んでください。

ファクトリー版のオーバーロードには、知っておく価値のある 2 つ目の落とし穴があります。渡される `IServiceProvider` は MAUI のハンドラーファクトリーのプロバイダーであり、アプリケーションのルートプロバイダーではありません。`ConfigureMauiHandlers` 経由で登録されたサービスしか解決できないため、アプリケーションレベルのシングルトンをそこから取得しようとすると失敗します。

どちらのオーバーロードも `Microsoft.AspNetCore.Components.WebView.Maui` 10.0.90 には存在せず、10.0.100 に存在します。つまり静かにバックポートされたものではなく、10.0.100 での純粋な新規追加です。.NET MAUI 10 のサービスリリースの流れを追っているなら、[Android の Material 3 対応は SR6 で完了しています](/ja/2026/05/maui-10-material-3-android-usematerial3-flag/)。
