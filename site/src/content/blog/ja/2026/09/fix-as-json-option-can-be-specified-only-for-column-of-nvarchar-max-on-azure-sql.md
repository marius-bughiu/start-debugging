---
title: "解決: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause"
description: "EF Core が OPENJSON WITH の内部に [col] json '$.path' AS JSON を出力し、Azure SQL が Msg 13618 で拒否します。EF Core 10.0.11 以降へ更新するか、プロバイダーの互換性レベルを 160 に下げてください。"
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "azure"
  - "json"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql"
translatedBy: "claude"
translationDate: 2026-09-09
---

`Microsoft.EntityFrameworkCore.SqlServer` を 10.0.11 以降に更新してください。それ以前のバージョンでは、JSON にマッピングされた複合型が入れ子のコレクションを含み、プロバイダーが互換性レベル 170 で動作している場合に、EF Core は `OPENJSON ... WITH` 句の内部へ `[col] json '$.path' AS JSON` を生成していました。SQL Server 2025 はその位置でネイティブの `json` 型を受け付けますが、Azure SQL は受け付けず、Msg 13618 で拒否します。更新できない場合は `o => o.UseCompatibilityLevel(160)` を渡してください。ひとつ注意点があります。この修正が働くのは EF が Azure SQL と通信していると認識している場合だけです。つまり Azure の接続文字列を渡した `UseSqlServer` ではなく、`UseAzureSql` を呼び出す必要があります。

## エラーの文脈

例外は、入れ子の JSON コレクションに踏み込む最初のクエリで、ごく普通の `SqlException` として現れます。

```
Microsoft.Data.SqlClient.SqlException (0x80131904): AS JSON option can be specified only for column of nvarchar(max) type in WITH clause.
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReaderAsync(RelationalCommandParameterObject parameterObject, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.AsyncEnumerator.InitializeReaderAsync(AsyncEnumerator enumerator, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, ...)
   at Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToListAsync[TSource](IQueryable`1 source, CancellationToken cancellationToken)
