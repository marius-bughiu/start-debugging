---
title: "Kompilierte Abfragen mit EF Core für Hot Paths verwenden"
description: "Ein praktischer Leitfaden zu kompilierten Abfragen in EF Core 11: wann EF.CompileAsyncQuery wirklich gewinnt, das Static-Field-Pattern, die Stolperfallen bei Include und Tracking, und wie Sie vorher und nachher benchmarken, um den Mehraufwand zu rechtfertigen."
pubDate: 2026-05-02
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths"
translatedBy: "claude"
translationDate: 2026-05-02
---

Kurze Antwort: Deklarieren Sie die Abfrage einmal als `static readonly`-Feld über `EF.CompileAsyncQuery`, speichern Sie das resultierende Delegate, und rufen Sie es pro Aufruf mit einem frischen `DbContext` und Parametern auf. Bei einem heißen Read-Endpunkt, der dieselbe Form tausende Male pro Sekunde ausführt, spart das den LINQ-zu-SQL-Übersetzungsschritt und reduziert den Overhead pro Aufruf in EF Core 11 um 20-40%. Außerhalb von Hot Paths lohnt sich der Boilerplate nicht, da der EF Core Query Cache die Übersetzung für wiederholte strukturell identische Abfragen bereits memoisiert.

Dieser Beitrag behandelt die genaue Mechanik von `EF.CompileQuery` und `EF.CompileAsyncQuery` in EF Core 11.0.x auf .NET 11, das Static-Field-Pattern, das die Ersparnis real macht, was kompilierte Abfragen nicht können (kein `Include`-Chaining zur Laufzeit, keine Client-seitige Komposition, keine IQueryable-Rückgabe), und ein BenchmarkDotNet-Harness, das Sie in Ihr Repo einfügen können, um den Gewinn auf Ihrem eigenen Schema zu verifizieren. Alles unten verwendet `Microsoft.EntityFrameworkCore` 11.0.0 gegen SQL Server, aber die gleichen APIs funktionieren identisch auf PostgreSQL und SQLite.

## Was "kompilierte Abfrage" in EF Core 11 tatsächlich bedeutet

Wenn Sie `ctx.Orders.Where(o => o.CustomerId == id).ToListAsync()` schreiben, macht EF Core bei jedem Aufruf ungefähr fünf Dinge:

1. Den LINQ-Ausdrucksbaum parsen.
2. Im internen Query Cache nachschlagen (der Cache-Schlüssel ist die strukturelle Form des Baums plus Parametertypen).
3. Bei einem Cache-Miss den Baum nach SQL übersetzen und ein Shaper-Delegate bauen.
4. Eine Verbindung öffnen, das SQL mit gebundenen Parametern senden.
5. Die Ergebniszeilen zurück in Entitäten materialisieren.

Schritt 2 ist schnell, aber nicht kostenlos. Der Cache-Lookup durchläuft den Ausdrucksbaum, um einen Hash-Schlüssel zu berechnen. Bei einer kleinen Abfrage sind das Mikrosekunden. An einem heißen Endpunkt, der 5000 Anfragen pro Sekunde bedient, summieren sich diese Mikrosekunden. `EF.CompileAsyncQuery` lässt Sie die Schritte 1 bis 3 nach dem ersten Aufruf vollständig überspringen. Sie übergeben EF den Ausdrucksbaum einmal beim Start, EF erzeugt ein `Func`-Delegate, und ab dann geht jeder Aufruf direkt zu Schritt 4. Die Kosten pro Aufruf sinken auf "Parameter bauen, Shaper ausführen, Zeilen zurückgeben."

Die offizielle Anleitung steht in [der EF Core Advanced-Performance-Dokumentation](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics). Die Schlagzahl aus den eigenen Benchmarks des Teams ist eine Reduktion des Overheads pro Abfrage von rund 30%, mit dem größten Gewinn bei kleinen, häufig ausgeführten Abfragen, bei denen die Übersetzung einen relevanten Anteil der Gesamtzeit ausmacht.

## Das Static-Field-Pattern

