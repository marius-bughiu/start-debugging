---
title: "So wärmen Sie das EF-Core-Modell vor der ersten Abfrage auf"
description: "EF Core baut sein konzeptionelles Modell träge beim ersten DbContext-Zugriff auf, weshalb die erste Abfrage in einem frisch gestarteten Prozess mehrere hundert Millisekunden langsamer ist als jede weitere. Dieser Leitfaden behandelt die drei realen Lösungen in EF Core 11: einen Start-IHostedService, der Model berührt und eine Verbindung öffnet, dotnet ef dbcontext optimize zum Ausliefern eines vorkompilierten Modells, und die Cache-Key-Fußangeln, die das Modell trotzdem stillschweigend neu aufbauen."
pubDate: 2026-04-27
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "dotnet-11"
  - "performance"
  - "startup"
  - "csharp"
lang: "de"
translationOf: "2026/04/how-to-warm-up-ef-core-model-before-the-first-query"
translatedBy: "claude"
translationDate: 2026-04-29
---

Die erste Abfrage durch einen frisch erstellten `DbContext` ist die langsamste, die Ihre Anwendung je ausführen wird, und sie hat nichts mit der Datenbank zu tun. EF Core baut sein internes Modell nicht beim Hoststart auf. Es wartet, bis zum ersten Mal etwas `DbContext.Model` liest, eine Abfrage ausführt, `SaveChanges` aufruft oder auch nur ein `DbSet` aufzählt. An diesem Punkt führt es die gesamte Konventionenpipeline gegen Ihre Entitätstypen aus, was bei einem 50-Entitäten-Modell mit Beziehungen, Indizes und Value Convertern 200 bis 500 ms dauern kann. Folgekontexte im selben Prozess bekommen das gecachte Modell in unter 1 ms. Dieser Leitfaden zeigt die drei Lösungen, die die Zahl in EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.0, .NET 11, C# 14) tatsächlich bewegen: ein explizites Aufwärmen beim Start, ein vorkompiliertes Modell, das `dotnet ef dbcontext optimize` erzeugt, und die Modell-Cache-Key-Fußangeln, die beide oben genannten leise aushebeln.

## Warum die erste Abfrage langsam ist, auch wenn die Datenbank warm ist

`DbContext.Model` ist eine `IModel`-Instanz, die von der Konventionenpipeline gebaut wird. Die Konventionen sind dutzende `IConvention`-Implementierungen (Beziehungserkennung, Schlüsselableitung, Owned-Type-Erkennung, Fremdschlüsselbenennung, Value-Converter-Auswahl, JSON-Spaltenmapping und so weiter), die jede Eigenschaft jedes Entitätstyps und jede Navigation durchlaufen. Die Ausgabe ist ein unveränderlicher Modellgraph, den EF Core dann für die Lebensdauer des Prozesses unter einem Schlüssel hält, den `IModelCacheKeyFactory` erzeugt.

In einer Standardregistrierung `AddDbContext<TContext>` passiert diese Arbeit träge. Die Laufzeitsequenz beim Kaltstart sieht so aus:

1. Der Host startet. `IServiceProvider` wird gebaut. `TContext` ist als scoped registriert. Modellbezogenes ist noch nichts gelaufen.
2. Die erste HTTP-Anfrage kommt herein. Der DI-Container löst einen `TContext` auf. Sein Konstruktor speichert `DbContextOptions<TContext>` und kehrt zurück. Modellbezogenes ist immer noch nichts gelaufen.
3. Ihr Handler schreibt `await db.Blogs.ToListAsync()`. EF Core dereferenziert `Set<Blog>()`, was `Model` liest, was die Konventionenpipeline auslöst. Hier liegen die 200 bis 500 ms.
4. Die Abfrage wird dann kompiliert (LINQ-zu-SQL-Übersetzung, Parameterbindung, Executor-Caching), was weitere 30 bis 80 ms hinzufügt.
5. Die Abfrage trifft schließlich die Datenbank.

