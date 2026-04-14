---
title: "EF Core 11 turns on Cosmos DB transactional batches by default"
description: "EF Core 11 groups Cosmos DB writes into transactional batches per container and partition on every SaveChanges, giving best-effort atomicity and fewer roundtrips without any code changes."
pubDate: 2026-04-14
tags:
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
  - "azure"
---

EF Core 11 quietly changed how the Azure Cosmos DB provider saves data. Until EF Core 10 every tracked insert, update, or delete went to Cosmos as its own request, which meant an N-row `SaveChangesAsync` turned into N separate HTTP calls, N sets of RU charges, and no atomicity. Starting with EF Core 11 the provider groups those operations into [Cosmos DB transactional batches](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch) automatically. You do not have to opt in and you do not have to rewrite your data access code.

## What changed on SaveChanges

A transactional batch in Cosmos bundles up to 100 point operations that target the same container and the same logical partition into a single roundtrip, executed atomically on the server side. EF Core 11 now inspects the change tracker, groups entries by container and partition key, and issues one batch per group. The [EF Core 11 release notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#transactional-batches) describe the behavior: batches are executed sequentially, and if a batch fails, the subsequent batches are not executed.

The behavior is controlled by the new `AutoTransactionBehavior` option:

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

`Auto` groups whatever it can. `Never` restores the old request-per-entry behavior if you need it for compatibility. `Always` is useful when your domain requires an all-or-nothing write and you want EF to throw at save time rather than leave you with a half-applied mutation.

## Why the partition grouping matters

Because batches are scoped to one logical partition, the shape of your writes now directly affects how many roundtrips you pay for. Writing ten orders that all share the same `CustomerId` partition key is a single batch. Writing ten orders to ten different customers is ten batches. Consider this model:

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

A nightly job that inserts twenty new orders and updates their totals for one customer now hits Cosmos once, not forty times:

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

If you need strict atomicity you can set `AutoTransactionBehavior.Always` per context. EF will throw if the working set would require more than one batch (different partitions, different containers, or more than the service limit of operations), which forces the problem to surface in your tests rather than in production after a partial write.

## When to turn it off

There are still cases where `Never` is the right answer. If your code path relies on a specific failure isolating to a single document (for example, a best-effort upsert that you want to continue past on conflict), batch semantics will change that: one bad operation aborts the batch. The pre-11 provider would have fired each request independently. Validate your error handling before taking the upgrade into production, and use `AutoTransactionBehavior.Never` if you need the old semantics.

Combined with the new [bulk execution mode](https://learn.microsoft.com/en-us/ef/core/providers/cosmos/saving#bulk-execution) and the first-class [complex types support](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#complex-types) in the Cosmos provider, EF Core 11 is the first release where the Cosmos experience feels on par with the relational providers for write-heavy workloads. The upgrade is mechanical, the default is safer, and the RU savings on partition-aligned workloads are immediate.
