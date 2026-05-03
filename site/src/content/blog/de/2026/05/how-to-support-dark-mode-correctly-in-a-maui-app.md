---
title: "So unterstützen Sie den Dark Mode in einer .NET MAUI-App korrekt"
description: "Dark Mode End-to-End in .NET MAUI 11: AppThemeBinding, SetAppThemeColor, RequestedTheme, UserAppTheme-Override mit Persistenz, das RequestedThemeChanged-Ereignis und die plattformspezifischen Info.plist- und MainActivity-Details, die die Dokumentation übergeht."
pubDate: 2026-05-03
tags:
  - "maui"
  - "dotnet-maui"
  - "dotnet-11"
  - "csharp"
  - "dark-mode"
  - "theming"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-support-dark-mode-correctly-in-a-maui-app"
translatedBy: "claude"
translationDate: 2026-05-03
---

Kurze Antwort: Binden Sie in .NET MAUI 11.0.0 jeden themensensitiven Wert mit der Markup-Erweiterung `AppThemeBinding`, organisieren Sie helle und dunkle Farben als `StaticResource`-Schlüssel in `App.xaml`, setzen Sie `Application.Current.UserAppTheme = AppTheme.Unspecified` beim Start, damit die App dem Betriebssystem folgt, und persistieren Sie jeden Benutzer-Override über `Preferences`. Unter Android benötigen Sie zusätzlich `ConfigChanges.UiMode` an `MainActivity`, damit die Activity bei einem System-Themenwechsel nicht zerstört wird; unter iOS benötigen Sie entweder keinen `UIUserInterfaceStyle`-Schlüssel in `Info.plist` oder den Wert `Automatic`, damit das System Ihnen sowohl hell als auch dunkel liefern kann. Greifen Sie nur dann auf `Application.Current.RequestedThemeChanged` zurück, wenn Sie etwas imperativ mutieren müssen, denn die Markup-Erweiterung wertet die Bindings bereits neu aus.

Dieser Beitrag behandelt die gesamte Oberfläche der System-Theme-Unterstützung in .NET MAUI 11.0.0 auf .NET 11, einschließlich der Stellen, die in der Produktion zubeißen: Persistenz über App-Neustarts hinweg, Plattformkonfiguration von `Info.plist` und `MainActivity`, dynamisches Resource-Refresh bei `Application.Current.UserAppTheme`-Wechseln, Statusleisten- und Splash-Screen-Farben sowie das `RequestedThemeChanged`-Ereignis, das bekanntlich aufhört zu feuern, wenn Sie das Manifest-Flag vergessen. Jedes Snippet wurde gegen `dotnet new maui` aus dem .NET 11 SDK mit `Microsoft.Maui.Controls` 11.0.0 verifiziert.

## Was die Betriebssysteme Ihnen tatsächlich geben

Dark Mode ist keine einzelne Funktion, sondern die Vereinigung von drei verschiedenen Verhaltensweisen, die auf Betriebssystemebene ausgeliefert werden und für die Sie sich einzeln anmelden müssen:

1. Das Betriebssystem meldet ein aktuelles Theme. iOS 13+ stellt `UITraitCollection.UserInterfaceStyle` bereit, Android 10 (API 29)+ stellt `Configuration.UI_MODE_NIGHT_MASK` bereit, macOS 10.14+ stellt `NSAppearance` bereit, Windows 10+ stellt `UISettings.GetColorValue(UIColorType.Background)` plus den `app-mode`-Registry-Schlüssel bereit. MAUI normalisiert alle vier in der Enum `Microsoft.Maui.ApplicationModel.AppTheme`: `Unspecified`, `Light`, `Dark`.

2. Das OS benachrichtigt die App, wenn der Benutzer einen Schalter umlegt. Unter iOS kommt das über `traitCollectionDidChange:` an, unter Android über `Activity.OnConfigurationChanged` (nur wenn Sie sich anmelden, dazu unten mehr), unter Windows über `UISettings.ColorValuesChanged`. MAUI stellt die Vereinigung als das statische Ereignis `Application.RequestedThemeChanged` bereit.

