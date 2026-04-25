---
title: "Channels statt BlockingCollection in C# verwenden"
description: "System.Threading.Channels ist der async-fähige Ersatz für BlockingCollection in .NET 11. Diese Anleitung zeigt die Migration, die Wahl zwischen begrenzt und unbegrenzt sowie den Umgang mit Backpressure, Cancellation und sauberem Shutdown ohne Deadlocks."
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
  - "async"
lang: "de"
translationOf: "2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

Wenn Sie eine `BlockingCollection<T>` in einer .NET-Anwendung haben, die vor .NET Core 3.0 geschrieben wurde, ist `System.Threading.Channels` der moderne Ersatz. Ersetzen Sie `new BlockingCollection<T>(capacity)` durch `Channel.CreateBounded<T>(capacity)`, ersetzen Sie `Add` / `Take` durch `await WriteAsync` / `await ReadAsync`, und rufen Sie `channel.Writer.Complete()` statt `CompleteAdding()` auf. Konsumenten iterieren mit `await foreach (var item in channel.Reader.ReadAllAsync(ct))` statt mit `foreach (var item in collection.GetConsumingEnumerable(ct))`. Alles bleibt thread-sicher, kein Thread wird je beim Warten auf Items blockiert, und Backpressure funktioniert über `await` statt durch das Parken eines Worker-Threads.

Diese Anleitung zielt auf .NET 11 (Preview 3) und C# 14, aber `System.Threading.Channels` ist seit .NET Core 3.0 eine stabile, mitgelieferte API und über das [NuGet-Paket `System.Threading.Channels`](https://www.nuget.org/packages/System.Threading.Channels) auch unter .NET Standard 2.0 verfügbar. Nichts hier ist Preview-spezifisch.

## Warum BlockingCollection nicht mehr passt

`BlockingCollection<T>` kam mit .NET Framework 4.0 im Jahr 2010. Ihr Design ging von einer Welt aus, in der ein Thread pro Konsument günstig war und in der async/await nicht existierte. `Take()` parkt den aufrufenden Thread an einer Kernel-Synchronisationsprimitive, bis ein Item verfügbar ist; `Add()` macht dasselbe, wenn die begrenzte Kapazität voll ist. In einer Konsolenanwendung, die 10 Items pro Sekunde verarbeitet, ist das in Ordnung. In einem ASP.NET Core-Endpoint, einem Worker-Service oder irgendeinem Code, der unter `ThreadPool`-Druck läuft, nimmt jeder blockierte Konsument einen Thread aus dem Verkehr. Zwanzig Konsumenten, die in `Take()` blockieren, sind zwanzig Threads, die die Runtime nicht für andere Dinge nutzen kann, und die Hill-Climbing-Heuristik des Thread-Pools reagiert mit dem Erzeugen weiterer Threads, die selbst teuer sind (etwa 1 MB Stack pro Thread unter Windows in der Standardkonfiguration).

`System.Threading.Channels` wurde in .NET Core 3.0 speziell hinzugefügt, um diese Kosten zu beseitigen. Ein Konsument, der auf `ReadAsync` wartet, hält überhaupt keinen Thread fest: Die Continuation wird erst dann auf den Thread-Pool eingereiht, wenn tatsächlich ein Item geschrieben wird. Das ist dasselbe Async-Zustandsmaschinen-Muster, das `Task` und `ValueTask` antreibt, und es ist der Grund, warum ein einzelner ASP.NET Core-Prozess Zehntausende gleichzeitiger Channel-Konsumenten beherbergen kann, ohne den Thread-Pool zu erschöpfen. Die [offizielle Einführung in Channels](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/) im Microsoft .NET Blog gibt die explizite Empfehlung: Verwenden Sie Channels für jedes neue Producer-Consumer-Muster, das I/O berührt, und behalten Sie `BlockingCollection<T>` für synchrone, CPU-gebundene Worker-Szenarien vor, in denen das Blockieren eines Threads tatsächlich akzeptabel ist.

