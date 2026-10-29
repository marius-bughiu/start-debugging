---
title: "Fix: flutter upgrade meldet \"Your flutter checkout has local changes that would be erased by upgrading\""
description: "flutter upgrade bricht ab, wenn git status im SDK-Ordner irgendetwas ausgibt. Prüfen Sie die Ausgabe, stellen Sie pubspec.lock wieder her oder nutzen Sie git stash -u, und verwenden Sie --force nur als letzten Ausweg."
pubDate: 2026-10-29
template: error-page
tags:
  - "errors"
  - "flutter"
  - "flutter-3-47"
  - "git"
lang: "de"
translationOf: "2026/10/fix-flutter-upgrade-your-flutter-checkout-has-local-changes"
translatedBy: "claude"
translationDate: 2026-10-29
---

`flutter upgrade` führt `git status -s` im Flutter-SDK-Ordner aus und bricht ab, sobald dabei auch nur eine Zeile erscheint, auch bei untracked Dateien, die Sie nie behalten wollten. Den SDK-Ordner finden Sie mit `flutter --version --machine` (Feld `flutterRoot`). Führen Sie dort `git status --short` aus. Stellen Sie dann entweder die Datei wieder her (meist `pubspec.lock`), sichern Sie Ihre Änderungen mit `git stash push -u`, oder führen Sie `flutter upgrade --force` aus, wenn Ihnen nichts im SDK wichtig ist. Alles unten wurde am 2026-10-29 mit Flutter 3.44.8 und 3.47.7/3.47.8 (stable, Dart 3.12.2) geprüft.

## Der Fehler im Kontext

Sie führen `flutter upgrade` auf einem Rechner aus, auf dem Sie Flutter selbst sicher nie angefasst haben, und erhalten Folgendes:

```text
$ flutter upgrade
Your flutter checkout has local changes that would be erased by upgrading. If you want to keep these changes, it is recommended that you stash them via "git stash" or else commit the changes to a local branch. If it is okay to remove local changes, then re-run this command with "--force".
```

Der Exit-Code ist 1, und nichts hat sich geändert. Die Meldung bezieht sich auf den Git-Checkout des **SDK**, nicht auf das Repository Ihrer App. Der `git status` Ihrer App kann völlig sauber sein, und Sie sehen den Fehler trotzdem.

## Warum das passiert

Das Flutter-SDK ist ein Git-Klon von `flutter/flutter`, und `flutter upgrade` ist im Kern `git fetch` plus `git reset --hard <new revision>` mit einigen Sicherheitsprüfungen drumherum. Der relevante Code liegt in `packages/flutter_tools/lib/src/commands/upgrade.dart`, und die Reihenfolge der Schritte ist entscheidend:

1. `git fetch --tags`, danach wird die Upstream-Revision Ihres Branches (`stable`, `beta`, `main`) aufgelöst.
2. Sind Sie bereits auf dieser Revision, wird "Flutter is already up to date" ausgegeben und mit 0 beendet. **Die Prüfung auf lokale Änderungen findet nicht statt.**
3. Wurde `--verify-only` übergeben, wird die verfügbare Version ausgegeben und beendet.
4. Hat der aktuelle Commit kein erkennbares Release-Tag und haben Sie nicht `--force` übergeben, bricht der Befehl mit "Unknown flutter tag" ab.
5. Haben Sie nicht `--force` übergeben und liefert `hasUncommittedChanges()` true, bricht der Befehl mit dem obigen Fehler ab.
6. `git reset --hard <upstream revision>`, danach wird das neue Tool mit `flutter upgrade --continue` erneut gestartet, um Artefakte vorab zu laden, `pub upgrade` für Ihr Projekt auszuführen und `flutter doctor` laufen zu lassen.

