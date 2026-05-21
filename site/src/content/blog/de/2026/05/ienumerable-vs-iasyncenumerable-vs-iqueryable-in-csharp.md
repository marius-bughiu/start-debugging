---
title: "IEnumerable vs IAsyncEnumerable vs IQueryable in C#: Was sollte die Methode zurückgeben?"
description: "Drei Sequenz-Interfaces, drei Ausführungsmodelle. Verwenden Sie IQueryable, wenn eine Datenbank die Abfrage übersetzen kann, IAsyncEnumerable, wenn der Producer asynchron ist und Sie streamen möchten, IEnumerable für alles andere im Speicher."
pubDate: 2026-05-21
template: vs
tags:
  - "comparison"
  - "csharp"
  - "linq"
  - "ef-core"
  - "async"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-21
---

Wenn Sie zwischen `IEnumerable<T>`, `IAsyncEnumerable<T>` und `IQueryable<T>` für eine Methodensignatur in C# 14 / .NET 11 wählen, ist die Regel fast mechanisch. Geben Sie `IQueryable<T>` nur dann zurück, wenn der Konsument weitere `Where`/`Select`/`OrderBy`-Aufrufe komponieren kann und der zugrundeliegende Provider (EF Core 11, LINQ to SQL, ein OData-Client) sie in die entfernte Abfrage übersetzen kann. Geben Sie `IAsyncEnumerable<T>` zurück, wenn der Producer pro Element oder pro Batch E/A ausführt und Sie wollen, dass der Konsument mit der Verarbeitung beginnt, bevor der Producer fertig ist. Geben Sie `IEnumerable<T>` für alles zurück, was bereits im Speicher ist oder was Sie an der Grenze vollständig materialisieren wollen. Der Fehler, den es zu vermeiden gilt, ist `IQueryable<T>` aus einem Repository heraus zu lecken: jedes nachfolgende `.Where(...)` wird Teil des SQL, ob Sie es wollten oder nicht, und "wo läuft diese Abfrage eigentlich" wird zu einer Frage, die Sie mit dem Debugger beantworten müssen.

Dieser Beitrag ist die Langfassung. Alle Beispiele zielen auf `<TargetFramework>net11.0</TargetFramework>` mit `<LangVersion>14.0</LangVersion>` und, wo relevant, `Microsoft.EntityFrameworkCore 11.0.0`.

## Drei Interfaces, drei Ausführungsmodelle

Die drei Interfaces sehen auf dem Papier ähnlich aus. Alle stellen eine einzelne Sequenz von `T` zur Verfügung. Der Unterschied ist, wo die Arbeit passiert und wann.

- `IEnumerable<T>` ist eine pull-basierte, synchrone Sequenz. `MoveNext` läuft im aufrufenden Thread. Der Producer ist eine Methode, die Elemente liefert, ein `List<T>`, ein `T[]` oder eine LINQ-to-Objects-Kette. Der Producer kann nichts mit `await` warten.
- `IAsyncEnumerable<T>` ist eine pull-basierte, asynchrone Sequenz. `MoveNextAsync` gibt einen `ValueTask<bool>` zurück, was es dem Producer erlaubt, zwischen Elementen zu warten. Der Konsument iteriert mit `await foreach`. Eingeführt in C# 8 / .NET Core 3.0; erstklassig in modernem LINQ über das Paket `System.Linq.Async` und EF Cores `AsAsyncEnumerable`.
- `IQueryable<T>` ist ein Builder für Ausdrucksbäume. Jedes `Where`, `Select` oder `OrderBy`, das Sie an ein `IQueryable<T>` ketten, hängt einen Knoten an den Ausdrucksbaum an. Der Baum wird erst in etwas Ausführbares übersetzt (eine SQL-Anweisung, eine OData-URL, eine Cosmos-Abfrage), wenn Sie einen terminalen Operator aufrufen (`ToList`, `FirstOrDefault`, `Count`, `ToListAsync`). Bis dahin ist keine E/A passiert.

