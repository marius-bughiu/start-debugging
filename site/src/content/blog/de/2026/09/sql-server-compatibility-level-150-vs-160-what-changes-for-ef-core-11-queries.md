---
title: "SQL Server Kompatibilitätsgrad 150 vs 160: Was sich für Abfragen in EF Core 11 ändert"
description: "EF Core 11 setzt UseSqlServer jetzt standardmäßig auf Kompatibilitätsgrad 160. Damit landen LEAST, GREATEST und LTRIM/RTRIM mit zwei Argumenten in Ihrem SQL, auch bei jedem Take(n).FirstOrDefault(). Bleiben Sie auf SQL Server 2022 und neuer bei 160; legen Sie UseCompatibilityLevel(150) fest, wenn noch irgendeine Umgebung SQL Server 2019 betreibt."
pubDate: 2026-09-16
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "sql-server"
  - "dotnet-11"
lang: "de"
translationOf: "2026/09/sql-server-compatibility-level-150-vs-160-what-changes-for-ef-core-11-queries"
translatedBy: "claude"
translationDate: 2026-09-16
---

Kurze Antwort: Wenn jede Datenbank, mit der Ihre App spricht, auf SQL Server 2022 oder neuer läuft, behalten Sie den neuen Standard von EF Core 11 bei, den Kompatibilitätsgrad 160. Er übersetzt `Math.Min`/`Math.Max`, `EF.Functions.Least`/`Greatest`, `Min`/`Max` über Inline-Arrays und verkettete `Take`-Aufrufe in `LEAST`/`GREATEST` sowie `TrimStart(char)`/`TrimEnd(char)` in `LTRIM`/`RTRIM` mit zwei Argumenten. Wenn noch irgendeine Umgebung SQL Server 2019 betreibt, rufen Sie `UseCompatibilityLevel(150)` auf, bevor Sie aktualisieren. Bei 160 wird eine so gewöhnliche Abfrage wie `.Take(pageSize).FirstOrDefaultAsync()` zu `SELECT TOP(LEAST(@p, 1))`, und SQL Server 2019 kennt kein `LEAST`.

