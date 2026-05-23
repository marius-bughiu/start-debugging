---
title: ".NET 11 добавляет сжатие Deflate и GZip без аллокаций"
description: ".NET 11 Preview 4 приносит DeflateEncoder, GZipEncoder и ZLibEncoder вместе с соответствующими декодерами, позволяя сжимать прямо в Span<byte> через OperationStatus, без всякого Stream."
pubDate: 2026-05-23
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
lang: "ru"
translationOf: "2026/05/dotnet-11-span-based-deflate-gzip-compression"
translatedBy: "claude"
translationDate: 2026-05-23
---

[Заметки о библиотеках в .NET 11 Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md) без лишнего шума закрывают пробел, который раздражал всех, кто сжимает небольшие данные на критическом пути. В `System.IO.Compression` теперь есть `DeflateEncoder`, `GZipEncoder` и `ZLibEncoder`, а также `DeflateDecoder`, `GZipDecoder` и `ZLibDecoder`. Они сжимают и распаковывают напрямую между спанами, без какого-либо `Stream`. Это отдельно от [поддержки Zstandard, добавленной в Preview 1](/ru/2026/04/dotnet-11-zstandard-compression-system-io/): классические алгоритмы наконец получают форму на основе буфера, которая есть у `BrotliEncoder` со времён .NET Core 2.1.

## Почему GZipStream аллоцирует больше, чем кажется

Сжать gzip-ом `byte[]`, который уже находится в памяти, раньше означало пропустить его через поток:

```csharp
using var output = new MemoryStream();
using (var gzip = new GZipStream(output, CompressionLevel.Optimal))
{
    gzip.Write(payload);
}
byte[] compressed = output.ToArray();
```

Это аллоцирует `MemoryStream`, внутренний буфер копирования и новый `byte[]` из `ToArray()`, ни один из которых нельзя взять из пула. На пути обработки запроса, где сжимаются тысячи мелких блобов, это давление проявляется в трассировках GC.

## За один проход в буфер из пула

Новые кодировщики предоставляют операцию за один проход, которая пишет в принадлежащее вам место назначения:

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

Ни потока, ни промежуточной копии, а рабочий буфер возвращается в пул. `GetMaxCompressedLength` подбирает размер аренды так, что `TryCompress` никогда не завершится неудачей из-за нехватки места.

## Потоковые буферы без Stream

Для данных, поступающих частями, API экземпляра управляет циклом с `OperationStatus`. Вы подаёте входные спаны, опустошаете выходные спаны и помечаете последний вызов:

```csharp
using var encoder = new GZipEncoder(CompressionLevel.SmallestSize);

OperationStatus status = encoder.Compress(
    chunk,
    destination,
    out int bytesConsumed,
    out int bytesWritten,
    isFinalBlock: lastChunk);
```

Возвращаемое значение подсказывает, что делать дальше: `Done`, `DestinationTooSmall` (увеличьте выход и вызовите снова) или `NeedMoreData` (передайте следующий входной спан). Распаковка зеркальна и выполняется через `GZipDecoder.Decompress`, который также сообщает `bytesConsumed` и `bytesWritten`, чтобы можно было продолжать через частичные фреймы. Это тот же контракт, что используют `BrotliEncoder` и `ZstandardEncoder` из Preview 1, поэтому код с несколькими алгоритмами может использовать один цикл.

## Когда к этому прибегать

Потоки по-прежнему подходящий инструмент, когда вы направляете файл на диск или в тело ответа, где буферизацией управляет фреймворк. Новые кодировщики выигрывают, когда данные уже в памяти и вам важны аллокации: кеширование сжатых фрагментов, упаковка записей в бинарный формат или сжатие множества крошечных сообщений. Нацельтесь на `net11.0` с [SDK из Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) и замените `GZipStream` поверх `MemoryStream` на `GZipEncoder.TryCompress`. Разницу в аллокациях трудно не заметить.
