---
title: "JSON-Spalten in EF Core 11 mappen und abfragen"
description: "Mappen Sie einen verschachtelten Typ mit ComplexProperty(...).ToJson() auf eine einzelne JSON-Spalte, lassen Sie EF Core 11 ihn im nativen json-Datentyp von SQL Server 2025 speichern und fragen Sie ihn dann mit LINQ ab, das zu JSON_VALUE, JSON_CONTAINS und JSON_PATH_EXISTS übersetzt wird."
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "json"
  - "sql-server"
  - "dotnet-11"
lang: "de"
translationOf: "2026/06/how-to-map-and-query-json-columns-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-23
---

Kurze Antwort: Modellieren Sie die verschachtelten Daten als komplexen Typ, rufen Sie `ComplexProperty(b => b.Details, d => d.ToJson())` in `OnModelCreating` auf, und EF Core 11 mappt den gesamten Objektgraphen auf eine einzige Spalte. Auf SQL Server 2025 (Kompatibilitätsebene 170) ist diese Spalte der native `json`-Datentyp, nicht `nvarchar(max)`. Dann fragen Sie sie mit normalem LINQ ab: `Where(b => b.Details.Viewers > 3)` wird zu `JSON_VALUE(... RETURNING int)` übersetzt, `b.Tags.Contains("ef-core")` wird zu `JSON_CONTAINS` übersetzt, und `EF.Functions.JsonPathExists(...)` prüft einen Pfad. Massenaktualisierungen innerhalb des Dokuments funktionieren ebenfalls, über `ExecuteUpdateAsync` und die `.modify()`-Funktion des SQL-Server-`json`-Typs.

Dieser Artikel verwendet `Microsoft.EntityFrameworkCore` 11.0.0 auf .NET 11 mit C# 14, gegen SQL Server 2025. Die Mapping-APIs sind providerunabhängig, aber das genaue SQL und der native `json`-Typ sind SQL-Server-spezifisch; PostgreSQL und SQLite verwenden ihre eigenen JSON-Funktionen für dasselbe LINQ.

## Zwei Wege, eine Spalte auf JSON zu mappen, und warum nun einer bevorzugt wird

EF Core kann seit einiger Zeit ein verschachteltes .NET-Objekt in eine einzelne JSON-Spalte legen, aber historisch war der einzige Weg über *Owned-Entity-Typen*: `OwnsOne(...).ToJson()`. Das funktioniert weiterhin. Das Problem ist, dass Owned-Typen unter der Haube Entity-Typen sind, also Identität und Referenzsemantik mit sich tragen, was auf überraschende Weise in Ihren Code durchsickert.

Ab EF Core 10 und in 11 weiter stabilisiert ist das empfohlene Modellierungswerkzeug der *komplexe Typ*. Ein komplexer Typ hat keinen Schlüssel, keine Identität und Wertsemantik, was genau das ist, was ein JSON-Dokument innerhalb einer Zeile darstellt. Markieren Sie den Typ mit `[ComplexType]` (oder konfigurieren Sie ihn fluent) und rufen Sie `ToJson()` auf:

```csharp
// .NET 11, EF Core 11.0.0
public class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";

    public string[] Tags { get; set; } = [];     // primitive collection
    public required BlogDetails Details { get; set; }
}

[ComplexType]
public class BlogDetails
{
    public string? Description { get; set; }
    public int Viewers { get; set; }
}
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Blog>()
        .ComplexProperty(b => b.Details, d => d.ToJson());
}
```

Zwei Dinge landen hier in JSON. `Details` wird zu einer JSON-Spalte, weil Sie es mit `ToJson()` angefordert haben. `Tags` wird automatisch zu einer JSON-Spalte: EF mappt primitive Sammlungen (`string[]`, `List<int>` und so weiter) ohne jegliche Konfiguration auf eine JSON-Array-Spalte, ein Verhalten, das es seit EF Core 8 gibt.

## Der native json-Datentyp und wann Sie ihn bekommen

Der *Typ* der Spalte hängt von der Datenbank ab, auf die Sie EF richten. Mit EF Core 10 und 11 setzt EF die Spalte standardmäßig auf den nativen `json`-Datentyp anstelle von `nvarchar(max)`, wenn Sie den Provider mit `UseAzureSql` oder mit einer SQL-Server-Kompatibilitätsebene von 170 oder höher konfigurieren (was SQL Server 2025 meldet):

