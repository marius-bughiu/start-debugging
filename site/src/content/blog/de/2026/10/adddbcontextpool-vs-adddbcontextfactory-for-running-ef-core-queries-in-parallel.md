---
title: "AddDbContextPool vs AddDbContextFactory: EF Core-Abfragen parallel ausführen"
description: "AddDbContextPool liefert pro DI-Scope genau einen Scoped-DbContext und kann daher nicht zwei Abfragen gleichzeitig ausführen. AddDbContextFactory und AddPooledDbContextFactory liefern pro Aufruf einen Kontext, was parallele Abfragen brauchen. Gemessen mit EF Core 11 RC 1: Die gepoolte Factory erzeugt einen Kontext in 342 ns und 40 B gegenüber 17 us und 44 KB."
pubDate: 2026-10-08
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "dependency-injection"
lang: "de"
translationOf: "2026/10/adddbcontextpool-vs-adddbcontextfactory-for-running-ef-core-queries-in-parallel"
translatedBy: "claude"
translationDate: 2026-10-08
---

Wer EF Core-Abfragen parallel ausführen will, ist mit `AddDbContextPool` allein falsch bedient: Es registriert Ihren `DbContext` als Scoped-Service, sodass alles innerhalb einer Anfrage (eines DI-Scopes) dieselbe Instanz teilt, und ein einzelner `DbContext` kann nicht zwei Operationen gleichzeitig ausführen. `AddDbContextFactory` registriert eine Singleton-`IDbContextFactory<T>`, die pro Aufruf einen frischen Kontext liefert, genau die Form, die `Task.WhenAll` braucht. Wer beides will, registriert `AddPooledDbContextFactory`: dieselbe Factory-API, gestützt auf denselben Pool wie bei `AddDbContextPool`, sodass jeder parallele Zweig seine eigene recycelte Instanz ausleiht.

Alles Folgende wurde mit EF Core 11.0.0-rc.1.26425.128, SDK 11.0.100-rc.1.26425.128 und `Microsoft.EntityFrameworkCore.Sqlite` auf einem Apple M4 gemessen. Dasselbe Testprogramm habe ich mit EF Core 10.0.12 und .NET 10.0.10 erneut ausgeführt: Registrierungen, Wiederverwendungsverhalten und Pool-Größe waren identisch, die Zeiten lagen im selben Bereich (14,3 us und 43 KB pro ungepooltem Kontext, 357 ns und 40 B gepoolt).

## Der Vergleich auf einen Blick

| | `AddDbContextPool<T>` | `AddDbContextFactory<T>` | `AddPooledDbContextFactory<T>` |
| --- | --- | --- | --- |
| Was Sie injizieren | `T` (Scoped) | `IDbContextFactory<T>` (Singleton) | `IDbContextFactory<T>` (Singleton) |
| Registriert `T` auch als Scoped | Ja, es ist der Hauptdienst | Ja | Ja |
| Kontexte pro DI-Scope | 1 | So viele, wie Sie erzeugen | So viele, wie Sie erzeugen |
| Sicher für `Task.WhenAll` in einer Anfrage | Nein | Ja | Ja |
| Instanzen nach `Dispose` wiederverwendet | Ja | Nein | Ja |
| Kosten für Erzeugen + Dispose (gemessen) | n/a über DI-Scope | 17.250 ns, 44.888 B | 342 ns, 40 B |
| Konstruktor darf Scoped-Dienste annehmen | Nein | Ja | Nein |
| `OnConfiguring` läuft | Einmal pro gepoolter Instanz | Bei jeder Instanz | Einmal pro gepoolter Instanz |
| Standard-Pool-Größe | 1024 | n/a | 1024 |

Die Zeile "sicher parallel" ist die, um die es in diesem Beitrag geht, und sie wird durch die Lebensdauer entschieden, nicht durch Pooling. Pooling entscheidet nur, wie teuer jeder Kontext ist.

## Warum ein DbContext nicht zwei Abfragen gleichzeitig ausführen kann

Ein `DbContext` besitzt einen Change Tracker, eine Verbindung und während einer Abfrage einen offenen Data Reader. Nichts davon ist Thread-sicher, und EF Core versucht gar nicht erst, das zu ändern. Stattdessen gibt es einen Concurrency-Detektor, der eine Ausnahme auslöst, sobald eine zweite Operation startet, während die erste noch läuft. Diese Ausnahme habe ich ausführlich im [Beitrag zu "A second operation was started on this context instance"](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/) behandelt, aber die Kurzfassung zählt hier: Parallelität in EF Core bedeutet immer einen Kontext pro gleichzeitiger Operation.

