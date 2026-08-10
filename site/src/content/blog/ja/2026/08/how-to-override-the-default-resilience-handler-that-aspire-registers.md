---
title: "Aspire が登録する既定のレジリエンスハンドラーを上書きする方法"
description: "Aspire の AddServiceDefaults はすべての HttpClient に標準レジリエンスハンドラーを適用します。AddStandardResilienceHandler をもう一度呼んでも置き換えにはならず、2 つ目のハンドラーが積み重なります。実際に上書きする 3 つの方法、どこにも書かれていないオプション名 -standard、そして単に削除しただけで引き継いでしまう無限タイムアウトを解説します。"
pubDate: 2026-08-10
template: how-to
tags:
  - "aspire"
  - "dotnet"
  - "dotnet-11"
  - "httpclient"
  - "resilience"
  - "polly"
  - "how-to"
lang: "ja"
translationOf: "2026/08/how-to-override-the-default-resilience-handler-that-aspire-registers"
translatedBy: "claude"
translationDate: 2026-08-10
---

Aspire の `AddServiceDefaults()` は `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())` を呼び出し、プロセス内のすべての `HttpClient` の前にリトライ、サーキットブレーカー、レートリミッター、そして 30 秒の総リクエストタイムアウトを配置します。特定のクライアントに対して `AddStandardResilienceHandler()` をもう一度呼んでも、それは置き換えにはなりません。1 つ目のハンドラーの上に 2 つ目が積み重なるため、論理的には 1 回のリクエストが物理的には 16 回になり得ます。既定値を本当に上書きする方法はちょうど 3 つです。自分の管理下にあるなら `ServiceDefaults/Extensions.cs` を編集する、対象の `IHttpClientBuilder` に対して自前のハンドラーを追加する前に `RemoveAllResilienceHandlers()` を呼ぶ、あるいは既定のハンドラーが読み取る名前付きオプションのインスタンスを設定し直す、という 3 つです。最後の名前は文字どおり `-standard` です。

以下の挙動はすべて、ドキュメントを読んだのではなく実際に実行して確認しました。検証コードは SDK 10.0.201 の `net10.0` を対象とし、`Microsoft.Extensions.Http.Resilience` 10.8.0 を使用しています。これは Aspire 13.4.6 の ServiceDefaults テンプレートが取り込むパッケージそのものです。レジリエンスの挙動は Aspire 本体ではなくこのパッケージ側にあるため、`ConfigureHttpClientDefaults` を使う `IHttpClientFactory` アプリならどれでも同じルールが当てはまります。

## AddServiceDefaults が HttpClient の前に実際に置くもの

生成される `ServiceDefaults/Extensions.cs` には次のコードが含まれます。

```csharp
// Aspire 13.4.6 ServiceDefaults template
public static TBuilder AddServiceDefaults<TBuilder>(this TBuilder builder)
    where TBuilder : IHostApplicationBuilder
{
    builder.ConfigureOpenTelemetry();
    builder.AddDefaultHealthChecks();
    builder.Services.AddServiceDiscovery();

    builder.Services.ConfigureHttpClientDefaults(http =>
    {
        // Turn on resilience by default
        http.AddStandardResilienceHandler();

        // Turn on service discovery by default
        http.AddServiceDiscovery();
    });

    return builder;
}
```

`AddStandardResilienceHandler()` は Polly v8 の 5 つの戦略を外側から順に組み立てます。レートリミッター (許可数 1000、キュー 0)、30 秒の総リクエストタイムアウト、リトライ戦略 (リトライ 3 回、ジッター付き指数バックオフ、基準遅延 2 秒)、サーキットブレーカー (失敗率 10 パーセント、最小スループット 100、サンプリング期間 30 秒、遮断 5 秒)、そして 1 試行あたり 10 秒のタイムアウトです。リトライとサーキットブレークは HTTP 5xx、408、429、`HttpRequestException`、および Polly の `TimeoutRejectedException` で発動します。

このメソッドには、どの戦略の既定値よりも重要な行がもう 1 行あります。

```csharp
// ResilienceHttpClientBuilderExtensions.StandardResilience.cs, dotnet/extensions
// Disable the HttpClient timeout to allow the timeout strategies to control the timeout.
_ = builder.ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan);
```

