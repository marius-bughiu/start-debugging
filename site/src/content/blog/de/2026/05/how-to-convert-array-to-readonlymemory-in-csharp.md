---
title: "T[] in ReadOnlyMemory<T> in C# umwandeln (impliziter Operator und expliziter Konstruktor)"
description: "Drei Wege, ein T[] in .NET 11 in ein ReadOnlyMemory<T> einzuhüllen: die implizite Konvertierung, der explizite Konstruktor und AsMemory(). Wann welcher der richtige ist."
pubDate: 2026-05-04
tags:
  - "csharp"
  - "dotnet"
  - "performance"
  - "memory"
template: "how-to"
lang: "de"
translationOf: "2026/05/how-to-convert-array-to-readonlymemory-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-04
---

Wenn Sie nur eine `ReadOnlyMemory<T>`-Sicht auf ein bestehendes Array wollen, ist der kürzeste Weg die implizite Konvertierung: `ReadOnlyMemory<byte> rom = bytes;`. Wenn Sie einen Slice brauchen, bevorzugen Sie `bytes.AsMemory(start, length)` oder `new ReadOnlyMemory<byte>(bytes, start, length)`. Alle drei sind allokationsfrei, aber nur der Konstruktor und `AsMemory` akzeptieren Offset und Länge, und nur der Konstruktor ist an der Aufrufstelle explizit (was im Code-Review zählt).

In diesem Beitrag referenzierte Versionen: .NET 11 (Laufzeit), C# 14. `System.Memory` ist im modernen .NET Teil von `System.Runtime`, daher ist kein zusätzliches Paket nötig.

## Warum es mehr als einen Konvertierungspfad gibt

`ReadOnlyMemory<T>` ist seit .NET Core 2.1 in der BCL (und im `System.Memory` NuGet-Paket auf .NET Standard 2.0). Microsoft hat absichtlich mehrere Einstiegspunkte hinzugefügt: einen reibungslosen für den 90-Prozent-Fall, einen expliziten Konstruktor für Code, der die Konvertierung sichtbar machen muss, und eine Erweiterungsmethode, die `AsSpan()` widerspiegelt, sodass Sie ohne Kontextwechsel zwischen Span und Memory wechseln können.

Konkret stellt die BCL bereit:

1. Eine implizite Konvertierung von `T[]` zu `Memory<T>` und von `T[]` zu `ReadOnlyMemory<T>`.
2. Eine implizite Konvertierung von `Memory<T>` zu `ReadOnlyMemory<T>`.
3. Den Konstruktor `new ReadOnlyMemory<T>(T[])` und die Slicing-Überladung `new ReadOnlyMemory<T>(T[] array, int start, int length)`.
4. Die Erweiterungsmethoden `AsMemory<T>(this T[])`, `AsMemory<T>(this T[], int start)`, `AsMemory<T>(this T[], int start, int length)` und `AsMemory<T>(this T[], Range)`, definiert auf `MemoryExtensions`.

Jeder Pfad ist allokationsfrei. Die Wahl ist meist stilistisch, mit zwei echten Unterschieden: nur der Konstruktor und `AsMemory` akzeptieren einen Slice, und nur die implizite Konvertierung lässt ein `T[]`-Argument in einen `ReadOnlyMemory<T>`-Parameter fließen, ohne dass der Aufrufer etwas schreibt.

## Das minimale Beispiel

```csharp
// .NET 11, C# 14
using System;

byte[] payload = "hello"u8.ToArray();

// Path 1: implicit operator
ReadOnlyMemory<byte> a = payload;

// Path 2: explicit constructor, full array
ReadOnlyMemory<byte> b = new ReadOnlyMemory<byte>(payload);

// Path 3: explicit constructor, slice
ReadOnlyMemory<byte> c = new ReadOnlyMemory<byte>(payload, start: 1, length: 3);

// Path 4: AsMemory extension, full array
ReadOnlyMemory<byte> d = payload.AsMemory();

// Path 5: AsMemory extension, slice with start + length
ReadOnlyMemory<byte> e = payload.AsMemory(start: 1, length: 3);

// Path 6: AsMemory extension, range
ReadOnlyMemory<byte> f = payload.AsMemory(1..4);
```

