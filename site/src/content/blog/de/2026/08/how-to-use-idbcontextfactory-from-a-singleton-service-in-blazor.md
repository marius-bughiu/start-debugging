---
title: "IDbContextFactory<T> aus einem Singleton-Service in Blazor verwenden"
description: "Ein Singleton kann keinen DbContext injizieren, wohl aber IDbContextFactory<T>, denn AddDbContextFactory registriert die Factory standardmäßig als Singleton. Erzeugen und entsorgen Sie einen Kontext pro Aufruf und speichern Sie die Instanz niemals."
pubDate: 2026-08-16
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "blazor"
  - "ef-core"
  - "dependency-injection"
lang: "de"
translationOf: "2026/08/how-to-use-idbcontextfactory-from-a-singleton-service-in-blazor"
translatedBy: "claude"
translationDate: 2026-08-16
---

Ein Singleton-Service kann keinen `DbContext` im Konstruktor entgegennehmen: `AddDbContext<T>` registriert den Kontext als scoped, und die Scope-Validierung von ASP.NET Core lehnt die Erfassung bereits beim Start ab. `IDbContextFactory<T>` kann er entgegennehmen, denn `AddDbContextFactory<T>` registriert die Factory standardmäßig als **Singleton**. Injizieren Sie die Factory, rufen Sie `CreateDbContextAsync` in jeder Methode auf, umschließen Sie das Ergebnis mit `await using`, und legen Sie den zurückgegebenen Kontext niemals in einem Feld ab. Diese letzte Regel ist der entscheidende Punkt: Ein Singleton in Blazor wird von jedem Circuit auf dem Server geteilt, ein zwischengespeicherter Kontext wird also von mehreren Benutzern gleichzeitig getroffen, und EF Core beschädigt seinen Zustand oder wirft eine Ausnahme.

Diese Anleitung bezieht sich auf .NET 11 und EF Core 11. Alles hier gilt unverändert auch für .NET 6, 8 und 10, denn `IDbContextFactory<T>` hat seit EF Core 5.0 dieselbe Registrierungsform. Die Registrierungs-Dumps und Fehlermeldungen unten entstanden mit dem SDK .NET 10.0.201 und `Microsoft.EntityFrameworkCore.Sqlite` 10.0.11, dem Runtime, das beim Schreiben installiert war.

## Warum ein Blazor-Singleton der ungünstigste Fall für DbContext ist

Serverseitiges Blazor hält pro verbundenem Benutzer einen *Circuit*. Dieser Circuit ist ein einzelner, langlebiger DI-Scope, der so lange lebt wie der Browser-Tab und nicht so lange wie eine HTTP-Anfrage. Microsofts eigene Anleitung zu EF Core mit Blazor benennt alle drei Standard-Lebensdauern als ungeeignet für einen `DbContext`: Singleton teilt eine Instanz über alle Benutzer hinweg, Scoped teilt eine Instanz über alle Komponenten im Circuit eines Benutzers, und Transient erzeugt Kontexte, die so lange leben wie die Komponente, die sie hält.

Singleton ist der schlechteste der drei, und man landet leicht versehentlich dort. Ein Katalog-Cache, ein Service für Nachschlagetabellen, ein `IHostedService`, der Referenzdaten aktualisiert, ein `IEmailSender`, der eine Audit-Zeile schreibt: All das sind von Natur aus Singletons, alle wollen Datenbankzugriff, und keiner davon darf einen `DbContext` halten.

Die Scope-Validierung fängt die naive Variante beim Start ab. Den Kontext normal zu registrieren und in ein Singleton zu injizieren lässt `BuildServiceProvider` mit `ValidateOnBuild` scheitern:

```text
Error while validating the service descriptor 'ServiceType: BadWarmer Lifetime: Singleton
ImplementationType: BadWarmer': Cannot consume scoped service 'AppDb' from singleton 'BadWarmer'.
```