```csharp
// .NET 11, EF Core 11.0.0 - opt into the SQL Server 2025 json type
protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder.UseSqlServer(
        connectionString,
        o => o.UseCompatibilityLevel(170));
```

Das obige Modell erzeugt dann diese Tabelle:

```sql
CREATE TABLE [Blogs] (
    [Id] int NOT NULL IDENTITY,
    [Name] nvarchar(max) NOT NULL,
    [Tags] json NOT NULL,
    [Details] json NOT NULL,
    CONSTRAINT [PK_Blogs] PRIMARY KEY ([Id])
);
```

Der native `json`-Typ validiert seinen Inhalt, speichert ihn kompakter als Text und unterstützt einen JSON-Index. Ein Migrationsdetail sei gleich vorab erwähnt: Wenn Ihre Anwendung JSON bereits in `nvarchar(max)`-Spalten speichert und Sie die Kompatibilitätsebene auf 170 anheben, *ändert die nächste Migration, die EF generiert, diese Spalten automatisch auf `json`*. Wenn Sie dafür nicht bereit sind, setzen Sie den Spaltentyp explizit wieder auf `nvarchar(max)` oder halten Sie die Kompatibilitätsebene unter 170. Unter 170 funktioniert alles in diesem Artikel weiterhin; die Daten leben einfach in einer Textspalte und das SQL verwendet die älteren, string-basierten JSON-Funktionen.

## Das Mapping konfigurieren, Schritt für Schritt

Hier ist der minimale, geordnete Weg von einer normalen Klasse zu einer abfragbaren JSON-Spalte.

1. **Modellieren Sie die verschachtelten Daten als `[ComplexType]`.** Geben Sie ihm die Eigenschaften, die Sie im Dokument haben möchten. Sammlungen sind innerhalb eines komplexen Typs, der auf JSON gemappt wird, erlaubt, anders als beim Table Splitting.
2. **Rufen Sie `ToJson()` in `OnModelCreating` auf.** Verwenden Sie `ComplexProperty(b => b.Details, d => d.ToJson())` für ein einzelnes verschachteltes Objekt. Für eine Sammlung verschachtelter Objekte verwenden Sie `ComplexProperty` mit einem Sammlungstyp, und das gesamte Array wird auf eine Spalte gemappt.
3. **Zielen Sie auf SQL Server 2025 für den nativen Typ.** Setzen Sie `UseCompatibilityLevel(170)` (oder `UseAzureSql`), damit die Spalte `json` statt `nvarchar(max)` ist.
4. **Fügen Sie eine Migration hinzu und wenden Sie sie an.** `dotnet ef migrations add AddBlogDetailsJson` und dann `dotnet ef database update`. Prüfen Sie das generierte `CREATE TABLE`, um zu bestätigen, dass der Spaltentyp dem entspricht, was Sie erwarten.
5. **Fragen Sie ab und aktualisieren Sie mit normalem LINQ.** Kein rohes SQL, keine manuelle Serialisierung. Die Abschnitte unten zeigen, wozu jede LINQ-Form übersetzt wird.

## Abfragen innerhalb des Dokuments mit LINQ

Dies ist der Teil, der es lohnenswert macht, JSON-Spalten statt eines serialisierten Blobs zu verwenden, den Sie im Speicher deserialisieren müssen. Sie filtern, projizieren und ordnen über Eigenschaften *innerhalb* des JSON, und EF übersetzt das zu serverseitigen JSON-Funktionen.

Das Filtern über einen verschachtelten Skalar liest über `JSON_VALUE` mit einer typisierten `RETURNING`-Klausel:

```csharp
// .NET 11, EF Core 11.0.0
var popular = await context.Blogs
    .Where(b => b.Details.Viewers > 3)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) > 3
```

Die `RETURNING int`-Klausel ist das, was den Vergleich als Ganzzahl auf dem Server statt als Stringvergleich erlaubt, was sowohl korrekt als auch indexfreundlich ist.

### Eine primitive Sammlung durchsuchen: Contains wird zu JSON_CONTAINS

Zu prüfen, ob ein JSON-Array einen Wert enthält, ist die häufigste JSON-Abfrage. Auf SQL Server 2025 übersetzt EF Core 11 `Contains` über eine JSON-gestützte primitive Sammlung zur neuen `JSON_CONTAINS`-Funktion:

```csharp
var tagged = await context.Blogs
    .Where(b => b.Tags.Contains("ef-core"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[Tags], [b].[Details]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[Tags], 'ef-core') = 1
```

