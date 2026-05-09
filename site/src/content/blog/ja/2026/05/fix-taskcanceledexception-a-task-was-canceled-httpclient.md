---
title: "修正: TaskCanceledException: A task was canceled in HttpClient"
description: "HttpClient は 3 つの異なる理由で TaskCanceledException をスローします。タイムアウト、呼び出し元のキャンセル、または接続レベルの中断です。InnerException と CancellationToken.IsCancellationRequested で区別したうえで、正しい原因を修正してください。"
pubDate: 2026-05-09
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "cancellation"
lang: "ja"
translationOf: "2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient"
translatedBy: "claude"
translationDate: 2026-05-09
---

修正方法: `HttpClient` は `TaskCanceledException` (`OperationCanceledException` のサブクラス) を 3 つの異なる原因でスローするため、対応する前にそれらを区別する必要があります。`ex.InnerException is TimeoutException` であれば、リクエストは `HttpClient.Timeout` (デフォルト 100 秒) に達しています。タイムアウトを引き上げるか、長時間実行される呼び出しをリクエストごとの `CancellationTokenSource` に移してください。自分の `CancellationToken` がキャンセルされた場合 (`ex.CancellationToken.IsCancellationRequested == true`)、それは呼び出し元が処理を中断しているため、そのまま伝播させる以外の修正は不要です。どちらでもなければ、トランスポートレベルの中断 (DNS、TCP、TLS、サーバーリセット) を見ていることになり、これは通常、自分のコードではなくインフラ側を指しています。

```text
System.Threading.Tasks.TaskCanceledException: The request was canceled due to the configured HttpClient.Timeout of 100 seconds elapsing.
 ---> System.TimeoutException: The operation was canceled.
 ---> System.Threading.Tasks.TaskCanceledException: The operation was canceled.
   at System.Threading.Tasks.TaskCompletionSource`1.TrySetCanceled(CancellationToken cancellationToken)
   at System.Net.Http.HttpConnectionPool.SendWithVersionDetectionAndRetryAsync(...)
   at System.Net.Http.HttpClient.<SendAsync>g__Core|...
   at MyApp.Program.<Main>$(String[] args)
```

このガイドは .NET 11 preview 4 と `System.Net.Http` 11.0.0-preview.4 を対象に書かれています。例外の型とラップされた `TimeoutException` の形は .NET 5 以降変更されていませんが、メッセージ本文は .NET 8 でどのタイムアウトが発火したかを明示するように整理されました ("The request was canceled due to the configured `HttpClient.Timeout` of 100 seconds elapsing")。.NET 6 以前では汎用的な "A task was canceled." しか得られなかったため、2024 年以前の多くのアドバイスでは内部例外を手動でログに残すように指示されていたわけです。

## なぜ HttpClient はあらゆる原因に対して TaskCanceledException をスローするのか

`HttpClient.SendAsync` のパイプラインは `Task` と単一の `CancellationToken` パラメーターの上に構築されています。タイムアウト、呼び出し元のトークン、内部の接続中断はすべて、リクエストがソケットに送信される前に 1 つの `CancellationTokenSource` にリンクされます。これらのソースのいずれかが発火すると、最初に発火したものに関係なく、操作は同じ `OperationCanceledException` 型の失敗で完了します。

Microsoft はこの設計上の選択を [dotnet/runtime#21965](https://github.com/dotnet/runtime/issues/21965) で確認しています。タイムアウトを `TimeoutException` として直接表面化させないのは、型を変更するとバイナリ互換性が壊れるためです。代わりに .NET 5 では `TimeoutException` の `InnerException` を追加し、呼び出し元がケースを区別できるようにし、.NET 8 では明示的なメッセージ本文を追加しました。例外の `CancellationToken` プロパティはランタイムによって設定され、2 つ目の判別材料になります。

つまり、同じ例外が 3 つのまったく異なる問題をカバーしているのです。どのケースに該当するかを調べずに「task was canceled」に対応してしまうことが、このバグが何週間も解決されないままになる最大の理由です。

## 各原因の最小再現コード

```csharp
// .NET 11, C# 14, System.Net.Http 11.0.0-preview.4
using System.Net.Http;

