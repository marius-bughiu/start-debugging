---
title: "EF Core 11 でキーセット (カーソル) ページネーションを実装する方法"
description: "Skip/Take を、最後に見た行の先までシークする WHERE 句に置き換えます。完全に一意なキーで並べ替え、最後の行の値をカーソルとして引き継げば、EF Core 11 は次のページを OFFSET スキャンではなくインデックスシークに変えてくれます。"
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "ja"
translationOf: "2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-23
---

手短に言うと、`Skip(n).Take(pageSize)` でのページングをやめて、`WHERE` 句でのページングを始めましょう。キーセットページネーション (カーソルページネーションやシークページネーションとも呼ばれます) は、いま表示したばかりのページの最後の行の並べ替え値を覚えておき、データベースに対してそれよりも後にソートされる行を要求します: `OrderBy(x => x.CreatedAt).ThenBy(x => x.Id).Where(x => x.CreatedAt > lastDate || (x.CreatedAt == lastDate && x.Id > lastId)).Take(pageSize)`。並べ替え列にインデックスがあれば、すべてのページがコスト一定のインデックスシークになります。ページの手前のすべての行を再スキャンして捨てる `OFFSET` とは違います。唯一の必須要件は、完全に一意なもので並べ替えることです。実際には、本物のソートキーにタイブレーカーとして主キーを加えることを意味します。

この記事では、SQL Server 2025 を対象に、C# 14 を使った .NET 11 上の `Microsoft.EntityFrameworkCore` 11.0.0 を使用します。ここで紹介する内容はすべて PostgreSQL と SQLite でも同じように動作します。プロバイダー固有の注意点は最後にあるものだけです。グリッドの 500 ページ目がページ 1 の 10 倍の時間がかかるのを見たことがあるなら、これがその修正方法です。

## なぜ Skip/Take は深くページングするほど遅くなるのか

オフセットページネーションは、誰もが最初に書く明白なものです。ページサイズ 20、ページ 30、580 行をスキップ:

```csharp
// .NET 11, EF Core 11.0.0 - offset pagination, the slow way
var page = 30;
var pageSize = 20;

var posts = await context.Posts
    .OrderBy(p => p.PostId)
    .Skip((page - 1) * pageSize)
    .Take(pageSize)
    .ToListAsync();
```

EF Core は `Skip`/`Take` を SQL の `OFFSET`/`FETCH` (PostgreSQL と SQLite では `LIMIT`/`OFFSET`) に変換します:

```sql
SELECT [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
ORDER BY [p].[PostId]
OFFSET 580 ROWS FETCH NEXT 20 ROWS ONLY;
```

問題は `OFFSET 580` が実際に何をするかです。データベースは 581 行目にジャンプするわけではありません。順番に 600 行すべてを生成し、最初の 580 行を数え上げ、それらを捨て、最後の 20 行を返します。作業量はページサイズではなくオフセットに比例して増えるので、深いページほど次第に高コストになります。アクセスの多いテーブルでは、これはユーザーの期待とはまさに逆です。スクロールが進むほど遅くなるのです。