Das ersetzt die ältere, langsamere `OPENJSON`-basierte Übersetzung, und `JSON_CONTAINS` kann einen JSON-Index verwenden, falls einer definiert ist. Ich habe diese Übersetzung ausführlich im [Artikel über EF Core 11 und JSON_CONTAINS](/2026/04/efcore-11-json-contains-sql-server-2025/) behandelt, einschließlich des Kompatibilitätsebenen-Schalters, der sie aktiviert. Eine scharfe Kante: `JSON_CONTAINS` kann nicht nach null suchen, daher emittiert EF es nur, wenn es beweisen kann, dass eine Seite nicht nullbar ist (eine nicht-null-Konstante oder eine nicht nullbare Spalte oder ein nicht nullbares Element). Wenn es das nicht kann, fällt es auf die `OPENJSON`-Form zurück, damit die Abfrage weiterhin die richtige Antwort liefert.

### Pfad- und modusspezifische Suche: EF.Functions.JsonContains

Wenn Sie an einem bestimmten Pfad innerhalb des Dokuments suchen oder einen Suchmodus angeben müssen, rufen Sie `JSON_CONTAINS` direkt über `EF.Functions.JsonContains()` auf:

```csharp
var rated = await context.Blogs
    .Where(b => EF.Functions.JsonContains(b.JsonData, 8, "$.Rating") == 1)
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_CONTAINS([b].[JsonData], 8, N'$.Rating') = 1
```

Es akzeptiert den JSON-Wert, den zu suchenden Wert und optional einen Pfad und einen Suchmodus. Es funktioniert gegen skalare String-Eigenschaften, komplexe Typen und auf JSON gemappte Owned-Entity-Typen.

### Existiert dieser Pfad überhaupt: EF.Functions.JsonPathExists

Neu in EF Core 11, prüft `EF.Functions.JsonPathExists()`, ob ein JSON-Pfad vorhanden ist, und übersetzt zu SQL Servers `JSON_PATH_EXISTS` (verfügbar seit SQL Server 2022). Dies ist das richtige Werkzeug für "Zeilen, bei denen das Dokument ein optionales Feld gesetzt hat":

```csharp
var withOptional = await context.Blogs
    .Where(b => EF.Functions.JsonPathExists(b.JsonData, "$.OptionalInt"))
    .ToListAsync();
```

```sql
SELECT [b].[Id], [b].[Name], [b].[JsonData]
FROM [Blogs] AS [b]
WHERE JSON_PATH_EXISTS([b].[JsonData], N'$.OptionalInt') = 1
```

## Innerhalb des Dokuments aktualisieren, ohne es zu laden

Das Schreiben in eine JSON-Spalte hat zwei Modi. Der vertraute ist die Änderungsverfolgung: Sie laden die Entität, mutieren die verschachtelte Eigenschaft, rufen `SaveChanges` auf. EF serialisiert das aktualisierte Dokument und schreibt die Spalte. Das ist für eine Zeile in Ordnung.

Der interessante ist die Massenaktualisierung direkt in der Datenbank. EF Core 10 fügte `ExecuteUpdateAsync`-Unterstützung für JSON hinzu, und sie überträgt sich auf 11. Mit dem obigen Mapping des komplexen Typs können Sie einen Zähler innerhalb des JSON für eine gesamte Ergebnismenge in einem einzigen Roundtrip inkrementieren:

```csharp
await context.Blogs.ExecuteUpdateAsync(s =>
    s.SetProperty(b => b.Details.Viewers, b => b.Details.Viewers + 1));
```

Auf SQL Server 2025 verwendet dies die `.modify()`-Funktion des `json`-Typs, sodass der Server nur diese eine Eigenschaft an Ort und Stelle umschreibt, anstatt das gesamte Dokument zu lesen und neu zu serialisieren:

```sql
UPDATE [b]
SET [Details].modify('$.Viewers', JSON_VALUE([b].[Details], '$.Viewers' RETURNING int) + 1)
FROM [Blogs] AS [b]
```

Eine feste Anforderung: `ExecuteUpdate` in JSON funktioniert nur, wenn der Typ als *komplexer Typ* gemappt ist. Es funktioniert nicht für Owned-Entity-Typen. Dies ist der konkreteste Grund, komplexe Typen für neuen Code zu bevorzugen, und der breitere Kompromiss zwischen [`ExecuteUpdate` und dem Laden von Entitäten mit anschließendem SaveChanges](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/) gilt auch hier.

