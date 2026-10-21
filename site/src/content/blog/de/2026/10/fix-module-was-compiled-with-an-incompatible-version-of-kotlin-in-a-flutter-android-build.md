---
title: "Fix: Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is X, expected version is Y (Flutter Android)"
description: "Eine Abhängigkeit wurde mit einer Kotlin-Version gebaut, die mindestens zwei Minor-Versionen neuer ist als der Compiler Ihres Builds. Erhöhen Sie die Version von org.jetbrains.kotlin.android in settings.gradle.kts auf X minus eins oder höher, oder setzen Sie die Abhängigkeit zurück."
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "kotlin"
  - "gradle"
lang: "de"
translationOf: "2026/10/fix-module-was-compiled-with-an-incompatible-version-of-kotlin-in-a-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-10-21
---

Kurzantwort: Eine Bibliothek im Android-Classpath (sehr oft ein neueres `kotlin-stdlib`, das transitiv eingebunden wird) wurde mit einer Kotlin-Version kompiliert, die mindestens zwei Minor-Releases vor dem Compiler liegt, den Ihr Build tatsächlich ausführt. Der Compiler liest Metadaten nur eine Minor-Version im Voraus. Erhöhen Sie die Version von `org.jetbrains.kotlin.android` in `android/settings.gradle.kts` auf mindestens "X minus eine Minor-Version" (bei Metadaten 2.4.0 also KGP 2.3.x oder neuer) und kompilieren Sie neu. Alles unten wurde mit Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0 und Kotlin-2.4.21-Artefakten reproduziert.

## Der Fehler im Kontext

Bei `flutter build apk` oder `flutter run` schlägt der Task `compileDebugKotlin` (oder `compileReleaseKotlin`) fehl, mit einer Zeile pro Kotlin-Moduldatei im betroffenen Jar:

```text
> Task :app:compileDebugKotlin FAILED
e: file:///Users/me/.gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib/2.4.21/.../kotlin-stdlib-2.4.21.jar!/META-INF/kotlin-stdlib.kotlin_module Module was compiled with an incompatible version of Kotlin. The binary version of its metadata is 2.4.0, expected version is 2.2.0.
e: file:///.../MainActivity.kt:6:19 Unresolved reference 'listOf'.

FAILURE: Build failed with an exception.
* What went wrong:
Execution failed for task ':app:compileDebugKotlin'.
> A failure occurred while executing org.jetbrains.kotlin.compilerRunner.GradleCompilerRunnerWithWorkers$GradleKotlinCompilerWorkAction
   > Compilation error. See log for more details
```

Liegt der fehlerhafte Code in einem Plugin statt in Ihrer App, wird dieselbe Inkompatibilität pro Klasse gemeldet, und die Meldung ist neuer und hilfreicher formuliert:

```text
> Task :shared_preferences_android:compileDebugKotlin FAILED
e: Incompatible classes were found in dependencies. Remove them from the classpath or use '-Xskip-metadata-version-check' to suppress errors
e: .../shared_preferences_android-2.5.1/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt:47:5 Class 'kotlin.Unit' was compiled with an incompatible version of Kotlin. The actual metadata version is 2.4.0, but the compiler version 2.2.0 can read versions up to 2.3.0.
```

Die nachfolgenden "Unresolved reference"-Fehler (`listOf`, `startsWith`, `it`) sind Rauschen. Sobald der Compiler die Standardbibliothek nicht mehr lädt, wird jedes Symbol daraus unauflösbar. Beheben Sie den ersten Fehler, dann verschwinden alle weiteren.

## Warum der Compiler neuere Metadaten ablehnt

