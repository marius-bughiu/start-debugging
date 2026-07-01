---
title: "Asynchrone Operationen in C# mit CancellationTokenSource.CancelAfter zeitlich begrenzen"
description: "CancellationTokenSource.CancelAfter für asynchrone Deadlines in .NET 11: Konstruktor vs. CancelAfter, verknüpfte Token, Ausnahmebehandlung, Task.WaitAsync, TryReset für Pooling und testbare Timeouts mit TimeProvider."
pubDate: 2026-07-01
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "de"
translationOf: "2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-01
---

Eine Deadline für eine asynchrone Operation durchzusetzen erfordert drei Dinge: eine `CancellationTokenSource`, einen Aufruf von `cts.CancelAfter(TimeSpan.FromSeconds(5))` und das Weiterleiten von `cts.Token` an jede asynchrone Methode in der Aufrufkette. Wenn die Deadline abläuft, wird das Token ausgelöst, jedes nachfolgende `await` wirft `OperationCanceledException`, und Sie fangen sie ab. Dieser Artikel behandelt das vollständige Muster in .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14): wann die Konstruktorüberladung statt `CancelAfter` verwendet werden sollte, wie ein Timeout mit einem äußeren `CancellationToken` kombiniert wird, wie ein Timeout von einer Aufrufer-Abbruch unterschieden wird, `Task.WaitAsync` für Code, den Sie nicht ändern können, `TryReset` für Pooling und wie Timeouts mit `TimeProvider` testbar gemacht werden.

## Die Operation, die ewig hängt

Ein `HttpClient`-Aufruf ohne explizite Deadline wartet so lange, wie der Server braucht. `HttpClient.Timeout` hat einen Standardwert von 100 Sekunden -- lang genug, um unter Last eine Anfragewarteschlange zu verstopfen. Außerdem kann `HttpClient.Timeout` nicht mit dem `CancellationToken` eines Aufrufers kombiniert werden, und wenn es ausgelöst wird, wirft es `TaskCanceledException` mit einer `InnerException` vom Typ `TimeoutException` -- eine andere Form als ein kooperativer Abbruch. Das manuelle `CancelAfter`-Muster bietet sowohl Deadline-Durchsetzung als auch Kompositionsmöglichkeiten.

```csharp
// .NET 11, C# 14 -- gefährlich: HttpClient.Timeout hat standardmäßig 100 Sekunden
using HttpClient http = new();
string json = await http.GetStringAsync("https://slow-api.example.com/data");
```

## CancelAfter in einem Schritt

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(5));

try
{
    using HttpClient http = new();
    string json = await http.GetStringAsync(
        "https://slow-api.example.com/data", cts.Token);
    Console.WriteLine(json);
}
catch (OperationCanceledException) when (cts.IsCancellationRequested)
{
    Console.WriteLine("Anfrage nach 5 Sekunden abgebrochen.");
}
```

`CancelAfter` plant einen internen Einmal-Timer. Wenn der Timer auslöst, ruft er `Cancel()` auf dem CTS auf, was den Zustand des Tokens von "nicht angefordert" auf "angefordert" wechselt. Jedes `await` innerhalb von `GetStringAsync`, das das Token prüft, wirft `OperationCanceledException`. Die `when`-Klausel stellt sicher, dass Sie die Ausnahme nur abfangen, wenn Ihr eigener CTS ausgelöst hat -- nicht wenn irgendein anderer Abbruch vom Framework oder einem Aufrufer eintrifft.

## Konstruktorüberladung vs. CancelAfter

```csharp
// .NET 11, C# 14 -- gleichwertig für eine feste, einmalige Deadline:
using var cts1 = new CancellationTokenSource(TimeSpan.FromSeconds(5));

using var cts2 = new CancellationTokenSource();
cts2.CancelAfter(TimeSpan.FromSeconds(5));
```

Verwenden Sie die Konstruktorüberladung, wenn die Deadline bei der Objekterstellung festgelegt ist und sich nicht ändern wird. Bevorzugen Sie `CancelAfter`, wenn Sie den CTS im Voraus erstellen und die Deadline später festlegen, oder wenn Sie ihn während der Operation zurücksetzen müssen -- zum Beispiel ein Watchdog, der sein Fenster bei jedem erfolgreichen Heartbeat erneuert:

```csharp
// .NET 11, C# 14 -- Watchdog-Muster, das die Deadline bei jedem Paket zurücksetzt
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));

