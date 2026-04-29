---
title: "SearchValues<T> in .NET 11 richtig verwenden"
description: "SearchValues<T> schlägt IndexOfAny um Faktor 5 bis 250, aber nur wenn Sie es so verwenden, wie es die Laufzeit erwartet. Die Cache-als-static-Regel, die StringComparison-Falle, wann sich der Aufwand nicht lohnt und der IndexOfAnyExcept-Inversionstrick, den niemand dokumentiert."
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "csharp"
  - "searchvalues"
lang: "de"
translationOf: "2026/04/how-to-use-searchvalues-correctly-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-29
---

`SearchValues<T>` liegt in `System.Buffers`. Es ist eine vorab berechnete, unveränderliche Wertemenge, die zusammen mit den Erweiterungsmethoden `IndexOfAny`, `IndexOfAnyExcept`, `ContainsAny`, `LastIndexOfAny` und `LastIndexOfAnyExcept` auf `ReadOnlySpan<T>` verwendet wird. Die Regel, die 90% der Verwendungen verfehlen, ist einfach: Bauen Sie die `SearchValues<T>`-Instanz einmal, legen Sie sie in einem `static readonly`-Feld ab und verwenden Sie sie wieder. Wer sie innerhalb der heißen Methode aufbaut, behält die gesamten Kosten (die SIMD-Strategieauswahl, die Bitmap-Allokation, den Aho-Corasick-Automaten für die String-Überladung) und verliert den gesamten Nutzen. Die zweite Regel: Greifen Sie nicht zu `SearchValues<T>` für Mengen aus einem oder zwei Werten. `IndexOf` ist für die trivialen Fälle bereits vektorisiert und schneller.

Dieser Beitrag richtet sich an .NET 11 (Preview 4) auf x64 und ARM64. Die Byte- und Char-Überladungen von `SearchValues.Create` sind seit .NET 8 stabil. Die String-Überladung (`SearchValues<string>`) ist seit .NET 9 stabil und in .NET 10 und .NET 11 unverändert. Das unten beschriebene Verhalten ist auf Windows, Linux und macOS identisch, weil die SIMD-Codepfade plattformübergreifend geteilt werden und nur dort auf Skalarcode zurückfallen, wo AVX2 / AVX-512 / NEON nicht verfügbar sind.

## Warum SearchValues existiert

`ReadOnlySpan<char>.IndexOfAny('a', 'b', 'c')` ist ein einmaliger Aufruf. Die Laufzeit kann nicht wissen, ob der nächste Aufruf dieselbe Menge oder eine andere verwendet, also muss sie jedes Mal vor Ort eine Suchstrategie auswählen. Für drei Zeichen inlinet der JIT einen handoptimierten vektorisierten Pfad, der Overhead ist also gering, aber sobald die Menge über vier oder fünf Elemente hinauswächst, fällt `IndexOfAny` auf eine generische Schleife mit Hash-Set-Mitgliedschaftsprüfung pro Zeichen zurück. Diese Schleife ist für kurze Eingaben in Ordnung und ein Desaster für lange.

`SearchValues<T>` entkoppelt den Planungsschritt vom Suchschritt. Wenn Sie `SearchValues.Create(needles)` aufrufen, inspiziert die Laufzeit die Suchwerte einmal: Sind sie ein zusammenhängender Bereich? Eine spärliche Menge? Teilen sie Präfixe (für die String-Überladung)? Sie wählt eine von mehreren Strategien (Bitmap mit `Vector256`-Shuffle, `IndexOfAnyAsciiSearcher`, `ProbabilisticMap`, `Aho-Corasick`, `Teddy`) und backt die Metadaten in die Instanz. Jeder folgende Aufruf gegen diese Instanz überspringt die Planung und springt direkt in den gewählten Kernel. Bei einer Menge mit 12 Elementen sehen Sie typischerweise einen Speedup von Faktor 5 bis 50 gegenüber der entsprechenden `IndexOfAny`-Überladung. Bei String-Mengen mit 5 oder mehr Suchwerten sehen Sie Faktor 50 bis 250 gegenüber einer manuellen `Contains`-Schleife.

Die Asymmetrie ist der Punkt: Planen ist teuer, Suchen ist billig. Wer pro Aufruf ein frisches `SearchValues<T>` baut, bezahlt den Planer ohne ihn zu amortisieren.

