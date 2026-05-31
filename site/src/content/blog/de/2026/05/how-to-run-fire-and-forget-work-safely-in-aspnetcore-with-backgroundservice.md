---
title: "Wie man Fire-and-Forget-Arbeit in ASP.NET Core mit BackgroundService sicher ausführt"
description: "Ein Aufruf von Task.Run aus einem Controller verliert Arbeit beim Herunterfahren, verschluckt Exceptions und erfasst bereits freigegebene scoped Services. Das sichere Muster ist eine begrenzte Channel-Queue, die von einem BackgroundService geleert wird, der pro Arbeitseinheit einen neuen Scope öffnet und laufende Arbeit in StopAsync abschließt."
pubDate: 2026-05-31
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "backgroundservice"
  - "async"
lang: "de"
translationOf: "2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice"
translatedBy: "claude"
translationDate: 2026-05-31
---

In dem Moment, in dem Sie möchten, dass eine HTTP-Anfrage sofort zurückkehrt, während langsamere Arbeit (eine E-Mail versenden, einen Audit-Eintrag schreiben, einen Webhook aufrufen) weiterläuft, ist der naheliegende Schritt `_ = Task.Run(() => DoTheWorkAsync())` innerhalb des Controllers. Es kompiliert, die Antwort ist schnell, und in einer Demo sieht es aus, als würde es funktionieren. In Produktion verliert es bei jeder Bereitstellung Arbeit, verschluckt jede Exception und greift auf scoped Services zu, die bereits freigegeben wurden. Der sichere Ersatz ist eine begrenzte `Channel<T>`-Queue, die als Singleton registriert und von einem einzigen `BackgroundService` geleert wird, der pro Arbeitseinheit einen frischen DI-Scope öffnet, Exceptions pro Eintrag abfängt und protokolliert und laufende Arbeit während eines kontrollierten Herunterfahrens abschließt. Diese Anleitung ist gegen .NET 11 (Preview 4 zum Zeitpunkt des Schreibens, allgemeine Verfügbarkeit für November 2026 angestrebt), `Microsoft.Extensions.Hosting` 11.0.0 und `System.Threading.Channels` aus der integrierten BCL geschrieben. Die Verträge der Queue und von `BackgroundService` sind seit .NET Core 3.1 stabil, sodass jedes Muster hier unverändert für .NET 6, 8 und 10 gilt.

## Warum `Task.Run` in einem Anfrage-Handler eine Falle ist

Der Reiz von `Task.Run` besteht darin, dass es sofort zurückkehrt und das Framework nie darauf blockiert. Genau das ist das Problem: Das Framework blockiert nie darauf, verfolgt es nie und wartet nie darauf.

Daraus folgen drei konkrete Fehler:

- **Verlorene Arbeit beim Herunterfahren.** Wenn der Host herunterfährt (eine Bereitstellung, ein Scale-in, ein abgestürzter Geschwister-Pod, der einen rollierenden Neustart auslöst), weiß er nicht, dass Ihre abgekoppelte `Task` existiert. Er nimmt keine Anfragen mehr an, wartet auf die Anfragen, die er kennt, und baut den Prozess ab. Jede noch laufende `Task.Run`-Arbeit wird mitten in der Ausführung abgebrochen. In einem stark ausgelasteten Service verwirft jede Bereitstellung stillschweigend eine Handvoll E-Mails oder Audit-Zeilen.
- **Verschluckte Exceptions.** Eine nicht beobachtete Exception in einer abgekoppelten `Task` bringt die Anwendung nicht zum Absturz und erreicht Ihre Protokollierungs-Pipeline nicht. Sie taucht, wenn überhaupt, im Finalizer-Thread als `TaskScheduler.UnobservedTaskException` lange nach dem Verschwinden der Anfrage auf. Das erste Mal, dass Sie erfahren, dass die Arbeit fehlschlägt, ist, wenn ein Kunde fragt, wo seine E-Mail geblieben ist.
- **Erfasste, freigegebene Abhängigkeiten.** Dies ist die subtile. Wenn Ihr Controller einen injizierten `DbContext` oder einen beliebigen scoped Service einschließt, ist dieser Service an den Scope der Anfrage gebunden. ASP.NET Core gibt den Anfrage-Scope in dem Moment frei, in dem die Antwort geschrieben wird. Der Körper Ihres `Task.Run`, der noch läuft, greift nun auf einen freigegebenen `DbContext` zu und wirft `ObjectDisposedException: Cannot access a disposed context instance`, oder schlimmer: Er konkurriert mit der Freigabe und beschädigt den Zustand.

