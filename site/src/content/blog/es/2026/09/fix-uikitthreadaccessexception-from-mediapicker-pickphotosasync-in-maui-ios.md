---
title: "Solución: UIKitThreadAccessException en MediaPicker.PickPhotosAsync al seleccionar varias fotos en .NET MAUI iOS"
description: "Seleccionar 2 o más fotos en iOS lanza UIKitThreadAccessException en MAUI 10.0.100 y 10.0.101. MAUI lee PHPickerResult.ItemProvider después de un await, fuera del hilo principal. Fija 10.0.90, actualiza a 10.0.110 o usa un PHPicker propio."
pubDate: 2026-09-16
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "ios"
  - "csharp"
  - "async"
lang: "es"
translationOf: "2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios"
translatedBy: "claude"
translationDate: 2026-09-16
---

Si `MediaPicker.PickPhotosAsync` lanza `UIKit.UIKitThreadAccessException` en iOS cada vez que el usuario selecciona 2 o más elementos, te topaste con una regresión de .NET MAUI introducida en 10.0.100. MAUI lee `PHPickerResult.ItemProvider`, una propiedad protegida por UIKit, dentro de un bucle que espera con `ConfigureAwait(false)`, así que cada iteración después de la primera corre en un hilo del pool. Nada de lo que hagas en el punto de llamada lo arregla. Fija `<MauiVersion>10.0.90</MauiVersion>`, pasa a 10.0.110 (SR11) o a MAUI 11.0.0-rc.2 cuando salgan, o invoca `PHPickerViewController` tú mismo y lee los item providers antes del primer await. Seleccionar exactamente una foto siempre funciona, y por eso esto parece intermitente hasta que notas el patrón.

## El error en contexto

```text
UIKit.UIKitThreadAccessException: UIKit Consistency error: you are calling a UIKit method that can only be invoked from the UI thread.
   at UIKit.UIApplication.EnsureUIThread()
   at PhotosUI.PHPickerResult.get_ItemProvider()
   at Microsoft.Maui.Media.MediaPickerImplementation.PickerResultsToMediaFiles(PHPickerResult[] results, MediaPickerOptions options)
   at Microsoft.Maui.Media.MediaPickerImplementation.CompletePickerResultsAsync(PHPickerResult[] results, MediaPickerOptions options, TaskCompletionSource`1 tcs)
```

Versiones afectadas, verificadas contra las ramas de release de `dotnet/maui`:

| Versión de MAUI | Publicada | `PickPhotosAsync` con 2+ elementos |
| --- | --- | --- |
| 10.0.90 (SR9) | 2026-07-22 | funciona |
| 10.0.100 (SR10) | 2026-08-20 | lanza excepción |
| 10.0.101 | 2026-09-07 | lanza excepción |
| 11.0.0-rc.1 | 2026-09-08 | lanza excepción |
| 10.0.110 (SR11) | sin publicar | corregido |
| 11.0.0-rc.2 | sin publicar | corregido |

`PickPhotosAsync` y `PickVideosAsync` son nuevos en .NET MAUI 10 ([dotnet/maui#6903](https://github.com/dotnet/maui/issues/6903)), así que no hay una versión mayor anterior a la que volver. Android y Windows no se ven afectados: el código roto está solo en `MediaPicker.ios.cs`.

## Por qué ocurre

`PickPhotosAsync` en iOS presenta un `PHPickerViewController`. Cuando el usuario confirma, el `PhotoPickerDelegate.DidFinishPicking` de MAUI cierra el controlador e invoca su manejador de finalización desde el callback de cierre, que corre en el hilo principal. Ese manejador llama a `PickerResultsToMediaFiles`, y en 10.0.100 ese método se veía así:

```csharp
// .NET MAUI 10.0.100 and 10.0.101, src/Essentials/src/MediaPicker/MediaPicker.ios.cs
var fileResults = new List<FileResult>(results.Length);
PHPickerFileResult fileResult = null;