// Cause 1: HttpClient.Timeout elapsed
using var c1 = new HttpClient { Timeout = TimeSpan.FromMilliseconds(50) };
try
{
    await c1.GetAsync("https://httpbin.org/delay/3");
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Inner: {ex.InnerException?.GetType().Name}");
    // Inner: TimeoutException
}

// Cause 2: caller's CancellationToken cancelled
using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
using var c2 = new HttpClient();
try
{
    await c2.GetAsync("https://httpbin.org/delay/3", cts.Token);
}
catch (TaskCanceledException ex)
{
    Console.WriteLine($"Token cancelled: {ex.CancellationToken.IsCancellationRequested}");
    Console.WriteLine($"Linked token: {cts.Token == ex.CancellationToken}");
    // Token cancelled: True
}

// Cause 3: connection-level abort (DNS/TCP/TLS) - simulated with a closed port
using var c3 = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
try
{
    await c3.GetAsync("http://10.255.255.1/");
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    Console.WriteLine("Looks like a timeout, was actually connect failure under timeout.");
}
catch (HttpRequestException ex)
{
    Console.WriteLine($"True transport failure: {ex.HttpRequestError}");
    // .NET 8+ exposes ex.HttpRequestError = ConnectionError, NameResolutionError, etc.
}
```

3 つ目のケースは興味深い点があります。接続のタイムアウトに達した場合は、`ex.HttpRequestError == HttpRequestError.ConnectionError` を持つ `HttpRequestException` が得られます。接続が成功してもレスポンスが停滞して `HttpClient.Timeout` を超えると、ケース 1 に戻ります。この 2 つはログ上ではほとんど同じに見えますが、必要な修正は異なります。

## 詳しい修正方法

### 1. まず例外フィルターで診断する

タイムアウトを変更する前に、どのケースに該当するかをログに残してください。そうしないと `Timeout` を 5 分に引き上げたあとで、本当の問題は呼び出し元のキャンセルだった、と気づくことになります。

```csharp
// .NET 11, C# 14
try
{
    return await client.GetAsync(url, ct);
}
catch (TaskCanceledException ex) when (ex.InnerException is TimeoutException)
{
    logger.LogWarning(ex,
        "HttpClient.Timeout elapsed for {Url} (configured: {Timeout})",
        url, client.Timeout);
    throw;
}
catch (OperationCanceledException ex) when (ct.IsCancellationRequested)
{
    logger.LogInformation("Caller cancelled request to {Url}", url);
    throw;
}
catch (TaskCanceledException ex)
{
    logger.LogError(ex, "Unknown cancellation cause for {Url}", url);
    throw;
}
```

`OperationCanceledException` は親型で、呼び出し元キャンセルの分岐ではこちらを使うべきです。実際のランタイム型は、パイプライン内のどこでキャンセルが発火したかによって `OperationCanceledException` か `TaskCanceledException` のどちらかになるためです。

### 2. HttpClient.Timeout を引き上げるのは、必要なクライアントだけに限定する

`HttpClient.Timeout` はクライアントごとに設定され、独自のタイムアウト付きトークンを渡さないすべてのリクエストに適用されます。デフォルトの 100 秒は典型的な REST 呼び出しでは問題ありません。長時間実行されるエンドポイントがある場合は、専用のクライアントを与えてください。

```csharp
// .NET 11
builder.Services.AddHttpClient("LongRunning", c =>
{
    c.Timeout = TimeSpan.FromMinutes(10);
    c.BaseAddress = new Uri("https://reports.example.com/");
});

