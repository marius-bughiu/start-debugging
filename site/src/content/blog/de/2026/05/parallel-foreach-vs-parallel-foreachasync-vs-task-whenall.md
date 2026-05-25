---
title: "Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll in C#"
description: "Verwenden Sie Parallel.ForEach für CPU-lastige Arbeit über Daten im Speicher, Parallel.ForEachAsync für asynchrone E/A über viele Elemente mit einer Parallelitätsgrenze und Task.WhenAll für ein kleines, festes Fan-out, bei dem alle Operationen gleichzeitig laufen sollen und Sie die Ergebnisse benötigen."
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
lang: "de"
translationOf: "2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall"
translatedBy: "claude"
translationDate: 2026-05-25
---

Verwenden Sie `Parallel.ForEach`, wenn die Arbeit CPU-lastig ist und die Daten bereits im Speicher liegen: 100.000 Dateien hashen, ein großes Array transformieren, alles, was die Kerne auslastet. Verwenden Sie `Parallel.ForEachAsync`, wenn jedes Element asynchrone E/A auslöst (einen HTTP-Aufruf, eine Datenbankabfrage) und Sie eine begrenzte Anzahl davon gleichzeitig in Bearbeitung haben möchten. Verwenden Sie `Task.WhenAll`, wenn Sie eine kleine, feste Menge asynchroner Operationen haben, die Sie alle auf einmal starten und deren Ergebnisse Sie sammeln möchten. Der eine Fehler, der die Entscheidung für Sie trifft: Führen Sie niemals asynchrone E/A innerhalb von `Parallel.ForEach` aus, denn das Blockieren mit `.Result` oder `.Wait()` innerhalb seines synchronen Bodys hungert den Thread-Pool aus.

Dieser Artikel zielt auf .NET 11 und C# 14. `Parallel.ForEach` gibt es seit .NET Framework 4.0 (2010); `Task.WhenAll` seit .NET Framework 4.5; und `Parallel.ForEachAsync` ist der Neuzugang, hinzugefügt in .NET 6 (2021). Das hier beschriebene Verhalten ist von .NET 6 bis .NET 11 stabil.

## Diese drei lösen unterschiedliche Probleme

Der Vergleich ist umständlich, weil die drei keine austauschbaren APIs mit unterschiedlicher Leistung sind. Sie sind Antworten auf drei verschiedene Fragen.

`Parallel.ForEach` fragt: "Ich habe eine Sammlung und eine synchrone, CPU-lastige Operation pro Element. Verteile sie auf die Kerne." Sein Body ist ein `Action<T>`. Es partitioniert die Quelle, führt den Body auf mehreren Threads des Thread-Pools aus und blockiert den aufrufenden Thread, bis jedes Element fertig ist. Es ist das Arbeitspferd für Datenparallelität aus der Task Parallel Library.

`Parallel.ForEachAsync` fragt: "Ich habe eine Sammlung und eine asynchrone Operation pro Element. Führe sie nebenläufig aus, aber begrenze, wie viele gleichzeitig laufen." Sein Body ist ein `Func<TSource, CancellationToken, ValueTask>`. Es gibt eine `Task` zurück, auf die Sie warten; es blockiert nicht. Entscheidend: Es drosselt. Standardmäßig führt es höchstens `Environment.ProcessorCount` Operationen parallel aus, und Sie können dies mit `ParallelOptions.MaxDegreeOfParallelism` explizit festlegen.

`Task.WhenAll` fragt: "Ich habe bereits eine Menge Tasks. Sag mir, wann sie alle fertig sind." Es startet nichts, drosselt nichts und iteriert keine Quelle. Sie erstellen die Tasks (was sie startet), übergeben die Sammlung an `WhenAll` und warten auf die eine Task, die es zurückgibt. Wenn Sie 5.000 Tasks starten, sind alle 5.000 in dem Moment in Bearbeitung, in dem Sie warten.

