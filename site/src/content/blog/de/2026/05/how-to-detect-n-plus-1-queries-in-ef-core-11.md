---
title: "N+1-Abfragen in EF Core 11 erkennen"
description: "Ein praktischer Leitfaden zum Aufspüren von N+1-Abfragen in EF Core 11: wie das Muster in echtem Code aussieht, wie Sie es über Logging, Diagnose-Interceptoren, OpenTelemetry und einen Test sichtbar machen, der den Build bricht, sobald ein Hot Path regrediert."
pubDate: 2026-05-02
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-05-02
---

Kurze Antwort: Aktivieren Sie `LogTo` von EF Core 11 mit der Kategorie `Microsoft.EntityFrameworkCore.Database.Command` auf der Stufe `Information`, und führen Sie den verdächtigen Endpunkt einmal aus. Wenn Sie dasselbe `SELECT` mit einem anderen Parameterwert 50-mal hintereinander statt eines einzigen `JOIN` sehen, haben Sie ein N+1. Die dauerhafte Lösung besteht nicht nur darin, ein `Include` hinzuzufügen, sondern darin, einen `DbCommandInterceptor` zu verdrahten, der die Befehle pro Anfrage zählt, und einen Unit-Test zu schreiben, der eine obere Schranke für die Anzahl der Befehle pro logischer Operation festlegt, damit die Regression nicht still zurückkehren kann.

Dieser Beitrag behandelt, wie N+1 in EF Core 11 immer noch auftritt (Lazy Loading, versteckter Navigationszugriff in Projektionen und falsch eingesetzte Split Queries), drei Ebenen der Erkennung (Logs, Interceptoren, OpenTelemetry) und wie Sie es im CI mit einem Test absichern, der fehlschlägt, sobald ein Endpunkt sein Abfragebudget überschreitet. Alle Beispiele laufen auf .NET 11, EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.x) und SQL Server, aber alles außer den providerspezifischen Ereignisnamen gilt identisch für PostgreSQL und SQLite.

## Wie ein N+1 in EF Core 11 wirklich aussieht

Die Lehrbuchdefinition lautet: "eine Abfrage zum Laden von N Eltern-Zeilen, dann eine zusätzliche Abfrage pro Eltern, um eine zugehörige Sammlung oder Referenz zu laden, also insgesamt N+1 Round-Trips." In einer echten EF-Core-11-Codebasis ist der Auslöser selten ein expliziter `foreach` über `Include`. Die vier Formen, die ich am häufigsten sehe, sind:

1. **Lazy Loading ist immer noch aktiviert**: Jemand hat vor Jahren `UseLazyLoadingProxies()` hinzugefügt, die Codebasis ist gewachsen, und eine Razor-Seite iteriert jetzt über 200 Bestellungen und greift auf `order.Customer.Name` zu. Jeder Zugriff löst eine eigene Abfrage aus.
2. **Eine Projektion, die eine Methode aufruft**: `Select(o => new OrderDto(o.Id, FormatCustomer(o.Customer)))`, wobei `FormatCustomer` nicht nach SQL übersetzt werden kann, sodass EF Core auf clientseitige Auswertung zurückfällt und `Customer` pro Zeile erneut abfragt.
3. **`AsSplitQuery` auf der falschen Form**: Ein `.Include(o => o.Lines).Include(o => o.Customer).AsSplitQuery()` zerlegt einen einzigen Eltern-Join korrekt in mehrere Round-Trips. Wenn Sie aber `.AsSplitQuery()` innerhalb eines `foreach` einsetzen, das bereits über die Eltern iteriert, vervielfachen Sie die Round-Trips.
4. **`IAsyncEnumerable` gemischt mit Navigationszugriff**: Ein `IAsyncEnumerable<Order>` mit [IAsyncEnumerable in EF Core 11](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) streamen und dann im Konsumenten `order.Customer.Email` antasten. Jeder Aufzählungsschritt öffnet einen neuen Round-Trip, falls die Navigation noch nicht geladen ist.

Der Grund, warum alle vier schwer zu erkennen sind, ist, dass die `DbContext`-API standardmäßig nie wirft oder warnt. Der Abfrageplan ist in Ordnung. Das einzige Signal ist der Datenverkehr auf der Leitung, und der ist unsichtbar, bis Sie hinschauen.

## Eine konkrete Reproduktion

