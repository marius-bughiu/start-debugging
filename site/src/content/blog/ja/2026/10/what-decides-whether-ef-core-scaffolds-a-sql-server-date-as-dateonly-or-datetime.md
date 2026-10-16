---
title: "EF Core が SQL Server の `date` 列を `DateOnly` と `DateTime` のどちらでスキャフォールドするかは何で決まるのか"
description: "決め手はスタートアッププロジェクトにある SQL Server プロバイダーの EF Core バージョンです。EF Core 7 以前は date を DateTime に、EF Core 8 から 11 までは DateOnly にスキャフォールドします。この判断を行う型マッピング、EF Core 7、8、10、11 RC 2 での実測出力、そして列を黙って datetime2 に再マッピングすることなく DateTime に戻す 2 つの方法を紹介します。"
pubDate: 2026-10-16
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "sql-server"
  - "scaffolding"
  - "dateonly"
lang: "ja"
translationOf: "2026/10/what-decides-whether-ef-core-scaffolds-a-sql-server-date-as-dateonly-or-datetime"
translatedBy: "claude"
translationDate: 2026-10-16
---

**結論:** 決め手は 1 つだけです。`dotnet ef dbcontext scaffold` を実行するときに、スタートアッププロジェクトが参照している `Microsoft.EntityFrameworkCore.SqlServer`(および `Microsoft.EntityFrameworkCore.Design`)のバージョンです。スキャフォールダーは、各ストア型の既定の CLR 型をプロバイダーの型マッピングソースに問い合わせます。EF Core 7 までは、この問い合わせは `date` に対して `DateTime`、`time` に対して `TimeSpan` を返します。EF Core 8 以降、EF Core 10 と EF Core 11 のリリース候補まで、返すのは `DateOnly` と `TimeOnly` です。これを変更する `dotnet ef` のスイッチはありません。`DateTime` に戻したい場合は、`IDesignTimeServices` で設計時の型マッピングを上書きするか、T4 テンプレートを編集します。公式の破壊的変更のノートにあるテンプレートの修正をそのまま使うと、`date` 列は実行時に `datetime2` としてマッピングされてしまいます。その理由と修正方法を、この記事の残りで説明します。

