---
title: "修正: AddStandardResilienceHandler でカスタム DelegatingHandler がリトライのたびに実行されない問題"
description: "AddStandardResilienceHandler より前に登録した DelegatingHandler は、リトライごとではなく論理リクエストごとに 1 回しか実行されません。レジリエンスハンドラーの後ろに移動し、リトライが同じ HttpRequestMessage を再送信するため、ハンドラーを冪等にしてください。Microsoft.Extensions.Http.Resilience 10.10.0 と 8.10.0 で計測しています。"
pubDate: 2026-09-23
template: how-to
tags:
  - "dotnet-10"
  - "httpclient"
  - "resilience"
  - "polly"
  - "aspnetcore"
lang: "ja"
translationOf: "2026/09/fix-delegatinghandler-not-running-on-each-retry-with-addstandardresiliencehandler"
translatedBy: "claude"
translationDate: 2026-09-23
---

**短い答え:** `IHttpClientFactory` はハンドラーチェーンを登録順に組み立て、最初に登録したものが最も外側になります。`AddStandardResilienceHandler()` の*前*に `AddHttpMessageHandler<MyHandler>()` を呼ぶと、ハンドラーはリトライループの外側に置かれ、その内側で Polly が何回試行しても、ちょうど 1 回しか実行されません。レジリエンスハンドラーの*後*に登録すれば、試行ごとに実行されます。そのうえで、この移動によって表面化する 2 つ目のバグを修正します。標準のリトライは**同じ** `HttpRequestMessage` オブジェクトを再送信するため、試行ごとのハンドラー内の `request.Headers.Add(...)` は重複した値を積み上げ、シークできない `StreamContent` のボディは 2 回目の試行で `InvalidOperationException: The stream was already consumed` をスローします。

以下の内容はすべて、.NET 10.0.10 (SDK 10.0.302) 上のファイルベースのプローブで、現行の安定版である `Microsoft.Extensions.Http.Resilience` 10.10.0 に対して計測し、8.10.0 でも再実行したものです。両バージョンの出力は同一だったので、これはリグレッションではなく、パッケージを更新しても変わりません。パイプラインの組み立て方そのものの挙動です。

## ハンドラーが 1 回しか実行されない理由

`AddStandardResilienceHandler` はクライアントの設定項目ではありません。`ResilienceHandler` 型の `DelegatingHandler` がもう 1 つ、`AddHttpMessageHandler` が追加するのと同じ順序付きリストに追加されるだけです。ASP.NET Core のドキュメントはこのルールを 1 行で説明しています。ハンドラーは[「実行したい順序で登録できる」](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware)もので、それぞれが次のハンドラーをラップします。

`ResilienceHandler.SendAsync` の内部では、Polly のパイプラインが `base.SendAsync(request, ...)` を呼ぶコールバックを実行します。これはチェーンの 1 つ下のハンドラーです。リトライ戦略が再試行を決めると、そのコールバックがもう一度呼び出されます。つまり、再実行されるのは `ResilienceHandler` より**下**のハンドラーだけです。それより上にあるものはすでに `base.SendAsync` を 1 回呼んでおり、最終結果を待機しているだけです。

バグの正体はこれだけです。チュートリアルや古いコードでは、横断的なハンドラーを先に登録し、最後にレジリエンスを付け足すことがよくあります。そのほうが自然に読めるからです。

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<SigningHandler>();

builder.Services.AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"))
    .AddHttpMessageHandler<SigningHandler>()   // outermost: runs once
    .AddStandardResilienceHandler();           // retries happen below this line
