---
title: "EF Core 11 Preview 4: Periodenspalten temporaler Tabellen können endlich echte Eigenschaften sein"
description: "EF Core 11 Preview 4 hebt die langjährige Shadow-Property-Beschränkung für SQL-Server-temporale-Tabellen auf. PeriodStart und PeriodEnd können jetzt reguläre CLR-Eigenschaften sein, konfiguriert mit stark typisierten HasPeriodStart- und HasPeriodEnd-Lambdas."
pubDate: 2026-05-26
tags:
  - "ef-core"
  - "dotnet-11"
  - "sql-server"
  - "csharp"
  - "dotnet"
lang: "de"
translationOf: "2026/05/ef-core-11-temporal-tables-clr-period-properties"
translatedBy: "claude"
translationDate: 2026-05-26
---

EF Core unterstützt temporale SQL-Server-Tabellen seit Version 6.0, allerdings mit einer lästigen Einschränkung: Die Spalten `PeriodStart` und `PeriodEnd` mussten als Shadow Properties modelliert werden. Sie konnten sie zwar mit `EF.Property<DateTime>(entity, "PeriodStart")` abfragen, aber nicht auf Ihre Entitätsklasse legen und wie jede andere Spalte lesen. Diese Einschränkung ist in EF Core 11 Preview 4 verschwunden, veröffentlicht am 12. Mai 2026 als Teil von [.NET 11 Preview 4](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-4/).

Der Fix landet als [efcore#38110](https://github.com/dotnet/efcore/pull/38110) und schließt ein [Issue aus dem Jahr 2021](https://github.com/dotnet/efcore/issues/26463). Es ist eine kleine Änderung an Codezeilen und eine große Verbesserung der Ergonomie.

## Wie das alte Shadow-Property-Modell aussah

Vor Preview 4 konnte eine temporale Entität nur die Anwendungsspalten deklarieren. Die Periodenspalten lebten im Modell, aber nicht auf der Klasse:

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
}

modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal());
```

Das Lesen der Periodenwerte bedeutete den Umweg über den Change Tracker:

```csharp
var start = context.Entry(order).Property<DateTime>("PeriodStart").CurrentValue;
var end   = context.Entry(order).Property<DateTime>("PeriodEnd").CurrentValue;
```

Zwei Probleme. Erstens verlieren Sie IntelliSense und Refactor-Sicherheit: Der Spaltenname ist ein magischer String. Zweitens ist das Projizieren von Periodenwerten in einer LINQ-Abfrage unhandlich, weil die Eigenschaft auf dem CLR-Typ nicht existiert. Ein DTO mit dem Gültigkeitsfenster zu mappen, erforderte entweder eine rohe SQL-Abfrage oder `EF.Property<>` innerhalb des `Select`, beides kämpft gegen das Typsystem.

## Das Modell in Preview 4

In Preview 4 legen Sie die Periodenspalten einfach auf die Entität:

```csharp
public class Order
{
    public int Id { get; set; }
    public string Status { get; set; } = "";
    public DateTime PeriodStart { get; set; }
    public DateTime PeriodEnd { get; set; }
}
```

Konfigurieren Sie sie mit den neuen stark typisierten Überladungen von `HasPeriodStart` und `HasPeriodEnd`, die eine Lambda akzeptieren:

```csharp
modelBuilder.Entity<Order>().ToTable(tb => tb.IsTemporal(ttb =>
{
    ttb.HasPeriodStart(o => o.PeriodStart);
    ttb.HasPeriodEnd(o => o.PeriodEnd);
}));
```

Jetzt verhalten sich `PeriodStart` und `PeriodEnd` wie jede andere gemappte Spalte. Sie können sie auf einer materialisierten Entität lesen, in `Select` projizieren, nach ihnen sortieren und in normalem LINQ filtern:

```csharp
var openOrders = await context.Orders
    .Where(o => o.PeriodEnd == DateTime.MaxValue)
    .Select(o => new { o.Id, o.Status, o.PeriodStart })
    .ToListAsync();
```

Das Prädikat `PeriodEnd == DateTime.MaxValue` ist der kanonische "aktuelle Zeile"-Filter für temporale SQL-Server-Tabellen. Bisher musste man ihn gegen die Shadow Property schreiben.

## Was sich nicht ändert

Die Semantik der temporalen Tabelle auf der Datenbankseite ist identisch. SQL Server pflegt weiterhin die History-Tabelle, aktualisiert weiterhin `PeriodStart` und `PeriodEnd` bei jedem Schreibvorgang und lehnt weiterhin direkte Schreibzugriffe auf die Periodenspalten ab. EF Core markiert sie weiterhin als `ValueGeneratedOnAddOrUpdate` und ignoriert sie bei Insert und Update. Sie können sie lesen, nicht aber setzen.

Zeitreise-Abfragen funktionieren ebenfalls unverändert:

```csharp
var snapshot = await context.Orders
    .TemporalAsOf(new DateTime(2026, 5, 1))
    .ToListAsync();
```

Der einzige Unterschied: Die zurückgegebenen Entitäten tragen die Periodenwerte jetzt auf dem CLR-Objekt, statt sie hinter `EF.Property<>` zu verstecken.

## Die Migration ist optional

Wenn Sie ein bestehendes Modell mit Shadow-Periodenspalten haben, müssen Sie nichts ändern. Die alte API funktioniert weiterhin. Für jede neue temporal-gemappte Entität ist es jetzt der Weg des geringsten Widerstands, `PeriodStart` und `PeriodEnd` auf die Klasse zu legen.

Vollständige EF-Core-Notes zu Preview 4: [release-notes/11.0/preview/preview4/efcore.md](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview4/efcore.md).
