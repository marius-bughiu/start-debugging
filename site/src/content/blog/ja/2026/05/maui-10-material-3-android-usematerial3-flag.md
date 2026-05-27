---
title: ".NET MAUI 10 SR6 が Android の Material 3 を UseMaterial3 フラグ 1 つで完成"
description: "MAUI 10 SR6 (10.0.60) は Android 上で Button、Entry、SearchBar、DatePicker、Slider、ProgressBar、ImageButton、Switch、Shell にまで Material 3 テーマを拡張します。MSBuild プロパティ 1 つで有効化でき、カスタムレンダラーも styles.xml の編集も不要です。"
pubDate: 2026-05-27
tags:
  - "dotnet"
  - "maui"
  - "android"
  - "material-3"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/05/maui-10-material-3-android-usematerial3-flag"
translatedBy: "claude"
translationDate: 2026-05-27
---

Microsoft は 2026 年 5 月 26 日に発表された .NET MAUI 10 SR6 (10.0.60) で、[Android 向け .NET MAUI における Material 3 サポートの最後の大きな塊](https://devblogs.microsoft.com/dotnet/dotnet-maui-material-3/)を出荷しました。注目すべきは Material 3 がやってきたことではありません。オプトインがちょうど 1 つの MSBuild プロパティだけであり、チームがハンドラーのカスタマイズを完全に方程式の外に置いた点です。

.NET 11 のモバイル系の話を追っているなら、MAUI 自体も [.NET 11 Preview 4 で Android と iOS のランタイムを CoreCLR にデフォルト変更](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/)しています。一方で Material 3 は .NET MAUI 10 の機能であり、サポート対象のサービスリリースのケイデンスで今日提供されています。

## ロールアウトの切り分け方

Material 3 は一度に着地したわけではありません。機能は .NET MAUI 10 の 3 つのサービスリリースに分けて段階展開されました。

- **SR3 (10.0.30)**: 一握りのコントロールに対する Material 3 のベーススタイル。
- **SR4 (10.0.40)**: `CheckBox` が新しいテーマに対応。
- **SR6 (10.0.60)**: 大きなまとめ。`Button`、`Entry`、`SearchBar`、`DatePicker`、`Slider`、`ProgressBar`、`ImageButton`、`Switch`、そして `Shell` の完全なテーマ。

SR6 でサポートされる完全なセットは、`Entry`、`Editor`、`SearchBar`、`RadioButton`、`ProgressBar`、`Slider`、`Picker`、`TimePicker`、`DatePicker`、`CheckBox`、`Switch`、`ImageButton`、`Button`、`Label`、`ActivityIndicator`、`Image`、`Shell` を網羅します。

## オプトインはたった 1 つのプロパティ

オプトインの全体は `.csproj` の 1 つのプロパティだけです。

```xml
<PropertyGroup>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

これが表面積のすべてです。リビルドして Android デバイスまたはエミュレーターにデプロイすると、サポート対象のコントロールが自動的に Material 3 スタイルを取り込み始めます。ハンドラーのカスタマイズも、カスタムレンダラーも、`Resources/values/styles.xml` への手術も、`MainActivity` の変更も一切ありません。

このフラグを Android にだけ適用したい場合は、標準の MSBuild 条件を使います。

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-android'))">
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

## 明示的なスタイルが依然として優先される

チームは優先順位ルールをあなたが望むとおりに保ちました。XAML や C# で明示的に設定したものは Material 3 のデフォルトを上書きします。

```xml
<Button Text="Save"
        BackgroundColor="#0F62FE"
        TextColor="White" />
```

このボタンは IBM のブルーを維持します。Material 3 はあなたがまだ塗っていない場所だけを埋めます。カスタムハンドラーやレンダラーは影響を受けません。これは、特定のコントロールをすでに上書きしているデザインシステムを持っている場合に重要です。フラグを立てても、意図的にカスタマイズした箇所が黙って再スタイル化されることはありません。

## なぜ重要か

Android の見た目のギャップは、MAUI への最も古くからの不満の 1 つです。すぐ使えるコントロールは古く見え、修正には Android のテーマ XML に潜る必要があり、コントロール単位の回避策は次の Material リリースで Google が出してくるものから乖離しがちでした。SR リリースを跨いで Material 3 を追従する 1 つの MSBuild フラグは、まだ独自のデザインシステムを固めていないチームにとって、メンテナンス面の意味のある削減です。

既存の MAUI 10 アプリでの現実的な動き方: 10.0.60 に上げて、`UseMaterial3` を `true` にし、Android エミュレーターでアプリを起動して全画面を一通り確認することです。古いデフォルトを補うために手作業でスタイルを当てていた箇所は、いまや削除候補です。