Das ist dieselbe Prüfung auf Captive Dependencies, die in gewöhnlichen ASP.NET Core-Anwendungen den [Fehler beim Konsumieren eines scoped Service aus einem Singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) erzeugt. Die Factory ist der vorgesehene Ausweg.

## Was AddDbContextFactory tatsächlich registriert

Dass ein Singleton die Factory injizieren kann, ist keine Konvention, sondern der deklarierte Standardwert. Die Signatur lautet:

```csharp
// EF Core 11, Microsoft.Extensions.DependencyInjection
public static IServiceCollection AddDbContextFactory<TContext>(
    this IServiceCollection serviceCollection,
    Action<DbContextOptionsBuilder>? optionsAction = null,
    ServiceLifetime lifetime = ServiceLifetime.Singleton)
    where TContext : DbContext;
```

`lifetime` hat den Standardwert `ServiceLifetime.Singleton` und steuert "die Lebensdauer, mit der die Factory **und die Optionen** registriert werden". Ein Dump der Service-Deskriptoren, die ein einzelner Aufruf von `AddDbContextFactory<AppDb>` hinzufügt, macht die Form greifbar:

```text
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.DbContextOptions
Singleton  Microsoft.EntityFrameworkCore.Internal.IDbContextFactorySource`1[AppDb]
Singleton  Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]
Scoped     AppDb
```

Zwei Dinge sind bemerkenswert.

Erstens ist `IDbContextFactory<AppDb>` ein Singleton, das Injizieren in ein eigenes Singleton besteht die Scope-Validierung also problemlos. Die konkret aufgelöste Implementierung ist die in EF Core eingebaute `DbContextFactory<TContext>`.

Zweitens, und das überrascht viele: `AddDbContextFactory` **registriert zusätzlich den Kontexttyp selbst als scoped**. Das ist dokumentiertes Verhalten, kein Leck. Die API-Anmerkungen sagen es unmissverständlich: "For convenience, this method also registers the context type itself as a scoped service. This allows a context instance to be resolved from a dependency injection scope directly or created by the factory, as appropriate." Nach einem Aufruf von `AddDbContextFactory` kompiliert `@inject AppDb Db` also weiterhin und funktioniert in einer Komponente auch. In Blazor ist das eine Falle, denn diese scoped Instanz gehört zum Circuit und wird von allen Komponenten im Tab geteilt. Die Registrierung der Factory hindert niemanden daran, den Kontext auf die falsche Weise zu injizieren.

## In vier Schritten einrichten

1. Registrieren Sie die Factory in `Program.cs` und belassen Sie die Lebensdauer beim Standardwert. Übergeben Sie nicht `ServiceLifetime.Scoped`, denn das ist der häufigste Weg, diesen Ansatz zu zerstören.

   ```csharp
   // .NET 11, EF Core 11
   builder.Services.AddDbContextFactory<CatalogDb>(options =>
       options.UseSqlServer(builder.Configuration.GetConnectionString("Catalog")));

   builder.Services.AddSingleton<CatalogCache>();
   ```

2. Stellen Sie am Kontext den Konstruktor mit `DbContextOptions<TContext>` bereit, genau wie bei `AddDbContext`. Die Factory reicht die Optionen über diesen Konstruktor durch, ein Kontext mit ausschließlich parameterlosem Konstruktor lässt sich also nicht erzeugen.

   ```csharp
   public sealed class CatalogDb(DbContextOptions<CatalogDb> options) : DbContext(options)
   {
       public DbSet<Product> Products => Set<Product>();
   }
   ```

3. Injizieren Sie `IDbContextFactory<TContext>` in das Singleton und erzeugen Sie pro Methodenaufruf einen Kontext. Verwenden Sie `CreateDbContextAsync` und `await using`, damit die asynchrone Entsorgung über den eigenen Pfad des Providers läuft.

   ```csharp
   public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
   {
       public async Task<List<Product>> GetActiveAsync(CancellationToken ct = default)
       {
           await using var db = await factory.CreateDbContextAsync(ct);
           return await db.Products
               .AsNoTracking()
               .Where(p => p.IsActive)
               .ToListAsync(ct);
       }
   }
   ```

4. Schalten Sie die Scope-Validierung in jeder Umgebung ein, damit ein späteres Refactoring, das einen erfassten `DbContext` wieder einführt, beim Start scheitert und nicht um 3 Uhr nachts unter Last.

   ```csharp
   builder.Host.UseDefaultServiceProvider(options =>
   {
       options.ValidateScopes = true;
       options.ValidateOnBuild = true;
   });
   ```

Die Kontexte, die die Factory liefert, gehören **nicht** dem DI-Container. Die EF Core-Dokumentation ist eindeutig: So erzeugte Instanzen "are not managed by the application's service provider and therefore must be disposed by the application". Das `await using` in Schritt 3 ist keine optionale Höflichkeit; ohne es lecken Sie Verbindungen für die gesamte Prozesslaufzeit.

## Was wirklich kaputtgeht, wenn Sie den Kontext zwischenspeichern

Die verlockende Abkürzung besteht darin, im Konstruktor des Singletons einen Kontext zu erzeugen und ihn wiederzuverwenden. In der Entwicklung sieht das harmlos aus, weil Sie der einzige Benutzer sind. Hier derselbe `CatalogCache` mit einem einzigen Kontext, getroffen von 25 gleichzeitigen Aufrufern auf echten Threads:

```csharp
// Do not do this. One context, shared by every circuit on the server.
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    private readonly CatalogDb _shared = factory.CreateDbContext();

    public Task<int> CountAsync() => _shared.Products.CountAsync();
}
```

Drei Läufe hintereinander auf EF Core 10.0.11 ergaben drei verschiedene Ergebnisse, zwei davon unterschiedliche Ausnahmen:

```text
run 1: InvalidOperationException: A second operation was started on this context instance
       before a previous operation completed. This is usually caused by different threads
       concurrently using the same instance of DbContext.
