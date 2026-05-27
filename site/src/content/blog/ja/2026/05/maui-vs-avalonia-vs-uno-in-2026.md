---
title: "MAUI vs Avalonia vs Uno Platform: 2026 年にどれを選ぶべきか"
description: "2026 年に新しい .NET クロスプラットフォームのデスクトップおよびモバイルアプリを作る場合、すべてのターゲットで単一のレンダリング済みコントロールセットが必要なら Avalonia、ブラウザにも届かせる必要があるなら Uno、ネイティブの iOS と Android にくわえて Microsoft の純正サポートが本当に必要な場合だけ MAUI を選びましょう。"
pubDate: 2026-05-27
tags:
  - "comparison"
  - "maui"
  - "avalonia"
  - "uno-platform"
  - "dotnet"
  - "csharp"
lang: "ja"
translationOf: "2026/05/maui-vs-avalonia-vs-uno-in-2026"
translatedBy: "claude"
translationDate: 2026-05-27
---

2026 年に .NET 11 上でゼロから .NET クロスプラットフォーム UI アプリを始めるなら、正直な答えはこうです。Windows、macOS、Linux、iOS、Android にわたって一貫したレンダリング済みのコントロールセットが必要なら Avalonia 11.3 を選びましょう。ブラウザと tvOS のターゲットが重要、あるいは WinUI/WPF の XAML を流用するオプションが欲しいなら Uno Platform 6 を選びましょう。iOS と Android が製品のすべてで、完全にネイティブなコントロールが必要、かつ Microsoft の純正サポートが譲れないなら、その場合にだけ .NET MAUI 11 を選びましょう。

この記事は、.NET MAUI 11 (執筆時点でプレビュー、GA は 2026 年 11 月予定)、Avalonia 11.3.x (2026 年 3 月から安定版)、Uno Platform 6.0.x (2026 年 2 月から安定版) を対象としています。3 つとも .NET 9 と .NET 11 をターゲットにし、3 つとも Windows、macOS、iOS、Android に配信でき、3 つとも成熟度がまったく異なる動作する WebAssembly のストーリーを持っています。プロジェクトを実際に左右する違いは、レンダリングモデル、ブラウザサポート、コントロールの同等性、そして既存の XAML をそのまま貼り付けられる量です。

## 2026 年における各フレームワークの実態

**.NET MAUI 11** は Microsoft の純正フレームワークです。プラットフォームネイティブのコントロールをラップします。MAUI の `Button` は、iOS では `UIButton`、Android では `AppCompatButton`、Windows では `Microsoft.UI.Xaml.Controls.Button`、Mac Catalyst では `NSButton` です。ネイティブの外観とプラットフォームの挙動が無償で得られます。macOS への唯一の経路は依然として Mac Catalyst です。Linux はサポートされていません。ブラウザはサポートされていません。.NET 11 で Android と iOS のデフォルトランタイムが CoreCLR になり、歴史的な「MAUI は遅い」ギャップの大半が埋まりました。

**Avalonia 11.3** はすべてを Skia で自前レンダリングします。`Button` はどのプラットフォームでも `Button` です。Avalonia がピクセルを描画し、レイアウトを所有し、入力パイプラインを所有します。Windows、macOS (Cocoa、Catalyst ではない)、Linux (X11 と Wayland)、iOS、Android、そしてブラウザで Skia を走らせる WebAssembly ターゲットにわたって、ピクセル単位で同一の UI が得られます。トレードオフは、そう作らない限り何ひとつ 100% ネイティブには見えないことです。Fluent と macOS のテーマが標準で同梱されておりかなり近づけてはくれますが、OS 向けに書かれたコントロールライブラリと完全に同じ感触にはなりません。

**Uno Platform 6** は XAML 互換性を売りにしています。WinUI 3 の XAML 方言を、Windows (ネイティブ WinUI)、iOS、Android、macOS (AppKit)、Linux (Skia または GTK)、tvOS、WebAssembly のネイティブレンダラー上に実装します。Uno 5 以降は、すべてを Avalonia のように Skia で描画する "Uno Native" モードと、両者を混ぜる "Uno Native + Hybrid" もあります。Uno の目玉機能は、WinUI 3 アプリを取り上げて、同じ XAML で他の 6 プラットフォーム向けに再ビルドできることです。ブラウザを一級ターゲットとして狙う唯一のものであり、そもそも tvOS をサポートする唯一のものです。

