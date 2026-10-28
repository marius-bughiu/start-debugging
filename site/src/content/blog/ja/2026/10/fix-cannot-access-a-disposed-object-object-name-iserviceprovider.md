---
title: "修正: Cannot access a disposed object. Object name: 'IServiceProvider'"
description: "コードが、破棄済みの DI スコープまたはルートプロバイダーからサービスを解決しています。IServiceProvider の代わりに IServiceScopeFactory を保持し、処理が実行される場所で新しいスコープを作成してください。"
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "aspnetcore"
  - "dependency-injection"
lang: "ja"
translationOf: "2026/10/fix-cannot-access-a-disposed-object-object-name-iserviceprovider"
translatedBy: "claude"
translationDate: 2026-10-28
---

修正方法: スコープ (またはコンテナー全体) がすでに破棄された `IServiceProvider` に対して、何かが `GetService`、`GetRequiredService`、`CreateScope` を呼び出しています。原因としてよくあるのは、`HttpContext.RequestServices` をキャプチャした fire-and-forget のタスク、"lazy" に解決するためにスコープ付きの `IServiceProvider` を保存しているサービス、ホストのシャットダウン後も動き続けるバックグラウンドループです。`IServiceProvider` を保持し続けるのをやめてください。`IServiceScopeFactory` を注入し、処理が実際に実行される場所で `CreateAsyncScope()` を呼び出し、その新しいスコープからすべてを解決します。

```text
System.ObjectDisposedException: Cannot access a disposed object.
Object name: 'IServiceProvider'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ThrowHelper.ThrowObjectDisposedException()
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

この記事のすべてのスニペットと出力行は、.NET 10 (ランタイム 10.0.10、共有フレームワークに含まれる `Microsoft.Extensions.DependencyInjection`、ASP.NET Core 10.0.10) で実行した再現コードによるものです。この例外をスローするガードは `dotnet/runtime` の `release/11.0` ブランチでも同一なので、同じ分析が .NET 11 にも当てはまります。

## コンテナーが null を返さずにスローする理由

`Microsoft.Extensions.DependencyInjection` では、すべてのスコープが `ServiceProviderEngineScope` です。これは `IServiceScope`、`IServiceProvider`、`IServiceScopeFactory` を同時に実装しており、`scope.ServiceProvider` から得られる `IServiceProvider` はスコープオブジェクト自身です。スコープが破棄されると、そのスコープが作成したすべての `IDisposable`/`IAsyncDisposable` を破棄し、その後でプライベートな `_disposed` フラグを設定します。この時点から、`GetService`、`GetKeyedService`、`GetRequiredKeyedService` はいずれも同じチェックから始まります。

```csharp
// dotnet/runtime, release/10.0
// src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs
public object? GetService(Type serviceType)
{
    if (_disposed)
    {
        ThrowHelper.ThrowObjectDisposedException();
    }

    return RootProvider.GetService(ServiceIdentifier.FromServiceType(serviceType), this);
}

// ThrowHelper.cs
internal static void ThrowObjectDisposedException()
{
    throw new ObjectDisposedException(nameof(IServiceProvider));
}
```

この `nameof(IServiceProvider)` があるため、リクエストスコープ、手動で作成したスコープ、ルートの `ServiceProvider` のどれに当たったかにかかわらず、オブジェクト名は常に `'IServiceProvider'` になります。ルートプロバイダーも独自の `_disposed` フラグを持ち、同じヘルパーを通るため、メッセージだけでは *どの* プロバイダーが破棄されたのかわかりません。それを教えてくれるのはスタックトレースです。`ServiceProviderEngineScope.GetService` ならスコープであり、`ServiceProvider.CreateScope` や `ServiceProvider.GetService` のフレームがあればルートコンテナーが失われており、ほぼ確実にホストが破棄されています。

この設計から、デバッグ時に重要な 2 つの帰結があります。

1. **スローされるのは解決時だけです。** スコープが終了する前に解決済みのインスタンスは、通常のオブジェクトのままです。そのインスタンス自身に破棄ガード (`DbContext`、`HttpClient`、`CancellationTokenSource` など) がある場合、それに触れると、この例外ではなく、その型固有のオブジェクト名を持つ `ObjectDisposedException` が発生します。
2. **プロバイダーは "壊れた" のではなく、終了したのです。** 破棄されたスコープを復活させる方法はありません。修正は常に、処理の全期間をカバーする寿命を持つスコープを使うことです。

## この例外を引き起こす 4 つのパターン

これらはすべて 1 つのコンソールアプリ (`Microsoft.NET.Sdk.Web`、`net10.0`) で再現しました。4 つとも上記と同じメッセージが出力されました。

### 1. `using` の外に漏れたスコープ付きプロバイダー

最小の再現コードです。変数がスコープより長く生き残ります。

```csharp
// .NET 10, C# 14
var services = new ServiceCollection();
services.AddScoped<Repo>();
using var root = services.BuildServiceProvider();

