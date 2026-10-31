---
title: "yield return Iterator vs. Rückgabe einer List<T>: was eine IEnumerable-Methode in C# wirklich kostet"
description: "Eine yield-return-Methode kostet pro Aufruf ein 40 Byte großes Zustandsautomat-Objekt, unabhängig von der Anzahl der Elemente; eine List<T> kostet sofort das gesamte Backing-Array. Gemessen auf .NET 10.0.10: Der Iterator gewinnt bei Speicher und vorzeitigem Abbruch, List<T> gewinnt, wenn der Aufrufer mehrfach aufzählt, Count braucht oder ToList() aufruft."
pubDate: 2026-10-31
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "linq"
  - "performance"
lang: "de"
translationOf: "2026/10/yield-return-iterator-vs-returning-a-list-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-31
---

**Kurze Antwort:** Eine `yield return`-Methode allokiert pro Aufruf genau ein kleines Objekt (40 Byte für eine einfache `IEnumerable<int>`-Schleife auf .NET 10.0.10), egal ob sie 10 Elemente oder eine Million erzeugt. Eine Methode, die eine `List<T>` aufbaut und zurückgibt, allokiert die Liste plus ein Backing-Array, das zum Ergebnis passt: 4.056 Byte für 1.000 ints bei vorab dimensionierter Liste und 8.424 Byte ohne Vordimensionierung. Wählen Sie den Iterator, wenn der Aufrufer nur einmal aufzählt (ein einzelnes `foreach` darüber war bei 1.000 Elementen etwa 2x schneller als das Füllen und Lesen einer Liste), vorzeitig abbrechen kann oder die Sequenz groß oder unbegrenzt ist. Wählen Sie `List<T>` (und sagen Sie das im Rückgabetyp, `List<T>` oder `IReadOnlyList<T>`), wenn der Aufrufer `Count`, Indexzugriff braucht oder mehrfach aufzählt, denn jeder zusätzliche Durchlauf über einen Iterator führt Ihren Methodenrumpf erneut aus.

Alles unten wurde mit C# 14 auf .NET 10.0.10 (SDK 10.0.302) auf einem Apple M4 gemessen, mit BenchmarkDotNet 0.15.8 für die Laufzeiten und `GC.GetAllocatedBytesForCurrentThread()` für die Allokationen pro Aufruf.

## Der Vergleich auf einen Blick

| | `yield return` Iterator | als `IEnumerable<T>` zurückgegebene `List<T>` |
| --- | --- | --- |
| Allokation pro Aufruf (.NET 10.0.10, `int`) | 40 B, konstant (manchmal 0 B, wenn der JIT inlined) | 32 B + Backing-Array (4.056 B für 1.000 ints) |
| Arbeit zum Aufrufzeitpunkt | keine, nicht einmal Argumentprüfungen | alles |
| Arbeit, wenn der Aufrufer nach 1 Element stoppt | 1 Element | alle Elemente |
| Zweites `foreach` | führt den Methodenrumpf erneut aus | liest die gespeicherten Elemente |
| `Count()` | durchläuft die gesamte Sequenz | O(1) über `ICollection<T>` |
| `TryGetNonEnumeratedCount` | `false` | `true` |
| `ToList()` / `ToArray()` | wächst durch Verdopplung / Kopie in exakter Größe | eine Kopie in exakter Größe |
| Ausgelöste Ausnahmen | beim ersten `MoveNext()` | zum Aufrufzeitpunkt |
| Thread-Sicherheit des Ergebnisses | pro Aufzählung ein neuer Zustandsautomat | von vielen Threads sicher lesbar |

## Was der Compiler aus `yield return` macht

Dies ist der Iterator, der im ganzen Beitrag verwendet wird:

```csharp
// .NET 10.0.10, C# 14
public static IEnumerable<int> Iterator(int n)
{
    for (int i = 0; i < n; i++)
        yield return i * 2;
}
```

Roslyn schreibt die Methode in eine versteckte Klasse um, hier `<Iterator>d__0` genannt, und der Methodenrumpf wird zu "diese Klasse allokieren, die Argumente speichern, sie zurückgeben". Reflection auf den generierten Typ zeigt genau, was darin steckt:

```text
Src+<Iterator>d__0
  field Int32 <>1__state
  field Int32 <>2__current
  field Int32 <>l__initialThreadId
  field Int32 n
  field Int32 <>3__n
  field Int32 <i>5__2
  implements IEnumerable`1, IEnumerable, IEnumerator`1, IDisposable, IEnumerator
```

Sechs `int`-Felder plus der 16 Byte große Objekt-Header samt Method-Table-Zeiger ergeben die 40 Byte. Jede lokale Variable, die ein `yield return` überdauert, wird zu einem Feld (`<i>5__2` ist die Schleifenvariable), und jeder Parameter wird doppelt gespeichert: `<>3__n` behält den Originalwert, damit die Sequenz erneut aufgezählt werden kann, `n` ist die Arbeitskopie. Eine Methode mit einem `string`-Parameter und einer `DateTime`-Variablen bekommt größere Felder, aber die Form hängt nie davon ab, wie viele Elemente Sie liefern. Das ist der springende Punkt: Der Speicherbedarf ist O(1) in der Elementanzahl.

Dasselbe Objekt ist sowohl das `IEnumerable<T>` als auch, beim ersten `GetEnumerator()`-Aufruf vom erzeugenden Thread aus, der `IEnumerator<T>`. Ein einfaches `foreach (var x in Iterator(n))` kostet also eine Allokation, nicht zwei.

Die `List<T>`-Variante ist der Code, den die meisten zuerst schreiben:

```csharp
// .NET 10.0.10, C# 14
public static List<int> ListCap(int n)
{
    var list = new List<int>(n);
    for (int i = 0; i < n; i++)
        list.Add(i * 2);
    return list;
}
```

Hier besteht der Aufwand aus dem 32 Byte großen `List<int>`-Objekt plus einem `int[]` mit `n` Elementen (24 Byte Header und Länge, dann 4 Byte pro Element). Lassen Sie das `n` im Konstruktor weg, wächst die Liste 4, 8, 16, ..., 1024 und hinterlässt jedes Zwischen-Array dem GC.

## Allokationen pro Aufruf, gemessen

Jeder Fall wurde 200.000-mal ausgeführt, um Tier-1-Code zu erreichen, und dann über 1.000 Aufrufe gemittelt:

| Elemente | Iterator, `foreach` | `List<T>(n)`, `foreach` | `List<T>()`, `foreach` | Iterator `.ToList()` | Iterator `.ToArray()` |
| --- | --- | --- | --- | --- | --- |
| 0 | 40 B | 32 B | 32 B | 72 B | 40 B |
| 1 | 40 B | 64 B | 72 B | 112 B | 72 B |
| 10 | 40 B | 96 B | 216 B | 256 B | 104 B |
| 1.000 | 40 B | 4.056 B | 8.424 B | 8.464 B | 4.064 B |

Drei Dinge fallen auf.

Erstens ist die Liste bei null Elementen tatsächlich günstiger (32 B vs. 40 B), und bei einem Element ist der Unterschied winzig. Bei kurzen, begrenzten Ergebnissen ist der Speicher kein Grund, sich für das eine oder andere zu entscheiden.

Zweitens ist `Iterator(n).ToList()` die schlechteste Spalte. Der Iterator implementiert `ICollection<T>` nicht, daher kann `ToList()` nicht vorab dimensionieren und wächst durch Verdopplung, genau wie die Liste ohne Kapazität, plus der 40 Byte große Zustandsautomat. Wenn jeder Aufrufer sofort `ToList()` auf Ihren Iterator aufruft, zahlen Sie für beide Entwürfe. Geben Sie stattdessen eine vorab dimensionierte `List<T>` zurück.

