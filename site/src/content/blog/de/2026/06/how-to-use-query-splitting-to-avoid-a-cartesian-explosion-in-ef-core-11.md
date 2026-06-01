---
title: "So vermeiden Sie mit Query Splitting eine kartesische Explosion in EF Core 11"
description: "Wenn Sie zwei gleichrangige Collections per Include laden, gibt EF Core 11 das Kreuzprodukt zurück und Ihre Zeilenzahl explodiert. So behebt AsSplitQuery das Problem, so aktivieren Sie es global, und das sind die Konsistenz- und Sortierfallen, die Sie beachten sollten."
pubDate: 2026-06-01
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "sql-server"
  - "how-to"
lang: "de"
translationOf: "2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-01
---

Kurze Antwort: Wenn eine einzelne LINQ-Abfrage zwei oder mehr Collection-Navigationen auf derselben Ebene lädt (`.Include(b => b.Posts).Include(b => b.Contributors)`), übersetzt EF Core sie in eine einzige SQL-Anweisung mit gleichrangigen JOINs, und die Datenbank gibt das Kreuzprodukt beider Collections zurück. Ein Blog mit 50 Posts und 20 Mitwirkenden kommt als 1000 Zeilen zurück. Rufen Sie `.AsSplitQuery()` auf, und EF Core 11 gibt stattdessen eine Abfrage pro Collection aus, sodass Sie 50 + 20 = 70 Zeilen über getrennte Roundtrips erhalten. Die Lösung ist ein einziger Methodenaufruf, aber drei Dinge bereiten Schwierigkeiten: die Datenkonsistenz über die aufgeteilten Abfragen hinweg, die zusätzlichen Referenz-Joins, die in jeder Abfrage wiederholt werden, und die Korrektheit der Sortierung mit `Skip`/`Take`.

Dieser Beitrag bezieht sich auf .NET 11 und EF Core 11 (`Microsoft.EntityFrameworkCore` 11.0.x) gegen SQL Server, aber die Mechanik der kartesischen Explosion und die `AsSplitQuery`-API sind in PostgreSQL und SQLite identisch. Ich zeige das explodierte SQL, das aufgeteilte SQL, wie Sie das Verhalten pro Abfrage und global festlegen, und wie Sie zwischen beiden entscheiden.

## Was eine kartesische Explosion tatsächlich ist

Ein relationaler JOIN zwischen einem Elternobjekt und einer einzelnen untergeordneten Collection ist unproblematisch. Das Problem beginnt, wenn Sie ein Elternobjekt mit zwei untergeordneten Collections joinen, die am selben Elternobjekt hängen. Nehmen Sie das kanonische Blog-Modell:

```csharp
// .NET 11, EF Core 11.0.0, C# 14
public sealed class Blog
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public List<Post> Posts { get; set; } = [];
    public List<Contributor> Contributors { get; set; } = [];
}

public sealed class Post
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public string Title { get; set; } = "";
}

public sealed class Contributor
{
    public int Id { get; set; }
    public int BlogId { get; set; }
    public string FirstName { get; set; } = "";
}
```

Laden Sie nun einen Blog mit beiden Collections in einer einzigen Abfrage:

```csharp
var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .ToListAsync();
```

EF Core 11 erzeugt eine einzige Anweisung mit zwei `LEFT JOIN`s auf derselben Ebene:

```sql
SELECT [b].[Id], [b].[Name],
       [p].[Id], [p].[BlogId], [p].[Title],
       [c].[Id], [c].[BlogId], [c].[FirstName]
FROM [Blogs] AS [b]
LEFT JOIN [Posts] AS [p] ON [b].[Id] = [p].[BlogId]
LEFT JOIN [Contributors] AS [c] ON [b].[Id] = [c].[BlogId]
ORDER BY [b].[Id], [p].[Id]
```

