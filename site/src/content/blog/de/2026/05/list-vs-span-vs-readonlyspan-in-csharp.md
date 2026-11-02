---
title: "List<T> vs Span<T> vs ReadOnlySpan<T> in C#: wann welcher Typ"
description: "List<T> für wachsende Sammlungen, Span<T> für veränderbare Sichten und ReadOnlySpan<T> zum Lesen: Lebensdauer, Rückgabe und async-Grenzen."
pubDate: 2026-05-25
updatedDate: 2026-11-02
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

`List<T>` verwaltet eine wachsende Sammlung. `Span<T>` ist eine Sicht fester Länge auf zusammenhängenden Speicher; `ReadOnlySpan<T>` verhindert Schreibzugriffe durch diese Sicht. Eine Sicht ersetzt weder Eigentum am Puffer noch dessen Lebensdauerverwaltung.

**Korrektur — 2. November 2026:** Nicht belegte .NET-11-Benchmarkzahlen wurden entfernt; Aussagen zu Rückgaben, Feldern und Versionen wurden korrigiert. Die Beispiele wurden mit SDK 10.0.302 und C# 14 geprüft. Ein allgemeiner Geschwindigkeitsvorteil wird nicht behauptet.

## Nach Aufgabe und Lebensdauer wählen

| Aufgabe | Ausgangspunkt |
| --- | --- |
| Eine Sammlung schrittweise aufbauen | `List<T>` |
| Vorhandenen zusammenhängenden Speicher synchron lesen oder ändern | `Span<T>` |
| Ohne Schreibzugriff durch die Sicht lesen | `ReadOnlySpan<T>` |
| Eine Sicht in einer Klasse oder über `await` behalten | `Memory<T>` / `ReadOnlyMemory<T>` |

Ein Span besitzt seinen Puffer nicht. Ein arraybasierter Span darf zurückgegeben werden, wenn die Lebensdauer des Speichers passt. Ein Span auf einen lokalen `stackalloc`-Puffer darf das nicht. Span-Felder sind in anderen `ref struct`-Typen möglich, nicht in gewöhnlichen Klassen oder Structs. Boxing und Erfassen in Lambdas sind ausgeschlossen.

Seit C# 13 können ref-struct-Lokale in async-Methoden verwendet werden, sofern sie kein `await` überleben. Dafür eignet sich eine Memory-Sicht. Eine schreibgeschützte Sicht macht den Puffer selbst nicht unveränderlich: Andere Referenzen können ihn weiterhin ändern.

## Ohne Kopie ändern

```csharp
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

var values = new List<int> { 3, 9, 4 };
Span<int> view = CollectionsMarshal.AsSpan(values);
view[1] = 20;
Console.WriteLine(values[1]); // 20

int[] array = { 10, 20, 30 };
Span<int> tail = Tail(array);
tail[0] = 99;
Console.WriteLine(array[1]); // 99

static Span<int> Tail(int[] source) => source.AsSpan(1);
```

Die Sichten teilen ihren Speicher mit der ursprünglichen Sammlung. `Tail` gibt einen gültigen Span auf ein Array zurück, keinen lokalen Stackpuffer. Während eine Sicht aus `CollectionsMarshal.AsSpan` verwendet wird, dürfen keine Listenelemente hinzugefügt oder entfernt werden, auch ohne Größenänderung des internen Arrays. Die normale Listen-API bleibt der Ausgangspunkt, solange Messungen keinen Bedarf zeigen.

## Schreibgeschützte Eingabe

```csharp
using System;

ReadOnlySpan<char> text = "2026-05-25".AsSpan(0, 4);
ReadOnlySpan<byte> method = "GET"u8;
Console.WriteLine(int.Parse(text)); // 2026
Console.WriteLine(method.Length);   // 3
```

Strings liefern `ReadOnlySpan<char>`, UTF-8-Literale `ReadOnlySpan<byte>`. Ein veränderbarer Span kann in einen schreibgeschützten umgewandelt werden, umgekehrt nicht. Leser sollten den schreibgeschützten Parametertyp verwenden.

C# 14 erschien mit .NET 10. Einfache implizite Array-zu-Span-Konvertierungen gab es schon vorher; C# 14 erweitert die Sprachunterstützung etwa bei Typinferenz und Empfängern von Erweiterungsmethoden. `allows ref struct` aus C# 13 erlaubt entsprechende generische Argumente nur bei ausdrücklich dafür ausgelegten APIs. `List<Span<int>>` wird dadurch nicht zulässig.

## Den konkreten Vorgang messen

Span-Slicing kann Kopien oder Teilstring-Allokationen vermeiden. Es garantiert keine schnellere Schleife: JIT, Runtime, Datenmenge und Arbeit im Schleifenkörper spielen eine Rolle. Neu erzeugte Strings, Arrays und Listen können weiterhin allokieren. Zu veröffentlichten Messwerten gehören vollständiger Quellcode, Konfiguration und Ausgabe.

Für async-Puffer siehe [Array in ReadOnlyMemory umwandeln](/de/2026/05/how-to-convert-array-to-readonlymemory-in-csharp/); für Verarbeitung und temporäre Puffer siehe [wann Spans die Leistung verbessern können](/de/2026/06/what-is-span-and-when-does-it-make-my-code-faster/).

## Quellen

- [Memory and Span usage guidelines](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-spans/memory-t-usage-guidelines)
- [Span<T>](https://learn.microsoft.com/en-us/dotnet/api/system.span-1?view=net-10.0)
- [CollectionsMarshal.AsSpan](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.collectionsmarshal.asspan?view=net-10.0)
- [C# 14 first-class span types](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-14.0/first-class-span-types.md)
- [C# 13 ref struct interfaces and generic arguments](https://github.com/dotnet/csharplang/blob/main/proposals/csharp-13.0/ref-struct-interfaces.md)
