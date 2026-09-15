---
title: "Fix: flutter doctor --android-licenses meldet 'The --licenses option is no longer needed' mit cmdline-tools 23"
description: "cmdline-tools 23.0 hat sdkmanager --licenses abgeschafft, daher meldet Flutter vor 3.47.3 einen unbekannten Lizenzstatus. Aktualisieren Sie Flutter oder fixieren Sie cmdline-tools 22.0."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "android-sdk"
  - "flutter-doctor"
lang: "de"
translationOf: "2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23"
translatedBy: "claude"
translationDate: 2026-09-15
---

Ihre Lizenzen sind vermutlich in Ordnung. Die Android SDK Command-line Tools 23.0 haben `sdkmanager` als veraltet markiert, und `sdkmanager --licenses` gibt jetzt ein Deprecation-Banner sowie "Warning: The --licenses option is no longer needed." aus und beendet sich mit 0, ohne nachzufragen. Flutter bis einschließlich 3.47.2 durchsucht diese Ausgabe nach einer Lizenzanzahl, findet keine und meldet "Android license status unknown", ganz gleich, was auf der Festplatte liegt. Aktualisieren Sie auf Flutter 3.47.3 oder neuer (der Fix steckt auch in der Beta 3.48), das `<sdk>/licenses/` direkt liest. Wenn ein Upgrade nicht möglich ist, installieren Sie cmdline-tools 22.0 und stellen Sie sicher, dass keine neuere Kopie in `cmdline-tools/` übrig bleibt.

Alles Folgende wurde auf macOS mit Flutter 3.44.8 und Flutter 3.47.3, cmdline-tools 22.0 und 23.0 nebeneinander in einem Test-SDK sowie OpenJDK 17.0.20.1 reproduziert.

## Der Fehler, wie flutter doctor ihn ausgibt

`flutter doctor -v` markiert die Android-Toolchain, obwohl alles andere grün ist:

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.1.0)
    • Android SDK at /Users/you/Library/Android/sdk
    • Platform android-36, build-tools 36.1.0
    • Java version OpenJDK Runtime Environment Homebrew (build 17.0.20.1+0)
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
      See https://flutter.dev/to/macos-android-setup for more details.
