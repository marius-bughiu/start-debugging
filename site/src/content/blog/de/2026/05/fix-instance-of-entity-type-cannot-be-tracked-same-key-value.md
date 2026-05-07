---
title: "Fix: The instance of entity type cannot be tracked because another instance with the same key value is already being tracked"
description: "EF Core 11 wirft diese Ausnahme, wenn zwei Objekte einen Primärschlüssel innerhalb eines DbContext teilen. Lösen Sie das alte Objekt oder aktualisieren Sie es an Ort und Stelle. AsNoTracking auf der Lesung verhindert die Kollision."
pubDate: 2026-05-07
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "change-tracker"
lang: "de"
translationOf: "2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value"
translatedBy: "claude"
translationDate: 2026-05-07
---

Die Behebung: Ein `DbContext` hat bereits eine Entität mit diesem Primärschlüssel im Change Tracker, und Sie haben ihm eine zweite Instanz mit demselben Schlüssel übergeben. Aktualisieren Sie entweder die verfolgte Instanz an Ort und Stelle mit `SetValues`, lösen Sie sie vor dem Anhängen Ihrer eigenen, oder lesen Sie mit `AsNoTracking`, sodass von Anfang an nichts verfolgt wird. Lange laufende Kontexte und das "Laden, dann `Update(newDto)`"-Muster sind die üblichen Verdächtigen.

```text
System.InvalidOperationException: The instance of entity type 'Customer' cannot be tracked because another instance with the same key value for {'Id'} is already being tracked. When attaching existing entities, ensure that only one entity instance with a given key value is attached. Consider using 'DbContextOptions.EnableSensitiveDataLogging' to see the conflicting key values.
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.ThrowIdentityConflict(InternalEntityEntry entry)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.IdentityMap`1.Add(...)
   at Microsoft.EntityFrameworkCore.ChangeTracking.Internal.StateManager.StartTracking(...)
   at Microsoft.EntityFrameworkCore.DbContext.SetEntityState(...)
   at Microsoft.EntityFrameworkCore.DbContext.Update[TEntity](TEntity entity)
```

Dieser Leitfaden ist gegen .NET 11 preview 4 und `Microsoft.EntityFrameworkCore` 11.0.0-preview.4 geschrieben. Das Verhalten ist seit EF Core 2.0 identisch; nur die internen Stack-Trace-Details verschieben sich zwischen Releases. Die Ausnahme stammt aus der Invariante von `IdentityMap<T>`: Ein `DbContext` hält höchstens eine verfolgte Instanz pro `(EntityType, PrimaryKey)`-Paar, und jede zweite Instanz wird sofort abgewiesen.

## Warum die Identity Map existiert

Der Change Tracker von EF Core ist um eine einzige Regel herum aufgebaut: Für jeden Entitätstyp wird jeder Primärschlüsselwert auf höchstens ein CLR-Objekt abgebildet. Diese Regel erlaubt es `SaveChanges`, ohne Mehrdeutigkeit zu entscheiden, ob eine Zeile `Added`, `Modified` oder `Unchanged` ist, und sie macht die Navigation Fix-up funktionsfähig, wenn Sie verbundene Daten in Stücken laden. Zwei Objekte mit demselben Schlüssel würden zwei konkurrierende Antworten auf "Was ist der aktuelle Zustand von Kunde 42?" bedeuten, also weigert sich der Change Tracker, die zweite anzunehmen. Die Ausnahme, die Sie sehen, ist diese Verweigerung, und sie wird ausgelöst, bevor Ihr `SaveChanges`-Aufruf jemals ausgeführt wird, in dem Moment, in dem der `DbContext` den Konflikt während `Attach`, `Update`, `Add` oder einer Operation, die einen Graphen durchläuft, bemerkt.

## Eine minimale Reproduktion

Der Fehlermodus hat fast immer diese Form: Ein HTTP-Handler liest eine Entität, um eine Anfrage zu validieren, erstellt dann dieselbe Entität aus einem DTO neu und bittet EF Core, sie zu aktualisieren.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public record CustomerDto(int Id, string Name, string Email);

public class CustomersController(AppDb db) : ControllerBase
{
    [HttpPut("{id:int}")]
    public async Task<IActionResult> Update(int id, CustomerDto dto)
    {
        var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
        if (existing is null) return NotFound();

        var updated = new Customer
        {
            Id = dto.Id,
            Name = dto.Name,
            Email = dto.Email
        };

        db.Update(updated); // throws: id is already tracked from the read above
        await db.SaveChangesAsync();
        return NoContent();
    }
}
```

Der erste `FirstOrDefaultAsync`-Aufruf hängt `existing` (id 42) im Zustand `Unchanged` an. `db.Update(updated)` versucht dann, ein anderes CLR-Objekt mit id 42 anzuhängen. Der Change Tracker weist es zurück. Der Ausnahmetext erwähnt "another instance with the same key value", was präzise ist, aber an einem müden Nachmittag leicht falsch zu lesen: Die "zwei Instanzen" sind diejenige, die EF Core bereits kennt, und diejenige, die Sie ihm jetzt übergeben.

