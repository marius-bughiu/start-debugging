---
title: "Lösung: Failed to decode advisories for archive from https://pub.dev in flutter pub get"
description: "Die Advisories-Warnung in pub get ist harmlos: pub get endet mit Exit-Code 0. pub.dev hat die fehlerhafte Antwort am 2026-05-04 behoben. Tritt sie weiterhin auf, liegt die Ursache bei einem Mirror oder Proxy."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "pub"
  - "ci"
lang: "de"
translationOf: "2026/09/fix-failed-to-decode-advisories-for-archive-from-pub-dev"
translatedBy: "claude"
translationDate: 2026-09-25
---

Ihre Pakete sind in Ordnung. Die Meldung stammt aus der Prüfung von pub auf Sicherheitshinweise (Security Advisories), die nach der Auflösung der Abhängigkeiten läuft, und `flutter pub get` endet trotzdem mit Exit-Code 0. Die massenhaften Meldungen (jedes Projekt, das von `archive`, `http`, `dio`, `shared_preferences_android` und so weiter abhängt) gingen auf einen Serverfehler bei pub.dev zurück. Zwischen 2026-05-02 und 2026-05-04 lieferte die Advisories-API `"advisoriesUpdated": null`, und pub.dev hat das am 2026-05-04 behoben. Sehen Sie die Meldung heute noch, kommt die Antwort von einem Paket-Mirror (`PUB_HOSTED_URL`, Artifactory, Nexus, ein privater pub-Server) oder einem Proxy. Beheben Sie das Problem auf diesem Server, oder aktualisieren Sie auf Flutter 3.47.0 / Dart 3.13.0 oder neuer, wo der Stack Trace auf eine einzeilige Warnung reduziert ist. Schlägt CI deswegen fehl, liegt das eigentliche Problem in einem Schritt, der Ausgaben auf stderr als Fehler wertet.

Ich habe jede der folgenden Varianten unter macOS mit Dart 3.12.2 (dem SDK in Flutter 3.44.x) und Dart 3.13.4 (dem SDK in Flutter 3.47.5) reproduziert. Beide liefen gegen ein lokales pub-Repository mit 40 Zeilen, das die [Hosted Repository Spec v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md) implementiert und mich festlegen lässt, was der Advisories-Endpunkt zurückgibt.

## Der Fehler im Kontext

Unter Flutter 3.44.x und älter (Dart 3.12.x und älter) gibt `flutter pub get` oder `dart pub get` Folgendes für ein Paket nach dem anderen aus:

```text
Resolving dependencies...
Downloading packages...
Failed to decode advisories for archive from https://pub.dev.
FormatException: advisoriesUpdated must be a String
package:pub/src/source/hosted.dart 670                        HostedSource._extractAdvisoryDetailsForPackage
package:pub/src/source/hosted.dart 622                        HostedSource._fetchAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 839                        HostedSource._getAdvisories
===== asynchronous gap ===========================
package:pub/src/source/hosted.dart 1120                       HostedSource.getAdvisoriesForPackageVersion
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 425                        SolveReport._reportPackage
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 221                        SolveReport._reportChanges
===== asynchronous gap ===========================
package:pub/src/solver/report.dart 76                         SolveReport.show
===== asynchronous gap ===========================
package:pub/src/entrypoint.dart 642                           Entrypoint.acquireDependencies
...
Failed to decode advisories for http from https://pub.dev.
FormatException: advisoriesUpdated must be a String
...
```

Unter Flutter 3.47.0 und neuer (Dart 3.13.0 und neuer) erzeugt dieselbe Bedingung eine Zeile pro Paket:

```text
Failed to decode advisories for archive from https://pub.dev: advisoriesUpdated must be a String
```

`archive` ist meist der erste Name, den Sie sehen. Der Bericht geht die Pakete alphabetisch durch, und `archive` ist eine transitive Abhängigkeit von `image` und von viel Build-Tooling, sodass es in den meisten Flutter-Lock-Dateien früh auftaucht. Nur Pakete, zu denen es jemals einen Sicherheitshinweis gab, lösen den Abruf aus. Deshalb standen `http` und `dio` in jedem Bericht, `path` dagegen nie.

## Warum pub überhaupt Advisories abruft

