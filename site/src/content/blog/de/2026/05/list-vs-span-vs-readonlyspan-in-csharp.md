---
title: "List<T> vs Span<T> vs ReadOnlySpan<T> in C#: wann welcher Typ"
description: "List<T> ist eine wachsende Heap-Sammlung; Span<T> und ReadOnlySpan<T> sind reine Stack-Sichten auf Speicher, den Sie bereits besitzen. Verwenden Sie List<T> für alles, was Sie speichern, aus async zurückgeben oder wachsen lassen; Span<T> für eine veränderliche, allokationsfreie Sicht in einer synchronen Methode; ReadOnlySpan<T> für schreibgeschütztes Parsen von Strings, u8-Literalen und Slices."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "de"
translationOf: "2026/05/list-vs-span-vs-readonlyspan-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-25
---

Verwenden Sie `List<T>`, wenn Sie eine Sammlung haben, die wächst, in einem Feld gespeichert, aus einer Methode zurückgegeben oder über ein `await` hinweg übergeben wird. Verwenden Sie `Span<T>`, wenn Sie eine veränderliche, allokationsfreie Sicht auf einen zusammenhängenden Puffer wollen, den Sie bereits haben (ein Array, einen `stackalloc`-Block, ein Slice), innerhalb einer einzigen synchronen Methode. Verwenden Sie `ReadOnlySpan<T>` für dieselbe Sicht, wenn Sie nur lesen: String-Slicing, `u8`-Literale, Parsen, Suchen. Die Entscheidung, die den Geschmack übersteuert: Die beiden Spans sind `ref struct`-Typen, also können sie nicht auf dem Heap leben, kein Feld einer Klasse sein und kein `await` oder `yield` überqueren. Wenn Sie eines davon brauchen, sind Sie bei `List<T>` (oder einem Array), Punkt.

Dieser Artikel zielt auf .NET 11 und C# 14. `Span<T>` und `ReadOnlySpan<T>` sind seit .NET Core 2.1 in der BCL und seit C# 7.2 in der Sprache, aber zwei jüngere Änderungen sind hier wichtig: C# 13 (.NET 9) fügte die Anti-Constraint `allows ref struct` und `params ReadOnlySpan<T>` hinzu, und C# 14 (.NET 11) fügte erstklassige implizite Konvertierungen zwischen Arrays und Spans hinzu. Beide verringern die Reibung beim Wechsel zwischen diesen Typen. `List<T>` geht auf .NET Framework 2.0 zurück.

## Das sind nicht drei Geschmacksrichtungen derselben Sache

Der Vergleich verwirrt, weil die drei Namen wie Gleichrangige aussehen und es nicht sind. Zwei davon sind nur dem Namen nach Sammlungen.

`List<T>` ist eine Klasse. Es ist ein wachsender Wrapper um ein privates `T[]`, das seine Kapazität verdoppelt, wenn es sich füllt. Sie lebt auf dem verwalteten Heap, der GC verfolgt sie, Sie können sie in einem Feld speichern, zurückgeben, in einem Lambda erfassen und an eine `async`-Methode übergeben. Sie besitzt ihren Speicher und kann wachsen. Dies ist die alltägliche Sammlung, zu der Sie ohne Nachdenken greifen, und meistens ist dieser Instinkt richtig.

`Span<T>` ist ein `ref struct`. Er besitzt keinen Speicher. Er ist ein winziger Wert (eine verwaltete Referenz plus eine Länge), der auf eine zusammenhängende Region zeigt, die jemand anderes allokiert hat: ein Array, ein Slice eines Arrays, ein `stackalloc`-Puffer oder nicht verwalteter Speicher. Er kann nicht wachsen, weil er den zugrunde liegenden Speicher nicht besitzt. Er ist veränderlich: Schreiben durch einen `Span<T>` schreibt in den zugrunde liegenden Puffer. Da er ein `ref struct` ist, garantiert die Laufzeit, dass er nur auf dem Stack leben kann, was genau das ist, was ihn sicher macht, auf Stack-Speicher zu zeigen, ihm aber auch verbietet, ein Feld zu sein, geboxt zu werden oder ein `await` zu überleben.

