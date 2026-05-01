---
title: "Animar fondos con Xamarin Forms"
description: "Crea un efecto de fondo animado y fluido en Xamarin Forms usando animaciones ScaleTo sobre BoxViews superpuestos."
pubDate: 2019-01-02
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "xamarin"
  - "xamarin-forms"
lang: "es"
translationOf: "2019/01/animating-backgrounds-with-xamarin-forms"
translatedBy: "claude"
translationDate: 2026-05-01
---
Empecé a juguetear con animaciones en Xamarin Forms hace poco y creé una animación de fondo chula para una de mis apps (Charades for Dota 2) que pensé en compartir. Sin más rodeos, este es el resultado final:

![](/wp-content/uploads/2019/01/animations3.gif)

El GIF se ve un poco entrecortado, pero solo porque mi PC no maneja bien el emulador. En un dispositivo, las animaciones son fluidas.

Vamos al lío. Primero, elegimos los colores. En nuestro caso, necesitamos 5 colores: uno como fondo de la app y 4 para las distintas capas que queremos animar. Para facilitar las cosas, elige un [color de Material Design](https://material-ui.com/style/color/); usaremos las tonalidades del 500 al 900. Añade estos colores como recursos en tu app o página.

```xml
<ContentPage.Resources>
        <Color x:Key="Color500">#2196F3</Color>
        <Color x:Key="Color600">#1E88E5</Color>
        <Color x:Key="Color700">#1976D2</Color>
        <Color x:Key="Color800">#1565C0</Color>
        <Color x:Key="Color900">#0D47A1</Color>
</ContentPage.Resources>
```

A continuación, prepara la página de modo que tengas 4 capas de fondo, siendo cada una un `BoxView` con su propio color. Fíjate en cómo ordenamos los colores del más oscuro al más claro.

```xml
<Grid x:Name="LayoutRoot" BackgroundColor="{StaticResource Color900}">
        <BoxView x:Name="BackgroundLayer1" BackgroundColor="{StaticResource Color800}" />
        <BoxView x:Name="BackgroundLayer2" BackgroundColor="{StaticResource Color700}" />
        <BoxView x:Name="BackgroundLayer3" BackgroundColor="{StaticResource Color600}" />
        <BoxView x:Name="BackgroundLayer4" BackgroundColor="{StaticResource Color500}" />
</Grid>
```

Con la página lista, lo único que queda es animar las capas individuales. En nuestro caso, escalamos cada capa hacia arriba y hacia abajo con el método `ScaleTo`, que recibe tres parámetros: la escala hacia la que animar, la duración de la animación en milisegundos y la función de easing a usar; los dos últimos parámetros son opcionales. Así encogemos una capa:

```cs
await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
```

Una vez encogida la capa -- fíjate cómo hacemos `await` para esperar a que termine la animación --, hay que hacer la animación opuesta y agrandarla. Y necesitamos hacer esto en un bucle:

```cs
while (true)
{
    await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
    await BackgroundLayer1.ScaleTo(1.2, 1750, Easing.SinInOut);
}
```

Haz lo mismo con las 4 capas dentro de bucles separados y obtendrás el mismo efecto que en el GIF anterior. Abajo tienes el código completo para animar las 4 capas.

```cs
public partial class MainPage : ContentPage
{
    public MainPage()
    {
        InitializeComponent();
        AnimateBackground();
    }

    private void AnimateBackground()
    {
        AnimateBackgroundLayer1();
        AnimateBackgroundLayer2();
        AnimateBackgroundLayer3();
        AnimateBackgroundLayer4();
    }

    private async void AnimateBackgroundLayer1()
    {
        while (true)
        {
            await BackgroundLayer1.ScaleTo(0.9, 2500, Easing.SinOut);
            await BackgroundLayer1.ScaleTo(1.2, 1750, Easing.SinInOut);
        }
    }

    private async void AnimateBackgroundLayer2()
    {
        while (true)
        {
            await BackgroundLayer2.ScaleTo(0.8, 2750, Easing.SinOut);
            await BackgroundLayer2.ScaleTo(1, 2250, Easing.SinInOut);
        }
    }

    private async void AnimateBackgroundLayer3()
    {
        while (true)
        {
            await BackgroundLayer3.ScaleTo(0.7, 3000, Easing.SinInOut);
            await BackgroundLayer3.ScaleTo(0.9, 2500, Easing.SinOut);
        }
    }

    private async void AnimateBackgroundLayer4()
    {
        while (true)
        {
            await BackgroundLayer4.ScaleTo(0.6, 1750, Easing.SinOut);
            await BackgroundLayer4.ScaleTo(0.8, 2000, Easing.SinInOut);
        }
    }
}
```

Eso es todo. Si algo no funciona y necesitas ayuda, deja un comentario abajo. El ejemplo completo vivía originalmente en GitHub, pero el repositorio ya no está disponible.
