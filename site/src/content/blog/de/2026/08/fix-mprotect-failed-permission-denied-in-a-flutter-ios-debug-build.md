---
title: "Fix: mprotect failed: 13 (Permission denied) in einem Flutter-Debug-Build für iOS"
description: "iOS verweigert der Dart VM, Speicherseiten ausführbar zu schalten, deshalb stirbt der JIT beim Start. Für iOS 26 auf Flutter 3.35.0 oder neuer aktualisieren, für iOS 18.4 auf 3.32.0. Kein Entitlement hilft."
pubDate: 2026-08-14
template: error-page
tags:
  - "errors"
  - "flutter"
  - "dart"
  - "ios"
  - "xcode"
lang: "de"
translationOf: "2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build"
translatedBy: "claude"
translationDate: 2026-08-14
---

Aktualisieren Sie Flutter. Dieser Absturz ist iOS, das der Dart VM verweigert, eine beschreibbare Speicherseite in eine ausführbare umzuwandeln, also genau das, was der JIT braucht und worauf der Debug-Modus läuft. Flutter 3.35.0 (Dart 3.9.0, 2025-08-14) ist das erste stabile Release, das auf physischen iOS-26-Geräten damit zurechtkommt; Flutter 3.32.0 (Dart 3.8.0) war das erste, das auf iOS 18.4 durchkam. Es gibt kein Entitlement, keinen Info.plist-Schlüssel und kein Build-Flag, mit dem sich das in einem älteren SDK beheben ließe. Wenn Sie bereits auf 3.35.0 oder neuer sind und der Absturz bleibt, fehlt Ihrem Xcode-Scheme die LLDB Init File, und das ist die zweite Hälfte der Lösung.

## Der Absturz im Wortlaut

Die App stirbt während `Dart_Initialize`, bevor ein einziges Widget gebaut wird:

```
../../../flutter/third_party/dart/runtime/vm/virtual_memory_posix.cc: 428: error: mprotect failed: 13 (Permission denied)
version=3.7.0 (stable) (Wed Feb 5 04:53:58 2025 -0800) on "ios_arm64"
pid=726, thread=259, isolate_group=vm-isolate(0x11ea52800), isolate=vm-isolate(0x11ebe5800)
os=ios, arch=arm64, comp=no, sim=no
  pc 0x0000000110302e84 fp 0x000000016eee4f50 Dart_DumpNativeStackTrace+0x18
  pc 0x000000010feb1428 fp 0x000000016eee4f70 dart::Assert::Fail(char const*, ...) const+0x30
  pc 0x000000010ffac33c fp 0x000000016eee5420 dart::Code::FinalizeCode(...)+0x82c
  pc 0x0000000110039cb0 fp 0x000000016eee5a30 dart::StubCode::Init()+0x320
  pc 0x000000010fefc4f4 fp 0x000000016eee64e0 dart::Dart::DartInit(Dart_InitializeParams const*)+0x2b18
  pc 0x00000001102e9754 fp 0x000000016eee6960 Dart_Initialize+0x60
  pc 0x000000010fe71e24 fp 0x000000016eee6f30 flutter::DartVM::Create(...)+0x1d64
=== Crash occurred when compiling unknown function in unoptimized JIT mode in unknown pass
```

Drei Details identifizieren den Fehler zweifelsfrei. Der Frame ist `dart::StubCode::Init()`, der läuft, bevor Ihr Code überhaupt existiert, also ist nichts an Ihrem Dart schuld. Die `13` ist `EACCES` vom POSIX-`mprotect`. Und die letzte Zeile nennt den JIT-Modus ausdrücklich.

## Warum iOS den mprotect-Aufruf verweigert

Debug-Builds von Flutter betreiben die Dart VM im JIT-Modus. Das ist kein Implementierungsdetail, das sich abschalten ließe: Hot Reload funktioniert, indem neuer Dart-Code im laufenden Prozess zu Maschinencode kompiliert wird, das heißt die VM schreibt Bytes in eine Seite und führt sie anschließend aus.

Apples W^X-Regel besagt, dass eine Seite entweder beschreibbar oder ausführbar sein darf, nie beides gleichzeitig. Der klassische Weg darum herum ist, eine Seite als RW zu allozieren, den kompilierten Code hineinzuschreiben und dann `mprotect(PROT_READ | PROT_EXEC)` aufzurufen. Genau das tat die Dart VM in `VirtualMemory::Protect` in `runtime/vm/virtual_memory_posix.cc`.