```

サーバー側のエラー番号は 13618 です。これを引き起こした SQL は次のようになります。

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

問題の行は `[partNumbers] json '$.partNumbers' AS JSON` です。ステートメントの他の部分に問題はありません。

似た別のエラーではなくこのページが正しいという手がかりは、失敗が環境に依存することです。同じバイナリ、同じモデル、同じクエリが、ローカルの SQL Server 2025 インスタンスに対しては動作し、Azure SQL に対しては失敗します。両方のデータベースが互換性レベル 170 を報告していてもです。

## なぜ起きるのか

独立した 3 つの事実が衝突します。

**`AS JSON` は以前から `nvarchar(max)` を要求してきました。** [OPENJSON のリファレンス](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql)は明確です。"If you specify the `AS JSON` option, the type of the column must be **nvarchar(MAX)**." このルールはネイティブの `json` 型より 9 年古いものです。

**SQL Server 2025 はこのルールを緩和しましたが、Azure SQL は緩和していません。** ネイティブの `json` データ型は Azure SQL Database と Azure SQL Managed Instance で一般提供され、SQL Server 2025 ではプレビューです。しかし [json データ型の制限](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations)は `OPENJSON` を明示的に除外しています。"Currently, the `OPENJSON()` function doesn't accept the **json** data type in some platforms. Currently, it's an implicit conversion. Explicitly convert to **nvarchar(max)** first. In SQL Server 2025 (17.x), the `OPENJSON()` function does support **json**." つまり `WITH` 句における `json` 型はオンプレミスの SQL Server 2025 の機能であり、Azure SQL の機能ではありません。

**`UseAzureSql` は既定で互換性レベル 170 を有効にし、その 170 が EF に `json` 型を選ばせます。** `SqlServerOptionsExtension` では `SqlServerDefaultCompatibilityLevel` が 160 であるのに対し、`AzureSqlDefaultCompatibilityLevel` は 170 です。`SqlServerSingletonOptions.SupportsJsonType` は 170 以上で true を返します。実務上の帰結として、何かを明示的に有効化する必要はありません。`UseSqlServer` から `UseAzureSql` に切り替えるだけで JSON 列がネイティブの `json` 型に移り、生成されるクエリに `json ... AS JSON` が出力され始めます。

EF Core 10.0.11 より前は、`SqlServerQuerySqlGenerator.GenerateColumnInfo` が `WITH` 句のすべての列について `columnInfo.TypeMapping.StoreType` をそのまま出力していました。ストア型が `json` で列に `AS JSON` が付いている場合、SQL Server 2025 だけが解析できる SQL が生成されていたわけです。

クエリの形が重要である点にも注意してください。JSON 列を丸ごと読むだけならこの問題には当たりませんし、ドキュメント内のスカラー値に対する `Where` でも当たりません。`AS JSON` が現れるのは、クエリが JSON ドキュメント内の入れ子コレクションに踏み込むときです。EF がその入れ子配列を 2 回目の `OPENJSON` 呼び出しに渡す必要があるからです。EF が入れ子ドキュメントを `OPENJSON` のツリーに変換する仕組みが初めてなら、[EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)で解説しています。

## 最小限の再現

モデルには、JSON にマッピングされた複合型があり、その中に複合型のコレクションがあり、さらにその中にプリミティブのコレクションがある構造が必要です。これは [dotnet/efcore#38615](https://github.com/dotnet/efcore/issues/38615) で報告された形です。

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
public class Car
{
    public int CarId { get; set; }
    public string Vin { get; set; } = null!;
    public string DealerId { get; set; } = null!;
    public CarConfiguration CarConfiguration { get; set; } = null!;
}

public class CarConfiguration
{
    public string? CurrentTrim { get; set; }
    public List<OptionPackage>? OptionPackages { get; set; }
}

public class OptionPackage
{
    public required string PackageId { get; set; }
    public required ICollection<string> PartNumbers { get; set; }
}
```

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Car>(builder =>
    {
        builder.ToTable("Cars");
        builder.HasKey(e => e.CarId);
        builder.Property(e => e.Vin).IsUnicode(false).HasMaxLength(32);
        builder.Property(e => e.DealerId).IsUnicode(false).HasMaxLength(32);

        builder.ComplexProperty(e => e.CarConfiguration, pp =>
        {
            pp.ToJson("CarConfiguration");
            pp.IsRequired();
            pp.Property(p => p.CurrentTrim).HasJsonPropertyName("currentTrim");

            pp.ComplexCollection(p => p.OptionPackages, op =>
            {
                op.HasJsonPropertyName("optionPackages");
                op.Property(o => o.PackageId).HasJsonPropertyName("packageId");
                op.PrimitiveCollection(o => o.PartNumbers)
                    .ElementType(e => e.IsUnicode(false).HasMaxLength(32))
                    .HasJsonPropertyName("partNumbers");
            });
        });
    });
}
```

この構成には意図的に `HasColumnType("json")` を書いていません。必要ないからです。互換性レベル 170 ではプロバイダーが自分でネイティブ型を選びます。

失敗するのは、2 階層下まで降りるあらゆる射影です。

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
var options = new DbContextOptionsBuilder<CarContext>()
    .UseAzureSql(connectionString)   // defaults to compatibility level 170
    .Options;

await using var ctx = new CarContext(options);

var partNumbers = await ctx.Cars
    .Where(c => c.Vin == "1FA6P8TH8J5123456" && c.DealerId == "DEALER-001")
    .SelectMany(c => c.CarConfiguration.OptionPackages!)
    .Where(op => op.PackageId == "PKG-SPORT")
    .SelectMany(op => op.PartNumbers)
    .ToListAsync();                  // Msg 13618 on Azure SQL
```

不正な SQL を確認するのに Azure のサブスクリプションは不要です。`ToQueryString()` は接続を開かずに生成するので、偽の接続文字列を持つ使い捨てのコンソールアプリだけで、自分のビルドがどの形を出力するか確認できます。この仕掛けを 10.0.10 に対して実行すると、先ほどの `[partNumbers] json '$.partNumbers' AS JSON` の行が出力されます。

## 解決策の詳細

### 1. EF Core 10.0.11 以降に更新する

これが本当の修正であり、モデルもクエリも変更する必要はありません。[dotnet/efcore#38665](https://github.com/dotnet/efcore/pull/38665) は 2026-07-20 に `release/10.0` ブランチへ入り、10.0.11 (2026-08-11) で出荷されました。現在のパッチ 10.0.12 にも含まれています。

```xml
<!-- .NET 10 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="10.0.12" />
```

同じ再現、同じクエリ、`Microsoft.EntityFrameworkCore.SqlServer` 10.0.12 と `UseAzureSql` の場合は次のとおりです。

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] nvarchar(max) '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

ジェネレーターはその 1 か所だけで型を置き換えるようになりました。

```csharp
// dotnet/efcore, SqlServerQuerySqlGenerator.GenerateColumnInfo, release/10.0
if (columnInfo.AsJson
    && columnInfo.TypeMapping.StoreType == "json"
    && (_sqlServerSingletonOptions.EngineType != SqlServerEngineType.SqlServer
        || _sqlServerSingletonOptions.SqlServerCompatibilityLevel < 170))
{
    Sql.Append("nvarchar(max)");
}
else
{
    Sql.Append(columnInfo.TypeMapping.StoreType);
}
```

