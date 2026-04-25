---
title: ".NET 11 добавляет нативное Zstandard-сжатие в System.IO.Compression"
description: ".NET 11 Preview 1 поставляет ZstandardStream, ZstandardEncoder и ZstandardDecoder в System.IO.Compression, давая быструю встроенную поддержку zstd без сторонних пакетов."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
lang: "ru"
translationOf: "2026/04/dotnet-11-zstandard-compression-system-io"
translatedBy: "claude"
translationDate: 2026-04-25
---

Разработчики .NET, которым требовалось Zstandard-сжатие, годами полагались на сторонние обёртки вроде ZstdSharp или ZstdNet. Начиная с [.NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/), это меняется: `System.IO.Compression` теперь поставляет `ZstandardStream`, `ZstandardEncoder` и `ZstandardDecoder` как API первого класса, без обходов через NuGet.

## Почему Zstandard важен

Zstandard (zstd), разработанный Meta, занимает золотую середину между скоростью и коэффициентом. Внутренние бенчмарки команды .NET показывают, что он сжимает в 2-7 раз быстрее, чем Brotli и Deflate, при эквивалентном качестве, и распаковывает в 2-14 раз быстрее на самом быстром уровне. Для HTTP-полезных нагрузок, отправки журналов или бинарной сериализации этот разрыв значителен.

## Потоковое сжатие в пять строк

API повторяет `BrotliStream` и `GZipStream`, так что путь миграции знаком:

```csharp
using System.IO.Compression;

await using var input = File.OpenRead("dump.json");
await using var output = File.Create("dump.json.zst");
await using var zstd = new ZstandardStream(output, CompressionMode.Compress);

await input.CopyToAsync(zstd);
```

Распаковка -- зеркальное отражение: оборачивайте входной поток и читайте.

```csharp
await using var compressed = File.OpenRead("dump.json.zst");
await using var zstd = new ZstandardStream(compressed, CompressionMode.Decompress);
await using var output = File.Create("dump.json");

await zstd.CopyToAsync(output);
```

## Тонкий контроль с ZstandardEncoder

Когда нужно установить уровни сжатия или использовать обученные словари, спускайтесь к `ZstandardEncoder`:

```csharp
using var encoder = new ZstandardEncoder(compressionLevel: 6);

Span<byte> source = GetPayload();
Span<byte> destination = new byte[ZstandardEncoder.GetMaxCompressedLength(source.Length)];

encoder.TryCompress(source, destination, out int bytesWritten);
```

Уровни сжатия варьируются от 1 (самый быстрый) до 22 (наименьший вывод). Уровень 3, по умолчанию, уже превосходит коэффициенты Deflate для большинства нагрузок. `ZstandardDictionary` позволяет обучаться на представительных образцах для ещё лучших коэффициентов на маленьких, повторяющихся нагрузках вроде ответов API или строк журналов.

## HttpClient получает автоматическую Zstd-распаковку

`DecompressionMethods` теперь включает член `Zstandard`, так что включение прозрачной HTTP-распаковки -- один флаг:

```csharp
var handler = new HttpClientHandler
{
    AutomaticDecompression = DecompressionMethods.Zstandard
};
var client = new HttpClient(handler);
```

Если сервер отправляет ответ `Content-Encoding: zstd`, обработчик распаковывает его до того, как ваш код увидит поток.

## Что попробовать сейчас

Установите [.NET 11 Preview SDK](https://dotnet.microsoft.com/download/dotnet/11.0), нацельтесь на `net11.0`, и замените одно из существующих мест вызова `BrotliStream` или `GZipStream` на `ZstandardStream`. Замерьте пропускную способность и сжатый размер: цифры обычно говорят сами за себя.

Полная поверхность API, включая `ZstandardCompressionOptions` для настройки размера окна, документирована на [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardencoder?view=net-11.0).
