---
title: "MAUI 10.0.120: BlazorWebView por fin acepta soltar archivos en Windows y arrastrar imágenes en Android"
description: ".NET MAUI 10.0.120 activa AllowDrop en el BlazorWebView de Windows y registra DropDataContentProvider de AndroidX en Android, así que las zonas de soltar de Blazor Hybrid funcionan sin código de plataforma. Esto es lo que cambió, el nuevo interruptor MauiEnableAndroidWebViewDragDrop y la advertencia MAUI1002."
pubDate: 2026-10-22
tags:
  - "maui"
  - "blazor"
  - "blazor-hybrid"
  - "dotnet"
lang: "es"
translationOf: "2026/10/maui-10-0-120-blazorwebview-accepts-file-drops-on-windows-and-image-drags-on-android"
translatedBy: "claude"
translationDate: 2026-10-22
---

[.NET MAUI 10.0.120](https://github.com/dotnet/maui/releases/tag/10.0.120) se publicó el 2026-10-21 con 213 commits. Casi todo son correcciones, pero dos cambios en BlazorWebView eliminan una solución alternativa que cada aplicación Blazor Hybrid con una caja de "suelta tus archivos aquí" ha arrastrado desde .NET 6: arrastrar un archivo desde el Explorador hasta un `BlazorWebView` en Windows ahora llega a tu destino de soltar HTML, y arrastrar imágenes dentro de un `BlazorWebView` en Android ahora produce datos de arrastre reales.

## Windows: AllowDrop ahora viene activado por defecto

Hasta ahora, el handler de Windows creaba su `WebView2` de WinUI con `AllowDrop` en `false`. El DOM nunca veía un evento `drop` para archivos que venían de fuera de la aplicación, así que una zona de soltar de Blazor que funcionaba en el navegador no hacía nada, sin avisar, en la versión de escritorio. La solución habitual era un mapeo de handler personalizado. [PR #37904](https://github.com/dotnet/maui/pull/37904) cambia `BlazorWebViewHandler.CreatePlatformView` a esto:

```csharp
protected override WebView2Control CreatePlatformView()
{
    return new WebView2Control
    {
        AllowDrop = true,
    };
}
```

Eso significa que un `InputFile` normal extendido sobre un área de soltar ahora funciona en Windows sin nada de código de plataforma:

```razor
<div class="dropzone">
    <InputFile OnChange="OnFilesDropped" multiple />
    <p>Drop files here</p>
</div>

@code {
    async Task OnFilesDropped(InputFileChangeEventArgs e)
    {
        foreach (var file in e.GetMultipleFiles(maxAllowedFiles: 10))
        {
            await using var stream = file.OpenReadStream(maxAllowedSize: 20 * 1024 * 1024);
            // save or process the stream
        }
    }
}
```

Si escribiste un mapper que establecía `AllowDrop = true` por tu cuenta, puedes borrarlo después de actualizar. Queda un límite: el arrastre nativo de elementos e imágenes dentro de la página en Windows sigue sin funcionar con la dependencia actual de MAUI en Windows App SDK 1.8. El autor del PR probó Windows App SDK 2.0.1 y encontró que esos escenarios empiezan a funcionar allí una vez que `AllowDrop` está activado, así que este ajuste también es trabajo preparatorio para ese salto.

## Android: DropDataContentProvider se registra por ti

En Android, arrastrar un `<img>` en un `BlazorWebView` disparaba eventos de arrastre del DOM, pero no llevaba datos de imagen utilizables. Para eso, el WebView de Android necesita que el `DropDataContentProvider` de AndroidX WebKit esté declarado en el manifiesto. [PR #37975](https://github.com/dotnet/maui/pull/37975) hace que `Microsoft.AspNetCore.Components.WebView.Maui` dependa de `Xamarin.AndroidX.WebKit` 1.16.0.1 en los destinos Android y fusiona este provider en tu manifiesto mediante un `AndroidManifestOverlay`:

```xml
<provider
  android:name="androidx.webkit.DropDataContentProvider"
  android:authorities="${applicationId}.DropDataProvider"
  android:exported="false"
  android:grantUriPermissions="true" />
```

Si tu aplicación ya declara el mismo provider, las dos entradas se fusionan en una. Si lo declaras con una configuración distinta, desactiva el registro automático:

```xml
<PropertyGroup>
  <MauiEnableAndroidWebViewDragDrop>false</MauiEnableAndroidWebViewDragDrop>
</PropertyGroup>
```

Esa propiedad solo controla la entrada del manifiesto. La referencia al paquete `Xamarin.AndroidX.WebKit` se mantiene en ambos casos.

## Cuidado con MAUI1002

Los proyectos que todavía establecen `<AndroidManifestMerger>legacy</AndroidManifestMerger>` ahora verán la advertencia `MAUI1002`, porque el fusionador legacy ignora los elementos `AndroidManifestOverlay` y el provider nunca llega al manifiesto. Cambia a `manifestmerger.jar` (el valor por defecto) o establece `MauiEnableAndroidWebViewDragDrop` en `false` y declara tú mismo el provider en `Platforms/Android/AndroidManifest.xml`. Si compilas tratando las advertencias como errores, esta es la única línea de 10.0.120 que puede romper tu CI.

## Cómo actualizar

Sube `Microsoft.Maui.Controls` y `Microsoft.AspNetCore.Components.WebView.Maui` a `10.0.120`; ambos ya están en NuGet. La misma versión también continúa la limpieza de fugas que cubrí en [el artículo de 10.0.110](/es/2026/10/maui-10-0-110-fixes-six-leaks-found-by-an-agentic-leak-hunter/), incluida una fuga de `BlazorWebView` en iOS donde `DisconnectHandlers()` nunca llegaba a las páginas dentro de un `Shell`.
