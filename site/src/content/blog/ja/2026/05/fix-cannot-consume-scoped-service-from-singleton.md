---
title: "解決方法: Cannot consume scoped service 'X' from singleton 'Y'"
description: "ASP.NET Core のスコープ検証は、シングルトンが scoped 依存をプロセス全体にわたってキャプチャしてしまう場合にこの例外を投げます。コンシューマーを scoped にするか、IServiceScopeFactory を注入して必要に応じてスコープを作成してください。"
pubDate: 2026-05-10
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
lang: "ja"
translationOf: "2026/05/fix-cannot-consume-scoped-service-from-singleton"
translatedBy: "claude"
translationDate: 2026-05-10
---

解決方法: ASP.NET Core のスコープバリデーターがキャプティブ依存をブロックしました。シングルトン `Y` がルートプロバイダーに scoped サービス `X` を要求し、`X` をプロセス全体に固定してリクエスト単位の有効期間を完全にバイパスしてしまうところでした。`Y` を scoped に変更する（`Y` がリクエストスコープ内で使われる場合に推奨）か、`Y` をシングルトンのまま `IServiceScopeFactory` を注入し、`X` が必要になるたびに新しいスコープを作成してください。`DbContext` 専用の場合は `IDbContextFactory<T>` を使ってください。

```text
System.InvalidOperationException: Cannot consume scoped service 'MyApp.Data.AppDbContext' from singleton 'MyApp.Workers.OrderProcessor'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.CallSiteValidator.ValidateCallSite(ServiceCallSite callSite)
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProvider.GetService(Type serviceType, ServiceProviderEngineScope serviceProviderEngineScope)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.Hosting.Internal.Host.StartAsync(CancellationToken cancellationToken)
```

このガイドは .NET 11 preview 4、`Microsoft.Extensions.DependencyInjection` 11.0.0-preview.4、`Microsoft.Extensions.Hosting` 11.0.0-preview.4 を対象に書かれています。例外メッセージとそれを投げるバリデーターは .NET Core 2.0 以降変わっていないため、以下の解決策はすべて .NET Core 3.1、.NET 5、6、8、10、11 にそのまま適用できます。

メッセージに含まれる 2 つの型名は最初に読むべき部分です。**1 つ目** の名前が **scoped** サービスで、**2 つ目** の名前がそれを要求した **シングルトン** のコンシューマーです。検索エンジンは半分の確率で誤った側にあなたを誘導しがちですが、エラーは常にこの順番で名前を出します。

## なぜスコープ検証がこの組み合わせを拒否するのか

シングルトンはプロセスごとに 1 度しか生きません。scoped サービスはリクエストスコープごと（または `IServiceScopeFactory.CreateScope()` 呼び出しごと）に 1 度生きます。シングルトンが scoped サービスへの参照をフィールドに保持すると、その scoped インスタンスは以降のすべてのリクエストを生き延び、scoped 有効期間の本来の目的（リクエストごとの状態、スコープごとの接続プール、スコープごとの変更追跡、スコープごとのテナント分離）が完全に台無しになります。

ASP.NET Core の `ValidateScopes` オプションは、コンストラクターが実行される前に call site グラフを走査することで、解決時にこれを捕捉します。`Development` では `WebApplication.CreateBuilder` が `ValidateScopes` を自動的に有効化しますが、`Production` ではそうはならないため、一部のチームはローカルでしか例外を見ず、キャプティブバグを本番に出してしまいます。本番では古いデータ、リークした接続、元のリクエストスコープと共に破棄された `DbContext` 上での `ObjectDisposedException` として現れます。

このバグはちょうど 4 つの形を取ります。

1. **シングルトンのコンストラクター引数が scoped である。** 最も多いケース。`BackgroundService`（シングルトン）のコンストラクターが `IUserRepository`（scoped）を要求しています。
2. **シングルトンのコンストラクター引数自体はシングルトンだが、推移的に scoped に依存している。** シングルトン `IFooFactory` がシングルトン `IFooDeps` を取り、それが scoped `IUnitOfWork` を取る。バリデーターはグラフをたどります。
3. **シングルトンが `IServiceProvider` から scoped を直接解決する。** シングルトン内部からの `_provider.GetRequiredService<IUserRepository>()`。`_provider` は **ルート** プロバイダーで、スコープを持たないため、バリデーターが投げます。
4. **ホスト型サービス／キューワーカー／タイマーコールバックが、いかなるリクエストの外でも実行される。** ホストは周囲スコープのないスレッドからシングルトンを呼び出すため、scoped の解決はすべてルートに対して行われます。

