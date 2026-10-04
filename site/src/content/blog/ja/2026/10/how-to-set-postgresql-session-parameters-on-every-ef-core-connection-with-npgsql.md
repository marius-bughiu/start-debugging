---
title: "Npgsql を使う EF Core の全接続に search_path や statement_timeout などの PostgreSQL セッションパラメーターを設定する方法"
description: "一度だけ実行した SET は、Npgsql が接続をプールに戻した瞬間に DISCARD ALL で消去されます。Search Path と Options の接続文字列キーワードで search_path と statement_timeout をスタートアップパケットに含め、うまくいかない場合は ALTER ROLE か ConnectionOpened インターセプターにフォールバックします。また、UsePhysicalConnectionInitializer の SET が黙って失われる理由も解説します。"
pubDate: 2026-10-04
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "dotnet-10"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-set-postgresql-session-parameters-on-every-ef-core-connection-with-npgsql"
translatedBy: "claude"
translationDate: 2026-10-04
---

結論から言うと、`SET statement_timeout = ...` を一度実行しただけで設定が維持されると期待してはいけません。Npgsql はプールされた接続を再利用するたびに `DISCARD ALL` を送信し、すべてのセッション設定をデフォルトに戻します。代わりに、設定を接続のスタートアップパケットに含めてください。スキーマの検索パスには `Search Path=tenant_a,public`、それ以外のパラメーターには `Options=-c statement_timeout=5s -c lock_timeout=1s` を使います。PostgreSQL はスタートアップパラメーターをセッションのデフォルトとして扱うため、`DISCARD ALL` は *あなたが指定した* 値に戻り、EF Core 側には追加のコードがまったく必要ありません。接続文字列を変更できない場合は、サーバー側で `ALTER ROLE app_user SET ...` を使うか、`ConnectionOpenedAsync` で `SET` を実行する `DbConnectionInterceptor` を使います(接続を開くたびに往復が 1 回増えます)。

以下の内容はすべて、.NET 10 (SDK 10.0.302) と `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (EF Core 10.0.4、Npgsql 10.0.3) を使い、PostgreSQL 18.4 に対して実行したものです。Npgsql が送信したすべてのステートメントがサーバーログに出力されるよう、`log_statement=all` を有効にしています。引用している出力は、これらの実行結果です。

## 一度きりの SET が消えてしまう理由

Npgsql は物理接続をプールします。`NpgsqlConnection` を破棄する(または EF Core がクエリ後に接続を閉じる)と、物理接続はプールに戻り、Npgsql はその接続にリセットのマークを付けます。リセットは `DISCARD ALL` であり、PostgreSQL はこれを `CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; DEALLOCATE ALL; UNLISTEN *; ...` と定義しています。ここで重要なのは `RESET ALL` の部分で、そのセッションで実行したすべての `SET` が失われます。

最小の再現コードを示します。プールを 1 接続に制限しているので、2 回目のオープンでは必ず同じ物理セッションが返されます。

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Maximum Pool Size=1");

int pid1, pid2;
await using (var c = await ds.OpenConnectionAsync())
{
    pid1 = c.ProcessID;
    await new NpgsqlCommand("SET search_path = tenant_a; SET statement_timeout = '1s'", c)
        .ExecuteNonQueryAsync();
}
await using (var c = await ds.OpenConnectionAsync())
{
    pid2 = c.ProcessID;
    // same physical=True search_path="$user", public statement_timeout=0
}
```

バックエンドプロセスは同じままですが、両方の設定がサーバーのデフォルトに戻っています。サーバーログを見ると理由がわかります。

```text
[95652] execute <unnamed>: SET search_path = tenant_a
[95652] execute <unnamed>: SET statement_timeout = '1s'
[95652] statement: DISCARD ALL
[95652] execute <unnamed>: SHOW search_path
```

`DISCARD ALL` は接続を閉じたときに送信されるわけではない点に注意してください。Npgsql は送信を遅延させ、その物理接続での次のコマンドの直前に書き込むため、余分な往復は発生しません。また、何か変更したかどうかにかかわらず実行されるので、慎重に使っても回避できません。

EF Core では、素の ADO.NET よりも影響が大きくなります。EF Core は操作ごとに接続を開閉するためです。クエリを実行し、続けて `SqlQueryRaw` を呼び出す `DbContext` は接続を 2 回開き、それぞれのオープンでリセット直後のセッションに当たる可能性があります。

## 方法 1: Search Path 接続文字列キーワード

スキーマの検索パスについては、Npgsql 専用のキーワードがあります。これは `SET` ではなくスタートアップパラメーターとして送信されます。

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Search Path=tenant_a,public");

