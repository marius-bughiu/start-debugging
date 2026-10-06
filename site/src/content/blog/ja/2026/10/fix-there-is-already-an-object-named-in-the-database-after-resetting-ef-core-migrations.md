---
title: "解決: EF Core のマイグレーションをリセットした後の There is already an object named 'X' in the database"
description: "Migrations フォルダーを削除して新しい InitialCreate を生成すると、EF Core はテーブルが既に存在することを知りません。開発用データベースを削除するか、新しいマイグレーションを実行せずに __EFMigrationsHistory に記録します。"
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "dotnet"
lang: "ja"
translationOf: "2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations"
translatedBy: "claude"
translationDate: 2026-10-06
---

`Migrations` フォルダーを削除して `dotnet ef migrations add InitialCreate` を実行したところ、`dotnet ef database update` が `There is already an object named 'Blogs' in the database` で失敗するようになった、という状況です。EF Core は、アセンブリ内のマイグレーション ID と `__EFMigrationsHistory` の行を比較して、何を実行するかを決めます。新しい `InitialCreate` には新しいタイムスタンプが付いているため、EF Core はこれを保留中とみなし、既に存在するテーブルに対して `CREATE TABLE` を実行しようとします。データベースが使い捨てなら削除し (`dotnet ef database drop --force`)、もう一度更新します。データが入っているなら、古い履歴行を削除して新しいマイグレーション ID の行を 1 行挿入し、実行せずに適用済みとして EF Core に記録させます。以下の内容はすべて .NET 10 (SDK 10.0.302) 上の EF Core 10.0.12 と `dotnet-ef` 10.0.12 で計測したもので、EF Core 11.0.0-rc.1 でもロジックは変わりません。

## エラーの全体像

SQL Server ではエンジンエラー 2714 で、`dotnet ef database update` または起動時の `Database.Migrate()` から `SqlException` として表面化します。この記事のために使える SQL Server インスタンスがなかったため、以下のブロックは SQLite での実行結果の DDL とエンジンメッセージを SQL Server のものに置き換えたものです。

```text
Applying migration '20261006110224_InitialCreate'.
Failed executing DbCommand (12ms) [Parameters=[], CommandType='Text', CommandTimeout='30']
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
Microsoft.Data.SqlClient.SqlException (0x80131904): There is already an object named 'Blogs' in the database.
```

同じ根本原因でも、プロバイダーごとにメッセージが異なります。SQLite の行はこの記事の再現実行からコピーしたもので、PostgreSQL と MySQL の行は同じ `CREATE TABLE` 文に対するエンジンエラーです。

```text
SQLite:      SQLite Error 1: 'table "Blogs" already exists'.
PostgreSQL:  42P07: relation "Blogs" already exists
MySQL:       Table 'Blogs' already exists        (error 1050)
SQL Server:  There is already an object named 'Blogs' in the database.   (error 2714)
```

重要なのは最初の行の `Applying migration '..._InitialCreate'` です。スキーマが既にあるデータベースに対して EF Core が初期マイグレーションを適用しようとしているなら、このページで合っています。

## EF Core が既存のテーブルを作成しようとする理由

EF Core は、どのマイグレーションを実行するかを決めるためにスキーマを調べたりはしません。`SELECT MigrationId FROM __EFMigrationsHistory` というクエリを 1 回実行し、その結果をアセンブリにコンパイルされたマイグレーションと比較するだけです。ID がテーブルにないマイグレーションはすべて保留中となり、保留中のマイグレーションは `Up()` メソッドを丸ごと実行します。

マイグレーション ID はファイル名のプレフィックスで、UTC タイムスタンプに入力した名前を付けたものです (例: `20261006110224_InitialCreate`)。マイグレーションをリセットすると、新しい `InitialCreate` には新しいタイムスタンプが付きます。古い行 (`20261006110219_InitialCreate`、`20261006110221_AddPublished`) は履歴テーブルに残っていますが、EF Core はアセンブリ内のどのマイグレーションにも一致しない行を黙って無視します。警告も出しません。そのため EF Core から見ると、データベースは新しいマイグレーションを一度も見たことがなく、最初の `CreateTable` が既存のテーブルにぶつかります。

意図的なリセット以外でも、同じ食い違いが起きる状況がいくつかあります。

