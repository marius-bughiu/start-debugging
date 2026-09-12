---
title: "Lookup<TKey, TElement> vs Dictionary<TKey, List<TValue>> für doppelte Schlüssel in C#"
description: "Verwenden Sie ToLookup, wenn Sie einmal gruppieren und danach nur lesen: Es ist unveränderlich, liefert für fehlende Schlüssel eine leere Sequenz, akzeptiert null-Schlüssel und behält die Reihenfolge des ersten Auftretens bei. Verwenden Sie Dictionary<TKey, List<TValue>>, wenn sich die Gruppen nach der Erstellung ändern oder eine JSON-Grenze überqueren."
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "linq"
  - "collections"
  - "performance"
lang: "de"
translationOf: "2026/09/lookup-vs-dictionary-of-lists-for-duplicate-keys-in-csharp"
translatedBy: "claude"
translationDate: 2026-09-12
---

Wenn ein Schlüssel in C# auf viele Werte abgebildet werden muss, bietet das Framework zwei eingebaute Antworten: `ILookup<TKey, TElement>` (das, was `Enumerable.ToLookup` zurückgibt) und ein selbst gebautes `Dictionary<TKey, List<TValue>>`. **Wählen Sie `ToLookup`, wenn Sie die Gruppierung einmal aus einer vorhandenen Sequenz erstellen und danach nur noch lesen**: Es ist eine Zeile, unveränderlich, liefert für einen fehlenden Schlüssel eine leere Sequenz statt einer Exception, akzeptiert einen `null`-Schlüssel und zählt Gruppen in der Reihenfolge ihres ersten Auftretens auf. **Wählen Sie `Dictionary<TKey, List<TValue>>`, wenn sich Gruppen nach der Erstellung ändern, wenn Sie `TryGetValue` brauchen oder wenn das Ergebnis einen Hin- und Rückweg durch JSON überstehen muss.** Die Performance spricht eher für das Dictionary, aber nicht deutlich genug, um die meisten Fälle zu entscheiden: Unter .NET 11 RC 1 wird ein selbst gebautes Dictionary etwa 30% schneller erstellt als `ToLookup` und liest 3-13% schneller, was bei 100,000 Elementen unter 2 ms liegt. Alles Folgende lief unter .NET 11 RC 1 (Laufzeit `11.0.0-rc.1.26425.128`, C# 15), und das beschriebene Verhalten ist stabil, seit `ToLookup` mit .NET Framework 3.5 eingeführt wurde.

## Die beiden Formen im direkten Vergleich

| Verhalten (.NET 11 RC 1)                    | `ILookup<TKey, TElement>` via `ToLookup` | `Dictionary<TKey, List<TValue>>`        |
| ------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Hinzufügen oder Entfernen nach der Erstellung | nein, unveränderlich                   | ja                                      |
| Indexer bei fehlendem Schlüssel             | leere Sequenz                            | `KeyNotFoundException`                  |
| `null`-Schlüssel                            | erlaubt                                  | `ArgumentNullException`                 |
| Aufzählungsreihenfolge der Gruppen          | Reihenfolge des ersten Auftretens, strukturell garantiert | in der Praxis Einfügereihenfolge, nicht garantiert |
| Reihenfolge der Elemente in einer Gruppe    | Reihenfolge der Quelle                   | die Reihenfolge Ihrer `Add`-Aufrufe     |
| `TryGetValue`                               | nein (`Contains` + Indexer)              | ja                                      |
| Öffentlicher Konstruktor                    | nein                                     | ja                                      |
| `System.Text.Json` serialisieren            | Array von Arrays, Schlüssel gehen verloren | Objekt mit `TKey` als Schlüssel       |
| `System.Text.Json` deserialisieren          | `NotSupportedException`                  | ja                                      |
| 100k Elemente erstellen, 100 Schlüssel      | 660 us, 1.91 MB                          | 477 us, 1.91 MB                         |
| 1,000 Abfragen lesen, 10,000 Schlüssel      | 66.1 us, 29,344 B                        | 61.0 us, 0 B                            |

Die Zeilen, die in den meisten realen Fällen den Ausschlag geben, sind die ersten beiden und die zu JSON. Der Rest sind Details, die Sie später einholen, wenn Sie nach dem falschen Kriterium entschieden haben.

