---
title: "SkiaSharp 4.0 が安定版に：GPU レンダリングが 24% 高速化し、API も整理"
description: "SkiaSharp 4.148.0 は v4 の最初の安定版リリースです。GPU 負荷の高い UI は最大 24% 高速にレンダリングされ、CPU シェーダーは約 6 倍高速に動作し、レガシーな API 表面がついに廃止されます。アップグレードに実際どれだけかかるかを解説します。"
pubDate: 2026-07-01
tags:
  - "skiasharp"
  - "dotnet"
  - "graphics"
  - "maui"
  - "performance"
lang: "ja"
translationOf: "2026/07/skiasharp-4-0-stable-release-faster-gpu-rendering"
translatedBy: "claude"
translationDate: 2026-07-01
---

Matthew Leibowitz は [2026 年 6 月 29 日に SkiaSharp 4.0 の最初の安定版リリースを発表しました](https://devblogs.microsoft.com/dotnet/skiasharp-4-0-stable/)。NuGet パッケージ `SkiaSharp 4.148.0` として公開されています。これは v4 のすべてのプレビューを、本番環境に投入できる 1 つのパッケージにまとめたリリースです。API が固まるのを待ってプレビュー（[SkiaSharp 4.0 Preview 1](/ja/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/) で扱いました）を見送っていたなら、API はいま固まりました。

## パフォーマンス向上は本物です

見出しは機能ではなく、数字です。ハードウェアアクセラレーションされた GPU バックエンドでは、最新のアプリ UI を占める処理（浮き上がったカード、ドロップシャドウ、重なったサーフェス）が、以前の安定版リリースよりも最大 24% 高速にレンダリングされます。Microsoft 自身の数値は、Windows 11 上の .NET 10 で OpenGL を使って測定したもので、影付きカードのダッシュボードは 65 から 80 FPS に上がり、スクロールするアクティビティフィードは 47 から 58 FPS になりました。

CPU バウンドな処理はさらに大きく向上しました。テクスチャや霧の効果に使うような手続き的な Perlin ノイズシェーダーは、約 6 倍高速に動作します。カスタム描画に SkiaSharp を頼っている MAUI、Avalonia、Uno のアプリにとって、これはホットパスのコードを変更せずにフレーム予算を無償で改善できるものです。

## 4.148.0 が実際に提供するもの

安定版 API に 3 つの具体的な追加が入ります。

- SkiaSharp と HarfBuzzSharp にまたがる OpenType 可変フォントの完全な軸制御。ネイティブの HarfBuzz ハンドルまで降りる代わりに、マネージドコードから `wght`、`wdth`、任意のカスタム軸を設定できます。
- 絵文字やアイコンフォント向けのカラーパレット。
- アニメーション WebP のエンコード。

可変フォントの経路は、多くのアプリが最初に手を伸ばすものです。

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
canvas.DrawText("One font file, every weight", 0, 0, font, paint);
```

## 発表が控えめに述べている部分

「よりクリーンで正確な API」は丁寧な言い回しです。実務的に訳すと、v4 は長い移行を完了し、レガシーな API 表面が廃止されます。コードがまだ 3.x の非推奨メンバーを呼び出している場合、あるいは可変な `SKPath` モデルに対してカスタムコントロールライブラリを構築していた場合、それが分かるのはコンパイル時です。プレビューで導入された不変の `SKPath` と `SKPathBuilder` のパターンがいまや既定となったため、キャッシュしたパスを変更していた描画ループはすべて builder へ移行する必要があります。

ほとんどの利用者にとって、アップグレードは 1 行の変更です。

```xml
<PackageReference Include="SkiaSharp" Version="4.148.0" />
```

これをブランチで行い、ビルドして、リリースノートを読む前に警告を読んでください。ビルドが緑なら、あなたはすでにクリーンだったということです。赤なら、それは書き直しではなく、廃止された呼び出しの短く機械的なリストです。いずれにせよ、その FPS は午後を費やす価値があります。

詳細は [GitHub の SkiaSharp 4.148.0 リリース](https://github.com/mono/SkiaSharp/releases) にあります。
