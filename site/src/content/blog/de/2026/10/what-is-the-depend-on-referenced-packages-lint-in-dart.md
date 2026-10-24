---
title: "Was ist der Lint depend_on_referenced_packages in Dart und warum schlägt er bei transitiven Imports an?"
description: "depend_on_referenced_packages schlägt an, wenn eine Datei ein Paket importiert oder exportiert, das nicht in Ihrer eigenen pubspec.yaml steht, auch wenn es über eine andere Abhängigkeit aufgelöst wird. Hier steht, was die Regel auf Dart 3.12.2 und Flutter 3.44.8 genau prüft, warum transitive Imports ein echter Fehler sind und wie Sie jede Variante beheben."
pubDate: 2026-10-24
tags:
  - "dart"
  - "flutter"
  - "lints"
  - "pub"
  - "pubspec"
lang: "de"
translationOf: "2026/10/what-is-the-depend-on-referenced-packages-lint-in-dart"
translatedBy: "claude"
translationDate: 2026-10-24
---

**Kurzantwort:** `depend_on_referenced_packages` meldet jeden `import` oder `export` von `package:foo/...`, bei dem `foo` nicht in der eigenen `pubspec.yaml` des importierenden Pakets steht. Der Lint ignoriert, dass `foo` problemlos aufgelöst wird, weil eine Ihrer Abhängigkeiten es mitbringt: Ein transitives Paket ist geliehen, mit einer Version, die Sie nicht kontrollieren, und ohne Garantie, dass es vorhanden bleibt. Beheben Sie das, indem Sie das Paket selbst deklarieren (`dart pub add foo` oder `flutter pub add foo`), unter `dependencies`, wenn der Import in `lib/`, `bin/`, `hook/build.dart` oder `hook/link.dart` liegt, und nur dann unter `dev_dependencies`, wenn er an anderer Stelle liegt, etwa in `test/` oder `tool/`. Alles Folgende wurde auf Dart 3.12.2 und Flutter 3.44.8 mit `lints` 6.1.0 und `flutter_lints` 6.0.0 gemessen.

