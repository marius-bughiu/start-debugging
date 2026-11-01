---
title: "Migrate a Flutter Android project's Gradle scripts from Groovy to Kotlin DSL (build.gradle to build.gradle.kts)"
description: "A tested, file-by-file conversion of a Flutter app's settings.gradle, build.gradle and app/build.gradle to Kotlin DSL on Flutter 3.44.8, AGP 9.0.1 and Gradle 9.1.0, with the real compiler errors each naive rename produces and the exact fix for signing configs, flavors, minifyEnabled and kotlinOptions."
pubDate: 2026-10-31
updatedDate: 2026-10-31
template: migration
tags:
  - "migration"
  - "flutter"
  - "android"
  - "gradle"
  - "kotlin"
---

Converting a Flutter Android project from Groovy to Kotlin DSL means renaming three files (`android/settings.gradle`, `android/build.gradle`, `android/app/build.gradle`) to `.kts` and fixing the syntax that Groovy tolerated: double quotes everywhere, `=` on every property, parentheses on every call, `is` prefixes on booleans like `isMinifyEnabled`, `create("release")` for signing configs and flavors, explicit imports for `Properties` and `FileInputStream`, and `kotlin { compilerOptions { } }` instead of `kotlinOptions`. For a typical app with a release keystore and a couple of flavors it takes 30 to 60 minutes, almost all of it in `app/build.gradle`. Nothing forces you to do it: Groovy files still build fine. The payoff is type-checked build scripts, real autocomplete in Android Studio, and matching every new `flutter create` template and current Android documentation.

Everything below was run on Flutter 3.44.8 stable (framework revision `058e0af2c2`), Android Gradle Plugin (AGP) 9.0.1, Kotlin Gradle Plugin (KGP) 2.3.20, Gradle 9.1.0 and OpenJDK 17.0.20. I started from a Groovy project shaped like the pre-3.29 Flutter template plus the additions most production apps have: a `key.properties` release signing config, R8 shrinking, two product flavors and a desugaring dependency. Both the Groovy original and the Kotlin result built `app-dev-debug.apk` with `flutter build apk --debug --flavor dev`. Every compiler error quoted here is the actual output from that project.

## Why migrate a working Groovy build

- **Errors move from runtime to compile time.** A typo like `minfyEnabled true` in Groovy is a dynamic method call that only fails when Gradle evaluates that line, with a `Could not find method` message. In Kotlin DSL the whole script is compiled first, and you get `Unresolved reference 'minfyEnabled'` with a line and column, together with every other error in the file.
- **Autocomplete and navigation work.** Android Studio resolves every block in a `.kts` file to the real AGP type, so you can Cmd-click `defaultConfig` and see what properties exist instead of guessing from blog posts.
- **The ecosystem has moved.** `flutter create` has generated `.kts` files since Flutter 3.29, and the Android build docs show Kotlin first. Copying a snippet from either into a Groovy file is a translation exercise every time.
- **Deprecations become visible.** Groovy silently accepted my old `kotlinOptions { jvmTarget = '17' }` block on KGP 2.3.20. The same block in Kotlin DSL is a hard error (more on that in the gotchas), which is exactly the kind of debt you want surfaced.

The honest cost: Google's own [migration guide](https://developer.android.com/build/migrate-to-kotlin-dsl) notes that Kotlin build scripts tend to compile slower than Groovy. In practice you pay it once per script change, because Gradle caches compiled scripts.

## What breaks when you just rename the files

| Area | Groovy | Kotlin DSL | Severity |
| --- | --- | --- | --- |
| Strings | `'single'` or `"double"` | `"double"` only | high (parse error) |
| Property assignment | `namespace "x"` | `namespace = "x"` | high |
| Method calls | `include ":app"` | `include(":app")` | high |
| Local variables | `def x = ...` | `val x = ...` | high |
| Boolean build type flags | `minifyEnabled true` | `isMinifyEnabled = true` | high |
| `minSdkVersion` / `targetSdkVersion` | setter methods | `minSdk = ...`, `targetSdk = ...` | high |
| Named containers | `release { }`, `dev { }` | `create("release") { }` unless it already exists | high |
| `signingConfigs.release` | dynamic lookup | `signingConfigs.getByName("release")` | high |
| JDK classes | auto-imported | `import java.util.Properties` | medium |
| `kotlinOptions { }` | still accepted | compile error on KGP 2.3 | medium |
| `buildDir` | assignable from a `String` | type mismatch, use `layout.buildDirectory` | medium |

## Pre-flight checklist

