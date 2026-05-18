---
title: "Fix: AndroidX-Konflikt beim Android-Build von Flutter"
description: "Die Lösung in 30 Sekunden: Setzen Sie android.useAndroidX=true und android.enableJetifier=true in android/gradle.properties, und finden Sie dann jedes Plugin, das noch auf der alten Support Library basiert, und aktualisieren oder ersetzen Sie es."
pubDate: 2026-05-18
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "androidx"
lang: "de"
translationOf: "2026/05/fix-androidx-conflict-during-flutter-android-build"
translatedBy: "claude"
translationDate: 2026-05-18
---

Die Lösung in einem Satz: Ein `AndroidX conflict` beim Android-Build von Flutter bedeutet, dass zwei Hälften Ihres Abhängigkeitsgraphen uneins sind, welche Android Support Library sie verwenden. Die Flutter-Engine und jedes in den letzten fünf Jahren veröffentlichte Plugin verwenden `androidx.*`. Ein einziges Plugin (oder eine transitive Java-Bibliothek), das weiterhin auf `android.support.*` verweist, reicht aus, um den Build zu zerstören. Setzen Sie `android.useAndroidX=true` und `android.enableJetifier=true` in `android/gradle.properties`, führen Sie `flutter clean` aus, dann erneut `flutter pub get` und `flutter build apk`. Wenn Gradle weiterhin verweigert, finden Sie das schuldige Plugin mit `./gradlew app:dependencies` und aktualisieren oder ersetzen Sie es. Bearbeiten Sie noch nichts unter `android/app/build.gradle`.

```text
* What went wrong:
Execution failed for task ':app:checkDebugDuplicateClasses'.
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules
    core-1.6.0-runtime (androidx.core:core:1.6.0) and
    support-compat-28.0.0-runtime (com.android.support:support-compat:28.0.0)

  Go to the documentation to learn how to <a href="d.android.com/r/tools/classpath-sync-errors">Fix dependency resolution errors</a>.

FAILURE: Build failed with an exception.
BUILD FAILED in 12s
```

