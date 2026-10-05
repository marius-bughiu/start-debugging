---
title: "Lösung: ClassNotFoundException für MainActivity beim Start einer Flutter-Android-App"
description: "Das .MainActivity im Manifest wird gegen den Gradle-namespace aufgelöst, und im APK gibt es keine Klasse mit diesem Namen. Bringen Sie namespace, die package-Zeile in Kotlin und das Manifest in Übereinstimmung."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
lang: "de"
translationOf: "2026/10/fix-classnotfoundexception-for-mainactivity-when-a-flutter-android-app-launches"
translatedBy: "claude"
translationDate: 2026-10-06
---

Die Activity-Klasse, die in Ihrer zusammengeführten `AndroidManifest.xml` genannt wird, existiert nicht in den dex-Dateien des APK. In einer Flutter-App bedeutet das fast immer, dass bei einer Umbenennung einer von drei Werten auseinandergelaufen ist: `namespace` in `android/app/build.gradle.kts` (gegen den `.MainActivity` im Manifest aufgelöst wird), die `package`-Zeile am Anfang von `MainActivity.kt` oder das Flavor-Source-Set, in dem die Datei liegt. Setzen Sie die `package`-Zeile gleich `namespace`, lassen Sie `applicationId` unverändert, sofern Sie nicht wirklich eine neue Store-Identität wollen, und führen Sie dann `flutter clean` aus und kompilieren neu. Der Ordner, in dem die `.kt`-Datei liegt, spielt keine Rolle.

Alles Folgende wurde unter macOS mit Flutter 3.44.8 (Dart 3.12.2) reproduziert, dessen `flutter create`-Template AGP 9.0.1, Kotlin 2.3.20 und Gradle 9.1.0 festlegt, auf einem arm64-Emulator mit Android 16 (API 36). Jedes Szenario wurde mit `flutter build apk` gebaut, mit `aapt2` und `dexdump` aus build-tools 36.1.0 untersucht und mit `adb shell am start` gestartet.

## Der Fehler im Kontext

Das ist der Absturz aus meiner Reproduktion, nachdem nur `namespace` geändert wurde (Pfade gekürzt):

```text
E AndroidRuntime: FATAL EXCEPTION: main
E AndroidRuntime: java.lang.RuntimeException: Unable to instantiate activity ComponentInfo{com.example.clsrepro/com.acme.shop.MainActivity}: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[[zip file "/data/app/~~.../com.example.clsrepro-.../base.apk"],nativeLibraryDirectories=[/data/app/~~.../lib/arm64, /system/lib64, /system_ext/lib64]]
E AndroidRuntime: Caused by: java.lang.ClassNotFoundException: Didn't find class "com.acme.shop.MainActivity" on path: DexPathList[...]
```

Lesen Sie den Teil `ComponentInfo{A/B}` genau, denn er verrät, welcher Wert falsch ist. `A` ist die Application ID, unter der die App installiert wurde. `B` ist die vollqualifizierte Klasse, die das System instanziieren wollte. Wenn `B` keine Klasse ist, die in Ihrem Kotlin-Code existiert, sind sich Manifest und Code uneinig. Der Build gelingt, das APK wird installiert, und die App stirbt, bevor die Flutter-Engine startet, sodass weder Ihr Dart-Code noch Ihre Protokollierung ausgeführt wird. Der Stack Trace steht in `adb logcat -b crash`.

## Warum die Klasse fehlt

Android startet Ihre App, indem es das `android:name` der Launcher-Activity aus dem zusammengeführten Manifest liest und genau diesen Klassennamen aus den `classes*.dex` des APK lädt. Das Flutter-Template schreibt ihn in Kurzform:

```xml
<!-- android/app/src/main/AndroidManifest.xml, Flutter 3.44.8 template -->
<activity
    android:name=".MainActivity"
    android:exported="true"
    ... >
```

Ein Name, der mit einem Punkt beginnt, wird an den `namespace` des Moduls aus `build.gradle.kts` angehängt, nicht an die `applicationId` und nicht an das Package, das Ihre Kotlin-Datei deklariert. Die Klasse, die im dex landet, erhält ihren Namen von der `package`-Zeile in `MainActivity.kt`. Nichts im Build prüft, ob die beiden übereinstimmen, also gibt es drei Wege zum Absturz:

