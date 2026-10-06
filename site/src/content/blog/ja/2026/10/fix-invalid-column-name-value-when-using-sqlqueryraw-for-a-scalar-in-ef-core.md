---
title: "修正: EF Core でスカラー結果に SqlQueryRaw<T> を使うと発生する Invalid column name 'Value'"
description: "EF Core は、First、Where、Max、Single を追加した時点で、スカラーの SqlQuery<T> をサブクエリでラップし、Value という名前の列を選択します。SQL の列に AS Value のエイリアスを付けるか、先にマテリアライズしてください。"
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "efcore"
  - "ef-core-11"
  - "dotnet"
lang: "ja"
translationOf: "2026/10/fix-invalid-column-name-value-when-using-sqlqueryraw-for-a-scalar-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-06
---

`Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First()` は `Invalid column name 'Value'` で失敗します。スカラーの `SqlQuery<T>` または `SqlQueryRaw<T>` に LINQ 演算子を連結すると、EF Core がその SQL をサブクエリでラップし、そこから文字どおり `Value` という名前の列を選択するためです。出力される単一の列にエイリアスを付ければ解決します: `SELECT COUNT(*) AS Value FROM Blogs`。PostgreSQL では `AS "Value"` のように引用符で囲みます。SQL を変更できない場合は、先にマテリアライズしてください (`ToListAsync()` を呼び、行はメモリ上で選びます)。以下はすべて EF Core 10.0.12 と EF Core 11.0.0-rc.1 で検証したもので、この件についての動作は両者で同一です。このルールは `SqlQuery<T>` が登場した EF Core 7.0 から存在します。

## エラーの状況

SQL Server では、例外は番号 207 の `SqlException` です。

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Invalid column name 'Value'.
```

同じバグでもプロバイダーごとに見え方が異なるため、検索しづらくなっています。SQLite と PostgreSQL のメッセージは、後述の検証実行からそのままコピーしたものです。SQL Server の行は、EF が送信する SQL に対するエンジンのエラーです (この記事の作成時には SQL Server インスタンスを用意できませんでした)。

```text
SQLite:      SQLite Error 1: 'no such column: s.Value'.
PostgreSQL:  42703: column s.Value does not exist
SQL Server:  Invalid column name 'Value'.                       (error 207)
SQL Server:  No column name was specified for column 1 of 's'.  (error 8155, unaliased COUNT(*), MAX(...) etc.)
```

SQL Server でどちらのエラーになるかは SQL によって決まります。`SELECT Id FROM Blogs` のように名前付きの列を返す場合、SQL Server は `Value` が存在しないと報告します。`COUNT(*)` のように名前のない式を返す場合は、派生テーブルに名前のない列を含められないため、SQL Server はそれより前の段階で失敗します。どちらも修正方法は同じです。

## EF Core が Value という列を要求する理由

スカラー `T` に対する `SqlQuery<T>` は、`RelationalQueryableMethodTranslatingExpressionVisitor` で変換されます。EF Core 11 RC 1 のソースでは、トランスレーターがテーブルエイリアス `s` (`"sql"` から生成) を持つ、ユーザーの SQL 用の `FromSqlExpression` と、ハードコードされた定数から名前を決める射影列を作成します。

```csharp
// EF Core 11.0.0-rc.1, src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs
private const string SqlQuerySingleColumnAlias = "Value";
```

この名前を変更する API はありません。上に何も合成しない限り、EF は SQL をそのまま送信し、先頭の列を位置で読み取ります。そのため列名は関係なく、`ToList()` は動作します。SQL 内で列を参照する必要がある演算子を追加した途端、EF は外側に `SELECT [s].[Value] FROM (<your SQL>) AS [s]` を生成し、データベースは存在しない列を探すことになります。

[EF Core の raw SQL ドキュメント](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types)は、このルールを一文で述べています。スカラー SQL クエリの上に LINQ を合成する場合は、"you must name the output column `Value`" とあります。落とし穴は、`First()` や `Single()` のようなメソッドが合成には見えないのに、実際には合成であることです。

## 最小の再現コード

次のコンソールアプリは、インメモリの SQLite で再現するため、サーバーは不要です。後で引用する SQL Server の文は、接続を抑止して `DbCommand.CommandText` を記録するインターセプターを使い、SQL Server プロバイダーから取得したものです。つまり EF が送信する正確な文であり、SQL Server インスタンスは使っていません。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (identical on .NET 10 + EF Core 10.0.12)
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();
var db = new Db(new DbContextOptionsBuilder<Db>().UseSqlite(conn).Options);
db.Database.EnsureCreated();
db.Blogs.AddRange(new Blog { Name = "a", Views = 5 }, new Blog { Name = "b", Views = 50 });
db.SaveChanges();

// Works: no composition, EF reads column 0 by position.
var all = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").ToList();

// Throws: SQLite Error 1: 'no such column: s.Value'.
var count = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First();

class Blog { public int Id { get; set; } public string Name { get; set; } = ""; public int Views { get; set; } }
class Db(DbContextOptions<Db> o) : DbContext(o) { public DbSet<Blog> Blogs => Set<Blog>(); }
```

