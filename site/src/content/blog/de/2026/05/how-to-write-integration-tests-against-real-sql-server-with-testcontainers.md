---
title: "Integrationstests gegen einen echten SQL Server mit Testcontainers schreiben"
description: "Eine vollständige Anleitung, um ASP.NET Core-Integrationstests gegen einen echten SQL Server 2022 mit Testcontainers 4.11 und EF Core 11 auszuführen: WebApplicationFactory verdrahten, IAsyncLifetime, DbContext-Registrierung austauschen, Migrationen anwenden, Parallelität, Aufräumen mit Ryuk und CI-Stolperfallen."
pubDate: 2026-05-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "sql-server"
lang: "de"
translationOf: "2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers"
translatedBy: "claude"
translationDate: 2026-05-01
---

Um Integrationstests aus einem .NET 11-Testprojekt gegen einen echten SQL Server auszuführen, installieren Sie `Testcontainers.MsSql` 4.11.0, erstellen eine `WebApplicationFactory<Program>`, die einen `MsSqlContainer` besitzt, starten den Container in `IAsyncLifetime.InitializeAsync`, überschreiben die `DbContext`-Registrierung in `ConfigureWebHost`, sodass sie auf `container.GetConnectionString()` zeigt, und wenden die Migrationen einmalig vor dem ersten Test an. Verwenden Sie `IClassFixture<T>`, damit xUnit einen Container über alle Tests einer Klasse hinweg teilt. Pinnen Sie das SQL Server-Image auf einen konkreten Tag, standardmäßig `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04`, und lassen Sie Ryuk den Container entsorgen, falls Ihr Prozess abstürzt. Diese Anleitung ist gegen .NET 11 preview 3, C# 14, EF Core 11, xUnit 2.9 und Testcontainers 4.11 geschrieben. Das Muster ist in .NET 8, 9 und 10 unverändert; lediglich die Paketversionen wandern.

## Warum ein echter SQL Server und nicht der In-Memory-Provider

EF Core liefert einen In-Memory-Provider sowie eine SQLite-In-Memory-Variante mit, die wie SQL Server aussehen, bis sie es nicht mehr tun. Der In-Memory-Provider hat überhaupt kein relationales Verhalten: keine Transaktionen, keine Erzwingung von Fremdschlüsseln, keine `RowVersion`-Concurrency-Token, keine SQL-Übersetzung. SQLite ist zwar eine echte relationale Engine, verwendet aber einen anderen SQL-Dialekt, andere Bezeichnerquotierung und einen anderen Decimal-Typ. Genau die Probleme, die Ihre Integrationstests aufdecken sollen, etwa ein fehlender Index, eine Verletzung einer Unique-Constraint, ein `nvarchar`-Truncation oder ein Präzisionsverlust bei `DateTime2`, werden stillschweigend verdeckt.

Die offizielle EF Core-Dokumentation hat vor Jahren sogar eine Warnung "nicht gegen In-Memory testen" hinzugefügt, und das vom Team empfohlene Muster auf der Seite [testing without your production database system](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) lautet "starten Sie eine echte Instanz in einem Container". Testcontainers macht daraus einen einzigen Methodenaufruf. Der Tradeoff ist die Kaltstartzeit beim Pullen und Booten eines SQL Server-Image (rund 8 bis 12 Sekunden bei warmem Docker-Daemon), aber jede danach getroffene Assertion wird von der Engine geprüft, die auch in Produktion läuft.

## Pinnen Sie das Image, lassen Sie es nicht treiben

Vor jedem Code: Legen Sie den Image-Tag fest. Die Testcontainers-Dokumentation verwendet als Standard `mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04`, und das ist die richtige Wahl, aus dem gleichen Grund, aus dem Sie in Produktion nicht `:latest` floaten: Eine CI-Pipeline, die gestern lief, muss heute laufen. Ein neues Cumulative Update ist in Ihrer Test-Pipeline kein kostenloses Upgrade, weil jede CU den Optimizer ändern, `sys.dm_*`-Schemata anpassen und das minimale Patch-Level für Tools wie `sqlpackage` anheben kann.

Das Image `2022-CU14-ubuntu-22.04` ist komprimiert ungefähr 1,6 GB groß, und der erste Pull auf einem frischen CI-Runner ist der langsamste Teil der Suite. Cachen Sie diese Schicht in Ihrer CI: GitHub Actions bietet `docker/setup-buildx-action` mit `cache-from`, Azure DevOps cached `~/.docker` mit dem gleichen Effekt. Nach dem ersten warmen Cache dauern Pulls etwa 2 Sekunden.

