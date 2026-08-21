---
title: "Lösung: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]"
description: "Gradle kompiliert mit einem JRE. Es durchsucht Ihre Maschine nicht, sondern nutzt genau die JVM, mit der es gestartet wurde. Richten Sie flutter config --jdk-dir auf ein echtes JDK, oder entfernen Sie org.gradle.java.home."
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "java"
lang: "de"
translationOf: "2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter"
translatedBy: "claude"
translationDate: 2026-08-21
---

Das Java-Home, auf dem Gradle läuft, enthält kein `bin/javac`, es ist also ein JRE und kein JDK. Gradle sucht auf Ihrer Maschine nicht nach einem besseren: Ohne konfigurierte Toolchain verwendet es die JVM, mit der es gestartet wurde, und bricht sofort ab. In einem Flutter-Android-Build wird diese JVM zuerst von `flutter config --jdk-dir` bestimmt. Führen Sie also `flutter config --jdk-dir "/pfad/zu/einem/echten/jdk"` aus und kompilieren Sie erneut. Ändert das nichts am Fehler, überschreibt etwas anderes die Entscheidung von Flutter: Prüfen Sie `org.gradle.java.home` in `android/gradle.properties`.

Alles Folgende wurde gegen Flutter 3.44.2 stable verifiziert, dessen Android-Templates Gradle 9.1.0, Android Gradle Plugin 9.0.1, Kotlin Gradle Plugin 2.3.20 und `compileSdk` 36 festlegen.

## Der Fehler, wie Gradle ihn ausgibt

```text
FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':app:packageDebug'.
> Could not create task ':app:compileDebugJavaWithJavac'.
   > Failed to calculate the value of task ':app:compileDebugJavaWithJavac' property 'javaCompiler'.
      > Toolchain installation 'C:\path\to\some-java-home' does not provide the required capabilities: [JAVA_COMPILER]
```

Über `flutter build apk` sehen Sie meist nur das Ende davon, eingepackt in `Gradle task assembleDebug failed with exit code 1`. Der Pfad in Anführungszeichen ist der entscheidende Teil. Es ist das Java-Home, das Gradle abgelehnt hat, und in neun von zehn Fällen haben Sie es nicht bewusst konfiguriert.

## Warum Gradle ein Java-Home beanstandet, das Sie nie konfiguriert haben

Diese Meldung stammt von Gradle, nicht von Flutter oder AGP. In Gradle 9.1.0 wird sie von `JavaToolchainQueryService` geworfen, und die umgebende Logik erklärt alles:

```java
// Gradle 9.1.0, JavaToolchainQueryService.resolveToolchain
boolean useFallback = !requestedSpec.isConfigured();
JavaToolchainSpec actualSpec = useFallback ? fallbackToolchainSpec : requestedSpec;
```

Ist im Build nirgends eine Toolchain konfiguriert, setzt Gradle eine Fallback-Spezifikation ein, die "die aktuelle JVM" bedeutet. Dieser Pfad sucht, filtert und sortiert nichts:

```java
// Gradle 9.1.0, JavaToolchainQueryService.query
if (spec instanceof CurrentJvmToolchainSpec) {
    return asToolchainOrThrow(
        InstallationLocation.autoDetected(currentJavaHome, "current JVM"),
        spec, requiredCapabilities, isFallback);
}
```

`asToolchainOrThrow` prüft genau diese eine Installation und wirft den Fehler, wenn eine benötigte Capability fehlt. Der konfigurierte Pfad, `findInstalledToolchain`, arbeitet dagegen alle erkannten Installationen durch einen Capability-Matcher ab und überspringt ungeeignete stillschweigend.

Dieser Unterschied ist die wichtigste Erkenntnis hier. Der Fehler bedeutet, dass Gradle ein einziges konkretes Java-Home übergeben bekam und dieses keinen Compiler enthält. Er bedeutet nicht "Gradle konnte kein JDK finden". Wenn Gradle tatsächlich keines findet, erscheint eine völlig andere Meldung, die weiter unten behandelt wird.

Er bedeutet außerdem, dass die Einstellungen zur automatischen Toolchain-Erkennung auf diesem Pfad irrelevant sind. Ich habe das bestätigt, indem ich dieselbe Task zweimal ausgeführt habe, einmal mit `-Dorg.gradle.java.installations.auto-detect=false` und einmal mit aktivierter Erkennung. Beide Male derselbe Fehler.

## Was Gradle bei JAVA_COMPILER tatsächlich prüft

Weniger, als man vermuten würde. Es gibt keine Analyse, keine Modulabfrage, keinen Versuch, eine Compiler-API aufzurufen. Es ist ein Test auf Dateiexistenz:

```java
// Gradle 9.1.0, JvmInstallationMetadata.gatherCapabilities
if (getToolByExecutable("javac").exists()) {
    capabilities.add(JavaInstallationCapability.JAVA_COMPILER);
}
if (getToolByExecutable("javadoc").exists()) {
    capabilities.add(JavaInstallationCapability.JAVADOC_TOOL);
}
if (getToolByExecutable("jar").exists()) {
    capabilities.add(JavaInstallationCapability.JAR_TOOL);
}
```

`getToolByExecutable` löst `<javaHome>/bin/<name>` mit der plattformspezifischen Dateiendung auf. Gradle stuft eine Installation nur dann als "JDK" ein, wenn alle drei vorhanden sind: `javac`, `javadoc` und `jar`. `JAVA_COMPILER` ist exakt `bin/javac`.

Die praktische Folge: Ein Java-Home, das in jeder Hinsicht ein JDK ist, dessen `bin`-Verzeichnis aber nicht buchstäblich `javac` enthält, wird als JRE gemeldet. Das betrifft `java-17-openjdk`-Pakete unter Fedora und Debian, die nur die Headless-Laufzeit mitbringen, ein altes `jre`-Unterverzeichnis innerhalb einer JDK-Installation und jedes Wrapper-Verzeichnis, das `java` weiterreicht, aber nicht die übrigen Werkzeuge.

## Reproduktion: ein JRE bauen und scheitern sehen

Sie brauchen dafür keine kaputte Maschine. Bauen Sie mit `jlink` ein Laufzeit-Image ohne die Compiler-Module, denn genau das ist ein JRE:

```bash
# JDK 21.0.11, jlink from the same JDK
MODS=$(java --list-modules | sed 's/@.*//' \
  | grep -vE '^(jdk\.compiler|jdk\.javadoc|jdk\.jshell|jdk\.jlink|jdk\.jdeps|jdk\.jpackage)$' \
  | paste -sd, -)
jlink --add-modules "$MODS" --no-header-files --no-man-pages --output ./real-jre-21
ls ./real-jre-21/bin/javac   # no such file
./real-jre-21/bin/java -version
# openjdk version "21.0.11" 2026-04-21 LTS
```

Der Ausschluss von `jdk.jpackage` ist wichtig. Es zieht `jdk.jlink` nach sich, das `jdk.jdeps` nach sich zieht, das wiederum `jdk.compiler` zurückholt, und am Ende steht der `javac`-Starter, den Sie vermeiden wollten.

Richten Sie nun Flutter darauf aus und kompilieren Sie eine frische `flutter create`-App:

```bash
# Flutter 3.44.2 stable, Gradle 9.1.0, AGP 9.0.1
flutter create --platforms=android toolchain_repro
flutter config --jdk-dir "$(pwd)/real-jre-21"
cd toolchain_repro && flutter build apk --debug
```

Das scheitert mit exakt dem Fehler vom Anfang dieses Beitrags, bei einem unveränderten Template ganz ohne Toolchain-Block.

## Welches Java verwendet ein Flutter-Build wirklich?

Hier geht die meiste Debugging-Zeit verloren, denn `JAVA_HOME` ist nicht das Erste, worauf Flutter schaut. Laut `packages/flutter_tools/lib/src/android/java.dart` in 3.44.2 liefert `_findJavaHome` den ersten Treffer in dieser Reihenfolge:

1. den Wert `jdk-dir` in Flutters eigener Konfiguration, gesetzt über `flutter config --jdk-dir`
2. das mit Android Studio ausgelieferte JDK
3. die Umgebungsvariable `JAVA_HOME`
4. das, worauf `java` im `PATH` verweist

Ein veraltetes `jdk-dir` schlägt also ein einwandfreies `JAVA_HOME`, dauerhaft und stillschweigend. Mir ist das beim Schreiben der Reproduktion passiert: Ich habe `JAVA_HOME` auf die beschnittene Laufzeit gesetzt, und der Build lief trotzdem durch, weil ein früher konfiguriertes `jdk-dir` gewann. Prüfen Sie Ihres, bevor Sie irgendetwas anderes ändern:

```bash
# Flutter 3.44.2
flutter config --list | grep jdk-dir
```

Bei Punkt 2 hängt der mitgelieferte Pfad von der Android-Studio-Version ab. Studio 2022 und neuer nutzen `<studio>/jbr`, unter macOS `<studio>/jbr/Contents/Home`. Ältere Versionen nutzen `<studio>/jre`. Wenn bei Ihnen noch eine alte Installation herumliegt, die Flutter weiterhin findet, ist dieses `jre`-Verzeichnis ein plausibler Verursacher.

Die Falle, die das schwer erkennbar macht: `flutter doctor` prüft nicht auf einen Compiler. Mit konfiguriertem JRE gibt es aus:

```text
[√] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Java binary at: /path/to/real-jre-21/bin/java
      This JDK is specified in your Flutter configuration.
    • Java version OpenJDK Runtime Environment Microsoft-13877171 (build 21.0.11+10-LTS)
```

Ein grüner Haken, und das Wort "JDK". Doctor führt `java --version` aus und wertet die Ausgabe aus, was ein JRE problemlos beantwortet. Nach `javac` sucht es nie. Falls Sie ohnehin einem Doctor-Problem nachgehen: `cmdline-tools component is missing` ist eine eigene Diagnose mit eigener Lösung.

## Wie richte ich Flutter auf ein echtes JDK aus?

Setzen Sie `jdk-dir` explizit und kompilieren Sie neu. Das ist die Lösung im Normalfall:

```bash
# Flutter 3.44.2
flutter config --jdk-dir "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
flutter build apk --debug
```

Prüfen Sie das Verzeichnis, bevor Sie es setzen. Die Prüfung, die Gradle durchführt, ist genau die, die Sie durchführen sollten:

```bash
ls "$YOUR_JDK/bin/javac"
```

Existiert diese Datei nicht, ist der Pfad ein JRE, unabhängig davon, wie das Verzeichnis heißt. Unter Debian und Ubuntu führt das Paket `openjdk-21-jre-headless` hierher, gebraucht wird `openjdk-21-jdk`. Unter macOS mit Homebrew installieren Sie `openjdk@21` und verwenden den versionierten Pfad, den Homebrew ausgibt, statt eines Shims.

Um zu `JAVA_HOME` und der normalen Reihenfolge zurückzukehren, entfernen Sie die Überschreibung:

```bash
# Flutter 3.44.2, empty value removes the setting
flutter config --jdk-dir ""
```

## Was überschreibt die JDK-Wahl von Flutter?

`android/gradle.properties` kann alles überschreiben, was Flutter entschieden hat. `org.gradle.java.home` legt die JVM fest, auf der der Gradle-Daemon läuft, und da der fehlschlagende Pfad "die aktuelle JVM" ist, reproduziert ein Verweis auf ein JRE den Fehler selbst dann, wenn `flutter config --jdk-dir` ein gültiges JDK ist. Ich habe genau diese Kombination verifiziert: korrektes `jdk-dir`, eine hinzugefügte Zeile, derselbe Fehler.

```properties
# android/gradle.properties, delete this line if it points at a JRE
org.gradle.java.home=/path/to/real-jre-21
```

Prüfen Sie dieselbe Property in `~/.gradle/gradle.properties`, die für jeden Build auf der Maschine gilt und leicht übersehen wird. Bestätigen Sie danach, was Gradle sieht:

```bash
# run from android/, Gradle 9.1.0
./gradlew -q javaToolchains
```

Der Bericht ist die schnellste verfügbare Diagnose, weil er die beiden entscheidenden Felder ausgibt:

```text
 + Microsoft JDK 21 (21.0.11+10-LTS)
     | Location:           C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot
     | Language Version:   21
     | Is JDK:             true
     | Detected by:        Current JVM

 + Oracle JDK 26 (26.0.2+10-55)
     | Location:           C:\Program Files\Java\jdk-26.0.2
     | Language Version:   26
     | Is JDK:             true
     | Detected by:        Windows Registry
```

Ein `Is JDK: false` bei dem Eintrag, dessen Location dem Pfad in Ihrer Fehlermeldung entspricht, bestätigt die Diagnose in einer Zeile.

## Behebt ein Toolchain-Block das Problem?

Der häufigste Ratschlag zu diesem Fehler lautet, in `android/app/build.gradle.kts` eine Toolchain zu deklarieren. Das ändert das Ergebnis tatsächlich, aber nicht immer in die gewünschte Richtung, denn es verschiebt den Build vom Pfad der aktuellen JVM auf den Matching-Pfad, auf dem Gradle nur Installationen akzeptiert, die es auch wirklich entdecken kann.

Ich habe genau das getestet. Mit weiterhin als `jdk-dir` konfiguriertem JRE führte das Hinzufügen von:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1, Gradle 9.1.0
java {
    toolchain { languageVersion = JavaLanguageVersion.of(21) }
}
```

zu einem anderen Fehler:

```text
> Cannot find a Java installation on your machine (Windows 11 10.0 amd64) matching:
  {languageVersion=21, vendor=any vendor, implementation=vendor-specific, nativeImageCapable=false}.
  Toolchain download repositories have not been configured.
