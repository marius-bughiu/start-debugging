---
title: "Wie man ein CancellationToken durch async-Methoden in .NET 11 propagiert"
description: "Führen Sie ein CancellationToken sauber durch jede Schicht einer async-Aufrufkette in .NET 11: Konvention des letzten Parameters, Standardwerte, verknüpfte Tokens, RequestAborted von ASP.NET Core und der CA2016-Analyzer, der die vergessenen findet."
pubDate: 2026-07-01
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "de"
translationOf: "2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-07-01
---

Abbruch in .NET funktioniert nur, wenn das Token den Code erreicht, der die Blockierung ausführt. Ein `CancellationToken`, das Sie am Anfang einer Anfrage erstellen, aber nie an `HttpClient.GetAsync`, `DbContext.SaveChangesAsync` oder einen `Stream.ReadAsync`-Aufruf übergeben, ist totes Gewicht: Die äußere Operation läuft weiter bis zum Ende, weil weiter unten niemand zuhört. Das Token zu propagieren bedeutet, diesen einen Parameter durch jede async-Methode zwischen der Stelle, an der der Abbruch angefordert wird, und der Stelle, an der die Arbeit tatsächlich passiert, durchzureichen. Dieser Beitrag behandelt die mechanischen Regeln in .NET 11 (`Microsoft.NET.Sdk` 11.0.0, C# 14): wohin der Parameter gehört, was sein Standardwert sein sollte, wie man Tokens kombiniert, wie ASP.NET Core Ihnen eines gratis übergibt und wie der `CA2016`-Analyzer die Aufrufe findet, die Sie weiterzureichen vergessen haben. Alle Beispiele kompilieren gegen .NET 11.

## Warum ein Token, das nicht reist, nutzlos ist

Abbruch in .NET ist kooperativ. Es gibt kein `Task.Kill()`, und die Laufzeit unterbricht niemals von sich aus einen Thread. Ein `CancellationToken` ist nur ein Signal, das von "nicht angefordert" zu "angefordert" wechselt, wenn jemand `Cancel()` auf der besitzenden `CancellationTokenSource` aufruft. Der Code reagiert auf diesen Wechsel nur, wenn er entweder `token.IsCancellationRequested` prüft, `token.ThrowIfCancellationRequested()` aufruft oder das Token an eine Framework-API übergibt, die diese Prüfungen intern durchführt. Wenn das Token nie beim blockierenden Aufruf ankommt, kann der blockierende Aufruf nicht wissen, dass er stoppen sollte.

Das ist der ganze Grund, warum Propagierung wichtig ist. Betrachten Sie diese Kette:

```csharp
// .NET 11, C# 14 -- broken: the token stops at the top
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync();          // no token -- runs to completion
    var enriched = await EnrichAsync(rows);    // no token -- runs to completion
    return Assemble(enriched);
}
```

Sie können den ganzen Tag `Cancel()` aufrufen. `LoadRowsAsync` und `EnrichAsync` sehen das Signal nie, also beendet `BuildReportAsync` seine gesamte Arbeit, bevor das `catch (OperationCanceledException)` an der Aufrufstelle überhaupt die Chance hat, auszulösen. Die Lösung ist kein cleverer Code, sondern Disziplin: Das Token muss ein Parameter in jeder Methode auf dem Pfad sein, und jeder Aufruf muss es weiterreichen.

```csharp
// .NET 11, C# 14 -- correct: the token reaches the leaves
public async Task<Report> BuildReportAsync(CancellationToken ct)
{
    var rows = await LoadRowsAsync(ct);
    var enriched = await EnrichAsync(rows, ct);
    return Assemble(enriched);
}
```

## Das durchgängige Propagierungsverfahren

Dies ist die Abfolge, um ein Token von einem Einstiegspunkt bis zu einem E/A-Aufruf durchzureichen. Jeder Schritt ist eine Regel, die Sie mechanisch anwenden.

1. **Nehmen Sie das Token als letzten Parameter an.** Geben Sie jeder async-Methode in der Kette einen `CancellationToken`-Parameter und stellen Sie ihn ans Ende, damit er sich in Ihrem gesamten Code konsistent liest und den Signaturen des Frameworks selbst entspricht.
2. **Benennen Sie es konsistent.** Verwenden Sie `cancellationToken` in öffentlichen Bibliotheks-APIs (das ist die BCL-Konvention) oder `ct` im internen App-Code. Wählen Sie eines und bleiben Sie dabei, damit das Weiterreichen per grep auffindbar ist.
3. **Reichen Sie es an jeden erwarteten Aufruf weiter, der eines akzeptiert.** Wenn eine Methode, die Sie aufrufen, eine `CancellationToken`-Überladung oder einen -Parameter hat, übergeben Sie Ihr Token daran. Übergeben Sie nicht `CancellationToken.None` "zur Sicherheit": Das lässt den Aufruf stillschweigend auf Abbruch verzichten.
4. **Geben Sie ihm nur an echten Einstiegspunkten einen Standardwert.** Bibliotheksorientierte Methoden verwenden `CancellationToken cancellationToken = default`, damit Aufrufer, denen es egal ist, ihn weglassen können. Interne Methoden, die immer ein Token haben, sollten ihm keinen Standardwert geben, damit ein fehlendes Argument eine Erinnerung zur Kompilierzeit ist.
5. **Kombinieren Sie Tokens, wenn Sie Ihre eigene Frist hinzufügen.** Wenn eine Methode zusätzlich zum Token des Aufrufers ihr eigenes Zeitlimit benötigt, verknüpfen Sie sie mit `CancellationTokenSource.CreateLinkedTokenSource`, anstatt eines zu wählen und das andere fallen zu lassen.
6. **Schalten Sie `CA2016` ein.** Lassen Sie den Analyzer die Aufrufe markieren, die Sie in den Schritten 3 bis 5 übersehen haben.

Der Rest dieses Beitrags erweitert die Teile dieser Liste, die echte Feinheiten haben.

## Wohin der Parameter gehört und wie man ihn nennt

Die Konvention in der gesamten BCL lautet: `CancellationToken` ist der **letzte** Parameter und heißt `cancellationToken`. Sehen Sie sich eine beliebige moderne async-API an, und Sie werden die Form erkennen:

```csharp
// From the BCL, for reference
Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken);
Task<int> SaveChangesAsync(CancellationToken cancellationToken = default);
Task<HttpResponseMessage> GetAsync(string requestUri, CancellationToken cancellationToken);
```

Bilden Sie das in Ihrem eigenen Code nach. Zwei Gründe, warum das nicht nur kosmetisch ist:

- **Der `CA2016`-Analyzer stützt sich auf die Position des letzten Parameters.** Er betrachtet eine Methode, die einen `CancellationToken` als letzten Parameter nimmt, und prüft dann, ob die Aufrufe darin ihn weiterreichen. Setzen Sie das Token in die Mitte, und Sie schwächen die Werkzeuge, die Ihre Fehler abfangen sollen.
- **Optionale Parameter müssen ohnehin zuletzt kommen.** Wenn Sie dem Token einen Standardwert geben (`= default`), zwingt C# es hinter alle nicht optionalen Parameter, sodass die Regel des letzten Parameters gratis aus den Sprachregeln folgt.

Beim Namen ist die Aufteilung: `cancellationToken` für alles Öffentliche oder Bibliotheksartige (Konsistenz mit der BCL gewinnt); `ct` ist akzeptabel und im anwendungsinternen Code verbreitet, wo Kürze der Lesbarkeit langer Aufrufketten hilft. Wichtig ist, dass es ein einziger Name ist, damit ein Leser, der eine Methode überfliegt, sofort sieht, ob das Token weitergereicht oder fallen gelassen wird.

## `default`, `CancellationToken.None` und wann man überhaupt einen Standardwert setzt

`default(CancellationToken)` und `CancellationToken.None` sind derselbe Wert: ein Token, das nie abgebrochen werden kann. `IsCancellationRequested` ist immer `false` und `CanBeCanceled` ist `false`. Sie unterscheiden sich nur in der Absichtssignalisierung, und die Sprache gibt Ihnen `= default` als idiomatische Form für optionale Parameter:

```csharp
// .NET 11, C# 14
public async Task<User> GetUserAsync(int id, CancellationToken cancellationToken = default)
{
    return await _db.Users.FindAsync([id], cancellationToken)
        ?? throw new KeyNotFoundException();
}
```

Die Entscheidung, die Leute ins Straucheln bringt, ist, **ob man dem Parameter überhaupt einen Standardwert gibt**. Die Regel, die Sie ehrlich hält:

- **Öffentliche / Bibliotheksmethoden: geben Sie ihm einen Standardwert.** Aufrufer, die wirklich kein Token haben (ein `Main` einer Konsole auf oberster Ebene, ein Fire-and-Forget-Pfad), können ihn weglassen, und die Methode kompiliert weiterhin. Deshalb gibt jede async-Methode der BCL dem Token einen Standardwert.
- **Interne Methoden, die immer unter einem Token laufen: geben Sie ihm keinen Standardwert.** Wenn `BuildReportAsync` nur von einem Anfrage-Handler aufgerufen wird, der ein Token hat, bedeutet das Weglassen eines Standardwerts, dass der Compiler in dem Moment protestiert, in dem jemand es ohne Weiterreichen eines Tokens aufruft. Dieser Kompilierfehler ist eine Funktion. Ihm dort einen Standardwert zu geben, würde ein fallen gelassenes Token als stilles `CancellationToken.None` durchgehen lassen.

Das zu vermeidende Antimuster ist der Griff zu `CancellationToken.None` innerhalb einer Methode, die bereits ein echtes Token im Gültigkeitsbereich hat. Das ist nicht "sicher", es ist ein als Vorsicht getarntes Abbruchleck.

```csharp
// .NET 11, C# 14 -- wrong: leaks cancellation on purpose
public async Task ProcessAsync(CancellationToken ct)
{
    // ct is right there, and we throw it away
    await _client.PostAsync(url, content, CancellationToken.None);
}
```

Die einzige legitime Verwendung von `CancellationToken.None` ist ein Aufruf, den Sie bewusst bis zum Ende laufen lassen wollen, selbst wenn die äußere Operation abgebrochen wird, zum Beispiel das Schreiben eines abschließenden Audit-Datensatzes oder das Freigeben einer Ressource. Machen Sie diese Absicht mit einem Kommentar deutlich, denn andernfalls liest ein Prüfer sie als Bug.

## Das Token des Aufrufers mit Ihrem eigenen Zeitlimit kombinieren

Eine häufige reale Situation: Eine Methode empfängt das `CancellationToken` des Aufrufers, braucht aber auch ihr eigenes Zeitlimit ("gib diesen nachgelagerten Aufruf nach 5 Sekunden auf"). Wählen Sie nicht eines und ignorieren Sie das andere. Verknüpfen Sie sie, sodass ein Abbruch aus **einer der beiden** Quellen die Arbeit stoppt. `CancellationTokenSource.CreateLinkedTokenSource` erzeugt eine Quelle, deren Token auslöst, wenn eines seiner Eltern-Tokens auslöst:

```csharp
// .NET 11, C# 14
public async Task<string> FetchWithTimeoutAsync(
    string url,
    CancellationToken cancellationToken)
{
    using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
    using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(
        cancellationToken, timeoutCts.Token);

    try
    {
        return await _client.GetStringAsync(url, linkedCts.Token);
    }
    catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested
                                             && !cancellationToken.IsCancellationRequested)
    {
        // Distinguish "we timed out" from "the caller cancelled us"
        throw new TimeoutException($"GET {url} exceeded 5s");
    }
}
```

Zwei Details machen dies korrekt:

- **Geben Sie die verknüpfte Quelle frei.** `CreateLinkedTokenSource` registriert Callbacks auf ihren Eltern; sie nicht freizugeben, leckt diese Registrierungen für die Lebensdauer des langlebigsten Eltern-Tokens. Das `using` erledigt das.
- **Der `when`-Filter trennt die beiden Abbruchursachen.** Wenn das Token auslöst, erhalten Sie so oder so eine `OperationCanceledException`. Die Prüfung von `timeoutCts.IsCancellationRequested` gegen `cancellationToken.IsCancellationRequested` sagt Ihnen, welche Quelle ausgelöst hat, sodass ein vom Aufrufer initiierter Abbruch unverändert propagiert wird, während ein Zeitlimit als `TimeoutException` auftaucht. Das ist dieselbe Disziplin, die Sie beim [Abbrechen einer lang laufenden Task ohne Deadlock](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) brauchen.

Wenn Sie nur ein Zeitlimit brauchen und es kein eingehendes Token gibt, ist `CancelAfter` auf einer einzelnen Quelle einfacher als eine verknüpfte. Greifen Sie speziell dann zur Verknüpfung, wenn ein Aufrufer-Token und eine lokale Frist beide gewinnen müssen.

## ASP.NET Core übergibt Ihnen ein Token: verwenden Sie es

In einer Web-App erstellen Sie das Token am Anfang der Kette selten selbst. ASP.NET Core stellt `HttpContext.RequestAborted` bereit, ein `CancellationToken`, das auslöst, wenn der Client die Verbindung trennt oder der Server die Anfrage abbricht. Sowohl Minimal-APIs als auch MVC-Controller binden es automatisch: Deklarieren Sie einen `CancellationToken`-Parameter, und das Framework füllt ihn aus `RequestAborted`.

```csharp
// .NET 11, C# 14 -- minimal API
app.MapGet("/reports/{id}", async (
    int id,
    ReportService reports,
    CancellationToken cancellationToken) =>
{
    var report = await reports.BuildAsync(id, cancellationToken);
    return Results.Ok(report);
});
```

```csharp
// .NET 11, C# 14 -- MVC controller
[HttpGet("reports/{id}")]
public async Task<IActionResult> Get(int id, CancellationToken cancellationToken)
{
    var report = await _reports.BuildAsync(id, cancellationToken);
    return Ok(report);
}
```

Dieses injizierte Token ist der Einstiegspunkt für die gesamte Propagierungskette. Reichen Sie es an `BuildAsync` weiter, das es an seine EF-Core-Abfragen und `HttpClient`-Aufrufe weiterreicht, und ein Client, der den Browser-Tab schließt, stoppt nun all diese nachgelagerte Arbeit, anstatt für eine Abfrage zu bezahlen, die niemand lesen wird. Das zu erwartende Verhalten: Wenn `RequestAborted` mitten in der Anfrage auslöst, werfen Ihre awaits `OperationCanceledException` (oder ihre Unterklasse `TaskCanceledException`), was das Framework als abgebrochene Anfrage statt als 500 behandelt. Wenn Sie diese Ausnahme in den Logs von `HttpClient` sehen, ist das oft genau dies, wie beabsichtigt funktionierend; siehe [warum eine TaskCanceledException aus HttpClient auftaucht](/de/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) für die Unterscheidung zwischen Zeitlimit und Abbruch.

Ein Vorbehalt speziell für Hintergrundarbeit: `RequestAborted` ist auf die Anfrage begrenzt. Wenn ein Anfrage-Handler Arbeit anstößt, die die Antwort überdauern soll, geben Sie ihr nicht `RequestAborted`: Sie wird in dem Moment abgebrochen, in dem die Antwort abgeschlossen ist. Diese Arbeit gehört in einen gehosteten Dienst mit eigener Lebensdauer, was das Muster hinter dem [sicheren Ausführen von Fire-and-Forget-Arbeit mit BackgroundService](/de/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) ist.

## Propagierung durch Streaming und `IAsyncEnumerable<T>`

Async-Streams müssen das Token durch den Iterator verdrahten, und der Mechanismus ist leicht anders, weil der Konsument, nicht der Produzent, das Token zum Zeitpunkt der Enumeration liefert. Der Produzent markiert den Parameter mit `[EnumeratorCancellation]`:

```csharp
// .NET 11, C# 14
public async IAsyncEnumerable<Row> ReadRowsAsync(
    [EnumeratorCancellation] CancellationToken cancellationToken = default)
{
    await using var reader = await _source.OpenAsync(cancellationToken);
    while (await reader.ReadAsync(cancellationToken))
    {
        yield return reader.Current;
    }
}
```

Der Konsument hängt ein Token mit `WithCancellation` an, und der Compiler leitet es in den `[EnumeratorCancellation]`-Parameter:

```csharp
// .NET 11, C# 14
await foreach (var row in ReadRowsAsync().WithCancellation(cancellationToken))
{
    Process(row);
}
```

Ohne `[EnumeratorCancellation]` wird das Token von `WithCancellation` stillschweigend ignoriert und die Enumeration kann nicht abgebrochen werden: ein subtiler Propagierungsbruch, den der `CA2016`-Analyzer nicht immer erkennt. Wenn Sie mit async-Streams neu sind, deckt die Übersicht [wann man zu IAsyncEnumerable greift](/de/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) das größere Bild ab.

## Lassen Sie `CA2016` die erkennen, die Sie fallen lassen

Ein Token von Hand durch eine tiefe Aufrufkette zu führen, ist genau die Art von Aufgabe, bei der Sie einen Aufruf übersehen werden. Der `CA2016`-Analyzer ("Reichen Sie den CancellationToken-Parameter an Methoden weiter, die einen nehmen") ist dafür gemacht: Er untersucht eine Methode, die einen `CancellationToken` als letzten Parameter hat, und markiert dann jeden Aufruf darin, der das Token akzeptieren könnte, direkt oder über eine Überladung, es aber nicht tut. Machen Sie ihn zu einem Build-Fehler, damit ein fallen gelassenes Token in der CI fehlschlägt, statt ausgeliefert zu werden:

```xml
<!-- .editorconfig -- .NET 11 -->
[*.cs]
dotnet_diagnostic.CA2016.severity = error
```

`CA2016` kommt mit den .NET-SDK-Analyzern, die für Projekte, die auf .NET 11 abzielen, standardmäßig aktiviert sind, sodass Sie nur den Schweregrad anheben müssen. Er kommt mit einer Codekorrektur, sodass Sie in Visual Studio oder mit `dotnet format analyzers` das Token über eine ganze Datei automatisch weiterreichen können. Was er nicht tun wird, ist ein Token zu erfinden, wo die umschließende Methode keines hat: Das ist der Fall, den Parameter bei internen Methoden nicht optional zu machen, sodass der Compiler Sie zwingt, ihn hinzuzufügen.

Ein Hinweis zu den blinden Flecken von `CA2016`: Er stützt sich auf die Konvention des letzten Parameters und auf das Vorhandensein einer passenden Überladung. Er markiert keinen Aufruf, der das Token an einer anderen als der letzten Position nimmt, und er berücksichtigt die `[EnumeratorCancellation]`-Weiterleitung nicht. Behandeln Sie ihn als starkes Netz für den häufigen Fall, nicht als Beweis, dass jeder Pfad abgedeckt ist.

## Die Propagierungsfehler, die Tokens am Funktionieren hindern

Einige Muster brechen die Propagierung, selbst wenn das Token technisch vorhanden ist:

- **Neue Quelle pro Aufruf.** `new CancellationTokenSource()` innerhalb einer Methode zu erstellen und *ihr* Token zu übergeben, ignoriert das Token des Aufrufers vollständig. Verknüpfen, nicht ersetzen.
- **`async void`.** Ein Token kann nicht aus einer `async void`-Methode herauspropagiert werden, weil es keine `Task` gibt, die ein Aufrufer erwarten oder auf der er die `OperationCanceledException` beobachten könnte. Halten Sie Abbruchpfade auf `async Task`: Die Gründe überschneiden sich stark mit [warum async void fast immer falsch ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/).
- **Das Verschlucken der `OperationCanceledException`.** Sie abzufangen und einen Standardwert zurückzugeben, verbirgt den Abbruch vor Aufrufern, sodass ein äußeres `Task.WhenAll` oder ein await nie erfährt, dass die Operation gestoppt hat. Lassen Sie sie hochblubbern, es sei denn, Sie haben einen bestimmten Grund, sie zu übersetzen (wie den Zeitlimit-Fall oben).
- **Das synchrone Blatt vergessen.** Eine enge CPU-Schleife am Ende einer async-Kette hat keine erwartete API, an die das Token übergeben werden kann. Fügen Sie ein explizites `cancellationToken.ThrowIfCancellationRequested()` innerhalb der Schleife hinzu, damit das Token weiterhin einen Prüfpunkt hat.

Propagierung ist keine Funktion, die man einschaltet; sie ist eine Eigenschaft, die man pflegt. Jede neue async-Methode ist ein weiteres Glied, das entweder das Token weiterreicht oder die Kette stillschweigend durchtrennt. Fügen Sie den Parameter hinzu, reichen Sie ihn bei jedem Aufruf weiter, lassen Sie `CA2016` die Aufrufe absichern, die Sie vergessen, und reservieren Sie `CancellationToken.None` für die seltene Operation, die Sie wirklich um jeden Preis abschließen wollen.

## Quellen

- [CA2016: Forward the CancellationToken parameter to methods that take one](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2016) -- Microsoft Learn
- [HttpContext.RequestAborted Property](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpcontext.requestaborted) -- Microsoft Learn
- [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding) -- Microsoft Learn
- [CancellationTokenSource.CreateLinkedTokenSource](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.createlinkedtokensource) -- Microsoft Learn
- [EnumeratorCancellationAttribute](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.enumeratorcancellationattribute) -- Microsoft Learn
</content>
</invoke>
