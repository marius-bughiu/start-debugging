---
title: "WebApplicationFactory vs Testcontainers für Integrationstests in ASP.NET Core"
description: "Es sind keine Alternativen. WebApplicationFactory startet Ihre Anwendung, Testcontainers startet deren Abhängigkeiten. Gemessen auf .NET SDK 10.0.201: ein Fixture mit Container kostet 1,7 s pro Klasse gegenüber 10 ms mit SQLite, und eine Verletzung von HasMaxLength(16), die Postgres mit 22001 ablehnt, akzeptiert SQLite stillschweigend."
pubDate: 2026-08-07
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "aspnetcore"
  - "testing"
  - "integration-tests"
  - "testcontainers"
  - "ef-core"
lang: "de"
translationOf: "2026/08/webapplicationfactory-vs-testcontainers-for-aspnetcore-integration-tests"
translatedBy: "claude"
translationDate: 2026-08-07
---

Verwenden Sie beides. `WebApplicationFactory<T>` startet Ihre Anwendung; Testcontainers startet das, womit Ihre Anwendung spricht. Die einzige Entscheidung, die Sie tatsächlich treffen müssen, betrifft die Grundlage Ihrer Datenschicht, und die Antwort lautet: Wenn der Test etwas prüft, das die Datenbank erzwingt, brauchen Sie eine echte Datenbank in einem Container. Wenn er Routing, Model Binding, Autorisierung oder die Form des JSON prüft, lassen Sie Docker weg und zahlen 10 ms statt 1,7 Sekunden.

Alles Folgende wurde auf .NET SDK 10.0.201 gemessen, mit `Microsoft.AspNetCore.Mvc.Testing` 10.0.1, `Testcontainers.PostgreSql` 4.13.0, EF Core 10.0.1 und `postgres:17.6-alpine`, auf Docker Desktop 29.5.3 (WSL2-Backend, 20 zugewiesene CPUs) auf einem Intel Core Ultra 7 265KF mit 32 GB RAM, Windows 11 26200. Die APIs sind in .NET 11 Preview unverändert.

## Die drei Konfigurationen, die tatsächlich gemeint sind

"WebApplicationFactory vs Testcontainers" ist eine schlecht gestellte Frage, denn beide liegen auf verschiedenen Ebenen. Gewählt wird in Wirklichkeit zwischen einer dieser drei Konfigurationen:

| | A. WAF + In-Process-Fake | B. WAF + Testcontainers | C. Testcontainers durchgehend |
| --- | --- | --- | --- |
| Wo die App läuft | Im Testprozess | Im Testprozess | In einem Container, den Sie kompiliert haben |
| Transport | `TestServer`, kein Socket | `TestServer`, kein Socket | Echter Socket, echter Kestrel |
| Datenbank | SQLite / In-Memory / Mock | Echte Engine im Container | Echte Engine im Container |
| Docker erforderlich | Nein | Ja | Ja |
| Fixture-Kosten (gemessen) | ~10 ms | ~1,7 s | ~1,7 s plus Image-Build |
| Haltepunkt im App-Code möglich | Ja | Ja | Nein |
| Dienst durch Fake ersetzbar | Ja | Ja | Nein |
| Testet Ihr Dockerfile / Entrypoint | Nein | Nein | Ja |
| Testet HTTPS, HTTP/2, Kestrel-Limits | Nein | Nein | Ja |
| Erkennt Constraint-Verletzungen der Datenbank | Nein (siehe unten) | Ja | Ja |

A und B sind derselbe Code mit einer anderen Verbindungszeichenfolge. C ist etwas grundsätzlich anderes und die einzige Zeile, in der das "vs" eine echte Entweder-oder-Entscheidung darstellt, denn in C verlieren Sie `ConfigureTestServices` vollständig: Die Anwendung ist ein versiegeltes Artefakt und Sie können nur über HTTP mit ihr sprechen.

Die meisten Teams wollen B, greifen zu A, weil Docker langsam wirkte, und prüfen C nie ernsthaft. Die Zahlen unten sagen: A ist billiger, als Sie es für teuer halten, B ist billiger als gedacht, und der Grund für B hat mit Leistung überhaupt nichts zu tun.

## Die Messung

Das getestete System ist eine Minimal API mit einem `POST /orders`, das über EF Core schreibt, und einem `GET /orders`, das zurückliest. `Order.Sku` ist mit `HasMaxLength(16)` und einem eindeutigen Index konfiguriert. Der Messaufbau startet pro Konfiguration dreimal ein frisches Factory im selben Prozess, sodass Runde 1 JIT und den Aufbau des EF-Modells enthält und die Runden 2 und 3 den eingeschwungenen Zustand zeigen.

