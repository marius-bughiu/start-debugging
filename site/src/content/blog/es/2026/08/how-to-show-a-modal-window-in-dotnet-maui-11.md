---
title: "Cómo mostrar una ventana modal en .NET MAUI 11"
description: "Dos cosas muy distintas se llaman ventana modal en .NET MAUI 11. PushModalAsync te da una página modal en todas las plataformas. Una ventana del sistema operativo que deshabilite a su propietaria no tiene API en MAUI, así que aquí está la interoperabilidad con OverlappedPresenter.IsModal de WinUI y el handle de propietario de Win32 que sí funciona en Windows, y qué hacer en Mac Catalyst."
pubDate: 2026-08-11
template: how-to
tags:
  - "dotnet-maui"
  - "dotnet"
  - "csharp"
  - "windows"
  - "winui"
  - "navigation"
  - "how-to"
lang: "es"
translationOf: "2026/08/how-to-show-a-modal-window-in-dotnet-maui-11"
translatedBy: "claude"
translationDate: 2026-08-11
---

Si llegaste buscando esto, seguramente te refieres a una de dos cosas completamente distintas, y .NET MAUI las trata de forma muy diferente. Una **página modal** (una página a pantalla completa que bloquea la interacción con lo que hay detrás hasta que se cierra) es una funcionalidad multiplataforma de primera clase: `Navigation.PushModalAsync`. Una **ventana modal** en el sentido de escritorio (una segunda ventana de nivel superior que atenúa y deshabilita a su propietaria hasta que la atiendas, como hace `ShowDialog` en WPF) no tiene ninguna API en MAUI, ni en .NET MAUI 11 ni en ninguna versión anterior. `Application.Current.OpenWindow` abre una segunda ventana *no modal*. Para conseguir modalidad real en Windows tienes que bajar a través del handler hasta el `AppWindow` de WinUI, asignar un propietario con una llamada de Win32 y activar `OverlappedPresenter.IsModal`. En Mac Catalyst no hay equivalente, y ahí conviene usar una página modal.

.NET MAUI 11 está en `11.0.0-preview.6.26360.8` en NuGet en agosto de 2026, así que la superficie de API todavía se mueve. Todos los fragmentos de abajo se compilaron contra el workload estable .NET MAUI 10.0.20 sobre el SDK de .NET 10.0.201, con destino `net10.0-windows10.0.19041.0`. Las versiones preliminares de MAUI 11 mantienen todos estos miembros sin cambios; el único renombrado que necesitas conocer llegó en MAUI 10 y lo cubro más abajo.

## Cuál de los dos "modal" quieres realmente

| Lo que quieres | API a usar | Dónde funciona |
| --- | --- | --- |
| Una página que cubre la app y de la que no se puede salir navegando | `Navigation.PushModalAsync` | Android, iOS, Mac Catalyst, Windows |
| Una pregunta de sí/no o una sola entrada de texto | `DisplayAlertAsync`, `DisplayPromptAsync` | todas |
| Una superposición más pequeña que la pantalla, sobre la página actual | `ShowPopupAsync` del Community Toolkit | todas |
| Una ventana del sistema operativa aparte que deshabilita a su propietaria | Sin API en MAUI. Interoperabilidad WinUI + Win32 | solo Windows |

La cuarta fila es la respuesta honesta a la pregunta de escritorio, y es la razón por la que la petición lleva abierta en el repositorio de MAUI desde 2022. Todo lo demás es un problema resuelto.

## Páginas modales, y qué las diferencia de `PushAsync`

La navegación modal usa una pila separada de la navegación jerárquica. `Navigation` expone ambas, y la modal es deliberadamente más pequeña:

```csharp
// .NET MAUI 10.0.20 / 11.0 preview
async void OnOpenModalClicked(object sender, EventArgs e)
{
    await Navigation.PushModalAsync(new ConfirmPage());
}

async void OnCloseModalClicked(object sender, EventArgs e)
{
    await Navigation.PopModalAsync();
}
```