Es gibt auch eine Lastdimension: Ein Controller, der bei jeder Anfrage `Task.Run` startet, konkurriert um denselben Threadpool, der Ihre Anfragen bedient, sodass eine Lastspitze zu Threadpool-Starvation wird. Wenn Sie die vollständige Aufschlüsselung möchten, wie sich `Task.Run` von den anderen Auslagerungs-Primitiven unterscheidet, behandelt der Vergleich in [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/de/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/), wann welche angemessen ist. Für Anfrage-Handler lautet die Antwort: keine davon direkt.

Fire-and-Forget ist nur dann akzeptabel, wenn der Verlust der Arbeit bei einem Neustart wirklich in Ordnung ist. Das untenstehende Muster macht die Arbeit nicht dauerhaft (dafür benötigen Sie eine externe Queue wie Azure Storage Queues oder einen datenbankgestützten Job-Speicher), aber es behebt die anderen drei Probleme und gibt der In-Memory-Arbeit ein sauberes Leeren beim Herunterfahren.

## Die Form des sicheren Musters

Microsofts eigene [Anleitung zu in die Warteschlange gestellten Hintergrundaufgaben](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) beschreibt die kanonische Struktur, und sie hat drei Teile:

1. Eine **Arbeitseintrags-Queue**, gestützt auf einen begrenzten `Channel<Func<CancellationToken, ValueTask>>`, als Singleton registriert, sodass Produzenten und der Konsument eine einzige Instanz teilen.
2. Ein einzelner **`BackgroundService`-Konsument**, der in einer Schleife läuft, jeweils einen Arbeitseintrag entnimmt, einen DI-Scope öffnet, ihn ausführt und Exceptions pro Eintrag abfängt.
3. **Produzenten** (Controller, Minimal-API-Handler, andere Services), die die Queue-Schnittstelle injizieren und ein Delegate in die Warteschlange stellen, statt es inline auszuführen.

Der Anfrage-Handler kehrt in dem Moment zurück, in dem der Arbeitseintrag in die Warteschlange gestellt wird. Die Arbeit selbst läuft auf dem Konsumenten, vollständig entkoppelt von der Lebensdauer der Anfrage. Bauen wir jedes Teil auf.

## Schritt 1: die begrenzte Queue definieren und implementieren

Die Queue stellt zwei Operationen bereit: Einreihen (von Produzenten aufgerufen) und Entnehmen (vom Konsumenten aufgerufen). Der Arbeitseintrag ist ein `Func<CancellationToken, ValueTask>`, damit der Konsument zum Ausführungszeitpunkt sein eigenes Cancellation-Token übergeben kann.

```csharp
// .NET 11, C# 14 - IBackgroundTaskQueue.cs
public interface IBackgroundTaskQueue
{
    ValueTask QueueBackgroundWorkItemAsync(Func<CancellationToken, ValueTask> workItem);

    ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken);
}
```

Die Implementierung umschließt einen begrenzten Channel. Den Channel zu begrenzen ist in einem Produktionsservice nicht optional: Eine unbegrenzte Queue unter einem Produzenten, der den Konsumenten überholt, ist ein Speicherleck mit zusätzlichen Schritten.

