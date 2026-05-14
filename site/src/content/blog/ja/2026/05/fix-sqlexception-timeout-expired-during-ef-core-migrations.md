---
title: "修正: EF Core マイグレーション中の SqlException: Timeout expired"
description: "マイグレーションはランタイムの CommandTimeout ではなくデザインタイムの DbContext を使用します。UseSqlServer(o => o.CommandTimeout(...))、接続文字列の Command Timeout、または Migrate() の前の Database.SetCommandTimeout でタイムアウトを設定してください。"
pubDate: 2026-05-14
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "migrations"
lang: "ja"
translationOf: "2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations"
translatedBy: "claude"
translationDate: 2026-05-14
---

修正方法: `dotnet ef database update` はデザインタイムの `DbContext` を介して接続し、各マイグレーションステップを 1 つのコマンドとして実行し、SQL Server プロバイダーのデフォルトの `CommandTimeout` である 30 秒を継承します。長いマイグレーション (大きな `AlterColumn`、インデックスの再構築、バックフィル) は 30 秒を超え、SqlClient は `Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired` をスローします。タイムアウトを次の優先順位で 3 か所に設定してください: `UseSqlServer` のプロバイダーレベルの `o.CommandTimeout(600)`、デザインタイムに使用される接続文字列の `Command Timeout=600`、または `Migrate()` を呼び出す前にアプリケーションから `context.Database.SetCommandTimeout(TimeSpan.FromMinutes(10))` でマイグレーションを適用する方法です。EF Core 11 の `dotnet ef database update` CLI 自体には `--command-timeout` フラグがありません。これがこのエラーを追跡する際に最も時間を浪費する単一の事実です。

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired.
The timeout period elapsed prior to completion of the operation or the server is not responding.
 ---> System.ComponentModel.Win32Exception (258): The wait operation timed out.
   at Microsoft.Data.SqlClient.SqlCommand.<>c.<ExecuteDbDataReaderAsync>b__214_0(Task`1 result)
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReader(RelationalCommandParameterObject parameterObject)
   at Microsoft.EntityFrameworkCore.Migrations.MigrationCommandExecutor.ExecuteNonQuery(IEnumerable`1 migrationCommands, IRelationalConnection connection, MigrationExecutionState executionState, Boolean commitTransaction, Nullable`1 isolationLevel)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.Design.Internal.MigrationsOperations.UpdateDatabase(String targetMigration, String connectionString, String contextType)
ClientConnectionId:7c2f9aa3-...
Error Number:-2,State:0,Class:11
```

このガイドは .NET 11 preview 4、`Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.4、`Microsoft.Data.SqlClient` 6.0.x、`dotnet-ef` 11.0.0-preview.4 を対象に書かれています。エラーメッセージは SqlClient のバージョン間で安定しており、プロバイダーが EF Core 3.0 で切り替わった際に名前空間が `System.Data.SqlClient` から `Microsoft.Data.SqlClient` に変わっただけです。`Error Number:-2` は標準的なシグナルです: `SqlException.Number` の値 `-2` はクライアント側のコマンドタイムアウトであり、サーバー側の障害ではありません。`Error Number:1222` や他の正のコードが表示される場合、本記事の残りの部分では解決できない別の問題 (ロック待機、ログイン失敗) に直面しています。

## ランタイムのクエリではタイムアウトしないのにマイグレーションがタイムアウトする理由

マイグレーション中には 2 つの `DbContext` インスタンスが関与します。ASP.NET Core アプリケーションがランタイムで使用する、`AddDbContext` で設定されたものと、`dotnet ef` がデザインタイムに構築するものです。これらは同じインスタンスではなく、必ずしも設定を共有しません。EF Core のマイグレーションツールは [EF Core CLI リファレンス](https://learn.microsoft.com/ja-jp/ef/core/cli/dotnet) に文書化されている 3 つのメカニズムのいずれかを通じて `DbContext` を発見します: `Program` クラスのパブリック静的な `CreateHostBuilder(string[])` を呼び出すか、`IDesignTimeDbContextFactory<TContext>` を探すか、フォールバックとしてアプリケーションのホストを実行して `AddDbContext` がコンテキストを登録できるようにします。いずれのパスでも、新しい `DbContext` を構築してマイグレーションに使用します。

SQL Server プロバイダーのデフォルトの `CommandTimeout` は、基礎となる `SqlCommand` のデフォルトである 30 秒です。リクエストパイプラインのどこかで呼び出す `SetCommandTimeout` はランタイムのインスタンス上で実行され、デザインタイムのインスタンスでは実行されません。テーブルに 800 万行あるために 90 秒かかる `AlterColumn` は、`CommandTimeout` が 30 の `DbCommand` 上で 1 つのコマンドとしてディスパッチされ、SqlClient が 30 秒後にキャンセルします。

これを必要以上に悪化させる 2 つの要因があります。第一に、マイグレーションは成功時にのみ `__EFMigrationsHistory` に行を記録します。コマンドが途中でタイムアウトすると、スキーマが部分的に適用され、マイグレーション行が欠落し、次の `dotnet ef database update` が同じ長い操作をゼロから再試行することになります。第二に、EF Core 9 以降は、オプトアウトしない限り、デフォルトで各マイグレーションをトランザクションでラップします。コマンドタイムアウトが発生すると、SQL Server はマイグレーション全体をロールバックします。これは安全な結果ですが、次の試行でさらに 30 秒の実時間を費やすことになります。

CLI 側の話は単純です。`dotnet ef database update` は `--connection`、`--context`、`--project`、`--startup-project`、および一般的なオプションを受け付けます。`--command-timeout` はありません。EF Core チームは [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) として何年もこれを追跡しています。標準的な回答は変わらず "`DbContext` の設定で指定してください" です。

## 最小再現

どんな `AlterColumn` でも 30 秒以上かかるだけの行数を持つテーブルがあれば十分です。

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class Order
{
    public int Id { get; set; }
    public string Reference { get; set; } = "";
    public decimal Total { get; set; }
}

public class OrdersContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer(
            "Server=localhost;Database=Orders;Integrated Security=true;Encrypt=false");
}
```

SQL Server がメタデータのみの変更ではなく各行を書き換える必要があるように、`Reference` を `nvarchar(50)` から `nvarchar(450)` に拡張するマイグレーションを追加します:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public partial class WidenReference : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AlterColumn<string>(
            name: "Reference",
            table: "Orders",
            type: "nvarchar(450)",
            maxLength: 450,
            nullable: false,
            oldClrType: typeof(string),
            oldType: "nvarchar(50)",
            oldMaxLength: 50);
    }
}
```

数百万行を持つ `Orders` テーブルに対して `dotnet ef database update` を実行します。デフォルトの 30 秒タイムアウトでは、コマンドはこの記事の冒頭にあるスタックトレースをそのままスローします。

## 修正の詳細

プロジェクトでマイグレーションがどのように適用されるかに合うオプションを選択してください。以下の順位は容易さではなく保守性に基づいています。

### 1. DbContext 設定のプロバイダーで CommandTimeout を設定する

これは標準的な修正です。`DbContext` にタイムアウトを固定し、デザインタイムとランタイムの両方のコードパスが同じ値を取得するようにします。

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class OrdersContext : DbContext
{
    public OrdersContext(DbContextOptions<OrdersContext> options) : base(options) { }
}

// Program.cs
builder.Services.AddDbContext<OrdersContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("Orders"),
        sql => sql.CommandTimeout(600))); // 10 minutes
```

