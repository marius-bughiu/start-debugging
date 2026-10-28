---
title: "Fix: Cannot access a disposed object. Object name: 'IServiceProvider'"
description: "Code hat einen Dienst aus einem bereits freigegebenen DI-Scope oder Root-Provider aufgelöst. Erfassen Sie IServiceScopeFactory statt IServiceProvider und erzeugen Sie dort einen neuen Scope, wo die Arbeit tatsächlich läuft."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-10"
  - "aspnetcore"
  - "dependency-injection"
lang: "de"
translationOf: "2026/10/fix-cannot-access-a-disposed-object-object-name-iserviceprovider"
translatedBy: "claude"
translationDate: 2026-10-28
---

Die Lösung: Etwas hat `GetService`, `GetRequiredService` oder `CreateScope` auf einem `IServiceProvider` aufgerufen, dessen Scope (oder dessen gesamter Container) bereits freigegeben war. Meist ist es ein Fire-and-Forget-Task, der `HttpContext.RequestServices` erfasst hat, ein Dienst, der den Scoped-`IServiceProvider` für eine "lazy" Auflösung speichert, oder eine Hintergrundschleife, die nach dem Herunterfahren des Hosts weiterläuft. Halten Sie keinen `IServiceProvider` mehr fest. Injizieren Sie `IServiceScopeFactory`, rufen Sie `CreateAsyncScope()` an der Stelle auf, an der die Arbeit tatsächlich läuft, und lösen Sie alles aus diesem neuen Scope auf.

```text
System.ObjectDisposedException: Cannot access a disposed object.
Object name: 'IServiceProvider'.
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ThrowHelper.ThrowObjectDisposedException()
   at Microsoft.Extensions.DependencyInjection.ServiceLookup.ServiceProviderEngineScope.GetService(Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService(IServiceProvider provider, Type serviceType)
   at Microsoft.Extensions.DependencyInjection.ServiceProviderServiceExtensions.GetRequiredService[T](IServiceProvider provider)
```

Jedes Snippet und jede Ausgabezeile in diesem Beitrag stammt aus einem Repro, das ich unter .NET 10 ausgeführt habe (Laufzeit 10.0.10, `Microsoft.Extensions.DependencyInjection` wie im Shared Framework ausgeliefert, ASP.NET Core 10.0.10). Die Prüfung, die diese Ausnahme auslöst, ist im Branch `release/11.0` von `dotnet/runtime` identisch, die Analyse gilt also auch für .NET 11.

## Warum der Container eine Ausnahme wirft, statt null zurückzugeben

In `Microsoft.Extensions.DependencyInjection` ist jeder Scope ein `ServiceProviderEngineScope`. Er implementiert gleichzeitig `IServiceScope`, `IServiceProvider` und `IServiceScopeFactory`, und der `IServiceProvider`, den Sie über `scope.ServiceProvider` erhalten, ist das Scope-Objekt selbst. Wird der Scope freigegeben, gibt er jede `IDisposable`/`IAsyncDisposable`-Instanz frei, die er erzeugt hat, und setzt anschließend ein privates Flag `_disposed`. Ab diesem Moment beginnen `GetService`, `GetKeyedService` und `GetRequiredKeyedService` alle mit derselben Prüfung:

```csharp
// dotnet/runtime, release/10.0
// src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs
public object? GetService(Type serviceType)
{
    if (_disposed)
    {
        ThrowHelper.ThrowObjectDisposedException();
    }

    return RootProvider.GetService(ServiceIdentifier.FromServiceType(serviceType), this);
}

// ThrowHelper.cs
internal static void ThrowObjectDisposedException()
{
    throw new ObjectDisposedException(nameof(IServiceProvider));
}
```

Wegen dieses `nameof(IServiceProvider)` lautet der Objektname immer `'IServiceProvider'`, egal ob es sich um einen Request-Scope, einen von Hand erzeugten Scope oder den Root-`ServiceProvider` handelt. Der Root-Provider hat ein eigenes Flag `_disposed` und läuft durch denselben Helper, die Meldung allein verrät also nicht, *welcher* Provider freigegeben wurde. Der Stack Trace verrät es: `ServiceProviderEngineScope.GetService` bedeutet einen Scope, während ein Frame in `ServiceProvider.CreateScope` oder `ServiceProvider.GetService` bedeutet, dass der Root-Container verschwunden ist, was fast immer heißt, dass der Host freigegeben wurde.