テーブル側は何も変わりません。列はディスク上では `json` のままで、書き換わるのは `WITH` 句の宣言だけです。`OPENJSON` は引き続き暗黙の変換によって `json` 列を第 1 引数として受け付けます。

### 2. 更新できない場合は互換性レベルを 160 に下げる

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.SqlServer 10.0.9 or 10.0.10
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

160 では `SupportsJsonType` が false になり、JSON 列は `nvarchar(max)` にマッピングされ、`WITH` 句は `[partNumbers] nvarchar(max) '$.partNumbers' AS JSON` に戻ります。10.0.10 で確認済みです。

代償はこの 1 つの句にとどまりません。互換性レベル 160 は `JSON_CONTAINS` の変換、`ExecuteUpdate` 向けの `json` 型の `.modify()` サポート、そして [EF Core 11 の JSON_CONTAINS 変換](/ja/2026/04/efcore-11-json-contains-sql-server-2025/)で説明している 170 専用の他の変換も無効にします。さらに重要なのは、モデル上の列型が変わり、マイグレーションのパイプラインがそれに気づくことです。10.0.12 でリレーショナルモデルから直接ストア型を読むと、それが具体的に分かります。

```
UseAzureSql (default compat 170)            Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(170)   Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(160)   Cars.CarConfiguration -> nvarchar(max)
```

テーブルがすでに `json` になっている状態で互換性レベルを下げると、次の `dotnet ef migrations add` は `nvarchar(max)` へ戻す `ALTER COLUMN` を生成します。そもそも SQL Server は `ALTER TABLE` で `json` 列を文字列型に変換させないので、そのマイグレーションはデプロイ時に失敗し、データを黙って書き換えることはありません。160 は実行時の応急処置として扱い、マイグレーションを生成するモデルからは外しておくか、`nvarchar(max)` ストレージのままで行くと割り切ってください。

### 3. 本当に `UseAzureSql` を呼んでいるか確認する

更新したのにエラーが続く人がつまずくのがここです。ジェネレーターの条件をもう一度見てください。エンジン型が `SqlServer` でないとき、または `SqlServer` であっても互換性レベルが 170 未満のときに `nvarchar(max)` へ置き換えます。`UseSqlServer` を Azure SQL の接続文字列に向けてレベル 170 を要求すると、EF は `OPENJSON` で `json` をサポートするオンプレミスの SQL Server 2025 と通信していると判断します。10.0.12 でもこの組み合わせは失敗する行を出力し続けます。

```sql
-- UseSqlServer + UseCompatibilityLevel(170), EF Core 10.0.12
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
```

これは 2 つ目のバグではなく正しい挙動です。EF はサーバーに問い合わせずに接続文字列の指す先を知ることはできません。解決策は、自分が使っているエンジンを宣言することです。`UseAzureSql` は EF Core 9.0 から存在し、Azure に適した接続の回復性も無料で設定してくれます。

```csharp
// .NET 10, EF Core 9.0 and later
builder.Services.AddDbContext<CarContext>(options =>
    options.UseAzureSql(builder.Configuration.GetConnectionString("CarContext")));
```

Azure SQL Managed Instance も同じ呼び出しを使います。Azure Synapse には `UseAzureSynapse` があり、`SupportsJsonType` を無条件で false と報告するため、このコードパスには到達しません。

### 4. 効かない方法: コンテナー列の型を上書きする

いかにも効きそうな回避策は、JSON 列を文字列型に戻すことです。

```csharp
// Does NOT fix the WITH clause
pp.ToJson("CarConfiguration");
pp.HasColumnType("nvarchar(max)");
```

10.0.10 で `UseSqlServer` をレベル 170 にした場合、これでも `[partNumbers] json '$.partNumbers' AS JSON` が出力されます。理由は、`HasColumnType` がコンテナー列のストア型を設定するのに対し、入れ子コレクションに対応する `WITH` 句のエントリはプロバイダーの JSON 型マッピングから型を取得し、それが互換性レベルから決まるためです。外側の列を変えても内側の宣言には届きません。バージョンの引き上げか互換性レベルのどちらかを選んでください。

## 落とし穴と紛らわしいエラー

**"The store type 'nvarchar(2000)' specified for JSON column ... is not supported by the current provider."** 別のエラーであり、原因も別です。これは SQL が生成される前にモデル検証が投げる `InvalidOperationException` で、Azure かどうかに関係なくすべての構成で発生します。

```
InvalidOperationException: The store type 'nvarchar(2000)' specified for JSON column 'CarConfiguration' in table 'Cars' is not supported by the current provider. JSON columns require a provider-specific JSON store type.
```

