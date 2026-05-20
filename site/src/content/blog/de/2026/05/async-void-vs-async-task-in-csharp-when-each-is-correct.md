---
title: "async void vs async Task in C#: wann welches korrekt ist"
description: "async Task ist der Standard, async void die Ausnahme. Verwenden Sie async void nur für Event-Handler, Top-Level-Handler in Message-Loops und einige wenige Framework-Callbacks, die eine void-Signatur verlangen. Überall sonst gewinnt async Task bei Exceptions, Komposition und Testbarkeit."
pubDate: 2026-05-20
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-10"
lang: "de"
translationOf: "2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct"
translatedBy: "claude"
translationDate: 2026-05-20
---

Wenn Sie zwischen `async void` und `async Task` für eine Methode wählen, die Sie in C# 14 / .NET 10 schreiben werden, lautet die Antwort `async Task`. Die einzig legitimen Gründe, `async void` zu deklarieren, sind Event-Handler, die per `+=` an ein Event gebunden sind, Top-Level-Handler in einer Message-Loop (ein WinForms-Button-Click, ein WPF-`Loaded`-Handler, ein MAUI-Page-Event) und eine winzige Menge von Framework-Callbacks, deren Signatur durch einen externen Vertrag festgelegt ist (`ICommand.Execute`, bestimmte Test-Fixtures, einige Test-Runner). Für alles, was Sie selbst aufrufen, ist `async Task` korrekt, weil Exceptions fangbar werden, die Aufrufstelle den Abschluss per `await` abwarten kann und die Methode mit `Task.WhenAll`, Cancellation und Unit-Tests komponierbar wird.

Dieser Beitrag ist die Langfassung dieser Antwort. Alles unten verwendet `<TargetFramework>net10.0</TargetFramework>` und `<LangVersion>14.0</LangVersion>`, sofern nicht anders angegeben, aber die Regeln haben sich seit der Einführung von async in C# 5.0 nicht geändert.

## Funktionsmatrix

| Funktion                                         | `async void`                                                   | `async Task`                                |
| ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------- |
| Aufrufer kann `await` verwenden                  | nein                                                           | ja                                          |
| Aufrufer kann geworfene Exceptions mit `catch` fangen | nein, an `SynchronizationContext` / `AppDomain` weitergegeben | ja, auf dem zurückgegebenen `Task` erfasst |
| Komponierbar mit `Task.WhenAll` / `.WhenAny`     | nein                                                           | ja                                          |
| Testbar auf Abschluss / Ergebnis                 | nein, kehrt sofort zurück                                      | ja, `await` auf den zurückgegebenen `Task`  |
| Löst `SynchronizationContext.OperationStarted/Completed` aus | ja                                              | nein                                        |
| Übersteht eine nicht behandelte Exception        | beendet den Prozess standardmäßig seit .NET Framework 4.5      | nein, die Exception bleibt auf dem `Task`, bis sie beobachtet wird |
| Signatur kompatibel mit C#-Events                | ja (`EventHandler` gibt `void` zurück)                         | nein                                        |
| Erlaubt in Interfaces / virtuellen Overrides, wenn der Vertrag `void` vorgibt | ja                          | nur wenn der Vertrag `Task` zurückgibt      |

Die Tabelle ist der Beitrag. Alles unten ist das Warum.

## Warum `async void` aufruferfeindlich ist

Der C#-Compiler schreibt `async`-Methoden in eine Zustandsmaschine um, die ihre Arbeit an einen `AsyncMethodBuilder` übergibt. Für `async Task`-Methoden ist der Builder [`AsyncTaskMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder), der eine `Task`-Eigenschaft bereitstellt. Wenn die Zustandsmaschine abschließt, ruft der Builder `SetResult` oder `SetException` auf diesem Task auf, und jeder Aufrufer, der die Referenz hält, beobachtet das Ergebnis.

