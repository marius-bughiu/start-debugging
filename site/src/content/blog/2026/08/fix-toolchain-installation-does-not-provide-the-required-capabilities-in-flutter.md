---
title: "Fix: Toolchain installation does not provide the required capabilities: [JAVA_COMPILER]"
description: "Gradle is compiling with a JRE. It is not searching your machine, it is using the exact JVM it was launched on. Point flutter config --jdk-dir at a real JDK, or clear org.gradle.java.home."
pubDate: 2026-08-21
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "java"
---

The Java home Gradle is running on has no `bin/javac`, so it is a JRE, not a JDK. Gradle is not searching your machine for a better one: with no toolchain configured it uses the JVM it was launched on and fails immediately. In a Flutter Android build that JVM is chosen by `flutter config --jdk-dir` first, so run `flutter config --jdk-dir "/path/to/a/real/jdk"` and rebuild. If that does not move the error, something is overriding Flutter: check `org.gradle.java.home` in `android/gradle.properties`.

Everything below was verified against Flutter 3.44.2 stable, whose Android templates pin Gradle 9.1.0, Android Gradle Plugin 9.0.1, Kotlin Gradle Plugin 2.3.20, and `compileSdk` 36.

## The error as Gradle prints it

```text
FAILURE: Build failed with an exception.

* What went wrong:
Could not determine the dependencies of task ':app:packageDebug'.
> Could not create task ':app:compileDebugJavaWithJavac'.
   > Failed to calculate the value of task ':app:compileDebugJavaWithJavac' property 'javaCompiler'.
      > Toolchain installation 'C:\path\to\some-java-home' does not provide the required capabilities: [JAVA_COMPILER]
```

Through `flutter build apk` you usually only see the tail of it, wrapped in `Gradle task assembleDebug failed with exit code 1`. The path in quotes is the important part. It is the Java home Gradle rejected, and nine times out of ten you did not knowingly configure it.

## Why Gradle blames a Java home you never configured

This message comes from Gradle, not from Flutter or AGP. In Gradle 9.1.0 it is thrown by `JavaToolchainQueryService`, and the surrounding logic is the whole story:

```java
// Gradle 9.1.0, JavaToolchainQueryService.resolveToolchain
boolean useFallback = !requestedSpec.isConfigured();
JavaToolchainSpec actualSpec = useFallback ? fallbackToolchainSpec : requestedSpec;
```

If no toolchain is configured anywhere in the build, Gradle substitutes a fallback spec that means "the current JVM". That path does not search, filter, or rank anything:

```java
// Gradle 9.1.0, JavaToolchainQueryService.query
if (spec instanceof CurrentJvmToolchainSpec) {
    return asToolchainOrThrow(
        InstallationLocation.autoDetected(currentJavaHome, "current JVM"),
        spec, requiredCapabilities, isFallback);
}
```

`asToolchainOrThrow` probes that one installation and throws if it is missing a required capability. Compare that with the configured path, `findInstalledToolchain`, which streams every detected installation through a capability-aware matcher and silently skips the ones that do not qualify.

That difference is the single most useful thing to know here. This error means Gradle was handed one specific Java home and that home has no compiler. It does not mean "Gradle could not find a JDK". When Gradle genuinely cannot find one, you get a completely different message, which is covered further down.

It also means the toolchain auto-detection settings are irrelevant on this path. I confirmed that by running the same task twice, once with `-Dorg.gradle.java.installations.auto-detect=false` and once with detection left on. Identical failure both times.

## What Gradle actually checks when it says JAVA_COMPILER

Less than you would guess. There is no probe, no module query, no attempt to invoke a compiler API. It is a file existence test:

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

`getToolByExecutable` resolves `<javaHome>/bin/<name>` with the platform executable suffix. Gradle labels an installation "JDK" only when all three of `javac`, `javadoc`, and `jar` are present, and `JAVA_COMPILER` is exactly `bin/javac`.

The practical consequence: a Java home that is a JDK in every sense except that its `bin` directory does not literally contain `javac` will be reported as a JRE. That covers `java-17-openjdk` packages on Fedora and Debian that ship the headless runtime only, an old `jre` subdirectory left inside a JDK install, and any wrapper directory that forwards `java` but not the rest of the toolchain.

## Repro: build a JRE and watch it fail

You do not need a broken machine to see this. Build a runtime image without the compiler modules using `jlink`, which is what a JRE is:

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

