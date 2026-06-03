---
title: ".NET 11 のバックグラウンドジョブにおける BackgroundService vs IHostedService vs Hangfire"
description: "インプロセスのループには BackgroundService、ライフサイクルの細かな制御が必要なときは素の IHostedService、ジョブが再起動を生き延びる必要があるときは Hangfire を選びます。コード付きの決定マトリクスと、あなたの代わりに決めてくれる一点を示します。"
pubDate: 2026-06-03
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
lang: "ja"
translationOf: "2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-06-03
---

.NET 11 アプリでのバックグラウンド処理について、短い答えはこうです。継続的なインプロセスのループやキューのコンシューマーには `BackgroundService` を使い、明示的で順序づけられた起動や終了が必要なときだけ素の `IHostedService` まで降り、ジョブがプロセスの再起動を生き延びる必要があるとき、あるいは「来週の火曜午前 2 時」にスケジュールする必要があるときは Hangfire に手を伸ばします。最初の 2 つは同じホスティングのプリミティブを異なる高度で見たもので、追加コストはゼロです。Hangfire は背後にデータベースを持つ別個の依存関係であり、そのデータベースこそがあなたが支払っている対価です。この記事では決定マトリクスを組み立て、それぞれの最小限のコードを示し、たいてい代わりに決めてくれる唯一の要件、つまり永続性を指し示します。

すべての例は .NET 11 と C# 14 を対象とします。Hangfire の例は Hangfire 1.8.x（`Hangfire.AspNetCore` と `Hangfire.SqlServer`）を使います。

## 機能マトリクス

これがあなたの目当ての表です。まず「再起動を生き延びる」の行を読んでください。これが選択肢を二分する行です。

| 機能                             | IHostedService          | BackgroundService        | Hangfire                       |
| -------------------------------- | ----------------------- | ------------------------ | ------------------------------ |
| .NET 11 に組み込み               | はい                    | はい                     | いいえ（NuGet + ストレージ）   |
| 追加インフラ                     | なし                    | なし                     | SQL Server / Redis / Postgres  |
| ライフサイクルの面               | `StartAsync`/`StopAsync`| 1 つの `ExecuteAsync`    | なし（あなたがジョブを投入する）|
| 最適な用途                       | 起動/終了のステップ     | 長時間実行のループ       | 単発およびスケジュールされたジョブ|
| 再起動を生き延びる               | いいえ                  | いいえ                   | はい                           |
| 失敗時のリトライ                 | 自分で書く              | 自分で書く               | 自動、設定可能                 |
| スケジューリング（cron、遅延）   | 自分で書く              | 自分で書く               | 組み込み                       |
| 複数インスタンスでの実行         | 各インスタンスで実行    | 各インスタンスで実行     | 1 つの worker が各ジョブを取る |
| ダッシュボード / 可視性          | なし                    | なし                     | 組み込みの Web ダッシュボード  |
| コスト                           | 無料                    | 無料                     | OSS コア、一部 Pro ライセンス  |

`BackgroundService` は `IHostedService` の代替ではありません。それを実装する抽象クラスです。したがって本当の選択は二択です。インプロセスのホスティングサービス（その 2 つの形態のいずれか）か、外部の永続的なジョブシステムか。順番に見ていきましょう。

## IHostedService: 素のライフサイクル契約

`IHostedService` は、.NET の汎用ホストが起動時と終了時に呼び出す低レベルのインターフェースです。メソッドはちょうど 2 つあります。

```csharp
// .NET 11, C# 14
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

ホストは、最初のリクエストを処理する前に、登録された各サービスの `StartAsync` を登録順に待機（`await`）し、プロセスが終了する前に `StopAsync` を（`HostOptions.ShutdownTimeout`、デフォルトで 30 秒まで）待機します。この順序の保証こそ、素のインターフェースを使う理由です。トラフィックが到着する前に完了していなければならない処理（キャッシュのウォームアップ、一度きりのマイグレーションチェック、長寿命の接続のオープン）にふさわしい場所です。

```csharp
// .NET 11, C# 14
public sealed class CacheWarmer(IMemoryCache cache, IProductRepository repo) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // Runs to completion BEFORE the app starts serving requests.
        var hot = await repo.GetHotProductsAsync(ct);
        cache.Set("hot-products", hot);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

