---
title: "AsNoTracking vs AsNoTrackingWithIdentityResolution in EF Core 11: welche sollten Sie verwenden?"
description: "Verwenden Sie AsNoTracking standardmäßig für schreibgeschützte Abfragen. Greifen Sie nur dann zu AsNoTrackingWithIdentityResolution, wenn der Ergebnisgraph dieselbe Entität mehrfach enthält und Ihr Code darauf angewiesen ist, eine einzige gemeinsam genutzte Instanz zu erhalten."
pubDate: 2026-06-15
template: vs
tags:
  - "comparison"
  - "ef-core"
  - "ef-core-11"
  - "csharp"
  - "dotnet-11"
  - "performance"
lang: "de"
translationOf: "2026/06/asnotracking-vs-asnotrackingwithidentityresolution-in-ef-core-11"
translatedBy: "claude"
translationDate: 2026-06-15
---

Kurze Antwort: Verwenden Sie `AsNoTracking()` standardmäßig für jede schreibgeschützte Abfrage. Es überspringt den Change Tracker vollständig, was der günstigste und schnellste Weg ist, Zeilen zu laden, die Sie nicht ändern werden. Wechseln Sie nur dann zu `AsNoTrackingWithIdentityResolution()`, wenn die Ergebnismenge dieselbe Entität mehrfach enthält -- typischerweise, weil ein `Include` über eine Sammlungs-Navigation denselben Elternteil über viele Kindzeilen verteilt -- und Ihr Code darauf angewiesen ist, pro Primärschlüssel eine einzige gemeinsam genutzte Instanz statt jeweils einer neuen Kopie zu erhalten. Identity Resolution kostet etwas mehr (ein wegwerfbarer Change Tracker wird für die Dauer der Abfrage aufgebaut), ist aber immer noch weit günstiger als vollständiges Tracking. Wenn Ihre Abfrage jede Entität genau einmal zurückgibt, verhalten sich die beiden identisch und Sie sollten `AsNoTracking` wählen.

Dieser Beitrag vergleicht die beiden auf `Microsoft.EntityFrameworkCore` 11.0.0 unter .NET 11 gegen SQL Server 2025, mit C# 14. Beide Methoden schalten das Change Tracking ab; das Einzige, was sie unterscheidet, ist, ob EF Core die Entitätsinstanzen innerhalb des Ergebnisses pro Schlüssel dedupliziert. Die richtige Wahl läuft darauf hinaus, eine Frage ehrlich zu beantworten: Kommt dieselbe Zeile mehr als einmal zurück, und ist das für irgendetwas in Ihrem Code relevant?

## Was "Identity Resolution" tatsächlich bedeutet

Eine Tracking-Abfrage führt immer Identity Resolution durch. Wenn EF Core eine Zeile materialisiert, prüft es den Change Tracker des Kontexts anhand des Primärschlüssels; falls bereits eine Instanz für diesen Schlüssel erzeugt wurde, gibt es dasselbe Objekt zurück. Deshalb liefern zwei Tracking-Abfragen für `BlogId == 1` referenzgleiche Objekte, und deshalb ist ein Elternteil, der unter fünfzig Kindern in einem `Include` auftaucht, eine einzige `Blog`-Instanz mit fünfzig `Post`-Kindern, die auf sie verweisen.

`AsNoTracking` wirft diese Maschinerie weg. Es gibt keinen Change Tracker, also keine Identitätszuordnung, also erzeugt jede materialisierte Zeile ein brandneues Objekt, selbst wenn der Schlüssel zuvor schon gesehen wurde:

```csharp
// .NET 11, EF Core 11.0.0 - no tracking, no identity map
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTracking()
    .ToListAsync();

// Two posts on the same blog do NOT share a Blog instance:
bool same = ReferenceEquals(posts[0].Blog, posts[1].Blog); // false, even if BlogId is identical
```

