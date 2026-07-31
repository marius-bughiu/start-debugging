---
title: "Lösung: CocoaPods could not find compatible versions for pod bei einem Flutter-iOS-Build"
description: "Lesen Sie die zweite Zeile des Fehlers, nicht die erste. Sie benennt die Ursache: ein veraltetes Podfile.lock, ein zu niedriges Deployment Target oder zwei Plugins, die denselben transitiven Pod fixieren."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "ios"
  - "cocoapods"
lang: "de"
translationOf: "2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build"
translatedBy: "claude"
translationDate: 2026-07-31
---

Die Lösung hängt vollständig von der Zeile direkt unter dem Fehler ab, und es gibt nur vier Möglichkeiten. Steht dort `In snapshot (Podfile.lock)`, löschen Sie `ios/Podfile.lock` und führen Sie `pod install` aus. Steht dort, dass die Specs `required a higher minimum deployment target`, erhöhen Sie `platform :ios` in Ihrem `Podfile`. Werden zwei Plugins aufgelistet, die jeweils auf eine andere exakte Version desselben Pods auflösen, liegt ein echter Konflikt vor, und der wird in `pubspec.yaml` behoben, nicht im `Podfile`. Nur der vierte Fall, ein tatsächlich veraltetes Specs-Repository, wird durch `pod repo update` behoben. Zuerst `pod repo update` auszuführen, was fast alle tun, verschwendet zwei Minuten in den drei Fällen, in denen es nicht helfen kann.

Dieser Artikel bezieht sich auf Flutter 3.44.7 (stable, Juli 2026), CocoaPods 1.17.0 (veröffentlicht am 2026-07-06), Dart 3.12 und Xcode 16.x unter macOS Sequoia.

## Der Fehler im Kontext

Die häufigste Form, direkt nach einem `flutter pub upgrade`, das ein Firebase-Plugin angehoben hat:

```text
[!] CocoaPods could not find compatible versions for pod "Firebase/CoreOnly":
  In snapshot (Podfile.lock):
    Firebase/CoreOnly (= 10.28.0)

  In Podfile:
    firebase_core (from `.symlinks/plugins/firebase_core/ios`) was resolved to 3.4.0, which depends on
      Firebase/CoreOnly (= 11.0.0)

You have either:
 * out-of-date source repos which you can update with `pod repo update` or with `pod install --repo-update`.
 * changed the constraints of dependency `Firebase/CoreOnly` inside your development pod `firebase_core`.
   You should run `pod update Firebase/CoreOnly` to apply changes you've made.

Error running pod install
Error launching application on iPhone 16 Pro.
```

Die zweite Form, die wie derselbe Fehler aussieht, es aber nicht ist:

```text
[!] CocoaPods could not find compatible versions for pod "sqflite_darwin":
  In Podfile:
    sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)

Specs satisfying the `sqflite_darwin (from `.symlinks/plugins/sqflite_darwin/darwin`)` dependency were
found, but they required a higher minimum deployment target.
```

Beide beginnen mit derselben Kopfzeile, und genau deshalb sind die Suchergebnisse zu diesem Fehler ein Durcheinander widersprüchlicher Ratschläge. Über die erste Zeile hinaus haben sie nichts gemeinsam.

## Warum CocoaPods das meldet, statt einfach eine Version zu wählen

CocoaPods löst Abhängigkeiten mit Molinillo auf, einem backtrackenden Resolver im SAT-Stil. Er bekommt eine Menge von Constraints und soll je eine Version jedes Pods finden, die alle gleichzeitig erfüllt. Erschöpft er den Suchraum ohne Lösung, rät er nicht. Er gibt die Constraints aus, die beim Abbruch noch im Konflikt standen, dazu eine allgemeine Liste von Dingen, die manchmal Konflikte verursachen.

Diese Liste ist generisch. Sie wird ausgegeben, unabhängig davon, ob sie zutrifft. Der diagnostische Inhalt ist der eingerückte Block darüber, der jedes Constraint und seine Herkunft benennt. Vier Dinge bringen ein unerfüllbares Constraint in diese Menge:

1. **`Podfile.lock` fixiert eine alte exakte Version.** Die Lock-Datei nimmt als Constraint mit der Kennzeichnung `In snapshot (Podfile.lock)` an der Auflösung teil. Ein Plugin-Update auf der Dart-Seite hat geändert, was der Podspec verlangt, und der Lock besteht weiter auf der alten Nummer. Mit Abstand die häufigste Ursache.
2. **Jede Kandidatenversion braucht ein höheres Deployment Target, als Ihr `Podfile` deklariert.** Molinillo filtert Specs heraus, deren `deployment_target` Ihre Plattformzeile übersteigt, und meldet dann eine leere Kandidatenmenge. Das ist die Variante `required a higher minimum deployment target`.
3. **Zwei Plugins fixieren inkompatible exakte Versionen eines gemeinsamen transitiven Pods.** Ein echtes Diamantproblem. Keine `Podfile`-Änderung löst es, weil das Constraint aus zwei Podspecs stammt, die Flutter aus Ihrer `pubspec.yaml` generiert hat.
4. **Das Specs-Repository ist älter als die angeforderte Version.** Nur relevant, wenn Sie ein git-basiertes Specs-Repository verwenden. Die CDN-Quelle, die Flutters Standard-`Podfile` nutzt, braucht kein `pod repo update`.

## Minimale Reproduktion

Fall 1 lässt sich in drei Befehlen in jedem Projekt reproduzieren, das ein Plugin mit fixierter nativer Abhängigkeit enthält:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter create podconflict && cd podconflict
flutter pub add firebase_core:3.1.0 && (cd ios && pod install)
flutter pub add firebase_core:3.4.0 && (cd ios && pod install)   # boom
```

Das erste `pod install` schreibt `Firebase/CoreOnly (= 11.0.0)` in `ios/Podfile.lock`. Das zweite `flutter pub add` tauscht das Plugin gegen eines, dessen Podspec eine andere exakte Version verlangt, und das Constraint der Lock-Datei ist gegenüber dem neuen Podspec nun unerfüllbar.

Fall 2 lässt sich reproduzieren, indem die Plattformzeile unter das gesenkt wird, was ein Plugin benötigt:

```ruby
# ios/Podfile -- Flutter 3.44.7, CocoaPods 1.17.0
platform :ios, '12.0'
```

mit einem Plugin, dessen Podspec Folgendes deklariert:

```ruby
# .symlinks/plugins/sqflite_darwin/darwin/sqflite_darwin.podspec
s.platform = :ios, '13.0'
```

## Die Lösung, nach Priorität geordnet

### 1. Steht im Fehler `In snapshot (Podfile.lock)`, verwerfen Sie den Lock

Die Lock-Datei ist ein Cache einer früheren Auflösung, keine Quelle der Wahrheit. Flutter regeneriert bei jedem Build den gesamten Pod-Graphen aus `pubspec.lock`, sodass ein `ios/Podfile.lock`, das dem widerspricht, per Definition veraltet und nicht maßgeblich ist.

```bash
# Flutter 3.44.7, CocoaPods 1.17.0 -- run from the repo root
flutter pub get
cd ios
rm Podfile.lock
pod install
```

Beachten Sie die Reihenfolge. `flutter pub get` muss zuerst laufen, denn es schreibt `ios/.symlinks/plugins/` so um, dass es auf die aufgelösten Plugin-Versionen im pub-Cache zeigt. `pod install` davor auszuführen löst die Podspecs der Plugin-Versionen auf, die beim letzten Mal dort lagen, was denselben Fehler mit anderen Zahlen erzeugt und Sie im Kreis schickt.

Wenn es ein Plugin ist, das Sie selbst kontrollieren, oder eines, bei dem Sie eine gezielte Änderung statt einer vollständigen Neuauflösung wollen:

```bash
# CocoaPods 1.17.0 -- surgical alternative, keeps other pins intact
cd ios && pod update Firebase/CoreOnly
```

In einer Flutter-App ist das Löschen des Locks vorzuziehen. `pod update <pod>` ist die richtige Wahl in einem handgeschriebenen iOS-Projekt, in dem die Lock-Datei bewusste Fixierungen kodiert; in einer Flutter-App stammen diese Fixierungen aus `pubspec.lock`, und von dort sollen sie auch weiterhin kommen.

### 2. Steht im Fehler `higher minimum deployment target`, erhöhen Sie die Plattform an zwei Stellen

Sowohl das `Podfile` als auch das Xcode-Projekt brauchen das. Nur das `Podfile` zu ändern repariert die Pod-Auflösung und scheitert dann später beim Linken, weil die Build-Einstellung des `Runner`-Targets weiterhin die alte Untergrenze deklariert.

```ruby
# ios/Podfile -- Flutter 3.44.7
platform :ios, '15.0'
```

```ruby
# ios/Podfile -- force every pod target to inherit the same floor
post_install do |installer|
  installer.pods_project.targets.each do |target|
    flutter_additional_ios_build_settings(target)
    target.build_configurations.each do |config|
      config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '15.0'
    end
  end