最初の 3 つは起動時または最初の呼び出しで失敗します。4 つ目はタイマーが発火した瞬間に失敗します。同じ例外、別のデバッグ経路です。

## 最小再現

例外を投げる最小の .NET 11 コンソールアプリ:

```csharp
// .NET 11 preview 4, Microsoft.Extensions.Hosting 11.0.0-preview.4
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddScoped<IUserRepository, UserRepository>();
builder.Services.AddHostedService<OrderProcessor>();

var host = builder.Build();
await host.RunAsync();

public interface IUserRepository
{
    string GetName(int id);
}

public sealed class UserRepository : IUserRepository
{
    public string GetName(int id) => $"user-{id}";
}

public sealed class OrderProcessor(IUserRepository repo) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            Console.WriteLine(repo.GetName(1));
            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddHostedService<T>` は `OrderProcessor` をシングルトンとして登録します。コンストラクターは scoped である `IUserRepository` を要求します。ホストビルダーは `StartAsync` の間にルートプロバイダー上で `GetRequiredService` を呼び、バリデーターは call site を走査して scoped から singleton への辺を見つけ、例外を投げます。

## 解決策その 1: コンシューマーがリクエストに収まるなら scoped にする

コンシューマーが **リクエスト単位** で到達される場合の最も綺麗な解決策です。コントローラー、minimal API のエンドポイントハンドラー、MVC フィルター、SignalR ハブメソッド: これらはすべて既存のスコープ内で実行されます。誤ってシングルトンとして登録した場合は、登録を変更してください:

```csharp
// .NET 11 preview 4
// Wrong: pulls AppDbContext into a process-wide singleton
builder.Services.AddSingleton<IOrderService, OrderService>();

// Right: scoped matches DbContext lifetime
builder.Services.AddScoped<IOrderService, OrderService>();
```

この解決策はホスト型サービス、タイマー、バックグラウンドキューには通用しません。これらには周囲スコープがないため、scoped にしても何も変わりません（ホストは依然としてルートから解決します）。それらには解決策その 2 を使ってください。

シングルトンから scoped への登録変更を行うときは、フィールドに保存された参照を求めて呼び出し箇所を監査してください。コンストラクターで `IOrderService` を取っていた他のシングルトンも今度はスコープ検証で落ち、リクエストスコープに収まるサービスに到達するまで連鎖が上方向にほどけていきます。

## 解決策その 2: IServiceScopeFactory を注入して作業単位ごとにスコープを開く

コンシューマーが **シングルトンのまま** でなければならない場合は、`IServiceScopeFactory` を取り、作業を行うたびに新しいスコープを作成します。これは `BackgroundService` およびあらゆるプロセス規模のコンシューマーにとって正典のパターンです:

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            using var scope = scopeFactory.CreateScope();
            var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();

            Console.WriteLine(repo.GetName(1));

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

このパターンを正しく適用するための 3 つのルール:

- **作業単位ごとに 1 スコープ**、プロセスごとに 1 スコープではありません。要点は、各反復が新しい `DbContext`、新しい変更追跡、新しい接続を取得することです。反復の終わりにスコープを破棄することで scoped サービスが解放されます。
- **スコープの `ServiceProvider` から解決する** こと。キャプチャしたルートプロバイダーからではありません。`scope.ServiceProvider.GetRequiredService<T>()` が正しく、`_rootProvider.GetRequiredService<T>()` は元のバグです。
- シングルトンの **フィールドに scoped サービスを保持しない** こと。スコープ内部で解決したインスタンスは、スコープより長く生きてはいけません。別のメソッドに渡す必要がある場合はパラメーターとして渡し、`using` と共にスコープから外させてください。

.NET 11 における `IAsyncDisposable` サービス（最近のほとんどの `DbContext` 構成）には、非同期 disposable 形式を優先してください:

```csharp
// .NET 11 preview 4
await using var scope = scopeFactory.CreateAsyncScope();
var repo = scope.ServiceProvider.GetRequiredService<IUserRepository>();
```

