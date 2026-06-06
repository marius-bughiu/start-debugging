---
title: "Von ValueTask<T> zurück zu Task<T> migrieren: wann und warum (.NET 11, C# 14)"
description: "Eine praktische Checkliste, um die Rückgabetypen ValueTask und ValueTask<T> wieder auf Task und Task<T> umzustellen: was an den Aufrufstellen bricht, wie Sie jede Änderung prüfen und wie Sie erkennen, ob die Umstellung den Aufwand wert war."
pubDate: 2026-06-06
updatedDate: 2026-06-06
template: migration
tags:
  - "migration"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
lang: "de"
translationOf: "2026/06/migrate-from-valuetask-back-to-task-when-and-why"
translatedBy: "claude"
translationDate: 2026-06-06
---

Eine `ValueTask<T>`-API wieder auf `Task<T>` zurückzustellen ist üblicherweise eine Arbeit von einem halben Tag und fast immer sicher, denn `Task<T>` ist der nachsichtigere Typ: Alles, was gegen `ValueTask<T>` kompiliert hat, kompiliert weiterhin, und mehrere latente Fehler in Ihren Aufrufern verschwinden in dem Moment, in dem Sie die Umstellung vornehmen. Was Zeit kostet, ist nicht die Änderung des Rückgabetyps selbst, sondern das Prüfen der Aufrufstellen, die sich auf die `ValueTask`-Semantik verlassen haben: eine Methode, die zweimal erwartet wird, ein in einem Feld zwischengespeichertes Ergebnis, ein `.GetAwaiter().GetResult()` auf einem heißen Pfad. Diese Anleitung behandelt, wann das Zurückstellen die richtige Entscheidung ist, die genauen Änderungen an der Deklaration und an jedem Aufrufer, wie Sie jeden Schritt prüfen und wie Sie danach bestätigen, dass Sie nicht das Allokationsprofil verschlechtert haben, das zu korrigieren Sie ursprünglich `ValueTask` eingeführt haben.

Dies zielt auf .NET 11 und C# 14 ab, gültig im Juni 2026, doch nichts davon ist versionsspezifisch: Der `ValueTask`-Vertrag ist stabil, seit er in .NET Core 2.1 eingeführt wurde. Der Rat folgt Stephen Toubs kanonischer Leitlinie in [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/), deren Fazit unmissverständlich ist: "die Standardwahl ist weiterhin `Task` / `Task<TResult>`." Wenn Sie `ValueTask` eingeführt haben, ohne dass ein Profiler es Ihnen geraten hat, ist dies der Beitrag, der Sie zurückführt.

## Warum überhaupt zurückstellen

`ValueTask<T>` existiert, um eine bestimmte Allokation zu vermeiden: das `Task<T>`-Objekt, das eine asynchrone Methode auf dem Heap allokiert, selbst wenn sie synchron abschließt. Das ist ein realer Aufwand auf heißen Pfaden, die fast immer ohne Warten enden (ein Cache-Treffer, ein gepufferter Lesevorgang, eine memoisierte Berechnung). Doch der Typ erkauft sich diesen Gewinn mit einem Vertrag, der leicht zu verletzen ist, und die meisten Codebasen, die danach greifen, hatten das Allokationsproblem nie. Konkrete Gründe, zurückzukehren:

- **Die Aufrufstellen lösen weiterhin CA2012 aus.** Wenn Ihr Team wiederholt dasselbe `ValueTask` zweimal erwartet, es in einem Feld speichert oder darauf blockiert, kostet der Typ Sie aktiv die Korrektheit. `Task<T>` macht alle diese Operationen legal.
- **Sie haben nie einen Gewinn gemessen.** `ValueTask` ist eine vom Profiler getriebene Optimierung. Wenn Sie ihn reflexartig eingeführt haben und ein Benchmark keinen Allokationsunterschied zeigt, ist die zusätzliche Vorsicht reiner Overhead.
- **Die Methode schließt jetzt meist asynchron ab.** `ValueTask` zahlt sich nur aus, wenn synchroner Abschluss der häufige Fall ist. Wenn die Methode bei den meisten Aufrufen begonnen hat, auf echte E/A zu warten, allokieren Sie ohnehin ein Backing-Objekt und tragen die Einschränkungen der Struct umsonst mit.
- **Sie wollen die Ergonomie von `WhenAll` / `WhenAny`.** Die Kombinatoren nehmen `Task`, also zwingt eine `ValueTask`-zurückgebende API jeden Aufrufer, vor dem Parallelisieren `.AsTask()` zu schreiben. Das Zurückstellen entfernt diese Reibung.

