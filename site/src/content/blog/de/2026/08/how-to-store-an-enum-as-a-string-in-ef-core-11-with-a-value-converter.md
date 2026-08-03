---
title: "Wie man ein Enum in EF Core 11 mit einem Value Converter als String speichert"
description: "C#-Enums in EF Core 11 als lesbare Strings statt als Ints speichern: HasConversion, Massenkonfiguration für alle Enums, die nvarchar(max)-Falle, das Sortierproblem und die Migration einer bestehenden int-Spalte."
pubDate: 2026-08-03
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

Kurze Antwort: In EF Core 11 (auf .NET 11 mit C# 14) fügen Sie der Eigenschaft `.HasConversion<string>()` hinzu, und EF Core wählt den eingebauten `EnumToStringConverter<TEnum>` für Sie aus. Setzen Sie gleichzeitig `.HasMaxLength(...)`, denn ohne das liefert SQL Server eine `nvarchar(max)`-Spalte, die kein Index anfassen kann. Erledigen Sie das einmal für alle Enums im Modell mit `configurationBuilder.Properties<Enum>().HaveConversion<string>()` in `ConfigureConventions`. Gleichheit und `Contains` werden weiterhin korrekt nach SQL übersetzt; relationale Vergleiche wie `>` und `OrderBy` wechseln stillschweigend zu alphabetischer Sortierung, und genau das geht kaputt.

Dieser Beitrag behandelt die drei Wege, die Konvertierung zu konfigurieren, wie das erzeugte DDL und SQL tatsächlich aussehen, die fünf Fallstricke, die in der Produktion zubeißen, und das Migrationsverfahren für eine Spalte, die bereits Ints enthält.

Alle SQL-Ausgaben und Verhaltensweisen unten wurden mit EF Core 10.0.10 gegen SQLite und gegen den DDL-Generator des SQL-Server-Providers gemessen, mit dem SDK .NET 10.0.201. EF Core 11 benötigt die .NET 11 Runtime, daher konnte ich es auf dieser Maschine nicht ausführen; die unten genannten Unterschiede von EF Core 11 stammen aus den [Release Notes zu EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) und sind als solche gekennzeichnet. Die Value-Conversion-API selbst hat sich zwischen EF Core 8 und 11 nicht geändert.

## Warum das int-Standardmapping eine Belastung ist

Standardmäßig mappt EF Core ein Enum auf seinen zugrunde liegenden numerischen Typ. `OrderStatus.Shipped` wird zu `2`. Das ist kompakt und sortiert so, wie das Enum es deklariert, koppelt Ihre Datenbank aber an die *Deklarationsreihenfolge* eines C#-Typs.

```csharp
// .NET 11, C# 14
public enum OrderStatus { Pending, Paid, Shipped, Delivered, Cancelled }
```

Sechs Monate später fügt jemand `Refunded` zwischen `Paid` und `Shipped` ein, weil es sich besser liest. Das Enum kompiliert weiterhin, alle Tests laufen weiterhin durch, und jede Zeile in der Datenbank, die `Shipped` sagte, bedeutet jetzt `Refunded`. Es gibt keinen Compilerfehler und keinen Laufzeitfehler. Das ist eine stille Datenkorruption, die erst auffällt, wenn ein Mensch einen Report liest.

Strings haben diesen Fehlermodus nicht. `"Shipped"` bedeutet `Shipped`, egal was Sie mit der Deklarationsreihenfolge anstellen, und die Spalte ist für jeden lesbar, der Ad-hoc-SQL, ein BI-Werkzeug oder eine Support-Abfrage ausführt. Bezahlt wird das mit Speicherplatz, mit Indexbreite und mit dem Sortiervorbehalt weiter unten.

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
// EF Core 11 - equivalent to HasConversion<string>(), just more typing
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

Das ist der mit Abstand häufigste Fehler, und er bleibt unsichtbar, bis eine Abfrage langsam wird.

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

`Status` hatte keine Facetten und wurde daher `nvarchar(max)`. Auf SQL Server lässt sich über eine `nvarchar(max)`-Spalte überhaupt kein normaler Index legen, und Statusspalten sind genau die Spalten, nach denen ständig gefiltert wird. `PrevStatus` nutzte `.HasMaxLength(20).IsUnicode(false)` und wurde ein sauberes `varchar(20)`.

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

`nvarchar(450)` sind 900 Byte, die Grenze für die Indexschlüsselgröße von SQL Server. Es funktioniert, aber ein 900-Byte-Schlüssel für eine Spalte, die `"Pending"` enthält, verschwendet jede Indexseite. Setzen Sie die Länge selbst. Enum-Namen sind kurz; 32 oder 64 Zeichen ohne Unicode ist fast immer richtig.

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

### ToString() in einer Abfrage erzeugt ein CAST, und EF Core 11 entfernt es

Auf `Status.ToString()` zu projizieren oder zu filtern wirkt harmlos, wenn die Spalte ohnehin ein String ist, aber EF Core 10 erzeugt weiterhin den vom CLR-Aufruf implizierten Cast:

```csharp
context.Orders.Where(o => o.Status.ToString()!.StartsWith("P"))
```

```sql
-- EF Core 10
WHERE CAST([o].[Status] AS nvarchar(max)) LIKE N'P%'
```

Dieser Cast ist semantisch wirkungslos und für den Query-Planer ein Desaster: Die Spalte in eine Funktion zu verpacken hindert SQL Server daran, irgendeinen Index darauf zu verwenden. EF Core 11 erkennt redundante Casts beim SQL-Post-Processing und entfernt sie, und die Release Notes nennen Eigenschaften mit Value Conversion als die übliche Quelle. Unter EF Core 11 erzeugt dieselbe Abfrage ein blankes `WHERE [o].[Status] LIKE N'P%'`. Auf EF Core 10 oder älter lassen Sie das `.ToString()` weg und verwenden `EF.Functions.Like` auf der Eigenschaft, oder Sie warten auf das Upgrade. Das zu prüfen ist ein guter Grund, [das SQL-Logging in der Entwicklung eingeschaltet zu lassen](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).

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

### Raw-SQL-Parameter ignorieren den Converter stillschweigend

Die Dokumentation zu Value Conversions führt das als bekannte Einschränkung auf, und es lohnt sich zu sehen, wie es aussieht, denn es wirft nicht:

```csharp
var rows = await context.Orders
    .FromSql($"SELECT Id, Status FROM Orders WHERE Status = {OrderStatus.Pending}")
    .ToListAsync();
```

Der Parameter geht als `DbType = Int32` mit dem Wert `0` an die Datenbank. Die Abfrage läuft, trifft nichts und liefert eine leere Liste. Übergeben Sie in Raw SQL explizit `OrderStatus.Pending.ToString()`, oder bleiben Sie bei LINQ. Das ist ein anderer Fehler als die hinter [die LINQ-Ausdruck konnte nicht übersetzt werden](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/): hier gibt es überhaupt keine Exception.

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

Lassen Sie EF Core diese Migration nicht selbst erzeugen. Erzeugt wird ein einzelnes `AlterColumn`, das auf SQL Server eine implizite Konvertierung von `int` nach `nvarchar` ausführt: Der Wert `2` wird zum String `"2"`, nicht zu `"Shipped"`. Danach ist keine Zeile mehr parsbar und der nächste Lesevorgang wirft.

Das sichere Verfahren hat vier Schritte:

1. Fügen Sie den Converter zum Modell hinzu und erzeugen Sie die Migration mit `dotnet ef migrations add StoreStatusAsString`.
2. Öffnen Sie die erzeugte Migration und ersetzen Sie das `AlterColumn` durch ein `AddColumn` für eine temporäre Spalte, zum Beispiel `StatusText nvarchar(20) NULL`.
3. Ergänzen Sie zwischen Add und Drop ein Backfill mit `migrationBuilder.Sql(...)`, das jeden int explizit auf seinen Namen abbildet: `UPDATE Orders SET StatusText = CASE Status WHEN 0 THEN 'Pending' WHEN 1 THEN 'Paid' ... END;`. Schreiben Sie das CASE von Hand gegen die Enum-Deklaration, wie sie in diesem Commit aussieht, nicht gegen das, was sie später wird.
4. Löschen Sie die alte Spalte, benennen Sie `StatusText` in `Status` um und setzen Sie sie auf `NOT NULL`. Schreiben Sie die spiegelbildliche Logik in `Down`, damit die Migration umkehrbar bleibt.

Prüfen Sie das SQL, bevor es irgendwo Echtes läuft. `dotnet ef migrations script` gibt es aus, und genau dieses Skript führt ein [Migration Bundle](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) auf der Zielmaschine aus. Wird das Enum als Fremdschlüssel oder innerhalb eines gefilterten Index verwendet, löschen und erstellen Sie den Index in derselben Migration neu.

Ein letzter Hinweis zum Modell selbst: Value Converter gelten für eine einzelne Spalte. In dem Moment, in dem Sie mehrere Felder in einen String serialisieren, um das zu umgehen, wollen Sie stattdessen einen [als JSON gemappten komplexen Typ](/de/2026/07/how-to-map-a-complex-type-instead-of-an-owned-entity-in-ef-core-11/), den EF Core 11 indizieren und direkt aktualisieren kann. Und wenn EF Core die Eigenschaft gar nicht mappen will, ist das ein anderes Problem mit einer anderen Lösung, behandelt unter [der Fehler, dass die Eigenschaft nicht gemappt werden konnte](/de/2026/07/fix-property-could-not-be-mapped-not-a-supported-primitive-type-in-ef-core-11/).

## Quellen

- [Value Conversions](https://learn.microsoft.com/en-us/ef/core/modeling/value-conversions) auf Microsoft Learn, inklusive der Liste der eingebauten Converter und der dokumentierten Einschränkungen.
- [Model bulk configuration](https://learn.microsoft.com/en-us/ef/core/modeling/bulk-configuration) zur Konfiguration vor den Konventionen und zum Matching auf Basistypen.
- [What's New in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) zum Entfernen wirkungsloser CASTs.
- API-Referenz zu [EnumToStringConverter&lt;TEnum&gt;](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.storage.valueconversion.enumtostringconverter-1).
- [dotnet/efcore#10434](https://github.com/dotnet/efcore/issues/10434), das Tracking-Issue zum Abfragen innerhalb wertkonvertierter Eigenschaften.
