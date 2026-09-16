---
title: "SQL Server 互換性レベル 150 vs 160: EF Core 11 のクエリで何が変わるのか"
description: "EF Core 11 では UseSqlServer の既定の互換性レベルが 160 になり、LEAST、GREATEST、2 引数の LTRIM/RTRIM が SQL に入るようになりました。すべての Take(n).FirstOrDefault() も対象です。SQL Server 2022 以降なら 160 のままにし、SQL Server 2019 がまだ動いている環境が一つでもあれば UseCompatibilityLevel(150) で固定してください。"
pubDate: 2026-09-16
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries"
translatedBy: "claude"
translationDate: 2026-09-16
---

結論から言うと、アプリが接続するすべてのデータベースが SQL Server 2022 以降で動いているなら、EF Core 11 の新しい既定値である互換性レベル 160 をそのまま使ってください。このレベルでは `Math.Min`/`Math.Max`、`EF.Functions.Least`/`Greatest`、インライン配列の `Min`/`Max`、連続した `Take` 呼び出しが `LEAST`/`GREATEST` に変換され、`TrimStart(char)`/`TrimEnd(char)` は 2 引数の `LTRIM`/`RTRIM` に変換されます。SQL Server 2019 がまだ動いている環境が一つでもあるなら、アップグレード前に `UseCompatibilityLevel(150)` を呼び出してください。160 では `.Take(pageSize).FirstOrDefaultAsync()` のようなごく普通のクエリが `SELECT TOP(LEAST(@p, 1))` になり、SQL Server 2019 には `LEAST` がありません。

以下の内容はすべて、.NET 11 RC 1 SDK (11.0.100-rc.1.26425.128) と C# 14 上の `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 で確認し、比較用の変更前の状態は SDK 10.0.302 上の 10.0.12 で確認しました。両バージョンが生成する SQL を比較しています。実際の SQL Server に対しては実行していないため、サーバー側の挙動は SQL Server のドキュメントに基づいており、リンクを下に載せています。

## 150 と 160 の比較一覧

| LINQ の形 (EF Core 11) | レベル 150 (EF Core 10 の既定) | レベル 160 (EF Core 11 の既定) |
| --- | --- | --- |
| `Where` / `OrderBy` 内の `Math.Max(a, b)` | "could not be translated" で例外 | `GREATEST([a], [b])` |
| 最終的な `Select` 内の `Math.Min(a, b)` | クライアントで評価 | サーバー上で `LEAST([a], [b])` |
| `Where` 内の `EF.Functions.Greatest(a, b, c)` | "could not be translated" で例外 | `GREATEST([a], [b], [c])` |
| `new[] { a, b }.Max()` | `(SELECT MAX(...) FROM (VALUES ...))` | `GREATEST([a], [b])` |
| `Take(n).FirstOrDefault()` | `TOP(@p)` サブクエリを包む入れ子の `TOP(1)` | `TOP(LEAST(@p, 1))` |
| `Skip(s).Take(n).First()` | `OFFSET`/`FETCH` サブクエリを包む `TOP(1)` | `FETCH NEXT LEAST(@p1, 1) ROWS ONLY` |
| `Where` 内の `TrimStart('0')` | "could not be translated" で例外 | `LTRIM([col], N'0')` |
| JSON プロパティに `DateTime` 列を設定する `ExecuteUpdate` | 例外 | `JSON_MODIFY(..., JSON_VALUE(JSON_OBJECT('v': [col]), '$.v'))` |
| DDL / マイグレーション | 同一 | 同一 |
| JSON 列 | `nvarchar(max)` | `nvarchar(max)` (`json` に切り替わるのは 170 のみ) |
| 最小サーバー | SQL Server 2019 | SQL Server 2022 (文字指定の `LTRIM`/`RTRIM` にはデータベースレベル 160 も必要) |

## EF の互換性レベルはデータベースの互換性レベルではない

設定は二つあり、どちらも "compatibility level" (互換性レベル) と呼ばれています。

