---
title: "EF Core 11 で JSON カラムをマッピングしてクエリする方法"
description: "ComplexProperty(...).ToJson() でネストした型を単一の JSON カラムにマッピングし、EF Core 11 に SQL Server 2025 のネイティブ json データ型で保存させ、JSON_VALUE・JSON_CONTAINS・JSON_PATH_EXISTS に変換される LINQ でクエリします。"
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "json"
  - "sql-server"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/06/how-to-map-and-query-json-columns-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-23
---

短い答え: ネストしたデータを複合型としてモデル化し、`OnModelCreating` で `ComplexProperty(b => b.Details, d => d.ToJson())` を呼び出すと、EF Core 11 はオブジェクトグラフ全体を単一のカラムにマッピングします。SQL Server 2025 (互換性レベル 170) では、そのカラムは `nvarchar(max)` ではなくネイティブの `json` データ型になります。その後は通常の LINQ でクエリします。`Where(b => b.Details.Viewers > 3)` は `JSON_VALUE(... RETURNING int)` に変換され、`b.Tags.Contains("ef-core")` は `JSON_CONTAINS` に変換され、`EF.Functions.JsonPathExists(...)` はパスの存在を確認します。ドキュメント内への一括更新も、`ExecuteUpdateAsync` と SQL Server の `json` 型の `.modify()` 関数を通じて機能します。

この記事では、SQL Server 2025 を対象に、.NET 11 上の `Microsoft.EntityFrameworkCore` 11.0.0 を C# 14 とともに使用します。マッピング API はプロバイダーに依存しませんが、正確な SQL とネイティブの `json` 型は SQL Server 固有です。PostgreSQL と SQLite は同じ LINQ に対して独自の JSON 関数を使用します。

## カラムを JSON にマッピングする 2 つの方法と、なぜ今は一方が好まれるのか

EF Core はしばらく前から、ネストした .NET オブジェクトを単一の JSON カラムに格納できましたが、歴史的には唯一の方法は *所有エンティティ型* (owned): `OwnsOne(...).ToJson()` でした。これは今でも機能します。問題は、所有型は内部的にはエンティティ型であるため、ID と参照セマンティクスを持ち込み、それが予想外の形でコードに漏れ出すことです。

EF Core 10 から始まり 11 でさらに安定化された、推奨されるモデリングツールは *複合型* です。複合型はキーを持たず、ID を持たず、値セマンティクスを持ちます。これはまさに、行の中の JSON ドキュメントそのものです。型を `[ComplexType]` でマークする (または fluent に設定する) か、`ToJson()` を呼び出します。

```csharp
// .NET 11, EF Core 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    public string[] Tags { get; set; } = [];     // primitive collection
    public required BlogDetails Details { get; set; }
}

[ComplexType]
public class BlogDetails
{
    public string? Description { get; set; }
    public int Viewers { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .ComplexProperty(b => b.Details, d => d.ToJson());
}
```

ここでは 2 つのものが JSON になります。`Details` は `ToJson()` で要求したため JSON カラムになります。`Tags` は自動的に JSON カラムになります。EF はプリミティブのコレクション (`string[]`、`List<int>` など) を設定なしで JSON 配列カラムにマッピングします。これは EF Core 8 から存在する動作です。

## ネイティブの json データ型と、それが得られる条件

カラムの *型* は、EF を向ける先のデータベースに依存します。EF Core 10 と 11 では、プロバイダーを `UseAzureSql` で設定するか、SQL Server 互換性レベル 170 以上 (SQL Server 2025 が報告する値) で設定すると、EF はカラムを既定で `nvarchar(max)` ではなくネイティブの `json` データ型にします。

```csharp
// .NET 11, EF Core 11.0.0 - opt into the SQL Server 2025 json type
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

上記のモデルは次のテーブルを生成します。

```sql
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Tags] json NOT NULL,
    [Details] json NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
