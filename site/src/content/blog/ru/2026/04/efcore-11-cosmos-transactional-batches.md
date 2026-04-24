---
title: "EF Core 11 включает transactional batches Cosmos DB по умолчанию"
description: "EF Core 11 группирует writes Cosmos DB в transactional batches по container и partition на каждом SaveChanges, давая best-effort атомарность и меньше roundtrips без изменений кода."
pubDate: 2026-04-14
tags:
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
  - "azure"
lang: "ru"
translationOf: "2026/04/efcore-11-cosmos-transactional-batches"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 тихо изменил то, как provider Azure Cosmos DB сохраняет данные. До EF Core 10 каждый tracked insert, update или delete шёл в Cosmos как отдельный request, что значило N-строчный `SaveChangesAsync` превращается в N отдельных HTTP-вызовов, N наборов RU-зарядов и ноль атомарности. Начиная с EF Core 11 provider автоматически группирует эти операции в [transactional batches Cosmos DB](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch). Не нужно делать opt-in и не нужно переписывать data access.

## Что изменилось в SaveChanges

Transactional batch в Cosmos упаковывает до 100 point operations, нацеленных на один container и одну логическую partition в один roundtrip, атомарно выполненный на server side. EF Core 11 теперь инспектирует change tracker, группирует entries по container и partition key и выдаёт один batch на группу. [Release notes EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#transactional-batches) описывают поведение: batches выполняются последовательно, и если batch падает, следующие batches не выполняются.

Поведение контролируется новой опцией `AutoTransactionBehavior`:

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

`Auto` группирует всё, что может. `Never` восстанавливает старое поведение request-per-entry, если оно нужно для совместимости. `Always` полезно, когда ваш домен требует all-or-nothing записи и вы хотите, чтобы EF падал на save, а не оставлял вас с half-applied мутацией.

## Почему group by partition важно

Поскольку batches ограничены одной логической partition, форма ваших writes теперь напрямую влияет на количество roundtrips, за которые вы платите. Писать десять orders, разделяющих одну и ту же `CustomerId` partition key - это один batch. Писать десять orders десяти разным customers - это десять batches. Рассмотрите эту модель:

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

Ночной job, вставляющий двадцать новых orders и обновляющий их totals для одного customer, теперь бьёт Cosmos один раз, а не сорок:

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

Если нужна строгая атомарность, можно установить `AutoTransactionBehavior.Always` на context. EF кинет, если working set потребовал бы больше одного batch (разные partitions, разные containers или больше сервисного лимита операций), что заставит проблему всплыть в ваших тестах, а не в продакшне после частичной записи.

## Когда выключать

Всё ещё есть случаи, когда `Never` - правильный ответ. Если ваш code path опирается на изоляцию конкретного сбоя в одном документе (например, best-effort upsert, который вы хотите продолжить при conflict), batch-семантика это изменит: одна плохая операция прерывает batch. Pre-11 provider отправил бы каждый request независимо. Проверьте обработку ошибок до того, как ввести апгрейд в прод, и используйте `AutoTransactionBehavior.Never`, если нужна старая семантика.

В сочетании с новым [bulk execution mode](https://learn.microsoft.com/en-us/ef/core/providers/cosmos/saving#bulk-execution) и first-class поддержкой [complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#complex-types) в Cosmos provider, EF Core 11 - первый релиз, где Cosmos-опыт ощущается на уровне реляционных providers для write-heavy нагрузок. Апгрейд механический, дефолт безопаснее, а экономия RU на partition-aligned нагрузках - немедленная.
