---
title: "Eine Flutter-App von Color.withOpacity auf Color.withValues migrieren (Flutter 3.27+)"
description: "Ersetzen Sie die veralteten Color.withOpacity, opacity, value, red, green, blue und alpha durch withValues, .a/.r/.g/.b und toARGB32. Was dart fix für Sie umschreibt, die vier Getter, die es stehen lässt, warum exakte Farbvergleiche in Tests und Map<Color, T>-Zugriffe nach dem Wechsel brechen und wie withOpacity unbemerkt Display P3 verwirft. Gemessen mit Flutter 3.44.8 und Dart 3.12.2."
pubDate: 2026-10-23
updatedDate: 2026-10-23
template: migration
tags:
  - "migration"
  - "flutter"
  - "dart"
  - "colors"
lang: "de"
translationOf: "2026/10/migrate-a-flutter-app-from-color-withopacity-to-color-withvalues"
translatedBy: "claude"
translationDate: 2026-10-23
---

`Color.withOpacity` ist seit Flutter 3.27.0 veraltet, als `dart:ui` begann, Farbkomponenten als Gleitkommawerte mit einem `ColorSpace` zu speichern. Der Ersatz ist `color.withValues(alpha: x)`, und seine Geschwister sind `.a` für `.opacity`, `toARGB32()` für `.value` und `.r`/`.g`/`.b` (Doubles von 0.0 bis 1.0) für `.red`/`.green`/`.blue` (Ints von 0 bis 255). `dart fix --apply` schreibt `withOpacity`, `opacity` und `value` für Sie um, überlässt `red`, `green`, `blue` und `alpha` aber Ihnen. Der Wechsel ist nicht rein kosmetisch: `withOpacity(0.5)` speichert ein Alpha von `0.50196` (128/255), während `withValues(alpha: 0.5)` exakt `0.5` speichert, sodass diese beiden Farben nicht mehr `==` sind. Jeder Test mit `expect(color, const Color(0x80000000))` und jede `Map<Color, T>`, die nach dem alten Wert indiziert ist, bricht nach der Migration. Eine typische App braucht 30 Minuten bis eine Stunde, größtenteils für die Tests. Alles Folgende wurde mit Flutter 3.44.8 (Dart 3.12.2) ausgeführt.

## Warum jetzt von withOpacity wegmigrieren

- **Präzision.** `withOpacity` quantisiert Alpha auf 8 Bit: Der Rumpf lautet wörtlich `withAlpha((255.0 * opacity).round())`. `withValues` behält den übergebenen Double. Bei Animationen, die in vielen kleinen Schritten ausblenden, ist das der Unterschied zwischen 256 möglichen Alpha-Stufen und stufenlosen Werten.
- **Farbräume.** `withValues` bewahrt den `colorSpace` des Empfängers. `withOpacity` und `withAlpha` laufen über `Color.fromARGB`, das immer eine sRGB-Farbe erzeugt, sodass eine Display-P3-Farbe als sRGB markiert zurückkommt. Mehr dazu bei den Stolperfallen.
- **Aus der Veraltung wird ein Entfernen.** Der Flutter-Migrationsleitfaden beschreibt das Entfernen der 8-Bit-API als "Phase 2", die noch nicht umgesetzt ist. Sobald sie landet, wird jedes verbliebene `withOpacity`, `.value` und `.red` zu einem Kompilierfehler statt zu einer `info`-Diagnose.
- **Rauschen.** Eine große App kann allein durch diese Getter Hunderte `deprecated_member_use`-Treffer haben, die die Veraltungen verdecken, auf die Sie tatsächlich reagieren müssen.

## Was sich in der App ändert

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| Tests mit exaktem `Color`-Vergleich | `withValues(alpha: 0.5) != const Color(0x80000000)`; verwenden Sie `isSameColorAs` | hoch |
| `Map<Color, T>`- / `Set<Color>`-Schlüssel | Alte und neue Farben haben unterschiedliche Hashes; Zugriffe liefern `null` | hoch |
| Arithmetik mit `.red`/`.green`/`.blue` | Die Ersatzwerte sind Doubles von 0,0 bis 1,0; ganzzahlige Schwellen wie `< 128` brechen unbemerkt | hoch |
| `withOpacity(x)`-Aufrufstellen | Wird zu `withValues(alpha: x)`, von `dart fix` angewendet | niedrig |
| `.value` / `.opacity` | Werden zu `toARGB32()` / `.a`, von `dart fix` angewendet | niedrig |
| Klassen mit `implements Color` | Müssen `a`, `r`, `g`, `b`, `colorSpace`, `toARGB32`, `withValues` implementieren | mittel |

