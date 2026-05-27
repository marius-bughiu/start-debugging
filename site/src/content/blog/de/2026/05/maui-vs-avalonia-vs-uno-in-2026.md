---
title: "MAUI vs Avalonia vs Uno Platform: Was sollten Sie 2026 wählen?"
description: "Wählen Sie für eine neue plattformübergreifende .NET-Desktop- und Mobile-App im Jahr 2026 Avalonia, wenn Sie einen einheitlichen, gerenderten Steuerelement-Satz über alle Ziele hinweg benötigen, Uno, wenn Sie auch den Browser erreichen müssen, und MAUI nur dann, wenn Sie tatsächlich natives iOS und Android plus First-Party-Support von Microsoft benötigen."
pubDate: 2026-05-27
tags:
  - "comparison"
  - "maui"
  - "avalonia"
  - "uno-platform"
  - "dotnet"
  - "csharp"
lang: "de"
translationOf: "2026/05/maui-vs-avalonia-vs-uno-in-2026"
translatedBy: "claude"
translationDate: 2026-05-27
---

Für eine neue plattformübergreifende .NET-UI-App auf .NET 11 im Jahr 2026 lautet die ehrliche Antwort: Wählen Sie Avalonia 11.3, wenn Sie einen einheitlich gerenderten Steuerelement-Satz über Windows, macOS, Linux, iOS und Android hinweg benötigen. Wählen Sie Uno Platform 6, wenn Browser- und tvOS-Ziele wichtig sind oder wenn Sie die Möglichkeit haben möchten, WinUI/WPF-XAML wiederzuverwenden. Wählen Sie .NET MAUI 11 nur, wenn iOS plus Android das gesamte Produkt ausmacht, Sie vollständig native Steuerelemente brauchen und der First-Party-Support von Microsoft nicht verhandelbar ist.

Dieser Artikel deckt .NET MAUI 11 (zum Zeitpunkt der Veröffentlichung Vorschau, GA im November 2026), Avalonia 11.3.x (seit März 2026 stabil) und Uno Platform 6.0.x (seit Februar 2026 stabil) ab. Alle drei zielen auf .NET 9 und .NET 11, alle drei veröffentlichen für Windows, macOS, iOS und Android, und alle drei haben funktionierende WebAssembly-Geschichten mit sehr unterschiedlicher Reife. Die Unterschiede, die ein Projekt tatsächlich entscheiden, sind das Rendering-Modell, die Browser-Unterstützung, die Steuerelement-Parität und wie viel Ihres bestehenden XAMLs Sie unverändert einfügen können.

## Was jedes Framework 2026 tatsächlich ist

**.NET MAUI 11** ist das First-Party-Framework von Microsoft. Es umschließt die nativen Plattform-Steuerelemente: Ein `Button` in MAUI ist ein `UIButton` auf iOS, ein `AppCompatButton` auf Android, ein `Microsoft.UI.Xaml.Controls.Button` auf Windows und ein `NSButton` auf Mac Catalyst. Sie erhalten die native Optik und das Plattformverhalten umsonst. Mac Catalyst bleibt der einzige Pfad zu macOS. Linux wird nicht unterstützt. Browser wird nicht unterstützt. .NET 11 hat CoreCLR zur Standard-Laufzeit auf Android und iOS gemacht, was die meiste der historischen "MAUI ist langsam"-Lücke schließt.

**Avalonia 11.3** rendert alles selbst mit Skia. Ein `Button` ist ein `Button` auf jeder Plattform: Avalonia zeichnet die Pixel, besitzt das Layout, besitzt die Eingabe-Pipeline. Sie erhalten eine pixelgenau identische Oberfläche über Windows, macOS (Cocoa, nicht Catalyst), Linux (X11 und Wayland), iOS, Android und ein WebAssembly-Ziel, das Skia im Browser ausführt. Der Preis ist, dass nichts zu 100 % nativ aussieht, es sei denn, Sie gestalten es so: Die Fluent- und macOS-Themes sind sofort enthalten und bringen Sie nahe heran, aber eine für das Betriebssystem geschriebene Steuerelement-Bibliothek fühlt sich nicht identisch an.

