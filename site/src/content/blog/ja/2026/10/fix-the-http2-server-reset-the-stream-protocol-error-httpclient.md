---
title: "修正: HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR'"
description: "ピアが 1 つのリクエストに対して PROTOCOL_ERROR 付きの RST_STREAM を送信しました。HttpClient は自動では再試行しません。どのホップがストリームをリセットしたかを特定し、拒否されたリクエストを修正し、冪等な呼び出しだけを再試行し、最後の手段としてそのホップを HTTP/1.1 に切り替えます。"
pubDate: 2026-10-21
template: error-page
tags:
  - "errors"
  - "httpclient"
  - "http2"
  - "dotnet"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/10/fix-the-http2-server-reset-the-stream-protocol-error-httpclient"
translatedBy: "claude"
translationDate: 2026-10-21
---

`HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1)` は、HTTP/2 接続の相手側が、あなたのリクエストに対してエラーコード 1 の `RST_STREAM` フレームを送信したことを意味します。`HttpClient` が何かを壊したわけではなく、ピアが伝えた内容を報告しているだけで、`PROTOCOL_ERROR` を自動で再試行することもありません。対処は次の順です。まずどのホップがリセットを送ったのか (Kestrel アプリ自体か、その前段にあるプロキシ、ロードバランサー、サイドカーか) を特定します。次に、そのホップが拒否した特定のリクエストの問題を修正します。冪等なリクエストはレジリエンスハンドラーで再試行し、最後の手段として、問題のあるホップとは HTTP/1.1 で通信します。

以下はすべて、.NET 10.0.10 (SDK 10.0.302、ASP.NET Core 10.0.10) 上で、Kestrel と `HttpClient` を 1 つのファイルベースアプリにまとめて再現したものです。再試行のセクションでは `Microsoft.Extensions.Http.Resilience` 10.0.0 も使っています。関連するコードパスは .NET 8、9、11 でも同じです。

## エラーの現れ方

レスポンスヘッダーより前にリセットが届いた場合、`SendAsync` (または `GetAsync`、`PostAsync`) は `HttpProtocolException` を内包した `HttpRequestException` をスローします。

```text
System.Net.Http.HttpRequestException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
   at System.Net.Http.Http2Connection.ThrowRequestAborted(Exception innerException)
   at System.Net.Http.Http2Connection.Http2Stream.CheckResponseBodyState()
   at System.Net.Http.Http2Connection.Http2Stream.TryEnsureHeaders()
   at System.Net.Http.Http2Connection.Http2Stream.ReadResponseHeadersAsync(CancellationToken cancellationToken)
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.Http2Connection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
```

サーバーがすでにステータスコードを送信していて、ボディの読み取り中にリセットが発生した場合、外側のメッセージは変わりますが、内部例外は同じです。

```text
System.Net.Http.HttpRequestException: Error while copying content to a stream.
 ---> System.Net.Http.HttpProtocolException: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
```

どちらの場合も `HttpRequestException.HttpRequestError` は `HttpRequestError.HttpProtocolError` で、`HttpProtocolException.ErrorCode` は `1` です。メッセージの文字列ではなく、この 2 つのプロパティをコードで確認してください。

"the HTTP/2 server reset the stream"という文言も重要です。`SocketsHttpHandler` には HTTP/2 の失敗メッセージが 3 種類あり、それぞれ別の問題を指しているためです。

| メッセージ | クライアントが受信したフレーム | 影響範囲 |
| --- | --- | --- |
| `The HTTP/2 server reset the stream. HTTP/2 error code '...'` | `RST_STREAM` | このリクエスト 1 件のみ |
| `The HTTP/2 server closed the connection. HTTP/2 error code '...'` | エラー付きの `GOAWAY` | その接続上のすべてのストリーム |
| `The HTTP/2 server sent invalid data on the connection. HTTP/2 error code '...'` | なし (クライアント自身が違反を検出) | 接続全体 |

この記事で扱うのは 1 行目です。2 行目や 3 行目が出ている場合は、接続そのものが不健全であり、診断方法が異なります。

## なぜ発生するのか

