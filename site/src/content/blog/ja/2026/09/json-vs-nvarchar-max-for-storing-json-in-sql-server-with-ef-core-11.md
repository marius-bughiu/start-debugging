---
title: "EF Core 11 で SQL Server に JSON を保存するときのネイティブ json 列と nvarchar(max) の比較"
description: "SQL Server 2025 と Azure SQL ではネイティブの json 型を使いましょう。EF Core 11 はそこから JSON_CONTAINS、型付きの JSON_VALUE、インプレースの modify()、JSON インデックスを引き出せます。SQL Server 2019/2022、レガシーなツール、あるいはロールバックできる必要があるスキーマの場合は nvarchar(max) のままにしてください。"
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "json"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-12
---

結論: データベースが SQL Server 2025 または Azure SQL なら、JSON はネイティブの `json` 型に保存してください。この型を使うと、EF Core 11 は型付きの `JSON_VALUE(... RETURNING int)` を出力し、プリミティブコレクションに対する `Contains` を `JSON_CONTAINS` に変換し、`ExecuteUpdate` をインプレースの `.modify()` メソッドで実行し、`CREATE JSON INDEX` を作成できます。これらはどれも `nvarchar(max)` では機能しません。SQL Server 2019 または 2022 を使っている場合、列を生のまま読むツール (bcp のネイティブ形式、古い ODBC クライアント) がある場合、あるいはロールバックできるスキーマ変更が必要な場合は `nvarchar(max)` のままにしてください。SQL Server は `json` 列を文字列型に戻す `ALTER` を拒否します。

以下の内容はすべて、.NET 11 RC 1 SDK (11.0.100-rc.1.26425.128) 上の `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 と C# 14 で確認しました。サーバー側の挙動は SQL Server 2025 (17.x) のドキュメントに基づいています。

## 比較の概要

| | `json` (ネイティブ) | `nvarchar(max)` |
| --- | --- | --- |
| 利用できる環境 | SQL Server 2025、Azure SQL Database、Azure SQL MI、Fabric の SQL データベース | すべての SQL Server バージョン |
| EF Core 11 で既定になる条件 | `UseAzureSql`、または `UseCompatibilityLevel(170)` | `UseSqlServer` (既定のレベル 160) |
| ストレージ | 解析済みのバイナリ、UTF-8 (`Latin1_General_100_BIN2_UTF8`)、最大 2 GB | UTF-16 テキスト |
| 書き込み時の検証 | 常に行われます。最上位はオブジェクトか配列である必要があります | `CHECK (ISJSON(...) = 1)` を追加しない限りなし |
| スカラーのフィルター SQL | `JSON_VALUE(col, '$.x' RETURNING int)` | `CAST(JSON_VALUE(col, '$.x') AS int)` |
| `tags.Contains("x")` | `JSON_CONTAINS(col, N'x') = 1` | `N'x' IN (SELECT ... FROM OPENJSON(col) ...)` |
| 1 つのプロパティに対する `ExecuteUpdate` | `SET [col].modify('$.x', ...)` | `SET col = JSON_MODIFY(col, '$.x', ...)` |
| `CREATE JSON INDEX` | あり (SQL Server 2025、プレビュー) | なし |
| EF が送るパラメーター型 | `SqlDbType.Json` | `SqlDbType.NVarChar` |
| `ALTER COLUMN` で元に戻す | 不可 | 該当なし |
| 古いクライアントからの見え方 | `varchar(max)` または `nvarchar(max)` | `nvarchar(max)` |

## EF Core 11 が json 型を選ぶと何が変わるか

EF は接続先のデータベースに基づいて判断するわけではありません。構成した互換性レベルに基づいて判断し、それもモデル構築時に行います。同じモデルを 4 通りに構成して DDL と SQL を出力する小さなプローブを作りました。接続を抑止するインターセプターを入れているので、データベースは不要です。

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string[] Tags { get; set; } = [];          // primitive collection, always JSON
    public required Shipping Shipping { get; set; }   // complex type mapped with ToJson()
}

public class Shipping
{
    public string City { get; set; } = "";
    public int Priority { get; set; }
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<Order>().ComplexProperty(o => o.Shipping, s => s.ToJson());
```

