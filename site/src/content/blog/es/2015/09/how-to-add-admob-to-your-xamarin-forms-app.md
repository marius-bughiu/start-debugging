---
title: "How To: añadir AdMob a tu app de Xamarin Forms"
description: "Guía paso a paso para integrar anuncios de AdMob en tu app Xamarin Forms en Android e iOS usando custom view renderers."
pubDate: 2015-09-27
updatedDate: 2023-11-18
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "es"
translationOf: "2015/09/how-to-add-admob-to-your-xamarin-forms-app"
translatedBy: "claude"
translationDate: 2026-05-01
---
Una de las primeras cosas en las que la gente piensa al desarrollar para una nueva plataforma o usar una nueva tecnología es la monetización; y en mi caso la pregunta es: ¿qué tan fácil es integrar AdMob? Para Xamarin Forms la respuesta sería: "depende": depende de la suerte y de la complejidad de lo que quieras conseguir; pero esto lo iré detallando sobre la marcha.

Lo primero es añadir los componentes necesarios a tus proyectos. Para este walkthrough usaré Visual Studio, pero debería ser bastante similar en Xamarin Studio. Aquí, las cosas se separan para cada plataforma:

-   para Android: añade el paquete NuGet Xamarin.GooglePlayServices.Ads.Lite
-   para iOS: añade el paquete NuGet Xamarin.Google.iOS.MobileAds
-   para Windows Phone: descarga el SDK desde aquí y añádelo como referencia (plataforma ya no soportada)

A estas alturas, tu proyecto Android ya no debería compilar y deberías estar recibiendo un error COMPILETODALVIK : UNEXPECTED TOP-LEVEL. Para arreglarlo, ve a las propiedades de tu proyecto Droid, selecciona la pestaña Android Options y, en Advanced, modifica el valor de Java Max Heap Size a 1G. Tu proyecto debería compilar ahora sin errores.

A continuación, dentro de tu proyecto compartido / PCL añade un nuevo Content View y llámalo AdMobView. Borra el código generado en su constructor y debería verse así:

```cs
public class AdMobView : ContentView
{
    public AdMobView() { }
}
```

Añade esta nueva vista a tu página. En XAML puedes hacerlo así:

```xml
<controls:AdMobView />
```

Asegúrate de que NADA interfiera con el control. Por nada me refiero a controles superpuestos, padding de la página, márgenes/espaciado del control, etc. Si tienes algo que se solape con el control de anuncio, los anuncios no se mostrarán y no recibirás ningún error, así que ten cuidado.

A continuación, es hora de añadir los custom view renderers; y de nuevo, manejaremos cada plataforma:

**Android**

Añade una nueva clase llamada AdMobRenderer con el código de abajo. Asegúrate de mantener el atributo ExportRenderer encima del namespace, si no, la magia no ocurrirá.

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

A continuación, necesitas modificar tu archivo AndroidManifest.xml para añadir la AdActivity y los permisos necesarios para mostrar anuncios: ACCESS\_NETWORK\_STATE, INTERNET; como en el ejemplo de abajo.

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

Y eso es todo. Tu build de Android debería mostrar ahora anuncios dentro del content view AdMobView.

**iOS**

Empieza añadiendo una línea en tu AppDelegate.cs para inicializar el SDK con tu application ID. Cuidado, no lo confundas con tu ad unit ID. Añádelo justo antes de la llamada a LoadApplication.

```cs
MobileAds.Configure("ca-app-pub-xxxxxxxxxxxxxxxx~xxxxxxxxxx");
```

Después, igual que antes, añade una nueva clase llamada AdMobRenderer y copia y pega el código de abajo, reemplazando el AdmobID con el ID de tu unidad banner.

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

Eso es todo. Ahora tienes anuncios servidos en ambas plataformas. Cualquier comentario o sugerencia que tengas, déjalo en la sección de comentarios de abajo.

**Actualización 30 dic 2017**

En este artículo vimos cómo mostrar anuncios Banner y dejamos hardcodeado el tamaño de la vista a 320 x 50 dp. Si quieres implementar smart banners, échale un vistazo a este post de seguimiento: [Tamaño de AdMob Smart Banner en Xamarin Forms](/es/2017/12/admob-smart-banner-sizing-xamarin-forms/)

**Actualización 21 ene 2018**

Por fin reuní el valor para intentar compilar una de mis apps en iOS, así que actualicé este artículo para que funcione con la última versión de AdMob para Xamarin. También he incluido el código de smart sizing que mencioné en la actualización del 30 dic. Gracias a todos los que están echando una mano en la sección de comentarios con la implementación en iOS.

### Lee a continuación

-   [How to: añadir AdMob a tu app MAUI](/es/2023/11/how-to-add-admob-to-your-maui-app/)
