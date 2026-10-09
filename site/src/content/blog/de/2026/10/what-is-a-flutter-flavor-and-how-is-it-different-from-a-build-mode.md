---
title: "Was ist ein Flutter Flavor, und worin unterscheidet er sich von einem Build-Modus?"
description: "Ein Build-Modus (debug, profile, release) legt fest, wie Flutter Ihren Dart-Code kompiliert. Ein Flavor (dev, staging, prod) ist eine native Build-Variante, die Sie in Gradle und Xcode definieren und die bestimmt, welche App Sie ausliefern. Beide sind unabhängige Achsen: 2 Flavors mal 3 Modi ergeben 6 Builds. Verifiziert mit Flutter 3.44.8 und AGP 9.0.1, Quellcode geprüft gegen 3.47.7."
pubDate: 2026-10-10
tags:
  - "flutter"
  - "dart"
  - "flavors"
  - "android"
  - "ios"
  - "tooling"
lang: "de"
translationOf: "2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode"
translatedBy: "claude"
translationDate: 2026-10-10
---

Kurz gesagt: Ein **Build-Modus** legt fest, wie Flutter Ihren Dart-Code kompiliert und ausführt. Es gibt genau drei, `debug`, `profile` und `release`; sie sind fest in der Engine und im Tool verankert, und Ihr Code sieht sie über `kDebugMode`, `kProfileMode` und `kReleaseMode`. Ein **Flavor** gehört Flutter dagegen überhaupt nicht: Es ist eine native Build-Variante, die Sie selbst definieren, als Android-`productFlavors` in Gradle und als Xcode-Schemes plus Build-Konfigurationen unter iOS und macOS, und sie bestimmt, *welche App* Sie bauen (Application ID, Anzeigename, Icons, Firebase-Projekt, API-Basis-URL). Flutter reicht lediglich `--flavor dev` an den nativen Build weiter und stellt den Namen in Dart als Konstante `appFlavor` bereit. Beide Achsen sind orthogonal, ein Projekt mit den Flavors `dev` und `prod` hat also sechs Varianten, von `devDebug` bis `prodRelease`. Alles unten Beschriebene wurde mit Flutter 3.44.8 (Dart 3.12.2, Android Gradle Plugin 9.0.1, Gradle 9.1.0) gebaut und geprüft, und der relevante `flutter_tools`-Quellcode wurde mit dem aktuellen Stable-Release Flutter 3.47.7 verglichen.

## Zwei Achsen, eine Build-Matrix

Die Verwirrung entsteht meist, weil beides in derselben Befehlszeile übergeben wird und beides im Namen der Ausgabedatei landet:

```bash
# Flutter 3.44.8 / 3.47.7
flutter build apk --release --flavor prod
# -> Running Gradle task 'assembleProdRelease'...
# -> build/app/outputs/flutter-apk/app-prod-release.apk
```

`--release` wählt den Modus. `--flavor prod` wählt den Flavor. Gradle setzt beides zu einem Variantennamen zusammen, `prodRelease`, und führt `assembleProdRelease` aus. Hier die vollständige Matrix für ein Projekt mit zwei Flavors:

| | `--debug` | `--profile` | `--release` |
|---|---|---|---|
| `--flavor dev` | `app-dev-debug.apk` | `app-dev-profile.apk` | `app-dev-release.apk` |
| `--flavor prod` | `app-prod-debug.apk` | `app-prod-profile.apk` | `app-prod-release.apk` |

Die Spalten werden von Flutter bestimmt und beantworten die Frage "Wie wird der Dart-Code kompiliert, und kann ich Hot Reload nutzen?". Die Zeilen werden von Ihrer `build.gradle.kts` und Ihrem Xcode-Projekt bestimmt und beantworten die Frage "Ist das die App, die mit dem Staging-Backend spricht und auf dem Startbildschirm `Demo Dev` heißt?". Nichts an der einen Achse legt etwas an der anderen fest. Ein Debug-Build von `prod` ist völlig normal: Sie starten ihn, wenn Sie einen Fehler, der nur in Produktion auftritt, mit Haltepunkten reproduzieren müssen.

## Was ein Build-Modus tatsächlich ändert

Build-Modi betreffen die Kompilierungs-Pipeline von Dart und sind von Flutter fest vorgegeben:

- **Debug** kompiliert in eine Kernel-Datei und führt sie im JIT der Dart VM aus. Asserts sind aktiv, Service Extensions sind aktiv, Hot Reload und Hot Restart funktionieren, und die Performance ist nicht repräsentativ.
- **Profile** kompiliert vorab (AOT) zu nativem Maschinencode, wie Release, hält aber genug vom Service-Protokoll am Leben für das Tracing mit DevTools. Es läuft nicht auf Emulatoren oder Simulatoren.
- **Release** kompiliert vorab, entfernt Asserts und Debug-Informationen und ist das, was Sie ausliefern.

Den Unterschied sieht man beim Auflisten der APKs. Das Debug-APK enthält das Dart-Programm als `kernel_blob.bin` für den JIT, während die Profile- und Release-APKs ein vorkompiliertes `libapp.so` enthalten:

```text
# Flutter 3.44.8, flutter build apk --target-platform android-arm64 --flavor dev|prod
app-dev-debug.apk     26146208  assets/flutter_assets/kernel_blob.bin
app-dev-profile.apk    2753424  lib/arm64-v8a/libapp.so
app-prod-release.apk   1508240  lib/arm64-v8a/libapp.so
```

Ihr Dart-Code erfährt den Modus über drei Konstanten aus `package:flutter/foundation.dart`. Es sind Compile-Zeit-Konstanten, abgeleitet aus Flags, die das Tool an den Dart-Compiler übergibt. Deshalb kann der Compiler einen `if (kDebugMode) { ... }`-Block vollständig per Tree Shaking aus einem Release-Build entfernen:

```dart
// Flutter 3.44.8, packages/flutter/lib/src/foundation/constants.dart (abridged)
const bool kReleaseMode = bool.fromEnvironment('dart.vm.product');
const bool kProfileMode = bool.fromEnvironment('dart.vm.profile');
const bool kDebugMode = !kReleaseMode && !kProfileMode;
```

Einen vierten Modus können Sie nicht hinzufügen. Einen "Staging"-Modus gibt es in Flutter nicht; Staging ist ein Flavor.

## Was ein Flavor tatsächlich ist

Ein Flavor ist eine Variante der nativen App. Flutter hat kein eigenes Konfigurationsformat für Flavors. Wenn Sie `--flavor dev` übergeben, tut das Tool drei Dinge:

1. Unter Android führt es die Gradle-Task `assemble<Flavor><Mode>` aus, zum Beispiel `assembleDevDebug`. Wenn Ihre Gradle-Datei keinen Product Flavor namens `dev` deklariert, schlägt der Build fehl.
2. Unter iOS und macOS baut es das Xcode-Scheme, das nach dem Flavor benannt ist (mit großem Anfangsbuchstaben, `dev` sucht also zuerst nach `Dev`, danach nach einem Treffer ohne Beachtung der Groß- und Kleinschreibung), und verwendet die Build-Konfiguration `<Mode>-<scheme>`, zum Beispiel `Debug-dev` oder `Release-prod`.
3. Auf jeder Plattform fügt es `FLUTTER_APP_FLAVOR=dev` zu den Dart-Defines hinzu, was in Dart als `appFlavor` erscheint.

Alles, was ein Flavor im fertigen Binary ändert, stammt von der nativen Seite: das Suffix der Application ID, der String für den App-Namen, `google-services.json` oder `GoogleService-Info.plist`, Launcher-Icons, die Signing-Konfiguration. Flutter reicht nur den Namen durch.

## Flavors unter Android mit AGP 9 definieren

Hier die Android-Seite der Demo-App. Es ist die Standardvorlage von `flutter create` für Flutter 3.44.8, ergänzt um eine Flavor-Dimension:

```kotlin
// android/app/build.gradle.kts
// Flutter 3.44.8, Android Gradle Plugin 9.0.1, Gradle 9.1.0
android {
    namespace = "com.example.flavordemo"
    compileSdk = flutter.compileSdkVersion

    defaultConfig {
        applicationId = "com.example.flavordemo"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    // AGP 9 turns resValue off by default. Without this block the
    // productFlavors below fail with:
    // "Product Flavor dev contains custom resource values, but the feature is disabled."
    buildFeatures {
        resValues = true
    }

    flavorDimensions += "env"
    productFlavors {
        create("dev") {
            dimension = "env"
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            resValue("string", "app_name", "Demo Dev")
        }
        create("prod") {
            dimension = "env"
            resValue("string", "app_name", "Demo")
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}
```

