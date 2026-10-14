---
title: "Thread.Sleep vs Task.Delay vs SpinWait zum Warten in C#"
description: "Verwenden Sie await Task.Delay für jedes zeitgesteuerte Warten in asynchronem Code, Thread.Sleep nur auf einem eigenen, dedizierten Thread und SpinWait nur für Wartezeiten unter einer Mikrosekunde in lock-freiem Code. Um auf eine Bedingung zu warten, nutzen Sie ein Signal (ManualResetEventSlim, SemaphoreSlim, TaskCompletionSource) statt einer der drei Varianten. Gemessen auf .NET 10.0.10."
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "async"
  - "performance"
lang: "de"
translationOf: "2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-14
---

Für eine zeitgesteuerte Pause verwenden Sie in jedem asynchronen Code `await Task.Delay(...)`, weil es den Thread während des Wartens freigibt. Nutzen Sie `Thread.Sleep` nur auf einem Thread, den Sie selbst erzeugt haben (eine Konsolenschleife, ein dedizierter Worker), niemals auf einem Thread-Pool- oder UI-Thread. Nutzen Sie `SpinWait` nur, wenn das Warten voraussichtlich innerhalb weniger Mikrosekunden endet, typischerweise in lock-freiem Code. Und wenn Sie eigentlich auf **ein Ereignis** warten und nicht darauf, dass Zeit vergeht, ist keines der drei das richtige Werkzeug: Verwenden Sie ein Signal wie `ManualResetEventSlim`, `SemaphoreSlim` oder eine `TaskCompletionSource`, die in meinen Messungen etwa 50-mal schneller aufwachten als jede Polling-Schleife.

Jede Zahl in diesem Beitrag wurde auf .NET 10.0.10 (SDK 10.0.302), C# 14, auf einem Apple M4 mit 10 Kernen unter macOS 26.6 gemessen. Die APIs selbst haben sich seit Jahren nicht geändert: `Task.Delay` gibt es seit .NET Framework 4.5, `SpinWait` seit 4.0, und alles hier gilt genauso für .NET 8, 9 und die .NET-11-Previews.

## Der Vergleich auf einen Blick

| | `Thread.Sleep` | `await Task.Delay` | `SpinWait` |
| --- | --- | --- | --- |
| Hält den Thread beim Warten | Ja, blockiert | Nein, der Thread geht zurück an den Pool | Ja, läuft oder gibt die Zeitscheibe ab |
| CPU beim Warten (500 ms, gemessen) | 0 ms | 0 ms | 4 ms mit `SpinUntil`, 500 ms mit `SpinOnce(-1)` |
| Kürzeste reale Wartezeit (`1` ms angefordert, macOS) | ~1,5 ms | ~1,3 ms | ~1 us pro frühem Spin |
| Kürzeste reale Wartezeit unter Windows (Standard-Timer) | ~1-15,6 ms | ~15,6 ms | ~1 us pro frühem Spin |
| Abbrechbar | Nein | Ja, über `CancellationToken` | Nur über Ihre eigene Bedingung |
| Mit simulierter Zeit testbar | Nein | Ja, `Task.Delay(TimeSpan, TimeProvider)` (.NET 8+) | Nein |
| Sicher auf einem Thread-Pool-Thread | Nein | Ja | Nur für Mikrosekunden |
| Sicher auf einem UI-Thread | Nein, friert die UI ein | Ja | Nein |
| Typischer Einsatz | Schleifen auf dedizierten Threads, kleine Konsolenwerkzeuge | Retry-Backoff, Drosselung, Polling in asynchronem Code | Lock-freie Retry-Schleifen, Spin-dann-blockieren-Primitive |

## Was jede Variante mit Ihrem Thread macht

`Thread.Sleep(ms)` suspendiert den aufrufenden OS-Thread. Der Scheduler nimmt ihn von der CPU und berücksichtigt ihn erst wieder, wenn das Intervall abgelaufen ist. Es wird keine CPU verbraucht, aber der Thread existiert weiterhin, hält seinen Stack und kann nichts anderes tun. Das ist in Ordnung für einen Thread, dessen einzige Aufgabe das Warten ist. Es ist ein Problem für einen Thread, der zu einer gemeinsam genutzten Ressource gehört.