Für `async void` ist der Builder [`AsyncVoidMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder). Er hat keinen `Task` zur Rückgabe. Daraus ergeben sich drei konkrete Konsequenzen.

Erstens hat die Aufrufstelle keinen Handle zum Abwarten. Wenn Sie `DoStuffAsync();` schreiben und `DoStuffAsync` `void` zurückgibt, ist die Zeile abgeschlossen, sobald das erste `await` innerhalb der Methode suspendiert, nicht wenn die Arbeit der Methode beendet ist. Die nächste Anweisung wird sofort ausgeführt, auch wenn die Methode ihre Aufgabe noch nicht erledigt hat. Dies ist die Ursache des klassischen Bugs "die Daten sind weg, wenn ich sie lese".

Zweitens werden Exceptions, die innerhalb einer `async void`-Methode geworfen werden, nirgendwo gespeichert. `AsyncVoidMethodBuilder.SetException` schickt sie an den `SynchronizationContext`, der beim Start der Methode aktuell war. In einem WinForms- oder WPF-Prozess bedeutet das die Message-Loop des UI-Threads, die `Application.ThreadException` (WinForms) oder `Application.DispatcherUnhandledException` (WPF) auslöst. In einer Konsolen-App oder einem ASP.NET-Core-Hintergrundkontext ist der Synchronization Context null, also wird die Exception in den Thread Pool eingereiht, der sie über `AppDomain.CurrentDomain.UnhandledException` exponiert und seit .NET Framework 4.5 und jedem .NET-5+-Release den Prozess beendet. Es gibt kein `try/catch` an der Aufrufstelle, das Sie retten kann, weil die Exception nie durch die Aufrufstelle reist.

Drittens ruft die Methode [`SynchronizationContext.OperationStarted`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted) beim Start und `OperationCompleted` beim Ende auf. Die meisten Kontexte ignorieren diese Aufrufe. Die Ausnahmen sind Kontexte im Stil des `AsyncOperationManager`, die von `xUnit` und einigen Testframeworks verwendet werden: Sie zählen ausstehende asynchrone Arbeit, damit der Test-Runner weiß, wann ein Test als beendet zu betrachten ist. Für eine `async void`-Methode wird der Runner warten. Für gewöhnliche Aufrufer ist diese Arbeit verschwendet.

## Minimaler Repro: ein Crash, den Sie nicht fangen können

```csharp
// .NET 10, C# 14, console app
using System;
using System.Threading.Tasks;

try
{
    Boom();
    await Task.Delay(100);
}
catch (Exception ex)
{
    Console.WriteLine($"caught: {ex.Message}");
}

static async void Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async void");
}
```

Führen Sie das aus. Die Ausgabe ist nicht "caught: from async void". Es ist ein Stack Trace einer nicht behandelten Exception, und der Prozess endet mit einem Exit-Code ungleich null. Der `catch`-Block oben sieht die Exception nie, weil die Exception auf dem Thread-Pool-Worker geworfen wird, der die Zustandsmaschine nach `Task.Yield` fortgesetzt hat, nicht auf dem Aufrufstack des ursprünglichen Aufrufers.

Ändern Sie ein Schlüsselwort:

```csharp
// .NET 10, C# 14
static async Task Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async Task");
}
```

Jetzt fängt `await Boom();` an der Aufrufstelle die Exception, und selbst `Boom();` ohne `await` beendet den Prozess nicht: die Exception sitzt auf dem unbeobachteten `Task`, bis entweder jemand sie beobachtet oder der `Task` finalisiert wird (was standardmäßig den Prozess auch nicht mehr beendet, seit der Standardwert von `<ThrowUnobservedTaskExceptions>` in .NET 4.5 auf `false` umgestellt wurde).

## Wann `async void` korrekt ist

Es gibt genau drei Kategorien, in denen `async void` angemessen ist. Bleiben Sie strikt innerhalb dieser.

**Event-Handler, die an ein CLR-Event gebunden sind.** Der `EventHandler`-Delegate gibt `void` zurück. Sie können die Methode nicht `Task` zurückgeben lassen und sich gleichzeitig mit `+=` abonnieren. Wenn Sie einen `Button.Click`-Handler, einen `Window.Loaded`-Handler, einen MAUI-`Page.Appearing`-Handler oder eine beliebige Signatur der Form `void (object?, EventArgs)` schreiben, muss er `async void` sein. Das Framework (WinForms, WPF, MAUI, Avalonia, Uno) löst das Event auf dem UI-Thread aus, und der Synchronization Context schickt nicht behandelte Exceptions zurück an das Unhandled-Exception-Event des UI-Thread-Dispatchers, das die meisten Apps bereits protokollieren. Halten Sie den Handler dünn und delegieren Sie an eine `async Task`-Methode, sobald Sie das Argument-Shaping erledigt haben:

```csharp
// .NET 10, MAUI, C# 14
private async void OnSaveClicked(object? sender, EventArgs e)
{
    try
    {
        await SaveAsync(_viewModel.Form);
    }
    catch (Exception ex)
    {
        await DisplayAlert("Save failed", ex.Message, "OK");
    }
}

