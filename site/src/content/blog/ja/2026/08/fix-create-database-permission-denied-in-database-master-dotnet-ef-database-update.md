---
title: "解決: dotnet ef database update 実行時の CREATE DATABASE permission denied in database 'master'"
description: "EF Core の Migrate() は常にデータベースの存在を確認し、なければハードコードされた master 接続で作成します。CREATE ANY DATABASE を付与するか、既存データベースへのログインのアクセスを直すか、冪等な SQL スクリプトを配布してください。"
pubDate: 2026-08-30
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "migrations"
  - "sql-server"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update"
translatedBy: "claude"
translationDate: 2026-08-30
---

`dotnet ef database update` があなたのデータベースを作ろうとしているのは、あなたがそう頼んだからではありません。`Migrate()` の呼び出しは必ず `if (!_databaseCreator.Exists()) _databaseCreator.Create()` から始まり、これを止めるスイッチは存在しません。つまり、ログインが本当にデータベースを作成できないか (`master` で `CREATE ANY DATABASE` を付与するか、`##MS_DatabaseManager##` に追加してください)、あるいはデータベースはすでに存在するのにログインがそれを開けず、EF Core がそれを「存在しない」と誤読しているかのどちらかです。まず後者を確認してください。`sa` として `SELECT DB_ID('YourDb')` を実行し、次にマイグレーション用ログインとして `SELECT DB_ID('YourDb')` を実行します。前者が数値を返し後者が `NULL` を返すなら、必要なのはサーバー権限ではなくデータベースユーザーです。本番環境では特権ログインで `Migrate()` を実行すること自体をやめ、`dotnet ef migrations script --idempotent` の出力を DBA に渡してください。その出力に `CREATE DATABASE` は一切含まれません。

以下の内容はすべて `Microsoft.EntityFrameworkCore.SqlServer` 10.0.11 と `dotnet-ef` CLI 10.0.11 を .NET SDK 10.0.302 上で検証しています。ここで引用する `Migrator.Migrate` と `SqlServerDatabaseCreator` のコードパスは EF Core 8、9、10、11 で変わっていないため、動作も対処法もこの 4 バージョンすべてに当てはまります。このマシンでの実行結果ではなく SQL Server のドキュメントを根拠にしている箇所は、その旨を明記します。

## エラーの全文

```text
Build started...
Build succeeded.
Microsoft.Data.SqlClient.SqlException (0x80131904): CREATE DATABASE permission denied in database 'master'.
   at Microsoft.Data.SqlClient.SqlConnection.OnError(SqlException exception, Boolean breakConnection, Action`1 wrapCloseInAction)
   ...
   at Microsoft.EntityFrameworkCore.Migrations.Internal.MigrationCommandExecutor.ExecuteNonQuery(...)
   at Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerDatabaseCreator.Create()
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
ClientConnectionId:...
Error Number:262,State:1,Class:14
CREATE DATABASE permission denied in database 'master'.
```

このトレースは以下に示す EF Core の呼び出し連鎖から組み立てたもので、SQL Server インスタンスのないこのマシンで採取したものではありません。フレーム名とエラー番号は公開されているソースコードと SQL Server の文書化されたエラーに基づいています。重要なフレームは 2 つです。`SqlServerDatabaseCreator.Create()` は、EF がデータベースは存在しないと判断したことを示します。`Error Number:262` は接続エラーではなく SQL Server の権限エラーで、ログインの認証は通り、ステートメントの実行まで到達したことを意味します。

## なぜ dotnet ef database update が master に触れるのか

`Program.cs` にも接続文字列にも `master` は出てきません。入れているのは EF です。該当のコードは `Migrate()` が最初に行う処理で、[`Migrator.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) にあります。

```csharp
// Microsoft.EntityFrameworkCore.Relational 10.0.11, Migrator.Migrate
if (!_databaseCreator.Exists())
{
    _databaseCreator.Create();
}
```

これをスキップするオプションも `DbContextOptionsBuilder` のフラグも環境変数もありません。`dotnet ef database update` はまさにこのメソッドを通りますし、アプリ起動時の `context.Database.Migrate()` も、`dotnet ef migrations bundle` が生成するマイグレーションバンドルも同じです。

次に `Create()` は独自の接続を組み立てます。[`SqlServerConnection.cs`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs) から引用します。

```csharp
// Microsoft.EntityFrameworkCore.SqlServer 10.0.11
public virtual ISqlServerConnection CreateMasterConnection()
{
    var connectionStringBuilder = new SqlConnectionStringBuilder(GetValidatedConnectionString())
        { InitialCatalog = "master" };
    connectionStringBuilder.Remove("AttachDBFilename");
    ...
}
```

`InitialCatalog = "master"` はハードコードされています。メッセージ中の `in database 'master'` はここから来ています。この接続の上で EF は、`SqlServerCreateDatabaseOperation` に対して自身のジェネレーターが出力する T-SQL を実行します。

