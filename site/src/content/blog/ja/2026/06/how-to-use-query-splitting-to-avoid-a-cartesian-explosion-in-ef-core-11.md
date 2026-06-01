---
title: "EF Core 11 でクエリ分割を使ってデカルト爆発を避ける方法"
description: "2 つの同階層コレクションを Include すると、EF Core 11 はクロス積を返し、行数が爆発します。AsSplitQuery でこれをどう解決するか、グローバルに有効化する方法、そして注意すべき整合性と並び順の落とし穴を解説します。"
pubDate: 2026-06-01
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "sql-server"
  - "how-to"
lang: "ja"
translationOf: "2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-01
---

手短に言うと、1 つの LINQ クエリが同じ階層で 2 つ以上のコレクションナビゲーションを読み込むと (`.Include(b => b.Posts).Include(b => b.Contributors)`)、EF Core はそれを同階層の JOIN を持つ 1 つの SQL ステートメントに変換し、データベースは両方のコレクションのクロス積を返します。50 件の投稿と 20 人の貢献者を持つブログは 1000 行として返ってきます。`.AsSplitQuery()` を呼び出すと、EF Core 11 は代わりにコレクションごとに 1 つのクエリを発行するので、50 + 20 = 70 行を別々のラウンドトリップで取得できます。修正はメソッド呼び出し 1 つですが、人々を悩ませることが 3 つあります。分割クエリ間のデータ整合性、各クエリで繰り返される余分な参照 join、そして `Skip`/`Take` での並び順の正しさです。

この記事は SQL Server に対する .NET 11 と EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.x) を対象としていますが、デカルト爆発の仕組みと `AsSplitQuery` API は PostgreSQL と SQLite でも同一です。爆発した SQL、分割された SQL、クエリ単位とグローバルで動作を設定する方法、そして両者の選び方を示します。

## デカルト爆発とは実際に何なのか

親と 1 つの子コレクションの間のリレーショナル JOIN は問題ありません。問題は、同じ親にぶら下がる 2 つの子コレクションに対して親を JOIN するときに始まります。標準的なブログモデルを見てみましょう。

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; set; } = [];
    public List<Contributor> Contributors { get; set; } = [];
}

public sealed class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public string Title { get; set; } = "";
}

public sealed class Contributor
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public string FirstName { get; set; } = "";
}
```

では、両方のコレクションを 1 つのクエリでブログを読み込みます。

```csharp
var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .ToListAsync();
```

EF Core 11 は同じ階層に 2 つの `LEFT JOIN` を持つ 1 つのステートメントを生成します。

```sql
SELECT [b].[Id], [b].[Name],
       [p].[Id], [p].[BlogId], [p].[Title],
       [c].[Id], [c].[BlogId], [c].[FirstName]
FROM [Blogs] AS [b]
LEFT JOIN [Posts] AS [p] ON [b].[Id] = [p].[BlogId]
LEFT JOIN [Contributors] AS [c] ON [b].[Id] = [c].[BlogId]
ORDER BY [b].[Id], [p].[Id]
```

`Posts` と `Contributors` はどちらも `Blog` のコレクションなので、データベースはクロス積を返す以外に選択肢がありません。各投稿行はそのブログの各貢献者行と組み合わされます。50 件の投稿と 20 人の貢献者を持つブログは 50 * 20 = 1000 行を生み出し、それらの行のそれぞれが `Blog` のすべての列、投稿の列、貢献者の列を繰り返します。EF Core はクライアント側で材料化したオブジェクトの重複を排除するので、50 件の投稿と 20 人の貢献者を持つ 1 つの `Blog` は得られますが、ネットワークは 1000 行の冗長なデータの分を支払ったことになります。

乗数はコレクションサイズの積であり、和ではありません。10 行を持つ 3 つ目の同階層コレクションを追加すると、1 つの親に対して 50 * 20 * 10 = 10,000 行になります。各ブログに投稿が 2 件しかない開発環境では無害に見えるクエリが、ブログに数百件の投稿がある本番環境では数百メガバイトを転送しうるのはこのためです。[EF Core の単一クエリと分割クエリの公式ガイド](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries) は、分割後に行数が 133,000 超から 1000 強へと減少した実例を記載しています。

重要な非該当ケース: 異なる階層のネストされた include は爆発しません。`.Include(b => b.Posts).ThenInclude(p => p.Comments)` は `Blog` ではなく `Post` にぶら下がる `Comments` なので、各コメントはちょうど 1 行にマッピングされ、クロス積は発生しません。デカルト爆発は特に同じ階層の同階層コレクションに関するものです。

## EF Core がすでに出してくれる警告

EF Core 11 はこれをヒントなしに静かに起こさせはしません。複数のコレクションを読み込むクエリを検出し、分割動作を選択していない場合、ログ出力パイプラインを通じて `MultipleCollectionIncludeWarning` を発生させます。デフォルトではスローではなくログ出力されるので、ノイズの多いログでは見落としやすいです。開発中に早期に失敗させるために、これを例外に昇格させることができます。

```csharp
// .NET 11, EF Core 11.0.0
services.AddDbContext<BloggingContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.ConfigureWarnings(w =>
        w.Throw(RelationalEventId.MultipleCollectionIncludeWarning));
});
```

これを設定すると、明示的な `AsSingleQuery()` または `AsSplitQuery()` なしに 2 つの同階層コレクションを含むクエリは実行時にスローし、作成者に意図的な決定を強制します。これは [EF Core 11 で N+1 クエリを検出するガイド](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) でパフォーマンス回帰を狩るために推奨しているのと同じ防御的な姿勢です。負荷の下で発見するのではなく、スケールしにくいパターンについてフレームワークに大声で知らせさせるのです。

## 修正方法: AsSplitQuery

クエリに演算子を 1 つ追加します。

```csharp
var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

