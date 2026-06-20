---
title: "Was ist Span<T> in C#, und wann macht es Ihren Code wirklich schneller?"
description: "Span<T> ist ein nur auf dem Stack lebender ref struct, der auf Speicher zeigt, den Sie bereits besitzen, also keine eigene Allokation hat. Es beschleunigt Code in genau drei Situationen: einen Heap-Puffer durch stackalloc ersetzen, ohne Kopieren zerteilen und enge Schleifen, in denen der JIT die Bereichsprüfungen entfernt. Überall sonst ändert es nichts, und über ein await hinweg kompiliert es nicht."
pubDate: 2026-06-20
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
lang: "de"
translationOf: "2026/06/what-is-span-and-when-does-it-make-my-code-faster"
translatedBy: "claude"
translationDate: 2026-06-20
---

`Span<T>` ist ein nur auf dem Stack lebender `ref struct`, der eine zusammenhängende Speicherregion darstellt, die Sie bereits besitzen: ein Array, einen Ausschnitt davon, einen `stackalloc`-Puffer, ein Stück einer Zeichenfolge oder nicht verwalteten Speicher. Es ist eine verwaltete Referenz plus eine Länge, mehr nicht. Es allokiert nicht, es kopiert nicht und es kann nicht wachsen. Das ist der gesamte Typ. Der Grund, warum Entwickler dazu greifen, ist Leistung, aber er macht Code nur in drei konkreten Situationen schneller: wenn er es Ihnen erlaubt, eine Heap-Allokation durch `stackalloc` zu ersetzen, wenn er es Ihnen erlaubt, einen Puffer ohne Kopieren zu zerteilen, und wenn er eine Schleife in eine Form bringt, aus der der JIT die Bereichsprüfungen entfernen kann. Außerhalb davon ist ein Span ein Werkzeug für Klarheit, kein Werkzeug für Leistung, und ihn in Code zu zwingen, der keines der drei tut, bringt Ihnen nichts. Dieser Artikel zielt auf .NET 11 und C# 14 ab, obwohl `Span<T>` selbst seit .NET Core 2.1 in der BCL und seit C# 7.2 in der Sprache ist.

Die Falle ist, dass "Verwenden Sie `Span<T>`, es ist schneller" ohne die zweite Hälfte des Satzes wiederholt wird. Also gebe ich Ihnen die zweite Hälfte: was der Typ wirklich ist, die genauen Mechanismen, durch die er Zyklen spart, und die ebenso wichtige Liste von Fällen, in denen das Einsetzen eines Spans den generierten Code um näherungsweise null verändert.

## Eine Sicht auf den Speicher, kein Container

Das mentale Modell, das die meiste Verwirrung beseitigt: `Span<T>` ist keine Sammlung. Es ist ein Fenster. Eine `List<T>` oder ein `T[]` besitzen ihren Speicher, leben auf dem Heap, und die Garbage Collection verfolgt sie. Ein `Span<T>` besitzt nichts. Es hält eine Referenz auf den Anfang eines bestimmten Speichers und eine Zählung, wie viele Elemente gültig sind. Erzeugen Sie einen, und es geschieht keine Allokation, weil es nichts zu allokieren gibt: die Bytes existieren bereits irgendwo, und der Span benennt lediglich einen Abschnitt davon.

```csharp
// .NET 11, C# 14
int[] numbers = { 10, 20, 30, 40, 50 };

Span<int> all = numbers;          // a view over the whole array, no copy
Span<int> middle = all.Slice(1, 3); // {20, 30, 40}, still the same backing memory

middle[0] = 99;                   // writes THROUGH to numbers[1]
Console.WriteLine(numbers[1]);    // 99
```

`middle` hat keine drei Ganzzahlen kopiert. Es ist eine Referenz auf `numbers[1]` plus die Länge `3`. Das Schreiben durch ihn schreibt in das ursprüngliche Array, weil es nur ein Array gibt. Dieses Aliasing ist genau der Sinn: ein Span ist ein günstiger, typisierter und bereichsgeprüfter Handle auf Speicher, der anderswo lebt.

Da die Laufzeit garantiert, dass ein `ref struct` nur auf dem Stack leben kann, ist ein Span sicher, um auf Stack-Speicher (einen `stackalloc`-Puffer) zu zeigen, ohne die Lebensdauer-Gefahren, die eine Heap-Referenz auf Stack-Speicher schaffen würde. Eben diese Garantie ist die Quelle jeder Einschränkung des Typs, zu der wir kommen werden. Zuerst der Teil, für den Sie gekommen sind.