## Drei Lösungen, geordnet

Wenden Sie sie in dieser Reihenfolge an. Die ersten beiden vermeiden das Problem vollständig; die dritte ist für Fälle, in denen Sie es ehrlich gesagt nicht können.

### 1. Aktualisieren Sie die verfolgte Entität an Ort und Stelle mit SetValues

Wenn Sie die Zeile bereits geladen haben, ist der Change Tracker Ihr Freund. Mutieren Sie die verfolgte Instanz und lassen Sie EF Core das Diff berechnen:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var existing = await db.Customers.FirstOrDefaultAsync(c => c.Id == id);
    if (existing is null) return NotFound();

    db.Entry(existing).CurrentValues.SetValues(dto);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`CurrentValues.SetValues` kopiert übereinstimmende Eigenschaftsnamen vom Quellobjekt auf die verfolgte Entität und markiert nur die Spalten, die sich tatsächlich geändert haben, als `Modified`. Die generierte `UPDATE`-Anweisung berührt nur "schmutzige" Spalten. Dies ist das sauberste Muster für "vorhandene Zeile aus einem DTO bearbeiten", weil es innerhalb der Identity Map bleibt und minimales SQL erzeugt.

### 2. Lesen mit AsNoTracking, dann Update

Wenn Sie die Zeile nur geladen haben, um die Existenz zu prüfen, tun Sie das ohne Tracking:

```csharp
// .NET 11, EF Core 11.0.0
[HttpPut("{id:int}")]
public async Task<IActionResult> Update(int id, CustomerDto dto)
{
    var exists = await db.Customers
        .AsNoTracking()
        .AnyAsync(c => c.Id == id);
    if (!exists) return NotFound();

    var updated = new Customer { Id = dto.Id, Name = dto.Name, Email = dto.Email };
    db.Update(updated);
    await db.SaveChangesAsync();
    return NoContent();
}
```

`AnyAsync` materialisiert keine Entität, also wird nichts verfolgt. `db.Update(updated)` hängt die neue Instanz im Zustand `Modified` an, und EF Core schreibt jede Eigenschaft als einen einzelnen `UPDATE`-Roundtrip. Der Kompromiss gegenüber Lösung 1 ist, dass jede Spalte über die Leitung geschrieben wird, schmutzig oder nicht, weil EF Core keine ursprünglichen Werte zum Vergleichen hat. Für breite Tabellen ist das verschwenderisch; für schmale Tabellen ist es der einfachste Code.

Für umfassendere Muster dazu, was verfolgt wird und was nicht, siehe den Überblick in [der Change Tracker Entries API](/2026/04/efcore-11-changetracker-getentriesforstate/).

### 3. Lösen Sie die vorhandene Entität, dann hängen Sie Ihre an

Wenn Sie die Doppel-Instanz-Situation nicht vermeiden können (ein lange laufender Kontext, eine Drittanbieter-Bibliothek, die hinter Ihrem Rücken lädt), lösen Sie zuerst den konfliktauslösenden Eintrag:

```csharp
// .NET 11, EF Core 11.0.0
public async Task ReplaceCustomer(int id, Customer incoming)
{
    var local = db.ChangeTracker.Entries<Customer>()
        .FirstOrDefault(e => e.Entity.Id == id);

    if (local is not null)
        local.State = EntityState.Detached;

    db.Update(incoming);
    await db.SaveChangesAsync();
}
```

`ChangeTracker.Entries<T>()` ist im Speicher und greift nicht auf die Datenbank zu. Das Setzen von `State = Detached` entfernt den Eintrag aus der Identity Map, was den Schlüssel für die neue Instanz freigibt. Das ist die Notluke, nicht der Standard, denn es zwingt Sie, darüber nachzudenken, welche Instanz "gewinnt", falls anderer Code eine Referenz auf die gelöste hält.

EF Core 11 stellt auch `db.Entry(local.Entity).State = EntityState.Detached` direkt zur Verfügung, wenn Sie das schuldige Objekt bereits zur Hand haben. Beide Formen tun dasselbe: den Eintrag aus der Identity Map ziehen.

## Häufige Formen, die das auslösen

### Ein DbContext, der als Singleton registriert oder in einem Singleton gefangen ist

Die überwiegende Mehrheit der "aber mein Code aktualisiert nur einmal"-Berichte stellt sich als ein Lebensdauer-Mismatch des `DbContext` heraus. Ein `DbContext` ist als `Scoped` gedacht, also einer pro Anfrage. Wenn er als `Singleton` registriert ist (oder in einen injiziert wird), stapelt jede Anfrage Entitäten auf dieselbe Identity Map, und die zweite Aktualisierung desselben Schlüssels wirft die Ausnahme.

```csharp
// Bad: long-lived AppDb captures the change tracker for the lifetime of the host
builder.Services.AddSingleton<AppDb>();

// Good: scoped per request, change tracker resets between requests
builder.Services.AddDbContext<AppDb>(o => o.UseSqlServer(cs));
```

