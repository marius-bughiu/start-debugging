---
title: "Eine Stored Procedure aufrufen und ihre Ergebnisse in EF Core 11 mappen"
description: "Verwenden Sie FromSql auf einem DbSet, wenn die Prozedur vollständige Entitätszeilen liefert, Database.SqlQuery<T> bei einer Projektion und ExecuteSql, wenn sie nichts liefert. Verketten Sie niemals einen LINQ-Operator auf ein EXEC, und lesen Sie einen Ausgabeparameter nie, bevor der Reader freigegeben wurde."
pubDate: 2026-08-10
tags:
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
  - "how-to"
lang: "de"
translationOf: "2026/08/how-to-call-a-stored-procedure-and-map-its-results-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-08-10
---

Kurze Antwort: EF Core 11 bietet drei Einstiegspunkte für den Aufruf einer Stored Procedure, und die falsche Wahl verursacht den größten Teil der Probleme. Verwenden Sie `FromSql` auf einem `DbSet<T>`, wenn die Prozedur alle Spalten einer gemappten Entität liefert. Verwenden Sie `Database.SqlQuery<T>`, wenn sie eine Projektion liefert, die keine Entität ist; das funktioniert seit EF Core 8 für beliebige DTOs. Verwenden Sie `Database.ExecuteSql`, wenn sie überhaupt kein Ergebnis liefert. Zwei Regeln gelten für alle drei: Sie dürfen keinen LINQ-Operator auf ein `EXEC` verketten, und der `Value` eines Ausgabeparameters ist null, bis der zugrunde liegende Reader freigegeben wurde.

Dieser Beitrag behandelt alle drei APIs, die genauen Exceptions bei falscher Verwendung, Ausgabe- und Rückgabeparameter, mehrere Ergebnismengen und das Tracking-Verhalten, das viele überrascht.

Alles Folgende wurde gegen SQL Server 2022 (`mcr.microsoft.com/mssql/server:2022-latest`) mit EF Core 10.0.10 auf dem .NET SDK 10.0.201 gemessen, da EF Core 11 die .NET 11 Laufzeit voraussetzt, die auf diesem Rechner nicht installiert ist. Das fällt hier weniger ins Gewicht als sonst: EF Core 11 bringt keine Änderungen an `FromSql`, `SqlQuery` oder `ExecuteSql`, und die [Release Notes zu EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew) enthalten überhaupt keine Einträge zu Stored Procedures. Jede hier zitierte Exception-Meldung und jedes Verhalten ist in EF Core 8, 9, 10 und 11 identisch. Wo eine Aussage aus der Dokumentation statt aus einer Messung stammt, sage ich es.

Das Schema für alle Beispiele:

```sql
-- SQL Server 2022
CREATE TABLE Blogs (
    Id         int NOT NULL IDENTITY PRIMARY KEY,
    Name       nvarchar(200) NOT NULL,
    Rating     int NOT NULL,
    OwnerEmail nvarchar(200) NULL
);

CREATE PROCEDURE dbo.GetTopBlogs @MinRating int AS
BEGIN
    SET NOCOUNT ON;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs
    WHERE Rating >= @MinRating ORDER BY Rating DESC;
END
```

Beachten Sie das `SET NOCOUNT ON`. Ohne dieses sendet SQL Server vor der Ergebnismenge eine Meldung über die betroffenen Zeilen, die manche Treiber als leere Phantom-Ergebnismenge darstellen. Es kostet nichts und verhindert eine ganze Klasse verwirrender Fehler.

## Wenn die Prozedur Entitätszeilen liefert: FromSql

`FromSql` ist eine Erweiterungsmethode auf `DbSet<T>` und der richtige Aufruf, wenn die Ergebnismenge Ihrer Prozedur Spalte für Spalte einer gemappten Entität entspricht:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .ToListAsync();
```

Diese interpolierte Lücke ist keine Stringverkettung. `FromSql` nimmt einen `FormattableString` entgegen und wandelt jede Lücke in einen `DbParameter` um, dadurch ist der Aufruf gegen SQL Injection sicher. Was genau gesendet wird, zeigt `ToQueryString()`:

```text
DECLARE p0 int = 3;

