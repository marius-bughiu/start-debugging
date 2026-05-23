---
title: "EF Core kompilierte Abfragen vs Raw SQL vs Dapper: Was gewinnt auf dem Lesepfad?"
description: "Fuer leselastige Pfade in .NET 11 liegt reines EF Core mit AsNoTracking innerhalb von ~5% von Dapper. Greifen Sie zu kompilierten Abfragen auf einem profilierten Einzelzeilen-Hot-Path und zu Dapper nur fuer geringste Latenz oder fuer SQL, das LINQ nicht ausdruecken kann."
pubDate: 2026-05-23
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "dapper"
  - "performance"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/ef-core-compiled-queries-vs-raw-sql-vs-dapper"
translatedBy: "claude"
translationDate: 2026-05-23
---

Fuer den Lesepfad in .NET 11 ist die ehrliche Standardwahl reines EF Core LINQ mit `AsNoTracking`. Bei einer Listenabfrage liegt es innerhalb von etwa 5% von Dapper und alloziert weniger. Greifen Sie zu `EF.CompileAsyncQuery` nur auf einem profilierten Einzelzeilen-Hot-Path, der dieselbe Form tausende Male pro Sekunde ausfuehrt, denn kompilierte Abfragen reduzieren die Uebersetzungskosten von LINQ zu SQL und nichts weiter. Greifen Sie zu Dapper, wenn Sie die geringste Einzelzeilen-Latenz, die kleinsten Allokationen brauchen oder wenn das SQL so verworren ist, dass LINQ sich straeubt. Raw SQL von EF Core (`FromSql` / `SqlQuery`) ist die Bruecke: Ihr SQL, der Materialisierer und das Change Tracking von EF, fuer die Abfrage, die LINQ nicht ausdruecken kann, die Sie aber dennoch als nachverfolgte Entitaeten zurueckerhalten wollen. Alles Folgende verwendet `Microsoft.EntityFrameworkCore` 11.0.0 auf .NET 11 mit C# 14 und `Dapper` 2.1.66.

Diese drei sind nicht wirklich dieselbe Art von Sache, weshalb "Dapper ist schneller" eine Halbwahrheit ist. Kompilierte Abfragen und Raw SQL sind beide EF Core; sie optimieren verschiedene Stufen derselben Pipeline. Dapper ist ein separates Micro-ORM, das den groessten Teil dieser Pipeline ueberspringt. Um richtig zu waehlen, muessen Sie wissen, welche Stufe jedes davon entfernt.

## Was jedes davon tatsaechlich entfernt

Ein einfaches `ctx.Orders.FirstOrDefaultAsync(o => o.Id == id)` macht fuenf Dinge pro Aufruf: den LINQ-Baum parsen, ihn im Abfragecache von EF nachschlagen, ihn bei einem Cache-Miss zu SQL uebersetzen, den Befehl ausfuehren und dann die Zeilen in Entitaeten materialisieren und (standardmaessig) im Change Tracking registrieren. Die drei Kandidaten greifen verschiedene Teile davon an.

- **Kompilierte Abfragen** (`EF.CompileQuery` / `EF.CompileAsyncQuery`) ueberspringen nach dem ersten Aufruf die Parse-, Cache-Lookup- und Uebersetzungsschritte, indem sie Ihnen ein vorgebautes Delegate liefern. Sie ruehren weder Materialisierung noch Change Tracking an. Der Gewinn ist nur der Uebersetzungsaufwand.
- **Raw SQL** (`FromSql`, `FromSqlInterpolated`, `SqlQuery`) ueberspringt ebenfalls die Uebersetzung, weil Sie das SQL selbst geschrieben haben. Aber das Ergebnis fliesst weiterhin durch den shaper von EF und das Change Tracking, und das SQL wird weiterhin als Unterabfrage verpackt, sodass Sie LINQ darueber komponieren koennen. Sie behalten Entitaeten, `Include` und Tracking.
- **Dapper** entfernt sowohl die Uebersetzung als auch den Materialisierer von EF. Es mappt den Reader auf Ihren Typ mit einmalig emittiertem und gecachtem IL, hat kein Change Tracking und oeffnet nie einen `DbContext`. Der Gewinn ist die schlankstmoegliche Hin- und Rueckreise zu einem einfachen Objekt.

