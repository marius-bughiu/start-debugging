---
title: "ASP.NET Core で BackgroundService を使って fire-and-forget の処理を安全に実行する方法"
description: "コントローラーから Task.Run を呼ぶと、シャットダウン時に処理が失われ、例外が握りつぶされ、すでに破棄された scoped サービスを参照してしまいます。安全なパターンは、BackgroundService が排出する境界付き Channel キューであり、作業項目ごとに新しい scope を開き、StopAsync で実行中の処理を完了させます。"
pubDate: 2026-05-31
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "backgroundservice"
  - "async"
lang: "ja"
translationOf: "2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice"
translatedBy: "claude"
translationDate: 2026-05-31
---

HTTP リクエストをすぐに返しつつ、何らかの遅い処理 (メール送信、監査レコードの書き込み、webhook の呼び出し) を裏で実行し続けたいと思った瞬間、明白な手段はコントローラー内の `_ = Task.Run(() => DoTheWorkAsync())` です。コンパイルは通り、レスポンスは速く、デモでは動いているように見えます。本番環境では、デプロイのたびに処理が失われ、すべての例外を握りつぶし、すでに破棄された scoped サービスに手を伸ばします。安全な代替手段は、singleton として登録された境界付きの `Channel<T>` キューであり、単一の `BackgroundService` がそれを排出し、作業項目ごとに新しい DI scope を開き、項目ごとに例外を捕捉してログに記録し、グレースフルなシャットダウン中に実行中の処理を完了させます。このガイドは .NET 11 (執筆時点では preview 4、一般提供は 2026 年 11 月を予定)、`Microsoft.Extensions.Hosting` 11.0.0、および組み込みの BCL の `System.Threading.Channels` を対象に書かれています。キューと `BackgroundService` のコントラクトは .NET Core 3.1 以降安定しているため、ここにあるすべてのパターンは .NET 6、8、10 にもそのまま適用できます。

## なぜリクエストハンドラー内の `Task.Run` が罠なのか

`Task.Run` の魅力は、即座に返り、フレームワークがそれをブロックすることが決してない点です。まさにそれが問題です。フレームワークはそれをブロックせず、追跡せず、待機しません。

そこから 3 つの具体的な失敗が生じます。

- **シャットダウン時に失われる処理。** ホストがシャットダウンするとき (デプロイ、スケールイン、クラッシュした兄弟 pod がローリング再起動を引き起こすなど)、ホストはあなたの切り離された `Task` の存在を知りません。ホストはリクエストの受け付けをやめ、認識しているリクエストを待ち、プロセスを解体します。まだ実行中の `Task.Run` の処理は、実行の途中で kill されます。負荷の高いサービスでは、デプロイのたびにいくつかのメールや監査行が静かに捨てられます。
- **握りつぶされる例外。** 切り離された `Task` 内の観測されない例外は、アプリケーションをクラッシュさせず、ログのパイプラインにも届きません。もし現れるとしても、リクエストが消えてからずっと後に、ファイナライザースレッドで `TaskScheduler.UnobservedTaskException` として現れます。処理が失敗していることを最初に知るのは、顧客がメールがどこに行ったのか尋ねてきたときです。
- **キャプチャされた、破棄済みの依存関係。** これは微妙なものです。コントローラーが注入された `DbContext` や任意の scoped サービスをクロージャに取り込むと、そのサービスはリクエストの scope に結び付けられます。ASP.NET Core はレスポンスが書き込まれた瞬間にリクエストの scope を破棄します。まだ実行中のあなたの `Task.Run` の本体は、破棄された `DbContext` に触れて `ObjectDisposedException: Cannot access a disposed context instance` をスローします。さらに悪い場合は、破棄と競合して状態を破壊します。

負荷の側面もあります。リクエストごとに `Task.Run` を起動するコントローラーは、リクエストを処理するのと同じスレッドプールを奪い合うため、トラフィックの急増がスレッドプールの枯渇に変わります。`Task.Run` が他のオフロード用プリミティブとどう異なるかの完全な内訳が必要なら、[Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/ja/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) の比較がそれぞれがいつ適切かを扱っています。リクエストハンドラーについては、答えは「どれも直接には使わない」です。

fire-and-forget が許容されるのは、再起動時に処理が失われても本当に問題ない場合だけです。下記のパターンは処理を永続化しません (そのためには Azure Storage Queues のような外部キューや、データベースに裏打ちされたジョブストアが必要です) が、他の 3 つの問題を解決し、メモリ内の処理にクリーンなシャットダウン時の排出を与えます。

## 安全なパターンの形

Microsoft 自身の [キューに入れられたバックグラウンドタスクのガイダンス](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) が標準的な構造を説明しており、それは 3 つの部分から成ります。

