---
title: "Wie man in EF Core 11 einen komplexen Typ statt einer Owned Entity abbildet"
description: "Owned Entities tragen einen versteckten Schlüssel und eine Referenzidentität, die mit Value Objects im Konflikt steht. So bilden Sie ein Value Object in EF Core 11 als komplexen Typ ab, wann Sie wechseln sollten und welche Fallstricke es gibt."
pubDate: 2026-07-12
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "complex-types"
  - "owned-entities"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-12
---

Kurze Antwort: Bilden Sie in EF Core 11 (mit .NET 11 und C# 14) ein Value Object wie `Address` oder `Money` mit `ComplexProperty` statt mit `OwnsOne` ab. Ein komplexer Typ hat keinen Schlüssel und keine Identität, deshalb behandelt EF Core ihn mit Wertsemantik: Zuweisen kopiert Felder, Vergleichen vergleicht Inhalte, und `ExecuteUpdate` kann seine Eigenschaften anfassen. Eine Owned Entity ist im Hintergrund weiterhin ein Entitätstyp, mit einem Schattenschlüssel und Referenzidentität, und genau das ist die Quelle der Überraschungen, auf die Leute stoßen (Sie können keine gemeinsame Referenz zuweisen, LINQ-Gleichheit funktioniert nicht, Bulk-Update ist blockiert). Komplexe Typen wurden in EF Core 8 eingeführt, erhielten in EF Core 10 optionale (nullbare) Abbildung und JSON-Spalten und wurden in EF Core 11 auf TPT/TPC-Vererbungshierarchien nutzbar, mit einer saubereren Konfigurations-API. Der Wechsel ist eine Änderung der Modellkonfiguration plus eine Migration.

Dieser Beitrag behandelt, was sich tatsächlich zwischen den beiden Abbildungen unterscheidet, die genaue `ComplexProperty`-Konfiguration für Table Splitting und JSON, wie Sie eine bestehende `OwnsOne`-Abbildung ohne Datenverlust migrieren und die Fälle, in denen Sie weiterhin zu Owned Entities greifen müssen.

## Warum Owned Entities nie die richtige Form für ein Value Object waren

Als EF Core Owned Entity Types hinzufügte, wurden sie als der Weg beworben, um Value Objects zu modellieren: eine `Address`, die innerhalb eines `Customer` lebt und auf dieselbe Tabelle abgebildet wird. Das funktioniert, aber es war immer ein Kompromiss. Eine Owned Entity **ist ein Entitätstyp**. EF Core gibt ihr einen Primärschlüssel (normalerweise einen Schattenschlüssel, den es für Sie verwaltet), verfolgt sie im Change Tracker als eigenen Knoten und behandelt sie mit Referenzidentität. Die [Dokumentation zu Owned Entities](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities) warnt seit Jahren vor den scharfen Kanten, die daraus folgen.

Drei dieser Kanten stören ständig.

Erstens können Sie keine Instanz teilen. Das sieht aus, als sollte es funktionieren, tut es aber nicht:

```csharp
// .NET 11, EF Core 11 - owned entity mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress;
await context.SaveChangesAsync(); // throws with owned entities
```

Weil beide Eigenschaften derselbe Entitätstyp sind, sieht EF Core eine Entität, die zweimal referenziert wird, und lehnt sie ab. Zweitens vergleicht LINQ-Gleichheit nach Identität, nicht nach Inhalt, deshalb bedeutet `context.Customers.Where(c => c.BillingAddress == c.ShippingAddress)` nicht das, was Sie denken. Drittens unterstützt `ExecuteUpdate` Eigenschaften von Owned Entities überhaupt nicht.

Ein komplexer Typ ist die Abbildung, die tatsächlich dafür gedacht war. Er hat keine eigene Identität. Er ist vollständig durch seine Daten definiert, was der Definition eines Value Objects entspricht. Zuweisen kopiert die Felder. Vergleichen vergleicht die Felder. Und EF Core 11 unterstützt ihn in `ExecuteUpdate`. Die eigene Empfehlung des EF-Teams in den [Release Notes zu EF Core 10](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types) ist unmissverständlich: "users already using owned entity types for these are advised to switch to complex types."

## Die minimale Abbildung eines komplexen Typs

Beginnen Sie mit dem Value Object und der Entität, die es enthält. Das Value Object braucht keinen Schlüssel, keine `Id`, nichts, das nach Identität riecht:

```csharp
// .NET 11, C# 14, EF Core 11
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; }
    public Address? BillingAddress { get; set; }
}
```

Es gibt zwei Wege, EF Core mitzuteilen, dass dies ein komplexer Typ ist. Die Fluent-API in `OnModelCreating`:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>(b =>
    {
        b.ComplexProperty(c => c.ShippingAddress);
        b.ComplexProperty(c => c.BillingAddress);
    });
}
```

Oder das `[ComplexType]`-Attribut auf dem Value Object, mit dem EF Core es per Konvention überall dort erkennt, wo es verwendet wird:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
    public required string PostalCode { get; set; }
}
```