Wenn Sie die umgekehrte Richtung abwägen oder noch entscheiden, ob `ValueTask` überhaupt in Ihren Code gehört, dienen die Regeln unten zugleich als Entscheidungshilfe.

## Was bricht (Spoiler: sehr wenig)

| Bereich | Änderung | Schweregrad |
| --- | --- | --- |
| Methodendeklaration | `ValueTask<T>` wird `Task<T>`; `ValueTask` wird `Task` | niedrig |
| Aufrufstellen mit direktem `await` | Keine Änderung nötig; beide Typen sind erwartbar | keiner |
| `.AsTask()`-Aufrufe | Jetzt redundant; entfernen | niedrig |
| `IValueTaskSource<T>`-Implementierungen | Müssen durch eine echte `Task`-Quelle oder `TaskCompletionSource<T>` ersetzt werden | hoch |
| Rückgaben des synchronen Schnellpfads | `return new ValueTask<T>(value)` wird `return Task.FromResult(value)` | mittel |
| Interface-/Basisklassen-Signaturen | Jeder Implementierer und Override muss gemeinsam geändert werden | mittel |
| Öffentliche API-Oberfläche | Binär brechende Änderung für externe Konsumenten | hoch |

Die einzigen wirklich schwierigen Fälle sind ein handgeschriebenes `IValueTaskSource<T>` (selten, und wenn Sie eines haben, haben Sie `ValueTask` bewusst eingeführt, also überlegen Sie es sich zweimal) und eine öffentliche NuGet-Oberfläche, bei der die Änderung des Rückgabetyps ein binärer Bruch ist. Alles andere ist mechanisch.

## Pre-Flight-Checkliste

Bevor Sie eine einzige Signatur anfassen:

- Bestätigen Sie, dass der Analyzer aktiv ist. Die `ValueTask`-Korrektheitsregel **CA2012** ist in .NET 10 und später standardmäßig als Vorschlag aktiviert. Stufen Sie sie zu einer Warnung hoch, damit der Compiler Ihnen genau zeigt, welche Aufrufstellen sich auf die `ValueTask`-Semantik verließen: Fügen Sie `dotnet_diagnostic.CA2012.severity = warning` zu Ihrer `.editorconfig` hinzu.
- Erfassen Sie eine Baseline. Wenn die Allokation jemals der Grund für `ValueTask` war, führen Sie jetzt einen `BenchmarkDotNet`-Durchlauf mit `[MemoryDiagnoser]` auf dem heißen Pfad aus, um danach vergleichen zu können.
- Identifizieren Sie die Vertragsgrenze. Wenn die Methode ein Interface implementiert oder ein Basis-Member überschreibt, ändert sich jede zugehörige Deklaration im selben Commit. Suchen Sie zuerst den Methodennamen in der gesamten Solution.
- Prüfen Sie die öffentliche Oberfläche. Wenn dieser Typ in einem NuGet-Paket ausgeliefert wird, bricht eine Änderung des Rückgabetyps die Binärkompatibilität, auch wenn sie quellcode-kompatibel ist. Planen Sie eine Major-Versionserhöhung.

## Migrationsschritte

Jeder Schritt unten ist eine abgegrenzte Änderung mit einer Verifikationszeile. Führen Sie sie der Reihe nach aus; rechnen Sie mit Zwischenzuständen, in denen der Build rot ist, bis der Vertrag überall aktualisiert ist.