## Woher die Geschwindigkeit tatsächlich kommt

Ein Span macht Code durch drei verschiedene Mechanismen schneller. Sie sind unabhängig: ein gegebenes Stück Code könnte einen, zwei oder keinen treffen. Trifft es keinen, dann tut der Span nichts für Ihre Laufzeit.

### Mechanismus 1: er erlaubt Ihnen, überhaupt nicht zu allokieren

Das ist der große, und eigentlich ist es nicht der Span, der die Arbeit macht. Der Span ist der sichere Handle, der `stackalloc` nutzbar macht. Ein kleiner Scratch-Puffer (eine Zahl formatieren, einen Suchschlüssel bauen, ein paar Bytes hashen) bedeutete traditionell ein `new byte[n]` oder `new char[n]` auf dem Heap, das der GC dann einsammeln muss. Mit `stackalloc` lebt der Puffer im Stack-Frame und verschwindet kostenlos, wenn die Methode zurückkehrt. Der `Span<T>` ist die Art, wie Sie diesen Stack-Speicher sicher lesen und schreiben.

```csharp
// .NET 11, C# 14 -- format an int to text with zero heap allocation
public static string ToHex(int value)
{
    Span<char> buffer = stackalloc char[8];   // on the stack, not the heap
    value.TryFormat(buffer, out int written, "X");
    return new string(buffer[..written]);     // the only allocation is the final string
}
```

Der Gewinn wird in GC-Druck gemessen, nicht in roher Schleifengeschwindigkeit. Allokieren Sie eine Million winziger Wegwerf-Puffer pro Sekunde, und Sie erzeugen eine Million Objekte, die der Gen-0-Collector durchlaufen muss. Verschieben Sie sie nach `stackalloc`, und dieser Druck geht auf null. In einem heißen Pfad ist das Entfernen von Allokationen oft ein größerer Ende-zu-Ende-Gewinn als das Einsparen von Instruktionen aus einer Schleife, weil GC-Pausen den gesamten Prozess betreffen, nicht nur Ihre Methode. Das ist derselbe Instinkt hinter [params ReadOnlySpan<T>, das die params-Allokationen beseitigt](/de/2026/01/c-13-the-end-of-params-allocations/): die schnellste Allokation ist die, die nie geschieht.

### Mechanismus 2: er erlaubt Ihnen, ohne Kopieren zu zerteilen

Der zweite Mechanismus ist `Slice`. Auf einer `string` allokiert das Nehmen einer Teilzeichenfolge mit `Substring` eine brandneue `string` und kopiert die Zeichen. Auf einem Array kopieren `GetRange` oder LINQs `Skip`/`Take`, die sich zu einer neuen Sammlung materialisieren, ebenfalls. Das `Slice` eines Spans tut keines von beiden: es gibt einen weiteren Span zurück, der auf denselben Speicher zeigt, mit angepasstem Offset und angepasster Länge. Null Kopie, null Allokation.

```csharp
// .NET 11, C# 14 -- parse "2026-06-20" with no substring allocations
public static (int Year, int Month, int Day) ParseIsoDate(ReadOnlySpan<char> date)
{
    int year  = int.Parse(date.Slice(0, 4));  // no new string
    int month = int.Parse(date.Slice(5, 2));
    int day   = int.Parse(date.Slice(8, 2));
    return (year, month, day);
}

var parsed = ParseIsoDate("2026-06-20");      // string converts to ReadOnlySpan<char> implicitly
```

Jedes `int.Parse` hier liest direkt aus einem Ausschnitt der ursprünglichen Zeichenfolge. Die alte Version mit `date.Substring(0, 4)` würde drei kurzlebige Zeichenfolgen pro Aufruf allokieren. In einem Parser, der über Millionen Zeilen läuft, sind das Millionen vermiedener Allokationen. Die Span-Überladungen von `int.Parse`, `DateTime.Parse`, `Guid.Parse` und Konsorten existieren genau, damit Sie aus Ausschnitten parsen können, ohne je eine Teilzeichenfolge zu materialisieren. Das ist das Rückgrat des schnellen Parsens von CSV und Logs, weshalb [das Lesen einer großen CSV ohne Speicherüberlauf](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) sich auf das Zerteilen mit Spans stützt, um jede Zeile an Ort und Stelle zu durchlaufen.

