---
title: "How to show a modal window in .NET MAUI 11"
description: "Two different things get called a modal window in .NET MAUI 11. PushModalAsync gives you a modal page on every platform. A real OS window that disables its owner has no MAUI API at all, so here is the WinUI OverlappedPresenter.IsModal plus Win32 owner-handle interop that actually works on Windows, and what to do on Mac Catalyst instead."
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
---

If you searched for this, you probably mean one of two completely different things, and .NET MAUI treats them very differently. A **modal page** (a full-screen page that blocks interaction with what is behind it until it is dismissed) is a first-class cross-platform feature: `Navigation.PushModalAsync`. A **modal window** in the desktop sense (a second top-level OS window that greys out and disables its owner until you deal with it, the way a WPF `ShowDialog` does) has no MAUI API at all, not in .NET MAUI 11 and not in any earlier version. `Application.Current.OpenWindow` opens a *modeless* second window. To get real modality on Windows you drop through the handler to the WinUI `AppWindow`, set an owner with a Win32 call, and flip `OverlappedPresenter.IsModal`. On Mac Catalyst there is no equivalent, and you should use a modal page instead.

.NET MAUI 11 is at `11.0.0-preview.6.26360.8` on NuGet as of August 2026, so the API surface here is still moving. Every snippet below was compiled against the shipping .NET MAUI 10.0.20 workload on .NET SDK 10.0.201, targeting `net10.0-windows10.0.19041.0`. The MAUI 11 previews carry all of these members forward unchanged; the one rename you need to know about landed in MAUI 10 and is covered below.

## Which "modal" do you actually want

| What you want | API to use | Where it works |
| --- | --- | --- |
| A page that covers the app and cannot be navigated away from | `Navigation.PushModalAsync` | Android, iOS, Mac Catalyst, Windows |
| A yes/no question or a single text input | `DisplayAlertAsync`, `DisplayPromptAsync` | all |
| An overlay smaller than the screen, over the current page | Community Toolkit `ShowPopupAsync` | all |
| A separate OS window that disables its owner window | No MAUI API. WinUI + Win32 interop | Windows only |

The fourth row is the honest answer to the desktop question, and it is the reason the request has been open on the MAUI repo since 2022. Everything else is a solved problem.

## Modal pages, and what makes them different from `PushAsync`

Modal navigation uses a separate stack from hierarchical navigation. `Navigation` exposes both, and the modal one is deliberately smaller:

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

There is no `PopModalToRootAsync`, no `InsertPageBefore` and no `RemovePage` for the modal stack, because those operations are not universally supported by the underlying platforms. You get `ModalStack` for inspection and that is it. You also do not need a `NavigationPage` to push modally, which matters in a Shell app: `NavigationPage` throws if you use it inside Shell, but modal navigation works fine there. If you are already routing through Shell, see the details on [passing data through Shell route parameters and query properties](/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/) before you reach for a modal page to move state around.

The `Window` class raises `ModalPushing`, `ModalPushed`, `ModalPopping`, `ModalPopped` and `PopCanceled`, which is how you observe the modal stack from outside the pages themselves. `ModalPoppingEventArgs` carries a `Cancel` flag, so this is also the seam for "are you sure you want to discard this?":

```csharp
// .NET MAUI 10.0.20: veto a modal dismissal from the Window
Window.ModalPopping += (s, e) =>
{
    if (HasUnsavedChanges(e.Modal))
        e.Cancel = true;
};
```

## Getting a result back from a modal page

`PushModalAsync` returns a `Task` that completes when the push animation finishes, not when the user is done. This trips up almost everyone the first time. The idiomatic fix is a `TaskCompletionSource<T>` on the modal page:

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

Call site:

```csharp
var confirm = new ConfirmPage();
await Navigation.PushModalAsync(confirm);
bool accepted = await confirm.Result;
```

