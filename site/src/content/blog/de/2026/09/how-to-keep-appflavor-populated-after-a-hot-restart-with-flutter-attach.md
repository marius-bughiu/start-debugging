---
title: "So bleibt appFlavor nach einem Hot Restart mit flutter attach gefüllt"
description: "flutter attach kennt keine Option --flavor, daher startet der residente Compiler ohne FLUTTER_APP_FLAVOR und die Konstante appFlavor fällt beim ersten Hot Restart auf null zurück. Drei Lösungen: default-flavor in pubspec.yaml, flutter run --use-application-binary und ein Plattformkanal, der den Flavor nativ ausliest. Geprüft mit Flutter 3.47.2 / Dart 3.13.2."
pubDate: 2026-09-07
template: how-to
tags:
  - "flutter"
  - "dart"
  - "how-to"
  - "flavors"
  - "tooling"
lang: "de"
translationOf: "2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach"
translatedBy: "claude"
translationDate: 2026-09-07
---

`appFlavor` ist eine Konstante zur Kompilierzeit, keine Abfrage zur Laufzeit, und `flutter attach` kennt keine Option `--flavor`. Wenn Sie sich also an eine App hängen, die außerhalb von `flutter run` kompiliert und gestartet wurde, startet der Frontend-Compiler des Tools ohne `-DFLUTTER_APP_FLAVOR=...`, und der erste Hot Restart ersetzt Ihr korrektes `dev` durch `null`. Die schnellste Lösung ist `default-flavor` in `pubspec.yaml`, das `FlutterCommand.getBuildInfo()` für jeden Befehl liest, `attach` eingeschlossen. Soll der Flavor je Aufruf variieren, verwenden Sie `flutter run --use-application-binary=<path> --flavor dev` statt sich anzuhängen, oder lesen Sie den Flavor gar nicht mehr über `appFlavor`, sondern über die Plattform. Alles Folgende wurde mit Flutter 3.47.2 und Dart 3.13.2 im Stable-Kanal geprüft.

## appFlavor besteht aus elf Zeilen const, und das ist die ganze Geschichte

Viele nehmen an, `appFlavor` frage die Engine etwas. Das tut es nicht. Hier ist die vollständige Deklaration aus `packages/flutter/lib/src/services/flavor.dart` im Stable-Branch:

```dart
// Flutter 3.47.2, packages/flutter/lib/src/services/flavor.dart
/// The flavor this app was built with.
///
/// This is equivalent to the value argued to the `--flavor` option at build time.
/// This will be `null` if the `--flavor` option was not provided.
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

`String.fromEnvironment` löst der CFE beim Kompilieren des Kernels auf, und zwar aus den `-D`-Flags, die der Compiler-Prozess bekommen hat. Das hat nichts mit `Platform.environment` zu tun, nichts mit der laufenden VM und nichts mit dem installierten APK. Der Wert, den der Compiler in dem Moment hatte, in dem er den Kernel erzeugt hat, ist fest eingebacken.

Das ist wichtig, weil eine Flutter-Debug-Sitzung in ihrem Leben zwei Compiler hat. Der erste läuft beim Kompilieren der App: `flutter build apk --flavor dev --debug` löst `--flavor` in `FlutterCommand.getBuildInfo()` auf und hängt `FLUTTER_APP_FLAVOR=dev` an die Dart Defines an, die als `-DFLUTTER_APP_FLAVOR=dev` auf der Kommandozeile des Frontend-Servers landen. Der zweite läuft die gesamte restliche Sitzung: der residente Compiler, den `flutter run` oder `flutter attach` für Hot Reload und Hot Restart am Leben hält. In `packages/flutter_tools/lib/src/compile.dart` werden die Defines genau einmal auf diesen Prozess geschrieben, beim Start:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/compile.dart (abridged)
final List<String> command = <String>[
  engineDartPath,
  ...
  '--sdk-root', sdkRoot,
  '--target=$targetModel',
  '--no-print-incremental-dependencies',
  for (final Object dartDefine in dartDefines) '-D$dartDefine',
  ...buildModeOptions(buildMode, dartDefines),
  if (trackWidgetCreation) '--track-creation-locations',
  ...
];
```

Danach gibt es keinen Kanal mehr, um `dartDefines` zu ändern. Jeder Hot Reload und jeder Hot Restart im weiteren Verlauf der Sitzung wird von genau diesem Prozess mit genau diesem Satz Defines bedient. Stand `FLUTTER_APP_FLAVOR` beim Start nicht auf der Kommandozeile, bringt kein Neustart den Wert zurück.

