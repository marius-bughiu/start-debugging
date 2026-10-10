---
title: "Verschachtelte Klammern und ausgewogene Tags mit Balancing Groups in .NET Regex abgleichen"
description: "Balancing Groups (?<name>) und (?<-name>) machen aus einer .NET-Regex-Capture-Gruppe einen Stack, sodass ein einziges Muster beliebig tief verschachtelte Klammern oder <div>-Tags erfassen kann. Das vollständige Muster, die Funktionsweise des Stacks, die Erfassung des inneren Inhalts mit (?<inner-open>) und die auf .NET 11 RC1 geprüften Stolperfallen: die Prüfung auf leeren Stack, katastrophales Backtracking, NonBacktracking und gemischte Klammertypen."
pubDate: 2026-10-10
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "regex"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-match-nested-parentheses-with-balancing-groups-in-dotnet-regex"
translatedBy: "claude"
translationDate: 2026-10-10
---

**Kurze Antwort:** In .NET führt jede Capture-Gruppe einen Stack ihrer Captures, und eine Balancing Group erlaubt es, diesen Stack direkt im Muster zu befüllen und zu leeren. `(?<depth>)` legt bei einer öffnenden Klammer etwas auf den Stack, `(?<-depth>)` entfernt bei einer schließenden Klammer das oberste Element, und die Bedingung `(?(depth)(?!))` am Ende lässt den Treffer scheitern, falls noch etwas auf dem Stack liegt. Zusammengesetzt ergibt `\((?>[^()]+|\((?<depth>)|\)(?<-depth>))*(?(depth)(?!))\)` eine vollständige, beliebig tief verschachtelte Klammergruppe. Alle Beispiele unten wurden auf .NET 11 RC1 (`11.0.100-rc.1.26425.128`) ausgeführt, aber die Funktion existiert in `System.Text.RegularExpressions` unverändert seit .NET Framework 1.0, die Muster funktionieren also auch auf .NET 8, 9 und 10.

Die meisten Regex-Engines können das überhaupt nicht. Klassische reguläre Ausdrücke beschreiben reguläre Sprachen, und "ausgewogene Klammern" ist das Lehrbuchbeispiel für eine Sprache, die nicht regulär ist: Man braucht einen Zähler, und ein endlicher Automat hat keinen. PCRE und Perl lösen das mit Rekursion (`(?R)`). .NET ging einen anderen Weg und gibt Ihnen den Stack direkt. Sobald man den Stack sieht, wirkt die Syntax nicht mehr wie Zeilenrauschen.

## Warum `\(.*\)` und `\(.*?\)` beide das falsche Ergebnis liefern

Nehmen Sie die Eingabe `f(a(b)c) + g(d)` und die zwei Muster, zu denen jeder zuerst greift:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

var input = "f(a(b)c) + g(d)";

Console.WriteLine(Regex.Match(input, @"\(.*\)").Value);
// (a(b)c) + g(d)    greedy: runs to the LAST ')'