foreach (var file in results)
{
    fileResult = new PHPickerFileResult(file.ItemProvider);   // UIKit call
    await fileResult.LoadFileRepresentationAsync().ConfigureAwait(false);
    fileResults.Add(fileResult);
    fileResult = null;
}
```

`PHPickerResult.ItemProvider` está enlazado con una guarda `UIApplication.EnsureUIThread()`. La primera iteración está bien, porque el callback del delegado nos dejó en el hilo principal. Luego se espera `LoadFileRepresentationAsync` con `ConfigureAwait(false)`, que descarta el contexto capturado, y la segunda iteración lee `file.ItemProvider` en el hilo donde haya aterrizado la continuación.

Lo que hace que esto sea determinista y no una condición de carrera está dentro de `PHPickerFileResult`:

```csharp
// .NET MAUI 10.0.100, PHPickerFileResult.LoadFileRepresentationAsync
loadTcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
```

`RunContinuationsAsynchronously` significa que la continuación nunca la ejecuta en línea el hilo que completa el `TaskCompletionSource`. Combinado con `ConfigureAwait(false)` no hay camino de vuelta al hilo principal, así que la segunda lectura siempre ocurre en el pool. Por eso el fallo es perfectamente reproducible: 1 elemento siempre funciona, 2 o más siempre fallan. Si ya perseguiste bugs asíncronos intermitentes, este es el caso contrario, y conviene entender [qué descarta realmente ConfigureAwait(false)](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/) antes de ponerte a buscar una condición de carrera que no existe.

Esto es una regresión de [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805) (".NET 10 SR10"), que corrigió que `FullPath` llegara vacío para los resultados de PHPicker. Antes de ese PR, todos los providers se materializaban de una sola vez:

```csharp
// .NET MAUI 10.0.90 and earlier
var fileResults = results?
    .Select(file => (FileResult)new PHPickerFileResult(file.ItemProvider))
    .ToList() ?? [];
```

Cada `ItemProvider` se leía antes del primer `await`, así que la guarda de UIKit nunca veía un hilo del pool. Reemplazar eso por un bucle con un `await` dentro es lo que lo rompió. El bug está registrado como [dotnet/maui#37878](https://github.com/dotnet/maui/issues/37878), etiquetado `regressed-in-10.0.100` y asignado al hito .NET 10 SR11.

## Reproducción mínima

```csharp
// .NET MAUI 10.0.100, net10.0-ios, iOS 26.4 simulator
private async void OnPickClicked(object sender, EventArgs e)
{
    try
    {
        var files = await MediaPicker.Default.PickPhotosAsync(new MediaPickerOptions
        {
            SelectionLimit = 5
        });

        StatusLabel.Text = $"Picked {files.Count}";
    }
    catch (Exception ex)
    {
        StatusLabel.Text = ex.ToString();   // UIKitThreadAccessException with 2+ items
    }
}
```

En un simulador, carga primero la galería o el selector aparece vacío:

```bash
xcrun simctl addmedia booted photo1.png photo2.png photo3.png
```

Selecciona una foto: obtienes un `FileResult`. Selecciona dos: obtienes la excepción. Nota que el manejador `async void` aquí solo es aceptable porque todos los caminos están dentro de un `try`, que es la única forma en la que [async void se justifica](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Solución 1: actualizar más allá de la regresión

La corrección es [dotnet/maui#37879](https://github.com/dotnet/maui/pull/37879), fusionada el 2026-08-27, retroportada a `release/10.0.1xx-sr11` como [#38481](https://github.com/dotnet/maui/pull/38481) y llevada a `main` como [#38488](https://github.com/dotnet/maui/pull/38488), ambas el 2026-09-12. El código publicado ahora lee todos los providers antes del primer await:

```csharp
// .NET MAUI 10.0.110 and 11.0.0-rc.2, MediaPicker.ios.cs
// PHPickerResult.ItemProvider is a UIKit call and must be read on the main thread.
var pickerResults = new List<PHPickerFileResult>(results.Length);
foreach (var file in results)
{
    pickerResults.Add(new PHPickerFileResult(file.ItemProvider));
}

var fileResults = new List<FileResult>(pickerResults.Count);
foreach (var pickerResult in pickerResults)
{
    await pickerResult.LoadFileRepresentationAsync().ConfigureAwait(false);
    fileResults.Add(pickerResult);
}
```

`NSItemProvider` es un tipo de Foundation sin guarda de hilo de UI, así que mantener los providers a través de los awaits es seguro. El mismo PR también tapó una fuga de memoria en la ruta de error: los resultados construidos después de la iteración que falla quedaban sin liberar.

Al 2026-09-16, ni 10.0.110 ni 11.0.0-rc.2 están en NuGet. Cuando salga 10.0.110, es un cambio de una línea:

```xml
<!-- Directory.Build.props or the app .csproj -->
<PropertyGroup>
  <MauiVersion>10.0.110</MauiVersion>
</PropertyGroup>
```

## Solución 2: fijar la versión en 10.0.90

Hasta que llegue SR11, fijar la versión es la opción de menor riesgo si no dependes de nada más que haya salido en SR10:

```xml
<!-- app .csproj, .NET 10 SDK -->
<PropertyGroup>
  <MauiVersion>10.0.90</MauiVersion>