Standardmäßig wird dies auf **Table Splitting** abgebildet: Die Adressspalten liegen direkt in der `Customers`-Tabelle mit einem Präfix.

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress_Street] nvarchar(max) NOT NULL,
    [ShippingAddress_City] nvarchar(max) NOT NULL,
    [ShippingAddress_PostalCode] nvarchar(max) NOT NULL,
    [BillingAddress_Street] nvarchar(max) NULL,
    [BillingAddress_City] nvarchar(max) NULL,
    [BillingAddress_PostalCode] nvarchar(max) NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

Beachten Sie, dass es keine separate `Addresses`-Tabelle und keinen Fremdschlüssel gibt. Das ist der Punkt: Das Value Object ist Teil der Zeile seines Besitzers, ohne Join und ohne zu verwaltende Identität.

## Optionale (nullbare) komplexe Typen brauchen mindestens eine erforderliche Eigenschaft

Das obige `BillingAddress? BillingAddress` funktioniert, weil EF Core 10 Unterstützung für **optionale** komplexe Typen hinzugefügt hat. Das gesamte Objekt kann null sein, und EF Core entscheidet über die Präsenz anhand der Spaltenwerte. Es gibt eine Regel, über die Leute stolpern: Ein optionaler komplexer Typ muss mindestens eine erforderliche (nicht-nullbare) Eigenschaft haben. EF Core verwendet diese Spalte, um "die gesamte Adresse ist null" von "die Adresse ist vorhanden, aber ihre optionalen Felder sind null" zu unterscheiden. Wenn jede Eigenschaft von `Address` nullbar wäre, hätte EF Core kein Signal, um diese beiden Zustände auseinanderzuhalten, und der Modellaufbau schlägt fehl.

In der Praxis ist das fast nie eine Einschränkung, weil eine echte Adresse mindestens ein Feld hat, das vorhanden sein muss. Wenn Sie tatsächlich ein Value Object haben, bei dem jedes Feld optional ist, fügen Sie einen Diskriminator hinzu oder überdenken Sie, ob es überhaupt nullbar sein sollte.

## Einen komplexen Typ auf eine einzelne JSON-Spalte abbilden