素の `UseSqlServer(connectionString)` では、EF Core 11 は互換性レベル 160 で動作します。この既定値は EF Core 11 で変わりました。EF Core 10 は 150 でした。どちらの JSON 列も `nvarchar(max)` になります。

```sql
-- UseSqlServer, default level 160
CREATE TABLE [Orders] (
    [Id] int NOT NULL,
    [Customer] nvarchar(max) NOT NULL,
    [Tags] nvarchar(max) NOT NULL,
    [Shipping] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

`UseSqlServer(cs, o => o.UseCompatibilityLevel(170))`、または `UseAzureSql(cs)` (既定値は 170) に切り替えると、同じモデルから `[Tags] json NOT NULL` と `[Shipping] json NOT NULL` が生成されます。コードの他の部分は何も変わりません。まず頭に入れておくべきはこの点です。意図したかどうかにかかわらず、**`UseSqlServer` から `UseAzureSql` への移行は列の型の変更です**。

クエリも変わります。特に重要な 3 つの LINQ の形を、各レベルで生成されたとおりに示します。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
ctx.Orders.Where(o => o.Shipping.Priority > 2);
ctx.Orders.Where(o => o.Tags.Contains("gift"));
await ctx.Orders.Where(o => o.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Shipping.Priority, o => o.Shipping.Priority + 1));
```

レベル 160 (`nvarchar(max)`) の場合:

```sql
WHERE CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) > 2

WHERE N'gift' IN (
    SELECT [t].[value]
    FROM OPENJSON([o].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)

UPDATE [o]
SET [o].[Shipping] = JSON_MODIFY([o].[Shipping], '$.Priority', CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

レベル 170 (`json`) の場合:

```sql
WHERE JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) > 2

WHERE JSON_CONTAINS([o].[Tags], N'gift') = 1

