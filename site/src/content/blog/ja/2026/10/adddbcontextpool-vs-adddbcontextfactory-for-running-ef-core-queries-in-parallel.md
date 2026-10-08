---
title: "EF Core のクエリを並列実行するための AddDbContextPool と AddDbContextFactory の比較"
description: "AddDbContextPool は DI スコープごとに 1 つのスコープ付き DbContext を渡すため、2 つのクエリを同時に実行できません。AddDbContextFactory と AddPooledDbContextFactory は呼び出しごとにコンテキストを返すので、並列クエリに向いています。EF Core 11 RC 1 での計測では、プール付きファクトリはコンテキストを 342 ns、40 B で作成しますが、プールなしでは 17 us、44 KB かかります。"
pubDate: 2026-10-08
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "dependency-injection"
lang: "ja"
translationOf: "2026/10/adddbcontextpool-vs-adddbcontextfactory-for-running-ef-core-queries-in-parallel"
translatedBy: "claude"
translationDate: 2026-10-08
---

EF Core のクエリを並列実行したい場合、`AddDbContextPool` を単独で使うのは適切ではありません。これは `DbContext` をスコープ付きサービスとして登録するため、1 つのリクエスト (1 つの DI スコープ) 内のすべての処理が 1 つのインスタンスを共有します。そして 1 つの `DbContext` は 2 つの操作を同時に実行できません。`AddDbContextFactory` は、呼び出しごとに新しいコンテキストを返すシングルトンの `IDbContextFactory<T>` を登録します。これはまさに `Task.WhenAll` が必要とする形です。両方の利点が欲しい場合は `AddPooledDbContextFactory` を登録してください。ファクトリの API はそのままで、`AddDbContextPool` が使うものと同じプールが裏にあるため、並列の各ブランチが再利用されるインスタンスを個別に借りられます。

以下の計測はすべて、Apple M4 上で EF Core 11.0.0-rc.1.26425.128、SDK 11.0.100-rc.1.26425.128、`Microsoft.EntityFrameworkCore.Sqlite` を使って行いました。同じハーネスを EF Core 10.0.12 と .NET 10.0.10 でも実行しました。登録方法、再利用の挙動、プールサイズは同一で、タイミングも同じ範囲に収まりました (プールなしのコンテキスト 1 つあたり 14.3 us と 43 KB、プール付きで 357 ns と 40 B)。

## 比較の概要

| | `AddDbContextPool<T>` | `AddDbContextFactory<T>` | `AddPooledDbContextFactory<T>` |
| --- | --- | --- | --- |
| 注入するもの | `T` (スコープ付き) | `IDbContextFactory<T>` (シングルトン) | `IDbContextFactory<T>` (シングルトン) |
| `T` もスコープ付きで登録される | はい、これが主要なサービスです | はい | はい |
| DI スコープあたりのコンテキスト数 | 1 | 作成した数だけ | 作成した数だけ |
| 1 リクエスト内の `Task.WhenAll` で安全か | いいえ | はい | はい |
| `Dispose` 後にインスタンスが再利用されるか | はい | いいえ | はい |
| 作成と破棄のコスト (計測値) | DI スコープ経由のため該当なし | 17,250 ns、44,888 B | 342 ns、40 B |
| コンストラクターでスコープ付きサービスを受け取れるか | いいえ | はい | いいえ |
| `OnConfiguring` が実行される回数 | プールされたインスタンスごとに 1 回 | インスタンスごと | プールされたインスタンスごとに 1 回 |
| 既定のプールサイズ | 1024 | 該当なし | 1024 |

"並列で安全か" の行がこの記事の主題です。これはプールではなくライフタイムで決まります。プールが決めるのは、各コンテキストの作成コストだけです。

## 1 つの DbContext が 2 つのクエリを同時に実行できない理由