```csharp
// .NET 11, C# 14 - BackgroundTaskQueue.cs
using System.Threading.Channels;

public sealed class BackgroundTaskQueue : IBackgroundTaskQueue
{
    private readonly Channel<Func<CancellationToken, ValueTask>> _queue;

    public BackgroundTaskQueue(int capacity)
    {
        // BoundedChannelFullMode.Wait makes QueueBackgroundWorkItemAsync await
        // a free slot once the queue is full, applying back pressure to producers
        // instead of dropping work or growing without bound.
        var options = new BoundedChannelOptions(capacity)
        {
            FullMode = BoundedChannelFullMode.Wait
        };
        _queue = Channel.CreateBounded<Func<CancellationToken, ValueTask>>(options);
    }

    public async ValueTask QueueBackgroundWorkItemAsync(
        Func<CancellationToken, ValueTask> workItem)
    {
        ArgumentNullException.ThrowIfNull(workItem);
        await _queue.Writer.WriteAsync(workItem);
    }

    public async ValueTask<Func<CancellationToken, ValueTask>> DequeueAsync(
        CancellationToken cancellationToken)
    {
        var workItem = await _queue.Reader.ReadAsync(cancellationToken);
        return workItem;
    }
}
```

Die Wahl von `BoundedChannelFullMode` ist eine echte Designentscheidung. `Wait` (oben) wendet Back Pressure auf den Produzenten an, was für einen Anfrage-Handler bedeutet, dass der Einreihungsaufruf wartet, bis Platz ist. Wenn Sie lieber Last abwerfen, als eine Anfrage warten zu lassen, verwenden Sie `BoundedChannelFullMode.DropWrite` und prüfen den Rückgabewert von `TryWrite`. Was auch immer Sie wählen, tun Sie es bewusst. Wenn Channels für Sie neu sind, erklärt [Channels statt BlockingCollection verwenden](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) das Reader/Writer-Modell und warum `Channel<T>` die richtige asynchrone Produzenten-Konsumenten-Primitive im modernen .NET ist.

## Schritt 2: der BackgroundService, der die Queue leert

Der Konsument ist ein einzelner `BackgroundService`. Seine einzige Aufgabe ist es, jeweils einen Arbeitseintrag zu ziehen und ihn innerhalb eines try/catch auszuführen, damit ein einziger vergifteter Arbeitseintrag die Schleife nicht beenden kann.

```csharp
// .NET 11, C# 14 - QueuedHostedService.cs
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

public sealed class QueuedHostedService(
    IBackgroundTaskQueue taskQueue,
    ILogger<QueuedHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is running.");
        await BackgroundProcessing(stoppingToken);
    }

    private async Task BackgroundProcessing(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            var workItem = await taskQueue.DequeueAsync(stoppingToken);

            try
            {
                await workItem(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                // Expected during shutdown; let the loop unwind.
                break;
            }
            catch (Exception ex)
            {
                // The whole point: one failing item is logged, not lost, and the
                // loop survives to process the next item.
                logger.LogError(ex, "Error occurred executing background work item.");
            }
        }
    }

    public override async Task StopAsync(CancellationToken stoppingToken)
    {
        logger.LogInformation("Queued hosted service is stopping.");
        await base.StopAsync(stoppingToken);
    }
}
```