標準ハンドラーを追加すると `HttpClient.Timeout` は完全に無効化され、タイムアウトの責務は Polly の戦略に移ります。これは覚えておいてください。ハンドラーを削除しても、この設定は残ります。落とし穴の節で改めて触れます。

## 2 つ目のハンドラーが 1 つ目を置き換えない理由

クライアント単位の登録が既定の登録を上書きするという直感は、ここでは通用しません。`ConfigureHttpClientDefaults` と `AddHttpClient(name)` はどちらも同じ順序付きリスト `HttpClientFactoryOptions.HttpMessageHandlerBuilderActions` に追加し、`AddStandardResilienceHandler` は最終的に末尾へ追加する `AddHttpMessageHandler` を呼び出します。重複排除は一切行われません。

既定値のブロックを登録し、その後にクライアント単位のハンドラーを登録したうえで、構築されたハンドラーチェーンを `IHttpMessageHandlerFactory.CreateHandler` でたどりました。

```text
A stacked: LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
           -> ResilienceHandler -> ResilienceHandler
           -> LoggingHttpMessageHandler -> SocketsHttpHandler
```

`ResilienceHandler` が 2 つあります。これは見た目だけの重複ではありません。外側のリトライ戦略は最大 4 回試行し、その 1 回ずつが内側のリトライ戦略を通ってさらに最大 4 回試行するため、コードからの 1 回の呼び出しが、守ろうとしていた依存先への 16 リクエストになり得ます。2 つのレートリミッターはそれぞれ許可を消費し、2 つのサーキットブレーカーは同じトラフィックの別々の断面を観測します。全体を抑えているのは外側の 30 秒の総タイムアウトだけです。つまり、設定したつもりの調整済みの挙動ではなく、依存先を叩き続けたあげく 30 秒で失敗するリクエストが得られます。

`AddServiceDefaults()` に加えて `Program.cs` で自分から `ConfigureHttpClientDefaults(http => http.AddStandardResilienceHandler())` を呼んだ場合も同じことが起きます。確認したところ、プロセス内のすべてのクライアントでチェーンにハンドラーが 2 つ現れました。

## ハンドラーを積み重ねずに既定値を上書きする手順

1. **適用範囲を決めます。** 新しい設定をサービスのすべての送信呼び出しに効かせたいなら `ServiceDefaults/Extensions.cs` を変更します。遅い依存先や非冪等な依存先が 1 つだけなら、クライアント単位で行い、既定値はそのままにします。
2. **追加の前に削除します。** 対象の `IHttpClientBuilder` で先に `RemoveAllResilienceHandlers()` を呼び、その後に `AddStandardResilienceHandler(...)` を呼びます。1 つの builder 内での登録順が結果を決めます。
3. **`EXTEXP0001` を抑制します。** `RemoveAllResilienceHandlers` には `[Experimental]` が付いており、この診断は警告ではなくエラーなので、`#pragma warning disable` か `NoWarn` の指定がないとビルドが失敗します。
4. **タイムアウトの整合性を保ちます。** `TotalRequestTimeout` は `AttemptTimeout` より大きく、`CircuitBreaker.SamplingDuration` は `AttemptTimeout` の 2 倍以上である必要があります。そうでなければホストが起動時に例外をスローします。
5. **意図ではなくチェーンを検証します。** テスト内で `IHttpMessageHandlerFactory` を解決し、構築されたパイプライン内の `ResilienceHandler` の数を数えます。

## ServiceDefaults でサービス全体を変更する

`ServiceDefaults` が自分の管理下にあるなら、このブロックを編集するのが正直な解決策です。Microsoft 自身も `Microsoft.Extensions.AI` のチャットテンプレートでまさにこの形を出荷しています。Ollama のエンドポイントは応答に数分かかることが珍しくなく、1 試行 10 秒のタイムアウトではすべてのリクエストが失敗するためです。

```csharp
// Microsoft.Extensions.Http.Resilience 10.8.0, .NET 10
public static IServiceCollection AddOllamaResilienceHandler(this IServiceCollection services)
{
    services.ConfigureHttpClientDefaults(http =>
    {
#pragma warning disable EXTEXP0001 // RemoveAllResilienceHandlers is experimental
        http.RemoveAllResilienceHandlers();
#pragma warning restore EXTEXP0001

        http.AddStandardResilienceHandler(config =>
        {
            config.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);

            // Must be at least double the AttemptTimeout to pass options validation
            config.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
            config.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        });
    });

    return services;
}
```