```sql
-- what EF Core 10.0.11 sends on the master connection
CREATE DATABASE [Shop];
GO
IF SERVERPROPERTY('EngineEdition') <> 5
BEGIN
    ALTER DATABASE [Shop] SET READ_COMMITTED_SNAPSHOT ON;
END;
```

*ログイン* エラーではなく *権限* エラーになるのは、SQL Server のどのログインでも `master` は開けるからです。[プリンシパルのドキュメント](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine) によれば、`guest` ユーザーの `CONNECT` 権限を取り消せるのは「`master` と `tempdb` 以外のデータベース」だけです。そのため EF は接続には成功し、ステートメントの段階でつまずきます。

## 存在チェックは思っているより雑

ここが多くの人を誤った方向へ導く部分です。`SqlServerDatabaseCreator.Exists()` は `sys.databases` を参照しません。対象データベースへ接続して `SELECT 1` を実行し、3 つの `SqlException` 番号をデータベースが存在しない証拠として扱います。

```csharp
// Microsoft.EntityFrameworkCore.SqlServer 10.0.11
private static bool IsDoesNotExist(SqlException exception)
    => exception.Number is 4060 or 1832 or 5120;
```

エラー 4060 は `Cannot open database "Shop" requested by the login. The login failed.` です。SQL Server はデータベースが存在しないときにもこれを出しますが、**存在するデータベースにログインのユーザーがマッピングされていないとき**、あるいはデータベースがオフライン、復元中、`SINGLE_USER` モードのときにも同じものを出します。EF はこれらを区別できないため、データベースがないと結論して作成しに行きます。その結果 `master` に関するエラー 262 が出ますが、実際の原因は `Shop` に `CREATE USER` がないことです。

権限に手を付ける前に、この 2 つを切り分けてください。管理者として接続し、次を実行します。

```sql
-- as sa or a sysadmin
SELECT DB_ID('Shop') AS db_id, state_desc, user_access_desc
FROM sys.databases WHERE name = 'Shop';
```

次に、マイグレーション用接続文字列とまったく同じ資格情報で接続して、次を実行します。

```sql
-- as the migration login
SELECT DB_ID('Shop') AS visible_to_me;
```

1 つ目が行を返し 2 つ目が `NULL` なら、データベースは存在していてログインから見えていません。これは次のセクションです。1 つ目が何も返さないなら本当に存在しないので、その次のセクションになります。

## 対処 1: データベースは存在するがログインが開けない

CI や復元直後の環境でよくある形です。誰かが `.bak` を復元したかスクリプトでデータベースを作り、サーバーレベルのログインはあるのに対応するデータベースユーザーがない、あるいは復元によって SID が孤立している状態です。

```sql
-- SQL Server 2019+ / Azure SQL MI; run in the target database
USE [Shop];
GO
CREATE USER [app] FOR LOGIN [app];
ALTER ROLE db_ddladmin ADD MEMBER [app];   -- schema changes
ALTER ROLE db_datareader ADD MEMBER [app];
ALTER ROLE db_datawriter ADD MEMBER [app];
GO
```

ユーザーはすでに存在するが復元で孤立している場合は、作り直さずログインに再度ひも付けます。

```sql
USE [Shop];
GO
ALTER USER [app] WITH LOGIN = [app];
GO
```

マイグレーションに必要なのは `db_ddladmin` です。`CREATE TABLE`、`ALTER TABLE`、`CREATE INDEX`、それに EF が初回実行時に作成する `__EFMigrationsHistory` テーブルがこれで賄えます。`db_owner` でも動きますし多くの人はそちらに手を伸ばしますが、マイグレーションが必要とする以上の権限です。

データベースユーザーでは直らない理由で 4060 になるケースが 2 つあります。`state_desc` が `ONLINE` でなければデータベースをオンラインにしてください。`user_access_desc` が `SINGLE_USER` なら `ALTER DATABASE [Shop] SET MULTI_USER;` を実行します。どちらの場合も、放っておくと EF はすぐそこにあるデータベースを作ろうとし続けます。

## 対処 2: データベースが本当に存在せず、EF に作らせたい

開発マシン、使い捨ての CI コンテナ、あるいはマイグレーション用ログインが自分のデータベースを所有してよい環境では、これが正しい対処です。

SQL Server 2022 (16.x) 以降と Azure SQL Database で最小権限なのは、固定サーバーロール `##MS_DatabaseManager##` です。[サーバーレベルロールのドキュメント](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles) によれば、そのメンバーは "create databases, and delete databases they own" ことができ、サーバーレベル権限の `CREATE ANY DATABASE` と `ALTER ANY DATABASE` を持ちます。

