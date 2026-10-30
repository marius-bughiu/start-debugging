---
title: "Marten 9.55 Fixes the Turkish I in Document Table Names: Rename Before You Upgrade"
description: "Marten 9.55.0 lowers document aliases, DDL template keys and flat-table upsert function names with the invariant culture. Apps running under tr-TR or az-AZ that store documents in tables like mt_doc_ınvoice must rename them first, or their data appears to vanish."
pubDate: 2026-10-30
tags:
  - "marten"
  - "postgresql"
  - "dotnet"
  - "globalization"
  - "breaking-changes"
---

[Marten 9.55.0](https://github.com/JasperFx/marten/releases/tag/V9.55.0) shipped on October 28, 2026, and its release notes open with a "read before upgrading" section that only matters to some apps, but matters a lot to those. If your process runs under a Turkish (`tr-TR`) or Azerbaijani (`az-AZ`) culture and you have a document type with an uppercase `I` in its name, the table Marten looks for has changed.

## Where the dotless ı came from

Marten derives a document's alias, and therefore its table name, from the type name. Until 9.55 it did that with `string.ToLower()`, which uses the current culture. In Turkic cultures the lowercase form of `I` is the dotless `ı` (U+0131), not `i`:

```csharp
using System.Globalization;

var tr = CultureInfo.GetCultureInfo("tr-TR");

Console.WriteLine("Invoice".ToLower(tr));        // ınvoice
Console.WriteLine("Invoice".ToLowerInvariant()); // invoice
```

So a document type `Invoice` lived in `mt_doc_ınvoice` on a Turkish server and in `mt_doc_invoice` everywhere else. [PR #5778](https://github.com/JasperFx/marten/pull/5778) switches `DocumentMapping` to `ToLowerInvariant()`. From 9.55.0 on, the same type maps to `mt_doc_invoice` regardless of culture, and Marten will happily create that table empty next to your old one.

## Two more identifiers in the same release

[PR #5783](https://github.com/JasperFx/marten/pull/5783) fixed two more places that lowered with the current culture:

- **`DdlTemplate` lookups.** Weasel keys templates by file name lowered invariantly, and the template cache creates an empty entry for any missing key. Under `tr-TR`, `DdlTemplate("Invoicing")` looked up `ınvoicing`, got an empty template, and silently wrote no `GRANT` statements. That one is a pure bug fix, nothing to migrate.
- **Flat-table projection upsert functions.** `mt_upsert_{table}_{event}` used to come out as `mt_upsert_ınvoices_ınvoiceıssued`. After upgrading, the next migration creates a correctly named function and leaves the old one behind, unused. No data moves, so you can drop it by hand.

## Renaming the tables

Do this before the 9.55 build touches the database. This DO block renames every Marten document table that contains a dotless `ı`:

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE tablename LIKE 'mt\_doc\_%' AND tablename LIKE '%ı%'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I RENAME TO %I',
      r.schemaname, r.tablename, replace(r.tablename, 'ı', 'i'));
  END LOOP;
END $$;
```

The release notes also ask you to rename the matching upsert functions. Alternatively, drop the old `mt_upsert_`, `mt_insert_`, `mt_update_` and `mt_overwrite_` functions whose names contain `ı` and let Marten regenerate them; `SELECT proname FROM pg_proc WHERE proname LIKE '%ı%'` lists them. Then run `await store.Storage.ApplyAllConfiguredChangesToDatabaseAsync()` against a copy first and check the generated diff. Any index or constraint names that still carry the old spelling will show up there.

If your apps set `<InvariantGlobalization>true</InvariantGlobalization>` or run with an English culture, the names they generate are unchanged and there is nothing to do.

## One more release note for everyone else

`StoredDocument.Version` for projection documents using `UseVersionFromMatchingStream` is now `<mt_version>:<epoch microseconds>` instead of the bare `mt_version` ([#5773](https://github.com/JasperFx/marten/issues/5773)), so code that parsed it as an integer will break. The release also fixes HiLo id generation staying broken after a database outage on a fresh store.

One caveat the PR calls out: JasperFx's `ToTableAlias`, which feeds event type names in `mt_events.type`, is still culture-sensitive. Changing it would orphan existing event rows under `tr-TR`, so it is tracked separately. If you run Marten on a Turkish server, keep an eye on that follow-up.

```bash
dotnet add package Marten --version 9.55.0
```