素の `IHostedService` の落とし穴は、`StartAsync` の内部で長時間実行の処理を行うことです。そこで無限ループを開始して `await` で待機すると、ホストは起動を終えられません。ループを待機せずに発火させ、`Task` を自分で追跡し、`StopAsync` でキャンセルして待機する必要があります。まさにこの帳簿付けを取り除くために `BackgroundService` は存在します。

さらに細かい制御が必要な場合（*すべての*ホスティングサービスが起動した*後*に走るフック、あるいは終了が始まる直前に走るフック）、.NET 8 は `IHostedLifecycleService` を追加しました。これは `IHostedService` を `StartingAsync`/`StartedAsync` と `StoppingAsync`/`StoppedAsync` で拡張します。.NET 11 でも現役であり、[Steve Gordon によるインターフェースの解説](https://www.stevejgordon.co.uk/introducing-the-new-ihostedlifecycleservice-interface-in-dotnet-8)が説明するように、「今やすべてが立ち上がった」というサービス横断の検証を行う、ドキュメント化された場所です。

## BackgroundService: あなたが本当に欲しいループ

`BackgroundService` は、テンプレートメソッドパターンを使って `IHostedService` をあなたの代わりに実装する抽象基底クラスです。オーバーライドするメソッドは 1 つだけです。

```csharp
// .NET 11, C# 14
public sealed class QueuePump(IServiceScopeFactory scopeFactory, ILogger<QueuePump> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
                await processor.DrainOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // normal shutdown
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Order pump iteration failed; retrying");
            }

            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }
}
```

フレームワークは自身の `StartAsync` の内部から `ExecuteAsync` を呼び出し、ホストが停止するときに `stoppingToken` をシグナルし、終了時にあなたが返した `Task` を `await` で待機します。十分な頻度で人を噛む 2 つの細部があるので挙げておきます。

- **`BackgroundService` はシングルトンです。** `DbContext` のようなスコープ付きサービスを直接注入することはできません。`IServiceScopeFactory` を受け取り、作業単位ごとに 1 つのスコープを開きます。まさに上記のとおりです。[BackgroundService の内部でスコープ付きサービスを使う方法](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/)について専用の解説を書きました。
- **`ExecuteAsync` 内の未処理例外はサービスを静かに停止させます**（さらに .NET 6 以降、デフォルトでは `BackgroundServiceExceptionBehavior.StopHost` を通じてホスト全体を停止させます）。1 回の不良な反復がサービスを殺すべきでない場合は、上記のようにループ本体を try/catch で囲んでください。

どちらの形態も同じ方法で登録します。

```csharp
// .NET 11, C# 14 -- Program.cs
builder.Services.AddHostedService<QueuePump>();      // BackgroundService
builder.Services.AddHostedService<CacheWarmer>();    // raw IHostedService
```

境界のある `System.Threading.Channel` と組み合わせた `BackgroundService` は、典型的なインプロセスのジョブキューです。プロデューサーが作業項目を書き込み、サービスがそれを排出します。コントローラーから `Task.Run` に手を伸ばしたことがあるなら、それこそが本当に欲しかったパターンです。[BackgroundService で fire-and-forget の処理を安全に実行する方法](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)と、[BlockingCollection の代わりに Channels を使う](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)というより広い論拠を参照してください。

## インプロセスの選択肢を選ぶとき

**次のとき `BackgroundService` を選びます。**

- 継続的なループがある場合: キューのコンシューマー、ポーラー、ハートビート、メトリクスのフラッシャー。ここが本領発揮の場です。
- 終了時に処理を失っても許容できる場合、あるいは短い `StopAsync` のウィンドウで処理中の項目を排出する場合。どのみちキューから再駆動されるメール再送、キャッシュの更新、ログの送出など。
- 新しいインフラをゼロにしたい場合。`Microsoft.Extensions.Hosting` に同梱されており、インストールやプロビジョニングするものはありません。

**次のとき素の `IHostedService`（または `IHostedLifecycleService`）を選びます。**

- 最初のリクエストが処理される*前に*処理を完了させる必要がある場合（キャッシュのウォームアップ、スキーマのチェック、feature flag のプリフェッチ）。
- 複数のサービスにまたがる順序づけられた起動や終了、あるいは起動後の「すべて緑」の検証フックが必要な場合。
- 処理が永続的なループではなく、個別の開始/停止のステップである場合。`BackgroundService` の単一の `ExecuteAsync` という形がそぐわないためです。

どちらもアプリの*すべての*インスタンスで実行されます。3 つのレプリカにスケールすると、`BackgroundService` は調整なしで並列に 3 回実行されます。ステートレスなポーラーならそれで構いません。「夜間の請求書メールを 1 回送る」のためなら、それはバグです。

## Hangfire を選ぶとき

**次のいずれかが当てはまるとき Hangfire を選びます。**

- **ジョブが再起動やクラッシュを生き延びる必要がある。** Hangfire は実行前にジョブをストレージ（SQL Server、Redis、または PostgreSQL）に書き込むため、ジョブの途中でのデプロイでも失われません。ジョブは再び取り上げられます。これが目玉の機能です。
- **スケジューリングが必要。** 「10 分後に実行」「毎営業日の午前 6 時」（cron）、「この正確な UTC 時刻」。組み込みで、タイマーの計算は不要です。
- **バックオフ付きの自動リトライが必要。** Hangfire はデフォルトで失敗したジョブを設定可能な回数リトライし、試行履歴はダッシュボードで確認できます。
- **N 個のインスタンスにまたがる単一の実行が必要。** Hangfire のサーバーは共有ストレージのジョブを取り合うため、アプリのインスタンスがいくつ立ち上がっていても、各ジョブは 1 回実行されます。「夜間メール 3 回」問題をきれいに解決します。
- **運用上の可視性が欲しい。** 同梱のダッシュボードは、キュー投入済み、処理中、成功、失敗のジョブをスタックトレース付きで表示します。さもなければ自分で作る必要があるものです。

.NET 11 での最小限のセットアップ:

```csharp
// .NET 11, C# 14 -- Program.cs
builder.Services.AddHangfire(cfg => cfg
    .SetDataCompatibilityLevel(CompatibilityLevel.Version_180)
    .UseSimpleAssemblyNameTypeSerializer()
    .UseRecommendedSerializerSettings()
    .UseSqlServerStorage(builder.Configuration.GetConnectionString("HangfireDb")));

builder.Services.AddHangfireServer();

var app = builder.Build();
app.UseHangfireDashboard("/jobs");  // lock this down in production

// Fire-and-forget, durable:
BackgroundJob.Enqueue<IInvoiceService>(s => s.SendAsync(orderId, CancellationToken.None));

// Recurring (cron):
RecurringJob.AddOrUpdate<IReportService>(
    "nightly-report",
    s => s.BuildAsync(CancellationToken.None),
    Cron.Daily(2));
```

今何が変わったかに注目してください。Hangfire が管理する一連のデータベーステーブル、接続文字列、Hangfire のアップグレードをまたいだそのスキーマのマイグレーション、そして認可しなければならないダッシュボードのエンドポイントを、あなたが所有することになりました。これは実在する運用上の重みです。永続性とスケジューリング、さもなければ自分で下手に組み上げるものと引き換えに、それを意図的に引き受けるのです。

## スループットの全体像、実際の数値とともに

ここでパフォーマンスが決定的な軸であることはまれですが、永続性のコストについて正直である価値はあります。`Channel` を排出するインプロセスの `BackgroundService` は、あなた自身の処理を超える I/O を項目ごとには行いません。ディスパッチのオーバーヘッドは事実上メソッド呼び出しであり、処理そのものに対して計測できるほどではありません。対照的に Hangfire は、ジョブごとにデキューのために少なくとも 1 回、完了をマークするためにもう 1 回、ストレージへのラウンドトリップを行います。

Hangfire 自身のドキュメントはストレージの選択を定量化しています。[Redis ガイド](https://docs.hangfire.io/en/latest/configuration/using-redis.html)によると、SQL Server から Redis に切り替えると、空のジョブで **4 倍を超えるスループット**が得られます。絶対的な数値はストレージのレイテンシ次第ですが、形は固定です。Hangfire の下限は「データベースへのラウンドトリップ」であり、インプロセスキューの下限は「ゼロ」です。1 秒あたり数万件の些細な項目を処理しているなら、その差は重要で、インプロセスの `Channel` キューが圧勝します。1 分あたり数千件のジョブを処理し、それぞれが実際の処理（API の呼び出し、PDF のレンダリング）を行うなら、ジョブごとのストレージコストはノイズに埋もれ、永続性は実質的に無料です。

そこから導かれるルール: そこにあるからといって、高頻度で損失に寛容な処理を Hangfire に通してはいけません。1 秒ごとにキューをチェックするポーラーは `BackgroundService` であって、1 日 86,400 件の Hangfire ジョブではありません。

## あなたの代わりに決めてくれる一点

2 つの要件が、好みが入り込む前に議論を終わらせます。

1. **「アプリが再起動しても、これは失われてはならない。」** ジョブがデプロイで破棄され、それが本物のバグである場合（決済のキャプチャ、確認メール、webhook の配信）、永続ストレージが必要であり、それは Hangfire（または本物のメッセージブローカー）を意味します。`StopAsync` でどれだけ排出しても、`BackgroundService` が `kill -9` やノード障害を生き延びることはありません。インプロセスの選択肢は処理をメモリに保持します。メモリはプロセスとともに死にます。

2. **「これはレプリカ全体でちょうど 1 回実行されなければならない。」** `BackgroundService` は各インスタンスで実行されます。水平にスケールしてジョブが冪等でなければ、重複した処理が発生します。Hangfire の共有ストレージによる worker モデルは、単一の実行を無料で与えてくれます。インプロセスでの同等物は、自分で構築して正しく作る必要のある分散ロックです。

2 つの要件のいずれも当てはまらない場合（処理がインプロセスで、損失に寛容で、かつ単一インスタンスで動かすので 1 回だけ実行されるか、本質的に冪等である場合）、Hangfire を追加するのは何の見返りもなくデータベース税を払うことです。`BackgroundService` を使ってください。

よくある、そして正しいハイブリッド: 永続的な*スケジュールとリトライ*は Hangfire に保ちつつ、繰り返しジョブの本体はインプロセスの `Channel` に投入するだけにし、それを `BackgroundService` が排出します。Hangfire はジョブが 1 回発火し再起動を生き延びることを保証します。`Channel` は高速で背圧を意識したインプロセスのスループットを与えます。すべての項目をストレージに通すことを強制せずに、両方の特性を得られます。

## 推奨、改めて

インプロセスでループするものはすべて、デフォルトで `BackgroundService` を選びます。起動順序や終了前後のフックが特に必要なときだけ、素の `IHostedService` や `IHostedLifecycleService` に手を伸ばします。ジョブが再起動を生き延びる、スケジュールで動く、自動でリトライする、あるいは複数インスタンスにまたがってちょうど 1 回実行される必要が出た瞬間に Hangfire を採用し、それがもたらすデータベースをそれらの保証の対価として受け入れます。「念のため」に Hangfire へ手を伸ばす本能はたいてい逆向きです。インプロセスで始め、具体的な永続性やスケジューリングの要件があなたをより重いツールへ引き寄せるに任せましょう。組み込みのプリミティブの上で動かすときは、盲目飛行にならないように[ヘルスチェックとメトリクスでそれらのバックグラウンドジョブを監視し](/ja/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/)、終了時にループが[デッドロックなしできれいにキャンセルされる](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)ことを確認してください。

## 出典

- [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) -- Microsoft Learn
- [Implement background tasks with IHostedService and BackgroundService](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/multi-container-microservice-net-applications/background-tasks-with-ihostedservice) -- Microsoft Learn
- [Introducing the new IHostedLifecycleService interface in .NET 8](https://www.stevejgordon.co.uk/introducing-the-new-ihostedlifecycleservice-interface-in-dotnet-8) -- Steve Gordon
- [Hangfire overview and supported storage](https://www.hangfire.io/) -- Hangfire
- [Using Redis storage (throughput note)](https://docs.hangfire.io/en/latest/configuration/using-redis.html) -- Hangfire Documentation
- [Using SQL Server storage](https://docs.hangfire.io/en/latest/configuration/using-sql-server.html) -- Hangfire Documentation
