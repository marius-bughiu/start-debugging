---
title: "Wie man mehrere Werte aus einer Methode in C# 14 zurückgibt"
description: "Sieben Wege, um mehr als einen Wert aus einer C# 14 Methode zurückzugeben: benannte Tupel, out-Parameter, Records, Structs, Deconstruction und der Extension-Member-Trick für Typen, die Ihnen nicht gehören. Echte Benchmarks und eine Entscheidungsmatrix am Ende."
pubDate: 2026-04-20
tags:
  - "csharp"
  - "csharp-14"
  - "dotnet-11"
  - "how-to"
  - "tuples"
  - "records"
lang: "de"
translationOf: "2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14"
translatedBy: "claude"
translationDate: 2026-04-24
---

Kurze Antwort: In C# 14 auf .NET 11 ist die idiomatische Art, mehrere Werte zurückzugeben, eine **benannte `ValueTuple`**, wenn die Gruppierung privat zum Aufrufer ist, ein **positionaler `record`**, wenn die Gruppierung einen Namen verdient, der im Domänenmodell leben darf, und **`out`-Parameter** nur für klassische `TryXxx`-Muster, bei denen der Boolean-Rückgabewert tragend ist. Jede andere Variante (anonyme Typen, `Tuple<T1,T2>`, geteilte DTOs, `ref`-Ausgabepuffer) existiert für Grenzfälle, die die meisten Codebases nie treffen.

Das ist das TL;DR. Der Rest dieses Beitrags ist die lange Version, mit Code, der gegen `net11.0` / C# 14 (LangVersion 14) kompiliert, Benchmarks für die allokationsempfindlichen Fälle, und einer Entscheidungstabelle, die Sie in den Code-Standard Ihres Teams einfügen können.

## Warum C# die Rückgabe eines einzigen Werts zum Standard macht

CLR-Methoden haben einen einzigen Rückgabe-Slot. Die Sprache hat "Multi-Return" nie als erstklassiges Konstrukt gehabt, wie Go, Python oder Lua. Alles, was in C# wie Multi-Return aussieht, ist in Wirklichkeit "Werte in ein einziges Objekt (Wert- oder Referenztyp) einpacken und zurückgeben". Die Unterschiede zwischen den Optionen drehen sich fast ausschließlich darum, (a) wie viel Zeremonie Sie für die Definition des Wrappers zahlen, und (b) wie viel Müll der Wrapper zur Laufzeit produziert.

Mit `ValueTuple`, positionalen `record`s und den erweiterten Extension Members von C# 14 ist die Zeremonie von "schreibe eine neue Klasse" auf "füge ein Komma hinzu" geschrumpft. Diese Verschiebung verändert die Abwägung. Es lohnt sich, die Optionen neu zu betrachten, wenn Ihre mentalen Defaults in der C# 7- oder C# 9-Ära geformt wurden.

## Benannte ValueTuple: die Standardantwort in 2026

Seit C# 7.0 unterstützt die Sprache `ValueTuple<T1, T2, ...>` als Werttyp mit spezieller syntaktischer Zuckersyntax:

```csharp
// .NET 11, C# 14
public static (int Min, int Max) MinMax(ReadOnlySpan<int> values)
{
    int min = int.MaxValue;
    int max = int.MinValue;
    foreach (var v in values)
    {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    return (min, max);
}

// Caller
var (lo, hi) = MinMax([3, 7, 1, 9, 4]);
Console.WriteLine($"{lo}..{hi}"); // 1..9
```

Zwei Dinge machen dies zum richtigen Default:

1. **`ValueTuple` ist ein `struct`**, also wird es auf dem heißen Pfad in Registern (oder auf dem Stack) ohne Heap-Allokation zurückgegeben. Für zwei oder drei primitive Felder hält der JIT die gesamte Struktur unter .NET 11s verbesserter ABI-Behandlung in der Regel komplett in Registern auf x64.
2. **Benannte Feldsyntax** erzeugt nutzbare Namen an der Aufrufstelle (`result.Min`, `result.Max`), ohne dass Sie einen Typ deklarieren müssen. Diese Namen sind Compiler-Metadaten, keine Laufzeitfelder, aber IntelliSense, `nameof` und Decompiler respektieren sie alle.

