---
title: "EF Core 11 がデフォルトで Cosmos DB transactional batch を有効にする"
description: "EF Core 11 は Cosmos DB の書き込みを SaveChanges ごとに container と partition 単位で transactional batch にグループ化し、コード変更なしで best-effort な原子性とラウンドトリップ削減を提供します。"
pubDate: 2026-04-14
tags:
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
  - "azure"
lang: "ja"
translationOf: "2026/04/efcore-11-cosmos-transactional-batches"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 は Azure Cosmos DB provider のデータ保存方法を静かに変えました。EF Core 10 までは、すべての tracked な insert、update、delete が独自の request として Cosmos に送られており、N 行の `SaveChangesAsync` が N 個の別々の HTTP 呼び出し、N 組の RU 課金、そして原子性ゼロになっていました。EF Core 11 から provider はこれらの操作を自動的に [Cosmos DB transactional batch](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch) にグループ化します。opt-in も、data access コードの書き直しも不要です。

## SaveChanges で何が変わったか

Cosmos の transactional batch は、同じ container と同じ logical partition を対象とする最大 100 個の point operation を単一のラウンドトリップにまとめ、サーバー側で原子的に実行します。EF Core 11 は今や change tracker を検査し、entry を container と partition key でグループ化し、グループごとに 1 つの batch を発行します。[EF Core 11 リリースノート](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#transactional-batches) が挙動を記述します: batch は逐次実行され、batch が失敗すると後続の batch は実行されません。

挙動は新しい `AutoTransactionBehavior` オプションで制御されます:

```csharp
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
{
    optionsBuilder.UseCosmos(
        connectionString: Configuration["Cosmos:ConnectionString"],
        databaseName: "OrdersDB",
        cosmosOptions =>
        {
            // Auto is the new default in EF Core 11.
            // Never reproduces the pre-11 one-request-per-entry behavior.
            // Always forces the whole SaveChanges to fit in one batch.
        });
}
```

`Auto` はできるものをグループ化します。`Never` は互換性のために必要なら 11 以前の 1-リクエスト-per-entry の挙動を復元します。`Always` はドメインが all-or-nothing 書き込みを要求し、half-applied ミューテーションを残されるのではなく save 時に EF が例外を投げてほしいときに便利です。

## partition グループ化がなぜ重要か

batch は 1 つの logical partition にスコープされるので、書き込みの形状があなたが支払うラウンドトリップ数に直接影響します。同じ `CustomerId` partition key を共有する 10 件の order を書くのは単一の batch です。10 件の異なる customer に 10 件の order を書くのは 10 個の batch です。このモデルを考えてください:

```csharp
public class Order
{
    public Guid Id { get; set; }
    public string CustomerId { get; set; } = null!;
    public decimal Total { get; set; }
    public List<OrderItem> Items { get; set; } = new();
}

public class OrdersContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Order>()
            .ToContainer("Orders")
            .HasPartitionKey(o => o.CustomerId);
    }
}
```

1 人の customer に対して 20 件の新しい order を挿入し total を更新する nightly ジョブは、今や 40 回ではなく 1 回だけ Cosmos を叩きます:

```csharp
await using var context = new OrdersContext();

for (int i = 0; i < 20; i++)
{
    context.Orders.Add(new Order
    {
        Id = Guid.NewGuid(),
        CustomerId = "cust-42",
        Total = 0m
    });
}

// Single transactional batch, atomic, one roundtrip.
await context.SaveChangesAsync();
```

厳密な原子性が必要なら、context ごとに `AutoTransactionBehavior.Always` を設定できます。working set が複数の batch を必要とする場合 (異なる partition、異なる container、または操作のサービス上限を超える)、EF は例外を投げ、問題を部分書き込み後の本番ではなくテストで表面化させます。

## いつオフにするか

`Never` が正しい答えであるケースはまだあります。code path が単一のドキュメントに分離された特定の失敗に依存している場合 (例えば、conflict 時にスキップしたい best-effort upsert など)、batch セマンティクスはそれを変えます: 1 つの失敗が batch を中止します。11 以前の provider なら各 request を独立に発火していました。アップグレードを本番に入れる前にエラーハンドリングを検証し、古いセマンティクスが必要なら `AutoTransactionBehavior.Never` を使ってください。

新しい [bulk execution mode](https://learn.microsoft.com/en-us/ef/core/providers/cosmos/saving#bulk-execution) と Cosmos provider の first-class な [complex types サポート](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#complex-types) と組み合わせて、EF Core 11 は書き込み重視のワークロードで Cosmos 体験がリレーショナル provider と肩を並べる最初のリリースです。アップグレードは機械的で、デフォルトは安全で、partition-aligned ワークロードでの RU 節約は即時です。