EF Core 11 は今や同じ接続上で 3 つの別々の SQL ステートメントを発行します。ブログのルートクエリ、投稿のクエリ、貢献者のクエリです。

```sql
-- Query 1: the roots
SELECT [b].[Id], [b].[Name]
FROM [Blogs] AS [b]
ORDER BY [b].[Id]

-- Query 2: posts, correlated back to the roots
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Posts] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]

-- Query 3: contributors, correlated back to the roots
SELECT [c].[Id], [c].[BlogId], [c].[FirstName], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Contributors] AS [c] ON [b].[Id] = [c].[BlogId]
ORDER BY [b].[Id]
```

同じブログが今や 50 の投稿行 + 20 の貢献者行 + 1 のルート行、合計 1000 行ではなく 71 行で済みます。ブログの列はクロス積の各行に押し込まれるのではなくクエリ 1 に一度だけ現れるので、データは重複しません。EF Core は相関キーを使ってクライアント側で 3 つの結果セットを縫い合わせるため、各子クエリは `[b].[Id]` を再選択してそれで並べ替えます。

返されるオブジェクトグラフは単一クエリ版とバイト単位で同一です。`AsSplitQuery` はデータの移動方法のみを変え、返ってくるものを変えることは決してありません。そのため、親が複数の大きなコレクションを持つあらゆる読み取りクエリにとって安全なドロップイン置換になります。

## クエリ分割をグローバルに有効化する

ほとんどのクエリが複数のコレクションに展開する場合、`AsSplitQuery()` をあちこちに散りばめるよりもデフォルトを切り替える方がきれいです。`UseQuerySplittingBehavior` を使ってプロバイダーオプションで設定します。

```csharp
// .NET 11, EF Core 11.0.0
services.AddDbContext<BloggingContext>(options =>
{
    options.UseSqlServer(connectionString,
        sql => sql.UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery));
});
```

列挙型 `QuerySplittingBehavior` には 2 つの値があります。`SingleQuery` (フレームワークのデフォルト、すべてを 1 つのステートメントに JOIN する) と `SplitQuery` (コレクションごとに 1 つのステートメント) です。グローバルなデフォルトが `SplitQuery` になったら、`AsSingleQuery()` で個々のクエリを 1 つのステートメントに戻すようオプトインします。

```csharp
var blog = await ctx.Blogs
    .Include(b => b.Posts)
    .AsSingleQuery()       // override the global SplitQuery default
    .FirstAsync(b => b.Id == id);
```

妥当な経験則: ちょうど 1 つのコレクションを読み込むクエリには `AsSingleQuery` を使い (爆発は起こりえず、ラウンドトリップを 1 つ節約できます)、2 つ以上のものはグローバルなデフォルト `SplitQuery` に任せます。グローバルなデフォルトを設定すると、コンテキスト全体について明示的な決定を下したことになるので、`MultipleCollectionIncludeWarning` も抑制されます。

## クエリ分割が間違った選択であるとき

分割は無料の勝利ではなく、それをそのように扱うことは、帯域幅の問題をレイテンシや正しさの問題と引き換えにする方法です。検討すべき 3 つの欠点があります。

**各分割は別々のラウンドトリップです。** 3 つのコレクションは、データベースへの 3 つのラウンドトリップを意味します。低レイテンシのローカルネットワークでは見えませんが、ラウンドトリップのレイテンシが 15 ms あるクラウドデータベースに対しては、3 つの逐次クエリは何らかの作業が始まる前に純粋な待ち時間を 45 ms 追加します。コレクションが小さい場合 (それぞれ数行)、クロス積は微小であり、1 つのラウンドトリップを支払う 1 つの JOIN クエリの方が、それぞれが自分の分を支払う 3 つの分割クエリよりも高速です。分割クエリは、コレクションがクロス積の行数がラウンドトリップのコストを上回るほど大きい場合に勝ちます。

**デフォルトでは分割間にトランザクションの整合性がありません。** 1 つの SQL ステートメントはデータベースの 1 つの整合スナップショットを見ます。分割クエリは複数のステートメントであり、クエリ 1 とクエリ 2 の間に別のトランザクションがコミットすると、読み込む投稿が読み込んだブログの状態と一致しないことがあります。公式ドキュメントによれば、修正は読み取りをシリアライズ可能またはスナップショットトランザクションでラップすることです。

