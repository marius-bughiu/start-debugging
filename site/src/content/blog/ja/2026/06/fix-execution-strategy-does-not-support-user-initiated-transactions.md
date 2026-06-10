---
title: "解決: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions"
description: "EnableRetryOnFailure は BeginTransaction と競合します。トランザクション全体を db.Database.CreateExecutionStrategy().ExecuteAsync(...) でラップし、1 つの単位として再試行させます。"
pubDate: 2026-06-10
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "ja"
translationOf: "2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions"
translatedBy: "claude"
translationDate: 2026-06-10
---

解決方法: `EnableRetryOnFailure()` で接続の回復性を有効にしたうえで、`BeginTransaction()` または `BeginTransactionAsync()` で独自のトランザクションを開きました。再試行を行う実行戦略は、自分が開始していないトランザクションを再生できないため、最初から拒否します。`db.Database.CreateExecutionStrategy()` から戦略を取得し、トランザクション全体を `strategy.ExecuteAsync(...)` の中で実行してください。デリゲート全体が 1 つの再試行可能な単位になります。

```text
System.InvalidOperationException: The configured execution strategy 'SqlServerRetryingExecutionStrategy' does not support user-initiated transactions. Use the execution strategy returned by 'DbContext.Database.CreateExecutionStrategy()' to execute all the operations in the transaction as a retriable unit.
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, Func`4 operation, Func`4 verifySucceeded, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal.SqlServerExecutionStrategy.Execute[TState,TResult](...)
   at Microsoft.EntityFrameworkCore.Storage.RelationalConnection.BeginTransaction()
```

このガイドは .NET 11 と `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0 を対象に書いていますが、メッセージと根底にあるルールは、接続の回復性が登場した EF Core 1.1 以降ずっと安定しています。EF Core 6、8、9 を使っている場合も、以下の内容はそのまま当てはまります。メッセージ中の型名はプロバイダーによって異なります。SQL Server は `SqlServerRetryingExecutionStrategy`、Npgsql は `NpgsqlRetryingExecutionStrategy`、Pomelo の MySQL プロバイダーは独自のものをスローします。解決方法はどれも同じです。

## 再試行戦略がトランザクションを拒否する理由

接続の回復性は、各データベース操作を再試行ループでラップすることで機能します。`EnableRetryOnFailure()` を呼ぶと、EF Core はどの SQL Server エラー番号が一時的か（デッドロックの犠牲者、接続断、Azure SQL のスロットリング）を把握し、それらの操作を指数バックオフで再試行する実行戦略に切り替えます。重要な語は *各* です。各クエリと `SaveChangesAsync()` の各呼び出しが、それぞれ独立した再試行可能な単位になります。いずれかが一時的に失敗すると、戦略はその 1 つの操作だけを再生します。

トランザクションはこのモデルを崩します。`BeginTransactionAsync()` を呼ぶと、複数の操作が 1 つのアトミックなグループを成すと EF Core に伝えることになります。途中で接続が切れた場合、単一のステートメントを再試行しても意味がありません。サーバーはすでにトランザクションをロールバックしており、もう存在しないトランザクションの中で単一の `INSERT` を再生すれば失敗するか、さらに悪いことに部分的な作業をコミットしてしまいます。実行戦略はトランザクションが何を含むはずだったか知りようがないため、正しく再生できません。

誤った再試行を行ってデータ破損のリスクを冒すのではなく、EF Core は再試行戦略がアクティブな状態でユーザー主導のトランザクションを開始しようとした瞬間に例外をスローします。公式ガイドは、何が懸かっているかをはっきり述べています。コミット境界をまたぐ素朴な再試行は、操作がストアの状態に依存している場合 "could lead to data corruption" とされています。この例外はバグではなく、ガードレールです。

## エラーを引き起こす最小のコード

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
builder.Services.AddDbContext<AppDb>(options =>
    options.UseSqlServer(
        connectionString,
        sql => sql.EnableRetryOnFailure())); // <-- resiliency on

// ...somewhere in a service:
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    await using var tx = await _db.Database.BeginTransactionAsync(); // <-- throws here

    var from = await _db.Accounts.FindAsync(fromId);
    var to = await _db.Accounts.FindAsync(toId);
    from!.Balance -= amount;
    to!.Balance += amount;

    await _db.SaveChangesAsync();
    await tx.CommitAsync();
}
```

