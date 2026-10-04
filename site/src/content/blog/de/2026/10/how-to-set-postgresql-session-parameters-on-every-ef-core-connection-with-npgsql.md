---
title: "So setzen Sie PostgreSQL-Sitzungsparameter wie search_path oder statement_timeout bei jeder EF Core Verbindung mit Npgsql"
description: "Ein einmal ausgeführtes SET wird von DISCARD ALL gelöscht, sobald Npgsql die Verbindung an den Pool zurückgibt. Legen Sie search_path und statement_timeout mit den Connection-String-Schlüsselwörtern Search Path und Options ins Startup-Paket, weichen Sie bei Bedarf auf ALTER ROLE oder einen ConnectionOpened-Interceptor aus, und erfahren Sie, warum UsePhysicalConnectionInitializer sein SET stillschweigend verliert."
pubDate: 2026-10-04
template: how-to
tags:
  - "ef-core"
  - "ef-core-10"
  - "postgresql"
  - "npgsql"
  - "dotnet-10"
  - "how-to"
lang: "de"
translationOf: "2026/10/how-to-set-postgresql-session-parameters-on-every-ef-core-connection-with-npgsql"
translatedBy: "claude"
translationDate: 2026-10-04
---

Kurzantwort: Führen Sie `SET statement_timeout = ...` nicht einmal aus und erwarten Sie nicht, dass es bestehen bleibt. Npgsql sendet `DISCARD ALL`, sobald eine gepoolte Verbindung wiederverwendet wird, und das setzt jede Sitzungseinstellung auf ihren Standardwert zurück. Legen Sie die Einstellungen stattdessen ins Startup-Paket der Verbindung: `Search Path=tenant_a,public` für den Schema-Suchpfad und `Options=-c statement_timeout=5s -c lock_timeout=1s` für jeden anderen Parameter. PostgreSQL behandelt Startup-Parameter als Sitzungsstandards, daher setzt `DISCARD ALL` auf *Ihre* Werte zurück, und EF Core braucht überhaupt keinen zusätzlichen Code. Wenn Sie den Connection String nicht anfassen können, verwenden Sie `ALTER ROLE app_user SET ...` auf dem Server oder einen `DbConnectionInterceptor`, der in `ConnectionOpenedAsync` ein `SET` ausführt (ein zusätzlicher Roundtrip pro Öffnen).

Alles Folgende wurde mit .NET 10 (SDK 10.0.302) und `Npgsql.EntityFrameworkCore.PostgreSQL` 10.0.3 (EF Core 10.0.4, Npgsql 10.0.3) gegen PostgreSQL 18.4 ausgeführt, mit eingeschaltetem `log_statement=all`, damit jede von Npgsql gesendete Anweisung im Serverlog erscheint. Die zitierten Ausgaben stammen aus diesen Läufen.

## Warum ein einmaliges SET verschwindet

Npgsql poolt physische Verbindungen. Wenn Sie eine `NpgsqlConnection` verwerfen (oder EF Core sie nach einer Abfrage schließt), geht die physische Verbindung zurück in den Pool, und Npgsql markiert sie für ein Zurücksetzen. Dieses Zurücksetzen ist ein `DISCARD ALL`, das PostgreSQL als `CLOSE ALL; SET SESSION AUTHORIZATION DEFAULT; RESET ALL; DEALLOCATE ALL; UNLISTEN *; ...` definiert. `RESET ALL` ist hier der entscheidende Teil: Jedes `SET`, das Sie in dieser Sitzung ausgeführt haben, ist weg.

Hier ist die kleinste Reproduktion. Der Pool ist auf eine Verbindung begrenzt, sodass das zweite Öffnen garantiert dieselbe physische Sitzung erhält:

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Maximum Pool Size=1");

