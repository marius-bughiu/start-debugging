---
title: "Wie man ein Enum in EF Core 11 mit einem Value Converter als String speichert"
description: "C#-Enums in EF Core 11 als lesbare Strings statt als Ints speichern: HasConversion, Massenkonfiguration für alle Enums, die nvarchar(max)-Falle, das Sortierproblem und die Migration einer bestehenden int-Spalte."
pubDate: 2026-08-03
updatedDate: 2026-11-02
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "value-converters"
  - "enums"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/08/how-to-store-an-enum-as-a-string-in-ef-core-11-with-a-value-converter"
translatedBy: "claude"
translationDate: 2026-08-03
---

Mit `.HasConversion<string>()` speichert EF Core Enum-Namen. Wählen Sie eine Länge für alle zulässigen Namen und prüfen Sie die erzeugte DDL. Gleichheitsfilter verwenden konvertierte Werte. Zeichenfolgenvergleich und Sortierung folgen der Datenbank-Collation, die von der numerischen Workflow-Reihenfolge abweichen kann.

**Korrektur, 2. November 2026.** Die frühere Fassung erklärte numerische Zeichenfolgen für grundsätzlich unlesbar und 900 Byte zur allgemeinen SQL-Server-Grenze für Indexschlüssel. Beides war falsch. Der Migrationsabschnitt unterscheidet nun Materialisierung und Treffer eines Abfragefilters.

Die Prüfung verwendete SDK 10.0.302 und EF Core 10.0.10. Getestet wurden SQLite-Lesevorgänge und Prädikate sowie die Erzeugung von DDL und Abfrage-SQL für SQL Server ohne Serververbindung. EF-Core-11-Optimierungen stehen in den [Release Notes](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew). Für [Konvertierung von Datenbank-NULL](/de/2026/09/how-to-write-an-ef-core-11-value-converter-that-maps-null-to-a-non-null-value/) gelten eigene Regeln.

## Warum das int-Standardmapping eine Belastung ist

EF Core verwendet standardmäßig den zugrunde liegenden numerischen Enum-Typ. Bei impliziten Werten kann Einfügen oder Umordnen späteren Elementen andere Zahlen zuweisen. Sind Zahlen Teil des gespeicherten Vertrags, vergeben Sie explizite stabile Werte.

```csharp
// Implicit numeric values follow declaration order.
public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled }
```

Sechs Monate später fügt jemand `Refunded` zwischen `Paid` und `Shipped` ein, weil es sich besser liest. Das Enum kompiliert weiterhin, alle Tests laufen weiterhin durch, und jede Zeile in der Datenbank, die `Shipped` sagte, bedeutet jetzt `Refunded`. Es gibt keinen Compilerfehler und keinen Laufzeitfehler. Das ist eine stille Datenkorruption, die erst auffällt, wenn ein Mensch einen Report liest.

Namen vermeiden die Abhängigkeit von der Deklarationsreihenfolge. Umbenennen ändert dennoch den gespeicherten Vertrag und erfordert Migration oder explizite Zuordnung. Berücksichtigen Sie Lesbarkeit, Speicher, Indizes und Sortierung.

## Die drei Wege, die Konvertierung zu konfigurieren

Die kürzeste Form nutzt die generische Überladung von `HasConversion`. EF Core betrachtet den Modelltyp (ein Enum) und den gewünschten Provider-Typ (`string`) und wählt den eingebauten Converter automatisch:

```csharp
// EF Core 11, OnModelCreating
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Order>()
        .Property(o => o.Status)
        .HasConversion<string>()
        .HasMaxLength(20);
}
```

Die zweite Form schreibt beide Lambdas aus. Für ein einfaches Enum brauchen Sie das fast nie, aber die [Dokumentation zu Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) zeigt es zuerst, deshalb lohnt es sich, die Form zu erkennen:

```csharp
// Explicit converter: Enum.Parse here is case-sensitive.
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion(
        v => v.ToString(),
        v => (OrderStatus)Enum.Parse(typeof(OrderStatus), v));
```

Die beiden sind *nicht* identisch, und der Unterschied ist relevant. Der eingebaute `EnumToStringConverter<TEnum>` parst ohne Beachtung der Groß- und Kleinschreibung; das handgeschriebene `Enum.Parse` oben beachtet sie und wirft bei einer Zeile, die `"pending"` statt `"Pending"` speichert. Bevorzugen Sie die generische Überladung.

