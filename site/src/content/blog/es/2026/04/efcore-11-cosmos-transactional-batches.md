---
title: "EF Core 11 prende transactional batches de Cosmos DB por default"
description: "EF Core 11 agrupa writes de Cosmos DB en transactional batches por container y partition en cada SaveChanges, dando atomicidad best-effort y menos roundtrips sin cambios de código."
pubDate: 2026-04-14
tags:
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
  - "azure"
lang: "es"
translationOf: "2026/04/efcore-11-cosmos-transactional-batches"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 cambió discretamente cómo el provider de Azure Cosmos DB guarda datos. Hasta EF Core 10 cada insert, update, o delete trackeado iba a Cosmos como su propio request, lo que significaba que un `SaveChangesAsync` de N rows se convertía en N llamadas HTTP separadas, N sets de cargos RU, y cero atomicidad. Arrancando con EF Core 11 el provider agrupa esas operaciones en [transactional batches de Cosmos DB](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch) automáticamente. No tienes que hacer opt-in y no tienes que reescribir tu código de data access.

## Qué cambió en SaveChanges

Un transactional batch en Cosmos empaqueta hasta 100 point operations que apuntan al mismo container y la misma logical partition en un solo roundtrip, ejecutado atómicamente en el server side. EF Core 11 ahora inspecciona el change tracker, agrupa entries por container y partition key, y dispara un batch por grupo. Las [release notes de EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#transactional-batches) describen el comportamiento: los batches se ejecutan secuencialmente, y si un batch falla, los siguientes no se ejecutan.

El comportamiento se controla por la nueva opción `AutoTransactionBehavior`:

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

`Auto` agrupa lo que pueda. `Never` restaura el comportamiento viejo de request-por-entry si lo necesitas por compatibilidad. `Always` es útil cuando tu dominio requiere un write all-or-nothing y quieres que EF tire al momento del save en lugar de dejarte con una mutación half-applied.

## Por qué importa el agrupamiento por partition

Como los batches están scopeados a una logical partition, la forma de tus writes ahora afecta directamente cuántos roundtrips pagas. Escribir diez orders que comparten la misma `CustomerId` partition key es un solo batch. Escribir diez orders a diez customers distintos son diez batches. Considera este modelo:

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

Un job nocturno que inserta veinte nuevas orders y actualiza sus totales para un customer ahora golpea Cosmos una vez, no cuarenta:

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

Si necesitas atomicidad estricta puedes setear `AutoTransactionBehavior.Always` por context. EF tirará si el working set requiriera más de un batch (partitions distintas, containers distintos, o más que el límite de servicio de operaciones), lo que fuerza al problema a surgir en tus tests en lugar de en producción después de un write parcial.

## Cuándo apagarlo

Todavía hay casos donde `Never` es la respuesta correcta. Si tu code path depende de una falla específica aislándose a un solo document (por ejemplo, un upsert best-effort sobre el que quieres continuar en conflict), las semánticas de batch cambiarán eso: una operación mala aborta el batch. El provider pre-11 habría disparado cada request independientemente. Valida tu error handling antes de tomar el upgrade a producción, y usa `AutoTransactionBehavior.Never` si necesitas las semánticas viejas.

Combinado con el nuevo [modo de ejecución bulk](https://learn.microsoft.com/en-us/ef/core/providers/cosmos/saving#bulk-execution) y el soporte first-class de [complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#complex-types) en el provider Cosmos, EF Core 11 es la primera release donde la experiencia Cosmos se siente a la par de los providers relacionales para workloads write-heavy. El upgrade es mecánico, el default es más seguro, y los ahorros de RU en workloads partition-aligned son inmediatos.
