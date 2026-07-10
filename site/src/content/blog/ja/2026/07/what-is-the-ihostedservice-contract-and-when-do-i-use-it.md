---
title: "IHostedService の契約とは何か、いつ使うべきか"
description: "IHostedService は、.NET の汎用ホストが起動時とグレースフルシャットダウン時に呼び出す 2 つのメソッド (StartAsync/StopAsync) を持つインターフェースです。この契約が何を保証するのか、直接実装すべきなのはいつか、そして人がつまずく .NET 10 と 11 の動作変更を解説します。"
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "aspnetcore"
  - "csharp"
lang: "ja"
translationOf: "2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it"
translatedBy: "claude"
translationDate: 2026-07-10
---

`IHostedService` は、.NET の汎用ホストがアプリケーションと一緒に長寿命の処理を開始および停止するために使う、2 つのメソッドを持つインターフェースです。メンバーは `StartAsync(CancellationToken)` と `StopAsync(CancellationToken)` の 2 つだけで、ホストはそれらを明確に定義されたタイミングで呼び出します。すなわち `StartAsync` はアプリがリクエストの処理を始める前、`StopAsync` はグレースフルシャットダウンの間です。順序付けられた起動またはシャットダウンの手順を正確に制御する必要があるときには、これを直接実装します。連続的なループには、ほとんどの場合 `BackgroundService` が適しています。これは `IHostedService` を代わりに実装してくれる小さな抽象クラスです。この記事では、この契約が実際に何を保証するのか、生のインターフェースに手を伸ばすべきはいつか、そして人をつまずかせる .NET 10 と .NET 11 の動作変更を説明します。

ここで扱う内容はすべて .NET 11 と C# 14、`Microsoft.Extensions.Hosting` 11.0.x を対象としています。動作が特定のバージョンで変わった箇所は、その旨を明記します。

## 契約は 2 つのメソッドと順序の約束

これがインターフェースの全体です。

