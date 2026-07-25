---
title: "Von blockierenden .Result/.Wait()-Aufrufen zu durchgehend asynchronem Code in einer alten C#-Codebasis migrieren"
description: "Ein stufenweiser Leitfaden, um sync-over-async aus einer bestehenden .NET-Codebasis zu entfernen: mit Analyzern inventarisieren, ThreadPool-Starvation messen, eine Aufrufkette nach der anderen umstellen und den Zähler unter .NET 11 auf null bringen."
pubDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "de"
translationOf: "2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-25
---

Sync-over-async aus einer echten Codebasis zu entfernen ist kein Suchen und Ersetzen. Planen Sie ein bis drei Sprints für einen Dienst mit einigen hunderttausend Zeilen ein, und rechnen Sie damit, dass die Arbeit die Form einer Reihe vertikaler Schnitte annimmt statt eines einzigen großen PR. Was bricht, sind vor allem die Signaturen: Jede Methode, die nicht mehr blockiert, muss `Task` zurückgeben, und das pflanzt sich nach oben durch Interfaces, Konstruktoren, `Dispose`, `lock`-Blöcke und Ihre öffentliche API-Oberfläche fort. Die Arbeit lohnt sich, wenn Sie unter Last ThreadPool-Starvation oder harte Deadlocks auf einem UI-Thread sehen, und sie lässt sich aufschieben, wenn der blockierende Aufruf in einem Kommandozeilenwerkzeug steckt, das einmal läuft und beendet wird. Dieser Leitfaden zielt auf .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14); alle genannten Werkzeuge funktionieren ab .NET 6, wobei der Tracing-Schritt zur Laufzeit .NET 9 oder neuer voraussetzt.

## Warum die blockierenden Aufrufe verschwinden müssen

- **ThreadPool-Starvation verschwindet.** Jedes `.Result` auf einem Anfragepfad parkt einen Pool-Thread. Microsofts eigenes [Tutorial zu ThreadPool-Starvation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-threadpool-starvation) misst denselben Endpunkt bei 3,48 s durchschnittlicher Latenz unter 125 gleichzeitigen Verbindungen mit Blockieren und bei 532 ms, nachdem der Aufruf awaitet wird. Das ist keine Feinabstimmung, das ist eine andere Anwendung.
- **Harte Deadlocks werden unmöglich, nicht unwahrscheinlich.** Auf einem WPF-, WinForms- oder klassischen ASP.NET-Thread ist das Blockieren auf einem Task, dessen Fortsetzung genau diesen Thread braucht, ein Zirkelwarten. Der Mechanismus ist in [warum das Blockieren auf einer asynchronen Methode zum Deadlock führt](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) beschrieben; das Entfernen der Blockade entfernt die gesamte Fehlerklasse.
- **Der Speicherverbrauch sinkt mit der Thread-Zahl.** Ein Pool, der sich bei 130 Threads eingependelt hat, um das Blockieren auszugleichen, hält 130 Stacks. Der Wechsel auf asynchronen Code bringt die Zahl üblicherweise auf ein kleines Vielfaches der Kernzahl zurück.
- **Abbruch funktioniert wieder.** Ein blockierter Thread kann kein `CancellationToken` beobachten. Sobald die Kette asynchron ist, propagieren Timeouts und Client-Abbrüche tatsächlich.

## Was beim Wechsel auf asynchronen Code bricht

| Bereich                          | Änderung                                                                                                    | Schweregrad |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------- |
| Öffentliche API-Oberfläche       | `T Get()` wird zu `Task<T> GetAsync()`: Quell- und binärbrechend für nachgelagerte Consumer                     | hoch        |
| Fremde Interfaces                | Einer Interface-Methode von Dritten oder vom Framework lässt sich kein `Task`-Rückgabetyp geben                 | hoch        |
| Konstruktoren, Property-Getter   | Beide können nicht `async` sein; die Arbeit wandert in eine Factory-Methode oder einen verzögerten Initializer  | hoch        |
| `lock`-Anweisungen               | `await` innerhalb von `lock` ist Compilerfehler `CS1996`; erfordert `SemaphoreSlim`                            | mittel      |
| Ausnahmebehandlung               | `AggregateException` tritt nicht mehr auf, `catch (AggregateException)` greift also stillschweigend nicht mehr  | mittel      |
| `TransactionScope`               | Fließt nicht über ein `await`, sofern er nicht mit `TransactionScopeAsyncFlowOption.Enabled` erzeugt wird       | mittel      |
| `IDisposable`                    | Asynchrone Aufräumarbeit in `Dispose` benötigt `IAsyncDisposable` und `await using`                             | mittel      |
| Testsuite                        | Synchrone Testmethoden, die nun asynchronen Code aufrufen, werden zu `async Task`                              | niedrig     |