Die eigentliche Entscheidung betrifft also die Form Ihrer Arbeit, nicht die rohe Geschwindigkeit: CPU-lastig über Daten (`Parallel.ForEach`), asynchrone E/A über viele Elemente mit einer Obergrenze (`Parallel.ForEachAsync`) oder eine bekannte Handvoll asynchroner Operationen, die Sie alle auf einmal wollen und deren Ergebnisse Sie benötigen (`Task.WhenAll`).

## Die Entscheidungsmatrix

Das folgende Verhalten gilt für .NET 6+, sofern nicht anders angegeben; `Parallel.ForEachAsync` existiert vor .NET 6 nicht.

| Fähigkeit                           | `Parallel.ForEach`            | `Parallel.ForEachAsync`                       | `Task.WhenAll`                       |
| ----------------------------------- | ----------------------------- | --------------------------------------------- | ------------------------------------ |
| Am besten für                       | CPU-lastige Arbeit            | asynchrone E/A pro Element                     | eine feste Menge async-Operationen   |
| Body-Delegate                       | `Action<T>` (synchron)        | `Func<T, CancellationToken, ValueTask>`       | Sie erstellen die Tasks              |
| Blockiert den aufrufenden Thread    | ja                            | nein (gibt `Task` zurück)                     | nein (gibt `Task` zurück)            |
| Eingebaute Parallelitätsgrenze      | ja (`MaxDegreeOfParallelism`) | ja (`MaxDegreeOfParallelism`)                 | nein -- alle Tasks gleichzeitig      |
| Standard-Parallelitätsgrad          | vom Scheduler verwaltet (`-1`) | `Environment.ProcessorCount`                 | unbegrenzt                           |
| Gibt Ergebnisse zurück              | nein                          | nein (gibt `Task` zurück, nicht `Task<T[]>`)  | ja (`Task<TResult[]>`, geordnet)     |
| Akzeptiert `IAsyncEnumerable<T>`    | nein                          | ja                                            | n/v                                  |
| Abbruch                             | `ParallelOptions`             | `ParallelOptions` + an den Body übergebenes Token | brechen Sie die zugrunde liegenden Tasks selbst ab |
| Bei der ersten Ausnahme             | startet keine Iterationen mehr| bricht das Token ab, plant keine neuen Elemente | lässt jede Task bis zum Ende laufen |
| Ausnahmedarstellung                 | `AggregateException`          | `AggregateException` (await entpackt zur ersten) | `AggregateException` (await entpackt) |
| Erstmals ausgeliefert               | .NET Framework 4.0            | .NET 6                                         | .NET Framework 4.5                   |

Die Zeilen, die die meisten realen Fälle entscheiden, sind "Body-Delegate" und "eingebaute Parallelitätsgrenze". Wenn Ihre Arbeit pro Element `async` ist, ist `Parallel.ForEach` bereits falsch. Wenn Sie die Parallelität begrenzen müssen, ist `Task.WhenAll` bereits falsch.

## Wann Sie Parallel.ForEach wählen sollten

Greifen Sie zu `Parallel.ForEach`, wenn die Arbeit pro Element synchron und CPU-lastig ist und die Sammlung bereits im Speicher materialisiert ist.

- **Ein großes Array oder eine große Liste im Speicher transformieren.** 50.000 Bilder skalieren, Prüfsummen berechnen, Zeilen parsen. Die Arbeit hält einen Kern beschäftigt, und das Partitionieren der Quelle auf die Kerne ist genau das, wofür `Parallel.ForEach` gebaut ist. Setzen Sie `MaxDegreeOfParallelism`, wenn Sie Spielraum für andere Arbeit lassen möchten.
- **Peinlich paralleles Zahlenknacken.** Eine Monte-Carlo-Simulation, ein Filter pro Pixel, ein Stapel unabhängiger Matrixoperationen. Kein gemeinsamer Zustand, keine E/A, nur CPU.
- **Sie möchten, dass der aufrufende Thread wartet.** `Parallel.ForEach` ist von Natur aus synchron. In einem Konsolen-Tool oder einem Hintergrund-Job, in dem Blockieren in Ordnung ist, ist diese Einfachheit ein Vorteil.