No existe `PopModalToRootAsync`, ni `InsertPageBefore`, ni `RemovePage` para la pila modal, porque esas operaciones no están soportadas de forma universal por las plataformas subyacentes. Tienes `ModalStack` para inspeccionar y nada más. Tampoco necesitas un `NavigationPage` para hacer un push modal, lo cual importa en una app con Shell: `NavigationPage` lanza una excepción si lo usas dentro de Shell, pero la navegación modal funciona sin problema. Si ya enrutas con Shell, revisa los detalles sobre [pasar datos con parámetros de ruta y propiedades de consulta en Shell](/es/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/) antes de recurrir a una página modal para mover estado.

La clase `Window` dispara `ModalPushing`, `ModalPushed`, `ModalPopping`, `ModalPopped` y `PopCanceled`, que es como observas la pila modal desde fuera de las páginas. `ModalPoppingEventArgs` lleva una bandera `Cancel`, así que este es también el punto de enganche para un "¿seguro que quieres descartar esto?":

```csharp
// .NET MAUI 10.0.20: veto a modal dismissal from the Window
Window.ModalPopping += (s, e) =>
{
    if (HasUnsavedChanges(e.Modal))
        e.Cancel = true;
};
```

## Recuperar un resultado de una página modal

`PushModalAsync` devuelve una `Task` que se completa cuando termina la animación de entrada, no cuando el usuario ha terminado. Esto sorprende a casi todo el mundo la primera vez. La solución idiomática es un `TaskCompletionSource<T>` en la página modal:

```csharp
// .NET MAUI 10.0.20, C# 14
public sealed class ConfirmPage : ContentPage
{
    readonly TaskCompletionSource<bool> _tcs = new();

    public Task<bool> Result => _tcs.Task;

    public ConfirmPage()
    {
        var ok = new Button { Text = "OK" };
        ok.Clicked += async (s, e) =>
        {
            _tcs.TrySetResult(true);
            await Navigation.PopModalAsync();
        };
        Content = ok;
    }

    protected override void OnDisappearing()
    {
        base.OnDisappearing();
        // Covers swipe-to-dismiss on iOS and the Android back button.
        _tcs.TrySetResult(false);
    }
}
```

Desde donde la llamas:

```csharp
var confirm = new ConfirmPage();
await Navigation.PushModalAsync(confirm);
bool accepted = await confirm.Result;
```

Usar `TrySetResult` en lugar de `SetResult` no es ruido defensivo: `OnDisappearing` se ejecuta realmente después de que el manejador del botón ya haya asignado el resultado, y `SetResult` lanzaría `InvalidOperationException` en la segunda llamada.

## Hacer que la página sea de verdad ineludible

En Android el botón atrás por hardware o por gesto saca la página de la pila modal te guste o no. Sobrescribe `OnBackButtonPressed` en la página modal y devuelve `true` para tragártelo:

```csharp
protected override bool OnBackButtonPressed() => true;
```

En iOS, los modales tipo hoja se pueden cerrar con un deslizamiento hacia abajo. Eso es cuestión del estilo de presentación, que viene a continuación.

## Controlar cómo se ve el modal en iOS y Mac Catalyst

Por defecto una página modal se presenta a pantalla completa. El platform-specific de iOS cambia eso, y es una de las pocas perillas que también afecta a Mac Catalyst, porque Catalyst ejecuta la maquinaria de presentación de UIKit:

```xaml
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:ios="clr-namespace:Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;assembly=Microsoft.Maui.Controls"
             x:Class="MyApp.ConfirmPage"
             ios:Page.ModalPresentationStyle="FormSheet">
</ContentPage>
```

O desde código:

```csharp
using Microsoft.Maui.Controls.PlatformConfiguration;
using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;
using Page = Microsoft.Maui.Controls.Page; // see the gotcha below

On<iOS>().SetModalPresentationStyle(UIModalPresentationStyle.FormSheet);
```

