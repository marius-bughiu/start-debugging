---
title: "Lösung: An error occurred while preparing SDK package NDK (Side by side): Not in GZIP format"
description: "Der SDK Manager entpackt erneut ein beschädigtes Archiv aus .downloadIntermediates. Löschen Sie diesen Ordner und das halb entpackte Verzeichnis ndk/<version>, und kompilieren Sie neu."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "android"
  - "gradle"
  - "ndk"
lang: "de"
translationOf: "2026/08/fix-an-error-occurred-while-preparing-sdk-package-ndk-not-in-gzip-format"
translatedBy: "claude"
translationDate: 2026-08-14
---

Löschen Sie den Download-Cache des SDK Managers und das teilweise entpackte NDK-Verzeichnis, und kompilieren Sie erneut. Das Archiv, das entpackt wird, ist beschädigt, und da es zwischengespeichert wird, schlägt jeder weitere Versuch identisch fehl, bis Sie es entfernen. Unter Windows sind das `%LOCALAPPDATA%\Android\Sdk\.downloadIntermediates` und `%LOCALAPPDATA%\Android\Sdk\ndk\28.2.13676358`. Schlägt es nach einem geleerten Cache erneut fehl, sitzen Sie hinter einem Proxy oder einem TLS-inspizierenden Virenscanner, der einen 750-MB-Download umschreibt, und die Antwort lautet: das NDK von Hand aus `dl.google.com` installieren.

## Der Fehler, vollständig

Die Meldung erscheint mitten im Build, meist während der Konfigurationsphase von Gradle, und ist eine Warnzeile und nicht der eigentliche Fehlschlag:

```
Preparing "Install NDK (Side by side) 28.2.13676358 v.28.2.13676358".
Warning: An error occurred while preparing SDK package NDK (Side by side) 28.2.13676358: Not in GZIP format.

FAILURE: Build failed with an exception.
```

Darunter liegt eine `java.util.zip.ZipException: Not in GZIP format` aus dem `GZIPInputStream`, und die Versionsnummer richtet sich danach, was Ihr Projekt festlegt. Zwei Dinge identifizieren genau diesen Fehlschlag: der Paketname `NDK (Side by side)` und die Tatsache, dass er sich Byte für Byte bei jedem Versuch reproduziert, auch nach einem Neustart, einem `flutter clean` und einem Neustart von Android Studio. Ein tatsächlich instabiles Netzwerk erzeugt jedes Mal einen anderen Fehler. Dieser nicht.

## Warum lädt ein Flutter-Build das NDK überhaupt herunter?

Das ist der Punkt, der viele überrascht: Eine Flutter-App ohne nativen Code, ohne C++ und ohne `externalNativeBuild`-Block lädt beim ersten Build trotzdem ein 750 MB großes NDK herunter. Das ist Absicht, und es geht auf Flutter zurück, nicht auf das Android Gradle Plugin.

AGP braucht das NDK, um Debug-Symbole aus nativen Bibliotheken zu entfernen, lädt es aber nur herunter, wenn es glaubt, nativen Code zu kompilieren. Flutter liefert immer native Bibliotheken aus (die Engine und Ihr AOT-kompiliertes Dart), braucht also dieses Strippen und bringt AGP deshalb dazu, die Toolchain zu holen. Geprüft an einer lokalen Installation von Flutter 3.44.2 stable, ruft `FlutterPlugin.kt` das in Zeile 228 bedingungslos auf:

```kotlin
// Flutter 3.44.2, packages/flutter_tools/gradle/src/main/kotlin/FlutterPluginUtils.kt
internal fun forceNdkDownload(gradleProject: Project, flutterSdkRootPath: String) {
    val gradleProjectAndroidExtension = getLegacyAndroidExtension(gradleProject)
    val forcingNotRequired: Boolean =
        gradleProjectAndroidExtension.externalNativeBuild.cmake.path != null
    if (forcingNotRequired) {
        return
    }

    // Otherwise, point to an empty CMakeLists.txt, and ignore associated warnings.
    gradleProjectAndroidExtension.externalNativeBuild.cmake.path(
        "$flutterSdkRootPath/packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt"
    )
    // ...
}
```

