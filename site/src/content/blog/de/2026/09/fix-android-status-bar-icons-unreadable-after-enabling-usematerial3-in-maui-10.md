---
title: "Fix: Android-Statusleistensymbole sind nach dem Aktivieren von UseMaterial3 in .NET MAUI 10 unlesbar"
description: "MAUI 10.0.100 wählt die Farbe der Statusleistensymbole anhand von colorPrimary, das die entgegengesetzte Helligkeit der Material-3-Surface hat. Das Ergebnis ist Weiß auf Weiß oder Schwarz auf Schwarz. Aktualisieren Sie Microsoft.Maui.Controls auf 10.0.101 oder neuer, oder setzen Sie AppearanceLightStatusBars in MainActivity zurück."
pubDate: 2026-09-29
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "maui"
  - "android"
  - "material-3"
  - "csharp"
lang: "de"
translationOf: "2026/09/fix-android-status-bar-icons-unreadable-after-enabling-usematerial3-in-maui-10"
translatedBy: "claude"
translationDate: 2026-09-29
---

Wenn Ihre .NET MAUI 10 App im hellen Modus weiße Uhr- und Akkusymbole auf einer weißen Statusleiste und im dunklen Modus schwarze Symbole auf einer schwarzen Statusleiste zeigt, direkt nachdem Sie `<UseMaterial3>true</UseMaterial3>` gesetzt haben, verwenden Sie `Microsoft.Maui.Controls` 10.0.100. Dieses Release wählt die Farbe der Statusleistensymbole seit Kurzem anhand der Luminanz von `colorPrimary` des Themes. Material 3 zeichnet aber `colorSurface` hinter die transparente Edge-to-Edge-Statusleiste, und die Primär- und Surface-Farben von Material 3 haben immer entgegengesetzte Helligkeit. Die Symbole erscheinen daher invertiert. Die Lösung ist ein Update auf 10.0.101 oder neuer (10.0.110 ist aktuell, veröffentlicht am 2026-09-22). Wenn Sie noch nicht aktualisieren können, setzen Sie `AppearanceLightStatusBars` in `MainActivity` nach `base.OnCreate` selbst. In .NET 11 RC 1 ist das Hauptfenster in Ordnung, modale Seiten zeigen den Fehler aber weiterhin; RC 2 enthält die Korrektur.

## Der Fehler im Kontext

Es gibt keine Exception und keinen Eintrag im Log. Das Symptom ist rein visuell und sieht unter Android 15, 16 und 17 mit Edge-to-Edge (das .NET MAUI 10 ab API 30 aktiviert) so aus:

```text
// .NET 10, Microsoft.Maui.Controls 10.0.100, <UseMaterial3>true</UseMaterial3>
Light mode: status bar background near-white (Material 3 surface), icons and clock white
Dark mode:  status bar background near-black (Material 3 surface), icons and clock black
```