Die Zeilen mit hohem Schweregrad bestimmen Ihre Reihenfolge. Alles andere ist mechanisch.

## Checkliste vor dem Start

- Die Solution kompiliert sauber ab .NET 6. Nichts davon setzt .NET 11 voraus, aber der Tracing-Schritt zur Laufzeit braucht .NET 9+ für das `WaitHandleWait`-Ereignis.
- `Microsoft.VisualStudio.Threading.Analyzers` in jedem Projekt, mindestens aber in den Projekten auf dem heißen Pfad. Dieses Paket findet blockierende Aufrufe in synchronen Methoden, was die eingebauten .NET-Analyzer nicht tun.
- `dotnet-counters`, `dotnet-trace` und `dotnet-stack` als globale Werkzeuge installiert.
- Ein Lasttest, der das Symptom reproduziert. Ohne ihn können Sie weder belegen, dass die Migration gewirkt hat, noch dass sie nichts verschlechtert hat.
- Eine Branch-Strategie, die viele kleine PRs zulässt. Ein PR über 400 Dateien, der jede Signatur der Solution ändert, wird nicht reviewt.

## Migrationsschritte

1. **Erstellen Sie die Inventur mit Analyzern, nicht mit grep.**

   `grep -r "\.Result"` findet Property-Zugriffe auf alles, was Result heißt, und übersieht synchrone E/A vollständig. Schalten Sie die beiden Regeln ein, die das Muster tatsächlich verstehen:

   ```ini
   # .editorconfig -- .NET 11 SDK 11.0.0
   [*.cs]
   # Avoid problematic synchronous waits (.Result, .Wait(), GetAwaiter().GetResult())
   dotnet_diagnostic.VSTHRD002.severity = warning
   # Call async methods when in an async method
   dotnet_diagnostic.VSTHRD103.severity = warning
   # Built-in equivalent; off by default through .NET 10
   dotnet_diagnostic.CA1849.severity = warning
   ```

   Der Unterschied ist in einer alten Codebasis entscheidend. [CA1849](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1849) greift nur innerhalb einer Methode, die `Task` zurückgibt, meldet also in Code, in dem noch nichts asynchron ist, praktisch nichts. `VSTHRD002` greift auf dem blockierenden Aufruf, wo immer er steht, und das ist genau die Menge, die Sie zählen wollen.

   **Prüfung**: Kompilieren Sie die Solution und zählen Sie die `VSTHRD002`-Zeilen in der Ausgabe. Notieren Sie die Zahl. Sie ist Ihr Burn-down-Diagramm.

2. **Erfassen Sie eine Baseline unter Last, bevor Sie eine Zeile ändern.**

   Führen Sie Ihren Lasttest aus und beobachten Sie den Pool:

   ```bash
   dotnet-counters monitor -n YourApp System.Runtime
   ```

   Ab .NET 9 sind die relevanten Zähler `dotnet.thread_pool.thread.count`, `dotnet.thread_pool.queue.length` und `dotnet.thread_pool.work_item.count`. Das Signal für Starvation ist eine langsam steigende Thread-Zahl bei deutlich unter 100% CPU-Auslastung. Eine Zahl, die sich oberhalb von etwa dem Dreifachen der Prozessorzahl einpendelt, bedeutet, dass der Code Pool-Threads blockiert und die Laufzeit das durch mehr Threads ausgleicht.

   **Prüfung**: Notieren Sie die eingependelte Thread-Zahl, die p95-Latenz und die Anfragen pro Sekunde. Damit vergleichen Sie im Verifikationsschritt.

3. **Finden Sie die blockierenden Aufrufe, die statische Analyse nicht sieht.**

   Analyzer können `File.ReadAllText`, `SqlCommand.ExecuteReader` oder ein `SemaphoreSlim.Wait()` tief in einer Abhängigkeit ohne Quellcode nicht melden. .NET 9 hat für genau diesen Zweck das `WaitHandleWait`-Ereignis ergänzt:

   ```bash
   dotnet trace collect -n YourApp --clrevents waithandle --clreventlevel verbose --duration 00:00:30
   ```

   Öffnen Sie die entstandene `.nettrace`-Datei in PerfView oder im .NET Events Viewer der Community und klappen Sie die `WaitHandleWaitStart`-Stacks auf. Jeder Stack, dessen unterste Frames `ThreadPoolWorkQueue.Dispatch` oder `WorkerThread.WorkerThreadStart` nennen, ist ein blockierter Pool-Thread, und der Frame über dem Wait benennt Ihre Methode.

   **Prüfung**: Jeder Stack im Trace entspricht entweder einer Aufrufstelle, die bereits in der Inventur aus Schritt 1 steht, oder wird ihr hinzugefügt.