Console.WriteLine(Regex.Match(input, @"\(.*?\)").Value);
// (a(b)             lazy: stops at the FIRST ')'
```

Keines von beiden findet "die passende `)`". Das gierige Muster verschluckt zwei getrennte Gruppen, das lazy Muster schneidet die verschachtelte Gruppe in der Mitte durch. Gesucht ist die `)`, an der die Anzahl der öffnenden minus die der schließenden Klammern wieder auf null fällt, und dafür muss man zählen. Genau diesen Zähler liefern Balancing Groups.

## Wie eine .NET-Capture-Gruppe zum Stack wird

Wenn eine benannte Gruppe mehrfach an einem Treffer beteiligt ist (etwa innerhalb einer `*`-Schleife), verwirft .NET die früheren Captures nicht. `Match.Groups["name"].Captures` enthält alle in der richtigen Reihenfolge, und die Engine behandelt den jüngsten als oberstes Element eines Stacks. Deshalb sehen Rückverweise wie `\k<name>` immer den letzten Capture.

Die Syntax der Balancing Groups manipuliert diesen Stack:

| Syntax | Wirkung |
|---|---|
| `(?<open>...)` | Normale benannte Erfassung. Legt einen Capture auf den Stack von `open`. `(?<open>)` mit leerem Rumpf legt einen Capture der Breite null ab, der als reiner Zähler dient. |
| `(?<-open>...)` | Entfernt den obersten Capture vom Stack von `open`. Ist der Stack leer, **scheitert** diese Alternative und die Engine geht per Backtracking zurück. |
| `(?<inner-open>...)` | Entfernt `open` vom Stack und legt auf `inner` einen Capture ab, der vom Ende des entfernten Captures bis zum Beginn der aktuellen Position reicht. So greifen Sie den Inhalt zwischen einem zusammengehörigen Paar ab. |
| `(?(open)yes\|no)` | Bedingung: Nimmt den `yes`-Zweig, wenn auf dem Stack von `open` mindestens ein Capture liegt. |
| `(?!)` | Ein leerer negativer Lookahead. Er kann nie erfolgreich sein und bedeutet daher "hier scheitern". |

Die Formen mit einfachen Anführungszeichen `(?'open')`, `(?'-open')` und `(?'inner-open')` sind identisch; es gibt sie, damit Sie Muster in XML-Attributen ohne Escaping der spitzen Klammern schreiben können. Nummerierte Gruppen funktionieren ebenfalls: `(?<-1>\))` entfernt das oberste Element von Gruppe 1.

Eine Regel beim Parsen: Die Gruppe, von der Sie entfernen, muss irgendwo im Muster existieren. `^\)(?<-d>)` allein wirft `RegexParseException: Reference to undefined group name 'd'` aus dem `Regex`-Konstruktor, es gibt also keinen fehlgeschlagenen Treffer.

## Eine ausgewogene Klammergruppe Schritt für Schritt abgleichen

Hier ist das kanonische Muster, mit `RegexOptions.IgnorePatternWhitespace` geschrieben, damit es Kommentare tragen kann:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

var balanced = new Regex(@"
    \(                      # the outer opening paren
    (?>
        [^()]+              # a run of anything that is not a paren
      | \( (?<depth>)       # an inner '(' pushes onto 'depth'
      | \) (?<-depth>)      # an inner ')' pops 'depth' (fails if empty)
    )*
    (?(depth)(?!))          # if 'depth' is not empty, fail
    \)                      # the outer closing paren
", RegexOptions.IgnorePatternWhitespace);

foreach (Match m in balanced.Matches("f(a(b)c) + g(d) + h((x)"))
    Console.WriteLine($"{m.Value} @{m.Index}");

// (a(b)c) @1
// (d) @12
// (x) @20
```

Gehen wir `(a(b)c)` durch:

1. Das Literal `\(` verbraucht die äußere `(`. Der Stack `depth` ist leer.
2. `[^()]+` verbraucht `a`.
3. Die innere `(` trifft die zweite Alternative, und `(?<depth>)` legt einen Capture ab. Die Tiefe ist 1.
4. `[^()]+` verbraucht `b`.
5. Die `)` trifft die dritte Alternative, und `(?<-depth>)` entfernt das oberste Element. Die Tiefe ist 0.
6. `[^()]+` verbraucht `c`.
7. Die letzte `)` würde von der dritten Alternative entfernt, aber der Stack ist leer, also scheitert `(?<-depth>)`. Die Schleife endet und gibt diese `)` zurück.
8. `(?(depth)(?!))` sieht einen leeren Stack und nimmt keinen Zweig, ist also erfolgreich.
9. Das Literal `\)` verbraucht die äußere `)`. Treffer.

Schritt 7 ist der subtile. Dass das Entfernen bei leerem Stack scheitert, verhindert, dass die Schleife die äußere schließende Klammer frisst, und das Muster hält dadurch von selbst an der richtigen `)`.

Beachten Sie die letzte Eingabe, `h((x)`. Die erste `(` wird nie geschlossen, also kann dort kein Treffer beginnen. Die Engine rückt weiter, startet an der zweiten `(` und liefert das wohlgeformte `(x)` bei Index 20. Das ist meist genau das, was Sie wollen, wenn Sie Text nach vollständigen Gruppen durchsuchen.

## Warum die Prüfung `(?(depth)(?!))` nicht optional ist

Es ist verlockend, die Bedingung wegzulassen, weil das äußere `\(...\)` die Sache zu umklammern scheint. Tut es nicht. Vergleichen Sie die beiden Muster an `((a)`:

```csharp
// .NET 11, C# 14
var noCheck   = new Regex(@"\((?>[^()]+|\((?<d>)|\)(?<-d>))*\)");
var withCheck = new Regex(@"\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)");

Console.WriteLine(noCheck.Match("((a)").Value);    // ((a)   unbalanced!
Console.WriteLine(withCheck.Match("((a)").Value);  // (a)
```