```

ネイティブの `json` 型は内容を検証し、テキストよりコンパクトに格納し、JSON インデックスをサポートします。最初に挙げておく価値のあるマイグレーションの注意点が 1 つあります。アプリケーションがすでに JSON を `nvarchar(max)` カラムに格納していて、互換性レベルを 170 に引き上げると、EF が次に生成するマイグレーションは *それらのカラムを自動的に `json` に変更します*。その準備ができていない場合は、カラム型を明示的に `nvarchar(max)` に固定するか、互換性レベルを 170 未満に保ちます。170 未満でもこの記事の内容はすべて機能します。データはテキストカラムに存在し、SQL は古い文字列ベースの JSON 関数を使うだけです。

## マッピングの設定、手順を追って

通常のクラスからクエリ可能な JSON カラムまでの、最小限で順序立った道筋を示します。

1. **ネストしたデータを `[ComplexType]` としてモデル化します。** ドキュメント内に欲しいプロパティを与えます。テーブル分割とは異なり、JSON にマッピングされる複合型の中ではコレクションが許可されます。
2. **`OnModelCreating` で `ToJson()` を呼び出します。** 単一のネストしたオブジェクトには `ComplexProperty(b => b.Details, d => d.ToJson())` を使います。ネストしたオブジェクトのコレクションには、コレクション型で `ComplexProperty` を使い、配列全体が 1 つのカラムにマッピングされます。
3. **ネイティブ型のために SQL Server 2025 を対象にします。** カラムが `nvarchar(max)` ではなく `json` になるように `UseCompatibilityLevel(170)` (または `UseAzureSql`) を設定します。
4. **マイグレーションを追加して適用します。** `dotnet ef migrations add AddBlogDetailsJson` の後に `dotnet ef database update` を実行します。生成された `CREATE TABLE` を調べて、カラム型が期待どおりであることを確認します。
5. **通常の LINQ でクエリと更新を行います。** 生の SQL も手動のシリアライズも不要です。以下のセクションは、各 LINQ の形がどう変換されるかを示します。

## LINQ でドキュメント内をクエリする

ここが、メモリ内でデシリアライズしなければならないシリアライズ済み blob の代わりに JSON カラムを使う価値を生む部分です。JSON の *内側* のプロパティでフィルタ、射影、並べ替えを行うと、EF はそれをサーバー側の JSON 関数に変換します。

ネストしたスカラーへのフィルタリングは、型付きの `RETURNING` 句を持つ `JSON_VALUE` を通して読み取ります。

```csharp
// .NET 11, EF Core 11.0.0
var popular = await context.Blogs
    .Where(b => b.Details.Viewers > 3)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) > 3
```

`RETURNING int` 句は、比較を文字列比較ではなくサーバー上で整数として行わせるものであり、正確かつインデックスに優しいものです。

### プリミティブのコレクションを検索する: Contains は JSON_CONTAINS になる

JSON 配列が値を含むかどうかを確認することは、最も一般的な JSON クエリです。SQL Server 2025 では、EF Core 11 は JSON で支えられたプリミティブのコレクションに対する `Contains` を新しい `JSON_CONTAINS` 関数に変換します。

```csharp
var tagged = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

これは古くて遅い `OPENJSON` ベースの変換を置き換え、`JSON_CONTAINS` は定義されていれば JSON インデックスを使えます。この変換については、それを有効にする互換性レベルの切り替えも含めて、[EF Core 11 と JSON_CONTAINS に関する記事](/2026/04/efcore-11-json-contains-sql-server-2025/)で詳しく扱いました。鋭い注意点が 1 つあります。`JSON_CONTAINS` は null を検索できないため、EF は片側が null 非許容であると証明できる場合 (null でない定数、または null 非許容のカラムや要素) にのみそれを出力します。それが判断できない場合は、クエリが正しい答えを返し続けるように `OPENJSON` 形式にフォールバックします。

### パスとモードを指定した検索: EF.Functions.JsonContains

ドキュメント内の特定のパスで検索する必要がある場合、または検索モードを指定する必要がある場合は、`EF.Functions.JsonContains()` を通じて `JSON_CONTAINS` を直接呼び出します。