Die dritte Form überspringt die Fluent API vollständig und deklariert nur den Spaltentyp. EF Core sieht eine String-Spalte unter einer Enum-Eigenschaft und leitet die Konvertierung ab:

```csharp
// EF Core 11 - conversion inferred from the store type
public class Order
{
    public int Id { get; set; }

    [Column(TypeName = "varchar(20)")]
    public OrderStatus Status { get; set; }
}
```

### Alle Enums im Modell auf einmal konfigurieren

`HasConversion<string>()` für vierzig Eigenschaften zu wiederholen ist der Weg, am Ende eine zu vergessen. Die Modellkonfiguration vor den Konventionen matcht auf den CLR-Typ, und die Dokumentation hält fest, dass der Typ "ein Basistyp sein kann". Damit matcht `System.Enum` jedes Enum im Modell:

```csharp
// EF Core 11 - applies to every enum property in the model
protected override void ConfigureConventions(ModelConfigurationBuilder configurationBuilder)
{
    configurationBuilder
        .Properties<Enum>()
        .HaveConversion<string>()
        .HaveMaxLength(32);
}
```

Ich habe das auf EF Core 10.0.10 verifiziert. Ein Dump des Modells zeigt die Konvertierung anschließend sowohl auf einer nicht nullbaren als auch auf einer nullbaren Enum-Eigenschaft, samt Maximallänge:

```text
Id:         clr=Int32       provider=(none)  maxlen=
Perms:      clr=Perms       provider=String  maxlen=32
PrevStatus: clr=Nullable`1  provider=String  maxlen=32
Status:     clr=OrderStatus provider=String  maxlen=32
```

Beachten Sie, dass `IProperty.GetValueConverter()` hier `null` zurückgibt, obwohl die Konvertierung aktiv ist. Kommt die Konvertierung vom Provider-Typ statt von einer expliziten Converter-Instanz, lebt sie am Type Mapping. Wer ein Modell im Debugger inspiziert, sieht unter `property.GetTypeMapping().Converter` eine Instanz von `EnumToStringConverter<TEnum>`.

Die Konfiguration vor den Konventionen überschreibt Konventionen *und* Data Annotations. Wenn Sie also ein Enum als int speichern müssen, konfigurieren Sie dieses eine danach explizit in `OnModelCreating`.

## Die nvarchar(max)-Falle

Wählen Sie eine passende Länge und prüfen Sie die Migration. SQL Server unterscheidet gewöhnliche Zeichenfolgenspalten, Indexschlüssel und eingeschlossene Nicht-Schlüsselspalten.

Konfigurieren Sie die Konvertierung ohne Länge, hat der SQL-Server-Provider keine Ahnung, wie lang die Strings sind, und wählt das Breiteste, was er hat. Hier das DDL, das EF Core für ein Modell mit drei konvertierten Enum-Eigenschaften erzeugte, von denen nur zwei eine Länge setzen:

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(max) NOT NULL,
    [PrevStatus] varchar(20) NULL,
    [Perms] nvarchar(64) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

Im Beispiel wird `Status` ohne Facetten zu `nvarchar(max)`. Die Spalte kann kein gewöhnlicher Indexschlüssel sein, aber als Nicht-Schlüsselspalte in einem nicht gruppierten Index enthalten sein. `PrevStatus` mit `.HasMaxLength(20).IsUnicode(false)` wird `varchar(20)`.

Eine Rettung gibt es: Deklarieren Sie einen Index auf der Eigenschaft, fällt der SQL-Server-Provider von EF Core auf seinen Standard für Schlüsselspalten zurück statt auf `max`:

```csharp
// EF Core 11
modelBuilder.Entity<Order>().Property(o => o.Status).HasConversion<string>();
modelBuilder.Entity<Order>().HasIndex(o => o.Status);
```

```sql
CREATE TABLE [Orders] (
    [Id] int NOT NULL IDENTITY,
    [Status] nvarchar(450) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
GO

CREATE INDEX [IX_Orders_Status] ON [Orders] ([Status]);
```

Der SQL-Server-Provider erzeugte für die indizierte Eigenschaft im EF-Core-10.0.10-Beispiel `nvarchar(450)`, also bis zu 900 Byte Zeichendaten. Ab SQL Server 2016 gelten maximal 900 Byte für gruppierte und 1.700 Byte für nicht gruppierte Indexschlüssel. Die deklarierte Breite ist nicht der tatsächliche Platzbedarf eines kurzen Werts. Wählen Sie eine Länge für alle gültigen Namen oder Codes.

Soll die Länge am Converter hängen statt pro Eigenschaft wiederholt zu werden, übergeben Sie `ConverterMappingHints`:

```csharp
// EF Core 11 - the size travels with the converter
var converter = new ValueConverter<OrderStatus, string>(
    v => v.ToString(),
    v => Enum.Parse<OrderStatus>(v, ignoreCase: true),
    new ConverterMappingHints(size: 20, unicode: false));
```

Jede Facette, die Sie explizit auf der Eigenschaft setzen, überschreibt diese Hinweise.

## Wozu Ihre LINQ-Abfragen tatsächlich kompilieren

Gleichheit wird genau so übersetzt, wie man es sich wünscht. Das Enum wird auf dem Weg in den Parameter konvertiert, nicht auf dem Weg aus der Spalte, die Spalte bleibt also indexnutzbar:

```csharp
var pending = await context.Orders
    .Where(o => o.Status == OrderStatus.Pending)
    .ToListAsync();
```

```sql
SELECT "o"."Id", "o"."Perms", "o"."PrevStatus", "o"."Status"
FROM "Orders" AS "o"
WHERE "o"."Status" = 'Pending'
```

`Contains` über ein Array von Enum-Werten wird ein parametrisiertes `IN`, jeder Wert konvertiert:

```sql
-- Parameters: @wanted1='Pending', @wanted2='Paid'
WHERE "o"."Status" IN (@wanted1, @wanted2)
```

Auch `ExecuteUpdate` verarbeitet konvertierte Enums und sendet den String als Parameter:

```csharp
await context.Orders
    .Where(o => o.Id == id)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Status, OrderStatus.Paid));