Ohne die Prüfung nimmt das äußere `\(` die erste `(`, die Schleife legt die zweite `(` auf den Stack, verbraucht `a` und entfernt bei der `)` das oberste Element. Nun hat das abschließende `\)` nichts mehr zum Abgleichen, also geht die Engine per Backtracking zurück: Die Schleife gibt ihre letzte Iteration zurück (und macht das Entfernen rückgängig), und das abschließende `\)` nimmt stattdessen diese `)`. Der Treffer gelingt, obwohl noch eine `(` auf dem Stack liegt. Der Stack erzwingt nur "nie mehr schließen, als geöffnet wurde". "Alles schließen, was geöffnet wurde" ist die Aufgabe der Bedingung.

## Prüfen, ob eine ganze Zeichenkette ausgewogen ist

Um die Frage "ist diese Zeichenkette ausgewogen?" statt "finde ausgewogene Gruppen darin" zu beantworten, verankern Sie beide Enden und lassen die äußeren Literal-Klammern weg:

```csharp
// .NET 11, C# 14
var valid = new Regex(@"^(?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))$");

foreach (var s in new[] { "a(b(c)d)e", "a(b(c)d", "a)b(c", "", "())(" })
    Console.WriteLine($"'{s}': {valid.IsMatch(s)}");

// 'a(b(c)d)e': True
// 'a(b(c)d': False    one '(' left on the stack
// 'a)b(c': False      ')' with an empty stack
// '': True
// '())(': False
```

## Den Inhalt zwischen jedem zusammengehörigen Paar erfassen

Die Form mit zwei Namen `(?<inner-open>\))` entfernt `open` vom Stack und hält den Text zwischen der entfernten `(` und der aktuellen `)` als Capture von `inner` fest. Sie erhalten den Inhalt jeder Verschachtelungsebene, die innerste zuerst:

```csharp
// .NET 11, C# 14
var inner = new Regex(@"(?>[^()]+|(?<open>\()|(?<inner-open>\)))*(?(open)(?!))");

Match m = inner.Match("x(a(b)c)(d)");
foreach (Capture c in m.Groups["inner"].Captures)
    Console.WriteLine($"{c.Value} @{c.Index}");

// b @4
// a(b)c @2
// d @9
```

Die Reihenfolge entspricht der, in der die Paare **geschlossen** werden, deshalb steht `b` vor `a(b)c`. Wenn Sie nur die äußersten Gruppen brauchen, filtern Sie danach, dass kein anderer Capture mit seinem Bereich diesen enthält, oder wechseln Sie zurück zum Muster mit einer einzelnen Gruppe aus dem vorherigen Abschnitt und verwenden `Matches`.

## Verschachtelte `<div>`-Tags abgleichen

Dieselbe Struktur funktioniert für jedes Paar von Begrenzern, auch mehrzeichenlange. Die einzige Änderung betrifft den Zweig "alles andere": Statt einer Zeichenklasse verwenden Sie `(?!</?div\b).`, damit jeweils ein Zeichen verbraucht wird, aber nie der Anfang eines öffnenden oder schließenden `div`-Tags.

```csharp
// .NET 11, C# 14
var divs = new Regex(@"
    <div\b[^>]*>
    (?>
        <div\b[^>]*>  (?<depth>)
      | </div>        (?<-depth>)
      | (?!</?div\b) .
    )*
    (?(depth)(?!))
    </div>",
    RegexOptions.IgnorePatternWhitespace | RegexOptions.Singleline | RegexOptions.IgnoreCase);

var html = "<p>x</p><div class=\"a\">1<div>2</div>3</div><div>4</div>";
foreach (Match m in divs.Matches(html))
    Console.WriteLine(m.Value);

// <div class="a">1<div>2</div>3</div>
// <div>4</div>
```

`RegexOptions.Singleline` ist hier wichtig: Ohne diese Option passt `.` nicht auf `\n`, und das Muster scheitert stillschweigend an jedem `div`, das sich über mehrere Zeilen erstreckt.

Das reicht für Schnipsel aus Vorlagen, Log-Ausgaben oder Markup, das Sie selbst erzeugen. Es ist kein HTML-Parser. Kommentare mit `<div>`, Attribute mit `>`, CDATA und nicht geschlossene Void-Elemente führen es alle in die Irre. Für echtes HTML verwenden Sie AngleSharp oder HtmlAgilityPack.

## Stolperfallen, auf die Sie stoßen werden

