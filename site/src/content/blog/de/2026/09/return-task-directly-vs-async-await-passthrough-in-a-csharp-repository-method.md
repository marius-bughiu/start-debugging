---
title: "Einen Task direkt zurückgeben vs. async/await-Durchreichen in einer C#-Repository-Methode: Was sollten Sie verwenden?"
description: "Das Weglassen von async/await in einer durchreichenden Repository-Methode spart etwa 6 ns und 72 Bytes und kostet einen Stack-Frame, die try/catch-Semantik und die sichere Freigabe von Ressourcen. Behalten Sie return await, sofern die Methode nicht reines Durchreichen auf einem gemessenen heißen Pfad ist."
pubDate: 2026-09-01
template: vs
tags:
  - "comparison"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "performance"
lang: "de"
translationOf: "2026/09/return-task-directly-vs-async-await-passthrough-in-a-csharp-repository-method"
translatedBy: "claude"
translationDate: 2026-09-01
---

Sie haben eine Repository-Methode, die nichts anderes tut, als an EF Core, Dapper oder einen `HttpClient` weiterzureichen. Sie können sie als `public Task<Order> GetAsync(int id) => _db.Orders.FindAsync(id).AsTask();` schreiben und die Zustandsmaschine einsparen, oder als `public async Task<Order> GetAsync(int id) => await _db.Orders.FindAsync(id);` und sie behalten. **Behalten Sie das `await`.** Das Weglassen bringt unter .NET 10 rund 6 Nanosekunden und 72 Bytes pro Aufruf, was neben jedem Datenbank-Roundtrip unsichtbar ist, und kostet einen Frame in jedem Stack Trace sowie drei Verhaltensweisen, die sich still ändern, sobald die Methode jemals ein `using`, ein `try` oder ein `lock` bekommt. Lassen Sie es nur weg, wenn die Methode ein echtes einzeiliges Durchreichen auf einem Pfad ist, den Sie profiliert haben. Alle Messungen unten laufen auf .NET 10.0.10 mit C# 14; die .NET-11-Geschichte (Preview 7, finale Version am 2026-11-10) steht am Ende und schwächt das Argument fürs Weglassen, statt es zu stärken.

## Die beiden Formen im Überblick

| Verhalten                                            | `return await inner()` (async) | `return inner()` (weggelassen) |
| ---------------------------------------------------- | ------------------------------ | ------------------------------ |
| Zustandsmaschine wird erzeugt                        | ja                             | nein                           |
| Erscheint im Stack Trace der Ausnahme                | ja                             | **nein**                       |
| Kosten, innerer Aufruf endet synchron                | 8,5 ns / 144 B                 | 2,6 ns / 72 B                  |
| Kosten, innerer Aufruf suspendiert wirklich          | 1111 ns / 286 B                | 1010 ns / 191 B                |
| Sicher innerhalb von `using` / `await using`         | ja                             | **nein**                       |
| `try`/`catch` um den Aufruf greift tatsächlich       | ja                             | **nein**                       |
| Ausnahmen aus der Argumentprüfung erscheinen         | beim `await`                   | an der Aufrufstelle            |
| Rückgabetyp darf vom inneren abweichen               | ja (Kovarianz, `ValueTask`)    | nein (CS0029)                  |
| `ConfigureAwait(false)` anwendbar                    | ja                             | n/v (erbt vom inneren)         |
| Löst CS1998 aus, wenn das letzte await entfällt      | ja                             | n/v                            |

Zwei Zeilen dieser Tabelle sind Fakten zur Kompilierzeit, der Rest ist Laufzeitverhalten, das Sie erst in der Produktion entdecken. Diese Asymmetrie ist das gesamte Argument für den Standard.

## Was der Compiler tatsächlich erzeugt

`async` ist keine Aufrufkonvention, sondern eine Umschreibung. Wenn Sie eine Methode als `async` markieren, verwandelt Roslyn sie in ein Struct, das `IAsyncStateMachine` implementiert, hebt jede lokale Variable in ein Feld dieses Structs und ersetzt den Rumpf durch ein switch innerhalb von `MoveNext()`. Die Methode selbst wird zu einem Stub, der einen `AsyncTaskMethodBuilder<T>` erzeugt, die Maschine startet und `builder.Task` zurückgibt. Dieses zurückgegebene `Task<T>` ist ein **neuer** Task, verschieden von dem, den der innere Aufruf erzeugt hat, und der Builder ist dafür zuständig, ihn abzuschließen, sobald der innere Task fertig ist.

