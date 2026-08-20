---
title: "Fix: Unable to find a destination matching the provided destination specifier in einem Flutter-iOS-Build"
description: "iOS-26-Simulator-Runtimes sind reine arm64-Builds. Eine übrig gebliebene EXCLUDED_ARCHS-arm64-Zeile erzeugt einen Intel-only-Runner, den kein Simulator ausführen kann."
pubDate: 2026-08-20
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "xcode"
  - "cocoapods"
lang: "de"
translationOf: "2026/08/fix-unable-to-find-a-destination-matching-the-provided-destination-specifier-in-a-flutter-ios-build"
translatedBy: "claude"
translationDate: 2026-08-20
---

Löschen Sie die Zeile `EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64` aus Ihrer `ios/Podfile` und führen Sie dann `flutter clean` und ein sauberes `pod install` aus. Diese Zeile stammt aus der Apple-Silicon-Ära von 2020 und ist unter Xcode 26 fatal: iOS-26-Simulator-Runtimes liefern nur arm64 aus, ein Ausschluss von arm64 lässt `Runner` also ohne jede Architektur zurück, die der Simulator ausführen kann. `xcodebuild` meldet das als fehlendes Ziel statt als Architektur-Konflikt. Stammt der Ausschluss aus einem Plugin, das Sie nicht kontrollieren, installieren Sie stattdessen die universelle Runtime mit `xcodebuild -downloadPlatform iOS -architectureVariant universal`.

## Der Fehler im Wortlaut

Flutter reicht den rohen `xcodebuild`-Fehler durch. Er nennt die UDID Ihres Simulators und listet danach Ziele auf, die völlig gültig aussehen:

```
Uncategorized (Xcode): Unable to find a destination matching the provided destination specifier:
                { id:6B4F9D28-C76C-4146-9527-E844395B4434 }

        Available destinations for the "Runner" scheme:
                { platform:macOS, arch:arm64, variant:Designed for [iPad,iPhone], id:00006020-000221002EE8C01E, name:My Mac }
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device }
                { platform:iOS Simulator, id:dvtdevice-DVTiOSDeviceSimulatorPlaceholder-iphonesimulator:placeholder, name:Any iOS Simulator Device }
```

Dasselbe Scheme über die Xcode-Oberfläche auszuführen liefert die Diagnose, die Flutters Ausgabe vergräbt:

```
iPhone 17 cannot run Runner.
Domain: IDEFoundationErrorDomain
Code: 3
Recovery Suggestion: Runner's architectures (Intel 64-bit) include none that iPhone 17 can execute (arm64).
```

Diese zweite Meldung ist der eigentliche Fehler. Der Simulator existiert, er läuft, und seine UDID stimmt. Was fehlt, ist eine gemeinsame Architektur zwischen dem gerade kompilierten Produkt und dem Gerät, auf dem es laufen soll.

## Warum ein iOS-26-Simulator kein passendes Ziel hat

`xcodebuild -destination` löst nicht zu "einem Gerät mit dieser UDID" auf, sondern zu "einem Gerät mit dieser UDID, das das Produkt dieses Schemes ausführen kann". Die Architektur gehört zum Abgleich, deshalb erscheint ein Architektur-Konflikt als fehlendes Ziel.

Vor iOS 26 spielte diese Unterscheidung selten eine Rolle. Simulator-Runtimes kamen als Universal Binaries mit einem `x86_64`- und einem `arm64`-Slice, ein Intel-only-Build fand also weiterhin einen Slice, der unter Rosetta auf Apple Silicon lief. Xcode 26 hat das beendet. Bei der Installation einer Runtime löst Apple die Architekturvariante auf Apple Silicon zu `arm64` auf und lädt nur diesen Slice, mit der Ausgabe `Automatically resolved architecture variant for platform iOS as 'arm64'`.

Ein iOS-26-Simulator kann also genau eine Architektur ausführen, und jede Build-Einstellung, die `arm64` aus dem Simulator-Build entfernt, erzeugt ein Produkt ohne verwendbaren Slice.