```csharp
// .NET 11, C# 14 -- CPU-bound work over an in-memory array.
// Parallel.ForEach partitions across cores and blocks until done.
var files = Directory.GetFiles(@"C:\data", "*.bin");
var hashes = new ConcurrentDictionary<string, string>();

Parallel.ForEach(
    files,
    new ParallelOptions { MaxDegreeOfParallelism = Environment.ProcessorCount },
    file =>
    {
        using var stream = File.OpenRead(file);
        byte[] hash = SHA256.HashData(stream);   // CPU + sync I/O, no await
        hashes[file] = Convert.ToHexString(hash);
    });
```

Die harte Regel: Wenn der Body irgendetwas mit `await` aufrufen will, greifen Sie nicht zu `Parallel.ForEach`. Manche umgehen das synchrone `Action<T>`, indem sie `SomeAsyncCall().Result` oder `.GetAwaiter().GetResult()` in den Body schreiben. Das blockiert einen Thread des Thread-Pools für die gesamte Dauer der E/A, und da `Parallel.ForEach` bereits Pool-Threads zum Ausführen von Iterationen verbraucht, können Sie unter Last einen Deadlock auslösen oder den Pool aushungern. Dieses Antipattern ist der häufigste Grund, warum `Parallel.ForEachAsync` existiert.

## Wann Sie Parallel.ForEachAsync wählen sollten

`Parallel.ForEachAsync` ist die Antwort auf "Ich habe viele Elemente und jedes ruft etwas Asynchrones auf, und ich möchte nicht zehntausend Verbindungen auf einmal öffnen".

- **Eine HTTP-API für jedes von vielen Elementen aufrufen.** 8.000 Datensätze aus einem REST-Endpunkt anreichern, wobei das gleichzeitige Absetzen aller 8.000 Anfragen Sie ratenbegrenzen oder die Sockets erschöpfen würde. Setzen Sie `MaxDegreeOfParallelism = 20`, und es hält 20 Anfragen in Bearbeitung und startet die nächste, sobald jede fertig ist.
- **Arbeit pro Element gegen Datenbank oder Queue mit einer Obergrenze.** Ein Verbindungspool hat eine endliche Größe. `Parallel.ForEachAsync` erlaubt es, den Parallelitätsgrad an den Pool anzupassen, damit Sie nicht beim Warten auf Verbindungen blockieren.
- **Eine Streaming-Quelle.** Es akzeptiert `IAsyncEnumerable<T>`, sodass Sie Elemente verarbeiten können, sobald sie aus einer paginierten API oder einem Channel eintreffen, ohne die gesamte Sequenz vorher zu puffern.

```csharp
// .NET 11, C# 14 -- async I/O per item, capped at 20 concurrent calls.
var ids = await db.Products.Select(p => p.Id).ToListAsync(ct);
var client = httpClientFactory.CreateClient("pricing");

await Parallel.ForEachAsync(
    ids,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 20,
        CancellationToken = ct
    },
    async (id, token) =>
    {
        var price = await client.GetFromJsonAsync<Price>($"/price/{id}", token);
        await SavePriceAsync(id, price, token);   // never blocks a pool thread
    });
```

Zwei Details, die zählen. Erstens erhält der Body ein `CancellationToken` als zweiten Parameter: Übergeben Sie es an jeden asynchronen Aufruf darin, nicht das äußere `ct`, denn `Parallel.ForEachAsync` bricht dieses innere Token ab, wenn eine Iteration fehlschlägt, damit der Rest früh aussteigen kann. Zweitens ist das Standard-`MaxDegreeOfParallelism` gleich `Environment.ProcessorCount`, was auf CPU-Arbeit abgestimmt ist, nicht auf E/A. Für E/A-lastige Aufrufe sollten Sie es fast immer höher als die Kernanzahl setzen, denn die Threads warten die meiste Zeit auf das Netzwerk, statt zu rechnen. Wenn Sie feinere Kontrolle als eine einzelne ganze Zahl als Limit brauchen, gibt Ihnen ein [auf SemaphoreSlim basierendes Gate](/de/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) in Kombination mit `Task.WhenAll` dieselbe Drosselung mit mehr Spielraum, das Limit pro Aufruf zu variieren.

