---
title: "RegexOptions.AnyNewLine landet in .NET 11 Preview 3: Unicode-bewusste Anchors ohne die \\r?-Hacks"
description: ".NET 11 Preview 3 fügt RegexOptions.AnyNewLine hinzu, damit ^, $, \\Z und . jede Unicode-Newline-Sequenz erkennen, inklusive \\r\\n, NEL, LS und PS, wobei \\r\\n als ein atomarer Break behandelt wird."
pubDate: 2026-04-19
tags:
  - "dotnet"
  - "dotnet-11"
  - "regex"
  - "csharp"
lang: "de"
translationOf: "2026/04/regex-anynewline-dotnet-11-preview-3"
translatedBy: "claude"
translationDate: 2026-04-24
---

Wenn Sie je einen Multiline-Regex in .NET geschrieben und `\r?$` gegriffen haben, um zwischen Windows- und Unix-Dateien sicher zu sein, fällt der Workaround endlich weg. .NET 11 Preview 3 führt `RegexOptions.AnyNewLine` ein, das der Engine den vollen Satz Unicode-Zeilenterminatoren beibringt, ohne dass Sie jeden einzeln von Hand buchstabieren müssen.

Die Option wurde schon im dotnet/runtime Issue [25598](https://github.com/dotnet/runtime/issues/25598) angefragt und ist mit dem Preview-3-Drop am 14. April 2026 gelandet. Details im [.NET 11 Preview 3 Announcement](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-3/).

## Was die Option tatsächlich ändert

Mit gesetztem `RegexOptions.AnyNewLine` erkennen die Anchors `^`, `$` und `\Z` plus `.`, wenn `Singleline` nicht aktiv ist, jede gebräuchliche Newline-Sequenz, die Unicode TR18 RL1.6 definiert:

- `\r\n` (CR+LF)
- `\r` (CR)
- `\n` (LF)
- `\u0085` (NEL, Next Line)
- `\u2028` (Line Separator)
- `\u2029` (Paragraph Separator)

Entscheidend: `\r\n` wird als atomare Sequenz behandelt. Das heißt, `^` zündet nicht zwischen dem `\r` und dem `\n`, und `.` konsumiert nicht nur das `\r` und lässt das `\n` baumeln. Dieses eine Verhalten löscht eine Klasse von Cross-Plattform-Bugs, die Regex-lastige Parser seit Jahren herumschleppen.

## Vorher vs nachher

Stellen Sie sich vor, Sie wollen jede nicht-leere Zeile aus einer gemischten Datei, die auf Windows, dann Linux editiert und dann durch ein altes Mac-Tool geschickt wurde. In .NET 10 kompensieren Sie jede Newline-Variante manuell:

```csharp
// .NET 10 style: opt in to every flavor manually
var legacy = new Regex(
    @"^(?<line>.+?)(?:\r?\n|\u2028|\u2029|\u0085|\z)",
    RegexOptions.Multiline);
```

In .NET 11 Preview 3 komprimiert dieselbe Absicht zu:

```csharp
using System.Text.RegularExpressions;

var modern = new Regex(
    @"^(?<line>.+)$",
    RegexOptions.Multiline | RegexOptions.AnyNewLine);

string input = "first\r\nsecond\nthird\u2028fourth\u2029fifth\u0085sixth";

foreach (Match m in modern.Matches(input))
{
    Console.WriteLine(m.Groups["line"].Value);
}
```

Jede Zeile druckt sauber, ohne manuelle Kompensation, und `\r` leckt bei Windows-Input nie in die erfasste Gruppe.

## Mit was es sich weigert zu kombinieren

Zwei Kombinationen werden zur Konstruktionszeit abgelehnt. Beide werfen `ArgumentOutOfRangeException`:

```csharp
// Both throw at construction
new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.NonBacktracking);

new Regex(@"^line$",
    RegexOptions.AnyNewLine | RegexOptions.ECMAScript);
```

Die `NonBacktracking`-Engine backt ihr eigenes Newline-Modell in die DFA, und die `ECMAScript`-Variante ist absichtlich an ECMA-262-Semantik fixiert. Einen der beiden stillschweigend den Unicode-Satz erben zu lassen, würde das Matching-Verhalten auf eine Weise ändern, die Caller nicht leicht entdecken können, also scheitert die Runtime lautstark bei der Konstruktion, statt überraschende Matches zur Laufzeit zu produzieren.

`RegexOptions.Singleline` ist die freundliche Kombination. Mit beiden `Singleline` und `AnyNewLine` gesetzt, matcht `.` jedes Zeichen inklusive Newlines, und `^`, `$` und `\Z` behalten das volle Unicode-Anchor-Verhalten.

## Warum das für Log- und Content-Parser zählt

Die meisten selbstgebauten `\r?\n`-Shims in .NET-Codebases existieren, weil das Standard-Regex-Verhalten nur `\n` als Zeilenumbruch behandelt. Logs, CSVs, RFC-822-Header und Inhalt, der aus Terminals eingefügt wurde, laufen alle darin auf, sobald ein `\r\n` oder ein verirrtes `\u2028` auftaucht. Jeder defensive Split, jeder "ist das eine Windows-Datei"-Check, jedes Off-by-One, wenn ein Unicode-Separator in den Buffer rutscht, zahlte diese Steuer.

`RegexOptions.AnyNewLine` ist eine kleine API, aber sie entfernt eine langjährige Quelle von Cross-Plattform-Regex-Bugs. Wenn Sie einen Parser, Log Shipper oder Text-Indexer in .NET pflegen, ist Preview 3 die Release, in der Sie endlich anfangen können, diese Workarounds zurückzuschneiden.