EXEC dbo.GetTopBlogs @MinRating = @p0
```

EF hat das SQL unverändert durchgereicht. Es gibt keine umschließende Unterabfrage, und genau darum geht es im nächsten Abschnitt.

Die Ergebnisse kommen getrackt zurück, genau wie bei einer LINQ-Abfrage. Ich habe nach dem Aufruf einer Prozedur mit drei Zeilen drei Entitäten im Change Tracker gemessen. Für rein lesende Pfade fügen Sie `AsNoTracking()` hinzu; das funktioniert hier problemlos, weil es nichts am SQL ändert:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsNoTracking()
    .ToListAsync();
```

Für benannte Parameter, die bei Prozeduren mit optionalen Parametern wichtig werden, verpacken Sie den Wert in einen `SqlParameter` und referenzieren ihn über den Namen:

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("min", 3);

var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {minRating}")
    .AsNoTracking()
    .ToListAsync();
```

Eine einzelne `SqlParameter`-Instanz über zwei aufeinanderfolgende Ausführungen wiederzuverwenden funktioniert, entgegen einer verbreiteten Annahme aus dem reinen ADO.NET, wo ein Parameter nur zur Collection eines Commands gehören darf. Ich habe dieselbe Instanz ohne Exception durch zwei aufeinanderfolgende `FromSqlRaw`-Aufrufe geschickt.

### Die Ergebnismenge muss alle gemappten Spalten enthalten

Das ist der Fehler, auf den man zuerst stößt. Entfernen Sie `OwnerEmail` aus dem `SELECT` der Prozedur, und die Abfrage stirbt:

```text
InvalidOperationException: The required column 'OwnerEmail' was not present
in the results of a 'FromSql' operation.
```

EF materialisiert die vollständige Entität, der Reader muss also jede gemappte Eigenschaft liefern, einschließlich Shadow Properties und Diskriminatoren. Die Spaltennamen müssen den gemappten Spaltennamen entsprechen, nicht den Eigenschaftsnamen, was eine echte Verhaltensänderung gegenüber EF6 darstellt. Die Reihenfolge spielt keine Rolle, und der Abgleich unterscheidet nicht zwischen Groß- und Kleinschreibung. Wenn Sie die Prozedur nicht so ändern können, dass sie die fehlenden Spalten liefert, geben Sie keine Entität zurück und sollten stattdessen `SqlQuery<T>` verwenden. Diese Exception habe ich ausführlicher im [Leitfaden zum Fehler über die fehlende Spalte in FromSql](/de/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/) beschrieben.

### LINQ lässt sich nicht über ein EXEC komponieren

Das ist die zweite Stolperstelle. SQL Server kann einen Prozeduraufruf nicht in eine Unterabfrage verschachteln, also gibt EF auf, sobald Sie einen Operator hinzufügen, der das SQL verändert:

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var blogs = await context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .Where(b => b.Rating > 4)          // composition
    .ToListAsync();
```

```text
InvalidOperationException: 'FromSql' or 'SqlQuery' was called with non-composable
SQL and with a query composing over it. Consider calling 'AsEnumerable' after the
method to perform the composition on the client side.
```

Dieselbe Exception tritt bei `Include`, `OrderBy`, `Skip`/`Take` sowie bei einem bloßen `First()` oder `Single()` auf, da all diese `TOP` oder `ORDER BY` anhängen. Ich habe bestätigt, dass auch `Include` sie auslöst; Eager Loading einer Navigation über einen Prozeduraufruf ist also nicht verfügbar.

Die Lösung ist die, die die Meldung selbst nennt. Setzen Sie `AsEnumerable()` (oder `AsAsyncEnumerable()`) direkt hinter `FromSql`, um eine klare Grenze zwischen dem zu ziehen, was die Datenbank tut, und dem, was Ihr Prozess tut:

```csharp
// .NET 11, C# 14, EF Core 11
var blogs = context.Blogs
    .FromSql($"EXEC dbo.GetTopBlogs @MinRating = {3}")
    .AsEnumerable()                    // everything after this runs in memory
    .Where(b => b.Rating > 4)
    .ToList();
```

Seien Sie ehrlich zu sich selbst, was das kostet: Jede Zeile, die die Prozedur liefert, geht über das Netzwerk und wird materialisiert, bevor das `Where` läuft. Liefert die Prozedur 200.000 Zeilen und Sie behalten vier, gehört der Filter als Parameter in die Prozedur. `AsEnumerable` ist eine Korrektur der Korrektheit, nicht der Leistung.

Change Tracking gilt auch nach `AsEnumerable` weiter, was viele überrascht. Die clientseitige Grenze verschiebt nur die Abfrageoperatoren; die Materialisierung ist auf EF-Seite bereits passiert. Ich habe nach `FromSql(...).AsEnumerable().ToList()` drei getrackte Entitäten gemessen. Setzen Sie `AsNoTracking()` vor `AsEnumerable()`, wenn Sie das nicht wollen.

Ein komponierbares `SELECT` wird dagegen umschlossen und nach unten geschoben, und genau das macht `FromSql` für SQL abseits von Prozeduren wirklich nützlich:

```csharp
// .NET 11, C# 14, EF Core 11
var q = context.Blogs
    .FromSql($"SELECT * FROM Blogs WHERE Rating >= {3}")
    .Where(b => b.Name.StartsWith("S"));
```

```sql
SELECT [b].[Id], [b].[Name], [b].[OwnerEmail], [b].[Rating]
FROM (
    SELECT * FROM Blogs WHERE Rating >= @p0
) AS [b]
WHERE [b].[Name] LIKE N'S%'
```

Das ist der ganze Unterschied. Komponierbares SQL beginnt mit `SELECT` und übersteht es, zur Unterabfrage zu werden; `EXEC` nicht.

## Wenn die Prozedur eine Projektion liefert: SqlQuery&lt;T&gt;

Die meisten realen Stored Procedures liefern keine Entitätszeilen. Sie liefern eine Report-Form: einen Join, ein `GROUP BY`, ein paar berechnete Spalten. Dafür mappt `Database.SqlQuery<T>` die Ergebnismenge auf einen einfachen CLR-Typ, der überhaupt nicht in Ihrem Modell liegt. Das ist die API, die die meisten Artikel zu diesem Thema immer noch als rein skalar beschreiben; das stimmt seit EF Core 8 nicht mehr, das sie auf [jeden mappbaren CLR-Typ](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types) erweitert hat.

```sql
CREATE PROCEDURE dbo.GetBlogStats @MinViews int AS
BEGIN
    SET NOCOUNT ON;
    SELECT b.Name AS BlogName, COUNT(p.Id) AS PostCount, SUM(p.Views) AS TotalViews
    FROM Blogs b JOIN Posts p ON p.BlogId = b.Id
    WHERE p.Views >= @MinViews
    GROUP BY b.Name;
END
```

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
    public int TotalViews { get; set; }
}

