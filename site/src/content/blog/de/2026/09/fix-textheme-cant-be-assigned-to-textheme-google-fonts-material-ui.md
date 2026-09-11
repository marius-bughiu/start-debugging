---
title: "Lösung: The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?' mit google_fonts"
description: "Ihre App importiert material_ui, aber google_fonts 8.2.1 liefert weiterhin den TextTheme des SDK. Bauen Sie den TextTheme selbst aus GoogleFonts.roboto-Tear-offs, bis google_fonts migriert ist."
pubDate: 2026-09-11
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "material-design"
  - "google-fonts"
lang: "de"
translationOf: "2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui"
translatedBy: "claude"
translationDate: 2026-09-11
---

Sie haben zwei verschiedene Klassen namens `TextTheme` in einem Programm. Ihre App importiert `package:material_ui/material_ui.dart`, daher erwartet `ThemeData.textTheme` die `material_ui`-Kopie von `TextTheme`. `google_fonts` 8.2.1, die neueste Version, importiert weiterhin `package:flutter/material.dart`, daher liefert `GoogleFonts.robotoTextTheme()` die SDK-Kopie. Dart behandelt die beiden als nicht verwandte Typen. Die Lösung, die heute funktioniert: Rufen Sie die `...TextTheme()`-Helfer nicht mehr auf und wenden Sie die Schrift pro Stil mit einem `GoogleFonts.roboto`-Tear-off an. Dieser liefert einen `TextStyle`, einen Typ, den beide Kopien gemeinsam nutzen. `MaterialUiCompatibilityBridge` kann das nicht beheben, weil es sich um einen Kompilierzeitfehler handelt.

Alles Folgende wurde auf Flutter 3.44.8 (Dart 3.12.2) mit `material_ui` 1.2.0, `cupertino_ui` 1.0.2 und `google_fonts` 8.2.1 reproduziert und gegen den `google_fonts`-Quellcode im main-Branch von `flutter/packages` mit Stand 2026-09-11 geprüft. Derselbe Fehler tritt auch auf der Stable-Linie 3.47 und auf master auf, weil die Unstimmigkeit im Paket liegt, nicht im SDK.

## Was Analyzer und Compiler ausgeben

`flutter analyze` und die IDE liefern die Kurzform, die unsinnig wirkt, weil die beiden Typnamen identisch sind:

```text
error • The argument type 'TextTheme' can't be assigned to the parameter type 'TextTheme?'.  • lib/main.dart:13:20 • argument_type_not_assignable
```

Der Front-End-Compiler, der bei `flutter run`, `flutter build` und `flutter test` läuft, ist hilfreicher. Er nummeriert die beiden Typen und sagt Ihnen, wo jeder davon liegt:

```text
lib/main.dart:13:47: Error: The argument type 'TextTheme/*1*/' can't be assigned to the parameter type 'TextTheme/*2*/?'.
 - 'TextTheme/*1*/' is from 'package:flutter/src/material/text_theme.dart' ('/opt/homebrew/share/flutter/packages/flutter/lib/src/material/text_theme.dart').
 - 'TextTheme/*2*/' is from 'package:material_ui/src/text_theme.dart' ('/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.2.0/lib/src/text_theme.dart').
        textTheme: GoogleFonts.robotoTextTheme(),
                                              ^
```

Diese zweite Meldung ist die Diagnose. Wenn Ihre Meldung `package:flutter/src/material/...` und `package:material_ui/src/...` nennt, sind Sie hier richtig. Nennt sie zwei andere Bibliotheken, springen Sie zum Abschnitt über ähnliche Fehler am Ende.

## Warum es zwei TextTheme-Klassen gibt

Seit Flutter 3.44 werden Material und Cupertino als eigenständige Pakete `material_ui` und `cupertino_ui` ausgeliefert. `material_ui` 1.0.0, veröffentlicht am 2026-08-12, ist eine Kopie der Material-Bibliothek, die im April im SDK eingefroren wurde. Es ist kein Re-Export. `material_ui/lib/src/text_theme.dart` deklariert eine eigene `class TextTheme`, genauso wie es eigene `ThemeData`, `Theme` und `ColorScheme` deklariert.