IServiceProvider leaked;
using (var scope = root.CreateScope())
{
    leaked = scope.ServiceProvider;
}

leaked.GetRequiredService<Repo>(); // ObjectDisposedException: 'IServiceProvider'
```

意図してこう書く人はいませんが、形を変えて頻繁に現れます。たとえば、`using var scope = ...; return scope.ServiceProvider;` というヘルパーメソッドや、`using var` でスコープを作成した `async` メソッドが、同期部分が戻った後もそのスコープから解決し続ける `Task` や `IAsyncEnumerable` を返すケースです。

### 2. `HttpContext.RequestServices` をキャプチャした fire-and-forget のタスク

多くの人がこの記事にたどり着くのはこのケースです。ASP.NET Core は `RequestServicesFeature` でリクエストスコープを遅延作成し、そのフィーチャーを `Response.RegisterForDisposeAsync` に登録するため、スコープはレスポンスの完了と同時に破棄されます。`RequestServices` を取得した切り離しタスクは、この競争に負けます。

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- wrong
app.MapPost("/orders/{id}/export", (int id, HttpContext ctx) =>
{
    var sp = ctx.RequestServices;
    _ = Task.Run(async () =>
    {
        await Task.Delay(200);                       // the response is already sent
        var exporter = sp.GetRequiredService<OrderExporter>(); // throws
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

再現では、エンドポイントは `202` を返し、200 ms 後にタスクが `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.` をログに出力しました。例外は監視されていないタスクで発生するため、ログでしか確認できないか、まったく気づけないことも多く、症状は "エクスポートが黙って実行されない" というものになります。コントローラーでコンストラクター注入により `IServiceProvider` をキャプチャしたタスクや、後から `IHttpContextAccessor.HttpContext.RequestServices` を読み取る場合も同じことが起こります (後者はコンテキストが再利用されて `null` になることもあります)。

### 3. `IServiceProvider` を後で使うために保存するサービス

"サービスロケーター" 型のパターンです。トランジェントまたはスコープ付きのサービスが、必要に応じて依存関係を解決できるよう、コンストラクターで `IServiceProvider` を受け取ります。

```csharp
// .NET 10, C# 14 -- wrong
class ReportBuilder(IServiceProvider sp)
{
    public void Build() => sp.GetRequiredService<Repo>().Save();
}

ReportBuilder rb;
using (var scope = root.CreateScope())
    rb = scope.ServiceProvider.GetRequiredService<ReportBuilder>();

