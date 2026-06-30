---
title: "HasData vs UseSeeding fuer das Seeding von Daten in EF Core 11: was sollten Sie verwenden?"
description: "Verwenden Sie HasData nur fuer feste, modelleigene Referenzdaten. Verwenden Sie UseSeeding und UseAsyncSeeding fuer alles andere in EF Core 11. Ein direkter Vergleich mit den Regeln, die die Entscheidung erzwingen."
pubDate: 2026-06-30
template: vs
tags:
  - "comparison"
  - "efcore"
  - "dotnet"
lang: "de"
translationOf: "2026/06/hasdata-vs-useseeding-for-seeding-data-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-30
---

Verwenden Sie fuer das Seeding von Daten in EF Core 11 `HasData` nur fuer kleine, feste, deterministische Referenztabellen, die Sie innerhalb Ihrer Migrationen versionieren wollen (Laendercodes, Waehrungen, enum-artige Nachschlagezeilen). Verwenden Sie `UseSeeding` und `UseAsyncSeeding` fuer alles andere: alles mit datenbankgenerierten Schluesseln, berechneten oder nicht deterministischen Werten, bedingter Logik, Navigationseigenschaften oder Zeilen, die davon abhaengen, was bereits in der Datenbank steht. Das EF-Team hat `HasData` in "model-managed data" umbenannt, gerade um von der Verwendung als allgemeines Seeding-Werkzeug abzuraten. Dieser Artikel verwendet .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0) und C# 14.

Wenn Sie sich nur eine Zeile merken: `HasData` ist Teil des Modells und des Migrations-Diffs, `UseSeeding` laeuft als gewoehnlicher Code gegen einen lebenden `DbContext`. Fast jeder schmerzhafte Seeding-Bug entsteht dadurch, dass man das erste waehlt, obwohl man das zweite braucht.

## Die Feature-Matrix

Dies ist die Tabelle, fuer die Sie gekommen sind. Jede Zeile ist eine echte Einschraenkung, kein Gefuehl.

| Feature                          | `HasData` (model-managed data) | `UseSeeding` / `UseAsyncSeeding` |
| -------------------------------- | ------------------------------ | -------------------------------- |
| Konfiguriert in                  | `OnModelCreating` (das Modell) | `DbContextOptionsBuilder`        |
| Wann es laeuft                   | Im Migrations-SQL (`InsertData`) | Bei `Migrate`/`EnsureCreated` und `dotnet ef database update` |
| Primaerschluessel                | Muessen von Hand angegeben werden | Datenbankgenerierte Schluessel funktionieren |
| Nicht deterministische Werte     | Verboten (Re-Diff bei jedem Build) | Erlaubt (`Guid.NewGuid()`, `DateTime.UtcNow`) |
| Navigationseigenschaften         | Nein, nur Fremdschluessel      | Ja, vollstaendige Graph-Inserts  |
| Bedingte Logik                   | Nein                           | Ja, Sie schreiben das `if`       |
| Externe Aufrufe / Transformationen | Nein                         | Ja (Hashing, HTTP, Dateilesen)   |
| Idempotenz                       | Automatisch (EF macht den Diff) | Sie schreiben die Existenzpruefung |
| In der Versionsverwaltung erfasst | Ja, im Migrations-Snapshot    | Nein, es ist Startup-Code        |
| Aktualisiert bestehende Zeilen   | Ja, ueber Migrations-Diff      | Nur wenn Sie das Update schreiben |
| Verfuegbar seit                  | EF Core 1.0 (war `HasData`)    | EF Core 9, aktuell in EF Core 11 |

Die mit Abstand wichtigste Zeile ist "nicht deterministische Werte". `HasData` wird bei jedem Build gegen den Modell-Snapshot verglichen, daher laesst ein `DateTime.UtcNow` oder ein `Guid.NewGuid()` in Ihrem Seed das Modell jedes Mal veraendert erscheinen, und EF wirft `PendingModelChangesWarning` oder erzeugt ein endloses Rinnsal sinnloser Migrationen. Das ist die Wand, gegen die die meisten laufen, gewoehnlich waehrend einer [Migration von EF Core 6 zu EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/).

