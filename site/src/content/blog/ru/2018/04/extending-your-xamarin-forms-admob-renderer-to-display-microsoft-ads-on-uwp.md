---
title: "Расширяем AdMob-renderer Xamarin Forms для показа Microsoft Ads в UWP"
description: "Узнайте, как расширить ваш AdMob-renderer Xamarin Forms, чтобы показывать Microsoft Ads в UWP с помощью Microsoft Advertising SDK."
pubDate: 2018-04-08
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
lang: "ru"
translationOf: "2018/04/extending-your-xamarin-forms-admob-renderer-to-display-microsoft-ads-on-uwp"
translatedBy: "claude"
translationDate: 2026-05-01
---
До сих пор мы [показывали рекламу только на Android и iOS через AdMob и наш AdMob-renderer](/ru/2015/09/how-to-add-admob-to-your-xamarin-forms-app/). Google полностью прекратил поддержку Windows Phone и не стал работать с UWP, поэтому AdMob тут не подходит.

К счастью, Microsoft тоже занимается рекламой и теперь хорошо интегрировала всё в developer dashboard и Visual Studio, что делает довольно лёгким показ рекламы в приложении. Возьмём за основу наш существующий AdMob-код из статьи выше и расширим его так, чтобы на UWP использовать Microsoft Advertising SDK для показа рекламы.

Для начала зайдите в Windows developer dashboard, выберите своё приложение -- Monetize -- In-app ads и создайте новый banner unit.

Затем добавьте NuGet-пакет Microsoft.Advertising.XAML в ваш UWP-проект.

Затем щёлкните правой кнопкой по References -- Add references, перейдите в Universal Windows -- Extensions, поставьте галочку "Microsoft Advertising SDK for XAML" и нажмите OK. **Замечание:** возможно, после этих двух шагов придётся перезапустить Visual Studio, чтобы он подхватил все изменения (например, если он не зарегистрирует namespaces для следующего фрагмента кода).

С настройкой проекта закончили, теперь время для renderer. Пойдём пошагово, но если вам нужен только код - он целиком в конце поста.

Первый шаг - создать AdControl. Для этого нужны application ID и AdUnitId из dev center (заполните их в коде ниже). Также я добавил несколько test ID, которые Microsoft предоставляет в документации, чтобы можно было проверить нашу реализацию.

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

Далее нам нужно определить доступную ширину, чтобы максимально использовать экран. У Microsoft есть 4 размера горизонтальных баннеров - 300, 320, 640 и 728 пикселей в ширину. Нужно выбрать подходящий для нашего сценария.

Это зависит от трёх вещей:

-   Доступной ширины приложения (не путайте с шириной экрана: на десктопе приложение не обязательно во весь экран)
-   Использует ли ваше Xamarin Forms приложение MasterDetail (с боковым меню)
-   Семейства устройства (нам интересно, десктоп это или нет)

Узнать ширину окна несложно. Если ваш app использует MasterDetail в качестве root, то на десктопах боковое меню всегда отображается (то есть не скрывается) и занимает место в доступной ширине. В Xamarin Forms ширина sidebar равна 320px, поэтому вычтем её из доступной ширины. В renderer добавим две константы для управления этой настройкой.

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

Затем выбираем ширину и высоту рекламы по доступной ширине и задаём height request элементу Xamarin Forms, чтобы для отображения хватало места на странице.

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

Вот и всё. Как обещали, ниже полный код.

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
