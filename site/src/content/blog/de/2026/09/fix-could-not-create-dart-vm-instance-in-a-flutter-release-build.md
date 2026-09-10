---
title: "Lösung: Could not create Dart VM instance in einem Flutter-Release-Build nach flutter upgrade"
description: "Das Release-APK wurde ohne libapp.so gebaut. Flutter 3.44.0 bis 3.44.4 konnte es verlieren: Auf 3.44.5 oder neuer aktualisieren und den kombinierten subprojects-Block aufteilen."
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
lang: "de"
translationOf: "2026/09/fix-could-not-create-dart-vm-instance-in-a-flutter-release-build"
translatedBy: "claude"
translationDate: 2026-09-10
---

Ihr Release-Build enthält den kompilierten Dart-Code nicht. Die Engine sucht den AOT-Snapshot in `libapp.so`, findet nichts und kann die VM nicht starten. Nach einem Upgrade auf Flutter 3.44.0 bis 3.44.4 ist die übliche Ursache eine Regression im Gradle-Plugin, die `libapp.so` stillschweigend aus dem APK oder App Bundle entfernt hat. Prüfen Sie das APK mit `unzip -l`, aktualisieren Sie auf Flutter 3.44.5 oder neuer (3.47.3 ist die aktuelle Stable-Version) und teilen Sie den kombinierten `subprojects`-Block in `android/build.gradle` in zwei Blöcke auf.

Alles Folgende wurde gegen den Quellcode von Flutter 3.44.x und 3.47.3 auf GitHub, das Hotfix-Changelog von 3.44 und den Engine-Code geprüft, der diese Zeilen ausgibt.

## Der Fehler, wie logcat ihn ausgibt

```text
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_data.cc(20)] VM snapshot invalid and could not be inferred from settings.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm.cc(253)] Could not set up VM data to bootstrap the VM from.
E/flutter ( 7564): [ERROR:flutter/runtime/dart_vm_lifecycle.cc(85)] Could not create Dart VM instance.
```

Die App beendet sich, bevor `main()` läuft. Unter 3.44 folgt der native Absturz meist in `FlutterJNI.performNativeAttach`. Ältere Engines gaben eine vierte Zeile aus, `[FATAL:flutter/shell/common/shell.cc] Check failed: vm. Must be able to initialize the VM.` Die macOS-Variante dieses Fehlers meldet statt der VM-Snapshot-Zeile `Isolate snapshot invalid and could not be inferred from settings.` in `dart_vm_data.cc(31)`. Sie hat eine andere Ursache, die weiter unten behandelt wird.

Das Muster, das Leute auf diese Seite führt: Debug-Builds und `flutter run` funktionieren, ein frisches `flutter create`-Projekt funktioniert, und der Release-Build der echten App stürzt beim Start ab. Es begann mit nichts als `flutter upgrade`, und ein Downgrade lässt es verschwinden.

## Warum die Engine keinen VM-Snapshot findet

Ein Release-Build enthält weder Dart-Quellcode noch Kernel-Bytecode. `gen_snapshot` kompiliert Ihre App vorab in eine native Shared Library, `libapp.so` unter Android und `App.framework` unter iOS und macOS. Diese Bibliothek exportiert die Symbole für den VM-Snapshot und den Isolate-Snapshot, und die Engine startet aus ihnen.

Die erste Log-Zeile stammt aus `DartVMData::Create` in der Engine. Sie nimmt zuerst den Snapshot, den der Embedder übergeben hat. Fehlt er oder ist er ungültig, greift sie auf `DartSnapshot::VMSnapshotFromSettings` zurück, das die in `settings.application_library_paths` aufgeführten Bibliotheken nach den Snapshot-Symbolen durchsucht. Liefert das nichts, protokolliert sie den Fehler und gibt ein leeres Ergebnis zurück. Die beiden anderen Zeilen sind ihre Aufrufer, die aufgeben. "VM snapshot invalid" bedeutet also fast nie einen beschädigten Snapshot. Es bedeutet, dass es keine AOT-Bibliothek zum Durchsuchen gab.

Damit lautet die Frage: Warum enthält das Paket kein `libapp.so`? Nach Wahrscheinlichkeit geordnet:

1. **Die Gradle-Regression in Flutter 3.44.0 bis 3.44.4.** `libapp.so` fiel in bestimmten Projektstrukturen aus APKs und App Bundles heraus. Das ist die Ursache, die nach `flutter upgrade` auftaucht.
2. **`debuggable true` im Release-Build-Type.** Das Flutter-Gradle-Plugin kompiliert Dart dann im Debug-Modus, sodass überhaupt keine AOT-Bibliothek entsteht.
3. **macOS Big Sur mit einer App, die mit Flutter 3.44 oder neuer gebaut wurde.** Die Bibliothek ist vorhanden, aber der alte dynamische Loader kann die Symbole in der neuen Mach-O-Ausgabe nicht auflösen.

## Bestätigen: ein Blick ins APK

Nicht raten, nachsehen. Das dauert zehn Sekunden:

```bash
# Flutter 3.44.x, Android release build
flutter build apk --release
unzip -Z1 build/app/outputs/flutter-apk/app-release.apk | grep -E 'lib/[^/]+/lib(app|flutter)\.so' | sort
```

Ein gesundes APK listet beide Bibliotheken für jedes ausgelieferte ABI:

```text
lib/arm64-v8a/libapp.so
lib/arm64-v8a/libflutter.so
lib/armeabi-v7a/libapp.so
lib/armeabi-v7a/libflutter.so
lib/x86_64/libapp.so
lib/x86_64/libflutter.so
```

Das APK in [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388), dem Hauptbericht zu dieser Regression, listete `libflutter.so` und `libdartjni.so` für alle drei ABIs und kein einziges `libapp.so`. Diese Asymmetrie ist das Erkennungsmerkmal. `libflutter.so` kommt aus einer AAR-Abhängigkeit und blieb daher erhalten. `libapp.so` kam über einen anderen Weg und ging verloren.

In einem App Bundle liegen die Pfade unter `base/lib/`:

```bash
# Flutter 3.44.x
unzip -Z1 build/app/outputs/bundle/release/app-release.aab | grep 'libapp.so'
```

Mit Flavors enthält der Dateiname den Flavor (`app-prod-release.apk`, `app-prodRelease.aab`). Prüfen Sie jedes ABI, nicht nur arm64. In der Flavor-Variante des Bugs kann ein ABI vorhanden sein und der Rest fehlen.

## Was sich in Flutter 3.44 geändert hat

Vor 3.44 lieferte das Flutter-Gradle-Plugin `libapp.so` in einer Jar-Abhängigkeit aus. Dadurch war es für das Stripping nativer Bibliotheken durch AGP unsichtbar, weshalb [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275) (gemergt am 2026-01-26, ausgeliefert in 3.44.0 am 2026-05-15) es in ein `jniLibs`-Source-Set-Verzeichnis verschob, das das Plugin befüllt. Diese Änderung machte `libapp.so` strippbar, machte die Auslieferung aber auf zwei Arten fragil, wie der Fix [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119) beschreibt:

1. Das `jniLibs`-Verzeichnis wurde bei der Konfiguration von `:app` sofort aufgelöst, von der Copy-Task aber erst später geschrieben. Wurde `:app` ausgewertet, bevor sein Build-Verzeichnis umgeleitet war, waren sich beide uneinig, wo das Build-Verzeichnis lag, und das bereitgestellte `libapp.so` wurde nie zusammengeführt. Das passiert mit dem alten kombinierten `subprojects`-Block plus einem beliebigen Plugin, dessen Gradle-Projektname alphabetisch vor `app` liegt.
2. Die Copy-Task schrieb in das eigene Ausgabeverzeichnis der Flutter-Task. Die überlappenden Ausgaben brachen die Up-to-date-Prüfungen von Gradle. In einem Projekt mit Flavors hinterließ ein `flutter run` auf einem Gerät (ein ABI), gefolgt von einem vollständigen `flutter build appbundle`, die übrigen ABIs ohne `libapp.so` ([#187388](https://github.com/flutter/flutter/issues/187388)). Ein verwandter Bericht zeigte inkrementelle Flavor-Builds, die das `libapp.so` des vorherigen Builds auslieferten ([#187553](https://github.com/flutter/flutter/issues/187553)).

App Bundles schlugen deutlicher fehl. Dieselbe fehlende Bibliothek zeigt sich zur Build-Zeit als `Release app bundle failed to strip debug symbols from native libraries` ([#186810](https://github.com/flutter/flutter/issues/186810)). APKs haben diese Prüfung nicht, sie bauen also sauber und stürzen auf dem Gerät ab.

## Minimales Repro für den subprojects-Auslöser

Diese Struktur hat das Flutter-Team im Integrationstest `gradle_libapp_so_packaging_test.dart` festgehalten, der mit dem Fix ausgeliefert wird. Ein Root-`android/build.gradle` aus einem älteren Template, mit beiden Anweisungen in einem Block:

```groovy
// android/build.gradle, pre-2021 template shape, broken on Flutter 3.44.0 to 3.44.4
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
    project.evaluationDependsOn(':app')
}
```

Fügen Sie ein beliebiges Plugin mit nativem Android-Code hinzu, dessen Name vor `app` einsortiert wird, etwa `android_intent_plus`, bauen Sie mit `flutter build apk --release` unter 3.44.4, und das APK enthält kein `libapp.so`. `subprojects {}` iteriert alphabetisch über die Projekte. `evaluationDependsOn(':app')` greift schon beim ersten Plugin und erzwingt die Konfiguration von `:app`, bevor die Schleife es erreicht und sein `buildDir` umgeleitet hat.

## Lösung 1: auf Flutter 3.44.5 oder neuer aktualisieren

Der Fix landete am 2026-06-23 in master und wurde per Cherry-Pick in [Flutter 3.44.5](https://github.com/flutter/flutter/releases/tag/3.44.5) (2026-07-06) übernommen. Der Changelog-Eintrag zu 3.44.5 lautet: "When building Android app bundles using flavors, or with an old app template combined with a plugin coming alphabetically before app, fixes problems with failing to include libapp.so." Das Plugin stellt `libapp.so` jetzt über eine eigene `CopyFlutterJniLibsTask` bereit und registriert die Ausgabe über die Variant-API von AGP, `variant.sources.jniLibs.addGeneratedSourceDirectory(...)`. AGP verwaltet damit die Task-Abhängigkeit und löst den Pfad verzögert auf, unabhängig von der Auswertungsreihenfolge.

```bash
# upgrade to current stable (3.47.3 as of 2026-09-10)
flutter upgrade
flutter --version

# clear the stale intermediates that the broken versions left behind
flutter clean
flutter pub get
flutter build apk --release
```

Führen Sie danach die `unzip`-Prüfung erneut aus, bevor Sie ausliefern. Wer auf der 3.44-Linie bleiben muss: 3.44.5 bis 3.44.9 enthalten den Fix alle. Unter 3.44.0 bis 3.44.4 hilft `flutter clean` allein nur beim Flavor-Auslöser, und auch nur bis zum nächsten `flutter run` auf einem einzelnen Gerät. Gegen den subprojects-Auslöser bewirkt es nichts.

Wenn Sie Flutter in der CI mit FVM oder einer `.flutter-version`-Datei festpinnen, heben Sie auch diesen Pin an. Ein lokales `flutter upgrade` ändert nicht die Version, mit der Ihre Pipeline baut, und so erreicht ein Absturz, der "auf meinem Rechner behoben" ist, trotzdem den Play Store. Pinnen bleibt die richtige Idee, wie im [Beitrag über reproduzierbare Flutter-Builds](/de/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/) begründet. Verschieben Sie den Pin nur bewusst.

## Lösung 2: den kombinierten subprojects-Block aufteilen

Tun Sie das auch nach dem Upgrade. Der kombinierte Block wurde vor Jahren aus dem Template entfernt ([flutter/flutter#91030](https://github.com/flutter/flutter/pull/91030)), weil er Reihenfolgefehler verursachte, und ein Flutter-Maintainer merkte in [#186810](https://github.com/flutter/flutter/issues/186810) an, dass die kombinierte Syntax vermutlich weiterhin nicht allgemein unterstützt wird, auch wenn die Wechselwirkung aus 3.44 behoben ist. Die Root-`build.gradle.kts` des `android-kotlin`-Templates von Flutter 3.47.3 sieht so aus:

```kotlin
// android/build.gradle.kts, Flutter 3.47.3 app template
val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)
}
subprojects {
    project.evaluationDependsOn(":app")
}
```

Wer noch Groovy verwendet, schreibt das Äquivalent:

```groovy
// android/build.gradle, Groovy equivalent of the Flutter 3.47.3 template
rootProject.buildDir = "../build"

subprojects {
    project.buildDir = "${rootProject.buildDir}/${project.name}"
}
subprojects {
    project.evaluationDependsOn(':app')
}
```

Zwei Blöcke bedeuten, dass das Build-Verzeichnis jedes Projekts umgeleitet ist, bevor irgendetwas die Auswertung von `:app` erzwingt. Prüfen Sie auch auf Überbleibsel wie einen dritten Block `subprojects { afterEvaluate { ... compileSdkVersion ... } }`, der Werte in Plugins erzwingt. Solche Blöcke stammen aus alten Stack-Overflow-Workarounds und verursachen gern den nächsten Fehler beim Gradle-Upgrade. Wenn Gradle tatsächlich fehlschlägt statt still, [steht der eigentliche Fehler meist oberhalb der Exit-Code-Zeile](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

## Lösung 3: debuggable true aus dem Release-Build-Type entfernen

Diese Ursache ist älter als 3.44 und besteht auch in 3.47.3 noch. Das Flutter-Gradle-Plugin wählt den Dart-Build-Modus anhand des Android-Build-Types in `FlutterPluginUtils.buildModeFor`:

```kotlin
// Flutter 3.47.3, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun buildModeFor(buildType: BuildType): String {
    if (buildType.name == "profile") {
        return "profile"
    } else if (buildType.isDebuggable) {
        return "debug"
    }
    return "release"
}
```

Diese Konfiguration kompiliert Ihren Dart-Code also im Debug-Modus, ohne `libapp.so`, während der Rest der Pipeline weiterhin eine Release-Engine erwartet:

```kotlin
// android/app/build.gradle.kts, Flutter 3.47.3: this crashes on launch
android {
    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("release")
            isDebuggable = true // makes buildModeFor() return "debug"
        }
    }
}
```

Das Ergebnis sind dieselben drei Log-Zeilen. Der Bericht dazu ist [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126), weiterhin offen. Entfernen Sie `isDebuggable = true` (`debuggable true` in Groovy) aus `release`. Wenn Sie damit einen nativen Debugger an einen signierten Build anhängen wollten, verwenden Sie `flutter build apk --profile`, oder legen Sie dafür einen eigenen Build-Type an und akzeptieren Sie, dass er Dart im JIT-Modus ausführt. Ein eigener Build-Type wie `staging` ohne `isDebuggable` bekommt Dart im Release-Modus, und genau das wollen Sie dort.

## Die Variante unter macOS Big Sur: Isolate snapshot invalid

Wenn das Log `Isolate snapshot invalid and could not be inferred from settings.` meldet und der Rechner unter macOS 11 Big Sur läuft, ist die Bibliothek vorhanden und im Paket fehlt nichts. Seit Flutter 3.44 wird `App.framework` unter iOS und macOS direkt von `gen_snapshot` geschrieben (`--snapshot_kind=app-aot-macho-dylib`), statt von `ld64` gelinkt zu werden. Die neue Dylib hat weder einen Exports-Trie noch ein Inhaltsverzeichnis. Der dyld von Big Sur (dyld-832) greift dann auf eine binäre Suche über die Symboltabelle zurück, deren Voraussetzungen die neue Ausgabe nicht erfüllt. Einige Snapshot-Symbole werden aufgelöst, andere nicht, sodass der VM-Snapshot lädt und der Isolate-Snapshot scheitert. Der dyld von Monterey verwendet in diesem Fall eine lineare Suche und lädt dasselbe Binary problemlos.

Das wurde in [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) und [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051) untersucht und wird nicht behoben. Flutter 3.47 führt Big Sur (11) und älter auf der [Seite der unterstützten Plattformen](https://docs.flutter.dev/reference/supported-platforms) als nicht unterstützt, und das Flutter-Team portiert per Cherry-Pick nicht in alte Stable-Linien zurück. Ihre Optionen: für Builds, die auf Big Sur laufen müssen, bei Flutter 3.41.x bleiben, oder `MACOSX_DEPLOYMENT_TARGET` auf 12.0 anheben und diese Nutzer aufgeben. Ein Community-Workaround sortiert die Einträge der Symboltabelle nach dem Build um und signiert das Framework neu. Ein Dart-Maintainer sagte später, die zugrunde liegende Analyse sei teilweise falsch (es fehlt das Inhaltsverzeichnis, nicht die Symbolreihenfolge), daher würde ich das nicht ausliefern.

Was Ihr Build erzeugt hat, lässt sich mit `nm` prüfen:

```bash
# Flutter 3.47.3, macOS release build
flutter build macos --release
nm -p build/macos/Build/Products/Release/*.app/Contents/Frameworks/App.framework/App | grep kDart
```

## Ähnliche Fehler, die nicht dieser Bug sind

- Ein iOS-Debug-Build, der beim Start mit `mprotect failed: 13 (Permission denied)` stirbt, ist ebenfalls ein Scheitern der Dart-VM, aber im JIT-Modus unter iOS 26. Dafür gibt es [eine eigene Lösung: Upgrade auf Flutter 3.35 oder neuer](/de/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/).
- Ein Release-Build, der normal startet und sich danach falsch verhält, ist über diesen Punkt längst hinaus: Die VM ist gestartet. Wenn etwa die Firebase-Anmeldung nur im Release verloren geht, liegt es an einer anderen `google-services.json`, einer abgelehnten Token-Aktualisierung oder App Check. Siehe [die Lösung für Firebase Auth nur im Release](/de/2026/08/fix-firebase-auth-sign-in-does-not-persist-in-a-flutter-android-release-build/).
- Wenn in einer App mit Flavors `appFlavor` nach einem Hot Restart `null` wird, ist das eine Lücke in `flutter attach`, kein Paketierungsproblem. Siehe [appFlavor nach einem Hot Restart befüllt halten](/de/2026/09/how-to-keep-appflavor-populated-after-a-hot-restart-with-flutter-attach/).
- Add-to-App-Module, die als AAR gebaut werden, können dieselben drei Zeilen zeigen, wenn das AAR in einem anderen Modus oder aus einem veränderten Flutter-Checkout gebaut wurde ([#114881](https://github.com/flutter/flutter/issues/114881)). Bauen Sie das AAR mit `flutter build aar` aus einem unveränderten SDK neu und prüfen Sie den Ordner `jni/` des AAR auf `libapp.so`.

## Verwandte Beiträge

- Was sich in der Version, die die Regression einführte, sonst noch geändert hat: [Flutter 3.44 und SwiftPM als Standard](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).
- Gradle-Fehler, die den Build tatsächlich scheitern lassen: [Gradle task assembleDebug failed with exit code 1](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- Warum das Pinnen von Flutter wichtig ist und warum man den Pin bewusst verschieben muss: [reproduzierbare Flutter-Builds](/de/2026/01/flutter-3-38-6-and-the-engine-version-bump-reproducible-builds-get-easier-if-you-pin-it/).
- Der andere Startabsturz der Dart-VM: [mprotect permission denied unter iOS](/de/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/).

## Quellen

- [flutter/flutter#187388](https://github.com/flutter/flutter/issues/187388), der Bericht zu 3.44.1 mit der APK-Auflistung, die das Fehlen von `libapp.so` in jedem ABI zeigte.
- [flutter/flutter#188119](https://github.com/flutter/flutter/pull/188119), der Fix, mit der Ursachenanalyse für beide Auslöser.
- [flutter/flutter#181275](https://github.com/flutter/flutter/pull/181275), die Änderung, die `libapp.so` aus einem Jar herausnahm.
- [flutter/flutter#186810](https://github.com/flutter/flutter/issues/186810) und [#187553](https://github.com/flutter/flutter/issues/187553), die Varianten mit App Bundle und veraltetem Flavor.
- [Flutter-CHANGELOG, Hotfix 3.44.5](https://github.com/flutter/flutter/blob/stable/CHANGELOG.md), der alle drei Issues aufführt.
- [flutter/flutter#54126](https://github.com/flutter/flutter/issues/54126), `debuggable true` in einem Release-Build-Type.
- [flutter/flutter#189183](https://github.com/flutter/flutter/issues/189183) und [dart-lang/sdk#64051](https://github.com/dart-lang/sdk/issues/64051), der Ladefehler von `App.framework` unter Big Sur.
- Quellcode der Flutter-Engine, `engine/src/flutter/runtime/dart_vm_data.cc` und `dart_snapshot.cc` auf dem Branch `stable`, als Herkunft der Log-Zeilen.
