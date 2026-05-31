---
title: "ExecuteUpdate und ExecuteDelete für Massenschreibvorgänge in EF Core 11 verwenden"
description: "Ein vollständiger Leitfaden zu ExecuteUpdate und ExecuteDelete in EF Core 11: das erzeugte SQL, die Falle des Change Trackers, die Ihren Massenschreibvorgang stillschweigend überschreibt, Transaktionen, Concurrency-Kontrolle über die Anzahl betroffener Zeilen und die Delegate-Setter aus EF Core 10, mit denen sich bedingte Updates über einfache if-Anweisungen erstellen lassen."
pubDate: 2026-05-31
template: how-to
tags:
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
  - "how-to"
lang: "de"
translationOf: "2026/05/how-to-use-executeupdate-and-executedelete-for-bulk-writes-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-05-31
---

Kurze Antwort: Um viele Zeilen in einer einzigen SQL-Anweisung zu aktualisieren oder zu löschen, schreiben Sie ein LINQ-`Where`, um die Zeilen auszuwählen, und rufen dann `ExecuteUpdateAsync` oder `ExecuteDeleteAsync` auf der resultierenden Abfrage auf. EF Core 11 übersetzt das Ganze in ein einziges `UPDATE` oder `DELETE`, das in der Datenbank läuft, ohne geladene Entitäten, ohne Change Tracker und ohne `SaveChanges`. Beide Methoden werden sofort ausgeführt und geben die Anzahl der betroffenen Zeilen zurück. Die eine Falle, in die jeder tappt: Da diese Methoden den Change Tracker nie berühren, behält jede bereits geladene Entität ihren veralteten Wert, und ein späteres `SaveChanges` überschreibt Ihren Massenschreibvorgang bereitwillig.

Dieser Beitrag behandelt `ExecuteUpdate` und `ExecuteDelete` in `Microsoft.EntityFrameworkCore` 11.0.0 auf .NET 11 gegen SQL Server 2025: das exakt erzeugte SQL, Updates mehrerer Eigenschaften, das Referenzieren des bestehenden Spaltenwerts, die Change-Tracking-Falle und wie man ihr ausweicht, die Transaktionssemantik, das Implementieren eigener optimistischer Concurrency über die Anzahl betroffener Zeilen, die bedingten Delegate-Setter aus EF Core 10 und die Einschränkungen, die Sie zu `SaveChanges` zurückschicken. Die relationalen APIs sind auf PostgreSQL und SQLite identisch; nur der erzeugte SQL-Dialekt unterscheidet sich.

## Warum die SaveChanges-Schleife das falsche Werkzeug für Massenschreibvorgänge ist

Der naive Weg, jeden schlecht bewerteten Blog per Soft Delete zu entfernen, wirkt vernünftig, bis Sie das SQL betrachten:

```csharp
// .NET 11, EF Core 11.0.0 - the slow way
await foreach (var blog in context.Blogs.Where(b => b.Rating < 3).AsAsyncEnumerable())
{
    context.Blogs.Remove(blog);
}

await context.SaveChangesAsync();
```

Dies fragt jede passende Zeile über die Leitung ab, materialisiert jede zu einer nachverfolgten Entität, markiert sie im Change Tracker als `Deleted` und gibt dann bei `SaveChanges` ein `DELETE` pro Zeile aus. Wenn 50.000 Blogs passen, ist das ein großes `SELECT`, 50.000 Allokationen und 50.000 `DELETE`-Anweisungen (gebündelt, aber dennoch einzeln parametrisiert). Die Datenbank leistet enorme Arbeit für eine Operation, die konzeptionell eine einzige mengenbasierte Anweisung ist.

`ExecuteDelete` reduziert all das auf einen einzigen Roundtrip:

```csharp
// .NET 11, EF Core 11.0.0
int deleted = await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteDeleteAsync();
```

EF Core 11 übersetzt das LINQ-Prädikat genau so in SQL, wie es das für eine Abfrage tun würde, gibt aber ein `DELETE` statt eines `SELECT` aus:

```sql
DELETE FROM [b]
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Es wird nichts geladen, nichts nachverfolgt, und `deleted` enthält die Zeilenanzahl. Sie können beliebiges übersetzbares LINQ in das `Where` packen, einschließlich Joins und Unterabfragen, genau wie beim Auswählen der Zeilen.

## In-place aktualisieren mit ExecuteUpdate

`ExecuteUpdate` ist das `UPDATE`-Pendant. Statt die schlecht bewerteten Blogs zu löschen, blenden Sie sie aus:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.IsVisible, false));
```

Das `Where` wählt die Zeilen aus; der `SetProperty`-Aufruf gibt an, welche Spalte sich ändert und auf welchen Wert. EF Core 11 gibt aus:

```sql
UPDATE [b]
SET [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Um mehrere Spalten auf einmal zu ändern, verketten Sie `SetProperty`-Aufrufe. Sie landen alle in einer einzigen Anweisung:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.IsVisible, false)
        .SetProperty(b => b.Rating, 0));
```

```sql
UPDATE [b]
SET [b].[Rating] = 0,
    [b].[IsVisible] = CAST(0 AS bit)
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

### Den neuen Wert aus dem alten berechnen

Das zweite Argument von `SetProperty` muss keine Konstante sein. Übergeben Sie ein Lambda, und Sie erhalten die aktuelle Zeile, sodass Sie den neuen Wert aus den bestehenden Spalten berechnen können. Um jede passende Bewertung um eins zu erhöhen:

```csharp
// .NET 11, EF Core 11.0.0
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(setters =>
        setters.SetProperty(b => b.Rating, b => b.Rating + 1));
```

Innerhalb dieses Lambdas ist `b.Rating` der Spaltenwert vor dem Update, und EF Core übersetzt den gesamten Ausdruck in SQL, sodass die Arithmetik in der Datenbank stattfindet, atomar, ohne Read-Modify-Write-Race-Condition:

```sql
UPDATE [b]
SET [b].[Rating] = [b].[Rating] + 1
FROM [Blogs] AS [b]
WHERE [b].[Rating] < 3
```

Das ist das Muster, das Sie für Zähler, Salden und Versionsstempel wollen. Es über `SaveChanges` zu tun bedeutet, die Zeile zu laden, im Speicher zu mutieren und zu speichern, was ein Fenster öffnet, in dem eine andere Transaktion dieselbe Zeile zwischen Ihrem Lesen und Ihrem Schreiben ändern kann. Das mengenbasierte `UPDATE` hat kein solches Fenster.

## Die Change-Tracker-Falle, die Ihren Schreibvorgang stillschweigend frisst

Hier ist das Wichtigste, das Sie zu beiden Methoden verinnerlichen sollten: Sie werden sofort wirksam und haben keinerlei Interaktion mit dem Change Tracker von EF. Das ist die Quelle ihrer Geschwindigkeit und zugleich die Quelle des einen Fehlers, den jeder mindestens einmal macht.

Gehen Sie diese Abfolge sorgfältig durch:

```csharp
// .NET 11, EF Core 11.0.0
// 1. Tracking query: this Blog is now tracked, Rating == 5 in memory.
var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");

// 2. Bump every blog's rating by one in the database. Runs now.
await context.Blogs
    .ExecuteUpdateAsync(setters => setters.SetProperty(b => b.Rating, b => b.Rating + 1));

// 3. Mutate the tracked instance in memory.
blog.Rating += 2;

