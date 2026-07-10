---
title: "Was ist der IHostedService-Vertrag und wann verwende ich ihn?"
description: "IHostedService ist das Interface mit zwei Methoden (StartAsync/StopAsync), das der generische Host von .NET beim Start und beim geordneten Herunterfahren aufruft. Hier steht, was der Vertrag zusichert, wann Sie ihn direkt implementieren und welche Verhaltensanderungen in .NET 10 und 11 fur Uberraschungen sorgen."
pubDate: 2026-07-10
tags:
  - "dotnet"
  - "aspnetcore"
  - "csharp"
lang: "de"
translationOf: "2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it"
translatedBy: "claude"
translationDate: 2026-07-10
---

`IHostedService` ist das Interface mit zwei Methoden, das der generische Host von .NET verwendet, um langlebige Arbeit zusammen mit Ihrer Anwendung zu starten und zu stoppen. Sie hat genau zwei Mitglieder, `StartAsync(CancellationToken)` und `StopAsync(CancellationToken)`, und der Host ruft sie an klar definierten Stellen auf: `StartAsync`, bevor die App beginnt, Anfragen zu bedienen, `StopAsync` wahrend des geordneten Herunterfahrens. Sie implementieren sie direkt, wenn Sie prazise Kontrolle uber geordnete Start- oder Shutdown-Schritte benotigen. Fur kontinuierliche Schleifen wollen Sie fast immer `BackgroundService`, eine kleine abstrakte Klasse, die `IHostedService` fur Sie implementiert. Dieser Artikel erklart, was der Vertrag tatsachlich garantiert, wann Sie zum rohen Interface greifen sollten und welche Verhaltensanderungen in .NET 10 und .NET 11 die Leute stolpern lassen.

Alles hier zielt auf .NET 11 und C# 14 ab, mit `Microsoft.Extensions.Hosting` 11.0.x. Wo sich das Verhalten in einer bestimmten Version geandert hat, weise ich darauf hin.

## Der Vertrag sind zwei Methoden und ein Sequenzierungsversprechen

Dies ist das gesamte Interface:

```csharp
// .NET 11, C# 14 -- Microsoft.Extensions.Hosting.Abstractions
public interface IHostedService
{
    Task StartAsync(CancellationToken cancellationToken);
    Task StopAsync(CancellationToken cancellationToken);
}
```

Das ist die gesamte Oberflache. Was sie nutzlich macht, ist nicht die Form der Methoden, sondern die Garantien, die der Host um sie herum legt:

- Der Host wartet (`await`) auf `StartAsync` bei jedem registrierten Hosted Service, **bevor** die Anwendung als gestartet gilt. In einer ASP.NET Core-App bedeutet das, bevor Kestrel die erste Anfrage annimmt.
- Standardmassig starten die Dienste **sequenziell, in Registrierungsreihenfolge**. Der Host ruft `StartAsync` des nachsten Dienstes erst auf, wenn der vom aktuellen zuruckgegebene `Task` abgeschlossen ist.
- Beim Herunterfahren ruft der Host `StopAsync` bei jedem Dienst in **umgekehrter** Registrierungsreihenfolge auf und wartet bis zu `HostOptions.ShutdownTimeout` (standardmassig 30 Sekunden), bis sie fertig sind.

Das Sequenzierungsversprechen ist der Grund, warum es wichtig ist. Wenn Sie "erwarme diesen Cache, bevor irgendeine Anfrage einen kalten Pfad treffen kann" oder "offne diese Verbindung, bevor der Queue-Consumer startet" benotigen, ist `StartAsync` der richtige Haken, denn der Host fahrt nicht fort, bis er zuruckkehrt.

## Warum StartAsync schnell sein muss

Da der Start standardmassig sequenziell ist, verzogert ein langsames `StartAsync` jeden danach registrierten Dienst und verzogert, dass die gesamte Anwendung online geht. Dies ist der haufigste Fehler mit dem rohen Interface: eine langlebige Schleife direkt in `StartAsync` zu platzieren und niemals zuruckzukehren.

```csharp
// .NET 11, C# 14 -- WRONG: the host never finishes starting
public sealed class BrokenWorker : IHostedService
{
    public async Task StartAsync(CancellationToken ct)
    {
        // This loop never returns, so StartAsync never completes,
        // so the host never starts, so no requests are served.
        while (!ct.IsCancellationRequested)
        {
            await DoWorkAsync();
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Die Losung besteht darin, `StartAsync` als "starte die Arbeit und kehre zuruck" zu behandeln. Starten Sie die Schleife als Hintergrund-`Task`, behalten Sie eine Referenz darauf und warten Sie in `StopAsync` auf diese Referenz:

```csharp
// .NET 11, C# 14 -- correct raw IHostedService with a background loop
public sealed class QueueDrainService(ILogger<QueueDrainService> logger) : IHostedService
{
    private readonly CancellationTokenSource _stopping = new();
    private Task? _loop;