1. **`namespace` wurde geändert, die Kotlin-`package`-Zeile nicht.** Das Manifest zeigt jetzt auf `<new namespace>.MainActivity`, das dex enthält noch `<old package>.MainActivity`.
2. **Die Kotlin-`package`-Zeile wurde geändert, `namespace` nicht.** Das Spiegelbild von 1.
3. **Die Klasse wird in diese Variante gar nicht kompiliert.** Typischerweise wurde `MainActivity.kt` in ein Flavor-Source-Set (`src/free/kotlin`) verschoben und Sie haben einen anderen Flavor gebaut, oder die Datei wurde gelöscht, als jemand den Ordner `android/` neu generiert hat.

Es liegt nicht an R8. Der Ressourcenschritt (AAPT2) erzeugt für jede im Manifest referenzierte Klasse eine Keep-Regel, sodass ein Release-Build `MainActivity` nicht wegoptimieren kann. Mehr dazu weiter unten.

## Minimale Reproduktion

Beginnen Sie mit einem sauberen Template und ändern Sie eine Zeile:

```bash
# Flutter 3.44.8, AGP 9.0.1
flutter create --org com.example --platforms android clsrepro
cd clsrepro
```

```kotlin
// android/app/build.gradle.kts, Flutter 3.44.8 template, AGP 9.0.1
android {
    namespace = "com.acme.shop"          // was "com.example.clsrepro"
    // ...
    defaultConfig {
        applicationId = "com.example.clsrepro"
        // ...
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/example/clsrepro/MainActivity.kt, unchanged
package com.example.clsrepro

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

`flutter build apk --debug` gelingt. Das hier ist tatsächlich im APK enthalten, und das passierte beim Start, für jede Variante, die ich ausprobiert habe:

| Szenario | Manifest `android:name` (zusammengeführt) | Klasse im dex | Ergebnis |
|---|---|---|---|
| Template-Ausgangszustand | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | läuft |
| nur `namespace` geändert | `com.acme.shop.MainActivity` | `com.example.clsrepro.MainActivity` | **ClassNotFoundException** |
| nur `applicationId` geändert | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | läuft (installiert als `com.acme.shop`) |
| nur Kotlin-`package`-Zeile geändert | `com.example.clsrepro.MainActivity` | `com.acme.shop.MainActivity` | **ClassNotFoundException** |
| `namespace` und `package`-Zeile geändert, Datei im alten Ordner belassen | `com.acme.shop.MainActivity` | `com.acme.shop.MainActivity` | läuft |
| `MainActivity.kt` in `src/free/kotlin`, Flavor `free` | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | läuft |
| dasselbe, Flavor `paid` | `com.example.clsrepro.MainActivity` | (keine) | **ClassNotFoundException** |
| Template-Ausgangszustand, `--release` (R8 an) | `com.example.clsrepro.MainActivity` | `com.example.clsrepro.MainActivity` | läuft |

Zwei Zeilen verdienen einen genauen Blick. Nur `applicationId` zu ändern ist harmlos, weil der Klassenname nie davon abhing. Und die Datei passend zum neuen Package zu verschieben ist nicht nötig: Kotlin erzwingt nicht, dass das Verzeichnis zur `package`-Deklaration passt, sodass die Zeile mit der Datei noch unter `com/example/clsrepro/` problemlos läuft. Die meisten Anleitungen zum "Umbenennen Ihres Flutter-Packages" sagen, Sie sollen zuerst Ordner verschieben, und genau das ist der Schritt, der am wenigsten zählt.

## Die Lösung, Schritt für Schritt

### 1. Die drei Werte aus dem gebauten APK lesen, nicht aus dem Quellcode

Quelldateien können lügen (ein nicht gespeicherter Editor, ein Flavor-Override, ein Manifest-Platzhalter). Das APK nicht. Mit den Android-SDK-build-tools in Ihrem `PATH`:

```bash
# Android SDK build-tools 36.1.0, after flutter build apk --debug
APK=build/app/outputs/flutter-apk/app-debug.apk

# 1. The application ID it installs as
aapt2 dump packagename $APK

# 2. The activity class the manifest asks for
aapt2 dump xmltree --file AndroidManifest.xml $APK | grep -A2 "E: activity" | grep android:name

# 3. The MainActivity classes that actually exist
unzip -o -q $APK 'classes*.dex' -d /tmp/dex
for d in /tmp/dex/classes*.dex; do dexdump $d | grep "Class descriptor" | grep MainActivity; done
```

Bei der kaputten `namespace`-Reproduktion gab das für Schritt 2 `com.acme.shop.MainActivity` und für Schritt 3 `Lcom/example/clsrepro/MainActivity;` aus. Wenn Schritt 3 nichts ausgibt, liegt der Fall "nicht in diese Variante kompiliert" vor; springen Sie zu Schritt 4.

### 2. Die Kotlin-`package`-Zeile an `namespace` angleichen

Entscheiden Sie, in welchem Namen Ihr Code leben soll, und setzen Sie dann beide darauf:

```kotlin
// android/app/build.gradle.kts, AGP 9.0.1
android {
    namespace = "com.acme.shop"
    defaultConfig {
        applicationId = "com.acme.shop"   // only if you want a new store identity, see below
    }
}
```

```kotlin
// android/app/src/main/kotlin/com/acme/shop/MainActivity.kt, Flutter 3.44.8
package com.acme.shop