`UseSqlServer` の 2 番目の引数は `Action<SqlServerDbContextOptionsBuilder>` です。`CommandTimeout(int seconds)` は [SqlServerDbContextOptionsBuilder](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout) に存在します。これは EF Core がこのコンテキスト上で構築するすべての `DbCommand`、マイグレーションランナーがディスパッチするものも含めて、`CommandTimeout` を設定します。

ツール用に `IDesignTimeDbContextFactory<OrdersContext>` がある場合は、そこにも設定してください。両方が存在する場合、`dotnet ef` は `CreateHostBuilder` よりも `IDesignTimeDbContextFactory<T>` を優先するため、このオーバーライドはデザインタイム実行で有効になります:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class OrdersContextFactory : IDesignTimeDbContextFactory<OrdersContext>
{
    public OrdersContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("ORDERS_CONNECTION")
            ?? "Server=localhost;Database=Orders;Integrated Security=true;Encrypt=false";

        var options = new DbContextOptionsBuilder<OrdersContext>()
            .UseSqlServer(connectionString, sql => sql.CommandTimeout(600))
            .Options;

        return new OrdersContext(options);
    }
}
```

### 2. 接続文字列に `Command Timeout` を入れる

`DbContext` を編集できない場合 (他人のパッケージをマイグレーションしている、またはデザインタイムの検出が CI から渡される接続文字列を使用している場合)、接続文字列にタイムアウトを設定すると、SqlClient がすべてのコマンドに適用します:

```text
Server=tcp:prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true;Command Timeout=600
```

`Command Timeout` キーワードは `Microsoft.Data.SqlClient` でサポートされており、`SqlCommand.CommandTimeout` に伝播します。マイグレーションバンドルを出荷し `--connection` を渡す CI パイプラインは、これを無料で取得できます:

```bash
./efbundle --connection "Server=...;Command Timeout=600"
```

バンドル実行可能ファイルには独自の `--timeout` フラグはありません ([`dotnet ef migrations bundle` リファレンス](https://learn.microsoft.com/ja-jp/ef/core/cli/dotnet#dotnet-ef-migrations-bundle) を参照)。接続文字列がバンドルが公開する唯一のつまみです。

### 3. コードから `SetCommandTimeout` でマイグレーションを適用する

アプリケーションから `context.Database.Migrate()` を呼び出す場合 (セルフホスト型サービスや統合テストでよくあるパターン)、呼び出しの直前にライブの `Database` ファサードにタイムアウトを設定します。`SetCommandTimeout` はコンテキストの接続上のランタイムコマンドタイムアウトを変更します:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
using var scope = app.Services.CreateScope();
var db = scope.ServiceProvider.GetRequiredService<OrdersContext>();

db.Database.SetCommandTimeout(TimeSpan.FromMinutes(10));
await db.Database.MigrateAsync();
```