**EF の設定**は `UseCompatibilityLevel` に渡す値です。EF がこれをサーバーから読み取ることはありません。オプションが構築された時点で固定され、クエリパイプラインがどの SQL 機能を使ってよいかを決めるだけです。EF Core 11 の `SqlServerOptionsExtension` では、既定値は `SqlServerDefaultCompatibilityLevel = 160` と `AzureSqlDefaultCompatibilityLevel = 170` です。EF Core 10 では前者が 150 でした。この変更は [dotnet/efcore#38198](https://github.com/dotnet/efcore/issues/38198) で、PR #38199 で出荷され、EF Core 11 の影響度の低い破壊的変更として記載されています。

**データベースの設定**は `sys.databases.compatibility_level` です。これはクエリオプティマイザーの挙動といくつかの構文規則を制御します。データベースレベル 160 では、SQL Server 2022 はパラメーター依存プランの最適化とカーディナリティ推定のフィードバックを有効にします。新しいサーバーにリストアまたはアタッチしたデータベースは、古いレベルを保持します。そのため SQL Server 2019 から 2022 に移したデータベースが、まだ 150 のままということもあり得ます。

二つの設定が関わり合うのは、EF が送信する SQL を通じてだけです。Microsoft の互換性レベルのページには、新しい T-SQL 構文は "isn't gated by database compatibility level, except when they can break existing applications" と書かれています。`GREATEST` と `LEAST` はその例外リストに含まれていないので、SQL Server 2022 ではどのデータベースレベルでも動作します。`LTRIM` と `RTRIM` の省略可能な *characters* 引数は例外で、そのドキュメントではデータベース互換性レベル 160 が必要とされています。

また、`UseAzureSql` と `UseSqlServer` は別の経路である点にも注意してください。`UseAzureSql` は EF Core 10 ですでに既定値が 170 だったため、Azure SQL のユーザーにとってこの記事の内容で変わることはありません。`UseSqlServer` を Azure SQL に向けている場合は、ほかの人と同じく 150 から 160 に移行したことになります。

## 違いをどう測定したか

検証用のプログラムでは同じモデルを三回構築します (既定、`UseCompatibilityLevel(150)`、`UseCompatibilityLevel(160)`)。クエリについては `ToQueryString()` を出力します。`FirstOrDefaultAsync` と `ExecuteUpdateAsync` については、インターセプターが接続を抑止してコマンドテキストを取得するため、データベースは一切関与しません:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
var configs = new (string Name, Action<DbContextOptionsBuilder> Configure)[]
{
    ("UseSqlServer (default)", o => o.UseSqlServer(Cs)),
    ("UseSqlServer + 150", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(150))),
    ("UseSqlServer + 160", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(160))),
};

foreach (var (name, configure) in configs)
{
    using var db = Shop.Create(configure); // adds the interceptor, EnableServiceProviderCaching(false)
    Q("Math.Max in Where", () => db.Products
        .Where(p => Math.Max(p.Stock, p.ReorderLevel) > 10).ToQueryString());
    Q("TrimStart('0') in Where", () => db.Products
        .Where(p => p.Sku.TrimStart('0') == "42").ToQueryString());
    // ...one line per shape in the table above
}

class NoDb : DbCommandInterceptor, IDbConnectionInterceptor
{
    public ValueTask<InterceptionResult> ConnectionOpeningAsync(DbConnection c, ConnectionEventData d,
        InterceptionResult r, CancellationToken t = default) => ValueTask.FromResult(InterceptionResult.Suppress());

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand cmd,
        CommandEventData d, InterceptionResult<DbDataReader> r, CancellationToken t = default)
    {
        Capture.Last = cmd.CommandText;
        throw new CapturedException(); // stop before anything needs a real reader
    }
    // ConnectionOpening (sync) and NonQueryExecutingAsync follow the same pattern
}
```

同じファイルを EF Core 10.0.12 に対して実行すると、有用な対照群になりました。`UseCompatibilityLevel(160)` を指定した EF Core 10 は、EF Core 11 の既定と同一の SQL を生成しました。これらの変換はどれも EF Core 11 で新しく追加されたものではありません。`LEAST`/`GREATEST` による `Math.Min`/`Math.Max` と、`TrimStart`/`TrimEnd` の `char` オーバーロードは、どちらもレベル 160 を条件として EF Core 9 で出荷されています。EF Core 11 は既定値を動かし、指定しなくても有効になるようにしただけです。

## 痛い目を見る変更: Take の後に First や Single を続ける場合

これは私が予想していなかったもので、`Math` とはまったく関係のないコードに影響します。すでに行数制限があるクエリにさらに制限を加えると、EF はそれらをマージします。両方の制限が定数なら小さいほうを残します。そうでなければ `GenerateLeast` を呼び出し、これはレベル 160 以上の場合にのみ `LEAST` 式を返します。160 未満では null を返し、EF は入れ子のクエリにフォールバックします。

`FirstOrDefaultAsync` は制限 1 を、`SingleOrDefaultAsync` は制限 2 を追加します。EF は `Take` に渡した値を、`Take(20)` のようなリテラルであってもパラメーター化します。そのため、ページングされた `IQueryable` を返すリポジトリと、最初の行を要求する呼び出し側を組み合わせると、次のようになります:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var first = await db.Products
    .OrderBy(p => p.Id)
    .Take(pageSize)
    .FirstOrDefaultAsync();
```

