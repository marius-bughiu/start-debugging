---
title: "Windows と macOS だけで動く MAUI アプリの書き方 (モバイルなし)"
description: ".NET MAUI 11 プロジェクトから Android と iOS を取り除き、Windows と Mac Catalyst のみを出荷するための csproj 編集、workload コマンド、コードをきれいに保つマルチターゲティング。"
pubDate: 2026-05-02
template: how-to
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "windows"
  - "macos"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only"
translatedBy: "claude"
translationDate: 2026-05-02
---

短い答え: `.csproj` を開き、`<TargetFrameworks>` から Android と iOS のエントリを削除して、`net11.0-windows10.0.19041.0` と `net11.0-maccatalyst` だけを残します。次に `Platforms/Android`、`Platforms/iOS`、そして存在すれば `Platforms/Tizen` を削除します。モバイル専用アイコンを指す MAUI 画像アセットの `<ItemGroup>` エントリを取り除き、マシンをきれいに保ちたければ `maui-android` と `maui-ios` workload をアンインストールします。Single Project レイアウト、`MauiProgram`、XAML ホットリロード、リソースパイプラインはそのまま動作します。`dotnet build -f net11.0-windows10.0.19041.0` は MSIX を生成し、`dotnet build -f net11.0-maccatalyst` (macOS で実行) は `.app` を生成し、Android エミュレータを起動しようとすることは二度とありません。

この記事では、.NET 11 上の .NET MAUI 11.0.0 における正確な編集内容、安全に削除できるものとそうでないもの、プラットフォーム head を取り除いたときに発生するマルチターゲティングの微妙な落とし穴、そして実際に時間を節約できる workload と CI の変更を順を追って説明します。以下はすべて .NET 11 SDK の `dotnet new maui` に対して検証済みで、すでに MAUI へ移行された Xamarin.Forms プロジェクトにも同じように適用できます。

## なぜデスクトップ専用 MAUI head を出荷するのか

業務アプリのチームには、モバイルへのリーチではなく XAML とバインディングのモデル目当てで MAUI を選ぶ層が一定数います。社内管理ツール、キオスクアプリ、POS クライアント、工場現場のダッシュボード、現場サービスアプリで「現場とは Surface と MacBook のこと」というケースは、いずれもここに当てはまります。これらのチームは、決して出荷しないモバイル head に対して実際のコストを支払っています。`dotnet build` のたびに 4 つのターゲットが評価され、NuGet の restore のたびに Android と iOS の reference packs が引かれ、CI ランナーごとに Android workload が必要で、開発者のオンボーディングはアプリを起動できる前に Xcode と Android Studio の依存に突き当たります。

モバイル head を取り除く構成は Visual Studio の既定テンプレートではありませんが、SDK は完全にサポートしています。ビルドシステムは `<TargetFrameworks>` を読み、宣言した head のみを生成します。MAUI 自体で切り替えるべきフラグはありません。摩擦はすべて、プロジェクトファイル、`Platforms/` フォルダー、そしてテンプレートがモバイルアセット用に追加する条件付き MSBuild アイテムに集中しています。

## TargetFrameworks の編集

.NET 11 SDK で `dotnet new maui -n DesktopApp` を新規作成すると、次の冒頭 `PropertyGroup` を持つプロジェクトが開きます:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-android;net11.0-ios;net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

2 つの `<TargetFrameworks>` 行を、明示的なリスト 1 つに置き換えます:

```xml
<!-- .NET MAUI 11.0.0, .NET 11 SDK -->
<PropertyGroup>
  <TargetFrameworks>net11.0-maccatalyst</TargetFrameworks>
  <TargetFrameworks Condition="$([MSBuild]::IsOSPlatform('windows'))">$(TargetFrameworks);net11.0-windows10.0.19041.0</TargetFrameworks>
  <OutputType>Exe</OutputType>
  <RootNamespace>DesktopApp</RootNamespace>
  <UseMaui>true</UseMaui>
  <SingleProject>true</SingleProject>
  <ImplicitUsings>enable</ImplicitUsings>
  <Nullable>enable</Nullable>
</PropertyGroup>
```