もう 1 つ、目立たないバグがあります。オフセットページネーションは同時書き込みに対して安定しません。公式の EF Core [ページネーションガイダンス](https://learn.microsoft.com/en-us/ef/core/querying/pagination) がこれを明記しています: 2 回のページリクエストの間に行が挿入または削除されると、結果セット全体が 1 つずれ、ページ 2 からページ 3 に移動するユーザーは、ある行を 2 回見るか、まるごと 1 行を飛ばすことになります。管理用グリッドでは誰も気づきません。しかし、行が絶えず先頭に追加される無限スクロールのフィードでは、これは目に見える再現可能な欠陥です。

## キーセットクエリは代わりに何をするのか

キーセットページネーションはオフセットという考え方を捨てます。「580 行スキップする」のではなく、「すでに持っているこの特定の行よりも後に来る行をくれ」と言うのです。最後の行のソート値を覚えておき、次のページはそれらの先までまっすぐシークする `WHERE` になります:

```csharp
// .NET 11, EF Core 11.0.0 - keyset pagination, single unique key
var pageSize = 20;
int? lastPostId = 580; // the PostId of the last row on the previous page; null for page 1

var query = context.Posts.OrderBy(p => p.PostId).AsQueryable();

if (lastPostId is int cursor)
{
    query = query.Where(p => p.PostId > cursor);
}

var posts = await query.Take(pageSize).ToListAsync();
```

これは次のように変換されます:

```sql
SELECT TOP(20) [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
WHERE [p].[PostId] > 580
ORDER BY [p].[PostId];
```

`PostId` のインデックス (クラスター化された主キーがすでにそうです) があれば、データベースは 580 より大きい最初の行に直接シークし、20 行を読み取ります。スキャンして捨てる処理はありません。ページ 1 とページ 10,000 のコストは同じです。そしてカーソルは位置ではなく値なので、テーブルの別の場所での挿入や削除がウィンドウをずらすことはありません。常に最後に見たまさにその行から続行できます。

落とし穴は名前の中にあります。キーセットページネーションには*キー*が必要です。並べ替えに使う列 (または複数の列) は、行全体にわたって厳密な全順序を生成しなければなりません。2 つの行がソートキーで同点になりうる場合、`>` 比較では同点の行が境界のどちら側に属するのかをデータベースに伝えられず、知らないうちに行をスキップしたり繰り返したりすることになります。`PostId` は一意なので、単独で機能します。`CreatedAt` のタイムスタンプはほとんど決して一意ではないので機能しません。そして、現実のクエリの多くはそこにあります。

## 一意でない列で並べ替える: タイブレーカーを加える

現実的なケースは「新しい順」で、ミリ秒単位まで衝突しうる `CreatedAt` で並べ替えるものです。[ページネーションのページ](https://learn.microsoft.com/en-us/ef/core/querying/pagination)の冒頭の警告でドキュメントが指摘している修正方法は、一意な列 (ほぼ常に主キー) を末尾に付けることで並べ替えを完全に一意にすることです:

```csharp
// .NET 11, EF Core 11.0.0 - keyset over (CreatedAt DESC, PostId DESC)
var pageSize = 20;

// Cursor carried from the last row of the previous page (null on page 1).
DateTime? lastCreatedAt = previousCursor?.CreatedAt;
int? lastPostId = previousCursor?.PostId;

var query = context.Posts
    .OrderByDescending(p => p.CreatedAt)
    .ThenByDescending(p => p.PostId)
    .AsQueryable();

if (lastCreatedAt is DateTime ca && lastPostId is int id)
{
    // Rows that sort strictly after the cursor in (CreatedAt DESC, PostId DESC).
    query = query.Where(p =>
        p.CreatedAt < ca || (p.CreatedAt == ca && p.PostId < id));
}

var posts = await query.Take(pageSize).ToListAsync();
```

`WHERE` 句がトリックのすべてなので、注意深く読んでください。降順で並べ替えているので、「カーソルの後」は小さいことを意味します。行が次のページに属するのは、その `CreatedAt` がカーソルのものより厳密に古い (`p.CreatedAt < ca`) 場合、または `CreatedAt` がちょうど同点でその `PostId` が同じ方向で同点を解消する (`p.CreatedAt == ca && p.PostId < id`) 場合です。その `==` 分岐こそ人々が落とす部分であり、それを落とすことこそが、タイムスタンプを共有する行がページ境界でスキップされる原因そのものです。`WHERE` での比較方向は `OrderBy` の方向を正確に反映しなければなりません: 昇順は `>` を使い、降順は `<` を使います。これらを取り違えると、ページが重複するか、隙間ができます。

生成される SQL は単一のシークです:

```sql
SELECT TOP(20) [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
WHERE [p].[CreatedAt] < @ca OR ([p].[CreatedAt] = @ca AND [p].[PostId] < @id)
ORDER BY [p].[CreatedAt] DESC, [p].[PostId] DESC;
```

## 端から端まで配線する

完全なループは次のとおりです: カーソルをエンコードし、ページとともに返し、次のリクエストでデコードします。手順は、カーソルがクエリ文字列に乗ろうと API レスポンスボディに乗ろうと同じです。

1. **完全に一意な並べ替えを選ぶ。** 意味のあるソート列に、最後のタイブレーカーとして主キーを加えます。ここでの列の順序が、その他すべてが従わなければならない順序です。
2. **並べ替えと正確に一致するインデックスを定義する。** `(CreatedAt DESC, PostId DESC)` に対する複合インデックスがあれば、シークは行をすでに順序どおりに読み取れます。これがないと、データベースはページごとにテーブル全体をソートし、利点は消えます。
3. **最後の行の値から `WHERE` を組み立てる。** 並べ替え列ごとに 1 つの `OR` 分岐を、各列のソート方向に一致する比較方向で作ります。
4. **`pageSize` 行を取得する。** 必要に応じて `pageSize + 1` にすれば、2 回目のクエリなしで次のページが存在するかどうかを判定できます。
5. **最後に返された行からカーソルを発行し**、次のリクエストで送るよう呼び出し元に返します。

ページと不透明なカーソルを返す最小限のエンドポイント:

```csharp
// .NET 11, EF Core 11.0.0, C# 14 - minimal API keyset endpoint
app.MapGet("/posts", async (string? cursor, AppDbContext db) =>
{
    const int pageSize = 20;

    var query = db.Posts
        .AsNoTracking()
        .OrderByDescending(p => p.CreatedAt)
        .ThenByDescending(p => p.PostId)
        .AsQueryable();

    if (Cursor.TryDecode(cursor, out var ca, out var id))
    {
        query = query.Where(p =>
            p.CreatedAt < ca || (p.CreatedAt == ca && p.PostId < id));
    }

    // Fetch one extra row to detect whether a further page exists.
    var rows = await query.Take(pageSize + 1).ToListAsync();

    var hasMore = rows.Count > pageSize;
    var page = rows.Take(pageSize).ToList();

    var next = hasMore && page.Count > 0
        ? Cursor.Encode(page[^1].CreatedAt, page[^1].PostId)
        : null;

    return Results.Ok(new { items = page, nextCursor = next });
});
```

`Cursor` ヘルパーは 2 つの値を URL セーフなトークンに詰めるだけで、呼び出し元がそれを不透明なものとして扱い、ページングのセマンティクスを改ざんできないようにします:

```csharp
// .NET 11, C# 14 - opaque cursor encode/decode
static class Cursor
{
    public static string Encode(DateTime createdAt, int id) =>
        Convert.ToBase64String(
            Encoding.UTF8.GetBytes($"{createdAt.Ticks}:{id}"));

    public static bool TryDecode(string? token, out DateTime createdAt, out int id)
    {
        createdAt = default;
        id = default;
        if (string.IsNullOrEmpty(token)) return false;

        var parts = Encoding.UTF8
            .GetString(Convert.FromBase64String(token))
            .Split(':');
        if (parts.Length != 2) return false;

        createdAt = new DateTime(long.Parse(parts[0]), DateTimeKind.Utc);
        id = int.Parse(parts[1]);
        return true;
    }
}
```

クエリ上の `AsNoTracking()` に注目してください。これらは読み取り専用のリスト行なので、変更トラッカーのコストを払う理由はありません。それがいつ重要になるかが分からない場合は、[EF Core 11 における AsNoTracking と AsNoTrackingWithIdentityResolution の違い](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)を参照してください。アクセスの多いリストエンドポイントでは、このクエリは[コンパイル済みクエリ](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)の有力な候補でもあります。リクエスト間で形が決して変わらないからです。

## インデックスは省略可能ではない

キーセットページネーションが速いのは、データベースがシークできる場合だけです。それには、キー列と方向が `OrderBy` と正確に一致するインデックスが必要です:

```csharp
// .NET 11, EF Core 11.0.0 - composite index matching the page order
modelBuilder.Entity<Post>()
    .HasIndex(p => new { p.CreatedAt, p.PostId })
    .IsDescending(true, true);
```

公式ガイダンスは[インデックスのセクション](https://learn.microsoft.com/en-us/ef/core/querying/pagination)でこれについて率直です: インデックスはページネーションの並べ替えに対応しなければなりません。`(CreatedAt DESC, PostId DESC)` で並べ替えているのに `(CreatedAt ASC, PostId ASC)` でインデックスを作ると、多くのデータベースはインデックスを逆方向にスキャンできますが、3 列目を加えたり方向が一致しなくなったりした瞬間に、プランナーはフィルター済みのセット全体に対するソートにフォールバックし、コスト一定のページは失われます。インデックスの方向は契約の一部であって、些細な詳細ではありません。これは、偶発的な [N+1 クエリ](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)と同じ種類の「クエリプランが頼んでいないことをしている」問題です: LINQ は問題なく見えるのに、プランが本当の話を語ります。だから、出荷する前に一度、実際の実行プランを確認してください。

## 生の SQL で見たことのあるタプル構文を使わない理由

手書きの SQL でキーセットページネーションを書いたことがあるなら、おそらく行値比較を使ったことがあるでしょう: `WHERE (CreatedAt, PostId) < (@ca, @id)`。これは同じ境界を表現するよりすっきりした方法であり、ほとんどのリレーショナルデータベースがサポートしており、展開された `OR` チェーンよりも良いプランを生成する傾向があります。EF Core 11 にとっての悪い知らせ: これは依然として LINQ で書けません。ドキュメントはこれを明示的に注記しており、[dotnet/efcore#26822](https://github.com/dotnet/efcore/issues/26822) で追跡されていますが、EF Core 11.0.0 の時点でも未解決のままです。したがって、上記の手動 `OR` 展開は次のバージョンで捨てる回避策ではありません。現在サポートされているアプローチそのものです。

3 列以上で並べ替える場合、`OR` チェーンは急速に大きくなり、間違えやすくなります。このパターンは機械的に一般化できます: 並べ替えキー `a, b, c` に対する述語は `a > a0 || (a == a0 && b > b0) || (a == a0 && b == b0 && c > c0)` です。キーが 2 つを超えたら、`MR.EntityFrameworkCore.KeysetPagination` のようなメンテナンスされているヘルパーに頼りましょう。これは同じ `OrderBy` 定義からこの式ツリーを構築し、`WHERE` をソートと同期させ続けてくれます。4 段重ねの `OR` チェーンを手書きすることが、`==` 分岐が落ちる原因です。

## 後ろ向きのページングとその他のエッジケース

ハッピーパスが動いたあとに人々を悩ませるものがいくつかあります:

- **前のページ。** 後ろ向きにページングするには、すべての比較とすべての `OrderBy` の方向を反転させ、1 ページ取得してから、返す前にメモリ内でリストを逆順にします。前向きのクエリを "before" カーソルと同じ並べ替えで再利用することはできません。行が間違った順序で返ってきてしまいます。
- **ユーザーにランダムアクセスはない。** キーセットページネーションは次と前をサポートしますが、「47 ページにジャンプ」はサポートしません。それはバグではなく本質的なものです。本当にページ番号ジャンプが必要なら、ドキュメントはハイブリッドを提案しています: 次/前にはキーセット、まれなランダムジャンプにだけオフセットを使います。ほとんどのフィードと無限スクロールはジャンプをまったく必要としません。
- **総数。** キーセットは行を返しますが、残りのページ数は返しません。UI に「200 ページ中 3 ページ目」が必要なら、その数は別の `COUNT(*)` クエリであり、大きなテーブルではしばしばそれが高コストな部分なので、キャッシュするか要件を落としましょう。
- **null 許容のソート列。** ソート列が null 許容の場合、`NULL` の比較は `>`/`<` のようには振る舞わず、`NULL` を持つ行がページングから消えることがあります。null 許容でない列でソートするか、明示的な `NULL` 順序の分岐を追加してください。
- **カーソルの安定性。** カーソルは値をエンコードするので、その周りで行が挿入または削除されても有効なままです。それこそが要点です。カーソルは、*それが指す行*が削除され、かつその行を読み戻すことに依存している場合には壊れます。値とだけ比較するのでそれは問題ありませんが、カーソルの行がまだ存在すると仮定してはいけません。

オフセットページネーションが常に間違っているわけではありません。小さな管理テーブルや、ユーザーが実際にページ番号をクリックするグリッドでは、`Skip`/`Take` のほうがシンプルで、パフォーマンスの差は目に見えません。テーブルが大きくなったり、追記が多くなったり、深くスクロールされたりした瞬間に、速さと正しさを保つのはキーセット版です。一意なキーで並べ替え、それに正確に一致する `WHERE` を組み立て、それらの列を同じ方向でインデックス化すれば、最も深いページが最初のページと同じコストになります。

## 関連記事

- [EF Core 11 でクエリ分割を使ってデカルト爆発を回避する方法](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)
- [EF Core 11 における AsNoTracking と AsNoTrackingWithIdentityResolution の違い](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [EF Core 11 で N+1 クエリを検出する方法](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [ホットパス向けに EF Core でコンパイル済みクエリを使う方法](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [EF Core 11 で IAsyncEnumerable を使う方法](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)

## ソース

- [Pagination - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/pagination)
- [Indexes - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/modeling/indexes)
- [Support row value comparisons for keyset pagination - dotnet/efcore#26822](https://github.com/dotnet/efcore/issues/26822)
- [MR.EntityFrameworkCore.KeysetPagination (GitHub)](https://github.com/mrahhal/MR.EntityFrameworkCore.KeysetPagination)
