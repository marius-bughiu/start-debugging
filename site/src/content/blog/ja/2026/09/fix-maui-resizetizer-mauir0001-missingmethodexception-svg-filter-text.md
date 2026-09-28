---
title: "修正: <filter>または<text>を含むSVGで.NET MAUI ResizetizerがMAUIR0001 MissingMethodExceptionを出す"
description: "MAUI 10.0.101と10.0.110のResizetizerは整合しないSystem.Memory参照を同梱しているため、filterやtextを含むSVGが失敗します。Resizetizerを10.0.100に固定するか、filterとtextを取り除いてください。"
pubDate: 2026-09-28
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "msbuild"
  - "csharp"
lang: "ja"
translationOf: "2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text"
translatedBy: "claude"
translationDate: 2026-09-28
---

.NET MAUI 10のビルドが`error MAUIR0001: There was an exception processing the image`と、`SKImageFilter.CreateMatrixConvolution`、`SKTextBlobBuilder.AddPositionedRun`、`SKTypeface.Clone`のいずれかに対する`System.MissingMethodException`で失敗し始めた場合、原因はSVG側ではなくResizetizerパッケージ自体にあります。`Microsoft.Maui.Resizetizer` 10.0.101と10.0.110は、`System.Memory` 4.0.5.0を要求するSkiaSharp 4.150.1ビルドを、4.0.2.0を要求する`Svg.Skia`と一緒に同梱しており、MSBuildが2つの異なる`ReadOnlySpan<T>`型を読み込んでしまいます。`<filter>`または`<text>`要素を使うSVGはすべてクラッシュします。最も速い修正は、MAUIの他の部分は10.0.110のままにして`Microsoft.Maui.Resizetizer`を10.0.100に固定することです。恒久的な修正は、`MauiIcon`、`MauiSplashScreen`、`MauiImage`のSVGからフィルターを削除し、テキストをパスに変換することです。

## エラーが起きる状況

このエラーには2つのパターンが上流で報告されています。フィルターのパターンは[dotnet/maui#38319](https://github.com/dotnet/maui/issues/38319)からのものです。

```text
error MAUIR0001: There was an exception processing the image '...\Resources\AppIcon\appicon.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKImageFilter SkiaSharp.SKImageFilter.CreateMatrixConvolution(
    SkiaSharp.SKSizeI, System.ReadOnlySpan`1<Single>, Single, Single,
    SkiaSharp.SKPointI, SkiaSharp.SKShaderTileMode, Boolean, SkiaSharp.SKImageFilter)'.
   at Svg.Skia.SkiaModel.ToSKImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.GetRenderImageFilter(SKImageFilter imageFilter)
   at Svg.Skia.SkiaModel.CreateRenderPaint(SKPaint paint)
   at Svg.Skia.SKSvg.Load(String path)
   at Microsoft.Maui.Resizetizer.SkiaSharpSvgTools..ctor(...)
```

10.0.101でのテキストのパターンは[dotnet/maui#38507](https://github.com/dotnet/maui/issues/38507)からのものです。

```text
error MAUIR0001: There was an exception processing the image '.../Resources/Images/place_capsule.svg'.
System.MissingMethodException: Method not found: 'Void SkiaSharp.SKTextBlobBuilder.AddPositionedRun
(System.ReadOnlySpan`1<UInt16>, SkiaSharp.SKFont, System.ReadOnlySpan`1<SkiaSharp.SKPoint>)'.
```

10.0.110ではテキストのパターンが別のメソッドに移りました。10.0.110で`Svg.Skia`が5.1.1から5.2.3に上がり、新しいバージョンはフォントの解決方法が異なるためです。単純な`<text>`要素を使った場合、10.0.110では次のようになります。

```text
error MAUIR0001: There was an exception processing the image '.../text.svg'.
System.MissingMethodException: Method not found:
'SkiaSharp.SKTypeface SkiaSharp.SKTypeface.Clone(System.ReadOnlySpan`1<SkiaSharp.SKFontVariationPositionCoordinate>)'.
   at Svg.Skia.SkiaModel.ApplyVariableFontWeight(SKTypeface typeface, SKFontStyle style)
   at Svg.Skia.SkiaModel.ResolveSKTypeface(SKTypeface typeface)
   at Svg.Skia.SkiaModel.ToSKFont(SKPaint paint)
