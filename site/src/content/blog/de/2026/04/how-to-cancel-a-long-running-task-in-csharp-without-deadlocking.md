---
title: "Wie man eine lang laufende Task in C# ohne Deadlock abbricht"
description: "Kooperativer Abbruch mit CancellationToken, CancelAsync, Task.WaitAsync und verknüpften Tokens in .NET 11. Plus die Blocking-Patterns, die einen sauberen Abbruch in einen Deadlock verwandeln."
pubDate: 2026-04-23
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "de"
translationOf: "2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking"
translatedBy: "claude"
translationDate: 2026-04-24
---

Sie haben eine `Task`, die lange läuft, ein Nutzer klickt auf Abbrechen, und entweder hängt die App oder die Task läuft weiter, bis sie von alleine fertig ist. Beide Ergebnisse deuten auf dasselbe Missverständnis: In .NET ist der Abbruch kooperativ, und die Bausteine, die ihn funktionieren lassen, sind `CancellationTokenSource`, `CancellationToken` und Ihre Bereitschaft, den Token tatsächlich zu prüfen. Dieser Beitrag zeigt, wie man das in .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14) sauber aufsetzt, und wie man die Blocking-Patterns vermeidet, die einen sauberen Abbruch in einen `Wait`-für-immer Deadlock verwandeln. Jedes Beispiel kompiliert gegen .NET 11.

## Kooperativer Abbruch, das Mental Model in einem Absatz

.NET hat kein `Task.Kill()`. Die CLR wird keinen Thread mitten aus Ihrem Code herausreißen. Wenn Sie Arbeit abbrechen wollen, erzeugen Sie eine `CancellationTokenSource`, reichen deren `Token` an jede Funktion in der Aufrufkette weiter, und diese Funktionen prüfen entweder `token.IsCancellationRequested`, rufen `token.ThrowIfCancellationRequested()` auf, oder geben den Token an eine asynchrone API, die ihn respektiert. Wenn `cts.Cancel()` (oder `await cts.CancelAsync()`) feuert, kippt der Token und jede geprüfte Stelle reagiert. Nichts wird abgebrochen, was nicht darum gebeten wurde, zu prüfen.

Deshalb lässt sich `Task.Run(() => LongLoop())` ohne Token nicht abbrechen. Der Compiler injiziert keinen Abbruch für Sie.

## Das minimale korrekte Pattern

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();

Task work = DoWorkAsync(cts.Token);

// Later, from a Cancel button, a timeout, whatever:
await cts.CancelAsync();

try
{
    await work;
}
catch (OperationCanceledException)
{
    // Expected when cts triggers. Not an error.
}

