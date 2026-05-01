---
title: "How To: Xamarin Forms アプリに AdMob を追加する"
description: "Custom view renderer を使い、Xamarin Forms アプリ (Android / iOS) に AdMob 広告を組み込む手順をステップバイステップで解説します。"
pubDate: 2015-09-27
updatedDate: 2023-11-18
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ja"
translationOf: "2015/09/how-to-add-admob-to-your-xamarin-forms-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
新しいプラットフォーム / 新しいテクノロジーで開発する際に、最初に考えることの 1 つがマネタイズです。私の場合の問いは「AdMob はどれくらい簡単に統合できるのか？」というもの。Xamarin Forms に対する答えは「ケースバイケース」で、運と達成したいことの複雑さ次第です。詳細は順を追って説明します。

最初に、必要なコンポーネントをプロジェクトに追加する必要があります。今回は Visual Studio を使いますが、Xamarin Studio でもほぼ同様のはずです。プラットフォームごとに分岐します。

-   Android -- NuGet パッケージ Xamarin.GooglePlayServices.Ads.Lite を追加
-   iOS -- NuGet パッケージ Xamarin.Google.iOS.MobileAds を追加
-   Windows Phone -- ここから SDK をダウンロードして参照に追加 (プラットフォームはサポート終了)

この時点で Android プロジェクトはビルドできなくなり、COMPILETODALVIK : UNEXPECTED TOP-LEVEL エラーが出ているはずです。修正するには、Droid プロジェクトの Properties から Android Options タブを開き、Advanced で Java Max Heap Size の値を 1G にしてください。これでエラーなくビルドできるようになるはずです。

次に、共有 / PCL プロジェクトに新しい Content View を追加し AdMobView と名付けます。コンストラクター内に生成されたコードを削除して、次のような状態にします。

```cs
public class AdMobView : ContentView
{
    public AdMobView() { }
}
```

この新しい view をページに追加します。XAML では次のように書けます。

```xml
<controls:AdMobView />
```

control に何も干渉しないようにしてください。「何も」とは、重なり合う control、ページの padding、control の margin / spacing などのことです。広告 control に何かが重なっていると広告は表示されず、エラーも出ません。注意してください。

次は custom view renderers の追加です。こちらもプラットフォームごとに進めます。

**Android**

新しいクラス AdMobRenderer を以下のコードで追加してください。ExportRenderer 属性は必ず namespace の上に置きます。そうしないと魔法は起きません。

```cs
[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobRenderer))]

namespace AdExample.Droid.Renderers
{
    public class AdMobRenderer : ViewRenderer
    {
        public AdMobRenderer(Context context) : base(context)
        {

        }

        private int GetSmartBannerDpHeight()
        {
            var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;

            if (dpHeight <= 400) return 32;
            if (dpHeight <= 720) return 50;
            return 90;
        }

        protected override void OnElementChanged(ElementChangedEventArgs<View> e)
        {
            base.OnElementChanged(e);

            if (Control == null)
            {
                var ad = new AdView(Context)
                {
                    AdSize = AdSize.SmartBanner,
                    AdUnitId = "ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx"
                };

                var requestbuilder = new AdRequest.Builder();

                ad.LoadAd(requestbuilder.Build());
                e.NewElement.HeightRequest = GetSmartBannerDpHeight();

                SetNativeControl(ad);
            }
        }
    }
}
```

続いて、AdActivity と広告表示に必要な権限 ACCESS\_NETWORK\_STATE、INTERNET を追加するため AndroidManifest.xml を変更します。次の例のとおりです。

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
	<uses-sdk android:minSdkVersion="15" />
	<application>
    <activity android:name="com.google.android.gms.ads.AdActivity" android:configChanges="keyboard|keyboardHidden|orientation|screenLayout|uiMode|screenSize|smallestScreenSize" android:theme="@android:style/Theme.Translucent" />
  </application>
  <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
  <uses-permission android:name="android.permission.INTERNET" />
</manifest>
```

これで完了です。Android のビルドで AdMobView の content view 内に広告が表示されるはずです。

**iOS**

まずは AppDelegate.cs に 1 行追加して、application ID で SDK を初期化します。これは ad unit ID と混同しないでください。LoadApplication 呼び出しの直前に追加します。

```cs
MobileAds.Configure("ca-app-pub-xxxxxxxxxxxxxxxx~xxxxxxxxxx");
```

そして同じように、AdMobRenderer という新しいクラスを追加し、以下のコードを貼り付け、AdmobID を自分の banner unit の ID に置き換えてください。

```cs
[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobRenderer))]

namespace GazetaSporturilor.iOS.Renderers
{
    public class AdMobRenderer : ViewRenderer
    {
        BannerView adView;
        bool viewOnScreen;

        protected override void OnElementChanged(ElementChangedEventArgs<Xamarin.Forms.View> e)
        {
            base.OnElementChanged(e);

            if (e.NewElement == null)
                return;

            if (e.OldElement == null)
            {
                adView = new BannerView(AdSizeCons.SmartBannerPortrait)
                {
                    AdUnitID = "ca-app-pub-xxxxxxxxxxxxxxxx/xxxxxxxxxx",
                    RootViewController = GetRootViewController()
                };

                adView.AdReceived += (sender, args) =>
                {
                    if (!viewOnScreen) this.AddSubview(adView);
                    viewOnScreen = true;
                };

                var request = Request.GetDefaultRequest();

                e.NewElement.HeightRequest = GetSmartBannerDpHeight();
                adView.LoadRequest(request);

                base.SetNativeControl(adView);
            }
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

        private int GetSmartBannerDpHeight()
        {
            var dpHeight = (double)UIScreen.MainScreen.Bounds.Height;

            if (dpHeight <= 400) return 32;
            if (dpHeight <= 720) return 50;
            return 90;
        }
    }
}
```

これで完了です。両プラットフォームで広告が配信されるようになりました。コメントや提案があれば、下のコメント欄でお知らせください。

**2017/12/30 更新**

本記事では Banner 広告の表示を扱い、view サイズを 320 x 50 dp に固定しました。smart banners を実装したい方は、続編をご覧ください: [Xamarin Forms における AdMob Smart Banner のサイズ調整](/ja/2017/12/admob-smart-banner-sizing-xamarin-forms/)

**2018/01/21 更新**

ようやく勇気を出して自分のアプリの 1 つを iOS でビルドしてみたので、最新版の AdMob for Xamarin に対応するよう本記事を更新しました。12/30 の更新で触れた smart sizing のコードも入れています。コメント欄で iOS 実装の手助けをしてくれた皆さん、ありがとう。

### 次に読む

-   [How to: MAUI アプリに AdMob を追加する](/ja/2023/11/how-to-add-admob-to-your-maui-app/)
