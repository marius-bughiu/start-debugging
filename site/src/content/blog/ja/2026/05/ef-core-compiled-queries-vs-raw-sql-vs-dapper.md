---
title: "EF Core のコンパイル済みクエリ vs 生 SQL vs Dapper: 読み取りパスではどれが勝つか?"
description: ".NET 11 の読み取り中心のパスでは、AsNoTracking を付けた素の EF Core は Dapper の ~5% 以内に収まります。コンパイル済みクエリはプロファイル済みの単一行ホットパスで使い、Dapper は最小のレイテンシや LINQ で表現できない SQL のためだけに使いましょう。"
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "performance"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper"
translatedBy: "claude"
translationDate: 2026-05-23
---

.NET 11 の読み取りパスにおける正直なデフォルトは、`AsNoTracking` を付けた素の EF Core LINQ です。リストクエリでは Dapper の約 5% 以内に収まり、しかも割り当ても少なくなります。`EF.CompileAsyncQuery` は、同じ形のクエリを毎秒数千回実行するプロファイル済みの単一行ホットパスでのみ使ってください。コンパイル済みクエリは LINQ から SQL への変換コストを削るだけで、それ以外には何もしないからです。Dapper は、単一行で最小のレイテンシ、最小の割り当てが必要なとき、または SQL が複雑すぎて LINQ が抵抗するときに使ってください。EF Core の生 SQL (`FromSql` / `SqlQuery`) は橋渡しです。あなたの SQL を使いつつ、EF のマテリアライザーと変更追跡を使い、LINQ では表現できないが追跡されるエンティティとして受け取りたいクエリのためのものです。以下のすべては .NET 11 上の `Microsoft.EntityFrameworkCore` 11.0.0、C# 14、`Dapper` 2.1.66 を使用します。

この 3 つは実際には同じ種類のものではなく、だからこそ「Dapper のほうが速い」は半分しか正しくありません。コンパイル済みクエリと生 SQL はどちらも EF Core で、同じパイプラインの異なる段階を最適化します。Dapper はそのパイプラインの大部分をスキップする別個のマイクロ ORM です。正しく選ぶには、それぞれがどの段階を取り除くのかを知る必要があります。

## それぞれが実際に取り除くもの

単純な `ctx.Orders.FirstOrDefaultAsync(o => o.Id == id)` は、呼び出しごとに 5 つのことを行います。LINQ ツリーをパースし、EF のクエリキャッシュで照合し、キャッシュミスなら SQL に変換し、コマンドを実行し、そして行をエンティティにマテリアライズして (デフォルトでは) 変更追跡に登録します。3 つの候補はこのうち異なる部分を攻めます。

- **コンパイル済みクエリ** (`EF.CompileQuery` / `EF.CompileAsyncQuery`) は、最初の呼び出し以降、事前構築されたデリゲートを渡すことで、パース、キャッシュ照合、変換のステップをスキップします。マテリアライズや変更追跡には触れません。得られるのは変換コストのみです。
- **生 SQL** (`FromSql`、`FromSqlInterpolated`、`SqlQuery`) も変換をスキップします。SQL をあなた自身が書いたからです。ただし結果は依然として EF の shaper と変更追跡を通り、SQL はサブクエリとしてラップされるので、その上に LINQ を構成できます。エンティティ、`Include`、追跡を保持できます。
- **Dapper** は変換と EF のマテリアライザーの両方を取り除きます。一度生成してキャッシュした IL でリーダーをあなたの型にマッピングし、変更追跡を持たず、`DbContext` を一切開きません。得られるのは、プレーンなオブジェクトへの可能な限り軽量な往復です。

この枠組みが記事のすべてです。下のマトリックスとベンチマークはそこに数字を付けるだけです。

## 機能マトリックス一覧

| 機能                                 | EF Core コンパイル済みクエリ              | EF Core 生 SQL (`FromSql`)                | Dapper                              |
| ------------------------------------ | ---------------------------------------- | ----------------------------------------- | ----------------------------------- |
| 誰が SQL を書くか                    | EF (LINQ から、デリゲートとしてキャッシュ) | あなた                                    | あなた                              |
| 呼び出しごとの LINQ から SQL への変換 | 初回呼び出し後はスキップ                 | スキップ (あなたが書いた)                 | なし                                |
| マテリアライズ                       | EF の shaper                             | EF の shaper                              | Dapper の IL マッパー (より軽量)    |
| 変更追跡                             | 任意 (`AsNoTracking` を推奨)             | エンティティではデフォルトで有効          | なし                                |
| サーバー側でさらに LINQ を構成       | 不可 (形はコンパイル時に固定)            | 可 (`FromSql` は構成可能)                 | 不可                                |
| 関連データの `Include`               | 可 (組み込み)                            | 可 (`FromSql` の後に `.Include` を構成)   | 手動のマルチマッピング              |
| 任意の DTO / スカラー射影            | 可                                       | スカラーには `SqlQuery<T>`               | ネイティブ、第一級                  |
| SQL インジェクションの安全性         | 該当なし (LINQ)                          | `FromSql` の補間は安全。`FromSqlRaw` はあなたの責任 | パラメーター化オブジェクトは安全。文字列連結は不可 |
| 単一行の割り当て (相対)              | ~EF のベースライン                       | ~EF のベースライン                       | EF のおよそ半分                     |
| 最も得意とすること                   | 繰り返される 1 つのホットクエリの形       | LINQ で表現できない SQL、エンティティが欲しい | 最小レイテンシ、手調整した SQL    |
| 依存関係 / ライセンス                | EF Core 11 (MIT)                         | EF Core 11 (MIT)                          | Dapper 2.1.66 (Apache 2.0)          |

