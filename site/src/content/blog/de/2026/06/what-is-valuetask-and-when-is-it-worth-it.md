---
title: "Was ist ValueTask<T> und wann lohnt es sich?"
description: "ValueTask und ValueTask<T> sind Structs, mit denen eine asynchrone Methode ein Ergebnis zurückgeben kann, ohne bei synchronem Abschluss einen Task auf dem Heap zu allozieren. Der Gewinn ist eine Allokation weniger auf Hot Paths, die üblicherweise ohne Warten abschließen. Der Preis ist ein striktes Await-once-Kontrakt. Hier steht, was der Typ tatsächlich ist, wie er funktioniert und der enge Satz an Fällen, in denen er sich auszahlt."
pubDate: 2026-06-20
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
  - "dotnet-11"
lang: "de"
translationOf: "2026/06/what-is-valuetask-and-when-is-it-worth-it"
translatedBy: "claude"
translationDate: 2026-06-20
---

`ValueTask` und `ValueTask<T>` sind Awaitables als Werttyp (Struct), die eine asynchrone Methode anstelle von `Task` oder `Task<T>` zurückgeben kann. Ihr einziger Zweck ist es, die Heap-Allokation zu vermeiden, die `Task<T>` verursacht, wenn eine asynchrone Methode synchron abschließt -- der häufige Fall bei einem Cache-Treffer, einem gepufferten Lesevorgang oder einer memoisierten Berechnung. Wenn die Methode abschließt, ohne jemals zu warten, trägt ein `ValueTask<T>` das Ergebnis inline auf dem Stack und alloziert nichts; nur wenn sie auf echte asynchrone Arbeit warten muss, fällt sie darauf zurück, einen `Task` zu umhüllen. Der Haken ist, dass diese Einsparung mit einem Kontrakt einhergeht: Sie dürfen einen `ValueTask` genau einmal warten, und Sie dürfen ihn nicht blockierend abrufen, nicht zweimal warten und nicht in einem Feld ablegen, um ihn später zu warten. Wegen dieses Kontrakts ist der Standardrückgabetyp für eine asynchrone Methode weiterhin `Task` / `Task<T>`. `ValueTask` ist eine profilergetriebene Optimierung für einen Hot Path, nicht ein besserer `Task`.

Alles hier zielt auf .NET 11 (SDK `11.0.100`) und C# 14, aktuell im Juni 2026, aber der `ValueTask`-Kontrakt ist seit seiner Auslieferung in .NET Core 2.1 stabil, sodass die Mechanik für jede Version ab 2.1 gilt.

## Die Allokation, die ValueTask beseitigen soll

Beginnen Sie damit, was `Task<T>` kostet. Wenn Sie eine `async`-Methode schreiben, die `Task<T>` zurückgibt, baut der C#-Compiler eine Zustandsmaschine, und in dem Moment, in dem die Methode tatsächlich pausiert oder eine ausstehende Operation zurückgeben muss, alloziert sie ein `Task<T>`-Objekt auf dem Heap (24 Byte auf 64-Bit für den Objekt-Header plus Felder, vor jeglichem Fortsetzungszustand). Die Laufzeit cached eine Handvoll häufiger Ergebnisse: `Task.FromResult(true)`, `Task.FromResult(false)` und kleine geboxte Integer verwenden Singleton-Tasks wieder. Aber für einen beliebigen Referenztyp wie Ihren `User` ist jeder Aufruf, der einen `Task<User>` zurückgibt, eine frische Allokation -- selbst wenn die Methode die Antwort in einem Dictionary bereitliegen hatte und nie auf etwas gewartet hat.

Für eine Methode, die einige Tausend Mal pro Sekunde aufgerufen wird, ist diese Allokation unsichtbar. Für eine auf einem wirklich heißen Pfad, der fast immer synchron abschließt, werden diese `Task<T>`-Objekte zu Druck auf den Garbage Collector, der sich als Gen-0-Churn in einem Profiler zeigt. `ValueTask<T>` wurde genau für diese Form entworfen: eine Methode, die *üblicherweise* einen Wert zurückgibt, den sie bereits hat, und nur *gelegentlich* asynchron werden muss.

Hier ist das kanonische Motivationsbeispiel, ein Cache mit einem langsamen Fallback:

```csharp
// .NET 11, C# 14
// Returns Task<User>: allocates a Task<User> even on the cache-hit fast path.
public Task<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return Task.FromResult(user);   // heap allocation on every cache hit

    return LoadFromDbAsync(id);          // genuinely async, allocates anyway
}
```

