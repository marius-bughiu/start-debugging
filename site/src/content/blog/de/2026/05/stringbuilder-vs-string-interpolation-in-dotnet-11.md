---
title: "StringBuilder vs. String-Interpolation in .NET 11: Was sollten Sie verwenden?"
description: "Verwenden Sie String-Interpolation, um einen festen Satz von Werten in einem Schritt zusammenzusetzen; verwenden Sie StringBuilder, wenn Sie in einer Schleife oder über eine unbekannte Anzahl von Fragmenten anhängen. Die Trennlinie ist die Schleife, nicht die Anzahl der Werte."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "performance"
  - "strings"
lang: "de"
translationOf: "2026/05/stringbuilder-vs-string-interpolation-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-25
---

Verwenden Sie String-Interpolation (`$"..."`), wenn Sie eine Zeichenfolge aus einem festen, bekannten Satz von Werten zusammensetzen: eine Log-Zeile, eine URL, eine Nachricht. Verwenden Sie `StringBuilder`, wenn Sie in einer Schleife oder über eine unbekannte Anzahl von Fragmenten anhängen. Die Trennlinie ist die Schleife, nicht wie viele Werte Sie haben. Ein einzelnes `$"{a} {b} {c} {d}"` ist schneller und klarer als das Hochfahren eines `StringBuilder`; tausend Iterationen von `result += item` sind das einzige Muster, das Ihnen tatsächlich schadet, und genau dafür existiert `StringBuilder`. Die beiden sind keine echten Konkurrenten, und die falsche Wahl in einer der beiden Richtungen kostet Sie entweder Lesbarkeit oder quadratische Allokationen.

Dieser Artikel richtet sich an .NET 11 und C# 14, aber die wichtigste Tatsache ist älter: Seit C# 10 und .NET 6 wandelt der Compiler eine interpolierte Zeichenfolge in einen `DefaultInterpolatedStringHandler` um (Lowering) statt in `string.Format`. Diese eine Änderung verschob die String-Interpolation von "bequem, aber langsam" zu "bequem und schnell für eine einzelne Zusammensetzung". `StringBuilder` ist seit .NET Framework 1.1 in der BCL und hat seine Grundlagen nicht geändert, erhielt aber in .NET 6 ebenfalls eine interpolationsbewusste `Append`-Überladung, die hier wichtig ist.

## Es sind nicht zwei Wege, dasselbe zu tun

Der Vergleich wird als Versus dargestellt, weil beide Zeichenfolgen erzeugen, aber sie beantworten unterschiedliche Fragen.

String-Interpolation beantwortet "Ich habe diese Werte, gib mir eine Zeichenfolge". Sie ist ein Ausdruck. `$"User {id} logged in at {time}"` wird zu einer `string` ausgewertet, unveränderlich, in einem Schritt. Sie können dem Ergebnis später nichts anhängen; wenn Sie eine andere Zeichenfolge brauchen, schreiben Sie eine weitere Interpolation.

`StringBuilder` beantwortet "Ich werde im Lauf der Zeit Zeichenfolgenfragmente erzeugen, möglicherweise in einer Schleife, und ich möchte nicht bei jedem Schritt eine neue Zeichenfolge allozieren". Es ist ein veränderbarer Puffer. Sie hängen mit `Append` so oft an, wie Sie möchten, und rufen dann am Ende einmal `ToString()` auf. Sein gesamter Daseinsgrund ist, dass String in .NET unveränderlich ist, sodass naive Verkettung in einer Schleife die gesamte angesammelte Zeichenfolge bei jeder Iteration neu alloziert.

Die eigentliche Frage lautet also fast nie "Interpolation oder StringBuilder für diese eine Zeile". Sie lautet "Baue ich diese Zeichenfolge in einem Ausdruck auf, oder sammle ich sie über viele Schritte an". Treffen Sie diese Achse richtig, und die Wahl ergibt sich automatisch.

## Wozu `$"..."` in .NET 6+ tatsächlich kompiliert

