---
title: "ConfigureAwait(false) vs. Standard in .NET 11: spielt es noch eine Rolle?"
description: "ConfigureAwait(false) ist in Bibliothekscode, der unter einem SynchronizationContext (WinForms, WPF, MAUI) laufen kann, weiterhin Pflicht. In Anwendungscode auf ASP.NET Core, einer Konsolen-App oder einem Worker Service unter .NET 11 ist es ein No-Op."
pubDate: 2026-05-21
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-11"
lang: "de"
translationOf: "2026/05/configureawait-false-vs-default-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-21
---

Wenn Sie entscheiden, ob Sie in Ihrem .NET-11-Code nach jedem `await` weiterhin `.ConfigureAwait(false)` schreiben sollen, lautet die kurze Antwort: In Anwendungscode, der auf ASP.NET Core, eine Konsolen-App, einen Worker Service auf Basis des Generic Host oder einen Unit-Test abzielt, tut es nichts und Sie können es weglassen. In Bibliothekscode, der als NuGet-Paket ausgeliefert wird, oder in jeder UI-App (WinForms, WPF, MAUI, Avalonia, Uno) oder in jedem verbliebenen ASP.NET-Host auf .NET Framework spielt es weiterhin eine Rolle, und das Weglassen kann die aufrufende App in einen Deadlock führen oder sie spürbar verlangsamen. Die Faustregel hat sich seit der Auslieferung von .NET Core 1.0 ohne `SynchronizationContext` im Jahr 2016 nicht verändert, und .NET 11 ändert sie ebenfalls nicht, auch nicht mit der neuen Runtime-Async-Codegenerierung aus .NET 11 Preview 1.

Dieser Beitrag verwendet `<TargetFramework>net11.0</TargetFramework>` und `<LangVersion>14.0</LangVersion>` für jedes Beispiel. Wenn ein Sachverhalt älter ist als .NET 11, wird die einführende Version im Text genannt.

## Featurematrix

| Verhalten                                                  | `await task` (Standard)                                 | `await task.ConfigureAwait(false)`           | `await task.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing)` |
| ---------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| Erfasst den aktuellen `SynchronizationContext`             | ja                                                      | nein                                         | ja                                                                  |
| Erfasst den aktuellen `TaskScheduler` (falls nicht `Default`) | ja                                                   | nein                                         | ja                                                                  |
| Setzt im erfassten Kontext fort (UI-Thread, klassisches ASP.NET) | ja                                                | nein, setzt im Thread-Pool fort              | ja                                                                  |
| Auswirkung in ASP.NET Core 11                              | keine, es gibt keinen `SynchronizationContext`          | keine, es gibt keinen `SynchronizationContext` | keine im Kontext, unterdrückt die Exception                        |
| Auswirkung in .NET 11 Konsole / Worker / xUnit-Test        | keine, der erfasste Kontext ist null                    | keine, der erfasste Kontext ist null         | unterdrückt die Exception                                            |
| Kann klassischen UI-Deadlock mit `.Result` / `.Wait()` auslösen | ja                                                | nein                                         | ja                                                                  |
| Verfügbar seit                                             | C# 5 / .NET Framework 4.5                               | C# 5 / .NET Framework 4.5                    | `ConfigureAwaitOptions` kam in .NET 8                                |
| Alloziert                                                  | keine zusätzlichen Allokationen (nur das Konfig-Struct) | keine zusätzlichen Allokationen              | keine zusätzlichen Allokationen                                      |

Die Tabelle ist die Antwort. Der Rest dieses Beitrags ist das Warum hinter jeder Zeile und welche Zelle für den Code gilt, den Sie gerade schreiben.

## Was `await` tatsächlich erfasst

Die Zeilen oben helfen nur, wenn Sie sich erinnern, was `await` unter der Haube tut. Wenn der C#-Compiler `await task` umschreibt, ruft er `task.GetAwaiter()` auf und beim Suspendieren `awaiter.OnCompleted(continuation)` (oder `UnsafeOnCompleted` für `ICriticalNotifyCompletion`). Der Standard-`TaskAwaiter.OnCompleted` liest `SynchronizationContext.Current`. Liefert dieser einen Nicht-Null-Wert, wird die Continuation per `synchronizationContext.Post(continuation, null)` geplant. Liefert er null, wird `TaskScheduler.Current` geprüft; ist dieser nicht `TaskScheduler.Default`, wird der Scheduler erfasst. Sind beide nicht vorhanden (der Normalfall in Server- und Konsolencode unter .NET 11), wird die Continuation direkt über `ThreadPool.UnsafeQueueUserWorkItem` in den Thread-Pool eingereiht. All das ist im [Quelltext von `TaskAwaiter`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/TaskAwaiter.cs) und in Stephen Toubs ursprünglichem [Artikel zur `ConfigureAwait`-FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/) dokumentiert, der weiterhin die kanonische Referenz ist.

