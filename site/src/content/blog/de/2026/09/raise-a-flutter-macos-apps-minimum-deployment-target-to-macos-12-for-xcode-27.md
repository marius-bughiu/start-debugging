---
title: "Das minimale Deployment Target einer Flutter-macOS-App für Xcode 27 auf macOS 12 anheben"
description: "Xcode 27 verweigert jeden Build unter macOS 12, und Flutter 3.47 hat seine eigene Untergrenze von 10.15 auf 12.0 angehoben. Was die automatische Migration umschreibt, die drei Stellen, die sie stillschweigend überspringt (eigene Werte, post_install-Overrides im Podfile, Plugin-Podspecs), und ein Podfile-Fix für Teams, die noch auf Flutter 3.44 sind."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "macos"
  - "xcode"
  - "cocoapods"
lang: "de"
translationOf: "2026/09/raise-a-flutter-macos-apps-minimum-deployment-target-to-macos-12-for-xcode-27"
translatedBy: "claude"
translationDate: 2026-09-18
---

Für die meisten Flutter-macOS-Apps ist das eine Sache von fünf Minuten: auf Flutter 3.47 oder neuer aktualisieren (3.47.4 ist das aktuelle Stable-Release, Dart 3.13.3), einmal `flutter build macos` ausführen und die drei Zeilen committen, die das Tool in `macos/Runner.xcodeproj/project.pbxproj` umschreibt, dazu die Zeile `platform :osx` in `macos/Podfile`. Die Migration erkennt nur die exakten Standardwerte, die Flutter jemals generiert hat (10.11, 10.13, 10.14, 10.15, 11.0). Ein Projekt, das jemand von Hand auf `11.5` oder `10.14.6` gesetzt hat, ein `post_install`-Block im Podfile, der Pods auf eine alte Version festlegt, oder ein veralteter Plugin-Podspec übersteht die Migration und scheitert dann unter Xcode 27 mit `The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to ..., but the range of supported deployment target versions is 12.0 to 27.0.x`. Alles Folgende wurde auf einem Mac mit Xcode 26.6, Flutter 3.44.8 und 3.47.4 sowie CocoaPods 1.17.0 überprüft.

## Warum sich die Untergrenze verschoben hat

Apple hat das niedrigste macOS-Deployment-Target in Xcode 27 von macOS 11 auf macOS 12 angehoben (iOS bleibt bei 15, watchOS geht von 8 auf 9). Xcode 27 ist Mitte September 2026 allgemein verfügbar geworden, daher stellen CI-Images und Entwicklerrechner gerade jetzt um. Unterhalb der Grenze warnt Xcode 27 nicht und klemmt den Wert nicht ab, wie es frühere Versionen taten: Es bricht den Build mit einem Target-Integrity-Fehler ab.

