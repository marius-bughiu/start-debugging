---
title: "Keyset- (Cursor-)Pagination in EF Core 11"
description: "Ersetzen Sie Skip/Take durch eine WHERE-Klausel, die hinter die zuletzt gesehene Zeile springt. Sortieren Sie nach einem vollständig eindeutigen Schlüssel, tragen Sie die Werte der letzten Zeile als Cursor mit, und EF Core 11 macht aus der nächsten Seite einen Index-Seek statt eines OFFSET-Scans."
pubDate: 2026-06-23
template: how-to
tags:
  - "how-to"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "de"
translationOf: "2026/06/how-to-do-keyset-cursor-pagination-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-23
---

Kurze Antwort: Hören Sie auf, mit `Skip(n).Take(pageSize)` zu paginieren, und beginnen Sie, mit einer `WHERE`-Klausel zu paginieren. Keyset-Pagination (auch Cursor- oder Seek-Pagination genannt) merkt sich die Sortierwerte der letzten Zeile auf der gerade angezeigten Seite und fragt dann die Datenbank nach den Zeilen, die danach einsortiert werden: `OrderBy(x => x.CreatedAt).ThenBy(x => x.Id).Where(x => x.CreatedAt > lastDate || (x.CreatedAt == lastDate && x.Id > lastId)).Take(pageSize)`. Mit einem Index auf den Sortierspalten ist jede Seite ein Index-Seek mit konstanten Kosten, statt eines `OFFSET`, der jede Zeile vor der Seite erneut scannt und verwirft. Die eine harte Anforderung: Sortieren Sie nach etwas vollständig Eindeutigem, was in der Praxis einen echten Sortierschlüssel plus den Primärschlüssel als Tiebreaker bedeutet.

Dieser Beitrag verwendet `Microsoft.EntityFrameworkCore` 11.0.0 unter .NET 11 mit C# 14, gegen SQL Server 2025. Alles hier funktioniert auf PostgreSQL und SQLite genauso; der einzige providerspezifische Hinweis steht am Ende. Wenn Sie jemals gesehen haben, wie Seite 500 eines Grids zehnmal länger braucht als Seite 1, dann ist das die Lösung.

## Warum Skip/Take langsamer wird, je tiefer Sie paginieren

Offset-Pagination ist das Offensichtliche, das jeder zuerst schreibt. Seitengröße 20, Seite 30, 580 Zeilen überspringen:

```csharp
// .NET 11, EF Core 11.0.0 - offset pagination, the slow way
var page = 30;
var pageSize = 20;

var posts = await context.Posts
    .OrderBy(p => p.PostId)
    .Skip((page - 1) * pageSize)
    .Take(pageSize)
    .ToListAsync();
```

EF Core übersetzt `Skip`/`Take` zu SQL `OFFSET`/`FETCH` (oder `LIMIT`/`OFFSET` auf PostgreSQL und SQLite):

```sql
SELECT [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
ORDER BY [p].[PostId]
OFFSET 580 ROWS FETCH NEXT 20 ROWS ONLY;
```

Das Problem ist, was `OFFSET 580` tatsächlich tut. Die Datenbank springt nicht zu Zeile 581. Sie erzeugt alle 600 Zeilen in der Reihenfolge, zählt die ersten 580 ab, wirft sie weg und gibt die letzten 20 zurück. Der Aufwand skaliert mit dem Offset, nicht mit der Seitengröße, also werden tiefe Seiten zunehmend teurer. Auf einer stark genutzten Tabelle ist das genau umgekehrt zu dem, was Nutzer erwarten: Je weiter sie scrollen, desto langsamer wird es.

