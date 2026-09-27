---
title: "Solución: MediaPicker.CapturePhotoAsync devuelve un PNG en lugar de un JPEG en .NET MAUI 10"
description: "En iOS, MAUI 10 vuelve a codificar las fotos de la cámara como PNG siempre que CompressionQuality es 90 o más y no hay MaximumWidth/Height, lo que incluye el valor por defecto. Pon CompressionQuality en 89 o menos, o agrega un MaximumWidth solo en iOS."
pubDate: 2026-09-27
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "android"
  - "csharp"
lang: "es"
translationOf: "2026/09/fix-mediapicker-capturephotoasync-returns-png-instead-of-jpeg-in-maui-10"
translatedBy: "claude"
translationDate: 2026-09-27
---

Si `MediaPicker.Default.CapturePhotoAsync()` en .NET MAUI 10 te entrega un `3f2c9a....png` con `ContentType` `image/png`, no fue la cámara la que produjo un PNG. Fue MAUI. En iOS, la ruta de la cámara le entrega a MAUI un `UIImage` decodificado, y MAUI 10 lo vuelve a codificar con `AsPNG()` siempre que `CompressionQuality` sea 90 o más y no estén definidos ni `MaximumWidth` ni `MaximumHeight`. La calidad por defecto es 100, así que una llamada sin opciones siempre devuelve un PNG. La solución que funciona en todas las plataformas y en todas las compilaciones 10.x y 11 es `new MediaPickerOptions { CompressionQuality = 85 }` (cualquier valor de 0 a 89). Si en cambio quieres el JPEG de mayor calidad de iOS, deja la calidad en 100 y define un `MaximumWidth` sobredimensionado solo en iOS. En Android y Windows, una calidad de 95 a 99 también te da bytes PNG, y en Windows incluso conservan un nombre `.jpg`.

## El error en contexto

Aquí no hay ninguna excepción. El síntoma es un archivo que no pediste:

```text
// .NET 10, Microsoft.Maui.Essentials 10.0.110, iPhone, CapturePhotoAsync() with no options
FileName:    6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png
ContentType: image/png
First bytes: 89 50 4E 47 0D 0A 1A 0A
```

Las búsquedas sobre esto suelen empezar en algún punto más adelante del flujo: un endpoint de carga que solo acepta `image/jpeg` rechaza el archivo con 415, un bucket de blob storage se llena de PNG de varios megabytes, un redimensionador de imágenes en el servidor falla con entradas RGBA, o faltan los datos EXIF que el backend esperaba (hora de captura, GPS). Los cuatro casos se remontan a la misma línea de código de MAUI.

Esto es lo que devuelve cada llamada a `CapturePhotoAsync`, tomado del código fuente de `MediaPicker` en cada tag de versión:

| Opciones | iOS, MAUI 10.0.0 a 10.0.51 | iOS, MAUI 10.0.60 a 10.0.110 y 11.0 RC 1/RC 2 | Android, todas las 10.x y 11 RC | Windows, todas las 10.x y 11 RC |
| --- | --- | --- | --- | --- |
| ninguna (calidad 100) | PNG | PNG | JPEG de la cámara, intacto | JPEG de la cámara, intacto |
| `CompressionQuality` 95 a 99 | PNG | PNG | PNG | bytes PNG con nombre `.jpg` |
| `CompressionQuality` 90 a 94 | JPEG, calidad 0.9 | PNG | JPEG, recodificado | JPEG, recodificado |
| `CompressionQuality` 0 a 89 | JPEG, calidad q/100 | JPEG, calidad q/100 | JPEG, recodificado | JPEG, recodificado |
| calidad 100 + `MaximumWidth` | JPEG, calidad 0.95 | JPEG, calidad 0.95 | PNG | bytes PNG con nombre `.jpg` |
| calidad 95 a 99 + `MaximumWidth` | JPEG, calidad 0.9 | JPEG, calidad 0.9 | PNG | bytes PNG con nombre `.jpg` |

Hay dos cosas que llaman la atención. La única configuración que da un JPEG en todas las columnas es una calidad de 89 o menos. Y la regla de iOS se volvió más estricta en 10.0.60 (SR6), así que una aplicación que usaba `CompressionQuality = 90` para obtener JPEG en 10.0.51 empezó a recibir PNG tras una actualización rutinaria de MAUI.

## Por qué MAUI 10 convierte una foto de la cámara en un PNG

`CapturePhotoAsync` en iOS presenta un `UIImagePickerController` con la cámara como origen. Una foto recién tomada todavía no está en la fototeca, así que no hay un `PHAsset` del cual leer los bytes HEIC o JPEG originales. MAUI recurre a la entrada `UIImagePickerController.OriginalImage`, que es un `UIImage` decodificado, y lo envuelve en un `CompressedUIImageFileResult` interno. Esa clase tiene que elegir un formato de archivo sin contar con ningún nombre de archivo original, y lo hace en `ShouldUsePngFormat`:

```csharp
// .NET MAUI 10.0.110, src/Essentials/src/MediaPicker/MediaPicker.ios.cs
bool ShouldUsePngFormat()
{
    bool originalWasPng = !string.IsNullOrEmpty(originalFileName) &&
        Path.GetExtension(originalFileName).Equals(".png", StringComparison.OrdinalIgnoreCase);

    return originalWasPng || (compressionQuality >= 90 && !maximumWidth.HasValue && !maximumHeight.HasValue);
}
```

En una captura de cámara, `originalFileName` es `null`, así que la segunda mitad es toda la decisión. `MediaPickerOptions.CompressionQuality` tiene 100 por defecto, lo que significa que "sin opciones" termina en `workingImage.AsPNG()`. El nombre de archivo es un `Guid` más `.png`, y `FileResult.ContentType` se deriva de esa extensión, así que todo lo que viene después coincide en que es un PNG.

Esto no es tanto un comportamiento nuevo como un remanente. En MAUI 9 y anteriores, la misma ruta de la cámara usaba un `UIImageFileResult` que siempre llamaba a `AsPNG()`, sin opciones de por medio (ver [dotnet/maui#11379](https://github.com/dotnet/maui/issues/11379) de 2022). MAUI 10 agregó `CompressionQuality`, `MaximumWidth`, `MaximumHeight`, `RotateImage` y `PreserveMetaData` a `MediaPickerOptions`, y mantuvo PNG como la salida de "máxima calidad". Hasta 10.0.51 el umbral era 95. [dotnet/maui#33119](https://github.com/dotnet/maui/issues/33119) señaló que el método calculaba un umbral de 90 y luego devolvía uno de 95, y [PR #33140](https://github.com/dotnet/maui/pull/33140) (milestone .NET 10 SR6, publicado por primera vez en 10.0.60 en NuGet el 2026-04-29) se quedó con 90. El mismo código está en el tag `11.0.100-rc.1.26458.5` y en la rama `release/11.0.1xx-rc2`.

Android y Windows toman otro camino. Ahí la cámara escribe un archivo JPEG real (`Guid.jpg` en Android, una captura `CameraCaptureUIPhotoFormat.Jpeg` en Windows), y MAUI solo lo toca cuando `ImageProcessor.IsProcessingNeeded` es true, es decir, con una calidad menor a 100 o una dimensión máxima. El `ImageProcessor.ProcessImageAsync` compartido elige entonces el formato con su propia regla, `qualityPercent >= 95 || (qualityPercent >= 90 && originalWasPng)`, que ignora por completo las opciones de redimensionamiento. Así que en Android una calidad de 97 convierte el JPEG de la cámara en un PNG, y en iOS una calidad de 97 con un `MaximumWidth` no lo hace. Mismo objeto de opciones, formatos de archivo distintos. Windows agrega un giro más: su `ProcessedImageFileResult` nombra la salida con `ImageProcessor.DetermineOutputExtension(imageData, 75, originalFileName)`, un 75 fijo en el código en lugar de tu calidad, así que los bytes PNG reciben un nombre `.jpg` y un content type `image/jpeg`.

## Reproducción mínima

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110, run on a physical iPhone
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync();
if (photo is null) return; // user cancelled

Console.WriteLine($"{photo.FileName} | {photo.ContentType}");
// 6b1e0c52-8f0d-4c1e-9a55-2f0b7d3c41aa.png | image/png
```

El iOS Simulator no tiene cámara (`IsCaptureSupported` es false ahí), así que esto necesita un dispositivo. Si todavía no configuraste uno para un proyecto MAUI, la [solución del provisioning profile para MAUI iOS](/es/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) cubre el primer obstáculo habitual.

## Solución 1: pon CompressionQuality en 89 o menos

Esta es la recomendación para casi cualquier aplicación. Es una sola línea, produce un JPEG en iOS, Android y Windows, y se comporta igual en todas las versiones de servicio de MAUI 10 y en MAUI 11 RC 1:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
FileResult? photo = await MediaPicker.Default.CapturePhotoAsync(new MediaPickerOptions
{
    CompressionQuality = 85,
});
```

En iOS esto llama a `UIImage.AsJPEG(0.85f)` sobre la imagen con la orientación normalizada. En Android y Windows carga el JPEG de la cámara a través de Microsoft.Maui.Graphics y lo vuelve a guardar como JPEG con calidad 0.85. Una calidad de 85 es visualmente indistinguible del original para fotos vistas al tamaño de un celular y reduce el tamaño del archivo de forma considerable frente a un PNG sin pérdida de los mismos píxeles. Si además quieres limitar la resolución antes de la carga, agrega `MaximumWidth` y `MaximumHeight` junto a ella. Con una calidad menor a 90, nunca cambian el formato en ninguna plataforma.

No "arregles" esto con una calidad de 90 a 94. Ese rango daba un JPEG en iOS hasta 10.0.51 y pasó a dar un PNG en 10.0.60, que es justo el tipo de configuración que se rompe en silencio con la siguiente actualización del workload.

## Solución 2: mantén la calidad máxima en iOS con un MaximumWidth sobredimensionado

Si necesitas el JPEG con menos pérdida que MAUI puede producir, hay una peculiaridad que vale la pena conocer: en iOS, definir cualquier `MaximumWidth` o `MaximumHeight` desactiva la rama PNG, y MAUI nunca escala hacia arriba (`CalculateResizedDimensions` limita la escala a 1). Con calidad 100 eso da `AsJPEG(0.95f)` a resolución completa. En Android y Windows las mismas opciones harían lo contrario y producirían un PNG, y ahí el JPEG intacto de la cámara que devuelve una llamada simple ya es lo que quieres. Así que separa por plataforma:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
using Microsoft.Maui.Devices;
using Microsoft.Maui.Media;

static MediaPickerOptions JpegCaptureOptions()
{
    if (DeviceInfo.Platform == DevicePlatform.iOS ||
        DeviceInfo.Platform == DevicePlatform.MacCatalyst)
    {
        // Any maximum dimension disables the PNG branch on iOS.
        // 16384 is larger than any iPhone sensor, so nothing is resized.
        return new MediaPickerOptions
        {
            CompressionQuality = 100, // encoded as AsJPEG(0.95f)
            MaximumWidth = 16384,
            MaximumHeight = 16384,
        };
    }

    // Android and Windows: quality 100 and no limits means MAUI returns
    // the camera's own JPEG file without re-encoding it.
    return new MediaPickerOptions();
}

FileResult? photo = await MediaPicker.Default.CapturePhotoAsync(JpegCaptureOptions());
```

Esto depende de un detalle de implementación de `ShouldUsePngFormat`, así que trátalo como un workaround y vuelve a revisar la tabla de arriba cuando pases a una nueva versión de MAUI. La Solución 1 no tiene esa dependencia.

## Solución 3: deja de confiar en la extensión más adelante en el flujo

Aun con las opciones corregidas, una aplicación MAUI es solo un cliente, y en Windows el nombre de archivo puede estar mal en la dirección contraria. Todo lo que reciba fotos debería revisar los bytes, no el nombre del archivo. JPEG empieza con `FF D8 FF`, PNG con la firma de 8 bytes `89 50 4E 47 0D 0A 1A 0A`:

```csharp
// .NET 10, C# 14, Microsoft.Maui.Essentials 10.0.110
using Microsoft.Maui.Storage;

static async Task<string?> DetectImageFormatAsync(FileResult file)
{
    await using var stream = await file.OpenReadAsync();
    var header = new byte[8];
    var read = await stream.ReadAtLeastAsync(header, header.Length, throwOnEndOfStream: false);

    if (read >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF)
        return "image/jpeg";

    if (read >= 8 && header.AsSpan().SequenceEqual(
            new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A }))
        return "image/png";

    return null;
}
```

Usa el tipo detectado al armar la carga, para que el servidor vea un `Content-Type` honesto incluso con fotos tomadas por una versión anterior de la aplicación que todavía envía PNG:

```csharp
// .NET 10, C# 14
static async Task UploadAsync(HttpClient http, FileResult photo)
{
    var contentType = await DetectImageFormatAsync(photo) ?? "application/octet-stream";
    var extension = contentType == "image/png" ? ".png" : ".jpg";

    await using var stream = await photo.OpenReadAsync();
    using var content = new MultipartFormDataContent();
    var file = new StreamContent(stream);
    file.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(contentType);
    content.Add(file, "photo", $"capture{extension}");

    using var response = await http.PostAsync("api/photos", content);
    response.EnsureSuccessStatusCode();
}
```

Si el servidor guarda el archivo en blob storage junto a una fila de la base de datos, el [artículo sobre la consistencia entre una escritura en base de datos y una carga a blob](/es/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) cubre qué hacer cuando una de las dos falla.

Todo el C# de arriba compila contra `Microsoft.Maui.Essentials` 10.0.110 con el SDK .NET 10.0.302. La tabla de formatos sale de leer `MediaPicker.ios.cs`, `MediaPicker.android.cs`, `MediaPicker.windows.cs` e `ImageProcessor.shared.cs` en los tags `10.0.0`, `10.0.51`, `10.0.60`, `10.0.110` y `11.0.100-rc.1.26458.5`, no de una matriz de dispositivos, así que si tu dispositivo no coincide, lo primero que debes revisar es el tag en el que realmente estás (`dotnet list package --include-transitive | grep Maui`).

## Trampas que vienen junto con el PNG

**El EXIF desaparece en las capturas de iOS, diga lo que diga `PreserveMetaData`.** `CompressedUIImageFileResult` se construye solo a partir del `UIImage`, y `PreserveMetaData` nunca se le pasa. `AsPNG()` y `AsJPEG()` sobre un `UIImage` no escriben metadatos de la cámara, así que la hora de captura, el GPS y los datos del lente no están en el archivo con ninguna de las dos soluciones. Si los necesitas, lee tú mismo el diccionario `UIImagePickerController.MediaMetadata` en un picker personalizado, o registra la marca de tiempo y la ubicación en la aplicación cuando termine la captura. Elegir una foto existente (`PickPhotoAsync`) pasa por `PHPicker` y el asset original, que es una ruta distinta. [dotnet/maui#36581](https://github.com/dotnet/maui/issues/36581) da seguimiento a APIs de metadatos adecuadas para .NET 12.

**Las fotos rotadas se vuelven RGBA.** Una foto vertical de la cámara del iPhone llega como un bitmap horizontal con `UIImageOrientation.Right`. MAUI siempre llama a `NormalizeOrientation()` antes de codificar, lo que vuelve a dibujar la imagen con un `UIGraphicsImageRenderer` cuyo formato tiene `Opaque = false`. El resultado lleva un canal alfa que no necesita, y un PNG de eso es todavía más grande. La ventaja es que los píxeles ya están derechos, así que `RotateImage = true` no hace falta para las capturas de iOS.

**`SaveToGallery` de MAUI 11 también guarda el PNG.** MAUI 11 agrega `MediaPickerOptions.SaveToGallery` para las llamadas de captura. En iOS escribe el mismo `FileResult` que MAUI te devuelve en un archivo temporal y lo pasa a `PHAssetChangeRequest.FromImage`. Con las opciones por defecto, eso significa que un PNG termina en la fototeca del usuario. Pon una calidad menor a 90 y la copia de la galería también será un JPEG.

**`PickPhotoAsync` puede devolver PNG por otro motivo.** Si el usuario elige una captura de pantalla, el original realmente es un PNG, y MAUI lo mantiene como PNG con calidad 90 o más por diseño (`originalWasPng`). Ese no es este bug; detecta el formato como en la Solución 3 y maneja ambos.

**La selección múltiple en iOS tiene su propio problema en 10.0.100.** Si `PickPhotosAsync` lanza una excepción cuando el usuario selecciona varias imágenes, se trata de la [regresión de UIKitThreadAccessException en MediaPicker.PickPhotosAsync](/es/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/), corregida en 10.0.110.

## Relacionado

- [Solución: UIKitThreadAccessException en MediaPicker.PickPhotosAsync en .NET MAUI iOS](/es/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/) cubre la otra regresión de MediaPicker en la línea 10.0.1xx.
- [Novedades de .NET MAUI 10](/es/2025/04/whats-new-in-net-maui-10/) para el resto de la versión en la que llegaron las nuevas opciones del picker.
- [Solución: el provisioning profile no incluye el dispositivo seleccionado actualmente](/es/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) para llevar el código de la cámara a un iPhone real.
- [Mantener consistentes una escritura en base de datos y una carga a Azure Blob en una sola solicitud](/es/2026/09/how-to-keep-a-database-write-and-an-azure-blob-upload-consistent-in-one-request/) para el lado del servidor de una carga de fotos.

## Fuentes

- [Selector de medios para fotos y videos, documentación de .NET MAUI (MS Learn)](https://learn.microsoft.com/dotnet/maui/platform-integration/device-media/picker?view=net-maui-10.0)
- [`MediaPicker.ios.cs` en el tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/MediaPicker.ios.cs)
- [`ImageProcessor.shared.cs` en el tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Essentials/src/MediaPicker/ImageProcessor.shared.cs)
- [dotnet/maui#33119: MediaPicker ShouldUsePngFormat method has conflicting/redundant code](https://github.com/dotnet/maui/issues/33119)
- [dotnet/maui#33140: Refactor image rotation and PNG format logic](https://github.com/dotnet/maui/pull/33140)
- [dotnet/maui#11379: CapturePhotoAsync returns PNG in which the orientation data is lost](https://github.com/dotnet/maui/issues/11379)
- [dotnet/maui#36581: Add image metadata APIs and non-destructive MediaPicker processing](https://github.com/dotnet/maui/issues/36581)
