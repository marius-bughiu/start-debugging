---
title: "Was ist Tiered Compilation und wie denke ich darüber nach?"
description: "Tiered Compilation ermöglicht es dem .NET-JIT, jede Methode zweimal zu kompilieren: zuerst schnell und unoptimiert, damit Ihre Anwendung startet, und dann erneut mit vollständigen Optimierungen, sobald die Laufzeit weiß, dass eine Methode heiß ist. Hier erfahren Sie, wie Tier 0, Tier 1, On-Stack-Replacement und Dynamic PGO zusammenpassen und wie Sie sie beobachten und einstellen."
pubDate: 2026-07-11
tags:
  - "dotnet"
  - "performance"
  - "jit"
  - "dotnet-11"
  - "csharp"
lang: "de"
translationOf: "2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it"
translatedBy: "claude"
translationDate: 2026-07-11
---

Tiered Compilation ist die Strategie der .NET-Laufzeit, jede Methode mehr als einmal zu kompilieren. Wenn eine Methode zum ersten Mal ausgeführt wird, erzeugt der JIT-Compiler (Just-in-Time) schnell und fast ohne Optimierung "Tier-0"-Code, damit Ihre Anwendung schnell startet. Erweist sich diese Methode später als heiß (mindestens 30-mal aufgerufen oder in einer langen Schleife rotierend), rekompiliert ein Hintergrund-Thread sie als vollständig optimierten "Tier-1"-Code und tauscht sie unauffällig aus. Sie erhalten Startgeschwindigkeit und Durchsatz im Dauerbetrieb aus demselben Binary, ohne zwischen beiden wählen zu müssen. Seit .NET Core 3.0 ist die Funktion standardmäßig aktiviert, und ab .NET 8 speist sie zusätzlich einen Profiler (Dynamic PGO), der den Tier-1-Code intelligenter macht, als ein statischer Compiler es könnte. Dieser Beitrag erklärt die beweglichen Teile und wie Sie beim Profiling oder Benchmarking darüber nachdenken.

Alles hier zielt auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET-11-SDK (`11.0.100`), aber die Mechanik ist seit .NET 7 stabil, als On-Stack-Replacement und das schnelle Jitting von Schleifen auf x64 und arm64 zum Standard wurden. Wenn ein Verhalten von einer bestimmten Version abhängt, weise ich darauf hin.

## Warum die Laufzeit dieselbe Methode zweimal kompiliert

Ein JIT-Compiler steht jedes Mal vor einem Dilemma, wenn er eine Methode zum ersten Mal sieht. Er kann diese Methode langsam kompilieren und exzellenten Maschinencode erzeugen, was für eine Methode, die eine Million Mal läuft, großartig ist, aber verschwenderisch für eine Methode, die während des Starts nur einmal läuft. Oder er kann schnell kompilieren und mittelmäßigen Code erzeugen, was für den Start großartig ist, aber auf den heißen Pfaden Durchsatz liegen lässt.

Ahead-of-Time-Compiler umgehen dies, indem sie alles im Voraus optimieren, und bezahlen dafür mit Build-Zeit und größeren Binaries. Ein reiner JIT, der immer optimiert, bezahlt dafür mit einem langsamen Start, denn eine echte Anwendung kompiliert Tausende von Methoden per JIT, bevor sie ihre erste Anfrage bedient. Tiered Compilation weigert sich zu wählen. Sie kompiliert zuerst schnell, damit der Prozess in Gang kommt, beobachtet dann, welche Methoden wirklich wichtig sind, und rekompiliert nur diese mit dem teuren Optimierer. Die überwältigende Mehrheit der Methoden in jedem Prozess läuft eine Handvoll Mal und verdient sich nie Tier 1, sodass das Budget des Optimierers dorthin geht, wo es sich auszahlt.

## Tier 0 und Tier 1: Was "schnell" und "optimiert" wirklich bedeuten