Lassen Sie das `async` weg, passiert nichts davon. Die Methode kompiliert zu einem einfachen Aufruf plus einem return, und der Aufrufer erhält *dieselbe* `Task<T>`-Instanz, die die innere Methode erzeugt hat. Es gibt keinen Builder, keine Zustandsmaschine auf dem Heap, keine Registrierung einer Fortsetzung und keinen zweiten Task.

```csharp
// .NET 10, C# 14
public sealed class OrderRepository(AppDbContext db)
{
    // elided: the caller gets the exact Task instance EF Core created
    public Task<List<Order>> GetOpenAsync(CancellationToken ct) =>
        db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);

    // await passthrough: EF Core's task is awaited, and a second task is handed out
    public async Task<List<Order>> GetOpenAwaitedAsync(CancellationToken ct) =>
        await db.Orders.Where(o => o.Status == OrderStatus.Open).ToListAsync(ct);
}
```

Beide kompilieren. Beide sind korrekt *für genau diesen Rumpf*. Die Unterschiede beginnen in dem Moment, in dem der Rumpf nicht mehr genau dieser ist.

## Was das zusätzliche await wirklich kostet

Ich habe beide Formen mit BenchmarkDotNet 0.15.8 auf einem Apple M4 (10 Kerne), macOS 26.6.2, .NET SDK 10.0.302, Host-Laufzeit .NET 10.0.10, Arm64 RyuJIT, mit aktiviertem `MemoryDiagnoser` und Workstation-GC gemessen. Zwei Szenarien: eine innere Methode, die synchron abschließt (`Task.FromResult`, der Treffer im First-Level-Cache von EF Core), und eine, die wirklich suspendiert (`await Task.Yield()`, der echte E/A-Fall).

| Methode             | Mittel     | Ratio | Alloziert | Alloc-Ratio |
| ------------------- | ---------- | ----- | --------- | ----------- |
| `Elided_Completed`  | 2,63 ns    | 1,00  | 72 B      | 1,00        |
| `Awaited_Completed` | 8,47 ns    | 3,22  | 144 B     | 2,00        |
| `Elided_Suspends`   | 1009,95 ns | 383,5 | 191 B     | 2,65        |
| `Awaited_Suspends`  | 1110,81 ns | 421,8 | 286 B     | 3,97        |

Liest man die Verhältnisse, sieht das Weglassen nach einem 3x-Gewinn aus. Liest man die absoluten Zahlen, sind es 5,8 Nanosekunden und 72 Bytes auf dem synchronen Pfad, 101 Nanosekunden und 95 Bytes auf dem suspendierenden Pfad. Die 72 Bytes auf dem schnellen Pfad sind der zweite `Task<int>`, den der Builder alloziert; die 95 Bytes auf dem langsamen Pfad sind die Zustandsmaschine auf dem Heap plus dieser Task.

Stellen Sie das nun neben das, was eine Repository-Methode tatsächlich tut. Ein Roundtrip zu einem lokalen PostgreSQL dauert 200 bis 500 Mikrosekunden. Einer über Availability Zones hinweg dauert einige Millisekunden. 101 Nanosekunden liegen zwischen 0,002 % und 0,05 % einer einzigen Abfrage. Sie bräuchten in der Größenordnung von zehntausend weggelassenen Durchreichungen, um die Zeit einer Abfrage zurückzuholen. Der Fall des synchronen Abschlusses ist der einzige, in dem das Verhältnis nicht vollständig geschluckt wird, und dieser Fall zählt genau dort, wo man es erwartet: eine enge Schleife über einen bereits gecachten Wert, ein schneller `ValueTask`-Pfad, eine heiße Serialisierungsschleife. Nicht `GetOrderByIdAsync`.

## Wo das Weglassen still das Verhalten ändert

### Der Stack-Frame verschwindet

Das sind die Kosten, die Sie täglich zahlen und erst um 3 Uhr nachts bemerken. Eine Methode, die einen Task zurückgibt, ohne ihn zu erwarten, ist in dem Augenblick fertig, in dem sie zurückkehrt; wenn die Ausnahme geworfen wird, ist ihr Frame längst verschwunden. Stack Traces in asynchronem Code sind ein Protokoll ausstehender Fortsetzungen, nicht davon, wer wen aufgerufen hat.

```csharp
// .NET 10, C# 14
static Task ElidedPassthroughAsync() => ThrowAsync();
static async Task AwaitedPassthroughAsync() => await ThrowAsync();

static async Task ThrowAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}
```

