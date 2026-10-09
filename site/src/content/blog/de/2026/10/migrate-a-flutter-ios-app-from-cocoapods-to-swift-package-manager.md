---
title: "Eine Flutter-iOS-App von CocoaPods auf Swift Package Manager migrieren (Flutter 3.44 bis 3.47)"
description: "Flutter 3.44 hat Swift Package Manager zum Standard für iOS und macOS gemacht, doch eine bestehende App behält CocoaPods, bis Sie es entfernen. So prüfen Sie, welche Plugins SwiftPM-fähig sind, lassen das Tool das Xcode-Projekt migrieren, löschen das Podfile sicher, gehen mit reinen Pods-Plugins und eigener Podfile-Logik um und machen die Migration bei Bedarf rückgängig."
pubDate: 2026-10-09
updatedDate: 2026-10-09
template: migration
tags:
  - "migration"
  - "flutter"
  - "ios"
  - "swiftpm"
  - "cocoapods"
  - "xcode"
lang: "de"
translationOf: "2026/10/migrate-a-flutter-ios-app-from-cocoapods-to-swift-package-manager"
translatedBy: "claude"
translationDate: 2026-10-09
---

Wurde Ihre Flutter-App vor Flutter 3.44 erstellt, enthält sie noch ein `Podfile`, ein `Pods/`-Verzeichnis und `#include`-Zeilen für CocoaPods in den xcconfig-Dateien, obwohl Swift Package Manager (SwiftPM) seit 3.44 der Standard ist. Ein Flutter-Upgrade erledigt nur die Hälfte der Migration. Der erste `flutter build ios` oder `flutter run` fügt Ihrem Xcode-Projekt das SwiftPM-Paket hinzu, entfernt aber CocoaPods nicht. Das erledigen Sie selbst, und zwar erst, wenn jedes verwendete Plugin ein `Package.swift` mitliefert. Bei einer typischen App mit 5 bis 15 Plugins dauert das etwa 30 Minuten. Problematisch sind ein von Hand bearbeitetes `Podfile` (eigene `post_install`-Logik, Präprozessor-Makros, zusätzliche Pods) und Plugins, die weiterhin nur als Pod verfügbar sind. Tun Sie es jetzt: Der CocoaPods-Trunk wird am 2. Dezember 2026 schreibgeschützt. Alles Folgende wurde mit Flutter 3.44.8, Xcode 27.0 und CocoaPods 1.17.0 getestet und gegen die aktuelle stabile Version, Flutter 3.47.6, geprüft.

## Warum CocoaPods entfernen, statt es einfach liegen zu lassen

- **Kein Ruby mehr auf dem Build-Rechner.** Sobald kein Pod mehr übrig ist, führt `flutter build ios` kein `pod install` mehr aus. CI braucht dann weder Ruby noch das `cocoapods`-Gem noch den Workaround `LANG=en_US.UTF-8`.
- **Schnellere Builds.** `flutter_tools` meldet das direkt: "Removing CocoaPods integration will improve the project's build time." Die Skriptphasen `[CP] Embed Pods Frameworks` und `[CP] Copy Pods Resources` verschwinden aus jedem Build.
- **Der CocoaPods-Trunk friert ein.** Er wird am 2. Dezember 2026 dauerhaft schreibgeschützt. Bereits vorhandene Pods werden weiter aufgelöst, aber danach kann kein Plugin mehr ein korrigiertes Podspec veröffentlichen. Jedes Plugin, das noch auf CocoaPods setzt, hat eine eingefrorene iOS-Seite.
- **Reine Pods-Plugins stehen unter Beobachtung.** Flutter 3.44+ meldet, dass ein reines Pods-Plugin "will become an error in a future version of Flutter", und pub.dev bewertet Pakete ohne SwiftPM-Unterstützung inzwischen schlechter.