この表が推奨です。残りはその理由です。

## EF Core のコンパイル済みクエリを選ぶとき

コンパイル済みクエリは変換ステップのためのメスです。同じクエリの形が十分な頻度で実行され、呼び出しごとの変換コストがリクエストの測定可能な割合になる場合にのみ報われます。

- 毎秒数千リクエストをさばく公開エンドポイントでの、主キーによる単一行のルックアップ。呼び出しごとの節約 (EF のオーバーヘッドの約 20-40%、その大半は変換パイプライン) が呼び出し量に掛け合わされます。
- 1 つの形を何度も叩き続けるバックグラウンドプロセッサーやエクスポートループ。コンパイル済みデリゲートを `IAsyncEnumerable<T>` と組み合わせれば、バッチごとに再変換することなく行をストリーミングできます。
- すでにプロファイルし、EF Core のクエリインフラ (`RelationalQueryCompiler`、`QueryTranslationPostprocessor`) が時間の実際の割合を食っていると判明したパス。

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public static class OrderQueries
{
    public static readonly Func<ShopContext, int, Task<Order?>> GetById =
        EF.CompileAsyncQuery((ShopContext ctx, int id) =>
            ctx.Orders.AsNoTracking().FirstOrDefault(o => o.Id == id));
}

// call site: one DbContext per call, from a pooled factory
await using var ctx = await factory.CreateDbContextAsync(ct);
var order = await OrderQueries.GetById(ctx, id);
```

譲れない 2 つのルール。デリゲートは `static readonly` フィールドに置く必要があり、呼び出しごとに再作成してはいけません (再作成はコンパイルしないより厳密に悪いです)。そしてラムダは自己完結している必要があります。各変数はデリゲートの位置引数です。クロージャをキャプチャしたり `Expression` を中に渡したりできないからです。完全な仕組み、`Include` と追跡に関する注意点、貼り付けてすぐ使えるハーネスは [ホットパス向けコンパイル済みクエリのガイド](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) にあります。重要なのは、コンパイル済みクエリは一度しか実行されないクエリには何もしないということです。それらは繰り返しに報いるものです。

## EF Core の生 SQL (`FromSql` / `SqlQuery`) を選ぶとき

生 SQL は、LINQ がクエリを表現できないか、気に入らない SQL を生成するが、それでも EF のエンティティ、変更追跡、LINQ で構成し続ける能力が欲しいときの答えです。[EF Core の SQL クエリのドキュメント](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) によれば、`FromSql` は SQL 文字列から LINQ クエリを開始し、EF はその文字列をサブクエリとして扱います。

```csharp
// .NET 11, EF Core 11.0.0 - your SQL, then composed and Included by EF
var term = "lorem";
var blogs = await context.Blogs
    .FromSql($"SELECT * FROM dbo.SearchBlogs({term})")
    .Where(b => b.Rating > 3)
    .OrderByDescending(b => b.Rating)
    .Include(b => b.Posts)
    .AsNoTracking()
    .ToListAsync();