ここで重要な点が 2 つあります。第一に、条件付きの `IsOSPlatform('windows')` ブロックは保持します。Windows head は Windows 上でしかビルドできず、Mac Catalyst も macOS 上でしかビルドできないからです。条件がなければ、macOS の開発者が `dotnet build` を実行すると "The Windows SDK is not available." で失敗します。第二に、`net11.0-windows10.0.19041.0` のバージョンサフィックスは MAUI が WinUI のために要求する Windows 10 SDK のバージョンです。バージョンサフィックスを落としたり `net11.0-windows10.0` 単独に変更したりしないでください。WinAppSDK のターゲットがその特定のモニカーに固定されているからです。

macOS だけが必要なら、Windows の行を完全に削除します。Windows だけが必要なら、Mac Catalyst の行と条件式を削除します。本当に head が 1 つしかないのなら、`<TargetFramework>` (単数形) も使えます。これは無条件の単一値となり、一部のツールはこれをよりエレガントに扱います。本格的なクロスデスクトップアプリでは、マルチターゲット形式を維持してください。

## `Platforms/` で削除するもの

MAUI テンプレートは `Platforms/Android`、`Platforms/iOS`、`Platforms/MacCatalyst`、`Platforms/Tizen`、`Platforms/Windows` を生成します。各フォルダーには、プラットフォーム固有のブートストラップコードが少しずつ含まれています。Apple プラットフォーム用の `AppDelegate`、Android 用の `MainActivity` と `MainApplication`、Windows 用の `App.xaml` と `Package.appxmanifest`、Mac Catalyst 用の `Application.cs` です。

デスクトップ専用の場合は、`Platforms/Android`、`Platforms/iOS`、`Platforms/Tizen` を直接削除します。これらは使用されません。`Platforms/MacCatalyst` と `Platforms/Windows` は残します。`Resources/` フォルダーには一切手を加えないでください。これは Single Project のアセットパイプラインで、すべての head に対応します。

削除後のレイアウトは次のようになります:

```
DesktopApp/
  App.xaml
  App.xaml.cs
  AppShell.xaml
  AppShell.xaml.cs
  MainPage.xaml
  MainPage.xaml.cs
  MauiProgram.cs
  Platforms/
    MacCatalyst/
      AppDelegate.cs
      Info.plist
      Program.cs
    Windows/
      App.xaml
      App.xaml.cs
      Package.appxmanifest
      app.manifest
  Resources/
    AppIcon/
    Fonts/
    Images/
    Raw/
    Splash/
    Styles/
  DesktopApp.csproj
```

これがデスクトップ専用 MAUI 11 アプリの完全なソースツリーです。

## モバイル専用の画像アセットアイテムを取り除く

既定のテンプレートを使った場合、`.csproj` の末尾近くに次のようなブロックがあります:

```xml
<!-- .NET MAUI 11.0.0 -->
<ItemGroup>
  <MauiIcon Include="Resources\AppIcon\appicon.svg" ForegroundFile="Resources\AppIcon\appiconfg.svg" Color="#512BD4" />
  <MauiSplashScreen Include="Resources\Splash\splash.svg" Color="#512BD4" BaseSize="128,128" />
  <MauiImage Include="Resources\Images\*" />
  <MauiImage Update="Resources\Images\dotnet_bot.png" Resize="True" BaseSize="300,185" />
  <MauiFont Include="Resources\Fonts\*" />
  <MauiAsset Include="Resources\Raw\**" LogicalName="%(RecursiveDir)%(Filename)%(Extension)" />
</ItemGroup>
```

これらはプラットフォーム非依存で、そのままで構いません。Single Project リソースパイプラインは、宣言された head に対してのみ、ビルド時に SVG をプラットフォーム別の PNG に変換します。Android を取り除くと Android の解像度は生成されません。同じ `Resources/AppIcon/appicon.svg` ファイルが Mac Catalyst の `AppIcon.icns` と Windows の `Square150x150Logo.scale-200.png` を生成し、必要なものはそれだけです。

プロジェクトが .NET 9 より前のものなら、Xamarin.Forms 移行で残った明示的な `<AndroidResource>` または `<BundleResource>` アイテムがあるかもしれません。削除してください。残してもエラーにはなりませんが、ビルド出力が混乱し、参照ファイルが存在しなくなれば "file not found" 警告に当たります。

## `#if ANDROID` を使わない自前コードのマルチターゲティング

