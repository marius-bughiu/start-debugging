---
title: "解決: EF Core 11 で \"The LINQ expression could not be translated\""
description: "EF Core 11 は、Where や OrderBy が SQL に変換できないメソッドを呼び出すとこれをスローします。予測を変換可能な演算子で書き直すか、先に AsEnumerable でデータをクライアントに取り込みましょう。"
pubDate: 2026-07-04
template: error-page
tags:
  - "errors"
  - "efcore"
  - "dotnet"
lang: "ja"
translationOf: "2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-04
---

EF Core 11 は、最後の `Select` の外側にあるクエリの一部（通常は `Where`、`OrderBy`、`GroupBy`、`Join`）が、データベースプロバイダーが SQL に変換できないメソッドを呼び出したり構文を使ったりすると、`The LINQ expression could not be translated` をスローします。EF が変換できる演算子（`==`、`Contains`、`StartsWith`、`EF.Functions.*`）で予測を書き直すか、本当にメモリ内のロジックが必要な場合は、変換できないステップの前に `AsEnumerable()`、`AsAsyncEnumerable()`、`ToList()`、`ToListAsync()` を呼び出して、意図的にクライアント評価を強制することで修正します。これは .NET 11 上の C# 14 における `Microsoft.EntityFrameworkCore` 11.0 に当てはまり、この動作は EF Core 3.0 以降変わっていません。

## エラーの全体像

完全な実行時例外は次のようになります。EF Core はつまずいた正確な式ツリーを出力しますが、これは画面全体で最も有用な手がかりです。

```
System.InvalidOperationException: The LINQ expression 'DbSet<Order>()
    .Where(o => o.CustomerName.Equals(
        name,
        StringComparison.OrdinalIgnoreCase))' could not be translated. Either rewrite the query in a form that can be translated, or switch to client evaluation explicitly by inserting a call to 'AsEnumerable', 'AsAsyncEnumerable', 'ToList', or 'ToListAsync'. See https://go.microsoft.com/fwlink/?linkid=2101038 for more information.
```

例外の型は `System.InvalidOperationException` で、クエリを組み立てるときではなく、実行するとき（`ToList`、`First`、`foreach`、`await`）にスローされます。そのため、スタックトレースは実際に原因となった `Where` ではなく、リポジトリやコントローラーの行を指すことがよくあります。スタックトレースではなく、引用された式を読んでください。

## なぜこれが起きるのか

EF Core は、クエリのできるだけ多くの部分を単一の SQL ステートメントに変換し、データベースサーバー上で実行します。バージョン 3.0 以降、部分的なクライアント評価はちょうど 1 か所だけでサポートされます。それはトップレベルの射影、つまり最後の `Select` 呼び出しです。クエリの他の部分、つまり `Where`、`OrderBy`、`Skip`、`GroupBy`、`Join`、あるいはネストされたサブクエリのいずれかに、変換できない式が含まれていると、テーブル全体をだまってメモリに読み込んでそこでフィルタリングすることを拒否します。代わりに例外をスローします。

この意図的な拒否は機能です。EF Core 3.0 より前は、フレームワークは変換できない `Where` をクライアント上で喜んで評価していました。つまり、安価に見えるクエリがだまって 100 万行をダウンロードして、あなたのプロセス内でフィルタリングしかねなかったのです。現在の動作は、開発時の目立つ例外と引き換えに、あなたが決して目にすることのない一連の本番パフォーマンス災害を防ぎます。このエラーに遭遇したとき、EF Core はあなたが書いた予測に SQL 相当のものが存在しないと伝えているのです。

よくあるきっかけは次のとおりです。

- SQL マッピングのない C# メソッドの呼び出し（独自のヘルパー、`StringComparison` を伴う `string.Equals`、`Enum.HasFlag`、`MidpointRounding` を伴う `decimal.Round`）。
- クエリ内でのフォーマットやパース（`DateTime.ToString("yyyy-MM-dd")`、`int.Parse`、`Guid.Parse`）。
- プロバイダーがマッピングできない型へのナビゲーションや呼び出し（マッピングされた列ではなく、C# のロジックに支えられた計算プロパティ）。
- あなたのデータベースでプロバイダーがサポートしない構文との比較（一部の `TimeSpan` 演算、一部の `Span` ベースの API）。

## 最小限の再現

これがそれを再現する最小のプログラムです。`StringComparison` オーバーロードによる大文字小文字を区別しない照合は、実世界で最もよくある原因です。なぜなら C# では完璧に読めるのに、まったく変換できないからです。

