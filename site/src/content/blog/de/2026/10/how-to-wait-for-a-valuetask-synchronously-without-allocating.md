---
title: "So warten Sie synchron auf einen ValueTask in einer nicht-asynchronen Methode, ohne zu allokieren"
description: "Prüfen Sie zuerst IsCompleted und lesen Sie das Ergebnis über GetAwaiter().GetResult(), das 0 Bytes kostet. Blockieren Sie nur, wenn der ValueTask noch aussteht, und nutzen Sie dafür ein gecachtes Event und UnsafeOnCompleted statt AsTask(), das pro Aufruf 72 bis 208 Bytes allokiert. Gemessen unter .NET 10 und .NET 11 RC1."
pubDate: 2026-10-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "valuetask"
  - "performance"
lang: "de"
translationOf: "2026/10/how-to-wait-for-a-valuetask-synchronously-without-allocating"
translatedBy: "claude"
translationDate: 2026-10-03
---

Um einen `ValueTask<T>` aus einer synchronen Methode ohne Allokation zu lesen, prüfen Sie zuerst `IsCompleted`. Ist er bereits abgeschlossen, rufen Sie einmal `vt.GetAwaiter().GetResult()` auf und sind fertig: 0 Bytes, etwa 3 ns. Steht er noch aus, müssen Sie blockieren. `vt.AsTask().GetAwaiter().GetResult()` ist der übliche sichere Fallback, allokiert aber bei jedem Aufruf einen `Task<T>`-Wrapper. Ein kleiner Helfer, der kurz spinnt und dann über `UnsafeOnCompleted` auf ein gecachtes `ManualResetEventSlim` wartet, blockiert ohne jede Allokation. Rufen Sie niemals `.Result` oder `.GetAwaiter().GetResult()` auf einem `ValueTask` auf, der noch nicht abgeschlossen ist: Bei Instanzen, die von einer `IValueTaskSource` gestützt werden, ist das Verhalten undefiniert, und in der Praxis wird eine `InvalidOperationException` ausgelöst. Alle Zahlen unten wurden auf einem Apple M4 mit SDK 10.0.302 (.NET 10, C# 14) gemessen und mit SDK 11.0.100-rc.1.26425.128 (.NET 11 RC1) wiederholt.

## Warum Blockieren auf einem ValueTask etwas anderes ist als auf einem Task

Ein `Task<T>` ist ein Referenztyp, der Blockieren unterstützt. `Task.Wait()`, `.Result` und `GetAwaiter().GetResult()` spinnen alle kurz und parken den Thread dann auf einem Event, bis der Task abgeschlossen ist. Diese Aufrufe auf einem unfertigen `Task` sind langsam und riskant (Deadlocks, Thread-Pool-Starvation), aber der Aufruf selbst ist definiert: Er wartet.

Ein `ValueTask<T>` ist ein Struct, das eines von drei Dingen kapselt: ein einfaches `T`-Ergebnis, einen `Task<T>` oder eine `IValueTaskSource<T>` plus ein `short`-Token. Der dritte Fall ist der, der das Blockieren bricht. `IValueTaskSource<T>` stellt `GetStatus`, `OnCompleted` und `GetResult` bereit, und nichts in diesem Vertrag verlangt, dass `GetResult` wartet. Die [Dokumentation zu ValueTask&lt;TResult&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1) nennt vier Dinge, die Sie mit einer Instanz niemals tun dürfen, darunter "Using `.Result` or `.GetAwaiter().GetResult()` when the operation hasn't yet completed", und sagt unmissverständlich, dass in diesem Fall "the results are undefined". Stephen Toubs [Beitrag zum ValueTask-Design](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/) erklärt den Grund: Die Quelle "need not support blocking until the operation completes, and likely doesn't".

Die in der Praxis relevanten Quellen unterstützen es nicht. `Socket`, `NetworkStream`, `System.IO.Pipelines` und `System.Threading.Channels` liefern allesamt `ValueTask`s, die von gepoolten `IValueTaskSource`-Objekten gestützt werden, und die meisten handgeschriebenen Quellen nutzen `ManualResetValueTaskSourceCore<T>`, das eine Ausnahme auslöst, wenn das Ergebnis zu früh angefordert wird.

## Ein minimales Beispiel für den undefinierten Fall

Hier ist eine gepoolte Quelle, die auf dem Thread-Pool abgeschlossen wird, in derselben Form, die `Socket` intern verwendet:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
using System.Threading.Tasks.Sources;

sealed class PooledSource : IValueTaskSource<int>, IThreadPoolWorkItem
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> StartAsync()
    {
        _core.Reset();
        ThreadPool.UnsafeQueueUserWorkItem(this, preferLocal: false);
        return new ValueTask<int>(this, _core.Version);
    }

    void IThreadPoolWorkItem.Execute() { Thread.SpinWait(50); _core.SetResult(42); }

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> c, object? s, short token,
        ValueTaskSourceOnCompletedFlags f) => _core.OnCompleted(c, s, token, f);
}
```

Blockieren Sie darauf so, wie Sie auf einem `Task` blockieren würden:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
var src = new PooledSource();
int r = src.StartAsync().GetAwaiter().GetResult();
// System.InvalidOperationException:
//   Operation is not valid due to the current state of the object.
```