builder.Services.AddHttpClient("Default", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
});
```

1 件の遅い呼び出しを動かすためだけに、グローバルクライアントの `Timeout` を引き上げてはいけません。将来の性能劣化を隠してしまうことになります。本来 200ms で済むはずの呼び出しが 90 秒かかり始めても、緩和されたゲートを静かに通過し、UI のハングとして表面化します。タイムアウトをきつくしておくほうが、性能劣化を早期に捕まえられます。[HttpClient の単体テスト解説](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)では、こうしたタイムアウト境界をテストで確かめる方法を扱っており、ここでの劣化が CI をすり抜けないようにできます。

### 3. 細かく制御するためにリクエストごとの CancellationTokenSource に切り替える

`HttpClient.Timeout` は粗い手段です。すでにトークンを持っている `BackgroundService` やリクエストパイプラインの中では、それらをリンクしてください。

```csharp
// .NET 11, C# 14
using var perCallCts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
using var linked = CancellationTokenSource.CreateLinkedTokenSource(
    perCallCts.Token, requestAborted);

try
{
    var response = await client.GetAsync(url, linked.Token);
    return await response.Content.ReadAsStringAsync(linked.Token);
}
catch (OperationCanceledException) when (perCallCts.IsCancellationRequested
                                          && !requestAborted.IsCancellationRequested)
{
    // Per-call timeout, not caller cancellation. Surface as your own timeout type.
    throw new TimeoutException($"GET {url} exceeded 15 seconds.");
}
```

このパターンは `IHttpClientFactory` ときれいに組み合わせられます。名前付きクライアントの `Timeout` を高めに (あるいは `Timeout.InfiniteTimeSpan` に) 設定しておき、本当の予算は呼び出し側でリンクされた CTS によって強制します。`Timeout.InfiniteTimeSpan` がここで機能する理由は、`HttpClient` が自身の `Timeout` をリンクされたトークンに加えるのは値が正のときだけだからです。クライアントの `Timeout` を無限にすると「呼び出し元が制御を握る」という意味になります。[キャンセルとデッドロックの解説](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)では、上位レイヤーでタイムアウトと呼び出し元キャンセルを区別する方法を含め、リンクトークンのパターンをさらに詳しく扱っています。

### 4. ストリーミングボディには HttpCompletionOption.ResponseHeadersRead を使う

`HttpClient.Timeout` が `SendAsync` から「ボディの読み取り準備完了」までの時間をカバーするのは、デフォルトの `HttpCompletionOption.ResponseContentRead` を使う場合だけです。`ResponseHeadersRead` ではタイムアウトはヘッダー受信までしか適用されません。ボディの読み取りは自分でタイムアウトを管理する必要があります。これは [HttpCompletionOption のドキュメント](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption)で確認できます。

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));
using var response = await client.GetAsync(
    url, HttpCompletionOption.ResponseHeadersRead, cts.Token);

response.EnsureSuccessStatusCode();
await using var stream = await response.Content.ReadAsStreamAsync(cts.Token);
await using var file = File.Create(path);
await stream.CopyToAsync(file, cts.Token);
```

トークンはどこにでも同じものを渡してください。よくあるバグは、`GetAsync` には `cts.Token` を渡しているのに `CopyToAsync` で渡し忘れるパターンです。この場合、`HttpClient.Timeout` はもはやボディには適用されず、止まったプロデューサーが永遠にハングします。[ASP.NET Core からのストリーミングに関する記事](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)では、リクエストの `CancellationToken` を転送し忘れることでプロデューサー側に同じハングが起こる、対称なサーバー側のミスを扱っています。

### 5. .NET 8 以降では接続タイムアウトを別に構成する

`HttpClient.Timeout` はリクエスト全体をカバーしますが、DNS と TCP 接続もその予算の一部です。リクエスト全体のタイムアウトとは独立して DNS や接続を早く失敗させたい場合は、`SocketsHttpHandler.ConnectTimeout` を設定します。

```csharp
// .NET 11, C# 14
var handler = new SocketsHttpHandler
{
    ConnectTimeout = TimeSpan.FromSeconds(5),
    PooledConnectionLifetime = TimeSpan.FromMinutes(2),
};

builder.Services.AddHttpClient("Api", c =>
{
    c.Timeout = TimeSpan.FromSeconds(30);
    c.BaseAddress = new Uri("https://api.example.com/");
}).ConfigurePrimaryHttpMessageHandler(() => handler);
```

