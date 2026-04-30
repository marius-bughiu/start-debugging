---
title: ".NET 9 と .NET 10 でコンテナ上の gRPC が「難しい」と感じる: 修正できる 4 つの落とし穴"
description: ".NET 9 と .NET 10 でコンテナに gRPC をホストするときによくある 4 つの落とし穴: HTTP/2 のプロトコル不一致、TLS 終端の混乱、壊れたヘルスチェック、プロキシの設定ミス -- それぞれの修正方法付き。"
pubDate: 2026-01-10
tags:
  - "grpc"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-9"
lang: "ja"
translationOf: "2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix"
translatedBy: "claude"
translationDate: 2026-04-30
---
今日また r/dotnet で話題になりました: 「なぜコンテナで gRPC サービスをホストするのはこんなに難しいのか?」。短い答えとしては、gRPC は HTTP/2 について強い意見を持っており、コンテナはネットワーク境界をより明示的にします。TLS をどこで終端するか、どのポートが HTTP/2 を話すか、前段にどのプロキシを置くかを決める必要に迫られます。

元の議論: [https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/](https://www.reddit.com/r/dotnet/comments/1q93h2h/why_is_hosting_grpc_services_in_containers_so_hard/)

## 落とし穴 1: コンテナのポートには到達できるが、HTTP/2 を話していない

gRPC はエンドツーエンドで HTTP/2 を要求します。プロキシが HTTP/1.1 にダウングレードすると、アプリのバグのように見える謎の "unavailable" エラーが発生します。

.NET 9 / .NET 10 では、サーバーの意図を明示的に宣言してください:

```cs
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // Inside a container you usually run plaintext HTTP/2 and terminate TLS at the proxy.
    options.ListenAnyIP(8080, listen =>
    {
        listen.Protocols = HttpProtocols.Http2;
    });
});

builder.Services.AddGrpc();

var app = builder.Build();
app.MapGrpcService<GreeterService>();
app.MapGet("/", () => "gRPC service. Use a gRPC client.");
app.Run();
```

## 落とし穴 2: TLS 終端が不明確 (そして gRPC クライアントはそれを気にする)

多くのチームは「コンテナ = TLS」と考えがちです。実際には、境界で TLS を終端するほうがシンプルです:

-   **Kestrel**: クラスタ内では `8080` で TLS なしの HTTP/2 を実行します。
-   **Ingress / リバースプロキシ**: TLS を終端し、HTTP/2 でサービスへ転送します。

Kestrel で TLS を終端する場合は、コンテナ内に証明書も必要で、適切なポートを公開する必要があります。実現可能ですが、可動部品が増えるだけです。

## 落とし穴 3: ヘルスチェックが間違ったものを調べている

Kubernetes の HTTP プローブや基本的なロードバランサーのプローブは、しばしば HTTP/1.1 です。gRPC のエンドポイントを直接プローブすると、サービスが正常でも失敗する可能性があります。

実用的な修正は 2 つあります:

-   **プレーンな HTTP エンドポイントを公開する**: プローブ用 (上記の `MapGet("/")` のような) を別ポート、またはプロキシが対応しているなら同じポートで提供します。
-   **gRPC のヘルスチェックを使う** (`grpc.health.v1.Health`): 環境が gRPC を理解するプローブをサポートしている場合に使います。

## 落とし穴 4: プロキシと HTTP/2 のデフォルト設定に噛まれる

gRPC を「難しく」感じさせる最も簡単な方法は、上流に対して HTTP/2 で設定されていないプロキシを前段に置くことです。プロキシが次のように明示的に設定されていることを確認してください:

-   クライアントから HTTP/2 を受け付ける
-   上流サービスに HTTP/2 を転送する (HTTP/1.1 だけでなく)

最後の項目が、Nginx のデフォルト設定の多くが gRPC でつまずく場所です。

## 退屈なままでいられるコンテナ構成

-   **コンテナ**: `HttpProtocols.Http2` で `8080` をリッスンします。
-   **プロキシ/ingress**: `443` で TLS を終端し、クライアントとも上流とも HTTP/2 を話します。
-   **可観測性**: リクエスト失敗の構造化ログを有効にし、gRPC のステータスコードを含めます。

Kubernetes に触れる前に単一の参照点が欲しい場合は、まずローカルで検証することから始めてください: コンテナを起動し、`grpcurl` で叩き、その後プロキシを前段に置いて、引き続き HTTP/2 がエンドツーエンドでネゴシエートされることを確認します。

参考リンク: [https://learn.microsoft.com/aspnet/core/grpc/](https://learn.microsoft.com/aspnet/core/grpc/)
