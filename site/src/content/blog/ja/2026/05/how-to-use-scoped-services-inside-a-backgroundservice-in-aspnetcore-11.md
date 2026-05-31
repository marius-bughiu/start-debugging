---
title: "ASP.NET Core 11 で BackgroundService 内から scoped サービスを使う方法"
description: "BackgroundService はシングルトンなので、DbContext のような scoped サービスを直接注入できません。IServiceScopeFactory を受け取り、CreateAsyncScope で作業単位ごとに scope を開き、その中で解決し、作業が終わったら破棄します。"
pubDate: 2026-05-31
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "dependency-injection"
  - "backgroundservice"
lang: "ja"
translationOf: "2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-05-31
---

`BackgroundService` はシングルトンとして登録されるため、`DbContext` のような scoped サービスをそのコンストラクターに直接注入すると、起動時に `Cannot consume scoped service 'X' from singleton 'Y'` がスローされるか、さらに悪いことに、その scoped インスタンスがプロセス全体のライフタイムに固定されてしまいます。解決策は、`IServiceScopeFactory` を注入し、`ExecuteAsync` 内で作業単位ごとに `CreateAsyncScope()` で新しい scope を開き、その scope のプロバイダーから scoped サービスを解決し、作業が終わったら scope を破棄することです。本ガイドは .NET 11（執筆時点では preview 4、一般提供は 2026 年 11 月を予定）、`Microsoft.Extensions.Hosting` 11.0.0、EF Core 11 を対象に書かれています。`BackgroundService` と `IServiceScopeFactory` の契約は .NET Core 3.1 以来安定しているため、ここで紹介するすべてのパターンは .NET 6、8、10 にも変更なく当てはまります。

## なぜ BackgroundService は scoped サービスをそのまま注入できないのか

`AddHostedService<T>` で登録するすべてのホステッドサービスはシングルトンです。これは上書きできるデフォルト値ではありません。`AddHostedService<T>` と `AddSingleton<IHostedService, T>` は同じ登録に解決され、ホストは `StartAsync` の間に**ルート**プロバイダーからインスタンスを取得します。ルートプロバイダーには周囲の scope がありません。

scoped サービスは定義上、scope ごとに 1 回だけ生存します。Web リクエストでは、その scope はリクエストごとに作成され破棄されます。`BackgroundService` はホストのライフタイム全体にわたって実行され、いかなるリクエストからも完全に外れています。したがって、ランタイムが scoped 依存関係を解決する対象となる scope が存在しません。`OrderWorker(AppDbContext db)` のようなコンストラクターを書くと、次の 2 つのいずれかが起こります。

- `Development` では、`WebApplication.CreateBuilder` が `ValidateScopes` を有効にし、コールサイトバリデーターがビルド時にグラフをたどり、シングルトンに流れ込む scoped サービスを検出して `Cannot consume scoped service ...` をスローします。これがまさにあなたがここにたどり着いた例外であれば、専用ガイドの [シングルトンから scoped サービスを使用できない](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) があらゆる形態を解説しています。
- `Production` では scope の検証はデフォルトで無効なので、同じコードがビルドされ実行されます。`DbContext` はプロセスの生存期間にわたって捕捉されます。その変更トラッカーは読み込んだすべてのエンティティを蓄積し、その接続はプールにきれいに戻らず、遅かれ早かれ `ObjectDisposedException` や古い読み取りに突き当たります。

どちらの結果も望ましくありません。正しいモデルはこうです。シングルトンのワーカーがループとキャンセルを所有し、各反復が実際の作業を行うために短命の scope を借りるのです。

## scoped 解決を 4 ステップでセットアップする

Microsoft 自身の [ワーカーサービスのガイダンス](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) は、実際の作業を scoped サービスに委譲し、`BackgroundService` 自体は薄く保つことを推奨しています。完全な形を 4 ステップで示します。