Die Zeile `Task.FromResult(user)` alloziert bei jedem Cache-Treffer einen `Task<User>`. Wenn Ihre Trefferquote 99 Prozent beträgt und die Methode millionenfach läuft, allozieren Sie Millionen kurzlebiger Task-Objekte, um einen Wert zu umhüllen, den Sie bereits auf dem Stack hatten.

## Was ValueTask<T> tatsächlich ist

`ValueTask<T>` ist ein `readonly struct`, das intern eines von drei Dingen hält: ein direktes `TResult`, einen `Task<TResult>` oder eine `IValueTaskSource<TResult>` (mehr dazu weiter unten). Wenn die Methode synchron abschließt, trägt das Struct das Ergebnis direkt und es wird nie ein `Task` erzeugt. Wenn die Methode auf echte Arbeit warten muss, umhüllt das Struct den `Task<T>`, den die asynchrone Maschinerie erzeugt hat. Dasselbe Beispiel, umgeschrieben:

```csharp
// .NET 11, C# 14
// Returns ValueTask<User>: zero allocation on the cache-hit fast path.
public ValueTask<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return new ValueTask<User>(user);     // no allocation, result is inline

    return new ValueTask<User>(LoadFromDbAsync(id)); // wraps the real Task
}
```

Beim Cache-Treffer konstruiert `new ValueTask<User>(user)` ein Struct auf dem Stack mit dem User darin. Nichts erreicht den Heap. Beim Fehlschlag umhüllt es den `Task<User>` von `LoadFromDbAsync`, sodass der asynchrone Pfad genau das kostet, was er vorher kostete. Sie können auch das Schlüsselwort `async` direkt verwenden, und der Compiler übernimmt das Umhüllen für Sie:

```csharp
// .NET 11, C# 14
// The async keyword builds a state machine that returns a ValueTask<User>.
// Synchronous completion still avoids the Task<User> allocation via a pooled
// state machine box when possible.
public async ValueTask<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return user;                     // completes synchronously

    return await LoadFromDbAsync(id);    // suspends, goes async
}
```

Der nicht-generische `ValueTask` existiert aus demselben Grund für Methoden, die keinen Wert zurückgeben (`async ValueTask DoWorkAsync()`), und er vermeidet die Allokation des quasi-Singleton abgeschlossenen `Task` in den Fällen, in denen selbst das von Bedeutung ist.

## Der Kontrakt: einmal warten, nie blockieren, nie speichern

Alles, was `ValueTask` günstiger macht, macht ihn auch gefährlicher, und die Gefahr liegt vollständig darin, wie der *Aufrufer* ihn konsumiert. Ein `Task<T>` ist ein dauerhaftes Objekt, das Sie so oft warten können, wie Sie wollen, von so vielen Threads, wie Sie wollen, in einem Feld speichern und mit `.Result` blockierend abrufen können. Ein `ValueTask<T>` garantiert nichts davon. Aus der [offiziellen Dokumentation zu ValueTask&lt;TResult&gt;](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1) lauten die Regeln:

- **Warten Sie ihn höchstens einmal.** Ein `ValueTask<T>` kann eine gepoolte `IValueTaskSource<T>` umhüllen, die nach dem ersten Warten recycelt wird. Zweimaliges Warten kann ein Ergebnis beobachten, das nun zu einer anderen Operation gehört.
- **Warten Sie ihn nicht nebenläufig.** Zwei Threads, die denselben `ValueTask<T>` warten, sind aus demselben Grund undefiniertes Verhalten.
- **Greifen Sie nicht auf `.Result` zu, bevor er abgeschlossen ist.** Bei `Task<T>` ist das blockierende Abrufen von `.Result` lediglich ein Deadlock-Risiko; bei `ValueTask<T>` ist es undefiniertes Verhalten, sofern nicht bereits bekannt ist, dass der Value Task abgeschlossen ist.
- **Speichern Sie ihn nicht, um ihn später zu warten.** Einen `ValueTask<T>` einem Feld zuzuweisen und ihn zu warten, nachdem anderer Code gelaufen ist, ist die häufigste Art, mit der Teams Ergebnisse unter Last korrumpieren.

Wenn Sie eines dieser Dinge tun müssen, rufen Sie einmal `.AsTask()` auf, um einen echten `Task<T>` zu materialisieren, und verwenden Sie dann diesen:

```csharp
// .NET 11, C# 14
// Need to await twice or fan out? Convert exactly once, then treat as a Task.
ValueTask<User> vt = repo.GetUserAsync(id);
Task<User> task = vt.AsTask();   // materialize the Task once
var a = await task;
var b = await task;              // safe: Task<T> is awaitable repeatedly
```

