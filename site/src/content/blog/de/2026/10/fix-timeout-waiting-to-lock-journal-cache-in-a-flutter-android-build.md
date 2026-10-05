---
title: "Fix: Timeout waiting to lock journal cache in einem Flutter-Android-Build"
description: "Ein anderer Gradle-Prozess hält ~/.gradle/caches/journal-1 und gibt die Sperre nicht frei. Finden Sie die Owner PID, beenden Sie diesen Daemon und löschen Sie keine .lock-Dateien mehr: Das verschiebt den Fehler nur."
pubDate: 2026-10-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
lang: "de"
translationOf: "2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-10-05
---

Ein anderer Gradle-Prozess, die "Owner PID" in der Meldung, hält die Sperre auf `~/.gradle/caches/journal-1` und hat auf die Anfrage Ihres Builds, sie freizugeben, innerhalb des festen 60-Sekunden-Timeouts von Gradle nicht geantwortet. Die Lösung besteht darin, diesen Prozess zu finden und zu beenden: mit `jps -l` (oder `ps`) prüfen, ob es ein `GradleDaemon` ist, dann `kill -9 <Owner PID>` bzw. unter Windows `Stop-Process -Id <Owner PID> -Force` ausführen und `flutter run` erneut starten. `./gradlew --stop` bewirkt hier oft nichts, weil es nur Daemons der eigenen Gradle-Version beendet. Auch das Löschen von `journal-1.lock` hilft nicht: In meiner Reproduktion lief der nächste Build stattdessen beim File-Hash-Cache in den Timeout.

Alles Folgende habe ich unter macOS mit Flutter 3.44.8 (dessen Template Gradle 9.1.0 und AGP 9.0.1 festlegt), den Gradle-Distributionen 9.3.1 und 8.14 sowie OpenJDK 17 reproduziert, mit einem Wegwerf-`GRADLE_USER_HOME`. Den Sperrcode habe ich im Gradle-Quelltext am Tag `v9.8.0` gelesen, dem aktuellen Release.

## Der Fehler im Kontext

Dies ist die exakte Ausgabe aus meiner Reproduktion (Pfade zu `~` gekürzt):

```text
FAILURE: Build failed with an exception.

* What went wrong:
Gradle could not start your build.
> Cannot create service of type BuildSessionActionExecutor using method LauncherServices$ToolingBuildSessionScopeServices.createActionExecutor() as there is a problem with parameter #21 of type BuildLifecycleAwareVirtualFileSystem.
   ...
            > Could not create service of type FileAccessTimeJournal using GradleUserHomeScopeServices.createFileAccessTimeJournal().
               > Timeout waiting to lock journal cache (~/.gradle/caches/journal-1). It is currently in use by another process.
                 Owner PID: 52907
                 Our PID: 52963
                 Owner Operation: 
                 Our operation: 
                 Lock file: ~/.gradle/caches/journal-1/journal-1.lock

BUILD FAILED in 1m 1s
```

Wenn Flutter den Build ausführt, sehen Sie denselben Block unter `FAILURE: Build failed with an exception.`, gefolgt von Flutters eigenem `Gradle task assembleDebug failed with exit code 1`. Diese letzte Zeile ist nur der Bote, nicht die Ursache.

Zwei Details verraten, welche Gradle-Version Sie verwenden. Gradle 8.x und älter schreiben "It is currently in use by another **Gradle instance**". Ab Gradle 9.0 lautet die Formulierung "in use by another **process**". Die Zeilen `Owner Operation` und `Our operation` sind beim Journal-Cache fast immer leer, ignorieren Sie sie also. Entscheidend ist die Zeile `Owner PID`.

## Warum Gradle die Sperre nicht bekommt

`~/.gradle/caches/journal-1` hält fest, wann jede Datei in den gemeinsamen Caches zuletzt verwendet wurde, damit die Cache-Bereinigung von Gradle weiß, was sich gefahrlos löschen lässt. Anders als `caches/9.1.0/` oder `caches/8.14/` ist es **nicht versioniert**: Jede Gradle-Version auf dem Rechner, jeder Daemon und jede IDE-Synchronisierung teilen sich dieses eine Verzeichnis. Deshalb ist es die Sperre, auf die man am häufigsten stößt.

Gradle hält diese Sperren nicht für die Dauer eines Builds. Es nimmt sie "bei Bedarf" und gibt sie weiter, wenn jemand anderes danach fragt. Der Algorithmus in `DefaultFileLockManager` sieht so aus:

1. Versuchen, eine Betriebssystem-Dateisperre auf den Zustandsbereich der Sperrdatei zu legen.
2. Schlägt das fehl, die PID und den UDP-Port des Besitzers aus dem Info-Bereich der Sperrdatei lesen und den Besitzer über Loopback anpingen.
3. Der Besitzer gibt die Sperre frei und bestätigt dies, sofern er den Cache gerade nicht benutzt.
4. Mit exponentiellem Backoff wiederholen, bis die Sperre erworben wurde oder `DEFAULT_LOCK_TIMEOUT` (60.000 ms) abgelaufen ist.

```java
// Gradle v9.8.0, DefaultFileLockManager.java
public static final int DEFAULT_LOCK_TIMEOUT = 60000;
```

Der Timeout ist eine Konstante, die von `BasicGlobalScopeServices` übergeben wird. Es gibt keine Gradle-Eigenschaft und keine Systemeigenschaft, um ihn zu erhöhen, "den Lock-Timeout erhöhen" ist also keine Option.

Der Fehler bedeutet also nie, dass irgendwo eine veraltete Sperrdatei herumliegt. Wäre der Besitzerprozess gestorben, hätte das Betriebssystem seine Dateisperre freigegeben und Ihr Build hätte sie sofort bekommen. Er bedeutet: **Ein lebender Prozess besitzt die Sperre und hat den Ping nicht beantwortet.** Dafür gibt es vier realistische Gründe:

- **Der Besitzer hängt.** Ein Daemon, der im GC-Thrashing steckt, weil ihm der Heap ausgegangen ist, der in einem Debugger angehalten oder suspendiert wurde. Er lebt, also behält das Betriebssystem seine Sperre, aber er kann den Ping nicht bedienen ([gradle/gradle#16299](https://github.com/gradle/gradle/issues/16299)).
- **Der Ping erreicht ihn nicht.** Von Endpoint-Security- und Firewall-Produkten (CrowdStrike, SentinelOne, Symantec WSS, Netskope, manche VPN-Clients) ist bekannt, dass sie den UDP-Loopback-Verkehr von Gradle verwerfen. Der Fall mit der Firewall von macOS 15.1 ist [gradle/gradle#31245](https://github.com/gradle/gradle/issues/31245), behoben in Gradle 8.12.1.
- **Der Besitzer läuft in einem anderen Container.** Zwei CI-Container, die dasselbe `~/.gradle`-Volume einbinden, teilen sich die Sperrdatei, aber nicht das Loopback-Interface, sodass Pings nie ankommen ([gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750)). Die Gradle-Dokumentation sagt, gleichzeitiger Cache-Zugriff werde "nur unterstützt, wenn die verschiedenen Gradle-Prozesse miteinander kommunizieren können" (englisch: "is only supported if the different Gradle processes can communicate together").
- **Das Dateisystem unterstützt Sperren nicht korrekt.** ExFAT, einige Netzwerkfreigaben und einige synchronisierte Ordner ([gradle/gradle#4329](https://github.com/gradle/gradle/issues/4329)).

Auf einem Flutter-Entwicklungsrechner dominiert die erste Ursache, weil auf ein Flutter-Projekt meist mehrere Gradle-Clients zugreifen: `flutter run` im Terminal oder in VS Code, die Gradle-Synchronisierung von Android Studio und `flutter build apk` aus einem Skript. Verwenden sie unterschiedliche JDKs (das mitgelieferte JBR von Android Studio gegenüber `JAVA_HOME`) oder unterschiedliche Gradle-Versionen (zwei Projekte, die mit verschiedenen Flutter-Releases erstellt wurden), bekommt jeder seinen eigenen Daemon, und alle teilen sich `journal-1`.

## Minimale Reproduktion

Sie brauchen weder Flutter noch ein Telefon, um das zu sehen. Ein Gradle-Projekt mit einer Aufgabe, ein separates Gradle-Benutzerverzeichnis und `kill -STOP`, um einen hängenden Daemon zu simulieren, genügen:

```bash
# macOS 26, OpenJDK 17, Gradle 9.3.1 (same 9.x error wording as Gradle 9.1.0 in the Flutter 3.44 template)
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export GRADLE_USER_HOME=/tmp/guh          # keep your real ~/.gradle out of it
mkdir -p /tmp/plain && cd /tmp/plain
echo "rootProject.name = 'plain'" > settings.gradle
echo "tasks.register('hello') { doLast { println 'hello' } }" > build.gradle

gradle hello -q                           # starts a daemon, which keeps journal-1 on demand
PID=$(jps -l | awk '/GradleDaemon/{print $1}')
kill -STOP "$PID"                         # the daemon is alive but cannot answer pings

gradle hello --no-daemon                  # fails after ~60 s: Timeout waiting to lock journal cache
kill -CONT "$PID"
```

Dies sind die gemessenen Ergebnisse, jeweils mit demselben separaten Benutzerverzeichnis:

| Szenario | Ergebnis |
| --- | --- |
| Gesunder, inaktiver 9.3.1-Daemon, zweiter 9.3.1-Build | Erfolgreich in 2 s (der Daemon gibt die Sperre weiter) |
| Eingefrorener 9.3.1-Daemon, zweiter 9.3.1-Build | Schlägt nach 62 s bei `journal cache` fehl, `Owner PID` = der eingefrorene Daemon |
| Eingefrorener 9.3.1-Daemon, `journal-1.lock` gelöscht, zweiter Build | Schlägt nach 62 s stattdessen bei `file hash cache (caches/9.3.1/fileHashes)` fehl |
| Eingefrorener 9.3.1-Daemon, `gradle --stop` (9.3.1) | Hängt bei "Stopping Daemon(s)" (wartet nach 25 s immer noch) |
| Gesunder 9.3.1-Daemon, `gradle --stop` von Gradle 8.14 | Gibt "No Gradle daemons are running." aus, während der 9.3.1-Daemon weiterläuft |
| Eingefrorener 9.3.1-Daemon, Gradle-8.14-Build | Schlägt nach 64 s bei `journal cache` fehl, mit der älteren Formulierung "another Gradle instance" |
| `kill -9` auf den eingefrorenen Daemon, danach ein Build | Erfolgreich in 2 s |

Die dritte und die fünfte Zeile erklären, warum dieser Fehler so einen frustrierenden Ruf hat.

## Die Lösung, Schritt für Schritt

### 1. Die Owner PID identifizieren

Nehmen Sie die PID aus dem Fehler und sehen Sie sich den Prozess an, bevor Sie etwas beenden:

```bash
# macOS / Linux, any Gradle version
ps -o pid,stat,etime,command -p 52907
jps -l                                    # lists every JVM; Gradle daemons show as org.gradle.launcher.daemon.bootstrap.GradleDaemon
```

```powershell
# Windows PowerShell, any Gradle version
Get-CimInstance Win32_Process -Filter "ProcessId = 52907" | Select-Object ProcessId, CommandLine
Get-CimInstance Win32_Process -Filter "Name = 'java.exe'" |
  Where-Object CommandLine -match 'GradleDaemon' |
  Select-Object ProcessId, CommandLine
```

Die Befehlszeile enthält die Gradle-Version des Daemons und das JDK, auf dem er läuft, und verrät damit, wer ihn gestartet hat. Ein Daemon im `jbr`-Ordner von Android Studio stammt aus einer IDE-Synchronisierung. Ein `T` in der Spalte `stat` unter macOS oder Linux bedeutet, dass der Prozess angehalten ist. Gehört die PID zu einem Prozess, der gar kein Gradle-Daemon ist (ein Kotlin-Compile-Daemon, eine Test-JVM), notieren Sie das, denn es deutet auf einen Build hin, der mit Ihrem Gradle-Benutzerverzeichnis eine langlebige JVM abgespalten hat.

Existiert die PID auf Ihrem Rechner nicht, liegt der Besitzer woanders: in einem anderen Container oder einer VM, die dasselbe `.gradle`-Verzeichnis teilt. Springen Sie dann zum Abschnitt über CI weiter unten.

### 2. Den Prozess beenden, nicht die Sperrdatei

```bash
# macOS / Linux (a stopped or hung JVM ignores a plain kill, so use -9)
kill -9 52907
```

```powershell
# Windows
Stop-Process -Id 52907 -Force
```

Wenn der Besitzer stirbt, gibt das Betriebssystem seine Sperre frei. Starten Sie `flutter run` erneut, und der Build läuft normal an. Es gibt nichts zu löschen und `flutter clean` ist nicht nötig, das `~/.gradle` ohnehin nicht anfasst.

So beenden Sie alle Daemons aller Versionen auf einmal (nützlich nach einem langen Tag mit Wechseln zwischen Projekten):

```bash
# macOS / Linux: stops all Gradle daemons regardless of version
jps -l | awk '/GradleDaemon/{print $1}' | xargs kill
```

`./gradlew --stop` im Verzeichnis `android/` genügt, wenn der Besitzer ein gesunder Daemon derselben Gradle-Version wie Ihr Wrapper ist. Die Gradle-Dokumentation ist eindeutig: Der Befehl beende alle Daemon-Prozesse, die mit derselben Gradle-Version wie der ausführende Befehl gestartet wurden (englisch: "terminates all Daemon processes started with the same version of Gradle used to execute the command"). Meine Reproduktion zeigt beide Fehlerfälle: Ein `--stop` einer anderen Version sieht den Besitzer gar nicht, und ein `--stop` derselben Version wartet auf einen hängenden Daemon, statt ihn zu beenden.

### 3. Die Ursache fürs Hängen beseitigen

Wenn derselbe Daemon immer wieder hängt, finden Sie heraus, warum, bevor es erneut passiert:

- **Heap.** Das Flutter-3.44-Template setzt `org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G` in `android/gradle.properties`. Projekte, die mit älteren Flutter-Versionen erstellt wurden, haben oft deutlich weniger, und eine große App mit aktiviertem R8 kann einen Daemon ins GC-Thrashing treiben. Führen Sie `jstack <Owner PID>` aus, bevor Sie ihn beenden: Ein Dump voller GC- oder `OutOfMemoryError`-Frames bestätigt es.
- **Zwei JDKs.** Sorgen Sie dafür, dass Flutter und Android Studio dasselbe JDK verwenden, damit sie sich einen Daemon teilen statt zwei zu starten. `flutter doctor -v` gibt das `Java binary at:` aus, das Flutter verwendet. Stellen Sie die Gradle-JDK-Einstellung von Android Studio auf dasselbe JDK ein, oder lassen Sie Flutter mit `flutter config --jdk-dir <path>` auf das JDK von Android Studio zeigen.
- **Sicherheitssoftware.** Tritt der Fehler immer auf, wenn zwei Projekte gleichzeitig gebaut werden, und der Besitzer ist gesund, vermuten Sie eine Firewall oder einen Endpoint-Agenten, der UDP-Loopback-Verkehr filtert. Aktualisieren Sie den Gradle-Wrapper des Projekts über 8.12.1 hinaus (Projekte aus aktuellen Flutter-Templates sind es bereits) und bitten Sie dann die IT um eine Ausnahme für Loopback-Verkehr Ihres JDK.

## CI-Runner und Docker

In CI lebt die Owner PID meist in einem anderen Job. Drei Setups funktionieren:

1. **Ein Gradle-Benutzerverzeichnis pro Job.** Setzen Sie `GRADLE_USER_HOME` auf einen Pfad im Workspace des Jobs und nutzen Sie den CI-Cache-Schritt, um es zwischen Läufen zu erhalten. So teilen nie zwei lebende Prozesse eine Sperrdatei.
2. **Ein gemeinsamer schreibgeschützter Abhängigkeits-Cache.** `GRADLE_RO_DEP_CACHE` von Gradle verweist auf ein vorab befülltes `modules-2`-Verzeichnis, das Gradle ohne Sperren liest, während jeder Container sein eigenes beschreibbares Benutzerverzeichnis behält. Die Funktion ist in der Gradle-Dokumentation noch als incubating markiert, und die gemeinsame Kopie darf nie beschrieben werden, solange Builds sie lesen.
3. **Keine Daemons zurücklassen.** `flutter build apk --no-android-gradle-daemon` (das Flag ist in Flutter 3.44.8 standardmäßig true) übergibt `--no-daemon` an den Wrapper, sodass die JVM des Builds mit dem Build endet. Das verhindert keine Konkurrenz zwischen zwei gleichzeitig laufenden Jobs, beseitigt aber den häufigsten Besitzer: einen Daemon, der vom vorherigen Job auf einem wiederverwendeten Runner übrig geblieben ist.

```yaml
# GitHub Actions, Flutter 3.44.8: per-job Gradle home, cached between runs
env:
  GRADLE_USER_HOME: ${{ github.workspace }}/.gradle-home
steps:
  - uses: actions/cache@v4
    with:
      path: ${{ github.workspace }}/.gradle-home/caches
      key: gradle-${{ runner.os }}-${{ hashFiles('android/**/*.gradle*', 'android/gradle/wrapper/gradle-wrapper.properties') }}
  - run: flutter build apk --release --no-android-gradle-daemon
```

Container mit Host-Networking lassen die Pings ebenfalls funktionieren, geben dafür aber die Isolation auf, die man von Containern wollte. Ich würde daher zuerst zu einem Benutzerverzeichnis pro Job greifen.

## Warum der Tipp "die .lock-Dateien löschen" immer wiederkehrt

Der meistbewertete Rat zu diesem Fehler lautet `find ~/.gradle -type f -name "*.lock" -delete`. Meine Reproduktion zeigt, was das bewirkt, solange der Besitzer noch lebt. Der zweite Build legte eine frische `journal-1.lock` an, sperrte sie und lief 60 Sekunden später bei `caches/9.3.1/fileHashes/fileHashes.lock` in den Timeout, weil der eingefrorene Daemon auch diese Sperre hielt. Werden alle Sperrdateien gelöscht, kann der neue Build zwar weiterlaufen, aber nun glauben zwei Prozesse, dieselben Cache-Dateien zu besitzen. So landen Leute bei `CorruptedCacheException` und einem vollständigen Leeren von `~/.gradle/caches`, wie in [gradle/gradle#30135](https://github.com/gradle/gradle/issues/30135) berichtet.

Wenn es scheinbar funktioniert, liegt das daran, dass der Besitzer zufällig zwischenzeitlich fertig wurde oder gestorben ist. Den Besitzer zu beenden führt zum selben Ergebnis, ohne das Risiko einer Beschädigung.

## Ähnliche Fehler

- **`Timeout waiting to lock file hash cache`, `build cache`, `Generated Gradle JARs cache`, `artifact cache`.** Gleicher Mechanismus und gleiche Lösung: Owner PID finden und beenden. Nur der Name des Caches ändert sich.
- **`Timeout waiting to lock ... It is currently in use by this process.`** Keine Zeile `Owner PID`. Der Konflikt besteht zwischen zwei Threads innerhalb eines Builds, meist durch Fehlgebrauch eines Plugins oder Test Kits ([gradle/gradle#35592](https://github.com/gradle/gradle/issues/35592)). Das Beenden von Daemons hilft nicht.
- **`Gradle task assembleDebug failed with exit code 1`** allein. Das ist Flutters Zusammenfassung dessen, woran Gradle gescheitert ist. Siehe [wie Sie den echten Fehler hinter assembleDebug failed lesen](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- **`e: Daemon compilation failed: null`.** Trotz des Wortes "Daemon" ist das der Kotlin-Compile-Daemon und ein Pfadfehler über Laufwerksgrenzen hinweg, behandelt in [der Lösung für Daemon compilation failed](/de/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/).

## Verwandte Artikel

- [Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) erklärt, wie Sie den eigenen Fehlerblock von Gradle aus einem Flutter-Build herausholen.
- [Ein Flutter-Android-Projekt mit integriertem Kotlin auf AGP 9 migrieren](/de/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) behandelt die Gradle- und AGP-Versionen, die neuere Templates festlegen.
- [Fix: A restricted method in java.lang.System has been called](/de/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/) ist ein weiterer Fall, in dem das JDK Ihres Gradle-Daemons eine Rolle spielt.
- [Mehrere Flutter-Versionen aus einer CI-Pipeline anvisieren](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) zeigt Matrix-Builds, bei denen sich Gradle-Verzeichnisse pro Job auszahlen.

## Quellen

- Gradle-Quelltext, [`DefaultFileLockManager.java` bei v9.8.0](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/DefaultFileLockManager.java) und [`DefaultFileLockContentionHandler.java`](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/locklistener/DefaultFileLockContentionHandler.java).
- Gradle-Dokumentation: [The Gradle Daemon](https://docs.gradle.org/current/userguide/gradle_daemon.html) (Reichweite von `--stop`, Daemon-Kompatibilität) und [Dependency caching](https://docs.gradle.org/current/userguide/dependency_caching.html) (Cache-Sperren, `GRADLE_RO_DEP_CACHE`).
- [gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750), [#16299](https://github.com/gradle/gradle/issues/16299), [#31245](https://github.com/gradle/gradle/issues/31245), [#30135](https://github.com/gradle/gradle/issues/30135), [#8375](https://github.com/gradle/gradle/issues/8375).
- Flutter 3.44.8 `flutter_tools`, `lib/src/android/gradle.dart` und `lib/src/runner/flutter_command.dart` (das Flag `--android-gradle-daemon`).