Es gibt auch einen messbaren Throughput-Unterschied. Microsofts eigene Benchmarks und mehrere unabhängige Vergleiche (siehe Michael Shpilts [Performance-Showdown von Producer/Consumer-Implementierungen](https://michaelscodingspot.com/performance-of-producer-consumer/)) sehen `Channel<T>` bei etwa dem 4-fachen Throughput von `BlockingCollection<T>` für typische Nachrichtengrößen, weil der Channel im Fast Path lock-freie `Interlocked`-Operationen nutzt und die Kernel-Übergänge vermeidet, die `BlockingCollection` erzwingt.

## Eine minimale Reproduktion des BlockingCollection-Musters

Hier das kanonische `BlockingCollection<T>`-Setup, dem die meiste Legacy-Code folgt. Es nutzt eine begrenzte Kapazität (damit Produzenten drosseln, wenn Konsumenten zurückfallen), ein `CancellationToken` und `CompleteAdding`, damit Konsumenten sauber beenden.

```csharp
// .NET 11, C# 14 -- legacy pattern, do not write new code like this
using System.Collections.Concurrent;

var queue = new BlockingCollection<int>(boundedCapacity: 100);
using var cts = new CancellationTokenSource();

var producer = Task.Run(() =>
{
    for (int i = 0; i < 10_000; i++)
        queue.Add(i, cts.Token);

    queue.CompleteAdding();
});

var consumer = Task.Run(() =>
{
    foreach (int item in queue.GetConsumingEnumerable(cts.Token))
        Process(item);
});

await Task.WhenAll(producer, consumer);

static void Process(int item) { /* work */ }
```

Zwei Threads bleiben für die gesamte Lebensdauer dieser Pipeline gebunden. Wenn `Process` I/O macht, sitzt der Konsumenten-Thread während jeder `await`-äquivalenten Wartezeit untätig herum, und der Channel kann besser. Wenn Sie auf vier Produzenten und acht Konsumenten skalieren, sind das zwölf belegte Threads.

## Das Channels-Äquivalent

Hier dieselbe Pipeline mit `System.Threading.Channels`. Die Form des Codes ist ähnlich; der Unterschied ist, dass kein Thread je blockiert wird.

```csharp
// .NET 11, C# 14 -- modern replacement
using System.Threading.Channels;

var channel = Channel.CreateBounded<int>(new BoundedChannelOptions(100)
{
    FullMode = BoundedChannelFullMode.Wait,
    SingleReader = false,
    SingleWriter = false
});

using var cts = new CancellationTokenSource();

var producer = Task.Run(async () =>
{
    for (int i = 0; i < 10_000; i++)
        await channel.Writer.WriteAsync(i, cts.Token);

    channel.Writer.Complete();
});

var consumer = Task.Run(async () =>
{
    await foreach (int item in channel.Reader.ReadAllAsync(cts.Token))
        await ProcessAsync(item);
});

await Task.WhenAll(producer, consumer);

static ValueTask ProcessAsync(int item) => ValueTask.CompletedTask;
```

Drei Unterschiede sind erwähnenswert. `WriteAsync` gibt einen `ValueTask` zurück, anstatt zu blockieren, wenn der Puffer voll ist: Die Continuation des Produzenten setzt erst dann fort, wenn Platz frei ist. `ReadAllAsync` liefert ein `IAsyncEnumerable<T>`, das vollständig ist, sobald `Writer.Complete()` aufgerufen wird, und spiegelt damit exakt das Verhalten von `GetConsumingEnumerable` nach `CompleteAdding`. Und `Channel.CreateBounded` verlangt, dass Sie `FullMode` explizit angeben, was eine Entscheidung erzwingt, die `BlockingCollection` stillschweigend für Sie traf (sie blockierte immer).

## Begrenzt vs unbegrenzt: bewusst wählen

`Channel.CreateBounded(capacity)` hat eine harte Obergrenze für gepufferte Items und übt Backpressure auf Produzenten aus, wenn der Puffer voll ist. `Channel.CreateUnbounded()` hat keine Obergrenze, sodass Schreiboperationen synchron abschließen und nie warten. Unbegrenzte Channels sind verlockend, weil sie in einem Mikrobenchmark schneller wirken, aber sie sind ein Memory-Leak, das nur darauf wartet zu passieren: Wenn Ihr Konsument in einer Pipeline mit hohem Durchsatz auch nur ein paar Sekunden zurückfällt, puffert der Channel fröhlich Gigabytes an Arbeitselementen, bevor jemand etwas merkt. Verwenden Sie standardmäßig `CreateBounded`. Greifen Sie nur dann zu `CreateUnbounded`, wenn Sie nachweisen können, dass der Konsument schneller ist als der Produzent, oder wenn die Rate des Produzenten ohnehin durch etwas anderes begrenzt ist (zum Beispiel ein Webhook-Empfänger, dessen Durchsatz vom Sender vorgegeben wird).

`BoundedChannelFullMode` steuert, was passiert, wenn ein begrenzter Channel voll ist und ein Produzent `WriteAsync` aufruft. Die vier Optionen sind:

- `Wait` (Standard): Der `ValueTask` des Produzenten schließt erst ab, wenn Platz verfügbar ist. Dies ist das direkte Äquivalent zum blockierenden Verhalten von `BlockingCollection.Add` und der richtige Standard.
- `DropOldest`: Das älteste Item im Puffer wird entfernt, um Platz zu schaffen. Verwenden Sie es für Telemetrie, bei der veraltete Daten schlechter sind als fehlende.
- `DropNewest`: Das neueste Item bereits im Puffer wird entfernt. Selten nützlich.
- `DropWrite`: Das neue Item wird stillschweigend verworfen. Verwenden Sie es für Fire-and-forget-Logging, bei dem das Verwerfen des neuen Schreibvorgangs günstiger ist als das Backpressuren des Produzenten.

Wenn Sie `DropOldest` / `DropNewest` / `DropWrite` wählen, schließt `WriteAsync` immer synchron ab, sodass der Produzent nie gedrosselt wird. Diese Modi mit der Erwartung "Ich will Backpressure" zu mischen, ist eine häufige Fehlerquelle. `Wait` ist der einzige Modus, der tatsächlich Backpressure erzeugt.

## Eine bestehende BlockingCollection-Pipeline migrieren

Die meiste BlockingCollection-Code lässt sich mechanisch übersetzen. Die Übersetzungstabelle:

- `new BlockingCollection<T>(capacity)` -> `Channel.CreateBounded<T>(new BoundedChannelOptions(capacity) { FullMode = BoundedChannelFullMode.Wait })`
- `new BlockingCollection<T>()` (unbegrenzt) -> `Channel.CreateUnbounded<T>()`
- `collection.Add(item, token)` -> `await channel.Writer.WriteAsync(item, token)`
- `collection.TryAdd(item)` -> `channel.Writer.TryWrite(item)` (gibt `bool` zurück, blockiert nie)
- `collection.Take(token)` -> `await channel.Reader.ReadAsync(token)`
- `collection.TryTake(out var item)` -> `channel.Reader.TryRead(out var item)`
- `collection.GetConsumingEnumerable(token)` -> `channel.Reader.ReadAllAsync(token)` (mit `await foreach`)
- `collection.CompleteAdding()` -> `channel.Writer.Complete()` (oder `Complete(exception)` zum Signalisieren eines Fehlers)
- `collection.IsCompleted` -> `channel.Reader.Completion.IsCompleted`
- `BlockingCollection.AddToAny / TakeFromAny` -> kein direktes Äquivalent, siehe "Stolpersteine" unten

Die nicht-blockierenden `TryWrite` und `TryRead` sind kritisch für ein bestimmtes Szenario: synchrone Codepfade, die kein `await` einführen dürfen. Sie geben `false` zurück, anstatt zu warten, und Sie können pollen oder auf einen anderen Codepfad ausweichen. Die meiste Code braucht sie nicht; bevorzugen Sie die asynchronen Formen.

Wenn Ihre Produzenten auf dem Thread-Pool laufen und Ihr Channel heiß ist, möchten Sie eventuell `SingleWriter = true` (oder `SingleReader = true`) setzen. Channels verwenden eine andere, schnellere interne Implementierung, wenn sie wissen, dass es genau einen Produzenten oder Konsumenten gibt. Die Prüfung erfolgt nur opportunistisch: Die Runtime erzwingt sie nicht, also setzen Sie diese Flag ehrlich. Wenn Sie `SingleWriter = true` setzen und dann versehentlich zwei Produzenten haben, verhält sich `WriteAsync` auf subtile Weise falsch (verlorene Items, kaputte Completion).

## Backpressure, Cancellation und sauberer Shutdown

Backpressure funktioniert über den `ValueTask` von `WriteAsync`. Wenn der Puffer voll ist, ist der Task des Produzenten unvollständig, bis der Konsument ein Item liest, woraufhin ein einzelner wartender Schreiber freigegeben wird. Dies hat dieselbe Form wie ein Semaphor, aber mit einer Semantik, die an den Pufferzustand gebunden ist statt an einen separaten Zähler.

Cancellation propagiert genauso wie in jeder Async-API. Übergeben Sie ein `CancellationToken` an `WriteAsync`, `ReadAsync` und `ReadAllAsync`. Wenn das Token feuert, wirft der laufende `ValueTask` `OperationCanceledException`. Der Channel selbst wird durch das Token nicht abgebrochen: Andere Produzenten und Konsumenten, die dieses Token nicht übergeben haben, laufen normal weiter. Wenn Sie die gesamte Pipeline abbrechen wollen, rufen Sie `channel.Writer.Complete()` (oder `Complete(exception)`) auf, was allen aktuellen und zukünftigen Lesern signalisiert, dass keine weiteren Daten kommen. Siehe [eine lang laufende Task in C# ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) für das umfassendere Muster.

Sauberer Shutdown sieht in einem Worker-Service so aus:

```csharp
// .NET 11, C# 14
public class ImportWorker : BackgroundService
{
    private readonly Channel<ImportJob> _channel =
        Channel.CreateBounded<ImportJob>(new BoundedChannelOptions(500)
        {
            FullMode = BoundedChannelFullMode.Wait
        });

    public ChannelWriter<ImportJob> Writer => _channel.Writer;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var job in _channel.Reader.ReadAllAsync(stoppingToken))
                await ProcessAsync(job, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // expected on host shutdown
        }
        finally
        {
            _channel.Writer.TryComplete();
        }
    }

    private static ValueTask ProcessAsync(ImportJob job, CancellationToken ct)
        => ValueTask.CompletedTask;
}

public record ImportJob(string Id);
```

Zwei Anmerkungen. `TryComplete` (statt `Complete`) ist idempotent und kann sicher aus `finally` aufgerufen werden. Der `OperationCanceledException`-Filter schluckt die Cancellation nur, wenn sie tatsächlich vom `stoppingToken` kommt: Eine Cancellation, die durch ein anderes Token ausgelöst wurde, propagiert weiterhin, was Sie auch wollen.

Wenn Ihre Produzenten fehlschlagen können, bevorzugen Sie `channel.Writer.Complete(exception)`. Der nächste Aufruf des Konsumenten an `ReadAsync` oder `ReadAllAsync` wirft diese Exception erneut, was das Channel-Äquivalent dazu ist, dass `BlockingCollection.GetConsumingEnumerable` nach einem Aufruf von `CompleteAdding` infolge eines Fehlers wieder wirft.

## Stolpersteine, denen Sie begegnen werden

`Channel.Writer.WriteAsync` gibt `ValueTask` zurück, nicht `Task`. Wenn Sie das Ergebnis speichern und mehr als einmal awaiten, lösen Sie undefiniertes Verhalten aus: `ValueTask` ist als single-await dokumentiert. Der 99-%-Fall ist `await channel.Writer.WriteAsync(item)` inline; das ist nur dann ein Thema, wenn Sie den Rückgabewert weiterreichen.

`Reader.Completion` ist ein `Task`, der vollständig ist, wenn `Writer.Complete` aufgerufen wurde und alle Items geleert sind. Wenn Sie wissen wollen, wann der Channel vollständig leer und geschlossen ist, awaiten Sie `Reader.Completion`. Prüfen Sie nicht `Reader.Count == 0`: Diese Eigenschaft existiert, kollidiert aber mit laufenden Schreiboperationen.

`ChannelReader<T>.WaitToReadAsync` gibt nur dann `false` zurück, wenn der Channel abgeschlossen und leer ist. Das ist die richtige Primitive für handgeschriebene Konsumentenschleifen, in denen `await foreach` nicht passt, etwa weil Sie Reads in Batches gruppieren wollen:

```csharp
// .NET 11, C# 14 -- batched consumer
while (await channel.Reader.WaitToReadAsync(ct))
{
    var batch = new List<int>(capacity: 100);
    while (batch.Count < 100 && channel.Reader.TryRead(out int item))
        batch.Add(item);

    if (batch.Count > 0)
        await ProcessBatchAsync(batch, ct);
}

static ValueTask ProcessBatchAsync(IReadOnlyList<int> items, CancellationToken ct)
    => ValueTask.CompletedTask;
```

`BlockingCollection` hatte `AddToAny` und `TakeFromAny`, die über mehrere Collections operierten. Channels haben dafür kein direktes Äquivalent. Wenn Sie wirklich Fan-in über N Channels brauchen, ist das idiomatische Muster, einen Konsumenten-Task pro Quell-Channel zu starten, die alle in einen einzigen Downstream-Channel schreiben; das fügt sich sauber in das Cancellation-Modell ein und bleibt async-freundlich. Wenn Sie wirklich Fan-out brauchen (ein Produzent versorgt N Konsumenten), starten Sie N Reader-Tasks gegen denselben `Reader`: Channels sind mehrfach lesbar, solange Sie nicht `SingleReader = true` setzen.

`System.Threading.Channels` ist weder ein Serialisierungs-Channel wie Gos `chan` noch eine verteilte Messaging-Primitive. Es ist ausschließlich In-Process. Wenn Sie prozess- oder maschinenübergreifendes Messaging brauchen, verwenden Sie einen echten Message Broker (Azure Service Bus, RabbitMQ, Kafka). Channels sind das richtige Werkzeug innerhalb eines einzelnen Prozesses; sie sind das falsche Werkzeug, sobald ein Netzwerk im Spiel ist.

## Wann BlockingCollection noch vertretbar ist

Es gibt einen schmalen Fall, in dem das Beibehalten von `BlockingCollection<T>` vernünftig ist: ein synchroner, CPU-gebundener Worker-Pool innerhalb einer Konsolenanwendung oder eines Batch-Jobs, in dem Sie die Thread-Anzahl steuern und sich nicht um Thread-Pool-Druck sorgen müssen, weil es keinen Thread-Pool-Druck gibt, um den Sie sich sorgen müssten. Die [Channels-Übersicht auf Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) ist in diesem Punkt explizit. Überall sonst (ASP.NET Core, Worker-Services, jeder Code, der I/O berührt, jeder Code, der mit async-fähigen Konsumenten geteilt wird) bevorzugen Sie `System.Threading.Channels`.

## Verwandt

- [Eine lang laufende Task in C# ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [IAsyncEnumerable&lt;T&gt; mit EF Core 11 verwenden](/de/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [Eine große CSV-Datei in .NET 11 ohne Speicherüberlauf lesen](/de/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [Eine Datei aus einem ASP.NET Core-Endpoint streamen, ohne zu puffern](/de/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## Quellen

- [An Introduction to System.Threading.Channels (Microsoft .NET Blog)](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/)
- [Channels overview (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels)
- [BoundedChannelOptions class reference](https://learn.microsoft.com/en-us/dotnet/api/system.threading.channels.boundedchanneloptions)
- [Performance Showdown of Producer/Consumer Implementations in .NET (Michael Shpilt)](https://michaelscodingspot.com/performance-of-producer-consumer/)
- [System.Threading.Channels source on GitHub](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.Channels)
