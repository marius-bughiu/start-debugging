---
title: "Zwei Collections in C# im Gleichschritt durchlaufen, ohne Heap-Allokationen"
description: "Enumerable.Zip allokiert 144 bis 208 Bytes pro Aufruf und läuft etwa 10x langsamer als eine einfache Schleife. Für Arrays und Listen ist eine for-Schleife über zwei auf dieselbe Länge zugeschnittene Spans allokationsfrei und die schnellste Variante; wer foreach-Syntax möchte, kommt mit einem kleinen ref struct Zip-Enumerator auf weniger als 25 % Abstand. Gemessen mit .NET 10.0.10 und .NET 11 RC 3."
pubDate: 2026-10-27
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "linq"
  - "memory"
lang: "de"
translationOf: "2026/10/how-to-iterate-over-two-collections-in-lockstep-without-heap-allocations-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-27
---

**Kurze Antwort:** Wenn beide Quellen Arrays, Listen oder irgendetwas sind, aus dem sich ein `ReadOnlySpan<T>` gewinnen lässt, nehmen Sie die kürzere Länge, schneiden beide Spans darauf zu und lassen eine einzige `for`-Schleife mit einem Index laufen. Das allokiert nichts und ist die schnellste Form, die der JIT kennt. Wer die Syntax `foreach (var (x, y) in ...)` ohne diese Kosten möchte, schreibt einen 20-zeiligen `ref struct` Zip-Enumerator, der in `MoveNext` beide Längen prüft. Sind die Quellen nicht indizierbar (ein `HashSet<T>`, ein `Dictionary<TKey, TValue>`), steuern Sie deren Struct-Enumeratoren von Hand über zwei `GetEnumerator()`-Aufrufe auf den konkreten Typen. Meiden Sie `Enumerable.Zip` in Hot Paths: Auf .NET 10.0.10 und .NET 11 RC 3 allokiert es 144 bis 208 Bytes pro Aufruf und war im Benchmark unten etwa 10x langsamer als die einfache Schleife.

Alles in diesem Artikel wurde mit C# 14 auf .NET 10.0.10 (SDK 10.0.302) und .NET 11.0.0-rc.3.26522.148 auf einem Apple M4 gemessen. Die Allokationszahlen waren auf beiden Runtimes identisch.

## Woher die Bytes in Enumerable.Zip kommen

`Enumerable.Zip` ist die naheliegende Antwort auf "zwei Sequenzen gemeinsam durchlaufen", und seit .NET Core 3.0 gibt es eine Überladung, die Tupel zurückgibt, sodass sich der Code gut liest:

```csharp
// .NET 10, C# 14
long sum = 0;
foreach (var (x, y) in first.Zip(second))
    sum += (long)x * y;
```

Das Problem: Jedes Teil dieser Pipeline ist ein Referenztyp hinter einem Interface. `Zip` nimmt zwei `IEnumerable<T>`-Parameter entgegen und ruft daher `GetEnumerator()` auf jeder Quelle über das Interface auf. Bei einer `List<T>` wird dadurch ihr Struct `List<T>.Enumerator` geboxt; bei einem Array wird ein Array-Enumerator-Objekt allokiert. Dann gibt `Zip` selbst ein Iterator-Objekt zurück, das beide hält. Ihr `foreach` spricht mit diesem Iterator über `IEnumerator<(T1, T2)>`, also ist jedes `MoveNext` und `Current` ein Interface-Aufruf, den der JIT meist nicht inlinen kann.

Ich habe die Allokationen im eingeschwungenen Zustand mit `GC.GetAllocatedBytesForCurrentThread()` gemessen, nachdem jede Methode mit dynamischem PGO bis Tier 1 hochgestuft war, mit zwei `int`-Quellen zu je 1.000 Elementen:

| Ansatz | Allokiert pro Aufruf (.NET 10.0.10 und 11 RC 3) |
|---|---|
| `for`-Schleife mit einem Index über Arrays | 0 B |
| `for`-Schleife über zwei zugeschnittene `ReadOnlySpan<int>` | 0 B |
| `CollectionsMarshal.AsSpan` auf zwei `List<int>` | 0 B |
| `ref struct` Zip-Enumerator mit `foreach` | 0 B |
| Zwei manuell gesteuerte `List<int>.Enumerator` | 0 B |
| Zwei `IEnumerator<int>`, Quellen als `IEnumerable<int>` typisiert, über Arrays | 64 B |
| Zwei `IEnumerator<int>`, Quellen als `IEnumerable<int>` typisiert, über Listen | 80 B |
| `Enumerable.Zip` Tupel-Überladung, Arrays | 144 B |
| `Enumerable.Zip` mit statischem Result Selector, Arrays | 160 B |
| `Enumerable.Zip` Tupel-Überladung, Listen | 160 B |
| `Enumerable.Zip` mit drei Quellen, Arrays | 208 B |