Table Splitting verteilt die Felder über Spalten. Wenn Sie das Value Object lieber als ein undurchsichtiges JSON-Dokument behalten möchten, hat EF Core 10 `ToJson()` auf komplexen Eigenschaften hinzugefügt, und EF Core 11 hält es stabil:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>(b =>
{
    b.ComplexProperty(c => c.ShippingAddress, c => c.ToJson());
    b.ComplexProperty(c => c.BillingAddress, c => c.ToJson());
});
```

Auf SQL Server 2025 (oder Azure SQL) verwendet dies den nativen `json`-Spaltentyp:

```sql
CREATE TABLE [Customers] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [ShippingAddress] json NOT NULL,
    [BillingAddress] json NULL,
    CONSTRAINT [PK_Customers] PRIMARY KEY ([Id])
);
```

Die JSON-Abbildung bringt Ihnen eine Sache, die Table Splitting nicht kann: **Collections innerhalb des abgebildeten Typs**. Ein mit Table Splitting abgebildeter komplexer Typ muss ein einzelner Wert sein, aber ein auf JSON abgebildeter komplexer Typ kann eine `List<string>` oder eine verschachtelte Liste von Value Objects enthalten. Sie können weiterhin in das Dokument hinein abfragen. Auf SQL Server 2025 wird `context.Customers.Where(c => c.ShippingAddress.City == "Cluj")` in eine `JSON_VALUE`-Suche übersetzt, und EF Core 11 fügt `EF.Functions.JsonPathExists` und `EF.Functions.JsonContains` hinzu, die beide gegen auf JSON abgebildete komplexe Typen funktionieren. Für das größere Bild zur Abfrage von JSON-abgebildeten Daten siehe [wie man JSON-Spalten in EF Core 11 abbildet und abfragt](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) und die [JSON_CONTAINS-Übersetzung, die auf SQL Server 2025 hinzugefügt wurde](/2026/04/efcore-11-json-contains-sql-server-2025/).

## Was Wertsemantik Ihnen tatsächlich bringt

Sobald die Abbildung ein komplexer Typ ist, verschwinden die drei Kanten der Owned Entities.

Das Teilen einer Instanz funktioniert nun, weil die Zuweisung Felder kopiert, statt eine verfolgte Referenz zu aliasieren:

```csharp
// .NET 11, EF Core 11 - complex type mapping
var customer = await context.Customers.SingleAsync(c => c.Id == id);
customer.BillingAddress = customer.ShippingAddress; // copies the values
await context.SaveChangesAsync(); // succeeds
```

LINQ-Gleichheit vergleicht Inhalte, deshalb liefert dies die Kunden zurück, deren zwei Adressen wirklich gleich sind:

```csharp
// .NET 11, EF Core 11
var sameAddress = await context.Customers
    .Where(c => c.BillingAddress == c.ShippingAddress)
    .ToListAsync();
```

Und Bulk-Update reicht in den komplexen Typ hinein, was Owned Entities nie erlaubten:

```csharp
// .NET 11, EF Core 11
await context.Customers
    .Where(c => c.ShippingAddress.City == "Bucuresti")
    .ExecuteUpdateAsync(s =>
        s.SetProperty(c => c.ShippingAddress.PostalCode, "010001"));