Excluding `jdk.jpackage` matters. It pulls `jdk.jlink`, which pulls `jdk.jdeps`, which pulls `jdk.compiler` straight back in, and you end up with a `javac` launcher you were trying to avoid.

Now point Flutter at it and build a stock `flutter create` app:

```bash
# Flutter 3.44.2 stable, Gradle 9.1.0, AGP 9.0.1
flutter create --platforms=android toolchain_repro
flutter config --jdk-dir "$(pwd)/real-jre-21"
cd toolchain_repro && flutter build apk --debug
```

That fails with the exact error at the top of this post, on an unmodified template with no toolchain block anywhere in it.

## Which Java does a Flutter build actually use?

This is where most of the wasted debugging time goes, because `JAVA_HOME` is not the first thing Flutter looks at. From `packages/flutter_tools/lib/src/android/java.dart` in 3.44.2, `_findJavaHome` returns the first hit in this order:

1. the `jdk-dir` value in Flutter's own config, set by `flutter config --jdk-dir`
2. the JDK bundled with Android Studio
3. the `JAVA_HOME` environment variable
4. whatever `java` resolves to on `PATH`

So a stale `jdk-dir` beats a perfectly good `JAVA_HOME`, permanently and silently. I hit this while writing the repro: I exported `JAVA_HOME` to the crippled runtime and the build kept succeeding, because a previously configured `jdk-dir` was winning. Check yours before you change anything else:

```bash
# Flutter 3.44.2
flutter config --list | grep jdk-dir
```

For entry 2, the bundled path depends on the Android Studio version. Studio 2022 and newer use `<studio>/jbr`, or `<studio>/jbr/Contents/Home` on macOS. Anything older uses `<studio>/jre`. If you have an ancient install lying around that Flutter still finds, that `jre` directory is a plausible culprit.

The trap that makes this hard to spot is that `flutter doctor` does not check for a compiler. With the JRE configured it prints:

```text
[√] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • Java binary at: /path/to/real-jre-21/bin/java
      This JDK is specified in your Flutter configuration.
    • Java version OpenJDK Runtime Environment Microsoft-13877171 (build 21.0.11+10-LTS)
```

A green check, and the words "This JDK". Doctor runs `java --version` and parses the output, which a JRE answers perfectly well. It never looks for `javac`. If you are already chasing a doctor problem, `cmdline-tools component is missing` is a separate diagnosis with its own fix.

## How do I point Flutter at a real JDK?

Set `jdk-dir` explicitly and rebuild. This is the fix in the common case:

```bash
# Flutter 3.44.2
flutter config --jdk-dir "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home"
flutter build apk --debug
```

Verify the directory before you set it. The check Gradle performs is the one you should perform:

```bash
ls "$YOUR_JDK/bin/javac"
```

If that file does not exist, the path is a JRE regardless of what the directory is named. On Debian and Ubuntu, `openjdk-21-jre-headless` is the package that gets you here and `openjdk-21-jdk` is the one you want. On macOS with Homebrew, install `openjdk@21` and use the versioned path it prints rather than a shim.

To go back to `JAVA_HOME` and the normal precedence chain, clear the override:

```bash
# Flutter 3.44.2, empty value removes the setting
flutter config --jdk-dir ""
```

## What overrides Flutter's JDK choice?

`android/gradle.properties` can override everything Flutter decided. `org.gradle.java.home` sets the JVM the Gradle daemon runs on, and since the failing path is "the current JVM", pointing it at a JRE reproduces the error even when `flutter config --jdk-dir` is a valid JDK. I verified that specific combination: correct `jdk-dir`, one added line, same failure.

```properties
# android/gradle.properties, delete this line if it points at a JRE
org.gradle.java.home=/path/to/real-jre-21
```

Check the same property in `~/.gradle/gradle.properties`, which applies to every build on the machine and is easy to forget. Then confirm what Gradle sees:

```bash
# run from android/, Gradle 9.1.0
./gradlew -q javaToolchains
```

The report is the fastest diagnostic available, because it prints the two fields that matter:

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

`Is JDK: false` on the entry whose location matches the path in your error message confirms the diagnosis in one line.

## Does adding a toolchain block fix this?

The most common advice for this error is to declare a toolchain in `android/app/build.gradle.kts`. It does change the outcome, but not always in the direction you want, because it moves the build off the current-JVM path and onto the matching path, where Gradle will only accept an installation it can actually discover.