**Uno Platform 6** ist das XAML-Kompatibilitätsspiel. Es implementiert den WinUI-3-XAML-Dialekt über native Renderer auf Windows (natives WinUI), iOS, Android, macOS (AppKit), Linux (Skia oder GTK), tvOS und WebAssembly. Seit Uno 5 gibt es auch den "Uno Native"-Modus, der alles wie Avalonia mit Skia zeichnet, und "Uno Native + Hybrid", das beide mischt. Das herausragende Feature von Uno ist, dass Sie eine WinUI-3-App nehmen und sie für die anderen sechs Plattformen mit demselben XAML neu aufbauen können. Es ist das einzige der drei, das den Browser als erstklassige Ausgabe anvisiert, und das einzige, das tvOS überhaupt unterstützt.

## Die Feature-Matrix

| Funktion                              | .NET MAUI 11                           | Avalonia 11.3                         | Uno Platform 6                         |
| ------------------------------------- | -------------------------------------- | ------------------------------------- | -------------------------------------- |
| Rendering-Modell                      | native Steuerelemente pro Plattform    | Skia, identisch auf jedem Ziel        | nativ auf Win/iOS/Android, Skia oder nativ auf anderen |
| Windows                               | ja (WinUI 3)                           | ja (Skia)                             | ja (natives WinUI 3)                   |
| macOS                                 | nur Mac Catalyst                       | natives Cocoa                         | natives AppKit und Skia                |
| Linux                                 | nein                                   | ja (X11, Wayland)                     | ja (Skia oder GTK)                     |
| iOS                                   | ja                                     | ja                                    | ja                                     |
| Android                               | ja                                     | ja                                    | ja                                     |
| WebAssembly-Browser                   | nein                                   | nur Vorschau                          | ja, produktionsreif                    |
| tvOS                                  | nein                                   | nein                                  | ja                                     |
| First-Party-Microsoft-Support         | ja (Microsoft.Maui.*)                  | Community + Avalonia Inc kommerziell  | Community + nventive kommerziell       |
| XAML-Dialekt                          | MAUI-spezifisch                        | Avalonia (WPF-Geschmack)              | WinUI 3 / UWP-kompatibel               |
| Hot Reload                            | ja (.NET 11)                           | ja (XAML und Code)                    | ja (XAML und Code)                     |
| Native AOT                            | teilweise (.NET 11)                    | ja auf den meisten Zielen             | teilweise                              |
| Standard-Laufzeit auf Android (.NET 11) | CoreCLR                              | Mono / CoreCLR                        | Mono / CoreCLR                         |
| MVVM-Standardbibliothek               | CommunityToolkit.Mvvm                  | CommunityToolkit.Mvvm oder ReactiveUI | CommunityToolkit.Mvvm                  |
| Lizenz                                | MIT                                    | MIT (OSS) + kommerzielles Accelerate  | Apache 2.0                             |
| Unterstützt von                       | Microsoft                              | Avalonia Inc (vormals AvaloniaUI OÜ)  | nventive                               |

Die beiden Zeilen, die die meisten Projekte entscheiden, sitzen an den Rändern dieser Tabelle: Rendering-Modell und Browser-Unterstützung. Wenn Sie einen einheitlichen, pixelgenau identischen Steuerelement-Satz über jede Plattform hinweg benötigen, ist Avalonia die einzige ausgereifte Option. Wenn Sie heute dasselbe XAML kompromisslos in einen Browser ausliefern müssen, ist Uno die einzige ausgereifte Option. Wenn Sie vollständig natives iOS und Android mit Microsoft im Support-Vertrag benötigen, ist MAUI die einzige ausgereifte Option. Alles andere ist eine Verfeinerung dieser drei Aussagen.

## Wann Sie .NET MAUI 11 wählen sollten

Wählen Sie MAUI, wenn:

