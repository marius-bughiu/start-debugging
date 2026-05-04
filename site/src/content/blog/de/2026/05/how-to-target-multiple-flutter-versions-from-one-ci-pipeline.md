---
title: "Wie Sie aus einer einzigen CI-Pipeline mehrere Flutter-Versionen ansteuern"
description: "Praktische Anleitung zum Ausführen eines Flutter-Projekts gegen mehrere SDK-Versionen in der CI: eine GitHub-Actions-Matrix mit subosito/flutter-action v2, FVM-3-.fvmrc als Quelle der Wahrheit, Channel-Pinning, Caching und die Stolperfallen, die zubeißen, wenn die Matrix über drei Versionen hinauswächst."
pubDate: 2026-05-04
template: how-to
tags:
  - "flutter"
  - "dart"
  - "ci"
  - "github-actions"
  - "fvm"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline"
translatedBy: "claude"
translationDate: 2026-05-04
---

Kurze Antwort: Pinnen Sie die primäre Flutter-Version des Projekts in `.fvmrc` (FVM-3-Stil) und nutzen Sie diese Datei als Quelle der Wahrheit für die lokale Entwicklung. In der CI führen Sie einen `strategy.matrix`-Job über die zusätzlichen Flutter-Versionen aus, die Sie interessieren, installieren jede mit `subosito/flutter-action@v2` (es liest `flutter-version-file: .fvmrc` für den primären Build und akzeptiert ein explizites `flutter-version: ${{ matrix.flutter-version }}` für die Matrix-Einträge), aktivieren sowohl `cache: true` als auch `pub-cache: true` und schützen die Matrix mit `fail-fast: false`, damit eine einzelne kaputte Version die anderen nicht verbirgt. Behandeln Sie die primäre Version als verpflichtend und die Matrix-Versionen als informativ, bis Sie sie stabilisiert haben.

Diese Anleitung gilt für Flutter-3.x-Projekte im Mai 2026, validiert gegen `subosito/flutter-action@v2` (neueste v2.x), FVM 3.2.x und Flutter SDK 3.27.x und 3.32.x auf von GitHub gehosteten Ubuntu- und macOS-Runnern. Sie nimmt ein Repo, eine `pubspec.yaml` und das Ziel an, Regressionen über Flutter-Versionen hinweg zu fangen, bevor sie einen Release-Branch erreichen. Die Muster lassen sich mit kleinen Syntaxänderungen auf GitLab CI und Bitbucket Pipelines übertragen; die Matrix-Konzepte sind identisch.

## Warum ein Repo gegen mehrere Flutter-Versionen überhaupt eine Sache ist

Flutter hat zwei Release-Channels, `stable` und `beta`, und nur `stable` wird in der Produktion unterstützt. Die Flutter-Dokumentation empfiehlt stable für neue Nutzer und für Produktions-Releases, was korrekt ist, und es wäre schön, wenn jedes Team einen stabilen Patch wählen und dabeibleiben könnte. In der Praxis drücken drei Kräfte Teams von diesem Pfad ab:

1. Ein Paket, von dem Sie abhängen, hebt seine `environment.flutter`-Untergrenze an, und die neue Untergrenze liegt einen Minor vor Ihrer aktuellen Version.
2. Ein neues stable landet mit einem Impeller-Fix oder einem iOS-Build-Fix, den Sie brauchen, aber ein transitives Paket hat sich noch nicht dagegen zertifiziert.
3. Sie liefern eine Bibliothek oder ein Template (ein Starter-Kit, ein internes Design-System), das Downstream-Apps auf der Flutter-Version konsumieren, auf die ihr Team standardisiert hat, und Sie müssen wissen, dass es unter keiner von `stable - 1`, `stable` oder `beta` bricht.

In allen drei Fällen ist die Antwort dieselbe langweilige Disziplin: Wählen Sie eine Version als Vertrag für die Entwicklermaschinen und behandeln Sie jede andere Version, die Ihnen wichtig ist, als CI-Matrix-Eintrag. Das ist das Modell, auf dem der Rest dieses Posts aufbaut.

