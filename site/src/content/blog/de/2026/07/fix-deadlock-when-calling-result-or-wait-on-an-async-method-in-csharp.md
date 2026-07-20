---
title: "Lösung: Deadlock beim Aufruf von .Result oder .Wait() auf einer async-Methode in C#"
description: "Das Blockieren einer async-Task mit .Result oder .Wait() führt zu einem Deadlock, wenn ein SynchronizationContext vorhanden ist. Hier erkläre ich, warum es hängt und wie Sie es in .NET 11 und C# 14 lösen."
pubDate: 2026-07-20
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "deadlock"
lang: "de"
translationOf: "2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-20
---

Wenn ein Aufruf von `task.Result`, `task.Wait()` oder `task.GetAwaiter().GetResult()` für immer hängt und nie eine Ausnahme wirft, haben Sie einen sync-über-async Deadlock. Er entsteht, wenn Sie einen Thread blockieren, der einen SynchronizationContext mit nur einem Thread besitzt (einen WPF- oder WinForms-UI-Thread, einen Anfrage-Thread des klassischen ASP.NET), während die async-Methode, die Sie blockieren, versucht, ihre Fortsetzung zurück auf demselben Thread fortzusetzen. Der Thread steckt fest und wartet auf die Task; die Task steckt fest und wartet auf den Thread. Die Lösung ist, mit dem Blockieren aufzuhören: die gesamte Aufrufkette durchgängig asynchron zu machen, sodass Sie `await` statt `.Result` verwenden. Dieser Artikel erklärt den Mechanismus in .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) und geht jede Lösung in der Reihenfolge der Präferenz durch, einschließlich derer, die richtig aussehen, aber nicht funktionieren.

## Warum der Thread auf sich selbst wartet

Ein `await` tut zwei Dinge, die die Leute vergessen. Bevor es sich aussetzt, erfasst es den aktuellen `SynchronizationContext` (über `SynchronizationContext.Current`). Wenn die erwartete Task abgeschlossen ist, wird sie nicht einfach auf irgendeinem Thread fortgesetzt: Standardmäßig postet sie die Fortsetzung, den Code nach dem `await`, zurück in diesen erfassten Kontext. Auf einem generischen Worker-Thread des Thread-Pools gibt es keinen Kontext, sodass die Fortsetzung auf einem beliebigen freien Pool-Thread läuft und nichts Besonderes passiert. Aber auf einem UI-Thread oder in einer klassischen ASP.NET-Anfrage hat der Kontext nur einen Thread. Er hat genau einen Thread, der seine eingereihte Arbeit ausführen darf.

Stellen Sie diese beiden Tatsachen nun neben einen blockierenden Aufruf:

1. Ihr UI-Thread ruft `GetDataAsync().Result` auf. Das blockiert den UI-Thread und hält ihn.
2. Innerhalb von `GetDataAsync` hat ein `await SomeIoAsync()` den UI-`SynchronizationContext` erfasst, bevor es sich ausgesetzt hat.
3. `SomeIoAsync` ist fertig. Die Laufzeit versucht, die Fortsetzung von `GetDataAsync` zurück in den UI-Kontext zu posten, um den Rest der Methode auszuführen und die Task abzuschließen.
4. Der UI-Kontext hat einen Thread. Dieser Thread ist bei Schritt 1 blockiert und wartet auf den Abschluss der Task. Er wird die Fortsetzung nie aufnehmen.
5. Die Task kann nicht abgeschlossen werden, bis die Fortsetzung läuft. Die Fortsetzung kann nicht laufen, bis der Thread frei wird. Der Thread wird nicht frei, bis die Task abgeschlossen ist. Deadlock.

Stephen Cleary hat dieses Muster vor Jahren in [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) benannt, und der Mechanismus hat sich nicht geändert. Die Laufzeit ist nicht fehlerhaft. Das Blockieren einer Task, deren Fortsetzung den Thread benötigt, den Sie blockieren, ist ein echtes zirkuläres Warten.

## Die kleinste Reproduktion, die hängt

Sie brauchen zwei Dinge: einen `SynchronizationContext` mit nur einem Thread und einen blockierenden Aufruf über einem `await`, das ihn erfasst. Ein WinForms-Button-Handler ist die klassische Reproduktion, aber Sie brauchen kein UI-Projekt. Sie können einen Kontext mit einem einzigen Thread von Hand installieren und ihn hängen sehen.