Alles Folgende wurde mit `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0-rc.1.26425.128 auf dem .NET 11 RC 1 SDK (11.0.100-rc.1.26425.128) mit C# 14 geprüft, und für den Vorher-Zustand mit 10.0.12 auf SDK 10.0.302. Ich habe das SQL verglichen, das beide Versionen erzeugen. Gegen einen laufenden SQL Server habe ich es nicht ausgeführt, das Verhalten auf dem Server stammt also aus der SQL Server-Dokumentation, die unten verlinkt ist.

## 150 vs 160 im Überblick

| LINQ-Form (EF Core 11) | Grad 150 (Standard in EF Core 10) | Grad 160 (Standard in EF Core 11) |
| --- | --- | --- |
| `Math.Max(a, b)` in `Where` / `OrderBy` | Wirft "could not be translated" | `GREATEST([a], [b])` |
| `Math.Min(a, b)` im abschließenden `Select` | Wird auf dem Client ausgewertet | `LEAST([a], [b])` auf dem Server |
| `EF.Functions.Greatest(a, b, c)` in `Where` | Wirft "could not be translated" | `GREATEST([a], [b], [c])` |
| `new[] { a, b }.Max()` | `(SELECT MAX(...) FROM (VALUES ...))` | `GREATEST([a], [b])` |
| `Take(n).FirstOrDefault()` | Verschachteltes `TOP(1)` über einer `TOP(@p)`-Unterabfrage | `TOP(LEAST(@p, 1))` |
| `Skip(s).Take(n).First()` | `TOP(1)` über einer `OFFSET`/`FETCH`-Unterabfrage | `FETCH NEXT LEAST(@p1, 1) ROWS ONLY` |
| `TrimStart('0')` in `Where` | Wirft "could not be translated" | `LTRIM([col], N'0')` |
| `ExecuteUpdate` setzt eine JSON-Eigenschaft auf eine `DateTime`-Spalte | Wirft | `JSON_MODIFY(..., JSON_VALUE(JSON_OBJECT('v': [col]), '$.v'))` |
| DDL / Migrationen | Identisch | Identisch |
| JSON-Spalten | `nvarchar(max)` | `nvarchar(max)` (erst 170 wechselt zu `json`) |
| Mindestversion des Servers | SQL Server 2019 | SQL Server 2022 (und Datenbankgrad 160 für `LTRIM`/`RTRIM` mit Zeichen) |

## Der Kompatibilitätsgrad von EF ist nicht der Kompatibilitätsgrad Ihrer Datenbank

Es gibt zwei getrennte Einstellungen, und beide heißen "Kompatibilitätsgrad".

Die **EF-Einstellung** ist das, was Sie an `UseCompatibilityLevel` übergeben. EF liest sie nie vom Server. Sie wird beim Erstellen der Optionen festgelegt und entscheidet nur, welche SQL-Funktionen die Abfrage-Pipeline verwenden darf. In `SqlServerOptionsExtension` lauten die Standardwerte in EF Core 11 `SqlServerDefaultCompatibilityLevel = 160` und `AzureSqlDefaultCompatibilityLevel = 170`. In EF Core 10 war der erste Wert 150. Die Änderung ist [dotnet/efcore#38198](https://github.com/dotnet/efcore/issues/38198), ausgeliefert in PR #38199, und sie ist als Breaking Change mit geringer Auswirkung für EF Core 11 aufgeführt.

Die **Datenbankeinstellung** ist `sys.databases.compatibility_level`. Sie steuert das Verhalten des Abfrageoptimierers und einige Syntaxregeln. Bei Datenbankgrad 160 aktiviert SQL Server 2022 die parameterabhängige Planoptimierung und das Feedback zur Kardinalitätsschätzung. Eine Datenbank, die Sie auf einem neueren Server wiederherstellen oder anfügen, behält ihren alten Grad. Eine Datenbank, die von SQL Server 2019 auf 2022 umgezogen ist, kann also immer noch auf 150 stehen.

Die beiden Einstellungen wirken nur über das SQL zusammen, das EF sendet. Laut der Microsoft-Seite zum Kompatibilitätsgrad ist neue T-SQL-Syntax nicht an den Datenbank-Kompatibilitätsgrad gebunden, außer wenn sie bestehende Anwendungen beschädigen könnte. `GREATEST` und `LEAST` stehen nicht auf der Liste der Ausnahmen, sie funktionieren auf SQL Server 2022 also bei jedem Datenbankgrad. Das optionale *characters*-Argument von `LTRIM` und `RTRIM` ist eine Ausnahme: Seine Dokumentation verlangt Datenbank-Kompatibilitätsgrad 160.

Beachten Sie außerdem, dass `UseAzureSql` und `UseSqlServer` getrennte Wege sind. `UseAzureSql` stand schon in EF Core 10 standardmäßig auf 170, für Azure SQL-Nutzer ändert sich durch diesen Beitrag also nichts. Wenn Sie `UseSqlServer` auf Azure SQL richten, sind Sie wie alle anderen gerade von 150 auf 160 gewechselt.

## Wie ich den Unterschied gemessen habe

Das Testprogramm baut dasselbe Modell dreimal auf (Standard, `UseCompatibilityLevel(150)`, `UseCompatibilityLevel(160)`). Für Abfragen gibt es `ToQueryString()` aus. Für `FirstOrDefaultAsync` und `ExecuteUpdateAsync` unterdrückt ein Interceptor die Verbindung und fängt den Befehlstext ab, sodass keine Datenbank beteiligt ist:

```csharp
// .NET 11 RC 1, C# 14, Microsoft.EntityFrameworkCore.SqlServer 11.0.0-rc.1.26425.128
var configs = new (string Name, Action<DbContextOptionsBuilder> Configure)[]
{
    ("UseSqlServer (default)", o => o.UseSqlServer(Cs)),
    ("UseSqlServer + 150", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(150))),
    ("UseSqlServer + 160", o => o.UseSqlServer(Cs, s => s.UseCompatibilityLevel(160))),
};

foreach (var (name, configure) in configs)
{
    using var db = Shop.Create(configure); // adds the interceptor, EnableServiceProviderCaching(false)
    Q("Math.Max in Where", () => db.Products
        .Where(p => Math.Max(p.Stock, p.ReorderLevel) > 10).ToQueryString());
    Q("TrimStart('0') in Where", () => db.Products
        .Where(p => p.Sku.TrimStart('0') == "42").ToQueryString());
    // ...one line per shape in the table above
}

