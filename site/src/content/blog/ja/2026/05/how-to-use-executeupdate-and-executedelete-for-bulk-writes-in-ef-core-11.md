---
title: "EF Core 11 で ExecuteUpdate と ExecuteDelete を使って一括書き込みを行う方法"
description: "EF Core 11 の ExecuteUpdate と ExecuteDelete の完全ガイド。生成される SQL、一括書き込みを静かに上書きしてしまう変更トラッカーの落とし穴、トランザクション、影響を受けた行数による同時実行制御、そして EF Core 10 のデリゲートセッターで単純な if 文を使って条件付き更新を組み立てる方法を解説します。"
pubDate: 2026-05-31
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "ja"
translationOf: "2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-05-31
---

手短に言うと、多数の行を 1 つの SQL 文で更新または削除するには、LINQ の `Where` で行を選び、その結果のクエリに対して `ExecuteUpdateAsync` または `ExecuteDeleteAsync` を呼び出します。EF Core 11 はこれ全体を、データベース上で実行される単一の `UPDATE` または `DELETE` に変換します。エンティティの読み込みも、変更トラッカーも、`SaveChanges` もありません。どちらのメソッドも即座に実行され、影響を受けた行数を返します。誰もが一度は引っかかる落とし穴がこれです。これらのメソッドは変更トラッカーに一切触れないため、すでに読み込んだエンティティは古い値を保持したままになり、後続の `SaveChanges` が平然とあなたの一括書き込みを上書きします。

この記事では、SQL Server 2025 に対する .NET 11 上の `Microsoft.EntityFrameworkCore` 11.0.0 における `ExecuteUpdate` と `ExecuteDelete` を扱います。生成される正確な SQL、複数プロパティの更新、既存の列の値の参照、変更トラッキングの落とし穴とその回避方法、トランザクションのセマンティクス、影響を受けた行数を使った独自の楽観的同時実行制御の実装、EF Core 10 で登場したデリゲートによる条件付きセッター、そして `SaveChanges` に戻すべき制約です。リレーショナル API は PostgreSQL や SQLite でも同一です。異なるのは生成される SQL の方言だけです。

## なぜ SaveChanges のループが一括書き込みに不向きなのか

評価の低いブログをすべて論理削除する素朴な方法は、SQL を見るまでは妥当に見えます。

```csharp
// .NET 11, EF Core 11.0.0 - the slow way
await foreach (var blog in context.Blogs.Where(b => b.Rating < 3).AsAsyncEnumerable())
{
    context.Blogs.Remove(blog);
}

await context.SaveChangesAsync();
```

これは一致するすべての行をネットワーク越しにクエリし、それぞれを追跡対象のエンティティにマテリアライズし、変更トラッカーで `Deleted` とマークし、そして `SaveChanges` で 1 行ごとに `DELETE` を発行します。50,000 件のブログが一致すれば、これは 1 つの大きな `SELECT`、50,000 回の割り当て、そして 50,000 個の `DELETE` 文（バッチ化されますが、それでも個別にパラメーター化されます）になります。データベースは、概念的には単一の集合ベースの文であるはずの操作のために膨大な作業を行います。

`ExecuteDelete` はこれらすべてを単一のラウンドトリップに集約します。

```csharp
// .NET 11, EF Core 11.0.0
int deleted = await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteDeleteAsync();
```

EF Core 11 は LINQ の述語を、クエリの場合とまったく同じように SQL に変換しますが、`SELECT` の代わりに `DELETE` を発行します。

```sql
DELETE FROM [b]
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

何も読み込まれず、何も追跡されず、`deleted` に行数が入ります。行を選択するときと同じように、結合やサブクエリを含む任意の変換可能な LINQ を `Where` に入れられます。

## ExecuteUpdate でその場で更新する

`ExecuteUpdate` は `UPDATE` の兄弟分です。評価の低いブログを削除する代わりに、非表示にしましょう。

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.IsVisible, false));
```

`Where` が行を選択し、`SetProperty` の呼び出しがどの列をどの値に変更するかを指定します。EF Core 11 は次を発行します。