// 4. Persist tracked changes.
await context.SaveChangesAsync();
```

Nach Schritt 2 liest die Datenbankzeile `6`. Aber die nachverfolgte Instanz glaubt weiterhin, der ursprüngliche Wert sei `5`, weil `ExecuteUpdate` dem Change Tracker nie etwas mitgeteilt hat. Schritt 3 setzt den In-Memory-Wert auf `7`. Wenn `SaveChanges` in Schritt 4 läuft, vergleicht EF den aktuellen Wert `7` mit dem *ursprünglichen*, den es in Schritt 1 erfasst hat (`5`), entscheidet, dass sich die Eigenschaft geändert hat, und schreibt `7`. Ihr Massen-`+1` ist weg, überschrieben von einem `SaveChanges`, das nichts davon wusste.

Die offizielle Empfehlung aus der [EF-Core-Dokumentation zu ExecuteUpdate und ExecuteDelete](https://learn.microsoft.com/en-us/ef/core/saving/execute-insert-update-delete) ist unmissverständlich: Vermeiden Sie es, nachverfolgte `SaveChanges`-Änderungen und nicht nachverfolgte Änderungen über `ExecuteUpdate`/`ExecuteDelete` an denselben Entitäten in derselben Arbeitseinheit zu mischen. In der Praxis gibt es zwei saubere Wege, Ärger zu vermeiden:

1. Führen Sie den Massenschreibvorgang gegen einen Kontext aus, dessen Abfrage dieser Zeilen `AsNoTracking()` verwendet hat, sodass nichts Nachverfolgtes veralten kann.
2. Wenn Sie Entitäten lesen müssen, führen Sie den Massenschreibvorgang aus und rufen dann `context.ChangeTracker.Clear()` auf, bevor Sie erneut abfragen, sodass das nächste Lesen aus der Datenbank mit frischen Werten neu befüllt wird.

```csharp
// .NET 11, EF Core 11.0.0 - re-read fresh after a bulk write
await context.Blogs
    .Where(b => b.Rating < 3)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.IsVisible, false));

context.ChangeTracker.Clear();

var hidden = await context.Blogs
    .AsNoTracking()
    .Where(b => !b.IsVisible)
    .ToListAsync();
```

Das sauberste mentale Modell: Behandeln Sie `ExecuteUpdate`/`ExecuteDelete`, als gehörten sie zu einer eigenständigen, tieferliegenden Datenzugriffsschicht, die zufällig Ihren `DbContext` teilt. Sie sprechen SQL, nicht Entitäten. Es ist dieselbe Grenze, die Sie respektieren, wenn Sie [einen DbContext mocken, ohne das Change Tracking zu zerstören](/de/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/): Der Change Tracker ist ein zustandsbehaftetes In-Memory-Objekt, und Schreibvorgänge über einen Seitenkanal aktualisieren ihn nicht.

## Transaktionen: nichts ist implizit

Keine der beiden Methoden öffnet eine Transaktion für Sie. Jeder Aufruf ist sein eigener Roundtrip und, sofern Sie ihn nicht umschließen, seine eigene implizite Transaktion. Diese Abfolge sind vier separate Transaktionen:

```csharp
// .NET 11, EF Core 11.0.0 - four independent transactions, NOT atomic
await context.Blogs.ExecuteUpdateAsync(/* update A */);
await context.Blogs.ExecuteUpdateAsync(/* update B */);

var blog = await context.Blogs.SingleAsync(b => b.Name == "SomeBlog");
blog.Rating += 2;
await context.SaveChangesAsync();
```

Wenn Update B eine Ausnahme wirft, ist Update A bereits committet. Es gibt kein Rollback, weil es nie eine gemeinsame Transaktion gab. Wenn zwei oder mehr Massenschreibvorgänge gemeinsam erfolgreich sein oder gemeinsam fehlschlagen müssen, starten Sie eine explizite Transaktion über die [DatabaseFacade](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.infrastructure.databasefacade):

```csharp
// .NET 11, EF Core 11.0.0 - one atomic unit
await using var tx = await context.Database.BeginTransactionAsync();

await context.Blogs
    .Where(b => b.Rating < 0)
    .ExecuteUpdateAsync(s => s.SetProperty(b => b.Rating, 0));

await context.Posts
    .Where(p => p.IsOrphaned)
    .ExecuteDeleteAsync();