## Was ToLookup tatsächlich erstellt

`Lookup<TKey, TElement>` hat keinen öffentlichen Konstruktor. `Enumerable.ToLookup` ist der einzige Weg, eine Instanz zu bekommen, und der Quellcode in [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) zeigt genau, was Sie zurückbekommen:

- Der Laufzeittyp ist ein internes `CollectionLookup<TKey, TElement>`, eine Unterklasse des öffentlichen `Lookup<TKey, TElement>`, die zusätzlich `ICollection<IGrouping<TKey, TElement>>` implementiert, wobei jedes verändernde Mitglied `NotSupportedException` wirft.
- Es ist eine eigene kleine Hashtabelle: ein Array von `Grouping<TKey, TElement>`-Buckets, auf eine Primzahl dimensioniert und mit `HashHelpers.ExpandPrime` vergrößert, mit Verkettung über ein `_hashNext`-Feld. Es kapselt kein `Dictionary`.
- Jede Gruppe ist zugleich ein Knoten in einer zirkulären verketteten Liste, angehängt, sobald ein neuer Schlüssel auftaucht. Die Aufzählung durchläuft diese Liste, weshalb Gruppen in der Reihenfolge ihres ersten Auftretens zurückkommen. Das ist eine strukturelle Eigenschaft des Typs, kein Zufall des Hash-Layouts.
- Jedes `Grouping` speichert seine Elemente in einem `TElement[]`, das mit Länge 1 beginnt und sich verdoppelt, genau wie `List<T>`, und implementiert `IList<TElement>` schreibgeschützt.
- Ein `null`-Schlüssel wird zu `0` gehasht, statt den Comparer aufzurufen, daher ist `null` ein gültiger Schlüssel.
- Ist die Quelle ein leeres Array, erhalten Sie das gemeinsam genutzte Singleton `EmptyLookup<TKey, TElement>.Instance`, und es wird nichts alloziert.

Daraus ergeben sich zwei Dinge. Erstens ist `ToLookup` **eager**: Es durchläuft sofort die gesamte Quelle, anders als `GroupBy`, das verzögert ausgeführt wird und bei jeder Aufzählung dasselbe interne `Lookup` erneut aufbaut. Zweitens ist `lookup[key].Count()` O(1), weil `Enumerable.Count` die `ICollection<T>`-Implementierung auf `Grouping` erkennt und die Anzahl direkt ausliest.

## Die Verhaltensweisen, die sich tatsächlich unterscheiden

Hier ist ein kleines Programm, das jede Zeile der Tabelle durchspielt. Führen Sie es als Konsolen-App unter .NET 11 aus:

```csharp
// .NET 11 RC 1 (11.0.0-rc.1.26425.128), C# 15
var orders = new List<Order>
{
    new("alice", 1), new("bob", 2), new("alice", 3), new(null, 4), new("carol", 5),
};

var lookup = orders.ToLookup(o => o.Customer);
Console.WriteLine(lookup.GetType());                     // System.Linq.CollectionLookup`2[...]
Console.WriteLine(lookup.Count);                         // 4 (keys, not orders)
Console.WriteLine(lookup["dave"].Count());               // 0, no exception
Console.WriteLine(string.Join(",", lookup[null].Select(o => o.Id)));            // 4
Console.WriteLine(string.Join(",", lookup.Select(g => g.Key ?? "<null>")));     // alice,bob,<null>,carol

try { ((IList<Order>)lookup["alice"]).Add(new("alice", 99)); }
catch (NotSupportedException) { Console.WriteLine("groups are read-only"); }

// Eager vs deferred
var source = new List<Order> { new("x", 1) };
var eager = source.ToLookup(o => o.Customer);
var deferred = source.GroupBy(o => o.Customer);
source.Add(new("x", 2));
Console.WriteLine(eager["x"].Count());       // 1, snapshot taken at ToLookup
Console.WriteLine(deferred.First().Count()); // 2, re-evaluated on enumeration

var map = new Dictionary<string, List<Order>>();
// map["dave"]      -> KeyNotFoundException
// map.Add(null!, []) -> ArgumentNullException