Die Typidentität in Dart ergibt sich aus der deklarierenden Bibliothek, nicht aus dem Namen. Der `TextTheme` aus `package:flutter/src/material/text_theme.dart` und der `TextTheme` aus `package:material_ui/src/text_theme.dart` haben dieselben Felder und denselben Code, aber keiner ist ein Subtyp des anderen, also ist keiner dem anderen zuweisbar.

`google_fonts` 8.2.1 wurde am 2026-07-31 veröffentlicht, bevor `material_ui` die Version 1.0 erreichte. Seine `lib/src/google_fonts_all_parts.dart` enthält weiterhin:

```dart
// google_fonts 8.2.1, lib/src/google_fonts_all_parts.dart
import 'package:flutter/material.dart';
```

und jeder generierte `...TextTheme`-Helfer baut auf diesem Import auf:

```dart
// google_fonts 8.2.1, lib/src/google_fonts_parts/part_r.dart (trimmed)
static TextTheme robotoTextTheme([TextTheme? textTheme]) {
  textTheme ??= ThemeData.light().textTheme;
  return TextTheme(
    displayLarge: roboto(textStyle: textTheme.displayLarge),
    // ...14 more styles
  );
}
```

Sowohl der Parameter als auch der Rückgabetyp sind der SDK-`TextTheme`. Sobald Ihre Datei `material_ui` statt `package:flutter/material.dart` importiert, genau das macht `dart fix --apply --code=migrate_design_widgets`, lässt sich keine Aufrufstelle von `GoogleFonts.xxxTextTheme()` mehr kompilieren. Das Problem wird als [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067) verfolgt, eröffnet am Tag nach der Veröffentlichung von `material_ui` 1.0.0.

## Minimale Reproduktion

```yaml
# pubspec.yaml, Flutter 3.44.8
dependencies:
  flutter:
    sdk: flutter
  google_fonts: ^8.2.1
  material_ui: ^1.2.0
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: ThemeData(
        textTheme: GoogleFonts.robotoTextTheme(), // error here
      ),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

Stellen Sie den Import wieder auf `package:flutter/material.dart` um, und der Code kompiliert. Deshalb heißt es in so vielen Meldungen zu diesem Fehler "previously working".

## Warum MaterialUiCompatibilityBridge nicht hilft

Die Bridge, die `material_ui` 0.0.3 eingeführt hat, ist das Erste, was man ausprobiert, und sie war auch der erste Vorschlag eines Maintainers in #191067. Sie behebt diesen Fehler nicht und kann es auch nicht. Die Bridge ist ein Widget. Sie fügt die alten Inherited Widgets `Theme` und `Localizations` in den Baum ein, damit ein nicht migriertes Paket, das zur Laufzeit `Theme.of(context)` aufruft, etwas findet. Das deckt Abhängigkeiten ab, die Material-Zustand aus dem `BuildContext` *lesen*.

`google_fonts` liest nichts aus dem Baum. Es *liefert* einen Material-Typ des SDK aus seiner öffentlichen API, und dieser Wert gelangt als Argument in Ihren Code, das der Typprüfer ablehnt, bevor überhaupt ein Widget existiert. [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448) dokumentiert diese Grenze allgemein und führt den `google_fonts`-Fall als First-Party-Beispiel an. Wenn Sie nicht kompilieren können, spielt kein Widget-Wrapper eine Rolle.

## Lösung 1: die Schrift pro Stil mit einem Tear-off anwenden (empfohlen)

`TextStyle` ist in `package:flutter/painting.dart` deklariert, das zum SDK gehört und von beiden Material-Kopien gemeinsam genutzt wird. `GoogleFonts.roboto(...)` liefert einen `TextStyle`. Das Einzige, was Sie ersetzen müssen, ist also die fünfzehnzeilige Schleife, die der `...TextTheme`-Helfer für Sie erledigt, und die können Sie gegen den `material_ui`-`TextTheme` schreiben:

```dart
// lib/theme/google_text_theme.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