`AsNoTrackingWithIdentityResolution` lässt das Tracking aus, stellt aber die Identitätszuordnung wieder her. EF Core baut nur für diese Abfrage einen eigenständigen Change Tracker auf, nutzt ihn zur Deduplizierung pro Schlüssel, während das Ergebnis einläuft, und lässt ihn aus dem Gültigkeitsbereich fallen und von der Garbage Collection einsammeln, sobald die Enumeration abgeschlossen ist. Der Kontext trackt nie etwas:

```csharp
// .NET 11, EF Core 11.0.0 - no tracking, but identity resolved
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTrackingWithIdentityResolution()
    .ToListAsync();

bool same = ReferenceEquals(posts[0].Blog, posts[1].Blog); // true when BlogId matches
```

Diese API ist nicht neu. Sie kam mit **EF Core 5.0** im November 2020, zusammen mit dem Enum-Wert `QueryTrackingBehavior.NoTrackingWithIdentityResolution`. Mehrere weit geteilte Beiträge schreiben sie EF Core 8 zu, was falsch ist; wenn Sie auf irgendeinem LTS seit EF Core 5 sind, haben Sie sie bereits, und unter EF Core 11 verhält sie sich genau wie unten dokumentiert.

## Funktionsmatrix

| Funktion | AsNoTracking | AsNoTrackingWithIdentityResolution |
| ----------------------------------- | --------------------- | ---------------------------------- |
| Change Tracking im Kontext | nein | nein |
| Durch `SaveChanges` persistiert | nein | nein |
| Identitätszuordnung (gleicher Schlüssel = gleiche Instanz) | nein | ja, abfragebezogen |
| Doppelte Entitäten in einem Ergebnis | jedes Mal neue Instanz | eine gemeinsame Instanz pro Schlüssel |
| Change Tracker im Hintergrund | keiner | einer, wegwerfbar, nach Enumeration durch GC entfernt |
| Aus der Datenbank geladene Zeilen | alle passenden Zeilen | alle passenden Zeilen (gleiches SQL) |
| Relative Abfragekosten | am niedrigsten | leicht über `AsNoTracking` |
| Navigations-Fixup über das Ergebnis | nein | ja (innerhalb der Abfrage) |
| Verfügbar seit | EF Core 1.0 | EF Core 5.0 |
| Als Kontext-Standard | `QueryTrackingBehavior.NoTracking` | `QueryTrackingBehavior.NoTrackingWithIdentityResolution` |

Die gesamte Tabelle reduziert sich auf eine Zeile: Identity Resolution. Alles andere ist gemeinsam. Keine der Methoden schreibt in die Datenbank, keine füllt den Tracker des Kontexts und -- das ist der Teil, den man übersieht -- keine ändert das SQL oder die Anzahl der Zeilen, die der Server zurückgibt. Identity Resolution ist eine rein clientseitige Deduplizierung der Objekte, die EF Core aus diesen Zeilen baut.

## Wann Sie AsNoTracking wählen sollten

- **Einfache schreibgeschützte Listen und DTOs.** Ein Grid, eine API-Antwort, ein Bericht. Sie fragen ab, projizieren oder serialisieren, fertig. Es gibt keinen Grund, für eine Identitätszuordnung zu zahlen, wenn Sie nie Instanzen vergleichen. Das ist der korrekte Standard für die überwältigende Mehrheit der Lesevorgänge und passt natürlich zu [kompilierten Abfragen auf Hot Paths](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/).
- **Abfragen, die jede Entität genau einmal zurückgeben.** Ein flaches `context.Customers.Where(...)` ohne ein verzweigendes `Include` kann kein Duplikat erzeugen, also würde Identity Resolution nichts tun außer Overhead hinzuzufügen. Dasselbe gilt, sobald Sie auf einen anonymen Typ oder ein DTO projizieren, das keine Entitätsinstanzen enthält -- dort führt EF Core gar kein Tracking durch, mit oder ohne den Operator.
- **Große Ergebnisse, die Sie zeilenweise im Streaming verarbeiten.** Wenn Sie mit `IAsyncEnumerable<T>` iterieren und jedes Element nach der Verarbeitung verwerfen, halten Sie nie zwei Instanzen gleichzeitig, also bringt die Deduplizierung nichts und der zusätzliche Change Tracker ist reiner Aufwand.
- **Sie optimieren einen engen Lesepfad.** `AsNoTracking` ist die Untergrenze. Wenn Sie den Kontext-Standard auf `NoTracking` gesetzt haben, um jeden Lesevorgang standardmäßig günstig zu machen, lassen Sie einzelne Abfragen darauf, sofern eine nicht spezifisch Identity Resolution benötigt.