`TrySetResult` rather than `SetResult` is not defensive noise here: `OnDisappearing` genuinely runs after the button handler has already set the result, and `SetResult` would throw `InvalidOperationException` on the second call.

## Making the page genuinely unskippable

On Android the hardware or gesture back button pops the modal stack whether you like it or not. Override `OnBackButtonPressed` on the modal page and return `true` to swallow it:

```csharp
protected override bool OnBackButtonPressed() => true;
```

On iOS, sheet-style modals can be dismissed with a downward swipe. That is a presentation-style concern, covered next.

## Controlling how the modal looks on iOS and Mac Catalyst

By default a modal page is presented full screen. The iOS platform-specific changes that, and it is one of the few knobs that also affects Mac Catalyst, because Catalyst runs the UIKit presentation machinery:

```xaml
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:ios="clr-namespace:Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;assembly=Microsoft.Maui.Controls"
             x:Class="MyApp.ConfirmPage"
             ios:Page.ModalPresentationStyle="FormSheet">
</ContentPage>
```

Or from code:

```csharp
using Microsoft.Maui.Controls.PlatformConfiguration;
using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;
using Page = Microsoft.Maui.Controls.Page; // see the gotcha below

On<iOS>().SetModalPresentationStyle(UIModalPresentationStyle.FormSheet);
```

`UIModalPresentationStyle` offers `FullScreen`, `FormSheet`, `PageSheet`, `OverFullScreen`, `Automatic` and, since .NET MAUI 10, `Popover`. `FormSheet` is the closest thing to a desktop dialog that Mac Catalyst gives you: a centred, smaller-than-screen panel over the app window. `OverFullScreen` is what you want if the modal page has a transparent or translucent background.

## Steps to show a real modal window on Windows

This is the desktop case: a genuinely separate window, with its own title bar, that disables the window it came from.

1. Create a `Window` and open it with `Application.Current.OpenWindow`. At this instant the window has no handler and no platform view, so you cannot configure anything yet.
2. Wait for the handler. Subscribe to `HandlerChanged` on the new `Window` before opening it, or check `Handler` first in case it is already attached. Everything after this point is inside a `#if WINDOWS` block.
3. Cast the platform view to `MauiWinUIWindow` and read its `AppWindow` property. That is the Windows App SDK object that owns presentation.
4. Set an owner. Call `SetWindowLongPtr` with `GWLP_HWNDPARENT` (`-8`), passing the owner window's HWND. Skipping this is the single most common failure.
5. Apply an `OverlappedPresenter` and set `IsModal` to `true`. Use `OverlappedPresenter.CreateForDialog()` for dialog defaults: no minimise, no maximise, not resizable.
6. Re-activate the owner when the modal window closes. Handle `Destroying` on the MAUI `Window` and call `Activate` on the owner, otherwise focus lands on another application.

## The Windows interop, in full

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

`IsModal` is doing the real work. The Windows App SDK documents it as taking precedence over the owner window and blocking all input to it until the modal window is dismissed or stops being modal. You do not need a separate `EnableWindow(ownerHwnd, false)` call once `IsModal` is set, and adding one gives you a disabled owner that you then have to remember to re-enable by hand.

`OverlappedPresenter.CreateForDialog()` pre-populates dialog-shaped values, so you do not have to turn off `IsMinimizable`, `IsMaximizable` and `IsResizable` individually. If you want a normal window that merely happens to be modal, use `OverlappedPresenter.Create()` instead. Note also that .NET MAUI 10 added `Window.IsMinimizable` and `Window.IsMaximizable` as bindable properties on the cross-platform `Window`, so for those two specific knobs you no longer need interop at all.

## Gotchas that cost real time

**`IsModal` without an owner throws.** Setting `IsModal = true` on a window with no owner produces `System.ArgumentException: Value does not fall within the expected range.` This is reported on the Windows App SDK repo and it is the reason step 4 exists. If your modal window works in one code path and throws in another, check that the owner HWND you passed was non-zero.

