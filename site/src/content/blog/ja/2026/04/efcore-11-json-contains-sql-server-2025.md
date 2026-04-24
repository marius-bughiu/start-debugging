---
title: "EF Core 11 が SQL Server 2025 で Contains を JSON_CONTAINS に翻訳"
description: "EF Core 11 は JSON コレクションに対する LINQ Contains を SQL Server 2025 の新しい JSON_CONTAINS 関数に自動翻訳し、JSON インデックスを利用できるパス指定・モード指定クエリ向けに EF.Functions.JsonContains を追加します。"
pubDate: 2026-04-20
tags:
  - ".NET 11"
  - "EF Core 11"
  - "SQL Server"
  - "JSON"
  - "LINQ"
lang: "ja"
translationOf: "2026/04/efcore-11-json-contains-sql-server-2025"
translatedBy: "claude"
translationDate: 2026-04-24
---

SQL Server 2025 はネイティブの [`JSON_CONTAINS`](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql) 関数を追加し、EF Core 11 はそれに繋ぎ込むリリースです。コレクションを JSON カラムとして格納している人にとって 2 つのことが変わります: JSON コレクションに対する `Contains` が古い `OPENJSON` join ではなく直接翻訳されるようになり、JSON パスや特定の検索モードが必要なケースのために新しい `EF.Functions.JsonContains()` が追加されました。この作業は [EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md) の一部です。

## SQL Server 2025 の互換性レベルへのオプトイン

新しい翻訳は、プロバイダーが SQL Server 2025 と話していると分かったときだけ有効になります。プロバイダーオプションに `UseCompatibilityLevel(170)` を渡すことで設定します:

```csharp
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

互換性レベル 170 は SQL Server 2025 が報告する値です。それより低いレベルでは古い翻訳が使われ続けるので、実際にデータベースをアップグレードするまで省略しても安全です。

## Contains は今どう見えるか

クラシックな「タグを JSON 配列として」の形を取りましょう:

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<string> Tags { get; set; } = new();
}

modelBuilder.Entity<Blog>()
    .Property(b => b.Tags)
    .HasColumnType("json"); // SQL Server 2025 native JSON type
```

EF Core 10、または古い SQL Server ターゲットでは、このクエリ:

```csharp
var posts = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

は `OPENJSON` 翻訳を返し、相関サブクエリのように読めます:

```sql
WHERE N'ef-core' IN (
    SELECT [t].[value]
    FROM OPENJSON([b].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)
```

互換性レベル 170 の EF Core 11 は代わりにこれを発行します:

```sql
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

これが重要な理由は SQL の見た目だけではありません。`JSON_CONTAINS` は SQL Server 2025 で [JSON インデックス](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) を使える唯一の述語です。`CREATE JSON INDEX IX_Tags ON Blogs(Tags)` があるとき、`OPENJSON` パスは決してそれに触れませんが、EF 11 の翻訳は触れます。

リリースノートで指摘されている落とし穴が 1 つあります: `JSON_CONTAINS` は LINQ の `Contains` のようには NULL を扱わないため、EF は少なくとも片側が証明可能に non-nullable (null でない定数、または non-nullable なカラム) のときだけ新しい翻訳を選びます。両側が null になり得る場合、EF は `OPENJSON` にフォールバックし、既存の挙動を保ちます。

## パスや検索モードが必要なとき

`Contains` は「このスカラーが配列に含まれるか」のケースをカバーします。それ以外には、EF Core 11 が `EF.Functions.JsonContains(container, value, path?, mode?)` を公開します。古典的な例は、構造化された JSON ドキュメント内の特定パスにある値を検索することです:

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string JsonData { get; set; } = "{}"; // { "Rating": 8, ... }
}

var ratedEights = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

これは次のように翻訳されます:

```sql
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

スカラーな string カラム、JSON にマップされた複合型、そして `OwnsOne(... b.ToJson())` でマップされた owned 型と一緒に使えます。`= 1` との比較が重要です: `JSON_CONTAINS` は `bit` を返し、EF はそれを保つので、`WHERE ... AND JSON_CONTAINS(...) = 1` のような複合述語が JSON インデックスに対して SARGable のままになります。

これと [`EF.Functions.JsonPathExists`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) を組み合わせて「プロパティが存在するか」のチェックをすれば、生 SQL に降りずに JSON カラムクエリの大部分をカバーできます。EF Core 11 の翻訳の変更点の完全なリストは [What's New](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) ドキュメントにあります。
