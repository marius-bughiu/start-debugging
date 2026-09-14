---
title: "修正: EF Core 11 のプロジェクションで InvalidOperationException: Nullable object must have a value が発生する"
description: "Select が SQL の NULL を null 非許容の int、decimal、DateTime に読み込もうとすると、EF Core はこの例外をスローします。メンバーを null 許容型にキャストして ?? default を付けるか、ナビゲーションを null チェックで保護してください。"
pubDate: 2026-09-14
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
  - "linq"
lang: "ja"
translationOf: "2026/09/fix-nullable-object-must-have-a-value-in-an-ef-core-11-projection"
translatedBy: "claude"
translationDate: 2026-09-14
---

EF Core が `InvalidOperationException: Nullable object must have a value` をスローするのは、`Select` 用に生成した SQL が、プロジェクションで null 非許容の値型 (`int`、`decimal`、`DateTime`、`Guid`、構造体) に代入している列に `NULL` を返したときです。よくある原因は、省略可能なナビゲーション (顧客のいない注文での `o.Customer.Rating`)、空のコレクションに対する `Max`/`Min`/`Average`、そして `DefaultIfEmpty` による結合の空の側から取り出した DTO 全体の 3 つです。修正方法は、null 許容性を LINQ 上で明示することです。null 許容型にキャストして (`(int?)o.Customer.Rating`) `?? 0` で既定値を与えるか、`o.Customer == null ? 0 : o.Customer.Rating` と書きます。以下の結果はすべて .NET 11 RC 1 上の `Microsoft.EntityFrameworkCore` 11.0.0-rc.1.26425.128 で計測し、EF Core 10.0.12 と比較したものです。1 つのケースは EF Core 11 で新しく発生します。JSON の複合コレクションをコレクションナビゲーションと一緒にプロジェクションするケースです。これは本物のリグレッションなので、専用のセクションで扱います。

## エラーが発生する状況

実行時に発生するケースでは、例外はコンパイル済みのシェイパーから送出され、あなたのコードやデータベースドライバーからではありません。そのため、スタックトレースは役に立たないように見えます。