`Task.Delay(ms)` gibt einen `Task` zurück, der abgeschlossen wird, wenn ein interner `TimerQueueTimer` auslöst. Wenn Sie ihn mit `await` abwarten, kehrt Ihre Methode zum Aufrufer zurück, der Thread geht zurück an den Pool (oder zurück in die UI-Nachrichtenschleife), und der Rest der Methode wird als Continuation eingeplant, sobald der Timer auslöst. Solange die Verzögerung aussteht, ist Ihrer Methode überhaupt kein Thread zugeordnet.

`SpinWait` hält den Thread auf der CPU und prüft erneut. Es ist ein Struct mit einer wichtigen Methode, `SpinOnce()`, und sein Verhalten hängt davon ab, wie oft Sie sie aufgerufen haben. Im [.NET-10-Quellcode](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs) lauten die Konstanten `YieldThreshold = 10`, `Sleep0EveryHowManyYields = 5` und `DefaultSleep1Threshold = 20`:

- Die Aufrufe 0 bis 9 führen `Thread.SpinWait(n)` aus, eine Busy-Schleife aus CPU-Pause-Befehlen, die mit jeder Iteration wächst.
- Ab Aufruf 10 gibt jeder zweite Aufruf die Zeitscheibe mit `Thread.Yield()` oder `Thread.Sleep(0)` ab.
- Ab Aufruf 20 führt jeder Aufruf `Thread.Sleep(1)` aus.
- Auf einem Einprozessorsystem wird das Spinnen komplett übersprungen und ab dem ersten Aufruf die Zeitscheibe abgegeben, denn Spinnen verzögert dort nur den Thread, auf den Sie warten.

"`SpinWait`" ist also weniger ein Spin als eine Eskalationsleiter. Dieses Detail entscheidet über die meisten der folgenden Abwägungen.

## Gemessen: Wie lange dauert "1 ms warten" wirklich?

Dieser Test misst 200 Aufrufe von jedem und gibt den Median und das 99. Perzentil aus:

```csharp
// .NET 10.0.10, C# 14, dotnet run probe.cs
using System.Diagnostics;

foreach (var ms in new[] { 0, 1, 10, 15 })
{
    var sleep = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        Thread.Sleep(ms);
        sleep.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    var delay = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        await Task.Delay(ms);
        delay.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    sleep.Sort(); delay.Sort();
    Console.WriteLine($"{ms} ms: Sleep p50={sleep[100]:F3} | Delay p50={delay[100]:F3}");
}
```

| Angefordert | `Thread.Sleep` p50 | `Thread.Sleep` p99 | `Task.Delay` p50 | `Task.Delay` p99 |
| --- | --- | --- | --- | --- |
| 0 ms | 0.000 ms | 0.015 ms | 0.000 ms | 0.001 ms |
| 1 ms | 1.510 ms | 1.633 ms | 1.297 ms | 1.513 ms |
| 10 ms | 12.012 ms | 12.033 ms | 12.043 ms | 12.083 ms |
| 15 ms | 16.763 ms | 17.071 ms | 17.023 ms | 17.215 ms |

Zwei Dinge sind daraus mitzunehmen. Erstens bedeuten beide "mindestens so lange", nie "genau so lange". Unter macOS betrug die Überschreitung konstant 0,3 bis 2 ms. Zweitens wird `Task.Delay(0)` synchron abgeschlossen: Es gibt einen bereits abgeschlossenen Task zurück, sodass `await Task.Delay(0)` überhaupt nicht abgibt. Wenn Sie in asynchronem Code die Kontrolle abgeben wollen, ist `await Task.Yield()` die passende API.

Unter Windows ist die Lücke deutlich größer. Die [`Task.Delay`-Dokumentation](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay) besagt, dass die Verzögerung von der Systemuhr abhängt, deren Auflösung unter Windows etwa 15 ms beträgt, sodass `Task.Delay(1)` dort typischerweise rund 15,6 ms dauert. `Thread.Sleep(1)` kann unter Windows nahe bei 1 ms oder nahe bei 15,6 ms liegen, je nachdem, ob ein Prozess auf dem Rechner die globale Timer-Auflösung erhöht hat. Keine der beiden APIs ist ein Präzisions-Timer. Wenn Ihre Schleife von einem 1-ms-Takt abhängt, läuft sie auf einem Windows-Standardrechner mit einem Bruchteil der erwarteten Rate.