`UIModalPresentationStyle` ofrece `FullScreen`, `FormSheet`, `PageSheet`, `OverFullScreen`, `Automatic` y, desde .NET MAUI 10, `Popover`. `FormSheet` es lo más parecido a un diálogo de escritorio que te da Mac Catalyst: un panel centrado y más pequeño que la pantalla, sobre la ventana de la app. `OverFullScreen` es lo que quieres si la página modal tiene fondo transparente o translúcido.

## Pasos para mostrar una ventana modal real en Windows

Este es el caso de escritorio: una ventana genuinamente separada, con su propia barra de título, que deshabilita a la ventana de la que salió.

1. Crea una `Window` y ábrela con `Application.Current.OpenWindow`. En ese instante la ventana no tiene handler ni vista de plataforma, así que todavía no puedes configurar nada.
2. Espera al handler. Suscríbete a `HandlerChanged` en la nueva `Window` antes de abrirla, o comprueba primero `Handler` por si ya está adjunto. Todo lo que viene después va dentro de un bloque `#if WINDOWS`.
3. Castea la vista de plataforma a `MauiWinUIWindow` y lee su propiedad `AppWindow`. Ese es el objeto del Windows App SDK que controla la presentación.
4. Asigna un propietario. Llama a `SetWindowLongPtr` con `GWLP_HWNDPARENT` (`-8`), pasando el HWND de la ventana propietaria. Saltarse esto es el fallo más común con diferencia.
5. Aplica un `OverlappedPresenter` y pon `IsModal` en `true`. Usa `OverlappedPresenter.CreateForDialog()` para los valores por defecto de diálogo: sin minimizar, sin maximizar, no redimensionable.
6. Reactiva la ventana propietaria cuando la modal se cierre. Maneja `Destroying` en la `Window` de MAUI y llama a `Activate` sobre la propietaria; si no, el foco se va a otra aplicación.

## La interoperabilidad de Windows, completa

```csharp
// ModalWindowService.cs
// Verified against .NET MAUI 10.0.20 / .NET SDK 10.0.201, net10.0-windows10.0.19041.0
#if WINDOWS
using System.Runtime.InteropServices;
using Microsoft.Maui.Platform;   // MauiWinUIWindow
using Microsoft.UI.Windowing;    // AppWindow, OverlappedPresenter
using WinRT.Interop;             // WindowNative
#endif

namespace MyApp;

public static partial class ModalWindowService
{
    public static void ShowModal(Window owner, Page content, string title)
    {
        var modal = new Window(content) { Title = title, Width = 520, Height = 360 };

#if WINDOWS
        WhenHandlerReady(modal, () => MakeModal(modal, owner));
        modal.Destroying += (s, e) => Application.Current?.ActivateWindow(owner);
#endif

        Application.Current?.OpenWindow(modal);
    }

    static void WhenHandlerReady(Window window, Action action)
    {
        if (window.Handler?.PlatformView is not null)
        {
            action();
            return;
        }

        void OnChanged(object? sender, EventArgs e)
        {
            window.HandlerChanged -= OnChanged;
            if (window.Handler?.PlatformView is not null)
                action();
        }

        window.HandlerChanged += OnChanged;
    }

#if WINDOWS
    const int GWLP_HWNDPARENT = -8;

    static void MakeModal(Window modal, Window owner)
    {
        var nativeModal = (MauiWinUIWindow)modal.Handler!.PlatformView!;
        var nativeOwner = (MauiWinUIWindow)owner.Handler!.PlatformView!;

        nint modalHwnd = WindowNative.GetWindowHandle(nativeModal);
        nint ownerHwnd = WindowNative.GetWindowHandle(nativeOwner);

        // Ownership must be established before IsModal is set.
        SetWindowLongPtr(modalHwnd, GWLP_HWNDPARENT, ownerHwnd);

        AppWindow appWindow = nativeModal.AppWindow;
        var presenter = OverlappedPresenter.CreateForDialog();
        appWindow.SetPresenter(presenter);
        presenter.IsModal = true;
    }

    [LibraryImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static partial nint SetWindowLongPtr(nint hWnd, int nIndex, nint dwNewLong);
#endif
}
```