Die häufigste Art, `EF.CompileAsyncQuery` falsch zu verwenden, ist der Aufruf innerhalb der Methode, die die Abfrage ausführt. Das erzeugt das Delegate bei jedem Aufruf neu, was strikt schlechter ist als gar nicht zu kompilieren. Das Pattern, das funktioniert, ist die Ablage in einem statischen Feld:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public static class OrderQueries
{
    public static readonly Func<ShopContext, int, Task<Order?>> GetOrderById =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int id) =>
                ctx.Orders
                    .AsNoTracking()
                    .FirstOrDefault(o => o.Id == id));

    public static readonly Func<ShopContext, int, IAsyncEnumerable<Order>> GetOrdersByCustomer =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int customerId) =>
                ctx.Orders
                    .AsNoTracking()
                    .Where(o => o.CustomerId == customerId)
                    .OrderByDescending(o => o.PlacedAt));
}
```

Zwei Dinge fallen auf. Erstens: Die Parameterliste ist positionell und die Typen sind fest verdrahtet: `int id` ist Teil der Delegate-Signatur. Sie können später keinen beliebigen `Expression<Func<Order, bool>>` übergeben, da das den ganzen Sinn unterlaufen würde. Zweitens: Das Delegate wird mit einer `DbContext`-Instanz pro Aufruf aufgerufen:

```csharp
public sealed class OrderService(IDbContextFactory<ShopContext> factory)
{
    public async Task<Order?> Get(int id)
    {
        await using var ctx = await factory.CreateDbContextAsync();
        return await OrderQueries.GetOrderById(ctx, id);
    }
}
```

Das Factory-Pattern ist hier wichtig. Kompilierte Abfragen sind über Kontexte hinweg threadsicher, der `DbContext` selbst aber nicht. Wenn Sie einen Kontext über Threads teilen und kompilierte Abfragen gleichzeitig ausführen, bekommen Sie dieselben Race Conditions, die Sie bei jeder anderen gleichzeitigen EF Core Nutzung bekommen. Verwenden Sie [eine gepoolte DbContext-Factory](https://learn.microsoft.com/en-us/ef/core/dbcontext-configuration/#using-a-dbcontext-factory-eg-for-blazor) für die Per-Aufruf-Instanz. Wenn Sie das nicht tun, übersteigen die Kosten für Allokation und Konfiguration eines neuen Kontexts pro Aufruf alles, was Sie durch das Kompilieren der Abfrage gespart haben.

## Die zwei Varianten und wann jede gewinnt

EF Core 11 liefert zwei statische Methoden auf `EF`:

- `EF.CompileQuery` gibt ein synchrones `Func<,...>` zurück. Der Ergebnistyp ist je nach Lambda entweder `T`, `IEnumerable<T>` oder `IQueryable<T>`.
- `EF.CompileAsyncQuery` gibt entweder `Task<T>` für einzeilige Terminaloperatoren (`First`, `FirstOrDefault`, `Single`, `Count`, `Any`, etc.) oder `IAsyncEnumerable<T>` für Streaming-Abfragen zurück.

Für Server-Workloads ist die asynchrone Variante fast immer das, was Sie wollen. Die synchrone Variante blockiert den aufrufenden Thread auf dem Datenbank-Roundtrip, was in einer Konsolen-App oder einem Desktop-Client in Ordnung ist, aber in ASP.NET Core unter Last den Threadpool aushungert. Die einzige Ausnahme ist eine Startup-Migration oder ein CLI-Tool, in dem Sie wirklich blockieren wollen.

Eine Feinheit: `EF.CompileAsyncQuery` akzeptiert keinen `CancellationToken`-Parameter direkt. Der Token wird von der umgebenden Async-Maschinerie eingefangen. Wenn Sie eine langlaufende kompilierte Abfrage abbrechen müssen, gilt weiterhin das Pattern aus [dem Cancellation-Leitfaden für langlaufende Tasks](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/): Registrieren Sie einen `CancellationToken` auf dem Request-Scope und lassen Sie das `DbCommand` ihn über die Verbindung honorieren. Kompilierte Abfragen propagieren den Token über denselben `DbCommand.ExecuteReaderAsync`-Pfad wie eine nicht-kompilierte Abfrage.

## Eine Repro, die den Gewinn zeigt

Bauen Sie das kleinste Modell, das Sie können:

```csharp
// .NET 11, EF Core 11.0.0
public sealed class Customer
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
}