## Wann Sie HasData waehlen sollten

`HasData` ist das richtige Werkzeug, wenn die Daten wirklich Teil der Bedeutung Ihres Schemas sind. Der gedankliche Test: Waeren Sie damit zufrieden, diese Zeilen in einer Konstante zu codieren, und werden sie sich fast nie aendern?

- **Feste Nachschlagetabellen.** ISO-Laendercodes, Waehrungscodes, US-Bundesstaaten, ein durch eine Tabelle gestuetzter Bestellstatus-Enum. Die Schluessel sind stabil, Sie vergeben sie selbst, und Sie wollen, dass die Werte mit dem Schema ausgeliefert und versioniert werden. In EF Core 11 konfigurieren Sie es in `OnModelCreating`:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
protected override void OnModelCreating(ModelBuilder modelBuilder)
{
    modelBuilder.Entity<OrderStatus>().HasData(
        new OrderStatus { Id = 1, Name = "Pending" },
        new OrderStatus { Id = 2, Name = "Shipped" },
        new OrderStatus { Id = 3, Name = "Delivered" });
}
```

- **Daten, die automatisch gediffed und migriert werden sollen.** Aendern Sie `"Shipped"` in `"Dispatched"`, und das naechste `dotnet ef migrations add` gibt einen `UpdateData`-Aufruf aus. Sie erhalten versionierte, pruefbare, nachvollziehbare Aenderungen am Seed am selben Ort wie das Schema. Das ist ein echter Vorteil, den `UseSeeding` nicht kostenlos liefert.

- **Daten, ohne die das Schema bedeutungslos ist.** Wenn ein Fremdschluessel in einer anderen Tabelle auf `OrderStatus.Id = 2` zeigt und die Zeile fehlt, ist Ihre Anwendung kaputt. Das Einbacken in die Migration garantiert, dass sie im Gleichschritt mit dem Schema landet, innerhalb derselben Transaktion.

Die Schluessel muessen explizit gesetzt werden, und die Werte muessen deterministisch sein. Kein `Guid.NewGuid()`, kein `DateTime.Now`, keine Navigationseigenschaften (setzen Sie die Fremdschluesselspalte direkt). Brechen Sie eine davon, und `HasData` kaempft bei jedem Build mit Ihnen.

## Wann Sie UseSeeding und UseAsyncSeeding waehlen sollten

`UseSeeding` ist der in EF Core 11 empfohlene Allzweck-Mechanismus. Es ist einfacher Anwendungscode mit einem lebenden `DbContext`, daher existieren die Grenzen von `HasData` schlicht nicht. Greifen Sie dazu, sobald eine davon zutrifft:

- **Die Datenbank generiert den Schluessel.** Identity-Spalten, Sequenzen, `newsequentialid()`: Mit `HasData` muessten Sie Schluessel von Hand erfinden und hoffen, dass sie nie mit echten Inserts kollidieren. `UseSeeding` laesst die Datenbank sie vergeben.

- **Der Wert ist berechnet oder nicht deterministisch.** Das Hashen eines Standard-Admin-Passworts, das Stempeln von `CreatedAt = DateTime.UtcNow`, das Erzeugen eines `Guid`-Tokens. Nichts davon ueberlebt den Modell-Diff, also muss es zur Ausfuehrungszeit laufen:

```csharp
// .NET 11, EF Core 11 (Microsoft.EntityFrameworkCore 11.0), C# 14
services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .UseAsyncSeeding(async (context, _, ct) =>
        {
            if (!await context.Set<User>().AnyAsync(u => u.Email == "admin@example.com", ct))
            {
                context.Set<User>().Add(new User
                {
                    Email = "admin@example.com",
                    PasswordHash = PasswordHasher.Hash("change-me"), // runtime transform
                    CreatedAt = DateTime.UtcNow                        // non-deterministic
                });
                await context.SaveChangesAsync(ct);
            }
        })
        .UseSeeding((context, _) =>
        {
            if (!context.Set<User>().Any(u => u.Email == "admin@example.com"))
            {
                context.Set<User>().Add(new User
                {
                    Email = "admin@example.com",
                    PasswordHash = PasswordHasher.Hash("change-me"),
                    CreatedAt = DateTime.UtcNow
                });
                context.SaveChanges();
            }
        }));