`CreateAsyncScope` は `AsyncServiceScope` を返し、scoped サービスが `DisposeAsync` を実装している場合はそれを通じて破棄します。プールされた `DbContext` インスタンスにとってこれは重要です: 非同期専用リソースの同期的な破棄は、.NET 11 ではデフォルトで例外を投げます。

## 解決策その 3: DbContext 専用には IDbContextFactory を使う

EF Core はまさにこのシナリオのための型付きファクトリーを出荷しています。scoped `DbContext` の代わりに（または並行して）登録してください:

```csharp
// .NET 11 preview 4, Microsoft.EntityFrameworkCore 11.0.0-preview.4
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11 preview 4
public sealed class OrderProcessor(IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process pending...

            await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
        }
    }
}
```

`AddDbContextFactory` は `IDbContextFactory<AppDbContext>` を **シングルトン** として登録し、ファクトリーは要求に応じて新しい `DbContext` インスタンスを返します。スコープの不一致なし、キャプティブな `DbContext` なし、ワーカーでのスコープの儀式なし。これは Microsoft が Blazor Server、ホスト型サービス、リクエストにバインドされていない EF Core 利用コードに対して推奨するパターンです。完全な指針は [DbContext ファクトリーのドキュメント](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor) を参照してください。

リクエストにバインドされたコンシューマーとそうでないコンシューマーが混在する場合は、`AddDbContext` と `AddDbContextFactory` の両方を登録できます。スコーピングと並行してプーリングが必要な場合は `AddDbContextFactory<T>(..., ServiceLifetime.Scoped)` でファクトリー自身を scoped にしてもかまいませんが、コンシューマー側で有効期間が揃っていることを確認してください。

## 解決策その 4: ValidateOnBuild は最初のリクエストではなく起動時にこれを捕捉する

上記の本物の解決策を適用したら、次のキャプティブバグが速く失敗するようにビルド時検証を有効にしてください:

```csharp
// .NET 11 preview 4
builder.Host.UseDefaultServiceProvider(options =>
{
    options.ValidateScopes = true;
    options.ValidateOnBuild = true;
});
```

`ValidateScopes = true` はランタイムに対して、本番でもすべての解決を call site バリデーターに通すよう強制します。`ValidateOnBuild = true` は `host.Build()` の時点でコンテナのすべての登録に対してこれを **1 度** 実行します。最初の解決時に投げてしまうような登録があれば、ホストは起動を拒否します。

コストは起動時の検証パスが 1 度だけ走ることです。利点は、次にキャプティブ依存を導入した開発者が、本番トラフィックではなく、ローカル起動または CI で失敗を見ることです。

検索結果が示唆していたとしても、**やってはいけないこと**: 例外を黙らせるために `ValidateScopes` をオフにすることです。チェックを無効化してもバグは直りません。隠すだけです。scoped サービスはシングルトンの有効期間に固定されたままで、単に通知されなくなるだけです。古いデータ、リークした接続、プロセス後半の `ObjectDisposedException` が必ず起こります。

## 同じエラーに見えて解決策が異なる派生

エラーメッセージのいくつかは家族的な類似性を持ち、同一視するとデバッグ時間を浪費します:

- **`Unable to resolve service for type 'X' while attempting to activate 'Y'`**: 有効期間の不一致ではなく、登録漏れです。原因も解決策も別物です。[unable to resolve service for type while attempting to activate の記事](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/) で扱っています。
- **`Cannot resolve scoped service 'X' from root provider`**: コンシューマーが **ルート** の `IServiceProvider` に直接問い合わせた場合（scoped な `X` に対する `app.Services.GetRequiredService<X>()`）。解決策はシングルトンのケースと同じです: まずスコープを開きます。
- **`A circular dependency was detected for the service of type 'X'`**: 有効期間は問題ないが call site グラフに循環があります。コンストラクターで自身またはいとこ関係にあるサービスを取っているサービスを探してください。
- **`Cannot access a disposed object. Object name: 'AppDbContext'`**: スコープ検証から **すでに** 逃れた（検証がオフだったか、検証されない経路で解決された）キャプティブな scoped サービスが、元のスコープ破棄後に使われています。解決策は呼び出し箇所で新しいスコープを開くことです。

## なぜこれは何よりもホスト型サービスを直撃するのか