- **Commit first.** The conversion is three file renames; `git diff -M` will show it as edits only if the content stays similar, so keep the commit dedicated to this change.
- **Know your current versions.** Open `android/settings.gradle` and note the AGP and KGP versions in the `plugins { }` block. If your project still has a `buildscript { dependencies { classpath ... } }` block in the root `build.gradle`, it predates the declarative plugins layout introduced in Flutter 3.16. Do [the declarative plugin migration](https://docs.flutter.dev/release/breaking-changes/flutter-gradle-plugin-apply) first, in Groovy, and get it building. Converting both at once doubles the number of things that can be wrong.
- **Get a green build before you start.** Run `flutter build apk --debug` (with `--flavor` if you have flavors) and make sure it passes. If it does not, fix that first; [this guide to the generic Gradle exit code 1 failure](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) covers the usual suspects.
- **Use `./gradlew help` as your fast check.** From the `android/` folder, `./gradlew help` configures every project and compiles every build script, but runs no Android tasks. Script errors show up in seconds instead of after a full build.

## Migration steps

1. **Convert `android/settings.gradle` to `settings.gradle.kts`.** This is the smallest file and the one that resolves plugin versions, so do it first. A plain rename fails immediately on the Groovy closure and the space-separated plugin syntax:

   ```text
   e: settings.gradle.kts:2:24: Expecting an element
   e: settings.gradle.kts:6:33: Unexpected tokens (use ';' to separate expressions on the same line)
   e: settings.gradle.kts:20:8: Unexpected tokens (use ';' to separate expressions on the same line)
   Script compilation errors:
   10 errors
   ```

   Replace the whole file with the Kotlin equivalent. Keep your own AGP and KGP version numbers; these are the ones Flutter 3.44.8 writes:

   ```kotlin
   // android/settings.gradle.kts, Flutter 3.44.8, AGP 9.0.1, KGP 2.3.20
   pluginManagement {
       val flutterSdkPath =
           run {
               val properties = java.util.Properties()
               file("local.properties").inputStream().use { properties.load(it) }
               val flutterSdkPath = properties.getProperty("flutter.sdk")
               require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
               flutterSdkPath
           }

       includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

       repositories {
           google()
           mavenCentral()
           gradlePluginPortal()
       }
   }

   plugins {
       id("dev.flutter.flutter-plugin-loader") version "1.0.0"
       id("com.android.application") version "9.0.1" apply false
       id("org.jetbrains.kotlin.android") version "2.3.20" apply false
   }

   include(":app")
   ```

   The Groovy `def flutterSdkPath = { ... }()` closure becomes a `run { }` block, `withInputStream` becomes `inputStream().use { }` so the stream is closed, and `assert` becomes `require`, which throws a readable `IllegalArgumentException` instead of a Groovy power assertion. Verify: `cd android && ./gradlew help` prints `BUILD SUCCESSFUL`. Gradle supports mixing DSLs in one build: with only `settings.gradle.kts` converted, my still-Groovy root and app `build.gradle` files configured without a single change.

2. **Convert the root `android/build.gradle` to `build.gradle.kts`.** The old template sets `buildDir` from a string, which Kotlin rejects because the property is a `File`, and the API itself is deprecated:

   ```text
   w: build.gradle.kts:8:13: 'var buildDir: File' is deprecated. Deprecated in Java.
   e: build.gradle.kts:8:24: Assignment type mismatch: actual type is 'String', but 'File' was expected.
   e: build.gradle.kts:10:24: Assignment type mismatch: actual type is 'String', but 'File' was expected.
   ```

   And Groovy's `tasks.register("clean", Delete)` does not parse at all (`Expecting an element`), because Kotlin has no bare class literals. Use the lazy `layout.buildDirectory` API and the reified `register<Delete>` form, which is what current templates ship:

   ```kotlin
   // android/build.gradle.kts, Flutter 3.44.8, Gradle 9.1.0
   allprojects {
       repositories {
           google()
           mavenCentral()
       }
   }

   val newBuildDir: Directory =
       rootProject.layout.buildDirectory
           .dir("../../build")
           .get()
   rootProject.layout.buildDirectory.value(newBuildDir)

   subprojects {
       val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
       project.layout.buildDirectory.value(newSubprojectBuildDir)
   }
   subprojects {
       project.evaluationDependsOn(":app")
   }

   tasks.register<Delete>("clean") {
       delete(rootProject.layout.buildDirectory)
   }
   ```

   Note the `../../build`: `layout.buildDirectory` resolves to `android/build`, not `android/`, so two levels up lands on the Flutter project's `build/` folder, the same place the Groovy `"../build"` pointed at (Groovy's `buildDir` string was resolved against the project directory, `android/`). Keep that location: the Flutter tool looks for the APK under `build/app/outputs/`. If you have extra `ext { }` properties here, they become `extra["name"] = value` in Kotlin and are read back with `rootProject.extra["name"]`. Verify: `./gradlew help` passes.