```

`SigningHandler` がタイムスタンプと HMAC 署名を付与する場合、すべてのリトライは 1 回目の試行用に計算された署名のまま送信されます。有効期間の短いトークンを取得する場合、遅い 503 の後のリトライは、その間に期限切れになったトークンで送信される可能性があります。"sending request" をログに出力する場合、3 回のネットワーク呼び出しに対してログは 1 行しか出ません。

## 計測したハンドラーチェーン

`IHttpMessageHandlerFactory.CreateHandler("c")` を解決し、`InnerHandler` をプライマリハンドラーまでたどりました。プライマリは `503` を 2 回返した後に `200` を返すスタブで、プローブがすぐに終わるようリトライの遅延はゼロに設定しています。`CountingHandler` は受け取ったすべての呼び出しをログに出力します。

`AddStandardResilienceHandler` の**前**に登録した場合:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> CountingHandler -> ResilienceHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #1 X-Attempt=[]
CountingHandler #1 <- 200
```

ネットワークには 3 回リクエストが出ています。ハンドラーは 1 回だけ実行され、最終的な `200` しか見ていません。

`AddStandardResilienceHandler` の**後**に登録した場合:

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
final: 200, primary calls: 3
CountingHandler #2 <- 503
CountingHandler #3 <- 503
CountingHandler #4 <- 200
```

今度は試行ごとに実行され、それぞれの `503` を見ています。ファクトリー自身の `LoggingHttpMessageHandler` の位置に注目してください。常に最も内側、プライマリハンドラーのすぐ上にあります。組み込みの `System.Net.Http.HttpClient.<name>.ClientHandler` ログカテゴリがすでに試行ごとに 1 エントリを出すのに対し、最初に登録したハンドラーは呼び出しごとに 1 エントリしか出さないのはこのためです。ログとハンドラーでリクエスト数が食い違うなら、これが原因です。

## 3 つのステップで修正する

1. ハンドラーごとに、その処理が**論理的な呼び出し**に属するのか**各試行**に属するのかを決めます。署名、トークン取得、試行ごとのログ出力とメトリクスは試行ごとです。冪等キー、リトライをまたいで変わらないようにしたい相関 ID、そして正確に 1 回だけ行う必要があるものは呼び出しごとです。
2. 試行ごとのハンドラーは `AddStandardResilienceHandler()` (または `AddResilienceHandler(...)`) の**後**に、呼び出しごとのハンドラーはその前に登録します。
3. 試行ごとのハンドラーはすべて、同じ `HttpRequestMessage` に対して繰り返し実行しても安全にします。ヘッダーは追加せずに置き換え、リクエストボディが複数回読み取れることを確認します。

支払いの例の登録は次のようになります。

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.10.0
builder.Services.AddTransient<IdempotencyKeyHandler>();
builder.Services.AddTransient<SigningHandler>();

var payments = builder.Services
    .AddHttpClient<PaymentsClient>(c => c.BaseAddress = new("https://payments.example"));

payments.AddHttpMessageHandler<IdempotencyKeyHandler>(); // once per call: same key on every retry
payments.AddStandardResilienceHandler();
payments.AddHttpMessageHandler<SigningHandler>();        // once per attempt: fresh signature
```

`IHttpClientBuilder` は変数に保持してください。`AddStandardResilienceHandler()` はクライアントビルダーではなく `IHttpStandardResiliencePipelineBuilder` を返すため、その後ろに `.AddHttpMessageHandler<T>()` をチェーンすることはできません。試すとビルドが失敗します。

```text
error CS1929: 'IHttpStandardResiliencePipelineBuilder' does not contain a definition for
'AddHttpMessageHandler' and the best extension method overload
'HttpClientBuilderExtensions.AddHttpMessageHandler<SigningHandler>(IHttpClientBuilder)'
requires a receiver of type 'Microsoft.Extensions.DependencyInjection.IHttpClientBuilder'
```

多くのコードがハンドラーを先に登録している本当の理由は、このコンパイラーエラーではないかと考えています。流れるようなチェーンは誤った順序でしかコンパイルできないので、レジリエンスを最後に置いてそのまま先へ進んでしまうのです。同じクライアントに対して 2 回目の `AddHttpClient<PaymentsClient>()` を呼んでも、同じ名前のビルダーが返るので動作しますが、変数を使うほうが順序が目に見えます。

