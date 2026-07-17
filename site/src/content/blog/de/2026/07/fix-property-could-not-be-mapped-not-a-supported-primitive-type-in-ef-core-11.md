---
title: "Lösung: \"The property could not be mapped, because it is not a supported primitive type or a valid entity type\" in EF Core 11"
description: "EF Core ist auf eine Eigenschaft gestoßen, die es nicht speichern kann. Mappen Sie sie als Complex Type, konvertieren Sie sie mit HasConversion, geben Sie ihr einen Schlüssel oder ignorieren Sie sie mit [NotMapped]."
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
lang: "de"
translationOf: "2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-17
---

EF Core wirft `The property 'X.Y' could not be mapped, because it is of type 'Z' which is not a supported primitive type or a valid entity type`, wenn Ihr Modell eine Eigenschaft enthält, die EF Core weder in eine Spalte umwandeln noch als Beziehung behandeln kann. Beheben Sie es auf eine von vier Arten, in dieser Reihenfolge: Mappen Sie sie als Complex Type mit `ComplexProperty`, wenn es ein Wertobjekt ist; konvertieren Sie sie mit `HasConversion` (einem Wertkonverter) in einen Skalar, wenn es eine Enum-Liste oder ein eigener Wrapper ist; geben Sie dem Typ einen Schlüssel, damit EF Core ihn als verwandte Entität mappt; oder schließen Sie sie ganz mit `[NotMapped]` / `EntityTypeBuilder.Ignore` aus, wenn sie nie persistiert werden soll. Dies gilt für `Microsoft.EntityFrameworkCore` 11.0 auf .NET 11 mit C# 14, und die Meldung ist seit EF Core 3.0 stabil.

## Die Fehlermeldung im Kontext

Die vollständige Laufzeitausnahme ist eine `InvalidOperationException`, die geworfen wird, während EF Core das Modell aufbaut. Das bedeutet, sie tritt beim ersten Zugriff auf den `DbContext` auf (eine Abfrage, ein `SaveChanges` oder `dotnet ef migrations add`), nicht beim Kompilieren:

```
System.InvalidOperationException: The property 'Customer.Tags' could not be mapped, because it is of type 'HashSet<Tag>' which is not a supported primitive type or a valid entity type. Either explicitly map this property, or ignore it using the '[NotMapped]' attribute or by using 'EntityTypeBuilder.Ignore' in 'OnModelCreating'.
```

Die beiden Bezeichner in der Meldung sind das Einzige, was Sie lesen müssen: die Eigenschaft (`Customer.Tags`) und ihr Typ (`HashSet<Tag>`). EF Core teilt Ihnen mit, dass es Ihre Entität durchlaufen hat, dieses Mitglied gefunden hat und keine Regel zum Speichern hatte. Der letzte Satz listet die Notausgänge auf, aber nicht den richtigen. Deshalb schickt dieser Fehler so viele Leute direkt zu `[NotMapped]`, selbst wenn die Daten gespeichert werden sollten.

## Warum das passiert

EF Core mappt eine Eigenschaft auf genau eine von drei Arten. Ein Skalar wird zu einer Spalte (`int`, `string`, `decimal`, `DateTime`, `Guid`, `bool`, ein `enum` und seit EF Core 8 auch `DateOnly` und `TimeOnly` sowie Primitiv-Sammlungen wie `List<string>`). Ein Typ mit einem erkennbaren Schlüssel wird zu einer verwandten Entität, verbunden über einen Fremdschlüssel. Und ein Wertobjekt ohne Schlüssel wird zu einem Complex Type oder einer Owned Entity, inline in der Tabelle des Besitzers gespeichert.

Dieser Fehler bedeutet, dass die Eigenschaft durch alle drei Raster gefallen ist. Der Typ ist kein Skalar, den EF Core kennt, er hat keinen Schlüssel, den EF Core finden kann (also kann er keine Beziehung sein), und Sie haben EF Core nie gesagt, ihn als Complex Type oder Owned Type zu behandeln. Häufige Auslöser:

- Eine **eigene Klasse oder Struct**, die als Wertobjekt verwendet wird (`Address`, `Money`, `GeoPoint`), die Sie nie konfiguriert haben.
- Eine **Sammlung eines eigenen Typs** (`List<OrderLine>`, `HashSet<Tag>`), deren Elementtyp keinen Schlüssel hat.
- Eine **Enum-Sammlung** (`List<Status>`). Ein einzelnes Enum mappt problemlos, aber vor EF Core 8 tat eine Sammlung davon das nicht, und eine Sammlung eines eigenen Typs tut es ohne Konfiguration weiterhin nicht.
- Ein **Dictionary oder beliebiges Objekt** (`Dictionary<string, string>`, `IDictionary`, `object`, `dynamic`, `JsonElement`), das keine natürliche Spaltendarstellung hat.
- Ein **Typ aus einer anderen Bibliothek** (`NodaTime.Instant`, ein Domänen-Primitiv) ohne eingebautes Provider-Mapping.

Die Lösung ist nie das Raten. Entscheiden Sie, was das Datum *ist*, und wählen Sie dann das passende Mapping.

## Minimale Reproduktion

Das kleinste Programm, das den Fehler reproduziert, verwendet ein Wertobjekt, das harmlos aussieht. `Address` hat kein `Id`, also kann EF Core es nicht zu einer verwandten Entität machen, und es ist kein Skalar, also wirft EF Core:

```csharp
// .NET 11, C# 14, EF Core 11, Microsoft.EntityFrameworkCore.SqlServer 11.0
using Microsoft.EntityFrameworkCore;

using var db = new ShopContext();
await db.Database.EnsureCreatedAsync(); // throws here while building the model

public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}

public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public required Address ShippingAddress { get; set; } // unmapped: not scalar, no key
}

public class ShopContext : DbContext
{
    public DbSet<Customer> Customers => Set<Customer>();

    protected override void OnConfiguring(DbContextOptionsBuilder options) =>
        options.UseSqlServer("Server=.;Database=Shop;Trusted_Connection=True;Encrypt=False");
}
```

EF Core meldet `The property 'Customer.ShippingAddress' could not be mapped, because it is of type 'Address'...`. Die Eigenschaft ist real, der Typ ist real, aber nichts im Modell sagt EF Core, wie `Address` zu Speicher wird.

## Die Lösung im Detail

Arbeiten Sie von oben nach unten. Das erste Mapping, das zu Ihrer Absicht passt, ist das richtige.

### 1. Es ist ein Wertobjekt: mappen Sie es als Complex Type

Wenn die Eigenschaft ein Wertobjekt ist, das in die Zeile des Besitzers gehört (eine Adresse, ein Geldbetrag, eine Koordinate), mappen Sie sie mit `ComplexProperty`. Ein Complex Type hat keine Identität und wird inline gespeichert, was genau das ist, was ein Wertobjekt will:

```csharp
// .NET 11, EF Core 11
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Customer>()
        .ComplexProperty(c => c.ShippingAddress);
}
```

Oder markieren Sie den Typ mit `[ComplexType]`, damit EF Core ihn per Konvention überall dort aufgreift, wo er vorkommt:

```csharp
// .NET 11, C# 14, EF Core 11
[ComplexType]
public class Address
{
    public required string Street { get; set; }
    public required string City { get; set; }
}
```

Dies mappt per Table Splitting: Spalten `ShippingAddress_Street` und `ShippingAddress_City` auf `Customers`, kein Join, kein Fremdschlüssel. Complex Types sind der moderne Ersatz für Owned Entities bei Wertobjekten, und sie bringen Wertsemantik mit, die Owned Entities nie hatten. Die vollständige Geschichte, einschließlich wann sie noch zu kurz greifen, steht in [wie man einen Complex Type statt einer Owned Entity in EF Core 11 mappt](/de/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/). Wenn der Typ ein `record` ist, lesen Sie zuerst [wie man Records mit EF Core 11 korrekt verwendet](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/), denn Record-Gleichheit interagiert mit der Änderungsverfolgung auf eine Weise, die man vor dem Ausliefern verstehen sollte.