Der `buildFeatures`-Block ist der Teil, den die meisten älteren Tutorials übersehen. Flavor-Anleitungen aus der Zeit vor AGP 9 nutzen `resValue` für den App-Namen, und in einem frischen Flutter-3.44-Projekt scheitert diese Konfiguration jetzt zur Gradle-Konfigurationszeit mit dem Fehler aus dem Kommentar oben. Verweisen Sie danach im Manifest auf den String, damit jeder Flavor sein eigenes Launcher-Label bekommt:

```xml
<!-- android/app/src/main/AndroidManifest.xml -->
<application
    android:label="@string/app_name"
    android:name="${applicationName}"
    android:icon="@mipmap/ic_launcher">
```

`aapt2 dump badging` auf den entstandenen APKs bestätigt, dass die beiden Achsen wirklich unabhängig sind. Der Modus hat nichts an der Identität geändert, und der Flavor nichts an der Kompilierung:

```text
app-dev-debug.apk     package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-profile.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-dev-release.apk   package: com.example.flavordemo.dev  versionName 0.1.0-dev  label 'Demo Dev'
app-prod-release.apk  package: com.example.flavordemo      versionName 0.1.0      label 'Demo'
```

Weil die `dev`-Varianten eine andere Application ID haben, lassen sie sich parallel zur Produktionsversion auf demselben Telefon installieren. Allein deshalb setzen die meisten Teams Flavors ein.

## Die Fehler, die verraten, welche Achse falsch ist

Sobald eine Gradle-Datei Product Flavors deklariert, funktioniert ein einfaches `flutter build apk` nicht mehr:

```text
# Flutter 3.44.8, no --flavor, productFlavors declared
Running Gradle task 'assembleDebug'...                             14.5s
Gradle build failed to produce an .apk file. It's likely that this file was generated
under .../flavordemo/build, but the tool couldn't find it.
```

Die Meldung führt in die Irre. `assembleDebug` war erfolgreich und hat *jeden* Flavor gebaut (sowohl `app-dev-debug.apk` als auch `app-prod-debug.apk` lagen danach auf der Platte), aber das Tool sucht nach `app-debug.apk`, das nicht mehr existiert. Übergeben Sie `--flavor` oder legen Sie einen Standard fest (siehe unten).

Der umgekehrte Fehler, `--flavor` an ein Projekt ohne Product Flavors zu übergeben, liefert eine deutlich klarere Meldung:

```text
# Flutter 3.44.8, --flavor dev, no productFlavors
[!]  Gradle project does not define a task suitable for the requested build.
The .../android/app/build.gradle.kts file does not define any custom product flavors.
You cannot use the --flavor option.
```

Unter iOS prüft das Tool den Flavor gegen die Xcode-Schemes. `flutter build ios --config-only --no-codesign --flavor dev` im selben Projekt, das noch kein `dev`-Scheme hat, gab Folgendes aus:

```text
The Xcode project defines schemes: FlutterFramework, FlutterGeneratedPluginSwiftPackage, Runner
You must specify a --flavor option to select one of the available schemes.
```

## Beleg: Beide landen als Konstanten im Binary

`appFlavor` ist in `package:flutter/services.dart` deklariert und ist in Flutter 3.47.7 weiterhin ein einfacher Lookup per `String.fromEnvironment`:

```dart
// Flutter 3.47.7, packages/flutter/lib/src/services/flavor.dart
const String? appFlavor = String.fromEnvironment('FLUTTER_APP_FLAVOR') != ''
    ? String.fromEnvironment('FLUTTER_APP_FLAVOR')
    : null;
```

Der Flavor gelangt also genauso nach Dart wie der Modus: als Compile-Zeit-Konstante. Zum Beweis gibt die `main.dart` der Demo beides aus:

```dart
// Flutter 3.44.8, lib/main.dart
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

void main() {
  debugPrint('FLAVORPROBE appFlavor=$appFlavor kDebugMode=$kDebugMode '
      'kProfileMode=$kProfileMode kReleaseMode=$kReleaseMode');
  runApp(const SizedBox());
}
```

Mit `strings` auf dem AOT-Snapshot in jedem APK sieht man dann, dass der Compiler die gesamte Interpolation zu einem einzigen Literal zusammengefasst hat. Es gibt keinen Lookup zur Laufzeit mehr, den man untersuchen könnte:

```text
# strings lib/arm64-v8a/libapp.so | grep FLAVORPROBE
app-dev-release.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=false kReleaseMode=true
app-prod-release.apk:  FLAVORPROBE appFlavor=prod kDebugMode=false kProfileMode=false kReleaseMode=true
app-dev-profile.apk:   FLAVORPROBE appFlavor=dev kDebugMode=false kProfileMode=true kReleaseMode=false
```

