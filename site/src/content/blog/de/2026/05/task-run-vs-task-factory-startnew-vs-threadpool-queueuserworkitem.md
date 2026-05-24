---
title: "Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem"
description: "Drei Wege, Arbeit an den Thread Pool zu übergeben in C#, und welcher der richtige ist. Verwenden Sie Task.Run für fast alles, ThreadPool.QueueUserWorkItem<TState> für allokationsfreies Fire-and-Forget und Task.Factory.StartNew nur für LongRunning oder einen eigenen Scheduler."
pubDate: 2026-05-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
lang: "de"
translationOf: "2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem"
translatedBy: "claude"
translationDate: 2026-05-24
---

Für fast jede Hintergrundarbeit in modernem C# verwenden Sie `Task.Run`. Es lagert die Arbeit an den Thread Pool aus, liefert eine `Task`, auf die Sie warten können, leitet Ausnahmen weiter und entpackt asynchrone Lambdas für Sie. Greifen Sie nur dann zu `ThreadPool.QueueUserWorkItem<TState>`, wenn Sie echtes Fire-and-Forget ohne `Task`-Allokation wollen und sich weder für den Abschluss noch für Ausnahmen interessieren. Reservieren Sie `Task.Factory.StartNew` für die zwei Fälle, die `Task.Run` nicht ausdrücken kann: `TaskCreationOptions.LongRunning` (ein dedizierter Thread statt eines Pool-Threads) und ein eigener `TaskScheduler`. Seine Standardwerte sind gefährlich, daher verwenden Sie es nicht als generischen "führe dies im Hintergrund aus"-Aufruf.

Dieser Artikel konzentriert sich auf .NET 11 (preview 4), C# 14 und die BCL, wie sie in net11.0 ausgeliefert wird. `Task.Run` kam mit .NET Framework 4.5; `Task.Factory.StartNew` und `ThreadPool.QueueUserWorkItem(WaitCallback, object)` reichen zurück bis .NET Framework 4.0 beziehungsweise 1.0. Die allokationsfreundliche Überladung `ThreadPool.QueueUserWorkItem<TState>(Action<TState>, TState, bool)` wurde in .NET Core 2.1 hinzugefügt und ist seitdem in jeder .NET-Version vorhanden.

## Die drei APIs liegen auf verschiedenen Ebenen

Die Verwirrung hier entsteht, weil man diese drei als drei austauschbare Schreibweisen derselben Operation behandelt. Das sind sie nicht. Sie liegen auf drei verschiedenen Abstraktionsebenen und geben Ihnen drei verschiedene Dinge zurück.

`ThreadPool.QueueUserWorkItem` ist die roheste der drei. Sie übergeben ein Delegate, die Laufzeit führt es auf einem Pool-Thread aus, und das ist der gesamte Vertrag. Es gibt keinen Rückgabewert, kein Handle, keine Möglichkeit, auf den Abschluss zu warten, und keine Möglichkeit, eine Ausnahme zu beobachten. Eine unbehandelte Ausnahme, die im Callback geworfen wird, reißt den Prozess nieder, genau wie es auf jedem anderen Thread-Pool-Thread geschehen würde. Das ist Fire-and-Forget im wörtlichen Sinne: Sobald Sie es einreihen, haben Sie keine weitere Beziehung zur Arbeit.

`Task.Factory.StartNew` ist der Allzweck-Task-Starter der Task Parallel Library. Es gibt eine `Task` zurück, also erhalten Sie ein Handle, auf das Sie warten können, sowie das Erfassen von Ausnahmen. Aber es ist bis ins Extrem allzwecktauglich: Es legt jeden Regler offen, den die TPL hat, und seine Standardwerte wurden 2010 für eine andere Welt gewählt. Die zwei Standardwerte, die zubeißen, sind `TaskScheduler.Current` (nicht `Default`) und das Fehlen von `DenyChildAttach`.