```csharp
// .NET 11, C# 14 -- Microsoft.Extensions.Hosting.Abstractions
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

これが表面のすべてです。これを有用にしているのはメソッドの形ではなく、ホストがそれらの周りに包む保証です。

- ホストは、アプリケーションが起動済みとみなされる**前に**、登録されたすべてのホステッドサービスの `StartAsync` を待機 (`await`) します。ASP.NET Core アプリでは、これは Kestrel が最初のリクエストを受け付ける前を意味します。
- デフォルトでは、サービスは**登録順に順次**起動します。ホストは、現在のサービスが返した `Task` が完了するまで、次のサービスの `StartAsync` を呼び出しません。
- シャットダウン時、ホストは各サービスの `StopAsync` を登録の**逆順**で呼び出し、それらが完了するまで `HostOptions.ShutdownTimeout` (デフォルトで 30 秒) まで待ちます。

順序の約束こそが重要である理由です。「どのリクエストもコールドパスに当たれる前にこのキャッシュを温めておく」あるいは「キューのコンシューマーが起動する前にこの接続を開く」といったことが必要なら、`StartAsync` が正しいフックです。なぜなら、それが制御を返すまでホストは先に進まないからです。

## StartAsync が高速でなければならない理由

起動はデフォルトで順次であるため、遅い `StartAsync` は、その後に登録されたすべてのサービスを遅らせ、アプリケーション全体がオンラインになるのを遅らせます。これは生のインターフェースで最もよくある間違いです。長寿命のループを `StartAsync` の中に直接置いて、決して制御を返さないというものです。

```csharp
// .NET 11, C# 14 -- WRONG: the host never finishes starting
public sealed class BrokenWorker : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // This loop never returns, so StartAsync never completes,
        // so the host never starts, so no requests are served.
        while (!ct.IsCancellationRequested)
        {
            await DoWorkAsync();
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

解決策は、`StartAsync` を「処理を開始して制御を返す」ものとして扱うことです。ループをバックグラウンドの `Task` として起動し、そのハンドルを保持し、`StopAsync` でそのハンドルを待機します。

```csharp
// .NET 11, C# 14 -- correct raw IHostedService with a background loop
public sealed class QueueDrainService(ILogger<QueueDrainService> logger) : IHostedService
{
    private readonly CancellationTokenSource _stopping = new();
    private Task? _loop;

    public Task StartAsync(CancellationToken ct)
    {
        // Return quickly. Capture the loop task; do not await it here.
        _loop = RunAsync(_stopping.Token);
        return Task.CompletedTask;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await DrainOnceAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _stopping.Cancel();
        // Wait for the loop to unwind, but respect the shutdown deadline.
        if (_loop is not null)
            await _loop.WaitAsync(ct).ConfigureAwait(false);
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

このパターンが定型コードに見えるなら、まさにそれが要点です。これは `BackgroundService` が取り除くために存在する定型コードなのです。

## BackgroundService の位置づけ

`BackgroundService` は同じ名前空間にある抽象クラスで、`IHostedService` を実装し、オーバーライドする単一のメソッドを与えてくれます。

```csharp
// .NET 11, C# 14 -- the shape BackgroundService hands you
public sealed class QueueDrainService(ILogger<QueueDrainService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await DrainOnceAsync(stoppingToken); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

基底クラスは `ExecuteAsync` が返したタスクを保持し、ホストが停止するときに `stoppingToken` をキャンセルし、自身の `StopAsync` であなたのループを待機します。これは上の生の例と同じライフサイクルであり、配管部分がないだけです。

したがって実用的なルールはこうです。**`IHostedService` を直接実装するのは、アプリがオンラインになる前に `StartAsync` の中で処理を完了させる必要があるとき、または `StopAsync` の中で順序付けられたシャットダウン処理が必要なときだけにしてください。** アプリが動いている間ただ動き続ければよい連続ループには、`BackgroundService` を使います。永続的なジョブシステムまで含めたより深い比較が欲しい場合は、[BackgroundService、IHostedService、Hangfire の決定マトリクス](/ja/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/)を参照してください。

## ExecuteAsync をメインスレッドから外した .NET 10 の変更

.NET 10 より前、`BackgroundService` には微妙な落とし穴がありました。`ExecuteAsync` の同期部分、つまり最初の `await` より前のすべては、起動中にメインスレッドで実行され、他のサービスの起動をブロックしていました。最初の `await` より後のコードだけがバックグラウンドスレッドに移っていたのです。

.NET 10 以降、[`BackgroundService` は `ExecuteAsync` の全体をバックグラウンドスレッドで実行する](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task)ため、その一部が他のサービスの起動をブロックすることはありません。これは歓迎すべき修正ですが、一部のコードが依存していた前提を変えます。最初の `await` より前に意図的にセットアップ処理を行って起動中に実行させていた場合、その処理は起動パスの外に出ました。

起動中に何かを再び同期的に実行させる必要がある場合、ドキュメントは選択肢を列挙しています。コンストラクターで行う、`StartAsync` をオーバーライドして `base.StartAsync` の前で実行する、`IHostedLifecycleService` (後述) を実装する、あるいは生の `IHostedService` に降りる、です。生のインターフェースにはこの曖昧さが元々なく、起動順序が本当に重要なときにそれを使うもう 1 つの理由になっています。

## より細かいフックのための IHostedLifecycleService

2 つの `StartAsync` フックでは足りない場合、.NET 8 は `IHostedLifecycleService` を追加しました。これは `IHostedService` をさらに 4 つのコールバックで拡張します。

```csharp
// .NET 11, C# 14 -- extends IHostedService with pre/post hooks
public interface IHostedLifecycleService : IHostedService
{
    Task StartingAsync(CancellationToken cancellationToken);
    Task StartedAsync(CancellationToken cancellationToken);
    Task StoppingAsync(CancellationToken cancellationToken);
    Task StoppedAsync(CancellationToken cancellationToken);
}
```

ホストは中心となる 2 つのメソッドの周りで、次の順序でこれらを呼び出します。すべてのサービスで `StartingAsync`、次にすべてのサービスで `StartAsync`、次にすべてのサービスで `StartedAsync` です。シャットダウンはそれを反映します。`StoppingAsync`、次に `StopAsync`、次に `StoppedAsync` です。単純な `IHostedService` との違いは、これらのフェーズが各サービスにまたがって*バッチ*として実行される点です。したがって `StartingAsync` は、自分自身の `StartAsync` だけでなく、**どの**サービスの `StartAsync` よりも前に起こる必要がある処理を実行する場所です。

これが必要になることはめったにありません。「どのサービスもネットワークリスナーを開く前に、各サービスが事前起動処理を終えていなければならない」といったサービス間の順序制約があるときに手を伸ばしてください。一般的なケースには、単純な `IHostedService` か `BackgroundService` で十分です。

## ホステッドサービスの登録

登録は 1 行で済み、DI のライフタイムは固定されています。

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueueDrainService>();
builder.Services.AddHostedService<CacheWarmer>();

var app = builder.Build();
app.Run();
```

`AddHostedService<T>` は、その型を **singleton** の `IHostedService` として登録します。これには、人が絶えずぶつかる帰結があります。スコープ付きサービス (プールされた `DbContext` など) をホステッドサービスのコンストラクターに直接注入することはできません。singleton はスコープ付きサービスに依存できないからです。代わりに `IServiceScopeFactory` を注入し、作業単位ごとにスコープを作成してください。この具体的な落とし穴とその正確な例外メッセージは、[なぜ singleton からスコープ付きサービスを利用できないのか](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)で扱っており、正しいスコープ処理のパターンは[BackgroundService の中でスコープ付きサービスを使う方法](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)にあります。

登録順は `StartAsync` の呼び出し順であり、`StopAsync` の呼び出しの逆順です。したがって、他のサービスがその起動に依存するサービスを先に登録してください。

## キャンセルトークンを尊重する

どちらのメソッドも `CancellationToken` を受け取りますが、意味は異なります。

`StartAsync` に渡されるトークンは、起動が中断されつつあることを示します。実際にはめったに発火しませんが、それでも行うあらゆる非同期呼び出しに通しておくべきです。そうすれば、遅い起動中の Ctrl+C が実際にそれをキャンセルします。

`StopAsync` に渡されるトークンこそが重要なものです。これはグレースフルシャットダウンの期限 (`HostOptions.ShutdownTimeout`、デフォルトで 30 秒) が過ぎたときにキャンセルされます。あなたの `StopAsync` がこれを無視して待ち続けると、ホストはいずれにせよプロセスを引き倒し、処理中の作業は失われます。したがってシャットダウンのロジックは、そのトークンが発火したら*すみやかに*停止し、すべてを終わらせようとする代わりに、できる範囲でフラッシュまたはチェックポイントを取るべきです。

```csharp
// .NET 11, C# 14 -- extend the shutdown window when your drain is slow
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(60));
```

タイムアウトを引き上げるのは、あなたの作業がきれいに片付くのに本当にもっと時間が必要な場合だけにしてください。トークンで正しくキャンセルすることのほうが重要な習慣であり、それは残りの非同期コードすべてでキャンセルを正しく行うことと対になります。これは[長時間実行される Task をデッドロックせずにキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)という独立したトピックです。

## 失敗時の終了コードに関する .NET 11 の変更

アップグレード時に最もあなたを驚かせそうな動作変更がこれです。`BackgroundService` が `ExecuteAsync` から未処理の例外をスローし、`HostOptions.BackgroundServiceExceptionBehavior` がデフォルトの `StopHost` のままだと、ホストは停止します。このデフォルトは .NET 6 から有効です (それ以前のデフォルトは `Ignore` で、生きているように見えるのに何の作業もしないゾンビホストを黙ってあなたに残していました)。

.NET 11 Preview 3 で変わったのは終了コードです。以前は、サービスがクラッシュしていても `RunAsync`、`StopAsync`、`WaitForShutdownAsync` が返すタスクは*成功*として完了していたため、プロセスは通常コード 0 で終了し、オーケストレーターはすべて問題ないと考えていました。.NET 11 以降、[これらのメソッドは例外で失敗する](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure)ようになり、プロセスは非ゼロで終了します。単一のサービスが失敗した場合はその例外が再スローされ、複数の失敗は `AggregateException` として返されます。

これはほぼ常にあなたが望む動作です。クラッシュしたバックグラウンドワーカーが成功を報告すべきではありません。しかし、古い静かな成功動作に依存したコードがあった場合、今や非ゼロの終了と、おそらく `Program.cs` の最上部での未処理の例外を目にすることになります。Microsoft が推奨する対応は、何もせず、大きな音を立てて失敗させることです。本当に古い動作が必要なら、`await host.RunAsync()` を try/catch で囲むか、例外動作を `Ignore` に戻してトレードオフを受け入れてください。

```csharp
// .NET 11, C# 14 -- opt back into the old, quieter behavior (usually a mistake)
builder.Services.Configure<HostOptions>(o =>
    o.BackgroundServiceExceptionBehavior =
        BackgroundServiceExceptionBehavior.Ignore);
```

私なら `Ignore` に手を伸ばしません。クラッシュしてホストを動作中だが何もしていない状態にできるホステッドサービスは、プロセスを引き倒してオーケストレーターに再起動されるものよりも、はるかに診断が困難です。より良い修正は、前述の例のようにループの中でキャッチしてログを取り、単一の失敗した反復が決して未処理の例外にならないようにすることです。

## 生のインターフェースが正しい選択になるとき

まとめると、次のときに `IHostedService` を直接実装してください。

- **アプリがトラフィックを処理する前に完了しなければならない**起動処理があるとき。キャッシュの温め、スキーマまたはマイグレーションのチェックの実行、接続プールの確立などです。それを `StartAsync` に置き、順次起動の保証に仕事をさせます。
- **特定の順序**で実行しなければならないシャットダウン処理があるとき。バッファのフラッシュ、サービスディスカバリーのエンドポイントからの登録解除、最後のメトリクスの送信などです。それを `StopAsync` に置きます。
- ライフサイクルが特殊で、基底クラスを信頼するよりも自分で読みたいという理由で、配管を明示的にしたいとき。

アプリの寿命の間ずっと動くループというはるかに一般的なケースには、`BackgroundService` を使ってください。複数のサービスにまたがるバッチの事前起動または事後シャットダウンのフェーズが必要なときだけ、`IHostedLifecycleService` を使ってください。そしてどれを選ぶにせよ、キャンセルトークンを尊重し、`StartAsync` を高速に保ち、失敗を表面化させてください。関連するパターンについては、[BackgroundService で fire-and-forget の処理を安全に実行する方法](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)を参照してください。

## 出典

- [IHostedService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedservice)
- [IHostedLifecycleService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedlifecycleservice)
- [Breaking change: BackgroundService runs all of ExecuteAsync as a Task (.NET 10)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task)
- [Breaking change: IHost.RunAsync and IHost.StopAsync throw when a BackgroundService fails (.NET 11)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure)
- [BackgroundServiceExceptionBehavior Enum -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.backgroundserviceexceptionbehavior)
