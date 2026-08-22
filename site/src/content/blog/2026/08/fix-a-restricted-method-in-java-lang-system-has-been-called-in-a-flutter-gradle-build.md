---
title: "Fix: A restricted method in java.lang.System has been called in a Flutter Gradle build"
description: "The JEP 472 warning on JDK 24+ is harmless and prints once. Fix it by matching your JDK to a Gradle version that supports it, not by pasting flags into gradle.properties."
pubDate: 2026-08-22
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "jdk"
---

Your build is fine. This is a JDK 24 and newer warning from [JEP 472](https://openjdk.org/jeps/472), printed once per calling module when something loads a native library through `System.load` or `System.loadLibrary` without `--enable-native-access`. Current Gradle already passes that flag to its own daemon, so if you are seeing this, either your JDK is newer than your Gradle supports or a forked JVM in the build is missing the flag. Downgrading to the JDK 21 that Android Studio bundles makes it disappear entirely.

Everything below was measured on Windows 11 with Flutter 3.44.2 stable (revision `c9a6c48423`), Gradle 9.1.0, JDK 26.0.2 (`26.0.2+10-55`), and Microsoft OpenJDK 21.0.11.

## The error in context

```text
WARNING: A restricted method in java.lang.System has been called
WARNING: java.lang.System::load has been called by net.rubygrapefruit.platform.internal.NativeLibraryLoader in an unnamed module (file:/C:/Users/mariu/.gradle/wrapper/dists/gradle-9.1.0-all/7wzd0jkjit61aq2p43wpjgij9/gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
WARNING: Use --enable-native-access=ALL-UNNAMED to avoid a warning for callers in this module
WARNING: Restricted methods will be blocked in a future release unless native access is enabled
```

The second line varies. `java.lang.System::loadLibrary` appears instead of `::load` when the caller passed a library name rather than an absolute path, and the caller class is whatever actually loaded the native code. `net.rubygrapefruit.platform.internal.NativeLibraryLoader` is Gradle's own native integration. `com.sun.jna.Native` is JNA, pulled in by a plugin.

## What does "a restricted method in java.lang.System has been called" mean?

JEP 472, delivered in JDK 24, made `System::load`, `System::loadLibrary`, `Runtime::load` and `Runtime::loadLibrary` restricted methods, and made binding a JNI `native` method a restricted operation. Restricted means the JVM wants an explicit opt-in before code reaches outside the runtime, because a bad native library can corrupt the heap in ways the JVM cannot report.

The opt-in is `--enable-native-access`. Without it, JDK 24 and later print the four-line block above and carry on. Three things are worth knowing before you go looking for a fix:

The warning is emitted **once per calling module**, not once per call. A loop that loads three libraries from the same class prints one block:

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

That prints one warning block followed by `DONE-MULTI`. If you are seeing the block repeated, you are looking at several different JVMs, or several different jars, in one build log. Read the module path on line 2 of each block to tell them apart.

The default mode is still `warn`. Running the same class under `--illegal-native-access=warn` on JDK 26.0.2 produces output identical to running it with no flag at all, which is how you confirm the default has not flipped to `deny` in the JDK you are on.

And the last line is a forecast, not a deprecation notice about your code. "Blocked in a future release" refers to a future JDK, not a future Gradle or Flutter.

## Which JDK versions print this, and why does JDK 21 not?

JDK 24 is the floor. This warning does not exist on JDK 21 or 17. Running the same probe on Microsoft OpenJDK 21.0.11 prints `DONE-MULTI` and nothing else.

It is worth being precise here because the restriction arrived in two waves. JDK 22 and 23 warn about restricted methods in the Foreign Function and Memory API, so the message names `java.lang.foreign.Linker` or similar. The JNI half, which is the `java.lang.System::load` variant you are reading about, landed in JDK 24. If your warning names `java.lang.System`, you are on JDK 24 or later.

That matters for Flutter because Flutter does not pick the newest JDK on your machine. It resolves one, in this order, from `packages/flutter_tools/lib/src/android/java.dart`:

1. The path stored by `flutter config --jdk-dir`.
2. The JBR bundled with Android Studio.
3. `JAVA_HOME`.
4. The first `java` on `PATH`.

Android Studio's bundled JBR is a 21 for current releases, so a default Flutter install never sees this warning. Seeing it means you set `jdk-dir` or `JAVA_HOME` to a JDK 24, 25 or 26 yourself, most often as a side effect of installing "latest Java" from a package manager. Confirm which one is in play with `flutter doctor --verbose`, which prints the resolved Java binary and its version.

## Does the Gradle daemon already pass --enable-native-access?

Yes, and this is the part that changes the fix. Gradle has shipped the flag since 8.14. The logic lives in `org.gradle.internal.jvm.JpmsConfiguration`, and the bytecode in both `gradle-base-services-8.14.jar` and `gradle-base-services-9.1.0.jar` is identical: `forDaemonProcesses(int, boolean)` and `forWorkerProcesses(int, boolean)` compare the target Java version against `24`, and when it is 24 or higher and the boolean is true they return a list containing `--enable-native-access=ALL-UNNAMED`. The callers, `DefaultDaemonStarter` and `DefaultWorkerProcessBuilder`, pass `NativeServices.NativeServicesMode.isPotentiallyEnabled()` for that boolean.

You can see it on a live daemon. Start any build, then ask the JVM for its command line:

```bash
# JDK 26.0.2 jcmd against a running Gradle 9.1.0 daemon
jps -l | grep GradleDaemon
jcmd <pid> VM.command_line
```

On a Gradle 9.1.0 daemon running on JDK 26.0.2 that prints, among the `--add-opens` entries, a single `--enable-native-access=ALL-UNNAMED`. Two follow-ups are worth knowing:

- Setting your own `org.gradle.jvmargs` does not clobber it. With `org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G` in `gradle.properties`, the daemon command line still carries `-Xmx4G`, `-XX:MaxMetaspaceSize=2G` **and** `--enable-native-access=ALL-UNNAMED`. This matters for Flutter specifically, because the app template ships a non-empty `org.gradle.jvmargs` line by default.
- Setting `org.gradle.native=false` does remove it, because `isPotentiallyEnabled()` returns false. That is not a fix, it is Gradle turning off its native integration wholesale, and you lose file-system watching with it.

So a warning naming `net.rubygrapefruit.platform.internal.NativeLibraryLoader` from a current Gradle daemon is not something you patch with a flag. It means that JVM did not get Gradle's arguments, which points at one of three things: a Gradle older than 8.14, a JVM forked by a plugin rather than by Gradle's worker API, or an IDE talking to your build over the Tooling API. Gradle's own 8.14 release notes call the last one out: Tooling API consumers have to enable native access at startup themselves because of its use of JNI.

## Which JVM in the build is printing the warning?

Work from line 2 outward. It names both the caller class and the jar it came from, and that pair is enough to place the JVM:

- Caller in a `native-platform-*.jar` under `~/.gradle/wrapper/dists/`, and `jcmd` shows the daemon does have the flag: the warning is from a different process than the daemon you inspected, typically a forked worker or a compile daemon started by a plugin.
- Caller in a `jna-*.jar`: a plugin loaded JNA. Find it with `./gradlew :app:dependencies --configuration runtimeClasspath` from the `android/` directory and look for `net.java.dev.jna`.
- Caller in a jar under `~/.gradle/caches/modules-2/`: it is a plugin dependency, not Gradle itself, and the plugin author needs to fork with the flag.

Since Flutter runs Gradle for you, capture the raw output first:

```bash
# Flutter 3.44.2, run from the project root
flutter build apk --debug --verbose 2>&1 | tee build.log
grep -n "restricted method" -A 3 build.log
```

## How do I get rid of the warning?

In order of preference.

**Match your JDK to your Gradle version.** Gradle's compatibility matrix is strict: Java 24 needs Gradle 8.14 or later, Java 25 needs 9.1.0 or later, and Java 26 needs 9.4.0 or later. Flutter 3.44.2 generates projects on Gradle 9.1.0 with AGP 9.0.1 and Kotlin 2.3.20, so a new project is fine on JDK 24 or 25 and one version short for JDK 26. Bump the wrapper in `android/gradle/wrapper/gradle-wrapper.properties`:

```properties
# Flutter 3.44.2 default is gradle-9.1.0-all; 9.4.0+ is required for JDK 26
distributionUrl=https\://services.gradle.org/distributions/gradle-9.4.0-all.zip
```

Running past the matrix does not merely warn. Gradle 9.1.0 on JDK 26.0.2 fails the build outright:

```text
BUG! exception in phase 'semantic analysis' in source unit '_BuildScript_' Unsupported class file major version 70
```

Flutter recognises that one. `gradle_errors.dart` matches `Unsupported class file major version\s+\d+` and prints a box telling you your Gradle version is incompatible with the Java version Flutter is using, with a pointer to `flutter doctor --verbose`.

**Point Flutter at the JDK you actually want.** If you do not need a bleeding-edge JDK for this project, the shortest path is to stop handing Flutter one:

```bash
# Flutter 3.44.2; persists to the Flutter config, survives JAVA_HOME changes
flutter config --jdk-dir "C:\Program Files\Android\Android Studio\jbr"
flutter doctor --verbose
```

Because `jdk-dir` sits above `JAVA_HOME` in the resolution order, this wins over whatever a package manager set globally, and it only affects Flutter.

**Add the flag to the JVM that is missing it.** Only once you have identified that JVM from line 2. For the Gradle daemon on an older Gradle, that is `org.gradle.jvmargs` in `android/gradle.properties`, appended to what Flutter's template already put there:

```properties
# Flutter 3.44.2 template default, plus the JEP 472 opt-in
org.gradle.jvmargs=-Xmx8G -XX:MaxMetaspaceSize=4G -XX:ReservedCodeCacheSize=512m -XX:+HeapDumpOnOutOfMemoryError --enable-native-access=ALL-UNNAMED
```

For a Kotlin compile daemon, the equivalent knob is `kotlin.daemon.jvmargs`. Note that this is a real opt-in with a real meaning, not a mute button: you are asserting that everything on the class path may call native code.

## Is --illegal-native-access=allow safe to put in gradle.properties?

No, and this is the one change here that can actually break a teammate's build.

`--illegal-native-access` was introduced alongside JEP 472 in JDK 24. On JDK 21 it does not exist, and an unknown `-` option is fatal at JVM startup:

```text
Unrecognized option: --illegal-native-access=deny
Error: Could not create the Java Virtual Machine.
Error: A fatal exception has occurred. Program will exit.
```

Put it in `org.gradle.jvmargs` and the build dies for anyone on JDK 21, which includes every developer using Android Studio's bundled JBR and most CI images pinned to an LTS. `--enable-native-access` is safer on that front, since it has existed since JDK 21 and is accepted there without complaint, but it is still worth scoping to the project rather than to a global `GRADLE_OPTS`.

The `allow` value has a second problem: it is the compatibility mode JEP 472 describes as temporary, to be phased out and eventually removed. Building on it means the warning comes back as an error on some future JDK, on someone else's schedule.

## What happens when the warning becomes an error?

You can see the endgame today by opting in early. Loading Gradle's own native library on JDK 26.0.2 under `--illegal-native-access=deny`:

```text
Exception in thread "main" net.rubygrapefruit.platform.NativeException: Failed to load native library 'native-platform.dll' for Windows 11 amd64.
	at net.rubygrapefruit.platform.internal.NativeLibraryLoader.load(NativeLibraryLoader.java:67)
	at net.rubygrapefruit.platform.Native.init(Native.java:60)
Caused by: java.lang.IllegalCallerException: Illegal native access from an unnamed module (file:/C:/.../gradle-9.1.0/lib/native-platform-0.22-milestone-28.jar)
	at java.base/java.lang.Module.ensureNativeAccess(Module.java:311)
	at java.base/java.lang.System$1.ensureNativeAccess(System.java:2110)
```

The `IllegalCallerException` is the JDK's part. Everything above it is the library's own failure handling, which is why the future version of this problem will not look like a native-access error at all. It will look like whatever the library says when a `.dll` or `.so` fails to load. Running your CI with `--illegal-native-access=deny` on a JDK 24+ job is a cheap way to find out which of your plugins will break first, as long as you keep it out of the shared `gradle.properties`.

## Related

- [Toolchain installation does not provide the required capabilities: \[JAVA_COMPILER\]](/2026/08/fix-toolchain-installation-does-not-provide-the-required-capabilities-in-flutter/) covers the other half of Flutter's JDK story, where Gradle resolves a JRE instead of a JDK.
- [Gradle task assembleDebug failed with exit code 1](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) walks through pulling the real error out of a Flutter Android build log.
- [flutter doctor reports cmdline-tools component is missing](/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) is the companion for when `flutter doctor --verbose` itself is unhappy.
- [Flutter UI overlaps the Android system navigation bar after targeting SDK 35](/2026/08/fix-flutter-ui-overlaps-the-android-navigation-bar-after-targeting-sdk-35/) is another case where an Android platform change surfaces late in a Flutter project.

## Sources

- [JEP 472: Prepare to Restrict the Use of JNI](https://openjdk.org/jeps/472), which defines the restricted methods and the `--enable-native-access` opt-in.
- [JDK 24: Prepares Restricted Native Access](https://inside.java/2024/12/09/quality-heads-up/) on Inside Java, the quality outreach note for the JDK 24 change.
- [Gradle Java compatibility matrix](https://docs.gradle.org/current/userguide/compatibility.html), for the Gradle version required by each Java release.
- [Gradle 8.14 release notes](https://docs.gradle.org/8.14/release-notes.html), which add Java 24 daemon support and flag the Tooling API's own JNI requirement.
- Flutter 3.44.2 sources: `packages/flutter_tools/lib/src/android/java.dart` for the JDK resolution order and `packages/flutter_tools/lib/src/android/gradle_errors.dart` for the class-file-version handler.
