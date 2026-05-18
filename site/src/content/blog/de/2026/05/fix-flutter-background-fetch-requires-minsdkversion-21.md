---
title: "Fix: Das Flutter-Plugin background_fetch erfordert minSdkVersion 21"
description: "Die Lösung in 30 Sekunden: Setzen Sie minSdkVersion auf 21 (oder höher) in android/app/build.gradle. background_fetch baut auf Androids JobScheduler auf, den es erst ab API 21 gibt."
pubDate: 2026-05-18
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "background_fetch"
lang: "de"
translationOf: "2026/05/fix-flutter-background-fetch-requires-minsdkversion-21"
translatedBy: "claude"
translationDate: 2026-05-18
---

Die Lösung in einem Satz: Das Plugin `background_fetch` (Transistor Software) liefert eine `AndroidManifest.xml` und Kotlin-Code aus, die Androids `JobScheduler` verdrahten, der in API 21 (Android 5.0 Lollipop) eingeführt wurde. Wenn die `android/app/build.gradle` Ihrer Flutter-App noch `minSdkVersion 19` verwendet (oder `16`, bei Apps, die mit einem Flutter-SDK vor 2023 erzeugt wurden), verweigert der Manifest-Merger den Build mit `uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]`. Öffnen Sie `android/app/build.gradle`, setzen Sie `minSdkVersion` auf mindestens `21`, führen Sie `flutter clean` aus, dann `flutter pub get` und `flutter build apk`. Wenn Sie auf einem neueren Flutter-SDK sind, das `minSdk flutter.minSdkVersion` verwendet, überschreiben Sie den Flutter-weiten Standard, statt die Zahl hart zu codieren, sonst überschreibt das Flutter-Gradle-Plugin Ihre Änderung beim nächsten Build stillschweigend.

```text
> Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21 declared in library [:background_fetch]
    /Users/me/myapp/build/background_fetch/intermediates/merged_manifest/debug/AndroidManifest.xml as the library might be using APIs not available in 19
    Suggestion: use a compatible library with a minSdk of at most 19,
        or increase this project's minSdk version to at least 21,
        or use tools:overrideLibrary="com.transistorsoft.flutter.backgroundfetch" to force usage (may lead to runtime failures)

FAILURE: Build failed with an exception.
BUILD FAILED in 14s
```

Diese Anleitung gilt für Flutter 3.41.5, Dart 3.11, `background_fetch` 1.6.2, Android Gradle Plugin 8.7 und Gradle 8.11, den Stable-Kanal im Mai 2026. Der Fehler selbst ist seit `background_fetch` 1.0.0 stabil; nur die Standard-`minSdkVersion`, die ein frisch generiertes Flutter-Projekt mitbringt, hat sich verschoben. Deshalb stoßen manche Teams beim ersten Build einer kürzlich aktualisierten App darauf und andere haben das nie gesehen.

## Was der Fehler tatsächlich sagt