Die wichtigste Konsequenz: Ein `IEnumerable<T>`, das von einem EF-Core-Aufruf zurückgegeben wird, hat die Datenbank bereits verlassen. Ein `IQueryable<T>`, das vom gleichen Aufruf zurückgegeben wird, nicht. Diese eine Tatsache ist verantwortlich für mehr "Warum ist diese Abfrage langsam"-Tickets als jede andere einzelne Ursache in EF-Core-Code.

## Feature-Matrix

| Fähigkeit                                       | `IEnumerable<T>`         | `IAsyncEnumerable<T>`        | `IQueryable<T>`                     |
| ----------------------------------------------- | ------------------------ | ---------------------------- | ----------------------------------- |
| Ausführungsmodell                               | sync pull                | async pull                   | deferred, vom Provider übersetzt    |
| Wo die Arbeit läuft                             | aufrufender Thread, im Speicher | Producer-Seite, awaitable | entfernter Provider (DB, OData, Cosmos) |
| Kann `await` zwischen Elementen                 | nein                     | ja                           | n/a (keine Arbeit pro Element)      |
| Verfügbare LINQ-Operatoren                      | LINQ to Objects          | LINQ to Objects (Async)      | providerspezifische Untermenge      |
| Komponierbar nach Rückgabe                      | ja (im Speicher)         | ja (im Speicher)             | ja (entfernt übersetzt)             |
| Streamt ohne Pufferung                          | ja (lazy `yield return`) | ja                           | hängt vom Provider ab               |
| Abbruch                                         | keiner, der Loop ist sync| `CancellationToken` pro Element | pro Abfrage via `ToListAsync(token)` |
| Risiko beim Rückgeben aus einem Repository      | gering                   | mittel (Lebensdauer des Providers) | hoch (Aufrufer kann SQL anhängen) |
| Beste Passform                                  | In-Memory-Sammlungen     | entfernte Streams, server-sent | repo-interne Abfrageobjekte       |
| Materialisiert bei                              | bei jedem `MoveNext`     | bei jedem `await MoveNextAsync` | beim terminalen Operator         |

Die Matrix ist der Beitrag. Alles darunter ist die Begründung.

## Wann `IEnumerable<T>` der richtige Rückgabetyp ist

`IEnumerable<T>` ist die Standardwahl für "Ich habe Elemente, gib mir eine Sequenz". Es ist synchron, hat jeden LINQ-to-Objects-Operator und komponiert günstig. Verwenden Sie es für:

- Eine Methode, die aus einer In-Memory-Sammlung oder einer reinen Berechnung liefert.
- Eine Methode, die die Daten bereits materialisiert hat und nun eine Sicht darauf zurückgibt (`return list.Where(x => x.IsActive);`).
- Eine Methode, die eine synchrone Quelle durchläuft, wie eine Datei, die Sie mit `File.ReadLines` lesen, oder ein deserialisiertes DOM.

Die Falle ist, `IEnumerable<T>` als Rückgabetyp einer Repository-Methode zu verwenden, die einen asynchronen E/A-Aufruf umschließt. Das zwingt das Repository, intern `.ToList()` zu machen und die Streaming-Eigenschaft zu verlieren, oder es zwingt den Aufrufer zu `.Result` und einer Threadpool-Blockade. Beides ist falsch. Wenn die Quelle asynchron ist, sollte die Signatur `IAsyncEnumerable<T>` oder `Task<List<T>>` sein, nicht `IEnumerable<T>`.

```csharp
// .NET 11, C# 14
public static IEnumerable<string> ReadLowercaseLines(string path)
{
    foreach (var line in File.ReadLines(path))
    {
        yield return line.ToLowerInvariant();
    }
}
```

`File.ReadLines` gibt ein `IEnumerable<string>` zurück, das die Datei lazy liest. Die Transformation bleibt lazy. Nichts zwingt die Datei dazu, vollständig geladen zu werden, bevor das erste Element den Aufrufer erreicht.

