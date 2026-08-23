---
title: "Wie Sie feststellen, ob ein IEnumerable<T> in C# bereits materialisiert wurde"
description: "Es gibt kein HasBeenEnumerated-Flag auf IEnumerable<T>. Hier steht, was TryGetNonEnumeratedCount tatsächlich prüft, warum Enumerable.Range einen ICollection<T>-Test besteht und welche Guard-Klausel ein überflüssiges ToList() vermeidet."
pubDate: 2026-08-23
tags:
  - "csharp"
  - "linq"
  - "dotnet"
  - "performance"
lang: "de"
translationOf: "2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp"
translatedBy: "claude"
translationDate: 2026-08-23
---

Es gibt in .NET keine API, die beantwortet, ob ein `IEnumerable<T>` bereits enumeriert wurde, und keine, die beantwortet, ob eine Sequenz im Speicher liegt. Die Schnittstelle hat genau ein Mitglied, `GetEnumerator()`, und nichts im Vertrag verlangt von einer Implementierung, sich den Aufruf zu merken. Was Sie tatsächlich bekommen, ist `Enumerable.TryGetNonEnumeratedCount` (.NET 6 und höher), das Ihnen sagt, ob die *Anzahl* günstig zu ermitteln ist, plus eine Reihe von Typprüfungen, die Sie selbst durchführen können. Diese beiden Signale überschneiden sich mit "bereits materialisiert", sind aber nicht dasselbe, und genau in diesen Lücken leben die Fehler. Alles Folgende wurde auf .NET 10.0.201 mit C# 14 gemessen.

## Warum die Frage keine direkte Antwort hat

`IEnumerable<T>` ist eine Fabrik für Enumeratoren, kein Container. `GetEnumerator()` zweimal aufzurufen ist zulässig, und jeder Aufruf darf einen frischen, unabhängigen Durchlauf über die Daten liefern. Eine `List<int>` gibt Ihnen einen Struct-Enumerator über ein bestehendes Array. Eine Methode mit `yield return` baut eine Zustandsmaschine, die Ihren Methodenrumpf von vorn ausführt. Ein `DbSet<T>` öffnet eine Verbindung und setzt SQL ab. Alle drei erfüllen dieselbe Schnittstelle, und nur die erste hält die Elemente im Speicher.

"Wurde es materialisiert?" zerfällt also in drei getrennte Fragen, die häufig vermischt werden:

1. Liegen die Elemente bereits im Speicher, sodass ein zweiter Durchlauf kostenlos ist?
2. Ist die Anzahl verfügbar, ohne die Sequenz zu durchlaufen?
3. Wurde *dieses konkrete* Sequenzobjekt bereits einmal durchlaufen?

Die BCL gibt eine Teilantwort auf (1), eine gute Antwort auf (2) und gar keine Antwort auf (3).

## Was die Laufzeit tatsächlich nachhält: die Zustandsmaschine des Iterators

Vom Compiler generierte Iteratoren führen sehr wohl ein Zustandsfeld mit, und Sie können hineinschauen. Das ist eine Debugging-Hilfe, keine API, aber es lohnt sich einmal, weil es das beobachtete Verhalten erklärt:

```csharp
// .NET 10.0.201, C# 14
static IEnumerable<int> Lazy()
{
    yield return 1;
    yield return 2;
}

static string ReadState(object o)
{
    var f = o.GetType().GetField("<>1__state",
        BindingFlags.Instance | BindingFlags.NonPublic);
    return f is null ? "no state field" : $"{f.GetValue(o)}";
}

var seq = Lazy();
Console.WriteLine(ReadState(seq));      // -2  : constructed, never enumerated
var e = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, e)); // True : the first call returns "this"
e.MoveNext();
Console.WriteLine(ReadState(seq));      // 1   : mid-enumeration
```