## Die Cache-als-static-Regel

Das ist das kanonische Muster. Achten Sie auf das `static readonly`:

```csharp
// .NET 11, C# 14
using System.Buffers;

internal static class CsvScanner
{
    private static readonly SearchValues<char> Delimiters =
        SearchValues.Create(",;\t\r\n\"");

    public static int FindNextDelimiter(ReadOnlySpan<char> input)
    {
        return input.IndexOfAny(Delimiters);
    }
}
```

Die falsche Variante, die ich jede Woche in PRs sehe:

```csharp
// .NET 11 -- BROKEN, do not ship
public static int FindNextDelimiter(ReadOnlySpan<char> input)
{
    var delims = SearchValues.Create(",;\t\r\n\"");
    return input.IndexOfAny(delims);
}
```

Sieht harmlos aus. Allokiert bei jedem Aufruf, und der Planer läuft bei jedem Aufruf. Benchmarks, die ich auf .NET 11 Preview 4 mit `BenchmarkDotNet` ausgeführt habe:

```
| Method                     | Mean       | Allocated |
|--------------------------- |-----------:|----------:|
| StaticSearchValues_1KB     |    71.4 ns |       0 B |
| RebuiltSearchValues_1KB    |   312.0 ns |     208 B |
| LoopWithIfChain_1KB        |   846.0 ns |       0 B |
```

Die Allokation ist die gefährlichere Hälfte. Ein falsch platziertes `Create` in einem heißen Pfad wird zu einem stetigen Strom LOH-naher Müllobjekte. Bei einem Service mit 100k Anfragen pro Sekunde sind das Gigabytes pro Minute, mit denen der GC für einen Wert unter Druck gesetzt wird, den Sie wiederverwenden sollten.

Wenn Sie `static readonly` nicht verwenden können, weil die Suchwerte beim Start vom Benutzer kommen, bauen Sie die Instanz einmal während der Initialisierung und legen Sie sie in einem Singleton-Service ab:

```csharp
// .NET 11, C# 14
public sealed class TokenScanner
{
    private readonly SearchValues<string> _tokens;

    public TokenScanner(IEnumerable<string> tokens)
    {
        _tokens = SearchValues.Create(tokens.ToArray(), StringComparison.Ordinal);
    }

    public bool ContainsAny(ReadOnlySpan<char> input) => input.ContainsAny(_tokens);
}
```

Registrieren Sie ihn als Singleton in der Dependency Injection. Nicht als Transient. Transient gibt Ihnen dieselbe Pro-Aufruf-Neuaufbau-Falle mit zusätzlichen Schritten.

## Die StringComparison-Falle

`SearchValues<string>` (die in .NET 9 hinzugefügte Multi-String-Überladung) nimmt ein `StringComparison`-Argument:

```csharp
private static readonly SearchValues<string> Forbidden =
    SearchValues.Create(["drop", "delete", "truncate"], StringComparison.OrdinalIgnoreCase);
```

Nur vier Werte sind erlaubt: `Ordinal`, `OrdinalIgnoreCase`, `InvariantCulture` und `InvariantCultureIgnoreCase`. Wer `CurrentCulture` oder `CurrentCultureIgnoreCase` übergibt, bei dem wirft der Konstruktor beim Start `ArgumentException`. Das ist korrekt: Eine kulturabhängige Multi-String-Suche müsste pro Aufruf allokieren, um die aktuelle Thread-Kultur zu respektieren, was die Vorabberechnung zunichtemachen würde.

Zwei Folgen:

- Für ASCII-Daten verwenden Sie immer `Ordinal` oder `OrdinalIgnoreCase`. Sie sind 5x bis 10x schneller als die Invariant-Varianten, weil die Laufzeit zu einem Teddy-Kernel verzweigt, der auf Rohbytes arbeitet. Die Invariant-Varianten zahlen für Unicode-Case-Folding sogar bei reinen ASCII-Eingaben.
- Wenn Sie sprachkorrekte Groß-/Kleinschreibungsunabhängigkeit brauchen (türkisches I mit Punkt, griechisches Sigma), ist `SearchValues<string>` nicht Ihr Werkzeug. Greifen Sie auf `string.Contains(needle, StringComparison.CurrentCultureIgnoreCase)` in einer Schleife zurück und akzeptieren Sie die Kosten. Sprachsensitiver String-Vergleich ist grundsätzlich nicht vektorisierbar.