Die `CMakeLists.txt`, auf die verwiesen wird, ist eine leere Datei, deren einziger Zweck darin besteht, AGP glauben zu machen, es gäbe nativen Code zu kompilieren. Der NDK-Download ist also nicht optional, nicht überspringbar, und jede frische Maschine und jeder frische CI-Runner trifft darauf. Ein Download von dreiviertel Gigabyte, der einmal pro Umgebung läuft, ist genau das Profil, das abgeschnittene Archive erzeugt.

Die geladene Version kommt von Flutter, nicht von Ihnen. Dieselbe Installation, `packages/flutter_tools/lib/src/android/gradle_utils.dart` Zeile 68:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/android/gradle_utils.dart
const ndkVersion = '28.2.13676358';
```

Das ist NDK r28c. Ich habe die installierte Kopie auf dieser Maschine geprüft, und `ndk/28.2.13676358/source.properties` enthält `Pkg.ReleaseName = r28c`, die Zuordnung von Revision zu Release ist also nicht geraten.

## Warum besteht das Archiv die GZIP-Prüfung nicht?

Sortiert danach, wie oft die jeweilige Ursache tatsächlich zutrifft.

**Ein beschädigtes Archiv im Cache unter `.downloadIntermediates`.** Der SDK Manager legt einen Paketdownload in `<sdk>/.downloadIntermediates` ab, bevor er ihn entpackt. Wenn die Verbindung abbrach, die Platte volllief oder der Prozess mittendrin beendet wurde, bleibt eine abgeschnittene Datei in diesem Verzeichnis liegen. Der Downloader behandelt die Datei im Cache als fortsetzbaren Download und reicht sie beim nächsten Versuch direkt an den Entpacker weiter, ein erneuter Versuch reproduziert also dieselbe Exception auf Dauer. Das ist bei der großen Mehrheit der Meldungen die Ursache, und deshalb ist "ich habe es schon fünfmal versucht" kein Gegenbeweis.

**Ein Proxy oder ein TLS-inspizierender Virenscanner, der die Antwort umschreibt.** `GZIPInputStream` wirft genau diese Zeichenfolge, wenn die ersten beiden Bytes nicht die Gzip-Magic-Number `1f 8b` sind. Ein Unternehmens-Proxy, der mit einer HTML-Sperrseite antwortet, ein Captive Portal, das die Anfrage abfängt, oder ein Scanner, der `Content-Encoding: gzip` auf einen Body setzt, den er gar nicht komprimiert hat, erzeugen jeweils einen Stream, der die Magic-Number-Prüfung schon beim ersten Byte nicht besteht. Das Erkennungsmerkmal: Ein geleerter Cache hilft nicht, Sie bekommen einen frischen, ebenso ungültigen Download.

**Eine volle Festplatte.** Ein Download von 750 MB plus eine Entpackung von 4 GB braucht Reserve, die der SDK Manager vorher nicht prüft. Er schreibt, was er kann, und das abgeschnittene Ergebnis scheitert auf dieselbe Weise.

## Wie leere ich den Download-Cache und das halb entpackte NDK?

Schließen Sie zuerst Android Studio, da es unter Windows Handles auf diese Verzeichnisse hält. Das SDK-Wurzelverzeichnis ist `%LOCALAPPDATA%\Android\Sdk` unter Windows, `~/Library/Android/sdk` unter macOS und `~/Android/Sdk` unter Linux.

```bash
# macOS / Linux. Adjust SDK for your platform.
SDK="$HOME/Library/Android/sdk"
rm -rf "$SDK/.downloadIntermediates" "$SDK/.temp" "$SDK/temp" "$SDK/downloadIntermediates"
rm -rf "$SDK/ndk/28.2.13676358"
```

```powershell
# Windows PowerShell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
Remove-Item -Recurse -Force "$sdk\.downloadIntermediates","$sdk\.temp","$sdk\temp","$sdk\downloadIntermediates" -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force "$sdk\ndk\28.2.13676358" -ErrorAction SilentlyContinue
```

Beide Schreibweisen, mit und ohne führenden Punkt, kommen je nach Android-Studio-Version vor. Entfernen Sie also, was existiert, und ignorieren Sie den Rest. In der Installation, die ich für diesen Artikel untersucht habe, liefert das SDK `.temp` mit führendem Punkt.

Das Löschen des Verzeichnisses `ndk/<version>` ist genauso wichtig wie das Leeren des Caches, und es ist der Schritt, den die meisten Anleitungen auslassen. Warum, steht im nächsten Abschnitt.

## Was tun, wenn der nächste Build stattdessen mit CXX1101 fehlschlägt?

Das passiert, weil das gescheiterte Entpacken ein unvollständiges Verzeichnis hinterlassen hat und jetzt ein anderer Codepfad darauf stößt.

```
> [CXX1101] NDK at /Users/you/Library/Android/sdk/ndk/28.2.13676358
  did not have a source.properties file
