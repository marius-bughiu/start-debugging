---
title: "Lösung: CS1998 \"This async method lacks 'await' operators and will run synchronously\" in C#"
description: "CS1998 bedeutet, dass eine async-Methode kein await enthält und deshalb synchron läuft. Entfernen Sie async und geben Sie Task.FromResult zurück, oder ergänzen Sie das fehlende await."
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "async"
lang: "de"
translationOf: "2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously"
translatedBy: "claude"
translationDate: 2026-08-05
---

`CS1998` erscheint, wenn eine Methode den Modifizierer `async` trägt, ihr Rumpf aber keinen `await`-Ausdruck enthält. Die Methode läuft dann vollständig synchron, und Sie zahlen für die asynchrone Maschinerie, ohne Asynchronität zurückzubekommen. Die Lösung besteht fast immer darin, `async` zu entfernen und eine bereits abgeschlossene Task zurückzugeben: `Task.CompletedTask`, `Task.FromResult(value)` oder `ValueTask.FromResult(value)`. Sollte die Methode etwas erwarten, ergänzen Sie das fehlende `await`. Unterdrücken Sie die Warnung nicht mit `await Task.CompletedTask`, denn damit bleiben alle Kosten bestehen, die die Warnung bemängelt. Eines hat sich geändert, und die meisten Suchergebnisse haben das noch nicht nachgezogen: Ab dem .NET 10 SDK gibt der C#-Compiler `CS1998` überhaupt nicht mehr aus. Alles Folgende ist gegen SDK 10.0.201 (Roslyn 5.3.0) und .NET 10.0.5 verifiziert.

## Die Warnung im Kontext

```
warning CS1998: This async method lacks 'await' operators and will run synchronously. Consider using the 'await' operator to await non-blocking API calls, or 'await Task.Run(...)' to do CPU-bound work on a background thread.
```

Es handelt sich um eine Warnung, nicht um einen Fehler, der Build läuft also durch, sofern nicht `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` in der `.csproj` steht. Microsoft dokumentiert sie als `WRN_AsyncLacksAwaits` in der [Referenz der Compilermeldungen zu async und await](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors). Die offizielle Empfehlung lautet dort, mindestens einen `await`-Ausdruck in den Methodenrumpf aufzunehmen oder den Modifizierer `async` zu entfernen und die Task direkt zurückzugeben.

## Warum der Compiler das meldet

Eine `async`-Methode ohne `await` wird nie angehalten. Der Rumpf läuft von Anfang bis Ende auf dem aufrufenden Thread, genau wie bei einer synchronen Methode, und die vom Compiler erzeugte Zustandsmaschine übergibt dem Aufrufer anschließend eine Task, die bereits im Zustand `RanToCompletion` ist. Nichts wurde in den Hintergrund verlagert, nichts überlappte sich. Das Schlüsselwort `async` hat die Methode nicht asynchron gemacht, es hat nur verändert, wie Ergebnis und Ausnahmen der Methode verpackt werden.

Diese Verpackung ist nicht kostenlos. So viel kostet sie, gemessen auf .NET 10.0.5, x64, Release, mit einer schlichten `Stopwatch`-Schleife über zwei Millionen Aufrufe und `GC.GetAllocatedBytesForCurrentThread` für die Allokation. Das sind keine BenchmarkDotNet-Zahlen, betrachten Sie sie also als Größenordnungen und nicht als exakte Werte:

| Form | Bytes pro Aufruf | ns pro Aufruf |
| --- | --- | --- |
| `async Task` ohne `await` | 0 | 12,1 |
| `Task.CompletedTask` | 0 | 2,3 |
| `async Task<string>` ohne `await` | 72 | 27,9 |
| `Task.FromResult("ok")` | 72 | 16,0 |
| `async ValueTask<int>` ohne `await` | 0 | 15,6 |
| `ValueTask.FromResult(42)` | 0 | 3,0 |