Ab den iOS-18.4-Betas und in iOS 26 noch einmal verschärft erlaubt der Kernel diesen Übergang für Drittanbieter-Apps nicht mehr, auch nicht mit dem Entitlement `get-task-allow`, das ein Entwicklungs-Build mitbringt. `mprotect` liefert `EACCES`, das `ASSERT` der VM schlägt an, und der Prozess bricht ab. Das ist der gesamte Inhalt von [flutter/flutter#163984](https://github.com/flutter/flutter/issues/163984), einem P1, das von Februar bis Juli 2025 offen war und 61 Kommentare sammelte.

Zwei Konsequenzen, die man verinnerlicht haben sollte, bevor man anfängt, Dinge zu ändern:

**Release- und Profile-Builds sind nicht betroffen.** Sie sind AOT-kompiliert. Der Maschinencode liegt bereits im App-Binary, der Loader mappt ihn ausführbar, und die VM verlangt nie eine Schutzänderung. Wenn Ihre CI grün ist und Ihr TestFlight-Build startet, ist das erwartbar und kein Beleg dafür, dass Ihr Setup in Ordnung ist.

**Der Simulator ist nicht betroffen.** Er läuft auf dem macOS-Kernel, der die Einschränkung nicht durchsetzt. In einem Team, in dem eine Person im Simulator und eine andere auf dem Gerät testet, teilt sich das sauber in der Mitte, und genau das macht die erste Stunde der Fehlersuche so verwirrend.

## Welche Flutter-Version brauche ich wirklich?

Die Lösung kam in zwei Teilen, in zwei verschiedenen stabilen Releases. Die Commit-Abstammung habe ich über die GitHub-Compare-API gegen die Release-Tags des Dart-SDK geprüft, statt dem Issue-Thread zu vertrauen.

| Ziel | Erstes funktionierendes Stable | Dart | Veröffentlicht |
| --- | --- | --- | --- |
| Physisches Gerät mit iOS 18.4 | Flutter 3.32.0 | 3.8.0 | 2025-05-20 |
| Physisches Gerät mit iOS 26 | Flutter 3.35.0 | 3.9.0 | 2025-08-14 |
| iOS 26, Tool steuert LLDB selbst | Flutter 3.38.0 | 3.10.0 | 2025-11-12 |

Der erste Teil ist der Hook `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` in der VM, hinzugefügt im Dart-Commit `939699a9` am 2025-02-28. Er ist ein Vorfahr des Tags `3.8.0`, also hat ihn alles ab Flutter 3.32.0.

Der zweite Teil ist das doppelte Mapping der Code-Seiten, drei Commits aus Juni 2025 (`d194fcec`, `dc0567c0`, `c111f693`). Die sind Vorfahren von `3.9.0`, aber nicht von `3.8.1`, und deshalb stürzt 3.32.x auf iOS 26 ab, 3.35.0 dagegen nicht. Statt den Schutz eines Mappings umzuschalten, mappt die VM denselben physischen Speicher nun zweimal: eine RW-Sicht, durch die der Compiler schreibt, und eine getrennte RX-Sicht, aus der die CPU ausführt. Kein `mprotect`-Aufruf, nichts, was der Kernel verweigern könnte.

Die praktische Anweisung ist damit eine Zeile:

```bash
# Latest stable at time of writing is 3.47.0 (Dart 3.13.0, 2026-08-12)
flutter upgrade
flutter clean
```

Das `flutter clean` ist kein Aberglaube. Das Flutter-Tool schreibt generierte LLDB-Dateien nach `ios/Flutter/ephemeral/`, und veraltete Kopien aus einem früheren SDK verursachten Fehlzündungen, die während des Rollouts der Lösung wiederholt im Issue gemeldet wurden.

## Ich bin auf Flutter 3.35 oder neuer und es stürzt weiterhin ab

Dann ist die VM in Ordnung und die Debugger-Seite nicht. Doppeltes Mapping ist notwendig, aber nicht hinreichend: Das RX-Mapping wird erst gültig, wenn der Debugger die Seiten berührt, also muss LLDB Teil des Starts sein. Flutter verdrahtet das über das Xcode-Scheme, und fehlt dort die Einstellung, bekommen Sie denselben `mprotect`-Absturz zurück.

Das Tool versucht bei jedem Debug- oder Profile-Build, das Scheme für Sie zu migrieren. Wenn das nicht gelingt, gibt es Folgendes aus:

```
Running Flutter in debug mode on new iOS versions requires a LLDB Init File,
but the Runner scheme does not have it set. To ensure debug mode works, please
complete the following:
  * Open Xcode > Product > Scheme > Edit Scheme and for the Run and Test actions,
    set LLDB Init File to:

  $(SRCROOT)/Flutter/ephemeral/flutter_lldbinit
```

Tun Sie genau das, und beachten Sie, dass sowohl die Run- als auch die Test-Aktion gemeint ist. Die Migration prüft beide unabhängig voneinander und beschwert sich über die jeweils fehlende. Wenn Sie bereits eine eigene LLDB Init File haben, überschreibt Flutter sie nicht, sondern verlangt, dass Sie seine Datei aus Ihrer heraus einbinden:

```
command source /path/to/ios/Flutter/ephemeral/flutter_lldbinit
```

In einem Add-to-App-Projekt ist der Pfad ein anderer, weil das Flutter-Modul als Swift-Paket gebaut wird und die generierten Dateien in der Paketausgabe landen. Setzen Sie die LLDB Init File des Schemes auf `$(FLUTTER_SWIFT_PACKAGE_OUTPUT)/Scripts/flutter_lldbinit`, oder binden Sie sie relativ zu Ihrer eigenen Datei ein:

```
command source --relative-to-command-file "../my_flutter_app/build/ios/SwiftPackages/Scripts/flutter_lldbinit"
```

Add-to-App-Hosts bekommen hier eine Warnung statt eines Fehlers, weil das Tool nicht wissen kann, welches Ihrer Schemes das gestartete ist. Es durchsucht jede `.xcscheme` im Projekt nach der Zeichenkette `customLLDBInitFile` und warnt nur, wenn keine sie enthält. Ein Projekt mit fünf Schemes, bei dem das falsche konfiguriert ist, besteht diese Prüfung und stürzt trotzdem ab.

## Wie funktioniert JIT überhaupt noch, wenn mprotect blockiert ist?

Das lohnt sich zu verstehen, weil es die Einschränkung im nächsten Abschnitt erklärt.

Die generierte `ios/Flutter/ephemeral/flutter_lldb_helper.py` setzt einen Haltepunkt auf ein Symbol, das die VM einzig als Signal an den Debugger exportiert, und schreibt dann von der Debugger-Seite aus in die Seiten, was erlaubt ist, weil ein Debugger den ausführbaren Speicher eines debuggten Prozesses ändern darf:

```python
# Generated by Flutter 3.44.2 into ios/Flutter/ephemeral/flutter_lldb_helper.py
import lldb

def handle_new_rx_page(frame: lldb.SBFrame, bp_loc, extra_args, intern_dict):
    """Intercept NOTIFY_DEBUGGER_ABOUT_RX_PAGES and touch the pages."""
    base = frame.register["x0"].GetValueAsAddress()
    page_len = frame.register["x1"].GetValueAsUnsigned()

    data = bytearray(page_len)
    data[0:8] = b'IHELPED!'

    error = lldb.SBError()
    frame.GetThread().GetProcess().WriteMemory(base, data, error)
    if not error.Success():
        print(f'Failed to write into {base}[+{page_len}]', error)
        return

def __lldb_init_module(debugger: lldb.SBDebugger, _):
    target = debugger.GetDummyTarget()
    bp = target.BreakpointCreateByRegex("^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$")
    bp.SetScriptCallbackFunction('{}.handle_new_rx_page'.format(__name__))
    bp.SetAutoContinue(True)
    print("-- LLDB integration loaded --")
```

Die Markierung `IHELPED!` ist eine Diagnose: `NOTIFY_DEBUGGER_ABOUT_RX_PAGES` liest die ersten acht Bytes zurück und kann so unterscheiden zwischen "der Debugger hat das erledigt" und "es wurde nie ein Haltepunkt gesetzt", und das ist der Unterschied zwischen einem funktionierenden Setup und dem Absturz vom Anfang dieses Artikels.

Wenn Sie `-- LLDB integration loaded --` in der Xcode-Konsole sehen, ist die Init File korrekt verdrahtet.

## Was hat sich ab Flutter 3.38 geändert?

Ab Flutter 3.38.0 delegiert das Tool für physische Geräte nicht mehr an Xcode, sondern steuert `devicectl` und `lldb` selbst (PRs [#173417](https://github.com/flutter/flutter/pull/173417), [#173443](https://github.com/flutter/flutter/pull/173443) und [#173724](https://github.com/flutter/flutter/pull/173724)). `flutter run` startet die App angehalten und schickt LLDB dann diese Sequenz:

```
device select <device-id>
breakpoint set --func-regex '^NOTIFY_DEBUGGER_ABOUT_RX_PAGES$'
breakpoint command add --script-type python <breakpoint-id>
device process attach --pid <app-pid>
process continue
```

Das steckt hinter einem Feature Flag, das in jedem Kanal standardmäßig aktiv ist. Gegen eine lokale Flutter-3.44.2-Installation geprüft, deklariert `packages/flutter_tools/lib/src/features.dart`:

```dart
// Flutter 3.44.2, packages/flutter_tools/lib/src/features.dart
const lldbDebugging = Feature(
  name: 'support for debugging with LLDB for physical iOS devices',
  configSetting: 'enable-lldb-debugging',
  environmentOverride: 'FLUTTER_LLDB_DEBUGGING',
  master: FeatureChannelSetting(available: true, enabledByDefault: true),
  beta: FeatureChannelSetting(available: true, enabledByDefault: true),
  stable: FeatureChannelSetting(available: true, enabledByDefault: true),
);
```

Vorausgesetzt werden iOS 17 oder neuer und Xcode 26 oder neuer. Unterhalb einer der beiden Schwellen fällt das Tool stillschweigend auf den Start über Xcode zurück, und deshalb kann eine Maschine mit Xcode 16 völlig andere Symptome zeigen als die einer Kollegin oder eines Kollegen mit derselben Flutter-Version. Prüfen Sie `xcodebuild -version`, bevor Sie Beobachtungen vergleichen.

Abschalten lässt es sich global oder pro Projekt, falls es sich schlecht verhält:

```bash
flutter config --no-enable-lldb-debugging
```

```yaml
# pubspec.yaml, disables LLDB debugging for this project only
flutter:
  config:
    enable-lldb-debugging: false
```

## Was tun, wenn ein Flutter-Update nicht möglich ist?

Wer auf ein altes SDK festgelegt ist, und Pins auf 3.7.x waren im Issue-Thread verbreitet, bekommt weder einen Backport noch eine Lösung innerhalb der App. Bleiben der Test im Simulator, der Test auf einem Gerät mit iOS 18.3 oder älter, oder `flutter run --profile`, das AOT-kompiliert und damit immun ist. Der Profile-Modus kostet Hot Reload, behält aber DevTools, die Timeline und den Widget Inspector, taugt also als Zwischenlösung für UI-Arbeit, die nicht stark iterativ ist.

Ein lange festgepinntes SDK über vier stabile Releases hinweg anzuheben, ist ein eigenes Projekt. Wenn Sie mehrere Apps mit unterschiedlichen Pins betreuen, ist es günstiger, das über [mehrere Flutter-Versionen aus einer CI-Pipeline](/de/2026/05/how-to-target-multiple-flutter-versions-from-one-ci-pipeline/) zu staffeln, als alles auf einmal zu aktualisieren.

## Stolperfallen, die wie dieser Bug aussehen, aber keiner sind

**Ein Debug-Build braucht jetzt einen dauerhaft angehängten Debugger.** Erst der Debugserver auf dem Gerät macht den JIT legal, also stürzt ein vom Homescreen gestarteter Debug-Build ohne angehängten Debugger genauso ab. Das ist keine zu meldende Regression, sondern der Mechanismus. Verwenden Sie einen Profile- oder Release-Build für alles, was Sie an Testende weitergeben.

**Kabelloses Debuggen unter iOS 26 ist langsam, nicht kaputt.** Flutter 3.44 gibt aus: "Wireless debugging on iOS 26 may be slower than expected. For better performance, consider using a wired (USB) connection." Jede RX-Seitenübergabe ist ein Roundtrip zum Debugger, und über WLAN summiert sich das. Mehrere Meldungen über Zehn-Sekunden-Hänger im ursprünglichen Issue waren genau das. Stecken Sie das Kabel ein, bevor Sie einen Bug melden.

**Release-Builds in der CI, die sich über `customLLDBInitFile` beschweren.** Die Scheme-Migration läuft nur für Debug- und Profile-Builds, aber ein falsch konfiguriertes Scheme kann trotzdem in Release-Pipelines auffallen. Scheitert Ihre CI bei einem Release-Build an der Init File, liegt das Problem am Scheme, nicht an diesem Absturz: Ein Release-Build hat keinen JIT und braucht kein LLDB.

**Flavors haben eigene Schemes.** Flutter migriert das Scheme, das sich für den gerade gebauten Flavor ergibt. Wenn Sie `dev`, `staging` und `prod` haben und lokal nur `dev` starten, bleiben die anderen beiden unmigriert, bis jemand sie baut, und jedes fällt genau einmal um.

**Alles, was unter Android `mprotect` erwähnt, ist ein anderes Problem.** Android-Build-Fehler rund um Speicherseiten sind fast immer die 16-KB-Seitengrößen-Anforderung, also eine Frage von Packaging und Alignment, nicht von JIT. Dafür gibt es [eine eigene Lösung mit NDK r28 und zipalign](/de/2026/08/fix-google-play-rejects-flutter-or-maui-app-for-16-kb-page-size/).

## Verwandt

Wenn die App gar nicht erst startet, liegt der Fehler vor der VM: [Failed to build iOS app mit Xcode 16 und Flutter 3.x](/de/2026/05/fix-failed-to-build-ios-app-with-xcode-16-and-flutter-3-x/) und [CocoaPods findet keine kompatiblen Versionen für einen Pod](/de/2026/07/fix-cocoapods-could-not-find-compatible-versions-for-pod-in-a-flutter-ios-build/) decken die beiden Fehler ab, die den größten Teil des Rests ausmachen. Da dieser Absturz nur auf echter Hardware auftritt, lohnt sich auch ein [Workflow mit echtem Gerät, um Flutter iOS von Windows aus zu debuggen](/de/2026/01/debugging-flutter-ios-from-windows-a-real-device-workflow-flutter-3-x/), damit ein Mac keine Voraussetzung zum Reproduzieren ist. Und wenn das Update auf 3.35 oder neuer viel anderes mitreißt, ist die [Null-Safety-Checkliste für Flutter 3.x](/de/2026/06/migrate-a-flutter-2-app-to-flutter-3-x-null-safety-checklist/) die Reihenfolge, die ich bei alten Codebasen verwende.

## Quellen

- [Debug mode and hot reload fail on iOS 26 due to JIT restriction `error: mprotect failed: 13 (Permission denied)`](https://github.com/flutter/flutter/issues/163984), das P1-Tracking-Issue, für den ursprünglichen Crash-Dump und den zeitlichen Ablauf der Lösung.
- [Add lldb init file](https://github.com/flutter/flutter/pull/164344) (flutter/flutter#164344, gemergt am 2025-03-06), ausgeliefert in den [Release Notes zu Flutter 3.32.0](https://docs.flutter.dev/release/release-notes/release-notes-3.32.0).
- [Release Notes zu Flutter 3.38.0](https://docs.flutter.dev/release/release-notes/release-notes-3.38.0), für LLDB und `devicectl` als Standard-Startpfad unter iOS 17+ mit Xcode 26+.
- [Integrate a Flutter app into your iOS project](https://docs.flutter.dev/add-to-app/ios/project-setup), für die Add-to-App-Pfade der LLDB Init File.
- Dart-SDK-Commits `939699a9` (`[vm] Add NOTIFY_DEBUGGER_ABOUT_RX_PAGES hook`), `d194fcec` (`[vm] Use dual mapping of code pages on certain OS versions`), `dc0567c0` und `c111f693`, mit Tag-Abstammung geprüft gegen die Release-Tags `3.8.1` und `3.9.0`.
- Code zitiert aus einer lokalen Installation von Flutter 3.44.2 stable: `packages/flutter_tools/lib/src/features.dart`, `lib/src/ios/lldb.dart`, `lib/src/xcode_project.dart`, `lib/src/migrations/lldb_init_migration.dart` und `lib/src/build_system/targets/ios.dart`.