Die `char`- und `byte`-Überladungen haben keinen `StringComparison`-Parameter. Sie vergleichen exakt. Wenn Sie ASCII-Suche ohne Beachtung der Groß-/Kleinschreibung mit `SearchValues<char>` wollen, nehmen Sie beide Schreibweisen in die Menge auf:

```csharp
// case-insensitive ASCII vowels in .NET 11, C# 14
private static readonly SearchValues<char> Vowels =
    SearchValues.Create("aeiouAEIOU");
```

Billiger, als zuerst `ToLowerInvariant` auf der Eingabe aufzurufen.

## Mengenmitgliedschaft: SearchValues.Contains ist nicht das, was Sie denken

`SearchValues<T>` exponiert eine `Contains(T)`-Methode:

```csharp
SearchValues<char> set = SearchValues.Create("abc");
bool isInSet = set.Contains('b'); // true
```

Bitte genau lesen: das prüft, ob ein einzelner Wert in der Menge liegt. Das Pendant zu `HashSet<T>.Contains`, keine Substring-Suche. Leute greifen danach, erwarten `string.Contains`-Semantik und liefern Code aus, der fragt "ist das Zeichen 'h' in meiner Menge verbotener Tokens" statt "enthält meine Eingabe irgendein verbotenes Token". Dieser Bug-Typ besteht den Typcheck und läuft.

Die richtigen Aufrufe für "enthält die Eingabe einen davon":

- `ReadOnlySpan<char>.ContainsAny(SearchValues<char>)` für Char-Mengen.
- `ReadOnlySpan<char>.ContainsAny(SearchValues<string>)` für String-Mengen.
- `ReadOnlySpan<byte>.ContainsAny(SearchValues<byte>)` für Byte-Mengen.

Verwenden Sie `SearchValues<T>.Contains(value)` nur, wenn Sie tatsächlich einen einzelnen Wert haben und ein Mengen-Lookup wollen, etwa innerhalb eines eigenen Tokenizers, der entscheidet, ob das aktuelle Zeichen ein Trennzeichen ist.

## Der IndexOfAnyExcept-Inversionstrick

`IndexOfAnyExcept(SearchValues<T>)` liefert den Index des ersten Elements, das **nicht** in der Menge liegt. Das ist der Weg, den Anfang des inhaltsreichen Bereichs in einer Zeichenkette nach führendem Whitespace, Padding oder Rauschen in einem einzigen SIMD-Durchgang zu finden:

```csharp
// .NET 11, C# 14
private static readonly SearchValues<char> WhitespaceAndQuotes =
    SearchValues.Create(" \t\r\n\"'");

public static ReadOnlySpan<char> TrimStart(ReadOnlySpan<char> input)
{
    int firstReal = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    return firstReal < 0 ? ReadOnlySpan<char>.Empty : input[firstReal..];
}
```

Das schlägt `string.TrimStart(' ', '\t', '\r', '\n', '"', '\'')` bei Eingaben mit langen führenden Sequenzen, weil `TrimStart` für Mengen über vier Zeichen auf eine Schleife pro Zeichen zurückfällt. Für den typischen Fall "64 Zeichen Einrückung entfernen" ist mit Faktor 4 bis 8 Speedup zu rechnen.

`LastIndexOfAnyExcept` ist das rechtsseitige Pendant. Zusammen ergeben sie ein vektorisiertes `Trim`:

```csharp
public static ReadOnlySpan<char> TrimBoth(ReadOnlySpan<char> input)
{
    int start = input.IndexOfAnyExcept(WhitespaceAndQuotes);
    if (start < 0) return ReadOnlySpan<char>.Empty;

    int end = input.LastIndexOfAnyExcept(WhitespaceAndQuotes);
    return input[start..(end + 1)];
}
```

Zwei Slices, zwei SIMD-Scans, null Allokationen. Die naive `string.Trim(charsToTrim)`-Überladung allokiert in .NET 11 intern ein temporäres Array, selbst wenn die Eingabe gar nicht getrimmt werden müsste.

## Wann byte statt char

Beim Protokollparsen (HTTP, JSON, ASCII-CSV, Log-Zeilen) liegt die Eingabe oft als `ReadOnlySpan<byte>` vor, nicht als `ReadOnlySpan<char>`. `SearchValues<byte>` aus den ASCII-Bytewerten zu bauen, ist deutlich schneller, als zuerst nach UTF-16 zu dekodieren:

```csharp
// .NET 11, C# 14 -- HTTP header value sanitiser
private static readonly SearchValues<byte> InvalidHeaderBytes =
    SearchValues.Create([(byte)'\0', (byte)'\r', (byte)'\n', (byte)'\t']);

public static bool IsValidHeaderValue(ReadOnlySpan<byte> value)
{
    return value.IndexOfAny(InvalidHeaderBytes) < 0;
}
```

Der Byte-Pfad zieht 32 Bytes pro AVX2-Zyklus gegenüber 16 Chars; auf AVX-512-fähiger Hardware zieht er 64 Bytes gegenüber 32 Chars. Bei ASCII-Daten verdoppeln Sie den Durchsatz, indem Sie den UTF-16-Umweg sparen.

Der Compiler warnt nicht, wenn Sie versehentlich `char`-Codepoints über 127 auf eine Weise einsetzen, die bricht. Aber der SearchValues-Planer schaltet bewusst auf einen langsamen Pfad, wenn die Char-Menge über den BMP-ASCII-Bereich hinausgeht und gemischte bidi-Eigenschaften enthält. Wenn Ihr Benchmark sagt "das wurde langsamer als erwartet", prüfen Sie, ob Sie ein Nicht-ASCII-Zeichen in eine Menge gepackt haben, die nur ASCII enthalten sollte.

## Wann SearchValues NICHT zu verwenden ist

Eine kurze Liste der Fälle, in denen die richtige Antwort "lassen Sie es" lautet:

- **Ein Suchwert**. `span.IndexOf('x')` ist bereits vektorisiert. `SearchValues.Create("x")` fügt nur Overhead hinzu.
- **Zwei oder drei Char-Suchwerte, selten aufgerufen**. `span.IndexOfAny('a', 'b', 'c')` ist in Ordnung. Der Break-even liegt bei etwa vier Werten für Char und etwa zwei für String.
- **Eingaben kürzer als 16 Elemente**. Die SIMD-Kernels haben Setupkosten. Bei einer Span von 8 Zeichen gewinnt der skalare Vergleich.
- **Suchwerte, die sich pro Aufruf ändern**. Der ganze Sinn von `SearchValues` ist Amortisation. Wenn die Menge pro Aufruf eine Benutzereingabe ist, bleiben Sie bei den `IndexOfAny`-Überladungen oder `Regex` mit `RegexOptions.Compiled`.
- **Sie brauchen Gruppenerfassung oder Rückwärtsreferenzen**. `SearchValues` macht ausschließlich literalen Vergleich. Es ist kein Regex-Ersatz, nur ein schnelleres `Contains`.

## Allokationsfreie statische Initialisierung