Eine kurze Erinnerung daran, was `pubspec.yaml` tatsächlich erzwingt. Die `environment.flutter`-Einschränkung wird von `pub` nur als Untergrenze geprüft. Wie in [flutter/flutter#107364](https://github.com/flutter/flutter/issues/107364) und [#113169](https://github.com/flutter/flutter/issues/113169) beschrieben, erzwingt das SDK die Obergrenze der `flutter:`-Einschränkung nicht, sodass das Schreiben von `flutter: ">=3.27.0 <3.33.0"` einen Entwickler auf Flutter 3.40 nicht davon abhält, Ihr Paket zu installieren. Sie brauchen einen externen Mechanismus. Dieser Mechanismus ist FVM für Menschen und `flutter-action` für die CI.

## Schritt 1: Machen Sie `.fvmrc` zur Quelle der Wahrheit des Projekts

Installieren Sie [FVM 3](https://fvm.app/) einmal pro Arbeitsplatz und pinnen Sie dann das Projekt aus dem Repo-Root:

```bash
# FVM 3.2.x, May 2026
dart pub global activate fvm
fvm install 3.32.0
fvm use 3.32.0
```

`fvm use` schreibt `.fvmrc` und aktualisiert `.gitignore`, damit das schwere `.fvm/`-Verzeichnis nicht commitet wird. Gemäß der [FVM-Konfigurationsdokumentation](https://fvm.app/documentation/getting-started/configuration) gehört nur `.fvmrc` (und das veraltete `fvm_config.json`, falls Sie eines aus FVM 2 haben) in die Versionsverwaltung. Commiten Sie es, und die Datei wird zum Vertrag, den jeder Entwickler und jeder CI-Job liest.

Eine minimale `.fvmrc` sieht so aus:

```json
{
  "flutter": "3.32.0",
  "flavors": {
    "next": "3.33.0-1.0.pre",
    "edge": "beta"
  },
  "updateVscodeSettings": true,
  "updateGitIgnore": true
}
```

Die `flavors`-Map ist das FVM-Konzept, das perfekt auf eine CI-Matrix abbildet: Jeder Eintrag ist eine benannte Flutter-Version, die Ihr Projekt toleriert. `next` ist das kommende stable, für das Sie grünes Licht haben wollen, `edge` ist der aktive beta-Channel als Frühwarnsignal. Lokal kann ein Entwickler `fvm use next` ausführen, um vor dem Öffnen eines PR einen Sanity-Check zu machen. In der CI iterieren Sie dieselben Flavor-Namen aus der Matrix, sodass die Namen konsistent bleiben.

## Schritt 2: Ein Workflow, ein primärer Build, ein Matrix-Job

Die Falle, in die die meisten Teams beim ersten Versuch tappen, ist, jede Flutter-Version in dieselbe Matrix zu stecken und alle als verpflichtend zu behandeln. Das lässt die Laufzeit explodieren und macht aus einer flackernden beta einen roten main-Branch. Das Muster, das skaliert, sind zwei Jobs in derselben Workflow-Datei:

- Ein **primärer** Job, der nur die Version aus `.fvmrc` installiert und die volle Test-, Build- und Ship-Pipeline ausführt. Er wird durch Branch Protection erzwungen.
- Ein **Kompatibilitäts**-Matrix-Job, der jede zusätzliche Version installiert, den Analyzer und die Tests ausführt und informativ ist, bis Sie ihm vertrauen.

Hier ist der Workflow, mit v6 von `actions/checkout` (aktuell im Mai 2026) und `subosito/flutter-action@v2`:

```yaml
# .github/workflows/flutter-ci.yml
name: Flutter CI

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: flutter-ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  primary:
    name: Primary (.fvmrc)
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          flutter-version-file: .fvmrc
          channel: stable
          cache: true
          pub-cache: true
      - run: flutter --version
      - run: flutter pub get
      - run: dart format --output=none --set-exit-if-changed .
      - run: flutter analyze
      - run: flutter test --coverage

  compat:
    name: Compat (Flutter ${{ matrix.flutter-version }})
    needs: primary
    runs-on: ${{ matrix.os }}
    timeout-minutes: 20
    continue-on-error: ${{ matrix.experimental }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - flutter-version: "3.27.4"
            channel: stable
            os: ubuntu-latest
            experimental: false
          - flutter-version: "3.32.0"
            channel: stable
            os: macos-latest
            experimental: false
          - flutter-version: "3.33.0-1.0.pre"
            channel: beta
            os: ubuntu-latest
            experimental: true
    steps:
      - uses: actions/checkout@v6
      - uses: subosito/flutter-action@v2
        with:
          flutter-version: ${{ matrix.flutter-version }}
          channel: ${{ matrix.channel }}
          cache: true
          pub-cache: true
      - run: flutter pub get
      - run: flutter analyze
      - run: flutter test
```

Einige Dinge in dieser Datei sind absichtlich gewählt und es lohnt sich, sie hervorzuheben, bevor Sie sie kopieren.

**`fail-fast: false`** ist Pflicht für eine Kompatibilitäts-Matrix. Ohne das stoppt die erste fehlgeschlagene Version die anderen, was den Sinn untergräbt. Sie wollen in einem CI-Lauf sehen, dass 3.27 besteht, 3.32 fehlschlägt und beta besteht, nicht nur "etwas ist fehlgeschlagen".

**`continue-on-error` pro Matrix-Eintrag** lässt Sie beta als toleriertes Rot markieren. Branch Protection sollte den Check-Namen `Primary (.fvmrc)` und alle Kompatibilitätseinträge fordern, die Sie als verpflichtend klassifiziert haben. Beta und "next" bleiben grün-ish auf dem Dashboard, blockieren aber nie einen Merge.

**`needs: primary`** ist ein kleines, aber wichtiges Sequenzierungsdetail. Es bedeutet, dass keine CI-Minuten in der Matrix verbrannt werden, bis der primäre Build beweist, dass die Änderung zumindest syntaktisch sinnvoll ist. Bei einer 30-Job-Matrix zählt das. Bei einer 3-Job-Matrix ist es immer noch ein kostenloser Gewinn.

**`concurrency`** bricht laufende Läufe auf derselben Ref ab, wenn ein neuer Commit landet. Ohne das zahlt ein Entwickler, der dreimal pro Minute pusht, für drei vollständige Matrix-Läufe.

## Schritt 3: Caching, das tatsächlich über Versionen hinweg trifft

`subosito/flutter-action@v2` cacht die Flutter-SDK-Installation intern mit `actions/cache@v5`. Jede einzigartige Kombination von `(os, channel, version, arch)` erzeugt einen separaten Cache-Eintrag, was genau das ist, was Sie wollen. Der Standard-Cache-Key ist eine Funktion dieser Tokens, also erzeugt eine 3-Versions-Matrix 3 SDK-Caches und eine 2-OS-mal-3-Versionen-Matrix erzeugt 6. Das ist in Ordnung, bis Sie anfangen zu individualisieren.

Die zwei Stellschrauben, die es zu kennen lohnt:

- `cache: true` cacht das SDK selbst. Spart etwa 90 Sekunden pro Lauf auf Ubuntu, mehr auf macOS, wo die Installation Xcode-bezogene Artefakte zieht.
- `pub-cache: true` cacht `~/.pub-cache`. Das ist der größere Gewinn für inkrementelle Änderungen. Eine typische Flutter-App mit 80 transitiven Paketen braucht 25-40 Sekunden für `pub get` kalt, weniger als 5 Sekunden warm.

Wenn Sie ein Monorepo mit mehreren Flutter-Projekten haben, die Abhängigkeiten teilen, setzen Sie einen `cache-key` und `pub-cache-key`, die den Hash aller relevanten `pubspec.lock`-Dateien einschließen, nicht nur den Default. Sonst überschreibt jedes Subprojekt den Cache der anderen. Die Action stellt die Tokens `:hash:` und `:sha256:` genau dafür bereit; sehen Sie das [README](https://github.com/subosito/flutter-action) für die Syntax.

Was **nicht** in Ihren Matrix-Cache-Key gehört, ist der Name des Flutter-SDK-Channels, wenn Sie auf einen `*-pre`-Build pinnen. Beta-Tags werden gelegentlich neu gebaut, also kann ein Cache-Treffer auf einer `*-pre`-Version eine veraltete Binärdatei zurückgeben. Die einfachste Lösung ist, das Caching für die `experimental: true`-Einträge zu überspringen:

```yaml
- uses: subosito/flutter-action@v2
  with:
    flutter-version: ${{ matrix.flutter-version }}
    channel: ${{ matrix.channel }}
    cache: ${{ !matrix.experimental }}
    pub-cache: ${{ !matrix.experimental }}
```

Sie geben eine Minute Installationszeit beim beta-Eintrag auf und gewinnen Vertrauen, dass der beta-Build reproduzierbar ist.

## Schritt 4: Verdrahten Sie `.fvmrc` und die Matrix

Der Sinn von FVM-Flavors plus einer Matrix ist, dass die Namen übereinstimmen. Ein neues Kompatibilitätsziel hinzuzufügen sollte eine Ein-Zeilen-Änderung in `.fvmrc` und eine Ein-Zeilen-Änderung im Workflow sein. Um sie ohne manuelle Koordination synchron zu halten, generieren Sie die Matrix zur Job-Zeit aus der Datei. GitHub Actions kann das mit einem kleinen Bootstrap-Job tun, der eine JSON-Matrix ausgibt:

```yaml
  matrix-builder:
    name: Build matrix from .fvmrc
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.build.outputs.matrix }}
    steps:
      - uses: actions/checkout@v6
      - id: build
        run: |
          MATRIX=$(jq -c '
            {
              include: (
                .flavors // {} | to_entries
                | map({
                    "flutter-version": .value,
                    "channel": (if (.value | test("pre|dev")) then "beta" else "stable" end),
                    "os": "ubuntu-latest",
                    "experimental": (.key == "edge")
                  })
              )
            }' .fvmrc)
          echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"

  compat:
    needs: [primary, matrix-builder]
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix: ${{ fromJson(needs.matrix-builder.outputs.matrix) }}
    # ... same steps as before
```

Jetzt fügt das Hinzufügen von `"perf-investigation": "3.31.2"` zu `.fvmrc` automatisch beim nächsten CI-Lauf einen Kompatibilitäts-Job hinzu. Keine zweite Quelle der Wahrheit, keine Abweichung zwischen dem, was lokales FVM versucht, und dem, was die CI verifiziert. Die GitHub Action `flutter-actions/pubspec-matrix-action` macht etwas Ähnliches, falls Sie lieber eine gepflegte Abhängigkeit als das Inline-`jq` verwenden; beide Ansätze funktionieren.

## Stolperfallen, die nach dem zweiten Matrix-Eintrag auftauchen

Sobald die Matrix mehr als drei Versionen hat, werden Sie auf mindestens eines davon stoßen.

**Pub-Cache-Vergiftung.** Ein Paket, das bedingte Imports für neuere Flutter-Symbole verwendet, kann auf 3.27 gegenüber 3.32 unterschiedlich aufgelöst werden. Wenn beide Versionen sich einen `pub-cache` teilen, kann die von 3.32 geschriebene Lock-Datei an 3.27 zurückgegeben werden und einen Build erzeugen, der mit dem falschen Code-Pfad "funktioniert". Verwenden Sie einen `pub-cache-key`, der den Flutter-Versions-Token (`:version:`) enthält, um sie getrennt zu halten. Die Kosten sind ein kälterer Cache; der Nutzen ist Reproduzierbarkeit.

**`pubspec.lock`-Churn.** Wenn Sie `pubspec.lock` commiten (für App-Repos empfohlen, nicht für Bibliotheken), wird die Matrix sie pro Flutter-Version unterschiedlich neu erzeugen, und ein Entwickler, der auf der Version aus `.fvmrc` läuft, wird ein anderes Lock sehen als die CI-Matrix-Einträge. Die Lösung ist, das Lock-Writeback im Matrix-Job zu überspringen: Übergeben Sie `--enforce-lockfile` an `flutter pub get`, was bei Auflösungs-Divergenz fehlschlägt, statt das Lock zu mutieren. Wenden Sie das nur im Matrix-Job an; der primäre Job sollte weiterhin Updates erlauben, damit Renovate- oder Dependabot-PRs grün werden können.

**iOS-Builds und Beta-Channel.** `subosito/flutter-action@v2` installiert das Flutter-SDK, ändert aber nicht die Xcode-Version auf `macos-latest`. Das Xcode des Runners wird in einer anderen Kadenz aktualisiert als der Beta-Channel von Flutter, und Flutter beta wird gelegentlich ein Xcode benötigen, das der Runner noch nicht ausliefert. Wenn der iOS-Build-Schritt (`flutter build ipa --no-codesign`) nur auf beta zu fehlschlagen beginnt, prüfen Sie das Xcode des Runners gegen die [`flutter doctor`](https://docs.flutter.dev/get-started/install)-Anforderungen, bevor Sie annehmen, dass Ihr Code kaputt ist. Den Runner mit `runs-on: macos-15` statt `macos-latest` zu pinnen, gibt Ihnen Kontrolle über diese Variable.

**Architektur-Defaults.** Stand Mai 2026 sind von GitHub gehostete Runner standardmäßig ARM64 auf macOS und x64 auf Ubuntu. Wenn Sie native Plugins bauen, ist der Architektur-Token im Cache-Key wichtig; sonst kann ein Apple-Silicon-Cache bei einer zukünftigen Migration einem x64-Runner ausgeliefert werden. Der Standard-`cache-key` der Action enthält `:arch:` aus diesem Grund; entfernen Sie ihn nicht, wenn Sie individualisieren.

**Dart-SDK-Drift.** Jede Flutter-Version liefert ein bestimmtes Dart-SDK aus. Ein `dart format`-Lauf auf Flutter 3.32 (Dart 3.7) erzeugt in einigen Edge-Cases andere Formatierung als Flutter 3.27 (Dart 3.5). Führen Sie die Formatierung nur im primären Job aus, nicht in der Matrix, um falsche "format check failed"-Berichte auf älteren Versionen zu vermeiden. Dieselbe Logik gilt für Lints: Ein in Dart 3.7 eingeführter neuer Lint feuert auf 3.32 und nicht auf 3.27. Verwenden Sie eine Projekt-Level-`analysis_options.yaml` und aktivieren Sie neue Lints erst, wenn die älteste Matrix-Version sie unterstützt.

## Wann mit dem Hinzufügen von Versionen aufhören

Der Sinn all dessen ist, Regressionen früh zu fangen, nicht erschöpfend zu testen. Eine Matrix von mehr als drei oder vier Versionen bedeutet meist, dass das Team Angst vor dem Upgrade hat statt Vertrauen darin. Wenn Ihre Matrix auf fünf gewachsen ist, fragen Sie, welcher Eintrag in sechs Monaten keine Regression gefangen hat. Dieser Eintrag sollte wahrscheinlich pensioniert werden. Die richtige Kadenz für die meisten Apps ist `aktuelles stable`, `nächstes stable, sobald angekündigt` und `beta`, was bedeutet, dass das matrix-builder-Skript aus Schritt 4 sie durch das beschränkt, was `.fvmrc` deklariert.

Die Disziplin, die sich auszahlt, ist dieselbe, die [das reproduzierbare Pinnen des Flutter SDK](/de/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) überhaupt zum Funktionieren bringt: Deklarieren Sie die Versionen, die Ihnen wichtig sind, installieren Sie nur diese Versionen und behandeln Sie alles außerhalb dieses Sets als außerhalb des Vertrags. Die Matrix ist die Durchsetzung.

## Verwandt

- [Flutter 3.38.6 und der engine.version-Bump: Reproduzierbare Builds werden einfacher, wenn Sie es pinnen](/de/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) erläutert, warum das Pinnen des SDK auch innerhalb eines einzelnen Channels wichtig ist.
- [Dart-3.12-Dev-Tags bewegen sich schnell](/de/2026/01/dart-3-12-dev-tags-are-moving-fast-how-to-read-them-and-what-to-do-as-a-flutter-3-x-developer/) erklärt, wie die Dev-Tag-Kadenz von Dart mit Flutter-Channel-Entscheidungen interagiert.
- [Flutter iOS aus Windows debuggen](/de/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) ist das Begleitstück für Teams, deren CI macOS abdecken muss, deren Entwickler aber nicht täglich Macs nutzen.
- [FlutterGuard CLI: ein schneller "was kann ein Angreifer extrahieren"-Check für Flutter-3.x-Apps](/de/2026/01/flutterguard-cli-a-fast-what-can-an-attacker-extract-check-for-flutter-3-x-apps/) ist ein nützlicher zusätzlicher Schritt, den Sie dem primären Job hinzufügen können, sobald Ihre Matrix stabil ist.

## Quellen-Links

- [README von subosito/flutter-action](https://github.com/subosito/flutter-action)
- [flutter-actions/setup-flutter](https://github.com/flutter-actions/setup-flutter) (die gepflegte Alternative, falls v2 jemals nachhinkt)
- [FVM-3-Dokumentation](https://fvm.app/documentation/getting-started/configuration)
- [Flutter pubspec-Optionen](https://docs.flutter.dev/tools/pubspec)
- [Flutter aktualisieren](https://docs.flutter.dev/install/upgrade)
- [flutter/flutter#107364: Die Obergrenze der SDK-Einschränkung wird nicht erzwungen](https://github.com/flutter/flutter/issues/107364)
- [flutter/flutter#113169: Setzen einer exakten Flutter-Version in pubspec.yaml funktioniert nicht](https://github.com/flutter/flutter/issues/113169)