## Checkliste vor dem Start

- Flutter 3.27.0 oder neuer, idealerweise die aktuelle stabile Version. `CupertinoDynamicColor.withValues` und die zugehörige `dart fix`-Regel kamen später (die Veraltungsmeldungen sagen "deprecated after v3.33.0-1.0.pre"), daher sollten Cupertino-lastige Apps auf 3.35 oder neuer sein.
- Ein sauberes `git status`, damit Sie die Ausgabe von `dart fix` als einen einzigen Diff prüfen können.
- Eine bestandene Testsuite vor dem Start. Fehler bei Farbvergleichen sind das wichtigste Signal, dass sich etwas geändert hat, und sie sollten die einzigen Fehler sein.
- Eine Liste der Stellen, an denen Farben persistiert werden (Shared Preferences, JSON, eine Datenbank). Dort sind die Ganzzahl-Konvertierungen relevant.

## Migrationsschritte

1. **Die veralteten Member erfassen.** Führen Sie `flutter analyze` aus und filtern Sie nach den Farb-Gettern, damit Sie wissen, was `dart fix` nicht anfasst:

    ```bash
    # Flutter 3.44.8
    flutter analyze 2>&1 | grep deprecated_member_use | grep -E "'(withOpacity|opacity|value|red|green|blue|alpha)'"
    ```

    Für diese Beispieldatei:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (before)
    import 'package:flutter/material.dart';

    Color scrim(Color base) => base.withOpacity(0.54);

    bool isDark(Color c) => (c.red * 0.299 + c.green * 0.587 + c.blue * 0.114) < 128;

    int serialize(Color c) => c.value;

    double fade(Color c) => c.opacity;

    int alphaByte(Color c) => c.alpha;
    ```

    meldet der Analyzer sieben `deprecated_member_use`-Infos, eine pro Member, jeweils mit dem vorgeschlagenen Ersatz, etwa `'red' is deprecated and shouldn't be used. Use (*.r * 255.0).round().clamp(0, 255).`

    Prüfen: Sie haben eine Anzahl. Behalten Sie sie, Sie vergleichen sie in Schritt 3.

2. **Die datengesteuerten Korrekturen anwenden.** Flutter liefert `fix_data`-Regeln für genau drei `Color`-Member: `withOpacity` zu `withValues(alpha: ...)`, `opacity` zu `a` und `value` zu `toARGB32()`. Erst als Vorschau, dann anwenden:

    ```bash
    # Flutter 3.44.8
    dart fix --dry-run .
    dart fix --apply .
    ```

    Der Probelauf meldet für das Beispiel `deprecated_member_use - 3 fixes`, und der Diff lautet:

    ```diff
    -Color scrim(Color base) => base.withOpacity(0.54);
    +Color scrim(Color base) => base.withValues(alpha: 0.54);
    -int serialize(Color c) => c.value;
    +int serialize(Color c) => c.toARGB32();
    -double fade(Color c) => c.opacity;
    +double fade(Color c) => c.a;
    ```

    Dieselben Regeln gibt es für `CupertinoDynamicColor.withOpacity`. In einem Monorepo führen Sie den Befehl einmal im Wurzelverzeichnis aus; der Analyzer erfasst jede verschachtelte `pubspec.yaml`.

    Prüfen: `flutter analyze` meldet jetzt vier Farb-Veraltungen statt sieben, alle zu `red`, `green`, `blue` oder `alpha`.

