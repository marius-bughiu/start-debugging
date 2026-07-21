---
title: "Fix: CS4014 \"Because this call is not awaited, execution of the current method continues\" in C#"
description: "CS4014 bedeutet, dass Sie eine Task-zurückgebende Methode aufgerufen haben, ohne sie zu erwarten. Fügen Sie await hinzu, oder verwerfen Sie mit _ = bei echtem Fire-and-Forget, und behandeln Sie Ausnahmen."
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "de"
translationOf: "2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-21
---

`CS4014` wird ausgelöst, wenn Sie eine Methode aufrufen, die `Task` oder `Task<T>` zurückgibt, dies aus einer `async`-Methode heraus, ohne sie mit `await` zu erwarten. Der Compiler warnt, dass die aktuelle Methode weiterläuft, bevor der Aufruf abgeschlossen ist. Beheben Sie es, indem Sie dem Aufruf `await` hinzufügen, was in der überwiegenden Mehrheit der Fälle das Gewünschte ist. Wenn das Fire-and-Forget-Verhalten wirklich beabsichtigt ist, machen Sie das explizit, indem Sie das Ergebnis einer Verwerfung zuweisen (`_ = SomeAsyncCall();`), und stellen Sie sicher, dass etwas die Ausnahmen behandelt, die die Task auslösen könnte. Dies wurde gegen C# 14 auf .NET 11 verifiziert; das Diagnoseverhalten ist so, seit `async`/`await` in C# 5 eingeführt wurde, sodass die Anleitung für jede moderne .NET-Version gilt.

## Der Fehler im Kontext

Der Compiler gibt dies als Warnung aus, nicht als Fehler:

```
warning CS4014: Because this call is not awaited, execution of the current method continues before the call is completed. Consider applying the 'await' operator to the result of the call.
```

Beachten Sie das Wort *warning*. `CS4014` stoppt die Build standardmäßig nicht, und genau deshalb ist sie gefährlich: Sie lässt sich leicht ignorieren, und der Fehler, auf den sie hinweist (eine Task, die unbeobachtet läuft, deren Ausnahmen stillschweigend verschluckt werden), zeigt sich erst in der Produktion. Viele Teams stufen sie mit `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` oder dem engeren `<WarningsAsErrors>CS4014</WarningsAsErrors>` in der `.csproj` zu einem Fehler hoch, gerade damit ein versehentlich weggelassenes `await` nicht durch die Code-Review rutschen kann.

Die Warnung erscheint nur innerhalb einer `async`-Methode. Der Compiler geht davon aus, dass ein nicht erwarteter Task-Aufruf mit ziemlicher Sicherheit ein Versehen ist, wenn Sie sich schon die Mühe gemacht haben, die umschließende Methode als `async` zu markieren. Rufen Sie dieselbe Methode aus einer nicht-`async`-Methode auf, erhalten Sie überhaupt kein `CS4014`, was eine verwandte Falle ist, die weiter unten behandelt wird.

## Warum das passiert

Eine `async`-Methode, die `Task` zurückgibt, beginnt synchron zu laufen und gibt in dem Moment ein Task-Objekt zurück, in dem sie auf ihr erstes unvollständiges `await` trifft. Die Task repräsentiert die noch laufende Operation. Wenn Sie `DoWorkAsync();` als bloße Anweisung schreiben, werfen Sie dieses Task-Objekt weg. Daraus folgen zwei Dinge, und beide sind schlecht.

Erstens wartet die Ausführung nicht. Die Zeile nach Ihrem Aufruf läuft sofort, bevor `DoWorkAsync` fertig ist. Jeder Code, der vom Abschluss der Operation abhängt, ein Datenbankschreibvorgang, ein Datei-Flush, eine Cache-Aktualisierung, konkurriert nun mit ihr. Das ist die Hälfte "execution of the current method continues" der Meldung.

Zweitens, und schlimmer, verschwinden Ausnahmen. Wenn Sie eine Task mit `await` erwarten, wird jede von ihr erfasste Ausnahme in Ihre Methode zurückgeworfen, damit Ihr `try`/`catch` sie sehen kann. Verwerfen Sie die Task, bleibt nichts, was zurückgeworfen werden könnte. Die Ausnahme liegt auf dem verworfenen Task-Objekt, unbeobachtet, bis der Garbage Collector es irgendwann finalisiert. In .NET Framework 4.0 stürzte dadurch der Prozess ab; seit 4.5 und in allen modernen .NET-Versionen ist die Voreinstellung, sie vollständig zu verschlucken. Eine nicht erwartete Task, die fehlschlägt, sieht also aus Sicht des Aufrufers genau wie ein Erfolg aus. Dieser stille Fehlschlag ist der eigentliche Grund, warum es `CS4014` gibt, und warum "die Warnung einfach unterdrücken" fast nie richtig ist.

