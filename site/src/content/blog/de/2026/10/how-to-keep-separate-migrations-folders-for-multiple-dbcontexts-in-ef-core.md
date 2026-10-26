---
title: "Getrennte Migrations-Ordner für mehrere DbContexts in einem EF Core-Projekt führen"
description: "Übergeben Sie --output-dir einmal pro DbContext, und EF Core legt jede weitere Migration in diesem Ordner und Namespace ab. Warum das Standardlayout unsymmetrisch ist, die CS0111-Kollision bei einem gemeinsamen Ordner, wie Sie vorhandene Migrationen verschieben und wann Sie die Verlaufstabelle aufteilen sollten."
pubDate: 2026-10-26
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "ef-core-11"
  - "migrations"
  - "dotnet"
lang: "de"
translationOf: "2026/10/how-to-keep-separate-migrations-folders-for-multiple-dbcontexts-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-26
---

**Kurze Antwort:** Legen Sie die erste Migration jedes Contexts mit einem eigenen `--output-dir` an, zum Beispiel `dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog` und dasselbe für `OrdersDbContext` mit `Data/Migrations/Orders`. EF Core leitet den Namespace aus diesem Ordner ab (`Shop.Data.Migrations.Catalog`), und jedes weitere `migrations add` für denselben Context landet automatisch neben der vorherigen Migration und dem Snapshot, sodass Sie `--output-dir` nie wieder angeben müssen. Verweisen Sie nicht zwei Contexts auf denselben Ordner: Gleich benannte Migrationen werden zu einer partiellen Klasse, und der Build schlägt mit CS0111 fehl. Alles unten wurde mit EF Core 10.0.14 und `dotnet-ef` 10.0.14 auf .NET 10 (SDK 10.0.302) gegen SQLite ausgeführt. Den Scaffolding-Code im Branch `release/11.0` habe ich ebenfalls verglichen, und die Ordner- und Namespace-Logik ist in EF Core 11 unverändert.

## Was EF Core tut, wenn Sie nichts festlegen

Viele entscheiden sich nie für ein Layout. Sie fügen dem Projekt einen zweiten `DbContext` hinzu, stoßen auf den ersten Fehler, ergänzen `--context` und machen weiter. Es lohnt sich zu sehen, was dabei herauskommt, denn das erklärt die meisten verwirrenden Ordnerstrukturen, die ich in echten Repositories sehe.

Dies ist das Setup für den gesamten Beitrag: ein Konsolenprojekt namens `Shop`, zwei Contexts, die beide auf dieselbe SQLite-Datei zeigen.

```csharp
// .NET 10, EF Core 10.0.14
// Data/Contexts.cs
using Microsoft.EntityFrameworkCore;

namespace Shop.Data;

public class Product { public int Id { get; set; } public string Name { get; set; } = ""; }
public class Order { public int Id { get; set; } public int ProductId { get; set; } public int Quantity { get; set; } }

public class CatalogDbContext(DbContextOptions<CatalogDbContext> options) : DbContext(options)
{
    public DbSet<Product> Products => Set<Product>();
}

public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
}
```

```csharp
// .NET 10, EF Core 10.0.14
// Program.cs
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Shop.Data;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db"));
builder.Services.AddDbContext<OrdersDbContext>(o => o.UseSqlite("Data Source=shop.db"));
using var host = builder.Build();
```

Ohne `--context` weigert sich das Tool zu raten:

```text
$ dotnet ef migrations add InitialCreate
More than one DbContext was found. Specify which one to use. Use the '-Context' parameter for PowerShell commands and the '--context' parameter for dotnet commands.
```

Ergänzen Sie `--context` für jeden Context und lassen Sie EF Core den Ordner wählen:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext
dotnet ef migrations add InitialCreate --context OrdersDbContext
```

Das Ergebnis ist unsymmetrisch:

```text
Migrations/
  20261026120305_InitialCreate.cs              namespace Shop.Migrations        (Catalog)
  20261026120305_InitialCreate.Designer.cs
  CatalogDbContextModelSnapshot.cs
  OrdersDb/
    20261026120307_InitialCreate.cs            namespace Shop.Migrations.OrdersDb
    20261026120307_InitialCreate.Designer.cs
    OrdersDbContextModelSnapshot.cs
