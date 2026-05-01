---
title: "Cómo añadir AdMob a tu app de MAUI"
description: "Aprende a mostrar anuncios banner de AdMob en tu app de .NET MAUI tanto en Android como en iOS, con configuración paso a paso e implementaciones de handlers específicas por plataforma."
pubDate: 2023-11-17
tags:
  - "maui"
  - "dotnet"
  - "dotnet-8"
lang: "es"
translationOf: "2023/11/how-to-add-admob-to-your-maui-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Una de las primeras cosas en las que la gente piensa al desarrollar para una nueva plataforma o usar una nueva tecnología es la monetización; y en mi caso la pregunta es: ¿qué tan fácil es integrar AdMob? Para .NET MAUI la respuesta sería: 'Depende', depende de la suerte y de la complejidad de lo que quieres lograr; pero detallaré esto a medida que avancemos.

En este artículo vamos a ver cómo mostrar un anuncio banner usando AdMob tanto en Android como en iOS.

Lo primero que tenemos que hacer es agregar los paquetes de AdMob específicos por plataforma:

-   para Android, agrega el paquete NuGet `Xamarin.GooglePlayServices.Ads.Lite`
-   para iOS, agrega el paquete NuGet `Xamarin.Google.iOS.MobileAds`

Una vez instalados los paquetes, es posible que te encuentres con algunos errores de bindings, del estilo:

```plaintext
Type androidx.collection.LongSparseArrayKt$keyIterator$1 is defined multiple times.
```

Eso se debe a conflictos entre las bibliotecas de bindings referenciadas por MAUI y las referenciadas por los paquetes de Xamarin que acabamos de instalar. Podemos arreglarlo forzando una versión específica de paquete. En este caso, queremos instalar:

-   para Android: `Xamarin.AndroidX.Collection.Ktx` versión `1.3.0.1`
-   para iOS: `Xamarin.Build.Download` versión `0.11.4`

Con estos paquetes instalados, tu proyecto debería compilar y ejecutarse sin problemas en ambas plataformas. Ahora vamos al código. Empezamos definiendo nuestra vista de anuncio:

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

A continuación, queremos crear un handler vacío para nuestra vista (un poco más adelante proporcionaremos implementaciones específicas por plataforma para esto):

```cs
internal partial class BannerAdHandler { }
```

Y registramos el handler en tu `MauiProgram.cs`, justo después de `.UseMauiApp()`:

```cs
builder
    .UseMauiApp<App>()
    .ConfigureMauiHandlers(handlers =>
        {
            handlers.AddHandler(typeof(BannerAd), typeof(BannerAdHandler));
        });
```

Con todo configurado, es momento de trabajar en los handlers específicos por plataforma. Estos van en las carpetas `Platforms/Android` y `Platforms/iOS`, respectivamente.

Para Android, el handler se ve así:

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

Y para iOS:

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

Con los handlers específicos por plataforma implementados, podemos usar la vista `BannerAd` en nuestra página. Ve a `MainPage.xaml` y simplemente agrega el `BannerAd` dentro de tu layout:

```xml
<admob:BannerAd AdUnitId="ca-app-pub-3940256099942544/6300978111" />
```

¡Y eso es todo! Si ejecutas la app, ahora deberías ver un anuncio de prueba mostrándose en ambas plataformas.

### Lectura recomendada

-   [GitHub: implementación del plugin AdMob y ejemplo totalmente funcional para .NET MAUI](https://github.com/marius-bughiu/Plugin.AdMob)