Tier 0 wird vom "Quick JIT" erzeugt. Der Compiler überspringt die meisten Optimierungen: kein aggressives Inlining, kein Loop-Unrolling, minimale Registerzuweisung. Er gibt geradlinigen Maschinencode in einem Bruchteil der Zeit aus, die eine vollständige Kompilierung benötigen würde. Der resultierende Code ist korrekt und oft mehrmals langsamer als optimierter Code, aber er existiert nahezu sofort.

Tier 1 ist der vollständige Optimierer. Er führt Inlining durch, eliminiert Grenzprüfungen, wo er beweisen kann, dass sie redundant sind, zieht Invarianten aus Schleifen heraus und nutzt (seit .NET 8) Profildaten, die gesammelt wurden, während Tier 0 lief. Die Tier-1-Kompilierung ist viel langsamer zu erzeugen, was genau der Grund ist, warum die Laufzeit sie nur für Methoden aufwendet, die bewiesen haben, dass sie es wert sind.

Es gibt eine dritte Codequelle, die am selben System teilnimmt: ReadyToRun (R2R). Framework-Assemblies werden mit vorkompiliertem R2R-Code ausgeliefert, damit die Laufzeit nicht bei jedem Start `string.Substring` per JIT kompilieren muss. R2R-Code wird als ein vorgebackenes Tier behandelt, das immer noch durch eine noch bessere Tier-1-Version ersetzt werden kann, sobald sich die Methode in Ihrer spezifischen Arbeitslast als heiß erweist. Deshalb kann das Deaktivieren von Tiered Compilation eine Anwendung gelegentlich langsamer statt schneller machen: Sie verlieren die Fähigkeit, Framework-Methoden mit Ihrem Profil neu zu optimieren.

## Der Aufrufzähler-Schwellenwert und die Tiering-Verzögerung

Eine Methode springt nicht in dem Moment auf Tier 1, in dem sie warm wird. Zwei Mechanismen steuern die Beförderung.

Erstens ein Aufrufzähler. Jede Tier-0-Methode hat einen Zähler, und sobald sie 30-mal aufgerufen wurde (der Standardwert von `DOTNET_TC_CallCountThreshold`), wird sie für die Tier-1-Rekompilierung in die Warteschlange gestellt. Dreißig ist bewusst niedrig; der Zweck ist, alles einzufangen, was wiederholt läuft, ohne zu warten, bis es tausende Male in langsamem Code läuft.

Zweitens eine Startverzögerung. Die Laufzeit beginnt nicht sofort, Aufrufe zu zählen, denn während des Starts werden fast alle Methoden zum ersten Mal aufgerufen und keine ist bereits im Dauerbetrieb heiß. Es gibt einen Timer von etwa 100 ms, der jedes Mal zurückgesetzt wird, wenn eine neue Tier-0-Methode per JIT kompiliert wird. Erst wenn dieser Timer ohne neue Tier-0-Kompilierungen abläuft, das heißt, wenn sich der JIT-Sturm des Starts gelegt hat, beginnt das Aufrufzählen ernsthaft. Deshalb bleibt der Start selbst in billigem Tier-0-Code und der Optimierer verausgabt sich nicht an Methoden, die nur während der Initialisierung liefen.

Die Rekompilierung geschieht auf einem Hintergrund-Thread, der aus dem Thread-Pool geliehen wird und jeweils in Scheiben von etwa 10 ms arbeitet, sodass er nie einen Worker monopolisiert. Ihre heiße Methode führt weiterhin ihren Tier-0-Code aus, bis die optimierte Version bereit ist, woraufhin die Laufzeit zukünftige Aufrufe atomar auf den Tier-1-Code umleitet. Nichts blockiert, und kein laufender Aufruf wird unterbrochen.

```csharp
// .NET 11, C# 14.
// Call this in a tight loop and the runtime will promote it to tier 1
// after ~30 calls, once startup has settled. You will not see the
// promotion in the method's behavior, only in its speed.
static long SumOfSquares(int n)
{
    long acc = 0;
    for (int i = 0; i < n; i++)
        acc += (long)i * i;
    return acc;
}
```

## On-Stack-Replacement: einer heißen Schleife entkommen, die nie zurückkehrt

