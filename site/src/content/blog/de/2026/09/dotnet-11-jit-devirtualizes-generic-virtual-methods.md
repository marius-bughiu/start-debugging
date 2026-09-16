---
title: "Der JIT in .NET 11 devirtualisiert generische virtuelle Methoden, und die Allokation verschwindet gleich mit"
description: "Stephen Toubs Artikel Performance Improvements in .NET 11 zeigt Aufrufe generischer virtueller Methoden, die von 6,7 ns und 24 Byte auf 1,8 ns und null Allokationen fallen. Drei RyuJIT-Pull-Requests haben Inlining bei dem Dispatch freigeschaltet, der in .NET bisher der undurchsichtigste war."
pubDate: 2026-09-16
tags:
  - "dotnet"
  - "dotnet-11"
  - "jit"
  - "performance"
  - "csharp"
lang: "de"
translationOf: "2026/09/dotnet-11-jit-devirtualizes-generic-virtual-methods"
translatedBy: "claude"
translationDate: 2026-09-16
---

Stephen Toub hat am 2026-09-15 ["Performance Improvements in .NET 11"](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-11/) veröffentlicht, und im Abschnitt zur Deabstraktion steckt eine Änderung, die jahrelang blockiert war: RyuJIT kann generische virtuelle Methoden jetzt devirtualisieren.

GVMs sind seit langem die langsamste Dispatch-Form in .NET, und das aus einem strukturellen Grund. Eine normale virtuelle Methode hat einen vtable-Slot, der Compiler weiß also, wo er nachsehen muss. `int SizeOf<T>(T value)` auf einem Interface hat keinen einzelnen Slot, denn jede Instanziierung ist ein eigener Methodenrumpf, identifiziert über die Typargumente. Einen davon aufzulösen bedeutet eine Suche zur Laufzeit, und für den JIT ist das Ergebnis ein undurchsichtiger Funktionszeiger. Undurchsichtig heißt kein Inlining, und ohne Inlining sieht die Escape-Analyse nie durch den Aufruf hindurch.

## Der Benchmark aus dem Artikel

```csharp
[Benchmark]
public int NonShared() => ((IProcessor)new Processor()).SizeOf(42);

[Benchmark]
public int Shared() => ((IProcessor)new Processor()).SizeOf("hello");

private interface IProcessor
{
    int SizeOf<T>(T value);
}

private sealed class Processor : IProcessor
{
    public int SizeOf<T>(T value) => Unsafe.SizeOf<T>();
}
```

`NonShared` instanziiert über `int`, die Laufzeit kompiliert also einen eigenen Rumpf. `Shared` instanziiert über `string` und nutzt damit den gemeinsam genutzten Rumpf für Referenztypen, weshalb ein generisches Kontextargument durch den Aufruf gereicht werden muss. Beide waren bisher langsam:

| Methode | Runtime | Mittelwert | Ratio | Alloziert |
| --- | --- | --- | --- | --- |
| NonShared | .NET 10.0 | 6.678 ns | 1.00 | 24 B |
| NonShared | .NET 11.0 | 1.764 ns | 0.26 | 0 B |
| Shared | .NET 10.0 | 7.166 ns | 1.00 | 24 B |
| Shared | .NET 11.0 | 1.764 ns | 0.25 | 0 B |

## Drei Pull Requests, der Reihe nach

[dotnet/runtime#120866](https://github.com/dotnet/runtime/pull/120866) kam zuerst, im November 2025, und ist der Blocker-Löser. Der JIT hat das Aufrufziel von `ldvirtftn` bisher in eine temporäre Variable ausgelagert, bevor die Argumente aufgebaut wurden, und das genügte, um den Dispatch für den restlichen Pipeline-Durchlauf undurchsichtig zu halten. Der Wegfall dieses Spills erlaubt es, die Auswertung des Ziels vor die Auswertung der Argumente zu ziehen, sofern das zulässig ist.

[dotnet/runtime#122023](https://github.com/dotnet/runtime/pull/122023) hat dem JIT dann beigebracht, nicht geteilte GVMs zu devirtualisieren, inklusive des generischen Kontexts, den der Aufruf braucht, damit aus dem indirekten Dispatch ein direkter, inlinebarer Aufruf wird. [dotnet/runtime#128702](https://github.com/dotnet/runtime/pull/128702) hat das auf geteilte GVMs und auf Default Interface Implementations ausgeweitet, die Instantiating Stubs benötigen. Deshalb landet die Zeile `Shared` bei denselben 1.764 ns wie `NonShared`.

## Warum die 24 Byte verschwinden

Die Allokation war nie der Zweck des Aufrufs. `new Processor()` existiert nur, damit der Cast auf das Interface einen Empfänger hat. In .NET 10 zwang der undurchsichtige Aufruf den JIT zur Annahme, der Empfänger entkomme, also landete `Processor` auf dem Heap: 24 Byte pro Aufruf.

Sobald der Aufruf eingebettet ist, kann die Escape-Analyse beweisen, dass das Objekt den Frame nie verlässt. Die Instanz wird auf dem Stack alloziert, niemand liest sie, und sie fällt vollständig weg. `Unsafe.SizeOf<T>()` wird im selben Durchlauf zu einer Konstante. Der Faktor 3,8 ist real, aber die Null in der Spalte Alloziert ist der Teil, der sich in einem Dienst mit hoher GC-Last bemerkbar macht.

Eine Einschränkung: Der JIT muss den exakten Empfängertyp an der Aufrufstelle kennen, wie hier bei einem lokal erzeugten `sealed` Typ. An einer wirklich polymorphen Aufrufstelle verlassen Sie sich weiterhin auf die guarded Devirtualization aus [dynamischem PGO](/de/2026/07/what-is-pgo-in-dotnet-and-do-i-need-to-opt-in/), die eine Typprüfung plus einen eingebetteten schnellen Pfad liefert statt eines direkten Aufrufs.

Wer Visitor-Interfaces, generische Serializer-Hooks oder irgendeine Abstraktion schreibt, bei der der Typparameter an der Methode und nicht am Typ hängt, sollte genau diese .NET 11 Änderung am eigenen Code messen. Der [vollständige Artikel](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-11/) enthält das Disassembly.