```csharp
// .NET 11, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();

string name = "acme";

// Throws at ToListAsync: StringComparison has no SQL translation.
var orders = await db.Orders
    .Where(o => o.CustomerName.Equals(name, StringComparison.OrdinalIgnoreCase))
    .ToListAsync();

public class Order
{
    public int Id { get; set; }
    public string CustomerName { get; set; } = "";
    public DateTime PlacedOn { get; set; }
}

public class ShopContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

`Equals(name, StringComparison.OrdinalIgnoreCase)` の呼び出しが問題です。SQL における大文字小文字の区別は、メソッドの引数ではなく列の照合順序（collation）によって決まるため、EF Core は「序数、大文字小文字を区別しない」を SQL として表現する方法を持ちません。そのため例外をスローします。

## 解決策の詳細

解決策は、最良のもの（作業をサーバー上に残す）から最後の手段（意図的にデータをメモリに取り込む）まで順に並べています。

### 1. 変換可能な演算子で予測を書き直す

90 パーセントの場合、解決策は EF Core が知っている演算子を使って同じ意図を表現することです。大文字小文字を区別しない比較では、`StringComparison` オーバーロードを完全に捨てます。SQL Server ではデフォルトの照合順序がすでに大文字小文字を区別しないので、単純な `==` が望みどおりに動作し、きれいな `WHERE` に変換されます。

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] = @name
var orders = await db.Orders
    .Where(o => o.CustomerName == name)
    .ToListAsync();
```

列の照合順序に関係なく大文字小文字を区別しない比較が必要な場合は、`EF.Functions.Collate` を使って比較を大文字小文字を区別しない照合順序に固定します。プロバイダーはこれを `COLLATE` 句に変換します。

```csharp
// .NET 11, EF Core 11 -- explicit case-insensitive comparison in SQL
var orders = await db.Orders
    .Where(o => EF.Functions.Collate(o.CustomerName, "SQL_Latin1_General_CP1_CI_AS") == name)
    .ToListAsync();
```

`EF.Functions` の面はまさにこのために存在します。`Like`、`Collate`、`DateDiffDay`、`Contains`（全文）、`Random`、そしてプロバイダー固有のヘルパーは、素の C# では表現できない SQL 構文を提供します。サーバー評価をあきらめる前に、これに手を伸ばしてください。部分文字列の一致には、いずれも `LIKE` に変換される `Contains`、`StartsWith`、`EndsWith` を優先します。

```csharp
// .NET 11, EF Core 11 -- translates to WHERE [o].[CustomerName] LIKE @p + '%'
var orders = await db.Orders
    .Where(o => o.CustomerName.StartsWith(name))
    .ToListAsync();
```

### 2. クエリの中ではなく、クエリの前に値を計算する

これらのエラーの大きな割合は自業自得です。結果が実際には行に依存しないメソッドを、クエリの中で呼び出しているのです。それをローカル変数に引き上げれば、EF Core はそれをパラメーターに変換します。

```csharp
// Throws: ToString() on a DateTime cannot be translated
var bad = await db.Orders
    .Where(o => o.PlacedOn.ToString("yyyy") == "2026")
    .ToListAsync();

// Fixed: compare the mapped column directly, no formatting in SQL
var year = 2026;
var good = await db.Orders
    .Where(o => o.PlacedOn.Year == year)
    .ToListAsync();
```

`DateTime.Year`、`Month`、`Day`、`Date` などは実際に変換されます（SQL Server では `DATEPART` に）が、`ToString(format)` は変換されません。経験則としては、値全体を文字列にフォーマットしてそれで比較するのではなく、EF がマッピングできるプロパティで必要なデータを取り出すことです。

### 3. クライアント専用のロジックをトップレベルの射影に移す

EF Core は最後の `Select` でクライアント評価を許可することを思い出してください。変換できないメソッドが実際にはフィルタリングではなく出力の整形に関するものなら、そこに移しましょう。このクエリは SQL でフィルタリングと並べ替えを行い、その後、返ってきた行に対してのみ C# のヘルパーを実行します。

```csharp
// .NET 11, EF Core 11 -- filter in SQL, format on the client in the projection
var rows = await db.Orders
    .Where(o => o.PlacedOn.Year == 2026)      // server
    .OrderByDescending(o => o.PlacedOn)        // server
    .Select(o => new
    {
        o.Id,
        Display = FormatCustomer(o.CustomerName) // client, allowed here
    })
    .ToListAsync();

static string FormatCustomer(string raw) => raw.Trim().ToUpperInvariant();
```

`FormatCustomer` は `Where` の中では例外をスローしますが、最後の `Select` の中では合法で、すでにフィルタリングされた結果セットに対してメモリ内で実行されます。これが SQL のフィルタリングと C# のフォーマットを組み合わせる正規の方法です。

### 4. 意図的にクライアント評価を強制する（最後の手段）

ロジックが本当に SQL で実行できず、`Where` の中に置く必要がある場合は、`AsEnumerable` または `AsAsyncEnumerable` でクエリを分割することで、明示的にクライアント評価を選びます。分割より前のすべてはサーバー上で実行され、後のすべてはメモリ内で実行されます。