Wann man darauf zurückgreift: die Rückgabewerte sind eng an einen einzigen Aufrufer gekoppelt, die Gruppierung verdient keinen Domänennamen, und Sie wollen keine Allokation pro Aufruf. Die meisten internen Helper passen in diese Beschreibung.

Wann man es vermeiden sollte: Sie planen, den Wert über eine API-Grenze zurückzugeben, zu serialisieren oder intensiv darauf Pattern Matching zu machen. Tupel verlieren ihre Feldnamen über Assembly-Grenzen hinweg, außer Sie liefern ein `TupleElementNamesAttribute` mit der Signatur aus, und `System.Text.Json` serialisiert `ValueTuple` als `{"Item1":...,"Item2":...}`, was fast nie das ist, was Sie wollen.

## Out-Parameter: immer noch korrekt für TryXxx

`out`-Parameter waren ein Jahrzehnt lang das hässliche Entlein von C#. Sie sind immer noch die richtige Antwort, wenn der **primäre** Rückgabewert ein Erfolgs-Flag ist und die "zusätzlichen" Werte nur bei Erfolg existieren:

```csharp
// .NET 11, C# 14
public static bool TryParseRange(
    ReadOnlySpan<char> input,
    out int start,
    out int end)
{
    int dash = input.IndexOf('-');
    if (dash <= 0)
    {
        start = 0;
        end = 0;
        return false;
    }
    return int.TryParse(input[..dash], out start)
        && int.TryParse(input[(dash + 1)..], out end);
}

// Caller
if (TryParseRange("42-99", out var a, out var b))
{
    Console.WriteLine($"{a}..{b}");
}
```

Drei Gründe, warum `out` für diese Form immer noch gewinnt:

- **Keine Wrapper-Allokation**, offensichtlich, aber wichtiger noch, keine Allokation im **Fehlschlag**-Pfad. `TryParse` wird oft in einer heißen Schleife aufgerufen, in der die meisten Aufrufe fehlschlagen (Parser-Sondierungen, Cache-Lookups, Fallback-Ketten).
- **Regeln für definite Zuweisung** zwingen die Methode dazu, vor jeder Rückgabe in jeden `out`-Parameter zu schreiben, was eine Klasse von Bugs abfängt, die `ValueTuple` hinter einer Default-Wert-Rückgabe gerne versteckt.
- **Lesbarkeit entspricht der Erwartung**. Jeder .NET-Entwickler liest `Try...(out ...)` als "sondiere und habe vielleicht Erfolg". `(bool Success, int Value, int Other)` zurückzugeben ist technisch äquivalent und messbar fremdartiger.

Was sich in neueren Runtimes unter der Haube geändert hat, ist die Fähigkeit des JIT, `out`-Locals in Register zu promoten, wenn der Aufrufer `out var` verwendet. In .NET 11 ist die Promotion zuverlässig genug, dass ein `TryParseRange` mit `int`-outs den gleichen Assembly-Code erzeugt wie eine Version, die `(int, int)` via `ValueTuple` zurückgibt.

Verwenden Sie `out` nicht, wenn die Werte **immer** zurückgegeben werden. Die Verzweigungs-Zeremonie an der Aufrufstelle (`if (Foo(out var a, out var b)) { ... }`) lohnt sich nur, wenn der `bool` Information trägt.

## Positionale Records: wenn die Gruppierung einen Namen hat

Records, in C# 9 eingeführt und mit den Primary Constructors von C# 12 verfeinert, geben Ihnen einen benannten Wrapper mit `Equals`, `GetHashCode`, `ToString` **und `Deconstruct`** kostenlos:

```csharp
// .NET 11, C# 14
public record struct PricedRange(decimal Low, decimal High, string Currency);

public static PricedRange GetDailyRange(Symbol symbol)
{
    var quotes = QuoteStore.ReadDay(symbol);
    return new PricedRange(
        Low: quotes.Min(q => q.Bid),
        High: quotes.Max(q => q.Ask),
        Currency: symbol.Currency);
}

// Caller, either style works
PricedRange r = GetDailyRange(s);
var (lo, hi, ccy) = GetDailyRange(s);
```

