---
title: "EF Core 11 でストアドプロシージャを呼び出して結果をマッピングする方法"
description: "プロシージャがエンティティの全列を返す場合は DbSet の FromSql、射影を返す場合は Database.SqlQuery<T>、何も返さない場合は ExecuteSql を使います。EXEC に LINQ 演算子を連結してはいけません。また、リーダーが破棄される前に出力パラメーターを読んではいけません。"
pubDate: 2026-08-10
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "ja"
translationOf: "2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-10
---

手短に言うと、EF Core 11 にはストアドプロシージャを呼び出すための入口が 3 つあり、間違ったものを選ぶことがトラブルの大半の原因です。プロシージャがマッピング済みエンティティの全列を返す場合は `DbSet<T>` の `FromSql` を使います。エンティティではない射影を返す場合は `Database.SqlQuery<T>` を使います。これは EF Core 8 以降、任意の DTO に対して機能します。結果セットをまったく返さない場合は `Database.ExecuteSql` を使います。3 つすべてに共通する規則が 2 つあります。`EXEC` に LINQ 演算子を連結することはできません。そして出力パラメーターの `Value` は、基になるリーダーが破棄されるまで null のままです。

この記事では 3 つの API すべて、誤用したときに出る正確な例外、出力パラメーターと戻り値、複数の結果セット、そして多くの人が驚く追跡の挙動を扱います。

以下の内容はすべて、SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`) に対して EF Core 10.0.10 と .NET SDK 10.0.201 で計測しました。EF Core 11 は .NET 11 ランタイムを必要としますが、この環境にはインストールされていないためです。ただし今回はその点の影響はいつもより小さいです。EF Core 11 は `FromSql`、`SqlQuery`、`ExecuteSql` に一切変更を加えておらず、[EF Core 11 のリリースノート](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)にはストアドプロシージャに関する項目がまったくありません。ここで引用する例外メッセージと挙動は、EF Core 8、9、10、11 で同一です。計測ではなくドキュメントを出典とする記述については、その旨を明記します。

すべての例で使うスキーマです。

```sql
-- SQL Server 2022
CREATE TABLE Blogs (
    Id         int NOT NULL IDENTITY PRIMARY KEY,
    Name       nvarchar(200) NOT NULL,
    Rating     int NOT NULL,
    OwnerEmail nvarchar(200) NULL
);

CREATE PROCEDURE dbo.GetTopBlogs @MinRating int AS
BEGIN
    SET NOCOUNT ON;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs
    WHERE Rating >= @MinRating ORDER BY Rating DESC;
END
```

`SET NOCOUNT ON` に注目してください。これがないと SQL Server は結果セットの前に影響行数のメッセージを送り、一部のドライバーはそれを幻の空結果セットとして表面化させます。コストはゼロで、紛らわしいバグを丸ごと 1 種類防げます。

## プロシージャがエンティティの行を返す場合: FromSql

`FromSql` は `DbSet<T>` の拡張メソッドで、プロシージャの結果セットがマッピング済みエンティティと列単位で一致する場合に選ぶべき呼び出しです。

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .ToListAsync();
```

この補間の穴は文字列連結ではありません。`FromSql` は `FormattableString` を受け取り、すべての穴を `DbParameter` に変換するため、SQL インジェクションに対して安全です。実際に送られる内容は `ToQueryString()` で確認できます。

```text
DECLARE p0 int = 3;

EXEC dbo.GetTopBlogs @MinRating = @p0
```

EF は SQL をそのまま通しました。囲むサブクエリはありません。まさにこの点が次のセクションの理由になります。

結果は LINQ クエリとまったく同じように追跡された状態で返ります。3 行を返すプロシージャの呼び出し後、変更トラッカーに 3 つのエンティティがあることを計測しました。読み取り専用の経路では `AsNoTracking()` を付けます。SQL は何も変わらないため、ここでは問題なく動作します。

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsNoTracking()
    .ToListAsync();
```

省略可能なパラメーターを持つプロシージャで重要になる名前付きパラメーターの場合は、値を `SqlParameter` で包み、名前で参照します。

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("min", 3);

var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {minRating}")
    .AsNoTracking()
    .ToListAsync();
```

単一の `SqlParameter` インスタンスを連続する 2 回の実行で再利用することは可能です。パラメーターは 1 つのコマンドのコレクションにしか属せないという素の ADO.NET から受け継がれた通説に反しますが、同じインスタンスを 2 回続けて `FromSqlRaw` に通しても例外は出ませんでした。