`BeginTransactionAsync()` の行はトランザクションを決して返しません。EF Core はまず再試行戦略がアクティブかどうかを確認し、`InvalidOperationException` をスローします。この問題に陥るために明示的に `BeginTransaction` を呼ぶ必要はないことに注意してください。自分で作成した `TransactionScope` を含め、ユーザートランザクションを開くものはすべて該当します。

## 解決策 1: トランザクションを実行戦略でラップする

これは定番の解決策であり、Microsoft が文書化しているものです。コンテキストに実行戦略を要求し、`BeginTransactionAsync` から `CommitAsync` までトランザクション全体を含むデリゲートを渡します。内部のどこかで一時的な失敗が起きると、戦略はデリゲート全体をトランザクションごと再実行します。

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
public async Task TransferAsync(int fromId, int toId, decimal amount)
{
    var strategy = _db.Database.CreateExecutionStrategy();

    await strategy.ExecuteAsync(async () =>
    {
        await using var tx = await _db.Database.BeginTransactionAsync();

        var from = await _db.Accounts.FindAsync(fromId);
        var to = await _db.Accounts.FindAsync(toId);
        from!.Balance -= amount;
        to!.Balance += amount;

        await _db.SaveChangesAsync();
        await tx.CommitAsync();
    });
}
```

`CreateExecutionStrategy()` は、`EnableRetryOnFailure()` の呼び出しから EF Core が構成したのと同じ再試行戦略を返します。回復性がオフのときは、デリゲートをちょうど 1 回だけ実行する何もしない戦略を返すため、このコードは再試行が有効でないプロジェクトでも安全に書けます。これにより `strategy.ExecuteAsync` は、Azure でホストされたアプリのものに限らず、あらゆる明示的なトランザクションに対する妥当な既定のラッパーになります。

つまずきやすいルールが 1 つあります。デリゲートは、最初から 2 回以上実行できるだけのべき等性を備えていなければなりません。`strategy.ExecuteAsync` の呼び出し前に値を読み取って変更し、その読み取りに再試行の内部で依存してはいけません。すべての読み取りと書き込みをデリゲートの中に入れ、再試行が真っさらな状態から始まるようにしてください。

## 解決策 2: コミットの検証が必要なときの ExecuteInTransactionAsync

`strategy.ExecuteAsync` は一般的なケースをカバーしますが、盲点があります。*コミットの実行中*に接続が切れた場合、戦略はサーバーが実際にコミットしたかどうか分かりません。既定ではロールバックを想定して再生するため、ストア生成キーを使っていると重複行を挿入する可能性があります。

`ExecuteInTransactionAsync` はそのギャップを埋めます。トランザクションの開始とコミットを代わりに行い、一時的なコミット失敗の後に作業が反映されたかどうかを確認する `verifySucceeded` デリゲートを受け取ります。

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

var blog = new Blog { Url = "https://startdebugging.net" };
_db.Blogs.Add(blog);

await strategy.ExecuteInTransactionAsync(
    _db,
    operation: (ctx, ct) => ctx.SaveChangesAsync(acceptAllChangesOnSuccess: false, ct),
    verifySucceeded: (ctx, ct) =>
        ctx.Blogs.AsNoTracking().AnyAsync(b => b.BlogId == blog.BlogId, ct));

_db.ChangeTracker.AcceptAllChanges();
```

ここでは 2 つの細部が重要です。`SaveChangesAsync` は `acceptAllChangesOnSuccess: false` で呼び出され、コミットが反映されたと分かるまで追跡対象のエンティティを `Added` の状態に保ちます。これがクリーンな再生を可能にします。その後、戦略が戻ったら `ChangeTracker.AcceptAllChanges()` を 1 回呼びます。`verifySucceeded` のクエリは `AsNoTracking()` を使い、検証用の読み取りがチェンジトラッカーにまだ保留中のエンティティと衝突しないようにします。

コミットの途中で起きる稀な失敗を本当に気にしないのであれば、Microsoft の「ほぼ何もしない」選択肢は、ストア生成キーを避けること（クライアント側の `Guid` を使う）です。そうすれば、盲目的な再生がデータを黙って重複させる代わりに主キー違反をスローします。その場合は解決策 1 で十分です。

## アンビエントトランザクションと TransactionScope

同じラッパーは `TransactionScope` でも機能し、2 つのコンテキストにまたがる場合も同様です。スコープを開き、デリゲートの中で `Complete()` を呼びます。

