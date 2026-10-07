---
title: "Fix: Bad state: No suitable NDK found for target architecture arm64 in einem Flutter-Build"
description: "Der Build-Hook von android_libcpp_shared (0.2.0 und älter) findet Ihr NDK nicht, oder Ihr minSdk liegt über der neuesten API des NDK. Aktualisieren Sie auf 0.2.1+ oder installieren Sie ein NDK, das Ihr minSdk abdeckt."
pubDate: 2026-10-07
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "ndk"
  - "native-assets"
lang: "de"
translationOf: "2026/10/fix-no-suitable-ndk-found-for-target-architecture-in-flutter"
translatedBy: "claude"
translationDate: 2026-10-07
---

Dieser Fehler stammt weder von Gradle noch von Flutter. Er wird vom Dart-Build-Hook des Pakets `android_libcpp_shared` (Versionen 0.1.0 bis 0.2.0) ausgelöst, das einige FFI-Pakete wie `croppy` transitiv einbinden. Es gibt zwei Ursachen. Entweder verfehlt die eigene NDK-Suche des Hooks das NDK, das Gradle problemlos verwendet, oder jedes gefundene NDK endet bei einem API-Level unterhalb des `minSdk` Ihrer App. Für den ersten Fall aktualisieren Sie das Paket auf 0.2.1 oder neuer (bei transitiver Abhängigkeit mit `dependency_overrides`). Für den zweiten Fall installieren Sie ein NDK, dessen Sysroot Ihr `minSdk` abdeckt: NDK r28c und r29 enden bei API 35, daher benötigt `minSdk = 36` das NDK r30.

Alles Folgende wurde unter macOS mit Flutter 3.44.8 (Dart 3.12.2), dem Gradle 9.1.0 der Flutter-Vorlage, OpenJDK 17 und NDK r28c (`28.2.13676358`) in einem Android SDK unter `/opt/homebrew/share/android-commandlinetools` reproduziert. Den Hook-Quellcode von `android_libcpp_shared` 0.1.0 bis 0.3.1 habe ich direkt aus den pub.dev-Archiven gelesen.

## Der Fehler im Kontext

Dies ist die Ausgabe von `flutter build apk --debug --target-platform android-arm64` bei einer frisch erstellten App, zu der `android_libcpp_shared: 0.2.0` hinzugefügt wurde und sonst nichts geändert ist (die langen `--packages`-Pfade sind gekürzt):

```text
Unhandled exception:
Bad state: No suitable NDK found for target architecture arm64.
#0      main.<anonymous closure> (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:31:7)
<asynchronous suspension>
#1      build (package:hooks/src/api/build_and_link.dart:250:5)
<asynchronous suspension>
#2      main (file:///Users/marius/.pub-cache/hosted/pub.dev/android_libcpp_shared-0.2.0/hook/build.dart:12:3)
<asynchronous suspension>

  Building assets for package:android_libcpp_shared failed.
  build.dart returned with exit code: 255.
  To reproduce run:
  (cd .../android_libcpp_shared-0.2.0/; .../dart-sdk/bin/dart --packages=.../package_config.json .../hooks_runner/android_libcpp_shared/cbb4418675/hook.dill --config=.../input.json )
  stdout:
  INFO: Searching for android NDK...

Target dart_build failed: Error: Building native assets failed. See the logs for more details.

FAILURE: Build failed with an exception.

* What went wrong:
Execution failed for task ':app:compileFlutterBuildDebug'.
```

Die Architektur am Ende ändert sich mit Ihrem Ziel: `arm64`, `arm` oder `x64`. Ein Release-Build ohne `--target-platform` kompiliert alle drei, daher sehen Sie die ABI, die der Hook-Runner zuerst versucht.

Das Detail, das alle verwirrt: Gradle hatte auf dieser Maschine bereits das NDK `28.2.13676358` aufgelöst. Flutters eigenes Gradle-Plugin erzwingt bei jedem Android-Build den Download dieses NDK, das NDK war also installiert, gültig und in Verwendung. Der Hook hat nur nicht dort gesucht, wo es lag.

## Warum ein Build-Hook überhaupt nach einem NDK sucht

In aktuellen stabilen Flutter-Versionen können Pakete eine `hook/build.dart` mitliefern, die während `flutter build` läuft, um nativen Code zu kompilieren oder einzubinden (das Feature "Native Assets" bzw. "Build Hooks", aufgebaut auf `package:hooks` und `package:code_assets`). Flutter führt diese Hooks im Target `dart_build` aus, bevor Gradle irgendetwas kompiliert, und übergibt jedem Hook eine JSON-Konfiguration mit dem Ziel-Betriebssystem, der Architektur, dem gefundenen C-Compiler und `targetNdkApi`.