1. **scoped サービスを `AddScoped` で登録します**。リクエストにバインドされたコンシューマーの場合とまったく同じです。バックグラウンドコンテキストで使われるからといって特別なことは必要ありません。
2. **ワーカーを `AddHostedService<T>` で登録します**。これはシングルトンのままです。scoped にしようとしないでください。
3. **`IServiceScopeFactory` を注入します**（scoped サービスでも `IServiceProvider` でもなく）。ワーカーのコンストラクターに対してです。
4. **作業単位ごとに scope を開きます**。`ExecuteAsync` 内で `CreateAsyncScope()` を使い、`scope.ServiceProvider` から scoped サービスを解決し、作業を行い、`await using` に scope を破棄させます。

### ステップ 1 と 2: 登録

```csharp
// .NET 11, C# 14 - Program.cs
using App.Workers;

var builder = WebApplication.CreateBuilder(args);

// The scoped unit of work. Registered exactly like any request-scoped service.
builder.Services.AddScoped<IOrderProcessor, OrderProcessor>();

// The worker stays a singleton. AddHostedService always registers a singleton.
builder.Services.AddHostedService<OrderWorker>();

var app = builder.Build();
app.Run();
```

### ステップ 3 と 4: ワーカー

```csharp
// .NET 11, C# 14
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace App.Workers;

public sealed class OrderWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<OrderWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("OrderWorker started.");

        while (!stoppingToken.IsCancellationRequested)
        {
            // One scope per iteration: a fresh DbContext, change tracker, and
            // connection scope every time, disposed at the end of the block.
            await using var scope = scopeFactory.CreateAsyncScope();

            var processor = scope.ServiceProvider
                .GetRequiredService<IOrderProcessor>();

            await processor.ProcessPendingAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}
```

実際のロジックと scoped 依存関係をすべて保持する scoped サービス:

```csharp
// .NET 11, C# 14
namespace App.Workers;

public interface IOrderProcessor
{
    Task ProcessPendingAsync(CancellationToken cancellationToken);
}

public sealed class OrderProcessor(
    AppDbContext db,                 // scoped, injected normally now
    ILogger<OrderProcessor> logger) : IOrderProcessor
{
    public async Task ProcessPendingAsync(CancellationToken cancellationToken)
    {
        var pending = await db.Orders
            .Where(o => o.Status == OrderStatus.Pending)
            .ToListAsync(cancellationToken);

        foreach (var order in pending)
        {
            order.Status = OrderStatus.Processed;
        }

        await db.SaveChangesAsync(cancellationToken);
        logger.LogInformation("Processed {Count} orders.", pending.Count);
    }
}
```

`OrderProcessor` は `AppDbContext` を直接注入します。これは自身が scoped であり、scope 内からのみ解決されるからです。シングルトンのワーカーは `DbContext` を一切目にしません。この分離こそがすべてのコツです。scoped グラフがルートからではなく実際の scope から解決された瞬間に、ライフタイムの不一致は消え去ります。

## CreateAsyncScope と CreateScope の違い

ほぼすべての現代的なコードでは、`CreateScope()` ではなく `CreateAsyncScope()` を使ってください。違いは破棄にあります。

`CreateScope()` は `IServiceScope` を返し、その scoped サービスを `IDisposable.Dispose()` を通じて同期的に破棄します。`CreateAsyncScope()` は `AsyncServiceScope` を返し、サービスが実装している場合は `IAsyncDisposable.DisposeAsync()` を通じて破棄し、実装していない場合は同期的な破棄にフォールバックします。

これが重要なのは、.NET 11 の EF Core の `DbContext` が `IAsyncDisposable` を実装しており、いくつかの構成（プールされたコンテキスト、開いた `DbConnection` を保持するコンテキスト）は同期的に破棄するとスローするからです。`using var scope = scopeFactory.CreateScope();` と書き、その scope に非同期破棄を必要とするコンテキストが含まれていると、実際の作業とはまったく無関係な例外がブロックの末尾で発生します。

```csharp
// .NET 11 - prefer this
await using var scope = scopeFactory.CreateAsyncScope();

// Only use the sync form when nothing in the scope needs async disposal
using var syncScope = scopeFactory.CreateScope();
```

何も非同期破棄を必要としない場合、`CreateScope()` に対する `CreateAsyncScope()` のコストは実質ゼロなので、デフォルトで同期版に手を伸ばす理由はありません。

## scope はプロセスごとに 1 つではなく、作業単位ごとに 1 つ