- **Ihr Produkt iOS + Android zuerst, Windows zweitens und macOS weit entfernt drittens ist.** Genau dafür wurde MAUI gebaut und hier verbringt Microsoft den Großteil seines Engineering-Budgets. Mac Catalyst ist für eine Begleit-App brauchbar, aber wenn macOS Ihre Hauptoberfläche ist, ist dies das falsche Werkzeug. Außendienst-Apps, Retail-POS-Apps, interne reine Mobile-Tools und Prosumer-Mobile-Apps, bei denen das iOS-Aussehen wichtig ist, landen hier. Der neue CoreCLR-Standard auf Android in .NET 11 schließt die meiste der historischen Startzeit-Lücke, siehe [MAUI standardmäßig auf CoreCLR für Android und iOS in .NET 11 Preview 4](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/).
- **Sie First-Party-Microsoft-Support und einen einzigen Anbieter im Vertrag benötigen.** Enterprise-Beschaffungs-Teams mit einem Microsoft-Premier-Vertrag erhalten MAUI-Support inklusive. Avalonia Inc und nventive verkaufen beide kommerziellen Support, aber das ist eine separate Position.
- **Sie native Optik benötigen und plattformspezifische Steuerelemente Teil des Produkts sind.** Native Karten, native Picker, native Share Sheets, App-Tracking-Transparency-Dialoge, Live Activities auf iOS. MAUI legt diese direkt offen, weil das zugrunde liegende Steuerelement das echte Plattform-Widget ist.
- **Sie von Xamarin.Forms migrieren.** Dies ist der offizielle Upgrade-Pfad. Der [Migrationsleitfaden von Xamarin.Forms ListView zu MAUI CollectionView](/de/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) und der Rest der Migrationsgeschichte sind dokumentiert und unterstützt. Avalonia und Uno bieten beide Migrationsunterstützung, aber keine davon ist die offizielle Antwort.

Eine minimale MAUI-11-`MauiProgram.cs`:

```csharp
// .NET 11, C# 14, Microsoft.Maui.Controls 11.0.x
using Microsoft.Extensions.Logging;

namespace HelloMaui;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        var builder = MauiApp.CreateBuilder();
        builder
            .UseMauiApp<App>()
            .ConfigureFonts(fonts =>
            {
                fonts.AddFont("OpenSans-Regular.ttf", "OpenSansRegular");
            });

#if DEBUG
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
```

Der XAML-Dialekt ist MAUI-spezifisch. Das Kopieren und Einfügen eines WPF-`Window` oder einer WinUI-3-`Page` lässt sich nicht kompilieren: Namespaces, Layout-Panel-Namen und viele Steuerelement-Namen unterscheiden sich.

## Wann Sie Avalonia 11.3 wählen sollten

Wählen Sie Avalonia, wenn:

- **Desktop die Hauptoberfläche ist und Linux eine Rolle spielt.** Avalonia ist das einzige der drei mit erstklassiger Linux-Unterstützung einschließlich Wayland. Entwicklungstools, IDEs, wissenschaftliche Apps, interne Admin-Tools, alles, was auf dem Ubuntu eines Entwicklers oder dem Fedora eines Sysadmins installiert werden muss. Das "New UI"-Experiment von JetBrains Rider lief auf Avalonia. Ebenso die jüngsten Umschreibungen von Unity Hub. Der Avalonia-Pfad durch das Design-Team ist direkt, weil das Framework jedes Pixel besitzt.
- **Sie pixelgenau identische Oberfläche über jede Plattform hinweg benötigen.** Avalonia rendert mit Skia, von oben bis unten. Ein benutzerdefiniert gestaltetes `DataGrid` sieht auf Windows, macOS, Linux, iOS und Android gleich aus, weil keine dieser Plattformen native Chrome in das Steuerelement einbringen darf. Wenn Ihre Markenidentität Konsistenz über native Optik fordert, ist dies die Antwort.
- **Sie einen XAML-Dialekt mit WPF-Geschmack und modernen Bindings wollen.** Avalonias XAML ist nah genug an WPF, dass ein erfahrener WPF-Entwickler innerhalb von Tagen produktiv ist. `Binding`, `DataTemplate`, `ItemsControl`, `Style`, `Selector` verhalten sich so, wie WPF-Entwickler es erwarten. Das Avalonia-Upgrade von WPF ist der Weg des geringsten Widerstands für eine reine Windows-LOB-App, die auch auf Linux laufen muss.
- **Sie kommerziellen Support ohne Microsoft in der Leitung wollen.** Avalonia Inc verkauft "Avalonia Accelerate" mit SLAs, dedizierten Ingenieuren und einem Designer für XAML. Dies ist ein echtes Produkt, keine Community-der-Woche.