```

Damit sind die gewöhnlichen Fälle abgedeckt. Jetzt die, die sich nicht benehmen.

### Relationaler Vergleich und OrderBy wechseln zu alphabetisch

Das ist der eigentliche Preis der String-Speicherung, und EF Core warnt nicht davor. Ein `>`-Vergleich auf einem Enum ist vollkommen legales C# und wird zu einem vollkommen legalen SQL-String-Vergleich übersetzt, was nicht dasselbe ist:

```csharp
// Intent: "everything after Paid in the workflow"
var later = await context.Orders
    .Where(o => o.Status > OrderStatus.Paid)
    .ToListAsync();
```

```sql
WHERE "o"."Status" > 'Paid'
```

Bei drei Zeilen mit `Pending`, `Delivered` und `Cancelled` liefert LINQ im Speicher die Zeilen `Delivered` und `Cancelled`. Die Datenbank liefert die Zeile `Pending`, weil `'Pending' > 'Paid'` alphabetisch gilt und `'Cancelled'` und `'Delivered'` nicht. `OrderBy(o => o.Status)` hat dasselbe Problem: Es kommt `Cancelled, Delivered, Pending` zurück statt der Deklarationsreihenfolge.

Die Lösung ist keine Converter-Einstellung. Entweder behalten Sie einen int für alles, wonach sortiert oder per Bereich verglichen wird, oder Sie ergänzen eine explizite `int SortOrder`-Spalte, oder Sie ersetzen die Bereichsabfrage durch eine explizite Menge: `Where(o => finished.Contains(o.Status))`. Wenn bereits Code in Produktion Enums per Bereich vergleicht, suchen Sie ihn per grep, bevor Sie das Mapping umstellen.

### SQL für ToString() prüfen

Auf `Status.ToString()` zu projizieren oder zu filtern wirkt harmlos, wenn die Spalte ohnehin ein String ist, aber EF Core 10 erzeugt weiterhin den vom CLR-Aufruf implizierten Cast:

```csharp
context.Orders.Where(o => o.Status.ToString()!.StartsWith("P"))
```

```sql
-- EF Core 10
WHERE CAST([o].[Status] AS nvarchar(max)) LIKE N'P%'
```

Der SQL-Server-Provider von EF Core 10.0.10 erzeugte den gezeigten `CAST`. Ob ein Index genutzt wird, zeigt der tatsächliche Plan. EF Core 11 dokumentiert eine Optimierung redundanter Casts; prüfen Sie `ToQueryString()` mit der eingesetzten Kombination. Für exakte Statuswerte direkt Enums vergleichen. `EF.Functions.Like` erwartet einen Zeichenfolgenausdruck, keinen Enum-Parameter. Siehe [SQL-Logging in der Entwicklung](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

## Werte zurücklesen: unbekannte Namen und Groß-/Kleinschreibung

Value Converter laufen bei der Materialisierung, und eine String-Spalte nimmt alles an. Eine Zeile mit einem Namen, den Ihr Enum nicht hat, scheitert beim Lesen, nicht beim Abfragen:

```text
InvalidOperationException: Cannot convert string value 'Refunded' from the database
to any value in the mapped 'OrderStatus' enum.
```

Die Exception tritt beim Materialisieren der Zeile auf, eine Abfrage mit 10.000 Zeilen stirbt also an derjenigen Zeile, die zufällig defekt ist. Sichern Sie die Spalte mit einem `CHECK`-Constraint ab, wenn die Datenbank mit etwas geteilt wird, das direkt hineinschreibt.

Bei der Groß- und Kleinschreibung ist der eingebaute Converter dagegen nachsichtig: Eine Zeile mit `"pending"` materialisiert als `OrderStatus.Pending`. Das ist `EnumToStringConverter<TEnum>`, der ohne Beachtung der Schreibweise parst. Tauschen Sie ein handgeschriebenes `Enum.Parse(typeof(OrderStatus), v)` ein, wirft dieselbe Zeile, weil der BCL-Standard die Schreibweise beachtet. Wenn Sie selbst einen schreiben, schreiben Sie `Enum.Parse<OrderStatus>(v, ignoreCase: true)`.

### `[Flags]`-Enums laufen hin und zurück, lassen sich aber nicht abfragen

Ein `[Flags]`-Enum wird wie jedes andere über `ToString()` konvertiert, was eine kommagetrennte Liste ergibt:

```text
row 1 | Read
row 2 | Read, Write
row 3 | None
```

Der Hin- und Rückweg funktioniert. Abfragen nicht: `Where(o => o.Perms.HasFlag(Perms.Write))` lässt sich nicht in ein String-Prädikat übersetzen, und `LIKE '%Write%'` trifft nichts Brauchbares und scannt alles. Lassen Sie `[Flags]`-Enums als Ints, oder modellieren Sie die Berechtigungen als Zeilen.

### In Raw SQL den Providerwert übergeben

Ein interpolierter Raw-SQL-Parameter übernimmt den Eigenschaftskonverter nicht automatisch. Geben Sie die gespeicherte Darstellung explizit an. Für die eingebaute Namenszuordnung:

```csharp
var providerValue = OrderStatus.Pending.ToString();
var rows = await context.Orders
    .FromSql($"SELECT * FROM Orders WHERE Status = {providerValue}")
    .ToListAsync();
