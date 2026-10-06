---
title: "Fix: Invalid column name 'Value' bei SqlQueryRaw<T> mit skalarem Ergebnis in EF Core"
description: "EF Core verpackt eine skalare SqlQuery<T> in eine Unterabfrage und wählt eine Spalte namens Value aus, sobald Sie First, Where, Max oder Single anhängen. Versehen Sie Ihre SQL-Spalte mit AS Value oder materialisieren Sie zuerst."
pubDate: 2026-10-06
template: error-page
tags:
  - "errors"
  - "efcore"
  - "ef-core-11"
  - "dotnet"
lang: "de"
translationOf: "2026/10/fix-invalid-column-name-value-when-using-sqlqueryraw-for-a-scalar-in-ef-core"
translatedBy: "claude"
translationDate: 2026-10-06
---

`Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First()` schlägt mit `Invalid column name 'Value'` fehl, weil jeder LINQ-Operator, den Sie an eine skalare `SqlQuery<T>` oder `SqlQueryRaw<T>` anhängen, EF Core dazu bringt, Ihr SQL in eine Unterabfrage zu verpacken und daraus eine Spalte mit dem Namen `Value` auszuwählen. Die Lösung: die einzelne Ausgabespalte mit einem Alias versehen, `SELECT COUNT(*) AS Value FROM Blogs`, unter PostgreSQL in Anführungszeichen als `AS "Value"`. Wenn Sie das SQL nicht ändern können, materialisieren Sie zuerst (`ToListAsync()`, danach die Zeile im Speicher auswählen). Alles unten wurde mit EF Core 10.0.12 und EF Core 11.0.0-rc.1 gemessen, die sich hier identisch verhalten, und die Regel gilt seit der Einführung von `SqlQuery<T>` in EF Core 7.0.

## Der Fehler im Kontext

Unter SQL Server ist die Ausnahme eine `SqlException` mit der Nummer 207:

```text
Microsoft.Data.SqlClient.SqlException (0x80131904): Invalid column name 'Value'.
```

Derselbe Fehler sieht bei jedem Anbieter anders aus, weshalb er schwer zu finden ist. Die Meldungen von SQLite und PostgreSQL stammen aus den unten beschriebenen Laborläufen; die SQL-Server-Zeilen sind die Engine-Fehler für das SQL, das EF sendet (für diesen Beitrag stand keine SQL-Server-Instanz zur Verfügung):

```text
SQLite:      SQLite Error 1: 'no such column: s.Value'.
PostgreSQL:  42703: column s.Value does not exist
SQL Server:  Invalid column name 'Value'.                       (error 207)
SQL Server:  No column name was specified for column 1 of 's'.  (error 8155, unaliased COUNT(*), MAX(...) etc.)
```

Welche SQL-Server-Variante Sie erhalten, hängt von Ihrem SQL ab. Liefert Ihre Abfrage eine benannte Spalte wie `SELECT Id FROM Blogs`, beklagt SQL Server, dass `Value` nicht existiert. Liefert sie einen Ausdruck ganz ohne Namen, etwa `COUNT(*)`, scheitert SQL Server früher, weil eine abgeleitete Tabelle keine unbenannte Spalte enthalten darf. Beide haben dieselbe Lösung.

## Warum EF Core nach einer Spalte namens Value fragt

`SqlQuery<T>` für ein skalares `T` wird in `RelationalQueryableMethodTranslatingExpressionVisitor` übersetzt. Im Quellcode von EF Core 11 RC 1 erzeugt der Übersetzer für Ihr SQL einen `FromSqlExpression` mit dem Tabellenalias `s` (aus `"sql"` generiert) und eine Projektionsspalte, deren Name aus einer fest codierten Konstante stammt:

```csharp
// EF Core 11.0.0-rc.1, src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs
private const string SqlQuerySingleColumnAlias = "Value";
```

Es gibt keine API, um diesen Namen zu ändern. Solange nichts darüber komponiert wird, sendet EF Ihr SQL unverändert und liest die erste Spalte nach Position, der Spaltenname spielt also keine Rolle und `ToList()` funktioniert. Sobald Sie einen Operator hinzufügen, der die Spalte in SQL referenzieren muss, erzeugt EF ein äußeres `SELECT [s].[Value] FROM (<your SQL>) AS [s]`, und die Datenbank sucht eine Spalte, die nicht existiert.

Die [EF-Core-Dokumentation zu Raw SQL](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types) fasst die Regel in einem Satz zusammen: Wenn Sie LINQ über eine skalare SQL-Abfrage komponieren, "you must name the output column `Value`". Die Falle: Methoden wie `First()` und `Single()` sehen nicht nach Komposition aus, sind aber eine.