```

#38507のコメントには、iOSの`GenerateSplashStoryboard`ステップで発生する`HarfBuzzSharp.Font.SetVariations(ReadOnlySpan<Variation>)`という同種の例外も報告されています。メソッド名が何であれ、シグネチャに注目してください。どれも`ReadOnlySpan<T>`を引数に取っています。これがバグの本質です。

## 存在するはずのメソッドをResizetizerが見つけられない理由

誰もが最初にやるのは、`SkiaSharp.dll`をデコンパイラーで開いて、そこにメソッドが存在することを確認することです。#38507の報告者もまさにそれを行い、リフレクションによって`AddPositionedRun(ReadOnlySpan<ushort>, SKFont, ReadOnlySpan<SKPoint>)`が存在することを確認しています。私も同様に、各パッケージバージョンの`buildTransitive`フォルダーに対して`System.Reflection.Metadata`で確認したところ、10.0.100、10.0.101、10.0.110のいずれにもメソッドは存在していました。

違いはアセンブリ参照にあります。同梱されている各アセンブリが要求している内容は次のとおりです。

| Resizetizer | SkiaSharp.dll (TFM) | SkiaSharpが要求するSystem.Memory | Svg.Skiaが要求するSystem.Memory | 同梱されているSystem.Memory.dll |
|---|---|---|---|---|
| 10.0.100 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |
| 10.0.101 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 10.0.110 | 4.150.1 (net462) | 4.0.5.0 | 4.0.2.0 | 4.0.2.0 |
| 11.0.0-rc.1 | 3.116.1 (net462) | 4.0.1.2 | 4.0.1.2 | 4.0.1.2 |

SkiaSharpの引き上げは[dotnet/maui#37731](https://github.com/dotnet/maui/pull/37731)（"Update SkiaSharp to 4.150.1"）で行われ、これが10.0.1xxのサービシングブランチにバックポートされて10.0.101でリリースされました。

次に、`dotnet build`がタスクの依存関係をどう読み込むかを見てみましょう。.NET上のMSBuildは、タスクの各アセンブリを専用の`MSBuildLoadContext`に配置します。依存関係が要求されると、タスクのフォルダーを探索しますが、[`MSBuildLoadContext.Load`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs)では、ローカルのバージョンが要求されたバージョンより低い場合、そのローカルファイルをスキップします。

```csharp
// dotnet/msbuild main, src/Framework/Loader/MSBuildLoadContext.cs (abridged)
AssemblyName candidateAssemblyName = AssemblyLoadContext.GetAssemblyName(candidatePath);
if (candidateAssemblyName.Version < assemblyName.Version)
{
    continue;
}
return LoadFromAssemblyPath(candidatePath);
```

したがって、10.0.101と10.0.110では次のようになります。

1. `Svg.Skia`は`System.Memory` 4.0.2.0を要求します。タスクのフォルダーには4.0.2.0があるため、MSBuildはそのファイルをプラグインコンテキストに読み込みます。この`System.Memory.dll`はアウトオブバンドのnetstandard2.0パッケージビルドであり、**独自の**`System.ReadOnlySpan<T>`型を定義しています。
2. `SkiaSharp`は`System.Memory` 4.0.5.0を要求します。ローカルの4.0.2.0は古すぎるため、探索はデフォルトコンテキストにフォールバックし、共有フレームワークの`System.Memory`ファサードが解決されます。このファサードは`ReadOnlySpan<T>`を`System.Private.CoreLib`にタイプフォワードします。
3. `Svg.Skia`は`SKImageFilter.CreateMatrixConvolution(..., ReadOnlySpan<float> [from System.Memory.dll], ...)`という呼び出しをコンパイルします。一方`SkiaSharp`が公開しているのは`CreateMatrixConvolution(..., ReadOnlySpan<float> [from CoreLib], ...)`です。名前もテキストも同じですが、型のアイデンティティが異なります。ランタイムはこれをバインドできず、呼び出し元メソッドをJITコンパイルする際に`MissingMethodException`をスローします。

これは、再現用のSVGが`feGaussianBlur`しか使っていないにもかかわらず、#38319のトレースに`CreateMatrixConvolution`という名前が出てくる理由でもあります。この例外は`Svg.Skia.SkiaModel.ToSKImageFilter`がJITコンパイルされるときに発生し、このメソッドにはすべてのフィルタープリミティブに対する呼び出しが含まれているためです。`<filter>`を含むSVGはどれもこのコードに到達します。フィルターもテキストも使わないSVGは、ラスタライズ中にSpanを引数に取るSkiaSharp APIに一切触れないため、デフォルトのテンプレートアイコンは今でもビルドに成功します。

このメカニズムを証明するため、10.0.110の`buildTransitive`フォルダーをコピーし、`System.Memory.dll`だけを削除して、タスクにそのコピーを指し示させてみました。失敗していた2つのSVGはどちらも問題なくラスタライズされました。これは、`System.Memory`へのすべての要求がフレームワークのファサードに行き着き、`ReadOnlySpan<T>`が1種類だけになるためです。このハックを本番に出荷してはいけませんが、診断の裏付けにはなります。

## 最小の再現手順

Resizetizerは通常のMSBuildタスクなので、これを再現するのにMAUIワークロードは不要です。`microsoft.maui.resizetizer.10.0.110.nupkg`を展開して、タスクを直接実行します。

```xml
<!-- .NET SDK 10.0.302, Microsoft.Maui.Resizetizer 10.0.110 (extracted nupkg), run.proj -->
<Project>
  <UsingTask AssemblyFile="$(RzDir)/Microsoft.Maui.Resizetizer.dll"
             TaskName="Microsoft.Maui.Resizetizer.ResizetizeImages" />
  <Target Name="Build">
    <ItemGroup><Img Include="$(Svg)" BaseSize="128,128" /></ItemGroup>
    <ResizetizeImages PlatformType="android"
                      IntermediateOutputPath="$(MSBuildThisFileDirectory)out/"
                      InputsFile="$(MSBuildThisFileDirectory)out/inputs.txt"
                      Images="@(Img)" />
  </Target>