4. **Stellen Sie eine Aufrufkette vollständig um, nicht eine Datei.**

   Wählen Sie den heißesten Einstiegspunkt aus Schritt 3. Beginnen Sie beim Blatt (der Methode, die tatsächlich `HttpClient` oder EF Core aufruft), geben Sie ihr einen asynchronen Zwilling und arbeiten Sie sich den Stack nach oben, indem Sie jeden Aufrufer umstellen, bis Sie eine Methode erreichen, die `await` verwenden kann, ohne selbst einen Aufrufer zu haben: eine Controller-Action, ein `BackgroundService.ExecuteAsync`, einen Event-Handler oder `Main`.

   ```csharp
   // .NET 11, C# 14 -- before: the block is three frames below the controller
   public IActionResult GetOrder(int id)
   {
       var order = _repository.Get(id);          // sync wrapper
       return Ok(order);
   }

   // after: no wrapper, no block, Task all the way to the framework
   public async Task<IActionResult> GetOrderAsync(int id, CancellationToken ct)
   {
       var order = await _repository.GetAsync(id, ct);
       return Ok(order);
   }
   ```

   Eine teilweise Umstellung ist auf diesem Pfad schlechter als gar keine. Ein einziges verbliebenes `.Result` irgendwo im synchronen Abschnitt bringt sowohl den Deadlock als auch den geparkten Thread zurück, ein Schnitt ist also erst fertig, wenn er einen Einstiegspunkt erreicht.

   **Prüfung**: Wiederholen Sie den Trace aus Schritt 3 nur für diesen Endpunkt. Null `WaitHandleWait`-Ereignisse auf Pool-Threads für diesen Stack.