Seit Dart 3.4 ([dart-lang/pub#4062](https://github.com/dart-lang/pub/pull/4062)) melden `pub get`, `pub upgrade` und `pub add` bekannte Sicherheitshinweise für die aufgelösten Versionen. Die Daten stammen von [osv.dev](https://osv.dev), und pub.dev stellt sie über zwei Felder seiner API bereit:

1. Die Versionsliste, `GET /api/packages/<name>`, hat einen optionalen Zeitstempel `advisoriesUpdated`. Ist er vorhanden, geht der Client davon aus, dass der Server den Advisories-Endpunkt für dieses Paket unterstützt.
2. Der Advisories-Endpunkt, `GET /api/packages/<name>/advisories`, liefert `{"advisories": [...], "advisoriesUpdated": "<date-time>"}`.

Der Client speichert die zweite Antwort unter `$PUB_CACHE/hosted/<host>/.cache/<name>-advisories.json` zwischen und entscheidet anhand des Zeitstempels, ob dieser Cache veraltet ist. In `_extractAdvisoryDetailsForPackage` in [`hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart) ist der Parser beim Zeitstempel streng:

```dart
// dart-lang/pub, lib/src/source/hosted.dart (Dart 3.12 and 3.13)
final advisoriesUpdated = body['advisoriesUpdated'];
if (advisoriesUpdated is! String) {
  throw const FormatException('advisoriesUpdated must be a String');
}
```

Diese `FormatException` wird in `_fetchAdvisories` abgefangen, als Warnung protokolliert, und die Methode gibt `null` zurück, was "keine Advisory-Daten für dieses Paket" bedeutet. Die Auflösung ist zu diesem Zeitpunkt bereits abgeschlossen, und nichts in `pubspec.lock` hängt davon ab. Verloren geht nur der Advisory-Bericht für dieses Paket.

## Was im Mai 2026 bei pub.dev kaputtging

Der [Post Mortem](https://github.com/dart-lang/pub-dev/issues/9372) des pub.dev-Teams erklärt den Ablauf. Am 2026-04-23 entfernte ein schlankeres `FROM scratch`-Docker-Image `unzip`, sodass der Job, der den osv.dev-Export herunterlädt, nicht mehr funktionierte. Am 2026-05-01 wurde er durch eine Dart-Implementierung von unzip ersetzt, der ein `init()`-Aufruf fehlte. Diese Implementierung entpackte null Dateien, also "fand" die nächste Synchronisierung am 2026-05-02 keine Advisories und löschte sie alle aus dem Datastore.

Der Advisories-Endpunkt leitete `advisoriesUpdated` vom neuesten gespeicherten Advisory ab, und es war keines mehr übrig, also lieferte er `null`. Die Versionsliste trug noch den alten Zeitstempel aus der Paket-Entität. Jeder Client sah daher "dieses Paket hat Advisories", rief sie ab und scheiterte an:

```json
{"advisories": [], "advisoriesUpdated": null}
```

[dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368) ("Fix advisoriesUpdated") wurde am 2026-05-04 ausgeliefert. Die Advisories wurden neu geladen, und das Issue wurde am 2026-05-05 geschlossen. Heute liefert ein Paket ohne Advisories die Unix-Epoche statt `null`:

```bash
# pub.dev, checked 2026-09-25
curl -s https://pub.dev/api/packages/path/advisories
# {"advisories":[],"advisoriesUpdated":"1970-01-01T00:00:00.000"}
```

Auf der Client-Seite hat [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817) ("Quiet warning instead of stack trace when failing to parse advisories") den Stack Trace durch eine einzeilige Meldung ersetzt. Ich habe für jedes Release-Tag die in der `DEPS`-Datei des Dart SDK festgelegte `pub_rev` geprüft. Die Änderung ist in 3.12.0 bis 3.12.2 nicht enthalten, in jedem 3.13.x-Release dagegen schon. Auf Flutter übertragen geben 3.44.0 bis 3.44.9 noch den vollständigen Trace aus, und 3.47.0 ist das erste Stable-Release, das es nicht mehr tut.

## Minimale Reproduktion mit einem lokalen pub-Server

pub.dev muss nicht kaputt sein, damit Sie das sehen. Ein winziger Node-Server, der der Repository-Spezifikation folgt und einen Schalter für die Advisories-Antwort hat, reproduziert jede Variante. Das ist der relevante Teil:

```js
// Node 24, server.mjs: minimal pub repository (spec v2)
if (req.url === '/api/packages/fakepkg') {
  res.writeHead(200, { 'content-type': 'application/vnd.pub.v2+json' });
  return res.end(JSON.stringify({
    name: 'fakepkg',
    advisoriesUpdated: '2026-04-20T10:00:00.000Z', // tells pub to fetch advisories
    latest: { version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec },
    versions: [{ version: '1.0.0', archive_url: `${base}/pkg/fakepkg-1.0.0.tar.gz`, pubspec }],
  }));
}
if (req.url === '/api/packages/fakepkg/advisories') {
  res.writeHead(200, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ advisories: [], advisoriesUpdated: null }));
}
```

Die App verweist mit einer Abhängigkeit darauf:

```yaml
# pubspec.yaml, Dart 3.12.2 / 3.13.4
name: app
publish_to: none
environment:
  sdk: ^3.0.0
dependencies:
  fakepkg:
    hosted: http://localhost:8123
    version: ^1.0.0
```

Ausgeführt auf beiden SDKs, jedes Mal mit einem frischen `PUB_CACHE`:

```bash
# Dart 3.12.2
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# out.txt: Resolving dependencies... Downloading packages... + fakepkg 1.0.0  Changed 1 dependency!
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123.
#          FormatException: advisoriesUpdated must be a String
#          package:pub/src/source/hosted.dart 648  HostedSource._extractAdvisoryDetailsForPackage
#          ... (full async stack trace)

# Dart 3.13.4
dart pub get > out.txt 2> err.txt; echo "exit=$?"
# exit=0
# err.txt: Failed to decode advisories for fakepkg from http://localhost:8123: advisoriesUpdated must be a String
```

Drei Dinge macht die Reproduktion konkret:

- **Der Exit-Code ist in beiden Versionen 0.** Das Paket wird heruntergeladen und `pubspec.lock` wird geschrieben.
- **Alles landet auf stderr.** stdout bleibt sauber.
- **Die fehlerhafte Antwort wird nie zwischengespeichert.** Danach enthält `$PUB_CACHE/hosted/localhost%588123/.cache/` zwar `fakepkg-versions.json`, aber kein `fakepkg-advisories.json`. Der Cache wird erst nach erfolgreichem Parsen geschrieben, also fragt pub bei jedem Lauf erneut nach, auch bei einem `pub get`, bei dem sich nichts geändert hat. Den pub-Cache zu löschen hilft nicht, denn der Cache war nie das Problem. Das deckt sich mit den Berichten im pub-dev-Issue von Leuten, die `flutter pub cache clean` ausgeführt haben und den Fehler trotzdem bekamen.

## Die Lösung, nach Wahrscheinlichkeit geordnet

### 1. Prüfen, woher die Antwort kommt

Führen Sie ein ausführliches get aus und suchen Sie nach der Advisories-Anfrage:

```bash
# Flutter 3.47.5 / Dart 3.13.4
dart pub get --verbose 2>&1 | grep -A3 "Fetching security advisories"
# IO  : Fetching security advisories from https://pub.dev/api/packages/archive/advisories.
# IO  : HTTP GET https://pub.dev/api/packages/archive/advisories
```

Rufen Sie dann genau diese URL selbst ab:

```bash
curl -s https://pub.dev/api/packages/archive/advisories | head -c 300
```

Ist der Host `pub.dev` und enthält der Body ein `advisoriesUpdated` als String, ist die Serverseite in Ordnung. Jede verbleibende Meldung stammt von etwas zwischen Ihnen und pub.dev, meist einem TLS-inspizierenden Proxy, der Antworten umschreibt. Ist der Host nicht pub.dev, prüfen Sie `echo $PUB_HOSTED_URL` und alle `hosted:`-URLs in `pubspec.yaml`. Dieser Server ist der Schuldige.

### 2. Verhindern, dass CI die Warnung als Fehler wertet

pub endet mit 0. Ist eine Pipeline wegen dieser Meldung rot geworden, schlägt also ein Schritt wegen Ausgaben auf stderr fehl. Die üblichen Verdächtigen sind Script-Tasks in Azure Pipelines mit `failOnStderr: true` sowie Windows-PowerShell-5.1-Skripte, die `flutter pub get 2>&1` unter `$ErrorActionPreference = 'Stop'` ausführen. PowerShell 5.1 macht aus jeder umgeleiteten stderr-Zeile einen `ErrorRecord`, und mit `Stop` beendet bereits der erste das Skript. Prüfen Sie stattdessen den Exit-Code:

```yaml
# Azure Pipelines, Flutter 3.47.5
- script: flutter pub get
  displayName: Restore packages
  failOnStderr: false   # pub prints advisory warnings to stderr and still exits 0
```

```powershell
# Windows PowerShell 5.1, Flutter 3.47.5
$ErrorActionPreference = 'Continue'
flutter pub get
if ($LASTEXITCODE -ne 0) { throw "flutter pub get failed ($LASTEXITCODE)" }
```

Wrapper, die das Log nach `Exception` oder `Error` durchsuchen, haben dasselbe Problem. Ein echter Auflösungsfehler wie [`version solving failed`](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/) setzt einen Exit-Code ungleich null, der Exit-Code genügt also.

### 3. Auf Flutter 3.47.0 oder neuer aktualisieren

Das beseitigt die Warnung nicht, aber die einzeilige Form wirkt in Logs weit weniger alarmierend und verdeckt nicht die Ausgabe, die Sie interessiert. Legt Ihre CI Flutter pro Branch fest, können Sie mit dem Ansatz aus [mehrere Flutter-Versionen aus einer CI-Pipeline ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) den Standard-Job auf 3.47.x umstellen, ohne die anderen anzufassen.

### 4. Den Mirror oder privaten pub-Server reparieren

Die Spezifikation lässt einem Mirror zwei gültige Möglichkeiten, und er muss sich für eine entscheiden:

- `/api/packages/<name>/advisories` originalgetreu weiterleiten, wobei `advisoriesUpdated` immer ein String ist.
- Oder `advisoriesUpdated` aus der ausgelieferten Versionsliste entfernen. Die Spezifikation macht das Feld optional, und fehlt es, ruft der Client den Advisories-Endpunkt gar nicht erst auf. Sie verlieren den Advisory-Bericht, aber pub hört auf nachzufragen.

Remote-Repositories in Artifactory und ähnlichen Produkten speichern Upstream-Metadaten zwischen. Ein Artifactory-Nutzer im pub-dev-Issue stieß auf einen anderen Fehler: Der eigene Parser des Proxys warf bei dem `null`-Feld eine `NullPointerException`. Hat Ihr Proxy eine Antwort aus dem Zeitraum im Mai 2026 zwischengespeichert, sorgt das Leeren des Metadaten-Caches dieses Remote-Repositorys (Artifactory nennt das "zap cache") dafür, dass er die korrigierte Antwort abruft. Das muss derjenige erledigen, der den Proxy betreibt. Auf der Client-Seite ändert nichts daran etwas.

### 5. Die Prüfung dort überspringen, wo sie wirklich keine Rolle spielt

`dart pub get --offline` / `flutter pub get --offline` ruft nie Advisories ab. Der Code kehrt im Offline-Modus vorzeitig zurück. Das funktioniert nur, wenn jedes Paket bereits im lokalen pub-Cache liegt, und passt daher zu hermetischen Build-Agents mit vorgewärmtem Cache, nicht als allgemeine Lösung. Verwenden Sie es nicht, um einen kaputten Mirror auf Entwicklerrechnern zu kaschieren, denn damit verlieren Sie auch den Sicherheitsbericht, für den es die Prüfung gibt.

## Ähnlich aussehende Varianten

**`Failed to decode advisories for X from ...: Unexpected character (at character 1)`**, gefolgt von einer Zeile HTML. Die Advisories-Anfrage hat eine HTML-Seite erhalten, typischerweise ein Captive Portal, eine Proxy-Anmeldung oder eine Fehlerseite, die HTTP 200 liefert. Ich habe das reproduziert, indem ich `<html>proxy login</html>` zurückgegeben habe. Der Exit-Code ist weiterhin 0, und die Lösung liegt im Netzwerkpfad, nicht in pub.

**`Warning: Unable to fetch advisories for "X" from "https://my-mirror/"`**. Der Advisories-Endpunkt hat einen Status außerhalb von 2xx von einem Host geliefert, der nicht pub.dev ist. Das ist eine Warnung mit Exit-Code 0. Dieses Verhalten geht auf [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275) aus dem Jahr 2024 zurück. Davor brachte ein Mirror ohne den Endpunkt `pub get` zum Absturz.

**`Failed to fetch advisories for "X" from "https://pub.dev"`**. Dieselbe Situation, aber der Host ist pub.dev. pub behandelt diesen Fall als fatal (`fail(...)`) und endet mit einem Exit-Code ungleich null, da pub.dev den Endpunkt immer bereitstellen sollte. Sehen Sie diese Meldung, handelt es sich wirklich um einen Ausfall von pub.dev oder um etwas, das diesen Pfad blockiert. Prüfen Sie [den Issue Tracker von pub.dev](https://github.com/dart-lang/pub-dev/issues), bevor Sie lokal etwas ändern.

**`FormatException: advisories must be a list`** oder **`advisory must be a map`**. Derselbe Codepfad, ein anderes fehlerhaftes Feld. Ein selbst gebauter pub-Server liefert die falsche Struktur. Vergleichen Sie seine Antwort mit dem Abschnitt zum OSV-Format in der Spezifikation.

## Verwandte Artikel

- [Lösung: version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/) behandelt den pub-Fehler, der einen Build tatsächlich stoppt, und wie man seine Ausgabe liest.
- [Mehrere Flutter-Versionen aus einer CI-Pipeline ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), nützlich beim Umstieg der CI auf ein 3.47.x-SDK.
- [Die Flutter-Engine-Version für reproduzierbare Builds festlegen](/de/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/), denn nur wenn Sie genau wissen, welches SDK Ihre Agents ausführen, können Sie Ausgaben von 3.44 und 3.47 unterscheiden.
- [Lösung: Unexpected failure parsing device information from adb output](/de/2026/09/fix-unexpected-failure-parsing-device-information-from-adb-output-in-flutter/) ist eine weitere laute Meldung des Flutter-Toolings, bei der eine bestimmte SDK-Version der richtige Schritt ist.
- [Was sonst noch im Flutter-3.47.1-Hotfix ausgeliefert wurde](/de/2026/08/flutter-3-47-1-blocks-plugin-registrant-code-injection/).

## Quellen

- [dart-lang/pub-dev#9372](https://github.com/dart-lang/pub-dev/issues/9372), der ursprüngliche Bericht und der Post Mortem, dazu die Duplikate [dart-lang/sdk#63308](https://github.com/dart-lang/sdk/issues/63308) und [flutter/flutter#185943](https://github.com/flutter/flutter/issues/185943).
- [dart-lang/pub-dev#9368](https://github.com/dart-lang/pub-dev/pull/9368), die Korrektur auf dem Server.
- [dart-lang/pub#4817](https://github.com/dart-lang/pub/pull/4817), die leisere Client-Warnung, und [dart-lang/pub#4275](https://github.com/dart-lang/pub/pull/4275), der sanfte Umgang mit einem fehlenden Advisories-Endpunkt.
- [`lib/src/source/hosted.dart`](https://github.com/dart-lang/pub/blob/master/lib/src/source/hosted.dart) in dart-lang/pub (`_fetchAdvisories`, `_extractAdvisoryDetailsForPackage`, `_getAdvisories`).
- [Hosted Pub Repository Specification v2](https://github.com/dart-lang/pub/blob/master/doc/repository-spec-v2.md), die Abschnitte zu `advisoriesUpdated` und "List security advisories for a package".
- [Dart SDK `DEPS`](https://github.com/dart-lang/sdk/blob/3.13.0/DEPS) (`pub_rev`) an den Tags 3.12.x und 3.13.x sowie das [Flutter-Release-Manifest](https://storage.googleapis.com/flutter_infra_release/releases/releases_macos.json) für die Zuordnung von Flutter zu Dart.
- [Troubleshooting pub](https://dart.dev/tools/pub/troubleshoot) auf dart.dev.
