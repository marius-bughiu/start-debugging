---
title: "Lösung: e: Daemon compilation failed: null in einem Flutter-Android-Gradle-Build"
description: "Unter Windows schlägt die inkrementelle Kotlin-Kompilierung fehl, wenn das Flutter-Projekt und der Pub-Cache auf verschiedenen Laufwerken liegen. Verschieben Sie PUB_CACHE auf das Laufwerk des Projekts oder schalten Sie IC für Plugins aus dem Pub-Cache ab."
pubDate: 2026-09-25
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
lang: "de"
translationOf: "2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build"
translatedBy: "claude"
translationDate: 2026-09-25
---

Der Fehler tritt unter Windows auf, wenn Ihr Flutter-Projekt auf einem Laufwerk liegt (`D:\`) und der Pub-Cache auf einem anderen (`C:\Users\<you>\AppData\Local\Pub\Cache`). Der inkrementelle Compiler von Kotlin speichert jede Plugin-Quelldatei als Pfad relativ zu Ihrem Ordner `android\`. Von `D:\` nach `C:\` gibt es keinen relativen Pfad, daher stürzt `compileDebugKotlin` bei Plugins wie `shared_preferences_android` ab. Die beste Lösung ist, `PUB_CACHE` auf dasselbe Laufwerk wie Ihre Projekte zu legen und danach `flutter clean` und `flutter pub get` auszuführen. Wenn das nicht geht, setzen Sie `kotlin.incremental=false` nur für die Plugin-Unterprojekte (Snippet weiter unten). Mit dem Kotlin Gradle Plugin 2.3.0 und älter wird die APK trotzdem gebaut, und der Fehler ist nur Rauschen. Ab KGP 2.3.20 (Template von Flutter 3.44) und KGP 2.4.0 (Flutter 3.47) kann der Build komplett fehlschlagen.

Die folgenden Versionen wurden geprüft mit Flutter 3.47.5 (Dart 3.13.4, AGP 9.1.0, Gradle 9.3.1, KGP 2.4.0), `shared_preferences` 2.5.5 / `shared_preferences_android` 2.4.28 sowie dem Quellcode des Kotlin Gradle Plugin an den Tags `v1.9.22` bis `v2.4.20`.

## Der Fehler im Kontext

Die Berichte in [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) und [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) sehen alle so aus, einmal pro Plugin:

```text
e: Daemon compilation failed: null
java.lang.Exception
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:69)
	at org.jetbrains.kotlin.daemon.common.CompileService$CallResult$Error.get(CompileService.kt:65)
	at org.jetbrains.kotlin.compilerRunner.GradleKotlinCompilerWork.compileWithDaemon(GradleKotlinCompilerWork.kt:244)
	...
Caused by: java.lang.AssertionError: java.lang.Exception: Could not close incremental caches in
  D:\src\my_app\build\shared_preferences_android\kotlin\compileReleaseKotlin\cacheable\caches-jvm\jvm\kotlin:
  class-fq-name-to-source.tab, source-to-classes.tab, internal-name-to-source.tab
	at org.jetbrains.kotlin.incremental.IncrementalCachesManager.close(IncrementalCachesManager.kt:55)
	...
	Suppressed: java.lang.IllegalArgumentException: this and base files have different roots:
	  C:\Users\me\AppData\Local\Pub\Cache\hosted\pub.dev\shared_preferences_android-2.4.28\android\src\main\kotlin\io\flutter\plugins\sharedpreferences\LegacySharedPreferencesPlugin.kt
	  and D:\src\my_app\android.