Fängt man oben ab und gibt `ex.StackTrace` aus, ergeben sich zwei verschiedene Bilder:

```text
=== ELIDED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<Main>$(String[] args) in Program.cs:line 4

=== AWAITED ===
   at Program.<<Main>$>g__ThrowAsync|0_2() in Program.cs:line 16
   at Program.<<Main>$>g__AwaitedPassthroughAsync|0_1() in Program.cs:line 11
   at Program.<Main>$(String[] args) in Program.cs:line 7
```

`ElidedPassthroughAsync` taucht im Trace überhaupt nicht auf. Bei einem Beispiel aus zwei Methoden ist das eine Kuriosität. In einem echten Dienst, in dem das Gegenstück zu `ThrowAsync` (eine `SqlException` aus `ToListAsync`) aus elf verschiedenen Repository-Methoden erreicht wird, sind genau die weggelassenen Frames diejenigen, die Ihnen gesagt hätten, welche Funktion kaputtgegangen ist. Wenn Sie bereits gelesen haben, wie [Runtime Async in .NET 11 asynchrone Stack Traces aufräumt](/de/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/), beachten Sie: es macht die Frames, die Sie *haben*, weit lesbarer, kann aber keinen Frame wiederbeleben, der nie eine Fortsetzung registriert hat.

### `using` gibt frei, bevor die Arbeit fertig ist

Das ist der Fehler, kein Kompromiss. `using var` kompiliert zu einem `try`/`finally` um den Rest des Gültigkeitsbereichs, und das `finally` läuft, wenn die Methode zurückkehrt. Eine Methode ohne `await` kehrt zurück, sobald der innere Aufruf einen unvollständigen Task liefert.

```csharp
// .NET 10, C# 14 -- broken: the resource is disposed while the task is still running
static Task<int> BadAsync()
{
    using var res = new Resource();
    return res.UseAsync();
}

// correct: the finally runs after the awaited work completes
static async Task<int> GoodAsync()
{
    using var res = new Resource();
    return await res.UseAsync();
}
```

`BadAsync` wirft jedes Mal `ObjectDisposedException: Cannot access a disposed object. Object name: 'Resource'`; `GoodAsync` schließt ab. Dasselbe gilt für `await using` über einem `IAsyncDisposable`, für ein in einem `finally` freigegebenes `SemaphoreSlim` und für jeden Transaktionsbereich. Wenn Ihr Repository eine Verbindung öffnet, eine Transaktion beginnt oder aus einem Pool leiht, ist das Weglassen keine Optimierung, sondern ein Zugriff nach der Freigabe. Die Regeln zur Freigabereihenfolge sind ausführlicher in [IAsyncDisposable mit await using implementieren und konsumieren](/de/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) behandelt.

### `try`/`catch` fängt nicht mehr

Derselbe Mechanismus, anderes Symptom. Ein `catch`-Block fängt nur Ausnahmen, die geworfen werden, während der Frame auf dem Stack liegt. Eine Ausnahme, die geworfen wird, nachdem die innere Methode suspendiert hat, wird über den zurückgegebenen Task ausgeliefert, lange nachdem Ihr `try`-Block verlassen wurde.

```csharp
// .NET 10, C# 14
static Task<string> ElidedTryAsync()
{
    try { return ThrowAsync(); }                              // catch never runs
    catch (InvalidOperationException) { return Task.FromResult("caught"); }
}

static async Task<string> AwaitedTryAsync()
{
    try { return await ThrowAsync(); }                        // catch runs
    catch (InvalidOperationException) { return "caught"; }
}
```

Die weggelassene Version lässt `InvalidOperationException` zum Aufrufer entweichen; die Version mit await gibt `"caught"` zurück. Das ist die Variante des Fehlers, die das Code-Review überlebt, weil das `try`/`catch` *direkt da* steht und aussieht, als täte es etwas.

### Prüf-Ausnahmen wandern an die Aufrufstelle

Eine `async`-Methode wirft nie synchron. Jede Ausnahme, auch eine aus der ersten Zeile, wird eingefangen und auf den zurückgegebenen Task gelegt. Eine Methode ohne `async` hat keinen Builder, in den sie einfangen könnte, also wirft eine Guard-Klausel sofort, an der Aufrufexpression, bevor der Aufrufer überhaupt einen Task zum Erwarten hat.

```csharp
// .NET 10, C# 14
static Task<int> ElidedValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws at the call site
    return Task.FromResult(id.Length);
}

static async Task<int> AsyncValidateAsync(string? id)
{
    ArgumentNullException.ThrowIfNull(id);   // throws when the task is awaited
    await Task.Yield();
    return id.Length;
}
```