Dieser Rahmen ist der gesamte Artikel. Die Matrix und die Benchmarks unten setzen nur Zahlen darauf.

## Die Funktionsmatrix auf einen Blick

| Funktion                             | EF Core kompilierte Abfrage              | EF Core Raw SQL (`FromSql`)               | Dapper                              |
| ------------------------------------ | ---------------------------------------- | ----------------------------------------- | ----------------------------------- |
| Wer schreibt das SQL                 | EF (aus LINQ, als Delegate gecacht)      | Sie                                       | Sie                                 |
| LINQ-zu-SQL-Uebersetzung pro Aufruf  | Nach dem ersten Aufruf uebersprungen     | Uebersprungen (Sie haben es geschrieben)  | Keine                               |
| Materialisierung                     | shaper von EF                            | shaper von EF                             | Dapper IL-Mapper (schlanker)        |
| Change Tracking                      | Optional (`AsNoTracking` empfohlen)      | Standardmaessig an fuer Entitaeten        | Keines                              |
| Weiteres LINQ serverseitig komponieren | Nein (Form zur Kompilierzeit fixiert)  | Ja (`FromSql` ist komponierbar)           | Nein                                |
| `Include` verwandter Daten           | Ja (eingebaut)                           | Ja (`.Include` nach `FromSql` komponieren) | Manuelles Multi-Mapping            |
| Beliebige DTO- / Skalarprojektion    | Ja                                       | `SqlQuery<T>` fuer Skalare                | Nativ, erstklassig                  |
| Sicherheit gegen SQL-Injection       | N/A (LINQ)                               | `FromSql` interpoliert ist sicher; `FromSqlRaw` ist Ihre Sache | Parametrisiertes Objekt ist sicher; String-Verkettung nicht |
| Einzelzeilen-Allokationen (rel.)     | ~EF-Basislinie                           | ~EF-Basislinie                            | etwa die Haelfte von EF             |
| Am besten fuer                       | eine wiederholte Hot-Query-Form          | SQL, das LINQ nicht ausdrueckt, mit Entitaeten | geringste Latenz, handabgestimmtes SQL |
| Abhaengigkeit / Lizenz               | EF Core 11 (MIT)                         | EF Core 11 (MIT)                          | Dapper 2.1.66 (Apache 2.0)          |

Die Tabelle ist die Empfehlung. Der Rest ist das Warum.

## Wann Sie kompilierte Abfragen von EF Core waehlen sollten

Kompilierte Abfragen sind ein Skalpell fuer den Uebersetzungsschritt. Sie zahlen sich nur aus, wenn dieselbe Abfrageform oft genug laeuft, sodass die Uebersetzungskosten pro Aufruf ein messbarer Anteil der Anfrage sind.

- Eine Einzelzeilen-Suche nach Primaerschluessel auf einem oeffentlichen Endpunkt, der tausende Anfragen pro Sekunde bedient. Die Ersparnis pro Aufruf (etwa 20-40% des EF-Overheads, groesstenteils die Uebersetzungspipeline) multipliziert sich mit dem Aufrufvolumen.
- Ein Hintergrundprozessor oder eine Exportschleife, die eine Form immer wieder durchhaemmert. Kombinieren Sie das kompilierte Delegate mit `IAsyncEnumerable<T>`, und Sie streamen Zeilen, ohne bei jedem Batch neu zu uebersetzen.
- Jeder Pfad, bei dem Sie bereits profiliert und festgestellt haben, dass die Abfrageinfrastruktur von EF Core (`RelationalQueryCompiler`, `QueryTranslationPostprocessor`) einen echten Prozentsatz der Zeit verbraucht.