## Wann Sie AsNoTrackingWithIdentityResolution wählen sollten

- **`Include` über eine Sammlungs-Navigation, bei der sich Eltern wiederholen.** Das Laden von Bestellungen mit ihrem Kunden oder von Posts mit ihrem Blog lässt dieselbe Elternzeile einmal pro Kind zurückkommen. Ohne Identity Resolution erhalten Sie pro Kind ein separates `Customer`/`Blog`-Objekt, was sowohl Speicher verschwendet als auch jeden Code bricht, der `order.Customer` durchläuft und ein gemeinsames Objekt erwartet. Das ist der kanonische Fall, für den die Methode existiert.
- **Ihr Code stützt sich auf Referenzgleichheit oder In-Memory-Deduplizierung.** Wenn Sie ein `Dictionary<Blog, ...>` mit Instanz als Schlüssel bauen, nach Referenz gruppieren oder eine zugehörige Entität im Speicher ändern und erwarten, dass jede Referenz die Änderung sieht, wird `AsNoTracking` Sie stillschweigend hintergehen, weil jede "gleiche" Entität ein anderes Objekt ist. Identity Resolution stellt die Garantie einer einzigen Instanz wieder her, die Sie von einer Tracking-Abfrage bekämen, ohne die Tracking-Kosten.
- **Sie haben Tracking global deaktiviert, brauchen aber dennoch einen kohärenten Graphen.** Wenn der Kontext-Standard `NoTracking` ist und ein Lesevorgang einen deduplizierten Objektgraphen benötigt, ist `AsNoTrackingWithIdentityResolution()` das Opt-in pro Abfrage. Sie müssen nicht ganz auf vollständiges Tracking zurückfallen, um einen konsistenten Graphen zu erhalten.
- **Sie sind auf eine kartesische Explosion gestoßen und wollen weniger Objekte im Speicher.** Ein `Include` über mehrere Sammlungen kann die Zeilen drastisch vervielfachen. Die richtige primäre Lösung ist meist [Query Splitting, um die kartesische Explosion zu vermeiden](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/), aber wenn Sie eine einzige Abfrage beibehalten, kollabiert Identity Resolution zumindest die duplizierten Elternobjekte auf jeweils eine Instanz.

## Der Benchmark

Dies ist ein BenchmarkDotNet-Lauf, .NET 11.0.0, `Microsoft.EntityFrameworkCore.SqlServer` 11.0.0, gegen SQL Server 2025 auf demselben Host (Windows 11, 12 Kerne / 32 GB, lokales TCP, warmer Connection Pool). Die Abfrage lädt `Posts` mit `Include(p => p.Blog)` aus einem Seed von 100 Blogs und einer variierenden Anzahl von Posts, sodass die Zeile jedes Blogs über alle seine Posts dupliziert wird. Alle drei Varianten führen identisches SQL aus und geben identische Zeilen zurück; nur die Materialisierungsstrategie unterscheidet sich. Die Zeiten sind der Mittelwert der Messphase von BenchmarkDotNet; weniger ist besser. "Allokiert" ist der pro Operation allokierte verwaltete Speicher.

| Zurückgegebene Posts | Tracking | NoTracking | NoTrackingWithIdentityResolution |
| -------------- | --------- | ---------- | -------------------------------- |
| 1.000 | 6,8 ms | 3,1 ms | 3,5 ms |
| 10.000 | 71 ms | 27 ms | 31 ms |
| 100.000 | 980 ms | 295 ms | 360 ms |

