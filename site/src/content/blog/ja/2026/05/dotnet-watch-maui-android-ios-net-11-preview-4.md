---
title: ".NET 11 Preview 4 で dotnet watch がついに MAUI の Android と iOS に対応"
description: ".NET 11 Preview 4 では Android 実機、Android エミュレーター、iOS シミュレーターで dotnet watch が有効になります。編集して保存するだけで、手動のリビルドなしに実行中のアプリが更新されます。iOS には csproj の落とし穴が 1 つあります。"
pubDate: 2026-05-13
tags:
  - "dotnet-11"
  - "maui"
  - "dotnet-watch"
  - "hot-reload"
  - "mobile"
lang: "ja"
translationOf: "2026/05/dotnet-watch-maui-android-ios-net-11-preview-4"
translatedBy: "claude"
translationDate: 2026-05-13
---

Microsoft は [2026 年 5 月 12 日に .NET 11 Preview 4 をリリースしました](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/)。MAUI 開発者にとって、changelog では小さく見える項目ですが、日々の作業では非常に大きな変化です。`dotnet watch` が Android 実機、Android エミュレーター、iOS シミュレーターで Hot Reload を駆動するようになりました。これまでのプレビューでは、XAML 以外のものは「編集 → リビルド → 再デプロイ」のサイクルが MAUI のモバイル開発の現実でした。Preview 4 はそのギャップを埋めます。

## 実際のワークフロー

MAUI アプリを開き、target framework とデバイスを選んで、次のように実行します。

```bash
dotnet watch --framework net11.0-android
```

iOS でも同じ形で、iOS シミュレーターのターゲットを指定します。

```bash
dotnet watch --framework net11.0-ios
```

`dotnet watch` はアプリを一度デプロイし、その後はファイル変更イベントを Hot Reload のデルタに変換して、実行中のプロセスにプッシュします。C# のメソッド本体、XAML、CSS のいずれもこの経路を通ります。セッション中に新しい `PackageReference` や `ProjectReference` を追加することも .NET 11 では機能します。Roslyn が変更を検証し、`ReferenceCopyLocalPathsOutputGroup` ターゲットが新しいアセンブリを出力ディレクトリにコピーし、プロセス内のデルタアプライアーが `AssemblyResolving` イベント経由でロードします。再起動は不要です。

## iOS で知っておくべき落とし穴

ピンで留めておくべき既知の問題が 1 つあります。[MAUI Preview 4 のリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/dotnetmaui.md) によると、`MtouchLink` を無効化しない限り iOS プロジェクトで `dotnet watch` は動作しません。`.csproj` の iOS `PropertyGroup` に次を追加してください。

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-ios'))">
  <MtouchLink>None</MtouchLink>
</PropertyGroup>
```

これは iOS の Debug ビルドでマネージドリンカーを無効化します。開発のインナーループ用としては問題ありませんが、Release 構成では避けたい設定です。条件は iOS TFM と Debug に絞り込むか、プラットフォーム構成を分けている場合は `Debug|iPhoneSimulator` 条件に移してください。

Preview 4 が iOS パスにもたらしたその他の修正にも触れておきます。シミュレーターとのコンソール入力の競合は解決され、Hot Reload セッションを終了させていた WebSocket 例外もなくなり、高速な編集でアプリを固まらせていたデッドロックも解消されました。これらは、watch が形式上は起動しても以前のプレビューを iOS 上で使い物にならなくしていたバグです。

## なぜこれが見た目以上に重要なのか

MAUI のフィードバックループは、Xamarin のベテランや Flutter 寄りの開発者が距離を置いてきた最大の理由として挙げられてきました。C# を編集するたびに 30 秒のリビルドが入ると、UI の探索的な作業は成立しません。デスクトップターゲット (Windows、Mac Catalyst) 向けの `dotnet watch` は以前からありましたが、MAUI の命運を握るのはモバイルです。Preview 4 でようやく、MAUI のモバイルインナーループは `flutter run` の hot reload と同じ土俵に立ちました。

サイドブランチで .NET 11 のプレビューを追っているなら、実プロジェクトで実際に使えるのがこのバージョンです。これまで待っていたなら、[Preview 4 をダウンロード](https://dotnet.microsoft.com/download/dotnet/11.0) して、初回の `dotnet watch` の前に iOS の `.csproj` を更新してください。