```

Der erste Context mit einer Migration besitzt `Migrations/`. Der zweite erhält einen Unterordner, benannt nach dem Context ohne das Suffix `Context`, aus `OrdersDbContext` wird also `OrdersDb`. Das ist kein Fehler, sondern gewollter Code in `MigrationsScaffolder`: Wenn Sie kein Ausgabeverzeichnis angeben und der Standard-Namespace `Migrations` bereits Migrationen enthält, deren Attribut `[DbContext]` auf einen anderen Context zeigt, wechselt EF Core zu `<RootNamespace>.Migrations.<ContextNameWithoutSuffix>`. Ein Context, dessen Name nicht auf `Context` endet, erhält stattdessen `<Name>Migrations`. Diese Logik gibt es seit EF Core 3.1, und sie existiert auch in 11 noch.

Das funktioniert, hängt aber von der Reihenfolge ab. Wer das Repository frisch klont, die Migrationen löscht und die Befehle in der anderen Reihenfolge ausführt, vertauscht die Ordner. Und die Asymmetrie (ein Context im Stammordner, einer darin verschachtelt) lässt `Migrations/` so aussehen, als gehöre es beiden. Explizit zu sein kostet einmalig ein Flag.

## Das explizite Layout mit --output-dir

Beginnen Sie sauber und geben Sie jedem Context bei seiner ersten Migration einen eigenen Ordner:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Data/Migrations/Catalog
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Data/Migrations/Orders
```

```text
Data/
  Contexts.cs
  Migrations/
    Catalog/
      20261026120357_InitialCreate.cs           namespace Shop.Data.Migrations.Catalog
      20261026120357_InitialCreate.Designer.cs
      CatalogDbContextModelSnapshot.cs
    Orders/
      20261026120359_InitialCreate.cs           namespace Shop.Data.Migrations.Orders
      20261026120359_InitialCreate.Designer.cs
      OrdersDbContextModelSnapshot.cs
```

Der Wert von `--output-dir` ist relativ zum Projektverzeichnis, und EF Core macht aus den Pfadsegmenten den Sub-Namespace, sodass `Data/Migrations/Catalog` zu `Shop.Data.Migrations.Catalog` wird (der Root-Namespace stammt aus dem `RootNamespace` des Projekts). Wenn der Namespace den Ordner nicht widerspiegeln soll, ergänzen Sie `--namespace`:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext \
  --output-dir Data/Migrations/Catalog \
  --namespace Shop.Catalog.Migrations
```

In der Package Manager Console von Visual Studio lauten dieselben Optionen `-Context`, `-OutputDir` und `-Namespace`:

```powershell
# EF Core 10.0.14 PMC tools
Add-Migration InitialCreate -Context CatalogDbContext -OutputDir Data\Migrations\Catalog
Add-Migration InitialCreate -Context OrdersDbContext -OutputDir Data\Migrations\Orders
```

## --output-dir geben Sie nur einmal an

Das lassen die meisten Antworten im Internet weg, und deshalb enden Leute mit Skripten, die `--output-dir` für immer wiederholen. Nach der ersten Migration bleibt der Ordner erhalten. Ich habe die Entität `Product` geändert und eine zweite Migration ganz ohne Ausgabeverzeichnis hinzugefügt:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add AddPrice --context CatalogDbContext
```

```text
Data/Migrations/Catalog/20261026120401_AddPrice.cs
Data/Migrations/Catalog/20261026120401_AddPrice.Designer.cs
```

Zwei Regeln in `MigrationsScaffolder` machen das möglich:

1. **Namespace**: Ohne angegebenes Ausgabeverzeichnis übernimmt die neue Migration den Namespace des letzten Migrationstyps des Contexts, und der Snapshot übernimmt den Namespace der vorhandenen Snapshot-Klasse.
2. **Verzeichnis**: `Save` durchsucht das Projektverzeichnis rekursiv nach der Datei der vorherigen Migration (`<PreviousMigrationId>.cs`) und schreibt die neuen Dateien in denselben Ordner. Der Snapshot wird auf dieselbe Weise über seinen Dateinamen `CatalogDbContextModelSnapshot.cs` gefunden.

Maßgeblich ist also, wo die Dateien gerade liegen. Das hat zwei praktische Folgen. Erstens müssen Sie kein Ausgabeverzeichnis in ein Skript oder in die `.config/dotnet-ef.json` von EF Core 11 schreiben (die ohnehin keinen Schlüssel für output-dir kennt). Zweitens können Sie Migrationen später verschieben, und EF Core folgt ihnen, worum es im nächsten Abschnitt geht.