</Project>
```

テスト用の画像は2つ用意します。

```xml
<!-- filter.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <filter id="blur"><feGaussianBlur stdDeviation="8" /></filter>
  <rect width="456" height="456" fill="#512BD4" filter="url(#blur)" />
</svg>
```

```xml
<!-- text.svg: fails on Resizetizer 10.0.101 and 10.0.110 -->
<svg width="456" height="456" viewBox="0 0 456 456" xmlns="http://www.w3.org/2000/svg">
  <rect width="456" height="456" fill="#512BD4" />
  <text font-family="Arial" font-size="120" fill="#FFFFFF"><tspan x="60 150 240" y="280">SD!</tspan></text>
</svg>
```

各パッケージに対して`dotnet build run.proj -nodeReuse:false -p:RzDir=<buildTransitive folder> -p:Svg=<file>`を実行したところ、SDK 10.0.302のmacOSでは次の結果になりました。

| Resizetizer | 通常のSVG | `<filter>` | `<text>` |
|---|---|---|---|
| 10.0.100 | OK | OK | OK |
| 10.0.101 | OK | `CreateMatrixConvolution` | `AddPositionedRun` |
| 10.0.110 | OK | `CreateMatrixConvolution` | `SKTypeface.Clone` |
| 11.0.0-rc.1.26451.6 | OK | OK | OK |

`PlatformType`を`ios`に切り替えても10.0.110では同様に失敗するため、私のテストでは10.0.110はどちらのプラットフォームでもどちらのパターンも修正していませんでした。本記事執筆時点で#38319と#38507はまだオープンであり、提案されている修正である[dotnet/maui#38883](https://github.com/dotnet/maui/pull/38883)は、同梱されているSkiaSharpをnetstandard2.0ビルドに差し替えるドラフトです。このCI実行ではネイティブライブラリの不整合が表面化しており、次のサービスリリースに間に合うことは期待しない方がよいでしょう。

## 修正1: Microsoft.Maui.Resizetizerを10.0.100に固定する

Resizetizerはビルド時にのみ使われます。PNGとリソースファイルを生成するだけで、アプリに同梱されるものは何もありません。そのため、MAUIの他の部分を10.0.110のままにして、Resizetizerだけをバージョン1つ分戻しても安全です。

MAUI SDKは`Microsoft.Maui.Resizetizer`を`$(MauiVersion)`の暗黙的な`PackageReference`として追加しますが、同じ名前の明示的な参照を宣言すると、ターゲットはその暗黙的な項目を削除します。`Microsoft.Maui.Controls` 10.0.110も`Microsoft.Maui.Resizetizer >= 10.0.110`に依存しているため、単純にダウングレードするとリストアが失敗します。

```text
error NU1605: Warning As Error: Detected package downgrade: Microsoft.Maui.Resizetizer from 10.0.110 to 10.0.100.
  App -> Microsoft.Maui.Controls 10.0.110 -> Microsoft.Maui.Resizetizer (>= 10.0.110)
  App -> Microsoft.Maui.Resizetizer (>= 10.0.100)
