---
title: "解決: ObjectDisposedException: Cannot access a disposed context instance"
description: "fire-and-forget タスクが、DI スコープがすでに破棄したリクエストスコープの DbContext をキャプチャしました。IServiceScopeFactory または IDbContextFactory でタスク内に新しいコンテキストを解決してください。"
pubDate: 2026-06-02
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "async"
lang: "ja"
translationOf: "2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance"
translatedBy: "claude"
translationDate: 2026-06-02
---

解決策: fire-and-forget の `Task` が、タスクの完了前に破棄された DI スコープに属する `DbContext`（または別のスコープ付きサービス）をキャプチャしました。リクエストが戻り、ASP.NET Core がスコープとその `DbContext` を破棄し、その後で切り離されたタスクが死んだインスタンスに触れたのです。スコープ付きのコンテキストをキャプチャしないでください。タスク内で `IServiceScopeFactory.CreateAsyncScope` を使って自分自身のスコープを作成し、そこから新しい `DbContext` を解決するか、`IDbContextFactory<T>` を注入して `CreateDbContextAsync` を呼び出します。

```text
System.ObjectDisposedException: Cannot access a disposed context instance. A common cause of this error is disposing a context instance that was resolved from dependency injection and then later trying to use the same context instance elsewhere in your application. This may occur if you are calling Dispose() on the context instance, or wrapping it in a using statement. If you are using dependency injection, you should let the dependency injection container take care of disposing context instances.
Object name: 'AppDb'.
   at Microsoft.EntityFrameworkCore.DbContext.CheckDisposed()
   at Microsoft.EntityFrameworkCore.DbContext.get_DbContextDependencies()
   at Microsoft.EntityFrameworkCore.DbContext.Set[TEntity]()
   at Microsoft.EntityFrameworkCore.Internal.InternalDbSet`1.get_EntityQueryable()
```

このガイドは .NET 11 preview 4 と `Microsoft.EntityFrameworkCore` 11.0.0-preview.4 を対象に書かれていますが、メッセージのテキストと `CheckDisposed` のチェックは EF Core 3.0 以来安定しています。この例外は `DbContext.CheckDisposed()` から送出され、これは `Set<T>`、`SaveChangesAsync`、`Database`、変更トラッカーなど、すべての公開メンバーの先頭で実行されます。あなたがこれを目にする頃には、オブジェクトは実際にすでに消えています。EF Core は競合状態にあるわけでも、誤動作しているわけでもありません。何かがコンテキストを破棄し、それでもコードがそれに手を伸ばしたのです。

## ここで「破棄された」が実際に意味すること

依存性注入から解決された `DbContext` は、それが解決されたスコープが所有します。ASP.NET Core では、フレームワークが HTTP リクエストごとに 1 つの DI スコープを作成し、レスポンスが完了するとそれを破棄します。スコープを破棄すると、それが作成したすべての `IDisposable`（あなたの `DbContext` を含む）が破棄されます。その後、コンテキストの内部サービスプロバイダーは解体され、その `DbConnection` はプールに戻り、`_disposed` が `true` に設定されます。それ以降のあらゆる呼び出しは `CheckDisposed()` に到達し、例外を送出します。

このエラーは、自分で `using` を書いたり `Dispose()` を呼び出したりすることにはほとんど関係ありません（とはいえ、それも引き起こすもう 1 つの方法ではあります）。実際にはライフタイムの問題です。コンテキストを所有していたスコープよりもコードが長生きしたのです。圧倒的に最も多い形は、リクエストから開始され、そのリクエストのコンテキストをキャプチャした fire-and-forget タスクです。

## 最小の再現

コントローラーがバックグラウンド処理を待機せずに開始し、ラムダが注入された `DbContext` をクロージャに取り込みます。

```csharp
// .NET 11, C# 14, EF Core 11.0.0 -- wrong
public class OrdersController(AppDb db) : ControllerBase
{
    [HttpPost("orders")]
    public IActionResult Create(OrderDto dto)
    {
        var order = new Order(dto);
        db.Orders.Add(order);

        // fire-and-forget: not awaited, escapes the request lifetime
        _ = Task.Run(async () =>
        {
            await Task.Delay(2000);            // simulate slow work
            db.AuditLog.Add(new Audit(order)); // db is disposed by now
            await db.SaveChangesAsync();        // throws ObjectDisposedException
        });

        return Accepted();
    }
}
```

順序はこうです。`Create` はほぼ即座に `Accepted()` を返し、ASP.NET Core はリクエストスコープ（および `db`）を破棄します。そして 2 秒後、切り離されたタスクが起き上がり、`_disposed` フラグがすでに設定されているコンテキストを呼び出します。`Add` はタイミングによっては成功するように見えることさえありますが、`SaveChangesAsync` は破棄された依存関係に触れるため、確実に例外を送出します。

同じことが `ContinueWith`、コンテキストをキャプチャする `async void` のイベントハンドラー、それをクロージャに取り込む `Timer` のコールバック、そしてコンストラクターで一度スコープ付きコンテキストを解決して永遠に再利用する `BackgroundService` でも起こります。

## 解決策 1: タスク内でスコープを作成し、新しいコンテキストを解決する

これは、バックグラウンド処理が純粋なデータアクセスを超えてスコープ付きサービスを必要とする場合の正しい答えです。`IServiceScopeFactory`（シングルトンで、キャプチャしても常に安全）を注入し、タスク本体の内部でスコープを開きます。

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class OrdersController(AppDb db, IServiceScopeFactory scopeFactory)
    : ControllerBase
{
    [HttpPost("orders")]
    public async Task<IActionResult> Create(OrderDto dto)
    {
        var order = new Order(dto);
        db.Orders.Add(order);
        await db.SaveChangesAsync();     // the request's own work, awaited

        var orderId = order.Id;          // capture a value, not the context

        _ = Task.Run(async () =>
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var bgDb = scope.ServiceProvider.GetRequiredService<AppDb>();
            bgDb.AuditLog.Add(new Audit(orderId));
            await bgDb.SaveChangesAsync();
        });

        return Accepted();
    }
}
```