rb.Build(); // ObjectDisposedException: 'IServiceProvider'
```

スコープ付きまたはトランジェントのサービスに注入される `IServiceProvider` は、ルートではなく、そのサービスが解決されたスコープです。`ReportBuilder` が、スコープより長く生きるもの (シングルトンのキャッシュ、シングルトンへのイベント購読、静的フィールド、`Lazy<T>`、`sp => () => sp.GetRequiredService<T>()` として登録した `Func<T>` ファクトリなど) に渡された瞬間、次の遅延解決でスローされます。[キャプティブ依存関係のエラー "Cannot consume scoped service from singleton"](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) を見たことがあるなら、これはそのランタイム版です。スコープ検証はビルド時にキャプティブな *サービス* を検出しますが、キャプチャされた *プロバイダー* は検出できません。

### 4. ホストより長く生き残るバックグラウンドループ

ルートプロバイダーはホストが破棄されるときに破棄されます。`BackgroundService.StopAsync` は停止トークンをキャンセルして `ExecuteAsync` を待ちますが、それは `HostOptions.ShutdownTimeout` (.NET 6 以降の既定値は 30 秒) が切れるまでです。トークンを無視するループは、ホストが先に進んでコンテナーを破棄した後も動き続けます。

```csharp
// .NET 10 -- wrong: ignores stoppingToken
class StubbornWorker(IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            using var scope = scopes.CreateScope(); // throws once the host is disposed
            scope.ServiceProvider.GetRequiredService<Repo>().Save();
            await Task.Delay(250);
        }
    }
}
```

`ShutdownTimeout` を 1 秒に設定すると、`StopAsync` が戻り、`host.Dispose()` が実行され、次のイテレーションで `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.` が出力されました。このワーカーはスコープの扱いについては正しいことに注意してください。バグは、キャンセルトークンを無視していることだけです。同じ失敗は、`System.Threading.Timer` のコールバック、`Task.Run` で開始した `Channel` のコンシューマー、シャットダウン後も処理を続けるメッセージバスのハンドラーでも発生します。テストでは、`WebApplicationFactory<T>` やホストのフィクスチャーが破棄された時点で、テスト (またはテストが開始したバックグラウンドタスク) がまだ `factory.Services` からサービスを解決している場合に発生します。

## 修正 1: `IServiceProvider` ではなく `IServiceScopeFactory` をキャプチャする

パターン 2 と 3 では、これが修正方法です。`IServiceScopeFactory` はコンテナー内で特別な扱いを受けます。`ServiceProvider` はこれを **ルート** スコープを指す定数のコールサイトとして登録するため、どこから解決しても問題ありません。リクエストスコープのエンドポイントに注入された `IServiceScopeFactory` であっても、ルートコンテナーに結び付いており、リクエストが終了した後も動作し続けます。切り離した処理の内部でスコープを作成すれば、スコープの寿命がちょうど処理の寿命と一致します。

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- right
app.MapPost("/orders/{id}/export", (int id, IServiceScopeFactory scopes) =>
{
    _ = Task.Run(async () =>
    {
        await using var scope = scopes.CreateAsyncScope();
        var exporter = scope.ServiceProvider.GetRequiredService<OrderExporter>();
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

再現では、`RequestServices` 版を壊した 200 ms の遅延と同じ条件で、こちらは `good: ok` がログに出力されました。`await using` と組み合わせて `CreateAsyncScope()` を使うことをお勧めします。スコープ内のサービスのどれかが `IAsyncDisposable` だけを実装している場合、スコープに対して同期的に `Dispose()` を呼ぶと、`DisposeAsync` を使うよう伝える `InvalidOperationException` がスローされるためです。理由は [`IAsyncDisposable` と `await using` のガイド](/ja/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)で説明しています。

リクエストに紐づく *データ* もスコープ経由で渡さないでください。必要なもの (ID、ユーザー名、相関 ID) は、タスクを開始する前にローカル変数へコピーします。`HttpContext` 自体も、レスポンスの完了後に触れるのは安全ではありません。

サービスロケーター型のパターンでは、`ReportBuilder` に `IServiceScopeFactory` を注入して `Build()` の呼び出しごとにスコープを作成するか、より良い方法として `Repo` を直接注入してコンテナーに寿命の管理を任せます。依存関係が本当にオプションであるか、コストが高い場合は、プロバイダーを保存するよりも、新しいスコープから解決するキー付きまたはファクトリ登録のほうが適切です。

## 修正 2: 処理を本来のバックグラウンド機構に移す

パターン 2 の根本的な問題は、リクエストハンドラーからの `Task.Run` です。タスクを追跡するものも、その例外を監視するものも、シャットダウン時にそれを止めるものもありません。作業項目を `Channel<T>` に入れ、項目ごとに 1 つのスコープを作成する `BackgroundService` から取り出して処理します。

```csharp
// .NET 10, C# 14
public sealed class ExportQueue
{
    private readonly Channel<int> _channel = Channel.CreateUnbounded<int>();
    public ValueTask EnqueueAsync(int orderId) => _channel.Writer.WriteAsync(orderId);
    public IAsyncEnumerable<int> ReadAllAsync(CancellationToken ct) => _channel.Reader.ReadAllAsync(ct);
}

public sealed class ExportWorker(ExportQueue queue, IServiceScopeFactory scopes, ILogger<ExportWorker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var id in queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<OrderExporter>().ExportAsync(id, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Export of order {OrderId} failed", id);
            }
        }
    }
}