### Eine fehlende atomare Gruppe verursacht katastrophales Backtracking

Das `(?>...)` um die Alternation ist keine Dekoration. Schreiben Sie `(?:...)` und `[^()]*` statt `[^()]+`, kann die Engine eine Folge einfacher Zeichen auf exponentiell viele Arten aufteilen, wenn der Treffer scheitert, und probiert alle durch, bevor sie aufgibt. Ich habe das auf .NET 11 RC1 mit einem Match-Timeout von 2 Sekunden und einer Eingabe mit 29 Zeichen gemessen:

```csharp
// .NET 11, C# 14
var input = "(" + new string('a', 25) + "(((";
var timeout = TimeSpan.FromSeconds(2);

var bad  = new Regex(@"^\((?:[^()]*|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)$", RegexOptions.None, timeout);
var good = new Regex(@"^\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)$", RegexOptions.None, timeout);

// bad.IsMatch(input)  -> RegexMatchTimeoutException after 2000 ms
// good.IsMatch(input) -> False in 0 ms
```

Zwei Korrekturen, setzen Sie beide ein: Umschließen Sie die Alternation mit `(?>...)`, damit jede Iteration sich auf das Verbrauchte festlegt, und verwenden Sie in einer Schleife `+` statt `*`, damit eine Iteration nie leer passen kann. Läuft das Muster auf nicht vertrauenswürdigen Eingaben, übergeben Sie zusätzlich ein Match-Timeout oder setzen `REGEX_DEFAULT_MATCH_TIMEOUT` für die Anwendungsdomäne.

### `RegexOptions.NonBacktracking` lehnt Balancing Groups ab

Die in .NET 7 hinzugekommene Engine mit linearer Laufzeit kennt keine Stacks und weist diese Muster daher schon im Konstruktor zurück:

```text
System.NotSupportedException: RegexOptions.NonBacktracking is not supported in
conjunction with expressions containing: 'balancing group (?<name1-name2>subexpression)
or (?'name1-name2' subexpression)'.
```

Atomare Gruppen `(?>...)` und Bedingungen auf Capture-Gruppen `(?(name)...)` lehnt sie mit derselben Exception ab, Sie können das Problem also nicht durch Umschreiben umgehen. Wenn Sie garantiert lineare Laufzeit auf feindlichen Eingaben brauchen, schreiben Sie stattdessen die weiter unten gezeigte Stack-Schleife mit 15 Zeilen. Das OpenTelemetry-Team ist mit dieser Engine in eine verwandte Falle getreten, beschrieben in [dem Beitrag zur NotSupportedException bei Wildcards in OpenTelemetry .NET 1.19.1](/de/2026/09/opentelemetry-dotnet-1-19-1-fixes-wildcard-notsupportedexception-on-net-8/).

### `[GeneratedRegex]` funktioniert problemlos

Der Source Generator unterstützt Balancing Groups, atomare Gruppen und Bedingungen, Sie können diese Muster also unverändert in die Kompilierzeit verlagern:

```csharp
// .NET 11, C# 14
using System.Text.RegularExpressions;

Console.WriteLine(Patterns.Call().Match("call(foo(1, bar(2)), 3);").Value);
// call(foo(1, bar(2)), 3)

static partial class Patterns
{
    [GeneratedRegex(@"\w+\((?>[^()]+|\((?<d>)|\)(?<-d>))*(?(d)(?!))\)")]
    public static partial Regex Call();
}
```

Falls Sie noch nicht migriert haben, behandelt [die Anleitung zum Ersetzen von new Regex(...) durch [GeneratedRegex]](/de/2026/08/how-to-replace-new-regex-with-the-generatedregex-source-generator-in-dotnet-11/) den Analyzer und den Code Fix, die das für Sie erledigen.

### Getrennte Stacks erzwingen keine Klammerreihenfolge

Die naheliegende Erweiterung auf `()`, `[]` und `{}` ist ein Stack pro Klammertyp:

```csharp
// .NET 11, C# 14
var multi = new Regex(@"^(?>
      [^()\[\]{}]+
    | (?<p>\() | (?<-p>\))
    | (?<b>\[) | (?<-b>\])
    | (?<c>\{) | (?<-c>\})
  )*(?(p)(?!))(?(b)(?!))(?(c)(?!))$", RegexOptions.IgnorePatternWhitespace);

Console.WriteLine(multi.IsMatch("{[()]}"));  // True
Console.WriteLine(multi.IsMatch("(]"));      // False
Console.WriteLine(multi.IsMatch("{[(])}"));  // True   <- wrong
```