1. **データベースが `EnsureCreated()` で作成された**。`EnsureCreated()` はモデルから直接スキーマを構築し、`__EFMigrationsHistory` を作成しません。最初の `Migrate()` は空の履歴テーブルを作り、すべてのマイグレーションを保留中とみなし、最初のテーブルで失敗します。
2. **データベースが別の場所から来た**。別のアプリのバックアップを復元した、DB ファーストのスキーマ、DBA が実行したスクリプトなどです。テーブルはあるが履歴はない、という同じ構図です。
3. **履歴テーブルの場所が変わった**。デプロイ後に `MigrationsHistoryTable("__MyHistory", "app")` を追加または変更した場合や、SQL Server で既定のスキーマが `dbo` ではない別のログインで接続した場合です。EF Core は新しい場所を探し、何も見つからず、ゼロから始めます。
4. **2 つのマイグレーションが同じテーブルを作成する**。2 つのブランチがそれぞれ `AuditLog` を作成するマイグレーションを追加し、両方がマージされた場合です。1 つ目は成功し、2 つ目が 2714 をスローします。

## EF Core 10 での最小の再現手順

どのマシンでも再現できるように SQLite を使い、実際に実行したのが次の手順です。

```csharp
// .NET 10, EF Core 10.0.12, Microsoft.EntityFrameworkCore.Sqlite 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new AppDb();

public class Blog { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Post { public int Id { get; set; } public string Title { get; set; } = ""; public int BlogId { get; set; } }

public class AppDb : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();
    public DbSet<Post> Posts => Set<Post>();
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlite("Data Source=app.db");
}
```

```bash
# dotnet-ef 10.0.12
dotnet ef migrations add InitialCreate
# add a DateTime Published property to Post
dotnet ef migrations add AddPublished
dotnet ef database update            # applies both, history has 2 rows

rm -rf Migrations                    # the "reset"
dotnet ef migrations add InitialCreate
dotnet ef database update            # SQLite Error 1: 'table "Blogs" already exists'.
```

失敗の後、`dotnet ef migrations list` を実行すると EF Core が何を認識しているかがそのまま分かります。

```text
20261006110224_InitialCreate (Pending)
```

古い 2 行は履歴テーブルに残ったままです。また EF Core 10 は各マイグレーションをそれぞれ独自のトランザクションで囲むため、SQLite と SQL Server では失敗した `InitialCreate` はきれいにロールバックされ、中途半端に適用された状態は残りません。例外は MySQL で、DDL が暗黙的にコミットされます。

## 解決策 1: データが不要ならデータベースを削除する

ローカルの開発用データベースであれば、本当に必要だったリセットは「マイグレーションとデータベースを一緒にやり直す」ことです。[公式ドキュメント](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations) もまさにその方法、つまり `Migrations` フォルダーを削除してデータベースを削除する手順を説明しています。

```bash
# dotnet-ef 10.0.12
dotnet ef database drop --force
dotnet ef database update
```

ノート PC 上のデータベースや使い捨てのコンテナーならこれが正解です。共有しているものには使わないでください。データごとデータベースが削除されます。

## 解決策 2: 新しいベースラインを実行せずに記録する

データベースに大事なデータがあるなら、やるべきことは逆です。スキーマを残したまま、新しい `InitialCreate` が既に適用済みであることを EF Core に伝えます。ドキュメントではこれをマイグレーションのスカッシュ (squash) と呼んでいます。EF Core にはこのための組み込みコマンドがない (要望は [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174) として何年も未解決です) ため、履歴テーブルを手作業で編集することになります。

1. データベースをバックアップします。
2. リセットする前に、データベースが **最後の古いマイグレーション** まで適用されていることを確認します。遅れている場合は、ソース管理にある古いコードを使って不足している古いマイグレーションを先に適用します。ベースラインは、新しい `InitialCreate` が実際に存在するスキーマを表している場合にのみ機能します。
3. `Migrations` フォルダーを削除し、`dotnet ef migrations add InitialCreate` を実行します。
4. `dotnet ef migrations script 0 InitialCreate` を実行し、出力の末尾にある `INSERT INTO [__EFMigrationsHistory]` 文をコピーします。正確なマイグレーション ID と製品バージョンが含まれています。
5. 古い履歴行を、その 1 行で置き換えます。

SQL Server では、手順 5 は次のようになります。

```sql
-- SQL Server, EF Core 10.0.12 history table
BEGIN TRANSACTION;

DELETE FROM [__EFMigrationsHistory];

INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
VALUES (N'20261006110224_InitialCreate', N'10.0.12');

COMMIT;
```