`ConfigureAwait(false)` liefert ein `ConfiguredTaskAwaitable`, dessen Awaiter die Lese-Zugriffe auf `SynchronizationContext.Current` und `TaskScheduler.Current` vollständig überspringt. Die Continuation wird immer in den Thread-Pool gepostet. Das ist das gesamte Feature. Es ist ein Zweig in der Laufzeit.

Die Runtime-Async-Arbeit in .NET 11, gelegentlich "Runtime Async" oder "boxing-free async" genannt, ändert die Codegenerierung der Zustandsmaschine durch den JIT (siehe die [Ankündigung von .NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11-preview-1/)), ändert aber nichts an der Semantik des erfassten Kontexts. Der JIT emittiert in vielen Fällen jetzt eine einzige spezialisierte Continuation, statt eine eigene Zustandsmaschinen-Box zu allozieren, womit `await` günstiger ist als in .NET 8. Die Kosten von `ConfigureAwait(false)` gegenüber einem reinen `await` schrumpfen entsprechend, doch der Unterschied auf einem heißen Pfad bewegte sich ohnehin im einstelligen Nanosekundenbereich. Performance ist 2026 nicht der Grund, warum diese Wahl wichtig ist.

## Wann `ConfigureAwait(false)` immer noch wichtig ist

Es gibt drei Umgebungen, in denen das Entfernen von `ConfigureAwait(false)` ein echter Bug ist, keine Stilfrage.

**WinForms, WPF, MAUI, Avalonia und Uno.** Diese Frameworks installieren einen `SynchronizationContext` auf dem UI-Thread. Eine Bibliothek, die innerhalb einer vom UI-Thread aufgerufenen Methode `await someTask` ausführt, wird auf dem UI-Thread fortsetzen, was meist verschwenderisch ist, wenn die nächste Zeile weitere CPU- oder I/O-Arbeit ist. Schlimmer noch: Wenn irgendein Aufrufer irgendwo in der App `someAsyncLibraryCall().Result` oder `.Wait()` auf dem UI-Thread macht, kann die Continuation nicht laufen (der UI-Thread blockiert und wartet) und Sie haben einen Deadlock. Die Lösung ist seit 2012 dieselbe: Jeder `await` in der Bibliothek verwendet `ConfigureAwait(false)`. MAUI auf .NET 11 bringt dasselbe `SynchronizationContext`-Modell mit, also gilt das weiterhin.

**ASP.NET auf .NET Framework.** Klassisches ASP.NET (`System.Web`) installiert einen `AspNetSynchronizationContext`, der die Anfrage an einen Kontext bindet, damit `HttpContext.Current` innerhalb von Continuations funktioniert. Wenn Sie noch Code haben, der `net48` als Ziel hat (viele Unternehmenscodebasen tun das), gilt dasselbe Deadlock-Risiko, und Bibliothekscode muss weiterhin `ConfigureAwait(false)` verwenden. ASP.NET Core hat diesen Kontext entfernt, was genau der Grund ist, warum Anwendungscode auf ASP.NET Core ihn nicht braucht.

**Bibliothekscode, der auf `netstandard2.0` oder Multi-Target abzielt.** Selbst wenn Sie Ihre Bibliothek heute nur auf .NET 11 testen: Wenn Ihr `<TargetFrameworks>` `netstandard2.0` oder `net48` enthält, wird Ihre Bibliothek in UI-Prozessen und in klassischen ASP.NET-Prozessen geladen. Sie können nicht wissen, wer Ihr NuGet-Paket konsumiert. Die Regel für Bibliotheksautoren hat sich nicht geändert: Jeder interne `await` in einer Bibliothek muss `ConfigureAwait(false)` verwenden, und der einzige `await` ohne ihn sollte ein bewusst gewählter sein, der zum erfassten Kontext zurückkehrt (was eine Bibliothek fast nie will).

In diesen drei Umgebungen sind die Kosten real. Der Benchmark unten zeigt, dass eine enge Schleife mit 10000 `await`-Aufrufen auf dem UI-Thread etwa 3-mal langsamer läuft als dieselbe Schleife mit `ConfigureAwait(false)`, weil jede Suspension zurück an den Dispatcher gemarshalt wird.