/// Applies a Google Font to every style of a material_ui [TextTheme].
///
/// Pass a tear-off such as `GoogleFonts.roboto`. Only [TextStyle] crosses
/// the package boundary, and TextStyle lives in package:flutter/painting.dart,
/// which both copies of Material share.
TextTheme withGoogleFont(
  TextTheme base,
  TextStyle Function({TextStyle? textStyle}) font,
) {
  TextStyle? apply(TextStyle? style) =>
      style == null ? null : font(textStyle: style);

  return base.copyWith(
    displayLarge: apply(base.displayLarge),
    displayMedium: apply(base.displayMedium),
    displaySmall: apply(base.displaySmall),
    headlineLarge: apply(base.headlineLarge),
    headlineMedium: apply(base.headlineMedium),
    headlineSmall: apply(base.headlineSmall),
    titleLarge: apply(base.titleLarge),
    titleMedium: apply(base.titleMedium),
    titleSmall: apply(base.titleSmall),
    bodyLarge: apply(base.bodyLarge),
    bodyMedium: apply(base.bodyMedium),
    bodySmall: apply(base.bodySmall),
    labelLarge: apply(base.labelLarge),
    labelMedium: apply(base.labelMedium),
    labelSmall: apply(base.labelSmall),
  );
}
```

Der Typ des Parameters `font` ist der Kniff, der die Aufrufstellen kurz hält. Jede generierte Schriftmethode hat die Signatur `TextStyle Function({TextStyle? textStyle, Color? color, double? fontSize, ...})`. Ein Funktionstyp mit mehr optionalen benannten Parametern ist ein Subtyp eines Funktionstyps mit weniger, daher lassen sich `GoogleFonts.roboto`, `GoogleFonts.lato` oder `GoogleFonts.pangolin` direkt übergeben.

Bauen Sie dann zuerst das Theme und ersetzen Sie dessen Text-Theme:

```dart
// lib/main.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
import 'package:google_fonts/google_fonts.dart';
import 'package:material_ui/material_ui.dart';

import 'theme/google_text_theme.dart';

ThemeData buildTheme(Brightness brightness) {
  final base = ThemeData(
    brightness: brightness,
    colorSchemeSeed: Colors.indigo,
  );
  return base.copyWith(
    textTheme: withGoogleFont(base.textTheme, GoogleFonts.roboto),
  );
}

class App extends StatelessWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const Scaffold(body: Center(child: Text('Hello'))),
    );
  }
}
```

`flutter analyze` meldet damit keine Probleme, und ein Widget-Test bestätigt, dass die Ausgabe dem entspricht, was `GoogleFonts.robotoTextTheme()` früher erzeugt hat: Jeder Stil erhält `fontFamily: 'Roboto_regular'` mit `fontFamilyFallback: ['Roboto']`, so benennt `google_fonts` eine geladene Variante.

In einer Hinsicht ist diese Version sogar besser als der Aufruf, den sie ersetzt. `robotoTextTheme()` ohne Argument startet von `ThemeData.light().textTheme`. Wenn Sie es also in `darkTheme` wiederverwendet haben, ohne `ThemeData.dark().textTheme` zu übergeben, bekamen Sie dunklen Text auf dunkler Fläche. Die Ableitung von `base.textTheme` pro Helligkeit liefert die Farben konstruktionsbedingt richtig. Im obigen Test löst das helle `bodyMedium` zu einem fast schwarzen `Color(0xFF1B1B21)` auf und das dunkle `bodyMedium` zu einem fast weißen `Color(0xFFE4E1E9)`.

Sobald die Migration upstream landet, ist das Löschen dieser Datei und die Rückkehr zu `GoogleFonts.robotoTextTheme(base.textTheme)` eine einzeilige Änderung pro Theme.

### Wenn der Schriftfamilienname erst zur Laufzeit bekannt ist

Wenn Benutzer auf einem Einstellungsbildschirm eine Schrift wählen, haben Sie vermutlich `GoogleFonts.getTextTheme(name)` aufgerufen, das dasselbe Problem hat. Kapseln Sie `getFont`, das einen `TextStyle` liefert:

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
TextTheme withGoogleFontNamed(TextTheme base, String family) =>
    withGoogleFont(
      base,
      ({TextStyle? textStyle}) =>
          GoogleFonts.getFont(family, textStyle: textStyle),
    );
```

