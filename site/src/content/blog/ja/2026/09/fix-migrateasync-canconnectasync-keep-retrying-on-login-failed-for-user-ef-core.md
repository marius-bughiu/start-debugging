---
title: "解決: EF Core の MigrateAsync と CanConnectAsync が 'Login failed for user' で 60 秒間リトライし続ける"
description: "EF Core の SQL Server 存在チェックは、EnableRetryOnFailure の有無にかかわらずエラー 18456 を丸 1 分間リトライします。即座に失敗させるか、RetryTimeout を短くするか、EF Core 12 を待ってください。"
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-10"
  - "csharp"
lang: "ja"
translationOf: "2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core"
translatedBy: "claude"
translationDate: 2026-09-15
---

`Database.MigrateAsync()`、`EnsureCreatedAsync()`、`CanConnectAsync()` が約 1 分間固まってから `Login failed for user` を投げる (あるいは `false` を返す) 場合、そのリトライは `EnableRetryOnFailure` ではなく EF Core 自体から来ています。`SqlServerDatabaseCreator` は存在チェックの中で SQL エラー 18456 をリトライ可能として扱い、1 分の `RetryTimeout` が切れるまで 500 ms ごとに再接続を繰り返します。リトライを無効にしても何も変わりません。回避策は 3 つあります。マイグレーションの前に自分で接続を開いて、間違ったパスワードが最初の試行で失敗するようにする、`RetryTimeout` を短くする、ヘルスチェックにタイムアウトを設定する、の 3 つです。本当の修正 ([dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927)) が入るのは EF Core 12 だけです。以下はすべて EF Core 10.0.12 と 11.0.0-rc.1 で計測したもので、両者の挙動は同一です。

## エラーの実際の姿

例外そのものはごく普通の SQL Server のログイン失敗です。手がかりになるのは、届くまでにかかる時間です。

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Login failed for user 'app'.
Error Number:18456,State:1,Class:14
```

典型的な症状は次のとおりです。

- 起動時にマイグレーションを実行するコンテナーの接続文字列に間違ったパスワードが入っていると、60 秒間黙ったままになってからクラッシュします。そのため先にオーケストレーターのスタートアッププローブがコンテナーを殺してしまい、例外を目にすることがないことがよくあります。
- `AddDbContextCheck<T>()` を使った `/health` は、資格情報が間違っていると `Unhealthy` を報告するまでに丸 1 分かかり、ロードバランサーのプローブはそのずっと前にタイムアウトします。
- SQL Server のエラーログ (または Azure SQL の監査) に、1 回のプロセス起動から 100 件を超える `Login failed for user` のエントリーが一気に記録されます。
- 「間違った資格情報なら `CanConnectAsync` が `false` を返す」ことを検証する統合テストは合格しますが、1 件ごとに 1 分かかります。

同じ接続文字列を使った通常のクエリは最初の試行で失敗します。遅くなるのは「このデータベースは存在するか」を問い合わせる API に限られます。

## EF Core がログイン失敗をリトライする理由

`CanConnectAsync`、`MigrateAsync`、`EnsureCreatedAsync`、`EnsureDeletedAsync` はいずれも最初に `IRelationalDatabaseCreator.ExistsAsync()` を呼び出します。SQL Server の場合、その実体は [`SqlServerDatabaseCreator`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) で、その存在チェックは独自のループになっています。

```csharp
// EF Core 10.0.12 and 11.0.0-rc.1, SqlServerDatabaseCreator (abridged)
public virtual TimeSpan RetryDelay { get; set; } = TimeSpan.FromMilliseconds(500);
public virtual TimeSpan RetryTimeout { get; set; } = TimeSpan.FromMinutes(1);

// inside ExistsAsync: open the connection, run SELECT 1, and on SqlException:
if (!retryOnNotExists && IsDoesNotExist(e)) // 4060, 1832, 5120
    return false;
if (DateTime.UtcNow > giveUp || !RetryOnExistsFailure(e))
    throw;
await Task.Delay(RetryDelay, ct);

private bool RetryOnExistsFailure(SqlException exception)
    => (exception.Number is 203 && exception.InnerException is Win32Exception)
       || exception.Number is 233 or -2 or 4060 or 1832 or 5120 or 18456;
