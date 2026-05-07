---
title: "修正: A second operation was started on this context instance before a previous operation completed"
description: "EF Core は同じ DbContext 上で 2 つの await が並行に実行されるとこの例外をスローします。各呼び出しを順次 await するか、IDbContextFactory で並行する作業単位ごとに新しい DbContext を取得してください。"
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
lang: "ja"
translationOf: "2026/05/fix-second-operation-was-started-on-this-context-instance"
translatedBy: "claude"
translationDate: 2026-05-07
---

修正方法: `DbContext` はスレッドセーフではなく、一度に 1 つのクエリ、保存、または変更トラッカーの走査しか実行できません。この例外は同じインスタンス上で 2 つの操作が重なったことを意味し、ほとんどの場合 `await` なしで `Task` を開始した、`Parallel.ForEachAsync` の本体がコンテキストを共有した、または取り込まれたフィールドが 2 つのリクエストから同時にアクセスされたためです。最初の呼び出しを await してから 2 つ目を開始するか、`IDbContextFactory<T>` を介して並行する各作業単位に専用の `DbContext` を渡してください。

```text
System.InvalidOperationException: A second operation was started on this context instance before a previous operation completed. This is usually caused by different threads concurrently using the same instance of DbContext. For more information on how to avoid threading issues with DbContext, see https://go.microsoft.com/fwlink/?linkid=2097913.
   at Microsoft.EntityFrameworkCore.Internal.ConcurrencyDetector.EnterCriticalSection()
   at Microsoft.EntityFrameworkCore.Query.Internal.QueryCompiler.ExecuteAsync[TResult](Expression query, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.EntityQueryProvider.ExecuteAsync[TResult](Expression expression, CancellationToken cancellationToken)
   at System.Linq.AsyncEnumerable.ToListAsync[TSource](IAsyncEnumerable`1 source, CancellationToken cancellationToken)
```

このガイドは .NET 11 preview 4 と `Microsoft.EntityFrameworkCore` 11.0.0-preview.4 を対象に書かれています。テキストと内部の `ConcurrencyDetector` は EF Core 2.0 以来同じで、リリース間で変わるのは周辺のスタックトレース内部のみです。例外は `ConcurrencyDetector.EnterCriticalSection` から発生し、`DbContext` のすべてのパブリックな async API を保護します。EF Core 側にレースコンディションは存在せず、検出器は正しく動作しています。1 つの ID マップと 1 つの開いたコマンドを通じて 2 つの操作を実行しようとしているのを捕まえたのです。

## なぜ DbContext は設計上シングルスレッドなのか

`DbContext` はプライベートな状態機械を保持しています。追跡されたエンティティの ID マップ、保留中の変更リスト、開かれた `DbConnection`、そして高々 1 つの実行中の `DbCommand` です。ADO.NET プロバイダは MARS が有効でない限り同じ接続上で 2 つのコマンドを許可せず、MARS が有効でも、2 つのクエリにまたがる変更トラッカーの変異は任意の方法で互いに競合します。すべてを内部で同期して呼び出しごとにコストを払う代わりに、EF Core は「No」と言います。1 つのインスタンスにつき一度に 1 つの操作です。`ConcurrencyDetector` はその契約のデバッグしやすい強制実装であり、問題の原因ではありません。

この契約はすべての `*Async` メソッドにわたって成立します。`ToListAsync`、`FirstOrDefaultAsync`、`SaveChangesAsync`、`AnyAsync`、`CountAsync`、`Database.ExecuteSqlAsync`、加えて同じ呼び出し位置に `.Result` や `.GetAwaiter().GetResult()` を混在させた場合の同期版兄弟です。これらのうち 2 つが同じ `DbContext` 上で重なると、2 つ目がスローします。

## 最小再現

最も短くて確実な再現は、同じコンテキスト上での `Task.WhenAll` です:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class Report(AppDb db)
{
    public async Task<(int customers, int orders)> Counts()
    {
        var customersTask = db.Customers.CountAsync();
        var ordersTask = db.Orders.CountAsync();

        await Task.WhenAll(customersTask, ordersTask); // throws
        return (await customersTask, await ordersTask);
    }
}
```