Der Sentinel-Wert `-2` ist der schnelle Pfad des Compilers: Der erste `GetEnumerator()`-Aufruf im erzeugenden Thread setzt den Zustand auf `0` und gibt dasselbe Objekt zurück, statt einen Klon zu allozieren. Jeder weitere Aufruf liefert einen Klon mit eigenem Zustand. Deshalb startet der zweite Enumerator wieder von vorn, während der erste seine Position behält, und deshalb gibt es kein gemeinsames "bereits enumeriert"-Bit zum Auslesen. Reflexion über `<>1__state` sagt etwas über ein Objekt, auf einem Codepfad, für einen Compiler; setzen Sie das nicht produktiv ein.

## TryGetNonEnumeratedCount und was es genau prüft

In .NET 6 hinzugefügt und in .NET 11 unverändert, ist `Enumerable.TryGetNonEnumeratedCount` das einzige unterstützte Primitiv nach dem Motto "schauen ohne anzufassen". Die [Implementierung in der Laufzeit](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs) besteht aus drei Typprüfungen in Reihenfolge:

```csharp
// System.Linq.Enumerable, .NET 10, abridged
public static bool TryGetNonEnumeratedCount<TSource>(
    this IEnumerable<TSource> source, out int count)
{
    if (source is ICollection<TSource> collectionoft) { count = collectionoft.Count; return true; }
    if (source is Iterator<TSource> iterator)
    {
        int c = iterator.GetCount(onlyIfCheap: true);
        if (c >= 0) { count = c; return true; }
    }
    if (source is ICollection collection) { count = collection.Count; return true; }
    count = 0;
    return false;
}
```

`Iterator<TSource>` ist die interne Basisklasse für die LINQ-eigenen Iteratoren, der mittlere Zweig ist also der Teil, den Sie von außerhalb von `System.Linq` nicht nachbauen können. Die [dokumentierten Hinweise](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) sagen es deutlich: "eine Reihe von Typprüfungen, die gängige Untertypen identifizieren, deren Anzahl ohne Enumeration bestimmt werden kann".

Führt man alle gängigen Sequenzformen durch diese Methode, ergänzt um die Typprüfungen, die Sie von Hand schreiben würden, ergibt sich das hier auf .NET 10.0.201:

| Sequenz | `TryGetNonEnumeratedCount` | `is ICollection<T>` | `is IReadOnlyCollection<T>` | `is IQueryable` |
| --- | --- | --- | --- | --- |
| `int[]` | true, 3 | true | true | false |
| `List<int>` | true, 3 | true | true | false |
| `HashSet<int>` | true, 3 | true | true | false |
| `Queue<int>` | true, 3 | **false** | true | false |
| `Stack<int>` | true, 3 | **false** | true | false |
| `ReadOnlyCollection<int>` | true, 3 | true | true | false |
| `ImmutableArray<int>` | true, 3 | true | true | false |
| `Enumerable.Empty<int>()` | true, 0 | true | true | false |
| `Enumerable.Range(0, 1_000_000_000)` | **true, 1000000000** | **true** | true | false |
| `Enumerable.Repeat(7, 500)` | true, 500 | true | true | false |
| `list.Select(x => x)` | **true, 3** | false | false | false |
| `list.Where(x => true)` | false | false | false | false |
| `list.Take(2)` | true, 2 | **true** | true | false |
| `list.Skip(1)` | true, 2 | **true** | true | false |
| `list.OrderBy(x => x)` | true, 3 | false | false | false |
| `list.Distinct()` | false | false | false | false |
| `list.Concat(list)` | true, 6 | false | false | false |
| `((IEnumerable)list).Cast<int>()` | true, 3 | true | true | false |
| `list.DefaultIfEmpty()` | true, 3 | false | false | false |
| `Enumerable.Reverse(list)` | true, 3 | false | false | false |
| `list.GroupBy(x => x).SelectMany(g => g)` | false | false | false | false |
| Iteratormethode mit `yield return` | false | false | false | false |
| `list.AsQueryable()` | false | false | false | **true** |
| `list.ToList()` / `.ToArray()` | true, 3 | true | true | false |

## Drei Fallen in dieser Tabelle

