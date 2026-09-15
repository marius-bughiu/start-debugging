---
title: "Lösung: EF Core MigrateAsync und CanConnectAsync wiederholen 'Login failed for user' 60 Sekunden lang"
description: "Die Existenzprüfung von EF Core für SQL Server wiederholt Fehler 18456 eine volle Minute lang, mit oder ohne EnableRetryOnFailure. Schnell scheitern, RetryTimeout begrenzen oder auf EF Core 12 warten."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-10"
  - "csharp"
lang: "de"
translationOf: "2026/09/fix-migrateasync-canconnectasync-keep-retrying-on-login-failed-for-user-ef-core"
translatedBy: "claude"
translationDate: 2026-09-15
---

Wenn `Database.MigrateAsync()`, `EnsureCreatedAsync()` oder `CanConnectAsync()` etwa eine Minute hängt, bevor `Login failed for user` geworfen wird (oder bevor `false` zurückkommt), dann stammen die Wiederholungen aus EF Core selbst, nicht aus `EnableRetryOnFailure`. `SqlServerDatabaseCreator` behandelt den SQL-Fehler 18456 in seiner Existenzprüfung als wiederholbar und verbindet sich alle 500 ms neu, bis sein einminütiges `RetryTimeout` abläuft. Das Abschalten der Wiederholungen ändert nichts. Es gibt drei Workarounds: die Verbindung vor der Migration selbst öffnen, damit ein falsches Passwort beim ersten Versuch scheitert, `RetryTimeout` senken oder Health Checks ein Timeout geben. Die echte Lösung ([dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927)) erscheint erst mit EF Core 12. Ich habe all das mit EF Core 10.0.12 und 11.0.0-rc.1 gemessen, und beide verhalten sich identisch.

## Der Fehler im Kontext

Die Exception ist der gewöhnliche SQL-Server-Anmeldefehler. Verräterisch ist, wie lange sie auf sich warten lässt:

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Login failed for user 'app'.
Error Number:18456,State:1,Class:14
```

Typische Symptome:

- Ein Container, der beim Start Migrationen ausführt und ein falsches Passwort im Connection String hat, sitzt 60 Sekunden lang still da, bevor er abstürzt. Die Startup-Probe des Orchestrators beendet ihn deshalb oft vorher, und die Exception bekommen Sie nie zu sehen.
- `/health` mit `AddDbContextCheck<T>()` braucht bei falschen Anmeldedaten eine volle Minute, um `Unhealthy` zu melden, und die Probe des Load Balancers läuft lange davor in ein Timeout.
- Das SQL-Server-Fehlerprotokoll (oder das Azure SQL Auditing) zeigt einen Schwall von über hundert `Login failed for user`-Einträgen aus einem einzigen Prozessstart.
- Integrationstests, die prüfen, dass "falsche Anmeldedaten `CanConnectAsync` dazu bringen, `false` zurückzugeben", laufen grün, aber jeder dauert eine Minute.

Eine normale Abfrage mit demselben Connection String scheitert beim ersten Versuch. Der langsame Pfad beschränkt sich auf die APIs, die fragen: "Existiert diese Datenbank?"

## Warum EF Core einen Anmeldefehler wiederholt

`CanConnectAsync`, `MigrateAsync`, `EnsureCreatedAsync` und `EnsureDeletedAsync` beginnen alle mit einem Aufruf von `IRelationalDatabaseCreator.ExistsAsync()`. Für SQL Server ist das [`SqlServerDatabaseCreator`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), und dessen Existenzprüfung ist eine eigene Schleife:

```csharp
// EF Core 10.0.12 and 11.0.0-rc.1, SqlServerDatabaseCreator (abridged)
public virtual TimeSpan RetryDelay { get; set; } = TimeSpan.FromMilliseconds(500);
public virtual TimeSpan RetryTimeout { get; set; } = TimeSpan.FromMinutes(1);

// inside ExistsAsync: open the connection, run SELECT 1, and on SqlException:
if (!retryOnNotExists && IsDoesNotExist(e)) // 4060, 1832, 5120
    return false;
if (DateTime.UtcNow > giveUp || !RetryOnExistsFailure(e))
    throw;
await Task.Delay(RetryDelay, ct);

private bool RetryOnExistsFailure(SqlException exception)
    => (exception.Number is 203 && exception.InnerException is Win32Exception)
       || exception.Number is 233 or -2 or 4060 or 1832 or 5120 or 18456;