Falls Sie SQL Server 2025-Funktionen benötigen (Vektorsuche, `JSON_CONTAINS`, siehe [SQL Server 2025 JSON contains in EF Core 11](/de/2026/04/efcore-11-json-contains-sql-server-2025/)), heben Sie den Tag auf `2025-CU2-ubuntu-22.04` an. Andernfalls bleiben Sie bei 2022, weil das Developer-Image für 2022 von den Testcontainers-Maintainern am breitesten getestet wird.

## Die benötigten Pakete

Drei Pakete decken den Happy Path ab:

```xml
<!-- .NET 11, xUnit-based test project -->
<ItemGroup>
  <PackageReference Include="Testcontainers.MsSql" Version="4.11.0" />
  <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="9.0.0" />
  <PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="11.0.0" />
</ItemGroup>
```

`Testcontainers.MsSql` zieht das Basis-Paket `Testcontainers` und den `MsSqlBuilder` mit. `Microsoft.AspNetCore.Mvc.Testing` liefert `WebApplicationFactory<TEntryPoint>`, das Ihren kompletten DI-Container und die HTTP-Pipeline gegen einen `TestServer` hochfährt. `Microsoft.EntityFrameworkCore.SqlServer` ist das, was Ihr Produktionscode bereits referenziert; das Testprojekt zieht es mit, damit das Fixture Migrationen anwenden kann.

Wenn Ihre Tests xUnit verwenden, fügen Sie zusätzlich `xunit` 2.9.x und `xunit.runner.visualstudio` 2.8.x hinzu. Bei NUnit oder MSTest funktioniert dasselbe Factory-Muster, nur die Lifecycle-Hooks heißen anders.

## Die Factory-Klasse

Die Integrationstest-Factory hat drei Aufgaben: Sie verwaltet die Lebensdauer des Containers, stellt die Verbindungszeichenfolge der DI des Hosts zur Verfügung und wendet das Schema an, bevor irgendein Test läuft. Hier ist die vollständige Implementierung gegen einen hypothetischen `OrdersDbContext`:

```csharp
// .NET 11, C# 14, EF Core 11, Testcontainers 4.11
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Testcontainers.MsSql;
using Xunit;

public sealed class OrdersApiFactory
    : WebApplicationFactory<Program>, IAsyncLifetime
{
    private readonly MsSqlContainer _sql = new MsSqlBuilder()
        .WithImage("mcr.microsoft.com/mssql/server:2022-CU14-ubuntu-22.04")
        .WithPassword("Strong!Passw0rd_for_tests")
        .Build();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<DbContextOptions<OrdersDbContext>>();
            services.AddDbContext<OrdersDbContext>(opts =>
                opts.UseSqlServer(_sql.GetConnectionString()));
        });
    }

    public async Task InitializeAsync()
    {
        await _sql.StartAsync();

        using var scope = Services.CreateScope();
        var db = scope.ServiceProvider
            .GetRequiredService<OrdersDbContext>();
        await db.Database.MigrateAsync();
    }

    public new async Task DisposeAsync()
    {
        await _sql.DisposeAsync();
        await base.DisposeAsync();
    }
}
```

Drei Details lohnen einen Moment Aufmerksamkeit. Der Container wird im Feld-Initialisierer konstruiert, aber erst in `InitializeAsync` gestartet, weil xUnit diese Methode genau einmal pro Fixture aufruft. Der Host (und damit der DI-Container) wird von `WebApplicationFactory` erst dann lazy gebaut, wenn Sie `Services` lesen oder `CreateClient` aufrufen, sodass beim Aufruf von `Services.CreateScope()` in `InitializeAsync` der SQL-Container bereits läuft und die Verbindungszeichenfolge verdrahtet ist. Die Zeile `RemoveAll<DbContextOptions<OrdersDbContext>>` ist nicht verhandelbar: Lassen Sie sie weg, haben Sie zwei Registrierungen, und `services.AddDbContext` wird zur zweiten, was je nach Reihenfolge des Resolvers stillschweigend beide behält.

Der Aufruf `WithPassword` setzt das SA-Passwort. Die Passwortrichtlinie von SQL Server verlangt mindestens acht Zeichen sowie eine Mischung aus Groß-, Kleinbuchstaben, Ziffern und Symbolen; geben Sie ein schwächeres an, startet der Container zwar, aber die Engine fällt durch die Health Checks. Das Standard-SA-Passwort von Testcontainers ist `yourStrong(!)Password`, das die Richtlinie bereits erfüllt, daher funktioniert auch das Weglassen von `.WithPassword`.

## Die Factory in einer Testklasse verwenden

`IClassFixture<T>` von xUnit ist in den meisten Fällen der richtige Scope. Es konstruiert das Fixture einmal, führt jede Testmethode der Klasse gegen denselben SQL-Container aus und entsorgt es danach:

```csharp
// .NET 11, xUnit 2.9
public sealed class OrdersApiTests : IClassFixture<OrdersApiFactory>
{
    private readonly OrdersApiFactory _factory;
    private readonly HttpClient _client;

    public OrdersApiTests(OrdersApiFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Post_creates_order_and_returns_201()
    {
        var response = await _client.PostAsJsonAsync("/orders",
            new { customerId = "C-101", amount = 49.99m });

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
    }

    [Fact]
    public async Task Get_returns_persisted_order()
    {
        using var scope = _factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        db.Orders.Add(new Order { Id = "O-1", CustomerId = "C-101" });
        await db.SaveChangesAsync();

        var response = await _client.GetAsync("/orders/O-1");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }
}
```

Wenn Sie für jeden Test einen frischen Container brauchen (etwa wenn ein Test das Schema umschreibt), verwenden Sie `IAsyncLifetime` direkt auf der Testklasse statt `IClassFixture`. Das ist selten; in neun von zehn Fällen wollen Sie die Kaltstartkosten einmal pro Klasse zahlen und den Zustand durch Truncate-Befehle zurücksetzen, nicht durch einen Reboot.

## Zustand zwischen Tests zurücksetzen, nicht den Container neu starten

Der ehrliche Preis von "echten SQL Server"-Tests ist Zustands-Leak: Test A fügt Zeilen ein, Test B prüft eine Zählung und bekommt eine falsche Antwort. Es gibt drei Lösungen, geordnet nach Geschwindigkeit:

1. **Zu Beginn jedes Tests truncaten.** Am günstigsten. Halten Sie ein `static readonly string[] TablesInTruncationOrder` und führen `TRUNCATE TABLE` für jede Tabelle aus. Genau das empfehlen die Testcontainers-Maintainer in ihrem ASP.NET Core-Beispiel.
2. **Jeden Test in eine Transaktion einwickeln und am Ende rollback machen.** Funktioniert, sofern der getestete Code nicht selbst `BeginTransaction` aufruft. EF Core 11 erlaubt auf SQL Server weiterhin keine geschachtelten Transaktionen ohne einen `EnlistTransaction`-Aufruf.
3. **`Respawn` verwenden** ([Paket auf NuGet](https://www.nuget.org/packages/Respawn)). Erzeugt das Truncate-Skript einmalig durch Lesen des Information Schema, cached es und führt es vor jedem Test aus. Darauf landen die meisten großen Teams nach einigen hundert Tests.

Was Sie auch wählen: Rufen Sie zwischen Tests **nicht** `EnsureDeletedAsync` und `MigrateAsync` auf. Der Migrations-Runner von EF Core braucht selbst für ein kleines Schema einstellige Sekunden; multipliziert mit 200 Tests wandert Ihre Suite von 30 Sekunden auf 30 Minuten. Zu den Tradeoffs der DbContext-Lebensdauer in Tests siehe [removing pooled DbContextFactory in EF Core 11 test swaps](/de/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/) sowie die verwandten Hinweise zu [warming up the EF Core model](/de/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/).

## Parallele Testausführung

xUnit führt Testklassen standardmäßig parallel aus. Mit einem Container pro Class-Fixture bedeutet das: N Klassen zünden M Container gleichzeitig, wobei M durch den Speicher Ihres Docker-Hosts begrenzt ist. Ein SQL Server frisst pro Instanz im Leerlauf rund 1,5 GB RAM, ein 16-GB-GitHub-Actions-Runner schafft also etwa acht parallele Klassen, bevor er ins Swappen gerät.

Zwei gängige Stellschrauben:

```xml
<!-- xunit.runner.json in the test project, copy to output -->
{
  "parallelizeTestCollections": true,
  "maxParallelThreads": 4
}
```

```csharp
// or, opt-out per assembly
[assembly: CollectionBehavior(MaxParallelThreads = 4)]
```

Wenn Sie ein `[Collection]`-Attribut nutzen, um einen Container über mehrere Klassen zu teilen, serialisieren diese Klassen. Manchmal ist das der richtige Tradeoff: ein warmer Container, langsamere Wanduhrzeit pro Test, deutlich weniger RAM-Druck.

## Was Ryuk tut und warum Sie es eingeschaltet lassen sollten

Testcontainers bringt einen Sidecar namens Ryuk mit (Image `testcontainers/ryuk`). Wenn der .NET-Prozess startet, hängt sich Ryuk an den Docker-Daemon und beobachtet den Elternprozess. Stürzt Ihr Test-Runner ab, gerät in Panik oder wird per `kill -9` beendet, bemerkt Ryuk, dass der Elternprozess weg ist, und entsorgt die etikettierten Container. Ohne Ryuk hinterlässt ein abgestürzter Testlauf verwaiste SQL Server-Container, und der nächste Lauf läuft in Portkonflikte oder geht der RAM aus.

Ryuk ist standardmäßig aktiv. Es zu deaktivieren (`TESTCONTAINERS_RYUK_DISABLED=true`) wird in restriktiven CI-Umgebungen manchmal empfohlen, verlagert aber die Aufräumlast auf Ihre CI. Wenn Sie deaktivieren müssen, fügen Sie einen Post-Job-Schritt hinzu, der `docker container prune -f --filter "label=org.testcontainers=true"` ausführt.

## CI-Stolperfallen

GitHub Actions-Runner bringen auf Linux-Runnern (`ubuntu-latest`) Docker vorinstalliert mit, auf macOS- und Windows-Runnern jedoch nicht. Pinnen Sie für den SQL-Container auf Linux oder zahlen Sie den Preis von `docker/setup-docker-action`. Die von Microsoft gehosteten Linux-Agents in Azure DevOps verhalten sich genauso; auf selbst gehosteten Windows-Agents brauchen Sie Docker Desktop mit WSL2-Backend und ein SQL Server-Image, das zur Architektur des Hosts passt.

Was Teams ebenfalls trifft, sind Zeitzone und Kultur. Das Ubuntu-Basisimage steht auf UTC; wenn Ihre Tests gegen `DateTime.Now` prüfen, laufen sie lokal durch und scheitern in der CI. Verwenden Sie überall `DateTime.UtcNow` oder injizieren Sie `TimeProvider` (eingebaut ab .NET 8) und seeden eine deterministische Zeit.

## Verifizieren, dass der Container tatsächlich läuft

Schlägt ein Test mit `A network-related or instance-specific error occurred` fehl, war der Container noch nicht hochgefahren, als EF Core eine Verbindung geöffnet hat. Das MsSql-Modul von Testcontainers besitzt eine eingebaute Wait-Strategie, die pollt, bis die Engine antwortet, daher passiert das nur, wenn Sie die Wait-Strategie ersetzt haben. Bestätigen Sie es so:

```csharp
// peek at the dynamic host port
var port = _sql.GetMappedPublicPort(MsSqlBuilder.MsSqlPort);
Console.WriteLine($"SQL is listening on localhost:{port}");
```

Die Wait-Strategie verwendet `sqlcmd` innerhalb des Containers; falls Ihr SQL Server-Image kein `sqlcmd` enthält (ältere Images), übergeben Sie zum Überschreiben `.WithWaitStrategy(Wait.ForUnixContainer().UntilCommandIsCompleted("/opt/mssql-tools18/bin/sqlcmd", "-Q", "SELECT 1"))`.

## Wo dieser Ansatz nicht mehr ausreicht

Testcontainers liefert Ihnen einen echten SQL Server. Es liefert keinen Always On, kein Sharded Routing und keine Volltextsuche über mehrere Dateien hinweg. Ist Ihre Produktionsdatenbank ein konfiguriertes Cluster, laufen Ihre Integrationstests gegen einen einzelnen Knoten, und Ihre Suite hat eine bekannte Abdeckungslücke. Dokumentieren Sie sie und schreiben Sie kleinere, gezielte Tests gegen eine Staging-Umgebung für das clusterspezifische Verhalten, siehe [unit testing code that uses HttpClient](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/) für das Muster, das die Aufrufe der Staging-API behandelt.

Was der In-Memory-Provider einer Generation von .NET-Teams beigebracht hat, ist: "läuft lokal" ist kein Deployment-Signal. Echte Datenbank, echter Port, echte Bytes auf der Leitung, bezahlt mit 10 Sekunden Kaltstart. Eine günstige Versicherung.

## Verwandt

- [How to mock DbContext without breaking change tracking](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Removing pooled DbContextFactory for cleaner test swaps in EF Core 11](/de/2026/04/efcore-11-removedbcontext-pooled-factory-test-swap/)
- [Warm up the EF Core model before the first query](/de/2026/04/how-to-warm-up-ef-core-model-before-the-first-query/)
- [Single-step migrations with `dotnet ef update --add` in EF Core 11](/de/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/)
- [Unit-testing code that uses HttpClient](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/)

## Quellen

- [Microsoft SQL Server module (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/modules/mssql/)
- [ASP.NET Core example (Testcontainers for .NET docs)](https://dotnet.testcontainers.org/examples/aspnet/)
- [Testcontainers.MsSql 4.11.0 on NuGet](https://www.nuget.org/packages/Testcontainers.MsSql)
- [Choosing a testing strategy (EF Core docs)](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy)
- [Respawn package on NuGet](https://www.nuget.org/packages/Respawn)