2 つの点が変わりました。タスクは `DbContext` ではなく `orderId`（`int`）をキャプチャします。そして、自分が所有するスコープから真新しい `AppDb` を解決するため、そのスコープの破棄は HTTP リクエストではなくタスクの完了に結び付きます。`CreateAsyncScope`（同期の `CreateScope` ではなく）が重要なのは、`DbContext` が `IAsyncDisposable` を実装しているからです。非同期スコープを使うことで非同期パスを通じて破棄され、アナライザーによる sync-over-async の警告を回避できます。

境界を越えてエンティティのインスタンスをキャプチャすることも決してしないでください。`order` オブジェクトはリクエストのコンテキストによって追跡されています。それを新しいスコープのコンテキストに渡すと、「instance of entity type cannot be tracked」の衝突を招きます。キーを渡し、タスク内で再読み込みまたは再アタッチしてください。

## 解決策 2: 処理が純粋なデータアクセスなら IDbContextFactory を注入する

切り離された処理が `DbContext` だけを必要とし、スコープ付きのものが他に何もない場合、`IDbContextFactory<T>` は DI スコープ全体を立ち上げるよりもクリーンです。スコープ付きコンテキストと並べて（またはその代わりに）登録します。

```csharp
// .NET 11, EF Core 11.0.0 -- Program.cs
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public class OrdersController(IDbContextFactory<AppDb> factory) : ControllerBase
{
    [HttpPost("orders")]
    public async Task<IActionResult> Create(OrderDto dto)
    {
        int orderId;
        await using (var db = await factory.CreateDbContextAsync())
        {
            var order = new Order(dto);
            db.Orders.Add(order);
            await db.SaveChangesAsync();
            orderId = order.Id;
        }

        _ = Task.Run(async () =>
        {
            await using var bgDb = await factory.CreateDbContextAsync();
            bgDb.AuditLog.Add(new Audit(orderId));
            await bgDb.SaveChangesAsync();
        });

        return Accepted();
    }
}
```

`IDbContextFactory<T>` はシングルトンとして登録されるため、クロージャでキャプチャしても安全です。各 `CreateDbContextAsync` は、`await using` でライフタイムを制御できるコンテキストを渡します。ファクトリーはリクエストスコープを完全に回避します。これはまさに切り離されたタスクが求めるものです。`AddDbContextFactory` も呼び出す場合、EF Core 11 では同じ登録がスコープ付き `AppDb` の注入とファクトリーの注入の両方を満たせるため、グローバルにどちらか一方を選ぶ必要はありません。作成コストがプロファイルに現れる場合は `AddPooledDbContextFactory` に頼りますが、貸し出しの間にコンテキストごとの状態をリセットしてください。

## 解決策 3: 撃ちっぱなしをやめる -- 処理を本物のバックグラウンド機構に渡す

リクエストハンドラーからの `Task.Run` は、コンテキストのライフタイムを修正したとしても誤ったツールです。その処理にはリトライも、バックプレッシャーも、グレースフルシャットダウンの処理もなく、それが実行されるスレッドはリクエスト処理と競合します。永続的な解決策は、メッセージをキューに入れ、hosted service にそれを自分のスコープで処理させることです。`Channel<T>` は最も軽量なインプロセスの選択肢です。

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public sealed record AuditWork(int OrderId);

public class AuditQueue
{
    private readonly Channel<AuditWork> _channel =
        Channel.CreateUnbounded<AuditWork>();

    public ValueTask Enqueue(AuditWork work) => _channel.Writer.WriteAsync(work);
    public IAsyncEnumerable<AuditWork> Reader(CancellationToken ct) =>
        _channel.Reader.ReadAllAsync(ct);
}

