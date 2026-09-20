---
title: "2 つのアプリインスタンスが同じメッセージを消費するときに EF Core 11 で冪等なメッセージ処理を保証する方法"
description: "ハンドラーの存在チェックは、あなたが思っているようなガードではありません。inbox テーブルに一意インデックスを張り、業務上の変更と同じ SaveChanges でマーカーを書き込み、勝者はデータベースに決めさせます。さらに、それを静かに台無しにする ExecuteUpdate の罠も扱います。"
pubDate: 2026-09-20
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "concurrency"
  - "messaging"
  - "idempotency"
  - "sql-server"
  - "postgresql"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-guarantee-idempotent-message-processing-in-ef-core-11-with-an-inbox-table"
translatedBy: "claude"
translationDate: 2026-09-20
---

端的な答えです。`if (await db.Inbox.AnyAsync(...)) return;` を信用するのをやめてください。2 つのインスタンスは、どちらかがコミットする前に両方ともそのチェックを実行でき、両方ともメッセージを処理してしまいます。代わりに、inbox テーブルの重複排除キーに一意インデックスを張り、業務上の変更と並べてマーカー行をチェンジトラッカーに追加し、1 回の `SaveChangesAsync` で両方をコミットするか、どちらもコミットしないかにします。競争に負けたインスタンスは、内部例外が一意制約違反である `DbUpdateException` を受け取ります。これは「他の誰かがすでにこれを実行した」という意味なので、メッセージに確認応答して戻ります。ハンドラーを冪等にするのは、あなたの `if` ではなくデータベースです。

この記事では、その競合状態を詳しく見たうえで、EF Core 11 が実際に発行する SQL を伴う 4 ステップの修正、重複メッセージと本物の制約違反を見分ける方法、データベーストランザクションに参加できない副作用のための 2 フェーズの変種、そして全体を静かに無効化してしまう 3 つの間違いを扱います。