MAUI テンプレートは、プラットフォーム固有コードのためにいくつかのパターンを提供します。`Platforms/<head>/` のファイルに分割した `partial` クラスと、`#if` ディレクティブです。Android と iOS が消えたいま、扱う必要があるのは Windows と Mac Catalyst だけです。実際に使うプリプロセッサシンボルは次のとおりです:

```csharp
// .NET 11, MAUI 11.0.0
public static class PlatformInfo
{
    public static string Describe()
    {
#if WINDOWS
        return "Windows";
#elif MACCATALYST
        return "macOS (Mac Catalyst)";
#else
        return "Unknown";
#endif
    }
}
```

これだけです。`ANDROID` と `IOS` は、それらの head が `<TargetFrameworks>` に含まれていれば依然として定義されたシンボルですが、含まれていない以上、それらの分岐は単にコンパイルされません。コードベースから `#if ANDROID` と `#if IOS` のブロックは、別途のクリーンアップパスとしてすべて安全に削除できます。

ファイル名で実装を分割する ([MAUI に対して文書化された公式マルチターゲティングパターン](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)) なら、条件付き `<ItemGroup>` ブロックから Android と iOS の分岐を落とすことになります:

```xml
<!-- Mac Catalyst -->
<ItemGroup Condition="$(TargetFramework.StartsWith('net11.0-maccatalyst')) != true">
  <Compile Remove="**\*.MacCatalyst.cs" />
  <None Include="**\*.MacCatalyst.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>

<!-- Windows -->
<ItemGroup Condition="$(TargetFramework.Contains('-windows')) != true">
  <Compile Remove="**\*.Windows.cs" />
  <None Include="**\*.Windows.cs" Exclude="$(DefaultItemExcludes);$(DefaultExcludesInProjectFolder)" />
</ItemGroup>
```

5 つではなく 2 つのルールで済みます。同じロジックがフォルダーベースのマルチターゲティングにも当てはまります。`MacCatalyst` と `Windows` のフォルダールールだけ残してください。

## Workload: ビルドするものをインストールし、しないものをアンインストールする

これは CI ランナーで最も早く元が取れる変更です。MAUI の workload マニフェストは複数のサブ workload に分かれています:

```bash
# .NET 11 SDK on macOS
dotnet workload install maui-maccatalyst

# .NET 11 SDK on Windows
dotnet workload install maui-windows
```

デスクトップ専用プロジェクトには、対応するランナーで上記 2 つだけが必要です。Android と iOS を推移的依存として引き込む包括 workload `maui` は不要です。`maui` がインストール済みの CI イメージでは次のように実行します:

```bash
dotnet workload uninstall maui-android maui-ios
```

macOS 上の Mac Catalyst head は依然として Xcode を必要とします。`mlaunch` と Apple のツールチェーンが実際の `.app` 構築を行うからです。Android SDK、Java JDK、iOS のデバイスデプロイ依存は不要です。Windows 上では、Windows head は `<TargetFrameworks>` に固定されたバージョンの Windows App SDK と Windows 10 SDK を要求します。`dotnet workload install maui-windows` コマンドが両方を引き込みます。

CI における節約は確かなものです。MAUI アプリの Linux ホスト上ビルドのために Android workload とエミュレータイメージをプロビジョンしては CI ゲートでスキップしていた Linux ランナーは、これらの手順を完全に削除できます。ビルドは Linux を無視するようになり、OS ごとに 1 つずつ、計 2 つのジョブを実行することになります。

## 各 head のビルドと公開

`dotnet build` と `dotnet publish` は明示的な `-f` フレームワーク引数を取り、誤って間違ったホスト上で head をビルドしようとしないようにします:

```bash
# On Windows, .NET 11 SDK
dotnet build -f net11.0-windows10.0.19041.0 -c Release
dotnet publish -f net11.0-windows10.0.19041.0 -c Release -p:WindowsAppSDKSelfContained=true -p:WindowsPackageType=MSIX

# On macOS, .NET 11 SDK
dotnet build -f net11.0-maccatalyst -c Release
dotnet publish -f net11.0-maccatalyst -c Release -p:CreatePackage=true
```

Windows head は `.msix` パッケージ、もしくは `WindowsPackageType=None` ならパッケージ化されない Win32 ディレクトリを出力します。Mac Catalyst head は `.app` を出力し、`CreatePackage=true` なら `.pkg` インストーラーも出力します。コード署名は両方で別の話になります。MSIX には Authenticode 証明書、`.pkg` には Apple Developer ID が必要です。どちらも provisioning profile を要求しません。これは、いままさに抜け出した iOS 固有のダンスです。

