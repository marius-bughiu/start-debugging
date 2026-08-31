---
title: "Lösung: The method 'getInvocation' isn't defined for the type 'DartObjectImpl'"
description: "build_runner kompiliert nicht, weil source_gen 3.1.0 oder 4.0.0 eine in analyzer 8.4.0 entfernte API aufruft. Aktualisieren Sie den Generator, der source_gen unter 4.0.1 festhält."
pubDate: 2026-08-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "build-runner"
  - "source-gen"
lang: "de"
translationOf: "2026/08/fix-the-method-getinvocation-isnt-defined-for-the-type-dartobjectimpl"
translatedBy: "claude"
translationDate: 2026-08-31
---

`build_runner` scheitert beim Kompilieren seines eigenen Build-Skripts, nicht Ihres Codes. `source_gen` 3.1.0 und 4.0.0 rufen `DartObjectImpl.getInvocation()` auf, das `analyzer` 8.4.0 gelöscht hat, und beide Pakete deklarieren Constraints, die locker genug sind, damit pub sie zusammenbringt. Die Lösung: Aktualisieren Sie den Codegenerator in Ihrer `pubspec.yaml`, der `source_gen` unter 4.0.1 festhält. Wenn heute kein Upgrade möglich ist, fügen Sie `dependency_overrides: analyzer: 8.3.0` als Zwischenlösung hinzu.

## Der vollständige Fehler

Sie führen `dart run build_runner build` (oder `flutter pub run build_runner build`) aus und erhalten einen Compile-Fehler des Dart-Frontends, der in Ihren pub-Cache zeigt:

```text
[INFO] Generating build script...
../../.pub-cache/hosted/pub.dev/source_gen-3.1.0/lib/src/constants/revive.dart:82:40:
Error: The method 'getInvocation' isn't defined for the type 'DartObjectImpl'.
 - 'DartObjectImpl' is from 'package:analyzer/src/dart/constant/value.dart'
   ('../../.pub-cache/hosted/pub.dev/analyzer-8.4.1/lib/src/dart/constant/value.dart').
Try correcting the name to the name of an existing method, or defining a method
named 'getInvocation'.
  final i = (object as DartObjectImpl).getInvocation();
                                       ^^^^^^^^^^^^^
[SEVERE] Failed to compile build script. Check builder definitions and generated
script .dart_tool/build/entrypoint/build.dart.
```

Zwei Details dieser Ausgabe erledigen die Diagnose für Sie. Die fehlerhafte Datei liegt in `source_gen`, nicht in Ihrem Projekt. Und die Versionsnummern in diesen beiden Cache-Pfaden sind der gesamte Fehler: `source_gen-3.1.0` gegen `analyzer-8.4.1`.

Alles Folgende wurde gegen die Paketarchive von pub.dev geprüft und gilt für Flutter 3.47.0 mit Dart 3.13.0, dem Stable-Kanal im August 2026, ebenso wie für jedes ältere Dart-3.x-Projekt, das dasselbe Paar auflöst.

## Warum analyzer 8.4.0 die Methode entfernt hat

`source_gen` muss für jede Annotation eine Frage beantworten: Welcher Quellcode würde ein const-Objekt, das der Analyzer bereits ausgewertet hat, wieder erzeugen? Genau das tut `reviveInstance` in `source_gen/lib/src/constants/revive.dart`, und so wird `@JsonSerializable(fieldRename: FieldRename.snake)` zu nutzbarer Konfiguration innerhalb eines Builders.

Dafür brauchte `source_gen` den Konstruktor und die Argumentwerte hinter einem `DartObject`. Jahrelang war ein Implementierungs-Import der einzige Weg dorthin:

```dart
// source_gen 3.1.0, lib/src/constants/revive.dart
// ignore: implementation_imports
import 'package:analyzer/src/dart/constant/value.dart' show DartObjectImpl;

// ...
final i = (object as DartObjectImpl).getInvocation();
```