```

- **Sie brauchen bedingte oder datenabhaengige Logik.** "Einen Demo-Tenant nur in `Development` seeden" oder "diese Zeilen nur einfuegen, wenn die Tabelle leer ist". Das ist ein gewoehnliches `if`, das `HasData` ueberhaupt nicht ausdruecken kann.

- **Sie fuegen einen Objektgraphen ueber Navigationseigenschaften ein.** Ein Blog mit drei Posts, eine Bestellung mit Positionen oder [eine Many-to-Many-Beziehung](/de/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/). Mit `UseSeeding` bauen Sie den Graphen in C# und ueberlassen `SaveChanges` das Ermitteln der Fremdschluessel. Mit `HasData` muessten Sie jede Join-Zeile von Hand verdrahten.

Der Haken ist der, den die meisten uebersehen: Sie muessen **beide** Ueberladungen implementieren, und die Existenzpruefung liegt bei Ihnen. Die EF-Core-Tools (`dotnet ef database update`) rufen nur das synchrone `UseSeeding` auf; Ihr Laufzeitpfad ruft `UseAsyncSeeding` auf. Implementieren Sie das eine und nicht das andere, dann tut das Seeding aus dem vergessenen Pfad stillschweigend nichts. Fuer die vollstaendigen Mechanismen siehe [wie man Daten mit UseSeeding und UseAsyncSeeding seedet](/de/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/).

## Was tatsaechlich auf der Festplatte passiert

Der klarste Weg, den Unterschied zu sehen, ist zu betrachten, was jedes erzeugt.

`HasData` materialisiert sich in Ihrer Migration. Nach `dotnet ef migrations add SeedStatuses` enthaelt die generierte `Up`-Methode SQL-foermige Aufrufe:

```csharp
// .NET 11, EF Core 11 generated migration
migrationBuilder.InsertData(
    table: "OrderStatuses",
    columns: new[] { "Id", "Name" },
    values: new object[,]
    {
        { 1, "Pending" },
        { 2, "Shipped" },
        { 3, "Delivered" }
    });
