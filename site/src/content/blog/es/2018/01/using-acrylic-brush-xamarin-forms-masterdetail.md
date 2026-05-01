---
title: "UWP - Usar un Acrylic Brush en tu menú MasterDetail de Xamarin Forms"
description: "Aplica el Acrylic Brush de UWP a un menú MasterDetail de Xamarin Forms usando un native renderer específico de plataforma sin librerías de terceros."
pubDate: 2018-01-16
updatedDate: 2023-11-05
tags:
  - "uwp"
  - "xamarin"
  - "xamarin-forms"
lang: "es"
translationOf: "2018/01/using-acrylic-brush-xamarin-forms-masterdetail"
translatedBy: "claude"
translationDate: 2026-05-01
---
Bien, así que eres uno de los que apuntan a UWP con su app Xamarin Forms y quieres usar el nuevo Acrylic Brush para que tu aplicación destaque. No se diga más.

![Menú Acrylic de Gazeta en UWP](https://image.ibb.co/fTPyrm/gazeta_acrylic.gif)

No usaremos ninguna librería ni paquete de terceros para hacer esto y trabajaremos en el proyecto específico de plataforma; abre tu **MainPage.xaml.cs** dentro de tu proyecto UWP. Lo primero que hay que hacer es obtener una referencia a la página Master de tu MasterDetail. En mi caso, el MasterDetail es mi MainPage, así que es bastante directo.

```cs
var masterPage = (app.MainPage as Xamarin.Forms.MasterDetailPage).Master;
```

A continuación, necesitas el native renderer para la página Master. Esto es lo que nos permitirá modificar el Background brush.

```cs
var renderer = Platform.GetRenderer(masterPage) as PageRenderer;
```

Ahora crea tu brush y asígnalo al renderer. Esto sobrescribirá cualquier BackgroundColor que hayas establecido en tu ContentPage en XAML, y eso está bien: Android e iOS seguirán usando el valor que definiste en XAML, mientras que en UWP usarás el nuevo AcrylicBrush.

```cs
var acrylicBrush = new Windows.UI.Xaml.Media.AcrylicBrush();
acrylicBrush.BackgroundSource = Windows.UI.Xaml.Media.AcrylicBackgroundSource.HostBackdrop;
acrylicBrush.TintColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.FallbackColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
acrylicBrush.TintOpacity = 0.8;

renderer.Background = acrylicBrush;
```

He puesto TintColor y FallbackColor para que coincidan con el color que definí en XAML, y para la opacidad elegí 80%. Juega con estos valores hasta obtener el efecto deseado. En cuanto a qué hace exactamente cada propiedad:

> -   **TintColor**: la capa superpuesta de color/tinte. Considera especificar tanto el valor de color RGB como la opacidad del canal alfa.
> -   **TintOpacity**: la opacidad de la capa de tinte. Recomendamos un 80% de opacidad como punto de partida, aunque otros colores pueden lucir mejor con otras transparencias.
> -   **BackgroundSource**: el flag para indicar si quieres acrylic de fondo o in-app.
> -   **FallbackColor**: el color sólido que reemplaza al acrylic en modo de batería baja. Para background acrylic, el fallback color también sustituye al acrylic cuando tu app no está en la ventana activa del escritorio o cuando la app corre en teléfono o Xbox.

Puedes leer [esto](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic) para más información sobre cómo funciona el material Acrylic. Por si algo no funciona, aquí está el MainPage completo:

```cs
public sealed partial class MainPage
{
    public MainPage()
    {
        this.InitializeComponent();
        var app = new GazetaSporturilor.App();
        LoadApplication(app);

        var masterPage = (app.MainPage as Xamarin.Forms.MasterDetailPage).Master;
        var renderer = Platform.GetRenderer(masterPage) as PageRenderer;

        var acrylicBrush = new Windows.UI.Xaml.Media.AcrylicBrush();
        acrylicBrush.BackgroundSource = Windows.UI.Xaml.Media.AcrylicBackgroundSource.HostBackdrop;
        acrylicBrush.TintColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
        acrylicBrush.FallbackColor = Windows.UI.Color.FromArgb(255, 168, 29, 43);
        acrylicBrush.TintOpacity = 0.8;

        renderer.Background = acrylicBrush;
    }
}
```
