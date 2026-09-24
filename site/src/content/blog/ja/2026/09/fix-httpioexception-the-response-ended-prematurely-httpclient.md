---
title: "修正: .NET の HttpClient で発生する HttpIOException: The response ended prematurely"
description: "HttpClient がサーバーが閉じたばかりのキープアライブ接続を再利用したか、サーバーがレスポンスの途中で接続を切断しています。PooledConnectionIdleTimeout をサーバーのアイドルタイムアウトより短くし、べき等なリクエストだけを再試行してください。"
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "httpclient"
  - "networking"
lang: "ja"
translationOf: "2026/09/fix-httpioexception-the-response-ended-prematurely-httpclient"
translatedBy: "claude"
translationDate: 2026-09-24
---

`HttpIOException: The response ended prematurely. (ResponseEnded)` は、`HttpClient` が完全な HTTP レスポンスを受け取る前に TCP 接続が閉じられたことを意味します。最も多い原因はキープアライブの競合です。サーバーがアイドル状態を理由に接続を閉じるのとまったく同じ瞬間に、`HttpClient` がプール内のその接続でリクエストを送信してしまいます。`SocketsHttpHandler.PooledConnectionIdleTimeout` をサーバー (またはロードバランサー) のアイドルタイムアウトより十分に短く設定し、`ResponseEnded` の再試行は 2 回送っても安全なリクエストに限定してください。すべてのリクエストでエラーが出る場合は、接続先そのものが間違っています。HTTPS ポートに対する `http://`、あるいは背後で何も待ち受けていない Docker のポートマッピングです。

以下の内容はすべて、意図的に不正な動作をする小さな raw ソケットサーバーを相手に、.NET 10.0.10 (SDK 10.0.302) と .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) で再現したものです。どちらのランタイムでもバイト単位で同一の結果になりました。

## エラーが発生する状況

呼び出し側で目にする例外は、ほぼ必ず `HttpIOException` をラップした `HttpRequestException` です。

```text
System.Net.Http.HttpRequestException: An error occurred while sending the request.
 ---> System.Net.Http.HttpIOException: The response ended prematurely. (ResponseEnded)
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   --- End of inner exception stack trace ---
   at System.Net.Http.HttpConnection.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(HttpRequestMessage request, Boolean async, Boolean doRequestAuth, CancellationToken cancellationToken)
   at System.Net.Http.RedirectHandler.SendAsync(HttpRequestMessage request, Boolean async, CancellationToken cancellationToken)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|83_0(HttpRequestMessage request, HttpCompletionOption completionOption, CancellationTokenSource cts, Boolean disposeCts, CancellationTokenSource pendingRequestsCts, CancellationToken originalCancellationToken)
```

メッセージには 3 つのバリエーションがあり、どれが出るかで接続がどこで切れたかがわかります。

| 外側のメッセージ | 内側のメッセージ | 意味 |
| --- | --- | --- |
| `An error occurred while sending the request.` | `The response ended prematurely. (ResponseEnded)` | ステータスラインが 1 バイトも届く前に EOF |
| `Error while copying content to a stream.` | `The response ended prematurely. (ResponseEnded)` | ヘッダーは届いたが、ボディが途中で切れた (バッファリング読み取り) |
| なし、`HttpIOException` が直接スローされる | `The response ended prematurely, with at least 90 additional bytes expected. (ResponseEnded)` | 自分でストリームを読んでいる途中でボディが切れた |

HTTP/2 接続では 4 つ目として `The response ended prematurely while waiting for the next frame from the server.` が加わります。.NET 8 以降、これらすべてのケースで `HttpRequestException.HttpRequestError` と `HttpIOException.HttpRequestError` の両方が `HttpRequestError.ResponseEnded` に設定されます。メッセージ文字列を解析する代わりに、コードではこちらをチェックしてください。

## なぜ発生するのか