`android_libcpp_shared` existiert, um `libc++_shared.so` einzubinden, die gemeinsam genutzte C++-Laufzeit, die FFI-Bibliotheken, die mit `-stl=c++_shared` kompiliert wurden, zur Ladezeit benötigen. Dazu muss das Paket ein NDK auf der Festplatte finden, und in 0.2.0 und früher führte es eine eigene Suche aus, statt dem von Flutter übergebenen Wert zu vertrauen. Zwei Stellen in dieser Suche können nichts zurückgeben, und beide enden im selben `StateError`.

### Ursache 1: Der Hook durchsucht weniger Orte als Gradle

In 0.2.0 sammelt `NDKLocator.locate()` Kandidaten aus genau vier Quellen:

1. `ndk-build` im `PATH`, wobei jedoch das übergeordnete Verzeichnis des NDK-Verzeichnisses aufgelöst wird statt des Verzeichnisses selbst, sodass diese Quelle nie traf (das Changelog von 0.2.1 nennt dies als Fix).
2. Die Umgebungsvariablen `ANDROID_NDK`, `ANDROID_NDK_HOME`, `ANDROID_NDK_LATEST_HOME` und `ANDROID_NDK_ROOT`.
3. Ein fest einkodierter Glob pro Betriebssystem: `$HOME/Library/Android/sdk/ndk/*/` unter macOS, `$HOME/Android/Sdk/ndk/*/` unter Linux, `$HOME/AppData/Local/Android/Sdk/ndk/*/` unter Windows.
4. `ndk/*/` unterhalb von `ANDROID_HOME`, `ANDROID_SDK_ROOT` oder `ANDROID_SDK_HOME`.

Nicht gelesen wird `sdk.dir` in `android/local.properties`, woher Gradle das SDK tatsächlich bezieht, ebenso wenig der Wert `android-sdk`, den Sie mit `flutter config --android-sdk` setzen. Flutter selbst beachtet beides. Jedes SDK außerhalb des Standardorts von Android Studio und ohne exportiertes `ANDROID_HOME` ist für den Hook daher unsichtbar: das `android-commandlinetools` von Homebrew, ein eigenes Laufwerk unter Windows oder ein CI-Image, das nur `local.properties` schreibt. Unter Windows gibt es eine zweite Falle: Der Glob expandiert `$HOME` mit `Platform.environment['HOME']!`, und `HOME` ist in einer normalen `cmd.exe`-Sitzung nicht gesetzt.

### Ursache 2: Ihr minSdk ist höher als die neueste API in jedem gefundenen NDK

Selbst wenn ein NDK gefunden wird, akzeptiert der Hook es nur, wenn dessen Sysroot ein API-Level-Verzeichnis auf oder über dem minimalen SDK Ihrer App enthält:

```dart
// android_libcpp_shared 0.2.0, lib/src/locate_ndk.dart
NDKApiLevel? highestMatching(int minApiLevel) {
  final suitableApiLevels =
      _apiLevels.where((api) => api.level >= minApiLevel).toList()
        ..sort((a, b) => b.level.compareTo(a.level));
  return suitableApiLevels.isNotEmpty ? suitableApiLevels.first : null;
}
```

`minApiLevel` ist `targetNdkApi` aus der Hook-Konfiguration, und Flutter befüllt es aus dem zusammengeführten `minSdk` Ihrer App: `FlutterPlugin.kt` liest `variant.mergedFlavor.minSdkVersion` und übergibt es als `-dMinSdkVersion` an `flutter assemble`. Die API-Verzeichnisse stammen aus `toolchains/llvm/prebuilt/<host>/sysroot/usr/lib/aarch64-linux-android/`. Ich habe sie für die drei aktuellen NDKs aufgelistet:

| NDK | Revision | API-Level der Sysroot |
|-----|----------|-----------------------|
| r28c | `28.2.13676358` (Standard-`ndkVersion` von Flutter 3.44) | 21 bis 35 |
| r29 | `29.0.14206865` | 21 bis 35 |
| r30 | `30.0.16248370` | 21 bis 37 |

