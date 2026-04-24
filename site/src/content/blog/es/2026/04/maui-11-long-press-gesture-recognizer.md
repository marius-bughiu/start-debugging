---
title: ".NET MAUI 11 incluye un LongPressGestureRecognizer integrado"
description: ".NET MAUI 11 Preview 3 agrega LongPressGestureRecognizer como gesto de primera clase, con duration, umbral de movimiento, eventos de state, y binding de command, reemplazando el behavior común del Community Toolkit."
pubDate: 2026-04-16
tags:
  - "dotnet-maui"
  - "dotnet-11"
  - "xaml"
  - "mobile"
lang: "es"
translationOf: "2026/04/maui-11-long-press-gesture-recognizer"
translatedBy: "claude"
translationDate: 2026-04-24
---

Hasta ahora, detectar un long press en .NET MAUI significaba recurrir a un behavior de terceros, al [TouchBehavior del Community Toolkit](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/maui/behaviors/touch-behavior), o escribir platform handlers por OS. [.NET MAUI 11 Preview 3](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/) promueve el patrón a un API de primera clase con `LongPressGestureRecognizer`, llegando vía [dotnet/maui #33432](https://github.com/dotnet/maui/pull/33432).

## Qué obtienes out of the box

El nuevo recognizer se sienta al lado de `TapGestureRecognizer`, `PanGestureRecognizer`, y el resto de la familia. Expone cuatro cosas que importan para UIs reales:

- `MinimumPressDuration` en milisegundos, por default siguiendo la convención de plataforma (alrededor de 500ms en Android, 400ms en iOS).
- Un `MovementThreshold` en unidades device-independent que cancela el gesto si el usuario arrastra más allá, así un scroll nunca dispara un long press.
- Un evento `StateChanged` reportando `Started`, `Running`, `Completed`, y `Canceled`, útil para haptic feedback o estados visuales de pressed.
- `Command` y `CommandParameter` para bindings MVVM, y un evento `LongPressed` para code-behind plano.

Como cuelga de `GestureRecognizers`, cualquier `View` que ya acepta gestos lo toma sin cambios de handler.

## Reemplazando TouchBehavior en XAML

Un menú contextual en una imagen de avatar es el caso canónico. En .NET MAUI 10 esto típicamente requería un TouchBehavior con un `LongPressCommand`. En .NET MAUI 11 colapsa a:

```xaml
<Image Source="avatar.png"
       HeightRequest="64"
       WidthRequest="64">
    <Image.GestureRecognizers>
        <LongPressGestureRecognizer
            MinimumPressDuration="650"
            MovementThreshold="10"
            Command="{Binding ShowContextMenuCommand}"
            CommandParameter="{Binding .}" />
    </Image.GestureRecognizers>
</Image>
```

El recognizer despacha en el UI thread y pasa el parámetro bindado directo, así que el view model se mantiene platform-agnostic.

## Reaccionar al state para feedback de press

El evento `StateChanged` es lo que hace que esto se sienta nativo. La mayoría de los long presses de plataforma animan una escala o atenúan el target durante el hold, y cancelan limpiamente si el dedo se desvía. Con el nuevo API esa lógica vive en un solo lugar:

```csharp
var longPress = new LongPressGestureRecognizer
{
    MinimumPressDuration = 500
};

longPress.StateChanged += async (s, e) =>
{
    switch (e.State)
    {
        case GestureRecognizerState.Started:
            await card.ScaleTo(0.97, 80);
            break;
        case GestureRecognizerState.Completed:
            await HapticFeedback.Default.PerformAsync(HapticFeedbackType.LongPress);
            await card.ScaleTo(1.0, 80);
            ShowMenu();
            break;
        case GestureRecognizerState.Canceled:
            await card.ScaleTo(1.0, 80);
            break;
    }
};

card.GestureRecognizers.Add(longPress);
```

Ese único evento reemplaza tres platform handlers y un Behavior cableado en `MauiProgram`.

## Por qué esto importa para autores de librerías

Las librerías de controles que antes entregaban su propio plumbing de long-press ahora pueden apoyarse en un contrato compartido. Un recognizer de `Microsoft.Maui.Controls` significa que bindings, input transparency, y propagación de `IsEnabled` ya funcionan como funciona el resto del framework, así que los consumidores dejan de golpearse con inconsistencias como el gesto disparándose durante un scroll de `CollectionView` o no respetando `InputTransparent="True"` en un parent.

Si sigues con el TouchBehavior del Community Toolkit, la migración usualmente es un swap de una línea y un rename de property. Revisa las [release notes completas de MAUI en Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/dotnetmaui.md) para los cambios circundantes de gestos y XAML.