冪等キーは、逆方向に間違えやすいケースです。署名を直すために*すべて*のハンドラーをリトライの内側に移すと、`Idempotency-Key: Guid.NewGuid()` を生成するハンドラーが試行ごとに異なるキーを送るようになり、サーバーはリトライと新しい支払いを区別できなくなります。キーの意味はリトライをまたいで一定であることにあるので、ループの外側に置く必要があります。

## リトライは同じ HttpRequestMessage を再送信する

これには驚きました。レジリエンスハンドラーは試行ごとにリクエストを複製するものだと思っていましたが、標準の (リトライ) ハンドラーでは複製しません。プローブで各試行のリクエストのハッシュコードをログに出したところ、毎回同じオブジェクトでした。`Headers.Add` を使う試行ごとのハンドラーは、次のような結果になります。

```text
chain: ... -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
CountingHandler #5 X-Attempt=[1]
CountingHandler #6 X-Attempt=[1,1]
CountingHandler #7 X-Attempt=[1,1,1]
```

3 回目の試行の時点で、ヘッダーには 3 つの値が入っています。署名ヘッダーであれば、サーバーは `X-Signature: abc, def, ghi` を受け取って拒否します。`ResilienceHandler` のコードでも確認できます。パイプラインのコールバックは `GetRequestMessage(context, state.request)` を呼び、外側の戦略がコンテキストに別のリクエストを設定していない限り、元のリクエストを返します。それを行うのはヘッジングだけです。

修正方法は、ヘッダーを「設定」のセマンティクスで書き込むことです。`Authorization` は単一値の型付きプロパティなので、代入すれば古い値が置き換わります。カスタムヘッダーの場合は、先に削除します。

```csharp
// .NET 10, C# 14
public sealed class SigningHandler(ISigner signer, TimeProvider clock) : DelegatingHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var timestamp = clock.GetUtcNow().ToUnixTimeSeconds().ToString();

        request.Headers.Remove("X-Timestamp");
        request.Headers.Remove("X-Signature");
        request.Headers.Add("X-Timestamp", timestamp);
        request.Headers.Add("X-Signature", await signer.SignAsync(request, timestamp, cancellationToken));

        return await base.SendAsync(request, cancellationToken);
    }
}
```

`Remove` の後に `Add` を行うと、プローブの結果は 3 回の試行で `X-Attempt=[1]`、`[2]`、`[3]` となりました。値は 1 つだけで、毎回更新されています。トークンハンドラーも同様で、`request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);` はもともと繰り返しても安全です。

## リクエストボディは再送可能でなければならない

同じ `HttpRequestMessage` が再び送信されるので、同じ `HttpContent` も再び送信されます。`StringContent`、`ByteArrayContent`、`JsonContent`、`FormUrlEncodedContent` はメモリに裏付けられており、何度でもシリアル化できます。プローブのプライマリハンドラーは `SocketsHttpHandler` と同じく `CopyToAsync` でボディをコピーしましたが、`StringContent` の POST は 3 回の試行すべてで欠けることなく届きました。

シークできないストリーム (ネットワークストリーム、パイプ、転送中のアップロード) の上の `StreamContent` は耐えられません。

```text
primary #1 body='{"a":1}'
primary #2 InvalidOperationException: The stream was already consumed. It cannot be read again.
```

`InvalidOperationException` は標準のリトライが一時的なものとして扱う例外に含まれないため、呼び出しはリトライされずに 2 回目の試行でこの例外とともに失敗します。シーク可能なストリームであれば、`StreamContent` が送信のたびに開始位置へ巻き戻すので動作します。

選択肢は 3 つあります。

```csharp
// .NET 10, C# 14
// Option 1: buffer it (fine for small bodies)
var content = new StreamContent(uploadStream);
await content.LoadIntoBufferAsync(cancellationToken);   // probe: all 3 attempts sent the full body

// Option 2: copy to a seekable stream first
var ms = new MemoryStream();
await uploadStream.CopyToAsync(ms, cancellationToken);
ms.Position = 0;
var seekable = new StreamContent(ms);

// Option 3: do not retry this request at all
builder.Services.AddHttpClient("uploads")
    .AddStandardResilienceHandler()
    .Configure(o => o.Retry.DisableForUnsafeHttpMethods());
```