`minSdk = 36` scheitert mit Flutters Standard-NDK also, unabhängig davon, wie das NDK gefunden wird. Diese Prüfung bleibt auch in 0.2.1 und 0.3.x bestehen, nur mit besserer Meldung. Sie ist zudem etwas merkwürdig, denn `libc++_shared.so` liegt eine Ebene höher in `sysroot/usr/lib/<triple>/` und ist gar nicht pro API. Aber das ist die Regel, die das Paket durchsetzt, also müssen Sie sie erfüllen.

## Minimales Beispiel zur Reproduktion

Beide Ursachen lassen sich mit einer Vorlagen-App reproduzieren. Für Ursache 1 brauchen Sie ein SDK außerhalb des Standardorts und kein `ANDROID_HOME`; für Ursache 2 genügt jede Maschine.

```bash
# Flutter 3.44.8, android_libcpp_shared 0.2.0, NDK r28c
flutter create --platforms=android -e ndkapp
cd ndkapp
flutter pub add android_libcpp_shared:0.2.0
flutter build apk --debug --target-platform android-arm64
```

Um die Sicht des Hooks auf Ihre Maschine ohne vollständigen Gradle-Build zu prüfen, rufen Sie seinen Locator aus einem Wegwerf-Konsolenpaket auf. Damit habe ich die beiden Ursachen getrennt:

```dart
// Dart 3.12.2, android_libcpp_shared 0.2.0
// bin/repro.dart  -  dart run bin/repro.dart 36
import 'package:android_libcpp_shared/src/locate_ndk.dart';

Future<void> main(List<String> args) async {
  final minSdk = int.parse(args.first);
  final ndks = await NDKLocator.locate();
  print('NDKs found: ${ndks.length}');
  for (final ndk in ndks) {
    final target = ndk.hostArchitectures.first.findTarget(LibArch.arm64);
    print('${ndk.path.toFilePath()} '
        'match(minSdk=$minSdk): ${target?.highestMatching(minSdk)}');
  }
}
```

Auf meiner Maschine gibt das Skript ohne `ANDROID_HOME` `NDKs found: 0` aus (Ursache 1). Mit gesetztem `ANDROID_HOME` und dem Argument `24` gibt es `android-35` aus; mit `36` gibt es `null` aus (Ursache 2).

## Die Lösung Schritt für Schritt

### 1. Herausfinden, wer von android_libcpp_shared abhängt

Sie haben es wahrscheinlich nie selbst hinzugefügt:

```bash
# Flutter 3.44.8
flutter pub deps --style=compact | grep android_libcpp_shared
flutter pub deps --style=tree | grep -B5 android_libcpp_shared
```

Zum Zeitpunkt des Schreibens sind die Pakete auf pub.dev, die davon abhängen, `croppy` (1.5.3 pinnt exakt `0.1.0`), `flutter_piper_tts` (`^0.1.1`), `mecab_for_dart` und `than_audiotag` (`^0.2.1`) sowie `liblsl` (`^0.3.0`). Wenn bei Ihnen 0.2.0 oder älter aufgelöst wird, behebt Schritt 2 die Ursache 1.

### 2. Auf 0.2.1 oder neuer aktualisieren

0.2.1 (veröffentlicht am 2026-08-12) hat die Suche neu geschrieben. Zu den Kandidaten kommt das NDK hinzu, mit dem das Flutter-Tool baut, abgeleitet aus dem Pfad des C-Compilers in der Hook-Konfiguration, außerdem `sdk.dir` und `ndk.dir` aus `local.properties`, `flutter config --android-sdk`, eine längere Liste bekannter Verzeichnisse und die korrigierte `PATH`-Suche. Unter Windows wird zudem `USERPROFILE` gelesen.

Ist die Abhängigkeit direkt, erhöhen Sie die Version. Ist sie transitiv und gepinnt, überschreiben Sie sie:

```yaml
# pubspec.yaml, Flutter 3.44.8
dependency_overrides:
  android_libcpp_shared: ^0.2.1
```

Welche Linie Sie wählen, hängt von Ihrer Flutter-Version ab. 0.2.x hängt von `code_assets ^1.0.0` und `hooks ^2.0.2` ab. 0.3.0 und 0.3.1 wechseln zu `code_assets ^2.0.0`. Die `flutter_tools` von Flutter 3.44.8 pinnen selbst `code_assets 1.0.0`, daher empfehle ich unter 3.44 `^0.2.1`, was ich verifiziert habe. Mit 0.2.1 und ohne `ANDROID_HOME` wird dieselbe Vorlagen-App gebaut, und die APK enthält `lib/arm64-v8a/libc++_shared.so`.