Wer gelernt hat, dass "String-Interpolation nur `string.Format` unter der Haube ist", arbeitet mit Wissen aus der Zeit vor .NET 6, und das führt dazu, zum `StringBuilder` zu greifen, wenn man ihn nicht braucht.

Vor C# 10 wandelte der Compiler `$"Hello {name}"` in `string.Format("Hello {0}", name)` um. Das parste die Formatzeichenfolge zur Laufzeit, boxte Werttyp-Argumente in ein `object[]` und allozierte. Seit C# 10 und .NET 6 wandelt der Compiler denselben Ausdruck in eine Folge direkter Aufrufe auf einem `DefaultInterpolatedStringHandler` um:

```csharp
// .NET 11, C# 14
// Source:
string s = $"Hello {name}, you have {count} messages";

// Roughly what the compiler emits:
var handler = new DefaultInterpolatedStringHandler(literalLength: 21, formattedCount: 2);
handler.AppendLiteral("Hello ");
handler.AppendFormatted(name);
handler.AppendLiteral(", you have ");
handler.AppendFormatted(count);   // no boxing: ISpanFormattable path
handler.AppendLiteral(" messages");
string s = handler.ToStringAndClear();
```

Drei Dinge machen es schnell. Die Formatzeichenfolge wird zur Kompilierzeit geparst, daher gibt es keine Format-Parse-Arbeit zur Laufzeit. Der Handler mietet seinen Backing-Puffer aus einem `ArrayPool<char>`, sodass im stabilen Zustand nur die endgültige Zeichenfolge alloziert wird. Und die generischen `AppendFormatted<T>`-Überladungen prüfen auf `ISpanFormattable` und formatieren Werttypen direkt in den Puffer, statt sie zu boxen und `ToString()` aufzurufen. Das Ergebnis ist, dass eine einzelne Interpolation jetzt in derselben Allokationsliga liegt wie ein handgeschriebener `StringBuilder`, mit einer Allokation für die endgültige Zeichenfolge, und meist schneller ist, weil kein `StringBuilder`-Objekt zu allozieren ist. Microsofts eigene [Ankündigung zur String-Interpolation in .NET 6](https://devblogs.microsoft.com/dotnet/string-interpolation-in-c-10-and-net-6/) geht dieses Lowering im Detail durch.

## Die Entscheidungsmatrix

Das folgende Verhalten gilt für .NET 6+ / C# 10+, sofern nicht anders angegeben; der Artikel richtet sich an .NET 11 / C# 14.

| Aspekt                              | String-Interpolation `$"..."`             | `StringBuilder`                          |
| ----------------------------------- | ----------------------------------------- | ---------------------------------------- |
| Am besten für                       | einmalige Zusammensetzung, feste Teile    | inkrementeller Aufbau, Schleifen, unbekannte Anzahl |
| Form                                | ein Ausdruck, erzeugt eine `string`       | ein veränderbares Objekt, an das Sie anhängen |
| Ergebnis                            | unveränderliche `string`                  | veränderbarer Puffer bis `ToString()`    |
| Lowering (C# 10+)                   | `DefaultInterpolatedStringHandler`        | n/a (es ist eine Klasse, die Sie aufrufen) |
| Formatzeichenfolge geparst          | zur Kompilierzeit                         | n/a                                      |
| Werttypen                           | an Ort und Stelle formatiert via `ISpanFormattable` | `Append(int)` usw. vermeiden ebenfalls Boxing |
| Allokationen, einzelne Zusammensetzung | eine endgültige `string` (gemieteter Puffer) | Builder-Objekt + `char[]` + endgültige Zeichenfolge |
| Allokationen, naive Schleife        | O(n^2) bei `s += $"..."`                 | O(n) amortisiert mit `Append`            |
| Wiederverwendbar / leerbar          | nein (jedes Mal neue Zeichenfolge)        | ja (`Clear()` und wiederverwenden)       |
| Thread-Sicherheit                   | das Ergebnis ist eine unveränderliche Zeichenfolge | nicht thread-sicher              |
| Lesbarkeit für Vorlagen             | hoch                                      | niedrig (ausführliche Aufrufketten)      |
| Verfügbar seit                      | C# 6 (Handler seit C# 10 / .NET 6)        | .NET Framework 1.1                       |

Die beiden Zeilen, die fast jeden realen Fall entscheiden, sind "Am besten für" und "Allokationen, naive Schleife". Wenn Sie eine Zeichenfolge aus einem festen Satz von Werten zusammensetzen, gewinnt die Interpolation sowohl bei Lesbarkeit als auch bei Allokationen. Wenn Sie in einer Schleife sind, gewinnt `StringBuilder`, und der Abstand ist nicht subtil.

## Wann String-Interpolation wählen

Greifen Sie zu `$"..."`, sobald die Zeichenfolge in einem einzigen Ausdruck aus Werten aufgebaut wird, die Sie bereits haben. Das ist die überwältigende Mehrheit des Codes, der Zeichenfolgen baut.

- **Log-Zeilen, Nachrichten, Ausnahmetext.** `throw new InvalidOperationException($"Order {id} is in state {state}, expected {expected}");`. Ein Ausdruck, eine Handvoll Werte, einmal gelesen. Ein `StringBuilder` ist hier reine Zeremonie und alloziert mehr, nicht weniger.
- **URLs, Dateipfade, SQL-Parameternamen, Cache-Schlüssel.** `$"/api/orders/{id}/items"`. Die Teile sind an der Aufrufstelle bekannt. Die Interpolation liest sich wie das Ergebnis.
- **Zusammensetzen von 2 bis ~10 Werten, beliebiger Typen.** Da Werttypen über `ISpanFormattable` statt Boxing gehen, zahlt das Mischen von `int`, `Guid`, `DateTime` und `string` in einer Interpolation keine Boxing-Steuer wie der alte `string.Format`-Pfad.

```csharp
// .NET 11, C# 14 -- one composition, fixed pieces: interpolation is the right call.
// Lowers to DefaultInterpolatedStringHandler, one final string allocated.
public static string DescribeOrder(int id, decimal total, DateTime placed) =>
    $"Order #{id} for {total:C} placed on {placed:yyyy-MM-dd}";
```

Wenn die gesamte Zeichenfolge in einem einzigen Ausdruck bekannt sein kann, ist das Ihr Signal. Formatspezifizierer (`{total:C}`, `{placed:yyyy-MM-dd}`) funktionieren genau wie mit `string.Format` und werden weiterhin zur Kompilierzeit geparst.

## Wann StringBuilder wählen

Greifen Sie zu `StringBuilder`, wenn Fragmente im Lauf der Zeit eintreffen, besonders innerhalb einer Schleife, oder wenn die Anzahl der Teile nicht im Voraus bekannt ist.

- **Verkettung in einer Schleife.** Eine CSV-Datei Zeile für Zeile aufbauen, einen Bericht Zeile für Zeile, ein HTML-Fragment aus einer Sammlung. Das ist der kanonische `StringBuilder`-Fall, und dort wird naive Verkettung quadratisch.
- **Bedingter Aufbau.** Sie hängen eine Klausel nur an, wenn ein Flag gesetzt ist, dann vielleicht eine weitere, dann vielleicht ein abschließendes Trennzeichen. Das in eine einzige Interpolation zu fädeln, ist unlesbar; `if (x) sb.Append(...)` ist klar.
- **Wiederverwenden eines Puffers über Iterationen hinweg.** `StringBuilder` kann mit `Clear()` geleert und wiederverwendet werden und behält dabei seine gemietete Kapazität. In einer heißen Schleife, die viele unabhängige Zeichenfolgen erzeugt, schlägt ein wiederverwendeter Builder viele kurzlebige Interpolationen bei der Allokation.

```csharp
// .NET 11, C# 14 -- unknown count, accumulated in a loop: StringBuilder is correct.
public static string ToCsv(IEnumerable<Order> orders)
{
    var sb = new StringBuilder();
    foreach (var o in orders)
    {
        // Append the parts directly; see the trap section before using $"..." here.
        sb.Append(o.Id).Append(',')
          .Append(o.Total).Append(',')
          .Append(o.Placed.ToString("yyyy-MM-dd"))
          .Append('\n');
    }
    return sb.ToString();
}
```

Eine nützliche Faustregel: Wenn Sie ein `for`, `foreach` oder `while` um den Zeichenfolgenaufbau sehen, wollen Sie fast sicher `StringBuilder`. Wenn nicht, wollen Sie fast sicher die Interpolation.

## Die Falle: `+=` in einer Schleife und `sb.Append($"...")`

Zwei Muster bringen Leute zu Fall, und beide entstehen daraus, die zwei Werkzeuge falsch zu mischen.

Das erste ist Verkettung mit `+=` innerhalb einer Schleife:

```csharp
// .NET 11, C# 14 -- DO NOT do this. O(n^2) allocations.
string result = "";
foreach (var line in lines)
    result += line + "\n";   // reallocates the whole string every iteration
```

Da String unveränderlich ist, alloziert jedes `+=` eine völlig neue Zeichenfolge, die alles bisher Angesammelte enthält. Für n Iterationen sind das O(n^2) Gesamtkopieraufwand und O(n) verworfene Zeichenfolgen. Das ist der häufigste String-Performance-Fehler in C#, und genau das soll `StringBuilder` vermeiden. Interpolation hier zu verwenden (`result += $"{line}\n"`) hilft nicht; die quadratischen Kosten liegen in der wiederholten Zuweisung, nicht in der Interpolation.

Die zweite Falle ist subtiler und war früher real: eine interpolierte Zeichenfolge an `StringBuilder.Append` zu übergeben.

```csharp
// .NET 11, C# 14 -- fine on .NET 6+, was wasteful before.
sb.Append($"{key}={value}");
```

Vor .NET 6 kompilierte dies zu `sb.Append(string.Format("{0}={1}", key, value))`, was eine Zwischenzeichenfolge baute und sie dann in den Builder kopierte, was einen Teil des Zwecks zunichtemachte. Ab .NET 6 erhielt `StringBuilder` eine `Append`-Überladung, die einen `AppendInterpolatedStringHandler` entgegennimmt, und der Compiler bevorzugt sie. Die interpolierten Teile werden nun ohne Zwischenzeichenfolge direkt an den Builder angehängt, wie Microsoft im [Breaking Change zur Auswertungsreihenfolge von StringBuilder.Append](https://learn.microsoft.com/dotnet/core/compatibility/core-libraries/6.0/stringbuilder-append-evaluation-order) dokumentiert. In .NET 11 ist `sb.Append($"{key}={value}")` für das Fragment also wirklich allokationsfrei. Der verkettete Stil `Append(o.Id).Append(',')` aus dem CSV-Beispiel ist immer noch marginal schlanker und klarer, aber die interpolierte Form ist kein Performance-Fehler mehr.

## Der Benchmark

Zwei Szenarien, weil die zwei Werkzeuge in unterschiedlichen Szenarien gewinnen. Gemessen mit BenchmarkDotNet 0.14.x auf einem Ryzen 7 / Windows 11 / .NET 11-Build, x64 RyuJIT, `dotnet run -c Release`.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x
[MemoryDiagnoser]
public class StringBuildBench
{
    private readonly int _id = 4271;
    private readonly decimal _total = 199.95m;
    private readonly DateTime _placed = new(2026, 5, 25);

    // Scenario A: one composition of a fixed set of values.
    [Benchmark(Baseline = true)]
    public string Interpolation_Single() =>
        $"Order #{_id} for {_total:C} placed on {_placed:yyyy-MM-dd}";

    [Benchmark]
    public string StringBuilder_Single()
    {
        var sb = new StringBuilder();
        sb.Append("Order #").Append(_id).Append(" for ").Append(_total.ToString("C"))
          .Append(" placed on ").Append(_placed.ToString("yyyy-MM-dd"));
        return sb.ToString();
    }

    // Scenario B: build a 1,000-line string.
    [Params(1000)] public int N;

    [Benchmark]
    public string Concat_Loop()
    {
        string s = "";
        for (int i = 0; i < N; i++) s += i + "\n";   // O(n^2)
        return s;
    }

    [Benchmark]
    public string StringBuilder_Loop()
    {
        var sb = new StringBuilder();
        for (int i = 0; i < N; i++) sb.Append(i).Append('\n');
        return sb.ToString();
    }
}
```

Repräsentative Ergebnisse:

| Methode                 | Mittel     | Ratio  | Alloziert |
| ----------------------- | ---------- | ------ | --------- |
| `Interpolation_Single`  | 78 ns      | 1.00   | 96 B      |
| `StringBuilder_Single`  | 165 ns     | 2.12   | 336 B     |
| `Concat_Loop` (N=1000)  | 410.000 ns | 5256   | 5,86 MB   |
| `StringBuilder_Loop`    | 9800 ns    | 126    | 39 KB     |

Lesen Sie die beiden Hälften getrennt. Für eine einzelne Zusammensetzung ist die Interpolation rund doppelt so schnell und alloziert ein Drittel, weil kein `StringBuilder`-Objekt oder dessen internes `char[]` zu allozieren ist, nur die endgültige Zeichenfolge. Für die Schleife ist `StringBuilder` etwa 40-mal schneller als die `+=`-Verkettung und alloziert 150-mal weniger, und der Abstand wächst mit steigendem N, weil die Verkettung quadratisch ist, während `StringBuilder` linear ist. Die genauen Zahlen verschieben sich mit Zeichenfolgenlänge und CPU, aber die beiden Richtungen sind stabil: die Interpolation gewinnt einmalig, `StringBuilder` gewinnt die Schleife, und keines der beiden Ergebnisse ist knapp genug, um daran zu zweifeln. Wenn Sie im einmaligen Fall null Allokationen wollen, behandelt der nächste Abschnitt `string.Create`.

## Wenn keiner reicht: `string.Create`

Für den seltenen heißen Pfad, in dem selbst eine Allokation der endgültigen Zeichenfolge über den Handler zu viel ist und Sie die genaue Länge im Voraus kennen, erlaubt `string.Create<TState>` das direkte Schreiben in den Puffer der Zeichenfolge mit einem `Span<char>`:

```csharp
// .NET 11, C# 14 -- exact length known, write straight into the string buffer.
public static string FormatId(int id) =>
    string.Create(8, id, static (span, value) => value.TryFormat(span, out _, "D8"));
```

Das ist der Boden: eine Allokation (die Zeichenfolge selbst), kein Zwischenpuffer, kein Handler. Es ist auch das am wenigsten Lesbare und lohnt sich nur in gemessenen heißen Schleifen, in denen Sie Millionen von Zeichenfolgen mit fester Form formatieren. Wenn Sie auf dieser Ebene arbeiten, leben Sie wahrscheinlich bereits in `Span<char>` und `stackalloc`; für das größere Bild, wann stack-only-Puffer sich lohnen, siehe [List vs. Span vs. ReadOnlySpan in C#](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/). Für gewöhnlichen Code greifen Sie nicht hierher. Interpolation und `StringBuilder` decken das Feld ab.

## Das Detail, das für Sie entscheidet

Eine Einschränkung überstimmt den Geschmack vollständig: **die Unveränderlichkeit des Ergebnisses.** String-Interpolation erzeugt eine fertige `string`. Wenn Ihr Code danach weiter anhängen, in der Mitte einfügen, ein Token ersetzen oder den Puffer leeren und wiederverwenden muss, brauchen Sie `StringBuilder`, egal wie wenige Werte beteiligt sind. Es gibt keine Interpolationsform von `sb.Insert(0, header)` oder `sb.Replace("{name}", actual)`.

Die umgekehrte Einschränkung ist Lesbarkeit unter Bedingungen. Wenn die Zeichenfolge aus einer festen Vorlage ohne Schleife und ohne nachträgliche Mutation zusammengesetzt wird, ist `StringBuilder` das falsche Werkzeug, selbst wenn die Performance irrelevant ist, weil `sb.Append(...).Append(...).Append(...)` strikt schwerer zu lesen ist als die Interpolation, die es ersetzt, und in .NET 11 meist mehr alloziert. Reviewer sollten einen `StringBuilder` ohne Schleife und mit fester Anzahl von Appends als Code-Smell behandeln: Es ist fast immer eine einzelne Interpolation in Verkleidung.

## Die Empfehlung, neu formuliert

Verwenden Sie standardmäßig String-Interpolation. In .NET 11 wandelt sie sich in einen `DefaultInterpolatedStringHandler` um, parst das Format zur Kompilierzeit, formatiert Werttypen ohne Boxing und mietet ihren Scratch-Puffer, sodass eine einzelne Zusammensetzung eine Zeichenfolge alloziert und einen handgemachten `StringBuilder` sowohl bei Geschwindigkeit als auch bei Allokationen schlägt, während sie sich deutlich besser liest. Wechseln Sie zu `StringBuilder`, sobald Sie in einer Schleife oder über eine unbekannte Anzahl von Fragmenten anhängen, wo sein linearer, veränderbarer, wiederverwendbarer Puffer das quadratische Desaster der `+=`-Verkettung in ein Nicht-Ereignis verwandelt. Verketten Sie niemals mit `+=` innerhalb einer Schleife. Und fürchten Sie `sb.Append($"...")` ab .NET 6 nicht: Der Interpolations-Handler hängt ohne Zwischenzeichenfolge direkt an den Builder an. Die Einzeiler-Version: ein Ausdruck bedeutet Interpolation, eine Schleife bedeutet `StringBuilder`, und die Anzahl der Werte ist eine falsche Fährte.

## Verwandt

- [List<T> vs. Span<T> vs. ReadOnlySpan<T> in C#](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/) behandelt die stack-only-Puffertypen, zu denen Sie greifen, wenn `string.Create` und `stackalloc` ins Spiel kommen.
- [C# 13: das Ende der params-Allokationen](/de/2026/01/c-13-the-end-of-params-allocations/) erklärt dieselbe Philosophie der Allokationsvermeidung, angewendet auf `params ReadOnlySpan<T>`.
- [Wie man eine große CSV in .NET 11 ohne Speicherüberlauf liest](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) baut Zeichenfolgen und parst Felder in großem Maßstab, genau dort, wo die Unterscheidung zwischen Schleife und Einmal greift.
- [Interpolierte rohe String-Literale in C# 11](/de/2023/03/c-11-interpolated-raw-string-literal/) zeigt die Interpolationssyntax, die mit dem hier behandelten Handler zusammenspielt.
- [Implizite Span-Konvertierungen in C# 14](/de/2025/04/implicit-span-conversions-in-c-14-first-class-support-for-span-and-readonlyspan/) ist die Konvertierungsmaschinerie hinter der span-basierten Formatierung, auf die sich `string.Create` stützt.

## Quellen

- [String Interpolation in C# 10 and .NET 6 (.NET Blog)](https://devblogs.microsoft.com/dotnet/string-interpolation-in-c-10-and-net-6/)
- [Explore C# string interpolation handlers (MS Learn)](https://learn.microsoft.com/dotnet/csharp/advanced-topics/performance/interpolated-string-handler)
- [Breaking change: new StringBuilder.Append overloads (MS Learn)](https://learn.microsoft.com/dotnet/core/compatibility/core-libraries/6.0/stringbuilder-append-evaluation-order)
- [DefaultInterpolatedStringHandler struct reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.runtime.compilerservices.defaultinterpolatedstringhandler)
- [StringBuilder class reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.text.stringbuilder)
- [string.Create reference (MS Learn)](https://learn.microsoft.com/dotnet/api/system.string.create)