3. **Rename `android/app/build.gradle` and fix the mechanical syntax.** This is where most of the work is. Rename the file, then do the purely textual pass: single quotes to double quotes, `=` on every property assignment, parentheses on every method call (`proguardFiles(...)`, `implementation("...")`), `def` to `val`, and drop `new`. After that pass, my project still produced 23 errors, and they are the interesting ones:

   ```text
   e: app/build.gradle.kts:7:26: Unresolved reference 'Properties'.
   e: app/build.gradle.kts:10:29: Unresolved reference 'FileInputStream'.
   e: app/build.gradle.kts:24:9: 'var jvmTarget: String' is deprecated. Please migrate to the compilerOptions DSL.
   e: app/build.gradle.kts:29:9: Function invocation 'minSdkVersion(...)' expected.
   e: app/build.gradle.kts:38:13: Unresolved reference 'keyAlias'.
   e: app/build.gradle.kts:47:29: Assignment type mismatch: actual type is 'NamedDomainObjectProvider<KotlinSourceSet>', but 'ApkSigningConfig?' was expected.
   e: app/build.gradle.kts:48:13: Unresolved reference 'minifyEnabled'.
   e: app/build.gradle.kts:56:9: Unresolved reference 'dev'.
   ```

   Each line maps to one rule, handled in the next three steps. Verify nothing for now; the file will not compile until step 6.