Das Android-Build-System führt einen Manifest-Merger-Durchlauf aus, der die `AndroidManifest.xml` der Anwendung mit den Manifesten jeder AAR im Classpath kombiniert. Jedes Manifest deklariert ein `<uses-sdk android:minSdkVersion="X"/>`-Tag. Der Merger nimmt den höchsten Wert und verweigert einen Build, dessen `minSdkVersion` auf Anwendungsebene niedriger ist als das, was irgendeine Bibliothek deklariert. `background_fetch` deklariert `minSdkVersion 21` in [seinem Plugin-Manifest](https://github.com/transistorsoft/flutter_background_fetch/blob/master/android/src/main/AndroidManifest.xml), und der einzige Weg, den Merger zufriedenzustellen, ist die Anwendung auf denselben Wert zu heben.

Der Fehler tritt in drei konkreten Formen auf, je nach Version des Android Gradle Plugins und dem Flutter-Template:

```text
Manifest merger failed : uses-sdk:minSdkVersion 19 cannot be smaller than version 21
declared in library [:background_fetch]
```

```text
The plugin background_fetch requires a higher Android SDK version.
Fix this issue by adding the following to /Users/me/myapp/android/app/build.gradle:
android {
  defaultConfig {
    minSdkVersion 21
  }
}
```

```text
A problem occurred evaluating project ':background_fetch'.
> com.transistorsoft.flutter.backgroundfetch requires Android SDK 21 or above
```

Der erste ist die rohe Ausgabe des Manifest-Mergers. Der zweite ist ein Pre-Flight-Hinweis der `flutter`-CLI, der nur für Plugins ausgelöst wird, die ihre `minSdkVersion` über den Flutter-Plugin-Deskriptor angekündigt haben. Der dritte ist eine Gradle-Assertion in der `android/build.gradle` des Plugins. Alle drei führen auf dieselbe Einschränkung zurück: `JobScheduler` und die Klassen `android.app.job.JobInfo`, `JobService` und `JobParameters`, die `background_fetch` aufruft, wurden in API 21 hinzugefügt. In API 19 existieren sie überhaupt nicht; in API 20 (Android Wear 4.4W) wurde nur ein Teil von `JobService` ausgeliefert. Das Plugin läuft auf nichts unter 21, also blockiert der Manifest-Merger den Build, bevor Sie ein kaputtes APK ausliefern können.

## Warum gerade API 21

`JobScheduler` existiert aus gutem Grund: Vorher hieß wiederkehrende Hintergrundarbeit auf Android `AlarmManager` mit einem Wake Lock, einem `IntentService` und einer selbst gebauten Retry-Schleife. Dieser Ansatz hat Akkus geleert, ab Android 6.0 den Doze-Modus umgangen und wurde stückweise in Android 8.0, 9.0 und 10 deprecated. `JobScheduler` lässt das OS Hintergrundarbeit über Apps hinweg zusammenfassen, sie an Ladezustand oder Netzwerktyp koppeln und Prozesstode überleben. `background_fetch` ist intern ein Dart-freundlicher Wrapper über `JobScheduler` (und das iOS-Pendant, `BGTaskScheduler`). Er kann konstruktionsbedingt keine API unter 21 anvisieren, ohne das gesamte Backend neu zu schreiben.

Das [README](https://pub.dev/packages/background_fetch) des Plugins und sein `CHANGELOG.md` nennen diese Anforderung seit 1.0.0 (2018), aber der Fehler ist 2025 wieder häufig geworden, als der Google Play Store Apps abgewiesen hat, die auf `targetSdkVersion 33` oder niedriger gezielt haben. Das hat groß angelegte Rebuilds langlebiger Flutter-Codebasen ausgelöst, die seit 2019 ihre `android/app/build.gradle` nicht angefasst hatten.

## Eine minimale Reproduktion

Erstellen Sie eine Flutter-App auf einem SDK, das noch `minSdkVersion 19` als Standard hat, fügen Sie das Plugin hinzu und führen Sie einen Debug-Build aus:

```bash
# Flutter 3.7.0 (December 2022), the last template before the 19 -> 21 bump
flutter create background_fetch_repro
cd background_fetch_repro
flutter pub add background_fetch
flutter build apk --debug
```

`flutter pub add background_fetch` löst auf `^1.6.2` auf und schreibt eine transitive Abhängigkeit auf das Android-Plugin-Manifest. Der nächste Build scheitert mit `Manifest merger failed`. Derselbe Fehler reproduziert in einem frisch generierten Flutter-3.41.5-Projekt, wenn Sie `minSdkVersion` manuell heruntergesetzt haben, weil ein anderes Plugin (`flutter_blue_classic` zum Beispiel) einen niedrigeren Wert zu brauchen schien.

## Die Lösung im Detail

Es gibt drei gangbare Wege, abhängig davon, welches Flutter-SDK das Projekt erzeugt hat. Wählen Sie den, der zu Ihrer `android/app/build.gradle` passt.

### Weg A: Groovy-build.gradle mit hartkodierten Zahlen

Wenn `android/app/build.gradle` ein Literal `minSdkVersion 19` enthält, ändern Sie das Literal:

```groovy
// android/app/build.gradle
// Flutter 3.0 through 3.15 era template
android {
    compileSdkVersion 34

    defaultConfig {
        applicationId "com.example.myapp"
        minSdkVersion 21        // was 19
        targetSdkVersion 34
        versionCode flutterVersionCode.toInteger()
        versionName flutterVersionName
    }
}
```

Speichern, dann `flutter clean && flutter pub get && flutter build apk` ausführen. Der Merger wählt jetzt 21 aus der App und akzeptiert die 21 des Plugins.

### Weg B: Groovy-build.gradle mit flutter.minSdkVersion

Flutter 3.16 und neuer ersetzen das Literal durch eine Referenz auf eine Property, die vom Flutter-Gradle-Plugin gesetzt wird:

```groovy
// android/app/build.gradle
// Flutter 3.16 through 3.27 era template
android {
    defaultConfig {
        minSdkVersion flutter.minSdkVersion
    }
}
```

`flutter.minSdkVersion` steht ab Flutter 3.16 standardmäßig auf 21, sodass dieser Pfad bereits durchläuft. Wenn Ihr Projekt auf diesem Template ist und der Manifest-Merger trotzdem scheitert, überschreibt etwas die Property. Prüfen Sie `android/local.properties` auf eine veraltete Zeile `flutter.minSdkVersion=19` und löschen Sie sie, oder übergeben Sie `-Pflutter.minSdkVersion=21` an der Gradle-Befehlszeile, falls Ihre CI einen alten Wert injiziert. Ersetzen Sie die Property-Referenz nicht durch ein Literal; das Flutter-Gradle-Plugin in 3.41 schreibt `android/app/build.gradle` bei jedem `flutter run` unter bestimmten Bedingungen neu ([flutter/flutter#177141](https://github.com/flutter/flutter/issues/177141)) und macht Ihre Änderung rückgängig.

### Weg C: build.gradle.kts in Kotlin DSL

Flutter 3.29 hat das Template auf Kotlin DSL umgestellt. Die Form ist dieselbe in Kotlin-Syntax:

```kotlin
// android/app/build.gradle.kts
// Flutter 3.29 and later
android {
    defaultConfig {
        applicationId = "com.example.myapp"
        minSdk = flutter.minSdkVersion       // resolves to 21 on Flutter 3.29+
        targetSdk = flutter.targetSdkVersion
    }
}
```

Wenn Sie einen Wert explizit pinnen müssen (etwa weil ein anderes Plugin 23 verlangt), setzen Sie stattdessen `minSdk = 23`. Das Flutter-Gradle-Plugin respektiert explizite Literale im Kotlin-DSL-Template; nur das Groovy-Template hat aktuell den Überschreib-Bug.

Nach einem der drei Schritte führen Sie aus:

```bash
flutter clean
flutter pub get
flutter build apk --release
```

`flutter clean` ist hier wichtig, weil der Manifest-Merger seine Entscheidung in `build/app/intermediates/merged_manifest/` cached. Ein anschließender Build ohne Clean-Schritt spielt den fehlgeschlagenen Merge weiterhin von der Platte ab und Sie denken, Ihre Änderung hätte nichts bewirkt.

## Was das Heben von minSdkVersion auf 21 tatsächlich kostet

API 21 bedeutet Android 5.0 Lollipop, veröffentlicht im Oktober 2014. Googles eigenes [Verteilungs-Dashboard](https://developer.android.com/about/dashboards) (letzte sinnvolle Aktualisierung, bevor Google es in Android Studio verlagert hat) beziffert den Anteil der Geräte unterhalb von API 21 in 2026 deutlich unter 0,3 Prozent, fast ausschließlich alte Kindle-Fire-Tablets und nicht aktualisierte Geräte aus Emerging Markets. Der Play Store akzeptiert ohnehin keine neuen Releases mehr unter API 24, also ist das für eine über Play vertriebene App irrelevant. Wenn Sie APKs per Sideload oder über alternative Stores vertreiben, haben Sie eventuell ein Long-Tail-Publikum auf API 19 oder 20, und dann ist `background_fetch` schlicht keine Option: Es gibt keinen Shim. Verwenden Sie `WorkManager` direkt über einen [Pigeon](https://pub.dev/packages/pigeon)-Channel oder akzeptieren Sie einen Foreground-Service mit einer persistenten Notification.

## Folgefehler, nachdem der Merger durchläuft

Mehrere Folgefehler sehen aus wie der erste, haben aber andere Ursachen. Erkennen Sie sie, damit Sie nicht weiter `minSdkVersion` erhöhen und Kompatibilität ohne Grund brechen.

**Ein anderes Plugin braucht mehr als 21.** Wenn Sie nach dem Fix `cannot be smaller than version 23 declared in library [:flutter_blue_plus]` sehen, ist das ein anderes Plugin, das API 23 verlangt. Heben Sie `minSdkVersion` auf den höchsten von irgendeinem Plugin in Ihrem Baum deklarierten Wert. Listen Sie sie mit `./gradlew app:dependencies` aus `android/` auf.

**Fehlender Manifest-Tag für Headless-Tasks.** Wenn Sie `BackgroundFetch.registerHeadlessTask` verwenden, um Callbacks zu empfangen, während die App terminiert ist, muss das Manifest den Receiver deklarieren. Das Plugin-Manifest enthält ihn bereits, aber Apps, die manuell `tools:replace="android:label"` auf dem `<application>`-Tag setzen (ein Fix aus der AndroidX-Migrationsära), können versehentlich auch `android:name` überschreiben oder den Receiver verlieren. Lesen Sie [den AndroidX-Konflikt-Guide](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/), wenn Sie das vermuten; das Symptom ist still (kein Callback feuert), kein Build-Fehler.

**iOS-BGTaskScheduler-Identifier fehlt.** Der Android-Fehler ist der lauteste, aber eine parallele iOS-Konfiguration ist erforderlich. `Info.plist` braucht ein Array `BGTaskSchedulerPermittedIdentifiers` mit `com.transistorsoft.fetch`, und das Xcode-Projekt muss die Capability `background-fetch` unter Signing and Capabilities aktiviert haben. Der obige Android-Fix lässt den Build auf Android durchlaufen, aber der iOS-Build scheitert weiterhin oder, schlimmer, kompiliert und feuert in Produktion nie einen Callback.

**Der Gradle-Daemon cached das gemergte Manifest.** Auf CI reicht `flutter clean` nicht immer. Der Gradle-Daemon hält Ausgaben von `:app:processDebugManifest` in `~/.gradle/caches/`. Wenn ein CI-Lauf einmal mit dem alten `minSdkVersion` gescheitert ist, kann der nächste den Fehler wiederholen, sofern Sie nicht `./gradlew --stop` vor dem nächsten Build aufrufen oder das Cache-Verzeichnis löschen.

**Jetifier mit einem neueren AGP verändert den Fehler optisch.** AGP 8.7 deaktiviert Jetifier standardmäßig. Wenn Sie ihn in `gradle.properties` explizit wieder eingeschaltet haben (`android.enableJetifier=true`), läuft der Manifest-Merger, nachdem Jetifier das Bibliotheks-AAR umgeschrieben hat, und die Fehlermeldung tauscht `com.transistorsoft.flutter.backgroundfetch` gegen einen auf `androidx.*` umgeschriebenen Namen aus. Gleiche Ursache, anderer Oberflächentext. Der Fix ist identisch.

**Gepinntes NDK oder buildToolsVersion unter 30.** Eine sehr kleine Zahl langlebiger Projekte pinnt `buildToolsVersion "29.0.3"` in `android/app/build.gradle`. `background_fetch` 1.6 wurde gegen Android-14-Build-Tools kompiliert und verlinkt nicht gegen `JobService`-Symbole unterhalb von 30. Entfernen Sie das Pin oder heben Sie es auf `34.0.0`.

## Weiterführend

Die AndroidX-Migration ist die andere Hälfte des Grundes, warum Flutter-Android-Builds in alten Projekten brechen: Siehe [AndroidX-Konflikt während Flutter-Android-Build](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/) für detailliertes Manifest-Merger- und Jetifier-Verhalten. Wenn stattdessen `flutter pub get` scheitert, geht [version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/) die "because"-Kette des Constraint-Solvers durch. Das iOS-Pendant zu vielen derselben Symptome lebt in [Failed to build iOS app mit Xcode 16 und Flutter 3.x](/de/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/). Und wenn der eigentliche Android-Fehler die Gradle-Kommandozeile ist, nicht der Manifest-Merger, hat [Gradle build failed to produce an .apk file in MAUI Android](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) dieselben Triage-Schritte mit MAUI-spezifischen Pfaden, aber die AGP-Cache-Anmerkungen gelten genauso.

## Quellen

- [`background_fetch`-Paket auf pub.dev](https://pub.dev/packages/background_fetch)
- [`flutter_background_fetch` Android-Installationsanleitung](https://github.com/transistorsoft/flutter_background_fetch/blob/master/help/INSTALL-ANDROID.md)
- [Android `JobScheduler`-API-Referenz (hinzugefügt in API 21)](https://developer.android.com/reference/android/app/job/JobScheduler)
- [Android-Gradle-Plugin-Manifest-Merger-Dokumentation](https://developer.android.com/build/manage-manifests)
- [flutter/flutter#177141: Flutter-Gradle-Plugin überschreibt explizites `minSdk`](https://github.com/flutter/flutter/issues/177141)
- [Flutter 3.16 Release Notes: Standard-`minSdkVersion` auf 21 angehoben](https://docs.flutter.dev/release/release-notes/release-notes-3.16.0)
