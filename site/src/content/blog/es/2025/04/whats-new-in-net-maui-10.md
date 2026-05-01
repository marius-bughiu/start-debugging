---
title: "Novedades en .NET MAUI 10"
description: "Un resumen de las nuevas características, mejoras y cambios disruptivos en .NET MAUI 10, lanzado junto con .NET 10 y C# 14 en noviembre de 2025."
pubDate: 2025-04-11
updatedDate: 2026-01-08
tags:
  - "maui"
  - "dotnet"
  - "dotnet-10"
lang: "es"
translationOf: "2025/04/whats-new-in-net-maui-10"
translatedBy: "claude"
translationDate: 2026-05-01
---
.NET MAUI 10 se lanzó en noviembre de 2025 junto con .NET 10 y C# 14.  
  
.NET 10 es una versión Long Term Support (LTS), que recibirá soporte y parches gratuitos durante 3 años a partir de la fecha de lanzamiento, hasta noviembre de 2028. Para más información consulta [novedades en .NET 10](/2024/12/dotnet-10/) y [novedades en C# 14](/2024/12/csharp-14/).

Hay varias características nuevas y mejoras en .NET MAUI 10:

-   Mejoras en controles
    -   Mejoras de rendimiento y estabilidad en `CollectionView` y `CarouselView`
    -   Sobrecarga de `HybridWebView.InvokeJavaScriptAsync`
    -   Propiedad `SearchIconColor` en `SearchBar`
    -   Propiedad `OffColor` en `Switch`
-   Nuevo `ShadowTypeConverter`
-   Propiedad `Rate` en `SpeechOptions`
-   Extensión de marcado XAML `FontImageExtension`
-   iOS y Mac Catalyst
    -   nuevas `AccessibilityExtensions`
    -   sobrescrituras de `MauiWebViewNavigationDelegate`
    -   mostrar una página modal como popover
-   Android
    -   soporte para Android 16 Baklava -- API 36 -- y JDK 21
    -   soporte de `dotnet run`
    -   `AndroidEnableMarshalMethods` activado por defecto
    -   metadato `ArtifactFilename` para el ítem `@(AndroidMavenLibrary)`
    -   las compilaciones de Visual Studio en tiempo de diseño ya no invocan `aapt2`
    -   la salida del `generator` evita el posible uso de System.Reflection.Emit
    -   `ApplicationAttribute.ManageSpaceActivity` ya no lanza una `InvalidCastException`

Cambios disruptivos en .NET MAUI para .NET 10:

-   `TableView` se ha marcado como obsoleto. Se debe usar `CollectionView` en su lugar.
-   `MessagingCenter` se hizo interno en .NET 10. Usa `WeakReferenceMessenger` de [CommunityToolkit.Mvvm](https://www.nuget.org/packages/CommunityToolkit.Mvvm) en su lugar.