```

他の箇所での本物のダウングレードを隠してしまわないよう、`NU1605`はこの参照だけに限定して抑制します。

```xml
<!-- .NET 10, Microsoft.Maui.Controls 10.0.110, App.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="$(MauiVersion)" />

  <!-- Workaround for dotnet/maui#38319 and #38507. Remove when a fixed Resizetizer ships. -->
  <PackageReference Include="Microsoft.Maui.Resizetizer"
                    Version="10.0.100"
                    PrivateAssets="all"
                    NoWarn="NU1605" />
</ItemGroup>
```

これでクリーンにリストアでき、`project.assets.json`が`Microsoft.Maui.Resizetizer/10.0.100`を解決することを確認しています。Central Package Managementを使っている場合は、`Version`を`PackageVersion`項目に置き、`NoWarn="NU1605"`は`PackageReference`側に残してください。

最も大雑把な代替策は、両方のissueの報告者が使った方法で、`<MauiVersion>10.0.100</MauiVersion>`でMAUI全体を巻き戻すことです。これでも動作しますが、ビルドタスクの問題を回避するために10.0.110のすべての修正を手放すことになります。MAUIを戻す別の理由がすでにある場合にのみ行ってください。

## 修正2: Resizetizerが処理するSVGからフィルターとテキストを取り除く

これは、上流がパッチを出荷した後も維持しておきたい修正です。アイコンをどこでも同じように描画できるようになるからです。Resizetizerは`Svg.Skia`でSVGをラスタライズしますが、これはブラウザではありません。テキストはビルドマシンに存在するフォントに依存するため（macOSのCIランナーとWindowsのノートPCでは異なるフォールバックが選ばれます）、SVGフィルターはこれまでもブラウザ以外のレンダラーの中で最も再現性の低い部分でした。

テキストはアウトラインに変換してください。Inkscape 1.xではコマンドラインから変換でき、アセットのフォルダー全体を処理するのに便利です。

```bash
# Inkscape 1.x, converts <text> to <path> and drops editor metadata
inkscape design/splash-source.svg --export-text-to-path --export-plain-svg --export-filename=Resources/Splash/splash.svg
```

Figmaでは、エクスポート前にテキストレイヤーに"Outline stroke"（アウトラインストローク）／"Flatten"（統合）を適用します。Illustratorでは"Create Outlines"（アウトラインを作成）です。編集可能なソースファイルは`Resources/`の外のどこかに保管し、Resizetizerの目に触れないようにしてください。

フィルターについては、2つの選択肢があります。

- エフェクトをジオメトリで置き換えます。アプリアイコンのドロップシャドウは、たいてい不透明度を下げて数ピクセルずらした2つ目の図形で表現できます。ソフトなグローは放射状グラデーションで代用できます。どちらも`<filter>`は不要です。
- エフェクトレイヤーを自分でラスタライズし、PNGとして使います。`MauiIcon`と`MauiSplashScreen`はPNGを受け付け、PNGは`Svg.Skia`を一切通りません。必要な最大サイズでエクスポートしてください（iOSのアプリアイコンなら1024x1024）。[app iconのドキュメント](https://learn.microsoft.com/dotnet/maui/user-interface/images/app-icons)によると、メイン画像として使うビットマップは`BaseSize`を設定した場合にのみリサイズされるため、最もシンプルな構成はSVGを背景のまま残し、エフェクトをPNGのフォアグラウンドに移すことです。

```xml
<!-- .NET 10, MAUI 10.0.110, App.csproj -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg"
            ForegroundFile="Resources\AppIcon\appiconfg.png"
            Color="#512BD4" />
