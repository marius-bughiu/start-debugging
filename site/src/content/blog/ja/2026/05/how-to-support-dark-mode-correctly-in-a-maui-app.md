---
title: ".NET MAUI アプリでダークモードを正しくサポートする方法"
description: ".NET MAUI 11 におけるダークモードのエンドツーエンド: AppThemeBinding、SetAppThemeColor、RequestedTheme、UserAppTheme による上書きと永続化、RequestedThemeChanged イベント、そしてドキュメントが触れていない Info.plist と MainActivity のプラットフォーム固有の設定です。"
pubDate: 2026-05-03
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "dark-mode"
  - "theming"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-support-dark-mode-correctly-in-a-maui-app"
translatedBy: "claude"
translationDate: 2026-05-03
---

短い答えとして、.NET MAUI 11.0.0 では、テーマに依存するすべての値を `AppThemeBinding` マークアップ拡張でバインドし、ライトとダークのカラーを `App.xaml` の `StaticResource` キーとして整理し、起動時に `Application.Current.UserAppTheme = AppTheme.Unspecified` を設定してアプリが OS に従うようにし、ユーザーによる上書きはすべて `Preferences` を通じて永続化してください。Android では `MainActivity` に `ConfigChanges.UiMode` も必要で、システムテーマの切り替えで activity が破棄されないようにします。iOS では `Info.plist` に `UIUserInterfaceStyle` キーが存在しないか、`Automatic` を設定する必要があり、これによりシステムがライトとダークの両方を渡せるようになります。`Application.Current.RequestedThemeChanged` は命令的に何かを変更しなければならないときだけ使用してください。なぜならマークアップ拡張がすでにバインディングを再評価するからです。

この記事では .NET MAUI 11.0.0 と .NET 11 におけるシステムテーマサポートの全範囲を解説します。本番で噛みつく部分も含みます: アプリ再起動をまたいだ永続化、`Info.plist` と `MainActivity` のプラットフォーム設定、`Application.Current.UserAppTheme` 切り替え時の動的なリソース更新、ステータスバーとスプラッシュスクリーンの色、そしてマニフェストのフラグを忘れると有名なように発火を停止する `RequestedThemeChanged` イベントです。すべてのスニペットは .NET 11 SDK の `dotnet new maui` と `Microsoft.Maui.Controls` 11.0.0 に対して検証済みです。

## オペレーティングシステムが実際に提供するもの

ダークモードは単一の機能ではなく、OS レベルで提供される 3 つの異なる振る舞いの集合体であり、それぞれに個別にオプトインする必要があります。

1. オペレーティングシステムが現在のテーマを報告します。iOS 13+ は `UITraitCollection.UserInterfaceStyle` を公開し、Android 10 (API 29)+ は `Configuration.UI_MODE_NIGHT_MASK` を公開し、macOS 10.14+ は `NSAppearance` を公開し、Windows 10+ は `UISettings.GetColorValue(UIColorType.Background)` と `app-mode` レジストリキーを公開します。MAUI はこれら 4 つすべてを `Microsoft.Maui.ApplicationModel.AppTheme` 列挙型に正規化します: `Unspecified`、`Light`、`Dark`。

2. ユーザーがスイッチを切り替えると OS がアプリに通知します。iOS では `traitCollectionDidChange:` を経由して届き、Android では `Activity.OnConfigurationChanged` を経由します (オプトインした場合のみ、詳細は後述)。Windows では `UISettings.ColorValuesChanged` を経由します。MAUI はそれらの集合を静的な `Application.RequestedThemeChanged` イベントとして公開します。

3. OS はアプリがレンダリングされるテーマを上書きすることを許可します。iOS は `UIWindow.OverrideUserInterfaceStyle` を使用し、Android は `AppCompatDelegate.SetDefaultNightMode` を使用し、Windows は `FrameworkElement.RequestedTheme` を使用します。MAUI は上書きを読み書き可能なプロパティ `Application.Current.UserAppTheme` として公開します。

これらの層のいずれかを抜かすと、ダークモードの「シミュレーターでは問題なく見えるがユーザーの携帯電話では壊れている」バージョンになります。この記事の残りの部分は、MAUI アプリがプラットフォーム規約が期待するように応答するように、3 つの層をすべて正しく配線する方法です。

## ライトとダークのリソースを App.xaml に一度だけ定義する