```

Wenn Sie die Schreibpfade gegen das Laden und Mutieren von Entitäten abwägen, sind die Kompromisse dieselben, die in [ExecuteUpdate vs. Laden von Entitäten und SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) behandelt werden; komplexe Typen machen den Value-Object-Fall einfach für den schnellen Pfad geeignet.

Structs funktionieren ebenfalls, was gut zur Idee der "keinen Identität" passt:

```csharp
// .NET 11, C# 14, EF Core 11
public struct Money
{
    public required decimal Amount { get; set; }
    public required string Currency { get; set; }
}
```

Records passen auch gut, und das Zusammenspiel zwischen Records, komplexen Typen und Change Tracking ist es wert, vollständig in [wie man Records mit EF Core 11 korrekt verwendet](/2026/04/how-to-use-records-with-ef-core-11-correctly/) nachzulesen.

## Eine bestehende OwnsOne-Abbildung zu einem komplexen Typ migrieren

Wenn Sie bereits `OwnsOne` ausliefern, ist der Wechsel mechanisch, und mit Table Splitting ist er in der Regel schemaneutral, weil die Spalten auf dieselbe Weise benannt und typisiert sind. Hier ist die Vorgehensweise.

1. **Bestätigen Sie die aktuelle Speicherform.** Wenn Ihr `OwnsOne` auf die Tabelle des Besitzers abbildet (der Standard), sind die Spalten bereits `Owner_Property`. Wenn es `OwnsOne(...).ToTable("Addresses")` (eine separate Tabelle) oder `OwnsOne(...).ToJson()` verwendet, notieren Sie das, weil die Zielspeicherung dafür entscheidend ist, ob die Migration Daten bewegt.
2. **Entfernen Sie Identitätslecks aus dem Value Object.** Löschen Sie jede `Id`-Eigenschaft, jede explizite Schlüsselkonfiguration und jede Navigation zurück zum Besitzer. Ein komplexer Typ kann keinen Schlüssel und keine Rückreferenz haben.
3. **Ersetzen Sie `OwnsOne` durch `ComplexProperty`.** Ändern Sie `b.OwnsOne(c => c.ShippingAddress)` zu `b.ComplexProperty(c => c.ShippingAddress)` und `b.OwnsOne(c => c.ShippingAddress, a => a.ToJson())` zu `b.ComplexProperty(c => c.ShippingAddress, a => a.ToJson())`. Übernehmen Sie die eigenschaftsbezogene Konfiguration wie `HasMaxLength` und `HasColumnName`.
4. **Machen Sie optionale Value Objects im CLR-Typ nullbar.** Wenn die Owned-Referenz fehlen könnte, deklarieren Sie die Eigenschaft als `Address?` und bestätigen Sie, dass der Typ mindestens eine erforderliche Eigenschaft hat, damit EF Core null erkennen kann.
5. **Fügen Sie die Migration hinzu und prüfen Sie sie.** Führen Sie `dotnet ef migrations add SwitchAddressToComplexType` aus. Bei einem tabellengesplitteten `OwnsOne` auf derselben Tabelle sollte die Migration leer oder nahezu leer sein, weil sich die Spalten nicht bewegen. Wenn sie Spalten löschen und neu erstellen will, sind Ihre Spaltennamen abgewichen; fixieren Sie sie mit `HasColumnName`, bis der Diff sauber ist, damit Sie keine Daten verlieren.
6. **Überprüfen Sie das datenerhaltende Verhalten zuerst an einer Kopie.** Wenden Sie die Migration auf eine Wegwerf-Datenbank an, die aus der Produktion wiederhergestellt wurde, bevor Sie sie echt ausführen, besonders wenn Sie von einer separaten Tabelle oder von `nvarchar`-JSON zum nativen `json`-Typ wechseln.

Die eine Migration, die tatsächlich Daten bewegt, ist der Wechsel von `OwnsOne(...).ToTable("Addresses")` (eine separate Tabelle) zu einem tabellengesplitteten komplexen Typ. Dafür gibt es keinen sauberen automatisch generierten Pfad, weil die Zeilen aus der Kindtabelle in die Elterntabelle wandern müssen. Schreiben Sie diese Migration von Hand: Fügen Sie die neuen Spalten hinzu, nutzen Sie `UPDATE ... FROM`, um die Werte hinüberzukopieren, und löschen Sie dann die alte Tabelle. Wenn Sie bereits tief in einem EF-Core-Upgrade stecken, gilt dieselbe Sorgfalt für den Rest Ihres Modells; der [Migrationsleitfaden von EF Core 6 auf EF Core 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) behandelt die Breaking Changes, die tendenziell zusammen mit diesem auftauchen.

## EF Core 11 beseitigt die Reibung bei Vererbung und Konfiguration

Zwei Dinge, die sich in EF Core 11 gezielt verbessert haben, machen den Wechsel einfacher.

Komplexe Typen (und JSON-Spalten) funktionieren nun auf Entitäten, die **TPT (table-per-type) und TPC (table-per-concrete-type) Vererbung** verwenden. Vor EF Core 11 wurde eine komplexe Eigenschaft auf einem Basistyp in einer TPT/TPC-Hierarchie nicht unterstützt, was Sie für jedes vererbte Value Object zurück zu Owned Entities zwang. Nun wird dies korrekt abgebildet:

```csharp
// .NET 11, C# 14, EF Core 11
public abstract class Animal
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required AnimalDetails Details { get; set; }
}

public class Dog : Animal { public string Breed { get; set; } = ""; }
public class Cat : Animal { public bool IsIndoor { get; set; } }

[ComplexType]
public class AnimalDetails
{
    public DateTime BirthDate { get; set; }
    public string? Veterinarian { get; set; }
}

// OnModelCreating
modelBuilder.Entity<Animal>().UseTptMappingStrategy();
```

EF Core 11 erstellt die Spalten `Details_BirthDate` und `Details_Veterinarian` auf der `Animal`-Tabelle wie erwartet.

Die Konfiguration wurde ebenfalls kürzer. Zuvor bedeutete das Hineinbohren in die Eigenschaft eines komplexen Typs, zuerst den Complex Builder zu greifen:

```csharp
// Pre-EF Core 11
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.ShippingAddress)
    .Property(a => a.Street)
    .HasMaxLength(200);
```

EF Core 11 lässt Sie den Zugriff auf Member direkt in `Property` durchreichen:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Property(c => c.ShippingAddress.Street)
    .HasMaxLength(200);
```

