---
title: "Was ist PGO in .NET und muss ich es aktivieren?"
description: "PGO (profilgesteuerte Optimierung) lässt den .NET-JIT den heißen Code für die Typen und Verzweigungen spezialisieren, die Ihre Arbeitslast tatsächlich trifft. Dynamic PGO ist seit .NET 8 standardmäßig aktiviert, daher müssen Sie es unter .NET 8 und höher nicht aktivieren. Hier erfahren Sie, was es tut, wie Sie seine Wirkung sehen und in welchen seltenen Fällen Sie an der Einstellung drehen."
pubDate: 2026-07-11
tags:
  - "dotnet"
  - "performance"
  - "jit"
  - "dotnet-11"
  - "csharp"
lang: "de"
translationOf: "2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in"
translatedBy: "claude"
translationDate: 2026-07-11
---

PGO steht für profilgesteuerte Optimierung: Der Compiler sammelt ein Profil davon, wie Ihr Code tatsächlich läuft, und nutzt dieses Profil dann, um schnelleren Maschinencode für die Pfade zu erzeugen, die zählen. In .NET erledigt der JIT dies zur Laufzeit, ein Modus namens Dynamic PGO, und die kurze Antwort auf "Muss ich es aktivieren?" lautet nein, nicht mehr. Dynamic PGO ist seit .NET 8 standardmäßig aktiviert, daher haben Sie es unter .NET 8, .NET 9, .NET 10 und .NET 11 bereits. Sie greifen nur dann zum Schalter, wenn Sie unter .NET 6 oder 7 arbeiten (wo es standardmäßig deaktiviert war) oder wenn Sie eine ungewöhnliche, sehr kurzlebige Arbeitslast haben, bei der Sie es abschalten möchten. Dieser Artikel erklärt, was Ihnen das Profil bringt, wie Sie bestätigen, dass es läuft, und die wenigen Fälle, in denen sich das Drehen an der Einstellung lohnt.

Alles hier zielt auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET-11-SDK (`11.0.100`), aber das standardmäßig aktivierte Verhalten gilt seit .NET 8, und der zugrunde liegende Mechanismus ist stabil, seit .NET 7 ihn gefestigt hat. Wo ein Verhalten von einer bestimmten Version abhängt, weise ich darauf hin.

## Was "profilgesteuert" wirklich bedeutet

Ein herkömmlicher optimierender Compiler muss raten. Wenn er einen virtuellen Methodenaufruf sieht, kann er nicht wissen, welcher konkrete Typ zur Laufzeit auftaucht, also gibt er einen allgemeinen indirekten Aufruf aus. Wenn er ein `if` sieht, weiß er nicht, welche Verzweigung heiß ist, also legt er beide so aus, als wären sie gleich wahrscheinlich. Wenn er eine Schleife sieht, weiß er nicht, ob sie zweimal oder zwei Millionen Mal läuft. Diese Vermutungen sind meist in Ordnung und lassen gelegentlich viel Leistung liegen.

Die profilgesteuerte Optimierung beseitigt das Raten. Sie führt das Programm aus, zeichnet auf, was an jedem dieser Entscheidungspunkte tatsächlich geschah, und speist diese Daten zurück in den Optimierer. Nun weiß der Compiler, dass eine bestimmte Aufrufstelle zu 98% `List<int>` war, dass eine bestimmte Verzweigung einmal in tausend Iterationen genommen wird, dass eine bestimmte Schleife wirklich heiß ist. Er kann den Code für die Realität spezialisieren, statt sich für jede Möglichkeit abzusichern.

Klassisches vorgezogenes PGO erledigt dies in zwei getrennten Builds: einem instrumentierten Build, den Sie gegen eine repräsentative Arbeitslast laufen lassen, um ein Profil zu erzeugen, und dann einem zweiten Build, der das Profil verbraucht. So machen es C- und C++-Toolchains seit Jahrzehnten, und es ist mächtig, aber umständlich, weil Sie eine Arbeitslast erfassen müssen, die der Produktion ähnelt, und neu kompilieren müssen. Dynamic PGO von .NET verschmilzt beide Phasen in einem einzigen laufenden Prozess, was es zu etwas macht, das Sie einfach aktiviert lassen können.

## Wie Dynamic PGO sich auf die Tiered Compilation stützt