### 2. Es ist eigentlich ein Skalar: konvertieren Sie es mit HasConversion

Wenn die Eigenschaft konzeptionell ein einzelner Wert ist, für den EF Core kein eingebautes Mapping hat, wandelt ein Wertkonverter sie auf dem Weg zur Datenbank in einen Skalar um und beim Herausholen wieder zurück. Das deckt `NodaTime`-Typen, Domänen-Primitive oder ein Enum ab, das Sie als seinen Namen als Text speichern wollen:

```csharp
// .NET 11, EF Core 11 - store the enum as its name, not its int
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<string>();
```

Für einen eigenen Wrapper-Typ geben Sie beide Richtungen explizit an:

```csharp
// .NET 11, EF Core 11 - EmailAddress is a struct wrapping a string
modelBuilder.Entity<Customer>()
    .Property(c => c.Email)
    .HasConversion(
        email => email.Value,          // to the database column (nvarchar)
        value => new EmailAddress(value)); // back from the column
```

Ein Wertkonverter ist das richtige Werkzeug, wenn es ein sauberes, verlustfreies Mapping auf eine Spalte gibt. Wenn das Mapping verlustbehaftet ist oder der Typ wirklich zusammengesetzt ist (mehrere Felder), verwenden Sie stattdessen einen Complex Type. Greifen Sie nicht zu einem Konverter, nur um einen ganzen Objektgraphen in eine Zeichenkette zu serialisieren; dieser Weg kommt als Nächstes und hat schärfere Kanten.

### 3. Es ist eine Sammlung oder ein Dictionary: Primitiv-Sammlungen oder eine JSON-Spalte

EF Core 8 hat natives Mapping für **Primitiv-Sammlungen** hinzugefügt, sodass in EF Core 11 eine `List<string>`, `int[]` oder `List<DateOnly>` ohne Konfiguration automatisch auf eine JSON-Spalte gemappt wird. Wenn Sie den Fehler bei einer Primitiv-Sammlung immer noch sehen, sind Sie auf EF Core 7 oder älter; ein Upgrade behebt ihn direkt.

Für eine Sammlung eines **eigenen Typs** oder ein **Dictionary** kann EF Core die Form nicht ableiten, also serialisieren Sie die gesamte Eigenschaft in eine JSON-Spalte. In EF Core 11 ist der sauberste Weg für eine Sammlung von Wertobjekten ein auf JSON gemappter Complex Type:

```csharp
// .NET 11, EF Core 11 - store the whole collection as one json document
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Tags, b => b.ToJson());
```

Für ein `Dictionary<string, string>` oder einen anderen freiformigen Beutel gibt Ihnen ein Wertkonverter, der `System.Text.Json` ausführt, denselben Speicher in einer Spalte:

```csharp
// .NET 11, EF Core 11 - dictionary stored as a json string
modelBuilder.Entity<Customer>()
    .Property(c => c.Metadata)
    .HasConversion(
        dict => JsonSerializer.Serialize(dict, (JsonSerializerOptions?)null),
        json => JsonSerializer.Deserialize<Dictionary<string, string>>(json, (JsonSerializerOptions?)null)
                ?? new());
```

Eine JSON-Spalte ist bei modernen Providern abfragbar, sodass Sie nicht auf Filterung verzichten, um Speicher in einer Spalte zu erhalten. Die Abfrageseite, einschließlich der SQL-Funktionen, die in ein JSON-Dokument hineinreichen, wird in [wie man JSON-Spalten in EF Core 11 mappt und abfragt](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) behandelt. Wenn Sie eine eigene Serialisierungsform statt der Standardform benötigen, zeigt [wie man einen eigenen JsonConverter in System.Text.Json schreibt](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/), wie man genau steuert, was in der Spalte landet.

