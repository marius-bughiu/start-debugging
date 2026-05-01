---
title: "Tamaño de AdMob Smart Banner en Xamarin Forms"
description: "Cómo calcular la altura correcta de un AdMob Smart Banner en Xamarin Forms basándose en density-independent pixels de la pantalla."
pubDate: 2017-12-30
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "es"
translationOf: "2017/12/admob-smart-banner-sizing-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
En uno de mis posts anteriores, [How To: Add AdMob to your Xamarin Forms app](/es/2015/09/how-to-add-admob-to-your-xamarin-forms-app/), daba un trozo de código que se veía así:

```xml
<controls:AdMobView WidthRequest="320" HeightRequest="50" />
```

Eso funcionará perfectamente con anuncios Banner, pero fallará si optas por usar un Smart Banner. Para un Smart Banner, el tamaño es algo más complicado, depende de la altura del dispositivo. Puedes leer más sobre el tamaño de las ad units de AdMob [aquí](https://developers.google.com/admob/android/banner).

| Alto del anuncio | Alto de la pantalla     |
|------------------|-------------------------|
| 32 dp            | <= 400 dp               |
| 50 dp            | > 400 dp y <= 720 dp    |
| 90 dp            | > 720 dp                |

Ahora bien, los **dps** son density-independent pixels. No los confundas con la resolución de la pantalla del dispositivo. Esta unidad de medida es la que usan tanto Android como Xamarin Forms para los tamaños. Para calcular la altura de la pantalla en dps, obtenemos la resolución y la dividimos por la density. Este valor de density no es el DPI de la pantalla; es la escala con la que los píxeles se agrupan en dps. Por ejemplo, para un ancho de pantalla de 1080 píxeles y una density de 3, tendrás un ancho real de 360 dp.

```cs
var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;
```

Así obtienes la altura de la pantalla en dps. Ahora necesitamos implementar la lógica detrás de esa tabla de tamaños y envolverla en una función.

```cs
private int GetSmartBannerDpHeight()
{
    var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;

    if (dpHeight <= 400) return 32;
    if (dpHeight > 400 && dpHeight <= 720) return 50;
    return 90;
}
```

## El renderer de AdMob

Y ya está. Ahora en tu AdMobRenderer especificas el nuevo tamaño del AdBanner y usas el método recién implementado para pedir la altura adecuada según la pantalla del dispositivo. El renderer completo para Android se vería así:

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

Y básicamente eso es todo.
