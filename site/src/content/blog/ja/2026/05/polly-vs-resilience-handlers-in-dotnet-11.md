---
title: ".NET 11 における Polly と resilience handler の比較: どちらを使うべきか?"
description: "HttpClient の呼び出しには Microsoft.Extensions.Http.Resilience の resilience handler を使ってください。これは HTTP を理解したデフォルト値とテレメトリを 1 行で備えた Polly そのものだからです。HttpClient ではないものを保護する場合にのみ、Polly の ResiliencePipeline を直接使ってください。"
pubDate: 2026-05-24
tags:
  - "comparison"
  - "polly"
  - "resilience"
  - "httpclient"
  - "dotnet"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/polly-vs-resilience-handlers-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-24
---

「Polly と resilience handler」という枠組みはわずかに誤っており、なぜそうなのかに気づくことが答えそのものです。resilience handler、すなわち `Microsoft.Extensions.Http.Resilience` パッケージの `AddStandardResilienceHandler` は、Polly の代替ではありません。それは Polly であり、HTTP を理解し DI に親和的なレイヤーで包まれ、`IHttpClientFactory` に直接組み込まれます。したがって本当の問いは「どのライブラリか」ではなく「どのレイヤーでレジリエンスを構成するか」です。2026 年の新しい .NET 11 のコードでは、保護したい対象が `HttpClient` の呼び出しであれば、resilience handler を使ってください。なぜなら、HTTP を理解したデフォルト値、テレメトリ、構成バインディングを備えた Polly の各ストラテジを 1 行で提供してくれるからです。Polly の `ResiliencePipeline` API を直接使うのは、操作が `HttpClient` のリクエストでない場合だけにしてください。たとえばデータベースのクエリ、メッセージブローカーへの発行、手動で呼び出す gRPC 呼び出し、あるいは任意のデリゲートです。

ここでのすべての例は、.NET 11 SDK と C# 14 で `<TargetFramework>net11.0</TargetFramework>` を対象としています。「Polly」は Polly v8(NuGet 上の `Polly.Core` パッケージ、8.6.6)を指し、その `ResiliencePipeline` API は古い `Policy` 型を置き換えました。「resilience handler」は `Microsoft.Extensions.Http.Resilience` 10.6.0 を指し、これは `Microsoft.Extensions.Resilience` と Polly に依存します。両者は、二つの高さから見た同じエンジンです。

## 機能マトリクスを一目で

これがあなたが見に来た表です。列は実際にレジリエンスを組み込む二つの方法であり、行はどちらを選ぶかを変える判断です。

| 観点 | Polly `ResiliencePipeline` | resilience handler (`Microsoft.Extensions.Http.Resilience`) |
| ------- | ------------------------- | ---------------------------------------------------------- |
| 何を包むか | 任意のデリゲートまたは操作 | `HttpClient` のリクエストのみ |
| 何の上に構築されるか | `Polly.Core`(エンジン) | `Polly.Core`(ラップしたもの) |
| どう実行されるか | `pipeline.ExecuteAsync(...)` を明示的に呼び出す | 透過的に、`HttpMessageHandler` のパイプライン内で |
| HTTP を理解したデフォルト値(5xx, 408, 429) | `ShouldHandle` を自分で書く | 組み込み |
| まともなデフォルトパイプラインを 1 行で | いいえ、自分で組み立てる | はい、`AddStandardResilienceHandler()` |
| テレメトリ(メトリクス + トレース) | `Microsoft.Extensions.Resilience` 経由または手動 | 組み込み |
| 構成バインディング + ホットリロード | 手動 | 第一級(`EnableReloads`) |
| DI との統合 | `ResiliencePipelineRegistry<TKey>` | `IHttpClientBuilder` |
| NuGet パッケージ | `Polly.Core` 8.6.6 | `Microsoft.Extensions.Http.Resilience` 10.6.0 |
| 最適な用途 | DB 呼び出し、キュー、gRPC、任意のコード | 名前付きまたは型付きの `HttpClient` 呼び出し |