### Mechanismus 3: der JIT entfernt die Bereichsprüfungen in engen Schleifen

Der dritte Mechanismus ist der subtilste und derjenige, den Entwickler am häufigsten beschwören, ohne ihn zu verstehen. Wenn Sie einen Span mit einer `for`-Schleife durchlaufen, die durch `span.Length` begrenzt ist, kann der JIT beweisen, dass jeder Index im Bereich liegt, und die Bereichsprüfung pro Element vollständig entfernen. Er erkennt das Muster `for (int i = 0; i < span.Length; i++)` und weiß, dass `span[i]` nicht außerhalb des Bereichs liegen kann, also verwirft er den Vergleich und die Verzweigung, die sonst jeden Zugriff schützen würden. Microsofts JIT-Team hat Jahre damit verbracht, RyuJIT beizubringen, die Bereichsprüfungen eines Spans genauso zu erkennen wie die eines Arrays, und .NET 10 machte die zugrunde liegende Assertions-Analyse weniger reihenfolgeabhängig, damit mehr Schleifenformen qualifizieren, wie der Artikel [Performance Improvements in .NET 10](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/) dokumentiert.

Vergleichen Sie das mit dem Durchlaufen einer `List<T>` über ihren Enumerator. `List<T>.Enumerator.MoveNext` führt bei jedem Schritt eine Versionsprüfung aus (der Mechanismus, der `InvalidOperationException` wirft, wenn Sie die Liste mitten in der Iteration verändern) plus eine Bereichsprüfung. Diese Versionsprüfung ist eine Korrektheitsfunktion, keine Verschwendung, aber sie kostet Zyklen, die ein Span nie zahlt.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x -- dotnet run -c Release
[MemoryDiagnoser]
public class SumBench
{
    private List<int> _list = null!;

    [GlobalSetup]
    public void Setup() => _list = new List<int>(Enumerable.Range(0, 10_000));

    [Benchmark(Baseline = true)]
    public long ListForeach()
    {
        long sum = 0;
        foreach (int x in _list) sum += x;   // version + bounds check per step
        return sum;
    }

