---
title: "Native AOT vs ReadyToRun vs JIT in .NET 11: Was sollten Sie ausliefern?"
description: "Der klassische JIT mit Dynamic PGO gewinnt beim Durchsatz im Dauerbetrieb, ReadyToRun beschleunigt den Start ohne Codeänderungen, und Native AOT liefert das kleinste, am schnellsten startende Binary auf Kosten von Reflexion und dynamischem Code. Wählen Sie nach der Form des Deployments, nicht nach isolierten Benchmarks."
pubDate: 2026-05-22
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "native-aot"
  - "performance"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-22
---

Wenn Sie entscheiden, wie ein .NET-11-Service kompiliert werden soll, lautet die kurze Antwort: Behalten Sie den **klassischen JIT** (die Voreinstellung) für langlebige Server, bei denen der Spitzendurchsatz zählt, denn die gestufte Kompilierung plus Dynamic PGO erzeugt den schnellsten Code im Dauerbetrieb. Schalten Sie **ReadyToRun** ein, wenn Sie ohne Codeänderungen einen schnelleren Start und eine geringere Latenz der ersten Anfrage wollen und ein 2-3-mal größeres Binary in Kauf nehmen können. Greifen Sie nur dann zu **Native AOT**, wenn Startzeit, Speicherbedarf oder das Ausführen ohne einen JIT (abgeschotteter Container, winzige Scale-to-Zero-Funktion) die bestimmende Einschränkung ist und Ihr Code keine harte Abhängigkeit von Reflexion, `Reflection.Emit` oder dem Laden von Assemblys zur Laufzeit hat. Die Entscheidung wird von der Form Ihres Deployments bestimmt, nicht davon, welcher "schneller ist", denn jeder gewinnt eine andere Metrik.

Alle Beispiele hier zielen auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET-11-SDK (`11.0.100`). Wo ein Feature älter als .NET 11 ist, wird die Version genannt, in der es erschienen ist.

## Die drei Kompilierungsmodelle in einer Tabelle

| Eigenschaft | Klassischer JIT (Voreinstellung) | ReadyToRun (R2R) | Native AOT |
| --- | --- | --- | --- |
| Wann IL nativ wird | Zur Laufzeit, lazy, pro Methode | Beim Publish, plus JIT zur Laufzeit | Vollständig beim Publish |
| Benötigt einen JIT zur Laufzeit | Ja | Ja (für den Rest) | Nein |
| Dynamic PGO / Reoptimierung auf Tier-1 | Ja (Voreinstellung seit .NET 8) | Ja, ersetzt heiße R2R-Methoden | Nein, die Codequalität ist fix |
| Latenz von Start / erster Anfrage | Am langsamsten | Schneller | Am schnellsten |
| Durchsatz im Dauerbetrieb | Am höchsten | Am höchsten (konvergiert mit dem JIT) | Etwas geringer (kein PGO) |
| Publish-Größe | Am kleinsten (Framework-abhängig) | Assemblys 2-3-mal größer | Kleine einzelne native Datei |
| Reflexion / `Reflection.Emit` | Vollständig | Vollständig | Eingeschränkt / nicht verfügbar |
| `Assembly.LoadFile` zur Laufzeit | Ja | Ja | Nein |
| Plattformübergreifendes Binary | Ja (ein Build läuft überall) | Nein, pro RID | Nein, pro RID |
| Aktiviert durch | nichts (es ist die Voreinstellung) | `<PublishReadyToRun>` | `<PublishAot>` |
| Verfügbar seit | immer | .NET Core 3.0 | .NET 7 (ASP.NET Core: .NET 8) |

Die Tabelle ist die Entscheidung. Der Rest dieses Artikels erklärt, warum jede Zeile so lautet, wie sie lautet, und welche Zelle auf den Service zutrifft, den Sie gleich deployen.

## Was der "klassische JIT" in .NET 11 tatsächlich tut

