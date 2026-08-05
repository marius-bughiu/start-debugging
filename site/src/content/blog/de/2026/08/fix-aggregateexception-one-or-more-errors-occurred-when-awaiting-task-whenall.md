---
title: "Fix: AggregateException \"One or more errors occurred\" beim Warten auf Task.WhenAll in C#"
description: "await Task.WhenAll wirft nur einen der Fehler erneut. Speichern Sie den WhenAll-Task in einer Variablen und lesen Sie Exception.InnerExceptions, um alle Fehler zu sehen."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "de"
translationOf: "2026/08/fix-aggregateexception-one-or-more-errors-occurred-when-awaiting-task-whenall"
translatedBy: "claude"
translationDate: 2026-08-05
---

Wenn mehrere Tasks in einem `Task.WhenAll` fehlschlagen, endet der zurückgegebene Task fehlerhaft mit einer `AggregateException`, deren Meldung "One or more errors occurred" lautet. Das `await` packt sie jedoch aus und wirft genau eine der inneren Exceptions erneut. Alle anderen Fehler werden stillschweigend verworfen und erreichen Ihren `catch`-Block nie. Der Fix besteht darin, den von `Task.WhenAll` zurückgegebenen Task in einer lokalen Variablen zu behalten, ihn innerhalb eines `try` zu erwarten und im `catch` `whenAll.Exception.InnerExceptions` zu lesen. Wenn Sie den Typ `AggregateException` wörtlich in einem `catch` sehen, blockieren Sie mit `.Wait()` oder `.Result`, statt zu warten, und das ist ein eigenes, schlimmeres Problem. Verifiziert unter .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14), das Laufzeitverhalten gemessen unter .NET 10.0.5; der relevante Laufzeitcode ist auf den Branches `release/10.0` und `main` byteidentisch.

## Der Fehler im Kontext

Blockierendes Warten auf den `WhenAll`-Task liefert die Hülle direkt:

```
Unhandled exception. System.AggregateException: One or more errors occurred. (Connection refused) (The operation has timed out.)
 ---> System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   --- End of inner exception stack trace ---
   at System.Threading.Tasks.Task.ThrowIfExceptional(Boolean includeTaskCanceledExceptions)
   at System.Threading.Tasks.Task.Wait(Int32 millisecondsTimeout, CancellationToken cancellationToken)
```

Mit `await` erhalten Sie überhaupt keine `AggregateException`, sondern nur eine der inneren Exceptions:

```
Unhandled exception. System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   at OrderSync.SyncAllAsync()
```

Beides ist dieselbe zugrunde liegende Situation. Diese zwei Erscheinungsformen sind der Grund, warum Suchanfragen zu diesem Fehler auf widersprüchliche Ratschläge stoßen.

## Warum await alle Fehler bis auf einen verbirgt

`Task.WhenAll` ist so dokumentiert, dass es im Zustand `Faulted` endet, "wobei seine Exceptions die Aggregation der Menge ausgepackter Exceptions aus jedem der übergebenen Tasks enthalten". Diese Aggregation liegt in der Eigenschaft `Exception` des zurückgegebenen Tasks und enthält tatsächlich jeden Fehler.