```csharp
// .NET 11, EF Core 11.0.0
using var tx = await ctx.Database.BeginTransactionAsync(
    System.Data.IsolationLevel.Snapshot);

var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();

await tx.CommitAsync();
```

ほとんどの読み取りパスでは短い不整合のウィンドウは問題になりませんが、一致しなければならないコレクションをまたぐ合計を計算している場合は、スナップショット分離に手を伸ばしてください。

**参照ナビゲーションはすべての分割に join されます。** コレクションと一緒に対 1 ナビゲーションも `Include` すると、各分割クエリはその参照テーブルへの join を繰り返します。EF Core 10 以前ではこれは純粋な無駄でした。EF Core 11 はこれを修正しました。[EF Core 11 が分割クエリで参照 join を刈り取る記事](/ja/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) で取り上げているように、ランタイムは今やそれらを投影しない子クエリから参照 join を落とすので、`BlogType` のルックアップは投稿クエリで再 join されなくなりました。1 対 1 と多対 1 の参照は分割モードでも常に JOIN 経由で読み込まれることに注意してください。参照は行を増やせないので、分割するものは何もありません。

## Skip と Take での並び順の落とし穴

微妙な正しさの罠はページングです。分割クエリは共有キーで並べ替えることで結果セットを相関させ、並び順が完全に一意でない場合、各分割クエリは `Skip`/`Take` と組み合わさったときに異なる行のサブセットを選ぶことがあります。ブログを `CreatedDate` で並べ替え、2 つのブログが同じ日付を共有するとしましょう。

```csharp
// Risky on older EF: non-unique ordering with paging
var page = await ctx.Blogs
    .OrderBy(b => b.CreatedDate)
    .Skip(20).Take(10)
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

リレーショナルデータベースは固有の並び順を一切適用しないため、ルートクエリと子クエリがそれぞれ同点を別々に解決し、あなたのページにないブログの投稿を返す可能性があります。EF Core 10 と 11 は、相関キーが一意になるように生成された `ORDER BY` に主キーを自動的に追加することでこれを強化していますが、安全な習慣は EF のバージョンに関係なく自前の並び順を決定的にすることです。

```csharp
// .NET 11, EF Core 11.0.0 -- fully unique ordering
var page = await ctx.Blogs
    .OrderBy(b => b.CreatedDate)
    .ThenBy(b => b.Id)            // tie-breaker makes the order total
    .Skip(20).Take(10)
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

`ThenBy(b => b.Id)` を追加すると並び順が全順序になるので、各分割クエリはどの 10 件のブログがページにあるかで一致します。これにはコストがかからず、2 つの行がたまたま同点になったときにのみ現れる種類のバグを取り除きます。

## 判断のためのクイックチェックリスト

複数のコレクションを含むクエリに出くわしたら、これを順に確認してください。

1. **クエリは 2 つ以上の同階層コレクションを読み込んでいますか?** そうでなければ、デカルト爆発は起こりえません。単一クエリのままにしてください。
2. **コレクションは本番で大きいですか?** 各親がコレクションごとに数百行を持つなら、クロス積が支配的なコストです。分割してください。
3. **データベースのレイテンシは高いですか (クラウド、リージョン間)?** そうでコレクションが小さい場合、余分なラウンドトリップが爆発より高くつくことがあります。分割する前に測定してください。
4. **読み取りに整合スナップショットが必要ですか?** コレクションをまたぐ集計を計算するなら、分割をスナップショットまたはシリアライズ可能トランザクションでラップしてください。
5. **ページングはありますか?** 主キーの同点解決で `OrderBy` を完全に一意にしてください。

クエリが 1 秒間に何千回も実行されるホットパスでは、LINQ から SQL への変換がキャッシュされるように分割を [EF Core のコンパイル済みクエリ](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) と組み合わせてください。そして読み取りが本当にクリティカルパス上にあり EF Core のオーバーヘッドが問題になる場合は、[一括操作のための EF Core 11 と Dapper の比較](/ja/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/) を一見の価値がありますが、通常のコレクション読み込みでは `AsSplitQuery` がそのギャップの大半を埋めます。リストを材料化する代わりに結果をストリーミングする場合、同じ分割ルールが [EF Core 11 の IAsyncEnumerable クエリ](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) に適用されます。

デカルト爆発は、1 行の修正で結果セットが同一になる数少ない EF Core パフォーマンス問題の 1 つです。難しいのは `AsSplitQuery()` の呼び出しではなく、そもそもそれが起きていると知ることです。開発中に `MultipleCollectionIncludeWarning` を例外に変えれば、フレームワークは本番に到達する前に、どのクエリに処置が必要かを正確に教えてくれます。

出典: [単一クエリと分割クエリ、EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries)、および [EF Core 11 の新機能ノート](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)。
