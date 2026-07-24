---
title: ".Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#: welches sollten Sie verwenden?"
description: "await ist fast immer die richtige Antwort. Wenn Sie wirklich blockieren müssen, schlägt GetAwaiter().GetResult() sowohl .Result als auch .Wait(), weil es die ursprüngliche Ausnahme wirft. Eine Entscheidungsmatrix für .NET 11 und C# 14."
pubDate: 2026-07-24
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "de"
translationOf: "2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-24
---

Wenn Sie einen `Task<T>` haben und das `T` herausholen möchten, haben Sie vier Optionen: `task.Result`, `task.Wait()`, `task.GetAwaiter().GetResult()` und `await task`. Verwenden Sie `await`. Es ist die einzige, die keinen Thread blockiert, und es wirft genau die Ausnahme, die Ihr Code geworfen hat, statt eines Wrappers. Die anderen drei blockieren den aufrufenden Thread und riskieren einen Deadlock; unter ihnen ist `GetAwaiter().GetResult()` die am wenigsten schlechte, weil sie Ausnahmen genauso auspackt wie `await`. Greifen Sie nur darauf zurück, wenn Sie in einer synchronen Methode feststecken, die Sie nicht `async` machen können. Das gilt in .NET 11 (`Microsoft.NET.Sdk` 11.0.0) mit C# 14, und die Semantik ist seit .NET Framework 4.5 stabil.

## Die vier auf einen Blick

| Verhalten                            | `await`            | `GetAwaiter().GetResult()` | `.Result`           | `.Wait()`           |
| ------------------------------------ | ------------------ | -------------------------- | ------------------- | ------------------- |
| Blockiert den aufrufenden Thread     | nein               | ja                         | ja                  | ja                  |
| Gibt einen Wert zurück               | ja (`T`)           | ja (`T`)                   | ja (`T`)            | nein (void)         |
| Funktioniert mit nicht-generischem `Task` | ja            | ja                         | nein (nur `Task<T>`)| ja                  |
| Geworfene Ausnahme                   | original           | original                   | `AggregateException`| `AggregateException`|
| Deadlock-Risiko (erfasster Kontext)  | nein               | ja                         | ja                  | ja                  |
| Thread-Pool-Starvation unter Last    | nein               | ja                         | ja                  | ja                  |
| Sicher bei `ValueTask<T>`            | ja (einmal)        | nein                       | nur wenn abgeschlossen | n/a              |

Lesen Sie diese Tabelle für `await` von oben nach unten, und Sie erhalten eine saubere Spalte: keine Blockierung, echter Wert, ursprüngliche Ausnahme, kein Deadlock. Jede andere Spalte hat mindestens ein "ja" in einer Zeile, die Sie nicht wollen. Das ist das gesamte Argument. Der Rest dieses Artikels erklärt, warum jede Zeile wahr ist und wann der Kompromiss Ihre Hand tatsächlich zwingt.

## Warum await standardmäßig gewinnt

`await` ist keine ausgefeiltere Art, `.Result` aufzurufen. Es ist eine andere Operation. Wenn Sie einen Task per `await` abwarten, der noch nicht abgeschlossen ist, wird die Methode suspendiert und gibt die Kontrolle an ihren Aufrufer zurück. Kein Thread sitzt da und wartet. Die Laufzeit plant den Rest Ihrer Methode als Continuation, die ausgeführt wird, wenn der Task fertig ist. Ein blockierendes Member macht das Gegenteil: Es parkt den aktuellen Thread und hält ihn, bis der Task fertig ist.

Dieser eine Unterschied ist der Grund, warum `await` skaliert und Blockieren nicht. Auf einem Server ist ein blockierter Thread ein Thread-Pool-Thread, der nichts anderes tut als warten, und unter Last gehen sie Ihnen aus. Auf einem UI-Thread ist ein blockierter Thread ein eingefrorenes Fenster. `await` gibt den Thread frei, um andere Arbeit zu erledigen (eine andere Anfrage bedienen, die Nachrichtenschleife pumpen), und nimmt Ihre Methode später wieder auf.

```csharp
// .NET 11, C# 14 -- the default: no thread is blocked while the I/O runs
public async Task<string> GetGreetingAsync(HttpClient http)
{
    string body = await http.GetStringAsync("https://example.com/greeting");
    return body.Trim();
}
```