3. Das OS erlaubt der App, das gerenderte Theme zu überschreiben. iOS verwendet `UIWindow.OverrideUserInterfaceStyle`, Android verwendet `AppCompatDelegate.SetDefaultNightMode`, Windows verwendet `FrameworkElement.RequestedTheme`. MAUI stellt den Override als die Lese-/Schreibeigenschaft `Application.Current.UserAppTheme` bereit.

Wenn Sie eine dieser Schichten weglassen, erhalten Sie die Version "sieht im Simulator gut aus und ist auf dem Telefon des Benutzers kaputt" des Dark Mode. Der Rest dieses Artikels zeigt, wie Sie alle drei Schichten korrekt verdrahten, damit eine MAUI-App so reagiert, wie es die Plattformkonventionen erwarten.

## Helle und dunkle Ressourcen einmal in App.xaml definieren

Das sauberste Muster ist, jeden themensensitiven Wert als `StaticResource` in `App.xaml` zu halten und dann über `AppThemeBinding` zu binden. Die Ressourcen im Anwendungsbereich zu platzieren bedeutet, dass jede Seite dieselbe Palette sieht und Sie einen einzigen Schlüssel umbenennen können, wenn sich das Designsystem ändert.

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<?xml version = "1.0" encoding = "UTF-8" ?>
<Application xmlns="http://schemas.microsoft.com/dotnet/2021/maui"
             xmlns:x="http://schemas.microsoft.com/winfx/2009/xaml"
             x:Class="HelloDarkMode.App">
    <Application.Resources>
        <ResourceDictionary>

            <!-- Light palette -->
            <Color x:Key="LightBackground">#FFFFFF</Color>
            <Color x:Key="LightSurface">#F5F5F7</Color>
            <Color x:Key="LightText">#0A0A0B</Color>
            <Color x:Key="LightAccent">#0066FF</Color>

            <!-- Dark palette -->
            <Color x:Key="DarkBackground">#0F1115</Color>
            <Color x:Key="DarkSurface">#1A1D23</Color>
            <Color x:Key="DarkText">#F2F2F2</Color>
            <Color x:Key="DarkAccent">#5B9BFF</Color>

            <Style TargetType="ContentPage" ApplyToDerivedTypes="True">
                <Setter Property="BackgroundColor"
                        Value="{AppThemeBinding Light={StaticResource LightBackground},
                                                Dark={StaticResource DarkBackground}}" />
            </Style>

            <Style TargetType="Label">
                <Setter Property="TextColor"
                        Value="{AppThemeBinding Light={StaticResource LightText},
                                                Dark={StaticResource DarkText}}" />
            </Style>

        </ResourceDictionary>
    </Application.Resources>
</Application>
```

`AppThemeBinding` ist die Markup-Erweiterungsform der Klasse `AppThemeBindingExtension` in `Microsoft.Maui.Controls.Xaml`. Sie stellt drei Werte bereit: `Default`, `Light`, `Dark`. Der XAML-Parser behandelt `Default=` als Inhaltseigenschaft, sodass `{AppThemeBinding Red, Light=Green, Dark=Blue}` eine zulässige Kurzform für "verwende rot, es sei denn, das System ist hell oder dunkel" ist. Wenn sich das Systemtheme ändert, durchläuft MAUI jede Bindung, die auf eine `AppThemeBindingExtension` zielt, wertet sie neu aus und schiebt den neuen Wert durch die Bindable-Property-Pipeline. Sie schreiben keinen Code zum Aktualisieren.

Für einmalige Werte, die keinen Ressourcenschlüssel verdienen, fügen Sie die Farben inline ein:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Border Stroke="{AppThemeBinding Light=#DDD, Dark=#333}"
        BackgroundColor="{AppThemeBinding Light={StaticResource LightSurface},
                                          Dark={StaticResource DarkSurface}}">
    <Label Text="Hello, theme" />
</Border>
```

Für Bilder akzeptiert dieselbe Erweiterung Dateireferenzen:

```xaml
<!-- .NET MAUI 11.0.0, .NET 11 -->
<Image Source="{AppThemeBinding Light=logo_light.png, Dark=logo_dark.png}"
       HeightRequest="48" />
```

## Themes aus dem Code-Behind anwenden