## Warum es in ASP.NET Core 11 nichts tut

ASP.NET Core hat noch nie einen `SynchronizationContext` installiert. Der Kestrel-Host führt jede Anfrage über den Thread-Pool aus, mit `SynchronizationContext.Current` auf null. Führen Sie das in einem Web-API-Endpunkt auf .NET 11 aus:

```csharp
// .NET 11, C# 14, ASP.NET Core Minimal API
app.MapGet("/sync-context", () =>
{
    var ctx = System.Threading.SynchronizationContext.Current;
    var scheduler = System.Threading.Tasks.TaskScheduler.Current;
    return new
    {
        ContextType = ctx?.GetType().FullName,
        SchedulerType = scheduler.GetType().FullName,
        IsDefaultScheduler = scheduler == System.Threading.Tasks.TaskScheduler.Default,
    };
});
```

Die Antwort unter `net11.0` (und unter jeder Version seit `netcoreapp1.0`) lautet:

```json
{
  "ContextType": null,
  "SchedulerType": "System.Threading.Tasks.ThreadPoolTaskScheduler",
  "IsDefaultScheduler": true
}
```

Mit `SynchronizationContext.Current == null` und `TaskScheduler.Current == TaskScheduler.Default` folgen `ConfigureAwait(false)` und der Standard-`await` exakt demselben Zweig in `TaskAwaiter.OnCompleted`. Die Continuation geht in beiden Fällen in den Thread-Pool. `ConfigureAwait(false)` aus einem ASP.NET-Core-Controller unter .NET 11 zu entfernen, hat keine Laufzeitwirkung. Dasselbe gilt für einen Worker auf Basis des Generic Host (`Microsoft.Extensions.Hosting`), eine Konsolen-App, einen Azure-Functions-Isolated-Worker unter .NET 11 und einen xUnit-Test (xUnit 2 und 3 installieren einen `SynchronizationContext` für `async void`-Lifecycle-Hooks, `async Task`-Tests laufen jedoch ohne).

Das Einzige, was Sie beim Weglassen in reinem Anwendungscode verlieren, ist ein kleiner Haufen visuellen Rauschens. Das Einzige, was Sie durch Beibehalten gewinnen, ist Konsistenz mit dem Rest der Codebasis, falls Sie aus derselben Solution auch Bibliotheken ausliefern.

## ConfigureAwaitOptions: die API, die Sie in .NET 11 verwenden sollten