```csharp
// .NET 10.0.201, C# 14, Mvc.Testing 10.0.1, Testcontainers.PostgreSql 4.13.0
var sw = Stopwatch.StartNew();
var pg = new PostgreSqlBuilder("postgres:17.6-alpine").Build();
await pg.StartAsync();
var containerStart = sw.ElapsedMilliseconds;

sw.Restart();
await using var factory = new PostgresFactory(pg.GetConnectionString());
var client = factory.CreateClient();
var boot = sw.ElapsedMilliseconds;
```

Konfiguration A, `WebApplicationFactory<T>` über eine SQLite-In-Memory-Verbindung, ohne Docker:

| Runde | Factory-Start | Schema-Erstellung | Erste Anfrage | 100 Schreibvorgänge | 100 Lesevorgänge |
| --- | --- | --- | --- | --- | --- |
| 1 | 129 ms | 309 ms | 64 ms | 205 ms | 193 ms |
| 2 | 11 ms | 2 ms | 4 ms | 49 ms | 70 ms |
| 3 | 4 ms | 7 ms | 3 ms | 49 ms | 67 ms |

Konfiguration B, dasselbe Factory gegen eine per Testcontainers gestartete PostgreSQL-Instanz, Image bereits heruntergeladen:

| Runde | Container-Start | Factory-Start | Schema-Erstellung | Erste Anfrage | 100 Schreibvorgänge | 100 Lesevorgänge | Abbau |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2933 ms | 5 ms | 198 ms | 4 ms | 210 ms | 191 ms | 321 ms |
| 2 | 1403 ms | 5 ms | 42 ms | 6 ms | 131 ms | 197 ms | 300 ms |
| 3 | 1424 ms | 4 ms | 32 ms | 5 ms | 81 ms | 81 ms | 306 ms |

Daraus folgen zwei Dinge, die dem Volksglauben widersprechen.

**Das Factory selbst ist in beiden Fällen kostenlos.** Der Start von `WebApplicationFactory<T>` kostet 4 bis 5 ms, sobald der Prozess warm ist, unabhängig von der dahinterliegenden Datenbank. Wenn jemand sagt, Integrationstests seien langsam, spricht er fast nie über `TestServer`.

**Die Kosten pro Anfrage sind praktisch gleich.** 100 Durchläufe durch die gesamte Middleware-Pipeline, Model Binding, EF Core und zurück kosten im eingeschwungenen Zustand 49 ms gegen SQLite und 81 ms gegen ein containerisiertes Postgres. Das sind 0,3 ms Unterschied pro Anfrage, über einen Loopback-Socket nach WSL2. Dass die Datenbank echt ist, macht Ihre Suite nicht langsam.

Teuer ist das Fixture: rund 1,7 Sekunden für Start und Abbau des Containers, pro Fixture, gegenüber etwa 10 ms bei der In-Process-Variante. Multiplizieren Sie das mit der Anzahl der Testklassen, die jeweils einen eigenen Container besitzen, und Sie haben Ihre Antwort. Eine Suite mit 40 Fixtures mit eigenem Container verbringt 68 Sekunden damit, nichts anderes zu tun als Postgres zu starten und zu stoppen.

Die Kaltkosten sind gesondert zu nennen, denn sie zahlt Ihr erster CI-Lauf: Das Herunterladen von `postgres:17.6-alpine` von Grund auf dauerte 11,3 Sekunden für ein 106 MB großes Image. Das ist das günstige Ende. Ein SQL-Server-Entwickler-Image ist um mehr als eine Größenordnung größer, weshalb die [Testcontainers-Anleitung für SQL Server](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/) einen Abschnitt dem Zwischenspeichern dieser Schicht in CI widmet.

## Das Ergebnis, das die Entscheidung trifft

Leistung ist nicht die entscheidende Achse. Dies schon:

```csharp
// .NET 10.0.201, EF Core 10.0.1
// Order.Sku is configured HasMaxLength(16)
db.Orders.Add(new Order { Sku = "TOOLONGSKU-0123456789", Total = 1m });
await db.SaveChangesAsync();
```

Gegen den Container:

```
postgres: 22001: value too long for type character varying(16)
```

Gegen SQLite In-Memory:

```
sqlite:   ACCEPTED, stored 21 chars
```