```sql
UPDATE [b]
SET [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

複数の列を一度に変更するには、`SetProperty` の呼び出しを連鎖させます。すべて 1 つの文にまとまります。

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.IsVisible, false)
        .SetProperty(b => b.Rating, 0));
```

```sql
UPDATE [b]
SET [b].[Rating] = 0,
    [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

### 古い値から新しい値を計算する

`SetProperty` の 2 番目の引数は定数である必要はありません。ラムダを渡すと現在の行が得られるので、既存の列から新しい値を計算できます。一致する各評価を 1 つ増やすには次のようにします。

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters =>
        setters.SetProperty(b => b.Rating, b => b.Rating + 1));
```

このラムダ内では `b.Rating` は更新前の列の値であり、EF Core は式全体を SQL に変換するため、算術はデータベース上でアトミックに、読み取り・変更・書き込みの競合状態なしに行われます。

```sql
UPDATE [b]
SET [b].[Rating] = [b].[Rating] + 1
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

これはカウンター、残高、バージョンスタンプに使いたいパターンです。`SaveChanges` で行うと、行を読み込み、メモリ内で変更し、保存することになり、あなたの読み取りと書き込みの間に別のトランザクションが同じ行を変更できる隙間が生まれます。集合ベースの `UPDATE` にはそのような隙間がありません。

## あなたの書き込みを静かに飲み込む変更トラッカーの落とし穴

両メソッドについて頭に叩き込むべき最も重要なことがこれです。これらは即座に有効になり、EF の変更トラッカーとはいっさい相互作用しません。これが速度の源であり、同時に誰もが少なくとも一度は犯すただ 1 つのバグの源でもあります。

この一連の流れを注意深く追ってください。

```csharp
// .NET 11, EF Core 11.0.0
// 1. Tracking query: this Blog is now tracked, Rating == 5 in memory.
var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");

// 2. Bump every blog's rating by one in the database. Runs now.
await context.Blogs
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.Rating, b => b.Rating + 1));

// 3. Mutate the tracked instance in memory.
blog.Rating += 2;

// 4. Persist tracked changes.
await context.SaveChangesAsync();
```

ステップ 2 の後、データベースの行は `6` になります。しかし追跡対象のインスタンスは、`ExecuteUpdate` が変更トラッカーに何も伝えなかったため、元の値が `5` のままだと信じています。ステップ 3 はメモリ内の値を `7` に設定します。ステップ 4 で `SaveChanges` が実行されると、EF は現在の値 `7` を、ステップ 1 で記録した*元の*値（`5`）と比較し、プロパティが変更されたと判断して `7` を書き込みます。あなたの一括 `+1` は消え、それが起きたことすら知らない `SaveChanges` によって上書きされます。

[EF Core の ExecuteUpdate と ExecuteDelete のドキュメント](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete)の公式ガイダンスは率直です。同じ作業単位内で、同じエンティティに対して、追跡対象の `SaveChanges` による変更と、`ExecuteUpdate`/`ExecuteDelete` による非追跡の変更を混在させるのは避けてください。実際には、トラブルを避けるためのクリーンな方法が 2 つあります。

1. それらの行のクエリで `AsNoTracking()` を使ったコンテキストに対して一括書き込みを実行し、追跡対象のものが古くなりえないようにします。
2. エンティティを読み取る必要がある場合は、一括書き込みを実行してから、再度クエリする前に `context.ChangeTracker.Clear()` を呼び出し、次の読み取りがデータベースから新しい値で再投入されるようにします。

```csharp
// .NET 11, EF Core 11.0.0 - re-read fresh after a bulk write
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.IsVisible, false));

context.ChangeTracker.Clear();

var hidden = await context.Blogs
    .AsNoTracking()
    .Where(b => !b.IsVisible)
    .ToListAsync();
