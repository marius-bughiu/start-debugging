---
title: "Marten 9.55 behebt das türkische I in Dokument-Tabellennamen: Vor dem Upgrade umbenennen"
description: "Marten 9.55.0 wandelt Dokument-Aliase, DDL-Template-Schlüssel und Upsert-Funktionsnamen für Flat-Table-Projektionen mit der invarianten Kultur in Kleinbuchstaben um. Apps unter tr-TR oder az-AZ, die Dokumente in Tabellen wie mt_doc_ınvoice speichern, müssen diese zuerst umbenennen, sonst scheinen ihre Daten zu verschwinden."
pubDate: 2026-10-30
tags:
  - "marten"
  - "postgresql"
  - "dotnet"
  - "globalization"
  - "breaking-changes"
lang: "de"
translationOf: "2026/10/marten-9-55-fixes-the-turkish-i-in-document-table-names"
translatedBy: "claude"
translationDate: 2026-10-30
---

[Marten 9.55.0](https://github.com/JasperFx/marten/releases/tag/V9.55.0) ist am 28. Oktober 2026 erschienen, und die Release Notes beginnen mit einem Abschnitt "vor dem Upgrade lesen", der nur für manche Apps relevant ist, für diese aber umso mehr. Wenn Ihr Prozess unter einer türkischen (`tr-TR`) oder aserbaidschanischen (`az-AZ`) Kultur läuft und Sie einen Dokumenttyp mit einem großen `I` im Namen haben, hat sich die Tabelle geändert, nach der Marten sucht.

## Woher das punktlose ı kam

Marten leitet den Alias eines Dokuments und damit den Tabellennamen aus dem Typnamen ab. Bis 9.55 geschah das mit `string.ToLower()`, das die aktuelle Kultur verwendet. In türkischen Kulturen ist die Kleinbuchstabenform von `I` das punktlose `ı` (U+0131), nicht `i`:

```csharp
using System.Globalization;

var tr = CultureInfo.GetCultureInfo("tr-TR");

Console.WriteLine("Invoice".ToLower(tr));        // ınvoice
Console.WriteLine("Invoice".ToLowerInvariant()); // invoice
```

Ein Dokumenttyp `Invoice` lag also auf einem türkischen Server in `mt_doc_ınvoice` und überall sonst in `mt_doc_invoice`. [PR #5778](https://github.com/JasperFx/marten/pull/5778) stellt `DocumentMapping` auf `ToLowerInvariant()` um. Ab 9.55.0 wird derselbe Typ unabhängig von der Kultur auf `mt_doc_invoice` abgebildet, und Marten legt diese Tabelle bereitwillig leer neben Ihrer alten an.

## Zwei weitere Bezeichner im selben Release

[PR #5783](https://github.com/JasperFx/marten/pull/5783) hat zwei weitere Stellen korrigiert, an denen mit der aktuellen Kultur in Kleinbuchstaben umgewandelt wurde:

- **`DdlTemplate`-Lookups.** Weasel verwendet als Schlüssel für Templates den invariant kleingeschriebenen Dateinamen, und der Template-Cache legt für jeden fehlenden Schlüssel einen leeren Eintrag an. Unter `tr-TR` suchte `DdlTemplate("Invoicing")` nach `ınvoicing`, erhielt ein leeres Template und schrieb stillschweigend keine `GRANT`-Anweisungen. Das ist ein reiner Bugfix, es ist nichts zu migrieren.
- **Upsert-Funktionen für Flat-Table-Projektionen.** `mt_upsert_{table}_{event}` lautete früher `mt_upsert_ınvoices_ınvoiceıssued`. Nach dem Upgrade legt die nächste Migration eine korrekt benannte Funktion an und lässt die alte ungenutzt zurück. Es werden keine Daten verschoben, sodass Sie sie von Hand löschen können.

## Die Tabellen umbenennen

Tun Sie dies, bevor der 9.55-Build die Datenbank berührt. Dieser DO-Block benennt jede Marten-Dokumenttabelle um, die ein punktloses `ı` enthält:

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

Die Release Notes bitten außerdem darum, die zugehörigen Upsert-Funktionen umzubenennen. Alternativ löschen Sie die alten Funktionen `mt_upsert_`, `mt_insert_`, `mt_update_` und `mt_overwrite_`, deren Namen `ı` enthalten, und lassen Marten sie neu generieren; `SELECT proname FROM pg_proc WHERE proname LIKE '%ı%'` listet sie auf. Führen Sie danach zuerst gegen eine Kopie `await store.Storage.ApplyAllConfiguredChangesToDatabaseAsync()` aus und prüfen Sie den generierten Diff. Index- oder Constraint-Namen, die noch die alte Schreibweise tragen, tauchen dort auf.

Wenn Ihre Apps `<InvariantGlobalization>true</InvariantGlobalization>` setzen oder mit einer englischen Kultur laufen, bleiben die generierten Namen unverändert, und es ist nichts zu tun.

## Ein weiterer Hinweis aus den Release Notes für alle anderen

`StoredDocument.Version` für Projektionsdokumente mit `UseVersionFromMatchingStream` hat jetzt die Form `<mt_version>:<epoch microseconds>` statt nur `mt_version` ([#5773](https://github.com/JasperFx/marten/issues/5773)), sodass Code, der den Wert als Ganzzahl geparst hat, bricht. Das Release behebt außerdem, dass die HiLo-Id-Generierung bei einem frischen Store nach einem Datenbankausfall defekt blieb.

Eine Einschränkung nennt der PR ausdrücklich: JasperFx' `ToTableAlias`, das die Ereignistypnamen in `mt_events.type` liefert, ist weiterhin kulturabhängig. Eine Änderung würde bestehende Ereigniszeilen unter `tr-TR` verwaisen lassen, deshalb wird sie separat verfolgt. Wenn Sie Marten auf einem türkischen Server betreiben, behalten Sie diesen Folge-PR im Auge.

```bash
dotnet add package Marten --version 9.55.0
```
