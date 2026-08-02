---
title: "EF Core 11 cheat sheet"
description: "Quick reference for EF Core 11: new query features, vector search, performance wins, and migration notes from EF Core 8/9/10."
tagline: "The parts of EF Core 11 worth remembering."
pubDate: 2026-04-18
updatedDate: 2026-08-02
indexTags:
  - "ef-core"
  - "ef-core-11"
  - "efcore"
  - "efcore-11"
  - "entity-framework"
---

This pillar is a running index of everything I've written about **EF Core 11** - new query features, vector search over DiskANN indexes, performance work, and migration notes coming from EF Core 8, 9, or 10.

## What to read first

For the headline 11.0 features, start with [native SQL Server vector search over DiskANN indexes](/2026/04/efcore-11-sql-server-vector-search-diskann-indexes/) and [Cosmos DB transactional batches on by default](/2026/04/efcore-11-cosmos-transactional-batches/) - both reshape how you model write paths. [Temporal-table period columns](/2026/05/ef-core-11-temporal-tables-clr-period-properties/) can now be real CLR properties, making `PeriodStart`/`PeriodEnd` first-class on the entity. Before you model, [TPH vs TPT vs TPC inheritance mapping](/2026/07/tph-vs-tpt-vs-tpc-inheritance-mapping-in-ef-core-11/) and [complex types vs owned entities](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) settle the two schema-shape decisions.

For day-to-day query work, [pruned reference joins in split queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) and [Contains translating to JSON_CONTAINS on SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) are the changes you're most likely to feel in generated SQL. For hot paths, [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) and [compiled queries](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) are the practical follow-ups, and [ExecuteUpdate and ExecuteDelete for bulk writes](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) is the modern set-based path. For test and reference data, [HasData vs UseSeeding for seeding in EF Core 11](/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) settles the approach, with [UseSeeding and UseAsyncSeeding](/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/) for the runtime path. Upgrading? [Migrate EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) is the checklist. To ship schema changes, [applying migrations in production with a migrations bundle](/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) is the deployment path.

## What's on this page

The list below auto-collects posts tagged with any of: `ef-core`, `ef-core-11`, `efcore`, `efcore-11`, `entity-framework`. Newest first.
