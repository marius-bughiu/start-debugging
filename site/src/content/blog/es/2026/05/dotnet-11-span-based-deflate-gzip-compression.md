---
title: ".NET 11 agrega compresión Deflate y GZip sin asignaciones"
description: ".NET 11 Preview 4 incorpora DeflateEncoder, GZipEncoder y ZLibEncoder más sus decodificadores, para comprimir directamente en un Span<byte> con OperationStatus, sin necesidad de un Stream."
pubDate: 2026-05-23
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
lang: "es"
translationOf: "2026/05/dotnet-11-span-based-deflate-gzip-compression"
translatedBy: "claude"
translationDate: 2026-05-23
---

Las [notas de la biblioteca de .NET 11 Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md) cierran sin hacer ruido una brecha que ha molestado a cualquiera que comprima cargas pequeñas en una ruta crítica. `System.IO.Compression` ahora incorpora `DeflateEncoder`, `GZipEncoder` y `ZLibEncoder`, junto con `DeflateDecoder`, `GZipDecoder` y `ZLibDecoder`. Comprimen y descomprimen directamente entre spans, sin ningún `Stream` a la vista. Esto es independiente del [soporte de Zstandard agregado en Preview 1](/es/2026/04/dotnet-11-zstandard-compression-system-io/): son los algoritmos clásicos que por fin reciben la forma basada en búfer que `BrotliEncoder` tiene desde .NET Core 2.1.

## Por qué GZipStream asigna más de lo que crees

Comprimir con gzip un `byte[]` que ya vive en memoria solía implicar enrutarlo a través de un stream:

```csharp
using var output = new MemoryStream();
using (var gzip = new GZipStream(output, CompressionLevel.Optimal))
{
    gzip.Write(payload);
}
byte[] compressed = output.ToArray();
```

Eso asigna un `MemoryStream`, un búfer de copia interno y un nuevo `byte[]` desde `ToArray()`, ninguno de los cuales puedes agrupar. En una ruta de solicitud que comprime miles de blobs pequeños, esa presión aparece en las trazas del GC.

## En una sola pasada hacia un búfer agrupado

Los nuevos codificadores exponen una operación de una sola pasada que escribe en un destino que tú posees:

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

Sin stream, sin copia intermedia, y el búfer temporal vuelve al pool. `GetMaxCompressedLength` dimensiona el préstamo para que `TryCompress` nunca falle por falta de espacio.

## Búferes en streaming sin un Stream

Para datos que llegan en fragmentos, la API de instancia impulsa un bucle con `OperationStatus`. Alimentas spans de entrada, drenas spans de salida y marcas la última llamada:

```csharp
using var encoder = new GZipEncoder(CompressionLevel.SmallestSize);

OperationStatus status = encoder.Compress(
    chunk,
    destination,
    out int bytesConsumed,
    out int bytesWritten,
    isFinalBlock: lastChunk);
```

El valor de retorno te indica qué hacer a continuación: `Done`, `DestinationTooSmall` (aumenta la salida y vuelve a llamar) o `NeedMoreData` (entrégale el siguiente span de entrada). La descompresión lo refleja con `GZipDecoder.Decompress`, que también reporta `bytesConsumed` y `bytesWritten` para que puedas reanudar entre frames parciales. Es el mismo contrato que usan `BrotliEncoder` y el `ZstandardEncoder` de Preview 1, así que el código multialgoritmo puede compartir un solo bucle.

## Cuándo recurrir a esto

Los streams siguen siendo la herramienta adecuada cuando canalizas un archivo al disco o un cuerpo de respuesta donde el framework posee el almacenamiento en búfer. Los nuevos codificadores ganan cuando los datos ya están en memoria y te importan las asignaciones: cachear fragmentos comprimidos, empaquetar registros en un formato binario o comprimir muchos mensajes diminutos. Apunta a `net11.0` con el [SDK de Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) y reemplaza un `GZipStream` sobre un `MemoryStream` por `GZipEncoder.TryCompress`. La diferencia en asignaciones es difícil de pasar por alto.