## Was sich im Projekt ändert

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| `ios/Runner.xcodeproj/project.pbxproj` | `FlutterGeneratedPluginSwiftPackage` wird als lokale Paketabhängigkeit von `Runner` hinzugefügt (automatisch) | niedrig |
| `Runner.xcscheme` | Build-Pre-Action "Run Prepare Flutter Framework Script" wird hinzugefügt (automatisch, pro Scheme) | niedrig |
| `ios/Podfile`, `Podfile.lock`, `Pods/`, `.symlinks/` | Von Ihnen gelöscht | mittel |
| `ios/Flutter/Debug.xcconfig`, `Release.xcconfig` | Zeilen `#include? "Pods/..."` von Ihnen entfernt | mittel |
| Eigene `Podfile`-Logik | `post_install`-Hooks, `GCC_PREPROCESSOR_DEFINITIONS` und Nicht-Flutter-Pods müssen anderswo hin | hoch |
| Reine Pods-Plugins | Erzwingen, dass CocoaPods bleibt; das `Podfile` wird neu erzeugt, wenn Sie es löschen | hoch |
| Minimale iOS-Version | SwiftPM-Plugins können ein höheres Minimum deklarieren als Ihr `Runner`-Target | mittel |

## Checkliste vor dem Start

1. Flutter 3.44 oder neuer (`flutter --version`). SwiftPM war seit 3.24 optional, aber ab 3.44 sind die automatische Migration und die unten genannten Warnungen standardmäßig aktiv.
2. Xcode 15 oder neuer. `flutter_tools` verweigert SwiftPM mit älteren Xcode-Versionen.
3. Ein sauberer Arbeitsbaum, damit der Diff von `project.pbxproj` und Scheme nachvollziehbar und umkehrbar ist.
4. SwiftPM nicht deaktiviert. Prüfen Sie, dass `flutter config --list` nicht `enable-swift-package-manager: false` anzeigt und dass `pubspec.yaml` unter `flutter:` kein `config: enable-swift-package-manager: false` enthält. Frühere Releases, als SwiftPM noch optional war, dokumentierten einen anderen Schlüssel, nämlich `disable-swift-package-manager: true` direkt unter `flutter:`. Entfernen Sie ihn, falls ein Teammitglied ihn damals ergänzt hat.
5. Wenn Sie Flavors bauen, notieren Sie jeden Scheme-Namen. Die Pre-Action wird pro Scheme hinzugefügt.

## Migrationsschritte

1. **Aktualisieren Sie zuerst die Plugins.** Viele Plugins haben `Package.swift` in einem Minor-Release ergänzt, und eine alte Lockfile hält Sie auf der Version nur mit Pods. Führen Sie `flutter pub upgrade` aus und für alles, was in `pubspec.yaml` festgepinnt ist, `flutter pub outdated`. Prüfen Sie mit `git diff pubspec.lock`, dass die iOS-Plugin-Implementierungen (`*_ios`, `*_darwin`, `*_foundation`, `*_apple`) angehoben wurden.

