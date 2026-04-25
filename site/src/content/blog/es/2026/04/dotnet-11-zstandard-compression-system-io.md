---
title: ".NET 11 agrega compresión Zstandard nativa a System.IO.Compression"
description: ".NET 11 Preview 1 incluye ZstandardStream, ZstandardEncoder y ZstandardDecoder en System.IO.Compression, dándote soporte zstd rápido e integrado sin paquetes de terceros."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
lang: "es"
translationOf: "2026/04/dotnet-11-zstandard-compression-system-io"
translatedBy: "claude"
translationDate: 2026-04-25
---

Los desarrolladores de .NET que necesitaban compresión Zstandard han confiado en wrappers de terceros como ZstdSharp o ZstdNet por años. A partir de [.NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/), eso cambia: `System.IO.Compression` ahora incluye `ZstandardStream`, `ZstandardEncoder` y `ZstandardDecoder` como APIs de primera clase, sin desvíos por NuGet.

## Por qué importa Zstandard

Zstandard (zstd), desarrollado por Meta, se sitúa en un punto óptimo entre velocidad y ratio. Los benchmarks internos del equipo .NET muestran que comprime 2-7x más rápido que Brotli y Deflate con calidad equivalente, y descomprime 2-14x más rápido en el nivel más rápido. Para payloads HTTP, envío de logs, o serialización binaria, esa brecha es significativa.

## Compresión en streaming en cinco líneas

La API refleja a `BrotliStream` y `GZipStream`, así que la ruta de migración es familiar:

```csharp
using System.IO.Compression;

await using var input = File.OpenRead("dump.json");
await using var output = File.Create("dump.json.zst");
await using var zstd = new ZstandardStream(output, CompressionMode.Compress);

await input.CopyToAsync(zstd);
```

La descompresión es la imagen espejo: envuelve el stream de entrada y lee.

```csharp
await using var compressed = File.OpenRead("dump.json.zst");
await using var zstd = new ZstandardStream(compressed, CompressionMode.Decompress);
await using var output = File.Create("dump.json");

await zstd.CopyToAsync(output);
```

## Control fino con ZstandardEncoder

Cuando necesites establecer niveles de compresión o usar diccionarios entrenados, baja a `ZstandardEncoder`:

```csharp
using var encoder = new ZstandardEncoder(compressionLevel: 6);

Span<byte> source = GetPayload();
Span<byte> destination = new byte[ZstandardEncoder.GetMaxCompressedLength(source.Length)];

encoder.TryCompress(source, destination, out int bytesWritten);
```

Los niveles de compresión van de 1 (más rápido) a 22 (salida más pequeña). El nivel 3, el predeterminado, ya supera los ratios de Deflate para la mayoría de las cargas de trabajo. `ZstandardDictionary` te permite entrenar sobre muestras representativas para ratios incluso mejores en payloads pequeños y repetitivos como respuestas de API o líneas de log.

## HttpClient obtiene descompresión Zstd automática

`DecompressionMethods` ahora incluye un miembro `Zstandard`, así que optar por la descompresión HTTP transparente es un solo flag:

```csharp
var handler = new HttpClientHandler
{
    AutomaticDecompression = DecompressionMethods.Zstandard
};
var client = new HttpClient(handler);
```

Si el servidor envía una respuesta `Content-Encoding: zstd`, el handler la descomprime antes de que tu código vea el stream.

## Qué probar ahora

Instala el [SDK Preview de .NET 11](https://dotnet.microsoft.com/download/dotnet/11.0), apunta a `net11.0`, e intercambia uno de tus sitios de llamada existentes de `BrotliStream` o `GZipStream` a `ZstandardStream`. Mide el throughput y el tamaño comprimido: los números tienden a hablar por sí mismos.

La superficie completa de la API, incluyendo `ZstandardCompressionOptions` para ajuste del tamaño de ventana, está documentada en [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardencoder?view=net-11.0).