`SocketsHttpHandler` は、まだデータを待っているのにソケットからの読み取りが 0 バイトを返したとき (相手側からの正常な FIN)、常に `ResponseEnded` をスローします。発生源は `HttpConnection.cs` の 2 行です。リクエスト送信後に読み取りバッファーが空だった場合と、`FillAsync` 内の `bytesRead == 0` です。.NET の側が失敗を決めたわけではありません。相手側が接続を閉じたのです。問題はその理由で、よく見られる順に原因を挙げます。

1. **キープアライブの競合。** サーバー (またはプロキシ、クラウドのロードバランサー) は N 秒後にアイドル接続を閉じます。`HttpClient` はデフォルトでアイドル接続を 60 秒間保持します。N の方が短いと、いずれサーバーがまさに閉じようとしている接続でリクエストが送信されます。これが断続的に起きる、「99% は動く」タイプです。
2. **実際には何も待ち受けていない。** Docker Desktop、`kubectl port-forward`、SSH トンネル、一部のリバースプロキシは、TCP 接続を自分で受け入れ、バックエンドが存在しないとその接続を閉じます。その結果、`Connection refused` ではなく `ResponseEnded` になります。
3. **ポートのプロトコルが間違っている。** TLS 専用ポートにプレーンな `http://` を送ると (Kestrel の `launchSettings.json` でよくある取り違え)、サーバーはハンドシェイクに失敗してソケットを閉じます。
4. **サーバーがレスポンスの途中でクラッシュした、または中断した。** ストリーミング中に終了したプロセス、サイズや時間の上限に達したプロキシ、実際に書き込む量より大きい `Content-Length` を設定したハンドラーなどです。これはボディ段階のバリエーションになります。

## 最小再現コード

このファイルベースアプリは raw TCP サーバーを起動します。サーバーは各接続の最初のリクエストには応答し、2 つ目のリクエストには応答せずに接続を閉じます。これは、サーバー側のアイドルタイムアウトがリクエストの最中に発火したときの挙動そのものです。

```csharp
// .NET 10.0.10, C# 14. Run with: dotnet run repro.cs
using System.Net;
using System.Net.Sockets;
using System.Text;

var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
int port = ((IPEndPoint)listener.LocalEndpoint).Port;
int connections = 0;

_ = Task.Run(async () =>
{
    while (true)
    {
        var tcp = await listener.AcceptTcpClientAsync();
        int connectionId = Interlocked.Increment(ref connections);
        _ = Task.Run(async () =>
        {
            using (tcp)
            {
                var stream = tcp.GetStream();
                for (int requestNo = 1; ; requestNo++)
                {
                    if (!await ReadRequestAsync(stream)) return;
                    Console.WriteLine($"  server: connection {connectionId}, request {requestNo}");
                    if (requestNo == 2) return; // idle timeout fires: close, no response
                    await stream.WriteAsync("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"u8.ToArray());
                }
            }
        });
    }
});

using var client = new HttpClient();
foreach (var method in new[] { HttpMethod.Get, HttpMethod.Post })
{
    for (int i = 1; i <= 2; i++)
    {
        try
        {
            using var request = new HttpRequestMessage(method, $"http://127.0.0.1:{port}/");
            if (method == HttpMethod.Post) request.Content = new StringContent("{}");
            using var response = await client.SendAsync(request);
            Console.WriteLine($"{method} #{i}: {await response.Content.ReadAsStringAsync()}");
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"{method} #{i}: {ex.HttpRequestError} / {ex.InnerException?.Message}");
        }
    }
}

// Reads one request: headers up to the blank line, then Content-Length bytes of body.
static async Task<bool> ReadRequestAsync(NetworkStream stream)
{
    var data = new List<byte>();
    var buffer = new byte[8192];
    int headerEnd;
    while ((headerEnd = Encoding.ASCII.GetString(data.ToArray()).IndexOf("\r\n\r\n")) < 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        data.AddRange(buffer.AsSpan(0, read));
    }
    var headers = Encoding.ASCII.GetString(data.ToArray(), 0, headerEnd);
    var lengthLine = headers.Split("\r\n")
        .FirstOrDefault(h => h.StartsWith("Content-Length:", StringComparison.OrdinalIgnoreCase));
    int remaining = (lengthLine is null ? 0 : int.Parse(lengthLine[15..])) - (data.Count - headerEnd - 4);
    while (remaining > 0)
    {
        int read = await stream.ReadAsync(buffer);
        if (read == 0) return false;
        remaining -= read;
    }
    return true;
}
```

