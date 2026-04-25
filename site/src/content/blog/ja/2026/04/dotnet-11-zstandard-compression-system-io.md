---
title: ".NET 11 が System.IO.Compression にネイティブな Zstandard 圧縮を追加"
description: ".NET 11 Preview 1 は ZstandardStream、ZstandardEncoder、ZstandardDecoder を System.IO.Compression に出荷し、サードパーティパッケージなしで高速なビルトイン zstd サポートを提供します。"
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "csharp"
  - "performance"
  - "compression"
lang: "ja"
translationOf: "2026/04/dotnet-11-zstandard-compression-system-io"
translatedBy: "claude"
translationDate: 2026-04-25
---

Zstandard 圧縮を必要とした .NET 開発者は、長年 ZstdSharp や ZstdNet のようなサードパーティラッパーに頼ってきました。[.NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/) からそれが変わります。`System.IO.Compression` は今や NuGet 経由の迂回なしで、`ZstandardStream`、`ZstandardEncoder`、`ZstandardDecoder` をファーストクラス API として出荷します。

## なぜ Zstandard が重要か

Meta によって開発された Zstandard (zstd) は、速度と圧縮率のスイートスポットに位置しています。.NET チームの内部ベンチマークは、同等品質で Brotli と Deflate より 2-7 倍速く圧縮し、最速レベルでは 2-14 倍速く解凍することを示しています。HTTP ペイロード、ログ送信、またはバイナリシリアライゼーションにとって、このギャップは重要です。

## 5 行でストリーミング圧縮

API は `BrotliStream` と `GZipStream` を反映しているので、移行パスは馴染みがあります。

```csharp
using System.IO.Compression;

await using var input = File.OpenRead("dump.json");
await using var output = File.Create("dump.json.zst");
await using var zstd = new ZstandardStream(output, CompressionMode.Compress);

await input.CopyToAsync(zstd);
```

解凍は鏡像です。入力ストリームをラップして読み込みます。

```csharp
await using var compressed = File.OpenRead("dump.json.zst");
await using var zstd = new ZstandardStream(compressed, CompressionMode.Decompress);
await using var output = File.Create("dump.json");

await zstd.CopyToAsync(output);
```

## ZstandardEncoder による細かい制御

圧縮レベルを設定したり、訓練された辞書を使用する必要がある場合は、`ZstandardEncoder` まで降りてください。

```csharp
using var encoder = new ZstandardEncoder(compressionLevel: 6);

Span<byte> source = GetPayload();
Span<byte> destination = new byte[ZstandardEncoder.GetMaxCompressedLength(source.Length)];

encoder.TryCompress(source, destination, out int bytesWritten);
```

圧縮レベルは 1 (最速) から 22 (最小出力) まで及びます。デフォルトのレベル 3 は、ほとんどのワークロードに対してすでに Deflate の比率を上回ります。`ZstandardDictionary` は、API レスポンスやログ行のような小さく反復的なペイロードに対するさらに良い比率のために、代表的なサンプルで訓練することを可能にします。

## HttpClient が自動 Zstd 解凍を取得

`DecompressionMethods` には `Zstandard` メンバーが含まれるようになったので、透過的な HTTP 解凍を有効にするのは 1 つのフラグです。

```csharp
var handler = new HttpClientHandler
{
    AutomaticDecompression = DecompressionMethods.Zstandard
};
var client = new HttpClient(handler);
```

サーバーが `Content-Encoding: zstd` レスポンスを送信する場合、ハンドラーはコードがストリームを見る前にそれを解凍します。

## 今試すべきこと

[.NET 11 Preview SDK](https://dotnet.microsoft.com/download/dotnet/11.0) をインストールし、`net11.0` をターゲットにし、既存の `BrotliStream` または `GZipStream` の呼び出しサイトの 1 つを `ZstandardStream` に交換します。スループットと圧縮サイズを測定してください。数字が物語る傾向があります。

ウィンドウサイズチューニング用の `ZstandardCompressionOptions` を含む API サーフェス全体は、[Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zstandardencoder?view=net-11.0) に文書化されています。