Zwei Details, die 2026 wichtig sind:

- **Verwenden Sie `record struct` für den Fall "gib mir einfach eine Form"**. Klassen-Records allokieren auf dem Heap, was der falsche Default ist, wenn Sie zwischen ihnen und `ValueTuple` wählen. `record struct` ist ein allokationsfreier Struct mit vom Compiler generiertem `Deconstruct`, `ToString` und wertbasierter Gleichheit.
- **Verwenden Sie `record` (Klasse), wenn Identität wichtig ist**, zum Beispiel wenn der Wert durch eine Sammlung fließt und Sie brauchen, dass Referenzgleichheit bedeutungsvoll ist, oder wenn der Record an einer Vererbungshierarchie teilnimmt, die Sie bereits haben.

Im Vergleich zu Tupeln zahlen positionale Records einmalige Deklarationskosten (eine Zeile) und verdienen sie zurück, sobald die Form an mehr als einer Aufrufstelle, einem DTO, einer Log-Zeile oder einer API-Oberfläche erscheint. Meine Faustregel: wenn sich zwei verschiedene Dateien auf die Feldnamen der Tupel einigen müssten, ist es bereits ein Record.

## Klassische Klassen und Structs: wenn Records zu laut sind

Records sind ein scharfes Werkzeug und sie bringen `with`-Ausdrücke, wertbasierte Gleichheit und eine öffentliche Konstruktor-Signatur mit, ob Sie wollen oder nicht. Wenn Sie einen einfachen Container mit privaten Feldern und einer angepassten `ToString`-Methode wollen, ist ein normaler `struct` immer noch in Ordnung:

```csharp
// .NET 11, C# 14
public readonly struct ParseResult
{
    public int Consumed { get; init; }
    public int Remaining { get; init; }
    public ParseStatus Status { get; init; }
}
```

`readonly struct` mit `init`-Properties ist das Nächste an einem Record, das Sie bauen können, ohne sich für Record-Semantik zu entscheiden. Sie verlieren Deconstruction, außer Sie fügen eine `Deconstruct`-Methode explizit hinzu. Sie verlieren auch das `ToString`-Override, was meist in Ordnung ist, weil ein Parse-Ergebnis keines braucht.

## Deconstruction bindet alles zusammen

Jede obige Option wird letztlich zu Zucker an der Aufrufstelle:

```csharp
// .NET 11, C# 14
var (lo, hi) = MinMax(values);           // ValueTuple
var (low, high, ccy) = GetDailyRange(s);  // record struct
```

Der Compiler sucht eine `Deconstruct`-Methode, als Instanz oder als Extension, die zur Arität und zu den out-Parameter-Typen des positionalen Musters passt. Für `ValueTuple` und Typen der `record`-Familie wird die Methode synthetisiert. Für normale Klassen und Structs können Sie sie selbst schreiben:

```csharp
// .NET 11, C# 14
public readonly struct LatLon
{
    public double Latitude { get; }
    public double Longitude { get; }

    public LatLon(double lat, double lon) => (Latitude, Longitude) = (lat, lon);

    public void Deconstruct(out double lat, out double lon)
    {
        lat = Latitude;
        lon = Longitude;
    }
}

// Caller
var (lat, lon) = home;
```

Wenn Sie den Typ besitzen, schreiben Sie die `Deconstruct`-Methode. Wenn nicht, gibt Ihnen C# 14 eine bessere Option als die alte Extension-Methode.

## Der C# 14 Trick: Extension Members auf Typen, die Ihnen nicht gehören

C# 14 hat **Extension Members** eingeführt, die das Extension-Konzept von "statische Methode mit `this`-Modifier" zu einem vollständigen Block befördern, der Properties, Operatoren und hier relevant `Deconstruct`-Methoden deklarieren kann, die sich nativ für den Empfänger anfühlen. Der [Vorschlag](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/extension-members) deckt die Syntax ab, aber der Nutzen für unser Thema sieht so aus:

```csharp
// .NET 11, C# 14 (LangVersion 14)
public static class GeometryExtensions
{
    extension(System.Drawing.Point p)
    {
        public void Deconstruct(out int x, out int y)
        {
            x = p.X;
            y = p.Y;
        }
    }
}

// Caller, no changes to System.Drawing.Point
using System.Drawing;
var origin = new Point(10, 20);
var (x, y) = origin;
```

