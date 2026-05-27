---
title: "Flutter vs React Native vs .NET MAUI: Was sollten Sie 2026 für ein neues Mobile-Projekt wählen?"
description: "Für eine neue Mobile-App auf der grünen Wiese im Jahr 2026 wählen Sie Flutter 3.44, wenn pixelgenau identische UI und Animations-Budget wichtig sind, React Native 0.82, wenn Ihr Team bereits in TypeScript zu Hause ist und Sie einen echten Browser-Ableger benötigen, und .NET MAUI 11, wenn iOS und Android Teil eines breiteren .NET-Produkts sind und Sie First-Party-Support von Microsoft benötigen."
pubDate: 2026-05-27
tags:
  - "comparison"
  - "flutter"
  - "react-native"
  - "maui"
  - "mobile"
  - "dotnet"
lang: "de"
translationOf: "2026/05/flutter-vs-react-native-vs-maui-for-a-new-mobile-project-in-2026"
translatedBy: "claude"
translationDate: 2026-05-27
---

Für eine neue iOS- und Android-App, die heute startet, lautet die ehrliche Antwort: Wählen Sie Flutter 3.44, wenn pixelgenau identische UI, ruckelfreie 120-Hz-Animation und eine einzige Dart-Codebasis die Prioritäten sind. Wählen Sie React Native 0.82, wenn Ihr Engineering-Team TypeScript-first arbeitet, Sie das JS-Paket-Ökosystem griffbereit haben möchten und eine zukünftige Browser-Version im Scope ist. Wählen Sie .NET MAUI 11, wenn Mobile eine Oberfläche eines breiteren .NET-11-Produkts ist und Microsoft im Support-Vertrag nicht verhandelbar ist. Bei 95 % der Business-Apps ist die Leistung ein Unentschieden. Team-Passung und Ökosystem-Passung entscheiden für Sie.

Dieser Artikel deckt Flutter 3.44 (seit Mai 2026 stabil, Material 3 in eigene Pakete ausgelagert), React Native 0.82 (seit April 2026 stabil, New Architecture verpflichtend, Bridgeless als Standard) und .NET MAUI 11 (zum Zeitpunkt der Veröffentlichung Vorschau, GA im November 2026, CoreCLR standardmäßig auf Android und iOS) ab. Alle drei liefern an iOS 18 und Android 15+, alle drei unterstützen Hot Reload, und alle drei haben ausgelieferte Beispiele im App Store und Play Store. Die Unterschiede, die ein Projekt tatsächlich entscheiden, sind Sprache, Rendering-Modell, Ökosystem-Reife und auf welche Plattform Sie das Team hieven können, ohne das Back-End neu zu schreiben.

## Was jedes Framework 2026 tatsächlich ist

**Flutter 3.44** ist ein Dart-first, Skia-gerendertes UI-Toolkit. Es zeichnet alles selbst: Ein `Button` ist kein `UIButton` und kein `AppCompatButton`, sondern die Pixel, die die Flutter-Engine basierend auf dem von Ihnen verwendeten `Material`- oder `Cupertino`-Widget gezeichnet hat. iOS-Nutzer erhalten Cupertino-Themen-Widgets, die nativ aussehen, Android-Nutzer erhalten Material-3-Widgets, aber das Framework besitzt jedes Layout und jede Geste. Das 3.44-Release hat `material` und `cupertino` in separate Pakete verschoben, die auf der iOS-Seite über Swift Package Manager verteilt werden, was Modul-Level-Deltas einfacher zu verfolgen macht, aber einmalige Migrationskosten in Ihrer `pubspec.yaml` hinzufügt.

**React Native 0.82** ist ein JavaScript-/TypeScript-Framework, das über eine Turbo-Modules-Bridge auf native iOS- und Android-Views abbildet. Seit 0.78 ist die New Architecture (Fabric-Renderer + TurboModules + JSI) für neue Projekte der Standard; seit 0.82 ist die Legacy-Bridge vollständig entfernt. Der Bridgeless-Modus bedeutet, dass JavaScript nach Möglichkeit synchron nativen Code aufruft, was die historische Beschwerde "RN fühlt sich träge an" 2026 deutlich weniger zutreffend macht als 2022. Die JS-Engine ist standardmäßig Hermes auf beiden Plattformen, und `expo` ist der De-facto-Build-Orchestrator: Eine reine `react-native init`-Vorlage existiert noch, ist aber für neue Apps nicht mehr der empfohlene Pfad.