1. **CA2012 zu einer Warnung machen und kompilieren.** Machen Sie den Analyzer laut, bevor Sie etwas ändern, damit der Build jedes riskante Konsummuster zeigt, während die `ValueTask`-Signatur noch vorhanden ist.

   ```ini
   # .editorconfig - .NET 11 SDK, CA2012 ships in the built-in analyzers
   [*.cs]
   dotnet_diagnostic.CA2012.severity = warning
   ```

   Führen Sie `dotnet build` aus. Jede CA2012-Warnung ist eine Aufrufstelle, die das `ValueTask` zweimal erwartet, gespeichert oder darauf blockiert hat, genau der Code, der nach dem Zurückstellen trivial korrekt wird. Notieren Sie jede; die Workarounds löschen Sie in Schritt 4. **Prüfen:** Der Build schließt ab und Sie haben eine schriftliche Liste der CA2012-Treffer (oft null, was selbst eine nützliche Information ist).

2. **Die Deklaration ändern.** Tauschen Sie den Rückgabetyp. Der Methodenrumpf braucht normalerweise eine Änderung pro `return` eines materialisierten Werts.

   ```csharp
   // Before: .NET 11, C# 14
   public ValueTask<User> GetUserAsync(int id)
   {
       if (_cache.TryGetValue(id, out var user))
           return new ValueTask<User>(user);          // synchronous fast path

       return new ValueTask<User>(LoadFromDbAsync(id)); // wraps a Task
   }

   // After: .NET 11, C# 14
   public Task<User> GetUserAsync(int id)
   {
       if (_cache.TryGetValue(id, out var user))
           return Task.FromResult(user);              // synchronous fast path

       return LoadFromDbAsync(id);                     // already a Task<User>
   }
   ```

   Bei einer Methode mit dem Schlüsselwort `async` ist die Änderung nur die Signatur; der Compiler schreibt den Rest um:

   ```csharp
   // Before
   public async ValueTask<int> CountAsync(CancellationToken ct)
   {
       await Task.Delay(5, ct);
       return 42;
   }

   // After: only the return type changed
   public async Task<int> CountAsync(CancellationToken ct)
   {
       await Task.Delay(5, ct);
       return 42;
   }
   ```

   **Prüfen:** Das Projekt kompiliert. Die Form mit dem Schlüsselwort `async` braucht keine weiteren Änderungen; die manuelle Form benötigt, dass jedes `new ValueTask<T>(...)` als `Task.FromResult(...)` umgeschrieben wird oder direkt den inneren `Task` zurückgibt.

3. **Interface- und Basisklassen-Deklarationen gemeinsam aktualisieren.** Wenn die Methode aus einem Vertrag stammt, ändern Sie den Vertrag und jeden Implementierer im selben Durchgang, sonst bricht der Build halb fertig.

   ```csharp
   // Before
   public interface IUserRepository
   {
       ValueTask<User> GetUserAsync(int id);
   }

   // After
   public interface IUserRepository
   {
       Task<User> GetUserAsync(int id);
   }
   ```

   **Prüfen:** `dotnet build` über die gesamte Solution, nicht nur das eine Projekt. Ein übersehener Implementierer erscheint als `CS0535` (implementiert das Interface-Member nicht) oder `CS0508` (Rückgabetyp stimmt beim Override nicht überein).

4. **Die `.AsTask()`-Workarounds und die Doppel-await-Korrekturen löschen.** Hier zahlt sich das Zurückstellen aus. Überall, wo sich ein Aufrufer gegen die Einmal-await-Regel von `ValueTask` abgesichert hat, ist die Absicherung jetzt toter Code.

   ```csharp
   // Before: caller had to convert because it awaited twice / fanned out
   ValueTask<User> vt = repo.GetUserAsync(id);
   Task<User> safe = vt.AsTask();        // required for ValueTask
   var a = await safe;
   var b = await safe;

   // After: Task is awaitable repeatedly; no conversion needed
   Task<User> t = repo.GetUserAsync(id);
   var a = await t;
   var b = await t;
   ```

   `Task.WhenAll` und `Task.WhenAny` nehmen die Ergebnisse nun direkt:

   ```csharp
   // Before: each ValueTask needed .AsTask() before combining
   await Task.WhenAll(ids.Select(id => repo.GetUserAsync(id).AsTask()));

   // After
   await Task.WhenAll(ids.Select(id => repo.GetUserAsync(id)));
   ```

   **Prüfen:** Jede CA2012-Warnung aus Schritt 1 ist verschwunden, und Sie haben mindestens so viele `.AsTask()`-Aufrufe entfernt, wie Sie Warnungen hatten.