Flutters Richtlinie lautet, [den Deployment-Bereich des aktuellen Xcode zu übernehmen](https://flutter.dev/go/match-xcode-deployment-range). Deshalb hat das Team [flutter/flutter#187762](https://github.com/flutter/flutter/issues/187762) angelegt und [flutter/flutter#188520](https://github.com/flutter/flutter/pull/188520) umgesetzt (gemergt am 2026-06-29), das mit 3.47.0 ausgeliefert wird. Es bewirkt drei Dinge:

- `FlutterDarwinPlatform.macos.deploymentTarget()` in `flutter_tools` liefert jetzt `12.0` statt `10.15`. Dieser Wert steuert das generierte SwiftPM-Paket, die Plugin-Templates und den Podspec für `FlutterMacOS`.
- Das `FlutterMacOS.framework` der Engine wird für macOS 12 gebaut. In meinem 3.44.8-Build steht in dessen `LC_BUILD_VERSION` `minos 11.0`, im 3.47.4-Build `minos 12.0`.
- `MacOSDeploymentTargetMigration` und `podhelper.rb` wurden aktualisiert, um bestehende Projekte auf `12.0` zu heben.

Der zweite Punkt ist auch dann relevant, wenn Sie Xcode 27 nie installieren. Eine Flutter-3.47-App, die weiterhin behauptet, macOS 11 zu unterstützen, gibt ein Versprechen, das die Engine-Binary nicht halten kann.

## Was kaputtgeht

| Bereich | Änderung | Schweregrad |
| ---- | ------ | -------- |
| `MACOSX_DEPLOYMENT_TARGET` unter 12.0 in `Runner` | Build-Fehler unter Xcode 27 | hoch, für Standardwerte automatisch migriert |
| `platform :osx` unter 12.0 in `macos/Podfile` | Pods werden für die alte Version gebaut, Fehler unter Xcode 27 | hoch, für Standardwerte automatisch migriert |
| `post_install` im Podfile, das `MACOSX_DEPLOYMENT_TARGET` für Pods setzt | Overrides überstehen die Migration, Fehler unter Xcode 27 | hoch, manueller Fix |
| Plugin-Podspec oder `Package.swift` mit Angabe unter 12.0 | Wird von `podhelper.rb` (3.47+) und dem generierten SwiftPM-Paket behandelt | gering für App-Autoren, Aufräumarbeit für Plugin-Autoren |
| Nutzer auf macOS 10.15 und 11 | Können neue Builds nicht installieren (`LSMinimumSystemVersion` wird 12.0) | Produktentscheidung |

Die letzte Zeile ist die einzige, die kein Build-Problem ist. `macos/Runner/Info.plist` setzt `LSMinimumSystemVersion` auf `$(MACOSX_DEPLOYMENT_TARGET)`. Sobald sich die Build-Einstellung ändert, bieten der App Store und Updater im Stil von Sparkle Ihre neue Version Rechnern mit Catalina und Big Sur nicht mehr an. Prüfen Sie vor dem Release Ihre Analytics und informieren Sie den Support.

## Checkliste vor dem Start

- Flutter 3.47.0 oder neuer auf jedem Rechner und CI-Runner, der das macOS-Target baut. `flutter --version` sollte `3.47.x` oder neuer ausgeben.
- Ein sauberer Arbeitsbaum in `macos/`, damit sich der Migrations-Diff für sich allein prüfen lässt.
- CocoaPods 1.16 oder neuer, falls Sie für macOS-Plugins noch CocoaPods verwenden (hier wurde 1.17.0 genutzt).
- Eine Liste aller Stellen, an denen Ihr Repository eine macOS-Version setzt. Dieser Einzeiler findet sie:

```bash
# Flutter 3.47.4, run from the project root
grep -rnE "MACOSX_DEPLOYMENT_TARGET|platform :osx|osx.deployment_target|\.macOS\(" \
  macos/ --include='*.pbxproj' --include='Podfile' --include='*.xcconfig' \
  --include='*.podspec' --include='Package.swift'
```

## Migrationsschritte

1. Aktualisieren Sie das SDK mit `flutter upgrade` (oder legen Sie 3.47.4 in Ihrer FVM- oder CI-Konfiguration fest) und führen Sie anschließend `flutter clean` aus. Prüfen Sie mit `flutter --version`, dass das Tool 3.47.x oder neuer meldet.
2. Führen Sie einmal `flutter build macos --debug` aus. Das Tool führt `MacOSDeploymentTargetMigration` vor `pod install` aus und gibt genau einmal `Updating minimum macOS deployment target to 12.0.` aus. Prüfen Sie mit `git diff --stat macos/`, dass sich `project.pbxproj` und `Podfile` geändert haben.
3. Führen Sie den grep aus der Checkliste erneut aus und stellen Sie sicher, dass in `Runner`, `RunnerTests`, weiteren Targets, `.xcconfig`-Dateien oder dem Podfile nichts unter 12.0 übrig ist. Korrigieren Sie alles, was die Migration übersprungen hat, von Hand (Details unten).
4. Entfernen oder aktualisieren Sie jeden `post_install`-Block im Podfile, der `MACOSX_DEPLOYMENT_TARGET` auf Pod-Targets schreibt, und führen Sie dann erneut `flutter build macos --debug` aus. Prüfen Sie mit `grep MACOSX_DEPLOYMENT_TARGET macos/Pods/Pods.xcodeproj/project.pbxproj | sort | uniq -c`, dass jeder Eintrag 12.0 oder höher ist.
5. Prüfen Sie die ausgelieferte Binary: `plutil -p` auf die `Contents/Info.plist` der gebauten App sollte `LSMinimumSystemVersion => 12.0` zeigen, und `otool -l` auf die ausführbare Datei sollte `minos 12.0` zeigen.
6. Stellen Sie CI auf ein Xcode-27-Image um und führen Sie einen Release-Build aus (`flutter build macos --release`). Nur dieser Schritt beweist, dass das Projekt unter Xcode 27 baut.

## Was die Migration tatsächlich umschreibt

Bei einem Projekt, das mit Flutter 3.44.8 erstellt wurde (das überall 10.15 generiert), mit hinzugefügtem `url_launcher` und aktiviertem CocoaPods, gab der erste 3.47.4-Build die Statuszeile aus und erzeugte in den beiden Dateien, die er verwaltet, genau diesen Diff:

```diff
# macos/Podfile (Flutter 3.47.4 migration)
-platform :osx, '10.15'
+platform :osx, '12.0'

# macos/Runner.xcodeproj/project.pbxproj (Debug, Release, Profile)
-				MACOSX_DEPLOYMENT_TARGET = 10.15;
+				MACOSX_DEPLOYMENT_TARGET = 12.0;
```

Der Build war danach erfolgreich, und jedes `MACOSX_DEPLOYMENT_TARGET` in `Pods.xcodeproj` stand auf 12.0, obwohl `url_launcher_macos` 3.2.6 in seinem Podspec weiterhin `s.platform = :osx, '10.15'` deklariert. Das ist das Werk von `podhelper.rb`: `flutter_additional_macos_build_settings` löscht das eigene Deployment Target eines Pods, wenn dessen Hauptversion unter 12 liegt, sodass der Pod stattdessen die Plattform des Podfiles erbt. Vor 3.47 lag die Grenze bei 10.15, sodass ein Pod mit 10.15 seinen Wert behielt. Genau deshalb scheitern Flutter-3.44-Projekte unter Xcode 27 selbst dann, wenn Sie das Runner-Target angepasst haben (siehe letzter Abschnitt).

Mit SwiftPM (seit Flutter 3.44 der Standard für Projekte ohne Opt-out) hebt die Migration ebenfalls das Runner-Target an, und das Tool generiert `macos/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift` aus dem `MACOSX_DEPLOYMENT_TARGET` des Runners neu. In meinem Durchlauf wechselte es beim ersten 3.47.4-Build von `.macOS("10.15")` auf `.macOS("12.0")`. Die `Package.swift` in `url_launcher_macos` sagt weiterhin `.macOS("10.15")`; unter Xcode 26.6 baute das sauber. Xcode 27 konnte ich auf diesem Rechner nicht ausführen, daher habe ich nicht überprüft, ob Plugin-Manifeste unter 12.0 auch dort sauber bauen.

## Stolperfalle 1: Eine von Hand geänderte Version ist für die Migration unsichtbar

Der Migrator ist ein zeilenbasiertes String-Replace. Laut `macos_deployment_target_migration.dart` am Tag `3.47.4` sucht er nach diesen literalen Strings und nichts anderem:

```dart
// flutter_tools 3.47.4, lib/src/macos/migrations/macos_deployment_target_migration.dart
const deploymentTargetOriginal1015 = 'MACOSX_DEPLOYMENT_TARGET = 10.15;';
const deploymentTargetOriginal110 = 'MACOSX_DEPLOYMENT_TARGET = 11.0;';
const podfilePlatformVersionOriginal1015 = "platform :osx, '10.15'";
const podfilePlatformVersionOriginal110 = "platform :osx, '11.0'";
// ...plus 10.11, 10.13 and 10.14 in both forms
```

`11.5`, `10.14.6`, `11.0.1`, ein in einer `.xcconfig` gesetzter Wert oder `platform :osx, "10.15"` mit doppelten Anführungszeichen bleiben also unangetastet, ohne jede Meldung. Ich habe Runner-Target und Podfile auf 11.5 gesetzt und mit 3.47.4 gebaut. Es gab keine Zeile `Updating minimum macOS deployment target`, `git status` zeigte keine Änderungen an beiden Dateien, und der Build war unter Xcode 26.6 trotzdem erfolgreich, mit Linker-Warnungen, über die man leicht hinwegscrollt:

```text
ld: warning: building for macOS-11.5, but linking with dylib
'@rpath/FlutterMacOS.framework/Versions/A/FlutterMacOS' which was built for newer version 12.0
```

Die resultierende App hat `LSMinimumSystemVersion` 11.5 und `minos 11.5`, liefert aber eine für 12.0 gebaute Engine aus. Unter Xcode 27 scheitert dasselbe Projekt direkt. Die Lösung besteht darin, den Wert von Hand in Xcode (Runner-Projekt, Runner-Target, General, Minimum Deployments) oder in der Datei zu setzen:

```bash
# Flutter 3.47.4 project, replace any leftover value below 12.0
sed -i '' -E 's/MACOSX_DEPLOYMENT_TARGET = (10\.[0-9.]+|11\.[0-9.]+);/MACOSX_DEPLOYMENT_TARGET = 12.0;/' \
  macos/Runner.xcodeproj/project.pbxproj
sed -i '' -E "s/platform :osx, ['\"][0-9.]+['\"]/platform :osx, '12.0'/" macos/Podfile
```

Die Podfile-Plattform anzuheben ist genauso wichtig wie das Runner-Target. Als ich den Runner auf 10.14.6 und das Podfile auf 11.5 belassen habe, brach sogar Xcode 26.6 mit `compiling for macOS 10.14.6, but module 'url_launcher_macos' has a minimum deployment target of macOS 11.5` in `GeneratedPluginRegistrant.swift` ab. Halten Sie beide Werte synchron.

## Stolperfalle 2: post_install-Overrides im Podfile überleben

Ein verbreitetes Copy-Paste aus der Xcode-14-Ära zwingt jeden Pod auf eine Version:

```ruby
# macos/Podfile, a pattern that breaks on Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['MACOSX_DEPLOYMENT_TARGET'] = '10.14'
    end
  end
end
```

Die Migration hat die Zeile `platform :osx` dieses Podfiles angepasst und ihre Statusmeldung ausgegeben, es sieht also erledigt aus. Nach dem Build enthielt `Pods.xcodeproj` 15 Einträge `MACOSX_DEPLOYMENT_TARGET = 10.14;` und nur 3 mit 12.0: Der Override läuft nach `flutter_additional_macos_build_settings` und gewinnt. Xcode 26.6 hat diese Pods stillschweigend für macOS 11.0 (seine eigene Untergrenze) gebaut, weshalb es niemandem auffällt. Xcode 27 meldet stattdessen für jeden einzelnen einen Fehler.

Löschen Sie die innere Schleife. Wenn ein Pod wirklich eine festgelegte Version braucht, setzen Sie sie auf `12.0` oder höher, niemals niedriger als die Plattform des Podfiles.

## Stolperfalle 3: Die geführte Fehlermeldung gibt es erst ab 3.47

Wenn Xcode das Target ablehnt, erkennt Flutter 3.47 die Zeile (die Erkennungslogik kam mit [flutter/flutter#188812](https://github.com/flutter/flutter/pull/188812), aus [flutter/flutter#187855](https://github.com/flutter/flutter/issues/187855)) und gibt eine eingerahmte Meldung aus:

```text
The macOS deployment target is too low. Xcode requires at least 12.0.

To upgrade your macOS deployment target, follow these steps:
  1. Open the project in Xcode:
     open macos/Runner.xcworkspace
  2. Select the "Runner" project in the project navigator.
  3. Select the "Runner" TARGET, and in the "General" tab:
     Update "Minimum Deployments" to at least 12.0.
```

Zwei Einschränkungen. Die Meldung erscheint nur, wenn die fehlschlagende Zeile `MACOSX_DEPLOYMENT_TARGET` und den unterstützten Bereich erwähnt, und der Rat betrifft nur das Runner-Target. Bei einem Fehler in einem Pod-Target (Stolperfalle 2) ist der vorgeschlagene Fix also nicht der, den Sie brauchen. Flutter 3.44 und älter haben gar keine solche Behandlung: Sie bekommen `Build process failed` plus die rohe Xcode-Zeile, die in den Test-Fixtures dieses PRs so lautet: `error: The macOS deployment target 'MACOSX_DEPLOYMENT_TARGET' is set to 10.11, but the range of supported deployment target versions is 12.0 to 27.0.x. (in target 'Runner' from project 'Runner')`. Das Suffix `(in target '...')` verrät Ihnen, welches Target Sie korrigieren müssen.

## Mit Flutter 3.44 unter Xcode 27 bleiben

Manchmal ist ein Flutter-Upgrade diese Woche nicht drin, aber Ihr CI-Image ist bereits auf Xcode 27 umgestiegen. Sie können das Projekt von Hand anheben, doch das `podhelper.rb` von 3.44 entfernt Pod-Deployment-Targets nur unterhalb von 10.15, sodass Pods mit Angaben von 10.15 bis 11.x ihre Werte behalten. In einem 3.44.8-Projekt mit Runner und Podfile auf 12.0 hatte `Pods.xcodeproj` immer noch 9 Einträge mit `10.15`. Diese Ergänzung in `post_install` hat sie alle entfernt, sodass jeder Pod bei den geerbten 12.0 landete:

```ruby
# macos/Podfile, Flutter 3.44.x workaround for Xcode 27
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_macos_build_settings(target)
    target.build_configurations.each do |config|
      pod_target = config.build_settings['MACOSX_DEPLOYMENT_TARGET']
      if pod_target && Gem::Version.new(pod_target) < Gem::Version.new('12.0')
        config.build_settings.delete 'MACOSX_DEPLOYMENT_TARGET'
      end
    end
  end
end
```

Löschen statt Überschreiben ist derselbe Trick, den Flutter 3.47 nutzt: Der Pod erbt den höheren Wert vom Projekt, und ein Pod, der tatsächlich etwas Neueres als 12.0 benötigt, behält seine eigene Anforderung. Das Engine-Framework in 3.44 ist für macOS 11 gebaut, daher ändert dies nichts daran, worauf Ihre Binary laufen kann; es stellt nur Xcode 27 zufrieden. Entfernen Sie den Block, sobald Sie auf 3.47 sind, da er dann überflüssig wird.

## Für Plugin-Autoren

Wenn Sie ein macOS-Plugin veröffentlichen, heben Sie im nächsten Release den Podspec (`s.platform = :osx, '12.0'` oder `s.osx.deployment_target = '12.0'`) und die Plattform in `Package.swift` (`.macOS("12.0")`) an, und setzen Sie Ihre Einschränkung `environment: flutter:` auf `>=3.47.0`, falls Sie auf etwas aus diesem Release angewiesen sind. Apps auf 3.47 sind durch `podhelper.rb` bereits geschützt, das ist also Hygiene und kein Notfall. Es verhindert aber, dass Ihr Plugin als falsch-positiver Treffer im `grep` von jemandem auftaucht, und die Plugin-Templates von 3.47 generieren ohnehin 12.0.

## Überprüfung

- `flutter build macos --release` ist auf einem Xcode-27-Runner erfolgreich.
- `grep -rn MACOSX_DEPLOYMENT_TARGET macos/ --include='*.pbxproj' --include='*.xcconfig'` zeigt nichts unter 12.0, einschließlich `macos/Pods/Pods.xcodeproj/project.pbxproj`.
- `plutil -p build/macos/Build/Products/Release/<App>.app/Contents/Info.plist | grep LSMinimumSystemVersion` gibt `12.0` aus.
- Das Build-Log enthält keine Warnungen der Form `building for macOS-11.x, but linking with dylib ... built for newer version 12.0`.
- Die App startet auf dem ältesten macOS, auf dem Sie noch testen (12.x, falls Sie dafür einen Rechner oder eine VM haben).

## Rollback-Plan

Die Änderung am Quellcode lässt sich mit `git revert` rückgängig machen, das Flutter SDK aber nicht: Ab 3.47 ist die Engine für macOS 12 gebaut, und das Tool führt die Migration beim nächsten Build erneut aus, sobald es einen Standardwert unter 12.0 sieht. Zurück zur Unterstützung von macOS 10.15 oder 11 heißt, bei Flutter 3.44.x und Xcode 26 zu bleiben, die Apple für App-Store-Einreichungen nicht mehr akzeptieren wird, sobald das macOS-27-SDK Pflicht wird. Betrachten Sie das als Einbahnstraße und treffen Sie die Entscheidung zur macOS-11-Unterstützung ausdrücklich, bevor Sie mergen.

## Verwandte Artikel

- Die Android-Seite desselben 3.47-Upgrades: [ein Flutter-Android-Projekt auf AGP 9 mit integriertem Kotlin migrieren](/de/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/).
- Was sich in diesem Release sonst für den Desktop geändert hat: [Flutter 3.47 macht Impeller zum Standard-Renderer auf dem Desktop](/de/2026/08/flutter-3-47-impeller-default-renderer-on-desktop/).
- Warum Ihr Projekt womöglich auf SwiftPM läuft, ohne dass Sie es gewählt haben: [Flutter 3.44 verwendet standardmäßig SwiftPM](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Wenn das Podfile-Problem die Versionsauflösung betrifft und nicht die Deployment Targets: ["CocoaPods could not find compatible versions for pod" beheben](/de/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/).
- Die vorherige Runde davon auf iOS: ["Failed to build iOS app" mit Xcode 16 und Flutter 3.x beheben](/de/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/).

## Quellen

- [flutter/flutter#187762: Increase macOS minimum supported version from 10.15 to 12 to support Xcode 27](https://github.com/flutter/flutter/issues/187762)
- [flutter/flutter#188520: die Änderung an SDK, Templates, podhelper und Migration](https://github.com/flutter/flutter/pull/188520)
- [flutter/flutter#188812: geführte Meldung, wenn die Mindestversion zu niedrig ist](https://github.com/flutter/flutter/pull/188812)
- [`macos_deployment_target_migration.dart` in 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/lib/src/macos/migrations/macos_deployment_target_migration.dart)
- [`podhelper.rb` in 3.47.4](https://github.com/flutter/flutter/blob/3.47.4/packages/flutter_tools/bin/podhelper.rb)
- [Release Notes zu Flutter 3.47.0](https://docs.flutter.dev/release/release-notes/release-notes-3.47.0)
- [Release Notes zu Xcode 27](https://developer.apple.com/go/?id=xcode-27-sdk-rn)
