---
title: "Was ist das W^X-Flag in .NET und braucht Native AOT es?"
description: "W^X (write xor execute) ist die Regel, dass keine Speicherseite gleichzeitig beschreibbar und ausführbar ist. In .NET ist das der Schalter DOTNET_EnableWriteXorExecute, seit .NET 7 standardmäßig aktiv, und er existiert ausschließlich für den JIT. Native AOT liest ihn nie. Hier steht, wie die Laufzeit ihn umsetzt, was er kostet und wann das Abschalten eine legitime Lösung ist."
pubDate: 2026-09-04
tags:
  - "dotnet"
  - "native-aot"
  - "jit"
  - "performance"
  - "security"
  - "dotnet-11"
lang: "de"
translationOf: "2026/09/what-is-the-w-xor-x-flag-in-dotnet-and-does-native-aot-need-it"
translatedBy: "claude"
translationDate: 2026-09-04
---

W^X ("write xor execute") ist eine Speicherschutzrichtlinie: Jede Speicherseite darf beschreibbar oder ausführbar sein, niemals beides zugleich. In .NET wird sie als Schalter `DOTNET_EnableWriteXorExecute` bereitgestellt, und ihr Standardwert ist seit .NET 7 `1`. Die Annahme, die in der üblichen Formulierung dieser Frage steckt, ist verkehrt herum, also korrigieren wir sie gleich zu Beginn: Native AOT braucht das W^X-Flag nicht und liest es auch nicht. Das Flag konfiguriert den Allokator für ausführbaren Speicher in CoreCLR, der für den JIT existiert. Native AOT hat weder JIT noch einen solchen Allokator. Die tatsächliche Beziehung verläuft in die andere Richtung: Plattformen, die W^X ausnahmslos erzwingen (iOS, tvOS), machen JIT-Kompilierung unmöglich, und Native AOT ist die Antwort auf diese Einschränkung, kein Konsument des Flags.

Alles Folgende zielt auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET 11 SDK, aber die Mechanik ist seit .NET 7 stabil. Wo ein Verhalten von einer bestimmten Version abhängt, sage ich es.

## Warum eine gleichzeitig beschreibbare und ausführbare Seite ein Problem ist

Der klassische Speicherkorruptions-Exploit hat zwei Hälften: angreiferkontrollierte Bytes in den Prozess bekommen und dann die CPU dazu bringen, dorthin zu springen. Wenn jede Seite im Prozess entweder beschreibbar oder ausführbar ist, funktioniert die zweite Hälfte nicht mehr. Die geschriebenen Bytes liegen auf einer Seite, deren Ausführung die CPU verweigert, und die Seiten, die die CPU ausführt, sind Seiten, die Sie nicht beschreiben können. Die Richtlinie kam 2003 aus OpenBSD und ist heute Grundausstattung: Windows nennt seine Variante DEP, Linux stützt sich auf das NX-Bit plus die Seitenrechte des Laders, und Apple silicon erzwingt sie auf Kernel-Ebene für jeden Prozess.

Für gewöhnlichen kompilierten Code ist das kostenlos. Der Lader bildet Ihren `.text`-Abschnitt als Lesen-Ausführen und Ihren `.data`-Abschnitt als Lesen-Schreiben ab, und nichts muss sich je ändern. Der unangenehme Fall ist eine Laufzeit, die Maschinencode erzeugt, während das Programm läuft.

## Warum der JIT der unangenehme Fall ist

Ein JIT-Compiler schreibt Maschinencode-Bytes in den Speicher und ruft sie dann auf. Die naive Umsetzung allokiert eine RWX-Seite, schreibt und springt. Genau diese Form soll W^X verhindern, und sie liefert einem Angreifer eine Seite, die garantiert beschreibbar und ausführbar ist, an einer halbwegs stabilen Adresse.

Die naheliegende Lösung ist, die Seite als Lesen-Schreiben zu allokieren, den Code zu emittieren und sie dann per `mprotect` auf Lesen-Ausführen zu setzen. Das reicht CoreCLR aus zwei Gründen nicht. Erstens gibt es ein Zeitfenster, in dem die Seite beschreibbar und ihre Adresse bereits bekannt ist. Zweitens, und wichtiger: Die Laufzeit schreibt den Code nicht nur einmal. Sie patcht ihn fortlaufend: Call-Counting-Stubs werden neu geschrieben, wenn eine Methode die Tiering-Schwelle überschreitet, [Tiered Compilation](/de/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/) tauscht Tier-0-Code gegen Tier-1-Code, und Virtual-Stub-Dispatch-Zellen werden nachgepatcht, sobald sich monomorphe Aufrufstellen auflösen. Eine Seite bei jedem Patch zwischen RW und RX umzuschalten ist langsam und über Threads hinweg anfällig für Race Conditions.