Diese Einstellung stammt fast immer aus einer Podfile. 2020 empfahl jede Apple-Silicon-Anleitung einen arm64-Ausschluss, damit Intel-only-Pods linkten, und dieser Rat wurde in tausende Projekte kopiert. Flutters eigener CocoaPods-Helper erhält ihn: `packages/flutter_tools/bin/podhelper.rb` schreibt den Simulator-Ausschluss mit vorangestelltem `$(inherited)`, wodurch Ihr projektweiter Wert erhalten bleibt statt ersetzt zu werden.

```ruby
# Flutter 3.44.2, packages/flutter_tools/bin/podhelper.rb
build_configuration.build_settings['VALID_ARCHS[sdk=iphonesimulator*]'] = '$(ARCHS_STANDARD)'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = '$(inherited) i386'
build_configuration.build_settings['EXCLUDED_ARCHS[sdk=iphoneos*]'] = '$(inherited) armv7'
```

Der Standardausschluss ist allein `i386` und damit harmlos. Tödlich ist das geerbte `arm64`.

Es gibt eine zweite Quelle. Schließt irgendein Pod-Target `arm64` aus, gibt Flutter den Ausschluss an die App selbst weiter. `packages/flutter_tools/lib/src/ios/xcode_build_settings.dart` entscheidet das beim Erzeugen von `Generated.xcconfig`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/xcode_build_settings.dart
var excludedSimulatorArchs = 'i386';
if (!(await project.ios.pluginsSupportArmSimulator(printWarnings: printWarnings))) {
  excludedSimulatorArchs += ' arm64';
}
xcodeBuildSettings.add(
  'EXCLUDED_ARCHS[sdk=${XcodeSdk.IPhoneSimulator.platformName}*]=$excludedSimulatorArchs',
);
```

`pluginsSupportArmSimulator` führt `xcodebuild -showBuildSettings` über `Pods/Pods.xcodeproj` aus und liefert false, sobald das `EXCLUDED_ARCHS` irgendeines Targets `arm64` nennt. Eine einzige schlecht konfigurierte transitive Abhängigkeit genügt, um die gesamte App auf Intel-only zu zwingen.

## Minimale Reproduktion: die Podfile-Zeile, die den Simulator-Build zerlegt

Fügen Sie den klassischen Workaround in eine unveränderte Flutter-App ein und starten Sie sie auf einem iOS-26-Simulator:

```ruby
# ios/Podfile, Flutter 3.44.2, CocoaPods 1.16.2, Xcode 26.0.1
post_install do |installer|
  installer.pods_project.build_configurations.each do |config|
    config.build_settings['EXCLUDED_ARCHS[sdk=iphonesimulator*]'] = 'arm64'
  end
end
```

```bash
# Flutter 3.44.2 (stable, 11 June 2026), Dart 3.12.2
flutter run -d 6B4F9D28-C76C-4146-9527-E844395B4434
```

Flutter baut das `-destination`-Argument aus dem gewählten Gerät, in `packages/flutter_tools/lib/src/ios/mac.dart`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/ios/mac.dart
buildCommands.add('-destination');
if (deviceID != null) {
  buildCommands.add('id=$deviceID');
} else if (environmentType == EnvironmentType.physical) {
  buildCommands.add(XcodeSdk.IPhoneOS.genericPlatform);
} else {
  buildCommands.add(XcodeSdk.IPhoneSimulator.genericPlatform);
}
```

`genericPlatform` expandiert zu `generic/platform=iOS Simulator`. Beide Formen scheitern gleich, sobald das Produkt Intel-only ist. Deshalb reproduziert `flutter build ios --simulator` den Fehler auch ganz ohne gewähltes Gerät.

## Wie entferne ich den arm64-Ausschluss?

Arbeiten Sie von Ihrem eigenen Projekt nach außen zu den Abhängigkeiten.