run 2: InvalidOperationException: ExecuteReader can only be called when the connection is open.
run 3: InvalidOperationException: A second operation was started on this context instance ...
```

Genau dieser Nichtdeterminismus ist der Punkt. Die Thread-Sicherheitsprüfung von EF Core liefert die freundliche erste Meldung, wenn sie das Rennen gewinnt, aber sie gewinnt nicht immer: Der zweite Lauf brachte einen rohen Verbindungszustandsfehler aus ADO.NET hervor, weil sich zwei Operationen auf derselben Verbindung bereits verschränkt hatten. Bei anderem Timing liefert derselbe Fehler stillschweigend falsche Daten, statt überhaupt etwas zu werfen. Früher in meinen Tests lieferten 25 Tasks, die zufällig synchron abliefen, alle das richtige Ergebnis und warfen nichts, und genau deshalb erreicht dieser Fehler die Produktion.

Mit einem Kontext pro Aufruf gelangen dieselben 25 gleichzeitigen Aufrufe mit identischen Ergebnissen. Das ist kein raffinierter Code, sondern nur die ehrlich angewendete [Regel einer einzigen Unit of Work](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/).

Dieselbe Überlegung erklärt, warum das Erfassen eines Kontexts in einem losgelösten Task eine [ObjectDisposedException auf einer bereits entsorgten Kontextinstanz](/de/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) erzeugt: Beide Fehler entstehen dadurch, dass ein Kontext die Operation überlebt, die ihn brauchte.

## Die Überladung, die das Muster unbemerkt zerstört

`AddDbContextFactory` nimmt ein optionales `lifetime` entgegen. `ServiceLifetime.Scoped` zu übergeben ist ein oft kopierter Ratschlag, meist aus einem mandantenfähigen Beispiel übernommen, in dem der Verbindungsstring pro Anfrage aufgelöst wird. Es ändert die Registrierung der Factory und führt genau die Captive Dependency wieder ein, die Sie vermeiden wollten:

```csharp
// This compiles, then fails at startup once a singleton consumes the factory.
builder.Services.AddDbContextFactory<CatalogDb>(
    options => options.UseSqlServer(connectionString),
    lifetime: ServiceLifetime.Scoped);