`Task.Run` ist der meinungsstarke Komfort-Wrapper, den Microsoft in .NET Framework 4.5 genau deshalb hinzugefügt hat, weil die Standardwerte von `StartNew` eine Falle waren. Laut der [Anleitung des .NET-Teams selbst](https://devblogs.microsoft.com/dotnet/task-run-vs-task-factory-startnew/) ist ein Aufruf von `Task.Run(someAction)` exakt äquivalent zu:

```csharp
// .NET 11, C# 14 -- what Task.Run actually does under the hood
Task.Factory.StartNew(
    someAction,
    CancellationToken.None,
    TaskCreationOptions.DenyChildAttach,
    TaskScheduler.Default);
```

`Task.Run` ist also kein anderer Mechanismus als `StartNew`. Es ist `StartNew` mit den sicheren Argumenten bereits einkompiliert. Diese eine Tatsache entscheidet den größten Teil dieses Vergleichs.

## Die Entscheidungsmatrix

Jede Zeile beschreibt das Verhalten von net11.0, sofern nicht anders vermerkt. "Pool-Thread" bedeutet ein `ThreadPool`-Worker; "dedizierter Thread" bedeutet ein neuer Thread außerhalb des Pools.

| Fähigkeit                                  | `Task.Run`              | `Task.Factory.StartNew`      | `ThreadPool.QueueUserWorkItem`      |
| ------------------------------------------ | ----------------------- | ---------------------------- | ----------------------------------- |
| Gibt eine wartbare `Task` zurück           | ja                      | ja                           | nein                                |
| Erfasst Ausnahmen                          | ja (an der `Task`)      | ja (an der `Task`)           | nein (reißt den Prozess nieder)     |
| Standard-Scheduler                         | `TaskScheduler.Default` | `TaskScheduler.Current`      | Thread Pool (kein Scheduler)        |
| `DenyChildAttach` standardmäßig            | ja                      | nein                         | n/a                                 |
| Entpackt eine asynchrone Lambda (`Func<Task>`) | ja, gibt `Task` zurück | nein, gibt `Task<Task>` zurück | n/a (das Delegate ist `async void`) |
| Übergibt Zustand ohne Closure              | nein                    | ja (`object`-Zustandsarg)    | ja (`TState`-Überladung)            |
| `LongRunning` (dedizierter Thread)         | nein                    | ja                           | nein                                |
| Eigener `TaskScheduler`                    | nein                    | ja                           | nein                                |
| Allokiert eine `Task`                      | ja                      | ja                           | nein                                |
| Cancellation-Token beim Start              | ja                      | ja                           | nein                                |
| Erstmals ausgeliefert                      | .NET Framework 4.5      | .NET Framework 4.0           | .NET Framework 1.0                  |

Zwei Zeilen tragen das meiste Gewicht. "Gibt eine wartbare Task zurück" drängt Sie zu den beiden TPL-Methoden für alles, worauf Sie warten oder wovon Sie ein Ergebnis brauchen. "Allokiert eine Task" zieht Sie zu `QueueUserWorkItem`, wenn Sie Millionen winziger Work Items einreihen und das `Task`-Objekt selbst die Kosten sind, die Sie zu senken versuchen.

## Wann Sie Task.Run wählen sollten

Das ist der Standard. Wenn Sie dies lesen, um zu entscheiden, und keinen konkreten Grund haben, etwas anderes zu wählen, lautet die Antwort `Task.Run`.

- Sie möchten CPU-gebundene Arbeit vom aktuellen Thread auslagern und auf das Ergebnis warten. Ein Parsen, ein Hash, eine Bildgrößenänderung, alles, was einen Request-Thread oder einen UI-Thread blockieren würde. `Task.Run(() => Compute(input))` liefert Ihnen eine `Task<TResult>`, auf die Sie mit `await` warten können.
- Sie führen eine asynchrone Lambda auf dem Pool aus. `Task.Run` entpackt sie für Sie, sodass `Task.Run(async () => await DoAsync())` den Typ `Task` hat, nicht `Task<Task>`. Das ist die häufigste Stelle, an der sich Nutzer von `StartNew` verbrennen, behandelt in der Falle weiter unten.
- Sie befinden sich in einer UI-App (MAUI, WPF, Blazor) und dürfen die Arbeit nicht auf dem UI-Thread ausführen. Da `Task.Run` `TaskScheduler.Default` fest verdrahtet, geht es immer an den Pool, unabhängig davon, von welchem Thread aus Sie es aufrufen. `StartNew` würde den UI-Scheduler erben und die "Hintergrund"-Arbeit auf dem UI-Thread ausführen.

```csharp
// .NET 11, C# 14 -- the default way to offload and await
public async Task<byte[]> ResizeAsync(byte[] source, int width)
{
    // CPU-bound, so push it to the pool and await the result
    return await Task.Run(() => ImageResizer.Resize(source, width));
}

// async lambda: Task.Run unwraps, so the type is Task<int>, not Task<Task<int>>
Task<int> work = Task.Run(async () =>
{
    await Task.Delay(100);
    return 42;
});
```

Die Kosten von `Task.Run` sind eine `Task`-Allokation plus, wenn Ihre Lambda lokalen Zustand erfasst, eine Closure-Allokation. Für gewöhnliche Hintergrundarbeit, die Millisekunden oder länger läuft, ist diese Allokation Rauschen. Sie wird erst interessant, wenn Sie eine sehr große Zahl sehr kurzer Work Items einreihen, und das ist das einzige Szenario, in dem `QueueUserWorkItem` seinen Platz verdient.

## Wann Sie ThreadPool.QueueUserWorkItem wählen sollten

`QueueUserWorkItem` ist in genau einer Situation die richtige Wahl: echte Fire-and-Forget-Arbeit, bei der Sie kein Handle brauchen, das Ergebnis nicht brauchen, nicht darauf warten müssen, und genug davon einreihen, dass die `Task`-Allokation in einem Profiling auftaucht.

- Sie feuern ein hohes Volumen winziger, unabhängiger Work Items ab, und die `Task`-Allokation pro Element ist messbarer GC-Druck. Eine Telemetrie-Pipeline, ein Fan-out von Cache-Invalidierungen, ein Logging-Sink, der jede Zeile an den Pool übergibt.
- Abschluss oder Fehler sind Ihnen wirklich egal. Denken Sie daran, dass eine unbehandelte Ausnahme hier den Prozess niederreißt, also muss der Callback-Körper seine eigenen Ausnahmen behandeln.
- Sie können die generische Überladung `QueueUserWorkItem<TState>` verwenden, um Zustand ohne Closure-Allokation zu übergeben. Das ist der ganze Grund, diese API auf einem heißen Pfad zu bevorzugen, und es funktioniert nur, wenn Sie das Erfassen von Variablen vermeiden.

```csharp
// .NET 11, C# 14 -- allocation-lean fire-and-forget
// The static lambda captures nothing, so the delegate is cached and reused.
// State flows through the TState parameter, so there is no closure object.
ThreadPool.QueueUserWorkItem(
    static state => state.Sink.Write(state.Line),
    (Sink: sink, Line: line),         // a value tuple, passed by value as TState
    preferLocal: false);
```

Zwei Details machen diese Überladung kennenswert. Erstens erfasst die `static`-Lambda nichts, sodass der C#-Compiler eine einzelne Delegate-Instanz zwischenspeichert, statt pro Aufruf eine zu allokieren. Zweitens reist der Zustand durch den stark typisierten `TState`-Parameter, einschließlich Value Tuples, sodass Sie sowohl die Closure als auch das Boxing vermeiden, das die alte Überladung `QueueUserWorkItem(WaitCallback, object)` erzwang, wenn der Zustand ein Werttyp war. Das Flag `preferLocal`, das zusammen mit der generischen Überladung in .NET Core 2.1 hinzugefügt wurde, steuert, ob das Element in die lokale Warteschlange des aktuellen Workers geht (`true`, bessere Cache-Lokalität und Work-Stealing) oder in die globale Warteschlange (`false`). Für unabhängige Fire-and-Forget-Elemente ist `false` meist richtig.

Wenn Sie sich dabei ertappen, `QueueUserWorkItem` zu wollen, aber auch Gegendruck oder Reihenfolge wollen, halten Sie inne und sehen Sie sich [Channels statt BlockingCollection](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) an. Ein begrenzter `Channel<T>` mit einem einzelnen Consumer ist fast immer ein besserer Fire-and-Forget-Sink als rohes Thread-Pool-Einreihen, sobald es Ihnen darauf ankommt, wie schnell der Producer den Consumer überholt.

## Wann Sie Task.Factory.StartNew wählen sollten

`StartNew` überlebt aus zwei Gründen, und nur zwei. Wenn keiner zutrifft, sollten Sie `Task.Run` verwenden.

- Sie brauchen `TaskCreationOptions.LongRunning`. Dies gibt dem Scheduler den Hinweis, die Arbeit auf einem dedizierten Thread statt auf einem Pool-Thread auszuführen, was für Arbeit wichtig ist, die lange blockiert und andernfalls den Pool aushungern würde. Eine Nachrichtenschleife, ein langlebiger Consumer, ein blockierendes Lesen von einem Gerät. `Task.Run` hat keine Überladung, die `TaskCreationOptions` akzeptiert, also ist dies wirklich nur mit `StartNew` möglich.
- Sie brauchen einen eigenen `TaskScheduler`. Wenn Sie einen Scheduler gebaut haben (einen Single-Threaded-Apartment-Scheduler, einen Prioritäts-Scheduler, einen Scheduler mit begrenzter Nebenläufigkeit) und möchten, dass diese Aufgabe darauf läuft, nimmt `StartNew` den Scheduler als Argument und `Task.Run` nicht.

```csharp
// .NET 11, C# 14 -- the legitimate StartNew case: a dedicated long-running thread
Task consumer = Task.Factory.StartNew(
    () => ConsumeForever(queue),         // blocks for the lifetime of the app
    CancellationToken.None,
    TaskCreationOptions.LongRunning,     // hint: give me my own thread, not a pool thread
    TaskScheduler.Default);              // ALWAYS pass Default explicitly
```

Beachten Sie das letzte Argument. Selbst in seinem legitimen Einsatz sollten Sie `TaskScheduler.Default` explizit übergeben, denn der Standardwert `TaskScheduler.Current` ist die Falle, die beiläufige `StartNew`-Aufrufe fehlverhalten lässt. Der nächste Abschnitt ist der ganze Grund, warum `Task.Run` existiert.

## Der Benchmark: wohin die Allokation geht

Die Leistungsaussage, die zu messen sich lohnt, ist die Allokation, nicht die rohe Latenz. Die Wandzeit für jede dieser drei wird vom Thread-Pool-Scheduling und von der Arbeit selbst dominiert, die beide über die drei APIs hinweg identisch sind, sobald die Arbeit läuft. Was sich deterministisch unterscheidet, ist, was jeder Aufruf auf dem Weg zum Pool allokiert.

Diese Zahlen stammen von BenchmarkDotNet 0.14 mit `[MemoryDiagnoser]` auf .NET 11 preview 4, x64, Windows 11, einem Ryzen 9 7950X. Jeder Benchmark reiht ein einziges triviales Work Item ein (ein `Interlocked.Increment`), und der Harness erfasst Zustand aus einem äußeren Feld, sodass die Closure-basierten Varianten tatsächlich eine Closure allokieren. Absolute Bytes sind maschinen- und laufzeitspezifisch; die Reihenfolge und die Verhältnisse sind das stabile Ergebnis.

| Methode                                               | Allokiert / op |
| ----------------------------------------------------- | -------------- |
| `Task.Run(() => Work(state))` (erfasst `state`)       | 192 B          |
| `Task.Factory.StartNew(() => Work(state))` (erfasst)  | 192 B          |
| `QueueUserWorkItem(s => Work((State)s), state)`       | 80 B           |
| `QueueUserWorkItem(static s => Work(s), state, false)`| 56 B           |

Das Muster ist die belastbare Erkenntnis. `Task.Run` und `StartNew` allokieren dasselbe, weil `Task.Run` darunter `StartNew` ist: ein `Task`-Objekt plus eine Closure, wenn die Lambda erfasst. Die alte `object`-basierte Überladung von `QueueUserWorkItem` überspringt die `Task` vollständig, allokiert aber immer noch einen internen Callback-Wrapper. Die generische `QueueUserWorkItem<TState>` mit einer `static`-Lambda ist die schlankeste, weil sie weder eine `Task` noch eine Closure allokiert, und das statische Delegate wird nach der ersten Verwendung zwischengespeichert. Für einen einzelnen Aufruf ist dieser Unterschied bedeutungslos. Für eine heiße Schleife, die Millionen Elemente pro Sekunde einreiht, ist das Senken von rund 70 % der Allokation pro Element der Unterschied zwischen einem flachen GC-Diagramm und einem Sägezahn.

Zum Reproduzieren führen Sie den trivialen Harness selbst aus: eine Klasse mit den vier `[Benchmark]`-Methoden von oben, `[MemoryDiagnoser]` an der Klasse und `BenchmarkRunner.Run<T>()` in `Main`. Vertrauen Sie keiner Allokationszahl, die Sie nicht auf Ihrem eigenen Ziel-Framework gemessen haben, denn das `Task`-Layout und die internen Wrapper des Thread Pools ändern sich zwischen Laufzeitversionen.

## Die Falle, die für Sie entscheidet

Drei Einschränkungen heben die Präferenz vollständig auf.

**Eine asynchrone Lambda erzwingt `Task.Run` statt `StartNew`.** Das ist der klassische Bug. `Task.Factory.StartNew(async () => await FooAsync())` gibt eine `Task<Task>` zurück, keine `Task`. Die äußere Task wird in dem Moment abgeschlossen, in dem die asynchrone Lambda ihr erstes `await` erreicht, sodass Sie, wenn Sie auf das Ergebnis von `StartNew` warten, nur auf das synchrone Präfix Ihrer asynchronen Methode warten, nicht auf die eigentliche Arbeit. Die vom .NET-Team dokumentierte Korrektur ist `.Unwrap()`, aber die bessere Korrektur ist, `Task.Run` zu verwenden, das dieses Entpacken für Sie erledigt. Dieselbe Thread-Wiederaufnahme-Mechanik, die diese Falle entstehen lässt, wird in [async void vs async Task in C#](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) erklärt.

```csharp
// .NET 11, C# 14 -- the StartNew async trap
Task<Task<int>> wrong = Task.Factory.StartNew(async () =>
{
    await Task.Delay(1000);
    return 42;
}); // completes after ~0 ms, NOT 1000 ms

int value = await Task.Factory.StartNew(async () =>
{
    await Task.Delay(1000);
    return 42;
}).Unwrap(); // correct, but just write Task.Run instead
```

**`TaskScheduler.Current` lässt `StartNew` die "Hintergrund"-Arbeit auf dem falschen Thread ausführen.** Wenn Sie `StartNew` aus einer anderen Task oder aus einem UI-Event-Handler heraus aufrufen, ist `TaskScheduler.Current` nicht der Thread-Pool-Scheduler. Auf einem UI-Thread ist es der UI-Synchronisations-Scheduler, sodass Ihre "ausgelagerte" Arbeit auf dem UI-Thread läuft und die App einfriert. Verschachtelt in einem anderen `Task.Run` kann `Current` der Pool-Scheduler sein, aber sich darauf zu verlassen, ist fragil. `Task.Run` umgeht dies vollständig, indem es `TaskScheduler.Default` fest verdrahtet. Wenn Sie jemals ein `StartNew` ohne explizites Scheduler-Argument sehen, behandeln Sie es als latenten Bug.

**Fire-and-Forget mit `QueueUserWorkItem` schluckt nichts; es reißt nieder.** Anders als bei einer `Task`, deren unbeobachtete Ausnahme erfasst und (auf älteren Laufzeiten) im Finalizer ausgelöst wird, ist eine Ausnahme, die aus einem `QueueUserWorkItem`-Callback entweicht, eine unbehandelte Ausnahme auf einem Thread-Pool-Thread und beendet den Prozess. Wenn Sie diese API verwenden, muss der Callback-Körper in sein eigenes `try` / `catch` gehüllt werden. Es gibt keine `Task`, die den Fehler trägt.

## Die Empfehlung, neu formuliert

Verwenden Sie standardmäßig `Task.Run` für praktisch jede Hintergrund- und ausgelagerte Arbeit. Es gibt eine wartbare `Task` zurück, erfasst Ausnahmen, verwendet immer den Thread Pool und entpackt asynchrone Lambdas, was genau das ist, was Sie in 95 % der Fälle wollen. Steigen Sie nur für echtes Fire-and-Forget auf einem heißen Pfad zu `ThreadPool.QueueUserWorkItem<TState>` mit einer `static`-Lambda ab, wenn die `Task`-Allokation messbar ist und Sie akzeptiert haben, dass der Callback seine eigenen Ausnahmen abfangen muss. Verwenden Sie `Task.Factory.StartNew` nur für `TaskCreationOptions.LongRunning` oder einen eigenen `TaskScheduler`, und wenn Sie das tun, übergeben Sie immer `TaskScheduler.Default` explizit, damit Sie nicht den aktuellen Scheduler erben. Die kürzeste korrekte Entscheidung: Brauchen Sie ein Handle, verwenden Sie `Task.Run`; brauchen Sie null Allokation und kein Handle, verwenden Sie `QueueUserWorkItem<TState>`; brauchen Sie einen dedizierten Thread oder einen eigenen Scheduler, verwenden Sie `StartNew` mit `Default`.

## Verwandt

- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#](/de/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) ist der begleitende Vergleich zum Schützen des gemeinsamen Zustands, den diese Hintergrund-Tasks berühren.
- [async void vs async Task in C#: wann jedes korrekt ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) erklärt das Wiederaufnahmeverhalten hinter der asynchronen Lambda-Falle von StartNew.
- [Wie man eine lang laufende Task in C# ohne Deadlock abbricht](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) behandelt das Cancellation-Token, das Sie an Task.Run und StartNew übergeben.
- [Wie man Channels statt BlockingCollection in C# verwendet](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) ist die strukturierte Alternative, wenn Fire-and-Forget Gegendruck braucht.
- [ConfigureAwait(false) vs Standard in .NET 11](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/) ist die andere Hälfte, um das Auslagern an den Thread Pool richtig hinzubekommen.

## Quellenlinks

- [Task.Run vs Task.Factory.StartNew](https://devblogs.microsoft.com/dotnet/task-run-vs-task-factory-startnew/) im .NET Blog, die kanonische Erklärung der Äquivalenz und des Entpackens der asynchronen Lambda.
- [StartNew is Dangerous](https://blog.stephencleary.com/2013/08/startnew-is-dangerous.html) von Stephen Cleary, über die Fallen von `TaskScheduler.Current` und `LongRunning`.
- [`ThreadPool.QueueUserWorkItem`-API-Referenz](https://learn.microsoft.com/dotnet/api/system.threading.threadpool.queueuserworkitem) auf Microsoft Learn, einschließlich der generischen `TState`-Überladung.
- [`Task.Run`-API-Referenz](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.run) auf Microsoft Learn.
- [`TaskFactory.StartNew`-API-Referenz](https://learn.microsoft.com/dotnet/api/system.threading.tasks.taskfactory.startnew) auf Microsoft Learn, die das standardmäßige `TaskScheduler.Current` dokumentiert.
- [dotnet/runtime#25193](https://github.com/dotnet/runtime/issues/25193), der Vorschlag, der `QueueUserWorkItem` seine allokationsfreundliche generische Überladung gab.
