---
title: ".NET 11 がアロケーションなしの Deflate と GZip 圧縮を追加"
description: ".NET 11 Preview 4 は DeflateEncoder、GZipEncoder、ZLibEncoder とそれぞれのデコーダーを提供し、Stream なしで OperationStatus を使って Span<byte> に直接圧縮できます。"
pubDate: 2026-05-23
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
lang: "ja"
translationOf: "2026/05/dotnet-11-span-based-deflate-gzip-compression"
translatedBy: "claude"
translationDate: 2026-05-23
---

[.NET 11 Preview 4 のライブラリ ノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/libraries.md)は、ホットパスで小さなペイロードを圧縮する人を悩ませてきたギャップを静かに解消します。`System.IO.Compression` に `DeflateEncoder`、`GZipEncoder`、`ZLibEncoder` が加わり、あわせて `DeflateDecoder`、`GZipDecoder`、`ZLibDecoder` も提供されます。これらは `Stream` をまったく使わずに、スパン間で直接圧縮・展開します。これは [Preview 1 で追加された Zstandard サポート](/ja/2026/04/dotnet-11-zstandard-compression-system-io/)とは別物です。古くからのアルゴリズムが、`BrotliEncoder` が .NET Core 2.1 から持っていたバッファーベースの形をようやく手に入れた、ということです。

## GZipStream が思ったよりアロケーションする理由

すでにメモリ上にある `byte[]` を gzip 圧縮するには、これまでストリームを経由させる必要がありました。

```csharp
using var output = new MemoryStream();
using (var gzip = new GZipStream(output, CompressionLevel.Optimal))
{
    gzip.Write(payload);
}
byte[] compressed = output.ToArray();
```

これは `MemoryStream`、内部のコピー用バッファー、`ToArray()` による新しい `byte[]` をアロケーションしますが、いずれもプールできません。何千もの小さな blob を圧縮するリクエスト パスでは、その負荷が GC のトレースに現れます。

## プールしたバッファーへ一括で

新しいエンコーダーは、自分が所有する出力先に書き込む一括処理を公開します。

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

ストリームも中間コピーもなく、作業用バッファーはプールに戻ります。`GetMaxCompressedLength` がレンタルのサイズを決めるので、`TryCompress` が領域不足で失敗することはありません。

## Stream なしのストリーミング バッファー

データがチャンクで届く場合は、インスタンス API が `OperationStatus` のループを駆動します。入力スパンを与え、出力スパンを排出し、最後の呼び出しに印を付けます。

```csharp
using var encoder = new GZipEncoder(CompressionLevel.SmallestSize);

OperationStatus status = encoder.Compress(
    chunk,
    destination,
    out int bytesConsumed,
    out int bytesWritten,
    isFinalBlock: lastChunk);
```

戻り値が次にすべきことを教えてくれます。`Done`、`DestinationTooSmall`(出力を広げて再度呼び出す)、または `NeedMoreData`(次の入力スパンを渡す)です。展開も `GZipDecoder.Decompress` で対称的に行え、こちらも `bytesConsumed` と `bytesWritten` を報告するので、部分的なフレームをまたいで再開できます。これは `BrotliEncoder` と Preview 1 の `ZstandardEncoder` が使うものと同じ契約なので、複数アルゴリズムを扱うコードは 1 つのループを共有できます。

## どんなときに使うか

ファイルをディスクへ流すときや、バッファリングをフレームワークが所有するレスポンス本文では、依然としてストリームが適切なツールです。新しいエンコーダーが有利なのは、データがすでにメモリ上にあり、アロケーションを気にする場合です。圧縮済みフラグメントのキャッシュ、レコードのバイナリ形式へのパック、多数の小さなメッセージの圧縮などです。[Preview 4 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) で `net11.0` をターゲットにし、`MemoryStream` 上の `GZipStream` を `GZipEncoder.TryCompress` に置き換えてみてください。アロケーションの差は見逃しようがありません。
