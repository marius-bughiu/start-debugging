---
title: "MAUI アプリに AdMob を追加する方法"
description: "Android と iOS の両方の .NET MAUI アプリで AdMob のバナー広告を表示する方法を、ステップバイステップのセットアップとプラットフォーム別ハンドラーの実装とともに解説します。"
pubDate: 2023-11-17
tags:
  - "maui"
  - "dotnet"
  - "dotnet-8"
lang: "ja"
translationOf: "2023/11/how-to-add-admob-to-your-maui-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
新しいプラットフォーム向けに開発したり、新しい技術を使ったりする際に最初に考えることのひとつが収益化です。私の場合の問いは「AdMob はどれくらい簡単に統合できるのか」になります。.NET MAUI に対する答えは「状況による」、つまり運と達成したいことの複雑さによります。とはいえ、これから順を追って詳しく説明していきます。

この記事では、Android と iOS の両方で AdMob を使ってバナー広告を表示する方法を見ていきます。

最初に行うのは、プラットフォーム固有の AdMob パッケージを追加することです。

-   Android では NuGet パッケージ `Xamarin.GooglePlayServices.Ads.Lite` を追加します
-   iOS では NuGet パッケージ `Xamarin.Google.iOS.MobileAds` を追加します

パッケージをインストールすると、次のような bindings エラーに遭遇することがあります。

```plaintext
Type androidx.collection.LongSparseArrayKt$keyIterator$1 is defined multiple times.
```

これは、MAUI が参照する bindings ライブラリと、先ほどインストールした Xamarin パッケージが参照するライブラリの競合によるものです。特定のパッケージバージョンを強制することで解決できます。この場合、次をインストールします。

-   Android: `Xamarin.AndroidX.Collection.Ktx` バージョン `1.3.0.1`
-   iOS: `Xamarin.Build.Download` バージョン `0.11.4`

これらのパッケージをインストールすれば、プロジェクトはどちらのプラットフォームでも問題なくビルドおよび実行できるようになるはずです。それではコードに移ります。まずは広告ビューを定義します。

```cs
public class BannerAd : ContentView
{
    public static readonly BindableProperty AdUnitIdProperty =
        BindableProperty.Create("AdUnitId", typeof(string), typeof(BannerAd), null);

    public string AdUnitId
    {
        get { return (string)GetValue(AdUnitIdProperty); }
        set { SetValue(AdUnitIdProperty, value); }
    }
}
```

次に、このビュー用に空のハンドラーを作成します（プラットフォーム固有の実装は後ほど用意します）。

```cs
internal partial class BannerAdHandler { }
```

そして `MauiProgram.cs` の `.UseMauiApp()` の直後にハンドラーを登録します。

```cs
builder
    .UseMauiApp<App>()
    .ConfigureMauiHandlers(handlers =>
        {
            handlers.AddHandler(typeof(BannerAd), typeof(BannerAdHandler));
        });
```

土台が整ったので、プラットフォーム固有のハンドラーに取りかかります。これらはそれぞれ `Platforms/Android` および `Platforms/iOS` フォルダーに配置します。

Android の場合、ハンドラーは次のようになります。

```cs
internal partial class BannerAdHandler : ViewHandler<BannerAd, AdView>
{
    public static IPropertyMapper<BannerAd, BannerAdHandler> PropertyMapper = 
      new PropertyMapper<BannerAd, BannerAdHandler>(ViewMapper);


    public BannerAdHandler() : base(PropertyMapper) { }

    protected override void DisconnectHandler(AdView platformView)
    {
        platformView.Dispose();
        base.DisconnectHandler(platformView);
    }

    protected override AdView CreatePlatformView()
    {
        var adView = new AdView(Context)
        {
            AdSize = GetAdSize(),
            AdUnitId = VirtualView.AdUnitId
        };

        VirtualView.HeightRequest = 90;

        var request = new AdRequest.Builder().Build();
        adView.LoadAd(request);

        return adView;
    }
}
```

iOS の場合は次の通りです。

```cs
internal partial class BannerAdHandler : ViewHandler<BannerAd, BannerView>
{
    public static IPropertyMapper<BannerAd, BannerAdHandler> PropertyMapper = 
      new PropertyMapper<BannerAd, BannerAdHandler>(ViewMapper);

    public BannerAdHandler() : base(PropertyMapper) { }

    protected override void DisconnectHandler(BannerView platformView)
    {
        platformView.Dispose();
        base.DisconnectHandler(platformView);
    }

    protected override BannerView CreatePlatformView()
    {
        var adSize = AdSizeCons.GetCurrentOrientationAnchoredAdaptiveBannerAdSize((float)UIScreen.MainScreen.Bounds.Width);
        var adView = new BannerView(adSize)
        {
            AdUnitId = VirtualView.AdUnitId,
            RootViewController = GetRootViewController()
        };
        
        VirtualView.HeightRequest = 90;

        var request = Request.GetDefaultRequest();
        adView.LoadRequest(request);

        return adView;
    }

    private UIViewController GetRootViewController()
    {
        foreach (UIWindow window in UIApplication.SharedApplication.Windows)
        {
            if (window.RootViewController != null)
            {
                return window.RootViewController;
            }
        }

        return null;
    }
}
```

プラットフォーム固有のハンドラーが実装できたので、ページで `BannerAd` ビューを使うことができます。`MainPage.xaml` を開き、レイアウト内に `BannerAd` を追加するだけです。

```xml
<admob:BannerAd AdUnitId="ca-app-pub-3940256099942544/6300978111" />
```

これで完了です。アプリを実行すると、両方のプラットフォームでテスト広告が表示されるはずです。

### 次に読む

-   [GitHub: .NET MAUI 向けの AdMob プラグインの実装と完全に動作するサンプル](https://github.com/marius-bughiu/Plugin.AdMob)