Dieser Kommentar `// ignore: implementation_imports` ist der eigene Lint des Analyzers, der `source_gen` mitteilt, dass es in ein `src/`-Verzeichnis greift, das keinerlei API-Stabilität zusichert.

Das Analyzer-Team hat die zugrunde liegende Lücke geschlossen. Version 8.1.0, veröffentlicht am 2025-08-07, fügte `DartObject.constructorInvocation` zur öffentlichen Oberfläche von `package:analyzer/dart/constant/value.dart` hinzu und liefert ein `ConstructorInvocation` mit `constructor`, `positionalArguments` und `namedArguments`. In 8.3.0 war der alte Einstiegspunkt noch vorhanden und zur Entfernung markiert:

```dart
// analyzer 8.3.0, lib/src/dart/constant/value.dart
@Deprecated('Use constructorInvocation instead')
ConstructorInvocationImpl? getInvocation() {
  return constructorInvocation;
}
```

Analyzer 8.4.0, veröffentlicht am 2025-10-15, hat diese Methode gestrichen. `constructorInvocation` bleibt, aber nichts namens `getInvocation` existiert noch irgendwo im Paket. Jeder Code, der es weiterhin aufruft, hört in dem Moment auf zu kompilieren, in dem diese Version aufgelöst wird.

`source_gen` war bereits umgezogen. Version 4.0.1, veröffentlicht am 2025-09-04, wechselte auf den öffentlichen Getter und verschärfte das eigene Constraint auf `analyzer: ^8.1.1`:

```dart
// source_gen 4.0.1 and later, lib/src/constants/revive.dart
final i = object.constructorInvocation;
if (i != null) {
  url = Uri.parse(urlOfElement(i.constructor.enclosingElement));
  // ...
}
```

Beachten Sie den fehlenden Implementierungs-Import. Das ist die eigentliche Korrektur, und deshalb ist jede Version von `source_gen` ab 4.0.1 immun.

## Die Lücke im Solver, die die kaputten Versionen paart

Wenn `source_gen` 4.0.1 das im September behoben hat und analyzer 8.4.0 im Oktober kam, warum trifft es dann überhaupt jemanden? Weil die kaputten Versionen die Inkompatibilität nie deklariert haben und pub ausschließlich Deklarationen liest.

Das sind die relevanten Constraints:

| Paket | Constraint auf analyzer | Ruft `getInvocation` auf |
| --- | --- | --- |
| `source_gen` 3.0.0 | `^7.4.0` | ja, aber unter 8.0.0 gedeckelt, also sicher |
| `source_gen` 3.1.0 | `>=7.4.0 <9.0.0` | ja, und 8.4.x liegt im Bereich |
| `source_gen` 4.0.0 | `>=7.4.0 <9.0.0` | ja, und 8.4.x liegt im Bereich |
| `source_gen` 4.0.1+ | `^8.1.1` | nein |

`source_gen` 3.1.0 und 4.0.0 sind die einzigen beiden veröffentlichten Versionen, die sowohl die entfernte Methode aufrufen als auch analyzer 8.4.x zulassen. Ihre Obergrenze `<9.0.0` war die Annahme, dass ein Major-Sprung jede Breaking Change mitbringen würde. Das Analyzer-Team hat ein veraltetes Member in einem Minor-Release entfernt, was für etwas normal ist, das ohnehin nie öffentliche API war.

Pub bevorzugt die neueste Version, die alle Constraints erfüllt, also löst ein Projekt ohne weiteren Druck `source_gen` 4.3.0 auf und sieht das nie. Der Fehler braucht etwas in Ihrem Graphen, das `source_gen` unten hält. Dieses Etwas ist fast immer ein Codegenerator mit einem Caret-Pin. `objectbox_generator` 5.0.0, veröffentlicht am 2025-10-01, deklarierte `source_gen: ^3.1.0`, was auf genau eine Version auflöst, 3.1.0, weil 3.1.0 das letzte Release der 3.x-Reihe ist. Zwei Wochen später erschien analyzer 8.4.0, und jedes ObjectBox-Projekt, das `dart pub upgrade` ausführte, bekam ein Build-Skript, das nicht kompilierte.