### 結果セットにはマッピングされた全列が必要です

これは誰もが最初にぶつかる失敗です。プロシージャの `SELECT` から `OwnerEmail` を外すとクエリは死にます。

```text
InvalidOperationException: The required column 'OwnerEmail' was not present
in the results of a 'FromSql' operation.
```

EF はエンティティ全体をマテリアライズするため、リーダーはシャドウプロパティや識別子を含め、マッピングされたすべてのプロパティを供給しなければなりません。列名はプロパティ名ではなくマッピングされた列名と一致する必要があり、これは EF6 からの実質的な挙動変更です。順序は問われず、照合は大文字と小文字を区別しません。不足している列を返すようプロシージャを変更できないのであれば、それはエンティティを返していないということであり、代わりに `SqlQuery<T>` を使うべきです。この例外については[FromSql の列不足エラーの解説](/ja/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)でさらに詳しく書きました。

### EXEC の上に LINQ を合成することはできません

これが誰もが 2 番目にぶつかる点です。SQL Server はプロシージャ呼び出しをサブクエリに入れ子にできないため、SQL を変える演算子を足した瞬間に EF はあきらめます。

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .Where(b => b.Rating > 4)          // composition
    .ToListAsync();
```

```text
InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable
SQL and with a query composing over it. Consider calling 'AsEnumerable' after the
method to perform the composition on the client side.
```

同じ例外は `Include`、`OrderBy`、`Skip`/`Take`、そして裸の `First()` や `Single()` でも発生します。いずれも `TOP` または `ORDER BY` を付け足すからです。`Include` でも発生することを確認したので、プロシージャ呼び出しからナビゲーションを eager ロードすることはできません。

対処法はメッセージ自体が示しているとおりです。`FromSql` の直後に `AsEnumerable()` (または `AsAsyncEnumerable()`) を挟み、データベースがやることと自分のプロセスがやることの間に明示的な線を引きます。

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsEnumerable()                    // everything after this runs in memory
    .Where(b => b.Rating > 4)
    .ToList();
```

そのコストについては自分に正直であるべきです。プロシージャが返す行はすべてネットワークを越え、`Where` が走る前にマテリアライズされます。プロシージャが 200,000 行を返して 4 行だけ残すのであれば、フィルターはパラメーターとしてプロシージャの中に押し込んでください。`AsEnumerable` は正しさの修正であって、パフォーマンスの修正ではありません。

変更の追跡は `AsEnumerable` の後も引き続き適用されます。ここでつまずく人がいます。クライアント側の境界が動かすのはクエリ演算子だけで、マテリアライズは EF 側ですでに完了しています。`FromSql(...).AsEnumerable().ToList()` の後に、追跡されたエンティティが 3 つあることを計測しました。不要であれば `AsEnumerable()` の前に `AsNoTracking()` を付けてください。

対照的に、合成可能な `SELECT` は包まれてプッシュダウンされます。これこそが、プロシージャ以外の SQL に対して `FromSql` を本当に有用にしている点です。

```csharp
// .NET 11, C# 14, EF Core 11
var q = context.Blogs
    .FromSql($"SELECT * FROM Blogs WHERE Rating >= {3}")
    .Where(b => b.Name.StartsWith("S"));
```

```sql
SELECT [b].[Id], [b].[Name], [b].[OwnerEmail], [b].[Rating]
FROM (
    SELECT * FROM Blogs WHERE Rating >= @p0
) AS [b]
WHERE [b].[Name] LIKE N'S%'
```

違いはこれだけです。合成可能な SQL は `SELECT` で始まり、サブクエリ化に耐えます。`EXEC` は耐えません。

## プロシージャが射影を返す場合: SqlQuery&lt;T&gt;

現実のストアドプロシージャの多くはエンティティの行を返しません。結合、`GROUP BY`、いくつかの計算列といったレポートの形を返します。そうした場合、`Database.SqlQuery<T>` は結果セットを、モデルにまったく含まれていない素の CLR 型にマッピングします。このトピックの記事の多くはこの API をいまだにスカラー専用と説明していますが、それは EF Core 8 で[マッピング可能な任意の CLR 型](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types)へ拡張された時点で事実ではなくなりました。