.NET 10.0.10 と .NET 11 RC 1 での出力です。

```text
  server: connection 1, request 1
GET #1: ok
  server: connection 1, request 2
  server: connection 2, request 1
GET #2: ok
  server: connection 2, request 2
POST #1: ResponseEnded / The response ended prematurely. (ResponseEnded)
  server: connection 3, request 1
POST #2: ok
```

server の行を見てください。`GET #2` も切断された接続 (connection 1, request 2) に当たっていますが、`SocketsHttpHandler` がまったく新しい connection 2 で黙って再送しています。続いて `POST #1` が connection 2 を再利用し、同じように切断され、例外が表に出ました。ハンドラーが失敗したリクエストを再送するのは、そのリクエストが再利用されたプール接続で送信され、かつボディがないか、ボディが `Expect: 100-continue` によって保留されていた場合だけです (`HttpConnection.SendAsync` 内の `_canRetry` フラグ)。コンテンツ付きの `POST` は、サーバーがすでに処理したかどうかをハンドラーが知り得ないため、決して再送されません。このエラーがログに書き込み系のリクエストで現れ、読み取り系ではほとんど現れないのはこのためです。

## 修正 1: アイドル接続をサーバーより短く保持する

断続的に起きるタイプに対する恒久的な修正は、サーバーより先に `HttpClient` がアイドル接続を破棄するようにすることです。経路上で最も短いアイドルタイムアウトを探してください。サービス本体、リバースプロキシ、ロードバランサーのすべてが対象です。実際のデフォルト値をいくつか挙げます。

- Kestrel `KeepAliveTimeout`: 130 秒。クライアントのデフォルトより長いので、.NET 同士なら何もしなくても問題ありません。
- Node.js 26 `http.Server`: `keepAliveTimeout` 5 秒、`keepAliveTimeoutBuffer` 1 秒。
- uvicorn: `--timeout-keep-alive` 5 秒。Gunicorn: `keepalive` 2 秒。
- AWS Application Load Balancer: アイドルタイムアウト 60 秒。クライアントのデフォルトと同じなので、約 1 分間アイドルになったすべての接続で競合が起こり得ます。

そのうえで、ハンドラーをその値より短く設定します。`IHttpClientFactory` を使う場合は次のとおりです。

```csharp
// .NET 10, Microsoft.Extensions.Http 10.0.12
builder.Services.AddHttpClient<OrdersClient>(c => c.BaseAddress = new Uri("https://orders.internal/"))
    .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
    {
        // Server or load balancer closes idle connections after 60s (AWS ALB default).
        PooledConnectionIdleTimeout = TimeSpan.FromSeconds(30),
        // Also recycle connections so DNS changes are picked up.
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
    });
```

余裕は十分に取ってください。`PooledConnectionIdleTimeout` は接続をプールから取り出すときにはチェックされません。`PooledConnectionIdleTimeout / 4` ごと (下限は 1 秒) に動くバックグラウンドのスカベンジャータイマーによって適用されます (`HttpConnectionPoolManager.cs`)。したがって接続は、設定したアイドルタイムアウトの最大約 1.25 倍、小さい値ならアイドルタイムアウトに 1 秒を足した時間まで生き残ることがあります。サーバーのタイムアウトの半分にしておくのが安全な目安です。