`DbContext` は、変更トラッカー、接続、そしてクエリ中は開いたデータリーダーを保持します。これらはいずれもスレッドセーフではなく、EF Core もそうしようとはしません。代わりに、最初の操作がまだ実行中のうちに 2 つ目の操作が始まると、すぐに例外をスローする同時実行検出機能を備えています。この例外については ["A second operation was started on this context instance"の記事](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/)で詳しく扱いましたが、ここでは要点だけで十分です。EF Core での並列化とは、常に同時実行する操作ごとに 1 つのコンテキストを使うことを意味します。

ここで `AddDbContextPool` につまずく人が多くいます。名前から並行処理に役立ちそうに思えます ("コンテキストのプール") が、プールが共有されるのはスコープをまたいでであり、1 つのスコープの内部ではありません。EF Core 11 RC 1 の `ServiceCollection` から、それぞれの呼び出し後にコンテナーへ実際に何が入っているかをダンプしたものを示します。

```text
--- AddDbContextPool
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Scoped    IScopedDbContextLease<AppDb>
  Scoped    AppDb
--- AddDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextFactorySource<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
--- AddPooledDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
```

`AddDbContextPool` では、`AppDb` はスコープ付きで、`IScopedDbContextLease<AppDb>` を通じてプールから借りられます。1 つのスコープ内で 2 回解決しても同じオブジェクトが返ります。コンテナーには `IDbContextFactory<AppDb>` がまったく存在しないため、2 つ目を要求することもできません。

## AddDbContextPool で失敗する並列クエリ

最小の再現コードです。コントローラーまたは最小 API のエンドポイントがスコープ付きコンテキストを受け取り、ファンアウトを試みます。

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextPool<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (AppDb db) =>
{
    // Both queries use the same pooled instance: this throws.
    var ordersTask = db.Orders.CountAsync();
    var customersTask = db.Customers.CountAsync();
    await Task.WhenAll(ordersTask, customersTask);
    return new { Orders = ordersTask.Result, Customers = customersTask.Result };
});
```

非同期呼び出しがネットワーク待ちの間に実際に制御を戻す SQL Server や PostgreSQL では、最初のクエリが終わる前に 2 つ目が始まり、EF Core が次の例外をスローします。

```text
InvalidOperationException: A second operation was started on this context instance
before a previous operation completed. This is usually caused by different threads
concurrently using the same instance of DbContext.
```

テストで分かったことが 2 点あります。1 点目は、SQLite の非同期メソッドは同期的に完了するため、上の素朴なバージョンは SQLite では重ならず "動いて" しまうことです。つまり SQLite をバックエンドにしたテストスイートは、このバグの検出には向きません。重ねるには、両方のクエリを `Task.Run` で包む必要がありました。2 点目は、新しいコンテキストの最初の使用時に競合が起きると、別のメッセージ "An attempt was made to use the context instance while it is being configured" が出ることです。2 つのスレッドが同時にコンテキストを初期化しようとするためです。原因も対処も同じです。

## AddDbContextFactory によるファンアウト

ファクトリ版では、各ブランチが自分専用のインスタンスを持ちます。

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (IDbContextFactory<AppDb> factory, CancellationToken ct) =>
{
    async Task<int> CountOrders()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Orders.CountAsync(ct);
    }

    async Task<int> CountCustomers()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Customers.CountAsync(ct);
    }

    var orders = CountOrders();
    var customers = CountCustomers();
    await Task.WhenAll(orders, customers);
    return new { Orders = orders.Result, Customers = customers.Result };
});
```

各ローカル関数は、コンテキストを作成し、クエリを 1 つ実行して、破棄します。何も共有しないので、競合する対象がありません。私のテストハーネスでは、同じ形で 4 ブランチ (リージョンごとに 1 つ、4 つの `CountAsync` に対する `Task.WhenAll`) を試し、毎回 `250,250,250,250` が返りました。