2. **Listen Sie auf, welche Plugins SwiftPM nutzen und welche nicht.** `flutter_tools` entscheidet das per Dateiprüfung: Ein Plugin unterstützt SwiftPM, wenn in seinem Paket `ios/<plugin_name>/Package.swift` existiert (oder `darwin/<plugin_name>/Package.swift` bei Plugins, die iOS- und macOS-Code teilen). Das Tool liest die Plugin-Pfade aus `.flutter-plugins-dependencies`, sodass Sie dieselbe Prüfung selbst ausführen können, bevor Sie das Xcode-Projekt anfassen:

   ```bash
   #!/usr/bin/env bash
   # Flutter 3.44+, run from the app root after `flutter pub get`. Needs jq.
   jq -r '.plugins.ios[] | [.name, .path, (if .shared_darwin_source then "darwin" else "ios" end)] | @tsv' \
     .flutter-plugins-dependencies |
   while IFS=$'\t' read -r name path dir; do
     base="${path%/}/$dir"
     if [ -f "$base/$name/Package.swift" ]; then echo "swiftpm    $name"
     elif [ -f "$base/$name.podspec" ];     then echo "pods-only  $name"
     else                                       echo "dart-only  $name"
     fi
   done
   ```

   Bei einer Test-App mit zehn gängigen Plugins lautete die Ausgabe:

   ```text
   swiftpm    audioplayers_darwin
   swiftpm    device_info_plus
   swiftpm    flutter_contacts
   swiftpm    flutter_secure_storage_darwin
   pods-only  flutter_tts
   swiftpm    geolocator_apple
   swiftpm    image_gallery_saver_plus
   swiftpm    package_info_plus
   dart-only  path_provider_foundation
   swiftpm    vibration
   ```

   `dart-only` bedeutet, dass das Plugin gar keinen nativen iOS-Code hat (`path_provider_foundation` 2.6.0 spricht per FFI mit Foundation), sodass keiner der beiden Abhängigkeitsmanager beteiligt ist. Jede Zeile mit `pods-only` bedeutet, dass Sie das Xcode-Projekt migrieren können, CocoaPods aber noch nicht löschen dürfen. Springen Sie dann zum Stolperstein "Reine Pods-Plugins" weiter unten.

3. **Lassen Sie Flutter das Xcode-Projekt migrieren.** Führen Sie einen echten Build aus, keinen reinen Konfigurationslauf:

   ```bash
   # Flutter 3.44.8, Xcode 27.0
   flutter build ios --simulator --debug
   ```

   In meinem Test führte `flutter build ios --config-only` zwar `pod install` aus und erzeugte das SwiftPM-Paket unter `ios/Flutter/ephemeral/Packages/` neu, berührte aber weder `project.pbxproj` noch das Scheme. Die Integration ins Xcode-Projekt geschieht kurz vor dem Start von `xcodebuild`. Prüfen Sie:

   ```bash
   grep -c FlutterGeneratedPluginSwiftPackage ios/Runner.xcodeproj/project.pbxproj   # > 0
   grep "Run Prepare Flutter Framework Script" ios/Runner.xcodeproj/xcshareddata/xcschemes/*.xcscheme
   ```

   Wenn jedes Plugin SwiftPM nutzt, endet die Build-Ausgabe nun mit einer auf Ihr Projekt zugeschnittenen Checkliste:

   ```text
   All plugins found for ios are Swift Packages, but your project still has CocoaPods integration. To remove CocoaPods integration, complete the following steps:
     * In the ios/ directory run "pod deintegrate"
     * Also in the ios/ directory, delete the Podfile
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig" in your ios/Flutter/Debug.xcconfig
     * Remove the include to "Pods/Target Support Files/Pods-Runner/Pods-Runner.release.xcconfig" in your ios/Flutter/Release.xcconfig

   Removing CocoaPods integration will improve the project's build time.
   ```

   Erhalten Sie stattdessen die Meldung "Your project uses a non-standard Podfile and will need to be migrated to Swift Package Manager manually", hat Flutter Ihr `Podfile` Byte für Byte mit seiner Vorlage verglichen und Änderungen gefunden. Gehen Sie den Stolperstein "Eigenes Podfile" durch, bevor Sie fortfahren. Committen Sie an dieser Stelle: Das Projekt baut jetzt mit beiden Managern, und das ist Ihr Rollback-Anker.

4. **Entfernen Sie die CocoaPods-Integration.**

   ```bash
   # CocoaPods 1.17.0
   cd ios
   pod deintegrate
   rm -rf Podfile Podfile.lock Pods .symlinks
   cd ..
   ```

   `pod deintegrate` entfernt aus `project.pbxproj` die `[CP]`-Build-Phasen, die Verknüpfung mit `Pods_Runner.framework` und die Verweise auf die Pods-xcconfig. Prüfen Sie mit `grep -c "\[CP\]" ios/Runner.xcodeproj/project.pbxproj`; die Ausgabe sollte `0` sein.