static async Task DoWorkAsync(CancellationToken ct)
{
    for (int i = 0; i < 1_000_000; i++)
    {
        ct.ThrowIfCancellationRequested();
        await Task.Delay(10, ct); // async APIs should take the token
    }
}
```

Drei Regeln leisten hier die Arbeit:

1. Die `CancellationTokenSource` wird entsorgt (`using var`), damit ihr interner Timer und ihr Wait-Handle freigegeben werden.
2. Jede Ebene der Aufrufkette akzeptiert einen `CancellationToken` und prüft ihn oder reicht ihn weiter.
3. Der Aufrufer wartet die Task ab und fängt `OperationCanceledException`. Der Abbruch erscheint als Exception, damit Aufräumarbeiten in `finally`-Blöcken weiterhin laufen.

## CPU-bound Schleifen: ThrowIfCancellationRequested

Für CPU-bound Arbeit streuen Sie `ct.ThrowIfCancellationRequested()` in einer Frequenz ein, bei der die Responsivität akzeptabel ist, ohne die Prüfung zum heißen Pfad zu machen. Die Prüfung ist billig (`Volatile.Read` auf einem `int`), aber in einer engen inneren Schleife, die zig Millionen Elemente verarbeitet, taucht sie im Profile dennoch auf. Ein guter Default ist einmal pro äußerer Iteration der Schleife, die "eine Arbeitseinheit" macht.

```csharp
// .NET 11, C# 14
static long SumPrimes(int max, CancellationToken ct)
{
    long sum = 0;
    for (int n = 2; n <= max; n++)
    {
        if ((n & 0xFFFF) == 0) ct.ThrowIfCancellationRequested(); // every 65536 iterations
        if (IsPrime(n)) sum += n;
    }
    return sum;
}
```

Wenn die Arbeit in einem Hintergrund-Thread lebt, der mit `Task.Run` gestartet wurde, reichen Sie den Token auch an `Task.Run` selbst:

```csharp
var task = Task.Run(() => SumPrimes(10_000_000, cts.Token), cts.Token);
```

Den Token an `Task.Run` zu übergeben bedeutet, dass wenn der Token **vor** dem Start des Delegates abgebrochen wird, die Task direkt nach `Canceled` wechselt, ohne zu laufen. Ohne ihn läuft das Delegate durch, und nur die interne Prüfung würde es stoppen.

## I/O-bound Arbeit: geben Sie den Token an jede asynchrone API weiter

Jede moderne .NET I/O-API akzeptiert einen `CancellationToken`. `HttpClient.GetAsync`, `Stream.ReadAsync`, `DbCommand.ExecuteReaderAsync`, `SqlConnection.OpenAsync`, `File.ReadAllTextAsync`, `Channel.Reader.ReadAsync`. Wenn Sie den Token nicht weiterreichen, stoppt der Abbruch auf Ihrer Ebene und die darunterliegende I/O läuft weiter, bis das OS oder die Gegenseite aufgibt.

```csharp
// .NET 11, C# 14
static async Task<string> FetchWithTimeoutAsync(string url, TimeSpan timeout, CancellationToken outer)
{
    using var http = new HttpClient();
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(outer);
    linked.CancelAfter(timeout);

    using HttpResponseMessage resp = await http.GetAsync(url, linked.Token);
    resp.EnsureSuccessStatusCode();
    return await resp.Content.ReadAsStringAsync(linked.Token);
}
```

Zwei Dinge verdienen eine Erwähnung in diesem Snippet. `CreateLinkedTokenSource` kombiniert "der Aufrufer will abbrechen" mit "wir haben nach `timeout` aufgegeben" in einen einzigen Token. Und `CancelAfter` ist der richtige Weg, einen Timeout auszudrücken, nicht `Task.Delay`, das gegen die Arbeit wettläuft, weil es einen einzelnen Eintrag in der Timer-Queue statt einer vollständig allokierten `Task` nutzt.

## Die Deadlock-Fallen, in der Reihenfolge, wie oft ich sie sehe

### Falle 1: Auf eine async-Methode aus einem erfassenden Kontext blockieren

```csharp
// BAD on WinForms, WPF, or any SynchronizationContext that runs on one thread
string html = FetchAsync(url).Result;
```

`FetchAsync` macht intern `await`, was die Fortsetzung auf den erfassten `SynchronizationContext` zurückposted. Dieser Kontext ist der UI-Thread. Der UI-Thread ist auf `.Result` blockiert. Die Fortsetzung kann nicht laufen. Deadlock. Abbruch hilft hier nicht, weil die Task nie fertig werden wird.

Die Lösung ist nicht `ConfigureAwait(false)` in Ihrem Code. Die Lösung ist, gar nicht erst zu blockieren. Machen Sie den Aufrufer async:

```csharp
string html = await FetchAsync(url);
```

Wenn Sie absolut nicht awaiten können (zum Beispiel in einem Konstruktor), verwenden Sie `Task.Run`, um sich vom erfassten Kontext zu entfernen. Das ist eine Kapitulation, keine Lösung.

### Falle 2: ConfigureAwait(false) nur auf dem äußeren await

Ein Bibliotheks-Autor wickelt einen Aufruf in `ConfigureAwait(false)` ein, sieht den Deadlock im Unit-Test verschwinden und liefert aus. Dann wickelt ein Aufrufer das Ganze in `.Result` ein und der Deadlock kommt zurück, weil ein inneres `await` in einem Callee den Kontext eben doch erfasst hat.

`ConfigureAwait(false)` ist eine Einstellung pro `await`. Entweder verwendet jedes `await` in jeder Bibliotheksmethode es, oder keines. Die Welt der `Nullable`-Annotationen hat es leicht; diese hier nicht. Auf .NET 11 mit C# 14 können Sie den Analyzer `CA2007` einschalten, um `ConfigureAwait(false)` in Bibliotheken zu erzwingen, und `ConfigureAwaitOptions.SuppressThrowing` verwenden, wenn Sie eine Task rein für die Fertigstellung abwarten wollen, ohne sich um ihre Exception zu kümmern.

### Falle 3: CancellationTokenSource.Cancel() wird aus einem Callback aufgerufen, der auf demselben Token registriert ist

`CancellationTokenSource.Cancel()` führt registrierte Callbacks standardmäßig **synchron** auf dem aufrufenden Thread aus. Wenn einer dieser Callbacks `Cancel()` auf derselben Source aufruft oder auf einem Lock blockiert, den ein anderer Callback hält, bekommen Sie einen rekursiven oder reentranten Deadlock. Auf .NET 11 bevorzugen Sie `await cts.CancelAsync()`, wenn Sie irgendeinen Lock halten, wenn Sie auf einem `SynchronizationContext` sind, oder wenn Callbacks nicht trivial sind. `CancelAsync` dispatched Callbacks asynchron, sodass `Cancel` zuerst zu Ihnen zurückkehrt.

```csharp
// .NET 11, C# 14
lock (_state)
{
    _state.MarkStopping();
}
await _cts.CancelAsync(); // callbacks fire after we are out of the lock
```

### Falle 4: eine Task, die ihren Token ignoriert

Die häufigste Ursache für "Abbruch tut nichts" ist überhaupt kein Deadlock, sondern eine Task, die nie prüft. Beheben Sie es an der Quelle:

```csharp
static async Task BadAsync(CancellationToken ct)
{
    await Task.Delay(5000); // no token, so unaffected by cancel
}

