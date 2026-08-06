---
title: "Lösung: flutter doctor meldet cmdline-tools component is missing"
description: "Installieren Sie die Android SDK Command-line Tools so, dass die Binaries in <sdk>/cmdline-tools/latest/bin landen, setzen Sie ANDROID_HOME auf das SDK-Wurzelverzeichnis und starten Sie flutter doctor erneut."
pubDate: 2026-08-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "dart"
  - "tooling"
lang: "de"
translationOf: "2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing"
translatedBy: "claude"
translationDate: 2026-08-06
---

Die Lösung in einem Satz: `flutter doctor` prüft, ob ein Verzeichnis namens `cmdline-tools` direkt unterhalb des Android-SDK-Wurzelverzeichnisses existiert, und das tut es nicht. Öffnen Sie in Android Studio **Tools > SDK Manager > SDK Tools**, setzen Sie den Haken bei **Android SDK Command-line Tools (latest)** und klicken Sie auf Apply. Ohne Android Studio entpacken Sie das Command-line-Tools-Archiv so, dass die Binaries unter `<sdk-root>/cmdline-tools/latest/bin` liegen, setzen `ANDROID_HOME` auf `<sdk-root>` (nicht auf den Ordner `cmdline-tools`) und führen dann `flutter doctor --android-licenses` aus. Die Zeile "Android license status unknown" darunter ist eine Folge, kein zweiter Fehler: das Lizenzwerkzeug ist `sdkmanager`, und `sdkmanager` steckt in genau dem Paket, das fehlt.

```text
[!] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Android SDK at C:\Users\mariu\AppData\Local\Android\Sdk
    ✗ cmdline-tools component is missing.
      Try installing or updating Android Studio.
      Alternatively, download the tools from https://developer.android.com/studio#command-line-tools-only and make sure to set the ANDROID_HOME environment variable.
      See https://developer.android.com/studio/command-line for more details.
    ✗ Android license status unknown.
      Run `flutter doctor --android-licenses` to accept the SDK licenses.
```

Alles Folgende ist gegen Flutter 3.44.7 stable (Dart 3.12.x) verifiziert, den Stable-Kanal vom 2026-08-06, mit einem Android SDK, das `cmdline-tools;19.0`, Build-Tools 36.0.0, Platform-Tools 37.0.0 und OpenJDK 21.0.11 enthält. Die höchste Command-line-Tools-Revision im Stable-Kanal ist heute 22.0.

## Die Prüfung ist ein einzelner Verzeichnistest

Es lohnt sich zu wissen, wie wenig der Doctor hier tut, denn das erklärt die meisten verwirrenden Fälle. In `packages/flutter_tools/lib/src/android/android_workflow.dart` macht der Validator dies:

```dart
// flutter_tools, stable channel, Flutter 3.44.7
_task = 'Validating Android SDK command line tools are available';
if (!androidSdk.cmdlineToolsAvailable) {
  messages.add(
    const ValidationMessage.error(
      'cmdline-tools component is missing.\n'
      'Try installing or updating Android Studio.\n'
      ...
    ),
  );
  return ValidationResult(ValidationType.missing, messages);
}
```

Und `cmdlineToolsAvailable` in `android_sdk.dart` ist eine einzige Zeile:

```dart
// flutter_tools, stable channel, Flutter 3.44.7
bool get cmdlineToolsAvailable =>
    directory.childDirectory('cmdline-tools').existsSync();
```

Es wird kein Binary ausgeführt. Es wird keine Version geparst. Flutter nimmt das aufgelöste SDK-Wurzelverzeichnis, hängt `cmdline-tools` an und ruft `existsSync()` auf. Damit gibt es nur zwei Wege zu dieser Meldung: der Ordner fehlt tatsächlich, oder Flutter hat ein anderes SDK-Wurzelverzeichnis aufgelöst als das, auf das Sie schauen.