`IServiceScopeFactory` に切り替えた後の最も一般的な誤りは、scope をループの外に持ち上げることです。

```csharp
// .NET 11 - WRONG. The scope lives for the whole process.
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    await using var scope = scopeFactory.CreateAsyncScope();      // created once
    var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();

    while (!stoppingToken.IsCancellationRequested)
    {
        await processor.ProcessPendingAsync(stoppingToken);       // same DbContext forever
        await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
    }
}
```

これはコンパイルされ、scope の検証を通過し、修正しようとしていたまさにそのバグを再導入します。一度だけ解決された `DbContext` は、いまやワーカーのライフタイム全体にわたって生存します。その変更トラッカーは反復ごとに際限なく成長し、追跡されるグラフが拡大するにつれてクエリは遅くなり、1 回失敗した `SaveChanges` がコンテキストを以降のすべての反復を汚染する状態に陥れることがあります。また、2 つの反復が重なった瞬間に [「コンテキストインスタンスで 2 つ目の操作が開始された」エラー](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/) への扉を再び開いてしまいます。

scope はループの**内側**で作成してください。scope は安価です。このパターンの要点は、各作業単位がまっさらな状態を得ることです。新しいコンテキスト、新しい変更トラッカー、そして反復の終わりにプールから取り出して返される接続です。

## キューを排出するワーカーでの scoped サービス

反復ごとの scope は、`Channel<T>` を排出するワーカーへ自然に一般化されます。キューから取り出された各アイテムはそれ自体が作業単位なので、それぞれが自身の scope を得ます。

```csharp
// .NET 11, C# 14
using System.Threading.Channels;

public sealed class OrderQueueWorker(
    Channel<int> queue,
    IServiceScopeFactory scopeFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var orderId in queue.Reader.ReadAllAsync(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider
                .GetRequiredService<IOrderProcessor>();

            await processor.ProcessOneAsync(orderId, stoppingToken);
        }
    }
}
```

`ReadAllAsync` はすでにキャンセルトークンを尊重するため、シャットダウン時にループはきれいに巻き戻されます。各メッセージは隔離された状態で処理され、ある scope 内で例外をスローする毒メッセージが、次の scope で使われるコンテキストを破損させることはありません。

## EF Core: IServiceScopeFactory と IDbContextFactory の比較

必要な scoped 依存関係が `DbContext` **だけ**の場合、EF Core はより直接的な道具を提供します。`IDbContextFactory<T>` です。`AddDbContextFactory` で登録し（これはファクトリーをシングルトンとして登録します）、ファクトリーをワーカーに直接注入します。

```csharp
// .NET 11, EF Core 11 - Program.cs
builder.Services.AddDbContextFactory<AppDbContext>(options =>
    options.UseSqlServer(builder.Configuration.GetConnectionString("Default")));
```

```csharp
// .NET 11, EF Core 11
public sealed class OrderWorker(
    IDbContextFactory<AppDbContext> dbFactory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);

            var pending = await db.Orders
                .Where(o => o.Status == OrderStatus.Pending)
                .ToListAsync(stoppingToken);

            // process...
            await db.SaveChangesAsync(stoppingToken);

            await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
        }
    }
}
```

判断基準は単純です。作業単位に **`DbContext` だけ**が必要なら、`IDbContextFactory<T>` を使ってください。scope の儀式は不要で、ファクトリーは呼び出しごとに新しく正しく破棄されるコンテキストを渡してくれます。作業単位に scoped サービスのグラフ（リポジトリ、テナントリゾルバー、`IOptionsSnapshot<T>`、それ自体がコンテキストに依存するドメインサービス）が必要なら、`IServiceScopeFactory` を使って、グラフ全体が単一の scope 内で一貫して解決されるようにしてください。同じアプリケーション内で、リクエストにバインドされたコード向けに `AddDbContext` を、ワーカー向けに `AddDbContextFactory` を登録できます。

## scope はスレッドセーフではない: 並列処理にはタスクごとに scope が必要

アイテムを並列処理する場合、並列タスク間で単一の scope を共有しないでください。`DbContext` はスレッドセーフではなく、scope の解決もそうではありません。各並列分岐に自身の scope を与えてください。