SQLite erzwingt keine `varchar`-Längenbegrenzung. EF Core gibt für eine Zeichenfolge mit `HasMaxLength(16)` getreu `TEXT` aus, SQLite speichert alle 21 Zeichen ohne Beanstandung, und der Test, der beweisen sollte, dass Ihre Validierung funktioniert, ist grün. In der Produktion wirft derselbe Schreibvorgang eine Ausnahme. Diese eine Abweichung ist das gesamte Argument, und sie verallgemeinert sich: SQLite unterscheidet sich von Postgres und SQL Server bei der Dezimalgenauigkeit, bei der Groß- und Kleinschreibung von Bezeichnern, bei der `DateTime`-Genauigkeit, beim Verhalten gleichzeitiger Schreibvorgänge und bei fast jeder `FromSql`-Abfrage, die Sie je schreiben werden. Der In-Memory-Provider von EF Core ist noch schlechter, da er überhaupt keine relationale Semantik erzwingt.

Die Regel lautet also weder "immer Testcontainers" noch "Testcontainers ist zu langsam". Sie lautet: **Sobald die Prüfung eines Tests von etwas abhängt, das die Datenbank-Engine erzwingt, macht eine gefälschte Datenbank diesen Test zur Lüge.** Constraint-Verletzungen, kaskadierende Löschvorgänge, `rowversion`-Nebenläufigkeitstoken (siehe [optimistische Nebenläufigkeit mit einem rowversion-Token](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/)), rohes SQL, Migrationen und alles, was den Abfrageübersetzer berührt, gehören in Konfiguration B.

## Wann Sie was wählen sollten

**Wählen Sie A (WAF, kein Docker), wenn** der Test die HTTP-Oberfläche betrifft. Lehnt `/orders/{id:int}` ein `abc` mit einem 400 ab? Gibt das Attribut `[Authorize(Policy = "Admin")]` für Nicht-Administratoren ein 403 zurück? Serialisiert die Antwort `total` als Zahl und nicht als Zeichenfolge? Erzeugt der Ausnahmehandler einen `ProblemDetails`-Rumpf? Nichts davon kümmert sich darum, ob die Datenbank echt ist, und viele dieser Tests brauchen gar keine Datenbank: Registrieren Sie über `ConfigureTestServices` ein Stub-Repository und überspringen Sie die Persistenz ganz. Das sind die Tests, die Sie bei jedem Tastendruck laufen lassen wollen, und mit 10 ms Vorbereitung können sie das.

**Wählen Sie B (WAF + Testcontainers), wenn** die Prüfung die Speicher-Engine erreicht. Das ist der Standard für Repository-Tests, EF-Core-Abfragetests, die Überprüfung von Migrationen und jeden Endpunkt, dessen interessantes Verhalten ein Datenbank-Fehlerpfad ist. Es ist außerdem der einzig ehrliche Weg zu testen, ob Ihre Migrationen sich tatsächlich auf eine leere Datenbank anwenden lassen, eine Fehlerklasse, die kein Fake erkennt und die die Produktion lahmlegt.

**Wählen Sie C (vollständig containerisiert), wenn** das Artefakt selbst geprüft wird. Sie überprüfen, ob das Dockerfile ein lauffähiges Image erzeugt, ob der Entrypoint die Umgebungsvariablen liest, die Ihr Helm-Chart setzt, ob TLS korrekt terminiert oder ob die HTTP/2-Aushandlung funktioniert. `TestServer` kann Ihnen nichts davon sagen, weil er nie einen Socket öffnet. C ist eine Handvoll Smoke-Tests am Ende der Pipeline, keine Teststrategie.

## B günstig machen: Wiederverwendung

Die 1,7 Sekunden pro Fixture sind keine feste Größe. Testcontainers unterstützt die Wiederverwendung von Containern schon länger, und das macht die Fixture-Kosten während der lokalen Entwicklung zur Randnotiz:

```csharp
// Testcontainers 4.13.0
var pg = new PostgreSqlBuilder("postgres:17.6-alpine")
    .WithReuse(true)
    .Build();
await pg.StartAsync();
// deliberately not disposed: reuse keeps the container alive between runs
```

Gemessen über drei aufeinanderfolgende Starts im selben Prozess:

| Start | Dauer | Container-ID |
| --- | --- | --- |
| 1 | 1812 ms | `81ae62b0f2b4` |
| 2 | 103 ms | `81ae62b0f2b4` |
| 3 | 81 ms | `81ae62b0f2b4` |

Derselbe Container, 81 ms statt 1812. Die Wiederverwendung wird über einen Hash der Container-Konfiguration aufgelöst, sodass ein geändertes Image-Tag, eine geänderte Umgebung oder ein geändertes Port-Mapping korrekt einen neuen Container erzeugt.