## Minimales Beispiel zur Reproduktion

Die folgende Konsolenanwendung reproduziert den Fehler mit SQLite im Speicher und braucht daher keinen Server. Die weiter unten zitierten SQL-Server-Anweisungen wurden vom SQL-Server-Anbieter mit einem Interceptor erfasst, der die Verbindung unterdrückt und `DbCommand.CommandText` aufzeichnet. Es sind also exakt die Anweisungen, die EF sendet; eine SQL-Server-Instanz war nicht beteiligt.

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128 (identical on .NET 10 + EF Core 10.0.12)
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

var conn = new SqliteConnection("Data Source=:memory:");
conn.Open();
var db = new Db(new DbContextOptionsBuilder<Db>().UseSqlite(conn).Options);
db.Database.EnsureCreated();
db.Blogs.AddRange(new Blog { Name = "a", Views = 5 }, new Blog { Name = "b", Views = 50 });
db.SaveChanges();

// Works: no composition, EF reads column 0 by position.
var all = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").ToList();

// Throws: SQLite Error 1: 'no such column: s.Value'.
var count = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").First();

class Blog { public int Id { get; set; } public string Name { get; set; } = ""; public int Views { get; set; } }
class Db(DbContextOptions<Db> o) : DbContext(o) { public DbSet<Blog> Blogs => Set<Blog>(); }
```

Für den Aufruf von `First()` sendet der SQL-Server-Anbieter:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider, captured CommandText
SELECT TOP(1) [s].[Value]
FROM (
    SELECT COUNT(*) FROM Blogs
) AS [s]
```

## Welche Operatoren den Fehler auslösen

Ich habe jeden Operator auf beiden EF-Versionen gegen ein unbenanntes `SELECT Id FROM Blogs` ausgeführt. Die Tabelle zeigt das Ergebnis unter SQLite; die SQL-Spalte zeigt, was der SQL-Server-Anbieter für dieselbe Abfrage erzeugt hat.

| Aufruf auf `SqlQueryRaw<int>(...)` | Erzeugtes äußeres SQL (SQL Server) | Ergebnis ohne Alias |
|---|---|---|
| `ToList()` / `ToListAsync()` | keines, Ihr SQL wird unverändert gesendet | funktioniert |
| `AsEnumerable().First()` | keines, `First` läuft im Speicher | funktioniert |
| `First()` / `FirstOrDefault()` | `SELECT TOP(1) [s].[Value] FROM (...) AS [s]` | schlägt fehl |
| `Single()` / `SingleOrDefault()` | `SELECT TOP(2) [s].[Value] FROM (...) AS [s]` | schlägt fehl |
| `Where(x => x > 1)` | `SELECT [s].[Value] ... WHERE [s].[Value] > 1` | schlägt fehl |
| `Max()` / `Min()` | `SELECT MAX([s].[Value]) FROM (...) AS [s]` | schlägt fehl |
| `Count()` | `SELECT COUNT(*) FROM (...) AS [s]` | funktioniert |
| `Any()` | `SELECT CASE WHEN EXISTS (SELECT 1 FROM (...) AS [s]) ...` | funktioniert |

`Count()` und `Any()` verpacken Ihr SQL ebenfalls, referenzieren die Spalte aber nie, kommen also damit durch. So übersteht Code das Review: Der Pfad mit `Count()` wird getestet, dann ändert jemand ihn zu `FirstOrDefault()`, und in Produktion fliegen Ausnahmen.

## Lösung 1: die Ausgabespalte mit AS Value benennen

Das ist die Lösung, die die Dokumentation empfiehlt, und sie hält die Komposition auf dem Server:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = await db.Database
    .SqlQueryRaw<int>("SELECT COUNT(*) AS Value FROM Blogs")
    .FirstAsync();

var bigIds = await db.Database
    .SqlQuery<int>($"SELECT Id AS Value FROM Blogs")
    .Where(id => id > 1)
    .OrderBy(id => id)
    .ToListAsync();