```

In der obersten Zeile steht `null`, weil der Daemon den eigentlichen Fehler in eine nackte `java.lang.Exception` ohne Meldung verpackt. Die nützliche Zeile ist die letzte: `this and base files have different roots`. Wenn Ihr Log sie enthält, ist dieser Beitrag Ihre Lösung. Wenn nicht, springen Sie zu "Ähnliche Fehler" am Ende.

## Warum der inkrementelle Kotlin-Compiler ein einziges Laufwerk braucht

Die inkrementelle Kompilierung von Kotlin (IC) führt Lookup-Tabellen unter `build/<module>/kotlin/compile<Variant>Kotlin/cacheable/caches-jvm`. Die Tabellen ordnen jeder Quelldatei die Klassen zu, die sie erzeugt. Damit der Build-Cache von Gradle verschiebbar bleibt, speichert Kotlin seit 1.9.20 diese Pfade relativ zu einem Basisverzeichnis statt als absolute Pfade. Das ist der Konverter aus `build-common` im Kotlin-Repository:

```kotlin
// Kotlin build-common, RelocatableFileToPathConverter.kt (unchanged through 2.4.20)
override fun toPath(file: File): String {
    // ...
    // Note: If the given file is located outside `baseDir`, the relative path will start with "../".
    // It's not "clean", but it can work.
    return file.relativeTo(baseDir).invariantSeparatorsPath
}
```

Für Quelldateien ist `baseDir` das **Verzeichnis des Root-Projekts**, bei einer Flutter-App also `<project>\android`. Flutter-Plugins sind Gradle-Unterprojekte, ihre Quellen liegen aber im Pub-Cache, außerhalb dieses Ordners. Unter macOS und Linux funktioniert das, weil alle Pfade die gemeinsame Wurzel `/` haben. Auf meinem Mac enthält der IC-Cache für `shared_preferences_android` tatsächlich diesen Eintrag:

```text
../../../../../../../../Users/marius/.pub-cache/hosted/pub.dev/shared_preferences_android-2.4.28/android/src/main/kotlin/io/flutter/plugins/sharedpreferences/LegacySharedPreferencesPlugin.kt
```

Unter Windows haben `D:\src\my_app\android` und `C:\Users\...\Pub\Cache` unterschiedliche Wurzeln. Keine Kette von `..\` führt von einem Laufwerk zum anderen, also wirft `File.relativeTo` eine `IllegalArgumentException`. Die Exception tritt auf, während IC seine Caches schreibt, deshalb erscheint sie als "Could not close incremental caches", und der Daemon meldet sie als "Daemon compilation failed".

Das erklärt auch, warum die klassischen Workarounds funktionieren: "das Projekt nach `C:` verschieben", "Kotlin auf 1.9.10 downgraden" (die letzte Version vor den relativen Pfaden) und "es scheitert nur bei manchen Plugins" (nur Plugins mit Kotlin-Quellen laufen durch den Kotlin-Compiler). JetBrains verfolgt die eigentliche Ursache als [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983), das immer noch auf "To be discussed" steht. Ein JetBrains-Entwickler merkte an, dass die triviale Lösung (`relativeToOrSelf`) zu falschen Treffern im Build-Cache führen würde. Auf Flutter-Seite ist es [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395), offen seit 2022.

Derselbe Absturz trifft jedes Setup, in dem Quellen und Root-Projekt verschiedene Wurzeln haben: virtuelle `subst`-Laufwerke ([KT-65155](https://youtrack.jetbrains.com/issue/KT-65155)), ein Build-Verzeichnis auf einer RAM-Disk oder ein WSL-Pfad wie `\mnt\d\project`, gemischt mit `D:\project`.

## Warum die APK manchmal trotzdem gebaut wird

Viele berichten, dass das Log voller `e:`-Zeilen ist und danach `√ Built build\app\outputs\flutter-apk\app-release.apk` ausgibt. Andere, besonders seit Flutter 3.44, bekommen ein echtes `BUILD FAILED`. Der Unterschied liegt darin, welchen Compiler-Pfad das Kotlin Gradle Plugin nimmt, nachdem der Daemon gescheitert ist. Ich habe es an jedem Tag im KGP-Quellcode nachgelesen:

| KGP-Version | Standard-Compiler-Pfad | Fallback nach dem Scheitern des Daemons | Ergebnis bei einem laufwerksübergreifenden Projekt |
| --- | --- | --- | --- |
| 1.9.20 bis 2.3.0 | `GradleKotlinCompilerWork` | `compileInProcess`, das ausdrücklich **nicht inkrementell** ist ("in-process execution strategy is non-incremental") | Viel `e:`-Ausgabe, APK wird gebaut |
| 2.3.20 und neuer | Build Tools API (`kotlin.compiler.runViaBuildToolsApi` ist standardmäßig `true`) | `performCompilation(IN_PROCESS)` mit **derselben** inkrementellen Konfiguration, einschließlich `ROOT_PROJECT_DIR` | Fallback trifft dasselbe `relativeTo`, Build kann fehlschlagen |

Das Flutter-Template legt die KGP-Version in `android/settings.gradle.kts` fest, daher entscheidet Ihre Flutter-Version zum Zeitpunkt von `flutter create`, in welcher Zeile Sie sich befinden:

| Flutter-Template | `templateKotlinGradlePluginVersion` |
| --- | --- |
| 3.35.0 | 2.1.0 |
| 3.38.0, 3.41.0 | 2.2.20 |
| 3.44.0 | 2.3.20 |
| 3.47.0 bis 3.47.5 | 2.4.0 |

Das passt zu den Issue-Threads. Die Berichte aus 2025 zu Flutter 3.32 und 3.35 sagen "die APK wird trotzdem gebaut". Die Kommentare vom Juni 2026 sagen "habe das Problem nach dem Upgrade auf Flutter 3.44 bekommen". Der Bericht vom August 2026 zu 3.47.0 mit AGP 9.1.0 und KGP 2.4.0 zeigt, wie `:shared_preferences_android:compileDebugKotlin` den Build bei einem sauberen Lauf scheitern lässt. Diese Leute sehen keinen neuen Bug. Der Kotlin-Fallback, der den alten früher verdeckt hat, tut das nicht mehr.

## Minimale Reproduktion

Sie brauchen Windows mit zwei Laufwerken (oder einem `subst`-Laufwerk). Lassen Sie den Standard-Pub-Cache auf `C:`:

```powershell
# Windows 11, Flutter 3.47.5, default PUB_CACHE on C:
D:
cd \src
flutter create --platforms=android daemon_repro
cd daemon_repro
flutter pub add shared_preferences
flutter build apk --debug
```

Ein frisch erstelltes 3.47.5-Projekt bekommt `com.android.application` 9.1.0, `org.jetbrains.kotlin.android` 2.4.0 und Gradle 9.3.1, mit standardmäßig aktivierter Kotlin-IC. Ohne das Plugin hat die Template-App außerhalb von `android\` nichts, was Kotlin kompilieren müsste, also läuft der Build sauber durch. Das erklärt die häufige Beobachtung "es ging kaputt, sobald ich ein Paket hinzugefügt habe".

## Lösung 1: den Pub-Cache auf dasselbe Laufwerk wie Ihre Projekte legen

Das ist die empfohlene Lösung. Sie beseitigt die Ursache und behält die inkrementelle Kompilierung überall bei. Wählen Sie einen Ordner auf dem Laufwerk, auf dem Ihre Projekte liegen, lassen Sie `PUB_CACHE` darauf zeigen und lösen Sie die Abhängigkeiten neu auf:

```powershell
# Windows, any Flutter 3.x: user-level env var, picked up by new shells and IDEs
[Environment]::SetEnvironmentVariable("PUB_CACHE", "D:\PubCache", "User")

