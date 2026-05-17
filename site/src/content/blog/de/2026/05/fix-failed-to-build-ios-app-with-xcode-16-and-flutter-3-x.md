---
title: "Fix: Failed to build iOS app mit Xcode 16 und Flutter 3.x"
description: "Der Fix in 60 Sekunden: Aktualisieren Sie Flutter auf 3.24.4 oder höher, heben Sie die Podfile-Plattform auf iOS 13 an, löschen Sie Pods und DerivedData, dann pod install. Der Fehler steckt selten in Ihrem Dart-Code."
pubDate: 2026-05-17
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
lang: "de"
translationOf: "2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x"
translatedBy: "claude"
translationDate: 2026-05-17
---

Der Fix in einem Satz: `Failed to build iOS app` nach dem Upgrade auf Xcode 16 ist fast nie Ihr Dart-Code. Es ist eine von vier Ursachen, in dieser Reihenfolge der Häufigkeit: ein Flutter-SDK älter als 3.24.4, das den neuen Modul-Verifier von Xcode 16 nicht kennt, ein `Podfile`, das noch `platform :ios, '11.0'` fixiert (Xcode 16 hat die Unterstützung für den iOS-11-Simulator entfernt), ein veralteter Cache aus `ios/Pods` und `~/Library/Developer/Xcode/DerivedData/ModuleCache.noindex` vom vorherigen Xcode, oder ein Plugin, das noch kein mit Swift 6 / Xcode 16 kompatibles Release veröffentlicht hat. Aktualisieren Sie Flutter, heben Sie das Podfile auf iOS 13 an, löschen Sie beide Caches, führen Sie `pod install` aus, kompilieren Sie neu. Greifen Sie nicht mehr als ersten Schritt zu `flutter clean`; es berührt die iOS-Caches, die tatsächlich kaputt sind, nicht.

```text
Launching lib/main.dart on iPhone 16 Pro in debug mode...
Running Xcode build...
Xcode build done.                                           38.4s
Failed to build iOS app
Error (Xcode): Swift Compiler Error (Xcode): No such module 'Flutter'
/Users/me/MyApp/ios/Runner/AppDelegate.swift:2:8

Could not build the application for the simulator.
Error launching application on iPhone 16 Pro.
```