4. **Add imports and type the keystore properties.** Groovy imports `java.util.*` and `java.io.*` by default, Kotlin scripts do not. Add the imports at the very top of the file, above `plugins { }`. `Properties` extends `Hashtable<Any, Any>`, so `keystoreProperties["keyAlias"]` is `Any?`, and you need an explicit cast to assign it to a `String?` property:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.44.8, AGP 9.0.1
   import java.io.FileInputStream
   import java.util.Properties

   val keystoreProperties = Properties()
   val keystorePropertiesFile = rootProject.file("key.properties")
   if (keystorePropertiesFile.exists()) {
       keystoreProperties.load(FileInputStream(keystorePropertiesFile))
   }
   ```

   Without the cast the compiler stops at `Assignment type mismatch: actual type is 'Any?', but 'String?' was expected.` `keystoreProperties.getProperty("keyAlias")` is an equally valid alternative that already returns `String?`, if you prefer to avoid casts. Verify: the two `Unresolved reference 'Properties'` and `'FileInputStream'` errors are gone on the next `./gradlew help`.

5. **Create named containers instead of configuring them by name.** In Groovy, `signingConfigs { release { ... } }` creates the `release` signing config if it does not exist. In Kotlin, `release { }` is only an accessor for something that already exists. AGP creates the `debug` signing config and the `debug` and `release` build types for you, so `buildTypes { release { } }` works as written, but the release signing config and every flavor must be created explicitly:

   ```kotlin
   // inside android { }, AGP 9.0.1
   signingConfigs {
       create("release") {
           keyAlias = keystoreProperties["keyAlias"] as String?
           keyPassword = keystoreProperties["keyPassword"] as String?
           storeFile = keystoreProperties["storeFile"]?.let { file(it) }
           storePassword = keystoreProperties["storePassword"] as String?
       }
   }

   flavorDimensions += "env"
   productFlavors {
       create("dev") {
           dimension = "env"
           applicationIdSuffix = ".dev"
           versionNameSuffix = "-dev"
       }
       create("prod") {
           dimension = "env"
       }
   }
   ```

   The type-mismatch error from step 3 is worth understanding: `signingConfigs.release` did not fail as "unresolved". It resolved to the Kotlin plugin's `release` source set accessor, a `NamedDomainObjectProvider<KotlinSourceSet>`, which is why the message mentions `KotlinSourceSet`. Look up signing configs by name instead. The same applies to any custom build type such as `staging` or `profileRelease`: only `debug` and `release` exist implicitly, everything else needs `create("staging")`, which the Android guide calls out explicitly. Verify: the `Unresolved reference 'dev'` and `'keyAlias'` errors are gone.

6. **Rename properties that changed shape: booleans, SDK levels, `kotlinOptions`.** Kotlin exposes boolean properties through their getter names, so `minifyEnabled` is `isMinifyEnabled` and `shrinkResources` is `isShrinkResources`. The old `minSdkVersion` and `targetSdkVersion` are setter functions, not properties, hence `Function invocation 'minSdkVersion(...)' expected`; use the properties `minSdk` and `targetSdk`. Replace `kotlinOptions` with the top-level `kotlin { compilerOptions { } }` block. Here is the complete converted file:

   ```kotlin
   // android/app/build.gradle.kts, Flutter 3.44.8, AGP 9.0.1, KGP 2.3.20
   import java.io.FileInputStream
   import java.util.Properties

   plugins {
       id("com.android.application")
       id("kotlin-android")
       id("dev.flutter.flutter-gradle-plugin")
   }

   val keystoreProperties = Properties()
   val keystorePropertiesFile = rootProject.file("key.properties")
   if (keystorePropertiesFile.exists()) {
       keystoreProperties.load(FileInputStream(keystorePropertiesFile))
   }

   android {
       namespace = "net.startdebugging.gradle_kts_demo"
       compileSdk = flutter.compileSdkVersion
       ndkVersion = flutter.ndkVersion

       compileOptions {
           sourceCompatibility = JavaVersion.VERSION_17
           targetCompatibility = JavaVersion.VERSION_17
       }

       defaultConfig {
           applicationId = "net.startdebugging.gradle_kts_demo"
           minSdk = flutter.minSdkVersion
           targetSdk = flutter.targetSdkVersion
           versionCode = flutter.versionCode
           versionName = flutter.versionName
           multiDexEnabled = true
       }

       signingConfigs {
           create("release") {
               keyAlias = keystoreProperties["keyAlias"] as String?
               keyPassword = keystoreProperties["keyPassword"] as String?
               storeFile = keystoreProperties["storeFile"]?.let { file(it) }
               storePassword = keystoreProperties["storePassword"] as String?
           }
       }

       buildTypes {
           release {
               signingConfig =
                   if (keystorePropertiesFile.exists()) signingConfigs.getByName("release")
                   else signingConfigs.getByName("debug")
               isMinifyEnabled = true
               isShrinkResources = true
               proguardFiles(
                   getDefaultProguardFile("proguard-android-optimize.txt"),
                   "proguard-rules.pro",
               )
           }
       }

       flavorDimensions += "env"
       productFlavors {
           create("dev") {
               dimension = "env"
               applicationIdSuffix = ".dev"
               versionNameSuffix = "-dev"
           }
           create("prod") {
               dimension = "env"
           }
       }
   }

   kotlin {
       compilerOptions {
           jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
       }
   }

   flutter {
       source = "../.."
   }

   dependencies {
       implementation("androidx.window:window:1.3.0")
       coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")
   }
   ```

   `multiDexEnabled` keeps its name because AGP declares it as a nullable `Boolean?`, and Kotlin only applies the `is` getter convention to the primitive `boolean` properties. When in doubt, let autocomplete in Android Studio tell you; that is half the reason for doing this migration. Verify: `./gradlew help` prints `BUILD SUCCESSFUL`.

7. **Build every flavor and build type you ship.** `./gradlew help` proves the scripts compile and configure; it does not run R8 or signing. Run the real builds:

   ```bash
   # Flutter 3.44.8
   flutter build apk --debug --flavor dev
   flutter build appbundle --release --flavor prod
   ```

   Verify: both commands end with `✓ Built build/app/outputs/...`. For my project, `flutter build apk --debug --flavor dev` produced `app-dev-debug.apk` from the converted scripts, and `./gradlew :app:signingReport` with a throwaway `key.properties` showed the `prodRelease` variant signed with the release keystore and alias, so the `create("release")` block and the property casts behave exactly like the Groovy original.

## Verification checklist

- `./gradlew help` from `android/` passes with no `e:` lines. The `w:` deprecation warnings are fine to leave for later, but read them: they are your next migration.
- `flutter build apk --debug` and `flutter build appbundle --release` pass for every flavor.
- `git status` shows only the three renames (plus any `gradle.properties` change you made on purpose). No stray `build.gradle` next to its `.kts` twin. I tested this: with both `app/build.gradle` and `app/build.gradle.kts` present, Gradle 9.1.0 silently used the Groovy file, printed no warning, and ignored every edit in the `.kts` file. That is a very confusing way to lose an afternoon.
- If you sign releases, run `./gradlew :app:signingReport` and check the `release` variant points at your keystore, not the debug one. The `if (keystorePropertiesFile.exists())` fallback hides a missing `key.properties` on CI by signing with the debug key, which Play will then reject.
- CI scripts that `sed` or `grep` build files (for example to bump `versionCode`) need their paths and patterns updated to the `.kts` names and the `=` syntax.

## Rollback plan

The migration is fully reversible and file-scoped: `git checkout HEAD~1 -- android/` restores the Groovy files, and because Gradle allows Groovy and Kotlin scripts side by side, you can also roll back a single file. If `app/build.gradle.kts` is fighting you, keep the converted `settings.gradle.kts` and root `build.gradle.kts`, restore `app/build.gradle`, ship, and finish the app module later.

## Gotchas I hit

**`kotlinOptions` works in Groovy but is a compile error in Kotlin DSL.** On KGP 2.3.20, `kotlinOptions { jvmTarget = '17' }` in Groovy produced no error and the APK built. The identical block in `.kts` failed with `'var jvmTarget: String' is deprecated. Please migrate to the compilerOptions DSL.` as an `e:` line, because KGP marks it with error-level deprecation and only the Kotlin compiler enforces that. Groovy calls it dynamically and never sees the annotation. If you are also planning [the AGP 9 built-in Kotlin migration](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/), you need this change there too, so the Kotlin DSL conversion front-loads it.

**`flavorDimensions` is a list, not a function.** In the current Android DSL `flavorDimensions` is a `MutableList<String>`, so the forward-compatible form is `flavorDimensions += "env"` (or `+= listOf("env", "store")`). A literal `flavorDimensions("env")` still compiled in my test, because the deprecated `android` extension that Flutter's `android.newDsl=false` keeps alive still accepts it, but it will not survive the move to the new DSL. If you are unsure how flavors interact with build modes on the Dart side, see [what a Flutter flavor is and how it differs from a build mode](/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/).

**Kotlin version errors are not caused by the DSL change.** If after the migration you see `Module was compiled with an incompatible version of Kotlin`, the cause is the KGP version on the classpath, which the DSL does not change. [That error has its own walkthrough](/2026/10/fix-module-was-compiled-with-an-incompatible-version-of-kotlin-in-a-flutter-android-build/).

**`buildConfigField` and `manifestPlaceholders` need Kotlin syntax inside the values.** `buildConfigField("String", "API_URL", "\"https://api.example.com\"")` keeps the escaped inner quotes, because the third argument is pasted into Java source verbatim. `manifestPlaceholders["appAuthRedirectScheme"] = "com.example"` replaces Groovy's `manifestPlaceholders = [appAuthRedirectScheme: 'com.example']`, and unlike the Groovy map assignment it adds to placeholders set elsewhere instead of replacing them. Since AGP 8.0, `buildConfigField` also requires `buildFeatures { buildConfig = true }`, regardless of DSL.

**Do not edit plugins' Groovy files.** Your Flutter plugins in `~/.pub-cache` keep their own `build.gradle` files, and that is fine. Mixed DSLs across projects are supported, and the plugins are compiled as separate subprojects.

## Related

- [Migrate a Flutter Android project to AGP 9 with built-in Kotlin](/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/)
- [Fix: Gradle task assembleDebug failed with exit code 1 in a Flutter Android build](/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/)
- [Fix: Module was compiled with an incompatible version of Kotlin](/2026/10/fix-module-was-compiled-with-an-incompatible-version-of-kotlin-in-a-flutter-android-build/)
- [What is a Flutter flavor and how is it different from a build mode?](/2026/10/what-is-a-flutter-flavor-and-how-is-it-different-from-a-build-mode/)

## Sources

- Android Developers: [Migrate your build configuration from Groovy to Kotlin](https://developer.android.com/build/migrate-to-kotlin-dsl)
- Gradle User Manual: [Migrating build logic from Groovy to Kotlin](https://docs.gradle.org/current/userguide/migrating_from_groovy_to_kotlin_dsl.html)
- Flutter docs: [Deprecated imperative apply of Flutter's Gradle plugins](https://docs.flutter.dev/release/breaking-changes/flutter-gradle-plugin-apply)
- Flutter docs: [Migrating Flutter Android projects to built-in Kotlin](https://docs.flutter.dev/release/breaking-changes/migrate-to-built-in-kotlin)
- Andrea Bizzotto: [Kotlin DSL in Flutter 3.29](https://codewithandrea.com/articles/flutter-android-gradle-kts/), on the template switch