Das Schlüsselwort `yield return` ist das, was dies funktionieren lässt. Es weist den Compiler an, eine Zustandsmaschine zu generieren, die Elemente einzeln zurückgibt und die Methode zwischen Yields aussetzt. Es ist das synchrone Gegenstück zu `await foreach` plus `yield return` zusammen.

## Wann `IAsyncEnumerable<T>` der richtige Rückgabetyp ist

`IAsyncEnumerable<T>` ist das, wonach Sie greifen, wenn der Producer zwischen Elementen `await` benötigt. Das Paradebeispiel ist ein paginierter HTTP-Endpunkt: Sie holen Seite 1, liefern jedes Element, holen Seite 2, liefern jedes Element. Sie wollen, dass der Konsument mit der Arbeit an Seite 1 beginnt, während Seite 2 noch unterwegs ist. Sie wollen auch ein `CancellationToken` eingebunden haben, damit der Konsument den Producer sauber stoppen kann.

Verwenden Sie es für:

- Paginierte entfernte Quellen (HTTP-APIs, die Seiten zurückgeben, Server-Sent Events, Message-Queue-Consumer).
- EF-Core-11-Abfragen, die Ergebnisse in ein CSV oder in eine andere HTTP-Antwort streamen, ohne in den Speicher zu materialisieren.
- Jeden Producer, bei dem Backpressure wichtig ist: Der Konsument liest, verarbeitet, und erst dann fragt er nach dem nächsten Element.

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<Order> FetchAllAsync(
    HttpClient http,
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    string? next = "/api/orders?page=1";
    while (next is not null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var page = await http.GetFromJsonAsync<PageOf<Order>>(next, cancellationToken)
                   ?? throw new InvalidOperationException("page was null");
        foreach (var order in page.Items)
        {
            yield return order;
        }
        next = page.NextLink;
    }
}
```

Zwei Details, die Leute auf dem falschen Fuß erwischen. Erstens ist `[EnumeratorCancellation]` erforderlich, um das Token von `WithCancellation(...)` an der Aufrufstelle in den Iterator zu verdrahten. Ohne es verwirft `await foreach (var x in source.WithCancellation(token))` das Token still. Zweitens kann eine asynchrone Iterator-Methode kein `try/catch` um ein `yield return` für eine Ausnahme verwenden, die von einem nachgelagerten Operator kommt; die Ausnahme fließt durch den Konsumenten, nicht durch den Producer. Wickeln Sie die E/A-Aufrufe explizit ein, wenn Sie Retry-Logik brauchen.

Für EF Core 11 ist das Äquivalent auf einem `DbSet<T>` `AsAsyncEnumerable`:

```csharp
// .NET 11, C# 14, EF Core 11.0.0
await foreach (var order in db.Orders
    .Where(o => o.Status == "shipped")
    .AsAsyncEnumerable()
    .WithCancellation(cancellationToken))
{
    await sink.WriteAsync(order, cancellationToken);
}
```

Das hält den SQL-DataReader offen und zieht Zeilen bei Bedarf nach. Das gesamte Set landet niemals in `List<Order>`. Für die EF-Core-Spezifika siehe [wie man IAsyncEnumerable mit EF Core 11 verwendet](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/).

## Wann `IQueryable<T>` der richtige Rückgabetyp ist

`IQueryable<T>` ist die richtige Form innerhalb eines Repositorys oder eines Abfrage-Builder-Helpers, wo der Aufrufer noch komponieren soll. Es ist die falsche Form über eine Netzwerkgrenze hinweg oder aus einer Schicht heraus, die der nächste Aufrufer möglicherweise nicht versteht.

Verwenden Sie es für:

- Eine `Queryable`-Erweiterung, die ein bestehendes `IQueryable<T>` nimmt und eine `Where`-Klausel hinzufügt: `q.WhereActive()`. Der Provider übersetzt das Prädikat; Sie laufen niemals auf materialisierten Daten.
- Eine Repository-Methode, die eine schmale, projektspezifische Abfrage offenlegt, die der Aufrufer weiter filtert, paginiert oder zählt: `IQueryable<Invoice> Unpaid(int customerId)`.
- Eine Bibliotheks-API, bei der vom Konsumenten erwartet wird, dass er Ausdrücke aufbaut, wie ein OData-Controller oder eine eigene Such-DSL.

Das Muster, das beißt, ist `IQueryable<T>` aus einer Service-Schicht heraus offenzulegen, von der der Aufrufer annimmt, dass sie In-Memory-Daten zurückgibt:

```csharp
// Anti-Pattern: kein IQueryable<T> aus einem öffentlichen Service zurückgeben
public IQueryable<Order> GetRecentOrders() => _db.Orders.Where(o => o.At > _start);