Da `Posts` und `Contributors` beide Collections von `Blog` sind, hat die Datenbank keine andere Wahl, als ein Kreuzprodukt zurückzugeben: Jede Post-Zeile wird mit jeder Contributor-Zeile dieses Blogs kombiniert. Ein Blog mit 50 Posts und 20 Mitwirkenden ergibt 50 * 20 = 1000 Zeilen, und jede dieser Zeilen wiederholt alle `Blog`-Spalten sowie die Post-Spalten und die Contributor-Spalten. EF Core dedupliziert die materialisierten Objekte auf dem Client, sodass Sie weiterhin einen `Blog` mit 50 Posts und 20 Mitwirkenden erhalten, aber die Leitung hat für 1000 Zeilen redundanter Daten bezahlt.

Der Multiplikator ist das Produkt der Collection-Größen, nicht die Summe. Fügen Sie eine dritte gleichrangige Collection mit 10 Zeilen hinzu, und Sie sind bei 50 * 20 * 10 = 10.000 Zeilen für ein einzelnes Elternobjekt. Deshalb kann eine Abfrage, die in der Entwicklung harmlos aussieht, wo jeder Blog zwei Posts hat, in der Produktion Hunderte von Megabyte übertragen, wo Blogs Hunderte von Posts haben. Der [offizielle Leitfaden zu Einzel- und aufgeteilten Abfragen von EF Core](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries) dokumentiert einen realen Fall, in dem die Zeilenzahl nach der Aufteilung von über 133.000 auf knapp über 1000 fiel.

Ein wichtiger Nicht-Fall: Verschachtelte Includes auf verschiedenen Ebenen explodieren nicht. `.Include(b => b.Posts).ThenInclude(p => p.Comments)` ist `Comments`, das an `Post` hängt, nicht an `Blog`, sodass jeder Kommentar auf genau eine Zeile abgebildet wird und kein Kreuzprodukt entsteht. Die kartesische Explosion betrifft speziell gleichrangige Collections auf derselben Ebene.

## Die Warnung, die EF Core Ihnen bereits gibt

EF Core 11 lässt dies nicht stillschweigend ohne Hinweis geschehen. Wenn es eine Abfrage erkennt, die mehrere Collections lädt, und Sie kein Aufteilungsverhalten gewählt haben, löst es `MultipleCollectionIncludeWarning` über die Logging-Pipeline aus. Standardmäßig wird sie protokolliert, nicht ausgelöst, sodass sie in einem unübersichtlichen Log leicht übersehen wird. Sie können sie zu einer Ausnahme hochstufen, damit sie in der Entwicklung schnell fehlschlägt:

```csharp
// .NET 11, EF Core 11.0.0
services.AddDbContext<BloggingContext>(options =>
{
    options.UseSqlServer(connectionString);
    options.ConfigureWarnings(w =>
        w.Throw(RelationalEventId.MultipleCollectionIncludeWarning));
});
```

Damit löst jede Abfrage, die zwei gleichrangige Collections ohne ein explizites `AsSingleQuery()` oder `AsSplitQuery()` einbezieht, zur Laufzeit eine Ausnahme aus und zwingt den Autor zu einer bewussten Entscheidung. Dies ist dieselbe defensive Haltung, die ich zum Aufspüren von Performance-Regressionen im [Leitfaden zum Erkennen von N+1-Abfragen in EF Core 11](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) empfehle: Sorgen Sie dafür, dass das Framework laut auf Muster hinweist, die schlecht skalieren, anstatt sie unter Last zu entdecken.

## Die Lösung: AsSplitQuery

Fügen Sie der Abfrage einen Operator hinzu:

```csharp
var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

EF Core 11 gibt nun drei separate SQL-Anweisungen über dieselbe Verbindung aus: die Root-Abfrage für die Blogs, eine Abfrage für die Posts und eine für die Mitwirkenden.

```sql
-- Query 1: the roots
SELECT [b].[Id], [b].[Name]
FROM [Blogs] AS [b]
ORDER BY [b].[Id]