`First()` の呼び出しでは、SQL Server プロバイダーは次の SQL を送信します。

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, captured CommandText
SELECT TOP(1) [s].[Value]
FROM (
    SELECT COUNT(*) FROM Blogs
) AS [s]
```

## 問題を引き起こす演算子

エイリアスなしの `SELECT Id FROM Blogs` に対して、両方の EF バージョンで各演算子を実行しました。表は SQLite での結果で、SQL の列は同じクエリに対して SQL Server プロバイダーが生成した内容を示します。

| `SqlQueryRaw<int>(...)` に対する呼び出し | 生成される外側の SQL (SQL Server) | エイリアスなしの結果 |
|---|---|---|
| `ToList()` / `ToListAsync()` | なし。ユーザーの SQL がそのまま送信される | 動作する |
| `AsEnumerable().First()` | なし。`First` はメモリ上で実行される | 動作する |
| `First()` / `FirstOrDefault()` | `SELECT TOP(1) [s].[Value] FROM (...) AS [s]` | 失敗する |
| `Single()` / `SingleOrDefault()` | `SELECT TOP(2) [s].[Value] FROM (...) AS [s]` | 失敗する |
| `Where(x => x > 1)` | `SELECT [s].[Value] ... WHERE [s].[Value] > 1` | 失敗する |
| `Max()` / `Min()` | `SELECT MAX([s].[Value]) FROM (...) AS [s]` | 失敗する |
| `Count()` | `SELECT COUNT(*) FROM (...) AS [s]` | 動作する |
| `Any()` | `SELECT CASE WHEN EXISTS (SELECT 1 FROM (...) AS [s]) ...` | 動作する |

`Count()` と `Any()` も SQL をラップしますが、列を参照しないため問題になりません。これがコードレビューをすり抜ける理由です。`Count()` のパスはテストされていても、後で誰かが `FirstOrDefault()` に変更すると、本番環境で例外が発生し始めます。

## 修正 1: 出力列に AS Value のエイリアスを付ける

これはドキュメントが推奨する修正で、合成をサーバー側に保てます。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = await db.Database
    .SqlQueryRaw<int>("SELECT COUNT(*) AS Value FROM Blogs")
    .FirstAsync();

var bigIds = await db.Database
    .SqlQuery<int>($"SELECT Id AS Value FROM Blogs")
    .Where(id => id > 1)
    .OrderBy(id => id)
    .ToListAsync();
```