`Database.SetCommandTimeout` は [RelationalDatabaseFacadeExtensions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout) に文書化されています。`int` (秒) または `TimeSpan` を受け付けます。値はコンテキストの存続期間中保持されるため、1 回の設定で `MigrateAsync` 呼び出し全体をカバーするのに十分です。これは [Testcontainers で実際の SQL Server を起動する統合テスト](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) の正しいパターンです。テストオーケストレーターがマイグレーションの適用を所有するためです。

## 検索トラフィックが混同するつまずきとバリエーション

### `Error Number != -2` の "Timeout expired"

`SqlException.Number` が `-2` でない場合、問題はクライアント側のコマンドタイムアウトではありません。同じ文言で出荷される最も一般的な代替パターンは次の 2 つです:

- `Error Number:1222` はロック待機タイムアウトです。別のセッションが変更しようとしているオブジェクトにロックを保持しており、SQL Server の `LOCK_TIMEOUT` 設定が発火しました。`CommandTimeout` を上げても同じ壁に当たります。修正方法はブロッカー (`sp_who2`、`sys.dm_exec_requests`) を見つけることです。
- `Error Number:-2` で `State:0,Class:11` と `ClientConnectionId` を伴うものが、この記事が修正する標準的な SqlClient のクライアント側コマンドタイムアウトです。

### Connection Timeout vs Command Timeout

接続文字列の `Connection Timeout=30` (または `Connect Timeout`) は、SqlClient が TCP 接続を開くのを待つ時間です。単一のコマンドが実行できる時間には影響しません。`Command Timeout` ではなく `Connection Timeout` のみを変更した場合、間違ったつまみを回しています。EF Core 11 より前のドキュメントは散文で 2 つを互換的に使用することがありますが、実際のプロパティ名は曖昧ではありません。

### 複数の `AlterColumn` 呼び出しをラップするマイグレーション

EF Core は 1 つの `Up` メソッドの操作をデフォルトで 1 つのトランザクションにグループ化します。30 秒タイマーはマイグレーションごとではなく `DbCommand` ごとですが、ホットなテーブル上の単一の `AlterColumn` は容易に長いコマンドになります。1 つのマイグレーションに長い操作が複数ある場合、`CommandTimeout` を一度上げるだけで十分です。マイグレーションを分割する必要はありません。分割したい場合は、[EF Core 11 のシングルステップマイグレーションコマンドである `dotnet ef migrations update --add`](/ja/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) を使うと、作業をよりきれいにステージングできます。

