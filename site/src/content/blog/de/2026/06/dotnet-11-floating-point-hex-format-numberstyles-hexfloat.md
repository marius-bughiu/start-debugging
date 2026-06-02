---
title: ".NET 11 kann ein double bitgenau als Hex und zurück wandeln"
description: ".NET 11 Preview 4 bringt double, float und Half bei, mit dem X-Spezifizierer zu formatieren und mit NumberStyles.HexFloat zu parsen, und erzeugt denselben IEEE-754-Hex-Text wie printf(\"%a\") in C."
pubDate: 2026-06-02
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
lang: "de"
translationOf: "2026/06/dotnet-11-floating-point-hex-format-numberstyles-hexfloat"
translatedBy: "claude"
translationDate: 2026-06-02
---

Die [Bibliotheks-Notizen zu .NET 11 Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md) enthielten eine Funktion, die nach einem Nischenthema klingt, bis Sie sie eines Tages brauchen: `double`, `float` und `Half` lassen sich nun in IEEE-754-Hexadezimalform schreiben und wieder einlesen. Das ist dieselbe Notation, die C und C++ mit `printf("%a", ...)` ausgeben, und sie legt jedes Bit des Werts direkt im Text offen.

## Der X-Spezifizierer warf bei einem double bisher eine Ausnahme

Bisher war die Formatzeichenfolge `"X"` nur für Ganzzahlen gedacht. Riefen Sie sie auf einem Gleitkommawert auf, erhielten Sie eine `FormatException`:

```csharp
double value = Math.PI;
string hex = value.ToString("X"); // .NET 10: throws FormatException
```

Ab .NET 11 gibt derselbe Aufruf die Hex-Darstellung des float zurück:

```csharp
using System.Globalization;

double value = Math.PI;

string hex = value.ToString("X"); // "0X1.921FB54442D18P+1"
double round = double.Parse(hex, NumberStyles.HexFloat);

Console.WriteLine(round == value); // True, exact round-trip
```

Das neue Flag `NumberStyles.HexFloat` weist `Parse` und `TryParse` an, diese Form wieder einzulesen. Das führende `0X1.` ist die Mantisse, und `P+1` ist der binäre Exponent. Sie sehen also das wörtliche Bit-Layout, nicht eine dezimale Näherung davon.

## Der dezimale Round-Trip funktionierte bereits, wozu also der Aufwand

Hier lohnt sich Genauigkeit. Seit .NET Core 3.0 garantiert der kürzeste Round-Trip-Formatierer, dass `double.Parse(value.ToString())` exakt dasselbe `double` zurückgibt. Hex behebt also keinen Korrektheitsfehler beim dezimalen Round-Trip.

Was Hex bringt, sind Transparenz und Interoperabilität. Der Dezimaltext eines `double` ändert je nach Wert seine Form und verrät nicht, welche Bits gesetzt sind. Die Hex-Form ist kanonisch: Jedes unterschiedliche `double` wird auf genau eine Hex-Zeichenfolge abgebildet, und diese Zeichenfolge ist plattform- und sprachübergreifend bytegenau vergleichbar. Wenn Sie erwartete Werte in einem Test mit Referenzdatei festschreiben, ist eine Abweichung um ein Zeichen an der letzten Dezimalstelle ein echtes Ärgernis. Hex macht den Vergleich exakt und eindeutig.

## Wo es sich auszahlt

Der klarste Vorteil ist die sprachübergreifende Interoperabilität. Eine native Bibliothek, die floats mit `%a` protokolliert, oder eine numerische Testsuite, die mit einer C++-Codebasis geteilt wird, erzeugt Hex, das .NET nun direkt einlesen kann:

```csharp
// From a C++ component that printed with %a
string fromNative = "0X1.5BF0A8B145769P+1"; // ~2.718281828...
double e = double.Parse(fromNative, NumberStyles.HexFloat);
```

`Half` und `float` werden gleich behandelt, sodass Werte mit halber Genauigkeit aus einer ML-Pipeline oder einem GPU-Puffer den Round-Trip ohne verlustbehafteten Umweg über Dezimaltext schaffen. Laden Sie das [Preview 4 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) herunter, zielen Sie auf `net11.0`, und greifen Sie das nächste Mal, wenn Sie einen float für eine Test-Fixture oder einen Debug-Dump serialisieren müssen, zu `"X"` statt zu einem handgeschriebenen Tanz mit `BitConverter.DoubleToInt64Bits`.
