---
title: "AutoMapper vs Mapperly vs handgeschriebenes Mapping in 2026"
description: "Mapperly ist die Standardwahl für neuen .NET-Code: gleiche Geschwindigkeit wie handgeschriebenes Mapping, funktioniert unter Native AOT und meldet nicht gemappte Member zur Compile-Zeit. AutoMapper gewinnt weiterhin bei ProjectTo. Mit Benchmarks und Lizenzschwellen."
pubDate: 2026-08-31
template: vs
tags:
  - "comparison"
  - "automapper"
  - "mapperly"
  - "source-generators"
  - "dotnet"
  - "performance"
lang: "de"
translationOf: "2026/08/automapper-vs-mapperly-vs-hand-written-mapping-in-2026"
translatedBy: "claude"
translationDate: 2026-08-31
---

Für neuen .NET-Code in 2026 sollten Sie **Mapperly** verwenden. Es erzeugt einfaches C# zur Compile-Zeit, liegt innerhalb von 3% des handgeschriebenen Mappings, veröffentlicht sauber unter Native AOT und macht aus einer vergessenen Eigenschaft eine Compiler-Diagnose statt eines stillen leeren Strings. Schreiben Sie das Mapping **von Hand**, wenn ein Projekt weniger als etwa zwanzig Maps hat oder Quell- und Zielstruktur wirklich auseinandergehen. Bleiben Sie bei **AutoMapper** nur dann, wenn `ProjectTo` in einer großen EF-Core-Codebasis tragend ist und Sie sich für die kostenlose Community-Stufe qualifizieren, denn oberhalb von 5.000.000 USD Jahresumsatz macht die Lizenz aus der Entscheidung eine Bestellung.

Alle Zahlen unten wurden auf einem Apple M4 (10 Kerne) mit .NET SDK 10.0.302 und Zielframework `net10.0` gemessen, mit AutoMapper 16.2.0 (veröffentlicht am 2026-07-02), Riok.Mapperly 4.3.1 (veröffentlicht am 2025-12-22) und BenchmarkDotNet 0.15.8.

## Die Matrix

| | AutoMapper 16.2.0 | Mapperly 4.3.1 | Handgeschrieben |
| --- | --- | --- | --- |
| Lizenz | RPL-1.5 Copyleft oder kommerziell kostenpflichtig | Apache 2.0 | keine |
| Kosten oberhalb 5.000.000 USD Umsatz | 799 bis 6.399 USD pro Jahr | kostenlos | kostenlos |
| Wie das Mapping entsteht | Reflection plus kompilierte Expression Trees beim ersten Aufruf | Roslyn Source Generator zur Compile-Zeit | Sie |
| Nicht gemappter Ziel-Member | still, nur `AssertConfigurationIsValid()` findet ihn | Warnung `RMG012`, zu Fehler eskalierbar | der Compiler sagt ebenfalls nichts |
| Nicht gemappter Quell-Member | wird gar nicht gemeldet | Warnung `RMG020` | wird nicht gemeldet |
| Native-AOT-Veröffentlichung | `IL2104` plus `IL3053`, stürzt beim Start ab | null Warnungen, läuft | null Warnungen, läuft |
| Kaltkosten des ersten Mappings | ~33 ms für 3 Maps | ~1 ms | 0 |
| Mapping eines Objekts | 105.79 ns | 60.44 ns | 58.48 ns |
| EF-Core-Projektion | `ProjectTo` mit expliziter Erweiterung, Parametern und Rekursionstiefe | generierte `IQueryable`-Projektion, mehrere Funktionen fehlen | schreiben Sie das `Select` |
| `Map(object, type)` zur Laufzeit | ja | nein | nein |
| Debugbare Ausgabe | kompilierter Expression Tree | lesbare `.g.cs`, in die Sie hineinspringen können | Ihr eigener Code |

## Die Lizenz ist die Achse, an der alles andere hängt