Wenn Sie Views in C# erstellen oder sie nach der Konstruktion modifizieren, tauschen Sie die Markup-Erweiterung gegen die `SetAppThemeColor`- und `SetAppTheme<T>`-Erweiterungen auf `VisualElement`. Sie befinden sich in `Microsoft.Maui.Controls` und verhalten sich genau wie die Markup-Erweiterung: Sie speichern die beiden Werte, werten das aktuelle Theme aus und werten bei jedem Themenwechsel neu aus.

```csharp
// .NET MAUI 11.0.0, .NET 11
using Microsoft.Maui.Controls;
using Microsoft.Maui.Graphics;

var label = new Label { Text = "Hello, theme" };
label.SetAppThemeColor(
    Label.TextColorProperty,
    light: Colors.Black,
    dark: Colors.White);

var image = new Image { HeightRequest = 48 };
image.SetAppTheme<FileImageSource>(
    Image.SourceProperty,
    light: "logo_light.png",
    dark: "logo_dark.png");
```

`SetAppTheme<T>` ist der richtige Aufruf für jeden Wert, der kein `Color` ist. Es funktioniert mit `FileImageSource`, `Brush`, `Thickness` und jedem anderen Typ, den die Zieleigenschaft akzeptiert. Es gibt kein separates `SetAppThemeBrush` oder `SetAppThemeThickness`, weil die generische Version sie alle abdeckt.

## Aktuelles Theme erkennen und überschreiben

`Application.Current.RequestedTheme` gibt jederzeit den aufgelösten `AppTheme`-Wert zurück und berücksichtigt sowohl das OS als auch jeden `UserAppTheme`-Override. Greifen Sie sparsam darauf zurück: Ein einzelnes Bool, das auf einer Viewmodel gespeichert wird und sagt "sind wir gerade dunkel", ist fast immer ein Zeichen dafür, dass Sie stattdessen `AppThemeBinding` verwenden sollten.

```csharp
// .NET MAUI 11.0.0, .NET 11
AppTheme current = Application.Current!.RequestedTheme;
bool isDark = current == AppTheme.Dark;
```

Das Überschreiben des Themes ist das App-interne Gegenstück. `Application.Current.UserAppTheme` ist Lese-/Schreibzugriff und akzeptiert dieselbe Enum:

```csharp
// .NET MAUI 11.0.0, .NET 11
Application.Current!.UserAppTheme = AppTheme.Dark;     // force dark
Application.Current!.UserAppTheme = AppTheme.Light;    // force light
Application.Current!.UserAppTheme = AppTheme.Unspecified; // follow system
```

Der Setter löst `RequestedThemeChanged` aus, was bedeutet, dass jede aktive `AppThemeBinding` sofort neu ausgewertet wird. Sie müssen keine Seiten neu erstellen, ResourceDictionaries austauschen oder einen Navigations-Flush auslösen.

Der Override überlebt keinen App-Neustart. Wenn Sie möchten, dass die Wahl des Benutzers über Starts hinweg bestehen bleibt, persistieren Sie sie über `Microsoft.Maui.Storage.Preferences`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public static class ThemeService
{
    private const string Key = "user_app_theme";

    public static void Apply()
    {
        var stored = (AppTheme)Preferences.Default.Get(Key, (int)AppTheme.Unspecified);
        Application.Current!.UserAppTheme = stored;
    }

    public static void Set(AppTheme theme)
    {
        Preferences.Default.Set(Key, (int)theme);
        Application.Current!.UserAppTheme = theme;
    }
}
```

Rufen Sie `ThemeService.Apply()` aus `App.OnStart` (oder dem `App`-Konstruktor direkt nach `InitializeComponent`) auf, damit der Override aktiv ist, bevor das erste Fenster gerendert wird. Speichern Sie die Enum als `int`, weil `Preferences` keine typisierte Überladung für beliebige Enums auf jeder Plattform hat und das Casten über `int` portabel ist.

## Viewmodels benachrichtigen, wenn das Theme wechselt

Wenn Sie auf eine Themenänderung im Code reagieren müssen, beispielsweise um eine selbstgezeichnete `GraphicsView` auszutauschen oder eine andere `StatusBar`-Farbe zu setzen, abonnieren Sie `Application.Current.RequestedThemeChanged`:

```csharp
// .NET MAUI 11.0.0, .NET 11
public App()
{
    InitializeComponent();
    Application.Current!.RequestedThemeChanged += OnThemeChanged;
}