`AddDbContextFactory` は `AppDb` もスコープ付きで登録することに注目してください。`AppDb` を直接注入している既存のコードはそのまま動くので、アプリ内のすべてのコンストラクターに手を入れずに登録を切り替えられます。ファクトリを受け取る必要があるのは、ファンアウトするエンドポイントだけです。

## AddPooledDbContextFactory: 両方を同時に

`AddDbContextFactory` は、`CreateDbContext` を呼ぶたびに真新しいコンテキストを作成します。このコストはデータベースのラウンドトリップに比べれば通常は小さいものですが、5 つや 10 個のクエリにファンアウトする負荷の高いエンドポイントでは積み重なります。`AddPooledDbContextFactory` はファクトリの形を保ちつつ、プールからインスタンスを借ります。

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddPooledDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

呼び出し側のコードは前のセクションと同一です。注入するのは引き続き `IDbContextFactory<AppDb>` だからです。その裏の実装が `DbContextFactory<AppDb>` ではなく `PooledDbContextFactory<AppDb>` になり、`Dispose` はインスタンスを捨てる代わりにプールへ返します。これは直接確認しました。コンテキストを作成して破棄し、もう一度作成して `ReferenceEquals` を調べると、プール付きファクトリでは `true`、通常のファクトリでは `false` になります。

これで何が得られるかを、単純なループで計測しました (作成と破棄は 200,000 回、作成とクエリと破棄は 20,000 回、ウォームアップ済み、シングルスレッド、アロケーションは `GC.GetAllocatedBytesForCurrentThread` で測定)。

| 操作 | `AddDbContextFactory` | `AddPooledDbContextFactory` |
| --- | --- | --- |
| `CreateDbContext` + `Model` へのアクセス + `Dispose` | 17,250 ns、44,888 B | 342 ns、40 B |
| 作成 + キーによる `FirstOrDefault` (SQLite、追跡なし) + `Dispose` | 49.7 us、62,461 B | 20.0 us、11,710 B |

これはローカルの SQLite ファイルに対する数値なので、データベース側はほぼ無料に近く、コンテキストのセットアップが支配的になります。ネットワーク越しの実際の SQL Server では、クエリ時間が 17 us をはるかに上回ります。公式ドキュメントがプールを "high-performance scenarios" 向けのものと説明しているのはそのためです。ただし、アロケーションの差はレイテンシが大きくなっても縮まりません。コンテキストごとに 44 KB のガベージが出て、それが 10 の並列ブランチ、さらにリクエストレートの数だけ掛かれば、現実的な GC 負荷になります。[EF Core の高度なパフォーマンスのドキュメント](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)も、SQL Server に対して同じ傾向を報告しています。プールなしでは 50.38 KB、ありでは 4.63 KB が割り当てられます。

同じドキュメントには、DI 経由でプール付きコンテキストを解決すると、プール付きファクトリを直接呼ぶ場合に比べて "incurs a slight overhead" とも書かれています。したがって、並列化が不要な場合でも、プールを使う 2 つの選択肢のうちファクトリのほうが高速です。

## 両方を登録して 1 つのプールを共有できる

どちらか一方を選ぶ必要はありません。同じオプションで `AddDbContextPool<AppDb>` を呼び、続けて `AddPooledDbContextFactory<AppDb>` を呼ぶと、両者は同じ `IDbContextPool<AppDb>` を共有します。ファクトリからコンテキストを借りて破棄し、新しいスコープから `AppDb` を解決したところ、同じインスタンスが返ることで確認しました。これにより、アプリの大半は従来どおり `AppDb` を注入し、ファンアウトする少数のエンドポイントだけがファクトリを注入できます。プールを 2 つ持つコストもかかりません。

EF Core 11 では、コンテキスト自身の `OnConfiguring` から構成を読み取る、引数なしの `AddPooledDbContextFactory<T>()` オーバーロードもあります。これについては [RemoveDbContext とプール付きファクトリを扱った EF Core 11 Preview 3 の記事](/ja/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)で説明しました。