await using var c = await ds.OpenConnectionAsync();
// SHOW search_path            -> tenant_a,public
// SELECT count(*) FROM orders -> 1 (resolves to tenant_a.orders)
```

この接続では、サーバーログに `SET` がまったく出てきません。値はスタートアップパケットで運ばれ、PostgreSQL がそれをセッションのデフォルトとして使います。

## 方法 2: その他のパラメーターには Options=-c

`Options` キーワードは PostgreSQL の `options` スタートアップパラメーターとしてそのまま渡されます。これは `postgres` コマンドラインと同じ `-c name=value` 構文を受け付けます。`statement_timeout`、`lock_timeout`、`idle_in_transaction_session_timeout`、`work_mem`、`search_path` など、一般ユーザーが `SET` できるものすべてを指定できます。

```csharp
// .NET 10, Npgsql 10.0.3
var cs = "Host=localhost;Port=55432;Username=postgres;Database=postgres;" +
         "Options=-c statement_timeout=2s -c search_path=tenant_a,public -c lock_timeout=500ms";
var ds = NpgsqlDataSource.Create(cs);

await using (var c = await ds.OpenConnectionAsync())
{
    // statement_timeout=2s search_path=tenant_a,public lock_timeout=500ms
    await new NpgsqlCommand("SET statement_timeout = '9s'", c).ExecuteNonQueryAsync();
    // statement_timeout=9s
}
await using (var c = await ds.OpenConnectionAsync())
{
    // statement_timeout=2s   <- DISCARD ALL reset it to the startup value, not to 0
}
```

この性質こそが、スタートアップパケットを正しい置き場所にしています。`RESET ALL` は各パラメーターを、そのセッションで `SET` が一度も実行されなかった場合の値に戻します。スタートアップパラメーターの場合、その値はあなたが渡した値です。そのため、一時的にタイムアウトを引き上げたリクエストが次のリクエストに影響を残すことはなく、次のリクエストにはサーバーのデフォルトではなくあなたのデフォルトが適用されます。

接続文字列をコードで組み立てる場合は、クォート処理を任せられる `NpgsqlConnectionStringBuilder` を使ってください。スペース区切りの `Options` 値はクォートされます。

```csharp
// .NET 10, Npgsql 10.0.3
var csb = new NpgsqlConnectionStringBuilder("Host=localhost;Port=55432;Username=postgres;Database=sp_demo")
{
    SearchPath = "tenant_b,public",
    Options = "-c statement_timeout=5s -c lock_timeout=1s",
    ApplicationName = "orders-api",
};
// Host=localhost;Port=55432;Username=postgres;Database=sp_demo;Search Path=tenant_b,public;
// Options="-c statement_timeout=5s -c lock_timeout=1s";Application Name=orders-api
```

## EF Core への組み込み

設定は接続文字列の中にあるため、EF Core 側で特別なことは不要です。文字列を `UseNpgsql` に渡すか、`NpgsqlDataSource` を登録してそれを渡します。

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(
    builder.Configuration.GetConnectionString("Orders")));

// appsettings.json
// "ConnectionStrings": {
//   "Orders": "Host=db;Database=orders;Username=app;Search Path=tenant_b,public;Options=-c statement_timeout=5s -c lock_timeout=1s"
// }
```

そのコンテキストでクエリを実行すると、EF Core が開くすべての接続でタイムアウトが有効になっていることを確認できます。

```csharp
var st = await db.Database
    .SqlQueryRaw<string>("SELECT current_setting('statement_timeout') AS \"Value\"")
    .SingleAsync();
// 5s
```

タイムアウトが発生すると、PostgreSQL はサーバー側でステートメントをキャンセルし、`SqlState` が `57014`、メッセージが `canceling statement due to statement timeout` の `PostgresException` が発生します。接続は開いたままで、引き続き使用できます。これは Npgsql 自身の `Command Timeout` (デフォルトは 30 秒) とは異なります。こちらはクライアント側で強制されるもので、期限が切れると Npgsql はクエリをキャンセルし、`TimeoutException` をラップした `NpgsqlException` をスローします。このとき `SqlState` はありません。`Command Timeout` は `statement_timeout` より少し長めにしてください。そうすれば、クライアントの検知に依存せず明確なエラーを返してくれるサーバー側の制限が、先に作動します。

## 方法 3: サーバー側の ALTER ROLE または ALTER DATABASE

接続文字列が他の誰かの管理下にある場合(プラットフォームチームや、アプリごとに変更できないシークレットストアなど)は、デフォルト値をサーバーに設定します。

