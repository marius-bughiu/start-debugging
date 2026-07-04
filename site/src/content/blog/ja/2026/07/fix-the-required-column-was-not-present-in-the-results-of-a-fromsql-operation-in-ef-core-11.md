---
title: "修正: EF Core 11 の \"The required column 'X' was not present in the results of a 'FromSql' operation\""
description: "生の SQL がエンティティにマッピングされたすべての列を返さない、または名前が一致しないと EF Core はこの例外を投げます。一致する名前ですべてのマッピング列を返すか、スカラー型やキーレス型を照会してください。"
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
lang: "ja"
translationOf: "2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-04
---

EF Core は、`FromSql`、`FromSqlRaw`、`FromSqlInterpolated` に渡した生の SQL が、対象のエンティティ型がマッピングする列を返さないとき `The required column 'X' was not present in the results of a 'FromSql' operation` を投げます。マテリアライザーは結果をマッピング列の名前で読み取るため、各プロパティの列は EF が期待するとおりの綴りで結果セットに含まれていなければなりません。すべてのマッピング列を返す（`SELECT *` か、一致する別名を付けた明示的なリスト）ことで修正するか、部分集合や任意の形が欲しいだけなら、完全なエンティティではなく `Database.SqlQuery<T>` またはキーレスなエンティティ型に切り替えてください。これは .NET 11 上の `Microsoft.EntityFrameworkCore` 11.0、C# 14 に当てはまり、このルールは EF Core 3.0 以降変わっていません。

## エラーの文脈

完全な実行時例外は次のようになります。

```
System.InvalidOperationException: The required column 'Description' was not present in the results of a 'FromSql' operation.
   at Microsoft.EntityFrameworkCore.Query.Internal.RelationalCommandCache...
   at lambda_method(Closure, QueryContext, DbDataReader, ResultContext, ...)
```

例外の型は `System.InvalidOperationException` で、クエリを組み立てるときではなく、結果を読み取っている最中に投げられます。つまりスタックトレースは、あなたの SQL 文字列ではなく EF Core のマテリアライズ用パイプライン（`lambda_method` と `RelationalCommandCache`）を指します。唯一役に立つ情報は引用符で囲まれた列名 `'Description'` です。これは EF がリーダーの中で名前で探し、見つけられなかったマッピング列です。

## なぜ起きるのか

`FromSql` がマッピング済みのエンティティ型を返すとき、EF Core は列を序数の位置では読みません。名前で読みます。エンティティの各プロパティについて、EF は `DbDataReader` に「`Description` という名前の列の序数を教えてほしい」と要求し、リーダーにそのような列がなければその呼び出しが失敗し、EF はそれをこのエラーとして表面化させます。ドキュメントは制約を直接述べています。SQL クエリはエンティティ型のすべてのプロパティのデータを返さなければならず、結果セットの列名はプロパティがマッピングされている列名と一致しなければなりません。

頻度の高い順に、おおよそ三つの原因があります。

- **SELECT リストに列が欠けている。** `SELECT Id, Title FROM Articles` と書いたが、`Article` エンティティは `Description` プロパティもマッピングしている。EF は `Description` を求めているのに存在しない。
- **列名がマッピング名と一致しない。** SQL は `article_description`（あるいは別名のない式、またはスキャフォールディングされたストアドプロシージャの `Col2`）を返すが、プロパティは `Description` 列にマッピングされている。同じ失敗で、メッセージの引用符内の名前はあなたの SQL が生成した名前ではなく EF が求めた名前なので、メッセージが誤解を招くように感じられます。
- **シャドウ列や owned 型の列が欠けている。** CLR プロパティを持たない外部キー、`[Timestamp]`／rowversion の同時実行トークン、owned 型の列はすべてマッピングされており、すべて必須です。エンティティクラスからは見えないため忘れやすいものです。

これはバグではなく意図的な設計判断です。EF6 は生の SQL に対してプロパティと列のマッピングを無視し、プロパティ名で緩く照合していました。EF Core はこれを厳格にし、生のエンティティクエリが通常のクエリとまったく同じように振る舞い、安全に追跡・修正・合成できるようにしました。

## 最小の再現

これを再現する最小のプログラムです。エンティティは三つの列をマッピングし、SQL は二つを返します。

```csharp
// .NET 11, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new BlogContext();

// Throws: 'Description' is mapped but not in the SELECT list.
var articles = await db.Articles
    .FromSql($"SELECT Id, Title FROM Articles")
    .ToListAsync();

public class Article
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
}

public class BlogContext : DbContext
{
    public DbSet<Article> Articles => Set<Article>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Blog;Trusted_Connection=True;Encrypt=False");
}
```