Dynamic PGO ist kein separater, an die Laufzeit angeschraubter Durchlauf. Es reitet auf der Maschinerie mit, die der JIT bereits nutzt, um heiße Methoden zweimal zu kompilieren. Falls Sie dieses Zwei-Durchlauf-Modell noch nicht verinnerlicht haben, ist der Artikel darüber, [was Tiered Compilation ist und wie man darüber nachdenkt](/de/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/), die Voraussetzung; die sehr kurze Fassung lautet, dass Methoden zunächst als schneller, unoptimierter "Tier 0"-Code kompiliert werden und nur die heißen im Hintergrund als vollständig optimierter "Tier 1"-Code neu kompiliert werden.

Dynamic PGO nutzt diesen ersten Durchlauf aus. Wenn es aktiv ist, ist der Tier-0-Code, den der JIT ausgibt, nicht nur unoptimiert, sondern instrumentiert. Der Compiler fügt günstige Sonden ein, die zählen, wie oft jeder Basisblock ausgeführt wird, und die an virtuellen und Schnittstellen-Aufrufstellen ein kleines Histogramm darüber aufbauen, welche konkreten Typen tatsächlich ankommen. Während Ihre Anwendung aufwärmt, sammelt dieser Tier-0-Code still ein Profil Ihrer spezifischen Arbeitslast. Wenn eine Methode später auf Tier 1 befördert wird, liest der Optimierer das gesammelte Profil und spezialisiert den Tier-1-Code entsprechend.

Dieses Timing ist der ganze Trick. Das Profil wird von der realen Arbeitslast, auf der realen Maschine, Momente bevor der optimierte Code erzeugt wird, gesammelt, sodass es keinen separaten instrumentierten Build und kein Problem mit der repräsentativen Arbeitslast gibt. Der Preis dafür ist, dass instrumentierter Tier-0-Code etwas langsamer und etwas größer als reiner Tier-0-Code ist, was nur während des kurzen Fensters vor der Beförderung von Bedeutung ist.

## Die Optimierung, die für den Rest bezahlt: Guarded Devirtualization

Das Wertvollste, was Dynamic PGO ermöglicht, ist Guarded Devirtualization (GDV). Virtuelle und Schnittstellen-Aufrufe sind nicht teuer, weil der indirekte Sprung selbst langsam wäre, sondern weil der JIT durch sie hindurch kein Inlining vornehmen kann, und Inlining ist der Ort, an dem die meisten anderen Optimierungen ihren Hebel finden. Wenn der Compiler nicht in einen Aufruf hineinsehen kann, kann er keine Konstanten über ihn hinweg falten, keine Arbeit aus ihm herausheben und keine redundanten Prüfungen um ihn herum beseitigen.

Mit einem Typprofil in der Hand kann der JIT einen schnellen Pfad einfügen. Er gibt eine explizite Prüfung des Typs aus, der das Profil dominierte, und wenn die Prüfung besteht, führt er eine inlined, vollständig optimierte Kopie des Methodenkörpers aus; schlägt sie fehl, greift er auf den normalen virtuellen Aufruf zurück. Betrachten Sie eine Schleife über ein `IEnumerable<int>`, das in Wirklichkeit immer ein `List<int>` ist:

```csharp
// .NET 11, C# 14.
// Dynamic PGO learns that `items` is a List<int> at this call site
// and inlines the enumerator's MoveNext/Current behind a type guard.
static long Sum(IEnumerable<int> items)
{
    long total = 0;
    foreach (int x in items) // virtual GetEnumerator/MoveNext without PGO
        total += x;
    return total;
}
```