Overrides gelten für den gesamten Graphen, prüfen Sie daher, dass das Paket, das die alte Version pinnt, weiterhin mit der neuen funktioniert. Bei `croppy`, das `android_libcpp_shared` nur wegen des Hook-Nebeneffekts nutzt, gibt es keine API, die brechen könnte.

### 3. Wenn Sie nicht aktualisieren können: dem alten Hook einen Pfad geben, den er durchsucht

Exportieren Sie bei 0.2.0 oder älter vor dem Build eine der Variablen, die der Hook liest:

```bash
# macOS / Linux, android_libcpp_shared 0.2.0
export ANDROID_HOME="$HOME/path/to/your/android/sdk"
flutter clean
flutter build apk
```

```powershell
# Windows PowerShell, android_libcpp_shared 0.2.0
$env:ANDROID_HOME = "D:\Android\Sdk"
$env:HOME = $env:USERPROFILE
flutter clean
flutter build apk
```

Diese Variable muss in der Umgebung dessen stehen, was den Build startet. In meinen Tests mit `flutter build` und Gradle 9.1.0 übernahm ein warmer Gradle-Daemon den neuen Wert beim nächsten Build, in beide Richtungen. Schief geht es bei Android Studio, das über das Dock, das Startmenü oder einen Launcher gestartet wurde: GUI-Apps lesen `~/.zshrc` nicht, daher scheitert `flutter run` aus der IDE, während derselbe Befehl im Terminal funktioniert. Starten Sie die IDE aus einer Shell, die die Variable besitzt, oder verwenden Sie Schritt 2.

Überspringen Sie beim Testen nicht `flutter clean`. Flutter speichert Hook-Ergebnisse unter `.dart_tool/` zwischen, und in meiner Reproduktion blieb ein Build ohne `ANDROID_HOME` erfolgreich, weil er die erfolgreiche Hook-Ausgabe des vorherigen Builds wiederverwendete. Man glaubt, die Lösung funktioniere, bis ein sauberer CI-Runner das Gegenteil beweist.

### 4. Wenn Ihr minSdk über 35 liegt: ein NDK installieren, das ihn abdeckt

Für Ursache 2 ist die einzig richtige Lösung ein NDK, dessen Sysroot Ihr `minSdk` erreicht. Setzen Sie es explizit, damit Gradle es auf jeder Maschine und jedem CI-Runner herunterlädt:

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8, AGP 9.0.1
android {
    ndkVersion = "30.0.16248370" // NDK r30: sysroot API levels 21 to 37
    defaultConfig {
        minSdk = 36
    }
}
```

0.2.1 und neuer sortieren jedes gefundene NDK nach Version und nehmen das neueste, das die API-Prüfung besteht, daher genügt es, r30 neben r28c installiert zu haben. Prüfen Sie vor jeder Änderung selbst, welche NDKs installiert sind:

```bash
# any NDK r23 or later; the host folder is darwin-x86_64 even on Apple silicon
ls "$ANDROID_HOME"/ndk/*/toolchains/llvm/prebuilt/*/sysroot/usr/lib/aarch64-linux-android/
```

Die höchste Zahl in dieser Auflistung ist das höchste `minSdk`, das dieses NDK für diesen Hook erfüllen kann.

## Der Override libcpp_shared_path und die Multi-ABI-Falle

0.2.1 hat außerdem einen Notausgang ergänzt: ein User Define, das direkt auf die Bibliothek zeigt. Die resultierende Fehlermeldung ab 0.2.1 schlägt ihn sogar vor:

```yaml
# pubspec.yaml, android_libcpp_shared 0.2.1
hooks:
  user_defines:
    android_libcpp_shared:
      libcpp_shared_path: /path/to/ndk/toolchains/llvm/prebuilt/darwin-x86_64/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so