int pid1, pid2;
await using (var c = await ds.OpenConnectionAsync())
{
    pid1 = c.ProcessID;
    await new NpgsqlCommand("SET search_path = tenant_a; SET statement_timeout = '1s'", c)
        .ExecuteNonQueryAsync();
}
await using (var c = await ds.OpenConnectionAsync())
{
    pid2 = c.ProcessID;
    // same physical=True search_path="$user", public statement_timeout=0
}
```

Derselbe Backend-Prozess, und beide Einstellungen stehen wieder auf den Serverstandards. Das Serverlog zeigt, warum:

```text
[95652] execute <unnamed>: SET search_path = tenant_a
[95652] execute <unnamed>: SET statement_timeout = '1s'
[95652] statement: DISCARD ALL
[95652] execute <unnamed>: SHOW search_path
```

Beachten Sie, dass `DISCARD ALL` nicht beim Schließen der Verbindung gesendet wird. Npgsql schiebt es auf und schreibt es vor den nächsten Befehl auf dieser physischen Verbindung, es kostet also keinen zusätzlichen Roundtrip. Es läuft außerdem unabhängig davon, ob Sie etwas geändert haben, Sie können es also nicht durch Sorgfalt umgehen.

Mit EF Core trifft das härter als mit rohem ADO.NET, weil EF Core die Verbindung um jede Operation herum öffnet und schließt. Ein `DbContext`, der eine Abfrage und danach einen `SqlQueryRaw`-Aufruf ausführt, öffnet die Verbindung zweimal, und jedes Öffnen kann auf einer frisch zurückgesetzten Sitzung landen.

## Option 1: das Connection-String-Schlüsselwort Search Path

Speziell für den Schema-Suchpfad hat Npgsql ein eigenes Schlüsselwort. Es wird als Startup-Parameter gesendet, nicht als `SET`:

```csharp
// .NET 10, Npgsql 10.0.3
var ds = NpgsqlDataSource.Create(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Search Path=tenant_a,public");

await using var c = await ds.OpenConnectionAsync();
// SHOW search_path            -> tenant_a,public
// SELECT count(*) FROM orders -> 1 (resolves to tenant_a.orders)
```

Im Serverlog gibt es für diese Verbindung überhaupt kein `SET`. Der Wert reist im Startup-Paket, und PostgreSQL verwendet ihn als Sitzungsstandard.

## Option 2: Options=-c für jeden anderen Parameter

Das Schlüsselwort `Options` wird als PostgreSQL-Startup-Parameter `options` durchgereicht, der dieselbe `-c name=value`-Syntax akzeptiert wie die `postgres`-Kommandozeile. Das deckt `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `work_mem`, `search_path` und alles andere ab, was ein normaler Benutzer per `SET` setzen darf:

```csharp
// .NET 10, Npgsql 10.0.3
var cs = "Host=localhost;Port=55432;Username=postgres;Database=postgres;" +
         "Options=-c statement_timeout=2s -c search_path=tenant_a,public -c lock_timeout=500ms";
var ds = NpgsqlDataSource.Create(cs);

await using (var c = await ds.OpenConnectionAsync())
{
    // statement_timeout=2s search_path=tenant_a,public lock_timeout=500ms
    await new NpgsqlCommand("SET statement_timeout = '9s'", c).ExecuteNonQueryAsync();
    // statement_timeout=9s
}
await using (var c = await ds.OpenConnectionAsync())
{
    // statement_timeout=2s   <- DISCARD ALL reset it to the startup value, not to 0
}
```

Diese Eigenschaft macht das Startup-Paket zum richtigen Ort. `RESET ALL` setzt jeden Parameter auf den Wert zurück, den er gehabt hätte, wenn in dieser Sitzung kein `SET` gelaufen wäre, und bei einem Startup-Parameter ist das der Wert, den Sie übergeben haben. Eine Anfrage, die den Timeout vorübergehend erhöht, kann ihn also nicht in die nächste Anfrage durchsickern lassen, und die nächste Anfrage erhält weiterhin Ihren Standard statt den des Servers.

Wenn Sie Connection Strings im Code aufbauen, verwenden Sie `NpgsqlConnectionStringBuilder`, damit das Quoting für Sie erledigt wird. Der durch Leerzeichen getrennte `Options`-Wert wird in Anführungszeichen gesetzt:

```csharp
// .NET 10, Npgsql 10.0.3
var csb = new NpgsqlConnectionStringBuilder("Host=localhost;Port=55432;Username=postgres;Database=sp_demo")
{
    SearchPath = "tenant_b,public",
    Options = "-c statement_timeout=5s -c lock_timeout=1s",
    ApplicationName = "orders-api",
};
// Host=localhost;Port=55432;Username=postgres;Database=sp_demo;Search Path=tenant_b,public;
// Options="-c statement_timeout=5s -c lock_timeout=1s";Application Name=orders-api
```

## Anbindung an EF Core

Weil die Einstellungen im Connection String stehen, braucht EF Core nichts Besonderes. Übergeben Sie den String an `UseNpgsql`, oder registrieren Sie eine `NpgsqlDataSource` und übergeben Sie diese:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
builder.Services.AddDbContext<AppDbContext>(o => o.UseNpgsql(
    builder.Configuration.GetConnectionString("Orders")));

// appsettings.json
// "ConnectionStrings": {
//   "Orders": "Host=db;Database=orders;Username=app;Search Path=tenant_b,public;Options=-c statement_timeout=5s -c lock_timeout=1s"
// }
```

Eine Abfrage über diesen Context bestätigt, dass der Timeout auf jeder von EF Core geöffneten Verbindung gilt:

```csharp
var st = await db.Database
    .SqlQueryRaw<string>("SELECT current_setting('statement_timeout') AS \"Value\"")
    .SingleAsync();
// 5s
```

Wenn der Timeout auslöst, bricht PostgreSQL die Anweisung auf dem Server ab, und Sie erhalten eine `PostgresException` mit `SqlState` `57014` und der Meldung `canceling statement due to statement timeout`. Die Verbindung bleibt offen und nutzbar. Das unterscheidet sich vom eigenen `Command Timeout` von Npgsql (Standard 30 Sekunden), der vom Client erzwungen wird: Wenn er abläuft, bricht Npgsql die Abfrage ab und wirft eine `NpgsqlException`, die eine `TimeoutException` umschließt, ohne `SqlState`. Halten Sie `Command Timeout` etwas höher als `statement_timeout`, damit das serverseitige Limit auslöst, das einen sauberen Fehler liefert und nicht davon abhängt, dass der Client es bemerkt.

## Option 3: ALTER ROLE oder ALTER DATABASE auf dem Server

Wenn der Connection String jemand anderem gehört (einem Plattform-Team, einem Secret Store, den Sie nicht pro App ändern können), schieben Sie die Standards auf den Server:

```sql
-- PostgreSQL 18
ALTER ROLE app_user SET search_path = tenant_a, public;
ALTER ROLE app_user SET statement_timeout = '15s';

-- or scoped to one database
ALTER ROLE app_user IN DATABASE orders SET statement_timeout = '15s';
```

Eine neue Verbindung als `app_user` kam mit `search_path=tenant_a, public` und `statement_timeout=15s` zurück, ganz ohne clientseitige Konfiguration. Diese Rollenstandards überleben auch `DISCARD ALL`, da sie Teil des Ausgangszustands der Sitzung sind.

Die Rangfolge ist wichtig, wenn Sie Ansätze kombinieren. Dieselbe Rolle mit `Options=-c statement_timeout=3s` erhielt `3s`: Startup-Parameter überschreiben Rollen- und Datenbankstandards, die wiederum `postgresql.conf` überschreiben. Das ergibt eine nützliche Schichtung: ein konservativer Standard auf der Rolle und eine anwendungsspezifische Überschreibung im Connection String, wo ein Dienst berechtigterweise längere Abfragen braucht (ein Reporting-Job, ein Migrationsrunner).

Vermeiden Sie es, `statement_timeout` global in `postgresql.conf` zu setzen. Die PostgreSQL-Dokumentation rät davon ab, weil es auch für Wartungssitzungen, `pg_dump` und Ihre eigenen `psql`-Sitzungen gilt.

## Option 4: ein DbConnectionInterceptor, der bei jedem Öffnen SET ausführt

Manchmal ist der Wert nicht statisch. Eine mandantenfähige App, die das Schema pro Anfrage wählt, oder eine vom aktuellen Benutzer abgeleitete Einstellung kann nicht in einem festen Connection String stehen. Die [Interceptors](/de/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) von EF Core bieten einen Hook, der direkt nach jedem Öffnen läuft:

```csharp
// .NET 10, EF Core 10.0.4
using System.Data.Common;
using Microsoft.EntityFrameworkCore.Diagnostics;

public sealed class SessionSettingsInterceptor : DbConnectionInterceptor
{
    const string Sql = "SET statement_timeout = '5s'; SET lock_timeout = '1s'";

    public override void ConnectionOpened(DbConnection connection, ConnectionEndEventData eventData)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        cmd.ExecuteNonQuery();
    }

    public override async Task ConnectionOpenedAsync(
        DbConnection connection, ConnectionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        await using var cmd = connection.CreateCommand();
        cmd.CommandText = Sql;
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }
}