**`Handler` is null right after `OpenWindow`.** MAUI creates the platform window asynchronously. Reading `window.Handler.PlatformView` on the line after `OpenWindow` throws a `NullReferenceException`. The `WhenHandlerReady` helper above exists purely for this, and subscribing to `HandlerChanged` *before* the `OpenWindow` call is what makes it reliable.

**`[LibraryImport]` needs a `partial` type.** If you paste the P/Invoke into a plain `static class` you get `SYSLIB1050: Method 'SetWindowLongPtr' is contained in a type 'ModalWindowService' that is not marked 'partial'`, followed by `CS8795` and `CS0751`. Mark the class `partial`. The older `[DllImport]` attribute has no such requirement, but the source-generated interop is what you want in a trimmed or Native AOT build.

**The iOS platform-specific namespace shadows `Page`.** Adding `using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;` to a file that also uses `Microsoft.Maui.Controls` gives you `CS0104: 'Page' is an ambiguous reference between 'Microsoft.Maui.Controls.Page' and 'Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific.Page'`. Add `using Page = Microsoft.Maui.Controls.Page;` or fully qualify.

**`DisplayAlert` was renamed in .NET MAUI 10.** The pop-up methods on `Page` are now `DisplayAlertAsync`, `DisplayActionSheetAsync` and `DisplayPromptAsync`. `DisplayPromptAsync` kept its name because it always had one. If you are porting a MAUI 8 or 9 codebase forward, this is a quiet source of build breaks.

**Multi-window needs per-platform setup, and never works on iPhone.** Even the modeless `OpenWindow` path requires `LaunchMode.Multiple` on `MainActivity` for Android, and a `SceneDelegate` class plus a `UIApplicationSceneManifest` entry in `Info.plist` for iPadOS and Mac Catalyst. Windows needs nothing. iOS on iPhone cannot do it at all. If your app is desktop-only anyway, [trimming a MAUI project down to Windows and Mac Catalyst](/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) removes most of this configuration surface.

**Mac Catalyst has no `IsModal` equivalent.** There is no Catalyst analogue to `OverlappedPresenter`, and MAUI does not expose `beginSheet`. On Catalyst, present a modal page with `FormSheet` and accept that it is scoped to the window rather than to the app. If true per-app modal windows are a hard product requirement across desktop platforms, that is one of the concrete cases where [MAUI loses to Avalonia and Uno](/2026/05/maui-vs-avalonia-vs-uno-in-2026/).

## When a popup is the better answer

If what you actually want is an overlay that is smaller than the screen and floats above the current page, neither a modal page nor a second window is right. The .NET MAUI Community Toolkit (15.0.0 as of August 2026) has `ShowPopupAsync`, `Popup<T>` for typed results, and `IPopupService` for view-model-driven display. Set `CanBeDismissedByTappingOutsideOfPopup` to `false` and you have a blocking overlay with none of the interop above. It is worth knowing that the toolkit's popup is implemented as a `ContentPage` overlay, so the calling page still receives `OnNavigatingFrom`, `OnDisappearing` and `OnNavigatedFrom`. If you were relying on those events to mean "the user left this screen", a popup will fire them too.

Pick by scope, not by habit. Blocking one task inside one window is a modal page. Blocking the entire app on Windows is the interop above. Everything else is a popup.

## Related

- [How to use Shell route parameters and query properties for navigation in .NET MAUI 11](/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/)
- [How to write a MAUI app that runs on Windows and macOS only (no mobile)](/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/)
- [How to implement drag-and-drop in .NET MAUI 11](/2026/05/how-to-implement-drag-and-drop-in-maui-11/)
- [How to support dark mode correctly in a .NET MAUI app](/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/)
- [MAUI vs Avalonia vs Uno Platform: which should you pick in 2026?](/2026/05/maui-vs-avalonia-vs-uno-in-2026/)

## Sources

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