Das try/catch pro Eintrag ist der Unterschied zwischen diesem und `Task.Run`. Bei `Task.Run` bleibt eine Exception unbeobachtet. Hier landet jeder Fehler im `ILogger` mit einem Stack Trace, und der Konsument leert weiter. Das ist auch der Grund, warum der Arbeitseintrag ein `Func` ist, das `ValueTask` zurückgibt, statt eines `async void`-Delegates: Ein `async void`-Körper wirft ins Leere, und Sie sind wieder bei verschluckten Exceptions. Wenn die Unterscheidung zwischen `async void` und `async Task` unklar ist, legt [async void vs async Task in C#](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) genau dar, warum `async void` Event-Handlern vorbehalten ist und sonst nichts.

## Schritt 3: alles registrieren

Die Queue ist ein Singleton (eine einzige geteilte Instanz), der Konsument ist ein gehosteter Service, und Sie wählen eine Kapazität. Die Kapazität sollte widerspiegeln, wie viel Arbeit Sie gleichzeitig im Speicher halten möchten.

```csharp
// .NET 11, C# 14 - Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueuedHostedService>();
builder.Services.AddSingleton<IBackgroundTaskQueue>(_ =>
{
    // Tune to your workload. 100 means at most 100 queued items before
    // producers start waiting (with BoundedChannelFullMode.Wait).
    const int queueCapacity = 100;
    return new BackgroundTaskQueue(queueCapacity);
});

builder.Services.AddControllers();

var app = builder.Build();
app.MapControllers();
app.Run();
```

## Schritt 4: aus einem Anfrage-Handler einreihen, mit einem Scope pro Arbeitseintrag

Nun der Produzent. Ein Controller injiziert `IBackgroundTaskQueue` und reiht ein Delegate ein. Das entscheidende Detail: Das Delegate darf **keinen** scoped Service aus der Anfrage einschließen. Der Anfrage-Scope ist verschwunden, wenn die Arbeit läuft. Erfassen Sie stattdessen nur einfache Daten (eine Bestell-ID, eine Zeichenkette) und lösen Sie scoped Services aus einem frischen Scope innerhalb des Delegates mit `IServiceScopeFactory` auf.

```csharp
// .NET 11, C# 14 - OrdersController.cs
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

[ApiController]
[Route("orders")]
public sealed class OrdersController(
    IBackgroundTaskQueue queue,
    IServiceScopeFactory scopeFactory) : ControllerBase
{
    [HttpPost("{id:int}/confirm")]
    public async Task<IActionResult> Confirm(int id)
    {
        // Capture only the id - a value type, not a scoped service.
        await queue.QueueBackgroundWorkItemAsync(async token =>
        {
            // Fresh scope per work item: a clean DbContext, resolved and disposed here.
            await using var scope = scopeFactory.CreateAsyncScope();
            var processor = scope.ServiceProvider.GetRequiredService<IOrderProcessor>();
            await processor.ConfirmAsync(id, token);
        });

        // Returns immediately; the confirmation runs on the consumer.
        return Accepted();
    }
}
```

`HTTP 202 Accepted` ist hier der ehrliche Statuscode: Sie haben die Anfrage zur Verarbeitung angenommen, nicht abgeschlossen. Die Rückgabe von `200 OK` würde implizieren, dass die Arbeit erledigt ist, was nicht der Fall ist.

Die Regel eines Scopes pro Arbeitseintrag ist dieselbe Disziplin, die Sie überall benötigen, wo ein Singleton scoped Services berührt. Einen `CreateAsyncScope()` pro Arbeitseinheit zu öffnen, darin aufzulösen und ihn freizugeben, wenn die Arbeit abgeschlossen ist, wird ausführlich in [scoped Services innerhalb eines BackgroundService verwenden](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) behandelt. Der Grund, warum `await using` und `CreateAsyncScope()` wichtig sind (statt des synchronen `CreateScope()`), ist, dass der `DbContext` von EF Core `IAsyncDisposable` implementiert und werfen kann, wenn er synchron freigegeben wird.

Wenn Sie den Scope überspringen und stattdessen den `DbContext` der Anfrage direkt im Delegate einschließen, reproduzieren Sie genau den Bug mit der freigegebenen Abhängigkeit vom Anfang dieses Artikels, und häufig [den Fehler zur zweiten Operation auf der Context-Instanz](/de/2026/05/fix-second-operation-was-started-on-this-context-instance/), wenn eine spätere Anfrage einen Context wiederverwendet, den das Framework für freigegeben hält. Und wenn Sie versuchen, den scoped Service direkt in einen Singleton-Konsumenten zu injizieren, um die Dinge zu "vereinfachen", stoßen Sie beim Start auf [scoped Service kann nicht aus einem Singleton konsumiert werden](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/).

## Kontrolliertes Herunterfahren: Leeren versus Aufgeben

Hier verdient sich das Muster seinen Wert gegenüber `Task.Run`. `BackgroundService` nimmt an der Herunterfahr-Sequenz des Hosts teil. Wenn der Host stoppt, signalisiert er `stoppingToken`, und der Host wartet bis zum Herunterfahr-Timeout (standardmäßig 30 Sekunden), bis `StopAsync` zurückkehrt.

Bei zwei Verhaltensweisen lohnt es sich, bewusst vorzugehen:

**Annahme stoppen, aktuellen Eintrag abschließen.** Mit der obigen Schleife wirft `DequeueAsync(stoppingToken)` `OperationCanceledException`, sobald das Token ausgelöst wird, die Schleife bricht ab, und jeder gerade ausgeführte Arbeitseintrag wird abgeschlossen (weil wir `await workItem(stoppingToken)` ausführen, bevor wir die Schleife erneut durchlaufen). Einträge, die noch im Channel liegen, werden aufgegeben. Für In-Memory-Fire-and-Forget ist das der akzeptierte Kompromiss.

**Der laufenden Arbeit genug Zeit geben.** Wenn Ihre Arbeitseinträge länger als ein paar Sekunden laufen können, erhöhen Sie das Herunterfahr-Timeout, damit der Host keinen halb fertigen Eintrag abbricht:

```csharp
// .NET 11, C# 14 - Program.cs
builder.Services.Configure<HostOptions>(options =>
{
    options.ShutdownTimeout = TimeSpan.FromSeconds(60);
});
```

Ein Produzent, der die Arbeit an die Lebensdauer der Anwendung statt an eine Anfrage binden muss, kann `IHostApplicationLifetime` entgegennehmen und gegen `ApplicationStopping` einreihen, aber für anfrageinitiierte Arbeit ist das `stoppingToken` des Konsumenten das richtige Signal. Was auch immer Sie tun, leiten Sie das Token bis zum Ende Ihres Arbeitseintrags durch. Ein Arbeitseintrag, der das Token ignoriert und blockiert, hält das gesamte Herunterfahren für das volle Timeout als Geisel. Für Arbeit, die wirklich nicht kooperativ abgebrochen werden kann, behandelt [eine lang laufende Task ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) die Optionen.

## Einträge parallel verarbeiten, ohne einen Scope zu teilen

Die Einzelkonsumenten-Schleife verarbeitet einen Eintrag nach dem anderen. Wenn Ihre Arbeitseinträge unabhängig sind und Sie Durchsatz möchten, können Sie mehrere gleichzeitig ausführen, aber jeder gleichzeitige Eintrag muss seinen eigenen Scope erhalten, weil ein `DbContext` und ein DI-Scope nicht thread-sicher sind. Begrenzen Sie die Nebenläufigkeit mit einem `SemaphoreSlim`, damit ein Schwall von Einreihungen den Threadpool nicht sättigen kann:

```csharp
// .NET 11, C# 14 - inside BackgroundProcessing
private readonly SemaphoreSlim _concurrency = new(initialCount: 4);

private async Task BackgroundProcessing(CancellationToken stoppingToken)
{
    while (!stoppingToken.IsCancellationRequested)
    {
        var workItem = await taskQueue.DequeueAsync(stoppingToken);
        await _concurrency.WaitAsync(stoppingToken);

        // Fire each item on its own task; the semaphore caps concurrency at 4.
        _ = Task.Run(async () =>
        {
            try
            {
                await workItem(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Error executing background work item.");
            }
            finally
            {
                _concurrency.Release();
            }
        }, stoppingToken);
    }
}
```

Beachten Sie, dass das `Task.Run` hier auf eine Weise akzeptabel ist, wie es im Controller nicht war: Es befindet sich innerhalb eines verfolgten `BackgroundService`, jede Exception wird abgefangen und protokolliert, die Nebenläufigkeit ist begrenzt, und jeder Arbeitseintrag erstellt bereits intern seinen eigenen Scope. Das, was `Task.Run` in einem Anfrage-Handler gefährlich machte (keine Verfolgung, keine Exception-Behandlung, erfasster Anfrage-Scope), fehlt hier. Der Kompromiss ist, dass die parallele Verarbeitung die Herunterfahr-Geschichte verkompliziert, weil laufende Tasks nicht mehr von der Schleife abgewartet werden. Wenn Sie sowohl Parallelität als auch ein sauberes Leeren benötigen, verfolgen Sie die ausstehenden Tasks in einer `List<Task>` und führen `await Task.WhenAll` darauf in `StopAsync` aus.

## Wann eine Channel-Queue nicht ausreicht

Dieses Muster hält alles im Prozessspeicher. Das ist seine Stärke (null externe Infrastruktur) und seine Grenze. Greifen Sie zu etwas Schwererem, wenn:

- **Die Arbeit einen Neustart überleben muss.** Wenn der Verlust der eingereihten Arbeit bei einer Bereitstellung inakzeptabel ist, benötigen Sie eine Dauerhaftigkeit, die der Channel nicht bieten kann. Persistieren Sie den Job in einer Datenbanktabelle oder schieben Sie ihn zu Azure Storage Queues / Amazon SQS, und lassen Sie den `BackgroundService` (oder einen separaten Worker-Prozess) von dort ziehen. Die Einreih-/Konsum-Form bleibt identisch; nur der Backing Store ändert sich.
- **Sie mehrere Instanzen ausführen und Exactly-once benötigen.** Eine In-Memory-Queue ist pro Instanz. Drei Pods bedeuten drei unabhängige Queues. Eine geteilte dauerhafte Queue mit einem Sichtbarkeits-Timeout-Lease ist der Weg zur Koordination.
- **Sie Wiederholungen, Planung oder Dashboards benötigen.** An diesem Punkt verdient sich eine Bibliothek wie Hangfire oder eine gehostete Job-Plattform ihre Komplexität. Bauen Sie keinen Job-Scheduler auf einem Channel nach.

Für lang lebende Worker, die Sie in Produktion behalten, kombinieren Sie die Queue mit Observability, damit ein hängender oder still scheiternder Konsument auffällt, bevor Benutzer es bemerken; der Ansatz in [Hintergrund-Jobs ohne Hangfire überwachen](/de/2026/01/monitor-background-jobs-in-net-9-and-net-10-without-hangfire-health-metrics-alerts/) gilt direkt für diesen Konsumenten.

Das mentale Modell, das all dies korrekt hält: Die Aufgabe des Anfrage-Handlers ist es, Arbeit *anzunehmen* und zurückzukehren, der Singleton-Konsument *besitzt die Schleife und die Stornierung*, und jeder Arbeitseintrag *besitzt einen frischen Scope für seinen eigenen Zustand*. In dem Moment, in dem Sie diese Verantwortlichkeiten zusammenfallen lassen (die Arbeit inline ausführen, den Anfrage-Scope erfassen oder eine nicht verfolgte `Task` abkoppeln), kehrt einer der drei Fehler vom Anfang dieses Artikels zurück.

## Quellen

- Microsoft Learn, [Background tasks with hosted services in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) (aktualisiert 2026-05-05), das kanonische Muster für in die Warteschlange gestellte Hintergrundaufgaben, auf dem dieser Beitrag aufbaut.
- Microsoft Learn, [System.Threading.Channels](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) für `BoundedChannelOptions` und `BoundedChannelFullMode`.
- Microsoft Learn, [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout) zum Anpassen des Zeitfensters für das kontrollierte Herunterfahren.
- Microsoft Learn, [`AsyncServiceScope` und `CreateAsyncScope`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.dependencyinjection.serviceproviderserviceextensions.createasyncscope) für die Scope-Freigabe pro Arbeitseintrag.
