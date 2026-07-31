---
title: "Fix: Gradle task assembleDebug failed with exit code 1 bei einem Flutter-Android-Build"
description: "Diese Zeile ist eine Hülle, nicht der Fehler. Starten Sie erneut mit flutter run --verbose oder ./gradlew assembleDebug --stacktrace, lesen Sie den echten Gradle-Fehler und beheben Sie diesen."
pubDate: 2026-07-31
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "dart"
lang: "de"
translationOf: "2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter"
translatedBy: "claude"
translationDate: 2026-07-31
---

Die Lösung in einem Satz: `Gradle task assembleDebug failed with exit code 1` ist kein Fehler, sondern Flutters Meldung, dass Gradle mit einem Exit-Code ungleich null beendet wurde. Der eigentliche Fehler steht darüber und wird fast immer aus der Konsole gekürzt. Starten Sie erneut mit `flutter run --verbose`, oder wechseln Sie nach `android/` und führen Sie `./gradlew assembleDebug --stacktrace` aus, und beheben Sie das, was Gradle tatsächlich unter `* What went wrong:` meldet. Im Juli 2026 lautet die häufigste Antwort: das integrierte Kotlin des Android Gradle Plugin 9 kollidiert mit dem alten `kotlin-android`-Plugin, was als `Cannot add extension with name 'kotlin'` erscheint.

```text
FAILURE: Build failed with an exception.

BUILD FAILED in 47s
Running Gradle task 'assembleDebug'...                             48.2s
Error: Gradle task assembleDebug failed with exit code 1
```

Dieser Leitfaden bezieht sich auf Flutter 3.44.7 und Dart 3.12.2, den Stable-Kanal mit Stand 2026-07-20, mit Hinweisen zu Android Gradle Plugin (AGP) 8.x und 9.x, Gradle 8.13 sowie JDK 17 und 21. Das Diagnoseverfahren hat sich seit Jahren nicht geändert; die unten aufgeführten Ursachen schon, und die erste ist seit dem AGP-9-Rollout neu.

## Warum die Meldung nichts aussagt

`assembleDebug` ist ein Android-Gradle-Task. Das Flutter-Tool ruft den Gradle-Wrapper im Verzeichnis `android/` Ihres Projekts auf, leitet die Ausgabe weiter und prüft anschließend den Exit-Code. Ist der Code ungleich null, gibt das Tool genau eine Zeile aus: den Task-Namen und den Exit-Code. Es weiß nicht, was schiefging, denn Gradle-Fehler sind nicht typisiert, sondern Text.

Zwei Dinge arbeiten dann gegen Sie:

1. Das Flutter-Tool filtert Gradles Ausgabe. Es blendet das laute Geplapper der Konfigurationsphase aus, damit ein normaler Build sauber aussieht, und verwirft dabei manchmal genau den Block, den Sie brauchen.
2. Gradle selbst kürzt. Ohne `--stacktrace` wird eine drei Ebenen tiefe `Caused by:`-Kette zu einer einzigen Zeile zusammengefasst, die das verursachende Plugin womöglich nicht nennt.

Der erste Schritt ist also niemals Raten. Er besteht darin, den Build die Wahrheit ausgeben zu lassen.

## Holen Sie sich den echten Fehler, bevor Sie etwas ändern

Führen Sie diese Befehle der Reihe nach aus und hören Sie beim ersten auf, der einen `* What went wrong:`-Block mit Task und Ursache liefert:

```bash
# Flutter 3.44.7, Dart 3.12.2
flutter run --verbose
```

Bleibt das undurchsichtig, umgehen Sie das Flutter-Tool vollständig und sprechen Sie direkt mit Gradle. Diesen Schritt überspringen die meisten, und er ist der, der funktioniert:

```bash
# From the Flutter project root. Use gradlew.bat on Windows.
cd android
./gradlew assembleDebug --stacktrace --info
```

Gradle gibt nun den vollständigen Fehler samt verursachendem Modul aus:

```text
* What went wrong:
A problem occurred configuring project ':file_picker'.
> Failed to apply plugin 'kotlin-android'.
   > Cannot add extension with name 'kotlin', as there is an extension
     already registered with that name.
```

Das ist ein echter, behebbarer Fehler. `Gradle task assembleDebug failed with exit code 1` war es nie.

Eine weitere Diagnose lohnt sich, bevor Sie eine einzige Gradle-Datei anfassen, denn sie fängt eine ganze Ursachenklasse für sich ab:

```bash
# Validates the Java, Gradle, and AGP versions against each other
flutter analyze --suggestions
```