Genau hier stolpern Leute über `AddDbContextPool`. Es klingt, als müsste es bei Nebenläufigkeit helfen ("ein Pool von Kontexten"), aber der Pool wird über Scopes hinweg geteilt, nicht innerhalb eines Scopes. Das hier ist der tatsächliche Inhalt des Containers nach jedem Aufruf, ausgegeben aus einer EF Core 11 RC 1-`ServiceCollection`:

```text
--- AddDbContextPool
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Scoped    IScopedDbContextLease<AppDb>
  Scoped    AppDb
--- AddDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextFactorySource<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
--- AddPooledDbContextFactory
  Singleton IDbContextOptionsConfiguration<AppDb>
  Singleton DbContextOptions<AppDb>
  Singleton IDbContextPool<AppDb>
  Singleton IDbContextFactory<AppDb>
  Scoped    AppDb
```

Bei `AddDbContextPool` ist `AppDb` Scoped und wird über `IScopedDbContextLease<AppDb>` aus dem Pool geleast. Wer es zweimal im selben Scope auflöst, erhält dasselbe Objekt. Im Container gibt es überhaupt keine `IDbContextFactory<AppDb>`, also lässt sich auch kein zweiter Kontext anfordern.

## Die parallele Abfrage, die mit AddDbContextPool fehlschlägt

Das ist die minimale Reproduktion. Ein Controller oder Minimal-API-Endpunkt erhält den Scoped-Kontext und versucht, aufzufächern:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextPool<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (AppDb db) =>
{
    // Both queries use the same pooled instance: this throws.
    var ordersTask = db.Orders.CountAsync();
    var customersTask = db.Customers.CountAsync();
    await Task.WhenAll(ordersTask, customersTask);
    return new { Orders = ordersTask.Result, Customers = customersTask.Result };
});
```

Bei SQL Server oder PostgreSQL, wo die asynchronen Aufrufe beim Warten auf das Netzwerk tatsächlich die Kontrolle abgeben, startet die zweite Abfrage, bevor die erste fertig ist, und EF Core löst eine Ausnahme aus:

```text
InvalidOperationException: A second operation was started on this context instance
before a previous operation completed. This is usually caused by different threads
concurrently using the same instance of DbContext.
```

Zwei Details aus den Tests. Erstens: Die asynchronen Methoden von SQLite laufen synchron zu Ende, die naive Version oben überlappt sich auf SQLite also nicht und "funktioniert", weshalb eine SQLite-basierte Testsuite diesen Fehler schlecht erkennt. Ich musste beide Abfragen in `Task.Run` verpacken, damit sie sich überlappen. Zweitens: Tritt der Wettlauf bei der allerersten Verwendung eines frischen Kontexts auf, erscheint eine andere Meldung, "An attempt was made to use the context instance while it is being configured", weil beide Threads gleichzeitig versuchen, den Kontext zu initialisieren. Derselbe Fehler, dieselbe Lösung.

## Auffächern mit AddDbContextFactory

Die Factory-Variante gibt jedem Zweig eine eigene Instanz:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddDbContextFactory<AppDb>(o => o.UseSqlServer(cs));

app.MapGet("/dashboard", async (IDbContextFactory<AppDb> factory, CancellationToken ct) =>
{
    async Task<int> CountOrders()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Orders.CountAsync(ct);
    }

    async Task<int> CountCustomers()
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Customers.CountAsync(ct);
    }

    var orders = CountOrders();
    var customers = CountCustomers();
    await Task.WhenAll(orders, customers);
    return new { Orders = orders.Result, Customers = customers.Result };
});
```

Jede lokale Funktion erzeugt einen Kontext, führt eine Abfrage aus und gibt ihn wieder frei. Es wird nichts geteilt, also gibt es nichts, worum ein Wettlauf entstehen könnte. In meinem Testprogramm lieferte dieselbe Form mit vier Zweigen (`Task.WhenAll` über vier `CountAsync`-Aufrufe, einer pro Region) bei jedem Lauf `250,250,250,250`.

Beachten Sie, dass `AddDbContextFactory` auch `AppDb` als Scoped registriert hat. Bestehender Code, der `AppDb` direkt injiziert, funktioniert weiter. Sie können also die Registrierung austauschen, ohne jeden Konstruktor der Anwendung anzufassen, und nur die Endpunkte, die auffächern, müssen die Factory annehmen.