## Gemessen: Was `Thread.Sleep` mit dem Thread-Pool anrichtet

Der eigentliche Grund, warum `Thread.Sleep` gefährlich ist, sind weder CPU noch Präzision. Es ist die Wirkung auf einen gemeinsam genutzten Pool. Dieser Test stellt 200 Arbeitselemente in die Warteschlange, die jeweils eine Sekunde warten, und misst dann von einem dedizierten Thread aus, wie lange ein brandneues Arbeitselement wartet, bevor es überhaupt startet:

```csharp
// .NET 10.0.10, C# 14, dotnet run probe3.cs -- sleep|delay
using System.Diagnostics;

string mode = args[0];
var sw = Stopwatch.StartNew();

var tasks = Enumerable.Range(0, 200).Select(_ => Task.Run(async () =>
{
    if (mode == "sleep") Thread.Sleep(1000);
    else await Task.Delay(1000);
})).ToArray();

var sampler = new Thread(() =>
{
    using var started = new ManualResetEventSlim();
    var t = Stopwatch.GetTimestamp();
    ThreadPool.UnsafeQueueUserWorkItem(_ => started.Set(), null);
    started.Wait();
    Console.WriteLine($"new work item waited {Stopwatch.GetElapsedTime(t).TotalMilliseconds:F0} ms");
});
sampler.Start();

Task.WaitAll(tasks);
sampler.Join();
Console.WriteLine($"{mode}: 200 waits done in {sw.ElapsedMilliseconds} ms, pool threads = {ThreadPool.ThreadCount}");
```

| | `Thread.Sleep(1000)` | `await Task.Delay(1000)` |
| --- | --- | --- |
| Zeit für alle 200 Ein-Sekunden-Wartezeiten | 18,034 ms | 1,005 ms |
| Pool-Threads am Ende | 12 | 11 |
| Verzögerung, bevor ein unabhängiges Arbeitselement startete | 17,030 ms | 1 ms |

Mit `Task.Delay` überlappen sich alle 200 Wartezeiten, und der gesamte Stapel dauert auf zehn Threads eine Sekunde. Mit `Thread.Sleep` kann der Pool nur so viele Sleeps gleichzeitig ausführen, wie er Threads hat, sodass der Stapel in Gruppen von etwa zehn serialisiert wird, und jedes andere dahinter eingereihte Arbeitselement, hier ein triviales `started.Set()`, wartete **17 Sekunden** in der Warteschlange. Beachten Sie, dass der Pool die Lage nicht durch zusätzliche Threads rettete: Es wurden jede Sekunde Arbeitselemente fertig, daher ließ ihn seine Hill-Climbing-Logik nur von 10 auf 12 Threads wachsen.

In einer ASP.NET-Core-App ist dieses eingereihte Arbeitselement die nächste HTTP-Anfrage. Das ist das klassische Muster der Thread-Pool-Starvation, und ein `Thread.Sleep` in einem Request-Handler oder einem `BackgroundService` ist eine der einfachsten Methoden, sie auszulösen. Dasselbe passiert mit `Task.Delay(1000).Wait()`, was nichts anderes ist als `Thread.Sleep` mit zusätzlichen Allokationen. Wenn Ihnen dieses Muster bekannt vorkommt: Der Beitrag über das [Beheben von Deadlocks durch `.Result` und `.Wait()`](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) behandelt die Sync-over-Async-Seite davon.

## Gemessen: CPU-Kosten und Aufwachlatenz von `SpinWait`

`SpinWait.SpinUntil(condition)` klingt, als würde es so lange einen Kern verbrennen, wie Sie warten. Dank der Eskalationsleiter ist das nicht so:

| Wartestrategie, 500 ms Wanduhrzeit | Verbrauchte CPU-Zeit |
| --- | --- |
| `Thread.Sleep(500)` | 0 ms |
| `await Task.Delay(500)` | 0 ms |
| `SpinWait.SpinUntil(...)` | 4 ms |
| `SpinOnce(sleep1Threshold: -1)`-Schleife | 500 ms (ein voller Kern) |
| leere `while`-Schleife | 499 ms |

Die ersten 10 reinen Spins dauerten insgesamt 9,8 us, die Spins 10 bis 19 weitere 10 us. Danach ist jedes `SpinOnce()` ein `Thread.Sleep(1)`, das ich mit etwa 1265 us pro Aufruf gemessen habe. Übergeben Sie `sleep1Threshold: -1`, um die `Sleep(1)`-Stufe abzuschalten, erhalten Sie genau das, was der Name verspricht: einen ausgelasteten Kern.

Die andere Hälfte der Abwägung ist, wie schnell jede Strategie bemerkt, dass das erwartete Ereignis eingetreten ist. Hier setzt ein zweiter Thread nach zufälligen 0 bis 3 ms ein Flag, und der Haupt-Thread misst die Zeit vom Setzen des Flags bis zum Bemerken (jeweils 200 Durchläufe):

```csharp
// .NET 10.0.10, C# 14
int flag = 0;
using var ev = new ManualResetEventSlim();
// setter thread: busy-waits a random 0-3 ms, then
//   Volatile.Write(ref flag, 1); ev.Set();

SpinWait.SpinUntil(() => Volatile.Read(ref flag) == 1);       // "spinuntil"
while (Volatile.Read(ref flag) == 0) Thread.Sleep(1);         // "sleep1"
while (Volatile.Read(ref flag) == 0) await Task.Delay(1);     // "delay1"
ev.Wait();                                                    // "mres"
```

| Strategie | p50 Aufwachverzögerung | p90 Aufwachverzögerung |
| --- | --- | --- |
| `SpinWait.SpinUntil` | 745 us | 1,182 us |
| `Thread.Sleep(1)`-Polling | 710 us | 1,158 us |
| `await Task.Delay(1)`-Polling | 836 us | 1,205 us |
| `ManualResetEventSlim.Wait()` | 15 us | 37 us |

Sobald das Warten länger als etwa 20 us dauert, ist `SpinUntil` nur eine `Thread.Sleep(1)`-Polling-Schleife mit schönerem Namen und wacht nicht schneller auf. Das ereignisbasierte Warten war im Median 50-mal schneller und verbrauchte während des Wartens keine CPU. `ManualResetEventSlim` und `SemaphoreSlim` spinnen bereits kurz, bevor sie blockieren, und bieten Ihnen so in einem Aufruf den günstigen Schnellpfad von `SpinWait` und den effizienten langsamen Pfad eines Kernel-Wartens.

## Wann `await Task.Delay` die richtige Wahl ist

- **Retry und Backoff in asynchronem Code.** Ein HTTP-Client, der nach einem 429 erneut versucht, eine Schleife zum Wiederverbinden mit einer Datenbank. Übergeben Sie das `CancellationToken` der Anfrage, damit ein Herunterfahren oder ein Verbindungsabbruch des Clients das Warten abbricht, statt es ausstehend zu lassen.
- **Periodische Arbeit in einem `BackgroundService`.** `await Task.Delay(interval, stoppingToken)` in einer Schleife ist in Ordnung. Wenn Sie Ticks wollen, die nicht um die Dauer der Arbeit driften, ist `PeriodicTimer` (.NET 6+) die bessere Wahl.
- **Drosseln oder Debouncing auf einem UI-Thread.** WPF, WinForms, MAUI und Blazor bleiben alle reaktionsfähig, weil der UI-Thread frei ist, solange die Verzögerung aussteht.
- **Alles, was Sie per Unit-Test prüfen wollen.** Die Überladung `Task.Delay(TimeSpan, TimeProvider, CancellationToken)` (.NET 8+) lässt einen Test die Zeit mit `FakeTimeProvider` sofort vorstellen, was ich im Beitrag über das [Testen zeitabhängigen Codes mit `TimeProvider`](/de/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) durchgegangen bin.