```

エラー 18456 は EF Core 6.0 で [dotnet/efcore#25832](https://github.com/dotnet/efcore/pull/25832) によってこのリストに追加されました。これは [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644) の回避策でした。Azure SQL は `CREATE DATABASE` の直後に短時間 `Login failed` を返すことがあり、新しいデータベースに対する `EnsureCreated` や最初の `Migrate` がランダムに失敗していたのです。この回避策が必要なのは作成直後のチェック (`CreateAsync` は `ExistsAsync(retryOnNotExists: true)` を呼びます) だけでしたが、同じメソッドがすべての存在チェックに使われています。そのため、単に間違っているだけのパスワードが「データベースがまだ準備中」として扱われ、丸 1 分間リトライされます。2026-08-31 に起票された [dotnet/efcore#38886](https://github.com/dotnet/efcore/issues/38886) が報告したのはまさにこの現象です。

`EnableRetryOnFailure` が犯人に見えて実はそうではない理由も、これで説明がつきます。このループは実行戦略の 1 回の操作の中で動いています。1 分が過ぎると、戦略は `SqlServerTransientExceptionDetector.ShouldRetryOn(18456)` に問い合わせ、`false` を受け取り (18456 はそのリストに含まれていません)、例外を再スローします。リトライが有効でも無効でも、かかる時間は同じです。`errorNumbersToAdd` も関係ありません。18456 をそこに追加すれば別ですが、それは状況を悪化させるだけです。

さらに `CanConnectAsync` は全体を `try/catch` で包み、キャンセル以外のあらゆる例外を `false` に変換します。ヘルスチェック版が決して例外を投げないのはこのためで、「いいえ」と答えるまでに 1 分かかるだけです。

## SQL Server なしの最小限の再現

これを確認するのにサーバーは必要ありません。物理的な接続オープンのたびに番号 18456 の `SqlException` を投げる `DbConnectionInterceptor` が、資格情報の間違ったサーバーの代わりになります。`SqlException` のコンストラクターは internal なので、リフレクションで生成しています。プローブはオープンの試行回数を数え、各呼び出しの時間を計測します。

```csharp
// .NET 10, EF Core 10.0.12 (also run on .NET 11 RC 1 with EF Core 11.0.0-rc.1.26425.128)
public class FailingOpen(int number) : DbConnectionInterceptor
{
    int _attempts;
    public int Attempts => _attempts;

    public override ValueTask<InterceptionResult> ConnectionOpeningAsync(
        DbConnection c, ConnectionEventData e, InterceptionResult r, CancellationToken ct = default)
    {
        Interlocked.Increment(ref _attempts);
        throw FakeSql.Create(number, "Login failed for user 'app'.");
    }
}

public class Shop(FailingOpen interceptor, bool retry) : DbContext
{
    public DbSet<Product> Products => Set<Product>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlServer(
                "Server=db.invalid;Database=Shop;User Id=app;Password=wrong;Encrypt=False",
                sql => { if (retry) sql.EnableRetryOnFailure(); })
            .AddInterceptors(interceptor);
}
```

結果は EF Core 10.0.12 (SqlClient 6.0) と EF Core 11.0.0-rc.1 (SqlClient 7.0) で同一でした。

| 呼び出し | エラー | `EnableRetryOnFailure` | オープン試行回数 | 経過時間 | 結果 |
|---|---|---|---|---|---|
| `CanConnectAsync()` | 18456 | 無効 | 121 | 60.4 s | `false` |
| `CanConnectAsync()` | 18456 | 有効 | 121 | 60.2 s | `false` |
| `MigrateAsync()` | 18456 | 有効 | 121 | 60.2 s | `SqlException` 18456 |
| `EnsureCreatedAsync()` | 18456 | 有効 | 121 | 60.2 s | `SqlException` 18456 |
| `Products.ToListAsync()` | 18456 | 有効 | 1 | 0.1 s | `SqlException` 18456 |
| `CanConnectAsync()` | 4060 | 有効 | 1 | 0.0 s | `false` |

インターセプターは即座に失敗するので、121 回が上限です。60 秒間、500 ms ごとに 1 回です。実際のサーバーに対しては、各試行で TCP 接続、TLS、ログインのラウンドトリップのコストもかかるため試行回数は減りますが、1 分という時間は変わりません。最後の行が非対称性を示しています。*存在しないデータベース* (4060) は即座に `false` へショートカットされる一方、*間違ったパスワード* こそがリトライされるケースです。

## 修正方法の詳細

優先度の高い順に並べています。

### 1. サーバー側の state コードを使って資格情報を直す

1 分間のリトライは、本当の問題の発見を遅らせるだけです。クライアントは常に `State:1` を報告します。本当の理由は、サーバーが state コードとしてエラーログに書き込みます (Azure SQL では監査が記録します)。

| State | 意味 |
|---|---|
| 2, 5 | ログインが存在しない |
| 6 | Windows ログイン名が SQL 認証で使われた |
| 7 | ログインが無効化されている (かつパスワードが間違っている) |
| 8 | パスワードが間違っている |
| 18 | パスワードの変更が必要 |
| 38, 40 | ログインは有効だが、要求されたデータベースを開けない |
| 58 | Windows 認証のみのモードのサーバーに SQL 認証を使った |

完全な一覧は [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error) のページにあります。State 38 と 40 は覚えておく価値があります。資格情報の問題に見えますが、実際には権限かデータベース名の問題だからです。これらは [CREATE DATABASE permission denied の記事](/ja/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/) で扱った 4060 のケースの親戚です。

### 2. マイグレーションの前に即座に失敗させる

起動時にマイグレーションを実行するなら、まず自分で接続を開いてください。`OpenConnectionAsync` は存在チェックのループを通らないので、間違ったパスワードは最初の試行で例外になります。接続がすでに開いていれば、`MigrateAsync` はそれを再利用します。

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
static async Task MigrateFailFastAsync(DbContext db, CancellationToken ct = default)
{
    var opened = false;
    try
    {
        await db.Database.OpenConnectionAsync(ct);
        opened = true;
    }
    catch (SqlException ex) when (ex.Number == 4060)
    {
        // Database missing (or no user for this login in it): let MigrateAsync decide.
    }

    try
    {
        await db.Database.MigrateAsync(ct);
    }
    finally
    {
        if (opened) await db.Database.CloseConnectionAsync();
    }
}
```