## Was attach registriert und was nicht

Der Konstruktor von `AttachCommand` ist eine Liste von `uses*`-Aufrufen. Hier der relevante Teil, wörtlich aus Stable:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/commands/attach.dart
addBuildModeFlags(verboseHelp: verboseHelp, defaultToRelease: false, excludeRelease: true);
usesTargetOption();
usesPortOptions(verboseHelp: verboseHelp);
usesIpv6Flag(verboseHelp: verboseHelp);
usesFilesystemOptions(hide: !verboseHelp);
usesFuchsiaOptions(hide: !verboseHelp);
usesDartDefineOption();
usesDeviceUserOption();
```

`usesFlavorOption()` fehlt. `RunCommand` ruft es in Zeile 40 von `run.dart` auf; `AttachCommand` nie. Und `getBuildInfo()`, das `attach` sehr wohl aufruft, löst den Flavor so auf:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
final String? defaultFlavor = project.manifest.defaultFlavor;
final String? cliFlavor = getValue(BuildInfoOptions.flavor);
final String? flavor = cliFlavor ?? defaultFlavor;

_ensureReservedDartDefineIsUnset(kAppFlavor, dartDefines);
if (flavor != null) {
  dartDefines.add('$kAppFlavor=$flavor');
}
```

Ohne registrierte Option `--flavor` ist `cliFlavor` gleich `null`. Ist `defaultFlavor` ebenfalls null, ist `flavor` null, das `if` läuft nie, und der residente Compiler startet ohne das Define. Die App auf dem Gerät ist ein `dev`-Build; der Compiler, der sie bedient, hält Flavors für nicht existent.

## Die Reproduktion in vier Schritten

Das ist [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261), eingereicht am 2026-09-03 und von der Triage gegen 3.47.2 Stable bestätigt. Es tritt sowohl unter `platform-android` als auch unter `platform-ios` auf.

1. Geben Sie einer App Product Flavors und lesen Sie die Konstante an einer sichtbaren Stelle aus:

   ```dart
   // Flutter 3.47.2 / Dart 3.13.2
   import 'package:flutter/material.dart';
   import 'package:flutter/services.dart';

   void main() => runApp(const FlavorApp());

   class FlavorApp extends StatelessWidget {
     const FlavorApp({super.key});

     @override
     Widget build(BuildContext context) {
       return MaterialApp(
         home: Scaffold(
           body: Center(
             child: Text('appFlavor = $appFlavor',
                 style: const TextStyle(fontSize: 28)),
           ),
         ),
       );
     }
   }
   ```

2. Kompilieren und starten Sie sie mit dem Flavor, aber außerhalb von `flutter run`:

   ```bash
   flutter build apk --flavor dev --debug
   adb install -r build/app/outputs/flutter-apk/app-dev-debug.apk
   adb shell monkey -p com.example.flavors.dev 1
   ```

3. Hängen Sie sich an: `flutter attach --debug`. Auf dem Bildschirm steht weiterhin `appFlavor = dev`, weil noch nichts neu kompiliert wurde.

4. Drücken Sie `R` für einen Hot Restart. Jetzt steht dort `appFlavor = null`.

Schritt 3 macht die Diagnose so verwirrend. Der Wert stimmt bis zum ersten Restart, deshalb wirkt der Fehler so, als gehöre er zu dem Code, den Sie gerade bearbeitet haben, und nicht zum Tool.

## Lösung 1: default-flavor in pubspec.yaml