Das hat zwei praktische Folgen. Sie können Flavors nicht zur Laufzeit wechseln, denn das Binary enthält nur eine Antwort. Und alles, was Dart ohne die richtigen Defines neu kompiliert, etwa ein Hot Restart über `flutter attach`, bekommt `appFlavor == null`; dieses Problem behandelt [wie Sie appFlavor nach einem Hot Restart befüllt halten](/de/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).

Das Tool schützt außerdem den Namen. Der Versuch, einen Flavor mit einem Define vorzutäuschen, scheitert, bevor der Build startet:

```text
# flutter build apk --dart-define=FLUTTER_APP_FLAVOR=qa
FLUTTER_APP_FLAVOR is used by the framework and cannot be set using --dart-define or --dart-define-from-file
```

## iOS und macOS: Schemes plus Build-Konfigurationen

Auf Apple-Plattformen besteht ein Flavor aus zwei Dingen, die übereinstimmen müssen: einem Scheme, das nach dem Flavor benannt ist, und einem Satz Build-Konfigurationen namens `Debug-<flavor>`, `Profile-<flavor>` und `Release-<flavor>`. Die Matrix aus Modus mal Flavor steht buchstäblich in den Namen der Konfigurationen. Duplizieren Sie in Xcode `Debug`, `Profile` und `Release` für jeden Flavor, legen Sie ein `dev`-Scheme an und setzen Sie dessen Run-Aktion auf `Debug-dev`, Profile auf `Profile-dev` und Archive auf `Release-dev`. Jede Konfiguration kann dann ihren eigenen `PRODUCT_BUNDLE_IDENTIFIER` und Anzeigenamen setzen.

Ein Verhalten, das man in Flutter 3.47.7 kennen sollte: `XcodeProjectInfo.buildConfigurationFor` sucht zuerst nach einem exakten Treffer `Debug-dev`, dann nach einer einzelnen Konfiguration, deren Name sowohl den Modus als auch das Scheme enthält (ohne Beachtung der Groß- und Kleinschreibung), und wenn beides fehlt, **fällt es auf die einfache Konfiguration `Debug` zurück**. Ein Tippfehler wie `Debug-dve` lässt den Build also nicht scheitern; er baut stillschweigend mit Ihrer Basiskonfiguration und dem Bundle Identifier, den diese Konfiguration trägt, meist dem von Produktion. Wenn ein Flavor-Build unter iOS wie prod aussieht, prüfen Sie zuerst die Namen der Konfigurationen.

`flutter run`, `flutter build ios`, `flutter build ipa` und `flutter build macos` akzeptieren `--flavor`. `flutter build web`, `flutter build windows` und `flutter build linux` haben diese Option in 3.44.8 nicht, weil es dort kein natives Variantensystem gibt, an das Flutter weiterreichen könnte.

## Flavor-spezifische Assets und ein Standard-Flavor

Zwei pubspec-Funktionen machen Flavors weniger mühsam. Assets lassen sich auf bestimmte Flavors beschränken, wodurch Dev-Fixtures und Debug-Konfigurationen aus dem Produktions-Bundle herausbleiben:

```yaml
# pubspec.yaml, Flutter 3.44.8
flutter:
  default-flavor: dev
  assets:
    - path: assets/dev/
      flavors:
        - dev
```

In der Demo war `assets/flutter_assets/assets/dev/config.json` in `app-dev-debug.apk` und `app-dev-profile.apk` vorhanden und in `app-prod-debug.apk` und `app-prod-release.apk` nicht. Beachten Sie, dass jedes `rootBundle.loadString('assets/dev/config.json')` in gemeinsamem Code in `prod` nun eine Ausnahme auslöst, derselbe Fehler "Unable to load asset", der in [dem Beitrag zur Fehlersuche bei pubspec-Assets](/de/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/) beschrieben ist.

`default-flavor` verwendet das Tool, wenn `--flavor` fehlt. In `FlutterCommand.getBuildInfo()` ist die Logik ein Einzeiler, `cliFlavor ?? defaultFlavor`, in 3.47.7 unverändert. Mit dieser Einstellung erzeugte ein einfaches `flutter build apk --release` in der Demo `app-dev-release.apk`, statt zu scheitern. Das ist praktisch für `flutter run` während der Entwicklung, aber überlegen Sie es sich gut, bevor Sie `default-flavor: prod` einchecken: Ein CI-Job, der `--flavor` vergisst, liefert dann stillschweigend den Flavor aus, den die Datei nennt.