プローブでは、`EnableRetryOnFailure` を有効にした状態で、`SqlException` 18456 まで 1 回の試行、0.0 s でした。4060 の `catch` は重要です。マイグレーションでデータベースを *作成* することが前提の場合 (ローカル開発や最初のデプロイ)、データベースがまだ存在しないため事前オープンは 4060 で失敗します。これを握りつぶすことで、`MigrateAsync` が通常の作成パスをたどれるようになり、Azure SQL が実際に必要とする作成直後のリトライもそのまま働きます。データベースが常に別途プロビジョニングされるなら、`catch` を外して 4060 でも起動を失敗させてください。

本番のパイプラインでは、長期的にはマイグレーションをアプリケーションの起動処理から完全に切り離し、デプロイのステップとして [マイグレーションバンドル](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) を実行するほうが優れた選択です。バンドルも同じループに当たりますが、1 分後に失敗するパイプラインのステップは、クラッシュループする Pod よりはるかにましです。

### 3. `RetryTimeout` に上限を設ける

`RetryTimeout` と `RetryDelay` は `SqlServerDatabaseCreator` の public で設定可能なプロパティですが、このクラスは `.Internal` 名前空間にあります。これを使うと EF1001 アナライザーの警告が出ますし、その形はリリース間で変わる可能性があります。

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
#pragma warning disable EF1001 // Internal EF Core API usage.
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;

var creator = (SqlServerDatabaseCreator)db.GetService<IRelationalDatabaseCreator>();
creator.RetryTimeout = TimeSpan.FromSeconds(5);
await db.Database.MigrateAsync();
#pragma warning restore EF1001
```

これを入れた状態で、プローブでは `MigrateAsync` が 11 回の試行、5.0 s でした。同じタイムアウトが作成直後のチェックにも適用されるので、Azure SQL で `EnsureCreated` や `Migrate` がデータベースを作成する場合は 0 にしないでください。数秒にしておけば #15644 の回避策を生かしたまま、1 分の待ちをなくせます。creator はスコープ付きサービスなので、起動時に 1 回設定するのではなく、マイグレーションを実行するコンテキストのインスタンスごとに設定してください。

### 4. データベースのヘルスチェックにタイムアウトを設定する

`AddDbContextCheck<T>()` はデフォルトで `CanConnectAsync` を実行し、[`HealthCheckRegistration.Timeout`](https://github.com/dotnet/aspnetcore/blob/main/src/HealthChecks/Abstractions/src/HealthCheckRegistration.cs) のデフォルトは `Timeout.InfiniteTimeSpan` です。`AddCheck` と違って `AddDbContextCheck` には `timeout` パラメーターがないので、2 つのことを行います。テストを存在チェックのループを通らないものに置き換え、登録のタイムアウトを `HealthCheckServiceOptions` 経由で設定します。

```csharp
// .NET 10, ASP.NET Core 10.0, Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore 10.0.12
builder.Services.AddHealthChecks()
    .AddDbContextCheck<Shop>(customTestQuery: async (db, ct) =>
    {
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();
        return true;
    });

// The registration is named after the context type unless you pass a name.
builder.Services.Configure<HealthCheckServiceOptions>(o =>
    o.Registrations.Single(r => r.Name == nameof(Shop)).Timeout = TimeSpan.FromSeconds(5));
