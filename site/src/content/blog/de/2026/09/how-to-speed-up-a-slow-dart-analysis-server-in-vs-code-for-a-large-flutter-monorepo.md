---
title: "So beschleunigen Sie einen langsamen Dart-Analyseserver in VS Code für ein großes Flutter-Monorepo"
description: "Ein Monorepo mit Dutzenden pubspec.yaml-Dateien bringt den Dart-Analyseserver dazu, pro Paket einen eigenen Analysekontext aufzubauen, und genau dort landen der Speicher und der minutenlange Start. Stellen Sie auf einen Pub-Workspace um, schließen Sie generierten Code in der analysis_options.yaml aus, entfernen Sie Legacy-Analyzer-Plugins und belegen Sie das Ergebnis mit der Insights-Seite. Gemessen unter Dart 3.12.2: 2,3-mal weniger Spitzenspeicher und halbierte Zeit für die Kaltanalyse."
pubDate: 2026-09-27
template: "how-to"
tags:
  - "dart"
  - "flutter"
  - "vs-code"
  - "performance"
  - "monorepo"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-speed-up-a-slow-dart-analysis-server-in-vs-code-for-a-large-flutter-monorepo"
translatedBy: "claude"
translationDate: 2026-09-27
---

**Kurze Antwort:** In einem Flutter-Monorepo ist der Dart-Analyseserver vor allem deshalb langsam, weil er für jedes Paket mit eigener `pubspec.yaml` und eigener `.dart_tool/package_config.json` einen separaten Analysekontext anlegt, und jeder Kontext lädt seine eigene Kopie des SDK, von Flutter und von jeder gemeinsam genutzten Abhängigkeit. Machen Sie aus dem Repo einen [Pub-Workspace](https://dart.dev/tools/pub/workspaces) (Dart 3.6+), damit alle Pakete in einen einzigen gemeinsamen Kontext aufgelöst werden, schließen Sie generierten Code mit `analyzer: exclude:` in der `analysis_options.yaml` im Root aus, entfernen Sie Legacy-Analyzer-Plugins wie `custom_lint` und öffnen Sie das Workspace-Root in VS Code. In einem synthetischen Repo mit 40 Paketen und 3.240 Dateien sank der Spitzenspeicher damit von etwa 1,2 GB auf 0,5 GB und die Kaltanalyse von 17 bis 22 s auf 11 bis 12 s, noch bevor generierter Code überhaupt angefasst wurde.

Alles Folgende wurde mit Dart 3.12.2 (Flutter 3.44.8) auf einem Mac mit Apple Silicon gemessen. Die aktuelle stabile Version ist Dart 3.13.3, ausgeliefert mit der Linie Flutter 3.47; die Konfigurationsschlüssel und das hier beschriebene Verhalten sind dort unverändert, und 3.13.2 markiert zusätzlich das Legacy-Plugin-System als veraltet, das Sie laut Abschnitt 4 hinter sich lassen sollten.

## Warum aus einem Repo vierzig Analyzer werden

Der Analyseserver (der Prozess hinter `dart language-server`, den die Dart-Code-Erweiterung startet, und hinter `dart analyze`) organisiert seine Arbeit in Analysekontexten. Ein Kontext ist eine Menge von Dateien, die eine gemeinsame Paketauflösung und einen gemeinsamen Satz Analyseoptionen teilen. Jeder Kontext hält sein eigenes aufgelöstes Elementmodell von allem, was er sieht, und das bedeutet für ein Flutter-Paket: das Dart SDK, das gesamte `flutter`-Paket und jede transitive Abhängigkeit.

Wenn Sie ein Monorepo-Root öffnen, das `apps/customer`, `apps/driver` und 38 Pakete unter `packages/` enthält, jedes mit eigener `pubspec.lock` und `.dart_tool/package_config.json`, hat der Server keine Wahl: Diese Pakete könnten `collection` oder `riverpod` in unterschiedliche Versionen auflösen, also baut er 40 Kontexte und löst `package:flutter` 40-mal auf. Das Dart-Team schreibt genau das auf der Workspaces-Seite: Das Root ohne Workspaces zu öffnen würde "separate Analysekontexte für jedes Paket erzeugen und den Speicherverbrauch erhöhen". Das langlebige Tracking-Issue für die Lösung, [dart-lang/sdk#53874](https://github.com/dart-lang/sdk/issues/53874), stellt die Verringerung der Kontextanzahl ins Zentrum der Performance-Arbeit am Server.

Die Symptome in VS Code sind bekannt: "Analyzing..." dreht sich nach dem Öffnen des Ordners eine Minute lang, Vervollständigungen brauchen Sekunden, Vorschläge für Auto-Imports hinken dem Tippen hinterher, und auf Rechnern mit 16 GB wird der Server beendet und neu gestartet.

## Messen, bevor Sie etwas ändern

Raten ist hier teuer, also besorgen Sie sich zuerst zwei Zahlen.

Führen Sie in VS Code über die Befehlspalette **Dart: Open Analyzer Diagnostics / Insights** aus. Das öffnet die Diagnose-Webseite des Servers. Die Seite Contexts listet jeden Analysekontext mit seinem Speicherort, seinem Workspace-Root und der Anzahl der "added" Dateien (Ihre eigenen) und der "implicit" Dateien (die SDK- und Abhängigkeitsdateien, die dieser Kontext einbinden musste). Sehen Sie einen Kontext pro Paket, jeweils mit Tausenden impliziter Dateien, haben Sie das Problem gefunden. Die Seite "Memory and CPU usage" zeigt, was der Prozess im Speicher hält, und die Seite "Legacy Plugins" listet alle Plugin-Isolates. **Dart: Capture Analysis Server Timings** zeichnet auf, welche Anfragen langsam sind, falls nicht der Start, sondern die Vervollständigung das Problem ist.

Für eine reproduzierbare Zahl, die Sie in der CI oder vor und nach einer Änderung erheben können, nutzen Sie die Kommandozeile. `dart analyze` führt denselben Analyseserver aus, und zwei versteckte Flags (sichtbar mit `dart analyze -h -v`) machen ihn als Benchmark brauchbar:

```bash
# Dart 3.12.2. --cache points at an empty dir so every run is cold.
rm -rf /tmp/dart-cache
/usr/bin/time -l dart analyze --cache=/tmp/dart-cache .
# "maximum resident set size" in the time output is peak memory (macOS, bytes).
# On Linux use: /usr/bin/time -v dart analyze --cache=/tmp/dart-cache .

# Server-reported heap, printed only with JSON output:
dart analyze --cache=/tmp/dart-cache --memory --format=json . | jq .memory
```

Das Flag `--cache` ist entscheidend. Ohne es verwendet der Lauf `~/.dartServer` wieder, und warme Läufe verdecken den größten Teil des Unterschieds, den Sie messen wollen.

## Das gemessene Repo

Um Zahlen zu bekommen, die nicht an die Codebasis einer einzelnen Firma gebunden sind, habe ich ein Monorepo aus 40 reinen Dart-Paketen generiert, jedes mit 80 Bibliotheksdateien, einer Barrel-Datei und Pfadabhängigkeiten auf die beiden vorherigen Pakete, sodass der Abhängigkeitsgraph eine Kette wie in einer echten geschichteten App bildet (`core` -> `data` -> `features`). Das sind 3.240 Dateien. Flutter-Pakete verhalten sich dafür genauso; sie machen jeden zusätzlichen Kontext nur teurer, weil `package:flutter` groß ist.

Zwei Varianten: `separate`, bei der jedes Paket sein eigenes `dart pub get` ausgeführt hat, und `workspace`, derselbe Code als Pub-Workspace umgebaut. Je drei kalte Läufe:

| Variante | Paketkonfigurationen | Kaltes `dart analyze` | Spitzen-RSS |
| --- | --- | --- | --- |
| separate | 40 | 16,5 s / 20,7 s / 22,4 s | 1.225 / 1.291 / 1.067 MB |
| workspace | 1 | 11,1 s / 11,6 s / 11,7 s | 499 / 495 / 490 MB |

Dieselben Diagnosen, derselbe Code, weniger als der halbe Speicher. In der IDE ist der Abstand größer als bei einem einmaligen CLI-Lauf, weil der Server Ihre gesamte Sitzung über läuft und jeder Kontext im Speicher bleibt.

## Schritt für Schritt: den Analyzer wieder schnell machen

1. Das SDK über bekannte Regressionen hinaus aktualisieren.
2. Das Repo auf einen Pub-Workspace umstellen.
3. Generierten und mitgelieferten Fremdcode in der `analysis_options.yaml` ausschließen.
4. Legacy-Analyzer-Plugins entfernen.
5. Das Workspace-Root in VS Code öffnen und reduzieren, was die IDE sieht.

### 1. Über bekannte Regressionen hinaus aktualisieren

Dart 3.11.0 wurde mit einem Performance-Problem in Workspaces mit vielen Dateien und vielen Verzeichnissen ausgeliefert, behoben in 3.11.1 ([dart-lang/sdk#62456](https://github.com/dart-lang/sdk/issues/62456)). Außerdem gibt es einen offenen Bericht, [dart-lang/sdk#62704](https://github.com/dart-lang/sdk/issues/62704), über einen Workspace mit 18 Paketen, der nach dem Umstieg auf 3.11.0 von etwa 10 s auf über 6 Minuten angewachsen ist. Wenn Sie genau auf 3.11.0 sind, aktualisieren Sie zuerst und messen Sie erneut. Dart 3.12 hat zudem den Start durch besseres Caching von Analyseoptionsdateien verbessert, was am meisten hilft, wenn jedes Paket eine eigene `analysis_options.yaml` hat, die eine gemeinsame per `include:` einbindet.

### 2. Auf einen Pub-Workspace umstellen

Ein Workspace verlangt, dass jedes Mitglied `resolution: workspace` deklariert und eine SDK-Untergrenze von mindestens 3.6 hat. Die `pubspec.yaml` im Root listet die Mitglieder auf:

```yaml
# pubspec.yaml at the repo root. Dart 3.6+ (measured on 3.12.2).
name: _
publish_to: none
environment:
  sdk: ^3.12.0
workspace:
  - apps/customer
  - apps/driver
  - packages/core
  - packages/data
  - packages/design_system
```

```yaml
# packages/data/pubspec.yaml
name: data
publish_to: none
environment:
  sdk: ^3.12.0
  flutter: ">=3.44.0"
resolution: workspace
dependencies:
  flutter:
    sdk: flutter
  core:
    path: ../core
```

Räumen Sie dann die Auflösungsartefakte der einzelnen Pakete auf und lösen Sie einmal vom Root aus auf:

```bash
# Remove stale per-package lockfiles and package configs, then resolve the workspace.
find . -name pubspec.lock -not -path './pubspec.lock' -delete
find . -path '*/.dart_tool/package_config.json' -not -path './.dart_tool/*' -delete
flutter pub get   # or: dart pub get
```

Danach gibt es eine einzige `pubspec.lock` und eine einzige `.dart_tool/package_config.json`, beide im Root. Starten Sie den Analyseserver neu (**Dart: Restart Analysis Server**) und prüfen Sie erneut die Seite Contexts: Sie sollten einen Kontext für den Workspace sehen.

Der Preis dafür ist, dass der Workspace eine einzige Versionsauflösung hat. Wenn `apps/driver` `intl` auf eine Hauptversion festlegt und `apps/customer` eine andere braucht, schlägt `pub get` fehl, bis Sie beide angleichen. Genau dieser Fehlschlag ist die eigentliche Migrationsarbeit; die meisten Repos entdecken zwei oder drei solcher Konflikte. Wenn Sie Melos verwenden: Version 7.0.0 ist auf Pub-Workspaces umgestiegen und hat `melos.yaml` durch einen Abschnitt `melos:` in der `pubspec.yaml` im Root ersetzt, sodass das Melos-Upgrade und die Umstellung auf einen Workspace ein und dieselbe Aufgabe sind.

### 3. Generierten und mitgelieferten Fremdcode ausschließen

Generierter Dart-Code ist oft so umfangreich wie der Code, den Sie selbst geschrieben haben. Die Ausgabe von `freezed`, `json_serializable`, `mockito`, `drift` und `intl` liegt als `*.g.dart`, `*.freezed.dart` und `*.mocks.dart` neben Ihren Quellen, und der Server löst jede Zeile auf und prüft sie mit Lints. (Falls die Codegenerierung selbst fehlschlägt, lesen Sie [die Versionsinkompatibilität zwischen source_gen und analyzer, die build_runner lahmlegt](/de/2026/08/fix-the-method-getinvocation-isnt-defined-for-the-type-dartobjectimpl/); wenn Sie zwischen generierten und eingebauten Modellen wählen, ist [Dart Records vs. freezed-Klassen](/de/2026/05/dart-records-vs-freezed-classes/) der passende Vergleich.)

```yaml
# analysis_options.yaml at the workspace root. Dart 3.12.2.
include: package:flutter_lints/flutter.yaml

analyzer:
  exclude:
    - "**/*.g.dart"
    - "**/*.freezed.dart"
    - "**/*.mocks.dart"
    - "**/build/**"
    - "third_party/**"
```

Ich habe jedem der 40 Pakete 10 Dateien im Stil generierten Codes (etwa 1.000 Zeilen) hinzugefügt und in der Workspace-Variante erneut gemessen:

| Workspace + generierter Code | Kaltes `dart analyze` | Spitzen-RSS |
| --- | --- | --- |
| generierte Dateien analysiert | 19,4 s / 14,7 s | 1.148 / 1.185 MB |
| `**/*.g.dart` ausgeschlossen | 6,9 s / 6,9 s | 523 / 523 MB |

Vier Details zu `exclude`, die die Dokumentation nicht ausformuliert, alle unter 3.12.2 verifiziert:

- **Globs sind relativ zur Optionsdatei.** Die [Analyse-Dokumentation](https://dart.dev/tools/analysis) sagt das ausdrücklich. `**/*.g.dart` funktioniert von überall; `lib/**` in der Root-Datei meint das `lib` des Roots, nicht das jedes Pakets.
- **In einem Workspace gilt das Exclude der Root-Datei auch für Mitglieder mit eigener `analysis_options.yaml`.** In meinem Test behielt jedes Paket seine eigene Optionsdatei, und ein `exclude` nur im Root entfernte trotzdem deren generierte Dateien aus der Analyse. Ohne Workspace gilt das nicht: Jedes Paket ist dann sein eigenes Kontext-Root, die Root-Datei wird für diese Pakete ignoriert, und Sie brauchen das Exclude in jedem Paket, oder eine Zeile `include: ../../analysis_options.yaml` in der Datei jedes Pakets, die das Exclude sehr wohl übernimmt.
- **Eine ausgeschlossene Datei wird trotzdem aufgelöst, wenn etwas sie importiert.** Ich habe eine Bibliothek ausgeschlossen, die andere Dateien importieren, und eine Warnung darin platziert. Die Warnung verschwand, die importierenden Dateien wurden weiterhin typgeprüft. Der Ausschluss spart also die Lint- und Diagnosearbeit und spart alles bei Dateien, die niemand importiert (Mocks, Test-Fixtures, veraltete Ausgaben), aber ein `*.g.dart`-`part` eines Modells, das Sie verwenden, wird weiterhin gelesen.
- **`build/` wird standardmäßig nicht übersprungen.** Ordner, deren Name mit einem Punkt beginnt (`.dart_tool`, `.git`), werden ignoriert, aber ein Verzeichnis `build/` oder `ios/Pods/`, das zufällig `.dart`-Dateien enthält, wird analysiert. Verschachtelte `example/`-Apps mit eigener `pubspec.yaml`, die keine Workspace-Mitglieder sind, werden ebenfalls zu zusätzlichen Kontexten. Nehmen Sie sie entweder in den Workspace auf oder schließen Sie sie aus.

### 4. Legacy-Analyzer-Plugins entfernen

Legacy-Analyzer-Plugins, also die Art `analyzer: plugins:`, die `custom_lint` und ältere Werkzeuge verwenden, laufen in separaten Isolates, die an Analysekontexte gebunden sind. Die Dart-Dokumentation warnt, dass das Aktivieren eines solchen Plugins "erhöht, wie viel Speicher der Analyzer verwendet", und empfiehlt, sie ganz zu vermeiden, wenn Sie weniger als 16 GB RAM haben oder ein Monorepo mit 10 oder mehr `pubspec.yaml`- oder `analysis_options.yaml`-Dateien. Dart 3.13.2 hat das Legacy-System offiziell als veraltet markiert.

Suchen Sie danach:

```bash
grep -rn --include=analysis_options.yaml -A3 'plugins:' .
```

Wenn die Lints wichtig sind, steigen Sie auf das [neue Plugin-System](https://dart.dev/tools/analyzer-plugins) um, das mit Dart 3.10 hinzukam, über einen Schlüssel `plugins:` auf oberster Ebene konfiguriert wird und sowohl von der IDE als auch von `dart analyze` unterstützt wird. Seit Dart 3.11 verwendet es einen AOT-Snapshot des Plugin-Einstiegspunkts wieder, was laut Changelog zu Beginn jeder IDE-Sitzung in der Größenordnung von 10 Sekunden spart. Wenn die Lints eine Portierung nicht wert sind, löschen Sie das Plugin und messen Sie den Unterschied; nach der Workspace-Umstellung ist das meist der größte einzelne Rückgang.

### 5. Den richtigen Ordner öffnen und reduzieren, was die IDE sieht

Öffnen Sie mit einem Workspace das Repo-Root in VS Code statt eines einzelnen App-Ordners, damit eine einzige Serversitzung alle Mitglieder abdeckt und paketübergreifende Navigation, Umbenennen und Find References im gesamten Repo funktionieren.

Zwei Dart-Code-Einstellungen sind wissenswert, und eine sollten Sie meiden:

```jsonc
// .vscode/settings.json (Dart-Code extension)
{
  // Folders the IDE analysis server ignores entirely, including for project detection.
  "dart.analysisExcludedFolders": [
    "tools/legacy_scripts",
    "third_party"
  ],
  // Keep SDK and dependency symbols out of Ctrl+T if workspace symbol search is slow.
  "dart.includeDependenciesInWorkspaceSymbols": false
}
```

`dart.analysisExcludedFolders` wirkt sich nur auf den Editor aus, verwenden Sie also bevorzugt `analyzer: exclude:` für alles, was auch `dart analyze` in der CI überspringen soll. Greifen Sie zur VS-Code-Einstellung, wenn ein Ordner in der CI analysiert bleiben soll, lokal aber nicht, etwa eine große archivierte App, die niemand in Ihrem Team bearbeitet.

Meiden Sie `dart.onlyAnalyzeProjectsWithOpenFiles`. Die Einstellung ist veraltet, und ihre eigene Beschreibung warnt, sie "kann die Performance beim Wechseln innerhalb eines Projekts deutlich verschlechtern", weil der Server beim Wechseln zwischen Dateien ständig Kontexte abbaut und neu aufbaut.

## Wenn es immer noch langsam ist

Zeigt die Seite Contexts einen einzigen Kontext und ist generierter Code ausgeschlossen, dann entstehen die verbleibenden Kosten durch echten Code. Ein paar Dinge, die Sie prüfen sollten:

- **Zirkuläre oder sehr breite Barrel-Exporte.** Eine Barrel-Datei, die ein ganzes Paket re-exportiert, macht jeden Importeur von jeder Datei darin abhängig, sodass eine Änderung weit mehr invalidiert als nötig. Importieren Sie innerhalb eines Pakets über `src/`-Pfade und behalten Sie Barrels für die öffentliche API.
- **Ein Mega-Paket.** Ein `app`-Paket mit 3.000 Dateien in Features aufzuteilen verringert die Gesamtarbeit nicht, erlaubt dem Server aber, nach einer Änderung die erneute Analyse nicht betroffener Bibliotheken zu überspringen.
- **Ein Serverneustart nach großen Git-Operationen.** Ein Branch-Wechsel, der Hunderte Dateien berührt, stellt viel Arbeit in die Warteschlange. **Dart: Restart Analysis Server** ist in manchen Fällen schneller, als auf die inkrementelle Invalidierung zu warten.
- **Instrumentierung für einen Fehlerbericht.** Setzen Sie `dart.analyzerInstrumentationLogFile` auf einen Pfad, reproduzieren Sie das Problem und hängen Sie die Datei an ein Issue auf [dart-lang/sdk](https://github.com/dart-lang/sdk/issues) an. Die oben genannten Regressionen wurden auf diese Weise gefunden.

Es sind dieselben Kontexte, die `dart fix` durchläuft, weshalb auch [dart fix über das gesamte Repo laufen zu lassen](/de/2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations/) nach der Workspace-Umstellung schneller wird. Und wenn Sie einen KI-Agenten über [den Dart- und Flutter-MCP-Server](/de/2026/05/dart-flutter-mcp-server-claude-code-cursor/) auf das Repo loslassen, spricht auch dieser mit einem Analyseserver, sodass ein schlankeres Kontextlayout dort ebenso hilft wie in Ihrem Editor.

## Quellen

- [Pub workspaces (monorepo support)](https://dart.dev/tools/pub/workspaces), dart.dev
- [Customizing static analysis](https://dart.dev/tools/analysis), dart.dev
- [Analyzer plugins](https://dart.dev/tools/analyzer-plugins), dart.dev
- [Dart SDK CHANGELOG](https://github.com/dart-lang/sdk/blob/main/CHANGELOG.md), Einträge für 3.10.0, 3.11.0, 3.11.1, 3.12.0 und 3.13.2
- [Referenz der Dart-Code-Einstellungen](https://dartcode.org/docs/settings/)
- [dart-lang/sdk#53874: reduce the number of analysis contexts](https://github.com/dart-lang/sdk/issues/53874)
- [Melos-Changelog, 7.0.0](https://pub.dev/packages/melos/changelog)