Alle sechs erzeugen `ReadOnlyMemory<byte>`-Instanzen, die in dasselbe zugrunde liegende Array zeigen. Keiner kopiert das Array. Alle sechs sind in engen Schleifen sicher, weil die Kosten ein kleiner Struct-Copy sind, kein Buffer-Copy.

## Wann der implizite Operator der richtige ist

Die implizite Konvertierung von `T[]` zu `ReadOnlyMemory<T>` ist an Aufrufstellen am saubersten, an denen der Zieltyp bereits ein `ReadOnlyMemory<T>`-Parameter ist:

```csharp
// .NET 11
public Task WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct = default)
{
    // ...
    return Task.CompletedTask;
}

byte[] payload = GetPayload();
await WriteAsync(payload); // implicit conversion happens here
```

Sie schreiben weder `payload.AsMemory()` noch `new ReadOnlyMemory<byte>(payload)`. Der Compiler emittiert die Konvertierung für Sie. Das zählt in zweierlei Hinsicht: die Aufrufstelle bleibt in heißem Code lesbar, und Ihre API kann `ReadOnlyMemory<T>` annehmen, ohne jeden Aufrufer zu zwingen, einen neuen Typ zu lernen.

Der Kompromiss ist, dass die Konvertierung unsichtbar ist. Wenn Sie wollen, dass ein Code-Reviewer bemerkt, "dieser Code übergibt jetzt eine `ReadOnlyMemory<T>`-Sicht statt eines Arrays", verbirgt der implizite Operator das.

## Wann der Konstruktor seine Ausführlichkeit wert ist

`new ReadOnlyMemory<byte>(payload, start, length)` ist die explizite Form. Sie greifen in drei Situationen darauf zurück:

1. **Sie brauchen einen Slice mit Offset und Länge.** Die implizite Konvertierung deckt immer das gesamte Array ab.
2. **Sie wollen, dass die Aufrufstelle die Konvertierung sichtbar macht.** Ein Feld wie `private ReadOnlyMemory<byte> _buffer;`, das per Konstruktor initialisiert wird, ist leichter zu greppen als ein impliziter Operator.
3. **Sie wollen, dass der Compiler Offset und Länge einmal bei der Konstruktion auf Grenzen prüft.** Alle Pfade führen letztlich Bounds-Checks durch, aber der Konstruktor akzeptiert `start` und `length` als Parameter und wirft sofort `ArgumentOutOfRangeException`, wenn sie außerhalb des Arrays liegen, bevor irgendein Konsument den Speicher anfasst.

```csharp
// .NET 11
byte[] frame = ReceiveFrame();
const int headerLength = 16;

// Skip the header. Bounds-checked here, not when the consumer reads.
var payload = new ReadOnlyMemory<byte>(frame, headerLength, frame.Length - headerLength);

await ProcessAsync(payload);
```

Wenn `frame.Length < headerLength`, wird die `ArgumentOutOfRangeException` an der Konstruktionsstelle geworfen, wo die lokalen Variablen noch im Gültigkeitsbereich sind und ein Debugger Ihnen zeigen kann, was `frame.Length` tatsächlich war. Wenn Sie das Slicing in `ProcessAsync` verschieben, verlieren Sie diese Lokalität, und der Fehler erscheint dort, wo der Slice schließlich materialisiert wird.

## Wann stattdessen `AsMemory()` zu verwenden ist

`AsMemory()` ist dasselbe wie der Konstruktor, mit zwei ergonomischen Vorteilen: es liest sich von links nach rechts (`payload.AsMemory(1, 3)` statt `new ReadOnlyMemory<byte>(payload, 1, 3)`), und es hat eine `Range`-Überladung, sodass die Slicing-Syntax von C# funktioniert:

```csharp
// .NET 11, C# 14
byte[] payload = GetPayload();
const int headerLength = 16;

ReadOnlyMemory<byte> body = payload.AsMemory(headerLength..);
ReadOnlyMemory<byte> first16 = payload.AsMemory(..headerLength);
ReadOnlyMemory<byte> middle = payload.AsMemory(8..24);
```