static async Task GoodAsync(CancellationToken ct)
{
    await Task.Delay(5000, ct); // throws OperationCanceledException on cancel
}
```

Wenn Sie den Callee nicht ändern können (Drittanbieter-Code ohne Token-Parameter), bietet `Task.WaitAsync(CancellationToken)` ab .NET 6+ einen Ausweg: das Warten wird abbrechbar, auch wenn die zugrunde liegende Arbeit es nicht ist.

```csharp
// .NET 11, C# 14
Task<string> hardcoded = LegacyFetchThatIgnoresTokensAsync();
string result = await hardcoded.WaitAsync(ct); // returns immediately on cancel; the underlying work keeps running
```

Seien Sie ehrlich, was das bewirkt: es entsperrt Sie, es stoppt die Arbeit nicht. Auf .NET 11 läuft der darunterliegende `HttpClient`, das File-Handle oder was auch immer der Legacy-Code tut, weiter, bis er fertig ist, und sein Ergebnis wird verworfen. Für eine lang laufende Schleife, die exklusive Ressourcen hält, ist das ein Leck, kein Abbruch.

## Verknüpfte Tokens: Caller-Abbruch + Timeout + Shutdown

Ein realistischer Server-Endpunkt will aus drei Gründen abbrechen: der Aufrufer hat die Verbindung getrennt, der Per-Request-Timeout ist abgelaufen, oder der Host fährt herunter. `CreateLinkedTokenSource` komponiert sie.

```csharp
// .NET 11, C# 14 - ASP.NET Core 11 minimal API
app.MapGet("/report", async (HttpContext ctx, IHostApplicationLifetime life, CancellationToken requestCt) =>
{
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(requestCt, life.ApplicationStopping);
    linked.CancelAfter(TimeSpan.FromSeconds(30));

    string report = await BuildReportAsync(linked.Token);
    return Results.Text(report);
});
```

ASP.NET Core gibt Ihnen bereits `HttpContext.RequestAborted` (freigelegt als `CancellationToken`-Parameter, wenn Sie einen akzeptieren). Verknüpfen Sie ihn mit `IHostApplicationLifetime.ApplicationStopping`, damit ein graceful Shutdown auch in Bearbeitung befindliche Arbeit abbricht, und fügen Sie oben drauf einen Per-Endpoint-Timeout hinzu. Wenn einer der drei feuert, kippt `linked.Token`.

## OperationCanceledException vs TaskCanceledException

Beide existieren. `TaskCanceledException` erbt von `OperationCanceledException`. Fangen Sie `OperationCanceledException`, es sei denn, Sie müssen gezielt "die Task wurde abgebrochen" von "der Aufrufer hat eine andere Operation abgebrochen" unterscheiden. In der Praxis fangen Sie immer die Basisklasse.

Ein subtiler Punkt: wenn Sie eine abgebrochene Task awaiten, trägt die zurückgegebene Exception möglicherweise nicht den ursprünglichen Token. Wenn Sie wissen müssen, welcher Token gefeuert hat, prüfen Sie `ex.CancellationToken == ct`, statt zu inspizieren, welchen Token Sie an welche API übergeben haben.

## Entsorgen Sie Ihre CancellationTokenSource, besonders bei CancelAfter

`CancellationTokenSource.CancelAfter` plant Arbeit auf dem internen Timer ein. Das Vergessen, den CTS zu entsorgen, hält diesen Timer-Eintrag am Leben, bis der GC ihn erreicht, was auf einem ausgelasteten Server ein Speicher- und Timer-Leck ist, das nichts abstürzen lässt, aber als langsames Wachstum in `dotnet-counters` auftaucht. `using var cts = ...;` oder `using (var cts = ...) { ... }` jedes Mal.

Wenn Sie den CTS an einen Hintergrund-Eigentümer übergeben wollen, stellen Sie sicher, dass genau eine Stelle für die Entsorgung verantwortlich ist, und entsorgen Sie erst, wenn alle, die den Token halten, ihn freigegeben haben.

## Background Services: stoppingToken ist Ihr Freund

In einem `BackgroundService` bekommt `ExecuteAsync` einen `CancellationToken stoppingToken`, der kippt, wenn der Host mit dem Herunterfahren beginnt. Verwenden Sie ihn als Wurzel jeder Abbruchkette innerhalb des Services. Erzeugen Sie keine frischen CTS-Instanzen, die vom Shutdown getrennt sind, sonst wird ein graceful `Ctrl+C` in einen Timeout laufen und der Host bringt den Prozess auf die harte Tour herunter.

```csharp
// .NET 11, C# 14
public sealed class Crawler(IHttpClientFactory http, ILogger<Crawler> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var perItem = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                perItem.CancelAfter(TimeSpan.FromSeconds(10));

                await CrawlNextAsync(http.CreateClient(), perItem.Token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // host is stopping; exit cleanly
            }
            catch (OperationCanceledException)
            {
                log.LogWarning("Per-item timeout elapsed, continuing.");
            }
        }
    }
}
```

Das `catch` mit einem `when`-Filter unterscheidet "wir fahren herunter" von "wir hatten einen Timeout auf einer einzelnen Arbeitseinheit". Shutdown bricht die äußere Schleife ab. Ein Per-Item-Timeout loggt und macht weiter.

## Was ist mit Thread.Abort, Task.Dispose oder einem Hard-Kill?

`Thread.Abort` wird auf .NET Core nicht unterstützt und wirft `PlatformNotSupportedException` auf .NET 11. `Task.Dispose` existiert, ist aber nicht, was Sie denken, es gibt nur ein `WaitHandle` frei, es bricht die Task nicht ab. Es gibt absichtlich keine "kill this task"-API. Das nächstliegende Notventil ist, wirklich nicht-abbrechbare Arbeit in einem separaten Prozess auszuführen (`Process.Start` + `Process.Kill`) und mit dem Cross-Process-Overhead zu leben. Für alles andere ist kooperativer Abbruch die API.

## Alles zusammenbringen

Ein Abbruch-Button, der funktioniert, ist neun von zehn Mal das Ergebnis von drei kleinen Gewohnheiten: jede async-Methode nimmt einen `CancellationToken` und reicht ihn weiter, jede lange Schleife ruft `ThrowIfCancellationRequested` in vernünftiger Kadenz auf, und nichts irgendwo in der Aufrufkette blockiert auf `.Result` oder `.Wait()`. Fügen Sie `using` auf Ihrem CTS hinzu, `CancelAfter` für Timeouts, `await CancelAsync()` innerhalb von Locks, und `WaitAsync` als Notventil für Code, den Sie nicht ändern können.

## Verwandte Lektüre

- [Streaming von Datenbankzeilen mit IAsyncEnumerable](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/), das sich stark auf dieselbe Token-Installation stützt.
- [Sauberere async Stack-Traces in der .NET 11 Runtime](/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), nützlich, wenn eine `OperationCanceledException` tief in einer Pipeline auftaucht.
- [Wie man mehrere Werte aus einer Methode in C# 14 zurückgibt](/de/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) passt gut zu async-Methoden, die "Ergebnis oder Abbruchgrund" zurückgeben wollen.
- [Das Ende von `lock (object)` in .NET 9](/2026/01/net-9-the-end-of-lockobject/) für den breiteren Threading-Kontext, in dem Ihr Abbruch-Code läuft.

## Quellen

- [Task Cancellation](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/task-cancellation), MS Learn.
- [Cancellation in Managed Threads](https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads), MS Learn.
- [Coalesce cancellation tokens from timeouts](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/coalesce-cancellation-tokens-from-timeouts), MS Learn.
- [`CancellationTokenSource.CancelAsync`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelasync), API-Referenz.
- [`Task.WaitAsync(CancellationToken)`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync), API-Referenz.