```sql
-- PostgreSQL 18
ALTER ROLE app_user SET search_path = tenant_a, public;
ALTER ROLE app_user SET statement_timeout = '15s';

-- or scoped to one database
ALTER ROLE app_user IN DATABASE orders SET statement_timeout = '15s';
```

`app_user` として新しく接続すると、クライアント側の設定なしで `search_path=tenant_a, public` と `statement_timeout=15s` が返ってきました。これらのロールのデフォルトは、セッションの開始状態の一部なので、`DISCARD ALL` の後も維持されます。

複数の方法を組み合わせる場合は、優先順位が重要です。同じロールが `Options=-c statement_timeout=3s` を付けて接続すると `3s` になりました。スタートアップパラメーターはロールやデータベースのデフォルトを上書きし、それらはさらに `postgresql.conf` を上書きします。これにより便利な階層化ができます。ロールには保守的なデフォルトを置き、あるサービスがより長いクエリを正当に必要とする場合(レポートジョブやマイグレーション実行ツールなど)は、接続文字列でアプリごとに上書きします。

`postgresql.conf` で `statement_timeout` をグローバルに設定するのは避けてください。メンテナンス用セッション、`pg_dump`、さらにあなた自身の `psql` セッションにも適用されてしまうため、PostgreSQL のドキュメントでも推奨されていません。

## 方法 4: 接続を開くたびに SET を実行する DbConnectionInterceptor

値が静的でない場合もあります。リクエストごとにスキーマを選ぶマルチテナントアプリや、現在のユーザーから導出される設定は、固定の接続文字列には置けません。EF Core の[インターセプター](/ja/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/)を使うと、接続を開いた直後に実行されるフックを利用できます。

```csharp
// .NET 10, EF Core 10.0.4
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class SessionSettingsInterceptor : DbConnectionInterceptor
{
    const string Sql = "SET statement_timeout = '5s'; SET lock_timeout = '1s'";

    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        cmd.ExecuteNonQuery();
    }

    public override async Task ConnectionOpenedAsync(
        DbConnection connection, ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }
}

// registration
builder.Services.AddDbContext<AppDbContext>(o => o
    .UseNpgsql(connectionString)
    .AddInterceptors(new SessionSettingsInterceptor()));
```

同期メソッドと非同期メソッドの両方をオーバーライドしてください。EF Core は使用した API に対応する方を呼び出すため、同期版を忘れると `db.Orders.Count()` が設定なしで黙って実行されます。

これは機能しますが、そのコストはログにそのまま表れています。2 つの `DbContext` インスタンスがそれぞれ LINQ クエリを 1 回、生 SQL クエリを 1 回実行したところ、接続のオープンが 4 回、`SET` のペアも 4 回発生しました。

```text
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT count(*)::int ...
[95655] statement: DISCARD ALL
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT s."Value" ...
```

接続を開くたびに往復が 1 回余分にかかります。ローカルソケットなら誤差ですが、別のアベイラビリティゾーンにあるマネージドデータベースに対しては、クエリ自体と同程度の大きさになることもあります。静的な値であれば、方法 1 から 3 のほうが明らかに優れています。リクエストごとに変わる値については、そのパラメーターが本当にセッション全体に必要なのか、それとも既に実行中のトランザクション内の `SET LOCAL` で十分なのかを検討してください。

## 落とし穴: UsePhysicalConnectionInitializer

`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer` は一見ぴったりの選択肢に見えます。物理接続が最初に作成されたときにコールバックを一度だけ実行するため、"セッションごとに 1 回、オープンごとのオーバーヘッドなし" のように思えます。しかし実際には次のようになります。

```csharp
// .NET 10, Npgsql 10.0.3
var b = new NpgsqlDataSourceBuilder(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Maximum Pool Size=1");
b.UsePhysicalConnectionInitializer(
    conn => { using var cmd = new NpgsqlCommand("SET statement_timeout = '4s'", conn); cmd.ExecuteNonQuery(); },
    async conn => { await using var cmd = new NpgsqlCommand("SET statement_timeout = '4s'", conn); await cmd.ExecuteNonQueryAsync(); });
var ds = b.Build();

// open 0: statement_timeout=4s inits=1
// open 1: statement_timeout=0  inits=1
// open 2: statement_timeout=0  inits=1
```

イニシャライザーは約束どおり一度だけ実行され、最初のオープンでは `4s` が見えます。その後、接続がプールに戻ると `DISCARD ALL` が `SET` を消去し、物理接続がまだ存在しているためイニシャライザーは二度と実行されません。最初のリクエスト以降のすべてのリクエストが、タイムアウトなしで実行されます。このメソッドに関する Npgsql 自身の XML ドキュメントにも、ここで適用した設定はリセットを無効にしない限り `DISCARD ALL` によって元に戻されるという警告があります。