```

Ist der Wert eine Datei, überspringt er die NDK-Suche und die API-Prüfung vollständig, sodass ein Build mit `minSdk = 36` damit tatsächlich grün wird. Es ist aber ein einziger Pfad für alle Architekturen. Ich habe mit diesem Override eine Release-APK gebaut und untersucht:

```text
lib/arm64-v8a/libc++_shared.so:   ELF 64-bit LSB shared object, ARM aarch64
lib/armeabi-v7a/libc++_shared.so: ELF 64-bit LSB shared object, ARM aarch64
lib/x86_64/libc++_shared.so:      ELF 64-bit LSB shared object, ARM aarch64
```

Die Slots für 32-Bit-ARM und x86_64 enthalten nun eine arm64-Bibliothek. Der Build gelingt, die App wird ausgeliefert, und das Laden der Bibliothek scheitert auf jedem Gerät oder Emulator, der nicht arm64 ist. Verwenden Sie einen Dateipfad nur, wenn Sie eine einzelne ABI bauen (`--target-platform android-arm64`). Zeigen Sie das User Define oder die Umgebungsvariable `ANDROID_LIBCPP_SHARED_PATH` stattdessen auf ein NDK-Stammverzeichnis, löst der Hook jede Architektur korrekt auf, aber dieser Pfad läuft wieder durch die API-Prüfung und umgeht Ursache 2 daher nicht.

## Was die neueren Versionen stattdessen ausgeben

Wenn Sie 0.2.1 oder neuer verwenden und trotzdem scheitern, sehen Sie nicht die Formulierung "No suitable NDK". Der Hook wirft nun einen längeren `StateError`, der jedes berücksichtigte NDK auflistet. Meine Reproduktion mit `minSdk = 36` auf 0.2.1 ergab:

```text
Could not find libc++_shared.so for target architecture arm64 (minimum NDK API level 36).
NDK installations considered:
  - 1 NDK installation(s) found, but none support arm64 at API level 36
```

"Found, but none support ... at API level" ist Ursache 2, und Schritt 4 gilt. "No Android NDK installation was found" ist Ursache 1 auf einer Maschine, auf der selbst die erweiterte Suche scheitert, was meist bedeutet, dass das NDK nie heruntergeladen wurde: Führen Sie zuerst einen Gradle-Build eines beliebigen Android-Projekts aus oder installieren Sie es mit `sdkmanager "ndk;28.2.13676358"`.

## Ähnliche Fehler

- `NDK at .../ndk/<version> did not have a source.properties file` ist ein halb entpacktes NDK, und die Lösung ist, dieses Verzeichnis zu löschen. Das und weitere NDK-Versionskonflikte behandelt [die Anleitung zu assembleDebug mit Exit-Code 1](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- `An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format` bedeutet, dass der NDK-Download selbst beschädigt ist. Siehe [So leeren Sie den Download-Cache des SDK Managers](/de/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- `No toolchains found in the NDK toolchains folder for ABI with prefix: mips64el-linux-android` bedeutet, dass ein altes Android Gradle Plugin mit einem neuen NDK spricht. Mit Build-Hooks hat das nichts zu tun.
- `Building native assets failed` mit einer anderen Exception darüber ist der Hook eines anderen Pakets. Lesen Sie die Zeile `Building assets for package:<name> failed`, um zu sehen, welcher.

## Verwandte Themen

- [Google Play lehnt eine Flutter-App wegen 16 KB Seitengröße ab](/de/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/) ist die andere Stelle, an der die gepinnte NDK-Version darüber entscheidet, ob ein Release ausgeliefert wird.
- [Das Gradle-Journal-Cache-Lock-Timeout](/de/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/) behandelt, wie Gradle-Daemons den Build überleben, der sie gestartet hat.
- [AndroidX-Konflikte in einem Flutter-Android-Build auflösen](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/) geht die Einstellungen in `android/app/build.gradle` durch, einschließlich `ndkVersion`.

## Quellen

- [android_libcpp_shared auf pub.dev](https://pub.dev/packages/android_libcpp_shared), einschließlich des [Changelogs](https://pub.dev/packages/android_libcpp_shared/changelog) für 0.2.1 und 0.3.x.
- [NexusDynamic/android_libcpp_shared auf GitHub](https://github.com/NexusDynamic/android_libcpp_shared), der Hook und der Quellcode von `locate_ndk.dart`.
- [Flutter-Dokumentation: Hooks und Native Assets](https://docs.flutter.dev/platform-integration/bind-native-code).
- [package:hooks](https://pub.dev/packages/hooks) und [package:code_assets](https://pub.dev/packages/code_assets), das Build-Hook-Protokoll.
- [Android NDK revision history](https://developer.android.com/ndk/downloads/revision_history) für r28c, r29 und r30.
- Quellcode der `flutter_tools` von Flutter 3.44.8: `lib/src/android/gradle_utils.dart` (Standard-`ndkVersion`), `lib/src/android/android_sdk.dart` (`getNdkBinaryPath`) und `gradle/src/main/kotlin/FlutterPlugin.kt` (`-dMinSdkVersion`).