これは JSON 列を MAX ではない `nvarchar(x)` に固定したという意味で、EF Core 9 では動いていたものが EF Core 10 で検証エラーになりました ([dotnet/efcore#37424](https://github.com/dotnet/efcore/issues/37424))。`nvarchar(max)` か `json` を使うか、`HasColumnType` の呼び出しを外してプロバイダーに選ばせてください。

**手書きの SQL と `FromSql`。** Msg 13618 は EF のルールではなく T-SQL のルールです。失敗しているステートメントが自分で書いた `OPENJSON ... WITH (Payload nvarchar(100) '$.payload' AS JSON)` なら、どの EF バージョンでも直りません。列の宣言を `nvarchar(max)` に広げてください。SQL ドキュメントの [JSON のよくある問題](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server)のページが同じルールを T-SQL 側から説明しています。生の SQL はクエリパイプラインを迂回するため、ここでは `ToQueryString()` は役に立ちません。書いた SQL がそのまま実行される SQL です。

**オンプレミスの SQL Server 2025 は影響を受けません。** データベースが SQL Server 2025 (17.x) で、EF が `UseSqlServer` とレベル 170 で構成されているなら、`json ... AS JSON` は有効であり、10.0.11 より前の SQL も問題なく動きます。この非対称性こそ、顧客が同じビルドを Azure に対して実行するまでこのバグが生き残った理由です。

**EF の互換性レベルはデータベースの互換性レベルではありません。** `UseCompatibilityLevel(170)` は生成してよい SQL を EF に伝えるだけです。`ALTER DATABASE ... SET COMPATIBILITY_LEVEL` を実行するわけではありません。データベースがまだ 150 のまま EF を 170 に設定すると、まったく別種の構文エラーが発生します。

**ドキュメント全体だけを読む `SELECT` は安全です。** 一見無関係なリファクタリングの後にエラーが出た場合は、入れ子コレクションに対する新しい `SelectMany`、`Any`、`Contains` を探してください。それが 2 つ目の `OPENJSON` と `AS JSON` 列を引き込みます。[EF Core 11 が生成する SQL をログ出力する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)のとおり SQL のログ出力を有効にすれば、1 リクエストのうちにどのクエリの形が変わったか分かります。

## EF Core 11 に修正は入っているか

同じジェネレーターのコードが `release/11.0` ブランチにも存在するため、2026-09-08 に公開された `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 には修正が入っています。このパッケージは `net11.0` のみを対象とするため、検証には .NET 11 SDK が必要です。上記の SQL のサンプルはすべて .NET SDK 10.0.302 上で EF Core 10.0.10、10.0.11、10.0.12 に対して `ToQueryString()` を使って生成しました。

いずれにせよ JSON を多用したモデルを EF Core 11 に移すのであれば、[複合型と所有エンティティの比較](/ja/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)のマッピング判断や、[EF Core 6 から EF Core 11 への移行](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)のプロバイダーレベルの変更と同じ作業でまとめて片付ける価値があります。根底の教訓はこの 1 つのエラーを超えて一般化できます。"Azure SQL" と "SQL Server 2025" は同じターゲットではなく、とくに JSON で分かれます。そして EF がどちらで動いているかを知っているのは、あなたが伝えたからにすぎません。

## 関連記事

- [EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [EF Core 11 は SQL Server 2025 で Contains を JSON_CONTAINS に変換する](/ja/2026/04/efcore-11-json-contains-sql-server-2025/)
- [EF Core 11 の複合型と所有エンティティの比較](/ja/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [EF Core 11 が生成する SQL をログ出力する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [EF Core 6 から EF Core 11 への移行: 実際に効いてくる破壊的変更](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## 参照元

- [dotnet/efcore#38615, 互換性レベル 170 の Azure SQL でのみ発生する json クエリ時の例外](https://github.com/dotnet/efcore/issues/38615)
- [dotnet/efcore#38665, 互換性レベル 170 で列の型が json のときに Azure SQL で OPENJSON AS JSON が失敗する問題の修正](https://github.com/dotnet/efcore/pull/38665)
- [dotnet/efcore#37424, EF10 SQL Server: nvarchar(x) にマッピングされた JSON 型が動作しなくなった](https://github.com/dotnet/efcore/issues/37424)
- [OPENJSON (Transact-SQL), AS JSON の列型ルールを含む](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql)
- [json データ型の制限, OPENJSON と json 型について](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations)
- [EF Core 向け Microsoft SQL Server データベースプロバイダー, UseAzureSql と互換性レベルについて](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/)
- [SQL Server での JSON のよくある問題を解決する](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server)