Der zweite Fall ist häufig genug, um die Auflösungsreihenfolge aus `locateAndroidSdk()` auszuschreiben:

1. Der Schlüssel `android-sdk` in Flutters eigener Konfiguration, gesetzt über `flutter config --android-sdk <path>`.
2. Die Umgebungsvariable `ANDROID_HOME`.
3. Die Umgebungsvariable `ANDROID_SDK_ROOT`, die Google als veraltet markiert hat, die Flutter aber weiterhin liest.
4. Der Plattformstandard: `~/Android/Sdk` unter Linux, `~/Library/Android/sdk` unter macOS, `%LOCALAPPDATA%\Android\sdk` unter Windows.
5. Als letzter Versuch ein PATH-Scan nach `aapt` (unter `build-tools/<version>/`) oder `adb` (unter `platform-tools/`), wobei die Wurzel aus deren Position abgeleitet wird.

Ein veraltetes `flutter config --android-sdk` von vor zwei Rechnern schlägt ein völlig korrektes `ANDROID_HOME`. `flutter doctor -v` gibt den Pfad aus, für den sich das Tool entschieden hat, und das ist die Zeile, die man zuerst liest.

Sobald der Ordner existiert, findet eine separate Suche die eigentliche ausführbare Datei. `getCmdlineToolsPath` probiert der Reihe nach:

1. `cmdline-tools/latest/bin/sdkmanager[.bat]`
2. den höchstnummerierten Ordner `cmdline-tools/<version>/bin/sdkmanager[.bat]`
3. `tools/bin/sdkmanager[.bat]`, das Layout von vor 2020, das für `sdkmanager` übersprungen wird, weil dieser mit `skipOldTools: true` angefordert wird

`latest` hat also Vorrang, ein versionierter Ordner funktioniert aber ebenfalls. Dieser Unterschied ist für einen der Stolpersteine weiter unten wichtig.

## In zehn Sekunden reproduziert

Auf einer funktionierenden Maschine ist der Fehler ein Umbenennen entfernt:

```bash
# Flutter 3.44.7 stable, Windows, Android SDK at %LOCALAPPDATA%\Android\Sdk
mv "$LOCALAPPDATA/Android/Sdk/cmdline-tools" "$LOCALAPPDATA/Android/Sdk/cmdline-tools.bak"
flutter doctor
```

Das ist der gesamte Fehlermodus. Es ist auch der Grund, warum der Rat "installieren Sie Android Studio neu" meist aus dem falschen Grund funktioniert: eine frische Studio-Installation setzt den Haken bei den Command-line Tools, also taucht der Ordner auf.

## Lösung 1: Installation über den SDK Manager von Android Studio

Das ist der empfohlene Weg, wenn Sie Android Studio überhaupt haben, denn Studio hält das Paket zusätzlich aktuell.

1. **Tools > SDK Manager** (oder das SDK-Manager-Symbol in der Werkzeugleiste).
2. Wählen Sie den Reiter **SDK Tools**.
3. Setzen Sie den Haken bei **Android SDK Command-line Tools (latest)**. Prüfen Sie bei der Gelegenheit, dass auch **Android SDK Build-Tools** und **Android SDK Platform-Tools** angehakt sind, denn Flutter braucht sie ebenfalls.
4. Klicken Sie auf **Apply**, akzeptieren Sie die Lizenz und warten Sie den Download ab.
5. Führen Sie `flutter doctor --android-licenses` aus und akzeptieren Sie alles, danach erneut `flutter doctor`.

Beachten Sie das Suffix "(latest)" in der Beschriftung. Das ist keine Dekoration: es sorgt dafür, dass Studio nach `cmdline-tools/latest/` installiert statt in einen nummerierten Ordner.

## Lösung 2: Installation über sdkmanager, wenn bereits eine Version vorhanden ist

Wenn Sie überhaupt Command-line Tools haben, auch eine alte Version, installieren Sie damit das aktuelle Paket:

```bash
# Android SDK Command-line Tools 19.0, JDK 21
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --install "cmdline-tools;latest"
```

Unter Windows heißt das Binary `sdkmanager.bat`. Wenn Sie für CI eine reproduzierbare Festlegung statt eines beweglichen Ziels wollen, benennen Sie die Revision explizit:

```bash
# Pin for CI. 22.0 is the newest on the stable channel as of 2026-08-06.
sdkmanager --install "cmdline-tools;22.0"
```

Hier steckt eine offensichtliche Zirkularität: `sdkmanager` liegt innerhalb von `cmdline-tools`, wenn das Paket also fehlt, können Sie `sdkmanager` nicht zu seiner Installation nutzen. Dafür ist Lösung 3 da.

## Lösung 3: das Paket von Hand aufsetzen

Das ist der Weg für Linux-Rechner ohne Oberfläche, für Container und für alle, die kein Android Studio wollen. Laden Sie das Archiv "Command line tools only" von der Android-Studio-Downloadseite und bauen Sie dann das Layout auf, das Googles Tooling erwartet. Das Archiv entpackt in einen Ordner, der wörtlich `cmdline-tools` heißt, und das ist eine Ebene zu wenig.

```bash
# Android SDK Command-line Tools, Linux, 2026-08
export ANDROID_HOME="$HOME/Android/Sdk"
mkdir -p "$ANDROID_HOME/cmdline-tools"
unzip -q commandlinetools-linux-*.zip -d /tmp/clt
mv /tmp/clt/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest"
```

Das Ziellayout, so wie es die SDK-Manager-Dokumentation vorgibt:

```text
$ANDROID_HOME/
└── cmdline-tools/
    └── latest/
        ├── bin/
        ├── lib/
        ├── NOTICE.txt
        └── source.properties
```

Zur Orientierung: `bin/` einer echten 19.0-Installation (Windows, daher die `.bat`-Wrapper) enthält:

```text
apkanalyzer.bat  avdmanager.bat  d8.bat     lint.bat      profgen.bat
r8.bat           resourceshrinker.bat  retrace.bat  screenshot2.bat  sdkmanager.bat
```

Danach die Umgebung dauerhaft setzen und die Tools in den PATH aufnehmen:

```bash
# ~/.bashrc or ~/.zshrc
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

`ANDROID_HOME` muss das SDK-Wurzelverzeichnis sein. Es auf `$HOME/Android/Sdk/cmdline-tools` oder auf `.../cmdline-tools/latest/bin` zu setzen ist die häufigste selbstverschuldete Variante dieses Fehlers, und sie erzeugt exakt dieselbe Meldung, weil `<dieser Pfad>/cmdline-tools` nicht existiert.

Zuletzt den Rest installieren, den Flutter erwartet, und verifizieren:

```bash
sdkmanager --install "platform-tools" "platforms;android-36" "build-tools;36.0.0"
sdkmanager --version
sdkmanager --list_installed
flutter doctor --android-licenses
flutter doctor -v
```

`sdkmanager --list_installed` ist die ehrliche Prüfung. Auf der Maschine, gegen die dieser Artikel geschrieben wurde, gibt sie aus:

```text
Installed packages:
  Path                  | Version       | Description                             | Location
  cmdline-tools;19.0    | 19.0          | Android SDK Command-line Tools (latest) | cmdline-tools\latest
  build-tools;36.0.0    | 36.0.0        | Android SDK Build-Tools 36              | build-tools\36.0.0
  platform-tools        | 37.0.0        | Android SDK Platform-Tools              | platform-tools
  platforms;android-36  | 2             | Android SDK Platform 36, rev 2          | platforms\android-36
