---
title: "So protokollieren Sie das SQL, das EF Core 11 generiert"
description: "Sehen Sie das exakte SQL, das Entity Framework Core 11 an Ihre Datenbank sendet, mit Parameterwerten, per LogTo, Microsoft.Extensions.Logging und ToQueryString."
pubDate: 2026-07-19
tags:
  - "ef-core"
  - "dotnet"
  - "csharp"
  - "logging"
lang: "de"
translationOf: "2026/07/how-to-log-the-sql-that-ef-core-11-generates"
translatedBy: "claude"
translationDate: 2026-07-19
---

Der schnellste Weg, das von Entity Framework Core 11 generierte SQL zu sehen, ist der Aufruf von `LogTo(Console.WriteLine)` auf Ihrem `DbContextOptionsBuilder`. Das gibt jeden Befehl aus, den EF Core an die Datenbank sendet, auf der Stufe `Information`, unter der Kategorie `Microsoft.EntityFrameworkCore.Database.Command`. In einer ASP.NET-Core-Anwendung benötigen Sie das meist nicht einmal: Setzen Sie `Microsoft.EntityFrameworkCore.Database.Command` in der `appsettings.json` auf `Information`, und das SQL fließt durch die Protokollierung, die Sie bereits haben. Um die tatsächlichen Parameterwerte statt `?` zu sehen, fügen Sie `EnableSensitiveDataLogging()` hinzu. Um das SQL einer einzelnen Abfrage zu erhalten, ohne sie auszuführen, rufen Sie `.ToQueryString()` auf.

Dieser Beitrag behandelt all diese Optionen, wann jede das richtige Werkzeug ist, und die Details, über die man stolpert: warum Sie standardmäßig nichts sehen, warum Parameter maskiert werden und warum Sie `EnableSensitiveDataLogging` niemals in die Produktion bringen sollten. Alles hier Beschriebene gilt für EF Core 11 und C# 14 unter .NET 11.

## Warum Sie standardmäßig kein SQL sehen

EF Core protokolliert nichts, sofern Sie ihm nicht mitteilen, wohin die Protokolle gesendet werden sollen. Das ist beabsichtigt. Das Erstellen einer Protokollnachricht kostet etwas, daher überspringt EF Core die Arbeit vollständig, wenn kein Ziel konfiguriert ist. Das ist ein Umdenken gegenüber EF6, wo `Database.Log` jederzeit angehängt werden konnte. In EF Core wird die Protokollierung einmalig konfiguriert, bei der Kontextinitialisierung, und das Framework erzeugt Nachrichten nur dann, wenn ein Ziel vorhanden ist.

Jeder SQL-Befehl, den EF Core ausführt, wird als ein einziges Ereignis protokolliert: `RelationalEventId.CommandExecuted`, Ereignis mit der ID `20101`, in der Kategorie `Microsoft.EntityFrameworkCore.Database.Command`, auf der Stufe `LogLevel.Information`. Dieses letzte Detail ist wichtig. Wenn Ihre Protokollierung auf `Warning` und höher gefiltert ist, was ein häufiger Produktionsstandard ist, wird das SQL intern erzeugt, erreicht aber nie Ihr Ziel. Das SQL zu sehen ist fast immer eine Frage des Absenkens der Stufe für diese eine Kategorie, nicht des Betätigens irgendeines speziellen Schalters.

## Die eine Zeile: LogTo

`LogTo` ist die integrierte "einfache Protokollierung" von EF Core. Sie benötigt kein NuGet-Paket und keine Dependency Injection. Sie nimmt eine `Action<string>` entgegen, die EF Core einmal pro Protokollnachricht aufruft.

```csharp
// EF Core 11, C# 14, .NET 11
public sealed class AppDbContext : DbContext
{
    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer("Server=(localdb)\\mssqllocaldb;Database=Shop;Trusted_Connection=True")
            .LogTo(Console.WriteLine);

    public DbSet<Order> Orders => Set<Order>();
}
```

Führen Sie eine Abfrage aus, und Sie erhalten den Befehl, seine Parameter, die Zeit und den SQL-Text:

```output
info: RelationalEventId.CommandExecuted[20101] (Microsoft.EntityFrameworkCore.Database.Command)
      Executed DbCommand (3ms) [Parameters=[@__customerId_0='?' (DbType = Int32)], CommandType='Text', CommandTimeout='30']
      SELECT [o].[Id], [o].[CustomerId], [o].[Total]
      FROM [Orders] AS [o]
      WHERE [o].[CustomerId] = @__customerId_0
```