3. **Die Ganzzahl-Getter von Hand umschreiben und die Skala beibehalten.** Hier entstehen die echten Fehler. `.red` liefert einen `int` von 0 bis 255; `.r` liefert einen `double` von 0.0 bis 1.0. Das eine gegen das andere zu tauschen kompiliert problemlos, weil beide `num` sind, und danach ist der Vergleich dauerhaft falsch:

    ```dart
    // Flutter 3.44.8: compiles, always returns true
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 128;
    ```

    Verschieben Sie entweder den ganzen Ausdruck auf die Skala von 0 bis 1, oder konvertieren Sie explizit dort, wo Sie wirklich Bytes brauchen:

    ```dart
    // Flutter 3.44.8, Dart 3.12.2 (after)
    bool isDark(Color c) => (c.r * 0.299 + c.g * 0.587 + c.b * 0.114) < 0.5;

    // Or, better for contrast decisions, the built-in WCAG luminance:
    bool isDarkWcag(Color c) => c.computeLuminance() < 0.179;

    extension ColorBytes on Color {
      int get alpha8 => (a * 255.0).round().clamp(0, 255);
      int get red8 => (r * 255.0).round().clamp(0, 255);
      int get green8 => (g * 255.0).round().clamp(0, 255);
      int get blue8 => (b * 255.0).round().clamp(0, 255);
    }

    int alphaByte(Color c) => c.alpha8;
    ```

    Die Extension verwendet exakt die Formel, die die Veraltungsmeldung vorschlägt, und sie stimmt mit `toARGB32()` überein, das intern pro Kanal `(x * 255.0).round().clamp(0, 255)` ausführt. Für `Colors.blue[500]` (`0xFF2196F3`) ist `.red` gleich `33` und `.r` gleich `0.12941176470588237`.

    Prüfen: `flutter analyze` meldet keine Farb-Veraltungen mehr, und `grep -rnE '\.(red|green|blue)\b' lib/` zeigt nichts, was einen Double im Stil von `.r` mit einem Literal in Byte-Größe vergleicht.

4. **Exakte Farbvergleiche in Tests korrigieren.** Führen Sie die Suite aus. Jeder Test, der eine migrierte Farbe mit einem Ganzzahl-Literal vergleicht, schlägt jetzt fehl, weil das Literal durch den 8-Bit-Konstruktor läuft und Alpha 128/255 erhält:

    ```dart
    // Flutter 3.44.8, flutter_test
    import 'package:flutter/material.dart';
    import 'package:flutter_test/flutter_test.dart';

    Color scrim() => Colors.black.withValues(alpha: 0.5);

    void main() {
      // Fails after the migration
      test('exact', () => expect(scrim(), const Color(0x80000000)));
      // Passes
      test('same color', () => expect(scrim(), isSameColorAs(const Color(0x80000000))));
    }
    ```

    Der fehlschlagende Test gibt aus:

    ```text
    Expected: Color:<Color(alpha: 0.5020, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
      Actual: Color:<Color(alpha: 0.5000, red: 0.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)>
    ```

    `isSameColorAs` vergleicht jede Komponente mit einem Standardschwellwert von `colorEpsilon = 0.004` (etwa ein 8-Bit-Schritt) und verlangt denselben `colorSpace`. Verwenden Sie es überall, wo ein Test Farben vergleicht, die per Arithmetik entstanden sind. Wenn Sie die Erwartung lieber exakt halten möchten, schreiben Sie sie mit demselben Konstruktor, den der Code verwendet: `Colors.black.withValues(alpha: 0.5)`.

    Prüfen: `flutter test` ist grün, und die einzigen Teständerungen sind Matcher-Wechsel, keine neuen Erwartungswerte.

5. **Nach Farben indizierte Collections und persistierte Werte prüfen.** Suchen Sie nach `Map<Color`, `Set<Color>`, `switch` auf Farben und allem, was `toARGB32()` speichert. Beide Richtungen des Roundtrips sind wichtig, und der nächste Abschnitt zeigt das gemessene Verhalten.

    Prüfen: Ein Unit-Test, der eine vom Benutzer gewählte Farbe speichert und neu lädt, prüft mit `isSameColorAs`, nicht mit `==`.

## Verifizierung

Führen Sie nach den obigen Schritten Folgendes aus:

```bash
# Flutter 3.44.8
flutter analyze
flutter test
dart fix --dry-run .
```

`flutter analyze` sollte kein `deprecated_member_use` mehr zu `Color`-Membern zeigen, `flutter test` sollte grün sein, und `dart fix --dry-run` sollte für die Farbregeln `Nothing to fix!` ausgeben. Starten Sie dann die App und prüfen Sie die Bildschirme mit transparenten Überlagerungen (Scrims, deaktivierte Schaltflächen, Ripple- und Hover-Farben aus Ihrem Theme). Visuell sollte sich nichts verschieben: Für jedes Alpha, das Sie an `withOpacity` übergeben haben, ist `toARGB32()` der alten und der neuen Farbe identisch (bei 0.5 jeweils `0x80000000`), sodass alles, was auf 8 Bit quantisiert wird, gleich ausfällt.

