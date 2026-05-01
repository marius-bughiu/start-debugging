---
title: "Xamarin Forms における AdMob Smart Banner のサイズ調整"
description: "Xamarin Forms で、画面の density-independent pixel をもとに AdMob Smart Banner の正しい高さを算出する方法を解説します。"
pubDate: 2017-12-30
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ja"
translationOf: "2017/12/admob-smart-banner-sizing-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
以前の記事 [How To: Add AdMob to your Xamarin Forms app](/ja/2015/09/how-to-add-admob-to-your-xamarin-forms-app/) で、次のようなコードを紹介しました。

```xml
<controls:AdMobView WidthRequest="320" HeightRequest="50" />
```

これは Banner 広告であれば問題なく動きますが、Smart Banner を使う場合はうまくいきません。Smart Banner の場合、サイズの扱いはもう少し複雑で、デバイスの高さに依存します。AdMob の ad unit のサイズについての詳細は [こちら](https://developers.google.com/admob/android/banner) をご覧ください。

| 広告の高さ | 画面の高さ              |
|------------|-------------------------|
| 32 dp      | <= 400 dp               |
| 50 dp      | > 400 dp かつ <= 720 dp |
| 90 dp      | > 720 dp                |

ここで言う **dps** とは density-independent pixels のことです。デバイスの画面解像度と混同しないでください。これは Android と Xamarin Forms の双方がサイズに用いる単位です。画面の高さを dps で計算するには、画面解像度を density で割ります。この density は画面の DPI ではなく、ピクセルが dps にまとめられる際のスケールです。例えば画面幅が 1080 ピクセルで density が 3 なら、実際の幅は 360 dp になります。

```cs
var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;
```

これが画面の高さを dps で得る方法です。次に、上の表のロジックを実装し、関数にまとめます。

```cs
private int GetSmartBannerDpHeight()
{
    var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;

    if (dpHeight <= 400) return 32;
    if (dpHeight > 400 && dpHeight <= 720) return 50;
    return 90;
}
```

## AdMob renderer

これで完了です。AdMobRenderer 内で新しい AdBanner サイズを指定し、新しく実装したメソッドを使ってデバイスの画面に応じた適切な高さを要求します。Android 用の renderer の完全版は次のようになります。

```cs
[assembly: ExportRenderer(typeof(AdMobView), typeof(AdMobRenderer))]

namespace GazetaSporturilor.Droid.Renderers
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
            if (dpHeight > 400 && dpHeight <= 720) return 50;
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
                    AdUnitId = "_your_admob_ad_unit_id_goes_here_"
                };

                var requestbuilder = new AdRequest.Builder();

#if !DEBUG
                ad.LoadAd(requestbuilder.Build());
                e.NewElement.HeightRequest = GetSmartBannerDpHeight();
#endif

                SetNativeControl(ad);
            }
        }
    }
}
```

ざっくりこんな感じです。