private void OnThemeChanged(object? sender, AppThemeChangedEventArgs e)
{
    AppTheme theme = e.RequestedTheme;
    UpdateStatusBar(theme);
    UpdateMapStyle(theme);
}
```

Der Event-Handler läuft auf dem Haupt-Thread. `AppThemeChangedEventArgs.RequestedTheme` ist das neue aufgelöste Theme, sodass Sie `Application.Current.RequestedTheme` innerhalb des Handlers nicht erneut lesen müssen.

Wenn das Ereignis unter Android nie ausgelöst wird, fehlt Ihrer `MainActivity` das `UiMode`-Flag. Das Standard-Visual-Studio-Template enthält es, aber ich habe handgefertigte Projekte gesehen, die es bei einer Migration von Xamarin.Forms verloren haben. Fügen Sie es hinzu:

```csharp
// .NET MAUI 11.0.0, .NET 11, Platforms/Android/MainActivity.cs
[Activity(
    Theme = "@style/Maui.SplashTheme",
    MainLauncher = true,
    LaunchMode = LaunchMode.SingleTop,
    ConfigurationChanges =
        ConfigChanges.ScreenSize |
        ConfigChanges.Orientation |
        ConfigChanges.UiMode |       // load-bearing for dark mode
        ConfigChanges.ScreenLayout |
        ConfigChanges.SmallestScreenSize |
        ConfigChanges.Density)]
