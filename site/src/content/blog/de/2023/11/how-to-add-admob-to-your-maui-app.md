---
title: "AdMob in Ihre MAUI-App einbinden"
description: "Erfahren Sie, wie Sie AdMob-Bannerwerbung in Ihrer .NET MAUI-App auf Android und iOS anzeigen, mit schrittweiser Einrichtung und plattformspezifischen Handler-Implementierungen."
pubDate: 2023-11-17
tags:
  - "maui"
  - "dotnet"
  - "dotnet-8"
lang: "de"
translationOf: "2023/11/how-to-add-admob-to-your-maui-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Eines der ersten Themen, an die man bei der Entwicklung für eine neue Plattform oder mit einer neuen Technologie denkt, ist die Monetarisierung; und in meinem Fall lautet die Frage: Wie einfach lässt sich AdMob integrieren? Für .NET MAUI lautet die Antwort 'Es kommt darauf an'. Es hängt vom Glück und der Komplexität dessen ab, was Sie erreichen möchten; aber das werden wir Schritt für Schritt im Detail durchgehen.

In diesem Artikel sehen wir uns an, wie ein Bannerinserat mit AdMob sowohl auf Android als auch auf iOS angezeigt werden kann.

Als Erstes müssen wir die plattformspezifischen AdMob-Pakete hinzufügen:

-   für Android: NuGet-Paket `Xamarin.GooglePlayServices.Ads.Lite` hinzufügen
-   für iOS: NuGet-Paket `Xamarin.Google.iOS.MobileAds` hinzufügen

Sobald die Pakete installiert sind, kann es zu Bindings-Fehlern kommen, etwa:

```plaintext
Type androidx.collection.LongSparseArrayKt$keyIterator$1 is defined multiple times.
```

Das liegt an Konflikten zwischen den Bindings-Bibliotheken, die von MAUI referenziert werden, und denen, die von den eben installierten Xamarin-Paketen referenziert werden. Wir können das beheben, indem wir eine bestimmte Paketversion erzwingen. In diesem Fall wollen wir Folgendes installieren:

-   für Android: `Xamarin.AndroidX.Collection.Ktx` Version `1.3.0.1`
-   für iOS: `Xamarin.Build.Download` Version `0.11.4`

Sobald diese Pakete installiert sind, sollte Ihr Projekt auf beiden Plattformen ohne Probleme kompilieren und laufen. Nun zum Code. Wir beginnen mit der Definition unserer Werbeansicht:

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

Als Nächstes erstellen wir einen leeren Handler für unsere View (plattformspezifische Implementierungen folgen gleich):

```cs
internal partial class BannerAdHandler { }
```

Und registrieren den Handler in `MauiProgram.cs`, direkt nach `.UseMauiApp()`:

```cs
builder
    .UseMauiApp<App>()
    .ConfigureMauiHandlers(handlers =>
        {
            handlers.AddHandler(typeof(BannerAd), typeof(BannerAdHandler));
        });
```

Mit der Grundstruktur ist es Zeit, die plattformspezifischen Handler zu implementieren. Diese kommen jeweils in die Ordner `Platforms/Android` und `Platforms/iOS`.

Für Android sieht der Handler so aus:

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

Und für iOS:

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

Mit den plattformspezifischen Handlern können wir die `BannerAd`-View nun auf unserer Seite verwenden. Öffnen Sie `MainPage.xaml` und fügen Sie das `BannerAd` einfach in Ihr Layout ein:

```xml
<admob:BannerAd AdUnitId="ca-app-pub-3940256099942544/6300978111" />
```

Das war es! Wenn Sie die App ausführen, sollte nun auf beiden Plattformen ein Testanzeige angezeigt werden.

### Weiterlesen

-   [GitHub: AdMob-Plugin-Implementierung und voll funktionsfähiges Beispiel für .NET MAUI](https://github.com/marius-bughiu/Plugin.AdMob)