class NoDb : DbCommandInterceptor, IDbConnectionInterceptor
{
    public ValueTask<InterceptionResult> ConnectionOpeningAsync(DbConnection c, ConnectionEventData d,
        InterceptionResult r, CancellationToken t = default) => ValueTask.FromResult(InterceptionResult.Suppress());

    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand cmd,
        CommandEventData d, InterceptionResult<DbDataReader> r, CancellationToken t = default)
    {
        Capture.Last = cmd.CommandText;
        throw new CapturedException(); // stop before anything needs a real reader
    }
    // ConnectionOpening (sync) and NonQueryExecutingAsync follow the same pattern
}
```

Dieselbe Datei gegen EF Core 10.0.12 auszuführen, lieferte eine nützliche Kontrolle. EF Core 10 mit `UseCompatibilityLevel(160)` erzeugte SQL, das mit dem Standard von EF Core 11 identisch war. Keine dieser Übersetzungen ist neu in EF Core 11. `Math.Min`/`Math.Max` über `LEAST`/`GREATEST` und die `char`-Überladungen von `TrimStart`/`TrimEnd` wurden beide in EF Core 9 ausgeliefert, gebunden an Grad 160. EF Core 11 hat nur den Standard verschoben, sodass sie sich einschalten, ohne dass Sie danach fragen.

## Die Änderung, die wehtut: Take gefolgt von First oder Single

Mit dieser hatte ich nicht gerechnet, und sie trifft Code, der nichts mit `Math` zu tun hat. Wenn eine Abfrage bereits eine Zeilenbegrenzung hat und Sie eine weitere hinzufügen, führt EF beide zusammen. Sind beide Begrenzungen Konstanten, behält es die kleinere. Andernfalls ruft es `GenerateLeast` auf, das nur bei Grad 160 oder höher einen `LEAST`-Ausdruck zurückgibt. Unter 160 gibt es null zurück, und EF weicht auf eine verschachtelte Abfrage aus.

`FirstOrDefaultAsync` fügt eine Begrenzung von 1 hinzu, `SingleOrDefaultAsync` eine von 2. EF parametrisiert den Wert, den Sie an `Take` übergeben, selbst ein Literal wie `Take(20)`. Ein Repository, das ein seitenweises `IQueryable` zurückgibt, gefolgt von einem Aufrufer, der die erste Zeile anfordert, sieht also so aus:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var first = await db.Products
    .OrderBy(p => p.Id)
    .Take(pageSize)
    .FirstOrDefaultAsync();
```

Bei Grad 160 (dem Standard in EF Core 11):

```sql
SELECT TOP(LEAST(@p, 1)) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
FROM [Products] AS [p]
ORDER BY [p].[Id]
```

Bei Grad 150 (dem Standard in EF Core 10):

```sql
SELECT TOP(1) [p0].[Id], [p0].[CreatedAt], [p0].[ListPrice], [p0].[Name], ...
FROM (
    SELECT TOP(@p) [p].[Id], [p].[CreatedAt], [p].[ListPrice], [p].[Name], ...
    FROM [Products] AS [p]
    ORDER BY [p].[Id]
) AS [p0]
ORDER BY [p0].[Id]
```

Mit `Skip` wandert die Begrenzung in `OFFSET @p ROWS FETCH NEXT LEAST(@p1, 1) ROWS ONLY`. `Take(n).Take(m)` mit zwei Parametern erzeugt `TOP(LEAST(@p, @p1))`. `Take(n).AnyAsync()` und `Take(n).CountAsync()` sind nicht betroffen, weil sie die begrenzte Abfrage umschließen, statt eine zweite Begrenzung daraufzusetzen. `Take(n).Take(n)` mit demselben Parameter ist ebenfalls nicht betroffen, weil EF zwei gleiche Begrenzungen erkennt und eine davon behält.

Auf SQL Server 2022 ist die Form mit 160 einfach kürzeres SQL. Auf SQL Server 2019 weist der Server `LEAST` als unbekannte integrierte Funktion zurück. Dieser Code ließ sich kompilieren, bestand die Tests gegen einen neueren Server und funktionierte auf EF Core 10. Deshalb warnt Sie eine Testsuite, die gegen einen SQL Server 2022-Container läuft, nicht.

## Math.Min, Math.Max und Inline-Arrays

Bei 150 lassen sich `Math.Max` und `EF.Functions.Greatest` überhaupt nicht übersetzen. In einem `Where` oder `OrderBy` erhalten Sie die übliche `InvalidOperationException`, die Sie auffordert, die Abfrage umzuschreiben oder auf Client-Auswertung umzusteigen. In der abschließenden Projektion wählt EF stillschweigend beide Spalten aus und führt `Math.Min` auf dem Client aus:

```sql
-- level 150: Select(p => new { p.Id, Effective = Math.Min(p.Price, p.ListPrice) })
SELECT [p].[Id], [p].[Price], [p].[ListPrice]
FROM [Products] AS [p]

-- level 160
SELECT [p].[Id], LEAST([p].[Price], [p].[ListPrice]) AS [Effective]
FROM [Products] AS [p]
```

Diese Projektion ist die zweite stille Änderung nach dem Upgrade: Dasselbe LINQ hängt jetzt davon ab, dass der Server `LEAST` kennt.

Inline-Arrays hatten bei 150 einen funktionierenden Ausweichweg, eine korrelierte `VALUES`-Unterabfrage:

```sql
-- level 150: Where(p => new[] { p.Stock, p.ReorderLevel }.Max() > 10)
WHERE (
    SELECT MAX([v].[Value])
    FROM (VALUES ([p].[Stock]), ([p].[ReorderLevel])) AS [v]([Value])) > 10

-- level 160
WHERE GREATEST([p].[Stock], [p].[ReorderLevel]) > 10
```

Die Null-Semantik stimmt überein. `GREATEST` und `LEAST` ignorieren `NULL`-Argumente, sofern nicht alle `NULL` sind, genau wie `MAX` über die `VALUES`-Zeilen und wie `Enumerable.Min` über ein `decimal?[]`. EF prüft das auch: Bei einem nullbaren Ergebnistyp wählt es `LEAST`/`GREATEST` nur, wenn die Funktion Nullwerte nicht weitergibt. `new decimal?[] { p.SalePrice, p.Price }.Min()` wird daher zu `LEAST([p].[SalePrice], [p].[Price])`, ohne dass sich die Ergebnisse ändern.

## TrimStart und TrimEnd mit Zeichen

Trimmen ohne Argumente ist auf jedem Grad `LTRIM(col)`. Das Trimmen bestimmter Zeichen braucht die Form mit zwei Argumenten aus SQL Server 2022, und EF verwendet sie nur bei 160:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
var bySku = db.Products.Where(p => p.Sku.TrimStart('0') == "42");
var byName = db.Products.Where(p => p.Name.TrimEnd(' ', '.') == "Widget");
```

```sql
-- level 160
WHERE LTRIM([p].[Sku], N'0') = N'42'
WHERE RTRIM([p].[Name], N' .') = N'Widget'
```

Bei 150 werfen beide "could not be translated". In einem abschließenden `Select` laufen sie auf dem Client, und bei 160 wandern sie auf den Server. Dies ist der Fall, der zusätzlich vom Grad der Datenbank selbst abhängt. Auf SQL Server 2022 verlangt die `LTRIM`-Dokumentation für das characters-Argument Datenbank-Kompatibilitätsgrad 160. Eine Datenbank, die aus 2019 wiederhergestellt und nie angehoben wurde, weist es zurück, obwohl `GREATEST` auf demselben Server problemlos funktioniert.

## ExecuteUpdate in JSON-Spalten

Bei JSON-gemappten komplexen Typen funktioniert das Setzen einer Eigenschaft auf eine `int`- oder `string`-Spalte auf beiden Graden. Das Setzen auf eine Spalte eines anderen Typs, etwa `DateTime`, braucht `JSON_OBJECT`, und das ist ebenfalls SQL Server 2022:

```csharp
// .NET 11 RC 1, EF Core 11.0.0-rc.1.26425.128
await db.Products.ExecuteUpdateAsync(s =>
    s.SetProperty(p => p.Details.LastPriceChange, p => p.CreatedAt));