Aufrufer, die `var t = repo.GetAsync(null); /* ... */ await t;` schreiben oder die Methode innerhalb eines `Select` an `Task.WhenAll` übergeben, verhalten sich zwischen beiden Formen unterschiedlich. Bei der weggelassenen Form kann `Select(x => repo.GetAsync(x)).ToList()` *während der Materialisierung* werfen, noch bevor `WhenAll` überhaupt erreicht wird, und keiner der bereits gestarteten Tasks wird beobachtet. Für sich genommen ist keines der beiden Verhalten falsch, aber zwischen ihnen zu wechseln, indem man ein `await` hinzufügt oder entfernt, ist kein Refactoring, mit dem Leser rechnen.

## Die Fälle, in denen das Weglassen gar nicht kompiliert

`Task<T>` ist eine Klasse und damit invariant. `Task<Dog>` ist kein `Task<Animal>`, und der Compiler sagt es Ihnen:

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.Task<Dog>'
              to 'System.Threading.Tasks.Task<Animal>'
```

Dieselbe Wand erscheint, wenn die innere Methode `ValueTask<int>` zurückgibt und Ihr Vertrag `Task<int>` lautet, was üblich ist, sobald Sie `FindAsync` oder eine `IAsyncEnumerable`-Brücke berühren:

```text
error CS0029: Cannot implicitly convert type 'System.Threading.Tasks.ValueTask<int>'
              to 'System.Threading.Tasks.Task<int>'
