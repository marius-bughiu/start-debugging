---
title: "Fix: Timeout waiting to lock journal cache in a Flutter Android build"
description: "Another Gradle process holds ~/.gradle/caches/journal-1 and cannot hand it over. Find the Owner PID, kill that daemon, and stop deleting .lock files: that only moves the error."
pubDate: 2026-10-05
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
---

A different Gradle process, the "Owner PID" in the message, holds the lock on `~/.gradle/caches/journal-1` and did not answer your build's request to release it within Gradle's fixed 60 second timeout. The fix is to find that process and kill it: `jps -l` (or `ps`) to confirm it is a `GradleDaemon`, then `kill -9 <Owner PID>` or `Stop-Process -Id <Owner PID> -Force` on Windows, and rerun `flutter run`. `./gradlew --stop` often does nothing here, because it only stops daemons of its own Gradle version. Deleting `journal-1.lock` does not fix it either: in my repro the next build simply timed out on the file hash cache instead.

Everything below was reproduced on macOS with Flutter 3.44.8 (whose template pins Gradle 9.1.0 and AGP 9.0.1), Gradle 9.3.1 and 8.14 distributions, and OpenJDK 17, using a throwaway `GRADLE_USER_HOME`. The lock code was read from the Gradle source at tag `v9.8.0`, the current release.

## The error in context

This is the exact output from my repro (paths shortened to `~`):

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

When Flutter drives the build you see the same block under `FAILURE: Build failed with an exception.`, followed by Flutter's own `Gradle task assembleDebug failed with exit code 1`. That last line is the messenger, not the cause.

Two details tell you which Gradle you are on. Gradle 8.x and older say "It is currently in use by another **Gradle instance**". From Gradle 9.0 the wording is "in use by another **process**". The `Owner Operation` and `Our operation` lines are almost always empty for the journal cache, so ignore them. The line that matters is `Owner PID`.

## Why Gradle cannot take the lock

`~/.gradle/caches/journal-1` records when each file in the shared caches was last used, so Gradle's cache cleanup knows what is safe to delete. Unlike `caches/9.1.0/` or `caches/8.14/`, it is **not versioned**: every Gradle version on the machine, every daemon, every IDE sync shares that one directory. That is why it is the lock people hit most often.

Gradle does not hold these locks for the length of a build. It takes them "on demand" and hands them over when someone else asks. The algorithm in `DefaultFileLockManager` is:

1. Try to take an OS file lock on the lock file's state region.
2. If that fails, read the owner's PID and UDP port from the lock file's info region, and ping the owner over loopback.
3. The owner, if it is not in the middle of using the cache, releases the lock and confirms.
4. Retry with exponential backoff until the lock is acquired or `DEFAULT_LOCK_TIMEOUT` (60,000 ms) runs out.

```java
// Gradle v9.8.0, DefaultFileLockManager.java
public static final int DEFAULT_LOCK_TIMEOUT = 60000;
```

The timeout is a constant passed in by `BasicGlobalScopeServices`. There is no Gradle property or system property to raise it, so "increase the lock timeout" is not an option.

So the error never means "a stale lock file is lying around". If the owner process had died, the operating system would have released its file lock and your build would have taken it immediately. It means **a live process owns the lock and did not answer the ping**. There are four realistic reasons:

- **The owner is hung.** A daemon thrashing in GC because it ran out of heap, stopped in a debugger, or suspended. It is alive, so the OS keeps its lock, but it cannot service the ping ([gradle/gradle#16299](https://github.com/gradle/gradle/issues/16299)).
- **The ping cannot reach it.** Endpoint security and firewall products (CrowdStrike, SentinelOne, Symantec WSS, Netskope, some VPN clients) have been known to drop Gradle's loopback UDP traffic. The macOS 15.1 firewall case is [gradle/gradle#31245](https://github.com/gradle/gradle/issues/31245), fixed in Gradle 8.12.1.
- **The owner is in another container.** Two CI containers that mount the same `~/.gradle` volume share the lock file but not the loopback interface, so pings never arrive ([gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750)). The Gradle docs say concurrent cache access "is only supported if the different Gradle processes can communicate together".
- **The file system does not do locks properly.** ExFAT, some network shares and some synced folders ([gradle/gradle#4329](https://github.com/gradle/gradle/issues/4329)).

On a Flutter developer machine the first cause dominates, because a Flutter project tends to have several Gradle clients pointed at it: `flutter run` from the terminal or VS Code, Android Studio's Gradle sync, and `flutter build apk` from a script. If they use different JDKs (Android Studio's bundled JBR vs `JAVA_HOME`) or different Gradle versions (two projects created by different Flutter releases), each one gets its own daemon, and all of them share `journal-1`.

## Minimal repro

You do not need Flutter or a phone to see it. A one-task Gradle project, a scratch Gradle user home and `kill -STOP` to simulate a hung daemon are enough:

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

These are the results I measured, each with the same scratch user home:

| Scenario | Result |
| --- | --- |
| Healthy idle 9.3.1 daemon, second 9.3.1 build | Succeeds in 2 s (the daemon hands the lock over) |
| Frozen 9.3.1 daemon, second 9.3.1 build | Fails after 62 s on `journal cache`, `Owner PID` = the frozen daemon |
| Frozen 9.3.1 daemon, `journal-1.lock` deleted, second build | Fails after 62 s on `file hash cache (caches/9.3.1/fileHashes)` instead |
| Frozen 9.3.1 daemon, `gradle --stop` (9.3.1) | Hangs at "Stopping Daemon(s)" (still waiting after 25 s) |
| Healthy 9.3.1 daemon, `gradle --stop` from Gradle 8.14 | Prints "No Gradle daemons are running." while the 9.3.1 daemon keeps running |
| Frozen 9.3.1 daemon, Gradle 8.14 build | Fails after 64 s on `journal cache`, with the older "another Gradle instance" wording |
| `kill -9` on the frozen daemon, then a build | Succeeds in 2 s |

The third and fifth rows are the ones that explain why this error has such a frustrating reputation.

## The fix, step by step

### 1. Identify the Owner PID

Take the PID from the error and look at it before you kill anything:

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

The command line includes the daemon's Gradle version and the JDK it runs on, which tells you who started it. A daemon under Android Studio's `jbr` folder came from an IDE sync. A `T` in the `stat` column on macOS or Linux means the process is stopped. If the PID belongs to a process that is not a Gradle daemon at all (a Kotlin compile daemon, a test JVM), note it, because that points at a build that forked a long-running JVM with your Gradle user home.

If the PID does not exist on your machine, the owner is somewhere else: another container or VM sharing the same `.gradle` directory. Skip to the CI section below.

### 2. Kill that process, not the lock file

```bash
# macOS / Linux (a stopped or hung JVM ignores a plain kill, so use -9)
kill -9 52907
```

```powershell
# Windows
Stop-Process -Id 52907 -Force
```

When the owner dies, the operating system releases its lock. Run `flutter run` again and the build starts normally. There is nothing to delete and no need for `flutter clean`, which does not touch `~/.gradle` anyway.

To clear every daemon of every version in one go (useful after a long day of switching between projects):

```bash
# macOS / Linux: stops all Gradle daemons regardless of version
jps -l | awk '/GradleDaemon/{print $1}' | xargs kill
```

`./gradlew --stop` inside `android/` is fine when the owner is a healthy daemon of the *same* Gradle version as your wrapper. The Gradle docs are explicit that it "terminates all Daemon processes started with the same version of Gradle used to execute the command". My repro shows both failure modes: a different-version `--stop` does not even see the owner, and a same-version `--stop` waits on a hung daemon instead of killing it.

### 3. Remove the reason it hung

If the same daemon keeps hanging, find out why before it happens again:

- **Heap.** The Flutter 3.44 template sets `org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G` in `android/gradle.properties`. Projects created by older Flutter versions often have much less, and a large app with R8 enabled can push a daemon into GC thrashing. Run `jstack <Owner PID>` before killing it: a dump full of GC or `OutOfMemoryError` frames confirms it.
- **Two JDKs.** Make Flutter and Android Studio use the same JDK so they share one daemon instead of two. `flutter doctor -v` prints the `Java binary at:` that Flutter uses. Point Android Studio's Gradle JDK setting at the same one, or point Flutter at Android Studio's with `flutter config --jdk-dir <path>`.
- **Security software.** If the error appears whenever two projects build at once and the owner is healthy, suspect a firewall or endpoint agent filtering loopback UDP. Upgrade the project's Gradle wrapper past 8.12.1 (projects from current Flutter templates already are), then ask IT for an exception for loopback traffic from your JDK.

## CI runners and Docker

On CI the Owner PID usually lives in a different job. Three setups work:

1. **One Gradle user home per job.** Set `GRADLE_USER_HOME` to a path inside the job's workspace and use the CI cache step to persist it between runs. No two live processes ever share a lock file.
2. **A shared read-only dependency cache.** Gradle's `GRADLE_RO_DEP_CACHE` points at a pre-populated `modules-2` directory that Gradle reads without locking, while each container keeps its own writable user home. The feature is still marked incubating in the Gradle docs, and the shared copy must never be written while builds read it.
3. **Do not leave daemons behind.** `flutter build apk --no-android-gradle-daemon` (the flag defaults to true in Flutter 3.44.8) passes `--no-daemon` to the wrapper, so the build's JVM exits when the build does. This does not prevent contention between two jobs that run at the same time, but it removes the most common owner: a daemon left over from the previous job on a reused runner.

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

Running containers with host networking also makes the pings work, but it gives up the isolation you wanted from containers, so I would reach for a per-job home first.

## Why "delete the .lock files" keeps coming back

The most upvoted advice for this error is `find ~/.gradle -type f -name "*.lock" -delete`. My repro shows what that does when the owner is still alive. The second build created a fresh `journal-1.lock`, locked it, and then timed out 60 seconds later on `caches/9.3.1/fileHashes/fileHashes.lock`, because the frozen daemon held that one too. Deleting every lock file lets the new build continue, but now two processes believe they own the same cache files. That is how people end up with `CorruptedCacheException` and a full `~/.gradle/caches` wipe, as reported in [gradle/gradle#30135](https://github.com/gradle/gradle/issues/30135).

When it appears to work, it is because the owner happened to finish or die in the meantime. Killing the owner gets you the same result without the corruption risk.

## Lookalikes

- **`Timeout waiting to lock file hash cache`, `build cache`, `Generated Gradle JARs cache`, `artifact cache`.** Same mechanism and same fix: find the Owner PID and kill it. Only the cache name changes.
- **`Timeout waiting to lock ... It is currently in use by this process.`** No `Owner PID` line. The contention is between two threads in one build, usually a plugin or test kit misuse ([gradle/gradle#35592](https://github.com/gradle/gradle/issues/35592)). Killing daemons will not help.
- **`Gradle task assembleDebug failed with exit code 1`** on its own. That is Flutter summarizing whatever Gradle failed on. See [how to read the real error behind assembleDebug failed](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- **`e: Daemon compilation failed: null`.** Despite the word "daemon", that is the Kotlin compile daemon and a cross-drive path bug, covered in [the Daemon compilation failed fix](/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/).

## Related

- [Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) explains how to get Gradle's own error block out of a Flutter build.
- [Migrating a Flutter Android project to AGP 9 with built-in Kotlin](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/) covers the Gradle and AGP versions newer templates pin.
- [Fix: A restricted method in java.lang.System has been called](/2026/08/fix-a-restricted-method-in-java-lang-system-has-been-called-in-a-flutter-gradle-build/) is another case where the JDK running your Gradle daemon matters.
- [Targeting multiple Flutter versions from one CI pipeline](/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) shows matrix builds, where per-job Gradle homes pay off.

## Sources

- Gradle source, [`DefaultFileLockManager.java` at v9.8.0](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/DefaultFileLockManager.java) and [`DefaultFileLockContentionHandler.java`](https://github.com/gradle/gradle/blob/v9.8.0/platforms/core-execution/persistent-cache/src/main/java/org/gradle/cache/internal/locklistener/DefaultFileLockContentionHandler.java).
- Gradle docs: [The Gradle Daemon](https://docs.gradle.org/current/userguide/gradle_daemon.html) (`--stop` scope, daemon compatibility) and [Dependency caching](https://docs.gradle.org/current/userguide/dependency_caching.html) (cache locking, `GRADLE_RO_DEP_CACHE`).
- [gradle/gradle#8750](https://github.com/gradle/gradle/issues/8750), [#16299](https://github.com/gradle/gradle/issues/16299), [#31245](https://github.com/gradle/gradle/issues/31245), [#30135](https://github.com/gradle/gradle/issues/30135), [#8375](https://github.com/gradle/gradle/issues/8375).
- Flutter 3.44.8 `flutter_tools`, `lib/src/android/gradle.dart` and `lib/src/runner/flutter_command.dart` (the `--android-gradle-daemon` flag).