```

最もクリーンなメンタルモデルはこうです。`ExecuteUpdate`/`ExecuteDelete` は、たまたまあなたの `DbContext` を共有しているだけの、別個のより低レベルなデータアクセス層に属するものとして扱ってください。これらはエンティティではなく SQL を話します。これは、[変更トラッキングを壊さずに DbContext をモックする](/ja/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)ときに尊重するのと同じ境界です。変更トラッカーは状態を持つメモリ内のものであり、サイドチャネルからの書き込みでは更新されません。

## トランザクション: 暗黙的なものは何もない

どちらのメソッドも、あなたのためにトランザクションを開始しません。各呼び出しはそれ自身のラウンドトリップであり、ラップしない限り、それ自身の暗黙的なトランザクションです。この一連の流れは 4 つの別々のトランザクションです。

```csharp
// .NET 11, EF Core 11.0.0 - four independent transactions, NOT atomic
await context.Blogs.ExecuteUpdateAsync(/* update A */);
await context.Blogs.ExecuteUpdateAsync(/* update B */);

var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");
blog.Rating += 2;
await context.SaveChangesAsync();
```

更新 B が例外をスローしても、更新 A はすでにコミット済みです。共有トランザクションが存在しなかったため、ロールバックはありません。2 つ以上の一括書き込みがまとめて成功またはまとめて失敗する必要がある場合は、[DatabaseFacade](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.databasefacade) を通じて明示的なトランザクションを開始します。

```csharp
// .NET 11, EF Core 11.0.0 - one atomic unit
await using var tx = await context.Database.BeginTransactionAsync();

await context.Blogs
    .Where(b => b.Rating < 0)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, 0));

await context.Posts
    .Where(p => p.IsOrphaned)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

これで両方の文が 1 つのトランザクションを共有し、失敗時にはまとめてロールバックします。いずれかが遅いテーブルに対して実行され、[SqlException: Timeout expired](/ja/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) に遭遇する場合、明示的なトランザクションは、バッチに対してより長いコマンドタイムアウトを設定する場所でもあります。

## 行数を使って独自の同時実行制御を実装する

`SaveChanges` は同時実行トークンを通じて楽観的同時実行制御を無料で提供します。トークンを `WHERE` 句に追加し、一致する行がなければ `DbUpdateConcurrencyException` をスローします。`ExecuteUpdate` と `ExecuteDelete` は変更トラッカーに触れないため、これを自動的には行えません。代わりに素材を与えてくれます。影響を受けた行数です。

同時実行トークンを自分の `Where` に入れ、戻り値を検査します。

```csharp
// .NET 11, EF Core 11.0.0 - hand-rolled optimistic concurrency
int updated = await context.Blogs
    .Where(b => b.Id == id && b.Version == expectedVersion)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.Title, newTitle)
        .SetProperty(b => b.Version, b => b.Version + 1));

if (updated == 0)
{
    // Either the row is gone or someone else bumped Version first.
    throw new DbUpdateConcurrencyException("Blog was modified concurrently.");
}
```

`Version` のチェックが SQL の `WHERE` の一部であるため、比較と書き込みは 1 つのアトミックな文です。別のトランザクションがすでに `Version` をインクリメントしていれば、どの行も一致せず、`updated` は `0` で返り、あなたはそれに対応します。これは、アクセスの多いエンドポイントでの単一行の更新では追跡パスよりも*高速*なことが多く、[ホットパス向けのコンパイル済みクエリ](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)の読み取り側パターンともよく組み合わさります。

## 式ツリーなしの条件付きセッター（EF Core 10 以降）

EF Core 10 より前は、セッターの引数は式ツリーであり、動的な更新は苦痛でした。流暢なチェーンの途中に `if` 文を入れることはできなかったため、条件付き更新は呼び出し全体を分岐させるか、式ツリーを手で組み立てるかを意味しました。EF Core 10 から、そして EF Core 11 に引き継がれて、セッターの引数が文本体を持つ通常のデリゲートであるオーバーロードがあります。通常の C# の制御フローを使えます。

```csharp
// .NET 11, EF Core 11.0.0 - conditional setters with normal control flow
await context.Blogs
    .Where(b => b.Id == id)
    .ExecuteUpdateAsync(setters =>
    {
        setters.SetProperty(b => b.Title, newTitle);

        if (rankChanged)
        {
            setters.SetProperty(b => b.Rating, newRating);
        }

        foreach (var (column, value) in extraFlags)
        {
            // build setters in a loop, one per flag that actually changed
            setters.SetProperty(column, value);
        }
    });
```

