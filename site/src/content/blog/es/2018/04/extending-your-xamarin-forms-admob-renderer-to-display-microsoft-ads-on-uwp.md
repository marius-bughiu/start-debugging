---
title: "Extender tu renderer de AdMob de Xamarin Forms para mostrar Microsoft Ads en UWP"
description: "Aprende a extender tu renderer de AdMob de Xamarin Forms para mostrar Microsoft Ads en UWP usando el Microsoft Advertising SDK."
pubDate: 2018-04-08
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
lang: "es"
translationOf: "2018/04/extending-your-xamarin-forms-admob-renderer-to-display-microsoft-ads-on-uwp"
translatedBy: "claude"
translationDate: 2026-05-01
---
Hasta ahora hemos estado [mostrando anuncios solo en Android e iOS a través de AdMob y nuestro renderer de AdMob](/es/2015/09/how-to-add-admob-to-your-xamarin-forms-app/). Google dejó por completo de soportar Windows Phone y nunca se molestó con UWP, así que AdMob no es una opción en esta situación.

Por suerte, Microsoft también está en el negocio publicitario y han integrado todo de forma muy clara en el dashboard de desarrollador y en Visual Studio, lo que hace bastante fácil mostrar anuncios en tu aplicación. Vamos a partir de nuestro código existente de AdMob del artículo enlazado arriba y lo extenderemos para usar el Microsoft Advertising SDK y mostrar anuncios en UWP.

Para empezar, ve a tu Windows developer dashboard, selecciona tu app -- Monetize -- In-app ads y crea una nueva unidad banner.

A continuación, añade el paquete NuGet Microsoft.Advertising.XAML a tu proyecto UWP.

Después haz clic derecho en References -- Add references y ve a Universal Windows -- Extensions y marca "Microsoft Advertising SDK for XAML"; luego pulsa OK. **Nota:** puede que tengas que reiniciar Visual Studio tras estos dos pasos para asegurarte de que recoge todos tus cambios (por ejemplo, si no registra los namespaces para el siguiente trozo de código).

Hemos terminado con la configuración del proyecto, es hora del renderer. Iremos paso a paso, pero si solo quieres el código, lo tienes entero al final del post.

El primer paso es crear el AdControl. Para ello necesitamos el application ID y el AdUnitId del dev center (asegúrate de rellenarlos en el código de abajo). Además he añadido algunos test IDs proporcionados por Microsoft en la documentación para poder probar nuestra implementación.

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

Después necesitamos determinar el ancho disponible para sacar el máximo provecho de la pantalla. Microsoft ofrece 4 tamaños de banners horizontales con 300, 320, 640 y 728 píxeles de ancho. Tenemos que decidir cuál es adecuado para nuestro escenario.

Esto depende de tres cosas:

-   El ancho disponible de la aplicación (no lo confundas con el ancho de pantalla, ya que en escritorio la aplicación no está necesariamente a pantalla completa)
-   Si tu app Xamarin Forms usa un MasterDetail (y tiene un menú lateral)
-   La familia de dispositivo (nos interesa si es escritorio o no)

Determinar el ancho de la ventana es bastante sencillo. Ahora, si tu app usa un MasterDetail como root, en escritorios ese menú lateral siempre se mostrará (es decir, no se oculta), así que ocupa espacio del ancho disponible de la aplicación. En Xamarin Forms, el ancho del sidebar es de 320px, así que se lo restaremos al ancho disponible. Añadiremos dos propiedades constantes en nuestro renderer para gestionar esta configuración.

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

A continuación elegimos el ancho y alto del anuncio en función de nuestro ancho disponible y fijamos el height request del elemento Xamarin Forms para asegurarnos de que tenga sitio donde mostrarse en la página.

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

Y ya está. Como prometimos, abajo tienes el código completo.

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
