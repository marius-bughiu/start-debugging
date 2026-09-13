---
title: "Die Android-Zurück-Taste auf einer Root-Seite in .NET MAUI Shell abfangen"
description: "Überschreiben Sie OnBackButtonPressed auf der Root-Seite und verwenden Sie .NET MAUI 10.0.101 oder neuer. Warum Root-Seiten ab 10.0.70 (Android 16) und 10.0.100 (jede Android-Version) keine Zurück-Eingaben mehr erhielten, warum .NET 11 RC 1 weiterhin betroffen ist, warum Shell.OnNavigating und BackButtonBehavior.Command nicht helfen, und ein MainActivity-Workaround für die fehlerhaften Versionen."
pubDate: 2026-09-13
template: how-to
tags:
  - "dotnet-maui"
  - "android"
  - "maui-shell"
  - "predictive-back"
  - "dotnet-10"
  - "dotnet-11"
lang: "de"
translationOf: "2026/09/how-to-intercept-the-android-back-button-on-a-dotnet-maui-shell-root-page"
translatedBy: "claude"
translationDate: 2026-09-13
---

**Kurze Antwort:** Überschreiben Sie `OnBackButtonPressed()` auf der Root-`ContentPage` (oder auf Ihrer `AppShell`), geben Sie `true` zurück, um die Eingabe zu verschlucken, und stellen Sie sicher, dass Sie **.NET MAUI 10.0.101** (veröffentlicht am 2026-09-07) oder neuer verwenden. Zwischen 10.0.70 und 10.0.100 sowie in .NET MAUI 11 RC 1 (`11.0.0-rc.1.26451.6`) wird diese Überschreibung auf einer Root-Seite nie aufgerufen: MAUI deaktiviert seinen Android-Zurück-Callback immer dann, wenn es glaubt, dass nichts vom Stapel zu entfernen ist, und Android schickt den Benutzer zum Startbildschirm, ohne Ihren Code zu fragen. Auf Android 16 begann das mit 10.0.70, auf allen anderen Android-Versionen mit 10.0.100. Wenn Sie nicht aktualisieren können, registrieren Sie in `MainActivity` Ihren eigenen `OnBackPressedCallback` (Code unten). `Shell.OnNavigating` mit `ShellNavigationSource.Pop` und `BackButtonBehavior.Command` fangen die Hardware- oder Gesten-Zurück-Aktion auf einer Root-Seite nicht ab, auch nicht unter 10.0.101.

