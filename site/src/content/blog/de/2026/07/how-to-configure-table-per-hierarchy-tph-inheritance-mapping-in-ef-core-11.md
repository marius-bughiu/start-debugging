---
title: "Table-per-Hierarchy-Vererbungsmapping (TPH) in EF Core 11 konfigurieren"
description: "TPH ist die Standard-Vererbungsstrategie von EF Core: eine Tabelle, eine Diskriminatorspalte. So konfigurieren Sie den Diskriminator, teilen Spalten, behandeln nullbare abgeleitete Eigenschaften und kennen die Fallstricke in EF Core 11."
pubDate: 2026-07-13
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "inheritance"
  - "tph"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/07/how-to-configure-table-per-hierarchy-tph-inheritance-mapping-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-13
---

Kurze Antwort: In EF Core 11 (mit .NET 11 und C# 14) müssen Sie nichts tun, um Table-per-Hierarchy (TPH) zu erhalten. Es ist der Standard. In dem Moment, in dem Sie einen Basistyp und mindestens einen abgeleiteten Typ mappen, speichert EF Core die gesamte Hierarchie in einer Tabelle und fügt eine string-Spalte `Discriminator` hinzu, um die Zeilen zu unterscheiden. Bei der Konfiguration geht es darum, diesen Standard anzupassen: die Diskriminatorspalte mit `HasDiscriminator` umbenennen, die gespeicherten Werte mit `HasValue` wählen, den Diskriminator auf eine echte Eigenschaft mappen, die Hierarchie mit `IsComplete(false)` als unvollständig markieren und Spalten zwischen Geschwistertypen teilen. EF Core 11 beseitigt außerdem eine langjährige Einschränkung, indem komplexe Typen und JSON-Spalten nun in Vererbungshierarchien funktionieren, und behebt einen TPH-spezifischen Nullbarkeits-Bug für auf JSON gemappte komplexe Eigenschaften.

Dieser Artikel behandelt die genaue Konfigurations-API, das Schema, das EF Core generiert, wie eine Abfrage gegen eine TPH-Hierarchie tatsächlich funktioniert, den Fallstrick mit nullbaren Spalten, der jeden mindestens einmal erwischt, und wann TPH nicht mehr die richtige Wahl ist.

## Warum TPH der Standard und meist der richtige ist

EF Core unterstützt drei relationale Vererbungsstrategien: Table-per-Hierarchy (TPH), Table-per-Type (TPT) und Table-per-Concrete-Type (TPC). TPH ist der Standard, weil es für den häufigen Fall am schnellsten ist. Alles liegt in einer Tabelle, sodass das Laden einer Entität ein Lesevorgang über eine einzelne Zeile ohne Joins ist, und die Abfrage des Basistyps ein einfaches `SELECT` ohne `UNION` und ohne Verteilung über mehrere Tabellen. Die [EF-Core-Vererbungsdokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance) und die [Performance-Anleitung](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping) kommen zur selben Regel: Verwenden Sie TPH, sofern nicht ein Benchmark oder eine externe Einschränkung Sie davon abbringt.

Der Preis, den Sie zahlen, ist eine breitere, dünner besetzte Tabelle. Jede Eigenschaft jedes abgeleiteten Typs wird zu einer Spalte der gemeinsamen Tabelle, und jede Spalte, die nur einige Zeilen verwenden, muss nullbar sein. Für die meisten Hierarchien ist dieser Kompromiss in Ordnung. Wenn er es nicht mehr ist, wechseln Sie zu TPT oder TPC, was eine separate Entscheidung ist, die am Ende behandelt wird.

## Das Standard-Mapping, ohne jegliche Konfiguration

EF durchsucht Ihr Assembly nicht nach abgeleiteten Typen. Sie nehmen jeden Typ explizit in das Modell auf, in der Regel durch Bereitstellen eines `DbSet` oder durch Referenzieren in `OnModelCreating`. Hier eine zweistufige Hierarchie:

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public string Network { get; set; } = "";
}