Zwei Dinge fallen auf. Die Allokationsspalte ist in jedem Paar identisch, denn eine synchron abschließende async-Methode boxt ihre Zustandsmaschine nie (das Struct bleibt auf dem Stack, solange es keine Unterbrechung gibt), und der nicht generische `AsyncTaskMethodBuilder` liefert eine zwischengespeicherte abgeschlossene Task zurück. Die Folklore "async allokiert" trifft hier also nicht zu. Was Sie tatsächlich zahlen, sind rund 10 bis 15 Nanosekunden Builder-Infrastruktur pro Aufruf. In einer Methode, die eine Datenbank anspricht, ist das vernachlässigbar, in einer heißen Schleife dagegen relevant. Genau deshalb war das eine Warnung und kein Fehler.

## Minimales Beispiel

Der kleinste Code, der die Warnung auf jedem SDK bis einschließlich .NET 9 erzeugt:

```csharp
// C# 14, .NET SDK 9.0.x or earlier
public class UserService
{
    private readonly Dictionary<int, User> _cache = new();

    public async Task<User> GetUserAsync(int id)   // CS1998
    {
        return _cache[id];
    }
}
```

Die häufigste Form in echtem Code ist die, die einmal korrekt war und dann verfallen ist:

```csharp
// C# 14
public async Task<Report> BuildReportAsync(int id)
{
    // var rows = await _db.QueryAsync(id);   <- deleted during a refactor
    var rows = _cachedRows[id];
    return new Report(rows);                  // CS1998, and the method is now
}                                             // async for no reason at all
```

Die erste Variante schreibt niemand absichtlich. Die zweite taucht ständig auf, und das ist das gesamte Argument für die Warnung: Sie ist ein Verfallsdetektor, keine Stilregel.

## Lösung 1: async entfernen und eine abgeschlossene Task zurückgeben

Das ist in der überwiegenden Mehrheit der Fälle die richtige Lösung. Entfernen Sie den Modifizierer, behalten Sie die `Task`-Signatur und verpacken Sie den Wert:

```csharp
// C# 14, .NET 10
public Task<User> GetUserAsync(int id)
{
    return Task.FromResult(_cache[id]);
}

public Task SaveAsync(User user)
{
    _cache[user.Id] = user;
    return Task.CompletedTask;          // the Task equivalent of FromResult
}

public ValueTask<int> CountAsync()
{
    return ValueTask.FromResult(_cache.Count);   // no Task allocation at all
}
```

Die Signatur bleibt unverändert, kein Aufrufer muss angefasst werden, und die Zustandsmaschine verschwindet. Liegt die Methode auf einem heißen Pfad und ist ihr Ergebnis meist synchron verfügbar, entfällt mit `ValueTask<T>` zusätzlich die 72-Byte-Allokation von `Task<T>`; die Abwägungen stehen in [was ValueTask ist und wann es sich lohnt](/de/2026/06/what-is-valuetask-and-when-is-it-worth-it/).

Eine Verhaltensänderung müssen Sie berücksichtigen, und deshalb ist diese Lösung nicht rein mechanisch. In einer `async`-Methode wird eine im Rumpf geworfene Ausnahme aufgefangen und auf die zurückgegebene Task gelegt. Ohne `async` wird die Ausnahme synchron an der Aufrufstelle geworfen, bevor der Aufrufer überhaupt eine Task zum Erwarten erhält. Das lässt sich leicht zeigen:

```csharp
// C# 14, .NET 10.0.5
static async Task ThrowsFromTaskAsync() => throw new InvalidOperationException("boom");
static Task ThrowsAtCallSiteAsync() => throw new InvalidOperationException("boom");

var t1 = ThrowsFromTaskAsync();   // returns a faulted task, no exception here
await t1;                          // InvalidOperationException surfaces here

var t2 = ThrowsAtCallSiteAsync();  // throws right here, before any await
```

In den meisten Fällen ist dieser Unterschied unsichtbar, weil der Aufrufer sofort erwartet. Sichtbar wird er, sobald der Aufruf nicht sofort erwartet wird: beim Sammeln von Tasks in einer Liste für `Task.WhenAll`, beim Ablegen einer Task in einem Feld oder bei einem `try`/`catch`, das nur das `await` umschließt. Kann Ihre Methode eine Ausnahme werfen, bevor sie einen Wert liefert, behalten Sie die Ausnahme in der Task:

```csharp
// C# 14, .NET 10
public Task<Stream> OpenAsync(string path)
{
    try
    {
        return Task.FromResult<Stream>(new FileStream(path, FileMode.Open));
    }
    catch (Exception ex)
    {
        return Task.FromException<Stream>(ex);   // same shape as async would produce
    }
}
```

