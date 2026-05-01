---
title: "Xamarin Forms - Usar OnPlatform"
description: "Aprende a usar OnPlatform en Xamarin Forms para establecer valores de propiedades específicos por plataforma, tanto en XAML como en C#."
pubDate: 2019-07-27
updatedDate: 2023-11-05
tags:
  - "xamarin"
  - "xamarin-forms"
lang: "es"
translationOf: "2019/07/xamarin-forms-using-onplatform"
translatedBy: "claude"
translationDate: 2026-05-01
---
Al desarrollar aplicaciones Xamarin Forms te encontrarás a menudo en situaciones donde necesitas establecer valores diferentes para una determinada propiedad según el sistema operativo.

OnPlatform te permite hacer exactamente eso y se puede usar tanto desde código C# como desde XAML. Veamos algunos ejemplos. Para este artículo trabajaremos con un nuevo proyecto master-detail.

## Usar OnPlatform con XAML

En la página About hay un botón Learn More. Vamos a hacer su color dependiente de la plataforma: verde para Android, naranja para iOS y morado para UWP.

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
    BackgroundColor="{OnPlatform Android=Green, iOS=Orange, UWP=Purple}"
    Command="{Binding OpenWebCommand}"
    TextColor="White" />
```

Y veamos el resultado:

![](/wp-content/uploads/2019/07/xamarin-forms-on-platform.png)

Como alternativa, también puedes usar la siguiente sintaxis, más cómoda cuando trabajas con tipos de dato más sofisticados.

```xml
<Button Margin="0,10,0,0" Text="Learn more" 
        Command="{Binding OpenWebCommand}"
        TextColor="White">
    <Button.BackgroundColor>
        <OnPlatform x:TypeArguments="Color">
            <On Platform="Android" Value="Green"/>
            <On Platform="iOS" Value="Orange"/>
            <On Platform="UWP" Value="Purple"/>
        </OnPlatform>
    </Button.BackgroundColor>
</Button>
```

## Usar OnPlatform con C# (obsoleto)

Mismos requisitos que antes, pero esta vez desde C# en lugar de XAML. Primero le pondremos a nuestro botón un x:Name="LearnMoreButton" y luego, en el code-behind, escribiremos lo siguiente:

```cs
Device.OnPlatform(
    Android: () => this.LearnMoreButton.BackgroundColor = Color.Green, 
    iOS: () => this.LearnMoreButton.BackgroundColor = Color.Orange, 
    WinPhone: () => this.LearnMoreButton.BackgroundColor = Color.Purple,
    Default: () => this.LearnMoreButton.BackgroundColor = Color.Black);
```

Mismo resultado que antes. WinPhone mapea a UWP y, además, puedes especificar un valor por defecto para el resto de plataformas. Este método está obsoleto desde XF 2.3.4, y se recomienda escribir tu propio switch case sobre Device.RuntimePlatform en su lugar.

## Usar Device.RuntimePlatform en su lugar

El código anterior se puede traducir a:

```cs
switch (Device.RuntimePlatform)
{
    case Device.Android:
        LearnMoreButtonSwitch.BackgroundColor = Color.Green;
        break;
    case Device.iOS:
        LearnMoreButtonSwitch.BackgroundColor = Color.Orange;
        break;
    case Device.UWP:
        LearnMoreButtonSwitch.BackgroundColor = Color.Purple;
        break;
     default:
         LearnMoreButtonSwitch.BackgroundColor = Color.Black;
         break;
}
```

Los valores de plataforma soportados actualmente son: iOS, Android, UWP, macOS, GTK, Tizen y WPF.

El código fuente del proyecto de ejemplo vivía originalmente en GitHub, pero el repositorio ya no está disponible.
