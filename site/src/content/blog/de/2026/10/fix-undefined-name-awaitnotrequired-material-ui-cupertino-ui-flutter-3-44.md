---
title: "Fix: Undefined name 'awaitNotRequired' bei material_ui oder cupertino_ui unter Flutter 3.44"
description: "material_ui 1.3.0 und cupertino_ui 1.1.0 verwenden eine Annotation, die Flutter 3.44 nicht exportiert. Beide sind zurückgezogen, aber eine Lockfile behält sie. Erst downgraden, dann upgraden, um bei 1.2.0 und 1.0.2 zu landen."
pubDate: 2026-10-02
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-44"
  - "dart"
  - "pub"
lang: "de"
translationOf: "2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44"
translatedBy: "claude"
translationDate: 2026-10-02
---

Ihre `pubspec.lock` pinnt `material_ui` 1.3.0 und/oder `cupertino_ui` 1.1.0, zwei Releases, die `@awaitNotRequired` verwenden. `package:flutter/foundation.dart` exportiert diese Annotation erst ab Flutter 3.47.0. Beide Versionen sind auf pub.dev inzwischen zurückgezogen (retracted), aber pub behält eine zurückgezogene Version, die Sie bereits gesperrt haben, und unter Flutter 3.44 wechselt selbst `flutter pub upgrade` nicht von ihr weg. Führen Sie `flutter pub downgrade material_ui cupertino_ui` gefolgt von `flutter pub upgrade` aus (Sie landen dann bei `material_ui` 1.2.0 und `cupertino_ui` 1.0.2), oder aktualisieren Sie Flutter auf 3.47. Alles Folgende wurde mit Flutter 3.44.8 (Dart 3.12.2) und Flutter 3.47.6 (Dart 3.13.5) am 2026-10-02 gemessen.

## Der Fehler im Kontext

Der Analyzer bleibt still, `flutter pub get` gelingt, und erst der erste echte Compile schlägt im Pub-Cache fehl. Dies ist `flutter build web` unter 3.44.8; jedes andere Ziel führt dasselbe Dart-Frontend über dieselben Quellen aus, daher scheitert `flutter run` an denselben Zeilen:

```text
Target dart2js failed: ProcessException: Process exited abnormally with exit code 1:
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/bottom_sheet.dart:1304:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/carousel.dart:1982:4:
Error: Not a constant expression.
  @awaitNotRequired
   ^^^^^^^^^^^^^^^^
/Users/marius/.pub-cache/hosted/pub.dev/material_ui-1.3.0/lib/src/dialog.dart:1672:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
...
/Users/marius/.pub-cache/hosted/pub.dev/cupertino_ui-1.1.0/lib/src/route.dart:1347:2:
Error: Undefined name 'awaitNotRequired'.
@awaitNotRequired
 ^^^^^^^^^^^^^^^^
```

`material_ui` 1.3.0 erzeugt acht dieser Fehler (`showModalBottomSheet`, `CarouselController.animateToItem`, `showDatePicker`, `showDateRangePicker`, `showDialog`, `showAdaptiveDialog`, `showMenu`, `showTimePicker`), und `cupertino_ui` 1.1.0 fügt zwei weitere hinzu (`showCupertinoModalPopup`, `showCupertinoDialog`). Die Variante `Not a constant expression` ist derselbe Fehler: Die Annotation an einer Instanzmethode wird vom Frontend nur anders gemeldet. Beachten Sie, dass `flutter analyze` in Ihrem Projekt nichts meldet, weil der Analyzer keine Fehler innerhalb von Abhängigkeiten anzeigt. Nur ein Compile-Schritt tut das.

