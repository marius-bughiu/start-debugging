---
title: "EF Core 11 agrega búsqueda vectorial nativa de SQL Server con índices DiskANN"
description: "EF Core 11 Preview 2 soporta VECTOR_SEARCH() de SQL Server 2025 y los índices vectoriales DiskANN directamente desde LINQ. Aquí está cómo configurar el índice, ejecutar consultas aproximadas, y qué cambia del enfoque VectorDistance de EF Core 10."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "sql-server"
  - "csharp"
  - "dotnet"
lang: "es"
translationOf: "2026/04/efcore-11-sql-server-vector-search-diskann-indexes"
translatedBy: "claude"
translationDate: 2026-04-25
---

EF Core 10 introdujo `EF.Functions.VectorDistance()` para computar distancias exactas entre embeddings en consultas LINQ. Eso funciona, pero la búsqueda exacta sobre millones de filas es costosa. EF Core 11 Preview 2 cierra la brecha al soportar la búsqueda vectorial aproximada de SQL Server 2025: índices DiskANN y la función con valor de tabla `VECTOR_SEARCH()`, todo conectado a través de tu `DbContext`.

## Configurando un índice vectorial

Declara el índice en `OnModelCreating` con la métrica de distancia que quieras (coseno, producto punto, o euclidiana):

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasVectorIndex(b => b.Embedding, "cosine");
}
```

Cuando agregas una migración, EF genera el DDL `CREATE VECTOR INDEX` apuntando al motor DiskANN de SQL Server 2025. El índice vive junto a tus índices regulares B-tree y de búsqueda de texto completo, gestionado a través del mismo pipeline de migración.

## Consultando con VectorSearch()

Una vez que existe el índice, usa el nuevo método de extensión `VectorSearch()` en tu `DbSet`:

```csharp
float[] queryEmbedding = GetEmbeddingForQuery("distributed caching");

var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 5)
    .ToListAsync();
```

Esto se traduce a la función con valor de tabla `VECTOR_SEARCH()` de SQL Server, que realiza una búsqueda aproximada de vecinos más cercanos contra el índice DiskANN. El parámetro `topN` limita cuántos resultados regresan.

El tipo de retorno es `VectorSearchResult<TEntity>`, que expone tanto la entidad como la distancia calculada:

```csharp
var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 10)
    .Select(r => new { r.Value.Name, r.Distance })
    .ToListAsync();
```

## Exacto vs. aproximado: cuándo usar cuál

`VectorDistance()` de EF Core 10 sigue funcionando y te da resultados exactos. Úsalo cuando el conjunto de datos es pequeño o la precisión importa más que la latencia. `VectorSearch()` con un índice DiskANN intercambia una pequeña cantidad de precisión de recall por un throughput dramáticamente mejor en tablas grandes.

En la práctica, la mayoría de las cargas de trabajo de RAG y recomendación quieren la ruta aproximada. Si previamente delegabas la búsqueda vectorial a una base de datos dedicada (Qdrant, Pinecone, pgvector), esto la trae de vuelta al SQL Server que ya estás ejecutando, con EF Core gestionando el esquema.

## Requisitos

Esta característica apunta a SQL Server 2025, que introdujo los índices vectoriales DiskANN. La función `VECTOR_SEARCH()` y la sintaxis `CREATE VECTOR INDEX` relacionada son experimentales en SQL Server al momento de escribir esto, así que espera cambios. Las APIs de EF Core reflejan ese estado experimental.

Para detalles completos de configuración, consulta la [documentación de búsqueda vectorial de EF Core](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/vector-search).