Erstens: Löschen Sie den Ausschluss aus `ios/Podfile`. Entfernen Sie die gesamte Zuweisung von `EXCLUDED_ARCHS[sdk=iphonesimulator*]`, statt sie auf einen leeren String zu setzen, damit Flutters eigener `i386`-Standard sauber greift.

Zweitens: Prüfen Sie das Xcode-Projekt selbst, denn dieselbe Zeile landet oft in den Build Settings statt in der Podfile:

```bash
# Xcode 26.0.1
cd ios
xcodebuild -showBuildSettings -project Runner.xcodeproj -scheme Runner \
  -sdk iphonesimulator | grep -i EXCLUDED_ARCHS
```

Alles, was `arm64` im Simulator-SDK nennt, muss weg. Leeren Sie es in Xcode unter Build Settings, Excluded Architectures, für Debug und Release.

Drittens: Bauen Sie die Pods von Grund auf neu. Veraltete `Pods` und `DerivedData` halten die alten Einstellungen am Leben und lassen es so aussehen, als hätte die Korrektur nichts bewirkt:

```bash
# Flutter 3.44.2, CocoaPods 1.16.2
flutter clean
rm -rf ios/Pods ios/Podfile.lock ~/Library/Developer/Xcode/DerivedData
flutter pub get
cd ios && pod install
```

Viertens: Prüfen Sie, dass der Ausschluss aus der von Flutter erzeugten Datei verschwunden ist. `ios/Flutter/Generated.xcconfig` sollte `EXCLUDED_ARCHS[sdk=iphonesimulator*]=i386` ohne `arm64` zeigen. Überlebt `arm64` ein sauberes `pod install`, ist eine Abhängigkeit die Quelle, nicht Sie.

## Was tun, wenn ein Plugin arm64 weiterhin ausschließt?

Unter Xcode 26 und neuer nennen Flutter 3.41.0 (11. Februar 2026) und neuere Versionen die schuldigen Targets während des Builds, aus `packages/flutter_tools/lib/src/xcode_project.dart`:

```
The following target(s) do not support arm64 architecture, which is a requirement for Apple Silicon iOS 26+ simulators:
  - SomePlugin (Flutter plugin)
  - SomeVendorSDK (transitive dependency of Flutter plugin SomePlugin)

Please contact plugin maintainers to request arm64 support to continue to be able to use the plugin on a simulator.
```