```

`await` erledigt die Konvertierung kostenlos. Ohne es brauchen Sie `.AsTask()` (eine Allokation, die die Ersparnis auslöscht) oder eine explizite Umwandlung, die es nicht gibt. Da eine Repository-Schnittstelle fast immer die Abstraktion (`Task<IReadOnlyList<Order>>`) statt des konkreten Rückgabetyps des Providers (`Task<List<Order>>`) offenlegt, ist das kein Randfall, sondern der Großteil der Schnittstelle. Und falls Sie erwogen haben, `ValueTask` stattdessen durch die Schichten nach oben zu reichen, lesen Sie zuerst [wann ValueTask sich lohnt](/de/2026/06/what-is-valuetask-and-when-is-it-worth-it/): die Einschränkungen kosten mehr als die Allokation.

Das Weglassen entfernt außerdem die Naht, an der Sie `ConfigureAwait(false)` setzen würden. In einer Bibliothek, die noch auf einen Host mit `SynchronizationContext` zielt, erbt ein weggelassenes Durchreichen das, was die innere Methode konfiguriert hat, und das kann nichts sein. Das ist eine Stelle weniger zum Annotieren, aber auch eine Stelle weniger zum Korrigieren. Ob diese Naht 2026 noch lohnt, behandelt [ConfigureAwait(false) gegenüber dem Standard in .NET 11](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/).

## Was Runtime Async in .NET 11 an dieser Abwägung ändert

Runtime Async, das auf `net11.0`-Projekten kein `<EnablePreviewFeatures>` mehr braucht, verlagert die Suspendierung aus compilergenerierten Zustandsmaschinen in die CLR. Preview 7 hat zwei Dinge ergänzt, die diesen Vergleich direkt treffen. Asynchrone Methoden durchlaufen jetzt die gestufte Kompilierung, statt dauerhaft den tier0-Code auszuführen, und der JIT hat eine **Tail-await-Optimierung** bekommen: wenn die letzte Handlung einer asynchronen Methode darin besteht, einen Aufruf zu erwarten, dessen zurückgegebener Task dem eigenen Rückgabetyp der Methode entspricht, kann die Laufzeit einen impliziten Tailcall erzeugen und so "Codegröße und Instruktionszahl deutlich reduzieren". Diese Optimierung beschreibt genau `async Task<T> M() => await Inner();`. Es ist das Weglassen, angewandt von der Laufzeit, ohne dass Ihr Quellcode die Frame-Semantik aufgibt.

Dieselben Release Notes berichten, dass die Tail-await-Arbeit in tier0 die maximale Allokationsrate während des Aufwärmens von TechEmpower `platform-json` von 110.580.952 B/s auf 8.030.616 B/s gesenkt hat. Die Richtung ist eindeutig: die Laufzeit schließt genau die Lücke, die Sie von Hand optimieren würden. Heute `return inner()` zu schreiben, um 72 Bytes zu sparen, heißt, eine Compiler-Optimierung abzuschreiben, die im November erscheint, und dabei jedes Verhaltensrisiko dauerhaft zu behalten.

## Die Analyzer, die Sie in die falsche Richtung drängen

Zwei verbreitete Analyzer melden `return await` als redundant. **RCS1174 "Remove redundant async/await"** von Roslynator ist der erste, auf den Sie treffen, und es gibt eine seit Langem offene Bitte, ihn standardmäßig abzuschalten, genau weil Stephen Cleary und das .NET-Team die Transformation als pauschale Regel für unsicher halten. **AsyncFixer01 "Unnecessary async/await usage"** macht denselben Vorschlag. Keiner von beiden kann sehen, ob Ihre Methode im nächsten Sprint ein `using` bekommt, und keiner weiß, dass Sie sich in Produktions-Traces auf diesen Frame verlassen.

Die praktische Einstellung ist, beide auszuschalten oder auf `suggestion` zu setzen und niemals lösungsweit automatisch zu korrigieren. Ein pauschales "RCS1174 auf alle Dokumente anwenden" gehört zu den wenigen Refactorings, die `ObjectDisposedException` in eine funktionierende Codebasis einschleusen können. Beachten Sie, dass dies die Gegenrichtung zu CS1998 ist: diese Warnung schlägt an, wenn eine `async`-Methode *überhaupt kein* `await` enthält, und dort ist das Entfernen des Modifizierers tatsächlich die richtige Korrektur, wie in [CS1998 beheben, ohne die Methode zu zerstören](/de/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/) beschrieben.

## Die Regel, die ich in Repository-Code anwende

- **Standard ist `return await`.** Die 6 Nanosekunden sind nicht real; der fehlende Stack-Frame und das Freigaberisiko sind es.
- **Lassen Sie nur weg, wenn alle vier Punkte gelten**: der Methodenrumpf besteht aus genau einer `return`-Anweisung, es gibt darin nirgends ein `using`, `try`, `lock` oder `finally`, der Rückgabetyp ist identisch mit dem des inneren Aufrufs, und Sie haben ein Profil, das das Durchreichen auf einem heißen Pfad zeigt. Drei davon prüfen Sie durch Lesen; den vierten überspringen die meisten.
- **Wenden Sie RCS1174 oder AsyncFixer01 niemals massenhaft an.** Unterdrücken Sie sie auf Projektebene, statt Methode für Methode zu korrigieren.
- **Unter .NET 11 lassen Sie es ganz sein.** Die Tail-await-Optimierung liefert Ihnen die Codegenerierung kostenlos, und die weggelassene Form gibt Frames auf, die die Laufzeit sonst behalten hätte.

Das Unangenehme an diesem Vergleich ist, dass die weggelassene Form nicht langsamer, nicht hässlicher und nicht falsch ist. Sie ist tatsächlich schneller, um einen Betrag, den kein Repository jemals bemerken wird, im Tausch gegen eine Methode, deren Semantik sich ändert, sobald jemand sie bearbeitet. Das ist zu jedem Kurs ein schlechter Handel, und .NET 11 macht den Zähler gerade zu null.

## Verwandte Artikel

- [Runtime Async in .NET 11 ersetzt Zustandsmaschinen und liefert saubere Stack Traces](/de/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/)
- [CS1998 beheben: "This async method lacks 'await' operators and will run synchronously"](/de/2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously/)
- [ConfigureAwait(false) gegenüber dem Standard in .NET 11: zählt das noch?](/de/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [Was ist ValueTask und wann lohnt es sich?](/de/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [IAsyncDisposable mit await using in C# implementieren und konsumieren](/de/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)
- [.Result vs. .Wait() vs. GetAwaiter().GetResult() vs. await in C#](/de/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

## Quellen

- [Eliding Async and Await](https://blog.stephencleary.com/2016/12/eliding-async-await.html) -- Stephen Cleary
- [Runtime-Release-Notes zu .NET 11 Preview 7: runtime-async tiering and tail-await optimizations](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/runtime.md) -- dotnet/core
- [.NET 11 Preview 7 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-7/) -- .NET Blog
- [RCS1174: Remove redundant async/await](https://josefpihrt.github.io/docs/roslynator/analyzers/RCS1174/) -- Roslynator
- [Disable by default RCS1174 (issue #429)](https://github.com/JosefPihrt/Roslynator/issues/429) -- dotnet/roslynator
- [AsyncFixer: async/await analyzers and code fixes](https://github.com/semihokur/AsyncFixer) -- semihokur
- [Referenz der Compilermeldungen zu async und await](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) -- Microsoft Learn
