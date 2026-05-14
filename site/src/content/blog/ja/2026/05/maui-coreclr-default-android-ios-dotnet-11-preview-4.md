---
title: ".NET 11 Preview 4 で MAUI が Android、iOS、Mac Catalyst のデフォルトで CoreCLR に切り替わる"
description: ".NET 11 Preview 4 では、Android、iOS、Mac Catalyst、tvOS 上の MAUI のデフォルトのランタイムが CoreCLR になります。Mono は依然として MSBuild プロパティ 1 つで使えます。変わるもの、壊れるもの、そして無効化する方法を解説します。"
pubDate: 2026-05-14
tags:
  - "dotnet-11"
  - "maui"
  - "coreclr"
  - "mono"
  - "runtime"
lang: "ja"
translationOf: "2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-14
---

Microsoft は 2026 年 5 月 13 日にリリースした [.NET 11 Preview 4 で MAUI のデフォルトランタイムを CoreCLR に切り替えました](https://devblogs.microsoft.com/dotnet/dotnet-maui-moves-to-coreclr-in-dotnet-11/)。Android、iOS、Mac Catalyst、tvOS をターゲットとする新しい MAUI プロジェクトは、デスクトップで ASP.NET Core やコンソールアプリを動かしているのと同じランタイム上で動作するようになります。モバイルにおいて Mono はもはや暗黙の選択肢ではありません。これは Xamarin の統合以降で MAUI における最大級の単一アーキテクチャ変更であり、デフォルトフラグの背後に静かに着地します。

.NET 11 のモバイル関連の話題を追っているなら、この変更は[同じプレビューで `dotnet watch` が Android と iOS の MAUI に到達したこと](/ja/2026/05/dotnet-watch-maui-android-ios-net-11-preview-4/)の上に積み重なります。

## なぜ電話の上の CoreCLR が重要なのか

約 10 年間、Xamarin そして MAUI はモバイルで Mono の上で動いていました。これは CoreCLR に ARM モバイルターゲット向けの動作する AOT のストーリーがなかったためです。Mono は独自の AOT コンパイラー、GC、JIT、プロファイラー、デバッガーを提供していました。Microsoft が CoreCLR に行ったすべてのツール投資 (階層型コンパイル、動的 PGO、Server GC のリージョンエンジン、ReadyToRun) は、モバイルでは再実装されるか、スキップされる必要がありました。

CoreCLR への切り替えはそれを解消します。モバイルの MAUI は、ASP.NET Core を実行する Linux コンテナーと同じ JIT、GC、診断のサーフェスを得ます。Microsoft の起動時間の数値は、ReadyToRun と PGO を使ったベースラインのテンプレートでは肯定的です。しかしアナウンスは Android 上のより大きなアプリでの回帰について率直であり、無料の勝利を仮定する前に実機の Release モードで計測するようチームに求めています。

これが重要なもう一つの理由は、Android 上の CoreCLR が MAUI 向けの NativeAOT を解放することです。投稿はこれを「自然な次のステップ」と呼んでいます。

## デフォルトでオフになるもの

モバイル上の CoreCLR は、Mono が抱えていたいくつかのプラットフォームを切り捨てます:

- Android x86 はなくなりました。
- Android API 23 以下はなくなりました。
- Android の embedding API (大半の Xamarin.Android ライブラリの作者が使ってきたパス) はなくなりました。
- Android arm32 は「まだ検討中」です。
- Blazor WebAssembly は影響を受けません。CoreCLR には WebAssembly ターゲットがないため、WASM は Mono に残ります。

アプリまたは推移的な NuGet 依存が embedding API や x86 向けの配布バイナリに依存している場合、アップグレードはビルド時もしくはロード時に失敗し、本番環境のランタイムでは失敗しません。

## オプトアウト

1 つの MSBuild プロパティで、影響を受ける target framework を Mono に戻せます:

```xml
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <UseMonoRuntime>true</UseMonoRuntime>
</PropertyGroup>
```

すべてのプラットフォームを戻したい場合は `Condition` を外してください。これは一時的な脱出口として扱ってください。Microsoft はモバイル MAUI 向けの Mono を .NET 11 のライフサイクルを超えて出荷し続けると約束していません。アナウンスはこのプロパティを、長期的な構成オプションとしてではなく、回帰 issue を提出している間にリリースをアンブロックするための手段として位置づけています。

## 今週実際にやるべきこと

プレビュー段階のうちにやっておく価値のあることが 3 つあります:

1. .NET 11 Preview 4 でビルドし、切り捨てられたプラットフォームに起因する失敗をチェックします。
2. 代表的なローエンドの Android 端末で Release ビルドを実行し、コールドスタート、ウォームスタート、APK サイズを .NET 10 で同じアプリをビルドした場合と比較します。コミュニティのレポートには勝利と回帰の両方が含まれているため、汎用的な数値ではあなたのアプリは予測できません。
3. 何年も触られていない Xamarin.Android ライブラリに依存している場合、それが embedding API を使っているかを確認してください。使っているなら、それは CoreCLR でロードされず、GA の列車が出る前に置き換えが必要になります。

これは、ベンチマークでは良く見えても、推移的な依存が Mono のみだと判明したときに 6 か月後に静かに本番を壊すタイプの変更です。プレビュー期間中に学んでおく方がよいでしょう。