取り出し時に実際にチェックされるのは、サーバー自身の `Keep-Alive: timeout=N` レスポンスヘッダーです。`HttpConnection.PrepareForReuse` は `CheckKeepAliveTimeoutExceeded()` を呼び出し、接続が N 秒以上アイドルだった場合はその接続を破棄します。これは HTTP/1.0 だけでなく HTTP/1.1 でも行われます。Node.js のサービスでこの問題がめったに起きないのはこのためです。Node は `timeout=5` を通知し、実際には 6 秒後に閉じます。サーバーを自分で管理しているなら、実際のタイムアウトより小さい値の `Keep-Alive` ヘッダーを送ることは、.NET に限らずすべてのクライアントを守る修正になります。

アイドル時間がちょうど 2,000 ms で接続を閉じるサーバーに対し、1,990-2,010 ms ごとに `POST` を送るクライアントで 3 つの方法すべてを計測しました (それぞれ 150 リクエスト、.NET 10.0.10)。

| クライアント/サーバーの構成 | 成功 | `ResponseEnded` |
| --- | --- | --- |
| デフォルト (`PooledConnectionIdleTimeout` 60 s) | 147 | 3 |
| `PooledConnectionIdleTimeout = 800 ms` | 150 | 0 |
| サーバーが `Keep-Alive: timeout=1` を送信 | 150 | 0 |

150 回中 3 回の失敗、これこそが本番環境でこのエラーを厄介にしている点です。すべてのテストを通過するほどまれでありながら、誰かが呼び出されるほどには頻繁です。ほとんどの場合、サーバーの FIN は次のリクエストより先に届き、`PrepareForReuse` が閉じた接続に気づいて黙って新しい接続を開きます。そのチェックとリクエスト送信の間の数ミリ秒に切断が重なったときだけ、表に出てきます。どちらの修正でも完全に解消しました。800 ms のアイドルタイムアウトが効くのは、スカベンジャー (この設定では毎秒動作) が 2,000 ms のサーバータイムアウトより前に接続を破棄するからです。ヘッダーが効くのは、クライアントが取り出しのたびに同期的にチェックするからです。

## 修正 2: `ResponseEnded` を再試行する、ただし 2 回目が安全な場合に限る

タイムアウトの調整で競合は減らせますが、なくすことはできません。サーバーは再起動したり、スケールインしたり、独自の理由で接続を切断したりします。そこで `ResponseEnded` を一時的なエラーとして扱いますが、条件が 1 つあります。サーバーはソケットを閉じる前にリクエストを受信して処理している可能性があります。私の再現用サーバーは、切断したリクエストのボディをすべて読み取っていました。注文を作成する `POST` を無条件に再試行すると、注文が 2 件作成されることがあります。

`AddStandardResilienceHandler()` はこの区別をしてくれません。デフォルトの `ShouldHandle` (`HttpClientResiliencePredicates.IsTransient`) は、すべての HTTP メソッドについて、すべての `HttpRequestException` を一時的なエラーとして扱います。`options.Retry.DisableForUnsafeHttpMethods()` を呼び出すか、サーバーが重複排除に使うべき等性キーがリクエストに含まれている場合にのみ安全でないメソッドを再試行する述語を書いてください。

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddHttpClient<OrdersClient>()
    .AddResilienceHandler("stale-connection", pipeline => pipeline.AddRetry(new HttpRetryStrategyOptions
    {
        MaxRetryAttempts = 1,
        Delay = TimeSpan.Zero, // a new connection is all we need, no backoff
        ShouldHandle = args => ValueTask.FromResult(
            args.Outcome.Exception is HttpRequestException { HttpRequestError: HttpRequestError.ResponseEnded }
            && args.Context.GetRequestMessage() is { } request
            && (request.Method == HttpMethod.Get
                || request.Method == HttpMethod.Put
                || request.Method == HttpMethod.Delete
                || request.Headers.Contains("Idempotency-Key"))),
    }));
