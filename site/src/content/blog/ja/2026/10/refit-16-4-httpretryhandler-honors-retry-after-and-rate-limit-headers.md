---
title: "Refit 16.4 が HttpRetryHandler を搭載、GitHub、Azure、AWS のレート制限ヘッダーも読み取ります"
description: "Refit 16.4.0 では、べき等なリクエストをリトライするオプトインの HttpRetryHandler が追加されました。Retry-After や x-ratelimit-reset、x-ms-retry-after-ms といったプロバイダー固有のヘッダーを尊重し、Polly やレジリエンスパッケージは不要です。"
pubDate: 2026-10-18
tags:
  - "dotnet"
  - "refit"
  - "httpclient"
  - "resilience"
lang: "ja"
translationOf: "2026/10/refit-16-4-httpretryhandler-honors-retry-after-and-rate-limit-headers"
translatedBy: "claude"
translationDate: 2026-10-18
---

[Refit 16.4.0](https://github.com/reactiveui/refit/releases/tag/v16.4.0) は 2026-10-17 にリリースされました。目玉機能は、コアの `Refit` パッケージに含まれるリトライハンドラーです。`HttpRetryHandler` は通常の `DelegatingHandler` なので、Polly や `Microsoft.Extensions.Http.Resilience` を導入しなくても、Refit クライアントにも普通の `HttpClient` にも使えます。

これは単なる指数バックオフのループではありません。興味深いのは、待機時間の決め方です。

## サーバーのヒントがバックオフより優先される

既定では、ハンドラーは最初の送信の後に 3 回までリトライしますが、対象は `GET`、`HEAD`、`OPTIONS`、`TRACE` だけです。リトライするのは HTTP 408、429、500、502、503、504 と `HttpRequestException` です。403 は、構成された遅延リーダーが有効なタイミングのヒントを見つけた場合にのみリトライされます。これはまさに、GitHub がプライマリのレート制限の枯渇を通知する方法です。

遅延は `DelayProvider` から取得されます。既定では標準の `Retry-After` ヘッダーを読み取り、`RetryDelayProviders` にはプロバイダー固有のリーダーが 4 つ用意されています。

- `Azure`: `x-ms-retry-after-ms`、次に `retry-after-ms`、次に `Retry-After`。
- `Aws`: ミリ秒単位の `x-amz-retry-after`、次に `Retry-After`。
- `GitHub`: `Retry-After`、または 403 か 429 で残りのクォータがゼロの場合は `x-ratelimit-reset` (Unix 秒)。
- `Jira`: `Retry-After`、または 429 の場合は ISO 8601 形式の `X-RateLimit-Reset`。

有効なヒントがない場合は、1 秒から始まり 30 秒を上限とする、フルジッター付きの指数バックオフにフォールバックします。ジッターがサーバーのヒントを短くすることはなく、ヒントが `MaxDelay` を超える場合、ハンドラーは早すぎるリトライをせずにレスポンスをそのまま返します。

## Refit クライアントへの組み込み

`Refit.HttpClientFactory` を使う場合、ハンドラーは他のメッセージハンドラーと同じようにチェーンに追加します。

```csharp
using Refit;

services.AddRefitGeneratedClient<IGitHubApi>()
    .ConfigureHttpClient(static client =>
        client.BaseAddress = new Uri("https://api.github.com"))
    .AddHttpMessageHandler(static () => new HttpRetryHandler(new HttpRetryOptions
    {
        MaxRetries = 3,
        DelayProvider = RetryDelayProviders.GitHub,
        MaxDelay = TimeSpan.FromMinutes(2),
    }));
```

上の例のように、ファクトリのラムダからは毎回新しいハンドラーを返してください。ハンドラーのインスタンスは 1 つのパイプラインに属します。

API が別のヘッダーを使っている場合は、`RetryDelayProviders.ReadHeader` が秒、ミリ秒、Unix タイムスタンプ、日付を解析してくれます。

```csharp
var options = new HttpRetryOptions
{
    DelayProvider = static (response, now, ct) =>
        RetryDelayProviders.ReadHeader(
            response, "X-Throttle-Reset", RetryHeaderFormat.UnixTimeSeconds, now, ct),
};
```

## 安全装置

`POST`、`PUT`、`PATCH`、`DELETE` は、`RetryUnsafeMethods = true` を設定しない限りリトライされません。この設定は、べき等キーを受け付けるエンドポイントに対してだけ使うべきです。各試行はヘッダーとオプションをコピーした新しい `HttpRequestMessage` になります。ボディは一度だけバッファリングされ、既定の上限は 1 MiB (`MaxRequestContentBufferSize`) です。そのため、上限のないストリーミングアップロードには向きません。

順序に関する詳細が 2 つ重要です。リトライハンドラーの内側に配置した認証ハンドラーは試行のたびに実行されます。トークンを更新したい場合にはこれが望ましい動作です。また、`HttpClient.Timeout` はリトライ間の待機を含む呼び出し全体に適用されるため、既定の 100 秒のタイムアウトが GitHub の 2 分間のリセット期間を途中で打ち切ってしまう可能性があります。

これを `AddStandardResilienceHandler` の上に重ねないでください。リトライの層は 1 つに絞りましょう。すでに Microsoft のレジリエンスパイプラインを使っているなら、それを使い続けてください。レート制限のある API に対して行儀よく振る舞うだけでよい小さな Refit クライアントなら、今では 2 行の変更で済みます。

テスト向けには、`Refit.Testing` に `RetryReply.After`、`RetryReply.Header`、`StubHttp.CreateRetryHandler` が追加されました。いずれも `TimeProvider` で駆動されるため、スリープせずに待機時間をアサートできます。

このリリースでは `[Query(Name = "client_id")]` と `[Url(AllowRelative = true)]` も追加され、大文字と小文字だけが異なるルートパラメーターとクエリパラメーターの問題も修正されています。[16.1 で PagedEnumerable によるページングループの生成が始まった](/ja/2026/09/refit-16-1-generates-the-paging-loop-with-pagedenumerable/) とき以来、最大の Refit リリースです。