```

AGP löst ein installiertes NDK auf, indem es `source.properties` in `ndk/<revision>/` liest. Der SDK Manager schreibt diese Datei zuletzt, nachdem das Archiv vollständig entpackt ist, gerade damit eine halbfertige Installation nicht für eine gute gehalten wird. Wenn das Entpacken am Gzip-Fehler stirbt, bleibt ein Verzeichnis voller Toolchain-Dateien ohne `source.properties` zurück, also weder abwesend noch gültig.

Ab da sieht der SDK Manager ein Verzeichnis am erwarteten Pfad und lädt nicht erneut, während AGP kein `source.properties` sieht und die Verwendung verweigert. Der Build steckt zwischen zwei Komponenten fest, die sich uneinig sind, ob das Paket existiert, und die Fehlermeldung wechselt zu etwas, das völlig unzusammenhängend wirkt. Deshalb enden viele Threads dazu damit, dass Leute `ndk.dir` in `local.properties` setzen oder eine ältere NDK-Version festlegen: Sie umgehen den zweiten Fehler, ohne den ersten je beseitigt zu haben. Löschen Sie das Verzeichnis, und beide verschwinden gemeinsam.

Zur Orientierung: Eine korrekt installierte Kopie enthält beide Dateien:

```
ndk/28.2.13676358/source.properties   # Pkg.Revision = 28.2.13676358, Pkg.ReleaseName = r28c
ndk/28.2.13676358/package.xml         # written by the SDK Manager, not present in the standalone zip
```

## Wie installiere ich das NDK über die Kommandozeile?

Gradle und Android Studio aus dem Spiel zu nehmen macht den Fehlschlag deutlich lesbarer, und `sdkmanager` gibt den zugrunde liegenden Stack Trace statt einer einzeiligen Warnung aus. Die Binärdatei liegt in `<sdk>/cmdline-tools/latest/bin`. Fehlt sie dort, ist [die Installation der Android SDK Command-line Tools](/de/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/) die Voraussetzung.

```bash
# Android SDK Command-line Tools 19.0, NDK r28c
cd "$HOME/Library/Android/sdk/cmdline-tools/latest/bin"
./sdkmanager --install "ndk;28.2.13676358" --verbose
```

Hinter einem Proxy geben Sie diesen explizit an, statt sich auf die Einstellungen von Studio zu verlassen, die `sdkmanager` nicht liest:

```bash
./sdkmanager --install "ndk;28.2.13676358" \
  --proxy=http --proxy_host=proxy.corp.example --proxy_port=8080
```

Greifen Sie nicht zu `--no_https` als Lösung. Es stuft die Übertragung auf einfaches HTTP herab, was einen abfangenden Proxy eher dazu bringt, den Body zu verfälschen, nicht weniger. Die Option existiert für Umgebungen, die CONNECT vollständig blockieren.

## Wie installiere ich das NDK von Hand, wenn der Downloader weiter fehlschlägt?

Das ist der verlässliche Notausgang in einem abgeschotteten Netzwerk, weil er den Download in ein Werkzeug verlagert, das Sie kontrollieren, und Sie die Bytes prüfen lässt.

1. Laden Sie das eigenständige Archiv von `https://dl.google.com/android/repository/android-ndk-r28c-linux.zip`, unter Windows mit `windows` statt `linux`. macOS liefert unter dieser URL ein `.dmg` statt eines ZIP, hängen Sie es also ein und kopieren Sie den Inhalt heraus.

