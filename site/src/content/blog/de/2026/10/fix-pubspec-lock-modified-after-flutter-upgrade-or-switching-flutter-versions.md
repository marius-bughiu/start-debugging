---
title: "Fix: pubspec.lock wird nach flutter upgrade oder einem Wechsel der Flutter-Version als geändert angezeigt"
description: "Das Flutter SDK pinnt Versionen von meta, vector_math, test_api und matcher, daher löst jeder SDK-Wechsel Ihre Lockfile neu auf, und flutter upgrade führt pub upgrade für das Projekt aus, in dem Sie sich befinden. Pinnen Sie pro Repository eine Flutter-Version und erzwingen Sie die Lockfile in der CI."
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "dart"
  - "pub"
lang: "de"
translationOf: "2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions"
translatedBy: "claude"
translationDate: 2026-10-13
---

Ihre `pubspec.lock` ändert sich, weil das Flutter SDK selbst eine Abhängigkeit mit eigenen Versions-Pins ist. `flutter` und `flutter_test` verlangen exakte Versionen von Paketen wie `meta`, `vector_math`, `test_api` und `matcher`. Ein anderes SDK zwingt pub daher, diese neu aufzulösen, und das `flutter run` oder `flutter build` nach einem SDK-Wechsel führt `pub get` für Sie aus. Hinzu kommt: `flutter upgrade` führt `pub upgrade` für das Projekt aus, in dem Sie sich gerade befinden. Die Lösung: Pinnen Sie pro Repository eine Flutter-Version (FVM plus eine `environment: flutter:`-Einschränkung), committen Sie die Lockfile-Änderung eines SDK-Updates separat und führen Sie in der CI `flutter pub get --enforce-lockfile` aus. Alles Folgende wurde am 2026-10-13 mit Flutter 3.44.8 (Dart 3.12.2) und Flutter 3.47.7 (Dart 3.13.5) gemessen.

## Das Symptom im Kontext

Sie haben `pubspec.yaml` nicht angefasst. Sie haben `flutter upgrade` ausgeführt, den Channel gewechselt, oder ein Teammitglied mit einer anderen Flutter-Version hat gepusht, und nun zeigt `git status` Folgendes:

```text
 M pubspec.lock
```

Der Diff betrifft nur transitive Pakete, die Sie nie selbst hinzugefügt haben:

```diff
   meta:
     dependency: transitive
     description:
       name: meta
-      sha256: "1741988757a65eb6b36abe716829688cf01910bbf91c34354ff7ec1c3de2b349"
+      sha256: "307249ce4ff29d58a18e97f6345f539382eb9c9c29ecda628900f31de0443dd9"
       url: "https://pub.dev"
     source: hosted
-    version: "1.18.0"
+    version: "1.19.0"
```

Wechseln Sie zurück zum alten SDK und führen Sie irgendetwas aus, das `pub get` auslöst, dann kippt der Diff in die andere Richtung. In einem Team mit gemischten Flutter-Versionen springt die Lockfile in jedem Pull Request hin und her.

## Warum das passiert

Es gibt drei getrennte Mechanismen, und die meisten Teams stoßen auf alle drei.

**1. Das Flutter SDK pinnt seine eigenen Abhängigkeiten.** `packages/flutter/pubspec.yaml` und `packages/flutter_test/pubspec.yaml` im SDK führen exakte Versionen auf. Ihre App hängt über `sdk: flutter` von beiden ab, daher werden deren Pins zu Einschränkungen für Ihre Auflösung. Ändert sich das SDK, ändern sich die Pins, die Versionen in Ihrer Lockfile erfüllen sie nicht mehr, und pub muss neue wählen. Hier die relevanten Zeilen aus den beiden getesteten SDKs:

| Paket | Flutter 3.44.8 | Flutter 3.47.7 |
| --- | --- | --- |
| `meta` | `1.18.0` | `^1.18.3` |
| `vector_math` | `2.2.0` | `^2.4.0` |
| `test_api` | `0.7.11` | `0.7.12` |
| `matcher` | `0.12.19` | `0.12.20` |
| `material_color_utilities` | `0.13.0` | `0.13.0` |
| `collection` | `1.19.1` | `^1.19.1` |