import io.flutter.embedding.android.FlutterActivity

class MainActivity : FlutterActivity()
```

Verschieben Sie die Datei der Ordnung halber nach `kotlin/com/acme/shop/`, wenn Sie möchten. Für Kotlin ist das optional. Ist Ihre Activity eine Java-Datei (`MainActivity.java`, üblich in älteren Flutter-Projekten), verschieben Sie sie ebenfalls: Java-Konventionen und IDE-Refactorings erwarten, dass das Verzeichnis zum Package passt.

Wenn Sie `namespace` lieber nicht anfassen, können Sie stattdessen den vollqualifizierten Namen ins Manifest schreiben (`android:name="com.example.clsrepro.MainActivity"`). Das funktioniert, verdeckt die Abweichung aber, statt sie zu beseitigen, und die nächste Änderung an `namespace` zieht ihn nicht mit.

### 3. Nach Resten des alten Namens suchen

Eine Umbenennung, die eine Datei übersieht, erzeugt genau diesen Absturz. Durchsuchen Sie den gesamten `android/`-Baum, einschließlich der Manifeste anderer Source-Sets (`src/debug/AndroidManifest.xml`, `src/profile/AndroidManifest.xml`) und aller anderen Kotlin- oder Java-Dateien, die das alte Package deklarieren:

```bash
# from the Flutter project root
grep -rn "com.example.clsrepro" android/ --include='*.kt' --include='*.java' --include='*.xml' --include='*.kts' --include='*.gradle'
```

Eigene `Application`-Unterklassen, `BroadcastReceiver`s und `Service`s, die mit führendem Punkt deklariert sind, werden auf dieselbe Weise gegen `namespace` aufgelöst und stürzen daher mit derselben Exception ab (die Meldung nennt lediglich eine andere Klasse, und bei einer `Application` heißt es "Unable to instantiate application").

### 4. Wenn die Klasse komplett fehlt, das Source-Set korrigieren

Wenn `dexdump` überhaupt keine `MainActivity` zeigt, finden Sie heraus, wo die Datei liegt:

```bash
find android/app/src -name 'MainActivity.*'
```

Alles unter `src/main/` wird in jede Variante kompiliert. Alles unter `src/<flavor>/` oder `src/<buildType>/` wird nur für diese Variante kompiliert. In meiner Reproduktion führte `MainActivity.kt` in `src/free/kotlin` zusammen mit `flutter run --flavor paid` zu `Didn't find class "com.example.clsrepro.MainActivity"` unter der Application ID `com.example.clsrepro.paid`. Verschieben Sie die Datei entweder zurück nach `src/main/kotlin` oder geben Sie jedem Flavor eine eigene Kopie mit demselben Package. Ist die Datei schlicht verschwunden (ein neu generierter `android/`-Ordner), erstellen Sie sie anhand des obigen Templates neu.

### 5. Bereinigen und neu installieren

```bash
# Flutter 3.44.8
flutter clean
flutter pub get
flutter run
```

Veraltete Zwischenartefakte können nach einer Umbenennung ein altes dex am Leben halten, und eine alte Installation unter der vorherigen Application ID kann noch das Launcher-Symbol besitzen, auf das Sie tippen. Wenn Sie `applicationId` geändert haben, deinstallieren Sie das alte Package (`adb uninstall com.example.clsrepro`), damit Sie nicht weiter den vorherigen Build testen.

## applicationId ändern im Vergleich zu namespace

Diese beiden Werte beantworten unterschiedliche Fragen, und die meisten Abstürze entstehen, wenn man sie als einen behandelt:

- `applicationId` ist die Identität auf dem Gerät und bei Google Play. Eine Änderung nach der Veröffentlichung erzeugt aus Sicht von Play eine andere App. Sie beeinflusst nie Klassennamen.
- `namespace` ist das Package für die generierten Klassen `R` und `BuildConfig` und die Basis für jeden verkürzten Klassennamen im Manifest. Es betrifft nur den Code.