</ItemGroup>
```

CIより先に影響を受けるファイルをすべて見つけるには、2つの要素名をgrepします。

```bash
# any shell with grep; lists SVGs the 10.0.101/10.0.110 Resizetizer will choke on
grep -rlE "<(filter|text)[ >]" --include="*.svg" Resources/
```

## 修正3: どうせ予定していたならMAUI 11に移行する

.NET MAUI 11 RC 1のResizetizer（`11.0.0-rc.1.26451.6`）は依然としてSkiaSharp 3.116.1と、それに対応する`Svg.Skia` 2.0.0.4を同梱しており、3つのテストSVGはすべて問題なくラスタライズされました。これは1つのビルドエラーのためだけにリリース候補版に飛びつく理由にはなりませんが、アップグレードがすでに予定されているなら、この問題はそれと一緒に解消されます。10.0.1xxのサービシングブランチの方が先にSkiaSharp 4.150.1を取り込んだことは覚えておいてください。根本で修正されなければ、後のMAUI 11のビルドが同じ組み合わせを引き継ぐ可能性があります。

## 見落としやすい点とよく似た別の問題

- **ローカルでは成功するのにCIでは失敗します。** Resizetizerはインクリメンタルです。PNGが10.0.100の以前のビルドで生成済みであれば、ターゲットはスキップされ、アップグレード後もローカルビルドは成功し続けます。CI側のクリーンビルドではPNGが再生成されて失敗します。実際の状態を見るには、ローカルで`dotnet clean`を実行するか`obj/`を削除してください。
- **`dotnet build-server shutdown`は役に立ちません。** これは古いSkiaSharpを保持したままの古いMSBuildノードの問題ではありません。#38319の報告者は`-nodeReuse:false`でも再現することを確認しており、私の再現手順でも同じフラグを使っています。
- **自分のアプリにSkiaSharpの`PackageReference`を追加しても役に立ちません。** タスクはアプリの依存関係グラフからではなく、パッケージの`buildTransitive`フォルダーからコピーを読み込みます。これが、このアップグレードでNuGetの警告が一切出なかった理由でもあります。
- **MAUIR0001には他の原因もあります。** `MAUIR0001`はResizetizerの汎用的な"exception processing the image"（画像処理中の例外）コードです。同じコードで出る`ArgumentNullException`や`Unable to allocate pixels for the bitmap`は別の問題であり、それぞれ独自の上流issueがあります（例えば[dotnet/maui#12109](https://github.com/dotnet/maui/issues/12109)）。このバグに該当するのは、`ReadOnlySpan`を引数に取る`MissingMethodException`の場合だけです。
- **`MauiFont`のフォントには影響しません。** クラッシュはSVGのラスタライズ処理だけで起きます。カスタムフォントを含む実行時のテキスト描画は、このコードに一切触れません。
- **自分のアプリでのアセンブリ読み込み失敗は似ていますが別物です。** ビルド時ではなく実行時に`MissingMethodException`や`FileLoadException`が出る場合は、代わりに[公開済みアプリでCould not load file or assemblyを修正する方法](/ja/2026/05/fix-could-not-load-file-or-assembly-in-published-app/)を参照してください。

## 関連記事

- Resizetizerのステップの直後にAndroidビルドも失敗する場合は、[MAUI Androidで"Gradle build failed to produce an .apk file"を修正する](/ja/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/)で次によくあるCIの失敗を扱っています。
- SDK更新後にiOSのCIランナーでもビルドできなくなった場合は、[MAUIビルド中のUnable to find a valid iOS Simulator runtime](/ja/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/)を参照してください。
- Resizetizerのアセットパイプラインと`MauiIcon`／`MauiSplashScreen`項目については、[Xamarin.Formsから.NET MAUI 11への移行](/ja/2026/05/migrate-from-xamarin-forms-to-maui-11/)で詳しく解説しています。
- ストア向けパッケージングではすべてのアイコンサイズが再生成されるため、[.NET MAUIアプリをMicrosoft Store向けにパッケージ化する](/ja/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/)は、フィルター付きのSVGアイコンがWindowsで問題を起こす箇所です。

## 参考資料

- [dotnet/maui#38319: `<filter>`を含むSVGアプリアイコンでResizetizerが失敗する](https://github.com/dotnet/maui/issues/38319)
- [dotnet/maui#38507: Resizetizer 10.0.101がSVGの`<text>`要素で失敗する](https://github.com/dotnet/maui/issues/38507)
- [dotnet/maui#37731: SkiaSharpを4.150.1に更新](https://github.com/dotnet/maui/pull/37731)
- [dotnet/maui#38883: Resizetizerが誤ったSkiaSharpアセンブリを読み込む問題を修正（ドラフト）](https://github.com/dotnet/maui/pull/38883)
- [dotnet/msbuild `MSBuildLoadContext.cs`](https://github.com/dotnet/msbuild/blob/main/src/Framework/Loader/MSBuildLoadContext.cs)
- [NuGet上のMicrosoft.Maui.Resizetizer](https://www.nuget.org/packages/Microsoft.Maui.Resizetizer)
- [.NET MAUIアプリプロジェクトに画像を追加する（MS Learn）](https://learn.microsoft.com/dotnet/maui/user-interface/images/images)