2. Prüfen Sie den SHA-1 gegen den auf der NDK-Downloadseite veröffentlichten Wert, bevor Sie dem Archiv vertrauen. Für r28c ist das Linux-ZIP 722.261.334 Bytes groß mit SHA-1 `a7b54a5de87fecd125a17d54f73c446199e72a64`, das Windows-ZIP 748.118.221 Bytes mit SHA-1 `086bba43ff2f5eb0e387b15c8278bb4e0d89ba1d`. Stimmt der Hash nicht, ist Ihr Proxy als Verursacher bestätigt und kein Leeren des Caches hilft.

```bash
# Verify, then unpack. NDK r28c.
sha1sum android-ndk-r28c-linux.zip
unzip -q android-ndk-r28c-linux.zip
```

3. Benennen Sie das entpackte Verzeichnis `android-ndk-r28c` in die Revisionsnummer um und verschieben Sie es in das SDK. AGP sucht nach der Revision, nicht nach dem Release-Namen:

```bash
mv android-ndk-r28c "$HOME/Android/Sdk/ndk/28.2.13676358"
cat "$HOME/Android/Sdk/ndk/28.2.13676358/source.properties"
# Pkg.Revision = 28.2.13676358
```

4. Kompilieren. AGP liest `source.properties` und akzeptiert die Toolchain. Der einzige Unterschied zu einer verwalteten Installation ist die fehlende `package.xml`, `sdkmanager --list_installed` meldet das Paket also nicht. Für den Build ist das kosmetisch, es zählt aber, wenn Ihre CI die Paketliste statt des Verzeichnisses prüft.

## Welche NDK-Version braucht mein Projekt wirklich?

Die, die Ihr Projekt festlegt, und standardmäßig legt Flutter sie für Sie fest. Stand August 2026:

| Rolle | NDK-Release | Revisionszeichenfolge |
| --- | --- | --- |
| Standard in Flutter 3.44 | r28c | `28.2.13676358` |
| Neueste stabile Version | r29 | `29.0.14206865` |
| Neueste LTS-Version | r27d | `27.3.13750724` |