### Azure SQL が長いマイグレーションをスロットルする

タイムアウトを 30 分に上げてもマイグレーションが同じメッセージで 60 秒前後で失敗する場合、クライアントタイムアウトではなく Azure SQL ゲートウェイに当たっています。ゲートウェイはアイドル TCP セッションを保持しますが、フェイルオーバー、スロットリング、またはサービス更新時にセッションをドロップする可能性があります。2 つの緩和策があります: 操作を `WITH (ONLINE = ON)` でオンラインインデックス再構築に変換して、長いロックをより短いものに分割し、[`EnableRetryOnFailure`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.enableretryonfailure) を有効にして、アプリケーションがすでに使用しているのと同じ一時的障害ポリシーの下でマイグレーションランナーが操作をリトライするようにします:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
options.UseSqlServer(connectionString, sql =>
{
    sql.CommandTimeout(1800);              // 30 minutes
    sql.EnableRetryOnFailure(
        maxRetryCount: 3,
        maxRetryDelay: TimeSpan.FromSeconds(30),
        errorNumbersToAdd: null);
});
```

### "私のマシンでは動くのに CI では失敗する"

2 つの具体的な原因。まず、ローカルの SQL Server が小さく、テーブルに 200 行しかないため、`AlterColumn` が 200 ms で完了します。CI は実際の行数を持つステージングデータベースに対して実行され、同じコマンドに数分かかります。次に、ローカルアプリケーションは寛大な `CommandTimeout` を持つランタイムの `DbContext` 設定を使用しますが、CI は `dotnet ef database update` を実行し、オーバーライドのない別のデザインタイム `DbContext` を発見します。[デザインタイム `DbContext` の検出ルール](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) は、CI がアプリケーションがランタイムで使用するものとは異なるコンテキストに行き着く理由を説明しています。

### 非同期と同期のタイムアウト動作

`SqlException.Number == -2` は `ExecuteNonQuery` と `ExecuteNonQueryAsync` で同じように発火します。`MigrateAsync` に切り替えても救われません、呼び出し側のスレッドを解放するだけです。`SetCommandTimeout` がここで重要な唯一のつまみです。

### マイグレーション履歴テーブルが中途半端に書かれている

コマンドが途中で接続を切断し、EF Core がマイグレーションが適用されたと考えるために次の実行で行き詰まっている場合、`__EFMigrationsHistory` を確認してください。行が欠落しているが列の変更が部分的に適用されている場合、単一の `ALTER` で部分的な DDL を手動でロールバックしてマイグレーションを再実行するか、`__EFMigrationsHistory` に行を挿入して作業を完了するフォローアップマイグレーションを書くことができます。そのテーブルから無関係な行を削除しないでください。EF Core はそれらを使用してどの `Down()` 操作を実行するかを判断します。

## 関連記事

- [修正: dotnet ef migrations add が "Unable to create an object of type DbContext" で失敗する](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) 上流のデザインタイム検出問題について。
- [dotnet ef migrations update --add による EF Core 11 シングルステップマイグレーション](/ja/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) 長いマイグレーションがタイムアウトを上げるよりも分割しやすい場合に。
- [Testcontainers で実際の SQL Server に対する統合テストを書く](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) `Database.SetCommandTimeout` プラス `MigrateAsync` が標準的なテストセットアップパターンであるため。
- [修正: A second operation was started on this context instance](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/) これと一緒によく検索される、別のタイミング関連の例外について。
- [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) データベースに大きな負荷をかけ、小さなマイグレーションさえタイムアウトし始めるランタイムリグレッションについて。

## ソース

- [EF Core CLI リファレンス](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) - `dotnet ef` オプションの標準リスト。
- [SqlServerDbContextOptionsBuilder.CommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout) API ドキュメント。
- [RelationalDatabaseFacadeExtensions.SetCommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout) API ドキュメント。
- [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) "Allow customizing migration commands timeout" は CLI フラグが存在しない理由を追跡しています。
- [dotnet/efcore#22887](https://github.com/dotnet/efcore/issues/22887) マイグレーションバンドルのケースと接続文字列の回避策をカバーしています。