どちらも動作するようになり、2 つ目はデータベース側でフィルターと並べ替えが行われます。

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider
SELECT [s].[Value]
FROM (
    SELECT Id AS Value FROM Blogs
) AS [s]
WHERE [s].[Value] > 1
ORDER BY [s].[Value]
```

ここでバージョン間の小さな違いが見つかりました。同じクエリに対して、EF Core 10.0.12 は `ORDER BY CAST([s].[Value] AS int)` を出力しますが、EF Core 11 RC 1 は冗長なキャストを省きます。結果は変わりませんが、アップグレード時にクエリを diff で比較している場合は、プラン用のテキストが変わります。

このエイリアスは、`string`、`DateTime`、`Guid`、`int?` のような null 許容型を含む、EF がマッピングできるあらゆるスカラー型で同様に機能します。`NULL` を返し得る集計では、null 許容型にマッピングしてください。空のテーブルでは、`SqlQueryRaw<int>("SELECT MAX(Views) AS Value FROM Blogs")` は合成の有無にかかわらず `Nullable object must have a value.` をスローしますが、`int?` 版は `null` を返します。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
int? maxViews = await db.Database
    .SqlQueryRaw<int?>("SELECT MAX(Views) AS Value FROM Blogs")
    .FirstOrDefaultAsync();
```

## 修正 2: PostgreSQL ではエイリアスを引用符で囲む

PostgreSQL は引用符なしの識別子を小文字に変換し、Npgsql は生成する列を引用符で囲みます。そのため `AS Value` は `value` という列を作り、EF は `s."Value"` を要求するので、ドキュメントどおりにしても同じエラーになります。これは Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3 と 11.0.0-rc.1.1 を PostgreSQL 18 に対して実行して確認しました。

```csharp
// .NET 11 RC 1, Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.1.1
// Throws: 42703: column s.Value does not exist
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS Value FROM \"Blogs\"").FirstAsync();

// Works
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM \"Blogs\"").FirstAsync();
```

C# 11 以降の raw 文字列リテラルを使えば、引用符を読みやすく保てます。

```csharp
// .NET 11 RC 1, C# 14
var count = await db.Database.SqlQuery<int>($"""
    SELECT count(*)::int AS "Value" FROM "Blogs"
    """).FirstAsync();
```

SQLite は列名を大文字小文字を区別せずに照合するため `AS value` でも動作し、SQL Server はデータベースの照合順序に従います (既定では大文字小文字を区別しません)。あらゆる場所で大文字の V を使った `"Value"` と書いておけば、クエリの移植性が保たれます。

## 修正 3: SQL を変更できない場合は先にマテリアライズする

SQL がストアドプロシージャ、自分が所有していないビュー、共有の定数から来ている場合は、行をクライアントに取り込み、そこで処理を完結させます。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = (await db.Database
        .SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs")
        .ToListAsync())
    .Single();