`IsModal` es quien hace el trabajo de verdad. El Windows App SDK lo documenta como que tiene precedencia sobre la ventana propietaria y bloquea toda entrada hacia ella hasta que la ventana modal se cierra o deja de ser modal. No necesitas una llamada aparte a `EnableWindow(ownerHwnd, false)` una vez que `IsModal` está puesto, y añadirla te deja una ventana propietaria deshabilitada que luego tienes que acordarte de rehabilitar a mano.

`OverlappedPresenter.CreateForDialog()` rellena de antemano valores con forma de diálogo, así que no tienes que desactivar `IsMinimizable`, `IsMaximizable` e `IsResizable` uno por uno. Si quieres una ventana normal que simplemente resulte ser modal, usa `OverlappedPresenter.Create()`. Ten en cuenta además que .NET MAUI 10 añadió `Window.IsMinimizable` y `Window.IsMaximizable` como propiedades enlazables en la `Window` multiplataforma, así que para esas dos perillas concretas ya no hace falta interoperabilidad.

## Trampas que cuestan tiempo real

**`IsModal` sin propietario lanza excepción.** Poner `IsModal = true` en una ventana sin propietario produce `System.ArgumentException: Value does not fall within the expected range.` Está reportado en el repositorio del Windows App SDK y es la razón de que exista el paso 4. Si tu ventana modal funciona en una ruta de código y falla en otra, comprueba que el HWND propietario que pasaste no fuera cero.

**`Handler` es null justo después de `OpenWindow`.** MAUI crea la ventana de plataforma de forma asíncrona. Leer `window.Handler.PlatformView` en la línea siguiente a `OpenWindow` lanza `NullReferenceException`. El helper `WhenHandlerReady` de arriba existe exactamente por esto, y suscribirse a `HandlerChanged` *antes* de la llamada a `OpenWindow` es lo que lo hace fiable.

**`[LibraryImport]` necesita un tipo `partial`.** Si pegas el P/Invoke en una `static class` normal obtienes `SYSLIB1050: Method 'SetWindowLongPtr' is contained in a type 'ModalWindowService' that is not marked 'partial'`, seguido de `CS8795` y `CS0751`. Marca la clase como `partial`. El atributo `[DllImport]` más antiguo no tiene ese requisito, pero la interoperabilidad generada por código fuente es lo que quieres en una compilación recortada o con Native AOT.

**El espacio de nombres del platform-specific de iOS oculta `Page`.** Añadir `using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;` a un archivo que también usa `Microsoft.Maui.Controls` te da `CS0104: 'Page' is an ambiguous reference between 'Microsoft.Maui.Controls.Page' and 'Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific.Page'`. Añade `using Page = Microsoft.Maui.Controls.Page;` o cualifica el nombre completo.

**`DisplayAlert` se renombró en .NET MAUI 10.** Los métodos emergentes de `Page` ahora son `DisplayAlertAsync`, `DisplayActionSheetAsync` y `DisplayPromptAsync`. `DisplayPromptAsync` conservó su nombre porque siempre lo tuvo. Si estás portando un código de MAUI 8 o 9 hacia adelante, esta es una fuente silenciosa de errores de compilación.

**Multiventana necesita configuración por plataforma, y nunca funciona en iPhone.** Incluso la ruta no modal de `OpenWindow` requiere `LaunchMode.Multiple` en `MainActivity` para Android, y una clase `SceneDelegate` más una entrada `UIApplicationSceneManifest` en `Info.plist` para iPadOS y Mac Catalyst. Windows no necesita nada. iOS en iPhone no puede hacerlo en absoluto. Si tu app es solo de escritorio de todos modos, [recortar un proyecto MAUI a Windows y Mac Catalyst](/es/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) elimina buena parte de esa superficie de configuración.