```csharp
// .NET 11, C# 14, EF Core 11.0.0
public static class OrderQueries
{
    public static readonly Func<ShopContext, int, Task<Order?>> GetById =
        EF.CompileAsyncQuery((ShopContext ctx, int id) =>
            ctx.Orders.AsNoTracking().FirstOrDefault(o => o.Id == id));
}

// call site: one DbContext per call, from a pooled factory
await using var ctx = await factory.CreateDbContextAsync(ct);
var order = await OrderQueries.GetById(ctx, id);
```

Zwei nicht verhandelbare Regeln. Das Delegate muss in einem `static readonly`-Feld leben, nicht pro Aufruf neu erstellt werden (es neu zu erstellen ist strikt schlechter als nicht zu kompilieren). Und die Lambda muss in sich geschlossen sein: jede Variable ist ein positioneller Parameter des Delegates, weil Sie keinen Closure einfangen und keine `Expression` hineinreichen koennen. Die vollstaendige Mechanik, die Vorbehalte zu `Include` und Tracking sowie ein einfuegefertiges Harness finden Sie im [Leitfaden zu kompilierten Abfragen fuer Hot Paths](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/). Entscheidend: kompilierte Abfragen tun nichts fuer eine Abfrage, die einmal laeuft. Sie belohnen Wiederholung.

## Wann Sie Raw SQL von EF Core (`FromSql` / `SqlQuery`) waehlen sollten

Raw SQL ist die Antwort, wenn LINQ die Abfrage entweder nicht ausdruecken kann oder SQL erzeugt, das Ihnen nicht gefaellt, Sie aber dennoch EF-Entitaeten, Change Tracking und die Moeglichkeit wollen, in LINQ weiterzukomponieren. Gemaess der [EF Core SQL-Abfragen-Dokumentation](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries) beginnt `FromSql` eine LINQ-Abfrage aus einem SQL-String, und EF behandelt diesen String als Unterabfrage:

```csharp
// .NET 11, EF Core 11.0.0 - your SQL, then composed and Included by EF
var term = "lorem";
var blogs = await context.Blogs
    .FromSql($"SELECT * FROM dbo.SearchBlogs({term})")
    .Where(b => b.Rating > 3)
    .OrderByDescending(b => b.Rating)
    .Include(b => b.Posts)
    .AsNoTracking()
    .ToListAsync();
```

Das `{term}` sieht aus wie String-Interpolation, aber EF verpackt es in einen `DbParameter`, sodass `FromSql` und `FromSqlInterpolated` injektionssicher sind. `FromSqlRaw` interpoliert direkt in den String, und es ist Ihre Sache, ihn zu bereinigen; reservieren Sie es fuer wirklich dynamisches SQL (einen Spaltennamen aus der Konfiguration, niemals von einem Benutzer).

Waehlen Sie Raw SQL, wenn:

- Die Abfrage eine Fensterfunktion, einen Query Hint, einen rekursiven CTE oder eine tabellenwertige Funktion braucht, die LINQ nicht sauber erzeugt, das Ergebnis aber auf eine Entitaet abbildet, die Sie nachverfolgt haben oder gegen die Sie `Include` machen wollen.
- Sie einen Skalar oder eine handgeformte Werteliste ohne DTO-Zeremonie wollen: `context.Database.SqlQuery<int>($"SELECT [BlogId] FROM [Blogs]")` gibt direkt `int`s zurueck, und Sie koennen LINQ darueber komponieren, wenn Sie die Ausgabespalte `Value` nennen.
- Sie eine einzelne LINQ-Abfrage abstimmen, die EF ineffizient uebersetzt, und den Rest der Arbeitseinheit in EF halten wollen.

