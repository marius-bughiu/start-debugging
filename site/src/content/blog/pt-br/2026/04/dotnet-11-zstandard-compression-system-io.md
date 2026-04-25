---
title: ".NET 11 adiciona compressão Zstandard nativa ao System.IO.Compression"
description: ".NET 11 Preview 1 entrega ZstandardStream, ZstandardEncoder e ZstandardDecoder no System.IO.Compression, oferecendo suporte zstd rápido e integrado sem pacotes de terceiros."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
lang: "pt-br"
translationOf: "2026/04/dotnet-11-zstandard-compression-system-io"
translatedBy: "claude"
translationDate: 2026-04-25
---

Desenvolvedores .NET que precisaram de compressão Zstandard contaram com wrappers de terceiros como ZstdSharp ou ZstdNet por anos. A partir do [.NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/), isso muda: `System.IO.Compression` agora entrega `ZstandardStream`, `ZstandardEncoder` e `ZstandardDecoder` como APIs de primeira classe, sem desvios por NuGet.

## Por que Zstandard importa

Zstandard (zstd), desenvolvido pela Meta, fica em um ponto doce entre velocidade e taxa. Benchmarks internos da equipe .NET mostram que ele comprime 2-7x mais rápido que Brotli e Deflate em qualidade equivalente, e descomprime 2-14x mais rápido no nível mais rápido. Para payloads HTTP, envio de log, ou serialização binária, essa lacuna é significativa.

## Compressão em streaming em cinco linhas

A API espelha `BrotliStream` e `GZipStream`, então o caminho de migração é familiar:

```csharp
using System.IO.Compression;

await using var input = File.OpenRead("dump.json");
await using var output = File.Create("dump.json.zst");
await using var zstd = new ZstandardStream(output, CompressionMode.Compress);

await input.CopyToAsync(zstd);
```

A descompressão é a imagem espelhada: envolva o stream de entrada e leia.

```csharp
await using var compressed = File.OpenRead("dump.json.zst");
await using var zstd = new ZstandardStream(compressed, CompressionMode.Decompress);
await using var output = File.Create("dump.json");

await zstd.CopyToAsync(output);
```

## Controle fino com ZstandardEncoder

Quando você precisar definir níveis de compressão ou usar dicionários treinados, desça para `ZstandardEncoder`:

```csharp
using var encoder = new ZstandardEncoder(compressionLevel: 6);

Span<byte> source = GetPayload();
Span<byte> destination = new byte[ZstandardEncoder.GetMaxCompressedLength(source.Length)];

encoder.TryCompress(source, destination, out int bytesWritten);
```

Os níveis de compressão vão de 1 (mais rápido) a 22 (saída menor). O nível 3, o padrão, já supera as taxas do Deflate para a maioria das cargas de trabalho. `ZstandardDictionary` permite treinar com amostras representativas para taxas ainda melhores em payloads pequenos e repetitivos como respostas de API ou linhas de log.

## HttpClient ganha descompressão Zstd automática

`DecompressionMethods` agora inclui um membro `Zstandard`, então optar pela descompressão HTTP transparente é uma única flag:

```csharp
var handler = new HttpClientHandler
{
    AutomaticDecompression = DecompressionMethods.Zstandard
};
var client = new HttpClient(handler);
```

Se o servidor enviar uma resposta `Content-Encoding: zstd`, o handler a descomprime antes que seu código veja o stream.

## O que experimentar agora

Instale o [.NET 11 Preview SDK](https://dotnet.microsoft.com/download/dotnet/11.0), mire `net11.0`, e troque um dos seus sites de chamada existentes de `BrotliStream` ou `GZipStream` para `ZstandardStream`. Meça o throughput e o tamanho comprimido: os números tendem a falar por si.

A superfície completa da API, incluindo `ZstandardCompressionOptions` para ajuste de tamanho de janela, está documentada na [Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardencoder?view=net-11.0).