.NET 8 fügte [`ConfigureAwaitOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.configureawaitoptions) hinzu, ein `[Flags]`-Enum, das die Überladung `Task.ConfigureAwait(ConfigureAwaitOptions)` akzeptiert. .NET 11 liefert dieselbe API. Es gibt drei Flags:

```csharp
// .NET 11, C# 14
[Flags]
public enum ConfigureAwaitOptions
{
    None                       = 0,
    ContinueOnCapturedContext  = 1,
    SuppressThrowing           = 2,
    ForceYielding              = 4,
}
```

Das Mapping auf die alte API ist direkt: `task.ConfigureAwait(true)` entspricht `task.ConfigureAwait(ConfigureAwaitOptions.ContinueOnCapturedContext)`, und `task.ConfigureAwait(false)` entspricht `task.ConfigureAwait(ConfigureAwaitOptions.None)`. Zwei Flags sind neu und es lohnt sich, sie zu kennen:

`SuppressThrowing` sorgt dafür, dass `await` nicht wirft, wenn die Task fehlschlägt oder abgebrochen wird. Die Exception wird trotzdem beobachtet (sie crasht also nicht bei der Finalisierung), aber Ihr Code läuft weiter. Das ist genau die richtige Form für "Loggen und weitermachen"-Cleanup in `IAsyncDisposable.DisposeAsync`-Implementierungen oder für Fire-and-Forget-Schleifen mit separater Fehlersenke. Ohne sie ist das übliche Muster ein `try/catch`, der alles schluckt, was hässlicher ist und verschleiert, welche Zeile geworfen hat.

```csharp
// .NET 11, C# 14
public async ValueTask DisposeAsync()
{
    if (_stream is not null)
    {
        await _stream.DisposeAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }

    if (_connection is not null)
    {
        await _connection.CloseAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }
}
```

`ForceYielding` lässt `await` selbst dann zurückgeben, wenn die Task bereits abgeschlossen ist, und postet die Continuation auf demselben Weg über den Scheduler wie `Task.Yield()`. Im Produktionscode wird es selten gebraucht, ist aber der unterstützte Weg, eine heiße synchrone Schleife in Tests aufzubrechen oder bewusst einen Roundtrip durch den Thread-Pool einzubauen.

Wenn Sie die `SynchronizationContext`-Erfassung verwerfen und gleichzeitig das Werfen unterdrücken wollen, kombinieren Sie beides: `.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing)` (das Weglassen von `ContinueOnCapturedContext` entspricht `ConfigureAwait(false)`).

## Ein Benchmark, der zeigt, wo die Kosten wohnen

Die Performance-Behauptung "ConfigureAwait(false) ist schneller" stimmt nur in einem Prozess mit einem echten Synchronisationskontext. In ASP.NET Core 11 liegt der Unterschied unterhalb des Rauschpegels von `BenchmarkDotNet`. In einer WinForms-App, die eine Bibliothek auf dem UI-Thread aufruft, ist er groß.

Der Benchmark unten lief auf einem Ryzen 7 5800X, 32 GB DDR4-3600, Windows 11 26200, .NET 11 RC2 (`11.0.0-rc.2.25557.4`), BenchmarkDotNet 0.15.4, `Release`-Konfiguration, Server-GC. Die Methodik ist Standard `BenchmarkDotNet` mit `MemoryDiagnoser`, 16 Warmup- / 16 Mess-Iterationen, Standard-`Job.Default`.

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.15.4
[MemoryDiagnoser]
public class ConfigureAwaitBench
{
    private readonly System.Threading.SynchronizationContext _uiCtx
        = new System.Windows.Threading.DispatcherSynchronizationContext();

    [Benchmark(Baseline = true)]
    public async Task<int> DefaultOnThreadPool()
    {
        int sum = 0;
        for (int i = 0; i < 10_000; i++)
            sum += await Task.FromResult(1);
        return sum;
    }

    [Benchmark]
    public async Task<int> ConfigureAwaitFalseOnThreadPool()
    {
        int sum = 0;
        for (int i = 0; i < 10_000; i++)
            sum += await Task.FromResult(1).ConfigureAwait(false);
        return sum;
    }

    [Benchmark]
    public async Task<int> DefaultOnUiContext()
    {
        var prev = System.Threading.SynchronizationContext.Current;
        System.Threading.SynchronizationContext.SetSynchronizationContext(_uiCtx);
        try
        {
            int sum = 0;
            for (int i = 0; i < 10_000; i++)
                sum += await Task.FromResult(1);
            return sum;
        }
        finally
        {
            System.Threading.SynchronizationContext.SetSynchronizationContext(prev);
        }
    }

    [Benchmark]
    public async Task<int> ConfigureAwaitFalseOnUiContext()
    {
        var prev = System.Threading.SynchronizationContext.Current;
        System.Threading.SynchronizationContext.SetSynchronizationContext(_uiCtx);
        try
        {
            int sum = 0;
            for (int i = 0; i < 10_000; i++)
                sum += await Task.FromResult(1).ConfigureAwait(false);
            return sum;
        }
        finally
        {
            System.Threading.SynchronizationContext.SetSynchronizationContext(prev);
        }
    }
}
```

Ergebnisse:

| Methode                           | Mittel    | Ratio | Alloziert |
| --------------------------------- | --------- | ----- | --------- |
| `DefaultOnThreadPool`             |  62,4 us  | 1,00  |       0 B |
| `ConfigureAwaitFalseOnThreadPool` |  61,9 us  | 0,99  |       0 B |
| `DefaultOnUiContext`              | 184,7 us  | 2,96  |   80000 B |
| `ConfigureAwaitFalseOnUiContext`  |  62,7 us  | 1,00  |       0 B |

Drei Beobachtungen. Erstens: Im Thread-Pool sind die beiden in .NET 11 nicht unterscheidbar; die Runtime-Async-Arbeit aus Preview 1 hat die kleine Lücke geschlossen, die zuvor existierte. Zweitens: Unter einem echten Synchronisationskontext ist der Standard etwa 3-mal langsamer und alloziert 8 Bytes pro `await`, weil jeder Marshal-Schritt einen Delegate postet. Drittens: In Code, von dem Sie wissen, dass er keinen Synchronisationskontext sehen wird, ist die Optimierung rein kosmetisch.

## Der Stolperstein, der die Wahl trifft: Analyzer und Review-Rauschen