```csharp
// .NET 11, C# 14
await Parallel.ForEachAsync(
    orderIds,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 4,
        CancellationToken = stoppingToken
    },
    async (orderId, ct) =>
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var processor = scope.ServiceProvider
            .GetRequiredService<IOrderProcessor>();
        await processor.ProcessOneAsync(orderId, ct);
    });
```

本体の各呼び出しは、独立した scope、独立した `DbContext`、独立した変更トラッカーを得ます。これはまさに並行作業に必要な隔離です。

## グレースフルなシャットダウンと StopAsync

`stoppingToken` は、ホストがシャットダウンを開始したときにシグナルされます。scope 内のすべての非同期呼び出し（クエリ、`SaveChanges`、`Task.Delay`）にこれを渡すことが、ワーカーがホストのシャットダウンタイムアウト（デフォルトで 30 秒）までシャットダウンをブロックする代わりに速やかに停止できるようにする仕組みです。

ホストの停止時にクリーンアップを行う必要がある場合は、`StopAsync` をオーバーライドして基底実装を呼び出します。

```csharp
// .NET 11, C# 14
public override async Task StopAsync(CancellationToken cancellationToken)
{
    logger.LogInformation("OrderWorker stopping, draining in-flight work.");
    await base.StopAsync(cancellationToken);
}
```

一つの細かい点として、`stoppingToken` を無視するループ内の長いブロッキング呼び出しは中断されず、ホストはプロセスを解体する前に完全なシャットダウンタイムアウトを待ちます。作業単位が長く実行される可能性がある場合は、トークンを最後まで通してください。キャンセルに協力しない作業を停止するという関連する問題については、[デッドロックなしで C# の長時間実行 Task をキャンセルする](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking) を参照してください。

## scope の検証を生き延びる誤り

これらはすべてコンパイルされ `ValidateScopes` を通過するため、名前を挙げる価値があります。

- **`IServiceScopeFactory` の代わりに `IServiceProvider` を注入する。** シングルトンに注入されるプロバイダーはルートプロバイダーです。それから scoped サービスを解決すると、検証設定に応じてスローするか捕捉します。常に `IServiceScopeFactory` を注入し `CreateAsyncScope()` を呼び出してください。
- **scope 内で捕捉したルートプロバイダーから解決する。** `_rootProvider.GetRequiredService<T>()` ではなく `scope.ServiceProvider.GetRequiredService<T>()` と書いてください。自分が開いた scope の中でルートから解決するのは、scope を完全に無意味にします。
- **解決した scoped サービスをフィールドに保存する。** インスタンスは scope より長く生存してはなりません。メソッドパラメーターとして渡し、`await using` とともに scope から外れさせてください。
- **`await using` を忘れる。** 破棄のない単なる `var scope = scopeFactory.CreateAsyncScope();` は、プロセスのライフタイム全体にわたって scope とその中のすべてのサービスをリークします。

本番で実行するつもりのワーカーには、このパターンを適切なオブザーバビリティと組み合わせて、行き詰まったり静かに失敗したりするループが表面化するようにしてください。[Hangfire なしでバックグラウンドジョブを監視する](/ja/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts) のアプローチが直接当てはまります。また、自明でない依存関係を取り巻く同じ scope factory パターンの完全な実例については、[BackgroundService から Semantic Kernel プラグインを実行する](/2026/05/how-to-run-a-semantic-kernel-plugin-from-a-backgroundservice/) を参照してください。

これを正しく保つメンタルモデルはこうです。シングルトンがループとキャンセルを所有し、scope が作業と単位ごとの状態を所有します。この 2 つの責務を分けて保てば、ライフタイムのエラーはそもそも現れません。

## 出典

- Microsoft Learn, [Use scoped services within a BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service)（2026-05-27 更新）、ワーカーサービスの定番チュートリアル。
- Microsoft Learn, [Dependency injection in .NET: service lifetimes](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection#service-lifetimes)。
- Microsoft Learn, [`AsyncServiceScope` and `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope)。
- Microsoft Learn, [Using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor)。
- .NET Blog, [.NET 11 Preview 1 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-1/)。