```

呼び出し側は次のとおりです。

```csharp
// .NET 10
using var request = new HttpRequestMessage(HttpMethod.Post, "orders") { Content = JsonContent.Create(order) };
request.Headers.Add("Idempotency-Key", order.ClientRequestId.ToString());
using var response = await http.SendAsync(request, ct);
```

再現用サーバー (各接続の 2 つ目のリクエストを切断する) に対して、このハンドラーを使った 3 つの `POST` はすべて `200 ok` を返し、2 つ目と 3 つ目でそれぞれ 1 回ずつ再試行が行われました。サーバーは 3 つの接続で 5 つのリクエストを受け取っています。ここが肝心な点で、切断された 2 つのリクエストも実際にはサーバーに届いていたのです。再試行を `DelegatingHandler` で行っている場合は、[そのハンドラーが再試行ループに対してどこで実行されるか](/ja/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/)に注意してください。2 つの API のどちらを使うか検討しているなら、[Polly と組み込みのレジリエンスハンドラーの比較](/ja/2026/05/polly-vs-resilience-handlers-in-dotnet-11/)も読んでください。

## 修正 3: すべてのリクエストで失敗する場合

新しく起動したプロセスの最初のリクエストで毎回 `ResponseEnded` が出る場合、それは競合ではありません。私の検証では、次の 2 つのどちらでもまったく同じ例外が発生しました。

**TLS エンドポイントに対する `http://`。** TLS しか話さないサーバーは `GET / HTTP/1.1` を不正な ClientHello として受け取り、ハンドシェイクに失敗して接続を閉じます。スキームとポートを `launchSettings.json` (Kestrel のデフォルトプロファイルは `https` ポートと `http` ポートで待ち受けており、組み合わせを取り違えやすい) や `ASPNETCORE_URLS` と照らし合わせてください。逆の間違い、つまりプレーンな HTTP ポートに対する `https://` では、代わりに [the SSL connection could not be established](/ja/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/) になります。

**背後に何もないリスナー。** Docker は独自のプロキシを通してポートを公開します。コンテナー内のアプリが `0.0.0.0` ではなく `localhost` で待ち受けている場合 (ASP.NET Core なら `ASPNETCORE_URLS=http://+:8080` で解決します)、あるいはアプリがクラッシュしている場合、プロキシは接続を受け入れた直後に閉じます。同じマシンから `curl -v http://localhost:8080/` を実行してください。curl が `Empty reply from server` を報告するなら、問題は .NET のコードにはありません。

## 修正 4: 切れているのがボディの場合

外側のメッセージが `Error while copying content to a stream.` である場合、あるいは自分でストリームを読んでいて `with at least N additional bytes expected` が出る場合は、ステータスラインとヘッダーは届いており、ボディの途中で接続が閉じられています。答えはサーバー側のログにあります。

- ストリーミング中に上流のプロセスがクラッシュした、または強制終了された (OOM、Pod の退避、デプロイ)。
- プロキシがサイズや時間の上限でレスポンスを切った。nginx の `proxy_read_timeout`、CDN のレスポンス上限、API ゲートウェイのペイロード上限は、いずれもこの形で終わります。
- サーバーが実際に書き込んだバイト数より大きい `Content-Length` を宣言した。多くの場合、ヘッダー設定後にボディを変更したミドルウェア (圧縮、書き換え) が原因です。.NET は不足分を正確に報告します。私の再現では、ヘッダーが 100 でサーバーが 10 バイト送ったので 90 バイトでした。
- チャンク形式のレスポンスが終端の長さ 0 のチャンクなしで終わった。これも `copying content` のバリエーションになります。

途中で切れたボディの再試行が安全なのは、修正 2 と同じべき等性のルールを満たす場合だけです。このリクエストは確実にサーバーで処理されているからです。

## 注意点と紛らわしいエラー

**`HttpRequestError` は .NET 8 以降にしか存在しません。** .NET 6 と 7 では、内側の例外はメッセージが `The response ended prematurely.` のただの `IOException` で、分岐に使える列挙型はありません。キープアライブの挙動と上記の修正はすべて同じです。