短い接続タイムアウトは、「無駄に 30 秒待つ」を「5 秒で失敗して別のエンドポイントで再試行する」に変えてくれます。接続のタイムアウトとレスポンスのタイムアウトを区別することは、Polly のサーキットブレーカーが素早く開くか、すべての呼び出し元をフルのタイムアウトウィンドウに引きずり込むかの違いになります。

## このエラーを引き起こしやすい構成

### Timeout を間違えて指定された IHttpClientFactory の型付きクライアント

型付きクライアントは `AddHttpClient` で設定した `Timeout` を引き継ぎ、後から `HttpClient` のプロパティで設定した値ではありません。コンストラクター注入から `_client.Timeout = TimeSpan.FromMinutes(5)` を実行するコードは、そのクライアントを通じて 1 件でもリクエストが流れたあとでは `InvalidOperationException` をスローします。ファクトリは内部のハンドラーを再利用しますが、`HttpClient` インスタンスは `Timeout` 目的では 1 回限りの使い捨てです。タイムアウトは型付きクライアントのコンストラクターではなく `AddHttpClient` で構成してください。

### トークンが揃っていない Task.WhenAll

`Task.WhenAll(tasks)` で N 件の HTTP 呼び出しを並列展開し、そのうち 1 件がキャンセルされても、スローするのはその 1 件だけです。残りは動き続け、こちらもタイムアウトに達する可能性があります。コードが最初のキャンセルを再スローすると、生き残ったタスクは観測されないままになり、それらの例外は `TaskScheduler.UnobservedTaskException` に出てきます。共有のリンクされた CTS を `Task.WhenAll` と組み合わせ、最初の失敗時にキャンセルすることで、残りのリクエストも止まるようにしてください。

### Polly のリトライポリシーが内部のタイムアウトを隠す

`TaskCanceledException` を握りつぶしてリトライする Polly のリトライハンドラーは、根本のタイムアウトを完全に覆い隠してしまいます。アップストリームが本当に遅い場合、1 回 100 秒の待機を 3 回 100 秒の待機に変えてからあきらめることになります。Polly が内部の `TimeoutException` でショートサーキットし、呼び出し元に判断を委ねるように構成してください。

```csharp
// .NET 11, Microsoft.Extensions.Http.Resilience 11.0.0-preview.4
builder.Services.AddHttpClient("Api")
    .AddStandardResilienceHandler(options =>
    {
        options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(10);
        options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(30);
        options.Retry.ShouldHandle = args => args.Outcome switch
        {
            { Exception: HttpRequestException } => PredicateResult.True(),
            { Exception: TaskCanceledException tce } when tce.InnerException is TimeoutException
                => PredicateResult.False(),
            _ => PredicateResult.False(),
        };
    });
```

`Microsoft.Extensions.Http.Resilience` パッケージの `AddStandardResilienceHandler` は、試行ごとのタイムアウトとリクエスト全体のタイムアウトをきれいに分離します。これは手作りの Polly + リンクされた CTS のコードに対するクリーンな置き換えになります。

### HttpClient 呼び出しに対する同期的な Wait や Result

`client.GetAsync(url).Result` はシングルスレッドの同期コンテキスト (古典的な ASP.NET、WPF) でデッドロックし、`HttpClient.Timeout` が 100 秒後にようやく発火したときに `TaskCanceledException` として表面化します。修正は `await` を使うこと、それだけです。デッドロックによりリクエストはレスポンスフェーズに入らず、タイマーが最終的に発火し、症状はネットワークタイムアウトのように見えます。トレースにネットワーク送信が見られないのに「task was canceled」が出ているなら、呼び出しスタック内のブロッキング同期呼び出しを探してください。[BackgroundService パターンの記事](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/)では、ホスト型サービスにおける async-all-the-way-down のルールを扱っています。これが最も強く効いてくる場面です。

### HttpRequestMessage の使い回し

`HttpRequestMessage` は 2 回送信できません。2 回目の `SendAsync` は `InvalidOperationException: The request message was already sent` をスローします。一部のリトライライブラリはこれを取り繕い、失敗は同じトークンを共有していた別のリクエストからのキャンセルとして表面化します。試行ごとに必ず新しい `HttpRequestMessage` を作成してください。

