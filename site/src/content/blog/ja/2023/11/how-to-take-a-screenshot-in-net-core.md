---
title: ".NET で Windows デスクトップのスクリーンショットを撮る"
description: "Windows 専用の実行可能な .NET コンソール例。仮想画面の範囲を取得し、描画リソースを破棄して PNG を保存します。"
pubDate: 2023-11-04
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2023/11/how-to-take-a-screenshot-in-net-core"
translatedBy: "claude"
translationDate: 2026-05-01
---
この例は Windows Forms と `System.Drawing` を使い、現在の Windows デスクトップセッションにおける仮想画面全体の外接矩形をキャプチャします。コンソールプログラムでも、Windows アプリケーションである点は変わりません。

**2026年11月2日訂正:** 失われたソースを、完全なプロジェクト設定、リソースの破棄、出力先フォルダーの処理、合成画像によるセルフテストとともに復元しました。macOS から Windows 向けにビルドしましたが、今回の検証で Windows の実画面キャプチャは実行していません。

## ダウンロードとプロジェクト設定

[実行可能なソースをダウンロード](/examples/windows-screenshot.zip)できます。プロジェクトファイルは次の設定です。

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <EnableWindowsTargeting>true</EnableWindowsTargeting>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
```

`UseWindowsForms` は Windows Desktop フレームワークへの参照を提供します。`EnableWindowsTargeting` は targeting pack を復元できる場合に別の OS からのビルドを許可する設定であり、macOS や Linux でアプリを実行可能にするものではありません。

## 仮想画面をキャプチャする

完全版には imports と STA エントリーポイントがあります。キャプチャ処理は次のとおりです。

```cs
var screen = SystemInformation.VirtualScreen;
using var bitmap = new Bitmap(screen.Width, screen.Height);
using (var graphics = Graphics.FromImage(bitmap))
{
    graphics.CopyFromScreen(
        screen.Left, screen.Top, 0, 0, screen.Size,
        CopyPixelOperation.SourceCopy);
}
bitmap.Save(filename, ImageFormat.Png);
```

主画面の左側や上側に別のモニターがある場合、`screen.Left` や `screen.Top` は負になります。外接矩形には画面間の未使用領域が含まれることもあります。別セッション、セキュアデスクトップ、保護されたコンテンツの取得を保証するものではありません。

プログラムは出力ディレクトリと一意の PNG ファイル名を作成し、bitmap と graphics のオブジェクトを破棄します。

## Windows で実行する

```powershell
dotnet run -c Release -- --self-test
dotnet run -c Release
dotnet run -c Release -- C:\Screenshots
```

セルフテストはデスクトップを撮影せず、合成 PNG を作成してデコードします。通常実行では Pictures または指定ディレクトリへ保存します。実際の取得は対象の Windows セッションで、画面配置と DPI 設定も含めて確認してください。

参照: [SystemInformation.VirtualScreen](https://learn.microsoft.com/en-us/dotnet/api/system.windows.forms.systeminformation.virtualscreen)、[Graphics.CopyFromScreen](https://learn.microsoft.com/en-us/dotnet/api/system.drawing.graphics.copyfromscreen)。