## 機能マトリクス

| 機能                                  | .NET MAUI 11                           | Avalonia 11.3                         | Uno Platform 6                         |
| ------------------------------------- | -------------------------------------- | ------------------------------------- | -------------------------------------- |
| レンダリングモデル                    | プラットフォームごとのネイティブコントロール | Skia、各ターゲットで同一            | Win/iOS/Android はネイティブ、それ以外は Skia またはネイティブ |
| Windows                               | はい (WinUI 3)                         | はい (Skia)                           | はい (ネイティブ WinUI 3)              |
| macOS                                 | Mac Catalyst のみ                      | ネイティブ Cocoa                      | ネイティブ AppKit と Skia              |
| Linux                                 | いいえ                                 | はい (X11、Wayland)                   | はい (Skia または GTK)                 |
| iOS                                   | はい                                   | はい                                  | はい                                   |
| Android                               | はい                                   | はい                                  | はい                                   |
| WebAssembly ブラウザ                  | いいえ                                 | プレビューのみ                        | はい、プロダクション品質               |
| tvOS                                  | いいえ                                 | いいえ                                | はい                                   |
| Microsoft 純正サポート                | はい (Microsoft.Maui.*)                | コミュニティ + 商用 Avalonia Inc      | コミュニティ + 商用 nventive           |
| XAML 方言                             | MAUI 固有                              | Avalonia (WPF テイスト)               | WinUI 3 / UWP 互換                     |
| Hot reload                            | はい (.NET 11)                         | はい (XAML とコード)                  | はい (XAML とコード)                   |
| Native AOT                            | 部分対応 (.NET 11)                     | ほとんどのターゲットで対応            | 部分対応                               |
| Android のデフォルトランタイム (.NET 11) | CoreCLR                             | Mono / CoreCLR                        | Mono / CoreCLR                         |
| デフォルトの MVVM ライブラリ          | CommunityToolkit.Mvvm                  | CommunityToolkit.Mvvm または ReactiveUI | CommunityToolkit.Mvvm               |
| ライセンス                            | MIT                                    | MIT (OSS) + 商用 Accelerate           | Apache 2.0                             |
| 後援                                  | Microsoft                              | Avalonia Inc (旧 AvaloniaUI OÜ)       | nventive                               |

ほとんどのプロジェクトを決めるのは、この表の両端にある 2 行、レンダリングモデルとブラウザサポートです。すべてのプラットフォームでピクセル単位に同一のコントロールセットが必要なら、Avalonia が唯一の成熟した選択肢です。妥協なしに今日同じ XAML をブラウザに出す必要があるなら、Uno が唯一の成熟した選択肢です。Microsoft をサポート契約に含めた完全ネイティブの iOS と Android が必要なら、MAUI が唯一の成熟した選択肢です。それ以外はすべて、この 3 つの主張の細部にすぎません。

## .NET MAUI 11 を選ぶとき

次の場合に MAUI を選びましょう。

- **製品が iOS + Android 第一、Windows 第二、macOS は遠い第三である場合。** MAUI はそのために作られ、Microsoft のエンジニアリング予算の大半が注がれる場所です。Mac Catalyst はコンパニオンアプリには使えますが、macOS が主要なサーフェスなら、これは間違ったツールです。フィールドサービスアプリ、リテール POS アプリ、社内モバイル専用ツール、iOS の見た目が重要なプロシューマー向けモバイルアプリはここに該当します。.NET 11 での Android の新しい CoreCLR デフォルトが、歴史的な起動時間ギャップの大半を埋めます。[.NET 11 Preview 4 における Android と iOS のデフォルト CoreCLR への移行](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) を参照してください。
- **Microsoft の純正サポートと、契約上の単一ベンダーが必要な場合。** Microsoft Premier 契約を持つエンタープライズ調達チームは、MAUI のサポートが含まれます。Avalonia Inc と nventive はどちらも商用サポートを販売していますが、別の項目になります。
- **ネイティブな見た目が必要で、プラットフォーム固有のコントロールが製品の一部である場合。** ネイティブのマップ、ネイティブのピッカー、ネイティブの共有シート、App Tracking Transparency ダイアログ、iOS の Live Activities など。MAUI はこれらを直接公開します。下層のコントロールが実際のプラットフォームのウィジェットだからです。
- **Xamarin.Forms から移行する場合。** これが公式のアップグレード経路です。[Xamarin.Forms ListView から MAUI CollectionView への移行ガイド](/ja/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) と、その他の移行ストーリーは文書化されてサポートされています。Avalonia と Uno もどちらも移行支援を提供しますが、どちらも公式な答えではありません。