## Wie CoreCLR es tatsächlich umsetzt: Double Mapping

Die Antwort von CoreCLR ist, zwei virtuelle Abbildungen desselben physischen Speichers zu erzeugen. Eine Abbildung ist Lesen-Ausführen und ist das, was die CPU ausführt. Die andere ist Lesen-Schreiben und ist das, wodurch die Laufzeit schreibt. Keine einzelne virtuelle Adresse ist jemals beides, die Richtlinie hält also, aber die Laufzeit kann Code weiterhin patchen, ohne ein Seitenrecht zu ändern.

Die Mechanik dahinter sind `ExecutableAllocator` und der RAII-Helfer `ExecutableWriterHolder` in `src/coreclr/inc/executableallocator.h`. Jede Stelle in der VM, die Code ändern will, nimmt einen Writer Holder, schreibt über `holder.GetRW()` und lässt den Destruktor die beschreibbare Sicht wieder abbauen. Der zugrunde liegende Speicher wird in `src/coreclr/minipal/Unix/doublemapping.cpp` angelegt, was unter Linux so aussieht:

```c
// dotnet/runtime, src/coreclr/minipal/Unix/doublemapping.cpp
int fd = memfd_create("doublemapper", MFD_CLOEXEC);
```

Unter FreeBSD kommt `shm_open(SHM_ANON, ...)` zum Einsatz, und auf anderen Unix-Systemen fällt es auf ein POSIX-Shared-Memory-Objekt namens `/shm-dotnet-<pid>` zurück, das sofort per `shm_unlink` entfernt wird. Dieses memfd ist das Stück, das Sie von außerhalb des Prozesses tatsächlich beobachten können:

```bash
# Linux, .NET 11. Count the double mappings in a running .NET process.
grep -c doublemapper /proc/$(pgrep -n MyApp)/maps
```

Apple-Plattformen gehen einen anderen Weg. `CreateDoubleMemoryMapper` kehrt auf Apple früh zurück, ganz ohne Dateideskriptor, denn macOS auf arm64 bietet stattdessen einen Mechanismus pro Thread: Seiten, die mit `MAP_JIT` allokiert wurden, lassen sich über `pthread_jit_write_protect_np` nur für den aufrufenden Thread zwischen beschreibbar und ausführbar umschalten. Die Laufzeit kapselt das als `PAL_JitWriteProtect`, und unter `HOST_APPLE && HOST_ARM64` gibt der Writer Holder schlicht dieselbe Adresse zurück statt einer zweiten Abbildung:

```cpp
// dotnet/runtime, executableallocator.h, Apple arm64 path
m_addressRW = addressRX;
PAL_JitWriteProtect(true);
```

Dieser Geltungsbereich pro Thread wird oft übersehen: Auf Apple silicon gehört das Schreibrecht einem Thread, nicht der Seite. Deshalb dürfen Sie nie einen Thread eine Region beschreiben lassen, während ein anderer sie ausführt.

## Das Flag und wie Sie es setzen

Der Schalter wird genau einmal deklariert, in `src/coreclr/inc/clrconfigvalues.h`:

```cpp
// dotnet/runtime, src/coreclr/inc/clrconfigvalues.h
RETAIL_CONFIG_DWORD_INFO(EXTERNAL_EnableWriteXorExecute, W("EnableWriteXorExecute"), 1,
                         "Enable W^X for executable memory.");
```

