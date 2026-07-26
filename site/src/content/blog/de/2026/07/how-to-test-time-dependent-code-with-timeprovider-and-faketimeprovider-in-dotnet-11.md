---
title: "Zeitabhängigen Code mit TimeProvider und FakeTimeProvider in .NET 11 testen"
description: "Ersetzen Sie DateTime.UtcNow, Stopwatch und Task.Delay durch System.TimeProvider, damit Tests die Uhr steuern: Registrierung per Dependency Injection, FakeTimeProvider.Advance und SetUtcNow, Tests für Timeouts und einen PeriodicTimer-basierten BackgroundService sowie die Stolperfallen mit Advance-Fortsetzungen und xUnit v2."
pubDate: 2026-07-26
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "testing"
  - "async"
  - "timeprovider"
lang: "de"
translationOf: "2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-26
---

Um zeitabhängigen Code in .NET 11 zu testen, rufen Sie `DateTime.UtcNow`, `Stopwatch` und `Task.Delay(...)` nicht mehr direkt auf, sondern nehmen einen `System.TimeProvider` über den Konstruktor entgegen. In der Produktion registrieren Sie `TimeProvider.System` als Singleton; im Test übergeben Sie einen `FakeTimeProvider` aus dem Paket `Microsoft.Extensions.TimeProvider.Testing` und steuern die Uhr selbst mit `Advance(TimeSpan)` und `SetUtcNow(DateTimeOffset)`. Eine Prüfung auf abgelaufene Testphase, die früher 14 Tage Wartezeit brauchte, wird zu einem zweizeiligen Test. Dieser Beitrag behandelt das gesamte Muster unter .NET 11 (zum Zeitpunkt des Schreibens Preview 6, finale Version im November 2026) mit C# 14 und `Microsoft.Extensions.TimeProvider.Testing` 10.8.0, einschließlich der schmerzhaften Stellen: mehrere Timer-Perioden auf einmal überspringen, Fortsetzungen die nach `Advance` nicht laufen, und die Blockade durch den Synchronisationskontext von xUnit v2.

`TimeProvider` kam mit .NET 8 in die Box (`System.Runtime.dll`), daher läuft hier alles unverändert auch auf .NET 8, 9 und 10. Für .NET Framework 4.6.2+, .NET 5-7 und netstandard2.0 gibt es das Paket `Microsoft.Bcl.TimeProvider`, mit einem API-Unterschied, der am Ende behandelt wird.

## Warum eine statische Uhr einen Test unausführbar macht

Diesen Code hat jede Codebasis irgendwo:

```csharp
// .NET 11, C# 14 -- untestable
public sealed class TrialService
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        DateTimeOffset.UtcNow - user.SignedUpAt >= TrialLength;
}
```

`DateTimeOffset.UtcNow` ist eine statische Eigenschaft, hinter der die Uhr des Betriebssystems steht. Es gibt keine Nahtstelle. Um den Ablaufzweig auszuführen, bleiben drei schlechte Möglichkeiten: zwei Wochen warten, `user.SignedUpAt` zurückdatieren (was die Subtraktion prüft, aber nie den Moment des Übergangs), oder zu einem Mocking-Framework greifen, das statische Member patcht und dabei einen Profiler-basierten Interceptor mitbringt, der die gesamte Suite verlangsamt.

An der Grenze wohnen die Fehler. Ist Tag 14 abgelaufen oder noch aktiv? Was passiert genau bei `SignedUpAt + 14 days`? Und bei der Sommerzeitumstellung in der lokalen Zone des Nutzers? Keine dieser Fragen ist beantwortbar, solange die Uhr der Maschine gehört.

## Was TimeProvider tatsächlich abstrahiert

`TimeProvider` ist eine abstrakte Klasse mit fünf Fähigkeiten, und es lohnt sich, alle zu kennen, denn die meisten übernehmen nur die erste:

- `GetUtcNow()` und `GetLocalNow()` liefern ein `DateTimeOffset`. Das ersetzt `DateTimeOffset.UtcNow` und `DateTime.Now`.
- `GetTimestamp()` liefert einen hochfrequenten Tick-Zähler, und `GetElapsedTime(long)` / `GetElapsedTime(long, long)` machen daraus eine `TimeSpan`. Das ersetzt `Stopwatch`.
- `CreateTimer(TimerCallback, object?, TimeSpan, TimeSpan)` liefert einen `ITimer`. Das ersetzt `System.Threading.Timer`.
- `LocalTimeZone` liefert ein `TimeZoneInfo`. Das ersetzt `TimeZoneInfo.Local`.
- `TimestampFrequency` meldet die Tick-Rate hinter `GetTimestamp()`.

Die Standardimplementierung ist die statische Eigenschaft `TimeProvider.System`: UTC kommt aus `DateTimeOffset.UtcNow`, die Zone aus `TimeZoneInfo.Local`, Zeitstempel aus `Stopwatch` und Timer aus `System.Threading.Timer`. Ihr Einsatz kostet gegenüber den rohen APIs nichts, denn sie ist eine dünne Weiterleitungsschicht über genau diesen Aufrufen.

`CreateTimer` ist deshalb wichtig, weil die BCL `TimeProvider` auch in die asynchronen Primitiven eingebaut hat. Diese Überladungen nehmen einen `TimeProvider` entgegen und leiten ihren internen Timer darüber:

- `Task.Delay(TimeSpan, TimeProvider)` und `Task.Delay(TimeSpan, TimeProvider, CancellationToken)`
- `Task.WaitAsync(TimeSpan, TimeProvider)` und die Überladung mit `CancellationToken`
- `new CancellationTokenSource(TimeSpan, TimeProvider)`
- `new PeriodicTimer(TimeSpan, TimeProvider)`

Eine Retry-Schleife mit Backoff, eine Anfragefrist und ein pollender Hintergrunddienst sind damit alle aus einem Test heraus steuerbar, ohne ein einziges `Thread.Sleep`.

## Schritte, um eine zeitabhängige Klasse testbar zu machen

1. Fügen Sie der Klasse, die die Uhr liest, einen `TimeProvider`-Konstruktorparameter hinzu. Geben Sie ihm keinen Standardwert `TimeProvider.System`, sonst bleibt der untestbare Pfad versehentlich erreichbar.
2. Ersetzen Sie in dieser Klasse jedes `DateTime.UtcNow`, `DateTimeOffset.Now`, `Stopwatch.StartNew()`, `new Timer(...)` und nacktes `Task.Delay(...)` durch das `TimeProvider`-Äquivalent.
3. Registrieren Sie die echte Uhr in der Composition Root: `builder.Services.AddSingleton(TimeProvider.System);`.
4. Fügen Sie dem Testprojekt `Microsoft.Extensions.TimeProvider.Testing` hinzu.
5. Erzeugen Sie in jedem Test einen `FakeTimeProvider`, fixieren Sie den Startzeitpunkt und bewegen Sie die Uhr zwischen den Assertions mit `Advance` oder `SetUtcNow`.

Der Rest dieses Beitrags führt jeden dieser Schritte in lauffähigem Code aus.

## Den Dienst so umschreiben, dass er eine Uhr entgegennimmt

```csharp
// .NET 11, C# 14
public sealed class TrialService(TimeProvider timeProvider)
{
    private static readonly TimeSpan TrialLength = TimeSpan.FromDays(14);

    public bool IsTrialExpired(User user) =>
        timeProvider.GetUtcNow() - user.SignedUpAt >= TrialLength;
}
```

Das ist die gesamte Produktionsänderung. Der primäre Konstruktor hält den Provider fest, und der einzige Unterschied an der Aufrufstelle ist `timeProvider.GetUtcNow()` statt `DateTimeOffset.UtcNow`.

Die Registrierung ist eine Zeile, denn `TimeProvider.System` ist ein Singleton, das sich gefahrlos in der gesamten Anwendung teilen lässt:

```csharp
// .NET 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddScoped<TrialService>();

var app = builder.Build();
```