修正方法は、`No Reset On Close=true` と組み合わせることです。EF Core では、`ConfigureDataSource` を使うと `UseNpgsql` の中からビルダーにアクセスできます。

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
options.UseNpgsql(
    "Host=localhost;Port=55432;Username=postgres;Database=sp_demo;No Reset On Close=true",
    o => o.ConfigureDataSource(ds => ds.UsePhysicalConnectionInitializer(
        conn => { using var cmd = new NpgsqlCommand("SET search_path = tenant_b, public", conn); cmd.ExecuteNonQuery(); },
        async conn => { await using var cmd = new NpgsqlCommand("SET search_path = tenant_b, public", conn); await cmd.ExecuteNonQueryAsync(); })));

// ctx 0: widgets=1 search_path=tenant_b, public inits=1
// ctx 1: widgets=1 search_path=tenant_b, public inits=1
// ctx 2: widgets=1 search_path=tenant_b, public inits=1
```

`SET` は 1 回だけで、ログに `DISCARD ALL` はなく、設定はコンテキストをまたいで維持されます。代償として、*何も* リセットされなくなります。どこかのコードパス(マイグレーションのヘルパー、診断用クエリ、ライブラリなど)が `SET` を実行すると、その値は、一時テーブルや `LISTEN` の登録とともに、その物理接続の後続のすべての利用者に漏れてしまいます。この組み合わせは、プール上で実行されるすべてのステートメントを自分で管理できる場合にのみ使用してください。静的な値だけが必要なら、接続文字列のほうがシンプルで安全です。

## SET LOCAL によるクエリ単位の上書き

処理が遅いとわかっている操作のためにタイムアウトを引き上げるだけなら、セッションを変更する必要はまったくありません。`SET LOCAL` は現在のトランザクションの終了まで有効です。

```csharp
// .NET 10, EF Core 10.0.4
await using var tx = await db.Database.BeginTransactionAsync();
await db.Database.ExecuteSqlRawAsync("SET LOCAL statement_timeout = '60s'");
await db.Database.ExecuteSqlRawAsync("REFRESH MATERIALIZED VIEW sales_summary");
await tx.CommitAsync();
// after commit: statement_timeout is back to the session default
```

検証では、`SHOW statement_timeout` はトランザクション内で `100ms` を返し、コミット直後は同じ接続で `0` を返しました。`DISCARD ALL` は不要です。これは、次に説明するトランザクションモードの PgBouncer 経由でも機能する唯一のアプローチでもあります。

## プーラー、マイグレーション、タイムアウトに関する注意点

**PgBouncer は未知のスタートアップパラメーターを拒否します。** デフォルトでは、PgBouncer は自身が追跡するスタートアップパラメーターだけを受け付け、`options` を含むそれ以外はエラーにします。対処法は、`options` を `ignore_startup_parameters` に追加する(この場合 PgBouncer は設定を黙って破棄します)か、デフォルトを `ALTER ROLE` に移すかのどちらかです。PostgreSQL 18 は `search_path` をクライアントに報告するため、18 では PgBouncer が標準で追跡します。トランザクションモードまたはステートメントモードでは、PgBouncer が次のトランザクションを別のバックエンドに割り当てる可能性があり `DISCARD ALL` が意味をなさないため、Npgsql のドキュメントでも `No Reset On Close=true` を設定するよう案内されています。このモードでは、トランザクション外の `SET` は事実上ランダムな結果になるため、`SET LOCAL` かロールのデフォルトを使ってください。

**search_path は、修飾なしのテーブルがどこに作成されるかを決めます。** `Search Path=tenant_b,public` を指定して `HasDefaultSchema` を使わなかった場合、`EnsureCreatedAsync` は `Widgets` を `tenant_b` に作成しました。Npgsql プロバイダーは `__EFMigrationsHistory` も修飾なしの `CREATE TABLE IF NOT EXISTS` で作成するため、アプリと異なる `search_path` を持つ接続文字列を使うマイグレーション実行ツールは、2 つ目の履歴テーブルを作成し、すべてのマイグレーションを再実行しようとします。モデルでスキーマを固定する(`modelBuilder.HasDefaultSchema("tenant_b")` と `MigrationsHistoryTable("__EFMigrationsHistory", "tenant_b")`)か、実行ツールがまったく同じ接続文字列を使うようにしてください。また、`EnsureCreated` は検索パス内のテーブルだけでなく、データベースに *何らかの* ユーザーテーブルがあるかどうかを確認する点にも注意が必要です。すでに `tenant_a.orders` があったデータベースでは、作成が完全にスキップされ、最初の挿入が `42P01: relation "Widgets" does not exist` で失敗しました。

**マイグレーションには専用のタイムアウトが必要です。** 共有の接続文字列に 5 秒の `statement_timeout` があると、デプロイ中の長い `CREATE INDEX` が強制終了されます。マイグレーション実行ツールには、`Options=-c statement_timeout=0` を指定した専用の接続文字列を与えてください(スタートアップパラメーターはロールのデフォルトより優先されます)。問題のクライアント側の半分については、[EF Core マイグレーションのタイムアウトに関するガイド](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)を参照してください。

**実際に欲しいのは、たいてい lock_timeout です。** ロックで詰まったクエリは本番障害でよくある原因ですが、`statement_timeout` は全体の予算を使い切ってからでないと検知できません。`lock_timeout=1s` なら `55P03` で素早く失敗し、正当に長いクエリはそのまま実行できます。PostgreSQL 17 では `transaction_timeout` も追加されており、ステートメントごとではなくトランザクション全体の上限を設定できます。

**この方法では設定できないパラメーターもあります。** サーバー全体のパラメーターは `options` では拒否されます。`-c shared_buffers=1GB` は `55P02 parameter "shared_buffers" cannot be changed without restarting the server` で失敗し、`log_checkpoints` のような `sighup` パラメーターは `55P02 ... cannot be changed now` で失敗します。スーパーユーザー専用のパラメーターは、通常のロールでは失敗します。`app_user` として `-c log_statement=none` を指定すると `42501 permission denied to set parameter "log_statement"` になりました。いずれの場合も `OpenAsync` が例外をスローするため、誤った設定のまま黙って動作することはなく、最初のリクエストで気づけます。

## アプローチの選び方

固定値には接続文字列を使ってください。スキーマには `Search Path`、それ以外には `Options=-c ...` です。オープンごとのコストはゼロで、プールのリセットの後も維持され、EF Core、Dapper、素の Npgsql のいずれでも機能します。接続文字列が自分のものではない場合や、その下のセーフティネットとして、`ALTER ROLE ... SET` を使ってください。`ConnectionOpened` インターセプターは、値が実行時の状態に依存する場合にのみ使い、余分な往復は受け入れてください。`No Reset On Close=true` と組み合わせた `UsePhysicalConnectionInitializer` は、すべてのステートメントを自分で管理しているプール向けのニッチなツールです。

### 関連記事

- [What is an EF Core interceptor and when do I need one?](/ja/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) では、`ConnectionOpened` を使う方法がフックするインターセプターのパイプラインを解説しています。
- [How to use EF Core 11 interceptors for auditing](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) では、`SaveChanges` インターセプターを最初から最後まで紹介しています。
- [How to use named query filters for soft delete and multi-tenancy in EF Core 11](/ja/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) は、スキーマ単位のテナント分離で `search_path` を切り替える方法に代わる、行レベルの方法です。
- [How to log the SQL that EF Core 11 generates](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) は、クライアント側からサーバーに何が届くかを確認するのに役立ちます。
- [How to atomically append to a PostgreSQL jsonb array with EF Core and Npgsql](/ja/2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql/) は、PostgreSQL 18 に対してテストした、Npgsql 固有のもう 1 つのパターンです。

### 参考資料

- [Connection String Parameters](https://www.npgsql.org/doc/connection-string-parameters.html), Npgsql ドキュメント (`Search Path`、`Options`、`No Reset On Close`、`Command Timeout`)
- [Compatibility notes: pgbouncer](https://www.npgsql.org/doc/compatibility.html), Npgsql ドキュメント
- [`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer`](https://github.com/npgsql/npgsql/blob/main/src/Npgsql/NpgsqlDataSourceBuilder.cs), npgsql/npgsql (`DISCARD ALL` に関する XML remarks)
- [`NpgsqlHistoryRepository.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Migrations/Internal/NpgsqlHistoryRepository.cs), npgsql/efcore.pg
- [DISCARD](https://www.postgresql.org/docs/current/sql-discard.html), PostgreSQL ドキュメント
- [Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html), PostgreSQL ドキュメント (`statement_timeout`、`lock_timeout`、`transaction_timeout`、`search_path`)
- [ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html), PostgreSQL ドキュメント
- [Connection interception](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors#connection-interception), EF Core ドキュメント
- [PgBouncer configuration](https://www.pgbouncer.org/config.html) (`track_extra_parameters`、`ignore_startup_parameters`)
