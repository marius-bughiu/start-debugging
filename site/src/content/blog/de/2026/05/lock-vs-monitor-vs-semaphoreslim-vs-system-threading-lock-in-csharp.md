---
title: "lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#"
description: "Vier Wege, einen kritischen Abschnitt in C# abzusichern, und eine Entscheidungsmatrix für die Auswahl. Nutzen Sie System.Threading.Lock für synchronen gegenseitigen Ausschluss auf .NET 9+, SemaphoreSlim wenn der Abschnitt ein await überspannt, und Monitor nur wenn Sie Wait/Pulse benötigen."
pubDate: 2026-05-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
lang: "de"
translationOf: "2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp"
translatedBy: "claude"
translationDate: 2026-05-24
---

Für synchronen gegenseitigen Ausschluss in neuem Code auf .NET 9 oder höher nutzen Sie `System.Threading.Lock` und schreiben es mit dem Schlüsselwort `lock`. Wenn der kritische Abschnitt auf etwas warten (`await`) muss, ist keines der synchronen Primitive zulässig, greifen Sie also zu `SemaphoreSlim(1, 1)` und `await WaitAsync()`. Reservieren Sie reines `Monitor` für den einen Fall, den die anderen überhaupt nicht abdecken: Bedingungsvariablen (`Monitor.Wait` / `Pulse` / `PulseAll`). Das klassische Idiom `lock (object)` ist nicht falsch, es kompiliert nur zu einem etwas schwereren `Monitor`-Pfad als `Lock`, daher gibt es auf .NET 9+ keinen Grund, ein neues Gate mit einem einfachen `object` zu beginnen.

Dieser Artikel zielt auf .NET 11 (preview 4), C# 14 und die BCL im Stand von `System.Threading` in net11.0 ab. `System.Threading.Lock` ist ein .NET-9-Typ, daher gilt die Empfehlung gleichermaßen für .NET 9, .NET 10 und .NET 11. `Monitor` und das Schlüsselwort `lock` reichen bis .NET 1.1 und C# 1.0 zurück; `SemaphoreSlim` kam mit .NET Framework 4.0.

## Die vier Kandidaten sind nicht wirklich gleichrangig

Der Grund, warum dieser Vergleich Verwirrung stiftet, ist, dass die vier Namen auf unterschiedlichen Schichten liegen.

`lock` ist eine C#-Sprachanweisung. Sie implementiert selbst nichts. Der Compiler reduziert `lock (x) { body }` je nach statischem Typ von `x` zu einer von zwei Formen. Ist `x` ein `System.Threading.Lock`, wird daraus `using (x.EnterScope()) { body }`. Für jeden anderen Referenztyp wird daraus ein `Monitor.Enter` / `Monitor.Exit`-Paar, eingewickelt in ein `try` / `finally`. Die Frage "soll ich `lock` oder `Monitor` nutzen" ist also größtenteils eine Scheinwahl: `lock (someObject)` *ist* `Monitor`, nur sicherer geschrieben.

`Monitor` ist die statische API hinter dem klassischen Idiom. Sie leistet gegenseitigen Ausschluss, trägt aber auch zwei Eigenschaften, die den anderen fehlen: Rekursion (derselbe Thread kann zweimal eintreten) und Bedingungsvariablen über `Wait`, `Pulse` und `PulseAll`. Diese Bedingungsvariablen-Methoden sind die einzige Fähigkeit in diesem ganzen Vergleich, die keinen Ersatz unter den anderen dreien hat.

`System.Threading.Lock` ist der dedizierte Typ für gegenseitigen Ausschluss, der in .NET 9 eingeführt wurde. Er ist das, was `Monitor` gewesen wäre, wenn er nicht zugleich als Backing-Implementierung für `lock (object)` gedient hätte. Er stellt genau das bereit, was ein Mutex braucht, und nichts weiter. Die tiefgehende Betrachtung, [wie System.Threading.Lock funktioniert und wie man dorthin migriert](/de/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/), behandelt seine Mechanik im Detail.

`SemaphoreSlim` ist ein zählendes Semaphor, kein Mutex, wird aber zu einem Mutex, wenn Sie es mit einem Zähler von eins konstruieren. Was es von den anderen dreien abhebt, ist `WaitAsync`: Es ist das einzige Primitiv hier, das Sie zulässig über ein `await` hinweg halten können.

## Die Entscheidungsmatrix

Jede Zeile dieser Tabelle bezieht sich auf das Verhalten von .NET 9+ / C# 13+, sofern nicht anders vermerkt.

