---
title: "Native json-Spalte vs. nvarchar(max) zum Speichern von JSON in SQL Server mit EF Core 11"
description: "Verwenden Sie den nativen json-Typ auf SQL Server 2025 und Azure SQL: EF Core 11 holt daraus JSON_CONTAINS, typisiertes JSON_VALUE, In-place-modify() und JSON-Indizes heraus. Bleiben Sie bei nvarchar(max) für SQL Server 2019/2022, ältere Tools oder ein Schema, das Sie zurückrollen können müssen."
pubDate: 2026-09-12
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "json"
  - "dotnet-11"
lang: "de"
translationOf: "2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11"
translatedBy: "claude"
translationDate: 2026-09-12
---

Kurze Antwort: Wenn Ihre Datenbank SQL Server 2025 oder Azure SQL ist, speichern Sie JSON im nativen `json`-Typ. Damit erzeugt EF Core 11 typisiertes `JSON_VALUE(... RETURNING int)`, übersetzt `Contains` auf einer primitiven Collection in `JSON_CONTAINS`, führt `ExecuteUpdate` über die In-place-Methode `.modify()` aus und kann einen `CREATE JSON INDEX` anlegen. Nichts davon funktioniert mit `nvarchar(max)`. Bleiben Sie bei `nvarchar(max)`, wenn Sie SQL Server 2019 oder 2022 betreiben, Tools haben, die die Spalte roh lesen (bcp im nativen Format, alte ODBC-Clients), oder eine Schemaänderung brauchen, die sich zurückrollen lässt: SQL Server weigert sich, eine `json`-Spalte per `ALTER` wieder in einen String-Typ umzuwandeln.

Alles Folgende wurde gegen `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 auf dem .NET 11 RC 1 SDK (11.0.100-rc.1.26425.128) mit C# 14 geprüft. Das serverseitige Verhalten stammt aus der Dokumentation zu SQL Server 2025 (17.x).

## Der Vergleich auf einen Blick

| | `json` (nativ) | `nvarchar(max)` |
| --- | --- | --- |
| Verfügbar auf | SQL Server 2025, Azure SQL Database, Azure SQL MI, SQL-Datenbank in Fabric | Allen Versionen von SQL Server |
| Standard in EF Core 11 bei | `UseAzureSql` oder `UseCompatibilityLevel(170)` | `UseSqlServer` (Standardlevel 160) |
| Speicherung | Geparstes Binärformat, UTF-8 (`Latin1_General_100_BIN2_UTF8`), bis zu 2 GB | UTF-16-Text |
| Validierung beim Schreiben | Immer; die oberste Ebene muss ein Objekt oder Array sein | Keine, außer Sie fügen `CHECK (ISJSON(...) = 1)` hinzu |
| SQL für skalaren Filter | `JSON_VALUE(col, '$.x' RETURNING int)` | `CAST(JSON_VALUE(col, '$.x') AS int)` |
| `tags.Contains("x")` | `JSON_CONTAINS(col, N'x') = 1` | `N'x' IN (SELECT ... FROM OPENJSON(col) ...)` |
| `ExecuteUpdate` auf einer Eigenschaft | `SET [col].modify('$.x', ...)` | `SET col = JSON_MODIFY(col, '$.x', ...)` |
| `CREATE JSON INDEX` | Ja (SQL Server 2025, Preview) | Nein |
| Parametertyp, den EF sendet | `SqlDbType.Json` | `SqlDbType.NVarChar` |
| Zurückwandeln mit `ALTER COLUMN` | Nicht erlaubt | Entfällt |
| Was ältere Clients sehen | `varchar(max)` oder `nvarchar(max)` | `nvarchar(max)` |

## Was sich ändert, wenn EF Core 11 den json-Typ wählt

EF entscheidet nicht anhand der Datenbank, mit der es sich verbindet. Es entscheidet anhand des Kompatibilitätslevels, das Sie konfigurieren, und zwar beim Aufbau des Modells. Ich habe ein kleines Testprogramm gebaut, das dasselbe Modell auf vier Arten konfiguriert und DDL und SQL ausgibt, mit einem Interceptor, der die Verbindung unterdrückt, sodass keine Datenbank nötig ist:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
public class Order
{
    public int Id { get; set; }
    public string Customer { get; set; } = "";
    public string[] Tags { get; set; } = [];          // primitive collection, always JSON
    public required Shipping Shipping { get; set; }   // complex type mapped with ToJson()
}

public class Shipping
{
    public string City { get; set; } = "";
    public int Priority { get; set; }
}

protected override void OnModelCreating(ModelBuilder mb)
    => mb.Entity<Order>().ComplexProperty(o => o.Shipping, s => s.ToJson());
```

