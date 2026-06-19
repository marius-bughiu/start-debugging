---
title: "Was ist Native AOT und was kostet es Sie?"
description: "Native AOT kompiliert Ihre .NET-App in eine einzige eigenständige native Binärdatei ohne JIT und erkauft so schnellen Start und einen kleinen Speicherbedarf. Der Preis ist eine C-Toolchain zur Compile-Zeit, langsamere Veröffentlichungen, Builds pro RID, keine Reflexion oder Reflection.Emit, obligatorisches Trimming und kein Dynamic PGO. Hier ist die vollständige Bilanz."
pubDate: 2026-06-19
tags:
  - "dotnet"
  - "native-aot"
  - "performance"
  - "dotnet-11"
  - "csharp"
lang: "de"
translationOf: "2026/06/what-is-native-aot-and-what-does-it-cost-you"
translatedBy: "claude"
translationDate: 2026-06-19
---

Native AOT ist ein .NET-Veröffentlichungsmodell, das Ihre gesamte App plus eine reduzierte Kopie der Laufzeit im Voraus in eine einzige eigenständige native ausführbare Datei kompiliert. Die erzeugte App hat keinen JIT-Compiler, startet daher schnell und verbraucht weniger Speicher, und sie läuft auf Maschinen, auf denen die .NET-Laufzeit nicht installiert ist. Die Kosten werden in drei Währungen bezahlt: Reibung zur Compile-Zeit (Sie benötigen eine C-Toolchain, Veröffentlichungen sind langsamer, und jeder Build zielt auf genau ein Betriebssystem plus Architektur), Verlust von Fähigkeiten zur Laufzeit (kein Code, der auf Reflexion angewiesen ist, kein `System.Reflection.Emit`, kein dynamisches Laden von Assemblys, Trimming ist obligatorisch) und ein kleiner, oft unsichtbarer Einbruch beim Durchsatz, weil AOT-Code nie eine profilgesteuerte Reoptimierung erhält. Ob sich dieser Tausch lohnt, hängt vollständig von der Form Ihrer Bereitstellung ab, nicht von einer Benchmark-Zahl. Dieser Beitrag ist die vollständige Bilanz, damit Sie entscheiden können, bevor Sie den Schalter umlegen.

Alles hier zielt auf `<TargetFramework>net11.0</TargetFramework>` mit dem .NET 11 SDK (`11.0.100`). Native AOT selbst kam in .NET 7, und die ASP.NET Core-Unterstützung landete in .NET 8, daher gilt die nachfolgende Mechanik ab .NET 8, sofern keine Version genannt wird.

## Was "im Voraus" hier wirklich bedeutet

Eine normale .NET-App wird als IL (Intermediate Language) ausgeliefert. Zur Laufzeit wandelt der JIT-Compiler (Just-in-Time) dieses IL träge in nativen Maschinencode um, eine Methode nach der anderen, beim ersten Aufruf jeder Methode. Deshalb ist ein frisch gestarteter .NET-Prozess bei seinen ersten Anfragen etwas langsam: Er kompiliert sich selbst, während er läuft. Die Laufzeit, der GC und der JIT müssen auf der Maschine vorhanden sein, damit das funktioniert.

Native AOT entfernt den JIT vollständig aus der Gleichung. Wenn Sie `dotnet publish` mit `<PublishAot>true</PublishAot>` ausführen, startet das SDK ILC, den AOT-Compiler, der Ihr gesamtes IL, das gesamte IL Ihrer Abhängigkeiten und eine reduzierte Version der CoreCLR-Laufzeit in eine einzige native Binärdatei kompiliert. Wie Microsofts [Übersicht zur Native AOT-Bereitstellung](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) sagt, haben diese Apps "eine schnellere Startzeit und kleinere Speicherbedarfe" und "können in eingeschränkten Umgebungen laufen, in denen ein JIT nicht erlaubt ist".

Die minimale Aktivierung ist eine einzelne MSBuild-Eigenschaft und ein Runtime Identifier:

```xml
<!-- .NET 11, C# 14. Enables ILC at publish and turns on AOT analysis while editing. -->
<PropertyGroup>
  <PublishAot>true</PublishAot>
</PropertyGroup>
```

```bash
# .NET 11 SDK 11.0.100. The -r RID is mandatory: AOT output is platform-specific.
dotnet publish -c Release -r linux-x64
```

Die Ausgabe im Veröffentlichungsverzeichnis ist eine einzige ausführbare Datei, die alles enthält, was sie zum Laufen braucht, "einschließlich einer reduzierten Version der coreclr-Laufzeit". Es gibt keine separate Laufzeit zu installieren, und es gibt keinen JIT innerhalb der Binärdatei. Dieser Satz ist die gesamte Funktion und zugleich die gesamten Kosten. Jede Einschränkung unten folgt aus "es gibt keinen JIT zur Laufzeit".

## Die Rechnung zur Compile-Zeit

Bevor Sie eine Zeile Code schreiben, ändert Native AOT, was Ihre Build-Maschine und Ihre CI benötigen.

**Sie benötigen eine native C-Toolchain.** ILC erzeugt Objektcode, der von einem Plattform-Linker in eine echte ausführbare Datei des Betriebssystems gelinkt werden muss, daher sind die [Voraussetzungen](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/) je nach Betriebssystem nicht verhandelbar. Unter Windows benötigen Sie Visual Studio 2022 oder neuer mit der Workload "Desktopentwicklung mit C++". Unter Linux installieren Sie clang und die zlib-Entwickler-Header (`sudo apt-get install clang zlib1g-dev` unter Ubuntu, `sudo dnf install clang zlib-devel` unter Fedora und RHEL, `sudo apk add clang build-base zlib-dev` unter Alpine). Unter macOS benötigen Sie die Command Line Tools für Xcode. Ein einfaches `dotnet`-SDK-Image reicht für Ihre Build-Agents nicht mehr aus; Sie müssen die Toolchain auch in das CI-Image einbacken.

**Veröffentlichungen sind langsamer.** Die Kompilierung des gesamten Programms plus Trimming plus natives Linken ist deutlich mehr Arbeit als das Emittieren von IL. Eine Veröffentlichung, die für eine frameworkabhängige App ein paar Sekunden dauert, kann unter AOT Minuten dauern und skaliert mit der Größe Ihres Abhängigkeitsgraphen. Das ist eine Steuer pro Veröffentlichung, nicht pro Ausführung, aber real genug, dass Sie AOT normalerweise nicht bei jedem Build der inneren Schleife ausführen, sondern nur beim Veröffentlichen.

**Jeder Build erfolgt pro RID.** Die AOT-Ausgabe läuft nur auf dem Betriebssystem und der CPU-Architektur, für die Sie kompiliert haben. Eine für `win-x64` kompilierte Binärdatei läuft nicht auf `linux-arm64`, Punkt. Unter Linux ist es speziell noch schlimmer: Eine auf einer bestimmten Distributionsversion kompilierte Binärdatei läuft nur auf dieser Version oder neuer. Die Dokumentation ist explizit, dass "eine auf Ubuntu 20.04 erzeugte Native AOT-Binärdatei auf Ubuntu 20.04 und neuer laufen wird, aber nicht auf Ubuntu 18.04 laufen wird". Wenn Sie auf mehrere Plattformen ausliefern, benötigen Sie eine Build-Matrix, eine Veröffentlichung pro RID. .NET 9 erweiterte die unterstützten Ziele um Windows/Linux x86 und 32-Bit-Arm zusätzlich zu dem x64 und Arm64, das .NET 8 unterstützte.

Vergleichen Sie das mit einer frameworkabhängigen JIT-App, bei der ein einziger Build auf jeder Maschine läuft, die die passende .NET-Laufzeit hat. Diese Portabilität ist eines der Dinge, auf die Sie verzichten.

## Die Laufzeitfähigkeiten, auf die Sie verzichten