// Program.cs
builder.Services.AddSingleton<ExportQueue>();
builder.Services.AddHostedService<ExportWorker>();
app.MapPost("/orders/{id}/export", async (int id, ExportQueue queue) =>
{
    await queue.EnqueueAsync(id);
    return Results.Accepted();
});
```

容量制限付きチャネルやバックプレッシャーを含む完全なパターンは、[BackgroundService で fire-and-forget の処理を安全に実行する方法](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)にあります。イテレーションごとにスコープを作成する部分は、[BackgroundService 内でスコープ付きサービスを使う方法](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)で詳しく扱っています。

## 修正 3: 停止トークンを尊重し、破棄後に何も実行されないようにする

パターン 4 では、スコープのコードは問題なく、ループの寿命がバグです。`ShutdownTimeout` が切れる前にループが終了するよう、すべての await とループ条件に `stoppingToken` を渡します。

```csharp
// .NET 10 -- right
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
    while (await timer.WaitForNextTickAsync(stoppingToken))
    {
        await using var scope = scopes.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<Repo>().SaveAsync(stoppingToken);
    }
}
```

`PeriodicTimer.WaitForNextTickAsync` はキャンセル時に `OperationCanceledException` をスローし、`BackgroundService` は停止トークンと一致するキャンセルを正常終了として扱います。1 つの処理が正当な理由で 30 秒より長くかかる場合は、トークンを無視するのではなく `HostOptions.ShutdownTimeout` を延ばしてください。そうしないと、ホストが足元でコンテナーを破棄してしまいます。開始と停止の正確な順序は、[IHostedService コントラクトの記事](/ja/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/)で解説しています。

統合テストでは、フィクスチャーの `DisposeAsync` が実行される前に、テストが開始したすべてのタスクを await するようにし、テストごとのサービスは `factory.Services` から直接ではなく `factory.Services.CreateAsyncScope()` から解決してください。

## 落とし穴と紛らわしい類似例

**解決処理の内部での競合。** `ServiceProviderEngineScope.CaptureDisposable` は、破棄可能なサービスを構築した後、ロック下で `_disposed` をチェックします。別のスレッドでサービスを作成している *最中に* スコープが破棄された場合、コンテナーは構築したばかりのインスタンスを破棄し、その後で同じ例外をスローします。そのため、直前まで問題なさそうに見えたコードパスでも発生することがあります。それでも同じバグです。2 つのスレッドがスコープの寿命について食い違っています。

**`app.Run` が戻った後の `app.Services`。** `Program.cs` で `app.Run()` や `await app.RunAsync()` の後に実行されるもの (クリーンアップコード、最後のフラッシュなど) は、ホストが破棄された後に実行されます。必要なものは `Run` を呼ぶ前に解決するか、そのロジックを `IHostApplicationLifetime.ApplicationStopping` コールバックに移してください。

**シングルトン内の `IServiceProvider` はルートです。** シングルトンに `IServiceProvider` を注入するとルートプロバイダーが得られます。これはホストとともにしか破棄されないため、通常の動作中にこの例外がスローされることはありません。ただし、`ValidateScopes` が無効だとルートスコープからスコープ付きサービスを平気で返してしまい、それらが意図せずシングルトンになります。ここでも `IServiceScopeFactory` を使ってください。

**"Cannot access a disposed context instance"。** メッセージのオブジェクト名が `DbContext` 型 (`Object name: 'AppDb'`) の場合、破棄されたのはプロバイダーではなくスコープ内のサービスであり、修正は操作ごとに新しいコンテキストを使うことです。[破棄された DbContext のガイド](/ja/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/)を参照してください。

**`Object name: 'System.Net.Http.HttpClient'` や `CancellationTokenSource`。** 例外の型は同じですが、所有者が異なります。これらは、破棄後に解決したのではなく、解決したインスタンスを破棄したことが原因です。

## 関連記事

- キャプチャされた寿命のビルド時版については [Fix: Cannot consume scoped service from singleton](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) を参照してください。
- 作業単位ごとにスコープを作成するパターンについては [How to use scoped services inside a BackgroundService](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) を参照してください。
- ハンドラー内の `Task.Run` を置き換える方法については [How to run fire-and-forget work safely with BackgroundService](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) を参照してください。
- 同じ寿命のバグの EF Core 版については [Fix: Cannot access a disposed context instance](/ja/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) を参照してください。
- テストでのフィクスチャーの寿命については [How to write integration tests with WebApplicationFactory](/ja/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) を参照してください。

## 参考資料

- [`ServiceProviderEngineScope.cs` on `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs) (`_disposed` ガードと `CaptureDisposable`)。
- [`ThrowHelper.cs` on `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ThrowHelper.cs) (`new ObjectDisposedException(nameof(IServiceProvider))`)。
- [`ServiceProvider.cs` on `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceProvider.cs) (ルートスコープに結び付いた定数として登録される `IServiceScopeFactory`)。
- [`RequestServicesFeature.cs` on `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http/src/Features/RequestServicesFeature.cs) (`RegisterForDisposeAsync` 経由で破棄されるリクエストスコープ)。
- Microsoft Learn の [Dependency injection guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines)。
- Microsoft Learn の [Use scoped services within a BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service)。
- [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout) API リファレンス。