// registration
builder.Services.AddDbContext<AppDbContext>(o => o
    .UseNpgsql(connectionString)
    .AddInterceptors(new SessionSettingsInterceptor()));
```

Überschreiben Sie sowohl die synchrone als auch die asynchrone Methode. EF Core ruft jeweils die Methode auf, die zu der von Ihnen verwendeten API passt, und wer die synchrone vergisst, lässt `db.Orders.Count()` stillschweigend ohne Ihre Einstellungen laufen.

Das funktioniert, und das Log zeigt genau, was es kostet. Zwei `DbContext`-Instanzen, die jeweils eine LINQ-Abfrage und eine rohe SQL-Abfrage ausführten, erzeugten vier Öffnungen und vier `SET`-Paare:

```text
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT count(*)::int ...
[95655] statement: DISCARD ALL
[95655] execute <unnamed>: SET statement_timeout = '5s'
[95655] execute <unnamed>: SET lock_timeout = '1s'
[95655] execute <unnamed>: SELECT s."Value" ...
```

Jedes Öffnen zahlt einen zusätzlichen Roundtrip. Auf einem lokalen Socket ist das Rauschen; gegen eine verwaltete Datenbank in einer anderen Availability Zone kann es in derselben Größenordnung liegen wie die Abfrage selbst. Für statische Werte sind die Optionen 1 bis 3 strikt besser. Für Werte pro Anfrage sollten Sie prüfen, ob der Parameter wirklich sitzungsweit gelten muss oder ob ein `SET LOCAL` innerhalb der ohnehin laufenden Transaktion genügt.

## Die Falle: UsePhysicalConnectionInitializer

`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer` wirkt wie die naheliegende Lösung. Es führt einen Callback einmal aus, wenn eine physische Verbindung erstmals erstellt wird, was nach "einmal pro Sitzung, kein Mehraufwand pro Öffnen" klingt. Das passiert tatsächlich:

```csharp
// .NET 10, Npgsql 10.0.3
var b = new NpgsqlDataSourceBuilder(
    "Host=localhost;Port=55432;Username=postgres;Database=postgres;Maximum Pool Size=1");