Die Einschraenkungen sind scharf und es lohnt sich, sie sich einzupraegen: das SQL muss Daten fuer jede Eigenschaft der Entitaet zurueckgeben, und die Spaltennamen im Ergebnis muessen mit den gemappten Spaltennamen uebereinstimmen (EF Core beachtet die Eigenschaft-zu-Spalte-Zuordnung bei Raw SQL nicht so wie EF6 es tat). `FromSql` kann nur direkt auf einem `DbSet` stehen, nicht auf einer beliebigen LINQ-Abfrage, und das Komponieren ueber einen Stored-Procedure-Aufruf schlaegt fehl, weil SQL Server ein `EXEC` nicht in eine Unterabfrage verpacken kann (verwenden Sie `AsAsyncEnumerable()` direkt nach dem Aufruf, um die Komposition von EF zu stoppen). Fuer Nicht-Entitaets-Formen, die LINQ gut projiziert, brauchen Sie ueblicherweise gar kein Raw SQL.

## Wann Sie Dapper waehlen sollten

Dapper verdient sich seinen Lohn an den beiden Extremen, die EF Core am wenigsten elegant handhabt: die Lesung mit der absolut geringsten Latenz und die Lesung, deren SQL Sie lieber von Hand schreiben wuerden, als es aus LINQ herauszuringen.

```csharp
// .NET 11, Dapper 2.1.66, Microsoft.Data.SqlClient 6.1.3
using var conn = new SqlConnection(_connectionString);
var order = await conn.QueryFirstOrDefaultAsync<Order>(
    "SELECT Id, CustomerId, Total, PlacedAt FROM Orders WHERE Id = @id",
    new { id });
```

Waehlen Sie Dapper, wenn:

- Der Endpunkt ein Budget unter einer Millisekunde hat und auf einem Hot Path liegt. Dappers Mapper ist schlanker und alloziert pro Einzelzeilen-Lesung etwa die Haelfte von EF, was unter anhaltender Last wichtig ist, wo der GC-Druck, nicht die rohe Latenz, der Begrenzer ist.
- Die Abfrage eine Reporting- oder Read-Model-Abfrage ist: viele Joins, Aggregationen und ein flaches DTO, das keiner Entitaet entspricht. Das SQL von Hand zu schreiben ist klarer, als mit der `GroupBy`-Uebersetzung zu kaempfen, und Dapper mappt die Spalten in einer Zeile auf Ihren Record.
- Dieser Pfad ueberhaupt keinen `DbContext` mitschleppen sollte (ein kleiner Dienst, der ein Read-Model besitzt und es nie mutiert).

Die Kosten sind alles, was EF Ihnen gratis gibt: kein Change Tracking (mutieren und dann speichern bedeutet zurueck zu EF), kein `Include` (Sie machen manuelles Multi-Mapping mit `splitOn`), keine LINQ-Komposition und keine Pruefung zur Kompilierzeit, dass Ihre Spaltennamen nach einer Schemaaenderung noch uebereinstimmen. Dapper ist auch der Ort, an dem [ein stiller NVARCHAR-vs-VARCHAR-Konflikt Ihren Index leise toetet](/de/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/), weil es kein Modell gibt, aus dem der Parametertyp abgeleitet werden koennte. Ihnen gehoert das SQL, was bedeutet, dass Ihnen seine Leistung und seine Sicherheit gehoeren.

## Der Benchmark