1. 境界付きの `Channel<Func<CancellationToken, ValueTask>>` に裏打ちされた **作業項目キュー**。プロデューサーとコンシューマーが 1 つのインスタンスを共有できるよう、singleton として登録します。
2. ループし、一度に 1 つの作業項目を取り出し、DI scope を開いて実行し、項目ごとに例外を捕捉する、単一の **`BackgroundService` コンシューマー**。
3. キューのインターフェースを注入し、デリゲートをインラインで実行する代わりにキューに入れる **プロデューサー** (コントローラー、minimal API ハンドラー、その他のサービス)。

リクエストハンドラーは、作業項目がキューに入れられた瞬間に返ります。処理自体はコンシューマー上で実行され、リクエストの生存期間から完全に切り離されます。各部分を組み立てましょう。

## ステップ 1: 境界付きキューを定義して実装する

キューは 2 つの操作を公開します。エンキュー (プロデューサーが呼ぶ) とデキュー (コンシューマーが呼ぶ) です。作業項目は `Func<CancellationToken, ValueTask>` であり、コンシューマーが実行時に自分のキャンセルトークンを渡せるようにします。

```csharp
// .NET 11, C# 14 - IBackgroundTaskQueue.cs
public interface IBackgroundTaskQueue
{
    ValueTask QueueBackgroundWorkItemAsync(Func<CancellationToken, ValueTask> workItem);

    ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken);
}
```

実装は境界付き channel をラップします。本番サービスで channel を境界付きにすることは任意ではありません。コンシューマーを追い越すプロデューサーの下にある境界なしのキューは、手間が増えただけのメモリリークです。

```csharp
// .NET 11, C# 14 - BackgroundTaskQueue.cs
using System.Threading.Channels;

public sealed class BackgroundTaskQueue : IBackgroundTaskQueue
{
    private readonly Channel<Func<CancellationToken, ValueTask>> _queue;

    public BackgroundTaskQueue(int capacity)
    {
        // BoundedChannelFullMode.Wait makes QueueBackgroundWorkItemAsync await
        // a free slot once the queue is full, applying back pressure to producers
        // instead of dropping work or growing without bound.
        var options = new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait
        };
        _queue = Channel.CreateBounded<Func<CancellationToken, ValueTask>>(options);
    }

    public async ValueTask QueueBackgroundWorkItemAsync(
        Func<CancellationToken, ValueTask> workItem)
    {
        ArgumentNullException.ThrowIfNull(workItem);
        await _queue.Writer.WriteAsync(workItem);
    }

    public async ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken)
    {
        var workItem = await _queue.Reader.ReadAsync(cancellationToken);
        return workItem;
    }
}
```

`BoundedChannelFullMode` の選択は、実際の設計上の判断です。`Wait` (上記) はプロデューサーにバックプレッシャーをかけます。リクエストハンドラーにとっては、エンキューの呼び出しが空きができるまで待機することを意味します。リクエストを待たせるよりも負荷を捨てたい場合は、`BoundedChannelFullMode.DropWrite` を使い、`TryWrite` の戻り値を確認します。どちらを選ぶにせよ、意図的に行ってください。channel が初めてなら、[BlockingCollection の代わりに Channels を使う](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) が reader/writer モデルと、なぜ `Channel<T>` がモダンな .NET における正しい非同期のプロデューサー・コンシューマープリミティブなのかを説明しています。

## ステップ 2: キューを排出する BackgroundService

コンシューマーは単一の `BackgroundService` です。その唯一の仕事は、一度に 1 つの作業項目を取り出し、try/catch の中で実行することです。これにより、1 つの毒となる作業項目がループを kill できないようにします。

```csharp
// .NET 11, C# 14 - QueuedHostedService.cs
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

public sealed class QueuedHostedService(
    IBackgroundTaskQueue taskQueue,
    ILogger<QueuedHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is running.");
        await BackgroundProcessing(stoppingToken);
    }

    private async Task BackgroundProcessing(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var workItem = await taskQueue.DequeueAsync(stoppingToken);

            try
            {
                await workItem(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Expected during shutdown; let the loop unwind.
                break;
            }
            catch (Exception ex)
            {
                // The whole point: one failing item is logged, not lost, and the
                // loop survives to process the next item.
                logger.LogError(ex, "Error occurred executing background work item.");
            }
        }
    }

    public override async Task StopAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is stopping.");
        await base.StopAsync(stoppingToken);
    }
}
```

