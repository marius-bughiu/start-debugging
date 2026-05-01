---
title: "Как добавить AdMob в ваше приложение на MAUI"
description: "Узнайте, как отображать баннерную рекламу AdMob в вашем приложении .NET MAUI на Android и iOS, с пошаговой настройкой и платформенно-специфичными реализациями обработчиков."
pubDate: 2023-11-17
tags:
  - "maui"
  - "dotnet"
  - "dotnet-8"
lang: "ru"
translationOf: "2023/11/how-to-add-admob-to-your-maui-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Одна из первых вещей, о которых задумываются при разработке для новой платформы или при использовании новой технологии, это монетизация; и в моём случае вопрос звучит так: насколько легко интегрировать AdMob? Для .NET MAUI ответ будет 'Зависит от обстоятельств': от везения и от сложности того, чего вы хотите добиться; но мы будем разбирать всё по ходу статьи.

В этой статье мы рассмотрим, как отобразить баннерную рекламу с помощью AdMob как на Android, так и на iOS.

Первое, что нам нужно сделать, это добавить специфичные для платформы пакеты AdMob:

-   для Android добавьте NuGet-пакет `Xamarin.GooglePlayServices.Ads.Lite`
-   для iOS добавьте NuGet-пакет `Xamarin.Google.iOS.MobileAds`

После установки пакетов вы можете столкнуться с ошибками bindings вида:

```plaintext
Type androidx.collection.LongSparseArrayKt$keyIterator$1 is defined multiple times.
```

Это связано с конфликтами между bindings-библиотеками, на которые ссылается MAUI, и теми, на которые ссылаются только что установленные пакеты Xamarin. Мы можем исправить это, принудительно указав определённую версию пакета. В данном случае нам нужно установить:

-   для Android: `Xamarin.AndroidX.Collection.Ktx` версии `1.3.0.1`
-   для iOS: `Xamarin.Build.Download` версии `0.11.4`

После установки этих пакетов ваш проект должен собираться и запускаться без проблем на обеих платформах. Теперь к коду. Начнём с определения нашей view рекламы:

```cs
public class BannerAd : ContentView
{
    public static readonly BindableProperty AdUnitIdProperty =
        BindableProperty.Create("AdUnitId", typeof(string), typeof(BannerAd), null);

    public string AdUnitId
    {
        get { return (string)GetValue(AdUnitIdProperty); }
        set { SetValue(AdUnitIdProperty, value); }
    }
}
```

Затем нам нужно создать пустой обработчик для нашей view (платформенно-специфичные реализации мы предоставим чуть позже):

```cs
internal partial class BannerAdHandler { }
```

И зарегистрировать обработчик в `MauiProgram.cs`, сразу после `.UseMauiApp()`:

```cs
builder
    .UseMauiApp<App>()
    .ConfigureMauiHandlers(handlers =>
        {
            handlers.AddHandler(typeof(BannerAd), typeof(BannerAdHandler));
        });
```

Когда всё настроено, пора заняться платформенно-специфичными обработчиками. Они помещаются в папки `Platforms/Android` и `Platforms/iOS` соответственно.

Для Android обработчик будет выглядеть так:

```cs
internal partial class BannerAdHandler : ViewHandler<BannerAd, AdView>
{
    public static IPropertyMapper<BannerAd, BannerAdHandler> PropertyMapper = 
      new PropertyMapper<BannerAd, BannerAdHandler>(ViewMapper);


    public BannerAdHandler() : base(PropertyMapper) { }

    protected override void DisconnectHandler(AdView platformView)
    {
        platformView.Dispose();
        base.DisconnectHandler(platformView);
    }

    protected override AdView CreatePlatformView()
    {
        var adView = new AdView(Context)
        {
            AdSize = GetAdSize(),
            AdUnitId = VirtualView.AdUnitId
        };

        VirtualView.HeightRequest = 90;

        var request = new AdRequest.Builder().Build();
        adView.LoadAd(request);

        return adView;
    }
}
```

А для iOS:

```cs
internal partial class BannerAdHandler : ViewHandler<BannerAd, BannerView>
{
    public static IPropertyMapper<BannerAd, BannerAdHandler> PropertyMapper = 
      new PropertyMapper<BannerAd, BannerAdHandler>(ViewMapper);

    public BannerAdHandler() : base(PropertyMapper) { }

    protected override void DisconnectHandler(BannerView platformView)
    {
        platformView.Dispose();
        base.DisconnectHandler(platformView);
    }

    protected override BannerView CreatePlatformView()
    {
        var adSize = AdSizeCons.GetCurrentOrientationAnchoredAdaptiveBannerAdSize((float)UIScreen.MainScreen.Bounds.Width);
        var adView = new BannerView(adSize)
        {
            AdUnitId = VirtualView.AdUnitId,
            RootViewController = GetRootViewController()
        };
        
        VirtualView.HeightRequest = 90;

        var request = Request.GetDefaultRequest();
        adView.LoadRequest(request);

        return adView;
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
}
```

После реализации платформенно-специфичных обработчиков мы можем использовать view `BannerAd` на нашей странице. Откройте `MainPage.xaml` и просто добавьте `BannerAd` в ваш layout:

```xml
<admob:BannerAd AdUnitId="ca-app-pub-3940256099942544/6300978111" />
```

И это всё! Если вы запустите приложение, на обеих платформах теперь должна отображаться тестовая реклама.

### Что почитать дальше

-   [GitHub: реализация плагина AdMob и полностью рабочий пример для .NET MAUI](https://github.com/marius-bughiu/Plugin.AdMob)