5. **Jegliches `IValueTaskSource<T>`-Plumbing ersetzen.** Wenn eine Methode ein gepooltes `ValueTask<T>` zurückgab, das von einem benutzerdefinierten `IValueTaskSource<T>` gestützt wurde (das Muster, das `ManualResetValueTaskSourceCore<T>` ermöglicht), gibt es keinen direkten Ersatz. Sie geben das Pooling auf, also verwenden Sie stattdessen ein `TaskCompletionSource<T>` und akzeptieren Sie die Allokation, die Sie wieder einzuführen wählen.

   ```csharp
   // After: a Task source replaces the pooled IValueTaskSource<T>
   private readonly TaskCompletionSource<int> _tcs =
       new(TaskCreationOptions.RunContinuationsAsynchronously);

   public Task<int> WaitForValueAsync() => _tcs.Task;

   public void Complete(int value) => _tcs.TrySetResult(value);
   ```

   Das Flag `RunContinuationsAsynchronously` ist wichtig: Ohne es führt `TrySetResult` die Fortsetzung inline auf dem abschließenden Thread aus, was auf dieselbe Weise wie eine synchrone Blockierung zu einem Deadlock führen oder den Thread Pool aushungern kann. Dies ist der einzige Schritt, bei dem das Zurückstellen Sie tatsächlich etwas kostet, also tun Sie es nur, wenn das Pooling nie durch einen Benchmark gerechtfertigt war. **Prüfen:** Der Typ implementiert `IValueTaskSource<T>` nicht mehr, und ein Stresstest, der die Operation tausendfach abschließt, läuft weiterhin ohne Wiedereintrittsprobleme durch.

## Verifikation nach der Umstellung

Führen Sie diese Checkliste vollständig durch, bevor Sie die Migration als abgeschlossen betrachten:

- `dotnet build` ist sauber mit CA2012 auf `warning` und null Treffern.
- `dotnet test` läuft ohne neue Fehler durch, besonders rund um Code, der das Erwartbare zuvor zwischenspeicherte.
- Der `BenchmarkDotNet`-Durchlauf mit `[MemoryDiagnoser]` aus dem Pre-Flight zeigt das erwartete Allokationsdelta. Wenn ein synchron abschließender heißer Pfad jetzt einen `Task<T>` pro Aufruf allokiert (24 Byte auf 64 Bit) und dieser Pfad millionenfach pro Sekunde läuft, haben Sie Ihren Beweis, dass `ValueTask` seinen Platz verdient hat und das Zurückstellen ein Fehler war. Wenn die Zahlen flach sind, war das Zurückstellen Korrektheit zum Nulltarif.
- Durchsuchen Sie das Diff nach jedem übersehenen `new ValueTask`, `.AsTask()` oder `ValueTask<`.

## Rollback-Plan

Diese Migration ist auf Quellcode-Ebene vollständig umkehrbar und risikoarm rückgängig zu machen: `Task<T>` wieder zu `ValueTask<T>` zu ändern ist dieselbe mechanische Änderung in umgekehrter Richtung. Die einzige Einschränkung ist der Fall der öffentlichen API. Wenn Sie die `Task<T>`-Version in einem veröffentlichten NuGet-Paket ausgeliefert haben, ist der Rücksprung zu `ValueTask<T>` eine weitere binär brechende Änderung, sodass externe Konsumenten zweimal neu kompilieren. Interner Code hat diese Einschränkung nicht; halten Sie die Migration auf einem Branch und machen Sie den Commit rückgängig, wenn der Benchmark eine Verschlechterung meldet.

## Stolpersteine, auf die wir gestoßen sind

**`Task.FromResult` ist nicht kostenlos für Referenztypen, die Sie ohnehin allokieren.** `Task.FromResult(value)` allokiert weiterhin einen `Task<T>` für einen beliebigen Wert. Die Laufzeit cacht die Tasks für `Task.FromResult(true)`, `false` und kleine Ganzzahlen, aber nicht für Ihren `User`. Wenn Sie gerade deshalb zurückstellen, weil die Methode jetzt selten synchron abschließt, spielt das keine Rolle; wenn sie weiterhin meist synchron abschließt, ist genau diese Allokation das, was `ValueTask` vermied. Messen Sie, bevor Sie annehmen, dass das Zurückstellen harmlos ist.

