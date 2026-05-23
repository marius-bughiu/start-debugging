---
title: ".NET 11 adiciona compressão Deflate e GZip sem alocações"
description: "O .NET 11 Preview 4 traz DeflateEncoder, GZipEncoder e ZLibEncoder mais os decodificadores correspondentes, para comprimir direto em um Span<byte> com OperationStatus, sem precisar de um Stream."
pubDate: 2026-05-23
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
lang: "pt-br"
translationOf: "2026/05/dotnet-11-span-based-deflate-gzip-compression"
translatedBy: "claude"
translationDate: 2026-05-23
---

As [notas da biblioteca do .NET 11 Preview 4](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md) fecham discretamente uma lacuna que incomoda qualquer um que comprime cargas pequenas em um caminho crítico. O `System.IO.Compression` agora traz `DeflateEncoder`, `GZipEncoder` e `ZLibEncoder`, junto com `DeflateDecoder`, `GZipDecoder` e `ZLibDecoder`. Eles comprimem e descomprimem diretamente entre spans, sem nenhum `Stream` à vista. Isso é separado do [suporte a Zstandard adicionado no Preview 1](/pt-br/2026/04/dotnet-11-zstandard-compression-system-io/): são os algoritmos clássicos finalmente ganhando o formato baseado em buffer que o `BrotliEncoder` tem desde o .NET Core 2.1.

## Por que o GZipStream aloca mais do que você imagina

Comprimir com gzip um `byte[]` que já está na memória costumava significar roteá-lo através de um stream:

```csharp
using var output = new MemoryStream();
using (var gzip = new GZipStream(output, CompressionLevel.Optimal))
{
    gzip.Write(payload);
}
byte[] compressed = output.ToArray();
```

Isso aloca um `MemoryStream`, um buffer de cópia interno e um novo `byte[]` a partir de `ToArray()`, nenhum dos quais você pode reaproveitar em pool. Em um caminho de requisição que comprime milhares de blobs pequenos, essa pressão aparece nos rastreamentos do GC.

## Em uma única passada para um buffer do pool

Os novos codificadores expõem uma operação de passada única que escreve em um destino que você possui:

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

Sem stream, sem cópia intermediária, e o buffer temporário volta para o pool. O `GetMaxCompressedLength` dimensiona o aluguel para que o `TryCompress` nunca falhe por falta de espaço.

## Buffers em streaming sem um Stream

Para dados que chegam em fragmentos, a API de instância conduz um laço com `OperationStatus`. Você alimenta spans de entrada, drena spans de saída e sinaliza a última chamada:

```csharp
using var encoder = new GZipEncoder(CompressionLevel.SmallestSize);

OperationStatus status = encoder.Compress(
    chunk,
    destination,
    out int bytesConsumed,
    out int bytesWritten,
    isFinalBlock: lastChunk);
```

O valor de retorno indica o que fazer em seguida: `Done`, `DestinationTooSmall` (aumente a saída e chame de novo) ou `NeedMoreData` (passe o próximo span de entrada). A descompressão espelha isso com `GZipDecoder.Decompress`, que também reporta `bytesConsumed` e `bytesWritten` para você retomar entre frames parciais. É o mesmo contrato que `BrotliEncoder` e o `ZstandardEncoder` do Preview 1 usam, então código multialgoritmo pode compartilhar um único laço.

## Quando recorrer a isso

Streams continuam sendo a ferramenta certa quando você canaliza um arquivo para o disco ou um corpo de resposta onde o framework controla o buffering. Os novos codificadores ganham quando os dados já estão na memória e você se importa com alocações: cachear fragmentos comprimidos, empacotar registros em um formato binário ou comprimir muitas mensagens minúsculas. Mire em `net11.0` com o [SDK do Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) e troque um `GZipStream` sobre um `MemoryStream` por `GZipEncoder.TryCompress`. A diferença de alocações é difícil de não notar.