EF Core は `Article` を三つの列 `Id`、`Title`、`Description` にマッピングします。`SELECT Id, Title` から戻ってくるリーダーにはそのうち二つしかないため、`ToListAsync` が行の読み取りを始めた瞬間に `'Description' was not present` でマテリアライズが失敗します。

## 修正の詳細

修正は最善（本物の完全なエンティティを返す）から、完全なエンティティが本当に欲しくないときに手を伸ばす代替手段の順に並べてあります。

### 1. マッピングされたすべての列を返す

追跡される `Article` エンティティを取り戻したいなら、SQL はエンティティがマッピングするすべての列を生成しなければなりません。最も単純で正しい形は、テーブル（または列が揃っているビュー／TVF）に対する `SELECT *` です。

```csharp
// .NET 11, EF Core 11 -- returns Id, Title, Description: all three mapped columns
var articles = await db.Articles
    .FromSql($"SELECT * FROM Articles")
    .ToListAsync();
```

ここで `SELECT *` が問題ないのは、まさに EF が名前で照合するからで、列の順序は関係なく、余分な列は無視されます。明示的なリスト（スキーマの変化に強く、コードレビューでも明快）を好むなら、マッピングされたすべての列を列挙し、どれも欠けていないことを確認してください。

```csharp
// .NET 11, EF Core 11 -- explicit, complete column list
var articles = await db.Articles
    .FromSql($"SELECT Id, Title, Description FROM Articles WHERE Title LIKE {'%' + term + '%'}")
    .ToListAsync();
```

「マッピングされたすべての列」には、明白な CLR プロパティを持たない列も含まれることを覚えておいてください。シャドウ外部キー、`RowVersion` の同時実行トークン、TPH 継承の判別子列などです。エンティティに `[Timestamp] public byte[] RowVersion` や継承の判別子があるなら、その列も結果セットに含まれていなければなりません。

### 2. 名前が一致するよう列に別名を付ける

SQL がマッピング名を直接使えないとき、たとえば `article_desc` を返すストアドプロシージャやレガシーテーブルの場合、EF が期待する名前になるよう出力列に別名を付けます。照合は大文字小文字を区別しませんが、名前は存在していなければなりません。

```csharp
// .NET 11, EF Core 11 -- alias legacy names onto mapped column names
var articles = await db.Articles
    .FromSqlRaw(@"SELECT article_id AS Id,
                         article_title AS Title,
                         article_desc AS Description
                  FROM legacy_articles")
    .ToListAsync();
```

SQL ではなくマッピングのほうを変えたいなら、`OnModelCreating` で `[Column("article_desc")]` または `HasColumnName("article_desc")` を使ってプロパティを実際の列名にマッピングします。すると `article_desc` を返す生の SQL が別名なしで一致します。どちらか一方を選んでください。両方で自分自身と戦ってはいけません。

### 3. `SqlQuery<T>` でスカラーまたは射影を照会する

いくつかのフィールドだけが欲しいなら、完全なエンティティを強いる必要はありません。`Database.SqlQuery<T>`（EF Core 7.0+、11.0 でも現行の API）は「すべてのマッピング列」ルールなしで任意の型を読み取ります。単一のスカラー列の場合。

```csharp
// .NET 11, EF Core 11 -- no entity involved, so no missing-column rule
var titles = await db.Database
    .SqlQuery<string>($"SELECT Title FROM Articles WHERE Id > {minId}")
    .ToListAsync();
```

複数列の形の場合は、プロパティ名が（場合によっては別名を付けた）結果列と一致するプレーンな record を宣言して照会します。この型はモデルの一部ではないため、EF は完全性について何も要求しません。

```csharp
// .NET 11, EF Core 11 -- lightweight read model, matched by name
public record ArticleSummary(int Id, string Title);

var summaries = await db.Database
    .SqlQuery<ArticleSummary>($"SELECT Id, Title FROM Articles")
    .ToListAsync();
```

`SqlQuery<T>` は結果を決して追跡しません。これは読み取り専用のサマリーにまさに必要なことです。部分的なエンティティが欲しいと気づいた瞬間に選ぶべき正しいツールです。

### 4. 結果をキーレスなエンティティ型としてモデル化する

アプリ全体で再利用する形、とくにビューやレポート用ストアドプロシージャの出力には、キーレスなエンティティ型を宣言します。これはモデルに参加する（そのため `Include` を使え、場合によっては上に合成できる）が、キーを持たず、決して追跡されません。`HasNoKey` で構成します。

```csharp
// .NET 11, EF Core 11 -- keyless type mapped to a reporting shape
public class ArticleStat
{
    public string Title { get; set; } = "";
    public int ViewCount { get; set; }
}

// in OnModelCreating:
modelBuilder.Entity<ArticleStat>().HasNoKey().ToView(null);

// query:
var stats = await db.Set<ArticleStat>()
    .FromSql($"SELECT Title, COUNT(*) AS ViewCount FROM Views GROUP BY Title")
    .ToListAsync();
```

