---
title: "SkiaSharp 4.0 Preview 1: 不変な SKPath、可変フォント、そして新しい共同メンテナー"
description: "SkiaSharp 4.0 Preview 1 が、Uno Platform を .NET チームと並ぶ共同メンテナーとして迎えて登場しました。SKPath は新しい SKPathBuilder の背後で不変になり、HarfBuzzSharp は OpenType 可変フォントの軸を完全に制御できるようになります。"
pubDate: 2026-04-29
tags:
  - "skiasharp"
  - "dotnet"
  - "maui"
  - "graphics"
  - "uno-platform"
lang: "ja"
translationOf: "2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer"
translatedBy: "claude"
translationDate: 2026-04-29
---

David Ortinau 氏は [2026 年 4 月 28 日に SkiaSharp 4.0 Preview 1 を発表しました](https://devblogs.microsoft.com/dotnet/welcome-to-skia-sharp-40-preview1/)。バージョンアップそのもの以上に重要なニュースが 2 つあります。Uno Platform が .NET チームと並ぶ正式な共同メンテナーになったこと、そして Skia エンジンが 1 つのリリースで何年分ものアップストリーム作業ぶん前進したことです。

## 共同メンテナンス体制となった SkiaSharp

このリリースまで、SkiaSharp の更新は Microsoft のペースで進んでおり、2024 年と 2025 年にはチームの注力先が他に移るにつれて目に見えて減速していました。Uno Platform を正式な共同メンテナーとして迎えることが重要なのは、Uno がすでに WebAssembly 向けに長く続く内部フォーク (`unoplatform/Uno.SkiaSharp`) を保持しており、そのフォークが今回のプレビューにおけるエンジン更新の大半 ([PR #3560](https://github.com/mono/SkiaSharp/pull/3560) と [#3702](https://github.com/mono/SkiaSharp/pull/3702)) のソースになっているからです。実際的な効果として、.NET MAUI のグラフィックス、Avalonia のコントロール、Uno アプリ、そして SkiaSharp を使うすべてのコンソールレンダラーが、Chromium に 1 年以上遅れていた Skia ではなく、最新の Skia の上で動くようになります。

Android API 36 のビルド修正、Linux 側のジェネレーターのツーリング、リフレッシュされた WebAssembly ギャラリーは、いずれも同じ貢献群から入ってきました。

## SKPath が不変になる

最大の API 変更は、`SKPath` が内部的に不変になったことです。慣れ親しんだ変更系メソッドは後方互換性のために残されますが、パスを構築する現代的な方法は新しい `SKPathBuilder` を通じて行います。

```csharp
using var builder = new SKPathBuilder();
builder.MoveTo(50, 0);
builder.LineTo(50, -50);
builder.LineTo(-30, -80);
builder.Close();

using SKPath path = builder.Detach();
canvas.DrawPath(path, paint);
```

`Detach()` は不変な結果を返します。基盤となる `SkPath` が構築後にもう変更されないため、ランタイムはパスのジオメトリをスレッド間で安全に共有・ハッシュ化・再利用できます。これはフレーム間で描画プリミティブをキャッシュするあらゆる UI フレームワークにとって重要です。`path.MoveTo(...)` を直接呼び出している既存のコードは引き続きコンパイル・実行できるので、MAUI や Xamarin.Forms のアプリは Preview 1 を採用するために何も変更する必要がありません。

## HarfBuzzSharp による可変フォント

もう 1 つの目玉となる追加は、OpenType 可変フォント軸の完全な制御です。HarfBuzzSharp は、フォントが宣言する軸 (ウェイト、幅、スラント、オプティカルサイズ、または任意のカスタム軸) を公開し、10 個の静的フォントファイルを出荷することなくタイプフェイスのバリアントを作成できるようになります。

```csharp
using var blob = SKData.Create("Inter.ttf");
using var typeface = SKTypeface.FromData(blob);

var variation = new SKFontVariation
{
    { "wght", 650 },
    { "wdth", 110 },
};

using var variant = typeface.CreateVariant(variation);
using var font = new SKFont(variant, size: 24);
canvas.DrawText("Hello, variable fonts", 0, 0, font, paint);
```

これまで呼び出し側は、軸の座標を設定するためにネイティブの HarfBuzz ハンドルまで降りていく必要がありました。Preview 1 では同じコントロールを SkiaSharp と HarfBuzzSharp の素直なマネージド API として公開しています。

## プレビューの取得

パッケージは `aka.ms/skiasharp-40-package` の背後で公開されています。プレビューは 3.x と同じプラットフォーム群 (`net8.0`、`net9.0`、`net10.0` に加えて通常のモバイル head) をターゲットにしており、チームは安定版 4.0 リリースで API サーフェスを固定する前にフィードバックを求めています。独自の Skia コントロールライブラリをメンテナンスしているなら、不変パスのセマンティクスを描画ループに対してテストし、キャッシュ後にパスを変更するものがあれば報告するための窓口がこのタイミングです。それこそが「3.x で動く」から「4.0 で `SKPathBuilder` が必要」になるまさにそのパターンです。

より深い解説については、Uno Platform が 6 月 30 日に Focus on SkiaSharp イベントを開催し、このリリースを支えたエンジニアによるセッションが行われます。