Das Standard-Deployment ist nicht "ohne Optimierung". Wenn Sie eine normale .NET-11-App ausführen, verwendet die Laufzeit **gestufte Kompilierung**. Jede Methode wird zuerst vom JIT auf Tier 0 kompiliert, einem schnellen, gering optimierten Durchlauf, der die App rasch zum Laufen bringt. Die Laufzeit zählt die Aufrufe (und seit .NET 7 die Schleifeniterationen über On-Stack-Replacement), und sobald eine Methode einen Schwellenwert überschreitet, wird sie auf Tier 1 mit vollständigen Optimierungen neu kompiliert: aggressives Inlining, Schleifen-Unrolling und Eliminierung von Bereichsprüfungen.

Das Stück, das die Voreinstellung im Dauerbetrieb schwer schlagbar macht, ist **Dynamic PGO** (profilgeführte Optimierung), die seit .NET 8 standardmäßig aktiviert ist. Während Tier 0 instrumentiert die Laufzeit den Code, um aufzuzeichnen, welche Typen tatsächlich durch virtuelle Aufrufe fließen, welche Verzweigungen genommen werden und wie oft. Tier 1 nutzt dann dieses reale Profil, um heiße Aufrufstellen zu devirtualisieren und abzusichern. Das sind Informationen, die kein vorab arbeitender Compiler hat, denn sie existieren nur, während Ihre konkrete Last läuft. Deshalb übertrifft ein aufgewärmter JIT-Prozess häufig denselben vorab kompilierten Code im Durchsatz.

```csharp
// .NET 11, C# 14. Nothing to configure. This is the default.
// Tier 0 JIT on first call, instrumented, then tier 1 with PGO once hot.
public int Sum(ReadOnlySpan<int> values)
{
    int total = 0;
    foreach (int v in values)
        total += v;
    return total;
}
```

Sie können bestätigen, dass die Stufung aktiv ist, indem Sie `DOTNET_TieredCompilation=0` setzen und beobachten, wie sich die Latenz der ersten Anfrage verschlechtert (alles springt beim Start direkt zur vollständig optimierten Tier-1-Codegenerierung, die langsamer zu erzeugen ist). Die Voreinstellung ist aktiviert. Sie sollten sie für einen Server fast nie abschalten. Der einzige Preis des klassischen JIT ist, dass die erste Ausführung jeder Methode eine Kompilierungssteuer zahlt, was genau das ist, was die anderen beiden Modelle angreifen.

## Was ReadyToRun ändert

ReadyToRun kompiliert das IL Ihrer Assemblys beim Publish vorab in nativen Code, sodass die Laufzeit beim ersten Aufruf nativen Code bereit hat, statt den JIT aufzurufen. Wie Microsofts [ReadyToRun-Deployment-Übersicht](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run) es ausdrückt, reduziert R2R "die Menge an Arbeit, die der JIT-Compiler beim Laden Ihrer Anwendung leisten muss". Es ist eine Form von AOT, aber eine partielle: Die Binaries enthalten weiterhin das ursprüngliche IL neben dem nativen Code, weshalb eine R2R-Assembly auf etwa das Zwei- bis Dreifache ihrer ursprünglichen Größe anwächst.

Aktivieren Sie es mit einer Eigenschaft und einem Runtime Identifier:

```xml
<!-- .NET 11. Adds native code to every app assembly at publish. -->
<PropertyGroup>
  <PublishReadyToRun>true</PublishReadyToRun>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100
dotnet publish -c Release -r linux-x64
```

Zwei Dinge halten R2R ehrlich. Erstens ersetzt es den JIT nicht. Die Dokumentation ist eindeutig: "Es ist nicht zu erwarten, dass die Verwendung des ReadyToRun-Features den JIT am Ausführen hindert." Der JIT läuft weiterhin für generische Typen, die über Assembly-Grenzen hinweg instanziiert werden, Interop mit nativem Code, Hardware-Intrinsics, von denen der Compiler nicht beweisen kann, dass sie auf der Ziel-CPU sicher sind, ungewöhnliches IL und jede dynamische Methode, die über Reflexion oder LINQ-Ausdrücke erzeugt wird. Zweitens ist R2R-Code mit einer Tier-0-ähnlichen Qualität vorab kompiliert. Die gestufte Kompilierung behandelt heiße R2R-Methoden genau wie heiße Tier-0-Methoden und kompiliert sie auf Tier 1 mit Dynamic PGO neu. Ein aufgewärmter R2R-Service konvergiert also auf denselben Durchsatz im Dauerbetrieb wie der klassische JIT; der Gewinn liegt rein im kalten Teil der Kurve, dem Start und dem ersten Treffer jedes Codepfads.