record Order(string? Customer, int Id);
```

Die Zeile zu eager vs. verzögert ist diejenige, die echte Bugs verursacht. Wenn Sie ein `GroupBy`-Ergebnis in einem Feld halten und es zweimal aufzählen, bezahlen Sie die Gruppierung zweimal und sehen jeweils den Zustand, den die Quelle in diesem Moment hat. `ToLookup` erstellt einen Snapshot. Wenn Sie nicht sicher sind, ob eine Sequenz, die Sie erhalten haben, bereits materialisiert wurde, [prüfen Sie das, bevor Sie gruppieren](/de/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/).

`Count` ist die andere Falle: Bei einem Lookup ist es die Anzahl der **Schlüssel**, nicht die Anzahl der Elemente. Für die Gesamtzahl der Elemente brauchen Sie `lookup.Sum(g => g.Count())`.

## Ein Dictionary von Listen ohne doppelten Lookup aufbauen

Wenn Sie den Weg über das Dictionary gehen, hasht das klassische Muster den Schlüssel für jeden neuen Schlüssel zweimal (`TryGetValue`, dann `Add`):

```csharp
// .NET 11 RC 1, C# 15
var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    if (!map.TryGetValue(o.CustomerId, out var list))
    {
        list = new List<Order>();
        map.Add(o.CustomerId, list);
    }
    list.Add(o);
}
```

Seit .NET 6 geht das mit einer einzigen Hash-Abfrage pro Element über [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault), das eine `ref` auf den Wertslot zurückgibt und einen Standardeintrag einfügt, wenn der Schlüssel fehlt:

```csharp
// .NET 11 RC 1, C# 15
using System.Runtime.InteropServices;

var map = new Dictionary<int, List<Order>>();
foreach (var o in orders)
{
    ref var list = ref CollectionsMarshal.GetValueRefOrAddDefault(map, o.CustomerId, out _);
    (list ??= []).Add(o);
}
```

Die Dokumentation enthält eine Regel, die Sie einhalten müssen: Fügen Sie keine Dictionary-Einträge hinzu und entfernen Sie keine, solange Sie diese `ref` halten. In der Schleife oben endet die `ref` vor der nächsten Iteration, daher ist das sicher.

Wenn Sie einen LINQ-Einzeiler bevorzugen, funktioniert `GroupBy(...).ToDictionary(g => g.Key, g => g.ToList())`, alloziert aber die Zwischengruppierungen und kopiert dann jedes Element in eine neue Liste. Und wenn Sie zu `AggregateBy` aus .NET 9 greifen, verwenden Sie die Überladung mit `seedSelector`. Die Überladung mit `seed` übergibt **dieselbe** Instanz an jeden Schlüssel:

```csharp
// .NET 11 RC 1, C# 15
var orders = new[] { new Order("alice", 1), new Order("bob", 2), new Order("alice", 3) };