| Fähigkeit                               | `lock (object)`        | `Monitor`              | `SemaphoreSlim`             | `System.Threading.Lock`   |
| --------------------------------------- | ---------------------- | ---------------------- | --------------------------- | ------------------------- |
| Gegenseitiger Ausschluss (ein Halter)   | ja                     | ja                     | ja, bei `new(1, 1)`         | ja                        |
| Auf N > 1 gleichzeitige Halter begrenzen| nein                   | nein                   | ja, `new(N, N)`             | nein                      |
| `await` im gehaltenen Bereich zulässig  | nein (CS1996)          | nein (CS1996)          | ja, über `WaitAsync`        | nein (CS1996)             |
| Bedingungsvariablen (`Wait`/`Pulse`)    | nein                   | ja                     | nein                        | nein                      |
| Wiedereintrittsfähig im selben Thread   | ja                     | ja                     | nein (Deadlock)             | ja                        |
| Erzwingt Thread-/Halter-Identität       | ja                     | ja                     | nein                        | ja                        |
| Reduziert zu                            | `Monitor.Enter`/`Exit` | (selbst)               | `Wait`/`Release`            | `Lock.EnterScope()`       |
| Sync-Block-Inflation bei Konkurrenz     | ja                     | ja                     | nein                        | nein                      |
| Erwerbsversuch mit Timeout              | `Monitor.TryEnter`     | `TryEnter(TimeSpan)`   | `Wait(TimeSpan)`            | `TryEnter(TimeSpan)`      |
| Abbrechbarer Erwerb                     | nein                   | nein                   | ja (`CancellationToken`)    | nein                      |
| Prozessübergreifend                     | nein                   | nein                   | nein (nutzen Sie `Semaphore`)| nein                     |
| `IDisposable`                           | nein                   | nein                   | ja                          | nein                      |
| Erstmals erschienen                     | C# 1.0                 | .NET 1.1               | .NET Framework 4.0          | .NET 9                    |

Zwei Zeilen entscheiden fast jeden realen Fall: "`await` im Bereich zulässig" und "Bedingungsvariablen". Brauchen Sie das Erste, sind Sie bei `SemaphoreSlim`. Brauchen Sie das Zweite, sind Sie bei `Monitor`. Alles andere weist auf `System.Threading.Lock`.

## Wann Sie System.Threading.Lock wählen sollten

Dies ist die Standardwahl für neuen synchronen Code auf .NET 9+.

- Sie sichern einen kurzen, CPU-gebundenen kritischen Abschnitt ab: die Aktualisierung eines In-Memory-Cache, einen Zähler, eine `Dictionary`-Mutation, ein Feld mit verzögerter Initialisierung. Der Rumpf wartet (`await`) auf nichts. Das sind 90 % des Sperrens in einem typischen Dienst.
- Sie migrieren ein bestehendes `lock (object)`-Gate und der Rumpf ist synchron. Die Änderung ist einzeilig: `private readonly object _gate = new();` wird zu `private readonly Lock _gate = new();`. Jede `lock (_gate) { ... }`-Anweisung bleibt Byte für Byte gleich, und der Compiler bindet sie von `Monitor.Enter` auf `Lock.EnterScope()` um.
- Sie wollen den kleineren Fußabdruck. Ein `Lock` inflationiert unter Konkurrenz nie einen prozessweiten Sync-Block, daher lässt ein Dienst, der Tausende von Gates hält (etwa eines pro Cache-Eintrag), die Sync-Block-Tabelle nicht so wachsen wie `Monitor`.

```csharp
// .NET 11, C# 14 -- the default gate for synchronous critical sections
public sealed class Counter
{
    private readonly Lock _gate = new();
    private long _value;

    public void Increment()
    {
        lock (_gate) // lowers to using (_gate.EnterScope())
        {
            _value++;
        }
    }

    public long Read()
    {
        lock (_gate)
        {
            return _value;
        }
    }
}
```

Wenn Sie noch nicht auf .NET 9 wechseln können, ist der Rückfall das klassische `lock (object)`. Es hat dieselbe Semantik, nur etwas schwerer. Greifen Sie nicht explizit zu `Monitor`, nur um zu sperren; das Schlüsselwort `lock` wickelt `Monitor.Enter` / `Exit` bereits in das korrekte `try` / `finally` ein, sodass die Sperre auch dann freigegeben wird, wenn der Rumpf eine Ausnahme wirft. Ein handgeschriebenes `Monitor.Enter` ohne ein `finally` ist eine klassische Quelle verwaister Sperren.