### 4. Es ist tatsächlich eine verwandte Entität: geben Sie ihr einen Schlüssel

Wenn die Eigenschaft ihre eigene Tabelle mit eigenen Zeilen sein sollte (ein `Order`, der echte `OrderLine`-Datensätze referenziert, kein Inline-Wertobjekt), dann ist sie eine Entität, und der Fehler bedeutet, dass EF Core keinen Schlüssel finden konnte, um die Beziehung herzustellen. Fügen Sie einen Schlüssel hinzu, und EF Core verdrahtet den Fremdschlüssel automatisch:

```csharp
// .NET 11, C# 14, EF Core 11
public class OrderLine
{
    public int Id { get; set; }     // now discoverable as a key
    public string Sku { get; set; } = "";
    public int Quantity { get; set; }
}

public class Order
{
    public int Id { get; set; }
    public List<OrderLine> Lines { get; set; } = []; // maps as a one-to-many
}
```

Wenn der Typ einen Bezeichner hat, der nicht `Id` oder `OrderLineId` heißt, teilen Sie es EF Core mit `HasKey` in `OnModelCreating` mit. Ein schlüsselloser Typ, der keinen natürlichen Schlüssel hat, aber dennoch eigene Zeilen braucht, sollte als Owned Collection mit `OwnsMany` gemappt werden. Und wenn der Fehler, den Sie tatsächlich vor sich haben, [der Entitätstyp 'X' erfordert die Definition eines Primärschlüssels](/de/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) ist, dann ist das der nahe Verwandte: EF Core kam weit genug, um den Typ als Entität zu behandeln, fand dann aber keinen Schlüssel.

### 5. Sie soll nie persistiert werden: ignorieren Sie sie

Wenn die Eigenschaft eine berechnete Bequemlichkeit, ein Cache oder eine Service-Referenz ist, die nichts in der Datenbank zu suchen hat, schließen Sie sie aus. Das Attribut ist am schnellsten:

```csharp
// .NET 11, C# 14, EF Core 11
public class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    [NotMapped]
    public string DisplayName => $"{Name} (#{Id})";
}
```

Oder tun Sie es in der Modellkonfiguration, was persistenz-ignorante POCOs frei von EF-Core-Attributen hält:

```csharp
// .NET 11, EF Core 11
modelBuilder.Entity<Customer>()
    .Ignore(c => c.DisplayName);
```

`Ignore` ist nur dann die richtige Lösung, wenn die Antwort auf "sollte diese Spalte existieren?" wirklich nein lautet. Danach zu greifen, um den Fehler bei Daten zu unterdrücken, die Sie speichern wollten, ist die häufigste Art, wie dieser Fehler zu einem stillen Datenverlust-Bug wird.

## Feinheiten und Varianten

**Eine nur lesbare berechnete Eigenschaft hat es ausgelöst.** EF Core versucht, jede lesbare Eigenschaft zu mappen, einschließlich ausdrucksbasierter. Wenn `DisplayName => ...` aus anderen Spalten abgeleitet wird, braucht sie keinen Speicher; ignorieren Sie sie. Wenn sie teuer ist und Sie sie in der Datenbank haben wollen, mappen Sie stattdessen eine berechnete Spalte mit `HasComputedColumnSql`.

**Es ist kaputtgegangen, nachdem Sie `required` hinzugefügt oder einen Typ geändert haben.** Das Hinzufügen einer Eigenschaft eines nicht gemappten Typs oder das Tauschen eines `string` gegen eine eigene Struct führt das nicht gemappte Mitglied ein. Der Fehler nennt die genaue Eigenschaft; prüfen Sie, was sich an diesem Typ geändert hat.