**Eine günstige Anzahl ist keine materialisierte Sequenz.** `Enumerable.Range(0, 1_000_000_000)` meldet in konstanter Zeit eine Anzahl von einer Milliarde und besteht `is ICollection<int>`, obwohl nichts alloziert wurde. `RangeIterator` implementiert `IList<T>` seit .NET 8; auf .NET 6 und .NET 7 scheitert derselbe Ausdruck am `ICollection<T>`-Test, weil der Iterator nur das interne `IPartition<int>` implementierte. Wenn Ihr Code `if (source is ICollection<T>) { /* safe to keep the reference */ }` sagt, sagt er auch: "Es ist sicher, eine Sequenz mit einer Milliarde Elementen zu halten und zweimal zu durchlaufen."

Dieselbe Falle zeigt sich bei `Select`. `list.Select(x => x)` liefert aus `TryGetNonEnumeratedCount` ein `true` mit der Anzahl der Quellliste, weil die Anzahl einer Projektion der Anzahl ihrer Quelle entspricht. Der Selektor lief für kein einziges Element. Die Anzahl zu bekommen sagt nichts darüber aus, ob die Arbeit erledigt ist.

**`ICollection<T>` übersieht zwei sehr gängige Typen.** `Queue<T>` und `Stack<T>` implementieren die nicht generische `ICollection` und die generische `IReadOnlyCollection<T>`, aber nicht `ICollection<T>`. Eine Guard-Klausel in der Form `source as ICollection<T>` fällt bei beiden still auf eine defensive Kopie zurück. `IReadOnlyCollection<T>` ist die bessere Prüfung, wenn Sie nur `Count` und wiederholte Enumeration brauchen.

**Verzögert heißt nicht unzählbar, und zählbar heißt nicht günstig zu durchlaufen.** `Where` und `Distinct` liefern `false`, selbst wenn die Quelle eine `List<int>` ist, weil das Prädikat die Anzahl bestimmt. `OrderBy` liefert `true` mit der Anzahl der Quelle, aber die Enumeration führt trotzdem eine vollständige Sortierung durch. Behandeln Sie ein `true` nicht als Freibrief zum beliebigen Enumerieren.

## Eine faule ICollection<T> hebelt jede Prüfung aus

Jede Technik hier ist eine Typprüfung, und eine Typprüfung kann von einer Implementierung erfüllt werden, die bei jedem `GetEnumerator()` teure Arbeit leistet. Das ist nicht hypothetisch: eine Collection-Navigation in Entity Framework Core unter Lazy-Loading-Proxies ist eine `ICollection<T>`, deren Enumeration die Datenbank treffen kann.

```csharp
// .NET 10.0.201, C# 14
sealed class LazyCollection : ICollection<int>
{
    public static int WorkDone;
    public int Count => 3;              // cheap, known up front
    public bool IsReadOnly => true;
    public IEnumerator<int> GetEnumerator()
    {
        WorkDone++;                     // expensive, runs on every pass
        return Enumerable.Range(0, 3).GetEnumerator();
    }
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    // mutating members omitted
}
```

Dieser Typ meldet `is ICollection<int> == true` und `TryGetNonEnumeratedCount == true` mit einer Anzahl von 3, ohne irgendetwas getan zu haben. Ein `foreach` später steht `WorkDone` auf 1 und steigt bei jedem weiteren Durchlauf. Keine API kann das von einer `List<int>` unterscheiden. Wenn Ihnen die Schnittstelle gehört, besteht die Lösung darin, kein `IEnumerable<T>` mehr zu übergeben, sondern `IReadOnlyList<T>` oder einen konkreten Typ. Damit wird aus einer Vermutung zur Laufzeit eine Garantie zur Kompilierzeit. Dasselbe Argument gilt bei der [Wahl des richtigen Rückgabetyps zwischen IEnumerable, IAsyncEnumerable und IQueryable](/de/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/).

## Die Guard-Klausel, die sich lohnt