public sealed class Order
{
    public int Id { get; set; }
    public int CustomerId { get; set; }
    public decimal Total { get; set; }
    public DateTime PlacedAt { get; set; }
}

public sealed class ShopContext(DbContextOptions<ShopContext> options)
    : DbContext(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<Order> Orders => Set<Order>();
}
```

Schreiben Sie nun zwei Implementierungen desselben Lookups, eine kompiliert und eine nicht:

```csharp
// .NET 11, EF Core 11.0.0
public static class Bench
{
    public static readonly Func<ShopContext, int, Task<Order?>> Compiled =
        EF.CompileAsyncQuery(
            (ShopContext ctx, int id) =>
                ctx.Orders
                    .AsNoTracking()
                    .FirstOrDefault(o => o.Id == id));

    public static Task<Order?> NotCompiled(ShopContext ctx, int id) =>
        ctx.Orders
            .AsNoTracking()
            .FirstOrDefaultAsync(o => o.Id == id);
}
```

Werfen Sie beide in BenchmarkDotNet 0.14 mit einem Testcontainers-gestützten SQL Server, dem gleichen Harness, das Sie aus [dem Testcontainers-Integrationstest-Leitfaden](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) verwenden würden:

```csharp
// .NET 11, BenchmarkDotNet 0.14.0, Testcontainers 4.11
[MemoryDiagnoser]
public class CompiledQueryBench
{
    private IDbContextFactory<ShopContext> _factory = null!;

    [GlobalSetup]
    public async Task Setup()
    {
        // Initialise the container, run migrations, seed N rows.
        // Resolve the IDbContextFactory<ShopContext> from your service provider.
    }