Wenn Sie bei einer späteren Migration `--output-dir` explizit angeben, gilt es für die Migrationsdateien, der Snapshot wird aber weiterhin dort geschrieben, wo die vorhandene Snapshot-Datei liegt. Eine spätere Migration woandershin zu lenken teilt einen Context daher auf zwei Ordner auf. Vermeiden Sie das.

## Keinen Ordner für mehrere Contexts teilen

Was passiert, wenn Sie für beide Contexts dasselbe `--output-dir` angeben? EF Core erlaubt es, mit einer Warnung:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations add InitialCreate --context CatalogDbContext --output-dir Migrations
dotnet ef migrations add InitialCreate --context OrdersDbContext --output-dir Migrations
```

```text
The namespace 'Shop.Migrations' contains migrations for a different DbContext. This can result in conflicting migration names. It's recommend to put migrations for different DbContext classes into different namespaces.
Done. To undo this action, use 'ef migrations remove'
```

Die Warnung untertreibt. Beide Contexts haben jetzt eine `partial class InitialCreate` in `Shop.Migrations`. Die Dateinamen unterscheiden sich wegen der Zeitstempel, aber C# führt die partiellen Deklarationen zu einer Klasse zusammen, und der nächste Build schlägt fehl:

```text
error CS0111: Type 'InitialCreate' already defines a member called 'Up' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'Down' with the same parameter types
error CS0111: Type 'InitialCreate' already defines a member called 'BuildTargetModel' with the same parameter types
error CS0579: Duplicate 'Migration' attribute
```

Die eigene Prüfung auf doppelte Namen in EF Core (`The name 'InitialCreate' is used by an existing migration.`) betrachtet nur Migrationen desselben Contexts und kann das daher nicht abfangen. Das trifft Sie bei jedem Namen, den beide Teams zufällig wählen: `InitialCreate`, `AddIndexes`, `Cleanup`. Ein Ordner und ein Namespace pro Context machen die Kollision unmöglich.

## Vorhandene Migrationen verschieben

Wenn Ihr Projekt bereits das unsymmetrische Standardlayout hat oder alles in einem Ordner liegt, können Sie umorganisieren, ohne die Datenbank anzufassen. EF Core findet Migrationen per Reflection: Jeder Typ, der von `Migration` erbt und die Attribute `[DbContext(typeof(X))]` und `[Migration("<id>")]` trägt, gehört zum Context `X`. Ordner und Namespace spielen zur Laufzeit keine Rolle, und die Migrations-ID in der Verlaufstabelle ändert sich nicht.

Die Schritte für jeden Context:

1. Verschieben Sie die Migrationsdateien des Contexts (`<id>_<Name>.cs` und `<id>_<Name>.Designer.cs`) und seine `<Context>ModelSnapshot.cs` in den neuen Ordner. Die einfache `.cs`-Datei hat kein Attribut `[DbContext]`, gleichen Sie also über die Migrations-ID ab statt nach dem Context-Namen zu suchen, sonst lassen Sie von jeder Migration die Hälfte zurück.
2. Ändern Sie die Zeile `namespace` in jeder verschobenen Datei, einschließlich des Snapshots, auf den neuen Namespace.
3. Kompilieren Sie und führen Sie dann `dotnet ef migrations list --context <Context>` aus, um zu bestätigen, dass dieselben IDs erscheinen.
4. Fügen Sie die nächste Migration ohne `--output-dir` hinzu und prüfen Sie, dass sie im neuen Ordner landet.

Genau das habe ich am oben kaputten Projekt mit gemeinsamem Ordner gemacht: Ich habe die drei Dateien von `OrdersDbContext` nach `Migrations/Orders` verschoben, `namespace Shop.Migrations` in `namespace Shop.Migrations.Orders` geändert, und der Build wurde grün. `migrations list --context OrdersDbContext` listete weiterhin `20261026120430_InitialCreate` auf, und eine neue Migration `AddPlacedAt` landete ohne zusätzliche Flags in `Migrations/Orders` mit dem Namespace `Shop.Migrations.Orders`.

Führen Sie das Verschieben in einem einzigen Commit ohne weitere Änderungen durch, sodass der Diff nur aus Umbenennungen und einzeiligen Namespace-Änderungen besteht. Das Code-Review ist dann trivial, und `git log --follow` funktioniert weiter.

## Die gemeinsame Tabelle __EFMigrationsHistory

Ordner sind eine Frage des Quellcodes. In der Datenbank schreiben beide Contexts standardmäßig in dieselbe Verlaufstabelle, weil der Tabellenname nicht vom Context abhängt. Nachdem beide angewendet wurden:

```bash
# dotnet-ef 10.0.14
dotnet ef database update --context CatalogDbContext
dotnet ef database update --context OrdersDbContext
```

```text
sqlite> select * from __EFMigrationsHistory;
20261026120357_InitialCreate|10.0.14
20261026120401_AddPrice|10.0.14
20261026120359_InitialCreate|10.0.14
```

Es gibt keine Spalte für den Context. Jeder Context liest alle Zeilen und berücksichtigt nur die IDs, die zu seinen eigenen Migrationen passen, weshalb das meistens problemlos funktioniert. Das ID-Format ist `yyyyMMddHHmmss_Name` mit Sekundenauflösung, daher kollidieren zwei Contexts nur, wenn jemand denselben Migrationsnamen für beide in derselben Sekunde anlegt, was ein Skript, das über die Contexts iteriert, durchaus tun kann.

Wenn Sie den Verlauf trennen möchten, zum Beispiel weil die beiden Contexts auf unterschiedliche Schemas abgebildet sind oder verschiedenen Teams gehören, konfigurieren Sie eine Tabelle pro Context:

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlite("Data Source=shop.db",
    sql => sql.MigrationsHistoryTable("__CatalogMigrationsHistory")));
```