`AsMemory(Range)` gibt `Memory<T>` zurück, und die Umwandlung in `ReadOnlyMemory<T>` läuft hier über die implizite Konvertierung von `Memory<T>` zu `ReadOnlyMemory<T>`. Auch das ist allokationsfrei.

Wenn Sie `AsSpan()` (das gleiche Muster für `Span<T>`) bereits verinnerlicht haben, ist `AsMemory()` die Version dieser Gewohnheit, die ein `await` überlebt.

## Was bei `null`-Arrays passiert

Ein `null`-Array an die implizite Konvertierung oder an `AsMemory()` zu übergeben, wirft keine Exception. Es erzeugt ein Default-`ReadOnlyMemory<T>`, das semantisch `ReadOnlyMemory<T>.Empty` entspricht (`IsEmpty == true`, `Length == 0`):

```csharp
// .NET 11
byte[]? maybeNull = null;

ReadOnlyMemory<byte> a = maybeNull;            // default, not a NullReferenceException
ReadOnlyMemory<byte> b = maybeNull.AsMemory(); // also default
// new ReadOnlyMemory<byte>(maybeNull) also returns default
```

Der Konstruktor mit einem Argument `new ReadOnlyMemory<T>(T[]? array)` dokumentiert das ausdrücklich: eine Null-Referenz erzeugt ein Default-`ReadOnlyMemory<T>`. Der dreiargumentige `new ReadOnlyMemory<T>(T[]? array, int start, int length)` wirft `ArgumentNullException`, wenn das Array null ist und Sie einen `start` oder `length` ungleich null angeben, weil die Grenzen gegen `null` nicht erfüllt werden können.

Diese `null`-Toleranz ist praktisch für optionale Payloads, aber auch eine Falle: ein Aufrufer, der `null` übergibt, erhält stillschweigend einen leeren Puffer statt eines Crashs, was einen Bug weiter oben verdecken kann. Wenn Ihre Methode darauf angewiesen ist, dass das Array nicht null ist, validieren Sie vor dem Einhüllen.

## Das Slicen des Ergebnisses ist ebenfalls kostenlos

Sobald Sie ein `ReadOnlyMemory<T>` haben, erzeugt der Aufruf von `.Slice(start, length)` ein weiteres `ReadOnlyMemory<T>` über demselben zugrunde liegenden Speicher. Es gibt keine zweite Kopie und keine zweite Allokation:

```csharp
// .NET 11
ReadOnlyMemory<byte> all = payload.AsMemory();

ReadOnlyMemory<byte> head = all.Slice(0, 16);
ReadOnlyMemory<byte> body = all.Slice(16);
```

Der `ReadOnlyMemory<T>`-Struct speichert eine Referenz auf das ursprüngliche `T[]` (oder einen `MemoryManager<T>`), einen Offset innerhalb dieses Speichers und eine Länge. Slicing gibt einfach einen neuen Struct mit angepasstem Offset und angepasster Länge zurück. Deshalb sind alle sechs oben beschriebenen Konvertierungspfade auch in engen Schleifen sicher: die Kosten sind ein Struct-Copy, kein Buffer-Copy.

## Von `ReadOnlyMemory<T>` zurück zu einem `Span<T>`

Innerhalb einer synchronen Methode wollen Sie meistens einen Span, kein Memory:

```csharp
// .NET 11
public int CountZeroBytes(ReadOnlyMemory<byte> data)
{
    ReadOnlySpan<byte> span = data.Span; // allocation-free
    int count = 0;
    foreach (byte b in span)
    {
        if (b == 0) count++;
    }
    return count;
}
```

`.Span` ist eine Eigenschaft auf `ReadOnlyMemory<T>`, die ein `ReadOnlySpan<T>` über denselben Speicher zurückgibt. Verwenden Sie den Span für die innere Schleife, behalten Sie das Memory in Feldern und über `await`-Grenzen hinweg. Die Umkehrung (Span zu Memory) ist absichtlich nicht vorgesehen, weil Spans auf dem Stack leben können, wo ein `Memory<T>` nicht hingelangt.