レベル 160 (EF Core 11 の既定) では:

```sql
SELECT TOP(LEAST(@p, 1)) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
FROM [Products] AS [p]
ORDER BY [p].[Id]
```

レベル 150 (EF Core 10 の既定) では:

```sql
SELECT TOP(1) [p0].[Id], [p0].[CreatedAt], [p0].[ListPrice], [p0].[Name], ...
FROM (
    SELECT TOP(@p) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
    FROM [Products] AS [p]
    ORDER BY [p].[Id]
) AS [p0]
ORDER BY [p0].[Id]
```

`Skip` がある場合、制限は `OFFSET @p ROWS FETCH NEXT LEAST(@p1, 1) ROWS ONLY` に移ります。二つのパラメーターを持つ `Take(n).Take(m)` は `TOP(LEAST(@p, @p1))` を生成します。`Take(n).AnyAsync()` と `Take(n).CountAsync()` は影響を受けません。二つ目の制限を重ねるのではなく、制限付きのクエリを包むからです。同じパラメーターを使う `Take(n).Take(n)` も影響を受けません。EF は二つの等しい制限を見て、一つだけを残すからです。

SQL Server 2022 では、160 の形は単に SQL が短くなるだけです。SQL Server 2019 では、サーバーは `LEAST` を不明な組み込み関数として拒否します。このコードはコンパイルが通り、新しいサーバーに対するテストにも合格し、EF Core 10 では動作していました。SQL Server 2022 のコンテナーに対して実行するテストスイートが警告してくれないのはこのためです。

## Math.Min、Math.Max とインライン配列

150 では、`Math.Max` と `EF.Functions.Greatest` はそもそも変換できません。`Where` や `OrderBy` 内では、クエリを書き換えるかクライアント評価に切り替えるよう求めるおなじみの `InvalidOperationException` が発生します。最終的な射影では、EF は黙って両方の列を選択し、`Math.Min` をクライアントで実行します:

```sql
-- level 150: Select(p => new { p.Id, Effective = Math.Min(p.Price, p.ListPrice) })
SELECT [p].[Id], [p].[Price], [p].[ListPrice]
FROM [Products] AS [p]

-- level 160
SELECT [p].[Id], LEAST([p].[Price], [p].[ListPrice]) AS [Effective]
FROM [Products] AS [p]
```

この射影が、アップグレード後の二つ目の静かな変更です。同じ LINQ が、今ではサーバーに `LEAST` があることに依存しています。

インライン配列には 150 でも動作するフォールバックがあり、相関 `VALUES` サブクエリになっていました:

```sql
-- level 150: Where(p => new[] { p.Stock, p.ReorderLevel }.Max() > 10)
WHERE (
    SELECT MAX([v].[Value])
    FROM (VALUES ([p].[Stock]), ([p].[ReorderLevel])) AS [v]([Value])) > 10

-- level 160
WHERE GREATEST([p].[Stock], [p].[ReorderLevel]) > 10
```

null のセマンティクスは一致します。`GREATEST` と `LEAST` は、すべての引数が `NULL` でない限り `NULL` の引数を無視します。これは `VALUES` の行に対する `MAX` や、`decimal?[]` に対する `Enumerable.Min` と同じです。EF もこれを確認しており、null 許容の結果型では、関数が null を伝播しない場合にのみ `LEAST`/`GREATEST` を選びます。そのため `new decimal?[] { p.SalePrice, p.Price }.Min()` は、結果を変えずに `LEAST([p].[SalePrice], [p].[Price])` になります。

## 文字を指定した TrimStart と TrimEnd