大きなアップロードでは、たいてい選択肢 3 が誠実な答えです。リトライ可能にするために 500 MB のボディをメモリにバッファリングするのは、エラーを表面化させるよりも悪い失敗モードです。`DisableForUnsafeHttpMethods` は、標準ハンドラーが `POST`、`PUT`、`PATCH`、`DELETE` 全般をリトライしないようにもするので、冪等でないエンドポイントではいずれにしても望ましいことが多いはずです。

## Aspire と ConfigureHttpClientDefaults ではハンドラーはすでに内側にある

プロジェクトで .NET Aspire の `ServiceDefaults` を使っているなら、このバグはそもそも起きていないかもしれません。`AddServiceDefaults()` は `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())` を呼び、既定のアクションは名前付きクライアントや型指定クライアント自身の構成より常に先に実行されます。`ConfigureHttpClientDefaults` でレジリエンスハンドラーを、名前付きクライアントに `CountingHandler` を登録してみました。

```text
chain: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
       -> ResilienceHandler -> CountingHandler
       -> LoggingHttpMessageHandler -> StubPrimary
CountingHandler #8 <- 503
CountingHandler #9 <- 503
CountingHandler #10 <- 200
```

`Program.cs` 内の `AddServiceDefaults()` と `AddHttpClient(...)` の順序に関係なく、クライアントごとのハンドラーはすべてリトライの内側に入ります。署名やトークンにとっては正しい既定値ですが、冪等キーにとっては誤った既定値です。Aspire アプリで呼び出しごとのハンドラーが必要な場合は、そのクライアントの既定のレジリエンスハンドラーを削除し、自分のハンドラーの後に再追加する必要があります。その方法は[Aspire が登録する既定のレジリエンスハンドラーをオーバーライドする方法](/ja/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/)で解説しています。`AddStandardResilienceHandler()` をもう 1 回追加しても最初のものは置き換わらず、積み重なるだけです。

## ヘッジングは挙動が異なる

`AddStandardHedgingHandler()` は「同じリクエストオブジェクト」ルールの例外です。ヘッジングでは複数の試行が同時に進行しうるため、元のリクエストのスナップショットを取り、試行ごとに複製を送信します。チェーンには `ResilienceHandler` のインスタンスも 2 つ含まれ、1 つはヘッジングパイプライン用、もう 1 つはエンドポイントごとの戦略用です。

```text
chain: ... -> ResilienceHandler -> ResilienceHandler -> HeaderHandler -> CountingHandler -> ...
final: 503, primary calls: 2
CountingHandler #16 req@9c43c1 X-Attempt=[1]
CountingHandler #17 req@17e61ce X-Attempt=[1]
```

ハンドラーが `Headers.Add` 版であっても、2 つの異なるリクエストオブジェクトにそれぞれヘッダー値がちょうど 1 つずつ入っています。ヘッジングハンドラーの後に登録したハンドラーも、試行ごとに実行されます。ただし、この複製に依存してはいけません。ヘッジングの下でしか正しく動かないコードは、誰かが標準ハンドラーに戻した日に壊れます。

## ハンドラーを内側に移すと変わるその他の点

ハンドラーをレジリエンスハンドラーの下に移すと、**試行タイムアウト** (既定で 10 秒) の対象になり、**サーキットブレーカー**の視野にも入ります。影響は 3 つあります。

- ハンドラー内の遅い処理は各試行の時間を消費します。8 秒かかるトークンエンドポイントでは、試行がタイムアウトするまでに実際のリクエストに使えるのは 2 秒だけです。トークンはキャッシュし、リクエストの経路上ではなく期限切れの前に更新してください。
- ハンドラーがスローした例外は、リトライとサーキットブレーカーが評価する結果になります。ハンドラーがスローした `HttpRequestException` はリトライされ、ブレーカーにとっては失敗として数えられます。構成の欠落のように、リトライでは直らない失敗については、一時的でない例外をスローする (またはレスポンスを返す) ようにしてください。
- 処理をショートサーキットして独自の `HttpResponseMessage` を返すハンドラー (キャッシュヒットなど) も、リトライの `ShouldHandle` の対象になります。ループの内側から合成した `503` を返すと、本物と同じようにリトライされます。

