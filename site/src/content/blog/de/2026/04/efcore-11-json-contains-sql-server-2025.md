---
title: "EF Core 11 übersetzt Contains zu JSON_CONTAINS auf SQL Server 2025"
description: "EF Core 11 übersetzt LINQ Contains über JSON-Collections automatisch in die neue SQL Server 2025 JSON_CONTAINS-Funktion und ergänzt EF.Functions.JsonContains für pfad- und modus-spezifische Queries, die einen JSON-Index treffen können."
pubDate: 2026-04-20
tags:
  - "dotnet-11"
  - "ef-core-11"
  - "sql-server"
  - "json"
  - "linq"
lang: "de"
translationOf: "2026/04/efcore-11-json-contains-sql-server-2025"
translatedBy: "claude"
translationDate: 2026-04-24
---

SQL Server 2025 hat eine native [`JSON_CONTAINS`](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql)-Funktion bekommen, und EF Core 11 ist das Release, das sich daran ankoppelt. Zwei Dinge ändern sich für alle, die Collections als JSON-Spalten speichern: `Contains` über JSON-Collections bekommt jetzt eine direkte Übersetzung statt dem alten `OPENJSON`-Join, und es gibt ein neues `EF.Functions.JsonContains()` für Fälle, in denen Sie einen JSON-Pfad oder einen bestimmten Suchmodus brauchen. Die Arbeit ist Teil von [EF Core 11 Preview 3](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview3/efcore.md).

## Die SQL Server 2025 Compatibility Level einschalten

Die neue Übersetzung schaltet sich nur ein, wenn der Provider weiß, dass er mit SQL Server 2025 spricht. Sie machen das über `UseCompatibilityLevel(170)` an den Provider-Optionen:

```csharp
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

Compatibility Level 170 ist, was SQL Server 2025 meldet; niedrigere Level verwenden weiterhin die ältere Übersetzung, daher ist es sicher, das wegzulassen, bis Sie tatsächlich die Datenbank upgraden.

## Wie Contains jetzt aussieht

Nehmen Sie eine klassische "Tags als JSON-Array"-Form:

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<string> Tags { get; set; } = new();
}

modelBuilder.Entity<Blog>()
    .Property(b => b.Tags)
    .HasColumnType("json"); // SQL Server 2025 native JSON type
```

Auf EF Core 10 oder einem älteren SQL Server-Target liefert diese Query:

```csharp
var posts = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

die `OPENJSON`-Übersetzung, die sich wie eine korrelierte Subquery liest:

```sql
WHERE N'ef-core' IN (
    SELECT [t].[value]
    FROM OPENJSON([b].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)
```

EF Core 11 gegen Compatibility Level 170 emittiert stattdessen das hier:

```sql
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

Der Grund, warum das wichtig ist, ist nicht nur SQL-Schönheit. `JSON_CONTAINS` ist das einzige Prädikat in SQL Server 2025, das einen [JSON-Index](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) verwenden kann. Wenn Sie `CREATE JSON INDEX IX_Tags ON Blogs(Tags)` haben, wird der `OPENJSON`-Pfad ihn nie anrühren, die EF 11 Übersetzung schon.

Es gibt eine Falle, die in den Release Notes erwähnt wird: `JSON_CONTAINS` behandelt NULL nicht so wie LINQs `Contains`, also wählt EF die neue Übersetzung nur, wenn mindestens eine Seite nachweislich non-nullable ist (eine non-null-Konstante oder eine non-nullable Spalte). Wenn beide Seiten null sein können, fällt EF auf `OPENJSON` zurück, um das bestehende Verhalten zu bewahren.

## Wenn Sie einen Pfad oder einen Suchmodus brauchen

`Contains` deckt den "ist dieser Skalar im Array"-Fall ab. Für alles andere stellt EF Core 11 `EF.Functions.JsonContains(container, value, path?, mode?)` bereit. Das klassische Beispiel ist das Nachschlagen eines Werts an einem bestimmten Pfad in einem strukturierten JSON-Dokument:

```csharp
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string JsonData { get; set; } = "{}"; // { "Rating": 8, ... }
}

var ratedEights = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

Übersetzt zu:

```sql
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

Sie können es mit skalaren String-Spalten verwenden, mit Complex Types, die auf JSON gemappt sind, und mit Owned Types, die via `OwnsOne(... b.ToJson())` gemappt sind. Der Vergleich gegen `= 1` ist load-bearing: `JSON_CONTAINS` gibt ein `bit` zurück, und EF bewahrt das, sodass zusammengesetzte Prädikate wie `WHERE ... AND JSON_CONTAINS(...) = 1` gegen einen JSON-Index SARGable bleiben.

Paaren Sie das mit [`EF.Functions.JsonPathExists`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) für "existiert die Property überhaupt"-Checks, und Sie decken den Großteil der JSON-Spalten-Query-Oberfläche ab, ohne in rohes SQL absteigen zu müssen. Die vollständige Liste der EF Core 11 Translator-Änderungen steht in der [What's New](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)-Dokumentation.
