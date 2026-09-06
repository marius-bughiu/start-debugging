---
title: "EF Core 11 で UPDLOCK と SELECT ... FOR UPDATE を使って悲観的ロックを取る方法"
description: "EF Core 11 にはいまだにロック用の API がありません。FromSql で実際の行ロックを取る方法を解説します。SQL Server では WITH (UPDLOCK, ROWLOCK)、PostgreSQL では FOR UPDATE、ロック範囲を静かに広げてしまうサブクエリの罠、NOWAIT と SKIP LOCKED、デッドロックのリトライ、そして行がまだ存在しない場合の対処法まで。"
pubDate: 2026-09-06
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-06
---

短い答え: EF Core 11 には悲観的ロックの API がないため、明示的なトランザクションの中で `FromSql` を使って自分でロックを取ります。SQL Server では `SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {id}`、PostgreSQL では `SELECT * FROM "Orders" WHERE "Id" = {id} FOR UPDATE` です。これを機能させる 2 つのルールがあり、そしてほぼ必ずここで間違えます。クエリは自分で開いたトランザクションの内側で実行しなければならない (そうでないとリーダーが終わった瞬間にロックが解放されます) こと、そして `WHERE` 句は後ろにつなげた LINQ の `.Where()` ではなく `FromSql` の文字列の中に置かなければならないことです。

この記事では、それぞれの形で EF Core が生成する正確な SQL、ロックを伴うクエリの上に LINQ を合成するとなぜロック範囲がテーブル全体まで静かに広がるのか、`NOWAIT` と `SKIP LOCKED` が失敗の仕方をどう変えるのか、接続の回復性戦略と衝突せずにデッドロックをリトライする方法、そして誰も書かないケース、つまりまだ存在しない行をロックする話を扱います。