```

```text
Error while validating the service descriptor 'ServiceType: CacheWarmer Lifetime: Singleton
ImplementationType: CacheWarmer': Cannot consume scoped service
'Microsoft.EntityFrameworkCore.IDbContextFactory`1[AppDb]' from singleton 'CacheWarmer'.
```

Wenn Sie tatsächlich einen Verbindungsstring pro Circuit brauchen, machen Sie die Factory nicht scoped, um sie dann aus einem Singleton zu konsumieren. Belassen Sie die Factory als Singleton und übergeben Sie den Mandanten explizit, oder lösen Sie die mandantenspezifische Factory innerhalb der Methode über `IServiceScopeFactory` auf. Damit sind wir bei der eigentlichen Grenze dieses Musters.

## Ein Singleton hat keinen Circuit, also auch keinen Benutzer

Das ist die Einschränkung, an die man als Zweites stößt, nachdem die Verdrahtung stimmt. Ein Singleton wird einmal für den gesamten Server erzeugt. Es hat keinen `AuthenticationStateProvider`, keinen circuit-gebundenen Mandanten-Resolver und keinen `HttpContext`. Alle `DbContextOptions`, die aus dem umgebenden Benutzer berechnet werden, existieren zum Ausführungszeitpunkt des Singletons schlicht nicht.

Konkret funktioniert das nicht:

```csharp
// The singleton has no circuit, so there is no current user to read here.
builder.Services.AddDbContextFactory<CatalogDb>((sp, options) =>
    options.UseSqlServer(sp.GetRequiredService<ITenantContext>().ConnectionString));
