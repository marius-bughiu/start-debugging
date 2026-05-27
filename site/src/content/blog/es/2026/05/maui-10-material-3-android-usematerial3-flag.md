---
title: ".NET MAUI 10 SR6 termina Material 3 en Android detrás de una sola bandera UseMaterial3"
description: "MAUI 10 SR6 (10.0.60) extiende el tema Material 3 a Button, Entry, SearchBar, DatePicker, Slider, ProgressBar, ImageButton, Switch y Shell en Android. Activalo con una propiedad MSBuild. Sin renderers personalizados, sin editar styles.xml."
pubDate: 2026-05-27
tags:
  - "dotnet"
  - "maui"
  - "android"
  - "material-3"
  - "dotnet-10"
lang: "es"
translationOf: "2026/05/maui-10-material-3-android-usematerial3-flag"
translatedBy: "claude"
translationDate: 2026-05-27
---

Microsoft envió el [último gran bloque de soporte para Material 3 en .NET MAUI sobre Android](https://devblogs.microsoft.com/dotnet/dotnet-maui-material-3/) en la versión .NET MAUI 10 SR6 (10.0.60), anunciada el 26 de mayo de 2026. Lo interesante no es que Material 3 esté disponible. Es que la activación se hace con exactamente una propiedad MSBuild y que el equipo mantuvo la personalización de handlers completamente fuera de la ecuación.

Si has seguido la historia móvil de .NET 11, MAUI también está [cambiando su runtime predeterminado a CoreCLR en Android y iOS en .NET 11 Preview 4](/es/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/). Material 3, sin embargo, es una característica de .NET MAUI 10 y se entrega hoy mediante la cadencia de versiones de servicio (service release) compatibles.

## Cómo se distribuyó el lanzamiento

Material 3 no llegó todo de golpe. La característica se distribuyó en tres versiones de servicio de .NET MAUI 10:

- **SR3 (10.0.30)**: estilos base de Material 3 para un puñado de controles.
- **SR4 (10.0.40)**: `CheckBox` adoptó el nuevo tema.
- **SR6 (10.0.60)**: el lote grande. `Button`, `Entry`, `SearchBar`, `DatePicker`, `Slider`, `ProgressBar`, `ImageButton`, `Switch` y el tema completo de `Shell`.

El conjunto compatible completo en SR6 abarca `Entry`, `Editor`, `SearchBar`, `RadioButton`, `ProgressBar`, `Slider`, `Picker`, `TimePicker`, `DatePicker`, `CheckBox`, `Switch`, `ImageButton`, `Button`, `Label`, `ActivityIndicator`, `Image` y `Shell`.

## La activación es una sola propiedad

Toda la activación es una única propiedad en tu `.csproj`:

```xml
<PropertyGroup>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

Esa es toda la superficie. Recompila, despliega a un dispositivo o emulador Android, y los controles compatibles comienzan a aplicar el estilo Material 3 automáticamente. Sin personalización de handlers, sin renderers personalizados, sin cirugía sobre `Resources/values/styles.xml`, sin cambios en `MainActivity`.

Si quieres limitar la bandera solo a Android, usa la condición MSBuild estándar:

```xml
<PropertyGroup Condition="$(TargetFramework.Contains('-android'))">
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>
```

## Los estilos explícitos siguen ganando

El equipo mantuvo la regla de precedencia tal como la querrías. Cualquier cosa que definas explícitamente en XAML o C# anula los valores predeterminados de Material 3:

```xml
<Button Text="Save"
        BackgroundColor="#0F62FE"
        TextColor="White" />
```

Ese botón conserva su azul IBM. Material 3 solo rellena donde no pintaste antes. Los handlers y renderers personalizados no se ven afectados, lo cual importa si ya tienes un sistema de diseño que sobrescribe controles específicos; activar la bandera no reestilizará silenciosamente las cosas que personalizaste intencionalmente.

## Por qué importa

La brecha visual de Android ha sido una de las quejas más persistentes sobre MAUI. Los controles listos para usar se veían anticuados, arreglarlo requería sumergirse en el XML de temas Android, y cualquier solución por control tendía a desviarse de lo que Google publicaba en el siguiente release de Material. Una sola bandera MSBuild que sigue a Material 3 a través de las versiones SR es una reducción significativa de la superficie de mantenimiento para cualquier equipo que aún no tenga un sistema de diseño cerrado.

El movimiento pragmático en una app MAUI 10 existente: subir a 10.0.60, poner `UseMaterial3` en `true`, ejecutar la app en un emulador Android y recorrer cada pantalla. Cualquier lugar donde antes hiciste estilo manual para compensar los valores predeterminados antiguos ahora es candidato a borrar.