Das ObjectBox-Changelog zu 5.0.1 benennt den Fehler direkt: "Generator: migrate to `analyzer` 8 APIs. Require at least `analyzer` 8.1.1 and `source_gen` 4.0.1. Resolves `Error: The method 'getInvocation' isn't defined` when running the generator using `analyzer` 8.4.0".

ObjectBox war nicht allein. `json_serializable` 6.11.0 lieferte `source_gen: ^3.1.0` aus und weitete es in 6.11.1 auf `>=3.1.0 <5.0.0` auf. `retrofit_generator` 10.0.2, `chopper_generator` 8.3.1, `built_value_generator` 8.11.1 und `envied_generator` 1.2.1 trugen im selben Zeitfenster denselben Pin. Da `source_gen` ein einziger gemeinsamer Knoten im Abhängigkeitsgraphen ist, zieht ein veralteter Generator jeden anderen Generator Ihres Projekts mit auf 3.1.0 herunter. Ein Projekt mit `freezed`, `json_serializable` und einem ungepflegten Builder verdächtigt jedes Mal das falsche Paket.

## Reproduktion aus einer sauberen pubspec

```yaml
# pubspec.yaml
# Dart 3.9.x. Any SDK that admits analyzer 8.4.x reproduces this.
name: repro
environment:
  sdk: ^3.9.0

dependencies:
  objectbox: 5.0.0

dev_dependencies:
  build_runner: ^2.9.0
  objectbox_generator: 5.0.0
```

Führen Sie `dart pub get` aus und lesen Sie danach, was tatsächlich gewählt wurde:

```bash
dart pub deps --style=compact | grep -E 'source_gen|analyzer'
```

Sie sehen `source_gen 3.1.0` und `analyzer 8.4.1`. Dieses Paar ist der Fehler. `dart run build_runner build` scheitert dann mit dem Fehler vom Anfang dieses Artikels, bevor eine einzige Zeile Ihres Codes analysiert wird.

## Lösung 1: Den Generator aktualisieren, der source_gen festhält

Das ist die richtige Korrektur und meist eine einzige Zeile. Finden Sie das Constraint, das `source_gen` deckelt, und heben Sie es an.

Lassen Sie pub den Verursacher benennen, indem Sie eine Version verlangen, die es nicht liefern kann:

```bash
dart pub add dev:source_gen:^4.0.1
```

Das Version-Solving schlägt fehl, und die Erklärung nennt das Paket mit dem Pin:

```text
Because objectbox_generator 5.0.0 depends on source_gen ^3.1.0 and no versions
        of objectbox_generator match >5.0.0 <6.0.0, objectbox_generator 5.0.0
        requires source_gen ^3.1.0.
So, because repro depends on both objectbox_generator 5.0.0 and
source_gen ^4.0.1, version solving failed.
```

Lesen Sie das von unten nach oben, genau wie jeden anderen [Fehler beim Version-Solving von pub](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/). Die oberste Zeile ist die Tatsache, die Sie ändern müssen.

Danach heben Sie das genannte Paket an und lassen die Korrektur durchlaufen:

```bash
dart pub upgrade objectbox objectbox_generator
dart run build_runner build --delete-conflicting-outputs
```

Bewährte Untergrenzen, falls Sie sie lieber explizit setzen:

- `objectbox_generator` 5.0.1 oder neuer
- `json_serializable` 6.11.1 oder neuer
- `chopper_generator` 8.5.0 oder neuer
- `envied_generator` 1.3.2 oder neuer
- `retrofit_generator` 10.2.3 oder neuer
- `built_value_generator` 8.11.2 oder neuer

Nehmen Sie `source_gen` nicht als Korrektur in Ihre eigenen `dev_dependencies` auf. Es ist eine transitive Abhängigkeit Ihrer Generatoren, und ein Pin in Ihrer pubspec verschiebt den Konflikt nur in Ihre Datei, wo er verrottet.

## Lösung 2: Den Analyzer als Zwischenlösung pinnen