バージョンと検証についての注記です。EF Core 11 は .NET 11 ランタイムを必要とし、[EF Core リリースページ](https://learn.microsoft.com/en-us/ef/core/what-is-new/)によれば 2026 年 11 月に .NET 11 と共に出荷されます。以下の内容はすべて、.NET 11 RC 1 SDK 上の `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 で実行しました。このマシンには SQL Server も PostgreSQL もないため、並行実行は同じデータベースファイルへの 2 本の接続を使った SQLite プロバイダーに対して行い、SQL Server の出力は `GenerateCreateScript()` と接続を抑止するインターセプターを使ってオフラインで生成しました。実行できなかったサーバー側の挙動に依存する主張については、その旨を明記し、代わりにベンダーのドキュメントを引用します。

## なぜ存在チェックはガードにならないのか

At-least-once は、Azure Service Bus、RabbitMQ、Kafka、SQS から得られる配信保証です。Microsoft の [Idempotent Consumer パターン](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer)のページは、重複があなたのところに届く 3 つの経路を挙げています。確認応答が失われた送信をプロデューサーが再試行した、ロックの期限切れ後にブローカーが再配信した、データベースへの書き込みと確認応答の間でプロセスがクラッシュした、の 3 つです。

どれも珍しいものではありません。ローリングデプロイ中の pod の再起動は、それだけで後ろの 2 つを引き起こします。そしてレプリカを複数動かしているので、再配信は同じインスタンスには戻りません。空いているコンシューマーに届き、それはまさにその瞬間に元のコピーを処理している最中かもしれません。

ほとんどの人が最初に書くハンドラーがこれです。

```csharp
// EF Core 11.0.0-rc.1, .NET 11. This is the version that does not work.
public async Task Handle(CreditRequested msg, CancellationToken ct)
{
    if (await db.Inbox.AnyAsync(m => m.MessageId == msg.MessageId && m.Consumer == "credit", ct))
        return;

    db.Credits.Add(new Credit { Amount = msg.Amount });
    db.Inbox.Add(new InboxMessage
    {
        MessageId = msg.MessageId,
        Consumer = "credit",
        ReceivedUtc = DateTime.UtcNow
    });

    await db.SaveChangesAsync(ct);
}
```

2 つのインスタンス、1 つのメッセージ ID、チェックと保存の間に 50 ms の間隔、そして一意ではない通常のインデックスしか持たない inbox テーブル。

```text
### 1. check-then-insert, no unique index, two concurrent consumers
  B: committed
  A: committed
  credits applied = 2, total = 200.0
  inbox rows = 2
```

どちらのリーダーも空の inbox を見て、どちらもマーカーを書き、どちらも口座に入金しました。マーカーテーブルは今や積極的に嘘をついています。メッセージが処理されたと、2 回言っているのです。

## 4 ステップの修正

1. inbox テーブルにメッセージ ID とコンシューマー識別子の組に対する一意インデックスを張り、データベースが 2 番目の書き込み手を拒否できるようにします。
2. マーカー行と業務上の変更を同じ `DbContext` に入れ、1 回の `SaveChangesAsync` でコミットして、両方が揃って着地するか、まったく着地しないかにします。
3. その特定のインデックスに対する一意制約違反を内部例外に持つ `DbUpdateException` を捕捉し、「別のインスタンスがすでにこのメッセージを処理した」として扱います。
4. コミット経路と重複を捕捉した経路の両方でメッセージに確認応答し、未処理の例外が起きたときだけメッセージを放棄します。

### 1. 重複排除キーに一意インデックスを張る

キーはメッセージの識別子とコンシューマーの識別子の組です。コンシューマー部分は、複数の独立したハンドラーが同じチャネルを購読するときに効いてきます。メッセージだけをキーにすると、最初にマーカーを記録したハンドラーが他のすべてのハンドラーを抑制してしまいます。

```csharp
// EF Core 11.0.0-rc.1
public class InboxMessage
{
    public long Id { get; set; }               // surrogate, keeps the clustered index sequential
    public Guid MessageId { get; set; }
    public string Consumer { get; set; }
    public DateTime ReceivedUtc { get; set; }
    public DateTime? ProcessedUtc { get; set; }
}

protected override void OnModelCreating(ModelBuilder b)
{
    var inbox = b.Entity<InboxMessage>();
    inbox.HasKey(m => m.Id);
    inbox.Property(m => m.Consumer).HasMaxLength(200).IsRequired();
    inbox.HasIndex(m => new { m.MessageId, m.Consumer }).IsUnique();
}
```

SQL Server プロバイダーでの `GenerateCreateScript()` はこれを生成します。

```sql
CREATE TABLE [Inbox] (
    [Id] bigint NOT NULL IDENTITY,
    [MessageId] uniqueidentifier NOT NULL,
    [Consumer] nvarchar(200) NOT NULL,
    [ReceivedUtc] datetime2 NOT NULL,
    [ProcessedUtc] datetime2 NULL,
    CONSTRAINT [PK_Inbox] PRIMARY KEY ([Id])
);
CREATE UNIQUE INDEX [IX_Inbox_MessageId_Consumer] ON [Inbox] ([MessageId], [Consumer]);
```

`MessageId` を主キーにしたくなる衝動は抑えてください。SQL Server では主キーは既定でクラスター化され、ランダムな `uniqueidentifier` に対するクラスター化インデックスは挿入のたびにテーブルを断片化させます。`bigint IDENTITY` のキーにして一意性は別の非クラスター化インデックスで強制すれば、挿入はクラスター化インデックスの末尾に追記され、あちこちでページ分割を起こすことがありません。これはまさに [MassTransit](https://masstransit.massient.com/documentation/configuration/middleware/outbox) が自身の `InboxState` エンティティで使っている形です。ソース中で "Primary key for table, to have ordered clustered index" と説明された `long Id` を持ち、重複排除のペアは `HasAlternateKey(p => new { p.MessageId, p.ConsumerId })` で宣言されています。

### 2. 業務上の変更と同じ SaveChanges でマーカーを書き込む

その前でもその後でもありません。[EF Core のトランザクションのドキュメント](https://learn.microsoft.com/en-us/ef/core/saving/transactions)は、1 回の `SaveChanges` 呼び出しにおけるすべての変更が 1 つのトランザクションに入ること、そして 1 つでも失敗すればそのすべてがロールバックされることを明言しています。つまり、その呼び出しは完全に成功するか、データベースを手つかずのまま残すかのどちらかです。

これは `DbTransactionInterceptor` で確認しました。口座を更新してマーカーを挿入する 1 回の `SaveChangesAsync` は、SQLite では次の 2 つのステートメントを `BEGIN, COMMIT` で囲みます。

```sql
UPDATE "Accounts" SET "Balance" = @p0
WHERE "Id" = @p1
RETURNING 1;

INSERT INTO "Inbox" ("Consumer", "MessageId", "ProcessedUtc", "ReceivedUtc")
VALUES (@p0, @p1, @p2, @p3)
RETURNING "Id";
```

SQL Server では同じ保存がこれを送ります。

```sql
SET IMPLICIT_TRANSACTIONS OFF;
SET NOCOUNT ON;
INSERT INTO [Inbox] ([Consumer], [MessageId], [ProcessedUtc], [ReceivedUtc])
OUTPUT INSERTED.[Id]
VALUES (@p0, @p1, @p2, @p3);
```

すべてか無かの部分を仮定ではなく証明するために、同じ保存の中に必ず失敗する挿入を入れました。マーカーは着地しませんでした。

```text
### 3. marker + business write in one SaveChanges: all or nothing
  SaveChanges threw SqliteException
  inbox rows after failure = 0 (marker rolled back with the business write)
```

知っておく価値のある注意点が 1 つあります。既定の `AutoTransactionBehavior.WhenNeeded` は、保存が複数のステートメントを必要とするときにだけ EF が明示的なトランザクションを開くという意味です。それは正しい既定値ですが、あなたが頼っている原子性は EF がトランザクションは必要だと判断することに由来する、ということでもあります。`AutoTransactionBehavior.Never` を設定した場合、保存の途中で失敗するとそれ以前のコマンドがコミット済みのまま残り、データベースが部分的な状態になりうるとドキュメントは警告しています。メッセージハンドラーでは設定しないでください。

### 3. 一意制約違反を捕捉して「処理済み」として扱う

先頭の安価な存在チェックは残しておきましょう。再配信が数分後に届くという一般的なケースでは高速パスになり、ロールバックされるトランザクションを 1 つ節約できます。ただそれは正しさの保証ではありません。保証は catch ブロックです。

```csharp
// EF Core 11.0.0-rc.1, SQL Server + PostgreSQL
try
{
    await db.SaveChangesAsync(ct);
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    // another instance committed this message first; its transaction already
    // applied the business change, so there is nothing left to do
    return;
}

static bool IsInboxDuplicate(DbUpdateException ex) => ex.InnerException switch
{
    SqlException s => (s.Number == 2601 || s.Number == 2627)
                      && s.Message.Contains("IX_Inbox_MessageId_Consumer", StringComparison.Ordinal),
    PostgresException p => p.SqlState == PostgresErrorCodes.UniqueViolation
                           && p.ConstraintName == "IX_Inbox_MessageId_Consumer",
    _ => false
};
```

修正したハンドラーを同じ 2 インスタンスの競争にかけると、こうなります。

```text
### 2. same handler, unique index on (MessageId, Consumer)
  A: committed
  B: DbUpdateException / SqliteException code=19 ext=2067
         inner message: SQLite Error 19: 'UNIQUE constraint failed: Inbox.MessageId, Inbox.Consumer'.
  credits applied = 1, total = 100.0
  inbox rows = 1
```

入金 1 件、マーカー 1 行、そして敗者はきれいに結果を知りました。

### 4. 両方の経路でメッセージに確認応答する

コミットも、捕捉した重複も、どちらも終端の結果です。メッセージを完了させてください。ブローカーに再配信させるために放棄してよいのは、未処理の例外が起きたときだけです。これを逆にして重複のときに放棄すると、デッドレターに入るまで往復し続けるメッセージができあがります。

## 両方のインスタンスが挿入している間、データベースは何をしているのか

興味深いのは、敗者が即座に失敗する私の SQLite の実行結果のほうではありません。2 つの挿入が重なるケース、つまりインスタンス A がマーカーを挿入したもののまだコミットしておらず、インスタンス B が同じペアを挿入しようとするケースです。

PostgreSQL の[一意インデックスのチェック](https://www.postgresql.org/docs/18/index-unique-checks.html)のドキュメントは、何が起きるかをまさに説明しています。競合する行がまだコミットされていないトランザクションのものである場合、2 番目の挿入側はそのトランザクションがどう終わるかを待って確かめなければなりません。ロールバックされれば競合はまったくなく、コミットされれば一意性違反になります。

そのブロッキングは機能であって、チューニングで取り除くべき問題ではありません。B は A のトランザクションが決着するまで自分の運命を知りません。A がコミットすれば B は `23505` を受け取り、業務上の変更が永続化されたと分かったうえで安全にスキップできます。ハンドラーが例外を投げたか pod がトランザクションの途中で死んだかで A がロールバックすれば、B の挿入は成功して B がメッセージを処理します。これはまさに望んだ動作です。SQL Server は別の経路で同じ結果に至ります。A は挿入したインデックスキーに排他ロックを保持するので、B は A がコミットするかロールバックするまでそのロックで待たされ、その後に初めて重複キーのエラーが発生するか、処理が進みます。このマシンには PostgreSQL も SQL Server もないので、このセクション全体は私が計測したものではなく、ドキュメントに記された挙動として受け取ってください。

## 重複メッセージと本物のバグを見分ける

上の `IsInboxDuplicate` のチェックはインデックス名で照合しています。これは意図的です。業務上の行を書き込むメッセージハンドラーは、たいてい独自の一意制約を持つテーブルにも書き込みます。注文番号、メールアドレス、支払いの冪等キーなどです。catch ブロックがあらゆる一意制約違反を飲み込むと、業務上の書き込みにある本物のデータのバグがブローカーには「処理済み」として報告され、メッセージは消えてしまいます。

プロバイダーがどれだけ助けてくれるかは様々です。例外の型をリフレクションで調べました。

```text
### 10. does the provider exception name the constraint?
  SqliteException: SqliteErrorCode, SqliteExtendedErrorCode, SqlState
  SqlException: Errors, Number, SqlState
```

気前がよいのは Npgsql です。`PostgresException` は `SqlState`、`TableName`、`ColumnName`、`ConstraintName` を公開しているので (Npgsql 10.0.3 で確認)、文字列解析なしで制約を名前で照合できます。`SqlException` が構造化して与えてくれるのは `Number` だけなので、メッセージ本文の中のインデックス名で照合することになります。`SqliteException` は `SqliteErrorCode` 19 と `SqliteExtendedErrorCode` 2067 を与えますが、列のリストはメッセージの中にしかありません。

2 つの SQL Server エラー番号について。Microsoft の[レプリケーションエラーリファレンス](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100))によれば、2601 は "Cannot insert duplicate key row in object '%.\*ls' with unique index '%.\*ls'"、2627 は "Violation of %ls constraint '%.\*ls'. Cannot insert duplicate key in object '%.\*ls'" です。どちらになるかは一意性をどう宣言したかで決まります。`HasIndex(...).IsUnique()` は `CREATE UNIQUE INDEX` を発行し、`HasAlternateKey(...)` はテーブル制約を発行します。

```sql
CONSTRAINT [AK_Inbox_MessageId_Consumer] UNIQUE ([MessageId], [Consumer])
```

両方の番号を捕捉して名前で照合すれば、モデルがどちらを生成したかを気にする必要はありません。

## これを静かに壊す 3 つの方法

**`ExecuteUpdate` と `ExecuteDelete` は保存の一部ではありません。** これらは独自のステートメントを即座に発行し、`SaveChanges` が後で開くトランザクションの外で実行されます。`ExecuteUpdateAsync` で口座に入金してから inbox マーカーを追加するハンドラーには、原子性がまったくありません。

```text
### 9. ExecuteUpdate commits on its own, before SaveChanges runs
  marker rejected as duplicate
  balance = 100 (the credit stuck even though the marker was rejected)
```

重複検出は完璧に働き、それでもお金は動きました。一括更新のパフォーマンスが欲しいなら、`BeginTransactionAsync` で明示的なトランザクションを開き、その中で `ExecuteUpdateAsync` と `SaveChangesAsync` を実行して、一度だけコミットしてください。

**同じ `DbContext` で再試行すると、同じ失敗する挿入を再試行することになります。** 保存が失敗した後も、チェンジトラッカーはすべてのエンティティを保存前の状態のまま保持します。

```text
### 4. change-tracker state after a duplicate-key failure
  InboxMessage  state = Added
  Account       state = Modified
  retry on same context: threw again (SqliteException)
```

再試行は新しいスコープと新しいコンテキストから始めなければなりません。実務上は、再試行がハンドラーの中ではなくメッセージポンプのレベルに置かれるということです。

**再試行する実行戦略と明示的なトランザクションを組み合わせると例外が投げられます。** 上の `ExecuteUpdate` の問題を解決しようと `BeginTransactionAsync` に手を伸ばした瞬間、`EnableRetryOnFailure` が文句を言い始めます。この失敗については別の記事で扱っています。[構成された実行戦略はユーザー起動のトランザクションをサポートしていません](/ja/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)。修正方法は戦略の `ExecuteAsync` で、トランザクション全体を包んで再試行がその全体を再実行するようにすることです。

## トランザクションに参加できない副作用

メールの送信、カードへの課金、blob ストレージへの書き込みは、データベーストランザクションと一緒にロールバックできません。うまくいくパターンは 2 フェーズの確保です。マーカーを挿入してコミットし、次に外部の処理を行い、最後に結果を記録します。

```csharp
// EF Core 11.0.0-rc.1
db.Inbox.Add(new InboxMessage { MessageId = msg.MessageId, Consumer = "email", ReceivedUtc = DateTime.UtcNow });
try
{
    await db.SaveChangesAsync(ct);          // phase 1: claim the message
}
catch (DbUpdateException ex) when (IsInboxDuplicate(ex))
{
    return;                                  // someone else owns this one
}

await emailer.SendAsync(msg, ct);            // the side effect, outside any transaction

await db.Inbox
    .Where(m => m.MessageId == msg.MessageId && m.Consumer == "email")
    .ExecuteUpdateAsync(s => s.SetProperty(m => m.ProcessedUtc, DateTime.UtcNow), ct);
```

2 つの並行インスタンス、1 回の外部呼び出し。

```text
### 7. two-phase claim: insert marker, commit, then call the API
  A: won the claim, called the API, marked processed (rows=1)
  B: lost the claim, skipping the API call
  external API calls = 1
```

これで何が得られ、何が得られないかに注意してください。重複した呼び出しはなくなります。コミットと送信の間のクラッシュには耐えられません。`ProcessedUtc` が null のまま確保された行が残り、メールが送信されたかどうかを知る手段がない状態になります。Microsoft のガイダンスは、処理中のレコードを中途半端に終わった試行かもしれないものとして読み、盲目的に確認応答するのではなく、古くなったものは照合するか人手による対応に回すべきだとしています。実務的な答えは、プロバイダーの冪等キーとして同じ `MessageId` を送ることで下流の呼び出しも冪等にし、しきい値より古い確保をスイーパーに再試行させることです。

## キーの選び方と後片付け

重複排除キーは再配信をまたいで安定していなければなりません。Azure Service Bus の `MessageId` と、CloudEvents の `source` と `id` のペアはどちらも条件を満たします。`CorrelationId` は満たしません。会話を識別するものであり、複数のメッセージが共有するからです。配信試行回数のカウンターや受信タイムスタンプも同様に不適格です。ブローカーが割り当てるメッセージ ID が存在しない Kafka では、トピック、パーティション、オフセットの三つ組が特定のレコードに対して安定しています。プロデューサーが設定するヘッダーがあるなら、そのほうが優れています。

inbox テーブルは刈り込まない限り永遠に増え続けますが、刈り込みが早すぎると窓が再び開きます。ブローカーがまだ元のメッセージを再配信できる期間より長く行を残してください。つまり、ロックまたは可視性のタイムアウトに最大配信回数を掛け、メッセージの time-to-live を足し、さらに数週間後に運用担当者がデッドレターキューから再投入するメッセージのための余裕を足したものです。`ReceivedUtc < cutoff` に対する夜間の `ExecuteDeleteAsync` で十分で、ここは `ExecuteDelete` がトランザクションの外で走ることがまさに望ましい数少ない場面の 1 つです。

これらはどれも維持がただではありません。だからこそ、操作が本来的に冪等であるときにはこのパターンを省く価値があります。業務上の識別子をキーにした upsert や、差分を適用する代わりに絶対値を設定する書き込みには、inbox はまったく不要です。すでに MassTransit を使っているなら、`AddInboxStateEntity()` とその仲間が、設定可能な `DuplicateDetectionWindow` と配信サービスを備えた同じ仕組みを `MassTransit.EntityFrameworkCore` 9.2.2 で提供します。

自前で作るなら、テーブル 1 つ、インデックス 1 つ、catch ブロック 1 つ、そしてクリーンアップジョブです。人が間違えるのはテーブルの部分ではありません。ハンドラーの先頭にある `if` が仕事をしていると信じてしまうことです。

### 次に読む

- [Fix: EF Core の並行 INSERT で発生する 23505: duplicate key value violates unique constraint](/ja/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/)
- [EF Core 11 で rowversion トークンを使って楽観的同時実行制御を実装する方法](/ja/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)
- [EF Core 11 で UPDLOCK と SELECT ... FOR UPDATE を使って悲観的ロックを取る方法](/ja/2026/09/how-to-use-pessimistic-locking-with-updlock-and-select-for-update-in-ef-core-11/)
- [解決: The configured execution strategy does not support user-initiated transactions](/ja/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [.NET 11 のバックグラウンドジョブにおける BackgroundService vs IHostedService vs Hangfire](/ja/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/)

### 出典

- [Idempotent Consumer パターン](https://learn.microsoft.com/en-us/azure/architecture/patterns/idempotent-consumer), Azure Architecture Center
- [EF Core のトランザクション](https://learn.microsoft.com/en-us/ef/core/saving/transactions), EF Core ドキュメント
- [EF Core 11 の新機能](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew), EF Core ドキュメント
- [PostgreSQL 18: 一意インデックスのチェック](https://www.postgresql.org/docs/18/index-unique-checks.html)
- [レプリケーションエラーリファレンスのエラー 2601 と 2627](https://learn.microsoft.com/en-us/previous-versions/SQL/SQL-server-2008/ms151779(v=sql.100)), Microsoft Learn
- [Transactional Outbox の構成](https://masstransit.massient.com/documentation/configuration/middleware/outbox), MassTransit ドキュメント
- [`InboxState.cs`](https://github.com/MassTransit/MassTransit/blob/develop/src/Persistence/MassTransit.EntityFrameworkCoreIntegration/EntityFrameworkCoreIntegration/InboxState.cs), MassTransit