Genau dieses Szenario hat Stephen Toub in [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001) angeführt, um zu begründen, dass ein naives Umschreiben auf `Task.FromResult` oft falsch ist.

## Lösung 2: das fehlende await ergänzen

Ist die Warnung nach einem Refactoring aufgetaucht, besteht die ehrliche Lösung meist darin, den Aufruf wiederherzustellen, der erwartet werden sollte:

```csharp
// C# 14, .NET 10
public async Task<Report> BuildReportAsync(int id, CancellationToken ct)
{
    var rows = await _db.QueryAsync(id, ct);
    return new Report(rows);
}
```

Suchen Sie in derselben Datei nach einem benachbarten [CS4014 "because this call is not awaited"](/de/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/). Beide Warnungen zusammen, eine über fehlende awaits und eine über eine fallengelassene Task, sind ein nahezu sicheres Zeichen dafür, dass ein `await` verlorengegangen ist, und nicht dafür, dass die Methode nie asynchron war.

## Lösung 3: Task.Run, und warum der eigene Vorschlag der Meldung meist falsch ist

Der Warnungstext schlägt `await Task.Run(...)` für CPU-lastige Arbeit vor. Für einen Desktop-Client ist dieser Rat korrekt, dort geht es darum, den UI-Thread zu entlasten:

```csharp
// C# 14, .NET 10, WPF or MAUI
private async void OnCalculateClicked(object sender, EventArgs e)
{
    var result = await Task.Run(() => CrunchNumbers(_input));   // UI stays responsive
    ResultLabel.Text = result.ToString();
}
```

In ASP.NET Core ist derselbe Rat falsch. Es gibt keinen UI-Thread zu entlasten, und die Anfrage läuft bereits auf einem Threadpool-Thread; `Task.Run` reicht die Arbeit nur an einen anderen Threadpool-Thread weiter, fügt einen Kontextwechsel plus eine Task-Allokation hinzu und verkleinert gleichzeitig den Pool, der andere Anfragen bedienen soll. In einer Serveranwendung sollte eine synchrone Methode synchron bleiben oder durch Erwarten echter E/A tatsächlich asynchron werden.

## Lösung 4: Interface-Implementierungen und Overrides, die Sie nicht ändern können

Am schlechtesten kam die Warnung mit einem Interface-Member oder einer virtuellen Methode zurecht, die `Task` zurückgeben muss, obwohl Ihre konkrete Implementierung nichts zu erwarten hat:

```csharp
// C# 14, .NET 10
public interface INotifier
{
    Task NotifyAsync(string message);
}

public sealed class NullNotifier : INotifier
{
    public Task NotifyAsync(string message) => Task.CompletedTask;   // no async, no warning
}
```

`async` zu entfernen bleibt die Antwort. Wo das wirklich unmöglich ist, unterdrücken Sie eng begrenzt statt global:

```csharp
// C# 14, .NET SDK 9.0.x or earlier
#pragma warning disable CS1998 // required by INotifier, nothing to await here
public async Task NotifyAsync(string message) { _log.Info(message); }
#pragma warning restore CS1998
```

Bevorzugen Sie `#pragma` mit einem begründenden Kommentar gegenüber `<NoWarn>$(NoWarn);CS1998</NoWarn>` in der Projektdatei. Projektweite Unterdrückung verbirgt jedes künftige Vorkommen, einschließlich des Refactoring-Verfalls, den die Warnung wirklich gut erkennt.

## Wohin die Warnung in .NET 10 verschwunden ist