## Wann Sie SemaphoreSlim wählen sollten

`SemaphoreSlim` ist die Antwort auf genau eine Frage, die die synchronen Primitive nicht beantworten können: Wie serialisiere ich einen Abschnitt, der ein `await` enthält?

- Der kritische Abschnitt überspannt ein `await`. Sie rufen eine asynchrone API auf (eine `HttpClient`-Anfrage, eine EF-Core-Abfrage, einen Dateischreibvorgang) und brauchen jeweils nur einen Aufrufer im Bereich. `lock`, `Monitor` und `Lock` verbieten allesamt `await` im gehaltenen Bereich. `SemaphoreSlim` nicht.
- Sie wollen die Nebenläufigkeit auf N größer als eins begrenzen. Eine Drossel, die drei gleichzeitige ausgehende Aufrufe erlaubt, ist `new SemaphoreSlim(3, 3)`. Kein Mutex kann das ausdrücken.
- Sie brauchen einen abbrechbaren oder zeitgebundenen Erwerb auf einem asynchronen Pfad. `WaitAsync(CancellationToken)` und `WaitAsync(TimeSpan)` fügen sich in den Rest Ihrer Abbruch-Strategie ein.

```csharp
// .NET 11, C# 14 -- async-safe mutual exclusion across an await
public sealed class AsyncCache : IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1); // count 1 == mutex
    private readonly Dictionary<string, byte[]> _store = new();

    public async Task<byte[]> GetOrAddAsync(string key, Func<string, Task<byte[]>> factory)
    {
        await _gate.WaitAsync();
        try
        {
            if (_store.TryGetValue(key, out var existing))
                return existing;

            var fresh = await factory(key); // legal: we are holding a semaphore, not a lock
            _store[key] = fresh;
            return fresh;
        }
        finally
        {
            _gate.Release(); // ALWAYS in finally
        }
    }

    public void Dispose() => _gate.Dispose();
}
```