## 並列度を制限するのはプールではなく接続プール

既定の `poolSize` は、`AddDbContextPool` と `AddPooledDbContextFactory` のどちらも 1024 です。この数字はプールが保持するインスタンスの最大数であり、同時に生存できる最大数ではありません。`poolSize: 2` に設定して 5 つのコンテキストを同時に借りたところ、5 つの別々のインスタンスが得られました。5 つをすべて破棄してからもう一度 5 つ借りると、最初のバッチから戻ってきたのはちょうど 2 つでした。つまり、あふれた分は新しいコンテキストの作成にフォールバックし、余分なものは返却時に単に破棄されます。プールがブロックすることはありません。

並列クエリの本当の上限は、その下にある ADO.NET の接続プールです。EF Core は各クエリの直前に接続を開き、直後に閉じます。同時実行する各クエリには専用の接続が必要です。`Microsoft.Data.SqlClient` の既定は `Max Pool Size=100` で、Npgsql の既定も 100 です。1 リクエストあたり 20 クエリにファンアウトし、10 リクエストが同時に来れば、すでに接続待ちになります。これは EF のエラーとしてではなく、プールから接続を取得する際のタイムアウトとして現れます。ID のリストに対してファンアウトする場合は、すべてを `Task.WhenAll` に投げ込む代わりに、`Parallel.ForEachAsync` で並列度を制限してください。トレードオフは [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/ja/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) にあります。

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
await Parallel.ForEachAsync(regionIds,
    new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },
    async (regionId, token) =>
    {
        await using var db = await factory.CreateDbContextAsync(token);
        totals[regionId] = await db.Orders
            .Where(o => o.RegionId == regionId)
            .SumAsync(o => o.Total, token);
    });
```

ループ本体は並行して実行されるため、ここでの `totals` は `ConcurrentDictionary<int, decimal>` か、あらかじめサイズを確保した配列にしてください。

## プール付きの方式でだけ問題になる落とし穴

### スコープ付きのコンストラクター依存はルートプロバイダーから解決される

これには驚きました。プール付きコンテキストは一度だけ作成されてスコープをまたいで再利用されるため、そのコンストラクター依存はリクエストのスコープから取得できません。EF Core 11 RC 1 で、`TenantDb(DbContextOptions<TenantDb> options, Tenant tenant)` のようなコンストラクターを持つプール付きコンテキスト (`Tenant` はスコープ付き) は、次のように動作します。

- スコープ検証が有効な場合 (`Development` 環境の既定)、解決すると `InvalidOperationException: Cannot resolve scoped service 'Tenant' from root provider.` がスローされます。
- スコープ検証が無効な場合 (`Production` の既定)、黙って成功します。コンテキストはルートプロバイダーから `Tenant` インスタンスを受け取りますが、これはリクエストのスコープが解決する `Tenant` とは別物で、同じキャプチャされたインスタンスがプール付きコンテキストとともに以降のすべてのリクエストに引き継がれます。

つまり、ローカルでは決して見えないバグが、本番ではテナント間のデータ漏洩になります。通常の `AddDbContextFactory` は毎回新しいコンテキストを作るので、この問題はありません。プールを使いつつリクエストごとの状態が必要な場合、ドキュメントにあるパターンは、プール付きファクトリから借りてプロパティを設定する、スコープ付きのラッパーファクトリです。

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public sealed class TenantDbFactory(
    IDbContextFactory<TenantDb> pooled, ITenant tenant) : IDbContextFactory<TenantDb>
{
    public TenantDb CreateDbContext()
    {
        var db = pooled.CreateDbContext();
        db.TenantId = tenant.Id; // reset on every rent, never trust the previous value
        return db;
    }
}

builder.Services.AddPooledDbContextFactory<TenantDb>(o => o.UseSqlServer(cs));
builder.Services.AddScoped<TenantDbFactory>();
```