Wenn Sie das hier lesen, weil die Warnung verschwunden ist und nicht, weil sie aufgetaucht ist: Sie wurde aus dem Compiler entfernt. [dotnet/roslyn#80144](https://github.com/dotnet/roslyn/pull/80144), gemergt am 2025-09-19 für den Meilenstein 18.0 P2, hat `WRN_AsyncLacksAwaits` vollständig entfernt, zusammen mit den C#-Codefixes "Remove async modifier" und "Make method synchronous". Die Begründung aus [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001): Die Warnung drängte Entwickler zu schlechterem Code. Wer einen `Task`-Vertrag erfüllen musste, schrieb `await Task.FromResult(result)`, um sie loszuwerden. Das behält die Zustandsmaschine, fügt ein await hinzu und macht die Methode strikt teurer, ohne sie sicherer zu machen. Die abschließende Entscheidung im Thread war eindeutig: Nach der Diskussion und besonders im Hinblick auf Runtime Async werde diese Warnung vollständig entfernt.

Die Entfernung lässt sich mit einem einzigen Build überprüfen. Dieses Projekt kompiliert auf SDK 10.0.201 ohne Warnungen:

```csharp
// C# 14, .NET SDK 10.0.201 -> 0 warnings
public class C
{
    public async Task Empty() { }
    public async Task<int> Value() { return 42; }
    public async void VoidMethod() { }
    public async IAsyncEnumerable<int> Stream() { yield return 1; }
}
```

Keine dieser Methoden erzeugt eine Diagnose, und weder `-warnaserror:CS1998` noch `dotnet_diagnostic.CS1998.severity = error` in der `.editorconfig` bringen sie zurück, weil es keine Diagnose mehr gibt, die man hochstufen könnte. `CS4014` meldet derselbe Compiler weiterhin, das Ganze betrifft also gezielt `CS1998` und ist kein allgemeiner Verlust von async-Warnungen.

Die Funktion kam als optionale IDE-Analyzer zurück, in [dotnet/roslyn#81835](https://github.com/dotnet/roslyn/pull/81835), gemergt am 2026-01-07 für den Meilenstein 18.4, bewusst auf zwei Diagnose-IDs aufgeteilt, damit der Fall der Interface-Implementierung separat eingestellt werden kann:

- `IDE0390` (`RemoveUnnecessaryAsyncModifier`): normale Methoden und Lambdas.
- `IDE0391` (`RemoveUnnecessaryAsyncModifierInterfaceImplementationOrOverride`): Methoden, die ein Interface-Member implementieren oder eine Basismethode überschreiben.

Beide erscheinen als "Make method synchronous" mit der Meldung "Method can be made synchronous", und keine der beiden ist standardmäßig aktiv. So holen Sie das alte Verhalten dort zurück, wo Sie es wollen:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0390.severity = warning
dotnet_diagnostic.IDE0391.severity = suggestion
```

```xml
<!-- .csproj: required to see IDE rules in dotnet build, not just in the IDE -->
<PropertyGroup>
  <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
</PropertyGroup>
```

Ein Vorbehalt aus dem Test: Auf SDK 10.0.201 sind die beiden Analyzer noch nicht vorhanden. Die obige Konfiguration liefert nichts, während eine Kontrollregel wie `IDE0161` bei gleicher Konfiguration normal meldet. Die Infrastruktur funktioniert also, die Regeln sind in diesem SDK-Band schlicht noch nicht enthalten. Sie zielen auf den Meilenstein 18.4, es braucht daher ein neueres SDK oder ein Update von Visual Studio 2026.

## Fallstricke und Varianten

- **CI schlägt fehl, der lokale Build läuft durch.** Eine `global.json`, die auf dem Build-Agent SDK 9 festnagelt, gibt `CS1998` weiterhin aus, und mit `TreatWarningsAsErrors` ist das ein roter Build für Code, der auf einem Entwicklerrechner mit SDK 10 sauber kompiliert. Gleichen Sie das SDK-Band ab, bevor Sie nach Exotischerem suchen.

- **ReSharper und Rider melden sie weiterhin.** Die Analyse von JetBrains ist unabhängig von Roslyn, die Inspektion kann im Editor also bestehen bleiben, nachdem der Compiler sie nicht mehr ausgibt. Schalten Sie sie in den ReSharper-Inspektionseinstellungen ab, statt auf einen Compilerschalter zu hoffen.

- **`await Task.CompletedTask` ist der denkbar schlechteste Weg zum Verstummen.** Es beseitigt die Warnung durch ein echtes `await`, das heißt Sie behalten die Zustandsmaschine, behalten die Builder-Kosten und legen noch einen Awaiter-Umweg obendrauf. Das ist strikt teurer als der Code, der die Warnung ausgelöst hat. Dasselbe gilt für `await Task.FromResult(value)`.

- **`async void` ohne awaits.** `async` aus `async void SomeHandler()` zu entfernen ist ein reiner Gewinn: Wenn es nichts zu erwarten gibt, profitiert nichts von der Zustandsmaschine, und Sie werden das [Ausnahmeverhalten von async void](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) los, bei dem ein Fehler auf dem Synchronisationskontext erneut geworfen wird und den Prozess beenden kann.

- **Es hieß nie "diese Methode blockiert".** `CS1998` sagt, dass es kein `await` gibt, nicht dass der Rumpf blockiert. Eine Methode, die `.Result` oder `.Wait()` in einem `async`-Rumpf aufruft, bringt die Warnung nur dann zum Schweigen, wenn irgendein anderes `await` existiert, und ist ein weit schlimmeres Problem: siehe [der Deadlock beim Aufruf von .Result oder .Wait()](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/).

- **Asynchrone Iteratoren.** Eine `async IAsyncEnumerable<T>`-Methode mit `yield return` und ohne `await` ist weiterhin ein legitimer asynchroner Stream, und dort ist der Wegfall der Warnung eine Erleichterung. Wenn Sie einen solchen Stream konsumieren, beachten Sie: Ein `await foreach` über einen Stream, der nie wirklich wartet, bringt keine Nebenläufigkeit, nur eine Schnittstelle.

Das mentale Modell, das den Wegfall der Warnung überlebt: `async` ist eine Kompilierungsstrategie, kein API-Vertrag. Der Vertrag ist die `Task`-Signatur. Wenn es nichts zu erwarten gibt, behalten Sie den Vertrag und lassen die Strategie fallen, wobei alles, was werfen kann, die Task weiterhin fehlschlagen lassen soll, statt an der Aufrufstelle zu werfen. Das war die richtige Antwort, als `CS1998` Sie noch angeschrien hat, und es ist die richtige Antwort, jetzt wo sie verstummt ist.

## Verwandte Beiträge

- [Lösung: CS4014 "Because this call is not awaited, execution of the current method continues" in C#](/de/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) zur Warnung, die meist neben einem fehlenden `await` auftaucht.
- [async void vs async Task in C#: wann welches richtig ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) dazu, warum eine `async void`-Methode ohne awaits zuerst korrigiert gehört.
- [Was ist ValueTask und wann lohnt es sich?](/de/2026/06/what-is-valuetask-and-when-is-it-worth-it/) für den Fall der synchronen Fertigstellung, in dem `ValueTask.FromResult` gegenüber `Task.FromResult` gewinnt.
- [Lösung: Deadlock beim Aufruf von .Result oder .Wait() in einer async-Methode in C#](/de/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) zur wirklich gefährlichen Variante von "diese async-Methode ist gar nicht asynchron".
- [.NET 11 Runtime Async braucht das Flag EnablePreviewFeatures nicht mehr](/de/2026/07/dotnet-11-runtime-async-no-longer-needs-enablepreviewfeatures/) zur Änderung auf Laufzeitebene, die dem Compiler-Team den Wegfall dieser Warnung leichter machte.

## Quellen

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) (exakter `CS1998`-Text und die offizielle Empfehlung, await zu ergänzen oder async zu entfernen).
- dotnet/roslyn, [PR #80144: Remove CS1998 warning entirely and remove dependent C# code fix providers](https://github.com/dotnet/roslyn/pull/80144) (gemergt am 2025-09-19, Meilenstein 18.0 P2).
- dotnet/roslyn, [Issue #77001: Consider not emitting CS1998 for interface implementations / method overrides](https://github.com/dotnet/roslyn/issues/77001) (das Antimuster `await Task.FromResult` und die Entscheidung, die Warnung zu entfernen).
- dotnet/roslyn, [PR #81835: Add back async fixers](https://github.com/dotnet/roslyn/pull/81835) (die optionalen Analyzer `IDE0390` und `IDE0391`, gemergt am 2026-01-07, Meilenstein 18.4).
- dotnet/roslyn, [Issue #82692: Warnings (at least CS1998) are not showing with SDK 10 compared to SDK 9](https://github.com/dotnet/roslyn/issues/82692) (Bestätigung, dass die Verhaltensänderung mit dem SDK kommt und nicht mit dem Zielframework).
- Microsoft Learn, [Task.FromException method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.fromexception) (eine fehlgeschlagene Task ohne `async`-Methode erzeugen).