その後、EF Core の認識と一致しているかを確認します。

```bash
# dotnet-ef 10.0.12
dotnet ef migrations list                      # 20261006110224_InitialCreate, no "(Pending)"
dotnet ef migrations has-pending-model-changes # "No changes have been made to the model since the last migration."
```

私の再現では、ベースラインの後に `Blog` へ `Url` プロパティを追加して `AddBlogUrl` を生成したところ、`dotnet ef database update` はそのマイグレーションだけを適用しました。これが目指す状態です。履歴にはベースラインの行が 1 行あり、新しいマイグレーションはその上に通常どおり積み上がります。

古い行の削除は厳密には必須ではありません。EF Core は認識できない行を無視するからです。それでも削除してください。後で誰かが古いコミットをチェックアウトしてこのデータベースに `database update` を実行すると、古い行のせいで EF Core は古いマイグレーションが適用済みだと思い込み、デバッグしにくい失敗になります。

## 複数の環境にベースラインを適用する

スカッシュはデータベースが 1 つなら簡単ですが、5 つになると間違えやすくなります。既存の環境にはすべて行の入れ替えが必要で、新しい環境ではすべて `InitialCreate` を最後まで実行する必要があります。両方を確実に満たす方法は、古いマイグレーションの連なりを見つけたときだけ履歴を書き換え、それ以外では何もしないガードを入れることです。

スカッシュしたコードをデプロイする前に、環境ごとに 1 回実行する SQL スクリプトにすると次のようになります。

```sql
-- SQL Server, run before deploying the squashed migrations
BEGIN TRANSACTION;

IF EXISTS (SELECT 1 FROM [__EFMigrationsHistory]
           WHERE [MigrationId] = N'20261006110221_AddPublished')
   AND NOT EXISTS (SELECT 1 FROM [__EFMigrationsHistory]
                   WHERE [MigrationId] = N'20261006110224_InitialCreate')
BEGIN
    DELETE FROM [__EFMigrationsHistory];
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20261006110224_InitialCreate', N'10.0.12');
END;

COMMIT;
```

ガードの条件は最初ではなく **最後** の古いマイグレーションです。`AddPublished` まで到達していないデータベースには、新しい `InitialCreate` が表すスキーマがないので、ベースラインを記録してはいけません。先に古いコードで最新の状態にする必要があります。

起動時にアプリからマイグレーションを適用している場合は、同じガードを `Migrate()` の前に置けます。3 つのデータベースで試しました。古い `AddPublished` の状態のもの、同じデータベースでの 2 回目の実行、そしてまったく新しい空のファイルです。3 つとも `InitialCreate, AddBlogUrl` が適用され、スキーマも正しい状態になりました。

```csharp
// .NET 10, EF Core 10.0.12
using Microsoft.EntityFrameworkCore;

using var db = new AppDb();
BaselineSquashedMigrations(db);
db.Database.Migrate();

static void BaselineSquashedMigrations(AppDb db)
{
    const string lastOldMigration = "20261006110221_AddPublished";
    const string newBaseline = "20261006110224_InitialCreate";

    // Returns every row in __EFMigrationsHistory, including IDs that no longer exist in the assembly.
    // Returns an empty list when the history table does not exist yet (fresh database).
    var applied = db.Database.GetAppliedMigrations().ToHashSet();
    if (!applied.Contains(lastOldMigration) || applied.Contains(newBaseline))
        return;

    using var tx = db.Database.BeginTransaction();
    db.Database.ExecuteSql($"DELETE FROM __EFMigrationsHistory");
    db.Database.ExecuteSql(
        $"INSERT INTO __EFMigrationsHistory (MigrationId, ProductVersion) VALUES ({newBaseline}, {"10.0.12"})");
    tx.Commit();
}
```

同じコードが SQL Server と SQLite の両方で動くように、テーブル名は引用符なしにしています。PostgreSQL では識別子の大文字と小文字が区別されるため、`"__EFMigrationsHistory"` のように引用符で囲む必要があります。これはすべてのレプリカではなく、単一のマイグレーションステップ (ジョブ、init コンテナー、または 1 つのインスタンス) で実行してください。EF Core 9 以降の `Migrate()` はマイグレーションロックを取得しますが、このヘルパーはロックの取得前に実行されます。バンドルでデプロイしている場合は、[migration bundles を使って本番環境で EF Core のマイグレーションを適用する方法](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) で説明しているように、バンドルの前に SQL 版を実行します。すべての環境にベースラインを記録し終えたら、ヘルパーは削除してください。