引数なしのトリムは、どのレベルでも `LTRIM(col)` です。特定の文字をトリムするには SQL Server 2022 の 2 引数形式が必要で、EF がそれを使うのは 160 の場合だけです:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var bySku = db.Products.Where(p => p.Sku.TrimStart('0') == "42");
var byName = db.Products.Where(p => p.Name.TrimEnd(' ', '.') == "Widget");
```

```sql
-- level 160
WHERE LTRIM([p].[Sku], N'0') = N'42'
WHERE RTRIM([p].[Name], N' .') = N'Widget'
```

150 ではどちらも "could not be translated" で例外になります。最終的な `Select` 内ではクライアントで実行され、160 ではサーバーに移ります。これはデータベース自体のレベルにも依存するケースです。SQL Server 2022 では、`LTRIM` のドキュメントが characters 引数にデータベース互換性レベル 160 を要求しています。2019 からリストアされ、レベルを一度も上げていないデータベースは、同じサーバー上で `GREATEST` が問題なく動作していても、これを拒否します。

## JSON 列への ExecuteUpdate

JSON にマップされた複合型では、プロパティに `int` や `string` の列を設定することはどちらのレベルでも動作します。`DateTime` のような別の型の列を設定するには `JSON_OBJECT` が必要で、これも SQL Server 2022 の機能です:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
await db.Products.ExecuteUpdateAsync(s =>
    s.SetProperty(p => p.Details.LastPriceChange, p => p.CreatedAt));
```

160 ではこれが `JSON_MODIFY([p].[Details], '$.LastPriceChange', JSON_VALUE(JSON_OBJECT('v': [p].[CreatedAt]), '$.v'))` になります。150 では EF が例外を投げます。EF Core 10.0.12 は、どうすればよいかを教えてくれるメッセージで例外を投げます: "'ExecuteUpdate' cannot set a property in a JSON column to an expression containing a column on SQL Server versions before 2022"。EF Core 11 RC 1 はそれを汎用的な "could not be translated, see inner exception" メッセージで包みます。

## 150 と 160 の間で変わらないもの

スキーマです。JSON 複合型を持つモデルに対して、`GenerateCreateScript()` は 150 と 160 で同一の DDL を返しました。`SupportsJsonType` が切り替わるのは 170 だけなので、JSON 列は `nvarchar(max)` のままで、150 と 160 の間で切り替えてもマイグレーションは作成されません。レベル 130 を必要とする `OPENJSON` ベースの JSON クエリには影響がありません。170 を必要とするもの (ネイティブの `json` 型、`JSON_CONTAINS`、`.modify()`) は、どちらのレベルでも無効のままです。

## 160 のままにすべきとき

- **すべての環境が SQL Server 2022 か 2025、または Azure SQL / Managed Instance である。** ページングクエリの SQL が短くなり、`Math.Min`/`Math.Max` がサーバーで実行され、文字指定のトリムが例外ではなく変換されるようになります。
- **以前から `UseCompatibilityLevel(160)` を手動で設定していた。** その呼び出しは削除できます。EF Core 10 での対照実行が示したとおり、結果は同じです。
- **射影内の `Math.Min` や `TrimStart('0')` のクライアント評価に頼っていた。** その処理をサーバーに移すことは、たいていもともと望んでいたことのはずです。

## 150 に固定すべきとき

- **SQL Server 2019 で動いている環境が一つでもある。** ステージング、顧客のオンプレミス環境、ディザスターリカバリー用のレプリカも含みます。EF Core 11 のプロバイダーのドキュメントは SQL Server 2019 を引き続きサポート対象として記載していますが、それはレベル 150 の場合に限ります。
- **データベースが SQL Server 2022 上のデータベースレベル 150 で動いており、それを自分で制御できない。** たとえば、ベンダーがデータベースを所有していて、160 ではクエリプランが変わるためレベルを上げてくれない場合です。そこでも `GREATEST`/`LEAST` は動作しますが、文字指定の `LTRIM`/`RTRIM` は動作しません。両方をカバーできる EF 側の設定は、150 に固定することだけです。
- **SQL Server のバージョンが不明な多数のテナントに、一つのバイナリを配布している。** サポートする中で最も古いサーバーが実行できるレベルを選んでください。

## レベルを明示し、起動時に確認する

Microsoft 自身のプロバイダーのドキュメントもレベルを明示的に設定することを推奨しており、今回の既定値の変更はそのアドバイスに従う十分な理由になります。各環境が自分の動かしているものを宣言できるよう、構成から読み取ってください:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
var level = builder.Configuration.GetValue("Database:CompatibilityLevel", 150);

builder.Services.AddDbContext<Shop>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Shop"),
        sql => sql.UseCompatibilityLevel(level)));