**`async` über einem synchronen Rumpf führt die Zustandsmaschine wieder ein.** `return new ValueTask<T>(cachedValue)` als `async`-Methode umzuschreiben, die `cachedValue` zurückgibt, fügt eine Zustandsmaschinen-Allokation zusätzlich zum `Task<T>` hinzu. Halten Sie den Schnellpfad ohne `async`: Geben Sie `Task.FromResult(...)` aus einer einfachen Methode zurück, genau wie in Schritt 2. Dieselbe Überlegung, die [ConfigureAwait in .NET 11 weiterhin relevant macht](/2026/05/configureawait-false-vs-default-in-dotnet-11/), gilt auch hier: Der billigste asynchrone Pfad ist der, der nie eine Zustandsmaschine baut.

**Die Abbruchsemantik ändert sich nicht, aber prüfen Sie sie trotzdem.** Sowohl `Task<T>` als auch `ValueTask<T>` legen den Abbruch als ein fehlgeschlagenes/abgebrochenes Erwartbares offen; das Zurückstellen ändert nicht, wie ein `CancellationToken` fließt. Testen Sie dennoch Ihre Abbruchpfade erneut, denn die Umschreibung berührt jede Return-Anweisung. Wenn Ihre Abbruchbehandlung bereits fragil war, lesen Sie [wie man eine lang laufende Task ohne Deadlock abbricht](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/).

**`IAsyncEnumerable<T>` ist der einzige Ort, an dem man `ValueTask` behalten sollte.** `IAsyncEnumerator<T>.MoveNextAsync` gibt `ValueTask<bool>` per Design zurück, und `DisposeAsync` gibt `ValueTask` zurück. "Stellen" Sie diese nicht "zurück"; die Async-Streams-Maschinerie ist darauf ausgelegt, die Backing-Quelle über Iterationen hinweg wiederzuverwenden, was der Lehrbuchfall ist, in dem sich `ValueTask` auszahlt. Wenn Sie mit Streams arbeiten, zeigt [IAsyncEnumerable<T> mit EF Core 11 verwenden](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) das Muster im Kontext.

**Fire-and-Forget verbarg einen Doppelkonsum.** Ein Muster, das wir beim Zurückstellen fanden: Ein `ValueTask` wurde einem Feld zugewiesen und später beobachtet, was illegal ist und unter Last still die Ergebnisse beschädigte. Der Wechsel zu `Task<T>` machte es legal, doch die richtige Korrektur war, das Fire-and-Forget ganz zu lassen. Wenn Sie das sehen, lesen Sie [wie man Fire-and-Forget-Arbeit sicher ausführt](/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/), bevor Sie es mit einer Typänderung übertünchen, und achten Sie auf die [ObjectDisposedException auf einem freigegebenen Kontext](/2026/06/fix-objectdisposedexception-cannot-access-a-disposed-context-instance/), die dasselbe Fire-and-Forget-Muster gern erzeugt.

Die ehrliche Zusammenfassung: `ValueTask<T>` zu `Task<T>` zurückzustellen ist der richtige Standard für Code, der die Struct ohne Profiler in der Hand eingeführt hat. Sie tauschen eine Mikrooptimierung, die Sie wahrscheinlich gar nicht erhielten, gegen einen Typ, den Ihr ganzes Team ohne das Lesen einer Regelliste verwenden kann. Behalten Sie `ValueTask` genau dort, wo die Daten sagen, dass er sich seinen Platz verdient (heiße Pfade mit synchronem Abschluss und Async Streams), und lassen Sie `Task<T>` alles andere tragen.

## Quellen

- [Understanding the Whys, Whats, and Whens of ValueTask -- .NET Blog (Stephen Toub)](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)
- [CA2012: Use ValueTasks correctly -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012)
- [ValueTask&lt;TResult&gt; Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)
- [ValueTask Restrictions -- Stephen Cleary](https://blog.stephencleary.com/2020/03/valuetask.html)
