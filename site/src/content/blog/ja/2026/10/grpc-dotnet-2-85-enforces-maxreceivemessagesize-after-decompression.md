---
title: "grpc-dotnet 2.85 は MaxReceiveMessageSize を解凍前だけでなく解凍後にも適用します"
description: "Grpc.AspNetCore と Grpc.Net.Client 2.85.0 は、gzip と deflate メッセージの解凍後のサイズにも MaxReceiveMessageSize を適用します。260 KB のリクエストが 256 MiB に膨らむ場合は ResourceExhausted で拒否されますが、正当な大きな圧縮ペイロードも失敗し始める可能性があります。"
pubDate: 2026-10-31
tags:
  - "grpc"
  - "aspnetcore"
  - "dotnet"
  - "security"
  - "breaking-changes"
lang: "ja"
translationOf: "2026/10/grpc-dotnet-2-85-enforces-maxreceivemessagesize-after-decompression"
translatedBy: "claude"
translationDate: 2026-10-31
---

[grpc-dotnet 2.85.0](https://github.com/grpc/grpc-dotnet/releases/tag/v2.85.0) は 2026年10月29日 にリリースされ、`Grpc.AspNetCore.Server` と `Grpc.Net.Client` の 2.85.0 はすでに NuGet で公開されています。リリースノートはわずか 4 行で、そのうちの 1 行は読み飛ばしやすい内容です。"Enforce receive message size limits during decompression" です。これは実際のメモリ枯渇の穴をふさぐ一方で、昨日まで動いていたトラフィックを拒否し始める可能性もあります。

## これまで制限が測っていたもの

サーバー側の `GrpcServiceOptions.MaxReceiveMessageSize` とクライアント側の `GrpcChannelOptions.MaxReceiveMessageSize` は、どちらも既定値が 4 MB (4,194,304 バイト) です。2.84.0 までは、このチェックは gRPC フレームの長さプレフィックスに対して行われていました。圧縮されたメッセージの場合、これは**圧縮後**のサイズです。チェックを通過した後、メッセージは単純な `compressionStream.CopyTo(new MemoryStream())` で展開され、上限はまったくありませんでした。

そのため、`grpc-encoding: gzip` を送るピアは、ごく小さなペイロードで 4 MB のチェックを通過し、相手側にデータが展開された分だけメモリを確保させることができました。[PR #2780](https://github.com/grpc/grpc-dotnet/pull/2780) の再現例は、260,934 バイトの圧縮リクエストが 256 MiB に展開されるものです。オプトインは不要でした。`CompressionProviders` が空の場合、`GrpcServiceOptionsSetup` が `GzipCompressionProvider` と `DeflateCompressionProvider` を自動的に登録し、`GrpcChannel` も同じ既定値を備えています。すべての ASP.NET Core の gRPC サービスは呼び出し元に対して、すべてのクライアントは呼び出し先のサーバーに対して、無防備な状態でした。

## 2.85.0 での圧縮メッセージの読み取り方

この修正では、両側の解凍処理が共通の `CommonGrpcProtocolHelpers.TryReadCompressedMessage` に移されました。上限が設定されている場合、解凍ストリームを 8 KB のプール済みチャンク単位で読み取り、上限を 1 バイトでも超える分は要求しません。

```csharp
// Read at most one byte beyond the limit to detect oversized messages without fully decompressing them.
while ((read = compressionStream.Read(buffer, 0, (int)Math.Min(buffer.Length, maxReceiveMessageSize.Value - output.Length + 1))) > 0)
{
    if (output.Length + read > maxReceiveMessageSize.Value)
    {
        message = default;
        return false;
    }

    output.Write(buffer, 0, read);
}
```

呼び出しは `StatusCode.ResourceExhausted` と詳細メッセージ "Received message exceeds the maximum configured message size." で失敗し、サービスメソッドやクライアントのデシリアライザーには何も渡されません。PR の再現例では、256 MiB の圧縮爆弾によるメモリ確保は約 9 MiB で済むようになりました。圧縮フレームのチェックは従来どおり最初に実行され、上限ちょうどのメッセージは引き続き受け入れられ、`null` の上限は従来の無制限の動作のままです。

## アップグレード時の落とし穴: 正当なペイロードも対象になります

この上限は"コードが受け取るメッセージ"のサイズを意味するようになり、これはほとんどの人が元々そう思っていた意味です。しかし、すでに 4 MB を超えて展開される圧縮メッセージ (一括エクスポート、バッチアップロード、繰り返しの多いデータのスナップショットストリームなど) を扱っている場合、2.84.0 では圧縮後のサイズだけがチェックされていたため、これらの呼び出しは動作していました。2.85.0 では `ResourceExhausted` になります。

上限は意図的に、できるだけ狭い範囲で引き上げてください。

```csharp
builder.Services.AddGrpc(options =>
{
    options.ResponseCompressionAlgorithm = "gzip";
    // Global default stays at 4 MB
})
.AddServiceOptions<ExportService>(options =>
{
    // This service legitimately receives large batches
    options.MaxReceiveMessageSize = 32 * 1024 * 1024;
});

// Client side, for responses that inflate past 4 MB
using var channel = GrpcChannel.ForAddress("https://exports.internal", new GrpcChannelOptions
{
    MaxReceiveMessageSize = 32 * 1024 * 1024
});
```

エラーを消すために `MaxReceiveMessageSize = null` を設定するのは避けてください。それではこのリリースが取り除いた無制限の展開をそのまま復活させることになります。

アップグレードの前に、実際に圧縮を使っている呼び出し元を調べてください。トレースで `identity` 以外の `grpc-encoding` リクエストヘッダーを探すか、クライアントとサーバーの設定で `grpc-internal-encoding-request` メタデータと `ResponseCompressionAlgorithm` を探します。圧縮しているものがなければ、2.85.0 はそのまま置き換えられるアップデートです。圧縮しているものがあれば、実際の最大メッセージの解凍後のサイズを測り、それを上回る値をサービスごとの上限に設定してください。gRPC が REST や SignalR と比べてどこに位置づけられるかという全体像については、[gRPC vs REST vs SignalR for service-to-service calls in .NET 11](/ja/2026/08/grpc-vs-rest-vs-signalr-for-service-to-service-calls-in-dotnet-11/) を参照してください。