Auf beiden SDKs wird sofort eine Ausnahme ausgelöst. `ManualResetValueTaskSourceCore<T>.GetResult` prüft, ob die Operation abgeschlossen ist, und löst andernfalls eine Ausnahme aus. Das ist der freundliche Ausgang. Eine eigene Quelle, die das nicht absichert, kann `default(T)` zurückgeben, das Ergebnis einer früheren Operation liefern, die dasselbe gepoolte Objekt wiederverwendet hat, oder ihren eigenen Zustand beschädigen. Code, der in der Entwicklung "funktioniert", weil die Operation zufällig schnell endet, kann in Produktion unter Last fehlschlagen. Dasselbe gilt für den nicht-generischen `ValueTask`.

## Schritt 1: einen abgeschlossenen ValueTask kostenlos lesen

Die meisten `ValueTask`-APIs existieren, weil sie in der Regel synchron abgeschlossen werden: ein Cache-Treffer, ein gepufferter Lesevorgang, ein Channel, der bereits ein Element enthält. Trifft das zu, gibt es nichts abzuwarten, und die Dokumentation erlaubt es, `.Result` oder `GetAwaiter().GetResult()` zu lesen, sobald die Instanz abgeschlossen ist. `SocketsHttpHandler` in `System.Net.Http` nutzt genau diesen schnellen Pfad mit `IsCompletedSuccessfully`.

```csharp
// .NET 10 / .NET 11 RC1, C# 14
ValueTask<int> vt = cache.GetAsync(key);

if (vt.IsCompleted)
{
    // Allowed: the operation is finished, and we consume it exactly once.
    int value = vt.GetAwaiter().GetResult();
}
```

Bevorzugen Sie in einem synchronen Helfer `IsCompleted` plus `GetAwaiter().GetResult()` gegenüber `IsCompletedSuccessfully` plus `.Result`. `IsCompleted` ist auch für fehlgeschlagene und abgebrochene Instanzen wahr, und `GetAwaiter().GetResult()` wirft die ursprüngliche Ausnahme erneut (eine `InvalidOperationException` bleibt eine `InvalidOperationException`), genau wie `await`. Prüfen Sie nur `IsCompletedSuccessfully`, landet ein fehlgeschlagener `ValueTask` in Ihrem langsamen Pfad und wird in einen `Task` gepackt, nur damit Sie seine Ausnahme beobachten können.

Hier sehen Sie, was der schnelle Pfad gegenüber dem üblichen Rat spart, zuerst `AsTask()` aufzurufen, für einen `ValueTask<int>`, der bereits den Wert 42 enthält (200.000 Iterationen, `GC.GetTotalAllocatedBytes(precise: true)` davor und danach):

| Ansatz, bereits abgeschlossener `ValueTask<int>` | .NET 10 | .NET 11 RC1 |
| --- | --- | --- |
| `vt.AsTask().GetAwaiter().GetResult()` | 72 B, ~22 ns | 72 B, ~20 ns |
| `vt.IsCompleted` dann `vt.GetAwaiter().GetResult()` | 0 B, ~3 ns | 0 B, ~3 ns |

`AsTask()` auf einem wertgestützten `ValueTask` muss über `Task.FromResult` einen `Task<T>` erzeugen, und die Laufzeit cacht diese nur für eine Handvoll Werte (`true`, `false` und kleine Ganzzahlen von -1 bis 8). Ihr `User`-Objekt oder die Ganzzahl 42 erhält jedes Mal einen neuen 72-Byte-Task. Für einen Wert, auf den nie gewartet werden musste, bringt diese Allokation nichts.

