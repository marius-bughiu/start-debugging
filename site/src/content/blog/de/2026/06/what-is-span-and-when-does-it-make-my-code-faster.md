---
title: "Was ist Span<T> in C#, und wann macht es Ihren Code wirklich schneller?"
description: "Span<T> kann beim Verarbeiten zusammenhängender Speicherbereiche temporäre Kopien und Allokationen vermeiden. Lebensdauer, Puffer und Messung erklärt."
pubDate: 2026-06-20
updatedDate: 2026-11-02
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

`Span<T>` ist eine Sicht fester Länge auf zusammenhängenden Speicher, etwa ein Array, Stack-Speicher oder korrekt verwalteten nativen Speicher. `ReadOnlySpan<T>` erlaubt nur Lesen durch die Sicht. Strings liefern `ReadOnlySpan<char>`, keinen veränderbaren `Span<char>`.

Eine Sicht erzeugt und besitzt den zugrunde liegenden Speicher nicht selbst. Das macht weder den gesamten Vorgang allokationsfrei noch automatisch schneller.

**Korrektur — 2. November 2026:** Unbelegte Messwerte und allgemeine Geschwindigkeitsversprechen wurden entfernt. UTF-8-Literaltyp, Rückgabegrenzen und Allokationsangaben wurden korrigiert. Die Beispiele wurden mit SDK 10.0.302 und C# 14 geprüft, ohne Leistungsbenchmark.

## Temporäre Teilstrings vermeiden

Span-fähige Parser können Zwischenstrings vermeiden. Hier wird ein exaktes Datumsformat ohne separate Teilstrings für Jahr, Monat und Tag verarbeitet:

```csharp
using System;
using System.Globalization;

string input = "2026-06-01";
DateOnly date = ParseIsoDate(input.AsSpan());
Console.WriteLine(date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture));

static DateOnly ParseIsoDate(ReadOnlySpan<char> input) =>
    DateOnly.ParseExact(input, "yyyy-MM-dd", CultureInfo.InvariantCulture);
```

`ParseExact` prüft das Datum und wirft bei ungültiger Eingabe. Ist diese zu erwarten, eignet sich `TryParseExact`. Einzelne `int.Parse(input.Slice(...))`-Aufrufe allein prüfen weder Trennzeichen noch gültige Kalenderdaten.

## Einen begrenzten Arbeitspuffer verwenden

```csharp
using System;
using System.Globalization;

Span<char> scratch = stackalloc char[32];
if (12345.TryFormat(scratch, out int written, provider: CultureInfo.InvariantCulture))
{
    ReadOnlySpan<char> formatted = scratch[..written];
    Console.Out.WriteLine(formatted); // 12345
    string owned = new string(formatted); // Allocates the resulting string.
    Console.WriteLine(owned);
}

ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(method.SequenceEqual(new byte[] { 71, 69, 84 })); // True
```

Der Arbeitspuffer vermeidet ein temporäres Zeichenarray. Der abschließende `string` allokiert weiterhin. Auch das Bytearray des Vergleichs ist eine ausdrückliche Allokation; es zeigt die Werte und ist kein Benchmark. `"GET"u8` hat den Typ `ReadOnlySpan<byte>`.

`stackalloc` sollte klein und begrenzt bleiben. Große oder wiederholte Allokationen in Schleifen können den Stack erschöpfen; ungeprüfte Eingaben dürfen nicht die Größe bestimmen. Für größere Daten eignen sich Arrays oder sorgfältig verwaltete Poolpuffer.

## Gemeinsamer Speicher und Lebensdauer

Slicing kopiert keine Elemente. Ein arraybasierter Span darf zurückgegeben werden, wenn die Speicherlebensdauer passt; ein Span auf einen lokalen Stackpuffer darf die Methode nicht verlassen. Span-Felder sind in anderen `ref struct`-Typen erlaubt, nicht in gewöhnlichen Klassen oder Structs. Seit C# 13 können solche Lokale in async-Methoden vorkommen, solange sie kein `await` überspannen; dafür ist `Memory<T>` geeignet.

`ReadOnlySpan<T>` friert den Puffer nicht ein. Während der Nutzung von `CollectionsMarshal.AsSpan(list)` dürfen keine Elemente hinzugefügt oder entfernt werden, auch bei freier Listenkapazität.

## Sinnvolle Optimierungen messen

Suchen Sie nach tatsächlich vermeidbaren Kopien oder Allokationen: Teilstrings, kopierten Ausschnitten und temporären Formatierarrays. Normale Array- und Listenschleifen können bereits gut optimiert sein. Bounds-Check-Eliminierung und Durchsatz hängen von Runtime, Schleife und Arbeit ab; ein fester Beschleunigungsfaktor ist nicht belastbar.

Messen Sie gleichwertige Arbeit im Release-Modus auf der eingesetzten Runtime mit repräsentativen Daten. Vorbereitung gehört außerhalb der Messung; Allokationen, Quellcode und Ausgabe gehören zum Ergebnis. Hier werden keine neuen Laufzeitmessungen veröffentlicht.

Einfache implizite Array-zu-Span-Konvertierungen sind älter als C# 14. C# 14 erschien mit .NET 10 und erweitert die Sprachintegration. `allows ref struct` aus C# 13 gilt nur für ausdrücklich dafür ausgelegte generische APIs.

Zur Wahl des Besitzmodells siehe [List, Span und ReadOnlySpan](/de/2026/05/list-vs-span-vs-readonlyspan-in-csharp/); für async-Speicher [ReadOnlyMemory aus einem Array](/de/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/).

## Quellen

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