最もきれいなパターンは、テーマに依存するすべての値を `App.xaml` の `StaticResource` として保持し、`AppThemeBinding` を通じてバインドすることです。リソースをアプリケーションスコープに置くことで、すべてのページが同じパレットを参照でき、デザインシステムが変更されたときに 1 つのキーだけリネームできます。

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<?xml version = "1.0" encoding = "UTF-8" ?>
<Application xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="HelloDarkMode.App">
    <Application.Resources>
        <ResourceDictionary>

            <!-- Light palette -->
            <Color x:Key="LightBackground">#FFFFFF</Color>
            <Color x:Key="LightSurface">#F5F5F7</Color>
            <Color x:Key="LightText">#0A0A0B</Color>
            <Color x:Key="LightAccent">#0066FF</Color>

            <!-- Dark palette -->
            <Color x:Key="DarkBackground">#0F1115</Color>
            <Color x:Key="DarkSurface">#1A1D23</Color>
            <Color x:Key="DarkText">#F2F2F2</Color>
            <Color x:Key="DarkAccent">#5B9BFF</Color>

            <Style TargetType="ContentPage" ApplyToDerivedTypes="True">
                <Setter Property="BackgroundColor"
                        Value="{AppThemeBinding Light={StaticResource LightBackground},
                                                Dark={StaticResource DarkBackground}}" />
            </Style>

            <Style TargetType="Label">
                <Setter Property="TextColor"
                        Value="{AppThemeBinding Light={StaticResource LightText},
                                                Dark={StaticResource DarkText}}" />
            </Style>

        </ResourceDictionary>
    </Application.Resources>
</Application>
```

`AppThemeBinding` は `Microsoft.Maui.Controls.Xaml` の `AppThemeBindingExtension` クラスのマークアップ拡張形式です。3 つの値を公開します: `Default`、`Light`、`Dark`。XAML パーサーは `Default=` をコンテンツプロパティとして扱うため、`{AppThemeBinding Red, Light=Green, Dark=Blue}` は「システムがライトまたはダークでない限り赤を使う」の正当な短縮形です。システムテーマが変化すると、MAUI は `AppThemeBindingExtension` をターゲットとするすべてのバインディングを巡回して再評価し、新しい値をバインダブルプロパティのパイプラインに送り出します。更新するためのコードを書く必要はありません。

リソースキーに値しない一回限りの値については、カラーをインラインで記述します:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Border Stroke="{AppThemeBinding Light=#DDD, Dark=#333}"
        BackgroundColor="{AppThemeBinding Light={StaticResource LightSurface},
                                          Dark={StaticResource DarkSurface}}">
    <Label Text="Hello, theme" />
</Border>
```

画像については、同じ拡張がファイル参照を受け取ります:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Image Source="{AppThemeBinding Light=logo_light.png, Dark=logo_dark.png}"
       HeightRequest="48" />
```

## コードビハインドからテーマを適用する

C# でビューを構築したり構築後に変更したりする場合、マークアップ拡張を `VisualElement` の `SetAppThemeColor` および `SetAppTheme<T>` 拡張に置き換えます。これらは `Microsoft.Maui.Controls` に含まれており、マークアップ拡張とまったく同じように動作します: 2 つの値を保存し、現在のテーマを評価し、すべてのテーマ変更で再評価します。

```csharp
// .NET MAUI 11.0.0, .NET 11
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;

var label = new Label { Text = "Hello, theme" };
label.SetAppThemeColor(
    Label.TextColorProperty,
    light: Colors.Black,
    dark: Colors.White);

var image = new Image { HeightRequest = 48 };
image.SetAppTheme<FileImageSource>(
    Image.SourceProperty,
    light: "logo_light.png",
    dark: "logo_dark.png");