UPDATE [o]
SET [Shipping].modify('$.Priority', JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

書き込みの経路では、1 つのプロパティを変更しただけでも `SaveChanges` はどちらのレベルでもドキュメント全体を送信します (`UPDATE [Orders] SET [Shipping] = @p0`)。違いはパラメーターです。レベル 170 では、EF Core 11 RC 1 が取り込む `Microsoft.Data.SqlClient` 7.0.2 がそれを `SqlDbType.NVarChar` ではなく `SqlDbType.Json` として送信します。部分的なインプレース更新になるのは `ExecuteUpdate` だけです。自分のアプリでこの SQL を取得したい場合は、[EF Core 11 が生成する SQL をログ出力する方法](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) で選択肢を解説しています。

## ネイティブの json 型を選ぶべきとき

- **Azure SQL Database または Managed Instance を使っている。** これらの環境では、SQL Server 2025 または Always-up-to-date の更新ポリシーでこの型が一般提供されており、`UseAzureSql` はすでにこの型を選択します。オプトアウトすると `JSON_CONTAINS` と型付きの `RETURNING` 句を失い、得るものは何もありません。
- **SQL Server 2025 を使っていて、ドキュメントの内部でフィルターする。** `JSON_VALUE`、`JSON_PATH_EXISTS`、`JSON_CONTAINS` は JSON インデックスを使用でき、EF Core 11 はモデルからそのインデックスを作成できるようになりました (次のセクション)。`nvarchar(max)` では、インデックスの選択肢はパスごとの計算列しかありません。
- **ドキュメント内のフィールドを一括更新する。** `ExecuteUpdate` は `.modify()` になり、Microsoft のドキュメントによると、新しい値が収まる場合、つまり元の値より長くない文字列や、同じ型または範囲の数値の場合はインプレースで更新されます。テキストに対する `JSON_MODIFY` は値を書き直します。
- **不正なデータをデータベースに拒否させたい。** `json` 列は、整形式のオブジェクトまたは配列でないものをすべて拒否します。`nvarchar(max)` では、そのチェックは自分で追加した場合にしか存在しません。

## nvarchar(max) のままにすべきとき

- **本番サーバーが SQL Server 2019 または 2022 である。** これらにはこの型が存在せず、EF は互換性レベルを上げた場合にしかこの型を使わないので、既定のレベル 160 のままにするか、150 を明示的に設定してください。
- **EF 以外の何かがこの列を読む。** SQL Server の `json` のドキュメントには、`sp_describe_first_result_set` が `json` 型を報告しないと記載されています。TDS 7.4 以降のクライアントからは UTF-8 照合順序の `varchar(max)` に見え、それより古いクライアントからは `nvarchar(max)` に見えます。bcp のネイティブ形式はドキュメントをテキストとして書き出すので、読み込み直すにはフォーマットファイルが必要です。列のメタデータをハードコードした ETL パッケージが、よく犠牲になります。
- **元に戻せるマイグレーションが必要である。** `nvarchar(max)` を `json` に `ALTER` することはできますが、SQL Server は `json` 列を文字列型やバイナリ型に戻す `ALTER TABLE` を許可しません。変換用に EF がスキャフォールドする `Down()` メソッドは単なる `ALTER COLUMN ... nvarchar(max)` なので、ロールバックするには新しい列を追加し、コピーし、手作業で入れ替える必要があります。
- **この型がまだサポートしていない形のクエリを使っている。** EF Core 10 の破壊的変更に関するドキュメントでは、その 1 つとして、`json` では JSON 配列に対する `DISTINCT` がサポートされておらず、そのようなクエリは失敗することが挙げられています。

## 根拠: 測定したことと、していないこと

ストレージやレイテンシのベンチマークは実行していません。私のテスト環境には SQL Server 2025 のインスタンスがなく、計測していない型に高速化の数値を添えるつもりはありません。上のプローブが EF Core 11 RC 1 について実際に示しているのは次の点です。

1. 列の型は、`UseAzureSql` か互換性レベル 170 以上によってのみ決まります。`UseSqlServer` の既定値は 160 です (`SqlServerOptionsExtension` で確認済み。そこでは `SqlServerDefaultCompatibilityLevel = 160`、`AzureSqlDefaultCompatibilityLevel = 170` となっています)。
2. 上の表にある変換の違いは、どれも実際に生成された SQL そのままであり、リリースノートの言い換えではありません。
3. レベル 160 から 170 へ移行するために EF が生成するマイグレーションは、JSON 列ごとに 1 つの `ALTER COLUMN` です (既定値制約の処理は省略しています)。

```sql
-- EF Core 11.0.0-rc.1, model diff from level 160 to level 170
ALTER TABLE [Orders] ALTER COLUMN [Tags] json NOT NULL;
ALTER TABLE [Orders] ALTER COLUMN [Shipping] json NOT NULL;
```

ストレージと読み取りに関する主張は Microsoft によるものです。[json データ型のリファレンス](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type) によると、ドキュメントがすでに解析済みなので読み取りが効率的になり、書き込みでは個々の値を更新でき、バイナリ形式は「圧縮向けに最適化」されています。誰かに数値を約束する前に、自分のドキュメントで測定してください。小さくフラットなドキュメントは、フィルター対象となる大きく入れ子になったドキュメントに比べて、得られる効果がずっと小さくなります。

## 選択を決めてしまう落とし穴: JSON インデックス

EF Core 11 では、JSON の複合型内のパスに対する `HasIndex` が追加され、SQL Server 2025 の `CREATE JSON INDEX` になります。これは `json` に移行する最も強い理由ですが、罠があります。上のモデルにインデックスを追加したときにプローブが出力した内容は次のとおりです。

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
mb.Entity<Order>().HasIndex("Shipping.City");
```

レベル 170 では期待どおりの結果になります。

```sql
CREATE JSON INDEX [IX_Orders_Shipping_City] ON [Orders]([Shipping]) FOR (N'$.City');
```

レベル 160 では、直前に作成した列が `nvarchar(max)` であるにもかかわらず、EF は **まったく同じステートメント** を出力します。マイグレーションの SQL ジェネレーターは、`CREATE JSON INDEX` を書き出す前にストア型をチェックしません。[CREATE JSON INDEX のリファレンス](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) では `json` 列が必須とされているので、このマイグレーションは適用時に失敗します。Microsoft 自身のサンプルが型を明示的に固定しているのもそのためです。

```csharp
// .NET 11, EF Core 11 - make the column type independent of the compatibility level
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Contact, b => b.ToJson().HasColumnType("json"));

modelBuilder.Entity<Customer>()
    .HasIndex("Contact.Address.City");
