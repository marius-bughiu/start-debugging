---
title: "So setzen Sie die Akzentfarbe in einer Flutter-App mit Material 3 ColorScheme"
description: "Der korrekte Weg in 2026, eine Akzentfarbe in Flutter mit Material 3 zu setzen: ColorScheme.fromSeed, das Kürzel colorSchemeSeed, die sieben DynamicSchemeVariant-Optionen, Dark Mode, dynamic_color auf Android 12+ und das Harmonisieren von Markenfarben. Getestet mit Flutter 3.27.1 und Dart 3.11."
pubDate: 2026-05-06
template: how-to
tags:
  - "flutter"
  - "dart"
  - "material-3"
  - "theming"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme"
translatedBy: "claude"
translationDate: 2026-05-06
---

Kurze Antwort: Material 3 hat keine "Akzentfarbe" mehr. Der nächstliegende einzelne Regler ist die Seed-Farbe, die Sie an `ColorScheme.fromSeed` übergeben. Verwenden Sie `ThemeData(colorSchemeSeed: Colors.deepPurple)` für den einfachsten Fall, oder `ColorScheme.fromSeed(seedColor: ..., brightness: Brightness.light)`, wenn Sie Variante, Kontraststufe oder die Paarung von hellem und dunklem Schema steuern möchten. Aus dieser einen Seed-Farbe leitet das Framework die vollständige M3-Palette ab: `primary`, `onPrimary`, `secondary`, `tertiary`, `surface`, `surfaceContainer` und den Rest. Verifiziert mit Flutter 3.27.1, Dart 3.11.

Diese Anleitung zeigt den richtigen Weg in 2026, die Dinge, die richtig aussehen, aber im Dark Mode oder auf Android 12+ brechen, und wie Sie eine bestehende Markenfarbe behalten, ohne das M3-Tonal-System aufzugeben.

## Warum die "Akzentfarbe" in M3 verschwunden ist

Material 2 hatte `primaryColor` und `accentColor` als zwei mehr oder weniger unabhängige Regler. Sie haben sie gesetzt, und Widgets wie `FloatingActionButton`, `Switch` oder der Cursor des `TextField` haben sich für eines davon entschieden. In Material 3 ist dieses Vokabular weg. Die Spezifikation ersetzt beide durch ein System von Farbrollen, die aus einer einzigen Seed-Farbe berechnet werden:

- `primary`, `onPrimary`, `primaryContainer`, `onPrimaryContainer`
- `secondary`, `onSecondary`, `secondaryContainer`, `onSecondaryContainer`
- `tertiary`, `onTertiary`, `tertiaryContainer`, `onTertiaryContainer`
- `surface`, `onSurface`, `surfaceContainerLowest` ... `surfaceContainerHighest`
- `error`, `onError`, plus Varianten
- `outline`, `outlineVariant`, `inverseSurface`, `inversePrimary`