この表のパターンは、resilience handler が左側のエンジンを継承し、その上に HTTP の知識、テレメトリ、DI 配線を加えた右側の列であるということです。右へ移る代償は汎用性を手放すことです。handler は `HttpClient` に対してのみ実行されます。

## resilience handler が制服を着た Polly にすぎない理由

`AddStandardResilienceHandler` を呼び出すと、パッケージは Polly の `ResiliencePipeline<HttpResponseMessage>` を構築し、それをそのクライアント向けに `IHttpClientFactory` が組み立てるメッセージハンドラーのパイプラインの中に `DelegatingHandler` としてインストールします。すべてのリトライ、すべての circuit breaker の作動、すべてのタイムアウトは `Polly.Core` によって実行されます。.NET に第二のレジリエンスエンジンは存在しません。Microsoft はリトライを再実装したのではなく、Polly v8 を取り、それに HTTP 向けに調整されたデフォルト値を与え、オプションシステムに配線し、その周囲に OpenTelemetry 互換のメトリクスとトレースを発行したのです。

だからこそ「Polly を使うべきか resilience handler を使うべきか」は、HTTP コードにとってはカテゴリの取り違えです。handler を使うことは Polly を使うことです。判断は、HTTP の形をした利便レイヤーが欲しいのか、それとも操作が HTTP でないために生のエンジンが必要なのか、ということです。

## resilience handler が正しい選択となるとき

`IHttpClientFactory` 経由で解決される `HttpClient` の上に乗るレジリエンスであれば、handler が勝ちます。標準の handler は型付きクライアントの上のたった 1 行です。

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using Microsoft.Extensions.DependencyInjection;

builder.Services.AddHttpClient<GitHubService>(client =>
{
    client.BaseAddress = new Uri("https://api.github.com");
    client.DefaultRequestHeaders.UserAgent.ParseAdd("start-debugging");
})
.AddStandardResilienceHandler(); // rate limiter, total timeout, retry, breaker, attempt timeout
```

この 1 回の呼び出しが、HTTP を理解したデフォルト値で五つのストラテジを積み重ねます。HTTP 500 以上、408、429 が一時的であること、`HttpRequestException` と Polly の `TimeoutRejectedException` をリトライすべきこと、そして `Retry-After` ヘッダーを尊重すべきことを、すでに知っています。これらのどれについても `ShouldHandle` 述語を書いていません。これはクライアントに Polly のポリシーを手作業で配線することの現代的な代替であり、ほぼすべてのサーバーサイド HTTP コードにとって正しいデフォルトです。

デフォルト値がぴったりでないとき、生の Polly まで降りる必要はありません。handler のレイヤーにとどまってカスタマイズします。なぜなら handler は HTTP 専用のオプション型を通じて同じ Polly のオプションを公開するからです。`AddResilienceHandler` を使って、名前付きの完全にカスタムなパイプラインを構築します。

```csharp
// .NET 11, C# 14, Microsoft.Extensions.Http.Resilience 10.6.0
using System.Net;
using Microsoft.Extensions.Http.Resilience;
using Polly;