Der Fix aus 10.0.101 ist nicht in .NET 11 RC 1 enthalten. Inzwischen ist er in `main` und im Branch `net11.0` angekommen (über den SR10-Servicing-Merge, [dotnet/maui#38301](https://github.com/dotnet/maui/pull/38301)), er ist also in .NET 11 RC 2 zu erwarten.

## Warum die Root-Seite die Zurück-Taste nicht mehr hört

Android 16 aktiviert Predictive Back standardmäßig für Apps, die API 36 als Ziel haben. Mit Predictive Back entscheidet das System *bevor die Geste beginnt*, ob die App das Zurück-Ereignis haben möchte. Ist kein Callback aktiviert, spielt es die Zurück-zum-Start-Vorschauanimation ab und schickt den Task in den Hintergrund. Es ruft nie das veraltete `Activity.OnBackPressed()` auf und leitet `KeyEvent.KEYCODE_BACK` nie an `OnKeyDown` weiter.

.NET MAUI registrierte seinen Zurück-Callback früher bedingungslos, was diese Animation für jede MAUI-App unterdrückte ([dotnet/maui#34594](https://github.com/dotnet/maui/issues/34594)). Der Fix, [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223), ersetzte ihn durch einen AndroidX-`OnBackPressedCallback`, dessen `Enabled`-Flag MAUI bei jeder Navigationsänderung neu berechnet. `MauiAppCompatActivity` aktiviert den Callback nur, wenn `Window.CanConsumeBackNavigation` meldet, dass die aktuelle Seite Zurück verarbeiten kann:

- eine modale Seite liegt auf dem Stapel, oder
- der Navigationsstapel der Shell-Sektion enthält mehr als eine Seite, oder
- eine `NavigationPage` enthält mehr als eine Seite, oder
- ein vom Benutzer schließbares Flyout ist geöffnet.

Eine einfache Root-`ContentPage` erfüllt keine dieser Bedingungen, also ist der Callback deaktiviert und die Eingabe geht direkt an das System. Ihre `OnBackButtonPressed()`-Überschreibung sitzt am Ende einer Kette (`MauiOnBackPressedCallback` -> `AndroidLifecycle.OnBackPressed` -> `IWindow.BackButtonClicked()` -> `Shell.OnBackButtonPressed()` -> `Page.OnBackButtonPressed()`), die nie startet.

Warum ging Android 16 zuerst kaputt? Von 10.0.70 bis 10.0.90 überschrieb `MauiAppCompatActivity` noch das veraltete `OnBackPressed()` und führte von dort aus die Zurück-Behandlung von MAUI bedingungslos aus. Geräte ohne Predictive Back (Android 15 und älter, sofern Sie nicht mit `android:enableOnBackInvokedCallback="true"` eingewilligt haben) lieferten die Eingabe weiterhin über diese Überschreibung, sodass die Sperre keine Rolle spielte. 10.0.100 entfernte die Überschreibung und verlagerte alles auf `OnBackPressedDispatcher`, sodass die Sperre auf jeder Android-Version greift. Die Issue-Triage passt genau dazu: [#37657](https://github.com/dotnet/maui/issues/37657) und [#38030](https://github.com/dotnet/maui/issues/38030) tragen das Label `regressed-in-10.0.70` für Android 16, und [#37706](https://github.com/dotnet/maui/issues/37706) meldet Fehler auf Android 15 und 17 ab 10.0.100.

## Was 10.0.101 geändert hat, gemessen

[dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709), zurückportiert als [#37729](https://github.com/dotnet/maui/pull/37729), fügt ganz oben in `CanConsumeBackNavigation` eine Prüfung ein: Ist das effektive `OnBackButtonPressed` der Seite in einer anderen Assembly als `Microsoft.Maui.Controls` deklariert, wird der Callback aktiviert. MAUI erkennt die Überschreibung über den `MethodInfo.DeclaringType` eines Delegates, ohne Ihren Code aufzurufen. Das Ergebnis wird pro Seiteninstanz zwischengespeichert.

Ich wollte die Entscheidung selbst sehen, statt der PR-Beschreibung zu vertrauen, also habe ich das interne `Window.CanConsumeBackNavigation(Page)` per Reflection aus einer dateibasierten .NET 10-App aufgerufen. Sie verwendet den einfachen `net10.0`-Build von `Microsoft.Maui.Controls`, daher ist kein Emulator nötig:

```csharp
// probe.cs -- dotnet run probe.cs (SDK 10.0.302; net11.0 + SDK 11.0.100-rc.1 for the RC 1 run)
#:package Microsoft.Maui.Controls@10.0.101
#:property PublishAot=false
#:property TargetFramework=net10.0
using System.Reflection;
using Microsoft.Maui.Controls;

var canConsume = typeof(Window).GetMethod("CanConsumeBackNavigation",
    BindingFlags.NonPublic | BindingFlags.Static)!;
bool Check(Page p) => (bool)canConsume.Invoke(null, [p])!;

Console.WriteLine($"root page with override        -> {Check(new OverridePage())}");
Console.WriteLine($"Shell override, plain root     -> {Check(MakeShell(new OverrideShell(), new PlainPage()))}");
Console.WriteLine($"Shell OnNavigating only        -> {Check(MakeShell(new NavigatingShell(), new PlainPage()))}");
// ...plus a plain Shell + plain root, and a root with a BackButtonBehavior.Command

static Shell MakeShell(Shell shell, ContentPage root)
{
    shell.Items.Add(new ShellContent { Content = root });
    return shell;
}

class PlainPage : ContentPage { }
class OverridePage : ContentPage { protected override bool OnBackButtonPressed() => true; }
class OverrideShell : Shell { protected override bool OnBackButtonPressed() => true; }
class NavigatingShell : Shell
{
    protected override void OnNavigating(ShellNavigatingEventArgs args)
    {
        base.OnNavigating(args);
        if (args.Source == ShellNavigationSource.Pop) args.Cancel();
    }
}
```

`True` bedeutet, dass MAUI seinen Callback auf dieser Root-Seite aktiviert, Ihr Code läuft also. `False` bedeutet, dass Android die App in den Hintergrund schickt, ohne zu fragen:

| Aufbau der Root-Seite | 10.0.90 | 10.0.101 | 11.0.0-rc.1.26451.6 |
|---|---|---|---|
| Einfache `ContentPage`, keine Überschreibungen | False | False | False |
| `ContentPage` überschreibt `OnBackButtonPressed` | False | **True** | False |
| `AppShell` überschreibt `OnBackButtonPressed`, einfache Root-Seite | False | **True** | False |
| Einfache `Shell`, Root-Seite überschreibt `OnBackButtonPressed` | False | **True** | False |
| `AppShell` überschreibt nur `OnNavigating` (bricht `Pop` ab) | False | False | False |
| Root-Seite mit `Shell.BackButtonBehavior` `Command` | False | False | False |

Dieser Test misst die Sperre, nicht einen Lauf auf einem Gerät. Für das Ergebnis auf dem Gerät enthält #37709 eine Verifikation auf einem Android 16-Emulator. Das MAUI-Team hat den Fix außerdem mit dem Shell-Tab-Repro aus #37657 bestätigt, und ein Melder in #37706 hat bestätigt, dass der PR-Build seine NavigationPage-App repariert hat.

## Schritt für Schritt: die Zurück-Eingabe auf einer Root-Seite abfangen

1. **Prüfen Sie Ihre MAUI-Version.** Suchen Sie das Paket `Microsoft.Maui.Controls` in Ihrer `.csproj` oder führen Sie `dotnet list package` aus. Löst es auf eine Version von 10.0.70 bis 10.0.100 auf, heben Sie es auf 10.0.101 oder neuer an. Unter .NET 11 RC 1 verwenden Sie bis RC 2 den Workaround aus Schritt 4.

   ```xml
   <!-- .NET MAUI 10, MyApp.csproj -->
   <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.101" />
   ```

2. **Überschreiben Sie `OnBackButtonPressed` auf der Seite, die es braucht.** Die Methode ist synchron, geben Sie also sofort `true` zurück und zeigen Sie einen eventuellen Bestätigungsdialog im nächsten Dispatcher-Durchlauf an. Machen Sie die Überschreibung nicht `async`: Eine `async`-Überschreibung gibt beim ersten `await` `false` zurück, bevor der Benutzer antwortet.

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- MainPage.xaml.cs (a Shell root page)
   public partial class MainPage : ContentPage
   {
       bool _confirming;

       protected override bool OnBackButtonPressed()
       {
           if (_confirming)
               return true;

           _confirming = true;
           Dispatcher.Dispatch(async () =>
           {
               try
               {
                   bool leave = await DisplayAlertAsync(
                       "Leave the app?", "Unsaved changes will be lost.", "Leave", "Stay");
                   if (leave)
                       LeaveApp();
               }
               finally
               {
                   _confirming = false;
               }
           });
           return true; // swallow this press; the dialog decides what happens next
       }

       static void LeaveApp()
       {
   #if ANDROID
           // Same as Android's own root back since Android 12: background the task, keep the process.
           Platform.CurrentActivity?.MoveTaskToBack(true);
   #endif
       }
   }
   ```

   `MoveTaskToBack(true)` ist Absicht. `Application.Current.Quit()` ruft unter Android `FinishAndRemoveTask()` und danach `Environment.Exit(0)` auf, was den Prozess beendet und den Warmstart verschenkt, den Android Ihnen sonst beim nächsten Start geben würde.

3. **Für Regeln auf Tab-Ebene überschreiben Sie stattdessen auf `AppShell`.** Eine häufige Anforderung lautet: "Zurück auf der Root-Seite eines beliebigen Tabs führt zum ersten Tab, und nur der erste Tab verlässt die App". Das gehört in die Shell, die jede Root-Seite sieht:

   ```csharp
   // .NET MAUI 10.0.101, C# 14 -- AppShell.xaml.cs
   public partial class AppShell : Shell
   {
       protected override bool OnBackButtonPressed()
       {
           var section = CurrentItem?.CurrentItem;
           bool atTabRoot = section is not null && section.Stack.Count <= 1;

           if (atTabRoot && CurrentItem is TabBar tabs && tabs.CurrentItem != tabs.Items[0])
           {
               tabs.CurrentItem = tabs.Items[0];
               return true;
           }

           return base.OnBackButtonPressed(); // pops pages, then raises Navigating(Pop)
       }
   }
   ```

   Die Rückgabe von `base.OnBackButtonPressed()` erhält das normale Verhalten der Shell. Sie ruft `OnBackButtonPressed` der sichtbaren Seite auf, entfernt eine Seite vom Sektionsstapel, falls es etwas zu entfernen gibt, und löst andernfalls `Navigating` mit `ShellNavigationSource.Pop` aus und gibt `args.Cancelled` zurück. Das bedeutet auch, dass das dokumentierte Abbruchmuster mit `OnNavigating` auf einer Root-Seite *durchaus* funktioniert, sobald irgendeine Überschreibung den Callback aktiviert hat. Für sich allein läuft es nie.

4. **Unter 10.0.70 bis 10.0.100 oder .NET 11 RC 1 fügen Sie in `MainActivity` Ihren eigenen Callback hinzu.** Der AndroidX-Dispatcher ruft zuerst den zuletzt hinzugefügten aktivierten Callback auf. Ein nach `base.OnCreate` hinzugefügter Callback läuft daher vor dem von MAUI, auch in den Fällen, in denen MAUIs eigener Callback deaktiviert ist:

   ```csharp
   // .NET MAUI 10.0.70-10.0.100 and 11.0.0-rc.1 only -- Platforms/Android/MainActivity.cs
   using Android.App;
   using Android.Content.PM;
   using Android.OS;
   using AndroidX.Activity;

   [Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
       ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                              ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
   public class MainActivity : MauiAppCompatActivity
   {
       protected override void OnCreate(Bundle? savedInstanceState)
       {
           base.OnCreate(savedInstanceState);
           OnBackPressedDispatcher.AddCallback(this, new RootBackCallback(this));
       }

       sealed class RootBackCallback(MainActivity activity) : OnBackPressedCallback(true)
       {
           public override void HandleOnBackPressed()
           {
               // Runs the same chain MAUI would: modal stack, Shell, then the visible page.
               var window = Microsoft.Maui.Controls.Application.Current?.Windows.FirstOrDefault()
                   as Microsoft.Maui.IWindow;
               if (window?.BackButtonClicked() == true)
                   return;

               // Nothing consumed it: step aside and let the system (or MAUI) handle this press.
               Enabled = false;
               try { activity.OnBackPressedDispatcher.OnBackPressed(); }
               finally { Enabled = true; }
           }
       }
   }
   ```

   Das ist ein Kompatibilitäts-Shim, kein Muster zum Beibehalten. Der Callback ist immer aktiviert, daher wird die Zurück-zum-Start-Animation nie abgespielt. Außerdem läuft Ihre Überschreibung zweimal, wenn MAUIs eigener Callback ebenfalls aktiviert ist (etwa bei einem geöffneten Flyout) und keine Seite die Eingabe behandelt. Entfernen Sie den Shim, wenn Sie auf 10.0.101 wechseln. Bleibt er unter 10.0.101 bestehen, durchläuft jede unbehandelte Eingabe auf einer überschreibenden Seite `OnBackButtonPressed` zweimal. [#37657](https://github.com/dotnet/maui/issues/37657) enthält eine kürzere Variante, die erneut in das veraltete `Activity.OnBackPressed()` einsteigt. Die obige Version vermeidet es, aus neuem Code eine veraltete API aufzurufen.

5. **Verifizieren Sie auf einem echten Android 16-Gerät oder einem API 36-Emulator.** Verwenden Sie sowohl die Gestennavigation als auch die 3-Tasten-Navigation. Wischen Sie auf einer Root-Seite, die die Methode überschreibt, vom Rand und halten Sie: Es sollte keine Zurück-zum-Start-Vorschau erscheinen, und beim Loslassen sollte Ihr Handler laufen. Auf einer Root-Seite ohne Überschreibung sollten Sie die Vorschauanimation weiterhin sehen. Daran erkennen Sie, dass Sie Predictive Back nicht für die gesamte App deaktiviert haben.

## Dinge, die funktionieren sollten, es aber nicht tun

**`BackButtonBehavior.Command` ist unter Android kein Handler für die Hardware-Zurück-Taste.** `Shell.OnBackButtonPressed` führt den Befehl nur unter `#if WINDOWS || !PLATFORM` aus. Unter Android läuft der Befehl aus `ShellToolbarTracker.OnClick`, also über den Pfeil in der Navigationsleiste. Eine Root-Seite hat keinen Zurück-Pfeil (in einer Flyout-Shell sitzt an dieser Stelle das Hamburger-Menü), für die Root-Seite ist der Befehl also irrelevant. Der Test bestätigt, dass er auch den Callback nicht aktiviert.

**Lifecycle-Ereignisse öffnen die Sperre nicht.** `builder.ConfigureLifecycleEvents(e => e.AddAndroid(a => a.OnBackPressed(...)))` registriert einen weiteren `AndroidLifecycle.OnBackPressed`-Delegate. Die Sperre prüft nur, ob *irgendein* Delegate existiert, und MAUI registriert immer sein eigenes `HandleWindowBackButtonPressed`, Ihrer fügt also nichts hinzu. Kann die Seite Zurück nicht verarbeiten, bleibt der Callback deaktiviert und Ihr Delegate läuft nie.

**Überschreibungen von `OnKeyDown(Keycode.Back, ...)` und `OnBackPressed()` in `MainActivity` sind unter Android 16 toter Code.** Googles Leitfaden zu Predictive Back stellt fest, dass das Abfangen von Zurück-Ereignissen über `KEYCODE_BACK` "is no longer supported". Die Migrations-Checkliste unter [Android API-Level 36 aus .NET MAUI als Ziel verwenden](/de/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) behandelt die anderen Überschreibungen, die bei Ziel 36 verstummen.

**Jede Überschreibung kostet Sie auf dieser Seite die Zurück-zum-Start-Animation.** MAUI entscheidet anhand des Typs, nicht anhand dessen, was Ihre Überschreibung zurückgibt. Sobald eine Seite `OnBackButtonPressed` deklariert, ist der Callback auf dieser Seite aktiviert, selbst wenn die Methode nur `base.OnBackButtonPressed()` zurückgibt. Dasselbe gilt für Überschreibungen, die von einer Basisklasse außerhalb von `Microsoft.Maui.Controls` geerbt werden: Eine gemeinsame `BasePage` mit Überschreibung schaltet jede abgeleitete Seite ein, und eine Überschreibung auf `AppShell` schaltet jede Seite ein. Androids Empfehlung lautet, Zurück-Callbacks nur für UI-Logik zu aktivieren (Bestätigen ungespeicherter Änderungen, Schließen eines Popups auf der Seite) und nie für Protokollierung oder Analytics. Legen Sie die Überschreibung auf die engste Seite, die sie braucht.

**`android:enableOnBackInvokedCallback="false"` ist kein Fix.** Es deaktiviert die Predictive-Back-Animationen und sorgt dafür, dass `OnBackInvokedCallback` nicht mehr funktioniert. Aufrufe über `OnBackPressedCallback`, das MAUI verwendet, funktionieren weiterhin. Unter 10.0.70 bis 10.0.90 leitet es Zurück auf Android 16 zufällig wieder über den Legacy-Pfad. Unter 10.0.100 gibt es keine Legacy-Überschreibung mehr, also ändert es nichts an der Sperre für Root-Seiten.

**Modale Seiten waren nie betroffen.** Ein nicht leerer modaler Stapel aktiviert den Callback immer, weshalb `protected override bool OnBackButtonPressed() => true;` auf einer modalen Seite die ganze Zeit weiter funktionierte. Siehe [ein modales Fenster in .NET MAUI 11 anzeigen](/de/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/).

**Feuern und vergessen Sie nicht aus der Überschreibung heraus.** `true` zurückzugeben und danach auf einen Dialog zu warten ist sicher, weil `Dispatcher.Dispatch` das Lambda auf dem UI-Thread ausführt. Ein `async void`-Helfer, der eine Exception wirft, würde den Prozess trotzdem abstürzen lassen. [Die `async void`-Handler finden, die ANRs in einer MAUI-Android-App verursachen](/de/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/) zeigt, wie Sie diese aufspüren.

## Weiterführende Artikel

- Zurück-Navigation mit Daten (`..?saved=true`) und die `BackButtonBehavior`-Eigenschaften, einschließlich des `AccessibilityLabel` aus .NET MAUI 11, werden in [Shell-Routenparameter und Query-Eigenschaften in .NET MAUI 11](/de/2026/07/how-to-use-shell-route-parameters-and-query-properties-in-dotnet-maui-11/) behandelt.
- Der Predictive-Back-Schritt der API 36-Migration und der Fix aus 10.0.90, der die Zurück-zum-Start-Animation wiederhergestellt hat, stehen in [eine MAUI-Android-App auf API-Level 36 als Ziel migrieren](/de/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/).
- Das Verschlucken von Zurück auf einer modalen Seite, und warum ein Modal kein modales Fenster ist, steht in [ein modales Fenster in .NET MAUI 11 anzeigen](/de/2026/08/how-to-show-a-modal-window-in-dotnet-maui-11/).
- Das Dispatcher-Muster in Schritt 2 ist die sichere Form des Fire-and-Forget-Codes, der in [`async void`-Handler finden, die ANRs verursachen](/de/2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app/) zerlegt wird.

## Quellen

- [.NET MAUI Shell navigation](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/shell/navigation) (Microsoft Learn: `BackButtonBehavior`, `Navigating`, `ShellNavigationSource.Pop`, Aufschieben der Navigation)
- [Add support for the predictive back gesture](https://developer.android.com/guide/navigation/custom-back/predictive-back-gesture) (Android Developers: wann Callbacks die Animation deaktivieren, `KEYCODE_BACK`, `enableOnBackInvokedCallback`)
- [dotnet/maui#35223](https://github.com/dotnet/maui/pull/35223): gesperrter `OnBackPressedCallback` für die Zurück-zum-Start-Animation
- [dotnet/maui#37709](https://github.com/dotnet/maui/pull/37709) und der 10.0.101-Backport [#37729](https://github.com/dotnet/maui/pull/37729): `OnBackButtonPressed` auf Root-Seiten
- Regressionsberichte: [#37657](https://github.com/dotnet/maui/issues/37657) (Shell-Tabs), [#37706](https://github.com/dotnet/maui/issues/37706) (Root-`ContentPage`), [#38030](https://github.com/dotnet/maui/issues/38030) (`FlyoutPage`)
- Quellcode an den Release-Tags: [`Window.cs` bei 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Window/Window.cs), [`MauiAppCompatActivity.cs` bei 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Core/src/Platform/Android/MauiAppCompatActivity.cs), [`Shell.cs` bei 10.0.101](https://github.com/dotnet/maui/blob/10.0.101/src/Controls/src/Core/Shell/Shell.cs) und [`Window.cs` bei 11.0.100-rc.1.26458.5](https://github.com/dotnet/maui/blob/11.0.100-rc.1.26458.5/src/Controls/src/Core/Window/Window.cs)