Drittens ist `ToArray()` auf einem Iterator unter .NET 10 nahezu verschwendungsfrei: 4.064 B für 1.000 ints, nur 8 Byte mehr als das exakte Array plus der Iterator. Seit .NET 9 puffert `ToArray()` Sequenzen unbekannter Länge in auf dem Stack allokierten Segmenten und kopiert einmal in ein Array exakter Größe; diese Änderung habe ich in [ToList vs ToArray on .NET 9](/de/2025/01/net-performance-tolist-vs-toarray/) behandelt. Wenn ein Aufrufer einen Iterator materialisieren muss, ist `ToArray()` der günstigere Aufruf.

## Was der .NET-10-JIT für Sie entfernt

Eine als `IEnumerable<T>` typisierte `List<T>` zurückzugeben, kostete früher eine weitere Allokation: `foreach` über das Interface ruft `IEnumerable<T>.GetEnumerator()` auf, was die `List<T>.Enumerator`-Struct boxt (40 Byte auf 64 Bit). Auf .NET 10.0.10 allokiert der Fall "List als `IEnumerable`" bei einem Element dieselben 64 B wie die konkrete Liste. Ein erneuter Lauf der Messung mit `DOTNET_JitObjectStackAllocation=0` bringt die Box zurück (104 B). Das zeigt, dass die Guarded Devirtualization des JIT zusammen mit der Objekt-Stack-Allokation, Teil der [.NET-10-Arbeiten zur Enumerator-De-Abstraktion](https://github.com/dotnet/runtime/issues/108913), diesen Enumerator inzwischen auf den Stack legt. Bei null Elementen gibt es auch mit ausgeschaltetem Schalter keine Box, weil `List<T>` bei `Count == 0` einen gemeinsam genutzten leeren Enumerator herausgibt.

Die 40 Byte des Iterators haben sich in den `foreach`-Fällen nicht bewegt, weder mit noch ohne Escape-Analyse. Der Zustandsautomat wird aus Ihrer Methode zurückgegeben, entkommt also per Definition, und der JIT kann ihn nur dann auf dem Stack allokieren, wenn er die Iterator-Methode und alles, was sie konsumiert, in einen Aufrufer inlined. Das passierte im untenstehenden Benchmark bei einigen LINQ-Aufrufen, aber nicht zuverlässig.

## Laufzeiten: wo welche Variante gewinnt

BenchmarkDotNet 0.15.8, Standard-Job, .NET 10.0.10 Arm64 RyuJIT, Apple M4. Jede Methode baut die Sequenz auf und konsumiert sie innerhalb des Benchmarks, daher enthalten die "List"-Zeilen das Füllen der Liste. Mittlere Zeit, Allokation in Klammern:

| Benchmark | N = 10 | N = 1.000 | N = 100.000 |
| --- | --- | --- | --- |
| Iterator, `foreach` | 10,7 ns (40 B) | 580 ns (40 B) | 56,9 us (40 B) |
| `List<T>(n)`, `foreach` | 12,7 ns (96 B) | 1.004 ns (4.056 B) | 116,3 us (400.140 B) |
| `List<T>()`, `foreach` | 30,1 ns (216 B) | 1.214 ns (8.424 B) | 145,8 us (1.049.168 B) |
| `List<T>(n)` als `IEnumerable<T>`, `foreach` | 13,2 ns (96 B) | 1.148 ns (4.056 B) | 114,6 us (400.140 B) |
| Iterator, `.First()` | 2,1 ns (0 B) | 2,1 ns (0 B) | 2,0 ns (0 B) |
| `List<T>(n)`, `.First()` | 11,4 ns (96 B) | 666 ns (4.056 B) | 77,3 us (400.140 B) |
| Iterator, `.ToList()` | 34,1 ns (216 B) | 1.452 ns (8.424 B) | 166,9 us (1.049.168 B) |
| Iterator, `.Count()` | 7,3 ns (0 B) | 541 ns (0 B) | 53,5 us (0 B) |

Bei einem einzelnen Durchlauf ist der Iterator bei jeder Größe schneller: etwa 1,2x bei 10 Elementen und 2x bei 1.000 und 100.000. Das überrascht Leute, die erwarten, dass "ein Interface-Aufruf pro Element" gegen "eine Liste" verliert. Die Listenvariante führt dieselbe Schleife zum Füllen der Liste aus, dann eine zweite Schleife zum Lesen, und zahlt für das Array; der Iterator macht eine Schleife. Bei 100.000 ints liegt das 400.140 Byte große Array der vorab dimensionierten Liste über der Schwelle von 85.000 Byte, landet also auf dem Large Object Heap und löst im BenchmarkDotNet-Lauf bei jedem Aufruf Gen2-Collections aus.

Beim vorzeitigen Abbruch wird der Abstand absurd: `First()` auf dem Iterator kostet unabhängig von der Größe 2 ns, weil nur ein Element berechnet wird. Die Listenvariante berechnet alle 100.000, bevor `First()` auch nur eines davon sieht.

Die beiden Zeilen, in denen der Iterator verliert, sind jene, die ohnehin das gesamte Ergebnis brauchen. `Iterator(n).ToList()` ist in jeder Spalte die langsamste Zeile, langsamer als das direkte Aufbauen der Liste ohne Kapazität, weil zusätzlich zum Verdopplungswachstum die Interface-Aufrufe anfallen. Und obwohl `Count()` auf dem Iterator hier schnell ist, ist es nur schnell, weil es die Sequenz konsumiert; rufen Sie `Count()` und danach `foreach` auf, führen Sie die Methode zweimal aus, und das O(1)-`Count` der Liste gewinnt.

Die 0 B bei den Zeilen `First()` und `Count()` des Iterators sind wieder der .NET-10-JIT: In diesen Benchmarks hat er die Iterator-Methode und den LINQ-Aufruf inlined und den Zustandsautomaten auf dem Stack allokiert. Meine Allokationsmessung sah dasselbe an manchen Aufrufstellen und normale 40 B an anderen, und `DOTNET_JitObjectStackAllocation=0` stellte überall 40 B wieder her. Betrachten Sie es als Bonus, nicht als etwas, wonach Sie Ihr Design ausrichten sollten.

## Der Iterator verwendet sich manchmal selbst wieder

Ein Detail erklärt eine überraschende Zahl in der Messung: Das zweimalige Aufzählen desselben Iterators allokierte insgesamt 40 Byte, nicht 80. Das generierte `GetEnumerator()` gibt `this` zurück, wenn das Zustandsfeld `-2` ist (frisch erzeugt) und der Aufrufer auf dem erzeugenden Thread läuft. Das Disassemblieren des generierten `Dispose()` mit SDK 10.0.302 zeigt, dass es nur `this.<>1__state = -2` ist. Sobald also ein `foreach` endet oder per `break` verlassen wird und den Enumerator freigibt, ist das Objekt wieder im Anfangszustand, und das nächste `foreach` auf demselben Thread erhält dieselbe Instanz:

```csharp
// .NET 10.0.10, C# 14 (SDK 10.0.302)
var seq = Iterator(5);
foreach (var x in seq) { if (x == 2) break; }
var again = seq.GetEnumerator();
Console.WriteLine(ReferenceEquals(seq, again)); // True: reused after Dispose

var fresh = Iterator(5);
var e1 = fresh.GetEnumerator();
e1.MoveNext();
var e2 = fresh.GetEnumerator();
Console.WriteLine(ReferenceEquals(fresh, e2));  // False: e1 still owns the instance
```

Ein zweiter Enumerator, der geholt wird, solange der erste noch lebt, oder einer von einem anderen Thread, erhält eine neue Instanz, die aus den gespeicherten `<>3__`-Parameterkopien initialisiert wird. Für die Korrektheit müssen Sie das nie bedenken, aber es bedeutet, dass "Iterator zweimal aufgezählt" in Bytes billig ist. In der Arbeit ist es nicht billig, und das ist der nächste Punkt.

## Stolperfallen, die die Entscheidung für Sie treffen

### Jede Aufzählung führt Ihre Methode erneut aus

Der Iterator speichert keine Elemente. Ein zweites `foreach`, ein `Count()` gefolgt von einem `foreach` oder `Any()` gefolgt von `ToList()` führt den Methodenrumpf erneut aus, einschließlich jedes Datenbankaufrufs, Dateilesevorgangs oder `Console.WriteLine` darin:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<string> ReadNames(string path)
{
    Console.WriteLine($"opening {path}");
    foreach (var line in File.ReadLines(path))
        yield return line.Trim();
}

var names = ReadNames("names.txt");
if (names.Any())                      // opening names.txt
    Console.WriteLine(names.Count()); // opening names.txt (again)
```

Die .NET-Analyzer melden dies als [CA1851: Possible multiple enumerations of IEnumerable collection](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1851), aber die Regel ist standardmäßig deaktiviert. Wenn Ihre Aufrufer routinemäßig zwei Durchläufe brauchen, geben Sie eine Liste zurück. Wenn Sie ein `IEnumerable<T>` geerbt haben und nicht wissen, ob zweimaliges Durchlaufen sicher ist, sind [die Prüfungen in diesem Beitrag zum Erkennen eines materialisierten IEnumerable](/de/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/) das Nächste, was die BCL bietet.

### Die Argumentvalidierung wird verzögert

Nichts im Rumpf eines Iterators läuft vor dem ersten `MoveNext()`, und das schließt die Guard Clauses am Anfang ein:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<int> Take(IEnumerable<int> source, int count)
{
    ArgumentNullException.ThrowIfNull(source); // runs on first MoveNext, not here
    foreach (var x in source)
    {
        if (count-- <= 0) yield break;
        yield return x;
    }
}

var q = Take(null!, 3);   // no exception
foreach (var x in q) { }  // ArgumentNullException thrown here
```

Der Stack Trace zeigt dann auf das `foreach`, möglicherweise weit vom fehlerhaften Aufruf entfernt. Die Standardlösung, und der Grund, warum die LINQ-Operatoren der BCL selbst zum Aufrufzeitpunkt werfen, besteht darin, die Methode in zwei aufzuteilen: eine öffentliche Nicht-Iterator-Methode, die validiert, und einen privaten Iterator (eine lokale Funktion genügt), der die Elemente liefert:

```csharp
// .NET 10.0.10, C# 14
static IEnumerable<int> Take(IEnumerable<int> source, int count)
{
    ArgumentNullException.ThrowIfNull(source); // throws at call time
    ArgumentOutOfRangeException.ThrowIfNegative(count);
    return Core(source, count);

    static IEnumerable<int> Core(IEnumerable<int> source, int count)
    {
        foreach (var x in source)
        {
            if (count-- <= 0) yield break;
            yield return x;
        }
    }
}
```

Eine `List<T>`-Methode hat diese Falle nicht: Sie läuft vollständig durch oder wirft, bevor sie zurückkehrt.

### `finally` läuft nur, wenn jemand den Enumerator freigibt

`try`/`finally`- und `using`-Blöcke in einem Iterator laufen, wenn die Aufzählung endet oder der Enumerator freigegeben wird. `foreach` gibt immer frei, auch bei `break` und bei Ausnahmen. Code, der `GetEnumerator()` und `MoveNext()` von Hand aufruft und `Dispose()` vergisst, lässt Dateien und Verbindungen offen, bis der GC finalisiert, was sie besaß. Eine Liste hält nach der Rückgabe keine Ressourcen.

### Rekursive Iteratoren sind quadratisch

`yield return` kann keine verschachtelte Sequenz weiterreichen. Ein rekursiver Baumdurchlauf, geschrieben als `foreach (var child in Walk(node.Left)) yield return child;`, allokiert daher einen Zustandsautomaten pro Knoten und reicht jedes Element durch jede Ebene nach oben: O(n x Tiefe) `MoveNext`-Aufrufe. Verwenden Sie bei tiefen Bäumen einen expliziten `Stack<T>` in einem einzigen Iterator oder füllen Sie eine einzige `List<T>`, die durch die Rekursion nach unten gereicht wird.

### Der Rückgabetyp ist ein Versprechen

Ein `IEnumerable<T>` aus einer Methode zurückzugeben, die tatsächlich eine `List<T>` aufbaut, verbirgt, dass `Count` kostenlos ist, und verleitet Aufrufer dazu, "sicherheitshalber" `ToList()` aufzurufen und die Daten ein zweites Mal zu kopieren (der Fall `List.ToList()` mit 8.112 B bei 1.000 Elementen in der [Allokationstabelle oben](#allokationen-pro-aufruf-gemessen), gegenüber 4.056 B für die Liste selbst). Wenn Sie materialisieren, geben Sie `List<T>`, `IReadOnlyList<T>` oder ein Array zurück, damit Aufrufer es sehen. Wenn Sie streamen, geben Sie `IEnumerable<T>` zurück und dokumentieren Sie, dass es lazy ist. Für Daten aus einer Datenbank oder dem Netzwerk ist keines von beiden richtig; [IEnumerable vs IAsyncEnumerable vs IQueryable](/de/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) behandelt, wann stattdessen asynchron gestreamt werden sollte, und [wofür IAsyncEnumerable gedacht ist](/de/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) geht tiefer auf `await foreach` ein.

## Was man zurückgeben sollte

Verwenden Sie einen `yield return`-Iterator, wenn:

- Der Aufrufer einmal von oben nach unten aufzählt, was der Normalfall bei `foreach`-Pipelines und LINQ-Ketten ist.
- Der Aufrufer vorzeitig abbrechen könnte (`First`, `Any`, `Take`, ein `break` bei einem Treffer). Der Iterator leistet nur die Arbeit, die verlangt wurde.
- Die Sequenz groß, unbegrenzt oder aus einem Stream erzeugt ist (Zeilen einer Datei, Seiten einer API). Der Speicher bleibt bei einem Objekt statt beim gesamten Ergebnis.

Geben Sie eine `List<T>` zurück (typisiert als `List<T>` oder `IReadOnlyList<T>`), wenn:

- Der Aufrufer `Count`, Indexzugriff oder mehr als einen Durchlauf braucht.
- Das Ergebnis klein und begrenzt ist, sodass die 40 Byte des Iterators und die Interface-Aufrufe pro Element nichts bringen.
- Aufrufer ohnehin `ToList()` aufrufen. Dimensionieren Sie sie mit `new List<T>(capacity)` vorab, wenn Sie die Anzahl kennen.
- Die Methode Seiteneffekte oder eine Validierung hat, die genau einmal zum Aufrufzeitpunkt stattfinden müssen.

Mein Standard für öffentliche APIs ist die zweite Liste: materialisiert und ehrlich typisiert. Ich greife zu `yield return`, wenn vorzeitiger Abbruch oder Speicher die eigentliche Anforderung ist, und lagere die Validierung dann jedes Mal in einen Nicht-Iterator-Wrapper aus.

## Verwandte Beiträge

- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#: which one should the method return?](/de/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/)
- [How to tell whether an IEnumerable<T> has already been materialized in C#](/de/2026/08/how-to-tell-whether-an-ienumerable-has-already-been-materialized-in-csharp/)
- [.NET Performance: ToList vs ToArray](/de/2025/01/net-performance-tolist-vs-toarray/)
- [What is IAsyncEnumerable and when should I use it?](/de/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)
- [How to iterate over two collections in lockstep without heap allocations in C#](/de/2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp/)

## Quellen

- [yield statement](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/yield) (C#-Sprachreferenz)
- [Iterators](https://learn.microsoft.com/dotnet/csharp/iterators) (C#-Leitfaden)
- [CA1851: Possible multiple enumerations of IEnumerable collection](https://learn.microsoft.com/dotnet/fundamentals/code-analysis/quality-rules/ca1851) (Microsoft Learn)
- [Enumerable.TryGetNonEnumeratedCount](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.trygetnonenumeratedcount) (Microsoft Learn)
- [Roslyn iterator rewriter source](https://source.dot.net/Microsoft.CodeAnalysis.CSharp/Lowering/IteratorRewriter/IteratorMethodToStateMachineRewriter.cs.html) (source.dot.net)
- [.NET 10 de-abstraction plans, dotnet/runtime#108913](https://github.com/dotnet/runtime/issues/108913)
- [What's new in the .NET 10 runtime](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime) (Microsoft Learn)
