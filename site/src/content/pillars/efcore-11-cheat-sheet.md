---
title: "EF Core 11 cheat sheet"
description: "Quick reference for EF Core 11: new query features, vector search, performance wins, and migration notes from EF Core 8/9/10."
tagline: "The parts of EF Core 11 worth remembering."
pubDate: 2026-04-18
updatedDate: 2026-09-06
indexTags:
  - "ef-core"
  - "ef-core-11"
  - "efcore"
  - "efcore-11"
  - "entity-framework"
---

This pillar is a running index of everything I've written about **EF Core 11** - new query features, vector search, performance work, and migration notes from EF Core 8, 9, or 10.

## What to read first

For the headline 11.0 features, start with [native SQL Server vector search over DiskANN indexes](/2026/04/efcore-11-sql-server-vector-search-diskann-indexes/) and [Cosmos DB transactional batches on by default](/2026/04/efcore-11-cosmos-transactional-batches/) - both reshape write paths. Before you model, [TPH vs TPT vs TPC](/2026/07/tph-vs-tpt-vs-tpc-inheritance-mapping-in-ef-core-11/) and [complex types vs owned entities](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) settle the schema shape, and [optimistic concurrency with a rowversion token](/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/) stops concurrent writes clobbering each other - the failure it prevents looks like [a 23505 duplicate-key violation on a concurrent insert](/2026/08/fix-23505-duplicate-key-value-violates-unique-constraint-on-a-concurrent-ef-core-insert/).

For query work, [pruned reference joins in split queries](/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) and [Contains translating to JSON_CONTAINS](/2026/04/efcore-11-json-contains-sql-server-2025/) are the changes you'll feel in generated SQL. When LINQ falls short, [a stored procedure](/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/) still maps onto entities. When a singleton needs data, [IDbContextFactory](/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/) is the only safe route to a context. To hook SaveChanges or a command without wrapping the context, [what an interceptor is and when you need one](/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) covers the seven interception points. For hot paths, [detecting N+1 queries](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) and [compiled queries](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) are the follow-ups, and [ExecuteUpdate and ExecuteDelete for bulk writes](/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) is the set-based path. For seed data, [HasData vs UseSeeding](/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) settles the approach. Upgrading? [Migrate EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) is the checklist.

## What's on this page

The list below auto-collects posts tagged with any of: `ef-core`, `ef-core-11`, `efcore`, `efcore-11`, `entity-framework`. Newest first.