Unter C# 13 konnten Sie das nur tun, indem Sie eine statische Extension-Methode namens `Deconstruct` schrieben. Es funktionierte, aber es saß unbequem in Code-Analyzern und komponierte sich nicht mit den anderen Mitgliedern (Properties, Operatoren), die Sie eventuell auch hinzufügen wollten. Extension Members räumen das auf, sodass das Wrappen eines fremden Typs in einen deconstruction-freundlichen Shim jetzt eine One-Block-Änderung ist statt einer neuen Hilfsklasse.

Das ist wichtig für interop-lastigen Code. Wenn Sie eine C-API wrappen, die einen gepackten Struct zurückgibt, oder einen Bibliothekstyp, der sich stur weigert, `Deconstruct` zu implementieren, können Sie das jetzt von außen mit weniger Reibung als vorher hinzufügen.

## Performance: was tatsächlich allokiert

Ich habe den folgenden BenchmarkDotNet-Durchgang auf .NET 11.0.2 (x64, RyuJIT, Tiered PGO aktiv), `LangVersion 14` ausgeführt:

```csharp
// .NET 11, C# 14
[MemoryDiagnoser]
public class MultiReturnBench
{
    private readonly int[] _data = Enumerable.Range(0, 1024).ToArray();

    [Benchmark]
    public (int Min, int Max) Tuple() => MinMax(_data);

    [Benchmark]
    public int OutParams()
    {
        MinMaxOut(_data, out int min, out int max);
        return max - min;
    }

    [Benchmark]
    public PricedRange RecordStruct() => GetRange(_data);

    [Benchmark]
    public MinMaxClass ClassResult() => GetRangeClass(_data);
}
```

Indikative Zahlen auf meiner Maschine (Ryzen 9 7950X):

| Ansatz           | Mittelwert | Allokiert |
| ---------------- | ---------- | --------- |
| `ValueTuple`     | 412 ns     | 0 B       |
| `out`-Parameter  | 410 ns     | 0 B       |
| `record struct`  | 412 ns     | 0 B       |
| `class`-Ergebnis | 431 ns     | 24 B      |

Die drei Werttyp-Ansätze sind statistisch nicht unterscheidbar. Sie teilen sich den gleichen Codegen, nachdem der JIT den Konstruktor inlined und den Struct in die Locals des Aufrufer-Frames promotet. Die Klassen-Version kostet eine 24-Byte-Allokation pro Aufruf, was für eine Handvoll Aufrufe pro Request in Ordnung ist und in einer engen Schleife tödlich. Deshalb ist der "Gib immer ein Referenztyp-DTO zurück"-Rat von 2015 schlecht gealtert, und deshalb ist `record struct` meist das richtige Upgrade, wenn Sie einen Namen an die Form binden möchten.

## Fallstricke und Varianten, die beißen

Ein paar Grenzfälle haben mich getroffen oder Teams, die ich im letzten Jahr reviewt habe:

- **Tupel-Namen gehen über Assembly-Grenzen hinweg verloren, ohne `[assembly: TupleElementNames]`**. Das Attribut wird für öffentliche Methoden-Signaturen automatisch emittiert, aber Debugger und Reflection sehen manchmal nur `Item1`, `Item2`. Wenn Sie sich auf Namen in Logs verlassen, bevorzugen Sie einen Record.
- **`record class`-Deconstruction kopiert Felder in Locals**. Für große Records ist das nicht kostenlos. Hat ein Record zwölf Felder und Sie wollen nur zwei, dekonstruieren Sie in Discards (`var (_, _, ccy, _, ...)`), oder machen Sie Pattern Matching mit einem `{ Currency: var ccy }`-Property-Muster.
- **`out`-Parameter komponieren sich nicht mit `async`**. Wenn Ihre Methode `async` ist, können Sie `out` nicht verwenden; weichen Sie auf `ValueTuple<T1, T2>` oder einen Record aus. `ValueTuple` ist hier der richtige Default, weil es eine Allokation pro `await`-Frame vermeidet, die ein Record-Class verursachen würde.
- **`ref`-Rückgaben sind nicht dasselbe wie Multi-Return**. Wenn Sie sich nach `ref T` strecken, um "mehrere zurückzugeben", wollen Sie wahrscheinlich einen `Span<T>` oder einen angepassten Ref-Struct-Wrapper. Das ist ein anderer Artikel.
- **Deconstruction in bestehende Variablen** funktioniert, erfordert aber, dass die Zielvariablen veränderlich sind. `(a, b) = Foo()` kompiliert nur, wenn `a` und `b` bereits als nicht-readonly deklariert sind. Mit pattern-match-ähnlicher Syntax (`var (a, b) = ...`) bekommen Sie jedes Mal neue Variablen.
- **Implizite Tupel-Konvertierung ist einseitig**. `(int, int)` konvertiert implizit zu `(long, long)`, aber `ValueTuple<int, int>` zu einem `record struct PricedRange` erfordert eine explizite Konvertierung. Erwarten Sie nicht, dass die beiden Welten stillschweigend interoperieren.