Mit einfachem `UseSqlServer(connectionString)` läuft EF Core 11 auf Kompatibilitätslevel 160. Dieser Standard hat sich in EF Core 11 geändert: EF Core 10 verwendete 150. Beide JSON-Spalten werden zu `nvarchar(max)`:

```sql
-- UseSqlServer, default level 160
CREATE TABLE [Orders] (
    [Id] int NOT NULL,
    [Customer] nvarchar(max) NOT NULL,
    [Tags] nvarchar(max) NOT NULL,
    [Shipping] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_Orders] PRIMARY KEY ([Id])
);
```

Wechseln Sie zu `UseSqlServer(cs, o => o.UseCompatibilityLevel(170))` oder zu `UseAzureSql(cs)` (standardmäßig 170), und dasselbe Modell erzeugt `[Tags] json NOT NULL` und `[Shipping] json NOT NULL`. Sonst ändert sich nichts an Ihrem Code. Das ist das Erste, was Sie verinnerlichen sollten: **Der Wechsel von `UseSqlServer` zu `UseAzureSql` ist eine Änderung des Spaltentyps**, ob Sie das beabsichtigt haben oder nicht.

Auch die Abfragen ändern sich. Hier sind die drei wichtigsten LINQ-Formen, so wie sie auf jedem Level erzeugt werden:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
ctx.Orders.Where(o => o.Shipping.Priority > 2);
ctx.Orders.Where(o => o.Tags.Contains("gift"));
await ctx.Orders.Where(o => o.Id == 1)
    .ExecuteUpdateAsync(s => s.SetProperty(o => o.Shipping.Priority, o => o.Shipping.Priority + 1));
```

Auf Level 160 (`nvarchar(max)`):

```sql
WHERE CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) > 2

WHERE N'gift' IN (
    SELECT [t].[value]
    FROM OPENJSON([o].[Tags]) WITH ([value] nvarchar(max) '$') AS [t]
)