await foreach (Packet packet in ReadPacketsAsync(cts.Token))
{
    Process(packet);
    cts.CancelAfter(TimeSpan.FromSeconds(10));  // 10-Sekunden-Fenster zurücksetzen
}
```

Jeder `CancelAfter`-Aufruf ersetzt die zuvor geplante Zeit mit `ITimer.Change` intern -- ohne neue Speicherzuweisung. Der neue Countdown beginnt ab dem Zeitpunkt des Aufrufs.

## Timeout mit einem äußeren CancellationToken kombinieren

In ASP.NET Core wird `HttpContext.RequestAborted` ausgelöst, wenn der Client die Verbindung trennt. In einem `BackgroundService` wird `stoppingToken` beim Herunterfahren ausgelöst. Ihr Timeout sollte abbrechen, wenn entweder die Deadline abläuft oder der Aufrufer abbricht. Verwenden Sie `CancellationTokenSource.CreateLinkedTokenSource`:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithDeadlineAsync(
    string url,
    CancellationToken callerToken = default)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(
        callerToken, timeoutCts.Token);

    using HttpClient http = new();
    return await http.GetStringAsync(url, linked.Token);
}
```

Übergeben Sie `linked.Token` an jeden nachgelagerten Aufruf. Das verknüpfte Token wird abgebrochen, wenn eine der Quellen ausgelöst wird. `CreateLinkedTokenSource` akzeptiert beliebig viele Token; der zurückgegebene CTS wird abgebrochen, sobald eines davon abgebrochen wird.

Entsorgen Sie immer sowohl den Timeout-CTS als auch den verknüpften CTS. Nicht entsorgte CTS-Instanzen mit ausstehenden Timern werden erst dann vom Garbage Collector erfasst, wenn der Timer auslöst.

## Timeout von Aufrufer-Abbruch unterscheiden

Beide Pfade werfen `OperationCanceledException`. Um dem Aufrufer aussagekräftige Fehlerinformationen zu geben, wandeln Sie einen echten Timeout in eine `TimeoutException` um:

```csharp
// .NET 11, C# 14
catch (OperationCanceledException ex)
{
    if (timeoutCts.IsCancellationRequested)
        throw new TimeoutException(
            "Die Operation ist nach 5 Sekunden abgelaufen.", ex);

    // Aufrufer hat abgebrochen -- unverändert weiterwerfen, damit das Token
    // des Aufrufers unverändert weitergegeben wird
    throw;
}
```

Dies ist wichtig, wenn der aufrufende Code die interne `CancellationTokenSource` nicht kennt. Ein Aufrufer, der `TimeoutException` abfängt, muss keine Token inspizieren, die er nie erstellt hat.

Prüfen Sie bei Verwendung eines verknüpften CTS direkt `timeoutCts.IsCancellationRequested`. Vergleichen Sie nicht `ex.CancellationToken` mit dem verknüpften Token -- `ex.CancellationToken` enthält das Token, das als erstes ausgelöst hat (Aufrufer, Timeout oder verknüpft), was je nach Race Condition variiert.

## Task.WaitAsync für Code ohne Token-Parameter

Nicht jede API akzeptiert ein `CancellationToken`. .NET 6 hat `Task.WaitAsync` für diesen Fall eingeführt:

```csharp
// .NET 11, C# 14 -- Wrapping einer tokenfreien Legacy-API
Task<string> slowWork = LegacyApiAsync();

try
{
    string result = await slowWork.WaitAsync(TimeSpan.FromSeconds(5));
}
catch (TimeoutException)
{
    // Deadline abgelaufen. slowWork LÄUFT NOCH im Hintergrund.
    Console.WriteLine("Warten nach 5 Sekunden aufgegeben.");
}
```

`WaitAsync(TimeSpan)` wirft `TimeoutException` (nicht `OperationCanceledException`) und bricht den zugrundeliegenden `Task` nicht ab. Die Arbeit läuft weiter, bis sie von selbst abgeschlossen wird. Verwenden Sie `WaitAsync` nur, wenn Sie dem aufgerufenen Code kein Token übergeben können; der Ressourcenverbrauch setzt sich in jedem Fall fort.