Drei Fallen kommen mit `SemaphoreSlim`, und alle drei gehen auf dieselbe Wurzel zurück: Es verfolgt nicht, wer es hält. Laut der [SemaphoreSlim-Dokumentation](https://learn.microsoft.com/dotnet/api/system.threading.semaphoreslim) erzwingt die Klasse "keine Thread- oder Task-Identität bei Aufrufen der Methoden Wait, WaitAsync und Release".

1. **Keine Wiedereintrittsfähigkeit.** Ruft eine Methode, die das Semaphor hält, eine andere Methode auf, die ebenfalls auf dasselbe Semaphor wartet, geraten Sie in einen Deadlock. `Monitor` und `Lock` würden demselben Thread den Wiedereintritt erlauben; `SemaphoreSlim` kann es nicht, weil es kein Konzept eines besitzenden Threads zum Vergleich hat.
2. **Release ist ungeschützt.** Nichts hindert Sie daran, `Release` öfter aufzurufen, als Sie `Wait` aufgerufen haben, was `CurrentCount` stillschweigend über den Anfangszähler hinaus anhebt und die Invariante bricht. Paaren Sie `Wait` / `WaitAsync` stets mit `Release` in einem `finally`.
3. **Es ist `IDisposable`.** Anders als die anderen drei besitzt ein `SemaphoreSlim` ein verzögert allokiertes `WaitHandle` und muss verworfen werden. Ein Semaphor auf Feldebene bedeutet, dass Ihre Klasse nun ebenfalls `IDisposable` ist.

Der Overhead pro Erwerb ist höher als bei einem `Lock`. Das ist der Preis für die asynchrone Unterstützung. Nutzen Sie `SemaphoreSlim` nicht für einen rein synchronen schnellen Pfad, nur weil Sie schon eines im Geltungsbereich haben.

## Wann Sie Monitor explizit wählen sollten

Fast nie, mit einer echten Ausnahme: Sie brauchen eine Bedingungsvariable.

`Monitor.Wait`, `Monitor.Pulse` und `Monitor.PulseAll` erlauben es einem Thread, die Sperre freizugeben, zu schlafen, bis ein anderer Thread eine Zustandsänderung signalisiert, und beim Aufwachen erneut zu erwerben. Das ist das klassische Koordinations-Primitiv für beschränkte Puffer / Erzeuger-Verbraucher. Kein anderer Typ in diesem Vergleich stellt es bereit. `System.Threading.Lock` hat es bewusst weggelassen; `SemaphoreSlim` hatte es nie.

```csharp
// .NET 11, C# 14 -- the one job only Monitor can do: condition variables
public sealed class BoundedBuffer<T>
{
    private readonly object _gate = new();
    private readonly Queue<T> _items = new();
    private readonly int _capacity;

    public BoundedBuffer(int capacity) => _capacity = capacity;

    public void Add(T item)
    {
        lock (_gate)
        {
            while (_items.Count == _capacity)
                Monitor.Wait(_gate);     // release + sleep until pulsed

            _items.Enqueue(item);
            Monitor.PulseAll(_gate);     // wake any waiting consumers
        }
    }

    public T Take()
    {
        lock (_gate)
        {
            while (_items.Count == 0)
                Monitor.Wait(_gate);

            var item = _items.Dequeue();
            Monitor.PulseAll(_gate);
            return item;
        }
    }
}
```

Beachten Sie, dass das Gate hier ein einfaches `object` ist, kein `Lock`: `Monitor.Wait`/`Pulse` arbeiten auf dem Sync-Block eines Objekts und sind auf `System.Threading.Lock` nicht verfügbar. Das ist der Kompromiss. Wenn Sie sich dabei ertappen, dieses Muster 2026 von Grund auf zu schreiben, halten Sie inne und prüfen Sie, ob ein [`Channel<T>` die ganze Sache ersetzen würde](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/). `System.Threading.Channels` gibt Ihnen eine beschränkte, asynchron-freundliche Erzeuger-/Verbraucher-Warteschlange mit eingebautem Backpressure, und Sie fassen `Monitor.Wait` nie wieder an. Der handgebaute beschränkte Puffer ist heute größtenteils von historischem und didaktischem Interesse.

Die andere Stelle, an der Sie `Monitor` direkt aufrufen könnten, ist `Monitor.TryEnter` für einen nicht blockierenden Versuch, aber `System.Threading.Lock` hat ebenfalls `TryEnter`, daher löst sich dieser Grund auf .NET 9+ in Luft auf.

## Der Benchmark: was Lock gegenüber Monitor tatsächlich einspart

Die Leistungsaussage lautet konkret, dass `System.Threading.Lock` schneller ist als das `Monitor`-gestützte `lock (object)`, sowohl für den unkonkurrierten schnellen Pfad als auch für den konkurrierten Pfad. Stephen Toubs Artikel [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) misst dies mit BenchmarkDotNet. Der unkonkurrierte Erwerb kollabiert zu einem einzigen verschränkten Compare-Exchange plus einer Barriere; der konkurrierte Erwerb ist rund 2-3x schneller als der `Monitor.Enter`-Pfad, weil `Monitor` vor seiner Barriere mehrere bedingte Verzweigungen durchläuft.

Was die synthetischen Zahlen nicht verraten, ist, wie wenig das in einem realen Dienst zählt, denn reale Dienste verbringen fast keine ihrer Wanduhr-Zeit innerhalb von `lock`. Die messbaren Gewinne in der Produktion sind struktureller Natur, nicht beim Durchsatz:

- **Working Set.** Jedes Gate geht von "einem `object` plus einem Sync-Block bei Konkurrenz" über zu "einem `Lock`, ungefähr objektgroß plus ein paar Bytes Zustand". Bei Tausenden von Gates hört die Sync-Block-Tabelle auf, unter Last zu wachsen.
- **GC-Traversierung.** Das `Lock` ist weiterhin ein Referenztyp, den der GC verfolgt, aber es inflationiert nie eine separate prozessweite Tabelle, die der GC durchlaufen müsste.

Was sich zwischen `Monitor` und `Lock` *nicht* ändert: der Durchsatz des geschützten Abschnitts selbst, die Fairness (beide sind unfair mit leichter Anti-Aushungerung) und das Rekursionsverhalten (beide sind im selben Thread wiedereintrittsfähig).

`SemaphoreSlim` spielt in einer völlig anderen Liga und der Vergleich ist nicht eins zu eins: Ein `WaitAsync`, das synchron abschließt, ist immer noch deutlich teurer als ein `Lock.EnterScope`, und eines, das asynchron abschließt, allokiert und macht einen Umweg über den Thread-Pool. Sie wählen `SemaphoreSlim` nicht wegen der Geschwindigkeit. Sie wählen es, weil es die einzige korrekte Option über ein `await` hinweg ist, und Korrektheit schlägt die Zyklenzahl jedes Mal.

## Der Stolperstein, der für Sie entscheidet

Drei Einschränkungen überstimmen die Vorliebe vollständig:

**Ein `await` im kritischen Abschnitt erzwingt `SemaphoreSlim`.** Das ist keine Stilfrage. `lock`, `Monitor` und `Lock` verfolgen den Besitz über den verwalteten Thread, und ein `await` kann auf einem anderen Thread fortsetzen, was die Sperre vom falschen Besitzer freigeben würde. Der C#-Compiler verweigert `await` innerhalb von `lock` mit [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996). Die hinterhältige Variante ist `using (_gate.EnterScope())` um ein `await`: Das kompiliert vielleicht, wirft aber zur Laufzeit `SynchronizationLockException`, wenn die Fortsetzung versucht, den Scope auf einem Thread zu verwerfen, der nie eingetreten ist. Wenn der Rumpf wartet, sind Sie bei `SemaphoreSlim`. Punkt. Dasselbe Argument steckt hinter [dem Grund, warum async void und async Task sich so unterschiedlich verhalten](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) unter der Haube.

**Bedingungsvariablen erzwingen `Monitor`.** Wenn Ihre Koordination wirklich die Semantik "schlafen, bis signalisiert" braucht und ein `Channel<T>` nicht passt, schaffen das nur `Monitor.Wait` / `Pulse`.

**Ein Ziel vor .NET 9 schließt `Lock` aus.** Wenn Ihre Bibliothek mehrere Ziele einschließlich `netstandard2.0` adressiert, existiert `System.Threading.Lock` auf dieser Seite nicht. Schützen Sie es mit `#if NET9_0_OR_GREATER` und behalten Sie ein `object`-Gate auf dem älteren Pfad. Leiten Sie den Typ `Lock` nicht aus einem Polyfill weiter; die Semantik wird vom echten Typ abweichen.

## Die Empfehlung, erneut formuliert

Nutzen Sie standardmäßig `System.Threading.Lock` für synchronen gegenseitigen Ausschluss auf .NET 9+, und schreiben Sie es über das Schlüsselwort `lock`, damit der Compiler das `try` / `finally` für Sie verwaltet. Steigen Sie nur dann auf ein einfaches `object`-Gate ab, wenn Sie eine Laufzeit vor .NET 9 adressieren müssen, wo `lock (object)` Ihnen identische Semantik zu etwas höheren Kosten liefert. Wechseln Sie in dem Moment zu `SemaphoreSlim(1, 1)`, in dem der geschützte Bereich ein `await` enthält, und nutzen Sie `SemaphoreSlim(N, N)`, wenn Sie die Nebenläufigkeit über eins begrenzen wollen. Fassen Sie `Monitor` nur für `Wait` / `Pulse`-Bedingungsvariablen direkt an, und fragen Sie zuerst, ob ein `Channel<T>` die gesamte handgebaute Koordination verschwinden lässt. Die kürzeste korrekte Entscheidung: synchron und kurz bedeutet `Lock`; asynchron bedeutet `SemaphoreSlim`; Signalisierung bedeutet `Monitor`.

## Verwandt

- [Wie man den neuen Typ System.Threading.Lock in .NET 11 nutzt](/de/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) ist die tiefgehende Betrachtung zur Migration auf und Nutzung des neuen Typs.
- [.NET 9: Das Ende von lock(object)](/de/2026/01/net-9-the-end-of-lockobject/) ist die ursprüngliche Einführung im Nachrichtenformat zu `System.Threading.Lock`.
- [Wie man Channels statt BlockingCollection in C# nutzt](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) zeigt das Erzeuger-/Verbraucher-Muster, das die handgebaute `Monitor.Wait`-Koordination ersetzt.
- [async void vs async Task in C#: wann welches korrekt ist](/de/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) erklärt das Thread-Fortsetzungsverhalten hinter der Regel, kein await in einem lock zu verwenden.
- [Wie man eine langlaufende Task in C# ohne Deadlocks abbricht](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) passt zu den abbrechbaren `WaitAsync`-Überladungen.

## Quellenlinks

- [API-Referenz zu `System.Threading.Lock`](https://learn.microsoft.com/dotnet/api/system.threading.lock) auf Microsoft Learn.
- [Klassenreferenz zu `SemaphoreSlim`](https://learn.microsoft.com/dotnet/api/system.threading.semaphoreslim) auf Microsoft Learn, einschließlich des Hinweises zur Thread-Identität.
- [Klassenreferenz zu `Monitor`](https://learn.microsoft.com/dotnet/api/system.threading.monitor), die `Wait`, `Pulse` und `PulseAll` abdeckt.
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) von Stephen Toub, mit den `Lock`-vs-`Monitor`-Mikrobenchmarks.
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812), der Vorschlag, der `System.Threading.Lock` einführte.