```

`DbContextHealthCheck` はテストが投げた例外をすべて捕捉し、例外を添えて `Unhealthy` を報告します。そのため、間違ったパスワードは 1 分後の素っ気ない失敗ではなく、ヘルスレポート内の `Login failed for user 'app'.` として表示されるようになります。タイムアウトは、TCP 接続は受け付けるのに一切応答しないサーバーなど、それ以外のあらゆるケースに対する最後の防御線です。一般的なセットアップは [Minimal API にヘルスチェックエンドポイントを追加する記事](/ja/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/) で扱っています。

### 5. EF Core 12 がリリースされたらアップグレードする

2026-09-10 にマージされ、マイルストーンが 12.0.0 の [dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927) は、`retryOnNotExists` を `RetryOnExistsFailure` まで渡すようにし、18456 がリトライされるのはプロバイダーがデータベースを作成した直後だけになります。

```csharp
// EF Core main (12.0), after dotnet/efcore#38927
|| (exception.Number is 233 or -2 or 4060 or 1832 or 5120)
|| (retryOnLoginFailure && exception.Number is 18456))
```

現時点では、この変更は `release/10.0` にも `release/11.0` にも入っていません (どちらも古い 1 行のチェックのままです)。そのため、EF Core 11.0 GA はほぼ確実に 1 分間のリトライを抱えたままリリースされます。私は EF Core 12 のデイリービルドは試していません。PR は両方のパスについて同期版と非同期版の回帰テストを追加しているので、10 と 11 で使えるのは上記の回避策です。

## 落とし穴と紛らわしいケース

**キャンセルトークンは、タイミングだけでなく結果も変えます。** `CanConnectAsync(ct)` はキャンセルを再スローするので、5 秒の `CancellationTokenSource` を使うと、プローブは `false` ではなく 10 回の試行の後に `TaskCanceledException` を受け取りました。boolean だけを確認しているコードには `catch (OperationCanceledException)` が必要です。

**同期版のパスはスレッドをブロックします。** `Database.Migrate()` と `CanConnect()` は同じループの中で `Thread.Sleep(RetryDelay)` を使うので、その 1 分間はスレッドプールのスレッドを占有し続けます。これも、リクエストを処理するコードの外でマイグレーションを実行すべき理由の 1 つです。

**エラー 4060 は `EnableRetryOnFailure` によってリトライされますが、ここではされません。** 4060 (`Cannot open database "Shop" requested by the login`) は一時的エラーのリストに *含まれています*。`CanConnectAsync` はこれに対して即座に `false` を返しますが、デフォルトの `EnableRetryOnFailure()` (6 回のリトライ、最大遅延 30 s) を使った通常のクエリは、57.9 s の間に 7 回試行してから `RetryLimitExceededException` を投げました。クエリ実行時の「login failed」に約 1 分かかる場合は、creator のループを疑う前に内部例外の番号を確認してください。また、どうせ実行戦略を調整するなら、[実行戦略とユーザートランザクションの記事](/ja/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) で、実行戦略が仕掛けるもう 1 つの罠を扱っています。

**ログイン失敗のノイズには副作用があります。** リトライのたびに、サーバー上では実際のログイン失敗が発生します。`CHECK_POLICY = ON` の場合、SQL ログインは Windows のアカウントロックアウトポリシーに従い、Azure SQL の監査はすべての試行を記録します。1 分間のリトライでアカウントがロックされることがあり、そうなると正しいパスワードでも、18456 ではなくエラー 18486 ("the account is currently locked out") で失敗するようになります。

**タイムアウトは別の問題です。** 1 分が `Login failed` ではなく `Timeout expired` で終わるなら、見ているのは長時間のマイグレーション中のコマンドまたはゲートウェイのタイムアウトです。これは [EF Core マイグレーション中の SqlException timeout expired](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) で扱っています。

## 関連記事

- [解決: dotnet ef database update 実行時の CREATE DATABASE permission denied in database 'master'](/ja/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [マイグレーションバンドルで EF Core 11 のマイグレーションを本番環境に適用する方法](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [解決: EF Core マイグレーション中の SqlException timeout expired](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [解決: The configured execution strategy does not support user-initiated transactions](/ja/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [ASP.NET Core 11 の Minimal API にヘルスチェックエンドポイントを追加する方法](/ja/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/)

## 出典

- [dotnet/efcore#38886: CanConnectAsync / MigrateAsync retries on authentication failure instead of throwing](https://github.com/dotnet/efcore/issues/38886) とその修正である [dotnet/efcore#38927: Restrict SQL Server login failure retries to post-creation checks](https://github.com/dotnet/efcore/pull/38927)。
- [dotnet/efcore#25832: Update SQL Server transient error list](https://github.com/dotnet/efcore/pull/25832)。[dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644) のために 18456 を追加したものです。
- [v10.0.12 の `SqlServerDatabaseCreator.cs`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs)、[v11.0.0-rc.1 のもの](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs)、および [`SqlServerTransientExceptionDetector.cs`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerTransientExceptionDetector.cs)。
- [接続の回復性](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) (Microsoft Learn, EF Core)。
- [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error) (Microsoft Learn, SQL Server)。
- dotnet/aspnetcore の [`DbContextHealthCheck.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/HealthChecks.EntityFrameworkCore/src/DbContextHealthCheck.cs)。