Zwei Folgen dieses Designs sind für das Debugging wichtig:

1. **Nur die Auflösung wirft.** Eine Instanz, die Sie vor dem Ende des Scopes aufgelöst haben, ist weiterhin ein normales Objekt. Hat sie eine eigene Dispose-Prüfung (ein `DbContext`, ein `HttpClient`, eine `CancellationTokenSource`), liefert der Zugriff die `ObjectDisposedException` *dieses* Typs mit dessen eigenem Objektnamen, nicht diese hier.
2. **Der Provider ist nicht "kaputt", er ist beendet.** Einen freigegebenen Scope kann man nicht wiederbeleben. Die Lösung besteht immer darin, einen Scope zu verwenden, dessen Lebensdauer die Arbeit abdeckt.

## Die vier Muster, die den Fehler auslösen

Ich habe jedes davon in einer Konsolenanwendung nachgestellt (`Microsoft.NET.Sdk.Web`, `net10.0`). Alle vier gaben exakt die obige Meldung aus.

### 1. Ein Scoped-Provider, der sein `using` überlebt

Das kleinstmögliche Repro. Die Variable überlebt den Scope:

```csharp
// .NET 10, C# 14
var services = new ServiceCollection();
services.AddScoped<Repo>();
using var root = services.BuildServiceProvider();

IServiceProvider leaked;
using (var scope = root.CreateScope())
{
    leaked = scope.ServiceProvider;
}

leaked.GetRequiredService<Repo>(); // ObjectDisposedException: 'IServiceProvider'
```

Niemand schreibt das absichtlich, aber es taucht ständig getarnt auf: eine Hilfsmethode mit `using var scope = ...; return scope.ServiceProvider;`, oder eine `async`-Methode, die einen Scope mit `using var` erzeugt und dann einen `Task` oder ein `IAsyncEnumerable` zurückgibt, das weiter aus diesem Scope auflöst, nachdem der synchrone Teil der Methode bereits zurückgekehrt ist.

### 2. Ein Fire-and-Forget-Task, der `HttpContext.RequestServices` erfasst hat