Der Aufrufzähler-Mechanismus hat eine offensichtliche Lücke. Was ist mit einer Methode, die genau einmal aufgerufen wird, dann aber während der gesamten Lebensdauer des Prozesses in einer Schleife rotiert? Denken Sie an `Main` oder an einen Worker, der ewig über eine Warteschlange iteriert. Sein Aufrufzähler steht auf 1, sodass er dauerhaft in langsamem Tier-0-Code feststecken würde.

On-Stack-Replacement (OSR) schließt diese Lücke. Wenn der Quick JIT Tier-0-Code für eine Methode ausgibt, die eine Schleife enthält, fügt er außerdem einen kleinen Zähler an der Rückwärtskante der Schleife ein (dem Sprung zurück zum Anfang). Wird diese Rückwärtskante oft genug ausgeführt, kompiliert die Laufzeit eine optimierte Version der Methode und überträgt die Ausführung mitten im Flug an sie, indem sie den laufenden Stack-Frame an Ort und Stelle ersetzt. Die Schleife, die in Tier 0 begann, endet in Tier 1, ohne dass die Methode je zurückgekehrt ist.

OSR ist es, das es überhaupt erst sicher macht, Methoden mit Schleifen per Quick JIT zu kompilieren. Bevor OSR kam, weigerte sich die Laufzeit, Quick JIT auf irgendeine Methode anzuwenden, die eine Schleife enthielt (der alte Standardwert `false` von `TieredCompilationQuickJitForLoops`), denn eine lange Schleife, die in unoptimiertem Code feststeckte, war ein echter Leistungsabgrund. Der [PR #65675 in dotnet/runtime](https://github.com/dotnet/runtime/pull/65675) aktivierte sowohl `DOTNET_TC_QuickJitForLoops` als auch `DOTNET_TC_OnStackReplacement` standardmäßig für x64 und arm64 in .NET 7, sodass heute fast alle Methoden in Tier 0 beginnen und sich die Laufzeit auf OSR verlässt, um alles zu retten, was in einer langen Schleife feststeckt. Das Ergebnis war eine Startverbesserung von etwa 25 % in JIT-lastigen Anwendungen und eine 10 bis 30 % bessere Zeit bis zur ersten Anfrage in den TechEmpower-Benchmarks, laut dem [Performance-Bericht zu .NET 7](https://devblogs.microsoft.com/dotnet/performance_improvements_in_net_7/).

## Dynamic PGO: Der Tier-0-Durchlauf profiliert ebenfalls

Hier ist der Teil, der die Leute überrascht. In .NET 8 und später ist Dynamic PGO (Profile-guided Optimization) standardmäßig aktiviert, und es ist das, was aus dem gesamten Zwei-Durchgang-Design mehr macht als ein bloßes "zweimal kompilieren".

Wenn Dynamic PGO aktiv ist, ist der Tier-0-Code nicht nur unoptimiert, sondern auch instrumentiert. Er zeichnet billige Fakten darüber auf, wie sich die Methode tatsächlich verhält: welche konkreten Typen an einer virtuellen Aufrufstelle auftauchen, welcher Zweig eines `if` am häufigsten genommen wird, wie oft eine Schleife iteriert. Wird die Methode auf Tier 1 befördert, liest der Optimierer dieses Profil und spezialisiert den Code für das, was zur Laufzeit tatsächlich geschah. Ein virtueller Aufruf, dessen Ziel zu 99 % `List<int>` war, erhält diesen Pfad per Inlining, geschützt durch eine Typprüfung (Guarded Devirtualization). Ein Zweig, der fast nie genommen wird, wird aus dem heißen Pfad herausgezogen.

Das ist eine Optimierung, die ein statischer Compiler nicht durchführen kann, denn sie hängt von Daten ab, die nur existieren, während Ihre spezifische Arbeitslast läuft. Es ist auch der Grund, warum Tiered Compilation plus Dynamic PGO eine von Anfang an vollständig optimierte Konfiguration im echten Durchsatz schlagen kann, nicht nur beim Start. Sie können es zum Vergleich deaktivieren:

```xml
<!-- .NET 11, C# 14. Disables Dynamic PGO. Default is enabled since .NET 8. -->
<PropertyGroup>
  <TieredPGO>false</TieredPGO>
</PropertyGroup>
```

Der Kompromiss besteht darin, dass der instrumentierte Tier-0-Code geringfügig langsamer und geringfügig größer ist als einfacher Tier-0-Code, und das Tier-1-Ergebnis ist besser. Für einen Server, der stundenlang läuft, ist das ein leichter Gewinn. Für eine kurzlebige Funktion, die endet, bevor irgendetwas Tier 1 erreicht, ist die Instrumentierung reine Kosten ohne Nutzen, was einer der Gründe ist, warum kaltstartsensible Arbeitslasten dies manchmal abschalten. Eine ausführlichere Behandlung dieses Szenarios finden Sie im Leitfaden zum [Reduzieren der Kaltstartzeit einer .NET-11-AWS-Lambda](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/).

## Wie Sie das Tiering tatsächlich in Aktion sehen

Über Tiered Compilation nachzudenken, fällt viel leichter, sobald Sie es sehen können. Die Laufzeit gibt für jede JIT-Kompilierung ETW/EventPipe-Ereignisse aus, versehen mit dem Tier, sodass `dotnet-trace` Ihnen die Übergänge zeigen kann:

```bash
# .NET 11 SDK 11.0.100. Capture JIT and tiering events for a running process.
dotnet-trace collect --process-id 1234 \
  --providers Microsoft-Windows-DotNETRuntime:0x1000:5
```

Die Ereignisse `MethodJittingStarted` und `MethodLoadVerbose` tragen ein Feld für die Optimierungsstufe, sodass eine Methode, die zweimal auftaucht, zuerst als Tier 0 und dann als Tier 1, die Beförderung ist, nach der Sie suchen. Eine Anleitung zum Lesen dieser Traces finden Sie im Beitrag über das [Profiling einer .NET-Anwendung mit dotnet-trace](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/).

Wenn Sie den Maschinencode sehen möchten, den der JIT auf jeder Stufe erzeugt hat, gibt `DOTNET_JitDisasmSummary=1` eine Zeile pro Methode mit ihrem Tier aus, und wenn Sie `DOTNET_JitDisasm` auf einen Methodennamen setzen, wird der tatsächliche Assembler-Code ausgegeben. Werkzeuge wie der [Disassembly-Viewer von Rider 2026.1](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) legen dieselbe Ausgabe offen, ohne dass Sie mit Umgebungsvariablen ringen müssen. Das Vergleichen des Tier-0- und Tier-1-Disassemblys derselben Methode ist der schnellste Weg, ein Gespür dafür zu entwickeln, was "optimiert" einbringt.

## Die Messfalle, in die jeder tappt

Der häufigste Fehler bei Tiered Compilation ist, versehentlich Tier-0-Code zu messen. Wenn Sie eine Stoppuhr-Schleife schreiben, die Ihre Methode ein paar tausend Mal ausführt und das Ergebnis mittelt, laufen die frühen Iterationen im langsamen Tier 0, die Beförderung geschieht mittendrin, und Ihr Durchschnitt ist eine bedeutungslose Mischung aus zwei verschiedenen Codestücken.

Die Lösung ist Aufwärmen. Führen Sie die Methode oft genug aus, um die Beförderung auszulösen, warten Sie, bis die Hintergrundkompilierung abgeschlossen ist, und beginnen Sie erst dann mit dem Messen. Genau das erledigt [BenchmarkDotNet](https://benchmarkdotnet.org/) für Sie: Es führt eine Aufwärmphase aus, erkennt, wann sich die Zeiten stabilisieren, und misst Tier-1-Code im Dauerbetrieb. Bauen Sie keinen Mikrobenchmark von Hand mit `Stopwatch` und vertrauen Sie der Zahl nicht; Sie messen mit ziemlicher Sicherheit das falsche Tier. Wenn es sein muss, können Sie die Sache erzwingen, indem Sie `DOTNET_TieredCompilation=0` setzen, sodass alles direkt zu optimiertem Code kompiliert wird, aber das ändert das Startverhalten und ist auch nicht die Art, wie Ihre Anwendung in der Produktion läuft.

## Die Stellschrauben und wann Sie sie tatsächlich anfassen sollten

Die Standardeinstellungen sind gut. Das .NET-Team stimmt sie an einer riesigen Sammlung echter Anwendungen ab, und die ehrliche Antwort für die meisten Projekte lautet, jede Einstellung in Ruhe zu lassen. Dennoch existieren die Hebel aus einem Grund:

- `TieredCompilation` (env `DOTNET_TieredCompilation`, standardmäßig aktiviert): Deaktivieren Sie es nur, um überall vollständig optimierten Code zu erzwingen, auf Kosten eines viel langsameren Starts. Gelegentlich nützlich für einen latenzkritischen Dienst, der sich ein langes Aufwärmen leisten kann und null Tier-0-Jitter will, aber messen Sie, bevor Sie sich festlegen.
- `TieredCompilationQuickJit` (env `DOTNET_TC_QuickJit`, standardmäßig aktiviert): Dies zu deaktivieren lässt Tier 0 den vollständigen Optimierer verwenden, was den Zweck weitgehend zunichtemacht.
- `TieredCompilationQuickJitForLoops` (env `DOTNET_TC_QuickJitForLoops`, standardmäßig aktiviert seit .NET 7 auf x64/arm64): zusammen mit OSR selten eine Änderung wert.
- `TieredPGO` (env `DOTNET_TieredPGO`, standardmäßig aktiviert seit .NET 8): das, was Sie für ultrakurzlebige Prozesse legitim deaktivieren könnten, oder für eine .NET-6/7-Anwendung aktivieren, die dem Standardwechsel vorausging.

Alle diese entsprechen MSBuild-Eigenschaften in der `.csproj` und `System.Runtime.*`-Schlüsseln in der `runtimeconfig.json`, dokumentiert in der Microsoft-Referenz zu den [Konfigurationseinstellungen für die Kompilierung](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation). Wenn Sie den gestuften JIT gegen den vollständigen Verzicht auf den JIT abwägen, finden Sie die Kompromisse in [Native AOT vs ReadyToRun vs reiner JIT](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) und in der tiefergehenden Betrachtung, [was Native AOT Sie kostet](/2026/06/what-is-native-aot-and-what-does-it-cost-you/), da AOT-Code überhaupt nie die Neuoptimierung von Dynamic PGO erhält.

Das Denkmodell, das Sie sich merken sollten: Ihr Prozess startet in billigem, schnell zu erzeugendem Tier-0-Code, der unauffällig Notizen macht; eine kleine Zahl von Methoden beweist, dass sie heiß sind; ein Hintergrund-Thread schreibt genau diese Methoden mit dem vollständigen, durch die Notizen informierten Optimierer neu; und OSR fängt alles ab, was in einer Schleife feststeckt, die das Aufrufzählen verpassen würde. Sobald Sie das in einem Trace geschehen sehen können, hört Tiered Compilation auf, eine Blackbox zu sein, und wird zu einem Werkzeug, über das Sie nachdenken können.

## Verwandt

- [Native AOT vs ReadyToRun vs reiner JIT in .NET 11](/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Was ist Native AOT und was kostet es Sie?](/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Wie Sie eine .NET-Anwendung mit dotnet-trace profilieren und die Ausgabe lesen](/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [Wie Sie die Kaltstartzeit einer .NET-11-AWS-Lambda reduzieren](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [Der ASM-Viewer von Rider 2026.1 für JIT- und Native-AOT-Disassembly](/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/)

## Quellen

- [Konfigurationseinstellungen für die Kompilierung, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)
- [Designdokument zur Tiered Compilation, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/tiered-compilation.md)
- [Designdokument zum On-Stack-Replacement, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/OnStackReplacement.md)
- [Enable QJFL and OSR by default for x64 and arm64, PR #65675](https://github.com/dotnet/runtime/pull/65675)
- [Performance Improvements in .NET 7, .NET Blog](https://devblogs.microsoft.com/dotnet/performance_improvements_in_net_7/)
- [Designdokument zu Dynamic PGO, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/DynamicPgo.md)