**`Connection reset by peer` は、同じ競合が一段階進んだものです。** 受信バッファーに未読のリクエストデータが残っているソケットをサーバーが閉じると、カーネルは FIN の代わりに RST を送り、`IOException: Unable to read data from the transport connection: Connection reset by peer` (Windows では `An existing connection was forcibly closed by the remote host`) をラップした `HttpRequestException` になります。修正方法は同じです。

**`PooledConnectionIdleTimeout = TimeSpan.Zero` はプーリングを無効にします。** 確かに競合は起こらなくなり、私の検証でも失敗していた `POST` が成功に変わりましたが、以後すべてのリクエストで新しい TCP (および TLS) ハンドシェイクのコストがかかります。診断目的でのみ使ってください。これでエラーが消えるなら、キープアライブの競合であることが確定します。

**`TaskCanceledException` は別の失敗です。** `HttpClient.Timeout` に達したリクエストは、`ResponseEnded` ではなく [a task was canceled](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) で終わります。両方が出ている場合、おそらくサーバーが遅く、その前段にある何かが長く待ちすぎた接続を閉じています。

**リクエストごとに新しい `HttpClient` を作っても解決しません。** 接続を再利用しないことでキープアライブの競合を隠すだけで、その代わりに高負荷時のソケット枯渇を招きます。実際に機能するライフタイムのルールは [HttpClient vs HttpClientFactory vs Refit](/ja/2026/05/httpclient-vs-httpclientfactory-vs-refit/) で解説しています。

## 関連記事

- [修正: HttpClient で発生する TaskCanceledException: A task was canceled](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)。このエラーのタイムアウト版です。
- [修正: The SSL connection could not be established](/ja/2026/06/fix-the-ssl-connection-could-not-be-established-with-httpclient/)。逆方向のスキーム取り違えについてです。
- [AddStandardResilienceHandler で DelegatingHandler が再試行ごとに実行されない理由](/ja/2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler/)。
- [.NET 11 における Polly とレジリエンスハンドラーの比較](/ja/2026/05/polly-vs-resilience-handlers-in-dotnet-11/)。
- [HttpClient を使うコードの単体テスト方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)。`HttpRequestError.ResponseEnded` 付きの `HttpRequestException` をスローするテストで再試行の述語をカバーしたい場合に役立ちます。

## 参考資料

- dotnet/runtime の `release/10.0` ブランチにある [`HttpConnection.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnection.cs) (`SendAsync`、`FillAsync`、`PrepareForReuse`、`CheckKeepAliveTimeoutExceeded`) と [`HttpConnectionPoolManager.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/HttpConnectionPoolManager.cs) (スカベンジャーの周期)。
- 正確なメッセージについては [`ContentLengthReadStream.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/System/Net/Http/SocketsHttpHandler/ContentLengthReadStream.cs) と [System.Net.Http のリソース文字列](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Net.Http/src/Resources/Strings.resx)。
- Microsoft Learn の [`HttpRequestError` 列挙型](https://learn.microsoft.com/dotnet/api/system.net.http.httprequesterror) と [`SocketsHttpHandler.PooledConnectionIdleTimeout`](https://learn.microsoft.com/dotnet/api/system.net.http.socketshttphandler.pooledconnectionidletimeout)。
- プール接続のライフタイムとクライアントの再利用については [.NET の HttpClient ガイドライン](https://learn.microsoft.com/dotnet/fundamentals/networking/http/httpclient-guidelines)。
- dotnet/extensions の [`HttpClientResiliencePredicates.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpClientResiliencePredicates.cs) と [`HttpRetryStrategyOptionsExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Polly/HttpRetryStrategyOptionsExtensions.cs)。
- [Node.js の `server.keepAliveTimeout`](https://nodejs.org/api/http.html#serverkeepalivetimeout) と [AWS ALB の接続アイドルタイムアウト](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html#connection-idle-timeout)。