b.UsePhysicalConnectionInitializer(
    conn => { using var cmd = new NpgsqlCommand("SET statement_timeout = '4s'", conn); cmd.ExecuteNonQuery(); },
    async conn => { await using var cmd = new NpgsqlCommand("SET statement_timeout = '4s'", conn); await cmd.ExecuteNonQueryAsync(); });
var ds = b.Build();

// open 0: statement_timeout=4s inits=1
// open 1: statement_timeout=0  inits=1
// open 2: statement_timeout=0  inits=1
```

Der Initializer läuft wie versprochen einmal, und das erste Öffnen sieht `4s`. Dann geht die Verbindung zurück in den Pool, `DISCARD ALL` löscht das `SET`, und der Initializer läuft nie wieder, weil die physische Verbindung weiterhin existiert. Jede Anfrage nach der ersten läuft ohne Timeout. Die XML-Dokumentation von Npgsql zu dieser Methode warnt davor: Dort angewendete Einstellungen werden von `DISCARD ALL` zurückgesetzt, es sei denn, Sie schalten das Zurücksetzen ab.

Die Lösung ist, es mit `No Reset On Close=true` zu kombinieren. In EF Core erreichen Sie über `ConfigureDataSource` den Builder, ohne `UseNpgsql` zu verlassen:

```csharp
// .NET 10, EF Core 10.0.4, Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3
options.UseNpgsql(
    "Host=localhost;Port=55432;Username=postgres;Database=sp_demo;No Reset On Close=true",
    o => o.ConfigureDataSource(ds => ds.UsePhysicalConnectionInitializer(
        conn => { using var cmd = new NpgsqlCommand("SET search_path = tenant_b, public", conn); cmd.ExecuteNonQuery(); },
        async conn => { await using var cmd = new NpgsqlCommand("SET search_path = tenant_b, public", conn); await cmd.ExecuteNonQueryAsync(); })));