Wenn der störende Generator verwaist ist oder Sie mitten in einem Release stecken und kein Upgrade aufnehmen können, halten Sie den Analyzer auf der letzten Version, die die veraltete Methode noch enthält:

```yaml
# pubspec.yaml
# Temporary. Delete once the generator is upgraded.
dependency_overrides:
  analyzer: 8.3.0
```

Analyzer 8.3.0 (2025-10-10) ist das letzte Release mit vorhandenem `getInvocation`. Das funktioniert, weil die veraltete Methode eine einzeilige Weiterleitung an `constructorInvocation` war, das Verhalten also identisch ist.

Zwei Kosten, beide real. `dependency_overrides` bringt den Solver für jedes Paket im Graphen zum Schweigen, sodass ein zweites Paket, das wirklich analyzer 8.4+ braucht, jetzt zur Compile-Zeit statt bei `pub get` scheitert. Und Overrides werden ignoriert, wenn Ihr Paket selbst als Abhängigkeit konsumiert wird, ein veröffentlichtes Paket kann das also nicht als Korrektur an seine eigenen Nutzer ausliefern. Behandeln Sie es als Entsperrung auf Branch-Ebene mit einem datierten TODO, und ergänzen Sie einen CI-Job, der ohne Override kompiliert, damit Sie merken, wann es überflüssig wird. Wenn Sie mehrere Branches auf unterschiedlichen SDKs pflegen, ist [mehrere Flutter-Versionen aus einer CI-Pipeline zu bedienen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) das passende Muster, um beide ehrlich zu halten.

## Lösung 3: Wenn der Aufruf in Ihrem eigenen Builder steht

Wenn der fehlerhafte Pfad im Fehler Ihr eigenes Paket ist und nicht `source_gen`, haben Sie den Aufruf geschrieben und besitzen die Migration. Es ist ein direkter Tausch:

```dart
// Before. Requires the implementation import of DartObjectImpl.
// ignore: implementation_imports
import 'package:analyzer/src/dart/constant/value.dart' show DartObjectImpl;

final invocation = (object as DartObjectImpl).getInvocation();
```

```dart
// After. analyzer 8.1.0 and later. Public API, no src/ import.
import 'package:analyzer/dart/constant/value.dart';

final invocation = object.constructorInvocation;
if (invocation != null) {
  final ctor = invocation.constructor;
  final positional = invocation.positionalArguments;
  final named = invocation.namedArguments;
}
```

Löschen Sie das `implementation_imports`-Ignore gleich mit. Setzen Sie danach Ihre eigene Untergrenze auf `analyzer: '>=8.1.1'`, damit pub Ihrem Code keinen Analyzer ohne den Getter unterschieben kann. Diese Untergrenze wird gerne übersprungen, und genau sie macht aus einem korrigierten Paket wieder ein kaputtes für jemanden auf einem älteren SDK.

Wenn Sie schon dabei sind: `ConstructorInvocation.constructor2` existiert und ist zugunsten von `constructor` veraltet. Migrieren Sie beides im selben Durchgang, statt eine Entfernung gegen die nächste zu tauschen.

## Fallstricke und Verwechslungen

**`flutter clean` behebt das nicht und hat es nie.** Der meistwiederholte Rat bei build_runner-Fehlern lautet, `.dart_tool` zu löschen und neu zu bauen. Hier wird damit nur dieselbe Kompilierung gegen dieselben aufgelösten Versionen wiederholt. Wenn der Fehler eine Datei innerhalb von `.pub-cache` nennt, ist die Auflösung falsch, und kein Leeren des Caches ändert daran etwas.

**`--delete-conflicting-outputs` behebt es ebenfalls nicht.** Dieses Flag behandelt einen Build, der eine Datei erzeugt hat, die ein anderer Builder schreiben will. Es greift, nachdem das Build-Skript kompiliert wurde, und hier kompiliert das Build-Skript nie.