両方の `CountAsync` 呼び出しはほぼ同時に開始します。2 つ目は最初がまだ中にいる間に `ConcurrencyDetector.EnterCriticalSection` に入り、検出器がスローします。修正はロックを導入することではなく、独立した 2 つの作業単位が必要だったのに 1 つしかツールがなかったと認識することです。

より微妙な再現は `await` の忘れです:

```csharp
// .NET 11, EF Core 11.0.0 -- still wrong
public async Task ProcessOrder(int id)
{
    var orderTask = db.Orders.FirstOrDefaultAsync(o => o.Id == id);
    var auditTask = db.AuditLog.AddAsync(new AuditEntry(id)); // no await
    await db.SaveChangesAsync(); // throws
}
```

`AddAsync` は `ValueTask` を返します。await しなければ実際に追加を完了したことにはなりませんが、呼び出しはすでに変更トラッカーに触れています。その後 `SaveChangesAsync` が変異中のトラッカーに対して走り、検出器が発火します。同じ根本原因です。同じインスタンス上で 2 つの操作が重なっています。

## 3 つの修正、優先順位順

この順序で適用してください。最初は 90% のケースで正解です。3 つ目は本当に並行な作業のための非常口です。

### 1. 接続が 1 つで済むなら順次 await する

クエリが並列に走る必要が実際にはないなら、並列に開始しないでください。順次 2 回の `CountAsync` の壁時計コストはバグの価値に見合うことはほとんどありません:

```csharp
// .NET 11, EF Core 11.0.0
public async Task<(int customers, int orders)> Counts()
{
    var customers = await db.Customers.CountAsync();
    var orders = await db.Orders.CountAsync();
    return (customers, orders);
}
```

1 つのリクエストハンドラが 1 つのデータベースと話す場合、これがほぼ常に正しいです。2 つ目のクエリはすでに開いている同じ接続上で実行されるため、クエリ自体を超える 2 回目のラウンドトリップコストはありません。並列性に頼るのは、同じバックエンドに対する 2 つのクエリが実時間を節約することを測定で確認したときだけにしてください。これは稀です。データベース自身が接続ごとにコマンドを直列化するためです。

### 2. 真に並行な作業単位には IDbContextFactory を使う

