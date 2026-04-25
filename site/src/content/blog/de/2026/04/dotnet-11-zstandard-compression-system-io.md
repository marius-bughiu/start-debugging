---
title: ".NET 11 fügt System.IO.Compression native Zstandard-Kompression hinzu"
description: ".NET 11 Preview 1 liefert ZstandardStream, ZstandardEncoder und ZstandardDecoder in System.IO.Compression aus und bietet schnelle, eingebaute zstd-Unterstützung ohne Drittanbieterpakete."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
lang: "de"
translationOf: "2026/04/dotnet-11-zstandard-compression-system-io"
translatedBy: "claude"
translationDate: 2026-04-25
---

.NET-Entwickler, die Zstandard-Kompression brauchten, haben sich jahrelang auf Drittanbieter-Wrapper wie ZstdSharp oder ZstdNet verlassen. Mit [.NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/) ändert sich das: `System.IO.Compression` liefert nun `ZstandardStream`, `ZstandardEncoder` und `ZstandardDecoder` als erstklassige APIs aus, ohne NuGet-Umweg.

## Warum Zstandard wichtig ist

Zstandard (zstd), entwickelt von Meta, sitzt am Sweet Spot zwischen Geschwindigkeit und Verhältnis. Interne Benchmarks vom .NET-Team zeigen, dass es bei gleicher Qualität 2-7x schneller komprimiert als Brotli und Deflate, und auf der schnellsten Stufe 2-14x schneller dekomprimiert. Für HTTP-Payloads, Log-Versand oder binäre Serialisierung ist diese Lücke erheblich.

## Streaming-Kompression in fünf Zeilen

Die API spiegelt `BrotliStream` und `GZipStream`, also ist der Migrationspfad vertraut:

```csharp
using System.IO.Compression;

await using var input = File.OpenRead("dump.json");
await using var output = File.Create("dump.json.zst");
await using var zstd = new ZstandardStream(output, CompressionMode.Compress);

await input.CopyToAsync(zstd);
```

Die Dekompression ist das Spiegelbild: den Eingabestream einpacken und lesen.

```csharp
await using var compressed = File.OpenRead("dump.json.zst");
await using var zstd = new ZstandardStream(compressed, CompressionMode.Decompress);
await using var output = File.Create("dump.json");

await zstd.CopyToAsync(output);
```

## Feinkörnige Kontrolle mit ZstandardEncoder

Wenn Sie Kompressionsstufen einstellen oder trainierte Wörterbücher verwenden müssen, steigen Sie auf `ZstandardEncoder` ab:

```csharp
using var encoder = new ZstandardEncoder(compressionLevel: 6);

Span<byte> source = GetPayload();
Span<byte> destination = new byte[ZstandardEncoder.GetMaxCompressedLength(source.Length)];

encoder.TryCompress(source, destination, out int bytesWritten);
```

Die Kompressionsstufen reichen von 1 (am schnellsten) bis 22 (kleinste Ausgabe). Stufe 3, der Standard, schlägt für die meisten Workloads bereits Deflate-Verhältnisse. `ZstandardDictionary` erlaubt es Ihnen, auf repräsentativen Samples zu trainieren, für noch bessere Verhältnisse bei kleinen, sich wiederholenden Payloads wie API-Antworten oder Log-Zeilen.

## HttpClient erhält automatische Zstd-Dekompression

`DecompressionMethods` enthält nun ein `Zstandard`-Mitglied, sodass das Aktivieren transparenter HTTP-Dekompression nur ein Flag ist:

```csharp
var handler = new HttpClientHandler
{
    AutomaticDecompression = DecompressionMethods.Zstandard
};
var client = new HttpClient(handler);
```

Wenn der Server eine `Content-Encoding: zstd`-Antwort sendet, dekomprimiert sie der Handler, bevor Ihr Code den Stream jemals sieht.

## Was jetzt zu probieren ist

Installieren Sie das [.NET 11 Preview SDK](https://dotnet.microsoft.com/download/dotnet/11.0), zielen Sie auf `net11.0` ab, und tauschen Sie eine Ihrer bestehenden `BrotliStream`- oder `GZipStream`-Aufrufstellen gegen `ZstandardStream` aus. Messen Sie Durchsatz und komprimierte Größe: die Zahlen sprechen meist für sich.

Die vollständige API-Oberfläche, einschließlich `ZstandardCompressionOptions` für die Anpassung der Fenstergröße, ist auf [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardencoder?view=net-11.0) dokumentiert.