以下はすべて macOS 上で、SDK 10.0.302 と `Microsoft.EntityFrameworkCore.SqlServer` 7.0.20、8.0.32、10.0.13、11.0.0-rc.2.26504.105(SDK 11.0.100-rc.1 上)を使って測定しました。このマシンには SQL Server がないため、スキャフォールダーが通常 `INFORMATION_SCHEMA` から読み取る `DatabaseModel` を自分で組み立て、実際の SQL Server 設計時サービスに渡しました。コード生成の経路(スキャフォールディングのモデルファクトリ、C# ジェネレーター、T4 テンプレート)は、`dotnet ef dbcontext scaffold` がスキーマを読み取った後に実行するものと同じです。

## 判断するのはツールではなく型マッピングソース

スキャフォールドを実行すると、EF Core は各列のストア型(`date`、`datetime2`、`nvarchar(50)` など)を読み取り、CLR 型を選ぶ必要があります。このために専用のスキャフォールディングルール表があるわけではありません。`IScaffoldingTypeMapper.FindMapping(storeType, ...)` を呼び出し、それがプロバイダーの `IRelationalTypeMappingSource` にそのストア型の既定のマッピングを問い合わせます。プロバイダーが `date` に対して最初に登録した CLR 型が、そのままエンティティに入ります。

EF Core 8 で SQL Server プロバイダーに `DateOnly` と `TimeOnly` の組み込みサポートが追加され([dotnet/efcore#24507](https://github.com/dotnet/efcore/issues/24507))、`date` と `time` の既定のマッピングになりました。[EF Core 8 の破壊的変更のページ](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only)では、これは影響度が中程度の変更で、再スキャフォールドするデータベースファースト利用者にのみ影響するものとされています。

マッパーに直接問い合わせるプローブは次のとおりです。

```csharp
// .NET 10, EF Core 10.0.13 (same code compiles against 7.0.20, 8.0.32, 11.0.0-rc.2)
// Reference Microsoft.EntityFrameworkCore.Design with IncludeAssets="all" so the code can see its types.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Scaffolding.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Design.Internal;
using Microsoft.Extensions.DependencyInjection;

var services = new ServiceCollection();
new SqlServerDesignTimeServices().ConfigureDesignTimeServices(services);
services.AddEntityFrameworkDesignTimeServices();
var mapper = services.BuildServiceProvider().GetRequiredService<IScaffoldingTypeMapper>();

foreach (var storeType in new[] { "date", "time", "datetime", "datetime2", "smalldatetime", "datetimeoffset" })
    Console.WriteLine($"{storeType,-15} -> {mapper.FindMapping(storeType, keyOrIndex: false, rowVersion: false)?.ClrType.Name}");
```

結果を、プロバイダーのバージョンごとの列で示します。

| ストア型 | EF Core 7.0.20 | EF Core 8.0.32 | EF Core 10.0.13 | EF Core 11.0 RC 2 |
| --- | --- | --- | --- | --- |
| `date` | `DateTime` | `DateOnly` | `DateOnly` | `DateOnly` |
| `time` | `TimeSpan` | `TimeOnly` | `TimeOnly` | `TimeOnly` |
| `datetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetime2` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `smalldatetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetimeoffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` |

つまり、結果を決めるのは次の事実です。

- **スタートアッププロジェクトのプロバイダーパッケージのバージョン。** `dotnet ef` は `Microsoft.EntityFrameworkCore.Design` とプロバイダーをツールパッケージからではなくプロジェクトのビルド出力から読み込むため、マッピングはプロジェクトの EF Core バージョンから来ます。古い `dotnet-ef` ツールに固定しても `DateTime` は戻りません。"tools version is older than that of the runtime" という警告が出るだけか、もっと悪い結果になります。
- **データではなくストア型。** 変わったのは `date` と `time` です。`datetime`、`datetime2`、`smalldatetime` は、日付のみの型ではないため、どのバージョンでも `DateTime` にスキャフォールドされます。
- **プロバイダー。** これはプロバイダーごとの判断です。Npgsql の設計時サービス(10.0.3 で確認しました)も、PostgreSQL の `date` を `DateOnly`、`time` を `TimeOnly` にマッピングします。

それ以外は関係ありません。SQL Server のバージョン、データベースの互換性レベル、`--use-database-names`、`--data-annotations` のいずれも影響しません。

## スキャフォールドされたコードの前後比較

`int` のキー、`date NOT NULL`、null 許容の `date`、`time`、`datetime2` を持つテーブルをスキャフォールドしました。EF Core 7.0.20 は次のように出力します。

```csharp
// Scaffolded by EF Core 7.0.20
public partial class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
    public DateTime? ShippedOn { get; set; }
    public TimeSpan CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
    entity.Property(e => e.OrderDate).HasColumnType("date");
    entity.Property(e => e.ShippedOn).HasColumnType("date");
});
```

EF Core 8.0.32、10.0.13、11.0 RC 2 は、3 つとも同一の次の出力を行います。

```csharp
// Scaffolded by EF Core 8.0.32 / 10.0.13 / 11.0.0-rc.2
public partial class Order
{
    public int Id { get; set; }
    public DateOnly OrderDate { get; set; }
    public DateOnly? ShippedOn { get; set; }
    public TimeOnly CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
});
```

`OnModelCreating` から何が消えたかに注目してください。EF Core 7 では `DateTime` は規約により `datetime2` にマッピングされるため、スキャフォールダーは列を `date` のままにするために `HasColumnType("date")` を書く必要がありました。EF Core 8 以降では `DateOnly` が規約により `date` にマッピングされるため、スキャフォールダーは `HasColumnType("date")` を冗長と見なして省略します。列の型は生成コードのどこにもなくなり、CLR 型によって暗黙的に決まります。この点が、`DateTime` に戻すための一見簡単な方法が壊れている理由です。

## ドキュメントのテンプレート修正では列の型が失われる

破壊的変更のページでは回避策として、`dotnet new ef-templates` を実行し、`CodeTemplates/EFCore/EntityType.t4` を開いて、列が `date` または `time` の場合に CLR 型を差し替える方法が示されています。

```csharp
// EntityType.t4 snippet from the EF Core 8 breaking-changes page
var clrType = property.GetColumnType() switch
{
    "date" when property.ClrType == typeof(DateOnly) => typeof(DateTime),
    "date" when property.ClrType == typeof(DateOnly?) => typeof(DateTime?),
    "time" when property.ClrType == typeof(TimeOnly) => typeof(TimeSpan),
    "time" when property.ClrType == typeof(TimeOnly?) => typeof(TimeSpan?),
    _ => property.ClrType
};
```

この編集を EF Core 10.0.13 のテンプレート(`Microsoft.EntityFrameworkCore.Templates` 10.0.13)に適用して、再度スキャフォールドしました。エンティティは `DateTime OrderDate` になります。しかし `DbContext.t4` は、プロパティが `DateOnly` であるモデルからフルエント API をレンダリングするため、依然として `HasColumnType("date")` を出力しません。結果として、列の型がどこにもない `DateTime` プロパティができあがります。

すると実行時に EF Core は `DateTime` の規約、つまり `datetime2` を適用します。テンプレートが生成したものに相当するコンテキストと、列の型を復元したコンテキストを並べて示します。

```csharp
// .NET 10, EF Core 10.0.13
var day = new DateTime(2026, 10, 16);
foreach (DbContext db in new DbContext[] { new ImplicitContext(), new ExplicitContext() })
{
    var p = db.Model.FindEntityType(typeof(Order))!.FindProperty(nameof(Order.OrderDate))!;
    Console.WriteLine($"{db.GetType().Name}: {p.GetColumnType()}");
    Console.WriteLine(db.Set<Order>().Where(o => o.OrderDate == day).ToQueryString());
}

public class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
}

public class ImplicitContext() : ShopContext(false); // what the docs' template produces
public class ExplicitContext() : ShopContext(true);  // with HasColumnType("date")

public abstract class ShopContext(bool explicitType) : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlServer("Server=.;Database=Shop");
    protected override void OnModelCreating(ModelBuilder b) => b.Entity<Order>(e =>
    {
        e.Property(x => x.Id).ValueGeneratedNever();
        if (explicitType) e.Property(x => x.OrderDate).HasColumnType("date");
    });
}
```

出力:

```text
ImplicitContext: datetime2
DECLARE @day datetime2 = '2026-10-16T00:00:00.0000000';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
ExplicitContext: date
DECLARE @day date = '2026-10-16';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
```

列の型がないと、その列と比較されるすべてのパラメーターは `datetime2` としてワイヤー上を送られます。`datetime2` は `date` よりも[データ型の優先順位](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql)が高いため、SQL Server は比較のために列を `datetime2` に変換します。すると、時刻部分を持つ `DateTime` は保存された日付と決して等しくなりません。`date` パラメーターであれば、先に時刻が切り捨てられていたはずです。プロジェクトでマイグレーションも使っている場合、`GenerateCreateScript()` は `[OrderDate] datetime2 NOT NULL` を出力するようになり、そのテーブルに触れる次の `migrations add` は列の変更を求めてきます。スニペットの `time` 側は無害です。`TimeSpan` はもともと規約により `time` にマッピングされるからです。

修正は、同じテンプレートの `switch` の直後にブロックをもう 1 つ追加し、差し替えたプロパティがストア型も一緒に持つようにすることです。

```csharp
// CodeTemplates/EFCore/EntityType.t4, EF Core 10.0.13 templates, after the clrType switch
        usings.AddRange(code.GetRequiredUsings(clrType));

        if (clrType != property.ClrType)
        {
            // Keep the store type: DateTime/TimeSpan would otherwise map to datetime2/time by convention.
            usings.Add("System.ComponentModel.DataAnnotations.Schema");
#>
    [Column(TypeName = "<#= property.GetColumnType() #>")]
<#
        }
```

そのうえで、ドキュメントに示されているとおり、`needsNullable`、`needsInitializer`、およびプロパティの行の `property.ClrType` を `clrType` に置き換えます。再スキャフォールドすると、エンティティは次のようになります。

```csharp
// Scaffolded by EF Core 10.0.13 with the patched EntityType.t4
using System.ComponentModel.DataAnnotations.Schema;

public partial class Order
{
    public int Id { get; set; }

    [Column(TypeName = "date")]
    public DateTime OrderDate { get; set; }

    [Column(TypeName = "date")]
    public DateTime? ShippedOn { get; set; }

    [Column(TypeName = "time")]
    public TimeSpan CutoffTime { get; set; }

    public DateTime CreatedAt { get; set; }
}
```

属性は `--data-annotations` を渡したかどうかに関係なく出力されます。アノテーションのコードジェネレーターではなく、テンプレートのコードが書き出すためです。フルエント側は決してこれを書かないので、ここではそれが望ましい動作です。

## より確実な戻し方: 設計時に型マッピングを上書きする

テンプレートによる方法は、EF がすでにプロパティを `DateOnly` と決めた後で出力にパッチを当てるものです。より堅牢な選択肢は、判断そのものを変えることです。これにより、EF Core 8 以降が `date` と `time` について、フルエント API も含めて EF Core 7 とまったく同じ動作になります。`dotnet ef` はスタートアッププロジェクト内の `IDesignTimeServices` の実装を検出し、プロバイダーおよび EF 自身の登録の**後**に実行する(`DesignTimeServicesBuilder.CreateServiceCollection` を参照)ため、後から行う `AddSingleton` が優先されます。

```csharp
// .NET 10, EF Core 10.0.13 / 11.0. Lives in the startup project; only used by dotnet ef.
#pragma warning disable EF1001 // SqlServerTypeMappingSource is an internal API
using System.Data;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.SqlServer.Infrastructure.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;

public sealed class ShopDesignTimeServices : IDesignTimeServices
{
    public void ConfigureDesignTimeServices(IServiceCollection services)
        => services.AddSingleton<IRelationalTypeMappingSource, DateTimeScaffoldingTypeMappingSource>();
}

public sealed class DateTimeScaffoldingTypeMappingSource(
    TypeMappingSourceDependencies dependencies,
    RelationalTypeMappingSourceDependencies relationalDependencies,
    ISqlServerSingletonOptions sqlServerSingletonOptions)
    : SqlServerTypeMappingSource(dependencies, relationalDependencies, sqlServerSingletonOptions)
{
    protected override RelationalTypeMapping? FindMapping(in RelationalTypeMappingInfo mappingInfo)
        => mappingInfo.StoreTypeNameBase switch
        {
            "date" => new SqlServerDateTimeTypeMapping("date", DbType.Date),
            "time" => new SqlServerTimeSpanTypeMapping("time"),
            _ => base.FindMapping(mappingInfo)
        };
}
```

これを登録すると、EF Core 10.0.13 は同じテーブルを EF Core 7 の出力とバイト単位で同一にスキャフォールドします。つまり `DateTime OrderDate`、`DateTime? ShippedOn`、`TimeSpan CutoffTime` となり、`OnModelCreating` には `HasColumnType("date")` が戻ります。比較が `DateTime` とその既定の `datetime2` の間で行われるようになるため、コードジェネレーターは明示的な列の型が必要だと判断します。`time(0)` 列も正しく出力され、標準の EF Core 10 が `TimeOnly` と `HasPrecision(0)` を書くところで、`HasColumnType("time(0)")` になります。

この方法について知っておくべき点が 3 つあります。

- `SqlServerTypeMappingSource` は `Internal` 名前空間にあるため、`EF1001` の抑制が必要です。コンストラクターは EF Core 8 と 9 では 2 つのパラメーターでしたが、EF Core 10 で `ISqlServerSingletonOptions` が加わったため、メジャーアップグレードのたびにこのクラスの修正が必要になると考えてください。
- 影響するのは設計時だけです。`IDesignTimeServices` はツールによってのみ呼び出されるため、実行時の `DbContext` がこのサービスを目にすることはありません。
- `TryAddSingleton` ではなく `AddSingleton` を使ってください。プロバイダーはすでに型マッピングソースを登録しているため、`TryAdd` では何も起こらず、エラーにもなりません。同じ落とし穴は、[`dbcontext scaffold` の複数形化ツールを置き換える](/ja/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/)ときにも現れます。

EF Core Power Tools またはその `efcpt` CLI でスキャフォールドする場合、これはすでに組み込まれています。そのリバースエンジニアリングエンジンには、まさに上記の処理を行う `SqlServerTypeMappingSource` のオーバーライドが含まれており、`efcpt-config.json` の `type-mappings` / `use-DateOnly-TimeOnly` で切り替えられます。公開されている設定スキーマではこの設定の既定値は `false` とされているため、どちらの型になるかを思い込まず、設定ファイルを確認してください。

## そもそも元に戻すべきか

通常は戻す必要はありません。暦上の日を保持する列にとって、`DateOnly` は正直な型です。`date` にマッピングされた `DateTime` は、データベースが破棄する時刻と `Kind` を持ち続けます。この不一致は、値がタイムゾーンや JSON の境界をまたぐときに起こる、1 日ずれるバグの多くの原因です。EF Core 8 以降は SQL Server で一般的な `DateOnly` のメンバーを変換でき、`System.Text.Json` は標準で `"2026-10-16"` とシリアル化し、Dapper も[2.1.86 以降は `DateOnly` をネイティブに処理します](/ja/2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support/)。

同じリリースで利用側を移行できない場合は、戻すことになります。たとえば共有の DTO アセンブリ、あらゆる箇所で `DateTime` の演算を行うレポート層、毎週再スキャフォールドしていて数百件のコンパイルエラーを一度に吸収できないチームなどです。その場合は上記 2 つの修正のどちらかを選び、リポジトリの一部にして、次に再スキャフォールドする人が同じ型を得られるようにしてください。

## 再スキャフォールド後に出てくる落とし穴

- **中途半端に移行されたモデル。** `--table` で一部のテーブルだけをスキャフォールドすると、新しいエンティティは `DateOnly` になり、手作業で保守されている古いものは `DateTime` のままになります。EF Core 8 以降は `HasColumnType("date")` を指定した `DateTime` も問題なくマッピングするため、どちらも動作しますが、それらをまたぐ結合や比較には C# での変換が必要になります。スキャフォールドした日付ごとではなく、列ごとに 1 つの型に決めてください。
- **コードファーストのモデルは影響を受けません。** 既存の `DateTime` プロパティの既定は依然として `datetime2` で、明示的な `HasColumnType("date")` も引き続き機能します。パッケージをアップグレードしても、実行時には何も変わりません。変わるのは新しく生成されるコードだけです。アップグレード後にマイグレーションが突然列の変更を求めてきた場合は、上記のような列の型の欠落を探し、そのうえで[EF Core がペンディング中のモデル変更を報告する理由](/ja/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/)を読んでください。
- **`datetime` は `DateTime` のままです。** 変わったのは `date` と `time` だけです。レガシーな `datetime` 列(3.33 ms の精度)は、どのバージョンでも `HasColumnType("datetime")` 付きの `DateTime` としてスキャフォールドされます。
- **ErikEJ パッケージを使った EF Core 6 または 7 からのアップグレード。** EF Core 8 より前に `DateOnly` を得るために `ErikEJ.EntityFrameworkCore.SqlServer.DateOnlyTimeOnly` と `UseDateOnlyTimeOnly()` を使っていた場合は、アップグレード時に両方を削除してください。このサポートはいまや組み込みです。そのアップグレードの残りの部分は、[EF Core 6 から 11 への破壊的変更のウォークスルー](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)で扱っています。
- **C# ではなく SQL を確認してください。** 上記の `datetime2` への再マッピングはコンパイルでき、実行でき、真夜中の値に対してはもっともらしい結果を返します。見分ける唯一の方法はパラメーターの型なので、スキャフォールディングをカスタマイズした後は、[EF Core が生成する SQL をログに出力する](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)か、`ToQueryString()` を一度呼び出してください。

## 関連記事

- [How to add custom pluralization to `dotnet ef dbcontext scaffold` with `IPluralizer`](/ja/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/): 同じクラスに入れることになる、もう 1 つの `IDesignTimeServices` フックです。
- [Migrate EF Core 6 to EF Core 11: the breaking changes that bite](/ja/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix "The JSON value could not be converted to System.DateTime"](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/): ワイヤー上の値が `DateOnly` であるべき場合も含みます。
- [How to log the SQL that EF Core 11 generates](/ja/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## 参考資料

- [Breaking changes in EF Core 8.0: SQL Server `date` and `time` now scaffold to `DateOnly` and `TimeOnly`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only), Microsoft Learn.
- [dotnet/efcore#24507: DateOnly and TimeOnly support for SQL Server](https://github.com/dotnet/efcore/issues/24507)
- [Custom reverse engineering templates (T4)](https://learn.microsoft.com/en-us/ef/core/managing-schemas/scaffolding/templates), Microsoft Learn.
- [Design-time services](https://learn.microsoft.com/en-us/ef/core/cli/services), Microsoft Learn.
- [`DesignTimeServicesBuilder.cs` on the release/10.0 branch](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Design/Internal/DesignTimeServicesBuilder.cs), dotnet/efcore.
- [Data type precedence (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql), Microsoft Learn.
- [EF Core Power Tools `SqlServerTypeMappingSource`](https://github.com/ErikEJ/EFCorePowerTools/blob/master/src/Core/RevEng.Core.80/SqlServerTypeMappingSource.cs) and [efcpt config schema](https://github.com/ErikEJ/EFCorePowerTools/blob/master/samples/efcpt-schema.json), ErikEJ/EFCorePowerTools.