```

Fehler 18456 kam in EF Core 6.0 durch [dotnet/efcore#25832](https://github.com/dotnet/efcore/pull/25832) auf diese Liste. Das war ein Workaround für [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644): Azure SQL kann direkt nach `CREATE DATABASE` kurzzeitig mit `Login failed` antworten, weshalb `EnsureCreated` und das erste `Migrate` gegen eine neue Datenbank zufällig scheiterten. Nötig war der Workaround nur in der Prüfung nach dem Anlegen (`CreateAsync` ruft `ExistsAsync(retryOnNotExists: true)` auf), aber dieselbe Methode wird für jede Existenzprüfung verwendet. Ein schlicht falsches Passwort wird also als "die Datenbank wärmt sich noch auf" behandelt und eine volle Minute lang wiederholt. [dotnet/efcore#38886](https://github.com/dotnet/efcore/issues/38886), eröffnet am 2026-08-31, hat genau das gemeldet.

Das erklärt auch, warum `EnableRetryOnFailure` schuldig aussieht, es aber nicht ist. Die Schleife läuft innerhalb einer einzigen Operation der Ausführungsstrategie. Wenn die Minute um ist, fragt die Strategie `SqlServerTransientExceptionDetector.ShouldRetryOn(18456)`, bekommt `false` (18456 steht nicht auf jener Liste) und wirft erneut. Mit oder ohne Wiederholungen ist das Timing dasselbe. Auch `errorNumbersToAdd` spielt keine Rolle, es sei denn, Sie fügen 18456 hinzu, was die Sache verschlimmern würde.

`CanConnectAsync` packt das Ganze dann in ein `try/catch`, das jede Exception außer einem Abbruch in `false` umwandelt. Deshalb wirft die Health-Check-Variante nie: Sie braucht nur eine Minute, um Nein zu sagen.

## Minimale Reproduktion ohne SQL Server

Um das zu sehen, brauchen Sie keinen Server. Ein `DbConnectionInterceptor`, der bei jedem physischen Öffnen eine `SqlException` mit der Nummer 18456 wirft, steht stellvertretend für einen Server mit falschen Anmeldedaten. Die `SqlException` wird per Reflection erzeugt, weil ihre Konstruktoren internal sind. Die Probe zählt die Öffnungsversuche und misst die Dauer jedes Aufrufs:

```csharp
// .NET 10, EF Core 10.0.12 (also run on .NET 11 RC 1 with EF Core 11.0.0-rc.1.26425.128)
public class FailingOpen(int number) : DbConnectionInterceptor
{
    int _attempts;
    public int Attempts => _attempts;

    public override ValueTask<InterceptionResult> ConnectionOpeningAsync(
        DbConnection c, ConnectionEventData e, InterceptionResult r, CancellationToken ct = default)
    {
        Interlocked.Increment(ref _attempts);
        throw FakeSql.Create(number, "Login failed for user 'app'.");
    }
}

public class Shop(FailingOpen interceptor, bool retry) : DbContext
{
    public DbSet<Product> Products => Set<Product>();