## Wann Sie Task.WhenAll wählen sollten

`Task.WhenAll` ist für eine bekannte, meist kleine Menge asynchroner Operationen, die Sie nebenläufig ausführen möchten und deren Ergebnisse Sie zurückbenötigen.

- **Ein festes Fan-out.** Das Profil eines Benutzers, seine Bestellungen und seine Benachrichtigungen parallel laden: drei unabhängige Awaits, die sich überlappen sollten. Starten Sie alle drei, `await Task.WhenAll`, fertig. Das ist die alltägliche Verwendung und die richtige.
- **Sie brauchen die Ergebnisse, in Reihenfolge.** Die generische Überladung gibt `Task<TResult[]>` zurück, und das Array bewahrt die Eingabereihenfolge unabhängig von der Abschlussreihenfolge. `Parallel.ForEachAsync` gibt eine einfache `Task` ohne Ergebnisse zurück; wenn Sie also ein Ergebnis pro Element benötigen, ist `WhenAll` (oder das Sammeln in einer thread-sicheren Struktur) der Weg.
- **Die Anzahl ist begrenzt und klein.** Ein Dutzend Aufrufe, nicht zehntausend. Da `WhenAll` keinerlei Drosselung vornimmt, entspricht die Anzahl nebenläufiger Operationen der Anzahl der von Ihnen gestarteten Tasks.

```csharp
// .NET 11, C# 14 -- a small, fixed fan-out; results returned in order.
Task<Profile> profile = LoadProfileAsync(userId, ct);
Task<Order[]> orders = LoadOrdersAsync(userId, ct);
Task<Alert[]> alerts = LoadAlertsAsync(userId, ct);

await Task.WhenAll(profile, orders, alerts);

// Each task is complete here; .Result no longer blocks.
var dashboard = new Dashboard(profile.Result, orders.Result, alerts.Result);
```

Die Falle bei `Task.WhenAll` ist, es für eine unbegrenzte Liste zu verwenden. `Task.WhenAll(ids.Select(id => CallApiAsync(id)))` über 10.000 IDs startet alle 10.000 Aufrufe in dem Moment, in dem das LINQ aufgezählt wird, denn `Select` materialisiert die Tasks und jede Task startet bei ihrer Erstellung. Das ist ein Denial-of-Service-Angriff gegen Ihren eigenen nachgelagerten Dienst. Sobald die Liste groß oder unbegrenzt ist, wollen Sie stattdessen `Parallel.ForEachAsync` (oder ein `SemaphoreSlim`-Gate).

## Das Benchmark: 500 simulierte E/A-Aufrufe

Rohe Geschwindigkeit ist hier eine irreführende Achse, denn die schnellste Option ist meist die gefährlichste. Der ehrliche Vergleich ist Geschwindigkeit gegen maximale Nebenläufigkeit. Jedes "Element" unten wartet auf `Task.Delay(20)`, um einen 20-ms-Netzwerkaufruf darzustellen, ausgeführt über 500 Elemente.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x, dotnet run -c Release
// Each item simulates a 20 ms I/O call.
[MemoryDiagnoser]
public class FanOutBench
{
    private readonly int[] _items = Enumerable.Range(0, 500).ToArray();
    private static Task IoAsync(CancellationToken ct = default) => Task.Delay(20, ct);

    [Benchmark]
    public Task WhenAll_Unbounded() =>
        Task.WhenAll(_items.Select(_ => IoAsync()));

