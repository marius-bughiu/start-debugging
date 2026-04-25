---
title: "EF Core 11 fügt native SQL Server Vektorsuche mit DiskANN-Indizes hinzu"
description: "EF Core 11 Preview 2 unterstützt SQL Server 2025 VECTOR_SEARCH() und DiskANN-Vektorindizes direkt aus LINQ. So richten Sie den Index ein, führen näherungsweise Abfragen aus, und das ändert sich gegenüber dem VectorDistance-Ansatz von EF Core 10."
pubDate: 2026-04-13
tags:
  - "dotnet-11"
  - "ef-core"
  - "sql-server"
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2026/04/efcore-11-sql-server-vector-search-diskann-indexes"
translatedBy: "claude"
translationDate: 2026-04-25
---

EF Core 10 führte `EF.Functions.VectorDistance()` ein, um exakte Distanzen zwischen Embeddings in LINQ-Abfragen zu berechnen. Das funktioniert, aber exakte Suche über Millionen von Zeilen ist teuer. EF Core 11 Preview 2 schließt die Lücke, indem es die näherungsweise Vektorsuche von SQL Server 2025 unterstützt: DiskANN-Indizes und die tabellenwertige Funktion `VECTOR_SEARCH()`, alles verdrahtet über Ihren `DbContext`.

## Einen Vektorindex einrichten

Deklarieren Sie den Index in `OnModelCreating` mit der gewünschten Distanzmetrik (Kosinus, Skalarprodukt oder euklidisch):

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .HasVectorIndex(b => b.Embedding, "cosine");
}
```

Wenn Sie eine Migration hinzufügen, generiert EF das `CREATE VECTOR INDEX`-DDL für die DiskANN-Engine von SQL Server 2025. Der Index lebt neben Ihren regulären B-Tree- und Volltextindizes und wird durch dieselbe Migrations-Pipeline verwaltet.

## Mit VectorSearch() abfragen

Sobald der Index existiert, verwenden Sie die neue Erweiterungsmethode `VectorSearch()` auf Ihrem `DbSet`:

```csharp
float[] queryEmbedding = GetEmbeddingForQuery("distributed caching");

var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 5)
    .ToListAsync();
```

Das übersetzt sich in die tabellenwertige Funktion `VECTOR_SEARCH()` von SQL Server, die eine näherungsweise Nearest-Neighbor-Suche gegen den DiskANN-Index durchführt. Der `topN`-Parameter begrenzt, wie viele Ergebnisse zurückkommen.

Der Rückgabetyp ist `VectorSearchResult<TEntity>`, der sowohl die Entität als auch die berechnete Distanz freigibt:

```csharp
var results = await context.Blogs
    .VectorSearch(b => b.Embedding, "cosine", queryEmbedding, topN: 10)
    .Select(r => new { r.Value.Name, r.Distance })
    .ToListAsync();
```

## Exakt vs. näherungsweise: wann was verwenden

`VectorDistance()` aus EF Core 10 funktioniert weiterhin und liefert exakte Ergebnisse. Verwenden Sie es, wenn der Datensatz klein ist oder Präzision wichtiger als Latenz ist. `VectorSearch()` mit einem DiskANN-Index tauscht eine kleine Menge an Recall-Genauigkeit gegen dramatisch besseren Durchsatz auf großen Tabellen.

In der Praxis wollen die meisten RAG- und Empfehlungs-Workloads den näherungsweisen Pfad. Falls Sie die Vektorsuche zuvor an eine dedizierte Datenbank (Qdrant, Pinecone, pgvector) ausgelagert haben, bringt das sie zurück in den SQL Server, den Sie bereits betreiben, mit EF Core, das das Schema verwaltet.

## Anforderungen

Dieses Feature zielt auf SQL Server 2025 ab, das DiskANN-Vektorindizes eingeführt hat. Die `VECTOR_SEARCH()`-Funktion und die zugehörige `CREATE VECTOR INDEX`-Syntax sind in SQL Server zum Zeitpunkt des Schreibens experimentell, also rechnen Sie mit Änderungen. Die EF Core APIs spiegeln diesen experimentellen Status wider.

Für vollständige Setup-Details siehe die [EF Core Dokumentation zur Vektorsuche](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/vector-search).