    [Benchmark(Baseline = true)]
    public async Task<Order?> NotCompiled()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await Bench.NotCompiled(ctx, 42);
    }

    [Benchmark]
    public async Task<Order?> Compiled()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await Bench.Compiled(ctx, 42);
    }
}
```

Auf einem 2024er Laptop gegen einen lokalen SQL Server 2025 Container kommt die kompilierte Version bei warmen Läufen rund 25% schneller heraus, mit einem kleineren Allokationsprofil, da die LINQ-Übersetzungspipeline nicht läuft. Die genaue Zahl hängt stark von Zeilenanzahl und Spaltenform ab, aber bei einem Single-Row-Primärschlüssel-Lookup können Sie einen relevanten Gewinn erwarten.

Das interessante Ergebnis ist, was bei einer Abfrage passiert, die genau einmal lief: Es gibt keinen Gewinn. Die kompilierte Version macht beim ersten Aufruf des Delegates dieselbe Übersetzungsarbeit. Wenn Ihr Hot Path "andere Form pro Aufruf" ist, sind kompilierte Abfragen nicht das richtige Werkzeug. Sie belohnen Wiederholung.

## Was kompilierte Abfragen nicht können

Kompilierte Abfragen sind statische Analyse auf einem festen Ausdrucksbaum. Das bedeutet, dass mehrere übliche LINQ-Patterns außerhalb des Erlaubten liegen:

- **Kein bedingtes `Include`**. Sie können `query.Include(o => o.Customer).If(includeLines, q => q.Include(o => o.Lines))` nicht innerhalb des Lambdas tun. Die Form ist zur Compile-Zeit festgelegt.
- **Keine `IQueryable`-Rückgabe für weitere Komposition**. Wenn Sie `IAsyncEnumerable<Order>` zurückgeben, können Sie `await foreach` darüber iterieren, aber Sie können nicht `.Where(...)` auf dem Ergebnis aufrufen und erwarten, dass dieser Filter serverseitig läuft. Er läuft Client-seitig, was den Gewinn zunichtemacht.
- **Kein Closure-Capture von State**. Das an `EF.CompileAsyncQuery` übergebene Lambda muss in sich geschlossen sein. Das Erfassen einer lokalen Variable oder eines Service-Felds aus dem umgebenden Scope wirft zur Laufzeit: "An expression tree may not contain a closure-captured variable in a compiled query." Die Lösung ist, den Wert als Parameter zur Delegate-Signatur hinzuzufügen.
- **Kein `Skip` und `Take` mit `Expression`-typisierten Werten**. Sie müssen `int`-Parameter auf dem Delegate sein. EF Core 8 hat parametergesteuertes Paging hinzugefügt, EF Core 11 behält es bei, aber Sie können kein `Expression<Func<int>>` übergeben.
- **Keine clientseitig auswertbaren Methoden**. Wenn Ihr `Where` `MyHelper.Format(x)` aufruft, kann EF das nicht übersetzen. In einer nicht-kompilierten Abfrage bekämen Sie eine Laufzeit-Warnung. In einer kompilierten Abfrage bekommen Sie eine harte Exception zur Compile-Zeit, was tatsächlich der bessere Failure Mode ist.

Die Einschränkungen sind der Trade-off, den Sie für die Beschleunigung eingehen. Wenn Ihre echte Abfrage verzweigte Form braucht, schreiben Sie eine normale LINQ-Abfrage und lassen Sie den EF Core Query Cache seine Arbeit machen. Der Cache ist gut. Er ist nur nicht kostenlos.

## Tracking, AsNoTracking, und warum es hier wichtig ist

Fast jedes Beispiel in diesem Beitrag verwendet `AsNoTracking()`. Das ist nicht dekorativ. Kompilierte Abfragen auf getrackten Entitäten gehen bei der Materialisierung weiterhin durch den Change Tracker, was einen Teil des Overheads, den Sie gerade entfernt haben, wieder hinzufügt. Für nur lesende Hot Paths ist `AsNoTracking` der gewünschte Standard.

Wenn Sie tatsächlich Tracking brauchen (der Benutzer wird die Entität mutieren und `SaveChangesAsync` aufrufen), ändert sich die Mathematik. Die Change-Tracker-Arbeit dominiert die Kosten pro Aufruf, und der Anteil, den Sie durch kompilierte Abfragen gewinnen, ist kleiner. In dem Fall ist der Gewinn eher 5-10%, was den Boilerplate selten wert ist.

Es gibt eine Folgerung im [N+1-Detection-Leitfaden](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): Wenn Sie eine Abfrage kompilieren, die `Include` für eine Navigation verwendet, ist die kartesische Explosion in das kompilierte SQL eingebrannt. Sie können sie nicht später opportunistisch `AsSplitQuery` machen. Entscheiden Sie einmal und wählen Sie die Form, die zum Aufrufort passt.

## Warm-up und der erste Aufruf

Die Kompilierungsarbeit wird bis zum ersten Aufruf des Delegates verzögert, nicht bis zur Zuweisung an das statische Feld. Wenn Ihr Service ein striktes P99-Latenzziel auf Cold Starts hat, zahlt die erste Anfrage, die einen kompilierten Abfragepfad trifft, die Übersetzungskosten zusätzlich zum normalen Erst-Anfrage-Overhead.

Die sauberste Lösung ist, sowohl das EF Core Modell als auch die kompilierten Abfragen während des Anwendungsstarts zu wärmen, dieselbe Idee, die in [dem EF Core Warm-up-Leitfaden](/de/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/) behandelt wird:

```csharp
// .NET 11, ASP.NET Core 11
var app = builder.Build();

await using (var scope = app.Services.CreateAsyncScope())
{
    var factory = scope.ServiceProvider
        .GetRequiredService<IDbContextFactory<ShopContext>>();
    await using var ctx = await factory.CreateDbContextAsync();

    // Touch the model
    _ = ctx.Model;

    // Trigger compilation by invoking each hot-path delegate once
    _ = await OrderQueries.GetOrderById(ctx, 0);
}

