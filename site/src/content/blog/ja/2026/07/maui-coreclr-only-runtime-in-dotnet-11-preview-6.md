---
title: ".NET 11 Preview 6 でモバイルの MAUI は CoreCLR のみに: Mono の非常口が消えた"
description: ".NET 11 Preview 6 は Android、iOS、Mac Catalyst 向け MAUI から独立した Mono パスを削除します。CoreCLR が唯一のモバイルランタイムになり、UseMonoRuntime という非常口は閉じられ、GA は 2026 年 11 月に予定されています。"
pubDate: 2026-07-19
tags:
  - "dotnet-11"
  - "maui"
  - "coreclr"
  - "mono"
  - "runtime"
lang: "ja"
translationOf: "2026/07/maui-coreclr-only-runtime-in-dotnet-11-preview-6"
translatedBy: "claude"
translationDate: 2026-07-19
---

2 か月前、[MAUI は .NET 11 Preview 4 でデフォルトのモバイルランタイムを CoreCLR に切り替え](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/)、リリースノートは非常口を用意していました。`<UseMonoRuntime>true</UseMonoRuntime>` を設定すれば、Android、iOS、Mac Catalyst のビルドは以前のランタイムに戻りました。その非常口が閉じられようとしています。[CoreCLR Progress and the Mono Timeline for .NET MAUI](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/) の中で、David Ortinau は、.NET 11 Preview 6（2026-07-10 公開）以降、CoreCLR が MAUI のモバイルアプリに提供される唯一のランタイムであると確認しています。Microsoft は「Android、iOS、Mac Catalyst 向けに独立した Mono パスをもう提供していません」と述べています。

## デフォルトから唯一へ

この区別は重要です。Preview 4 では CoreCLR がデフォルトで、Mono はプロパティを 1 つ変えるだけの距離にあり、リグレッションを報告する間の一時的な回避策として明確に位置づけられていました。Preview 6 はモバイルにおけるこの 2 つのランタイムという姿勢を取り除きます。MAUI のモバイルヘッド向けにサポートされる Mono の target はもう存在せず、それらを元に戻していたオプトアウトのプロパティも話の一部ではなくなりました。あなたのプロジェクトや推移的な依存関係が CoreCLR のリグレッションを回避するために `UseMonoRuntime` に頼っていた場合、その計画は GA ではなく今、期限切れになります。

Blazor WebAssembly は影響を受けません。CoreCLR には Wasm の target がないため、WebAssembly は引き続き Mono 上で動作し、それは変わりません。

```xml
<!-- Preview 4: still an option -->
<PropertyGroup Condition="'$(TargetFramework)' == 'net11.0-android'">
  <UseMonoRuntime>true</UseMonoRuntime>
</PropertyGroup>

<!-- Preview 6: no separate Mono path for MAUI mobile -->
```

## 数字はどこに落ち着いたか

Preview 4 の発表で誠実だった部分は、より大きな Android アプリでのリグレッションを認めた点でした。Preview 6 はより落ち着いて読めます。Ortinau は、iOS と Mac Catalyst は全体として Mono 上のときより速く、Android は起動時間とアプリサイズの両方で今や Mono のおよそ 10% 以内に収まっていると報告しています。これは十分に近く、ASP.NET Core と同じ JIT、GC、診断を共有するランタイムの統一が、議論するトレードオフではなく、その上に構築する土台になり始める程度です。また、モバイルが独立したランタイムに乗っている間は決して不可能だった MAUI 向け NativeAOT を、次のステップとしてテーブルに残します。

## 11 月までに何をテストするか

GA は 2026 年 11 月であり、preview の期間はまさに、あなたのフィードバックに基づいて優先順位がまだ変わりうるタイミングです。具体的には:

- Preview 6 でアプリをビルドし、ロードされることを確認してください。CoreCLR が .NET 11 サイクルの早い段階で切り捨てたプラットフォーム（Android x86、API 23 以下、古い Xamarin.Android の embedding API）は、本番で静かにではなく、ビルド時またはロード時に失敗します。
- 代表的なローエンドの Android 端末で Release ビルドを実行し、コールドスタート、ウォームスタート、パッケージサイズを .NET 10 と比較してください。10% という数字は Microsoft の集計であり、あなたの依存関係グラフについての約束ではありません。
- 長い間触れられていない Xamarin.Android ライブラリを監査してください。embedding API を使っている場合は CoreCLR 上でロードされないため、GA の列車が出発する前に置き換えをキューに入れておく必要があります。

11 月に MAUI を出荷するランタイムは今決まります。Preview 6 は、あなたのアプリがそれに同意するかどうかを確かめる最後の快適な瞬間です。完全な進捗レポートとタイムラインは [.NET Blog](https://devblogs.microsoft.com/dotnet/coreclr-progress-and-mono-timeline-dotnet-maui/) にあります。
