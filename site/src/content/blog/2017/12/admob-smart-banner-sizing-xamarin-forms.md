---
title: "AdMob Smart Banner sizing in Xamarin Forms"
description: "How to calculate the correct AdMob Smart Banner height in Xamarin Forms based on screen density-independent pixels."
pubDate: 2017-12-30
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
---
In one of my previous posts on [How To: Add AdMob to your Xamarin Forms app](/2015/09/how-to-add-admob-to-your-xamarin-forms-app/) I was giving a piece of code that looked like this:

```xml
<controls:AdMobView WidthRequest="320" HeightRequest="50" />
```

That will work perfectly with Banner ads but it’s going to fail if you choose to use a Smart Banner. For a Smart Banner, the sizing is a bit more complicated – it depends on the height of your device. You can find out more on AdMob ad unit sizing [here](https://developers.google.com/admob/android/banner).

| Ad height | Screen height           |
|-----------|-------------------------|
| 32 dp     | <= 400 dp               |
| 50 dp     | > 400 dp and <= 720 dp  |
| 90 dp     | > 720 dp                |

Now, **dps** are density-independent pixels. Do not mistake them for your device's screen resolution. This unit of measure is what both Android and Xamarin Forms use when it comes to sizes. In order to calculate your screen height in dps we'll get the screen resolution and divide it by the density. This density value isn't your screen DPI; it's the scale at which pixels are grouped into dps. For example, for a screen width of 1080 pixels and a density of 3, you will have an actual width of 360dp.

```cs
var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;
```

So that’s how you get your screen height in dps. Now we need to implement the logic behind that size table and wrap it all into a function.

```cs
private int GetSmartBannerDpHeight()
{
    var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;

    if (dpHeight <= 400) return 32;
    if (dpHeight > 400 && dpHeight <= 720) return 50;
    return 90;
}
```

## The AdMob renderer

And that’s it, now in your AdMobRenderer you go ahead and specify the new AdBanner size and use the newly implemented method to request the proper height based on the device’s screen. The complete renderer for Android would look like this:

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

That’s about it.
