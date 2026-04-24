---
title: "EF Core 11 liga transactional batches de Cosmos DB por padrão"
description: "EF Core 11 agrupa writes de Cosmos DB em transactional batches por container e partition em cada SaveChanges, dando atomicidade best-effort e menos roundtrips sem mudanças de código."
pubDate: 2026-04-14
tags:
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
  - "azure"
lang: "pt-br"
translationOf: "2026/04/efcore-11-cosmos-transactional-batches"
translatedBy: "claude"
translationDate: 2026-04-24
---

EF Core 11 mudou silenciosamente como o provider do Azure Cosmos DB salva dados. Até o EF Core 10 todo insert, update, ou delete trackeado ia pro Cosmos como request próprio, o que significava que um `SaveChangesAsync` de N rows virava N chamadas HTTP separadas, N conjuntos de cobranças RU, e nenhuma atomicidade. Começando com EF Core 11 o provider agrupa essas operações em [transactional batches do Cosmos DB](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch) automaticamente. Você não precisa fazer opt-in e não precisa reescrever seu código de data access.

## O que mudou no SaveChanges

Um transactional batch no Cosmos empacota até 100 point operations que miram o mesmo container e a mesma logical partition num único roundtrip, executado atomicamente no lado server. EF Core 11 agora inspeciona o change tracker, agrupa entries por container e partition key, e emite um batch por grupo. As [release notes do EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#transactional-batches) descrevem o comportamento: batches são executados sequencialmente, e se um batch falha, os subsequentes não são executados.

O comportamento é controlado pela nova opção `AutoTransactionBehavior`:

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

`Auto` agrupa o que puder. `Never` restaura o comportamento antigo de request por entry se precisar por compatibilidade. `Always` é útil quando seu domínio exige um write all-or-nothing e você quer que o EF jogue no save em vez de te deixar com uma mutação half-applied.

## Por que o agrupamento por partition importa

Porque batches são escopados a uma logical partition, a forma dos seus writes agora afeta diretamente quantos roundtrips você paga. Escrever dez orders que compartilham a mesma `CustomerId` partition key é um único batch. Escrever dez orders pra dez customers diferentes é dez batches. Considere esse modelo:

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

Um job noturno que insere vinte novas orders e atualiza seus totais pra um customer agora bate no Cosmos uma vez, não quarenta:

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

Se você precisa de atomicidade estrita pode setar `AutoTransactionBehavior.Always` por context. EF vai jogar se o working set precisasse de mais de um batch (partitions diferentes, containers diferentes, ou mais do que o limite de serviço de operações), o que força o problema a aflorar nos seus testes em vez de em produção depois de um write parcial.

## Quando desligar

Ainda há casos onde `Never` é a resposta certa. Se seu code path depende de uma falha específica isolada a um único document (por exemplo, um upsert best-effort em que você quer continuar em conflict), as semânticas de batch vão mudar isso: uma operação ruim aborta o batch. O provider pre-11 teria disparado cada request independentemente. Valide seu error handling antes de levar o upgrade pra produção, e use `AutoTransactionBehavior.Never` se precisar das semânticas antigas.

Combinado com o novo [modo de execução bulk](https://learn.microsoft.com/en-us/ef/core/providers/cosmos/saving#bulk-execution) e o suporte first-class a [complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew#complex-types) no provider Cosmos, EF Core 11 é a primeira release onde a experiência Cosmos parece no mesmo nível dos providers relacionais pra workloads write-heavy. O upgrade é mecânico, o default é mais seguro, e as economias de RU em workloads partition-aligned são imediatas.