## Schritt 2: auf einen ausstehenden ValueTask ohne AsTask blockieren

Ist `IsCompleted` falsch, müssen Sie warten. Die dokumentierte sichere Option ist `vt.AsTask().GetAwaiter().GetResult()`, die der [Vergleich von .Result und GetAwaiter().GetResult()](/de/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) für genau diese Situation empfiehlt. Sie ist korrekt, aber bei einer von `IValueTaskSource` gestützten Instanz allokiert `AsTask()` eine eigene `Task<T>`-Unterklasse, die sich bei der Quelle registriert, und wenn das Warten lange genug dauert, dass `Task` das Spinnen beendet und den Thread parkt, allokiert die Blockierungsmaschinerie ein zweites Objekt für das Event.

Beides lässt sich vermeiden, indem Sie den Awaiter direkt verwenden. `UnsafeOnCompleted` des Awaiters registriert eine einfache `Action`-Continuation bei der zugrunde liegenden Quelle oder dem Task und erfasst den `ExecutionContext` nicht. Ist diese `Action` ein gecachter Delegate auf ein gecachtes `ManualResetEventSlim.Set`, allokiert die Registrierung nichts:

```csharp
// .NET 10 / .NET 11 RC1, C# 14
public static class ValueTaskSyncExtensions
{
    [ThreadStatic] private static ManualResetEventSlim? t_event;
    [ThreadStatic] private static Action? t_set;

    public static T WaitSync<T>(this ValueTask<T> task)
    {
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();   // fast path, 0 bytes

        // Short spin: many pending operations finish within microseconds.
        // Polling IsCompleted calls GetStatus, which may be called repeatedly.
        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);             // no ExecutionContext capture
        mres.Wait();
        return awaiter.GetResult();                 // consume exactly once
    }

    public static void WaitSync(this ValueTask task)
    {
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);
        mres.Wait();
        awaiter.GetResult();
    }
}
```

Die Details, die das korrekt machen:

1. **Ein einziger Verbrauch.** Der `ValueTask` wird genau einmal über `GetResult()` gelesen, nachdem die Continuation ausgelöst wurde. Das Abfragen von `IsCompleted` zählt nicht als Verbrauch; es ruft `GetStatus` auf der Quelle auf, was vor dem Lesen des Ergebnisses beliebig oft erlaubt ist.
2. **Ein Event pro Thread.** Ein blockierter Thread kann nur auf eine Sache gleichzeitig warten, daher genügt ein `[ThreadStatic]`-Event, und verschachtelte Wartevorgänge auf demselben Thread sind unmöglich, solange dieser Thread blockiert ist. Auch der gecachte `Action`-Delegate wird nur einmal pro Thread erzeugt.
3. **`ConfigureAwait(false)`.** Ohne diesen Aufruf würde der Quelle mitgeteilt, die Continuation im erfassten `SynchronizationContext` auszuführen. In einem UI-Thread ist dieser Kontext der Thread, den Sie gerade blockieren, sodass `Set` nie ausgeführt würde. Mit `ConfigureAwait(false)` läuft die Continuation dort, wo die Quelle abgeschlossen wird.
4. **`UnsafeOnCompleted`, nicht `OnCompleted`.** Die sichere Variante erfasst und stellt den `ExecutionContext` wieder her, was für einen Delegate, der nur ein Event setzt, sinnlos ist.
5. **Spinnen vor dem Parken.** Das Blockieren eines `Task` spinnt, bevor es schläft, und dieser Helfer sollte das auch tun. In der ersten Version meines Benchmarks habe ich sofort geparkt (`spinCount: 0`, keine Spin-Schleife), und bei kurzen Operationen war das etwa doppelt so langsam wie `AsTask()`, weil jedes Warten einen Kernel-Übergang bezahlte.

## Was die Zahlen zeigen

Gleicher Testaufbau, 200.000 Iterationen für kurze Operationen und 2.000 für den 1-ms-Fall, Bytes pro Aufruf über alle Threads gemessen:

| Ausstehender `ValueTask<int>` | Ansatz | .NET 10 | .NET 11 RC1 |
| --- | --- | --- | --- |
| `IValueTaskSource`, endet nach Mikrosekunden | `AsTask().GetAwaiter().GetResult()` | 80 B | 80 B |
| `IValueTaskSource`, endet nach Mikrosekunden | `WaitSync()` | 0 B | 0 B |
| `IValueTaskSource`, endet nach ~1 ms | `AsTask().GetAwaiter().GetResult()` | 144 B | 208 B |
| `IValueTaskSource`, endet nach ~1 ms | `WaitSync()` | 0 B | 0 B |
| `Task`-gestützt (`Task.Run`) | `AsTask().GetAwaiter().GetResult()` | 72 B | 72 B |
| `Task`-gestützt (`Task.Run`) | `WaitSync()` | 72 B | 72 B |

Die Bruchteile von Bytes, die der Testaufbau für `WaitSync()` meldete (0,1 bis 0,3 B pro Aufruf), sind Buchführung des Thread-Pools, keine Allokationen pro Aufruf. Die 72 B in den `Task`-gestützten Zeilen sind der `Task<int>`, den `Task.Run` selbst erzeugt. Bei einem `Task`-gestützten `ValueTask` gibt `AsTask()` einfach den gekapselten Task zurück, sodass keiner der beiden Ansätze dort etwas hinzufügt.

Bei der Latenz gewinnt der Helfer nicht. Bei kurzen Operationen lagen beide Ansätze zwischen 1 und 6 Mikrosekunden pro Aufruf, wobei das Rauschen zwischen den Läufen größer war als der Unterschied zwischen ihnen. Im 1-ms-Fall lagen beide innerhalb von 1 % voneinander, weil das Warten dominiert. Geht es Ihnen um Geschwindigkeit statt um Allokationen, hilft tatsächlich nur der schnelle Pfad aus Schritt 1 und danach, gar nicht zu blockieren.

Die ehrliche Zusammenfassung lautet also: Die `IsCompleted`-Prüfung ist kostenlos und spart bei jedem synchronen Abschluss 72 Bytes, was für jede API der Normalfall ist, die ihren `ValueTask`-Rückgabetyp verdient hat. Der blockierende Helfer spart auf dem langsamen Pfad weitere 80 bis 208 Bytes, was nur relevant ist, wenn der langsame Pfad selbst heiß ist.

## Stolperfallen und Sonderfälle