Diese Anleitung ist gegen Flutter 3.41.5, Dart 3.11, Android Gradle Plugin 8.7 und Gradle 8.11 geschrieben, den stabilen Kanal im Mai 2026. Das hier beschriebene Verhalten ist dasselbe, seit das Android-Tooling-Team den Namespace `android.support.*` 2018 eingefroren und Jetifier als Brücke für Legacy-Bytecode veröffentlicht hat. Das Flutter-Projekt hat AndroidX für neue Apps standardmäßig in [Flutter 1.12](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (Dezember 2019) aktiviert; alles, was seitdem generiert wurde, wird mit `useAndroidX=true` ab Werk ausgeliefert. Wenn Sie auf diesen Fehler stoßen, wurde die App fast sicher auf einem Flutter-SDK vor 1.12 erstellt und die Migration wurde nie angewendet.

## Was der Fehler tatsächlich bedeutet

`androidx.*` ist die zweite Generation der Android Support Library. Google hat den Paket-Namespace einmal umgeschrieben und zugesagt, ihn nie wieder umzubenennen. Klassen unter `android.support.v4.*`, `android.support.v7.*`, `android.support.design.*` usw. sind die ursprünglichen Support Libraries und sind seit 28.0.0 im September 2018 eingefroren.

Das Android-Build-System weigert sich, ein APK zu kompilieren, das beide Hälften gleichzeitig enthält, weil die duplizierten Klassennamen auf dem Classpath kollidieren. Der Fehler tritt in einer von drei konkreten Formen auf:

```text
> Duplicate class android.support.v4.app.INotificationSideChannel found in modules ...
```

```text
This app is using AndroidX dependencies, but the project does not have
the property android.useAndroidX set to true. Configure your project for
AndroidX. See https://goo.gle/flutter-androidx-migration
```

```text
Cannot fit requested classes in a single dex file (# methods: 73512 > 65536)
```

Der erste ist eine wörtliche Classpath-Kollision. Der zweite ist die Pre-Flight-Prüfung des Flutter-Tools, die bemerkt, dass das Projekt noch den Legacy-Standard hat. Der dritte ist derselbe Konflikt weiter unten ausgedrückt: Das Hereinziehen beider Bibliotheken sprengt das 64K-Methodenlimit von Dalvik, weil jede Support-Klasse einen AndroidX-Zwilling hat.

Jetifier ist der Workaround, der mit AGP ausgeliefert wird. Zur Build-Zeit schreibt er jede `android.support.*`-Referenz in jedem JAR oder AAR, das von einer Drittabhängigkeit stammt, in die entsprechende `androidx.*`-Referenz um. Mit aktiviertem Jetifier wird ein Plugin, das noch Support-Library-Bytecode ausliefert, stillschweigend übersetzt und die Klassenduplikat-Kollision verschwindet. Mit deaktiviertem Jetifier wird das Duplikat sichtbar und der Build schlägt fehl. AGP 8 und höher setzen `enableJetifier` aus Build-Geschwindigkeitsgründen standardmäßig auf `false`, weshalb dieser Fehler wieder auf der Titelseite ist für Projekte, die jahrelang lebten, ohne dass jemand das Legacy-Plugin in ihrem Baum bemerkte.

## Eine minimale Reproduktion

Erstellen Sie eine frische Flutter-App auf einem aktuellen SDK und fügen Sie dann ein Plugin hinzu, das noch über eine transitive Java-Abhängigkeit auf die Support Library verweist:

```bash
# Flutter 3.41.5
flutter create androidx_repro
cd androidx_repro
flutter pub add some_old_plugin:^1.2.0  # any plugin whose Android side
                                        # depends on com.android.support:*
```

Schalten Sie dann den Workaround absichtlich aus:

```properties
# android/gradle.properties, Flutter 3.41.5, AGP 8.7
org.gradle.jvmargs=-Xmx4G -XX:MaxMetaspaceSize=2G
android.useAndroidX=true
android.enableJetifier=false
```

Führen Sie den Build aus:

```bash
flutter build apk --debug
```

Gradle gibt den oben gezeigten Fehler über duplizierte Klassen aus und beendet mit einem Code ungleich null. Die einzige Zeile, die den Regress auslöst, ist `enableJetifier=false` kombiniert mit einer transitiven Abhängigkeit von `com.android.support:*`. Schalten Sie Jetifier wieder ein, und derselbe Build gelingt, obwohl sich am Plugin-Baum nichts geändert hat.

## Fix, in der Reihenfolge, wie oft es die Antwort ist

Führen Sie die Schritte in der Reihenfolge aus. Jeder Schritt setzt voraus, dass der vorherige den Fehler nicht behoben hat.

### 1. Setzen Sie beide AndroidX-Flags

Öffnen Sie `android/gradle.properties` (nicht die Gradle-Datei im Flutter-SDK, nicht die `build.gradle` des Root-Projekts) und bestätigen Sie, dass beide Zeilen vorhanden sind:

```properties
# android/gradle.properties, Flutter 3.41.5
android.useAndroidX=true
android.enableJetifier=true
```

`useAndroidX=true` teilt AGP mit, dass Ihr eigener Code und die Flutter-Engine AndroidX sind. `enableJetifier=true` teilt AGP mit, jeden Drittanbieter-Bytecode umzuschreiben, der noch auf die Support Library verweist. Sie brauchen beide. Nur `useAndroidX=true` zu setzen, während ein Plugin noch Support-Klassen ausliefert, ist genau die Konfiguration, die den Fehler der duplizierten Klassen produziert.

Falls die Datei nicht existiert (selten in einem Flutter-1.12+-Projekt, häufig in Apps, die von nativem Android migriert wurden), erstellen Sie sie. Führen Sie dann aus:

```bash
flutter clean
flutter pub get
flutter build apk --debug
```

`flutter clean` ist hier erforderlich, weil Gradle den Abhängigkeitsauflösungs-Graph cached; ohne ihn wird der Build den fehlgeschlagenen Graph wiederverwenden und denselben Fehler melden.

### 2. Finden und aktualisieren Sie das Legacy-Plugin

Wenn Jetifier eingeschaltet ist und der Build immer noch fehlschlägt, ist das Duplikat nicht die Support Library selbst, sondern ein Plugin, dessen `android/build.gradle` `com.android.support:*` direkt deklariert und etwas verwendet, das Jetifier nicht umschreiben kann (Annotation Processors sind die häufigsten Übeltäter, da Jetifier standardmäßig nur auf JARs des Runtime-Classpaths operiert).

Listen Sie den Android-Abhängigkeitsbaum auf:

```bash
# from android/ directory, Flutter 3.41.5
./gradlew app:dependencies --configuration releaseRuntimeClasspath | grep -i "com.android.support"
```

Die Ausgabe benennt das Plugin und die Support-Library-Koordinate. Querverweisen Sie sie mit Ihrer `pubspec.yaml`. Drei Auflösungen, in der Reihenfolge der Präferenz:

1. **Aktualisieren Sie das Plugin**, falls eine neuere Version existiert. Führen Sie `flutter pub outdated` aus und suchen Sie den Übeltäter. Eine nach Ende 2019 veröffentlichte Version ist nativ AndroidX und der Konflikt verschwindet.
2. **Ersetzen Sie das Plugin**, falls es nicht mehr gewartet wird. Die Flutter-Community hat die meisten Plugins von vor 1.12 unter einem anderen Namen neu aufgebaut; suchen Sie auf [pub.dev](https://pub.dev) nach derselben Domäne (Benachrichtigungen, Image Picker usw.) und wählen Sie die aktuellste gewartete Option.
3. **Forken und patchen** Sie, falls keines davon hilft. Klonen Sie das Repo des Plugins, ändern Sie jede `com.android.support:appcompat-v7:28.0.0`-Zeile in `android/build.gradle` zu `androidx.appcompat:appcompat:1.6.1` (das [AndroidX-Klassenmapping](https://developer.android.com/jetpack/androidx/migrate/class-mappings) übersetzt die alten Namen in die neuen), aktualisieren Sie Ihre `pubspec.yaml`, um über `git:` auf den Fork zu zeigen, und führen Sie `flutter pub get` aus.

### 3. Heben Sie `compileSdk` auf eine Version an, die AndroidX enthält

Wenn Sie diese App von nativem Android migriert haben, kann die `android/app/build.gradle` `compileSdkVersion` auf 28 oder niedriger festsetzen. AndroidX erfordert `compileSdk` 28 oder höher und funktioniert am besten mit dem aktuellsten Stable. Flutter 3.41.5 setzt `flutter.compileSdkVersion` standardmäßig auf 35; falls Sie das überschrieben haben, stellen Sie den Standard wieder her oder setzen Sie ihn explizit:

```groovy
// android/app/build.gradle, Flutter 3.41.5, AGP 8.7
android {
    namespace "com.example.androidx_repro"
    compileSdk 35
    ndkVersion flutter.ndkVersion

    defaultConfig {
        applicationId "com.example.androidx_repro"
        minSdkVersion 21      // AndroidX requires at least 19; pick 21 unless you have a reason
        targetSdkVersion 35
    }
}
```

`minSdkVersion 21` ist die praktische Untergrenze für eine AndroidX-App im Jahr 2026. Niedriger zu gehen funktioniert im Prinzip, zieht aber Kompatibilitäts-Shims herein, die andere, aber gleichermaßen verwirrende Classpath-Fehler während des Merge-Schritts produzieren.

### 4. Aktivieren Sie multidex, falls das Duplikat weg ist, aber der Dex-Limit-Fehler bleibt

Das 64K-Methodenlimit ist älter als AndroidX und AGP schaltet multidex automatisch ein, wenn `minSdkVersion >= 21`. Falls Sie immer noch den Fehler "cannot fit requested classes" sehen, haben Sie eine `minSdk` unter 21 und müssen sich explizit anmelden:

```groovy
// android/app/build.gradle
android {
    defaultConfig {
        multiDexEnabled true
    }
}

dependencies {
    implementation "androidx.multidex:multidex:2.0.1"
}
```

Das ist keine Lösung für den AndroidX-Konflikt selbst, es ist der Aufräum-Pass, wenn Sie die duplizierten Klassen bereits behoben haben, aber die übrig gebliebene Methodenzahl immer noch überläuft.

### 5. Letzter Ausweg: Jetifier nur ausschalten, nachdem jede Abhängigkeit geprüft wurde

Sobald Sie über `./gradlew app:dependencies` bestätigt haben, dass kein Plugin im Baum noch auf `com.android.support:*` verweist, setzen Sie `android.enableJetifier=false` für den Build-Geschwindigkeitsgewinn. Die Classpath-Umschreibung von Jetifier ist der teuerste einzelne Schritt in einem kalten Android-Build für eine große Flutter-App (15-30 Sekunden in einem typischen Projekt nach unseren Messungen). Ihn zu deaktivieren erfordert keine Änderungen an Ihrem Code oder Ihren pub-Abhängigkeiten, aber wenn Sie das tun, ohne vorher zu prüfen, kommt der Konflikt zurück, sobald das nächste Mal ein transitives Update eine Legacy-Bibliothek hereinzieht, und Sie werden denken, dass der Fehler nichts mit Jetifier zu tun hat, weil Sie ihn vor Wochen entfernt haben.

## Stolperfallen und ähnliche Fälle

Einige Fälle, die einen ähnlichen Fehler produzieren oder wie ein AndroidX-Konflikt aussehen, es aber nicht sind:

- **`Could not find com.android.tools.build:gradle:X.Y.Z`**: kein AndroidX-Problem. Das Google Maven Repository ist nicht erreichbar, oder Ihre `settings.gradle` hat den Eintrag für das `google()`-Repository verloren. Fügen Sie `google()` zu `pluginManagement.repositories` und `dependencyResolutionManagement.repositories` hinzu.
- **`Manifest merger failed : Attribute application@appComponentFactory ...`**: das ist die historische Signatur eines AndroidX/Support-Konflikts speziell im Manifest, bevor die bytecode-Level-Prüfung von AGP existierte. Dieselbe Lösung (beide Flags aktivieren) behebt es, aber der Auslöser ist das `AndroidManifest.xml` eines Plugins, das einen `android.support.*`-Komponentennamen deklariert, anstatt dass sein Java-Code auf eine Support-Klasse verweist.
- **`Class not found: com.android.support.FileProvider`**: das `AndroidManifest.xml` eines Plugins hardcodiert den Support-Library-Pfad. Jetifier schreibt Manifest-XML standardmäßig nicht um. Aktualisieren Sie entweder das Plugin oder überschreiben Sie das `<provider>`-Element in Ihrem eigenen `AndroidManifest.xml` mit dem AndroidX-Äquivalent (`androidx.core.content.FileProvider`).
- **`Execution failed for task ':app:processDebugMainManifest'`** während eines `flutter run` auf einem Release-Build: meist ein `targetSdkVersion`-Mismatch zwischen Plugins. AndroidX ist in Ordnung; der Merge schlägt fehl, weil zwei Plugins über `android:exported` für eine Activity uneinig sind. Nicht verwandt, auch wenn es im selben Gradle-Schritt auftaucht.
- **Build gelingt unter macOS, schlägt aber auf Linux CI fehl**: die häufigste Ursache ist ein veralteter `~/.gradle/caches` auf der Entwicklermaschine, der die fehlende AndroidX-Flag verdeckt. Der Linux-Runner hat einen sauberen Cache und löst den Abhängigkeitsgraph von Grund auf neu auf. Die Lösung ist dieselbe (die Flags), aber das Symptom sieht wie ein reines CI-Problem aus.
- **Ein frisches `flutter create`-Projekt trifft auf diesen Fehler**: sollte es nicht. Wenn eine brandneue App auf einen AndroidX-Konflikt trifft, bevor Sie irgendein Plugin hinzufügen, ist Ihr Flutter-SDK älter als 1.12 und Sie müssen aktualisieren. Führen Sie `flutter upgrade` aus und führen Sie `flutter create` gegen das neue SDK erneut aus; kopieren Sie Ihr `lib/` herüber, statt das kaputte Projekt zu bearbeiten.

Wenn Sie mehr als einmal pro Jahr im selben Projekt zu `enableJetifier=true` greifen, haben Sie mindestens ein Plugin, dessen Maintainer aufgehört hat, der Android-Plattform zu folgen. Ersetzen Sie es. Jetifier ist offiziell als vorübergehender Shim deklariert, und das AGP-Team hat öffentlich erklärt, dass es in einem zukünftigen Major-Release entfernt wird.

## Verwandt

- [Fix: Version solving failed in pubspec.yaml](/de/2026/05/fix-version-solving-failed-in-pubspec-yaml/)
- [Fix: Gradle build failed to produce an .apk file in MAUI Android](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/)
- [Fix: Failed to build iOS app mit Xcode 16 und Flutter 3.x](/de/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/)
- [Wie man mehrere Flutter-Versionen aus einer einzigen CI-Pipeline anvisiert](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/)
- [Fix: A RenderFlex overflowed by N pixels in Flutter](/de/2026/05/fix-renderflex-overflowed-in-flutter/)

## Quellen

- [AndroidX-Migration für Flutter](https://docs.flutter.dev/release/breaking-changes/androidx-migration) (docs.flutter.dev)
- [Migrate to AndroidX](https://developer.android.com/jetpack/androidx/migrate) (developer.android.com)
- [AndroidX-Klassenmapping](https://developer.android.com/jetpack/androidx/migrate/class-mappings) (developer.android.com)
- [Release Notes des Android Gradle Plugin: Standard von enableJetifier](https://developer.android.com/build/releases/gradle-plugin) (developer.android.com)
- [flutter/flutter issue 25325: AndroidX-Support-Tracking](https://github.com/flutter/flutter/issues/25325) (kanonischer Thread für die ursprüngliche Migration)
