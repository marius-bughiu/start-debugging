---
title: "Tamanho de AdMob Smart Banner no Xamarin Forms"
description: "Como calcular a altura correta de um AdMob Smart Banner no Xamarin Forms com base em density-independent pixels da tela."
pubDate: 2017-12-30
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "pt-br"
translationOf: "2017/12/admob-smart-banner-sizing-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
Em um post anterior, [How To: Add AdMob to your Xamarin Forms app](/pt-br/2015/09/how-to-add-admob-to-your-xamarin-forms-app/), eu mostrei um trecho de código assim:

```xml
<controls:AdMobView WidthRequest="320" HeightRequest="50" />
```

Isso vai funcionar perfeitamente com anúncios Banner, mas vai falhar se você optar pelo Smart Banner. Para o Smart Banner, o sizing é um pouco mais complicado -- depende da altura do dispositivo. Você pode ler mais sobre o sizing das ad units do AdMob [aqui](https://developers.google.com/admob/android/banner).

| Altura do anúncio | Altura da tela          |
|-------------------|-------------------------|
| 32 dp             | <= 400 dp               |
| 50 dp             | > 400 dp e <= 720 dp    |
| 90 dp             | > 720 dp                |

Vale lembrar: **dps** são density-independent pixels. Não confunda com a resolução da tela do dispositivo. Essa é a unidade que tanto o Android quanto o Xamarin Forms usam para tamanhos. Para calcular a altura da tela em dps, pegamos a resolução e dividimos pela density. Esse valor de density não é o DPI da tela; é a escala em que os pixels são agrupados em dps. Por exemplo, para uma largura de tela de 1080 pixels com density 3, você terá uma largura real de 360 dp.

```cs
var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;
```

É assim que se obtém a altura da tela em dps. Agora precisamos implementar a lógica daquela tabela de tamanhos e empacotar tudo numa função.

```cs
private int GetSmartBannerDpHeight()
{
    var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;

    if (dpHeight <= 400) return 32;
    if (dpHeight > 400 && dpHeight <= 720) return 50;
    return 90;
}
```

## O renderer do AdMob

E é isso. No seu AdMobRenderer, você especifica o novo tamanho do AdBanner e usa o método recém-implementado para pedir a altura apropriada com base na tela do dispositivo. O renderer completo para Android ficaria assim:

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

E basicamente é só isso.