`await` gibt Ihnen auch die Ausnahme, die Sie tatsächlich geworfen haben. Wenn `GetStringAsync` einen `HttpRequestException` wirft, wirft der `await` diesen `HttpRequestException` erneut, mit seinem ursprünglichen Stack Trace, genau dort, wo Sie awaited haben. Kein Auspacken, keine `catch (AggregateException)`-Gymnastik. Sofern Sie keinen konkreten Grund zum Blockieren haben, endet die Entscheidung hier.

## Wann GetAwaiter().GetResult() der richtige blockierende Aufruf ist

Manchmal können Sie nicht asynchron sein. Ein Klassenkonstruktor kann nicht `async` sein. Ein `Main` vor C# 7.1, ein `Dispose` (nicht `DisposeAsync`), eine Interface-Methode, deren Signatur Sie nicht kontrollieren, ein Einstiegspunkt eines Drittanbieter-Plugins, der Ihnen ein synchrones Delegate übergibt: Das sind echte synchrone Nahtstellen. Wenn Sie asynchronen Code aus einer davon aufrufen müssen und nicht umstrukturieren können, müssen Sie auf etwas blockieren. Blockieren Sie auf `GetAwaiter().GetResult()`.

Der Grund, warum sie `.Result` und `.Wait()` schlägt, ist die Ausnahmetreue. `Task.Result` und `Task.Wait()` sind älter als `async`/`await`; sie stammen aus der Task Parallel Library von .NET 4.0, wo ein einzelner `Task` (denken Sie an `Task.WhenAll`) mit mehreren Ausnahmen gleichzeitig fehlschlagen konnte. Um das darzustellen, verpacken sie das, was schiefging, in einen `AggregateException`, selbst wenn es genau eine innere Ausnahme gibt. `GetAwaiter().GetResult()` wurde mit `async`/`await` in .NET 4.5 hinzugefügt und folgt der `await`-Konvention: Es wirft die erste Ausnahme direkt, ohne Wrapper.

```csharp
// .NET 11, C# 14 -- same failing task, three different exceptions surfaced
static async Task<int> FailAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}

// .Result -> throws AggregateException wrapping InvalidOperationException
try { _ = FailAsync().Result; }
catch (Exception ex) { Console.WriteLine(ex.GetType().Name); } // AggregateException

// GetAwaiter().GetResult() -> throws InvalidOperationException directly
try { _ = FailAsync().GetAwaiter().GetResult(); }
catch (Exception ex) { Console.WriteLine(ex.GetType().Name); } // InvalidOperationException
```

Wenn Ihre `catch`-Blöcke für `InvalidOperationException` geschrieben sind (wie es sein sollte), umgeht `.Result` sie stillschweigend, weil die Ausnahme verpackt ankommt. Sie fangen am Ende `AggregateException` und rufen `.InnerException` auf, oder schlimmer, die Ausnahme bleibt unbehandelt, weil niemand den Wrapper erwartet hat. `GetAwaiter().GetResult()` vermeidet all das. Deshalb lautet die Standardempfehlung, die auf Stephen Clearys Serie "A Tour of Task" zurückgeht: Wenn Sie keine Wahl haben, als zu blockieren, blockieren Sie mit `GetAwaiter().GetResult()`.

Sie funktioniert auch mit einem nicht-generischen `Task`, also ist sie der einzige blockierende Aufruf, der sowohl "führe das aus und warte" als auch "führe das aus und gib mir den Wert" abdeckt:

```csharp
// .NET 11, C# 14 -- blocks and unwraps, whether or not there is a return value
SaveAsync().GetAwaiter().GetResult();               // Task, no value
int count = CountAsync().GetAwaiter().GetResult();   // Task<int>, value
```

## Warum .Result und .Wait() strikt schlechter sind

`.Result` und `.Wait()` tun alles, was `GetAwaiter().GetResult()` tut (den Thread blockieren, dieselbe Deadlock-Gefahr), und fügen den `AggregateException`-Wrapper obendrauf. Es gibt kein Szenario, in dem der Wrapper Ihnen hilft, wenn der Task eine einzelne logische Operation ist. Der einzige Ort, an dem `.Result` sich akzeptabel liest, ist bei einem Task, von dem Sie bereits wissen, dass er abgeschlossen ist, wo er nicht blockiert:

```csharp
// .NET 11, C# 14 -- .Result on a known-completed task does not block
if (task.IsCompletedSuccessfully)
{
    var value = task.Result;   // safe: completed, so no wait, no deadlock
}
```

Selbst dort ist `GetAwaiter().GetResult()` ein feiner Ersatz und hält Ihre Ausnahmebehandlung einheitlich, falls sich die Annahme über die Fertigstellung je als falsch erweist. `.Wait()` hat die engste legitime Verwendung: das Warten auf einen Fire-and-forget-`Task`, bei dem Sie bewusst keinen Rückgabewert wollen und `AggregateException` explizit behandeln. In der Praxis ist das selten, und es ist meist ein Zeichen, dass die Arbeit als richtiger Hintergrundjob hätte strukturiert werden sollen. Wenn Sie Arbeit außerhalb des Anfrage-Threads ausführen, tun Sie das mit den Mustern aus [Fire-and-forget-Arbeit sicher mit BackgroundService ausführen](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/), statt auf einen losen Task zu blockieren.

Es gibt eine echte Falle bei `.Wait(timeout)` und `.Wait(cancellationToken)`. Sie lassen das Warten früh aufgeben, was wie Resilienz aussieht, aber keine ist. Ein `Wait(5000)`, das `false` zurückgibt, hat die zugrunde liegende Operation nicht abgebrochen; der Task läuft weiter, seine Continuation ist weiterhin in der Warteschlange, und Sie haben lediglich aufgehört, auf ihn zu warten. Sie haben ein Hängen mit einer magischen Zahl überdeckt. Wenn Sie eine Operation begrenzen müssen, brechen Sie sie ordnungsgemäß ab, wie in [eine asynchrone Operation mit CancellationTokenSource.CancelAfter abbrechen](/de/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/) beschrieben.

## Das Detail, das für Sie entscheidet: Deadlocks und ValueTask

Zwei Dinge können Ihnen die Wahl vollständig abnehmen.

**Ein erfasster `SynchronizationContext`.** Wenn der Thread, auf den Sie blockieren, einen Single-Thread-Kontext besitzt (ein WPF- oder WinForms-UI-Thread, ein klassischer ASP.NET-Anfrage-Thread), kann jede blockierende Option in diesem Vergleich zu einem Deadlock führen, und ein Wechsel zwischen ihnen hilft nicht. `GetAwaiter().GetResult()` blockiert genau an derselben Stelle wie `.Result`; das bessere Ausnahmeverhalten ist ein schwacher Trost, wenn die Anwendung hängt. Der Mechanismus und jede Korrektur in bevorzugter Reihenfolge stehen in [warum das Blockieren auf einer asynchronen Methode zu einem Deadlock führt und wie man ihn behebt](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/). Die Kurzfassung: Auf einem UI- oder klassischen ASP.NET-Thread blockieren Sie überhaupt nicht. In ASP.NET Core gibt es keinen `SynchronizationContext`, also bekommen Sie diesen spezifischen Deadlock nicht, aber Blockieren verursacht trotzdem Thread-Pool-Starvation unter Last, die schwerer zu diagnostizieren ist, weil sie nur bei Nebenläufigkeit auftaucht.

**Ein `ValueTask<T>`.** Wenn die Methode `ValueTask<T>` statt `Task<T>` zurückgibt, ist keines der blockierenden Member sicher direkt verwendbar. Ein `ValueTask` kann von einem `IValueTaskSource` gestützt werden, der nach dem Verbrauch des Werts wiederverwendet werden kann, und er darf nur einmal verbraucht werden. `.Result` oder `.GetAwaiter().GetResult()` auf einem `ValueTask` aufzurufen, der nicht abgeschlossen ist, ist undefiniertes Verhalten, und ihn zweimal per await abzuwarten ist ein Bug. Wenn Ihnen ein `ValueTask<T>` übergeben wird und Sie ihn wirklich nicht awaiten können, wandeln Sie ihn zuerst mit `.AsTask()` in einen `Task<T>` um und blockieren Sie darauf:

```csharp
// .NET 11, C# 14 -- never block a ValueTask directly; materialize a Task first
ValueTask<int> vt = ReadValueAsync();
int value = vt.AsTask().GetAwaiter().GetResult();   // safe
// int bad = vt.Result;                              // undefined if not completed
```

Die sauberere Regel lautet: Awaiten Sie einen `ValueTask` genau einmal und speichern Sie ihn nie. Auf einen zu blockieren ist ein Design-Geruch auf einem Design-Geruch. Für die vollständige Menge der Einschränkungen siehe die Notiz zu [wann ValueTask sich lohnt](/de/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

## Das Blockieren überflüssig machen

Meistens ist die ehrliche Korrektur, den blockierenden Aufruf zu löschen, nicht den am wenigsten schädlichen zu wählen. Blockieren existiert fast immer, weil jemand aufgehört hat, `async` in einer Schicht zu propagieren, die hätte weitermachen können. Eine synchrone Controller-Action, die ein asynchrones Repository aufruft, ein `void`-Event-Handler, der "nur jetzt den Wert braucht": Beide können in der Regel `async Task` werden (oder `async void` für den Handler, dem einzigen Ort, an dem es legitim ist). Die Grenze zwischen einem korrekten `async void` und einem Bug ist in [wann async void korrekt ist und wann es eine Falle ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) dargelegt.

Wenn Sie eine Kette von oben bis unten asynchron machen, verdampft der gesamte Vergleich in diesem Artikel. Sie berühren nie `.Result`, `.Wait()` oder `GetAwaiter().GetResult()`, weil Sie immer ein `await` zur Verfügung haben. Das ist die eigentliche Empfehlung, die sich hinter der Entscheidungsmatrix verbirgt: Der beste blockierende Aufruf ist der, den Sie wegrefaktoriert haben.

## Die Empfehlung, noch einmal

- **Standardmäßig `await`.** Es blockiert nicht, es skaliert, und es wirft die ursprüngliche Ausnahme. Wenn die umgebende Methode `async` sein kann, ist das die Antwort, Punkt.
- **Wenn Sie wirklich nicht asynchron sein können, blockieren Sie mit `GetAwaiter().GetResult()`.** Es blockiert wie die anderen, wirft aber die echte Ausnahme statt eines `AggregateException`, und es funktioniert sowohl mit `Task` als auch mit `Task<T>`.
- **Vermeiden Sie `.Result` und `.Wait()`** außer bei einem Task, von dem Sie bereits wissen, dass er abgeschlossen ist. Sie fügen den `AggregateException`-Wrapper ohne Nutzen bei einzelnen Operationen hinzu.
- **Blockieren Sie nie auf einem UI- oder klassischen ASP.NET-Thread**, und blockieren Sie nie direkt einen `ValueTask`. Ersteres führt zum Deadlock; Letzteres ist undefiniertes Verhalten. Wandeln Sie den `ValueTask` mit `.AsTask()` in einen `Task` um, wenn Sie keine Alternative haben.

Behandeln Sie jeden blockierenden Aufruf als `TODO`, den Aufrufer asynchron zu machen. Die Version Ihres Codes, die nie blockiert, ist schneller, deadlock-sicher und hat gratis sauberere Ausnahmen.

## Verwandt

- [Fix: Deadlock beim Aufruf von .Result oder .Wait() auf einer asynchronen Methode in C#](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [Wann async void korrekt ist und wann es eine Falle ist in C#](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [ConfigureAwait(false) gegenüber dem Standard in .NET 11: spielt es noch eine Rolle?](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Was ist ValueTask und wann lohnt es sich?](/de/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [Wie man eine asynchrone Operation mit CancellationTokenSource.CancelAfter in C# per Timeout beendet](/de/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)

## Quellen

- [A Tour of Task, Part 6: Results](https://blog.stephencleary.com/2014/12/a-tour-of-task-part-6-results.html) -- Stephen Cleary
- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
- [TaskAwaiter.GetResult Method](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.taskawaiter.getresult) -- Microsoft Learn
- [Task exception handling in .NET](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) -- Microsoft Learn
- [ValueTask Restrictions](https://blog.stephencleary.com/2020/03/valuetask.html) -- Stephen Cleary