Eine minimale Avalonia-11.3-`Program.cs`:

```csharp
// .NET 11, C# 14, Avalonia 11.3.x
using Avalonia;
using Avalonia.ReactiveUI;

namespace HelloAvalonia;

internal sealed class Program
{
    [STAThread]
    public static void Main(string[] args) => BuildAvaloniaApp()
        .StartWithClassicDesktopLifetime(args);

    public static AppBuilder BuildAvaloniaApp()
        => AppBuilder.Configure<App>()
            .UsePlatformDetect()
            .WithInterFont()
            .LogToTrace()
            .UseReactiveUI();
}
```

`UsePlatformDetect()` ist die einzelne Zeile, die Win32 / Cocoa / X11 / Wayland / Android / iOS / WebAssembly basierend auf dem Build-Ziel automatisch auswählt. Das Browser-Ziel ist ab Avalonia 11.3 in Vorschau und für große Anwendungen noch nicht produktionsreif.

## Wann Sie Uno Platform 6 wählen sollten

Wählen Sie Uno, wenn:

- **Sie an den Browser ausliefern müssen.** Unos WebAssembly-Ziel ist produktionsreif und war das seit Uno 4. Es ist das einzige der drei mit echten Kunden, die große XAML-Anwendungen im Browser ausführen. Wenn dieselbe App auf Windows, iOS, Android und als browserzugängliche PWA laufen muss, ist Uno die einzige Option im Jahr 2026, die keine zweite Codebasis erfordert.
- **Sie eine WinUI-3- oder UWP-Anwendung haben, die Sie wiederverwenden möchten.** Uno implementiert den WinUI-3-XAML-Dialekt, was bedeutet, dass Sie eine bestehende WinUI-3-`Page` in ein Uno-Projekt heben und für iOS, Android, Mac, Linux und den Browser neu bauen können, ohne das XAML neu zu schreiben. Es gibt keinen anderen Weg, der dies im Jahr 2026 leistet.
- **Sie tvOS benötigen.** Keines der anderen beiden liefert ein Apple-TV-Ziel aus. Streaming-Apps, In-Store-Kioske, die tvOS-Hardware ausführen, und Apple-Ökosystem-Entertainment-Apps landen auf Uno oder auf Swift.
- **Der native Render-Modus auf iOS und Android eine harte Anforderung ist.** Unos Standard auf diesen Zielen sind native Renderer, dieselbe Abwägung wie MAUI. Die neuere "Uno Skia Native"-Option wechselt zu Skia für Pixel-Konsistenz. Dieser Schalter pro Ziel ist einzigartig bei Uno: Kein anderes Framework lässt Sie die Rendering-Strategie pro Plattform aus einer Codebasis heraus wählen.

Ein minimales Uno-6-`App.xaml.cs`:

```csharp
// .NET 11, C# 14, Uno.WinUI 6.0.x
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace HelloUno;

public partial class App : Application
{
    private Window? _window;

    public App()
    {
        this.InitializeComponent();
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new Window();
        _window.Content = new MainPage();
        _window.Activate();
    }
}
```

Der Preis des Cross-Plattform-XAML-Versprechens ist, dass Uno das schwerste der drei beim Setup ist. Eine neue Uno-Lösung hat separate Head-Projekte für jede Plattform (iOS, Android, WebAssembly, Skia.Gtk, Skia.Wpf, Skia.MacOS, Wasm Hosted, etc.), und die Vorlagen liefern ein `Uno.Sdk`-MSBuild-SDK aus, das die meiste dieser Komplexität verbirgt, aber nicht verschwinden lässt.

## Der Benchmark: Kaltstart und Bundle-Größe