-- Query 2: posts, correlated back to the roots
SELECT [p].[Id], [p].[BlogId], [p].[Title], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Posts] AS [p] ON [b].[Id] = [p].[BlogId]
ORDER BY [b].[Id]

-- Query 3: contributors, correlated back to the roots
SELECT [c].[Id], [c].[BlogId], [c].[FirstName], [b].[Id]
FROM [Blogs] AS [b]
INNER JOIN [Contributors] AS [c] ON [b].[Id] = [c].[BlogId]
ORDER BY [b].[Id]
```

Derselbe Blog kostet nun 50 Post-Zeilen plus 20 Contributor-Zeilen plus 1 Root-Zeile, insgesamt 71 Zeilen statt 1000. Keine Daten werden dupliziert, da die Blog-Spalten einmal in Abfrage 1 erscheinen, statt auf jede Kreuzprodukt-Zeile gestempelt zu werden. EF Core fügt die drei Ergebnismengen auf dem Client mithilfe des Korrelationsschlüssels wieder zusammen, weshalb jede untergeordnete Abfrage `[b].[Id]` erneut auswählt und danach sortiert.

Der zurückgegebene Objektgraph ist Byte für Byte identisch mit der Einzelabfrage-Version. `AsSplitQuery` ändert nur, wie die Daten übertragen werden, niemals das, was Sie zurückbekommen. Das macht es zu einem sicheren Ersatz für jede Leseabfrage, bei der das Elternobjekt mehrere große Collections hat.

## Query Splitting global aktivieren

Wenn sich die meisten Ihrer Abfragen in mehrere Collections auffächern, ist das Umstellen des Standards sauberer, als `AsSplitQuery()` überall zu verteilen. Konfigurieren Sie es in den Provider-Optionen mit `UseQuerySplittingBehavior`:

```csharp
// .NET 11, EF Core 11.0.0
services.AddDbContext<BloggingContext>(options =>
{
    options.UseSqlServer(connectionString,
        sql => sql.UseQuerySplittingBehavior(QuerySplittingBehavior.SplitQuery));
});
```

Das Enum `QuerySplittingBehavior` hat zwei Werte: `SingleQuery` (der Framework-Standard, alles in eine einzige Anweisung joinen) und `SplitQuery` (eine Anweisung pro Collection). Sobald der globale Standard `SplitQuery` ist, melden Sie einzelne Abfragen mit `AsSingleQuery()` wieder zu einer einzigen Anweisung an:

```csharp
var blog = await ctx.Blogs
    .Include(b => b.Posts)
    .AsSingleQuery()       // override the global SplitQuery default
    .FirstAsync(b => b.Id == id);
