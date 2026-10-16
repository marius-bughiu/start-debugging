---
title: "Was entscheidet, ob EF Core eine SQL-Server-Spalte `date` als `DateOnly` oder `DateTime` scaffoldet?"
description: "Die EF-Core-Version des SQL-Server-Providers in Ihrem Startprojekt entscheidet: EF Core 7 und früher scaffolden date als DateTime, EF Core 8 bis 11 als DateOnly. Hier sind das Type Mapping, das diese Wahl trifft, gemessene Ausgaben von EF Core 7, 8, 10 und 11 RC 2 sowie zwei Wege, DateTime zurückzubekommen, ohne die Spalte stillschweigend auf datetime2 umzustellen."
pubDate: 2026-10-16
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "sql-server"
  - "scaffolding"
  - "dateonly"
lang: "de"
translationOf: "2026/10/what-decides-whether-ef-core-scaffolds-a-sql-server-date-as-dateonly-or-datetime"
translatedBy: "claude"
translationDate: 2026-10-16
---

**Kurze Antwort:** Eine Sache entscheidet, nämlich die Version von `Microsoft.EntityFrameworkCore.SqlServer` (und `Microsoft.EntityFrameworkCore.Design`), die Ihr Startprojekt beim Ausführen von `dotnet ef dbcontext scaffold` referenziert. Der Scaffolder fragt die Type Mapping Source des Providers nach dem Standard-CLR-Typ für jeden Store-Typ. Bis EF Core 7 liefert diese Abfrage `DateTime` für `date` und `TimeSpan` für `time`. Ab EF Core 8, über EF Core 10 bis zu den Release Candidates von EF Core 11, liefert sie `DateOnly` und `TimeOnly`. Es gibt keinen `dotnet ef`-Schalter, um das zu ändern. Wenn Sie `DateTime` zurückbrauchen, überschreiben Sie entweder das Type Mapping zur Entwurfszeit über `IDesignTimeServices` oder bearbeiten das T4-Template. Wenn Sie die Template-Lösung aus den offiziellen Breaking-Change-Hinweisen unverändert übernehmen, werden Ihre `date`-Spalten zur Laufzeit als `datetime2` gemappt. Der Rest dieses Beitrags zeigt, warum das so ist und wie Sie es beheben.