```

Interpolation liefert hier einen Parameter. Bei eigener Zuordnung auf `PND` muss für `Pending` dieser Code übergeben werden. Ein Integer kann je nach Provider andere Treffer oder einen Konvertierungsfehler liefern. Entity-Abfragen benötigen außerdem die für die Materialisierung erforderlichen Spalten. Das ist von einem [LINQ-Übersetzungsfehler](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) zu unterscheiden.

## Kurzcodes statt Namen speichern

Wenn Sie `"PND"` statt `"Pending"` wollen (Codes fester Breite sind in Schemata üblich, die mit einem Data Warehouse geteilt werden), leiten Sie von `ValueConverter<TModel, TProvider>` ab, damit das Mapping explizit und prüfbar ist:

```csharp
// EF Core 11
public class StatusCodeConverter : ValueConverter<OrderStatus, string>
{
    public StatusCodeConverter() : base(v => ToCode(v), v => FromCode(v)) { }

    private static string ToCode(OrderStatus s) => s switch
    {
        OrderStatus.Pending => "PND",
        OrderStatus.Paid => "PAI",
        OrderStatus.Shipped => "SHP",
        OrderStatus.Delivered => "DLV",
        OrderStatus.Cancelled => "CAN",
        _ => throw new ArgumentOutOfRangeException(nameof(s), s, null)
    };

    private static OrderStatus FromCode(string c) => c switch
    {
        "PND" => OrderStatus.Pending,
        "PAI" => OrderStatus.Paid,
        "SHP" => OrderStatus.Shipped,
        "DLV" => OrderStatus.Delivered,
        "CAN" => OrderStatus.Cancelled,
        _ => throw new InvalidOperationException($"Unknown status code '{c}'.")
    };
}
```

```csharp
modelBuilder.Entity<Order>()
    .Property(o => o.Status)
    .HasConversion<StatusCodeConverter>()
    .HasMaxLength(3)
    .IsUnicode(false);