`default-flavor` kam mit [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968) in das Pubspec-Schema, und [#169298](https://github.com/flutter/flutter/pull/169298) hat die Auflösung nach `FlutterCommand.getBuildInfo()` verschoben, sodass sie für jeden Befehl gilt, der ein `BuildInfo` erzeugt, nicht nur für `run` und `build`. `attach` ist einer dieser Befehle. Deshalb funktioniert das hier.

1. Fügen Sie das Feld unter dem Schlüssel `flutter:` in `pubspec.yaml` ein:

   ```yaml
   # pubspec.yaml, Flutter 3.47.2
   name: flavors_example
   environment:
     sdk: ^3.13.0

   flutter:
     uses-material-design: true
     default-flavor: dev
   ```

2. Starten Sie die Attach-Sitzung neu. `flutter attach --debug` löst `flavor` nun aus dem Manifest zu `dev` auf, hängt `FLUTTER_APP_FLAVOR=dev` an die Defines an, und der Hot Restart liefert weiterhin `dev`.

3. Verwenden Sie `--flavor` weiterhin explizit dort, wo es die Option gibt. Der Hilfetext von `usesFlavorOption()` sagt selbst "Overrides the value of the `default-flavor` entry in the flutter pubspec", also gewinnt `flutter run --flavor staging` weiterhin gegen `default-flavor: dev`.

Die Einschränkung ist genau die, die man von einem Wert in einer eingecheckten Datei erwartet: ein Flavor, für alle, bei jedem Attach. Wenn Ihre CI auf einem Rechner an einen `staging`-Build und auf einem anderen an einen `dev`-Build andockt, kann `default-flavor` dem nicht folgen. Es gibt einen offenen Vorschlag, [#191376](https://github.com/flutter/flutter/pull/191376), für plattformspezifische `default-flavor`-Werte, aber auch der macht den Wert nicht pro Aufruf variabel.

## Warum --dart-define=FLUTTER_APP_FLAVOR abgelehnt wird

Die naheliegende Abhilfe ist, das Define von Hand zu setzen, und `attach` registriert `usesDartDefineOption()`, das Flag wird also geparst. Trotzdem schlägt es fehl:

```bash
flutter attach --debug --dart-define=FLUTTER_APP_FLAVOR=dev
# FLUTTER_APP_FLAVOR is used by the framework and cannot be set using
# --dart-define or --dart-define-from-file
```

Diese Absicherung ist Absicht, und sie deckt auch die Prozessumgebung ab:

```dart
// Flutter 3.47.2, packages/flutter_tools/lib/src/runner/flutter_command.dart
void _ensureReservedDartDefineIsUnset(String define, List<String> dartDefines) {
  if (_platform.environment[define] != null) {
    throwToolExit('$define is used by the framework and cannot be set in the environment.');
  }
  if (dartDefines.any((String d) => d == define || d.startsWith('$define='))) {
    throwToolExit(
      '$define is used by the framework and cannot be '
      'set using --${FlutterOptions.kDartDefinesOption} or --${FlutterOptions.kDartDefineFromFileOption}',
    );
  }
}
```

`FLUTTER_APP_FLAVOR` steht zusammen mit `FLUTTER_BUILD_NAME`, `FLUTTER_BUILD_NUMBER` und `FLUTTER_ENABLED_FEATURE_FLAGS` auf dieser reservierten Liste. Die Variable vor dem Tool-Aufruf in der Shell zu setzen, hilft ebenfalls nicht: Der erste Zweig prüft `_platform.environment` und bricht mit einer anderen Meldung ab. Wer das früher bei Web-Builds gemacht hat, landet bei [#172165](https://github.com/flutter/flutter/issues/172165), geschlossen als ungültig: Das Verhalten vor 3.32 war der Unfall, nicht die heutige Ablehnung.

## Lösung 2: das fertige Binary ausführen statt sich anzuhängen

Die meisten greifen zu `flutter attach`, weil die App von etwas anderem als `flutter run` kompiliert wurde: einem Gradle-Task, einem Xcode-Schema, einem Instrumentierungs-Harness. Wenn Sie nur "installiere dieses Artefakt und gib mir eine Hot-Restart-Schleife" brauchen, erledigt `flutter run` das direkt und akzeptiert im Gegensatz zu `attach` auch `--flavor`:

```bash
# Flutter 3.47.2. run registers both --use-application-binary and --flavor.
flutter run \
  --use-application-binary=build/app/outputs/flutter-apk/app-dev-debug.apk \
  --flavor dev
```

`RunCommand` ruft `usesFlavorOption()` auf und liest `--use-application-binary` in `prebuiltApplicationBinaryPath`, Sie bekommen also einen echten `HotRunner` über einem selbst kompilierten Binary, mit `FLUTTER_APP_FLAVOR=dev` im residenten Compiler. Unter iOS zeigen Sie auf das `.app`-Bundle, das `flutter build ios --flavor dev --debug` oder Ihr Xcode-Schema erzeugt. Das kommt einer korrekten Lösung ohne Eingriff in den Dart-Code am nächsten, und in der CI ist es das, wozu ich zuerst greife.

Es hilft nicht, wenn Sie den Start wirklich nicht kontrollieren, etwa wenn eine native Host-App Flutter als Modul einbettet und die Engine selbst startet. Dafür ist Lösung 3 da.

## Lösung 3: den Flavor über die Plattform lesen, nicht aus dem Kernel

Wenn der Flavor ein beliebiges Attach überstehen muss, hören Sie auf, eine Konstante zur Kompilierzeit nach einem Wert zu fragen, den der Compiler nicht kennt. Der Flavor liegt nativ ohnehin vor, unter Android in `BuildConfig.FLAVOR` und unter iOS in dem Build Setting, das Ihr Xcode-Schema steuert, und ein Plattformkanal liest ihn nach dem Neustart des Isolates aus, statt vor dem Kompilieren. Die Technik ist dieselbe wie in [plattformspezifischen Code ohne eigenes Plugin hinzufügen](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

Zuerst Android. AGP 8.0 erzeugt `BuildConfig` nur noch auf Anforderung, und die Flutter-App-Vorlage fordert es nicht an, also schalten Sie es ein:

```kotlin
// android/app/build.gradle.kts, AGP 8.13, Flutter 3.47.2
android {
    namespace = "com.example.flavors"

    buildFeatures {
        buildConfig = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
        }
        create("staging") {
            dimension = "env"
            applicationIdSuffix = ".staging"
        }
    }
}
```

Dann beantworten Sie einen Kanalaufruf in `MainActivity`:

```kotlin
// android/app/src/main/kotlin/com/example/flavors/MainActivity.kt
package com.example.flavors

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.example.flavors/flavor",
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "getFlavor" -> result.success(BuildConfig.FLAVOR)
                else -> result.notImplemented()
            }
        }
    }
}
```

Unter iOS legen Sie pro xcconfig ein benutzerdefiniertes Build Setting an (`APP_FLAVOR = dev` in `Debug-dev.xcconfig`), machen es in `Info.plist` als String `FLUTTER_APP_FLAVOR` mit dem Wert `$(APP_FLAVOR)` sichtbar und lesen es aus dem Bundle:

```swift
// ios/Runner/AppDelegate.swift, Xcode 26.4, Flutter 3.47.2
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let controller = window?.rootViewController as! FlutterViewController
    let channel = FlutterMethodChannel(
      name: "com.example.flavors/flavor",
      binaryMessenger: controller.binaryMessenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "getFlavor" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(Bundle.main.object(forInfoDictionaryKey: "FLUTTER_APP_FLAVOR") as? String)
    }
    GeneratedPluginRegistrant.register(with: self)
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
```

Auf der Dart-Seite lösen Sie einmal auf und fallen auf Plattformen ohne nativen Handler auf `appFlavor` zurück:

```dart
// Flutter 3.47.2 / Dart 3.13.2
import 'package:flutter/services.dart';

const _channel = MethodChannel('com.example.flavors/flavor');

/// Survives hot restart under `flutter attach`, because it is a call, not a const.
Future<String?> resolveFlavor() async {
  try {
    return await _channel.invokeMethod<String>('getFlavor') ?? appFlavor;
  } on MissingPluginException {
    return appFlavor; // desktop, web, unit tests
  }
}
```

Der Preis ist, dass `resolveFlavor()` asynchron ist und `appFlavor` nicht. Alles, was in `main()` synchron nach Flavor verzweigt hat, muss nun vor `runApp` darauf warten oder den Wert aus einem Provider beziehen. Das ist ein echtes Refactoring, und deshalb würde ich es nur angehen, wenn Lösung 1 und Lösung 2 beide ausscheiden.

## Was wie dieser Fehler aussieht, es aber nicht ist

**Der Hotfix in 3.32.1.** Wer nach diesem Symptom sucht, landet bei [#165803](https://github.com/flutter/flutter/issues/165803) und [#169160](https://github.com/flutter/flutter/issues/169160), wo `appFlavor` nach einem Hot Restart unter schlichtem `flutter run --flavor` und während `flutter test --flavor` null wurde. Das hatte eine andere Ursache: `KernelSnapshot` in `build_system/targets/common.dart` übersprang das Hinzufügen des Flavors, wenn aus dem xcodebuild-Abschnitt des Builds bereits ein Define vorhanden war. [PR #169602](https://github.com/flutter/flutter/pull/169602) änderte das so, dass vorhandene Einträge entfernt und der eigene zuletzt angehängt wird; der Changelog-Eintrag erschien in **Flutter 3.32.1**. Wenn Sie auf 3.32.1 oder neuer sind und unter `flutter run` weiterhin null sehen, ist das ein neuer Fehler und nicht dieser.

**Hot Reload, nicht nur Hot Restart.** Der Satz Defines steht fest, sobald der residente Compiler startet, und gilt damit für jede inkrementelle Kompilierung, nicht nur für vollständige Restarts. Ein Hot Reload, der eine Bibliothek neu kompiliert, die `appFlavor` liest, kann die Konstante dort zu null auswerten, während andere Bibliotheken den alten Wert behalten. Gehen Sie nicht davon aus, dass `r` sicher ist, nur weil `R` es nicht ist.

**Flavors, die nur in Gradle existieren.** `appFlavor` meldet den an `--flavor` übergebenen Wert, der einem Product-Flavor-Namen entsprechen muss. Haben Sie einen Flavor in `build.gradle.kts` umbenannt und kompilieren weiter mit dem alten Namen, schlägt der Build fehl, bevor das hier überhaupt eine Rolle spielt. Das Einrichten der Flavor-Dimensionen selbst liegt außerhalb dieses Artikels; wenn `assembleDevDebug` scheitert, ist [die Checkliste zu assembleDebug mit Exit Code 1](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) näher dran.

**Attach-Aktionen der IDE.** IntelliJ ist von der anderen Seite gegen dieselbe Wand gelaufen, in flutter-intellij#5237: Die Attach-Aktion übergab `--flavor` und starb mit `Could not find an option named 'flavor'`. Die IDE-Lösung war, das Flag wegzulassen, und deshalb zeigt sich dieses Verhalten auch beim Anhängen aus Android Studio oder VS Code. `default-flavor` ist derzeit das Einzige, was den IDE-Pfad repariert, denn deren Kommandozeile kontrollieren Sie nicht.

Der Upstream-Vorschlag in #192261 ist eine Zeile: `usesFlavorOption()` im Konstruktor von `AttachCommand` aufrufen. `getBuildInfo()` macht aus der Option bereits das Define, mehr Verkabelung ist nicht nötig. Bis das landet, behandeln Sie `appFlavor` unter `attach` als "genau einmal korrekt" und wählen die der drei Lösungen, die dazu passt, wie viel vom Start Sie kontrollieren.

## Verwandt

- [So fügen Sie plattformspezifischen Code in Flutter ohne Plugins hinzu](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/) führt durch die `MethodChannel`-Einrichtung, auf der Lösung 3 aufbaut.
- [Fix: Gradle-Task assembleDebug scheitert mit Exit Code 1 in einem Flutter-Android-Build](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) behandelt die Flavor- und NDK-Fehlkonfigurationen, die den Build zerlegen, bevor `appFlavor` überhaupt eine Rolle spielt.
- [So zielen Sie aus einer CI-Pipeline auf mehrere Flutter-Versionen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) lohnt sich neben Lösung 2, denn `--use-application-binary` ist vor allem ein CI-Zug.
- [Flutter iOS von Windows aus debuggen: ein realer Workflow mit echtem Gerät](/de/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/) ist die andere Stelle, an der `flutter attach` sich lohnt, und dieselbe Unterscheidung zwischen Konstante und Laufzeit gilt dort ebenso.
- [Fix: Firebase-Auth-Anmeldung bleibt in einem Flutter-Android-Release-Build nicht bestehen](/de/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) passt gut dazu, wenn Ihre Flavors auch unterschiedliche Firebase-Projekte bedeuten.

## Quellen

- [flutter/flutter#192261](https://github.com/flutter/flutter/issues/192261), das offene Issue zum fehlenden `--flavor` bei `attach`, mit Triage-Bestätigung auf 3.47.2.
- [Die Konstante `appFlavor`](https://api.flutter.dev/flutter/services/appFlavor-constant.html) in der Flutter-API-Dokumentation und ihr Quelltext in `packages/flutter/lib/src/services/flavor.dart`.
- [Flutter Pubspec-Optionen](https://docs.flutter.dev/tools/pubspec) zum Feld `default-flavor` und [Flutter-Flavors für Android einrichten](https://docs.flutter.dev/deployment/flavors) für die Flavor-Einrichtung selbst.
- [flutter/flutter#147968](https://github.com/flutter/flutter/pull/147968) hat `default-flavor` eingeführt; [#169298](https://github.com/flutter/flutter/pull/169298) und der Roll-forward [#169602](https://github.com/flutter/flutter/pull/169602) haben die Flavor-Auflösung nach `getBuildInfo()` verschoben.
- [Das Flutter-CHANGELOG](https://github.com/flutter/flutter/blob/main/CHANGELOG.md) für den Hotfix-Eintrag zu 3.32.1, der `appFlavor` unter `flutter test` und Hot Restart abdeckt.
- [Die Release Notes zum Android Gradle Plugin 8.0](https://developer.android.com/build/releases/past-releases/agp-8-0-0-release-notes) zur geänderten Vorgabe von `buildFeatures.buildConfig`, die Lösung 3 umgehen muss.