Die Regel gibt es seit Dart 2.14 und sie gehört zum **core**-Set in [`package:lints`](https://pub.dev/packages/lints). Damit aktivieren sowohl `lints/recommended.yaml` als auch `flutter_lints` sie. Die meisten begegnen ihr zum ersten Mal, wenn sie in einer frischen Flutter-App `import 'package:collection/collection.dart';` tippen und eine blaue Wellenlinie unter einer Zeile sehen, die kompiliert und einwandfrei läuft.

## Warum ein funktionierender Import trotzdem markiert wird

Wenn Sie `flutter pub get` ausführen, löst pub den gesamten Abhängigkeitsgraphen auf und schreibt jedes darin enthaltene Paket nach `.dart_tool/package_config.json`. Der Compiler und der Analyzer lösen `package:`-URIs über diese Datei auf, und sie enthält auch Ihre transitiven Abhängigkeiten. Deshalb wird `package:http_parser` in einem Projekt aufgelöst, das nur von `http` abhängt: `http` hängt von `http_parser` ab, also steht es in der Paketkonfiguration.

Der Import funktioniert heute nur zufällig. Drei Dinge können ihn später kaputt machen, und keines davon taucht in Ihrem Diff auf:

1. **Der Vermittler lässt es fallen.** Wenn `http` 2.0 nicht mehr von `http_parser` abhängt, entfernt Ihr nächstes `pub upgrade` es aus dem Graphen und Ihr Build scheitert mit `Target of URI doesn't exist`. In Ihrer `pubspec.yaml` hat sich nichts geändert.
2. **Sie haben die Version nie gewählt.** Ihr Code ist gegen die Version von `http_parser` geschrieben, die die Einschränkung von `http` zufällig erlaubt hat. Ein Major-Sprung im transitiven Paket, den `http` toleriert, ist für Sie ein Breaking Change, und keine Einschränkung von Ihnen hält ihn auf.
3. **Ihre Nutzer bekommen es nicht.** Wenn Sie ein Paket veröffentlichen, lösen Ihre Nutzer ihren eigenen Graphen auf. Dev-Abhängigkeiten sind nie transitiv, daher existiert alles, was Ihr `lib/`-Code aus einer Dev-Abhängigkeit importiert, für sie schlicht nicht.

Der Lint macht aus diesen drei latenten Fehlern eine sichtbare Info-Diagnose an der Import-Stelle. Die [offizielle Regelseite](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) fasst sie als "Depend on referenced packages" zusammen, und die Begründung lautet: Eine explizite Abhängigkeit ist der einzige Weg, sowohl sicherzustellen, dass das Paket vorhanden ist, als auch eine eigene Versionseinschränkung darauf zu setzen.

## Was die Regel tatsächlich prüft

Die Implementierung ist kurz und lesenswert: [`pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) im Dart SDK. Für jede Bibliothek baut sie eine Liste erlaubter Paketnamen auf:

- der eigene `name` des Pakets (Selbst-Imports mit `package:my_app/...` sind also immer in Ordnung),
- jeder Schlüssel unter `dependencies`,
- jeder Schlüssel unter `dev_dependencies`, **aber nur, wenn die Datei nicht an einem öffentlichen Ort liegt**.

Eine Datei gilt als öffentlich, wenn sie in `lib/` oder `bin/` liegt oder genau `hook/build.dart` oder `hook/link.dart` ist (die Build-Hooks für Native Assets, ergänzt nach [dart-lang/sdk#54334](https://github.com/dart-lang/sdk/issues/54334)). Danach besucht die Regel jede `import`- und `export`-Direktive, nimmt das erste Pfadsegment nach `package:` und meldet es, wenn der Name nicht in der erlaubten Liste steht.

Einige Konsequenzen ergeben sich direkt aus diesem Code:

- `dependency_overrides` werden nicht berücksichtigt. Ein Paket, das nur dort auftaucht, ist weiterhin "keine Abhängigkeit".
- `export`-Direktiven werden genau wie Imports geprüft.
- Nur die Haupt-URI einer Direktive wird geprüft, nicht die URIs in bedingten `if (dart.library.io) ...`-Klauseln.
- Die einzige fest verdrahtete Ausnahme ist `flutter_gen`, das alte synthetische Lokalisierungspaket (siehe [dart-lang/linter#3308](https://github.com/dart-lang/linter/issues/3308)).
- Es gibt keine Vererbung vom Root-Paket oder Workspace. Jedes Paket wird gegen seine eigene pubspec geprüft.

## Ein Repro, das jede Variante auslöst

Hier ist ein kleines reines Dart-Paket, das nur von `http` abhängt und `meta` als Dev-Abhängigkeit führt:

```yaml
# pubspec.yaml -- Dart 3.12.2
name: repro
version: 1.0.0

environment:
  sdk: ^3.12.0

dependencies:
  http: ^1.6.0

dev_dependencies:
  lints: ^6.1.0
  meta: ^1.18.0

dependency_overrides:
  path: ^1.9.1
```

```yaml
# analysis_options.yaml
include: package:lints/recommended.yaml
```

```dart
// lib/repro.dart -- Dart 3.12.2
import 'package:http/http.dart' as http;          // declared: OK
import 'package:http_parser/http_parser.dart';   // transitive via http: LINT
import 'package:meta/meta.dart';                 // dev_dependency in lib/: LINT
import 'package:repro/src/helpers.dart';         // self package: OK
export 'package:async/async.dart' show Result;   // transitive export: LINT

@immutable
class Probe {
  const Probe();

  Future<MediaType> contentType(Uri uri) async {
    final response = await http.head(uri);
    return MediaType.parse(response.headers['content-type'] ?? 'text/plain');
  }
}

final helper = helperValue;
```

Fügen Sie denselben `import 'package:meta/meta.dart';` in `bin/repro.dart`, `hook/build.dart`, `tool/gen.dart` und `test/repro_test.dart` ein, importieren Sie auch im Test `package:http_parser` und importieren Sie `package:path` (nur als Override vorhanden) aus `lib/src/over.dart`. `dart analyze` meldet:

```text
info - bin/repro.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - hook/build.dart:1:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:3:8 - The imported package 'meta' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/repro.dart:5:8 - The imported package 'async' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - lib/src/over.dart:1:8 - The imported package 'path' isn't a dependency of the importing package. ... - depend_on_referenced_packages
info - test/repro_test.dart:2:8 - The imported package 'http_parser' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

Beachten Sie, was fehlt: `tool/gen.dart` und der `meta`-Import in `test/` sind sauber, weil Dev-Abhängigkeiten außerhalb öffentlicher Orte erlaubt sind. Beachten Sie auch, dass die Meldung gleich lautet, ob das Paket fehlt oder nur im falschen Abschnitt steht. "Isn't a dependency" kann heißen: "Es ist eine Dev-Abhängigkeit, und diese Datei ist öffentlich".

## Die Flutter-Variante desselben Problems

In einer Flutter-App sind die transitiven Pakete, die Sie am ehesten versehentlich importieren, die, von denen das SDK selbst abhängt: `collection`, `meta`, `vector_math`, `characters`, `material_color_utilities`. Sie sind immer im Graphen, weil `flutter` sie braucht. Eine neue `flutter create --empty`-App mit dieser Datei:

```dart
// lib/probe.dart -- Flutter 3.44.8
import 'package:collection/collection.dart';
import 'package:meta/meta.dart';
import 'package:vector_math/vector_math_64.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
```

erhält vier Infos zu `depend_on_referenced_packages`. `flutter_localizations` erhält zusätzlich einen harten Fehler `uri_does_not_exist`, weil es ein separates SDK-Paket ist, das erst im Graphen steht, wenn Sie es anfordern. Der Lint ist die freundlichere der beiden Diagnosen, aber das zugrunde liegende Problem ist dasselbe.

## So beheben Sie es, Fall für Fall

1. **Transitives Paket, das aus `lib/` importiert wird.** Deklarieren Sie es als reguläre Abhängigkeit. Lassen Sie pub die Einschränkung wählen, statt zu raten:

   ```bash
   # Flutter 3.44.8
   flutter pub add collection meta vector_math
   ```

   ```yaml
   dependencies:
     collection: ^1.19.1
     flutter:
       sdk: flutter
     meta: ^1.18.0
     vector_math: ^2.2.0
   ```

2. **SDK-Paket wie `flutter_localizations`.** Diese brauchen die Form `sdk: flutter`, die `pub add` als JSON-Deskriptor akzeptiert:

   ```bash
   flutter pub add 'flutter_localizations:{"sdk":"flutter"}'
   ```

3. **Dev-Abhängigkeit, die aus `lib/`, `bin/` oder einem Build-Hook importiert wird.** Verschieben Sie sie entweder nach `dependencies` (`dart pub add meta` verschiebt sie für Sie) oder verlagern Sie den importierenden Code aus dem öffentlichen Verzeichnis. Bei reinen Annotationspaketen wie `meta` ist das Verschieben nach `dependencies` die richtige Wahl: Ein veröffentlichtes Paket mit `@immutable` in `lib/` lässt sich für Nutzer sonst nicht kompilieren.

4. **Paket, das nur in `dependency_overrides` existiert.** Ein Override ändert die Version von etwas, das bereits im Graphen steht; er deklariert keine Abhängigkeit. Fügen Sie zusätzlich einen normalen Eintrag hinzu und behalten Sie den Override, falls Sie ihn weiterhin brauchen.

5. **Paket, das aus Ihrer Bibliothek exportiert wird.** Dieselbe Lösung wie bei einem Import. Wenn Sie `Result` aus `package:async` re-exportieren, hängt Ihre öffentliche API nun von der Version von `async` ab, und genau deshalb wollen Sie dafür eine eigene Einschränkung.

Für diese Regel gibt es kein `dart fix`; im Repro meldet `dart fix --dry-run` "Nothing to fix!". Die Quick-Fix-Funktion der IDE trägt das Paket in die `pubspec.yaml` ein, und `pub add` tut dasselbe im Terminal.

## Stolperfallen und Sonderfälle

### Das Flutter SDK legt Ihre Einschränkung fest

Pakete wie `meta` und `collection` sind von `flutter` und `flutter_test` auf exakte Versionen festgelegt. Wenn Sie eine Einschränkung oberhalb der festgelegten Version schreiben, scheitert die Auflösung:

```text
Note: meta is pinned to version 1.18.0 by flutter_test from the flutter SDK.

Because every version of flutter_test from sdk depends on meta 1.18.0 and fapp depends on meta ^1.19.0, flutter_test from sdk is forbidden.
So, because fapp depends on flutter_test from sdk, version solving failed.
```

Deshalb ist `flutter pub add` besser, als die Einschränkung von Hand zu tippen: Es wählt die Version, die die Festlegung erfüllt. Falls Sie diesen Fehler schon haben, erklärt die Anleitung [Version solving failed in pubspec.yaml beheben](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/), wie Sie die Ausgabe des Solvers lesen. Rechnen Sie damit, dass sich Ihre `pubspec.lock` später ändert, wenn Sie die Flutter-Version wechseln, da die Festlegungen mit dem SDK wandern; [diese Erklärung zur pubspec.lock](/de/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) behandelt den Grund.

### Pub-Workspaces erben keine Abhängigkeiten

In einem Dart-3.6+-Pub-Workspace teilen sich alle Mitglieder eine Auflösung und eine `package_config.json`, sodass ein Mitglied alles importieren kann, wovon ein anderes Mitglied abhängt. Der Lint erlaubt das nicht. Eine Root-`pubspec.yaml` mit `http` in ihren `dependencies` und ein Mitglied `pkgs/app` mit `resolution: workspace` und ohne Abhängigkeiten ergeben weiterhin:

```text
info - pkgs/app/lib/app.dart:1:8 - The imported package 'http' isn't a dependency of the importing package. ... - depend_on_referenced_packages
```

Das ist das Verhalten, das Sie in einem Monorepo wollen. Die geteilte Auflösung macht versehentliches Ausleihen zwischen Paketen leicht, und der Lint verhindert, dass sich ein Paket stillschweigend auf die Abhängigkeitsliste eines Nachbarn verlässt. Wenn der Analysis Server in einem großen Workspace langsam ist, ist das ein separates Problem, siehe [Dart Analysis Server in einem großen Flutter-Monorepo beschleunigen](/de/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

### Bedingte Imports rutschen durch

Die Regel prüft nur die primäre URI einer Direktive. Das hier besteht den Lint, obwohl `path` nicht deklariert ist:

```dart
// lib/src/cond.dart -- Dart 3.12.2
import 'package:repro/src/helpers.dart'
    if (dart.library.io) 'package:path/path.dart';
```

Auch `dart pub publish --dry-run` hat das auf Dart 3.12.2 nicht beanstandet. Prüfen Sie plattformbedingte Imports im Review von Hand.

### `dart pub publish` erzwingt dieselbe Regel als Fehler

Bei veröffentlichten Paketen führt der eigene Validator von pub eine strengere Variante dieser Prüfung aus. Im Repro hat `dart pub publish --dry-run` die Befunde in lib, bin und Hook zu harten Fehlern gemacht:

```text
* line 3, column 1 of lib/repro.dart: meta is in the `dev_dependencies` section of `pubspec.yaml`. Packages used in lib/ must be declared in the `dependencies` section.
* line 2, column 1 of lib/repro.dart: This package does not have http_parser in the `dependencies` section of `pubspec.yaml`.
```

Der Befund in `test/` erscheint nur als Warnung. Den Lint in einem veröffentlichten Paket zu ignorieren, verschiebt den Fehler also nur auf den Release-Tag.

### `flutter_gen` ist ausgenommen, wird aber verschwinden

Die Ausnahme für `flutter_gen` besteht, weil `flutter gen-l10n` früher ein synthetisches Paket erzeugte, das in keiner pubspec stehen konnte. Flutter hat dieses synthetische Paket als veraltet markiert (siehe die [Breaking-Change-Mitteilung](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)); die generierten Lokalisierungen liegen jetzt in Ihrem eigenen Quellbaum und werden über Ihren eigenen Paketnamen importiert, was der Lint bereits erlaubt.

### Nicht für "nur ein Dev-Paket" abschalten

Ein häufiger Wunsch ist, ein reines Dev-Annotationspaket in `analysis_options.yaml` auf eine Whitelist zu setzen. [dart-lang/sdk#60026](https://github.com/dart-lang/sdk/issues/60026) hat genau das gefordert und wurde ohne das Feature geschlossen. Die Antwort des Maintainers war, dass ein Paket, das aus `lib/` importiert wird, eine echte Abhängigkeit ist, und dass `// ignore:`-Kommentare zur Verfügung stehen, wenn Sie darauf bestehen. Wenn es wirklich sein muss, begrenzen Sie die Unterdrückung auf die Zeile statt auf das Projekt:

```dart
// ignore: depend_on_referenced_packages
import 'package:meta/meta.dart';
```

Die Regel global abzuschalten (`depend_on_referenced_packages: false` unter `linter: rules:`) schaltet auch die einzige Frühwarnung ab, die Sie bekommen, bevor pub oder der Build eines Nutzers scheitert. Lint-Konfiguration lässt sich generell leichter durchdringen, wenn man genau weiß, wo jede Regel hinschaut; der [Vergleich von unawaited_futures und discarded_futures](/de/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/) ist ein gutes Beispiel für zwei Regeln, deren Geltungsbereich enger ist, als ihre Namen vermuten lassen.

## Weiterlesen

- [Fix: Version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Fix: pubspec.lock wird nach flutter upgrade oder dem Wechsel der Flutter-Version als geändert angezeigt](/de/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/)
- [unawaited_futures vs discarded_futures in Dart](/de/2026/10/unawaited-futures-vs-discarded-futures-lint-in-dart/)
- [dart fix über ein ganzes Repo ausführen, um Flutter-Breaking-Change-Migrationen anzuwenden](/de/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/)
- [Einen langsamen Dart Analysis Server in VS Code für ein großes Flutter-Monorepo beschleunigen](/de/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## Quellen

- [Regelseite zu depend_on_referenced_packages](https://dart.dev/tools/linter-rules/depend_on_referenced_packages) und [Diagnoseseite](https://dart.dev/tools/diagnostics/depend_on_referenced_packages)
- [Regelimplementierung in dart-lang/sdk](https://github.com/dart-lang/sdk/blob/main/pkg/linter/lib/src/rules/pub/depend_on_referenced_packages.dart) und [die zugehörigen Tests](https://github.com/dart-lang/sdk/blob/main/pkg/linter/test/rules/depend_on_referenced_packages_test.dart)
- [package:lints, core-Regelsatz](https://pub.dev/packages/lints)
- [dart-lang/sdk#60026: Dev-Abhängigkeiten ausnehmen](https://github.com/dart-lang/sdk/issues/60026)
- [dart-lang/linter#3308: Ausnahme für flutter_gen](https://github.com/dart-lang/linter/issues/3308)
- [SDK-Versionsfestlegung](https://dart.dev/go/sdk-version-pinning)
- [Flutter Breaking Change: flutter generate l10n source](https://docs.flutter.dev/release/breaking-changes/flutter-generate-i10n-source)
