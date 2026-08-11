---
title: "Wie man in .NET MAUI 11 ein modales Fenster anzeigt"
description: "Zwei völlig verschiedene Dinge heißen in .NET MAUI 11 modales Fenster. PushModalAsync liefert auf jeder Plattform eine modale Seite. Ein echtes Betriebssystemfenster, das sein Besitzerfenster sperrt, hat in MAUI gar keine API. Hier steht die WinUI-Interop mit OverlappedPresenter.IsModal und dem Win32-Besitzerhandle, die unter Windows tatsächlich funktioniert, und was unter Mac Catalyst zu tun ist."
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
lang: "de"
translationOf: "2026/08/how-to-show-a-modal-window-in-dotnet-maui-11"
translatedBy: "claude"
translationDate: 2026-08-11
---

Wer danach sucht, meint vermutlich eines von zwei völlig verschiedenen Dingen, und .NET MAUI behandelt beide sehr unterschiedlich. Eine **modale Seite** (eine bildschirmfüllende Seite, die die Interaktion mit dem Dahinterliegenden blockiert, bis sie geschlossen wird) ist ein vollwertiges plattformübergreifendes Feature: `Navigation.PushModalAsync`. Ein **modales Fenster** im Desktop-Sinne (ein zweites Fenster oberster Ebene, das sein Besitzerfenster abblendet und sperrt, bis es bearbeitet wurde, so wie `ShowDialog` in WPF) hat in MAUI überhaupt keine API, weder in .NET MAUI 11 noch in einer früheren Version. `Application.Current.OpenWindow` öffnet ein *nicht modales* zweites Fenster. Für echte Modalität unter Windows greifen Sie über den Handler auf das WinUI-`AppWindow` durch, setzen mit einem Win32-Aufruf einen Besitzer und aktivieren `OverlappedPresenter.IsModal`. Unter Mac Catalyst gibt es kein Gegenstück; dort verwenden Sie stattdessen eine modale Seite.

.NET MAUI 11 steht im August 2026 bei `11.0.0-preview.6.26360.8` auf NuGet, die API-Oberfläche bewegt sich also noch. Alle folgenden Ausschnitte wurden gegen das stabile Workload .NET MAUI 10.0.20 auf dem .NET SDK 10.0.201 kompiliert, Ziel `net10.0-windows10.0.19041.0`. Die MAUI-11-Previews übernehmen all diese Member unverändert; die einzige relevante Umbenennung kam mit MAUI 10 und wird weiter unten behandelt.

## Welches "modal" Sie tatsächlich brauchen

| Was Sie wollen | Passende API | Wo es funktioniert |
| --- | --- | --- |
| Eine Seite, die die App überdeckt und die man nicht wegnavigieren kann | `Navigation.PushModalAsync` | Android, iOS, Mac Catalyst, Windows |
| Eine Ja/Nein-Frage oder eine einzelne Texteingabe | `DisplayAlertAsync`, `DisplayPromptAsync` | alle |
| Eine Überlagerung kleiner als der Bildschirm über der aktuellen Seite | `ShowPopupAsync` aus dem Community Toolkit | alle |
| Ein eigenes Betriebssystemfenster, das sein Besitzerfenster sperrt | Keine MAUI-API. WinUI- plus Win32-Interop | nur Windows |

Die vierte Zeile ist die ehrliche Antwort auf die Desktop-Frage, und sie erklärt, warum der Wunsch im MAUI-Repository seit 2022 offen ist. Alles andere ist gelöst.

## Modale Seiten und ihr Unterschied zu `PushAsync`

Modale Navigation verwendet einen von der hierarchischen Navigation getrennten Stack. `Navigation` stellt beide bereit, und der modale ist bewusst kleiner:

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

Es gibt kein `PopModalToRootAsync`, kein `InsertPageBefore` und kein `RemovePage` für den modalen Stack, weil die zugrunde liegenden Plattformen diese Operationen nicht durchgängig unterstützen. Sie bekommen `ModalStack` zur Inspektion, mehr nicht. Für einen modalen Push brauchen Sie außerdem keine `NavigationPage`, was in einer Shell-App zählt: `NavigationPage` wirft eine Ausnahme, wenn Sie sie innerhalb von Shell verwenden, modale Navigation funktioniert dort aber problemlos. Wenn Sie ohnehin über Shell routen, sehen Sie sich die Details zum [Übergeben von Daten über Shell-Routenparameter und Query-Eigenschaften](/de/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/) an, bevor Sie eine modale Seite zum Verschieben von Zustand einsetzen.