public class AuditWorker(AuditQueue queue, IServiceScopeFactory scopeFactory)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var work in queue.Reader(stoppingToken))
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<AppDb>();
            db.AuditLog.Add(new Audit(work.OrderId));
            await db.SaveChangesAsync(stoppingToken);
        }
    }
}
```

`AuditQueue` をシングルトンとして、`AuditWorker` を `AddHostedService` で登録します。コントローラーは今や `await queue.Enqueue(new AuditWork(orderId))` を呼び出して戻るだけです。各作業単位はワーカー内で自分のスコープと自分のコンテキストを得て、処理はリクエストの返却後も生き残り、ループが `stoppingToken` を尊重するためシャットダウンはクリーンに処理されます。これは [BackgroundService による安全な fire-and-forget の解説](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) が完全にカバーするパターンであり、[BlockingCollection の代替としての Channels ガイド](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) がキュー側を詳しく説明しています。

## DbContext を注入する BackgroundService が起動時に失敗する理由

より微妙なバージョン: `AppDb` を `BackgroundService` のコンストラクターに直接注入すると、最初に別のエラーが出ます。

```csharp
// .NET 11, EF Core 11.0.0 -- wrong, fails to start
public class AuditWorker(AppDb db) : BackgroundService { /* ... */ }
```

`BackgroundService` はシングルトンです。スコープ付きの `AppDb` をシングルトンに注入すると、起動時に DI スコープバリデーターが「Cannot consume scoped service 'AppDb' from singleton」で引っかかります。仮にこれを何らかの形で抑制した場合（すべきではありません）、シングルトンはプロセスのライフタイム全体で 1 つのコンテキストを保持することになり、2 つのイテレーションが重なった最初の瞬間に `ObjectDisposedException` やスレッドエラーに戻ってしまいます。解決策は解決策 1 と同じ `CreateAsyncScope` パターンです。[シングルトンからスコープ付きサービスのエラー](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/) の記事と [BackgroundService 内のスコープ付きサービスのガイド](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) は、いずれもシングルトンがスコープ付きの状態を保持できない理由を説明しています。

## 自分自身が引き起こした破棄

fire-and-forget ではない 2 つの形が、まったく同じメッセージを生み出します。

DI で解決されたコンテキストを `using` で包んだ場合。`AppDb` がコンストラクター注入から来たのなら、それはコンテナーが所有します。`using` ブロックはそれを早すぎるタイミングで破棄し、同じリクエスト内の次のメンバー呼び出しが例外を送出します。コンテナーに破棄させてください -- `using` を削除します。自分で `new` またはファクトリー経由で作成したコンテキストだけを破棄してください。

メソッドから `IEnumerable<T>` または `IQueryable<T>` を返し、呼び出し側がコンテキストの消滅後にそれを列挙した場合。遅延 LINQ は列挙まで実行されません。メソッドのコンテキストが `using` やすでに終了したリクエストにスコープされていた場合、列挙は破棄されたコンテキストに到達します。メソッド内で `ToListAsync` によりマテリアライズするか、列挙の間コンテキストを生かしておいてください。

## これに似ているが別物のバリアント

### "A second operation was started on this context instance before a previous operation completed"

同じ系統で原因が異なります。2 つの操作が生きている（破棄されていない）コンテキスト上で重なったもので、通常は忘れられた `await` か、1 つのコンテキストに対する `Task.WhenAll` です。解決策もまた操作ごとに 1 コンテキストで、[second-operation-started のガイド](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/) に詳しくあります。

### "Cannot access a disposed object. Object name: 'IServiceProvider'"

コンテキストだけでなく、スコープ全体またはルートプロバイダーが破棄されました。同じ根本原因（ライフタイム）ですが、`IServiceProvider`/`IServiceScope` をキャプチャし、それを破棄した後に使ったことを意味します。スコープが終わる前に必要なものをすべて解決するか、処理の間スコープを生かしておいてください。

### "The ConnectionString property has not been initialized"

プロバイダーが構成されていない `new` で作られたコンテキストであり、破棄の問題ではありません。DI を回避して `OnConfiguring` やオプションを忘れています。`new AppDb()` ではなくファクトリーまたは DI を使ってください。

### CancellationTokenSource での "ObjectDisposedException"

それ由来のトークンがまだ使用中なのに破棄された `CancellationTokenSource`。例外の型は一致しますが、EF Core とは無関係です。`Object name:` の行を見てください -- それが破棄されたオブジェクトを名指しており、それが最速のトリアージのシグナルです。

## 関連

スコープ付きの状態を漏らさずに切り離された処理を実行する全体像については、[安全な fire-and-forget パターン](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) と [BackgroundService 内のスコープ付きサービス](/ja/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) のガイドが次に読むべき 2 つです。あなたの fire-and-forget が `async void` として始まったのなら、[async void と async Task の解説](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) が、なぜそれが例外を完全に飲み込むのかを説明します。そして切り離されたタスクがシャットダウン時にクリーンに停止する必要がある場合、[デッドロックなしでキャンセルするガイド](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) がトークンの規律をカバーします。

## ソース

- [DbContext lifetime, configuration, and initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), EF Core ドキュメント。
- [`IDbContextFactory<TContext>` interface](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn。
- [`DbContext.CheckDisposed` source](https://github.com/dotnet/efcore/blob/main/src/EFCore/DbContext.cs), GitHub の dotnet/efcore。
- [Consuming a scoped service in a background task](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service), .NET ドキュメント。
- [`ServiceProviderServiceExtensions.CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope), Microsoft Learn。