5. **Entfernen Sie die Pods-Includes aus den xcconfig-Dateien.** Beide Dateien beginnen mit einem optionalen Include, das `pod deintegrate` nicht anfasst:

   ```text
   // ios/Flutter/Debug.xcconfig, before
   #include? "Pods/Target Support Files/Pods-Runner/Pods-Runner.debug.xcconfig"
   #include "Generated.xcconfig"

   // after
   #include "Generated.xcconfig"
   ```

   Machen Sie dasselbe in `Release.xcconfig` und in jeder xcconfig pro Flavor, die Sie angelegt haben (`Debug-dev.xcconfig` und so weiter). Die Form `#include?` bedeutet, dass eine fehlende Datei stillschweigend ignoriert wird, der Build also nicht bricht, wenn die Zeile bleibt. Aber `flutter_tools` sucht nach dieser Zeile und gibt die Checkliste zum Entfernen weiter aus, solange sie existiert. Prüfen Sie mit `grep -rn "Pods" ios/Flutter/*.xcconfig`; es sollte nichts ausgegeben werden.

6. **Räumen Sie den Workspace-Verweis auf.** `pod deintegrate` endet mit "The workspace referencing the Pods project still remains." Öffnen Sie `ios/Runner.xcworkspace/contents.xcworkspacedata` und löschen Sie das Element `<FileRef location = "group:Pods/Pods.xcodeproj">`, damit Xcode kein rotes, fehlendes Projekt mehr anzeigt. Behalten Sie `Runner.xcworkspace` selbst; Flutter und Xcode öffnen die App weiterhin darüber.

7. **Bauen Sie von Grund auf neu.**

   ```bash
   # Flutter 3.44.8 / 3.47.6
   flutter clean
   flutter pub get
   flutter build ios --simulator --debug
   ```

   Prüfen Sie in der Ausgabe zwei Dinge: Es gibt keine Zeile `Running pod install...`, und `ios/Podfile` wurde nicht neu erstellt. Ist das `Podfile` zurückgekehrt, steckt noch ein reines Pods-Plugin im Abhängigkeitsgraphen.

8. **Passen Sie CI an.** Entfernen Sie `pod install`, `pod repo update`, die Ruby-Einrichtung und die CocoaPods-Cache-Schritte. Cachen Sie `~/Library/Developer/Xcode/DerivedData/<project>/SourcePackages` oder übergeben Sie `-clonedSourcePackagesDirPath` an `xcodebuild`, wenn Sie direkt aus Xcode bauen. Prüfen Sie dies, indem Sie die Pipeline auf einem Runner-Image ohne installiertes `cocoapods`-Gem ausführen.

## Verifizierung

- `flutter build ios --release --no-codesign` ist erfolgreich und gibt keine Zeile `pod install` aus.
- `flutter run` auf einem echten Gerät funktioniert, einschließlich Hot Reload. Das belegt, dass die Pre-Action `Flutter.framework` korrekt vorbereitet hat.
- In Xcode hat jedes ausgelieferte Scheme unter Edit Scheme, Build, Pre-actions die Pre-Action "Run Prepare Flutter Framework Script". Von Hand angelegte Flavor-Schemes fehlt sie am häufigsten.
- Jedes Plugin mit nativem Code funktioniert zur Laufzeit: eine Berechtigung anfordern, eine URL öffnen, einen Wert aus dem Secure Storage lesen. Ein Plugin, das kompiliert wurde, aber seine Konfiguration verloren hat, scheitert hier und nicht zur Build-Zeit (siehe den Stolperstein zu `permission_handler`).
- Das Archiv wird gebaut: `flutter build ipa` ist erfolgreich, und der Upload besteht die Validierung von App Store Connect. Dort würde eine fehlende Plugin-Ressource oder ein fehlendes Privacy Manifest zuerst auffallen.

## Migration rückgängig machen

