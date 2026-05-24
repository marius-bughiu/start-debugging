---
title: "EF Core 11 cheat sheet"
description: "Quick reference for EF Core 11: new query features, vector search, performance wins, and migration notes from EF Core 8/9/10."
tagline: "The parts of EF Core 11 worth remembering."
pubDate: 2026-04-18
updatedDate: 2026-05-24
indexTags:
  - "ef-core"
  - "ef-core-11"
  - "efcore"
  - "efcore-11"
  - "entity-framework"
---

This pillar is a running index of everything I've written about **EF Core 11** - new query features, vector search over DiskANN indexes, performance work, and migration notes coming from EF Core 8, 9, or 10.

## What to read first

For the headline 11.0 features, start with [EF Core 11 Adds Native SQL Server Vector Search with DiskANN Indexes](/2026/04/efcore-11-sql-server-vector-search-diskann-indexes/) and [EF Core 11 turns on Cosmos DB transactional batches by default](/2026/04/efcore-11-cosmos-transactional-batches/) - both reshape how you model write paths.

For day-to-day query work, [EF Core 11 Prunes Unnecessary Reference Joins in Split Queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) and [EF Core 11 translates Contains to JSON_CONTAINS on SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) are the changes you're most likely to feel in generated SQL. For hot paths and diagnostics, [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) and [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) are the practical follow-ups. If you're weighing EF Core against a micro-ORM on the write path, [EF Core 11 vs Dapper for bulk inserts: real benchmark](/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/) has the numbers.

## What's on this page

The list below auto-collects posts tagged with any of: `ef-core`, `ef-core-11`, `efcore`, `efcore-11`, `entity-framework`. Newest first.
