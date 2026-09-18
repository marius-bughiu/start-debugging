---
title: "Ein Flutter-Android-Projekt auf AGP 9 mit Built-in Kotlin migrieren"
description: "Der vollständige Weg von einer AGP-8-Flutter-App, die kotlin-android anwendet, zu AGP 9.1 mit android.builtInKotlin=true auf Flutter 3.47. Jeder Schritt wurde gebaut und gemessen, einschließlich der zwei Änderungen, die optional aussehen und es nicht sind: kotlinOptions ist unter KGP 2.2+ ein Kompilierfehler, und die KGP-Zeile in settings.gradle.kts muss bleiben."
pubDate: 2026-09-18
updatedDate: 2026-09-18
template: migration
tags:
  - "migration"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
lang: "de"
translationOf: "2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin"
translatedBy: "claude"
translationDate: 2026-09-18
---

Für eine Flutter-App, die vor Flutter 3.44 erstellt wurde, besteht die Migration aus vier Änderungen: den Gradle Wrapper auf 9.3.1 und AGP auf 9.1.0 anheben, die Version des Kotlin Gradle Plugin (KGP) in `settings.gradle.kts` auf 2.4.0 anheben, die Zeile aber behalten, `kotlinOptions` durch einen `kotlin { compilerOptions { ... } }`-Block auf oberster Ebene ersetzen und `id("kotlin-android")` aus `app/build.gradle.kts` löschen. Danach setzen Sie `android.builtInKotlin=true` in `gradle.properties`, was Flutter 3.47 oder neuer voraussetzt, und zwar erst, wenn jedes Plugin, von dem Sie abhängen, ebenfalls auf KGP verzichtet. Planen Sie für eine App mit aktuellen Abhängigkeiten eine Stunde ein, länger, wenn ein Plugin noch `kotlin-android` anwendet. Es lohnt sich, das jetzt zu erledigen: Flutter verweigert bereits den Build mit Gradle unter 8.14 oder AGP unter 8.11.1 und hat angekündigt, die KGP-Unterstützung vollständig zu entfernen ([flutter#184837](https://github.com/flutter/flutter/issues/184837)).

Alles Folgende lief auf Flutter 3.47.4 stable (Framework-Revision `9584c6713b`, Dart 3.13), OpenJDK 17.0.20 und Android SDK build-tools 36.1, ausgehend von einem Projekt, das genau wie das `android-kotlin`-Template von Flutter 3.35 aufgebaut war: AGP 8.9.1, KGP 2.1.0, Gradle 8.12, `id("kotlin-android")` im App-Modul und ein `kotlinOptions`-Block. Den Endzustand habe ich zusätzlich auf Flutter 3.44.8 geprüft. Zu jedem Schritt steht die exakte Ausgabe, die ich bekommen habe.

## Warum diese Migration nicht mehr optional ist

- **Flutter 3.47 erzwingt Mindestversionen, die ein AGP-8-Projekt aus 2025 nicht erfüllt.** `DependencyVersionChecker.kt` in 3.47.4 bricht bei Gradle unter 8.14.0, AGP unter 8.11.1 und KGP unter 2.2.20 mit einem Fehler ab und warnt unter Gradle 9.1.0, AGP 9.0.1 und KGP 2.3.20. Mein unverändertes Projekt aus der 3.35-Ära scheiterte beim ersten Build mit `Your project's Gradle version (8.12.0) is lower than Flutter's minimum supported version of 8.14.0`.
- **AGP 9 ändert zwei Standardwerte.** Laut den [Release Notes zu AGP 9.0](https://developer.android.com/build/releases/agp-9-0-0-release-notes) stehen `android.builtInKotlin` und `android.newDsl` beide standardmäßig auf `true`. Built-in Kotlin bedeutet, dass AGP Kotlin selbst kompiliert und das Anwenden von `org.jetbrains.kotlin.android` ein Fehler ist.
- **Die Opt-outs sind auf beiden Seiten nur vorübergehend.** Flutters eigene Templates werden derzeit mit `android.builtInKotlin=false` und `android.newDsl=false` ausgeliefert, aber die [Übersicht zur Built-in-Kotlin-Migration](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) sagt, dass die KGP-Unterstützung in einer künftigen Flutter-Version entfernt wird, und Google sagt, dass der Notausgang `newDsl=false` mit AGP 10 verschwindet.
- **Ihre Plugins werden an derselben Regel gemessen.** Sobald Sie Built-in Kotlin aktivieren, lässt jedes Plugin, das noch `kotlin-android` anwendet, Ihren Build scheitern, nicht seine eigene CI. Diese Plugins früh zu finden, ist der größte Teil der eigentlichen Arbeit.

## Was kaputtgeht

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| Gradle Wrapper | Flutter 3.47 bricht unter 8.14 ab; AGP 9.1 braucht 9.3.1 | hoch |
| `kotlin-android` im App-Modul | Scheitert mit aktiviertem Built-in Kotlin | hoch |
| `kotlinOptions { jvmTarget = ... }` | Fehler bei der Skriptkompilierung unter KGP 2.2 und neuer | hoch |
| Plugins, die KGP anwenden | Lassen Ihren Build scheitern, sobald `android.builtInKotlin=true` gilt | hoch |
| `android.newDsl=true` | Das Flutter Gradle Plugin castet noch auf die alte DSL, `ClassCastException` | hoch (auf `false` lassen) |
| KGP-Eintrag in `settings.gradle.kts` | Entfernen fällt auf das mit AGP gebündelte Kotlin 2.2.10 zurück, unter Flutters Mindestversion | mittel |
| `build.gradle`-Projekte (Groovy) | Dieselben Änderungen, andere Syntax; `buildscript`-Layouts vor 3.16 brauchen zuerst die Migration auf deklarative Plugins | mittel |

## Checkliste vor dem Start

- **Flutter 3.47.x auf dem Rechner und in der CI.** Flutter 3.44 hat AGP-9-Unterstützung mit *deaktiviertem* Built-in Kotlin hinzugefügt; das Aktivieren wird erst ab 3.47 unterstützt. Prüfen Sie das mit `flutter --version`.
- **JDK 17 oder neuer für Gradle.** AGP 9 setzt JDK 17 voraus. `flutter doctor -v` zeigt, welches JDK Flutter an Gradle übergibt; ist es eine JRE oder JDK 11, beheben Sie das zuerst (wie Flutter das JDK auswählt, steht im Beitrag zum [JAVA_COMPILER-Toolchain-Fehler](/de/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/)).
- **Android SDK build-tools 36.0.0 oder neuer.** Das ist das Minimum von AGP 9.
- **Ein sauberer Arbeitsbaum.** Das Flutter-Tool schreibt `gradle.properties` beim ersten Build mit 3.44+ selbstständig um, also committen Sie vor dem Start und prüfen Sie den Diff danach.
- **Eine Liste Ihrer Android-Plugins.** `flutter pub deps --style=compact` genügt. In Schritt 6 prüfen Sie das Changelog jedes Plugins auf Unterstützung für Built-in Kotlin.

## Migrationsschritte

1. **Lassen Sie das Flutter-Tool die beiden Opt-out-Flags hinzufügen und prüfen Sie sie dann.** Führen Sie einmal einen beliebigen Android-Build mit Flutter 3.44 oder neuer aus. Die Migratoren des Tools hängen beide Flags an `android/gradle.properties` an, falls sie fehlen. Bei meinem Projekt scheiterte der Build trotzdem (wegen Gradle 8.12), aber die Datei war bereits umgeschrieben:

   ```properties
   # android/gradle.properties, written by the Flutter 3.47.4 migrators
   org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError
   android.useAndroidX=true
   # This builtInKotlin flag was added automatically by Flutter migrator
   android.builtInKotlin=false
   # This newDsl flag was added automatically by Flutter migrator
   android.newDsl=false
   ```

   Bei Add-to-App-Host-Projekten läuft der Migrator nie, weil der Host ein reines Android-Projekt ist. Dort tragen Sie beide Zeilen von Hand in die `gradle.properties` des Hosts ein. Prüfen: `grep -E 'builtInKotlin|newDsl' android/gradle.properties` gibt beide Zeilen aus.

2. **Heben Sie den Gradle Wrapper auf 9.3.1 an.** AGP 9.0.x braucht Gradle 9.1.0 oder neuer, und Flutters Tooling kombiniert AGP 9.1.x mit 9.3.1 oder neuer, was auch das Template von Flutter 3.47 mitbringt:

   ```properties
   # android/gradle/wrapper/gradle-wrapper.properties, Flutter 3.47.4
   distributionUrl=https\://services.gradle.org/distributions/gradle-9.3.1-all.zip
   ```

   Prüfen: `cd android && ./gradlew --version` meldet `Gradle 9.3.1`.

3. **Heben Sie AGP und KGP in `settings.gradle.kts` an und behalten Sie die Kotlin-Zeile.** Das sind die Versionen, die `flutter create` in 3.47.4 schreibt:

   ```kotlin
   // android/settings.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   plugins {
       id("dev.flutter.flutter-plugin-loader") version "1.0.0"
       id("com.android.application") version "9.1.0" apply false
       id("org.jetbrains.kotlin.android") version "2.4.0" apply false
   }
   ```

   Es ist verlockend, die Zeile `org.jetbrains.kotlin.android` zu löschen, da der Sinn der Migration ja ist, KGP nicht mehr zu verwenden. Tun Sie es nicht. Mit `apply false` legt sie nur diese Kotlin-Version auf den Build-Classpath, und Built-in Kotlin kompiliert damit. Als ich sie entfernt habe, fiel AGP 9.1.0 auf sein gebündeltes Kotlin 2.2.10 zurück, und das Flutter Gradle Plugin lehnte den Build ab: `Your project's Kotlin version (2.2.10) is lower than Flutter's minimum supported version of 2.2.20`. Die Zeile ist auch wichtig, solange `builtInKotlin=false` gilt, denn dann wendet das Flutter Gradle Plugin `kotlin-android` selbst auf jedes Android-Unterprojekt an, das es nicht tut, und dafür braucht es KGP auf dem Classpath.

   Prüfen: noch nichts. Der Build scheitert bis Schritt 4 weiterhin.

4. **Ersetzen Sie `kotlinOptions` durch die `compilerOptions`-DSL.** Das ist die Änderung, die viele überrascht, weil sie nötig ist, noch bevor Sie Built-in Kotlin anfassen. Mit AGP 9.1.0, KGP 2.4.0, weiterhin angewendetem `kotlin-android` und `builtInKotlin=false` scheiterte mein Build bei der Skriptkompilierung:

   ```text
   Script compilation errors:
     Line 18:     kotlinOptions {
                  ^ 'fun BaseAppModuleExtension.kotlinOptions(configure: Action<DeprecatedKotlinJvmOptions>): Unit' is deprecated. Please migrate to the compilerOptions DSL.
     Line 19:         jvmTarget = JavaVersion.VERSION_11.toString()
                      ^ 'var jvmTarget: String' is deprecated. Please migrate to the compilerOptions DSL.
   ```

   [Kotlin 2.2.0 hat die Deprecation von `kotlinOptions` zu einem Fehler hochgestuft](https://kotlinlang.org/docs/whatsnew22.html), und Flutter 3.47 lässt Sie nicht unter KGP 2.2.20 bleiben, also gibt es keine Versionskombination, in der `kotlinOptions` überlebt. Verschieben Sie das JVM-Target aus dem `android {}`-Block in einen `kotlin {}`-Block auf oberster Ebene:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4, AGP 9.1.0, KGP 2.4.0
   android {
       // ...
       compileOptions {
           sourceCompatibility = JavaVersion.VERSION_17
           targetCompatibility = JavaVersion.VERSION_17
       }
       // kotlinOptions { jvmTarget = JavaVersion.VERSION_17.toString() }  <- delete
   }

   kotlin {
       compilerOptions {
           jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
       }
   }
   ```

   Halten Sie `jvmTarget` gleich `targetCompatibility`. Alte Templates nutzten 11, neue nutzen 17; beides funktioniert, solange die zwei übereinstimmen. Prüfen: `flutter build apk --debug` ist erfolgreich. An diesem Punkt gibt es außerdem `WARNING: Your Android app project: app ... applies the Kotlin Gradle Plugin, which will cause build failures in future versions of Flutter.` aus. Diese Warnung ist erwartet, und genau sie entfernt Schritt 5.

5. **Entfernen Sie `kotlin-android` aus dem App-Modul.** Löschen Sie die Plugin-Zeile und sonst nichts:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.47.4
   plugins {
       id("com.android.application")
       // id("kotlin-android")  <- delete
       // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
       id("dev.flutter.flutter-gradle-plugin")
   }
   ```

   Nutzt Ihr App-Modul die Version-Catalog-Form, ist die zu löschende Zeile `alias(libs.plugins.kotlin.android)`. Bei einer Groovy-`build.gradle` ist es `apply plugin: 'kotlin-android'` oder `id "kotlin-android"`, und der `kotlin { compilerOptions { ... } }`-Block aus Schritt 4 ist so, wie er dasteht, gültiges Groovy. Prüfen: `flutter build apk --debug` ist erfolgreich, ohne KGP-Warnung für `app`. Da `builtInKotlin` noch auf `false` steht, wendet jetzt das Flutter Gradle Plugin KGP in Ihrem Namen an, weshalb dieser Zwischenzustand baut.

6. **Finden Sie die Plugins, die noch KGP anwenden.** Bauen Sie noch einmal mit `builtInKotlin=false` und lesen Sie die Gradle-Ausgabe. Flutter 3.47 nennt sie Ihnen:

   ```text
   WARNING: Your app uses the following plugins that apply Kotlin Gradle Plugin (KGP): oldplug
   Future versions of Flutter will fail to build if your app uses plugins that apply KGP.
   Please check the changelogs of these plugins and upgrade to a version that supports Built-in Kotlin.
   ```

   Suchen Sie für jedes aufgeführte Plugin auf pub.dev nach einer neueren Version, deren Changelog Built-in Kotlin oder AGP 9 erwähnt, und aktualisieren Sie. Gibt es keine, eröffnen Sie ein Issue beim Plugin (Flutters Leitfaden für App-Entwickler enthält [eine Issue-Vorlage](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers#report-incompatible-kotlin-gradle-plugin-usage-to-plugin-authors)) und hören Sie hier auf: Sie sind auf AGP 9 mit deaktiviertem Built-in Kotlin, was ein unterstützter Zustand ist. Prüfen: Die Warnung listet kein Plugin mehr auf.

7. **Aktivieren Sie Built-in Kotlin.** Erst wenn Schritt 6 sauber zurückkommt:

   ```properties
   # android/gradle.properties, Flutter 3.47.4, AGP 9.1.0
   android.builtInKotlin=true
   android.newDsl=false
   ```

   Lassen Sie `android.newDsl=false` stehen. Prüfen: `flutter build apk --debug` ist ohne KGP-Warnungen erfolgreich, und danach startet `flutter run` die App auf einem Gerät oder Emulator.

## Checkliste zur Überprüfung

- `flutter build apk --debug` und `flutter build appbundle --release` sind beide erfolgreich, ohne Warnung `applies the Kotlin Gradle Plugin` in der Ausgabe.
- Ihr Kotlin-Code ist tatsächlich im APK gelandet. Das habe ich geprüft, weil Built-in Kotlin ein anderer Compiler-Pfad ist: Entpacken Sie das APK mit `unzip` und durchsuchen Sie die `classes*.dex`-Dateien nach Ihrer `MainActivity`. In meinem migrierten Projekt lag `Lnet/sd/app347/MainActivity;` in `classes4.dex`.
- `flutter test` und alle `integration_test`-Suites laufen auf einem Android-Gerät weiterhin durch.
- Die CI nutzt dieselbe Flutter-Version und JDK 17. Ein CI-Image, das auf Flutter 3.44 hängen geblieben ist, baut mit aktiviertem Built-in Kotlin, gibt aber eine irreführende Meldung aus (siehe die Stolperfallen).
- `git diff android/` zeigt nur die oben genannten Dateien. Ein Migrator, der stillschweigend etwas anderes umgeschrieben hat, verdient einen Blick, bevor Sie committen.

## Rollback-Plan

Die Migration ist in jedem Schritt umkehrbar, und das günstigste Rollback ist ein teilweises. Wenn nach Schritt 7 ein Plugin kaputtgeht, setzen Sie `android.builtInKotlin=false` wieder: Mit diesem Flag akzeptiert AGP 9 KGP, und das Flutter Gradle Plugin wendet `kotlin-android` erneut auf die Module an, die es brauchen, sodass Sie die `kotlin-android`-Zeile in Ihrem App-Modul nicht wiederherstellen müssen. Ein vollständiges Rollback auf AGP 8 bedeutet, `settings.gradle.kts` und den Wrapper aus git wiederherzustellen, aber auf Flutter 3.47 können Sie nicht unter AGP 8.11.1, Gradle 8.14 oder KGP 2.2.20 gehen, also bedeutet "Rollback" in Wahrheit AGP 8.11+, nicht Ihr ursprüngliches 8.9. Die Änderung `kotlin { compilerOptions }` aus Schritt 4 bleibt in jedem Fall.

## Stolperfallen, auf die ich unterwegs gestoßen bin

**Der erste Fehler hat überhaupt nichts mit Kotlin zu tun.** Beim nicht migrierten Projekt gab Flutter 3.47.4 das eigentliche Problem (Gradle 8.12 unter 8.14) innerhalb der Gradle-Ausgabe aus und darunter einen umrahmten "Flutter Fix", der `Starting AGP 9+, only the new DSL interface will be read` meldete und vorschlug, sich per Opt-out von `android.newDsl` abzumelden. Das Projekt lief auf AGP 8.9.1. Der Kasten ist eine Heuristik, die bei jedem Fehlschlag beim Anwenden des Flutter Gradle Plugin auslöst, also lesen Sie zuerst den Abschnitt `* What went wrong:`, derselbe Rat wie im [Leitfaden zu assembleDebug mit Exit-Code 1](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).

**Die Fehlermeldung für ein übrig gebliebenes `kotlin-android` hängt von Ihrer KGP-Version ab.** Mit KGP 2.4.0 ist sie eindeutig:

```text
> Failed to apply plugin 'kotlin-android'.
   > ⛔ Failed to apply plugin 'org.jetbrains.kotlin.android'
     The 'org.jetbrains.kotlin.android' plugin is no longer required for Kotlin support since AGP 9.0.
     Solution: Remove the 'org.jetbrains.kotlin.android' plugin from this project's build file: app/build.gradle.kts.
```

Mit älteren KGP-Versionen zeigt sich derselbe Fehler als `Cannot add extension with name 'kotlin'`, die Form, die die meisten Antworten auf Stack Overflow zitieren. Die Zeile `Solution:` ist nützlich, wenn der Übeltäter ein Plugin ist: Bei meinem Test-Plugin zeigte sie auf `../../oldplug/android/build.gradle.kts`. Bei einem pub.dev-Paket zeigt der Pfad in `~/.pub-cache/hosted/pub.dev/<package>-<version>/android/`, was Ihnen genau sagt, welches Paket Sie aktualisieren müssen. Bearbeiten Sie keine Dateien im Pub-Cache; sie werden beim nächsten `pub get` überschrieben.

**`android.newDsl=true` ist weiterhin ein harter Fehler.** Mit allem anderen migriert führte das Setzen zu `class com.android.build.gradle.internal.dsl.ApplicationExtensionImpl$AgpDecorated_Decorated cannot be cast to class com.android.build.gradle.AbstractAppExtension`. Das Flutter Gradle Plugin liest noch die alten DSL-Typen ([flutter#180137](https://github.com/flutter/flutter/issues/180137) verfolgt die Portierung). Lassen Sie das Flag auf `false`, bis ein Flutter-Release etwas anderes sagt, und rechnen Sie damit, dass dieses Release vor AGP 10 erscheint.

**Flutter 3.44 funktioniert mit aktiviertem Built-in Kotlin nur halb.** Die Dokumentation sagt, dass `android.builtInKotlin=true` 3.47 braucht. Ich habe das vollständig migrierte Projekt trotzdem auf Flutter 3.44.8 laufen lassen: Das APK wurde gebaut und `MainActivity` war im Dex, aber das Tool gab `Applying the Kotlin Android Plugin (KGP) was unsuccessful. KGP was not found on the classpath.` aus. Das kommt vom Flutter Gradle Plugin aus 3.44, das das Flag nicht liest und trotzdem versucht, KGP anzuwenden. In einer trivialen App ist das harmlos und in einem CI-Log verwirrend, also behandeln Sie 3.47 als das echte Minimum, genau wie dokumentiert.

**Projekte vor 3.16 brauchen zuerst eine frühere Migration.** Wenn Ihre `android/build.gradle` noch `buildscript { ext.kotlin_version = '...' }` enthält und Ihr App-Modul `apply from: ".../flutter.gradle"` verwendet, lassen sich die obigen Schritte nicht sauber übertragen. Führen Sie zuerst die [Migration auf deklarative Plugins](https://docs.flutter.dev/release/breaking-changes/flutter-gradle-plugin-apply) durch und kehren Sie dann zu Schritt 2 zurück. Dieses Layout habe ich für diesen Beitrag nicht nachgestellt; dort ist die Flutter-Dokumentation die Referenz. Wenn Sie stattdessen an der alten Meldung zur Kotlin-Version hängen, erklärt [der Beitrag zum KGP-Versionsfehler](/de/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/), wo diese Version in älteren Layouts steht.

**Gradle 9 macht andere alte Warnungen zu Fehlern.** Gradle 9 hat APIs entfernt, die Gradle 8 nur als veraltet markiert hatte, sodass ein altes Plugin aus Gründen scheitern kann, die nichts mit Kotlin zu tun haben. Taucht daneben eine JDK-24-Warnung wie `A restricted method in java.lang.System has been called` auf, wird diese in [einem eigenen Beitrag](/de/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/) behandelt.

## Gemessene Ergebnisse

| Projektzustand (Flutter 3.47.4, sofern nicht anders angegeben) | Ergebnis |
| --- | --- |
| AGP 8.9.1, KGP 2.1.0, Gradle 8.12, `kotlin-android` | Scheitert: Gradle unter 8.14 |
| AGP 9.1.0, KGP 2.4.0, Gradle 9.3.1, `kotlinOptions` behalten | Scheitert: Fehler bei der Skriptkompilierung |
| Dasselbe, `compilerOptions`, `kotlin-android` behalten, `builtInKotlin=false` | Baut, KGP-Warnung für `app` |
| Dasselbe, `builtInKotlin=true` | Scheitert: KGP seit AGP 9.0 nicht mehr erforderlich |
| `kotlin-android` entfernt, `builtInKotlin=true` | Baut, 4,0 s inkrementell |
| KGP-Zeile aus `settings.gradle.kts` entfernt | Scheitert: Kotlin 2.2.10 unter 2.2.20 |
| Plugin wendet KGP an, `builtInKotlin=true` | Scheitert, nennt die Build-Datei des Plugins |
| Plugin wendet KGP an, `builtInKotlin=false` | Baut, Warnung listet das Plugin auf |
| Migriert, `newDsl=true` | Scheitert: `ClassCastException` im Flutter Gradle Plugin |
| Migriert, `builtInKotlin=true`, Flutter 3.44.8 | Baut, irreführende Meldung "KGP was not found" |

## Verwandte Beiträge

- [Fix: Gradle task assembleDebug failed with exit code 1 in einem Flutter-Android-Build](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Fix: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]](/de/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/)
- [Fix: A restricted method in java.lang.System has been called in einem Flutter-Gradle-Build](/de/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/)
- [Fix: flutter doctor --android-licenses scheitert mit cmdline-tools 23](/de/2026/09/fix-flutter-doctor-android-licenses-fails-with-cmdline-tools-23/)
- [Flutter: your project requires a newer version of the Kotlin Gradle plugin](/de/2023/08/flutter-your-project-requires-a-newer-version-of-the-kotlin-gradle-plugin/)

## Quellen

- [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin) und der [Leitfaden für App-Entwickler](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-app-developers), Flutter-Dokumentation.
- [Built-in Kotlin migration for plugin authors](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin/for-plugin-authors), Flutter-Dokumentation.
- [Android Gradle Plugin 9.0 release notes](https://developer.android.com/build/releases/agp-9-0-0-release-notes): Gradle 9.1.0, JDK 17, KGP 2.2.10 als Laufzeitabhängigkeit, neue Standardwerte.
- [What's new in Kotlin 2.2.0](https://kotlinlang.org/docs/whatsnew22.html): Deprecation von `kotlinOptions` zum Fehler hochgestuft.
- Quellcode von Flutter 3.47.4: `packages/flutter_tools/gradle/src/main/kotlin/DependencyVersionChecker.kt` (Mindestversionen), `FlutterPluginUtils.kt` (`isBuiltInKotlinEnabled`, automatisch angewendetes KGP), `lib/src/android/migrations/disable_built_in_kotlin_migration.dart`.
- Flutter-Issues [#181383](https://github.com/flutter/flutter/issues/181383), [#183909](https://github.com/flutter/flutter/issues/183909), [#184837](https://github.com/flutter/flutter/issues/184837), [#180137](https://github.com/flutter/flutter/issues/180137).