## このエラーに似ているが別物のもの

### .NET Framework 4.8 で内部例外なしの「The operation was canceled」

.NET Framework では、`InnerException` が `TimeoutException` であることはほとんどありません。ステップ 1 の判別パターンが機能するのは .NET 5 以降だけです。まだ Framework を使っているなら、最も信頼できる手がかりは `ex.CancellationToken` を渡したトークンと比較することと、スローまでの経過時間を記録することです。このケースの扱いにくさは、Framework からの移行を早めに済ませる十分な理由のひとつです。

### SocketException をラップする「An error occurred while sending the request」

完全に別の例外クラス (`HttpRequestException`) で、ほぼ常にトランスポートの問題 (DNS、TCP RST、TLS ハンドシェイク失敗) です。.NET 8 以降では、`ex.HttpRequestError` が原因を列挙します: `ConnectionError`、`NameResolutionError`、`SecureConnectionError` など。修正は DNS、ファイアウォール、証明書設定にあり、自分のコードにはありません。

### 「The SSL connection could not be established」

内部例外は `System.Net.Security` の `AuthenticationException` です。これは TLS ネゴシエーションの失敗で、タイムアウトではありません。秒単位の時間がかかって表面的には似て見えるだけです。証明書チェーン、SNI ホスト、TLS プロトコルバージョン (`SslProtocols.Tls12 | SslProtocols.Tls13` が .NET 11 のデフォルト) を確認してください。

### 「A connection attempt failed because the connected party did not properly respond」

`SocketException` で `ErrorCode == 10060` (WSAETIMEDOUT) です。syn-ack が届かないときに発生します。通常はネットワークレベルのファイアウォールでのドロップです。これが `TaskCanceledException` として表面化するのは、ラップする `HttpClient.Timeout` が OS レベルの接続タイムアウトより短いときだけで、それ以外では `HttpRequestException` が得られます。

### CancelPendingRequests による「Request was forcibly aborted」

`HttpClient.CancelPendingRequests` を呼ぶと、そのクライアント上のすべての処理中リクエストがキャンセルされ、1 件だけではありません。アプリがクライアントを再利用していて、あるコンポーネントが `CancelPendingRequests` を呼ぶと、他のすべてのコンポーネントの処理中リクエストが同じ `TaskCanceledException` で失敗します。これは長命な静的クライアントではなく `IHttpClientFactory` を使うべき最も強い理由のひとつです。ファクトリの呼び出しごとの型付きクライアントは短命のファサードなので、迷子の `CancelPendingRequests` は呼び出し元にしか影響しません。

## 関連記事

完全なキャンセルパターンについては、[長時間実行タスクをキャンセルする解説](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)が `CancellationToken`、`Task.WaitAsync`、上で使ったリンクトークンの形を扱っています。[HttpClient の単体テストガイド](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)では、テストでタイムアウトを偽装してタイムアウト分岐を実際に動かす方法を示しています。ストリーミングダウンロードについては、[ASP.NET Core からのストリーミング記事](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)が対応するサーバー側のキャンセル転送を扱っています。バックグラウンドワーカーがこうした呼び出しを発行している場合は、[BackgroundService の解説](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/)が、ホストシャットダウン時にもリンクトークンパターンが正しく機能するための寿命とキャンセルのルールを扱っています。

## 参考資料

- [`HttpClient.Timeout` プロパティ](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclient.timeout)、Microsoft Learn。
- [`HttpCompletionOption` 列挙型](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpcompletionoption)、Microsoft Learn。
- [`SocketsHttpHandler.ConnectTimeout`](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.socketshttphandler.connecttimeout)、Microsoft Learn。
- [`HttpRequestError` 列挙型](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httprequesterror)、Microsoft Learn。
- [HttpClient throws TaskCanceledException on timeout](https://github.com/dotnet/runtime/issues/21965)、dotnet/runtime issue。
- [How to identify HttpClient connect timeout errors?](https://github.com/dotnet/runtime/issues/78070)、dotnet/runtime issue。
- [`Microsoft.Extensions.Http.Resilience` standard handler](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience)、Microsoft Learn。
