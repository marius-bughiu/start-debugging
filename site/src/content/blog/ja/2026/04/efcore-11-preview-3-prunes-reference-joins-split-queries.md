---
title: "EF Core 11 が split query で不要な reference join を刈り込む"
description: "EF Core 11 Preview 3 は split query から冗長な to-one join を除去し、不要な ORDER BY キーを落とします。報告された一つのシナリオは 29% 速くなり、別のは 22% でした。今の SQL はこう見えます。"
pubDate: 2026-04-18
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "performance"
  - "csharp"
lang: "ja"
translationOf: "2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core の split query には常に鋭い角がありました: reference navigation の `Include` と collection navigation の `Include` を混ぜると、collection query 側で何も必要としていないのに、すべての子 query が reference テーブルを再 join していました。EF Core 11 Preview 3 はこれを修正し、関連する `ORDER BY` 過剰指定も一緒に直します。[release notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) は benchmark 影響を一般的な split-query シナリオで 29%、single-query ケースで 22% と計上します。LINQ の編集なしで本番に現れる類の変更です。

## 不要だった余分な join

定型を考えます: to-one の `BlogType` と to-many の `Posts` を持つブログを `AsSplitQuery()` でロード:

```csharp
var blogs = context.Blogs
    .Include(b => b.BlogType)
    .Include(b => b.Posts)
    .AsSplitQuery()
    .ToList();
```

split query は include された collection ごとに 1 つの SQL とルート query を実行します。ルート query は `BlogType` のカラムを投影するために正当に join が必要です。`Posts` の collection query はそうではありません。post のカラムしか投影しないからです。EF Core 10 以前もそれでも join を発行していました:

```sql
-- Before EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id], [b0].[Id]
FROM [Blogs] AS [b]
INNER JOIN [BlogType] AS [b0] ON [b].[BlogTypeId] = [b0].[Id]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id], [b0].[Id]
```

その余分な `INNER JOIN [BlogType]` は全行で解決され、ソートにも参加します。payload 的な理由はまったくありません。EF Core 11 はそれを刈り取ります:

```sql
-- EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]
```

`Include` に束ねた reference navigation が多いほど、消える join も多くなります。ドメインモデルが本物の collection と並んで小さな lookup (`Country`、`Status`、`Currency`) の `Include` に頼っているなら、これは本質的にタダのスループットです。

## ORDER BY 過剰指定も消える

2 つ目の最適化は single query にも適用されます。reference navigation を include すると、親の primary key が foreign key 経由ですでにそれを決定しているのに、EF は歴史的にその key を `ORDER BY` 節に発行していました:

```csharp
var blogs = context.Blogs
    .Include(b => b.Owner)
    .Include(b => b.Posts)
    .ToList();
```

EF Core 11 以前:

```sql
ORDER BY [b].[BlogId], [p].[PersonId]
```

EF Core 11 では:

```sql
ORDER BY [b].[BlogId]
```

`BlogId` は一意であり、`PersonId` は FK 経由で `BlogId` によって完全に決定されていたので、それを sort key に保持するのは純粋なコストでした。それを落とすと sort key が短くなり、それはテーブルが十分大きくなってディスクにスピルするようになったり、planner が結果上に merge join を選んだりするときに重要になります。

## いつ気づくか

最も大きな勝ちは、複数の小さな reference include と 1 つ以上の collection include を持つ query で見られます。そういった query はすべての子 query で同じ不要な join を繰り返していたからです。Customer-order、invoice-with-lines、blog-with-posts が明白な候補です。`AsSplitQuery()` なしの query や reference include なしの query は `ORDER BY` 簡略化は得られますが、join 刈り込みは得られません。

API 変更はなく、オンにするものもありません。EF Core 11.0.0-preview.3 (.NET 11 Preview 3 をターゲット) にアップグレードし、同じ LINQ を走らせると、生成される SQL がタイトになります。benchmark 詳細は [EF Core のトラッキング issue](https://github.com/dotnet/efcore/issues/29182) にあります。