**Die Lockfile ist der übliche Auslöser.** An Ihrer pubspec hat sich nichts geändert; ein `dart pub upgrade`, ein frischer CI-Checkout ohne eingecheckte `pubspec.lock` oder das `pub get` einer Kollegin hat den Analyzer auf 8.4.x gehoben, während `source_gen` auf 3.1.0 festhing. Wenn die Maschine im Team noch baut, vergleichen Sie zuerst die beiden Lockfiles.

**Geschwisterfehler, identische Ursache.** `The getter 'name' isn't defined for the class 'NamedType'`, `The getter 'tmp' isn't defined for the class 'Diagnostic'` und `DotShorthandConstructorInvocation isn't defined` sind derselbe Fehlermodus: ein Builder, kompiliert gegen eine Analyzer-API, die umgezogen ist. Die Diagnose bleibt gleich. Lesen Sie die beiden Versionen aus den Cache-Pfaden im Fehler, finden Sie das Paket, das die ältere festhält, und aktualisieren Sie es. Das ist dieselbe Art von Bruch wie bei [einem Plugin, das seinen unbenannten Konstruktor entfernt](/de/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/), nur gehört die API hier einem Paket, das Sie nie aufgeschrieben haben.

**Analyzer 9.0.0 ist nicht die Grenze, die Sie wollen.** Es erschien am 2025-10-23, acht Tage nach 8.4.0. `analyzer: <9.0.0` schützt Sie nicht, weil 8.4.x bereits darunter liegt. Die einzigen sicheren Untergrenzen sind `source_gen: '>=4.0.1'` auf Generatorseite und `analyzer: '>=8.1.1'` auf Ihrer.

## Verwandt

- Pubs Fehlerbeweis zu lesen ist hier die Kernfähigkeit: [Version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/) geht die PubGrub-Ausgabe Zeile für Zeile durch.
- `freezed` ist ein `source_gen`-Builder wie jeder andere, dieser Fehler kann also ein Projekt treffen, das es nur für Datenklassen nutzt. [Dart Records vs. Freezed-Klassen](/de/2026/05/dart-records-vs-freezed-classes/) behandelt, wann Sie die Codegenerierung überhaupt brauchen.
- Der Generator von Riverpod sitzt auf demselben Stack: [die Migration von Riverpod 2.x auf Riverpod 3.0](/de/2026/07/migrate-from-riverpod-2-x-to-riverpod-3-0-in-flutter/) enthält den Codegen-Sprung.
- Ein Paket-Upgrade, das einen Konstruktor statt einer Methode entfernt: [The class 'GoogleSignIn' doesn't have an unnamed constructor](/de/2026/08/fix-the-class-googlesignin-doesnt-have-an-unnamed-constructor-in-flutter/).
- Um ein Projekt baubar zu halten, während ein Generator-Upgrade landet, siehe [mehrere Flutter-Versionen aus einer CI-Pipeline bedienen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Quellen

- [source_gen-Changelog](https://pub.dev/packages/source_gen/changelog), für den Wechsel in 4.0.1 auf `analyzer: ^8.1.1`. Versions-Constraints und Veröffentlichungsdaten wurden aus den pub.dev-Paketarchiven von 3.1.0, 4.0.0 und 4.0.1 gelesen.
- [analyzer-Changelog](https://pub.dev/packages/analyzer/changelog), für 8.1.0 mit `DartObject.constructorInvocation`. Das Vorhandensein des veralteten `getInvocation()` in 8.3.0 und sein Fehlen in 8.4.0 wurden gegen die veröffentlichten Archive beider Versionen bestätigt.
- [objectbox-Changelog](https://pub.dev/packages/objectbox/changelog), Version 5.0.1, veröffentlicht am 2025-10-29, das genau diesen Fehler und seine Korrektur benennt.
- [build_runner auf pub.dev](https://pub.dev/packages/build_runner). Die Meldung "Failed to compile build script" stammt aus `lib/src/bootstrap/bootstrapper.dart`.
- [dart pub deps](https://dart.dev/tools/pub/cmd/pub-deps) und [die Dokumentation des PubGrub-Solvers](https://github.com/dart-lang/pub/blob/master/doc/solver.md) für die Diagnosebefehle.