シングルトンからスコープ付きサービスを使う罠は EF の外でも現れます。["Cannot consume scoped service from singleton"の記事](/ja/2026/05/fix-cannot-consume-scoped-service-from-singleton/)で、コンテナーがそれを拒否する理由を説明しています。

### 自分で追加したフィールドはリセットされない

プール付きコンテキストが戻るとき、EF Core は自身の状態をリセットします。変更トラッカーはクリアされます (エンティティを追加して破棄し、もう一度借りると、`ChangeTracker.Entries()` は空でした)。`DbContext` のサブクラスに追加したフィールドやプロパティには手が加えられません。破棄する前に `"dirty"` を設定した `public string? Note` は、次に借りたときも `"dirty"` のままでした。リクエストごとの値は、上のラッパーのように、借りるたびに代入する必要があります。手動で開いた `DbConnection` にも同じことが当てはまります。コンテキストを返す前に閉じてください。

### OnConfiguring は一度だけ実行される

インスタンスが再利用されるため、`OnConfiguring` が実行されるのはプール内のインスタンスが最初に作成されたときだけです。ここで現在のユーザー、テナント、カルチャを読み取らないでください。

### インスタンスを返すのは Dispose

プール付きファクトリでは、破棄し忘れたコンテキストは返却されません。GC が回収するので古典的な意味でのリークではありませんが、プールの利点を失い、プールは新しいインスタンスで静かに埋まっていきます。必ず `await using` を使ってください。

## どれを選ぶか

- **逐次クエリのみの通常のアプリ**: `AddDbContext` または `AddDbContextPool`。`AppDb` を注入し、各クエリを順番に待機します。コンテキストにコンストラクター依存もリクエストごとの状態もなければ、プールは手軽な改善になります。
- **一部のエンドポイントが並列にファンアウトする**: `AddPooledDbContextFactory` を登録します (または `AddDbContextPool` と、同じオプションの `AddPooledDbContextFactory` の併用)。逐次処理では `AppDb` を、ファンアウトでは `IDbContextFactory<AppDb>` を注入します。
- **コンテキストがコンストラクターでスコープ付きサービスを必要とする**: プールなしの `AddDbContextFactory`。あるいはその状態をスコープ付きラッパーが設定するプロパティに移し、プールを維持します。
- **シングルトン、ホステッドサービス、Blazor Server コンポーネント**: ファクトリです。理由は[ Blazor のシングルトンから IDbContextFactory を使う方法](/ja/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/)にあります。コンテキストが許すならプール付きにします。

すでに `AddDbContextPool` を使っていて 2 つ目の登録を増やしたくない場合の最後の代替案として、並列のブランチごとに `IServiceScopeFactory.CreateAsyncScope()` で子スコープを作り、そこから `AppDb` を解決する方法があります。各スコープが自分専用のプール済みインスタンスを借り、私の 4 ブランチのテストでも同じ `250,250,250,250` が返りました。動作はしますが、ファクトリを注入するより手間がかかり、各ブランチではそのスコープ内の他のすべてのサービスも解決されます。

経験則はこうです。並列化には操作ごとに 1 つのコンテキストが必要で、それを直接提供するのは 2 つのファクトリだけです。プールは、それらのコンテキストをどれだけ安く作れるかを決める独立した判断であり、EF Core 11 ではプール付きファクトリによってコンテキストの作成が約 50 倍安くなります。ただし、コンテキストがコンストラクターにリクエストごとの状態を持たないことが条件です。

## 参考資料

- [Advanced Performance Topics: DbContext pooling (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [DbContext Lifetime, Configuration, and Initialization: using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)
- [`EntityFrameworkServiceCollectionExtensions` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions)
- [Sample: AspNetContextPoolingWithState (dotnet/EntityFramework.Docs)](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Performance/AspNetContextPoolingWithState)
- [SQL Server connection pooling (ADO.NET)](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql-server-connection-pooling)