Die Klasse `Window` löst `ModalPushing`, `ModalPushed`, `ModalPopping`, `ModalPopped` und `PopCanceled` aus. So beobachten Sie den modalen Stack von außerhalb der Seiten selbst. `ModalPoppingEventArgs` trägt ein `Cancel`-Flag, das ist also auch die Stelle für ein "Wollen Sie die Änderungen wirklich verwerfen?":

```csharp
// .NET MAUI 10.0.20: veto a modal dismissal from the Window
Window.ModalPopping += (s, e) =>
{
    if (HasUnsavedChanges(e.Modal))
        e.Cancel = true;
};
```

## Ein Ergebnis aus einer modalen Seite zurückbekommen

`PushModalAsync` liefert eine `Task`, die abgeschlossen ist, sobald die Einblendanimation endet, nicht wenn die Benutzerin oder der Benutzer fertig ist. Darüber stolpert fast jeder beim ersten Mal. Die idiomatische Lösung ist eine `TaskCompletionSource<T>` auf der modalen Seite:

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

An der Aufrufstelle:

```csharp
var confirm = new ConfirmPage();
await Navigation.PushModalAsync(confirm);
bool accepted = await confirm.Result;
```

`TrySetResult` statt `SetResult` ist hier kein defensives Rauschen: `OnDisappearing` läuft tatsächlich, nachdem der Button-Handler das Ergebnis bereits gesetzt hat, und `SetResult` würde beim zweiten Aufruf eine `InvalidOperationException` werfen.

## Die Seite wirklich unumgehbar machen

Unter Android entfernt die Hardware- oder Gestenzurücktaste die modale Seite vom Stack, ob Sie wollen oder nicht. Überschreiben Sie `OnBackButtonPressed` auf der modalen Seite und geben Sie `true` zurück, um das Ereignis zu schlucken:

```csharp
protected override bool OnBackButtonPressed() => true;
```

Unter iOS lassen sich Modals im Sheet-Stil durch eine Abwärtswischgeste schließen. Das ist eine Frage des Präsentationsstils, dazu gleich mehr.

## Das Aussehen des Modals unter iOS und Mac Catalyst steuern

Standardmäßig wird eine modale Seite bildschirmfüllend präsentiert. Das iOS-Platform-Specific ändert das, und es ist einer der wenigen Regler, der auch Mac Catalyst betrifft, weil Catalyst die Präsentationsmechanik von UIKit ausführt:

```xaml
<ContentPage xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             xmlns:ios="clr-namespace:Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;assembly=Microsoft.Maui.Controls"
             x:Class="MyApp.ConfirmPage"
             ios:Page.ModalPresentationStyle="FormSheet">
</ContentPage>
```

Oder aus dem Code heraus:

```csharp
using Microsoft.Maui.Controls.PlatformConfiguration;
using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;
using Page = Microsoft.Maui.Controls.Page; // see the gotcha below

On<iOS>().SetModalPresentationStyle(UIModalPresentationStyle.FormSheet);
```

`UIModalPresentationStyle` bietet `FullScreen`, `FormSheet`, `PageSheet`, `OverFullScreen`, `Automatic` und seit .NET MAUI 10 auch `Popover`. `FormSheet` kommt einem Desktop-Dialog am nächsten, was Mac Catalyst hergibt: ein zentriertes, kleineres Panel über dem App-Fenster. `OverFullScreen` ist die richtige Wahl, wenn die modale Seite einen transparenten oder durchscheinenden Hintergrund hat.

## Schritte für ein echtes modales Fenster unter Windows

Das ist der Desktop-Fall: ein wirklich eigenständiges Fenster mit eigener Titelleiste, das das Fenster sperrt, aus dem es geöffnet wurde.