`AddHttpMessageHandler<T>()` で登録する `DelegatingHandler` のインスタンスは transient でなければならず、これは変わりません。ファクトリーはハンドラーの有効期間 (既定で 2 分) ごとに 1 つのチェーンを作成してリクエスト間で再利用するので、リクエストごとの状態はハンドラーのフィールドではなく `HttpRequestMessage` (`request.Options`) に置きます。

## 自分のチェーンを検証する方法

登録コードを信用せず、構築されたチェーンを確認してください。次のテストはどのクライアントにも使えます。

```csharp
// .NET 10, xUnit v3, Microsoft.Extensions.Http.Resilience 10.10.0
[Fact]
public void SigningHandler_runs_inside_the_retry()
{
    var services = new ServiceCollection();
    services.AddTransient<SigningHandler>();
    services.AddSingleton<ISigner, FakeSigner>();
    services.AddSingleton(TimeProvider.System);
    var payments = services.AddHttpClient("payments");
    payments.AddStandardResilienceHandler();
    payments.AddHttpMessageHandler<SigningHandler>();

    using var sp = services.BuildServiceProvider();
    var handler = sp.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler("payments");

    var names = new List<string>();
    for (HttpMessageHandler? h = handler; h is not null; h = (h as DelegatingHandler)?.InnerHandler)
        names.Add(h.GetType().Name);

    Assert.True(names.IndexOf(nameof(ResilienceHandler)) < names.IndexOf(nameof(SigningHandler)));
}
```

振る舞いのテストとしては、[HttpClient を使うコードのユニットテスト](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)と同じ手法で、プライマリハンドラーを決まった回数だけ失敗するスタブに差し替え、ハンドラーの呼び出し回数が試行回数と等しいことをアサートします。

## 関連記事

- [.NET 11 における Polly とレジリエンスハンドラーの比較](/ja/2026/05/polly-vs-resilience-handlers-in-dotnet-11/)では、`AddStandardResilienceHandler` 内の 5 つの戦略とその順序を説明しています。
- [Aspire が登録する既定のレジリエンスハンドラーをオーバーライドする方法](/ja/2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers/)では、クライアントごとにハンドラーを削除して再追加する方法を扱っています。
- [HttpClient、HttpClientFactory、Refit の比較](/ja/2026/05/httpclient-vs-httpclientfactory-vs-refit/)では、ファクトリーが `DelegatingHandler` のパイプラインをどう組み立てるかを解説しています。
- [HttpClient の TaskCanceledException: A task was canceled を修正する](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)は、呼び出しを失敗させているのがハンドラーではなく試行タイムアウトである場合に役立ちます。
- [Polly 8.8 は独自の IOptionsMonitor からレジリエンスパイプラインを再読み込みする](/ja/2026/09/polly-8-8-reloads-a-resilience-pipeline-from-your-own-ioptionsmonitor/)は、実行時にリトライ設定を調整する場合に参考になります。

## 出典

- [送信 HTTP 要求を行う: 送信要求ミドルウェア](https://learn.microsoft.com/aspnet/core/fundamentals/http-requests#outgoing-request-middleware)、Microsoft Learn
- [回復性のある HTTP アプリを構築する: 主要な開発パターン](https://learn.microsoft.com/dotnet/core/resilience/http-resilience)、Microsoft Learn
- dotnet/extensions の [`ResilienceHandler.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHandler.cs)
- [NuGet の `Microsoft.Extensions.Http.Resilience`](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience)、バージョン 10.10.0 と 8.10.0 でテスト
- [`HttpContent.LoadIntoBufferAsync`](https://learn.microsoft.com/dotnet/api/system.net.http.httpcontent.loadintobufferasync)、Microsoft Learn