**Mac Catalyst no tiene equivalente de `IsModal`.** No hay análogo de `OverlappedPresenter` en Catalyst, y MAUI no expone `beginSheet`. En Catalyst, presenta una página modal con `FormSheet` y asume que queda acotada a la ventana y no a la app. Si las ventanas modales de verdad a nivel de aplicación son un requisito duro de producto en todas las plataformas de escritorio, ese es uno de los casos concretos en los que [MAUI pierde frente a Avalonia y Uno](/es/2026/05/maui-vs-avalonia-vs-uno-in-2026/).

## Cuándo un popup es la mejor respuesta

Si lo que de verdad quieres es una superposición más pequeña que la pantalla y que flote sobre la página actual, ni una página modal ni una segunda ventana son lo correcto. El .NET MAUI Community Toolkit (15.0.0 en agosto de 2026) tiene `ShowPopupAsync`, `Popup<T>` para resultados tipados e `IPopupService` para mostrarlos desde el modelo de vista. Pon `CanBeDismissedByTappingOutsideOfPopup` en `false` y tienes una superposición bloqueante sin nada de la interoperabilidad de arriba. Conviene saber que el popup del toolkit está implementado como una superposición de `ContentPage`, así que la página que lo llama sigue recibiendo `OnNavigatingFrom`, `OnDisappearing` y `OnNavigatedFrom`. Si dependías de esos eventos para saber que "el usuario salió de esta pantalla", un popup también los disparará.

Elige por alcance, no por costumbre. Bloquear una tarea dentro de una ventana es una página modal. Bloquear la aplicación entera en Windows es la interoperabilidad de arriba. Todo lo demás es un popup.

## Relacionado

- [Cómo usar parámetros de ruta y propiedades de consulta de Shell para navegar en .NET MAUI 11](/es/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/)
- [Cómo escribir una app MAUI que se ejecute solo en Windows y macOS (sin móvil)](/es/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/)
- [Cómo implementar arrastrar y soltar en .NET MAUI 11](/es/2026/05/how-to-implement-drag-and-drop-in-maui-11/)
- [Cómo soportar el modo oscuro correctamente en una app de .NET MAUI](/es/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/)
- [MAUI vs Avalonia vs Uno Platform: ¿cuál elegir en 2026?](/es/2026/05/maui-vs-avalonia-vs-uno-in-2026/)

## Fuentes

- [Window - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/window?view=net-maui-11.0)
- [NavigationPage, Perform modal navigation - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/pages/navigationpage?view=net-maui-11.0)
- [Display pop-ups - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/pop-ups?view=net-maui-11.0)
- [Modal page presentation style on iOS - .NET MAUI, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/ios/platform-specifics/page-presentation-style?view=net-maui-11.0)
- [OverlappedPresenter.IsModal Property, Windows App SDK](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.windowing.overlappedpresenter.ismodal)
- [OverlappedPresenter Class, Windows App SDK](https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.windowing.overlappedpresenter)
- [microsoft/WindowsAppSDK#3258, ArgumentException when OverlappedPresenter.IsModal is set to true](https://github.com/microsoft/WindowsAppSDK/issues/3258)
- [microsoft/WindowsAppSDK discussion #4435, on the issue of modal windows](https://github.com/microsoft/WindowsAppSDK/discussions/4435)
- [dotnet/maui#6210, Multi-Window in Windows with all options](https://github.com/dotnet/maui/issues/6210)
- [SYSLIB1050, source-generated P/Invoke diagnostics](https://learn.microsoft.com/dotnet/fundamentals/syslib-diagnostics/syslib1050)
- [.NET MAUI Community Toolkit Popup documentation](https://learn.microsoft.com/en-us/dotnet/communitytoolkit/maui/views/popup)