Es gibt einen zweiten, leiseren Fehler. Offset-Pagination ist unter gleichzeitigen Schreibvorgängen nicht stabil. Die offizielle EF-Core-[Pagination-Anleitung](https://learn.microsoft.com/en-us/ef/core/querying/pagination) beschreibt es klar: Wird zwischen zwei Seitenanfragen eine Zeile eingefügt oder gelöscht, verschiebt sich die gesamte Ergebnismenge um eins, und ein Nutzer, der von Seite 2 zu Seite 3 wechselt, sieht entweder eine Zeile doppelt oder überspringt eine vollständig. Bei einem Admin-Grid bemerkt das niemand. Bei einem Infinite-Scroll-Feed, in den ständig oben Zeilen hinzukommen, ist es ein sichtbarer, reproduzierbarer Defekt.

## Was eine Keyset-Abfrage stattdessen tut

Keyset-Pagination wirft die Idee eines Offsets über Bord. Statt "überspringe 580 Zeilen" sagen Sie "gib mir die Zeilen, die nach dieser konkreten Zeile kommen, die ich bereits habe". Sie merken sich die Sortierwerte der letzten Zeile, und die nächste Seite ist ein `WHERE`, das direkt an ihnen vorbeispringt:

```csharp
// .NET 11, EF Core 11.0.0 - keyset pagination, single unique key
var pageSize = 20;
int? lastPostId = 580; // the PostId of the last row on the previous page; null for page 1

var query = context.Posts.OrderBy(p => p.PostId).AsQueryable();

if (lastPostId is int cursor)
{
    query = query.Where(p => p.PostId > cursor);
}

var posts = await query.Take(pageSize).ToListAsync();
```

Das übersetzt sich zu:

```sql
SELECT TOP(20) [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
WHERE [p].[PostId] > 580
ORDER BY [p].[PostId];
```

Mit einem Index auf `PostId` (der gruppierte Primärschlüssel ist bereits einer) springt die Datenbank direkt zur ersten Zeile größer als 580 und liest 20 Zeilen. Es gibt kein Scannen-und-Verwerfen. Seite 1 und Seite 10.000 kosten dasselbe. Und weil der Cursor ein Wert ist, keine Position, kann ein Einfügen oder Löschen an anderer Stelle in der Tabelle Ihr Fenster nicht verschieben: Sie fahren immer von genau der Zeile fort, die Sie zuletzt gesehen haben.

Der Haken steckt im Namen: Keyset-Pagination braucht einen *Schlüssel*. Die Spalte (oder Spalten), nach der Sie sortieren, muss eine strikte, totale Ordnung über die Zeilen erzeugen. Wenn zwei Zeilen beim Sortierschlüssel gleichstehen können, kann der `>`-Vergleich der Datenbank nicht mitteilen, auf welcher Seite der Grenze eine gleichstehende Zeile liegt, und Sie überspringen oder wiederholen stillschweigend Zeilen. `PostId` ist eindeutig, also funktioniert es allein. Ein `CreatedAt`-Zeitstempel ist fast nie eindeutig, also funktioniert er nicht, und dort liegen die meisten echten Abfragen.

## Sortierung nach einer nicht eindeutigen Spalte: einen Tiebreaker hinzufügen

Der realistische Fall ist "neueste zuerst", sortiert nach einem `CreatedAt`, das bis auf die Millisekunde kollidieren kann. Die Lösung, die die Dokumentation in einer Warnung oben auf der [Pagination-Seite](https://learn.microsoft.com/en-us/ef/core/querying/pagination) hervorhebt, ist, die Sortierung vollständig eindeutig zu machen, indem man eine eindeutige Spalte anhängt, fast immer den Primärschlüssel:

```csharp
// .NET 11, EF Core 11.0.0 - keyset over (CreatedAt DESC, PostId DESC)
var pageSize = 20;

// Cursor carried from the last row of the previous page (null on page 1).
DateTime? lastCreatedAt = previousCursor?.CreatedAt;
int? lastPostId = previousCursor?.PostId;

var query = context.Posts
    .OrderByDescending(p => p.CreatedAt)
    .ThenByDescending(p => p.PostId)
    .AsQueryable();

if (lastCreatedAt is DateTime ca && lastPostId is int id)
{
    // Rows that sort strictly after the cursor in (CreatedAt DESC, PostId DESC).
    query = query.Where(p =>
        p.CreatedAt < ca || (p.CreatedAt == ca && p.PostId < id));
}

var posts = await query.Take(pageSize).ToListAsync();
```

Die `WHERE`-Klausel ist der ganze Trick, also lesen Sie sie sorgfältig. Sie sortieren absteigend, also bedeutet "nach dem Cursor" kleiner. Eine Zeile gehört auf die nächste Seite, wenn ihr `CreatedAt` strikt älter ist als das des Cursors (`p.CreatedAt < ca`), oder wenn ihr `CreatedAt` exakt gleichsteht und ihr `PostId` den Gleichstand in dieselbe Richtung auflöst (`p.CreatedAt == ca && p.PostId < id`). Diesen `==`-Zweig lassen die Leute weg, und ihn wegzulassen ist genau die Art, wie Zeilen, die sich einen Zeitstempel teilen, an Seitengrenzen übersprungen werden. Die Vergleichsrichtung im `WHERE` muss die Richtung des `OrderBy` exakt spiegeln: aufsteigende Reihenfolge verwendet `>`, absteigende verwendet `<`. Verwechseln Sie sie, und Ihre Seiten überlappen sich entweder oder lassen Lücken.

Das generierte SQL ist ein einzelner Seek:

```sql
SELECT TOP(20) [p].[PostId], [p].[Title], [p].[CreatedAt]
FROM [Posts] AS [p]
WHERE [p].[CreatedAt] < @ca OR ([p].[CreatedAt] = @ca AND [p].[PostId] < @id)
ORDER BY [p].[CreatedAt] DESC, [p].[PostId] DESC;
```

## Den Ablauf von Anfang bis Ende verdrahten

Hier ist die vollständige Schleife: den Cursor kodieren, ihn mit der Seite zurückgeben, ihn bei der nächsten Anfrage dekodieren. Die Schritte sind dieselben, ob der Cursor in einem Query-String oder einem API-Antwort-Body mitreist.

1. **Wählen Sie eine vollständig eindeutige Sortierung.** Eine aussagekräftige Sortierspalte plus den Primärschlüssel als letzten Tiebreaker. Die Reihenfolge der Spalten hier ist die Reihenfolge, der alles andere folgen muss.
2. **Definieren Sie einen Index, der zur Sortierung exakt passt.** Ein zusammengesetzter Index über `(CreatedAt DESC, PostId DESC)` lässt den Seek die Zeilen bereits in Reihenfolge lesen. Ohne ihn sortiert die Datenbank bei jeder Seite die ganze Tabelle und der Vorteil verdunstet.
3. **Bauen Sie das `WHERE` aus den Werten der letzten Zeile.** Ein `OR`-Zweig pro Sortierspalte, mit der Vergleichsrichtung passend zur Sortierrichtung jeder Spalte.
4. **Nehmen Sie `pageSize` Zeilen.** Optional `pageSize + 1`, damit Sie ohne eine zweite Abfrage feststellen können, ob eine nächste Seite existiert.
5. **Geben Sie einen Cursor aus der letzten zurückgegebenen Zeile aus** und reichen Sie ihn an den Aufrufer zurück, damit er ihn mit der nächsten Anfrage sendet.

Ein minimaler Endpunkt, der eine Seite plus einen opaken Cursor zurückgibt:

```csharp
// .NET 11, EF Core 11.0.0, C# 14 - minimal API keyset endpoint
app.MapGet("/posts", async (string? cursor, AppDbContext db) =>
{
    const int pageSize = 20;

    var query = db.Posts
        .AsNoTracking()
        .OrderByDescending(p => p.CreatedAt)
        .ThenByDescending(p => p.PostId)
        .AsQueryable();

    if (Cursor.TryDecode(cursor, out var ca, out var id))
    {
        query = query.Where(p =>
            p.CreatedAt < ca || (p.CreatedAt == ca && p.PostId < id));
    }

    // Fetch one extra row to detect whether a further page exists.
    var rows = await query.Take(pageSize + 1).ToListAsync();

    var hasMore = rows.Count > pageSize;
    var page = rows.Take(pageSize).ToList();

    var next = hasMore && page.Count > 0
        ? Cursor.Encode(page[^1].CreatedAt, page[^1].PostId)
        : null;

    return Results.Ok(new { items = page, nextCursor = next });
});
```

Der `Cursor`-Helper packt einfach die beiden Werte in ein URL-sicheres Token, damit Aufrufer es als opak behandeln und nicht an der Paging-Semantik manipulieren können:

```csharp
// .NET 11, C# 14 - opaque cursor encode/decode
static class Cursor
{
    public static string Encode(DateTime createdAt, int id) =>
        Convert.ToBase64String(
            Encoding.UTF8.GetBytes($"{createdAt.Ticks}:{id}"));

    public static bool TryDecode(string? token, out DateTime createdAt, out int id)
    {
        createdAt = default;
        id = default;
        if (string.IsNullOrEmpty(token)) return false;

        var parts = Encoding.UTF8
            .GetString(Convert.FromBase64String(token))
            .Split(':');
        if (parts.Length != 2) return false;

        createdAt = new DateTime(long.Parse(parts[0]), DateTimeKind.Utc);
        id = int.Parse(parts[1]);
        return true;
    }
}
```

Beachten Sie das `AsNoTracking()` auf der Abfrage. Das sind schreibgeschützte Listenzeilen, also gibt es keinen Grund, für den Change Tracker zu zahlen; wenn Sie unsicher sind, wann das eine Rolle spielt, siehe [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/). Für einen stark genutzten Listen-Endpunkt ist diese Abfrage außerdem ein starker Kandidat für eine [Compiled Query](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/), da sich die Form zwischen Anfragen nie ändert.

## Der Index ist nicht optional

Keyset-Pagination ist nur dann schnell, wenn die Datenbank einen Seek durchführen kann. Das erfordert einen Index, dessen Schlüsselspalten und -richtungen genau zu Ihrem `OrderBy` passen:

```csharp
// .NET 11, EF Core 11.0.0 - composite index matching the page order
modelBuilder.Entity<Post>()
    .HasIndex(p => new { p.CreatedAt, p.PostId })
    .IsDescending(true, true);
```

Die offizielle Anleitung ist dazu im [Abschnitt über Indizes](https://learn.microsoft.com/en-us/ef/core/querying/pagination) unmissverständlich: Ihr Index muss zu Ihrer Pagination-Sortierung passen. Wenn Sie nach `(CreatedAt DESC, PostId DESC)` sortieren, aber `(CreatedAt ASC, PostId ASC)` indizieren, können viele Datenbanken den Index immer noch rückwärts scannen, aber sobald Sie eine dritte Spalte oder eine abweichende Richtung hinzufügen, fällt der Planner auf eine Sortierung über die gesamte gefilterte Menge zurück und Ihre Seite mit konstanten Kosten ist dahin. Die Indexrichtung ist Teil des Vertrags, kein Detail. Das ist dieselbe Klasse von "der Abfrageplan tut etwas, worum Sie nicht gebeten haben"-Problem wie eine versehentliche [N+1-Abfrage](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/): Das LINQ sieht in Ordnung aus, aber der Plan erzählt die wahre Geschichte, also prüfen Sie den tatsächlichen Ausführungsplan einmal, bevor Sie ausliefern.

## Warum nicht die Tuple-Syntax, die Sie aus rohem SQL kennen

Wenn Sie Keyset-Pagination in handgeschriebenem SQL geschrieben haben, haben Sie wahrscheinlich Row-Value-Vergleiche verwendet: `WHERE (CreatedAt, PostId) < (@ca, @id)`. Das ist die sauberere Art, dieselbe Grenze auszudrücken, die meisten relationalen Datenbanken unterstützen es, und es neigt dazu, einen besseren Plan zu erzeugen als die ausgerollte `OR`-Kette. Die schlechte Nachricht für EF Core 11: Sie können es in LINQ immer noch nicht schreiben. Die Dokumentation merkt das ausdrücklich an, und es wird unter [dotnet/efcore#26822](https://github.com/dotnet/efcore/issues/26822) verfolgt, das mit Stand EF Core 11.0.0 weiterhin offen ist. Die manuelle `OR`-Erweiterung oben ist also keine Notlösung, die Sie in der nächsten Version wegwerfen werden; sie ist der aktuell unterstützte Ansatz.

Wenn Sie nach drei oder mehr Spalten sortieren, wächst die `OR`-Kette schnell und wird fehleranfällig. Das Muster verallgemeinert sich mechanisch: Für die Sortierschlüssel `a, b, c` lautet das Prädikat `a > a0 || (a == a0 && b > b0) || (a == a0 && b == b0 && c > c0)`. Sobald Sie mehr als zwei Schlüssel haben, greifen Sie zu einem gepflegten Helper wie `MR.EntityFrameworkCore.KeysetPagination`, der diesen Ausdrucksbaum aus derselben `OrderBy`-Definition für Sie baut und das `WHERE` mit der Sortierung synchron hält. Vierstufige `OR`-Ketten von Hand zu schreiben ist die Art, wie der `==`-Zweig verloren geht.

## Rückwärts paginieren und andere Randfälle

Ein paar Dinge erwischen Leute, sobald der Happy Path funktioniert:

- **Vorherige Seite.** Um rückwärts zu paginieren, drehen Sie jeden Vergleich und jede `OrderBy`-Richtung um, nehmen eine Seite und kehren die Liste dann im Speicher um, bevor Sie sie zurückgeben. Sie können die Vorwärtsabfrage nicht mit einem "before"-Cursor und derselben Sortierung wiederverwenden; die Zeilen kämen in der falschen Reihenfolge zurück.
- **Der Nutzer hat keinen wahlfreien Zugriff.** Keyset-Pagination unterstützt nächste und vorherige, nicht "springe zu Seite 47". Das ist inhärent, kein Fehler. Wenn Sie wirklich Sprünge zu Seitennummern brauchen, schlägt die Dokumentation einen Hybrid vor: Keyset für nächste/vorherige, Offset nur für den seltenen wahlfreien Sprung. Die meisten Feeds und Infinite Scrolls brauchen den Sprung überhaupt nie.
- **Gesamtzahl.** Keyset gibt Ihnen Zeilen, keine Zählung verbleibender Seiten. Wenn die UI "Seite 3 von 200" braucht, ist diese Zählung eine separate `COUNT(*)`-Abfrage, und auf einer großen Tabelle ist sie oft der teure Teil, also cachen Sie sie oder lassen Sie die Anforderung fallen.
- **Nullbare Sortierspalten.** Wenn Ihre Sortierspalte nullbar ist, verhalten sich `NULL`-Vergleiche nicht wie `>`/`<`, und Zeilen mit `NULL` können aus der Pagination verschwinden. Sortieren Sie entweder nach nicht-nullbaren Spalten oder fügen Sie einen expliziten `NULL`-Sortierzweig hinzu.
- **Cursor-Stabilität.** Der Cursor kodiert Werte, also bleibt er gültig, selbst wenn um ihn herum Zeilen eingefügt oder gelöscht werden, was der ganze Sinn ist. Er bricht, wenn die *Zeile, auf die er zeigt*, gelöscht wird und Sie sich darauf verlassen, diese Zeile zurückzulesen; da Sie nur gegen ihre Werte vergleichen, ist das in Ordnung, aber gehen Sie nicht davon aus, dass die Cursor-Zeile noch existiert.

Offset-Pagination ist nicht immer falsch. Für eine kleine Admin-Tabelle oder jedes Grid, in dem Nutzer wirklich Seitennummern anklicken, ist `Skip`/`Take` einfacher und der Leistungsunterschied unsichtbar. In dem Moment, in dem die Tabelle groß, anhänglastig oder tief gescrollt ist, ist Keyset die Variante, die schnell und korrekt bleibt. Sortieren Sie nach einem eindeutigen Schlüssel, bauen Sie das `WHERE` so, dass es exakt dazu passt, indizieren Sie diese Spalten in derselben Richtung, und Ihre tiefste Seite kostet dasselbe wie Ihre erste.

## Verwandt

- [How to use query splitting to avoid a cartesian explosion in EF Core 11](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)
- [AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11](/2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11/)
- [How to detect N+1 queries in EF Core 11](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [How to use compiled queries with EF Core for hot paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [How to use IAsyncEnumerable with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)

## Quellen

- [Pagination - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/pagination)
- [Indexes - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/modeling/indexes)
- [Support row value comparisons for keyset pagination - dotnet/efcore#26822](https://github.com/dotnet/efcore/issues/26822)
- [MR.EntityFrameworkCore.KeysetPagination (GitHub)](https://github.com/mrahhal/MR.EntityFrameworkCore.KeysetPagination)
