---
title: "C# 15 Collection Expression Arguments: Konstruktoren inline mit with(...) übergeben"
description: "C# 15 fügt das with(...)-Element zu Collection Expressions hinzu und lässt Sie Kapazität, Vergleicher und andere Konstruktorargumente direkt im Initialisierer übergeben."
pubDate: 2026-04-13
tags:
  - "csharp-15"
  - "dotnet-11"
  - "collection-expressions"
lang: "de"
translationOf: "2026/04/csharp-15-collection-expression-arguments"
translatedBy: "claude"
translationDate: 2026-04-25
---

Collection Expressions kamen in C# 12 und haben seitdem neue Fähigkeiten aufgenommen. C# 15, das mit [.NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/overview) ausgeliefert wird, fügt ein fehlendes Stück hinzu: Sie können nun Argumente an den Konstruktor oder die Factory-Methode der Collection mit einem `with(...)`-Element übergeben, das am Anfang des Ausdrucks platziert wird.

## Warum das wichtig ist

Vor C# 15 leiteten Collection Expressions den Zieltyp ab und riefen dessen Standardkonstruktor auf. Wenn Sie ein `HashSet<string>` ohne Berücksichtigung der Groß-/Kleinschreibung oder ein `List<T>` mit vorab dimensionierter bekannter Kapazität brauchten, mussten Sie auf einen traditionellen Initialisierer oder ein Zwei-Schritt-Setup zurückgreifen:

```csharp
// C# 14 and earlier: no way to pass a comparer via collection expression
var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Hello", "HELLO" };

// Or the awkward two-step
List<string> names = new(capacity: 100);
names.AddRange(source);
```

Beide Muster brechen den prägnanten Fluss, für den Collection Expressions entworfen wurden.

## Inline-Konstruktorargumente mit `with(...)`

C# 15 lässt Sie stattdessen das hier schreiben:

```csharp
string[] values = ["one", "two", "three"];

// Pre-allocate capacity
List<string> names = [with(capacity: values.Length * 2), .. values];

// Case-insensitive set in a single expression
HashSet<string> set = [with(StringComparer.OrdinalIgnoreCase), "Hello", "HELLO", "hello"];
// set.Count == 1
```

Das `with(...)`-Element muss zuerst erscheinen. Danach funktioniert der Rest des Ausdrucks genauso wie jede andere Collection Expression: Literale, Spreads und verschachtelte Ausdrücke kombinieren sich alle normal.

## Dictionaries bekommen die gleiche Behandlung

Das Feature glänzt wirklich mit `Dictionary<TKey, TValue>`, wo Vergleicher häufig sind, Sie aber zuvor gezwungen waren, Collection Expressions ganz aufzugeben:

```csharp
Dictionary<string, int> headers = [
    with(StringComparer.OrdinalIgnoreCase),
    KeyValuePair.Create("Content-Length", 512),
    KeyValuePair.Create("content-length", 1024)  // overwrites the first entry
];
// headers.Count == 1
```

Ohne `with(...)` konnten Sie einen Vergleicher überhaupt nicht durch eine Collection Expression übergeben. Die einzige Option war ein Konstruktoraufruf gefolgt von manuellen Adds.

## Zu beachtende Einschränkungen

Einige Regeln, die im Hinterkopf behalten werden sollten:

- `with(...)` muss das **erste** Element im Ausdruck sein.
- Es wird nicht auf Arrays oder Span-Typen (`Span<T>`, `ReadOnlySpan<T>`) unterstützt, da diese keine Konstruktoren mit Konfigurationsparametern haben.
- Argumente können keinen `dynamic`-Typ haben.

## Eine natürliche Evolution

C# 12 gab uns die Syntax. C# 13 erweiterte `params`, um Collection Expressions zu akzeptieren. C# 14 verbreiterte implizite Span-Konvertierungen. Nun entfernt C# 15 den letzten häufigen Grund, Collection Expressions aufzugeben: Konstruktorkonfiguration. Wenn Sie bereits auf [.NET 11 Preview 2](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-2/) oder später sind, können Sie das heute mit `<LangVersion>preview</LangVersion>` in Ihrer Projektdatei ausprobieren.

Vollständige Spec: [Collection expression arguments proposal](https://github.com/dotnet/csharplang/blob/main/proposals/collection-expression-arguments.md).