バージョンについての注記です。EF Core 11 は 2026 年 9 月時点でプレビューであり、[EF Core のリリースと計画のページ](https://learn.microsoft.com/en-us/ef/core/what-is-new/)によれば 2026 年 11 月に .NET 11 とともに出荷されます。EF11 は .NET 11 のランタイムを必要とします。このマシンにある SDK は .NET 10.0.302 だけなので、以下に示す生成 SQL はすべて `Microsoft.EntityFrameworkCore.SqlServer` 10.0.10 と `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 上で `ToQueryString()` を使って生成しました。この領域は EF11 でも変わっていません。[What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) のページには `FromSql`、トランザクション、ロックに関する変更は挙げられていません。

## EF Core にいまだにロック API がないのは意図的です

この要望は 2021 年 9 月から [dotnet/efcore#26042, "Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency)"](https://github.com/dotnet/efcore/issues/26042) としてオープンのままです。`needs-design` のラベルが付き、対象リリースのない Backlog マイルストーンに置かれています。EF Core 11 でもクローズされていません。

汎用的な API が難しい理由は、この記事の残りの部分に表れています。SQL Server はロックをテーブル参照に付くテーブルヒントとして表現し、PostgreSQL は 4 つの強さを持つステートメントレベルの句として表現します。そして両者は結合、`LIMIT`、存在しない行の扱いについて食い違います。両方にきれいに対応する形は存在しません。だから SQL は自分で書きます。

最初に検討すべき代替手段は `rowversion` の同時実行トークンです。悲観的ロックが適切なのは、競合する処理がサーバー上の 1 つの短いトランザクションの内側で完結する場合だけです。読み取りから更新、書き込みまでの途中に人間が入るなら、代わりに [EF Core 11 の rowversion 同時実行トークン](/ja/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)を使ってください。ユーザーのコーヒー休憩の間、データベースのトランザクションを開いたままにしておくことはできません。

## セットアップは 4 ステップ

1. **明示的なトランザクションを開きます。** `await using var tx = await context.Database.BeginTransactionAsync();`。すべての行ロックはトランザクションとともに生まれ、ともに消えます。トランザクションがないと、EF Core は読み取りを独自の暗黙トランザクションで包み、リーダーを読み切った時点でコミットしてしまうため、ロックはマイクロ秒後には消えています。
2. **`FromSql` で行を読み、フィルターは SQL 文字列の中に書きます。** ロックの構文は、実際にスキャンされるテーブル参照に付いている必要があります。
3. **追跡されているエンティティを変更し、`SaveChangesAsync` を呼びます。** `FromSql` の結果は他の LINQ クエリと同じく既定で追跡されるため、更新は自動的に生成されます。
4. **コミットします。** ロックはコミットまたはロールバックで解放され、それより前には解放されません。

SQL Server 版を最初から最後まで示します。

```csharp
// EF Core 11 (verified on EF Core 10.0.10), .NET 11, C# 14
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

PostgreSQL 版は、文字列が違うだけの同じコードです。

```csharp
// Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
await using var tx = await context.Database.BeginTransactionAsync();

var order = await context.Orders
    .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE""")
    .SingleAsync();

order.Status = "Confirmed";
await context.SaveChangesAsync();

await tx.CommitAsync();
```

`FromSql` の補間は文字列連結ではありません。`{orderId}` の穴は `DbParameter` になるので、インジェクションに対して安全です。`ToQueryString()` がそれを裏付けます。

```sql
-- SQL Server, from ToQueryString()
DECLARE p0 int = 42;

SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = @p0
```

[EF Core の SQL クエリのドキュメント](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)による制約が 1 つあります。結果セットには、エンティティのマップされたすべてのプロパティに対応する列が、マップされた列名で含まれていなければなりません。`SELECT *` はこれを満たします。手書きで列を並べてプロパティを 1 つ忘れると、マテリアライズ時に例外になります。これは [FromSql 操作の結果に必要な列が存在しませんでした](/ja/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)で扱っているテーマです。

## SQL Server で UPDLOCK が実際にもたらすもの

`UPDLOCK` は共有ロック (S) ではなく更新ロック (U) を取得し、[テーブルヒントのリファレンス](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table)によればトランザクションが完了するまでそれを保持します。この後半こそが要点です。`READ COMMITTED` 下の素の `SELECT` は共有ロックを取り、行を読み終えた時点で解放します。そのため 2 つのトランザクションが両方とも読み、両方とも書くと決め、その後それぞれが S ロックを X ロックに変換しようとしてデッドロックに陥ります。U ロック同士は互換性がないため、2 番目の読み手は書き込みでデッドロックする代わりに読み取りでブロックされます。この変換デッドロックこそ、そもそも人々がこの機能を探しに来る典型的な症状です。

押さえておく価値のある詳細が 3 つあります。

- **`ROWLOCK` は粒度の要求であって保証ではありません。** SQL Server が通常ページロックやテーブルロックを取る場面で、行ロックを要求します。数行のスキャンが、触れてもいない行にまたがるページロックへエスカレートしないように付けておきます。何らかの理由で `UPDLOCK` が `TABLOCK` と組み合わさった場合、ドキュメントによれば代わりに排他テーブルロックになり、これが望んだ結果であることはまずありません。
- **`UPDLOCK` だけでは挿入を止められません。** ロックするのは存在する行です。ロジックが「この注文の明細を合計し、それからもう 1 行挿入する」なら、別のトランザクションが合計を変える明細を挿入できます。ドキュメントが `SERIALIZABLE` と同等と説明する `HOLDLOCK` を追加し、トランザクションの間ずっと述語に対するキー範囲ロックを取ってください。`WITH (UPDLOCK, HOLDLOCK, ROWLOCK)` です。
- **ロックはデータ行ではなくインデックスキーに乗ることがあります。** Remarks のセクションは明確です。カバリングの非クラスター化インデックスがクエリに応答する場合、ロックはインデックスキー上に取られます。普段は見えませんが、互いに無関係だと思っていた 2 つのクエリがブロックし合う理由になることがあります。

非推奨の点も注意してください。`WITH` キーワードなしのテーブルヒントは今も解析されますが、Microsoft はこの書き方を削除対象としています。ヒントの間をカンマで区切って `WITH (UPDLOCK, ROWLOCK)` と書き、`(UPDLOCK ROWLOCK)` とは書かないでください。

## PostgreSQL にはロックの強さが 4 段階あり、FOR UPDATE が最も強い

[SELECT のロック句のドキュメント](https://www.postgresql.org/docs/current/sql-select.html)は `FOR UPDATE`、`FOR NO KEY UPDATE`、`FOR SHARE`、`FOR KEY SHARE` を強い順に定義しています。`FOR UPDATE` は他のすべてのロック取得に加えて `UPDATE` と `DELETE` をブロックします。`FOR NO KEY UPDATE` は、キー列に触れない素の `UPDATE` が自力で取るロックであり、キー以外の列だけを変更し、`FOR KEY SHARE` を取る子テーブルからの外部キーチェックをブロックしたくない場合の正しい選択です。

つまずきやすいのは `FOR UPDATE` と `Include` の組み合わせです。PostgreSQL は外部結合の null 許容側をロックすることを拒否します。"FOR UPDATE cannot be applied to the nullable side of an outer join" です。対処は `FOR UPDATE OF "Orders"` のように、本当にロックしたいテーブルだけを名指しすることです。EF Core ではこの問題はほぼ自動的に解消します。`Include` はあなたの `FromSql` の上にサブクエリとして合成され、結合はその外側に置かれるからです。

```sql
-- Npgsql, FromSql with FOR UPDATE plus .Include(o => o.Lines)
SELECT o."Id", o."Status", o."Total", o0."Id", o0."OrderId", o0."Quantity"
FROM (
    SELECT * FROM "Orders" WHERE "Id" = @p0 FOR UPDATE
) AS o
LEFT JOIN "OrderLines" AS o0 ON o."Id" = o0."OrderId"
ORDER BY o."Id"
```

`Orders` の行はロックされ、`OrderLines` の行はロックされません。明細もロックする必要があるなら、`OrderLines` に対する 2 つ目の `FromSql` で、一貫した順序でロックしてください。

## ロック範囲を静かに広げてしまうサブクエリの罠

これは本番コードで見かけると賭けてもいい失敗パターンです。`FromSql` は合成されます。後ろにつなげた LINQ 演算子は、あなたの SQL を派生テーブルに変えます。フィルターを文字列から出して `.Where()` に移すと、EF Core は次を生成します。

```sql
-- Npgsql: .FromSql($"""SELECT * FROM "Orders" FOR UPDATE""").Where(o => o.Status == "Pending")
SELECT o."Id", o."Status", o."Total"
FROM (
    SELECT * FROM "Orders" FOR UPDATE
) AS o
WHERE o."Status" = 'Pending'
```

`FOR UPDATE` は今や `Orders` のフィルターなしスキャンに付いています。PostgreSQL は、ロック句を持つサブクエリの内側へ外側の述語を押し込みません。そうするとロックされる行が変わってしまうからです。ドキュメントは `ORDER BY` の回避策の説明で同じ点を述べており、`SELECT * FROM (SELECT * FROM mytable FOR UPDATE) ss ORDER BY column1` は「すべての行をロックする」としています。つまりこのクエリはテーブルの全行をロックし、他のすべての書き手をブロックします。しかもエラーも警告もなく、実行計画に明らかにおかしく見えるものも出さずに、です。

SQL Server は同じ形と、より微妙な問題を生みます。

```sql
-- SQL Server: .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)").Where(o => o.Status == "Pending")
SELECT [o].[Id], [o].[Status], [o].[Total]
FROM (
    SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK)
) AS [o]
WHERE [o].[Status] = N'Pending'
```

T-SQL では派生テーブルは最適化の壁ではないため、オプティマイザーは述語をその中に押し込むこともあれば、押し込まないこともあります。どの行が最終的にロックされるかが、あなたのコードの性質ではなく選ばれた実行計画の性質になってしまいます。これは午前 3 時にデバッグしたいバグではありません。

ルールはこうです。行の集合を絞るものはすべて `FromSql` の文字列の中に入れます。後ろに LINQ をつなぐのは、`Include` や射影のようにロック範囲を広げようがないものだけにします。そして一度は確認してください。テストの中で `ToQueryString()` を使うか、[EF Core 11 が生成する SQL をログ出力する](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)かのどちらかです。

## NOWAIT と SKIP LOCKED: 失敗の仕方を選ぶ

既定では、ブロックされたロック要求は待ちます。どちらのデータベースも代替手段を 2 つ用意しています。

**すぐに失敗させる。** PostgreSQL の `FOR UPDATE NOWAIT` は待たずに直ちに SQLSTATE `55P03` (`lock_not_available`) を発生させます。SQL Server の `NOWAIT` テーブルヒントは、そのテーブルに対する `SET LOCK_TIMEOUT 0` と同等だと文書化されており、エラー 1222 "Lock request time out period exceeded" として現れます。どちらの場合も、リクエストが 30 秒スレッドを占有し続ける代わりに、409 に変換できる例外が得られます。

```csharp
// Npgsql: fail immediately rather than queue behind another worker
try
{
    var order = await context.Orders
        .FromSql($"""SELECT * FROM "Orders" WHERE "Id" = {orderId} FOR UPDATE NOWAIT""")
        .SingleAsync();
}
catch (PostgresException ex) when (ex.SqlState == "55P03")
{
    return Results.Conflict("Order is being modified by another request.");
}
```

**競合している行を飛ばす。** これはジョブキューのパターンで、悲観的ロックが疑いなく正しい設計と言える唯一のケースです。PostgreSQL では `SKIP LOCKED` と書き、SQL Server では `READPAST` と書きます。ドキュメントはこれを、まさに「SQL Server のテーブルを使う作業キューを実装する際のロック競合を減らすため」に作られたものと説明しています。

```csharp
// SQL Server: claim up to 10 unclaimed jobs, skipping rows other workers hold
await using var tx = await context.Database.BeginTransactionAsync();

var jobs = await context.Jobs
    .FromSql($"""
        SELECT TOP (10) * FROM [Jobs] WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE [Status] = 'Queued' ORDER BY [Id]
        """)
    .ToListAsync();

foreach (var job in jobs)
{
    job.Status = "Running";
}

await context.SaveChangesAsync();
await tx.CommitAsync();
```

`READPAST` には制約が 2 つあります。行レベルのロックは飛ばしますがページレベルのロックは飛ばさないので、これも `ROWLOCK` と組み合わせる理由になります。また `READ_COMMITTED_SNAPSHOT` が `ON` でセッションの分離レベルが `READ COMMITTED` のときは使えません。その構成では `READCOMMITTEDLOCK` ヒントを追加する必要があります。PostgreSQL の `SKIP LOCKED` は意図的に一貫性のないビューを返すため、キューには適していますが、集計するつもりのものには不適切です。

## デッドロックは起きるので、リトライする

悲観的ロックはほとんどの書き込み競合を待機に変えますが、デッドロックをなくすわけではありません。行 A の次に B、B の次に A の順でロックする 2 つのトランザクションは今もデッドロックします (SQL Server はエラー 1205、PostgreSQL は SQLSTATE `40P01`)。安価な構造的対処は、常に決定的な順序でロックを取得することで、たいていは主キーで並べ替えてからロックを取り始めることを意味します。

残りはリトライで対処します。`EnableRetryOnFailure` を有効にしている場合、リトライする実行戦略は自分で開いたトランザクションを包むことを拒否し、`InvalidOperationException` を投げる点に注意してください。作業単位全体を戦略の中に通す必要があります。これは [実行戦略はユーザー起動のトランザクションをサポートしていません](/ja/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)で詳しく扱っています。

```csharp
var strategy = context.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    await using var tx = await context.Database.BeginTransactionAsync();

    var order = await context.Orders
        .FromSql($"SELECT * FROM [Orders] WITH (UPDLOCK, ROWLOCK) WHERE [Id] = {orderId}")
        .SingleAsync();

    order.Status = "Confirmed";
    await context.SaveChangesAsync();
    await tx.CommitAsync();
});
```

注意点が 1 つあります。EF の既定の `SqlServerRetryingExecutionStrategy` は、SQL Server の一時的なエラー番号の特定のリストに対してリトライします。1205 が処理されていると決めつけず、必要なデッドロックがその集合に含まれているか確認するか、自分で `errorNumbersToAdd` を渡してください。

## 存在しない行はロックできない

これが最大の制約です。まだ挿入されていない行に対する `SELECT ... FOR UPDATE` は 0 行を返し、何もロックしません。そのため「このユーザー名が使われているか確認してから挿入する」という古典的な競合は、行ロックではまったく守られません。2 つのトランザクションがどちらも何も見つけず、どちらも挿入し、一方が一意制約違反を受け取ります。これはまさに [fix 23505 duplicate key value violates unique constraint が EF Core の同時挿入で発生する](/ja/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/)のシナリオです。

抜け道は 3 つあり、好ましさの低い順に並べます。

- **一意インデックスと例外のキャッチ。** データベースが制約を強制し、あなたはプロバイダーの例外をドメインのエラーに変換します。退屈で、正しく、既定の答えです。
- **述語ロック。** SQL Server では、一致したはずの `WHERE` に対する `WITH (UPDLOCK, HOLDLOCK)` がキー範囲ロックを取り、競合する挿入を実際にブロックします。PostgreSQL には `SERIALIZABLE` 分離レベル以外に直接の等価物はありません。
- **値をキーにしたアドバイザリロック。** PostgreSQL の `pg_advisory_xact_lock(key)` は任意の 64 ビット数値に対するロックを取り、トランザクションの終了時に自動的に解放されます (セッションスコープでロールバックしても残る `pg_advisory_lock` とは異なります)。SQL Server の等価物は `@LockOwner = 'Transaction'` と文字列のリソース名を指定した `sys.sp_getapplock` で、成功時に `0` または `1`、タイムアウトで `-1`、デッドロックの犠牲になった場合は `-3` を返します。

```csharp
// PostgreSQL: serialise on a logical key rather than a row
await using var tx = await context.Database.BeginTransactionAsync();
await context.Database.ExecuteSqlAsync($"SELECT pg_advisory_xact_lock({tenantId})");
// ... read, decide, insert ...
await tx.CommitAsync();
```

アドバイザリロックは、直列化したい対象が行ではなく判断であるときに適した道具です。「このテナントの夜間集計を実行できる worker は 1 つだけ」といった場合です。

## まったく別の手段を選ぶべきとき

操作全体が 1 つの算術更新で済むなら、そもそもロックしないでください。`UPDATE Accounts SET Balance = Balance - 10 WHERE Id = 1 AND Balance >= 10` はアトミックで、ステートメントの実行中は自前の排他ロックを取り、影響を受けた行数によって事前条件が成立したかどうかを教えてくれます。EF Core ではこれが `ExecuteUpdateAsync` であり、エンティティを読み込む方式とのトレードオフは [ExecuteUpdate とエンティティ読み込みおよび SaveChanges の比較](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)で扱っています。悲観的ロックが割に合うのは、読み取りと書き込みの間に SQL では表現できない本物のロジックがある場合だけです。

そしてトランザクションは短く保ってください。`BeginTransactionAsync` から `CommitAsync` までの間に行うことはすべて、他のリクエストがブロックされて過ごす時間です。ロックを保持したトランザクションの内側から決済プロバイダーへ HTTP 呼び出しを行うのは、1 つの遅い依存関係でテーブル全体を落とすやり方そのものです。

### 次に読む

- [EF Core 11 で rowversion トークンを使って楽観的同時実行制御を実装する方法](/ja/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [Fix: 実行戦略はユーザー起動のトランザクションをサポートしていません](/ja/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Fix: EF Core 11 で FromSql 操作の結果に必要な列が存在しませんでした](/ja/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [EF Core 11 が生成する SQL をログ出力する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [EF Core における ExecuteUpdate とエンティティ読み込みおよび SaveChanges の比較](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)

## 参考資料

- [Support SELECT FOR UPDATE / UPDLOCK (pessimistic concurrency), dotnet/efcore#26042](https://github.com/dotnet/efcore/issues/26042)。2021 年からオープンで、いまだに Backlog マイルストーンにあります。
- [Table hints (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table)。`UPDLOCK`、`HOLDLOCK`、`ROWLOCK`、`READPAST`、`NOWAIT`、`WITH` キーワードの非推奨化、インデックスキーへのロックについて。
- [SELECT, The Locking Clause](https://www.postgresql.org/docs/current/sql-select.html)。4 段階のロックの強さ、`NOWAIT`、`SKIP LOCKED`、`OF table` のリスト、サブクエリでのロックに関する注記について。
- [Explicit locking, PostgreSQL ドキュメント](https://www.postgresql.org/docs/current/explicit-locking.html)。行ロックの競合マトリクスとトランザクションスコープのアドバイザリロックについて。
- [SQL queries in EF Core](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)。`FromSql` のパラメーター化、合成可能性、サブクエリでの包み込み、変更追跡について。
- [sys.sp_getapplock (Transact-SQL)](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql)。ロックモード、トランザクション所有とセッション所有の違い、戻り値のコードについて。
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)。EF11 が .NET 11 ランタイムを必要とすることを確認でき、ロックや `FromSql` の変更は挙げられていません。