var broken = orders.AggregateBy(o => o.Customer, seed: new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,2,3   bob: 1,2,3   <- one shared List

var correct = orders.AggregateBy(o => o.Customer, seedSelector: _ => new List<int>(),
    (acc, o) => { acc.Add(o.Id); return acc; });
// alice: 1,3     bob: 2
```

`AggregateBy` und sein Geschwister `CountBy` sind hervorragend, wenn Sie ein einzelnes Aggregat pro Schlüssel wollen; den Zählfall habe ich in [Häufigkeitszählung mit LINQ CountBy](/de/2026/01/optimizing-frequency-counting-with-linq-countby/) behandelt. Für "alle Werte pro Schlüssel" sind sie das falsche Werkzeug.

## Der Benchmark

BenchmarkDotNet 0.15.8 kann den Moniker `net11.0` noch nicht auflösen (es wirft `NotImplementedException` aus `GetRuntimeVersion`), daher liefen diese Messungen mit `--inProcess` unter .NET 11 RC 1, Arm64 RyuJIT, auf einem Apple M4 (10 Kerne, 16 GB) unter macOS 26.6. Die Quelle sind 100,000 `Order`-Records mit einem `int` `CustomerId` als Schlüssel, mit entweder 100 oder 10,000 verschiedenen Schlüsseln. Der Lese-Benchmark fragt 1,000 zufällige Schlüssel ab, von denen 10% fehlen, und summiert ein `decimal`-Feld über jede Gruppe.

Aufbau der Gruppierung aus 100,000 Bestellungen:

| Methode (.NET 11 RC 1)                         | Schlüssel | Mean     | Ratio | Allocated |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `ToLookup`                                     | 100    | 660.1 us | 1.00  | 1.91 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 100    | 883.0 us | 1.34  | 2.69 MB   |
| `TryGetValue` + `Add`-Schleife                 | 100    | 476.7 us | 0.72  | 1.91 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 100    | 485.8 us | 0.74  | 1.91 MB   |
| `ToLookup`                                     | 10,000 | 5,934 us | 1.00  | 3.86 MB   |
| `GroupBy(...).ToDictionary(g => g.ToList())`   | 10,000 | 7,537 us | 1.27  | 6.06 MB   |
| `TryGetValue` + `Add`-Schleife                 | 10,000 | 4,070 us | 0.69  | 3.59 MB   |
| `CollectionsMarshal.GetValueRefOrAddDefault`   | 10,000 | 4,384 us | 0.74  | 3.59 MB   |

Lesen von 1,000 zufälligen Schlüsseln und Summieren jeder Gruppe:

| Methode (.NET 11 RC 1)                         | Schlüssel | Mean     | Ratio | Allocated |
| ---------------------------------------------- | ------ | -------: | ----: | --------: |
| `foreach (var o in lookup[k])`                 | 100    | 3,736 us | 1.00  | 29,344 B  |
| `TryGetValue` + `foreach` über `List<T>`       | 100    | 3,617 us | 0.97  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 100    | 3,299 us | 0.88  | 0 B       |
| `foreach (var o in lookup[k])`                 | 10,000 | 66.1 us  | 1.00  | 29,344 B  |
| `TryGetValue` + `foreach` über `List<T>`       | 10,000 | 61.0 us  | 0.92  | 0 B       |
| `TryGetValue` + `CollectionsMarshal.AsSpan`    | 10,000 | 57.8 us  | 0.87  | 0 B       |

Einige Dinge fallen auf.

**Der Aufbau des Lookups ist etwa 1.4x langsamer als eine einfache Schleife, bei identischen Allokationen.** Beide landen bei 100 Schlüsseln bei 1.91 MB, der Unterschied liegt also in der Arbeit pro Element, nicht im Speicher. `ToLookup` ruft für jedes Element den `keySelector`-Delegate auf und ruft `IEqualityComparer<TKey>.GetHashCode` und `Equals` über das Interface auf. `Dictionary<TKey, TValue>` behandelt Werttyp-Schlüssel ohne eigenen Comparer gesondert und ruft `EqualityComparer<TKey>.Default` direkt auf, was der JIT devirtualisiert und inlined. Mit `string`-Schlüsseln schrumpft dieser Vorteil, weil auch das Dictionary über ein Comparer-Objekt geht.

**`GroupBy(...).ToDictionary(...)` vereint das Schlechteste beider Welten.** Es baut dasselbe interne Lookup auf, das `ToLookup` baut, und kopiert dann jede Gruppe in eine frische `List<T>`: 27-34% langsamer als `ToLookup` und bis zu 57% mehr Speicher. Wenn Sie ein Dictionary wollen, schreiben Sie die Schleife.

**`CollectionsMarshal` hat `TryGetValue` hier nicht geschlagen.** Das doppelte Hashing passiert nur, wenn ein Schlüssel zum ersten Mal auftaucht, also 100 bzw. 10,000 Mal bei 100,000 Elementen. Die Variante mit einer einzigen Abfrage zahlt sich aus, wenn die meisten Elemente einen neuen Schlüssel einführen, und sie ist nie in relevantem Maß langsamer, daher bleibt sie mein Standard für die Schleife.

**Jeder Lesezugriff auf das Lookup alloziert.** Der Indexer gibt `IEnumerable<TElement>` zurück, und `Grouping.GetEnumerator` liefert einen auf dem Heap allozierten `PartialArrayEnumerator<TElement>`: 29,344 Bytes für rund 917 Treffer, 32 Bytes pro Treffer. `List<T>` hat einen Struct-Enumerator, den `foreach` ohne Boxing nutzt, und `CollectionsMarshal.AsSpan` entfernt den Enumerator vollständig und holt weitere 5-9% heraus. Bei 100 Schlüsseln wird das Lesen vom Summieren von etwa 1,000 `decimal`-Werten pro Gruppe dominiert, weshalb sich die Verhältnisse annähern.

Das ehrliche Fazit lautet, dass keine dieser Zahlen den Typ für Sie auswählen sollte. Wenn eine Gruppierung auf einem Pfad liegt, der heiß genug ist, dass ein Leseunterschied von 10% und 32 Bytes pro Abfrage ins Gewicht fallen, sind Sie vermutlich besser mit einem einmal über Arrays aufgebauten [`FrozenDictionary`](/de/2024/04/net-8-performance-dictionary-vs-frozendictionary/) bedient, oder damit, über Spans statt über `IEnumerable<T>` zu iterieren. Das ist derselbe Zielkonflikt, den ich in [List vs Span vs ReadOnlySpan](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) durchgegangen bin.

## Fallstricke, die die Entscheidung für Sie treffen

**Ein `Dictionary<TKey, List<TValue>>` lässt sich nicht kostenlos als schreibgeschützte Multimap bereitstellen.** `IReadOnlyDictionary<TKey, TValue>` ist in `TValue` invariant, daher kompiliert Folgendes nicht:

```csharp
// .NET 11 RC 1, C# 15
Dictionary<string, List<int>> map = new() { ["a"] = [1] };
IReadOnlyDictionary<string, IReadOnlyList<int>> ro = map;
// error CS0266: Cannot implicitly convert type 'Dictionary<string, List<int>>'
// to 'IReadOnlyDictionary<string, IReadOnlyList<int>>'
```

Der explizite Cast, den der Compiler vorschlägt, wirft zur Laufzeit `InvalidCastException`. Ihre Optionen: das Dictionary von Anfang an als `Dictionary<string, IReadOnlyList<int>>` deklarieren (und `Add` auf den Werten ohne Cast verlieren), es kopieren oder ein `ILookup` zurückgeben, das per Konstruktion schreibgeschützt ist. Wenn "Aufrufer dürfen das nicht verändern" eine Anforderung ist, ist das allein schon ein guter Grund für das Lookup.

**`ILookup` übersteht JSON nicht.** `System.Text.Json` serialisiert es als `IEnumerable<IGrouping<...>>`, Sie erhalten also `[[{...},{...}],[{...}]]` ohne die Schlüssel, und die Deserialisierung in `ILookup<TKey, TElement>` wirft `NotSupportedException`, weil das Interface nicht instanziiert werden kann. Ein `Dictionary<string, List<T>>` wird als `{"alice":[...],"bob":[...]}` serialisiert und übersteht den Hin- und Rückweg. Für API-Antworten und zwischengespeicherte Payloads konvertieren Sie an der Grenze mit `lookup.ToDictionary(g => g.Key, g => g.ToList())` oder bauen gleich von Anfang an das Dictionary.

**Auf `ILookup` gibt es kein `TryGetValue`.** `if (lookup.Contains(k)) use(lookup[k]);` hasht den Schlüssel zweimal. Da ein fehlender Schlüssel ohnehin eine leere Sequenz liefert, rufen Sie einfach den Indexer auf und lassen den leeren Fall durchlaufen. Verwenden Sie `Contains` nur, wenn "keine Werte" und "Schlüssel fehlt" unterschiedlich behandelt werden müssen, was bei einem Lookup nie der Fall ist (ein Schlüssel kann nicht mit null Elementen existieren).

**Der Comparer wird bei der Erstellung festgelegt.** Beide Typen nehmen einen `IEqualityComparer<TKey>` entgegen. Für String-Schlüssel übergeben Sie `StringComparer.OrdinalIgnoreCase` an `ToLookup` oder an den Dictionary-Konstruktor; nachträglich ändern lässt er sich bei keinem der beiden Typen.

**Die Aufzählungsreihenfolge eines Dictionary ist ein Implementierungsdetail.** Ein `Dictionary`, das nur Hinzufügungen gesehen hat, zählt zufällig in Einfügereihenfolge auf, aber die Dokumentation sagt, dass die Reihenfolge undefiniert ist, und ein einziges `Remove` gefolgt von einem `Add` verwendet den freigewordenen Slot wieder: Unter .NET 11 RC 1 werden die Schlüssel `a, b, c` nach `Remove("a")` und `Add("d")` als `d, b, c` aufgezählt. Wenn Sie Gruppen in der Reihenfolge ihres ersten Auftretens darstellen, gibt Ihnen das Lookup diese Garantie strukturell.

**Keiner der beiden Typen ist für Schreiber threadsicher.** Lookups sind unveränderlich, gleichzeitige Lesezugriffe sind also unproblematisch. Ein Dictionary von Listen braucht einen Lock um das Dictionary und um jede Liste, und `ConcurrentDictionary<TKey, List<T>>` löst das nicht, weil die Listen darin weiterhin einfache `List<T>` sind. Wenn Sie gleichzeitig anhängen müssen, verwenden Sie `ConcurrentDictionary<TKey, ConcurrentQueue<T>>` oder eine unveränderliche Collection, die atomar ausgetauscht wird.

**Ein `MultiValueDictionary` gibt es nicht von Haus aus.** Microsoft hat 2014 einen Prototyp in `Microsoft.Experimental.Collections` erstellt, der aber nie in die Laufzeit übernommen wurde, und das corefxlab-Repository ist inzwischen archiviert. Für eine veränderliche Multimap ist das Dictionary von Listen weiterhin die Standardantwort.

## Wozu Sie greifen sollten

Greifen Sie standardmäßig zu `ToLookup`, wann immer die Gruppierung ein schreibgeschützter Index über Daten ist, die Sie bereits haben: zwei In-Memory-Mengen verknüpfen, Zeilen für einen Bericht in Buckets einteilen, Kinder nach Elternknoten für einen Baum vorab berechnen. Es ist kürzer, kann nicht hinter Ihrem Rücken verändert werden, und das Verhalten bei fehlenden Schlüsseln und Null-Schlüsseln erspart eine ganze Klasse defensiven Codes. Wechseln Sie zu `Dictionary<TKey, List<TValue>>`, aufgebaut mit `CollectionsMarshal.GetValueRefOrAddDefault`, wenn sich die Gruppen während der Lebensdauer des Objekts ändern, wenn Sie das Ergebnis serialisieren oder wenn Sie die eine heiße Schleife schreiben, in der Sie gemessen haben, dass der Leseunterschied zählt. Wenn Sie schwanken, ob die Methode, die diese Gruppen zurückgibt, `IEnumerable<T>` oder etwas Reichhaltigeres bereitstellen soll, gilt dieselbe Überlegung wie in [IEnumerable vs IAsyncEnumerable vs IQueryable](/de/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/): Geben Sie den engsten Typ zurück, der Aufrufer ehrlich hält, und das ist für eine fertige Gruppierung `ILookup`.

### Verwandte Artikel

- [Wie Sie erkennen, ob ein IEnumerable in C# bereits materialisiert wurde](/de/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [Häufigkeitszählung mit LINQ CountBy optimieren](/de/2026/01/optimizing-frequency-counting-with-linq-countby/)
- [Dictionary vs FrozenDictionary in .NET 8](/de/2024/04/net-8-performance-dictionary-vs-frozendictionary/)
- [List vs Span vs ReadOnlySpan in C#](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/de/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)

### Quellen

- [`Lookup<TKey, TElement>`-Klasse](https://learn.microsoft.com/en-us/dotnet/api/system.linq.lookup-2), MS Learn
- [`Enumerable.ToLookup`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.tolookup), MS Learn
- [`CollectionsMarshal.GetValueRefOrAddDefault`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.getvaluereforadddefault), MS Learn
- [`Enumerable.AggregateBy`](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.aggregateby), MS Learn
- [`Lookup.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Lookup.cs) und [`Grouping.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Linq/src/System/Linq/Grouping.cs) am Tag `v11.0.0-rc.1.26425.128`, dotnet/runtime
- [MultiDictionary becomes MultiValueDictionary](https://devblogs.microsoft.com/dotnet/multidictionary-becomes-multivaluedictionary/), .NET Blog
- [Release the Microsoft.Experimental.Collections.MultiValueDictionary](https://github.com/dotnet/runtime/issues/14406), dotnet/runtime-Issue