`MigrationsHistoryTable` akzeptiert bei Providern mit Schema-Unterstützung wie SQL Server auch ein Schema: `sql.MigrationsHistoryTable("__EFMigrationsHistory", "catalog")`.

Hier lauert die Falle: wenn Sie das bei einer Datenbank tun, auf die bereits Migrationen angewendet wurden. Die neue Tabelle ist leer, also denkt EF Core, es sei nichts gelaufen, und spielt `InitialCreate` erneut ab:

```text
$ dotnet ef database update --context CatalogDbContext
SQLite Error 1: 'table "Products" already exists'.
```

Kopieren Sie die Zeilen des Contexts in die neue Tabelle, bevor Sie aktualisieren. Unter SQLite:

```sql
-- SQLite, run once per database before deploying the history table change
CREATE TABLE "__CatalogMigrationsHistory" (
    "MigrationId" TEXT NOT NULL CONSTRAINT "PK___CatalogMigrationsHistory" PRIMARY KEY,
    "ProductVersion" TEXT NOT NULL);

INSERT INTO "__CatalogMigrationsHistory"
SELECT "MigrationId", "ProductVersion" FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');

DELETE FROM "__EFMigrationsHistory"
WHERE "MigrationId" IN ('20261026120357_InitialCreate', '20261026120401_AddPrice');
```

Danach ist `database update --context CatalogDbContext` ein No-op, und `migrations list` zeigt beide Migrationen als angewendet. Für eine neue Datenbank ist nichts Besonderes nötig: Das generierte Skript beginnt mit `CREATE TABLE IF NOT EXISTS "__CatalogMigrationsHistory"`. Wenn Sie mit einem idempotenten Skript oder einem Migration Bundle bereitstellen, führen Sie das Kopieren davor aus, in jeder Umgebung.

## Wenn beide Contexts dieselbe Tabelle abbilden

Getrennte Ordner verhindern nicht, dass zwei Contexts DDL für dieselbe Tabelle erzeugen. Angenommen, `OrdersDbContext` braucht Lesezugriff auf Produkte, und Sie fügen ihm `public DbSet<Product> Products => Set<Product>();` hinzu. Die nächste Migration für `OrdersDbContext` enthält dann ein `CreateTable(name: "Products", ...)`, das bei der Bereitstellung fehlschlägt, weil `CatalogDbContext` die Tabelle bereits angelegt hat.

Wählen Sie einen Besitzer und schließen Sie die Tabelle aus den Migrationen des anderen Contexts aus:

```csharp
// .NET 10, EF Core 10.0.14
public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Product> Products => Set<Product>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
        => modelBuilder.Entity<Product>()
            .ToTable("Products", t => t.ExcludeFromMigrations());
}
```

Damit erzeugte dasselbe `migrations add` eine leere Methode `Up`. Die Entität bleibt Teil des Modells, Abfragen und Change Tracking funktionieren also; nur Migrationen ignorieren die Tabelle. Beachten Sie, dass eine Schemaänderung an `Product` nun über `CatalogDbContext` migriert werden muss und `OrdersDbContext` sie über die gemeinsame Entitätsklasse übernimmt.