</PropertyGroup>
```

El costo es que también renuncias a [dotnet/maui#35805](https://github.com/dotnet/maui/pull/35805), la corrección de `FullPath`. En 10.0.90, un `FileResult` de la ruta de PHPicker puede volver con una ruta donde no existe ningún archivo, así que `File.Copy(result.FullPath, ...)` falla y tienes que pasar por `await result.OpenReadAsync()`. Si tu código de subida ya usa streams en vez de copiar por ruta, no lo vas a notar.

## Solución 3: invocar PHPicker tú mismo

Si no puedes cambiar de versión, reemplaza la ruta de selección múltiple de iOS con unas sesenta líneas de interop. Todo el truco está en leer cada `ItemProvider` dentro de `DidFinishPicking`, antes de que algo haga await.

```csharp
// .NET MAUI 10.0.100, net10.0-ios only
using Foundation;
using Microsoft.Maui.ApplicationModel;
using Microsoft.Maui.Storage;
using PhotosUI;
using UIKit;

sealed class PhotoPicker
{
    public static Task<List<string>> PickPhotosAsync(int selectionLimit)
    {
        var tcs = new TaskCompletionSource<List<string>>();

        var config = new PHPickerConfiguration
        {
            Filter = PHPickerFilter.ImagesFilter,
            SelectionLimit = selectionLimit
        };

        var picker = new PHPickerViewController(config)
        {
            Delegate = new PickerDelegate(tcs)
        };

        var vc = WindowStateManager.Default.GetCurrentUIViewController(true);
        vc.PresentViewController(picker, true, null);

        return tcs.Task;
    }

    sealed class PickerDelegate : PHPickerViewControllerDelegate
    {
        readonly TaskCompletionSource<List<string>> _tcs;

        public PickerDelegate(TaskCompletionSource<List<string>> tcs) => _tcs = tcs;

        public override void DidFinishPicking(PHPickerViewController picker, PHPickerResult[] results)
        {
            // Main thread. Read every provider now, before any await can move us off it.
            var providers = new List<NSItemProvider>(results.Length);
            foreach (var result in results)
            {
                providers.Add(result.ItemProvider);
            }

            picker.DismissViewController(true, () => _ = LoadAllAsync(providers));
        }

        async Task LoadAllAsync(List<NSItemProvider> providers)
        {
            try
            {
                var paths = new List<string>(providers.Count);
                foreach (var provider in providers)
                {
                    var identifier = provider.RegisteredTypeIdentifiers?.FirstOrDefault();
                    if (string.IsNullOrEmpty(identifier))
                    {
                        continue;
                    }

                    paths.Add(await CopyToCacheAsync(provider, identifier).ConfigureAwait(false));
                }

                _tcs.TrySetResult(paths);
            }
            catch (Exception ex)
            {
                _tcs.TrySetException(ex);
            }
        }

        static Task<string> CopyToCacheAsync(NSItemProvider provider, string identifier)
        {
            var tcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);

            provider.LoadFileRepresentation(identifier, (url, error) =>
            {
                if (error is not null)
                {
                    tcs.TrySetException(new NSErrorException(error));
                    return;
                }

                try
                {
                    // The URL is only valid inside this callback, so copy synchronously.
                    var destination = Path.Combine(
                        FileSystem.CacheDirectory,
                        Guid.NewGuid().ToString("n") + Path.GetExtension(url.Path));

                    File.Copy(url.Path, destination, overwrite: true);
                    tcs.TrySetResult(destination);
                }
                catch (Exception ex)
                {
                    tcs.TrySetException(ex);
                }
            });