Dies ist der Teil, der die meisten Projekte entscheidet, denn die Verluste sind nicht "langsamer", sondern "funktioniert nicht, und der Veröffentlichungsschritt wird Sie warnen". Da es keinen JIT gibt, fällt alles weg, was darauf angewiesen ist, Code zur Laufzeit zu generieren oder zu entdecken. Direkt aus den [offiziellen Einschränkungen](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/):

- **Kein dynamisches Laden**, zum Beispiel `Assembly.LoadFile`. Plugin-Architekturen, die einen Ordner nach DLLs durchsuchen und sie zur Laufzeit laden, können nicht funktionieren, weil der Code nie in die Binärdatei kompiliert wurde.
- **Keine Codegenerierung zur Laufzeit**, zum Beispiel `System.Reflection.Emit`. Das nimmt still und leise einen überraschenden Teil des Ökosystems heraus: Bibliotheken für dynamische Proxys (Castle DynamicProxy), einige Mocking-Frameworks und jeder Serializer oder Mapper, der für die Geschwindigkeit IL emittiert.
- **Kein C++/CLI** und unter Windows **kein integriertes COM**.
- **Trimming ist obligatorisch.** Der Trimmer entfernt jeden Code, von dem er nicht beweisen kann, dass er erreichbar ist. Unbegrenzte Reflexion (`Type.GetType("SomeName")` aus einer Zeichenkette, `GetProperties()`-Durchläufe, `Activator.CreateInstance(someType)`) vereitelt diese Analyse, daher braucht Code mit viel Reflexion entweder Annotationen oder muss durch einen Source Generator ersetzt werden.
- **Die Einzeldatei-Verpackung ist impliziert**, was eigene [bekannte Inkompatibilitäten](https://learn.microsoft.com/en-us/dotnet/core/deploying/single-file/overview) mit sich bringt (APIs, die eine `.dll` auf der Festplatte voraussetzen, `Assembly.Location`, das leer zurückgibt, und so weiter).
- **`System.Linq.Expressions` läuft immer interpretiert.** Sie können nicht zur Laufzeit kompiliert werden, weil das den JIT braucht, daher funktioniert Code mit vielen Ausdrucksbäumen weiterhin, läuft aber langsamer als auf einem Host mit JIT.

Die wichtigste praktische Regel: **der Compiler sagt es Ihnen.** "Der Veröffentlichungsprozess analysiert das gesamte Projekt und seine Abhängigkeiten auf mögliche Einschränkungen. Für jede Einschränkung, auf die die veröffentlichte App zur Laufzeit stoßen könnte, werden Warnungen ausgegeben." Diese Warnungen sind IL2026 (erfordert nicht referenzierten Code, ein Trimming-Problem) und IL3050 (erfordert dynamischen Code, ein AOT-Problem). Behandeln Sie ein sauberes `dotnet publish` mit null IL2026/IL3050-Warnungen als Ihr Go-/No-Go-Signal, nicht die Dokumentation. Wenn Sie nicht auf null kommen, liefern Sie kein AOT aus.

Der Weg auf null führt fast immer über das Ersetzen von Reflexion durch Codegenerierung zur Compile-Zeit. Das quellgenerierte `System.Text.Json` ist das kanonische Beispiel: Statt zur Laufzeit über Ihr DTO zu reflektieren, emittiert ein Generator den Serialisierungscode zur Compile-Zeit. Wenn der Begriff neu für Sie ist, ist [was ein Source Generator ist und wann Sie einen brauchen](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) der richtige erste Schritt, denn unter AOT sind sie nicht mehr ein Nice-to-have, sondern die einzige Möglichkeit, wie manche Bibliotheken überhaupt funktionieren.

## Die Durchsatzkosten, die niemand erwähnt

Es gibt Kosten, die die Schlagzeilen zu Start und Größe verbergen. Ein JIT-Prozess kompiliert Ihren Code nicht nur einmal. Seit .NET 8 ist **Dynamic PGO** (profilgesteuerte Optimierung) standardmäßig aktiviert: Während Ihre App läuft, zeichnet die Laufzeit auf, welche Typen tatsächlich durch virtuelle Aufrufe fließen und welche Verzweigungen heiß sind, und rekompiliert diese Methoden dann auf Tier 1 mit diesem realen Profil. Das ist eine Information, die kein AOT-Compiler haben kann, weil sie nur existiert, während Ihre spezifische Arbeitslast läuft.

Native AOT-Code ist zur Veröffentlichungszeit festgelegt. Er erhält nie eine Tier-1-Reoptimierung und nie PGO. Für eine CPU-gebundene heiße Schleife, die stundenlang läuft, kann ein gut aufgewärmter JIT-Prozess denselben mit AOT kompilierten Code im rohen Durchsatz schlagen, obwohl der AOT-Prozess in einem Bruchteil der Zeit gestartet ist. AOT tauscht die Spitze am langen Ende gegen eine flache, vorhersehbare, von der ersten Anweisung an schnelle Kurve. Der gemessene Abstand ist klein (ein kleiner Prozentsatz in einem JSON-API-Benchmark), aber real und verläuft in die entgegengesetzte Richtung von allem anderen, was AOT bietet. Die vollständigen Zahlen stehen im [Vergleich Native AOT vs ReadyToRun vs JIT](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/), der Start, Durchsatz und Größe direkt gegenüberstellt.

Noch eine Nuance zur Größe: Generics. "Generische Parameter, die mit Struct-Typargumenten substituiert werden, erhalten für jede Instanziierung spezialisierten generierten Code." Ein JIT erzeugt diese bei Bedarf; AOT erzeugt sie alle im Voraus. Wenn Sie viele wertbasierte Generics instanziieren, wächst die Binärdatei. AOT-Binärdateien sind im üblichen Fall klein (eine Minimal-API liegt bei etwa 10-13 MB), aber eine Bibliothek mit vielen Generics kann sie stärker aufblähen, als Sie erwarten.

## Was die Kosten Ihnen einbringen

Die Vorteile sind echt und für die richtige Arbeitslast entscheidend. Der Start ist die Schlagzeile: Eine Minimal-API mit Native AOT startet etwa dreimal schneller als dieselbe App auf reinem JIT, weil es kein JIT-Aufwärmen und kein Laden von Assemblys gibt. Der Speicherbedarf fällt um mehr als die Hälfte, weil der Prozess keinen JIT, kein IL und keine Metadaten zum Kompilieren mitträgt. Und weil die Ausgabe eigenständig ist, ist die Bereitstellungseinheit eine einzige kleine Binärdatei ohne zu installierende Laufzeit, weshalb Teams die Größe ihrer Container-Images beim Wechsel erheblich verringern.

Der andere Vorteil ist kategorisch statt quantitativ: AOT-Apps "können in eingeschränkten Umgebungen laufen, in denen ein JIT nicht erlaubt ist". Manche abgeriegelten Container-Laufzeiten und Sicherheitsrichtlinien verbieten die beschreibbar-ausführbaren Speicherseiten, die ein JIT benötigt. AOT ist das einzige .NET-Bereitstellungsmodell, das dort überhaupt läuft.

Deshalb liegt der Sweet Spot bei Scale-to-Zero- und Hochdichte-Compute. Bei einer pro Anfrage abgerechneten Funktion (AWS Lambda, Azure Functions Consumption, Cloud Run auf null skaliert) dominiert der Kaltstart sowohl das Latenz-SLO als auch die Rechnung, daher ist ein 3-facher Startgewinn viel Schmerz zur Compile-Zeit wert. Das [Kaltstart-Handbuch für AWS Lambda in .NET 11](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) geht den genauen AOT-auf-Lambda-Pfad durch. Bei einem langlebigen, CPU-gebundenen Dienst mit einer Handvoll Instanzen amortisiert sich der Start auf null, und Sie würden Dynamic PGO für einen Vorteil aufgeben, den Sie nur einmal bezahlen, daher gewinnt meist der reine JIT.

## Wie Sie entscheiden, ohne zu raten

Führen Sie die Analyse aus, bevor Sie sich auf irgendetwas festlegen. Der billigste Test besteht darin, `<PublishAot>true</PublishAot>` zu setzen und eine Veröffentlichung gegen Ihren echten Abhängigkeitsgraphen auszuführen:

```bash
# .NET 11. Surfaces every IL2026 / IL3050 across your whole dependency tree.
dotnet publish -c Release -r linux-x64 -o ./publish
```

Wenn das mit Warnungen zurückkommt, die Sie nicht durch Annotationen beseitigen können, ist AOT für diese Codebasis noch nicht praktikabel, und Sie haben Ihre Antwort zum Preis einer Veröffentlichung. ASP.NET Core schärft den Punkt: MVC-Controller (`AddControllers`), Razor Pages und serverseitige SignalR-Hubs sind in .NET 11 nicht AOT-kompatibel, während Minimal-APIs und gRPC es sind. Wenn Sie das vollständige Rezept für einen sauberen Build wollen (den `CreateSlimBuilder`-Host, quellgeneriertes JSON, die Tücken von Bibliotheksprojekten), ist [wie man Native AOT mit ASP.NET Core Minimal-APIs verwendet](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) die Schritt-für-Schritt-Anleitung. Und wenn eine AOT-inkompatible API am Analyzer vorbeischlüpft und erst zur Laufzeit explodiert, deckt [das Beheben der daraus resultierenden PlatformNotSupportedException](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/) den häufigsten Fehler ab.

Eine kurze Entscheidungsregel: Greifen Sie zu Native AOT, wenn Startzeit, Speicherbedarf, Bereitstellungsgröße oder das Laufen ohne JIT die dominierende Einschränkung ist, **und** `dotnet publish` über Ihren gesamten Abhängigkeitsgraphen null AOT-Warnungen meldet. Bleiben Sie bei reinem JIT, wenn der Spitzendurchsatz im stationären Zustand wichtiger ist als der Start, wenn Sie ein einziges Artefakt auf mehrere Plattformen ausliefern, oder wenn eine tragende Abhängigkeit Reflexion oder `Reflection.Emit` benötigt, die Sie nicht ersetzen können. Native AOT ist kein schnelleres `dotnet publish`; es ist ein anderer Bereitstellungsvertrag, und die obigen Kosten sind die Bedingungen dieses Vertrags. Lesen Sie sie, bevor Sie unterschreiben.

## Verwandt

- [Native AOT vs ReadyToRun vs JIT in .NET 11: was sollten Sie ausliefern?](/de/2026/05/native-aot-vs-readytorun-vs-jit-in-dotnet-11/) legt harte Benchmark-Zahlen hinter die Abwägungen von Start, Durchsatz und Größe.
- [Wie man Native AOT mit ASP.NET Core Minimal-APIs verwendet](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) ist die Schritt-für-Schritt-Anleitung für den sauberen Build, sobald Sie sich für die Auslieferung entschieden haben.
- [Was ist ein Source Generator und wann brauche ich einen?](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) erklärt die Codegenerierung zur Compile-Zeit, die die von AOT verbotene Reflexion ersetzt.
- [Wie man die Kaltstartzeit einer .NET 11 AWS Lambda reduziert](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) ist das Scale-to-Zero-Szenario, in dem sich der Startgewinn von AOT auszahlt.
- [Fix: PlatformNotSupportedException in Native AOT](/de/2026/05/fix-platformnotsupportedexception-in-native-aot/) deckt den Laufzeitfehler ab, wenn eine AOT-inkompatible API durch einen sauberen Build schlüpft.

## Quellen

- [Übersicht zur Native AOT-Bereitstellung](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/), MS Learn (Voraussetzungen, Einschränkungen, Restriktionen pro RID und Plattform, Verhalten von Einzeldatei und Generics).
- [ASP.NET Core-Unterstützung für Native AOT](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/native-aot/), MS Learn (unterstützte und nicht unterstützte Web-Funktionen).
- [Trimming-Inkompatibilitäten](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/incompatibilities), MS Learn (warum Trimming obligatorisch ist und was es kaputt macht).
- [Conversation about PGO](https://devblogs.microsoft.com/dotnet/conversation-about-pgo/), .NET Blog (Design von Dynamic PGO und warum AOT darauf verzichtet).