**Eine Sammlung von Enums.** `List<Status>` wirft in EF Core 7 und älter, weil Enum-Sammlungen noch keine Primitiv-Sammlungen waren. Ab EF Core 8 wird sie automatisch auf eine JSON-Spalte gemappt. Wenn Sie mitten in einem Upgrade sind, ist das Verhalten von Enum-Sammlungen eine von mehreren Mapping-Änderungen im [Migrationsleitfaden von EF Core 6 zu EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**Der Typ lebt in einer anderen Assembly und Sie können ihn nicht annotieren.** Sie können `[ComplexType]` oder `[NotMapped]` nicht auf einen Typ setzen, der Ihnen nicht gehört, aber jedes Attribut hat ein Fluent-Äquivalent in `OnModelCreating` (`ComplexProperty`, `Property(...).HasConversion(...)`, `Ignore`). Konfigurieren Sie es aus Ihrem `DbContext`, und Sie berühren den fremden Typ nie.

**Eine Navigation zu einem abstrakten oder Interface-Typ.** EF Core kann eine Eigenschaft, die als Interface (`IAddress`) oder als nicht gemappte Basis ohne Diskriminator typisiert ist, nicht mappen. Mappen Sie den konkreten Typ, oder konfigurieren Sie die Vererbung explizit.

**Es ist ein `DbSet`-Filter, keine persistierte Eigenschaft.** Wenn die "Eigenschaft" in Wirklichkeit ein Helfer ist, der andere Daten abfragt, gehört sie überhaupt nicht auf die Entität. Verschieben Sie sie in ein Repository oder einen Service, damit EF Core sie beim Modellaufbau nie sieht.

Die Entscheidung, die Sie für immer aus diesem Fehler heraushält, ist eine einzige Frage, die vor dem Hinzufügen der Eigenschaft gestellt wird: Was ist das, in Speicherbegriffen? Ein Wertobjekt geht inline als Complex Type. Ein einzelner konvertierbarer Wert bekommt ein `HasConversion`. Ein Beutel voller Daten wird zur JSON-Spalte. Etwas mit Identität wird zur verwandten Entität mit einem Schlüssel. Und ein reiner In-Memory-Helfer wird ignoriert. EF Core wirft den Fehler genau deshalb, weil es sich weigert zu raten, welches davon Sie gemeint haben.

## Verwandte Artikel

- [Wie man einen Complex Type statt einer Owned Entity in EF Core 11 mappt](/de/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/) ist der Tiefgang zum Wertobjekt-Mapping, auf das dieser Fehler am häufigsten zeigt.
- [Wie man JSON-Spalten in EF Core 11 mappt und abfragt](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) behandelt das Speichern und Filtern einer serialisierten Sammlung oder eines Dokuments.
- [Lösung: Der Entitätstyp 'X' erfordert die Definition eines Primärschlüssels](/de/2026/06/fix-the-entity-type-requires-a-primary-key-to-be-defined/) ist der Geschwisterfehler, wenn EF Core den Typ als Entität behandelt, aber keinen Schlüssel findet.
- [Wie man Records mit EF Core 11 korrekt verwendet](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/) ist wichtig, wenn Ihr Wertobjekt ein Record ist und die Änderungsverfolgung im Spiel ist.
- [Wie man einen eigenen JsonConverter in System.Text.Json schreibt](/de/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) formt genau, was eine Konverter-zu-JSON-Eigenschaft speichert.

## Quellen

- [Wertkonvertierungen, EF-Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions)
- [Complex Types, Neuerungen in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [Primitiv-Sammlungen, Neuerungen in EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#primitive-collections)
- [Typen oder Eigenschaften vom Modell ausschließen, EF-Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/#excluding-types-from-the-model)
- [dotnet/efcore issue #15987: property could not be mapped, not a supported primitive type](https://github.com/dotnet/efcore/issues/15987)