Diese Migration ist umkehrbar. Wenn Sie nach Schritt 3 committet haben, stellt ein `git revert` des Deintegrations-Commits plus `cd ios && pod install` das gemischte Setup wieder her. Um SwiftPM ganz zu verlassen, deaktivieren Sie es für das gesamte Projekt in `pubspec.yaml`:

```yaml
# pubspec.yaml, Flutter 3.44+
flutter:
  config:
    enable-swift-package-manager: false
```

Entfernen Sie dann `FlutterGeneratedPluginSwiftPackage` aus den Package Dependencies und aus Frameworks, Libraries, and Embedded Content des `Runner`-Targets und löschen Sie die Pre-Action aus jedem Scheme. Das Deaktivieren allein lässt die SwiftPM-Integration in der Projektdatei zurück, und Flutter erzeugt weiterhin ein leeres Paket dafür. Betrachten Sie das Deaktivieren als vorübergehend, denn die CocoaPods-Unterstützung befindet sich im Wartungsmodus und wird irgendwann entfallen.

## Stolpersteine aus einer echten Migration

### Reine Pods-Plugins bringen das Podfile zurück

Fehlt auch nur einem Plugin ein `Package.swift`, läuft Flutter im gemischten Modus. Ich habe `flutter_tts` 4.2.5 zu einer vollständig migrierten App ohne `Podfile` hinzugefügt, und der nächste Build gab Folgendes aus:

```text
The following plugins do not support Swift Package Manager for ios:
  - flutter_tts
This will become an error in a future version of Flutter. Please contact the plugin maintainers to request Swift Package Manager adoption.
Running pod install...
```

Flutter hat `ios/Podfile` aus seiner Vorlage neu erzeugt und die `#include?`-Zeilen in beide xcconfig-Dateien zurückgeschrieben. Der gemischte Modus baut problemlos, es ist also kein Notfall. Ihre Optionen: das Plugin ersetzen, seinen iOS-Code in ein lokales Paket mit `Package.swift` übernehmen oder das gemischte Setup behalten und das Plugin später erneut prüfen. Löschen Sie das neu erzeugte `Podfile` nicht in einer Schleife; es kommt immer wieder, solange dieses Plugin in `pubspec.lock` steht.

### permission_handler ignoriert Ihre Podfile-Makros unter SwiftPM

Die klassische Einrichtung von `permission_handler` setzt `PERMISSION_CAMERA=1` und Verwandte in `GCC_PREPROCESSOR_DEFINITIONS` im `post_install`-Block des `Podfile`. Unter SwiftPM läuft dieser Block nicht mehr. Ab `permission_handler_apple` 9.4.8 aktiviert das Paket-Manifest eine Berechtigung, wenn der passende Schlüssel `NS*UsageDescription` in Ihrer `Info.plist` existiert. Version 9.5.1 korrigierte die Erkennung für Build-Konfigurations- und Flavor-spezifische Plists, und 9.6.0 ergänzte eine `permission_handler.yaml` für Berechtigungen pro Flavor, stellen Sie also sicher, dass Ihre Lockfile 9.6.x auflöst. Zwei Folgen: Eine Berechtigung ohne Usage Description wird herauskompiliert und meldet zur Laufzeit `denied`, statt den Build scheitern zu lassen, und das Manifest wird zwischengespeichert, sodass Sie nach einer Änderung der `Info.plist` einmal `rm -rf ~/Library/Developer/Xcode/DerivedData` ausführen müssen. Deshalb ist die Laufzeitprüfung in der Verifizierungsliste wichtig.

### Ein eigenes Podfile muss übersetzt, nicht gelöscht werden

Suchen Sie in Ihrem `Podfile` nach drei Dingen, bevor Sie es löschen. Nicht-Flutter-Pods (`pod 'GoogleMLKit/...'`, Analytics-SDKs) müssen zu Swift-Paketabhängigkeiten werden, die Sie über den Reiter Package Dependencies von Xcode im `Runner`-Projekt hinzufügen. Überschreibungen von Build-Einstellungen in `post_install` (`ENABLE_BITCODE`, `EXCLUDED_ARCHS`, Deployment Targets) betrafen nur Pod-Targets, die meisten können also einfach entfallen. Präprozessor-Makros, die Plugins auswerten, brauchen das SwiftPM-Äquivalent des Plugins, wie oben bei `permission_handler`. Wenn Sie das überspringen, ist der Build meist trotzdem erfolgreich, und die Funktion verschwindet stillschweigend.