await app.RunAsync();
```

Die Abfrage gegen `Id == 0` gibt `null` zurück, erzwingt aber die Übersetzung. Nach diesem Block trifft Ihre erste echte Anfrage die Datenbank mit dem im Delegate bereits gecachten SQL.

## Wann Sie kompilierte Abfragen ganz weglassen sollten

Es gibt die Versuchung, jede Abfrage in der Codebasis zu kompilieren. Widerstehen Sie. Die eigene Anleitung des EF Core Teams sagt, kompilierte Abfragen "sparsam zu verwenden, nur in Situationen, in denen Mikro-Optimierungen wirklich nötig sind." Die Gründe:

- Der interne Query Cache memoisiert Übersetzungen für wiederholte strukturell identische Abfragen bereits. Für die meisten Workloads liegt die Cache-Hit-Rate nach dem Warm-up über 99%.
- Kompilierte Abfragen fügen eine zweite Quelle der Wahrheit für die Abfrageform hinzu (das statische Feld plus den Aufrufort), was Refactoring schmerzhafter macht.
- Stack Traces werden weniger hilfreich: Eine Exception in einer kompilierten Abfrage zeigt auf die Delegate-Aufrufstelle, nicht auf den ursprünglichen LINQ-Ausdruck.

Die ehrliche Entscheidungsregel lautet: Profilen Sie zuerst. Lassen Sie den Endpunkt unter realistischer Last mit [`dotnet-trace`](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/) laufen und sehen Sie, wie viel der Zeit in der Query-Infrastruktur von EF Core verbracht wird. Wenn es im einstelligen Prozentbereich der gesamten Request-Zeit liegt, lassen Sie es in Ruhe. Wenn Sie 20%+ in `RelationalQueryCompiler`, `QueryTranslationPostprocessor` oder `QueryCompilationContext` sehen, ist das ein Kandidat für eine kompilierte Abfrage.

## Zwei Patterns, die gut zusammen funktionieren

Die kompilierte Abfrage ist am nützlichsten in engen Schleifen oder Hintergrundprozessoren, die dieselbe Form hämmern:

```csharp
// .NET 11, EF Core 11.0.0 - a streaming export
public static readonly Func<ShopContext, DateTime, IAsyncEnumerable<Order>> OrdersSince =
    EF.CompileAsyncQuery(
        (ShopContext ctx, DateTime since) =>
            ctx.Orders
                .AsNoTracking()
                .Where(o => o.PlacedAt >= since)
                .OrderBy(o => o.PlacedAt));

await foreach (var order in OrdersSince(ctx, cutoff).WithCancellation(ct))
{
    await writer.WriteRowAsync(order, ct);
}
```

Paaren Sie das mit [`IAsyncEnumerable<T>` in EF Core 11](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/), und Sie bekommen einen Streaming-Export, der das Ergebnis nicht puffert, keine Liste alloziert und das kompilierte SQL bei jedem Batch wiederverwendet. Für einen Export-Job, der nächtlich über Millionen von Zeilen läuft, reduziert diese Kombination Latenz und Speicherdruck messbar.

Das andere Pattern ist der High-Cardinality-Lookup-Endpunkt: ein Single-Row-Primärschlüssel-Fetch auf einer öffentlichen API, bei dem die Anfragerate bei tausenden pro Sekunde liegt. Dort multiplizieren sich die Per-Aufruf-Einsparungen mit dem Aufrufvolumen, und eine kompilierte Abfrage auf einem `FirstOrDefault`, gepaart mit [Response Caching](https://learn.microsoft.com/en-us/aspnet/core/performance/caching/response), bringt Sie an das Nächste, was EF Core einem "kostenlosen" Read zu bieten hat.

Für alles andere schreiben Sie die Abfrage in einfachem LINQ, lehnen sich auf den Query Cache und kommen erst zurück, wenn der Profiler Ihnen sagt, dass der Übersetzungsschritt der Engpass ist. Kompilierte Abfragen sind ein Skalpell, kein Vorschlaghammer.