```csharp
// .NET 11, C# 14 -- this deadlocks
using System.Threading;

var context = new SingleThreadedSyncContext();
SynchronizationContext.SetSynchronizationContext(context);

// Block on an async method from the context-owning thread:
string result = GetGreetingAsync().Result;   // hangs forever
Console.WriteLine(result);

static async Task<string> GetGreetingAsync()
{
    // Captures the current (single-threaded) context here:
    await Task.Delay(100);
    // The runtime tries to post THIS line back to the captured context,
    // but that thread is blocked on .Result above.
    return "hello";
}
```

In einer echten WPF- oder WinForms-Anwendung schreiben Sie `SetSynchronizationContext` nicht selbst. Das Framework installiert einen `DispatcherSynchronizationContext` (WPF) oder einen `WindowsFormsSynchronizationContext` (WinForms) auf dem UI-Thread, bevor Ihre Ereignis-Handler laufen, sodass jeder Handler, der `SomethingAsync().Result` macht, dies sofort reproduziert. Das klassische ASP.NET (System.Web, nicht ASP.NET Core) installiert `AspNetSynchronizationContext` auf dem Anfrage-Thread mit demselben Verhalten eines einzigen Threads.

## Die einzige echte Lösung: durchgängig asynchron

Der Deadlock existiert, weil Sie blockiert haben. Entfernen Sie die Blockierung, und er ist weg. Propagieren Sie `async`/`await` die Aufrufkette hinauf, bis der äußerste Aufrufer `await` verwenden kann, statt `.Result` zu lesen.

```csharp
// .NET 11, C# 14 -- no block, no deadlock
private async void OnLoadClick(object sender, EventArgs e)
{
    string greeting = await GetGreetingAsync();   // await, not .Result
    label.Text = greeting;
}
```

Hier erfasst `await` immer noch den UI-Kontext, aber nichts blockiert den UI-Thread. Der Handler setzt sich aus, der UI-Thread kehrt zur Nachrichtenschleife zurück und bleibt frei, und wenn `GetGreetingAsync` abgeschlossen ist, wird seine Fortsetzung zurückgepostet und läuft sauber auf dem nun untätigen UI-Thread. Genau dafür ist ein UI-`SynchronizationContext` da. Die Fortsetzung landet zurück auf dem UI-Thread, sodass Sie `label.Text` ohne Marshalling anfassen können.

Ereignis-Handler sind der einzige zulässige Ort für `async void`, gerade weil sie an der Spitze des Aufrufstapels stehen und keinen Aufrufer haben, der auf sie wartet. Alles darunter sollte `async Task` sein. Wenn Sie sich nicht sicher sind, wo `async void` legitim ist und wo es ein Bug ist, wird die Unterscheidung in [wann async void korrekt ist und wann es eine Falle ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) behandelt.

Dieselbe Regel gilt auf dem Server. Eine klassische ASP.NET-MVC-Action, ein Razor-Page-Handler, eine SignalR-Hub-Methode: machen Sie sie `async Task` und verwenden Sie `await` auf der Arbeit, statt zu blockieren. Hier gibt es keine Teilpunkte. Ein einziges `.Result` an irgendeiner Stelle im synchronen Pfad kann den Deadlock wieder einführen, selbst wenn jede andere Schicht asynchron ist.

## Die Bibliotheks-Lösung: ConfigureAwait(false)

Manchmal können Sie nicht die gesamte Kette async machen, weil der blockierende Aufruf in Code lebt, den Sie nicht besitzen. Wenn Sie der Autor der async-Bibliothek sind, auf die blockiert wird, können Sie den Deadlock von Ihrer Seite aus entschärfen, indem Sie jedem `await` sagen, den Kontext nicht zu erfassen:

```csharp
// .NET 11, C# 14 -- library code that stays deadlock-safe under a blocking caller
public async Task<string> GetGreetingAsync()
{
    await Task.Delay(100).ConfigureAwait(false);
    // No captured context, so this continuation runs on a thread pool
    // thread, not the caller's blocked UI/request thread.
    return "hello";
}
```

