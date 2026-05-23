---
title: ".NET 11 ergänzt allokationsfreie Deflate- und GZip-Komprimierung"
description: ".NET 11 Preview 4 liefert DeflateEncoder, GZipEncoder und ZLibEncoder sowie die passenden Decoder, um direkt in ein Span<byte> mit OperationStatus zu komprimieren, ganz ohne Stream."
pubDate: 2026-05-23
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
lang: "de"
translationOf: "2026/05/dotnet-11-span-based-deflate-gzip-compression"
translatedBy: "claude"
translationDate: 2026-05-23
---

Die [Bibliotheksnotizen zu .NET 11 Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md) schließen unauffällig eine Lücke, die alle stört, die kleine Nutzdaten in einem kritischen Pfad komprimieren. `System.IO.Compression` liefert nun `DeflateEncoder`, `GZipEncoder` und `ZLibEncoder`, zusammen mit `DeflateDecoder`, `GZipDecoder` und `ZLibDecoder`. Sie komprimieren und dekomprimieren direkt zwischen Spans, ohne dass ein `Stream` im Spiel ist. Das ist getrennt von der [in Preview 1 ergänzten Zstandard-Unterstützung](/de/2026/04/dotnet-11-zstandard-compression-system-io/): Hier erhalten die klassischen Algorithmen endlich die pufferbasierte Form, die `BrotliEncoder` seit .NET Core 2.1 besitzt.

## Warum GZipStream mehr allokiert, als Sie denken

Einen `byte[]`, der bereits im Speicher liegt, mit gzip zu komprimieren, bedeutete bisher, ihn durch einen Stream zu leiten:

```csharp
using var output = new MemoryStream();
using (var gzip = new GZipStream(output, CompressionLevel.Optimal))
{
    gzip.Write(payload);
}
byte[] compressed = output.ToArray();
```

Das allokiert einen `MemoryStream`, einen internen Kopierpuffer und einen frischen `byte[]` aus `ToArray()`, von denen sich keiner poolen lässt. In einem Anfragepfad, der Tausende kleiner Blobs komprimiert, taucht dieser Druck in den GC-Traces auf.

## In einem Durchgang in einen gepoolten Puffer

Die neuen Encoder bieten einen Durchgang in einem Schritt, der in ein Ziel schreibt, das Ihnen gehört:

```csharp
using System.Buffers;
using System.IO.Compression;

ReadOnlySpan<byte> source = payload;
byte[] buffer = ArrayPool<byte>.Shared.Rent(
    GZipEncoder.GetMaxCompressedLength(source.Length));

if (GZipEncoder.TryCompress(source, buffer, out int written))
{
    Use(buffer.AsSpan(0, written));
}

ArrayPool<byte>.Shared.Return(buffer);
```

Kein Stream, keine Zwischenkopie, und der Arbeitspuffer geht zurück in den Pool. `GetMaxCompressedLength` dimensioniert die Ausleihe so, dass `TryCompress` nie an fehlendem Platz scheitert.

## Streaming-Puffer ohne Stream

Für Daten, die in Teilen eintreffen, treibt die Instanz-API eine `OperationStatus`-Schleife an. Sie speisen Eingabe-Spans ein, leeren Ausgabe-Spans und kennzeichnen den letzten Aufruf:

```csharp
using var encoder = new GZipEncoder(CompressionLevel.SmallestSize);

OperationStatus status = encoder.Compress(
    chunk,
    destination,
    out int bytesConsumed,
    out int bytesWritten,
    isFinalBlock: lastChunk);
```

Der Rückgabewert sagt Ihnen, was als Nächstes zu tun ist: `Done`, `DestinationTooSmall` (Ausgabe vergrößern und erneut aufrufen) oder `NeedMoreData` (den nächsten Eingabe-Span übergeben). Die Dekomprimierung spiegelt das mit `GZipDecoder.Decompress`, das ebenfalls `bytesConsumed` und `bytesWritten` meldet, sodass Sie über Teil-Frames hinweg fortsetzen können. Es ist derselbe Vertrag, den `BrotliEncoder` und der `ZstandardEncoder` aus Preview 1 verwenden, sodass algorithmenübergreifender Code eine einzige Schleife teilen kann.

## Wann Sie dazu greifen sollten

Streams sind weiterhin das richtige Werkzeug, wenn Sie eine Datei auf die Festplatte leiten oder einen Antwortkörper, bei dem das Framework das Puffern besitzt. Die neuen Encoder gewinnen, wenn die Daten bereits im Speicher liegen und Ihnen Allokationen wichtig sind: komprimierte Fragmente cachen, Datensätze in ein Binärformat packen oder viele winzige Nachrichten komprimieren. Zielen Sie mit dem [Preview-4-SDK](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) auf `net11.0` und ersetzen Sie einen `GZipStream` über einem `MemoryStream` durch `GZipEncoder.TryCompress`. Der Unterschied bei den Allokationen ist kaum zu übersehen.