```

SQL 側からはさらに 3 つの制約があります。JSON インデックスはプレビュー段階で、ドキュメント上は SQL Server 2025 のみが対象であり、Azure SQL は対象外です。テーブルにはクラスター化された主キーが必要です。そしてインデックスはオフラインでしか作成できず、作成中はずっとスキーマ変更ロックを保持します。マイグレーションの時間枠はそれに合わせて計画してください。[本番環境向けのマイグレーションバンドルのワークフロー](/ja/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) が、それを安全に実行する方法です。

Azure SQL に関連する注意点もあります。`json` 型のドキュメントでは、`.modify()` は依然として SQL Server 2025 でのみ利用できるプレビュー機能とされていますが、EF は `UseAzureSql` の場合も含め、すべての `json` 列に対してこれを出力します。この組み合わせはテストできませんでした。Azure SQL で JSON プロパティへの `ExecuteUpdate` に頼る前に、実際のデータベースに対して一度実行してみてください。この種の不一致は以前にも EF で問題になっています。[Azure SQL での `AS JSON` エラー](/ja/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/) は、SQL Server 2025 しか受け付けない `OPENJSON` 句の中で EF が `json` を出力したことが原因でした。これは EF Core 10.0.11 で修正されています。

## オプトアウトする: 列単位またはグローバルに

Azure SQL を使っているもののまだ変換する準備ができていない場合は、2 つの切り替え方法があります。グローバルな方法は、EF が想定する互換性レベルを下げることです。

```csharp
// .NET 11, EF Core 11 - keep every JSON column on nvarchar(max) on Azure SQL
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

これは `JSON_CONTAINS` を含む、レベル 170 の他のすべての変換も無効にします。対象を絞った方法では、個々の列を固定し、モデルの残りの部分は 170 のままにします。

```csharp
// .NET 11, EF Core 11 - pin specific columns to text, verified to emit nvarchar(max) at level 170
modelBuilder.Entity<Order>()
    .ComplexProperty(o => o.Shipping, s => s.ToJson().HasColumnType("nvarchar(max)"));
modelBuilder.Entity<Order>()
    .PrimitiveCollection(o => o.Tags).HasColumnType("nvarchar(max)");
```

既存のデータベースで逆方向に進む場合は、レベルを上げて `dotnet ef migrations add ConvertJsonColumns` を実行し、適用する前に生成されたマイグレーションを読んでください。このマイグレーションはプリミティブコレクションも含め、モデル内のすべての JSON 列を一度に変更します。`ToJson()` で 1 つの複合型しかマッピングしていないと、この点は見落としがちです。この判断のモデリング面については、[EF Core 11 の複合型と所有エンティティの比較](/ja/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) で、変換前に `ComplexProperty(...).ToJson()` のマッピングにしておくべき理由を説明しています。JSON への `ExecuteUpdate` は複合型でしか機能しません。

## 推奨事項のまとめ

SQL Server 2025 と Azure SQL では `json` を選んでください。EF Core 11 が向かっている方向はそこです。`JSON_CONTAINS`、型付きの `JSON_VALUE`、`.modify()`、JSON インデックスはすべてこの型に依存しており、`UseAzureSql` はすでにこの型を前提としています。インデックスを作成する JSON 列には `HasColumnType("json")` を明示的に設定し、互換性レベルの変更によって失敗するマイグレーションが生成されることがないようにしてください。サーバーが 2025 より古い場合、EF 以外のツールが生の列を読む場合、あるいは一方通行のスキーマ変更をまだ受け入れられない場合は `nvarchar(max)` のままにしてください。最後のケースでは、コンテキスト全体の互換性レベルを下げるのではなく、列ごとに型を固定してください。変換後のクエリ面については、[EF Core 11 で JSON 列をマッピングしてクエリする方法](/ja/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) のウォークスルーが、この記事の続きを扱っています。

## 参考資料

- [json データ型 (SQL Server 2025、Azure SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type): ストレージ形式、`modify`、変換ルール、制限事項
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [EF Core 11 の新機能: JSON インデックス、JSON_CONTAINS、互換性レベル 160 の既定化](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [EF Core 10 の新機能: JSON 型のサポート](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [EF Core 10 の破壊的変更: Azure SQL と互換性レベル 170 では json データ型が既定で使用される](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [SqlClient における JSON データ型のサポート](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/json-data-sql-server)
- [dotnet/efcore#29623: SQL Server, support JSON indexes](https://github.com/dotnet/efcore/issues/29623)