// ctx 0: widgets=1 search_path=tenant_b, public inits=1
// ctx 1: widgets=1 search_path=tenant_b, public inits=1
// ctx 2: widgets=1 search_path=tenant_b, public inits=1
```

Ein `SET`, kein `DISCARD ALL` im Log, und die Einstellung hält über mehrere Contexts hinweg. Der Preis: *Nichts* wird mehr zurückgesetzt. Wenn irgendein Codepfad ein `SET` ausführt (ein Migrationshelfer, eine Diagnoseabfrage, eine Bibliothek), sickert dieser Wert nun an jeden späteren Nutzer dieser physischen Verbindung durch, zusammen mit temporären Tabellen und `LISTEN`-Registrierungen. Verwenden Sie diese Kombination nur, wenn Sie jede Anweisung kontrollieren, die auf dem Pool läuft. Wenn ein statischer Wert genügt, ist der Connection String einfacher und sicherer.

## Überschreibungen pro Abfrage mit SET LOCAL

Den Timeout für eine bekannt langsame Operation zu erhöhen, erfordert überhaupt keine Sitzungsänderung. `SET LOCAL` gilt bis zum Ende der aktuellen Transaktion:

```csharp
// .NET 10, EF Core 10.0.4
await using var tx = await db.Database.BeginTransactionAsync();
await db.Database.ExecuteSqlRawAsync("SET LOCAL statement_timeout = '60s'");
await db.Database.ExecuteSqlRawAsync("REFRESH MATERIALIZED VIEW sales_summary");
await tx.CommitAsync();
// after commit: statement_timeout is back to the session default
```

Im Test lieferte `SHOW statement_timeout` innerhalb der Transaktion `100ms` und direkt nach dem Commit `0`, auf derselben Verbindung, ganz ohne `DISCARD ALL`. Das ist auch der einzige Ansatz, der durch PgBouncer im Transaction-Modus funktioniert, wie als Nächstes behandelt.

## Fallstricke bei Poolern, Migrationen und Timeouts

**PgBouncer lehnt unbekannte Startup-Parameter ab.** Standardmäßig akzeptiert PgBouncer nur Startup-Parameter, die er verfolgt, und löst für alles andere einen Fehler aus, einschließlich `options`. Sie fügen entweder `options` zu `ignore_startup_parameters` hinzu (dann verwirft PgBouncer Ihre Einstellungen stillschweigend) oder verlagern die Standards nach `ALTER ROLE`. PostgreSQL 18 meldet `search_path` an den Client zurück, daher verfolgt PgBouncer ihn unter 18 von Haus aus. Im Transaction- oder Statement-Modus empfiehlt die Npgsql-Dokumentation außerdem `No Reset On Close=true`, weil `DISCARD ALL` keinen Sinn ergibt, wenn PgBouncer die nächste Transaktion an ein anderes Backend übergeben kann. In diesem Modus ist jedes `SET` außerhalb einer Transaktion praktisch zufällig, verwenden Sie also `SET LOCAL` oder Rollenstandards.

**search_path entscheidet, wo nicht qualifizierte Tabellen erstellt werden.** Mit `Search Path=tenant_b,public` und ohne `HasDefaultSchema` erstellte `EnsureCreatedAsync` `Widgets` in `tenant_b`. Der Npgsql-Provider erstellt `__EFMigrationsHistory` ebenfalls mit `CREATE TABLE IF NOT EXISTS` unqualifiziert, sodass ein Migrationsrunner, dessen Connection String einen anderen `search_path` trägt als die App, eine zweite Verlaufstabelle anlegt und versucht, jede Migration erneut auszuführen. Legen Sie entweder das Schema im Modell fest (`modelBuilder.HasDefaultSchema("tenant_b")` und `MigrationsHistoryTable("__EFMigrationsHistory", "tenant_b")`) oder stellen Sie sicher, dass der Runner exakt denselben Connection String verwendet. Beachten Sie auch, dass `EnsureCreated` prüft, ob die Datenbank *irgendwelche* Benutzertabellen hat, nicht nur solche in Ihrem Suchpfad: In einer Datenbank, die bereits `tenant_a.orders` enthielt, wurde die Erstellung komplett übersprungen, und das erste Insert scheiterte mit `42P01: relation "Widgets" does not exist`.

**Migrationen brauchen ihren eigenen Timeout.** Ein `statement_timeout` von 5 Sekunden im gemeinsamen Connection String bricht ein langes `CREATE INDEX` bei der Bereitstellung ab. Geben Sie dem Migrationsrunner einen eigenen Connection String mit `Options=-c statement_timeout=0` (Startup-Parameter gewinnen gegen Rollenstandards), und lesen Sie [den Leitfaden zu EF Core Migrations-Timeouts](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) für die clientseitige Hälfte des Problems.

**lock_timeout ist meist der, den Sie wirklich wollen.** Eine Abfrage, die hinter einer Sperre hängt, ist der häufige Produktionsvorfall, und `statement_timeout` greift erst, wenn das gesamte Budget aufgebraucht ist. `lock_timeout=1s` scheitert schnell mit `55P03` und lässt berechtigterweise lange Abfragen laufen. PostgreSQL 17 hat außerdem `transaction_timeout` hinzugefügt, das die gesamte Transaktion statt jeder einzelnen Anweisung begrenzt.

**Manche Parameter lassen sich so nicht setzen.** Serverweite Parameter werden in `options` abgelehnt: `-c shared_buffers=1GB` scheitert mit `55P02 parameter "shared_buffers" cannot be changed without restarting the server`, und ein `sighup`-Parameter wie `log_checkpoints` scheitert mit `55P02 ... cannot be changed now`. Parameter nur für Superuser scheitern bei einer normalen Rolle: `-c log_statement=none` als `app_user` ergab `42501 permission denied to set parameter "log_statement"`. In jedem Fall wirft `OpenAsync` eine Ausnahme, sodass Sie es bei der ersten Anfrage erfahren, statt stillschweigend mit falschen Einstellungen zu laufen.

## Den passenden Ansatz wählen

Für einen festen Wert verwenden Sie den Connection String: `Search Path` für Schemas, `Options=-c ...` für alles andere. Er kostet pro Öffnen nichts, übersteht das Zurücksetzen des Pools und funktioniert gleichermaßen für EF Core, Dapper und rohes Npgsql. Verwenden Sie `ALTER ROLE ... SET`, wenn der Connection String nicht Ihnen gehört oder als Sicherheitsnetz darunter. Greifen Sie nur dann zu einem `ConnectionOpened`-Interceptor, wenn der Wert vom Laufzeitzustand abhängt, und nehmen Sie den zusätzlichen Roundtrip in Kauf. `UsePhysicalConnectionInitializer` mit `No Reset On Close=true` ist ein Nischenwerkzeug für Pools, bei denen Sie jede Anweisung kontrollieren.

### Weiterlesen

- [Was ist ein EF Core Interceptor und wann brauche ich einen?](/de/2026/09/what-is-an-ef-core-interceptor-and-when-do-i-need-one/) erklärt die Interceptor-Pipeline, in die sich der `ConnectionOpened`-Ansatz einhängt.
- [Wie Sie EF Core 11 Interceptors für Auditing verwenden](/de/2026/06/how-to-use-ef-core-11-interceptors-for-auditing/) zeigt einen `SaveChanges`-Interceptor von Anfang bis Ende.
- [Wie Sie benannte Abfragefilter für Soft Delete und Mandantenfähigkeit in EF Core 11 verwenden](/de/2026/07/how-to-use-named-query-filters-for-soft-delete-and-multi-tenancy-in-ef-core-11/) ist die zeilenbasierte Alternative zum Umschalten des `search_path` pro Mandant und Schema.
- [Wie Sie das von EF Core 11 erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/) hilft, clientseitig zu bestätigen, was den Server erreicht.
- [Wie Sie atomar an ein PostgreSQL-jsonb-Array mit EF Core und Npgsql anhängen](/de/2026/09/how-to-atomically-append-to-a-postgresql-jsonb-array-with-ef-core-and-npgsql/) ist ein weiteres Npgsql-spezifisches Muster, getestet gegen PostgreSQL 18.

### Quellen

- [Connection String Parameters](https://www.npgsql.org/doc/connection-string-parameters.html), Npgsql-Dokumentation (`Search Path`, `Options`, `No Reset On Close`, `Command Timeout`)
- [Compatibility notes: pgbouncer](https://www.npgsql.org/doc/compatibility.html), Npgsql-Dokumentation
- [`NpgsqlDataSourceBuilder.UsePhysicalConnectionInitializer`](https://github.com/npgsql/npgsql/blob/main/src/Npgsql/NpgsqlDataSourceBuilder.cs), npgsql/npgsql (XML-Hinweise zu `DISCARD ALL`)
- [`NpgsqlHistoryRepository.cs` at `v10.0.3`](https://github.com/npgsql/efcore.pg/blob/v10.0.3/src/EFCore.PG/Migrations/Internal/NpgsqlHistoryRepository.cs), npgsql/efcore.pg
- [DISCARD](https://www.postgresql.org/docs/current/sql-discard.html), PostgreSQL-Dokumentation
- [Client Connection Defaults](https://www.postgresql.org/docs/current/runtime-config-client.html), PostgreSQL-Dokumentation (`statement_timeout`, `lock_timeout`, `transaction_timeout`, `search_path`)
- [ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html), PostgreSQL-Dokumentation
- [Connection interception](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/interceptors#connection-interception), EF-Core-Dokumentation
- [PgBouncer configuration](https://www.pgbouncer.org/config.html) (`track_extra_parameters`, `ignore_startup_parameters`)