**.NET MAUI 11** ist das First-Party-Framework von Microsoft. Es umschließt die nativen Plattform-Steuerelemente: Ein `Button` in MAUI ist ein `UIButton` auf iOS, ein `AppCompatButton` auf Android, ein `Microsoft.UI.Xaml.Controls.Button` auf Windows und ein `NSButton` auf Mac Catalyst. CoreCLR ist in .NET 11 nun die Standard-Laufzeit auf Android und iOS, was die meiste der historischen Startzeit-Lücke zu Flutter und RN schließt. MAUI teilt sich denselben XAML-/C#-Stack mit WinUI 3 und Blazor Hybrid, daher ergibt es am meisten Sinn, wenn iOS und Android Geschwister eines Windows-Desktops oder eines Blazor-Web-Produkts sind, nicht wenn Mobile das gesamte Universum ist.

## Die Feature-Matrix

| Fähigkeit                             | Flutter 3.44                        | React Native 0.82                   | .NET MAUI 11                          |
| ------------------------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------- |
| Primäre Sprache                       | Dart 3.7                            | TypeScript / JavaScript             | C# 14                                 |
| Rendering-Modell                      | Skia, identische Pixel pro Plattform | native Views via Fabric / TurboModules | native Steuerelemente pro Plattform |
| iOS                                   | ja                                  | ja                                  | ja                                    |
| Android                               | ja                                  | ja                                  | ja                                    |
| Windows-Desktop                       | ja (stabil seit 3.16)               | Community (`react-native-windows`)  | ja (WinUI 3)                          |
| macOS-Desktop                         | ja (stabil seit 3.16)               | Community (`react-native-macos`)    | Mac Catalyst                          |
| Linux-Desktop                         | ja (stabil seit 3.10)               | nein                                | nein                                  |
| Web (Browser)                         | Vorschau, nicht produktionsreif für große Apps | ja (via React DOM, eingeschränkte Code-Wiederverwendung) | nein (Blazor Hybrid ist separat) |
| Hot Reload                            | unter einer Sekunde, zustandserhaltend | Fast Refresh, zustandserhaltend  | ja (.NET 11)                          |
| Standard-Laufzeit auf Android (.NET 11) | AOT-kompiliertes Dart             | Hermes JS                           | CoreCLR                               |
| Standard-IDE                          | VS Code, Android Studio             | VS Code, WebStorm                   | Visual Studio 2026, Rider             |
| Paket-Ökosystem                       | pub.dev, 50k+ Pakete                | npm, die gesamte JS-Welt            | NuGet, .NET-Ökosystem                 |
| First-Party-Support                   | Google                              | Meta + Community                    | Microsoft                             |
| New Architecture / Laufzeit-Baseline  | immer-aktives AOT                   | verpflichtend seit 0.80             | CoreCLR Standard seit .NET 11 Preview 4 |
| Lizenz                                | BSD-3                               | MIT                                 | MIT                                   |
| Standard-State-Management             | Riverpod, Bloc, Provider            | Redux Toolkit, Zustand, TanStack Query | CommunityToolkit.Mvvm              |

Drei Zeilen entscheiden die meisten Projekte: primäre Sprache, Rendering-Modell und First-Party-Support. Der Rest ist Verfeinerung. Wenn Ihr Engineering-Team TypeScript schreibt und Ihr Back-End Node ist, beträgt der Aufwand für React Native Tage, nicht Monate. Wenn Ihr Team C# gegen .NET und Entity Framework Core schreibt, lässt MAUI sie DTOs, Validierung und sogar ViewModels mit der Web-Schicht teilen. Flutter ist das einzige, bei dem die produktive Sprache im Wesentlichen einzigartig für das Framework ist, was eine echte Steuer ist, wenn Ihr Team nie Dart geschrieben hat.

## Wann Sie Flutter 3.44 wählen sollten

Wählen Sie Flutter, wenn:

- **Pixelgenau identische UI über iOS und Android Teil des Produkts ist.** Ein benutzerdefiniertes Design-System, eine markengetriebene App, eine spielnahe App oder ein Consumer-Produkt, bei dem das Design-Team starke Meinungen hat. Flutter rendert mit Skia von oben bis unten, sodass ein `CustomPainter` auf einem Pixel 8 und einem iPhone 15 gleich aussieht, ohne plattformspezifisches Nachjustieren. Dies ist der mit Abstand häufigste Grund, warum Teams 2026 Flutter wählen.
- **Animations-Budget wichtig ist und 120 Hz in der Spezifikation steht.** Flutters Render-Pipeline ist auf ein 120-Hz-Ziel ausgelegt. Impeller (das neue Grafik-Backend, Standard auf iOS seit 3.7 und auf Android seit 3.16) beseitigt das Shader-Kompilierungs-Ruckeln, das frühen Flutter-Apps geschadet hat. Wenn Sie schwere gestengesteuerte UI, eine komplexe animierte Liste oder etwas Spielähnliches bauen, ist Flutter die sicherste Wahl der drei.
- **Sie eine Codebasis wollen, die iOS, Android und Desktop ohne Kompromisse erreicht.** Flutter Desktop ist GA auf Windows, macOS und Linux. Der Widget-Katalog ist derselbe; nur das Eingabe-Modell und die Fenster-Chrome ändern sich. Keines der anderen beiden liefert eine vergleichbare Linux-Desktop-Geschichte.
- **Das Team das Erlernen von Dart aufnehmen kann.** Dart 3.7 ist 2026 eine starke Sprache mit Sound Null Safety, Mustervergleich, Records und Klassen-Modifier-Schlüsselwörtern (`sealed`, `final`, `interface`). Senior-Entwickler aus TypeScript oder C# erreichen die Produktivität in etwa zwei Wochen. Junior-Entwickler brauchen länger, weil das Ökosystem außerhalb von Flutter klein ist.

Eine minimale Flutter-3.44-`main.dart`:

```dart
// Flutter 3.44, Dart 3.7
import 'package:flutter/material.dart';

void main() => runApp(const HelloApp());

class HelloApp extends StatelessWidget {
  const HelloApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Hello Flutter',
      theme: ThemeData(useMaterial3: true),
      home: const HelloPage(),
    );
  }
}

class HelloPage extends StatelessWidget {
  const HelloPage({super.key});

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Hello')),
        body: const Center(child: Text('Hello, Flutter')),
      );
}
```

Das `useMaterial3: true`-Flag ist in 3.44 nun der Standard (siehe [die Flutter-3.44-Aufteilung der Material- und Cupertino-Pakete](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) für das, was sich unter der Haube geändert hat), sodass Sie die Zeile in neuen Projekten weglassen können.

## Wann Sie React Native 0.82 wählen sollten

Wählen Sie React Native, wenn:

- **Ihr Team bereits React und TypeScript für das Web schreibt.** Dies ist der mit Abstand größte Grund, warum RN 2026 einen Bake-off gewinnt. Hooks, das Komponentenmodell, die Daten-Fetching-Bibliotheken (TanStack Query, SWR) und die meisten Validierungsbibliotheken (Zod) funktionieren unverändert. Ein Senior-React-Entwickler liefert eine funktionierende RN-Funktion in Tagen aus, nicht in Wochen. Flutter und MAUI erfordern beide das Erlernen eines neuen Komponentenmodells.
- **Sie npm-Pakete wiederverwenden müssen, insbesondere rund um KI, Zahlungen und Analytics.** Das JavaScript-Ökosystem stellt Darts `pub.dev` und die mobile-spezifischen NuGet-Pakete von .NET in den Schatten. Wenn Ihre Roadmap Stripe, Segment, das Anthropic SDK, das OpenAI SDK, LangChain oder irgendetwas aus der KI-Tooling-Schicht enthält, finden Sie eine First-Party-JS-/TS-Bibliothek, bevor Sie ein Dart- oder C#-Äquivalent finden.
- **Dasselbe Produkt eine Web-Version benötigt und die Code-Wiederverwendung über Web und Mobile Teil des Plans ist.** React Native und React DOM sind unterschiedliche Rendering-Ziele, teilen sich aber Hooks, Geschäftslogik, Validierung und ungefähr 60-70 % des präsentationellen Codes, wenn Sie [React Native for Web](https://github.com/necolas/react-native-web) oder Expos universelle Apps verwenden. Flutter hat ein Web-Ziel, das aber 2026 für große Apps in Vorschau-Qualität ist, und MAUI hat keine echte Browser-Geschichte (Blazor Hybrid ist ein separater Stack).
- **Sie Hermes + die New Architecture ohne Legacy-Bridge-Kopfschmerzen wollen.** Ab 0.82 ist die Legacy-Bridge weg. Module verwenden TurboModules mit JSI, der Renderer ist Fabric, und alte Pakete, die nicht migriert wurden, werden nicht geladen. Dies ist eine sauberere Baseline, als RN sie seit dem Launch hatte, und die Beschwerden aus der 2022er-Ära über Thread-Hopping-Latenz treffen meist nicht mehr zu.

Eine minimale React-Native-0.82-`App.tsx`:

```typescript
// React Native 0.82, Expo SDK 53, TypeScript 5.6
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text>Hello, React Native</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
```

Expo ist nun das Standard-Scaffold. `npx create-expo-app` für ein neues Projekt, `expo prebuild`, falls Sie ein benutzerdefiniertes natives Modul benötigen, und EAS Build für in der Cloud gebaute `.ipa`- und `.aab`-Artefakte. Der "Bare Workflow" existiert noch, wird vom Team aber seit Expo SDK 51 nicht mehr für neue Projekte empfohlen.

## Wann Sie .NET MAUI 11 wählen sollten

Wählen Sie MAUI, wenn:

- **iOS und Android Begleitoberflächen eines breiteren .NET-Produkts sind.** Ein Außendienst-Tool, das auch eine Blazor-Server-Admin-Konsole hat, ein Retail-POS, der sich eine Entity-Framework-Core-Domäne mit einem Windows-Back-Office teilt, eine Healthcare-App, deren Validierungsregeln sowohl auf einer ASP.NET-Core-API als auch auf dem Gerät laufen. MAUI lässt Sie das Datenmodell, die DTOs, die FluentValidation-Regeln und sogar die ViewModels mit `CommunityToolkit.Mvvm` teilen. Kein anderes Framework gibt Ihnen diese Reichweite mit einer Sprache.
- **Sie von Xamarin.Forms migrieren.** Dies ist der offizielle Pfad. Der [Migrationsleitfaden von Xamarin.Forms ListView zu MAUI CollectionView](/de/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) ist der am häufigsten nachgefragte einzelne Migrationsschritt, und das Tooling ist seit den schmerzhaften 8.0-Tagen gereift.
- **Sie First-Party-Microsoft-Support und einen einzigen Anbieter im Vertrag benötigen.** Enterprise-Beschaffungs-Teams, die einen Microsoft-Premier- oder Unified-Support-Vertrag haben, erhalten MAUI inklusive. Flutter hat Google, aber keinen Enterprise-Vertrag, und React Native hat Meta plus eine Community von Anbietern.
- **Das Team C# schreibt und das Back-End .NET ist.** Eine einzige Sprache über Mobile, Web, Desktop und Server zu teilen, ist ein echter Produktivitäts-Multiplikator. Typgeprüfte DTOs über die Leitung (System.Text.Json-Source-Generators), geteilte Validierung, identische Logging-Primitive. Flutter und RN können dies ohne einen Code-Gen-Schritt oder eine duplizierte Implementierung nicht.

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

Der CoreCLR-als-Standard-Umschalter in [.NET 11 Preview 4 schließt die meiste der historischen MAUI-Kaltstart-Lücke](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) auf Android und iOS, was das größte einzelne Update des Frameworks seit 8.0 GA ist.

## Der Benchmark: Kaltstart und Bundle-Größe

Die folgenden Zahlen stammen aus einer "Hello World"-Vorlage pro Framework, im Release-Build kompiliert und auf einem Pixel 8 (Android 15) und einem iPhone 15 (iOS 18.4) installiert. Kaltstart gemessen ab `am start` (Android) und einem Instruments-Launch-Trace (iOS), keine Profil-Vorab-Optimierung, kein Native AOT für MAUI, Impeller an für Flutter, Hermes + Fabric für RN.

| Metrik                                    | Flutter 3.44     | React Native 0.82 | MAUI 11 (CoreCLR) |
| ----------------------------------------- | ---------------- | ----------------- | ----------------- |
| Android-Kaltstart, nur App-Code           | 320 ms           | 450 ms            | 480 ms            |
| Android-APK-Größe, Release, eine Architektur | 19 MB         | 24 MB             | 22 MB             |
| iOS-Kaltstart, nur App-Code               | 280 ms           | 340 ms            | 360 ms            |
| iOS-IPA-Größe, Release                    | 28 MB            | 35 MB             | 38 MB             |
| Speicher-Footprint im Leerlauf (Android)  | 78 MB            | 110 MB            | 132 MB            |
| Bilder pro Sekunde unter schwerem Scrollen | 119,2           | 117,8             | 118,4             |

Flutter gewinnt den Kaltstart auf ganzer Linie, weil seine Engine AOT-kompiliertes Dart vom Start weg ist und nicht zuerst eine JS- oder CoreCLR-Laufzeit hochfahren muss. React Native ist näher an MAUI, als es früher war, weil Hermes + Fabric ihre Initialisierungskosten einmal bezahlen, nicht pro Frame. MAUI auf CoreCLR ist näher an RN als die MAUI-auf-Mono-Zahl, die Sie möglicherweise zitiert gesehen haben (die für dieselbe Vorlage bei ~720 ms auf Android lag). Die FPS-Zeile ist im Wesentlichen ein Unentschieden: Alle drei rendern an der Aktualisierungsobergrenze des Geräts, sobald die App läuft. Der Kaltstart ist wichtig für die App-Start-Wahrnehmung. Anhaltende FPS sind wichtig für das In-App-Gefühl. Die erste Zeile entscheidet "fühlt sich das Icon flott an". Die letzte Zeile entscheidet "fühlt sich die App modern an". Die Lücke in der ersten Zeile ist real, aber klein; die Lücke in der letzten Zeile ist nicht messbar.

## Der Knackpunkt, der die Entscheidung trifft

Drei Dinge erzwingen die Entscheidung unabhängig von der Präferenz:

1. **Die bestehende Sprache Ihres Teams.** Ein TypeScript-Team wählt React Native. Ein C#-Team wählt MAUI. Nur ein Team ohne etablierten Stack oder eines, das ausdrücklich bereit ist, Dart zu lernen, wählt Flutter. Die Kosten, einem Senior-Entwickler eine dritte Sprache beizubringen, die er nur im Mobile-Projekt verwenden wird, sind real und tauchen nicht in einer Feature-Matrix-Tabelle auf.
2. **Web steht auf der Roadmap, auch wenn nicht in v1.** Wenn "wir werden irgendwann eine Web-Version ausliefern" in der Produktspezifikation steht, sind RN mit `react-native-web` oder Flutter Web die beiden gangbaren Pfade, und nur RN ist 2026 produktionsreif. Flutter Web ist ein Vorschau-Qualitäts-Ziel für nicht-triviale Apps; das Flutter-Team hat dies gesagt. MAUI hat keine Browser-Geschichte (Blazor Hybrid ist ein separater Stack mit einem anderen Programmiermodell). Wenn Sie MAUI wählen und später eine Web-Version benötigen, schreiben Sie eine zweite App.
3. **First-Party-native Module, die Sie nicht abstrahieren können.** App-Tracking-Transparency-Dialoge, App Clips, Live Activities, Dynamic-Island-Widgets, Wear-OS-Tiles, Health Connect, App Intents. Flutter hat Plugins für die meisten davon; einige werden noch von der Community gepflegt. RN hat die breiteste Plugin-Abdeckung dank des Expo-Ökosystems. MAUI legt native Plattform-APIs direkt offen, weil das zugrunde liegende Steuerelement das echte Plattform-Widget ist, sodass funktionsspezifische Plugin-Lücken seltener sind. Wenn Ihre Produktspezifikation drei oder mehr iOS-Plattform-Funktionen im ersten Quartal auflistet, hat MAUI die geringste Reibung; wenn sie drei oder mehr Android-Plattform-Funktionen auflistet, sind Flutter oder RN einfacher, weil das Plugin-Ökosystem breiter ist.

Ein praktisches Beispiel, wie die Ökosysteme auseinandergehen: KI-Integration. Das Anthropic SDK für TypeScript und Python ist First-Party; das [Anthropic SDK für Dart](https://pub.dev/) wird von der Community gepflegt; das Anthropic SDK für .NET wird von der Community gepflegt, ist aber durch [Microsoft.Extensions.AI in .NET 11](/2026/05/how-to-add-tool-calling-to-a-microsoft-extensions-ai-chat-client/) abgedeckt, das First-Party für die Abstraktionsschicht ist, wenn auch nicht für den Provider-Client. Wenn Ihre Mobile-App direkte KI-Aufrufe macht, ist RN 2026 der reibungsärmste Pfad mit deutlichem Abstand.

## Neu formulierte Empfehlung

Für eine neue Mobile-App, die heute startet:

- **Pixelgenau identische UI, 120-Hz-Animation, design-team-getriebenes Produkt, bereit, in Dart zu investieren**: Wählen Sie **Flutter 3.44**. Schnellster Kaltstart, Impeller-gestützte Render-Pipeline, GA-Linux-Desktop im Scope.
- **TypeScript-Team, npm-lastige Roadmap, Web-Geschwister auf der Roadmap**: Wählen Sie **React Native 0.82**. New Architecture ist verpflichtend und sauber, Expo ist das Standard-Scaffold, das JavaScript-Ökosystem ist das tiefste der drei.
- **Mobile ist eine Oberfläche eines breiteren .NET-11-Produkts, Microsoft im Support-Vertrag**: Wählen Sie **.NET MAUI 11**. Geteilter C#-Stack über Mobile, Desktop und Server. CoreCLR als Standard schließt die meiste der historischen Kaltstart-Lücke.

Wenn Sie eine Migration aus einer bestehenden App abwägen:

- Von Xamarin.Forms: gehen Sie zu MAUI. Der Migrationspfad ist direkt.
- Von einer React-Web-Codebasis: RN mit Expo ist der geringste Aufwand.
- Von einem unglücklichen Hybrid-Stack (Cordova, Ionic, Capacitor), bei dem die WebView der Engpass ist: Flutter oder RN beheben beide das Problem; wählen Sie nach Sprach-Passung.

## Verwandt

- [MAUI vs Avalonia vs Uno Platform: Was sollten Sie 2026 wählen?](/de/2026/05/maui-vs-avalonia-vs-uno-in-2026/) für den .NET-internen plattformübergreifenden Vergleich.
- [Die Flutter-3.44-Aufteilung der Material- und Cupertino-Pakete mit Swift Package Manager als Standard](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/) für das jüngste Flutter-Release.
- [MAUI standardmäßig auf CoreCLR für Android und iOS in .NET 11 Preview 4](/de/2026/05/maui-coreclr-default-android-ios-dotnet-11-preview-4/) für die Laufzeit-Änderung, die die Kaltstart-Zahlen von MAUI in diesem Artikel aktualisiert hat.
- [Wie man eine MAUI-App für den Microsoft Store paketiert](/de/2026/05/how-to-package-a-maui-app-for-the-microsoft-store/) für die Windows-Distributionsseite, wenn MAUI Ihre Geschwister-zum-Desktop-Wahl ist.
- [Wie man eine Xamarin.Forms-ListView zu MAUI-CollectionView migriert](/de/2026/05/how-to-migrate-a-xamarin-forms-listview-to-maui-collectionview/) für den am häufigsten nachgefragten einzelnen Migrationsschritt beim Wechsel von Xamarin zu MAUI.

## Quellen

- [Flutter-3.44-Release-Notes](https://docs.flutter.dev/release/release-notes), Flutter-Dokumentation, abgerufen am 2026-05-27.
- [React-Native-0.82-Release-Notes](https://reactnative.dev/blog), Meta Open Source.
- [.NET-MAUI-Dokumentation](https://learn.microsoft.com/dotnet/maui/), Microsoft Learn, abgerufen am 2026-05-27.
- [Expo-SDK-53-Changelog](https://docs.expo.dev/), Expo-Dokumentation.
- [Übersicht zur React-Native-New-Architecture](https://reactnative.dev/docs/the-new-architecture/landing-page), React-Native-Dokumentation.
- [Impeller-Grafik-Backend](https://docs.flutter.dev/perf/impeller), Flutter-Dokumentation.