I tested exactly that. With the JRE still configured as `jdk-dir`, adding:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1, Gradle 9.1.0
java {
    toolchain { languageVersion = JavaLanguageVersion.of(21) }
}
```

produced a different failure:

```text
> Cannot find a Java installation on your machine (Windows 11 10.0 amd64) matching:
  {languageVersion=21, vendor=any vendor, implementation=vendor-specific, nativeImageCapable=false}.
  Toolchain download repositories have not been configured.
```

A JDK 21 was installed the entire time. Gradle did not find it because auto-detection had never seen it: look again at the `javaToolchains` output above and note that the Microsoft JDK 21 is listed as `Detected by: Current JVM`. Once the current JVM was the JRE, that entry disappeared from the candidate list, and the registry scan only surfaced a JDK 26 that does not satisfy a request for 21.

So a bare toolchain block trades a clear error for a vaguer one. Use it together with an explicit installation path, not instead of one.

## How do I pin a JDK for CI so this cannot regress?

Declare the toolchain and tell Gradle where the installations are. This combination builds successfully even when the daemon is running on a JRE, which is the property you want on a build agent where you do not control `JAVA_HOME`:

```properties
# android/gradle.properties, Gradle 9.1.0
org.gradle.java.installations.paths=/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/21.0.11/x64
```

Paired with the `java { toolchain { ... } }` block above, that was the configuration I confirmed green while `jdk-dir` still pointed at the compiler-less runtime. Two related knobs are worth knowing: `org.gradle.java.installations.fromEnv=JDK21` reads paths out of named environment variables, which suits CI images that already export them, and `org.gradle.java.installations.auto-detect=false` disables scanning entirely so an unpinned agent fails loudly instead of picking something arbitrary.

Do not reach for `org.gradle.java.installations.auto-download=true` as the fix. Gradle 9 deprecates using auto-provisioned toolchains without declared toolchain repositories and warns that it will become an error in Gradle 10.

## Variants that look like this error but are not

`Toolchain installation '...' could not be probed` is thrown two lines earlier in the same method and means Gradle could not run `java` at all. That is a broken or partial installation, a permissions problem, or an architecture mismatch, not a JRE.

`Cannot find a Java installation on your machine ... matching` is the configured-toolchain path failing to find a candidate. Fix it by adding the installation path, as above.

`Unsupported class file major version` and `Gradle requires JVM 17 or later` are version mismatches rather than capability failures. Flutter 3.44.2 carries a Java to Gradle compatibility table in `gradle_utils.dart`: Java 21 needs Gradle 8.4 or newer, Java 24 needs 8.14, and Java 25 needs 9.1.0.

`Cannot add extension with name 'kotlin'` is AGP 9's built-in Kotlin support colliding with the legacy `kotlin-android` plugin, and it is the other frequent cause of a failed `assembleDebug` in 2026.

## Related

- Flutter reports Gradle failures through a wrapper line, and the [real error is usually truncated above it](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/).
- A green Android toolchain check can still hide a missing piece, as with [the cmdline-tools component](/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/).
- Another Android SDK failure that repeats identically until you clear a cache: [a corrupt NDK archive](/2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format/).
- More build-breaking settings that live in `android/gradle.properties`: [the AndroidX and Jetifier flags](/2026/05/fix-androidx-conflict-during-flutter-android-build/).
- Version context for the toolchain defaults referenced here: [what changed in Flutter 3.44](/2026/05/flutter-3-44-material-cupertino-packages-swiftpm-default/).

## Sources

- Gradle user guide, [Toolchains for JVM projects](https://docs.gradle.org/current/userguide/toolchains.html), for auto-detection sources, precedence, and the installation properties.
- Gradle 9.1.0 source, `JavaToolchainQueryService.java` and `JvmInstallationMetadata.java`, shipped in the `src` directory of the `gradle-9.1.0-all` distribution.
- Flutter 3.44.2 source, `packages/flutter_tools/lib/src/android/java.dart` for the Java lookup order and `gradle_utils.dart` for the pinned Gradle, AGP, and Kotlin versions.
- Gradle issue [#30499](https://github.com/gradle/gradle/issues/30499) and [#30421](https://github.com/gradle/gradle/issues/30421), where the same message is reported against Linux OpenJDK packages.
