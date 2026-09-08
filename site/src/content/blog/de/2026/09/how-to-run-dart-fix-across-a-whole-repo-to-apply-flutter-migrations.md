---
title: "dart fix über ein ganzes Repository laufen lassen, um Flutter-Breaking-Change-Migrationen anzuwenden"
description: "dart fix nimmt genau ein Zielverzeichnis, und das darf das Repository-Root sein: Der Analyzer öffnet pro verschachtelter pubspec.yaml einen Kontext und migriert alle Pakete in einem Durchlauf. Hier sind die vollständige Flag-Oberfläche, die vier Dinge, die Korrekturen unterdrücken und ein schmutziges Repo Nothing to fix melden lassen, warum der Exit-Code in der CI nutzlos ist, und ein Fall, in dem eine Flutter-Transformation Code erzeugt, der nicht kompiliert."
pubDate: 2026-09-08
template: how-to
tags:
  - "flutter"
  - "dart"
  - "migration"
  - "tooling"
  - "how-to"
lang: "de"
translationOf: "2026/09/how-to-run-dart-fix-across-a-whole-repo-to-apply-flutter-migrations"
translatedBy: "claude"
translationDate: 2026-09-08
---

`dart fix --apply` akzeptiert genau ein Zielverzeichnis, und dieses Verzeichnis darf das Root Ihres Repositorys sein. Der Analyzer öffnet für jede darunter verschachtelte `pubspec.yaml` einen eigenen Analysekontext, sodass ein Monorepo mit einem Dutzend Paketen mit einem einzigen Befehl migriert wird und dabei die jeweils eigene `analysis_options.yaml` jedes Pakets respektiert. Dass ein Durchlauf über das gesamte Repository so oft `Nothing to fix!` ausgibt, obwohl die Codebasis sichtbar voller Deprecation-Warnungen steckt, liegt nicht an einem defekten Werkzeug: Vier voneinander unabhängige Dinge unterdrücken Korrekturen, und `dart fix` beendet sich in jedem dieser Fälle mit 0. Einen Befehl `flutter fix` gibt es ebenfalls nicht, trotz der Dokumentationsseite namens Flutter fix. Alles Folgende lief unter Flutter 3.44.8 mit Dart 3.12.2; die Befehlsoberfläche und die hier zitierten Interna sind im main-Branch des Dart SDK, der die aktuelle stabile Linie Flutter 3.47 speist, unverändert.

## Die gesamte Befehlsoberfläche besteht aus vier Flags

Bevor Sie um dieses Werkzeug herum einen Workflow für das ganze Repository entwerfen, hilft es zu wissen, wie wenig davon existiert:

```console
$ dart fix --help
Apply automated fixes to Dart source code.

This tool looks for and fixes analysis issues that have associated automated fixes.

To use the tool, run either 'dart fix --dry-run' for a preview of the proposed changes for a project, or 'dart fix --apply' to apply the changes.

Usage: dart fix [arguments]
-h, --help                      Print this usage information.
-n, --dry-run                   Preview the proposed changes but make no changes.
    --apply                     Apply the proposed changes.
    --code=<code1,code2,...>    Apply fixes for one (or more) diagnostic codes.
```

Das ist alles. Zwei versteckte Flags existieren in `pkg/dartdev/lib/src/commands/fix.dart` (`--compare-to-golden` für die Tests des SDK selbst und `--use-aot-snapshot`), und keines davon nützt Ihnen. Es gibt kein `--exclude`, keine Glob-Unterstützung, kein Argument für mehrere Pfade. Genau ein positionelles Ziel, eine Datei oder ein Verzeichnis, standardmäßig das aktuelle Verzeichnis. Übergeben Sie weder `--apply` noch `--dry-run` oder beides zugleich, gibt der Befehl die Verwendung aus und liefert 0 zurück, ohne etwas zu tun.

Das Zweite, was sich früh zu prüfen lohnt:

```console
$ flutter fix --dry-run
Could not find a command named "fix".
```