`ReadOnlySpan<T>` ist dieselbe `ref struct`-Sicht, abzüglich der Fähigkeit zu schreiben. Es ist das, was String-Slicing zurückgibt (`"hello".AsSpan(1, 3)`), was ein UTF-8-Literal erzeugt (`"GET"u8` ist ein `ReadOnlySpan<byte>`), und der Parametertyp, den Sie akzeptieren sollten, wenn Sie nur einen Puffer lesen. Alles über die reinen Stack-Einschränkungen von `Span<T>` gilt identisch.

Die eigentliche Frage ist also selten "welche Sammlung". Sie lautet: "Besitze ich einen Puffer und lasse ihn wachsen (`List<T>`), oder betrachte ich einen, den ich bereits habe, veränderlich (`Span<T>`) oder schreibgeschützt (`ReadOnlySpan<T>`)?"

## Die Entscheidungsmatrix

Das Verhalten unten gilt für .NET 9+ / C# 13+, sofern nicht anders angegeben.

| Fähigkeit                                    | `List<T>`              | `Span<T>`                  | `ReadOnlySpan<T>`          |
| -------------------------------------------- | ---------------------- | -------------------------- | -------------------------- |
| Art                                          | Klasse (Heap)          | `ref struct` (Stack)       | `ref struct` (Stack)       |
| Besitzt seinen Speicher                      | ja                     | nein (eine Sicht)          | nein (eine Sicht)          |
| Kann wachsen / `Add`                         | ja                     | nein                       | nein                       |
| Elemente mutieren                            | ja                     | ja                         | nein                       |
| Allokation beim Erstellen                    | Heap (das zugrunde liegende `T[]`) | keine         | keine                      |
| In einem Feld einer Klasse speichern         | ja                     | nein                       | nein                       |
| Aus einer `async`-Methode zurückgeben        | ja                     | nein                       | nein                       |
| Über `await` / `yield` hinweg verwenden      | ja                     | nein                       | nein                       |
| In einem Lambda / Closure erfassen           | ja                     | nein                       | nein                       |
| Boxing / Zuweisung an `object` oder Interface | ja                    | nein                       | nein                       |
| Als generisches Typargument verwenden        | ja                     | nur mit `allows ref struct` | nur mit `allows ref struct` |
| Slicen ohne Kopie                            | nein (`GetRange` kopiert) | ja (`Slice`, ohne Kopie) | ja (`Slice`, ohne Kopie)   |
| Aus einem `string` erzeugen                  | nein                   | nein                       | ja (`AsSpan`)              |
| Aus `stackalloc` erzeugen                    | nein                   | ja                         | ja                         |
| Erstmals veröffentlicht                      | .NET Framework 2.0     | .NET Core 2.1              | .NET Core 2.1              |

Die Zeilen von "In einem Feld speichern" bis "Boxing" entscheiden die meisten realen Fälle. Wenn eine davon für Ihr Szenario ein Ja ist, fallen die Spans weg, und Sie behalten ein `List<T>` oder ein Array. Alles andere ist eine Frage von Leistung und Ergonomie.

## Wann List<T> zu wählen ist

`List<T>` ist die Standardwahl. Greifen Sie dazu, wann immer die Sammlung eine längere Lebensdauer als eine synchrone Methode hat oder wenn Sie die endgültige Größe nicht im Voraus kennen.