    protected override void OnConfiguring(DbContextOptionsBuilder o)
        => o.UseSqlServer(
                "Server=db.invalid;Database=Shop;User Id=app;Password=wrong;Encrypt=False",
                sql => { if (retry) sql.EnableRetryOnFailure(); })
            .AddInterceptors(interceptor);
}
```

Ergebnisse, identisch auf EF Core 10.0.12 (SqlClient 6.0) und EF Core 11.0.0-rc.1 (SqlClient 7.0):

| Aufruf | Fehler | `EnableRetryOnFailure` | Öffnungsversuche | Dauer | Ergebnis |
|---|---|---|---|---|---|
| `CanConnectAsync()` | 18456 | aus | 121 | 60,4 s | `false` |
| `CanConnectAsync()` | 18456 | an | 121 | 60,2 s | `false` |
| `MigrateAsync()` | 18456 | an | 121 | 60,2 s | `SqlException` 18456 |
| `EnsureCreatedAsync()` | 18456 | an | 121 | 60,2 s | `SqlException` 18456 |
| `Products.ToListAsync()` | 18456 | an | 1 | 0,1 s | `SqlException` 18456 |
| `CanConnectAsync()` | 4060 | an | 1 | 0,0 s | `false` |

Der Interceptor scheitert sofort, 121 Versuche sind also die Obergrenze: einer alle 500 ms über 60 Sekunden. Gegen einen echten Server kostet jeder Versuch zusätzlich eine TCP-Verbindung, TLS und einen Login-Roundtrip, Sie sehen also weniger Versuche, aber die Minute bleibt dieselbe. Die letzte Zeile zeigt die Asymmetrie: Eine *fehlende Datenbank* (4060) führt sofort zu `false`, während ein *falsches Passwort* der Fall ist, der wiederholt wird.

## Die Lösung im Detail

In der Reihenfolge meiner Präferenz.

### 1. Die Anmeldedaten korrigieren, anhand des serverseitigen State-Codes

Die Minute an Wiederholungen macht das eigentliche Problem nur schwerer zu finden. Der Client meldet immer `State:1`. Der Server schreibt den wahren Grund als State-Code in sein Fehlerprotokoll (in Azure SQL zeichnet das Auditing ihn auf):

| State | Bedeutung |
|---|---|
| 2, 5 | Der Login existiert nicht |
| 6 | Ein Windows-Loginname wurde mit SQL-Authentifizierung verwendet |
| 7 | Der Login ist deaktiviert (und das Passwort ist falsch) |
| 8 | Falsches Passwort |
| 18 | Das Passwort muss geändert werden |
| 38, 40 | Der Login ist gültig, kann aber die angeforderte Datenbank nicht öffnen |
| 58 | SQL-Authentifizierung gegen einen Server im reinen Windows-Modus |

Die vollständige Liste steht auf der Seite [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error). Die States 38 und 40 sollten Sie kennen, weil sie wie ein Problem mit den Anmeldedaten aussehen, in Wahrheit aber ein Berechtigungs- oder Datenbanknamenproblem sind. Sie sind Verwandte des 4060-Falls, der im [Beitrag zu CREATE DATABASE permission denied](/de/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/) behandelt wird.

### 2. Vor der Migration schnell scheitern

Wenn Sie Migrationen beim Start ausführen, öffnen Sie die Verbindung vorher selbst. `OpenConnectionAsync` läuft nicht durch die Existenzschleife, ein falsches Passwort wirft also beim ersten Versuch. Ist die Verbindung bereits offen, verwendet `MigrateAsync` sie wieder:

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
static async Task MigrateFailFastAsync(DbContext db, CancellationToken ct = default)
{
    var opened = false;
    try
    {
        await db.Database.OpenConnectionAsync(ct);
        opened = true;
    }
    catch (SqlException ex) when (ex.Number == 4060)
    {
        // Database missing (or no user for this login in it): let MigrateAsync decide.
    }

    try
    {
        await db.Database.MigrateAsync(ct);
    }
    finally
    {
        if (opened) await db.Database.CloseConnectionAsync();
    }
}
```

Die Probe hat 1 Versuch und 0,0 s bis zur `SqlException` 18456 gemessen, mit eingeschaltetem `EnableRetryOnFailure`. Das `catch` für 4060 ist wichtig. Wenn Ihre Migrationen die Datenbank *anlegen* sollen (lokale Entwicklung, eine erste Bereitstellung), scheitert das vorgezogene Öffnen mit 4060, weil die Datenbank noch nicht existiert. Wird der Fehler geschluckt, nimmt `MigrateAsync` den normalen Anlegepfad, einschließlich der Wiederholung nach dem Anlegen, die Azure SQL tatsächlich braucht. Wenn Ihre Datenbanken immer separat bereitgestellt werden, entfernen Sie das `catch` und lassen Sie auch 4060 den Start scheitern.

Für Produktions-Pipelines ist es langfristig besser, Migrationen ganz aus dem Anwendungsstart herauszunehmen und ein [Migrations-Bundle](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/) als Bereitstellungsschritt auszuführen. Es trifft auf dieselbe Schleife, aber ein Pipeline-Schritt, der nach einer Minute scheitert, ist weit weniger schmerzhaft als ein Pod in einer Crash-Schleife.

### 3. `RetryTimeout` begrenzen

`RetryTimeout` und `RetryDelay` sind öffentliche, setzbare Eigenschaften von `SqlServerDatabaseCreator`, der in einem `.Internal`-Namespace liegt. Die Verwendung löst die Analyzer-Warnung EF1001 aus, und seine Form kann sich zwischen Releases ändern:

```csharp
// .NET 10, EF Core 10.0.12 / 11.0.0-rc.1
#pragma warning disable EF1001 // Internal EF Core API usage.
using Microsoft.EntityFrameworkCore.SqlServer.Storage.Internal;
using Microsoft.EntityFrameworkCore.Storage;

var creator = (SqlServerDatabaseCreator)db.GetService<IRelationalDatabaseCreator>();
creator.RetryTimeout = TimeSpan.FromSeconds(5);
await db.Database.MigrateAsync();
#pragma warning restore EF1001
```

Damit hat die Probe für `MigrateAsync` 11 Versuche und 5,0 s gemessen. Dasselbe Timeout begrenzt auch die Prüfung nach dem Anlegen, setzen Sie es auf Azure SQL also nicht auf null, wenn `EnsureCreated` oder `Migrate` die Datenbank anlegt. Ein paar Sekunden halten den Workaround für #15644 am Leben und beseitigen die Minute. Der Creator ist ein Scoped Service, setzen Sie den Wert also auf jeder Kontextinstanz, die Migrationen ausführt, nicht einmalig beim Start.

### 4. Datenbank-Health-Checks ein Timeout geben

`AddDbContextCheck<T>()` führt standardmäßig `CanConnectAsync` aus, und [`HealthCheckRegistration.Timeout`](https://github.com/dotnet/aspnetcore/blob/main/src/HealthChecks/Abstractions/src/HealthCheckRegistration.cs) ist standardmäßig `Timeout.InfiniteTimeSpan`. Anders als `AddCheck` hat `AddDbContextCheck` keinen `timeout`-Parameter, also sind zwei Dinge nötig: den Test durch einen ersetzen, der die Existenzschleife umgeht, und das Timeout der Registrierung über `HealthCheckServiceOptions` setzen:

```csharp
// .NET 10, ASP.NET Core 10.0, Microsoft.Extensions.Diagnostics.HealthChecks.EntityFrameworkCore 10.0.12
builder.Services.AddHealthChecks()
    .AddDbContextCheck<Shop>(customTestQuery: async (db, ct) =>
    {
        await db.Database.OpenConnectionAsync(ct);
        await db.Database.CloseConnectionAsync();
        return true;
    });

// The registration is named after the context type unless you pass a name.
builder.Services.Configure<HealthCheckServiceOptions>(o =>
    o.Registrations.Single(r => r.Name == nameof(Shop)).Timeout = TimeSpan.FromSeconds(5));
```

`DbContextHealthCheck` fängt alles ab, was der Test wirft, und meldet `Unhealthy` mit angehängter Exception. Ein falsches Passwort erscheint im Health-Bericht jetzt also als `Login failed for user 'app'.` statt als nackter Fehlschlag eine Minute später. Das Timeout ist die Absicherung für alles andere, etwa einen Server, der die TCP-Verbindung annimmt und nie antwortet. Die allgemeine Einrichtung behandelt der Beitrag [Health-Check-Endpunkt zu einer Minimal API hinzufügen](/de/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/).

### 5. Upgraden, sobald EF Core 12 erscheint

[dotnet/efcore#38927](https://github.com/dotnet/efcore/pull/38927), gemergt am 2026-09-10 und dem Meilenstein 12.0.0 zugeordnet, reicht `retryOnNotExists` an `RetryOnExistsFailure` durch, sodass 18456 nur noch wiederholt wird, wenn der Provider die Datenbank gerade angelegt hat:

```csharp
// EF Core main (12.0), after dotnet/efcore#38927
|| (exception.Number is 233 or -2 or 4060 or 1832 or 5120)
|| (retryOnLoginFailure && exception.Number is 18456))
```

Stand heute ist die Änderung weder auf `release/10.0` noch auf `release/11.0` (beide haben noch die alte einzeilige Prüfung), EF Core 11.0 GA wird also höchstwahrscheinlich mit der einminütigen Wiederholung erscheinen. Einen Daily Build von EF Core 12 habe ich nicht ausprobiert. Der PR fügt synchrone und asynchrone Regressionstests für beide Pfade hinzu, auf 10 und 11 bleiben Ihnen also die Workarounds oben.

## Fallstricke und ähnliche Fehler

**Ein Cancellation Token ändert das Ergebnis, nicht nur das Timing.** `CanConnectAsync(ct)` wirft Abbrüche weiter, mit einer 5-Sekunden-`CancellationTokenSource` bekam die Probe also nach 10 Versuchen eine `TaskCanceledException` statt `false`. Code, der nur den booleschen Wert prüft, braucht ein `catch (OperationCanceledException)`.

**Der synchrone Pfad blockiert einen Thread.** `Database.Migrate()` und `CanConnect()` verwenden in derselben Schleife `Thread.Sleep(RetryDelay)`, die Minute blockiert also einen Thread aus dem Thread Pool. Ein weiterer Grund, Migrationen außerhalb von Code auszuführen, der Anfragen bedient.

**Fehler 4060 wird von `EnableRetryOnFailure` wiederholt, nur nicht hier.** 4060 (`Cannot open database "Shop" requested by the login`) *steht* auf der Liste der transienten Fehler. `CanConnectAsync` gibt dafür sofort `false` zurück, aber eine normale Abfrage mit dem Standard-`EnableRetryOnFailure()` (6 Wiederholungen, maximal 30 s Verzögerung) machte 7 Versuche über 57,9 s, bevor sie `RetryLimitExceededException` warf. Wenn ein "login failed" zur Abfragezeit etwa eine Minute dauert, prüfen Sie die Nummer der inneren Exception, bevor Sie der Creator-Schleife die Schuld geben. Und falls Sie die Strategie ohnehin anpassen, behandelt der [Beitrag zu Ausführungsstrategie und Benutzertransaktionen](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/) die andere Falle, die sie stellt.

**Das Rauschen fehlgeschlagener Logins hat Nebenwirkungen.** Jede Wiederholung ist ein echter fehlgeschlagener Login auf dem Server. Mit `CHECK_POLICY = ON` folgen SQL-Logins der Kontosperrungsrichtlinie von Windows, und das Azure SQL Auditing zeichnet jeden Versuch auf. Eine Minute an Wiederholungen kann das Konto sperren, und danach scheitert selbst das richtige Passwort, mit Fehler 18486 ("the account is currently locked out") statt 18456.

**Timeouts sind ein anderes Problem.** Wenn die Minute mit `Timeout expired` statt `Login failed` endet, haben Sie es mit Command- oder Gateway-Timeouts während einer langen Migration zu tun. Das behandelt [SqlException timeout expired während EF-Core-Migrationen](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/).

## Verwandte Beiträge

- [Lösung: CREATE DATABASE permission denied in database 'master' bei dotnet ef database update](/de/2026/08/fix-create-database-permission-denied-in-database-master-dotnet-ef-database-update/)
- [EF-Core-11-Migrationen in Produktion mit einem Migrations-Bundle anwenden](/de/2026/07/how-to-apply-ef-core-11-migrations-in-production-with-migrations-bundle/)
- [Lösung: SqlException timeout expired während EF-Core-Migrationen](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/)
- [Lösung: The configured execution strategy does not support user-initiated transactions](/de/2026/06/fix-execution-strategy-does-not-support-user-initiated-transactions/)
- [Einen Health-Check-Endpunkt zu einer Minimal API in ASP.NET Core 11 hinzufügen](/de/2026/07/how-to-add-a-health-check-endpoint-to-a-minimal-api-in-aspnetcore-11/)

## Quellen

- [dotnet/efcore#38886: CanConnectAsync / MigrateAsync retries on authentication failure instead of throwing](https://github.com/dotnet/efcore/issues/38886) und die Korrektur, [dotnet/efcore#38927: Restrict SQL Server login failure retries to post-creation checks](https://github.com/dotnet/efcore/pull/38927).
- [dotnet/efcore#25832: Update SQL Server transient error list](https://github.com/dotnet/efcore/pull/25832), das 18456 für [dotnet/efcore#15644](https://github.com/dotnet/efcore/issues/15644) hinzufügte.
- [`SqlServerDatabaseCreator.cs` in v10.0.12](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs), [in v11.0.0-rc.1](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.SqlServer/Storage/Internal/SqlServerDatabaseCreator.cs) und [`SqlServerTransientExceptionDetector.cs`](https://github.com/dotnet/efcore/blob/v10.0.12/src/EFCore.SqlServer/Storage/Internal/SqlServerTransientExceptionDetector.cs).
- [Verbindungsresilienz](https://learn.microsoft.com/en-us/ef/core/miscellaneous/connection-resiliency) (Microsoft Learn, EF Core).
- [MSSQLSERVER_18456](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/mssqlserver-18456-database-engine-error) (Microsoft Learn, SQL Server).
- [`DbContextHealthCheck.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/HealthChecks.EntityFrameworkCore/src/DbContextHealthCheck.cs) in dotnet/aspnetcore.