Schritte 3 und 4 passieren nur einmal pro Prozess pro `DbContext`-Typ. Die fünfte Anfrage durch denselben Kontexttyp sieht beide Kosten als null. Deshalb reproduziert sich "erste Anfrage langsam, alle weiteren schnell" so sauber und deshalb können Sie es mit Datenbank-Tuning nicht abschütteln. Die Arbeit ist in Ihrem Prozess, nicht auf der Leitung.

Wenn Sie eine Stoppuhr um zwei aufeinanderfolgende Abfragen in einem frisch gestarteten Prozess legen, sehen Sie die Asymmetrie direkt:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
var sw = Stopwatch.StartNew();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"first:  {sw.ElapsedMilliseconds} ms");

sw.Restart();
await using (var db = new BloggingContext(options))
{
    _ = await db.Blogs.AsNoTracking().FirstOrDefaultAsync(b => b.Id == 1);
}
Console.WriteLine($"second: {sw.ElapsedMilliseconds} ms");
```

Auf einem Demo-Modell mit 30 Entitäten gegen SQL Server 2025 mit EF Core 11.0.0 auf einem warmen Laptop druckt die erste Iteration etwa `380 ms` und die zweite etwa `4 ms`. Der Modellaufbau dominiert. Wenn derselbe Code gegen ein kaltes AWS Lambda läuft, bei dem der Host pro Invocation hochgefahren wird, landen diese 380 ms direkt in der nutzersichtbaren p99-Latenz, was genau die Klasse von Problem ist, die in [Kaltstartzeit eines .NET 11 AWS Lambda reduzieren](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/) behandelt wird.

## Lösung eins: Modell beim Start mit IHostedService aufwärmen

Die billigste Lösung verschiebt die Kosten von "erste Anfrage" auf "Hoststart", ohne irgendeinen Produktionscodepfad zu ändern. Registrieren Sie einen `IHostedService`, dessen einzige Aufgabe es ist, einen Kontext aufzulösen, das Modell zur Materialisierung zu zwingen und sich zu beenden. Der Host blockiert in `StartAsync`, bevor er den Listening-Socket öffnet, sodass zu dem Zeitpunkt, an dem Kestrel eine Anfrage annimmt, die Konventionenpipeline bereits gelaufen ist und das gecachte `IModel` in der Options-Instanz sitzt.

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class EfCoreWarmup(IServiceProvider sp, ILogger<EfCoreWarmup> log) : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        await using var scope = sp.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<BloggingContext>();

        // Forces the conventions pipeline to run and the IModel to be cached.
        _ = db.Model;

        // Forces the relational connection-string parsing and the SqlClient pool
        // to allocate one physical connection. ADO.NET keeps it warm in the pool.
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();

        log.LogInformation("EF Core warm-up done in {Elapsed} ms", sw.ElapsedMilliseconds);
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Hängen Sie das nach `AddDbContext` ein:

```csharp
// Program.cs, .NET 11, ASP.NET Core 11
builder.Services.AddDbContext<BloggingContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Db")));
builder.Services.AddHostedService<EfCoreWarmup>();
```

Drei Dinge, die das richtig macht und die handgefertigte Aufwärmungen häufig verfehlen:

1. Es scoped den Kontext. `AddDbContext` registriert `TContext` als scoped, sodass das Auflösen aus dem Root-Provider eine Exception wirft. `CreateAsyncScope` ist das dokumentierte Muster.
2. Es liest `db.Model`, nicht `db.Set<Blog>().FirstOrDefault()`. Das Lesen von `Model` löst die Konventionenpipeline aus, ohne irgendeine LINQ-Abfrage zu kompilieren, was die Aufwärmung frei von Datenbank-Roundtrips hält, die fehlschlagen könnten, weil das Schema noch nicht bereit ist (denken Sie an Aspire-`WaitFor`-Ordnung oder Migrationen, die nach dem Hochfahren des Hosts laufen).
3. Es öffnet und schließt eine Verbindung, damit der SqlClient-Pool primt. Der Pool hält physische Verbindungen für ein kurzes Fenster im Leerlauf, sodass die erste echte Anfrage nicht TCP- und TLS-Setup zusätzlich zum Modellaufbau bezahlt.

Eine Pooled-Context-Registrierung (`AddDbContextPool<TContext>`) braucht dieselbe Aufwärmung, nur aus dem Pool aufgelöst. Beides funktioniert, aber wenn Sie zusätzlich die Registrierung mutieren müssen, um Modelle in Tests auszutauschen, konsultieren Sie [den RemoveDbContext-/Pooled-Factory-Test-Swap in EF Core 11](/de/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) für die unterstützte Vorgehensweise, ohne den gesamten Service Provider neu zu bauen.

Diese Lösung reicht für die meisten ASP.NET-Core-Apps. Das Modell wird zur Laufzeit immer noch gebaut, Sie haben die Kosten nur im Hoststart-Fenster versteckt, das normalerweise gratis oder fast gratis ist. Die Lösung, die die Kosten tatsächlich beseitigt, kommt unten.

## Lösung zwei: Ein vorkompiliertes Modell mit dotnet ef dbcontext optimize ausliefern

EF Core 6 hat das Compiled-Model-Feature eingeführt, EF Core 7 hat es stabilisiert, und EF Core 11 hat genug der verbleibenden Einschränkungen behoben, sodass es der richtige Standard für jeden Service ist, dem Kaltstart wichtig ist. Die Idee: Anstatt die Konventionenpipeline zur Laufzeit auszuführen, führen Sie sie zur Build-Zeit aus und emittieren ein handgeschriebenes `IModel` als generiertes C#. Zur Laufzeit lädt der Kontext direkt das vorgebaute Modell und überspringt die Konventionen vollständig.

Der CLI-Befehl ist ein Einmalaufruf:

```bash
# .NET 11 SDK, dotnet-ef 11.0.0
dotnet ef dbcontext optimize \
  --output-dir GeneratedModel \
  --namespace MyApp.Data.GeneratedModel \
  --context BloggingContext