## AddPooledDbContextFactory: beides zugleich

`AddDbContextFactory` erzeugt bei jedem Aufruf von `CreateDbContext` einen brandneuen Kontext. Diese Kosten sind neben einem Datenbank-Roundtrip normalerweise klein, summieren sich aber bei einem stark genutzten Endpunkt, der in fünf oder zehn Abfragen auffächert. `AddPooledDbContextFactory` behält die Factory-Form bei und leiht Instanzen stattdessen aus einem Pool:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
builder.Services.AddPooledDbContextFactory<AppDb>(o => o.UseSqlServer(cs));
```

Der aufrufende Code ist identisch mit dem des vorigen Abschnitts, da Sie weiterhin `IDbContextFactory<AppDb>` injizieren. Dahinter steht `PooledDbContextFactory<AppDb>` statt `DbContextFactory<AppDb>`, und `Dispose` gibt die Instanz an den Pool zurück, statt sie wegzuwerfen. Das habe ich direkt geprüft: Kontext erzeugen, freigeben, einen weiteren erzeugen, und `ReferenceEquals` liefert mit der gepoolten Factory `true` und mit der normalen `false`.

Das bringt es, gemessen mit einer einfachen Schleife (200.000 Iterationen für Erzeugen/Freigeben, 20.000 für Erzeugen/Abfragen/Freigeben, aufgewärmt, ein Thread, `GC.GetAllocatedBytesForCurrentThread` für die Allokationen):

| Operation | `AddDbContextFactory` | `AddPooledDbContextFactory` |
| --- | --- | --- |
| `CreateDbContext` + `Model` berühren + `Dispose` | 17.250 ns, 44.888 B | 342 ns, 40 B |
| Erzeugen + `FirstOrDefault` per Schlüssel (SQLite, ohne Tracking) + `Dispose` | 49,7 us, 62.461 B | 20,0 us, 11.710 B |

Das sind Zahlen gegen eine lokale SQLite-Datei, der Datenbankanteil ist also fast kostenlos und der Kontext-Setup dominiert. Gegen einen echten SQL Server über das Netzwerk überdeckt die Abfragezeit die 17 us, weshalb die offizielle Dokumentation Pooling als etwas für "high-performance scenarios" beschreibt. Der Unterschied bei den Allokationen schrumpft mit der Latenz aber nicht: 44 KB Garbage pro Kontext, mal zehn parallele Zweige, mal Ihre Anfragerate, sind echter GC-Druck. Die [EF Core-Dokumentation zu fortgeschrittener Performance](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics) nennt dasselbe Bild gegen SQL Server: 50,38 KB allokiert ohne Pooling gegenüber 4,63 KB mit Pooling.

Dieselbe Dokumentation vermerkt außerdem, dass das Auflösen eines gepoolten Kontexts über DI im Vergleich zum direkten Aufruf der gepoolten Factory "incurs a slight overhead", die Factory ist also auch dann die schnellere der beiden gepoolten Optionen, wenn Sie keine Parallelität brauchen.

## Beides registrieren und einen Pool teilen

Sie müssen sich nicht entscheiden. `AddDbContextPool<AppDb>` gefolgt von `AddPooledDbContextFactory<AppDb>` mit denselben Optionen funktioniert, und beide teilen sich denselben `IDbContextPool<AppDb>`. Ich habe das geprüft, indem ich einen Kontext aus der Factory ausgeliehen, freigegeben und dann `AppDb` aus einem neuen Scope aufgelöst habe: Es war dieselbe Instanz. So kann der Großteil der Anwendung `AppDb` wie gewohnt injizieren, während die wenigen auffächernden Endpunkte die Factory injizieren, ohne zwei Pools zu bezahlen.

Mit EF Core 11 gibt es außerdem eine parameterlose Überladung `AddPooledDbContextFactory<T>()`, die die Konfiguration aus dem `OnConfiguring` des Kontexts liest. Ich habe sie im [Beitrag zu EF Core 11 Preview 3 über RemoveDbContext und die gepoolte Factory](/de/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) beschrieben.

## Nicht der Pool begrenzt die Parallelität, sondern der Connection Pool

Die Standard-`poolSize` beträgt sowohl für `AddDbContextPool` als auch für `AddPooledDbContextFactory` 1024. Diese Zahl ist die maximale Anzahl an Instanzen, die der Pool behält, nicht die maximale Anzahl gleichzeitig lebender Instanzen. Als ich `poolSize: 2` setzte und fünf Kontexte gleichzeitig auslieh, bekam ich fünf verschiedene Instanzen. Nachdem ich alle fünf freigegeben und erneut fünf ausgeliehen hatte, kamen genau zwei aus dem ersten Durchgang zurück. Anders gesagt: Überlauf fällt auf das Erzeugen frischer Kontexte zurück, und die überzähligen werden bei der Rückgabe einfach verworfen. Der Pool blockiert nie.

Die eigentliche Obergrenze für parallele Abfragen ist der darunterliegende ADO.NET Connection Pool. EF Core öffnet eine Verbindung unmittelbar vor jeder Abfrage und schließt sie unmittelbar danach, und jede gleichzeitige Abfrage braucht ihre eigene Verbindung. `Microsoft.Data.SqlClient` verwendet standardmäßig `Max Pool Size=100`, und auch Npgsql hat den Standardwert 100. Wer pro Anfrage 20 Abfragen auffächert und 10 gleichzeitige Anfragen hat, wartet bereits auf Verbindungen, was sich als Timeout beim Beschaffen einer Verbindung aus dem Pool zeigt und nicht als EF-Fehler. Wenn Sie über eine Liste von IDs auffächern, begrenzen Sie den Grad der Parallelität mit `Parallel.ForEachAsync`, statt alles auf einmal an `Task.WhenAll` zu übergeben. Die Abwägungen stehen in [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/de/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
await Parallel.ForEachAsync(regionIds,
    new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = ct },
    async (regionId, token) =>
    {
        await using var db = await factory.CreateDbContextAsync(token);
        totals[regionId] = await db.Orders
            .Where(o => o.RegionId == regionId)
            .SumAsync(o => o.Total, token);
    });
```