### Abweichende Mindest-iOS-Versionen

Ein SwiftPM-Plugin kann eine höhere Plattform als Ihre App deklarieren, was mit "The package product 'plugin_name_ios' requires minimum platform version 14.0 for the iOS platform, but this target supports 12.0" fehlschlägt. Erhöhen Sie die Minimum Deployments des `Runner`-Targets und führen Sie `flutter build ios --config-only` aus, um die Konfiguration neu zu erzeugen. Unter Xcode 27 gibt es eine zweite Untergrenze: Es lehnt jedes iOS-Deployment-Target unter 15.0 ab, und ein mit Flutter 3.44.8 erstelltes Projekt steht noch auf 13.0. Dieser Fehler trifft das `Runner`-Projekt und im gemischten Modus jedes Pod-Target. Für Pods fügen Sie im `post_install`-Block nach `flutter_additional_ios_build_settings(target)` eine Überschreibung hinzu:

```ruby
# ios/Podfile, Flutter 3.44.8 + Xcode 27.0, mixed mode only
target.build_configurations.each do |config|
  config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
end
```

macOS hat eine eigene Variante dieses Problems, behandelt in [Mindest-Deployment-Target einer Flutter-macOS-App für Xcode 27 auf macOS 12 anheben](/de/2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27/).

### Alte StackOverflow-Lösungen greifen nicht mehr

Eine Pod-Version im `Podfile` festzupinnen, um einen Konflikt zu lösen, bewirkt nichts mehr, sobald das Plugin über SwiftPM aufgelöst wird, denn CocoaPods sieht es nie. Falls Sie früher mit [CocoaPods "could not find compatible versions for pod"](/de/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) gekämpft haben, löschen Sie diese Pins bei der Migration, statt sie mitzuschleppen.

### Add-to-app-Module sind anders

Ein in eine native iOS-App eingebettetes Flutter-Modul verwendet sein eigenes Modul-`Podfile`, das `flutter_tools` bewusst nicht anfasst. Folgen Sie stattdessen der Anleitung zum Einrichten von Add-to-app-Projekten, nicht den obigen Schritten.

## Verwandte Beiträge

- Das Release, das den Standard umgestellt hat: [Flutter 3.44 macht Swift Package Manager zum Standard](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Wenn Xcode selbst das Problem ist und nicht der Abhängigkeitsmanager, beginnen Sie mit [failed to build an iOS app with Xcode 16 and Flutter 3.x](/de/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).
- Wie Sie die Migration in CI über mehrere Flutter-Versionen ausrollen, ohne ältere Branches zu brechen, lesen Sie unter [mehrere Flutter-Versionen aus einer CI-Pipeline anvisieren](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/).

## Quellen

- [Swift Package Manager for app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Swift Package Manager for plugin authors](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-plugin-authors) (docs.flutter.dev)
- [Saying goodbye to CocoaPods](https://flutter.dev/blog/saying-goodbye-to-cocoapods-swift-package-manager-is-soon-the-default-in-flutter) (flutter.dev blog)
- [`darwin_dependency_management.dart`](https://github.com/flutter/flutter/blob/master/packages/flutter_tools/lib/src/macos/darwin_dependency_management.dart), die Quelle der oben zitierten Warnungen (flutter/flutter)
- [`permission_handler_apple` changelog](https://github.com/Baseflow/flutter-permission-handler/blob/main/permission_handler_apple/CHANGELOG.md) (Baseflow/flutter-permission-handler)
- [CocoaPods Specs repo read-only plan](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (CocoaPods blog)