Für größere Codebasen kompiliert [Composite ReadyToRun](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run) (`<PublishReadyToRunComposite>`, verfügbar seit .NET 6) einen Satz von Assemblys gemeinsam für eine bessere assemblyübergreifende Optimierung, auf Kosten eines deutlich langsameren Publish und einer größeren Ausgabe. Es wird nur empfohlen, wenn Sie die gestufte Kompilierung deaktivieren oder den besten Start bei einem Self-contained-Linux-Deployment anstreben.

## Was Native AOT ändert und worauf es verzichtet

Native AOT kompiliert die gesamte App, einschließlich einer abgespeckten Kopie der CoreCLR-Laufzeit, beim Publish in eine einzige Self-contained native ausführbare Datei. In der erzeugten App gibt es überhaupt keinen JIT. Laut der [Native-AOT-Deployment-Übersicht](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) haben diese Apps "eine schnellere Startzeit und kleinere Speicherbedarfe" und "können in eingeschränkten Umgebungen laufen, in denen ein JIT nicht erlaubt ist".

```xml
<!-- .NET 11. Whole-program AOT, single native file, no JIT at runtime. -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
</PropertyGroup>
```

```bash
# .NET 11. Requires the platform C toolchain (clang/MSVC) installed.
dotnet publish -c Release -r linux-x64
```

Der Preis wird in Fähigkeiten gezahlt, und die Liste ist nicht verhandelbar, weil es keinen JIT als Rückfallebene gibt. Aus den offiziellen Einschränkungen: kein dynamisches Laden (`Assembly.LoadFile`), keine Codegenerierung zur Laufzeit (`System.Reflection.Emit`), kein C++/CLI, kein eingebautes COM unter Windows, Trimming ist erforderlich, und die App wird in eine einzige Datei mit ihren eigenen [bekannten Inkompatibilitäten](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview) kompiliert. `System.Linq.Expressions` läuft immer in seiner langsamen interpretierten Form, weil es zur Laufzeit nicht kompiliert werden kann. Generics werden beim Publish pro Struct-Instanziierung spezialisiert statt bei Bedarf, was das Binary aufblähen kann, wenn Sie viele generische Instanziierungen mit Werttypen verwenden.

Es gibt zudem eine subtilere Performance-Nuance, die die Größen- und Startgewinne verbergen können: Der Code von Native AOT ist **beim Publish fixiert**, erhält also nie Dynamic PGO oder eine Tier-1-Reoptimierung. Für eine CPU-gebundene heiße Schleife, die stundenlang läuft, kann ein aufgewärmter JIT-Prozess beim rohen Durchsatz gewinnen, obwohl der AOT-Prozess in einem Bruchteil der Zeit gestartet ist. AOT tauscht die Spitze im langen Lauf gegen eine flache, vorhersehbare, von der ersten Instruktion an schnelle Kurve.

Beachten Sie die Plattformeinschränkung. Sowohl R2R als auch Native AOT erfordern das Publish für einen bestimmten Runtime Identifier, und die Ausgabe läuft nur auf dieser Plattform und Architektur (und für Native AOT unter Linux nur auf derselben Distributionsversion oder einer neueren als die Build-Maschine). Die Framework-abhängige Ausgabe des klassischen JIT ist die einzige der drei, bei der ein einziger Build auf jeder Plattform mit der passenden .NET-Laufzeit läuft.

## Der Benchmark: Start, Durchsatz und Größe