`PROTOCOL_ERROR` は [RFC 9113 section 7](https://www.rfc-editor.org/rfc/rfc9113#section-7) の中で最も汎用的なコードです。ピアは、1 つのリクエスト (そのヘッダー、ボディ、またはフレーミング) がルールに違反したときに、共有している接続を切断せずにそのリクエストだけを拒否したい場合、これをストリームエラーとして送信します。この設計のせいで、このエラーは"負荷がかかったとき"にランダムに起きるように見えます。1 本の HTTP/2 接続には数百の同時リクエストが乗っており、リセットされるのは検査に引っかかった 1 件だけで、残りは成功します。トラフィックが増えるほど、検査に引っかかるまれな性質を持つリクエストも増えるため、負荷が原因ではないのに失敗率は負荷とともに上がります。

.NET クライアントでよく見られる順に、原因を挙げます。

1. **途中のプロキシがそのリクエストの何かを拒否した。** リバースプロキシ、サービスメッシュ、Ingress コントローラー、クラウドのロードバランサーはいずれも HTTP/2 を終端し、独自のルールでリクエストを検証します。無効とみなすヘッダー文字、複数行のヘッダー値、接続固有のヘッダー、ヘッダーやボディのサイズ制限などです。実例としては、Envoy が[不正なヘッダー文字](https://github.com/envoyproxy/envoy/issues/7061)を含むストリームをリセットするケース、nginx が[複数行のヘッダー値](https://github.com/nginx/nginx/issues/540)で何もログを出さずに失敗するケース、Envoy を経由して届いた[通常のヘッダーの後ろにある疑似ヘッダー](https://github.com/dotnet/aspnetcore/issues/12190)を Kestrel 自身が拒否するケースがあります。
2. **リクエストボディが `Content-Length` と一致しなかった。** Kestrel は、宣言された長さより多い、または少ない DATA バイトを受信すると、`PROTOCOL_ERROR` でストリームをリセットします ([`Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs) の `Http2StreamErrorMoreDataThanLength` と `Http2StreamErrorLessDataThanLength`)。.NET の `HttpClient` は、この不一致をサーバーより先に自分で検出します (`Sent 5 request content bytes, but Content-Length promised 50.` が返ります)。したがって Kestrel がこれをログに出す場合、多くは .NET 以外のクライアントか、ヘッダーを修正せずにボディを書き換えたプロキシが原因です。
3. **Kestrel がリクエストの疑似ヘッダーを拒否した。** 無効な `:method`、`:path`、`:scheme` の不一致、不正な `Host` や `:authority`、不正な拡張 CONNECT は、いずれも Kestrel 内の `ResetAndAbort(..., Http2ErrorCode.PROTOCOL_ERROR)` で終わります。`HttpClient` はこれらのヘッダーを自分で組み立てるため、遭遇するのはプロキシや自作クライアントを経由した場合だけです。
4. **アプリケーションコードがストリームをリセットした。** `IHttpResetFeature.Reset(1)` を呼ぶミドルウェアやハンドラーは、クライアント側でまったく同じエラーを引き起こします。まれですが、ゲートウェイや gRPC インターセプターの中には、"不正なリクエスト"を知らせるためにあえてこれを行うものがあります。

通常は原因ではないものが 1 つあります。.NET クライアントが不正なヘッダーを Kestrel に直接送るケースです。私の再現環境では、`TE: gzip`、`Connection: keep-alive`、300 KB のカスタムヘッダーを h2c で Kestrel 10.0.10 に送ったところ、いずれもリセットではなく通常の `400 Bad Request` が返りました。Kestrel のバックエンドに対して `PROTOCOL_ERROR` が出る場合は、まずクライアントと Kestrel の間にあるものを疑ってください。

## 最小の再現コード

まったく同じ例外を再現する最も簡単な方法は、`IHttpResetFeature` を通じて自分自身のストリームをリセットする Kestrel エンドポイントを用意することです。これは、クライアント側から見るとプロキシが送る `RST_STREAM` とバイト単位で同一です。

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
#:sdk Microsoft.NET.Sdk.Web
#:property PublishAot=false
using System.Net;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core;

var hits = 0;
var builder = WebApplication.CreateBuilder();
builder.Logging.ClearProviders();
// h2c (HTTP/2 without TLS) needs an HTTP/2-only endpoint
builder.WebHost.ConfigureKestrel(k => k.ListenLocalhost(5199, o => o.Protocols = HttpProtocols.Http2));
var app = builder.Build();
app.MapGet("/reset/{code:int}", (HttpContext ctx, int code) =>
{
    Interlocked.Increment(ref hits);
    ctx.Features.Get<IHttpResetFeature>()!.Reset(code); // 1 = PROTOCOL_ERROR, 7 = REFUSED_STREAM
    return Results.Empty;
});
await app.StartAsync();

var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version20,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact,
};

foreach (var code in new[] { 1, 7 })
{
    hits = 0;
    try { await client.GetAsync($"http://localhost:5199/reset/{code}"); }
    catch (HttpRequestException e) when (e.InnerException is HttpProtocolException p)
    {
        Console.WriteLine($"code {code}: {e.HttpRequestError}, ErrorCode={p.ErrorCode}, server hits={hits}");
        Console.WriteLine($"  outer: {e.Message}");
    }
}
await app.StopAsync();
```

出力:

```text
code 1: HttpProtocolError, ErrorCode=1, server hits=1
  outer: The HTTP/2 server reset the stream. HTTP/2 error code 'PROTOCOL_ERROR' (0x1). (HttpProtocolError)
code 7: HttpProtocolError, ErrorCode=7, server hits=4
  outer: The request was aborted.
```

役に立つのは `server hits` の列です。`PROTOCOL_ERROR` のリセットはサーバーに 1 回だけ届き、そのままあなたにスローされます。`REFUSED_STREAM` のリセットは、`SocketsHttpHandler` 自身が再試行します。RFC 9113 が、拒否されたストリームをピアが処理していないことを保証しているためです。プールは `MaxConnectionFailureRetries = 3` 回の再試行で諦めるので、サーバーには 4 回の試行が見えています。ソースは [`Http2Stream.OnReset`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs) で、`canRetry` が true になるのは `REFUSED_STREAM` と、`GOAWAY` で未処理とマークされたストリームだけです。

## 修正方法の詳細

### 1. どのホップがリセットを送ったかを特定する

`RST_STREAM` を誰が送ったのかは、クライアントからは分かりません。分かるのは、そのフレームが接続先のピア、つまり最初の HTTP/2 ホップから来たということだけです。それはあなたのサービスではなくプロキシであることがよくあります。コードを変更する前にこれをはっきりさせてください。

- **バックエンドで Kestrel の HTTP/2 デバッグログを有効にします。** Kestrel は、リセットしたすべてのストリームを `Microsoft.AspNetCore.Server.Kestrel.Http2` カテゴリの `Debug` レベルでログに出力します。メッセージは `HTTP/2 stream error "PROTOCOL_ERROR". A Reset is being sent to the stream.` (イベント 35) や `HTTP/2 stream error.` (イベント 30。正確な理由を持つ `Http2StreamErrorException` が付随し、たとえば `More data received than specified in the Content-Length header.` など) です。

```json
// appsettings.Development.json, ASP.NET Core 10
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore.Server.Kestrel.Http2": "Debug",
      "Microsoft.AspNetCore.Server.Kestrel.BadRequests": "Debug"
    }
  }
}
```

- **失敗したリクエストについて Kestrel が何もログに出さない場合、リセットは中継装置から来ています。** その時間帯のプロキシのアクセスログを確認してください。Envoy はレスポンスフラグと `upstream_reset_before_response_started` の詳細にリセットを記録し、nginx はヘッダーの問題をエラーログの `info` レベルに出力し (確認するには `error_log` を `info` に上げます)、クラウドのロードバランサーは通常、リクエストごとの理由コードを公開しています。
- **一度プロキシを迂回します。** 同じリクエストでバックエンドを直接呼び出します (ポートフォワードや内部アドレスを使います)。エラーが消えれば、どのホップに責任があるかが証明できます。

### 2. ホップが拒否したリクエストを修正する

どのホップのどのルールかが分かれば、修正は通常トランスポートではなくリクエスト側にあります。失敗したリクエストのメソッド、パス、ヘッダー名、ヘッダー値の長さ、ボディのサイズをログに出し (認証ヘッダーの値は絶対に出さないでください)、成功したリクエストと比較します。よくある原因は次のとおりです。

- 可視 ASCII 以外の文字、埋め込まれた改行、先頭や末尾の空白を含むヘッダー値。多くは、ユーザー入力をそのままカスタムヘッダーにコピーしたものです。`HttpClient` は CR、LF、NUL をブロックしますが、厳格なプロキシはそれ以上のものを拒否します。
- HTTP/1.1 でしか意味を持たないヘッダー (`Connection`、`Keep-Alive`、`Proxy-Connection`、`Transfer-Encoding`、`Upgrade`、そして `trailers` 以外の値を持つ `TE`)。`HttpClient` では `TryAddWithoutValidation` で追加でき、中継装置にはこれらを持つストリームをリセットする権限があります。
- プロキシの制限を超えるリクエスト。大きな Cookie、多数のクレームを持つ JWT、小さなバッファーで構成されたプロキシへの大きなボディなどです。これらは典型的な"一部のユーザーだけ"の障害です。
- `Headers.ContentLength` を設定しておきながら別の数のバイトを書き込むカスタム `HttpContent`、またはボディを圧縮したり書き換えたりするプロキシのフィルター。.NET 以外でこれに相当するものが、Kestrel からの直接の `PROTOCOL_ERROR` です。

### 3. 再試行する。ただし繰り返しても安全なリクエストだけ

リセットが自分で制御できないインフラから来る場合は、再試行を追加します。`PROTOCOL_ERROR` のリセットは、サーバーがそのリクエストを処理したかどうかを教えてくれません (プロキシは転送した後にリセットすることがあります)。そのため、再試行は冪等なメソッドに限定してください。`Microsoft.Extensions.Http.Resilience` を使う場合は次のとおりです。

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.0.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

builder.Services.AddHttpClient("api", c =>
    {
        c.BaseAddress = new Uri("https://api.internal");
        c.DefaultRequestVersion = HttpVersion.Version20;
    })
    .AddResilienceHandler("h2-reset", pipeline =>
    {
        var retry = new HttpRetryStrategyOptions
        {
            MaxRetryAttempts = 2,
            Delay = TimeSpan.FromMilliseconds(50),
            ShouldHandle = args => ValueTask.FromResult(
                args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.HttpProtocolError }),
        };
        retry.DisableForUnsafeHttpMethods(); // never replay POST, PUT, PATCH, DELETE, CONNECT
        pipeline.AddRetry(retry);
    });
```

最初の試行をリセットし、2 回目の試行で成功するエンドポイントに対して、このクライアント経由の `GET` は `ok on attempt 2 via HTTP/2` を返しました。一方 `POST` は、サーバーへのヒットが 1 回のまま、元の `PROTOCOL_ERROR` をスローしました。すでに `AddStandardResilienceHandler` を使っている場合、そのデフォルトの `ShouldHandle` は `HttpRequestException` を一時的な障害として扱うので、このケースもカバーされます。ただし `options.Retry` で `DisableForUnsafeHttpMethods()` を呼ばない限り、すべてのメソッドを再試行します。なお、`DisableForUnsafeHttpMethods` の戻り値は `void` なので、メソッドチェーンの中ではなく、`AddRetry` に渡す前のオプションオブジェクトに対して呼び出してください。

### 4. 問題のあるホップを HTTP/1.1 にダウングレードする

リセットの原因が、バグのある、または過度に厳格な HTTP/2 実装を持つ中継装置にあり、それを修正もアップグレードもできない場合は、そのホップから HTTP/2 を外します。クライアント側では次のようにします。

```csharp
// .NET 10: ask for HTTP/1.1 for this client only
var client = new HttpClient
{
    DefaultRequestVersion = HttpVersion.Version11,
    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
};
```

HTTP/1.1 にはリセットすべきストリームがありません。再現では、HTTP/2 でストリームをリセットしたのと同じエンドポイントが `ok on attempt 2 via HTTP/1.1` と応答しました。多重化は失われるため、負荷時には接続数が増えることを見込んでください。また、gRPC は HTTP/2 を必須とするため、この方法はまったく使えません。これは回避策であり、プロキシ側に issue を起票した上で使うものです。根本的な修正とは考えないでください。

## 注意点とバリエーション

- **`REFUSED_STREAM` は似ていますが別の問題です。** 外側のメッセージは `The request was aborted.` で、内部に `REFUSED_STREAM` の `HttpProtocolException` があり、ハンドラーがすでに 3 回再試行した後にしか目にしません。これは、サーバーまたはプロキシが新しいストリームを拒否していることを意味します。典型的には、同時ストリーム数の上限に達したか、シャットダウン中です。サーバーの `SETTINGS_MAX_CONCURRENT_STREAMS` を確認し、`SocketsHttpHandler.EnableMultipleHttp2Connections = true` を検討してください。
- **ローカルの h2c エンドポイントでの `HTTP_1_1_REQUIRED`。** プレーンな `http://` 上で Kestrel を `HttpProtocols.Http1AndHttp2` に構成し、クライアントで HTTP/2 を強制すると、`The HTTP/2 server closed the connection. HTTP/2 error code 'HTTP_1_1_REQUIRED' (0xd).` が返ります。TLS がないとプロトコルをネゴシエートする ALPN が存在しないため、h2c には `Http2` 専用のエンドポイントが必要です。
- **`ResponseHeadersRead` でのボディ途中のリセット。** レスポンスを自分でストリーミングしている場合、リセットが届く時点ではステータスコード (多くは `200`) がすでに返されています。成功ステータスを、ボディが完全であることの証拠とみなさないでください。読み取りは `Error while copying content to a stream.` をスローするか、レスポンスストリームの `ReadAsync` から `HttpProtocolException` を直接 (`HttpRequestException` のラッパーなしで) スローします。
- **レジリエンスハンドラーはボディ途中のリセットを再試行できません。** ハンドラーパイプラインはレスポンスヘッダーが届いた時点で戻り、その後に `HttpClient` がボディをバッファリングします。そのため、ボディの途中でのリセットは、デフォルトの `ResponseContentRead` であっても、手順 3 の再試行を素通りします。ボディが重要な場合は、冪等な呼び出しに限り、"送信して読み取る"操作全体を独自の再試行で包んでください。
- **ピアがリセットではなく接続を閉じた場合。** 内部例外が `HttpProtocolException` ではなく `ResponseEnded` を持つ `HttpIOException` である場合、HTTP/2 フレームなしで接続が切れています。これはキープアライブとアイドルタイムアウトに関する系統で、[the response ended prematurely fix](/ja/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/) で扱っています。
- **タイムアウトはリセットではありません。** 呼び出しがハングし、その後 `TaskCanceledException` で失敗する場合、ストリームをリセットしたものは何もありません。まずは [why HttpClient throws "A task was canceled"](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) から始めてください。

## 関連記事

- [Fix: HttpIOException "The response ended prematurely" in HttpClient](/ja/2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient/) は、このエラーの接続レベルの兄弟にあたるエラーを扱います。
- [Polly vs resilience handlers in .NET 11](/ja/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) では、上記の再試行がどこに収まるか、そして標準ハンドラーがどのように構成されているかを説明しています。
- [HttpClient vs IHttpClientFactory vs Refit](/ja/2026/05/httpclient-vs-httpclientfactory-vs-refit/) では、この記事で使っている名前付きクライアントの構成方法を示しています。
- [Fix: The SSL connection could not be established](/ja/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/) は、HTTP/2 がネゴシエートされる前に失敗する場合に役立ちます。
- [gRPC in containers: 4 traps you can fix](/ja/2026/01/grpc-in-containers-feels-hard-in-net-9-and-net-10-4-traps-you-can-fix/) では、gRPC が追加する HTTP/2 専用トランスポートの問題を扱っています。

## 参考資料

- [RFC 9113, HTTP/2: error codes (section 7) and stream errors (section 5.4.2)](https://www.rfc-editor.org/rfc/rfc9113#section-7)
- [`HttpProtocolException` class, Microsoft Learn](https://learn.microsoft.com/dotnet/api/system.net.http.httpprotocolexception)
- [`HttpProtocolException.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/HttpProtocolException.cs) と [`Http2Stream.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/Http2Stream.cs) (dotnet/runtime v10.0.0)
- [Kestrel `Http2Stream.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Http2/Http2Stream.cs) と [`KestrelTrace.Http2.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Servers/Kestrel/Core/src/Internal/Infrastructure/KestrelTrace.Http2.cs) (dotnet/aspnetcore v10.0.0)
- [Build resilient HTTP apps, Microsoft Learn](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)
- [envoyproxy/envoy#7061](https://github.com/envoyproxy/envoy/issues/7061), [nginx/nginx#540](https://github.com/nginx/nginx/issues/540), [dotnet/aspnetcore#12190](https://github.com/dotnet/aspnetcore/issues/12190)