Ohne PGO geht das `foreach` bei jedem Element durch Schnittstellen-Dispatch. Mit PGO rät der JIT `List<int>`, sichert die Vermutung mit einer Typprüfung ab und inlined den Enumerator, sodass der Schleifenkörper zu straffer, allokationsfreier Ganzzahlarithmetik wird. Ab .NET 8 kann der JIT sogar mehr als eine Absicherung an einer Stelle ausgeben, die zwei dominante Typen sieht, obwohl mehrfaches GDV standardmäßig deaktiviert und hinter einer Konfigurationseinstellung verwahrt ist. Das .NET-Team maß Framework-Methoden, bei denen GDV allein die Ausführungszeit um etwa 40% senkte, und berichtete von echten Gewinnen in Produktion: [Bings Migration auf .NET 8](https://devblogs.microsoft.com/dotnet/bing-on-dotnet-8-the-impact-of-dynamic-pgo/) führte einen Rückgang der CPU-Zyklen pro Abfrage um 13%, eine Verringerung der von gen0/gen1-GC betroffenen Abfragen um 20% und einen Rückgang einiger interner Latenzen um über 25% großenteils darauf zurück, dass Dynamic PGO standardmäßig aktiviert ist.

## Muss ich es aktivieren? Die Antwort Version für Version

Hier ist der Teil, nach dem die Suchanfrage wirklich fragt.

- **.NET 8, 9, 10 und 11**: nein. Dynamic PGO ist standardmäßig aktiviert. Sie tun nichts. Wenn `<TieredCompilation>` auf dem Standardwert (aktiviert) steht, haben Sie PGO bereits.
- **.NET 7**: es existiert und funktioniert gut, ist aber standardmäßig deaktiviert. Aktivieren Sie es mit der Einstellung unten, wenn Sie es möchten.
- **.NET 6**: hier wurde es als Experiment eingeführt, standardmäßig deaktiviert und weniger ausgereift. Sie können es aktivieren, sollten es aber als Vorschauqualität behandeln.
- **.NET 5 und früher**: Dynamic PGO existiert nicht.

Um es dort einzuschalten, wo es nicht der Standard ist, setzen Sie die MSBuild-Eigenschaft in Ihrer Projektdatei:

```xml
<!-- .NET 7 (or .NET 6). Opts into Dynamic PGO, which is off by default there. -->
<!-- Unnecessary on .NET 8+, where it is already enabled. -->
<PropertyGroup>
  <TieredPGO>true</TieredPGO>
</PropertyGroup>
```

Oder setzen Sie die Umgebungsvariable, was für A/B-Tests ohne Neukompilierung praktisch ist:

```bash
# Enable Dynamic PGO for a single run (any supported .NET version).
DOTNET_TieredPGO=1 ./myapp
```

Die MSBuild-Eigenschaft, der `runtimeconfig.json`-Schlüssel (`System.Runtime.TieredPGO`) und die Umgebungsvariable `DOTNET_TieredPGO` steuern alle denselben Schalter, dokumentiert in Microsofts Referenz zu den [Konfigurationseinstellungen der Kompilierung](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation). Da Dynamic PGO von der Tiered Compilation abhängt, deaktiviert das Abschalten der Tiered Compilation (`DOTNET_TieredCompilation=0`) auch Dynamic PGO als Nebeneffekt; es gibt keinen Profildurchlauf, wenn es kein Tier 0 gibt.

## Wann Sie es berechtigterweise abschalten könnten

PGO aktiviert zu lassen ist für nahezu jede Anwendung die richtige Wahl, aber es gibt eine ehrliche Ausnahme: einen Prozess, der endet, bevor seine heißen Methoden je Tier 1 erreichen. Eine kurzlebige CLI, eine Serverless-Funktion, die eine Anfrage bearbeitet und stirbt, ein AWS Lambda mit einem aggressiven Timeout. Bei solchen Arbeitslasten läuft der instrumentierte Tier-0-Code, zahlt die kleine Profiling-Steuer, und der Prozess fährt herunter, bevor irgendeine Tier-1-Neukompilierung stattfindet, sodass Sie für ein Profil bezahlt haben, das Sie nie ausgegeben haben.

```xml
<!-- .NET 11, C# 14. Turns Dynamic PGO OFF. -->
<!-- Only sensible for ultra-short-lived processes that never reach tier 1. -->
<PropertyGroup>
  <TieredPGO>false</TieredPGO>
</PropertyGroup>
```

Auch hier: nehmen Sie es nicht an, messen Sie. Viele auf Kaltstart empfindliche Arbeitslasten gewinnen mehr durch eine völlig andere Strategie, etwa ReadyToRun-Images oder Native AOT, als durch das Umschalten von PGO. Die Abwägungen speziell für den Kaltstart werden im Leitfaden zum [Reduzieren der Kaltstartzeit eines AWS Lambda mit .NET 11](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) durchgearbeitet. Und wenn Sie erwägen, den JIT ganz aufzugeben, beachten Sie, dass [Native-AOT](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/)-Code nie die Laufzeit-Reoptimierung von Dynamic PGO erhält, weil es in einer vorgezogen kompilierten Binärdatei keinen Tier-0-Profiling-Durchlauf gibt.

## Static PGO: das Profil, das das Framework mitbringt

Dynamic PGO ist nicht das einzige PGO in .NET. Die eigenen vorkompilierten ReadyToRun-Images des Frameworks werden mit Static PGO gebaut: Microsoft sammelt offline ein Profil, speichert es als `.mibc`-Datei und gibt es an den `crossgen2`-Compiler, sodass selbst der vorgezogen kompilierte Framework-Code gemäß einem repräsentativen Profil angeordnet wird. Deshalb kommen `string`, `List<T>` und der Rest der Basisklassenbibliothek bereits abgestimmt an, bevor Ihre Anwendung eine einzige Zeile ausführt.

Sie können dasselbe für Ihre eigenen AOT- oder ReadyToRun-Builds tun: erfassen Sie ein Profil mit dem Werkzeug, erzeugen Sie eine `.mibc` und geben Sie sie an `crossgen2`. Dies ist ein Nischen- und fortgeschrittener Workflow, vor allem relevant, wenn Sie Native AOT veröffentlichen und eine profilgestützte Anordnung ohne JIT zur Laufzeit wollen. Für die überwiegende Mehrheit der Server- und Desktop-Anwendungen, die den JIT behalten, gibt Ihnen Dynamic PGO automatisch dieselbe Art von Nutzen und passt sich an die tatsächliche Arbeitslast statt an ein Konservenprofil an, was strikt besser ist als ein statisches, zur Kompilierzeit eingebackenes Profil. Die Wahl zwischen JIT-mit-PGO und den AOT-Modellen ist das Thema von [Native AOT vs ReadyToRun vs reinem JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/).

## Wie Sie bestätigen, dass PGO tatsächlich etwas tut

Da PGO von Natur aus still ist, lautet die naheliegende Frage, wie Sie wissen, dass es funktioniert. Zwei Ansätze.

Der erste ist, sich den Maschinencode anzusehen. `DOTNET_JitDisasm` auf einen Methodennamen zu setzen gibt den Tier-1-Assembler aus, und eine Methode, die durch GDV gegangen ist, zeigt eine verräterische Form: einen Typvergleich, einen inlined schnellen Pfad und einen Rückfall-Aufruf. Wenn Sie PGO deaktivieren und erneut ausgeben, verschwinden die Absicherung und der inlined Körper, und Ihnen bleibt ein reiner virtueller Aufruf. Dieses Vorher-Nachher ist der klarste Beweis, dass das Profil die Ausgabe verändert hat.

```bash
# .NET 11 SDK 11.0.100. Dump the JIT's assembly for a specific method,
# then compare with DOTNET_TieredPGO=0 to see the guarded fast path vanish.
DOTNET_JitDisasm=Sum DOTNET_TieredPGO=1 ./myapp
```

Der zweite Ansatz ist, den Durchsatz korrekt zu messen, was bedeutet, den Tier-1-Code im eingeschwungenen Zustand zu messen und nicht das Tier-0-Aufwärmen, das ihm vorausgeht. Bauen Sie keine `Stopwatch`-Schleife von Hand; verwenden Sie [BenchmarkDotNet](https://benchmarkdotnet.org/), das aufwärmt, bis sich die Zeiten stabilisieren, und denselben Benchmark mit PGO an und aus laufen lassen kann, damit Sie Vergleichbares vergleichen. Wenn Sie die Tiering- und JIT-Ereignisse in einem realen Prozess vorbeiziehen sehen möchten, führt der Artikel zum [Profilieren einer .NET-Anwendung mit dotnet-trace](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) durch das Erfassen des Laufzeit-Providers, der die Optimierungsstufe jeder Methode meldet.

Das mentale Modell zum Merken: PGO ist der Grund, warum das .NET-Design, "heiße Methoden zweimal zu kompilieren", Code erzeugt, den ein statischer Compiler nicht erreichen kann, weil die zweite Kompilierung durch ein Profil Ihrer realen Arbeitslast informiert ist. Unter .NET 8 und höher ist es bereits aktiviert, passt sich bereits an und trägt sich bereits selbst. Sie müssen es nicht aktivieren. Sie müssen nur wissen, dass es da ist, damit Sie beim Benchmarking die optimierte Stufe messen und dem Profil die Geschwindigkeit zuschreiben, die es sich verdient hat.

## Related

- [Was ist Tiered Compilation und wie denke ich darüber nach?](/de/2026/07/what-is-tiered-compilation-and-how-do-i-reason-about-it/)
- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/)
- [Native AOT vs ReadyToRun vs reiner JIT in .NET 11](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/)
- [Wie man eine .NET-Anwendung mit dotnet-trace profiliert und die Ausgabe liest](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)
- [Wie man die Kaltstartzeit eines AWS Lambda mit .NET 11 reduziert](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)

## Sources

- [Konfigurationseinstellungen der Kompilierung, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation)
- [Dynamic-PGO-Designdokument, dotnet/runtime](https://github.com/dotnet/runtime/blob/main/docs/design/features/DynamicPgo.md)
- [Performance Improvements in .NET 8, .NET Blog](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-8/)
- [Bing on .NET 8: The Impact of Dynamic PGO, .NET Blog](https://devblogs.microsoft.com/dotnet/bing-on-dotnet-8-the-impact-of-dynamic-pgo/)