httpClientBuilder.AddResilienceHandler("CustomPipeline", static builder =>
{
    builder.AddRetry(new HttpRetryStrategyOptions
    {
        BackoffType = DelayBackoffType.Exponential,
        MaxRetryAttempts = 5,
        UseJitter = true
    });

    builder.AddCircuitBreaker(new HttpCircuitBreakerStrategyOptions
    {
        SamplingDuration = TimeSpan.FromSeconds(10),
        FailureRatio = 0.2,
        MinimumThroughput = 3,
        ShouldHandle = static args => ValueTask.FromResult(args is
        {
            Outcome.Result.StatusCode:
                HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests
        })
    });

    builder.AddTimeout(TimeSpan.FromSeconds(5));
});
```

型に注目してください。`HttpRetryStrategyOptions` と `HttpCircuitBreakerStrategyOptions` です。これらは Polly の `RetryStrategyOptions<T>` と `CircuitBreakerStrategyOptions<T>` の HTTP 風味版であり、HTTP にのみ意味のある `DisableForUnsafeHttpMethods()` のような利便機能を備えています。あなたは依然として Polly の中におり、ただ `HttpResponseMessage` を理解する Polly の部分にいるだけです。

handler は構成にもバインドし、実行時にリロードします。`HttpStandardResilienceOptions` を `appsettings.json` のセクションにバインドし、`ResilienceHandlerContext` を公開する `AddResilienceHandler` のオーバーロードの中で `EnableReloads` を呼び出すと、JSON を変更するだけで再起動なしに稼働中のパイプラインを再調整できます。この配管を生の Polly に対して手作業で書くのは無料ではなく、handler はそれをあなたに与えてくれます。

## 標準 handler が実際に構成するもの

読者がこの比較にたどり着くのは、信頼する前に `AddStandardResilienceHandler` が何をするのかを知りたいからです。デフォルト構成は、最も外側から最も内側へと五つのストラテジを連結します。以下の数値は .NET 11 / `Microsoft.Extensions.Http.Resilience` 10.6.0 のデフォルト値です。

| 順序 | ストラテジ | デフォルト |
| ----- | -------- | ------- |
| 1 | rate limiter | Permit: `1_000`, Queue: `0` |
| 2 | リクエスト全体のタイムアウト | 全試行を通じて 30s |
| 3 | retry | 最大リトライ回数: `3`、指数バックオフ、jitter 有効、基準遅延 2s |
| 4 | circuit breaker | 失敗率: 10%、最小スループット: `100`、サンプリング 30s、遮断 5s |
| 5 | 試行ごとのタイムアウト | 個々の試行ごとに 10s |

順序は重要です。全体タイムアウト(30s)はリトライの外側に位置するため、それぞれが 10s の試行ごとタイムアウトに達する 3 回のリトライが永遠に走ることはありません。操作全体は 30s で頭打ちになります。circuit breaker はリトライの内側に位置するため、個々の試行の失敗を数えます。そして 30s 以内にサンプリングされた少なくとも 100 件の呼び出しのうち 10% が失敗すると、5s 間オープンになり、その下のすべてを短絡します。デフォルト値について一つだけ覚えるなら、リトライは回数だけでなく 30s の実時間によって制限される、ということです。

## Polly を直接使うとき

保護対象が `HttpClient` の呼び出しでなくなった瞬間に、handler は選択肢ではなくなります。データベースのクエリ、`ServiceBusSender.SendMessageAsync`、Redis の呼び出し、あるいは時折例外をスローするビジネスロジックのブロックに対する `AddStandardResilienceHandler` は存在しません。それらに対しては、Polly の `ResiliencePipeline` を構築し、明示的に呼び出します。

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - resilience around a non-HTTP operation
using Polly;
using Polly.Retry;

ResiliencePipeline pipeline = new ResiliencePipelineBuilder()
    .AddRetry(new RetryStrategyOptions
    {
        MaxRetryAttempts = 3,
        BackoffType = DelayBackoffType.Exponential,
        UseJitter = true,
        // Only retry the transient failures this dependency actually throws
        ShouldHandle = new PredicateBuilder().Handle<TimeoutException>()
    })
    .AddTimeout(TimeSpan.FromSeconds(5))
    .Build();

await pipeline.ExecuteAsync(
    async token => await SaveOrderAsync(order, token),
    cancellationToken);
```

形は handler の中で見たのと同じエンジンです。`AddRetry`、`AddTimeout`、`AddCircuitBreaker`、同じ `DelayBackoffType` と `ShouldHandle`。変わるのは、`ExecuteAsync` を自分で呼び出すこと、何を一時的失敗とみなすかを自分で選ぶこと(ここでは検査すべき HTTP ステータスコードがないため `TimeoutException`)、そしてパイプラインが文字どおり任意のデリゲートを包めることです。