## 空の Up() を使う裏技と、私がそれを避ける理由

Stack Overflow でよく見かける回答は、新しい `InitialCreate` の `Up()` の本体をコメントアウトし、`database update` を実行して行を記録させ、その後本体を元に戻す、というものです。1 台のマシン上の 1 つのデータベースならこれでうまくいきます。しかし、壊れたマイグレーションがコミットされるのはまさにこの経路です。本体を戻し忘れると、新しい環境はすべて、完了済みと主張する履歴行付きの空のスキーマを受け取ることになります。SQL によるベースラインはマイグレーションファイルに触れずにデータベースに同じことを行うため、戻し忘れるものがありません。

## 落とし穴と紛らわしい類似エラー

**古いマイグレーション内のカスタムコードは失われます。** ビュー、ストアドプロシージャ、トリガー、シードデータのために書いた `migrationBuilder.Sql(...)` は、削除したファイルの中にありました。新しい `InitialCreate` にはモデルが知っているものしか含まれません。それらのブロックを新しいマイグレーションに手作業でコピーしないと、本番環境にあるオブジェクトが新しい環境には存在しないことになります。

**スキーマのドリフトはベースラインを嘘にします。** 誰かが本番環境で直接インデックスや列を追加していると、新しい `InitialCreate` にはそれが含まれず、ベースラインは実際と一致しないスキーマを記録します。ベースラインを記録する前に、`dotnet ef migrations script 0 InitialCreate` の出力を実際のスキーマ (SSMS のスキーマ比較、`pg_dump --schema-only`、`sqlite3 .schema`) と比較してください。

**`Migrate()` と並んでいる `EnsureCreated()`。** データベースが `EnsureCreated()` で作成されたためにここへ来たのなら、何よりも先にその呼び出しを削除してください。履歴テーブルを作成しないので、両者は共存できません。同じ助言は [`dotnet ef database update` 中の `CREATE DATABASE permission denied`](/ja/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/) の記事にもあり、これも 2 つを混在させたときの症状です。

**起動時に別のエラーが先に出る。** EF Core 9 以降、モデルにマイグレーションへ反映されていない変更があると、`Migrate()` は実行を拒否します。代わりに `The model for context has pending changes` が表示される場合は、[保留中のモデル変更に関する記事](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/) の手順で先にそれを解決してから戻ってきてください。

**タイムアウト後に中途半端に適用されたマイグレーション。** 初期マイグレーション以外で 2714 が出る場合は、途中で止まったマイグレーションが原因かもしれません。このケースは、履歴行の修復方法も含めて [EF Core のマイグレーション中の SqlException タイムアウトを解決する方法](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) で扱っています。

**`--idempotent` スクリプトでは救われません。** `dotnet ef migrations script --idempotent` は各マイグレーションを `IF NOT EXISTS (SELECT * FROM [__EFMigrationsHistory] WHERE [MigrationId] = N'...')` で囲みます。チェックするのはテーブルではなくマイグレーション ID なので、新しい `InitialCreate` の ID は依然として `CREATE TABLE` を実行し、同じように失敗します。

**ここに来る前に `dotnet ef migrations add` が失敗する。** リセット中にツールがコンテキストを構築できない場合は、デザイン時の構成の問題です。[「Unable to create an object of type DbContext」の解決方法](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) で扱っています。

## 関連記事

- [dotnet ef migrations bundle を使って本番環境で EF Core 11 のマイグレーションを適用する方法](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [解決: EF Core 11 の The model for context has pending changes](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)
- [解決: EF Core のマイグレーション中の SqlException: Timeout expired](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [解決: CREATE DATABASE permission denied in database 'master'](/ja/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [解決: dotnet ef migrations add の "Unable to create an object of type DbContext"](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)

## 参考資料

- [Managing Migrations: Resetting all migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing#resetting-all-migrations)、Microsoft Learn。
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table)、Microsoft Learn。
- [Applying Migrations](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying)、Microsoft Learn。
- [dotnet/efcore#2174](https://github.com/dotnet/efcore/issues/2174)、マイグレーションのスカッシュを求める未解決の機能要望です。
- [release/10.0 ブランチの `HistoryRepository.cs`](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Relational/Migrations/HistoryRepository.cs)、履歴テーブルの名前とスキーマの既定値が確認できます。