Die Komponenten von ASP.NET Core suchen selbst bereits nach dieser Registrierung. Seit .NET 8 ist `ISystemClock` im gesamten Authentifizierungs- und Identity-Stack veraltet, und die Options-Klassen bieten stattdessen eine setzbare `TimeProvider`-Eigenschaft, die aus dem Container aufgelöst wird, sobald eine registriert ist. `TimeProvider.System` zu registrieren macht damit auch die Gültigkeitsprüfung von Tokens und den Ablauf von Cookies testbar.

## Der erste Test mit FakeTimeProvider

```
dotnet add package Microsoft.Extensions.TimeProvider.Testing
```

Version 10.8.0 ist Stand Juli 2026 aktuell. Sie zielt auf .NET 8.0 und höher sowie .NET Framework 4.6.2 und höher und bringt auf modernem .NET keine Abhängigkeiten mit.

```csharp
// .NET 11, C# 14, xUnit v3, Microsoft.Extensions.TimeProvider.Testing 10.8.0
using Microsoft.Extensions.Time.Testing;

public class TrialServiceTests
{
    [Fact]
    public void Trial_is_active_on_day_13_and_expired_on_day_14()
    {
        var time = new FakeTimeProvider(
            new DateTimeOffset(2026, 7, 26, 12, 0, 0, TimeSpan.Zero));

        var user = new User(SignedUpAt: time.GetUtcNow());
        var sut = new TrialService(time);

        time.Advance(TimeSpan.FromDays(13));
        Assert.False(sut.IsTrialExpired(user));

        time.Advance(TimeSpan.FromDays(1));
        Assert.True(sut.IsTrialExpired(user));
    }
}
```

Kein Schlafen, kein Zurückdatieren, und die Grenze bei Tag 14 wird explizit geprüft. Drei Details von `FakeTimeProvider` sollten Sie jetzt verinnerlichen:

**Der parameterlose Konstruktor startet um Mitternacht am 1. Januar 2000 UTC.** Das ist Absicht: ein fixer, offensichtlich synthetischer Zeitpunkt, der nie zufällig auf "heute" fällt. Übergeben Sie dem Konstruktor ein `DateTimeOffset`, wenn das Datum selbst Teil des geprüften Verhaltens ist, etwa ein Schalttag oder ein Monatsende.

**`LocalTimeZone` ist standardmäßig `TimeZoneInfo.Utc`, nicht die Zone der Maschine.** `GetLocalNow()` entspricht also `GetUtcNow()`, bis Sie `SetLocalTimeZone(...)` aufrufen. Genau das macht zonenabhängige Tests auf einem Build-Agent in einer anderen Region als Ihrem Rechner deterministisch:

```csharp
// .NET 11, C# 14 -- pin the zone so a CI agent in UTC behaves like a user in Bucharest
var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 25, 3, 30, 0, TimeSpan.Zero));
time.SetLocalTimeZone(TimeZoneInfo.FindSystemTimeZoneById("Europe/Bucharest"));

Assert.Equal(new TimeSpan(2, 0, 0), time.GetLocalNow().Offset); // after the DST fall-back
```

**`SetUtcNow` bewegt sich nur vorwärts.** Ein Wert vor der aktuellen Zeit wirft eine `ArgumentOutOfRangeException` mit der Meldung "Cannot go back in time.". Wenn Sie wirklich einen Operator oder einen NTP-Daemon simulieren müssen, der die Uhr zurückstellt, verwenden Sie `AdjustTime(DateTimeOffset)`. `AdjustTime` verschiebt die aktuelle Zeit, ohne ausstehende Timer auszulösen, und verschiebt den Weckzeitpunkt jedes ausstehenden Timers um dasselbe Delta, genau wie es eine echte Änderung der Systemuhr tut.

## Ein Timeout testen, statt darauf zu warten

Die interessanten Fälle sind nicht Zeitstempel, sondern Wartezeiten. Eine Retry-Strategie mit exponentiellem Backoff braucht normalerweise Sekunden echter Zeit im Test. Leiten Sie ihr Warten über den Provider, und es dauert Mikrosekunden:

```csharp
// .NET 11, C# 14
public sealed class RetryingFetcher(HttpClient http, TimeProvider timeProvider)
{
    public async Task<string> FetchAsync(string url, CancellationToken ct = default)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                return await http.GetStringAsync(url, ct);
            }
            catch (HttpRequestException) when (attempt < 3)
            {
                var backoff = TimeSpan.FromSeconds(Math.Pow(2, attempt));
                await Task.Delay(backoff, timeProvider, ct);
            }
        }
    }
}
```

Fristen funktionieren genauso. `new CancellationTokenSource(TimeSpan, TimeProvider)` liefert eine Token-Quelle, deren interner Timer von der gefälschten Uhr getrieben wird, sodass das gesamte `CancelAfter`-Muster zur Durchsetzung einer asynchronen Frist prüfbar wird:

```csharp
// .NET 11, C# 14
[Fact]
public async Task Deadline_fires_after_five_seconds()
{
    var time = new FakeTimeProvider();
    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5), time);

    Assert.False(cts.IsCancellationRequested);

    time.Advance(TimeSpan.FromSeconds(5));

    Assert.True(cts.IsCancellationRequested);
}
```

## Einen BackgroundService testen, der über einen Timer pollt

Ein Polling-Worker auf Basis von `PeriodicTimer` ist die klassische Komponente, die "wir nicht unit-testen". Mit der `TimeProvider`-Überladung ist er ganz gewöhnlicher Code:

```csharp
// .NET 11, C# 14
public sealed class ExpiryWorker(IExpiryStore store, TimeProvider timeProvider)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5), timeProvider);

        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await store.PurgeExpiredAsync(timeProvider.GetUtcNow(), stoppingToken);
        }
    }
}
```

Der Test hat eine Feinheit: Der Worker muss `WaitForNextTickAsync` erreichen und seinen Timer registrieren, bevor Sie vorspulen, sonst spulen Sie an einem Tick vorbei, der nie geplant wurde. Lösen Sie das nicht mit `Thread.Sleep`. Geben Sie zuerst die Kontrolle ab, spulen Sie dann vor und warten Sie danach auf ein Signal, dass die Arbeit tatsächlich stattgefunden hat:

```csharp
// .NET 11, C# 14, xUnit v3
[Fact]
public async Task Worker_purges_once_per_five_minute_tick()
{
    var time = new FakeTimeProvider();
    var store = new RecordingExpiryStore(); // sets a TaskCompletionSource on each call
    var worker = new ExpiryWorker(store, time);

    await worker.StartAsync(CancellationToken.None);
    await Task.Yield(); // let ExecuteAsync reach WaitForNextTickAsync

    time.Advance(TimeSpan.FromMinutes(5));
    await store.NextPurge; // completes when PurgeExpiredAsync is entered

    Assert.Equal(1, store.PurgeCount);

    await worker.StopAsync(CancellationToken.None);
}
```

Auf ein Signal zu warten, das der Produktionscode auslöst, statt auf reale Zeit, bewahrt diesen Test davor, auf einem ausgelasteten CI-Agent instabil zu werden. Dieselbe Disziplin gilt, wenn der getestete Worker [Scoped Services innerhalb eines BackgroundService](/de/2026/05/how-to-use-scoped-services-inside-a-backgroundservice-in-aspnetcore-11/) verwendet: Den Scope innerhalb der Schleife auflösen und dann gegen das prüfen, was der Scope erzeugt hat.

## Advance löst periodische Timer einmal pro vergangener Periode aus

Das ist das Verhalten, das die meisten überrascht. `FakeTimeProvider.Advance` geht seine Warteliste durch, ruft jeden Callback auf, dessen Weckzeitpunkt überschritten ist, und addiert bei einem periodischen Timer die Periode auf den Weckzeitpunkt, um erneut zu prüfen. Ein einziger Aufruf löst einen Fünf-Minuten-Timer somit zwölfmal aus:

```csharp
// .NET 11, C# 14 -- twelve ticks, not one
time.Advance(TimeSpan.FromHours(1)); // PeriodicTimer period = 5 minutes
```

