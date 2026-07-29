---
title: "Lösung: \"The model for context 'X' has pending changes\" in EF Core 11"
description: "EF Core wirft PendingModelChangesWarning, wenn das Modell nicht mehr zum letzten Migrations-Snapshot passt. Migration hinzufügen oder den Fehlalarm beheben."
pubDate: 2026-07-29
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "dotnet"
  - "dotnet-11"
  - "migration"
lang: "de"
translationOf: "2026/07/fix-the-model-for-context-has-pending-changes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-07-29
---

Führen Sie `dotnet ef migrations add <Name>` und danach `dotnet ef database update` aus. Seit EF Core 9.0 vergleichen `Migrate()`, `MigrateAsync()` und `dotnet ef database update` das aktuelle Modell mit dem Snapshot, den die letzte Migration geschrieben hat, und werfen `PendingModelChangesWarning`, wenn beide voneinander abweichen. Die mit Abstand häufigste Ursache ist eine Modelländerung ohne zugehörige Migration. Ist die gerade erzeugte Migration leer oder bei jedem Neuerzeugen identisch, liegt ein Fehlalarm vor: nicht deterministische Werte in `HasData`, ein fehlender Modell-Snapshot, Identity-Optionen, die nur im Startprojekt existieren, oder ein Snapshot aus einer älteren EF Core Version. Dieser Artikel bezieht sich auf EF Core 11.0 unter .NET 11 (zum Redaktionszeitpunkt Preview 6, GA im November 2026) mit C# 14, und alles gilt unverändert zurück bis EF Core 9.0, wo die Exception eingeführt wurde.

## Der Fehler im Kontext

Die Laufzeit-Exception, geworfen von einem `Database.Migrate()` Aufruf beim Start:

```
Microsoft.EntityFrameworkCore.Migrations[20409]
System.InvalidOperationException: An error was generated for warning 'Microsoft.EntityFrameworkCore.Migrations.PendingModelChangesWarning': The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes. This exception can be suppressed or logged by passing event ID 'RelationalEventId.PendingModelChangesWarning' to the 'ConfigureWarnings' method in 'DbContext.OnConfiguring' or 'AddDbContext'.
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.ValidateMigrations(String targetMigration)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.RelationalDatabaseFacadeExtensions.Migrate(DatabaseFacade databaseFacade)
```

Derselbe Fehler über die CLI fällt kürzer aus, der Exit-Code ist ungleich null:

```
Build started...
Build succeeded.
The model for context 'AppDbContext' has pending changes. Add a new migration before updating the database. See https://aka.ms/efcore-docs-pending-changes.
```

Die Event-ID `20409` ist `RelationalEventId.PendingModelChangesWarning` (`CoreEventId.RelationalBaseId + 409`), in der Log-Kategorie `Microsoft.EntityFrameworkCore.Migrations`. In EF Core 9.0.0 fehlte im Text der `aka.ms` Link, das ist der einzige Formulierungsunterschied zwischen 9.0 und 11.0.

## Warum das passiert

Die Prüfung vergleicht zwei Modelle: das Entwurfszeitmodell, das EF gerade aus Ihrem `DbContext` aufbaut, und den Modell-Snapshot, der beim letzten `migrations add` nach `Migrations/AppDbContextModelSnapshot.cs` serialisiert wurde. Die Datenbank wird dabei **nicht** betrachtet. Das ist das Wichtigste an diesem Fehler, denn es bedeutet: eine vollständig aktuelle Datenbank rettet Sie nicht, und eine veraltete löst den Fehler nicht aus.

Der Vergleich ist derselbe, der auch das Erzeugen von Migrationen antreibt. Aus der `Migrator` Implementierung von EF Core selbst:

```csharp
// efcore/src/EFCore.Relational/Migrations/Internal/Migrator.cs, EF Core 11
public bool HasPendingModelChanges()
    => _migrationsModelDiffer.HasDifferences(
        FinalizeModel(_migrationsAssembly.ModelSnapshot?.Model)?.GetRelationalModel(),
        _designTimeModel.Model.GetRelationalModel());
```