    [Benchmark]
    public Task ForEachAsync_DefaultDop() =>
        Parallel.ForEachAsync(_items, async (_, ct) => await IoAsync(ct));

    [Benchmark]
    public Task ForEachAsync_Dop50() =>
        Parallel.ForEachAsync(
            _items,
            new ParallelOptions { MaxDegreeOfParallelism = 50 },
            async (_, ct) => await IoAsync(ct));
}
```

Repräsentative Ergebnisse auf einem 16-Kern-Ryzen 7 / Windows 11 / .NET 11, mit der von Hand aus der Konfiguration ergänzten Spalte für maximale Nebenläufigkeit:

| Methode                    | Mittel  | Max. nebenläufige Ops | Hinweise                           |
| -------------------------- | ------- | --------------------- | ---------------------------------- |
| `WhenAll_Unbounded`        | ~24 ms  | 500                   | am schnellsten, aber 500 offene Verbindungen |
| `ForEachAsync_Dop50`       | ~210 ms | 50                    | 10 Stapel zu je 50                 |
| `ForEachAsync_DefaultDop`  | ~640 ms | 16 (`ProcessorCount`) | Standardobergrenze ist die CPU-Zahl, niedrig für E/A |

`WhenAll` ist hier etwa 25x schneller als das Standard-`ForEachAsync`, und genau das ist der Punkt: Es erreicht diese Geschwindigkeit, indem es 500 Verbindungen auf einmal öffnet. Wenn Ihr nachgelagertes System das verkraftet, gut. Wenn es eine Drittanbieter-API mit einem Ratenlimit ist, ist der "langsame" gedrosselte Lauf derjenige, der Ihnen kein 429 oder keine `SocketException` einbringt. Das Standard-`Parallel.ForEachAsync` ist das langsamste, weil sein Standard-Parallelitätsgrad `Environment.ProcessorCount` ist, abgestimmt auf CPU-Arbeit; für E/A erhöhen Sie ihn bewusst, wie `Dop50` zeigt. Die Erkenntnis ist nicht "WhenAll gewinnt", sondern "wählen Sie die Nebenläufigkeit, die Sie sich leisten können, und dann die API, die sie durchsetzt".

## Die Stolpersteine, die für Sie entscheiden

Einige Einschränkungen überstimmen die Präferenz vollständig.

**Asynchroner Body bedeutet nicht `Parallel.ForEach`.** Sein Body ist `Action<T>`. Es gibt keine asynchrone Überladung. Das Blockieren darin mit `.Result` oder `.GetAwaiter().GetResult()` bindet pro Iteration einen Pool-Thread und lädt zum Aushungern ein. Wenn die Arbeit mit await wartet, sind Sie bei `Parallel.ForEachAsync` oder `Task.WhenAll`. Siehe [async void vs async Task](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) dafür, warum ein `async`-Lambda stillschweigend zu `async void` wird, wenn es einem `Action<T>` zugewiesen wird, was Ausnahmen verschluckt und die Schleife völlig zunichtemacht.

**Unbegrenzte Liste bedeutet nicht `Task.WhenAll`.** `WhenAll` hat keine Drosselung. Über eine große oder unbekannte Anzahl von Elementen startet es alles auf einmal. Wenn Sie nicht garantieren können, dass die Anzahl klein ist, verwenden Sie `Parallel.ForEachAsync` mit einem `MaxDegreeOfParallelism`.

**Mehrere Fehler zeigen sich unterschiedlich.** Alle drei sammeln Ausnahmen in einer `AggregateException`, aber wie Sie sie beobachten, unterscheidet sich. `Parallel.ForEach` (synchron) wirft die `AggregateException` direkt, sodass ein `catch (AggregateException ae)` jede innere Ausnahme sieht. Bei `Parallel.ForEachAsync` und `Task.WhenAll` verwenden Sie `await`, und `await` entpackt nur die *erste* Ausnahme; um alle zu sehen, prüfen Sie die Eigenschaft `.Exception` der fehlgeschlagenen Task. Der tiefere Unterschied ist das Timing: `Task.WhenAll` lässt jede Task bis zum Ende laufen, selbst nachdem eine fehlschlägt, sodass Sie Fehler von allen erhalten, während `Parallel.ForEachAsync` sein internes Token beim ersten Fehler abbricht und keine neuen Iterationen mehr plant, also kurzschließt. Wenn "alles versuchen, alle Fehler melden" die Anforderung ist, deutet das auf `WhenAll`; wenn "stoppen, sobald einer fehlschlägt" die Anforderung ist, deutet das auf `ForEachAsync`.

**Vor .NET 6 bedeutet kein `Parallel.ForEachAsync`.** Wenn Sie auf .NET Framework oder .NET Core 3.1 festsitzen, existiert die API nicht. Der idiomatische Ersatz ist ein `SemaphoreSlim`-Gate um `Task.WhenAll`, oder für eine Producer/Consumer-Form, [ein Channel statt BlockingCollection](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/).

Noch ein übergreifender Hinweis: Wenn eines davon asynchrone Arbeit ausführt, sollte der Abbruch durchfließen. `Parallel.ForEachAsync` übergibt Ihrem Body ein Token; `Task.WhenAll` bricht nur ab, wenn die von Ihnen erstellten Tasks ein Token berücksichtigen. Das korrekt zu verdrahten ist ein eigenes Thema, behandelt in [wie man eine lang laufende Task ohne Deadlocks abbricht](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

## Die Empfehlung, wiederholt

Entscheiden Sie nach der Form der Arbeit. CPU-lastig über eine Sammlung im Speicher: `Parallel.ForEach`, mit `MaxDegreeOfParallelism`, wenn Sie Kerne frei lassen möchten. Asynchrone E/A über viele Elemente, bei denen Sie die Nebenläufigkeit begrenzen müssen: `Parallel.ForEachAsync`, und denken Sie daran, `MaxDegreeOfParallelism` für E/A über die Kernanzahl anzuheben und das Token des Bodys an jeden inneren Aufruf zu übergeben. Ein kleines, festes Fan-out, bei dem Sie alles in Bearbeitung haben und die Ergebnisse benötigen: `Task.WhenAll`, aber niemals über eine unbegrenzte Liste. Die kürzeste korrekte Fassung: CPU und Daten bedeutet `Parallel.ForEach`; asynchrone E/A im großen Maßstab bedeutet `Parallel.ForEachAsync`; eine bekannte Handvoll Awaits bedeutet `Task.WhenAll`.

## Verwandt

- [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/de/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) behandelt die tiefer liegenden Primitiven, auf denen diese höheren APIs aufbauen.
- [async void vs async Task in C#: wann welches korrekt ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) erklärt die `async void`-Falle, die zuschnappt, wenn Sie ein asynchrones Lambda an `Parallel.ForEach` übergeben.
- [Wie man eine lang laufende Task in C# ohne Deadlocks abbricht](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) ist die Abbruch-Hälfte aller drei.
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/de/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) zeigt das SemaphoreSlim-Gate, das `Task.WhenAll` drosselt, wenn Sie mehr Kontrolle brauchen, als `Parallel.ForEachAsync` bietet.
- [Wie man Channels statt BlockingCollection in C# verwendet](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) ist die Producer/Consumer-Alternative, wenn die Arbeit eine Pipeline ist und kein flaches Fan-out.

## Quellen

- [Referenz der Methode Parallel.ForEachAsync (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreachasync)
- [Referenz der Methode Task.WhenAll (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.whenall)
- [Referenz der Methode Parallel.ForEach (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreach)
- [ParallelOptions.MaxDegreeOfParallelism (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.paralleloptions.maxdegreeofparallelism)
- [Parallel.ForEachAsync and Exceptions (Jeremy Bytes)](https://jeremybytes.blogspot.com/2024/02/parallelforeachasync-and-exceptions.html)