Die Dokumentationsseite [Flutter fix](https://docs.flutter.dev/tools/flutter-fix) beschreibt eine Funktion, keinen Befehl. Sie führen `dart fix` aus, und solange das `dart` in Ihrem `PATH` jenes aus dem Flutter SDK ist (`$FLUTTER_ROOT/bin/dart`), findet es die Migrationsdaten des Frameworks automatisch.

## Ein Durchlauf im Repository-Root erfasst jedes verschachtelte Paket

Das ist der Teil, den die meisten Teams falsch machen, meist indem sie eine `find`-Schleife schreiben, bevor sie prüfen, ob sie eine brauchen. Nehmen Sie einen Pub-Workspace mit drei Mitgliedern:

```yaml
# pubspec.yaml at the repo root, Dart 3.12.2
name: mono_root
environment:
  sdk: ^3.12.0
workspace:
  - packages/pkg_a
  - packages/pkg_b
  - apps/app
```

Ein Befehl im Root, ein Bericht über alle drei:

```console
$ dart fix --dry-run
Computing fixes in mono (dry run)...

6 proposed fixes in 3 files.

apps/app/lib/main.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_a/lib/a.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix

packages/pkg_b/lib/b.dart
  prefer_const_constructors - 1 fix
  prefer_final_locals - 1 fix
```

Das ist keine Workspace-Funktion. Zwei benachbarte Pakete ganz ohne `pubspec.yaml` im Root werden genauso behandelt, denn der Analyzer findet Kontextwurzeln, indem er den Verzeichnisbaum nach `pubspec.yaml`- und `analysis_options.yaml`-Dateien durchläuft. Jedes Paket behält während dieses einen Durchlaufs seine eigene Lint-Konfiguration, sodass ein Paket, das `prefer_final_locals` aktiviert, diese Korrekturen erhält und sein Nachbar nicht.

`dart fix` iteriert außerdem. `FixCommand.maxPasses` ist 4, und die gesamte Berechnung läuft erneut, bis keine Änderungen mehr entstehen oder diese Obergrenze erreicht ist. Der Effekt zeigt sich in einer einzigen Anweisung: `var b = Box(1);` wird zu `final b = const Box(1);`, wofür `prefer_final_locals` und `prefer_const_constructors` in getrennten Durchläufen über dieselbe Zeile greifen müssen.

## Warum ein Paket "Nothing to fix!" meldet, obwohl es voller veralteter APIs ist

Vier verschiedene Mechanismen erzeugen dieselbe Ausgabe und denselben Exit-Code. Schließen Sie sie in dieser Reihenfolge aus.

**Das Paket ist nicht aufgelöst.** `dart fix` braucht eine `.dart_tool/package_config.json`, um zu wissen, was `package:lib_pkg/api.dart` bedeutet, und ohne sie gibt es keine `deprecated_member_use`-Diagnose, an die sich eine Korrektur hängen ließe. Gleiches Repository, gleiche Datei, vor und nach einem `pub get`:

```console
$ dart fix --dry-run          # no pub get yet
Computing fixes in app (dry run)...
Nothing to fix!

$ dart pub get && dart fix --dry-run
Computing fixes in app (dry run)...

1 proposed fix in 1 file.

lib/main.dart
  deprecated_member_use - 1 fix
```

In einem Monorepo ist das der übliche Schuldige: Die CI hat die App aufgelöst, aber nicht die sechs Blattpakete, sodass die Migration stillschweigend nur einen Bruchteil des Baums abdeckt.

**Die Dateien sind von der Analyse ausgeschlossen.** Eine `exclude`-Liste, typischerweise vor Jahren hinzugefügt, um generierten Code aus dem Lint-Bericht herauszuhalten, entfernt diese Dateien auch aus der Korrekturmenge:

```yaml
# analysis_options.yaml
analyzer:
  exclude:
    - lib/main.dart
```

```console
$ dart fix --dry-run
Nothing to fix!
```

**Die Diagnose ist auf `ignore` herabgestuft.** Diese ist die schädlichste, weil sie der Standardgriff ist, wenn ein Flutter-Upgrade die CI mit Deprecation-Warnungen flutet:

```yaml
analyzer:
  errors:
    deprecated_member_use: ignore
```

Die Warnung stummzuschalten deaktiviert auch die zugehörige automatische Migration. Wenn Ihr Repo diese Zeile enthält, entfernen Sie sie vor dem `dart fix`, nicht danach.

**Die Zeile trägt einen `// ignore:`-Kommentar.** Gleicher Effekt, auf Datei- oder Zeilenebene. Ein `// ignore_for_file: deprecated_member_use` am Anfang einer großen Widget-Datei lässt `dart fix` die gesamte Datei kommentarlos überspringen.

Für Lint-getriebene Korrekturen gibt es einen fünften Fall, der Absicht ist und keine Falle: Eine Korrektur existiert nur, wenn der Lint aktiviert ist. `--code` setzt sich darüber nicht hinweg.

```console
$ dart fix --dry-run --code=prefer_final_locals   # lint not in analysis_options.yaml
Nothing to fix!
```

Fügen Sie die Regel hinzu, und derselbe Befehl findet die Korrektur. Daraus ergibt sich ein nützliches Einmalmuster: einen Aufräum-Lint vorübergehend aktivieren, `dart fix --apply --code=<dieser Lint>` ausführen und dann entscheiden, ob die Regel aktiviert bleibt.

Keiner dieser fünf Fälle ändert den Exit-Status. Jeder Durchlauf oben lieferte 0. Der einzige Aufruf, der ungleich null zurückgibt, ist ein unbekannter Diagnosecode:

```console
$ dart fix --apply --code=this_is_not_a_real_code
Computing fixes in app...
Unable to compute fixes: The diagnostic 'this_is_not_a_real_code' is not defined by the analyzer.
$ echo $?
3
```

Das ist wissenswert, denn es bedeutet, dass ein Tippfehler in einem CI-Skript laut scheitert, statt die Migration zu überspringen.

## Der Durchlauf über das ganze Repository, der Reihe nach

1. **Zuerst das SDK aktualisieren, dann die Unterdrücker entfernen.** Deprecation-Transformationen existieren nur für APIs, die der Analyzer als veraltet erkennt, also kommt `flutter upgrade` zuerst. Suchen Sie danach in jeder `analysis_options.yaml` nach `deprecated_member_use: ignore` und in `lib/` nach `ignore_for_file: deprecated_member_use`, und löschen Sie beides. Überspringen Sie das, melden die Schritte 3 und 4 ein sauberes Repo.

2. **Jedes Paket auflösen.** Innerhalb eines Pub-Workspace löst ein einziges `dart pub get` an beliebiger Stelle alles auf (in einem Mitgliedspaket ausgeführt, gibt es `Resolving dependencies in /path/to/root` aus und schreibt das `.dart_tool` des Roots). Außerhalb eines Workspace braucht jedes Paket mit eigener Auflösung sein eigenes `pub get`.

3. **Einmal im Root laufen lassen und den Bericht lesen.** `dart fix --dry-run` vom Repository-Root aus, und prüfen Sie, ob die Dateiliste jedes erwartete Paket nennt. Ein im Bericht fehlendes Paket ist ein Paket, das an Schritt 2 gescheitert oder von der Analyse ausgeschlossen ist, kein sauberes.

4. **Erst wenn Schritt 3 zu kurz greift, auf eine Schleife pro Paket ausweichen.** Für Repos, in denen sich Pakete nicht von einer Stelle aus auflösen lassen, deckt das alles ab und ist idempotent:

   ```bash
   #!/usr/bin/env bash
   # tool/dart_fix_repo.sh - Flutter 3.44.8, Dart 3.12.2
   set -euo pipefail

   find . -name pubspec.yaml \
     -not -path '*/.*' \
     -not -path '*/build/*' \
     -not -path '*/ephemeral/*' \
     -print | while read -r manifest; do
       pkg=$(dirname "$manifest")
       echo "==> $pkg"
       ( cd "$pkg" && dart pub get >/dev/null && dart fix --apply "$@" )
     done

   dart format .
   ```

   Die `-not -path`-Filter sind wichtig: `build/` und die `ephemeral/`-Verzeichnisse unter `windows/`, `linux/` und `macos/` enthalten generierte `pubspec.yaml`-Dateien, die Sie nicht anfassen wollen. Wenn Sie bereits [Melos](https://melos.invertase.dev/) einsetzen, erledigt `melos exec -- "dart pub get && dart fix --apply"` dasselbe mit den Filter-Flags, die Sie ohnehin konfiguriert haben.

5. **Formatieren, dann analysieren, dann die Tests ausführen.** In dieser Reihenfolge, und lassen Sie den letzten Punkt nicht aus. Details weiter unten.

## Eine Diagnose pro Commit

Ein `dart fix --apply`-Diff über 400 Dateien ist nicht reviewbar. `--code` nimmt eine kommaseparierte Liste, teilen Sie den Durchlauf also in Commits auf, die ein Mensch tatsächlich lesen kann:

```bash
dart fix --apply --code=deprecated_member_use
git commit -am "chore: apply Flutter deprecation migrations via dart fix"

dart fix --apply --code=prefer_const_constructors,prefer_const_literals_to_create_immutables
git commit -am "chore: const cleanup via dart fix"
```

Der Dry-Run-Bericht druckt die exakten Befehle für die gefundenen Codes, was diese Planung billig macht.

## Woher die Migrationen kommen

Deprecation-Korrekturen sind Daten, keine Compiler-Logik. Ein Paket deklariert sie in `lib/fix_data.yaml`, und der Analyzer liest sie aus jeder aufgelösten Abhängigkeit. In Flutter 3.44.8 liefert das Framework 30 solcher Dateien unter `packages/flutter/lib/fix_data/` mit 381 Transformationen aus, dazu 8 in `flutter_test`, 2 in `flutter_driver` und 1 in `integration_test`. Die Änderungsarten nach Häufigkeit in `package:flutter`: 418 `removeParameter`, 228 `addParameter`, 204 `fragment`, 158 `rename`, 90 `renameParameter`, 16 `import`, 12 `addTypeParameter`, 11 `replacedBy`, 1 `changeParameterType`.

Derselbe Mechanismus steht Ihren eigenen internen Paketen offen, und das ist der wirkungsvollste Punkt dieses Artikels, wenn Sie ein gemeinsames Design-System pflegen. Markieren Sie das alte Mitglied als veraltet und beschreiben Sie dann die Umschreibung:

```dart
// lib_pkg/lib/api.dart
class Report {
  @Deprecated('Use render() instead. Removed in lib_pkg 3.0.0.')
  String toHtml() => render();
  String render() => '<html/>';
}
```

```yaml
# lib_pkg/lib/fix_data.yaml - Dart 3.12.2
version: 1
transforms:
  - title: "Rename to 'render'"
    date: 2026-09-01
    element:
      uris: ['api.dart']
      method: 'toHtml'
      inClass: 'Report'
    changes:
      - kind: 'rename'
        newName: 'render'
```

Jeder Konsument, der nach dem Anheben der Abhängigkeit `dart fix --apply` ausführt, bekommt `r.toHtml()` zu `r.render()` umgeschrieben. Die `uris`-Liste muss den öffentlichen Bibliothekspfad enthalten, den Konsumenten importieren, nicht die Datei unter `src/`, in der die Klasse deklariert ist. Dieses eine Detail ist der häufigste Grund, warum eine handgeschriebene `fix_data.yaml` nichts bewirkt.

## dart fix ist kein Compiler und liefert Ihnen Code, der nicht baut

Deshalb endet Schritt 5 oben mit analysieren und testen statt mit committen. Ein minimales Widget, das zwei veraltete Flutter-APIs verwendet:

```dart
// Flutter 3.44.8, Dart 3.12.2
import 'package:flutter/material.dart';

class Card1 extends StatelessWidget {
  const Card1({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.black.withOpacity(0.5),
      child: ListView(
        cacheExtent: 250.0,
        children: const [Text('hi')],
      ),
    );
  }
}
```

`dart fix --apply` meldet `deprecated_member_use - 2 fixes` und schreibt beide um. Die `withOpacity`-Transformation ist korrekt. Die für `cacheExtent` nicht:

```dart
color: Colors.black.withValues(alpha: 0.5),
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0), children: const [Text('hi')],
),
```

```console
$ flutter analyze
error - Undefined name 'ScrollCacheExtent'. Try correcting the name to one that is defined,
        or defining the name - lib/main.dart:11:28 - undefined_identifier
```

`ScrollCacheExtent` ist in `packages/flutter/lib/src/rendering/viewport.dart` deklariert und wird nur aus `package:flutter/rendering.dart` exportiert. Weder `material.dart` noch `widgets.dart` reexportieren es, und die Transformation in `fix_widgets.yaml` verwendet `addParameter` ohne begleitende `import`-Änderung. Die Umschreibung ist semantisch richtig, und die Datei kompiliert nicht mehr. Ein `import 'package:flutter/rendering.dart';` behebt das, und `flutter analyze` wird grün.

Dieses Fehlermuster verallgemeinert sich. `dart fix` bearbeitet in YAML beschriebene Token-Bereiche; es typprüft das Ergebnis nicht und weiß nicht, ob das gerade geschriebene Symbol im Gültigkeitsbereich liegt. Verhaltensänderungen sind hier schlimmer als Kompilierfehler, weil sie niemand auffängt, und genau deshalb brauchen die [Aufteilung der Material- und Cupertino-Pakete](/de/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/) und die [Umstellung von Radio auf RadioGroup](/de/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/) nach dem automatischen Durchlauf einen Testlauf und nicht nur ein Analyze.

Ein Trost: Eine Datei mit einem Syntaxfehler vergiftet den Durchlauf nicht. `dart fix` berechnet und wendet Korrekturen in allen anderen Dateien desselben Pakets weiterhin an.

## Lassen Sie immer dart format folgen

Das Werkzeug wendet Änderungen an, es formatiert das Ergebnis nicht neu. Beachten Sie, wo `children` oben gelandet ist. `dart format .` stellt es wieder her:

```dart
child: ListView(
  scrollCacheExtent: ScrollCacheExtent.pixels(250.0),
  children: const [Text('hi')],
),
```

Legen Sie den Formatierungsschritt in denselben Commit wie die Korrektur, sonst erledigt ihn der Editor der nächsten Person und die Blame-Historie wird schlechter.

## Absicherung in der CI

Weil der Exit-Code immer 0 ist, muss eine CI-Prüfung stattdessen den Arbeitsbaum betrachten. Wenden Sie die Korrekturen an und lassen Sie git entscheiden:

```yaml
# .github/workflows/analyze.yml
- run: dart pub get
- run: dart fix --apply
- run: git diff --exit-code
```

Lokal verifiziert: Mit einer im Branch committeten offenen Korrektur liefert `git diff --exit-code` 1 und der Job schlägt fehl; ohne offene Korrektur liefert er 0. Kombinieren Sie das mit einer Matrix, wenn Sie [gegen mehr als eine Flutter-Version bauen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), denn die verfügbaren Transformationen unterscheiden sich je SDK, und eine unter 3.47 offene Korrektur existiert unter 3.44 womöglich gar nicht.

Der Workflow, der über eine mehrjährige Codebasis wirklich trägt, ist langweilig: SDK aktualisieren, Unterdrücker löschen, alles auflösen, Dry Run im Root, einen Diagnosecode nach dem anderen anwenden, formatieren, analysieren, testen, committen. Die 392 Transformationen des Frameworks übernehmen den größten Teil der Tipparbeit. Den Teil, den sie nicht übernehmen können, ist der, in dem Sie das Diff lesen.

## Verwandte Beiträge

- [Material- und Cupertino-Importe in Flutter auf die Pakete material_ui und cupertino_ui migrieren](/de/2026/09/migrate-flutter-material-and-cupertino-imports-to-standalone-packages/)
- [Eine Flutter-Web-App von dart:html auf package:web und dart:js_interop migrieren](/de/2026/09/migrate-a-flutter-web-app-from-dart-html-to-package-web/)
- [Veraltetes groupValue und onChanged von Radio in Flutter durch RadioGroup ersetzen](/de/2026/08/how-to-replace-flutter-deprecated-radio-groupvalue-and-onchanged-with-radiogroup/)
- [Eine Flutter-2-App auf Flutter 3.x migrieren: die Null-Safety-Checkliste](/de/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/)
- [Wie Sie aus einer einzigen CI-Pipeline mehrere Flutter-Versionen ansteuern](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## Quellen

- [dart fix](https://dart.dev/tools/dart-fix), Dart-Werkzeugdokumentation
- [Flutter fix](https://docs.flutter.dev/tools/flutter-fix), Flutter-Werkzeugdokumentation
- [Breaking changes and migration guides](https://docs.flutter.dev/release/breaking-changes), Flutter-Release-Dokumentation
- [`pkg/dartdev/lib/src/commands/fix.dart`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/lib/src/commands/fix.dart), Dart SDK
- [`pkg/dartdev/doc/dart-fix.md`](https://github.com/dart-lang/sdk/blob/main/pkg/dartdev/doc/dart-fix.md), Dart SDK
- [Data driven fixes](https://dart.dev/go/data-driven-fixes), Dart-Spezifikation für `fix_data.yaml`
- [Pub workspaces](https://dart.dev/tools/pub/workspaces), Dart-Dokumentation zur Paketverwaltung
- [Customizing static analysis](https://dart.dev/tools/analysis), Dokumentation des Dart-Analyzers
