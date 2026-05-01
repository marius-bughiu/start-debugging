---
title: "How To: добавляем AdMob в ваше приложение Xamarin Forms"
description: "Пошаговое руководство по интеграции рекламы AdMob в приложение Xamarin Forms на Android и iOS с использованием custom view renderers."
pubDate: 2015-09-27
updatedDate: 2023-11-18
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "ru"
translationOf: "2015/09/how-to-add-admob-to-your-xamarin-forms-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Одно из первых, о чём задумываются при разработке под новую платформу или с использованием новой технологии, - монетизация. И в моём случае вопрос: насколько легко интегрировать AdMob? Для Xamarin Forms ответ - "по-разному": зависит от удачи и от сложности задумки. Но об этом я расскажу по ходу.

Первое, что нужно сделать, - добавить нужные компоненты в проекты. В этом руководстве буду использовать Visual Studio, но в Xamarin Studio всё должно быть похоже. Здесь пути расходятся для каждой платформы:

-   для Android - добавьте NuGet-пакет Xamarin.GooglePlayServices.Ads.Lite
-   для iOS - добавьте NuGet-пакет Xamarin.Google.iOS.MobileAds
-   для Windows Phone - скачайте SDK здесь и добавьте как ссылку (платформа больше не поддерживается)

К этому моменту ваш Android-проект уже должен перестать собираться - получите ошибку COMPILETODALVIK : UNEXPECTED TOP-LEVEL. Чтобы исправить, зайдите в свойства Droid-проекта, выберите вкладку Android Options и в разделе Advanced установите Java Max Heap Size в 1G. Проект должен собраться без ошибок.

Затем в общем / PCL проекте добавьте новый Content View и назовите его AdMobView. Удалите код, сгенерированный в конструкторе, должно получиться так:

```cs
public class AdMobView : ContentView
{
    public AdMobView() { }
}
```

Добавьте новую view в свою страницу. В XAML это можно сделать так:

```xml
<controls:AdMobView />
```

Убедитесь, что НИЧЕГО не мешает control'у. Под "ничего" я имею в виду перекрывающие control'ы, padding страницы, margins/spacing control'ов и т. п. Если что-то перекрывает рекламный control, объявления не покажутся, и ошибки вы тоже не увидите. Так что будьте внимательны.

Теперь пора добавить custom view renderers. Снова - по платформам:

**Android**

Добавьте новый класс AdMobRenderer с кодом ниже. Атрибут ExportRenderer держите над namespace, иначе магия не сработает.

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

Теперь нужно изменить AndroidManifest.xml, чтобы добавить AdActivity и нужные для показа рекламы разрешения: ACCESS\_NETWORK\_STATE, INTERNET; как в примере ниже.

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

Готово. Сборка под Android должна теперь показывать рекламу внутри content view AdMobView.

**iOS**

Начните с одной строки в AppDelegate.cs, чтобы инициализировать SDK с вашим application ID. Внимание: не путайте с ad unit ID. Добавьте перед вызовом LoadApplication.

```cs
MobileAds.Configure("ca-app-pub-xxxxxxxxxxxxxxxx~xxxxxxxxxx");
```

Затем, как и раньше, добавьте новый класс AdMobRenderer и скопируйте код ниже, заменив AdmobID на ID вашего banner unit.

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

Готово. Теперь реклама показывается на обеих платформах. Любые комментарии и предложения - в комментариях ниже.

**Обновление 30 декабря 2017**

В этой статье мы рассмотрели показ Banner-объявлений и захардкодили размер view 320 x 50 dp. Если хотите реализовать smart banners, посмотрите продолжение: [Размер AdMob Smart Banner в Xamarin Forms](/ru/2017/12/admob-smart-banner-sizing-xamarin-forms/)

**Обновление 21 января 2018**

Я наконец собрался с духом и попробовал собрать одно из своих приложений под iOS, поэтому обновил статью под последнюю версию AdMob для Xamarin. Также включил код smart sizing, упомянутый в обновлении от 30 декабря. Спасибо всем, кто помогает в комментариях с реализацией для iOS.

### Читать дальше

-   [How to: добавляем AdMob в ваше приложение MAUI](/ru/2023/11/how-to-add-admob-to-your-maui-app/)