## Zu welcher Achse gehört eine Einstellung?

So entscheiden Sie schnell, wo ein Stück Konfiguration hingehört:

- **Es hängt davon ab, wie Code kompiliert oder debuggt wird** (ausführliches Logging, `debugPaintSizeEnabled`, abgeschaltetes Crash-Reporting während der Entwicklung, Performance-Overlays): Verwenden Sie den Modus über `kDebugMode` / `kReleaseMode`. Diese Prüfungen werden per Tree Shaking aus Release-Builds entfernt.
- **Es hängt davon ab, welche Umgebung oder welches Produkt Sie ausliefern** (API-Basis-URL, Firebase-Projekt, Bundle ID, App-Name, Icon, Produkt-IDs der Paywall): Verwenden Sie einen Flavor, auf der nativen Seite für alles, was das Betriebssystem liest, und über `appFlavor` für alles, was Dart liest.
- **Es ist ein Wert, keine Identität** (ein Feature Flag, eine Build-Nummer, ein nicht geheimer Schlüssel): `--dart-define` oder `--dart-define-from-file` ist oft einfacher als ein Flavor. Defines sind ebenfalls Compile-Zeit-Konstanten und lassen sich daher mit beiden Achsen kombinieren.
- **Es ist ein Geheimnis**: keines der oben genannten. Flavors, Modi und Defines landen alle als lesbare Strings im Binary, wie die `strings`-Ausgabe oben zeigt.

Der Fehler, den es zu vermeiden gilt, ist das Abbilden von Umgebungen auf Modi, etwa "Debug spricht mit Staging, Release spricht mit Prod". Das funktioniert, bis Sie gegen Produktion profilen, einen Absturz, der nur im Release auftritt, gegen Staging debuggen oder einen Staging-Build über TestFlight an Tester verteilen müssen, wofür ein Release-Build nötig ist. Halten Sie die Achsen getrennt, dann bleibt jede Kombination erreichbar.

Bei Firebase geht das in der Praxis am häufigsten schief. Die `google-services.json`-Dateien pro Flavor liegen in Android-Source-Sets wie `android/app/src/dev/`, und eine Abweichung dort führt zu der Art von Fehler, die nur im Release auftritt, wie in [Firebase-Auth-Anmeldung bleibt im Release-Build nicht erhalten](/de/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/) behandelt. Flavor-Source-Sets beeinflussen außerdem, welche Kotlin-Klassen kompiliert werden, was eine der Ursachen in [ClassNotFoundException für MainActivity](/de/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/) ist, und Ausgabenamen mit Flavor (`app-prod-release.apk`, `app-prodRelease.aab`) sind wichtig, wenn Sie native Bibliotheken für [den Release-Absturz "Could not create Dart VM instance"](/de/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/) prüfen.

## Verwandte Artikel

- [So halten Sie appFlavor nach einem Hot Restart mit flutter attach befüllt](/de/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/)
- [Fix: ClassNotFoundException für MainActivity beim Start einer Flutter-Android-App](/de/2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches/)
- [Fix: Firebase-Auth-Anmeldung bleibt in einem Flutter-Android-Release-Build nicht erhalten](/de/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/)
- [Fix: Could not create Dart VM instance in einem Flutter-Release-Build nach flutter upgrade](/de/2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build/)
- [Fix: Unable to load asset in Flutter nach dem Hinzufügen eines Bildes zur pubspec.yaml](/de/2026/07/fix-unable-to-load-asset-in-flutter-after-adding-an-image-to-pubspec-yaml/)

## Quellen

- [Flutter docs: Flutter's build modes](https://docs.flutter.dev/testing/build-modes)
- [Flutter docs: Set up Flutter flavors for Android](https://docs.flutter.dev/deployment/flavors)
- [Flutter docs: Set up Flutter flavors for iOS and macOS](https://docs.flutter.dev/deployment/flavors-ios)
- [Android developers: Configure build variants](https://developer.android.com/build/build-variants)
- [`flavor.dart` at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/services/flavor.dart)
- [`flutter_command.dart` (`getBuildInfo`, `default-flavor`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/runner/flutter_command.dart)
- [`xcodeproj.dart` (scheme and build configuration matching) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter_tools/lib/src/ios/xcodeproj.dart)
- [`constants.dart` (`kReleaseMode`, `kProfileMode`, `kDebugMode`) at Flutter 3.47.7](https://github.com/flutter/flutter/blob/3.47.7/packages/flutter/lib/src/foundation/constants.dart)
