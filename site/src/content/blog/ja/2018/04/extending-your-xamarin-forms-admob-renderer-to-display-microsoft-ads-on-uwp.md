---
title: "Xamarin Forms の AdMob renderer を拡張して UWP で Microsoft Ads を表示する"
description: "Microsoft Advertising SDK を使い、Xamarin Forms の AdMob renderer を拡張して UWP で Microsoft Ads を表示する方法を解説します。"
pubDate: 2018-04-08
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
lang: "ja"
translationOf: "2018/04/extending-your-xamarin-forms-admob-renderer-to-display-microsoft-ads-on-uwp"
translatedBy: "claude"
translationDate: 2026-05-01
---
これまでは [AdMob と AdMob renderer を使って Android と iOS でだけ広告を表示](/ja/2015/09/how-to-add-admob-to-your-xamarin-forms-app/) してきました。Google は Windows Phone のサポートを完全に打ち切り、UWP には手も付けなかったので、この場面で AdMob は選択肢になりません。

幸い、Microsoft も広告事業を行っており、developer dashboard と Visual Studio に綺麗に統合されているため、アプリで広告を表示するのは比較的簡単です。先ほどの記事の既存の AdMob コードを土台に拡張し、UWP では Microsoft Advertising SDK を使って広告を表示できるようにします。

まずは Windows developer dashboard でアプリを選び、Monetize -- In-app ads から新しい banner unit を作成します。

次に、UWP プロジェクトに NuGet パッケージ Microsoft.Advertising.XAML を追加します。

続いて References を右クリック -- Add references で Universal Windows -- Extensions を開き、"Microsoft Advertising SDK for XAML" にチェックを入れて OK を押します。**メモ:** これら 2 つの手順の後、変更をきちんと反映させるために Visual Studio の再起動が必要になることがあります (例えば、次のコードで namespace が登録されない場合など)。

プロジェクトの準備は終わったので、いよいよ renderer です。順を追って進めますが、コードだけ欲しい方は記事の最後にすべてあります。

最初のステップは AdControl を作ることです。そのために dev center の application ID と AdUnitId が必要です (下のコードに必ず埋めてください)。加えて、ドキュメントで Microsoft が提供しているテスト用 ID をいくつか入れておき、実装を確認できるようにしました。

```cs

var ad = new Microsoft.Advertising.WinRT.UI.AdControl
{
#if !DEBUG
    ApplicationId = "",
    AdUnitId = "",
#endif

#if DEBUG
    ApplicationId = "3f83fe91-d6be-434d-a0ae-7351c5a997f1",
    AdUnitId = "test"
#endif
};
```

次に、画面を最大限活用するために利用可能な幅を求める必要があります。Microsoft からは 300、320、640、728 ピクセル幅の 4 サイズの横長バナーが提供されています。シナリオに合うものを選ぶ必要があります。

これは 3 つの要素に左右されます。

-   アプリの利用可能幅 (画面幅と混同しないでください。デスクトップではアプリは必ずしも全画面ではありません)
-   Xamarin Forms アプリが MasterDetail を使っているか (サイドメニューがあるか)
-   デバイスファミリー (デスクトップかどうかが重要)

ウィンドウの幅を取得するのは簡単です。アプリのルートが MasterDetail の場合、デスクトップではそのサイドメニューが常に表示される (つまり隠れない) ため、アプリの利用可能幅を圧迫します。Xamarin Forms ではサイドバー幅は 320px なので、利用可能幅から差し引きます。renderer にこの設定を扱うための定数プロパティを 2 つ追加します。

```cs
private const bool _hasSideMenu = true;
private const int _sideBarWidth = 320;
```
```cs
var availableWidth = Window.Current.Bounds.Width;
if (_hasSideMenu)
{
var isDesktop = AnalyticsInfo.VersionInfo.DeviceFamily == "Windows.Desktop";
if (isDesktop)
{
availableWidth = Window.Current.Bounds.Width - _sideBarWidth;
}
}
```

次に利用可能幅をもとに広告の幅と高さを決め、ページに表示するスペースが確保されるよう Xamarin Forms 要素の height request を設定します。

```cs
if (availableWidth >= 728)
{
    ad.Width = 728;
    ad.Height = 90;
}
else if (availableWidth >= 640)
{
    ad.Width = 640;
    ad.Height = 100;
}
else if (availableWidth >= 320)
{
    ad.Width = 320;
    ad.Height = 50;
}
else if (availableWidth >= 300)
{
    ad.Width = 300;
    ad.Height = 50;
}

e.NewElement.HeightRequest = ad.Height;

SetNativeControl(ad);
```

以上です。お約束どおり、以下に完全なコードを示します。

```cs
using GazetaSporturilor.Controls;
using GazetaSporturilor.UWP.Renderers;
using Microsoft.Advertising.WinRT.UI;
using Windows.System.Profile;
using Windows.UI.Xaml;
using Xamarin.Forms.Platform.UWP;

[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobRenderer))]

namespace GazetaSporturilor.UWP.Renderers
{
    public class AdMobRenderer : ViewRenderer<AdMobView, AdControl>
    {
        private const bool _hasSideMenu = true;
        private const int _sideBarWidth = 320;

        public AdMobRenderer()
        {

        }

        protected override void OnElementChanged(ElementChangedEventArgs<AdMobView> e)
        {
            base.OnElementChanged(e);

            if (e.NewElement == null)
            {
                return;
            }

            if (Control == null)
            {
                var ad = new Microsoft.Advertising.WinRT.UI.AdControl
                {
#if !DEBUG
                    ApplicationId = "",
                    AdUnitId = "",
#endif

#if DEBUG
                    ApplicationId = "3f83fe91-d6be-434d-a0ae-7351c5a997f1",
                    AdUnitId = "test"
#endif
                };

                var availableWidth = Window.Current.Bounds.Width;
                if (_hasSideMenu)
                {
                    var isDesktop = AnalyticsInfo.VersionInfo.DeviceFamily == "Windows.Desktop";
                    if (isDesktop)
                    {
                        availableWidth = Window.Current.Bounds.Width - _sideBarWidth;
                    }
                }

                if (availableWidth >= 728)
                {
                    ad.Width = 728;
                    ad.Height = 90;
                }
                else if (availableWidth >= 640)
                {
                    ad.Width = 640;
                    ad.Height = 100;
                }
                else if (availableWidth >= 320)
                {
                    ad.Width = 320;
                    ad.Height = 50;
                }
                else if (availableWidth >= 300)
                {
                    ad.Width = 300;
                    ad.Height = 50;
                }

                e.NewElement.HeightRequest = ad.Height;

                SetNativeControl(ad);
            }
        }
    }
}
```
