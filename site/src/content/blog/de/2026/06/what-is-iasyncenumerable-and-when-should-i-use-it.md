---
title: "Was ist IAsyncEnumerable<T> und wann sollten Sie es verwenden?"
description: "IAsyncEnumerable<T> ist die Schnittstelle für asynchrone Streams: eine Sequenz, deren Elemente über die Zeit eintreffen und bei der jedes Element ein await erfordern kann. Hier erfahren Sie, was es wirklich ist, wie await foreach und yield es antreiben, und die Regel, wann Sie es statt Task<List<T>> wählen sollten."
pubDate: 2026-06-19
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "iasyncenumerable"
lang: "de"
translationOf: "2026/06/what-is-iasyncenumerable-and-when-should-i-use-it"
translatedBy: "claude"
translationDate: 2026-06-19
---

`IAsyncEnumerable<T>` ist die Schnittstelle für einen asynchronen Stream: eine Sequenz, die Sie ein Element nach dem anderen abrufen, wobei das Erzeugen jedes Elements ein Warten auf etwas erfordern kann (ein Netzwerklesevorgang, eine Datenbankzeile, ein Dateifragment). Es ist das asynchrone Gegenstück zu `IEnumerable<T>`. Sie erzeugen es mit einer Iteratormethode, die `yield return` und `await` kombiniert, und konsumieren es mit `await foreach`. Greifen Sie dazu, wenn Sie viele Elemente haben, die über die Zeit eintreffen, und Sie nicht alle im Speicher puffern möchten, bevor Sie das erste verarbeiten. Wenn Sie immer nur ein einzelnes Ergebnis erzeugen oder die gesamte Sammlung bereits im Speicher liegt, brauchen Sie es nicht. Dieser Beitrag (aktuell für .NET 11, C# 14) erklärt die Mechanik, den Grund, warum die naheliegenden Alternativen scheitern, und die Entscheidungsregel.

## Die Lücke, die `Task<T>` und `IEnumerable<T>` offen lassen

Stellen Sie die vier Formen nebeneinander, und die fehlende Zelle wird offensichtlich:

| | einzelner Wert | viele Werte |
| --- | --- | --- |
| **synchron** | `T` | `IEnumerable<T>` |
| **asynchron** | `Task<T>` | `IAsyncEnumerable<T>` |

`Task<T>` liefert Ihnen einen Wert, später. `IEnumerable<T>` liefert viele Werte, aber das Abrufen jedes einzelnen ist synchron: `MoveNext()` gibt einen `bool` zurück, nicht etwas, worauf Sie warten können. Jahrelang hatte die untere rechte Zelle keinen erstklassigen Typ, und man behalf sich mit zwei schlechten Notlösungen.

Die erste ist `Task<IEnumerable<T>>` (oder `Task<List<T>>`). Diese wartet einmal und übergibt Ihnen dann die gesamte Sammlung. Sie funktioniert, aber sie vereitelt den Zweck des Streamings: nichts ist für Ihren Code sichtbar, bis alles abgerufen wurde. Eine Abfrage, die fünf Millionen Zeilen zurückgibt, allokiert eine Liste mit fünf Millionen, bevor Ihr Schleifenrumpf ein einziges Mal läuft.

Die zweite ist `IEnumerable<Task<T>>`. Diese ist schlimmer. Sie ist eine synchrone Sequenz von Tasks, was bedeutet, dass der Iterator die gesamte Arbeitsmenge im Voraus festlegt, und Sie haben keine natürliche Möglichkeit, Gegendruck anzuwenden oder die Erzeugung von Tasks zu stoppen, sobald ein Konsument das Interesse verliert. Sie können auch kein `await` innerhalb des `MoveNext` ausführen, das den nächsten Task erzeugt, also blockiert jede Latenz pro Element die Thread.

`IAsyncEnumerable<T>`, hinzugefügt in C# 8 und .NET Core 3.0, füllt die Zelle korrekt. Jeder Schritt der Iteration ist selbst awaitbar, also kann der Erzeuger zwischen Elementen warten, und der Konsument ruft das nächste Element nur ab, wenn er dafür bereit ist.

## Wie die Schnittstelle tatsächlich aussieht

Hier gibt es keine Magie. Der Vertrag ist klein:

```csharp
// System.Collections.Generic
public interface IAsyncEnumerable<out T>
{
    IAsyncEnumerator<T> GetAsyncEnumerator(
        CancellationToken cancellationToken = default);
}

public interface IAsyncEnumerator<out T> : IAsyncDisposable
{
    T Current { get; }
    ValueTask<bool> MoveNextAsync();
    ValueTask DisposeAsync();
}
```

Zwei Details tragen das gesamte Design.

`MoveNextAsync` gibt `ValueTask<bool>` statt `Task<bool>` zurück. Diese Wahl ist bewusst getroffen. Sie rufen `MoveNextAsync` einmal pro Element auf, also bedeutet ein Stream mit 100.000 Elementen 100.000 Aufrufe. Würde jeder ein `Task`-Objekt auf dem Heap allokieren, wären asynchrone Streams eine Allokationskatastrophe. `ValueTask<bool>` allokiert nichts, wenn das Ergebnis bereits synchron verfügbar ist (eine gepufferte Zeile zum Beispiel), was der häufige Fall bei einem schnellen Erzeuger ist. Sie zahlen die Heap-Kosten nur, wenn ein Element wirklich warten muss.

`IAsyncEnumerator<T>` implementiert `IAsyncDisposable`, nicht `IDisposable`. Das Aufräumen ist asynchron, weil das Schließen der zugrunde liegenden Ressource (ein Socket, ein `DbDataReader`) selbst E/A erfordern kann. Deshalb braucht die konsumierende Schleife `await foreach` und kein einfaches `foreach`: das Freigeben am Ende der Iteration muss abgewartet werden.

Sie rufen diese Member fast nie von Hand auf. Der Compiler erledigt das für Sie an beiden Enden.

## Einen Stream erzeugen: `yield return` trifft `await`

Eine asynchrone Iteratormethode ist eine, die `IAsyncEnumerable<T>` zurückgibt und sowohl `await` als auch `yield return` enthält. Der Compiler schreibt sie in einen Zustandsautomaten um, der weiß, wie er bei jedem `await` aussetzt und beim nächsten `MoveNextAsync` fortsetzt:

```csharp
// .NET 11, C# 14
public static async IAsyncEnumerable<string> ReadLinesAsync(
    string path,
    [EnumeratorCancellation] CancellationToken ct = default)
{
    using var reader = new StreamReader(path);
    while (await reader.ReadLineAsync(ct) is { } line)
    {
        yield return line;
    }
}
```

Lesen Sie, was Ihnen das gibt. Jede Zeile wird asynchron gelesen und dann sofort ausgegeben. Der Aufrufer kann Zeile eins verarbeiten, während Zeile zwei noch von der Festplatte gelesen wird. Der Speicher hält nie mehr als eine einzelne Zeile plus den internen Puffer des Readers, unabhängig davon, ob die Datei 10 Zeilen oder 10 Gigabyte hat. Das `using` auf dem Reader wird durch das generierte `DisposeAsync` eingehalten, also schließt sich der Datei-Handle, wenn die Iteration endet, auch wenn der Konsument vorzeitig aussteigt oder eine Ausnahme die Schleife abwickelt.

Das Attribut `[EnumeratorCancellation]` auf dem Token-Parameter ist der Teil, den man vergisst. Es teilt dem Compiler mit, dass dieser Parameter das Token erhalten soll, das ein Konsument über `WithCancellation` übergibt, und leitet externe Abbrüche in den Iteratorrumpf weiter. Ohne es ist der Parameter nur ein gewöhnliches Argument, das standardmäßig `CancellationToken.None` annimmt und ignoriert, was auch immer der Konsument geliefert hat. Mehr dazu unten, denn es ist der häufigste Korrektheitsfehler bei asynchronen Streams.

## Einen Stream konsumieren: `await foreach`

Die Konsumentenseite ist ein Schlüsselwort länger als eine normale Schleife:

```csharp
// .NET 11, C# 14
await foreach (var line in ReadLinesAsync("huge.log", ct))
{
    if (line.Contains("ERROR"))
        await alertSink.WriteAsync(line, ct);
}
```

Der Compiler erweitert dies zu Aufrufen von `GetAsyncEnumerator`, einer Schleife aus `await MoveNextAsync()`, die jede Runde `Current` liest, und einem `await DisposeAsync()` in einem finally-Block. Die Schleife ist vollständig sequenziell: Element N+1 wird erst angefordert, wenn Ihr Rumpf mit Element N fertig ist. Diese sequenzielle, bedarfsgesteuerte Form ist die Funktion, keine Einschränkung. Sie ist es, die den Speicher begrenzt und Ihnen natürlichen Gegendruck gibt: ein langsamer Konsument verlangsamt automatisch den Erzeuger, weil das nächste `await` des Erzeugers erst beim nächsten Aufruf von `MoveNextAsync` fortgesetzt wird.

Wenn die Iterationsreihenfolge keine Rolle spielt und Sie Nebenläufigkeit wollen, ist `await foreach` das falsche Werkzeug. Verwenden Sie [Parallel.ForEachAsync](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/), das ein `IAsyncEnumerable<T>` konsumieren und den Rumpf für mehrere Elemente gleichzeitig mit einer Obergrenze für den Parallelitätsgrad ausführen kann. `await foreach` ist für geordnete Verarbeitung, eines nach dem anderen.

## Abbruch: das Paar `WithCancellation` plus `[EnumeratorCancellation]`

Ein nacktes `await foreach (var x in stream)` gibt Ihnen keinen Ort, um ein Token zu übergeben, weil die Sprachsyntax keinen Platz dafür hat. Die zwei Teile, die den Kreis schließen, sind `WithCancellation` beim Konsumenten und `[EnumeratorCancellation]` beim Erzeuger:

```csharp
// Producer: token parameter is tagged
public static async IAsyncEnumerable<int> ProduceAsync(
    [EnumeratorCancellation] CancellationToken ct = default)
{
    for (var i = 0; ; i++)
    {
        await Task.Delay(100, ct);
        yield return i;
    }
}

// Consumer: token is forwarded into GetAsyncEnumerator
await foreach (var n in ProduceAsync().WithCancellation(ct))
{
    Console.WriteLine(n);
}
```

`WithCancellation` umhüllt die Sequenz nicht mit einem weiteren Iterator und fügt keinen Mehraufwand hinzu. Es vermerkt lediglich das Token, sodass, wenn der Compiler `GetAsyncEnumerator(token)` aufruft, das Token hineinfließt, und `[EnumeratorCancellation]` es zum Parameter des Erzeugers leitet. Brechen Sie das Token ab, und das ausstehende `await Task.Delay` wirft `OperationCanceledException`, die sich durch Ihr `await foreach` nach außen fortpflanzt.

Das Token wegzulassen ist der Weg zu hängenden Hintergrund-Jobs und steckengebliebenen Anfragen in der Produktion: ein Stream über ein Netzwerk oder eine Datenbank hält eine Verbindung für die gesamte Schleife, und ohne ein Token gibt es keine Möglichkeit, sie abzubrechen, wenn der Aufrufer verschwindet. Behandeln Sie `WithCancellation(ct)` als verpflichtend bei jedem von E/A gestützten Stream.

## `ConfigureAwait` funktioniert auch auf der Schleife

`await foreach` wartet intern, also greift es das Einfangen des Synchronisationskontexts genauso auf wie ein normales `await`. In Bibliothekscode, der nicht zu einem eingefangenen Kontext zurückkehren sollte, wenden Sie `ConfigureAwait(false)` auf die gesamte Schleife mit `ConfigureAwait` an:

```csharp
await foreach (var item in stream.ConfigureAwait(false))
{
    Process(item);
}
```

Dies konfiguriert sowohl die `MoveNextAsync`-Awaits als auch das abschließende `DisposeAsync`-Await. In einer modernen ASP.NET-Core-Anwendung gibt es keinen Synchronisationskontext zum Einfangen, also ist es dort ein No-Op, aber es ist weiterhin wichtig für Bibliothekscode, Konsolen-Hosts und alles, was unter einem UI- oder Legacy-Kontext laufen könnte. Die Abwägungen sind dieselben wie überall sonst im asynchronen Code, behandelt in [ob ConfigureAwait in .NET 11 noch wichtig ist](/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## LINQ über asynchrone Streams ist jetzt integriert

Eine langjährige raue Kante war, dass `IAsyncEnumerable<T>` kein LINQ hatte. Um `stream.Where(...).Select(...)` zu schreiben, zog man das von der Community gepflegte NuGet-Paket `System.Linq.Async` heran. Mit .NET 10 änderte sich das: die Laufzeit liefert `System.Linq.AsyncEnumerable` in der BCL aus, also funktionieren die Standardoperatoren über jedem `IAsyncEnumerable<T>` ohne Paketverweis, und .NET 11 erbt dies.

```csharp
// .NET 11: Where/Select/Take resolve from the BCL, no NuGet package
var firstTenErrors = ReadLinesAsync("huge.log", ct)
    .Where(l => l.Contains("ERROR"))
    .Take(10);

await foreach (var line in firstTenErrors.WithCancellation(ct))
    Console.WriteLine(line);
```

Wenn Sie ein älteres Projekt migrieren, entfernen Sie den expliziten Verweis auf `System.Linq.Async`, wenn Sie zu .NET 10 oder neuer wechseln; ihn drinzulassen verursacht Fehler durch mehrdeutige Überladungen gegen die nun integrierten Methoden. Eine Namensänderung, die man kennen sollte: die alten Operatoren `SelectAwait`/`WhereAwait`, die asynchrone Lambdas entgegennahmen, sind weg, und Sie übergeben das asynchrone Delegate stattdessen an das reguläre `Select`/`Where`. Code, der mehrere ältere Laufzeiten als Ziel hat, sollte das Paket `System.Linq.AsyncEnumerable` statt `System.Linq.Async` referenzieren.

## Wann Sie dazu greifen sollten

Verwenden Sie `IAsyncEnumerable<T>`, wenn alle drei dieser Bedingungen zutreffen:

1. Es gibt **viele** Elemente, oder eine unbekannte oder unbegrenzte Anzahl.
2. Das Erzeugen jedes Elements beinhaltet **asynchrone E/A** (Datenbank, Netzwerk, Datei, Nachrichtenwarteschlange).
3. Sie möchten **mit der Verarbeitung beginnen, bevor das letzte Element eintrifft**, oder Sie können es sich nicht leisten, sie alle auf einmal im Speicher zu halten.

Konkrete Fälle, die passen: Zeilen aus einer Datenbank für einen Export streamen, wie behandelt in [IAsyncEnumerable mit EF Core 11 verwenden](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/); eine paginierte API Seite für Seite lesen und jedes Element ausgeben, sobald die Seiten eintreffen; ein Log oder einen Nachrichtenstrom verfolgen, der nie endet; Daten in einen [Channel](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) oder einen `PipeWriter` leiten. In ASP.NET Core streamt das Zurückgeben von `IAsyncEnumerable<T>` aus einer Minimal API oder einer Controller-Aktion das JSON-Array Element für Element an den Client, statt die gesamte Antwort zu puffern.

## Wann Sie es nicht sollten

Asynchrone Streams sind nicht kostenlos, und sie sind nicht immer die richtige Form:

- **Die Daten liegen bereits im Speicher.** Über eine `List<T>` oder ein Array iterieren? Verwenden Sie `foreach`. Eine im Speicher liegende Sammlung in einen asynchronen Stream zu hüllen, fügt Zustandsautomaten-Mehraufwand hinzu und bringt nichts, weil kein Element je tatsächlich wartet.
- **Es gibt genau ein Ergebnis.** Eine Methode, die einen einzelnen Datensatz zurückgibt, sollte `Task<T>` zurückgeben. Ein Stream von einem ist nur Zeremonie.
- **Die Menge ist klein und begrenzt, und Sie brauchen wahlfreien Zugriff, `Count` oder mehrere Durchläufe.** `Task<List<T>>` (über `ToListAsync`) ist einfacher und erlaubt Indizierung, Zählen und erneutes Aufzählen. Das Streaming gibt Ihnen eine vorwärtsgerichtete Sequenz mit einem einzigen Durchlauf; wenn Sie mehr brauchen, materialisieren Sie sie.
- **Sie brauchen echte Parallelität über die Elemente.** Ein einzelnes `await foreach` ist von Natur aus sequenziell. Für Fan-out verwenden Sie `Parallel.ForEachAsync` oder sammeln Tasks und `Task.WhenAll`.

Eine nützliche Faustregel: Wenn Sie sich dabei ertappen, `ToListAsync()` sofort auf dem Stream aufzurufen, wollten Sie keinen Stream, sondern die Liste. Und wenn Sie versucht sind, eine im Speicher liegende Liste als `IAsyncEnumerable<T>` zu hüllen, nur um eine Methodensignatur zu erfüllen, überdenken Sie die Signatur.

## Eine Anmerkung zu Freigabe und vorzeitigem Ausstieg

Da der Enumerator `IAsyncDisposable` ist, garantiert das `await foreach`, dass `DisposeAsync` läuft, wenn die Schleife aus irgendeinem Grund endet: normale Beendigung, ein `break`, oder eine Ausnahme, die durch den Rumpf reißt. Das ist es, was das `using` innerhalb eines asynchronen Iterators sicher macht. Die subtile Konsequenz ist, dass vorzeitiges Aussteigen die zugrunde liegende Quelle nicht zwangsläufig sofort stoppt. Eine Datenbank könnte serverseitig bereits Zeilen aufgespult haben; ein gepufferter Netzwerk-Reader könnte das nächste Fragment vorab geholt haben. Die Freigabe sendet das Abbruchsignal, aber ein wenig bereits in Bearbeitung befindliche Arbeit kann sich trotzdem noch abschließen. Das ist fast nie ein Problem, aber es erklärt den gelegentlichen Moment "warum läuft diese Abfrage noch, nachdem meine Schleife ausgestiegen ist?" in einem Profiler.

Asynchrone Streams machten die unbequeme untere rechte Zelle der Wert-/Sammlungsmatrix zu einem erstklassigen Sprachfeature. Das mentale Modell ist das ganze Spiel: es ist `IEnumerable<T>`, bei dem jeder Schritt `await` ausführen kann, angetrieben von `await foreach`, und genau dann lohnend, wenn die Elemente über die Zeit eintreffen und Sie sie lieber verarbeiten möchten, sobald sie kommen, als auf sie alle zu warten.

## Verwandt

- [How to use IAsyncEnumerable<T> with EF Core 11](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) wendet all dies auf das Streamen von Datenbankzeilen an.
- [IEnumerable vs IAsyncEnumerable vs IQueryable in C#](/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) ist der vergleichende Entscheidungsleitfaden für die drei Sequenzschnittstellen.
- [How to stream a file from an ASP.NET Core endpoint without buffering](/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) ist das HTTP-Antwort-Gegenstück zum Erzeugen eines Streams.
- [How to cancel a long-running Task in C# without deadlocking](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) geht tiefer auf die Abbruch-Token ein, von denen asynchrone Streams abhängen.
- [Streaming tasks with .NET 9 Task.WhenEach](/2026/01/streaming-tasks-with-net-9-task-wheneach/) ist die andere Hauptmethode, um Ergebnisse zu konsumieren, sobald sie abgeschlossen sind.

## Quellen

- [IAsyncEnumerable<T> interface, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.collections.generic.iasyncenumerable-1?view=net-10.0).
- [Generate and consume async streams, C# docs](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/generate-consume-asynchronous-stream).
- [EnumeratorCancellationAttribute class, .NET API reference](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute?view=net-10.0).
- [Breaking change: System.Linq.AsyncEnumerable in .NET 10, MS Learn](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/10.0/asyncenumerable).
- [async-streams design doc, dotnet/roslyn on GitHub](https://github.com/dotnet/roslyn/blob/main/docs/features/async-streams.md).