最小構成の MAUI 11 `MauiProgram.cs`:

```csharp
// .NET 11, C# 14, Microsoft.Maui.Controls 11.0.x
using Microsoft.Extensions.Logging;

namespace HelloMaui;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            });

#if DEBUG
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
```

XAML 方言は MAUI 固有です。WPF の `Window` や WinUI 3 の `Page` をコピペしてもコンパイルは通りません。namespace、レイアウトパネルの名前、多くのコントロール名が異なります。

## Avalonia 11.3 を選ぶとき

次の場合に Avalonia を選びましょう。

- **デスクトップが主要サーフェスで、Linux が重要な場合。** Avalonia は 3 つの中で唯一、Wayland を含む一級の Linux サポートを持ちます。開発ツール、IDE、科学技術アプリ、社内管理ツールなど、開発者の Ubuntu や sysadmin の Fedora にインストールしなければならないものすべて。JetBrains Rider の "New UI" 実験は Avalonia で出荷されました。Unity Hub の最近のリライトもそうです。フレームワークがすべてのピクセルを所有しているため、Avalonia のデザインチームを通る経路はまっすぐです。
- **すべてのプラットフォームでピクセル単位に同一の UI が必要な場合。** Avalonia は上から下まで Skia でレンダリングします。カスタムスタイルの `DataGrid` は Windows、macOS、Linux、iOS、Android で同じに見えます。どのプラットフォームもネイティブのクロームをコントロールに注入することが許されないためです。ブランドアイデンティティがネイティブ感より一貫性を要求するなら、これが答えです。
- **モダンな bindings を備えた WPF テイストの XAML 方言が欲しい場合。** Avalonia の XAML は WPF に十分近いので、シニアの WPF 開発者は数日で生産的になります。`Binding`、`DataTemplate`、`ItemsControl`、`Style`、`Selector` はすべて WPF 開発者の期待どおりに振る舞います。WPF から Avalonia へのアップグレードは、Linux でも動かす必要のある Windows 専用の LOB アプリにとって最も抵抗の少ない道です。
- **Microsoft を回線に乗せずに商用品質のサポートが欲しい場合。** Avalonia Inc は SLA、専任エンジニア、XAML 用デザイナーを備えた "Avalonia Accelerate" を販売しています。これは本物の製品であって、今週のコミュニティではありません。

最小構成の Avalonia 11.3 `Program.cs`:

```csharp
// .NET 11, C# 14, Avalonia 11.3.x
using Avalonia;
using Avalonia.ReactiveUI;

namespace HelloAvalonia;

internal sealed class Program
{
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp()
        .StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace()
            .UseReactiveUI();
}
```

`UsePlatformDetect()` は、ビルドターゲットに基づいて Win32 / Cocoa / X11 / Wayland / Android / iOS / WebAssembly を自動的に選ぶ唯一の行です。ブラウザターゲットは Avalonia 11.3 時点でプレビューであり、大規模アプリケーションにはまだプロダクション品質ではありません。

## Uno Platform 6 を選ぶとき

次の場合に Uno を選びましょう。

- **ブラウザに配信する必要がある場合。** Uno の WebAssembly ターゲットはプロダクション品質で、Uno 4 以降ずっとそうです。3 つの中で唯一、ブラウザで大規模 XAML アプリケーションを実行している実際の顧客がいます。同じアプリが Windows、iOS、Android、そしてブラウザでアクセスできる PWA として動かなければならないなら、2026 年に第二のコードベースを必要としない唯一の選択肢が Uno です。
- **再利用したい WinUI 3 または UWP アプリケーションがある場合。** Uno は WinUI 3 の XAML 方言を実装しているため、既存の WinUI 3 `Page` を Uno プロジェクトに持ち込み、XAML を書き直さずに iOS、Android、Mac、Linux、ブラウザ向けに再ビルドできます。2026 年にこれをやれる他の経路はありません。
- **tvOS が必要な場合。** 他の 2 つはどちらも Apple TV ターゲットを出荷しません。ストリーミングアプリ、tvOS ハードウェアで動く店舗内キオスク、Apple エコシステムのエンターテイメントアプリは Uno か Swift に着地します。
- **iOS と Android でのネイティブレンダリングモードが必須要件の場合。** これらのターゲットでの Uno のデフォルトはネイティブレンダラーで、MAUI と同じトレードオフです。新しい "Uno Skia Native" オプションは、ピクセル整合性のために Skia に切り替えます。このターゲットごとのスイッチは Uno に固有です。1 つのコードベースからプラットフォームごとにレンダリング戦略を選べる他のフレームワークはありません。