キーレスなエンティティ型でも、自分自身のマッピング列が存在することは依然として要求されますが、そのマッピングはあなたが制御するので、完全なテーブルエンティティではなく、SQL が返す列にちょうど合わせてサイズを決められます。

## 注意点とバリエーション

**引用符で囲まれた列は、SQL に欠けている列ではありません。** EF は名前で照合するため、SQL が `Desc` を返しエンティティが `Description` をマッピングしていると、メッセージは `'Desc' was unexpected` ではなく `'Description' was not present` と言います。クエリが実際に返す列のリストとエンティティのマッピング列を比べ、名前が挙がった列が文字どおり存在しないと信じ込むのではなく、食い違いを探してください。まさにこの混乱が [dotnet/efcore issue #33748](https://github.com/dotnet/efcore/issues/33748) で追跡されています。

**スキャフォールディングされたストアドプロシージャは `Col1`、`Col2` を生成します。** ストアドプロシージャが名前のない計算列（`SELECT COUNT(*) AS Total` ではなく `SELECT COUNT(*)`）を返すと、リバースエンジニアリングツールはそれを `Col0`、`Col1` のように命名し、生成された結果型はそれらの名前を期待します。プロシージャ内で各列に明示的な別名を付ければ、問題は発生源で消えます。

**部分集合を射影するストアドプロシージャ。** `Id, Title` だけを返す `EXECUTE dbo.GetArticleTitles` は、完全な `Article` をマテリアライズできません。それを `context.Articles.FromSql` に通さず、`Database.SqlQuery<T>` かプロシージャが返すものに合わせたキーレス型に通してください。また、ストアドプロシージャの呼び出しの上に LINQ を合成することはできないので、メモリ内でさらに処理が必要なら `FromSql` の直後に `AsEnumerable()` を追加してください。

**owned 型とテーブル分割。** `Article` が同じテーブルに保存される `Address` のような値オブジェクトを所有している場合、owned 型の列はエンティティの一部であり、結果セットに含まれていなければなりません。それらを省くと、存在に気づいていないかもしれない列について同じエラーが出ます。それらを含めるか、読み取りをキーレスな射影に分けてください。

**EF6 からのアップグレード前は動いていた。** EF6 は生の SQL の結果をプロパティ名で照合し、欠けた列や名前の違う列に対して緩やかでした。EF Core は厳格です。その境界を越えてコードベースを移すなら、これは変わった生の SQL の挙動の一つであり、より広い [EF Core 6 から EF Core 11 への移行で実際に噛みついてくる破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)と一緒に扱われます。

**non-nullable 列の `NULL` は別のエラーです。** 列は存在するが値が `NULL` で、プロパティが non-nullable な値型なら、このエラーではなく `System.Data.SqlTypes.SqlNullValueException` か null 変換に関するマテリアライズエラーが出ます。それは形ではなくデータの問題です。プロパティを nullable にするか、SQL で `ISNULL`／`COALESCE` を使ってください。

このエラーから永久に抜け出すためのメンタルモデルはこうです。`DbSet<T>` に対する `FromSql` は、完全で正しく命名された `T` を返すという約束です。その約束を守れない、あるいは守りたくないなら、エンティティを使わないでください。スカラーやアドホックな record には `SqlQuery<T>` を、名前を付けて再利用する形にはキーレス型を使ってください。`context.Set<T>().FromSql` は、SQL が本当にエンティティ全体をハイドレートする場合のために取っておきましょう。

## 関連記事

- [修正: EF Core 11 の "The LINQ expression could not be translated"](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)：反対の道を進んで LINQ に留まるときに当たる兄弟エラーです。
- [EF Core のコンパイル済みクエリ vs 生の SQL vs Dapper](/ja/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)：今出会ったばかりの鋭い角に見合うほど生の SQL が価値を持つのはいつかを比較します。
- [EF Core 11 で JSON 列をマッピングして照会する方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)：結果の形とエンティティのマッピングが揃っていなければならないもう一つのケースを扱います。
- [EF Core 11 の AsNoTracking vs AsNoTrackingWithIdentityResolution](/ja/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)：生のエンティティクエリが動いた後、読み取りを安くしたいときに重要になります。
- [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)：EF が下手に生成したクエリへの答えとして生の SQL を使うときに一読の価値があります。

## 出典

- [生の SQL クエリ、EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)（"Limitations" セクションを参照：マッピングされたすべての列を返す必要があり、名前は一致していなければならない）
- [キーレスなエンティティ型、EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [RelationalDatabaseFacadeExtensions.SqlQuery、API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlquery)
- [dotnet/efcore issue #33748：間違った列に対する誤解を招く "missing column" テキスト](https://github.com/dotnet/efcore/issues/33748)
