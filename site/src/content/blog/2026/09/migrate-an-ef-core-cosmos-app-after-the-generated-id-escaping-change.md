---
title: "Migrate an EF Core Cosmos app after the generated id escaping change in EF Core 11"
description: "EF Core 11 stops escaping '/', '\\', '?' and '#' in generated Cosmos DB id values, so documents written by EF Core 8-10 stop resolving by key. How to find out if you are affected, when to set the EscapeIllegalCosmosIdCharacters switch, and how to rewrite the ids safely with a transactional batch."
pubDate: 2026-09-19
updatedDate: 2026-09-19
template: migration
tags:
  - "migration"
  - "efcore"
  - "efcore-11"
  - "cosmos-db"
  - "dotnet-11"
---

EF Core 11 changes how the Azure Cosmos DB provider builds the `id` of a document when that `id` is made of more than one value. EF Core 8, 9 and 10 replaced `/`, `\`, `?` and `#` in each part with `^2F`, `^5C`, `^3F` and `^23`. EF Core 11 (the change shipped in 11.0 preview 5, and I verified it on 11.0.0 RC 1) writes the raw characters instead. If none of your composite key values contain those four characters, the upgrade changes nothing and you can stop reading after the next section. If some do, `FindAsync` and key lookups stop finding those documents after the upgrade. You then have two choices: set the `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters` switch before the app starts, or rewrite the affected ids. For keys that contain `/` or `\`, the switch is the only option that works, because Cosmos DB rejects those characters in an `id`. Expect about an hour for the audit, and most teams will find nothing to do.

## Who is actually affected

The escaping only ever applied to multi-part ids. I read `JsonIdDefinition` at the EF Core 11 RC 1 tag: a key made of one value is written as-is, and escaping only happens when more than one value is joined with `|`. Partition key properties are dropped from the id before that check. So an entity type is in scope only if one of these is true:

- Its primary key still has two or more properties after you remove the partition key properties. For example, `HasKey(x => new { x.TenantId, x.OrderId, x.Sku })` with `HasPartitionKey(x => x.TenantId)` gives the id `OrderId|Sku`.
- It uses `HasDiscriminatorInJsonId()`. Apps that upgraded from EF Core 8 often turned this on in EF Core 9 to keep their old `Post|1` ids, so this is the most common way to be affected.

Then one of the key values has to contain `/`, `\`, `?` or `#`. GUID and integer keys cannot. Free-text or path-like string keys (SKUs such as `shoes/red`, slugs such as `2026/09/hello`, file names, URLs) are where this bites.

I ran the same entities through EF Core 10.0.12 and EF Core 11.0.0 RC 1 without a database. Adding an entity to a `DbContext` runs the id value generator, so the generated id can be read straight from the change tracker:

| Key values | EF Core 10.0.12 | EF Core 11 RC 1 | EF Core 11 RC 1 + switch |
| ---------- | --------------- | --------------- | ------------------------ |
| `o-1`, `shoes/red` | `o-1\|shoes^2Fred` | `o-1\|shoes/red` | `o-1\|shoes^2Fred` |
| `o-1`, `shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` | `o-1\|shoes^2Fred` |
| `o-1`, `C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` | `o-1\|C:\temp?#1` | `o-1\|C:^5Ctemp^3F^231` |
| `o-1`, `a\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` | `o-1\|a^\|b` |
| single key `shoes/red` | `shoes/red` | `shoes/red` | `shoes/red` |
| `HasDiscriminatorInJsonId`, `2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` | `LegacyPost\|2026/09/hello` | `LegacyPost\|2026^2F09^2Fhello` |