Was in M2 Ihr "Accent" war, wird in M3 meistens auf `primary` abgebildet, manchmal auf `tertiary`, falls Sie Accent für Highlights verwendet haben. Die [Material-3-Dokumentation zu Farbrollen](https://m3.material.io/styles/color/roles) ist die kanonische Quelle dafür, welche Rolle auf welche Oberfläche gehört.

Die praktische Konsequenz: Wenn Sie eine alte StackOverflow-Antwort finden, die sagt "setzen Sie `ThemeData.accentColor`", kompiliert diese Eigenschaft in einigen schmalen Pfaden noch, aber kein Material-3-Widget liest sie. Sie verbringen einen Nachmittag damit, sich zu fragen, warum sich nichts ändert. Sie ist veraltet und für M3-Widgets effektiv ein No-op.

## Das minimale, korrekte Muster

Material 3 ist in Flutter 3.16 und neuer standardmäßig aktiviert. Sie müssen `useMaterial3: true` nicht mehr setzen. Die einfachste, idiomatische Akzentfarbe für eine neue App:

```dart
// Flutter 3.27.1, Dart 3.11
import 'package:flutter/material.dart';

void main() => runApp(const MyApp());

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Demo',
      theme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.light,
      ),
      darkTheme: ThemeData(
        colorSchemeSeed: Colors.deepPurple,
        brightness: Brightness.dark,
      ),
      themeMode: ThemeMode.system,
      home: const Scaffold(),
    );
  }
}
```

`colorSchemeSeed` ist eine Kurzschreibweise innerhalb von `ThemeData`, die äquivalent zu Folgendem ist:

```dart
// What colorSchemeSeed expands to internally
ThemeData(
  colorScheme: ColorScheme.fromSeed(
    seedColor: Colors.deepPurple,
    brightness: Brightness.light,
  ),
);
```

Wenn Sie nur die Seed-Farbe und die Helligkeit benötigen, bevorzugen Sie `colorSchemeSeed`. Greifen Sie direkt zu `ColorScheme.fromSeed`, wenn Sie die Variante, die Kontraststufe oder ein bis zwei spezifische Rollen feinjustieren müssen.

## Eine DynamicSchemeVariant auswählen

Seit Flutter 3.22 akzeptiert der Konstruktor `ColorScheme.fromSeed` einen Parameter `dynamicSchemeVariant`. Dieser wählt aus, welcher Algorithmus der Material Color Utilities die Palette ableitet. Die Optionen, in der Reihenfolge, wie aggressiv sie Ihre Seed-Farbe sichtbar erhalten:

- `DynamicSchemeVariant.tonalSpot` (Standard): das Standardrezept von Material 3. Mittlere Sättigung, ausgewogen. Die Seed-Farbe wird zur Quelle für `primary`, während `secondary` und `tertiary` aus benachbarten Farbtönen gezogen werden.
- `DynamicSchemeVariant.fidelity`: hält `primary` sehr nah an der exakten Seed-Farbe. Verwenden Sie dies, wenn die Marke möchte, dass die Seed-Farbe wörtlich gerendert wird.
- `DynamicSchemeVariant.content`: ähnlich `fidelity`, aber für aus Inhalten abgeleitete Paletten konzipiert (z. B. die dominante Farbe eines Hero-Bildes).
- `DynamicSchemeVariant.monochrome`: Graustufen. `primary`, `secondary`, `tertiary` sind alle neutral.
- `DynamicSchemeVariant.neutral`: niedrige Chroma. Die Seed-Farbe färbt das Ergebnis kaum.
- `DynamicSchemeVariant.vibrant`: erhöht Chroma. Gut für verspielte oder medienlastige Apps.
- `DynamicSchemeVariant.expressive`: rotiert `secondary` und `tertiary` weiter um den Farbkreis. Visuell unruhiger.
- `DynamicSchemeVariant.rainbow`, `DynamicSchemeVariant.fruitSalad`: extreme Varianten, eher von Material-You-Launchern als von typischen Apps verwendet.

Ein konkretes Beispiel. Wenn Ihre Markenfarbe genau `#7B1FA2` ist und das Marketing-Team dieses spezifische Lila bereits genehmigt hat, wird `tonalSpot` es entsättigen. `fidelity` bewahrt es:

```dart
// Flutter 3.27.1
final brand = const Color(0xFF7B1FA2);

final lightScheme = ColorScheme.fromSeed(
  seedColor: brand,
  brightness: Brightness.light,
  dynamicSchemeVariant: DynamicSchemeVariant.fidelity,
);
```

Wählen Sie die Variante einmal aus und wenden Sie sie dann sowohl auf helle als auch auf dunkle Helligkeit an, damit das Aussehen über die Themes hinweg konsistent bleibt.

## Helle und dunkle Schemata korrekt paaren

Zwei `ColorScheme`-Instanzen aus derselben Seed-Farbe zu bauen (eine pro `Brightness`) ist der richtige Ansatz. Das Framework regeneriert die Tonal-Palette pro Helligkeit, damit die Kontrastverhältnisse oberhalb der M3-Mindestwerte bleiben. Invertieren Sie die Farben nicht selbst.

```dart
// Flutter 3.27.1
final seed = Colors.indigo;

final light = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.light,
);
final dark = ColorScheme.fromSeed(
  seedColor: seed,
  brightness: Brightness.dark,
);

return MaterialApp(
  theme: ThemeData(colorScheme: light),
  darkTheme: ThemeData(colorScheme: dark),
  themeMode: ThemeMode.system,
  home: const Home(),
);
```

Ein häufiger Bug hier: das helle Theme mit `Brightness.light` zu bauen, aber zu vergessen, `Brightness.dark` an das dunkle Theme zu übergeben. Das dunkle Schema verwendet dann die hellen Töne wieder, die auf schwarzer Oberfläche ausgewaschen aussehen und im Fließtext den WCAG-AA-Kontrast nicht erfüllen. Übergeben Sie immer beide.

Wenn Sie zusätzliche Kontrolle über den Kontrast benötigen, akzeptiert `ColorScheme.fromSeed` ein `contrastLevel` von `-1.0` (geringerer Kontrast) bis `1.0` (höherer Kontrast). Der Standardwert `0.0` entspricht der M3-Spezifikation. Höherer Kontrast ist nützlich, wenn Ihre App Enterprise-Audits zur Barrierefreiheit erfüllen muss.

## Eine Markenfarbe verwenden und die M3-Generierung behalten

Manchmal ist die Markenfarbe nicht verhandelbar, aber der Rest der Palette steht zur Disposition. Verwenden Sie `ColorScheme.fromSeed` und überschreiben Sie eine einzelne Rolle:

```dart
// Flutter 3.27.1
final scheme = ColorScheme.fromSeed(
  seedColor: Colors.indigo,
  brightness: Brightness.light,
).copyWith(
  primary: const Color(0xFF1E3A8A), // exact brand
);
```

Das hält alles andere (`secondary`, `tertiary`, `surface` usw.) in der algorithmisch abgeleiteten Palette und fixiert nur `primary`. Überschreiben Sie nicht mehr als ein oder zwei Rollen. Der ganze Sinn des M3-Systems ist, dass die Rollen gegenseitig konsistent sind. Vier Farben zu fixieren, bricht meist irgendwo den Kontrast.

Eine sicherere Alternative, wenn Sie mehrere obligatorische Markenfarben haben, ist sie gegen die Seed-Farbe zu harmonisieren, statt Rollen zu ersetzen. Die Material Color Utilities stellen `MaterialDynamicColors.harmonize` bereit, verfügbar über das Paket [`dynamic_color`](https://pub.dev/packages/dynamic_color):

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';

final brandError = const Color(0xFFD32F2F);
final harmonized = brandError.harmonizeWith(scheme.primary);
```

`harmonizeWith` verschiebt den Markenfarbton leicht in Richtung der Seed-Farbe, damit beide visuell koexistieren, ohne die Markenidentität zu verlieren. Das ist das richtige Werkzeug, wenn das Designsystem ein exaktes Rot vorschreibt, etwa für Fehler- oder destruktive Buttons.

## Material You: dynamische Farbe auf Android 12+

Wenn Sie auf Android 12 oder höher ausliefern, kann das System Ihnen ein vom Hintergrundbild abgeleitetes `ColorScheme` übergeben. Verdrahten Sie es mit dem `DynamicColorBuilder` von `dynamic_color`. Auf iOS, Web, Desktop oder älterem Android gibt der Builder `null` zurück, und Sie fallen auf Ihre Seed-Farbe zurück.

```dart
// Flutter 3.27.1, dynamic_color 1.7.0
import 'package:dynamic_color/dynamic_color.dart';
import 'package:flutter/material.dart';

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return DynamicColorBuilder(
      builder: (lightDynamic, darkDynamic) {
        final ColorScheme light = lightDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.light,
            );
        final ColorScheme dark = darkDynamic ??
            ColorScheme.fromSeed(
              seedColor: Colors.indigo,
              brightness: Brightness.dark,
            );

        return MaterialApp(
          theme: ThemeData(colorScheme: light),
          darkTheme: ThemeData(colorScheme: dark),
          themeMode: ThemeMode.system,
          home: const Home(),
        );
      },
    );
  }
}
```

Eine subtile Falle: `lightDynamic` und `darkDynamic` sind nicht immer vom selben Hintergrundbild abgeleitet. Auf einigen Pixel-Geräten kommt das dunkle Schema aus einer anderen Quelle. Behandeln Sie sie als unabhängig. Wenn Sie ein Markenrot mit dem Schema harmonisieren müssen, mit dem die Nutzerin endet, machen Sie `brandRed.harmonizeWith(scheme.primary)` pro Build, nicht einmal beim Start.

## Die Farbe in Ihren Widgets lesen

Sobald das Schema gesetzt ist, greifen Sie über `Theme.of(context).colorScheme` auf die Rollen zu. Hardcoden Sie keine Hex-Werte in Widgets und referenzieren Sie nicht die M2-Getter `primaryColor` / `accentColor`.

```dart
// Flutter 3.27.1
class CallToAction extends StatelessWidget {
  const CallToAction({super.key, required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return FilledButton(
      style: FilledButton.styleFrom(
        backgroundColor: scheme.primary,
        foregroundColor: scheme.onPrimary,
      ),
      onPressed: () {},
      child: Text(label),
    );
  }
}
```

`FilledButton` verwendet `primary` und `onPrimary` bereits standardmäßig, daher ist das explizite `styleFrom` nur dazu da, die Rollennamen zu zeigen. Die meisten M3-Widgets haben sinnvolle Defaults, daher ist die einfachste Antwort auf "wie style ich meine Buttons mit der Akzentfarbe" "wählen Sie das richtige Widget", nicht "überschreiben Sie das style".

Eine schnelle Zuordnung für den M2-zu-M3-Übergang:

| M2-Idee | M3-Rolle |
| --- | --- |
| `accentColor` als Highlight bei Toggles, Slidern, FAB | `primary` |
| `accentColor` als weicher Chip-Hintergrund | `secondaryContainer` mit `onSecondaryContainer`-Text |
| `accentColor` als "drittes" Highlight | `tertiary` |
| `primaryColor` in der App Bar | `primary` (oder `surface` für die M3-Standard-App-Bar) |
| `cardColor` | `surfaceContainer` |
| `dividerColor` | `outlineVariant` |
| `disabledColor` | `onSurface` mit 38% Deckkraft |

## Dinge, die richtig aussehen, aber falsch sind

Fünf Fehler, die ich wöchentlich sehe:

1. **`useMaterial3: false`** in einer neuen App zu setzen, um "das Stylen einfacher zu machen", und sich dann zu fragen, warum `colorSchemeSeed` immer noch M3-Töne erzeugt. `colorSchemeSeed` ist M3-only. Wer sich gegen M3 entscheidet, entscheidet sich auch gegen Seed-basierte Farbschemata. Bleiben Sie bei M3, sofern Sie keine harte Anforderung haben.
2. **Ein einziges `ColorScheme` zu bauen und für beide Themes wiederzuverwenden.** Das helle Schema auf schwarzem Hintergrund verfehlt den Kontrast. Bauen Sie zwei aus derselben Seed-Farbe.
3. **`ColorScheme.fromSeed` innerhalb von `build()`** eines Widgets weit oben im Baum aufzurufen. Das führt die Material Color Utilities bei jedem Rebuild aus, was nicht katastrophal, aber verschwenderisch ist. Bauen Sie das Schema einmal in `main` oder im `State` Ihrer `App` und reichen Sie es nach unten.
4. **`Colors.deepPurple.shade300` als Seed-Farbe verwenden.** Seed-Farben funktionieren am besten, wenn sie gesättigt und klar farbtonig sind. Eine ausgewaschene Variante gibt eine ausgewaschene Palette. Übergeben Sie die Basisfarbe (z. B. `Colors.deepPurple`, was die 500er-Variante ist) und lassen Sie `tonalSpot` die Entsättigungsarbeit für die helleren Rollen erledigen.
5. **Eine Hex-Farbe für den FAB oder den Daumen eines ausgewählten `Switch` hartzucodieren**, weil "die Akzentfarbe weg ist". Die Rolle ist `primary`. Wenn `primary` auf dieser Oberfläche nicht richtig aussieht, ist Ihre Variante falsch, nicht Ihr Widget.

## Eine alte App aufräumen: eine 5-Minuten-Migration

Wenn die App bereits irgendwo `accentColor` oder `primarySwatch` enthält, ist die billigste korrekte Migration:

1. `accentColor` und `primarySwatch` aus `ThemeData(...)` entfernen.
2. `colorSchemeSeed: <Ihr altes primary>` hinzufügen.
3. `useMaterial3: false` entfernen, falls vorhanden; M3 ist der Standard in 3.16+.
4. Im Projekt nach `Theme.of(context).accentColor`, `theme.primaryColor` und `theme.colorScheme.background` suchen (in neueren Flutters in `surface` umbenannt) und jedes durch die richtige M3-Rolle aus der Tabelle oben ersetzen.
5. `flutter analyze` ausführen. Alles, was noch vor einer veralteten Theme-Eigenschaft warnt, bekommt dieselbe Behandlung.

Die größte sichtbare Änderung danach ist, dass der Standardhintergrund der `AppBar` jetzt `surface` ist, nicht `primary`. Wenn Sie die farbige App Bar zurück möchten, setzen Sie `appBarTheme: AppBarTheme(backgroundColor: scheme.primary, foregroundColor: scheme.onPrimary)`. Viele Teams stellen im Nachhinein fest, dass sie die M3-`surface`-App-Bar tatsächlich bevorzugten, sobald sie sich daran gewöhnt hatten.

## Verwandte Lektüre

Wenn Sie gleichzeitig eine größere Flutter-App migrieren, decken die [Schritt-für-Schritt-Migration von GetX zu Riverpod](/de/2026/05/how-to-migrate-a-flutter-app-from-getx-to-riverpod/) und der [Leitfaden zum Profilieren von Jank mit DevTools](/de/2026/05/how-to-profile-jank-in-a-flutter-app-with-devtools/) zwei Dinge ab, die bei einer Theme-Auffrischung häufig auftauchen: State-Management-Churn und überraschende Rebuild-Stürme. Für native Brücken (etwa um ein System-Theme-Signal verfügbar zu machen, das Sie aus Flutter allein nicht bekommen) siehe [plattformspezifischen Code ohne Plugins hinzufügen](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/). Und falls Ihre CI-Matrix während der Migration alte und neue Flutter-SDKs überspannt, hält der Beitrag zum [Targeting mehrerer Flutter-Versionen aus einer einzigen CI-Pipeline](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) beide Branches grün.

## Quellen

- Flutter API: [`ColorScheme.fromSeed`](https://api.flutter.dev/flutter/material/ColorScheme/ColorScheme.fromSeed.html)
- Flutter API: [`ThemeData.colorSchemeSeed`](https://api.flutter.dev/flutter/material/ThemeData/colorSchemeSeed.html)
- Flutter API: [`DynamicSchemeVariant`](https://api.flutter.dev/flutter/material/DynamicSchemeVariant.html)
- Material-3-Spezifikation: [Farbrollen](https://m3.material.io/styles/color/roles)
- pub.dev: [`dynamic_color`](https://pub.dev/packages/dynamic_color) für Material You und Harmonisierung