public class BankTransferPayment : Payment
{
    public string Iban { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
public class PaymentsContext : DbContext
{
    public DbSet<Payment> Payments { get; set; } = null!;
    public DbSet<CardPayment> CardPayments { get; set; } = null!;
    public DbSet<BankTransferPayment> BankTransferPayments { get; set; } = null!;
}
```

Ohne jegliche Vererbungskonfiguration generiert EF Core 11 eine einzige Tabelle mit jeder Eigenschaft jedes Typs, dazu eine Spalte `Discriminator`, die es implizit hinzufügt:

```sql
CREATE TABLE [Payments] (
    [Id] int NOT NULL IDENTITY,
    [Amount] decimal(18,2) NOT NULL,
    [CreatedAt] datetime2 NOT NULL,
    [Discriminator] nvarchar(max) NOT NULL,
    [Last4] nvarchar(max) NULL,
    [Network] nvarchar(max) NULL,
    [Iban] nvarchar(max) NULL,
    CONSTRAINT [PK_Payments] PRIMARY KEY ([Id])
);
```

Zwei Dinge fallen auf. Der Diskriminator ist eine string-Spalte, die den CLR-Typnamen speichert (`"CardPayment"`, `"BankTransferPayment"`, `"Payment"`), damit EF weiß, welchen Typ es für jede Zeile materialisieren muss. Und `Last4`, `Network` und `Iban` sind alle nullbar, weil eine `BankTransferPayment`-Zeile keine Kartenfelder und eine `CardPayment`-Zeile keine IBAN hat. Diese Nullbarkeit ist automatisch und, wie wir sehen werden, für eine Eigenschaft eines abgeleiteten Typs nicht überschreibbar.

## Wie eine TPH-Abfrage nach Typ filtert

Wenn Sie den Basistyp abfragen, liest EF Core jede Zeile und verwendet den Diskriminator, um für jede das richtige konkrete Objekt zu erstellen:

```csharp
// .NET 11, EF Core 11
var all = await context.Payments.ToListAsync();
// SELECT [p].[Id], [p].[Amount], [p].[CreatedAt], [p].[Discriminator],
//        [p].[Last4], [p].[Network], [p].[Iban]
// FROM [Payments] AS [p]
```

Wenn Sie einen abgeleiteten Typ abfragen, fügt EF ein Prädikat über den Diskriminator hinzu, sodass Sie nur die passenden Zeilen erhalten:

```csharp
// .NET 11, EF Core 11
var cards = await context.CardPayments
    .Where(c => c.Network == "Visa")
    .ToListAsync();
// ... WHERE [p].[Discriminator] = N'CardPayment' AND [p].[Network] = N'Visa'
```

Sie können auch innerhalb einer Basistyp-Abfrage mit `OfType<T>()` oder einem C#-Typmuster nach Typ filtern, und beide werden in dasselbe Diskriminator-Prädikat übersetzt:

```csharp
// .NET 11, EF Core 11
var cardsOnly = await context.Payments.OfType<CardPayment>().ToListAsync();
```

Es gibt eine Materialisierungsregel, die man kennen sollte: Wenn die Tabelle einen Diskriminatorwert enthält, der keinem Typ in Ihrem Modell zugeordnet ist, wirft EF eine Ausnahme, sobald es auf diese Zeile trifft, weil es nicht weiß, was es erstellen soll. Das passiert nur, wenn etwas außerhalb von EF Zeilen mit einem unbekannten Diskriminator geschrieben hat. Wenn das Ihre Situation ist, markieren Sie das Mapping als unvollständig (siehe unten), damit EF das Diskriminator-Filterprädikat immer hinzufügt, auch bei Basistyp-Abfragen.

## Die Diskriminatorspalte und ihre Werte konfigurieren

Die implizite Spalte `Discriminator` und die darin gespeicherten CLR-Typnamen sind selten das, was Sie in einem Schema wollen, mit dem Sie leben müssen. Benennen Sie die Spalte um, legen Sie ihren Typ fest und wählen Sie stabile string-Werte mit `HasDiscriminator` und `HasValue`:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Payment>()
        .HasDiscriminator<string>("payment_type")
        .HasValue<Payment>("base")
        .HasValue<CardPayment>("card")
        .HasValue<BankTransferPayment>("bank_transfer");
}
```

Explizite `HasValue`-Strings festzulegen ist wichtiger, als es aussieht. Wenn Sie sich auf den Standard verlassen (den CLR-Typnamen), ändert das Umbenennen einer Klasse bei einem späteren Refactoring stillschweigend den gespeicherten Diskriminatorwert, und jede vorhandene Zeile in der Produktion hat nun einen Wert, den Ihr neues Modell nicht erkennt. Explizite Werte entkoppeln die Datenbank von Ihren Klassennamen.

Der Diskriminator muss kein string sein. Ein `int` oder ein `enum` ist kleiner und indexiert besser:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator<int>("payment_type")
    .HasValue<Payment>(0)
    .HasValue<CardPayment>(1)
    .HasValue<BankTransferPayment>(2);
```

Da EF den Diskriminator implizit als [Shadow Property](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties) hinzufügt, können Sie ihn wie jede andere Eigenschaft konfigurieren, zum Beispiel die string-Länge begrenzen, damit sie nicht `nvarchar(max)` ist:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .Property("payment_type")
    .HasMaxLength(20);
```

## Den Diskriminator auf eine echte .NET-Eigenschaft mappen

Manchmal möchten Sie, dass die Typmarkierung an der Entität selbst lesbar ist und nicht in einer Shadow Property versteckt. Fügen Sie dem Basistyp eine Eigenschaft hinzu und richten Sie `HasDiscriminator` darauf aus:

```csharp
// .NET 11, C# 14, EF Core 11
public class Payment
{
    public int Id { get; set; }
    public decimal Amount { get; set; }
    public DateTime CreatedAt { get; set; }
    public string PaymentType { get; set; } = "";
}
```

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator(p => p.PaymentType)
    .HasValue<CardPayment>("card")
    .HasValue<BankTransferPayment>("bank_transfer");
```

Jetzt wird `payment.PaymentType` bei jeder geladenen Entität befüllt. EF verwaltet den Wert: Es setzt ihn beim Insert anhand des konkreten Typs und lässt Sie keinen Wert schreiben, der dem Typ widerspricht. Behandeln Sie ihn in Ihrem Code als schreibgeschützt. Ein gemappter Diskriminator ist praktisch für Reporting-Abfragen und für API-Antworten, bei denen der Client den Typnamen benötigt, ohne dass Sie darüber reflektieren.

## EF mitteilen, dass die Hierarchie unvollständig ist

Wenn ein anderes System Zeilen in dieselbe Tabelle mit Diskriminatorwerten schreibt, die Sie bewusst nicht mappen, markieren Sie den Diskriminator als unvollständig, damit EF immer filtert, auch bei Basistyp-Abfragen:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Payment>()
    .HasDiscriminator()
    .IsComplete(false);
```

Mit `IsComplete(false)` fügt `context.Payments.ToListAsync()` `WHERE [payment_type] IN (N'card', N'bank_transfer', ...)` hinzu und überspringt Zeilen, deren Diskriminator nicht gemappt ist, anstatt bei ihnen eine Ausnahme zu werfen. Das ist genau der Ausweg für eine gemeinsame Tabelle, in der EF nur einige der Typen besitzt.

## Eine Spalte zwischen Geschwistertypen teilen

Standardmäßig erhalten zwei Geschwistertypen, die beide eine Eigenschaft mit demselben Namen deklarieren, zwei separate Spalten. Wenn die Eigenschaften vom selben Typ sind und wirklich denselben Speicher darstellen, mappen Sie sie mit `HasColumnName` auf eine Spalte:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Reference)
    .HasColumnName("Reference");

modelBuilder.Entity<BankTransferPayment>()
    .Property(b => b.Reference)
    .HasColumnName("Reference");
```

Das hält die Tabelle schmaler, aber es gibt eine Abfragefalle, auf die die Dokumentation ausdrücklich hinweist. Relationale Provider fügen das Diskriminator-Prädikat nicht hinzu, wenn Sie eine gemeinsame Spalte über einen Cast lesen. Eine Abfrage wie `(payment as CardPayment).Reference` liefert den `Reference`-Wert auch für die Geschwisterzeilen, weil die Spalte physisch geteilt ist. Um sie auf einen Typ zu beschränken, müssen Sie selbst nach dem Typ verzweigen:

```csharp
// .NET 11, EF Core 11 - guard the cast so siblings return null
var refs = await context.Payments
    .Select(p => p is CardPayment ? ((CardPayment)p).Reference : null)
    .ToListAsync();
```

Teilen Sie Spalten nur, wenn die Werte wirklich dasselbe Konzept sind. Im Zweifel lassen Sie EF jedem Geschwister seine eigene nullbare Spalte geben.

## Der Fallstrick mit nullbaren Spalten, den niemand erwartet

Hier ist der, der die Leute überrascht. Eine Eigenschaft, die für einen abgeleiteten Typ erforderlich ist, kann unter TPH keine `NOT NULL`-Spalte sein. Da sich alle Typen eine Tabelle teilen, muss eine Spalte, die zu `CardPayment` gehört, nullbar sein, damit `BankTransferPayment`-Zeilen sie leer lassen können. Selbst wenn `Last4` in C# `required` ist, muss EF Core sie als nullbare Spalte mappen:

```sql
[Last4] nvarchar(max) NULL   -- required on CardPayment, still NULL in the DB
```

Die Datenbank erzwingt für Sie nicht, dass "jede Kartenzahlung Last4 hat". Die Anwendungsschicht und EF Cores eigene Validierung erzwingen das beim Schreiben, aber ein roher `INSERT` oder eine fehlerhafte Migration kann eine Kartenzeile mit einem null-`Last4` erzeugen, und das Schema hält das nicht auf. Wenn datenbankseitig erzwungenes Non-Null bei abgeleiteten Eigenschaften eine harte Anforderung ist, ist das ein echter Grund, TPT zu wählen (jeder Typ erhält seine eigene Tabelle, sodass die Spalte dort `NOT NULL` sein kann) oder in einer Migration von Hand eine `CHECK`-Bedingung hinzuzufügen. Das ist der häufigste Grund, warum ein Team eine Hierarchie von TPH wegbewegt, also wägen Sie das ab, bevor Sie sich festlegen.

## Was sich in EF Core 11 für Vererbung geändert hat

TPH selbst ist seit Jahren stabil; die Änderungen in EF Core 11 betreffen das, was Sie in eine Hierarchie packen können. Komplexe Typen und JSON-Spalten funktionieren nun auf Entitätstypen, die TPT- und TPC-Vererbung verwenden, was zuvor nicht unterstützt wurde und Sie für jedes vererbte Wertobjekt zu Owned-Entitäten zurückzwang. TPH unterstützte komplexe Typen bereits, und EF Core 11 behob einen TPH-spezifischen Bug, bei dem eine [als JSON gespeicherte komplexe Eigenschaft in einer TPH-Klassenhierarchie fälschlicherweise als nicht nullbar markiert wurde](https://github.com/dotnet/efcore/issues/37404). Ein in eine TPH-Tabelle gemapptes Wertobjekt verhält sich nun nullbar so, wie es soll:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class CardMetadata
{
    public required string Bin { get; set; }
    public string? IssuerCountry { get; set; }
}

public class CardPayment : Payment
{
    public string Last4 { get; set; } = "";
    public CardMetadata? Metadata { get; set; }
}
```

Auch die Konfiguration wurde durchweg kürzer. EF Core 11 erlaubt es, den Memberzugriff direkt durch `Property` zu verketten, sodass das Vordringen in einen komplexen Typ oder eine diskriminatornahe Eigenschaft keinen Zwischen-Builder mehr benötigt:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<CardPayment>()
    .Property(c => c.Metadata!.Bin)
    .HasMaxLength(8);
```

Wenn Sie ein vererbtes Wertobjekt mit einem Table-Splitting- oder JSON-Mapping kombinieren, ist die Mechanik dieses Mappings dieselbe wie in [Wie man in EF Core 11 einen komplexen Typ statt einer Owned-Entität mappt](/de/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), und die JSON-Abfrageseite wird in [Wie man JSON-Spalten in EF Core 11 mappt und abfragt](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) behandelt.

## Massen-Updates und Query-Filter vertragen sich mit TPH

Da eine TPH-Hierarchie eine einzige Tabelle ist, zielen `ExecuteUpdate` und `ExecuteDelete` sauber auf einen abgeleiteten Typ und wenden das Diskriminator-Prädikat für Sie an:

```csharp
// .NET 11, EF Core 11
await context.CardPayments
    .Where(c => c.Network == "Amex")
    .ExecuteUpdateAsync(s => s.SetProperty(c => c.Amount, c => c.Amount * 1.03m));
// UPDATE [p] SET [p].[Amount] = ... WHERE [p].[payment_type] = N'card' AND ...
```

Die Kompromisse zwischen diesem Weg und dem Laden von Entitäten sind dieselben wie in [Wie man ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge in EF Core 11 verwendet](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/). Query-Filter kombinieren sich ebenfalls mit dem Diskriminator, sodass ein Soft-Delete- oder Multi-Tenant-Filter auf dem Basistyp für die gesamte Hierarchie gilt, wie in [Wie man benannte Query-Filter für Soft Delete und Mandantenfähigkeit in EF Core 11 verwendet](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) beschrieben.

## Wann Sie TPH verlassen sollten

Bleiben Sie bei TPH, sofern nicht eine dieser Bedingungen zutrifft:

- **Sie benötigen datenbankseitig erzwungenes Non-Null bei abgeleiteten Eigenschaften.** TPH kann das nicht; die gemeinsame Spalte muss nullbar sein. TPT gibt jedem Typ seine eigene Tabelle, in der die Spalte `NOT NULL` sein kann.
- **Die Tabelle wird wirklich dünn besetzt und breit.** Eine Hierarchie mit vielen abgeleiteten Typen, von denen jeder mehrere im Code erforderliche Spalten hinzufügt, erzeugt eine Tabelle, die überwiegend aus Nulls besteht. Wenn das dem Speicher schadet oder Ihr DBA es ablehnt, normalisiert TPT das auf Kosten von Joins.
- **Sie fragen überwiegend einen einzelnen Blatt-Typ ab und Benchmarks zeigen, dass TPC gewinnt.** TPC hält jeden konkreten Typ in seiner eigenen Tabelle mit allen Spalten inline, was TPH bei Abfragen eines einzelnen Blatt-Typs schlagen kann. Messen Sie, bevor Sie wechseln; TPC bringt eine eigene Schlüsselgenerierung und Fremdschlüssel-Bedingungen mit.

Beachten Sie, dass das Ändern des Typs einer Entität zur Laufzeit (ein `CardPayment` in ein `BankTransferPayment` verwandeln) in keiner Strategie unterstützt wird. Sie löschen und fügen neu ein. Das ist eine Modellierungsrealität, keine TPH-Einschränkung.

Als Faustregel: TPH ist der Standard, weil es der richtige Standard ist. Konfigurieren Sie den Diskriminator so, dass Ihr Schema nicht von Klassennamen abhängt, denken Sie daran, dass Spalten abgeleiteter Typen immer nullbar sind, und greifen Sie nur zu TPT oder TPC, wenn eine konkrete Einschränkung oder ein echter Benchmark es Ihnen sagt. Wenn diese Entscheidung Teil eines größeren Versionssprungs ist, behandelt der [Migrationsleitfaden von EF Core 6 zu EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) die Vererbungs- und Mapping-Änderungen, die typischerweise damit auftauchen.

## Weiterführende Lektüre

- [Wie man in EF Core 11 einen komplexen Typ statt einer Owned-Entität mappt](/de/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) erklärt das Wertobjekt-Mapping, das nun innerhalb von Vererbungshierarchien funktioniert.
- [Wie man JSON-Spalten in EF Core 11 mappt und abfragt](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) behandelt die JSON-Seite komplexer Eigenschaften in einer TPH-Tabelle.
- [Wie man ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge in EF Core 11 verwendet](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) zeigt den Massenschreibweg, den Diskriminator-Prädikate sauber halten.
- [Wie man benannte Query-Filter für Soft Delete und Mandantenfähigkeit in EF Core 11 verwendet](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) kombiniert globale Filter mit einer TPH-Hierarchie.
- [Fix: The entity type requires a primary key to be defined in EF Core 11](/de/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined) ist die Ergänzung, wenn einem Basis- oder abgeleiteten Typ sein Schlüssel fehlt.

## Quellen

- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [What's New in EF Core 11: complex types and JSON on TPT/TPC](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Modeling for performance: inheritance mapping](https://learn.microsoft.com/en-us/ef/core/performance/modeling-for-performance#inheritance-mapping)
- [EF Core shadow properties](https://learn.microsoft.com/en-us/ef/core/modeling/shadow-properties)
- [Complex property stored as JSON marked non-nullable in TPH class hierarchy (efcore#37404)](https://github.com/dotnet/efcore/issues/37404)