The first two rows are the reason for the change ([dotnet/efcore#38244](https://github.com/dotnet/efcore/issues/38244)). The escape character `^` was never escaped itself, so `shoes/red` and `shoes^2Fred` got the same id and the second insert silently overwrote the first document. The EF team decided to stop escaping instead of also escaping `^`, because escaping `^` would have broken every existing id that contains a caret. The fix is [dotnet/efcore#38245](https://github.com/dotnet/efcore/pull/38245), merged on 2026-05-08. Note that the `|` separator is still escaped as `^|` on both versions, so that part of your ids does not move.

## What breaks

| Area | Change after upgrading to EF Core 11 | Severity |
| ---- | ------------------------------------ | -------- |
| `FindAsync`, and queries that filter on the full key plus partition key | EF turns these into a point read using the newly generated id, so documents stored with an escaped id come back as `null` or as an empty result | high |
| Inserting an entity whose key matches an old document | The new id differs, so for `?` and `#` you get a second document with the same key values instead of a conflict | high |
| New keys containing `/` or `\` | EF 11 now sends those characters in the id, and the Cosmos DB service does not allow `/` and `\` in an id ([service limits](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)), so the write fails | high |
| Updates and deletes of entities loaded by a query | Still work: `SaveChanges` uses the `__id` value that was materialized from the document, not a freshly generated one | none |
| Queries that do not filter on the full key | Still work, they do not use the id | none |

The second row is the dangerous one. The common "find it, and add it if it is missing" pattern returns `null` for the old document and creates a duplicate next to it. No exception is thrown.

## Pre-flight checklist

- The app builds against `Microsoft.EntityFrameworkCore.Cosmos` 11.0.0-rc.1.26425.128 (or GA once it ships), and you have read the rest of the [EF Core 11 breaking changes](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes). The Cosmos provider has several changes in 11, including the removal of sync I/O and of unmapped property round-tripping.
- You have Data Explorer or SDK access to every container that EF writes to.
- Continuous backup or a point-in-time restore is enabled on the account before you rewrite any ids.
- You know which key properties hold user-supplied or free-text strings.

## Migration steps

1. **List the entity types with multi-part ids.**
   This walks the EF model with public Cosmos metadata APIs and applies the same rule the provider uses:

   ```csharp
   // EF Core 11.0 RC 1, .NET 11 RC 1
   foreach (var entityType in db.Model.GetEntityTypes().Where(t => !t.IsOwned()))
   {
       var key = entityType.FindPrimaryKey()!;
       var partitionKeyNames = entityType.GetPartitionKeyPropertyNames();
       var idParts = key.Properties.Count(p => !partitionKeyNames.Contains(p.Name));
       var discriminatorInId = entityType.GetDiscriminatorInKey()
           is IdDiscriminatorMode.EntityType or IdDiscriminatorMode.RootEntityType;

       Console.WriteLine($"{entityType.DisplayName(),-12} container={entityType.GetContainer(),-8} " +
           $"id parts={idParts} discriminator in id={discriminatorInId} " +
           $"-> {(idParts > 1 || discriminatorInId ? "AFFECTED" : "not affected")}");
   }
   ```

   For a model with a partitioned `OrderLine` (key `TenantId, OrderId, Sku`) and a single-key `Product`, it prints:

   ```text
   OrderLine    container=Orders   id parts=2 discriminator in id=False -> AFFECTED
   Product      container=Catalog  id parts=1 discriminator in id=False -> not affected
   ```

   Verify: every entity type marked `AFFECTED` has at least one `string` key property. If all of them are `Guid`, `int` or `long`, you are done. EF Core 11 generates the same ids as EF Core 10 for those.

2. **Count the documents that actually carry an escape sequence.**
   Run this in Data Explorer against each container that holds an affected type:

   ```sql
   -- Azure Cosmos DB for NoSQL
   SELECT c.id, c["$type"] FROM c
   WHERE CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C")
      OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23")
   ```

   `$type` is the JSON discriminator name EF has written since EF Core 9. EF Core 11 renamed the model property to `Discriminator`, but the name in the JSON is still `$type`. Verify: zero rows means no stored document will change its id. Then the only open question is whether *new* keys can contain those characters, and step 3 still applies to them.

3. **Decide: keep the old escaping, or move to raw ids.**
   Use this rule:

   - Keys can contain `/` or `\`: keep the old escaping with the switch (step 4). Raw ids containing those characters cannot be stored in Cosmos DB, so there is nothing to migrate to. The only alternative is to change the key values themselves.
   - Keys can contain only `?` or `#`: you can rewrite the ids (step 5) and drop the old escaping for good. That also removes the collision bug.
   - Key values can be supplied by users: be aware that with the switch on, a user who submits the literal string `shoes^2Fred` can overwrite `shoes/red`. If that matters, validate key input so it never contains `^`.

   Verify: write the decision down per entity type. A mixed container can need both.

4. **If you keep the escaping, set the switch before EF loads.**
   The provider reads the switch once, into a `static readonly` field of `JsonIdDefinition`. The safest place for it is the project file, because MSBuild writes it into `runtimeconfig.json`:

   ```xml
   <!-- EF Core 11.0, .NET 11 -->
   <ItemGroup>
     <RuntimeHostConfigurationOption Include="Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters"
                                     Value="true" />
   </ItemGroup>
   ```

   `AppContext.SetSwitch("Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters", true)` also works, as long as it is the first line of `Program.cs`, before any `DbContext` has been created. Verify with the id generator itself (step 6). I tested both the `runtimeconfig.json` entry and a `SetSwitch` call at startup on RC 1, and both gave `o-1|shoes^2Fred`.

5. **If you move to raw ids, rewrite the documents in place.**
   Cosmos DB cannot rename an `id`, so each document is recreated under the new id and the old one is deleted. Both documents share a partition key, so a transactional batch makes the swap atomic. Compute the new id with EF Core 11 itself instead of reimplementing the format: add a key-only instance to a throwaway context and read `__id`. Do the rewrite with the raw JSON and not through EF, because EF Core 11 no longer keeps JSON properties that are not mapped in the model, so saving through EF would drop them.

   ```csharp
   // EF Core 11.0 RC 1, Microsoft.Azure.Cosmos 3.x, .NET 11 RC 1
   // Run with the switch OFF, so EF generates the new ids.
   using var client = new CosmosClient(connectionString);
   var container = client.GetContainer("shop", "Orders");
   var query = new QueryDefinition(
       """
       SELECT * FROM c
       WHERE c["$type"] = "OrderLine"
         AND (CONTAINS(c.id, "^2F") OR CONTAINS(c.id, "^5C") OR CONTAINS(c.id, "^3F") OR CONTAINS(c.id, "^23"))
       """);

   await using var idContext = new ShopContext(connectionString); // never saved
   using var iterator = container.GetItemQueryStreamIterator(query);
   while (iterator.HasMoreResults)
   {
       using var page = await iterator.ReadNextAsync();
       page.EnsureSuccessStatusCode();
       var documents = JsonNode.Parse(page.Content)!["Documents"]!.AsArray();

       foreach (var doc in documents.Select(d => d!.AsObject()))
       {
           var oldId = (string)doc["id"]!;
           var line = new OrderLine
           {
               TenantId = (string)doc["TenantId"]!,
               OrderId = (string)doc["OrderId"]!,
               Sku = (string)doc["Sku"]!,
           };
           var entry = idContext.Add(line);
           var newId = (string)entry.Property("__id").CurrentValue!;
           entry.State = EntityState.Detached;

           if (newId == oldId) continue; // the key really contains "^2F"
           if (newId.Contains('/') || newId.Contains('\\'))
           {
               Console.WriteLine($"BLOCKED  {oldId} -> {newId}");
               continue;
           }

           Console.WriteLine($"{(apply ? "REWRITE " : "DRY RUN ")} {oldId} -> {newId}");
           if (!apply) continue;

           var etag = (string)doc["_etag"]!;
           foreach (var system in new[] { "_rid", "_self", "_etag", "_attachments", "_ts" })
               doc.Remove(system);
           doc["id"] = newId;

           using var body = new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(doc));
           using var result = await container
               .CreateTransactionalBatch(new PartitionKey(line.TenantId))
               .CreateItemStream(body)
               .DeleteItem(oldId, new TransactionalBatchItemRequestOptions { IfMatchEtag = etag })
               .ExecuteAsync();

           if (!result.IsSuccessStatusCode)
               Console.WriteLine($"  FAILED {result.StatusCode}: {result.ErrorMessage}");
       }
   }
   ```

   The key is read from the document's own properties, not recovered from the escaped id. That is what makes the tool safe for the collision case: a document stored as `o-1|shoes^2Fred` whose `Sku` really is `shoes^2Fred` produces the same id on EF 11, so it is skipped. I ran the id logic offline on RC 1 against four sample documents. It printed `BLOCKED o-1|shoes^2Fred -> o-1|shoes/red`, `DRY RUN o-1|gift^23card -> o-1|gift#card`, `DRY RUN o-1|what^3F -> o-1|what?`, and skipped the literal `shoes^2Fred` one. I did not run the batch against a live account or the emulator, so run the dry run first, then `--apply` against a restored copy of the database. The `IfMatchEtag` on the delete makes the batch fail instead of losing a concurrent write. If it fails, run the tool again. Verify: the step 2 query returns only `BLOCKED` documents, or none.

6. **Pin the id format with a test.**
   The id generator runs on `Add`, so a unit test can check the format without Cosmos DB:

   ```csharp
   // EF Core 11.0 RC 1, xUnit v3
   [Theory]
   [InlineData("shoes/red", "o-1|shoes^2Fred")] // expected with the switch on
   [InlineData("gift#card", "o-1|gift^23card")]
   public void Generated_id_matches_stored_documents(string sku, string expectedId)
   {
       using var db = new ShopContext("AccountEndpoint=https://localhost:8081/;AccountKey=dGVzdA==");
       var entry = db.Add(new OrderLine { TenantId = "t1", OrderId = "o-1", Sku = sku });
       Assert.Equal(expectedId, entry.Property("__id").CurrentValue);
   }
   ```

   Verify: the test passes in CI with the same `runtimeconfig.json` the app ships with. If someone removes the `RuntimeHostConfigurationOption`, this test fails instead of production.

## Verification

After deploying EF Core 11, check these three things against real data:

- `await db.OrderLines.FindAsync("t1", "o-1", "shoes/red")` (a key that used to be escaped) returns the entity and not `null`.
- The step 2 query returns the same count as before if you kept the switch, and zero (apart from `BLOCKED` rows) if you migrated.
- A query for duplicates returns nothing: `SELECT c.TenantId, c.OrderId, c.Sku, COUNT(1) AS n FROM c GROUP BY c.TenantId, c.OrderId, c.Sku`, then look for any `n` greater than 1. That catches the silent duplicate inserts from the "What breaks" table.

## Rollback plan

Keeping the switch is fully reversible: remove the package upgrade and EF Core 10 generates the same ids it always did. Rewriting ids is not reversible by redeploying. EF Core 10 generates escaped ids again and cannot find the rewritten documents. So rewriting commits you to EF Core 11. If you need a way back, either restore the container from the backup you took before the rewrite, or deploy EF Core 11 with the switch on (the old ids are still valid under it) and rerun the tool in reverse. Test that path before you depend on it.

## Gotchas

- **The switch name has two spellings in the wild.** The issue and a code comment in `JsonIdDefinition` both say `Microsoft.EntityFrameworkCore.EscapeIllegalIdCharacters`. The code actually reads `Microsoft.EntityFrameworkCore.EscapeIllegalCosmosIdCharacters`, which is also what the breaking-changes doc says. I set the shorter name in `runtimeconfig.json` on RC 1 and it had no effect: ids stayed unescaped.
- **Setting the switch late does nothing.** In my probe, `AppContext.SetSwitch` called after the first `DbContext` had generated an id was ignored, and the next context still produced `o-2|shoes/red`. Hosted apps that set switches from configuration after `builder.Build()` run into this.
- **Single-key ids were never escaped.** A `Product` with `Id = "shoes/red"` has always been written as `shoes/red`, on 10 and 11, so the Cosmos DB restriction on `/` already applied to it. The change only affects ids made of several values.
- **Partition key properties are not part of the id.** When you check your keys, ignore the properties you pass to `HasPartitionKey`. Those values can contain anything, because the provider sends them as the partition key and not in the id.
- **Batches are per partition and capped at 100 operations.** The tool issues one batch per document to keep failures local. If you batch several documents together, group them by partition key and stay under the limit.

## Related

- The rewrite tool relies on the same mechanism EF Core 11 now uses for every `SaveChanges`: [EF Core 11 turns on Cosmos DB transactional batches by default](/2026/04/efcore-11-cosmos-transactional-batches/).
- If you are skipping several major versions at once, [migrating from EF Core 6 to EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) lists the other breaking changes you will hit on the way.
- Another EF Core 11 default that changes silently under an upgrade: [SQL Server compatibility level 150 vs 160](/2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries/).
- To log every point read and see which ids EF asks Cosmos DB for, [an EF Core interceptor](/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) is the lightest hook.
- If owned types in your Cosmos documents are also on the upgrade list, see [complex types vs owned entities in EF Core 11](/2026/07/complex-types-vs-owned-entities-in-ef-core-11/).

## Sources

- [EF Core 11 breaking changes: Cosmos illegal `id` characters are no longer escaped](https://learn.microsoft.com/ef/core/what-is-new/ef-core-11.0/breaking-changes#cosmos-no-id-escape)
- [dotnet/efcore#38244: Generated `id` values can collide when key values contain escape sequences](https://github.com/dotnet/efcore/issues/38244)
- [dotnet/efcore#38245: Don't escape illegal id characters](https://github.com/dotnet/efcore/pull/38245)
- [`JsonIdDefinition.cs` at v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinition.cs)
- [`JsonIdDefinitionFactory.cs` at v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Cosmos/Metadata/Internal/JsonIdDefinitionFactory.cs)
- [Azure Cosmos DB service quotas: allowed characters for ID value](https://learn.microsoft.com/azure/cosmos-db/concepts-limits#per-item-limits)
- [Transactional batch operations in Azure Cosmos DB](https://learn.microsoft.com/azure/cosmos-db/transactional-batch)
- [EF Core 9 breaking changes: discriminator no longer included in `id`](https://learn.microsoft.com/ef/core/what-is-new/ef-core-9.0/breaking-changes#cosmos-id-property-changes)