```csharp
var rated = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

これは JSON 値、検索する値、そして任意でパスと検索モードを受け取ります。スカラーの文字列プロパティ、複合型、JSON にマッピングされた所有エンティティ型に対して機能します。

### そもそもこのパスは存在するか: EF.Functions.JsonPathExists

EF Core 11 で新しく登場した `EF.Functions.JsonPathExists()` は、JSON パスが存在するかどうかを確認し、SQL Server の `JSON_PATH_EXISTS` (SQL Server 2022 から利用可能) に変換されます。これは「ドキュメントにオプションのフィールドが設定されている行」のための適切なツールです。

```csharp
var withOptional = await context.Blogs
    .Where(b => EF.Functions.JsonPathExists(b.JsonData, "$.OptionalInt"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_PATH_EXISTS([b].[JsonData], N'$.OptionalInt') = 1
```

## ドキュメントを読み込まずにその中を更新する

JSON カラムへの書き込みには 2 つのモードがあります。馴染みのあるものは変更追跡です。エンティティを読み込み、ネストしたプロパティを変更し、`SaveChanges` を呼び出します。EF は更新されたドキュメントをシリアライズしてカラムに書き込みます。1 行ならこれで問題ありません。

興味深いものは、データベース内で直接行う一括更新です。EF Core 10 は JSON 向けの `ExecuteUpdateAsync` サポートを追加し、それは 11 に引き継がれます。上記の複合型マッピングがあれば、結果セット全体について JSON 内のカウンターを 1 回のラウンドトリップでインクリメントできます。

```csharp
await context.Blogs.ExecuteUpdateAsync(s =>
    s.SetProperty(b => b.Details.Viewers, b => b.Details.Viewers + 1));
```

SQL Server 2025 ではこれは `json` 型の `.modify()` 関数を使うため、サーバーはドキュメント全体を読んで再シリアライズするのではなく、その 1 つのプロパティだけをその場で書き換えます。

```sql
UPDATE [b]
SET [Details].modify('$.Viewers', JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) + 1)
FROM [Blogs] AS [b]
```

確固たる要件が 1 つあります。JSON への `ExecuteUpdate` は、型が *複合型* としてマッピングされている場合にのみ機能します。所有エンティティ型では機能しません。これは新しいコードで複合型を好むべき最も具体的な理由であり、[`ExecuteUpdate` とエンティティを読み込んでから SaveChanges を呼ぶこと](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)の間のより広いトレードオフもここに当てはまります。

## JSON カラムが TPT および TPC 継承で機能するようになった

EF Core 11 までは、複合型と JSON カラムは、テーブル分離 (TPT) またはテーブル個別 (TPC) 継承を使うエンティティ型では使えませんでした。その制限は 11 でなくなりました。基底型に JSON プロパティをマッピングし、それを階層全体で使えます。

```csharp
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Animal>()
        .UseTptMappingStrategy()
        .ComplexProperty(a => a.Details, b => b.ToJson());
}
```

本物の継承階層を持つドメインモデルを維持しているなら、これは TPT/TPC を保ちつつ、各エンティティの共有された構造化部分をドキュメントとしてモデル化できるようにする変更です。

## 噛みついてくるエッジケース

**所有型と複合型のセマンティクス。** 所有エンティティ型では、あるドキュメントを別のドキュメントに代入すること (`blog.BillingDetails = blog.ShippingDetails`) は例外をスローします。同じエンティティインスタンスを 2 回追跡できないためです。複合型は値で比較・代入されるため、代入は単にフィールドをコピーします。JSON にまだ所有型を使っているなら、複合型への移行はこの種のバグのカテゴリ全体を取り除きます。これは、不変の値の形に対する[EF Core 11 で record を正しく使う](/2026/04/how-to-use-records-with-ef-core-11-correctly/)規律とよく噛み合います。

**struct の複合型はまだコレクションに入れられません。** EF Core 10 は複合型に `struct` と `record struct` のサポートを追加しました。これはその値セマンティクスによく合います。しかし struct の複合型の *コレクション* は現在サポートされていません。ネストした型がリストの中にある場合はクラスを使ってください。

**オプションの複合型には必須プロパティが必要です。** JSON にマッピングされたオプション (null 許容) の複合型には、その型に定義された必須プロパティが少なくとも 1 つ必要です。そうでないと、EF はすべてが null のドキュメントと欠落したドキュメントを区別できません。

**nvarchar から json へのマイグレーションは自動です。** 互換性レベルを 170 に引き上げると、既存の `nvarchar(max)` JSON カラムは次のマイグレーションでネイティブの `json` 型に書き換えられます。本番に適用する前にそのマイグレーションを確認してください。すべての JSON カラムを一度に変更するスキーマ変更です。

**インデックス。** JSON インデックスは、`JSON_CONTAINS` とパス検索を大規模に高速化するものです。ネイティブの `json` 型は `CREATE JSON INDEX` をサポートしますが、プレーンテキストのカラムはサポートしません。JSON クエリがホットパスなら、ネイティブ型とインデックスは seek とフルスキャンの違いであり、これはクエリプランをめぐる[EF Core 6 から 11 へのマイグレーションの破壊的変更](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)で現れるのと同じ教訓です。

要約すると、`[ComplexType]` と `ToJson()` を選び、カラムが本物の `json` になるように SQL Server 2025 を対象にし、その後は LINQ でドキュメントをモデルの他の部分と同じように扱います。EF Core 11 はフィルタリング、配列の `Contains`、パスのチェック、さらには一括更新までもサーバー側の JSON 関数に変換するため、ドキュメントはクエリされるためだけにメモリへ往復する必要が決してありません。

## 出典

- [What's New in EF Core 11: complex types and JSON with TPT/TPC, JsonPathExists, JSON_CONTAINS](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: native json data type, complex types ToJson, ExecuteUpdate for JSON](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [SQL Server json data type and the modify() method](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type)
- [JSON_CONTAINS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql)
- [JSON_PATH_EXISTS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-path-exists-transact-sql)
</content>