Der Haken ist die Bereinigung. Die Testcontainers-Dokumentation sagt ausdrücklich, dass das Aktivieren der Wiederverwendung den Resource Reaper deaktiviert. Ryuk entfernt den Container also nicht für Sie, und ein `DisposeAsync()` auf einem wiederverwendbaren Container stoppt ihn, statt ihn zu löschen. Ein veralteter Container mit dem Schema der Vorwoche bedient Ihre Tests klaglos weiter, bis Sie ihn von Hand entfernen. Genau diese Zustandserhaltung zwischen Läufen macht die Wiederverwendung zu einer Optimierung für die lokale Entwicklung und nicht für CI: Stellen Sie eine Umgebungsprüfung davor, damit Ihre Pipeline immer eine saubere Engine erhält.

Beachten Sie, dass Testcontainers für .NET anders als die Java-Implementierung keine Freischaltung in `~/.testcontainers.properties` benötigt. `WithReuse(true)` genügt allein, was bequem ist und zugleich der Grund dafür, dass die Absicherung Ihre Aufgabe bleibt.

Der andere Hebel, der in CI stärker wiegt, ist ein Container für viele Testklassen statt einer pro Klasse. In xUnit ist das ein Collection Fixture oder ein Assembly Fixture statt `IClassFixture<T>`; die Unterschiede zwischen den Frameworks behandelt der [Vergleich xUnit v3, NUnit und MSTest](/de/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/). Teilen Sie den Container, isolieren Sie die Daten: Geben Sie jeder Testklasse ihr eigenes Schema oder ihre eigene Datenbank auf dem gemeinsamen Server, oder setzen Sie zwischen den Tests per Truncate zurück.

## Drei Fehler, die Ihnen beim Aufbau begegnen werden

Alle drei stammen aus dem Aufbau des Messaufbaus für diesen Artikel, mit den aktuellen Paketversionen.

**`Solution root could not be located using application root`.** `WebApplicationFactory<T>` ermittelt den Content Root der Anwendung, indem er vom Test-Assembly aus im Verzeichnisbaum nach oben nach einer `.sln`- oder `.slnx`-Datei sucht, sofern das MSBuild-Target aus `Microsoft.AspNetCore.Mvc.Testing` nicht ein `WebApplicationFactoryContentRootAttribute` in Ihr Test-Assembly gestempelt hat. Ein Testprojekt, das nicht Teil einer Projektmappendatei ist, was mit den Layouts der `dotnet run app.cs`-Ära immer häufiger vorkommt, scheitert beim ersten `CreateClient()`. Entweder Sie nehmen die Projekte in eine Projektmappe auf oder Sie überschreiben `CreateHost` und setzen den Content Root explizit.

**`Services for database providers 'Npgsql.EntityFrameworkCore.PostgreSQL', 'Microsoft.EntityFrameworkCore.Sqlite' have been registered in the service provider. Only a single database provider can be registered in a service provider.`** Das ist das klassische Scheitern beim Austausch des `DbContext`, und der Rat, den Sie auf Stack Overflow finden, ist veraltet. Das Entfernen von `DbContextOptions<TContext>` genügt nicht mehr, weil `AddDbContext` ab EF Core 9 zusätzlich ein `IDbContextOptionsConfiguration<TContext>` registriert, das weiterhin den Produktionsprovider mitführt. Entfernen Sie alle drei:

```csharp
// .NET 10.0.201, EF Core 10.0.1
protected override void ConfigureWebHost(IWebHostBuilder builder)
{
    builder.ConfigureTestServices(services =>
    {
        services.RemoveAll(typeof(IDbContextOptionsConfiguration<OrdersDbContext>));
        services.RemoveAll(typeof(DbContextOptions<OrdersDbContext>));
        services.RemoveAll(typeof(DbContextOptions));
        services.AddDbContext<OrdersDbContext>(o => o.UseNpgsql(_connectionString));
    });
}
```

Die sauberere Alternative, wenn Ihnen `Program.cs` gehört, besteht darin, gar keinen Provider zu registrieren, den Sie ersetzen wollen: Lesen Sie die Verbindungszeichenfolge aus der Konfiguration und lassen Sie das Test-Factory sie über `ConfigureAppConfiguration` liefern. Dann gibt es nichts zu entfernen.