これは `AddServiceDefaults()` の後に呼ばれる 2 つ目の `ConfigureHttpClientDefaults` ブロックである点に注目してください。アクションは登録順に実行されるため、削除が再追加より先に走り、結果として自分の設定を持つハンドラーが 1 つだけ残ります。なおこのテンプレートは同じブロック内で `AddServiceDiscovery()` も再追加していますが、これは不要です。`RemoveAllResilienceHandlers` が取り除くのは `ResilienceHandler` 型のハンドラーだけなので、サービスディスカバリーを再追加するとサービスディスカバリーのハンドラーが 2 つになります。

## ServiceDefaults に触れずに 1 つのクライアントだけ上書きする

実務で本当に出てくるのはこのケースです。依存先の 1 つが遅い、あるいは絶対にリトライしてはいけない `POST` のエンドポイントが 1 つあり、それ以外は Aspire の既定値のままにしたい、という状況です。

```csharp
// .NET 10, Microsoft.Extensions.Http.Resilience 10.8.0
builder.AddServiceDefaults();

builder.Services.AddHttpClient("reports", client =>
    {
        client.BaseAddress = new Uri("https+http://reporting");
    })
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(o =>
    {
        o.AttemptTimeout.Timeout = TimeSpan.FromMinutes(3);
        o.CircuitBreaker.SamplingDuration = TimeSpan.FromMinutes(10);
        o.TotalRequestTimeout.Timeout = TimeSpan.FromMinutes(10);
        o.Retry.DisableForUnsafeHttpMethods();
    });
```

このコードには自明ではない点が 2 つあります。

1 つ目に、`AddServiceDefaults()` と `AddHttpClient(...)` の呼び出し順は問題になりません。`ConfigureHttpClientDefaults` は自身の登録をサービスコレクション内の追跡された位置に挿入するため、既定値は常に名前付きクライアントの構成より先に実行されます。名前付きクライアントを先に、既定値のブロックを後に登録しても、`reports` クライアントは 3 分の試行タイムアウトを持つ `ResilienceHandler` をちょうど 1 つだけ持ち、無関係なクライアントは 10 秒の既定値のままでした。ただし同一の builder チェーン内では順序が効きます。同じクライアントで `AddStandardResilienceHandler()` の後に `RemoveAllResilienceHandlers()` を置くと、レジリエンスがまったくないクライアントができあがります。

2 つ目に、`DisableForUnsafeHttpMethods()` は `POST`、`PATCH`、`PUT`、`DELETE`、`CONNECT` のリトライを無効にします。標準ハンドラーは既定ですべてのメソッドをリトライするため、非冪等なエンドポイントではデータ重複のバグが起きるのを待っているような状態になります。より限定したい場合は `DisableFor(HttpMethod.Post, HttpMethod.Delete)` を使います。

## どこにも書かれていないオプション名: `-standard`

`AddStandardResilienceHandler` は既定のオプションインスタンスを使いません。識別子 `standard` を使って `$"{httpClientName}-{pipelineIdentifier}"` という形でオプション名を組み立て、その名前付きインスタンスを `IOptionsMonitor<HttpStandardResilienceOptions>` 経由で読み取ります。`slow` という名前のクライアントなら、オプション名は `slow-standard` です。`ConfigureHttpClientDefaults` の内側では builder の `Name` が null なので、文字列補間の結果は先頭にハイフンだけが付いた `-standard` になります。

ここに鋭い落とし穴があります。正しそうに見える `Configure<HttpStandardResilienceOptions>` の呼び出しは何もしません。

```csharp
builder.Services.ConfigureHttpClientDefaults(h => h.AddStandardResilienceHandler());
builder.Services.Configure<HttpStandardResilienceOptions>(o => o.Retry.MaxRetryAttempts = 9);
```

```text
options[''].MaxRetryAttempts          = 9
options['-standard'].MaxRetryAttempts = 3
```

指定した値は名前なしのインスタンスに入りますが、そのインスタンスはどのハンドラーも読み取らず、ハンドラーは既定値の 3 のままです。例外もログも出ません。レジリエンスを「設定した」のに効果がゼロだった経験があるなら、原因はほぼ確実にこれです。`HttpStandardResilienceOptions` がごく普通のオプションクラスであるにもかかわらず、標準ハンドラーが素の `Configure` の影響を受けない理由もこれで説明がつきます。[オプションのアクセサーインターフェースの違い](/ja/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/)はここでは問題ではなく、問題は名前です。