- **Sie bauen eine Sammlung inkrementell auf.** Sie lesen Zeilen, hängen Ergebnisse an, sammeln Ereignisse. `Add` ist amortisiert O(1), und die Liste ändert ihre Größe selbst. Ein Span kann nicht wachsen, also ist das nicht einmal ein Wettbewerb.
- **Die Sammlung ist ein Feld oder ein Rückgabewert.** Ein Cache, eine Registry, ein `List<Order>`, das Sie aus einem Repository zurückgeben. Ein `ref struct` kann kein Feld sein und nicht über eine asynchrone Grenze zurückgegeben werden, also lebt alles, was den Stack-Frame überdauert, in einem `List<T>`.
- **Sie überqueren ein `await`.** In dem Moment, in dem eine Methode wartet (await), wird jede lokale Variable, die das await überlebt, in eine auf dem Heap allokierte Zustandsmaschine gehoben. Ein `ref struct` kann nicht gehoben werden, also kann eine lokale `Span<T>`-Variable das await nicht überleben. Ein `List<T>` kann es.

```csharp
// .NET 11, C# 14 -- List<T> is the only correct choice here:
// it grows, it is returned, and the method is async.
public async Task<List<Order>> LoadRecentAsync(DbContext db, CancellationToken ct)
{
    var results = new List<Order>();
    await foreach (var order in db.Orders.AsAsyncEnumerable().WithCancellation(ct))
    {
        if (order.Total > 100m)
            results.Add(order);   // grows on demand
    }
    return results;               // escapes the stack frame
}
```

Wenn Sie einen Hinweis wollen, dass Sie die richtige Wahl getroffen haben, fragen Sie, ob die Sammlung existieren muss, nachdem die Methode zurückgekehrt ist. Wenn ja, ist es ein `List<T>` oder ein Array, niemals ein Span.

## Wann Span<T> zu wählen ist

`Span<T>` ist für eine veränderliche, allokationsfreie Sicht auf Speicher, den Sie bereits kontrollieren, verwendet und verworfen innerhalb einer einzigen synchronen Methode. Der klassische Gewinn ist die Vermeidung einer Zwischenallokation.

- **Ein kleiner Scratch-Puffer über `stackalloc`.** Eine Zahl formatieren, einen kleinen Schlüssel bauen, ein paar Bytes hashen. `stackalloc` legt den Puffer auf den Stack, und ein `Span<T>` ist der sichere Handle darauf. Kein `T[]` auf dem Heap, kein GC-Druck.
- **Einen Puffer an Ort und Stelle slicen.** Einen Netzwerk-Frame parsen: den Header nehmen, dann die Nutzlast, ohne eines von beiden zu kopieren. `Span<T>.Slice` gibt eine weitere Sicht auf denselben Speicher zurück.
- **Eine Array-Region mutieren ohne ein Durcheinander aus Offset/Längen-Parametern.** `buffer.AsSpan(start, length)` zu übergeben ist sauberer, als `(buffer, start, length)` durch jeden Aufruf zu fädeln, und die Grenzen werden einmal beim Slice geprüft.

```csharp
// .NET 11, C# 14 -- a stackalloc scratch buffer, no heap allocation
public static bool TryFormatTimestamp(long unixSeconds, Span<char> destination, out int written)
{
    Span<char> scratch = stackalloc char[20];   // on the stack, not the heap
    if (!unixSeconds.TryFormat(scratch, out int n))
    {
        written = 0;
        return false;
    }
    return scratch.Slice(0, n).TryCopyTo(destination)
        ? (written = n) >= 0
        : Fail(out written);

    static bool Fail(out int w) { w = 0; return false; }
}
```

Es gibt einen echten Leistungsgrund jenseits der Allokation. Der JIT kann oft die Grenzprüfungen eliminieren, wenn er einen `Span<T>` direkt durchläuft, weil die Länge des Spans direkt verfügbar ist und die Schleifenform erkennbar ist. Das Durchlaufen eines `List<T>` über seinen Enumerator führt bei jedem `MoveNext` eine Versionsprüfung und eine Grenzprüfung aus. Wir messen das weiter unten.

Eine häufige Brücke: Wenn Sie bereits ein `List<T>` haben und Span-Leistung für einen heißen Lesezugriff oder eine In-Place-Mutation wollen, kopieren Sie es nicht. Rufen Sie `CollectionsMarshal.AsSpan(list)` auf, um einen `Span<T>` direkt über das zugrunde liegende Array der Liste zu erhalten. Diese Sicht ist nur gültig bis zur nächsten Operation, die die Liste vergrößert, also verwenden Sie sie und verwerfen Sie sie.

