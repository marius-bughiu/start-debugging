---
title: "EF Core 11 beschneidet unnötige Referenz-Joins in Split Queries"
description: "EF Core 11 Preview 3 entfernt redundante To-one-Joins aus Split Queries und streicht überflüssige ORDER BY-Schlüssel. Ein gemeldetes Szenario wurde 29% schneller, ein anderes 22%. So sieht das SQL jetzt aus."
pubDate: 2026-04-18
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "performance"
  - "csharp"
lang: "de"
translationOf: "2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries"
translatedBy: "claude"
translationDate: 2026-04-24
---

Split Queries in EF Core hatten schon immer eine scharfe Kante: Wenn Sie `Include` von Referenznavigationen mit `Include` von Collection-Navigationen mischten, re-joinete jede Child-Query immer noch die Referenztabellen, obwohl nichts in diesen Collection-Queries sie brauchte. EF Core 11 Preview 3 behebt das, zusammen mit einer verwandten `ORDER BY`-Überspezifikation. Die [Release Notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) beziffern die Benchmark-Auswirkung auf 29% für ein gängiges Split-Query-Szenario und 22% für einen Single-Query-Fall. Das ist die Art Änderung, die in Produktion auftaucht, ohne dass Sie irgendein LINQ editieren müssen.

## Der zusätzliche Join, der nie nötig war

Betrachten Sie die kanonische Form: ein Blog mit einem To-One-`BlogType` und einer To-Many-`Posts`, geladen mit `AsSplitQuery()`:

```csharp
var blogs = context.Blogs
    .Include(b => b.BlogType)
    .Include(b => b.Posts)
    .AsSplitQuery()
    .ToList();
```

Split Queries laufen ein SQL pro inkludierter Collection plus die Root-Query. Die Root-Query braucht legitimerweise einen Join auf `BlogType`, um dessen Spalten zu projizieren. Die Collection-Query für `Posts` braucht ihn nicht, weil sie nur Post-Spalten projiziert. EF Core 10 und älter gaben den Join trotzdem aus:

```sql
-- Before EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id], [b0].[Id]
FROM [Blogs] AS [b]
INNER JOIN [BlogType] AS [b0] ON [b].[BlogTypeId] = [b0].[Id]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id], [b0].[Id]
```

Dieses zusätzliche `INNER JOIN [BlogType]` wird für jede Zeile aufgelöst und nimmt dann am Sort teil, ohne Payload-Grund. EF Core 11 beschneidet es:

```sql
-- EF Core 11
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Post] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]
```

Je mehr Referenznavigationen Sie in den `Include` gebündelt hatten, desto mehr Joins verschwinden. Wenn Ihr Domänenmodell auf `Include` kleiner Lookups (`Country`, `Status`, `Currency`) neben einer echten Collection setzt, ist das im Wesentlichen kostenloser Durchsatz.

## ORDER BY-Überspezifikation, auch weg

Die zweite Optimierung gilt auch für Single Queries. Wenn Sie eine Referenznavigation inkludieren, hat EF historisch ihren Schlüssel in die `ORDER BY`-Klausel ausgegeben, obwohl der Primary Key des Parents ihn bereits über den Foreign Key bestimmt:

```csharp
var blogs = context.Blogs
    .Include(b => b.Owner)
    .Include(b => b.Posts)
    .ToList();
```

Vor EF Core 11:

```sql
ORDER BY [b].[BlogId], [p].[PersonId]
```

In EF Core 11:

```sql
ORDER BY [b].[BlogId]
```

`BlogId` ist eindeutig, und `PersonId` war über den FK vollständig durch `BlogId` bestimmt, also war ihn im Sort-Schlüssel zu behalten reiner Aufwand. Ihn fallen zu lassen verkürzt den Sort-Schlüssel, was wichtig wird, sobald die Tabelle groß genug ist, um auf Disk zu spillen, oder sobald der Planner einen Merge Join über das Ergebnis wählt.

## Wann Sie es merken werden

Die größten Gewinne sehen Sie bei Queries mit mehreren kleinen Referenz-Includes plus einer oder mehrerer Collection-Includes, weil diese früher dieselben unnötigen Joins über jede Child-Query wiederholt haben. Customer-Order, Invoice-With-Lines und Blog-With-Posts sind die offensichtlichen Kandidaten. Queries ohne `AsSplitQuery()` und Queries ohne Referenz-Includes bekommen die `ORDER BY`-Vereinfachung, aber nicht die Join-Beschneidung.

Es gibt keine API-Änderung und nichts anzuschalten. Upgraden Sie auf EF Core 11.0.0-preview.3 (gezielt auf .NET 11 Preview 3), lassen Sie dasselbe LINQ laufen, und das generierte SQL ist straffer. Benchmark-Details leben im [EF Core Tracking Issue](https://github.com/dotnet/efcore/issues/29182).