デリゲートの本体は C# で一度実行され、設定する列のリストを組み立てます。その後 EF Core 11 はそれを単一の `UPDATE` に変換します。これは、クライアントが変更したいフィールドだけを送る PATCH エンドポイントを実装する慣用的な方法です。すべての列を更新したり、読み込み・変更・保存に頼ったりするのではなく、必要なセッターだけを正確に組み立てて 1 つの文を発行します。古い式ベースのオーバーロードも依然として存在し、常に同じ列という静的なケースには適しています。

## 関連エンティティの参照と制約

`ExecuteUpdate` は `SetProperty` の中でナビゲーションを直接参照できません。これは変換されません。

```csharp
// .NET 11, EF Core 11.0.0 - does NOT work
await context.Blogs.ExecuteUpdateAsync(
    setters => setters.SetProperty(b => b.Rating, b => b.Posts.Average(p => p.Rating)));
```

回避策は、まず値を計算する匿名の射影に `Select` し、その射影に対して `ExecuteUpdate` を呼び出すことです。

```csharp
// .NET 11, EF Core 11.0.0 - set each Blog's rating to the average of its Posts
await context.Blogs
    .Select(b => new { Blog = b, NewRating = b.Posts.Average(p => p.Rating) })
    .ExecuteUpdateAsync(setters => setters.SetProperty(x => x.Blog.Rating, x => x.NewRating));
```

EF Core 11 は平均を `UPDATE` 内の相関サブクエリに変換します。

```sql
UPDATE [b]
SET [b].[Rating] = CAST((
    SELECT AVG(CAST([p].[Rating] AS float))
    FROM [Post] AS [p]
    WHERE [b].[Id] = [p].[BlogId]) AS int)
FROM [Blogs] AS [b]
```

ナビゲーション以外に、次の制約を念頭に置いてください。

- **更新と削除のみ。** `ExecuteInsert` はありません。挿入は依然として `Add` と `SaveChanges` を通じて行います。
- **古い値は返さない。** SQL は影響を受けた行を返せますが、EF Core 11 はそれを公開しません。得られるのは件数だけです。
- **呼び出しをまたいだバッチ化はない。** 2 回の `ExecuteUpdate` 呼び出しは 2 回のラウンドトリップです。変更を蓄積して一度にフラッシュする相当のものはありません。
- **1 つの文につき 1 つのテーブル。** 生の SQL `UPDATE`/`DELETE` と同様に、1 回の呼び出しは 1 つのテーブルを対象とします。複数のテーブルにまたがる TPT 継承階層を横断する更新は、1 回の呼び出しでは表現できません。
- **リレーショナルプロバイダーのみ。** これらはリレーショナルクエリプロバイダー上の拡張メソッドです。in-memory プロバイダーにはありません。

最初の点は注目に値します。ホットパスが大量の*挿入*である場合、どちらのメソッドも役立ちません。それは独自の答えを持つ別の問題であり、[一括挿入における EF Core 11 と Dapper の比較](/ja/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)でベンチマークされています。

## どちらを選ぶべきか

判断は主に、エンティティが必要かどうかにかかっています。述語で行を削除または更新していて、その後メモリ内で影響を受けたオブジェクトが必要ないなら、`ExecuteDelete`/`ExecuteUpdate` はほぼ常に正しい選択です。1 つの文、マテリアライズなし、トラッキングのオーバーヘッドなしです。それは、[EF Core 11 で N+1 クエリを検出する](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)ときに突き止めて潰すのと同じ本能、つまりデータベースが全作業を単一の集合ベースの操作で行える場合に、行ごとのラウンドトリップを拒む本能です。

本当に変更トラッカーが必要なときは `SaveChanges` に戻ってください。複雑なオブジェクトグラフ、追跡された状態に依存するカスケード動作、自動の同時実行トークン、または `SaveChanges` に組み込まれたインターセプターやドメインイベントです。そして両者を混在させるときは、その境界を思い出してください。一括メソッドは SQL を直接書き込み、あなたの追跡対象エンティティを過去に凍結したまま残します。一括書き込みの後はトラッカーをクリアするか `AsNoTracking()` でクエリし、複数の文にまたがる作業は明示的なトランザクションでラップし、何行が実際に変更されたかに正しさが依存する場合は返された行数を確認してください。