```sql
CREATE PROCEDURE dbo.GetBlogStats @MinViews int AS
BEGIN
    SET NOCOUNT ON;
    SELECT b.Name AS BlogName, COUNT(p.Id) AS PostCount, SUM(p.Views) AS TotalViews
    FROM Blogs b JOIN Posts p ON p.BlogId = b.Id
    WHERE p.Views >= @MinViews
    GROUP BY b.Name;
END
```

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
    public int TotalViews { get; set; }
}

var stats = await context.Database
    .SqlQuery<BlogStat>($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`BlogStat` に `DbSet` は不要で、`OnModelCreating` への登録も属性も要りません。マッピングの挙動について確認した点は次のとおりです。

- **照合は位置ではなく列名で行われます。** 3 つの列を順序を入れ替えて返しましたが、各プロパティは正しく収まりました。
- **照合は大文字と小文字を区別しません。** `blogname` も `POSTCOUNT` も正しくバインドされました。
- **結果セットの余分な列は無視されます。** 4 つ目の `Surprise` 列を追加しても例外は出ませんでした。ドキュメントは型が「結果セットのすべての値に対応するプロパティを持たなければならない」と述べているにもかかわらずです。これに頼ってはいけません。契約ではなく未文書の挙動です。
- **列の不足は致命的です。** `SELECT` から `TotalViews` を外すと、エンティティの場合と同じ `The required column 'TotalViews' was not present in the results of a 'FromSql' operation.` が出ます。
- **null 非許容プロパティへの null は** `SqlNullValueException: Data is Null. This method or property cannot be called on Null values.` を投げます。プロパティを null 許容としてモデリングするか、SQL 側で `COALESCE` を使ってください。

結果の列名をプロパティ名に一致させられない場合は `[Column("...")]` を使います。

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    [Column("blog_name")]
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
}
```

合成不可の規則はここでも同一に適用されます。`EXEC` に対する `SqlQuery<T>(...).Where(...)` はまったく同じ合成不可の例外を投げ、`AsEnumerable()` が同じ対処法になります。

単一のスカラー値であれば、プリミティブ型を指定した `SqlQuery<T>` がそのまま機能します。

```csharp
// .NET 11, C# 14, EF Core 11
var count = (await context.Database
    .SqlQuery<int>($"EXEC dbo.GetBlogCount")
    .ToListAsync()).Single();
```

EF Core のドキュメントは、スカラーの `SqlQuery` では出力列に `AS Value` という別名を付けるよう指示しています。この要件はクエリの上に LINQ を合成する場合にのみ適用されます。EF が生成する外側の `SELECT` から参照するための名前が必要になるからです。合成なしのプロシージャ呼び出しに別名は不要で、別名のない `SELECT COUNT(*)` が問題なくバインドされることを確認しました。

### キーなしエンティティ型という代替手段

EF Core 8 より前は、エンティティではない結果の形をマッピングする唯一の方法がキーなしエンティティ型でした。その形がドメインの一部であり `DbSet` としてクエリしたい場合は、今でもこちらが優れた選択です。

```csharp
// .NET 11, C# 14, EF Core 11
protected override void OnModelCreating(ModelBuilder b)
{
    b.Entity<BlogStat>().HasNoKey().ToView(null);
}