**Das behebt keine Sync-over-Async-Deadlocks.** `ConfigureAwait(false)` auf *Ihrem* Awaiter steuert nur, wo *Ihre* Continuation läuft. Hat die asynchrone Methode, auf die Sie blockieren, intern ein `await` ohne `ConfigureAwait(false)`, und Sie rufen `WaitSync()` aus einem WPF-, WinForms-, MAUI- oder klassischen ASP.NET-Thread auf, wird diese innere Continuation in die Warteschlange des Threads eingereiht, den Sie gerade blockiert haben, und es kommt genau wie bei `.Result` zum Deadlock. Den Mechanismus und die Lösungen beschreibt [warum Blockieren auf eine asynchrone Methode zum Deadlock führt](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

**Auch Thread-Pool-Starvation behebt es nicht.** Ein Thread-Pool-Thread, der in `mres.Wait()` geparkt ist, ist ein Thread, den der Pool nicht nutzen kann, um genau die Continuation auszuführen, die ihn aufwecken würde. Null Allokationen bedeuten nicht null Kosten. Setzen Sie das an echten synchronen Nahtstellen ein (eine `Dispose`-Methode, eine synchrone Schnittstelle, die Ihnen nicht gehört, eine `Stream.Read`-Überschreibung über einem asynchronen Kern), nicht als Mittel, um eine Aufrufkette nicht asynchron machen zu müssen. Lässt sich die Nahtstelle verschieben, bleibt die [Migration blockierender Aufrufe zu durchgängig asynchronem Code](/de/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/) die eigentliche Lösung.

**Berühren Sie den ValueTask nach `WaitSync()` nicht mehr.** Sobald `GetResult` aufgerufen wurde, bedient eine gepoolte Quelle möglicherweise bereits eine andere Operation. Das Struct zu kopieren und die Kopie später abzuwarten, ist derselbe Fehler wie zweimaliges `await`. CA2012 ("Use ValueTasks correctly") erkennt die offensichtlichen Varianten, aber nicht alle, weil der Analyzer einem `ValueTask` nicht durch eine Hilfsmethode wie diese folgen kann. Der [ValueTask-Überblick](/de/2026/06/what-is-valuetask-and-when-is-it-worth-it/) behandelt den vollständigen Vertrag, genau einmal zu warten.

**`Preserve()` ist keine Abkürzung.** `ValueTask<T>.Preserve()` liefert eine Instanz, die Sie mehrfach verbrauchen können, tut dies bei einer ausstehenden, von `IValueTaskSource` gestützten Instanz aber, indem es intern `AsTask()` aufruft, und allokiert damit denselben Wrapper, den Sie vermeiden wollten.

**Ausnahmen kommen unverpackt heraus.** Weil der Helfer mit `GetAwaiter().GetResult()` endet, löst eine fehlgeschlagene Operation ihren ursprünglichen Ausnahmetyp aus, genau wie `await`. Im Testaufbau erschien ein `ValueTask<int>`, der nach einem `Task.Yield()` eine `InvalidOperationException` warf, aus `WaitSync()` als `InvalidOperationException`, nicht als `AggregateException`.

**Abbruch erscheint als `OperationCanceledException`.** Wurde die Operation abgebrochen, löst `GetResult` je nach Quelle `TaskCanceledException` oder `OperationCanceledException` aus. Der obige Helfer hat keine Überladung mit Timeout. Brauchen Sie eine, übergeben Sie ein Timeout an `mres.Wait`, und berühren Sie bei einem Timeout den `ValueTask` nicht mehr: Seine Continuation ist weiterhin registriert und ruft später `Set` auf Ihrem Thread-statischen Event auf, daher müssen Sie vor dem nächsten Warten auf diesem Thread auch `t_event` und `t_set` durch frische Instanzen ersetzen.

**Wenn Sie die API besitzen, überlegen Sie, ob sie überhaupt `ValueTask` sein sollte.** Eine Methode, die routinemäßig synchron konsumiert wird, ist eine Methode, deren Aufrufer gegen ihren Rückgabetyp ankämpfen. Stellen Sie entweder einen synchronen `TryGet`-Zwilling für den schnellen Pfad bereit oder gehen Sie zurück zu `Task<T>`, wie in [Migration von ValueTask zurück zu Task](/de/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) beschrieben.

## Die Entscheidung der Reihe nach

1. Wenn Sie `await` verwenden können, verwenden Sie `await`. Alles in diesem Beitrag gilt für synchrone Nahtstellen, die Sie nicht entfernen können.
2. Prüfen Sie `IsCompleted`. Ist es wahr, rufen Sie einmal `GetAwaiter().GetResult()` auf. Null Allokationen, ursprünglicher Ausnahmetyp.
3. Steht er aus und der Aufruf ist nicht heiß, ist `AsTask().GetAwaiter().GetResult()` korrekt und unspektakulär. Verwenden Sie es.
4. Steht er aus und ist so heiß, dass 80 bis 208 Bytes pro Aufruf in einem Profiler auffallen, verwenden Sie den oben gezeigten `WaitSync()`-Helfer.
5. Rufen Sie niemals `.Result` oder `GetAwaiter().GetResult()` auf einem ausstehenden `ValueTask` auf. Das ist undefiniert, und mit `ManualResetValueTaskSourceCore<T>` wird eine Ausnahme ausgelöst.

## Verwandte Beiträge

- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#](/de/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) behandelt die `Task`-Seite derselben Frage.
- [Was ist ValueTask und wann lohnt er sich](/de/2026/06/what-is-valuetask-and-when-is-it-worth-it/) erklärt das Pooling von `IValueTaskSource` und die Regel, nur einmal zu warten.
- [Migration von ValueTask zurück zu Task](/de/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) ist die Option, wenn Aufrufer immer wieder synchronen Zugriff brauchen.
- [Den Deadlock beheben, wenn .Result oder .Wait() auf einer asynchronen Methode aufgerufen wird](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) erklärt, warum nichts davon in einem UI-Thread sicher ist.

## Quellen

- [ValueTask&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1), Microsoft Learn (Hinweise zur undefinierten Verwendung)
- [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/), Stephen Toub, .NET Blog
- [IValueTaskSource&lt;TResult&gt; Interface](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.ivaluetasksource-1), Microsoft Learn
- [ManualResetValueTaskSourceCore&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1), Microsoft Learn
- [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012), Microsoft Learn
- [ValueTask.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/ValueTask.cs)