Der [Android Java Gradle migration guide](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide) dokumentiert diesen Validator: Er bewertet JDK, Gradle-Wrapper und AGP-Version als Tripel und nennt Ihnen, welcher Wert außerhalb des zulässigen Bereichs liegt.

## Ursache 1: das integrierte Kotlin von AGP 9 gegen das `kotlin-android`-Plugin

Dies ist 2026 die dominierende Ursache und die am häufigsten falsch diagnostizierte, weil sie während Gradles Konfigurationsphase auslöst, bevor eine einzige Zeile Dart oder Kotlin kompiliert wird.

AGP 9.0 liefert integrierte Kotlin-Unterstützung mit und registriert automatisch eine Gradle-Erweiterung namens `kotlin`. Jedes Modul, das noch das alte Kotlin Gradle Plugin (`kotlin-android`, auch bekannt als KGP) anwendet, versucht eine zweite Erweiterung unter demselben Namen zu registrieren, und Gradle verweigert das:

```text
Cannot add extension with name 'kotlin', as there is an extension
already registered with that name.
```

Das in `A problem occurred configuring project ':x'` genannte Modul zeigt, ob der Verursacher Ihre eigene App ist oder ein Paket, von dem Sie abhängen. Handelt es sich um ein Plugin-Paket wie `file_picker` oder `wakelock_plus`, können Sie das nicht in Ihren eigenen Build-Dateien beheben; entweder Sie aktualisieren das Paket oder Sie schalten das integrierte Kotlin ab.

Der Notausgang steht laut dem [Migrationsleitfaden zu integriertem Kotlin für App-Entwickler](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers) in `android/gradle.properties`:

```properties
# android/gradle.properties -- Flutter 3.44, AGP 9.x
android.newDsl=false
android.builtInKotlin=false
```