Der eine Fall, bei dem der Compiler nicht helfen kann: `async void`. Wenn `DoWorkAsync` statt `Task` `void` zurückgibt, gibt es keine Task zum Erwarten und kein `CS4014`, aber alle dieselben Probleme treten auf, plus ein weiteres: Eine Ausnahme aus einer `async void`-Methode wird auf dem Synchronisationskontext ausgelöst und reißt typischerweise den Prozess mit. Das ist eine separate Diagnose, behandelt in [async void vs async Task in C#](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

## Minimale Reproduktion

Der kleinste Code, der `CS4014` auslöst:

```csharp
// .NET 11, C# 14
public class OrderService
{
    public async Task PlaceOrderAsync(Order order)
    {
        SaveAsync(order);          // CS4014: not awaited
        Console.WriteLine("Order placed");   // runs before SaveAsync finishes
    }

    private async Task SaveAsync(Order order)
    {
        await Task.Delay(100);     // stand-in for a real DB write
        throw new InvalidOperationException("DB down");
    }
}
```

Zwei Fehler in vier Zeilen. `"Order placed"` wird ausgegeben, bevor der Schreibvorgang gelaufen ist, und die `InvalidOperationException` sieht niemand: `PlaceOrderAsync` wird erfolgreich abgeschlossen, soweit der Aufrufer das erkennen kann. Die Warnung ist das einzige Signal zur Kompilierzeit, dass die Bestellung nie wirklich gespeichert wurde.

Eine häufige Variante versteckt den Aufruf innerhalb eines `Task.Run` oder eines Event-Handlers, wo er leichter zu übersehen ist:

```csharp
// .NET 11, C# 14
button.Clicked += async (s, e) =>
{
    RefreshAsync();   // CS4014: fire-and-forget by accident
};
```

## Behebung im Detail

Arbeiten Sie diese der Reihe nach durch. Die erste ist für nahezu jedes reale Auftreten korrekt; der Rest ist für die echten Ausnahmen.

### 1. await hinzufügen (die Behebung, die Sie in 95 % der Fälle wollen)

Wenn Sie sich innerhalb einer `async`-Methode befinden, ist die Absicht fast immer, auf den Aufruf zu warten. Fügen Sie `await` hinzu:

```csharp
// .NET 11, C# 14
public async Task PlaceOrderAsync(Order order)
{
    await SaveAsync(order);        // waits, and re-throws any exception
    Console.WriteLine("Order placed");
}
```

Jetzt wird `"Order placed"` erst ausgegeben, nachdem der Schreibvorgang abgeschlossen ist, und wenn `SaveAsync` auslöst, propagiert die Ausnahme aus `PlaceOrderAsync` heraus, sodass ein `try`/`catch` des Aufrufers (oder die ASP.NET-Core-Pipeline) sie behandeln kann. Diese eine Änderung behebt den Reihenfolgefehler und den Fehler der verschluckten Ausnahme auf einmal. Greifen Sie nur dann zu den anderen Optionen, wenn Sie begründen können, warum das Warten falsch ist.

### 2. Mehrere Aufrufe zusammen mit Task.WhenAll erwarten

Wenn der Grund, warum Sie nicht mit `await` gewartet haben, der war, dass mehrere Operationen nebenläufig laufen sollten, verwerfen Sie die Tasks nicht, sammeln Sie sie und erwarten Sie sie zusammen:

```csharp
// .NET 11, C# 14
public async Task NotifyAllAsync(IEnumerable<User> users)
{
    var tasks = users.Select(u => SendEmailAsync(u));
    await Task.WhenAll(tasks);     // all run concurrently, all awaited
}
```

`Task.WhenAll` gibt Ihnen die Nebenläufigkeit, ohne auf Beobachtung zu verzichten: Es startet jede Task, wird dann abgeschlossen, wenn die letzte fertig ist, und wirft erneut, wenn eine von ihnen fehlgeschlagen ist. Das ist das korrekte Muster für Fan-out-Arbeit, und es beseitigt `CS4014`, weil die Tasks erwartet werden. Für die Abwägungen zwischen diesem und anderen parallelen Ansätzen siehe [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/de/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/).

### 3. Die Task zurückgeben, statt sie zu erwarten

Wenn Ihre Methode eine dünne Durchreiche ist, die nach dem Aufruf nichts tut, brauchen Sie oft überhaupt kein `async`/`await`. Entfernen Sie beides und geben Sie die Task zurück:

```csharp
// .NET 11, C# 14
public Task PlaceOrderAsync(Order order)
{
    return SaveAsync(order);       // caller awaits; no state machine here
}
```

Dies entfernt den `async`-Modifikator, sodass `CS4014` nicht mehr gilt (die Warnung wird nur innerhalb von `async`-Methoden erzeugt), und es spart die Kosten, eine Zustandsmaschine für eine Methode zu generieren, die sie nicht braucht. Der Aufrufer erhält weiterhin eine Task, die er mit `await` erwarten kann. Der einzige Vorbehalt: Ohne `await` treten Ausnahmen auf, wenn der Aufrufer die zurückgegebene Task erwartet, statt an der Stelle des Aufrufs, und ein `using`-Block würde seine Ressource freigeben, bevor die zurückgegebene Task abgeschlossen ist. Verwenden Sie dies nur für echte Durchreichen.

### 4. Explizit verwerfen, nur wenn Fire-and-Forget wirklich beabsichtigt ist

Manchmal wollen Sie tatsächlich Arbeit starten und nicht warten: eine Metrik protokollieren, einen Cache vorwärmen, eine Best-Effort-Benachrichtigung anstoßen. In diesem Fall machen Sie die Absicht mit einer Verwerfung unmissverständlich und behandeln die Ausnahmen selbst, damit sie nicht verloren gehen:

```csharp
// .NET 11, C# 14
public void OnUserLoggedIn(User user)
{
    _ = LogAnalyticsAsync(user);   // intentional fire-and-forget, warning cleared
}

private async Task LogAnalyticsAsync(User user)
{
    try
    {
        await _analytics.RecordAsync(user.Id);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Analytics failed for {UserId}", user.Id);
    }
}
```

Die Verwerfung `_ =` teilt sowohl dem Compiler als auch dem nächsten Leser mit: "Ja, ich wollte dies nicht erwarten." Entscheidend: Die Verwerfung beseitigt die Warnung, behebt aber *nicht* das Problem der verschluckten Ausnahme, sodass das `try`/`catch` innerhalb von `LogAnalyticsAsync` die eigentliche Arbeit leistet. Eine Fire-and-Forget-Task ohne interne Ausnahmebehandlung ist ein Absturz oder ein stiller Datenverlustfehler, der nur darauf wartet, einzutreten.

Selbst mit einer Verwerfung ist rohes Fire-and-Forget in einer Web-Anwendung fragil: Die Anfrage kann abgeschlossen werden und der Host kann herunterfahren, während Ihre Task noch mitten in der Arbeit ist, was sie abbricht oder beendet. Für alles, was wirklich fertig werden muss, machen Sie überhaupt kein Fire-and-Forget aus einer Anfrage heraus; übergeben Sie die Arbeit an eine Hintergrundwarteschlange. Dieses Muster wird behandelt in [wie man Fire-and-Forget-Arbeit sicher in ASP.NET Core mit BackgroundService ausführt](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/).

## Fallstricke und Varianten

Einige Situationen erzeugen `CS4014` oder verbergen es aus Gründen, die die Meldung nicht ausbuchstabiert:

- **Keine Warnung außerhalb einer `async`-Methode.** Genau derselbe nicht erwartete Aufruf in einer gewöhnlichen (nicht-`async`) Methode erzeugt kein `CS4014`. Der Compiler nimmt an, dass eine nicht-async-Methode legitim Hintergrundarbeit starten könnte. Deshalb schleichen sich Fehler ein, wenn jemand ein `await` und den umschließenden `async`-Modifikator zur gleichen Zeit entfernt: Die Warnung, die es gefangen hätte, verschwindet mit dem Modifikator. Wenn Sie sich auf die Warnung als Sicherheitsnetz verlassen, halten Sie `<WarningsAsErrors>CS4014</WarningsAsErrors>` aktiv und seien Sie misstrauisch gegenüber jedem bloßen Task-zurückgebenden Aufruf.

- **Die Verwerfung bringt die Warnung zum Schweigen, aber nicht den Fehler.** `_ = DoAsync();` beseitigt `CS4014`, aber wenn `DoAsync` auslöst und nichts darin es fängt, geht die Ausnahme trotzdem verloren. Die Verwerfung ist eine Absichtserklärung, keine Behebung für unbeobachtete Ausnahmen. Kombinieren Sie Fire-and-Forget stets mit internem `try`/`catch`.

- **Blockieren mit `.Result` oder `.Wait()` ist nicht die Behebung.** Das fehlende `await` durch `SaveAsync(order).Result` zu ersetzen, lässt die Warnung verschwinden und blockiert, bis die Task fertig ist, aber auf einem UI- oder klassischen ASP.NET-Synchronisationskontext führt es zu einem Deadlock, und überall sonst verschwendet es einen Thread. Wenn Sie versucht sind zu blockieren, weil Sie den Aufrufer nicht `async` machen können, lesen Sie zuerst [den Deadlock, den Sie beim Aufruf von .Result oder .Wait() auf einer async-Methode erhalten](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

- **`Task.Run(() => FooAsync())` verschluckt die innere Task.** Eine `async`-Lambda an `Task.Run` zu übergeben, bei der der Delegat `void` zurückgibt (eine `async void`-Lambda), gibt Ihnen eine `Task`, die abgeschlossen wird, wenn die Lambda ihr erstes await *beginnt*, nicht wenn die innere Arbeit fertig ist. Bevorzugen Sie `Task.Run(FooAsync)` oder `Task.Run(async () => await FooAsync())`, damit die zurückgegebene Task die echte Arbeit verfolgt, und erwarten Sie dann diese Task mit `await`.

- **Ein `CancellationToken`, das Sie nie durchreichen.** Eine häufige Ursache für eine anhaltende Fire-and-Forget-Task ist, dass die Methode keine Möglichkeit hat, abgebrochen zu werden, sodass sie weiterläuft, nachdem der Aufrufer weitergezogen ist. Wenn Ihr nicht erwarteter Aufruf Hintergrundarbeit ist, reichen Sie ein Token hinein, damit sie sauber gestoppt werden kann; siehe [wie man ein CancellationToken durch async-Methoden propagiert](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

- **Analyzer-Überschneidung mit CA2012 und VSTHRD110.** Über das `CS4014` des Compilers hinaus kennzeichnen die .NET-Analyzer (`CA2012` für `ValueTask`) und die Visual-Studio-Threading-Analyzer (`VSTHRD110`, "observe the awaitable result") dieselbe Fehlerklasse an mehr Stellen, einschließlich einiger nicht-`async`-Methoden, wo `CS4014` schweigt. Wenn Sie die Prüfung auf nicht erwartete Tasks überall wollen, nicht nur innerhalb von `async`-Methoden, schließt das Aktivieren dieser Analyzer die Lücke, die die Compiler-Warnung lässt.

Das mentale Modell, das Sie behalten sollten: `CS4014` ist der Compiler, der Ihnen sagt, dass eine Task gleich unbeobachtet laufen wird. Entscheiden Sie, was tatsächlich zutrifft, und handeln Sie dann danach. Sie wollten warten (fügen Sie `await` hinzu), Sie wollten mehrere Dinge nebenläufig laufen lassen (`Task.WhenAll`), die Methode ist eine Durchreiche (geben Sie die Task zurück), oder Sie wollen wirklich Fire-and-Forget (verwerfen mit `_ =` und behandeln die Ausnahmen darin). Die Warnung mit einer Verwerfung zu unterdrücken, während Sie die Ausnahmen unbehandelt lassen, verwandelt lediglich einen Hinweis zur Kompilierzeit in einen stillen Laufzeitfehler, was genau der Fehler ist, den die Warnung verhindern soll.

## Verwandt

- [async void vs async Task in C#: wann welches korrekt ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) dafür, warum die `void`-zurückgebende Version dieses Aufrufs noch gefährlicher ist und keine Warnung erzeugt.
- [Fix: Deadlock beim Aufruf von .Result oder .Wait() auf einer async-Methode in C#](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) dafür, warum Blockieren keine gültige Methode ist, um CS4014 zum Schweigen zu bringen.
- [Wie man Fire-and-Forget-Arbeit sicher in ASP.NET Core mit BackgroundService ausführt](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) für die richtige Art, Arbeit zu starten, die eine Anfrage überleben muss.
- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/de/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/), um zu wählen, wie man viele asynchrone Operationen nebenläufig ausführt.
- [Wie man ein CancellationToken durch async-Methoden in .NET 11 propagiert](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/), um Hintergrundarbeit abbrechbar zu machen, statt sie verwaisen zu lassen.

## Quellen

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs4014) (exakter `CS4014`-Text und die Anleitung, mit await zu erwarten oder explizit mit `_ =` zu verwerfen).
- Microsoft Learn, [Asynchronous programming with async and await](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/) (wie eine Task-zurückgebende async-Methode läuft und wo Ausnahmen erfasst werden).
- Microsoft Learn, [Task.WhenAll method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (Abschluss, wenn alle erwarteten Tasks fertig sind, und erneutes Werfen aggregierter Fehlschläge).
- Microsoft Learn, [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012) (der Analyzer, der die unbeobachteten Awaitables fängt, die die Compiler-Warnung durchlässt).