Die Android-Dokumentation empfiehlt, `applicationId` immer explizit zu setzen, denn fehlt es, wird auf `namespace` zurückgegriffen, und dann ändert eine Umbenennung auf Code-Ebene stillschweigend auch Ihre Store-Identität. Das Flutter-Template setzt bereits beide. Wenn Sie nur eine neue Bundle ID für einen neuen Store-Eintrag wollen, ändern Sie `applicationId` und sonst nichts: Das ist die einzige Umbenennung in der Tabelle oben, die diesen Absturz nicht verursachen kann.

Das Umbenennen der Activity-Klasse selbst nach der Auslieferung hat zudem einen Preis. Die `<activity>`-Dokumentation sagt, man solle `android:name` einer exportierten Activity nach der Veröffentlichung der App nicht ändern. Die Flutter-`MainActivity` ist exportiert, und Launcher-Verknüpfungen sowie angeheftete Symbole auf den Startbildschirmen der Nutzer referenzieren die Komponente über ihren Klassennamen. Wenn Sie sie verschieben müssen, hält ein `<activity-alias>` mit dem alten Namen, der auf die neue Klasse zeigt, bestehende Verknüpfungen funktionsfähig.

## Release-Builds und R8

Eine häufige Vermutung lautet, R8 habe `MainActivity` in einem Release-Build entfernt. Das tut es nicht, solange das Manifest sie nennt. Während der Ressourcenverarbeitung schreibt AAPT2 eine Keep-Regel für jede Komponente, die es im Manifest findet. In meinem Release-Build enthielt `build/app/intermediates/aapt_proguard_file/release/processReleaseResources/aapt_rules.txt`:

```text
-keep class com.example.clsrepro.MainActivity { <init>(); }
```

und `mapping.txt` bildete die Klasse unumbenannt auf sich selbst ab. Das Release-APK startete problemlos. Wenn also ein Release-Build mit diesem Fehler scheitert, während Debug funktioniert, suchen Sie nach einem Unterschied zwischen den Varianten (ein reines Release-Manifest in `src/release/`, ein Flavor-Source-Set), bevor Sie ProGuard-Regeln schreiben. Eine Klasse, die R8 tatsächlich entfernt, ist eine, die Sie nur per Reflection erreichen und nie in einem Manifest erwähnen, und das zeigt sich meist später als `ClassNotFoundException` für genau diese Klasse, nicht für `MainActivity`.

## Ähnlich aussehende Fehler

- **Ein Build-Fehler zu `io.flutter.app.FlutterActivity` oder `FlutterApplication`**: eine App, die noch das v1-Android-Embedding nutzt. Das ist ein Migrationsproblem, behandelt in der [Checkliste zur Migration von Flutter 2 auf 3.x](/de/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/).
- **Der Build scheitert, bevor ein APK existiert** (Kotlin-Daemon- oder Gradle-Fehler): Sie erreichen den Start nie. Siehe [Daemon compilation failed: null](/de/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/) und [Timeout waiting to lock journal cache](/de/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/).
- **`MissingPluginException` auf einem Method Channel**: Die Activity startete problemlos, aber ein Handler wurde an der falschen Stelle registriert. Das Muster zur Channel-Registrierung finden Sie unter [plattformspezifischen Code ohne Plugins hinzufügen](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/).

## Verwandte Artikel

- [Ein Flutter-Android-Projekt auf AGP 9 mit integriertem Kotlin migrieren](/de/2026/09/migrate-a-flutter-android-project-to-agp-9-with-built-in-kotlin/), einschließlich der Prüfung, ob Ihre `MainActivity` nach der Migration im dex angekommen ist.
- [Lösung: e: Daemon compilation failed: null in einem Flutter-Android-Gradle-Build](/de/2026/09/fix-daemon-compilation-failed-null-in-a-flutter-android-gradle-build/)
- [Wie Sie plattformspezifischen Code in Flutter ohne Plugins hinzufügen](/de/2026/05/how-to-add-platform-specific-code-in-flutter-without-plugins/)
- [Lösung: Timeout waiting to lock journal cache in einem Flutter-Android-Build](/de/2026/10/fix-timeout-waiting-to-lock-journal-cache-in-a-flutter-android-build/)

## Quellen

- [Configure the app module: namespace and application ID](https://developer.android.com/build/configure-app-module), Android Developers.
- [`<activity>` element, `android:name`](https://developer.android.com/guide/topics/manifest/activity-element#nm), Android Developers.
- [Set the application ID](https://developer.android.com/build/configure-app-module#set-application-id), Android Developers.
- [Shrink, obfuscate, and optimize your app](https://developer.android.com/build/shrink-code), Android Developers.
- [Build and release an Android app](https://docs.flutter.dev/deployment/android), Flutter-Dokumentation.