```

Beide laufen jetzt, und die zweite wird in der Datenbank gefiltert und sortiert:

```sql
-- EF Core 11.0.0-rc.1, SQL Server provider
SELECT [s].[Value]
FROM (
    SELECT Id AS Value FROM Blogs
) AS [s]
WHERE [s].[Value] > 1
ORDER BY [s].[Value]
```

Dabei zeigte sich ein kleiner Unterschied zwischen den Versionen: EF Core 10.0.12 erzeugt für dieselbe Abfrage `ORDER BY CAST([s].[Value] AS int)`, EF Core 11 RC 1 lässt den überflüssigen Cast weg. Das Ergebnis ändert sich dadurch nicht, aber der Text des Abfrageplans, falls Sie Abfragen bei einem Upgrade vergleichen.

Der Alias funktioniert für jeden skalaren Typ, den EF abbilden kann, einschließlich `string`, `DateTime`, `Guid` und nullbarer Typen wie `int?`. Bei einem Aggregat, das `NULL` liefern kann, bilden Sie auf den nullbaren Typ ab. Bei einer leeren Tabelle wirft `SqlQueryRaw<int>("SELECT MAX(Views) AS Value FROM Blogs")` mit oder ohne Komposition `Nullable object must have a value.`, während die Variante mit `int?` `null` zurückgibt:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
int? maxViews = await db.Database
    .SqlQueryRaw<int?>("SELECT MAX(Views) AS Value FROM Blogs")
    .FirstOrDefaultAsync();
```

## Lösung 2: den Alias unter PostgreSQL in Anführungszeichen setzen

PostgreSQL wandelt nicht in Anführungszeichen gesetzte Bezeichner in Kleinbuchstaben um, und Npgsql setzt die Spalte, die es erzeugt, in Anführungszeichen. `AS Value` erzeugt also eine Spalte namens `value`, EF fragt nach `s."Value"`, und Sie erhalten denselben Fehler, obwohl Sie der Dokumentation gefolgt sind. Gemessen mit Npgsql.EntityFrameworkCore.PostgreSQL 10.0.3 und 11.0.0-rc.1.1 gegen PostgreSQL 18:

```csharp
// .NET 11 RC 1, Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.1.1
// Throws: 42703: column s.Value does not exist
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS Value FROM \"Blogs\"").FirstAsync();

// Works
await db.Database.SqlQueryRaw<int>("SELECT count(*)::int AS \"Value\" FROM \"Blogs\"").FirstAsync();
```

In einem Raw-String-Literal ab C# 11 bleibt die Quotierung gut lesbar:

```csharp
// .NET 11 RC 1, C# 14
var count = await db.Database.SqlQuery<int>($"""
    SELECT count(*)::int AS "Value" FROM "Blogs"
    """).FirstAsync();
```

SQLite vergleicht Spaltennamen ohne Beachtung der Groß- und Kleinschreibung, daher funktioniert dort `AS value`, und SQL Server folgt der Datenbank-Kollation, die standardmäßig Groß- und Kleinschreibung ignoriert. Schreiben Sie überall `"Value"` mit großem V, dann bleibt die Abfrage portabel.

## Lösung 3: zuerst materialisieren, wenn Sie das SQL nicht anfassen können

Stammt das SQL aus einer gespeicherten Prozedur, einer View, die Ihnen nicht gehört, oder einer gemeinsam genutzten Konstante, holen Sie die Zeilen zum Client und beenden die Verarbeitung dort:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var count = (await db.Database
        .SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs")
        .ToListAsync())
    .Single();

// or, synchronously
var count2 = db.Database.SqlQueryRaw<int>("SELECT COUNT(*) FROM Blogs").AsEnumerable().Single();
```

Keine der beiden erzeugt eine Unterabfrage, der Spaltenname ist also irrelevant. Tun Sie das nur bei Abfragen, die eine Handvoll Zeilen liefern. `AsEnumerable().Where(...)` streamt das gesamte Ergebnis zum Client, bevor gefiltert wird, und genau das sollte die Komposition auf dem Server vermeiden.

Das ist auch die einzige Option für eine gespeicherte Prozedur, weil ein `EXEC` gar nicht als Unterabfrage verwendet werden kann. Eine Komposition darüber wirft einen anderen Fehler, bevor irgendetwas den Server erreicht; diesen Fall habe ich in der Anleitung zum [Aufruf einer gespeicherten Prozedur und zur Abbildung ihrer Ergebnisse](/de/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/) behandelt.

## Stolperfallen und ähnliche Fehler

**`ORDER BY` in Ihrem SQL plus `First()` unter SQL Server.** Selbst mit dem Alias erzeugt `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs ORDER BY Views DESC").First()` den Ausdruck `SELECT TOP(1) [s].[Value] FROM (SELECT Views AS Value FROM Blogs ORDER BY Views DESC) AS [s]`. SQLite akzeptiert das, SQL Server lehnt es mit Fehler 1033 ab ("The ORDER BY clause is invalid in views, inline functions, derived tables, subqueries, and common table expressions, unless TOP, OFFSET or FOR XML is also specified"). Selbst wenn SQL Server es akzeptierte, garantiert ein `ORDER BY` innerhalb einer abgeleiteten Tabelle nicht die Reihenfolge der äußeren Abfrage. Verlagern Sie die Sortierung stattdessen nach LINQ: `SqlQueryRaw<int>("SELECT Views AS Value FROM Blogs").OrderByDescending(v => v).First()`.