Wenn Sie ehrlich einen Kontext innerhalb eines `Singleton` brauchen (zum Beispiel ein `BackgroundService` oder ein Hangfire-Job), injizieren Sie `IDbContextFactory<AppDb>` und erstellen Sie einen frischen Kontext pro Arbeitseinheit:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

public class CustomerSyncService(IDbContextFactory<AppDb> factory) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            // ... work with db ...
        }
    }
}
```

### Eager geladene Graphen, die auf eine manuell angehängte Entität treffen

Wenn Sie einen Kunden mit seinen Bestellungen eager laden und dann später `Attach(customer)` von woanders versuchen (ein anderes Abfrageergebnis, ein serialisierter Anfragekörper, ein Cache-Treffer), kollidiert der Bestellungsgraph mit allem, was bereits verfolgt wird. Entweder ziehen Sie die Leseseiten-Abfrage auf `AsNoTracking()` herunter, sodass der Graph nicht in der Map ist, oder Sie verwenden `db.Entry(customer).State = EntityState.Modified` nur auf der Wurzel und gehen die Kinder explizit durch.

### Gemockter DbContext in Tests

Wenn Sie einen gemockten `DbContext` zum Schreiben von Tests verwenden, implementiert das Mock oft die Identity Map nicht korrekt, sodass die Produktion auf diesen Fehler trifft und die Tests bestehen. Das Gegenteil passiert auch: Ein echter In-Memory-Provider verfolgt Entitäten, die das Mock nicht verfolgte, und der Test schlägt aus Gründen fehl, die nichts mit dem zu testenden System zu tun haben. Die Behebung ist, gegen einen echten Provider zu testen; der Leitfaden zu [DbContext-Mocking-Fallstricken](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) deckt ab, was das Mock leistet und was nicht.

### EnableSensitiveDataLogging ist Ihr Debugger

Die Ausnahmemeldung sagt "Consider using `DbContextOptions.EnableSensitiveDataLogging` to see the conflicting key values" aus einem Grund. Ohne sie versteckt EF Core den tatsächlichen Primärschlüssel im Fehler, um zu vermeiden, PII in Logs zu lecken. Aktivieren Sie sie lokal, um zu sehen, welche Zeile das Duplikat ist:

```csharp
// .NET 11, EF Core 11.0.0 -- development only
builder.Services.AddDbContext<AppDb>(o => o
    .UseSqlServer(cs)
    .EnableSensitiveDataLogging()
    .EnableDetailedErrors());
```

Versenden Sie das niemals in Produktion; dasselbe Flag wird Parameterwerte bei jedem Befehl in Ihre Logs drucken.

## Varianten, die wie dieser Fehler aussehen, aber keine sind

### "Cannot insert explicit value for identity column"

Andere Ausnahme, andere Ursache: SQL Server lehnt einen Primärschlüssel ungleich Null in einer `IDENTITY`-Spalte ab. Die Behebung ist `SET IDENTITY_INSERT ON` oder, häufiger, den Schlüssel beim Insert nicht zuzuweisen. Der Change Tracker ist nicht beteiligt.

### "An attempt was made to use the model while it was being created"

Das ist ein Startup-Reihenfolge-Bug, typischerweise verursacht durch ein statisches `DbContext`-Feld oder durch Lesen aus dem Modell innerhalb von `OnModelCreating`. Die Identity Map ist auch nicht beteiligt.

### "A second operation was started on this context instance before a previous operation completed"

Das ist Nebenläufigkeit, kein Schlüsselkonflikt. Ein scoped `DbContext` ist nicht thread-sicher; zwei parallele `await`s auf derselben Instanz erzeugen diese Ausnahme. Anderer Fehler, andere Behebung (`IDbContextFactory` wieder, oder serialisieren Sie die Arbeit).

## Verwandt

Für den breiteren EF Core Kontext siehe den Überblick zur [N+1 Query-Erkennung](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), den Leitfaden zu [kompilierten Queries auf Hot Paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) und die Tour durch [Records als EF Core Entitäten](/2026/04/how-to-use-records-with-ef-core-11-correctly/), die ihre eigenen Identity-Map-Fallstricke rund um `with`-Ausdrücke hat. Wenn Sie diesen Fehler im Startup-Code statt in einem Request-Handler treffen, deckt die [DefaultConnection-Suchcheckliste](/2026/05/fix-no-connection-string-named-defaultconnection/) die Konfigurationsseite ab. Für Test-Fixtures, die Ihrem Code eine echte Datenbank übergeben, ist die [Testcontainers-Tour](/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) das sauberste Setup.

## Quellen

- [Tracking and No-Tracking Queries](https://learn.microsoft.com/en-us/ef/core/querying/tracking), EF Core Dokumentation.
- [Change Tracker API](https://learn.microsoft.com/en-us/ef/core/change-tracking/), EF Core Dokumentation.
- [Working with disconnected entity graphs](https://learn.microsoft.com/en-us/ef/core/saving/disconnected-entities), EF Core Dokumentation.
- [`IDbContextFactory<TContext>`-Schnittstelle](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.idbcontextfactory-1), Microsoft Learn.
- [`PropertyValues.SetValues`-Methode](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.changetracking.propertyvalues.setvalues), Microsoft Learn.