    [Benchmark]
    public long SpanForeach()
    {
        long sum = 0;
        Span<int> span = CollectionsMarshal.AsSpan(_list);  // a view, no copy
        foreach (int x in span) sum += x;                   // bounds checks elided
        return sum;
    }
}
```

Repräsentative Ergebnisse auf einem Ryzen 7 / Windows 11 / .NET 11 Build, x64 RyuJIT:

| Method        | Mean   | Ratio | Allocated |
| ------------- | ------ | ----- | --------- |
| `ListForeach` | 6.1 us | 1.00  | 0 B       |
| `SpanForeach` | 2.4 us | 0.39  | 0 B       |

Etwa 2,5-mal schneller, ohne Allokation in beiden (die Liste existiert bereits; `CollectionsMarshal.AsSpan` gibt Ihnen einen Span über ihr Backing-Array, ohne zu kopieren). Das genaue Verhältnis verschiebt sich mit dem Elementtyp und der CPU, aber die Richtung ist stabil. Beachten Sie jedoch die Einheit: das sind Mikrosekunden über 10.000 Elemente. Diese Zahl ist der ganze Grund für den nächsten Abschnitt.

## Wann Span<T> nichts für Sie tut

Hier ist der Teil, den die Cargo-Cult-Version dieses Ratschlags weglässt. Ein Span hilft nur, wenn einer dieser drei Mechanismen im Spiel ist. Setzen Sie ihn in Code ein, der keinen auslöst, und Sie haben stärker eingeschränkten Code für eine identische Laufzeit geschrieben. Schlimmer noch, Sie haben ihn vielleicht langsamer gemacht oder das Kompilieren verhindert.

**Sie konvertieren zu einem Span und kopieren sofort heraus.** Wenn Ihre "Optimierung" `array.AsSpan().ToArray()` ist oder einen Span nur zu zerteilen, um das Ergebnis mit `.ToArray()` zu erfassen, haben Sie ohnehin allokiert. Die Kopie ist die Kosten; der Span davor hat nichts gebracht. Der Gewinn aus Mechanismus 2 existiert nur, solange Sie weiter durch die Sicht lesen.

**Die Schleife ist nicht heiß.** Mechanismus 3 sparte 3,7 Mikrosekunden über 10.000 Elemente. Wenn diese Schleife einmal pro Web-Anfrage oder ein paar hundert Mal insgesamt läuft, werden Sie den Unterschied nie gegen die Netzwerk- und Datenbanklatenz messen, die ihn um fünf Größenordnungen in den Schatten stellt. Lesbaren Code zu verbiegen, um Mikrosekunden aus einem kalten Pfad zu schneiden, ist ein Nettoverlust: Sie zahlen in Klarheit und Einschränkungen für eine Beschleunigung, die niemand beobachten kann. Spans verdienen ihren Platz in Parsern, Serialisierern und inneren Schleifen, die Millionen Male laufen, nicht im gelegentlichen Durchlauf einer Sammlung.

**Sie hatten bereits ein Array und lesen es nur sequenziell.** Ein einfaches `foreach` über ein `T[]` erhält bereits die Bereichsprüfungs-Entfernung des JIT; Arrays sind der ursprüngliche Fall, für den diese Optimierung gebaut wurde. Das Array zuerst in einen Span zu hüllen, macht die Schleife nicht schneller, weil die Array-Schleife bereits schnell war. Der Span hilft, wenn die Quelle eine `List<T>` ist (deren Enumerator die Versionsprüfung trägt) oder wenn Sie zerteilen müssen, nicht, wenn Sie bereits ein Array halten und es von Anfang bis Ende durchlaufen.

**Sie erzwingen ein `stackalloc`, das zu groß ist.** Mechanismus 1 gewinnt nur bei kleinen Puffern. Ein `stackalloc` mit großer oder aufruferseitig kontrollierter Größe riskiert einen Stapelüberlauf, der ein Absturz ist, kein langsamer Pfad. Die übliche Empfehlung ist, `stackalloc` auf eine kleine Konstante zu begrenzen (üblicherweise ein paar hundert Bytes bis ~1 KB) und darüber auf ein gepooltes oder Heap-Array zurückzufallen. Ein Span über ein zu großes `stackalloc` ist nicht schneller, er ist eine latente `StackOverflowException`.

Der ehrliche Test, bevor Sie zu einem Span greifen: welchen der drei Mechanismen kaufe ich? Wenn Sie keinen benennen können, greifen Sie aus Gewohnheit zum Typ. Der [Entscheidungsleitfaden List vs Span vs ReadOnlySpan](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) geht die vollständige Besitz- und Lebensdauer-Achse durch, wenn Sie zwischen ihnen für ein bestimmtes Feld oder einen bestimmten Rückgabewert wählen.

## Die Einschränkungen und warum es sie gibt

Jede Einschränkung von `Span<T>` folgt aus einer Tatsache: es ist ein `ref struct`, also zwingt die Laufzeit es, nur auf dem Stack zu leben. Das ist es, was es sicher macht, auf `stackalloc`-Speicher zu zeigen, und es ist nicht verhandelbar.

**Es kann kein `await` oder `yield` überschreiten.** Wenn eine Methode awaited, hebt der Compiler jede lokale Variable, die das await überlebt, in eine auf dem Heap allokierte Zustandsmaschine. Ein nur auf dem Stack lebender Typ kann nicht gehoben werden, also lehnt der Compiler eine lokale `Span<T>`-Variable ab, die ein `await` überspannt. Das ist die Einschränkung, auf die Entwickler zuerst stoßen. Wenn Sie einen Puffer brauchen, der eine asynchrone Grenze überschreitet, verwenden Sie `Memory<T>` oder `ReadOnlyMemory<T>`, die heap-freundlichen Verwandten; [ein Array in ReadOnlyMemory<T> konvertieren](/de/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) behandelt die await-sicheren Sichttypen.

**Es kann kein Feld einer Klasse sein, geboxt oder in einer Lambda erfasst werden.** Sie können nicht `class C { Span<int> _buf; }` schreiben, können einen Span nicht `object` zuweisen und nicht in einer Closure über einen schließen. Jedes dieser Dinge würde den Span aus seinem Stack-Frame entkommen lassen, was der Typ verbietet. In dem Moment, in dem Ihr Entwurf verlangt, dass die Sicht die aktuelle Methode überlebt, ist die Antwort eine `List<T>`, ein `T[]` oder ein `Memory<T>`-Handle.

**Generische Verwendung benötigt `allows ref struct`.** Vor C# 13 konnten Sie `Span<T>` überhaupt nicht als generisches Typargument verwenden. Die `allows ref struct`-Anti-Constraint von C# 13 hob das auf, aber nur für generische Methoden und Typen, die sich explizit mit `where T : allows ref struct` dafür entscheiden. Eine ältere generische API, die sich nicht dafür entschieden hat, kann immer noch keinen Span nehmen.

**Eine `CollectionsMarshal.AsSpan`-Sicht ist nur gültig, bis die Liste ihre Größe ändert.** Dieser Span zeigt auf das aktuelle Backing-Array der Liste. Fügen Sie mit `Add` genug hinzu, um eine Größenänderung auszulösen, und die Liste allokiert ein neues Array und lässt Ihren Span auf das alte, nun verwaiste zeigen. Verwenden Sie einen solchen Span sofort und verwerfen Sie ihn; halten Sie ihn nie über einen verändernden Aufruf der Liste hinweg.

Eine weitere Annehmlichkeit kam in C# 14: Arrays konvertieren sich nun implizit zu Spans, also schreiben Sie `ReadOnlySpan<char> s = "GET"u8` und übergeben `myArray`, wo ein Span erwartet wird, ohne ein sichtbares `.AsSpan()`. Der Artikel [implizite Span-Konvertierungen in C# 14](/de/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) behandelt genau, welche Konvertierungen der Compiler nun für Sie vornimmt.

## Die Kurzfassung

`Span<T>` ist eine allokationsfreie, nur auf dem Stack lebende Sicht auf Speicher, den Sie bereits besitzen. Es macht Code auf drei spezifische Arten schneller: es erlaubt Ihnen, Heap-Puffer durch `stackalloc` zu ersetzen, es erlaubt Ihnen, Zeichenfolgen und Arrays ohne Kopieren zu zerteilen, und es gibt dem JIT eine Schleifenform, aus der er Bereichsprüfungen entfernen kann. Diese Gewinne sind real und groß in Parsern, Serialisierern und heißen inneren Schleifen, die Millionen Male laufen. Sie sind unsichtbar in kalten Pfaden und verdampfen vollständig, wenn Sie aus dem Span herauskopieren, wenn Ihre Quelle bereits ein Array ist, das Sie sequenziell durchlaufen, oder wenn es gar keine gemessene heiße Schleife gibt. Und da es ein `ref struct` ist, stoppt es beim ersten `await`, Feld oder Closure in Ihrem Entwurf. Greifen Sie dazu, wenn Sie benennen können, welchen der drei Mechanismen Sie kaufen. Wenn Sie es nicht können, fügen Sie Einschränkungen für eine Beschleunigung hinzu, die nicht da ist.

## Verwandt

- [List<T> vs Span<T> vs ReadOnlySpan<T> in C#: wann welcher Typ](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) ist der Entscheidungsleitfaden, wenn Sie zwischen den dreien für ein bestimmtes Feld oder einen bestimmten Rückgabewert wählen.
- [Wie man T[] in ReadOnlyMemory<T> in C# konvertiert](/de/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/) ist der await-sichere Weg, wenn ein Span kein `await` überschreiten kann.
- [Wie man SearchValues<T> in .NET 11 korrekt verwendet](/de/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) baut auf `ReadOnlySpan<T>` für SIMD-beschleunigte Mehrfachsuche auf.
- [Wie man eine große CSV in .NET 11 ohne Speicherüberlauf liest](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) parst jede Zeile an Ort und Stelle mit Span-Zerteilung.
- [Implizite Span-Konvertierungen in C# 14](/de/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) behandelt die Konvertierungen, die es Aufrufern erlauben, `.AsSpan()` wegzulassen.

## Quellen

- [System.Span<T> Struct-Referenz (MS Learn)](https://learn.microsoft.com/dotnet/api/system.span-1)
- [Nutzungsrichtlinien für Memory<T> und Span<T> (MS Learn)](https://learn.microsoft.com/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Performance Improvements in .NET 10 (.NET Blog)](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-10/)
- [allows ref struct Anti-Constraint (MS Learn, C# 13)](https://learn.microsoft.com/dotnet/csharp/language-reference/proposals/csharp-13.0/ref-struct-interfaces)
- [CollectionsMarshal.AsSpan Referenz (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan)
