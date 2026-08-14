---
title: "Fix: Google Play lehnt eine Flutter- oder .NET-MAUI-App wegen fehlender Unterstützung für 16-KB-Speicherseiten ab"
description: "Play lehnt das Bundle ab, weil eine 64-Bit-.so noch 4-KB-ELF-Segmente hat. Finden Sie die Bibliothek, bauen Sie sie mit NDK r28+ neu und prüfen Sie mit zipalign -P 16."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "maui"
  - "dotnet"
  - "dotnet-10"
  - "android"
  - "gradle"
lang: "de"
translationOf: "2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size"
translatedBy: "claude"
translationDate: 2026-08-14
---

Die Ablehnung liegt so gut wie nie am eigenen Code. Google Play scannt die 64-Bit-Bibliotheken im App Bundle und blockiert das Release, sobald eine davon ELF-`LOAD`-Segmente mit 4 KB (`0x1000`) statt 16 KB (`0x4000`) Ausrichtung hat. Sowohl die Flutter-Engine als auch die .NET-Android-Runtime liefern seit geraumer Zeit 16-KB-ausgerichtete Binaries aus, der Verursacher ist also fast immer ein Drittanbieter-Plugin oder eine Binding-Bibliothek, die mit einem alten NDK kompiliert wurde. Finden, aktualisieren oder neu bauen, danach mit `zipalign -c -P 16 -v 4` bestätigen.

## Der Fehler im Kontext

Beim Hochladen des Bundles in die Play Console erscheint eine Meldung, die das Release blockiert:

```
Your app's native libraries are not aligned to 16 KB.
Recompile your app with 16 KB native library alignment.

lib/arm64-v8a/libsomething.so
lib/arm64-v8a/libsomething_jni.so
```

Der aktuelle Wortlaut in Googles eigener Dokumentation ist bei Umfang und Datum eindeutig:

> Alle Apps, die auf Android 15 (API-Level 35) und höher abzielen, müssen auf 64-Bit-Geräten bei Google Play 16-KB-Speicherseiten unterstützen. Ab dem 2027-02-01 können Sie App-Updates, die keine 16-KB-Speicherseiten unterstützen, nicht mehr veröffentlichen.

