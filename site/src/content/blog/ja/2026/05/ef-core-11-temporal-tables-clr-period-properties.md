---
title: "EF Core 11 Preview 4: テンポラルテーブルの期間列がついに本物のプロパティになれる"
description: "EF Core 11 Preview 4 で SQL Server テンポラルテーブルに対する長年の shadow プロパティ制約が撤廃されました。PeriodStart と PeriodEnd を通常の CLR プロパティとして宣言し、強く型付けされた HasPeriodStart と HasPeriodEnd のラムダで設定できます。"
pubDate: 2026-05-26
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2026/05/ef-core-11-temporal-tables-clr-period-properties"
translatedBy: "claude"
translationDate: 2026-05-26
---

EF Core はバージョン 6.0 から SQL Server のテンポラルテーブルをサポートしてきましたが、ひとつ厄介な制約がありました。`PeriodStart` と `PeriodEnd` の列は shadow プロパティとしてモデリングしなければならなかったのです。`EF.Property<DateTime>(entity, "PeriodStart")` で値を取得することはできましたが、エンティティクラスに置いて他の列と同じように読み取ることはできませんでした。この制約は EF Core 11 Preview 4 で解消されました。2026 年 5 月 12 日に [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/) の一部としてリリースされています。

修正は [efcore#38110](https://github.com/dotnet/efcore/pull/38110) として入り、[2021 年に立てられた issue](https://github.com/dotnet/efcore/issues/26463) をクローズしました。コード行数で見れば小さな変更ですが、エルゴノミクス上は大きな改善です。

## これまでの shadow プロパティモデル

Preview 4 以前は、テンポラルエンティティはアプリケーションの列だけを宣言できました。期間列はモデル上には存在しても、クラス上には存在しませんでした。

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal());
```

期間の値を読み取るには change tracker を経由する必要がありました。

```csharp
var start = context.Entry(order).Property<DateTime>("PeriodStart").CurrentValue;
var end   = context.Entry(order).Property<DateTime>("PeriodEnd").CurrentValue;
```

問題は 2 つあります。まず IntelliSense とリファクタリングの安全性が失われます。列名はマジックストリングだからです。次に、CLR 型上にプロパティが存在しないため、LINQ クエリで期間値を射影するのが扱いにくくなります。妥当期間を含む DTO をマッピングするには、生の SQL クエリか `Select` の中の `EF.Property<>` のどちらかが必要で、どちらも型システムとぶつかります。

## Preview 4 のモデル

Preview 4 では期間列をエンティティに置くだけで済みます。

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }
}
```

ラムダを受け取る新しい強く型付けされた `HasPeriodStart` と `HasPeriodEnd` のオーバーロードで設定します。

```csharp
modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal(ttb =>
{
    ttb.HasPeriodStart(o => o.PeriodStart);
    ttb.HasPeriodEnd(o => o.PeriodEnd);
}));
```

これで `PeriodStart` と `PeriodEnd` は他のマッピング済み列と同じように振る舞います。マテリアライズされたエンティティから読み取り、`Select` で射影し、ソートし、通常の LINQ でフィルタリングできます。

```csharp
var openOrders = await context.Orders
    .Where(o => o.PeriodEnd == DateTime.MaxValue)
    .Select(o => new { o.Id, o.Status, o.PeriodStart })
    .ToListAsync();
```

`PeriodEnd == DateTime.MaxValue` という述語は、SQL Server テンポラルテーブルにおける「現在の行」を表す定型的なフィルターです。以前はこれを shadow プロパティに対して書く必要がありました。

## 変わらない部分

データベース側のテンポラルテーブルのセマンティクスは同じです。SQL Server は履歴テーブルを引き続き保守し、書き込みのたびに `PeriodStart` と `PeriodEnd` を更新し、期間列への直接書き込みを引き続き拒否します。EF Core はそれらを `ValueGeneratedOnAddOrUpdate` としてマークし、insert と update では無視します。読み取りはできますが、設定はできません。

タイムトラベルクエリも同じように動作します。

```csharp
var snapshot = await context.Orders
    .TemporalAsOf(new DateTime(2026, 5, 1))
    .ToListAsync();
```

唯一の違いは、返されるエンティティが期間値を `EF.Property<>` の裏に隠すのではなく、CLR オブジェクト上に保持するようになった点です。

## マイグレーションは任意

既存のモデルで shadow の期間列を使っているなら、何も変える必要はありません。古い API はそのまま動きます。新しいテンポラルエンティティについては、`PeriodStart` と `PeriodEnd` をクラス上に置くのが最も抵抗の少ない道です。

Preview 4 の EF Core 全リリースノート: [release-notes/11.0/preview/preview4/efcore.md](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/efcore.md)。