Für `PeriodicTimer` bedeutet das nicht zwölf Schleifendurchläufe, weil `WaitForNextTickAsync` Ticks zusammenfasst, die eintreffen, während niemand wartet. Bei einem rohen `ITimer` aus `CreateTimer` mit einer nicht unendlichen Periode erhalten Sie dagegen zwölf Callback-Aufrufe, synchron, auf dem Thread, der `Advance` aufgerufen hat. Wenn Sie genau einen Tick wollen, spulen Sie um genau eine Periode vor.

Der synchrone Teil ist aus einem zweiten Grund relevant: Jede Ausnahme aus einem Timer-Callback fliegt aus Ihrem `Advance`-Aufruf heraus und nicht auf einem Hintergrund-Thread, wo sie verschluckt würde. Das ist meist ein Geschenk, bedeutet aber, dass eine `Advance`-Zeile einen Assertion-Fehler aus Code werfen kann, der mehrere Schichten entfernt liegt.

## Fortsetzungen, die nach Advance nicht laufen

Das mit Abstand am häufigsten gemeldete Problem mit `FakeTimeProvider` ist ein Test, der nach `Advance` hängt oder zu früh prüft, erfasst als [dotnet/extensions#5326](https://github.com/dotnet/extensions/issues/5326). Die Form sieht so aus:

```csharp
// .NET 11, C# 14 -- flaky: the continuation may not have run yet
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
Assert.True(delayTask.IsCompleted); // not guaranteed
```

`Advance` schließt den zugrunde liegenden Task ab, aber die Fortsetzung, die ein `await` an anderer Stelle angehängt hat, wird eingeplant und nicht inline ausgeführt. Die Lösung ist, auf das zu warten, was Sie interessiert, statt ein Flag abzufragen:

```csharp
// .NET 11, C# 14 -- deterministic
var delayTask = Task.Delay(TimeSpan.FromSeconds(30), time);
time.Advance(TimeSpan.FromSeconds(30));
await delayTask; // returns immediately, and orders the continuation
```

In vielen Beispielen sehen Sie `await Task.Delay(1)` nach `Advance`. Das funktioniert, weil es dem Scheduler eine echte Runde gibt, führt aber eine Echtzeitabhängigkeit in einen Test zurück, dessen ganzer Zweck es war, eine solche zu beseitigen. Warten Sie stattdessen auf die Operation, oder auf eine `TaskCompletionSource`, die der Produktionscode abschließt.

Die verwandte Falle ist `AutoAdvanceAmount`. Wird sie gesetzt, rückt die Uhr bei jedem *Lesen* von `GetUtcNow()` oder `GetTimestamp()` vor, was für Code praktisch ist, der die verstrichene Zeit zwischen zwei Lesevorgängen misst:

```csharp
// .NET 11, C# 14 -- every clock read advances by 100ms
var time = new FakeTimeProvider { AutoAdvanceAmount = TimeSpan.FromMilliseconds(100) };

long start = time.GetTimestamp();
long end = time.GetTimestamp();

Assert.Equal(TimeSpan.FromMilliseconds(100), time.GetElapsedTime(start, end));
```

Aber Auto-Advance treibt keine Timer an, weil niemand stellvertretend für einen Timer die Uhr liest. Ein `Task.Delay(TimeSpan, TimeProvider)` wird durch Auto-Advance allein nie abgeschlossen; Sie brauchen weiterhin ein explizites `Advance`. Diese Unterscheidung sollte man kennen, bevor man einen Nachmittag daran verliert.

## Die Blockade durch den Synchronisationskontext von xUnit v2

Wenn Ihr Testprojekt noch auf xUnit v2 läuft und der geprüfte Code `ConfigureAwait(false)` verwendet, kann ein `FakeTimeProvider`-Test in einen Deadlock geraten. xUnit v2 installiert für die Dauer jedes Tests einen `AsyncTestSyncContext`, und das Zusammenspiel dieses Kontexts mit den inline ausgeführten Timer-Callbacks lässt den Test dauerhaft stehen. Das README des Pakets dokumentiert die Umgehung:

```csharp
// .NET 11, C# 14 -- xUnit v2 only
SynchronizationContext.SetSynchronizationContext(null);
```

Setzen Sie das an den Anfang des betroffenen Tests oder in den Konstruktor der Fixture. xUnit v3 hat `AsyncTestSyncContext` vollständig entfernt, dort existiert das Problem nicht. Wer für ein neues Projekt ein Test-Framework auswählt, hat damit ein weiteres kleines Argument für v3.

## Was Sie nicht umstellen sollten

`TimeProvider` ist eine Nahtstelle, keine Religion. Zwei Regeln verhindern, dass er sich überall ausbreitet:

Injizieren Sie ihn in die Klasse, die eine *Entscheidung* auf Basis der Zeit trifft, nicht in jede Klasse, die zufällig einen Zeitstempel weiterreicht. Ein DTO mit einem `CreatedAt` braucht keine Uhr; die Factory, die ihn setzt, schon.

Lesen Sie die Uhr nicht zweimal in derselben Methode und erwarten dabei denselben Wert. `timeProvider.GetUtcNow()` ist ein Methodenaufruf und keine zwischengespeicherte Eigenschaft, und mit gesetztem `AutoAdvanceAmount` liefert er bewusst jedes Mal etwas anderes. Lesen Sie einmal in eine lokale Variable und arbeiten Sie mit dieser, was auch bei `DateTime.UtcNow` gute Praxis ist und hier zur Korrektheitsanforderung wird.

Auf .NET Framework und netstandard2.0 über `Microsoft.Bcl.TimeProvider` existieren die asynchronen Überladungen schließlich nicht als Instanzmethoden. Nutzen Sie dort die Erweiterungsmethoden aus `System.Threading.Tasks.TimeProviderTaskExtensions`: `timeProvider.Delay(...)`, `timeProvider.CreateCancellationTokenSource(...)` und `task.WaitAsync(timeout, timeProvider, ct)`. Das Verhalten ist identisch; nur die Aufrufform unterscheidet sich, sodass eine Bibliothek mit mehreren Zielframeworks ein kleines `#if` oder einen gemeinsamen Helper braucht.

## Verwandte Beiträge

- Die Timeout-Mechanik, die dieser Beitrag testbar macht, ist vollständig im Leitfaden zum [Durchsetzen einer asynchronen Frist mit CancellationTokenSource.CancelAfter](/de/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/) beschrieben.
- Jeder dieser Tests hängt davon ab, dass ein Token die Operation erreicht, worum es beim [Weiterreichen eines CancellationToken durch asynchrone Methoden](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) geht.
- Wenn der geprüfte Code eine echte Datenbank statt einer gefälschten Uhr braucht, siehe [Integrationstests gegen einen echten SQL Server mit Testcontainers](/de/2026/05/how-to-write-integration-tests-against-real-sql-server-with-testcontainers/).
- Wo die Polling-Schleife überhaupt leben soll, behandelt [BackgroundService vs IHostedService vs Hangfire](/de/2026/06/backgroundservice-vs-ihostedservice-vs-hangfire-for-background-jobs-in-dotnet-11/).
- Blockierendes Warten auf einen asynchronen Aufruf ist der schnellste Weg, einen `FakeTimeProvider`-Test aus Gründen hängen zu lassen, die nichts mit der Uhr zu tun haben: siehe [den Deadlock beim Aufruf von .Result oder .Wait()](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

## Quellen

- [TimeProvider Class](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider) auf Microsoft Learn
- [What is the TimeProvider class](https://learn.microsoft.com/en-us/dotnet/standard/datetime/timeprovider-overview) in der .NET-Grundlagendokumentation
- [FakeTimeProvider-API-Referenz](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.time.testing.faketimeprovider)
- [README von Microsoft.Extensions.TimeProvider.Testing](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/README.md) in dotnet/extensions
- [Quellcode von FakeTimeProvider.cs](https://github.com/dotnet/extensions/blob/main/src/Libraries/Microsoft.Extensions.TimeProvider.Testing/FakeTimeProvider.cs)
- [dotnet/extensions#5326: Fortsetzungen von Task.Delay laufen nicht, wenn Advance aufgerufen wird](https://github.com/dotnet/extensions/issues/5326)
- [Breaking Change: ISystemClock ist veraltet](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnet-core/8.0/isystemclock-obsolete)