```csharp
// .NET 10, C# 14
async Task<HttpResponseMessage> GetWithRetryAsync(
    HttpClient http, string url, TimeProvider time, CancellationToken ct)
{
    for (int attempt = 0; ; attempt++)
    {
        var response = await http.GetAsync(url, ct);
        if (response.StatusCode != System.Net.HttpStatusCode.TooManyRequests || attempt == 4)
            return response;

        response.Dispose();
        var backoff = TimeSpan.FromMilliseconds(200 * Math.Pow(2, attempt));
        await Task.Delay(backoff, time, ct); // cancellable, testable, holds no thread
    }
}
```

## Wann `Thread.Sleep` die richtige Wahl ist

- **Ein Thread, den Sie erzeugt haben und besitzen.** Ein `new Thread(...)`, das jede Sekunde Hardware oder eine Datei abfragt und auf dem nichts anderes eingeplant ist. Ihn zu blockieren kostet nichts, was jemand anderes braucht.
- **Ein synchrones Konsolenwerkzeug oder ein Skript.** Ein `Main`, das nicht asynchron ist und einfach zwischen Schritten pausieren muss. Es gibt keinen Pool- oder UI-Thread, der ausgehungert werden könnte.
- **Gezieltes Nachstellen von Blockierung.** Tests oder Demos, die einen langsamen synchronen Aufruf simulieren müssen, etwa der oben gezeigte Starvation-Test für den Pool.

Selbst auf einem dedizierten Thread sollten Sie stattdessen `WaitHandle.WaitOne(timeout)` oder `CancellationToken.WaitHandle.WaitOne(timeout)` erwägen. Es wartet dasselbe Intervall, kehrt aber vorzeitig zurück, sobald jemand den Thread zum Beenden auffordert, was `Thread.Sleep` nicht kann:

```csharp
// .NET 10, C# 14: a dedicated worker thread that can be stopped promptly
void PollLoop(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        PollDevice();
        ct.WaitHandle.WaitOne(TimeSpan.FromSeconds(1)); // returns immediately on Cancel()
    }
}
```

## Wann `SpinWait` die richtige Wahl ist

- **Lock-freie Retry-Schleifen.** Eine Compare-and-Swap-Schleife, die fehlschlug, weil ein anderer Thread gerade mitten in einer Aktualisierung steckt. Der andere Thread ist in Nanosekunden fertig, ein Kontextwechsel würde also mehr kosten als das Warten.
- **Der Schnellpfad Ihres eigenen Synchronisationsprimitivs.** Spinnen Sie einige Male mit `SpinOnce()`, solange `NextSpinWillYield` false ist, und weichen Sie dann auf ein echtes blockierendes Warten aus. Das ist dieselbe Struktur, die `ManualResetEventSlim` intern verwendet.

```csharp
// .NET 10, C# 14: spin briefly, then block
var spinner = new SpinWait();
while (!IsReady())
{
    if (spinner.NextSpinWillYield)
    {
        readyEvent.Wait(); // stop spinning, let the OS park the thread
        break;
    }
    spinner.SpinOnce();
}
```