end
```

Setzen Sie es anschließend auch am App-Target. Öffnen Sie `ios/Runner.xcworkspace`, wählen Sie das `Runner`-Target, gehen Sie zu `Build Settings` und setzen Sie `iOS Deployment Target` für Debug und Release auf denselben Wert. Für `Runner` selbst gewinnt die Workspace-Einstellung gegenüber dem `Podfile`; die `Podfile`-Zeile gilt nur für Pod-Targets.

Wählen Sie die Zahl nicht durch Ausprobieren. Lesen Sie sie aus dem fehlgeschlagenen Podspec ab:

```bash
# Flutter 3.44.7 -- print the floor the failing plugin actually declares
grep -r "s.platform\|deployment_target" ios/.symlinks/plugins/sqflite_darwin/darwin/*.podspec
```

Eine höhere Untergrenze schließt ältere Geräte aus, erhöhen Sie sie also genau auf das, was der Podspec verlangt, nicht auf die neueste installierte iOS-Version.

### 3. Fixieren zwei Plugins denselben Pod auf unterschiedliche exakte Versionen, korrigieren Sie `pubspec.yaml`

Das ist der Fall, in dem jede `Podfile`-Änderung und jedes Cache-Löschen scheitert, weil der Konflikt oberhalb von CocoaPods liegt. Das Erkennungsmerkmal sind zwei `was resolved to`-Zeilen, die zwei verschiedene Plugins nennen:

```text
[!] CocoaPods could not find compatible versions for pod "GTMSessionFetcher/Core":
  In Podfile:
    firebase_auth (from `.symlinks/plugins/firebase_auth/ios`) was resolved to 5.1.0, which depends on
      GTMSessionFetcher/Core (~> 3.3)
    google_sign_in_ios (from `.symlinks/plugins/google_sign_in_ios/darwin`) was resolved to 5.7.6, which depends on
      GTMSessionFetcher/Core (< 3.0, >= 1.1)
```

`~> 3.3` und `< 3.0` überschneiden sich nicht. Suchen Sie die Plugin-Versionen, deren Podspecs zueinander passen, und fixieren Sie sie in `pubspec.yaml`:

```yaml
# pubspec.yaml -- Flutter 3.44.7, Dart 3.12
dependencies:
  firebase_auth: ^5.1.0
  google_sign_in: ^6.2.2   # 6.2.2 ships google_sign_in_ios 5.7.7+, which allows GTMSessionFetcher 3.x
```

Lösen Sie dann beide Ebenen neu auf:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter pub get
cd ios && rm Podfile.lock && pod install
```

Alternativ können Sie eine Version eines transitiven Pods aus dem `Podfile` erzwingen:

```ruby
# ios/Podfile -- last resort, use only to unblock while waiting on a plugin release
pod 'GTMSessionFetcher/Core', '3.4.1'
```

Behandeln Sie das als temporären Patch mit Ablaufdatum. Es überschreibt ein Constraint, das der Plugin-Autor bewusst gesetzt hat, und der Build läuft sauber durch, genau bis er zur Laufzeit an einem fehlenden Selektor abstürzt.

Scheitert bereits `flutter pub get`, bevor Sie überhaupt CocoaPods erreichen, liegt ein Auflösungsproblem auf der Dart-Seite vor und kein natives, und die zu lesenden Constraints sind andere: siehe [warum "Version solving failed" ein Beweis und kein Bug ist](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

### 4. Erst dann das Specs-Repository aktualisieren

```bash
# CocoaPods 1.17.0
cd ios && pod install --repo-update
```

Das hilft in genau einer Situation: Sie nutzen ein git-basiertes Specs-Repository (`source 'https://github.com/CocoaPods/Specs.git'` in Ihrem `Podfile`), und Ihr lokaler Klon ist älter als die angeforderte Version. Das von Flutter generierte `Podfile` verwendet standardmäßig die CDN-Quelle, die Versionen pro Pod über HTTP abfragt und in diesem Sinne nie veraltet ist. Haben Sie die `source`-Zeile nicht geändert, ist `--repo-update` eine Leeroperation, die Sie einen vollständigen Specs-Klon kostet.

## Fallstricke und Verwechslungen

**`flutter clean` fasst `Podfile.lock` nicht an.** Es leert `build/` und `.dart_tool/`. `ios/Podfile.lock` und `ios/Pods/` überstehen es unberührt, weshalb "ich habe doch schon flutter clean ausgeführt" die häufigste falsche Fährte bei diesem Fehler ist. Die radikale Variante, die den iOS-Zustand tatsächlich bereinigt:

```bash
# Flutter 3.44.7, CocoaPods 1.17.0
flutter clean
cd ios && pod deintegrate && rm -rf Pods Podfile.lock .symlinks
cd .. && flutter pub get
cd ios && pod install
```

**`arch -x86_64 pod install` ist überholt.** Dieser Workaround stammt aus 2021, als das `ffi`-Gem kein arm64-Binary hatte. CocoaPods 1.17.0 auf Ruby 3.x läuft nativ auf Apple Silicon. Ein vorangestelltes `arch -x86_64` erzwingt heute ein Ruby unter Rosetta, das Ihre Gems womöglich nicht installiert hat, und erzeugt einen völlig anderen Fehler.

**Ein Plugin, das zu SwiftPM gewechselt ist, taucht im Pod-Graphen gar nicht auf.** Seit [Flutter 3.44 den Swift Package Manager zum Standard gemacht hat](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/), werden Plugins mit einer `Package.swift` von SwiftPM aufgelöst, und CocoaPods sieht sie nie. Das ist meist der Grund, warum dieser Fehler nach einem Upgrade verschwindet. Es bedeutet auch, dass ein Konflikt, über den Sie in einer StackOverflow-Antwort von 2024 lesen, möglicherweise nicht mehr reproduzierbar ist, und dass das Fixieren eines Pods in Ihrem `Podfile` für ein bereits migriertes Plugin stillschweigend wirkungslos bleibt. Prüfen Sie, welcher Resolver ein Plugin besitzt, bevor Sie darum herum patchen:

```bash
# Flutter 3.44.7 -- if this file exists, the plugin is on SwiftPM, not CocoaPods
ls ios/Flutter/ephemeral/Packages/FlutterGeneratedPluginSwiftPackage/Package.swift
```

**`Error running pod install` ohne Constraint-Block darunter ist ein anderer Fehler.** Fehlt der eingerückte Abschnitt `In Podfile:`, ist CocoaPods vor der Auflösung gescheitert, meist an einem Ruby- oder Xcode-Toolchain-Problem und nicht an einem Versionskonflikt. Das gehört zur [Checkliste für iOS-Builds mit Xcode 16](/de/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/), nicht hierher.

**Reproduzierbarkeit in der CI.** `ios/Podfile.lock` zu versionieren ist der richtige Standard, führt aber dazu, dass Fall 1 in der CI ausgelöst wird, sobald jemand im Team ein Plugin anhebt, ohne lokal erneut `pod install` auszuführen. Erzwingen Sie entweder, dass beide Lock-Dateien im selben Commit wandern, oder fixieren Sie die Toolchain, damit der Fehlschlag wenigstens deterministisch ist: siehe [wie Sie mehrere Flutter-Versionen aus einer CI-Pipeline heraus ansprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/). Die Android-Seite derselben Problemklasse behandelt [assembleDebug schlägt mit exit code 1 fehl](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

## Die Frist, die man kennen sollte

Das Specs-Repository von CocoaPods Trunk geht am 2026-12-02 dauerhaft in den Nur-Lese-Modus, mit einer Generalprobe vom 2026-11-01 bis zum 2026-11-07. Bestehende Pods lösen weiterhin auf und das CDN liefert weiter aus, Builds brechen also nicht, aber kein Pod wird jemals wieder eine neue Version veröffentlichen. Praktisch heißt das: Nach diesem Datum lässt sich Fall 3 nicht mehr durch Abwarten beheben. Fixieren zwei Plugins inkompatible Versionen eines gemeinsamen Pods und veröffentlicht keines davon vor Dezember einen korrigierten Podspec, kommt kein Upstream-Release mehr zur Rettung, und die einzigen Auswege sind ein Override im `Podfile` oder die Migration des Plugins zu SwiftPM. Beides sollte man jetzt einplanen und nicht im ersten Quartal.

## Quellen

- [CocoaPods Trunk read-only plan](https://blog.cocoapods.org/CocoaPods-Specs-Repo/) (CocoaPods-Blog)
- [Swift Package Manager for Flutter app developers](https://docs.flutter.dev/packages-and-plugins/swift-package-manager/for-app-developers) (docs.flutter.dev)
- [Flutter-Release-Notes](https://docs.flutter.dev/release/release-notes) (docs.flutter.dev)
- [CocoaPods-Releases](https://github.com/CocoaPods/CocoaPods/releases) (CocoaPods/CocoaPods)
- [flutter/flutter#168660: could not find compatible versions for pod Firebase/CoreOnly](https://github.com/flutter/flutter/issues/168660) (flutter/flutter)
- [flutter/flutter#148116: could not find compatible versions for pod GTMSessionFetcher/Core](https://github.com/flutter/flutter/issues/148116) (flutter/flutter)