型付きの結果には、ジェネリックの builder を使い、パイプラインが例外だけでなく戻り値についても判断できるようにします。

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - a pipeline that inspects the result
using Polly;

ResiliencePipeline<DbResult> pipeline = new ResiliencePipelineBuilder<DbResult>()
    .AddRetry(new()
    {
        MaxRetryAttempts = 3,
        ShouldHandle = static args => ValueTask.FromResult(
            args.Outcome.Result is { Status: DbStatus.Throttled })
    })
    .Build();

DbResult result = await pipeline.ExecuteAsync(
    async token => await QueryAsync(token),
    cancellationToken);
```

DI アプリケーションでは、呼び出し箇所でパイプラインを new しません。`AddResiliencePipeline` で一度登録すると、それらは `ResiliencePipelineRegistry<TKey>` に収まり、どこからでも `ResiliencePipelineProvider<TKey>` を通じて解決できます。

```csharp
// .NET 11, C# 14, Polly.Core 8.6.6 - register once, resolve anywhere
using Microsoft.Extensions.DependencyInjection;
using Polly;
using Polly.Registry;

builder.Services.AddResiliencePipeline("db-writes", static b =>
{
    b.AddRetry(new()).AddTimeout(TimeSpan.FromSeconds(5));
});

// elsewhere, injected ResiliencePipelineProvider<string> provider
ResiliencePipeline pipeline = provider.GetPipeline("db-writes");
await pipeline.ExecuteAsync(static async ct => await DoWorkAsync(ct), ct);
```

さらに `Microsoft.Extensions.Resilience` を取り込めば、これら登録済みのパイプラインは HTTP handler が享受するのと同じテレメトリの扱いを受けるので、HTTP でないパイプラインでもメトリクスとトレースを発行できます。これが HTTP でないコードにとって「handler の体験」に最も近いものであり、送信 HTTP ではなくデータ層やメッセージング層の周りにレジリエンスが欲しいときの正しいツールです。

## 一方が他方より速いのか?

いいえ。そしてこの問い自体が誤解を露呈しています。resilience handler は内部で Polly の `ResiliencePipeline` を実行するため、「handler」と「生の Polly」の呼び出しごとのオーバーヘッドは、同じストラテジを実行する同じエンジンです。パイプラインを手作業で組み立てて回避できる Polly 税もなければ、利便性のために支払う handler 税もありません。Polly v8 は v7 に対してアロケーションを削減するために特別に書き直されており、両方のエントリポイントはその書き直しの上に乗っています。

異なるのはスループットではなく、実行の周囲で得られるものです。handler はテレメトリ、構成バインディング、`IHttpClientFactory` のライフタイム保証を無償で追加しますが、生のパイプラインはそれらを配線したときにのみ与えてくれます。自分のワークロードでの実際の数値が欲しければ、パイプラインの有無で自分のデリゲートに対して BenchmarkDotNet を実行してください。性能を基準にこの二つを選ばないでください。性能は両者を分ける軸ではないからです。

## あなたの代わりに決めてくれる要点

いくつかの固い制約が、好みが入り込む前に選択を決着させます。

**handler は `IHttpClientFactory` 経由の `HttpClient` でのみ機能します。** コードが `AddHttpClient` と注入されたクライアントを経由していなければ、追加できる handler はありません。静的なシングルトン `HttpClient`、`DbContext`、Kafka のプロデューサー、これらのいずれも resilience handler を受け取れません。これらは Polly のパイプラインを取るか、何も取らないかです。この一つの事実がほとんどの実際のケースを決めます。

**resilience handler を積み重ねないでください。** Microsoft のガイダンスは明確です。クライアントごとに resilience handler はちょうど一つ追加してください。別の形が必要なら、まず `RemoveAllResilienceHandlers()` を呼び出してから自分のカスタムのものを追加します。標準 handler とカスタム handler を積み重ねると、二つの完全なパイプラインが入れ子になり、誰も意図しない形で乗算されるリトライ回数とタイムアウトを生みます。

**冪等でない動詞でのリトライはデータを重複させます。** 標準 handler はデフォルトであらゆる HTTP メソッドをリトライします。すでにサーバーに到達した `POST` をリトライすると、同じレコードを二度挿入する可能性があります。`POST`、`PATCH`、`PUT`、`DELETE`、`CONNECT` のリトライをスキップするには `options.Retry.DisableForUnsafeHttpMethods()` を、特定のリストには `DisableFor(HttpMethod.Post, ...)` を呼び出してください。これは handler レイヤーの関心事であり、生の Polly は HTTP の動詞が何かを知らないため助けられません。

**Polly は `TimeoutException` ではなく `TimeoutRejectedException` をスローします。** リトライに `ShouldHandle` 述語を書いてタイムアウトストラテジの失敗を捕まえるつもりなら、それは Polly の `TimeoutRejectedException` として現れることを覚えておいてください。これを誤って扱うことは、リトライを期待した場所に浮上してくる [タスクがキャンセルされたという TaskCanceledException](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) の頻出原因です。

## 結論を 1 行で

2026 年の新しい .NET 11 のコードでは、`IHttpClientFactory` 経由で解決される `HttpClient` にレジリエンスを追加するなら、resilience handler を使ってください。`AddStandardResilienceHandler` は、HTTP を理解したデフォルト値、テレメトリ、構成バインディングを 1 行で備えた Polly であり、`AddResilienceHandler` はそのレイヤーを離れずにカスタマイズさせてくれます。Polly の `ResiliencePipeline` API を直接使うのは、操作が `HttpClient` の呼び出しでない場合だけにしてください。データベースアクセス、メッセージブローカー、手で呼び出す gRPC、あるいは任意のデリゲートです。あなたは二つのレジリエンスライブラリのあいだで選んでいるのでは決してありません。なぜなら一つしかないからです。あなたが選んでいるのは、Polly を HTTP の形をしたドアから使うか、汎用のドアから使うかであり、保護する操作の種類があなたの代わりにドアを選びます。

## 関連

- [.NET 11 における HttpClient と HttpClientFactory と Refit の比較: どれを使うべきか?](/ja/2026/05/httpclient-vs-httpclientfactory-vs-refit/)
- [修正: HttpClient で TaskCanceledException、タスクがキャンセルされました](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [C# で長時間実行される Task をデッドロックなしにキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [.NET 11 と無料のバックエンドで OpenTelemetry を使う方法](/ja/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/)
- [HttpClient を使うコードの単体テストの書き方](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## 出典

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) - `AddStandardResilienceHandler`、`AddResilienceHandler`、標準パイプラインのデフォルト値、一時的な結果のリスト。
- [Introduction to resilient app development](https://learn.microsoft.com/en-us/dotnet/core/resilience/) - `Microsoft.Extensions.Resilience` がどのように Polly の上に構築され、テレメトリを加えるか。
- [Polly docs: Resilience pipelines](https://www.pollydocs.org/pipelines/) - `ResiliencePipelineBuilder`、`ExecuteAsync`、registry。
- [Polly docs: Advanced dependency injection](https://www.pollydocs.org/advanced/dependency-injection/) - `AddResiliencePipeline`、`ResiliencePipelineRegistry`、動的リロード。
- [Polly v7 to v8 migration guide](https://www.pollydocs.org/migration-v8.html) - なぜ `Policy` API が `ResiliencePipeline` に置き換えられたか。
- [Microsoft.Extensions.Http.Resilience on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Http.Resilience) - パッケージの現在のバージョンと依存関係。
</content>