```

Ein JDK 21 war die ganze Zeit installiert. Gradle fand es nicht, weil die automatische Erkennung es nie gesehen hatte: Sehen Sie sich die `javaToolchains`-Ausgabe oben noch einmal an, dort steht das Microsoft JDK 21 als `Detected by: Current JVM`. Sobald die aktuelle JVM das JRE war, verschwand dieser Eintrag aus der Kandidatenliste, und der Registry-Scan förderte nur ein JDK 26 zutage, das eine Anforderung von 21 nicht erfüllt.

Ein alleinstehender Toolchain-Block tauscht also einen klaren Fehler gegen einen vageren. Verwenden Sie ihn zusammen mit einem expliziten Installationspfad, nicht anstelle davon.

## Wie fixiere ich ein JDK für CI, damit das nicht zurückkommt?

Deklarieren Sie die Toolchain und teilen Sie Gradle mit, wo die Installationen liegen. Diese Kombination kompiliert selbst dann erfolgreich, wenn der Daemon auf einem JRE läuft, und genau das brauchen Sie auf einem Build-Agenten, auf dem Sie `JAVA_HOME` nicht kontrollieren:

```properties
# android/gradle.properties, Gradle 9.1.0
org.gradle.java.installations.paths=/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/21.0.11/x64
```

Zusammen mit dem `java { toolchain { ... } }`-Block oben war das die Konfiguration, die bei mir grün lief, während `jdk-dir` noch auf die Laufzeit ohne Compiler zeigte. Zwei verwandte Stellschrauben sind erwähnenswert: `org.gradle.java.installations.fromEnv=JDK21` liest Pfade aus benannten Umgebungsvariablen, was zu CI-Images passt, die diese ohnehin exportieren, und `org.gradle.java.installations.auto-detect=false` schaltet das Scannen komplett ab, sodass ein Agent ohne fixierte Pfade laut scheitert, statt etwas Beliebiges zu wählen.

Greifen Sie nicht zu `org.gradle.java.installations.auto-download=true` als Lösung. Gradle 9 stuft die Nutzung automatisch bereitgestellter Toolchains ohne deklarierte Toolchain-Repositories als veraltet ein und warnt, dass daraus in Gradle 10 ein Fehler wird.

## Varianten, die wie dieser Fehler aussehen, es aber nicht sind

`Toolchain installation '...' could not be probed` wird zwei Zeilen früher in derselben Methode geworfen und bedeutet, dass Gradle `java` überhaupt nicht ausführen konnte. Das ist eine defekte oder unvollständige Installation, ein Rechteproblem oder eine falsche Architektur, kein JRE.

`Cannot find a Java installation on your machine ... matching` ist der Pfad der konfigurierten Toolchain, der keinen Kandidaten findet. Die Lösung ist das Ergänzen des Installationspfads, wie oben.

`Unsupported class file major version` und `Gradle requires JVM 17 or later` sind Versionskonflikte, keine Capability-Fehler. Flutter 3.44.2 führt in `gradle_utils.dart` eine Java-Gradle-Kompatibilitätstabelle: Java 21 benötigt Gradle 8.4 oder neuer, Java 24 benötigt 8.14, Java 25 benötigt 9.1.0.

`Cannot add extension with name 'kotlin'` ist die eingebaute Kotlin-Unterstützung von AGP 9 im Konflikt mit dem alten Plugin `kotlin-android` und 2026 die andere häufige Ursache für ein fehlgeschlagenes `assembleDebug`.

## Verwandte Beiträge

- Flutter meldet Gradle-Fehler über eine Wrapper-Zeile, und der [eigentliche Fehler wird meist darüber abgeschnitten](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- Ein grüner Haken bei der Android-Toolchain kann trotzdem ein fehlendes Teil verbergen, etwa [die Komponente cmdline-tools](/de/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/).
- Ein weiterer Android-SDK-Fehler, der sich identisch wiederholt, bis Sie einen Cache leeren: [ein beschädigtes NDK-Archiv](/de/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- Weitere Build-brechende Einstellungen in `android/gradle.properties`: [die AndroidX- und Jetifier-Flags](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/).
- Versionskontext zu den hier genannten Toolchain-Standardwerten: [was sich in Flutter 3.44 geändert hat](/de/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).

## Quellen

- Gradle-Benutzerhandbuch, [Toolchains for JVM projects](https://docs.gradle.org/current/userguide/toolchains.html), zu Erkennungsquellen, Reihenfolge und Installations-Properties.
- Gradle-9.1.0-Quellcode, `JavaToolchainQueryService.java` und `JvmInstallationMetadata.java`, enthalten im `src`-Verzeichnis der Distribution `gradle-9.1.0-all`.
- Flutter-3.44.2-Quellcode, `packages/flutter_tools/lib/src/android/java.dart` für die Java-Suchreihenfolge und `gradle_utils.dart` für die festgelegten Gradle-, AGP- und Kotlin-Versionen.
- Gradle-Issues [#30499](https://github.com/gradle/gradle/issues/30499) und [#30421](https://github.com/gradle/gradle/issues/30421), in denen dieselbe Meldung gegen OpenJDK-Pakete unter Linux gemeldet wird.