Die `Create`-Überladungen akzeptieren `ReadOnlySpan<T>`. Sie können ein String-Literal übergeben (der C#-Compiler wandelt String-Literale seit .NET 7 über `RuntimeHelpers.CreateSpan` in `ReadOnlySpan<char>` um), ein Array oder einen Collection Expression. Alle drei erzeugen dieselbe `SearchValues<T>`-Instanz; der Compiler erzeugt für die String-Literal-Form keine Zwischenarrays.

```csharp
// .NET 11, C# 14 -- all three are equivalent in cost at runtime
private static readonly SearchValues<char> A = SearchValues.Create("abc");
private static readonly SearchValues<char> B = SearchValues.Create(['a', 'b', 'c']);
private static readonly SearchValues<char> C = SearchValues.Create(new[] { 'a', 'b', 'c' });
```

Für die String-Überladung muss die Eingabe ein Array (`string[]`) oder ein Collection Expression sein, der auf eines abzielt:

```csharp
private static readonly SearchValues<string> Tokens =
    SearchValues.Create(["select", "insert", "update"], StringComparison.OrdinalIgnoreCase);
```

Der Konstruktor kopiert die Suchwerte in den internen Zustand, das Quellarray wird also nicht gehalten. Das Quellarray nach der Konstruktion zu verändern, hat keinen Effekt auf die `SearchValues<string>`-Instanz. Das ist das Gegenteil von `Regex` mit gecachten Mustern, wo die Quellzeichenkette gehalten wird.

## Source-Generator-freundliches Muster

Wenn Sie eine `partial`-Klasse und einen Codegenerator haben (eigenen oder `System.Text.RegularExpressions.GeneratedRegex`), ist es ein sauberes Muster, ein `static readonly SearchValues<char>`-Feld als Teil der generierten Ausgabe zu erzeugen. Trim-sicher, AOT-sicher, ohne Reflection, ohne Heap-Allokation pro Aufruf.

```csharp
// .NET 11, C# 14 -- hand-rolled equivalent of what a generator would emit
internal static partial class IdentifierScanner
{
    private static readonly SearchValues<char> NonIdentifierChars =
        SearchValues.Create(GetNonIdentifierAscii());

    private static ReadOnlySpan<char> GetNonIdentifierAscii()
    {
        // Build a 96-element set of non-[A-Za-z0-9_] ASCII chars at type init.
        Span<char> buffer = stackalloc char[96];
        int i = 0;
        for (int c = ' '; c <= '~'; c++)
        {
            if (!(char.IsAsciiLetterOrDigit((char)c) || c == '_'))
                buffer[i++] = (char)c;
        }
        return buffer[..i].ToArray();
    }
}
```

Das `stackalloc` läuft genau einmal, weil `static readonly` vom Typinitialisierer der Laufzeit genau einmal initialisiert wird. Das `.ToArray()` ist die einzige Allokation in der Lebenszeit des Typs. Danach ist jede Suche allokationsfrei.

## Native AOT und Trim-Warnungen

`SearchValues<T>` ist vollständig kompatibel mit Native AOT. Innen gibt es keine Reflection und keine dynamische Codegenerierung zur Laufzeit. Ihr per AOT veröffentlichtes Binary enthält dieselben SIMD-Kernels wie die JIT-Version, ausgewählt zur AOT-Compile-Zeit anhand der angegebenen Ziel-ISA (`-r linux-x64` schließt standardmäßig x64-Baseline mit SSE2- und AVX2-Pfaden ein; `-p:TargetIsa=AVX-512` erweitert auf AVX-512). Keine Trim-Warnungen, keine `[DynamicallyAccessedMembers]`-Annotationen erforderlich.

Wenn Sie für `linux-arm64` veröffentlichen, werden die NEON-Kernels automatisch gewählt. Derselbe Quellcode kompiliert für beide Ziele ohne Codeverzweigung.

## Verwandte Lektüre

- [Span<T> vs ReadOnlySpan<T> und wann sich welcher rechnet](/2026/01/net-10-performance-searchvalues/) deckt eine ältere Momentaufnahme von `SearchValues` aus der .NET-10-Zeit ab; lesenswert für den SIMD-Hintergrund.
- [Channels statt BlockingCollection](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) ist der richtige Transport, wenn Sie Eingaben in einem Worker scannen.
- [Wie man große CSV-Dateien in .NET 11 ohne Speicherüberlauf liest](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) verwendet `SearchValues<char>` für die Trennzeichen-Suche im Parser.
- [Wie man erkennt, wann eine Datei in .NET fertig geschrieben ist](/de/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) passt natürlich zum CSV-Scanner oben, wenn Sie Inbox-Dateien konsumieren.

## Quellen

- [`SearchValues<T>`-Referenz, MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues-1) -- die kanonische API-Oberfläche, einschließlich der byte-, char- und string-Überladungen von `Create`.
- [`SearchValues.Create(ReadOnlySpan<string>, StringComparison)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.buffers.searchvalues.create) -- dokumentiert die vier unterstützten `StringComparison`-Werte und die `ArgumentException`, die für die anderen geworfen wird.
- [.NET runtime PR 90395 -- ursprüngliches `SearchValues<T>`](https://github.com/dotnet/runtime/pull/90395) -- die Einführung der byte- und char-Überladungen in .NET 8 mit der SIMD-Strategietabelle.
- [.NET runtime PR 96570 -- `SearchValues<string>`](https://github.com/dotnet/runtime/pull/96570) -- die Ergänzung der Multi-String-Aho-Corasick-/Teddy-Kernels in .NET 9.
- [Boosting string search performance in .NET 8.0 with SearchValues, endjin](https://endjin.com/blog/2024/01/dotnet-8-searchvalues-string-search-performance-boost) -- die sauberste externe Benchmark-Aufschreibung für den Char-Pfad.