`ConfigureAwait(false)` sagt "ich muss nicht im erfassten Kontext fortgesetzt werden." Die Fortsetzung läuft stattdessen auf einem Thread-Pool-Thread, der nicht der blockierte ist, sodass das zirkuläre Warten nie entsteht und die Task abgeschlossen werden kann. Deshalb lautet die Empfehlung für gemeinsam genutzte Bibliotheken, `.ConfigureAwait(false)` an jedes await zu setzen, wie Microsoft in der [ConfigureAwait FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/) darlegt.

Zwei Vorbehalte verhindern, dass dies ein Allheilmittel ist. Erstens hilft es nur, wenn es an jedem `await` in der gesamten transitiven Hülle des blockierten Aufrufs angewendet wird. Übersehen Sie ein einziges await tief in einer Abhängigkeit, und der Deadlock kehrt zurück, was genau der Grund ist, warum es eine Bibliotheks-Disziplin ist und keine Lösung, die Sie an der Aufrufstelle verstreuen. Zweitens sollten Sie in Ihrem eigenen Anwendungscode gar nicht erst blockieren, sodass `ConfigureAwait(false)` im Anwendungscode ein Symptom behandelt. Die Nuance, wann es noch von Bedeutung ist und wann die Compiler-Analyzer Sie dazu drängen, findet sich in [ConfigureAwait(false) gegenüber dem Standardverhalten in .NET 11](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## Lösungen, die richtig aussehen, aber nicht funktionieren

**`.Result` durch `.GetAwaiter().GetResult()` ersetzen.** Die Leute greifen dazu, weil es die Ausnahme auspackt, statt sie in `AggregateException` zu verpacken. Am Deadlock ändert es nichts. `GetAwaiter().GetResult()` blockiert weiterhin den aufrufenden Thread, bis die Task abgeschlossen ist, und die Task kann weiterhin nicht abgeschlossen werden, weil ihre Fortsetzung hinter der Blockierung eingereiht ist. Bessere Ausnahmen, identisches Hängen.

**Einen Timeout mit `Wait(TimeSpan)` hinzufügen.** `task.Wait(5000)` gibt nach fünf Sekunden `false` zurück, statt für immer zu hängen, aber das ist keine Lösung, es ist ein langsameres Scheitern. Die Operation wurde immer noch nicht abgeschlossen, und Sie haben nun ein Design-Problem mit einer magischen Zahl überklebt. Die zugrunde liegende Fortsetzung steckt immer noch fest.

**Die async-Methode in `Task.Run` einwickeln und darauf blockieren.** Dieser durchbricht den Deadlock tatsächlich, und deshalb ist er gefährlich. `Task.Run(() => GetGreetingAsync()).GetAwaiter().GetResult()` startet die async-Methode auf einem Thread-Pool-Thread, der keinen Kontext mit nur einem Thread hat, sodass ihre Fortsetzungen nicht mehr auf Ihren blockierten UI-Thread zielen. Das Hängen verschwindet.

```csharp
// .NET 11, C# 14 -- avoids the deadlock, but it is a smell, not a solution
string greeting = Task.Run(() => GetGreetingAsync()).GetAwaiter().GetResult();
```

Es funktioniert, aber nun verbrennen Sie einen Thread-Pool-Thread, um einen anderen Thread zu blockieren, Sie haben den UI-Kontext für jede Fortsetzung verloren, die ihn legitim benötigte, und Sie haben die Tatsache verborgen, dass der Aufruf hätte asynchron sein sollen. Microsoft dokumentiert dieses Auslagerungsmuster unter [synchrone Wrapper für asynchrone Methoden](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/synchronous-wrappers-for-asynchronous-methods) mit derselben Warnung: behandeln Sie es als letzten Ausweg für einen wirklich nur-synchronen Einstiegspunkt, nicht als Weg, weiter blockierenden Code zu schreiben.

## Warum ASP.NET Core hier keinen Deadlock verursacht (und wie es anders zubeißt)

Wenn Sie von klassischem ASP.NET zu ASP.NET Core gewechselt sind und Ihre alten Deadlocks verschwunden sind, ist dies der Grund: ASP.NET Core hat keinen `SynchronizationContext`. `SynchronizationContext.Current` ist innerhalb einer Anfrage `null`, sodass `await` nie einen Kontext mit nur einem Thread erfasst, Fortsetzungen immer auf Thread-Pool-Threads laufen und das oben beschriebene spezifische zirkuläre Warten nicht entstehen kann. Deshalb hat auch `ConfigureAwait(false)` keine Wirkung in einem ASP.NET-Core-Anfrage-Handler: es gibt keinen Kontext, aus dem man sich abmelden könnte.

Das macht das Blockieren in ASP.NET Core nicht sicher. Es tauscht einen deterministischen Deadlock gegen einen probabilistischen, der Thread-Pool-Starvation heißt. Jede Anfrage, die auf `.Result` blockiert, parkt einen Thread-Pool-Thread, der nichts tut außer zu warten. Unter Last teilt der Pool Threads schneller aus, als die (standardmäßig graduelle) Injektionsrate die geparkten ersetzen kann, sodass neue Anfragen ohne einen Thread zum Laufen in die Warteschlange geraten. Die Anwendung hängt nicht bei Anfrage eins; sie bricht bei einer Nebenläufigkeit zusammen, die Sie auf Ihrem Laptop nicht reproduzieren können. Die Heilung ist identisch: nicht blockieren, durchgängig asynchron gehen. Wenn Ihre Blockierung dazu diente, eine lange Operation zu begrenzen, tun Sie das stattdessen mit Abbruch, wie in [eine lang laufende Task ohne Deadlock abbrechen](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), und stellen Sie sicher, dass das Token die Blatt-Aufrufstelle tatsächlich erreicht, indem Sie [das CancellationToken durch die Kette propagieren](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

## Eine Checkliste zur Jagd auf die Blockierung, die hängt

Wenn etwas hängt und Sie dies vermuten, suchen Sie die Blockierung, nicht die async-Methode:

1. **Durchsuchen Sie den synchronen Pfad nach `.Result`, `.Wait(` und `.GetAwaiter().GetResult()`.** Eines davon ist auf einem Thread, der einen Kontext besitzt. Das ist Ihr Übeltäter, nicht das unschuldige `await`, das es blockiert.
2. **Bestätigen Sie, dass ein Kontext mit nur einem Thread im Spiel ist.** UI-Thread, klassische ASP.NET-Anfrage oder ein benutzerdefinierter Kontext. Wenn Sie auf ASP.NET Core oder in einer einfachen Konsolenanwendung ohne installierten Kontext sind, ist das Symptom Starvation oder eine langsame Antwort, kein hartes Hängen.
3. **Ersetzen Sie die Blockierung durch `await` und machen Sie die umschließende Methode `async Task`.** Wiederholen Sie das den Stapel hinauf, bis Sie einen Einstiegspunkt erreichen, der asynchron sein kann (ein Ereignis-Handler, ein `Main`, eine Controller-Action).
4. **Wenn eine Schicht wirklich nicht async sein kann** und Sie die async-Bibliothek besitzen, fügen Sie `ConfigureAwait(false)` in dieser gesamten Bibliothek hinzu. Wenn Sie sie nicht besitzen, ist die Auslagerung mit `Task.Run` der letzte Ausweg, mit den obigen Kosten.
5. **"Beheben" Sie es nie mit einem Timeout.** Ein `Wait(timeout)`, das false zurückgibt, ist ein Deadlock, der aufgibt, kein Design, das funktioniert.

Der rote Faden ist einfach: async-Code will async bleiben. In dem Moment, in dem Sie ihn von einem Thread aus blockieren, den seine Fortsetzung benötigt, haben Sie von Hand ein zirkuläres Warten gebaut. Hören Sie auf zu blockieren, und der Deadlock kann nicht existieren. Alles andere auf dieser Seite ist Schadensbegrenzung für die Fälle, in denen Sie noch nicht aufhören können zu blockieren.

## Related

- [Wann async void korrekt ist und wann es eine Falle in C# ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [ConfigureAwait(false) gegenüber dem Standardverhalten in .NET 11: ist es noch von Bedeutung?](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Wie man eine lang laufende Task in C# ohne Deadlock abbricht](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [Wie man ein CancellationToken durch async-Methoden in .NET 11 propagiert](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)

## Sources

- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
- [ConfigureAwait FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/) -- .NET Blog
- [ASP.NET Core SynchronizationContext](https://blog.stephencleary.com/2017/03/aspnetcore-synchronization-context.html) -- Stephen Cleary
- [Synchronous wrappers for asynchronous methods](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/synchronous-wrappers-for-asynchronous-methods) -- Microsoft Learn
- [CA2007: Do not directly await a Task](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007) -- Microsoft Learn
