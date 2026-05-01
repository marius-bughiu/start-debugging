---
title: "Размер AdMob Smart Banner в Xamarin Forms"
description: "Как рассчитать корректную высоту AdMob Smart Banner в Xamarin Forms на основе density-independent pixels экрана."
pubDate: 2017-12-30
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ru"
translationOf: "2017/12/admob-smart-banner-sizing-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
В одном из предыдущих постов, [How To: Add AdMob to your Xamarin Forms app](/ru/2015/09/how-to-add-admob-to-your-xamarin-forms-app/), я приводил такой кусочек кода:

```xml
<controls:AdMobView WidthRequest="320" HeightRequest="50" />
```

С Banner-объявлениями это работает идеально, но даст сбой, если вы решите использовать Smart Banner. Для Smart Banner размер чуть сложнее - он зависит от высоты устройства. Подробнее о размерах ad units AdMob можно почитать [здесь](https://developers.google.com/admob/android/banner).

| Высота объявления | Высота экрана           |
|-------------------|-------------------------|
| 32 dp             | <= 400 dp               |
| 50 dp             | > 400 dp и <= 720 dp    |
| 90 dp             | > 720 dp                |

Здесь **dps** - это density-independent pixels. Не путайте их с разрешением экрана устройства. Эта единица измерения используется и в Android, и в Xamarin Forms для размеров. Чтобы вычислить высоту экрана в dps, мы возьмём разрешение экрана и поделим на density. Это значение density - не DPI экрана, а коэффициент, по которому пиксели группируются в dps. Например, при ширине экрана 1080 пикселей и density 3 фактическая ширина будет 360 dp.

```cs
var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;
```

Так получаем высоту экрана в dps. Теперь нужно реализовать логику из таблицы выше и обернуть всё в функцию.

```cs
private int GetSmartBannerDpHeight()
{
    var dpHeight = Resources.DisplayMetrics.HeightPixels / Resources.DisplayMetrics.Density;

    if (dpHeight <= 400) return 32;
    if (dpHeight > 400 && dpHeight <= 720) return 50;
    return 90;
}
```

## Renderer AdMob

Готово. Теперь в вашем AdMobRenderer указываете новый размер AdBanner и используете только что реализованный метод, чтобы запросить нужную высоту с учётом экрана устройства. Полный renderer для Android выглядит так:

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

Вот, собственно, и всё.