Dieser Leitfaden wurde gegen Flutter 3.41.5 (Stable-Kanal, Mai 2026), die Xcode 16.x-Linie (16.0 bis 16.4 zum Zeitpunkt des Schreibens), CocoaPods 1.16.2 und macOS Sequoia 15.3 auf Apple Silicon geschrieben. Die gleichen Fixes gelten für Flutter 3.24.4 und höher; wenn Sie auf Flutter 3.19 oder älter sind, lesen Sie zuerst den Upgrade-Schritt, denn keine Menge an Pod-Fummelei wird Sie auf diesem Branch retten. Die relevanten Flutter-Änderungen, die Xcode 16 sauber zum Laufen brachten, landeten in [flutter/flutter#155438](https://github.com/flutter/flutter/issues/155438), und die folgenden modulemap-Fixes in [flutter/flutter#157461](https://github.com/flutter/flutter/issues/157461).

## Was `Failed to build iOS app` Ihnen tatsächlich sagt

`Failed to build iOS app` ist die Dachmeldung des Flutter-Tools. Sie bedeutet nur "xcodebuild hat einen Exit-Code ungleich null zurückgegeben". Die eigentliche Diagnose ist die Zeile direkt darüber oder darunter, mit `Error (Xcode):` als Präfix. Es gibt etwa sechs verschiedene zugrunde liegende Fehler, die alle unter demselben Dach erscheinen:

1. `No such module 'Flutter'` -- der Swift-Compiler findet das Flutter-Framework-Modul nicht. Fast immer ein Podfile- oder pod-install-Problem nach dem Xcode-16-Upgrade.
2. `no such file or directory: '.../ModuleCache.noindex/Session.modulevalidation'` -- der neue Modul-Verifier von Xcode 16 kann eine von Xcode 15 geschriebene Cache-Datei nicht lesen. Siehe [Issue #157461](https://github.com/flutter/flutter/issues/157461).
3. `Using bridging headers with module interfaces is unsupported` -- ein Muster aus `module.modulemap` plus Bridging Header eines Plugins, das in Xcode 15 funktionierte, ist jetzt ein harter Fehler.
4. `type 'UIApplication' does not conform to protocol 'Launcher'` -- ein strikter Konformitätsfehler von Swift 6 in einem veralteten Plugin (häufig `url_launcher_ios` vor 6.3.0).
5. `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56` -- Swift-Runtime-ABI-Inkompatibilität, fast immer ein CocoaPods-Cache von einem vorherigen Xcode-SDK.
6. `The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0, but the range of supported deployment target versions is 12.0 to 18.4` -- Ihr `Podfile` fixiert immer noch iOS 11, das Xcode 16 entfernt hat.

Jeder dieser Fehler ist ein anderer Bug mit einer anderen Wurzelursache. Die erste Aufgabe ist, zu identifizieren, welcher davon das Tool tatsächlich getroffen hat. Scrollen Sie im Terminal nach oben, bis Sie die `error:`-Zeile finden, die einen Dateipfad und eine Zeilennummer hat. Das ist die Wahrheit; `Failed to build iOS app` ist das Symptom.

## Den tatsächlichen Fehler aus `flutter build` lesen

Führen Sie mit ausführlichem Logging aus, damit die zugrunde liegende `xcodebuild`-Ausgabe nicht zusammengefasst wird:

```bash
# Flutter 3.41.5
flutter build ios --verbose 2>&1 | tee build.log
```

Suchen Sie dann im Log nach dem ersten `error:` (Kleinbuchstaben, das ist das Xcode-Präfix), nicht nach `Error (Xcode)` (das ist Flutters Umformatierung):

```bash
grep -n "error:" build.log | head -20
```

Der erste Treffer ist der, den Sie beheben müssen. Nachfolgende Fehler sind in der Regel Kaskaden des ersten. Wenn Sie die ausführliche Ausgabe nicht haben, raten Sie.

## Eine minimale Reproduktion, die eine der häufigen Formen demonstriert

Die häufigste Form 2026 ist die Kombination aus dem Plattform-Pin im `Podfile` und einem veralteten `Pods`-Verzeichnis. Erstellen Sie ein frisches Flutter-Projekt und fixieren Sie das iOS-Deployment-Target auf 11.0:

```ruby
# ios/Podfile, Flutter 3.41.5, CocoaPods 1.16.2
platform :ios, '11.0'

# CocoaPods analytics sends network stats synchronously affecting flutter build latency.
ENV['COCOAPODS_DISABLE_STATS'] = 'true'

project 'Runner', {
  'Debug' => :debug,
  'Profile' => :release,
  'Release' => :release,
}

# ... rest of the default Podfile ...
```

Führen Sie `flutter build ios --no-codesign` unter Xcode 16 aus, und die Kompilierung schlägt fehl mit:

```text
[!] Automatically assigning platform `iOS` with version `11.0` on target `Runner`
    because no platform was specified. Please specify a platform for this target
    in your Podfile.
...
error: The iOS deployment target 'IPHONEOS_DEPLOYMENT_TARGET' is set to 11.0,
       but the range of supported deployment target versions is 12.0 to 18.4.
       (in target 'firebase_core' from project 'Pods')
Failed to build iOS app
```

Dasselbe Podfile unter Xcode 15.4 kompiliert klaglos. Der Bug ist die neue Deployment-Target-Untergrenze in Xcode 16, nicht Ihr Code.

## Fix, in Reihenfolge der Häufigkeit als Antwort

Wenden Sie diese Schritte der Reihe nach an. Jeder Schritt setzt voraus, dass der vorherige nicht funktioniert hat.

### 1. Aktualisieren Sie Flutter auf 3.24.4 oder höher

Flutter 3.24.4 (Oktober 2024) ist das erste stabile Release, das die Xcode-16-Fixes für `xcode_backend.sh` und die Generated.xcconfig-Vorlage enthält. Jedes Release der 3.41.x-Linie in 2026 ist aktuell. Prüfen Sie, was Sie haben, und aktualisieren Sie:

```bash
flutter --version
flutter upgrade
```

Wenn `flutter upgrade` sich weigert, weil Ihr Kanal auf `master` ist oder Sie lokale Engine-Modifikationen haben, wechseln Sie zurück auf `stable`:

```bash
flutter channel stable
flutter upgrade
```

Dieser einzelne Schritt löst die Mehrheit der `No such module 'Flutter'`-Meldungen, die 2024 und 2025 gegen Xcode 16 eingereicht wurden. Das Flutter-Team hat [Issue #155438](https://github.com/flutter/flutter/issues/155438) genau aus diesem Grund als in 3.24.4 behoben geschlossen.

### 2. Heben Sie die Podfile-Plattform auf iOS 13 an

Xcode 16 unterstützt iOS 12 als Deployment-Target noch immer, aber die meisten modernen Plugins (Firebase, Google Maps, alles, was SwiftUI berührt) erfordern jetzt iOS 13. iOS 13 als Untergrenze festzulegen ist der sichere Standard in 2026:

```ruby
# ios/Podfile, Flutter 3.41.5
platform :ios, '13.0'
```

Sie müssen das auch im Runner-Projekt spiegeln. Öffnen Sie `ios/Runner.xcworkspace`, wählen Sie das `Runner`-Target, gehen Sie zu `Build Settings` und setzen Sie `iOS Deployment Target` auf `13.0` für Debug und Release. Die Build Settings des Workspace gewinnen für das Runner-Target gegenüber dem `Podfile`; die `Podfile`-Zeile wirkt sich nur auf die Pod-Targets aus.

Wenn Sie einen `post_install`-Block im Podfile haben, zwingen Sie jeden Pod, dasselbe Minimum zu erben (das ist der Snippet aus der modernen Flutter-Vorlage):

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
    end
  end
end
```

### 3. Löschen Sie Pods, das Lockfile und den Modul-Cache

Das ist der Schritt, der den `ModuleCache.noindex`-Fehler und die meisten `Undefined symbol: _swift_FORCE_LOAD$_swiftCompatibility56`-Meldungen behebt. Der Swift-ABI-Cache Ihres vorherigen Xcode ist mit dem `swiftc` von Xcode 16 inkompatibel, und `flutter clean` rührt ihn nicht an. Aus dem Projektstammverzeichnis:

```bash
# Flutter 3.41.5, CocoaPods 1.16.2
flutter clean
cd ios
rm -rf Pods Podfile.lock .symlinks
rm -rf ~/Library/Developer/Xcode/DerivedData
pod cache clean --all
pod install --repo-update
cd ..
flutter pub get
```

`pod install --repo-update` (Achtung: nicht `pod install` allein) aktualisiert das CocoaPods-Specs-Repository, damit Sie alle Plugin-Podspecs erhalten, die seit Ihrem letzten Build veröffentlicht wurden. Überspringen Sie das, und Sie installieren die gestrige `firebase_core.podspec`, die noch immer iOS 11 fixiert.

### 4. Aktualisieren Sie Plugins, besonders die im Fehler genannten

Wenn der Fehler `type 'UIApplication' does not conform to protocol 'Launcher'` lautet, ist das Plugin veraltet. Die zwei häufigsten Übeltäter sind `url_launcher_ios` und `webview_flutter_wkwebview`. Heben Sie auf die neueste Minor-Version:

```bash
flutter pub upgrade --major-versions
```

Wenn Sie kein Pauschal-Upgrade machen können, weil eine Abhängigkeit fixiert ist, aktualisieren Sie nur das im Fehler genannte Plugin:

```bash
flutter pub upgrade --major-versions url_launcher_ios
```

Wiederholen Sie dann Schritt 3 (Pods werden nach Version gecacht; eine Änderung an `pubspec.yaml` führt `pod install` nicht automatisch erneut aus). Für einen tieferen Leitfaden zum Lesen der Beschwerden des `pubspec`-Resolvers, falls `pub upgrade` selbst fehlschlägt, siehe [warum "Version solving failed" ein Beweis und kein Bug ist](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

### 5. Erzwingen Sie eine einzige Swift-Version über alle Pods

Eine Teilmenge der Build-Fehler kommt von Pods, die keine `SWIFT_VERSION` deklariert haben, was unter Xcode 16 standardmäßig auf den strikten Modus von Swift 6 fällt und dann an völlig legalem Swift-5-Code explodiert. Der Fix ist, jeden Pod im selben `post_install`-Block auf Swift 5 zu fixieren:

```ruby
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '13.0'
      config.build_settings['SWIFT_VERSION'] = '5.0'
    end
  end
end
```

Das ist ein Workaround, kein Fix. Die korrekte langfristige Lösung ist, ein Issue gegen das Plugin zu eröffnen, damit es seine eigene Swift-Version deklariert, aber die Fixierung wird Sie heute entsperren.

### 6. Löschen und regenerieren Sie die `ios/Runner.xcodeproj`-Einstellungen nur als letzten Ausweg

Wenn Sie die `project.pbxproj` von Hand bearbeitet haben (native Targets hinzugefügt, benutzerdefinierte Build-Phasen, App-Clip-Erweiterungen) und nichts davon funktioniert hat, kann das Runner-Target veraltete Build Settings vor Xcode 16 haben. Sichern Sie `ios/Runner.xcodeproj` und vergleichen Sie es dann mit einem frisch generierten:

```bash
# Flutter 3.41.5
flutter create --platforms=ios --project-name=runner /tmp/scratch
diff -r ios/Runner.xcodeproj /tmp/scratch/ios/Runner.xcodeproj
```

Übertragen Sie die relevanten Build Settings (`IPHONEOS_DEPLOYMENT_TARGET`, `SWIFT_VERSION`, `ENABLE_USER_SCRIPT_SANDBOXING`, `STRING_CATALOG_GENERATE_SYMBOLS`) vom Scratch-Projekt in Ihres, eine nach der anderen, und kompilieren Sie zwischen jeder neu. Das ist mühsam, aber auch der einzig verlässliche Weg, ein Projekt zu retten, das fünf Jahre Xcode-Upgrade-Geröll angesammelt hat.

## Fallstricke und Ähnlichkeiten

Einige Fälle, die wie dieser Fehler aussehen, es aber nicht sind:

- **`Sandbox: rsync deny file-write-create`**: Xcode 16 hat `ENABLE_USER_SCRIPT_SANDBOXING=YES` standardmäßig für neue Projekte aktiviert. Flutters `xcode_backend.sh` schreibt außerhalb der Sandbox. Setzen Sie `ENABLE_USER_SCRIPT_SANDBOXING=NO` in den Build Settings des Runner-Targets. Die Installer-Vorlage von Flutter seit 3.24.4 setzt das, aber vorher erstellte Projekte nicht.
- **`Provisioning profile doesn't include the currently selected device`**: überhaupt kein Flutter-Build-Fehler. Das native Binary wurde sauber gebaut; der Installationsschritt schlug fehl. Siehe [Provisioning profile doesn't include the currently selected device](/de/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/) -- der MAUI-Artikel deckt dieselbe Wurzelursache auf Apple-Seite ab.
- **`Unable to find a valid iOS Simulator runtime`**: Xcode 15 hat aufgehört, Simulator-Runtimes zu bündeln; Xcode 16 bündelt sie immer noch nicht. Führen Sie `xcodebuild -downloadPlatform iOS` aus. Der detaillierte Artikel ist unter [Unable to find a valid iOS Simulator runtime during MAUI build](/de/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/) und gilt identisch für Flutter.
- **`Xcode 26 update -- Clang dependency scanning failure: module 'Flutter' not found`**: das ist die Xcode-26-Variante (Developer Preview), die in [flutter/flutter#185210](https://github.com/flutter/flutter/issues/185210) verfolgt wird. Versenden Sie noch keine Release-Builds gegen Xcode 26; bleiben Sie auf der 16.x-Linie, bis Flutter eine Kompatibilitätsnotiz veröffentlicht.
- **CI scheitert, aber lokale Builds gelingen**: Ihr CI ist auf einem älteren Xcode-Image. Das `macos-14`-Image von GitHub Actions enthält Xcode 15.4; Sie brauchen `macos-15` (oder explizit `macos-15-large`) für Xcode 16. Pinnen Sie das Runner-Image und wählen Sie die Xcode-Version mit `sudo xcode-select -s /Applications/Xcode_16.app` aus. Wenn Sie auch mehrere Flutter-Versionen im CI jonglieren, zeigt das [Matrix-Muster für Flutter auf subosito/flutter-action](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), wie Sie den Build über Versionen hinweg grün halten.
- **`No such module 'Flutter'` nur in einem watchOS-Target oder App Clip**: das Flutter-Framework wird standardmäßig nicht in Begleit-Targets eingebettet. Sie müssen eine Run-Script-Phase hinzufügen, die `Flutter.framework` in die eingebetteten Binaries kopiert, oder die [add-to-app](https://docs.flutter.dev/add-to-app/ios/project-setup)-Projekteinrichtung verwenden. Das ist in [flutter/flutter#164597](https://github.com/flutter/flutter/issues/164597) für den Apple-Watch-Fall dokumentiert.
- **`flutter clean` hat die `ios/Flutter/Generated.xcconfig` gelöscht und jetzt baut nichts mehr**: das ist erwartet. Führen Sie `flutter pub get` aus, um sie zu regenerieren. Wenn `flutter pub get` erfolgreich ist, aber die Datei nicht regeneriert wird, deklariert Ihre `pubspec.yaml` iOS nicht als Plattform; fügen Sie `flutter:` `plugin:` `platforms:` `ios:` hinzu oder führen Sie `flutter create --platforms=ios .` aus.

Wenn Sie die Schritte 1 bis 5 zweimal durchgegangen sind und immer noch denselben Fehler sehen, ist der nächste Schritt, Plugins zu bisektieren. Kommentieren Sie jede direkte Abhängigkeit in `pubspec.yaml` außer `flutter` und `cupertino_icons` aus, führen Sie den Lösch-und-Build-Zyklus aus und bestätigen Sie, dass das leere Projekt baut. Dann auskommentieren Sie Abhängigkeiten in Dreiergruppen. Die erste Gruppe, die den Fehler wieder einführt, enthält das schuldige Plugin. Das ist langsam, aber deterministisch und liefert Ihnen einen einreichbereiten Bug-Report.

## Verwandt

- [Fix: Version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Fix: Provisioning profile doesn't include the currently selected device (MAUI iOS)](/de/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/)
- [Fix: Unable to find a valid iOS Simulator runtime during MAUI build](/de/2026/05/fix-unable-to-find-a-valid-ios-simulator-runtime-during-maui-build/)
- [Wie man mehrere Flutter-Versionen aus einer CI-Pipeline ansteuert](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Flutter iOS von Windows aus debuggen: ein Workflow mit echtem Gerät](/de/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/)

## Quellen

- [flutter/flutter#155438: After updating to xCode 16, Failed to build iOS app in Flutter 3.19.5](https://github.com/flutter/flutter/issues/155438)
- [flutter/flutter#157461: Xcode 16 and iOS 18 project not compiling: ModuleCache.noindex error](https://github.com/flutter/flutter/issues/157461)
- [flutter/flutter#155873: No such module 'Flutter' after updating to Xcode 16](https://github.com/flutter/flutter/issues/155873)
- [flutter/flutter#164597: Flutter 3.29.0 + Xcode 16 build failure with Apple Watch target](https://github.com/flutter/flutter/issues/164597)
- [flutter/flutter#185210: Xcode 26 update -- Clang dependency scanning failure](https://github.com/flutter/flutter/issues/185210)
- [Flutter add-to-app iOS project setup](https://docs.flutter.dev/add-to-app/ios/project-setup) (docs.flutter.dev)
- [CocoaPods 1.16.x changelog](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