Flutter 3.47 ist das erste stabile Release mit [PR #185268, "Unpin sdk package dependencies"](https://github.com/flutter/flutter/pull/185268), der das lang offene Issue [#158050, "Stop pinning dependencies"](https://github.com/flutter/flutter/issues/158050) schloss. Die meisten Pins wurden zu Caret-Bereichen. `test_api` und `matcher` bleiben exakt, weil das SDK deren `src/`-Bibliotheken importiert, und auch `material_color_utilities` ist weiterhin gepinnt (die PR-Beschreibung erklärt beides). Selbst ab 3.47 schreibt also jedes Flutter-Release, das `test_api` oder `matcher` anhebt, diese Lockfile-Einträge neu.

**2. Flutter führt nach einem SDK-Wechsel heimlich `pub get` aus.** `flutter run`, `flutter build`, `flutter test` und Verwandte rufen `pub get` auf, bevor sie irgendetwas anderes tun. Das Flutter-Tool überspringt den Schritt nur, wenn `.dart_tool/version` zur aktuellen Framework-Version passt und `pubspec.yaml` älter ist als `pubspec.lock` und `.dart_tool/package_config.json`. Die Prüfung steht in `packages/flutter_tools/lib/src/dart/pub.dart`. Das erste `flutter run` nach einem SDK-Wechsel löst also immer neu auf, und die Lockfile ändert sich, obwohl Sie nie `pub` getippt haben.

**3. `flutter upgrade` führt `pub upgrade` für Ihr Projekt aus.** Das übersehen die meisten. Nach dem Aktualisieren des SDK sucht `UpgradeCommand.updatePackages` im aktuellen Verzeichnis oder einem übergeordneten nach einer `pubspec.yaml`, und falls es eine findet, ruft es `pub.get(..., upgrade: true)` für dieses Projekt auf. Das ist `pub upgrade`, nicht `pub get`, und es hebt *jede* Abhängigkeit auf die neueste Version an, die Ihre Einschränkungen erlauben, auch Pakete, die mit dem SDK nichts zu tun haben. Der Code verhält sich so mindestens seit Flutter 3.0.0.

## Minimales Repro

Legen Sie ein Projekt mit dem älteren SDK an, committen Sie es und lösen Sie es dann mit dem neueren auf. Ich hatte beide SDKs nebeneinander: Flutter 3.44.8 von Homebrew und das stabile 3.47.7-Zip, entpackt in einen Scratch-Ordner.

```bash
# Flutter 3.44.8 (Dart 3.12.2) creates and locks the project
flutter create -e --platforms=android app
cd app
flutter pub add http shared_preferences intl
git init -q && git add -A && git commit -qm base

# Same project, Flutter 3.47.7 (Dart 3.13.5)
~/sdks/flutter-3.47.7/bin/flutter pub get
git diff --stat
```

Ausgabe unter 3.47.7:

```text
Resolving dependencies...
Downloading packages...
  clock 1.1.2 (1.1.3 available)
> matcher 0.12.20 (was 0.12.19)
  material_color_utilities 0.13.0 (0.13.1 available)
> meta 1.19.0 (was 1.18.0)
  stack_trace 1.12.1 (1.12.2 available)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Changed 4 dependencies!
Upgrading analysis_options.yaml to exclude build and platform directories.
 analysis_options.yaml |  4 ++++
 pubspec.lock          | 16 ++++++++--------
 2 files changed, 12 insertions(+), 8 deletions(-)
```

Vier Pakete haben sich bewegt, allesamt SDK-Pins oder ehemalige SDK-Pins. `http`, `shared_preferences` und `intl` blieben exakt dort, wo sie waren: Ein einfaches `pub get` behält jede gesperrte Version, die es behalten kann. Beachten Sie die zusätzliche Dateiänderung. Flutter 3.47 liefert eine `AnalysisOptionsMigration` mit, die beim ersten `pub get` in Ihrem Projekt `build/**` und je Plattformordner einen `<platform>/**`-Ausschluss zu `analysis_options.yaml` hinzufügt. Das ist eine einmalige Änderung, und Sie sollten sie zusammen mit der Lockfile committen.

Wechseln Sie nun zurück zu 3.44.8:

```text
< matcher 0.12.19 (was 0.12.20) (0.12.20 available)
< meta 1.18.0 (was 1.19.0) (1.19.0 available)
< test_api 0.7.11 (was 0.7.12) (0.7.15 available)
< vector_math 2.2.0 (was 2.4.3) (2.4.3 available)
Changed 4 dependencies!
```

Das ist das Hin und Her. Keines der beiden SDKs akzeptiert die Lockfile des anderen, also gewinnt, wer zuletzt gelaufen ist.

Zum Vergleich: `pub upgrade` unter 3.47.7 auf derselben 3.44-Lockfile (also das, was `flutter upgrade` für Sie erledigt) änderte sechs statt vier Pakete, weil es zusätzlich `clock` und `stack_trace` auf ihre neuesten Versionen hob. In einer echten App mit einigen Dutzend Abhängigkeiten ist diese Zahl meist deutlich größer.

## Die Lösung im Detail

Das Ziel ist nicht, dass sich die Lockfile nie ändert. Sie muss sich ändern, wenn sich das SDK ändert, weil die alte Auflösung nicht mehr gültig ist. Das Ziel ist, dass sie sich einmal ändert, mit Absicht, in einem Commit, den Sie prüfen können.

### 1. `pubspec.lock` für Apps committen, und nur für Apps

Die [Dart-Dokumentation zu `pub get`](https://dart.dev/tools/pub/cmd/pub-get) sagt, Anwendungspakete sollten die Lockfile einchecken, damit jeder Entwickler und jedes Deployment dieselben Versionen nutzt, wiederverwendbare Pakete dagegen nicht. Wenn Sie Änderungsrauschen in einem *Paket*-Repository sehen, ist die einfachste Lösung, die Lockfile dort nicht mehr zu committen. Alles Folgende setzt eine App voraus.

### 2. Pro Repository eine Flutter-Version pinnen

Das Hin und Her entsteht nur, wenn verschiedene Personen unterschiedliche SDKs gegen dieselbe Lockfile ausführen. Machen Sie die Version zum Bestandteil des Repositorys.

Mit [FVM](https://fvm.app/) schreibt `fvm use` die Version in `.fvmrc` im Projektstamm, und alle führen `fvm flutter ...` dagegen aus:

```bash
# FVM 3.x, Flutter 3.47.7
fvm install 3.47.7
fvm use 3.47.7
git add .fvmrc
```

Sichern Sie das anschließend mit einer Flutter-Einschränkung in `pubspec.yaml` ab, die pub für alle durchsetzt, ob mit oder ohne FVM:

```yaml
# pubspec.yaml, Flutter 3.47.7 / Dart 3.13.5
environment:
  sdk: ^3.13.5
  flutter: ">=3.47.0 <3.48.0"
```

Pub prüft beide Grenzen. Mit dem Bereich `<3.45.0` weigerte sich Flutter 3.47.7 überhaupt aufzulösen:

```text
The current Flutter SDK version is 3.47.7.

Because app2 requires Flutter SDK version >=3.0.0 <3.45.0, version solving failed.
Failed to update packages.
```

Dieser Fehler ist viel besser als eine stillschweigend umgeschriebene Lockfile: Das Teammitglied mit dem falschen SDK merkt es sofort statt erst im Code Review. Erwarten Sie, dass der Block `sdks:` am Ende von `pubspec.lock` Ihre Einschränkung widerspiegelt (`flutter: ">=3.47.0 <3.48.0"`), denn pub hält dort die Schnittmenge aller SDK-Einschränkungen im Graphen fest. Diese Zeile ändert sich, sobald Sie die Einschränkung bearbeiten, und das ist in Ordnung.

Wenn die CI derselben Datei folgen soll: Das [Multi-Version-CI-Setup](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) liest die Version aus `.fvmrc`.

### 3. Flutter als eigene Änderung aktualisieren, außerhalb des Projektverzeichnisses

Weil `flutter upgrade` `pub upgrade` für das Projekt ausführt, das es von Ihrem Arbeitsverzeichnis aus findet, vermischt ein Upgrade aus einem Repository heraus zwei sehr verschiedene Änderungen in einem Diff: die SDK-bedingte Neuauflösung und ein vollständiges Abhängigkeits-Upgrade. Trennen Sie sie:

```bash
# Flutter 3.44.8 -> 3.47.7
cd ~                # no pubspec.yaml here or in any parent directory
flutter upgrade     # upgrades only the SDK

cd ~/src/my_app
flutter pub get     # re-resolves only what the new SDK forces
git add pubspec.lock analysis_options.yaml
git commit -m "Flutter 3.47.7: re-resolve SDK-pinned packages"
```

Mit FVM erhalten Sie denselben Effekt gratis: `fvm install` und `fvm use` rufen nie `pub upgrade` für Ihre App auf. Wenn Sie neuere Pakete wollen, führen Sie `flutter pub upgrade` bewusst in einem zweiten Commit aus, damit sich eine Regression auf entweder "neues SDK" oder "neue Pakete" eingrenzen lässt, nicht auf beides. Dieselbe Trennung empfehle ich für [den `awaitNotRequired`-Bruch](/de/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/), bei dem ein zurückgezogenes Paket und ein SDK-Mismatch wie ein einziges Problem aussahen.

### 4. Die Lockfile in der CI erzwingen

`--enforce-lockfile` lässt `pub get` fehlschlagen, statt die Lockfile umzuschreiben, wenn die committete Auflösung für das aktuelle SDK nicht gültig ist. Die Dokumentation empfiehlt es für CI und Produktions-Deployments. Hier die 3.44-Lockfile unter Flutter 3.47.7:

```text
> matcher 0.12.20 (was 0.12.19)
> meta 1.19.0 (was 1.18.0)
> test_api 0.7.12 (was 0.7.11) (0.7.15 available)
> vector_math 2.4.3 (was 2.2.0)
Would change 4 dependencies.
Unable to satisfy `pubspec.yaml` using `pubspec.lock`.

To update `pubspec.lock` run `flutter pub get` without
`--enforce-lockfile`.
Failed to update packages.
```

Der Befehl endet mit Exit-Code 65 und lässt `pubspec.lock` unangetastet. Setzen Sie ihn vor jeden Build:

```yaml
# GitHub Actions, subosito/flutter-action v2, Flutter 3.47.7
- uses: subosito/flutter-action@v2
  with:
    flutter-version-file: .fvmrc
- run: flutter pub get --enforce-lockfile
- run: flutter build apk --release
```

Ein CI-Runner mit dem falschen SDK oder eine Lockfile, die nach einem SDK-Update nicht committet wurde, ergibt so einen roten Build mit klarer Meldung statt eines grünen Builds auf Versionen, die niemand geprüft hat. `--enforce-lockfile` schlägt außerdem fehl, wenn der Inhalts-Hash eines gehosteten Pakets nicht mehr zum in der Lockfile gespeicherten `sha256` passt, was nebenbei eine nette Supply-Chain-Prüfung ist.

### 5. Den Diff nicht mit `--no-pub` bekämpfen

`flutter run --no-pub` überspringt das implizite `pub get` und verhindert tatsächlich, dass sich die Lockfile ändert. Es bedeutet aber auch, dass Sie das neue SDK gegen eine `package_config.json` ausführen, die für das alte aufgelöst wurde. Das funktioniert, bis es nicht mehr funktioniert, meist als Kompilierfehler in `flutter_test` oder bei einer `meta`-Annotation, die das neue Framework erwartet. Nutzen Sie `--no-pub` für schnelle Experimente, nie als Lösung.

## Stolperfallen und Doppelgänger

**Neue Projekte unter 3.47+ starten an den unteren Grenzen.** Seit [PR #175352](https://github.com/flutter/flutter/pull/175352) schreibt `flutter create` eine `pubspec.lock`, die die Abhängigkeiten des SDK am unteren Ende ihrer neuen Bereiche sperrt. Ein frisches 3.47.7-Projekt sperrt `meta` 1.18.3 und `vector_math` 2.4.0; das erste `flutter pub upgrade` hebt sie auf 1.19.0 und 2.4.3. Dieser Diff ist erwartet, und Sie entscheiden, wann Sie ihn übernehmen.

**Patch-Releases bewegen die Pins selten.** Die Pubspec von `flutter_test` ist in 3.47.0, 3.47.6 und 3.47.7 identisch, daher lässt ein Patch-Upgrade innerhalb einer Minor-Version die Lockfile meist in Ruhe. Minor-Releases (3.44 auf 3.47) ändern sie fast immer. Planen Sie den Diff ein, wenn Sie eine Minor-Version überschreiten.

**Die Anführungszeichen um `sha256` sind kein Rauschen.** In den obigen Diffs sind manche Hashes in Anführungszeichen und manche nicht. Pub setzt jeden Hash in Anführungszeichen, der mit einer Ziffer beginnt, damit YAML ihn nicht als Zahl liest. Ändert sich eine Hash-Zeile, liegt es an der geänderten Version, nicht an der Formatierung.

**Monorepos mit Pub Workspace.** Bei Dart Workspaces gibt es eine einzige `pubspec.lock` im Workspace-Stamm, und `flutter upgrade` aus einem beliebigen Mitgliedsordner läuft nach oben und findet ebenfalls eine `pubspec.yaml`. Es gelten dieselben Regeln, nur mit größerem Wirkungsradius. Wenn Ihr Editor nach einer Neuauflösung langsam wird, siehe [den Dart Analysis Server in einem großen Monorepo beschleunigen](/de/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/).

**"version solving failed" statt eines Diffs.** Wenn ein Paket, von dem Sie abhängen, dasselbe Paket pinnt wie das SDK, schlägt die Auflösung bei einem SDK-Wechsel komplett fehl, statt die Lockfile stillschweigend umzuschreiben. Das ist ein anderes Problem mit eigener Anleitung: ["version solving failed" in pubspec.yaml beheben](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

**Engine-Artefakte sind ein separater Pin.** Das Pinnen der Framework-Version pinnt auch die Engine, was für reproduzierbare Release-Builds wichtig ist. Den Hintergrund liefert [der Beitrag zur Engine-Version von Flutter 3.38.6](/de/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).

## Verwandte Beiträge

- [Wie Sie "version solving failed" in pubspec.yaml beheben](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Wie Sie mehrere Flutter-Versionen aus einer CI-Pipeline ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Fix: Undefined name 'awaitNotRequired' aus material_ui oder cupertino_ui unter Flutter 3.44](/de/2026/10/fix-undefined-name-awaitnotrequired-material-ui-cupertino-ui-flutter-3-44/)
- [Flutter 3.38.6 und der Engine-Version-Bump: reproduzierbare Builds werden einfacher, wenn Sie pinnen](/de/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/)
- [Wie Sie einen langsamen Dart Analysis Server in VS Code für ein großes Flutter-Monorepo beschleunigen](/de/2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo/)

## Quellen

- [dart.dev: `dart pub get`](https://dart.dev/tools/pub/cmd/pub-get), zu gesperrten Versionen, `--enforce-lockfile` und dem Committen der Lockfile.
- [flutter/flutter#158050: Stop pinning dependencies](https://github.com/flutter/flutter/issues/158050) und das [Design-Dokument](https://flutter.dev/go/unpin-flutter-sdk-dependencies).
- [flutter/flutter#184821: Unpin sdk package dependencies](https://github.com/flutter/flutter/pull/184821) und der Reland [#185268](https://github.com/flutter/flutter/pull/185268).
- [flutter/flutter#175352: Have `flutter create` create a pubspec.lock](https://github.com/flutter/flutter/pull/175352).
- Flutter-Tool-Quellcode am [Tag 3.47.7](https://github.com/flutter/flutter/tree/3.47.7/packages/flutter_tools/lib/src): `commands/upgrade.dart` (`updatePackages`), `dart/pub.dart` (die Prüfung zum Überspringen von pub get), `migrations/analysis_options_migration.dart`.