Der Bericht ist [dotnet/maui#37705](https://github.com/dotnet/maui/issues/37705), gekennzeichnet mit `i/regression` und `regressed-in-10.0.100`. Ein Downgrade auf 10.0.90 macht die Symbole wieder lesbar. Das ist der erste Hinweis darauf, dass es sich um eine MAUI-Änderung handelt und nicht um etwas in Ihrem Theme.

Was jede Version tut, geht aus `WindowExtensions.cs` und dem Window-Handler im jeweiligen Release-Tag hervor:

| Microsoft.Maui.Controls | Wie die Farbe der Statusleistensymbole gewählt wird | Ergebnis mit Material 3 |
| --- | --- | --- |
| 10.0.90 und früher | Tag/Nacht: Im hellen Theme gibt es dunkle Symbole | Lesbar |
| 10.0.100 (2026-08-20) | Luminanz von `android:colorPrimary` | Invertiert, unlesbar |
| 10.0.101 (2026-09-07), 10.0.110 | Luminanz von `colorSurface` bei Material 3, `colorPrimary` bei Material 2 | Lesbar |
| 11.0 RC 1 | `colorPrimary`, danach überschrieben durch `Window.StatusBarTheme` (Standard: Tag/Nacht), nur für das Hauptfenster | Hauptfenster lesbar, modale Seiten invertiert |
| 11.0 RC 2 Branch | Wie 10.0.101 | Lesbar |

## Warum die Symbole kippen: colorPrimary gegen colorSurface

Android erlaubt einer App nicht, eine exakte Farbe für die Statusleistensymbole zu wählen. Es bietet einen booleschen Wert: `WindowInsetsControllerCompat.AppearanceLightStatusBars`. Ist er `true`, geht das System von einem hellen Hintergrund der Statusleiste aus und zeichnet dunkle Symbole. Ist er `false`, zeichnet es helle Symbole.

Bis 10.0.90 setzte MAUI dieses Flag allein anhand des Tag/Nacht-Modus:

```csharp
// .NET MAUI 10.0.90, src/Core/src/Platform/Android/WindowExtensions.cs
var configuration = activity.Resources?.Configuration;
var isLightTheme = configuration is null ||
    (configuration.UiMode & UiMode.NightMask) != UiMode.NightYes;

windowInsetsController.AppearanceLightStatusBars = isLightTheme;
windowInsetsController.AppearanceLightNavigationBars = isLightTheme;
```

Das funktioniert, solange das, was hinter der Statusleiste liegt, dem Tag/Nacht-Modus folgt, und schlägt fehl, wenn nicht. [dotnet/maui#32987](https://github.com/dotnet/maui/issues/32987) war der zweite Fall: Eine Material-2-App mit hellem Theme und einer App-Leiste mit schwarzem `colorPrimary` unter der Statusleiste bekam dunkle Symbole auf dunklem Hintergrund. Die Korrektur dafür, [dotnet/maui#36214](https://github.com/dotnet/maui/pull/36214), wurde am 2026-07-01 gemergt und mit 10.0.100 ausgeliefert. Sie ermittelt `android:colorPrimary` aus dem aktuellen Theme und verwendet stattdessen dessen Luminanz:

```csharp
// .NET MAUI 10.0.100, src/Core/src/Platform/Android/WindowExtensions.cs
if (TryGetThemeColor(activity, global::Android.Resource.Attribute.ColorPrimary, out var statusBarColor))
    windowInsetsController.AppearanceLightStatusBars = IsLightColor(statusBarColor);
else
    windowInsetsController.AppearanceLightStatusBars = isLightTheme;

// ...
static bool IsLightColor(AColor color) =>
    ColorUtils.CalculateLuminance(color.ToArgb()) > 0.5;
```

Für eine Material-2-App-Leiste in `colorPrimary` ist das korrekt. Für Material 3 ist es genau umgekehrt. Mit aktiviertem `UseMaterial3` wechselt MAUI das Activity-Theme zu `Maui.Material3.Theme.NoActionBar`, dessen Elternteil `Theme.Material3.DayNight` ist. Die eigenen Material-3-Stile von MAUI überschreiben die Primärfarbe nicht, Sie erhalten also die Basispalette von Material 3. Material 3 legt die Surface-Farbe hinter die Statusleiste, nicht die Primärfarbe, und die Palette ist so gestaltet, dass die Primärfarbe zur Surface kontrastiert:

| Theme | `colorPrimary` | Relative Luminanz | 10.0.100 entscheidet | Tatsächlicher Hintergrund |
| --- | --- | --- | --- | --- |
| Hell | `#6750A4` | 0,11 (dunkel) | Helle Symbole | Fast weiße Surface |
| Dunkel | `#D0BCFF` | 0,57 (hell) | Dunkle Symbole | Fast schwarze Surface |

Das Violett `#512BD4` der Vorlage in `Platforms/Android/Resources/values/colors.xml` rettet Sie nicht: Diese Farbressource speist das Material-2-Theme `Maui.MainTheme`, nicht das Material-3-Theme, und sie ist ohnehin dunkel (Luminanz 0,08). Jede Material-3-Palette mit hellem Theme und gesättigter Primärfarbe landet am selben Punkt.

Die Korrektur in 10.0.101, [dotnet/maui#37710](https://github.com/dotnet/maui/pull/37710), als Backport auf den SR10-Branch als [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730), behält die Luminanz-Idee bei, liest aber das Attribut, das tatsächlich hinter der Leiste liegt:

```csharp
// .NET MAUI 10.0.101 and 10.0.110, src/Core/src/Platform/Android/WindowExtensions.cs
internal static bool GetStatusBarAppearance(Context context, bool isLightTheme, bool isMaterial3)
{
    // Material 3 draws its surface behind the transparent edge-to-edge status bar.
    // The Material 2 app bar uses colorPrimary in the same area.
    var backgroundAttribute = isMaterial3
        ? Resource.Attribute.colorSurface
        : global::Android.Resource.Attribute.ColorPrimary;

    return TryGetThemeColor(context, backgroundAttribute, out var backgroundColor)
        ? IsLightColor(backgroundColor)
        : isLightTheme;
}
```

## Minimales Repro

Beginnen Sie mit der Standardvorlage und legen Sie das betroffene Paket fest:

```xml
<!-- .NET 10 SDK, dotnet new maui, MyApp.csproj -->
<PropertyGroup>
  <TargetFrameworks>net10.0-android;net10.0-ios;net10.0-maccatalyst</TargetFrameworks>
  <UseMaterial3>true</UseMaterial3>
</PropertyGroup>

<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.100" />
</ItemGroup>
```

Führen Sie die App auf einem Emulator mit Android 11 (API 30) oder neuer aus. Die Statusleistensymbole sind auf der Startseite im hellen Modus weiß. Schalten Sie den Emulator in den dunklen Modus, starten Sie die App neu, und sie sind schwarz. Ändern Sie `10.0.100` in `10.0.90`, und beide Modi sind lesbar. Ändern Sie es in `10.0.110`, und beide Modi sind wieder lesbar.

Wenn Sie prüfen möchten, was MAUI entschieden hat, statt auf den Emulator zu starren, protokollieren Sie das Flag nach dem Start:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
protected override void OnResume()
{
    base.OnResume();
    var controller = AndroidX.Core.View.WindowCompat.GetInsetsController(Window!, Window!.DecorView);
    Android.Util.Log.Info("StatusBar", $"AppearanceLightStatusBars={controller.AppearanceLightStatusBars}");
}
```

Im hellen Modus sehen Sie unter 10.0.100 `False`, also "der Hintergrund ist dunkel, zeichne helle Symbole", und das auf einer fast weißen Surface.

## Fix 1: Microsoft.Maui.Controls auf 10.0.101 oder neuer aktualisieren

Das ist die eigentliche Lösung, und es ist ein Patch-Release auf derselben .NET-10-Linie, es ändert sich also nichts am Target Framework. Legen Sie die Version explizit fest, statt sich auf `$(MauiVersion)` des Workloads zu verlassen, der gerade auf dem Build-Rechner installiert ist:

```xml
<!-- .NET 10, MyApp.csproj -->
<ItemGroup>
  <PackageReference Include="Microsoft.Maui.Controls" Version="10.0.110" />
</ItemGroup>
```

Der geänderte Code liegt in `Microsoft.Maui.Core`, das `Microsoft.Maui.Controls` in derselben Version mitbringt. Wenn Ihr Projekt zusätzlich `Microsoft.Maui.Core` oder `Microsoft.Maui.Controls.Compatibility` direkt referenziert, erhöhen Sie diese auf dieselbe Version, sonst löst NuGet unter Umständen einen gemischten Satz auf. `dotnet list package --include-transitive` zeigt, was Sie tatsächlich erhalten haben.

Führen Sie danach ein Clean und einen Rebuild durch. Änderungen an Android-Ressourcen und Themes gehen bei einem inkrementellen Deployment leicht unter. Deinstallieren Sie die App daher einmal vom Gerät (`adb uninstall com.companyname.myapp`), bevor Sie das Ergebnis beurteilen.

10.0.110 enthält außerdem die Korrektur für die [UIKitThreadAccessException von MediaPicker.PickPhotosAsync](/de/2026/09/fix-uikitthreadaccessexception-from-mediapicker-pickphotosasync-in-maui-ios/), eine weitere Regression aus 10.0.100. Es gibt also kaum einen Grund, bei 10.0.100 zu bleiben. Eine Einschränkung in die andere Richtung: 10.0.101 und 10.0.110 haben ein Resizetizer-Problem mit [SVG-App-Symbolen, die Filter- oder Textelemente verwenden](/de/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/). Prüfen Sie Ihr Symbol, bevor Sie einen Release-Branch aktualisieren.

## Fix 2: AppearanceLightStatusBars in MainActivity zurücksetzen

Wenn Sie vorerst auf 10.0.100 festgelegt sind, überschreiben Sie das Flag selbst. `MauiAppCompatActivity.OnCreate` ruft `CreatePlatformWindow` auf, das den `WindowHandler` verbindet, der wiederum `ConfigureTranslucentSystemBars` ausführt und den falschen Wert schreibt. All das geschieht innerhalb von `base.OnCreate`, sodass alles, was Sie nach diesem Aufruf setzen, für das Hauptfenster gewinnt:

```csharp
// .NET 10, Microsoft.Maui.Controls 10.0.100, Platforms/Android/MainActivity.cs
using Android.App;
using Android.Content.PM;
using Android.Content.Res;
using Android.OS;
using AndroidX.Core.View;

namespace MyApp;

[Activity(Theme = "@style/Maui.SplashTheme", MainLauncher = true, LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges = ConfigChanges.ScreenSize | ConfigChanges.Orientation | ConfigChanges.UiMode |
                           ConfigChanges.ScreenLayout | ConfigChanges.SmallestScreenSize | ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity
{
    protected override void OnCreate(Bundle? savedInstanceState)
    {
        // MAUI sets the status bar appearance inside base.OnCreate. Correct it afterwards.
        base.OnCreate(savedInstanceState);
        ApplyStatusBarIconContrast(Resources?.Configuration);
    }

    public override void OnConfigurationChanged(Configuration newConfig)
    {
        base.OnConfigurationChanged(newConfig);
        ApplyStatusBarIconContrast(newConfig);
    }

    void ApplyStatusBarIconContrast(Configuration? configuration)
    {
        // MAUI only configures edge-to-edge system bars on API 30+, so mirror that.
        if (!OperatingSystem.IsAndroidVersionAtLeast(30) || Window is null)
            return;

        var isNight = configuration is not null &&
            (configuration.UiMode & UiMode.NightMask) == UiMode.NightYes;

        // true means "light background": Android draws dark icons.
        WindowCompat.GetInsetsController(Window, Window.DecorView)
            .AppearanceLightStatusBars = !isNight;
    }
}
```

Das stellt das Verhalten von 10.0.90 wieder her. Die Überschreibung von `OnConfigurationChanged` ist wichtig, weil `ConfigurationChanges` der Vorlage `ConfigChanges.UiMode` enthält: Wenn der Benutzer das Systemtheme umschaltet, erstellt Android die Activity nicht neu, und MAUI 10 setzt das Flag nur, wenn der Window-Handler sich verbindet. Ohne die Überschreibung behalten die Symbole bis zum nächsten Kaltstart die Farbe des vorherigen Modus.

Entfernen Sie diese Überschreibung, sobald Sie auf 10.0.101 oder neuer wechseln. Die eingebaute Korrektur leitet das Flag aus Ihrer tatsächlichen `colorSurface` ab, was genauer ist als Tag/Nacht, wenn Sie die Surface-Farbe anpassen.

## Fix 3: In .NET 11 Window.StatusBarTheme verwenden

.NET 11 hat `Window.StatusBarTheme` ([dotnet/maui#34903](https://github.com/dotnet/maui/pull/34903)) hinzugefügt, eine Enum mit `Default`, `Light` und `Dark`. In RC 1 ruft `WindowHandler.ConnectHandler` zuerst `ConfigureTranslucentSystemBars` auf (das noch die `colorPrimary`-Logik enthält) und wendet dann sofort `StatusBarTheme` an. `Default` fällt auf Tag/Nacht zurück, das Hauptfenster einer .NET 11 RC 1 App ist also lesbar, ohne dass Sie etwas tun müssen.

Bei modalen Seiten ist es anders. `ModalNavigationManager` zeigt jedes Modal in einem eigenen Dialogfenster und ruft dafür `ConfigureTranslucentSystemBars` auf, wendet danach aber `StatusBarTheme` nicht an. Bei einer Seite, die Sie in RC 1 mit `Navigation.PushModalAsync` öffnen, kehren daher die invertierten Symbole zurück. Die Korrektur liegt im Branch `release/11.0.1xx-rc2`, RC 2 löst also beides.

`StatusBarTheme` ist außerdem das richtige Werkzeug, wenn Ihre Seite etwas anderes als die Surface hinter die Statusleiste legt, etwa ein dunkles Hero-Bild in einem hellen Theme:

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, App.xaml.cs
protected override Window CreateWindow(IActivationState? activationState)
{
    var window = new Window(new AppShell());

    // Light = light status bar background, so Android draws dark icons.
    window.SetAppTheme(Window.StatusBarThemeProperty, StatusBarTheme.Light, StatusBarTheme.Dark);

    return window;
}
```

Oder pro Seite: Wenn ein einzelner Bildschirm helle Symbole über einem dunklen Header braucht, setzen Sie es am Fenster der Seite und stellen es zurück, wenn die Seite verschwindet:

```csharp
// .NET 11 RC 1, Microsoft.Maui.Controls 11.0.0-rc.1.26451.6, HeroPage.xaml.cs
protected override void OnAppearing()
{
    base.OnAppearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Dark;
}

protected override void OnDisappearing()
{
    base.OnDisappearing();
    if (Window is not null)
        Window.StatusBarTheme = StatusBarTheme.Default;
}
```

Beachten Sie die Benennung: `StatusBarTheme` beschreibt die Leiste, nicht die Symbole. `Dark` bedeutet "die Leiste ist dunkel", was helle Symbole ergibt, dieselbe Konvention wie bei `AppearanceLightStatusBars`.

## Stolpersteine und Verwechslungen

**Material-2-Apps können das Spiegelbild treffen.** 10.0.101 und 10.0.110 leiten die Material-2-Statusleiste bewusst weiterhin aus `colorPrimary` ab, weil die Material-2-App-Leiste in dieser Farbe gezeichnet wird. Wenn Ihre Material-2-App die Navigationsleiste ausblendet (`Shell.NavBarIsVisible="False"`) und eine weiße Seite unter einer Statusleiste zeigt, während `colorPrimary` dunkel ist, wählt der Code helle Symbole über Weiß. Das folgt aus demselben Quellcode und wird nicht als Fehler geführt, da das Standardlayout von Material 2 die App-Leiste unter der Statusleiste hält. Die Überschreibung in `MainActivity` aus Fix 2 behebt es.

**Die Symbole der Navigationsleiste sind nicht betroffen.** Alle oben genannten Versionen setzen `AppearanceLightNavigationBars` weiterhin anhand von Tag/Nacht. Wenn Ihre Gestenleiste oder die 3-Tasten-Leiste unlesbar ist, ist das ein anderes Problem, meist Inhalt, der nach den [Edge-to-Edge-Änderungen von API 36](/de/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) unter der Leiste gezeichnet wird.

**Android 10 und älter sehen gut aus.** MAUI führt diesen Code nur ab API 30 aus. Darunter ruft der Window-Handler `ConfigureTranslucentSystemBars` nie auf, ein Test auf einem alten Emulator reproduziert den Fehler daher nicht.

**Das Setzen der Statusleistenfarbe bewirkt unter Android 15+ nichts.** Eine häufige erste Reaktion ist `Window.SetStatusBarColor(...)` aus `MainActivity`. Bei Apps, die API 35 oder höher anvisieren und unter Android 15 und neuer laufen, ist Edge-to-Edge erzwungen, und dieser Aufruf wird ignoriert. Die Leiste bleibt transparent, weshalb das Flag für das Symbolaussehen der einzige relevante Hebel ist.

**Es liegt nicht an Ihrer Dark-Mode-Konfiguration.** Wenn die Symbole nur nach einer Änderung von `Application.Current.UserAppTheme` zur Laufzeit falsch sind und nach einem Kaltstart stimmen, ist das das in Fix 2 beschriebene fehlende erneute Anwenden und nicht diese Regression. [Dark Mode in einer MAUI-App richtig unterstützen](/de/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) behandelt die übrigen nativen Oberflächen, die `AppThemeBinding` nicht folgen.

## Verwandte Artikel

- [.NET MAUI 10 SR6 schließt Material 3 auf Android hinter einem einzigen UseMaterial3-Flag ab](/de/2026/05/maui-10-material-3-android-usematerial3-flag/) erklärt, was das Flag ändert und welche Steuerelemente es gestaltet.
- [Eine .NET MAUI Android-App auf Android API Level 36 migrieren](/de/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/) für die Edge-to-Edge- und Safe-Area-Änderungen, die die Statusleiste überhaupt erst transparent machen.
- [Dark Mode in einer MAUI-App richtig unterstützen](/de/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) für themenabhängige Farben und die Reaktion auf `RequestedThemeChanged`.
- [Fix: .NET MAUI Resizetizer MissingMethodException (MAUIR0001) bei einem SVG-App-Symbol](/de/2026/09/fix-maui-resizetizer-mauir0001-missingmethodexception-svg-filter-text/), bevor Sie auf 10.0.101 oder 10.0.110 aktualisieren.

## Quellen

- [dotnet/maui#37705: Status bar icons become unreadable when UseMaterial3 is enabled in 10.0.100](https://github.com/dotnet/maui/issues/37705)
- [dotnet/maui#36214: Fix status bar icon contrast with custom colorPrimary](https://github.com/dotnet/maui/pull/36214) (die Änderung, die die Regression eingeführt hat)
- [dotnet/maui#37710: Fix Material 3 status bar icon contrast](https://github.com/dotnet/maui/pull/37710) und der Backport für 10.0.101 [dotnet/maui#37730](https://github.com/dotnet/maui/pull/37730)
- [dotnet/maui#34903: Add Window.StatusBarTheme](https://github.com/dotnet/maui/pull/34903)
- [`WindowExtensions.cs` im Tag 10.0.100](https://github.com/dotnet/maui/blob/10.0.100/src/Core/src/Platform/Android/WindowExtensions.cs) und [im Tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/WindowExtensions.cs)
- [`styles-material3.xml` im Tag 10.0.110](https://github.com/dotnet/maui/blob/10.0.110/src/Core/src/Platform/Android/Resources/values/styles-material3.xml)
- [WindowInsetsControllerCompat.setAppearanceLightStatusBars (Android Developers)](https://developer.android.com/reference/androidx/core/view/WindowInsetsControllerCompat#setAppearanceLightStatusBars(boolean))
- [Microsoft.Maui.Controls auf NuGet](https://www.nuget.org/packages/Microsoft.Maui.Controls) für Veröffentlichungsdaten