```

Bei 160 wird daraus `JSON_MODIFY([p].[Details], '$.LastPriceChange', JSON_VALUE(JSON_OBJECT('v': [p].[CreatedAt]), '$.v'))`. Bei 150 wirft EF. EF Core 10.0.12 wirft eine Meldung, die Ihnen sagt, was zu tun ist: "'ExecuteUpdate' cannot set a property in a JSON column to an expression containing a column on SQL Server versions before 2022". EF Core 11 RC 1 verpackt sie in die allgemeine Meldung "could not be translated, see inner exception".

## Was sich zwischen 150 und 160 nicht ändert

Das Schema. `GenerateCreateScript()` lieferte für ein Modell mit einem komplexen JSON-Typ bei 150 und 160 identisches DDL. `SupportsJsonType` kippt erst bei 170, JSON-Spalten bleiben also `nvarchar(max)`, und ein Wechsel zwischen 150 und 160 erzeugt keine Migration. Die auf `OPENJSON` basierenden JSON-Abfragen, die Grad 130 brauchen, bleiben unberührt. Alles, was 170 braucht (der native `json`-Typ, `JSON_CONTAINS`, `.modify()`), bleibt auf beiden Graden ausgeschaltet.

## Wann Sie bei 160 bleiben sollten

- **Jede Umgebung ist SQL Server 2022 oder 2025, oder Azure SQL / Managed Instance.** Sie erhalten kürzeres SQL für seitenweise Abfragen, `Math.Min`/`Math.Max` auf dem Server und ein Trimmen von Zeichen, das übersetzt wird, statt eine Ausnahme zu werfen.
- **Sie haben `UseCompatibilityLevel(160)` bisher von Hand gesetzt.** Sie können den Aufruf löschen. Das Ergebnis ist dasselbe, wie der Kontrolllauf mit EF Core 10 gezeigt hat.
- **Sie haben sich in Projektionen auf die Client-Auswertung von `Math.Min` oder `TrimStart('0')` verlassen.** Diese Arbeit auf den Server zu verlagern, ist in der Regel ohnehin das, was Sie wollten.

## Wann Sie 150 festlegen sollten

- **Irgendeine Umgebung betreibt SQL Server 2019.** Dazu gehören Staging, eine On-Premises-Installation bei einem Kunden oder ein Replikat für die Notfallwiederherstellung. Die Provider-Dokumentation von EF Core 11 führt SQL Server 2019 weiterhin als unterstützt, aber nur mit Grad 150.
- **Ihre Datenbanken laufen auf SQL Server 2022 mit Datenbankgrad 150, und Sie haben darauf keinen Einfluss.** Zum Beispiel gehört die Datenbank einem Anbieter, der den Grad nicht anhebt, weil 160 die Abfragepläne ändert. `GREATEST`/`LEAST` würden dort trotzdem funktionieren, `LTRIM`/`RTRIM` mit Zeichen aber nicht. Das Festlegen von 150 ist die einzige Einstellung auf EF-Seite, die beides abdeckt.
- **Sie liefern eine einzige Binärdatei an viele Mandanten mit unbekannten SQL Server-Versionen aus.** Wählen Sie den Grad, den Ihr ältester unterstützter Server ausführen kann.

## Den Grad explizit machen und beim Start prüfen

Microsofts eigene Provider-Dokumentation empfiehlt, den Grad explizit zu konfigurieren, und diese Änderung des Standards ist ein guter Grund, dem Rat zu folgen. Lesen Sie ihn aus der Konfiguration, damit jede Umgebung angeben kann, was sie betreibt:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
var level = builder.Configuration.GetValue("Database:CompatibilityLevel", 150);

builder.Services.AddDbContext<Shop>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Shop"),
        sql => sql.UseCompatibilityLevel(level)));
```

Brechen Sie dann sofort ab, wenn der konfigurierte Grad mehr verlangt, als der Server bieten kann:

```csharp
// .NET 11, C# 14, EF Core 11.0.0-rc.1.26425.128
await using (var scope = app.Services.CreateAsyncScope())
{
    var db = scope.ServiceProvider.GetRequiredService<Shop>();

    // EngineEdition 5 = Azure SQL Database, 8 = Azure SQL Managed Instance
    var engineEdition = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS [Value]")
        .SingleAsync();
    var serverMajor = await db.Database
        .SqlQuery<int>($"SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int) AS [Value]")
        .SingleAsync();
    var databaseLevel = await db.Database
        .SqlQuery<int>($"SELECT CAST(compatibility_level AS int) AS [Value] FROM sys.databases WHERE name = DB_NAME()")
        .SingleAsync();

    // SQL Server 2019 = 15, 2022 = 16, 2025 = 17; the matching levels are 150, 160, 170
    var isAzure = engineEdition is 5 or 8;
    if ((!isAzure && level > serverMajor * 10) || level > databaseLevel)
        throw new InvalidOperationException(
            $"EF is configured for compatibility level {level}, but the server is version {serverMajor} " +
            $"and the database is at level {databaseLevel}.");
}
```