名前を知っていると 3 つ目の上書き手段が使えます。`ServiceDefaults` を編集できず (共有パッケージや自分のものではないテンプレートなど)、かつすべてのクライアントを列挙したくない場合に便利です。

```csharp
// Retunes the handler that AddServiceDefaults already registered.
builder.Services.Configure<HttpStandardResilienceOptions>("-standard", o =>
{
    o.AttemptTimeout.Timeout = TimeSpan.FromSeconds(20);
    o.CircuitBreaker.SamplingDuration = TimeSpan.FromSeconds(60);
    o.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(90);
});
```

これは起動時に `attempt=00:00:20 total=00:01:30` として解決され、チェーン内のハンドラーは 1 つのままです。実装の詳細に結び付いた文字列リテラルなので隣にコメントを残しておくべきですが、確かに機能し、ハンドラーも積み重なりません。

クライアント単位の設定をコードではなく構成に置きたい場合は、代わりにセクションをバインドします。`AddStandardResilienceHandler(IConfigurationSection)` は実在するオーバーロードで、正しい名前のオプションインスタンスに対する `.Configure(section)` へ転送します。

```json
{
  "Resilience": {
    "Slow": {
      "AttemptTimeout": { "Timeout": "00:03:00" },
      "TotalRequestTimeout": { "Timeout": "00:10:00" },
      "CircuitBreaker": { "SamplingDuration": "00:10:00" },
      "Retry": { "MaxRetryAttempts": 2 }
    }
  }
}
```

```csharp
builder.Services.AddHttpClient("slow")
#pragma warning disable EXTEXP0001
    .RemoveAllResilienceHandlers()
#pragma warning restore EXTEXP0001
    .AddStandardResilienceHandler(builder.Configuration.GetSection("Resilience:Slow"));
```

バインドされた値は記述したとおりに反映されます。さらに標準ハンドラーは `context.EnableReloads` を呼ぶため、`appsettings.json` でこれらの値を編集すると再起動なしでパイプラインが再構築されます。

## 実際に痛い落とし穴

**不正なタイムアウトは最初のリクエストではなく起動時に失敗します。** 2 つのバリデーターはどちらも `AddOptionsWithValidateOnStart` で登録されるため、不整合があるとホストの起動時に例外がスローされます。`AttemptTimeout` だけを 3 分にして他をそのままにすると、次のようになります。

```text
Microsoft.Extensions.Options.OptionsValidationException: Total request timeout resilience
strategy must have a greater timeout than the attempt resilience strategy. Total Request
Timeout: 30s, Attempt Timeout: 180s; The sampling duration of circuit breaker strategy needs
to be at least double of an attempt timeout strategy’s timeout interval, in order to be
effective. Sampling Duration: 30s,Attempt Timeout: 180s
```

2 倍というルールは `HttpStandardResilienceOptionsCustomValidator` にハードコードされた乗数 2 です。`AttemptTimeout` を上げるなら、必ず `TotalRequestTimeout` と `CircuitBreaker.SamplingDuration` も上げることになります。同じ種類のチェックを自前の設定に対して行いたい場合は、[`IValidateOptions<T>` による起動時検証](/ja/2026/08/how-to-validate-options-at-startup-with-ivalidateoptions-in-dotnet-11/)で同じ仕組みが使えます。

**ハンドラーを削除するとタイムアウトが一切なくなります。** これが最悪の落とし穴です。`RemoveAllResilienceHandlers()` は `ResilienceHandler` のインスタンスを取り除きますが、`AddStandardResilienceHandler` が登録した `ConfigureHttpClient(client => client.Timeout = Timeout.InfiniteTimeSpan)` は取り消しません。`AddHttpClient("bare").RemoveAllResilienceHandlers()` として何も追加し直さずに構築したクライアントは次のようになります。

```text
bare client chain:   LifetimeTrackingHttpMessageHandler -> LoggingScopeHttpMessageHandler
                     -> LoggingHttpMessageHandler -> SocketsHttpHandler
HttpClient('bare').Timeout = -00:00:00.0010000
```