Diese Warnung kam mit [PR #177065](https://github.com/flutter/flutter/pull/177065), gemergt am 5. November 2025. Ein Vergleich des Merge-Commits mit den Release-Tags legt sie außerhalb von 3.38.10 und innerhalb von 3.41.0, wer also noch auf der 3.38-Linie sitzt, bekommt den Fehler ohne jede Erklärung.

Ist das Target ein Binary-Framework eines Anbieters ohne arm64-Simulator-Slice, lässt sich der Ausschluss nicht entfernen. Installieren Sie stattdessen eine universelle Runtime, damit ein Intel-only-Produkt weiterhin etwas zum Laufen hat:

```bash
# Xcode 26.0.1
xcrun simctl delete unavailable
xcodebuild -downloadPlatform iOS -architectureVariant universal
```

Löschen Sie zuerst die vorhandene arm64-only-Runtime für iOS 26 über Xcodes Bereich Settings, Components. Sonst löst der Download auf die bereits vorhandene Runtime auf und endet, ohne die universelle Variante zu holen. Danach prüfen:

```bash
# Xcode 26.0.1
xcrun simctl list runtimes --json | grep -i x86_64
```

Das ist der Workaround, den Flutter selbst empfiehlt. Seit 3.41.4 (4. März 2026) gibt das Tool den Hinweis nach einem fehlgeschlagenen Simulator-Build aus, abhängig von Xcode 26 oder neuer und davon, dass der gewählten Runtime tatsächlich der `x86_64`-Slice fehlt:

```
The selected simulator is incompatible with the current build settings.
Please use a simulator that supports x86_64, such as a simulator prior to iOS 26 or download the universal variant of the iOS 26 simulator using "xcodebuild -downloadPlatform iOS -architectureVariant universal".
```

Behandeln Sie das als Notlösung. Eine universelle Runtime ist ein größerer Download, sie führt Ihre App unter Rosetta aus, und sie hilft dem nächsten Teammitglied nicht, das die Runtime auf dem Standardweg installiert. Den Ausschluss zu entfernen ist die dauerhafte Lösung.

## Was tun, wenn der Fehler meldet, die Plattform sei nicht installiert?

Ein anderer Fehlermodus druckt dieselbe Überschrift mit einem `Ineligible destinations`-Block darunter:

```
Unable to find a destination matching the provided destination specifier:
                { id:1234D567-890C-1DA2-34E5-F6789A0123C4 }

        Ineligible destinations for the "Runner" scheme:
                { platform:iOS, id:dvtdevice-DVTiPhonePlaceholder-iphoneos:placeholder, name:Any iOS Device, error:iOS 17.0 is not installed. To use with Xcode, first download and install the platform }
```

Das ist kein Architekturproblem. Ihr Deployment Target oder Ihr Scheme verweist auf eine Runtime, die nicht auf der Maschine liegt. Das passiert häufig direkt nach einem Xcode-Upgrade, weil Xcode 26 ältere Runtimes nicht übernimmt. Flutter liest die Formulierung `is not installed` aus dieser Meldung und druckt eine Installationsanleitung, die auf Xcodes Components-Bereich zeigt. Installieren Sie die fehlende Runtime, oder heben Sie das Deployment Target auf eine vorhandene Version an.

## Was tun, wenn das Ziel eine veraltete Simulator-UDID ist?

Existiert die UDID aus dem Fehler nicht mehr, ergänzt `xcodebuild` eine eigene Zeile:

```
The requested device could not be found because no available devices matched the request.
```

Flutter nimmt genau diesen Fall aus seiner Architektur-Diagnose aus. Dieser Satz bedeutet also, dass Sie einem Phantomgerät hinterherjagen und nicht einem Architektur-Konflikt. Meist folgt er auf ein iOS- oder Xcode-Update, das die Simulator-Liste neu erzeugt hat, während eine IDE-Konfiguration, eine `launch.json` oder ein Shell-Alias weiter die alte Kennung festhielt:

```bash
# Xcode 26.0.1, Flutter 3.44.2
xcrun simctl list devices available
xcrun simctl delete unavailable
flutter devices
```

Übergeben Sie danach eine UDID, die `flutter devices` tatsächlich meldet, oder lassen Sie `-d` weg und überlassen Flutter die Wahl.

## Was bricht das in der CI, wenn es lokal funktioniert?

Auf einem Build-Server bedeutet dieselbe Meldung meist, dass die iOS-Plattform überhaupt nicht installiert ist. In [Issue #163011](https://github.com/flutter/flutter/issues/163011) enthielt die Zielliste nur macOS-Einträge, und so sieht ein macOS-Image mit unvollständigem Xcode-Komponentensatz aus. `flutter build ipa` übergibt `generic/platform=iOS`, und ohne vorhandene iOS-Plattform gibt es nichts zum Abgleichen.

Prüfen Sie das Image, bevor Sie das Projekt verdächtigen:

```bash
# Xcode 26.0.1 on a CI runner
xcodebuild -showsdks
xcrun simctl list runtimes
```

Fehlt iOS, fügen Sie `xcodebuild -downloadPlatform iOS` als Pre-Build-Schritt hinzu und pinnen Sie die Xcode-Version, damit eine Image-Aktualisierung die Antwort nicht stillschweigend ändert. Es ist dieselbe Disziplin, die [eine CI-Pipeline gegen mehrere Flutter-Versionen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) berechenbar hält.

## Fallstricke und ähnlich aussehende Varianten

`ONLY_ACTIVE_ARCH` ist kein Ersatz. Flutter übergibt `ONLY_ACTIVE_ARCH` und `ARCHS` bereits explizit, wenn es die aktive Architektur kennt, und ein manuelles Setzen bringt keinen Slice zurück, den `EXCLUDED_ARCHS` entfernt hat.

Achten Sie auch auf die alte Form `VALID_ARCHS[sdk=iphonesimulator*] = x86_64`. Sie ist älter als `EXCLUDED_ARCHS` und erzeugt ein identisches Intel-only-Produkt. Flutters podhelper setzt sie für Pod-Targets auf `$(ARCHS_STANDARD)` zurück, für Ihr App-Target jedoch nicht.

Ein Build für ein physisches Gerät, der mit derselben Zeichenkette scheitert, ist ein anderes Problem. Dort lautet das Ziel `generic/platform=iOS`, und die übliche Ursache ist die Codesignatur, näher an [einem Provisioning Profile, das das gewählte Gerät nicht enthält](/de/2026/05/fix-provisioning-profile-doesnt-include-currently-selected-device-maui-ios/).

Kommt der Build schließlich an der Zielprüfung vorbei und stirbt erst beim Start, sind Sie ganz woanders. Ein Debug-Build, der startet und sofort in der Dart VM abstürzt, ist [der mprotect-permission-denied-Fehler](/de/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/), und ein Build, der gar nicht erst linkt, ist eher [ein CocoaPods-Konflikt bei der Versionsauflösung](/de/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).

## Welche Flutter-Version die echte Ursache meldet

Die zugrunde liegende Inkompatibilität ist Apples, ein Flutter-Upgrade bringt ein Intel-only-Produkt also nicht auf einer reinen arm64-Runtime zum Laufen. Das Upgrade kauft Ihnen eine Diagnose statt eines Rätsels. Flutter 3.41.0 ergänzt die Warnung, die jedes arm64 ausschließende Target benennt, 3.41.4 ergänzt den Hinweis auf die universelle Runtime nach dem Fehlschlag. Beides steckt in der aktuellen Stable-Version 3.47.1, veröffentlicht am 19. August 2026.

Wenn Sie auf 3.38 oder älter sitzen und nicht aktualisieren können, führen Sie den `-showBuildSettings`-Grep von oben von Hand aus. Genau diese Prüfung übernimmt Flutter inzwischen für Sie. Für einen breiteren Durchgang durch iOS-Build-Fehler nach einem Xcode-Upgrade gilt weiterhin die Triage-Reihenfolge aus [der Anleitung zum Xcode-16-Build-Fehler](/de/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).

## Verwandt

- [Fix: mprotect failed: 13 (Permission denied) in einem Flutter-Debug-Build für iOS](/de/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)
- [Fix: CocoaPods could not find compatible versions for pod in einem Flutter-iOS-Build](/de/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/)
- [Fix: Failed to build iOS app mit Xcode 16 und Flutter 3.x](/de/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [Flutter 3.44 macht Swift Package Manager zum Standard](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/)
- [Mehrere Flutter-Versionen aus einer CI-Pipeline ansteuern](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)

## Quellen

- [flutter/flutter Issue #176188, flutter run funktioniert nicht auf dem iOS-26-Simulator](https://github.com/flutter/flutter/issues/176188)
- [flutter/flutter PR #177065, Entfernen des arm64-Ausschlusses für Xcode-26-Simulatoren](https://github.com/flutter/flutter/pull/177065)
- [flutter/flutter Issue #163011, destination-specifier-Fehler mit generischer iOS-Plattform](https://github.com/flutter/flutter/issues/163011)
- [Apple Developer Forums, Installation von iOS-26-Simulator-Runtimes und Architekturvarianten](https://developer.apple.com/forums/thread/801106)
- [Apple, Herunterladen und Installieren zusätzlicher Xcode-Komponenten](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components)
- [Apple, Installieren zusätzlicher Simulator-Runtimes](https://developer.apple.com/documentation/xcode/installing-additional-simulator-runtimes)