1. Erstellen Sie ein `Window` und öffnen Sie es mit `Application.Current.OpenWindow`. In diesem Moment hat das Fenster weder Handler noch Plattform-View, es lässt sich also noch nichts konfigurieren.
2. Warten Sie auf den Handler. Abonnieren Sie `HandlerChanged` auf dem neuen `Window`, bevor Sie es öffnen, oder prüfen Sie zuerst `Handler`, falls er bereits angehängt ist. Alles Weitere steht in einem `#if WINDOWS`-Block.
3. Casten Sie die Plattform-View auf `MauiWinUIWindow` und lesen Sie deren Eigenschaft `AppWindow`. Das ist das Objekt des Windows App SDK, das die Präsentation steuert.
4. Setzen Sie einen Besitzer. Rufen Sie `SetWindowLongPtr` mit `GWLP_HWNDPARENT` (`-8`) auf und übergeben Sie das HWND des Besitzerfensters. Dieser Schritt wird am häufigsten übersprungen.
5. Wenden Sie einen `OverlappedPresenter` an und setzen Sie `IsModal` auf `true`. `OverlappedPresenter.CreateForDialog()` liefert die Dialogvorgaben: nicht minimierbar, nicht maximierbar, nicht in der Größe veränderbar.
6. Aktivieren Sie das Besitzerfenster wieder, wenn das modale Fenster schließt. Behandeln Sie `Destroying` auf dem MAUI-`Window` und rufen Sie `Activate` auf dem Besitzer auf, sonst landet der Fokus in einer anderen Anwendung.

## Die Windows-Interop, vollständig

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

Die eigentliche Arbeit macht `IsModal`. Das Windows App SDK dokumentiert die Eigenschaft so, dass sie Vorrang vor dem Besitzerfenster hat und jede Eingabe dorthin blockiert, bis das modale Fenster geschlossen wird oder nicht mehr modal ist. Einen separaten Aufruf von `EnableWindow(ownerHwnd, false)` brauchen Sie nicht, sobald `IsModal` gesetzt ist, und wer ihn ergänzt, hat ein gesperrtes Besitzerfenster, das er später von Hand wieder freigeben muss.

`OverlappedPresenter.CreateForDialog()` belegt die dialogtypischen Werte vor, Sie müssen `IsMinimizable`, `IsMaximizable` und `IsResizable` also nicht einzeln abschalten. Wenn Sie ein normales Fenster wollen, das lediglich modal ist, verwenden Sie `OverlappedPresenter.Create()`. Beachten Sie außerdem: .NET MAUI 10 hat `Window.IsMinimizable` und `Window.IsMaximizable` als bindbare Eigenschaften am plattformübergreifenden `Window` ergänzt, für genau diese beiden Regler ist Interop also nicht mehr nötig.

## Fallstricke, die echte Zeit kosten

**`IsModal` ohne Besitzer wirft eine Ausnahme.** `IsModal = true` auf einem Fenster ohne Besitzer erzeugt `System.ArgumentException: Value does not fall within the expected range.` Das ist im Repository des Windows App SDK gemeldet und der Grund, warum es Schritt 4 gibt. Wenn Ihr modales Fenster in einem Codepfad funktioniert und in einem anderen fehlschlägt, prüfen Sie, ob das übergebene Besitzer-HWND ungleich null war.

**`Handler` ist direkt nach `OpenWindow` null.** MAUI erzeugt das Plattformfenster asynchron. Der Zugriff auf `window.Handler.PlatformView` in der Zeile nach `OpenWindow` wirft eine `NullReferenceException`. Der Helfer `WhenHandlerReady` oben existiert allein deswegen, und das Abonnieren von `HandlerChanged` *vor* dem `OpenWindow`-Aufruf macht ihn zuverlässig.

**`[LibraryImport]` verlangt einen `partial`-Typ.** Wer den P/Invoke in eine gewöhnliche `static class` einfügt, bekommt `SYSLIB1050: Method 'SetWindowLongPtr' is contained in a type 'ModalWindowService' that is not marked 'partial'`, gefolgt von `CS8795` und `CS0751`. Markieren Sie die Klasse als `partial`. Das ältere Attribut `[DllImport]` stellt diese Anforderung nicht, aber in einem getrimmten oder Native-AOT-Build ist die quellcodegenerierte Interop die richtige Wahl.