項目ごとの try/catch が、これと `Task.Run` の違いです。`Task.Run` では例外は観測されないままです。ここでは、すべての失敗がスタックトレースとともに `ILogger` に届き、コンシューマーは排出を続けます。これはまた、作業項目が `async void` デリゲートではなく `ValueTask` を返す `Func` である理由でもあります。`async void` の本体は虚空にスローし、握りつぶされる例外に逆戻りします。`async void` と `async Task` の区別が曖昧なら、[C# における async void vs async Task](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) が、なぜ `async void` がイベントハンドラーのために予約され、それ以外には使われないのかを正確に説明しています。

## ステップ 3: すべてを登録する

キューは singleton (共有される単一インスタンス) で、コンシューマーは hosted service であり、容量はあなたが選びます。容量は、一度にメモリ内に保持してよい処理の量を反映すべきです。

```csharp
// .NET 11, C# 14 - Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueuedHostedService>();
builder.Services.AddSingleton<IBackgroundTaskQueue>(_ =>
{
    // Tune to your workload. 100 means at most 100 queued items before
    // producers start waiting (with BoundedChannelFullMode.Wait).
    const int queueCapacity = 100;
    return new BackgroundTaskQueue(queueCapacity);
});

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();
```

## ステップ 4: リクエストハンドラーからエンキューし、作業項目ごとに scope を持つ

次はプロデューサーです。コントローラーは `IBackgroundTaskQueue` を注入し、デリゲートをキューに入れます。重要な点として、デリゲートはリクエストの scoped サービスを**いっさい**クロージャに取り込んではいけません。処理が実行されるころには、リクエストの scope はなくなっています。代わりに、単純なデータ (注文 ID、文字列) だけをキャプチャし、デリゲート内で `IServiceScopeFactory` を使って新しい scope から scoped サービスを解決します。

```csharp
// .NET 11, C# 14 - OrdersController.cs
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

[ApiController]
[Route("orders")]
public sealed class OrdersController(
    IBackgroundTaskQueue queue,
    IServiceScopeFactory scopeFactory) : ControllerBase
{
    [HttpPost("{id:int}/confirm")]
    public async Task<IActionResult> Confirm(int id)
    {
        // Capture only the id - a value type, not a scoped service.
        await queue.QueueBackgroundWorkItemAsync(async token =>
        {
            // Fresh scope per work item: a clean DbContext, resolved and disposed here.
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
            await processor.ConfirmAsync(id, token);
        });

        // Returns immediately; the confirmation runs on the consumer.
        return Accepted();
    }
}
```

ここでは `HTTP 202 Accepted` が誠実なステータスコードです。リクエストを処理のために受け付けたのであって、完了したわけではありません。`200 OK` を返すと処理が完了したことを示唆しますが、そうではありません。

作業項目ごとに 1 つの scope というルールは、singleton が scoped サービスに触れるあらゆる場所で必要となるのと同じ規律です。作業単位ごとに 1 つの `CreateAsyncScope()` を開き、その中で解決し、処理が終わったら破棄することは、[BackgroundService 内で scoped サービスを使う](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) で詳しく扱っています。`await using` と `CreateAsyncScope()` が (同期の `CreateScope()` ではなく) 重要な理由は、EF Core の `DbContext` が `IAsyncDisposable` を実装しており、同期的に破棄するとスローする可能性があるためです。

scope を省略して、代わりにリクエストの `DbContext` をデリゲート内で直接キャプチャすると、この記事の冒頭にあった破棄済み依存関係のバグをそのまま再現します。さらに、後続のリクエストがフレームワークが解放済みと考えるコンテキストを再利用するとき、しばしば [コンテキストインスタンスでの 2 番目の操作のエラー](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/) を再現します。また、物事を「単純化」するために scoped サービスを singleton コンシューマーに直接注入しようとすると、起動時に [singleton から scoped サービスを消費できない](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) に突き当たります。

## グレースフルなシャットダウン: 排出するか、放棄するか

ここがパターンが `Task.Run` に対して真価を発揮するところです。`BackgroundService` はホストのシャットダウンシーケンスに参加します。ホストが停止するとき、ホストは `stoppingToken` をシグナルし、`StopAsync` が返るまでシャットダウンタイムアウト (既定で 30 秒) を上限として待機します。

2 つの挙動について、意図的に決めておく価値があります。

**受け付けをやめ、現在の項目を完了させる。** 上記のループでは、トークンが発火すると `DequeueAsync(stoppingToken)` が `OperationCanceledException` をスローし、ループが break し、その時点で実行中の作業項目は完了します (ループに戻る前に `await workItem(stoppingToken)` を行っているため)。channel にまだ残っている項目は放棄されます。メモリ内の fire-and-forget では、これが受け入れられるトレードオフです。

**実行中の処理に十分な時間を与える。** 作業項目が数秒以上実行される可能性があるなら、ホストが途中の項目を kill しないように、シャットダウンタイムアウトを引き上げます。

```csharp
// .NET 11, C# 14 - Program.cs
builder.Services.Configure<HostOptions>(options =>
{
    options.ShutdownTimeout = TimeSpan.FromSeconds(60);
});
```

処理をリクエストではなくアプリケーションの生存期間に結び付ける必要があるプロデューサーは、`IHostApplicationLifetime` を受け取って `ApplicationStopping` に対してエンキューできますが、リクエスト発の処理には、コンシューマーの `stoppingToken` が正しいシグナルです。何をするにせよ、トークンを作業項目の最後まで通してください。トークンを無視してブロックする作業項目は、タイムアウトいっぱいまでシャットダウン全体を人質に取ります。協調的にキャンセルできない処理については、[デッドロックなしで長時間実行の Task をキャンセルする](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) が選択肢を扱っています。

## scope を共有せずに項目を並列処理する

単一コンシューマーのループは、一度に 1 つの項目を処理します。作業項目が独立していてスループットがほしい場合は、複数を並行して実行できますが、`DbContext` と DI scope はスレッドセーフではないため、並行する各項目は自分自身の scope を取得しなければなりません。エンキューの急増がスレッドプールを飽和させないよう、`SemaphoreSlim` で並行数を制限します。

```csharp
// .NET 11, C# 14 - inside BackgroundProcessing
private readonly SemaphoreSlim _concurrency = new(initialCount: 4);

private async Task BackgroundProcessing(CancellationToken stoppingToken)
{
    while (!stoppingToken.IsCancellationRequested)
    {
        var workItem = await taskQueue.DequeueAsync(stoppingToken);
        await _concurrency.WaitAsync(stoppingToken);

        // Fire each item on its own task; the semaphore caps concurrency at 4.
        _ = Task.Run(async () =>
        {
            try
            {
                await workItem(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error executing background work item.");
            }
            finally
            {
                _concurrency.Release();
            }
        }, stoppingToken);
    }
}
```

ここでの `Task.Run` は、コントローラーでは許容できなかったのとは異なり、許容できる点に注目してください。これは追跡される `BackgroundService` の内部にあり、すべての例外が捕捉されてログに記録され、並行数が制限され、各作業項目はすでに内部で自分の scope を作成しています。`Task.Run` をリクエストハンドラーで危険にしていたもの (追跡なし、例外処理なし、キャプチャされたリクエスト scope) は、ここにはありません。トレードオフは、並列処理がシャットダウンの話を複雑にすることです。実行中のタスクがもはやループによって待機されないためです。並列性とクリーンな排出の両方が必要なら、未処理のタスクを `List<Task>` で追跡し、`StopAsync` でそれらに対して `await Task.WhenAll` を行います。

## Channel キューでは不十分なとき

このパターンはすべてをプロセスのメモリ内に保持します。それが強み (外部インフラがゼロ) であり、限界でもあります。次の場合は、もっと重いものに手を伸ばしてください。

- **処理が再起動を生き延びる必要がある。** デプロイ時にキュー内の処理が失われることが許容できないなら、channel が与えられない永続性が必要です。ジョブをデータベーステーブルに永続化するか、Azure Storage Queues / Amazon SQS に push し、`BackgroundService` (または別のワーカープロセス) にそこから取り出させます。エンキュー/消費の形は同一のままで、変わるのはバッキングストアだけです。
- **複数のインスタンスを実行し、exactly-once が必要。** メモリ内キューはインスタンスごとです。3 つの pod は 3 つの独立したキューを意味します。協調するには、可視性タイムアウトのリースを持つ共有の永続キューが方法です。
- **再試行、スケジューリング、ダッシュボードが必要。** その時点で、Hangfire のようなライブラリやホストされたジョブプラットフォームがその複雑さに見合います。channel の上にジョブスケジューラーを再構築しないでください。

本番で維持する長命なワーカーには、キューに観測可能性を組み合わせ、行き詰まったり静かに失敗したりするコンシューマーがユーザーに気付かれる前に表面化するようにしてください。[Hangfire なしでバックグラウンドジョブを監視する](/ja/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) のアプローチが、このコンシューマーに直接適用できます。

これらすべてを正しく保つメンタルモデルはこうです。リクエストハンドラーの仕事は処理を *受け付けて* 返すこと、singleton コンシューマーは *ループとキャンセルを所有* し、各作業項目は *自分自身の状態のための新しい scope を所有* します。これらの責務を 1 つにつぶした瞬間 (処理をインラインで実行する、リクエストの scope をキャプチャする、追跡されない `Task` を切り離す) に、この記事の冒頭にあった 3 つの失敗のいずれかが戻ってきます。

## 参考資料

- Microsoft Learn, [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) (2026-05-05 更新)。この投稿が基づいている、キューに入れられたバックグラウンドタスクの標準パターン。
- Microsoft Learn, [System.Threading.Channels](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels)。`BoundedChannelOptions` と `BoundedChannelFullMode` について。
- Microsoft Learn, [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout)。グレースフルなシャットダウンの猶予時間を調整するため。
- Microsoft Learn, [`AsyncServiceScope` と `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope)。作業項目ごとの scope の破棄について。