Der Verlust passiert eine Ebene darüber. `await` ist so spezifiziert, dass es die Exception eines Tasks ausgepackt erneut wirft, sodass Sie bei einem einzelnen fehlgeschlagenen Task `HttpRequestException` statt `AggregateException` fangen. Dieses Auspacken ist der richtige Standard: Nahezu jede asynchrone API erzeugt höchstens einen Fehler, und `catch (AggregateException ae) { ae.InnerException ... }` um jedes await wäre unerträglich. `Task.WhenAll` ist die wichtigste API, bei der diese Annahme bricht, und der Awaiter hat keine Möglichkeit zu signalisieren, dass es vier waren. Er nimmt eine Exception Dispatch Info aus der Liste und wirft sie erneut. Das wurde als [dotnet/runtime#31494](https://github.com/dotnet/runtime/issues/31494) und erneut als [dotnet/runtime#47605](https://github.com/dotnet/runtime/issues/47605) angesprochen, mit der Bitte um ein optionales await, das die gesamte Aggregation weitergibt. Keines davon wurde ausgeliefert, also bleibt der Workaround unten die Antwort.

Die Folgerung betrifft Ihre `catch`-Klauseln: Nach `await Task.WhenAll(...)` greift ein `catch (AggregateException)` nie. Wenn Sie eines geschrieben haben, ist es toter Code, und die echte Exception zieht daran vorbei.

## Minimale Reproduktion

```csharp
// .NET 11, C# 14
static async Task FailAsync(string message)
{
    await Task.Delay(10);
    throw new InvalidOperationException(message);
}

try
{
    await Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));
}
catch (Exception ex)
{
    Console.WriteLine(ex.Message);   // prints one message, not three
}
```

Drei Fehler gehen hinein, einer kommt heraus. Nichts im `catch`-Block kann die anderen beiden wiederherstellen, denn die einzige Referenz auf die Aggregation war die temporäre Variable, die `Task.WhenAll` zurückgab und die `await` verbraucht hat.

## Fix 1: den WhenAll-Task behalten und InnerExceptions lesen

Das ist der Fix für die überwiegende Mehrheit der Fälle, und die einzige Änderung ist eine lokale Variable:

```csharp
// .NET 11, C# 14
Task whenAll = Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));

try
{
    await whenAll;
}
catch
{
    // whenAll.Exception is the AggregateException the await threw away
    foreach (Exception inner in whenAll.Exception!.InnerExceptions)
    {
        _logger.LogError(inner, "Sync step failed");
    }
    throw;
}
```

`whenAll.Exception` ist genau dann nicht null, wenn `whenAll.Status == TaskStatus.Faulted` gilt, und die Sammlung `InnerExceptions` enthält einen Eintrag pro fehlgeschlagenem Task, jeweils mit unversehrtem ursprünglichem Stack Trace. Das leere `catch` mit einem `throw` erhält das bisherige Verhalten für Aufrufer (sie sehen weiterhin eine einzelne ausgepackte Exception) und gibt Ihnen zugleich volle Genauigkeit im Log.

Zwei Details machen das mechanisch anwendbar. Erstens: Legen Sie den Aufruf `Task.WhenAll(...)` nicht in das `try`. Es wirft das `await`, nicht der Aufruf, aber die Zuweisung außerhalb zu halten macht die Variable im `catch` sichtbar. Zweitens: Verwenden Sie `catch` oder `catch (Exception)`, nicht `catch (AggregateException)`, aus dem im vorherigen Abschnitt genannten Grund.

## Fix 2: den WhenAll-Task gar nicht erst fehlschlagen lassen

Wenn Ihr Fan-out ein Batch ist, bei dem Teilfehler normal sind, besteht der sauberere Entwurf darin, Exceptions gar nicht aus den einzelnen Tasks entkommen zu lassen. Kapseln Sie jede Arbeitseinheit so, dass sie ihr Ergebnis zurückgibt, statt zu werfen:

```csharp
// .NET 11, C# 14
static async Task<(int Id, Exception? Error)> RunSafeAsync(int id, Func<Task> work)
{
    try
    {
        await work();
        return (id, null);
    }
    catch (Exception ex)
    {
        return (id, ex);
    }
}

var results = await Task.WhenAll(orders.Select(o => RunSafeAsync(o.Id, () => SyncAsync(o))));

foreach (var (id, error) in results.Where(r => r.Error is not null))
{
    _logger.LogError(error, "Order {OrderId} failed", id);
}
```

`Task.WhenAll` läuft jetzt immer bis zum Ende durch, also gibt es keine Aggregation auszupacken, keinen Exception-Filter richtig zu treffen, und die Zuordnung zwischen jedem Fehler und dem verursachenden Element bleibt erhalten. Genau diese Zuordnung kann Fix 1 nicht liefern: `InnerExceptions` ist eine flache Liste von Exceptions ohne Rückverweis auf den Task, der sie erzeugt hat. Wenn Sie die Fehler wiederholen oder melden müssen, welche Datensätze abgelehnt wurden, nehmen Sie diese Form.

Der Preis ist, dass ein wirklich fataler Fehler sich nicht mehr von selbst fortpflanzt. Entscheiden Sie ausdrücklich, was passiert, wenn `results` Fehler enthält, sonst haben Sie einen stillen Fehlschlag gebaut.

## Fix 3: die gesamte Aggregation absichtlich erneut werfen

Wenn der Aufrufer wirklich jeden Fehler sehen soll, werfen Sie die Aggregation erneut, statt `await` einen auswählen zu lassen. `ExceptionDispatchInfo` erhält die ursprünglichen Stack Traces:

```csharp
// .NET 11, C# 14
using System.Runtime.ExceptionServices;

public static async Task WhenAllWithAggregateAsync(IEnumerable<Task> tasks)
{
    Task whenAll = Task.WhenAll(tasks);
    try
    {
        await whenAll;
    }
    catch
    {
        ExceptionDispatchInfo.Capture(whenAll.Exception!).Throw();
    }
}
```

Aufrufer dieses Helpers bekommen eine `AggregateException` mit jeder inneren Exception, und genau danach greifen Leute meist, wenn sie nach einem `await` ein `catch (AggregateException)` schreiben. Setzen Sie das an einer Grenze ein, an der eine einzelne logische Operation tatsächlich auf mehrere Arten gleichzeitig fehlgeschlagen ist, etwa bei einem Batch-Import, der alle Validierungsfehler melden muss. Machen Sie es nicht zum Standard: Es drängt die Behandlung von `AggregateException` in jeden Aufrufer, und genau dieses Ergonomieproblem sollte das Auspacken durch `await` beseitigen.

## Welche Exception wirft await tatsächlich?

Hier liegen die meisten bestehenden Antworten falsch, auch die, die "die erste Exception" sagen. Es hängt davon ab, welche Überladung Sie aufgerufen haben, und der Unterschied ist deterministisch.

```csharp
// .NET 10.0.5, C# 14 -- three tasks that fail at staggered times,
// slowest one first in argument order
static async Task FailAfterAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

static async Task<int> FailAfterIntAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

// non-generic overload -> Task
var nonGeneric = Task.WhenAll(
    FailAfterAsync(150, "index0-slow"),
    FailAfterAsync(80,  "index1-medium"),
    FailAfterAsync(10,  "index2-fast"));
// await throws:    index2-fast
// InnerExceptions: index2-fast, index1-medium, index0-slow

// generic overload -> Task<int[]>
var generic = Task.WhenAll(
    FailAfterIntAsync(150, "index0-slow"),
    FailAfterIntAsync(80,  "index1-medium"),
    FailAfterIntAsync(10,  "index2-fast"));
// await throws:    index0-slow
// InnerExceptions: index0-slow, index1-medium, index2-fast
```

Das nicht generische `Task.WhenAll` ordnet `InnerExceptions` nach **Abschlusszeitpunkt**. Das generische `Task.WhenAll<TResult>` ordnet sie nach **Argumentposition**. Beide werfen `InnerExceptions[0]`. Dieses Ergebnis war über wiederholte Läufe unter .NET 10.0.5 stabil.

Die Ursache ist im Laufzeit-Quellcode sichtbar. Beide Promises stehen in [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs). Die nicht generische `WhenAllPromise` behält das Eingabe-Array bewusst nicht; ihr Abschluss-Callback `Invoke` hängt jeden fehlgeschlagenen Task an eine Liste an, sobald er fertig ist, und läuft anschließend über diese Liste:

```csharp
// dotnet/runtime, Task.WhenAllPromise.Invoke
if (failedOrCanceled is List<Task> list)
{
    foreach (Task task in list) { HandleTask(task); }
}
```

Die generische `WhenAllPromise<T>` behält das Array, weil sie die `T[]`-Ergebnisse in Reihenfolge liefern muss, und iteriert es per Index:

```csharp
// dotnet/runtime, Task.WhenAllPromise<T>.Invoke
for (int i = 0; i < m_tasks.Length; i++)
{
    Task<T>? task = m_tasks[i];
    if (task.IsFaulted) { observedExceptions ??= new(); observedExceptions.AddRange(task.GetExceptionDispatchInfos()); }
    ...
}
```

Diese Abweichung trat in .NET 8 auf und wurde als [dotnet/runtime#93504](https://github.com/dotnet/runtime/issues/93504) gemeldet, nachdem der nicht generische Pfad aus Allokationsgründen neu geschrieben worden war. Sie wurde als "not planned" geschlossen und steht nicht in der Dokumentation der Breaking Changes. Praktisch heißt das: Schreiben Sie nie Code, der davon abhängt, welcher Fehler aus einem `await Task.WhenAll` auftaucht. Lesen Sie die ganze Liste, wie in Fix 1.

## Abbrüche verschwinden, sobald irgendetwas fehlschlägt

Der andere stille Verlust ist der Abbruch. Wenn ein Task abgebrochen wird und ein anderer fehlschlägt, trägt der abgebrochene nichts bei:

```csharp
// .NET 10.0.5
var mixed = Task.WhenAll(canceledTask, faultingTask);
try { await mixed; } catch (Exception ex) { /* InvalidOperationException */ }

// mixed.Status                          -> Faulted
// mixed.Exception.InnerExceptions.Count -> 1   (the cancellation is gone)
```

Beide Promise-Implementierungen führen `canceledTask` in einer separaten lokalen Variablen und rufen `TrySetCanceled` nur auf, wenn die Exception-Liste leer ist. Das entspricht der dokumentierten Regel: Fehlschlag schlägt Abbruch, und Abbruch schlägt Erfolg. Schlägt nichts fehl und wird mindestens ein Task abgebrochen, endet der `WhenAll`-Task als `Canceled`, seine Eigenschaft `Exception` ist `null`, und `await` wirft eine `TaskCanceledException`. Code, der `whenAll.Exception!.InnerExceptions` ohne Prüfung von `Status` aufruft, läuft genau dann in eine `NullReferenceException`, also sichern Sie ihn ab:

```csharp
// .NET 11, C# 14
catch (Exception ex)
{
    if (whenAll.Exception is { } aggregate)
    {
        foreach (var inner in aggregate.InnerExceptions) _logger.LogError(inner, "Step failed");
    }
    else
    {
        _logger.LogWarning(ex, "Batch was canceled");
    }
    throw;
}
```

Einen echten Abbruch von einem als Abbruch verkleideten Timeout zu unterscheiden, ist eine eigene Falle, behandelt in [warum HttpClient eine TaskCanceledException wirft](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/).

## Stolperfallen und Varianten

- **Sie fangen `AggregateException` und es funktioniert.** Dann warten Sie nicht mit `await`. `.Wait()`, `.Result` und `Task.WaitAll` werfen die Hülle unverändert, und nur deshalb taucht der Typname in einem `catch` auf. Das bedeutet zugleich, dass Sie einen Thread blockieren, mit allen Folgen: siehe [.Result vs .Wait() vs GetAwaiter().GetResult() vs await](/de/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/).

- **`Flatten()` ist hier wirkungslos.** `AggregateException.Flatten` existiert für verschachtelte Aggregationen, aber `Task.WhenAll` packt seine Bestandteile bereits aus, sodass sogar ein `WhenAll` über ein `WhenAll` eine flache Liste liefert. Verifiziert: Drei Fehler über zwei Ebenen verschachtelt ergaben vor und nach `Flatten()` jeweils drei innere Exceptions. Heben Sie `Flatten()` für `Parallel.ForEach` und PLINQ auf, wo Verschachtelung real ist.

- **Eine zweimal aufgezählte lazy LINQ-Abfrage startet die Arbeit zweimal.** `Enumerable.Range(0, 3).Select(_ => DoAsync())` ist eine Abfrage, keine Liste. `Task.WhenAll` zählt sie einmal auf, aber dieselbe Abfrage an ein zweites `WhenAll` zu übergeben (oder an `.Count()` für eine Log-Zeile) führt alles erneut aus. Gemessen: drei Tasks nach dem ersten `WhenAll` gestartet, sechs nach dem zweiten. Rufen Sie `.ToArray()` auf, bevor Sie eine Projektion an `WhenAll` übergeben.

- **`Task.WhenAll` stoppt nicht beim ersten Fehler.** Jeder Task läuft bis zum Ende, auch nachdem einer geworfen hat, und genau deshalb bekommen Sie mehrere Exceptions. Soll das Fan-out den Rest abbrechen, brauchen Sie eine `CancellationTokenSource`, die die Tasks beachten, verdrahtet wie in [einen CancellationToken durch asynchrone Methoden weiterreichen](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

- **`Task.WhenAll` hat keine Nebenläufigkeitsgrenze.** Wenn die Aggregation voller Socket-Exceptions und Timeouts steckt, ist der eigentliche Fehler vielleicht, dass Sie 5.000 Anfragen gleichzeitig gestartet haben. Die Alternativen mit Nebenläufigkeitslimit werden in [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/de/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) verglichen.

- **Fehler treffen spät ein.** `WhenAll` sagt Ihnen nichts, bis der langsamste Task fertig ist, sodass ein schneller Fehler hinter einem langsamen Erfolg unsichtbar bleibt. Wenn Sie auf jedes Ergebnis reagieren wollen, sobald es eintrifft, liefert [Task.WhenEach](/de/2026/01/streaming-tasks-with-net-9-task-wheneach/) ein `IAsyncEnumerable<Task>` in Abschlussreihenfolge.

- **Eine leere Sammlung ist erfolgreich.** `Task.WhenAll(Array.Empty<Task>())` geht direkt in `RanToCompletion` über. Ein Batch-Job, der bei leerer Eingabe Erfolg meldet, ist meist ein Filterfehler weiter oben und kein `WhenAll`-Fehler.

- **Das Warten auf den `WhenAll`-Task beobachtet jede innere Exception.** Sie bekommen keine `TaskScheduler.UnobservedTaskException` für die Fehler, die Sie nicht gesehen haben, denn `WhenAll` hat sie bereits für Sie beobachtet. Bequem, und zugleich der Grund, warum die Verluste so leise sind.

Das Denkmodell in einem Satz: `Task.WhenAll` sammelt jeden Fehler treu, und `await` ist der verlustbehaftete Schritt. Geben Sie dem zurückgegebenen Task einen Namen, dann geht nichts verloren.

## Verwandte Artikel

- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll in C#](/de/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) zur Wahl der richtigen Fan-out-Primitive und zur Begrenzung der Nebenläufigkeit.
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#](/de/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) dazu, warum gerade das Blockieren die rohe `AggregateException` sichtbar macht.
- [Fix: TaskCanceledException: A task was canceled in HttpClient](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) für den Abbruchfall, den ein fehlgeschlagenes `WhenAll` verschluckt.
- [Streaming von Tasks mit Task.WhenEach in .NET 9](/de/2026/01/streaming-tasks-with-net-9-task-wheneach/) zur Verarbeitung jedes Ergebnisses, sobald es fertig ist, statt auf das langsamste zu warten.
- [Einen CancellationToken durch asynchrone Methoden in .NET 11 weiterreichen](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/), damit ein Fan-out die restliche Arbeit abbricht.

## Quellen

- Microsoft Learn, [Methode Task.WhenAll](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (die oben zitierten Regeln zu Faulted, Canceled und `RanToCompletion`).
- Microsoft Learn, [Klasse AggregateException](https://learn.microsoft.com/en-us/dotnet/api/system.aggregateexception) (`InnerExceptions`, `Flatten`, `Handle` und die Meldung "One or more errors occurred").
- Microsoft Learn, [Exception-Behandlung bei Task](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) und [Exception-Behandlung in der TPL](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/exception-handling-task-parallel-library).
- dotnet/runtime, [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs) (`WhenAllPromise` und `WhenAllPromise<T>`, der Unterschied zwischen Abschluss- und Argumentreihenfolge).
- dotnet/runtime, [Issue #93504: Awaiting nongeneric Task.WhenAll changes behavior in .NET 8](https://github.com/dotnet/runtime/issues/93504) (als "not planned" geschlossen, nicht dokumentiert).
- dotnet/runtime, [Issue #31494: Task.WhenAll inner exceptions are lost](https://github.com/dotnet/runtime/issues/31494) und [Issue #47605: Configure an await to propagate all errors](https://github.com/dotnet/runtime/issues/47605).