"Reparieren" Sie diesen Fehler nicht, indem Sie auf ein NDK zurückgehen, das zufällig auf Ihrer Maschine im Cache liegt. NDK r28 ist das erste Release, das Shared Libraries für 16-KB-Speicherseiten ausgerichtet baut, was Google Play inzwischen verlangt. Ein Rückschritt auf r27, um einem Downloadproblem auszuweichen, tauscht einen Build-Fehler gegen [eine Ablehnung im Store](/de/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

Manchmal müssen Sie die Version tatsächlich anheben, nämlich wenn ein Plugin eine neuere Toolchain als den Flutter-Standard braucht. Flutter erkennt das und sagt Ihnen genau, was zu schreiben ist:

```
Your project is configured with Android NDK 28.2.13676358, but the following
plugin(s) depend on a different Android NDK version:
- some_plugin requires Android NDK 29.0.14206865
Fix this issue by using the highest Android NDK version (they are backward compatible).
```

```kotlin
// android/app/build.gradle.kts, AGP 8.x
android {
    ndkVersion = "29.0.14206865"
}
```

Diese Zeichenfolge zu ändern startet einen frischen Download eines anderen Pakets. Wenn Sie also weiterhin in einem Netzwerk sind, das große Übertragungen beschädigt, installieren Sie die neue Revision von Hand, bevor Sie die Festlegung ändern. Sonst wandert derselbe Fehler nur zu einer neuen Versionsnummer.

## Stolperfallen, die dieselbe Meldung aus anderem Grund erzeugen

**Docker- und CI-Images mit knappem Layer-Budget.** Ein Build-Container, dem mitten im Entpacken der beschreibbare Platz ausgeht, scheitert genauso wie ein abgeschnittener Download. Prüfen Sie den freien Platz im SDK-Volume, bevor Sie das Netzwerk beschuldigen. Das NDK ins Image vorzubacken ist die dauerhafte Lösung und entfernt einen 750-MB-Download aus jedem Job.

**Zwei Builds im Wettlauf um ein SDK.** Parallele CI-Jobs, die sich ein eingehängtes SDK-Verzeichnis teilen, verschränken Schreibvorgänge in `.downloadIntermediates` und beschädigen gegenseitig ihre Archive. Geben Sie jedem Job sein eigenes `ANDROID_SDK_ROOT`, oder serialisieren Sie die Erstinstallation.

**`Failed to install the following Android SDK packages as some licences have not been accepted`.** Anderer Fehler, dieselbe Build-Phase. Der wird mit `sdkmanager --licenses` behoben, nicht durch das Leeren von Caches.

**Ein generisches `Gradle task assembleDebug failed with exit code 1`.** Diese Zeile ist eine Hülle, und die Gzip-Warnung kann weit darüber stehen. Wenn Sie die eigentliche Ursache nicht sehen, [führen Sie den Build zuerst ausführlich aus](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/), statt zu raten.

**Ein `.gz`-Fehlschlag im eigenen Downloadschritt eines Plugins.** Manche Plugins holen ihre eigenen vorkompilierten Binärdateien zur Konfigurationszeit. Wenn der Name des fehlschlagenden Pakets nicht `NDK (Side by side)` lautet, ist dieser Artikel die falsche Seite.

## Verwandte Beiträge

Wenn der Build schon vor dem NDK-Download angeschlagen war, sind [AndroidX-Konflikte während eines Flutter-Android-Builds](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/) und [minSdkVersion-Konflikte durch Plugins](/de/2026/05/fix-flutter-background-fetch-requires-minsdkversion-21/) die beiden Probleme, die am häufigsten unter einem Erstlauf-Fehlschlag auf einer neuen Maschine liegen. Für Teams, in denen jeder Runner diesen Download einmal bezahlt, behandelt [mehrere Flutter-Versionen aus einer CI-Pipeline anzusprechen](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/), wie sich das SDK richtig zwischenspeichern lässt, sodass es einmal pro Image statt einmal pro Job passiert.

## Quellen

- [NDK Downloads](https://developer.android.com/ndk/downloads), für die Revisionszeichenfolgen von r29, r28c und r27d, die Archivgrößen und die oben zitierten SHA-1-Prüfsummen.
- [sdkmanager-Kommandozeilenreferenz](https://developer.android.com/studio/command-line/sdkmanager), für `--install`, `--sdk_root`, `--verbose` und das Trio `--proxy`, `--proxy_host`, `--proxy_port`.
- [NDK does not have Source properties file in my project](https://github.com/flutter/flutter/issues/164085) und [New, default Flutter Projects fail on build with NDK...did not have a source.properties file](https://github.com/flutter/flutter/issues/102831), für den Folgefehler CXX1101 und die Umwege, zu denen Leute statt zum Leeren des Caches greifen.
- [Android NDK version doesn't seem to be right for new projects](https://github.com/flutter/flutter/issues/163945), dazu wie die Standardrevision von Flutter gewählt wird und wann ein Plugin Sie darüber hinaus zwingt.
- Quellcode zitiert aus einer lokalen Installation von Flutter 3.44.2 stable: `packages/flutter_tools/gradle/src/main/kotlin/FlutterPlugin.kt`, `FlutterPluginUtils.kt`, `FlutterExtension.kt`, `packages/flutter_tools/gradle/src/main/scripts/CMakeLists.txt` und `packages/flutter_tools/lib/src/android/gradle_utils.dart`.
- SDK-Layoutdetails geprüft an einem Android SDK auf dieser Maschine: `ndk/28.2.13676358/source.properties` (`Pkg.ReleaseName = r28c`), `ndk/28.2.13676358/package.xml` und das Cache-Verzeichnis `.temp` mit führendem Punkt.