await tx.CommitAsync();
```

Nun teilen sich beide Anweisungen eine Transaktion und führen bei einem Fehler gemeinsam ein Rollback durch. Wenn eine davon gegen eine langsame Tabelle läuft und Sie auf eine [SqlException: Timeout expired](/de/2026/05/fix-sqlexception-timeout-expired-during-ef-core-migrations/) stoßen, ist die explizite Transaktion auch der Ort, an dem Sie einen längeren Befehls-Timeout für den Batch setzen würden.

## Eigene Concurrency-Kontrolle über die Zeilenanzahl

`SaveChanges` bietet Ihnen optimistische Concurrency kostenlos über Concurrency-Token: Es fügt das Token der `WHERE`-Klausel hinzu und wirft `DbUpdateConcurrencyException`, wenn keine Zeile passt. `ExecuteUpdate` und `ExecuteDelete` berühren den Change Tracker nicht, können das also nicht automatisch tun. Stattdessen liefern sie Ihnen das Rohmaterial: die Anzahl der betroffenen Zeilen.

Packen Sie das Concurrency-Token in Ihr eigenes `Where` und prüfen Sie den Rückgabewert:

```csharp
// .NET 11, EF Core 11.0.0 - hand-rolled optimistic concurrency
int updated = await context.Blogs
    .Where(b => b.Id == id && b.Version == expectedVersion)
    .ExecuteUpdateAsync(setters => setters
        .SetProperty(b => b.Title, newTitle)
        .SetProperty(b => b.Version, b => b.Version + 1));

if (updated == 0)
{
    // Either the row is gone or someone else bumped Version first.
    throw new DbUpdateConcurrencyException("Blog was modified concurrently.");
}
```

Da die `Version`-Prüfung Teil des SQL-`WHERE` ist, sind Vergleich und Schreibvorgang eine einzige atomare Anweisung. Keine Zeile passt, wenn eine andere Transaktion `Version` bereits erhöht hat, `updated` kommt als `0` zurück, und Sie reagieren. Dies ist häufig *schneller* als der nachverfolgte Pfad bei Einzelzeilen-Updates auf stark frequentierten Endpunkten und lässt sich gut mit den Lese-Mustern aus [kompilierten Abfragen für Hot Paths](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/) kombinieren.

## Bedingte Setter ohne Expression Trees (EF Core 10 und neuer)

Vor EF Core 10 war das Setter-Argument ein Expression Tree, was dynamische Updates mühsam machte: Sie konnten keine `if`-Anweisung mitten in eine fluente Kette setzen, also bedeuteten bedingte Updates entweder, den gesamten Aufruf zu verzweigen, oder Expression Trees von Hand zu bauen. Ab EF Core 10, übernommen in EF Core 11, gibt es eine Überladung, deren Setter-Argument ein gewöhnliches Delegate mit Anweisungsrumpf ist. Sie können den normalen C#-Kontrollfluss verwenden:

```csharp
// .NET 11, EF Core 11.0.0 - conditional setters with normal control flow
await context.Blogs
    .Where(b => b.Id == id)
    .ExecuteUpdateAsync(setters =>
    {
        setters.SetProperty(b => b.Title, newTitle);

        if (rankChanged)
        {
            setters.SetProperty(b => b.Rating, newRating);
        }

        foreach (var (column, value) in extraFlags)
        {
            // build setters in a loop, one per flag that actually changed
            setters.SetProperty(column, value);
        }
    });
```

Der Delegate-Rumpf läuft einmal, in C#, um die Liste der zu setzenden Spalten aufzubauen; EF Core 11 übersetzt das dann in ein einziges `UPDATE`. Das ist die idiomatische Art, einen PATCH-Endpunkt zu implementieren, bei dem der Client nur die Felder sendet, die er ändern möchte. Sie bauen genau die Setter, die Sie brauchen, und geben eine einzige Anweisung aus, statt entweder alle Spalten zu aktualisieren oder auf Laden-Mutieren-Speichern zurückzufallen. Die ältere ausdrucksbasierte Überladung existiert weiterhin und ist für den statischen Fall mit immer denselben Spalten geeignet.

## Verwandte Entitäten referenzieren, und die Grenzen

`ExecuteUpdate` kann eine Navigation nicht direkt innerhalb von `SetProperty` referenzieren. Dies wird nicht übersetzt:

```csharp
// .NET 11, EF Core 11.0.0 - does NOT work
await context.Blogs.ExecuteUpdateAsync(
    setters => setters.SetProperty(b => b.Rating, b => b.Posts.Average(p => p.Rating)));