Am 2025-07-02 übertrug Jimmy Bogard AutoMapper und MediatR an Lucky Penny Software und lizenzierte beide neu. AutoMapper 15.0.0 und höher erscheinen unter einem dualen Modell: der [Reciprocal Public License 1.5](https://github.com/LuckyPennySoftware/AutoMapper/blob/main/LICENSE.md) für Open-Source-Nutzung oder einer kostenpflichtigen kommerziellen Lizenz. Version 14.x und älter bleiben dauerhaft unter MIT.

RPL-1.5 ist nicht MIT mit Zusatzschritten. Es ist ein starkes reziprokes Copyleft, das auch bereitgestellte Software erfasst, nicht nur verteilte, deshalb können kommerzielle Closed-Source-Produkte realistisch nicht auf dem RPL-Build ausliefern. Damit bleibt der kommerzielle Vertrag, dessen kostenlose Community-Stufe Organisationen mit weniger als 5.000.000 USD Bruttojahresumsatz abdeckt, die zusätzlich weniger als 10.000.000 USD Fremdkapital aufgenommen haben und keine staatlichen, halbstaatlichen oder Hochschuleinrichtungen sind. Oberhalb dieser Grenze gelten die [veröffentlichten Stufen](https://automapper.io/): Standard für 799 USD pro Jahr bei 1 bis 10 Entwicklern, Professional für 1.499 USD pro Jahr bei 11 bis 50 und Enterprise für 6.399 USD pro Jahr bei unbegrenzt vielen Entwicklern. Gezählt werden nur Entwickler, die aktiv Code schreiben oder pflegen, der die Bibliothek aufruft, also ohne QA, Design und Frontend-Arbeit.

Die Durchsetzung ist bewusst weich. Es gibt keinen Lizenzserver, keinen Netzwerkaufruf und keine Funktionssperre. Ein fehlender oder abgelaufener Schlüssel erzeugt eine Log-Meldung und sonst nichts, und seit 16.2.0 kann der Schlüssel statt über `cfg.LicenseKey` auch aus den Umgebungsvariablen `AUTOMAPPER_LICENSE_KEY` oder `LUCKYPENNY_LICENSE_KEY` kommen. Weiche Durchsetzung ist aber nicht dasselbe wie Erlaubnis, und "uns ist keine Warnung in den Logs aufgefallen" ist keine Lizenzposition, die jemand in einer Beschaffungsprüfung verteidigen möchte.

Das ist dieselbe Weggabelung wie bei den Mediator-Bibliotheken, und die Argumentation überträgt sich direkt: siehe [MediatR vs einfache Service-Klassen in 2026](/de/2026/05/mediatr-vs-plain-service-classes-in-2026/) für die vollständige Aufschlüsselung der Community-Stufe und der RPL-1.5-Pflichten.

## Wann Sie Mapperly wählen sollten

- **Alles, was mit Trimming oder Native AOT veröffentlicht wird.** Das ist keine Präferenz, sondern eine harte Schranke. Siehe den AOT-Abschnitt weiter unten.
- **Serverless und kurzlebige Prozesse.** Mapperly kostet beim Start nichts, weil es kein Konfigurationsobjekt zu bauen gibt.
- **Codebasen, in denen DTO-Drift ein echtes Risiko ist.** Eine neue Spalte in der Entität, die niemand ins DTO übernommen hat, erzeugt `RMG020` zur Compile-Zeit. AutoMapper erwähnt das überhaupt nicht.
- **Teams, die das Mapping lesen wollen.** Mapperly schreibt eine `.g.cs`-Datei, die Sie öffnen, vergleichen und im Debugger durchlaufen können.

## Wann Sie von Hand mappen sollten

- **Kleine Oberfläche.** Unter etwa zwanzig Maps ist eine statische `ToDto`-Methode pro Typ weniger Maschinerie als ein Generator samt seinem Attributvokabular, und sie überrascht niemanden.
- **Strukturen, die sich wirklich unterscheiden.** Wenn die meisten Member `MapFrom`, `IValueResolver` oder bedingte Logik brauchen, degenerieren beide Bibliotheken zu einer schlechteren Schreibweise der Methode, die Sie ohnehin geschrieben hätten.
- **Öffentliche API-Verträge.** DTOs, die ein versioniertes Übertragungsformat sind, verdienen ein explizites, prüfbares Mapping, bei dem jede Feldzuweisung im Diff auftaucht.
- **Jede Schicht, in der Sie null Build-Abhängigkeiten wollen.** Mapperly ist ein Source Generator und nimmt damit an Ihrem Build teil; eine statische Methode nicht.

## Wann Sie bei AutoMapper bleiben sollten

- **Eine große EF-Core-Codebasis, die auf `ProjectTo` aufbaut.** Die Queryable-Erweiterungen von AutoMapper unterstützen explizite Erweiterung, Parametrisierung zur Laufzeit über anonyme Objekte, `RecursiveQueriesMaxDepth` für selbstreferenzierende Modelle und polymorphes Mapping. Die Projektionen von Mapperly decken den Normalfall ab, unterstützen aber ausdrücklich keine Object Factories, keine `ByName`-Enum-Strategien, kein Reference Handling und kein Deep Cloning, und melden `RMG068`, wenn eine benutzerdefinierte Methode nicht inline gesetzt werden kann.
- **Sie liegen unter der Community-Schwelle und die Maps funktionieren bereits.** 200 funktionierende Maps umzuschreiben, um 45 ns pro Aufruf zu sparen, ist kein Geschäftsfall.
- **Dynamisches, untypisiertes Mapping.** `mapper.Map(source, sourceType, destType)` hat kein quellgeneriertes Äquivalent. Wenn Sie ein Plugin-System haben, das Typen zur Laufzeit ermittelt, leistet AutoMapper etwas, das Mapperly strukturell nicht kann.

Wenn Sie sich für den Wechsel entscheiden, ist das Vorgehen Schritt für Schritt beschrieben in [von AutoMapper zu quellgeneriertem Mapping mit Mapperly migrieren](/de/2026/05/migrate-from-automapper-to-source-generated-mapping/).

## Der Benchmark

Das Modell ist ein `Order` mit fünf skalaren Membern, einem verschachtelten `Customer`, fünf `OrderLine`-Kindern und einem Enum, das auf seinen Textnamen gemappt wird. `[MemoryDiagnoser]`, Standard-Job, und die Expression-Kompilierung von AutoMapper wird im `[GlobalSetup]` vorgewärmt, damit die Messung den Dauerbetrieb abbildet und nicht die Kosten des ersten Aufrufs.

```csharp
// .NET SDK 10.0.302, net10.0, C# 14
// AutoMapper 16.2.0, Riok.Mapperly 4.3.1, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
public class MappingBenchmarks
{
    private Order _order = null!;
    private List<Order> _orders = null!;
    private IMapper _autoMapper = null!;
    private OrderMapper _mapperly = null!;

    [GlobalSetup]
    public void Setup()
    {
        _order = MakeOrder(1);
        _orders = Enumerable.Range(1, 1000).Select(MakeOrder).ToList();

        var config = new MapperConfiguration(
            cfg => cfg.AddProfile<OrderProfile>(),
            NullLoggerFactory.Instance);
        _autoMapper = config.CreateMapper();
        _mapperly = new OrderMapper();

        _autoMapper.Map<OrderDto>(_order); // warm the expression compilation
    }

    [Benchmark(Baseline = true)]
    public OrderDto HandWritten_Single() => HandMapper.ToDto(_order);

    [Benchmark]
    public OrderDto Mapperly_Single() => _mapperly.ToDto(_order);

    [Benchmark]
    public OrderDto AutoMapper_Single() => _autoMapper.Map<OrderDto>(_order);
}
```

Ergebnisse auf einem Apple M4, 10 physische Kerne, .NET 10.0.10 Arm64 RyuJIT:

| Methode | Mittelwert | Ratio | Allokiert | Allokationsverhältnis |
| --- | ---: | ---: | ---: | ---: |
| HandWritten_Single | 58.48 ns | 1.00 | 624 B | 1.00 |
| Mapperly_Single | 60.44 ns | 1.03 | 624 B | 1.00 |
| AutoMapper_Single | 105.79 ns | 1.81 | 704 B | 1.13 |
| HandWritten_1000 | 72,696 ns | 1.00 | 632,091 B | 1.00 |
| Mapperly_1000 | 77,334 ns | 1.06 | 672,093 B | 1.06 |
| AutoMapper_1000 | 103,376 ns | 1.42 | 720,640 B | 1.14 |

Lesen Sie das ehrlich: 45 Nanosekunden pro Objekt sind nicht der Grund zu wechseln. Bei einem Request, der 1.000 Bestellungen mappt, beträgt der gesamte Unterschied 31 Mikrosekunden, was neben einem einzigen Datenbank-Roundtrip nicht auffällt. Das Performance-Argument trägt erst bei sehr hohen Objektzahlen und ist der schwächste der drei Gründe für Mapperly.

Die Lücke von 40.000 Byte zwischen Mapperly und handgeschriebenem Code im Fall mit 1.000 Objekten ist ein realer Effekt, den man verstehen sollte. Mapperly weitet den Parameter eines generierten Mappers für verschachtelte Sammlungen auf `IReadOnlyCollection<T>` auf:

```csharp
// Riok.Mapperly 4.3.1 generated output, trimmed
private List<OrderLineDto> MapToListOfOrderLineDto(IReadOnlyCollection<OrderLine> source)
{
    var target = new List<OrderLineDto>(source.Count);
    foreach (var item in source)
        target.Add(MapToOrderLineDto(item));
    return target;
}
```

Das Durchlaufen einer `List<T>` über ein Interface boxt deren Struct-Enumerator: 40 Byte pro Bestellung, 40.000 Byte über den gesamten Stapel. Deklarieren Sie den Mapper für die verschachtelte Sammlung selbst mit einem konkreten `List<OrderLine>`-Parameter, verschwindet das. Genau solche Dinge lassen sich finden und beheben, weil der generierte Code auf der Festplatte liegt, und das ist der praktische Unterschied zwischen einem Source Generator und einem kompilierten Expression Tree.

## Der Punkt, der die Entscheidung abnimmt: Native AOT

Veröffentlichen Sie eine Konsolenanwendung, die AutoMapper 16.2.0 aufruft, mit `<PublishAot>true</PublishAot>` unter `net10.0`, und der Build warnt:

```text
AutoMapper.dll : warning IL2104: Assembly 'AutoMapper' produced trim warnings.
AutoMapper.dll : warning IL3053: Assembly 'AutoMapper' produced AOT analysis warnings.
```

Warnungen lassen sich leicht ignorieren. Die entstehende Binärdatei nicht:

```text
Unhandled exception. System.TypeInitializationException: A type initializer threw an exception.
 ---> System.ArgumentNullException: Value cannot be null. (Parameter 'method')
   at System.Linq.Expressions.Expression.Call(MethodInfo, Expression)
   at AutoMapper.Execution.ExpressionBuilder..cctor()
   at AutoMapper.MapperConfiguration..ctor(MapperConfigurationExpression, ILoggerFactory)
```

Der Trimmer hat eine Methode entfernt, die `ExpressionBuilder` per Reflection sucht, deshalb stirbt der statische Konstruktor vor Ihrem ersten Mapping. Die entsprechende Mapperly-Anwendung mit denselben Einstellungen erzeugt null IL-Warnungen, liefert eine native Binärdatei von 1.1 MB und läuft. Das ist kein Feinschliffproblem, das sich mit `DynamicDependency`-Attributen an der Aufrufstelle lösen lässt; es ist eine Eigenschaft davon, Maps zur Laufzeit aus Expression Trees zu bauen, also dieselbe Falle wie in [was ist trim-sicherer Code und wie schreibe ich ihn](/de/2026/07/what-is-trim-safe-code-and-how-do-i-write-it/) beschrieben. Wenn Native AOT auf Ihrer Roadmap steht, ist die Entscheidung bereits gefallen.

Die mildere Variante desselben Effekts ist der Kaltstart. Die Konfiguration aufzubauen und das erste Mapping für drei Typen auszuführen, dauerte auf dieser Maschine 33 Millisekunden, gegenüber 1 Millisekunde für `new OrderMapper()` plus dessen ersten Aufruf. In einer langlebigen Webanwendung ist das unsichtbar. In einer Lambda ist es ein messbarer Anteil eines kalten Aufrufs, weshalb es in [die Kaltstartzeit einer .NET-Lambda auf AWS reduzieren](/de/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) auftaucht.

## Wo der Sicherheitsunterschied tatsächlich sichtbar wird

Fügen Sie einem DTO eine `Slug`-Eigenschaft hinzu und vergessen Sie, sie zu mappen. AutoMapper 16.2.0 mappt das Objekt trotzdem:

```text
map ok: Id=1 Name=n Slug=''
```

`AssertConfigurationIsValid()` findet es zwar und wirft `AutoMapperConfigurationException` mit "Unmapped members were found", aber nur wenn Sie daran gedacht haben, es aufzurufen, und nur für nicht gemappte *Ziel*-Member. Eine Quell-Eigenschaft, die kein DTO mehr erreicht, wird überhaupt nicht gemeldet.

Mapperly meldet beide Richtungen zur Compile-Zeit, mit dem tatsächlichen Meldungstext:

```text
warning RMG020: The member InternalNote on the mapping source type Diag.Source
                is not mapped to any member on the mapping target type Diag.Target
warning RMG012: The member Slug on the mapping target type Diag.Target
                was not found on the mapping source type Diag.Source
```

Standardmäßig sind das Warnungen, die in einem lauten Build untergehen. Eskalieren Sie sie in der `.editorconfig`, und der Build scheitert vollständig:

```ini
[*.cs]
dotnet_diagnostic.RMG012.severity = error
dotnet_diagnostic.RMG020.severity = error
```

Diese Einstellung macht aus Mapperly statt "einem schnelleren AutoMapper" eine andere Werkzeugkategorie: Mapping-Fehler sind keine Produktionsvorfälle mehr, sondern Build-Fehler. Sie ist zugleich die klarste Illustration dafür, warum [Source Generators](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/) die Build-Abhängigkeit wert sind.

Handgeschriebenes Mapping bietet, der Vollständigkeit halber, keine solche Prüfung. Eine vergessene Zuweisung in einer `ToDto`-Methode ist genauso still wie bei AutoMapper. Ihre Sicherheit kommt aus der Sichtbarkeit im Code-Review, nicht aus Werkzeugen.

## Die Entscheidung

Nehmen Sie für neuen Code standardmäßig Mapperly und eskalieren Sie `RMG012` und `RMG020` vom ersten Tag an zu Fehlern, damit der Nutzen wirklich eintritt. Schreiben Sie von Hand, wenn das Projekt klein oder die Strukturen unregelmäßig sind, und akzeptieren Sie, dass Sie Werkzeugprüfungen gegen Prüfbarkeit tauschen. Bleiben Sie bei AutoMapper, wenn eine reife, `ProjectTo`-lastige Codebasis bereits funktioniert, Sie unter der Community-Schwelle liegen und Native AOT nicht auf der Roadmap steht; sobald eine dieser drei Bedingungen entfällt, starten Sie die Migration, statt die Lizenz einzuplanen. Die Performance-Tabelle ist der uninteressanteste Teil dieses Vergleichs. Trim-Sicherheit und Diagnosen zur Compile-Zeit sind das, was das Verhalten einer Codebasis wirklich verändert.

## Verwandte Artikel

- [Von AutoMapper zu quellgeneriertem Mapping mit Mapperly migrieren](/de/2026/05/migrate-from-automapper-to-source-generated-mapping/)
- [Lösung: 'MapperConfiguration' enthält keinen Konstruktor, der 1 Argumente akzeptiert](/de/2026/08/fix-mapperconfiguration-does-not-contain-a-constructor-that-takes-1-arguments/)
- [MediatR vs einfache Service-Klassen in 2026](/de/2026/05/mediatr-vs-plain-service-classes-in-2026/)
- [Was ist ein Source Generator und wann brauche ich einen?](/de/2026/06/what-is-a-source-generator-and-when-do-i-need-one/)
- [Was ist Native AOT und was kostet es Sie?](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/)

## Quellen

- [Licensing FAQ - Lucky Penny Software](https://luckypennysoftware.com/faq) - die Grenze bei 15.0.0, die Community-Schwellen von 5.000.000 USD Umsatz und 10.000.000 USD Kapital sowie die Zählweise der Entwickler.
- [AutoMapper LICENSE.md](https://github.com/LuckyPennySoftware/AutoMapper/blob/main/LICENSE.md) - der Text der dualen RPL-1.5- oder kommerziellen Lizenz.
- [AutoMapper-Dokumentation zur Lizenzkonfiguration](https://docs.automapper.io/en/latest/License-configuration.html) - die Erkennung von `AUTOMAPPER_LICENSE_KEY` und `LUCKYPENNY_LICENSE_KEY` sowie das rein protokollierende Durchsetzungsmodell.
- [AutoMapper Queryable Extensions](https://docs.automapper.io/en/latest/Queryable-Extensions.html) - explizite Erweiterung bei `ProjectTo`, Parametrisierung und die Einschränkung "muss der letzte Aufruf in der Kette sein".
- [Mapperly Queryable Projections](https://mapperly.riok.app/docs/configuration/queryable-projections/) - die Liste nicht unterstützter Funktionen und die Inlining-Diagnose `RMG068`.
- [Mapperly Analyzer Diagnostics](https://mapperly.riok.app/docs/configuration/analyzer-diagnostics/) - `RMG012`, `RMG020` und die Schweregrad-Eskalation in der `.editorconfig`.
- [Riok.Mapperly auf NuGet](https://www.nuget.org/packages/Riok.Mapperly) - Veröffentlichungsdatum von 4.3.1 und Apache-2.0-Lizenz.
- [AutoMapper auf NuGet](https://www.nuget.org/packages/AutoMapper) - Veröffentlichungsdatum von 16.2.0 und Versionsverlauf.