Azure SQL meldet keine SQL Server-Version im Stil eines Box-Produkts, die sich auf diese Weise vergleichen ließe, daher stützt sich die Prüfung dort nur auf den Datenbankgrad. Der Vergleich mit dem Datenbankgrad ist strenger, als er für `LEAST`/`GREATEST` sein müsste. Ich bevorzuge ihn trotzdem, weil `LTRIM` mit Zeichen sehr wohl vom Datenbankgrad abhängt und eine Prüfung, die nur die Hälfte der Fälle abdeckt, schlechter ist als gar keine. Führen Sie dieselbe Prüfung in Ihren Integrationstests gegen einen Container mit der *ältesten* Serverversion aus, die Sie unterstützen, nicht mit der neuesten.

## Die Empfehlung, noch einmal zusammengefasst

Grad 160 ist 2026 der richtige Standard. SQL Server 2022 ist seit fast vier Jahren verfügbar, und das SQL ist besser. Aber der Standard ist eine Vermutung über Ihren Server, und für einen Betrieb mit SQL Server 2019 ist sie auf eine Weise falsch, auf die kein Compiler, kein Analyzer und keine Migration hinweist. Das erste Anzeichen ist ein SQL-Fehler zur Laufzeit bei Abfragen, die in EF Core 10 funktioniert haben. Setzen Sie `UseCompatibilityLevel` daher in jeder App explizit, die Sie auf EF Core 11 umstellen: 160 oder höher, wenn jeder Server 2022+ ist, 150, wenn auch nur einer es nicht ist.

## Verwandte Artikel

- Der Schritt auf 170 ist deutlich größer, weil er Spaltentypen ändert: [native json-Spalte vs nvarchar(max) in EF Core 11](/de/2026/09/json-vs-nvarchar-max-for-storing-json-in-sql-server-with-ef-core-11/).
- Wenn Sie von einer älteren Version kommen, behandelt [die Breaking Changes von EF Core 6 bis 11, die wirklich wehtun](/de/2026/06/migrate-ef-core-6-to-ef-core-11-breaking-changes/) die anderen versionsabhängigen Übersetzungen.
- Die Fehler bei Grad 150 in diesem Beitrag sind der klassische [Fehler, dass der LINQ-Ausdruck nicht übersetzt werden konnte](/de/2026/07/fix-the-linq-expression-could-not-be-translated-in-ef-core-11/), und die Umschreibungen dort gelten auch hier.
- Um zu sehen, welches SQL Ihre App nach dem Upgrade tatsächlich sendet, [protokollieren Sie das SQL, das EF Core 11 erzeugt](/de/2026/07/how-to-log-the-sql-that-ef-core-11-generates/).
- Um die Abweichung bei der Serverversion in der CI zu erkennen, [führen Sie Integrationstests gegen einen echten SQL Server mit Testcontainers aus](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/), festgelegt auf Ihre älteste Produktionsversion.

## Quellen

- [Breaking Changes in EF Core 11: Der SQL Server-Kompatibilitätsgrad ist jetzt standardmäßig 160](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/breaking-changes#sqlserver-compatibility-level-160)
- [dotnet/efcore#38198: Standard-Kompatibilitätsgrad für SQL Server von 150 auf 160 anheben](https://github.com/dotnet/efcore/issues/38198)
- [dotnet/efcore#38196: Math.Min/Max werden auf dem alten Standardgrad nicht übersetzt](https://github.com/dotnet/efcore/issues/38196)
- [EF Core SQL Server-Provider: Kompatibilitätsgrad](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/#compatibility-level)
- [ALTER DATABASE-Kompatibilitätsgrad: unterstützte Grade und Unterschiede zwischen 150 und 160](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-compatibility-level)
- [GREATEST (Transact-SQL)](https://learn.microsoft.com/en-us/sql/t-sql/functions/logical-functions-greatest-transact-sql)
- [LTRIM (Transact-SQL): Das characters-Argument erfordert Kompatibilitätsgrad 160](https://learn.microsoft.com/en-us/sql/t-sql/functions/ltrim-transact-sql)
- EF Core-Quellcode beim Tag `v11.0.0-rc.1.26425.128`: `SqlServerSqlTranslatingExpressionVisitor.GenerateGreatest`/`GenerateLeast`, `RelationalQueryableMethodTranslatingExpressionVisitor.ApplyLimit`, `SqlServerStringMethodTranslator.TranslateTrimStartEnd`, `SqlServerSingletonOptions`