In der Praxis will niemand ein `HasBeenEnumerated`-Flag. Man will wissen, ob ein defensives `ToList()` verschwendet ist. Beantworten Sie genau diese Frage:

```csharp
// .NET 10.0.201, C# 14
public static IReadOnlyCollection<T> Materialize<T>(this IEnumerable<T> source)
{
    ArgumentNullException.ThrowIfNull(source);

    return source switch
    {
        // Deferred against a remote store: always pull it in, once.
        IQueryable<T> q => q.ToList(),

        // Known in-memory BCL types: reuse the reference, no copy.
        T[] a => a,
        List<T> l => l,
        IReadOnlyCollection<T> c when c.GetType().Assembly == typeof(List<T>).Assembly => c,

        _ => source.ToList(),
    };
}
```

Der `IQueryable<T>`-Zweig steht zuerst, weil ein Queryable der eine Fall ist, in dem eine zweite Enumeration eindeutig ein zweiter Roundtrip ist, und in dem die LINQ-Typprüfungen ohnehin alle `false` liefern. Die Assembly-Prüfung im dritten Zweig ist bewusst konservativ: Sie akzeptiert `Queue<T>`, `Stack<T>`, `ReadOnlyCollection<T>` und Verwandte, weist aber die obige `LazyCollection` und jeden ORM-Navigationstyp zurück. Wenn es in Ihrer Codebasis keine faul hinterlegten Collections gibt, reduzieren Sie diesen Zweig auf ein schlichtes `IReadOnlyCollection<T> c => c` und behalten die Einzeiler-Variante.

Beachten Sie, was *nicht* in der Guard-Klausel steht: `TryGetNonEnumeratedCount`. Es beantwortet eine andere Frage. Verwenden Sie es, wenn Sie wirklich eine Anzahl wollen und einen Rückfallwert akzeptieren, denn dafür wurde es entworfen:

```csharp
// .NET 10.0.201, C# 14
int capacity = source.TryGetNonEnumeratedCount(out int known) ? known : 16;
var buffer = new List<T>(capacity);
```

## Was die Guard-Klausel spart

Gemessen mit `Stopwatch` und `GC.GetAllocatedBytesForCurrentThread`, 100 Iterationen, auf einer `List<int>` mit 1.000.000 Elementen, übergeben als `IEnumerable<int>`, .NET 10.0.201 in Release:

| Ansatz | Zeit | Alloziert |
| --- | --- | --- |
| `input.ToList()` | 793,93 us/op | 4.000.056 Bytes/op |
| `input as IReadOnlyCollection<int> ?? input.ToList()` | 1,09 us/op | 0 Bytes/op |

Das sind grobe Schleifenmessungen und keine BenchmarkDotNet-Zahlen, aber die Allokationsspalte ist exakt und darum geht es: Die blinde Kopie alloziert bei jedem Aufruf ein zweites Backing-Array von vier Megabyte auf dem Large Object Heap, die Guard-Klausel alloziert nichts. Auf einem heißen Pfad, der eine bereits materialisierte Liste bekommt, ist die defensive Kopie die gesamten Kosten der Methode. Dieselbe Überlegung gilt, wenn Sie [eine große Datei lesen, ohne den Speicher zu sprengen](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/).

## Lassen Sie den Analyzer die Aufrufstellen finden

Sie müssen das nicht von Hand prüfen. CA1851, "Possible multiple enumerations of 'IEnumerable' collection", kam in .NET 7 hinzu und ist in .NET 10 **weiterhin nicht standardmäßig aktiviert**. Schalten Sie es ein:

```ini
# .editorconfig
[*.{cs,vb}]
dotnet_diagnostic.CA1851.severity = warning
```

Mit `EnableNETAnalyzers` und `AnalysisLevel` auf `latest` erzeugt dieser Code auf .NET 10.0.201 zwei Diagnosen:

```csharp
public static void Twice(IEnumerable<int> input)
{
    var count = input.Count();              // CA1851
    foreach (var i in input) { _ = i; }     // CA1851
}
```