Verwenden Sie `SpinWait` nicht für Wartezeiten im Millisekundenbereich, und verwenden Sie `Thread.SpinWait(n)` nicht direkt mit großem `n`. Die [`SpinWait`-Dokumentation](https://learn.microsoft.com/dotnet/api/system.threading.spinwait) ordnet es als Low-Level-Baustein für Synchronisationscode ein, und Spinnen lohnt sich nur, wenn die erwartete Wartezeit kürzer ist als die Kosten eines Kontextwechsels. Wenn Sie keine lock-freie Datenstruktur und kein Synchronisationsprimitiv schreiben, brauchen Sie es wahrscheinlich nicht. Der Beitrag über [`lock` vs `Monitor` vs `SemaphoreSlim` vs `System.Threading.Lock`](/de/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) behandelt die übergeordneten Primitive, die dieses Spinnen bereits für Sie erledigen.

## Der Stolperstein, der für Sie entscheidet: Warten Sie auf Zeit oder auf ein Ereignis?

Die meisten `Thread.Sleep`- und `Task.Delay`-Aufrufe, die ich in Code-Reviews sehe, sind gar keine zeitgesteuerten Wartezeiten. Es sind Polling-Schleifen: "100 ms schlafen, prüfen, ob der Job fertig ist, wiederholen". Dieses Muster verliert immer auf beiden Achsen. Es fügt nach dem Ereignis bis zu ein Intervall an Latenz hinzu und wacht in der Zwischenzeit umsonst auf.

Wenn ein anderer Teil Ihres Programms das Ereignis auslöst, signalisieren Sie es direkt:

```csharp
// .NET 10, C# 14: replace "while (!done) await Task.Delay(100);"
var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

_ = Task.Run(async () =>
{
    await DoWorkAsync();
    completion.TrySetResult();
});

await completion.Task.WaitAsync(TimeSpan.FromSeconds(30)); // a real timeout, no polling
```

`RunContinuationsAsynchronously` verhindert, dass der Code, der `completion.Task` abwartet, inline auf dem Thread läuft, der `TrySetResult` aufruft. `WaitAsync(TimeSpan)` (.NET 6+) liefert Ihnen den Timeout ohne ein selbstgebautes `Task.WhenAny(task, Task.Delay(...))`. Für Producer/Consumer-Übergaben verwenden Sie einen `Channel<T>`, und für "höchstens N gleichzeitig" `SemaphoreSlim.WaitAsync`. Pollen Sie nur dann, wenn das Ereignis außerhalb Ihres Prozesses stattfindet und nichts Sie benachrichtigen kann, etwa bei einem Statusendpunkt eines entfernten Jobs. Dann ist `await Task.Delay` mit einem `CancellationToken` das richtige Poll-Intervall.

## Empfehlung

Verwenden Sie standardmäßig `await Task.Delay(interval, cancellationToken)`. Es hält keinen Thread, verbraucht keine CPU, kann abgebrochen werden, und mit einem `TimeProvider` lässt es sich ohne echtes Warten testen. In der obigen Messung erledigte es 200 Ein-Sekunden-Wartezeiten in 1 Sekunde, wo `Thread.Sleep` 18 Sekunden brauchte und unabhängige Arbeit 17 davon lahmlegte.

Verwenden Sie `Thread.Sleep` nur auf einem Thread, den sich niemand sonst teilt, und bevorzugen Sie selbst dort ein abbrechbares `WaitHandle.WaitOne(timeout)`. Verwenden Sie `SpinWait` nur für Wartezeiten, die kürzer sind als ein Kontextwechsel, innerhalb von lock-freiem oder Synchronisationscode; bei allem Längeren degeneriert es ohnehin zu einer `Sleep(1)`-Schleife. Und bevor Sie sich für eine davon entscheiden, fragen Sie sich, ob Sie auf Zeit oder auf ein Ereignis warten. Ist es Letzteres, weckt Sie eine `TaskCompletionSource`, ein `ManualResetEventSlim`, ein `SemaphoreSlim` oder ein `Channel<T>` etwa 50-mal früher auf.

### Als Nächstes lesen

- [How to time out an async operation with `CancellationTokenSource.CancelAfter`](/de/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [How to cancel a long-running task in C# without deadlocking](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [`Task.Run` vs `Task.Factory.StartNew` vs `ThreadPool.QueueUserWorkItem`](/de/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/)
- [`Volatile.Read` vs `Volatile.ReadBarrier` in .NET 10](/de/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/)

### Quellen

- [`Thread.Sleep` API reference](https://learn.microsoft.com/dotnet/api/system.threading.thread.sleep), Microsoft Learn
- [`Task.Delay` API reference](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay), including the note on system clock resolution
- [`SpinWait` API reference](https://learn.microsoft.com/dotnet/api/system.threading.spinwait), Microsoft Learn
- [`SpinWait.cs` at v10.0.0](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs), dotnet/runtime
- [Debug thread pool starvation](https://learn.microsoft.com/dotnet/core/diagnostics/debug-threadpool-starvation), .NET diagnostics docs
- [`TimeProvider` overview](https://learn.microsoft.com/dotnet/standard/datetime/timeprovider-overview), Microsoft Learn