private async Task SaveAsync(FormData form)
{
    using var http = _httpFactory.CreateClient("api");
    var response = await http.PostAsJsonAsync("/forms", form);
    response.EnsureSuccessStatusCode();
}
```

Das `try/catch` ist im Handler Pflicht. Der Handler ist der einzige Ort, an dem Sie eine Chance haben, eine Exception zu beobachten, bevor die Laufzeit sie in einen Crash verwandelt, also lassen Sie ihn nicht blank.

**Top-Level-Callbacks der Message-Loop.** Einige Frameworks bieten Hook-Punkte, die wie Events aussehen, aber tatsächlich Delegates mit `void`-Signatur sind: ein `Executed`-Handler eines Routed Commands, ein Override von `ICommand.Execute(object)` (das Interface gibt `void` zurück), ein `BackgroundWorker.DoWork`-Handler, ein `Timer.Elapsed`-Handler mit der `System.Timers.Timer`-Signatur und so weiter. Die Regel ist die gleiche wie bei Events: halten Sie sie dünn und umgeben Sie sie mit `try/catch`.

**Framework-Callbacks, deren Vertrag fixiert ist.** xUnit 2 ruft `IAsyncLifetime.InitializeAsync` und `DisposeAsync` als `Task` auf, aber einige Attribut-stilige Hooks in Test-Runnern erwarten immer noch eine `void`-Methode, und einige IoC-Container-Hooks (`IHostedService` aus `Microsoft.Extensions.Hosting` gibt `Task` zurück, aber der ältere `IApplicationLifetime.ApplicationStarted`-Callback gibt `void` zurück). Wenn die Drittanbieter-Signatur `void` sagt, haben Sie keine Wahl. Dokumentieren Sie es in einem Kommentar, damit ein zukünftiger Leser es nicht "korrigiert".

Alles andere ist `async Task`.

## Was Sie verlieren, wenn Sie zu `async void` greifen

Wenn eine Methode laut fehlschlagen muss, wenn etwas schief läuft, nichts Sinnvolles zurückgibt, und Sie zu `async void` greifen, um die `await`-Zeremonie zu überspringen, haben Sie sich angemeldet für:

- **Verlorene Stack Traces.** Die Exception, die im Synchronization Context auftaucht, verliert den ursprünglichen Aufrufstack. Sie sehen den rethrowten Frame, nicht "dies wurde aus `OnSaveClicked` aufgerufen".
- **Keine Cancellation.** Sie können Cancellation nicht durchreichen, weil der Aufrufer keinen `Task` zum Abwarten hat. Ein `CancellationToken`-Argument funktioniert innerhalb der Methode weiterhin, aber der Aufrufer kann nicht auf eine `OperationCanceledException` reagieren, da sie nie zurück propagiert.
- **Kein Timeout via `Task.WhenAny`.** Ein gängiges Muster ist `await Task.WhenAny(work, Task.Delay(timeout, ct))`. Dafür brauchen Sie einen `Task`. `async void` hat keinen.
- **Keine Tests auf Abschluss.** xUnit, NUnit und MSTest können eine `async Task`-Testmethode mit `await` abwarten und ihr Ergebnis beobachten. Sie können einen `async void`-Test nicht abwarten. Einige Frameworks behandeln `async void`-Testmethoden gesondert (älteres NUnit, MSTest v2 mit Adapter-Eigenheiten); keines empfiehlt es. Sehen Sie sich das ausführlichere Muster in [wie man Code testet, der HttpClient verwendet](/2026/04/how-to-unit-test-code-that-uses-httpclient/) an, wo jeder Test `async Task` ist.
- **Fire-and-Forget, das auch Fire-and-Crash ist.** Viele "Fire-and-Forget"-Muster werden stillschweigend zu `async void`-Aufrufen, wenn Entwickler das `await` vergessen. Die Lösung ist nicht `async void`; die Lösung ist ein explizites `_ = SomeAsync();` Discard und die Akzeptanz, dass der resultierende `Task` unbeobachtet ist, oder besser, den Task an einen bekannten Ort zu übergeben, der ihn beobachtet (ein Logger, eine Hintergrund-Queue).

## Der Benchmark: spart `async void` etwas?

Manchmal lautet das Argument für `async void` "es ist billiger, weil keine `Task`-Allokation stattfindet". Messen wir das.

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
// dotnet add package BenchmarkDotNet
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<AsyncShapes>();

[MemoryDiagnoser]
public class AsyncShapes
{
    [Benchmark(Baseline = true)]
    public async Task ReturnsTask()
    {
        await Task.Yield();
    }

    [Benchmark]
    public void ReturnsVoid()
    {
        DoVoid();

        static async void DoVoid() => await Task.Yield();
    }
}
```

Methodik: BenchmarkDotNet 0.14.0, .NET 10.0.0 RTM, Windows 11 24H2, AMD Ryzen 9 7900X, einsträngiger synchroner Benchmark-Harness. Beide Methoden führen ein `Task.Yield` aus, das eine Continuation auf dem Thread Pool erzwingt.

| Methode     | Mittelwert | Allokiert |
| ----------- | ---------- | --------- |
| ReturnsTask | 1,34 us    | 152 B     |
| ReturnsVoid | 1,29 us    | 136 B     |