// Aufrufer, kilometerweit entfernt
var bad = service.GetRecentOrders()
                 .Where(o => SomeLocalMethod(o))   // EF Core wirft: nicht übersetzbar
                 .OrderBy(o => o.Total)
                 .Take(50)
                 .ToList();
```

`SomeLocalMethod` ist eine C#-Methode, die EF Core nicht übersetzen kann. Der `Where`-Aufruf hängt einen Ausdruck an, den der Provider nicht zu SQL absenken kann, und bei der Materialisierung bekommen Sie eine Ausnahme. Oder schlimmer: in einem Provider, der still auf Client-Evaluation zurückfällt, ziehen Sie versehentlich jede Zeile über die Leitung, um im Prozess zu filtern. EF Core 11 wirft standardmäßig; älterer Code mit mitten in einer Kette eingefügten `AsEnumerable`-Wechseln ist noch schwerer zu lesen.

Die Lösung ist, an der Grenze zu materialisieren:

```csharp
// .NET 11, C# 14
public async Task<IReadOnlyList<Order>> GetRecentOrdersAsync(
    int count, CancellationToken ct)
{
    return await _db.Orders
        .Where(o => o.At > _start)
        .OrderByDescending(o => o.At)
        .Take(count)
        .ToListAsync(ct);
}
```

Die Methode gibt jetzt eine konkrete, materialisierte Sammlung zurück. Der Aufrufer kann nicht versehentlich SQL anhängen. Wenn der Aufrufer einen anderen Filter will, fragt er explizit über einen Parameter oder eine neue Methode. Das ist die gleiche Begründung, die [wie man N+1-Abfragen in EF Core 11 erkennt](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/) antreibt: Seien Sie explizit darüber, wo die Abfragegrenze liegt.

## Der Benchmark: eine Million Zeilen auf drei Arten streamen

Eine echte Zahl. Das Setup: 1.000.000 schmale Zeilen (ein `Guid Id`, ein `int Status`, ein `DateTime At`) in SQL Server 2022. Der Konsument zählt Zeilen, die einen Filter (`Status == 1`) passieren, und schreibt eine Summe der Timestamps. Wir machen es auf drei Arten:

- `IEnumerable<T>`, erzeugt durch `ToList()` und dann aufgezählt.
- `IAsyncEnumerable<T>`, erzeugt durch `AsAsyncEnumerable()`.
- `IQueryable<T>`, innerhalb derselben Methode konsumiert via `await Where(...).CountAsync()`.

```csharp
// .NET 11, C# 14, EF Core 11.0.0, BenchmarkDotNet 0.14.0
[MemoryDiagnoser]
public class SequenceShapes
{
    private AppDb _db = null!;

    [GlobalSetup] public void Setup() => _db = AppDb.Connect();

    [Benchmark]
    public long Materialize_Then_Enumerate()
    {
        var rows = _db.Events.ToList();              // pull all 1,000,000
        long sum = 0; long count = 0;
        foreach (var r in rows)
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark]
    public async Task<long> StreamAsync()
    {
        long sum = 0; long count = 0;
        await foreach (var r in _db.Events.AsAsyncEnumerable())
            if (r.Status == 1) { sum += r.At.Ticks; count++; }
        return sum + count;
    }