最小構成の Uno 6 `App.xaml.cs`:

```csharp
// .NET 11, C# 14, Uno.WinUI 6.0.x
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace HelloUno;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        this.InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new Window();
        _window.Content = new MainPage();
        _window.Activate();
    }
}
```

クロスプラットフォーム XAML という約束のコストは、Uno が 3 つの中でセットアップが最も重いことです。新しい Uno ソリューションは各プラットフォーム (iOS、Android、WebAssembly、Skia.Gtk、Skia.Wpf、Skia.MacOS、Wasm Hosted など) ごとに別々のヘッドプロジェクトを持ち、テンプレートはこの複雑さのほとんどを隠しはするものの消し去りはしない `Uno.Sdk` MSBuild SDK を同梱しています。

## ベンチマーク: コールドスタートとバンドルサイズ

以下の数値は、フレームワークごとの "Hello World" テンプレートを .NET 11 SDK `11.0.100-preview.4.26152.6` で `dotnet publish -c Release` し、Pixel 8 (Android 15)、iPhone 15 (iOS 18.4)、MacBook Pro M2 上の Chrome 137 で測定したものです。コールドキャッシュ起動、プロファイル事前最適化なし、native AOT なし。

| 指標                                      | MAUI 11           | Avalonia 11.3      | Uno 6            |
| ----------------------------------------- | ----------------- | ------------------ | ---------------- |
| Android コールドスタート、アプリコードのみ | 480 ms (CoreCLR) | 410 ms (Mono)      | 520 ms (Mono)    |
| Android APK サイズ、release、単一アーキ   | 22 MB             | 18 MB              | 25 MB            |
| iOS コールドスタート、アプリコードのみ    | 360 ms            | 320 ms             | 380 ms           |
| iOS IPA サイズ、release                   | 38 MB             | 31 MB              | 42 MB            |
| WebAssembly バンドル (gzip)               | n/a               | 4.1 MB (プレビュー) | 3.3 MB           |
| WebAssembly First Contentful Paint        | n/a               | 2200 ms            | 1800 ms          |
| Windows コールドスタート (WinUI 3 経路)   | 280 ms            | 240 ms             | 310 ms           |

Avalonia はクリティカルパスにネイティブコントロールの膨張がないため、コールドスタートを全方位で勝ち取ります。Skia で最初のフレームを描いて終わりだからです。MAUI 11 は MAUI 9 のときよりも Avalonia に近く、これは Android の CoreCLR デフォルト化のおかげです (同じハードウェアでの MAUI 9 における以前の Mono 値は 720 ms でした)。Uno は WinUI 3 互換性サーフェスを毎ビルドに持ち込むので最も重いです。これらのギャップのどれも実アプリの成否を分けることはありませんが、KPI がコールドスタートなら、Avalonia は一貫して最速です。

## あなたの代わりに決めてしまう落とし穴

好みに関係なく決定を強制するものが 3 つあります。