このマイナス 1 ミリ秒が `Timeout.InfiniteTimeSpan` です。レジリエンスハンドラーもなく、`HttpClient` の既定の 100 秒もなく、いかなるタイムアウトもありません。依存先がハングすると、渡してあることを願うキャンセルトークンが発火するまで、リクエストのスレッドプールがそのまま塞がれます。ハンドラーを削除して追加し直さないのであれば、`client.Timeout` を明示的に設定してください。タイムアウトが実際に発火する関連の失敗パターンは[HttpClient が TaskCanceledException をスローする理由](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)で扱っています。

**削除の対象は型であってチェーンではありません。** 実装は追加ハンドラーを後ろから走査し、`is ResilienceHandler` に一致するものだけを取り除きます。独自の `DelegatingHandler` 型、認証ハンドラー、サービスディスカバリーのハンドラーはいずれも残ります。既定値のブロックに登録したマーカー用ハンドラーで確認したところ、名前付きクライアントで `RemoveAllResilienceHandlers()` を呼んだ後もマーカーは残っていました。したがって、削除後にサービスディスカバリーを再追加してはいけません。

**gRPC クライアントには `Grpc.Net.ClientFactory` 2.64.0 以降が必要です。** 標準ハンドラーを古い `AddGrpcClient` と組み合わせると `System.InvalidOperationException: The ConfigureHttpClient method isn't supported when creating gRPC clients` がスローされます。これにはビルド時のチェックがあり、`<SuppressCheckGrpcNetClientFactoryVersion>` で抑制できます。

**`RemoveAllResilienceHandlers` は実験的 API です。** `Microsoft.Extensions.Http.Resilience` 10.8.0 のアナライザーは `EXTEXP0001` をエラーとして出力するため、pragma は体裁の問題ではなく必須です。API の形自体は 9.0 以降安定していますが、この注釈はチームが変更する権利を留保していることを意味します。

これらすべてを貫くルールはこうです。レジリエンスハンドラーはメッセージハンドラーであり、メッセージハンドラーは置き換えではなく合成されます。それが腹落ちすれば、「Aspire の既定値をどう上書きするか」は謎ではなくなり、「正しい builder に対して、削除してから追加する、その順番で」という話になります。

## 関連記事

- [Polly とレジリエンスハンドラーの比較 (.NET 11)](/ja/2026/05/polly-vs-resilience-handlers-in-dotnet-11/) では、そもそもどの層でレジリエンスを設定すべきかを説明しています。
- [既存の ASP.NET Core ソリューションに Aspire を追加する](/ja/2026/07/how-to-add-aspire-to-an-existing-aspnetcore-solution-without-restructuring-it/) では、`AddServiceDefaults()` が他に何を有効にするかを扱っています。
- [HttpClient と HttpClientFactory と Refit の比較](/ja/2026/05/httpclient-vs-httpclientfactory-vs-refit/) では、そもそもハンドラーチェーンがどう構築されるかを説明しています。
- [.NET 11 の IOptions と IOptionsSnapshot と IOptionsMonitor](/ja/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/) では、標準ハンドラーが名前付きオプションを読み取るためのモニターを解説しています。
- [ローカルのマルチサービス開発における Aspire と Docker Compose](/ja/2026/08/aspire-vs-docker-compose-for-local-multi-service-development/) は、そもそも Aspire を採用するか迷っている場合に読んでください。

## 参照元

- [Build resilient HTTP apps: key development patterns](https://learn.microsoft.com/en-us/dotnet/core/resilience/http-resilience) (MS Learn)。標準ハンドラーの既定値の表と既知の問題の出典です。
- [`ResilienceHttpClientBuilderExtensions.StandardResilience.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/ResilienceHttpClientBuilderExtensions.StandardResilience.cs) (dotnet/extensions)。オプション名とクライアントの無限タイムアウトの出典です。
- [`HttpStandardResilienceOptionsCustomValidator.cs`](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.Http.Resilience/Resilience/Internal/Validators/HttpStandardResilienceOptionsCustomValidator.cs)。正確な検証ルールとメッセージの出典です。
- [`OllamaResilienceHandlerExtensions.cs`](https://github.com/dotnet/extensions/blob/main/src/ProjectTemplates/Microsoft.Extensions.AI.Templates/templates/AIChatWeb-CSharp/AIChatWeb-CSharp.Web/OllamaResilienceHandlerExtensions.cs)。Microsoft 自身による Aspire 既定値の上書き例です。
- [Aspire service defaults](https://aspire.dev/get-started/csharp-service-defaults/)。生成される `AddServiceDefaults` のソースの出典です。
