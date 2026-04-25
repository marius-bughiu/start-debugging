---
title: "EF Core 11 adiciona busca vetorial nativa do SQL Server com índices DiskANN"
description: "EF Core 11 Preview 2 suporta o VECTOR_SEARCH() do SQL Server 2025 e os índices vetoriais DiskANN diretamente do LINQ. Veja como configurar o índice, executar consultas aproximadas, e o que muda da abordagem VectorDistance do EF Core 10."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "sql-server"
  - "csharp"
  - "dotnet"
lang: "pt-br"
translationOf: "2026/04/efcore-11-sql-server-vector-search-diskann-indexes"
translatedBy: "claude"
translationDate: 2026-04-25
---

EF Core 10 introduziu `EF.Functions.VectorDistance()` para computar distâncias exatas entre embeddings em consultas LINQ. Isso funciona, mas a busca exata sobre milhões de linhas é cara. EF Core 11 Preview 2 fecha a lacuna suportando a busca vetorial aproximada do SQL Server 2025: índices DiskANN e a função com valor de tabela `VECTOR_SEARCH()`, tudo conectado através do seu `DbContext`.

## Configurando um índice vetorial

Declare o índice em `OnModelCreating` com a métrica de distância que você quiser (cosseno, produto escalar, ou euclidiana):

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasVectorIndex(b => b.Embedding, "cosine");
}
```

Quando você adiciona uma migração, o EF gera o DDL `CREATE VECTOR INDEX` mirando o motor DiskANN do SQL Server 2025. O índice vive ao lado dos seus índices B-tree e full-text regulares, gerenciados através do mesmo pipeline de migração.

## Consultando com VectorSearch()

Uma vez que o índice existe, use o novo método de extensão `VectorSearch()` no seu `DbSet`:

```csharp
float[] queryEmbedding = GetEmbeddingForQuery("distributed caching");

var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 5)
    .ToListAsync();
```

Isso traduz para a função com valor de tabela `VECTOR_SEARCH()` do SQL Server, que realiza uma busca aproximada de vizinhos mais próximos contra o índice DiskANN. O parâmetro `topN` limita quantos resultados retornam.

O tipo de retorno é `VectorSearchResult<TEntity>`, que expõe tanto a entidade quanto a distância calculada:

```csharp
var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 10)
    .Select(r => new { r.Value.Name, r.Distance })
    .ToListAsync();
```

## Exato vs. aproximado: quando usar qual

`VectorDistance()` do EF Core 10 ainda funciona e te dá resultados exatos. Use-o quando o conjunto de dados é pequeno ou a precisão importa mais que a latência. `VectorSearch()` com um índice DiskANN troca uma pequena quantidade de precisão de recall por um throughput dramaticamente melhor em tabelas grandes.

Na prática, a maioria das cargas de trabalho de RAG e recomendação quer o caminho aproximado. Se você antes delegava a busca vetorial a um banco de dados dedicado (Qdrant, Pinecone, pgvector), isso a traz de volta para o SQL Server que você já está rodando, com o EF Core gerenciando o schema.

## Requisitos

Este recurso mira o SQL Server 2025, que introduziu os índices vetoriais DiskANN. A função `VECTOR_SEARCH()` e a sintaxe `CREATE VECTOR INDEX` relacionada são experimentais no SQL Server no momento da escrita, então espere mudanças. As APIs do EF Core refletem esse status experimental.

Para detalhes completos de configuração, consulte a [documentação de busca vetorial do EF Core](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/vector-search).