```

`SetAppTheme<T>` は `Color` 以外のあらゆる値に対する正しい呼び出しです。`FileImageSource`、`Brush`、`Thickness`、およびターゲットプロパティが受け取るその他の型と動作します。ジェネリック版がそれらすべてをカバーするので、`SetAppThemeBrush` や `SetAppThemeThickness` といった別バージョンはありません。

## 現在のテーマを検出して上書きする

`Application.Current.RequestedTheme` は、OS と `UserAppTheme` の上書きの両方を考慮して、いつでも解決された `AppTheme` 値を返します。控えめに使用してください: 「今ダークモードかどうか」を保持する viewmodel 上の単一の bool は、ほとんどの場合代わりに `AppThemeBinding` を使用すべきサインです。

```csharp
// .NET MAUI 11.0.0, .NET 11
AppTheme current = Application.Current!.RequestedTheme;
bool isDark = current == AppTheme.Dark;
```

テーマの上書きはアプリ内のカウンターパートです。`Application.Current.UserAppTheme` は読み書き可能で、同じ列挙型を受け取ります:

```csharp
// .NET MAUI 11.0.0, .NET 11
Application.Current!.UserAppTheme = AppTheme.Dark;     // force dark
Application.Current!.UserAppTheme = AppTheme.Light;    // force light
Application.Current!.UserAppTheme = AppTheme.Unspecified; // follow system
```

セッターは `RequestedThemeChanged` をトリガーするため、すべてのアクティブな `AppThemeBinding` がただちに再評価されます。ページを再構築したり、リソースディクショナリを入れ替えたり、ナビゲーションのフラッシュをトリガーしたりする必要はありません。

上書きはアプリ再起動を生き残りません。ユーザーの選択が起動をまたいで持続することを望む場合、`Microsoft.Maui.Storage.Preferences` を通じて永続化します:

```csharp
// .NET MAUI 11.0.0, .NET 11
public static class ThemeService
{
    private const string Key = "user_app_theme";

    public static void Apply()
    {
        var stored = (AppTheme)Preferences.Default.Get(Key, (int)AppTheme.Unspecified);
        Application.Current!.UserAppTheme = stored;
    }

    public static void Set(AppTheme theme)
    {
        Preferences.Default.Set(Key, (int)theme);
        Application.Current!.UserAppTheme = theme;
    }
}
```

最初のウィンドウがレンダリングされる前に上書きが適用されるよう、`App.OnStart` (または `InitializeComponent` の直後の `App` コンストラクター) から `ThemeService.Apply()` を呼び出してください。すべてのプラットフォームで `Preferences` には任意の列挙型に対する型付きオーバーロードがなく、`int` 経由でのキャストはポータブルなので、列挙型を `int` として保存します。

## テーマが切り替わったら viewmodel に通知する

コードでテーマの変更に反応する必要があるとき、たとえばカスタム描画した `GraphicsView` を入れ替えたり、別の `StatusBar` カラーをプッシュしたりするときは、`Application.Current.RequestedThemeChanged` をサブスクライブします:

```csharp
// .NET MAUI 11.0.0, .NET 11
public App()
{
    InitializeComponent();
    Application.Current!.RequestedThemeChanged += OnThemeChanged;
}