`totals` sollte hier ein `ConcurrentDictionary<int, decimal>` oder ein vorab dimensioniertes Array sein, da der Schleifenrumpf nebenläufig läuft.

## Stolperfallen, die nur die gepoolten Varianten betreffen

### Scoped-Konstruktorabhängigkeiten werden vom Root Provider aufgelöst

Das hat mich überrascht. Ein gepoolter Kontext wird einmal erzeugt und über Scopes hinweg wiederverwendet, seine Konstruktorabhängigkeiten können also nicht aus dem Anfrage-Scope stammen. In EF Core 11 RC 1 verhält sich ein gepoolter Kontext mit einem Konstruktor wie `TenantDb(DbContextOptions<TenantDb> options, Tenant tenant)`, wobei `Tenant` Scoped ist, so:

- Bei aktivierter Scope-Validierung (Standard in der Umgebung `Development`) löst das Auflösen `InvalidOperationException: Cannot resolve scoped service 'Tenant' from root provider.` aus.
- Bei deaktivierter Scope-Validierung (Standard in `Production`) gelingt es stillschweigend. Der Kontext erhält eine `Tenant`-Instanz vom Root Provider, die nicht mit dem `Tenant` übereinstimmt, den der Anfrage-Scope auflöst, und dieselbe erfasste Instanz begleitet den gepoolten Kontext in jede spätere Anfrage.

Der Fehler, den man lokal nie sieht, wird in Produktion also zu einem mandantenübergreifenden Datenleck. Die einfache `AddDbContextFactory` hat dieses Problem nicht, weil sie jedes Mal einen neuen Kontext baut. Wenn Sie Zustand pro Anfrage mit Pooling brauchen, ist das dokumentierte Muster eine Scoped-Wrapper-Factory, die bei der gepoolten Factory ausleiht und eine Eigenschaft setzt:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1
public sealed class TenantDbFactory(
    IDbContextFactory<TenantDb> pooled, ITenant tenant) : IDbContextFactory<TenantDb>
{
    public TenantDb CreateDbContext()
    {
        var db = pooled.CreateDbContext();
        db.TenantId = tenant.Id; // reset on every rent, never trust the previous value
        return db;
    }
}