// or, synchronously
var count2 = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").AsEnumerable().Single();
```

どちらもサブクエリを生成しないため、列名は関係ありません。この方法は、ごく少数の行しか返さないクエリにだけ使ってください。`AsEnumerable().Where(...)` はフィルターの前に結果全体をクライアントにストリーミングします。これはまさに、サーバー側での合成によって避けたかったことです。

ストアドプロシージャの場合も、これが唯一の選択肢です。`EXEC` はサブクエリとしてまったく使用できないためです。その上に合成すると、サーバーに何かが届く前に別のエラーがスローされます。このケースは、[ストアドプロシージャを呼び出して結果をマッピングする](/ja/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/)ガイドで扱いました。

## 注意点と似たエラー

**SQL 内の `ORDER BY` と SQL Server での `First()`。** エイリアスがあっても、`SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs ORDER BY Views DESC").First()` は `SELECT TOP(1) [s].[Value] FROM (SELECT Views AS Value FROM Blogs ORDER BY Views DESC) AS [s]` を生成します。SQLite はこれを受け付けますが、SQL Server はエラー 1033 ("The ORDER BY clause is invalid in views, inline functions, derived tables, subqueries, and common table expressions, unless TOP, OFFSET or FOR XML is also specified") で拒否します。仮に SQL Server が受け付けたとしても、派生テーブル内の `ORDER BY` は外側のクエリの順序を保証しません。並べ替えは LINQ に移してください: `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs").OrderByDescending(v => v).First()`。

**スカラーではなく DTO の場合。** `SqlQuery<BlogStat>` (マッピングされていない型、EF Core 8 以降) では、EF は `Value` を使わず、プロパティごとに 1 列をプロパティ名で参照します。`SELECT Name AS BlogName, Views FROM Blogs` に `.Where(b => b.Views > 10)` を合成すると、SQLite では `no such column: b.Name` で失敗します (エイリアスは型名から付く `b` になります)。合成しない同じクエリは `The required column 'Name' was not present in the results of a 'FromSql' operation` で失敗します。修正方法は、各列にプロパティ名のエイリアスを付けることです。後者のメッセージは専用のガイドで扱っています: [the required column was not present in the results of a FromSql operation](/ja/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)。

**`DbSet` に対する `FromSql`。** エンティティクエリが `Value` を使うことはありません。そこで `Invalid column name` が出た場合、メッセージ内の名前はマッピングされた列のいずれかで、原因は `SELECT` リストに列が欠けていることです。

**自分の列がまさに `Value` という名前の場合。** その場合、`SELECT Value FROM Settings` はエイリアスなしでも問題なく合成できます。オンラインのサンプルの中にエイリアスなしで動作するように見えるものがあるのはこのためです。テーブルの列名を変更すると、それらのサンプルは動作しなくなります。

**実際の SQL を確認する。** 合成していない `SqlQueryRaw<int>(...)` に対する `ToQueryString()` は、ユーザー自身の SQL を出力するだけで、`First()` の後では呼び出せません。代わりに、実行されたコマンドをログに出力してください (`RelationalEventId.CommandExecuted` を使った `LogTo`、またはインターセプター)。方法は、[EF Core 11 が生成する SQL をログに出力する](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)記事で説明しています。実際の SQL を見れば、外側の `SELECT [s].[Value]` は一目瞭然です。

## raw SQL が適切なツールではない場合

コードレビューで目にするスカラーの raw SQL の大半は、LINQ で直接表現できる `COUNT`、`MAX`、`EXISTS` です。`db.Blogs.CountAsync()`、`db.Blogs.MaxAsync(b => (int?)b.Views)`、`db.Blogs.AnyAsync(...)` がそれにあたります。これらはこのエラーに遭遇せず、プロバイダーがすべてのデータベースに対して正しい引用符付けで変換してくれます。`SqlQuery<T>` は LINQ で表現できないクエリのために取っておいてください。ホットパスで raw SQL、コンパイル済みクエリ、Dapper のどれにするか迷っている場合は、[EF Core のコンパイル済みクエリと raw SQL と Dapper の比較](/ja/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)に数値があります。LINQ クエリの変換に失敗したために raw SQL へ移った場合は、["The LINQ expression could not be translated" の修正](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)ガイドで、たいてい LINQ に戻れます。

## 関連記事

- [修正: EF Core 11 で The required column 'X' was not present in the results of a 'FromSql' operation](/ja/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [EF Core 11 でストアドプロシージャを呼び出して結果をマッピングする方法](/ja/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/)
- [EF Core 11 が生成する SQL をログに出力する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [EF Core のコンパイル済みクエリと raw SQL と Dapper の比較](/ja/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [修正: EF Core 11 で The LINQ expression could not be translated](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## 参考資料

- [SQL Queries: querying scalar (non-entity) types](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types), EF Core ドキュメント
- [SQL Queries: composing with LINQ](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#composing-with-linq), SQL Server の `ORDER BY` の制限を含む
- [`RelationalQueryableMethodTranslatingExpressionVisitor.cs` at v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs), dotnet/efcore
- [`RelationalDatabaseFacadeExtensions.SqlQueryRaw<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlqueryraw), API リファレンス
- [Database engine errors](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/database-engine-events-and-errors), SQL Server ドキュメント (207, 1033, 8155)