`OnConfiguring` wird auch dann noch aufgerufen, wenn Sie den Kontext über `AddDbContext` erstellen oder ein vorgefertigtes `DbContextOptions` übergeben, weshalb dies der einzige Ort ist, um die Protokollierungskonfiguration abzulegen, unabhängig davon, wie der Kontext erstellt wird. Wenn Sie die Optionen bereits in der `Program.cs` registrieren, können Sie `LogTo` stattdessen dort anhängen:

```csharp
// EF Core 11, .NET 11 - Program.cs
builder.Services.AddDbContext<AppDbContext>(options =>
    options
        .UseSqlServer(connectionString)
        .LogTo(Console.WriteLine, LogLevel.Information));
```

Das zweite Argument hebt die Mindeststufe an. Standardmäßig gibt `LogTo` alles auf der Stufe `Debug` und höher aus, was laut ist. Die Übergabe von `LogLevel.Information` reduziert es auf den Datenbankzugriff plus einige Verwaltungsnachrichten, was in der Regel das ist, was Sie tatsächlich wollen, wenn Sie einer Abfrage nachgehen.

## Parameterwerte statt Fragezeichen anzeigen

Beachten Sie das `@__customerId_0='?'` in der obigen Ausgabe. EF Core maskiert Parameterwerte standardmäßig, weil sie personenbezogene oder sensible Daten sein können, die nicht in einer Protokolldatei landen dürfen. Wenn Sie lokal debuggen und sehen müssen, welcher Wert tatsächlich gesendet wurde, aktivieren Sie die Protokollierung sensibler Daten:

```csharp
// EF Core 11 - only ever do this in Development
optionsBuilder
    .UseSqlServer(connectionString)
    .LogTo(Console.WriteLine, LogLevel.Information)
    .EnableSensitiveDataLogging();
```

Nun wird der Parameter materialisiert:

```output
Executed DbCommand (2ms) [Parameters=[@__customerId_0='42' (DbType = Int32)], ...]
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[CustomerId] = @__customerId_0
```

Schützen Sie dies hinter einer Umgebungsprüfung, damit es in der Produktion nie aktiviert wird. Ein durchgesickertes Abfrageprotokoll mit echten Schlüsselwerten ist ein echtes Risiko der Datenoffenlegung:

```csharp
// EF Core 11, .NET 11
optionsBuilder.UseSqlServer(connectionString);
if (builder.Environment.IsDevelopment())
{
    optionsBuilder
        .LogTo(Console.WriteLine, LogLevel.Information)
        .EnableSensitiveDataLogging();
}
```

Wenn Sie schon dabei sind: `EnableDetailedErrors()` ist eine nützliche Ergänzung. EF Core überspringt aus Leistungsgründen die try-catch-Blöcke pro Wert, wodurch manche Fehler (zum Beispiel ein `NULL`, das für eine nicht nullbare Eigenschaft zurückkommt) schwer einem bestimmten Feld zuzuordnen sind. `EnableDetailedErrors()` führt diese Prüfungen wieder ein und liefert Ihnen eine Nachricht, die die schuldige Eigenschaft benennt. Es ist eine Debugging-Hilfe, keine Produktionseinstellung.

## Der ASP.NET-Core-Weg: Microsoft.Extensions.Logging

In einer ASP.NET-Core-Anwendung benötigen Sie `LogTo` selten überhaupt. `AddDbContext` und `AddDbContextPool` binden EF Core automatisch in die `Microsoft.Extensions.Logging`-Pipeline der Anwendung ein, sodass das SQL von EF Core durch denselben Logger, dieselben Provider und Filter fließt wie der Rest Ihrer Anwendung. Sie steuern es vollständig aus der `appsettings.json`, indem Sie die Stufe für die Befehlskategorie festlegen:

```json
{
  "Logging": {
    "LogLevel": {
      "Default": "Information",
      "Microsoft.AspNetCore": "Warning",
      "Microsoft.EntityFrameworkCore.Database.Command": "Information"
    }
  }
}
```

Diese eine Zeile ist der ganze Trick. Die Kategorie ist hierarchisch, sodass `Microsoft.EntityFrameworkCore.Database.Command` genau die Ereignisse ausgeführter Befehle anspricht und nichts sonst. Legen Sie sie in der `appsettings.Development.json` ab, um das SQL lokal zu sehen und die Produktion ruhig zu halten, und schalten Sie sie dann ohne erneute Bereitstellung um, wenn Sie in einer laufenden Umgebung etwas diagnostizieren müssen.

Wenn Sie lieber alles im Code halten, oder Sie sich in einer Konsolenanwendung befinden, die den generischen Host verwendet, registrieren Sie eine `ILoggerFactory` und übergeben sie EF Core mit `UseLoggerFactory`. Speichern Sie die Factory als eine einzige gemeinsame Instanz; eine pro Kontext zu erstellen, verursacht ein Speicherleck und hebelt das interne Caching aus.