## Wann ReadOnlySpan<T> zu wählen ist

`ReadOnlySpan<T>` ist der richtige Parametertyp für jede synchrone Methode, die einen Puffer liest und ihn nicht mutieren muss. Gemäß Microsofts [Memory- und Span-Nutzungsrichtlinien](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines) lautet Regel eins "Bevorzugen Sie für eine synchrone API `Span<T>` gegenüber `Memory<T>`", und Regel zwei "Verwenden Sie `ReadOnlySpan<T>`, wenn der Puffer schreibgeschützt sein soll." Das meiste Parsen und Suchen ist schreibgeschützt.

- **Strings slicen, ohne Teilstrings zu allokieren.** `"2026-05-25".AsSpan(0, 4)` gibt Ihnen das Jahr als `ReadOnlySpan<char>` ohne einen neuen `string`. `int.Parse` und Verwandte haben Span-Überladungen, also können Sie direkt aus dem Slice parsen.
- **UTF-8-Literale.** `"GET"u8` ist ein `ReadOnlySpan<byte>`, der in die Assembly eingebacken ist. Einen eingehenden Byte-Puffer dagegen zu vergleichen, ist allokationsfrei.
- **Jede Pufferform akzeptieren.** Eine Methode, die `ReadOnlySpan<byte>` nimmt, kann mit einem `byte[]`, einem `ArraySegment<byte>`, einem `stackalloc`-Puffer oder einem Slice aufgerufen werden, ohne Überladungen. In C# 14 ist die Array-zu-Span-Konvertierung implizit, also schreiben die Aufrufer nicht einmal `.AsSpan()`.

```csharp
// .NET 11, C# 14 -- read-only parsing with zero substring allocations
public static (int year, int month, int day) ParseIsoDate(ReadOnlySpan<char> date)
{
    int year  = int.Parse(date.Slice(0, 4));
    int month = int.Parse(date.Slice(5, 2));
    int day   = int.Parse(date.Slice(8, 2));
    return (year, month, day);
}

// All three callers work; none allocate a substring.
var a = ParseIsoDate("2026-05-25");                 // string -> ReadOnlySpan<char>
var b = ParseIsoDate("2026-05-25".AsSpan());         // explicit
Span<char> buf = stackalloc char[10];
"2026-05-25".CopyTo(buf);
var c = ParseIsoDate(buf);                            // Span<char> -> ReadOnlySpan<char>
```

Beachten Sie, dass ein `Span<T>` implizit in einen `ReadOnlySpan<T>` konvertiert wird, niemals umgekehrt. Nehmen Sie den restriktivsten Typ, den Ihre Methode tatsächlich braucht: Wenn Sie nur lesen, fordern Sie `ReadOnlySpan<T>` an, damit jeder Aufrufer, veränderlich oder nicht, Sie erreichen kann. Das passt natürlich zu [SearchValues<T> für schnelle Mehrfach-Suche](/de/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/), das vollständig um `ReadOnlySpan<T>`-Eingaben herum gebaut ist.

## Der Benchmark: 10.000 Ints summieren

Die Leistungsbehauptung ist spezifisch: Das Durchlaufen eines `Span<T>` oder `ReadOnlySpan<T>` ist schneller als das Durchlaufen eines `List<T>`, weil der JIT die Grenzprüfungen pro Element beim Span eliminiert und der Listen-Enumerator nicht. Hier ist die Messung.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x
// dotnet run -c Release
[MemoryDiagnoser]
public class SumBench
{
    private List<int> _list = null!;
    private int[] _array = null!;

    [GlobalSetup]
    public void Setup()
    {
        _array = Enumerable.Range(0, 10_000).ToArray();
        _list = new List<int>(_array);
    }

    [Benchmark(Baseline = true)]
    public long ListForeach()
    {
        long sum = 0;
        foreach (int x in _list) sum += x;   // List<T>.Enumerator: version + bounds check
        return sum;
    }