Jede Kotlin/JVM-Klassendatei trägt eine `@kotlin.Metadata`-Annotation, und jedes Jar enthält eine Datei `META-INF/*.kotlin_module`. Beide sind mit der Metadaten-Version des Compilers versehen, der sie erzeugt hat. Die [Evolutionsprinzipien](https://kotlinlang.org/docs/kotlin-evolution-principles.html) von Kotlin versprechen Abwärtskompatibilität (ein neuerer Compiler liest alle älteren Binärdateien), aber nur Vorwärtskompatibilität nach bestem Bemühen für das nächste Sprach-Release, "but not later ones". Der Compiler setzt diese Regel sofort durch: Ein 2.2-Compiler akzeptiert Metadaten bis 2.3.0 und lehnt 2.4.0 ab. Genau das sagt die neuere Meldung: "the compiler version 2.2.0 can read versions up to 2.3.0".

Die beiden Zahlen im Fehler bedeuten also:

- **"binary version of its metadata is X"**: die Kotlin-Version, mit der das im Pfad genannte Bibliotheks-Jar kompiliert wurde.
- **"expected version is Y"**: der Kotlin-Compiler, den Ihr Gradle-Build ausführt. Er stammt vom Kotlin Gradle Plugin (KGP) im Build-Classpath. Es ist nicht das in Android Studio installierte Kotlin und nicht zwingend die Version, die Sie eingetragen haben.

In Flutter-Apps ist der Auslöser fast immer einer der folgenden, nach Häufigkeit geordnet:

1. **Ein Update eines Plugins oder einer AndroidX-/Google-Bibliothek** bringt transitiv ein neueres `kotlin-stdlib` mit. Die Konfliktauflösung von Gradle wählt das höchste angeforderte Stdlib, sodass eine einzige moderne Abhängigkeit es für das ganze Modul anhebt.
2. **Das KGP Ihres Projekts ist alt**, typischerweise weil die App vor Jahren erstellt und `settings.gradle.kts` (oder `ext.kotlin_version` in einer `android/build.gradle` aus der Zeit vor 3.16) nie angehoben wurde.
3. **Ein Plugin, das gegen ein neueres Kotlin kompiliert wurde, liefert ein vorgebautes AAR oder Jar** mit Kotlin-Klassen aus (häufig bei Plugins, die ein SDK kapseln, etwa für Karten, Zahlungen und Analytics).

## Minimale Reproduktion

Gehen Sie von einem frischen Flutter-3.44.8-Projekt aus, senken Sie das KGP und fügen Sie eine mit Kotlin 2.4 gebaute Abhängigkeit hinzu:

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1, Gradle 9.1.0
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false // template ships 2.3.20
}
```

```kotlin
// android/app/build.gradle.kts -- Flutter 3.44.8
dependencies {
    // Stands in for any library compiled with Kotlin 2.4.x
    implementation("org.jetbrains.kotlin:kotlin-stdlib:2.4.21")
}
```

```kotlin
// android/app/src/main/kotlin/com/example/kapp/MainActivity.kt -- Kotlin source that touches stdlib
package com.example.kapp

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity() {
    val doubled = listOf(1, 2, 3).map { it * 2 }
}
```

Zwei Details aus der Reproduktion sollten Sie kennen, bevor Sie Versionen ändern.

**Die deklarierte Version ist nicht unbedingt die, die läuft.** Ich habe KGP 2.0.21 deklariert, doch der Fehler nennt "expected version is 2.2.0", und das Flutter Gradle Plugin warnte "Flutter support for your project's Kotlin version (2.2.10) will soon be dropped". AGP 9.0.1 deklariert eine Laufzeitabhängigkeit auf `kotlin-gradle-plugin:2.2.10`, und Gradle löst den Build-Classpath auf die höchste angeforderte Version auf. Ein KGP zu deklarieren, das *unter* dem von AGP mitgebrachten liegt, hat keinerlei Wirkung. Lesen Sie die "expected version" aus dem Fehler, nicht aus Ihrer Settings-Datei.

**Der Fehler tritt nur auf, wenn Kotlin-Code die neueren Klassen berührt.** Mit der üblichen einzeiligen `class MainActivity : FlutterActivity()` baute derselbe Classpath problemlos, weil nichts den Compiler zwang, die Stdlib-Metadaten zu deserialisieren. Erst `listOf(...)` brach den Build. Deshalb erscheint der Fehler oft "aus dem Nichts", nachdem Sie ein paar Zeilen Kotlin in `MainActivity` oder einem Method-Channel-Handler ergänzt haben, obwohl das Abhängigkeits-Update schon Wochen zurückliegt.

## Fix 1: Kotlin Gradle Plugin erhöhen (empfohlen)

Die Regel lautet: Die Minor-Version des KGP muss mindestens der Minor-Version der Bibliotheks-Metadaten minus eins entsprechen. Bei Metadaten 2.4.0 heißt das 2.3.x oder neuer; die exakte Übereinstimmung (2.4.x) ist die sicherste Wahl.

```kotlin
// android/settings.gradle.kts -- Flutter 3.44.8, AGP 9.0.1
plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "9.0.1" apply false
    id("org.jetbrains.kotlin.android") version "2.3.20" apply false
}
```

Mit 2.3.20 kompilierte dieselbe Reproduktion sauber (`BUILD SUCCESSFUL`): Eine Minor-Version Vorlauf genügt. Gehen Sie in dieser Reihenfolge vor:

1. Lesen Sie X aus dem Fehler ("binary version of its metadata is 2.4.0").
2. Öffnen Sie `android/settings.gradle.kts` (oder `settings.gradle`) und setzen Sie die Version von `org.jetbrains.kotlin.android` auf X minus eine Minor-Version oder neuer. Bei Projekten, die vor Flutter 3.16 erstellt wurden, steht die Version in `android/build.gradle` als `ext.kotlin_version = '...'` innerhalb von `buildscript`; ändern Sie sie dort.
3. Prüfen Sie das neue KGP gegen Ihr AGP und Gradle in der [Kompatibilitätstabelle des Kotlin Gradle Plugins](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin). KGP 2.3.20 unterstützt Gradle 7.6.3 bis 9.3.0 und AGP 8.2.2 bis 9.0.0; KGP 2.4.20 benötigt AGP 8.5.2 oder neuer. Ältere Flutter-Projekte mit AGP 7.x müssen AGP und Gradle in derselben Änderung anheben.
4. Führen Sie `flutter clean` aus und kompilieren Sie neu, damit keine gecachten Gradle-Ausgaben des alten Compilers zurückbleiben.

Das Tooling von Flutter 3.44.8 bestätigt das: Das Template liefert KGP 2.3.20, das Flutter Gradle Plugin warnt unter 2.2.20 und bricht unter 2.0.0 mit einem Fehler ab (`warnKGPVersion` und `errorKGPVersion` in `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt`). Wenn Sie noch auf einem Kotlin-1.x-Projekt sind, stoßen Sie mit nahezu jedem aktuellen AndroidX-Release auf diesen Fehler, daher ist dieses Upgrade ohnehin fällig.

## Fix 2: Liegt der Fehler in einem Plugin-Modul, trotzdem in der App beheben

Schlägt der Task `:some_plugin:compileReleaseKotlin` fehl, ist der Reflex, die `build.gradle` des Plugins verantwortlich zu machen. Die Reproduktion zeigt, warum das die falsche Datei ist. `shared_preferences_android` 2.5.1 deklariert in seinem Buildscript ein eigenes KGP:

```kotlin
// ~/.pub-cache/hosted/pub.dev/shared_preferences_android-2.5.1/android/build.gradle.kts (excerpt)
val kotlinVersion = "2.3.0"
classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:$kotlinVersion")
```

Dennoch nannte der Fehler "the compiler version 2.2.0". Plugins sind Teilprojekte des Gradle-Builds Ihrer App, und das KGP, das bereits vom Root-Build geladen wurde (aus `settings.gradle.kts`, möglicherweise von AGP angehoben), kompiliert sie. Die Deklaration des Plugins setzt sich nicht durch. Also:

1. Erhöhen Sie das KGP in der `android/settings.gradle.kts` Ihrer App, genau wie in Fix 1.
2. Wenn das Plugin selbst ein altes Kotlin so festlegt, dass es weiterhin scheitert, aktualisieren Sie das Plugin (`flutter pub upgrade <name>` oder heben Sie seine Einschränkung in `pubspec.yaml` an). Bearbeiten Sie niemals Dateien unter `~/.pub-cache`: `pub get` überschreibt sie.

## Fix 3: Die Abhängigkeit finden und zurücksetzen, die das neuere Kotlin eingeschleppt hat

Manchmal können Sie das KGP gerade nicht anheben (ein Release-Branch, ein eingefrorenes CI-Image). Dann ermitteln Sie, wer das neue Stdlib angefordert hat, und setzen diese Abhängigkeit zurück. Aus dem Ordner `android/`:

```bash
./gradlew :app:dependencyInsight --dependency org.jetbrains.kotlin:kotlin-stdlib --configuration releaseRuntimeClasspath
```

In meiner Reproduktion erklärte der Abschnitt "Selection reasons" die ganze Geschichte in einer Zeile:

```text
- By conflict resolution: between versions 2.4.21, 2.2.10, 1.8.22, 2.0.21, 1.6.21, 1.7.10, 1.8.10, 1.3.20, 1.8.20, 1.9.24, 2.0.0, 1.9.25 and 2.0.20
```

Darunter ist jede Zeile `org.jetbrains.kotlin:kotlin-stdlib:1.x -> 2.4.21` unter der Abhängigkeit eingerückt, die sie angefordert hat. Gehen Sie den Baum nach oben bis zu der, die 2.4.x verlangt, und stufen Sie dann entweder diese Bibliothek oder das Flutter-Plugin herab, das sie mitbringt. Für eine transitive Abhängigkeit eines Plugins führen Sie denselben Befehl gegen das Plugin-Projekt aus (`:plugin_name:dependencyInsight`). Das Zurücksetzen ist eine kurzfristige Maßnahme: Der Autor der Bibliothek ist aus gutem Grund auf das neue Kotlin umgestiegen, und das nächste Update irgendeiner anderen Abhängigkeit bringt Sie wieder hierher.

"Beheben" Sie das Problem nicht, indem Sie `kotlin-stdlib` mit `resolutionStrategy.force(...)` nach unten zwingen. Die Bibliothek wurde gegen die neuere Stdlib-API kompiliert und ruft möglicherweise Funktionen auf, die in der älteren nicht existieren, wodurch aus einem Kompilierfehler ein `NoSuchMethodError` zur Laufzeit wird.

## Fix 4: -Xskip-metadata-version-check (letzter Ausweg)

Die Meldung des Compilers selbst schlägt ein Flag vor, und es funktioniert tatsächlich:

```kotlin
// android/app/build.gradle.kts -- Kotlin compiler option, use only temporarily
kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
        freeCompilerArgs.add("-Xskip-metadata-version-check")
    }
}
```

Damit baute die Reproduktion. Es ist ein `-X`-Flag, also nicht unterstützt, und es schaltet nur die Sicherheitsprüfung ab: Der Compiler liest dann Metadaten in einem Format, das er nicht kennt. Nutzt die neuere Bibliothek ein Sprachmerkmal, das auf eine für Ihren Compiler nicht interpretierbare Weise kodiert ist, erhalten Sie falsche Signaturen oder einen Absturz im Compiler statt eines klaren Fehlers. Außerdem gilt es nur für das Modul, in das Sie es eintragen, ein fehlschlagendes Plugin-Modul würde also weiterhin scheitern. Nutzen Sie es, um einen Hotfix-Build freizugeben, und entfernen Sie es, sobald Sie das KGP anheben.

## Ähnliche Fehler, die hier landen

- **`Your project requires a newer version of the Kotlin Gradle plugin`**: Das ist die Vorabprüfung von Flutter selbst, nicht der Kotlin-Compiler. Sie hat einen anderen Lösungsweg, der im [Beitrag zum Fehler mit der älteren KGP-Version](/de/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/) behandelt wird.
- **`Daemon compilation failed: null`**: ein Absturz der inkrementellen Kompilierung im Kotlin-Daemon, keine Versionsinkompatibilität. Siehe [Daemon compilation failed: null beheben](/de/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/).
- **Kotlin-Fehler direkt nach dem Wechsel auf AGP 9**: Ging der Build beim AGP-Upgrade kaputt und sehen Sie `Cannot add extension with name 'kotlin'`, ist das die Migration auf das integrierte Kotlin. [Die AGP-9-Migrationsanleitung](/de/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) führt Sie hindurch, einschließlich der Erklärung, warum Sie die KGP-Zeile in `settings.gradle.kts` behalten müssen.
- **`Execution failed for task ':app:compileFlutterBuildDebug'` oder ein bloßer `exit code 1`**: Die Zusammenfassungszeile von Flutter verbirgt den eigentlichen Gradle-Fehler. Scrollen Sie nach oben oder starten Sie erneut mit `--verbose`; [die Anleitung zu assembleDebug mit exit code 1](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) zeigt, wo Sie suchen müssen.
- **"Expected version is 1.x" bei einem Projekt, das Sie auf Kotlin 2 wähnen**: Sie lesen die falsche Datei. Suchen Sie nach einem übrig gebliebenen `ext.kotlin_version` in `android/build.gradle` oder nach einem `buildscript`-Block im Root-Projekt, der noch ein altes `kotlin-gradle-plugin` in den Classpath legt.

## Verwandte Beiträge

- [Ein Flutter-Android-Projekt mit integriertem Kotlin auf AGP 9 migrieren](/de/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)
- [Fix: Daemon compilation failed: null in einem Flutter-Android-Gradle-Build](/de/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Fix: Gradle task assembleDebug failed with exit code 1 in Flutter](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Fix: Timeout waiting to lock journal cache in einem Flutter-Android-Build](/de/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## Quellen

- [Kotlin evolution principles: binary compatibility](https://kotlinlang.org/docs/kotlin-evolution-principles.html)
- [Kotlin Gradle plugin: compatibility with Gradle and AGP](https://kotlinlang.org/docs/gradle-configure-project.html#apply-the-plugin)
- [Android Gradle Plugin 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes) (KGP-2.2.10-Laufzeitabhängigkeit)
- [Flutter: Kotlin and Gradle version requirements](https://docs.flutter.dev/release/breaking-changes/kotlin-version)
- [flutter/flutter#179253](https://github.com/flutter/flutter/issues/179253), dieselbe Inkompatibilität, gemeldet mit Metadaten 2.2.0 bei erwarteten 1.8.0