```

## Lösung 4: Flutter mitteilen, wo das SDK wirklich liegt

Wenn der Ordner existiert und `sdkmanager --version` funktioniert, `flutter doctor` sich aber weiter beschwert, schaut Flutter woanders hin. Überschreiben Sie die Auflösungsreihenfolge bereits bei Schritt eins:

```bash
flutter config --android-sdk "$HOME/Android/Sdk"
flutter doctor -v
```

Zwei Fallen dabei. `flutter config --android-studio-dir` ist eine andere Einstellung für die Studio-Installation, nicht für das SDK, und sie auf `.../cmdline-tools/latest/bin` zu setzen ist ein dokumentierter Weg zurück in genau diesen Fehler. Und `flutter config` schreibt in eine Konfigurationsdatei auf Benutzerebene, ein einmal gesetzter Wert begleitet Sie also in jedes Projekt, bis Sie ihn mit `flutter config --android-sdk ""` löschen.

## Stolpersteine, die wie derselbe Fehler aussehen

**"Observed package id 'cmdline-tools;19.0' in inconsistent location"**. Jeder `sdkmanager`-Aufruf auf meiner Maschine gibt dies aus:

```text
Warning: Observed package id 'cmdline-tools;19.0' in inconsistent location
'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\latest'
(Expected 'C:\Users\mariu\AppData\Local\Android\Sdk\cmdline-tools\19.0')
```

Das ist kosmetisch. Das installierte Paket vermerkt `Pkg.Path=cmdline-tools;19.0` in seiner `source.properties`, der SDK Manager hat es aber nach `latest` gelegt, weil genau das das Paket "(latest)" bedeutet. `sdkmanager` funktioniert weiter, `flutter doctor` besteht weiter. "Reparieren" Sie das nicht durch Umbenennen von `latest` nach `19.0`: Flutter fände es zwar über die versionierte Suche, aber der automatische SDK-Download von Gradle und die meisten CI-Skripte haben `cmdline-tools/latest/bin` fest verdrahtet und würden brechen.

**Zwei `latest`-Ordner**. Sehen Sie `latest` neben `latest-2`, hat der SDK Manager über ein Verzeichnis installiert, das er nicht ersetzen konnte, meist weil ein `sdkmanager`- oder `adb`-Prozess ein Datei-Handle hielt. Löschen Sie `latest`, benennen Sie `latest-2` in `latest` um und starten Sie `flutter doctor` erneut.

**`ANDROID_SDK_ROOT` gesetzt, `ANDROID_HOME` leer**. Flutter liest beide und bevorzugt `ANDROID_HOME`. Gradle und das Android Gradle Plugin bewegen sich seit Jahren in die andere Richtung, und manche Drittanbieter-Tools lesen inzwischen nur noch `ANDROID_HOME`. Setzen Sie `ANDROID_HOME`; setzen Sie `ANDROID_SDK_ROOT` nur dann auf denselben Wert, wenn etwas in Ihrer Toolchain es noch braucht.

**Eine andere Meldung: "Android sdkmanager not found."** Vollständig: `Android sdkmanager not found. Update to the latest Android SDK and ensure that the cmdline-tools are installed to resolve this.` Das ist eine spätere Prüfung, und sie bedeutet, dass der Ordner den Existenztest bestanden hat, aber weder unter `latest/bin` noch unter einem versionierten `bin` ein `sdkmanager`-Binary gefunden wurde. Übliche Ursache ist ein verschachteltes Entpacken, `cmdline-tools/latest/cmdline-tools/bin/`, weil der Archivordner statt seines Inhalts verschoben wurde.

**Eine dritte Meldung: "Android sdkmanager tool was found, but failed to run."** Vollständig: `Android sdkmanager tool was found, but failed to run ($sdkManagerPath): "$error".` Das Binary existiert und läuft an; etwas darin wirft eine Exception. Führen Sie es direkt aus, um den echten Stack Trace zu sehen. Der klassische Verursacher ist ein `JAVA_HOME`, das auf eine alte Laufzeit zeigt, was als `UnsupportedClassVersionError` mit "class file version 61.0" (Java 17) gegen eine Laufzeit erscheint, die "recognizes class file versions up to 55.0" (Java 11). Command-line Tools ab 11.0 sind für Java 17 kompiliert. Neuere JDKs sind in der Gegenrichtung unproblematisch: 19.0 läuft klaglos auf OpenJDK 21.0.11, für diesen Artikel verifiziert.

**WSL und Container**. Richten Sie ein Linux-`ANDROID_HOME` nicht über `/mnt/c` auf ein Windows-SDK. Die Linux-Binaries liegen dort nicht, die Ausführungsbits stimmen nicht, und Sie jagen stattdessen die Variante "sdkmanager not found". Installieren Sie ein natives SDK innerhalb der Linux-Umgebung.

**CI-Runner**. Auf GitHub Actions installiert `android-actions/setup-android` die Command-line Tools und legt sie in den PATH, bevor irgendetwas anderes läuft, was diese Fehlerklasse vollständig aus der Pipeline entfernt. Fixieren Sie die Revision, statt `latest` zu folgen, wenn Builds von vor sechs Monaten weiterhin reproduzierbar sein sollen, dieselbe Überlegung gilt, wenn Sie [mehrere Flutter-Versionen aus einer einzigen CI-Pipeline ansteuern](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

**Die Lizenzzeile verschwindet nicht von allein**. Nach der Installation des Pakets meldet `flutter doctor` weiterhin `Android license status unknown`, bis Sie `flutter doctor --android-licenses` ausführen und jede einzelne akzeptieren. In einer nicht interaktiven Shell erledigt `yes | flutter doctor --android-licenses` die Aufgabe.

## Verwandte Beiträge

- [Lösung: Gradle task assembleDebug failed with exit code 1 in einem Flutter-Android-Build](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) -- die nächste Wand, gegen die Sie laufen, sobald die Toolchain validiert und der Build tatsächlich startet.
- [Lösung: AndroidX-Konflikt während eines Flutter-Android-Builds](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/) -- ein Android-Fehler auf Abhängigkeitsebene statt auf SDK-Ebene.
- [Mehrere Flutter-Versionen aus einer einzigen CI-Pipeline ansteuern](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) -- wo das Fixieren der SDK-Version aufhört, optional zu sein.
- [Lösung: Version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- das Dart-seitige Gegenstück zu einer kaputten Umgebung, mit einer ganz anderen Diagnose.
- [Lösung: Gradle build failed to produce an .apk file in MAUI Android](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) -- dieselbe Android-SDK-Verkabelung, von der .NET-Seite aus betrachtet.

## Quellen

- [Troubleshooting installation](https://docs.flutter.dev/install/troubleshoot), Flutter-Dokumentation, die den SDK-Manager-Weg für genau diese Doctor-Ausgabe zeigt.
- [sdkmanager](https://developer.android.com/tools/sdkmanager), Android-Studio-Dokumentation, für das erforderliche Layout `cmdline-tools/latest` und die Schalter `--install`, `--list_installed`, `--sdk_root` und `--channel`.
- [Android SDK Command-Line Tools release notes](https://developer.android.com/tools/releases/cmdline-tools).
- `packages/flutter_tools/lib/src/android/android_workflow.dart` und `android_sdk.dart` im Stable-Branch von [flutter/flutter](https://github.com/flutter/flutter), für den Validator-Text und die SDK-Auflösungsreihenfolge.
- [flutter/flutter#139288](https://github.com/flutter/flutter/issues/139288), wo der Melder einen Flutter-Konfigurationspfad auf `cmdline-tools/latest/bin` statt auf das SDK-Wurzelverzeichnis gesetzt hatte.
- [flutter/flutter#167413](https://github.com/flutter/flutter/issues/167413), ein noch offener Bericht darüber, dass der Doctor ein korrekt aufgebautes SDK unter Debian 12 nicht erkennt, mit gesetztem `ANDROID_SDK_ROOT` und leerem `ANDROID_HOME`.
- [android-actions/setup-android](https://github.com/android-actions/setup-android), für den CI-Ansatz.