**Der iOS-Platform-Specific-Namespace überdeckt `Page`.** Fügen Sie `using Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific;` einer Datei hinzu, die auch `Microsoft.Maui.Controls` verwendet, erhalten Sie `CS0104: 'Page' is an ambiguous reference between 'Microsoft.Maui.Controls.Page' and 'Microsoft.Maui.Controls.PlatformConfiguration.iOSSpecific.Page'`. Ergänzen Sie `using Page = Microsoft.Maui.Controls.Page;` oder qualifizieren Sie den Namen vollständig.

**`DisplayAlert` wurde in .NET MAUI 10 umbenannt.** Die Pop-up-Methoden auf `Page` heißen jetzt `DisplayAlertAsync`, `DisplayActionSheetAsync` und `DisplayPromptAsync`. `DisplayPromptAsync` behielt seinen Namen, weil er schon immer so lautete. Beim Portieren einer MAUI-8- oder MAUI-9-Codebasis ist das eine stille Quelle von Buildfehlern.

**Multi-Window braucht plattformspezifische Einrichtung und läuft auf dem iPhone nie.** Schon der nicht modale `OpenWindow`-Pfad verlangt unter Android `LaunchMode.Multiple` an der `MainActivity` sowie für iPadOS und Mac Catalyst eine `SceneDelegate`-Klasse plus einen `UIApplicationSceneManifest`-Eintrag in der `Info.plist`. Windows braucht nichts davon. iOS auf dem iPhone kann es überhaupt nicht. Wenn Ihre App ohnehin nur für den Desktop gedacht ist, entfernt das [Zurechtschneiden eines MAUI-Projekts auf Windows und Mac Catalyst](/de/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) den größten Teil dieser Konfigurationsoberfläche.

**Mac Catalyst hat kein `IsModal`-Gegenstück.** Ein Analogon zu `OverlappedPresenter` existiert unter Catalyst nicht, und MAUI stellt `beginSheet` nicht bereit. Präsentieren Sie unter Catalyst eine modale Seite mit `FormSheet` und akzeptieren Sie, dass sie auf das Fenster und nicht auf die App begrenzt ist. Sind echte anwendungsweite modale Fenster auf allen Desktop-Plattformen eine harte Produktanforderung, ist das einer der konkreten Fälle, in denen [MAUI gegen Avalonia und Uno verliert](/de/2026/05/maui-vs-avalonia-vs-uno-in-2026/).

## Wann ein Popup die bessere Antwort ist

Wenn Sie in Wahrheit eine Überlagerung wollen, die kleiner als der Bildschirm ist und über der aktuellen Seite schwebt, ist weder eine modale Seite noch ein zweites Fenster richtig. Das .NET MAUI Community Toolkit (im August 2026 in Version 15.0.0) bietet `ShowPopupAsync`, `Popup<T>` für typisierte Ergebnisse und `IPopupService` für die Anzeige aus dem View Model heraus. Setzen Sie `CanBeDismissedByTappingOutsideOfPopup` auf `false`, und Sie haben eine blockierende Überlagerung ohne jede der obigen Interop. Wichtig zu wissen: Das Popup des Toolkits ist als `ContentPage`-Überlagerung implementiert, die aufrufende Seite erhält also weiterhin `OnNavigatingFrom`, `OnDisappearing` und `OnNavigatedFrom`. Wenn diese Ereignisse für Sie bisher "der Benutzer hat diesen Bildschirm verlassen" bedeuteten, löst ein Popup sie ebenfalls aus.

Entscheiden Sie nach Geltungsbereich, nicht nach Gewohnheit. Eine Aufgabe innerhalb eines Fensters blockieren heißt modale Seite. Die gesamte Anwendung unter Windows blockieren heißt die obige Interop. Alles andere ist ein Popup.

## Verwandte Artikel

- [Shell-Routenparameter und Query-Eigenschaften für die Navigation in .NET MAUI 11 nutzen](/de/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/)
- [Eine MAUI-App schreiben, die nur unter Windows und macOS läuft (ohne Mobile)](/de/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/)
- [Drag and Drop in .NET MAUI 11 umsetzen](/de/2026/05/how-to-implement-drag-and-drop-in-maui-11/)
- [Dark Mode in einer .NET MAUI App richtig unterstützen](/de/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/)
- [MAUI vs Avalonia vs Uno Platform: Was sollten Sie 2026 wählen?](/de/2026/05/maui-vs-avalonia-vs-uno-in-2026/)

## Quellen

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