## Zurückrollen

Die Migration ist umkehrbar: `withOpacity`, `.opacity`, `.value` und die Ganzzahl-Getter existieren in 3.44.8 weiterhin und behalten ihre alte Semantik, sodass ein `git revert` des Migrations-Commits das exakte Verhalten wiederherstellt. Nicht zurückrollen lässt sich auf ein künftiges Flutter-Release, in dem Phase 2 sie entfernt hat. Wenn Sie vorerst bei der veralteten API bleiben müssen, unterdrücken Sie die Diagnose pro Datei mit `// ignore_for_file: deprecated_member_use` statt global, damit andere Veraltungen sichtbar bleiben.

## Stolperfallen aus einer echten Migration

All dies stammt aus einem einzigen Probe-Testlauf mit Flutter 3.44.8. Die Zahlen sind ausgegebene Werte, keine Schätzungen.

### Die alte und die neue Farbe sind nicht gleich und haben keinen gleichen Hash

```dart
// Flutter 3.44.8
final o = Colors.black.withOpacity(0.5);
final v = Colors.black.withValues(alpha: 0.5);

print(o.a);                          // 0.5019607843137255
print(v.a);                          // 0.5
print(o == v);                       // false
print(o.toARGB32() == v.toARGB32()); // true (both 0x80000000)
print({o: 'x'}[v]);                  // null
```

`Color.==` vergleicht `a`, `r`, `g`, `b` und `colorSpace` als Doubles, und `hashCode` hasht dieselben Felder. Ist die Hälfte einer Codebasis migriert und die andere nicht, findet eine Farbe aus der einen Hälfte ihren Eintrag in einer Map der anderen Hälfte nicht. Migrieren Sie eine Nachschlagetabelle und jede Aufrufstelle, die sie abfragt, im selben Commit, oder indizieren Sie die Map nach `toARGB32()`.

### Persistieren mit toARGB32 bringt die alte Farbe zurück

```dart
// Flutter 3.44.8
final stored = v.toARGB32();
print(Color(stored) == v); // false
print(Color(stored) == o); // true
```

`toARGB32()` ist absichtlich verlustbehaftet: Es rundet jeden Kanal auf ein Byte. Eine mit `Color(int)` wiederhergestellte Farbe erhält das Alpha `128/255`, das ist der `withOpacity`-Wert und nicht der gespeicherte. Das ist für das Zeichnen in Ordnung und für Gleichheitsprüfungen falsch, etwa bei "ist die gespeicherte Akzentfarbe noch die ausgewählte". Wenn exakte Roundtrips wichtig sind, speichern Sie die vier Doubles und den Namen des Farbraums und bauen die Farbe mit `Color.from(alpha: ..., red: ..., green: ..., blue: ..., colorSpace: ...)` neu auf.

### `.a` ist nicht einfach `.opacity` unter neuem Namen

`dart fix` benennt `opacity` in `a` um, aber der alte Getter wurde aus dem 8-Bit-Alpha berechnet. Für `Colors.black.withValues(alpha: 0.3)` liefert `.opacity` den Wert `0.30196078431372547` und `.a` den Wert `0.3`. Code, der `opacity` mit einem Literal wie `0.30196` verglich oder als Map-Schlüssel nutzte, ändert nach der Umbenennung sein Verhalten. Das ist selten, aber es ist die eine Änderung von `dart fix`, die nicht semantisch neutral ist.

### withOpacity wandelt Display-P3-Farben unbemerkt in sRGB um

```dart
// Flutter 3.44.8
const p3 = Color.from(alpha: 1, red: 1, green: 0, blue: 0, colorSpace: ColorSpace.displayP3);

print(p3.withOpacity(0.5));
// Color(alpha: 0.5020, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.sRGB)
print(p3.withValues(alpha: 0.5));
// Color(alpha: 0.5000, red: 1.0000, green: 0.0000, blue: 0.0000, colorSpace: ColorSpace.displayP3)
```

Das P3-Rot liegt außerhalb von sRGB (in erweitertes sRGB umgerechnet ist es `red: 1.0931, green: -0.2267, blue: -0.1501`), aber `withOpacity` etikettiert dieselben Komponentenwerte einfach als sRGB um, sodass die Farbe sichtbar matter wird. `withAlpha(128)` verhält sich genauso und ist nicht veraltet, taucht also im Analyzer nicht auf. Wenn Ihre App Markenfarben mit großem Gamut verwendet, suchen Sie auch nach `withAlpha(` und ersetzen es durch `withValues(alpha: n / 255)`.