`AddHostedService<T>` と `AddSingleton<IHostedService, T>` は同じ登録です。すべてのホスト型サービスはシングルトンです。ホストは `StartAsync` の間にルートプロバイダーからそれらを解決します。ホスト型サービスのコンストラクターがデータベースを触るもの、テナントリゾルバーと話すもの、`HttpContext` をラップするものを取っていれば、それらは scoped であり、バリデーターが投げます。

同じ落とし穴は次のものにも存在します:

- **シングルトンから scoped な delegating handler を解決する `IHttpClientFactory` のコンシューマー。** `IHttpClientFactory` 自体はシングルトンですが、リクエストごとのハンドラーは scoped として登録できます。シングルトンから名前付きクライアントを解決するとバリデーターが起動します。
- **scoped として登録された Polly のレジリエンスパイプライン**（.NET 11 ではこれがデフォルト）が、シングルトンから消費される場合。
- **`IOptionsSnapshot<T>`** は **scoped** です。`IOptionsSnapshot<T>` に依存するシングルトンは検証で落ちます。代わりに `IOptionsMonitor<T>`（シングルトン）を使ってください。変更はコンストラクターの 1 行編集です。
- **scoped として登録された MediatR / `ISender`。** ホスト型サービスからの `Mediator.Send` はスコープを通じて実行する必要があります。
- **キャプチャした `IServiceProvider` を保持する EF Core インターセプター。** キャプチャしたルートプロバイダーではなく、スコープに優しい登録オーバーロードを使ってください。

## 名前を付けておく価値のあるエッジケース

- **シングルトンに注入された `IServiceProvider`。** 合法ですが、受け取るプロバイダーは **ルート** プロバイダーです。そこから scoped を解決すると同じ例外が出ます。scoped を解決する必要があるなら、代わりに `IServiceScopeFactory` を要求して `CreateScope()` を呼んでください。
- **手動登録された `Func<T>` ファクトリー。** `T` が scoped でファクトリーがシングルトンにキャプチャされる場合、ファクトリーは見た目は問題ありませんが、スコープ外から最初に呼ばれた瞬間に吹き飛びます。手動ファクトリーを `IServiceScopeFactory` プラス `GetRequiredService<T>()` に置き換えてください。
- **スコープ検証を無効化するテストホスト。** `WebApplicationFactory<T>` は .NET 8+ ではデフォルトで検証を有効に保ちます。テストが通り本番が落ちるなら、テストホストに `ValidateScopes = false` を追加していないか確認してください。
- **Native AOT および trimmed ビルド。** スコープ検証は同じデフォルトのコンテナ上で動くため、AOT はこのルールを変えません。トリマーはキャプチャされたファクトリーの中でリフレクション経由でしか使われない型を削除することがあり、そのときの症状はキャプティブ例外ではなく `Unable to resolve` です。
- **ジェネリックホスト型サービス。** `AddHostedService<MyHostedService<MyArg>>()` は依然としてシングルトンです。バリデーターは閉じたジェネリックのコンストラクターを検査するため、scoped として登録された `IRepo<MyArg>` 型のコンストラクター引数は同じエラー経路を引き起こします。

## 関連

- これと対をなす登録エラー: [unable to resolve service for type while attempting to activate](/ja/2026/05/fix-unable-to-resolve-service-for-type-while-attempting-to-activate/)。
- シングルトン-with-スコープファクトリーパターンの実践例: [running a Semantic Kernel plugin from a BackgroundService](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/)。
- `DbContext` がスコープを誤って生き延びたときに次に当たる EF Core 例外: [a second operation was started on this context instance](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/)。
- スコープ検証を破らずにテスト時に DI を差し替える方法: [integration tests against a real SQL Server with Testcontainers](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)。
- 有効期間バグの隣によく現れる構成系の失敗モード: [no connection string named 'DefaultConnection' could be found](/ja/2026/05/fix-no-connection-string-named-defaultconnection/)。

## 出典

- Microsoft Learn, [Dependency injection guidelines: scope validation](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines#scope-validation)。
- Microsoft Learn, [Dependency injection in .NET](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection)。
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor)。
- ASP.NET Core ソース, [`CallSiteValidator.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/CallSiteValidator.cs)。キャプティブ依存のチェックが発火する場所。
- ASP.NET Core ソース, [`ServiceProviderEngineScope.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs)。ルートとスコープの区別が強制される場所。