```

Sie tun, was dort steht, und statt der vertrauten Abfrage "Review licenses that have not been accepted (y/N)?" erhalten Sie Folgendes, gefolgt von einem sofortigen Beenden mit Code 0:

```text
WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead.
The 'android' binary can also be found in the cmdline-tools directory, and 'android sdk' is the replacement for 'sdkmanager'.
To learn more about the Android CLI and how to use it, see the documentation (https://d.android.com/tools/agents/android-cli)

Warning: The --licenses option is no longer needed.
```

Führen Sie `flutter doctor` erneut aus, steht die Zeile "license status unknown" immer noch da. Diese Schleife ist der ganze Bug, gemeldet als [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487) (macOS, Flutter 3.47.1) und erneut als [#191558](https://github.com/flutter/flutter/issues/191558) (Windows 11) und [#191963](https://github.com/flutter/flutter/issues/191963) (Windows 10, Flutter 3.47.2).

## Warum Flutter nicht erkennen kann, ob Ihre Lizenzen akzeptiert sind

Flutters `AndroidLicenseValidator` liest die Lizenzdateien nicht selbst. Er führt `sdkmanager --licenses` aus, liest stdout Zeile für Zeile und prüft drei reguläre Ausdrücke. Das ist der Code in `packages/flutter_tools/lib/src/android/android_workflow.dart` beim Tag 3.44.8:

```dart
// Flutter 3.44.8, packages/flutter_tools/lib/src/android/android_workflow.dart
final licenseCounts = RegExp(r'(\d+) of (\d+) SDK package licenses? not accepted.');
final licenseNotAccepted = RegExp(r'licenses? not accepted', caseSensitive: false);
final licenseAccepted = RegExp(r'All SDK package licenses accepted.');
```

Passt einer davon, wird der Status zu `some`, `none` oder `all`. Passt keiner, gibt der Validator `LicensesAccepted.unknown` zurück, und das ist die Zeile, die Sie gerade vor sich haben.

cmdline-tools 22.0 gibt das Deprecation-Banner bereits aus, erledigt danach aber weiterhin die Lizenzprüfung, sodass die regulären Ausdrücke ihre Zeile noch finden. Mit meinem Test-SDK, in dem nur `android-sdk-license` vorhanden war, gab 22.0 Folgendes aus:

```text
Loading local repository...

6 of 7 SDK package licenses not accepted.
Review licenses that have not been accepted (y/N)?
```

cmdline-tools 23.0 lässt diesen Teil komplett weg. Ich habe `sdkmanager --licenses` aus 23.0 zweimal ausgeführt, einmal mit vorhandenem `licenses/`-Ordner und einmal mit umbenanntem Ordner. Die Ausgabe war beide Male identisch: das Banner, die Warnung "no longer needed", Exit-Code 0. Das Tool meldet den Lizenzstatus in keiner Form mehr, also gibt es für Flutter nichts zu parsen. Der Autor des Fix-PRs kam zum selben Ergebnis und fand auch in der neuen `android`-CLI keinen Unterbefehl für den Lizenzstatus.

Die zweite Hälfte der Schleife hat dieselbe Ursache. `flutter doctor --android-licenses` ist nur ein Wrapper, der `sdkmanager --licenses` interaktiv ausführt und Ihre Tastatureingaben durchreicht. Wenn 23.0 die Warnung ausgibt und sich beendet, gibt es nichts zu akzeptieren, und Flutter hat beim nächsten `flutter doctor`-Lauf nichts Neues zu lesen.

## Reproduktion: die Versionsmatrix

Um sicherzugehen, dass das die ganze Geschichte ist, habe ich ein Test-SDK-Root mit `cmdline-tools/22.0` und `cmdline-tools/23.0` angelegt, `ANDROID_HOME` darauf zeigen lassen und `flutter doctor -v` mit jeder Kombination ausgeführt. Flutter sucht zuerst nach `cmdline-tools/latest/bin/sdkmanager` und weicht dann auf den versionierten Ordner mit der höchsten Nummer aus, daher genügt es, den Ordner `23.0` zu verstecken, um umzuschalten.

| Flutter | cmdline-tools | `licenses/` auf der Festplatte | `flutter doctor` meldet |
| --- | --- | --- | --- |
| 3.44.8 | 22.0 | nur `android-sdk-license` | Some Android licenses not accepted |
| 3.44.8 | 22.0 | fehlt | Android licenses not accepted |
| 3.44.8 | 23.0 | nur `android-sdk-license` | Android license status unknown |
| 3.44.8 | 23.0 | fehlt | Android license status unknown |
| 3.47.3 | 23.0 | nur `android-sdk-license` | All Android licenses accepted |
| 3.47.3 | 23.0 | fehlt | Android licenses not accepted |
| 3.47.3 | 23.0 | `android-sdk-license` vorhanden, aber leer | Android licenses not accepted |

Auf einem Flutter ohne Fix macht 23.0 aus jedem Zustand "unknown". Auf 3.47.3 hängt die Antwort wieder von den Dateien ab.

## Fix 1: Flutter auf 3.47.3 oder neuer aktualisieren

Der Fix ist [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554), am 2026-08-29 in master gemergt und am 2026-09-02 nach stable ([#192133](https://github.com/flutter/flutter/pull/192133)) und beta ([#192132](https://github.com/flutter/flutter/pull/192132)) per Cherry-Pick übernommen. Die ersten Releases, die ihn enthalten, sind stable 3.47.3 und beta 3.48.0-0.4.pre. Der Hotfix-Eintrag für 3.47.3 in `CHANGELOG.md` nennt #191487 ausdrücklich.

```bash
# Flutter 3.47.x stable channel
flutter channel stable
flutter upgrade
flutter --version   # expect 3.47.3 or later
flutter doctor -v
```

Der Patch ist eng gefasst. Er fügt einen weiteren regulären Ausdruck hinzu, `--licenses option is no longer needed`. Taucht diese Zeile auf und hat keines der alten Muster gepasst, vertraut Flutter stdout nicht mehr und listet `<sdk>/licenses/` auf. Jede nicht versteckte, nicht leere Datei dort bedeutet `all`. Keine brauchbare Datei bedeutet `none`. Lässt sich das Verzeichnis nicht auflisten, lautet das Ergebnis `unknown`. Ältere `sdkmanager`-Versionen durchlaufen weiterhin unverändert das ursprüngliche Parsing.

Wenn Sie an eine ältere Flutter-Linie gebunden sind (3.44.x, 3.41.x), gibt es keinen Backport. Die Cherry-Picks gingen nur in die Candidate-Branches 3.47 und 3.48, verwenden Sie auf diesen Linien also Fix 3 oder leben Sie mit der rein kosmetischen Warnung.

## Fix 2: prüfen, ob die Lizenzen tatsächlich auf der Festplatte liegen

Bevor Sie annehmen, dass die doctor-Zeile lügt, prüfen Sie nach. Die Lizenzannahme wurde schon immer als Hash-Dateien unter dem SDK-Root gespeichert, und genau diese liest Gradle, wenn es entscheidet, ob es eine fehlende Plattform oder ein fehlendes build-tools-Paket automatisch herunterladen darf:

```bash
# any OS with a POSIX shell; ANDROID_HOME points at the SDK root
ls -la "$ANDROID_HOME/licenses"
cat "$ANDROID_HOME/licenses/android-sdk-license"
```

Auf einem funktionierenden Rechner sehen Sie mindestens `android-sdk-license` mit einem oder mehreren Hashes aus 40 Zeichen, etwa `24333f8a63b6825ea9c5514f83c2829b004d1fee`. Ist die Datei vorhanden, funktioniert `flutter build apk` unabhängig davon, was ein `flutter doctor` ohne Fix meldet. Dem Autor des Issues fiel dasselbe auf: APK-Builds liefen weiterhin erfolgreich durch.

Fehlt der Ordner, etwa auf einem brandneuen CI-Image, hat cmdline-tools 23.0 geändert, wie Sie ihn bekommen. Es gibt keine Abfrage mehr. Die Installation eines beliebigen Pakets schreibt die Lizenzdatei für Sie. Ich habe das auf zwei leeren SDK-Roots getestet, in die nur cmdline-tools 23.0 als `latest` kopiert war:

```bash
# cmdline-tools 23.0, fresh SDK root with no licenses/ folder
"$ANDROID_HOME/cmdline-tools/latest/bin/android" --no-metrics --sdk="$ANDROID_HOME" sdk install platform-tools

# or, the deprecated spelling, which forwards to the same code
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --install platform-tools
```

Beide Befehle beendeten sich mit geschlossenem stdin mit 0, luden `platform-tools_r37.0.1` herunter und hinterließen `licenses/android-sdk-license` mit dem Hash `24333f8a...`. Das reicht, damit Flutter 3.47.3 "All Android licenses accepted" meldet. Achten Sie auf die Paketnamen: Das neue `android sdk install` verwendet Schrägstriche (`platforms/android-36`, `build-tools/36.0.0`), nicht die Semikolons, die `sdkmanager` benutzt hat.

## Fix 3: cmdline-tools 22.0 auf älterem Flutter fixieren

Wenn Sie an einem Flutter-Release ohne den Fix festhängen und eine saubere doctor-Zeile wollen, geben Sie Flutter einen `sdkmanager`, der noch Lizenzanzahlen ausgibt. Flutter wählt zuerst `cmdline-tools/latest`, daher ändert die Installation von 22.0 neben einem `latest` mit 23.0 nichts. Sie müssen 23.0 aus dem Weg räumen.

Öffnen Sie in Android Studio **Settings > Languages & Frameworks > Android SDK > SDK Tools**, aktivieren Sie **Show Package Details**, deaktivieren Sie **Android SDK Command-line Tools (latest)**, aktivieren Sie **22.0** und übernehmen Sie die Änderung. Diesen Workaround hat der Autor von #191558 bestätigt.

Im Terminal:

```bash
# macOS/Linux, cmdline-tools 23.0 currently installed as cmdline-tools/latest
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;22.0"
mv "$ANDROID_HOME/cmdline-tools/latest" "$HOME/cmdline-tools-23.0-backup"
ls "$ANDROID_HOME/cmdline-tools"   # only 22.0 should remain
flutter doctor --android-licenses
```

Die Installation landet in `cmdline-tools/22.0`, und ohne `latest` weicht Flutter auf diesen versionierten Ordner aus. `flutter doctor --android-licenses` zeigt dann wieder die echte interaktive Abfrage, und Sie können die fehlenden Lizenzen akzeptieren. In einer nicht interaktiven Shell funktioniert `yes | flutter doctor --android-licenses` auf 22.0 weiterhin.

Zwei Warnungen zu diesem Weg. Erstens ist es eine Fixierung, und das nächste "update all" in Android Studio setzt 23.0 wieder als `latest` ein. Zweitens codiert manches Tooling `cmdline-tools/latest/bin` fest (der automatische SDK-Download von Gradle, viele CI-Skripte). Sobald die Lizenzen akzeptiert sind, ist es sauberer, Flutter zu aktualisieren und 23.0 zurückkehren zu lassen, als 22.0 für immer zu behalten.

## Stolperfallen und ähnliche Fehler

**"All Android licenses accepted" ist auf 3.47.3 großzügiger als früher.** Der Rückgriff auf die Festplatte kann `some` nicht von `all` unterscheiden. Mit nur `android-sdk-license` meldete 22.0 "6 of 7 SDK package licenses not accepted" und das alte Flutter "Some Android licenses not accepted". 3.47.3 auf 23.0 meldet "All Android licenses accepted". Für normale Builds ist das korrekt, da `android-sdk-license` Plattformen, build-tools, platform-tools und das NDK abdeckt. Preview-, TV- und XR-System-Images haben eigene Lizenzdateien (das sind die übrigen sechs in der Zählung von 22.0). Wenn Sie eines davon installieren, prüfen Sie also `licenses/` auf dessen Datei, statt der doctor-Zeile zu vertrauen.

**Eine leere Lizenzdatei gilt als nicht akzeptiert.** Manche CI-Rezepte erzeugen die Datei per `touch`, um die Annahme vorzutäuschen. Auf 3.47.3 ergibt eine `android-sdk-license` mit null Bytes "Android licenses not accepted". Schreiben Sie den echten Hash hinein, oder besser, lassen Sie `android sdk install` die Datei anlegen.

**CI-Skripte, die die doctor-Ausgabe mit grep durchsuchen.** Ein Schritt wie `flutter doctor -v | grep "All Android licenses accepted"` schlägt auf jedem Flutter ohne Fix mit 23.0 fehl. `yes | flutter doctor --android-licenses` schlägt nicht mehr fehl, bewirkt aber auch nichts mehr. Prüfen Sie stattdessen auf die Datei: `test -s "$ANDROID_HOME/licenses/android-sdk-license"`. Wenn Sie mehrere Flutter-Versionen in einer Pipeline testen, wie in [mehrere Flutter-Versionen aus einer CI-Pipeline ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), rechnen Sie damit, dass die älteren Matrix-Zweige "unknown" ausgeben, während 3.47.3 und neuer bestehen.

**Das `android`-Binary installiert sich bei der ersten Verwendung selbst.** Als ich `cmdline-tools/23.0/bin/android` zum ersten Mal ausführte, gab es "Downloading Android CLI..." aus, entpackte sich nach `~/.android/cli` und zeigte die SDK-Nutzungsbedingungen sowie einen Hinweis zu Nutzungsmetriken. Fügen Sie in CI `--no-metrics` hinzu. `android --version` meldete `1.0.16261425` mit cmdline-tools 23.0. Das Binary existiert auch in 22.0.

**"Unable to locate Android SDK" ist ein anderes Problem.** Beim Aufbau des Test-SDKs scheiterte mein erster doctor-Lauf, bevor er überhaupt die Lizenzprüfung erreichte, weil das Root zwar cmdline-tools, aber weder `platforms` noch `build-tools` enthielt. Wenn Sie diese Zeile oder "cmdline-tools component is missing" sehen, steht die Lösung im [Beitrag zu cmdline-tools component is missing](/de/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/), nicht hier.

**`flutter config --android-sdk` hat Vorrang vor `ANDROID_HOME`.** Wenn Sie irgendwann einen Pfad mit `flutter config` gesetzt haben, ignoriert Flutter `ANDROID_HOME` und prüft möglicherweise ein anderes SDK als das, das Sie gerade untersuchen. `flutter config --list` zeigt den gespeicherten Pfad, und `flutter doctor -v` gibt in der Zeile "Android SDK at" den tatsächlich verwendeten Pfad aus.

**Die neue CLI ist noch nicht in Flutter eingebunden.** Ein offener PR, [#191826](https://github.com/flutter/flutter/pull/191826), stellt auch die NDK-Bereitstellung von Flutter auf `android sdk install` um. Stand 2026-09-15 ist er nicht gemergt, daher ruft Flutter 3.47.3 für Lizenzen weiterhin den veralteten `sdkmanager` auf und verlässt sich darauf, dass dieser die alten Flags am Leben hält.

## Verwandte Beiträge

- [Fix: flutter doctor meldet cmdline-tools component is missing](/de/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) behandelt die Reihenfolge, in der Flutter das SDK sucht, und die Java-Anforderungen von `sdkmanager`, die auch hier gelten.
- Wenn sich Gradle statt doctor über Ihr JDK beschwert, lesen Sie [Toolchain installation does not provide the required capabilities](/de/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/).
- Ein beschädigter SDK-Download äußert sich anders: [NDK (Side by side): Not in GZIP format](/de/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- Ein weiterer Fall, in dem ein Hotfix-Release die eigentliche Lösung ist: [Could not create Dart VM instance nach flutter upgrade](/de/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/).

## Quellen

- [flutter/flutter#191487](https://github.com/flutter/flutter/issues/191487), das P1-Tracking-Issue, mit den Duplikaten [#191558](https://github.com/flutter/flutter/issues/191558) und [#191963](https://github.com/flutter/flutter/issues/191963).
- [flutter/flutter#191554](https://github.com/flutter/flutter/pull/191554), der Fix, mit den Cherry-Picks für stable und beta [#192133](https://github.com/flutter/flutter/pull/192133) und [#192132](https://github.com/flutter/flutter/pull/192132).
- [flutter/flutter#191826](https://github.com/flutter/flutter/pull/191826), der offene PR für vollständige Unterstützung der Android CLI.
- [Flutter CHANGELOG bei 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/CHANGELOG.md) und [`android_workflow.dart` bei 3.47.3](https://github.com/flutter/flutter/blob/3.47.3/packages/flutter_tools/lib/src/android/android_workflow.dart).
- [Dokumentation der Android CLI](https://developer.android.com/tools/agents/android-cli) für die Syntax von `android sdk install`, `list`, `update` und `remove`.
- [Dokumentation zu sdkmanager](https://developer.android.com/tools/sdkmanager).
