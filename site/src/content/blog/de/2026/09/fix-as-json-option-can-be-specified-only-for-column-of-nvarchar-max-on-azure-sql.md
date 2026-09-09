---
title: "Fix: AS JSON option can be specified only for column of nvarchar(max) type in WITH clause"
description: "EF Core erzeugt [col] json '$.path' AS JSON innerhalb von OPENJSON WITH, was Azure SQL mit Msg 13618 ablehnt. Aktualisieren Sie auf EF Core 10.0.11+ oder senken Sie die Kompatibilitätsstufe des Providers auf 160."
pubDate: 2026-09-09
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "azure"
  - "json"
  - "dotnet-10"
lang: "de"
translationOf: "2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql"
translatedBy: "claude"
translationDate: 2026-09-09
---

Aktualisieren Sie `Microsoft.EntityFrameworkCore.SqlServer` auf 10.0.11 oder neuer. Vor dieser Version erzeugte EF Core `[col] json '$.path' AS JSON` innerhalb einer `OPENJSON ... WITH`-Klausel, sobald ein auf JSON gemappter komplexer Typ eine verschachtelte Sammlung enthielt und der Provider auf Kompatibilitätsstufe 170 lief. SQL Server 2025 akzeptiert den nativen Typ `json` an dieser Stelle, Azure SQL nicht, und lehnt ihn mit Msg 13618 ab. Wenn ein Update nicht möglich ist, übergeben Sie `o => o.UseCompatibilityLevel(160)`. Ein Haken: Die Korrektur greift nur, wenn EF weiß, dass es mit Azure SQL spricht. Sie müssen also `UseAzureSql` aufrufen und nicht `UseSqlServer` mit einer Azure-Verbindungszeichenfolge.

## Der Fehler im Kontext

Die Ausnahme erscheint als gewöhnliche `SqlException` bei der ersten Abfrage, die in eine verschachtelte JSON-Sammlung greift:

```
Microsoft.Data.SqlClient.SqlException (0x80131904): AS JSON option can be specified only for column of nvarchar(max) type in WITH clause.
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReaderAsync(RelationalCommandParameterObject parameterObject, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Query.Internal.SingleQueryingEnumerable`1.AsyncEnumerator.InitializeReaderAsync(AsyncEnumerator enumerator, CancellationToken cancellationToken)
   at Microsoft.EntityFrameworkCore.Storage.ExecutionStrategy.ExecuteAsync[TState,TResult](TState state, ...)
   at Microsoft.EntityFrameworkCore.EntityFrameworkQueryableExtensions.ToListAsync[TSource](IQueryable`1 source, CancellationToken cancellationToken)
```

Die serverseitige Fehlernummer ist 13618. Das SQL, das ihn ausgelöst hat, sieht so aus:

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

Die problematische Zeile ist `[partNumbers] json '$.partNumbers' AS JSON`. Alles andere in der Anweisung ist in Ordnung.

Das Erkennungsmerkmal, dass Sie auf dieser Seite richtig sind und nicht bei einem ähnlich aussehenden Fehler: Der Ausfall hängt von der Umgebung ab. Dasselbe Binary, dasselbe Modell und dieselbe Abfrage laufen gegen eine lokale SQL Server 2025-Instanz und scheitern gegen Azure SQL, selbst wenn beide Datenbanken Kompatibilitätsstufe 170 melden.

## Warum das passiert

Drei voneinander unabhängige Fakten treffen aufeinander.

**`AS JSON` hat schon immer `nvarchar(max)` verlangt.** Die [OPENJSON-Referenz](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql) ist eindeutig: "If you specify the `AS JSON` option, the type of the column must be **nvarchar(MAX)**." Diese Regel ist neun Jahre älter als der native Typ `json`.

**SQL Server 2025 hat die Regel gelockert, Azure SQL nicht.** Der native Datentyp `json` ist in Azure SQL Database und Azure SQL Managed Instance allgemein verfügbar und in SQL Server 2025 als Vorschau. Die [Einschränkungen des Datentyps json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations) nehmen `OPENJSON` jedoch ausdrücklich aus: "Currently, the `OPENJSON()` function doesn't accept the **json** data type in some platforms. Currently, it's an implicit conversion. Explicitly convert to **nvarchar(max)** first. In SQL Server 2025 (17.x), the `OPENJSON()` function does support **json**." Der Typ `json` in einer `WITH`-Klausel ist also eine Fähigkeit von SQL Server 2025 vor Ort, nicht von Azure SQL.

**`UseAzureSql` aktiviert standardmäßig Kompatibilitätsstufe 170, und 170 ist der Grund, warum EF den Typ `json` wählt.** In `SqlServerOptionsExtension` ist `SqlServerDefaultCompatibilityLevel` gleich 160, `AzureSqlDefaultCompatibilityLevel` dagegen 170. `SqlServerSingletonOptions.SupportsJsonType` liefert ab 170 true. Praktisch heißt das: Sie müssen sich für nichts entscheiden. Der Wechsel von `UseSqlServer` zu `UseAzureSql` genügt, um Ihre JSON-Spalten auf den nativen Typ `json` zu verschieben und in generierten Abfragen `json ... AS JSON` auszugeben.

Vor EF Core 10.0.11 schrieb `SqlServerQuerySqlGenerator.GenerateColumnInfo` für jede Spalte der `WITH`-Klausel `columnInfo.TypeMapping.StoreType` wortwörtlich aus. War der Speichertyp `json` und trug die Spalte `AS JSON`, entstand SQL, das nur SQL Server 2025 parsen konnte.

Beachten Sie, dass die Form der Abfrage entscheidend ist. Eine JSON-Spalte, die Sie nur als Ganzes lesen, trifft das nie, ein `Where` über einen Skalar im Dokument ebenso wenig. `AS JSON` taucht auf, wenn die Abfrage in eine im JSON-Dokument verschachtelte Sammlung hineingreift, denn EF muss dieses verschachtelte Array an einen zweiten `OPENJSON`-Aufruf übergeben. Wenn Ihnen neu ist, wie EF verschachtelte Dokumente in `OPENJSON`-Bäume übersetzt: Die Mechanik ist in [JSON-Spalten in EF Core 11 mappen und abfragen](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) beschrieben.

## Minimale Reproduktion

Das Modell braucht einen auf JSON gemappten komplexen Typ, der eine Sammlung komplexer Typen enthält, die wiederum eine Sammlung primitiver Werte enthält. Das ist die in [dotnet/efcore#38615](https://github.com/dotnet/efcore/issues/38615) gemeldete Form:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
public class Car
{
    public int CarId { get; set; }
    public string Vin { get; set; } = null!;
    public string DealerId { get; set; } = null!;
    public CarConfiguration CarConfiguration { get; set; } = null!;
}

public class CarConfiguration
{
    public string? CurrentTrim { get; set; }
    public List<OptionPackage>? OptionPackages { get; set; }
}

public class OptionPackage
{
    public required string PackageId { get; set; }
    public required ICollection<string> PartNumbers { get; set; }
}
```

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<Car>(builder =>
    {
        builder.ToTable("Cars");
        builder.HasKey(e => e.CarId);
        builder.Property(e => e.Vin).IsUnicode(false).HasMaxLength(32);
        builder.Property(e => e.DealerId).IsUnicode(false).HasMaxLength(32);

        builder.ComplexProperty(e => e.CarConfiguration, pp =>
        {
            pp.ToJson("CarConfiguration");
            pp.IsRequired();
            pp.Property(p => p.CurrentTrim).HasJsonPropertyName("currentTrim");

            pp.ComplexCollection(p => p.OptionPackages, op =>
            {
                op.HasJsonPropertyName("optionPackages");
                op.Property(o => o.PackageId).HasJsonPropertyName("packageId");
                op.PrimitiveCollection(o => o.PartNumbers)
                    .ElementType(e => e.IsUnicode(false).HasMaxLength(32))
                    .HasJsonPropertyName("partNumbers");
            });
        });
    });
}
```

In dieser Konfiguration steht bewusst kein `HasColumnType("json")`. Sie brauchen es nicht: Auf Kompatibilitätsstufe 170 wählt der Provider den nativen Typ von selbst.

Die scheiternde Abfrage ist jede Projektion, die zwei Ebenen tief geht:

```csharp
// .NET 10, C# 14, Microsoft.EntityFrameworkCore.SqlServer 10.0.10
var options = new DbContextOptionsBuilder<CarContext>()
    .UseAzureSql(connectionString)   // defaults to compatibility level 170
    .Options;

await using var ctx = new CarContext(options);

var partNumbers = await ctx.Cars
    .Where(c => c.Vin == "1FA6P8TH8J5123456" && c.DealerId == "DEALER-001")
    .SelectMany(c => c.CarConfiguration.OptionPackages!)
    .Where(op => op.PackageId == "PKG-SPORT")
    .SelectMany(op => op.PartNumbers)
    .ToListAsync();                  // Msg 13618 on Azure SQL
```

Für das fehlerhafte SQL brauchen Sie kein Azure-Abonnement. `ToQueryString()` generiert, ohne eine Verbindung zu öffnen, also genügt eine Wegwerf-Konsolenanwendung mit einer erfundenen Verbindungszeichenfolge, um zu prüfen, welche Form Ihr Build erzeugt. Läuft dieses Gerüst gegen 10.0.10, druckt es die oben gezeigte Zeile `[partNumbers] json '$.partNumbers' AS JSON`.

## Die Korrektur im Detail

### 1. Auf EF Core 10.0.11 oder neuer aktualisieren

Das ist die eigentliche Korrektur, und sie erfordert keine Änderungen an Modell oder Abfrage. [dotnet/efcore#38665](https://github.com/dotnet/efcore/pull/38665) landete am 2026-07-20 im Branch `release/10.0` und wurde in 10.0.11 (2026-08-11) ausgeliefert. Der aktuelle Patch 10.0.12 enthält sie ebenfalls.

```xml
<!-- .NET 10 -->
<PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="10.0.12" />
```

Gleiche Reproduktion, gleiche Abfrage, `Microsoft.EntityFrameworkCore.SqlServer` 10.0.12 und `UseAzureSql`:

```sql
SELECT [p].[value]
FROM [Cars] AS [c]
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] nvarchar(max) '$.partNumbers' AS JSON
) AS [o]
CROSS APPLY OPENJSON([o].[partNumbers]) WITH ([value] varchar(32) '$') AS [p]
WHERE [c].[Vin] = '1FA6P8TH8J5123456' AND [c].[DealerId] = 'DEALER-001' AND [o].[packageId] = N'PKG-SPORT'
```

Der Generator ersetzt den Typ jetzt nur an dieser einen Stelle:

```csharp
// dotnet/efcore, SqlServerQuerySqlGenerator.GenerateColumnInfo, release/10.0
if (columnInfo.AsJson
    && columnInfo.TypeMapping.StoreType == "json"
    && (_sqlServerSingletonOptions.EngineType != SqlServerEngineType.SqlServer
        || _sqlServerSingletonOptions.SqlServerCompatibilityLevel < 170))
{
    Sql.Append("nvarchar(max)");
}
else
{
    Sql.Append(columnInfo.TypeMapping.StoreType);
}
```

An Ihrer Tabelle ändert sich nichts. Die Spalte bleibt auf der Festplatte `json`, nur die Deklaration in der `WITH`-Klausel wird umgeschrieben, und `OPENJSON` akzeptiert die `json`-Spalte weiterhin als erstes Argument über eine implizite Konvertierung.

### 2. Wenn ein Update nicht möglich ist: Kompatibilitätsstufe auf 160 senken

```csharp
// .NET 10, Microsoft.EntityFrameworkCore.SqlServer 10.0.9 or 10.0.10
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

Bei 160 ist `SupportsJsonType` false, die JSON-Spalte wird auf `nvarchar(max)` gemappt, und die `WITH`-Klausel fällt auf `[partNumbers] nvarchar(max) '$.partNumbers' AS JSON` zurück. Gegen 10.0.10 bestätigt.

Der Preis beschränkt sich nicht auf diese eine Klausel. Kompatibilitätsstufe 160 deaktiviert außerdem die Übersetzung von `JSON_CONTAINS`, die `.modify()`-Unterstützung des Typs `json` für `ExecuteUpdate` und die übrigen nur bei 170 verfügbaren Übersetzungen, die in [der JSON_CONTAINS-Übersetzung von EF Core 11](/de/2026/04/efcore-11-json-contains-sql-server-2025/) beschrieben sind. Wichtiger noch: Sie ändert den modellierten Spaltentyp, was die Migrations-Pipeline bemerkt. Der Speichertyp direkt aus dem relationalen Modell in 10.0.12 gelesen macht das greifbar:

```
UseAzureSql (default compat 170)            Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(170)   Cars.CarConfiguration -> json
UseSqlServer + UseCompatibilityLevel(160)   Cars.CarConfiguration -> nvarchar(max)
```

Ist Ihre Tabelle bereits `json` und Sie senken die Kompatibilitätsstufe, erzeugt das nächste `dotnet ef migrations add` ein `ALTER COLUMN` zurück auf `nvarchar(max)`. SQL Server lässt eine Konvertierung einer `json`-Spalte in einen Zeichenfolgentyp per `ALTER TABLE` ohnehin nicht zu, diese Migration scheitert also bei der Bereitstellung, statt Ihre Daten still umzuschreiben. Behandeln Sie 160 als Notlösung zur Laufzeit und halten Sie es aus dem Modell heraus, aus dem Sie Migrationen erzeugen, oder akzeptieren Sie, dass Sie dauerhaft bei `nvarchar(max)` bleiben.

### 3. Prüfen, ob Sie tatsächlich `UseAzureSql` aufrufen

Das ist der Punkt, an dem alle stolpern, die aktualisieren und den Fehler weiterhin sehen. Sehen Sie sich die Bedingung des Generators noch einmal an: Er ersetzt durch `nvarchar(max)`, wenn der Engine-Typ nicht `SqlServer` ist oder wenn er `SqlServer` mit einer Kompatibilitätsstufe unter 170 ist. Richten Sie `UseSqlServer` auf eine Azure SQL-Verbindungszeichenfolge, fordern Sie Stufe 170 an, und EF schließt daraus, dass es mit einem lokalen SQL Server 2025 spricht, der `json` in `OPENJSON` unterstützt. In 10.0.12 gibt diese Kombination die fehlerhafte Zeile weiterhin aus:

```sql
-- UseSqlServer + UseCompatibilityLevel(170), EF Core 10.0.12
CROSS APPLY OPENJSON([c].[CarConfiguration], '$.optionPackages') WITH (
    [packageId] nvarchar(max) '$.packageId',
    [partNumbers] json '$.partNumbers' AS JSON
) AS [o]
```

Das ist korrektes Verhalten und kein zweiter Fehler: EF kann nicht wissen, wohin eine Verbindungszeichenfolge zeigt, ohne den Server zu fragen. Die Lösung besteht darin, die Engine zu deklarieren, auf der Sie laufen. `UseAzureSql` gibt es seit EF Core 9.0, und es richtet zusätzlich die für Azure passende Verbindungsresilienz kostenlos ein.

```csharp
// .NET 10, EF Core 9.0 and later
builder.Services.AddDbContext<CarContext>(options =>
    options.UseAzureSql(builder.Configuration.GetConnectionString("CarContext")));
```

Azure SQL Managed Instance nutzt denselben Aufruf. Azure Synapse hat `UseAzureSynapse`, das `SupportsJsonType` bedingungslos als false meldet und diesen Codepfad daher nie erreicht.

### 4. Was nicht funktioniert: den Typ der Container-Spalte überschreiben

Der naheliegend wirkende Workaround besteht darin, die JSON-Spalte zurück auf einen Zeichenfolgentyp zu zwingen:

```csharp
// Does NOT fix the WITH clause
pp.ToJson("CarConfiguration");
pp.HasColumnType("nvarchar(max)");
```

In 10.0.10 mit `UseSqlServer` auf Stufe 170 wird weiterhin `[partNumbers] json '$.partNumbers' AS JSON` ausgegeben. Der Grund: `HasColumnType` legt den Speichertyp der Container-Spalte fest, während der Eintrag der `WITH`-Klausel für eine verschachtelte Sammlung seinen Typ aus dem JSON-Typmapping des Providers bezieht, das aus der Kompatibilitätsstufe abgeleitet wird. Eine Änderung der äußeren Spalte erreicht die innere Deklaration nicht. Greifen Sie stattdessen zum Versionssprung oder zur Kompatibilitätsstufe.

## Fallstricke und ähnlich aussehende Fehler

**"The store type 'nvarchar(2000)' specified for JSON column ... is not supported by the current provider."** Anderer Fehler, andere Ursache. Dies ist eine `InvalidOperationException`, die von der Modellvalidierung ausgelöst wird, bevor überhaupt SQL erzeugt wird, und sie tritt in jeder Konfiguration auf, mit oder ohne Azure:

```
InvalidOperationException: The store type 'nvarchar(2000)' specified for JSON column 'CarConfiguration' in table 'Cars' is not supported by the current provider. JSON columns require a provider-specific JSON store type.
```

Sie bedeutet, dass Sie eine JSON-Spalte auf ein `nvarchar(x)` ohne MAX festgelegt haben, was in EF Core 9 noch funktionierte und in EF Core 10 zu einem Validierungsfehler wurde ([dotnet/efcore#37424](https://github.com/dotnet/efcore/issues/37424)). Verwenden Sie `nvarchar(max)` oder `json`, oder lassen Sie den Aufruf von `HasColumnType` weg und überlassen Sie die Wahl dem Provider.

**Handgeschriebenes SQL und `FromSql`.** Msg 13618 ist eine T-SQL-Regel, keine EF-Regel. Ist die fehlschlagende Anweisung Ihr eigenes `OPENJSON ... WITH (Payload nvarchar(100) '$.payload' AS JSON)`, hilft keine EF-Version: Verbreitern Sie die Spaltendeklaration auf `nvarchar(max)`. Die Seite [Häufige Probleme mit JSON](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server) in der SQL-Dokumentation behandelt dieselbe Regel von der T-SQL-Seite. Da rohes SQL die Abfrage-Pipeline umgeht, hilft `ToQueryString()` hier nicht. Das SQL, das Sie geschrieben haben, ist das SQL, das läuft.

**Lokaler SQL Server 2025 ist nicht betroffen.** Wenn Ihre Datenbank SQL Server 2025 (17.x) ist und EF mit `UseSqlServer` plus Stufe 170 konfiguriert ist, ist `json ... AS JSON` gültig und das SQL vor 10.0.11 läuft einwandfrei. Genau diese Asymmetrie ist der Grund, warum der Fehler überlebte, bis ein Kunde denselben Build gegen Azure laufen ließ.

**Die Kompatibilitätsstufe von EF ist nicht die der Datenbank.** `UseCompatibilityLevel(170)` sagt EF nur, welches SQL es erzeugen darf. Es führt kein `ALTER DATABASE ... SET COMPATIBILITY_LEVEL` aus. EF auf 170 einzustellen, während die Datenbank noch auf 150 steht, erzeugt eine völlig andere Familie von Syntaxfehlern.

**Ein `SELECT`, das nur das gesamte Dokument liest, ist sicher.** Ist der Fehler nach einem scheinbar unzusammenhängenden Refactoring aufgetaucht, suchen Sie nach einem neuen `SelectMany`, `Any` oder `Contains` über eine verschachtelte Sammlung. Genau das zieht den zweiten `OPENJSON`-Aufruf und die `AS JSON`-Spalte herein. Das SQL-Logging wie in [SQL protokollieren, das EF Core 11 erzeugt](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) beschrieben einzuschalten, zeigt Ihnen innerhalb einer Anfrage, welche Abfrage ihre Form geändert hat.

## Enthält EF Core 11 die Korrektur

Derselbe Generator-Code liegt im Branch `release/11.0`, daher enthält `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128, veröffentlicht am 2026-09-08, die Korrektur. Dieses Paket zielt ausschließlich auf `net11.0`, eine Überprüfung braucht also ein .NET 11 SDK. Alle SQL-Beispiele oben entstanden auf .NET SDK 10.0.302 gegen EF Core 10.0.10, 10.0.11 und 10.0.12 mit `ToQueryString()`.

Wenn Sie ohnehin ein JSON-lastiges Modell auf EF Core 11 heben, lohnt es sich, das im selben Durchgang mit den Mapping-Entscheidungen aus [komplexe Typen gegen Owned Entities](/de/2026/07/complex-types-vs-owned-entities-in-ef-core-11/) und den Provider-Änderungen aus [der Migration von EF Core 6 auf EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) zu erledigen. Die eigentliche Lehre reicht über diesen einen Fehler hinaus: "Azure SQL" und "SQL Server 2025" sind nicht dasselbe Ziel, sie unterscheiden sich gerade bei JSON, und EF weiß nur deshalb, auf welchem Sie sind, weil Sie es ihm gesagt haben.

## Verwandte Beiträge

- [JSON-Spalten in EF Core 11 mappen und abfragen](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/)
- [EF Core 11 übersetzt Contains zu JSON_CONTAINS auf SQL Server 2025](/de/2026/04/efcore-11-json-contains-sql-server-2025/)
- [Komplexe Typen gegen Owned Entities in EF Core 11](/de/2026/07/complex-types-vs-owned-entities-in-ef-core-11/)
- [SQL protokollieren, das EF Core 11 erzeugt](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [Migration von EF Core 6 auf EF Core 11: die Breaking Changes, die wirklich wehtun](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)

## Quellen

- [dotnet/efcore#38615, Ausnahme beim Abfragen von json, die nur auf Azure SQL mit Kompatibilitätsstufe 170 auftritt](https://github.com/dotnet/efcore/issues/38615)
- [dotnet/efcore#38665, Korrektur des OPENJSON-AS-JSON-Fehlers auf Azure SQL, wenn der Spaltentyp json bei Kompatibilitätsstufe 170 ist](https://github.com/dotnet/efcore/pull/38665)
- [dotnet/efcore#37424, EF10 SQL Server: auf nvarchar(x) gemappte JSON-Typen funktionieren nicht mehr](https://github.com/dotnet/efcore/issues/37424)
- [OPENJSON (Transact-SQL), einschließlich der Spaltentyp-Regel für AS JSON](https://learn.microsoft.com/en-us/sql/t-sql/functions/openjson-transact-sql)
- [Einschränkungen des Datentyps json, zu OPENJSON und dem Typ json](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type#limitations)
- [Microsoft SQL Server-Datenbankprovider für EF Core, zu UseAzureSql und Kompatibilitätsstufen](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/)
- [Häufige Probleme mit JSON in SQL Server lösen](https://learn.microsoft.com/en-us/sql/relational-databases/json/solve-common-issues-with-json-in-sql-server)