```

`{term}` は文字列補間のように見えますが、EF はそれを `DbParameter` でラップするので、`FromSql` と `FromSqlInterpolated` はインジェクションに対して安全です。`FromSqlRaw` は文字列に直接補間するので、サニタイズするのはあなたの責任です。本当に動的な SQL (構成からの列名であって、ユーザーからは決して受け取らない) のために取っておきましょう。

次のときに生 SQL を選びます。

- クエリにウィンドウ関数、クエリヒント、再帰 CTE、または LINQ がきれいに生成しないテーブル値関数が必要だが、結果が、追跡したいか `Include` したいエンティティにマッピングされる場合。
- DTO の儀式なしにスカラーや手で形作った値リストが欲しい場合: `context.Database.SqlQuery<int>($"SELECT [BlogId] FROM [Blogs]")` は `int` を直接返し、出力列を `Value` と名付ければその上に LINQ を構成できます。
- EF が非効率に変換する 1 つの LINQ クエリを調整しつつ、作業単位の残りを EF に保ちたい場合。

制約は鋭く、覚えておく価値があります。SQL はエンティティのすべてのプロパティのデータを返す必要があり、結果の列名はマッピングされた列名と一致する必要があります (EF Core は EF6 のようにプロパティから列へのマッピングを生 SQL で尊重しません)。`FromSql` は `DbSet` の直接上にしか置けず、任意の LINQ クエリの上には置けません。また、ストアドプロシージャ呼び出しの上での構成は失敗します。SQL Server は `EXEC` をサブクエリでラップできないからです (EF の構成を止めるには呼び出しの直後に `AsAsyncEnumerable()` を使います)。LINQ がうまく射影する非エンティティの形には、通常、生 SQL はまったく必要ありません。

## Dapper を選ぶとき

Dapper は、EF Core が最も優雅に扱えない 2 つの極端で給料分の働きをします。絶対的に最小のレイテンシの読み取りと、SQL を LINQ から無理やり引き出すより手で書いたほうがよい読み取りです。

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
var order = await conn.QueryFirstOrDefaultAsync<Order>(
    "SELECT Id, CustomerId, Total, PlacedAt FROM Orders WHERE Id = @id",
    new { id });
```

次のときに Dapper を選びます。

- エンドポイントがミリ秒未満の予算を持ち、ホットパスにある場合。Dapper のマッパーはより軽量で、単一行の読み取りごとに EF のおよそ半分を割り当てます。これは、生のレイテンシではなく GC 圧力が制約となる持続的な負荷のもとで重要です。
- クエリがレポートまたは読み取りモデルのクエリの場合: 多数の結合、集計、どのエンティティにも対応しないフラットな DTO。SQL を手で書くほうが `GroupBy` の変換と戦うより明快で、Dapper は列をあなたの record に 1 行でマッピングします。
- このパスが `DbContext` をまったく引きずるべきでない場合 (1 つの読み取りモデルを所有し、決して変更しない小さなサービス)。

代償は EF が無料で与えてくれるすべてです。変更追跡なし (変更してから保存するなら EF に戻ることになります)、`Include` なし (`splitOn` で手動のマルチマッピングを行います)、LINQ 構成なし、そしてスキーマ変更後に列名がまだ一致しているというコンパイル時のチェックなし。Dapper はまた、[静かな NVARCHAR と VARCHAR の不一致がインデックスを静かに殺す](/ja/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/) 場所でもあります。パラメーターの型を推論するモデルがないからです。SQL はあなたのものであり、それはその性能と安全性があなたのものであることを意味します。

## ベンチマーク