```

Die Daten sind nun ein versioniertes Artefakt. Es laeuft einmal, innerhalb der Transaktion der Migration, und EF verfolgt es im Modell-Snapshot, sodass eine spaetere Aenderung ein `UpdateData` erzeugt. Genau deshalb ist ein nicht deterministischer Wert hier Gift: Der Snapshot wuerde nie uebereinstimmen, sodass EF glauben wuerde, das Modell habe sich bei jedem einzelnen Build geaendert.

`UseSeeding` erzeugt nichts auf der Festplatte. Es ist ein Callback, der ausgeloest wird, nachdem das Schema aktuell ist, bei jedem `Migrate`, `EnsureCreated` oder `dotnet ef database update`, einschliesslich Laeufen, bei denen keine Migration angewendet wurde. Da er bedingungslos laeuft, ist die Existenzpruefung kein optionaler Hausputz, sondern das Einzige, was zwischen Ihnen und doppelten Zeilen steht. EF Core 11 schuetzt den Callback mit demselben Migrations-Sperrmechanismus, den es fuer Migrationen verwendet, sodass zwei gleichzeitig startende Anwendungsinstanzen nicht beide den Seed nebenlaeufig ausfuehren, aber die Sperre macht ein fehlendes `if` nicht idempotent.

## Der Haken, der fuer Sie entscheidet

Einige Einschraenkungen ueberstimmen die Praeferenz vollstaendig. Wenn eine davon zutrifft, ist die Entscheidung fuer Sie gefallen:

- **Datenbankgenerierte Schluessel erzwingen `UseSeeding`.** Wenn Sie Primaerschluessel nicht von Hand codieren koennen oder wollen, faellt `HasData` aus. Es hat keine Moeglichkeit, eine Zeile zu seeden, deren Schluessel die Datenbank vergibt.

- **Nicht deterministische oder berechnete Werte erzwingen `UseSeeding`.** Ein gehashtes Passwort, ein Zeitstempel, ein zufaelliges Token: Sobald eines auftaucht, macht `HasData` jeden Build zu einer Phantom-Migration. Das ist der haeufigste Grund, warum Teams `HasData` herausreissen.

- **Eine feste Enum-Tabelle, auf die andere Zeilen zeigen, beguenstigt `HasData`.** Wenn die referenzielle Integritaet davon abhaengt, dass der Seed vor jeglichen echten Daten existiert, wollen Sie ihn innerhalb der Migrationstransaktion, nicht in einem Startup-Callback, der werfen und das Schema halb geseedet zuruecklassen koennte.

- **Ein erforderlicher, datenbankgenerierter Schluessel mit einer `HasData`-Zeile loest einen Fehler aus.** Wenn Sie versuchen, eine Entitaet ueber `HasData` zu seeden, ohne ihren Schluessel anzugeben, wirft EF `The seed entity for entity type 'X' cannot be added because a non-zero value is required for property 'Id'`. Dieser Fehler ist EFs Hinweis, dass Sie den falschen Mechanismus gewaehlt haben: siehe [die Loesung fuer genau diese Meldung](/de/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/).

Sie koennen beide problemlos in einer Anwendung verwenden. Eine gaengige, gesunde Aufteilung: `HasData` fuer die drei Nachschlagetabellen, ohne die Ihr Schema nicht funktionieren kann, und `UseSeeding` fuer die Demo-Daten, den Standard-Admin und alles Tenant-spezifische. Sie geraten nicht in Konflikt, weil sie in verschiedenen Phasen laufen.

## Die Empfehlung, wiederholt

Verwenden Sie standardmaessig `UseSeeding` und `UseAsyncSeeding` in EF Core 11. Sie sind der empfohlene Mechanismus, sie bewaeltigen die dynamischen, schluesselgenerierten, bedingten Daten, die echte Anwendungen tatsaechlich seeden, und sie scheitern laut, statt Ihre Migrationshistorie stillschweigend zu beschaedigen. Reservieren Sie `HasData` fuer den engen Fall, fuer den es umbenannt wurde: kleine, feste, deterministische Referenzdaten mit von Hand vergebenen Schluesseln, die Sie wirklich zusammen mit Ihrem Schema versionieren und diffen wollen.

Die zu vermeidende Falle ist der historische Standard. Jahrelang war `HasData` die einzige eingebaute Option, daher griffen Codebasen reflexartig danach und ertranken dann in Phantom-Migrationen und `PendingModelChangesWarning`. Wenn Sie in EF Core 11 neu beginnen, kehren Sie diesen Instinkt um: `UseSeeding` zuerst, `HasData` nur, wenn Sie benennen koennen, warum die Daten ins Modell gehoeren. Wenn Sie `records`-basierte Entitaeten pflegen, gilt dieselbe Aufteilung sauber, da [Records mit EF Core 11 gut funktionieren](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/) unter beiden Mechanismen.

## Verwandt

- [Wie man Daten mit UseSeeding und UseAsyncSeeding in EF Core 11 seedet](/de/2026/06/how-to-seed-data-with-useseeding-and-useasyncseeding-in-ef-core-11/)
- [Wie man eine Many-to-Many-Beziehung in EF Core 11 seedet](/de/2026/06/how-to-seed-a-many-to-many-relationship-in-ef-core-11/)
- [Loesung: the seed entity cannot be added because a non-zero value is required for property Id](/de/2026/06/fix-the-seed-entity-cannot-be-added-non-zero-value-is-required-for-property/)
- [Migration von EF Core 6 zu EF Core 11: die Breaking Changes, die wirklich beissen](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/)
- [Wie man Records mit EF Core 11 korrekt verwendet](/de/2026/04/how-to-use-records-with-ef-core-11-correctly/)

## Quellen

- [Data Seeding - EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/modeling/data-seeding)
- [What's New in EF Core 9: UseSeeding and UseAsyncSeeding, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-9.0/whatsnew)
- [DbContextOptionsBuilder.UseSeeding, API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.dbcontextoptionsbuilder.useseeding)