EF Core 11 lieferte außerdem eine Reihe von Stabilisierungskorrekturen für komplexe Typen, darunter den korrekten Vergleich verschachtelter komplexer Typen, die korrekte `ExecuteUpdate`-Zuweisung in verschachtelte Eigenschaften und eine Korrektur für eine `NullReferenceException`, wenn zwei Typen eine nullbare komplexe Eigenschaft teilten, die auf dieselbe Spalte abgebildet war. Wenn Sie komplexe Typen in EF Core 9 ausprobiert haben und auf raue Kanten gestoßen sind, ist EF Core 11 das Release, in dem sie als vollständiger Ersatz für Owned Entities gedacht sind.

## Wann Sie weiterhin eine Owned Entity verwenden müssen

Komplexe Typen decken nicht jeden Fall ab. Greifen Sie zu `OwnsOne` oder `OwnsMany`, wenn:

- **Sie das Value Object in einer separaten Tabelle brauchen.** Komplexe Typen sind immer inline, entweder als aufgeteilte Spalten oder als einzelne JSON-Spalte. Es gibt kein `ComplexProperty(...).ToTable("Addresses")`. Wenn Ihr Schema die Daten in einer eigenen Tabelle mit einem Fremdschlüssel erfordert, ist das eine Owned Entity (oder eine vollständige Entität).
- **Sie eine Collection brauchen, die auf separate Zeilen abgebildet wird.** Ein tabellengesplitteter komplexer Typ muss ein einzelner Wert sein; Collections von Structs werden überhaupt nicht unterstützt. Ein auf JSON abgebildeter komplexer Typ kann eine Collection innerhalb des Dokuments halten, aber wenn Sie jedes Element als eigene Zeile in einer Kindtabelle möchten, bleibt `OwnsMany` das Werkzeug.
- **Etwas wirklich Identität braucht.** Wenn zwei "Value Objects" mit demselben Inhalt unterscheidbar sein müssen oder Sie sie unabhängig verfolgen und aktualisieren müssen, sind es keine Value Objects. Modellieren Sie sie als echte verwandte Entität.

Die Faustregel ist dieselbe, die eine `class` von einem `record` trennt: Wenn das Ding durch seine Daten definiert ist, bilden Sie es als komplexen Typ ab; wenn es eine Identität hat, die seine Daten überdauert, ist es eine Entität. Für die meisten `Address`-, `Money`-, `GeoPoint`- und `DateRange`-Typen in einer .NET-11-Codebasis sind komplexe Typen nun der korrekte Standard, und Owned Entities sind die Ausnahme, zu der Sie nur dann herabsteigen, wenn die Speicherform Sie dazu zwingt.

## Weiterführende Lektüre

- [Wie man Records mit EF Core 11 korrekt verwendet](/2026/04/how-to-use-records-with-ef-core-11-correctly/) geht tiefer auf Records als komplexe Typen versus Entitäten ein und die Change-Tracking-Regeln hinter der Trennung.
- [Wie man JSON-Spalten in EF Core 11 abbildet und abfragt](/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) behandelt die Abfrageseite von JSON-abgebildeten komplexen Typen.
- [EF Core 11 übersetzt Contains zu JSON_CONTAINS auf SQL Server 2025](/2026/04/efcore-11-json-contains-sql-server-2025/) erklärt die JSON-Funktionen, die nun gegen komplexe Typen funktionieren.
- [ExecuteUpdate vs. Laden von Entitäten und SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) rahmt den Bulk-Update-Pfad ein, den komplexe Typen für Value Objects freischalten.
- [Migration von EF Core 6 auf EF Core 11: Breaking Changes, die tatsächlich wehtun](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) ist der Begleiter, falls dieser Wechsel Teil eines größeren Upgrades ist.

## Quellen

- [What's New in EF Core 10: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew#complex-types)
- [What's New in EF Core 11: Complex types](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [EF Core owned entity types](https://learn.microsoft.com/en-us/ef/core/modeling/owned-entities)
- [EF Core inheritance mapping](https://learn.microsoft.com/en-us/ef/core/modeling/inheritance)
- [Allow mapping optional complex properties (efcore#31376)](https://github.com/dotnet/efcore/issues/31376)