`hasUncommittedChanges()` ist ein dünner Wrapper um `git status -s`. Im Stable-Channel zählt jede nicht leere Ausgabe als Änderung. Seit Flutter 3.47.0 ([PR #184997](https://github.com/flutter/flutter/pull/184997)) überspringen die Channels beta und main Zeilen, die auf `pubspec.lock` enden, weil main eigene Dev-SDK-Constraints in diese Datei schreibt. Stable erhält diese Ausnahme nicht.

Aus der Verwendung von `git status -s` folgen zwei Konsequenzen:

- **Untracked Dateien zählen.** Eine verirrte `notes.txt` im SDK-Ordner blockiert das Upgrade, obwohl `git reset --hard` sie nie löschen würde.
- **Per gitignore ausgeschlossene Dateien zählen nicht.** Die `.gitignore` des SDK deckt bereits `.idea/`, `.vscode/*`, `.pub-cache/`, `.dart_tool/`, `bin/cache/`, `*.log` und jede `*.lock` außer der Root-Datei `/pubspec.lock` ab. `.pub-cache/` kam nach [Issue #128635](https://github.com/flutter/flutter/issues/128635) hinzu, wo eine Snap-Installation ihren Pub-Cache innerhalb des SDK ablegte.

Die eigentliche Frage lautet also nie "habe ich lokale Änderungen", sondern "was gibt `git status --short` im SDK-Ordner aus, und wer hat es dort abgelegt".

## Minimales Reproduktionsbeispiel

Ich habe jeden Fall an einem Scratch-Klon von `flutter/flutter` reproduziert, der auf das Tag `3.47.7` zurückgesetzt war, ein Release hinter `stable` (3.47.8). Um keinen frisch geklonten Code auszuführen, habe ich die Upgrade-Logik mit meinem installierten Flutter 3.44.8 und dem versteckten Tool-Flag `--working-directory` gesteuert, das den Befehl auf einen anderen Checkout richtet und die reentrante zweite Hälfte überspringt. Die Stable-Channel-Prüfung ist zwischen 3.44.8 und 3.47.8 byteidentisch.

```bash
# Flutter 3.44.8 tool, scratch checkout at 3.47.7, upstream stable = 3.47.8
C=~/scratch/flutter
git -C "$C" reset -q --hard 3.47.7

echo hi > "$C/notes.txt"                       # untracked file only
flutter upgrade --working-directory="$C"
# Your flutter checkout has local changes that would be erased by upgrading. ...
# exit=1
```

Das Ergebnis der einzelnen Szenarien:

| Zustand des SDK-Checkouts | `git status -s` | Ergebnis von `flutter upgrade` |
| --- | --- | --- |
| Sauber, ein Release zurück | (leer) | Upgrade läuft |
| Untracked `notes.txt` | `?? notes.txt` | Blockiert |
| Dateien in `.idea/`, `.pub-cache/`, `debug.log` | (leer, nur mit `--ignored` sichtbar) | Nicht blockiert |
| Geänderte Root-`pubspec.lock` | ` M pubspec.lock` | Blockiert |
| Geänderter Framework-Quellcode + untracked Datei, `--force` | ` M packages/flutter/...`, `?? notes.txt` | Upgrade läuft; Framework-Änderung weg, `notes.txt` noch da |
| Bereits auf 3.47.8 mit `?? notes.txt` | `?? notes.txt` | "Flutter is already up to date", Exit 0 |

Die letzte Zeile erklärt ein verwirrendes Muster: Die verirrte Datei liegt monatelang ohne Beanstandung dort, und der Fehler erscheint erst am Release-Tag, wenn es endlich etwas gibt, auf das man upgraden kann.

## Die häufigste Ursache: die eigene `pubspec.lock` des SDK

Zeigt `git status --short` ` M pubspec.lock` und sonst nichts, hat Flutter seine eigene Lock-Datei verändert. Das Flutter-Repository ist ein Pub-Workspace, und seine Root-`pubspec.lock` ist die einzige versionierte Lock-Datei im Baum. Alles, was `pub upgrade` mit dem SDK-Root als Projekt ausführt, schreibt sie neu, weil nach dem Release veröffentlichte Pakete (zum Beispiel ein neueres `objective_c`) dieselben Constraints erfüllen.

Bis einschließlich Flutter 3.44.x hat `flutter upgrade` genau das mit sich selbst gemacht. Das reentrante `flutter upgrade --continue` wurde mit dem SDK-Root als Arbeitsverzeichnis gestartet, sodass der Schritt "Pakete Ihres Projekts aktualisieren" `findProjectRoot()` aufrief. Diese Funktion läuft vom aktuellen Verzeichnis aufwärts und sucht nach einer `pubspec.yaml`, fand die des SDK und führte darauf `pub upgrade` aus. Das Upgrade gelang, hinterließ aber eine veränderte Lock-Datei, und das *nächste* Upgrade schlug fehl. Das ist [Issue #187977](https://github.com/flutter/flutter/issues/187977), und es passt zu den Berichten "tritt nur bei Installationen auf, die schon einmal upgegradet wurden".

Die Abweichung können Sie selbst sehen. Auf einem sauberen Checkout des Tags `3.44.0` hat `pub upgrade` im SDK-Root mit Dart 3.12.2 (der Dart-Linie von 3.44) die Lock-Datei neu geschrieben (14 Einfügungen, 6 Löschungen):

```bash
# Flutter 3.44.0 checkout, Dart 3.12.2, 2026-10-29
cd ~/scratch/flutter && dart pub upgrade
git diff --stat
#  pubspec.lock | 20 ++++++++++++++------
```

```diff
       name: jni
-    version: "1.0.0"
+    version: "1.1.1"
       name: jni_flutter
-    version: "1.0.1"
+    version: "1.0.4+1"
       name: objective_c
-    version: "9.2.3"
+    version: "9.3.0"
```

`objective_c` 9.2.3 auf 9.3.0 ist exakt der Diff aus dem Issue-Bericht. [PR #188794](https://github.com/flutter/flutter/pull/188794) hat das behoben, indem die zweite Hälfte in Ihrem ursprünglichen Arbeitsverzeichnis gestartet wird, und ist in Flutter 3.47.0 erschienen. Wenn Sie auf 3.44.x sind, müssen Sie auf dem Weg zu 3.47 also noch einmal mit diesem Fehler rechnen, danach sollte er verschwinden.

Der Fix hat allerdings einen Haken. Die zweite Hälfte führt jetzt `pub upgrade` für das Projekt aus, das `findProjectRoot()` von **Ihrem** aktuellen Verzeichnis aus findet, und diese Funktion läuft aufwärts. Führen Sie `flutter upgrade` innerhalb des SDK-Baums aus, etwa in `~/development/flutter/bin`, findet sie wieder die `pubspec.yaml` des SDK und verändert die Lock-Datei auch unter 3.47. Starten Sie Upgrades aus Ihrem Home-Verzeichnis oder aus einem App-Ordner, nie aus dem SDK heraus. (Aus einem App-Ordner heraus werden die Abhängigkeiten dieser App aktualisiert, was ein eigenes Thema ist und unter [warum sich `pubspec.lock` nach `flutter upgrade` ändert](/de/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) behandelt wird.)

## Fix im Detail

### 1. SDK finden und nachsehen, bevor Sie erzwingen

Greifen Sie nicht zuerst zu `--force`. Finden Sie heraus, was tatsächlich dort liegt.

```bash
# Flutter 3.44+ on macOS / Linux (needs jq)
SDK="$(flutter --version --machine | jq -r .flutterRoot)"
git -C "$SDK" status --short
git -C "$SDK" diff --stat
```

```powershell
# Flutter 3.44+ on Windows PowerShell
$sdk = (flutter --version --machine | ConvertFrom-Json).flutterRoot
git -C $sdk status --short
git -C $sdk diff --stat
```

`flutter doctor -v` gibt denselben Pfad in der Zeile "Flutter version X on channel Y at <path>" aus, falls Sie kein JSON parsen möchten. Bei einer Homebrew-Cask-Installation ist `flutterRoot` der echte Checkout (auf meinem Rechner `/opt/homebrew/share/flutter`), nicht der Symlink `bin/flutter`.

### 2a. Nur `pubspec.lock` ist geändert: wiederherstellen

Das ist der oben beschriebene Fall, in dem Flutter die Datei selbst geschrieben hat. Die Datei wird ohnehin neu erzeugt, verwerfen Sie also die Änderung und führen Sie das Upgrade normal aus:

```bash
# Flutter 3.44.x -> 3.47.x, stable channel
git -C "$SDK" checkout -- pubspec.lock
cd ~ && flutter upgrade
```

Das Upgrade aus `~` auszuführen verhindert, dass die zweite Hälfte eine `pubspec.yaml` im SDK findet.

### 2b. Sie haben Framework-Dateien absichtlich geändert: stashen

Vielleicht haben Sie auf der Fehlersuche ein Widget gepatcht oder ein `debugPrint` in `packages/flutter` eingefügt. Wenn Sie diese Änderungen nach dem Upgrade zurückhaben möchten, stashen Sie sie samt untracked Dateien:

```bash
# Flutter 3.47.7 -> 3.47.8, verified 2026-10-29
git -C "$SDK" stash push -u -m "before flutter upgrade"
flutter upgrade
git -C "$SDK" stash pop
```

In meinem Test wurde sauber auf 3.47.8 upgegradet, und `stash pop` stellte sowohl die geänderte `text.dart` als auch die untracked `notes.txt` wieder her. Haben sich die von Ihnen berührten Dateien zwischen den beiden Versionen upstream geändert, kann `stash pop` Konflikte erzeugen. Das ist das ehrliche Ergebnis: Ihr Patch wurde gegen eine andere Framework-Version geschrieben.

Wenn Sie langlebige Patches am Framework pflegen, ist ein Stash das falsche Werkzeug. Committen Sie sie auf einen lokalen Branch oder, besser, halten Sie einen Fork und binden Sie ein projektspezifisches SDK über einen Versionsmanager daran an, damit das SDK, das Sie upgraden, nicht dasjenige ist, das Sie patchen.

### 2c. Nichts davon ist wichtig: `--force`

Zeigt `git status --short` nur Rauschen, das Sie nicht interessiert, erzwingen Sie das Upgrade:

```bash
# Flutter 3.47.x, stable channel
flutter upgrade --force    # or: flutter upgrade -f
```

Wissen Sie, was `--force` tut, denn es ist nicht das, was die meisten annehmen:

- Es überspringt die Prüfung "Unknown flutter tag" und die Prüfung auf lokale Änderungen. Mehr nicht.
- Danach führt es `git reset --hard <upstream revision>` aus. Änderungen an versionierten Dateien werden ohne Sicherung verworfen, und Commits, die Sie auf Ihrem lokalen Branch `stable` gemacht haben, fallen vom Branch ab und sind nur noch über `git reflog` wiederherstellbar.
- Es löscht **keine** untracked Dateien. In meinem Test überlebte `notes.txt` das `--force` und wurde danach weiterhin von `git status` aufgelistet. Den nächsten Lauf blockierte sie nur deshalb nicht, weil dieser zuerst auf "already up to date" stieß. Beim nächsten Release blockiert sie wieder.

Um untracked Dateien dauerhaft loszuwerden, sehen Sie sich zuerst die Vorschau an und löschen sie dann:

```bash
# Run inside the SDK folder; -n is a dry run
git -C "$SDK" clean -n -d
git -C "$SDK" clean -f -d
```

`git clean` löscht Dateien endgültig und beachtet `.gitignore`, rührt also `bin/cache/` und `.pub-cache/` nicht an. Lesen Sie die Ausgabe von `-n`, bevor Sie den echten Lauf starten.

### 3. Verhindern, dass es wiederkommt

- Wechseln Sie auf Flutter 3.47.0 oder neuer, das den Fix für das reentrante Arbeitsverzeichnis enthält.
- Führen Sie `flutter upgrade` nie innerhalb des SDK-Baums aus.
- Legen Sie keine Scratch-Dateien, Notizen oder Experimentierprojekte im SDK-Ordner ab. Erstellen Sie Apps neben dem SDK, nicht darin.
- Installieren Sie das SDK unter Windows nicht, indem Sie das Archiv mit "Alle extrahieren" des Datei-Explorers entpacken. Der Explorer kann einige tiefe Pfade im SDK nicht anlegen (die Goldens der iOS-Szenario-App überschreiten `MAX_PATH`), überspringt sie, und diese fehlenden versionierten Dateien erscheinen in `git status` als gelöscht, was jedes künftige Upgrade blockiert ([Issue #193197](https://github.com/flutter/flutter/issues/193197), verfolgt in [#183172](https://github.com/flutter/flutter/issues/183172)). Installieren Sie stattdessen per `git clone`, nachdem Sie lange Pfade in Git (`core.longpaths`) und in Windows aktiviert haben, wie es die [Flutter-Upgrade-Dokumentation](https://docs.flutter.dev/install/upgrade) beschreibt. Haben Sie bereits eine solche Installation, stellt `git -C $sdk checkout -- .` nach dem Aktivieren langer Pfade die fehlenden Dateien wieder her.

## Stolperfallen und ähnliche Meldungen

**"Unknown flutter tag. Abandoning upgrade to avoid destroying local changes."** Eine andere Prüfung aus derselben Familie. Sie greift, wenn `git describe` in der Nähe Ihres Commits kein Release-Tag findet, typischerweise nach einem flachen Klon ohne Tags oder nach dem Auschecken eines beliebigen Commits. In einem offiziellen Channel rät die Meldung dazu, Git direkt zu verwenden, anderswo schlägt sie `--force` vor. Holen Sie die Tags (`git -C "$SDK" fetch --tags`), bevor Sie erzwingen.

**"Your Flutter checkout is currently not on a release branch."** Sie befinden sich in einem Detached HEAD, meist weil Sie dem Rat der Dokumentation `git checkout <version>` gefolgt sind, um eine Version festzulegen. Führen Sie `flutter channel stable` aus, um wieder auf einen Branch zu kommen, und starten Sie dann das Upgrade.

**"The current Flutter branch/channel is not tracking any remote repository."** Ihr lokaler Branch hat keinen Upstream. Dokumentierter Fix ist eine Neuinstallation; `git -C "$SDK" branch -u origin/stable` funktioniert ebenfalls, wenn `origin` das offizielle Remote ist.

**Rauschen durch Dateimodi oder Zeilenenden.** Zeigt `git diff` im SDK nur Zeilen `old mode 100755` / `new mode 100644`, hat etwas (ein `chmod -R`, eine Kopie über Dateisystemgrenzen, ein synchronisierter Ordner) die Berechtigungen geändert. Wird unter Windows jede Datei als geändert angezeigt, wurde der Checkout mit anderen Zeilenenden kopiert. In beiden Fällen hat sich nichts geändert, was Ihnen wichtig wäre; `git -C "$SDK" checkout -- .` oder `--force` ist dann die richtige Wahl. Die `.gitattributes` des SDK verwendet `* text=auto`, ein frischer Klon ist also der sauberste Ausweg, falls die Kopie stark beschädigt ist.

**Der Fehler tritt in der CI auf.** Cacht ein CI-Image das SDK zwischen Läufen und hat ein früherer Job `flutter upgrade` auf einem 3.44.x-SDK (oder aus dem SDK-Baum heraus) ausgeführt, trägt der gecachte Checkout die veränderte Lock-Datei, und jeder spätere Upgrade-Schritt schlägt fehl. Legen Sie die Version in der CI fest, statt zu upgraden; siehe [mehrere Flutter-Versionen aus einer CI-Pipeline ansteuern](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

**`flutter upgrade` hat funktioniert, aber Ihr Projekt lässt sich jetzt nicht mehr auflösen.** Das ist die zweite Hälfte, die mit den neuen SDK-Pins `pub upgrade` für Ihre App ausführt, und nicht dieser Fehler. Beginnen Sie mit [Fix für "version solving failed" in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Verwandte Artikel

- [Fix: pubspec.lock wird nach flutter upgrade oder beim Wechsel der Flutter-Version als geändert angezeigt](/de/2026/10/fix-pubspec-lock-modified-after-flutter-upgrade-or-switching-flutter-versions/) behandelt dieselbe Abweichung in der Lock-Datei Ihrer App statt in der des SDK.
- [Mehrere Flutter-Versionen aus einer CI-Pipeline ansteuern](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) zum Festlegen von SDKs, statt sie an Ort und Stelle zu upgraden.
- [Fix: "version solving failed" in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/) dazu, was direkt nach einem Upgrade kaputtgehen kann.
- [Fix: flutter doctor --android-licenses schlägt mit cmdline-tools 23 fehl](/de/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/), ein weiterer Tooling-Fehler, bei dem der Fix von Ihrem Flutter-Release abhängt.

## Quellen

- [`upgrade.dart` auf dem Branch stable](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/commands/upgrade.dart), die Reihenfolge der Prüfungen und der Aufruf von `git status -s`.
- [`findProjectRoot` in `os.dart`](https://github.com/flutter/flutter/blob/stable/packages/flutter_tools/lib/src/base/os.dart), die Aufwärtssuche nach `pubspec.yaml`.
- [PR #188794: Run re-entrant upgrade in original CWD](https://github.com/flutter/flutter/pull/188794), erschienen in 3.47.0.
- [PR #184997: Ignore pubspec.lock dirty checkout modifications on non-stable channels](https://github.com/flutter/flutter/pull/184997), erschienen in 3.47.0.
- [Issue #187977](https://github.com/flutter/flutter/issues/187977) (`objective_c`-Abweichung auf stable), [Issue #178777](https://github.com/flutter/flutter/issues/178777) (Abweichung auf main), [Issue #128635](https://github.com/flutter/flutter/issues/128635) (`.pub-cache` im SDK), [Issue #193197](https://github.com/flutter/flutter/issues/193197) (Extraktion mit dem Windows-Explorer).
- [Upgrading Flutter](https://docs.flutter.dev/install/upgrade) auf docs.flutter.dev, einschließlich des Windows-Abschnitts "Filename too long".