## Auch andere Befehle brauchen --context

Jeder Migrationsbefehl arbeitet mit einem Context. Sobald es zwei gibt, ist `--context` daher bei allen erforderlich, nicht nur bei `add`:

```bash
# dotnet-ef 10.0.14
dotnet ef migrations list   --context OrdersDbContext
dotnet ef migrations remove --context OrdersDbContext
dotnet ef migrations script --context OrdersDbContext --idempotent -o orders.sql
dotnet ef migrations bundle --context OrdersDbContext -o efbundle-orders
dotnet ef database update   --context OrdersDbContext
```

`migrations remove` löscht die Dateien der letzten Migration dort, wo sie liegen (es sucht im Projekt nach dem Dateinamen), und schreibt den Snapshot in seinem bestehenden Ordner neu, respektiert also ebenfalls Ihr Layout. Rufen Sie zur Laufzeit `Database.MigrateAsync()` einmal pro Context auf, in der Reihenfolge, die Ihr Schema braucht (Besitzer gemeinsamer Tabellen zuerst).

Wenn das Tippen von `--context` lästig wird: EF Core 11 kann einen Standard-`context` aus `.config/dotnet-ef.json` lesen. Flags überschreiben ihn weiterhin, Sie würden also den Context eintragen, den Sie am häufigsten migrieren, und für den anderen `--context` angeben.

## Ein eigenes Migrationsprojekt pro Context

Ordner innerhalb eines Projekts genügen für die meisten Apps. Wenn die Contexts getrennt bereitgestellt werden oder ein Team die Migrationen des anderen nicht anfassen darf, verschieben Sie die Migrationen jedes Contexts in eine eigene Klassenbibliothek und sagen EF Core, wo sie zu finden sind:

```csharp
// .NET 10, EF Core 10.0.14
builder.Services.AddDbContext<CatalogDbContext>(o => o.UseSqlServer(catalogConnection,
    sql => sql.MigrationsAssembly("Shop.Migrations.Catalog")));
```

Führen Sie dann `dotnet ef migrations add` mit `--project Shop.Migrations.Catalog --startup-project Shop --context CatalogDbContext` aus. Der Preis dafür ist ein weiteres Projekt pro Context und ein Verweis des Startprojekts auf jedes Migrationsprojekt, sodass diese zur Laufzeit geladen werden. Die [offizielle Anleitung zu einem separaten Migrationsprojekt](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects) beschreibt die Verdrahtung.

## Verwandte Beiträge

- [Fix: The model for context has pending changes in EF Core 11](/de/2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11/), was auch dann zuschlägt, wenn Sie eine Migration für den falschen Context hinzufügen.
- [Stop retyping --project and --startup-project with .config/dotnet-ef.json](/de/2026/06/efcore-11-dotnet-ef-json-config-file/) in EF Core 11.
- [How to apply EF Core 11 migrations in production with migration bundles](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/), ein Bundle pro Context.
- [Fix: There is already an object named 'X' in the database after resetting migrations](/de/2026/10/fix-there-is-already-an-object-named-in-the-database-after-resetting-ef-core-migrations/), dieselbe Mechanik der Verlaufstabelle aus anderer Perspektive.
- [Fix: dotnet ef migrations add "Unable to create an object of type DbContext"](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) für den Fall, dass die Design-Time-Tools keinen der beiden Contexts erstellen können.

## Quellen

- [EF Core tools reference (.NET CLI)](https://learn.microsoft.com/en-us/ef/core/cli/dotnet), Microsoft Learn: `--context`, `--output-dir`, `--namespace`.
- [Using a Separate Migrations Project](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/projects), Microsoft Learn.
- [Custom Migrations History Table](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/history-table), Microsoft Learn.
- [Entity types: excluding from migrations](https://learn.microsoft.com/en-us/ef/core/modeling/entity-types#excluding-from-migrations), Microsoft Learn.
- [`MigrationsScaffolder.cs` on release/10.0](https://github.com/dotnet/efcore/blob/release/10.0/src/EFCore.Design/Migrations/Design/MigrationsScaffolder.cs), die oben beschriebene Namespace-Vorgabe, Prüfung auf fremde Migrationen und Wiederverwendung des Verzeichnisses.
