---
title: "Fix: SqlException: Timeout expired bei EF Core-Migrationen"
description: "Migrationen verwenden den Design-Time-DbContext, nicht Ihr Runtime-CommandTimeout. Setzen Sie das Timeout über UseSqlServer(o => o.CommandTimeout(...)), das Command Timeout in der Verbindungszeichenfolge oder Database.SetCommandTimeout vor Migrate()."
pubDate: 2026-05-14
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "migrations"
lang: "de"
translationOf: "2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations"
translatedBy: "claude"
translationDate: 2026-05-14
---

Der Fix: `dotnet ef database update` verbindet sich über den Design-Time-`DbContext`, führt jeden Migrationsschritt als einzelnen Befehl aus und erbt das `CommandTimeout` von 30 Sekunden, das im SQL-Server-Provider voreingestellt ist. Lange Migrationen (großes `AlterColumn`, Index-Neuaufbau, Backfills) überschreiten die 30 Sekunden, und SqlClient wirft `Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired`. Setzen Sie das Timeout an drei Stellen, in dieser Reihenfolge der Präferenz: ein providerseitiges `o.CommandTimeout(600)` an `UseSqlServer`, ein `Command Timeout=600` in der Verbindungszeichenfolge, die zur Design-Zeit verwendet wird, oder wenden Sie Migrationen aus Ihrer Anwendung mit `context.Database.SetCommandTimeout(TimeSpan.FromMinutes(10))` vor dem Aufruf von `Migrate()` an. Die CLI `dotnet ef database update` selbst hat in EF Core 11 keinen `--command-timeout`-Schalter, und das ist die einzige Tatsache, die bei der Jagd nach diesem Fehler am meisten Zeit kostet.

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Execution Timeout Expired.
The timeout period elapsed prior to completion of the operation or the server is not responding.
 ---> System.ComponentModel.Win32Exception (258): The wait operation timed out.
   at Microsoft.Data.SqlClient.SqlCommand.<>c.<ExecuteDbDataReaderAsync>b__214_0(Task`1 result)
   at Microsoft.EntityFrameworkCore.Storage.RelationalCommand.ExecuteReader(RelationalCommandParameterObject parameterObject)
   at Microsoft.EntityFrameworkCore.Migrations.MigrationCommandExecutor.ExecuteNonQuery(IEnumerable`1 migrationCommands, IRelationalConnection connection, MigrationExecutionState executionState, Boolean commitTransaction, Nullable`1 isolationLevel)
   at Microsoft.EntityFrameworkCore.Migrations.Internal.Migrator.Migrate(String targetMigration)
   at Microsoft.EntityFrameworkCore.Design.Internal.MigrationsOperations.UpdateDatabase(String targetMigration, String connectionString, String contextType)
ClientConnectionId:7c2f9aa3-...
Error Number:-2,State:0,Class:11
```

Dieser Leitfaden wurde gegen .NET 11 Preview 4, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-preview.4, `Microsoft.Data.SqlClient` 6.0.x und `dotnet-ef` 11.0.0-preview.4 verfasst. Die Fehlermeldung ist über SqlClient-Versionen hinweg stabil geblieben, lediglich der Namespace hat sich von `System.Data.SqlClient` zu `Microsoft.Data.SqlClient` verschoben, als der Provider in EF Core 3.0 gewechselt wurde. Die `Error Number:-2` ist das kanonische Signal: ein Wert von `-2` in `SqlException.Number` bedeutet das clientseitige Command-Timeout, nicht einen serverseitigen Fehler. Wenn Sie `Error Number:1222` oder einen anderen positiven Code sehen, haben Sie es mit einem anderen Problem zu tun (Lock-Wait, Login-Fehler), das der Rest dieses Beitrags nicht löst.

## Warum Migrationen ablaufen, wo Runtime-Abfragen es nicht tun

Während einer Migration sind zwei `DbContext`-Instanzen im Spiel. Die, die Ihre ASP.NET-Core-Anwendung zur Laufzeit verwendet, konfiguriert über `AddDbContext`, und die, die `dotnet ef` zur Design-Zeit erzeugt. Sie sind nicht dieselbe Instanz und teilen sich nicht zwingend die Konfiguration. Das Migrations-Tooling von EF Core entdeckt einen `DbContext` über einen von drei Mechanismen, die in der [EF-Core-CLI-Referenz](https://learn.microsoft.com/de-de/ef/core/cli/dotnet) dokumentiert sind: es ruft eine öffentliche statische `CreateHostBuilder(string[])` in Ihrer `Program`-Klasse auf, es sucht nach einer `IDesignTimeDbContextFactory<TContext>`, oder es fällt darauf zurück, den Host Ihrer Anwendung auszuführen, sodass `AddDbContext` den Kontext registriert. Auf jedem Pfad baut es einen frischen `DbContext` und nutzt diesen für die Migrationen.

Das voreingestellte `CommandTimeout` des SQL-Server-Providers ist das zugrundeliegende `SqlCommand`-Default, also 30 Sekunden. Ein `SetCommandTimeout`, das Sie irgendwo in einer Request-Pipeline aufrufen, läuft auf der Runtime-Instanz, nicht auf der Design-Time-Instanz. Ein `AlterColumn`, das 90 Sekunden dauert, weil die Tabelle 8 Millionen Zeilen hat, endet als einzelner Befehl an einem `DbCommand`, dessen `CommandTimeout` 30 beträgt, und SqlClient bricht ihn nach 30 Sekunden ab.

Zwei Dinge machen dies schlimmer als nötig. Erstens schreibt eine Migration ihre Zeile in `__EFMigrationsHistory` nur bei Erfolg. Wenn der Befehl auf halbem Weg abläuft, können Sie mit einem teilweise angewendeten Schema enden, die Migrations-Zeile fehlt, und der nächste `dotnet ef database update` versucht die gleiche lange Operation von vorn. Zweitens umschließt EF Core 9 und neuere Versionen jede Migration standardmäßig in einer Transaktion, sofern Sie nicht ausdrücklich darauf verzichten. Wenn das Command-Timeout zuschlägt, rollt SQL Server die gesamte Migration zurück, was das sicherere Ergebnis ist, aber auch dasjenige, das Sie weitere 30 Sekunden Wall-Time beim nächsten Versuch kostet.

Die CLI-Seite der Geschichte ist klar. `dotnet ef database update` akzeptiert `--connection`, `--context`, `--project`, `--startup-project` und die üblichen Optionen. Es gibt kein `--command-timeout`. Das EF-Core-Team verfolgt dies seit Jahren als [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613); die kanonische Antwort bleibt "konfigurieren Sie es in der `DbContext`-Konfiguration."

## Minimales Repro

Eine Tabelle mit genügend Zeilen, sodass jedes `AlterColumn` mehr als 30 Sekunden dauert, genügt.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class Order
{
    public int Id { get; set; }
    public string Reference { get; set; } = "";
    public decimal Total { get; set; }
}

public class OrdersContext : DbContext
{
    public DbSet<Order> Orders => Set<Order>();

    protected override void OnConfiguring(DbContextOptionsBuilder options)
        => options.UseSqlServer(
            "Server=localhost;Database=Orders;Integrated Security=true;Encrypt=false");
}
```

Fügen Sie eine Migration hinzu, die `Reference` von `nvarchar(50)` auf `nvarchar(450)` verbreitert, sodass SQL Server jede Zeile umschreiben muss, statt nur eine reine Metadatenänderung vorzunehmen:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public partial class WidenReference : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.AlterColumn<string>(
            name: "Reference",
            table: "Orders",
            type: "nvarchar(450)",
            maxLength: 450,
            nullable: false,
            oldClrType: typeof(string),
            oldType: "nvarchar(50)",
            oldMaxLength: 50);
    }
}
```

Führen Sie `dotnet ef database update` gegen eine `Orders`-Tabelle mit einigen Millionen Zeilen aus. Mit dem voreingestellten 30-Sekunden-Timeout wirft der Befehl exakt den Stack Trace vom Anfang dieses Beitrags.

## Der Fix im Detail

Wählen Sie die Option, die dazu passt, wie Migrationen in Ihrem Projekt angewendet werden. Die Reihenfolge unten ist nach Wartbarkeit, nicht nach Einfachheit.

### 1. CommandTimeout am Provider in Ihrer DbContext-Konfiguration setzen

Dies ist der kanonische Fix. Er heftet das Timeout an den `DbContext`, sodass jeder Codepfad, Design-Zeit und Laufzeit, denselben Wert erhält.

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class OrdersContext : DbContext
{
    public OrdersContext(DbContextOptions<OrdersContext> options) : base(options) { }
}

// Program.cs
builder.Services.AddDbContext<OrdersContext>(options =>
    options.UseSqlServer(
        builder.Configuration.GetConnectionString("Orders"),
        sql => sql.CommandTimeout(600))); // 10 minutes
```

Das zweite Argument von `UseSqlServer` ist eine `Action<SqlServerDbContextOptionsBuilder>`. `CommandTimeout(int seconds)` lebt im [SqlServerDbContextOptionsBuilder](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout). Es setzt das `CommandTimeout` für jedes `DbCommand`, das EF Core auf diesem Kontext erzeugt, einschließlich derjenigen, die der Migrations-Runner versendet.

Wenn Sie eine `IDesignTimeDbContextFactory<OrdersContext>` für Tooling haben, setzen Sie es dort ebenfalls. `dotnet ef` bevorzugt `IDesignTimeDbContextFactory<T>` gegenüber `CreateHostBuilder`, wenn beide vorhanden sind, also greift dieser Override bei Design-Time-Läufen:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
public class OrdersContextFactory : IDesignTimeDbContextFactory<OrdersContext>
{
    public OrdersContext CreateDbContext(string[] args)
    {
        var connectionString = Environment.GetEnvironmentVariable("ORDERS_CONNECTION")
            ?? "Server=localhost;Database=Orders;Integrated Security=true;Encrypt=false";

        var options = new DbContextOptionsBuilder<OrdersContext>()
            .UseSqlServer(connectionString, sql => sql.CommandTimeout(600))
            .Options;

        return new OrdersContext(options);
    }
}
```

### 2. `Command Timeout` in die Verbindungszeichenfolge setzen

Wenn Sie den `DbContext` nicht bearbeiten können (Sie migrieren das Paket einer anderen Person, oder Ihre Design-Time-Discovery nutzt eine vom CI übergebene Verbindungszeichenfolge), setzen Sie das Timeout in der Verbindungszeichenfolge, und SqlClient wendet es auf jeden Befehl an:

```text
Server=tcp:prod-sql.contoso.com;Database=Orders;Authentication=Active Directory Default;Encrypt=true;Command Timeout=600
```

Das Schlüsselwort `Command Timeout` wird von `Microsoft.Data.SqlClient` unterstützt und propagiert an `SqlCommand.CommandTimeout`. CI-Pipelines, die ein Migrations-Bundle versenden und `--connection` durchreichen, erhalten dies kostenlos:

```bash
./efbundle --connection "Server=...;Command Timeout=600"
```

Das Bundle-Executable hat keinen eigenen `--timeout`-Schalter (siehe [die Referenz zu `dotnet ef migrations bundle`](https://learn.microsoft.com/de-de/ef/core/cli/dotnet#dotnet-ef-migrations-bundle)). Die Verbindungszeichenfolge ist der einzige Stellknopf, den das Bundle anbietet.

### 3. Migrationen aus dem Code mit `SetCommandTimeout` anwenden

Wenn Sie `context.Database.Migrate()` aus Ihrer Anwendung aufrufen (ein üblicher Stil für selbst gehostete Dienste und Integrationstests), setzen Sie das Timeout auf der lebenden `Database`-Fassade unmittelbar vor dem Aufruf. `SetCommandTimeout` mutiert das Runtime-Command-Timeout auf der Verbindung des Kontexts:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
using var scope = app.Services.CreateScope();
var db = scope.ServiceProvider.GetRequiredService<OrdersContext>();

db.Database.SetCommandTimeout(TimeSpan.FromMinutes(10));
await db.Database.MigrateAsync();
```

`Database.SetCommandTimeout` ist in den [RelationalDatabaseFacadeExtensions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout) dokumentiert. Es akzeptiert ein `int` (Sekunden) oder `TimeSpan`. Der Wert bleibt für die Lebensdauer des Kontexts bestehen, also reicht ein einmaliges Setzen, um einen vollständigen `MigrateAsync`-Aufruf abzudecken. Dies ist das richtige Muster für [Integrationstests, die einen echten SQL Server mit Testcontainers hochfahren](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), da der Test-Orchestrator das Anwenden der Migration übernimmt.

## Feinheiten und Varianten, die der Suchverkehr vermischt

### "Timeout expired" mit `Error Number != -2`

Wenn `SqlException.Number` nicht `-2` ist, ist Ihr Problem kein clientseitiges Command-Timeout. Die zwei häufigsten Alternativen, die denselben Wortlaut tragen, sind:

- `Error Number:1222` ist ein Lock-Wait-Timeout. Eine andere Sitzung hält ein Lock auf dem Objekt, das Sie ändern wollen, und die Einstellung `LOCK_TIMEOUT` von SQL Server hat ausgelöst. `CommandTimeout` zu erhöhen wird gegen dieselbe Wand laufen; der Fix ist, den Blocker zu finden (`sp_who2`, `sys.dm_exec_requests`).
- `Error Number:-2` mit `State:0,Class:11` und einer `ClientConnectionId` ist das kanonische clientseitige SqlClient-Command-Timeout, das dieser Beitrag behebt.

### Connection Timeout vs Command Timeout

`Connection Timeout=30` (auch als `Connect Timeout` geschrieben) in der Verbindungszeichenfolge gibt an, wie lange SqlClient auf das Öffnen der TCP-Verbindung wartet. Es beeinflusst nicht, wie lange ein einzelner Befehl laufen darf. Wenn Sie nur `Connection Timeout` und nicht `Command Timeout` geändert haben, haben Sie den falschen Stellknopf gedreht. Dokumente vor EF Core 11 verwenden die beiden in Prosa manchmal austauschbar; die tatsächlichen Property-Namen sind eindeutig.

### Migrationen, die mehrere `AlterColumn`-Aufrufe bündeln

EF Core gruppiert die Operationen einer einzelnen `Up`-Methode standardmäßig in einer Transaktion. Der 30-Sekunden-Timer gilt pro `DbCommand`, nicht pro Migration, aber ein einzelnes `AlterColumn` auf einer heißen Tabelle ist leicht ein langer Befehl. Wenn Sie mehrere lange Operationen in einer Migration haben, reicht es, `CommandTimeout` einmal zu erhöhen; Sie müssen die Migration nicht aufteilen. Wenn Sie sie doch aufteilen wollen, erlauben Ihnen die [Single-Step-Migrations-Befehle von EF Core 11 wie `dotnet ef migrations update --add`](/de/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/), die Arbeit sauberer zu staffeln.

### Azure SQL drosselt die lange Migration

Wenn Sie das Timeout auf 30 Minuten anheben und die Migration trotzdem nach etwa 60 Sekunden mit derselben Meldung scheitert, treffen Sie nicht das Client-Timeout, sondern das Azure-SQL-Gateway. Das Gateway hält inaktive TCP-Sitzungen, kann aber Sitzungen bei Failover, Throttling oder Service-Updates verwerfen. Zwei Minderungsmaßnahmen: Verwandeln Sie die Operation in einen Online-Index-Neuaufbau mit `WITH (ONLINE = ON)`, sodass das lange Lock in kürzere zerfällt, und aktivieren Sie [`EnableRetryOnFailure`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.enableretryonfailure), damit der Migrations-Runner die Operation unter derselben Transient-Fault-Policy wiederholt, die Ihre Anwendung bereits verwendet:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-preview.4
options.UseSqlServer(connectionString, sql =>
{
    sql.CommandTimeout(1800);              // 30 minutes
    sql.EnableRetryOnFailure(
        maxRetryCount: 3,
        maxRetryDelay: TimeSpan.FromSeconds(30),
        errorNumbersToAdd: null);
});
```

### "Es funktioniert auf meiner Maschine, schlägt im CI fehl"

Zwei spezifische Ursachen. Erstens ist Ihr lokaler SQL Server klein und die Tabelle hat 200 Zeilen, also schließt `AlterColumn` in 200 ms ab. CI läuft gegen eine Staging-Datenbank mit der echten Zeilenanzahl, wo derselbe Befehl Minuten dauert. Zweitens nutzt Ihre lokale Anwendung die Runtime-`DbContext`-Konfiguration mit einem großzügigen `CommandTimeout`, während das CI `dotnet ef database update` ausführt und einen anderen Design-Time-`DbContext` entdeckt, der Ihren Override nicht enthält. Die [Discovery-Regeln für den Design-Time-`DbContext`](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) erklären, warum das CI mit einem anderen Kontext endet als Ihre Anwendung zur Laufzeit.

### Async- vs. Sync-Timeout-Verhalten

`SqlException.Number == -2` schlägt identisch für `ExecuteNonQuery` und `ExecuteNonQueryAsync` zu. Der Wechsel zu `MigrateAsync` rettet Sie nicht, er befreit lediglich den aufrufenden Thread. `SetCommandTimeout` ist der einzige relevante Stellknopf.

### Die Migrations-Historien-Tabelle ist halb geschrieben

Wenn der Befehl die Verbindung mittendrin gekappt hat und Sie beim nächsten Lauf hängen, weil EF Core glaubt, die Migration sei angewendet, schauen Sie in `__EFMigrationsHistory`. Wenn die Zeile fehlt, aber die Spaltenänderung teilweise angewendet ist, können Sie das teilweise DDL mit einem einzigen `ALTER` manuell zurückrollen und die Migration erneut ausführen, oder die Zeile in `__EFMigrationsHistory` einfügen und eine Folge-Migration schreiben, die die Arbeit beendet. Löschen Sie keine unzusammenhängenden Zeilen aus dieser Tabelle, EF Core nutzt sie, um zu bestimmen, welche `Down()`-Operationen ausgeführt werden.

## Verwandt

- [Fix: dotnet ef migrations add schlägt mit "Unable to create an object of type DbContext" fehl](/de/2026/05/fix-dotnet-ef-migrations-add-unable-to-create-dbcontext/) für das vorgelagerte Design-Time-Discovery-Problem.
- [EF Core 11 Single-Step-Migrationen mit dotnet ef migrations update --add](/de/2026/04/efcore-11-single-step-migrations-dotnet-ef-update-add/), falls eine lange Migration einfacher aufzuteilen als das Timeout anzuheben ist.
- [Integrationstests gegen einen echten SQL Server mit Testcontainers schreiben](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), da `Database.SetCommandTimeout` plus `MigrateAsync` das Standard-Test-Setup-Muster ist.
- [Fix: A second operation was started on this context instance](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/) für eine andere zeitlich gefärbte Exception, die oft zusammen mit dieser gesucht wird.
- [N+1-Abfragen in EF Core 11 erkennen](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) für die Art von Runtime-Regression, die so viel Last auf die Datenbank legt, dass selbst kleine Migrationen anfangen abzulaufen.

## Quellen

- [EF-Core-CLI-Referenz](https://learn.microsoft.com/en-us/ef/core/cli/dotnet) - die kanonische Liste der `dotnet ef`-Optionen.
- [SqlServerDbContextOptionsBuilder.CommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.sqlserverdbcontextoptionsbuilder.commandtimeout) API-Dokumentation.
- [RelationalDatabaseFacadeExtensions.SetCommandTimeout](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.setcommandtimeout) API-Dokumentation.
- [dotnet/efcore#6613](https://github.com/dotnet/efcore/issues/6613) "Allow customizing migration commands timeout" verfolgt, warum kein CLI-Schalter existiert.
- [dotnet/efcore#22887](https://github.com/dotnet/efcore/issues/22887) deckt den Migration-Bundle-Fall und die Workaround-Lösung über die Verbindungszeichenfolge ab.
