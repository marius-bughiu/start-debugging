---
title: "EF Core 11 Adds Native SQL Server Vector Search with DiskANN Indexes"
description: "EF Core 11 Preview 2 supports SQL Server 2025 VECTOR_SEARCH() and DiskANN vector indexes directly from LINQ. Here is how to set up the index, run approximate queries, and what changes from the EF Core 10 VectorDistance approach."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "sql-server"
  - "csharp"
  - "dotnet"
---

EF Core 10 introduced `EF.Functions.VectorDistance()` for computing exact distances between embeddings in LINQ queries. That works, but exact search over millions of rows is expensive. EF Core 11 Preview 2 closes the gap by supporting SQL Server 2025's approximate vector search: DiskANN indexes and the `VECTOR_SEARCH()` table-valued function, all wired up through your `DbContext`.

## Setting up a vector index

Declare the index in `OnModelCreating` with the distance metric you want (cosine, dot product, or Euclidean):

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasVectorIndex(b => b.Embedding, "cosine");
}
```

When you add a migration, EF generates the `CREATE VECTOR INDEX` DDL targeting SQL Server 2025's DiskANN engine. The index lives alongside your regular B-tree and full-text indexes, managed through the same migration pipeline.

## Querying with VectorSearch()

Once the index exists, use the new `VectorSearch()` extension method on your `DbSet`:

```csharp
float[] queryEmbedding = GetEmbeddingForQuery("distributed caching");

var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 5)
    .ToListAsync();
```

This translates to SQL Server's `VECTOR_SEARCH()` table-valued function, which performs an approximate nearest-neighbor lookup against the DiskANN index. The `topN` parameter caps how many results come back.

The return type is `VectorSearchResult<TEntity>`, which exposes both the entity and the computed distance:

```csharp
var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 10)
    .Select(r => new { r.Value.Name, r.Distance })
    .ToListAsync();
```

## Exact vs. approximate: when to use which

`VectorDistance()` from EF Core 10 still works and gives you exact results. Use it when the dataset is small or precision matters more than latency. `VectorSearch()` with a DiskANN index trades a small amount of recall accuracy for dramatically better throughput on large tables.

In practice, most RAG and recommendation workloads want the approximate path. If you previously offloaded vector search to a dedicated database (Qdrant, Pinecone, pgvector), this brings it back into the SQL Server you are already running, with EF Core managing the schema.

## Requirements

This feature targets SQL Server 2025, which introduced DiskANN vector indexes. The `VECTOR_SEARCH()` function and the related `CREATE VECTOR INDEX` syntax are experimental in SQL Server at the time of writing, so expect changes. The EF Core APIs mirror that experimental status.

For full setup details, see the [EF Core vector search documentation](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/vector-search).