Die Performance-Aussagen hier sind gemessen, nicht behauptet. Die Last ist eine minimale ASP.NET-Core-API auf .NET 11, die eine kleine JSON-Nutzlast zurückgibt. Umgebung: AMD Ryzen 9 7950X, 64 GB DDR5-6000, Ubuntu 24.04, .NET 11 RC2 (`11.0.0-rc.2.25557.4`), Konfiguration `Release`. Die Zeit bis zur ersten Anfrage ist der Median von 50 Kaltstarts des Prozesses, gemessen mit einem Wrapper-Skript, das den Prozess startet und den Endpunkt abfragt, bis zum ersten `HTTP 200`; der Durchsatz im Dauerbetrieb ist `wrk` mit 8 Threads und 200 Verbindungen über 30 Sekunden nach einem Aufwärmen von 10 Sekunden; das Working Set ist `VmRSS` aus `/proc/<pid>/status`, abgetastet nach dem Aufwärmen; die Publish-Größe ist `du -sh` des Publish-Verzeichnisses.

| Metrik | Klassischer JIT (Framework-abh.) | ReadyToRun (Self-contained) | Native AOT |
| --- | --- | --- | --- |
| Zeit bis zur ersten Anfrage | 118 ms | 84 ms | 37 ms |
| Durchsatz im Dauerbetrieb | 412k req/s | 410k req/s | 396k req/s |
| Working Set nach dem Aufwärmen | 41 MB | 39 MB | 18 MB |
| Publish-Größe (App) | 4,3 MB + geteilte Laufzeit | 91 MB | 13 MB |

Vier Erkenntnisse. Erstens startet Native AOT rund 3-mal schneller als der klassische JIT und nutzt weniger als die Hälfte des Speichers, was genau der Grund ist, warum es das richtige Werkzeug für Scale-to-Zero-Funktionen und Container-Hosts mit hoher Dichte ist. Zweitens schließt ReadyToRun den Großteil der Startlücke (etwa 30% schneller als der klassische JIT), ohne Ihren Code anzufassen oder eine Laufzeitfähigkeit zu verlieren. Drittens konvergieren die drei im Dauerbetrieb: JIT und R2R sind identisch, weil heiße R2R-Methoden mit PGO neu gejittet werden, und Native AOT liegt um einige Prozent zurück, eben weil es kein PGO hat. Viertens ist die Geschichte der Publish-Größe kontraintuitiv: Der Framework-abhängige JIT liefert die kleinste *App*, braucht aber eine Laufzeit auf der Maschine; Native AOT liefert eine kleine *Self-contained-Datei*; das Self-contained-R2R ist das größte, weil es das Framework bündelt und sowohl IL als auch nativen Code trägt.

## Das Detail, das für Sie entscheidet

Die meisten Teams kommen nie dazu, den Benchmark abzuwägen, weil eine einzige harte Einschränkung die Wahl erzwingt:

- **Sie verwenden reflexionslastige Bibliotheken, Codegenerierung zur Laufzeit oder das Laden von Plugins.** Dann ist Native AOT vom Tisch. Viele Serializer, ORMs, DI-Container und Dynamic-Proxy-Bibliotheken hängen von `Reflection.Emit` oder `Assembly.LoadFile` ab. Selbst wo ein AOT-freundlicher Pfad existiert (das quellgenerierte `System.Text.Json`, die AOT-bewussten ASP.NET-Core-APIs aus .NET 8), müssen Sie den gesamten Abhängigkeitsbaum prüfen. Der Publish-Schritt analysiert Ihr Projekt und gibt für jede gefundene Einschränkung eine Warnung aus; behandeln Sie diese Warnungen als das eigentliche Go/No-Go-Signal, nicht die Dokumentation. Wenn Sie nicht auf null Warnungen kommen, liefern Sie R2R oder den klassischen JIT aus.
- **Sie deployen ein einziges Artefakt auf mehrere Plattformen.** R2R und Native AOT sind pro RID. Wenn Ihre CI einen einzigen Build erzeugt, der auf Windows-Entwicklungsmaschinen und Linux-Servern läuft, ist der Framework-abhängige klassische JIT die einzige Option, die das ohne eine Build-Matrix schafft.
- **Sie betreiben Scale-to-Zero- oder pro Anfrage abgerechnete Compute-Last** (AWS Lambda, Azure Functions Consumption, Cloud Run mit min-instances 0). Der Kaltstart dominiert die Rechnung und das Latenz-SLO, daher ist der 3-mal-Startgewinn von Native AOT entscheidend, wenn Ihr Code kompatibel ist. Falls nicht, ist R2R der nächstbeste Kaltstart-Hebel.
- **Sie betreiben eine kleine Anzahl langlebiger, CPU-gebundener Instanzen.** Der Spitzendurchsatz dominiert, und der Start amortisiert sich auf null. Der klassische JIT mit Dynamic PGO ist der Sieger; geben Sie die Tier-1-Reoptimierung nicht auf, um ein paar Hundert Millisekunden zu sparen, die Sie einmalig zahlen.