Eine kombinierte Überladung akzeptiert sowohl eine Deadline als auch ein `CancellationToken`:

```csharp
// .NET 11, C# 14 -- abbrechbar UND zeitbegrenzt
await slowWork.WaitAsync(TimeSpan.FromSeconds(5), callerToken);
```

Diese Überladung wirft `TimeoutException`, wenn die Deadline zuerst abläuft, oder `TaskCanceledException` (eine Unterklasse von `OperationCanceledException`), wenn das Token zuerst ausgelöst wird.

## Bestehenden Timeout zurücksetzen und deaktivieren

`CancelAfter` kann mehrfach aufgerufen werden. Jeder Aufruf ersetzt die zuvor geplante Deadline:

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();
cts.CancelAfter(TimeSpan.FromSeconds(10));   // anfängliche Deadline: 10s

// Verlängern: Timer mit einem 5-Sekunden-Fenster ab jetzt neu starten
cts.CancelAfter(TimeSpan.FromSeconds(5));

// Timeout vollständig deaktivieren, ohne den CTS abzubrechen:
cts.CancelAfter(Timeout.InfiniteTimeSpan);   // löst nicht mehr aus
```

`Timeout.InfiniteTimeSpan` entspricht `-1` Millisekunden, was den internen Timer deaktiviert, ohne den CTS in den abgebrochenen Zustand zu versetzen.

Sobald ein CTS abgebrochen wurde, hat der Aufruf von `CancelAfter` keine Wirkung. Prüfen Sie zuerst `IsCancellationRequested`, wenn ein Abbruch möglicherweise bereits stattgefunden hat.

## TryReset für Pooling

In Hochdurchsatz-Code, der viele kurze Operationen ausführt, erzeugt das Erstellen einer neuen `CancellationTokenSource` pro Anfrage Speicherzuweisungen. .NET 6 hat `TryReset` für die Wiederverwendung eingeführt:

```csharp
// .NET 11, C# 14 -- gepooltes CTS-Muster
private CancellationTokenSource _cts = new();