Die `async void`-Version spart 16 Byte (eine `Task`-Instanz) und ist etwa 4% schneller, was neben dem Thread-Pool-Hop bedeutungslos ist. Moderne Laufzeiten poolen `AsyncTaskMethodBuilder.Task` für nicht-generische abgeschlossene Tasks, sodass der Steady-State-Allokationsunterschied sogar kleiner ist, als der Mikrobenchmark zeigt. Das Performance-Argument für `async void` ist nicht real.

## Der Stolperstein, der für Sie entscheidet

Wenn Sie für eine Nicht-Event-Methode versucht sind, `async void` zu nehmen, sollten zwei Dinge Ihre Meinung auf der Stelle ändern.

Das erste sind Fire-and-Forget-Tasks, die sich über die Lebensdauer eines Requests erstrecken. ASP.NET Core gibt Ihnen standardmäßig keinen `SynchronizationContext`, sodass eine Exception in einem `async void` zu `ThreadPool.UnobservedExceptionEvent` aufsteigt und je nach Ihren `<ServerGarbageCollection>`-Einstellungen den Worker-Prozess mitreißen kann. In dem Moment, in dem Sie sich entscheiden, "etwas Hintergrundarbeit aus einem Controller anzustoßen", wechseln Sie zu `IHostedService` oder, für einen One-Shot, geben Sie den `Task` an das Framework zurück über etwas, das ihn beobachtet (`BackgroundService`, eine `IHostApplicationLifetime`-aware Queue, [Channels](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)).

Das zweite sind Interfaces. Wenn eine Methode jemals mockbar oder Teil eines Vertrags sein soll, muss sie etwas zurückgeben. `Task` ist der Standard-Rückgabetyp für eine asynchrone Operation, die keinen Wert erzeugt. `void` kann von einem Mock oder Fake nicht mit `await` abgewartet werden, und Sie können das Test-Setup nicht darum herum koordinieren. Das Mocking-Muster in [wie man DbContext mockt, ohne das Change Tracking zu brechen](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) stützt sich aus demselben Grund auf `Task`-zurückgebende Member.

## Die meinungsstarke Empfehlung, noch einmal

Standardmäßig `async Task`. `async void` für die genau drei Kategorien oben verwenden: CLR-Event-Handler, Message-Loop- oder Command-stilige Callbacks, deren Signatur durch das Framework festgelegt ist, und Drittanbieter-Hooks, die `void` verlangen. Jedes `async void` mit `try/catch` umschließen und an einen `async Task`-Helfer delegieren, sobald Sie den Aufruf argumentgeformt haben. Wenn Sie aus irgendeinem anderen Grund `async void` an einer selbst geschriebenen Methode sehen, behandeln Sie es als latenten Prozess-Crash und ändern Sie es.

Zwei Korollare, die ins Muskelgedächtnis übergehen sollten:

- Ein `async void`, das `I/O` betreibt und `try/catch` vergisst, ist ein Crash, der auf `await` wartet. Die Zustandsmaschine hat keinen Platz, eine geworfene Exception abzulegen, außer dem Synchronization Context, und die meisten Kontexte im modernen .NET behandeln das als fatal.
- Ein `async Task`, das Sie nie mit `await` abwarten, ist nicht dasselbe wie `async void`. Der `Task` erfasst die Exception trotzdem; sie sitzt nur dort bis zur Beobachtung oder Finalisierung. Verwenden Sie `_ = SomeAsync();` nur, wenn Sie sich der Lebensdauer sicher sind, und übergeben Sie den `Task` bevorzugt an eine Hintergrund-Queue-Infrastruktur, die ihn besitzt.

## Verwandt

- [Wie Sie einen lang laufenden Task in C# ohne Deadlock abbrechen](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Wie Sie Channels statt BlockingCollection in C# verwenden](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)
- [Wie Sie Code testen, der HttpClient verwendet](/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException: A task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Fix: InvalidOperationException: Synchronous operations are disallowed in ASP.NET Core](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)

## Quellen

- [Async-Rückgabetypen -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/async-return-types)
- [Stephen Cleary, "Async/Await -- Best Practices in Asynchronous Programming"](https://learn.microsoft.com/en-us/archive/msdn-magazine/2013/march/async-await-best-practices-in-asynchronous-programming)
- [Stephen Cleary, "Async OOP 5: Events"](https://blog.stephencleary.com/2013/02/async-oop-5-events.html)
- [`AsyncVoidMethodBuilder`-Referenz](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder)
- [`AsyncTaskMethodBuilder`-Referenz](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder)
- [`SynchronizationContext.OperationStarted`-Referenz](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted)