```
System.InvalidOperationException: Nullable object must have a value.
   at lambda_method272(Closure, QueryContext, DbDataReader, ResultContext, SingleQueryResultCoordinator)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.Enumerator.MoveNext()
   at System.Collections.Generic.List`1..ctor(IEnumerable`1 collection)
```

`lambda_method` は、EF Core がプロジェクション用にコンパイルしたマテリアライザーです。各列を null 許容の値として読み取り、その後 `.Value` を呼び出して null 非許容のメンバーに格納します。列が `NULL` だと `Nullable<T>.Value` が例外をスローし、素の C# で `((int?)null).Value` を実行したときと同じメッセージが表示されます。クエリの変換は成功し、SQL の実行も成功しています。失敗したのは、行からオブジェクトへの変換です。

上位のフレームが ``System.Nullable`1.get_Value()`` and `SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension` である場合は、SQL が実行される前、つまりクエリのコンパイル時に失敗しています。`ToQueryString()` でさえ例外をスローします。これは後述の JSON 複合コレクションのセクションで扱う EF Core 11 のリグレッションです。

## この問題が起きる理由

LINQ to Objects と SQL では、「存在しない」の意味が異なります。C# では、null の `Customer` に対する `order.Customer.Rating` は `NullReferenceException` をスローし、`new List<decimal>().Max()` は `Sequence contains no elements` をスローします。SQL では、一致しない `LEFT JOIN` は `NULL` の列を生成し、0 行に対する `MAX` は `NULL` を返します。EF Core は SQL のセマンティクスに変換するため、データベース側では例外は発生しません。その後、`NULL` がそれを保持できない CLR メンバーに戻ってきます。

EF Core はすでに何か所かでこれを補っています。`Sum` は `COALESCE(..., 0)` で包まれ、サブクエリ内のスカラー `FirstOrDefault()` は `ISNULL` で包まれ、エンティティのマテリアライズではオブジェクトを構築する前にキー列がチェックされます。このエラーは、それらでカバーされない隙間で発生します。その隙間は、1 つの修正と 1 つのリグレッションを除けば、EF Core 10 と 11 で同じです。

## 最小限の再現コード

このモデルには、顧客が省略可能な注文と、注文が 1 件もない顧客 ("Bob") が 1 人含まれています。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (same model on EF Core 10.0.12)
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public int Rating { get; set; }
    public List<Order> Orders { get; set; } = [];
}

public class Order
{
    public int Id { get; set; }
    public decimal Total { get; set; }
    public int? CustomerId { get; set; }     // optional relationship
    public Customer? Customer { get; set; }
}

// seed: Ana (Rating 5) with one order, Bob with none, plus one guest order with CustomerId = null
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer!.Rating })
    .ToList(); // InvalidOperationException: Nullable object must have a value.
```

`!` は null 許容の警告を黙らせるだけで、実行時には何もしません。EF Core は単純な `LEFT JOIN` を生成します。

```sql
-- EF Core 11 RC 1, SQL Server provider, via ToQueryString()
SELECT [o].[Id], [c].[Rating]
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

ゲスト注文の行では `[c].[Rating]` が `NULL` になり、匿名型の `int Rating` はそれを受け取れません。名前付きの DTO (`new OrderDto { Rating = o.Customer!.Rating }`) や単独のスカラー (`Select(o => o.Customer!.Rating)`) も同じように失敗します。

## 修正方法 (推奨順)

### 1. null 許容型にキャストしてから既定値を選ぶ

最も一般的な修正で、SQL のコストも最も小さくなります。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = (int?)o.Customer!.Rating ?? 0 })
    .ToList(); // { Id = 1, Rating = 0 } | { Id = 2, Rating = 5 }
```

```sql
SELECT [o].[Id], ISNULL([c].[Rating], 0)
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

呼び出し側にとって「顧客がいない」と「評価が 0」が異なる意味を持つ場合は、`?? 0` を外して DTO のメンバーを `int?` にしてください。そうすれば違いが保たれ、たいていは 0 をでっち上げるよりも正直な表現になります。

### 2. ナビゲーションを明示的に保護する

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Orders
    .Select(o => new { o.Id, Rating = o.Customer == null ? 0 : o.Customer.Rating })
    .ToList();
```

EF Core は null チェックを結合先のキーに対するテストに変換します。メンバー自体が null 許容の列である場合でも、これが「結合が一致したか」を示す正しいシグナルになります。

```sql
SELECT [o].[Id], CASE
    WHEN [c].[Id] IS NULL THEN 0
    ELSE [c].[Rating]
END
FROM [Orders] AS [o]
LEFT JOIN [Customers] AS [c] ON [o].[CustomerId] = [c].[Id]
```

同じ省略可能なナビゲーションから複数のメンバーをプロジェクションする場合や、メンバーが文字列などの参照型で DTO のプロパティを null 以外にしたい場合は、この書き方を使ってください。

### 3. 空の可能性があるコレクションに対する集計

`Sum` は安全です。`Max`、`Min`、`Average` は安全ではありません。EF Core 11 RC 1 でも 10.0.12 でも同様です。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
db.Customers.Select(c => new { c.Name, Biggest = c.Orders.Max(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Avg = c.Orders.Average(o => o.Total) });      // throws for Bob
db.Customers.Select(c => new { c.Name, Sum = c.Orders.Sum(o => o.Total) });          // Bob = 0.0
db.Customers.Select(c => new { c.Name, Last = c.Orders.OrderBy(o => o.Id)
                                                .Select(o => o.Total).FirstOrDefault() }); // Bob = 0.0
```

生成された SQL を見ると理由がわかります。`Sum` には `COALESCE(SUM([o].[Total]), 0.0)` が付き、`FirstOrDefault` のサブクエリには `ISNULL((SELECT TOP(1) ...), 0.0)` が付きます。`MAX` と `AVG` はそのまま出力されます。修正方法は同じキャストで、集計のセレクター内で行います。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows = db.Customers.Select(c => new
{
    c.Name,
    Biggest  = c.Orders.Max(o => (decimal?)o.Total) ?? 0m,
    Smallest = c.Orders.Min(o => (decimal?)o.Total) ?? 0m,
    Avg      = c.Orders.Average(o => (decimal?)o.Total) ?? 0m,
}).ToList(); // Bob: 0, 0, 0
```

`c.Orders.Select(o => o.Total).DefaultIfEmpty().Max()` でも動作しますが、1 行だけの `SELECT 1 AS empty` 派生テーブルに対する `LEFT JOIN` にコンパイルされます。同じ結果を得るなら、null 許容へのキャストのほうが SQL は単純です。

### 4. DTO をプロジェクションする `DefaultIfEmpty` 結合

これは [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915) の形です。内側がエンティティではなくプロジェクションした DTO になっている、手動の左外部結合です。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows =
    (from o in db.Orders
     join c in db.Customers.Select(c => new CustomerDto { Id = c.Id, Rating = c.Rating })
         on o.CustomerId equals c.Id into cs
     from c in cs.DefaultIfEmpty()
     select new { o.Id, Customer = c })
    .ToList(); // throws on EF Core 11 RC 1 and 10.0.12
```

LINQ to Objects なら、ゲスト注文に対して `Customer = null` が得られます。一方 EF Core は、すべて `NULL` の列から `CustomerDto` を構築しようとします。エンティティを結合し、結合の後で null チェックを挟んで DTO を構築してください。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var rows =
    (from o in db.Orders
     join c in db.Customers on o.CustomerId equals c.Id into cs
     from c in cs.DefaultIfEmpty()
     select new
     {
         o.Id,
         Customer = c == null ? null : new CustomerDto { Id = c.Id, Rating = c.Rating }
     })
    .ToList(); // { Id = 1, Customer = null } | { Id = 2, Customer = CustomerDto 1 Rating=5 }
```

内側がエンティティであれば、EF Core はキー列をチェックして行が一致したかどうかを判断できます。単純にプロジェクションした DTO では、チェックする対象がありません。EF チームはまさにこのバリエーションを [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608) で追跡しており、まだオープンのままです。修正にはナビゲーション展開の作り直しが必要だとしています。

## EF Core 11 ですでに修正されたもの: `GroupBy` に対する `LeftJoin`

EF Core 11 で改善されたパターンが 1 つあります。グループ化した集計に対する `LeftJoin` (.NET 10 で追加された演算子です。[.NET 10 と 11 の LINQ の結合演算子](/ja/2026/06/linq-fulljoin-tuple-returning-joins-dotnet-11-preview-5/)を参照してください) で、[dotnet/efcore#38055](https://github.com/dotnet/efcore/issues/38055) として報告されたものです。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var counts = db.Orders.GroupBy(o => o.CustomerId, (k, g) => new { CustomerId = k, Count = g.Count() });

var rows = db.Customers
    .LeftJoin(counts, c => (int?)c.Id, g => g.CustomerId, (c, g) => new { c, g })
    .Select(x => new { x.c.Name, Count = x.g == null ? 0 : x.g.Count })
    .ToList();
// EF Core 10.0.12: InvalidOperationException: Nullable object must have a value.
// EF Core 11 RC 1: { Name = Ana, Count = 1 } | { Name = Bob, Count = 0 }
```

EF Core 11 では、内側のサブクエリに合成列を追加し、それを条件にオブジェクトを構築するようになりました。

```sql
SELECT [c].[Name], [o0].[CustomerId], [o0].[Count], [o0].[marker]
FROM [Customers] AS [c]
LEFT JOIN (
    SELECT [o].[CustomerId], COUNT(*) AS [Count], 1 AS [marker]
    FROM [Orders] AS [o]
    GROUP BY [o].[CustomerId]
) AS [o0] ON [c].[Id] = [o0].[CustomerId]
```

`[marker]` が `NULL` になるのは結合が一致しなかったときだけなので、`x.g == null` がようやく見た目どおりの意味を持つようになりました。これは [dotnet/efcore#38479](https://github.com/dotnet/efcore/pull/38479) (2026 年 6 月にマージ) で導入され、値型のプロジェクション ([#38555](https://github.com/dotnet/efcore/pull/38555)) と後続の結合 ([#38499](https://github.com/dotnet/efcore/pull/38499)) に対するフォローアップが続きました。いずれも 10.0.x にはバックポートされていません。EF Core 10 では、グループ化の中でキャストし (`Count = (int?)g.Count()`)、`x.g!.Count ?? 0` と読み取ってください。これは両方のバージョンで動作し、`ISNULL([o0].[Count], 0)` を生成します。

## EF Core 11 RC 1 のリグレッション: JSON 複合コレクションとコレクションナビゲーションの組み合わせ

これはデータの問題ではまったくありません。JSON にマッピングした複合コレクション (`ComplexCollection(...).ToJson()`。[EF Core 11 での JSON 列のマッピング](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)を参照してください) を、コレクションナビゲーションと同じ `Select` 内でプロジェクションすると、クエリのコンパイル中に例外がスローされます。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
modelBuilder.Entity<Parent>(e =>
{
    e.ComplexCollection(p => p.Items).ToJson();
    e.HasMany(p => p.Links).WithMany(l => l.Parents);
});

var dtos = db.Parents
    .Select(p => new ParentDto
    {
        Name = p.Name,
        Items = p.Items,                                  // JSON complex collection
        Links = p.Links.Select(l => l.Name).ToList(),     // collection navigation
    })
    .ToList();
// EF Core 10.0.12: works
// EF Core 11 RC 1: InvalidOperationException: Nullable object must have a value.
//   at System.Nullable`1.get_Value()
//   at ...SelectExpression.ClientProjectionRemappingExpressionVisitor.VisitExtension(Expression expression)
```

どちらも単独であれば動作します。`AsSplitQuery()` は役に立ちません。EF Core が分割方法を決める前に失敗するからです。これは [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928) で、11.0.0-preview.1 以降のリグレッションとしてラベル付けされています。修正である [dotnet/efcore#38932](https://github.com/dotnet/efcore/pull/38932) は 2026-09-09 に `main` へマージされました。`release/11.0` へのバックポート [#38948](https://github.com/dotnet/efcore/pull/38948) は 2026-09-14 の時点でまだオープンなので、RC 1 にはこのバグがあり、修正は今後の RC か GA に入る見込みです。それまでは、`Include` でエンティティを読み込んでメモリ上でマッピングするか、

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var dtos = (await db.Parents.Include(p => p.Links).AsNoTracking().ToListAsync())
    .Select(p => new ParentDto { Name = p.Name, Items = p.Items, Links = p.Links.Select(l => l.Name).ToList() })
    .ToList();
```

2 つのプロジェクション (JSON 列用に 1 つ、ナビゲーション用に 1 つ) を実行してキーでつなぎ合わせてください。どちらも RC 1 で動作します。`Include` 版は `Link` のすべての列を読み込むため、列の多いテーブルでは 2 クエリ版を使ってください。

## ここにたどり着く似たエラー

- **`The data is NULL at ordinal 1. This method can't be called on NULL values`** (SQLite) または **`SqlNullValueException: Data is Null`** (SQL Server): データベースでは null 許容なのに、null 非許容のプロパティにマッピングされている列です。データベースファーストのモデルやビューでよく見られます。プロバイダーが列を読み取る時点で例外をスローするため、EF Core のシェイパーには届きません。計測は SQLite でのみ行いました。修正すべきはモデルです。プロパティを `int?` にするか、列を修正してください。プロジェクション内の `(int?)p.Stock` も `(int?)p.Stock ?? -1` も役に立ちません (どちらも EF Core 11 RC 1 で例外をスローします)。EF Core はモデルを信頼し、`GetInt32` で列を読み取るからです。
- **`Sequence contains no elements`**: 同じ空集合の問題の LINQ to Objects 版か、メモリ上で実行された `First()`/`Single()` です。[専用の記事](/ja/2026/07/fix-invalidoperationexception-sequence-contains-no-elements/)を参照してください。
- **`An exception was thrown while attempting to evaluate a LINQ query parameter expression`** が `Nullable object must have a value` を包んでいる場合: これは、あなた自身の `maybe!.Value` が SQL の前にパラメーターとしてクライアント側で評価されたものです。[パラメーター評価の記事](/ja/2026/08/fix-an-exception-was-thrown-while-attempting-to-evaluate-a-linq-query-parameter-expression/)で扱っています。

## 問題の列をすばやく見つける

シェイパーのスタックトレースには、メンバー名が決して表示されません。すばやく見つける方法が 2 つあります。

1. `query.ToQueryString()` を呼び出し、`LEFT JOIN` や `OUTER APPLY` の null 許容側にある列、または単独の `MAX`/`MIN`/`AVG` サブクエリを探します。その他の方法は [EF Core 11 が生成する SQL のログ出力](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)で扱っています。
2. 一時的に、値型のメンバーすべてについてプロジェクションを `(int?)` / `(decimal?)` に変更して実行し、どれが `null` で返ってくるかを確認します。そのメンバーが修正すべき対象です。

`ToQueryString()` 自体が例外をスローする場合、問題はコンパイル時にあります。EF Core 11 RC 1 では、前述の JSON とナビゲーションの組み合わせに該当しないか確認してください。マテリアライズではなく変換が失敗している場合は、通常は別のメッセージが表示されます。それについては [「could not be translated」のガイド](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)で扱っています。

検証方法について: 上記の行数と例外はすべて、両方の EF Core バージョンでインメモリの SQLite に対してクエリを実行して得たものです。SQL Server の SQL は `ToQueryString()` で生成したもので、実行はしていません。例外をスローするマテリアライザーはプロバイダーに依存しないため、同じプロジェクションは SQL Server でもまったく同じように失敗しますが、この記事のために SQL Server インスタンスは実行していません。

## 参考資料

- [dotnet/efcore#38928](https://github.com/dotnet/efcore/issues/38928): JSON 複合コレクションとコレクションナビゲーションのリグレッション。修正は [#38932](https://github.com/dotnet/efcore/pull/38932)、バックポートは [#38948](https://github.com/dotnet/efcore/pull/38948)。
- [dotnet/efcore#30915](https://github.com/dotnet/efcore/issues/30915) と [#38055](https://github.com/dotnet/efcore/issues/38055): 左外部結合されたエンティティ以外のプロジェクション。[#38479](https://github.com/dotnet/efcore/pull/38479) で部分的に修正。
- [dotnet/efcore#38608](https://github.com/dotnet/efcore/issues/38608): 単純にプロジェクションした DTO での `DefaultIfEmpty` のバリエーションで、まだオープンのもの。
- [dotnet/efcore#33802](https://github.com/dotnet/efcore/issues/33802): 空のコレクションに対する集計の一貫しない動作。
- [dotnet/efcore#35950](https://github.com/dotnet/efcore/issues/35950): EF Core 9 の `DefaultIfEmpty` `COALESCE` のリグレッションで、EF Core 10 で修正済み。
- Microsoft Learn の [EF Core の複雑なクエリ演算子](https://learn.microsoft.com/ef/core/querying/complex-query-operators)。