```

Wenn die Daten, die Ihr Singleton berührt, wirklich benutzerspezifisch sind, ist das Singleton der falsche Ort dafür. Verlagern Sie die Arbeit entweder in einen scoped Service, den die Komponente aufruft, oder übergeben Sie die Mandantenidentität als Methodenparameter und wählen Sie den Verbindungsstring selbst aus:

```csharp
public sealed class CatalogCache(IDbContextFactory<CatalogDb> factory)
{
    public async Task<int> CountForAsync(string tenantId, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Products.CountAsync(p => p.TenantId == tenantId, ct);
    }
}
```

Referenzdaten, Nachschlagetabellen und mandantenübergreifende Aggregate passen gut zu einem Singleton mit Factory. Alles, was am "aktuellen Benutzer" hängt, passt nicht. Wenn Sie vor allem deshalb zu einem Singleton greifen, um wiederholte Abfragen zu vermeiden, ist ein Cache das bessere Primitiv, und [HybridCache gegenüber IMemoryCache und IDistributedCache](/de/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) behandelt die Auswahl.

## Wann stattdessen die gepoolte Factory sinnvoll ist

`AddPooledDbContextFactory<TContext>` registriert ebenfalls eine Singleton-`IDbContextFactory<TContext>`, gestützt auf `PooledDbContextFactory<TContext>`, mit einem `poolSize`, dessen Standardwert ab EF Core 6 bei 1024 liegt (in EF Core 5.0 waren es 128). Das Entsorgen eines gepoolten Kontexts setzt ihn zurück und gibt ihn an den Pool zurück, statt ihn zu verwerfen, was Allokationen auf heißen Pfaden messbar senkt.

Verifiziertes Verhalten auf EF Core 10.0.11: Einen Kontext erzeugen, entsorgen und einen weiteren erzeugen liefert **dieselbe** Instanz, und ein Zugriff auf den ersten nach dem Entsorgen wirft `ObjectDisposedException`. Der Pool recycelt also tatsächlich, und die Verwendung nach dem Entsorgen wird weiterhin erkannt.

Zwei Vorbehalte vor dem Umstieg:

- Die gepoolten Überladungen nehmen keinen `lifetime`-Parameter, und `optionsAction` ist verpflichtend statt optional. Die Konfiguration muss extern erfolgen, denn `OnConfiguring` wird bei gepoolten Kontexten überhaupt nicht aufgerufen.
- Gepoolte Kontexte können keine beliebigen Services im Konstruktor injiziert bekommen, weil die Instanz über unzusammenhängende Operationen hinweg wiederverwendet wird. Jeder Zustand, den Sie am Kontext ablegen, überlebt bis zum nächsten Aufrufer, sofern EF Core ihn nicht zurücksetzt.

Für ein Singleton mit hochfrequenten kurzen Lesezugriffen ist die gepoolte Factory der bessere Standard. Für ein Singleton mit gelegentlicher Arbeit ist die einfache Factory schlichter, und der Allokationsunterschied taucht in keinem Profil auf. Liegt der heiße Pfad bei den Abfragen selbst und nicht bei der Kontexterzeugung, sind [kompilierte Abfragen für heiße EF Core-Pfade](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) der größere Hebel.

## Rendermodi, WebAssembly und Hintergrunddienste

Drei Grenzfälle sind es wert, benannt zu werden, denn sie verändern, wo das Singleton lebt.

**Interactive WebAssembly und Auto als Rendermodus.** Ein in der `Program.cs` des Serverprojekts registriertes Singleton existiert nur auf dem Server. Komponenten, die auf dem Client laufen, haben ihren eigenen Service-Provider im WebAssembly-Projekt, und ein `DbContext` kann aus der Browser-Sandbox heraus überhaupt keine Datenbankverbindung öffnen. Wechselt eine Komponente von interactive server zu interactive WebAssembly, ist das Singleton, von dem sie abhing, clientseitig stillschweigend nicht mehr auflösbar. Diese Grenze ist dieselbe, die hinter dem [Zustandsproblem zwischen statischem und interaktivem Rendering in Blazor](/de/2026/06/how-to-persist-state-across-the-blazor-static-to-interactive-render-boundary-in-dotnet-11/) steht.

**Statisches SSR und Prerendering.** Beim statischen serverseitigen Rendering gibt es keinen Circuit, der Root-Provider der Anwendung existiert aber weiterhin, ein Singleton mit Factory funktioniert also normal. Das ist eines der wenigen Datenbankmuster, das sich bei statischem SSR, Prerendering und interaktivem Serverrendering identisch verhält, was ein echtes Argument dafür ist.

**BackgroundService.** `AddHostedService<T>` registriert ein Singleton, ein Hosted Service mit Datenbedarf hat also exakt dasselbe Problem und exakt dieselbe Lösung. Injizieren Sie `IDbContextFactory<T>`, wenn die Arbeit reiner Datenzugriff ist; greifen Sie zu `IServiceScopeFactory`, wenn die Unit of Work mehrere scoped Services zusammen benötigt, was in [scoped Services innerhalb eines BackgroundService verwenden](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) behandelt wird.

Das Muster ist knapp genug für einen Satz: Singletons dürfen Factories halten, niemals Kontexte. Alles andere in diesem Artikel folgt daraus.

## Quellen

- [DbContext Lifetime, Configuration, and Initialization](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/), EF Core-Dokumentation, zu `AddDbContextFactory` und der Entsorgung nicht verwalteter Kontexte.
- [ASP.NET Core Blazor with Entity Framework Core](https://learn.microsoft.com/en-us/aspnet/core/blazor/blazor-ef-core), zu Circuits und dazu, warum Singleton, Scoped und Transient alle ungeeignet für einen `DbContext` sind.
- [EntityFrameworkServiceCollectionExtensions.AddDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.adddbcontextfactory), zum Standardwert `ServiceLifetime.Singleton` und zur scoped Registrierung des Kontexttyps.
- [EntityFrameworkServiceCollectionExtensions.AddPooledDbContextFactory](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.entityframeworkservicecollectionextensions.addpooleddbcontextfactory), zum Standardwert von `poolSize` und zum Vorbehalt bei `OnConfiguring`.