5. **Löschen Sie den synchronen Zwilling, statt beide zu behalten.**

   Die verlockende Abkürzung ist, `Get()` als `GetAsync().GetAwaiter().GetResult()` stehen zu lassen, damit sich sonst nichts ändern muss. Genau gegen diesen synchronen Wrapper argumentiert Stephen Toub in [Should I expose synchronous wrappers for asynchronous methods?](https://devblogs.microsoft.com/dotnet/should-i-expose-synchronous-wrappers-for-asynchronous-methods/), und in einer Migration ist er aktiv schädlich: Im Wrapper verstecken sich Ihre restlichen blockierenden Aufrufe, und er erlaubt Aufrufern, sich der Arbeit dauerhaft zu entziehen.

   Wenn Sie tatsächlich einen synchronen und einen asynchronen Consumer haben und keinen davon aufgeben können, nutzen Sie statt eines Wrappers das Flag-Argument-Muster, das auch die BCL verwendet:

   ```csharp
   // .NET 11, C# 14 -- one implementation, two entry points, no sync-over-async
   public int Read(byte[] buffer) => ReadCoreAsync(buffer, sync: true).GetAwaiter().GetResult();
   public Task<int> ReadAsync(byte[] buffer) => ReadCoreAsync(buffer, sync: false);

   private async Task<int> ReadCoreAsync(byte[] buffer, bool sync)
   {
       // Every I/O call inside branches on `sync`, so the synchronous path
       // never awaits an incomplete task and cannot deadlock.
       return sync ? _stream.Read(buffer) : await _stream.ReadAsync(buffer);
   }
   ```

   **Prüfung**: Der synchrone Einstiegspunkt taucht in einem `WaitHandleWait`-Trace nicht mehr auf, weil er nie auf einen unvollständigen Task wartet.

6. **Behandeln Sie die Nahtstellen, die wirklich nicht asynchron werden können.**

   Drei davon kommen in jeder Migration vor. Ein Konstruktor kann nicht `async` sein, verschieben Sie die Initialisierung also in eine statische Factory (`public static async Task<Foo> CreateAsync()`) oder in ein `Lazy<Task<T>>`-Feld, auf das Aufrufer warten. Ein `Dispose`, das asynchron aufräumt, sollte `IAsyncDisposable` implementieren und mit [await using](/de/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) konsumiert werden. Ein `lock`-Block mit neuer asynchroner Arbeit kompiliert mit `CS1996` nicht, weil ein Monitor auf demselben Thread freigegeben werden muss, der ihn genommen hat:

   ```csharp
   // .NET 11, C# 14 -- lock cannot span an await; SemaphoreSlim can
   private readonly SemaphoreSlim _gate = new(1, 1);

   public async Task<Config> LoadAsync(CancellationToken ct)
   {
       await _gate.WaitAsync(ct);
       try { return _cached ??= await FetchAsync(ct); }
       finally { _gate.Release(); }
   }
   ```

   **Prüfung**: Das Projekt kompiliert ohne `CS1996` und ohne neue `async void` außerhalb von Event-Handlern.

7. **Reichen Sie das CancellationToken durch, solange die Signaturen ohnehin offen sind.**

   `CancellationToken ct = default` kostet nichts in einer Signatur, die Sie sowieso ändern, und lässt sich später nur mühsam nachrüsten. Geben Sie es an jeden asynchronen Aufruf der Kette weiter, nicht nur an den äußersten, gemäß den Regeln in [ein CancellationToken durch asynchrone Methoden weiterreichen](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/).

   **Prüfung**: Brechen Sie eine laufende Anfrage ab (trennen Sie die Client-Verbindung) und bestätigen Sie, dass der Datenbankaufruf tatsächlich abgebrochen wird, statt bis zum Ende zu laufen.

8. **Sichern Sie den Analyzer mit einer Ratsche, damit der Zähler nur sinken kann.**

   Sobald ein Projekt null erreicht, sperren Sie es:

   ```xml
   <!-- Directory.Build.props -- .NET 11 SDK 11.0.0 -->
   <PropertyGroup>
     <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
     <WarningsAsErrors>$(WarningsAsErrors);VSTHRD002;CA1849</WarningsAsErrors>
   </PropertyGroup>
   ```

   Für Projekte mitten in der Migration belassen Sie die Regeln auf `warning` und lassen CI bei einem Anstieg des Zählers scheitern statt bei jeder Warnung. Eine Ratsche, die neue Schulden blockiert, während die alten abgebaut werden, ist die einzige Variante davon, die Teams tatsächlich beibehalten.

   **Prüfung**: Fügen Sie in einem bereits umgestellten Projekt absichtlich ein `.Result` ein und bestätigen Sie, dass der Build fehlschlägt.

## Nachweisen, dass die Migration wirklich gewirkt hat

Kompilierende Signaturen sind kein Beleg. Führen Sie denselben Lasttest wie in Schritt 2 aus und vergleichen Sie vier Zahlen:

- **Die ThreadPool-Thread-Zahl** sollte sich nahe einem kleinen Vielfachen der Kernzahl einpendeln, statt in die Hunderte zu klettern.
- **Die p95-Latenz unter Last** sollte sich der Latenz einer Einzelanfrage annähern. Der Endpunkt aus dem Starvation-Tutorial ging von 3,48 s zurück auf etwa seine 500 ms ohne Last.
- **Der Durchsatz** sollte steigen, oft um eine Größenordnung, weil dieselben Threads nun viel mehr Anfragen bedienen.
- **`WaitHandleWait`-Ereignisse auf Pool-Threads** sollten auf umgestellten Pfaden nahe null liegen.

Danach folgen die funktionalen Prüfungen: `dotnet test` ohne Fehlschläge, ein Abbruchtest, der belegt, dass eine Client-Trennung den nachgelagerten Aufruf abbricht, und ein manueller Durchgang durch alle `catch (AggregateException)`-Blöcke im berührten Code, denn diese greifen nach dem Entfernen der blockierenden Aufrufe auf nichts mehr.

## Rollback

Schnitt für Schnitt lässt sich diese Migration sauber zurücknehmen: Jeder vertikale Schnitt ist ein in sich geschlossener PR, und ein Revert stellt den blockierenden Aufruf samt Signaturen wieder her. Das ist das Hauptargument dafür, nach Aufrufkette statt nach Schicht zu schneiden.

Was sich nicht sauber zurücknehmen lässt, ist eine veröffentlichte Bibliothek. `T Get()` in `Task<T> GetAsync()` zu ändern ist für jeden Consumer, der gegen die alte Assembly kompiliert hat, binärbrechend. Für ein NuGet-Paket ist das also eine Major-Version-Migration, und die Rücknahme muss ein neues Release sein, kein `git revert`. Entscheiden Sie vor dem Start, ob das Paket beide Oberflächen für eine Major-Version ausliefert (mit dem Flag-Argument-Muster aus Schritt 5, niemals mit einem synchronen Wrapper) oder ob es in einem Zug bricht.

## Fallstricke, die uns Zeit gekostet haben

**`async void` schleicht sich über Lambdas zurück.** Ein Lambda, das an einen Parameter vom Typ `Action` übergeben wird, wird zu `async void`, Ausnahmen darin reißen also den Prozess ab, statt auf einem Task aufzutauchen. `List<T>.ForEach(async x => ...)` und `Parallel.ForEach` mit asynchronem Rumpf sind die beiden üblichen Überträger. `VSTHRD101` erkennt den Delegate-Fall; die Grenze zwischen legitimer und fehlerhafter Verwendung steht in [wann async void korrekt ist und wann es eine Falle ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).

**`.Select(async x => ...)` liefert `IEnumerable<Task>`, keine Ergebnisse.** Es kompiliert, sieht umgestellt aus, und nichts awaitet es. Ergänzen Sie `await Task.WhenAll(...)` oder stellen Sie die Aufzählung auf [IAsyncEnumerable](/de/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) um.

**`TransactionScope` fließt stillschweigend nicht mehr.** Der Standardkonstruktor leitet die ambiente Transaktion nicht über ein `await` weiter, der Code nach dem ersten await läuft also ohne Fehlermeldung außerhalb der Transaktion. Erzeugen Sie ihn mit `TransactionScopeAsyncFlowOption.Enabled`.

**ASP.NET Core wirft Ausnahmen, bevor Sie fertig sind.** Das Umstellen der äußeren Schichten kann `InvalidOperationException: Synchronous operations are disallowed` aus einem weiter unten liegenden synchronen `Stream.Read` zutage fördern, weil `AllowSynchronousIO` standardmäßig false ist. Diese Ausnahme ist eine Landkarte der Restarbeit, kein Grund, den Schalter wieder umzulegen; die Details stehen in [synchronous operations are disallowed beheben](/de/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/).

**Auf einem `ValueTask` zu blockieren ist undefiniert, nicht nur langsam.** Gibt ein umgestelltes Blatt `ValueTask<T>` zurück und blockiert ein Aufrufer weiter oben noch, ist `.Result` darauf undefiniertes Verhalten und nicht bloß ein Deadlock-Risiko. Konvertieren Sie an dieser Grenze mit `.AsTask()`, bis der Aufrufer umgestellt ist, und lesen Sie die Einschränkungen in [was ValueTask kostet](/de/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

**Nutzen Sie `ConfigureAwait(false)` nicht als Ersatz dafür, die Arbeit zu Ende zu bringen.** Es entschärft den Deadlock innerhalb einer Bibliothek, die Ihnen gehört, ändert aber nichts am geparkten Thread, und in ASP.NET Core gibt es ohnehin keinen Kontext, aus dem man aussteigen könnte. Es ist eine Abmilderung für Code, den Sie nicht ändern können, keine Migrationsstrategie.

Das Maß für den Erfolg ist nicht, dass der Analyzer-Zähler auf null steht. Es ist, dass die Pool-Thread-Zahl unter Last nicht mehr klettert und eine abgebrochene Anfrage jetzt tatsächlich etwas abbricht.

## Verwandte Beiträge

- [Fix: Deadlock beim Aufruf von .Result oder .Wait() auf einer asynchronen Methode in C#](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#](/de/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)
- [Ein CancellationToken durch asynchrone Methoden in .NET 11 weiterreichen](/de/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [Wann async void korrekt ist und wann es eine Falle ist in C#](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#](/de/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)

## Quellen

- [Debug ThreadPool starvation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-threadpool-starvation) -- Microsoft Learn
- [CA1849: Call async methods when in an async method](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1849) -- Microsoft Learn
- [VSTHRD002: Avoid problematic synchronous waits](https://microsoft.github.io/vs-threading/analyzers/VSTHRD002.html) -- Microsoft.VisualStudio.Threading
- [Should I expose synchronous wrappers for asynchronous methods?](https://devblogs.microsoft.com/dotnet/should-i-expose-synchronous-wrappers-for-asynchronous-methods/) -- Stephen Toub
- [CS1996: Cannot await in the body of a lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs1996) -- Microsoft Learn
- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
