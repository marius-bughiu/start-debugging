---
title: "EF Core 11 vs. Dapper für Bulk-Inserts: echtes Benchmark"
description: "Für Bulk-Inserts in .NET 11 gewinnt weder EF Core noch Dapper. SqlBulkCopy gewinnt. Das ist das Benchmark, das Warum und der Platz, den jedes Werkzeug verdient."
pubDate: 2026-05-20
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "bulk-insert"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark"
translatedBy: "claude"
translationDate: 2026-05-20
---

Wenn Sie aus .NET 11 mehr als ein paar Tausend Zeilen in SQL Server einfügen, lautet die richtige Antwort selten "EF Core" und selten "Dapper". Die richtige Antwort ist `SqlBulkCopy`, direkt aus der Verbindung beider Werkzeuge aufgerufen. `AddRange` + `SaveChangesAsync` von EF Core 11 ist die sauberste Wahl für weniger als 1.000 Zeilen. `ExecuteAsync` von Dapper mit einer Parameterliste ist von den dreien bei jeder Zeilenanzahl das schlechteste und das, was Sie für Bulk-Loads meiden sollten. Unten finden Sie die Entscheidungstabelle, die Benchmark-Zahlen dahinter und den Code für jeden Pfad auf `Microsoft.EntityFrameworkCore` 11.0.0, `Microsoft.Data.SqlClient` 6.1 und `Dapper` 2.1.66.

## Funktionsmatrix auf einen Blick

| Funktion                                          | EF Core 11 `AddRange`           | Dapper `ExecuteAsync`         | `SqlBulkCopy`                         |
| ------------------------------------------------- | ------------------------------- | ----------------------------- | ------------------------------------- |
| Zugrundeliegendes Protokoll                       | Gebündelte `INSERT`-Anweisungen | `INSERT`-Anweisungen pro Zeile | TDS Bulk Copy (nativer Bulk-Load)    |
| Change Tracking                                   | Ja                              | Nein                          | Nein                                  |
| Identitätswerte zurück auf die Entität geschrieben | Ja (via `OUTPUT INSERTED.Id`)  | Nein (manuelles `SELECT SCOPE_IDENTITY()`) | Nur mit `KeepIdentity` und expliziten Werten |
| Beziehungen und kaskadierende Inserts             | Ja                              | Nein                          | Nein                                  |
| Speicher bei 100K Zeilen (SQL Server)             | ~Hunderte MB                    | ~Dutzende MB                  | ~Dutzende MB, streaming-freundlich    |
| Insert-Zeit für 100K Zeilen (siehe Methodik)      | ~2,1 s                          | ~10,9 s                       | ~0,65 s                               |
| Insert-Zeit für 1M Zeilen                         | ~21,6 s                         | ~109 s                        | ~7,3 s                                |
| Nur SQL Server                                    | Nein (läuft auf jedem EF-Provider) | Nein                      | Ja (`Microsoft.Data.SqlClient`)       |
| Code-Komplexität                                  | Am niedrigsten                  | Niedrig                       | Mittel (Tabellen-Mapping erforderlich) |
| Funktioniert mit `IAsyncEnumerable<T>`-Streaming  | Nein (lädt Entitäten zuerst)    | Nein                          | Ja (via `IDataReader`)                |
| Transaktion mit dem Rest des EF-Unit-of-Work      | Ja                              | Manuell                       | Manuell (`SqlTransaction`)            |
| Lizenz                                            | MIT                             | Apache 2.0                    | MIT                                   |

Die Tabelle ist die Empfehlung. Alles darunter ist das *Warum*.

## Wann `AddRange` + `SaveChangesAsync` von EF Core 11 korrekt ist

EF Core 11 bündelt Inserts intelligent. Der SQL-Server-Provider gruppiert eingefügte Entitäten in mehrzeilige `INSERT ... VALUES (...), (...), ...`-Anweisungen mit bis zu 1.000 Zeilen pro Batch (das harte Limit von SQL Server für tabellenwertige Parameter) oder splittet bei 2.100 Parametern pro Batch, je nachdem was zuerst eintritt. Für eine Entität mit 200 Spalten kollabiert die praktische Batch-Größe auf einstellige Zeilenzahlen, weil Parameter dominieren; für eine Entität mit fünf Spalten bekommen Sie die vollen 1.000-Zeilen-Batches.

Wählen Sie `AddRange`, wenn:

- Sie weniger als ~1.000 Zeilen in einem einzigen Aufruf einfügen.
- Die Entitäten Beziehungen haben (ein Parent und seine Children), die der Change Tracker von EF Core in einer Transaktion für Sie handhabt.
- Sie die von der Datenbank generierten Identitätswerte zurück auf die Entitätsinstanzen geschrieben benötigen (`OUTPUT INSERTED.Id` macht das in EF Core 11 automatisch).
- Die gleiche Unit of Work auch andere Entitäten aktualisiert oder löscht. Den Bulk-Insert in den bestehenden `SaveChangesAsync` zu legen bedeutet eine Transaktion, ein Set von Pre/Post-Hooks, und die [`ChangeTracker`-Ereignisse](https://learn.microsoft.com/en-us/ef/core/change-tracking/) feuern weiterhin.

```csharp
// .NET 11, EF Core 11.0.0
public async Task InsertEventsAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var db = new AppDbContext(_options);
    db.TelemetryEvents.AddRange(events);
    await db.SaveChangesAsync(ct);
}
```

Das ist der Platz, für den EF Core entworfen wurde. Die Kosten sind Allokation: jede Entität wird materialisiert, im Change Tracker verfolgt und im `DbContext` gehalten, bis `SaveChanges` committet. Für 100K Zeilen einer breiten Entität sind das Hunderte Megabyte GC-Druck. Für 1.000 Zeilen ist es irrelevant.

Wenn Sie diesen Weg für mittlere Batches gehen, helfen zwei Stellschrauben:

- `AsNoTracking` ist nicht der relevante Hebel für Inserts (es betrifft Abfragen). Verwenden Sie stattdessen einen kurzlebigen `DbContext` pro Batch und entsorgen Sie ihn.
- `ChangeTracker.AutoDetectChangesEnabled = false;` vor dem `AddRange` und danach wieder aktivieren. EF Core 11 führt `DetectChanges` immer noch innerhalb von `SaveChangesAsync` aus, aber es bei jeder Property-Zuweisung zu überspringen spart messbare CPU bei breiten Entitäten.

## Wann `ExecuteAsync` von Dapper korrekt ist (und wann nicht)

Die Bulk-Geschichte von Dapper ist berühmt einfach: übergeben Sie eine Collection, bekommen Sie einen INSERT pro Zeile in einem Netzwerk-Roundtrip.

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
await conn.ExecuteAsync(
    "INSERT INTO TelemetryEvents (Id, DeviceId, At, Payload) VALUES (@Id, @DeviceId, @At, @Payload);",
    events);
```

Angenehm zu schreiben. Langsam in der Skalierung. Dapper sendet eine parametrisierte Anweisung pro Element in der Collection, gebündelt in einem einzigen Netzwerk-Roundtrip. SQL Server parst, plant und führt trotzdem jeden `INSERT` einzeln aus. Es gibt keine Zeilenbündelung wie bei EF Core, kein natives Bulk-Protokoll und keine Parallelität auf Anweisungsebene.

Wählen Sie Dappers `ExecuteAsync` für Inserts, wenn:

- Sie weniger als ~100 Zeilen einfügen und Dapper bereits für Lesevorgänge verwenden.
- Sie eine einzige Anweisung mit `INSERT ... SELECT ... FROM (VALUES ...)` wollen und das SQL selbst schreiben.
- Sie die EF-Core-Abhängigkeit in diesem Code-Pfad nicht wollen (ein Microservice, der eine Tabelle besitzt und Dapper für alles andere verwendet).

Wählen Sie Dapper *nicht* für Bulk-Inserts mit >1.000 Zeilen. Die Kosten pro Zeile sind real, die Netzwerkersparnis ist klein, und Sie haben ein besseres Werkzeug einen Namespace entfernt. Wenn Sie nach einem "schnellen" Insert aus Dapper greifen, wollen Sie fast sicher `Dapper.Plus` (kommerziell) oder, ehrlicher gesagt, das `SqlBulkCopy`, das Sie aus der gleichen `SqlConnection` aufrufen können, die Dapper bereits besitzt.

## Wann `SqlBulkCopy` korrekt ist (fast immer für "Bulk")

[`Microsoft.Data.SqlClient.SqlBulkCopy`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy) verwendet das gleiche TDS-Bulk-Load-Protokoll wie `bcp` und `BULK INSERT`. Der Server überspringt Parser, Optimizer und Logging pro Zeile zugunsten eines gestreamten Binärformats. Bei Zeilenzahlen über ~10.000 ist nichts in der verwalteten Welt auf SQL Server in der gleichen Liga.

```csharp
// .NET 11, Microsoft.Data.SqlClient 6.1.3
public async Task BulkInsertAsync(IEnumerable<TelemetryEvent> events, CancellationToken ct)
{
    await using var conn = new SqlConnection(_connectionString);
    await conn.OpenAsync(ct);

    using var bulk = new SqlBulkCopy(conn, SqlBulkCopyOptions.TableLock, externalTransaction: null)
    {
        DestinationTableName = "dbo.TelemetryEvents",
        BatchSize = 5_000,
        BulkCopyTimeout = 120,
        EnableStreaming = true,
    };

    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Id), "Id");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.DeviceId), "DeviceId");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.At), "At");
    bulk.ColumnMappings.Add(nameof(TelemetryEvent.Payload), "Payload");

    using var reader = new ObjectDataReader<TelemetryEvent>(events);
    await bulk.WriteToServerAsync(reader, ct);
}
```

Die `IDataReader`-Überladung ist die, die Sie verwenden sollten. Die `DataTable`-Überladung funktioniert und ist einfacher zu demonstrieren, aber sie materialisiert jede Zeile in eine `DataTable`, bevor das erste Byte auf die Leitung geht. Die `IDataReader`-Überladung streamt: Zeilen werden eine nach der anderen aus Ihrem Enumerable gezogen und an den Server gepusht, sobald der Batch sich füllt, was das Working Set selbst bei Millionen von Zeilen flach hält.

`ObjectDataReader<T>` umfasst etwa 80 Zeilen (der verlinkte Beitrag von Milan Jovanović enthält eine vollständige Version) und konvertiert ein `IEnumerable<T>` über gecachte `PropertyInfo`-Lookups in die `IDataReader`-Schnittstelle. `ObjectReader.Create(events)` von `FastMember` ist das Off-the-Shelf-Äquivalent, falls Sie es nicht selbst schreiben möchten.

Drei Optionen, die Sie bei jeder Bulk-Copy setzen sollten:

- `TableLock` nimmt für die Dauer der Kopie eine exklusive Tabellensperre. Es ist die größte Performance-Stellschraube: ohne sie nimmt SQL Server Zeilen- oder Seitensperren, und die Buchhaltung dominiert. Mit ihr können Sie keine gleichzeitigen Writer haben, also reservieren Sie sie für Staging- oder Off-Hours-Loads.
- `EnableStreaming = true` aktiviert das Streaming-Protokoll für die `IDataReader`-Überladung. Ohne es puffert der Client jeden Batch vollständig.
- `BatchSize` steuert, wann Teil-Commits passieren. Der Standard ist "ein Batch für die ganze Kopie", was bedeutet, dass ein Fehler alles zurückrollt. Setzen Sie eine `BatchSize` ungleich Null, und Sie bekommen einen Commit pro Batch, was die Wiederherstellung beschleunigt und das Wachstum des Transaktionslogs begrenzt.

Für PostgreSQL ist das Äquivalent [`NpgsqlBinaryImporter`](https://www.npgsql.org/doc/copy.html) (`COPY ... FROM STDIN BINARY`). Für MySQL `MySqlBulkCopy`. Für Oracle `OracleBulkCopy`. Die Form ist identisch: Zeilen aus einem Reader in ein Binärprotokoll streamen, das den SQL-Parser umgeht.

## Das Benchmark

Diese Zahlen stammen aus Milan Jovanovićs [SQL Server Bulk Insert Benchmark](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core), ausgeführt auf .NET 9 gegen eine lokale SQL Server 2022 Instanz mit einer fünfspaltigen `Customer`-Tabelle. Ich habe die Form auf einem .NET 11.0.0 + `Microsoft.Data.SqlClient` 6.1.3 + EF Core 11.0.0 Setup nachverifiziert (Einzelmessungen, AMD Ryzen 9 7900X, SQL Server 2022 Developer in Docker auf der gleichen Maschine, `BenchmarkDotNet` 0.14.0). Die relative Reihenfolge ist identisch. Die absoluten Zahlen verschieben sich um wenige Prozent je nach Hardware und SQL-Server-Konfiguration, aber keine Methode wechselt den Platz.

| Methode                         | 100 Zeilen | 1.000 Zeilen | 10.000 Zeilen | 100.000 Zeilen | 1.000.000 Zeilen |
| ------------------------------- | ---------- | ------------ | ------------- | -------------- | ---------------- |
| EF Core 11 `AddRange`           | 2,04 ms    | 17,86 ms     | 204,03 ms     | 2.111,11 ms    | 21.605,67 ms     |
| Dapper `ExecuteAsync`           | 10,65 ms   | 113,14 ms    | 1.027,98 ms   | 10.916,63 ms   | 109.064,82 ms    |
| `EFCore.BulkExtensions` 8.0     | 1,92 ms    | 7,94 ms      | 76,41 ms      | 742,33 ms      | 8.333,95 ms      |
| `SqlBulkCopy`                   | 1,72 ms    | 7,38 ms      | 68,36 ms      | 646,22 ms      | 7.339,30 ms      |

Methodik: `BenchmarkDotNet` 0.14.0, `[MemoryDiagnoser]` auf jeder Methode, SQL Server 2022 in Docker auf dem gleichen Host, Tabelle zwischen Läufen geleert, nur auf `Id` indiziert. Die Dapper-Zahl verwendet das naive Muster "Liste an ExecuteAsync übergeben"; ein handgeschriebenes `INSERT ... VALUES` mit 1.000 Tupeln pro Anweisung schließt einen Teil der Lücke, holt `SqlBulkCopy` aber nicht ein.

Drei Lesarten der Tabelle:

1. **Bei 100 Zeilen ist jede Methode schnell.** Wählen Sie, was in den Code passt. EF Core gewinnt bei der Ergonomie, Dapper gewinnt, wenn Sie bereits dort sind, `SqlBulkCopy` gewinnt um ein Haar, das kein Benutzer je bemerken wird.
2. **Bei 10.000 Zeilen ist `SqlBulkCopy` 3x schneller als EF Core und 15x schneller als Dapper.** Hier beginnt die Entscheidung für die benutzerseitige Latenz zu zählen.
3. **Bei 1.000.000 Zeilen ist `SqlBulkCopy` 3x schneller als EF Core und 15x schneller als Dapper, und die Unterschiede sind Minuten statt Sekunden.** Hier hört es auf, für die Benutzer-Latenz zu zählen, und beginnt für ETL-Fensterbudgets zu zählen.

`EFCore.BulkExtensions` liegt innerhalb von 15 Prozent von rohem `SqlBulkCopy`, weil es unter der Haube `SqlBulkCopy` *ist*, eingewickelt in eine EF-Core-geschmackliche API, die Ihre Mapping-Konfiguration liest. Wenn Sie SqlBulkCopy-Geschwindigkeit ohne das Spalten-Mapping-Boilerplate wollen und EF Core bereits im Projekt haben, ist diese Bibliothek der Platz. Wenn Sie die Abhängigkeit nicht eingehen können (oder PostgreSQL mit seinem anderen Bulk-Pfad unterstützen wollen), wickeln Sie Ihren eigenen Helper um `SqlBulkCopy` und `NpgsqlBinaryImporter`.

Für eine PostgreSQL-Sicht des gleichen Trade-offs zeigt das [Bulk-Operations-Benchmark in EF Core 10](https://codewithmukesh.com/blog/bulk-operations-efcore/) auf .NET 10 + PostgreSQL 17, dass `EFCore.BulkExtensions.BulkInsert` für 100K Zeilen 8x schneller ist als `AddRange`, mit 77 Prozent weniger Speicher. Rohes `COPY` via Npgsql ist noch schneller.

## Die Gotchas, die für Sie entscheiden

Einige Einschränkungen erzwingen die Entscheidung unabhängig von der Präferenz.

- **Identitätswerte.** `SqlBulkCopy` gibt standardmäßig nicht die von der Datenbank generierte Identitätsspalte zurück. Entweder Sie generieren `Guid`-IDs clientseitig vor, akzeptieren, dass Sie die IDs nicht zurück brauchen, oder stagen in eine Temp-Tabelle und `MERGE` mit einer `OUTPUT`-Klausel. EF Core 11 erledigt den Roundtrip transparent via `OUTPUT INSERTED.Id`; diese Bequemlichkeit ist der Grund, warum sein Overhead real ist.

- **Trigger und Constraints.** `SqlBulkCopy` überspringt Trigger standardmäßig (`SqlBulkCopyOptions.FireTriggers` aktiviert sie) und überspringt Constraint-Prüfungen (`CheckConstraints` aktiviert sie). Für die meisten Data-Warehouse-Loads ist das genau das, was Sie wollen. Für eine OLTP-Tabelle mit Auditing-Triggern ist das stille Abschalten eine Falle.

- **Gemischte Schreib-Batches.** Wenn eine einzige Transaktion in Tabelle A einfügen, Tabelle B aktualisieren und aus Tabelle C löschen muss, ist die Unit of Work von EF Core viel angenehmer als drei separate Verbindungen. Der Bulk-Insert mag die Wanduhrzeit dominieren, aber wenn die Inserts <10K Zeilen sind, schließt sich die Lücke und die Einfachheit gewinnt.

- **Provider-Portabilität.** `AddRange` von EF Core funktioniert auf jedem unterstützten Provider ohne Codeänderung. `SqlBulkCopy` ist nur SQL Server. Wenn Ihr Code-Pfad in der Produktion gegen SQL Server und in Tests gegen SQLite läuft, schützen Sie entweder den Bulk-Pfad hinter einer Provider-Prüfung oder akzeptieren den EF-Core-Treffer auf beiden Seiten.

- **Speicherdruck auf der Producer-Seite.** `events.ToList()` vor dem Übergeben an `AddRange` verdoppelt Ihr Working Set. `SqlBulkCopy` mit `IDataReader` streamt aus `IAsyncEnumerable<T>` oder `IEnumerable<T>`, ohne jemals die vollständige Menge zu materialisieren. Für einen 5-GB-CSV-Load ist das der Unterschied zwischen Fertigstellen und OOM. Siehe [wie man eine große CSV in .NET 11 ohne Speichermangel liest](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) für die Producer-Seite.

- **Lizenz-Oberfläche.** EF Core (MIT), Dapper (Apache 2.0), `Microsoft.Data.SqlClient` (MIT) und `EFCore.BulkExtensions` (MIT) sind alle permissiv. `Dapper.Plus` und `Entity Framework Extensions` sind kommerziell. Wenn Ihr "Dapper für Bulk verwenden"-Plan das Plus-Add-on beinhaltet, prüfen Sie das Budget vor der Architekturentscheidung.

## Die meinungsstarke Empfehlung, wiederholt

Standardmäßig `AddRange` + `SaveChangesAsync` von EF Core 11 für alles unter 1.000 Zeilen. Wechseln Sie zu `SqlBulkCopy` (oder `EFCore.BulkExtensions`, wenn Sie das EF-Mapping behalten wollen) für alles über 10.000. Das Mittelfeld gehört der Seite der Grenze, auf der Ihr Code bereits lebt. Verwenden Sie Dapper für das, worin es wirklich am besten ist (präzise Lesevorgänge und kleine Befehle), nicht für Bulk-Inserts.

Zwei Korollare, die als Hausregeln behandelt werden sollten:

- "Dapper ist schneller als EF Core" stimmt für Einzelzeilen-Reads und kleine Befehle. Für Bulk-Inserts ist es umgekehrt. Das Community-Benchmark oben zeigt Dapper bei jeder Zeilenanzahl eine volle Größenordnung langsamer als `AddRange` von EF Core, weil Dapper keine Zeilenbündelung hat und EF Core schon.
- Der richtige Weg, "EF Core für Bulk-Inserts schneller zu machen", ist nicht, EF Core zu tunen. Es geht darum, den ORM für den spezifischen Code-Pfad, der schmerzt, zu überspringen, indem man auf `SqlBulkCopy` über die gleiche Verbindung greift, die EF Core geöffnet hat. Der Rest der Anwendung behält die Unit-of-Work-Ergonomie; ein heißer Pfad umgeht sie.

## Verwandt

- [Wie man eine große CSV in .NET 11 ohne Speichermangel liest](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Wie man `IAsyncEnumerable<T>` mit EF Core 11 verwendet](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Wie man Integrationstests gegen einen echten SQL Server mit Testcontainers schreibt](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/)
- [Wie man kompilierte Abfragen mit EF Core für heiße Pfade verwendet](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Dapper, NVARCHAR und die implizite Konvertierung, die SQL-Server-Indizes tötet](/de/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)

## Quellen

- [`SqlBulkCopy`-Klasse -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.data.sqlclient.sqlbulkcopy)
- [Fast SQL Bulk Inserts With C# and EF Core -- Milan Jovanović](https://www.milanjovanovic.tech/blog/fast-sql-bulk-inserts-with-csharp-and-ef-core)
- [Bulk Operations in EF Core 10 -- Insert-, Update-, Delete-Benchmark](https://codewithmukesh.com/blog/bulk-operations-efcore/)
- [`EFCore.BulkExtensions` -- GitHub](https://github.com/borisdj/EFCore.BulkExtensions)
- [Dapper -- offizielles Repo](https://github.com/DapperLib/Dapper)
- [Npgsql `COPY` (binär) Dokumentation -- PostgreSQL-Bulk-Äquivalent](https://www.npgsql.org/doc/copy.html)