    [Benchmark]
    public long SpanForeach()
    {
        long sum = 0;
        Span<int> span = CollectionsMarshal.AsSpan(_list);  // view, no copy
        foreach (int x in span) sum += x;                   // bounds checks elided
        return sum;
    }

    [Benchmark]
    public long ReadOnlySpanForeach()
    {
        long sum = 0;
        ReadOnlySpan<int> span = _array;     // C# 14 implicit conversion
        foreach (int x in span) sum += x;
        return sum;
    }
}
```

Repräsentative Ergebnisse auf einem Ryzen 7 / Windows 11 / .NET 11-Build, x64 RyuJIT:

| Methode               | Mittelwert | Ratio | Allokiert |
| --------------------- | ---------- | ----- | --------- |
| `ListForeach`         | 6,1 us     | 1,00  | 0 B       |
| `SpanForeach`         | 2,4 us     | 0,39  | 0 B       |
| `ReadOnlySpanForeach` | 2,4 us     | 0,39  | 0 B       |

Ungefähr 2,5x schneller für die Span-Schleife, mit null Allokation in allen drei (die Liste existiert bereits; `CollectionsMarshal.AsSpan` kopiert nicht). Das genaue Verhältnis verschiebt sich mit dem Elementtyp und der CPU, aber die Richtung ist stabil: Der Span-Enumerator ist eine schlanke, `ref`-durchlaufende Schleife, die der JIT hart optimiert, während `List<T>.Enumerator` die Versionsprüfung trägt, die gleichzeitige Änderung erkennt. Diese Versionsprüfung ist eine Funktion, keine Verschwendung (sie ist der Grund, warum `List<T>` eine `InvalidOperationException` wirft, wenn Sie es während der Iteration mutieren), aber sie kostet Zyklen, die der Span nie zahlt.

Der ehrliche Vorbehalt: Für eine Summe von 10.000 Elementen sind das Mikrosekunden. Wenn Ihre Schleife nicht heiß ist, verbiegen Sie Ihren Code nicht, um 4 Mikrosekunden zu sparen. Spans verdienen sich ihren Platz in heißen inneren Schleifen, Parsern und Serialisierern, die millionenfach laufen, nicht beim gelegentlichen Durchlaufen einer Liste.

## Die Stolperfallen, die für Sie entscheiden

Drei Einschränkungen übersteuern den Geschmack vollständig, und alle drei kommen daher, dass `Span<T>` und `ReadOnlySpan<T>` `ref struct`-Typen sind.

**Ein `await` im Geltungsbereich schließt Spans aus.** Eine lokale `ref struct`-Variable kann ein `await` nicht überleben, weil der Compiler sie in eine auf dem Heap allokierte Zustandsmaschine heben müsste, was ein reiner Stack-Typ verbietet. Der Compiler lehnt es rundheraus ab. Wenn Ihre Methode wartet (await) und einen Puffer braucht, der das await überspannt, verwenden Sie `Memory<T>` / `ReadOnlyMemory<T>` (die heap-freundlichen Verwandten) oder ein `List<T>` / Array. Siehe [wie man T[] in ReadOnlyMemory<T> konvertiert](/de/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) für die await-sicheren Sichttypen.

**Ein Feld, eine Rückgabe über async oder ein Closure schließt Spans aus.** Sie können nicht `class C { Span<int> _buf; }` schreiben. Sie können einen Span nicht in einem Lambda erfassen. Sie können keinen aus einem `async Task<Span<int>>` zurückgeben. In dem Moment, in dem Ihr Design verlangt, dass der Puffer den aktuellen Stack-Frame verlässt, lautet die Antwort `List<T>` oder `T[]`, möglicherweise mit einem `Memory<T>`-Handle für async.

**Ein generischer Kontext vor C# 13 schränkt Spans ein.** Vor C# 13 konnten Sie `Span<T>` überhaupt nicht als generisches Typargument verwenden. Mit der `allows ref struct`-Anti-Constraint von C# 13 können Sie es, aber nur, wenn die generische Methode oder der generische Typ sich mit `where T : allows ref struct` dafür entscheidet. Eine generische API, die sich nicht dafür entschieden hat, kann immer noch keinen Span nehmen. `List<T>` hat keine solche Einschränkung; es ist eine gewöhnliche Klasse.

Es gibt auch eine subtile Lebensdauer-Falle bei `CollectionsMarshal.AsSpan`. Der Span, den es zurückgibt, zeigt auf das aktuelle zugrunde liegende Array der Liste. Wenn Sie dann genug `Add` aufrufen, um eine Größenänderung auszulösen, allokiert die Liste ein neues Array, und Ihr Span zeigt nun auf das alte, jetzt verwaiste. Behandeln Sie diesen Span nur bis zum nächsten mutierenden Aufruf der Liste als gültig.

## Die Empfehlung, neu formuliert

Standardmäßig `List<T>`. Es ist die Sammlung, die Sie wachsen lassen, speichern, zurückgeben, über await hinweg führen und erfassen, und auf .NET 11 ist es für alles, was kein gemessener heißer Pfad ist, mehr als schnell genug. Steigen Sie zu `Span<T>` ab, wenn Sie eine veränderliche, allokationsfreie Sicht auf einen Puffer wollen, den Sie bereits besitzen und den Sie innerhalb einer einzigen synchronen Methode verwenden und verwerfen, besonders mit `stackalloc` oder In-Place-Slicing. Verwenden Sie `ReadOnlySpan<T>` als Parametertyp für jeden synchronen Leser und als Rückgabe von String-Slicing und `u8`-Literalen, damit Sie parsen und suchen, ohne Teilstrings zu allokieren. Wenn ein Span ideal wäre, aber ein `await`, ein Feld oder ein Closure im Weg steht, greifen Sie zu `Memory<T>` / `ReadOnlyMemory<T>` oder bleiben Sie bei `List<T>`. Die kürzeste korrekte Version: besitzen und wachsen bedeutet `List<T>`; betrachten und mutieren bedeutet `Span<T>`; betrachten und lesen bedeutet `ReadOnlySpan<T>`.

## Verwandt

- [Implizite Span-Konvertierungen in C# 14: erstklassige Unterstützung für Span und ReadOnlySpan](/de/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) behandelt die Konvertierungen, die es Aufrufern ermöglichen, `.AsSpan()` wegzulassen.
- [Wie man T[] in ReadOnlyMemory<T> in C# konvertiert](/de/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) ist das await-sichere Gegenstück, wenn ein Span ein `await` nicht überqueren kann.
- [Wie man SearchValues<T> in .NET 11 korrekt verwendet](/de/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) baut auf `ReadOnlySpan<T>` für eine schnelle Mehrzeichen-Suche auf.
- [Wie man eine große CSV in .NET 11 liest, ohne den Speicher zu erschöpfen](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) stützt sich auf Span-Slicing, um ohne Kopieren zu parsen.
- [C# 13: das Ende der params-Allokationen](/de/2026/01/c-13-the-end-of-params-allocations/) erklärt `params ReadOnlySpan<T>`, die allokationsfreien `params`, die Spans möglich machen.

## Quellen

- [Memory<T>- und Span<T>-Nutzungsrichtlinien (MS Learn)](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [System.Span<T>-Struct-Referenz (MS Learn)](https://learn.microsoft.com/dotnet/api/system.span-1)
- [System.ReadOnlySpan<T>-Struct-Referenz (MS Learn)](https://learn.microsoft.com/dotnet/api/system.readonlyspan-1)
- [allows ref struct Anti-Constraint (MS Learn, C# 13-Vorschlag)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-13.0/ref-struct-interfaces)
- [CollectionsMarshal.AsSpan-Referenz (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan)
- [List<T>-Klassen-Referenz (MS Learn)](https://learn.microsoft.com/dotnet/api/system.collections.generic.list-1)