```

Eine sinnvolle Faustregel: Verwenden Sie `AsSingleQuery` für Abfragen, die genau eine Collection laden (keine Explosion ist möglich, und Sie sparen einen Roundtrip), und lassen Sie den globalen Standard `SplitQuery` alles mit zwei oder mehr abdecken. Das Setzen des globalen Standards unterdrückt auch `MultipleCollectionIncludeWarning`, da Sie nun eine explizite Entscheidung für den gesamten Kontext getroffen haben.

## Wann Query Splitting die falsche Wahl ist

Aufteilen ist kein kostenloser Gewinn, und es als solchen zu behandeln, ist der Weg, ein Bandbreitenproblem gegen ein Latenz- oder Korrektheitsproblem einzutauschen. Drei Nachteile zum Abwägen:

**Jede Aufteilung ist ein separater Roundtrip.** Drei Collections bedeuten drei Roundtrips zur Datenbank. In einem lokalen Netzwerk mit geringer Latenz ist das unsichtbar, aber gegen eine Cloud-Datenbank mit 15 ms Roundtrip-Latenz fügen drei sequenzielle Abfragen 45 ms reines Warten hinzu, bevor irgendeine Arbeit beginnt. Wenn Ihre Collections klein sind (eine Handvoll Zeilen pro Stück), ist das Kreuzprodukt winzig, und eine einzelne JOIN-Abfrage, die einen Roundtrip bezahlt, ist schneller als drei aufgeteilte Abfragen, die jeweils ihren eigenen bezahlen. Aufgeteilte Abfragen gewinnen, wenn die Collections groß genug sind, dass die Zeilenzahl des Kreuzprodukts die Roundtrip-Kosten in den Schatten stellt.

**Es gibt standardmäßig keine transaktionale Konsistenz über die Aufteilungen hinweg.** Eine einzelne SQL-Anweisung sieht einen konsistenten Snapshot der Datenbank. Aufgeteilte Abfragen sind mehrere Anweisungen, und wenn eine andere Transaktion zwischen Abfrage 1 und Abfrage 2 committet, passen die geladenen Posts möglicherweise nicht zum Blog-Zustand, den Sie geladen haben. Die Lösung ist laut offizieller Dokumentation, die Lesevorgänge in eine serialisierbare oder Snapshot-Transaktion einzuschließen:

```csharp
// .NET 11, EF Core 11.0.0
using var tx = await ctx.Database.BeginTransactionAsync(
    System.Data.IsolationLevel.Snapshot);

var blogs = await ctx.Blogs
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();

await tx.CommitAsync();
```

Für die meisten Lesepfade spielt das kurze Inkonsistenzfenster keine Rolle, aber wenn Sie eine Summe über Collections berechnen, die übereinstimmen muss, greifen Sie zur Snapshot-Isolation.

**Referenz-Navigationen werden in jede Aufteilung gejoint.** Wenn Sie neben Ihren Collections auch eine zu-eins-Navigation per `Include` einbeziehen, wiederholt jede aufgeteilte Abfrage den Join zu dieser Referenztabelle. In EF Core 10 und früher war das reine Verschwendung. EF Core 11 hat das behoben: Wie im [Beitrag über das Beschneiden von Referenz-Joins in aufgeteilten Abfragen durch EF Core 11](/de/2026/04/efcore-11-preview-3-prunes-reference-joins-split-queries/) beschrieben, entfernt die Laufzeit nun Referenz-Joins aus den untergeordneten Abfragen, die sie nicht projizieren, sodass ein `BlogType`-Lookup nicht mehr in der Posts-Abfrage erneut gejoint wird. Beachten Sie, dass Eins-zu-eins- und Viele-zu-eins-Referenzen auch im aufgeteilten Modus immer per JOIN geladen werden, da eine Referenz keine Zeilen multiplizieren kann, sodass es nichts aufzuteilen gibt.

## Die Sortierfalle mit Skip und Take

Die subtile Korrektheitsfalle ist die Paginierung. Aufgeteilte Abfragen korrelieren ihre Ergebnismengen durch Sortieren nach einem gemeinsamen Schlüssel, und wenn Ihre Sortierung nicht vollständig eindeutig ist, kann jede aufgeteilte Abfrage in Kombination mit `Skip`/`Take` eine andere Teilmenge von Zeilen auswählen. Angenommen, Sie sortieren die Blogs nach `CreatedDate` und zwei Blogs teilen sich dasselbe Datum:

```csharp
// Risky on older EF: non-unique ordering with paging
var page = await ctx.Blogs
    .OrderBy(b => b.CreatedDate)
    .Skip(20).Take(10)
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

Da relationale Datenbanken keine inhärente Sortierung anwenden, könnten die Root-Abfrage und die untergeordneten Abfragen den Gleichstand jeweils unterschiedlich auflösen und Posts für einen Blog zurückgeben, der nicht auf Ihrer Seite ist. EF Core 10 und 11 härten dies ab, indem sie automatisch den Primärschlüssel an die generierte `ORDER BY`-Klausel anhängen, damit der Korrelationsschlüssel eindeutig ist, aber die sichere Gewohnheit ist, Ihre eigene Sortierung unabhängig von der EF-Version deterministisch zu machen:

```csharp
// .NET 11, EF Core 11.0.0 -- fully unique ordering
var page = await ctx.Blogs
    .OrderBy(b => b.CreatedDate)
    .ThenBy(b => b.Id)            // tie-breaker makes the order total
    .Skip(20).Take(10)
    .Include(b => b.Posts)
    .Include(b => b.Contributors)
    .AsSplitQuery()
    .ToListAsync();
```

Das Hinzufügen von `ThenBy(b => b.Id)` macht die Sortierung total, sodass jede aufgeteilte Abfrage darüber übereinstimmt, welche 10 Blogs auf der Seite sind. Das kostet nichts und beseitigt eine Klasse von Bugs, die nur auftaucht, wenn zwei Zeilen zufällig gleichstehen.

## Eine schnelle Entscheidungs-Checkliste

Wenn Sie auf eine Abfrage stoßen, die mehrere Collections einbezieht, arbeiten Sie dies durch:

1. **Lädt die Abfrage zwei oder mehr gleichrangige Collections?** Wenn nicht, können Sie keine kartesische Explosion haben. Lassen Sie sie als einzelne Abfrage.
2. **Sind die Collections in der Produktion groß?** Wenn jedes Elternobjekt Hunderte von Zeilen pro Collection hat, ist das Kreuzprodukt der dominierende Kostenfaktor. Teilen Sie sie auf.
3. **Ist die Datenbanklatenz hoch (Cloud, regionsübergreifend)?** Wenn ja und die Collections klein sind, können die zusätzlichen Roundtrips mehr kosten als die Explosion. Messen Sie, bevor Sie aufteilen.
4. **Benötigt der Lesevorgang einen konsistenten Snapshot?** Wenn Sie Aggregate über Collections berechnen, schließen Sie die Aufteilung in eine Snapshot- oder serialisierbare Transaktion ein.
5. **Gibt es eine Paginierung?** Machen Sie das `OrderBy` mit einem Primärschlüssel-Tie-Breaker vollständig eindeutig.

Für heiße Pfade, in denen die Abfrage tausende Male pro Sekunde läuft, kombinieren Sie die Aufteilung mit [kompilierten Abfragen in EF Core](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/), damit die LINQ-zu-SQL-Übersetzung zwischengespeichert wird. Und wenn der Lesevorgang wirklich auf dem kritischen Pfad liegt und der EF-Core-Overhead ins Gewicht fällt, lohnt sich ein Blick auf den Vergleich in [EF Core 11 vs Dapper für Massenoperationen](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/), wobei `AsSplitQuery` beim gewöhnlichen Laden von Collections den größten Teil der Lücke schließt. Wenn Sie die Ergebnisse streamen, statt eine Liste zu materialisieren, gelten dieselben Aufteilungsregeln für [IAsyncEnumerable-Abfragen in EF Core 11](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/).

Die kartesische Explosion ist eines der wenigen EF-Core-Performance-Probleme mit einer einzeiligen Lösung und einer identischen Ergebnismenge. Der schwierige Teil ist nicht der `AsSplitQuery()`-Aufruf, sondern überhaupt zu wissen, dass es passiert. Verwandeln Sie `MultipleCollectionIncludeWarning` in der Entwicklung in eine Ausnahme, und das Framework wird Ihnen genau sagen, welche Abfragen die Behandlung benötigen, bevor sie jemals die Produktion erreichen.

Quelle: [Einzel- und aufgeteilte Abfragen, EF-Core-Dokumentation](https://learn.microsoft.com/en-us/ef/core/querying/single-split-queries), und die [Neuerungen-Notizen zu EF Core 11](https://learn.microsoft.com/en-us/ef/core/what-is-new/ef-core-11.0/whatsnew).