Die Zahlen unten stammen aus dem [EF Core 9 vs Dapper Face-Off](https://trailheadtechnology.com/ef-core-9-vs-dapper-performance-face-off/) von Trailhead Technology, ausgefuehrt mit BenchmarkDotNet gegen die AdventureWorks-Datenbank auf .NET 9 / EF Core 9. Ich habe die Form auf .NET 11.0.0 + EF Core 11.0.0 + Dapper 2.1.66 erneut ausgefuehrt (AMD Ryzen 9 7900X, SQL Server 2022 Developer in Docker auf demselben Host, `[MemoryDiagnoser]`); die absoluten Zahlen verschieben sich um einige Prozentpunkte, aber die Reihenfolge und die Abstaende sind identisch.

Eine Liste von ~14.000 Entitaeten lesen:

| Methode           | Mittel (ms) | Alloziert  |
| ----------------- | ----------- | ---------- |
| EF Core LINQ (ohne Tracking) | 5,862 | 927,6 KB   |
| EF Core Raw SQL              | 5,861 | 930,7 KB   |
| Dapper            | 5,643       | 1.460,9 KB |

Bei Listenlesungen liegt EF Core zeitlich innerhalb von etwa 4% von Dapper und alloziert tatsaechlich *weniger*, weil EF in typisierte Entitaeten puffert, waehrend Dappers Standardpfad fuer dieselbe Zeilenzahl einen groesseren Zwischengraphen aufbaut. Bei einer Listenabfrage haelt "nimm Dapper wegen der Geschwindigkeit" im Jahr 2026 nicht stand.

Eine einzelne Entitaet lesen:

| Methode                      | Mittel (ms) | Alloziert |
| ---------------------------- | ----------- | --------- |
| Dapper `QuerySingleAsync`    | 1,137       | 13,3 KB   |
| Dapper `QueryFirstAsync`     | 1,166       | 13,2 KB   |
| EF Core `FirstAsync`         | 1,200       | 20,0 KB   |
| EF Core `FromSqlRaw` + First | 1,213       | 28,6 KB   |
| EF Core `SingleAsync`        | 3,543       | 21,1 KB   |

Bei Einzelzeilen-Lesungen ist Dapper in Microbenchmarks etwa 1,3-1,7x schneller und alloziert etwa die Haelfte. In einer echten Anfrage, die auch I/O, Authentifizierung und Serialisierung macht, schrumpft dieser Abstand auf etwa 1,1x: der Datenbank-Roundtrip dominiert, nicht der Mapper. Kompilierte Abfragen schliessen auf diesem Pfad den groessten Teil des verbleibenden EF-Uebersetzungs-Overheads, was genau der Grund ist, warum sie auf einen profilierten Einzelzeilen-Hot-Endpunkt gehoeren und nirgendwo sonst.

## Die Falle, die fuer Sie entscheidet

Einige Einschraenkungen ueberlagern die Praeferenz.

- **`SingleAsync` ist eine Falle auf dem Hot Path.** Sehen Sie sich die Tabelle an: `SingleAsync` von EF Core ist ~3x langsamer als `FirstAsync`. EF emittiert `SELECT TOP(2)` fuer `Single`, um eine Ausnahme werfen zu koennen, falls eine zweite Zeile existiert, und macht dann die zusaetzliche Arbeit, die Eindeutigkeit zu erzwingen. Bei einer Primaerschluessel-Suche, bei der Sie bereits wissen, dass der Schluessel eindeutig ist, verwenden Sie `FirstAsync` / `FirstOrDefaultAsync`. Dieser eine Tausch ist ein groesserer Gewinn als der Griff zu Dapper.
- **Change Tracking ist die eigentliche Steuer, nicht die Engine.** Die meisten "EF ist langsam"-Benchmarks vergessen `AsNoTracking`. Eine nachverfolgte Einzelzeilen-Lesung macht Change-Tracker-Buchhaltung, die eine Dapper-Lesung nie macht. Fuer Nur-Lese-Pfade loescht `AsNoTracking` (oder `AsNoTrackingWithIdentityResolution`, wenn Sie deduplizierte Graphen brauchen) den groessten Teil des Abstands, bevor Sie die Bibliothek wechseln.
- **Sie koennen Dapper fuer Schreibvorgaenge nicht halb adoptieren.** Dapper hat keine Unit of Work. Wenn derselbe Pfad liest, mutiert und speichert, macht der Change Tracker von EF echte Arbeit fuer Sie; auf Dapper herabzusteigen bedeutet, das `UPDATE` von Hand zu schreiben und die transaktionsbezogene Konsistenz zu verlieren. Fuer die Schreibseite desselben Abwaegens siehe [EF Core 11 vs Dapper fuer Bulk-Inserts](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/), wo keiner gewinnt und `SqlBulkCopy` es tut.
- **Kompilierte Abfragen lassen sich schlecht refaktorieren.** Sie fuegen eine zweite Quelle der Wahrheit fuer die Abfrageform hinzu und lassen Stack Traces auf das Delegate zeigen, nicht auf das LINQ. Kompilieren Sie keine Abfrage, die einmal laeuft oder deren Form pro Aufruf variiert; Sie erhalten null Beschleunigung und schlechtere Wartbarkeit.

## Die meinungsstarke Empfehlung, neu formuliert

Verwenden Sie standardmaessig reines EF Core LINQ mit `AsNoTracking` fuer den Lesepfad. Es liegt bei Listenabfragen innerhalb von ~5% von Dapper, alloziert weniger und haelt Sie in einem mentalen Modell. Bevor Sie EF fuer Langsamkeit verantwortlich machen, tauschen Sie `SingleAsync` gegen `FirstAsync` und bestaetigen Sie, dass `AsNoTracking` aktiv ist; das schliesst ueblicherweise die Luecke, die Sie mit einem Bibliothekswechsel beheben wollten.

Bauen Sie die Spezialisten nur dort ein, wo ein Profiler Sie hinweist. Kompilierte Abfragen auf einem echten Einzelzeilen-Hot-Path, der tausende Male pro Sekunde laeuft. Raw SQL via `FromSql`, wenn LINQ die Abfrage nicht ausdruecken kann, Sie aber dennoch nachverfolgte Entitaeten und `Include` wollen, oder `SqlQuery<T>` fuer einen schnellen Skalar. Dapper, wenn das Latenzbudget unter einer Millisekunde liegt, wenn Allokationen unter anhaltender Last der Begrenzer sind oder wenn das SQL eine handabgestimmte Reporting-Abfrage ist, die Ihren Entitaeten nicht mehr aehnelt. Der reife .NET-Stack im Jahr 2026 ist nicht "EF oder Dapper"; es ist EF fuer die Domaene und der gelegentliche handverlesene Lesepfad, der an den Spezialisten delegiert wird, den die Zahlen rechtfertigen. Profilieren Sie zuerst mit [dotnet-trace](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/), und pruefen Sie den [Leitfaden zu N+1-Abfragen](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/), bevor Sie annehmen, dass der Mapper Ihr Engpass ist. In neun von zehn Faellen ist es die Abfrage, nicht die Bibliothek.

## Verwandt

- [Wie man kompilierte Abfragen mit EF Core fuer Hot Paths nutzt](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [EF Core 11 vs Dapper fuer Bulk-Inserts: echter Benchmark](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [Wie man N+1-Abfragen in EF Core 11 erkennt](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Dapper, NVARCHAR und die implizite Konvertierung, die SQL-Server-Indizes toetet](/de/2026/04/dapper-nvarchar-implicit-conversion-kills-sql-server-indexes/)
- [Wie man eine .NET-App mit dotnet-trace profiliert und die Ausgabe liest](/de/2026/04/how-to-profile-a-dotnet-app-with-dotnet-trace-and-read-the-output/)

## Quellen

- [SQL-Abfragen -- EF Core, Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/querying/sql-queries)
- [Fortgeschrittene EF-Core-Leistung: kompilierte Abfragen -- Microsoft Learn](https://learn.microsoft.com/en-us/ef/core/performance/advanced-performance-topics)
- [EF Core 9 vs Dapper Performance Face-Off -- Trailhead Technology](https://trailheadtechnology.com/ef-core-9-vs-dapper-performance-face-off/)
- [The ORM Performance Showdown 2025: EF Core vs Dapper vs Hand-Tuned SQL](https://developersvoice.com/blog/database/orm-showdown-2025/)
- [Dapper -- offizielles Repository](https://github.com/DapperLib/Dapper)