```sql
-- SQL Server 2022 (16.x)+ and Azure SQL Database
ALTER SERVER ROLE [##MS_DatabaseManager##] ADD MEMBER [app];
```

SQL Server 2019 (15.x) 以前にこのロールはないので、サーバースコープの権限を直接付与します。`dbcreator` よりこちらを選ぶべきです。`dbcreator` のメンバーは "create, alter, drop, and restore **any** database" ことができ、あなたのマイグレーションが触る必要のないデータベースまで含まれるからです。

```sql
-- SQL Server 2016 (13.x) and later, including 2019 (15.x) where no role exists
USE master;
GO
GRANT CREATE ANY DATABASE TO [app];
GO
```

`CREATE DATABASE` と `CREATE ANY DATABASE` は互換ではなく、この取り違えが 2 つ目の典型的な失敗です。`CREATE DATABASE` は `master` における *データベーススコープ* の権限なので、データベースユーザーにしか付与できません。つまりログインには先に `master` 上のユーザーが必要です。

```sql
-- the CREATE DATABASE variant needs a user in master
USE master;
GO
CREATE USER [app] FOR LOGIN [app];
GRANT CREATE DATABASE TO [app];
GO
```

`CREATE ANY DATABASE` はサーバースコープでログイン自体に付与するため、`master` 上のユーザーは不要です。[CREATE DATABASE のドキュメント](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) は `CREATE DATABASE`、`CREATE ANY DATABASE`、`ALTER ANY DATABASE` のいずれかで十分だと記しています。

Azure SQL Database での古い方法は `master` のデータベースロール `dbmanager` で、ドキュメントは今も `CREATE DATABASE` の有効なプリンシパルとして挙げています。

```sql
-- Azure SQL Database, connected to master
CREATE USER [app] FROM LOGIN [app];
ALTER ROLE dbmanager ADD MEMBER [app];
GO
```

Azure ではこれに注意してください。EF は `EDITION` も `SERVICE_OBJECTIVE` もない素の `CREATE DATABASE [Shop];` を送るため、サーバーが既定のティアを選び、その課金が始まります。これがまさに [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251) 「EF Core automatically creates expensive database when executing migrations」で挙げられた不満で、チームは not planned として閉じました。データベース名のタイプミスが新しい課金対象データベースをプロビジョニングしても構わないと思えない限り、Azure SQL サーバーを指すデプロイ用ログインにデータベース作成権限を与えないでください。

## 対処 3: 作成ステップをデプロイから完全に外す

ログインを意図的に非特権にしているなら、いくら権限を付与しても正解にはなりません。その環境では `Migrate()` の実行をやめ、代わりに SQL を適用します。生成されるスクリプトに `CREATE DATABASE` が入ることはありません。スクリプトジェネレーターはマイグレーションだけを対象とし、`IRelationalDatabaseCreator` を一切呼ばないからです。

```bash
dotnet ef migrations script --idempotent --output migrate.sql
```

EF Core 10.0.11 では、初期マイグレーション 1 本に対してちょうど次が出力されます。

```sql
IF OBJECT_ID(N'[__EFMigrationsHistory]') IS NULL
BEGIN
    CREATE TABLE [__EFMigrationsHistory] (
        [MigrationId] nvarchar(150) NOT NULL,
        [ProductVersion] nvarchar(32) NOT NULL,
        CONSTRAINT [PK___EFMigrationsHistory] PRIMARY KEY ([MigrationId])
    );
END;
GO

BEGIN TRANSACTION;
IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260830061302_InitialCreate'
)
BEGIN
    CREATE TABLE [Customers] (
        [Id] int NOT NULL IDENTITY,
        [Name] nvarchar(max) NOT NULL,
        CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
    );
END;
...
COMMIT;
GO
```

`master` への参照は 1 つもありません。`--idempotent` フラグにより、どのマイグレーション状態のデータベースに対しても安全に実行できます。DBA が手作業で適用する場面ではこれが欲しい性質です。EF チームも [マイグレーションの適用に関するドキュメント](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) で、`dotnet ef database update` は "applies SQL commands directly by the tool, without giving the developer a chance to inspect or modify them" と書いていますし、起動時に `Migrate()` を呼ぶことは "requires elevated access to modify the database schema" とも明記しています。これは本番環境の最小権限とぶつかります。

結果として運用はこうなります。データベースは手作業か Terraform または Bicep で一度だけ作成し、その中でアプリのログインに `db_ddladmin` を付与し、リリースパイプラインで `migrate.sql` を適用する。アプリのログインは `master` に一切の権限を必要としません。

## マイグレーションバンドルでは回避できない

