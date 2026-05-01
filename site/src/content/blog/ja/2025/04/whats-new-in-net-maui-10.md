---
title: ".NET MAUI 10 の新機能"
description: "2025 年 11 月に .NET 10 および C# 14 とともにリリースされた .NET MAUI 10 の新機能、改善点、破壊的変更のまとめです。"
pubDate: 2025-04-11
updatedDate: 2026-01-08
tags:
  - "maui"
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2025/04/whats-new-in-net-maui-10"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET MAUI 10 は、2025 年 11 月に .NET 10 および C# 14 とともにリリースされました。  
  
.NET 10 は長期サポート (LTS) バージョンで、リリース日から 3 年間、2028 年 11 月まで無償のサポートとパッチが提供されます。詳しくは [.NET 10 の新機能](/2024/12/dotnet-10/) と [C# 14 の新機能](/2024/12/csharp-14/) を参照してください。

.NET MAUI 10 にはいくつかの新機能と改善点があります。

-   コントロールの改善
    -   `CollectionView` と `CarouselView` のパフォーマンスと安定性の改善
    -   `HybridWebView.InvokeJavaScriptAsync` のオーバーロード
    -   `SearchBar` の `SearchIconColor` プロパティ
    -   `Switch` の `OffColor` プロパティ
-   新しい `ShadowTypeConverter`
-   `SpeechOptions` の `Rate` プロパティ
-   XAML マークアップ拡張 `FontImageExtension`
-   iOS と Mac Catalyst
    -   新しい `AccessibilityExtensions`
    -   `MauiWebViewNavigationDelegate` のオーバーライド
    -   モーダルページをポップオーバーとして表示
-   Android
    -   Android 16 Baklava -- API 36 -- および JDK 21 のサポート
    -   `dotnet run` のサポート
    -   `AndroidEnableMarshalMethods` がデフォルトで有効化
    -   `@(AndroidMavenLibrary)` 項目の `ArtifactFilename` メタデータ
    -   Visual Studio のデザイン時ビルドが `aapt2` を呼び出さなくなった
    -   `generator` の出力が System.Reflection.Emit の使用の可能性を回避
    -   `ApplicationAttribute.ManageSpaceActivity` が `InvalidCastException` をスローしなくなった

.NET MAUI for .NET 10 における破壊的変更:

-   `TableView` は非推奨になりました。代わりに `CollectionView` を使用してください。
-   `MessagingCenter` は .NET 10 で internal になりました。代わりに [CommunityToolkit.Mvvm](https://www.nuget.org/packages/CommunityToolkit.Mvvm) の `WeakReferenceMessenger` を使用してください。