### withValues prüft den Wertebereich nicht

`Colors.black.withOpacity(1.5)` wirft in Debug-Builds eine `AssertionError`. `Colors.black.withValues(alpha: 1.5)` gelingt und speichert `a == 1.5`; `toARGB32()` begrenzt auf `0xff000000`, aber Gleichheit und alles andere, was `.a` liest, sieht `1.5`. Stammt das Alpha aus Arithmetik (etwa ein Animationswert mal ein Faktor), begrenzen Sie es selbst mit `clampDouble(x, 0, 1)`. `Color.lerp` begrenzt seine Ausgabe, daher sind Tweens sicher.

### Klassen, die Color implementieren

Der Leitfaden vermerkt, dass Flutter `Color` irgendwann `sealed` machen will. Wenn Sie eine Klasse mit `implements Color` haben (einige Theming-Pakete haben das getan, um eine dynamische Farbe zu kapseln), muss sie jetzt die Float-Getter, `colorSpace`, `toARGB32` und `withValues` implementieren. Empfohlen wird die Komposition: ein `Color`-Feld halten und es bereitstellen, statt vorzugeben, selbst eine Farbe zu sein. `CupertinoDynamicColor` selbst ist die Referenzimplementierung: Jede überschriebene Methode leitet an `_effectiveColor` weiter.

## Verwandte Artikel

- Die drei mechanischen Umschreibungen in Schritt 2 sind standardmäßige datengesteuerte Korrekturen; [dart fix über ein ganzes Repository ausführen](/de/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) behandelt die Flags, die Fälle, in denen es bei einem unsauberen Repository "Nothing to fix" meldet, und warum sein Exit-Code in CI nutzlos ist.
- Die meisten `withOpacity`-Aufrufe in Apps stehen neben Theme-Farben. Wenn Sie sie ohnehin anfassen, zeigt [die Akzentfarbe mit einem Material-3-ColorScheme festlegen](/de/2026/05/how-to-set-accent-color-in-flutter-with-material-3-colorscheme/), wie Sie diese transparenten Varianten aus dem Schema ableiten, statt Alphas von Hand abzustimmen.
- Eigene Design-Tokens sind der Ort, an dem `Color.lerp` und exakte Farbvergleiche aufeinandertreffen; siehe [Design-Tokens mit ThemeExtension in Flutter definieren](/de/2026/10/how-to-define-custom-design-tokens-with-themeextension-in-flutter/).
- Eine weitere Veraltung, die bei einem künftigen Upgrade zum Kompilierfehler wird: [von describeEnum wegmigrieren, bevor Flutter es entfernt](/de/2026/09/migrate-off-describeenum-before-flutter-removes-it/).
- Farben mit großem Gamut erreichen den Bildschirm nur unter Impeller; für Desktop-Ziele behandelt [eine Flutter-Windows- oder Linux-App auf Impeller migrieren](/de/2026/10/migrate-a-flutter-windows-or-linux-desktop-app-to-impeller/) den Wechsel des Renderers.

## Quellen

- [Migration guide for wide gamut Color](https://docs.flutter.dev/release/breaking-changes/wide-gamut-framework) (docs.flutter.dev)
- [Migration guide for wide gamut CupertinoDynamicColor](https://docs.flutter.dev/release/breaking-changes/wide-gamut-cupertino-dynamic-color) (docs.flutter.dev)
- [`Color.withValues`](https://api.flutter.dev/flutter/dart-ui/Color/withValues.html) und [`Color.withOpacity`](https://api.flutter.dev/flutter/dart-ui/Color/withOpacity.html) (api.flutter.dev)
- [`isSameColorAs` matcher](https://api.flutter.dev/flutter/flutter_test/isSameColorAs.html) (api.flutter.dev)
- [flutter/flutter#127855: Implement wide gamut color support in the Framework](https://github.com/flutter/flutter/issues/127855) und [flutter/engine#54737: Framework wide color](https://github.com/flutter/engine/pull/54737)
- [`fix_dart_ui.yaml` data-driven fixes](https://github.com/flutter/flutter/blob/master/packages/flutter/lib/fix_data/fix_dart_ui.yaml) (flutter/flutter)