public class MainActivity : MauiAppCompatActivity { }
```

Ohne `ConfigChanges.UiMode` zerstört Android die Activity bei jedem System-Themenwechsel und erstellt sie neu, was bedeutet, dass MAUI eine frische Activity statt einer Konfigurationsaktualisierung sieht und das `RequestedThemeChanged`-Ereignis nicht aus derselben `Application`-Instanz ausgelöst wird. Das sichtbare Symptom ist, dass der erste Wechsel funktioniert, nachfolgende Wechsel jedoch nichts bewirken, bis die App beendet wird.

## Plattformkonfiguration, von der Ihnen niemand erzählt

Die MAUI-Oberfläche ist größtenteils plattformübergreifend, aber der Dark Mode hat kleine plattformspezifische Stellschrauben, die leicht zu übersehen sind.

**iOS / Mac Catalyst.** Wenn `Info.plist` `UIUserInterfaceStyle` auf `Light` oder `Dark` gesetzt enthält, sperrt das OS die App fest auf diesen Modus und `Application.RequestedTheme` gibt für immer den gesperrten Wert zurück. Das Standard-MAUI-Template lässt den Schlüssel weg, was bedeutet, dass die App dem System folgt. Wenn Sie sich explizit abmelden müssen, verwenden Sie `Automatic`:

```xml
<!-- Platforms/iOS/Info.plist or Platforms/MacCatalyst/Info.plist -->
<key>UIUserInterfaceStyle</key>
<string>Automatic</string>
```

`Automatic` ist auch der richtige Wert, wenn ein früherer Entwickler den Schlüssel auf `Light` gesetzt hat, um etwas zu "reparieren", und es dann vergessen hat. Den Schlüssel komplett zu entfernen hat denselben Effekt.

**Android.** Über das `ConfigChanges.UiMode`-Flag hinaus müssen Sie nur prüfen, ob das App-Theme von einer DayNight-Basis in `Platforms/Android/Resources/values/styles.xml` erbt. Das Standard-MAUI-Template verwendet `Maui.SplashTheme` und `Maui.MainTheme`, die beide `Theme.AppCompat.DayNight.NoActionBar` erweitern. Wenn Sie das Splash-Theme angepasst haben, halten Sie das Parent auf einem `DayNight`-Vorfahren, sonst bleibt Ihr Splash für immer hell, selbst wenn der Rest der App dunkel wird.

Für Drawables, die eine dunkle Variante benötigen, legen Sie sie in `Resources/values-night/colors.xml` ab oder verwenden Sie die Resource-Qualifizierer-Ordner `-night`. Alles, was über `AppThemeBinding` fließt, benötigt das nicht, aber native Splash-Grafiken und Benachrichtigungssymbole schon.

**Windows.** Es ist keine Änderung an `Package.appxmanifest` erforderlich. Der Windows-App-Host liest das Systemtheme über die Eigenschaft `Application.RequestedTheme` der WinUI-App, und MAUIs `AppThemeBinding`-Mechanik wird automatisch durch sie geleitet. Wenn Sie eine reine Windows-Oberfläche finden, die nicht aktualisiert wird, können Sie das erzwingen, indem Sie `MauiWinUIApplication.Current.MainWindow.Content` auf einen frischen Root setzen, aber das war in 11.0.0 bei mir nicht nötig.

## Statusleiste, Splash und andere native Oberflächen

Zwei Dinge werden nicht von `AppThemeBinding` abgedeckt und stolpern fast jedes Projekt beim ersten Mal:

- **Die Textfarbe und Symbolfarbe der Statusleiste unter Android und iOS** wird von der Plattform kontrolliert, nicht vom Seitenhintergrund. Unter iOS setzen Sie `UIViewController.PreferredStatusBarStyle` pro Seite; unter Android setzen Sie `Window.SetStatusBarColor` aus `MainActivity`. Das einfachste plattformübergreifende Muster ist, den plattformspezifischen Code hinter einen `ConditionalCompilation`-Block in dem oben gezeigten `RequestedThemeChanged`-Handler zu setzen.

- **Splash-Screens** werden vom OS gerendert, bevor MAUI geladen ist, sodass sie kein `AppThemeBinding` konsumieren können. Das Android-Template liefert separate helle und nächtliche Farben über `values/colors.xml` und `values-night/colors.xml`. iOS verwendet ein einzelnes Launch-Storyboard, daher wählen Sie entweder eine neutrale Farbe, die in beiden Modi funktioniert, oder liefern zwei Storyboards über die `LaunchStoryboard`-Konfiguration.

Wenn Sie einen benutzerdefinierten Kartenstil, eine Diagrammpalette oder `WebView`-Inhalte benötigen, die dem Theme folgen, machen Sie den Wechsel in `RequestedThemeChanged`. Speziell für Karten zeigt die [MAUI 11 Map Pin Clustering-Anleitung](/de/2026/04/dotnet-maui-11-map-pin-clustering/), wie Sie den Zustand des Kartensteuerelements mit Themenübergängen synchronisieren können, ohne den Renderer neu aufzubauen.

## Fünf Stolperfallen, die Ihnen einen Nachmittag fressen werden

**1. `Page.BackgroundColor` aktualisiert sich bei einer `UserAppTheme`-Änderung nicht immer.** Das bekannte Problem unter [dotnet/maui#6596](https://github.com/dotnet/maui/issues/6596) bedeutet, dass einige Eigenschaften den Reevaluierungsdurchlauf verpassen, wenn Sie `UserAppTheme` programmatisch setzen. Die zuverlässige Umgehung ist, den Seitenhintergrund über einen `Style`-`Setter` zu setzen (wie im obigen `App.xaml`-Beispiel) statt direkt am Seitenelement. Style-getriebene Setter werten zuverlässig neu aus.

**2. `RequestedThemeChanged` feuert einmal und schweigt dann.** Das ist das Symptom von [dotnet/maui#15350](https://github.com/dotnet/maui/issues/15350), und unter Android ist es fast immer das fehlende `ConfigChanges.UiMode`-Flag. Unter iOS tritt das äquivalente Symptom auf, wenn eine modale Seite zum Zeitpunkt des System-Themenwechsels auf dem Stack liegt; das Schließen und erneute Öffnen der Modal stellt die Ereignisse wieder her. Einmal in `App.xaml.cs` zu abonnieren und das Abonnement am Leben zu halten, ist das sichere Muster.

**3. `AppTheme.Unspecified` setzt sich unter iOS nicht immer auf das OS zurück.** Wie unter [dotnet/maui#23411](https://github.com/dotnet/maui/issues/23411) verfolgt, lässt das Setzen von `UserAppTheme = AppTheme.Unspecified` nach einem harten Override das iOS-Fenster manchmal beim vorherigen Override hängen. Die Umgehung in 11.0.0 ist, `UIWindow.OverrideUserInterfaceStyle = UIUserInterfaceStyle.Unspecified` aus einem benutzerdefinierten `MauiUIApplicationDelegate` zu setzen, nachdem MAUI `UserAppTheme` gesetzt hat. Eine Handvoll Zeilen, und nur erforderlich, wenn Ihre App in den Einstellungen einen "System folgen"-Schalter anbietet.

**4. Benutzerdefinierte Steuerelemente, die Farben bei der Konstruktion einfangen, bleiben für immer hell.** Wenn Sie einen `Color`-Wert im Konstruktor Ihres Steuerelements (oder in einem statischen Feld) cachen, wird er nie aktualisiert. Lesen Sie Themenwerte träge in `OnHandlerChanged` oder binden Sie sie über die Bindable-Property-Pipeline, damit MAUIs `AppThemeBinding`-Mechanik sie neu auswerten kann.

**5. Hot Reload spiegelt Themenänderungen nicht immer wider.** Wenn Sie den Simulator oder Emulator von hell auf dunkel umschalten, während die App suspendiert ist, liefert Hot Reload manchmal die gecachte Ressource. Erzwingen Sie nach dem Umschalten des Systemthemes während der Entwicklung einen vollständigen Rebuild. Das ist ein Tooling-Artefakt, kein `AppThemeBinding`-Bug, und die Diagnose echter Probleme wird viel einfacher, wenn Sie es als Variable entfernen.

## Wo Dark Mode auf den Rest des Frameworks trifft

Dark Mode ist die einfachste Themenfunktion, die MAUI ausliefert, und die, die die Dokumentation am gründlichsten abdeckt, aber sie interagiert mit zwei anderen Teilen des Frameworks, die Sie wahrscheinlich in derselben Woche anfassen. Das Handler-Anpassungsmuster aus [Wie ändert man die Symbolfarbe der SearchBar in .NET MAUI](/de/2025/04/how-to-change-searchbars-icon-color-in-net-maui/) ist die richtige Form, wenn Sie ein Steuerelement haben, dessen nativer Teil `TextColor` im Dark Mode ignoriert (die iOS `UISearchBar` ist der kanonische Übeltäter). Für die Plattformkonfigurations-Tour deckt der Beitrag [Was ist neu in .NET MAUI 10](/de/2025/04/whats-new-in-net-maui-10/) die `Window`- und `MauiWinUIApplication`-Ergänzungen ab, die in MAUI 10 gelandet sind und in 11.0.0 immer noch die richtigen Hooks sind. Wenn Sie themensensitive Steuerelemente in einer Klassenbibliothek bündeln, durchläuft [Wie registriert man Handler in einer MAUI-Bibliothek](/de/2023/11/maui-library-register-handlers/) die `MauiAppBuilder`-Mechanik, einschließlich der Reihenfolge-der-Operationen-Regeln, die bestimmen, wann ein Handler das aufgelöste Theme sieht. Und wenn Ihre Dark-Mode-Arbeit innerhalb eines Desktop-only-Builds stattfindet, zeigt die [nur Windows- und macOS-MAUI 11-Konfiguration](/de/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/), wie Sie die Android- und iOS-Targets fallen lassen, sodass Sie nur zwei Plattformen statt vier debuggen müssen.

## Quellen-Links

- [Respond to system theme changes - .NET MAUI](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/system-theme-changes?view=net-maui-10.0)
- [AppThemeBindingExtension Class - Microsoft.Maui.Controls.Xaml](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.xaml.appthemebindingextension)
- [Application.UserAppTheme Property - Microsoft.Maui.Controls](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.controls.application.userapptheme?view=net-maui-9.0)
- [AppTheme Enum - Microsoft.Maui.ApplicationModel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.maui.applicationmodel.apptheme)
- [Preferences - Microsoft.Maui.Storage](https://learn.microsoft.com/en-us/dotnet/maui/platform-integration/storage/preferences)
- [MAUI sample: Respond to system theme changes](https://learn.microsoft.com/en-us/samples/dotnet/maui-samples/userinterface-systemthemes/)