    [Benchmark(Baseline = true)]
    public async Task<long> Queryable_Aggregate()
    {
        var count = await _db.Events.Where(e => e.Status == 1).CountAsync();
        var sum   = await _db.Events.Where(e => e.Status == 1)
                                    .SumAsync(e => (long)e.At.Ticks);
        return sum + count;
    }
}
```

Methodik: BenchmarkDotNet 0.14.0, .NET 11.0.0 RTM, EF Core 11.0.0, SQL Server 2022 16.0.4135 auf derselben Maschine über Loopback. Windows 11 24H2, AMD Ryzen 9 7900X, 64 GB DDR5. Die Zahlen stammen aus einem repräsentativen Lauf.

| Methode                         | Mittel       | Zugewiesen  |
| ------------------------------- | ------------ | ----------- |
| Queryable_Aggregate (Baseline)  | 38 ms        | 1,4 KB      |
| StreamAsync                     | 1.210 ms     | 410 MB      |
| Materialize_Then_Enumerate      | 1.380 ms     | 432 MB      |

Das Muster ist konsistent damit, wie die drei Interfaces funktionieren. `IQueryable<T>` lässt die Datenbank die Zählung und die Summe machen und schickt zwei Skalare zurück. `IAsyncEnumerable<T>` spart Ihnen etwa 12 Prozent Gesamtzeit gegenüber `ToList`-und-Loop, und es spart das spitzenförmige Speicherprofil (die `List<Event>`-Zuweisung in `Materialize_Then_Enumerate` ist in `dotnet-counters` als einzelner `gen2`-Peak sichtbar). Aber beide verlieren gegen die queryable-Form um den Faktor 30, weil die Arbeit zur Datenbank gehörte, nicht zum Client.

Die Erkenntnis ist nicht "immer IQueryable verwenden". Sie lautet: Wenn die Operation in der Abfragesprache des Providers ausgedrückt werden kann, ziehen Sie die Zeilen nicht heraus. Wenn Sie die Zeilen herausziehen müssen (CSV-Export, eine Transformation, die nicht übersetzt, ein nachgelagerter Service, der einzelne Elemente will), bevorzugen Sie `IAsyncEnumerable<T>` gegenüber einem materialisierten `IEnumerable<T>`.

## Die Stolpersteine, die für Sie entscheiden

Ein paar Dinge entscheiden für Sie, unabhängig von Präferenz.

- **`IQueryable<T>` benötigt einen lebenden Provider.** `IQueryable<T>` aus einer Methode zurückzugeben, deren `DbContext` beim Rückkehren der Methode entsorgt wird, ist ein verkappter Use-after-free. Der Ausdrucksbaum existiert noch, aber in dem Moment, in dem der Aufrufer ihn materialisiert, fliegt eine `ObjectDisposedException`. Halten Sie entweder den Kontext für die Dauer des Queryable am Leben, oder materialisieren Sie vor der Rückgabe.

- **`IAsyncEnumerable<T>` benötigt `[EnumeratorCancellation]`.** Ohne es erreicht das Abbruch-Token, das ein Aufrufer über `.WithCancellation(token)` übergibt, niemals den Producer. Der Compiler warnt Sie nicht; der Bug ist still und das Token wird ignoriert. Der Roslyn-Analyzer `CA1068` erkennt den fehlenden Parameter; `CA2016` erkennt die fehlende Token-Weitergabe an interne asynchrone Aufrufe.

- **LINQ-Operatoren unterscheiden sich.** `Skip`, `Take`, `OrderBy`, `Select`, `Where`, `First`, `Count` existieren auf allen dreien. Aber `IAsyncEnumerable<T>` braucht das Paket `System.Linq.Async` für `WhereAsync`, `SelectAwait`, `SelectMany`, `GroupBy` und Freunde. `IQueryable<T>` unterstützt nur die Teilmenge, die sein Provider übersetzen kann; alles andere wirft entweder (EF Core 11) oder fällt still auf Client-Evaluation zurück (einige ältere Provider).

- **`IQueryable<T>` leakt das Persistenzmodell.** Wenn der Aufrufer `.Where(...)` schreiben kann, schreibt der Aufrufer SQL. Das Umbenennen eines Spaltennamens in der Entity wird zu einer codebasisweiten Suche, weil jeder queryable-Konsument diese Spalte berührt. Ein Repository, das materialisierte DTOs zurückgibt, verbirgt das Schema; eines, das `IQueryable<Entity>` zurückgibt, nicht.

- **Sie in einer Kette zu mischen.** `.AsEnumerable()` oder `.AsAsyncEnumerable()` mitten in einer `IQueryable<T>`-Kette aufzurufen, konvertiert den Rest zu In-Memory-Auswertung. Jedes `Where` nach diesem Punkt läuft auf dem Client. Manchmal ist das gewollt (ein komplexes Prädikat, das nicht übersetzt); oft ist es ein Performance-Bug. Machen Sie den Wechsel explizit und setzen Sie einen Kommentar daneben.

- **`yield return` innerhalb von `using` ist in Ordnung, aber die Ressource lebt so lange wie der Iterator.** Ein synchroner Iterator, der einen `FileStream` öffnet und Zeilen liefert, hält die Datei offen, bis der Konsument den Enumerator entsorgt oder mit der Iteration fertig ist. Dasselbe gilt, mit schlimmeren Fehlermodi, für asynchrone Iteratoren, die einen `DbDataReader` halten. Iterieren Sie immer bis zum Ende oder rufen Sie `await foreach` innerhalb eines using-/awaiting-Blocks auf.

## Die meinungsstarke Empfehlung, neu formuliert

Standardmäßig `IEnumerable<T>` für In-Memory-Arbeit. Greifen Sie zu `IAsyncEnumerable<T>` in dem Moment, in dem der Producer `await` benötigt, und verdrahten Sie `[EnumeratorCancellation]` von Tag eins an. Halten Sie `IQueryable<T>` innerhalb der Repository- oder Abfrage-Builder-Schicht; konvertieren Sie zu einer materialisierten `IReadOnlyList<T>` oder zu `IAsyncEnumerable<T>`, bevor Sie eine Service-Grenze überqueren.

Zwei Korollare, die es wert sind, ins Muskelgedächtnis übernommen zu werden:

- "Geben Sie die geringste Macht zurück, die der Aufrufer braucht". Eine Methode, die konzeptionell eine Liste zurückgibt, sollte `IReadOnlyList<T>` zurückgeben, nicht `IQueryable<T>`. Macht, die der Aufrufer nicht braucht, ist Macht, die der Aufrufer missbrauchen kann.
- "Materialisierung ist eine Grenze". Entscheiden Sie einmal, wo sie stattfindet, an einer Stelle, und schreiben Sie den Rest der Schicht zu diesem Vertrag. Codebasen, in denen jede Methode `IQueryable<T>` "für alle Fälle" zurückgibt, enden mit zufällig verstreuten `.ToList()`-Aufrufen und einem Budget für langsame Abfragen, das niemand besitzt.

## Verwandt

- [Wie man IAsyncEnumerable mit EF Core 11 verwendet](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [EF Core 11 vs Dapper für Bulk-Inserts: ein echter Benchmark](/de/2026/05/ef-core-11-vs-dapper-for-bulk-inserts-real-benchmark/)
- [Wie man N+1-Abfragen in EF Core 11 erkennt](/de/2026/05/how-to-detect-n-plus-1-queries-in-ef-core-11/)
- [Wie man kompilierte Abfragen mit EF Core auf heißen Pfaden verwendet](/de/2026/05/how-to-use-compiled-queries-with-ef-core-for-hot-paths/)
- [Wie man eine Datei aus einem ASP.NET Core-Endpunkt ohne Pufferung streamt](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## Quellen

- [IQueryable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.linq.iqueryable-1)
- [IAsyncEnumerable Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1)
- [Generate asynchronous streams (async iterators) -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream)
- [EnumeratorCancellationAttribute -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute)
- [Client vs server evaluation -- EF Core docs](https://learn.microsoft.com/en-us/ef/core/querying/client-eval)
- [System.Linq.Async on NuGet](https://www.nuget.org/packages/System.Linq.Async)