Das stellt das Verhalten vor AGP 9 für den gesamten Build wieder her, und Flutters temporärer KGP-Shim hält das alte Plugin funktionsfähig. Das verschafft Zeit, ist aber kein Ziel. Flutter hat [das Entfernen der KGP-Unterstützung](https://github.com/flutter/flutter/issues/184837) und [das Entfernen des alten AGP-DSL](https://github.com/flutter/flutter/issues/184839) für eine künftige Version eingeplant.

Die eigentliche Migration besteht, sobald alle von Ihnen genutzten Plugins AGP 9 unterstützen, darin, das Plugin und den `kotlinOptions`-Block aus `android/app/build.gradle.kts` zu löschen:

```kotlin
// android/app/build.gradle.kts -- AGP 9.0+, Flutter 3.47+
plugins {
    id("com.android.application")
    // id("kotlin-android")  <-- delete this line
}

android {
    // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <-- delete this block
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}
```

Anschließend setzen Sie das Flag um:

```properties
# android/gradle.properties
android.builtInKotlin=true
```

Beachten Sie die Mindestversionen. Flutter 3.44 hob das minimal unterstützte KGP auf 2.0.0 an, und die Dokumentation nennt Flutter 3.47 oder neuer als Voraussetzung dafür, integriertes Kotlin zu aktivieren. Unter 3.44 stable ist der richtige Schritt `android.builtInKotlin=false` plus ein Paket-Update, keine halbfertige Migration. Beschwert sich Ihr Build stattdessen, das Kotlin-Plugin selbst sei zu alt, ist das ein anderer Fehler mit einer anderen Lösung, behandelt unter [dem Versionsfehler des Kotlin Gradle Plugin](/de/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/).

## Ursache 2: Ihr JDK und Ihr Gradle-Wrapper sind sich uneinig

Die Signatur ist eine Class-File-Major-Version:

```text
Caused by: org.codehaus.groovy.control.MultipleCompilationErrorsException: startup failed:
...
Unsupported class file major version 65
```

Major-Version 61 steht für Java 17, 65 für Java 21. Die Zahl nennt das JDK, das den Build ausführt; der Fehler besagt, dass Ihr Gradle-Wrapper zu alt ist, um dessen Bytecode zu verstehen. Gradle-Versionen vor 7.3 laufen unter Java 17 überhaupt nicht, und jede Gradle-Version hat ihre eigene Obergrenze für das neueste akzeptierte JDK.

Am härtesten trifft das, wenn Sie gar nichts geändert haben: Android Studio aktualisierte sich, sein mitgeliefertes JDK sprang von 17 auf 21, und Ihr fünf Jahre alter Gradle-Wrapper war über Nacht kaputt.

Prüfen Sie, welches JDK Flutter verwendet:

```bash
flutter doctor -v
```

Danach heben Sie entweder den Wrapper an:

```bash
# From android/. Pick the version flutter analyze --suggestions recommends.
./gradlew wrapper --gradle-version=8.13
```

Oder Sie binden Flutter an ein JDK, mit dem der Wrapper umgehen kann:

```bash
# macOS example. /usr/libexec/java_home -V lists installed JDKs.
flutter config --jdk-dir=/opt/homebrew/Cellar/openjdk@17/17.0.13/libexec/openjdk.jdk/Contents/Home
```

Bevorzugen Sie es, Gradle nach vorne zu bewegen. Ein altes JDK festzunageln ist eine Entscheidung, für die Sie beim nächsten AGP-Sprung erneut bezahlen.

## Ursache 3: NDK-Versionskonflikt zwischen Plugins

Jedes Paket mit nativem Code deklariert eine NDK-Version. Widersprechen zwei davon der Konfiguration Ihrer App, bricht der Build ab:

```text
* What went wrong:
Execution failed for task ':app:configureCMakeDebug[arm64-v8a]'.
> [CXX1101] NDK at .../ndk/26.3.11579264 did not have a source.properties file
```

Oder, expliziter:

```text
Your project is configured with Android NDK 26.3.11579264, but the following
plugin(s) depend on a different Android NDK version:
- path_provider_android requires Android NDK 27.0.12077973
```

NDK-Releases sind abwärtskompatibel, deshalb besteht die Lösung darin, die höchste von einer Abhängigkeit geforderte Version zu übernehmen:

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44
android {
    ndkVersion = "27.0.12077973"
}
```

Nennt der Fehler eine fehlende `source.properties`, existiert das genannte NDK-Verzeichnis zwar, ist aber ein unvollständiger Download. Löschen Sie dieses Verzeichnis im Ordner `ndk/` Ihres Android SDK, installieren Sie die Version über den SDK Manager neu und führen Sie dann `flutter clean` aus.

## Ursache 4: ein Plugin hebt minSdkVersion über Ihre an

Das Manifest-Merging findet innerhalb von `assembleDebug` statt, deshalb erscheint ein SDK-Level-Konflikt als dieselbe generische Hülle:

```text
* What went wrong:
Execution failed for task ':app:processDebugMainManifest'.
> Manifest merger failed : uses-sdk:minSdkVersion 21 cannot be smaller than
  version 23 declared in library [:some_plugin]
```

Heben Sie die Untergrenze an, statt das Merging mit `tools:overrideLibrary` zu unterdrücken, was den Absturz nur auf die Laufzeit der ausgeschlossenen Geräte verschiebt:

```kotlin
// android/app/build.gradle.kts
android {
    defaultConfig {
        minSdk = 23
    }
}
```

Dieselbe Fehlerform mit einem konkreten Paket wird im Beitrag zu [background_fetch und minSdkVersion 21](/de/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) durchgespielt. Beschwert sich der Merger stattdessen über doppelte Support-Library-Klassen, liegt ein ganz anderes Problem vor: siehe [den AndroidX-Konflikt bei einem Flutter-Android-Build](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/).

## Ursache 5: einem ungepflegten Plugin fehlt der Namespace

AGP 8.0 machte die Eigenschaft `namespace` verpflichtend und liest `package` nicht mehr aus der `AndroidManifest.xml`. Ein Paket, das seit AGP 7 nichts mehr veröffentlicht hat, scheitert in der Konfiguration:

```text
* What went wrong:
A problem occurred configuring project ':some_old_plugin'.
> Namespace not specified. Specify a namespace in the module's build file.
```

Es gibt keinen unterstützten Weg, aus Ihrer App heraus einen Namespace in ein fremdes Paket einzuschleusen. In der Reihenfolge der Präferenz: Paket aktualisieren, ersetzen, oder forken und `namespace 'com.example.some_old_plugin'` in dessen `android/build.gradle` ergänzen. Skripte, die Dateien unter `~/.pub-cache` umschreiben, kursieren für diesen Fehler weit und sind eine Falle: Der Cache wird neu erzeugt, die Korrektur verschwindet also auf der nächsten Maschine und in der CI.

## Ursache 6: nichts ist kaputt außer dem Zustand auf der Festplatte

Nicht jeder Exit-Code 1 ist ein Konfigurationsproblem. Ein halb geschriebenes Artefakt in `build/`, ein Gradle-Daemon mit veraltetem Klassenpfad oder ein `.dart_tool`-Verzeichnis aus einer anderen SDK-Version erzeugen Fehler, die strukturell aussehen und es nicht sind. Räumen Sie vor einer langen Debug-Sitzung die billigen Fälle ab:

```bash
flutter clean
cd android && ./gradlew --stop && ./gradlew clean && cd ..
flutter pub get
flutter run
```

Kompiliert es danach, lag ein veralteter Zustand vor und es gibt nichts weiter zu beheben. Scheitert unterwegs ein `pub get`, ist die Ausgabe des Constraint-Solvers eine eigene Diagnoseübung, behandelt unter [einen version solving failed-Fehler in pubspec.yaml lesen](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/).

## Varianten, die versehentlich auf dieser Seite landen

- **`Gradle task assembleRelease failed with exit code 1`**: dieselbe Hülle um die Release-Variante. Alles oben Genannte gilt, dazu R8 und das Shrinking, die nur im Release laufen. Baut Debug und Release nicht, setzen Sie zuerst `isMinifyEnabled = false`, um R8 als Verursacher zu bestätigen, und ergänzen Sie dann die fehlenden Keep-Regeln, statt das Shrinking abgeschaltet zu lassen.
- **`Gradle task assembleDebug failed with exit code 1` sofort, in unter zwei Sekunden**: das ist kein Kompilierfehler. Gradle konnte nicht starten. Prüfen Sie die Wrapper-Distributions-URL in `android/gradle/wrapper/gradle-wrapper.properties` und Ihren Netzwerkzugriff auf `services.gradle.org`.
- **`Execution failed for task ':app:checkDebugAarMetadata'`**: eine Abhängigkeit verlangt ein höheres `compileSdk`, als Ihre App deklariert. Heben Sie `compileSdk` in `android/app/build.gradle.kts` an; es ist eine Compile-Zeit-Obergrenze, kein Laufzeitziel, das Anheben ändert also nichts am Verhalten auf dem Gerät.
- **Der Fehler tritt nur in der CI auf**: Vergleichen Sie JDK-, Android-SDK- und NDK-Versionen des Runners mit denen Ihrer Maschine. Ursache 2 und Ursache 3 erklären nahezu alle Meldungen der Art "lokal grün, CI rot", und beide sind umgebungsgeformt, nicht codegeformt.
- **Der Fehler erschien nach einem Flutter-Upgrade**: Sehen Sie den Breaking-Changes-Index der Version durch, bevor Sie das Symptom debuggen. Ein Framework-Sprung, der auch die Template-Versionen von AGP und Gradle bewegt, kann mehrere der obigen Ursachen gleichzeitig auslösen, genau wie ein [Upgrade von Flutter 2 auf Flutter 3](/de/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).

Die allgemeine Lehre reicht über diese eine Meldung hinaus. Immer wenn ein Flutter-Build-Fehler einen Gradle-Task und einen Exit-Code nennt, ist das Tool nur der Bote. Wechseln Sie nach `android/`, führen Sie den Task selbst mit `--stacktrace` aus und lesen Sie den Block unter `* What went wrong:`. Die Lösung steht immer in diesem Block und nie in der Zeile, die Flutter ausgegeben hat.

## Verwandt

- [Fix: AndroidX-Konflikt bei einem Flutter-Android-Build](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/) -- die Duplicate-Class-Variante eines Konfigurationsfehlers und warum AGP 8 sie durch das Abschalten von Jetifier zurückbrachte.
- [Flutter: Ihr Projekt benötigt eine neuere Version des Kotlin Gradle Plugin](/de/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) -- die KGP-Mindestversion, ein anderer Fehler als die AGP-9-Erweiterungskollision oben.
- [Fix: background_fetch benötigt minSdkVersion 21](/de/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) -- ein durchgerechnetes Beispiel des SDK-Konflikts beim Manifest-Merging aus Ursache 4.
- [Fix: Version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/) -- was zu tun ist, wenn das `flutter pub get` der Aufräumsequenz selbst scheitert.
- [Eine Flutter-2-App auf Flutter 3.x migrieren: Null-Safety-Checkliste](/de/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) -- der größere Upgrade-Pfad, der mehrere dieser Gradle-Ursachen auf einmal auslöst.

## Quellen

- [Android Java Gradle migration guide](https://docs.flutter.dev/release/breaking-changes/android-java-gradle-migration-guide), Flutter-Dokumentation
- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin), Flutter-Dokumentation
- [Built-in Kotlin migration for app developers](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), Flutter-Dokumentation
- [Flutter maintained plugins should support AGP 9.0](https://github.com/flutter/flutter/issues/181383), flutter/flutter
- [Gradle Java compatibility matrix](https://docs.gradle.org/current/userguide/compatibility.html#java), Gradle-Dokumentation
- [Android Gradle Plugin release notes](https://developer.android.com/build/releases/gradle-plugin), Android Developers