public async Task ProcessRequestAsync()
{
    if (!_cts.TryReset())
        _cts = new CancellationTokenSource();

    _cts.CancelAfter(TimeSpan.FromSeconds(5));

    await DoWorkAsync(_cts.Token);
}
```

`TryReset` gibt `true` zurück, wenn der CTS nicht abgebrochen wurde und sicher wiederverwendet werden kann; `false`, wenn er abgebrochen wurde und eine neue Instanz benötigt wird. Es ist nicht Thread-sicher bei gleichzeitigen Abbruchanforderungen -- rufen Sie es nur auf, nachdem die vorherige Operation abgeschlossen wurde, von einem einzigen Eigentümer. ASP.NET Core verwendet dieses Muster intern in Kestrel.

## Testbare Timeouts mit TimeProvider

Auf echte 5 Sekunden in einem Unit-Test zu warten ist langsam und unzuverlässig. `TimeProvider`, in .NET 8 eingeführt und in .NET 11 stabil, macht den internen Timer injizierbar:

```csharp
// .NET 11, C# 14
public async Task<string> FetchAsync(
    string url,
    TimeProvider? clock = null)
{
    clock ??= TimeProvider.System;
    using var cts = clock.CreateCancellationTokenSource(TimeSpan.FromSeconds(5));

    using HttpClient http = new();
    return await http.GetStringAsync(url, cts.Token);
}
```

Injizieren Sie in Tests `FakeTimeProvider` aus dem NuGet-Paket `Microsoft.Extensions.TimeProvider.Testing`:

```csharp
// xUnit, .NET 11, C# 14
[Fact]
public async Task FetchAsync_ThrowsOnTimeout()
{
    var clock = new FakeTimeProvider();
    Task<string> fetch = FetchAsync("https://slow.example.com", clock);

    clock.Advance(TimeSpan.FromSeconds(10));  // 10 Sekunden sofort vorspulen

    await Assert.ThrowsAsync<OperationCanceledException>(() => fetch);
}
```

Die Stornierung wird synchron ausgelöst, wenn Sie die Uhr vorspulen. Kein `Task.Delay`. Kein instabiles Test-Timing.

## CTS entsorgen

`CancellationTokenSource` implementiert `IDisposable`, nicht `IAsyncDisposable`. Es gibt kein `DisposeAsync`. Wenn Sie `CancelAfter` aufrufen, wird ein Timer in der Timer-Warteschlange des Thread-Pools registriert. Dieser Timer hält eine Referenz auf den CTS und verhindert die Garbage Collection, bis er auslöst.

Entsorgen Sie immer:

```csharp
// Korrekt: garantierte Bereinigung auch bei einer Ausnahme
using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
await DoWorkAsync(cts.Token);
// cts.Dispose() wird hier aufgerufen; der Timer wird abgebrochen und freigegeben
```

Die Entsorgung bricht den ausstehenden Timer ab, gibt Wait-Handles frei und entfernt den CTS aus jeder `CreateLinkedTokenSource`-Kette, zu der er gehört. Auf einem Server, der Tausende gleichzeitiger Anfragen verarbeitet, führen verlorene CTS-Instanzen zur Timer-Ansammlung.

## Häufige Fallstricke

**HttpClient.Timeout konkurriert mit Ihrem Token.** `HttpClient.Timeout` hat standardmäßig 100 Sekunden. Wenn Sie auch ein Token mit `CancelAfter` übergeben, laufen beide Timer. Wenn `HttpClient.Timeout` auslöst, wirft es `TaskCanceledException`, wobei `ex.InnerException is TimeoutException`; wenn Ihr Token auslöst, wirft es `OperationCanceledException`, wobei `ex.CancellationToken == cts.Token`. Deaktivieren Sie eines: setzen Sie entweder `HttpClient.Timeout` auf `Timeout.InfiniteTimeSpan` und verwalten Sie die Deadline selbst, oder verlassen Sie sich auf `HttpClient.Timeout` und verzichten Sie auf den manuellen CTS. Weitere Informationen finden Sie unter [Fix: TaskCanceledException in HttpClient](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

**CancelAfter nach Cancel hat keine Wirkung.** Sobald ein CTS abgebrochen wurde, hat der Aufruf von `CancelAfter` keine Wirkung. Abbruch ist ein einseitiger Übergang.

**Marshaling auf den UI-Thread.** Bei WinForms, WPF oder MAUI läuft die Fortsetzung nach einem abgebrochenen `await` auf dem Thread-Pool-Thread, der den Abschluss aufgreift -- nicht auf dem UI-Thread. Wenn Sie UI-Elemente im Catch-Block aktualisieren, wechseln Sie explizit zurück. In ASP.NET Core ist kein `SynchronizationContext` installiert, daher hat [ConfigureAwait(false) keine Wirkung](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/).

**Teilen Sie ein Token nicht unbeabsichtigt zwischen parallelen Zweigen.** Wenn Sie Arbeit mit `Task.WhenAll` verteilen und dasselbe `cts.Token` an alle Zweige übergeben, bricht der erste Abbruch alle anderen ab. Das ist in der Regel das Gewünschte für eine gemeinsame Deadline, aber seien Sie sich dessen bewusst.

## Verwandte Artikel

- Ein einzelnes `CancellationToken` durch jede asynchrone Schicht weiterleiten: [So leiten Sie ein CancellationToken durch asynchrone Methoden in .NET 11 weiter](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- Manueller Abbruch ohne Deadline: [So bricht man einen lang laufenden Task in C# ohne Deadlock ab](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- Drei Ursachen, warum HttpClient TaskCanceledException wirft: [Fix: TaskCanceledException in HttpClient](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- ConfigureAwait(false) in Bibliothekscode: [ConfigureAwait(false) vs. Standard in .NET 11](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- async void vs. async Task -- welches Ausnahmen weiterleiten kann: [async void vs. async Task in C#: wann welches korrekt ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)

## Quellen

- [CancellationTokenSource.CancelAfter -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelafter)
- [CancellationTokenSource.TryReset -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.tryreset)
- [Task.WaitAsync -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync)
- [TimeProvider.CreateCancellationTokenSource -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider.createcancellationtokensource)
- [Microsoft.Extensions.TimeProvider.Testing auf NuGet](https://www.nuget.org/packages/Microsoft.Extensions.TimeProvider.Testing)