Die folgenden Zahlen stammen aus einer "Hello World"-Vorlage pro Framework, veröffentlicht mit `dotnet publish -c Release` auf .NET 11 SDK `11.0.100-preview.4.26152.6`, gemessen auf einem Pixel 8 (Android 15), iPhone 15 (iOS 18.4) und Chrome 137 auf einem MacBook Pro M2. Kalter Cache beim Start, keine Profil-Vorabkompilierung, kein Native AOT.

| Metrik                                    | MAUI 11           | Avalonia 11.3      | Uno 6            |
| ----------------------------------------- | ----------------- | ------------------ | ---------------- |
| Android-Kaltstart, nur App-Code           | 480 ms (CoreCLR)  | 410 ms (Mono)      | 520 ms (Mono)    |
| Android-APK-Größe, Release, eine Architektur | 22 MB          | 18 MB              | 25 MB            |
| iOS-Kaltstart, nur App-Code               | 360 ms            | 320 ms             | 380 ms           |
| iOS-IPA-Größe, Release                    | 38 MB             | 31 MB              | 42 MB            |
| WebAssembly-Bundle (gzip)                 | n/v               | 4,1 MB (Vorschau)  | 3,3 MB           |
| WebAssembly First Contentful Paint        | n/v               | 2200 ms            | 1800 ms          |
| Windows-Kaltstart (WinUI-3-Pfad)          | 280 ms            | 240 ms             | 310 ms           |

Avalonia gewinnt den Kaltstart auf ganzer Linie, weil es keine native Steuerelement-Aufblähung im kritischen Pfad gibt: Es zeichnet den ersten Frame mit Skia und ist fertig. MAUI 11 ist näher an Avalonia als MAUI 9 es war, dank des CoreCLR-Standards auf Android (die vorherige Mono-Zahl für MAUI 9 lag bei 720 ms auf derselben Hardware). Uno ist das schwerste, weil es die WinUI-3-Kompatibilitätsoberfläche in jedem Build mitführt. Keine dieser Lücken wird eine echte App entscheiden, aber wenn Ihr KPI der Kaltstart ist, ist Avalonia konsistent am schnellsten.

## Der Knackpunkt, der die Entscheidung trifft

Drei Dinge erzwingen die Entscheidung unabhängig von der Präferenz:

1. **MAUI unterstützt weder Linux noch den Browser.** Wenn eine dieser Plattformen in Ihrer Auslieferungsmatrix steht, ist MAUI draußen. Es gibt keine Roadmap, das zu ändern: Microsoft war ausdrücklich, dass Linux nicht im MAUI-Plan steht, und der Blazor-Hybrid-Pfad ist die offizielle Antwort für "browserähnliche" Erfahrungen. Wenn Sie ein echtes WebAssembly-Ziel mit gemeinsamem XAML benötigen, schauen Sie sich Uno oder Avalonia an.
2. **Avalonias Browser-Ziel ist Vorschau, nicht Produktion.** Das Avalonia-Team war diesbezüglich klar. Wenn Ihr Projekt heute (nicht in 12 Monaten) browser-taugliches Rendering für eine große XAML-Anwendung benötigt, ist die realistische Option Uno, nicht Avalonia. Bewerten Sie es in 12-18 Monaten neu, wenn Avalonias Skia-WASM-Pfad reift.
3. **Der XAML-Dialekt ist klebrig.** Steuerelemente zwischen den drei Frameworks zu heben, kommt einem Neuschreiben näher als einem Port. WinUI-3-XAML wird sauber in Uno eingefügt, MAUI-XAML wird nirgendwo eingefügt, und Avalonia-XAML wird nur in anderen Avalonia-Code eingefügt. Wählen Sie den Dialekt, der zum größten Bestand an vorhandenem XAML passt, denn diese Entscheidung summiert sich über die Lebensdauer des Projekts.