**Ein DTO statt eines Skalars.** Bei `SqlQuery<BlogStat>` (nicht zugeordnete Typen, EF Core 8+) verwendet EF nicht `Value`, sondern referenziert pro Eigenschaft eine Spalte mit dem Eigenschaftsnamen. `SELECT Name AS BlogName, Views FROM Blogs`, komponiert mit `.Where(b => b.Views > 10)`, scheitert unter SQLite mit `no such column: b.Name` (der Alias ist jetzt `b`, vom Typnamen abgeleitet), und dieselbe Abfrage ohne Komposition scheitert mit `The required column 'Name' was not present in the results of a 'FromSql' operation`. Die Lösung ist, jede Spalte mit ihrem Eigenschaftsnamen zu versehen. Die zweite Meldung hat einen eigenen Beitrag: [the required column was not present in the results of a FromSql operation](/de/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/).

**`FromSql` auf einem `DbSet`.** Entitätsabfragen verwenden nie `Value`. Wenn dort `Invalid column name` auftritt, ist der Name in der Meldung eine Ihrer zugeordneten Spalten, und die Ursache ist eine Spalte, die in Ihrer `SELECT`-Liste fehlt.

**Ihre eigene Spalte heißt tatsächlich `Value`.** Dann lässt sich `SELECT Value FROM Settings` ohne Alias problemlos komponieren, weshalb manche Beispiele im Netz ohne Alias zu funktionieren scheinen. Benennen Sie die Tabellenspalte um, und diese Beispiele brechen.

**Das tatsächliche SQL sehen.** `ToQueryString()` auf der nicht komponierten `SqlQueryRaw<int>(...)` gibt nur Ihr eigenes SQL aus, und nach `First()` können Sie es nicht mehr aufrufen. Protokollieren Sie stattdessen die ausgeführten Befehle (`LogTo` mit `RelationalEventId.CommandExecuted` oder einen Interceptor), wie im Beitrag über das [Protokollieren des SQL, das EF Core 11 erzeugt](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/), beschrieben. Das äußere `SELECT [s].[Value]` fällt sofort auf, sobald Sie es sehen.

## Wenn Raw SQL das falsche Werkzeug ist

Das meiste skalare Raw SQL, das ich in Code-Reviews sehe, ist ein `COUNT`, `MAX` oder `EXISTS`, das LINQ direkt ausdrückt: `db.Blogs.CountAsync()`, `db.Blogs.MaxAsync(b => (int?)b.Views)`, `db.Blogs.AnyAsync(...)`. Diese lösen den Fehler nie aus und werden vom Anbieter mit korrekter Quotierung für jede Datenbank übersetzt. Behalten Sie `SqlQuery<T>` für Abfragen, die LINQ nicht ausdrücken kann, und wenn Sie für einen kritischen Pfad zwischen Raw SQL, kompilierten Abfragen und Dapper abwägen, liefert der Vergleich [EF Core compiled queries vs raw SQL vs Dapper](/de/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) die Zahlen. Wenn Sie zu Raw SQL gegriffen haben, weil eine LINQ-Abfrage nicht übersetzt werden konnte, bringt Sie die Anleitung zum [Beheben von "The LINQ expression could not be translated"](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/) meist zurück zu LINQ.

## Verwandte Beiträge

- [Fix: The required column 'X' was not present in the results of a 'FromSql' operation in EF Core 11](/de/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [How to call a stored procedure and map its results in EF Core 11](/de/2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11/)
- [How to log the SQL that EF Core 11 generates](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [EF Core compiled queries vs raw SQL vs Dapper](/de/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Fix: The LINQ expression could not be translated in EF Core 11](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)

## Quellen

- [SQL Queries: querying scalar (non-entity) types](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#querying-scalar-non-entity-types), EF-Core-Dokumentation
- [SQL Queries: composing with LINQ](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries#composing-with-linq), einschließlich der `ORDER BY`-Einschränkung von SQL Server
- [`RelationalQueryableMethodTranslatingExpressionVisitor.cs` at v11.0.0-rc.1.26425.128](https://github.com/dotnet/efcore/blob/v11.0.0-rc.1.26425.128/src/EFCore.Relational/Query/RelationalQueryableMethodTranslatingExpressionVisitor.cs), dotnet/efcore
- [`RelationalDatabaseFacadeExtensions.SqlQueryRaw<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.relationaldatabasefacadeextensions.sqlqueryraw), API-Referenz
- [Database engine errors](https://learn.microsoft.com/en-us/sql/relational-databases/errors-events/database-engine-events-and-errors), SQL-Server-Dokumentation (207, 1033, 8155)
