---
title: "AdMob Smart Banner Sizing in Xamarin Forms"
description: "Wie Sie die korrekte Höhe eines AdMob Smart Banners in Xamarin Forms anhand von Density-Independent Pixels des Bildschirms berechnen."
pubDate: 2017-12-30
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "de"
translationOf: "2017/12/admob-smart-banner-sizing-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
In einem meiner früheren Beiträge, [How To: Add AdMob to your Xamarin Forms app](/de/2015/09/how-to-add-admob-to-your-xamarin-forms-app/), habe ich folgendes Codebeispiel verwendet:

```xml
<controls:AdMobView WidthRequest="320" HeightRequest="50" />
```

Mit Banner-Anzeigen funktioniert das einwandfrei, scheitert aber, sobald Sie ein Smart Banner verwenden möchten. Beim Smart Banner ist die Größenermittlung etwas komplizierter, sie hängt von der Höhe Ihres Geräts ab. Mehr zur Größengebung der AdMob-Ad-Units finden Sie [hier](https://developers.google.com/admob/android/banner).

| Anzeigenhöhe | Bildschirmhöhe          |
|--------------|-------------------------|
| 32 dp        | <= 400 dp               |
| 50 dp        | > 400 dp und <= 720 dp  |
| 90 dp        | > 720 dp                |

Beachten Sie: **dps** sind Density-Independent Pixels. Verwechseln Sie das nicht mit der Bildschirmauflösung Ihres Geräts. Diese Maßeinheit wird sowohl von Android als auch von Xamarin Forms für Größen verwendet. Um die Bildschirmhöhe in dps zu berechnen, nehmen wir die Bildschirmauflösung und teilen sie durch die Density. Dieser Density-Wert ist nicht die DPI des Bildschirms; er ist der Faktor, mit dem Pixel zu dps gruppiert werden. Beispiel: Bei einer Breite von 1080 Pixeln und einer Density von 3 ergibt sich eine tatsächliche Breite von 360 dp.

```cs
var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;
```

So erhalten Sie also die Bildschirmhöhe in dps. Jetzt implementieren wir die Logik hinter der Größentabelle und packen alles in eine Funktion.

```cs
private int GetSmartBannerDpHeight()
{
    var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;

    if (dpHeight <= 400) return 32;
    if (dpHeight > 400 && dpHeight <= 720) return 50;
    return 90;
}
```

## Der AdMob-Renderer

Damit ist es geschafft. In Ihrem AdMobRenderer geben Sie die neue AdBanner-Größe an und nutzen die soeben implementierte Methode, um basierend auf der Geräteanzeige die passende Höhe anzufordern. Der vollständige Renderer für Android sähe so aus:

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

Mehr ist es nicht.