Daraus folgen zwei Dinge. Erstens läuft der Diff über das *relationale* Modell, sieht also Spaltentypen, Längen, Nullbarkeit, Indizes und Constraint-Namen, nicht nur Ihre Entitätsklassen. Ein `HasMaxLength(128)`, das früher `450` war, ist eine ausstehende Änderung, auch wenn sich keine C# Eigenschaft geändert hat. Zweitens: ist `ModelSnapshot` gleich `null`, ist auch das Quellmodell `null`, und jede Tabelle Ihres Modells zählt als Unterschied.

Die Motivation des EF-Teams war schlicht: Migrationen stillschweigend anzuwenden, während das Modell darüber hinausgelaufen ist, erzeugt eine Datenbank, die nicht zum Code passt, und dieser Fehler zeigt sich viel später als Exception wegen einer fehlenden Spalte in der Produktion. Vor EF Core 9.0 wendete `Migrate()` die vorhandenen Migrationen an und kehrte kommentarlos zurück.

## Minimale Reproduktion

Zwei Dateien und ein vergessener Befehl:

```csharp
// .NET 11, EF Core 11.0.0, Microsoft.EntityFrameworkCore.SqlServer 11.0.0
using Microsoft.EntityFrameworkCore;

public class Blog
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public string? Slug { get; set; }   // added after the last migration
}

public class AppDbContext : DbContext
{
    public DbSet<Blog> Blogs => Set<Blog>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer("Server=.;Database=Demo;Trusted_Connection=True;Encrypt=False");
}
```

```csharp
// Program.cs, .NET 11
using var db = new AppDbContext();
db.Database.Migrate();   // throws PendingModelChangesWarning
```

`Slug` hinzufügen, `dotnet ef migrations add AddBlogSlug` auslassen, und der nächste `Migrate()` Aufruf wirft. Die Datenbank spielt hier keine Rolle: löschen, neu anlegen oder auf einen frischen Server zeigen, die Exception bleibt identisch.

## Lösung, nach Wahrscheinlichkeit sortiert

**1. Fügen Sie die vergessene Migration hinzu.** Das ist in der überwiegenden Mehrzahl der Fälle die richtige Lösung:

```bash
dotnet ef migrations add AddBlogSlug
```

Danach mit `dotnet ef database update` anwenden, oder `Migrate()` beim nächsten Start machen lassen. EF Core 11 fasst diese beiden Schritte zusätzlich zu einem zusammen, was nützlich ist, wenn die Anwendung in einem Container läuft, den Sie nicht neu bauen können: `dotnet ef database update AddBlogSlug --add` erzeugt die Migration, kompiliert sie mit Roslyn und wendet sie in einem einzigen Befehl an. Ausführlicher steht das im Artikel über [Migration erstellen und anwenden in einem Schritt](/de/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/).

**2. Erzeugen Sie einen fehlenden oder handbearbeiteten Snapshot neu.** Wenn jemand eine Migrationsklasse von Hand geschrieben, `AppDbContextModelSnapshot.cs` gelöscht oder einen Merge-Konflikt darin durch Übernahme einer Seite gelöst hat, beschreibt der Snapshot nicht mehr das Modell, das die Migrationen erzeugen. Führen Sie `dotnet ef migrations add` einmal mit dem Tooling aus: die erzeugte Migration enthält die tatsächliche Abweichung, und der Snapshot wird als Nebeneffekt neu geschrieben. Bearbeiten Sie den Snapshot niemals von Hand, um den Fehler loszuwerden, denn die nächste erzeugte Migration vergleicht gegen genau das, was Sie dort hinterlassen haben.

**3. Ersetzen Sie nicht deterministische `HasData` Werte durch Konstanten.** Ein `Guid.NewGuid()` oder `DateTime.UtcNow` in einem Seed-Objekt wird bei jedem Modellaufbau neu ausgewertet, das Modell weicht also tatsächlich bei jedem Lauf vom Snapshot ab. EF Core erkennt genau diesen Fall und ergänzt den Fehler um eine zweite Diagnose:

> The model for context '{contextType}' changes each time it is built. This is usually caused by dynamic values used in a 'HasData' call (e.g. `new DateTime()`, `Guid.NewGuid()`). Add a new migration and examine its contents to locate the cause, and replace the dynamic call with a static, hardcoded value.

Die Lösung ist, die Werte fest zu verdrahten:

```csharp
// .NET 11, EF Core 11.0.0
modelBuilder.Entity<Blog>().HasData(new Blog
{
    Id = 1,
    Name = "Start Debugging",
    // Not Guid.NewGuid(), not DateTime.UtcNow.
    PublicId = Guid.Parse("9e4f49fe-0786-44c6-9061-53d2aa84fab3"),
    CreatedUtc = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc),
});
```

Erzeugen Sie die Migration nach der Korrektur neu, da die vorherige einen Zufallswert eingefroren hat. Müssen die Daten wirklich dynamisch sein, gehören sie überhaupt nicht ins Modell: verschieben Sie sie nach `UseSeeding`/`UseAsyncSeeding`, das außerhalb des Snapshots läuft. Das vollständige Vorgehen steht in [Migration von HasData zu UseAsyncSeeding](/de/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/), die Abwägungen in [HasData vs UseSeeding](/de/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/).

**4. Geben Sie den EF-Tools dieselbe Konfiguration wie der Anwendung.** ASP.NET Core Identity ist der klassische Fall. Optionen wie `Stores.SchemaVersion` oder `Stores.MaxLengthForKeys` verändern das Modell, sie werden im DI-Container der Anwendung gesetzt, und die EF-Tools sehen sie nicht, wenn Sie die Tools nur gegen das `DbContext` Projekt laufen lassen. Der Snapshot beschreibt dann ein anderes Modell als das, welches die laufende Anwendung aufbaut. Entweder geben Sie die Anwendung als Startprojekt an:

```bash
dotnet ef migrations add AddBlogSlug --project src/Data --startup-project src/Web
```

oder Sie implementieren `IDesignTimeDbContextFactory<T>` neben dem Kontext, damit beide Wege das Modell identisch aufbauen:

```csharp
// .NET 11, EF Core 11.0.0
public class AppDbContextDesignTimeFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var services = new ServiceCollection();
        services.AddDefaultIdentity<ApplicationUser>(options =>
            {
                options.Stores.SchemaVersion = IdentitySchemaVersions.Version2;
                options.Stores.MaxLengthForKeys = 256;
            })
            .AddEntityFrameworkStores<AppDbContext>();

        var optionsBuilder = new DbContextOptionsBuilder<AppDbContext>();
        optionsBuilder.UseApplicationServiceProvider(services.BuildServiceProvider());
        optionsBuilder.UseSqlServer();
        return new AppDbContext(optionsBuilder.Options);
    }
}
```