Jeder Stack zählt seinen eigenen Typ korrekt, aber nichts verbindet sie miteinander, deshalb besteht `{[(])}` die Prüfung: Die `]` entfernt das oberste Element des Stacks `b`, obwohl die zuletzt geöffnete Klammer `(` war. Eine korrekte Verschränkung zu erzwingen setzt voraus, dass man weiß, welcher Typ oben auf einem einzigen gemeinsamen Stack liegt, und genau dort ist die Regex nicht mehr das richtige Werkzeug. Ein einfacher `Stack<char>` erledigt das in einem Durchlauf, und jeder kann es lesen:

```csharp
// .NET 11, C# 14
static bool IsBalanced(ReadOnlySpan<char> s)
{
    var stack = new Stack<char>();
    foreach (char ch in s)
    {
        switch (ch)
        {
            case '(' or '[' or '{': stack.Push(ch); break;
            case ')': if (!stack.TryPop(out var a) || a != '(') return false; break;
            case ']': if (!stack.TryPop(out var b) || b != '[') return false; break;
            case '}': if (!stack.TryPop(out var c) || c != '{') return false; break;
        }
    }
    return stack.Count == 0;
}

// IsBalanced("{[()]}") -> True
// IsBalanced("{[(])}") -> False
```

Wenn der kritische Pfad in einer langen Zeichenkette nur die nächste Klammer finden muss, ist [SearchValues<char> mit IndexOfAny](/de/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) der schnelle Weg, die Textabschnitte dazwischen zu überspringen.

### Anführungszeichen und Escapes innerhalb der Klammern

`f("(", x)` enthält eine unausgewogene `(` innerhalb eines Zeichenkettenliterals. Um Zeichenketten in Anführungszeichen zu überspringen, fügen Sie vor den anderen eine Alternative hinzu, die eine ganze Zeichenkette verbraucht, zum Beispiel `"(?:[^"\\]|\\.)*"`, und nehmen `"` aus der Klasse für "alles andere" heraus: `[^()"]+`. Jede weitere lexikalische Regel (Kommentare, Zeichenliterale, wörtliche Zeichenketten) ist eine weitere Alternative, und ab zwei oder drei davon ist ein handgeschriebener Tokenizer leichter zu warten.

### Zeilenbasierte Anker

Wenn Sie mehrzeilige Eingaben mit `^...$` und `RegexOptions.Multiline` prüfen, bedenken Sie, dass `$` standardmäßig nur `\n` erkennt. [.NET 11 RegexOptions.AnyNewLine](/de/2026/04/regex-anynewline-dotnet-11-preview-3/) löst die Fälle mit `\r\n` und Unicode-Zeilentrennern ohne `\r?`-Behelfe.

## Wann man überhaupt zu Balancing Groups greifen sollte

Balancing Groups sind das richtige Werkzeug, wenn Sie ohnehin ein Problem in Regex-Form haben: ein Suchen-und-Ersetzen über Quelldateien, ein Log-Filter, ein Validierungsattribut, ein Suchdialog eines Editors, der .NET-Muster akzeptiert. Sie lassen einen einzelnen Ausdruck die Verschachtelung bewältigen, die Sie sonst zu einem Parser zwingen würde. Sobald Sie eine Reihenfolge über mehrere Klammertypen, Escape-Behandlung oder Fehlerpositionen ("unerwartete `)` in Spalte 14") brauchen, schreiben Sie die Schleife. Der Stack, den Sie in der Regex simuliert haben, ist in C# ein Einzeiler.

## Quellen

- [Grouping constructs: balancing group definitions](https://learn.microsoft.com/en-us/dotnet/standard/base-types/grouping-constructs-in-regular-expressions#balancing-group-definitions), MS Learn
- [Alternation constructs: conditional matching with a named group](https://learn.microsoft.com/en-us/dotnet/standard/base-types/alternation-constructs-in-regular-expressions), MS Learn
- [Regular expression options: NonBacktracking mode](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-options#nonbacktracking-mode), MS Learn
- [Backtracking in regular expressions](https://learn.microsoft.com/en-us/dotnet/standard/base-types/backtracking-in-regular-expressions), MS Learn
- [.NET regular expression source generators](https://learn.microsoft.com/en-us/dotnet/standard/base-types/regular-expression-source-generators), MS Learn