Die Kosten fallen pro Aufruf an, nicht pro Element. Für eine Schleife, die einmal beim Start läuft, spielt das keine Rolle. Es spielt eine Rolle, wenn die Gleichschritt-Schleife in einem Request Handler, einem Game Tick, einem Parser oder irgendetwas anderem steckt, das millionenfach läuft. Ein paar hundert Bytes pro Aufruf, multipliziert mit der Aufrufrate, sind genau der Gen0-Durchsatz, der in einem Trace auftaucht.

Beachten Sie, dass das statische Lambda in der Selector-Überladung nicht geholfen hat: Der Delegate wird zwar gecacht, aber der Iterator und die beiden Enumeratoren werden trotzdem allokiert.

## Die schnellste Variante: ein Index, zwei zugeschnittene Spans

Wenn beide Quellen zusammenhängender Speicher sind, brauchen Sie überhaupt keine Enumeratoren. Ein Index läuft über beide:

```csharp
// .NET 10, C# 14
static long DotProduct(ReadOnlySpan<int> a, ReadOnlySpan<int> b)
{
    int n = Math.Min(a.Length, b.Length);
    a = a[..n];
    b = b[..n];

    long sum = 0;
    for (int i = 0; i < a.Length; i++)
        sum += (long)a[i] * b[i];
    return sum;
}

int[] prices = [10, 20, 30];
int[] quantities = [3, 2, 1];
long total = DotProduct(prices, quantities); // 100
```

Das Zuschneiden ist keine Dekoration. Die Schleifenbedingung ist `i < a.Length`, wodurch der JIT die Bounds Check auf `a[i]` weglassen kann. Nach `b = b[..n]` mit demselben `n` weiß der JIT auch, dass `b.Length == a.Length` gilt, und kann die Prüfung auf `b[i]` ebenfalls weglassen. Ohne das Zuschneiden behält `b[i]` in jeder Iteration eine Bounds Check, weil nichts in der Schleife beweist, dass `b` mindestens so lang ist wie `a`. Das ist dieselbe Regel "die Länge zur Schleifengrenze machen", die ich in [was Span<T> ist und wann es Code tatsächlich schneller macht](/de/2026/06/what-is-span-and-when-does-it-make-my-code-faster/) behandelt habe.

Arrays werden implizit in `ReadOnlySpan<T>` konvertiert, die Aufrufstellen bleiben also sauber. Bei `List<T>` holen Sie sich mit `CollectionsMarshal.AsSpan` den Span über das zugrunde liegende Array:

```csharp
// .NET 10, C# 14
using System.Runtime.InteropServices;

List<int> prices = [10, 20, 30];
List<int> quantities = [3, 2, 1];

long total = DotProduct(
    CollectionsMarshal.AsSpan(prices),
    CollectionsMarshal.AsSpan(quantities));
```

`CollectionsMarshal.AsSpan` kostet nichts: Es gibt einen Span über das interne Array der Liste zurück, begrenzt auf `Count`. Der Haken ist, dass der Span danach nichts mehr von der Liste weiß. Wenn Sie `Add` auf der Liste aufrufen, während Sie den Span halten, und die Liste wächst, zeigt der Span weiter auf das alte Array, und Sie lesen veraltete Daten, ohne dass eine Exception fliegt. Ändern Sie die Größe der Liste nicht, solange der Span lebt. Der Vergleich [List<T> vs Span<T> vs ReadOnlySpan<T>](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) geht auf den Rest dieses Kompromisses ein.

Um in eine der Sequenzen zu schreiben, während Sie die andere lesen, machen Sie das Ziel zu einem `Span<T>` statt einem `ReadOnlySpan<T>`. Das Muster bleibt gleich.

## foreach-Syntax behalten mit einem ref struct Zip-Enumerator

Die Index-Schleife ist schnell, aber nicht hübsch, und wenn der Rumpf mehr als eine Zeile hat, werden `a[i]` und `b[i]` unübersichtlich. Das `foreach` von C# ist musterbasiert: Es verlangt kein `IEnumerable<T>`, nur eine Methode `GetEnumerator()`, die etwas mit `MoveNext()` und `Current` zurückgibt. Dieses Etwas darf ein `ref struct` sein, was bedeutet, dass es Spans halten kann und niemals geboxt wird:

```csharp
// .NET 10, C# 14
public ref struct SpanZip<T1, T2>
{
    private readonly ReadOnlySpan<T1> _first;
    private readonly ReadOnlySpan<T2> _second;
    private int _index;

    public SpanZip(ReadOnlySpan<T1> first, ReadOnlySpan<T2> second)
    {
        _first = first;
        _second = second;
        _index = -1;
    }

    public SpanZip<T1, T2> GetEnumerator() => this;

    public bool MoveNext()
    {
        int i = _index + 1;
        if ((uint)i < (uint)_first.Length && (uint)i < (uint)_second.Length)
        {
            _index = i;
            return true;
        }
        return false;
    }

    public (T1 First, T2 Second) Current => (_first[_index], _second[_index]);
}

public static class SpanZipExtensions
{
    public static SpanZip<T1, T2> ZipSpan<T1, T2>(
        this ReadOnlySpan<T1> first, ReadOnlySpan<T2> second) => new(first, second);
}
```

Die Verwendung liest sich wie LINQ:

```csharp
// .NET 10, C# 14
int[] prices = [10, 20, 30];
int[] quantities = [3, 2, 1];

long total = 0;
foreach (var (price, quantity) in prices.ZipSpan(quantities))
    total += (long)price * quantity;
```

Das zurückgegebene Tupel ist ein `ValueTuple`, also ein Struct, und das Dekonstruieren kostet auf dem Heap nichts. Dass sich eine `ReadOnlySpan<T>`-Erweiterungsmethode direkt auf einem `int[]` aufrufen lässt, mit abgeleiteten Typargumenten, beruht auf den First-Class-Span-Konvertierungen von C# 14; mit C# 13 müssten Sie zuerst `prices.AsSpan()` schreiben. Bei einer `List<T>` rufen Sie sie auf `CollectionsMarshal.AsSpan(list)` auf.

Die Form von `MoveNext` ist wichtiger, als es aussieht. Meine erste Version hat beide Spans im Konstruktor auf die gemeinsame Länge zugeschnitten und in `MoveNext` nur `_index` mit `_first.Length` verglichen. Das war korrekt, lief aber fast exakt mit den 2-fachen Kosten der einfachen Schleife. Die Prüfung beider Längen in `MoveNext` brachte es auf 1,23x herunter. Meine Lesart des Ergebnisses: Sobald `MoveNext` und `Current` geinlined sind, sieht der JIT beide Vergleiche direkt vor den zwei Indexer-Aufrufen und kann sie nutzen, um Bounds Checks wegzulassen; ein Zuschneiden in einer anderen Methode liefert ihm diese Information nicht. So oder so ist der gemessene Unterschied groß, also behalten Sie beide Prüfungen.