**5. Erzeugen Sie einen von einer älteren EF Core Version geschriebenen Snapshot neu.** Die Snapshot-Generierung verbessert sich zwischen Releases, ein Snapshot aus EF Core 6 kann also gegenüber einem EF Core 11 Modell abweichen, ohne dass sich Code geändert hat. Auch das erkennt EF Core, über `RelationalEventId.OldMigrationVersion` (`20414`): "Pending model changes were detected for context '{contextType}', but the model snapshot was created with EF Core version '{efVersion}'." Fügen Sie eine leere Migration hinzu, um den Snapshot auf der aktuellen Version neu zu schreiben, prüfen Sie, dass deren `Up` wirklich leer ist, und behalten Sie sie. Das ist ein Routineschritt bei einer [Migration von EF Core 6 auf EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

**6. Unterdrücken Sie die Warnung, aber nur in den zwei Fällen, in denen sie wirklich ein Fehlalarm ist.** Wenn Ihre Migrationen dynamisch durch Austausch von EF-Services erzeugt oder ausgewählt werden, oder Sie geprüft haben, dass nichts mehr zu migrieren ist, unterdrücken Sie das konkrete Event:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<AppDbContext>(options => options
    .UseSqlServer(connectionString)
    .ConfigureWarnings(w => w.Ignore(RelationalEventId.PendingModelChangesWarning)));
```

Mit `w.Log(RelationalEventId.PendingModelChangesWarning)` landet es stattdessen im Log, statt ganz zu verschwinden. Unterdrückung ist außerdem der einzige Hebel, wenn die letzte Migration für einen anderen Provider erzeugt wurde als den, der sie anwendet (SQLite lokal, SQL Server in der Produktion). Microsoft bezeichnet das aber ausdrücklich als nicht unterstützt und als wahrscheinlichen Kandidaten dafür, künftig nicht mehr zu funktionieren. Erzeugen Sie stattdessen pro Provider einen eigenen Satz Migrationen.

## So erkennen Sie Ihre Ursache

Beginnen Sie mit dem Befehl, nicht mit der Exception. `dotnet ef migrations has-pending-model-changes` gibt es seit EF Core 8.0, und es endet mit einem Exit-Code ungleich null, wenn das Modell abgewichen ist. Damit ist es genau das Richtige für die CI vor einer Bereitstellung:

```bash
dotnet ef migrations has-pending-model-changes
```

Das programmatische Gegenstück, `context.Database.HasPendingModelChanges()`, macht aus derselben Prüfung einen Test, der beim Pull Request fehlschlägt, in dem die Migration vergessen wurde:

```csharp
// .NET 11, EF Core 11.0.0, xUnit v3
[Fact]
public void Model_has_no_pending_changes()
{
    using var context = new AppDbContext();
    Assert.False(context.Database.HasPendingModelChanges());
}
```

Danach eine Migration erzeugen und lesen. Die generierte `Up` Methode ist der Diff im Klartext: ein `AddColumn` verrät die vergessene Eigenschaft, ein `AlterColumn` mit `maxLength: 128` gegen eine alte `nvarchar(450)` Spalte verrät, dass Modell und Datenbankschema sich über die Länge uneinig sind, und ein `InsertData` mit jedes Mal neuer GUID verrät Ursache 3. Mit `dotnet ef migrations remove` löschen Sie die Migration wieder, falls sie sich als unecht herausstellt.

Ist die erzeugte Migration leer und der Fehler bleibt, sieht der EF-eigene Vergleich etwas, das der Generator nicht ausgibt. Bilden Sie nach, was `HasPendingModelChanges` tut, und geben Sie die rohen Operationen aus:

```csharp
// .NET 11, EF Core 11.0.0. Uses EF internals: pin your EF version if you keep this.
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

using var context = new AppDbContext();

var differ = context.GetService<IMigrationsModelDiffer>();
var initializer = context.GetService<IModelRuntimeInitializer>();
var snapshot = context.GetService<IMigrationsAssembly>().ModelSnapshot?.Model;

var source = snapshot is null ? null : initializer.Initialize(snapshot).GetRelationalModel();
var target = context.GetService<IDesignTimeModel>().Model.GetRelationalModel();

foreach (var operation in differ.GetDifferences(source, target))
{
    Console.WriteLine(operation.GetType().Name);
}
```

`IMigrationsModelDiffer` ist ein öffentliches Interface, aber ein Service für den internen Gebrauch. Behandeln Sie das als Debugging-Werkzeug, nicht als Produktionscode.

## Fallstricke und Varianten

**Das Zurückrollen löst den Fehler seit 9.0.2 nicht mehr aus.** EF Core 9.0.0 und 9.0.1 warfen `PendingModelChangesWarning` auch dann, wenn Sie eine ältere Migration explizit als Ziel angaben, womit ein Rollback ohne Unterdrücken der Warnung unmöglich war. Behoben in 9.0.2: die Prüfung läuft jetzt nur noch, wenn keine Zielmigration angegeben ist, `dotnet ef database update AddBlogSlug` und `dotnet ef database update 0` funktionieren also auch bei ausstehenden Änderungen.

**"No migrations were found in assembly" ist das EF Core 11 Geschwister, nicht derselbe Fehler.** `RelationalEventId.MigrationsNotFound` (`20406`) war bislang eine informative Log-Meldung und wirft ab EF Core 11.0 standardmäßig. Es greift, wenn es überhaupt keine Migrationen gibt, typischerweise weil `Migrate()` aus Gewohnheit aufgerufen wird, während das Schema per DACPAC oder handgeschriebenem SQL verwaltet wird. Entfernen Sie den `Migrate()` Aufruf, oder unterdrücken Sie dieses separate Event mit `w.Ignore(RelationalEventId.MigrationsNotFound)`.

**Jeder `DbContext` Typ braucht seine eigene Migration.** Eine Migration für `AppDbContext` bewirkt nichts für `AuditDbContext`. Die Exception nennt den Kontext, also lesen Sie sie: `dotnet ef migrations add <Name> --context AuditDbContext`.

**Projekte mit mehreren Zielframeworks brauchen seit EF Core 10 `--framework`.** Nutzt Ihr Projekt `<TargetFrameworks>`, brechen die Tools mit "The project targets multiple frameworks" ab, bevor sie überhaupt zum Modellvergleich kommen. Übergeben Sie `--framework net11.0`.

**`EnsureCreated()` wirft diesen Fehler nie.** Es verwendet gar keine Migrationen, liest also weder den Snapshot noch wendet es die Migrationshistorie an. Wer in Tests `EnsureCreated()` und in der Produktion `Migrate()` mischt, sieht den Fehler nur auf dem Produktionspfad.

**Das Datenbankschema bleibt ungeprüft.** Diese Prüfung zu bestehen heißt, dass Ihr Modell zu Ihrer letzten Migration passt. Sie sagt nichts darüber, ob die Migration angewendet wurde oder ob jemand in der Produktion eine Spalte von Hand geändert hat. Schemaänderungen als eigenen Bereitstellungsschritt auszuführen, wie in [EF Core 11 Migrationen mit einem Migration Bundle anwenden](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) beschrieben, schließt diese Lücke.

## Verwandte Beiträge

- [EF Core 11 Migrationen in der Produktion mit einem Migration Bundle anwenden](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) - wo die `has-pending-model-changes` Prüfung in eine Deployment-Pipeline gehört.
- [Migration in einem einzigen Befehl erstellen und anwenden](/de/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/) - die `--add` Option von EF Core 11.
- [Von HasData zu UseAsyncSeeding migrieren](/de/2026/07/migrate-from-hasdata-seeding-to-useasyncseeding-in-ef-core-11/) - die dauerhafte Lösung für Seed-Daten, die diesen Fehler immer wieder auslösen.
- [HasData vs UseSeeding in EF Core 11](/de/2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11/) - welcher Seeding-Mechanismus ins Modell gehört und welcher nicht.
- [Von EF Core 6 auf EF Core 11 migrieren](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) - die übrigen Breaking Changes, die beim selben Upgrade auftauchen.

## Quellen

- [Breaking Changes in EF Core 9: Exception beim Anwenden von Migrationen bei ausstehenden Modelländerungen](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/breaking-changes) - die maßgebliche Liste der Ursachen und Gegenmaßnahmen, inklusive des Identity-Beispiels für die Entwurfszeit-Factory.
- [Breaking Changes in EF Core 11: EF Core wirft standardmäßig, wenn keine Migrationen gefunden werden](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes) - die Änderung an `MigrationsNotFound`.
- [Migrationen verwalten: auf ausstehende Modelländerungen prüfen](https://learn.microsoft.com/en-us/ef/core/managing-schemas/migrations/managing) - `has-pending-model-changes` und `HasPendingModelChanges()`.
- [dotnet/efcore#35285: Hintergrund und Informationen zum PendingModelChangesWarning Fehler in 9.0](https://github.com/dotnet/efcore/issues/35285) - die Einordnung der Fehlalarme durch das EF-Team selbst.
- [dotnet/efcore#35342](https://github.com/dotnet/efcore/issues/35342) und der Fix in 9.0.2 - die Rollback-Regression.
- [Migrator.cs in dotnet/efcore](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Migrations/Internal/Migrator.cs) und [RelationalStrings.resx](https://github.com/dotnet/efcore/blob/main/src/EFCore.Relational/Properties/RelationalStrings.resx) - der Vergleich selbst und der exakte Meldungstext.
