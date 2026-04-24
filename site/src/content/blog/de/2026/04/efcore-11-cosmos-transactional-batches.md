---
title: "EF Core 11 schaltet Cosmos-DB-Transaktionsbatches standardmäßig an"
description: "EF Core 11 gruppiert Cosmos-DB-Writes bei jedem SaveChanges in transaktionale Batches pro Container und Partition und liefert damit Best-Effort-Atomarität und weniger Roundtrips ohne Codeänderungen."
pubDate: 2026-04-14
tags:
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
  - "azure"
lang: "de"
translationOf: "2026/04/efcore-11-cosmos-transactional-batches"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 hat still geändert, wie der Azure-Cosmos-DB-Provider Daten speichert. Bis EF Core 10 ging jeder getrackte Insert, Update oder Delete als eigener Request an Cosmos, was hieß, dass ein N-Row-`SaveChangesAsync` in N separate HTTP-Calls, N Sets von RU-Charges und null Atomarität verwandelt wurde. Ab EF Core 11 gruppiert der Provider diese Operationen automatisch in [Cosmos-DB-Transaktionsbatches](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch). Sie müssen nicht opt-in machen, und Sie müssen Ihren Data-Access-Code nicht neu schreiben.

## Was sich in SaveChanges geändert hat

Ein Transaktionsbatch in Cosmos bündelt bis zu 100 Point Operations, die denselben Container und dieselbe logische Partition adressieren, in einen einzelnen Roundtrip, serverseitig atomar ausgeführt. EF Core 11 inspiziert jetzt den Change Tracker, gruppiert Entries nach Container und Partition Key und gibt ein Batch pro Gruppe aus. Die [EF-Core-11-Release-Notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#transactional-batches) beschreiben das Verhalten: Batches werden sequenziell ausgeführt, und wenn ein Batch fehlschlägt, werden die nachfolgenden Batches nicht ausgeführt.

Das Verhalten wird durch die neue Option `AutoTransactionBehavior` gesteuert:

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

`Auto` gruppiert, was es kann. `Never` stellt das alte Request-pro-Entry-Verhalten wieder her, wenn Sie es aus Kompatibilitätsgründen brauchen. `Always` ist nützlich, wenn Ihre Domäne einen All-or-Nothing-Write verlangt und Sie wollen, dass EF zur Save-Zeit wirft, statt Sie mit einer teilweise angewendeten Mutation zurückzulassen.

## Warum die Partitions-Gruppierung zählt

Weil Batches auf eine logische Partition beschränkt sind, beeinflusst die Form Ihrer Writes jetzt direkt, wie viele Roundtrips Sie zahlen. Zehn Orders zu schreiben, die alle denselben `CustomerId`-Partitions-Key teilen, ist ein einzelnes Batch. Zehn Orders an zehn verschiedene Kunden zu schreiben sind zehn Batches. Betrachten Sie dieses Modell:

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

Ein Nachtjob, der zwanzig neue Orders einfügt und deren Totals für einen Kunden aktualisiert, trifft Cosmos jetzt einmal, nicht vierzigmal:

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

Wenn Sie strikte Atomarität brauchen, können Sie `AutoTransactionBehavior.Always` pro Context setzen. EF wird werfen, wenn das Working Set mehr als ein Batch erfordern würde (unterschiedliche Partitionen, unterschiedliche Container oder mehr als das Service-Limit für Operationen), was das Problem in Ihren Tests auftauchen lässt, statt in Produktion nach einem teilweisen Write.

## Wann es ausschalten

Es gibt immer noch Fälle, in denen `Never` die richtige Antwort ist. Wenn Ihr Code-Pfad von einem spezifischen Fehler abhängt, der auf ein einzelnes Dokument isoliert ist (zum Beispiel ein Best-Effort-Upsert, über den Sie bei Konflikt fortfahren wollen), werden Batch-Semantiken das ändern: Eine schlechte Operation bricht das Batch ab. Der Pre-11-Provider hätte jeden Request unabhängig abgefeuert. Validieren Sie Ihr Error Handling, bevor Sie das Upgrade in Produktion nehmen, und nutzen Sie `AutoTransactionBehavior.Never`, wenn Sie die alten Semantiken brauchen.

Kombiniert mit dem neuen [Bulk-Execution-Mode](https://learn.microsoft.com/en-us/ef/core/providers/cosmos/saving#bulk-execution) und dem First-Class-Support für [Complex Types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#complex-types) im Cosmos-Provider ist EF Core 11 die erste Release, in der die Cosmos-Erfahrung für schreib-lastige Workloads mit den relationalen Providern gleichzieht. Das Upgrade ist mechanisch, der Default ist sicherer und die RU-Einsparungen bei partitions-ausgerichteten Workloads sind unmittelbar.