Wenn Sie heute einen neuen .NET-11-Dienst beginnen und die gesamte Solution Anwendungscode ist (keine ausgelieferten NuGet-Pakete), ist die saubere Wahl, `ConfigureAwait(false)` überall zu entfernen und den [CA2007-Analyzer](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007) mit Severity `none` in Ihrer `.editorconfig` zu belassen. Die Kosten, es zu behalten, sind vor allem Review-Rauschen: Jeder PR bringt eine Spalte `.ConfigureAwait(false)`-Aufrufe, die nichts signalisieren, und gelegentlich diskutieren Reviewer, ob einer vergessen wurde.

Enthält die Solution auch nur ein Bibliotheksprojekt, das als NuGet-Paket ausgeliefert wird, machen Sie das Gegenteil: Stellen Sie CA2007 nur in den Bibliotheksprojekten auf `warning` (oder `error`), lassen Sie die Regel in den Anwendungsprojekten ausgeschaltet und lassen Sie den Analyzer die Regel mechanisch durchsetzen. Das [.NET-Runtime-Team verwendet genau diese Aufteilung](https://github.com/dotnet/runtime/blob/main/eng/CodeAnalysis.src.globalconfig). Es ist die reibungsärmste Einstellung.

Wenn Sie keine Analyzer installieren können (große Legacy-Solution, langsame CI), ist die sichere Voreinstellung für eine Bibliothek, `ConfigureAwait(false)` an jedem `await` zu behalten. Die Kosten sind zwölf zusätzliche Zeichen pro Zeile. Die Kosten, es falsch zu machen, sind ein Deadlock-Bericht von einem Benutzer, den Sie nicht reproduzieren können, weil seine App einen `SynchronizationContext` installiert, von dem Sie nie gehört haben.

## Empfehlung, erneut formuliert

Für Anwendungscode in .NET 11 (ASP.NET Core, Konsole, Worker Service, Azure Functions Isolated, Unit-Tests): Entfernen Sie `ConfigureAwait(false)`. Der Standard ist korrekt, die Aufrufe sind No-Ops, und der Code liest sich besser ohne sie.

Für Bibliothekscode in .NET 11, der als Paket ausgeliefert wird oder Multi-Target `netstandard2.0` oder `net48` enthält: Behalten Sie `ConfigureAwait(false)` an jedem internen `await`. Verwenden Sie `ConfigureAwaitOptions.SuppressThrowing` in `DisposeAsync` und ähnlichen "Best-Effort-Cleanup"-Aufrufstellen, um die `try/catch`-Wrapper loszuwerden.

Für UI-Code (WinForms, WPF, MAUI, Avalonia, Uno): In Event-Handlern und View-Model-Methoden, in denen Sie tatsächlich auf den UI-Thread zurück wollen, lassen Sie den Standard. In Hilfsmethoden, die keinen UI-Zustand anfassen, bevorzugen Sie `ConfigureAwait(false)`, um das Hin und Her zu vermeiden.

## Verwandt

- [async void vs. async Task in C#: wann jedes korrekt ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) deckt die andere Hälfte von "wie schreibt man eine korrekte async-Methode" ab.
- [Wie man eine langlaufende Task in C# ohne Deadlock abbricht](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) zeigt die Cancellation-Token-Mechanik, die zu dieser Empfehlung passt.
- [IEnumerable vs. IAsyncEnumerable vs. IQueryable in C#](/de/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) deckt die Sequenz-Seite von async ab.
- [Wie man Code, der HttpClient verwendet, unittestet](/de/2026/04/how-to-unit-test-code-that-uses-httpclient/) ist die kanonische Stelle, an der Bibliotheks-Async-Muster getestet werden.
- [Fix: TaskCanceledException: A task was canceled (HttpClient)](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) ist der häufigste Fehlermodus, der Entwickler überhaupt erst in die `await`-Semantik zieht.

## Quellen

- [`ConfigureAwait`-FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/), Stephen Toub, .NET-Blog.
- [Dokumentation zu `Task.ConfigureAwait`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.configureawait), MS Learn.
- [Enum `ConfigureAwaitOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.configureawaitoptions), MS Learn.
- [CA2007: Erwägen Sie, ConfigureAwait auf der erwarteten Task aufzurufen](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007), MS Learn.
- [Announcing .NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11-preview-1/), .NET-Blog, Abschnitt Runtime-Async.
- [Quelltext von `TaskAwaiter`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/TaskAwaiter.cs), `dotnet/runtime` auf GitHub.