```text
warning CA1851: Possible multiple enumerations of 'IEnumerable' collection.
Consider using an implementation that avoids multiple enumerations.
```

Den Rumpf so umzuschreiben, dass er zuerst über eine Guard-Klausel bindet, beseitigt beide Warnungen:

```csharp
public static void Guarded(IEnumerable<int> input)
{
    var list = input as IReadOnlyCollection<int> ?? input.ToList();
    var count = list.Count;
    foreach (var i in list) { _ = i; }
}
```

Zwei Konfigurationsschalter sind für echte Codebasen relevant. `enumeration_methods` erlaubt es, eigene Methoden zu registrieren, die ein `IEnumerable`-Argument konsumieren, und `assume_method_enumerates_parameters` kehrt die Standardannahme um, die derzeit lautet, dass eine eigene Methode das Übergebene *nicht* enumeriert. Wegen dieser Vorgabe bleibt CA1851 still, wenn Sie dieselbe Sequenz an zwei Ihrer eigenen Hilfsmethoden übergeben.

## IQueryable und IAsyncEnumerable brauchen eigene Regeln

Für `IQueryable<T>` gilt nichts davon: Jede Typprüfung liefert `false`, und jede Enumeration ist eine neue Übersetzung durch den Provider und ein neuer Roundtrip. Das Signal, das Sie brauchen, ist der statische Typ, und die Lösung ist ein einmaliges `ToListAsync()` an der Grenze. Wiederholte Enumeration eines Queryable innerhalb einer Schleife ist eine der Formen hinter [N+1-Abfrageproblemen in EF Core](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), und eine Abfrage, die sich überhaupt nicht übersetzen lässt, erzeugt [den Fehler "The LINQ expression could not be translated"](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) statt eines stillen doppelten Roundtrips.

Für `IAsyncEnumerable<T>` gibt es überhaupt kein `TryGetNonEnumeratedCount`, kein Gegenstück zu `ICollection<T>` und keine günstige Anzahl. Der einzige Weg, die Elementzahl einer asynchronen Sequenz zu erfahren, ist, sie alle abzuwarten, und genau das soll [IAsyncEnumerable Ihnen ersparen](/de/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/). Materialisieren Sie einmal mit `await source.ToListAsync()` und reichen Sie die Liste weiter, oder strukturieren Sie so um, dass ein einziger Durchlauf genügt.

Die ehrliche Zusammenfassung: "Wurde das materialisiert?" ist nicht beantwortbar, "Wird ein zweiter Durchlauf günstig sein?" meistens schon. Prüfen Sie zuerst auf `IQueryable<T>`, dann auf `IReadOnlyCollection<T>` statt auf `ICollection<T>`, behandeln Sie `TryGetNonEnumeratedCount` als Kapazitätshinweis und nicht als Materialisierungsprüfung, und lassen Sie CA1851 zeigen, wo Sie es vergessen haben.

## Verwandte Beiträge

- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#: Welchen Typ soll die Methode zurückgeben?](/de/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [Was ist IAsyncEnumerable&lt;T&gt; und wann sollte ich es verwenden?](/de/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [Wie Sie N+1-Abfragen in EF Core 11 aufspüren](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Wie Sie eine große CSV-Datei in .NET 11 lesen, ohne den Speicher zu sprengen](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Lösung: "The LINQ expression could not be translated" in EF Core 11](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## Quellen

- [Enumerable.TryGetNonEnumeratedCount&lt;TSource&gt; Method](https://learn.microsoft.com/en-us/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) auf MS Learn
- [Count.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Count.cs), die Implementierung der Typprüfungen
- [Range.SpeedOpt.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Linq/src/System/Linq/Range.SpeedOpt.cs), wo `RangeIterator` `IList<T>` deklariert
- [CA1851: Possible multiple enumerations of 'IEnumerable' collection](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1851) auf MS Learn
- [Verzögerte Ausführung und Lazy Evaluation in LINQ](https://learn.microsoft.com/en-us/dotnet/standard/linq/deferred-execution-lazy-evaluation) auf MS Learn