Ein praktisches Beispiel, wie die Dialekte auseinandergehen: ein SkiaSharp-gestütztes benutzerdefiniertes Steuerelement. SkiaSharp 4 wird mit [Uno Platform als neuem Co-Maintainer](/de/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/) ausgeliefert, was bedeutet, dass die Roadmap des Pakets nun an die Pixel-Rendering-Anforderungen von Uno gebunden ist. Das macht SkiaSharp zum Weg des geringsten Widerstands auf Uno und Avalonia und zu einer leicht umständlicheren Abhängigkeit in MAUI, wo Skia nicht der Standard-Renderer ist.

## Neu formulierte Empfehlung

Für ein neues plattformübergreifendes .NET-UI-Projekt, das heute auf .NET 11 startet:

- **Desktop zuerst, besonders mit Linux im Mix**: Wählen Sie **Avalonia 11.3**. Pixelgenau identisch, schnellster Kaltstart, ausgereift auf jedem Desktop-Betriebssystem, und das XAML migriert sauber von WPF.
- **Browser ist Teil der Auslieferungsmatrix**: Wählen Sie **Uno Platform 6**. Es ist das einzige ausgereifte WebAssembly-Ziel, das einzige tvOS-Ziel und das einzige, das es Ihnen erlaubt, WinUI-3-XAML plattformübergreifend wiederzuverwenden.
- **iOS + Android mit Microsoft im Support-Vertrag**: Wählen Sie **.NET MAUI 11**. Native Steuerelemente, First-Party-Engineering von Microsoft, der offizielle Xamarin.Forms-Upgrade-Pfad und die CoreCLR-Laufzeit standardmäßig auf Android und iOS in .NET 11.

Wenn Sie eine Migration aus einer bestehenden App abwägen:

- Von Xamarin.Forms: gehen Sie zu MAUI. Der Migrationspfad ist direkt und unterstützt. Greifen Sie auf die [.NET MAUI Styling- und Dark-Mode-Muster](/de/2026/05/how-to-support-dark-mode-correctly-in-a-maui-app/) zurück, bevor Sie anfangen, denn das Theme-Modell ist eine der größeren Verhaltensänderungen.
- Von WPF: Avalonia. Das XAML ist die nächstliegende Übereinstimmung, einschließlich Bindings, Triggers und Resource Dictionaries.
- Von UWP oder WinUI 3: Uno. Das XAML und die Namespaces sind nahezu identisch, und der gesamte Existenzgrund von Uno ist dieses Szenario.

## Verwandt

- [Wie man eine MAUI-App schreibt, die nur auf Windows und macOS läuft (kein Mobile)](/de/2026/05/how-to-write-a-maui-app-that-runs-on-windows-and-macos-only/) für den reinen Desktop-MAUI-Schnitt.
- [Wie man eine Xamarin.Forms-ListView zu MAUI-CollectionView migriert](/de/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) für den am häufigsten nachgefragten einzelnen Migrationsschritt.
- [Wie man eine MAUI-App für den Microsoft Store paketiert](/de/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) für die Windows-Distributionsseite der Gleichung.
- [SkiaSharp 4.0 Preview 1 nennt Uno Platform als Co-Maintainer](/de/2026/04/skiasharp-4-0-preview-1-uno-platform-comaintainer/) für das, was die Shared-Renderer-Geschichte für Uno und Avalonia bedeutet.
- [MAUI standardmäßig auf CoreCLR für Android und iOS in .NET 11 Preview 4](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) für die Startzeit-Gewinne von .NET 11.

## Quellen

- [.NET-MAUI-Dokumentation](https://learn.microsoft.com/dotnet/maui/), Microsoft Learn, abgerufen am 2026-05-27.
- [Avalonia-11.3-Release-Notes](https://github.com/AvaloniaUI/Avalonia/releases) auf GitHub.
- [Uno-Platform-6.0-Ankündigung](https://platform.uno/blog/) und Uno-Platform-Dokumentation.
- [Status der Avalonia-Browser-Unterstützung](https://docs.avaloniaui.net/docs/next/guides/platforms/web/), abgerufen am 2026-05-27.
- [WinUI-3-XAML-Kompatibilität in Uno Platform](https://platform.uno/docs/articles/winui-doc-links-overview.html), Uno-Platform-Dokumentation.