Seien Sie sich der Kosten bewusst. `getFont` sucht die Familie in `GoogleFonts.asMap()`, einer const-Map, die jede generierte Schriftmethode referenziert, sodass der Compiler die ungenutzten nicht mehr per Tree Shaking entfernen kann. Der direkte Tear-off in Lösung 1 referenziert genau eine Schrift. Genau auf diesen Größenunterschied zielt der Einstiegspunkt `google_fonts_lite.dart` in [flutter/packages#11433](https://github.com/flutter/packages/pull/11433); er wurde am 2026-09-04 gemergt, ist aber noch nicht veröffentlicht. Verwenden Sie `getFont` nur, wenn Sie wirklich einen Namen zur Laufzeit brauchen.

## Lösung 2: einen vorhandenen alten TextTheme an der Grenze konvertieren

Wenn der SDK-`TextTheme` aus einer Quelle kommt, die Sie nicht kontrollieren, etwa aus einem gemeinsamen Theme-Paket, das Sie diese Woche nicht ändern können, konvertieren Sie ihn Feld für Feld. Importieren Sie die alte Bibliothek mit einem Präfix und einer `show`-Klausel, damit kein anderer Name in die Datei durchsickern kann:

```dart
// lib/theme/legacy_adapter.dart
// Flutter 3.44.8, Dart 3.12.2, material_ui 1.2.0, google_fonts 8.2.1
// Temporary: delete once google_fonts ships a material_ui release.
import 'package:flutter/material.dart' as legacy show TextTheme;
import 'package:material_ui/material_ui.dart';

extension LegacyTextThemeToMaterialUi on legacy.TextTheme {
  TextTheme toMaterialUi() => TextTheme(
        displayLarge: displayLarge,
        displayMedium: displayMedium,
        displaySmall: displaySmall,
        headlineLarge: headlineLarge,
        headlineMedium: headlineMedium,
        headlineSmall: headlineSmall,
        titleLarge: titleLarge,
        titleMedium: titleMedium,
        titleSmall: titleSmall,
        bodyLarge: bodyLarge,
        bodyMedium: bodyMedium,
        bodySmall: bodySmall,
        labelLarge: labelLarge,
        labelMedium: labelMedium,
        labelSmall: labelSmall,
      );
}
```

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final theme = ThemeData(
  textTheme: GoogleFonts.pangolinTextTheme().toMaterialUi(),
);
```

Das kompiliert, weil jedes Feld ein `TextStyle` ist. Es funktioniert speziell für `TextTheme`, weil die Klasse ein schlichter Behälter für fünfzehn Stile ist. Es lässt sich nicht verallgemeinern: #191448 zeigt, dass derselbe Adapter-Trick eine Ebene tiefer scheitert, bei Typen wie `FloatingActionButtonLocation`, deren Methoden andere Material-Typen als Argumente erwarten. Außerdem behält es den oben beschriebenen rein hellen Standard bei und bringt den Material-Import des SDK zurück, den die Migration entfernen sollte. Halten Sie es daher in einer einzigen Datei mit einem Kommentar und bevorzugen Sie Lösung 1.

## Lösung 3: auf die google_fonts-Migration warten

Zwei Pull Requests migrieren `google_fonts` selbst: [flutter/packages#12489](https://github.com/flutter/packages/pull/12489), eröffnet am 2026-08-17 und mit #191067 verknüpft, und [flutter/packages#12810](https://github.com/flutter/packages/pull/12810), eröffnet am 2026-09-09 als Teil des ökosystemweiten [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322). Der zweite hebt außerdem die Mindestanforderung des Pakets auf Flutter 3.44 und Dart 3.12 an. Mit Stand 2026-09-11 war keiner von beiden gemergt. Sobald einer landet, nehmen die `...TextTheme`-Helfer den `material_ui`-Typ entgegen und liefern ihn zurück, und der ursprüngliche Einzeiler kompiliert wieder. Beobachten Sie das [google_fonts-Changelog](https://pub.dev/packages/google_fonts/changelog).

Zwei Arten zu warten, die ich für eine ausgelieferte App nicht empfehlen würde:

- **Den Import nur in der Theme-Datei zurücksetzen.** Das funktioniert nicht. Das `ThemeData` in dieser Datei wird zum SDK-`ThemeData`, und Ihre `material_ui`-`MaterialApp` lehnt es mit demselben Fehler ab, nur einen Typ weiter oben. Die ganze App muss auf einer Seite stehen.
- **Eine `dependency_overrides`-Git-Referenz auf einen offenen PR-Branch.** Das kompiliert, und ein Kommentator in #191067 bietet genau das an. Aber Sie liefern dann ungeprüften Code aus einem Fork aus. Wenn Sie es trotzdem tun, pinnen Sie `ref:` auf einen Commit-SHA, nicht auf einen Branch.

Wenn Sie Lösung 1 aus irgendeinem Grund nicht nutzen können, ist die ehrliche Alternative, die `material_ui`-Migration zu verschieben, bis `google_fonts` eine neue Version ausliefert. Die Material-Bibliothek im SDK ist eingefroren, funktioniert unter 3.47 aber weiterhin.

## Stolperfalle: die Schriftstärke steht noch nicht im Theme

Etwas, das die `...TextTheme`-Helfer schon immer so gemacht haben und das Lösung 1 übernimmt: `ThemeData.textTheme` enthält zur Build-Zeit nur Farben und Familien. Größen und Schriftstärken stammen aus `Typography.englishLike` und werden erst später eingemischt, wenn `Theme.of` das Theme lokalisiert. Wenn `google_fonts` also `titleMedium` sieht, ist die Schriftstärke `null`, es wählt die Regular-Variante, und der Stil erhält `fontFamily: 'Roboto_regular'`. Zur Laufzeit löst `Theme.of(context).textTheme.titleMedium` zu `Roboto_regular` mit `FontWeight.w500` auf, was bedeutet, dass die Engine einen Stil der Stärke 500 aus der Datei der Stärke 400 rendert.

Wenn Ihre Titel und Labels die echte Medium-Datei brauchen, mischen Sie die Geometrie ein, bevor Sie die Schrift anwenden:

```dart
// Flutter 3.44.8, material_ui 1.2.0, google_fonts 8.2.1
final geometry = Typography.material2021().englishLike.merge(base.textTheme);
final textTheme = withGoogleFont(geometry, GoogleFonts.roboto);
// titleMedium -> fontFamily 'Roboto_500', fontWeight w500
```

Ich habe beide Ergebnisse in einem Widget-Test überprüft. Der Kompromiss: Die englischartigen Größen sind jetzt fest eingebaut. Wenn Sie also Chinesisch, Japanisch oder Koreanisch ausliefern, wählen Sie die Geometrie stattdessen pro Locale (`Typography.material2021().tall` oder `.dense`). Aus demselben Grund ist `TextTheme.apply(fontFamily: GoogleFonts.roboto().fontFamily)` eine Falle: Es setzt `'Roboto_regular'` auf jeden Stil, unabhängig von dessen Schriftstärke.

## Ähnliche Fehler, die nicht dieser Bug sind

- **`The argument type 'TextTheme' can't be assigned to the parameter type 'CupertinoTextThemeData'`.** Sie haben ein Material-Text-Theme an `CupertinoThemeData.textTheme` übergeben. Das sind absichtlich verschiedene Klassen, bereits 2022 als [material-foundation/flutter-packages#227](https://github.com/material-foundation/flutter-packages/issues/227) gemeldet. Für Cupertino gibt es keinen `...TextTheme`-Helfer; bauen Sie selbst ein `CupertinoTextThemeData` und übergeben Sie `GoogleFonts.lato()`-Stilobjekte an dessen `textStyle` und verwandte Parameter.
- **Dieselbe Meldung, aber der Compiler nennt eine Ihrer eigenen Dateien.** Eine Klasse namens `TextTheme` in Ihrem eigenen Code oder in einer generierten Design-Token-Datei verdeckt die Material-Klasse. Die nummerierte Compiler-Ausgabe sagt Ihnen, welche Datei Sie umbenennen müssen.
- **Dieselbe Meldung für `ColorScheme`.** Das war `dynamic_color`, das den SDK-`ColorScheme` aus `DynamicColorBuilder` lieferte. Das ist behoben: `dynamic_color` 2.1.0 hängt von `material_ui` ab, wie der Maintainer in [material-foundation/flutter-packages#698](https://github.com/material-foundation/flutter-packages/issues/698) bestätigt hat.
- **Es kompiliert, aber die Widgets eines Pakets stürzen mit "Could not find an ancestor of type Theme" ab.** Das ist die Laufzeithälfte derselben Aufspaltung, und genau diesen Fall behebt `MaterialUiCompatibilityBridge`.

## Verwandte Artikel

- Die vollständige Migration, aus der dieser Fehler hervorgeht, einschließlich der Frage, wann Sie die Compatibility Bridge brauchen, finden Sie unter [Flutter-Material- und Cupertino-Importe auf material_ui und cupertino_ui migrieren](/de/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Zum Hintergrund, warum Material das SDK überhaupt verlassen hat, lesen Sie [Flutter 3.44 trennt Material und Cupertino vom SDK](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Wenn Sie die Import-Umschreibung über ein ganzes Monorepo laufen lassen haben, erklärt [dart fix über ein ganzes Repository ausführen](/de/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/), wie Sie sie Paket für Paket eingrenzen und prüfen.
- Derselbe `ThemeData`-first-Ansatz aus Lösung 1 gilt auch für Farben: [die Akzentfarbe mit einem Material 3 ColorScheme festlegen](/de/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/).
- Für einen Fehlschlag bei der Ancestor-Suche aus Ihrem eigenen Code statt aus einer Abhängigkeit lesen Sie [Lösung für "No Material widget found" in Flutter](/de/2026/08/fix-no-material-widget-found-in-flutter/).

## Quellen

- [flutter/flutter#191067](https://github.com/flutter/flutter/issues/191067), `TextTheme`-Konflikt zwischen material_ui und `google_fonts`
- [flutter/flutter#191448](https://github.com/flutter/flutter/issues/191448), `MaterialUiCompatibilityBridge` kann keine Kopplung über API-Signaturen abdecken
- [flutter/flutter#191322](https://github.com/flutter/flutter/issues/191322), Migration der First-Party-Pakete auf `material_ui` und `cupertino_ui`
- [flutter/packages#12489](https://github.com/flutter/packages/pull/12489) und [flutter/packages#12810](https://github.com/flutter/packages/pull/12810), die offenen Pull Requests zur Migration von `google_fonts`
- [flutter/packages#11433](https://github.com/flutter/packages/pull/11433), der Einstiegspunkt `google_fonts_lite.dart`
- [google_fonts auf pub.dev](https://pub.dev/packages/google_fonts), Version 8.2.1, und sein [Quellcode](https://github.com/flutter/packages/tree/main/packages/google_fonts)
- [material_ui auf pub.dev](https://pub.dev/packages/material_ui), Version 1.2.0, und sein [Changelog](https://pub.dev/packages/material_ui/changelog)
- [argument_type_not_assignable](https://dart.dev/diagnostics/argument_type_not_assignable), Dart-Diagnosen