Ich habe alles Folgende unter macOS mit SDK 10.0.302 gegen `Microsoft.EntityFrameworkCore.SqlServer` 7.0.20, 8.0.32, 10.0.13 und 11.0.0-rc.2.26504.105 (auf SDK 11.0.100-rc.1) gemessen. Auf diesem Rechner läuft kein SQL Server, deshalb habe ich das `DatabaseModel`, das der Scaffolder normalerweise aus `INFORMATION_SCHEMA` liest, selbst aufgebaut und durch die echten SQL-Server-Design-Time-Services geschickt. Der Codegenerierungspfad (Scaffolding Model Factory, C#-Generator, T4-Templates) ist derselbe, den `dotnet ef dbcontext scaffold` ausführt, nachdem das Schema gelesen wurde.

## Die Type Mapping Source trifft die Entscheidung, nicht das Tool

Beim Scaffolden liest EF Core den Store-Typ jeder Spalte (`date`, `datetime2`, `nvarchar(50)` und so weiter) und muss einen CLR-Typ wählen. Dafür gibt es keine eigene Tabelle mit Scaffolding-Regeln. EF Core ruft `IScaffoldingTypeMapper.FindMapping(storeType, ...)` auf, was beim `IRelationalTypeMappingSource` des Providers nach dem Standard-Mapping dieses Store-Typs fragt. Welchen CLR-Typ der Provider für `date` zuerst registriert, landet in Ihrer Entität.

In EF Core 8 erhielt der SQL-Server-Provider eingebaute Unterstützung für `DateOnly` und `TimeOnly` ([dotnet/efcore#24507](https://github.com/dotnet/efcore/issues/24507)) und machte sie zu den Standard-Mappings für `date` und `time`. Die Seite zu den [Breaking Changes in EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only) führt dies als Änderung mit mittlerer Auswirkung auf, die nur Database-First-Anwender betrifft, die neu scaffolden.

Hier ist eine Sonde, die den Mapper direkt befragt:

```csharp
// .NET 10, EF Core 10.0.13 (same code compiles against 7.0.20, 8.0.32, 11.0.0-rc.2)
// Reference Microsoft.EntityFrameworkCore.Design with IncludeAssets="all" so the code can see its types.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.Scaffolding.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Design.Internal;
using Microsoft.Extensions.DependencyInjection;

var services = new ServiceCollection();
new SqlServerDesignTimeServices().ConfigureDesignTimeServices(services);
services.AddEntityFrameworkDesignTimeServices();
var mapper = services.BuildServiceProvider().GetRequiredService<IScaffoldingTypeMapper>();

foreach (var storeType in new[] { "date", "time", "datetime", "datetime2", "smalldatetime", "datetimeoffset" })
    Console.WriteLine($"{storeType,-15} -> {mapper.FindMapping(storeType, keyOrIndex: false, rowVersion: false)?.ClrType.Name}");
```

Die Ergebnisse, eine Spalte pro Provider-Version:

| Store-Typ | EF Core 7.0.20 | EF Core 8.0.32 | EF Core 10.0.13 | EF Core 11.0 RC 2 |
| --- | --- | --- | --- | --- |
| `date` | `DateTime` | `DateOnly` | `DateOnly` | `DateOnly` |
| `time` | `TimeSpan` | `TimeOnly` | `TimeOnly` | `TimeOnly` |
| `datetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetime2` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `smalldatetime` | `DateTime` | `DateTime` | `DateTime` | `DateTime` |
| `datetimeoffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` | `DateTimeOffset` |

Folgende Fakten entscheiden also:

- **Die Provider-Paketversion im Startprojekt.** `dotnet ef` lädt `Microsoft.EntityFrameworkCore.Design` und den Provider aus der Build-Ausgabe Ihres Projekts, nicht aus dem Tool-Paket. Das Mapping stammt also aus der EF-Core-Version des Projekts. Ein älteres `dotnet-ef`-Tool anzupinnen bringt `DateTime` nicht zurück. Sie erhalten nur die Warnung, dass die Tools-Version älter als die der Laufzeit ist, oder Schlimmeres.
- **Der Store-Typ, nicht die Daten.** `date` und `time` haben sich geändert. `datetime`, `datetime2` und `smalldatetime` werden in jeder Version zu `DateTime` gescaffoldet, weil keiner von ihnen nur ein Datum enthält.
- **Der Provider.** Das ist eine Entscheidung pro Provider. Auch die Design-Time-Services von Npgsql (geprüft mit 10.0.3) mappen PostgreSQL-`date` auf `DateOnly` und `time` auf `TimeOnly`.

Sonst spielt nichts eine Rolle: weder die SQL-Server-Version noch der Kompatibilitätsgrad der Datenbank, weder `--use-database-names` noch `--data-annotations`.

## Wie der gescaffoldete Code vorher und nachher aussieht

Ich habe eine Tabelle mit einem `int`-Schlüssel, einem `date NOT NULL`, einem nullbaren `date`, einem `time` und einem `datetime2` gescaffoldet. EF Core 7.0.20 schreibt Folgendes:

```csharp
// Scaffolded by EF Core 7.0.20
public partial class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
    public DateTime? ShippedOn { get; set; }
    public TimeSpan CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
    entity.Property(e => e.OrderDate).HasColumnType("date");
    entity.Property(e => e.ShippedOn).HasColumnType("date");
});
```

EF Core 8.0.32, 10.0.13 und 11.0 RC 2 schreiben Folgendes, in allen dreien identisch:

```csharp
// Scaffolded by EF Core 8.0.32 / 10.0.13 / 11.0.0-rc.2
public partial class Order
{
    public int Id { get; set; }
    public DateOnly OrderDate { get; set; }
    public DateOnly? ShippedOn { get; set; }
    public TimeOnly CutoffTime { get; set; }
    public DateTime CreatedAt { get; set; }
}

// In ShopContext.OnModelCreating
modelBuilder.Entity<Order>(entity =>
{
    entity.Property(e => e.Id).ValueGeneratedNever();
});
```

Achten Sie darauf, was aus `OnModelCreating` verschwunden ist. In EF Core 7 wird `DateTime` per Konvention auf `datetime2` gemappt, also musste der Scaffolder `HasColumnType("date")` schreiben, damit die Spalte ein `date` bleibt. In EF Core 8+ wird `DateOnly` per Konvention auf `date` gemappt, deshalb betrachtet der Scaffolder `HasColumnType("date")` als redundant und lässt es weg. Der Spaltentyp steht nirgends mehr im generierten Code. Er ergibt sich aus dem CLR-Typ. Genau dieses Detail ist der Grund, warum der naheliegende Weg zurück zu `DateTime` kaputt ist.

## Die Template-Lösung aus der Dokumentation verliert den Spaltentyp

Die Seite zu den Breaking Changes schlägt eine Abhilfe vor: `dotnet new ef-templates` ausführen, `CodeTemplates/EFCore/EntityType.t4` öffnen und den CLR-Typ austauschen, wenn die Spalte `date` oder `time` ist:

```csharp
// EntityType.t4 snippet from the EF Core 8 breaking-changes page
var clrType = property.GetColumnType() switch
{
    "date" when property.ClrType == typeof(DateOnly) => typeof(DateTime),
    "date" when property.ClrType == typeof(DateOnly?) => typeof(DateTime?),
    "time" when property.ClrType == typeof(TimeOnly) => typeof(TimeSpan),
    "time" when property.ClrType == typeof(TimeOnly?) => typeof(TimeSpan?),
    _ => property.ClrType
};
```

Ich habe diese Änderung auf die Templates von EF Core 10.0.13 (`Microsoft.EntityFrameworkCore.Templates` 10.0.13) angewendet und erneut gescaffoldet. Die Entität enthält nun `DateTime OrderDate`. Aber `DbContext.t4` rendert die Fluent API weiterhin aus dem Modell, in dem die Eigenschaft `DateOnly` ist, und lässt daher `HasColumnType("date")` weiterhin weg. Sie erhalten eine `DateTime`-Eigenschaft ohne Spaltentyp an irgendeiner Stelle.

Zur Laufzeit wendet EF Core dann die `DateTime`-Konvention an, also `datetime2`. Hier ist ein Kontext, der dem Template-Ergebnis entspricht, neben einem mit wiederhergestelltem Spaltentyp:

```csharp
// .NET 10, EF Core 10.0.13
var day = new DateTime(2026, 10, 16);
foreach (DbContext db in new DbContext[] { new ImplicitContext(), new ExplicitContext() })
{
    var p = db.Model.FindEntityType(typeof(Order))!.FindProperty(nameof(Order.OrderDate))!;
    Console.WriteLine($"{db.GetType().Name}: {p.GetColumnType()}");
    Console.WriteLine(db.Set<Order>().Where(o => o.OrderDate == day).ToQueryString());
}

public class Order
{
    public int Id { get; set; }
    public DateTime OrderDate { get; set; }
}

public class ImplicitContext() : ShopContext(false); // what the docs' template produces
public class ExplicitContext() : ShopContext(true);  // with HasColumnType("date")

public abstract class ShopContext(bool explicitType) : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder o) => o.UseSqlServer("Server=.;Database=Shop");
    protected override void OnModelCreating(ModelBuilder b) => b.Entity<Order>(e =>
    {
        e.Property(x => x.Id).ValueGeneratedNever();
        if (explicitType) e.Property(x => x.OrderDate).HasColumnType("date");
    });
}
```

Ausgabe:

```text
ImplicitContext: datetime2
DECLARE @day datetime2 = '2026-10-16T00:00:00.0000000';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
ExplicitContext: date
DECLARE @day date = '2026-10-16';

SELECT [o].[Id], [o].[OrderDate]
FROM [Order] AS [o]
WHERE [o].[OrderDate] = @day
```

Ohne den Spaltentyp geht jeder Parameter, der mit dieser Spalte verglichen wird, als `datetime2` über die Leitung. `datetime2` hat eine höhere [Datentyp-Rangfolge](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql) als `date`, daher konvertiert SQL Server die Spalte für den Vergleich nach `datetime2`. Ein `DateTime` mit Zeitanteil ist dann nie gleich einem gespeicherten Datum, während ein `date`-Parameter den Zeitanteil zuvor verworfen hätte. Wenn das Projekt außerdem Migrationen verwendet, gibt `GenerateCreateScript()` jetzt `[OrderDate] datetime2 NOT NULL` aus, und das nächste `migrations add`, das die Tabelle berührt, will die Spalte ändern. Die `time`-Hälfte des Snippets ist harmlos, weil `TimeSpan` ohnehin per Konvention auf `time` gemappt wird.

Die Lösung ist ein weiterer Block im selben Template, direkt nach dem `switch`, damit die ausgetauschte Eigenschaft ihren Store-Typ mitträgt:

```csharp
// CodeTemplates/EFCore/EntityType.t4, EF Core 10.0.13 templates, after the clrType switch
        usings.AddRange(code.GetRequiredUsings(clrType));

        if (clrType != property.ClrType)
        {
            // Keep the store type: DateTime/TimeSpan would otherwise map to datetime2/time by convention.
            usings.Add("System.ComponentModel.DataAnnotations.Schema");
#>
    [Column(TypeName = "<#= property.GetColumnType() #>")]
<#
        }
```

Ersetzen Sie dann, wie in der Dokumentation gezeigt, `property.ClrType` durch `clrType` in den Zeilen für `needsNullable`, `needsInitializer` und die Eigenschaft. Nach erneutem Scaffolden sieht die Entität so aus:

```csharp
// Scaffolded by EF Core 10.0.13 with the patched EntityType.t4
using System.ComponentModel.DataAnnotations.Schema;

public partial class Order
{
    public int Id { get; set; }

    [Column(TypeName = "date")]
    public DateTime OrderDate { get; set; }

    [Column(TypeName = "date")]
    public DateTime? ShippedOn { get; set; }

    [Column(TypeName = "time")]
    public TimeSpan CutoffTime { get; set; }

    public DateTime CreatedAt { get; set; }
}
```

Das Attribut wird unabhängig davon ausgegeben, ob Sie `--data-annotations` übergeben, weil es von Ihrem Template-Code geschrieben wird und nicht vom Annotation-Codegenerator. Das ist hier gewünscht, da die Fluent-Seite es nie schreiben wird.

## Die sauberere Rücknahme: Type Mapping zur Entwurfszeit überschreiben

Der Template-Ansatz flickt die Ausgabe, nachdem EF bereits entschieden hat, dass die Eigenschaft `DateOnly` ist. Robuster ist es, die Entscheidung selbst zu ändern. Damit verhält sich EF Core 8+ für `date` und `time` genau wie EF Core 7, einschließlich der Fluent API. `dotnet ef` findet jede `IDesignTimeServices`-Implementierung im Startprojekt und führt sie **nach** den Registrierungen des Providers und von EF selbst aus (siehe `DesignTimeServicesBuilder.CreateServiceCollection`), sodass ein späteres `AddSingleton` gewinnt:

```csharp
// .NET 10, EF Core 10.0.13 / 11.0. Lives in the startup project; only used by dotnet ef.
#pragma warning disable EF1001 // SqlServerTypeMappingSource is an internal API
using System.Data;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.EntityFrameworkCore.SqlServer.Infrastructure.Internal;
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;
using Microsoft.Extensions.DependencyInjection;

public sealed class ShopDesignTimeServices : IDesignTimeServices
{
    public void ConfigureDesignTimeServices(IServiceCollection services)
        => services.AddSingleton<IRelationalTypeMappingSource, DateTimeScaffoldingTypeMappingSource>();
}

public sealed class DateTimeScaffoldingTypeMappingSource(
    TypeMappingSourceDependencies dependencies,
    RelationalTypeMappingSourceDependencies relationalDependencies,
    ISqlServerSingletonOptions sqlServerSingletonOptions)
    : SqlServerTypeMappingSource(dependencies, relationalDependencies, sqlServerSingletonOptions)
{
    protected override RelationalTypeMapping? FindMapping(in RelationalTypeMappingInfo mappingInfo)
        => mappingInfo.StoreTypeNameBase switch
        {
            "date" => new SqlServerDateTimeTypeMapping("date", DbType.Date),
            "time" => new SqlServerTimeSpanTypeMapping("time"),
            _ => base.FindMapping(mappingInfo)
        };
}
```

Mit dieser Registrierung scaffoldet EF Core 10.0.13 dieselbe Tabelle byte-genau zur Ausgabe von EF Core 7: `DateTime OrderDate`, `DateTime? ShippedOn`, `TimeSpan CutoffTime` und `HasColumnType("date")` wieder in `OnModelCreating`. Weil der Vergleich nun zwischen `DateTime` und dessen `datetime2`-Standard stattfindet, weiß der Codegenerator, dass der explizite Spaltentyp nötig ist. Auch eine `time(0)`-Spalte kommt korrekt heraus, nämlich als `HasColumnType("time(0)")`, wo Standard-EF-Core-10 `TimeOnly` mit `HasPrecision(0)` schreibt.

Drei Dinge sollten Sie bei diesem Weg wissen:

- `SqlServerTypeMappingSource` liegt in einem `Internal`-Namespace, daher die Unterdrückung von `EF1001`. Der Konstruktor hatte in EF Core 8 und 9 zwei Parameter und bekam in EF Core 10 `ISqlServerSingletonOptions` dazu. Rechnen Sie also damit, diese Klasse bei Major-Upgrades anzufassen.
- Es betrifft nur die Entwurfszeit. Ihr `DbContext` sieht diesen Service zur Laufzeit nie, weil `IDesignTimeServices` nur von den Tools aufgerufen wird.
- Verwenden Sie `AddSingleton`, nicht `TryAddSingleton`. Der Provider hat seine Type Mapping Source bereits registriert, daher bewirkt ein `TryAdd` stillschweigend nichts. Dieselbe Falle begegnet Ihnen, wenn Sie [den Pluralizer für `dbcontext scaffold` ersetzen](/de/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/).

Wenn Sie über EF Core Power Tools oder deren `efcpt`-CLI scaffolden, ist dies bereits eingebaut: Deren Reverse-Engineering-Engine liefert eine `SqlServerTypeMappingSource`-Überschreibung, die genau das Obige tut, gesteuert über `type-mappings` / `use-DateOnly-TimeOnly` in `efcpt-config.json`. Das veröffentlichte Konfigurationsschema führt diese Einstellung mit dem Standardwert `false`, prüfen Sie also Ihre Konfigurationsdatei, statt anzunehmen, welchen Typ Sie erhalten.

## Sollte man überhaupt zurückwechseln?

Meistens nicht. Für eine Spalte, die einen Kalendertag enthält, ist `DateOnly` der ehrliche Typ. Ein auf `date` gemapptes `DateTime` trägt eine Uhrzeit und ein `Kind`, die die Datenbank verwirft, und diese Diskrepanz steckt hinter vielen Off-by-one-Day-Fehlern, wenn Werte Zeitzonen oder JSON-Grenzen überqueren. EF Core 8+ übersetzt die gängigen `DateOnly`-Member auf SQL Server, `System.Text.Json` serialisiert den Typ von Haus aus als `"2026-10-16"`, und Dapper [unterstützt `DateOnly` seit 2.1.86 wieder nativ](/de/2026/09/dapper-2-1-86-brings-back-dateonly-and-timeonly-support/).

Wechseln Sie zurück, wenn Sie die Konsumenten nicht im selben Release mitnehmen können: eine gemeinsame DTO-Assembly, eine Reporting-Schicht, die überall `DateTime`-Arithmetik betreibt, oder ein Team, das wöchentlich neu scaffoldet und nicht ein paar hundert Kompilierfehler auf einmal verkraften kann. Wählen Sie dann eine der beiden obigen Lösungen und machen Sie sie zum Teil des Repositorys, damit die nächste Person, die neu scaffoldet, dieselben Typen erhält.

## Stolperfallen nach einem erneuten Scaffold

- **Halb migrierte Modelle.** Wenn Sie nur einige Tabellen mit `--table` scaffolden, erhalten die neuen Entitäten `DateOnly`, und die alten, von Hand gepflegten behalten `DateTime`. Beides funktioniert, da EF Core 8+ `DateTime` mit `HasColumnType("date")` problemlos mappt, aber Joins und Vergleiche zwischen beiden brauchen nun Konvertierungen in C#. Entscheiden Sie sich für einen Typ pro Spalte, nicht pro Scaffold-Datum.
- **Code-First-Modelle sind nicht betroffen.** Der Standard für eine bestehende `DateTime`-Eigenschaft ist weiterhin `datetime2`, und ein explizites `HasColumnType("date")` funktioniert weiterhin. Beim Paket-Upgrade ändert sich zur Laufzeit nichts. Nur frisch generierter Code ändert sich. Wenn eine Migration nach einem Upgrade plötzlich eine Spalte ändern will, suchen Sie nach einem fehlenden Spaltentyp wie oben und lesen Sie dann, [warum EF Core ausstehende Modelländerungen meldet](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/).
- **`datetime` bleibt `DateTime`.** Nur `date` und `time` haben sich geändert. Eine ältere `datetime`-Spalte (3,33 ms Genauigkeit) wird in jeder Version weiterhin als `DateTime` mit `HasColumnType("datetime")` gescaffoldet.
- **Upgrade von EF Core 6 oder 7 mit dem ErikEJ-Paket.** Wenn Sie `ErikEJ.EntityFrameworkCore.SqlServer.DateOnlyTimeOnly` und `UseDateOnlyTimeOnly()` verwendet haben, um vor EF Core 8 `DateOnly` zu erhalten, entfernen Sie beides beim Upgrade. Die Unterstützung ist jetzt eingebaut. Den Rest dieses Sprungs behandelt [die Übersicht zu den Breaking Changes von EF Core 6 bis 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).
- **Prüfen Sie das SQL, nicht das C#.** Die oben beschriebene `datetime2`-Umstellung kompiliert, läuft und liefert für Mitternachtswerte plausible Ergebnisse. Man sieht sie nur am Parametertyp, also [protokollieren Sie das von EF Core erzeugte SQL](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) oder rufen Sie nach jeder Scaffolding-Anpassung einmal `ToQueryString()` auf.

## Verwandte Beiträge

- [How to add custom pluralization to `dotnet ef dbcontext scaffold` with `IPluralizer`](/de/2026/09/how-to-add-custom-pluralization-to-dotnet-ef-dbcontext-scaffold-with-ipluralizer/), der andere `IDesignTimeServices`-Hook, den Sie in derselben Klasse haben möchten.
- [Migrate EF Core 6 to EF Core 11: the breaking changes that bite](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Fix "The JSON value could not be converted to System.DateTime"](/de/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/), auch für den Fall, dass ein Wert auf der Leitung ein `DateOnly` sein sollte.
- [How to log the SQL that EF Core 11 generates](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)

## Quellen

- [Breaking changes in EF Core 8.0: SQL Server `date` and `time` now scaffold to `DateOnly` and `TimeOnly`](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/breaking-changes#sqlserver-date-time-only), Microsoft Learn.
- [dotnet/efcore#24507: DateOnly and TimeOnly support for SQL Server](https://github.com/dotnet/efcore/issues/24507)
- [Custom reverse engineering templates (T4)](https://learn.microsoft.com/en-us/ef/core/managing-schemas/scaffolding/templates), Microsoft Learn.
- [Design-time services](https://learn.microsoft.com/en-us/ef/core/cli/services), Microsoft Learn.
- [`DesignTimeServicesBuilder.cs` on the release/10.0 branch](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Design/Internal/DesignTimeServicesBuilder.cs), dotnet/efcore.
- [Data type precedence (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/data-types/data-type-precedence-transact-sql), Microsoft Learn.
- [EF Core Power Tools `SqlServerTypeMappingSource`](https://github.com/ErikEJ/EFCorePowerTools/blob/master/src/Core/RevEng.Core.80/SqlServerTypeMappingSource.cs) and [efcpt config schema](https://github.com/ErikEJ/EFCorePowerTools/blob/master/samples/efcpt-schema.json), ErikEJ/EFCorePowerTools.