Sie müssen nicht direkt von `material_ui` abhängen, um darauf zu stoßen. `shimmer` 4.0.0 hängt zum Beispiel von `material_ui: ^1.0.1` ab, sodass `flutter pub add shimmer` unter Flutter 3.44 zwischen 2026-09-15 und der Rücknahme 1.3.0 transitiv hineingezogen hat. Genau so ist der Melder in [flutter/flutter#192839](https://github.com/flutter/flutter/issues/192839) darauf gestoßen.

## Warum Flutter 3.44 eine Annotation nicht sieht, die in seinem eigenen meta-Paket existiert

`awaitNotRequired` ist nicht neu. Es lebt seit 1.17.0 in `package:meta`, und Flutter 3.44.8 pinnt `meta` 1.18.0, das sie bereits enthält. Die Konstante liegt direkt in Ihrem Pub-Cache. Was 3.44 fehlt, ist der Re-Export.

`material_ui` und `cupertino_ui` importieren nie `package:meta`. Ihre Bibliotheksdateien importieren `package:flutter/foundation.dart` und verlassen sich auf das, was dieses aus `meta` re-exportiert. Unter Flutter 3.44 ist diese Liste abgeschlossen:

```dart
// packages/flutter/lib/foundation.dart, Flutter 3.44.8
export 'package:meta/meta.dart'
    show
        factory,
        immutable,
        internal,
        // ignore: experimental_member_use
        mustBeConst,
        mustCallSuper,
        nonVirtual,
        optionalTypeArgs,
        protected,
        required,
        visibleForOverriding,
        visibleForTesting;
```

[flutter/flutter#181513](https://github.com/flutter/flutter/pull/181513) ("Add @awaitNotRequired annotation to flutter sdk") hat `awaitNotRequired` am 2026-04-25 zu dieser `show`-Liste hinzugefügt. Der Change verpasste den 3.44-Branch und erschien in Flutter 3.47.0 am 2026-08-12. In jedem 3.44.x-Release (3.44.0 bis 3.44.9) ist der Bezeichner für Code, der nur `foundation.dart` importiert, schlicht nicht im Gültigkeitsbereich.

Die Pakete werden unterdessen gegen den Flutter-main-Channel entwickelt. [flutter/packages#12622](https://github.com/flutter/packages/pull/12622) und [#12817](https://github.com/flutter/packages/pull/12817) haben die Annotationen hinzugefügt, und `material_ui` 1.3.0 sowie `cupertino_ui` 1.1.0 erschienen am 2026-09-15 mit den Annotationen, aber mit demselben `environment` wie zuvor:

```yaml
# material_ui 1.3.0 pubspec.yaml
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
```

Pub vertraut dieser Einschränkung, also wählte es unter Flutter 3.44 die Version 1.3.0 als neueste kompatible. Die Korrektur im Upstream bestand aus zwei Teilen: `material_ui` 1.4.0 und `cupertino_ui` 1.1.1 (beide 2026-09-21/22) hoben die Untergrenze auf `flutter: ">=3.47.0"` und `sdk: ^3.13.0` an, und 1.3.0 sowie 1.1.0 wurden zurückgezogen. Das Issue wurde am 2026-09-21 geschlossen.

## Minimales Reproduktionsbeispiel

Zurückgezogene Versionen lassen sich weiterhin über einen `dependency_overrides`-Pin erzwingen, was der einfachste Weg ist, den Build-Fehler gezielt nachzustellen:

```yaml
# pubspec.yaml, Flutter 3.44.8 / Dart 3.12.2
name: repro
publish_to: 'none'
environment:
  sdk: ^3.12.0
dependencies:
  flutter:
    sdk: flutter
  material_ui: ^1.0.0
dependency_overrides:
  material_ui: 1.3.0
  cupertino_ui: 1.1.0
```

```dart
// lib/main.dart, Flutter 3.44.8, material_ui 1.3.0
import 'package:material_ui/material_ui.dart';

void main() => runApp(
  const MaterialApp(home: Scaffold(body: Center(child: Text('hi')))),
);
```

`flutter pub get` gelingt, `flutter analyze` meldet keine Fehler, und `flutter build web` scheitert mit der obigen Ausgabe. Ohne den Override lehnt `flutter pub add material_ui:1.3.0` jetzt rundheraus ab mit `Because repro depends on material_ui 1.3.0 which doesn't match any versions, version solving failed.`, da der Solver zurückgezogene Versionen verbirgt, sofern sie nicht gepinnt oder bereits gesperrt sind.

## Warum die Rücknahme Ihr Projekt nicht repariert hat

Wenn Sie `pub get` ausgeführt haben, während 1.3.0 noch verfügbar war, steht in Ihrer `pubspec.lock` `version: "1.3.0"`, und eine Rücknahme berührt keine Lockfiles. Die [pub-Dokumentation](https://dart.dev/tools/pub/publishing#retract) stellt klar, dass eine gesperrte zurückgezogene Version weiter funktioniert. `flutter pub outdated` ist der schnellste Weg, um zu bestätigen, dass Sie in diesem Zustand sind:

```text
Package Name              Current             Upgradable          Resolvable          Latest

direct dependencies:
material_ui               *1.3.0 (retracted)  *1.3.0 (retracted)  *1.3.0 (retracted)  1.5.0

transitive dependencies:
cupertino_ui              *1.1.0 (retracted)  *1.1.0 (retracted)  *1.1.0 (retracted)  1.1.1
...
material_ui
    Version 1.3.0 is retracted. See https://dart.dev/go/package-retraction
cupertino_ui
    Version 1.1.0 is retracted. See https://dart.dev/go/package-retraction
```

Sehen Sie sich die Spalten Upgradable und Resolvable an: Pub sagt selbst, dass es Sie nicht weiterbewegt. Dieselbe pub-Dokumentation empfiehlt `dart pub upgrade <package>`, um eine zurückgezogene Version zu verlassen, und unter Flutter 3.44 bewirkt das nichts:

```text
$ flutter pub upgrade material_ui cupertino_ui
  cupertino_ui 1.1.0 (retracted, 1.1.1 available)
  material_ui 1.3.0 (retracted, 1.5.0 available)
No dependencies changed.
```

Der Grund liegt im Solver. In `lib/src/solver/version_solver.dart` gibt `_getAllowedRetracted` den Wert `_lockFile.packages[package]?.version` zurück, unabhängig davon, ob das Paket für das Upgrade entsperrt wurde. Während `upgrade` ist die gesperrte zurückgezogene Version also weiterhin ein zulässiger Kandidat. Jedes neuere Release (1.4.0, 1.5.0, 1.1.1) benötigt Flutter 3.47, daher ist die höchste Version, die der Solver unter 3.44 wählen kann, die zurückgezogene, die Sie bereits haben. Der Rat der Dokumentation funktioniert nur, wenn ein neueres *kompatibles* Release existiert, und unter 3.44 gibt es keines.

## Fix 1: Bei Flutter 3.44 bleiben und auf material_ui 1.2.0 zurückgehen

Die Lockfile soll 1.3.0 und 1.1.0 nicht mehr erwähnen. Am saubersten geht das mit Downgrade und anschließendem Upgrade, sodass die zurückgezogene Version aus der Sperre fällt, bevor das Upgrade läuft:

```bash
# Flutter 3.44.8: escape the retracted versions
flutter pub downgrade material_ui cupertino_ui
flutter pub upgrade
```

Der erste Befehl setzt beide Pakete auf die niedrigsten Versionen, die Ihre Einschränkungen erlauben (`material_ui` 1.0.0 und `cupertino_ui` 0.0.2 mit `^1.0.0`), was auch die zurückgezogenen Einträge aus `pubspec.lock` entfernt. Der zweite klettert zurück zu den neuesten nicht zurückgezogenen Versionen, die 3.44 akzeptiert:

```text
> cupertino_ui 1.0.2 (was 0.0.2) (1.1.1 available)
> material_ui 1.2.0 (was 1.0.0) (1.5.0 available)
```

Danach gelingt `flutter build web` unter 3.44.8. Dasselbe Ergebnis (1.2.0 und 1.0.2) erhalten Sie, wenn Sie die Einträge `material_ui` und `cupertino_ui` von Hand aus `pubspec.lock` löschen und `flutter pub get` ausführen, und ebenso, wenn Sie die ganze Lockfile löschen, wobei dann allerdings auch alles andere in Ihrem Graphen neu aufgelöst wird. Lassen Sie `cupertino_ui` nicht aus: Es ist meist eine transitive Abhängigkeit, und wenn Sie nur `material_ui` nennen, bleibt 1.1.0 gesperrt und weiterhin defekt.

Committen Sie die neue `pubspec.lock`. Wenn Ihre CI `flutter pub get --enforce-lockfile` ausführt, installiert sie genau das, was die committete Lockfile vorgibt, sodass der Build dort so lange fehlschlägt, bis die neue Lockfile eingecheckt ist.

## Fix 2: Auf Flutter 3.47 wechseln, was die Pakete jetzt erwarten

`material_ui` 1.4.0 und höher erfordern Flutter 3.47, und neue Korrekturen landen nur dort. Wenn Sie aktualisieren können, ist das die langfristige Antwort:

```bash
# Flutter 3.47.6 / Dart 3.13.5
flutter upgrade
flutter pub upgrade
```

Unter 3.47.6 funktioniert das Upgrade so, wie es die pub-Dokumentation beschreibt, weil nun neuere kompatible Versionen existieren:

```text
> cupertino_ui 1.1.1 (was 1.1.0)
> material_ui 1.5.0 (was 1.3.0)
```

Streng genommen brauchen Sie das Paket-Upgrade nicht einmal: Das zurückgezogene 1.3.0 kompiliert unter Flutter 3.47.6 einwandfrei, weil `foundation.dart` die Annotation jetzt re-exportiert. Ich empfehle trotzdem `flutter pub upgrade`, damit die Lockfile nicht mehr auf ein zurückgezogenes Release zeigt, was `flutter pub outdated` sonst weiter markieren wird.

Der Wechsel auf 3.47 ist ein größerer Eingriff als das Paket-Update. Er bringt Dart 3.13 mit (das unter anderem [`final` bei gewöhnlichen Parametern ablehnt](/de/2026/09/fix-dart-3-13-cant-have-modifier-final-here-on-parameters/)) und macht Impeller auf dem Desktop zum Standard-Renderer. Behandeln Sie ihn daher als geplantes Upgrade und nicht als Hotfix.

## Fix 3: Eine Einschränkung in pubspec.yaml beibehalten, damit das unter 3.44 nicht wiederkehrt

Wenn Sie noch eine Weile bei 3.44 bleiben, begrenzen Sie die Pakete explizit. Das dokumentiert die Entscheidung und verhindert, dass das `pub upgrade` eines Teamkollegen abdriftet, falls ein weiteres Release mit falschem `environment` erscheint:

```yaml
# pubspec.yaml, Flutter 3.44.x
dependencies:
  material_ui: ">=1.0.0 <1.3.0"
  cupertino_ui: ">=1.0.0 <1.1.0"
```

Fügen Sie `cupertino_ui` auch dann hinzu, wenn Sie es nicht importieren. Als ich nur `material_ui` begrenzt und `flutter pub get` gegen die defekte Lockfile ausgeführt habe, setzte pub `material_ui` auf 1.2.0, ließ aber das transitive `cupertino_ui` bei der zurückgezogenen 1.1.0, weil nichts eine Änderung erzwang. Mit beiden Begrenzungen setzte dasselbe `flutter pub get` sie auf 1.2.0 und 1.0.2.

## Dinge, die wie Lösungen aussehen, aber keine sind

- **`meta` anheben.** `meta` 1.18.0 deklariert `awaitNotRequired` bereits, und das Flutter-3.44-Framework pinnt `meta` in seiner eigenen `pubspec.yaml` auf exakt 1.18.0, sodass Sie es ohnehin nicht anheben könnten. Das Problem ist die `show`-Liste in `foundation.dart`, nicht die Version von `meta`.
- **Ein eigenes `awaitNotRequired` deklarieren.** Die Namensauflösung findet innerhalb der Bibliotheken von `material_ui` statt. Eine Top-Level-Konstante in Ihrer App liegt nicht in deren Gültigkeitsbereich.
- **`flutter clean` oder das Leeren des Pub-Caches.** Die fehlerhafte Version wird durch Ihre Lockfile ausgewählt, nicht durch veraltete Build-Ausgaben, daher wird sie beim nächsten `pub get` erneut heruntergeladen.
- **`material_ui: 1.3.0` in `dependencies` pinnen.** Eine zurückgezogene Version lässt sich so überhaupt nicht auswählen. Nur `dependency_overrides` kann sie erzwingen, und das reproduziert lediglich den Fehler.

Wenn Sie nach der Migration auf die eigenständigen Pakete `Undefined name` für einen anderen Flutter-Bezeichner erhalten, liegt die Ursache meist im selben Muster in anderer Richtung: Code, der gegen ein neueres Framework kompiliert wurde als das installierte. `flutter --version` und der `environment`-Block des Pakets, das im Fehlerpfad genannt wird, zeigen schnell, welche Seite voraus ist.

## Verwandte Artikel

- Den Hintergrund, warum Material und Cupertino aus dem SDK ausgelagert wurden, finden Sie in [Flutter 3.44 teilt Material und Cupertino in Pakete auf](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Für die vollständige Import-Migration, einschließlich `dart fix --code=migrate_design_widgets` und der Kompatibilitätsbrücken, siehe [Migration auf die Pakete material_ui und cupertino_ui](/de/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/).
- Eine weitere Typinkompatibilität zwischen den beiden Material-Welten wird in [dem google_fonts-TextTheme-Fehler mit material_ui](/de/2026/09/fix-textheme-cant-be-assigned-to-textheme-google-fonts-material-ui/) behandelt.
- Wenn pub gar nicht auflösen will, statt zu etwas Defektem aufzulösen, beginnen Sie mit [der Behebung von "version solving failed" in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/).
- Bevor Sie auf 3.47 wechseln, lesen Sie über [Impeller als Standard-Renderer auf dem Desktop in Flutter 3.47](/de/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).

## Quellen

- [flutter/flutter#192839: material_ui 1.3.0 & cupertino_ui 1.1.0 on Flutter 3.44 Error: Undefined name 'awaitNotRequired'](https://github.com/flutter/flutter/issues/192839)
- [flutter/flutter#181513: Add @awaitNotRequired annotation to flutter sdk](https://github.com/flutter/flutter/pull/181513)
- [flutter/packages#12622: Add awaitNotRequired annotation to material_ui](https://github.com/flutter/packages/pull/12622) und der nicht gemergte Revert [#12942](https://github.com/flutter/packages/pull/12942)
- [material_ui changelog](https://pub.dev/packages/material_ui/changelog) und [cupertino_ui changelog](https://pub.dev/packages/cupertino_ui/changelog)
- [Retract a package version](https://dart.dev/tools/pub/publishing#retract), Dart-Dokumentation
- [`version_solver.dart` in dart-lang/pub](https://github.com/dart-lang/pub/blob/master/lib/src/solver/version_solver.dart)
- [`awaitNotRequired` API docs in package:meta](https://pub.dev/documentation/meta/latest/meta/awaitNotRequired-constant.html)