Mit `ref struct` kommen zwei Einschränkungen: Sie können `SpanZip` nicht über ein `await` oder `yield return` hinweg verwenden, und Sie können es nicht in einem Feld einer normalen Klasse speichern. Wenn sich der Compiler über Lebensdauern beschwert, gelten die Regeln, die in [wie C# den ref-safe-context bestimmt](/de/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/) beschrieben sind.

## Wenn die Quellen nicht indizierbar sind

`HashSet<T>`, `Dictionary<TKey, TValue>`, `Queue<T>`, `LinkedList<T>` und verwandte Typen können Ihnen keinen Span liefern, aber jeder davon stellt einen öffentlichen Struct-Enumerator bereit, wenn Sie `GetEnumerator()` auf dem konkreten Typ aufrufen. Steuern Sie zwei davon selbst:

```csharp
// .NET 10, C# 14
static long SumProducts(List<int> a, List<int> b)
{
    long sum = 0;
    using var ea = a.GetEnumerator();   // List<int>.Enumerator, a struct
    using var eb = b.GetEnumerator();
    while (ea.MoveNext() && eb.MoveNext())
        sum += (long)ea.Current * eb.Current;
    return sum;
}
```

Das ergab 0 B pro Aufruf. Das entscheidende Detail ist der statische Typ der Parameter. Ändern Sie `List<int>` in `IEnumerable<int>`, und exakt derselbe Rumpf allokiert 80 B pro Aufruf (zwei geboxte `List<int>.Enumerator`-Instanzen), oder 64 B, wenn die Laufzeitobjekte Arrays sind. Das `var` verbirgt das: `ea` ist in der einen Version `List<int>.Enumerator` und in der anderen `IEnumerator<int>`.

Struct-Enumeratoren behalten außerdem die eigenen Sicherheitsprüfungen der Collection. `List<T>.Enumerator` wirft `InvalidOperationException`, wenn die Liste während der Enumeration verändert wird, was die Span-basierten Varianten nicht leisten können.

Die Reihenfolge ist hier die andere Falle. Ein Gleichschritt-Durchlauf über zwei `HashSet<T>`- oder `Dictionary<TKey, TValue>`-Instanzen paart Elemente nach interner Bucket-Reihenfolge, die nicht der Einfügereihenfolge entspricht und zwischen verschiedenen Instanzen mit gleichem Inhalt nicht stabil ist. Zippen Sie nur geordnete Collections. Wenn Sie eigentlich Elemente über einen Schlüssel zuordnen wollen, ist das ein Join oder ein Dictionary-Lookup, kein Zip.

## Was die Stack-Allokation von .NET 10 behebt und was nicht

.NET 10 hat dem JIT beigebracht, Interface-Methoden von Arrays zu devirtualisieren und über bedingte Escape-Analyse Enumeratoren "in bestimmten Szenarien" auf dem Stack zu allokieren, wie es die Seite [What's new in .NET 10 runtime](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime#array-enumeration-de-abstraction) formuliert. Es ist naheliegend zu hoffen, dass dadurch die Interface-Varianten kostenlos werden. In meinen Läufen war das nicht so:

- Die `Enumerable.Zip`-Varianten allokierten auf .NET 10.0.10 und .NET 11 RC 3 dieselben Bytes. Die Enumeratoren werden im Iterator von `Zip` erzeugt, der zum Aufrufer entkommt, also hat die Escape-Analyse nichts, womit sie arbeiten könnte.
- Zwei `IEnumerator<int>` über Arrays allokierten in meiner Messung im eingeschwungenen Zustand 64 B und unter BenchmarkDotNet 32 B. Das deutet darauf hin, dass der JIT in manchen Kompilierungen einen der beiden Enumeratoren auf dem Stack allokiert hat und in anderen keinen. Auf diese Optimierung können Sie sich nicht verlassen, und sie erreicht nie null.

Die De-Abstraktionsarbeit ist real und hilft durchaus bei `foreach` über eine einzelne Sequenz, wenn ein Array als `IEnumerable<T>` typisiert ist. Wer den Hintergrund möchte: [die Stack-Allokation kleiner Arrays in .NET 10](/de/2025/04/net-10-stack-allocation-of-arrays-of-value-types/) behandelt die verwandte Arbeit an Arrays. Den Fall mit zwei Quellen deckt sie nur noch nicht ab.

## Die Zahlen

BenchmarkDotNet 0.15.8, `[MemoryDiagnoser]`, In-Process-Toolchain, .NET 10.0.10 Arm64 RyuJIT, Apple M4, zwei Arrays (oder Listen) mit je 1.000 `int`-Werten, berechnet wird eine Summe von Produkten:

| Methode | Mittelwert | Verhältnis | Allokiert |
|---|---:|---:|---:|
| `for` mit einem Index über Arrays | 247,9 ns | 1,00 | 0 B |
| `for` über zwei zugeschnittene `ReadOnlySpan<int>` | 249,7 ns | 1,01 | 0 B |
| `CollectionsMarshal.AsSpan` auf zwei Listen | 250,9 ns | 1,01 | 0 B |
| `SpanZip` mit beiden Längen in `MoveNext` geprüft | 310,0 ns | 1,23 | 0 B |
| `SpanZip` im Konstruktor zugeschnitten (erster Entwurf) | 489,6 ns | 1,97 | 0 B |
| Zwei manuell gesteuerte `List<int>.Enumerator` | 652,5 ns | 2,63 | 0 B |
| Zwei `IEnumerator<int>` über Arrays | 1.621,2 ns | 6,54 | 32 B |
| `Enumerable.Zip` mit statischem Selector | 2.535,9 ns | 10,23 | 160 B |
| `Enumerable.Zip` Tupel-Überladung | 2.613,6 ns | 10,54 | 144 B |

Die `SpanZip`-Zeile mit beiden Prüfungen stammt aus einem zweiten Lauf derselben Benchmark-Klasse, in dem die `for`-Baseline 251,4 ns maß; das Verhältnis bezieht sich also auf die Baseline dieses Laufs. Die In-Process-Toolchain war nötig, weil BenchmarkDotNet für eine dateibasierte `dotnet run bench.cs`-App nicht sein übliches separates Projekt erzeugen kann.

Zwei Lesarten der Tabelle. Erstens landet alles, was Span-förmig ist, im Rauschen der handgeschriebenen Schleife; `CollectionsMarshal.AsSpan` fügt nichts Messbares hinzu. Zweitens sind "allokationsfrei" und "schnell" verschiedene Eigenschaften: Die manuellen Struct-Enumeratoren allokieren nichts, kosten aber trotzdem 2,6x, weil `List<T>.Enumerator.MoveNext` pro Element eine Versionsprüfung und eine Bounds Check mitbringt. Geht es Ihnen um GC-Druck, löst jede Zeile ohne Allokation das Problem. Geht es Ihnen um Durchsatz, nehmen Sie Spans.

## Die Wahl zwischen den Varianten

- Beide Quellen sind Arrays, Listen, `ImmutableArray<T>`, `Memory<T>` oder Stack-Puffer: Nehmen Sie die `for`-Schleife über zugeschnittene Spans, oder `SpanZip`, wenn Sie `foreach` bevorzugen und sich in einer engen numerischen Schleife etwa 20 % leisten können. Bei einem Schleifenrumpf, der echte Arbeit leistet, verschwinden diese 60 ns pro tausend Elemente.
- Die Quellen sind andere BCL-Collections: Halten Sie sie über ihren konkreten Typ und steuern Sie die Struct-Enumeratoren. Lassen Sie sie nie vorher durch einen `IEnumerable<T>`-Parameter laufen.
- Die Längen können abweichen, und das wäre ein Bug: Prüfen Sie `a.Length != b.Length` und werfen Sie vor der Schleife. `Enumerable.Zip`, die Span-Schleife oben und `SpanZip` hören alle stillschweigend bei der kürzeren Sequenz auf, und die BCL hat kein striktes Zip; ich habe die Referenzassemblies von .NET 11 RC 3 geprüft, und `Enumerable.Zip` ist weiterhin das einzige mitgelieferte Zip.
- Drei oder mehr Quellen: Die Span-Schleife lässt sich trivial erweitern (alle drei auf die minimale Länge zuschneiden). Die Drei-Quellen-Überladung von `Enumerable.Zip`, eingeführt in .NET 6, kostet 208 B pro Aufruf.
- Kalter Code, kleine Eingaben oder eine LINQ-Pipeline, die ohnehin allokiert: Bleiben Sie bei `Enumerable.Zip`. Es ist die klarste Variante, und die Bytes spielen dort keine Rolle.

Wenn Sie viel LINQ auf Spans umstellen, denken Sie daran, dass C# 14 geändert hat, wie Array-Argumente an Span-Überladungen binden; [die impliziten Span-Konvertierungen in C# 14](/de/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) erklären, warum ein Aufruf, der früher eine `IEnumerable<T>`-Überladung wählte, jetzt möglicherweise eine Span-Überladung wählt.

### Weiterlesen

- [Was ist Span<T> in C#, und wann macht es Ihren Code tatsächlich schneller?](/de/2026/06/what-is-span-and-when-does-it-make-my-code-faster/)
- [List<T> vs Span<T> vs ReadOnlySpan<T> in C#](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/)
- [Was ist ref-safe-context in C#, und wie bestimmt der Compiler ihn für ref-Locals?](/de/2026/10/what-is-ref-safe-context-in-csharp-and-how-does-the-compiler-decide-it-for-ref-locals/)
- [.NET 10: Stack-Allokation von Arrays aus Werttypen](/de/2025/04/net-10-stack-allocation-of-arrays-of-value-types/)

### Quellen

- [Enumerable.Zip-Methode](https://learn.microsoft.com/dotnet/api/system.linq.enumerable.zip) (Microsoft Learn)
- [CollectionsMarshal.AsSpan-Methode](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan) (Microsoft Learn)
- [Die foreach-Anweisung und musterbasierte Enumeration](https://learn.microsoft.com/dotnet/csharp/language-reference/statements/iteration-statements#the-foreach-statement) (C#-Sprachreferenz)
- [ref struct-Typen](https://learn.microsoft.com/dotnet/csharp/language-reference/builtin-types/ref-struct) (C#-Sprachreferenz)
- [What's new in .NET 10 runtime: array enumeration de-abstraction and stack allocation](https://learn.microsoft.com/dotnet/core/whats-new/dotnet-10/runtime)
- [.NET 10 de-abstraction plans, dotnet/runtime#108913](https://github.com/dotnet/runtime/issues/108913)