2 つのクエリを実際に同時に走らせる必要があるとき (最も一般的には `BackgroundService`、`Hangfire` ジョブ、バッチを処理する CLI ツール、ファンアウトのシナリオ)、各タスクに専用の `DbContext` を渡してください:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class Report(IDbContextFactory<AppDb> factory)
{
    public async Task<(int customers, int orders)> Counts()
    {
        var customersTask = CountAsync(db => db.Customers);
        var ordersTask = CountAsync(db => db.Orders);

        await Task.WhenAll(customersTask, ordersTask);
        return (await customersTask, await ordersTask);
    }

    private async Task<int> CountAsync<T>(Func<AppDb, IQueryable<T>> set)
    {
        await using var db = await factory.CreateDbContextAsync();
        return await set(db).CountAsync();
    }
}
```

各並行操作は今や独自のコンテキスト、プールから独自の接続、独自の変更トラッカーを取得します。共有された可変状態がないので、検出器が文句を言うことは何もありません。`AddDbContextFactory` がサポートされた登録方法です。ライフタイムを回避するために手動で `DbContext` を `new` しようとしないでください。オプション解決とプーリングをバイパスしてしまいます。

加えて安価な作成のためにプール済みのインスタンスが欲しい場合は、代わりに `AddPooledDbContextFactory` を登録してください。テストセットアップでのプール済みファクトリのトレードオフについては、[取り外し可能なプール済みファクトリのスワップパターン](/ja/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) がレンタル間の状態漏れの落とし穴をカバーしています。

### 3. 操作ごとに新しいスコープを解決する

フレームワークが管理する scoped ライフタイム (ASP.NET Core のデフォルト) では、修正は各並列分岐に対して子スコープを作成することです:

```csharp
// .NET 11, EF Core 11.0.0
public class Report(IServiceScopeFactory scopes)
{
    public async Task ProcessAll(IEnumerable<int> ids)
    {
        await Parallel.ForEachAsync(ids, async (id, ct) =>
        {
            await using var scope = scopes.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            var order = await db.Orders.FirstOrDefaultAsync(o => o.Id == id, ct);
            // ... process order ...
        });
    }
}
```

`CreateAsyncScope` は新しい DI スコープを構築するので、そこから `AppDb` を解決すると外側のリクエストスコープや他のすべてのイテレーションとは異なるインスタンスが返ります。これが EF Core に対する `Parallel.ForEachAsync` の正しい形です。修正 2 のファクトリパターンは、作業が純粋にデータアクセスである場合に好まれます。スコープパターンはループ本体が他の scoped サービスも必要とする場合に良いです。

## これを引き起こす一般的な形

### Task.Run でリクエストの DbContext を共有する

ASP.NET Core の典型的な間違いです。リクエストハンドラが request-scoped `DbContext` を取り込む fire-and-forget のバックグラウンドタスクを起動します:

```csharp
// .NET 11, EF Core 11.0.0 -- wrong
[HttpPost]
public IActionResult QueueWork()
{
    _ = Task.Run(async () =>
    {
        await db.AuditLog.AddAsync(new AuditEntry("queued"));
        await db.SaveChangesAsync();
    });
    return Accepted();
}
```

ここで 2 つの失敗モードが重なります。1 つ目はリクエストが返り、バックグラウンドタスクがまだ実行中の間に DI スコープが `DbContext` を破棄するので、`ObjectDisposedException` も見ることになります。2 つ目はリクエスト上の他のコードパスがまだコンテキストを使っていれば、両方のスレッドが争い、検出器がスローします。修正は #2 と同じです。`IDbContextFactory<AppDb>` を注入するか、独自のスコープを所有する本物のバックグラウンドメカニズム (`IHostedService`、channels、ジョブキュー) に作業を渡してください。[BlockingCollection の置き換えとしての Channels のウォークスルー](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) は in-process キューパターンをカバーしています。

### HTTP 境界を越えて IAsyncEnumerable をストリームする

EF Core クエリで支えられたコントローラから `IAsyncEnumerable<T>` を返すと、ASP.NET Core はレスポンスをシリアライズしながらそれを列挙します。シリアライズが進行中にそのスコープ上で他の何かが同じ `DbContext` にアクセスすると、検出器がスローします。ボディがまだストリーミング中にミドルウェアが後で `OnStarting` コールバックで監査行を追加するときに簡単に踏みます。

修正は enumerable をマテリアライズするか、ストリーミングエンドポイントがレスポンスのライフタイム中そのコンテキストへの唯一のアクセス権を所有することを保証することです。[`IAsyncEnumerable` を EF Core で使うウォークスルー](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) はストリーミングモデルとそれと動作するライフタイムを通り抜けます。

### イベントハンドラまたは静的フィールドに取り込まれた DbContext

静的フィールドとして格納された、または起動時に購読されたイベントハンドラに取り込まれた `DbContext` は、すべてのイベントで再利用されます。近接して到着する 2 つのイベントはその上で重なります。同じ修正です。ファクトリを注入し、取り込まないでください。

### Singleton スコープの DbContext

`Singleton` として登録された `DbContext` (誤って、または `MyService` が `AppDb` を注入する `AddSingleton<MyService>` 経由で) はリクエスト間で共有されます。並行性は実際の負荷下で保証されます。[ID マップ衝突ガイド](/ja/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) は同じ Singleton/Scoped の罠を重複キーの角度から通り抜けます。両方のエラーは同じ根本原因から来ます。

### 同じ呼び出し位置で sync と async を混在させる

`db.SaveChanges()` の後に以前に開始された (await されていない) 進行中の async クエリがあると、最終的に async に `await` するときに検出器が発火します。これは通常、誰かがコンパイラの警告を抑制するために `_ = SomethingAsync()` を追加したレガシーコードパスに現れます。警告を抑制したらバグも抑制されました。修正はそれに `await` することです。

### Polly のリトライ試行間で DbContext を再利用する

呼び出しを `Polly` でラップし、前の試行の `Task` がまだ生きている間にリトライが走ると (キャンセルがクリーンに伝播しなかった)、両方の試行が同じコンテキストに触れます。リトライを `IDbContextFactory<T>` とペアにして各試行が新鮮なコンテキストを取得するようにするか、リトライする前に前の試行が完全にキャンセルされる (`ct.ThrowIfCancellationRequested()` が EF Core 呼び出しを通過する) ことを保証してください。[デッドロックなしでキャンセルするガイド](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) は安全にするキャンセル規律をカバーしています。

## このエラーに似ているがそうでないバリアント

### "There is already an open DataReader associated with this Connection which must be closed first"

別の例外、同じファミリ。これは MARS がオフで同じ接続上で 2 つ目のリーダーを開始しようとしたときに ADO.NET から来ます。EF Core はほとんどの場合これを隠しますが、`db.Database.GetDbConnection()` を使う生の作業は検出器をバイパスして代わりに根本のエラーを浮上させます。修正は同じ形 (一度に 1 つの操作、または操作ごとに 1 つの接続) ですが、SQL Server の接続文字列で `MultipleActiveResultSets=True` をオンにすれば、本当に必要ならネストしたリーダーを実行できます。

### "ObjectDisposedException: Cannot access a disposed context"

取り込まれたタスクが使おうとしている間に DI スコープがすでに `DbContext` を破棄したことを意味します。通常は HTTP ハンドラからの fire-and-forget な `Task.Run`、または起動時に scoped コンテキストを取り込んだ `BackgroundService` です。修正はタスクの外ではなく内でコンテキストを解決することです。

### "The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"

ID マップ競合、シングルスレッドの形。2 つの CLR オブジェクト、同じ主キー、同じコンテキスト。修正の詳細は [エンティティ追跡ガイド](/ja/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/) で通り抜けています。

### "InvalidOperationException: Synchronous operations are disallowed"

Kestrel がレスポンスボディで `Stream.ReadAsync` の代わりに `Stream.Read` を拒否しています。別のスタック、別の修正 (`AllowSynchronousIO = true` または async API への移行)。`DbContext` の問題ではありません。

## 関連

より広い EF Core の衛生については、並行性モデルが正しくなった後のクエリ設計について [N+1 クエリ検出のウォークスルー](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) と [ホットパスでのコンパイル済みクエリのガイド](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) を参照してください。スレッド間でコンテキストを共有することなく実際のデータベースをコードに渡すテストフィクスチャについては、[実際の SQL Server に対する Testcontainers のウォークスルー](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) が最もクリーンなセットアップです。[N+1 検出の投稿](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) は、CI で忘れられた `await` をフラグするために再利用できる EF Core 11 のロガーフックもカバーしています。

## ソース

- [Avoiding DbContext threading issues](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#avoiding-dbcontext-threading-issues), EF Core ドキュメント。
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn。
- [`AddDbContextFactory` extension](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), Microsoft Learn。
- [`ConcurrencyDetector` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/Internal/ConcurrencyDetector.cs), GitHub の dotnet/efcore。
- [`IServiceScopeFactory.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn。