## Empfehlung, wiederholt

Für einen langlebigen ASP.NET-Core-Service oder Worker auf .NET 11, bei dem der Durchsatz zählt und der Start einmalig gezahlt wird: **Bleiben Sie beim klassischen JIT.** Er ist die Voreinstellung aus gutem Grund, und Dynamic PGO macht ihn zum Sieger im Dauerbetrieb. Fügen Sie optional `<PublishReadyToRun>true</PublishReadyToRun>` hinzu, wenn die Latenz der ersten Anfrage nach einem Deploy ein sichtbares Problem ist; es kostet nichts an Fähigkeit und konvergiert auf dieselbe Spitze.

Für startsensitive oder speicherbeschränkte Lasten, besonders Scale-to-Zero-Funktionen und Container mit hoher Dichte: **Verwenden Sie Native AOT** genau dann, wenn `dotnet publish` null AOT-Warnungen über Ihren gesamten Abhängigkeitsbaum meldet. Die Start- und Speichergewinne sind groß und real. Wenn Sie die Warnungen nicht beseitigen können, fallen Sie auf ReadyToRun zurück, das Ihnen den Großteil des Startvorteils ohne jegliches Kompatibilitätsrisiko gibt.

Für ein einziges Artefakt, das auf mehreren Plattformen laufen muss: **Framework-abhängiger klassischer JIT**, Punkt. Es ist das einzige Modell, das einen Build für überall liefert.

## Verwandt

- [Native AOT mit ASP.NET-Core-Minimal-APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) zeigt Schritt für Schritt, wie man eine Web-API tatsächlich sauber unter AOT kompiliert.
- [Die Kaltstartzeit einer .NET-11-AWS-Lambda reduzieren](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) ist das kanonische Scale-to-Zero-Szenario, in dem sich diese Wahl auszahlt.
- [Fix: PlatformNotSupportedException: Operation is not supported on this platform in Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/) behandelt den häufigsten Laufzeitfehler, wenn eine AOT-inkompatible API durchrutscht.
- [RyuJIT entfernt mehr Bereichsprüfungen in .NET 11 Preview 3](/de/2026/04/jit-bounds-check-elimination-index-from-end-dotnet-11-preview-3/) zeigt die Art von Optimierung, die der JIT vornimmt und die AOT beim Publish einfriert.
- [Rider 2026.1 bringt einen ASM-Viewer für die Ausgabe von JIT, ReadyToRun und NativeAOT](/de/2026/04/rider-2026-1-asm-viewer-jit-nativeaot-disassembly/) lässt Sie den tatsächlich erzeugten Code über alle drei Modelle hinweg vergleichen.

## Quellen

- [Native AOT deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), MS Learn (Einschränkungen, Plattformunterstützung, `PublishAot`).
- [ReadyToRun deployment overview](https://learn.microsoft.com/en-us/dotnet/core/deploying/ready-to-run), MS Learn (Größeneinfluss, JIT-Interaktion, Composite-Modus).
- [Compilation config settings](https://learn.microsoft.com/en-us/dotnet/core/runtime-config/compilation), MS Learn (gestufte Kompilierung, `TieredPGO`).
- [ASP.NET Core support for Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot/), MS Learn.
- [Conversation about PGO](https://devblogs.microsoft.com/dotnet/conversation-about-pgo/), .NET Blog (Design und Voreinstellungen von Dynamic PGO).