```

Prädikate werden durch den Converter übersetzt, `Where(o => o.Status == OrderStatus.Pending)` wird also zu `WHERE "o"."Status" = 'PND'`. Weil die Switch-Arme über die bekannten Codes vollständig sind, liefert ein unerwarteter Wert *Ihre* Meldung statt der von EF, was die Fehlersuche deutlich erleichtert. Converter sind zustandslos und lassen sich über alle Eigenschaften teilen, die sie verwenden.

## Eine Spalte migrieren, die bereits Ints enthält

Eine reine Spaltenkonvertierung kann `2` als Text `"2"` statt `"Shipped"` speichern. Im SQLite-Test las der eingebaute Konverter von EF Core 10.0.10 beide Werte als `Shipped`. Ein Gleichheitsfilter für `Shipped` fand nur die benannte Zeile, weil sein Providerwert `"Shipped"` war. Auch `"99"` wurde als unbenannter Enum-Wert materialisiert, während `"Bogus"` eine Ausnahme auslöste. Numerischer Text ist daher auch bei erfolgreichem Lesen ein Vertragsproblem.

Für eine koordinierte Migration die vorgesehenen Namen explizit nachtragen. Erstellen Sie ein Backup, testen Sie an einer Kopie und berücksichtigen Sie Writer, die während der Bereitstellung noch die alte Spalte verwenden.

1. Fügen Sie den Converter zum Modell hinzu und erzeugen Sie die Migration mit `dotnet ef migrations add StoreStatusAsString`.
2. Öffnen Sie die erzeugte Migration und ersetzen Sie das `AlterColumn` durch ein `AddColumn` für eine temporäre Spalte, zum Beispiel `StatusText nvarchar(20) NULL`.
3. Ergänzen Sie zwischen Add und Drop ein Backfill mit `migrationBuilder.Sql(...)`, das jeden int explizit auf seinen Namen abbildet: `UPDATE Orders SET StatusText = CASE Status WHEN 0 THEN 'Pending' WHEN 1 THEN 'Paid' ... END;`. Schreiben Sie das CASE von Hand gegen die Enum-Deklaration, wie sie in diesem Commit aussieht, nicht gegen das, was sie später wird.
4. Löschen Sie die alte Spalte, benennen Sie `StatusText` in `Status` um und setzen Sie sie auf `NOT NULL`. Schreiben Sie die spiegelbildliche Logik in `Down`, damit die Migration umkehrbar bleibt.

Vor dem Löschen Zeilenzahlen, nicht zugeordnete Zahlen, Nullbarkeit und jede Zuordnung prüfen. Betroffene Indizes und Fremdschlüssel gezielt neu aufbauen und Upgrade sowie unterstützten Rollback testen. Prüfen Sie `dotnet ef migrations script` und erproben Sie die tatsächliche Bereitstellung, einschließlich [Migration Bundle](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), falls eingesetzt.

Ein letzter Hinweis zum Modell selbst: Value Converter gelten für eine einzelne Spalte. In dem Moment, in dem Sie mehrere Felder in einen String serialisieren, um das zu umgehen, wollen Sie stattdessen einen [als JSON gemappten komplexen Typ](/de/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), den EF Core 11 indizieren und direkt aktualisieren kann. Und wenn EF Core die Eigenschaft gar nicht mappen will, ist das ein anderes Problem mit einer anderen Lösung, behandelt unter [der Fehler, dass die Eigenschaft nicht gemappt werden konnte](/de/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/).

## Quellen

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) auf Microsoft Learn, inklusive der Liste der eingebauten Converter und der dokumentierten Einschränkungen.
- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) zur Konfiguration vor den Konventionen und zum Matching auf Basistypen.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) zum Entfernen wirkungsloser CASTs.
- API-Referenz zu [EnumToStringConverter&lt;TEnum&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.enumtostringconverter-1).
- [dotnet/efcore#10434](https://github.com/dotnet/efcore/issues/10434), das Tracking-Issue zum Abfragen innerhalb wertkonvertierter Eigenschaften.
- [SQL Server index key limits](https://learn.microsoft.com/en-us/sql/sql-server/maximum-capacity-specifications-for-sql-server?view=sql-server-ver17)
- [EF Core 10.0.10 enum converter source](https://github.com/dotnet/efcore/blob/v10.0.10/src/EFCore/Storage/ValueConversion/Internal/StringEnumConverter.cs)