1. **MAUI は Linux もブラウザもサポートしません。** いずれかのプラットフォームが出荷マトリクスに入っているなら、MAUI は対象外です。これを変える計画はありません。Microsoft は Linux が MAUI の計画にないことを明言しており、"ブラウザ的" な体験の公式回答は Blazor Hybrid 経路です。共有 XAML を持つ実際の WebAssembly ターゲットが必要なら、Uno か Avalonia を見ることになります。
2. **Avalonia のブラウザターゲットはプレビューであり、プロダクションではありません。** Avalonia チームはこの点を明確にしています。プロジェクトが大規模 XAML アプリケーションに対して今日 (12 か月後ではなく) ブラウザ品質のレンダリングを必要とするなら、現実的な選択肢は Avalonia ではなく Uno です。Avalonia の Skia-WASM 経路が成熟するにつれ、12 〜 18 か月後に再評価してください。
3. **XAML 方言は粘着的です。** 3 つのフレームワーク間でコントロールを持ち上げるのは、ポートというよりリライトに近い作業です。WinUI 3 の XAML は Uno にきれいに貼り付きますが、MAUI の XAML はどこにも貼り付かず、Avalonia の XAML は他の Avalonia コードにしか貼り付きません。手元にある既存 XAML の最大の塊に合う方言を選びましょう。この決定はプロジェクトの生涯にわたって複利で効いてきます。

方言がどう分岐するかの実例として、SkiaSharp ベースのカスタムコントロールがあります。SkiaSharp 4 は [Uno Platform を新しい共同メンテナーとして](/ja/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/) 出荷されており、つまりパッケージのロードマップは今や Uno のピクセルレンダリングニーズに結びついています。これにより SkiaSharp は Uno と Avalonia では最も抵抗の少ない道に、Skia がデフォルトレンダラーではない MAUI ではやや扱いにくい依存関係になります。

## 再確認した推奨

.NET 11 上で今日始まる新しい .NET クロスプラットフォーム UI プロジェクトの場合:

- **デスクトップ第一、特に Linux を含む場合**: **Avalonia 11.3** を選びましょう。ピクセル単位で同一、コールドスタートが最速、各デスクトップ OS で成熟しており、XAML は WPF からきれいに移行します。
- **ブラウザが出荷マトリクスに入る場合**: **Uno Platform 6** を選びましょう。唯一成熟した WebAssembly ターゲットであり、唯一の tvOS ターゲットであり、唯一プラットフォーム間で WinUI 3 XAML を再利用できる選択肢です。
- **iOS + Android で Microsoft をサポート契約に乗せる場合**: **.NET MAUI 11** を選びましょう。ネイティブコントロール、Microsoft の純正エンジニアリング、Xamarin.Forms の公式アップグレード経路、そして .NET 11 における Android と iOS のデフォルト CoreCLR ランタイムです。

既存アプリからの移行を検討している場合:

- Xamarin.Forms から: MAUI に進みましょう。移行経路は直接的でサポートされています。テーマモデルは挙動変更の大きなものの 1 つなので、開始前に [.NET MAUI のスタイリングとダークモードのパターン](/ja/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) を参照してください。
- WPF から: Avalonia。bindings、triggers、resource dictionary を含めて XAML が最も近い一致です。
- UWP または WinUI 3 から: Uno。XAML と namespace はほぼ同一で、Uno がそもそも存在する理由がこのシナリオです。

## 関連

- [Windows と macOS だけで動く MAUI アプリの書き方 (モバイルなし)](/ja/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) デスクトップ専用 MAUI の切り口について。
- [Xamarin.Forms ListView を MAUI CollectionView に移行する方法](/ja/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) 最も質問の多い単一の移行ステップについて。
- [MAUI アプリを Microsoft Store 用にパッケージする方法](/ja/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) 方程式の Windows 配布側について。
- [SkiaSharp 4.0 preview 1 が Uno Platform を共同メンテナーに指名](/ja/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/) 共有レンダラーのストーリーが Uno と Avalonia にとって何を意味するかについて。
- [.NET 11 Preview 4 における Android と iOS のデフォルト CoreCLR への移行](/ja/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) .NET 11 の起動時間改善について。

## 参考資料

- [.NET MAUI ドキュメント](https://learn.microsoft.com/dotnet/maui/)、Microsoft Learn、2026-05-27 アクセス。
- [Avalonia 11.3 リリースノート](https://github.com/AvaloniaUI/Avalonia/releases) GitHub。
- [Uno Platform 6.0 発表](https://platform.uno/blog/) と Uno Platform ドキュメント。
- [Avalonia のブラウザサポート状況](https://docs.avaloniaui.net/docs/next/guides/platforms/web/)、2026-05-27 アクセス。
- [Uno Platform における WinUI 3 XAML 互換性](https://platform.uno/docs/articles/winui-doc-links-overview.html)、Uno Platform ドキュメント。