UPDATE [o]
SET [o].[Shipping] = JSON_MODIFY([o].[Shipping], '$.Priority', CAST(JSON_VALUE([o].[Shipping], '$.Priority') AS int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

Auf Level 170 (`json`):

```sql
WHERE JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) > 2

WHERE JSON_CONTAINS([o].[Tags], N'gift') = 1

UPDATE [o]
SET [Shipping].modify('$.Priority', JSON_VALUE([o].[Shipping], '$.Priority' RETURNING int) + 1)
FROM [Orders] AS [o]
WHERE [o].[Id] = 1
```

Auf dem Schreibpfad sendet `SaveChanges` bei der Änderung einer einzelnen Eigenschaft auf beiden Levels weiterhin das gesamte Dokument (`UPDATE [Orders] SET [Shipping] = @p0`). Der Unterschied liegt im Parameter: Auf 170 sendet das `Microsoft.Data.SqlClient` 7.0.2, das EF Core 11 RC 1 mitbringt, ihn als `SqlDbType.Json` statt als `SqlDbType.NVarChar`. Nur `ExecuteUpdate` bekommt das partielle In-place-Update. Wenn Sie dieses SQL in Ihrer eigenen App mitschneiden möchten, beschreibt [das Protokollieren des SQL, das EF Core 11 erzeugt](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) die Optionen.

## Wann der native json-Typ die richtige Wahl ist

- **Sie sind auf Azure SQL Database oder Managed Instance.** Der Typ ist dort mit der Update-Richtlinie SQL Server 2025 oder Always-up-to-date allgemein verfügbar, und `UseAzureSql` wählt ihn bereits aus. Ein Opt-out kostet Sie `JSON_CONTAINS` und die typisierte `RETURNING`-Klausel und bringt Ihnen nichts.
- **Sie sind auf SQL Server 2025 und filtern innerhalb von Dokumenten.** `JSON_VALUE`, `JSON_PATH_EXISTS` und `JSON_CONTAINS` können einen JSON-Index nutzen, und EF Core 11 kann jetzt einen aus dem Modell anlegen (nächster Abschnitt). Mit `nvarchar(max)` bleibt Ihnen als Index nur eine berechnete Spalte pro Pfad.
- **Sie aktualisieren Felder innerhalb von Dokumenten per Massenupdate.** `ExecuteUpdate` wird zu `.modify()`, das laut Microsoft in place aktualisiert, wenn der neue Wert passt: ein String, der nicht länger als der alte ist, oder eine Zahl desselben Typs oder Bereichs. `JSON_MODIFY` auf Text schreibt den Wert neu.
- **Sie möchten, dass die Datenbank Müll ablehnt.** Eine `json`-Spalte weist alles zurück, was kein wohlgeformtes Objekt oder Array ist. Mit `nvarchar(max)` gibt es diese Prüfung nur, wenn Sie sie selbst hinzufügen.

## Wann Sie bei nvarchar(max) bleiben sollten

- **Ihr Produktionsserver ist SQL Server 2019 oder 2022.** Den Typ gibt es dort nicht, und EF verwendet ihn nur, wenn Sie das Kompatibilitätslevel anheben. Behalten Sie also das Standardlevel 160 oder setzen Sie explizit 150.
- **Etwas außerhalb von EF liest die Spalte.** Die `json`-Dokumentation von SQL Server weist darauf hin, dass `sp_describe_first_result_set` den `json`-Typ nicht meldet. Clients mit TDS 7.4 oder neuer sehen `varchar(max)` mit einer UTF-8-Collation, ältere sehen `nvarchar(max)`. Das native bcp-Format schreibt das Dokument als Text, sodass Sie zum Zurückladen eine Formatdatei brauchen. ETL-Pakete mit fest kodierten Spaltenmetadaten sind das übliche Opfer.
- **Sie brauchen eine umkehrbare Migration.** Sie können `nvarchar(max)` per `ALTER` in `json` umwandeln, aber SQL Server erlaubt nicht, dass `ALTER TABLE` eine `json`-Spalte wieder in einen String- oder Binärtyp verwandelt. Die `Down()`-Methode, die EF für die Konvertierung erzeugt, ist ein schlichtes `ALTER COLUMN ... nvarchar(max)`. Ein Rollback bedeutet also, eine neue Spalte anzulegen, zu kopieren und von Hand zu tauschen.
- **Ihre Abfragen verwenden Formen, die der Typ noch nicht unterstützt.** Der Hinweis zu Breaking Changes in EF Core 10 nennt eine: `DISTINCT` über JSON-Arrays wird auf `json` nicht unterstützt, und solche Abfragen schlagen fehl.

## Belege: was ich gemessen habe und was nicht

Ich habe keinen Benchmark für Speicherbedarf oder Latenz durchgeführt. In meiner Testumgebung gibt es keine SQL Server 2025-Instanz, und ich werde keine Beschleunigungszahl neben einen Typ schreiben, den ich nicht gemessen habe. Was das Testprogramm oben für EF Core 11 RC 1 zeigt:

1. Der Spaltentyp wird ausschließlich durch `UseAzureSql` oder ein Kompatibilitätslevel von 170 oder höher bestimmt. `UseSqlServer` verwendet standardmäßig 160 (bestätigt in `SqlServerOptionsExtension`, wo `SqlServerDefaultCompatibilityLevel = 160` und `AzureSqlDefaultCompatibilityLevel = 170` gilt).
2. Jeder Übersetzungsunterschied in der Tabelle oben ist exakt erzeugtes SQL, nicht aus Release Notes umschrieben.
3. Die Migration, die EF für den Wechsel von 160 auf 170 erzeugt, besteht aus einem `ALTER COLUMN` pro JSON-Spalte (Behandlung von Default Constraints weggelassen):

```sql
-- EF Core 11.0.0-rc.1, model diff from level 160 to level 170
ALTER TABLE [Orders] ALTER COLUMN [Tags] json NOT NULL;
ALTER TABLE [Orders] ALTER COLUMN [Shipping] json NOT NULL;
```

Die Aussagen zu Speicherung und Lesen stammen von Microsoft. Die [Referenz zum json-Datentyp](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type) sagt, dass Lesevorgänge effizienter sind, weil das Dokument bereits geparst ist, dass Schreibvorgänge einzelne Werte aktualisieren können und dass das Binärformat "optimized for compression" ist. Messen Sie mit Ihren eigenen Dokumenten, bevor Sie irgendjemandem eine Zahl versprechen. Kleine, flache Dokumente gewinnen deutlich weniger als große, verschachtelte, auf die Sie filtern.

## Der Haken, der für Sie entscheidet: JSON-Indizes

EF Core 11 bringt `HasIndex` über Pfade innerhalb von JSON-Complex-Types, was zum `CREATE JSON INDEX` von SQL Server 2025 wird. Das ist der stärkste Grund, auf `json` umzusteigen, und es hat eine Falle. Das hat das Testprogramm ausgegeben, als ich dem Modell oben einen Index hinzugefügt habe:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1
mb.Entity<Order>().HasIndex("Shipping.City");
```

Auf Level 170 bekommen Sie, was Sie wollen:

```sql
CREATE JSON INDEX [IX_Orders_Shipping_City] ON [Orders]([Shipping]) FOR (N'$.City');
```

Auf Level 160 erzeugt EF **genau dieselbe Anweisung**, obwohl die Spalte, die es gerade angelegt hat, `nvarchar(max)` ist. Der SQL-Generator für Migrationen prüft den Speichertyp nicht, bevor er `CREATE JSON INDEX` schreibt. Die [Referenz zu CREATE JSON INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql) setzt eine `json`-Spalte voraus, also schlägt diese Migration beim Anwenden fehl. Deshalb legt auch Microsofts eigenes Beispiel den Typ explizit fest:

```csharp
// .NET 11, EF Core 11 - make the column type independent of the compatibility level
modelBuilder.Entity<Customer>()
    .ComplexProperty(c => c.Contact, b => b.ToJson().HasColumnType("json"));

modelBuilder.Entity<Customer>()
    .HasIndex("Contact.Address.City");
```

Drei weitere Einschränkungen kommen von der SQL-Seite. JSON-Indizes sind in Preview und nur für SQL Server 2025 dokumentiert, nicht für Azure SQL. Die Tabelle braucht einen gruppierten Primärschlüssel. Und ein Index lässt sich nur offline anlegen, wobei für die gesamte Dauer eine Schemaänderungssperre gehalten wird. Planen Sie das Migrationsfenster entsprechend; der [Workflow mit Migrations-Bundles für die Produktion](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) ist der sichere Weg, sie auszuführen.

Ein verwandter Hinweis zu Azure SQL: Die Dokumentation zum `json`-Typ führt `.modify()` noch als Preview-Funktion, die nur in SQL Server 2025 verfügbar ist, doch EF erzeugt es für jede `json`-Spalte, auch unter `UseAzureSql`. Diese Kombination konnte ich nicht testen. Bevor Sie sich auf `ExecuteUpdate` in JSON-Eigenschaften auf Azure SQL verlassen, führen Sie es einmal gegen eine echte Datenbank aus. Diese Diskrepanz hat EF schon einmal getroffen: [Der `AS JSON`-Fehler auf Azure SQL](/de/2026/09/fix-as-json-option-can-be-specified-only-for-column-of-nvarchar-max-on-azure-sql/) entstand, weil EF `json` in einer `OPENJSON`-Klausel erzeugte, die nur SQL Server 2025 akzeptiert. Er wurde in EF Core 10.0.11 behoben.

## Opt-out pro Spalte oder global

Wenn Sie auf Azure SQL sind, aber noch nicht konvertieren möchten, haben Sie zwei Schalter. Der globale senkt das Kompatibilitätslevel, von dem EF ausgeht:

```csharp
// .NET 11, EF Core 11 - keep every JSON column on nvarchar(max) on Azure SQL
optionsBuilder.UseAzureSql(connectionString, o => o.UseCompatibilityLevel(160));
```

Damit werden auch alle anderen Übersetzungen von Level 170 abgeschaltet, einschließlich `JSON_CONTAINS`. Der gezielte Schalter legt einzelne Spalten fest und lässt den Rest des Modells auf 170:

```csharp
// .NET 11, EF Core 11 - pin specific columns to text, verified to emit nvarchar(max) at level 170
modelBuilder.Entity<Order>()
    .ComplexProperty(o => o.Shipping, s => s.ToJson().HasColumnType("nvarchar(max)"));
modelBuilder.Entity<Order>()
    .PrimitiveCollection(o => o.Tags).HasColumnType("nvarchar(max)");
```

Für den umgekehrten Weg auf einer bestehenden Datenbank heben Sie das Level an, führen `dotnet ef migrations add ConvertJsonColumns` aus und lesen die erzeugte Migration, bevor Sie sie anwenden. Sie betrifft alle JSON-Spalten im Modell auf einmal, primitive Collections eingeschlossen, was man leicht vergisst, wenn man nur einen Complex Type mit `ToJson()` gemappt hat. Für die Modellierungsseite dieser Entscheidung erklärt [Complex Types vs. Owned Entities in EF Core 11](/de/2026/07/complex-types-vs-owned-entities-in-ef-core-11/), warum `ComplexProperty(...).ToJson()` das Mapping ist, das Sie vor der Konvertierung verwenden sollten. `ExecuteUpdate` in JSON funktioniert nur mit Complex Types.

## Die Empfehlung, noch einmal zusammengefasst

Wählen Sie `json` auf SQL Server 2025 und Azure SQL. Dorthin entwickelt sich EF Core 11: `JSON_CONTAINS`, typisiertes `JSON_VALUE`, `.modify()` und JSON-Indizes hängen alle davon ab, und `UseAzureSql` setzt es bereits voraus. Setzen Sie `HasColumnType("json")` explizit auf jeder JSON-Spalte, die Sie indizieren, damit eine Änderung des Kompatibilitätslevels nie eine Migration erzeugen kann, die fehlschlägt. Bleiben Sie bei `nvarchar(max)`, wenn der Server älter als 2025 ist, wenn Tools außerhalb von EF die rohe Spalte lesen oder wenn Sie eine Schemaänderung ohne Rückweg noch nicht akzeptieren können. Im letzten Fall legen Sie den Typ pro Spalte fest, statt das Kompatibilitätslevel für den gesamten Kontext zu senken. Für die Abfrageseite nach der Konvertierung setzt die Anleitung zum [Mappen und Abfragen von JSON-Spalten in EF Core 11](/de/2026/06/how-to-map-and-query-json-columns-in-ef-core-11/) dort an, wo dieser Beitrag aufhört.

## Quellen

- [json data type (SQL Server 2025, Azure SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/json-data-type): Speicherformat, `modify`, Konvertierungsregeln, Einschränkungen
- [CREATE JSON INDEX (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-json-index-transact-sql)
- [What's New in EF Core 11: JSON indexes, JSON_CONTAINS, compatibility level 160 default](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [What's New in EF Core 10: JSON type support](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/whatsnew)
- [EF Core 10 breaking change: json data type used by default on Azure SQL and compatibility level 170](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-10.0/breaking-changes)
- [JSON data type support in SqlClient](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql/json-data-sql-server)
- [dotnet/efcore#29623: SQL Server, support JSON indexes](https://github.com/dotnet/efcore/issues/29623)