```

Das schreibt einen Ordner mit Dateien wie `BloggingContextModel.cs`, `BlogEntityType.cs`, `PostEntityType.cs`. Fügen Sie den Ordner zur Versionskontrolle hinzu, zeigen Sie `UseModel` auf das generierte Singleton, und der Modellaufbau zur Laufzeit verschwindet:

```csharp
// .NET 11, EF Core 11.0.0
builder.Services.AddDbContext<BloggingContext>(o => o
    .UseSqlServer(builder.Configuration.GetConnectionString("Db"))
    .UseModel(MyApp.Data.GeneratedModel.BloggingContextModel.Instance));
```

Auf demselben Demo-Modell mit 30 Entitäten fällt die erste Abfrage nach dieser Änderung von 380 ms auf etwa 18 ms. Die verbleibenden Kosten sind die LINQ-zu-SQL-Übersetzung für die spezifische Abfrageform, was pro Abfrageform ist und was die zweite Aufrufung derselben Abfrage bereits cacht. Wenn die Abfrage dieselbe ist, die Sie bei jeder Anfrage ausführen, frisst der EF-Abfragecache die Kosten in Iteration zwei und die erste Anfrage ist effektiv genauso schnell wie der Steady State.

Drei Details, die einen beim ersten Mal beißen:

1. **Regenerieren, wenn das Modell sich ändert.** Das optimierte Modell ist ein Snapshot. Eine Eigenschaft, einen Index oder eine `OnModelCreating`-Regel hinzufügen und ausliefern, ohne `dotnet ef dbcontext optimize` erneut auszuführen, erzeugt einen Laufzeit-Mismatch, den EF Core erkennt und mit einer Exception beantwortet. Hängen Sie den Befehl in den Build (`<Target Name="OptimizeEfModel" BeforeTargets="BeforeBuild">`) oder in denselben Schritt, der Migrationen ausführt, damit er nicht abdriften kann.
2. **Das Flag `--precompile-queries` existiert in der EF-Core-11-Preview.** Es erweitert die Optimierung auf die LINQ-zu-SQL-Schicht für bekannte Abfragen. Stand `Microsoft.EntityFrameworkCore.Tools` 11.0.0 ist es als Preview dokumentiert und emittiert Attribute, die Sie in der offiziellen [Dokumentation zu vorkompilierten Abfragen](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries) lesen können. Verwenden Sie es für AOT-gebundene Apps, in denen Reflection eingeschränkt ist, oder für Hot Paths, bei denen die marginalen 30 bis 80 ms noch zählen.
3. **Ein vorkompiliertes Modell ist für Native AOT verpflichtend.** `OnModelCreating` führt Reflection-Pfade aus, die der AOT-Trimmer nicht statisch analysieren kann, sodass die veröffentlichte App ohne ein vorkompiliertes Modell beim ersten Berühren von `DbContext` abstürzt. Wenn Sie auch AOT für den Rest des Hosts in Betracht ziehen, gelten dieselben Einschränkungen aus [Native AOT mit ASP.NET Core Minimal APIs verwenden](/de/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) auch für EF Core.

Für einen Service, der bereits `dotnet ef migrations` in CI ausführt, sind das Hinzufügen von `dotnet ef dbcontext optimize` zum gleichen Schritt zwei Zeilen YAML, und es zahlt sich bei jedem Kaltstart für immer aus.

## Die Modell-Cache-Key-Fußangel, die beide Lösungen aushebelt

Es gibt eine Bug-Kategorie, in der die Aufwärmung sauber läuft, das vorkompilierte Modell sauber lädt und die erste benutzersichtbare Abfrage *trotzdem* langsam ist. Die Ursache ist fast immer `IModelCacheKeyFactory`. EF Core cacht das materialisierte `IModel` in einem statischen Dictionary, geschlüsselt durch ein Objekt, das die Factory zurückgibt. Die Standard-Factory gibt einen Schlüssel zurück, der nur der Kontexttyp ist. Wenn Ihr `OnModelCreating` Laufzeitzustand konsultiert (eine Tenant-ID, eine Kultur, ein Feature Flag), muss das Modell separat pro Wert dieses Zustands gecacht werden, und Sie müssen EF Core das mitteilen, indem Sie die Factory ersetzen.

```csharp
// .NET 11, EF Core 11.0.0
public sealed class TenantBloggingContext(
    DbContextOptions<TenantBloggingContext> options,
    ITenantProvider tenant) : DbContext(options)
{
    public string Tenant { get; } = tenant.CurrentTenant;

    protected override void OnModelCreating(ModelBuilder b)
    {
        b.Entity<Blog>().ToTable($"Blogs_{Tenant}");
    }
}