    public Task StartAsync(CancellationToken ct)
    {
        // Return quickly. Capture the loop task; do not await it here.
        _loop = RunAsync(_stopping.Token);
        return Task.CompletedTask;
    }

    private async Task RunAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { await DrainOnceAsync(ct); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), ct);
        }
    }

    public async Task StopAsync(CancellationToken ct)
    {
        _stopping.Cancel();
        // Wait for the loop to unwind, but respect the shutdown deadline.
        if (_loop is not null)
            await _loop.WaitAsync(ct).ConfigureAwait(false);
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Wenn dieses Muster wie Boilerplate aussieht, ist genau das der Punkt: Es ist der Boilerplate, den `BackgroundService` beseitigen soll.

## Wo BackgroundService hineinpasst

`BackgroundService` ist eine abstrakte Klasse im selben Namespace, die `IHostedService` implementiert und Ihnen eine einzige Methode zum Uberschreiben gibt:

```csharp
// .NET 11, C# 14 -- the shape BackgroundService hands you
public sealed class QueueDrainService(ILogger<QueueDrainService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await DrainOnceAsync(stoppingToken); }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { logger.LogError(ex, "Drain failed; retrying"); }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }

    private static Task DrainOnceAsync(CancellationToken ct) => Task.CompletedTask;
}
```

Die Basisklasse speichert den von `ExecuteAsync` zuruckgegebenen Task, bricht den `stoppingToken` ab, wenn der Host stoppt, und wartet in ihrem eigenen `StopAsync` auf Ihre Schleife. Es ist derselbe Lebenszyklus wie im rohen Beispiel oben, abzuglich der Verkabelung.

Die praktische Regel lautet also: **Implementieren Sie `IHostedService` nur dann direkt, wenn Arbeit innerhalb von `StartAsync` abgeschlossen sein muss, bevor die App online geht, oder geordnete Shutdown-Arbeit innerhalb von `StopAsync`.** Fur eine kontinuierliche Schleife, die nur laufen muss, solange die App lauft, verwenden Sie `BackgroundService`. Wenn Sie den tieferen Vergleich einschliesslich dauerhafter Job-Systeme wollen, sehen Sie sich [die Entscheidungsmatrix fur BackgroundService, IHostedService und Hangfire](/de/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/) an.

## Die Anderung in .NET 10, die ExecuteAsync vom Hauptthread wegverschob

Vor .NET 10 gab es eine subtile Falle in `BackgroundService`: Der synchrone Teil von `ExecuteAsync`, also alles vor dem ersten `await`, lief wahrend des Starts auf dem Hauptthread und blockierte andere Dienste am Starten. Nur der Code nach dem ersten `await` wanderte auf einen Hintergrundthread.

Ab .NET 10 [fuhrt `BackgroundService` die Gesamtheit von `ExecuteAsync` auf einem Hintergrundthread aus](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task), sodass kein Teil davon andere Dienste am Starten blockiert. Das ist eine willkommene Korrektur, aber sie andert eine Annahme, auf die sich mancher Code verliess. Wenn Sie absichtlich Einrichtungsarbeit vor dem ersten `await` erledigten, damit sie wahrend des Starts lief, liegt diese Arbeit nun ausserhalb des Startpfads.

Wenn Sie erneut benotigen, dass etwas wahrend des Starts synchron lauft, beschreibt die Dokumentation die Optionen: Tun Sie es im Konstruktor, uberschreiben Sie `StartAsync` und fuhren Sie es vor `base.StartAsync` aus, implementieren Sie `IHostedLifecycleService` (weiter unten) oder steigen Sie auf ein rohes `IHostedService` ab. Das rohe Interface hatte diese Mehrdeutigkeit nie, was ein weiterer Grund ist, sie zu verwenden, wenn die Startreihenfolge wirklich wichtig ist.

## IHostedLifecycleService fur feinkornigere Haken

Wenn zwei `StartAsync`-Haken nicht ausreichen, fugte .NET 8 `IHostedLifecycleService` hinzu, das `IHostedService` um vier weitere Callbacks erweitert:

```csharp
// .NET 11, C# 14 -- extends IHostedService with pre/post hooks
public interface IHostedLifecycleService : IHostedService
{
    Task StartingAsync(CancellationToken cancellationToken);
    Task StartedAsync(CancellationToken cancellationToken);
    Task StoppingAsync(CancellationToken cancellationToken);
    Task StoppedAsync(CancellationToken cancellationToken);
}
```

Der Host ruft sie um die beiden zentralen Methoden herum in dieser Reihenfolge auf: `StartingAsync` bei allen Diensten, dann `StartAsync` bei allen Diensten, dann `StartedAsync` bei allen Diensten. Das Herunterfahren spiegelt dies wider: `StoppingAsync`, dann `StopAsync`, dann `StoppedAsync`. Der Unterschied zum einfachen `IHostedService` ist, dass diese Phasen als *Stapel* uber jeden Dienst hinweg laufen, sodass `StartingAsync` der Ort ist, um Arbeit auszufuhren, die vor dem `StartAsync` **jedes** Dienstes geschehen muss, nicht nur vor dem eigenen.

Sie brauchen dies selten. Greifen Sie darauf zuruck, wenn Sie dienstubergreifende Reihenfolgevorgaben haben, etwa "jeder Dienst muss seine Vorstart-Arbeit beendet haben, bevor einer von ihnen einen Netzwerk-Listener offnet". Fur den ublichen Fall reicht das einfache `IHostedService` oder `BackgroundService`.

## Hosted Services registrieren

Die Registrierung ist ein Einzeiler, und die DI-Lebensdauer ist festgelegt:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddHostedService<QueueDrainService>();
builder.Services.AddHostedService<CacheWarmer>();

var app = builder.Build();
app.Run();
```

`AddHostedService<T>` registriert den Typ als **Singleton**-`IHostedService`. Das hat eine Konsequenz, an der die Leute standig stossen: Sie konnen einen Scoped-Dienst (wie einen gepoolten `DbContext`) nicht direkt in den Konstruktor eines Hosted Service injizieren, weil ein Singleton nicht von einem Scoped-Dienst abhangen kann. Injizieren Sie stattdessen `IServiceScopeFactory` und erstellen Sie einen Scope pro Arbeitseinheit. Diese spezielle Falle und ihre exakte Ausnahmemeldung wird in [warum Sie einen Scoped-Dienst nicht aus einem Singleton konsumieren konnen](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) behandelt, und das korrekte Scoping-Muster steht in [wie Sie Scoped-Dienste innerhalb eines BackgroundService verwenden](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/).

Die Registrierungsreihenfolge ist die Reihenfolge der `StartAsync`-Aufrufe und die umgekehrte Reihenfolge der `StopAsync`-Aufrufe, registrieren Sie also zuerst die Dienste, von deren Start andere abhangen.

## Die Cancellation-Token beachten

Beide Methoden erhalten einen `CancellationToken`, und sie bedeuten Unterschiedliches.

Der an `StartAsync` ubergebene Token signalisiert, dass der Start abgebrochen wird. In der Praxis wird er selten ausgelost, aber Sie sollten ihn dennoch durch jeden asynchronen Aufruf durchreichen, den Sie tatigen, damit ein Ctrl+C wahrend eines langsamen Starts ihn tatsachlich abbricht.

Der an `StopAsync` ubergebene Token ist der wichtige. Er wird abgebrochen, wenn die Frist fur das geordnete Herunterfahren (`HostOptions.ShutdownTimeout`, standardmassig 30 Sekunden) ablauft. Wenn Ihr `StopAsync` ihn ignoriert und weiter wartet, wird der Host den Prozess ohnehin irgendwann abbauen, und laufende Arbeit geht verloren. Ihre Shutdown-Logik sollte also *umgehend* stoppen, wenn dieser Token ausgelost wird, und ausspulen oder einen Checkpoint setzen, was sie kann, anstatt zu versuchen, alles zu beenden.

```csharp
// .NET 11, C# 14 -- extend the shutdown window when your drain is slow
builder.Services.Configure<HostOptions>(o =>
    o.ShutdownTimeout = TimeSpan.FromSeconds(60));
```

Erhohen Sie das Timeout nur, wenn Ihre Arbeit wirklich langer braucht, um sauber zu leeren. Korrekt auf den Token zu reagieren ist die wichtigere Angewohnheit, und sie geht Hand in Hand damit, das Abbrechen im restlichen asynchronen Code richtig hinzubekommen, was ein eigenes Thema in [wie Sie einen langlaufenden Task ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) ist.

## Die Anderung in .NET 11 bei Exit-Codes im Fehlerfall

Hier ist die Verhaltensanderung, die Sie beim Upgrade am ehesten uberrascht. Wenn ein `BackgroundService` eine unbehandelte Ausnahme aus `ExecuteAsync` wirft und `HostOptions.BackgroundServiceExceptionBehavior` auf seinem Standard `StopHost` bleibt, stoppt der Host. Dieser Standard gilt seit .NET 6 (davor war der Standard `Ignore`, das Sie stillschweigend mit einem Zombie-Host zuruckliess, der lebendig aussah, aber keine Arbeit tat).

Was sich in .NET 11 Preview 3 geandert hat, ist der Exit-Code. Zuvor wurde der von `RunAsync`, `StopAsync` oder `WaitForShutdownAsync` zuruckgegebene Task *erfolgreich* abgeschlossen, auch wenn ein Dienst abgesturzt war, sodass der Prozess ublicherweise mit Code null endete und Ihr Orchestrator glaubte, alles sei in Ordnung. Ab .NET 11 [schlagen diese Methoden nun mit einer Ausnahme fehl](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure), sodass der Prozess mit einem Code ungleich null endet. Ein einzelner fehlgeschlagener Dienst wirft seine Ausnahme erneut; mehrere Fehler kommen als `AggregateException` zuruck.

Das ist fast immer das gewunschte Verhalten: Ein abgesturzter Hintergrund-Worker sollte keinen Erfolg melden. Aber wenn Sie Code hatten, der sich auf das alte stille Erfolgsverhalten verliess, sehen Sie nun einen Exit-Code ungleich null und moglicherweise eine unbehandelte Ausnahme an der Spitze von `Program.cs`. Die von Microsoft empfohlene Massnahme ist, nichts zu tun und es lautstark scheitern zu lassen. Wenn Sie wirklich das alte Verhalten benotigen, umschliessen Sie das `await host.RunAsync()` mit einem try/catch oder setzen Sie das Ausnahmeverhalten wieder auf `Ignore` und akzeptieren Sie den Kompromiss:

```csharp
// .NET 11, C# 14 -- opt back into the old, quieter behavior (usually a mistake)
builder.Services.Configure<HostOptions>(o =>
    o.BackgroundServiceExceptionBehavior =
        BackgroundServiceExceptionBehavior.Ignore);
```

Ich wurde nicht zu `Ignore` greifen. Ein Hosted Service, der absturzen und den Host laufend, aber untatig zurucklassen kann, ist viel schwerer zu diagnostizieren als einer, der den Prozess niederreisst und von Ihrem Orchestrator neu gestartet wird. Die bessere Losung ist, innerhalb Ihrer Schleife zu fangen und zu protokollieren, wie es die vorherigen Beispiele tun, damit eine einzelne fehlgeschlagene Iteration niemals zu einer unbehandelten Ausnahme wird.

## Wann das rohe Interface die richtige Wahl ist

Zusammengefasst: Implementieren Sie `IHostedService` direkt, wenn:

- Sie Startarbeit haben, die **abgeschlossen sein muss, bevor die App Traffic bedient**: einen Cache erwarmen, eine Schema- oder Migrationsprufung ausfuhren, einen Verbindungspool aufbauen. Legen Sie sie in `StartAsync` und lassen Sie die Garantie des sequenziellen Starts ihre Arbeit tun.
- Sie Shutdown-Arbeit haben, die in einer **bestimmten Reihenfolge** laufen muss: einen Puffer leeren, sich von einem Service-Discovery-Endpunkt abmelden, eine letzte Metrik senden. Legen Sie sie in `StopAsync`.
- Sie wollen, dass die Verkabelung explizit ist, weil der Lebenszyklus ungewohnlich ist und Sie ihn lieber lesen, als der Basisklasse zu vertrauen.

Verwenden Sie `BackgroundService` fur den weitaus haufigeren Fall einer Schleife, die uber die gesamte Lebensdauer der App lauft. Verwenden Sie `IHostedLifecycleService` nur, wenn Sie stapelweise Vorstart- oder Nach-Shutdown-Phasen uber mehrere Dienste hinweg benotigen. Und was auch immer Sie wahlen, beachten Sie die Cancellation-Token, halten Sie `StartAsync` schnell und lassen Sie Fehler an die Oberflache kommen. Fur verwandte Muster sehen Sie sich [wie Sie Fire-and-Forget-Arbeit sicher mit BackgroundService ausfuhren](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) an.

## Quellen

- [IHostedService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedservice)
- [IHostedLifecycleService Interface -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.ihostedlifecycleservice)
- [Breaking change: BackgroundService runs all of ExecuteAsync as a Task (.NET 10)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/10.0/backgroundservice-executeasync-task)
- [Breaking change: IHost.RunAsync and IHost.StopAsync throw when a BackgroundService fails (.NET 11)](https://learn.microsoft.com/en-us/dotnet/core/compatibility/extensions/11/ihost-runasync-stopasync-throw-backgroundservice-failure)
- [BackgroundServiceExceptionBehavior Enum -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.backgroundserviceexceptionbehavior)