```csharp
// .NET 11, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
var strategy = _db.Database.CreateExecutionStrategy();

await strategy.ExecuteAsync(async () =>
{
    using var scope = new TransactionScope(
        TransactionScopeAsyncFlowOption.Enabled); // required for await inside

    _db.Orders.Add(order);
    await _db.SaveChangesAsync();

    await _auditDb.SaveChangesAsync();

    scope.Complete();
});
```

`TransactionScopeAsyncFlowOption.Enabled` がないと、アンビエントトランザクションは `await` をまたいで流れず、診断しづらい別の `TransactionAbortedException` が発生します。これは別のエラーですが、まったく同じコードパスで現れるため、`TransactionScope` を非同期の EF Core 呼び出しと組み合わせるときは必ずこのフラグを設定してください。

## 落とし穴とよく似たケース

**書き込みだけでなく、単純なクエリでも発生し得ます。** GitHub の issue [dotnet/efcore#29396](https://github.com/dotnet/efcore/issues/29396) は、このメッセージが単純な `SELECT` で出るという報告を追跡しています。よくある原因は、忘れていた外側の `TransactionScope`（基底リポジトリ、テストフィクスチャ、ユニットオブワークのラッパーで開かれていることが多い）で、その「単純な」クエリが実はユーザートランザクションの中で実行されています。失敗している行より上に `BeginTransaction` や `new TransactionScope` がないか、呼び出しスタックを調べてください。

**Azure SQL は、頼んでいないのにこれを有効にすることがあります。** EF Core 8 あたりから、SQL Server プロバイダーは Azure SQL の接続文字列を検出すると既定で再試行戦略を使うようになりました（[dotnet/efcore#32165](https://github.com/dotnet/efcore/issues/32165) を参照）。LocalDB に対してローカルで動いていたコードが、回復性が有効になったために Azure で突然失敗します。クラウド環境でのみこれが見られる場合は、それが理由です。解決方法は同じラッパーであり、既定の動作を無効にする必要はありません。

**エラーを消すためだけに `EnableRetryOnFailure` を削除しないでください。** それは、おそらく欲しかったはずの回復性を取り除くことでエラーを消しているにすぎません。代わりにトランザクションをラップしてください。1 つの分離した操作で本当に回復性を回避する必要がある場合、[dotnet/efcore#24922](https://github.com/dotnet/efcore/issues/24922) で議論されているよりきれいな逃げ道は、メインのコンテキストから取り除くのではなく、再試行なしで別途構成した 2 つ目のコンテキストを使うことです。

**これは "A second operation was started on this context instance" と同じではありません。** そのエラーは 1 つの `DbContext` の同時使用に関するもので、トランザクションや再試行に関するものではありません。メッセージが実行戦略ではなく並行性に言及しているなら、代わりに[このコンテキストで開始された 2 つ目の操作](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/)の解決策を参照してください。

## 関連

- [解決: SqlException: Timeout expired が EF Core のマイグレーション中に発生する](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) は、一時的失敗の系統をマイグレーション側から扱います。
- [解決: ObjectDisposedException: Cannot access a disposed context instance](/ja/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) は、非同期コードを襲うもう 1 つの EF Core ライフサイクルの罠です。
- [EF Core ExecuteUpdate とエンティティの読み込み + SaveChanges の比較](/ja/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) は、明示的なトランザクションを完全に避けられる場面を示します。
- [EF Core 11 のインターセプターを監査に使う方法](/ja/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) は、手動トランザクションなしで保存パイプラインにフックする方法です。
- [EF Core 6 から EF Core 11 への移行: 実際に痛い破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) は、他の意外な点とともに Azure SQL の再試行の既定値を取り上げています。

## 出典

- [Connection Resiliency, EF Core](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) - `CreateExecutionStrategy`、`ExecuteInTransactionAsync`、べき等性の問題に関する定番ガイド。
- [Implement resilient Entity Framework Core SQL connections](https://learn.microsoft.com/en-us/dotnet/architecture/microservices/implement-resilient-applications/implement-resilient-entity-framework-core-sql-connections) - 同じパターンに対する .NET マイクロサービスアーキテクチャの見解。
- [dotnet/efcore#32165: Azure SQL の再試行戦略の既定化](https://github.com/dotnet/efcore/issues/32165)
- [dotnet/efcore#29396: 単純な SELECT でのエラー](https://github.com/dotnet/efcore/issues/29396)
- [dotnet/efcore#24922: 構成済みの実行戦略を一時停止する](https://github.com/dotnet/efcore/issues/24922)