```

Die Umgehung besteht darin, mit `Select` in eine anonyme Projektion zu projizieren, die den Wert zuerst berechnet, und dann `ExecuteUpdate` über diese Projektion aufzurufen:

```csharp
// .NET 11, EF Core 11.0.0 - set each Blog's rating to the average of its Posts
await context.Blogs
    .Select(b => new { Blog = b, NewRating = b.Posts.Average(p => p.Rating) })
    .ExecuteUpdateAsync(setters => setters.SetProperty(x => x.Blog.Rating, x => x.NewRating));
```

EF Core 11 wandelt den Durchschnitt in eine korrelierte Unterabfrage im `UPDATE` um:

```sql
UPDATE [b]
SET [b].[Rating] = CAST((
    SELECT AVG(CAST([p].[Rating] AS float))
    FROM [Post] AS [p]
    WHERE [b].[Id] = [p].[BlogId]) AS int)
FROM [Blogs] AS [b]
```

Über Navigationen hinaus sollten Sie diese Einschränkungen im Blick behalten:

- **Nur Aktualisieren und Löschen.** Es gibt kein `ExecuteInsert`. Einfügungen laufen weiterhin über `Add` plus `SaveChanges`.
- **Keine Rückgabe der alten Werte.** SQL kann die berührten Zeilen zurückgeben, aber EF Core 11 stellt das nicht bereit; Sie erhalten nur die Anzahl.
- **Kein Bündeln über Aufrufe hinweg.** Zwei `ExecuteUpdate`-Aufrufe sind zwei Roundtrips. Es gibt kein Pendant zum Akkumulieren von Änderungen und einmaligem Flushen.
- **Eine Tabelle pro Anweisung.** Wie bei rohem SQL-`UPDATE`/`DELETE` zielt ein einzelner Aufruf auf eine einzelne Tabelle. Eine Aktualisierung über eine TPT-Vererbungshierarchie, die sich über mehrere Tabellen erstreckt, lässt sich nicht in einem einzigen Aufruf ausdrücken.
- **Nur relationale Provider.** Es sind Erweiterungsmethoden auf dem relationalen Abfrageprovider; der In-Memory-Provider hat sie nicht.

Die erste verdient besondere Aufmerksamkeit: Wenn Ihr Hot Path aus *Einfügungen* mit hohem Volumen besteht, hilft keine der beiden Methoden. Das ist ein anderes Problem mit eigener Antwort, gemessen in [EF Core 11 vs Dapper für Bulk-Inserts](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/).

## Wann Sie was wählen sollten

Die Entscheidung hängt überwiegend davon ab, ob Sie die Entitäten brauchen. Wenn Sie Zeilen anhand eines Prädikats löschen oder aktualisieren und die betroffenen Objekte danach nicht im Speicher benötigen, ist `ExecuteDelete`/`ExecuteUpdate` fast immer die richtige Wahl: eine Anweisung, keine Materialisierung, kein Tracking-Overhead. Es ist derselbe Instinkt, der Sie eine [N+1-Abfrage in EF Core 11](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) aufspüren und beseitigen lässt, nämlich die Weigerung, Roundtrips pro Zeile zu machen, wenn die Datenbank die gesamte Arbeit in einer einzigen mengenbasierten Operation erledigen kann.

Greifen Sie zu `SaveChanges` zurück, wenn Sie den Change Tracker wirklich brauchen: komplexe Objektgraphen, Kaskadenverhalten, das von nachverfolgtem Zustand abhängt, automatische Concurrency-Token oder Interceptoren und Domain Events, die an `SaveChanges` angebunden sind. Und wann immer Sie beides mischen, denken Sie an die Grenze. Die Massenmethoden schreiben direkt SQL und lassen Ihre nachverfolgten Entitäten in der Vergangenheit eingefroren. Leeren Sie den Tracker oder fragen Sie nach einem Massenschreibvorgang mit `AsNoTracking()` ab, umschließen Sie Arbeit mit mehreren Anweisungen in einer expliziten Transaktion, und prüfen Sie die zurückgegebene Zeilenanzahl, wenn die Korrektheit davon abhängt, wie viele Zeilen sich tatsächlich geändert haben.