Stellen Sie ein winziges Modell auf und beanspruchen Sie es:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public Customer Customer { get; set; } = null!;
    public decimal Total { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

Schreiben Sie nun die schlechtestmögliche Schleife:

```csharp
// Triggers N+1 if Customer is not eagerly loaded
var orders = await ctx.Orders.ToListAsync();
foreach (var order in orders)
{
    Console.WriteLine($"{order.Id}: {order.Customer?.Name}");
}
```

Ohne Lazy Loading ist `order.Customer` gleich `null`, und Sie sehen nur ein einziges `SELECT` aus `Orders`. Das ist ein anderer Bug, stiller Datenverlust, aber kein N+1. Aktivieren Sie Lazy Loading, und derselbe Code wird zum klassischen Antimuster:

```csharp
options.UseLazyLoadingProxies();
```

Jetzt erhalten Sie ein `SELECT` aus `Orders` und dann ein `SELECT * FROM Customers WHERE Id = @p0` pro Bestellung. Bei 1000 Bestellungen sind das 1001 Round-Trips. Das Erste, was Sie brauchen, ist eine Möglichkeit, sie zu sehen.

## Ebene 1: strukturiertes Logging mit LogTo und der richtigen Kategorie

Das schnellste Erkennungssignal ist der eingebaute Befehlslogger von EF Core. EF Core 11 stellt `LogTo` auf `DbContextOptionsBuilder` bereit und routet Ereignisse über `Microsoft.EntityFrameworkCore.Database.Command.CommandExecuting`:

```csharp
services.AddDbContext<ShopContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.LogTo(
        Console.WriteLine,
        new[] { RelationalEventId.CommandExecuting },
        LogLevel.Information);
});
```

Lassen Sie die Schleife einmal laufen, und die Konsole füllt sich mit Kopien derselben parametrisierten Anweisung. Wenn Sie auf eine echte Anwendung schauen, schicken Sie das Logging stattdessen über `ILoggerFactory`:

```csharp
var loggerFactory = LoggerFactory.Create(b => b.AddConsole());
options.UseLoggerFactory(loggerFactory);
options.EnableSensitiveDataLogging(); // only in dev
```

Der Schalter `EnableSensitiveDataLogging` macht die Parameterwerte sichtbar. Ohne ihn sehen Sie das SQL, aber nicht die Werte, was es viel schwerer macht, zu erkennen, dass "100 davon identisch sind, abgesehen von `@p0`". Lassen Sie ihn in der Produktion aus: er protokolliert die Abfrageparameter, die PII oder Geheimnisse enthalten können. Die offizielle Anleitung dazu finden Sie in [der EF-Core-Logging-Dokumentation](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/).

Sobald Sie den Datenstrom sehen können, ist die manuelle Erkennungsregel einfach: Für jede einzelne logische Benutzeraktion sollte die Anzahl der unterschiedlichen SQL-Anweisungen durch eine kleine Konstante begrenzt sein. Ein Listen-Endpunkt sollte seine Abfrageanzahl nicht mit der Zeilenanzahl skalieren. Tut er das doch, haben Sie einen gefunden.

## Ebene 2: ein DbCommandInterceptor, der Abfragen pro Scope zählt

Der "Loggen-und-Greppen"-Workflow ist für einen einzelnen Entwickler in Ordnung und für ein Team furchtbar. Die nächste Ebene ist ein Interceptor, der einen Zähler pro Anfrage führt und auf den Sie Asserts schreiben können. EF Core 11 liefert [`DbCommandInterceptor`](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors), der für jeden ausgeführten Befehl aufgerufen wird:

```csharp
// .NET 11, EF Core 11.0.0
public sealed class CommandCounter
{
    private int _count;
    public int Count => _count;
    public void Increment() => Interlocked.Increment(ref _count);
    public void Reset() => Interlocked.Exchange(ref _count, 0);
}

public sealed class CountingInterceptor(CommandCounter counter) : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result)
    {
        counter.Increment();
        return base.ReaderExecuting(command, eventData, result);
    }

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command,
        CommandEventData eventData,
        InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        counter.Increment();
        return base.ReaderExecutingAsync(command, eventData, result, cancellationToken);
    }
}
```

Verdrahten Sie ihn pro Anfrage als Scoped-Service:

```csharp
services.AddScoped<CommandCounter>();
services.AddScoped<CountingInterceptor>();
services.AddDbContext<ShopContext>((sp, options) =>
{
    options.UseSqlServer(connectionString);
    options.AddInterceptors(sp.GetRequiredService<CountingInterceptor>());
});
```

Nun kann jeder Codepfad in O(1) fragen: "Wie viele SQL-Befehle habe ich gerade abgesetzt?" In ASP.NET Core 11 legen Sie das um die Anfrage:

```csharp
app.Use(async (ctx, next) =>
{
    var counter = ctx.RequestServices.GetRequiredService<CommandCounter>();
    await next();
    if (counter.Count > 50)
    {
        var logger = ctx.RequestServices.GetRequiredService<ILogger<Program>>();
        logger.LogWarning(
            "{Path} executed {Count} SQL commands",
            ctx.Request.Path,
            counter.Count);
    }
});
```

Eine laute Warnung bei "mehr als 50 Befehlen pro Anfrage" reicht aus, um jeden Übeltäter während eines Lasttests oder eines Shadow-Runs in der Produktion an die Oberfläche zu bringen. Sie ist auch die Grundlage für das CI-Gate weiter unten.

Der Grund, warum das in der Produktion besser funktioniert als Logs, ist das Volumen. Der Befehlslogger auf `Information` ertränkt eine echte Anwendung. Ein Zähler ist eine einzelne Ganzzahl pro Anfrage und eine einzelne bedingte Logzeile für die Übeltäter.

## Ebene 3: OpenTelemetry, wo die Daten ohnehin schon liegen

Wenn Sie bereits dem Setup aus [dem OpenTelemetry-Leitfaden für .NET 11](/de/2026/05/how-to-use-opentelemetry-with-dotnet-11-and-a-free-backend/) folgen, brauchen Sie keinen separaten Zähler. Das Paket [`OpenTelemetry.Instrumentation.EntityFrameworkCore`](https://www.nuget.org/packages/OpenTelemetry.Instrumentation.EntityFrameworkCore) emittiert pro ausgeführtem Befehl einen Span mit dem SQL als `db.statement`:

```csharp
services.AddOpenTelemetry()
    .WithTracing(t => t
        .AddAspNetCoreInstrumentation()
        .AddEntityFrameworkCoreInstrumentation(o =>
        {
            o.SetDbStatementForText = true;
        })
        .AddOtlpExporter());
```

In jedem Backend, das Kind-Spans unter ihrem HTTP-Eltern-Span gruppiert (Aspire-Dashboard, Jaeger, Honeycomb, Grafana Tempo), erscheint ein N+1-Endpunkt als Flame Graph mit einer einzigen HTTP-Wurzel und einem Stapel formgleicher SQL-Spans. Das visuelle Signal ist unverkennbar: ein quadratischer Block aus wiederholten Kind-Spans ist immer ein N+1. Wenn Sie das haben, brauchen Sie die Log-Ebene für die alltägliche Triage eigentlich nicht mehr.

Vorsicht mit `SetDbStatementForText = true` in der Produktion: es schickt das gerenderte SQL an Ihren Collector, das identifizierbare Werte aus `WHERE`-Klauseln enthalten kann. Die meisten Teams lassen es außerhalb der Produktion an und schalten es in der Produktion aus (oder bereinigen es).

## Ebene 4: ein Test, der den Build bricht

Erkennung in Entwicklung und Produktion ist nötig, aber das Einzige, was eine schleichende Regression zurück zu N+1 verhindert, ist ein Test. Das Muster verwendet denselben Zählerinterceptor und einen [Testcontainers-basierten Integrationstest](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), der eine echte Datenbank trifft:

```csharp
// .NET 11, xUnit 2.9, EF Core 11.0.0, Testcontainers 4.11
[Fact]
public async Task Get_orders_endpoint_executes_at_most_two_commands()
{
    await using var factory = new ShopFactory(); // WebApplicationFactory<Program>
    var counter = factory.Services.GetRequiredService<CommandCounter>();
    counter.Reset();

    var client = factory.CreateClient();
    var response = await client.GetAsync("/orders?take=100");

    response.EnsureSuccessStatusCode();
    Assert.InRange(counter.Count, 1, 2);
}
```

Das Budget von "1 bis 2" spiegelt die realistische Form wider: ein `SELECT` für `Orders`, optional eines für `Customers`, falls Sie es per `Include` einbeziehen. Wenn eine zukünftige Änderung das `Include` in einen Lazy Load verwandelt, springt der Zähler auf 101, und der Test schlägt fehl. Der Test muss kein SQL kennen und sich nicht um den genauen Text kümmern. Er erzwingt nur einen Vertrag pro Endpunkt.

Eine Feinheit: Der Zähler ist scoped, aber `WebApplicationFactory` löst ihn in älteren EF-Core-Versionen aus dem Root-Provider auf. In EF Core 11 lautet das sichere Muster, den Zähler über eine Middleware pro Anfrage bereitzustellen, die ihn in `HttpContext.Items` ablegt, und ihn dann nur in Tests, in denen Sie die Lebensdauer kontrollieren, aus `factory.Services` zu lesen. Andernfalls riskieren Sie, einen Zähler zu lesen, der zu einer anderen Anfrage gehört.

## Warum `ConfigureWarnings` nicht die ganze Geschichte ist

EF Core hat `ConfigureWarnings` seit Version 3, und viele Anleitungen werden Ihnen sagen, bei `RelationalEventId.MultipleCollectionIncludeWarning` oder `CoreEventId.LazyLoadOnDisposedContextWarning` eine Exception zu werfen. Beides ist nützlich, aber keiner der beiden fängt N+1 direkt ab. Sie fangen spezifische Formen ab:

- `MultipleCollectionIncludeWarning` feuert, wenn Sie zwei Geschwister-Collections in einer einzigen, nicht aufgeteilten Abfrage per `Include` mitnehmen, und warnt vor einer kartesischen Explosion. Das ist ein anderes Problem (eine große Abfrage, die zu viele Zeilen liefert) und die Lösung ist `AsSplitQuery`, das selbst zu einem N+1 werden kann, wenn es falsch eingesetzt wird.
- `LazyLoadOnDisposedContextWarning` feuert erst, nachdem der `DbContext` weg ist. Sie fängt nicht den Lazy Load im aktiven Context ab, der das klassische N+1 erzeugt.

Es gibt keine einzelne Warnung, die sagt: "Sie haben gerade dieselbe Abfrage 100-mal abgesetzt." Genau deshalb ist der Zähleransatz tragend: er beobachtet das Verhalten, nicht die Konfiguration.

## Lösungsmuster, sobald Sie einen entdeckt haben

Erkennung ist die halbe Arbeit. Sobald der Zählertest fehlschlägt, passt die Lösung meist in eine dieser Formen:

- **Ein `Include` hinzufügen**. Die einfachste Lösung, wenn die Navigation immer benötigt wird.
- **Auf eine Projektion umstellen**. `Select(o => new OrderListDto(o.Id, o.Customer.Name))` übersetzt zu einem einzigen SQL-`JOIN` und vermeidet das Materialisieren des kompletten Graphen.
- **`AsSplitQuery` verwenden**, wenn der Eltern mehrere große Sammlungen hat. Ein Round-Trip pro Sammlung skaliert immer noch `O(1)` in den Eltern.
- **Bulk-Vorladen**. Wenn Sie nach der Eltern-Abfrage eine Liste von Fremdschlüsseln haben, machen Sie ein einziges Folge-`WHERE Id IN (...)` statt einer Suche pro Zeile. Die Übersetzung von Parameterlisten in EF Core 11 macht das knapp.
- **Lazy Loading komplett ausschalten**. `UseLazyLoadingProxies` ist die Laufzeitüberraschung selten wert. Statische Analyse und explizites `Include` finden mehr Bugs zur PR-Zeit als um 3 Uhr morgens.

Wenn Sie `DbContext` in Unit-Tests mocken, taucht nichts davon auf. Das ist ein weiterer Grund, sich auf Integrationstests gegen eine echte Datenbank zu stützen, dasselbe Argument wie in [dem Beitrag zum Mocken von DbContext](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/): Mocks bringen den Change Tracker zum Mitspielen, können aber den Datenverkehr auf der Leitung nicht reproduzieren, der N+1 sichtbar macht.

## Wo Sie als Nächstes schauen können

Die obigen Muster fangen mehr als 95 % der N+1 ab, aber zwei Nischenwerkzeuge füllen die Ecken. Das `database`-Profil von `dotnet-trace` zeichnet jeden ADO.NET-Befehl für die Offline-Auswertung auf, was nützlich ist, wenn die Regression nur unter Lasttest auftritt (siehe [den dotnet-trace-Leitfaden](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) für den Workflow). Und [`MiniProfiler`](https://miniprofiler.com/) funktioniert immer noch gut als Per-Request-UI-Overlay, wenn Sie ein an Entwickler gerichtetes Badge wollen, das sagt: "diese Seite hat 47 SQL-Abfragen abgesetzt."

All diese teilen sich dieselbe Idee: die Aktivität auf der Leitung früh genug sichtbar machen, damit der Entwickler, der die Regression eingeführt hat, sie vor dem Merge sieht. EF Core 11 macht das einfacher als jede frühere Version, aber nur, wenn Sie sich aktiv dafür entscheiden. Die Voreinstellung ist Stille.