var stats = await context.Set<BlogStat>()
    .FromSql($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`ToView(null)` は、その型に対応するテーブルが存在しないことを EF に伝えるので、マイグレーションがテーブルを作ろうとしません。キーなし型は決して変更追跡されません。3 行をマテリアライズした後のエントリ数がゼロであることを確認しました。単発のレポートには `SqlQuery<T>` を、その形をアプリ全体で使い回す場合や[プロシージャに加えて EF 生成のクエリ](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)も必要な場合はキーなし型を選んでください。

## プロシージャが何も返さない場合: ExecuteSql

書き込みだけを行うプロシージャには `ExecuteSql` を使います。返るのは影響を受けた行数であり、プロシージャが計算した値ではありません。

```csharp
// .NET 11, C# 14, EF Core 11
var rowsAffected = await context.Database
    .ExecuteSqlAsync($"EXEC dbo.BumpRatings @By = {1}");
```

`ExecuteSql` は `FromSql` と同様にパラメーター化します。SQL を動的に組み立てる必要がある場合の逃げ道が `ExecuteSqlRaw` です。これは[一括書き込みのための `ExecuteUpdate` と `ExecuteDelete`](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)とは別のツールで、あちらは自分で書いたものを呼ぶのではなく LINQ から SQL を生成します。

重要な注意点が 1 つあります。`ExecuteSql` は変更トラッカーの外で実行されます。データベース上で変更した行は、コンテキストがすでに読み込んでいるエンティティには反映されないため、その後の `SaveChanges` が古い値を上書きしてしまう可能性があります。読み込みの前に呼ぶか、後で対象のエントリに `Reload()` を実行してください。

## 出力パラメーターと、誰もが引っかかるタイミングの罠

結果セットと出力パラメーターの両方を返すプロシージャは、ページングでよく使われるパターンです。

```sql
CREATE PROCEDURE dbo.GetTopBlogsWithCount @MinRating int, @TotalCount int OUTPUT AS
BEGIN
    SET NOCOUNT ON;
    SELECT @TotalCount = COUNT(*) FROM Blogs;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs WHERE Rating >= @MinRating;
END
```

出力パラメーターには明示的な `SqlParameter` インスタンスと `FromSqlRaw` が必要です。`Direction` を自分で設定しなければならないからです。

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("MinRating", SqlDbType.Int) { Value = 3 };
var totalCount = new SqlParameter("TotalCount", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};

var blogs = await context.Blogs
    .FromSqlRaw("EXEC dbo.GetTopBlogsWithCount @MinRating, @TotalCount OUTPUT",
        minRating, totalCount)
    .ToListAsync();

var total = (int)totalCount.Value;   // only valid after ToListAsync
```

SQL テキスト中の `OUTPUT` キーワードに注目してください。これを省くと SQL Server はそのパラメーターを入力専用として扱い、黙って何も返しません。

ここからが、人々に半日を費やさせる部分です。`totalCount.Value` は `DbDataReader` が閉じられるまで `null` です。SQL Server が出力パラメーターの値を送出するのがそのタイミングだからです。直接計測した結果です。

```text
before enumeration:  total.Value = null
mid-enumeration:     total.Value = null
after dispose:       total.Value = 5
```

クエリを組み立てた次の行で `totalCount.Value` を読むと `null` が返り、キャストで `NullReferenceException` になります。読み取りは列挙が完了した後でなければなりません。`ToListAsync()`、`AsEnumerable()` に対する `First()`、`AsAsyncEnumerable()` に対する `await foreach` はいずれも機能します。どれもリーダーを破棄するからです。

その系はさらに厄介です。列挙子を取得したまま破棄しないと、2 つの障害が同時に起きます。

```csharp
// .NET 11, C# 14, EF Core 11 - do not do this
var e = context.Blogs
    .FromSqlRaw("EXEC dbo.ManyRowsWithCount @Total OUTPUT", total)
    .AsEnumerable().GetEnumerator();
e.MoveNext();                        // reader is open and never closed
```

`total.Value` は `null` のままになり、その `DbContext` に対する次のクエリが `InvalidOperationException: There is already an open DataReader associated with this Connection which must be closed first.` で失敗します。テスト中に偶然これを踏み、そのコンテキストに対する以降のクエリがすべて壊れました。手動で列挙する場合は `using` で包んでください。

## RETURN 値の取得、これは出力パラメーターとは別物です

T-SQL の `RETURN 42` は、出力パラメーターとも結果セットとも別の 3 つ目の経路です。素直なやり方は機能しません。

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
```

```text
SqlException: Must declare the scalar variable "@ret".
```

`ParameterDirection.ReturnValue` が解釈されるのはコマンドが本物の `CommandType.StoredProcedure` である場合だけで、EF は常に `CommandType.Text` を送ります。機能する方法は 2 つあります。単純なのは、パラメーターを `Output` として宣言し、`EXEC @ret =` の構文にバインドさせる方法です。

```csharp
// .NET 11, C# 14, EF Core 11
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};
var by = new SqlParameter("By", SqlDbType.Int) { Value = 1 };

context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
var returnValue = (int)ret.Value;   // 42
```

もう 1 つは EF の接続上で素の `DbCommand` まで降りる方法です。こちらは `CommandType.StoredProcedure` も得られるため、本物の `ReturnValue` サポートが使えます。

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.BumpRatings";
cmd.CommandType = CommandType.StoredProcedure;
cmd.Parameters.Add(new SqlParameter("@By", SqlDbType.Int) { Value = 1 });
var ret = new SqlParameter("@ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
cmd.Parameters.Add(ret);

await cmd.ExecuteNonQueryAsync();
var returnValue = (int)ret.Value;   // 42
```

どちらも 42 を返しました。他の理由で `CommandType.StoredProcedure` が必要でない限り、前者を使ってください。接続を自分で開いた場合、EF は閉じてくれないことを忘れないでください。

## 複数の結果セットは今もサポートされていません

プロシージャが 2 つの結果セットを返す場合、EF は最初のものを読み、残りを黙って捨てます。例外も警告もありません。ブログと投稿の両方を返すプロシージャを `FromSql` で呼んだところ、ブログ 3 件が返り、投稿 5 件は捨てられました。

[FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127) は 2017 年 4 月から開いたままで Backlog マイルストーンにあり、EF Core 11 でも実現しません。回避策は素の `DbDataReader` と `NextResult()` です。

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.TwoResultSets";
cmd.CommandType = CommandType.StoredProcedure;

await using var reader = await cmd.ExecuteReaderAsync();

var blogs = new List<Blog>();
while (await reader.ReadAsync())
    blogs.Add(new Blog { Id = reader.GetInt32(0), Name = reader.GetString(1) });

await reader.NextResultAsync();

var posts = new List<Post>();
while (await reader.ReadAsync())
    posts.Add(new Post { Id = reader.GetInt32(0), Title = reader.GetString(2) });
```

これはブログ 3 件と投稿 5 件を正しく分けて返しました。EF のマテリアライズと追跡は失われるので、追跡が必要なら結果を手動でアタッチしてください。ここまで手作業が増えるなら、Dapper の `QueryMultiple` に頼るのも妥当です。そのトレードオフは[コンパイル済みクエリと生 SQL と Dapper の比較](/ja/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)で計測したとおりです。

## 挿入、更新、削除をプロシージャにマッピングする

ここまでの内容はすべてクエリの話です。その逆方向、つまり `SaveChanges` に `INSERT`/`UPDATE`/`DELETE` を生成させる代わりに自分のプロシージャを呼ばせる機能は、EF Core 7 で追加され 11 でも変わっていない別個の機能です。

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.Entity<Person>()
    .InsertUsingStoredProcedure(
        "People_Insert",
        spb =>
        {
            spb.HasParameter(p => p.Name);
            spb.HasResultColumn(p => p.Id);
        })
    .DeleteUsingStoredProcedure(
        "People_Delete",
        spb =>
        {
            spb.HasOriginalValueParameter(p => p.Id);
            spb.HasRowsAffectedResultColumn();
        });
```

これに踏み切る前に、ドキュメントから 2 点を知っておく価値があります。パラメーターはプロシージャ定義に現れるのと同じ順序で宣言しなければなりません。EF は常に名前ではなく位置で呼び出すからです。また、更新と削除のプロシージャではキー値に対して元の値のパラメーターが必須です。この経路はデータベースに対して実行していないので、このサンプルはドキュメント由来として扱ってください。

EF チームは自らのリリースノートでこの機能について率直に述べています。ストアドプロシージャのマッピングをサポートすることは、ストアドプロシージャを推奨することを意味しません。

## 適切な API の選び方

プロシージャがエンティティの完全な行を返すなら、`DbSet` の `FromSql` を使い追跡を受け入れます。射影を返すなら、素の DTO を使った `Database.SqlQuery<T>`、あるいはその形を使い回すならキーなしエンティティ型を使います。何も返さないなら `ExecuteSql` です。複数の結果セットや必要な `RETURN` 値を返すなら `DbCommand` まで降ります。

どれを選ぶにせよ、フィルターしたくなった時点で呼び出しの後に `AsEnumerable()` を置き、出力パラメーターは列挙が終わってからだけ読んでください。この 2 つの規則で、このトピックの質問のほとんどは片が付きます。

## 関連記事

- [Fix: 必要な列が FromSql 操作の結果に存在しませんでした](/ja/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [EF Core のコンパイル済みクエリと生 SQL と Dapper の比較](/ja/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Fix: EF Core 11 で LINQ 式を変換できませんでした](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [EF Core 11 が生成する SQL をログに出力する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [EF Core 11 で一括書き込みに ExecuteUpdate と ExecuteDelete を使う方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)

## 出典

- [SQL Queries, EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [Raw SQL queries for unmapped types, EF Core 8 の新機能](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types)
- [Keyless entity types, EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [Stored procedure mapping, EF Core 7 の新機能](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/whatsnew#stored-procedure-mapping)
- [EF Core 11 の新機能](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [dotnet/efcore#8127, FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127)
- [RelationalStrings.FromSqlNonComposable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationalstrings.fromsqlnoncomposable)