デスクトップ head にも Native AOT が必要なら、MAUI の WinUI head は .NET 11 上で注意点付きでサポートしており、[ASP.NET Core minimal API の Native AOT 経路](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) と似た形になります。Mac Catalyst は MAUI 11 ではまだ完全な Native AOT に対応しておらず、Apple プラットフォーム向けには mono-AOT が同梱されます。

## 覚えておきたい落とし穴

Visual Studio の "Add new MAUI Page" テンプレートは、特定のシナリオで `<ItemGroup Condition="...android..."/>` ブロックを黙って戻すことがあります。csproj の差分には注意してください。あなたがクリーンなデスクトップ専用 csproj をコミットし、チームメイトが IDE から新しいビューを追加した場合、`<TargetFrameworks>` がもはやそれらのターゲットを含んでいなくても、差分が Android と iOS の条件付きアイテムを蘇らせる可能性があります。これらの孤児アイテムは無害ですが、ノイズが蓄積します。

`Xamarin.AndroidX.*` やモバイル専用 API の `Microsoft.Maui.Essentials` に依存する NuGet パッケージは、それでも restore されます。パッケージマネージャーは宣言済みのターゲットに対して解決し、`net11.0-windows10.0` または `net11.0-maccatalyst` 向けの互換アセットを持たないモバイル専用パッケージは `NU1202` で失敗します。修正方法はそのパッケージを取り除くことです。実際に使っているものの推移的依存である場合は、上流パッケージに issue を立て、デスクトップターゲットを明示的にサポートするバージョンに固定してください。

XAML ホットリロードは .NET 11 の両方のデスクトップ head で動作します。起動時のデバッガーは head のホスト OS でなければなりません。Windows 上の Visual Studio から Mac Catalyst セッションへデバッグすることはできません。macOS 上の Rider は単一ワークスペースから両方の head を扱え、これがクロスデスクトップチームの大半が落ち着くワークフローです。

明示的にモバイル専用の MAUI Essentials API (ジオコーディング、コンタクト、センサー、テレフォニー) は、Windows と Mac Catalyst では実行時に `FeatureNotSupportedException` をスローします。コンパイル時には失敗しません。これらの API の使用は、機能チェックやデスクトップで安全な抽象化の背後に包んでください。同じことが [.NET MAUI 11 で導入された pin clustering の変更](/ja/2026/04/dotnet-maui-11-map-pin-clustering/) 以前の MAUI Maps にも当てはまります。デスクトップ head の内部はモバイル head とは異なる地図コントロールを使っており、機能の一致は完璧ではありません。

将来モバイル head を戻す必要が出た (顧客が iPad 版を求めた) としても、変更はきれいに巻き戻せます。`<TargetFrameworks>` にエントリを戻し、新しい `dotnet new maui` テンプレートから `Platforms/Android` と `Platforms/iOS` のフォルダーを復元し、workload を再インストールします。Single Project レイアウト、XAML、ビューモデル、リソースパイプラインはそのまま引き継がれます。デスクトップ専用構成は 4 head テンプレートの厳密な部分集合であり、フォークではありません。

## 関連

- [.NET MAUI 11 が組み込みの LongPressGestureRecognizer を出荷](/ja/2026/04/maui-11-long-press-gesture-recognizer/)
- [Pin clustering が .NET MAUI 11 Maps に到来](/ja/2026/04/dotnet-maui-11-map-pin-clustering/)
- [ASP.NET Core minimal API で Native AOT を使う方法](/ja/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)
- [.NET 11 AWS Lambda のコールドスタートを短縮する方法](/ja/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## 参考リンク

- [.NET MAUI のマルチターゲティングを構成する (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/configure-multi-targeting?view=net-maui-10.0)
- [SDK スタイルプロジェクトのターゲットフレームワーク (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/standard/frameworks)
- [.NET MAUI の既知の問題のトラブルシューティング (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/maui/troubleshooting?view=net-maui-10.0)
- [Mac Catalyst ターゲットの削除に関する `dotnet/maui` issue 11584](https://github.com/dotnet/maui/issues/11584)