## Eine Entscheidungstabelle zum Kopieren

| Situation                                                                | Greifen Sie zu                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------ |
| Einmaliger Helper, Werte an einen einzigen Aufrufer gekoppelt            | benannte `ValueTuple`                            |
| `TryXxx`-Muster, der Bool ist die eigentliche Rückgabe                   | `out`-Parameter                                  |
| Zwei oder mehr Aufrufstellen brauchen die Gruppierung, keine Identität   | `record struct`                                  |
| Identität ist wichtig oder Teil einer Vererbungshierarchie               | `record` (Klasse)                                |
| Muss eine API-Grenze überschreiten und serialisiert werden               | benanntes DTO (`record class` oder einfache Klasse) |
| Deconstruction eines Typs, den Sie nicht besitzen                        | C# 14 Extension Member mit `Deconstruct`         |
| `async`-Methode, die konzeptionell zwei Dinge zurückgibt                 | `ValueTuple` in `Task<(T1, T2)>`                 |
| Muss einen Puffer plus Länge zurückgeben                                 | `Span<T>` oder angepasster Ref-Struct            |

Die Kurzversion dieser Tabelle: Standard ist `ValueTuple`, wechseln Sie zu `record struct`, wenn die Form einen Namen verdient, greifen Sie nur zu `out`, wenn das Erfolgs-Flag der Punkt ist.

## Verwandte Lektüre in diesem Blog

Für den Kontext der Sprachentwicklung zeigt der [Verlauf der C# Sprachversionen](/2024/12/csharp-language-version-history/), wie Tupel, Records und Deconstruction angekommen sind. Wenn Sie neugierig sind, wo das Schlüsselwort `union` und exhaustives Pattern Matching in diesem Bild einzuordnen sind, sehen Sie sich den Beitrag zu [C# 15 Union Types in .NET 11 Preview 2](/2026/04/csharp-15-union-types-dotnet-11-preview-2/) und den früheren [C# Vorschlag zu Discriminated Unions](/2026/01/csharp-proposal-discriminated-unions/) an; beide verändern das Kalkül für "gib eine von mehreren Formen zurück" gegenüber "gib viele Formen zurück". Für die Performance-Seite von Struct-vs-Class-Entscheidungen auf heißen Pfaden erfasst der ältere [FrozenDictionary vs Dictionary Benchmark](/2024/04/net-8-performance-dictionary-vs-frozendictionary/) die Allokationsgeschichte, die die `record struct`-Präferenz oben antreibt. Und wenn Sie jemals einen ausführlichen Tupel-Typ für die Lesbarkeit aliasieren müssen, ist [C# 12 alias any type](/2023/08/c-12-alias-any-type/) das Feature, das Sie wollen.

## Quellen

- [Vorschlag zu C# 14 Extension Members](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-14.0/extension-members)
- [ValueTuple und Tupel-Typen in C#](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/value-tuples)
- [Deconstruct-Deklarationen](https://learn.microsoft.com/en-us/dotnet/csharp/fundamentals/functional/deconstruct)
- [Record-Typen](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/builtin-types/record)
- [.NET 11 Release Notes](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview)