Dieser `.AsTask()`-Aufruf alloziert genau den `Task<T>`, den Sie zu vermeiden versuchten -- was der Punkt ist: Wenn Ihre Aufrufstelle `Task`-Semantik benötigt, hätten Sie die Einsparung nie bekommen, und der `ValueTask` war reines Risiko. Dieselbe Reibung tritt bei Kombinatoren auf. `Task.WhenAll` und `Task.WhenAny` nehmen `Task`, sodass eine `ValueTask`-zurückgebende API jeden Aufrufer, der auffächert, zwingt, zuerst `.AsTask()` zu schreiben, pro Element zu allozieren und den Vorteil zunichtezumachen.

## Der Analyzer, der die Verstöße fängt

Sie müssen den Kontrakt nicht mit bloßem Auge überwachen. Das .NET SDK liefert **CA2012 ("Use ValueTasks correctly")**, das Doppel-Awaits, gespeicherte Value Tasks und direkten `.Result`-Zugriff markiert. Es ist in .NET 10 und höher standardmäßig als Vorschlag aktiviert. Stufen Sie es zu einer Warnung hoch, damit der Build bei einem Missbrauch fehlschlägt:

```ini
# .editorconfig - .NET 11 SDK, CA2012 ships in the built-in analyzers
[*.cs]
dotnet_diagnostic.CA2012.severity = warning
```

Wenn Sie `ValueTask` irgendwo einsetzen, ist es nicht optional, CA2012 in eine Warnung zu verwandeln. Es ist die Leitplanke, die den Typ in einem Team sicher verwendbar macht, in dem nicht jeder Stephen Toubs Regeln gelesen hat. Eine Codebasis, die `ValueTask` zurückgibt, ohne CA2012 hochgestuft zu haben, ist nur ein unachtsames Doppel-Await von einem Heisenbug entfernt, der sich nur unter Nebenläufigkeit zeigt.

## IValueTaskSource<T>: das Pooling, das ihn wirklich auszahlt

Das dritte Ding, das ein `ValueTask<T>` umhüllen kann, ist eine `IValueTaskSource<T>`. Dies ist der fortgeschrittene Fall und derjenige, der den größten Gewinn liefert: Ein einzelnes Backing-Objekt, das `IValueTaskSource<T>` implementiert, kann über viele Operationen hinweg wiederverwendet werden, sodass selbst der asynchrone Pfad pro Aufruf nichts alloziert. Die Laufzeit verwendet dies intern für `Socket`, `NetworkStream` und die `System.IO.Pipelines`-Maschinerie, wo eine Verbindung Millionen von Lesevorgängen durchführt und Sie sich keinen `Task` pro Lesevorgang leisten können.

Sie schreiben selten von Hand eine. Wenn Sie es tun, ist `ManualResetValueTaskSourceCore<T>` der Helfer, der die schwierigen Teile implementiert (Fortsetzungsplanung, Token-Versionierung zur Durchsetzung von Await-once):

```csharp
// .NET 11, C# 14
// A reusable async signal: one backing source serves many awaits over its
// lifetime, allocation-free per operation. ManualResetValueTaskSourceCore
// handles version tokens so a stale await throws instead of silently aliasing.
public sealed class Signaller : IValueTaskSource<int>
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> WaitAsync() => new(this, _core.Version);

    public void Complete(int value) => _core.SetResult(value);

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> cont, object? state, short token,
        ValueTaskSourceOnCompletedFlags flags)
        => _core.OnCompleted(cont, state, token, flags);
}
```

Dies ist der einzige Kontext, in dem `ValueTask` `Task` auch auf dem *asynchronen* Pfad zuverlässig schlägt, nicht nur auf dem synchronen Fast Path. Wenn Sie keine Source wie diese poolen, alloziert der asynchrone Zweig Ihrer Methode ohnehin einen `Task`, und das Einzige, was `ValueTask` Ihnen erspart hat, war die Allokation bei synchronem Abschluss.

## Wann es sich konkret lohnt

Greifen Sie nur dann zu `ValueTask<T>`, wenn all dies zutrifft:

1. **Ein Profiler zeigt, dass die `Task<T>`-Allokation auf diesem Pfad echte Kosten verursacht.** Nicht "könnte", sondern eine Gen-0-Zeile in einem Memory Trace. `ValueTask` ist eine Optimierung, die Sie nach dem Messen anwenden, genauso wie Sie nicht ohne Grund zu `Span<T>` oder [Native AOT](/de/2026/06/what-is-native-aot-and-what-does-it-cost-you/) greifen würden.
2. **Synchroner Abschluss ist der häufige Fall.** Cache-Treffer, gepufferte Lesevorgänge, memoisierte Ergebnisse. Wenn die Methode üblicherweise auf echte I/O wartet, allozieren Sie bei den meisten Aufrufen ohnehin einen Backing-`Task` und gewinnen nichts.
3. **Die Aufrufstellen sind einfache Awaits.** Ein einzelnes `await` bei jedem Konsumenten, kein Auffächern, kein Cachen des Awaitable, kein Blockieren. In dem Moment, in dem ein Aufrufer `.AsTask()` benötigt, ist die Einsparung dahin.
4. **Sie haben CA2012 zu einer Warnung hochgestuft.** Damit ein zukünftiger Beitragender den Kontrakt nicht stillschweigend brechen kann.

Die Async-Streams-Maschinerie ist der eine Ort, an dem `ValueTask` standardmäßig korrekt ist statt durch Messung: `IAsyncEnumerator<T>.MoveNextAsync` gibt `ValueTask<bool>` zurück und `DisposeAsync` gibt `ValueTask` zurück, genau weil ein Enumerator eine Backing-Source über jede Iteration hinweg wiederverwendet. Wenn Sie überhaupt mit Streams arbeiten, zeigt [die Verwendung von IAsyncEnumerable<T> mit EF Core 11](/de/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) das Muster im Kontext, und Sie sollten diese Signaturen niemals auf `Task` "zurücksetzen".

## Wann Sie bei Task<T> bleiben sollten

Für die überwältigende Mehrheit asynchroner Methoden geben Sie `Task` / `Task<T>` zurück. Stephen Toubs kanonisches [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/) drückt es unverblümt aus: "the default choice is still `Task` / `Task<TResult>`." Konkrete Signale dafür, dass Sie aus Reflex statt aus Evidenz zu `ValueTask` greifen:

- Die Methode führt bei den meisten Aufrufen echte I/O durch. Sie allozieren ohnehin auf dem häufigen Pfad einen `Task`, sodass das Struct nichts einbringt und Vorsicht kostet.
- Aufrufer müssen zweimal warten, das Ergebnis cachen oder mit `Task.WhenAll` auffächern. Jedes `.AsTask()` führt die Allokation wieder ein und fügt eine Codezeile hinzu.
- Sie haben nie einen `BenchmarkDotNet`-`[MemoryDiagnoser]`-Durchlauf ausgeführt, um zu bestätigen, dass es eine zu entfernende Allokation gab. Wenn die Zahlen flach sind, ist der Typ reiner Overhead.
- Die Methode ist öffentliche API eines NuGet-Pakets. `ValueTask` später auf `Task` zurückzuändern, ist eine binär-brechende Änderung, also legen Sie sich ohne Daten nicht darauf fest.

Wenn Sie bereits `ValueTask` in einer Codebasis haben und die Daten es nicht rechtfertigen, ist die Umkehrung eine sichere, mechanische Änderung: [die Migration von ValueTask<T> zurück zu Task<T>](/de/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) geht die vollständige Checkliste durch, einschließlich dessen, was mit jeder handgeschriebenen `IValueTaskSource<T>` zu tun ist. Und welchen Typ Sie auch zurückgeben, die Regeln, den Thread-Pool nicht zu blockieren, sind dieselben: siehe [wie man einen langlaufenden Task ohne Deadlock abbricht](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) und die nach wie vor relevante Frage, ob [ConfigureAwait(false) in .NET 11 von Bedeutung ist](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## Die Entscheidung in einer Zeile

`ValueTask<T>` beseitigt eine `Task<T>`-Allokation auf dem Pfad mit synchronem Abschluss, zum Preis eines Await-once-Kontrakts, den Ihr gesamtes Team respektieren muss. Verwenden Sie ihn, wenn ein Profiler beweist, dass diese Allokation von Bedeutung ist und synchroner Abschluss der häufige Fall ist, stützen Sie sich auf `IValueTaskSource<T>`, wenn Sie eine Backing-Source poolen können, verwandeln Sie CA2012 in eine Warnung und behalten Sie ihn bei Async Streams, wo er per Design korrekt ist. Überall sonst geben Sie `Task<T>` zurück und investieren Sie Ihr Vorsichtsbudget in etwas, das tatsächlich eine Zahl bewegt.

## Quellen

- [ValueTask&lt;TResult&gt; Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)
- [Understanding the Whys, Whats, and Whens of ValueTask -- .NET Blog (Stephen Toub)](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)
- [CA2012: Use ValueTasks correctly -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012)
- [ManualResetValueTaskSourceCore&lt;TResult&gt; -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1)
- [ValueTask Restrictions -- Stephen Cleary](https://blog.stephencleary.com/2020/03/valuetask.html)