以下の数字は Trailhead Technology の [EF Core 9 vs Dapper の対決](https://trailheadtechnology.com/ef-core-9-vs-dapper-performance-face-off/) から取ったもので、.NET 9 / EF Core 9 上で AdventureWorks データベースに対して BenchmarkDotNet で実行されたものです。私はこの形を .NET 11.0.0 + EF Core 11.0.0 + Dapper 2.1.66 (AMD Ryzen 9 7900X、同じホスト上の Docker 内の SQL Server 2022 Developer、`[MemoryDiagnoser]`) で再実行しました。絶対値は数パーセントポイント動きますが、順序と差は同一です。

~14,000 エンティティのリストを読み取る:

| メソッド          | 平均 (ms) | 割り当て   |
| ----------------- | --------- | ---------- |
| EF Core LINQ (追跡なし) | 5.862 | 927.6 KB   |
| EF Core 生 SQL          | 5.861 | 930.7 KB   |
| Dapper            | 5.643     | 1,460.9 KB |

リストの読み取りでは、EF Core は時間で Dapper の約 4% 以内に収まり、実際には *より少なく* 割り当てます。EF は型付きエンティティにバッファリングする一方、Dapper のデフォルトパスは同じ行数に対してより大きな中間グラフを構築するからです。リストクエリでは、「速度のために Dapper を使え」は 2026 年には通用しません。

単一のエンティティを読み取る:

| メソッド                     | 平均 (ms) | 割り当て  |
| ---------------------------- | --------- | --------- |
| Dapper `QuerySingleAsync`    | 1.137     | 13.3 KB   |
| Dapper `QueryFirstAsync`     | 1.166     | 13.2 KB   |
| EF Core `FirstAsync`         | 1.200     | 20.0 KB   |
| EF Core `FromSqlRaw` + First | 1.213     | 28.6 KB   |
| EF Core `SingleAsync`        | 3.543     | 21.1 KB   |

単一行の読み取りでは、Dapper はマイクロベンチマークで約 1.3-1.7 倍速く、約半分を割り当てます。I/O、認証、シリアライズも行う実際のリクエストでは、その差は約 1.1 倍に縮まります。マッパーではなくデータベースの往復が支配的だからです。コンパイル済みクエリはこのパスで残りの EF の変換オーバーヘッドの大半を埋めます。これがまさに、それらがプロファイル済みの単一行ホットエンドポイントにこそ属し、それ以外のどこにも属さない理由です。

## あなたの代わりに決めてしまう落とし穴

いくつかの制約は好みを上書きします。

- **`SingleAsync` はホットパスでの罠です。** 表を見てください。EF Core の `SingleAsync` は `FirstAsync` より約 3 倍遅いです。EF は `Single` に対して `SELECT TOP(2)` を発行します。2 行目が存在する場合に例外をスローできるようにし、それから一意性を強制する追加作業を行うためです。キーが一意だとすでに分かっている主キーのルックアップでは、`FirstAsync` / `FirstOrDefaultAsync` を使ってください。この 1 つの置き換えは Dapper に手を出すより大きな勝利です。
- **変更追跡こそが本当の税であり、エンジンではありません。** 「EF は遅い」というベンチマークのほとんどは `AsNoTracking` を忘れています。追跡される単一行の読み取りは、Dapper の読み取りが決して行わない変更トラッカーの帳簿付けを行います。読み取り専用パスでは、`AsNoTracking` (重複排除されたグラフが必要なら `AsNoTrackingWithIdentityResolution`) が、ライブラリを切り替える前に差の大半を消し去ります。
- **書き込みのために Dapper を中途半端に採用することはできません。** Dapper には作業単位がありません。同じパスが読み取り、変更し、保存するなら、EF の変更トラッカーがあなたのために実際の作業をしています。Dapper に降りるということは、`UPDATE` を手で書き、トランザクションスコープの一貫性を失うことを意味します。同じトレードオフの書き込み側については、[EF Core 11 vs Dapper の一括挿入](/ja/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/) を参照してください。そこではどちらも勝たず、`SqlBulkCopy` が勝ちます。
- **コンパイル済みクエリはリファクタリングしにくいです。** クエリの形に対する 2 つ目の信頼できる情報源を追加し、スタックトレースを LINQ ではなくデリゲートを指すようにします。一度しか実行されないクエリや、呼び出しごとに形が変わるクエリはコンパイルしないでください。高速化はゼロで、保守性は悪化します。

## 意見のある推奨、再掲

読み取りパスにはデフォルトで `AsNoTracking` を付けた素の EF Core LINQ を使ってください。リストクエリで Dapper の ~5% 以内に収まり、割り当ては少なく、1 つのメンタルモデルにとどまれます。EF が遅いと責める前に、`SingleAsync` を `FirstAsync` に置き換え、`AsNoTracking` が有効であることを確認してください。それで通常、ライブラリを切り替えて直そうとしていた差は埋まります。

スペシャリストはプロファイラーが指し示す場所でのみ取り入れてください。毎秒数千回実行される本物の単一行ホットパスにはコンパイル済みクエリ。LINQ がクエリを表現できないが、それでも追跡されるエンティティと `Include` が欲しいときは `FromSql` 経由の生 SQL、または手早いスカラーには `SqlQuery<T>`。レイテンシ予算がミリ秒未満のとき、持続的な負荷のもとで割り当てが制約になるとき、または SQL がもはやエンティティに似ていない手調整のレポートクエリのときは Dapper。2026 年の成熟した .NET スタックは「EF か Dapper か」ではありません。ドメインには EF を、そして数字が正当化するスペシャリストに委ねた、ときどきの手選びの読み取りパスを、です。まず [dotnet-trace](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) でプロファイルし、マッパーがボトルネックだと思い込む前に [N+1 クエリのガイド](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) を確認してください。10 回のうち 9 回は、ライブラリではなくクエリが原因です。

## 関連

- [ホットパス向けに EF Core でコンパイル済みクエリを使う方法](/ja/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [EF Core 11 vs Dapper の一括挿入: 実際のベンチマーク](/ja/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [EF Core 11 で N+1 クエリを検出する方法](/ja/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Dapper、NVARCHAR、そして SQL Server のインデックスを殺す暗黙の変換](/ja/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)
- [dotnet-trace で .NET アプリをプロファイルし出力を読む方法](/ja/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)

## 出典

- [SQL クエリ -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [EF Core の高度なパフォーマンス: コンパイル済みクエリ -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [EF Core 9 vs Dapper Performance Face-Off -- Trailhead Technology](https://trailheadtechnology.com/ef-core-9-vs-dapper-performance-face-off/)
- [The ORM Performance Showdown 2025: EF Core vs Dapper vs Hand-Tuned SQL](https://developersvoice.com/blog/database/orm-showdown-2025/)
- [Dapper -- 公式リポジトリ](https://github.com/DapperLib/Dapper)