var stats = await context.Database
    .SqlQuery<BlogStat>($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`BlogStat` braucht kein `DbSet`, keinen Eintrag in `OnModelCreating` und keine Attribute. Was ich zum Verhalten des Mappings überprüft habe:

- **Der Abgleich erfolgt über den Spaltennamen, nicht über die Position.** Ich habe die drei Spalten in vertauschter Reihenfolge geliefert, und jede Eigenschaft landete korrekt.
- **Der Abgleich unterscheidet nicht zwischen Groß- und Kleinschreibung.** Sowohl `blogname` als auch `POSTCOUNT` wurden korrekt gebunden.
- **Zusätzliche Spalten in der Ergebnismenge werden ignoriert.** Eine vierte Spalte `Surprise` löste keine Exception aus, obwohl die Dokumentation sagt, der Typ müsse "eine Eigenschaft für jeden Wert in der Ergebnismenge" besitzen. Verlassen Sie sich nicht darauf; das ist undokumentiertes Verhalten, kein Vertrag.
- **Eine fehlende Spalte ist fatal.** Entfernen Sie `TotalViews` aus dem `SELECT`, und Sie erhalten dieselbe Meldung `The required column 'TotalViews' was not present in the results of a 'FromSql' operation.` wie im Entitätspfad.
- **Ein null in einer nicht nullbaren Eigenschaft löst** `SqlNullValueException: Data is Null. This method or property cannot be called on Null values.` aus. Modellieren Sie die Eigenschaft nullbar, oder verwenden Sie `COALESCE` im SQL.

Verwenden Sie `[Column("...")]`, wenn ein Spaltenname im Ergebnis nicht zum Namen Ihrer Eigenschaft passen kann:

```csharp
// .NET 11, C# 14, EF Core 11
public class BlogStat
{
    [Column("blog_name")]
    public string BlogName { get; set; } = "";
    public int PostCount { get; set; }
}
```

Die Regel zur fehlenden Komponierbarkeit gilt hier identisch. `SqlQuery<T>(...).Where(...)` über einem `EXEC` löst exakt dieselbe Exception aus, und `AsEnumerable()` ist dieselbe Lösung.

Für einen einzelnen Skalarwert funktioniert `SqlQuery<T>` mit einem primitiven Typ direkt:

```csharp
// .NET 11, C# 14, EF Core 11
var count = (await context.Database
    .SqlQuery<int>($"EXEC dbo.GetBlogCount")
    .ToListAsync()).Single();
```

Die EF Core Dokumentation empfiehlt, die Ausgabespalte für ein skalares `SqlQuery` mit `AS Value` zu benennen. Diese Anforderung gilt nur, wenn Sie LINQ über die Abfrage komponieren, weil EF einen Namen braucht, den das erzeugte äußere `SELECT` referenzieren kann. Ein Prozeduraufruf ohne Komposition braucht keinen Alias; ich habe bestätigt, dass ein `SELECT COUNT(*)` ohne Alias korrekt bindet.

### Die Alternative über schlüssellose Entitätstypen

Vor EF Core 8 war ein schlüsselloser Entitätstyp die einzige Möglichkeit, eine Ergebnisform ohne Entität zu mappen, und er bleibt die bessere Wahl, wenn die Form Teil Ihrer Domäne ist und Sie sie als `DbSet` abfragen wollen:

```csharp
// .NET 11, C# 14, EF Core 11
protected override void OnModelCreating(ModelBuilder b)
{
    b.Entity<BlogStat>().HasNoKey().ToView(null);
}

var stats = await context.Set<BlogStat>()
    .FromSql($"EXEC dbo.GetBlogStats @MinViews = {10}")
    .ToListAsync();
```

`ToView(null)` teilt EF mit, dass der Typ keine zugrunde liegende Tabelle hat, damit Migrationen nicht versuchen, eine anzulegen. Schlüssellose Typen werden nie im Change Tracking geführt, was ich bestätigt habe: null Einträge nach der Materialisierung von drei Zeilen. Greifen Sie zu `SqlQuery<T>` für einmalige Auswertungen und zu einem schlüssellosen Typ, wenn die Form in der Anwendung wiederverwendet wird oder [neben der Prozedur auch eine von EF erzeugte Abfrage](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types) braucht.

## Wenn die Prozedur nichts liefert: ExecuteSql

Für eine Prozedur, die ausschließlich schreibt, verwenden Sie `ExecuteSql`. Sie liefert die Anzahl der betroffenen Zeilen, nicht etwa einen von der Prozedur berechneten Wert:

```csharp
// .NET 11, C# 14, EF Core 11
var rowsAffected = await context.Database
    .ExecuteSqlAsync($"EXEC dbo.BumpRatings @By = {1}");
```

`ExecuteSql` parametrisiert wie `FromSql`; `ExecuteSqlRaw` ist der Notausgang, wenn SQL dynamisch zusammengesetzt werden muss. Das ist ein anderes Werkzeug als [`ExecuteUpdate` und `ExecuteDelete` für Massenschreibvorgänge](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/), die SQL aus LINQ erzeugen, statt etwas selbst Geschriebenes aufzurufen.

Ein wichtiger Vorbehalt: `ExecuteSql` läuft außerhalb des Change Trackers. Zeilen, die es in der Datenbank ändert, spiegeln sich nicht in bereits geladenen Entitäten wider, sodass ein späteres `SaveChanges` veraltete Werte darüberschreiben kann. Rufen Sie es vor dem Laden auf, oder verwenden Sie anschließend `Reload()` auf den betroffenen Einträgen.

## Ausgabeparameter und das Timing-Problem, das alle trifft

Eine Prozedur, die sowohl eine Ergebnismenge als auch einen Ausgabeparameter liefert, ist ein gängiges Muster für Paginierung:

```sql
CREATE PROCEDURE dbo.GetTopBlogsWithCount @MinRating int, @TotalCount int OUTPUT AS
BEGIN
    SET NOCOUNT ON;
    SELECT @TotalCount = COUNT(*) FROM Blogs;
    SELECT Id, Name, Rating, OwnerEmail FROM Blogs WHERE Rating >= @MinRating;
END
```

Ausgabeparameter benötigen explizite `SqlParameter`-Instanzen und `FromSqlRaw`, weil Sie `Direction` selbst setzen müssen:

```csharp
// .NET 11, C# 14, EF Core 11
var minRating = new SqlParameter("MinRating", SqlDbType.Int) { Value = 3 };
var totalCount = new SqlParameter("TotalCount", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};

var blogs = await context.Blogs
    .FromSqlRaw("EXEC dbo.GetTopBlogsWithCount @MinRating, @TotalCount OUTPUT",
        minRating, totalCount)
    .ToListAsync();

var total = (int)totalCount.Value;   // only valid after ToListAsync
```

Beachten Sie das Schlüsselwort `OUTPUT` im SQL-Text. Lassen Sie es weg, behandelt SQL Server den Parameter als reinen Eingabeparameter und liefert stillschweigend nichts zurück.

Jetzt der Teil, der Leute einen Nachmittag kostet. `totalCount.Value` ist `null`, bis der `DbDataReader` geschlossen ist, denn erst dann sendet SQL Server die Werte der Ausgabeparameter über die Leitung. Direkt gemessen:

```text
before enumeration:  total.Value = null
mid-enumeration:     total.Value = null
after dispose:       total.Value = 5
```

`totalCount.Value` in der Zeile nach dem Aufbau der Abfrage zu lesen liefert `null` und eine `NullReferenceException` beim Cast. Der Zugriff muss nach dem Abschluss der Enumeration erfolgen. `ToListAsync()`, `First()` auf einem `AsEnumerable()` und `await foreach` über `AsAsyncEnumerable()` funktionieren alle, weil jedes davon den Reader freigibt.

Die Folgerung ist schlimmer. Wenn Sie einen Enumerator holen und nie freigeben, bekommen Sie zwei Fehler auf einmal:

```csharp
// .NET 11, C# 14, EF Core 11 - do not do this
var e = context.Blogs
    .FromSqlRaw("EXEC dbo.ManyRowsWithCount @Total OUTPUT", total)
    .AsEnumerable().GetEnumerator();
e.MoveNext();                        // reader is open and never closed
```

`total.Value` bleibt `null`, und die nächste Abfrage auf diesem `DbContext` scheitert mit `InvalidOperationException: There is already an open DataReader associated with this Connection which must be closed first.` Mir ist das beim Testen versehentlich passiert, und es hat jede weitere Abfrage auf dem Kontext zerstört. Wenn Sie manuell enumerieren, kapseln Sie das in ein `using`.

## Den RETURN-Wert holen, der nicht der Ausgabeparameter ist

Ein `RETURN 42` in T-SQL ist ein dritter Kanal, getrennt von Ausgabeparametern und Ergebnismengen. Der naheliegende Ansatz funktioniert nicht:

```csharp
// .NET 11, C# 14, EF Core 11 - throws
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
```

```text
SqlException: Must declare the scalar variable "@ret".
```

`ParameterDirection.ReturnValue` wird nur verstanden, wenn der Command ein echter `CommandType.StoredProcedure` ist, und EF sendet immer `CommandType.Text`. Zwei Wege funktionieren. Der einfachere deklariert den Parameter als `Output` und lässt die Syntax `EXEC @ret =` die Bindung übernehmen:

```csharp
// .NET 11, C# 14, EF Core 11
var ret = new SqlParameter("ret", SqlDbType.Int)
{
    Direction = ParameterDirection.Output
};
var by = new SqlParameter("By", SqlDbType.Int) { Value = 1 };

context.Database.ExecuteSqlRaw("EXEC @ret = dbo.BumpRatings @By", ret, by);
var returnValue = (int)ret.Value;   // 42
```

Der andere steigt auf einen reinen `DbCommand` auf der Verbindung von EF ab, was zusätzlich `CommandType.StoredProcedure` und damit echte `ReturnValue`-Unterstützung liefert:

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.BumpRatings";
cmd.CommandType = CommandType.StoredProcedure;
cmd.Parameters.Add(new SqlParameter("@By", SqlDbType.Int) { Value = 1 });
var ret = new SqlParameter("@ret", SqlDbType.Int)
{
    Direction = ParameterDirection.ReturnValue
};
cmd.Parameters.Add(ret);

await cmd.ExecuteNonQueryAsync();
var returnValue = (int)ret.Value;   // 42
```

Beide lieferten 42. Verwenden Sie den ersten Weg, sofern Sie `CommandType.StoredProcedure` nicht aus einem anderen Grund brauchen. Wenn Sie die Verbindung selbst öffnen, denken Sie daran, dass EF sie nicht für Sie schließt.

## Mehrere Ergebnismengen werden weiterhin nicht unterstützt

Liefert Ihre Prozedur zwei Ergebnismengen, liest EF die erste und verwirft den Rest stillschweigend. Keine Exception, keine Warnung. Ich habe eine Prozedur, die Blogs und Posts liefert, über `FromSql` aufgerufen und drei Blogs zurückbekommen, während die fünf Posts unter den Tisch fielen.

[FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127) ist seit April 2017 offen und liegt im Meilenstein Backlog, kommt also nicht in EF Core 11. Der Workaround ist ein reiner `DbDataReader` mit `NextResult()`:

```csharp
// .NET 11, C# 14, EF Core 11
var conn = context.Database.GetDbConnection();
if (conn.State != ConnectionState.Open) await conn.OpenAsync();

await using var cmd = conn.CreateCommand();
cmd.CommandText = "dbo.TwoResultSets";
cmd.CommandType = CommandType.StoredProcedure;

await using var reader = await cmd.ExecuteReaderAsync();

var blogs = new List<Blog>();
while (await reader.ReadAsync())
    blogs.Add(new Blog { Id = reader.GetInt32(0), Name = reader.GetString(1) });

await reader.NextResultAsync();

var posts = new List<Post>();
while (await reader.ReadAsync())
    posts.Add(new Post { Id = reader.GetInt32(0), Title = reader.GetString(2) });
```

Das lieferte drei Blogs und fünf Posts, korrekt getrennt. Sie verlieren die Materialisierung und das Tracking von EF; wenn Sie Tracking brauchen, hängen Sie die Ergebnisse manuell an. Bei diesem Maß an Handarbeit ist `QueryMultiple` von Dapper eine vernünftige Alternative, und die Abwägungen sind die, die ich in [Compiled Queries vs Raw SQL vs Dapper](/de/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/) gemessen habe.

## Inserts, Updates und Deletes auf Prozeduren mappen

Alles bisherige betrifft das Abfragen. Die Gegenrichtung, `SaveChanges` Ihre Prozeduren aufrufen zu lassen statt `INSERT`/`UPDATE`/`DELETE` zu erzeugen, ist eine eigene Funktion, die in EF Core 7 hinzukam und in 11 unverändert ist:

```csharp
// .NET 11, C# 14, EF Core 11
modelBuilder.Entity<Person>()
    .InsertUsingStoredProcedure(
        "People_Insert",
        spb =>
        {
            spb.HasParameter(p => p.Name);
            spb.HasResultColumn(p => p.Id);
        })
    .DeleteUsingStoredProcedure(
        "People_Delete",
        spb =>
        {
            spb.HasOriginalValueParameter(p => p.Id);
            spb.HasRowsAffectedResultColumn();
        });
```

Zwei Punkte aus der Dokumentation sollten Sie kennen, bevor Sie sich darauf einlassen. Parameter müssen in derselben Reihenfolge deklariert werden, in der sie in der Prozedurdefinition stehen, weil EF immer positionsbasiert und nicht über Namen aufruft. Und für Schlüsselwerte in Update- und Delete-Prozeduren sind Original-Value-Parameter vorgeschrieben. Ich habe diesen Pfad nicht gegen eine Datenbank ausgeführt, behandeln Sie das Beispiel daher als aus der Dokumentation übernommen.

Das EF-Team äußert sich in den eigenen Release Notes deutlich: Die Unterstützung für Stored Procedure Mapping bedeutet nicht, dass Stored Procedures empfohlen werden.

## Die richtige API wählen

Liefert die Prozedur vollständige Entitätszeilen, verwenden Sie `FromSql` auf dem `DbSet` und nehmen das Tracking in Kauf. Liefert sie eine Projektion, verwenden Sie `Database.SqlQuery<T>` mit einem einfachen DTO oder einen schlüssellosen Entitätstyp, wenn die Form wiederverwendet wird. Liefert sie nichts, verwenden Sie `ExecuteSql`. Liefert sie mehrere Ergebnismengen oder einen `RETURN`-Wert, den Sie brauchen, steigen Sie auf einen `DbCommand` ab.

Was immer Sie wählen: Setzen Sie `AsEnumerable()` hinter den Aufruf, sobald Sie filtern wollen, und lesen Sie Ausgabeparameter erst nach Abschluss der Enumeration. Diese beiden Regeln decken die meisten Fragen zu diesem Thema ab.

## Verwandte Beiträge

- [Fix: die erforderliche Spalte war nicht in den Ergebnissen einer FromSql-Operation enthalten](/de/2026/07/fix-the-required-column-was-not-present-in-the-results-of-a-fromsql-operation-in-ef-core-11/)
- [EF Core Compiled Queries vs Raw SQL vs Dapper](/de/2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper/)
- [Fix: der LINQ-Ausdruck konnte in EF Core 11 nicht übersetzt werden](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/)
- [Das von EF Core 11 erzeugte SQL protokollieren](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/)
- [ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge in EF Core 11 verwenden](/de/2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11/)

## Quellen

- [SQL Queries, EF Core Dokumentation](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [Raw SQL queries for unmapped types, Neuerungen in EF Core 8](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-8.0/whatsnew#raw-sql-queries-for-unmapped-types)
- [Keyless entity types, EF Core Dokumentation](https://learn.microsoft.com/en-us/ef/core/modeling/keyless-entity-types)
- [Stored procedure mapping, Neuerungen in EF Core 7](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-7.0/whatsnew#stored-procedure-mapping)
- [Neuerungen in EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew)
- [dotnet/efcore#8127, FromSql: Support multiple resultsets](https://github.com/dotnet/efcore/issues/8127)
- [RelationalStrings.FromSqlNonComposable](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.diagnostics.relationalstrings.fromsqlnoncomposable)