            return tcs.Task;
        }
    }
}
```

Dos detalles importan. El `NSUrl` que recibe el callback de `LoadFileRepresentation` apunta a un archivo que el sistema borra en cuanto el callback retorna, así que la copia tiene que ser síncrona y dentro del callback. Y `PickerDelegate` debe seguir siendo alcanzable; asignarlo a la propiedad tipada `Delegate` mantiene una referencia administrada, pero si cambias a `WeakDelegate` tienes que guardar la instancia tú mismo o la recolección de basura se la lleva a mitad de la selección.

Lo que pierdes es todo lo que `MediaPickerOptions` hace después de la selección: `CompressionQuality`, `MaximumWidth`, `MaximumHeight`, `RotateImage` y `PreserveMetaData` los aplica el paso de postprocesado de MAUI, no el selector. Si los necesitas, redimensiona con `SkiaSharp` o `Microsoft.Maui.Graphics` después de copiar.

## Solución 4: usar FilePicker en su lugar

`FilePicker.PickMultipleAsync` pasa por `UIDocumentPickerViewController` y `NSUrl[]`, sin tocar nunca `PHPickerResult`, así que no está afectado:

```csharp
// .NET MAUI 10.0.100, cross-platform
var files = await FilePicker.Default.PickMultipleAsync(new PickOptions
{
    PickerTitle = "Select images",
    FileTypes = FilePickerFileType.Images
});
```

Es una experiencia distinta: la app Archivos en vez de la cuadrícula de Fotos, sin solicitud de permiso de Fotos y sin manejo de live photos ni HEIC. Es un parche razonable para flujos de "adjuntar algunas imágenes" y uno malo para cualquier cosa centrada en el carrete.

## Detalles y casos parecidos

**Una compilación Release hace desaparecer la excepción, y eso no es una solución.** `EnsureUIThread` depende de `ObjCRuntime.Runtime.CheckForIllegalCrossThreadCalls`, que la sustitución de ILLink desactiva en las compilaciones Release. El acceso a UIKit fuera del hilo sigue ocurriendo; solo pierdes el diagnóstico. Probar en Release y declarar victoria es como esto llega a la App Store como un crash intermitente en vez de una excepción determinista.

**No pongas `UIApplication.CheckForIllegalCrossThreadCalls = false`.** Silencia todas las aserciones de hilo de UI de tu aplicación, no solo esta, y el acceso subyacente es genuinamente inseguro.

**Envolver la llamada en `MainThread.InvokeOnMainThreadAsync` no sirve de nada.** El hilo se pierde dentro de MAUI, después de que el delegado del selector retorna, y el `ConfigureAwait(false)` de ahí descarta explícitamente cualquier contexto que hayas establecido en el punto de llamada. Los arreglos de hilos del lado del llamador no pueden alcanzarlo, igual que no pueden alcanzar [un interbloqueo causado por bloquear con .Result más abajo en la pila](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

**`PickVideosAsync` está afectado de forma idéntica.** Pasa por el mismo helper `PhotosAsync` y el mismo `PickerResultsToMediaFiles`. Si tu reproducción usa videos en vez de fotos, es el mismo bug.

**`PickPhotoAsync` (en singular) está bien.** Comparte la ruta de código pero produce exactamente un `PHPickerResult`, así que el bucle nunca llega a una segunda lectura. Si ves `UIKitThreadAccessException` con una selección única, estás ante otro problema, normalmente tu propia continuación tocando un control fuera del hilo principal.

**`SelectionLimit = 1` en `PickPhotosAsync` también es seguro.** Es una solución alternativa solo en el sentido de que elimina la selección múltiple, que es la funcionalidad por la que llamaste a esta API.

**No es lo mismo que [dotnet/maui#33954](https://github.com/dotnet/maui/issues/33954).** Ese, corregido en SR6, era `PickPhotosAsync` devolviendo menos imágenes de las seleccionadas cuando se fijaba `CompressionQuality`. Síntoma distinto, sin excepción, y ya publicado.

**Los ANR de Android son otra clase de bug de hilos en MAUI.** Si tu app MAUI también bloquea el hilo de UI en Android, eso aparece como un ANR en vez de una excepción, y el diagnóstico es completamente distinto: mira [cómo encontrar los manejadores async void que causan ANR en una app MAUI Android](/es/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/).

## Relacionado

- [ConfigureAwait(false) vs. el valor por defecto en .NET 11: ¿todavía importa?](/es/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [async void vs. async Task en C#: cuándo es correcto cada uno](/es/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [Solución: interbloqueo al llamar a .Result o .Wait() en un método asíncrono en C#](/es/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Cómo encontrar los manejadores async void que causan ANR en una app .NET MAUI Android](/es/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/)
- [Solución: el perfil de aprovisionamiento no incluye el dispositivo seleccionado en MAUI iOS](/es/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)

## Fuentes

- [dotnet/maui#37878 - MediaPicker.PickPhotosAsync lanza UIKitThreadAccessException cuando se seleccionan 2 o más elementos](https://github.com/dotnet/maui/issues/37878)
- [dotnet/maui#37879 - la corrección](https://github.com/dotnet/maui/pull/37879), retroportada como [#38481](https://github.com/dotnet/maui/pull/38481) y [#38488](https://github.com/dotnet/maui/pull/38488)
- [dotnet/maui#35805 - el cambio de SR10 que introdujo la regresión](https://github.com/dotnet/maui/pull/35805)
- [dotnet/macios - Runtime.EnsureUIThread y CheckForIllegalCrossThreadCalls](https://github.com/dotnet/macios/blob/main/src/ObjCRuntime/Runtime.cs)
- [Documentación para desarrolladores de Apple - PHPickerViewController](https://developer.apple.com/documentation/photokit/phpickerviewcontroller)
- [Microsoft Learn - Selector de medios en .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/device-media/picker)