## JSON-Spalten funktionieren jetzt mit TPT- und TPC-Vererbung

Bis EF Core 11 konnten komplexe Typen und JSON-Spalten nicht auf Entity-Typen verwendet werden, die Table-per-Type (TPT)- oder Table-per-Concrete-Type (TPC)-Vererbung nutzten. Diese Einschränkung ist in 11 verschwunden. Sie können eine JSON-Eigenschaft auf einem Basistyp mappen und sie über die gesamte Hierarchie verwenden:

```csharp
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
```

```csharp
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Animal>()
        .UseTptMappingStrategy()
        .ComplexProperty(a => a.Details, b => b.ToJson());
}
```

Wenn Sie ein Domänenmodell mit einer echten Vererbungshierarchie pflegen, ist dies die Änderung, die es Ihnen erlaubt, TPT/TPC beizubehalten und dennoch die gemeinsamen, strukturierten Teile jeder Entität als Dokument zu modellieren.

## Randfälle, die beißen

**Owned- versus komplexe Semantik.** Bei Owned-Entity-Typen wirft das Zuweisen eines Dokuments an ein anderes (`blog.BillingDetails = blog.ShippingDetails`) eine Ausnahme, weil dieselbe Entity-Instanz nicht zweimal verfolgt werden kann. Komplexe Typen werden nach Wert verglichen und zugewiesen, sodass die Zuweisung einfach die Felder kopiert. Wenn Sie für JSON noch bei Owned-Typen sind, beseitigt die Migration zu komplexen Typen eine ganze Kategorie dieser Bugs; das passt gut zur Disziplin, [Records mit EF Core 11 korrekt zu verwenden](/2026/04/how-to-use-records-with-ef-core-11-correctly/) für unveränderliche Wertformen.

**Struct-komplexe Typen können noch nicht in Sammlungen sein.** EF Core 10 fügte `struct`- und `record struct`-Unterstützung für komplexe Typen hinzu, was gut zu ihrer Wertsemantik passt. Aber eine *Sammlung* von Struct-komplexen Typen wird derzeit nicht unterstützt. Verwenden Sie eine Klasse, wenn der verschachtelte Typ in einer Liste lebt.

**Optionale komplexe Typen brauchen eine Pflichteigenschaft.** Ein optionaler (nullbarer) komplexer Typ, der auf JSON gemappt ist, benötigt mindestens eine auf dem Typ definierte Pflichteigenschaft, sonst kann EF ein vollständig-null-Dokument nicht von einem abwesenden unterscheiden.

**Die Migration von nvarchar zu json ist automatisch.** Das Anheben der Kompatibilitätsebene auf 170 schreibt vorhandene `nvarchar(max)`-JSON-Spalten bei der nächsten Migration auf den nativen `json`-Typ um. Prüfen Sie diese Migration, bevor Sie sie in der Produktion anwenden; es ist eine Schemaänderung an jeder JSON-Spalte auf einmal.

**Indizierung.** Ein JSON-Index ist das, was `JSON_CONTAINS` und Pfad-Lookups bei Skalierung schnell macht. Der native `json`-Typ unterstützt `CREATE JSON INDEX`; reine Textspalten nicht. Wenn Ihre JSON-Abfragen heiße Pfade sind, ist der native Typ plus ein Index der Unterschied zwischen einem Seek und einem vollständigen Scan, dieselbe Lektion, die in den [Breaking Changes der Migration von EF Core 6 zu 11](/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) rund um Abfragepläne auftaucht.

Die Kurzfassung: Greifen Sie zu `[ComplexType]` plus `ToJson()`, zielen Sie auf SQL Server 2025, damit die Spalte echtes `json` ist, und behandeln Sie das Dokument dann wie jeden anderen Teil Ihres Modells in LINQ. EF Core 11 übersetzt das Filtern, das Array-`Contains`, die Pfadprüfungen und sogar die Massenaktualisierungen zu serverseitigen JSON-Funktionen, sodass das Dokument nie eine Reise in den Speicher antreten muss, nur um abgefragt zu werden.

## Quellen

- [What's New in EF Core 11: complex types and JSON with TPT/TPC, JsonPathExists, JSON_CONTAINS](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: native json data type, complex types ToJson, ExecuteUpdate for JSON](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [SQL Server json data type and the modify() method](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type)
- [JSON_CONTAINS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-contains-transact-sql)
- [JSON_PATH_EXISTS (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/json-path-exists-transact-sql)
</content>