```

そのうえで、構成されたレベルがサーバーの提供できる範囲を超えている場合は、すぐに失敗させます:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<Shop>();

    // EngineEdition 5 = Azure SQL Database, 8 = Azure SQL Managed Instance
    var engineEdition = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS [Value]")
        .SingleAsync();
    var serverMajor = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS [Value]")
        .SingleAsync();
    var databaseLevel = await db.Database
        .SqlQuery<int>($"SELECT CAST(compatibility_level AS int) AS [Value] FROM sys.databases WHERE name = DB_NAME()")
        .SingleAsync();

    // SQL Server 2019 = 15, 2022 = 16, 2025 = 17; the matching levels are 150, 160, 170
    var isAzure = engineEdition is 5 or 8;
    if ((!isAzure && level > serverMajor * 10) || level > databaseLevel)
        throw new InvalidOperationException(
            $"EF is configured for compatibility level {level}, but the server is version {serverMajor} " +
            $"and the database is at level {databaseLevel}.");
}
```

Azure SQL はこの方法で比較できるパッケージ版 SQL Server のバージョンを報告しないため、そこではデータベースレベルだけに頼ってチェックします。データベースレベルの比較は、`LEAST`/`GREATEST` にとっては必要以上に厳格です。それでも私はこちらを好みます。文字指定の `LTRIM` は実際にデータベースレベルに依存しますし、半分のケースしかカバーしないチェックはないほうがましだからです。同じチェックを統合テストでも、サポートする中で最新ではなく *最も古い* サーバーバージョンのコンテナーに対して実行してください。

## 推奨事項のまとめ

2026 年においては、レベル 160 が正しい既定値です。SQL Server 2022 はリリースから四年近く経っており、SQL もより良くなります。しかし既定値はあなたのサーバーについての推測にすぎず、SQL Server 2019 を使っている組織にとっては、コンパイラーもアナライザーもマイグレーションも指摘してくれない形で間違っています。最初の兆候は、EF Core 10 では動いていたクエリで発生する実行時の SQL エラーです。ですから、EF Core 11 に移行するすべてのアプリで `UseCompatibilityLevel` を明示的に設定してください。すべてのサーバーが 2022 以降なら 160 以上、一つでもそうでないなら 150 です。

## 関連記事

- 170 への移行はずっと大きな一歩です。列の型が変わるからです: [EF Core 11 におけるネイティブ json 列と nvarchar(max) の比較](/ja/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/)。
- 古いリリースから移行する場合は、[EF Core 6 から 11 で本当に痛い目を見る破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) で、ほかのバージョン依存の変換を扱っています。
- この記事で紹介したレベル 150 での失敗は、典型的な [LINQ 式を変換できないエラー](/ja/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) であり、そこで紹介している書き換えがそのまま使えます。
- アップグレード後にアプリが実際に送信している SQL を確認するには、[EF Core 11 が生成する SQL をログに出力](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) してください。
- CI でサーバーバージョンの不一致を検出するには、本番環境で最も古いバージョンに固定して、[Testcontainers で実際の SQL Server に対する統合テストを実行](/ja/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) してください。

## 参考資料

- [EF Core 11 の破壊的変更: SQL Server の互換性レベルの既定値が 160 に](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes#sqlserver-compatibility-level-160)
- [dotnet/efcore#38198: 既定の SQL Server 互換性レベルを 150 から 160 に引き上げ](https://github.com/dotnet/efcore/issues/38198)
- [dotnet/efcore#38196: 古い既定レベルでは Math.Min/Max が変換されない](https://github.com/dotnet/efcore/issues/38196)
- [EF Core SQL Server プロバイダー: 互換性レベル](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/#compatibility-level)
- [ALTER DATABASE の互換性レベル: サポートされるレベルと 150 と 160 の違い](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-compatibility-level)
- [GREATEST (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/logical-functions-greatest-transact-sql)
- [LTRIM (Transact-SQL): characters 引数には互換性レベル 160 が必要](https://learn.microsoft.com/en-us/sql/t-sql/functions/ltrim-transact-sql)
- タグ `v11.0.0-rc.1.26425.128` 時点の EF Core のソース: `SqlServerSqlTranslatingExpressionVisitor.GenerateGreatest`/`GenerateLeast`、`RelationalQueryableMethodTranslatingExpressionVisitor.ApplyLimit`、`SqlServerStringMethodTranslator.TranslateTrimStartEnd`、`SqlServerSingletonOptions`