## Was nicht geht (und die Workarounds)

`ReadOnlyMemory<T>` ist hinsichtlich der öffentlichen API tatsächlich nur lesbar. Es gibt kein öffentliches `ToMemory()`, das das zugrunde liegende veränderbare `Memory<T>` zurückgibt. Die Notluke befindet sich in `MemoryMarshal`:

```csharp
// .NET 11
using System.Runtime.InteropServices;

ReadOnlyMemory<byte> ro = payload.AsMemory();
Memory<byte> rw = MemoryMarshal.AsMemory(ro);
```

Das ist unsicher im Sinne von "das Typsystem hat Ihnen etwas mitgeteilt". Greifen Sie nur dann darauf zurück, wenn Sie sicher sind, dass kein anderer Konsument auf den Read-Only-Vertrag angewiesen ist, den Sie gerade gebrochen haben, etwa in einem Unit-Test oder in Code, der den Puffer Ende-zu-Ende besitzt.

`ReadOnlyMemory<T>` kann auch nicht über die Array-Konvertierungspfade in einen `string` zeigen. `string.AsMemory()` gibt ein `ReadOnlyMemory<char>` zurück, das den String selbst umhüllt, kein `T[]`. Die oben behandelten Konvertierungspfade von `T[]` gelten nicht für Strings, aber der Rest der API-Oberfläche (Slicing, `Span`, Gleichheit) verhält sich identisch.

## Eine Wahl in Ihrer Codebasis treffen

Ein vernünftiger Default in einer .NET-11-Codebasis:

- **In API-Signaturen**: nehmen Sie `ReadOnlyMemory<T>` entgegen. Aufrufer mit einem `T[]` übergeben es unverändert (impliziter Operator), Aufrufer mit einem Slice übergeben `array.AsMemory(start, length)`. Sie geben nichts auf.
- **An Aufrufstellen mit einem vollständigen Array**: verwenden Sie die implizite Konvertierung, schreiben Sie kein `.AsMemory()`. Es ist Rauschen.
- **An Aufrufstellen mit einem Slice**: verwenden Sie `array.AsMemory(start, length)` oder `array.AsMemory(range)`. Vermeiden Sie `new ReadOnlyMemory<T>(array, start, length)`, es sei denn, die Explizitheit an der Aufrufstelle ist der eigentliche Punkt.
- **In heißen Pfaden**: spielt es für die Leistung keine Rolle. Der JIT senkt alle sechs Pfade auf dieselbe Struct-Konstruktion ab. Wählen Sie, was sich am besten liest.

## Verwandt

- [`SearchValues<T>` korrekt in .NET 11 verwenden](/de/2026/04/how-to-use-searchvalues-correctly-in-dotnet-11/) für span-freundliches Suchen, das natürlich mit `ReadOnlyMemory<T>.Span` zusammenpasst.
- [Channels statt `BlockingCollection` in C# verwenden](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/), wenn Sie asynchrone Pipelines wollen, die `ReadOnlyMemory<T>`-Payloads weiterreichen.
- [`IAsyncEnumerable<T>` mit EF Core 11 verwenden](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) für Streaming-Muster, die sich gut mit Memory-Sichten kombinieren lassen.
- [Eine große CSV in .NET 11 ohne Speichermangel lesen](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/), das stark auf Slicing ohne Kopieren setzt.
- [Den neuen `System.Threading.Lock`-Typ in .NET 11 verwenden](/de/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) für die Synchronisationsprimitive, die Sie um veränderbares `Memory<T>` zwischen Threads herum wollen werden.

## Quellen

- [`ReadOnlyMemory<T>` Referenz (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.readonlymemory-1)
- [`MemoryExtensions.AsMemory` Referenz (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.memoryextensions.asmemory)
- [Memory<T> und Span<T> Nutzungsrichtlinien (MS Learn)](https://learn.microsoft.com/en-us/dotnet/standard/memory-and-span/)
- [`MemoryMarshal.AsMemory` Referenz (MS Learn)](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.memorymarshal.asmemory)