| Zurückgegebene Posts | NoTracking allokiert | WithIdentityResolution allokiert |
| -------------- | -------------------- | -------------------------------- |
| 10.000 | 9,4 MB | 7,1 MB |
| 100.000 | 96 MB | 58 MB |

Zwei Dinge stechen heraus. Erstens schlagen beide No-Tracking-Varianten das vollständige Tracking um etwa das 2-3-Fache in der Zeit, weil das Snapshotting des Change Trackers der dominierende Kostenfaktor ist und sein Überspringen den Großteil des Gewinns ausmacht -- das deckt sich mit Microsofts eigenem [Leitfaden für effiziente Abfragen](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying). Identity Resolution gibt einen kleinen Teil dieses Gewinns zurück, in der Größenordnung von 10-20% langsamer als reines `AsNoTracking`, wegen des wegwerfbaren Change Trackers, den sie während der Abfrage unterhält.

Zweitens, und das ist der kontraintuitive Teil, kann `AsNoTrackingWithIdentityResolution` bei starker Duplizierung im Ergebnis *weniger* allokieren als `AsNoTracking`, weil es ein `Blog`-Objekt pro Schlüssel statt eines pro Post baut. Die Zeitkosten der Deduplizierung werden teilweise durch die Objekte ausgeglichen, die nie gebaut werden. Die Kehrseite: Hat Ihr Ergebnis keine Duplikate, fügt Identity Resolution nur den Tracker-Overhead hinzu, ohne etwas zu kollabieren, sodass reines `AsNoTracking` klar gewinnt. Die Zahlen verschieben sich mit dem Duplizierungsverhältnis, der Zeilenbreite und der Graphform, führen Sie sie also gegen Ihr eigenes Schema erneut aus, bevor Sie eine Zahl zitieren; die relative Reihenfolge ist der verlässliche Teil, nicht die Millisekundenwerte.

## Der Haken, der für Sie entscheidet: der stille Referenzgleichheits-Bug

Die Entscheidung dreht sich nicht immer um Geschwindigkeit; oft geht es um Korrektheit. Die Falle ist die Annahme, dass sich `AsNoTracking` wie eine Tracking-Abfrage verhält, nur weil Sie "wissen", dass zwei Zeilen einen Schlüssel teilen:

```csharp
// .NET 11, EF Core 11.0.0 - the trap
var posts = await context.Posts
    .Include(p => p.Blog)
    .AsNoTracking()
    .ToListAsync();

var blogsByInstance = posts
    .GroupBy(p => p.Blog)             // grouping by reference, not by key!
    .ToList();
// You expected 100 groups (one per blog). You get one group per post,
// because every p.Blog is a distinct object even when BlogId matches.
```

Nichts wirft eine Ausnahme. Die Abfrage gelingt, die Daten sind Zeile für Zeile korrekt, und der Bug zeigt sich erst als falsche Zählungen oder doppelte Arbeit weiter unten. Das gehört zur selben Fehlerfamilie wie die hinter ["the instance of entity type cannot be tracked"](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/): Die Instanzidentität von EF Core ist Buchführung, und wenn Sie die Buchführung abschalten, können Sie sich nicht auf die Objektidentität verlassen. Die Lösung ist, nach `p.Blog.BlogId` (Schlüssel, nicht Referenz) zu gruppieren oder die Abfrage auf `AsNoTrackingWithIdentityResolution()` umzustellen, damit die Referenzen so kollabieren, wie Sie es angenommen haben.

Ein zweiter, leiserer Haken: Identity Resolution ist **abfragebezogen**. Der Tracker im Hintergrund lebt nur für die Dauer der Enumeration dieser einen Abfrage und wird dann von der GC eingesammelt. Zwei separate `AsNoTrackingWithIdentityResolution()`-Abfragen teilen sich keine Identitätszuordnung untereinander, sodass ein `Blog` aus der ersten Abfrage nie referenzgleich zu einem `Blog` aus der zweiten ist. Wenn Sie abfrageübergreifende Identität brauchen, brauchen Sie echtes Tracking. Greifen Sie nicht zu Identity Resolution in der Erwartung kontextweiter Instanzteilung -- das tut sie nicht.

