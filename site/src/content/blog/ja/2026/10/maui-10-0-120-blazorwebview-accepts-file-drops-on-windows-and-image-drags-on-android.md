---
title: "MAUI 10.0.120: BlazorWebView がついに Windows でのファイルドロップと Android での画像ドラッグに対応"
description: ".NET MAUI 10.0.120 は Windows の BlazorWebView で AllowDrop を有効にし、Android では AndroidX の DropDataContentProvider を登録します。これにより Blazor Hybrid のドロップゾーンがプラットフォーム固有のコードなしで動作します。変更内容、新しい MauiEnableAndroidWebViewDragDrop スイッチ、MAUI1002 警告を解説します。"
pubDate: 2026-10-22
tags:
  - "maui"
  - "blazor"
  - "blazor-hybrid"
  - "dotnet"
lang: "ja"
translationOf: "2026/10/maui-10-0-120-blazorwebview-accepts-file-drops-on-windows-and-image-drags-on-android"
translatedBy: "claude"
translationDate: 2026-10-22
---

[.NET MAUI 10.0.120](https://github.com/dotnet/maui/releases/tag/10.0.120) が 2026年10月21日 にリリースされました。コミット数は 213 です。大半は修正ですが、BlazorWebView に関する 2 つの変更によって、"drop your files here" ボックスを持つすべての Blazor Hybrid アプリが .NET 6 以来抱えてきた回避策が不要になります。Windows ではエクスプローラーから `BlazorWebView` にファイルをドラッグすると HTML のドロップ先に届くようになり、Android では `BlazorWebView` 内で画像をドラッグすると実際のドラッグデータが生成されるようになりました。

## Windows: AllowDrop がデフォルトで有効に

これまで Windows ハンドラーは、WinUI の `WebView2` を `AllowDrop` を `false` のまま作成していました。アプリの外部から来たファイルに対して DOM に `drop` イベントが届かないため、ブラウザーでは動く Blazor のドロップゾーンが、デスクトップ版では何も起きませんでした。よくある対処法は、カスタムのハンドラーマッピングでした。[PR #37904](https://github.com/dotnet/maui/pull/37904) は `BlazorWebViewHandler.CreatePlatformView` を次のように変更します。

```csharp
protected override WebView2Control CreatePlatformView()
{
    return new WebView2Control
    {
        AllowDrop = true,
    };
}
```

つまり、ドロップ領域全体に広げた通常の `InputFile` が、プラットフォーム固有のコードなしで Windows でも動作します。

```razor
<div class="dropzone">
    <InputFile OnChange="OnFilesDropped" multiple />
    <p>Drop files here</p>
</div>

@code {
    async Task OnFilesDropped(InputFileChangeEventArgs e)
    {
        foreach (var file in e.GetMultipleFiles(maxAllowedFiles: 10))
        {
            await using var stream = file.OpenReadStream(maxAllowedSize: 20 * 1024 * 1024);
            // save or process the stream
        }
    }
}
```

自分で `AllowDrop = true` を設定するマッパーを書いていた場合は、アップグレード後に削除できます。1 つ制限が残っています。MAUI が現在依存している Windows App SDK 1.8 では、Windows 上のページ内要素や画像のネイティブなドラッグは依然として動作しません。PR の作者が Windows App SDK 2.0.1 を試したところ、`AllowDrop` を有効にすればそれらのシナリオも動作し始めたとのことで、この設定はその移行に向けた下地にもなります。

## Android: DropDataContentProvider が自動的に登録される

Android では、`BlazorWebView` 内で `<img>` をドラッグすると DOM のドラッグイベントは発火するものの、使える画像データは含まれていませんでした。Android WebView には、マニフェストで宣言された AndroidX WebKit の `DropDataContentProvider` が必要です。[PR #37975](https://github.com/dotnet/maui/pull/37975) では、`Microsoft.AspNetCore.Components.WebView.Maui` が Android ターゲットで `Xamarin.AndroidX.WebKit` 1.16.0.1 に依存するようになり、`AndroidManifestOverlay` を通じてこのプロバイダーがマニフェストにマージされます。

```xml
<provider
  android:name="androidx.webkit.DropDataContentProvider"
  android:authorities="${applicationId}.DropDataProvider"
  android:exported="false"
  android:grantUriPermissions="true" />
```

アプリがすでに同じプロバイダーを宣言している場合は、2 つのエントリが 1 つにマージされます。異なる構成で宣言している場合は、自動登録をオフにしてください。

```xml
<PropertyGroup>
  <MauiEnableAndroidWebViewDragDrop>false</MauiEnableAndroidWebViewDragDrop>
</PropertyGroup>
```

このプロパティが制御するのはマニフェストのエントリだけです。`Xamarin.AndroidX.WebKit` のパッケージ参照は、どちらの場合も残ります。

## MAUI1002 に注意

`<AndroidManifestMerger>legacy</AndroidManifestMerger>` を設定したままのプロジェクトでは、警告 `MAUI1002` が表示されるようになります。レガシーのマージャーは `AndroidManifestOverlay` 項目を無視するため、プロバイダーがマニフェストに追加されないからです。`manifestmerger.jar` (デフォルト) に切り替えるか、`MauiEnableAndroidWebViewDragDrop` を `false` に設定して `Platforms/Android/AndroidManifest.xml` に自分でプロバイダーを宣言してください。警告をエラーとして扱ってビルドしている場合、10.0.120 で CI を壊しうるのはこの 1 行です。

## アップグレード

`Microsoft.Maui.Controls` と `Microsoft.AspNetCore.Components.WebView.Maui` を `10.0.120` に更新してください。どちらもすでに NuGet で公開されています。このリリースでは、[10.0.110 の記事](/ja/2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter/)で取り上げたリーク対策も引き続き行われており、iOS で `Shell` 内のページに `DisconnectHandlers()` が届かなかった `BlazorWebView` のリークも含まれています。