**`'PostgreSqlBuilder.PostgreSqlBuilder()' is obsolete`.** Ab Testcontainers 4.13.0 sind die parameterlosen Modul-Builder veraltet und das Image muss dem Konstruktor übergeben werden: `new PostgreSqlBuilder("postgres:17.6-alpine")`. Das ist der Abschluss der Änderung aus 4.10, mit der Module nicht mehr auf ein von den Maintainern gewähltes Tag zurückfielen. Heute ist es eine Warnung und später ein Fehler, und es ist die richtige Entscheidung: Ein bewegliches Image-Tag bedeutet, dass eine CI-Pipeline, die gestern grün war, heute aus Gründen fehlschlagen kann, die nichts mit Ihrem Commit zu tun haben.

## Was ich tatsächlich tun würde

Standardmäßig Konfiguration B für alles mit einem Repository im Aufrufstapel und Konfiguration A für alles andere. Konkret: ein gemeinsamer Container pro Assembly, `WithReuse(true)` lokal, ein Truncate-Reset zwischen den Tests statt eines Containers pro Klasse, und ein separates schnelles Testprojekt ohne Docker-Abhängigkeit für die Tests der HTTP-Oberfläche, damit `dotnet test` für dieses Projekt unter einer Sekunde bleibt.

Verwenden Sie SQLite oder den In-Memory-Provider nicht als Ersatz für Ihre Produktions-Engine. Verwenden Sie sie, wenn die Datenbank für Ihre Prüfung wirklich nebensächlich ist, und seien Sie ehrlich: An diesem Punkt schreiben Sie einen HTTP-Test, der zufällig eine Persistenzschicht benötigt. Die gemessenen 30 ms pro hundert Anfragen sind keinen grünen Test wert, der in der Produktion rot wäre. Wenn Sie überhaupt einen Fake wollen, ist [`DbContext` mocken, ohne das Change Tracking zu zerstören](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) der ehrlichere Fake als ein anderer SQL-Dialekt.

Und greifen Sie sparsam zu Konfiguration C. Sie ist eine echte Fähigkeit, keine bessere Variante von B: Sie testet das Artefakt statt des Codes und gehört daher neben Ihre Deployment-Smoke-Tests und nicht in die Suite, die Entwickler vor dem Push laufen lassen.

## Verwandte Artikel

- Die vollständige Mechanik des Factory, einschließlich `ConfigureTestServices` gegenüber `ConfigureWebHost` und dem Fälschen von Authentifizierung: [Integrationstests mit `WebApplicationFactory<T>` in ASP.NET Core 11](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).
- Die Container-Seite im Detail, mit `IAsyncLifetime`, Migrationen und Ryuk: [Integrationstests gegen einen echten SQL Server mit Testcontainers](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Fixture-Sharing, Parallelitätsvorgaben und Lebenszyklus unterscheiden sich je nach Framework: [xUnit v3 vs NUnit vs MSTest im Jahr 2026](/de/2026/08/xunit-v3-vs-nunit-vs-mstest-in-2026/).
- Die andere häufige Quelle unzuverlässiger Tests: [zeitabhängigen Code mit `TimeProvider` und `FakeTimeProvider` testen](/de/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/).
- Ein Nebenläufigkeitsverhalten, das keine gefälschte Datenbank reproduziert: [optimistische Nebenläufigkeit mit einem `rowversion`-Token in EF Core 11](/de/2026/08/how-to-implement-optimistic-concurrency-with-a-rowversion-token-in-ef-core-11/).

## Quellen

- [Integrationstests in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/test/integration-tests) zu `WebApplicationFactory<TEntryPoint>` und dem Content-Root-Attribut
- [Eine Teststrategie wählen](https://learn.microsoft.com/en-us/ef/core/testing/choosing-a-testing-strategy) in der EF-Core-Dokumentation, dazu warum der In-Memory-Provider keine Datenbank ist
- Dokumentation von [Testcontainers for .NET](https://dotnet.testcontainers.org/) und die [Releases 4.10.0 bis 4.13.0](https://github.com/testcontainers/testcontainers-dotnet/releases), die das verpflichtende Anpinnen des Image und die APIs für den Wiederverwendungs-Hash eingeführt haben
- [Diskussion zur Container-Wiederverwendung in Testcontainers](https://github.com/testcontainers/testcontainers-dotnet/discussions/1470) zu den veralteten parameterlosen Buildern
- Paketversionen von NuGet: [Microsoft.AspNetCore.Mvc.Testing 10.0.1](https://www.nuget.org/packages/Microsoft.AspNetCore.Mvc.Testing), [Testcontainers.PostgreSql 4.13.0](https://www.nuget.org/packages/Testcontainers.PostgreSql)