Drittens: `AsNoTrackingWithIdentityResolution` reduziert nicht die Zeilen, die die Datenbank sendet. Manchmal hofft man, dass es eine kartesische Explosion auf der Leitung kuriert. Tut es nicht -- das SQL bleibt unverändert und der Server streamt weiterhin jede duplizierte Zeile; Identity Resolution dedupliziert nur die *Objekte*, die EF Core auf dem Client baut. Um die Zeilen selbst zu reduzieren, teilen Sie die Abfrage auf.

## Die Empfehlung, wiederholt

Machen Sie `AsNoTracking` zu Ihrem Standard für schreibgeschützte Arbeit und überdenken Sie es nicht. Es ist der günstigste Lesevorgang, den EF Core 11 bietet, es ist für die überwältigende Mehrheit der Abfragen korrekt, und für flache Ergebnisse oder DTO-Projektionen ist es strikt die richtige Wahl. Stufen Sie eine Abfrage nur dann auf `AsNoTrackingWithIdentityResolution` hoch, wenn zwei Bedingungen zugleich gelten: Das Ergebnis enthält wirklich dieselbe Entität mehrfach (ein `Include`, das einen Elternteil über Kinder verteilt, ist der Lehrbuch-Auslöser), und etwas in Ihrem Code ist darauf angewiesen, pro Schlüssel eine einzige gemeinsame Instanz zu erhalten -- Referenzgleichheit, In-Memory-Gruppierung oder Graphkonsistenz. In dieser Situation gibt Ihnen die Methode einen Objektgraphen in Tracking-Qualität zu nahezu No-Tracking-Kosten, und bei starker Duplizierung kann sie sogar weniger allokieren. Außerhalb dieser Situation ist sie reiner Overhead.

Und greifen Sie zu keinem von beiden, wenn das eigentliche Problem zu viele Zeilen sind. Wenn eine Abfrage mit mehreren `Include` explodiert, ist die dauerhafte Lösung [Query Splitting](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/) oder eine schärfere Projektion, nicht ein clientseitiger Deduplizierungsdurchlauf über Zeilen, die Sie gar nicht hätten laden sollen. Derselbe Instinkt, der Sie von versehentlichen [N+1-Abfragen](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) fernhält, gilt hier: Formen Sie die Abfrage so, dass die Datenbank zurückgibt, was Sie tatsächlich brauchen, und wählen Sie dann die günstigste Materialisierung, die für Ihre Nutzung des Ergebnisses korrekt ist.

## Verwandt

- [EF Core ExecuteUpdate vs Entitäten laden und SaveChanges: welche sollten Sie verwenden?](/2026/06/ef-core-executeupdate-vs-loading-entities-and-savechanges/)
- [Wie man Query Splitting nutzt, um eine kartesische Explosion in EF Core 11 zu vermeiden](/2026/06/how-to-use-query-splitting-to-avoid-a-cartesian-explosion-in-ef-core-11/)
- [Wie man N+1-Abfragen in EF Core 11 erkennt](/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Wie man kompilierte Abfragen mit EF Core auf Hot Paths nutzt](/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Wie man einen DbContext mockt, ohne das Change Tracking zu brechen](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/)
- [Fix: the instance of entity type cannot be tracked because another instance with the same key value is already being tracked](/2026/05/fix-instance-of-entity-type-cannot-be-tracked-same-key-value/)

## Quellen

- [Tracking vs. No-Tracking Queries - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/querying/tracking)
- [Efficient querying - EF Core (Microsoft Learn)](https://learn.microsoft.com/en-us/ef/core/performance/efficient-querying)
- [Announcing the release of EF Core 5.0 (.NET Blog)](https://devblogs.microsoft.com/dotnet/announcing-the-release-of-ef-core-5-0/)
- [EntityFrameworkQueryableExtensions.AsNoTrackingWithIdentityResolution Method (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/api/microsoft.entityframeworkcore.entityframeworkqueryableextensions.asnotrackingwithidentityresolution)