builder.Services.AddPooledDbContextFactory<TenantDb>(o => o.UseSqlServer(cs));
builder.Services.AddScoped<TenantDbFactory>();
```

Dieselbe Falle, Scoped in Singleton, gibt es auch außerhalb von EF; [der Beitrag zu "Cannot consume scoped service from singleton"](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) erklärt, warum der Container sie ablehnt.

### Eigene Felder werden nicht zurückgesetzt

EF Core setzt seinen eigenen Zustand zurück, wenn ein gepoolter Kontext zurückgegeben wird: Der Change Tracker wird geleert (ich habe eine Entität hinzugefügt, freigegeben, erneut ausgeliehen, und `ChangeTracker.Entries()` war leer). Felder und Eigenschaften, die Sie Ihrer `DbContext`-Unterklasse hinzugefügt haben, werden nicht angefasst. Ein `public string? Note`, das ich vor dem Freigeben auf `"dirty"` gesetzt hatte, war beim nächsten Ausleihen immer noch `"dirty"`. Alles, was pro Anfrage gilt, muss bei jedem Ausleihen zugewiesen werden, wie im Wrapper oben. Dasselbe gilt für eine `DbConnection`, die Sie manuell geöffnet haben: Schließen Sie sie, bevor der Kontext zurückgeht.

### OnConfiguring läuft nur einmal

Da die Instanz wiederverwendet wird, läuft `OnConfiguring` nur beim ersten Erzeugen einer gepoolten Instanz. Lesen Sie dort nicht den aktuellen Benutzer, Mandanten oder die Kultur.

### Dispose gibt die Instanz zurück

Bei der gepoolten Factory wird ein Kontext, den Sie nicht freigeben, nie zurückgegeben. Das ist kein Leck im klassischen Sinn, da der GC ihn weiterhin einsammelt, aber Sie verlieren den Pooling-Vorteil, und der Pool füllt sich unbemerkt mit frischen Instanzen. Verwenden Sie immer `await using`.

## Wann was zu wählen ist

- **Nur sequenzielle Abfragen, gewöhnliche Anwendung**: `AddDbContext` oder `AddDbContextPool`. `AppDb` injizieren, jede Abfrage nacheinander abwarten. Pooling ist ein günstiger Gewinn, wenn Ihr Kontext keine Konstruktorabhängigkeiten und keinen Zustand pro Anfrage hat.
- **Einige Endpunkte fächern parallel auf**: `AddPooledDbContextFactory` registrieren (oder `AddDbContextPool` plus `AddPooledDbContextFactory` mit denselben Optionen). `AppDb` injizieren, wo sequenziell gearbeitet wird, und `IDbContextFactory<AppDb>`, wo aufgefächert wird.
- **Der Kontext braucht Scoped-Dienste im Konstruktor**: `AddDbContextFactory`, ungepoolt. Oder den Zustand in eine Eigenschaft verlagern, die ein Scoped-Wrapper setzt, und das Pooling behalten.
- **Singletons, Hosted Services, Blazor Server-Komponenten**: die Factory, aus den Gründen in [IDbContextFactory aus einem Singleton in Blazor verwenden](/de/2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor/). Gepoolt, wenn der Kontext es erlaubt.

Eine letzte Alternative, falls Sie bereits `AddDbContextPool` nutzen und keine zweite Registrierung wollen: Erzeugen Sie pro parallelem Zweig mit `IServiceScopeFactory.CreateAsyncScope()` einen Child-Scope und lösen Sie `AppDb` daraus auf. Jeder Scope least seine eigene gepoolte Instanz, und mein Test mit vier Zweigen lieferte wieder `250,250,250,250`. Das funktioniert, ist aber mehr Aufwand als die Factory zu injizieren, und jeder Zweig löst zudem alles andere in diesem Scope auf.

Die Faustregel: Parallelität braucht einen Kontext pro Operation, und nur die beiden Factories liefern das direkt. Pooling ist eine unabhängige Entscheidung darüber, wie günstig jeder dieser Kontexte ist, und in EF Core 11 macht die gepoolte Factory das Erzeugen etwa 50-mal günstiger, solange Ihr Kontext keinen Zustand pro Anfrage im Konstruktor trägt.

## Quellen

- [Advanced Performance Topics: DbContext pooling (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [DbContext Lifetime, Configuration, and Initialization: using a DbContext factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/)
- [`EntityFrameworkServiceCollectionExtensions` API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions)
- [Sample: AspNetContextPoolingWithState (dotnet/EntityFramework.Docs)](https://github.com/dotnet/EntityFramework.Docs/tree/main/samples/core/Performance/AspNetContextPoolingWithState)
- [SQL Server connection pooling (ADO.NET)](https://learn.microsoft.com/en-us/sql/connect/ado-net/sql-server-connection-pooling)
