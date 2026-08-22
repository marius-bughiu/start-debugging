---
title: "Lösung: A restricted method in java.lang.System has been called in einem Flutter-Gradle-Build"
description: "Die JEP-472-Warnung ab JDK 24 ist harmlos und erscheint genau einmal. Die Lösung liegt darin, JDK und Gradle-Version aufeinander abzustimmen, nicht darin, Flags in gradle.properties zu kopieren."
pubDate: 2026-08-22
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "jdk"
lang: "de"
translationOf: "2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build"
translatedBy: "claude"
translationDate: 2026-08-22
---

Ihr Build ist in Ordnung. Dies ist eine Warnung ab JDK 24 aus [JEP 472](https://openjdk.org/jeps/472), die einmal pro aufrufendem Modul erscheint, wenn etwas eine native Bibliothek über `System.load` oder `System.loadLibrary` ohne `--enable-native-access` lädt. Aktuelle Gradle-Versionen übergeben dieses Flag bereits an den eigenen Daemon. Wenn Sie die Warnung sehen, ist also entweder Ihr JDK neuer als Ihr Gradle unterstützt, oder einer abgezweigten JVM im Build fehlt das Flag. Der Wechsel zurück auf das JDK 21, das Android Studio mitliefert, lässt sie vollständig verschwinden.

Alles Folgende wurde unter Windows 11 gemessen, mit Flutter 3.44.2 stable (Revision `c9a6c48423`), Gradle 9.1.0, JDK 26.0.2 (`26.0.2+10-55`) und Microsoft OpenJDK 21.0.11.

## Der Fehler im Kontext

```text
WARNING: A restricted method in java.lang.System has been called
WARNING: java.lang.System::load has been called by net.rubygrapefruit.platform.internal.NativeLibraryLoader in an unnamed module (file:/C:/Users/mariu/.gradle/wrapper/dists/gradle-9.1.0-all/7wzd0jkjit61aq2p43wpjgij9/gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
WARNING: Use --enable-native-access=ALL-UNNAMED to avoid a warning for callers in this module
WARNING: Restricted methods will be blocked in a future release unless native access is enabled
```

Die zweite Zeile variiert. `java.lang.System::loadLibrary` erscheint statt `::load`, wenn der Aufrufer einen Bibliotheksnamen statt eines absoluten Pfads übergeben hat, und die aufrufende Klasse ist diejenige, die den nativen Code tatsächlich geladen hat. `net.rubygrapefruit.platform.internal.NativeLibraryLoader` ist Gradles eigene native Integration. `com.sun.jna.Native` ist JNA, hereingezogen von einem Plugin.

## Was bedeutet "a restricted method in java.lang.System has been called"?

JEP 472, ausgeliefert in JDK 24, machte `System::load`, `System::loadLibrary`, `Runtime::load` und `Runtime::loadLibrary` zu eingeschränkten Methoden und das Binden einer nativen JNI-Methode zu einer eingeschränkten Operation. Eingeschränkt bedeutet, dass die JVM eine ausdrückliche Zustimmung verlangt, bevor Code die Laufzeitumgebung verlässt, denn eine fehlerhafte native Bibliothek kann den Heap auf eine Weise beschädigen, die die JVM nicht melden kann.

Die Zustimmung ist `--enable-native-access`. Ohne sie geben JDK 24 und neuer den obigen Vierzeiler aus und machen weiter. Drei Punkte lohnen sich, bevor Sie nach einer Lösung suchen:

Die Warnung erscheint **einmal pro aufrufendem Modul**, nicht einmal pro Aufruf. Eine Schleife, die drei Bibliotheken aus derselben Klasse lädt, gibt einen einzigen Block aus:

```java
// JDK 26.0.2, plain javac, no flags
public class MultiProbe {
    public static void main(String[] args) {
        for (int i = 0; i < 3; i++) {
            try { System.load("C:/Windows/System32/winhttp.dll"); }
            catch (Throwable t) { /* ignore */ }
        }
        System.out.println("DONE-MULTI");
    }
}
```

Das gibt einen Warnblock aus, gefolgt von `DONE-MULTI`. Wenn der Block mehrfach erscheint, sehen Sie mehrere verschiedene JVMs oder mehrere verschiedene Jars in einem Build-Log. Der Modulpfad in Zeile 2 jedes Blocks unterscheidet sie.

Der Standardmodus ist weiterhin `warn`. Dieselbe Klasse unter `--illegal-native-access=warn` auf JDK 26.0.2 erzeugt eine Ausgabe, die mit dem Lauf ganz ohne Flag identisch ist. Genau so bestätigen Sie, dass der Standard in Ihrem JDK noch nicht auf `deny` umgesprungen ist.

Und die letzte Zeile ist eine Prognose, kein Deprecation-Hinweis auf Ihren Code. "Blocked in a future release" bezieht sich auf ein zukünftiges JDK, nicht auf ein zukünftiges Gradle oder Flutter.

## Welche JDK-Versionen geben das aus, und warum JDK 21 nicht?

JDK 24 ist die Untergrenze. Diese Warnung existiert unter JDK 21 oder 17 nicht. Dieselbe Sonde auf Microsoft OpenJDK 21.0.11 gibt `DONE-MULTI` aus und sonst nichts.

Präzision lohnt sich hier, weil die Einschränkung in zwei Wellen kam. JDK 22 und 23 warnen vor eingeschränkten Methoden in der Foreign Function and Memory API, die Meldung nennt dort also `java.lang.foreign.Linker` oder Ähnliches. Die JNI-Hälfte, also die hier behandelte Variante `java.lang.System::load`, kam in JDK 24. Nennt Ihre Warnung `java.lang.System`, laufen Sie auf JDK 24 oder neuer.

Für Flutter ist das relevant, weil Flutter nicht das neueste JDK auf Ihrem Rechner wählt. Es löst eines auf, in dieser Reihenfolge, gemäß `packages/flutter_tools/lib/src/android/java.dart`:

1. Der von `flutter config --jdk-dir` gespeicherte Pfad.
2. Die mit Android Studio gebündelte JBR.
3. `JAVA_HOME`.
4. Das erste `java` im `PATH`.

Die mit Android Studio gebündelte JBR ist in aktuellen Releases eine 21, eine Standard-Flutter-Installation sieht diese Warnung also nie. Sie zu sehen bedeutet, dass Sie `jdk-dir` oder `JAVA_HOME` selbst auf ein JDK 24, 25 oder 26 gesetzt haben, meist als Nebenwirkung davon, "das neueste Java" über einen Paketmanager zu installieren. Welches im Spiel ist, zeigt `flutter doctor --verbose`, das die aufgelöste Java-Binärdatei samt Version ausgibt.

## Übergibt Gradle --enable-native-access bereits an seinen Daemon?

Ja, und das ändert die Lösung. Gradle liefert das Flag seit 8.14 mit. Die Logik liegt in `org.gradle.internal.jvm.JpmsConfiguration`, und der Bytecode in `gradle-base-services-8.14.jar` und in `gradle-base-services-9.1.0.jar` ist identisch: `forDaemonProcesses(int, boolean)` und `forWorkerProcesses(int, boolean)` vergleichen die Ziel-Java-Version mit `24`, und wenn sie 24 oder höher ist und der Boolean wahr ist, liefern sie eine Liste mit `--enable-native-access=ALL-UNNAMED`. Die Aufrufer, `DefaultDaemonStarter` und `DefaultWorkerProcessBuilder`, übergeben `NativeServices.NativeServicesMode.isPotentiallyEnabled()` als diesen Boolean.

Das lässt sich an einem laufenden Daemon nachsehen. Starten Sie irgendeinen Build und fragen Sie die JVM nach ihrer Kommandozeile:

```bash
# JDK 26.0.2 jcmd against a running Gradle 9.1.0 daemon
jps -l | grep GradleDaemon
jcmd <pid> VM.command_line
```

Auf einem Gradle-9.1.0-Daemon unter JDK 26.0.2 erscheint dort zwischen den `--add-opens`-Einträgen ein einzelnes `--enable-native-access=ALL-UNNAMED`. Zwei Folgerungen sind wichtig:

- Ein eigenes `org.gradle.jvmargs` überschreibt es nicht. Mit `org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G` in `gradle.properties` trägt die Kommandozeile des Daemons weiterhin `-Xmx4G`, `-XX:MaxMetaspaceSize=2G` **und** `--enable-native-access=ALL-UNNAMED`. Für Flutter ist das besonders relevant, weil das App-Template standardmäßig eine nicht leere `org.gradle.jvmargs`-Zeile mitbringt.
- `org.gradle.native=false` entfernt es dagegen, weil `isPotentiallyEnabled()` dann falsch liefert. Das ist keine Lösung, sondern Gradle, das seine native Integration komplett abschaltet, und damit fällt auch die Dateisystemüberwachung weg.

Eine Warnung, die `net.rubygrapefruit.platform.internal.NativeLibraryLoader` aus einem aktuellen Gradle-Daemon nennt, lässt sich also nicht per Flag flicken. Sie bedeutet, dass diese JVM Gradles Argumente nicht bekommen hat, und das deutet auf eines von drei Dingen hin: ein Gradle älter als 8.14, eine von einem Plugin statt von Gradles Worker-API abgezweigte JVM, oder eine IDE, die über die Tooling API mit Ihrem Build spricht. Gradles eigene 8.14-Release-Notes weisen auf Letzteres hin: Wer die Tooling API nutzt, muss den nativen Zugriff wegen ihrer JNI-Nutzung beim Start selbst aktivieren.

## Welche JVM im Build gibt die Warnung aus?

Arbeiten Sie von Zeile 2 aus nach außen. Sie nennt sowohl die aufrufende Klasse als auch das Jar, aus dem sie stammt, und dieses Paar genügt, um die JVM zu verorten:

- Aufrufer in einer `native-platform-*.jar` unter `~/.gradle/wrapper/dists/`, und `jcmd` zeigt, dass der Daemon das Flag hat: Die Warnung stammt aus einem anderen Prozess als dem geprüften Daemon, typischerweise einem abgezweigten Worker oder einem von einem Plugin gestarteten Compile-Daemon.
- Aufrufer in einer `jna-*.jar`: Ein Plugin hat JNA geladen. Zu finden mit `./gradlew :app:dependencies --configuration runtimeClasspath` aus dem Verzeichnis `android/` heraus, Suchbegriff `net.java.dev.jna`.
- Aufrufer in einer Jar unter `~/.gradle/caches/modules-2/`: Das ist eine Plugin-Abhängigkeit, nicht Gradle selbst, und der Plugin-Autor muss mit dem Flag abzweigen.

Da Flutter Gradle für Sie ausführt, sichern Sie zuerst die Rohausgabe:

```bash
# Flutter 3.44.2, run from the project root
flutter build apk --debug --verbose 2>&1 | tee build.log
grep -n "restricted method" -A 3 build.log
```

## Wie werde ich die Warnung los?

In der Reihenfolge der Empfehlung.

**Stimmen Sie Ihr JDK auf Ihre Gradle-Version ab.** Gradles Kompatibilitätsmatrix ist streng: Java 24 braucht Gradle 8.14 oder neuer, Java 25 braucht 9.1.0 oder neuer, Java 26 braucht 9.4.0 oder neuer. Flutter 3.44.2 erzeugt Projekte auf Gradle 9.1.0 mit AGP 9.0.1 und Kotlin 2.3.20, ein neues Projekt ist auf JDK 24 oder 25 also in Ordnung und für JDK 26 eine Version zu alt. Heben Sie den Wrapper in `android/gradle/wrapper/gradle-wrapper.properties` an:

```properties
# Flutter 3.44.2 default is gradle-9.1.0-all; 9.4.0+ is required for JDK 26
distributionUrl=https\://services.gradle.org/distributions/gradle-9.4.0-all.zip
```

Über die Matrix hinauszugehen warnt nicht nur. Gradle 9.1.0 auf JDK 26.0.2 lässt den Build schlicht scheitern:

```text
BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_' Unsupported class file major version 70
```

Flutter erkennt diesen Fall. `gradle_errors.dart` matcht `Unsupported class file major version\s+\d+` und gibt einen Kasten aus, der besagt, dass Ihre Gradle-Version mit der von Flutter verwendeten Java-Version unvereinbar ist, mit Verweis auf `flutter doctor --verbose`.

**Zeigen Sie Flutter auf das JDK, das Sie wirklich wollen.** Wenn Sie für dieses Projekt kein brandneues JDK brauchen, ist der kürzeste Weg, Flutter gar keines erst zu reichen:

```bash
# Flutter 3.44.2; persists to the Flutter config, survives JAVA_HOME changes
flutter config --jdk-dir "C:\Program Files\Android\Android Studio\jbr"
flutter doctor --verbose
```

Da `jdk-dir` in der Auflösungsreihenfolge über `JAVA_HOME` steht, gewinnt das gegen alles, was ein Paketmanager global gesetzt hat, und es betrifft nur Flutter.

**Ergänzen Sie das Flag an der JVM, der es fehlt.** Erst nachdem Sie diese JVM anhand von Zeile 2 identifiziert haben. Für den Gradle-Daemon auf einem älteren Gradle ist das `org.gradle.jvmargs` in `android/gradle.properties`, angehängt an das, was Flutters Template dort schon hinterlegt hat:

```properties
# Flutter 3.44.2 template default, plus the JEP 472 opt-in
org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError --enable-native-access=ALL-UNNAMED
```

Für einen Kotlin-Compile-Daemon lautet der entsprechende Schalter `kotlin.daemon.jvmargs`. Beachten Sie: Das ist eine echte Zustimmung mit echter Bedeutung, kein Stummschalter. Sie erklären damit, dass alles im Class Path nativen Code aufrufen darf.

## Ist --illegal-native-access=allow in gradle.properties unbedenklich?

Nein, und das ist die eine Änderung hier, die tatsächlich den Build einer Kollegin oder eines Kollegen zerstören kann.

`--illegal-native-access` kam zusammen mit JEP 472 in JDK 24. Unter JDK 21 existiert die Option nicht, und eine unbekannte `-`-Option ist beim JVM-Start fatal:

```text
Unrecognized option: --illegal-native-access=deny
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
```

Steht das in `org.gradle.jvmargs`, stirbt der Build für alle auf JDK 21, und dazu zählen jede Entwicklerin und jeder Entwickler mit der gebündelten Android-Studio-JBR sowie die meisten auf ein LTS festgelegten CI-Images. `--enable-native-access` ist an dieser Stelle sicherer, da es seit JDK 21 existiert und dort ohne Beanstandung akzeptiert wird, gehört aber trotzdem eher ins Projekt als in ein globales `GRADLE_OPTS`.

Der Wert `allow` hat ein zweites Problem: Es ist der Kompatibilitätsmodus, den JEP 472 als vorübergehend beschreibt, auslaufend und schließlich zu entfernen. Darauf zu bauen bedeutet, dass die Warnung in irgendeinem künftigen JDK als Fehler zurückkommt, nach dem Zeitplan anderer Leute.

## Was passiert, wenn aus der Warnung ein Fehler wird?

Das Ende lässt sich heute schon vorwegnehmen. Gradles eigene native Bibliothek auf JDK 26.0.2 unter `--illegal-native-access=deny` geladen:

```text
Exception in thread "main" net.rubygrapefruit.platform.NativeException: Failed to load native library 'native-platform.dll' for Windows 11 amd64.
	at net.rubygrapefruit.platform.internal.NativeLibraryLoader.load(NativeLibraryLoader.java:67)
	at net.rubygrapefruit.platform.Native.init(Native.java:60)
Caused by: java.lang.IllegalCallerException: Illegal native access from an unnamed module (file:/C:/.../gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
	at java.base/java.lang.Module.ensureNativeAccess(Module.java:311)
	at java.base/java.lang.System$1.ensureNativeAccess(System.java:2110)
```

Die `IllegalCallerException` ist der Anteil des JDK. Alles darüber ist die Fehlerbehandlung der Bibliothek selbst, und deshalb wird die künftige Fassung dieses Problems gar nicht wie ein Fehler beim nativen Zugriff aussehen. Sie sieht aus wie das, was die Bibliothek sagt, wenn eine `.dll` oder eine `.so` nicht geladen werden kann. Die CI mit `--illegal-native-access=deny` in einem JDK-24+-Job laufen zu lassen ist ein günstiger Weg, um herauszufinden, welches Ihrer Plugins zuerst bricht, solange Sie es aus der gemeinsamen `gradle.properties` heraushalten.

## Verwandte Beiträge

- [Toolchain installation does not provide the required capabilities: \[JAVA_COMPILER\]](/de/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/) behandelt die andere Hälfte der JDK-Geschichte in Flutter, bei der Gradle eine JRE statt eines JDK auflöst.
- [Gradle task assembleDebug failed with exit code 1](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) zeigt, wie sich der eigentliche Fehler aus einem Flutter-Android-Build-Log herausziehen lässt.
- [flutter doctor meldet, dass die Komponente cmdline-tools fehlt](/de/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) ist das Gegenstück, wenn `flutter doctor --verbose` selbst unzufrieden ist.
- [Flutter-UI überlappt die Android-Navigationsleiste nach Umstellung auf SDK 35](/de/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) ist ein weiterer Fall, in dem eine Änderung der Android-Plattform spät in einem Flutter-Projekt auftaucht.

## Quellen

- [JEP 472: Prepare to Restrict the Use of JNI](https://openjdk.org/jeps/472), das die eingeschränkten Methoden und die Zustimmung per `--enable-native-access` definiert.
- [JDK 24: Prepares Restricted Native Access](https://inside.java/2024/12/09/quality-heads-up/) auf Inside Java, der Quality-Outreach-Hinweis zur Änderung in JDK 24.
- [Gradle Java-Kompatibilitätsmatrix](https://docs.gradle.org/current/userguide/compatibility.html), für die von jedem Java-Release geforderte Gradle-Version.
- [Gradle 8.14 Release Notes](https://docs.gradle.org/8.14/release-notes.html), die Daemon-Unterstützung für Java 24 ergänzen und auf die JNI-Anforderung der Tooling API hinweisen.
- Quellen von Flutter 3.44.2: `packages/flutter_tools/lib/src/android/java.dart` für die Auflösungsreihenfolge des JDK und `packages/flutter_tools/lib/src/android/gradle_errors.dart` für den Handler zur Class-File-Version.