Standard `1` auf jeder Architektur außer `TARGET_RISCV64`, wo dieselbe Deklaration einen Standard von `0` ausliefert. Zum Standard wurde er in [PR #69672](https://github.com/dotnet/runtime/pull/69672), gemergt im Mai 2022 für .NET 7. Davor lieferte .NET 6 ihn nur für macOS arm64 standardmäßig aktiv aus (wo das Betriebssystem Ihnen keine Wahl lässt) und überall sonst als Opt-in, genau wie es die [.NET 6 Ankündigung](https://devblogs.microsoft.com/dotnet/announcing-net-6/) versprochen hatte.

Es gibt zwei Wege, ihn zu setzen. Die Umgebungsvariable funktioniert überall:

```bash
# Disables W^X for this process only. .NET 7 and later.
DOTNET_EnableWriteXorExecute=0 ./MyApp
```

Ab .NET 9 können Sie ihn dank [PR #101490](https://github.com/dotnet/runtime/pull/101490) auch in `runtimeconfig.json` hinterlegen:

```json
{
  "configProperties": {
    "System.Runtime.EnableWriteXorExecute": 0
  }
}
```

In einem Projekt im SDK-Stil drücken Sie das als MSBuild-Item aus, damit es eine Neukompilierung übersteht:

```xml
<!-- .NET 9 and later. Ignored by .NET 8 and earlier, which need the env var. -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="System.Runtime.EnableWriteXorExecute" Value="0" />
</ItemGroup>
```

Der Weg über runtimeconfig wurde nie nach .NET 8 zurückportiert; die Anfrage in [Issue #103340](https://github.com/dotnet/runtime/issues/103340) wurde als nicht geplant geschlossen. Unter .NET 8 ist die Umgebungsvariable Ihre einzige Option. Und beachten Sie die Änderung der Rangfolge in .NET 9: Umgebungsvariablen gewinnen jetzt gegen `runtimeconfig.json`, ein verirrtes `DOTNET_EnableWriteXorExecute` in einem Container-Image überschreibt Ihre Projekteinstellung also stillschweigend.

## Was es kostet

Diese Absicherung ist nicht kostenlos, und das Laufzeit-Team hat sie gemessen, bevor sie standardmäßig aktiv wurde. Die Zahlen aus [PR #69672](https://github.com/dotnet/runtime/pull/69672) über die ASP.NET-Benchmarks plaintext, json, fortunes und orchard auf x64 Windows, x64 Linux und arm64 Linux waren eine Startzeit-Regression von 5 bis 10 Prozent, wobei die Folgeanalyse die Zeit bis zur ersten Anfrage rund 10 Prozent schlechter einordnete. Im eingeschwungenen Zustand zeigte sich kein messbarer Unterschied, was Sinn ergibt: Sobald die heißen Methoden kompiliert und gepatcht sind, liegt der Allokator für ausführbaren Speicher auf keinem relevanten Pfad mehr.

Die erste ausgelieferte Fassung war bei JIT-lastigen Lasten schlechter als das. [PR #74526](https://github.com/dotnet/runtime/pull/74526) verfolgte eine Regression in den Regex-Tests, die sich auf das Kompilieren von rund 50.000 Methoden zurückführen ließ, von denen jede eine frische beschreibbare Abbildung allokierte und wieder freigab. Die zuletzt genutzte beschreibbare Abbildung zu cachen statt sie sofort abzubauen, behob das vollständig und wurde in .NET 7 zusammen mit der Standardumstellung ausgeliefert. Wenn Sie Startzeiten auf .NET 7 oder neuer messen, haben Sie diese Korrektur bereits.

Praktisch gelesen: W^X kostet Sie Startzeit, nicht Durchsatz. Das zählt bei kurzlebigen Prozessen und Cold Starts und deutlich weniger bei einem langlaufenden Server. Es ist dieselbe Achse, entlang derer [Native AOT gegen ReadyToRun gegen reines JIT](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) abwägt.

## Wo Native AOT tatsächlich steht

Nun der Teil, den die Frage verdreht. Native AOT veröffentlicht eine Binärdatei, deren Code vollständig zur Kompilierzeit erzeugt und vom Betriebssystemlader als Lesen-Ausführen abgebildet wird, genau wie bei einem C-Programm. Es gibt keinen JIT, kein Tiering, kein Nachpatchen von Stubs und damit auch keinen `ExecutableAllocator`. Durchsuchen Sie die Native-AOT-Laufzeit unter `src/coreclr/nativeaot/Runtime` und Sie werden `EnableWriteXorExecute` nirgends finden. Das Flag gegen eine Native-AOT-Binärdatei zu setzen bewirkt gar nichts: Der Schalter ist ein Konfigurationswert der CoreCLR-VM, und die Native-AOT-Laufzeit ist eine andere, viel kleinere Laufzeit, die CLR-Konfiguration nie liest.

Das Fehlen von Codeerzeugung zur Laufzeit können Sie aus verwaltetem Code bestätigen:

```csharp
// .NET 11, C# 14. Prints False under Native AOT, True under CoreCLR.
using System.Runtime.CompilerServices;

Console.WriteLine(RuntimeFeature.IsDynamicCodeCompiled);
```

Das ist nicht ganz dasselbe wie die Aussage, Native AOT allokiere zur Laufzeit keinen ausführbaren Speicher. Es allokiert etwas davon, aus einem bestimmten Grund: gemarshallte Delegates. Wenn Sie ein verwaltetes Instanz-Delegate als Funktionszeiger an nativen Code übergeben, muss die Zieladresse kodieren, welche Delegate-Instanz aufzurufen ist, und das lässt sich nicht in das Image einbacken, weil die Instanz zur Kompilierzeit nicht existiert. Die Laufzeit erzeugt dafür einen kleinen Thunk pro Delegate:

```csharp
// .NET 11, C# 14. This is the call that forces a runtime-allocated thunk.
using System.Runtime.InteropServices;

Action<int> callback = Console.WriteLine;
nint fnPtr = Marshal.GetFunctionPointerForDelegate(callback);
// fnPtr points at a thunk allocated from a thunk pool, not at compiled image code.
GC.KeepAlive(callback);
```

Diese Thunks stammen aus `PalAllocateThunksFromTemplate`, dessen Signatur in `src/coreclr/nativeaot/Runtime/unix/PalUnix.cpp` lautet:

```cpp
UInt32_BOOL PalAllocateThunksFromTemplate(HANDLE hTemplateModule, uint32_t templateRva,
                                          size_t templateSize, void** newThunksOut);
```

Der Entwurf, in [PR #82317](https://github.com/dotnet/runtime/pull/82317) für iOS-artige Plattformen hinzugefügt, erzeugt nie eine RWX-Seite. Auf Apple-Zielen reserviert er zwei benachbarte Bereiche mit `vm_allocate` und bildet dann mit `vm_remap` und `VM_FLAGS_FIXED | VM_FLAGS_OVERWRITE` die bereits kompilierte Template-Codeseite aus dem geladenen Image in die ausführbare Hälfte ab, während die beschreibbare Hälfte nur die *Daten* pro Thunk enthält (die Zieladresse und das Delegate-Handle). Der Code wird zur Laufzeit nie geschrieben, sondern nur referenziert. Das ist W^X-Konformität durch Konstruktion statt durch Richtlinie, und genau deshalb funktioniert es auf einer Plattform, die keine Hintertür anbietet.

`PalVirtualAlloc` in derselben Datei übergibt beim Allokieren von ausführbarem Speicher auf macOS arm64 sehr wohl `MAP_JIT`, da der Kernel das dort verlangt.

## In welche Richtung die Kausalität wirklich läuft

Apple lässt eine Drittanbieter-App aus dem App Store weder RWX-Speicher abbilden noch eine Seite nach dem Beschreiben auf ausführbar umschalten. Es gibt kein Entitlement, das daran für ausgelieferte Apps etwas ändert. Diese eine Einschränkung eliminiert JIT-Kompilierung und mit ihr den JIT-Modus von Mono, das Tiering von CoreCLR und Hot Reload von kompiliertem Code. Es ist dieselbe Wand, gegen die Flutter läuft, weshalb ein [Flutter-Debug-Build für iOS mit mprotect Permission denied fehlschlägt](/de/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/), während Release-Builds, die vollständig AOT-kompiliert sind, unberührt bleiben.

Die richtige Einordnung lautet also: iOS erzwingt W^X, W^X verbietet JIT, und Native AOT ist der Weg, auf dem .NET Code an eine Plattform ausliefert, die JIT verbietet. Native AOT unterstützt iOS-artige Plattformen seit .NET 9 und ist der Standard-Kompiliermodus für .NET MAUI Release-Builds auf iOS und Mac Catalyst. Nichts an dieser Kette betrifft das Flag `EnableWriteXorExecute`, das immer nur geregelt hat, wie der JIT von CoreCLR seine Bytes in den Speicher bekommt, auf Plattformen, die ihn sonst hätten schlampig sein lassen.

## Wann das Abschalten eine legitime Lösung ist

W^X ist eine Defense-in-Depth-Maßnahme. Sie abzuschalten senkt die Sicherheitslage Ihres Prozesses real, behandeln Sie `DOTNET_EnableWriteXorExecute=0` also zuerst als Diagnosewerkzeug und nur mit Begründung als dauerhafte Einstellung. Diese Gründe tragen:

**JIT-kompilierte Frames mit Linux `perf` profilieren.** Die Laufzeit schreibt ihre perf-Map mit der Adresse der RW-Abbildung, nicht der RX-Abbildung, die die CPU tatsächlich ausführt, also lösen JIT-Frames auf falsche Symbole oder auf gar nichts auf. Das ist seit Juli 2022 als [Issue #71786](https://github.com/dotnet/runtime/issues/71786) offen und steckt weiterhin im Meilenstein Future. Wenn Sie ein brauchbares `perf`-Profil von JIT-kompiliertem Code brauchen, schalten Sie W^X für diesen Lauf ab. Für die tägliche Profilierung nehmen Sie besser [dotnet-trace, das seine eigenen Rundown-Ereignisse liest](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) und nicht betroffen ist.

**Wachsende `/memfd:doublemapper (deleted)`-Einträge.** [Issue #89776](https://github.com/dotnet/runtime/issues/89776) meldet, dass sich diese Abbildungen unter Linux ansammeln (unter macOS werden sie freigegeben, unter Linux nicht), was sich in einem langlaufenden Dienst als steigende Abbildungszahl und wachsender virtueller Speicher zeigt. Auf ARM32 wurde derselbe Mechanismus in [Issue #121455](https://github.com/dotnet/runtime/issues/121455) als regelrechtes Speicherleck mit OOM-Kills gemeldet. Wenn Ihr `/proc/<pid>/maps` voller `doublemapper` ist, sehen Sie genau das.

**`SIGXFSZ` unter einem Dateigrößen-rlimit.** Das memfd ist für den Kernel eine Datei, ein `ulimit -f` unterhalb der vom Mapper angeforderten Größe beendet den Prozess also mit `SIGXFSZ`. Das war [Issue #117819](https://github.com/dotnet/runtime/issues/117819).

**Native Debugger, die Haltepunkte setzen.** Ein `int3` über die RX- statt die RW-Abbildung zu schreiben führte zu Zugriffsverletzungen, verfolgt in [Issue #107444](https://github.com/dotnet/runtime/issues/107444). Wenn Sie `lldb` oder `gdb` an einen .NET-Prozess hängen und Fehler beim Setzen von Haltepunkten sehen, schalten Sie W^X für diese Debugging-Sitzung ab.

**Rosetta.** Hier müssen Sie nichts tun. Double Mapping hat unter Rosetta-Emulation nie korrekt funktioniert ([Issue #70910](https://github.com/dotnet/runtime/issues/70910)), und die Laufzeit erkennt Rosetta und schaltet W^X für Sie ab.

Was nicht auf dieser Liste steht, ist "meine App startet langsam". Wenn Cold Start Ihr Problem ist, bringt Ihnen das Flag 5 bis 10 Prozent, während eine richtige Lösung, ReadyToRun oder [Native AOT mit seiner eigenen Kostenrechnung](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/), weit mehr bringt und den Prozess nicht schwächt. Greifen Sie zum Flag, wenn Sie eines der konkreten Symptome oben haben, und schreiben Sie einen Kommentar daneben, welches.

## Verwandt

- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs JIT in .NET 11: Was sollten Sie ausliefern?](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Was ist Tiered Compilation und wie denke ich darüber nach?](/de/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)
- [So profilen Sie eine .NET-App mit dotnet-trace und lesen die Ausgabe](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [Fix: mprotect failed: 13 (Permission denied) in einem Flutter-Debug-Build für iOS](/de/2026/08/fix-mprotect-failed-permission-denied-in-a-flutter-ios-debug-build/)

## Quellen

- [W^X support, dotnet/runtime PR #54954](https://github.com/dotnet/runtime/pull/54954)
- [Enable W^X by default, dotnet/runtime PR #69672](https://github.com/dotnet/runtime/pull/69672)
- [Enable caching of writeable W^X mappings, dotnet/runtime PR #74526](https://github.com/dotnet/runtime/pull/74526)
- [Read EnableWriteXorExecute from runtimeConfig, dotnet/runtime PR #101490](https://github.com/dotnet/runtime/pull/101490)
- [NativeAOT thunk page generation and mapping for iOS-like platforms, PR #82317](https://github.com/dotnet/runtime/pull/82317)
- [clrconfigvalues.h, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/coreclr/inc/clrconfigvalues.h)
- [doublemapping.cpp, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/coreclr/minipal/Unix/doublemapping.cpp)
- [Announcing .NET 6, .NET Blog](https://devblogs.microsoft.com/dotnet/announcing-net-6/)
- [.NET Runtime config options, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/)
- [Native AOT support for iOS-like platforms, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/ios-like-platforms/)
- [pthread_jit_write_protect_np(3), Apple](https://keith.github.io/xcode-man-pages/pthread_jit_write_protect_np.3.html)
