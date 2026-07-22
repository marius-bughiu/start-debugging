---
title: "TPH vs TPT vs TPC beim Vererbungsmapping in EF Core 11: Was sollten Sie wählen?"
description: "In EF Core 11 verwenden Sie standardmäßig TPH für fast jede Hierarchie, greifen nur zu TPC, wenn Sie überwiegend einen einzelnen Blatttyp abfragen und ein Benchmark den Vorteil belegt, und nutzen TPT nur, wenn eine externe Vorgabe es erzwingt."
pubDate: 2026-07-22
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
lang: "de"
translationOf: "2026/07/tph-vs-tpt-vs-tpc-inheritance-mapping-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-22
---

In EF Core 11 (mit .NET 11 und C# 14) mappen Sie eine Klassenhierarchie mit **Table-per-Hierarchy (TPH)**, sofern Sie keinen gemessenen Grund dagegen haben. TPH legt die gesamte Hierarchie in eine einzige Tabelle mit einer Diskriminatorspalte, sodass Lesevorgänge Scans einer einzelnen Tabelle ohne Joins sind. Greifen Sie nur dann zu **Table-per-Concrete-Type (TPC)**, wenn Ihr Code überwiegend einen einzelnen Blatttyp abfragt und ein Benchmark auf Ihren Daten zeigt, dass er TPH schlägt. Verwenden Sie **Table-per-Type (TPT)** nur, wenn eine externe Vorgabe es erzwingt, denn Microsofts eigener Benchmark setzt TPT bei einer Abfrage des Basistyps auf ungefähr die doppelte Zeit und fast die doppelten Allokationen von TPH. Die Regel in einer Zeile: TPH als Standard, TPC für blattlastige Workloads, die schneller messen, TPT niemals aus freien Stücken.

Dieser Artikel ist die Entscheidung, nicht die vollständige Konfigurationsanleitung. Wenn Sie die Diskriminator-API, geteilte Spalten und die Mechanik nullbarer Spalten im Detail möchten, lesen Sie [wie Sie das Table-per-Hierarchy-(TPH-)Vererbungsmapping in EF Core 11 konfigurieren](/de/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/). Hier stellen wir die drei Strategien nebeneinander, zeigen das Schema, das jede erzeugt, und benennen die Einschränkungen, die die Entscheidung für Sie treffen.

## Die Funktionsmatrix auf einem Bildschirm

Nehmen Sie eine zweistufige Hierarchie: eine Basisklasse `Blog` und eine abgeleitete Klasse `RssBlog`, die ein `RssUrl` hinzufügt. Die drei Strategien mappen dies auf drei völlig verschiedene Schemata, und jeder Kompromiss unten folgt aus dieser Form.

| Dimension                              | TPH                          | TPT                                | TPC                                   |
| -------------------------------------- | ---------------------------- | ---------------------------------- | ------------------------------------- |
| Erzeugte Tabellen                      | eine, gesamte Hierarchie     | eine pro Typ (inkl. abstrakter)    | eine pro konkretem Typ                |
| Diskriminatorspalte                    | ja                           | nein                               | nein                                  |
| Spalten abgeleiteter Typen             | nullbar, geteilte Tabelle    | eigene Tabelle, `NOT NULL` möglich | eigene Tabelle, `NOT NULL` möglich    |
| Basistyp-Abfrage (`context.Blogs`)     | ein `SELECT`, kein Join      | `LEFT JOIN` über alle Tabellen     | `UNION ALL` über konkrete Tabellen    |
| Einzelblatt-Abfrage (`OfType<RssBlog>`)| Diskriminator-Prädikat       | Join Basis- + Blatt-Tabelle        | eine Tabelle, kein Filter             |
| Speicherform                           | breit, dünn besetzt, viele Nulls| normalisiert, keine Nulls       | denormalisiert, Spalten wiederholt    |
| Schlüsselerzeugung                     | beliebig (Identity ok)       | beliebig (Identity auf Basis)      | geteilte Sequenz, kein einfaches Identity |
| FK-Constraint zum Basistyp             | ja                           | ja                                 | nein (Schlüssel in der Blatt-Tabelle) |
| Komplexe Typen / JSON-Spalten          | ja                           | ja (neu in EF Core 11)             | ja (neu in EF Core 11)                |
| Basistyp-Lesevorgang: relative Geschwindigkeit| am schnellsten (Basis) | ~2x langsamer                      | ~gleich wie TPH                       |
| Microsofts Haltung                     | empfohlener Standard         | "nur wenn dazu gezwungen"          | gut für Einzelblatt-Abfragen          |

Das Muster ist nicht subtil. TPH gewinnt oder liegt gleichauf in fast jeder Zeile, die zählt, TPC zieht damit gleich, außer wenn Sie typübergreifend abfragen, und TPT tauscht ein sauberer aussehendes Schema gegen Joins, die Sie zur Abfragezeit kosten. Drei dieser Zellen haben sich in EF Core 11 geändert: komplexe Typen und JSON-Spalten funktionieren nun auf TPT- und TPC-Hierarchien, was zuvor nicht unterstützt wurde und die Leute für jedes geerbte Wertobjekt zurück zu Owned Entities drängte. Das schließt einen der letzten nicht leistungsbezogenen Gründe, TPT und TPC zu meiden, ändert aber das Leistungsurteil nicht.

## Was jede Strategie tatsächlich in die Datenbank schreibt

Die Schemata machen die abstrakten Kompromisse konkret. TPH ist eine einzige Tabelle mit einem Diskriminator und nullbaren abgeleiteten Spalten:

```sql
-- TPH: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL IDENTITY,
    [Url] nvarchar(max) NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [RssUrl] nvarchar(max) NULL,          -- nullable: base Blogs have no RssUrl
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);
```

TPT teilt jeden Typ in seine eigene Tabelle auf, verbunden durch einen Fremdschlüssel auf dem geteilten Primärschlüssel:

```sql
-- TPT: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL IDENTITY,
    [Url] nvarchar(max) NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);

CREATE TABLE [RssBlogs] (
    [BlogId] int NOT NULL,
    [RssUrl] nvarchar(max) NULL,
    CONSTRAINT [PK_RssBlogs] PRIMARY KEY ([BlogId]),
    CONSTRAINT [FK_RssBlogs_Blogs_BlogId] FOREIGN KEY ([BlogId])
        REFERENCES [Blogs] ([BlogId]) ON DELETE NO ACTION
);
```

TPC gibt jedem konkreten Typ eine eigenständige Tabelle mit jeder geerbten Spalte wiederholt, mit Schlüsseln auf Basis einer geteilten Sequenz:

```sql
-- TPC: EF Core 11, SQL Server
CREATE TABLE [Blogs] (
    [BlogId] int NOT NULL DEFAULT (NEXT VALUE FOR [BlogSequence]),
    [Url] nvarchar(max) NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([BlogId])
);

CREATE TABLE [RssBlogs] (
    [BlogId] int NOT NULL DEFAULT (NEXT VALUE FOR [BlogSequence]),
    [Url] nvarchar(max) NULL,             -- inherited column, repeated here
    [RssUrl] nvarchar(max) NULL,
    CONSTRAINT [PK_RssBlogs] PRIMARY KEY ([BlogId])
);
```

Jede zu konfigurieren ist eine einzige Zeile auf der Wurzelentität. TPH ist der Standard und benötigt nichts; TPT und TPC aktivieren Sie mit einem Aufruf der Mapping-Strategie:

```csharp
// EF Core 11: choosing a strategy on the root entity type
modelBuilder.Entity<Blog>().UseTphMappingStrategy(); // default, can be omitted
modelBuilder.Entity<Blog>().UseTptMappingStrategy(); // one table per type
modelBuilder.Entity<Blog>().UseTpcMappingStrategy(); // one table per concrete type
```

## Wann Sie TPH wählen

TPH ist die richtige Antwort für die große Mehrheit der Hierarchien. Wählen Sie es, wenn:

- **Sie über die Hierarchie hinweg abfragen.** Jeder Code, der den Basistyp liest (eine Liste aller `Payment`-Zeilen, ein Dashboard, das `CardPayment` und `BankTransferPayment` mischt), ist unter TPH ein Scan einer indizierten Tabelle. Es gibt keinen Join und kein `UNION`. Dies ist das häufigste Zugriffsmuster, und genau hier versagt TPT.
- **Die Hierarchie flach ist oder die abgeleiteten Typen wenige Spalten hinzufügen.** Zwei oder drei Untertypen, die je eine Handvoll Eigenschaften hinzufügen, erzeugen eine nur leicht dünn besetzte Tabelle. Datenbanken kommen gut mit leeren Spalten zurecht, und in SQL Server können Sie selten befüllte TPH-Spalten als [Sparse-Spalten](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns) markieren, um den Platz zurückzugewinnen.
- **Sie die einfachsten Schreibvorgänge möchten.** Ein TPH-Insert ist eine Zeile in einer Tabelle. `ExecuteUpdate` und `ExecuteDelete` gegen einen abgeleiteten Typ wenden das Diskriminator-Prädikat für Sie an und berühren eine einzige Tabelle, was der saubere Massenschreibpfad ist, der in [wie Sie ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge in EF Core 11 verwenden](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) beschrieben wird.
- **Sie einen Fremdschlüssel zum Basistyp benötigen.** Da jede Zeile in einer Tabelle liegt, erhält eine Beziehung, die auf den Basistyp zeigt, ein echtes FK-Constraint. TPC kann dieses Constraint nicht erzwingen, wie unten behandelt.

Der einzige Preis, den Sie akzeptieren, ist, dass eine auf einem abgeleiteten Typ erforderliche Eigenschaft dennoch auf eine nullbare Spalte gemappt wird, weil Geschwisterzeilen sie leer lassen. Wenn datenbankseitig erzwungene Nicht-Nullbarkeit auf abgeleiteten Eigenschaften eine harte Anforderung ist, ist das der klassische Grund, TPH zu verlassen, und er zeigt auf TPT.

## Wann Sie TPC wählen

TPC ist der Spezialist. Es kommt bei typübergreifenden Abfragen nahe an TPH heran und zieht in einer bestimmten Form davon:

- **Sie fragen fast immer einen einzelnen Blatttyp ab.** Wenn Ihr heißer Pfad `context.RssBlogs.Where(...)` ist und selten `context.Blogs`, liest TPC eine eigenständige Tabelle ohne Diskriminatorfilter und ohne Join. Microsofts Leitfaden ist eindeutig: TPC glänzt "beim Abfragen von Entitäten eines einzelnen Blatttyps". Messen Sie es gegen TPH auf Ihren Daten, bevor Sie sich festlegen, denn der Vorteil hängt von der Workload ab.
- **Sie Nicht-Null-Spalten abgeleiteter Typen ohne die Joins von TPT möchten.** Jede TPC-Tabelle enthält alle Spalten eines konkreten Typs inline, sodass eine erforderliche abgeleitete Eigenschaft in ihrer eigenen Tabelle `NOT NULL` sein kann, und das Lesen dieses Typs bleibt eine Einzeltabelle. Das ist die Eigenschaft, die TPT mit einem Join erkauft und TPC ohne ihn.

Der Preis ist ein denormalisiertes Schema und umständliche Schlüssel. TPC kann keine einfache `Identity`-Spalte verwenden, weil es keine einzelne Tabelle gibt, die die Sequenz besitzt; EF Core 11 verwendet standardmäßig eine geteilte Datenbanksequenz (`NEXT VALUE FOR [BlogSequence]`), damit die Schlüssel über Geschwistertabellen hinweg eindeutig bleiben. In SQLite, das keine Sequenzen hat, ist die Erzeugung ganzzahliger Schlüssel für TPC nicht verfügbar, und Sie greifen auf clientseitig erzeugte GUIDs zurück. Und da der Primärschlüssel eines Basistyps in jeder konkreten Tabelle liegen kann, kann ein Fremdschlüssel, der den Basistyp referenziert, überhaupt nicht durch ein Datenbank-Constraint erzwungen werden. Wenn alle Ihre Schreibvorgänge über EF Core mit Navigationen laufen, ist das meist in Ordnung, aber es ist ein echter Verlust an Integrität auf Datenbankebene.

## Wann Sie TPT wählen (und warum die Antwort meist "nicht" lautet)

TPT erzeugt das Schema, das Ihrem Klassendiagramm am ähnlichsten sieht: eine Tabelle pro Typ, verbunden über den Schlüssel. Diese Ästhetik ist die Falle. Greifen Sie nur dann zu TPT, wenn:

- **Eine externe Vorgabe das Schema diktiert.** Ein DBA erzwingt eine normalisierte Tabelle pro Typ, ein Legacy-Schema, das Sie nicht ändern können, sieht bereits so aus, oder ein anderes System liest die Tabellen pro Typ direkt. Das sind die von Microsoft benannten Fälle von "durch externe Faktoren gezwungen".
- **Sie wirklich Tabellen pro Typ mit FK-Constraints und Nicht-Null-Spalten abgeleiteter Typen benötigen und typübergreifende Abfragen selten sind.** Das ist eine schmale Schnittmenge, und selbst dann sollten Sie zuerst gegen TPC benchmarken.

Wählen Sie TPT nicht, weil es sich sauberer anfühlt. Jede Basistyp-Abfrage joint über die gesamte Menge an Tabellen, und Joins sind eine der Hauptquellen relationaler Leistungsprobleme. Die Zahlen bestätigen das, was der nächste Abschnitt ist.

## Der Benchmark: TPT kostet ungefähr 2x

Das ist kein Gerede. Microsofts eigener Vererbungs-Benchmark baut eine Hierarchie mit 7 Typen auf, befüllt 5000 Zeilen pro Typ (35000 Zeilen insgesamt) und lädt jede Zeile aus der Datenbank. Die Ergebnisse:

| Methode| Mittel    | Allokiert |
| ------ | --------- | --------- |
| TPH    | 149.0 ms  | 40 MB     |
| TPT    | 312.9 ms  | 75 MB     |
| TPC    | 158.2 ms  | 46 MB     |

TPT ist ungefähr 2,1x langsamer als TPH und allokiert fast die doppelte Menge Speicher, weil das Laden der Hierarchie sieben Tabellen joint. TPC liegt bei dieser Abfrage aller Typen innerhalb von etwa 6 Prozent von TPH und würde TPH bei einer Einzelblatt-Abfrage übertreffen, bei der es eine Tabelle liest und TPH weiterhin die geteilte Tabelle mit einem Diskriminatorfilter scannt. Die Methodik zählt: Dies ist eine Basistyp-Abfrage, die jede Tabelle berührt, was der schwächste Fall von TPC und von TPT ist, sodass die Lücke, die Sie in Ihrer Workload sehen, davon abhängt, wie oft Sie typübergreifend gegenüber einem Blatttyp abfragen. Die Kernaussage ist dennoch über Läufe hinweg stabil: TPT zahlt eine Join-Steuer, die TPH und TPC nicht zahlen, und kein Argument der Schema-Ästhetik kauft das zurück.

Führen Sie den Benchmark gegen Ihr eigenes Modell aus, bevor Sie eine unumkehrbare Entscheidung treffen. Eine Vererbungsstrategie nach dem Vorliegen von Produktionsdaten zu ändern bedeutet eine Schemamigration, die Zeilen zwischen Tabellen verschiebt, daher ist dies eine Entscheidung, die es wert ist, einmal früh gemessen zu werden.

## Die Fallstricke, die für Sie entscheiden

Drei Einschränkungen können die Strategie unabhängig von der Vorliebe entscheiden.

Die erste ist **datenbankseitig erzwungene Nicht-Nullbarkeit auf einer abgeleiteten Eigenschaft**. TPH kann das nicht, weil die geteilte Spalte für die Geschwisterzeilen nullbar sein muss. Wenn Sie brauchen, dass die Datenbank (nicht nur Ihre Anwendung) garantiert, dass jedes `CardPayment` ein `Last4` hat, benötigen Sie diese Spalte in ihrer eigenen Tabelle, was TPT oder TPC bedeutet.

Die zweite ist die **Schlüsselerzeugung auf Ihrer Datenbank**. TPC benötigt Sequenzen für ganzzahlige Schlüssel. In SQL Server ist das automatisch, aber in SQLite können Sie mit TPC überhaupt keine ganzzahligen Identity-Schlüssel verwenden und müssen auf GUIDs umsteigen. Wenn Sie auf SQLite sind und ganzzahlige Schlüssel wollen, fällt TPC weg.

Die dritte ist die **Fremdschlüssel-Integrität zum Basistyp**. Wenn andere Tabellen Ihren Basistyp referenzieren und Sie möchten, dass die Datenbank diese Referenzen erzwingt, kann TPC Ihnen das Constraint nicht geben. TPH und TPT können es. Dies allein schließt TPC für viele normalisierte Schemata aus.

Eine Sache ist bei allen drei gleich: Sie können den Typ einer Entität nicht zur Laufzeit ändern. Ein `CardPayment` in ein `BankTransferPayment` zu verwandeln ist in jeder Strategie ein Delete plus ein Insert, weil der Diskriminator (oder die Tabelle selbst) den Typ kodiert. Das ist eine Realität der Modellierung, kein Unterscheidungsmerkmal.

## Die Empfehlung, klar gesagt

Verwenden Sie standardmäßig TPH. Es ist am schnellsten für die häufige typübergreifende Abfrage, am einfachsten, um dagegen zu schreiben, die einzige Strategie ohne Reibung bei der Schlüsselerzeugung und der von Microsoft empfohlene Standard für ein breites Spektrum an Szenarien. Greifen Sie nur dann zu TPC, wenn Ihre Workload von Abfragen eines einzelnen Blatttyps dominiert wird und ein Benchmark auf Ihren Daten zeigt, dass es TPH schlägt, und akzeptieren Sie das denormalisierte Schema, die Schlüssel aus einer geteilten Sequenz und das fehlende FK-Constraint zum Basistyp, die damit einhergehen. Verwenden Sie TPT nur, wenn ein externer Faktor Ihnen keine Wahl lässt, und tun Sie es im Wissen, dass Sie eine Abfragesteuer von ungefähr 2x für ein Schema zahlen, das ordentlicher aussieht.

Das mentale Modell ist dasselbe, das die Zahlen erzwingen: eine Tabelle ist schnell, viele per Join verbundene Tabellen sind langsam, und viele Tabellen ohne Join sind schnell, aber denormalisiert. Wenn diese Entscheidung Teil eines breiteren Versionswechsels ist, tauchen die Änderungen an Vererbung und Mapping tendenziell zusammen mit denen im [Migrationsleitfaden von EF Core 6 zu EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) auf.

## Weiterführende Lektüre

- [Wie Sie das Table-per-Hierarchy-(TPH-)Vererbungsmapping in EF Core 11 konfigurieren](/de/2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11/) ist die vollständige TPH-Anleitung: Diskriminator-API, geteilte Spalten und die Regel nullbarer Spalten.
- [Komplexe Typen vs Owned Entities in EF Core 11](/de/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) behandelt das Mapping von Wertobjekten, das nun innerhalb von TPT- und TPC-Hierarchien funktioniert.
- [Wie Sie JSON-Spalten in EF Core 11 mappen und abfragen](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) erklärt die JSON-Speicherung, die Vererbungshierarchien in EF Core 11 erhalten haben.
- [Wie Sie ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge in EF Core 11 verwenden](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) zeigt den Einzeltabellen-Massenschreibpfad, den TPH sauber macht.
- [Wie Sie N+1-Abfragen in EF Core 11 erkennen](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11) hilft, die joinlastigen Abfragemuster zu erkennen, die TPT begünstigen kann.

## Quellen

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Modeling for performance: inheritance mapping (with the TPH/TPT/TPC benchmark)](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core inheritance benchmark source](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Benchmarks/Inheritance.cs)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [SQL Server sparse columns](https://learn.microsoft.com/en-us/sql/relational-databases/tables/use-sparse-columns)