Die Vorgeschichte ist relevant, weil viele kursierende Ratschläge veraltete Termine nennen: Die Anforderung galt ursprünglich ab dem 2025-11-01 für neue Apps und Updates mit Android 15+ als Ziel, eine Verlängerung bis zum 2026-05-31 war beantragbar, und die harte Sperre für nicht konforme Updates liegt laut dem [Android-Leitfaden zu Seitengrößen](https://developer.android.com/guide/practices/page-sizes) inzwischen beim 2027-02-01.

## Warum scheitert eine 4-KB-ausgerichtete Bibliothek auf einem 16-KB-Gerät?

Android ist historisch von einer 4-KB-Speicherseite ausgegangen. Geräte mit Android 15 und höher können stattdessen eine 16-KB-Seite verwenden, was den Druck auf die Page Table senkt und den App-Start messbar beschleunigt. Der dynamische Linker mappt jedes `PT_LOAD`-Segment einer Shared Library an eine seitenausgerichtete Adresse. Ist das `p_align` des Segments 4096, die Seitengröße des Kernels aber 16384, kann der Loader die Segmentgrenzen nicht einhalten und `dlopen` schlägt fehl. Der Nutzer sieht einen Installationsfehler oder einen Start, der sofort in `System.loadLibrary` stirbt.

Tatsächlich gibt es zwei getrennte Ausrichtungsanforderungen, und deren Vermischung ist die größte Fehlerquelle:

- **ELF-Segmentausrichtung.** Jedes `PT_LOAD`-Segment in jeder `.so` benötigt ein `p_align` von mindestens 16384. Das ist eine Eigenschaft davon, wie die Bibliothek kompiliert und gelinkt wurde.
- **Zip-Eintragsausrichtung.** Werden native Bibliotheken unkomprimiert im APK abgelegt (`extractNativeLibs="false"`, der Standard in modernen Builds), mappt der Linker sie direkt aus dem APK. Die Zip-Einträge selbst müssen daher an einer 16-KB-Grenze beginnen. Das ist eine Eigenschaft davon, wie das Paket zusammengesetzt wurde.

Eine Bibliothek kann die eine Prüfung bestehen und die andere nicht. Play prüft beide, und ausschließlich für 64-Bit-ABIs.

## Welche Flutter- und .NET-MAUI-Versionen sind bereits konform?

Beide Toolchains sind seit einer Weile in Ordnung, weshalb die problematische Datei üblicherweise aus einer Abhängigkeit stammt.

**Flutter.** Ein Blick in das lokale Flutter-3.44.2-Stable-SDK (Framework-Revision `c9a6c48`, Engine `77e2e94`) zeigt in `packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt`, auf welches NDK `flutter.ndkVersion` auflöst:

```kotlin
// Flutter 3.44.2 stable, FlutterExtension.kt
val ndkVersion: String = "28.2.13676358"
```

Das ist NDK r28, das standardmäßig 16-KB-ausgerichtete Segmente erzeugt. Der `DependencyVersionChecker.kt` desselben SDK bricht unterhalb von AGP 8.6.0 hart ab und warnt unterhalb von AGP 8.11.1, während `gradle_utils.dart` neue Projekte mit AGP 9.0.1 und Gradle 9.1.0 anlegt. All das liegt deutlich über dem von Google genannten Minimum AGP 8.5.1 für korrekte Ausrichtung unkomprimierter Bibliotheken. Eine Flutter-3.44-App ist konstruktionsbedingt konform, sofern kein Plugin eine veraltete `.so` einschleppt.

**.NET MAUI.** Das .NET-Android-SDK setzt die Paketausrichtung explizit. Aus `Microsoft.Android.Sdk.DefaultProperties.targets` in `Microsoft.Android.Sdk.Windows` 36.1.53, der Version aus der .NET-10-Workload:

```xml
<!-- Microsoft.Android.Sdk 36.1.53 (.NET 10) -->
<AndroidZipAlignment Condition=" '$(AndroidZipAlignment)' == '' ">16</AndroidZipAlignment>
```

Der umgebende Kommentar hält fest, dass nur die Werte `4` und `16` unterstützt werden. Die Zip-Hälfte der Anforderung ist damit standardmäßig erledigt, und Sie sollten diese Property nie selbst setzen müssen. Enthält ein übernommenes Projekt ein festes `<AndroidZipAlignment>4</AndroidZipAlignment>`, löschen Sie die Zeile.

Für die ELF-Hälfte habe ich eine Ausrichtungsprüfung über die nativen Bibliotheken der .NET-10-Android-Runtime-Packs auf diesem Rechner laufen lassen (`Microsoft.Android.Runtime.*.36.1.53` und `Microsoft.NETCore.App.Runtime.Mono.android-arm64`). Jede 64-Bit-Runtime-Bibliothek meldet ein `p_align` von `0x4000`: `libmonosgen-2.0.so`, `libmono-android.release.so`, `libnet-android.release.so`, `libSystem.Native.so`, `libSystem.Security.Cryptography.Native.Android.so`, `libxamarin-native-tracing.so` sowie die Mono-Komponentenbibliotheken. Sowohl die Mono- als auch die CoreCLR-Variante sind sauber.

## Wie prüfe ich ein APK oder AAB auf 16-KB-Ausrichtung?

Googles `check_elf_alignment.sh` ist ein Bash-Skript, was unter Windows unpraktisch ist. Die Prüfung auf Zip-Ebene liegt den Android-Build-Tools bei und funktioniert überall:

```powershell
# Windows, Android build-tools 35.0.0 or newer
& "$env:LOCALAPPDATA\Android\sdk\build-tools\35.0.0\zipalign.exe" -c -P 16 -v 4 app-release.apk
```

Bei einem App Bundle meldet `bundletool` die konfigurierte Ausrichtung:

```bash
bundletool dump config --bundle=app-release.aab
```

Beide inspizieren allerdings keine ELF-Header. Für die Segmente selbst liefert das NDK `llvm-objdump` mit:

```bash
# ANDROID_NDK points at an r28 or newer installation
$ANDROID_NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-objdump -p libfoo.so | grep LOAD
```

Eine konforme Bibliothek gibt `align 2**14` aus. Alles bei `2**12` oder `2**13` fällt durch.

Wer keine NDK-Installation voraussetzen möchte: Die Program Header lassen sich direkt parsen. Das ist das Skript, mit dem ich oben die .NET-Runtime-Packs geprüft habe, und es läuft überall dort, wo Python läuft:

```python
# check_align.py - Python 3.9+, no dependencies
import glob, os, struct, sys

PT_LOAD = 1

def load_aligns(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:4] != b"\x7fELF":
        return None
    is64 = data[4] == 2
    if is64:
        e_phoff = struct.unpack_from("<Q", data, 0x20)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x36)[0]
        e_phnum = struct.unpack_from("<H", data, 0x38)[0]
    else:
        e_phoff = struct.unpack_from("<I", data, 0x1C)[0]
        e_phentsize = struct.unpack_from("<H", data, 0x2A)[0]
        e_phnum = struct.unpack_from("<H", data, 0x2C)[0]
    aligns = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if struct.unpack_from("<I", data, off)[0] != PT_LOAD:
            continue
        fmt, delta = ("<Q", 0x30) if is64 else ("<I", 0x1C)
        aligns.append(struct.unpack_from(fmt, data, off + delta)[0])
    return is64, aligns

for pattern in sys.argv[1:]:
    for path in sorted(glob.glob(pattern, recursive=True)):
        result = load_aligns(path)
        if result is None:
            continue
        is64, aligns = result
        if not is64:
            continue  # Play only checks 64-bit ABIs
        worst = min(aligns) if aligns else 0
        status = "ALIGNED  " if worst >= 16384 else "UNALIGNED"
        print(f"{status} p_align={hex(worst)} {os.path.basename(path)}")
```

Entpacken Sie das AAB oder APK und richten Sie das Skript auf das Verzeichnis der 64-Bit-ABI:

```bash
unzip -q app-release.aab -d extracted
python check_align.py "extracted/**/lib/arm64-v8a/*.so"
```

Die als `UNALIGNED` ausgegebenen Bibliotheken sind exakt jene, die Play auflisten wird.

## Wie repariere ich eine nicht ausgerichtete Flutter-App?

Zuerst gilt es herauszufinden, welches Plugin die Datei mitbringt. Durchsuchen Sie den Pub-Cache und das gebaute APK und ordnen Sie die `.so` einem Paket zu:

```bash
flutter build apk --release
unzip -l build/app/outputs/flutter-apk/app-release.apk | grep "lib/arm64-v8a"
```

Sobald der Verursacher feststeht, arbeiten Sie diese Reihenfolge ab:

1. **Plugin aktualisieren.** Mit Abstand die häufigste Lösung. Die meisten gepflegten Pakete haben ihre Binaries im Lauf des Jahres 2025 neu gebaut. `flutter pub outdated` ausführen, die betroffene Abhängigkeit anheben, neu bauen, erneut prüfen.
2. **Flutter-SDK und Android-Toolchain aktualisieren.** Stellen Sie sicher, dass Sie auf Flutter 3.32 oder neuer sind, AGP 8.5.1 oder neuer in `settings.gradle.kts` verwenden und `android { ndkVersion = flutter.ndkVersion }` statt einer fest verdrahteten alten NDK-Zeichenkette. Ein explizites, veraltetes `ndkVersion = "25.1.8937393"` in `android/app/build.gradle.kts` hebelt still und leise alles andere aus.
3. **Nativen Code selbst neu bauen**, falls das Plugin aus dem Quellcode gebaut wird und auf NDK r27 oder älter festhängt. Ergänzen Sie die Linker-Optionen in dessen `CMakeLists.txt`:

   ```cmake
   target_link_options(${CMAKE_PROJECT_NAME} PRIVATE
       "-Wl,-z,max-page-size=16384"
       "-Wl,-z,common-page-size=16384")
   ```

4. **Abhängigkeit entfernen**, wenn sie aufgegeben wurde. Ein ungepflegtes Paket mit vorkompilierter 4-KB-`.so` und ohne Quellcode ist ein harter Blocker, den kein Build-Flag auf Ihrer Seite behebt. Forken oder ersetzen.

## Wie repariere ich eine nicht ausgerichtete .NET-MAUI-App?

Die .NET-10-Runtime ist bereits konform, prüfen Sie also Ihre NuGet-Pakete, insbesondere Android-Binding-Bibliotheken mit eingebetteter vorkompilierter `.aar` oder `.so`. Werbe-, Analytics-, Payment-SDKs und ML-Runtimes sind die üblichen Verdächtigen.

```bash
# .NET 10, MAUI
dotnet publish -f net10.0-android -c Release
```

Entpacken Sie anschließend die entstandene `.aab` aus `bin/Release/net10.0-android/publish/` und lassen Sie den Prüfer gegen `base/lib/arm64-v8a/` laufen. Ist eine Binding-Bibliothek der Verursacher, besteht die Lösung darin, das NuGet-Paket auf eine Version zu heben, deren zugrunde liegende `.aar` mit NDK r28 neu gebaut wurde. Existiert keine solche Version, bleibt nur, die `.aar` mit neu gebauter nativer Bibliothek selbst neu zu paketieren oder die Abhängigkeit zu streichen.

Zwei Dinge auf Projektebene lohnen sich bei der Gelegenheit. Prüfen Sie, dass unkomprimierte native Bibliotheken nicht deaktiviert wurden, denn der gesamte Zip-Ausrichtungsmechanismus hängt daran, und dass Sie nicht weiterhin ein älteres SDK anvisieren, was das Problem lokal verdeckt, bei Play aber nicht. Beides sind keine häufigen Fehlkonfigurationen, führen aber zu verwirrenden Ergebnissen, wenn sie vorliegen.

## Was ist mit libc.so und den 32-Bit-Bibliotheken, die mein Prüfer meldet?

Zwei False Positives, die viel Zeit kosten, wenn das falsche Verzeichnis geprüft wird. Beide tauchten beim Scan der .NET-10-Runtime-Packs sofort auf.

**Stub-Bibliotheken werden nicht ausgeliefert.** Die Android-Runtime-Packs enthalten `libc.so`, `libdl.so`, `liblog.so`, `libm.so` und `libz.so` mit `p_align = 0x1000`. Das sind DSO-Stubs für den Linkvorgang; die echten Implementierungen kommen vom Gerät. Sie landen nie im APK, ihre Ausrichtung ist daher irrelevant. Genau deshalb muss das gebaute Paket geprüft werden und nicht ein `obj/`-Ordner oder ein NuGet-Cache.

**32-Bit-Bibliotheken sind ausgenommen.** Jede Bibliothek im Runtime-Pack `android-arm` (armeabi-v7a) meldet `0x1000`, und das ist korrekt und dauerhaft so: Ein 32-Bit-Prozess hat keinen 16-KB-Seitenmodus zu unterstützen. Play prüft nur 64-Bit-ABIs, und die Build-Zeit-Prüfung des .NET-Android-SDK tut dasselbe, deren Diagnosetext lautet `Not a 64-bit ELF image.  Ignored.` Beschränken Sie den Scan auf `arm64-v8a` und `x86_64`, genau wie das Skript oben.

Wer den Fix durchgängig belegen statt dem Scan vertrauen möchte, legt ein AVD aus dem System-Image "Google APIs Experimental 16 KB Page Size" im SDK Manager an und bestätigt vor der Installation, dass der Emulator tatsächlich 16-KB-Seiten verwendet:

```bash
adb shell getconf PAGE_SIZE
```

Das muss `16384` ausgeben. Eine App, die dort installiert und startet, besteht die Play-Prüfung.

## Verwandte Beiträge

Wenn der Build gar nicht erst zu einem Bundle kommt, liegt der eigentliche Fehler meist an anderer Stelle in der Gradle-Kette: [Gradle-Task assembleDebug scheitert mit Exit-Code 1](/de/2026/07/fix-gradle-task-assembledebug-failed-with-exit-code-1-in-flutter/) und [Gradle build failed to produce an .apk file unter MAUI Android](/de/2026/05/fix-gradle-build-failed-to-produce-an-apk-file-in-maui-android/) zeigen, wie man den echten Fehler aus einem verpackten Log herausliest. Ein fehlendes NDK oder SDK-Paket erscheint als [flutter doctor meldet fehlende cmdline-tools-Komponente](/de/2026/08/fix-flutter-doctor-cmdline-tools-component-is-missing/), und native Konflikte auf Abhängigkeitsebene zeigen sich oft zuerst als [AndroidX-Konflikt während eines Flutter-Android-Builds](/de/2026/05/fix-androidx-conflict-during-flutter-android-build/). Teams auf dem alten Stack treffen all das gleichzeitig beim [Wechsel von Xamarin.Forms zu MAUI 11](/de/2026/05/migrate-from-xamarin-forms-to-maui-11/).

## Quellen

- [Support 16 KB page sizes](https://developer.android.com/guide/practices/page-sizes) (Android Developers), für die Anforderung, das Datum 2027-02-01, die Prüfungen mit `zipalign` und `llvm-objdump` sowie die Linker-Flags für NDK r27 und älter.
- [Prepare your apps for Google Play's 16 KB page size compatibility requirement](https://android-developers.googleblog.com/2025/05/prepare-play-apps-for-devices-with-16kb-page-size.html) (Android Developers Blog), für die ursprüngliche Ankündigung vom 2025-11-01.
- [Preparing your .NET MAUI apps for Google Play's 16 KB page size requirement](https://devblogs.microsoft.com/dotnet/maui-google-play-16-kb-page-size-support/) (.NET Blog), für die .NET-seitige Anleitung und die berichteten Verbesserungen bei Start und Stromverbrauch.
- Versions- und Ausrichtungsangaben lokal gemessen gegen Flutter 3.44.2 stable und die .NET-10-Android-Workload (`Microsoft.Android.Sdk.Windows` und `Microsoft.Android.Runtime.*` 36.1.53).