`dotnet ef migrations bundle` は SDK に依存しない単体の実行ファイルなので問題を回避できる、というのはよくある誤解です。回避できません。バンドルは `Migrate()` を呼ぶので、同じ `Exists()`/`Create()` の組を実行し、非特権ログインの下では同じエラー 262 で失敗します。バンドルが解決するのは「デプロイエージェントに SDK がない」問題であって、権限の問題ではありません。対象環境が `CREATE DATABASE` を禁じているなら、バンドルにも CLI と同じ手当てが必要です。先にデータベースを存在させ、ログインがそれを開けるようにしてください。そのパイプラインの手順は [dotnet ef migrations bundle で EF Core 11 のマイグレーションを本番適用する方法](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) にあります。

## 似ているが別のエラー

**`CREATE TABLE permission denied in database 'master'.`** エラー番号は同じでステートメントが違います。これは接続文字列に `Database=` も `Initial Catalog=` もないため、SQL Server がログインの既定データベースに接続した状態で、`sa` の場合それは `master` です。EF は何も作成しておらず、あなたのマイグレーションを `master` に対して実行しています。接続文字列にデータベースを追加してください。

**マイグレーションではなく `EnsureCreated()`。** `Database.EnsureCreated()` はまったく同じ理由でまったく同じエラーを出し、しかもより厄介です。`__EFMigrationsHistory` テーブルなしでスキーマを作るため、そのデータベースにはあとからマイグレーションを適用できなくなります。マイグレーションフォルダーの横の `Program.cs` に `EnsureCreated()` の呼び出しを見つけたら、削除してください。

**LocalDB。** `(localdb)\MSSQLLocalDB` はインスタンスを所有する自分の Windows アカウントで動くため、そこで 262 が出るなら、ほぼ確実に共有インスタンスか、LocalDB だと思い込んでいた実際の SQL Server に接続しています。ツールが実際に読み込んだ接続文字列のサーバー名を `dotnet ef database update -v` で確認してください。

**権限エラーに見えるタイムアウト。** メッセージがエラー 262 ではなく `Execution Timeout Expired` なら、ログインには問題がなくマイグレーション自体が遅いだけです。これは別の問題で、[SqlException: Timeout expired が EF Core のマイグレーション中に出る](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) で扱っています。

**そもそも接続していない。** `dotnet ef` が SQL Server に到達すらしていない場合は代わりに `Unable to create an object of type 'DbContext'` が出ます。これは権限ではなく設計時の探索の失敗です。[dotnet ef migrations add が "Unable to create an object of type DbContext" で失敗する](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) で扱っています。

より大きな教訓は、EF Core のマイグレーションパイプラインが、自分のデータベースを所有しているのが普通である開発の内側のループ向けに設計されていて、自動作成のステップが最後まで任意化されなかったということです。マイグレーション用アプリにデータベース作成権限を不要にするため、まさにそれを求めた [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839) は not planned として閉じられました。`Migrate()` は開発時の利便性、SQL スクリプトはデプロイの手段と割り切れば、エラー 262 は本番で踏みようのないものになります。

## 関連記事

- [dotnet ef migrations bundle で EF Core 11 のマイグレーションを本番適用する方法](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [解決: SqlException: Timeout expired が EF Core のマイグレーション中に出る](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [解決: dotnet ef migrations add が "Unable to create an object of type DbContext" で失敗する](/ja/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/)
- [解決: dotnet tool install --global dotnet-ef がエラーになる](/ja/2026/08/fix-dotnet-tool-install-global-dotnet-ef-throws-an-error/)
- [EF Core 11 のマイグレーションでデータを失わずにテーブル名を変更する方法](/ja/2026/08/how-to-rename-a-table-in-an-ef-core-11-migration-without-losing-data/)

## 参考資料

- [Migrator.cs, `Migrate(string? targetMigration)`](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) - 無条件の `Exists()`/`Create()` の組
- [SqlServerDatabaseCreator.cs](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) - `IsDoesNotExist` と `SELECT 1` による存在確認
- [SqlServerConnection.cs, `CreateMasterConnection`](https://github.com/dotnet/efcore/blob/main/src/EFCore.SqlServer/Storage/Internal/SqlServerConnection.cs) - ハードコードされた `InitialCatalog = "master"`
- [CREATE DATABASE (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-database-transact-sql) - SQL Server と Azure SQL Database で必要な権限
- [Server-level roles](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/server-level-roles) - `##MS_DatabaseManager##` と `dbcreator`
- [Principals (Database Engine)](https://learn.microsoft.com/en-us/sql/relational-databases/security/authentication-access/principals-database-engine) - `master` で `guest` を取り消せない理由
- [Applying migrations - EF Core](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/applying) - スクリプト、バンドル、最小権限に関する注意
- [dotnet/efcore#18839](https://github.com/dotnet/efcore/issues/18839) - "Database Migrate fails to execute for manually created database"、not planned として閉鎖
- [dotnet/efcore#29251](https://github.com/dotnet/efcore/issues/29251) - "EF Core automatically creates expensive database when executing migrations"、not planned として閉鎖