private void OnThemeChanged(object? sender, AppThemeChangedEventArgs e)
{
    AppTheme theme = e.RequestedTheme;
    UpdateStatusBar(theme);
    UpdateMapStyle(theme);
}
```

イベントハンドラーはメインスレッドで実行されます。`AppThemeChangedEventArgs.RequestedTheme` は新しい解決済みテーマなので、ハンドラー内で再度 `Application.Current.RequestedTheme` を読み取る必要はありません。

イベントが Android で一度も発火しない場合、`MainActivity` に `UiMode` フラグが欠けています。デフォルトの Visual Studio テンプレートには含まれていますが、Xamarin.Forms からの移行中に手作りのプロジェクトがそれを失っているのを見たことがあります。追加してください:

```csharp
// .NET MAUI 11.0.0, .NET 11, Platforms/Android/MainActivity.cs
[Activity(
    Theme = "@style/Maui.SplashTheme",
    MainLauncher = true,
    LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges =
        ConfigChanges.ScreenSize |
        ConfigChanges.Orientation |
        ConfigChanges.UiMode |       // load-bearing for dark mode
        ConfigChanges.ScreenLayout |
        ConfigChanges.SmallestScreenSize |
        ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity { }
```

`ConfigChanges.UiMode` がないと、Android はシステムテーマの変更ごとに activity を破棄して再作成します。これは MAUI が構成更新ではなく新しい activity を見ることを意味し、`RequestedThemeChanged` イベントは同じ `Application` インスタンスから発火しません。目に見える症状は、最初の切り替えは機能するが、その後の切り替えはアプリが終了するまで何もしないというものです。

## 誰も教えてくれないプラットフォーム固有のセットアップ

MAUI のサーフェスはほとんどがクロスプラットフォームですが、ダークモードには見落としやすい小さなプラットフォーム固有のつまみがあります。

**iOS / Mac Catalyst.** `Info.plist` に `UIUserInterfaceStyle` が `Light` または `Dark` に設定されている場合、OS はそのモードにアプリをハードロックし、`Application.RequestedTheme` は永遠にロックされた値を返します。デフォルトの MAUI テンプレートはこのキーを省略しているため、アプリはシステムに従います。明示的にオプトアウトする必要がある場合は、`Automatic` を使用します:

```xml
<!-- Platforms/iOS/Info.plist or Platforms/MacCatalyst/Info.plist -->
<key>UIUserInterfaceStyle</key>
<string>Automatic</string>
```

`Automatic` はまた、以前の開発者が何かを「修正する」ためにキーを `Light` に設定して忘れた場合の正しい値でもあります。キーを完全に削除しても同じ効果があります。

**Android.** `ConfigChanges.UiMode` フラグを超えて確認しなければならないのは、アプリのテーマが `Platforms/Android/Resources/values/styles.xml` で DayNight ベースから継承していることだけです。デフォルトの MAUI テンプレートは `Maui.SplashTheme` と `Maui.MainTheme` を使用しており、両方とも `Theme.AppCompat.DayNight.NoActionBar` を拡張します。スプラッシュテーマをカスタマイズした場合は、親を `DayNight` 祖先に保ってください。そうしないと、アプリの残りがダークになっても、スプラッシュは永遠にライトのままになります。

ダークバリアントが必要な drawable については、`Resources/values-night/colors.xml` に置くか、`-night` リソース修飾子フォルダを使用します。`AppThemeBinding` を通って流れるものはこれを必要としませんが、ネイティブのスプラッシュアートと通知アイコンは必要です。

**Windows.** `Package.appxmanifest` の変更は不要です。Windows アプリホストは WinUI アプリの `Application.RequestedTheme` プロパティを通じてシステムテーマを読み取り、MAUI の `AppThemeBinding` の機構は自動的にそれを経由してルーティングされます。更新されない Windows 専用のサーフェスを見つけた場合、`MauiWinUIApplication.Current.MainWindow.Content` を新しいルートに設定することで強制できますが、11.0.0 では必要ありませんでした。

## ステータスバー、スプラッシュ、その他のネイティブサーフェス

`AppThemeBinding` でカバーされず、ほとんどのプロジェクトを最初の試行で躓かせる 2 つのものがあります:

- **Android と iOS でのステータスバーのテキスト/アイコンカラー** はページの背景ではなくプラットフォームに所有されています。iOS では、ページごとに `UIViewController.PreferredStatusBarStyle` を設定してください。Android では、`MainActivity` から `Window.SetStatusBarColor` を設定してください。最もシンプルなクロスプラットフォームのパターンは、上記の `RequestedThemeChanged` ハンドラー内の `ConditionalCompilation` ブロックの背後にプラットフォーム固有のコードを置くことです。

- **スプラッシュスクリーン** は MAUI が読み込まれる前に OS によってレンダリングされるため、`AppThemeBinding` を消費できません。Android テンプレートは `values/colors.xml` と `values-night/colors.xml` を介して別々のライトおよびナイトカラーを出荷します。iOS は単一のローンチ storyboard を使用するので、両方のモードで機能するニュートラルな色を選ぶか、`LaunchStoryboard` 構成を介して 2 つの storyboard を提供します。

カスタムマップスタイル、チャートパレット、または `WebView` コンテンツがテーマに従う必要がある場合、`RequestedThemeChanged` で切り替えを実行してください。特にマップについては、[MAUI 11 のマップピンクラスタリングのウォークスルー](/ja/2026/04/dotnet-maui-11-map-pin-clustering/) が、レンダラーを再構築せずにマップコントロールの状態をテーマ遷移と同期させる方法を示しています。

## 午後を食い尽くす 5 つの落とし穴

**1. `Page.BackgroundColor` は `UserAppTheme` の変更で常に更新されるとは限りません。** [dotnet/maui#6596](https://github.com/dotnet/maui/issues/6596) の既知の問題は、`UserAppTheme` をプログラム的に設定したときに一部のプロパティが再評価パスを逃すことを意味します。信頼できる回避策は、ページ要素に直接設定するのではなく、`Style` の `Setter` を介して (上記の `App.xaml` の例のように) ページの背景を設定することです。スタイル駆動のセッターは確実に再評価されます。

**2. `RequestedThemeChanged` は一度発火してから黙ります。** これは [dotnet/maui#15350](https://github.com/dotnet/maui/issues/15350) の症状で、Android ではほとんど常に欠けている `ConfigChanges.UiMode` フラグです。iOS では、システムテーマ切り替えの瞬間にスタックにモーダルページがあるときに同等の症状が現れます。モーダルを閉じて開き直すとイベントが復元されます。`App.xaml.cs` で一度サブスクライブし、サブスクリプションを生かしておくのが安全なパターンです。

**3. iOS で `AppTheme.Unspecified` が常に OS にリセットされるとは限りません。** [dotnet/maui#23411](https://github.com/dotnet/maui/issues/23411) で追跡されているように、ハードな上書きの後に `UserAppTheme = AppTheme.Unspecified` を設定すると、iOS ウィンドウが以前の上書きで動かなくなることがあります。11.0.0 での回避策は、MAUI が `UserAppTheme` を設定した後、カスタム `MauiUIApplicationDelegate` から `UIWindow.OverrideUserInterfaceStyle = UIUserInterfaceStyle.Unspecified` を設定することです。数行のコードで、設定で「システムに従う」トグルを公開する場合にのみ必要です。

**4. 構築時に色をスナップショットするカスタムコントロールは永遠にライトのままです。** コントロールのコンストラクター (または静的フィールド) で `Color` 値をキャッシュすると、決して更新されません。テーマ値を `OnHandlerChanged` で遅延的に読み取るか、バインダブルプロパティのパイプラインを介してそれらをバインドして、MAUI の `AppThemeBinding` 機構が再評価できるようにします。

**5. ホットリロードはテーマの変更を常に反映するとは限りません。** アプリがサスペンドされている間にシミュレーターまたはエミュレーターをライトからダークに切り替えると、ホットリロードはキャッシュされたリソースを提供することがあります。開発中にシステムテーマを切り替えた後はフルリビルドを強制してください。これは `AppThemeBinding` のバグではなくツールの成果物であり、変数として除去すると実際の問題の診断がはるかに簡単になります。

## ダークモードがフレームワークの残りと出会う場所

ダークモードは MAUI が出荷する最も簡単なテーマ機能であり、ドキュメントが最も徹底的にカバーしているものですが、おそらく同じ週に触れるであろうフレームワークの他の 2 つの部分と相互作用します。[.NET MAUI で SearchBar のアイコン色を変更する方法](/ja/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) のハンドラーカスタマイズパターンは、ネイティブ部分がダークモードで `TextColor` を無視するコントロール (iOS の `UISearchBar` が標準的な犯人) がある場合の正しい形です。プラットフォームセットアップツアーについては、[.NET MAUI 10 の新機能](/ja/2025/04/whats-new-in-net-maui-10/) の記事が、MAUI 10 で追加され、11.0.0 でも依然として正しいフックである `Window` と `MauiWinUIApplication` の追加をカバーしています。テーマ依存のコントロールをクラスライブラリ内にバンドルしている場合、[MAUI ライブラリでハンドラーを登録する方法](/ja/2023/11/maui-library-register-handlers/) は `MauiAppBuilder` の機構をたどります。これにはハンドラーが解決済みテーマを見るタイミングを決定する操作順序のルールも含まれます。そして、ダークモードの作業がデスクトップ専用ビルド内で起こっている場合、[Windows と macOS のみの MAUI 11 セットアップ](/ja/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) は、Android と iOS のターゲットを削除して、4 つではなく 2 つのプラットフォームだけをデバッグすればよくなる方法を示しています。

## ソースリンク

- [Respond to system theme changes - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/system-theme-changes?view=net-maui-10.0)
- [AppThemeBindingExtension Class - Microsoft.Maui.Controls.Xaml](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.xaml.appthemebindingextension)
- [Application.UserAppTheme Property - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.application.userapptheme?view=net-maui-9.0)
- [AppTheme Enum - Microsoft.Maui.ApplicationModel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.applicationmodel.apptheme)
- [Preferences - Microsoft.Maui.Storage](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences)
- [MAUI sample: Respond to system theme changes](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/userinterface-systemthemes/)