# open a NEW terminal (and restart VS Code / Android Studio), then:
cd D:\src\my_app
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter pub get` lädt die Pakete in den neuen Cache herunter und erzeugt `.dart_tool\package_config.json` und `.flutter-plugins-dependencies` neu. Das Flutter-Gradle-Plugin liest die Plugin-Pfade aus diesen Dateien, sodass jedes Plugin-Unterprojekt nun auf `D:\PubCache\...` aufgelöst wird. `flutter clean` ist wichtig, weil die alten IC-Caches unter `build\` noch Pfade aus dem vorherigen Layout enthalten. Den alten Ordner `C:\Users\<you>\AppData\Local\Pub\Cache` können Sie danach löschen.

Die Grenze dieser Lösung: Wenn Sie Projekte auf mehreren Laufwerken haben, kann nur eines davon zum Cache passen. Für diesen Fall nehmen Sie Lösung 2.

## Lösung 2: die inkrementelle Kompilierung nur für Plugin-Unterprojekte abschalten

Plugins aus dem Pub-Cache ändern sich zwischen Builds nie, daher bringt IC bei ihnen nichts. Ihr eigenes Modul `app` ist der Ort, an dem sich IC lohnt, und seine Quellen liegen innerhalb von `android\`, es ist also nicht betroffen. KGP liest `kotlin.incremental` pro Projekt, einschließlich der Extra-Eigenschaften des Projekts, sodass Sie den Schalter eingrenzen können. Hängen Sie Folgendes an `android/build.gradle.kts` an:

```kotlin
// android/build.gradle.kts, Flutter 3.47.5, AGP 9.1.0, KGP 2.4.0
// Kotlin incremental compilation stores source paths relative to this
// directory. Plugins from the pub cache live outside it, which breaks on
// Windows when the cache is on another drive (KT-63983). Turn IC off for
// those subprojects only; the :app module stays incremental.
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        extra["kotlin.incremental"] = "false"
    }
}
```

Für ein Groovy-`android/build.gradle` sieht das Äquivalent so aus:

```groovy
// android/build.gradle, Flutter 3.35 to 3.47
subprojects {
    if (!projectDir.canonicalPath.startsWith(rootDir.canonicalPath)) {
        ext.set("kotlin.incremental", "false")
    }
}
```

Ich habe das unter macOS mit dem 3.47.5-Reproduktionsprojekt geprüft, indem ich nachgesehen habe, welche Module nach `flutter clean && flutter build apk --debug` IC-Caches schreiben. Ohne das Snippet existieren sowohl `build/app/kotlin/compileDebugKotlin/cacheable/caches-jvm` als auch `build/shared_preferences_android/.../caches-jvm`. Mit dem Snippet existiert nur der für `app`, und die APK wird gebaut. Die Groovy-Variante lieferte dasselbe Ergebnis. Ich habe hier keinen Windows-Rechner mit zweitem Laufwerk, daher habe ich das Verschwinden des Windows-Absturzes nicht selbst gesehen, aber der Mechanismus ist derselbe: Mit abgeschalteter IC baut KGP keine inkrementelle Konfiguration auf, und nichts ruft `RelocatableFileToPathConverter` auf.

Zwei Ansätze, die richtig aussehen, funktionieren **nicht**, und ich habe beide mit 3.47.5 ausprobiert:

- `tasks.withType<KotlinCompile>().configureEach { incremental = false }` in `subprojects {}`. Die eigene Konfigurationsaktion von KGP führt später `task.incremental = propertiesProvider.incrementalJvm ?: true` aus und überschreibt Ihren Wert. Eine `doFirst`-Probe gab `incremental=true` aus.
- Dasselbe in `afterEvaluate {}` verpackt. Gleiches Ergebnis: Die Caches wurden trotzdem geschrieben.

Die Eigenschaft zu setzen, die KGP selbst liest, ist der einzige Schalter pro Modul, der überlebt.

Eine Pfadabhängigkeit innerhalb Ihres Repositorys (`path: ../packages/my_plugin`) liegt ebenfalls außerhalb von `android\`, daher schaltet das Snippet auch dafür IC ab. Das kostet bei jedem Build eine vollständige Neukompilierung des Kotlin-Codes dieses Plugins, meist ein bis zwei Sekunden. Wenn das ins Gewicht fällt, grenzen Sie die Prüfung auf Pub-Cache-Pfade ein, zum Beispiel mit `projectDir.canonicalPath.contains("Pub${File.separator}Cache")`.

## Lösung 3: die inkrementelle Kotlin-Kompilierung global abschalten

Die gröbste Lösung und die in den Issue-Threads am häufigsten zitierte. In `android/gradle.properties`:

```properties
# android/gradle.properties, any Flutter / KGP version
kotlin.incremental=false
```

Sie funktioniert, und ich habe bestätigt, dass danach für kein Modul ein Ordner `caches-jvm` angelegt wird. Der Preis: Auch der Kotlin-Code Ihres Moduls `app` wird bei jedem Build von Grund auf neu kompiliert. Für die einzelne `MainActivity.kt` des Flutter-Templates spielt das keine Rolle. Bei einer App mit viel nativem Kotlin (Platform Channels, ein Widget, ein Wear-OS-Modul) summiert sich das während `flutter run`. Bevorzugen Sie in diesem Fall Lösung 1 oder Lösung 2.

## Was Sie nicht tun sollten

- **Downgraden Sie KGP nicht auf 1.9.10.** Es ist die letzte Version vor den relativen Pfaden, also verschwindet der Absturz. Aber Flutter 3.47 lehnt KGP unter 2.2.20 ab, und AGP 9 verlangt ein modernes KGP, Sie würden also Ihre gesamte Android-Toolchain auf den Stand von 2023 festnageln.
- **Setzen Sie nicht `kotlin.compiler.runViaBuildToolsApi=false`, um das alte Verhalten "APK wird trotzdem gebaut" zurückzuholen.** In KGP 2.4 ist diese Eigenschaft als veraltet markiert (KT-85433, "non-BTA JVM compiler invocation is deprecated"), und sie protokolliert den Absturz weiterhin bei jedem Build. Sie verdeckt das Problem nur, bis das nächste KGP sie entfernt.
- **Setzen Sie nicht `kotlin.daemon.useFallbackStrategy=false`.** Damit wird der Fall "APK wird trotzdem gebaut" auch bei alten KGP-Versionen zum harten Fehler.
- **Verschieben Sie nicht das Flutter SDK.** Der Speicherort des SDK spielt hier keine Rolle. Das Flutter-Gradle-Plugin ist ein Included Build mit eigener Wurzel, und seine Quellen liegen direkt daneben. Es zählt nur die Aufteilung von Pub-Cache und Projekt auf verschiedene Laufwerke.

## Ähnliche Fehler

Nicht jede Zeile `Daemon compilation failed` ist dieser Bug. Prüfen Sie die Zeilen `Caused by` und `Suppressed`:

- **`Daemon compilation failed: Could not connect to Kotlin compile daemon`**. Der Daemon ist nicht gestartet oder abgestürzt, oft wegen eines Virenscanners oder zu wenig Speicher. Führen Sie `cd android; .\gradlew --stop` aus und bauen Sie erneut. Bei alten KGP-Versionen kompiliert der Fallback ohne Daemon, daher ist dieser Fehler meist harmlos.
- **Ein `OutOfMemoryError` im Daemon oder in Gradle**. Erhöhen Sie `kotlin.daemon.jvmargs` und `org.gradle.jvmargs` in `gradle.properties`, siehe [flutter/flutter#133371](https://github.com/flutter/flutter/issues/133371).
- **`Module was compiled with an incompatible version of Kotlin`**. Ein Plugin wurde mit einer neueren Kotlin-Metadatenversion gebaut als Ihr KGP. Das ist ein Versionskonflikt, kein IC-Problem, und er wird in [der Migrationsanleitung zu AGP 9](/de/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) behandelt.
- **Ein allgemeines `Gradle task assembleDebug failed with exit code 1`** ohne Zeilen zum Kotlin-Daemon. Beginnen Sie mit [der allgemeinen assembleDebug-Checkliste](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

Die rohen Daemon-Logs liegen in `android\.kotlin\errors\errors-<timestamp>.log` und `%TEMP%\kotlin-daemon.*.log`. Durchsuchen Sie sie nach `different roots`, wenn die Konsolenausgabe abgeschnitten ist.

## Verwandte Beiträge

- [Ein Flutter-Android-Projekt auf AGP 9 mit eingebautem Kotlin migrieren](/de/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) erklärt das AGP-9.1-/KGP-2.4-Template, das diese Warnung in einen Fehler verwandelt hat.
- [Lösung: Gradle task assembleDebug failed with exit code 1 in Flutter](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) ist der Sammelbeitrag für Android-Build-Fehler.
- [Lösung: A restricted method in java.lang.System has been called in einem Flutter-Gradle-Build](/de/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/), eine weitere laute Gradle-Meldung, bei der Sie entscheiden müssen, ob sie fatal ist.
- [Lösung: flutter doctor --android-licenses schlägt mit cmdline-tools 23 fehl](/de/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/) für das andere häufige Problem mit der Android-Toolchain unter Windows in diesem Monat.
- [Flutter iOS von Windows aus debuggen](/de/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/), wenn Windows Ihr Hauptrechner für Flutter ist.

## Quellen

- [flutter/flutter#173456](https://github.com/flutter/flutter/issues/173456) (offen), einschließlich der Reproduktion vom 2026-08-16 mit Flutter 3.47.0, AGP 9.1.0, KGP 2.4.0, sowie [flutter/flutter#105395](https://github.com/flutter/flutter/issues/105395), das Tracking-Issue zum laufwerksübergreifenden Problem.
- [flutter/flutter#144566](https://github.com/flutter/flutter/issues/144566) und [flutter/flutter#170534](https://github.com/flutter/flutter/issues/170534), frühere Berichte mit vollständigem Stack.
- [KT-63983](https://youtrack.jetbrains.com/issue/KT-63983), [KT-65155](https://youtrack.jetbrains.com/issue/KT-65155) und [KT-80077](https://youtrack.jetbrains.com/issue/KT-80077) im Kotlin-Tracker.
- Kotlin-Quellcode: [`RelocatableFileToPathConverter.kt`](https://github.com/JetBrains/kotlin/blob/master/build-common/src/org/jetbrains/kotlin/incremental/storage/RelocatableFileToPathConverter.kt), `GradleKotlinCompilerWork.kt` und `btapi/BuildToolsApiCompilationWork.kt` in `libraries/tools/kotlin-gradle-plugin` sowie `PropertiesProvider.kt` / `KotlinCompileConfig.kt` an den Tags `v2.3.0`, `v2.3.20` und `v2.4.0`.
- Flutter-Quellcode: `packages/flutter_tools/lib/src/android/gradle_utils.dart` (`templateKotlinGradlePluginVersion`) an den Tags 3.35.0 bis 3.47.5.
- [Kotlin Gradle plugin compilation and caches](https://kotlinlang.org/docs/gradle-compilation-and-caches.html) auf kotlinlang.org, zu `kotlin.incremental`.
- [Environment variables for pub](https://dart.dev/tools/pub/environment-variables) auf dart.dev, zu `PUB_CACHE`.