public sealed class TenantModelCacheKeyFactory : IModelCacheKeyFactory
{
    public object Create(DbContext context, bool designTime) =>
        context is TenantBloggingContext t ? (context.GetType(), t.Tenant, designTime) : context.GetType();
}
```

Registrieren Sie den Ersatz an den Optionen:

```csharp
builder.Services.AddDbContext<TenantBloggingContext>(o => o
    .UseSqlServer(connStr)
    .ReplaceService<IModelCacheKeyFactory, TenantModelCacheKeyFactory>());
```

Zwei Dinge gehen hier ohne die Aufwärmlösung schief:

- Die erste Anfrage für den Tenant `acme` baut das Modell beim Cache-Schlüssel `(TenantBloggingContext, "acme", false)` neu. Die erste Anfrage für den Tenant `globex` baut es erneut bei `(TenantBloggingContext, "globex", false)`. Jeder unterschiedliche Cache-Schlüssel trifft die Konventionenpipeline einmal. Eine naive Aufwärmung, die nur einen Tenant auflöst, wärmt nur einen von N Caches.
- Eine Cache-Key-Factory, die mehr Zustand als nötig einfängt (zum Beispiel den gesamten `IConfiguration`-Snapshot), fragmentiert den Cache. Wenn Sie feststellen, dass das Modell bei jeder Anfrage neu aufgebaut wird, loggen Sie den Rückgabewert von `IModelCacheKeyFactory.Create` und prüfen Sie, ob er instabil ist.

Die Aufwärmlösung von oben gilt weiter, Sie müssen sie nur über die Cache-Key-Dimensionen iterieren, die Sie interessieren: lösen Sie im Hosted Service einen Kontext pro bekanntem Tenant auf, bevor Sie den Start als erledigt erklären. Wenn die Tenant-Menge unbeschränkt ist (per-Customer-Subdomains in einem Multi-Tenant-SaaS), rettet Sie auch die Lösung mit dem vorkompilierten Modell nicht, weil `dotnet ef dbcontext optimize` einen Snapshot erzeugt, nicht eine Familie pro Tenant. Akzeptieren Sie in diesem Fall die Erstkosten pro Tenant und deckeln Sie sie stattdessen mit einem strikteren `UseQuerySplittingBehavior` und den kleinen relationalen Abfrageverbesserungen, die in [wie EF Core 11 Reference Joins bei Split Queries beschneidet](/de/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) behandelt werden.

## Eine pragmatische Reihenfolge

Wenn Sie wegen "was soll ich in welcher Reihenfolge tun" hier sind, ist das die Sequenz, die ich auf einem echten Service abarbeite:

1. Messen. Stoppen Sie die ersten drei Abfragen in einem frisch gestarteten Prozess. Wenn die erste unter 50 ms liegt, tun Sie nichts.
2. Fügen Sie den `IHostedService` `EfCoreWarmup` hinzu. Das sind 30 Zeilen Code, und es konvertiert nutzersichtbare 300 ms in 300 ms beim Hoststart.
3. Wenn die Startzeit selbst zählt (Lambda, Cloud Run, Autoscaler), führen Sie `dotnet ef dbcontext optimize` aus und `UseModel(...)`. Hängen Sie den Befehl in CI.
4. Wenn Sie eine eigene `IModelCacheKeyFactory` haben, prüfen Sie, was sie einfängt. Stellen Sie sicher, dass die Schlüsselmenge aufzählbar ist, und wärmen Sie jeden Eintrag. Wenn sie unbeschränkt ist, akzeptieren Sie die Kosten pro Schlüssel und hören Sie auf, dagegen zu kämpfen.
5. Wenn die zweite Abfrage auch langsam ist, liegen die Kosten bei der LINQ-Übersetzung, nicht beim Modellaufbau. Untersuchen Sie `DbContextOptionsBuilder.EnableSensitiveDataLogging` plus `LogTo` gefiltert auf `RelationalEventId.QueryExecuting`, oder kompilieren Sie die Abfrage vor.

Das ist dieselbe Form wie das Aufwärmen jedes Caches: herausfinden, wo die Kosten leben, sie nach vorne ziehen und die Verschiebung mit einer Stoppuhr verifizieren.

## Verwandt

- [DbContext mocken, ohne das Change Tracking zu zerstören](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [IAsyncEnumerable mit EF Core 11 verwenden](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Kaltstartzeit eines .NET 11 AWS Lambda reduzieren](/2026/04/how-to-reduce-cold-start-time-for-a-dotnet-11-aws-lambda/)
- [EF Core 11: RemoveDbContext und der Pooled-Factory-Test-Swap](/de/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [EF Core 11 Preview 3 beschneidet Reference Joins bei Split Queries](/de/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/)

## Quellen

- [EF Core Compiled Models](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-models) - Microsoft Learn
- [EF Core fortgeschrittene Performance-Themen: kompilierte Abfragen](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics#compiled-queries) - Microsoft Learn
- [`dotnet ef dbcontext optimize`-Referenz](https://learn.microsoft.com/en-us/ef/core/cli/dotnet#dotnet-ef-dbcontext-optimize) - Microsoft Learn
- [`IModelCacheKeyFactory`-API-Referenz](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.imodelcachekeyfactory) - Microsoft Learn
- [EF Core Teststrategien](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) - Microsoft Learn