Mit diesem Fall landen die meisten hier. ASP.NET Core erzeugt den Request-Scope verzögert in `RequestServicesFeature` und registriert das Feature mit `Response.RegisterForDisposeAsync`, sodass der Scope freigegeben wird, sobald die Antwort abgeschlossen ist. Ein losgelöster Task, der `RequestServices` abgegriffen hat, verliert das Rennen:

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- wrong
app.MapPost("/orders/{id}/export", (int id, HttpContext ctx) =>
{
    var sp = ctx.RequestServices;
    _ = Task.Run(async () =>
    {
        await Task.Delay(200);                       // the response is already sent
        var exporter = sp.GetRequiredService<OrderExporter>(); // throws
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

In meinem Repro gab der Endpunkt `202` zurück, und 200 ms später protokollierte der Task `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.` Da die Ausnahme in einem unbeobachteten Task auftritt, sehen Sie sie oft nur in den Logs oder gar nicht, und das Symptom lautet "der Export findet stillschweigend nicht statt". Dasselbe passiert, wenn der Task `IServiceProvider` per Konstruktorinjektion in einem Controller erfasst oder später `IHttpContextAccessor.HttpContext.RequestServices` liest (wobei Sie auch `null` erhalten können, weil der Kontext recycelt wurde).

### 3. Ein Dienst, der `IServiceProvider` für später speichert

Die "Service Locator"-Variante. Ein Transient- oder Scoped-Dienst nimmt `IServiceProvider` in seinem Konstruktor entgegen, um Abhängigkeiten bei Bedarf aufzulösen:

```csharp
// .NET 10, C# 14 -- wrong
class ReportBuilder(IServiceProvider sp)
{
    public void Build() => sp.GetRequiredService<Repo>().Save();
}

ReportBuilder rb;
using (var scope = root.CreateScope())
    rb = scope.ServiceProvider.GetRequiredService<ReportBuilder>();

rb.Build(); // ObjectDisposedException: 'IServiceProvider'
```

Der `IServiceProvider`, der in einen Scoped- oder Transient-Dienst injiziert wird, ist der Scope, aus dem er aufgelöst wurde, nicht der Root. Sobald `ReportBuilder` an etwas weitergereicht wird, das den Scope überlebt (ein Singleton-Cache, ein Ereignisabonnement an einem Singleton, ein statisches Feld, ein `Lazy<T>`, eine `Func<T>`-Factory, registriert mit `sp => () => sp.GetRequiredService<T>()`), wirft die nächste verzögerte Auflösung. Wenn Sie den [Captive-Dependency-Fehler "Cannot consume scoped service from singleton"](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) kennen, ist dies sein Laufzeit-Cousin: Die Scope-Validierung erkennt erfasste *Dienste* zur Build-Zeit, aber keinen erfassten *Provider*.

### 4. Eine Hintergrundschleife, die den Host überlebt

Der Root-Provider wird freigegeben, wenn der Host freigegeben wird. `BackgroundService.StopAsync` bricht das Stopping-Token ab und wartet auf `ExecuteAsync`, aber nur bis `HostOptions.ShutdownTimeout` abläuft (seit .NET 6 standardmäßig 30 Sekunden). Eine Schleife, die das Token ignoriert, läuft weiter, nachdem der Host fortgefahren ist und den Container freigegeben hat:

```csharp
// .NET 10 -- wrong: ignores stoppingToken
class StubbornWorker(IServiceScopeFactory scopes) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (true)
        {
            using var scope = scopes.CreateScope(); // throws once the host is disposed
            scope.ServiceProvider.GetRequiredService<Repo>().Save();
            await Task.Delay(250);
        }
    }
}
```

Mit `ShutdownTimeout` auf 1 Sekunde kehrte `StopAsync` zurück, `host.Dispose()` lief, und die nächste Iteration gab `ObjectDisposedException: Cannot access a disposed object. Object name: 'IServiceProvider'.` aus. Beachten Sie, dass dieser Worker bei den Scopes alles richtig macht. Der Fehler liegt allein im ignorierten Cancellation-Token. Dasselbe Fehlerbild zeigt sich bei Callbacks von `System.Threading.Timer`, bei `Channel`-Konsumenten, die mit `Task.Run` gestartet wurden, und bei Message-Bus-Handlern, die nach dem Herunterfahren weiterarbeiten. In Tests tritt es auf, wenn eine `WebApplicationFactory<T>` oder eine Host-Fixture freigegeben wird, während ein Test (oder ein vom Test gestarteter Hintergrund-Task) noch Dienste aus `factory.Services` auflöst.

## Lösung 1: `IServiceScopeFactory` erfassen, nicht `IServiceProvider`

Für die Muster 2 und 3 ist dies die Lösung. `IServiceScopeFactory` ist im Container ein Sonderfall: `ServiceProvider` registriert ihn als konstante Call Site, die auf den **Root**-Scope zeigt, es spielt also keine Rolle, wo Sie ihn auflösen. Selbst ein in einen Request-Scoped-Endpunkt injizierter `IServiceScopeFactory` ist an den Root-Container gebunden und funktioniert nach dem Ende der Anfrage weiter. Erzeugen Sie den Scope innerhalb der losgelösten Arbeit, sodass die Lebensdauer des Scopes genau der Lebensdauer der Arbeit entspricht:

```csharp
// .NET 10, ASP.NET Core 10.0.10 -- right
app.MapPost("/orders/{id}/export", (int id, IServiceScopeFactory scopes) =>
{
    _ = Task.Run(async () =>
    {
        await using var scope = scopes.CreateAsyncScope();
        var exporter = scope.ServiceProvider.GetRequiredService<OrderExporter>();
        await exporter.ExportAsync(id);
    });
    return Results.Accepted();
});
```

Im Repro protokollierte dieselbe Verzögerung von 200 ms, die die `RequestServices`-Version zum Absturz brachte, hier `good: ok`. Bevorzugen Sie `CreateAsyncScope()` mit `await using`: Implementiert ein Dienst im Scope nur `IAsyncDisposable`, wirft ein synchrones `Dispose()` auf dem Scope eine `InvalidOperationException`, die Sie auf `DisposeAsync` hinweist. Der [Leitfaden zu `IAsyncDisposable` und `await using`](/de/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) erklärt, warum.

Reichen Sie auch keine anfragegebundenen *Daten* über den Scope weiter. Kopieren Sie, was Sie brauchen (IDs, den Benutzernamen, eine Correlation ID), in lokale Variablen, bevor Sie den Task starten. `HttpContext` selbst darf nach Abschluss der Antwort nicht mehr angefasst werden.

Für das Service-Locator-Muster injizieren Sie `IServiceScopeFactory` in `ReportBuilder` und erzeugen pro `Build()`-Aufruf einen Scope, oder besser, injizieren Sie `Repo` direkt und überlassen Sie dem Container die Verwaltung der Lebensdauern. Ist die Abhängigkeit wirklich optional oder teuer, ist eine Keyed- oder Factory-Registrierung, die aus einem frischen Scope auflöst, sauberer als das Speichern des Providers.

## Lösung 2: die Arbeit in einen echten Hintergrundmechanismus verlagern

`Task.Run` aus einem Request-Handler ist die eigentliche Ursache in Muster 2. Nichts verfolgt den Task, nichts beobachtet seine Ausnahme, und nichts stoppt ihn beim Herunterfahren. Legen Sie das Arbeitselement in einen `Channel<T>` und leeren Sie ihn aus einem `BackgroundService`, der pro Element einen Scope erzeugt:

```csharp
// .NET 10, C# 14
public sealed class ExportQueue
{
    private readonly Channel<int> _channel = Channel.CreateUnbounded<int>();
    public ValueTask EnqueueAsync(int orderId) => _channel.Writer.WriteAsync(orderId);
    public IAsyncEnumerable<int> ReadAllAsync(CancellationToken ct) => _channel.Reader.ReadAllAsync(ct);
}

public sealed class ExportWorker(ExportQueue queue, IServiceScopeFactory scopes, ILogger<ExportWorker> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await foreach (var id in queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<OrderExporter>().ExportAsync(id, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogError(ex, "Export of order {OrderId} failed", id);
            }
        }
    }
}

// Program.cs
builder.Services.AddSingleton<ExportQueue>();
builder.Services.AddHostedService<ExportWorker>();
app.MapPost("/orders/{id}/export", async (int id, ExportQueue queue) =>
{
    await queue.EnqueueAsync(id);
    return Results.Accepted();
});
```

Das vollständige Muster, einschließlich begrenzter Channels und Back-Pressure, steht in [Fire-and-Forget-Arbeit sicher mit BackgroundService ausführen](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/). Der Teil mit dem Scope pro Iteration wird ausführlich in [Scoped-Dienste innerhalb eines BackgroundService verwenden](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) behandelt.

## Lösung 3: das Stopping-Token beachten, damit nach der Freigabe nichts mehr läuft

Bei Muster 4 ist der Scope-Code in Ordnung, und die Lebensdauer der Schleife ist der Fehler. Übergeben Sie `stoppingToken` an jedes await und jede Schleifenbedingung, damit die Schleife endet, bevor `ShutdownTimeout` abläuft:

```csharp
// .NET 10 -- right
protected override async Task ExecuteAsync(CancellationToken stoppingToken)
{
    using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
    while (await timer.WaitForNextTickAsync(stoppingToken))
    {
        await using var scope = scopes.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<Repo>().SaveAsync(stoppingToken);
    }
}
```

`PeriodicTimer.WaitForNextTickAsync` wirft bei Abbruch eine `OperationCanceledException`, und `BackgroundService` behandelt einen Abbruch, der zum Stopping-Token passt, als sauberes Beenden. Dauert eine einzelne Arbeitseinheit legitimerweise länger als 30 Sekunden, erhöhen Sie `HostOptions.ShutdownTimeout`, statt das Token zu ignorieren; andernfalls gibt der Host den Container unter Ihren Füßen frei. Der [Beitrag zum IHostedService-Vertrag](/de/2026/07/what-is-the-ihostedservice-contract-and-when-do-i-use-it/) beschreibt die genaue Reihenfolge von Start und Stopp.

Stellen Sie bei Integrationstests sicher, dass der Test jeden von ihm gestarteten Task abwartet, bevor das `DisposeAsync` der Fixture läuft, und lösen Sie testspezifische Dienste über `factory.Services.CreateAsyncScope()` auf statt direkt über `factory.Services`.

## Stolperfallen und ähnliche Fehler

**Der Wettlauf innerhalb der Auflösung.** `ServiceProviderEngineScope.CaptureDisposable` prüft `_disposed` unter einem Lock, nachdem ein Disposable-Dienst konstruiert wurde. Wurde der Scope freigegeben, *während* Ihr Dienst in einem anderen Thread erzeugt wurde, gibt der Container die frisch gebaute Instanz frei und wirft dann dieselbe Ausnahme. Sie können sie also in einem Codepfad sehen, der eine Mikrosekunde zuvor noch in Ordnung aussah. Es ist trotzdem derselbe Fehler: Zwei Threads sind sich über die Lebensdauer des Scopes uneinig.

**`app.Services` nach der Rückkehr von `app.Run`.** Alles in `Program.cs`, das nach `app.Run()` oder `await app.RunAsync()` läuft (Aufräumcode, ein abschließendes Flush), läuft nach der Freigabe des Hosts. Lösen Sie auf, was Sie brauchen, bevor Sie `Run` aufrufen, oder verlagern Sie die Logik in einen `IHostApplicationLifetime.ApplicationStopping`-Callback.

**`IServiceProvider` in einem Singleton ist der Root.** Wird `IServiceProvider` in einen Singleton injiziert, erhalten Sie den Root-Provider, der erst mit dem Host freigegeben wird und im Normalbetrieb diese Ausnahme daher nicht wirft. Er gibt allerdings bereitwillig Scoped-Dienste aus dem Root-Scope heraus, wenn `ValidateScopes` ausgeschaltet ist, und macht sie dadurch zu versehentlichen Singletons. Verwenden Sie auch dort `IServiceScopeFactory`.

**"Cannot access a disposed context instance".** Ist der Objektname in Ihrer Meldung Ihr `DbContext`-Typ (`Object name: 'AppDb'`), wurden die Dienste des Scopes freigegeben, nicht der Provider, und die Lösung ist ein frischer Kontext pro Operation: siehe [den Leitfaden zum freigegebenen DbContext](/de/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/).

**`Object name: 'System.Net.Http.HttpClient'` oder eine `CancellationTokenSource`.** Gleicher Ausnahmetyp, anderer Besitzer. Diese entstehen durch das Freigeben einer von Ihnen aufgelösten Instanz, nicht durch das Auflösen nach der Freigabe.

## Verwandte Beiträge

- [Fix: Cannot consume scoped service from singleton](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) für die Build-Zeit-Variante erfasster Lebensdauern.
- [Scoped-Dienste innerhalb eines BackgroundService verwenden](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) für das Muster Scope pro Arbeitseinheit.
- [Fire-and-Forget-Arbeit sicher mit BackgroundService ausführen](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) als Ersatz für `Task.Run` in Handlern.
- [Fix: Cannot access a disposed context instance](/de/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/) für die EF-Core-Variante desselben Lebensdauer-Fehlers.
- [Integrationstests mit WebApplicationFactory schreiben](/de/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) für Fixture-Lebensdauern in Tests.

## Quellen

- [`ServiceProviderEngineScope.cs` auf `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ServiceProviderEngineScope.cs) (die `_disposed`-Prüfung und `CaptureDisposable`).
- [`ThrowHelper.cs` auf `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceLookup/ThrowHelper.cs) (`new ObjectDisposedException(nameof(IServiceProvider))`).
- [`ServiceProvider.cs` auf `release/10.0`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/Microsoft.Extensions.DependencyInjection/src/ServiceProvider.cs) (`IServiceScopeFactory` als an den Root-Scope gebundene Konstante registriert).
- [`RequestServicesFeature.cs` auf `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Http/Http/src/Features/RequestServicesFeature.cs) (Request-Scope über `RegisterForDisposeAsync` freigegeben).
- [Dependency injection guidelines](https://learn.microsoft.com/en-us/dotnet/core/extensions/dependency-injection-guidelines) auf Microsoft Learn.
- [Use scoped services within a BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) auf Microsoft Learn.
- [`HostOptions.ShutdownTimeout`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.hosting.hostoptions.shutdowntimeout) API-Referenz.