```csharp
// .NET 11, EF Core 11 -- narrow in SQL first, then filter in memory
var orders = db.Orders
    .Where(o => o.PlacedOn.Year == 2026)   // runs in SQL, cuts the row count down
    .AsAsyncEnumerable();                    // boundary: client evaluation from here

var matched = new List<Order>();
await foreach (var o in orders)
{
    if (o.CustomerName.Equals(name, StringComparison.OrdinalIgnoreCase))
        matched.Add(o);
}
```

重要な点は、転送する行数を最小限にするために、できるだけ多くのフィルタリングを `AsEnumerable` の境界より前に置くことです。むき出しの `DbSet` に対して `AsEnumerable()` を呼び出し、その後でフィルタリングすると、テーブル全体がダウンロードされます。これはまさに例外があなたを守っていた災害です。中間結果をバッファリングするのではなくストリーミングするために、ここでは `ToList` より `AsAsyncEnumerable` を優先してください。

## 落とし穴とバリエーション

**EF Core 2.2 では動いていたのに、アップグレードで壊れた。** どこでもクライアント評価できる機能は EF Core 3.0 で削除されました。以前「動いていた」クエリは、おそらくずっとメモリ内でフィルタリングしていました。アップグレードはあなたのクエリを壊したのではなく、潜在的なパフォーマンスの問題を明るみに出したのです。メジャーバージョン間を移行しているなら、始める前に[EF Core 6 から EF Core 11 への移行で実際に痛手となる破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)を読む価値があります。

**in-memory プロバイダーは例外をスローせず、本物はスローします。** ユニットテストが in-memory プロバイダーを使っていると、すべてをクライアント上で評価するのでこのエラーを決して見ず、その後、本番の SQL Server や PostgreSQL に対して同じクエリで例外をスローします。変換を行うプロバイダーに対してテストしてください。Testcontainers のようなもので本物のデータベースに対してテストスイートを実行すれば、出荷前にこうしたケースを捕まえられます。

**SQL が集約できないものに射影する `GroupBy`。** `GroupBy` の後に、（`Count`、`Sum`、`Max` のような集約ではなく）生のグループ化されたエンティティを返す `Select` が続くと、しばしば変換できません。射影をスカラー集約に作り直すか、マテリアライズした後にクライアント上でグループ化してください。

**ナビゲーションプロパティとマッピングされていない計算メンバー。** C# の計算プロパティ（マッピングされた列ではなく、ロジックを持つゲッター）に対するフィルタリングは、背後に列がないため変換できません。永続化された列や計算列をマッピングするか、代わりに基となる列でフィルタリングしてください。

**大きなローカルリストに対する `Contains`。** `Where(o => ids.Contains(o.Id))` は実際に変換されます（EF Core 11 では `IN` またはテーブル値パラメーターに）が、要素の型が複雑な場合には関連する "could not be translated" が現れることがあります。`Contains` の引数はスカラーの単純なリストに保ってください。

**別のエラー、同じきっかけ。** `The LINQ expression could not be translated` が表示され、そのすぐ下に `AsSplitQuery` に関する注記がある場合、それはクライアント評価の問題ではなく、複数のコレクション include を含むクエリでの変換の限界に達しています。それはデカルト積の爆発に関するもので、解決策は予測の書き直しではなく、[EF Core 11 でデカルト積の爆発を避けるためのクエリ分割](/ja/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)です。

このエラーから永久に遠ざけてくれるメンタルモデルはこうです。最後の `Select` を除くすべては SQL にならなければなりません。`Where` を書く前に、データベースがそれを実行できるかを自問してください。答えがデータベースの聞いたことのない C# メソッドを伴うなら、`EF.Functions` の相当物を見つけるか、値を事前計算するか、あるいは行をメモリに取り込んでいることを受け入れて `AsAsyncEnumerable` で明示的にそう述べてください。

## 関連記事

- [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)は、クライアント評価のブロックを生き延びる、もう一つの静かなクエリパフォーマンスの罠を扱います。
- [EF Core 11 の AsNoTracking と AsNoTrackingWithIdentityResolution](/ja/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)は、読み取りクエリがきれいに変換され、それを速くしたくなったときに読む価値があります。
- [EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)は、マテリアライズしてフィルタリングする代わりに、JSON の予測をサーバー上に保つ方法を示します。
- [ホットパスのために EF Core でコンパイル済みクエリを使う方法](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)は、クエリが変換可能になり、スループットを調整しているときに役立ちます。
- [EF Core 11 で一括書き込みに ExecuteUpdate と ExecuteDelete を使う方法](/ja/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)は、作業をメモリ内ではなくデータベース内に保つ、書き込み側の相当物です。

## 出典

- [クライアント評価とサーバー評価、EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [クエリの仕組み、EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/querying/how-query-works)
- [データベース関数と EF.Functions、EF Core ドキュメント](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/functions)
- [dotnet/efcore issue #24318: in-memory プロバイダーでの "could not be translated"](https://github.com/dotnet/efcore/issues/24318)