```csharp
// EF Core 11, .NET 11
public static readonly ILoggerFactory DbLoggerFactory =
    LoggerFactory.Create(b => b.AddConsole().AddFilter(
        "Microsoft.EntityFrameworkCore.Database.Command", LogLevel.Information));

protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
    => optionsBuilder
        .UseSqlServer(connectionString)
        .UseLoggerFactory(DbLoggerFactory);
```

Da dieser Weg Standard-`Microsoft.Extensions.Logging` ist, klinkt sich jeder Provider auf die gleiche Weise ein. Wenn Sie Protokolle über Serilog leiten, landet das SQL von EF Core ohne zusätzliche EF-spezifische Einrichtung in Ihren Senken. Das ist dieselbe Pipeline, die in [strukturierte Protokollierung mit Serilog und Seq](/de/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) behandelt wird; EF Core ist einfach eine weitere Kategorie, die sie speist.

## Bis auf das reine SQL herunterfiltern

`LogTo` bietet Ihnen drei Möglichkeiten, den Strom auf genau die Befehle einzugrenzen, die Sie interessieren. Am lesbarsten ist die Filterung nach Kategorie. Verwenden Sie die stark typisierten Namen von `DbLoggerCategory`, damit Sie keine Zeichenketten fest verdrahten:

```csharp
// EF Core 11 - only database interactions
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { DbLoggerCategory.Database.Command.Name },
    LogLevel.Information);
```

Sie können auch nach Ereignis-ID filtern, wenn Sie ein bestimmtes Ereignis und nichts sonst wollen. Für ausschließlich das rohe SQL ist das `RelationalEventId.CommandExecuted`:

```csharp
// EF Core 11 - only the executed-command event
optionsBuilder.LogTo(
    Console.WriteLine,
    new[] { RelationalEventId.CommandExecuted });
```

Und für alles, was die integrierten Optionen nicht ausdrücken können, übergeben Sie ein Prädikat über `(eventId, logLevel)`. Dies filtert im heißen Pfad von EF Core, bevor die Nachrichtenzeichenkette erstellt wird, und ist daher günstiger als das Filtern innerhalb Ihres Delegates:

```csharp
// EF Core 11 - custom filter
optionsBuilder.LogTo(
    Console.WriteLine,
    (eventId, level) => eventId == RelationalEventId.CommandExecuted);
```

Das Filtern hier ist die Art, wie Sie Abfrageprotokolle lesbar halten, wenn Sie einem bestimmten Problem nachgehen, etwa dem Aufspüren des wiederholten identischen `SELECT`, das eine Lazy-Loading-Schleife verrät. Wenn Sie genau das jagen, ist der Kategorienfilter plus ein Durchsehen der Ausgabe genau die manuelle Version von [N+1-Abfragen in EF Core 11 erkennen](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/).

## Protokolle in eine Datei senden

`LogTo` nimmt jede beliebige `Action<string>` entgegen, sodass das Schreiben in eine Datei nur eine Frage ist, es auf einen `StreamWriter` zu richten. Geben Sie den Writer frei, wenn der Kontext freigegeben wird, damit die Datei sauber geschlossen wird:

```csharp
// EF Core 11, .NET 11
public sealed class AppDbContext : DbContext
{
    private readonly StreamWriter _log = new("ef-sql.log", append: true);

    protected override void OnConfiguring(DbContextOptionsBuilder optionsBuilder)
        => optionsBuilder
            .UseSqlServer(connectionString)
            .LogTo(_log.WriteLine, LogLevel.Information);

    public override void Dispose()
    {
        base.Dispose();
        _log.Dispose();
    }

    public override async ValueTask DisposeAsync()
    {
        await base.DisposeAsync();
        await _log.DisposeAsync();
    }
}
```

Für eine schlankere Datei fordern Sie einzeilige Ausgabe und UTC-Zeitstempel über `DbContextLoggerOptions` an:

```csharp
// EF Core 11 - compact one-line-per-message format
optionsBuilder.LogTo(
    _log.WriteLine,
    LogLevel.Information,
    DbContextLoggerOptions.UtcTime | DbContextLoggerOptions.SingleLine);
```

Für alles jenseits einer Wegwerf-Debugging-Datei sollten Sie über `Microsoft.Extensions.Logging` und eine echte Datei-Senke leiten. `LogTo` auf einen `StreamWriter` ist für einen kurzen Blick in Ordnung; es ist keine Protokollierungsstrategie für die Produktion.

## Das SQL einer Abfrage erhalten, ohne sie auszuführen

Manchmal wollen Sie keinen Schwall mit jedem Befehl. Sie haben eine LINQ-Abfrage und möchten das SQL sehen, das sie erzeugen wird. `ToQueryString()` gibt das SQL einer `IQueryable` wieder, ohne sie gegen die Datenbank auszuführen:

```csharp
// EF Core 11, C# 14
var query = db.Orders
    .Where(o => o.Total > 100)
    .OrderByDescending(o => o.Total);

Console.WriteLine(query.ToQueryString());
```

```output
SELECT [o].[Id], [o].[CustomerId], [o].[Total]
FROM [Orders] AS [o]
WHERE [o].[Total] > 100.0
ORDER BY [o].[Total] DESC
```

Dies ist das Werkzeug, zu dem Sie greifen, wenn Sie eine Abfrage in einem Test oder einem Entwurfs-Endpunkt verfeinern, denn es gibt keine Protokollkonfiguration einzurichten und kein weiteres Rauschen. Es funktioniert nur für Abfragen (`IQueryable`), nicht für `SaveChanges`, `ExecuteUpdate` oder `ExecuteDelete`; dafür greifen Sie auf `LogTo` oder die Befehlskategorie zurück. Wenn Sie über das SQL nachdenken, das Massenoperationen ausgeben, sind die in [ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/) gezeigten Formen das, was Sie im Befehlsprotokoll sehen werden.

## Details, die man kennen sollte

**`CommandExecuted` wird nach dem Roundtrip ausgelöst.** Das Ereignis `20101` trägt die Zeit, daher wird es protokolliert, sobald der Befehl zurückkehrt. Wenn eine Abfrage hängt, sehen Sie ihr SQL nicht im Ausführungsprotokoll, weil sie nie abgeschlossen wurde. Achten Sie auf `CommandExecuting` (`20100`), wenn Sie das SQL vor der Ausführung benötigen, oder verwenden Sie `ToQueryString()`, um es statisch zu inspizieren.

**Die Konfiguration wird bei der Initialisierung festgelegt.** Sie können `LogTo` nicht anhängen oder abtrennen, nachdem der Kontext erstellt wurde. Wenn Sie einen Laufzeitschalter wollen, erfassen Sie das Delegate und führen eine Null-Prüfung durch: `optionsBuilder.LogTo(s => _sink?.Invoke(s))`, und setzen dann `_sink` bei Bedarf. Dies spiegelt das alte Verhalten von `Database.Log` aus EF6 wider.

**Rufen Sie `LogTo` nicht zweimal mit der Absicht auf, Ziele hinzuzufügen.** Ein zweiter Aufruf ersetzt die Konfiguration, anstatt sie zu ergänzen. Um auf mehrere Ziele zu verteilen, schreiben Sie ein Delegate, das an jedes weiterleitet.

**Die Protokollierung sensibler Daten und die ausführlichen Fehler sind beide nur für die Entwicklung.** `EnableSensitiveDataLogging` schreibt echte Parameterwerte, einschließlich Schlüssel und personenbezogener Daten, in Ihre Protokolle. `EnableDetailedErrors` fügt Mehraufwand pro Lesevorgang hinzu. Schützen Sie beide hinter einer Umgebungsprüfung. Auch hier kann ein unerwartet lautes Protokoll mehr preisgeben, als Sie beabsichtigen, prüfen Sie also, was Ihre Senken aufbewahren.

**Die Kategorie, nicht ein Schalter, ist Ihre Produktionssteuerung.** Lassen Sie EF Core in einer bereitgestellten Anwendung in `Microsoft.Extensions.Logging` eingebunden und steuern Sie die Sichtbarkeit rein über die Stufe von `Microsoft.EntityFrameworkCore.Database.Command`. Sie erhalten SQL bei Bedarf, indem Sie einen einzigen Konfigurationswert ändern, und versenden nie ein `LogTo(Console.WriteLine)`, das Sie zu entfernen vergessen haben.

Das Lesen des generierten SQL ist der erste Schritt in fast jeder Leistungsuntersuchung von EF Core, von einer Abfrage, die stillschweigend auf dem Client ausgewertet wird, bis zu einer Migration, die mehr ausgibt als erwartet. Sobald Sie es sehen können, werden die Lösungen in [der LINQ-Ausdruck konnte nicht übersetzt werden](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) und die Hinweise zu Breaking Changes in [Migration von EF Core 6 zu EF Core 11](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) deutlich leichter anwendbar, weil Sie das tatsächliche SQL debuggen, statt darüber zu rätseln.

## Quellen

- [EF Core simple logging (LogTo) - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/simple-logging)
- [Using Microsoft.Extensions.Logging with EF Core - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/logging-events-diagnostics/extensions-logging)
- [ToQueryString / viewing generated SQL - Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/#viewing-generated-sql)
- [RelationalEventId.CommandExecuted - .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationaleventid.commandexecuted)
