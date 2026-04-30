---
title: "So nutzen Sie den neuen System.Threading.Lock-Typ in .NET 11"
description: "System.Threading.Lock kam mit .NET 9 und ist die Standard-Synchronisationsprimitive in .NET 11 und C# 14. Diese Anleitung zeigt die Migration von lock(object), wie EnterScope funktioniert und die Stolperfallen rund um await, dynamic und Downlevel-Targets."
pubDate: 2026-04-30
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
template: "how-to"
lang: "de"
translationOf: "2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-30
---

Die Kurzfassung: Ersetzen Sie `private readonly object _gate = new();` durch `private readonly Lock _gate = new();`, lassen Sie jede `lock (_gate) { ... }`-Anweisung exakt unverändert und überlassen Sie es dem C#-14-Compiler, das `lock`-Schlüsselwort an `Lock.EnterScope()` statt an `Monitor.Enter` zu binden. Auf .NET 11 ist das Ergebnis ein kleineres Objekt, keine Sync-Block-Inflation und ein messbarer Durchsatzgewinn auf umkämpften Fast Paths. Sie müssen nur dort genauer nachdenken, wo ein Block `await` benötigt, das Feld über `dynamic` exponiert wird, ein `using static` für `System.Threading` vorhanden ist oder derselbe Code zusätzlich gegen `netstandard2.0` kompilieren muss.

Diese Anleitung richtet sich an .NET 11 (Preview 4) und C# 14. `System.Threading.Lock` selbst ist ein .NET-9-Typ, daher funktioniert alles hier auf .NET 9, .NET 10 und .NET 11. Die Compiler-Mustererkennung, die bewirkt, dass `lock` an `Lock.EnterScope()` bindet, kam mit C# 13 in .NET 9 und ist in C# 14 unverändert.

## Warum `lock(object)` immer ein Workaround war

Neunzehn Jahre lang war das kanonische C#-Muster für "diese Sektion threadsicher machen" ein privates `object`-Feld plus eine `lock`-Anweisung. Der Compiler übersetzte das in Aufrufe von [`Monitor.Enter`](https://learn.microsoft.com/dotnet/api/system.threading.monitor.enter) und `Monitor.Exit` gegen die Identität des Objekts. Der Mechanismus funktionierte, hatte aber drei strukturelle Kosten.

Erstens zahlt jede gesperrte Region für ein Object-Header-Wort. Referenztypen auf dem verwalteten CLR-Heap tragen einen `ObjHeader` plus einen `MethodTable*`, zusammen 16 Bytes auf x64, allein um zu existieren. Das `object`, das Sie zum Sperren allokieren, hat keinen anderen Zweck als Identität. Es trägt nichts zu Ihrem Domänenmodell bei und der GC muss es trotzdem nachverfolgen.

Zweitens bläht die Laufzeit den Header in einen [SyncBlock](https://github.com/dotnet/runtime/blob/main/docs/design/coreclr/botr/sync-block-table.md) auf, sobald zwei Threads um den Lock konkurrieren. Die SyncBlock-Tabelle ist eine prozessweite Tabelle von `SyncBlock`-Einträgen, jeder bei Bedarf allokiert und nie freigegeben, bevor der Prozess endet. Ein lang laufender Dienst, der auf Millionen unterschiedlichen Objekten sperrt, endet mit einer SyncBlock-Tabelle, die monoton wächst. Das war selten, aber real, und nur mit `dotnet-dump` und `!syncblk` diagnostizierbar.

Drittens ist `Monitor.Enter` rekursiv (derselbe Thread kann zweimal eintreten und gibt erst frei, wenn die Exit-Zähler übereinstimmen) und unterstützt `Monitor.Wait` / `Pulse` / `PulseAll`. Der meiste Code braucht nichts davon. Er braucht gegenseitigen Ausschluss. Sie zahlten für Funktionen, die Sie nie benutzten.

`System.Threading.Lock` ist der Typ, den Microsoft 2002 ausgeliefert hätte, wenn `Monitor` nicht zusätzlich als Implementierung hinter `lock` hätte dienen müssen. Der Vorschlag, der ihn einführte ([dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812), 2024 angenommen), beschreibt ihn als "ein schnellerer Lock mit kleinerem Footprint und klarerer Semantik". Es ist ein versiegelter Referenztyp, der nur das exponiert, was gegenseitiger Ausschluss benötigt: eintreten, versuchen einzutreten, austreten und prüfen, ob der aktuelle Thread den Lock hält. Kein `Wait`. Kein `Pulse`. Keine Object-Header-Magie.

## Die mechanische Migration

Nehmen Sie einen typischen Legacy-Cache:

```csharp
// .NET Framework 4.x / .NET 8, C# 12 -- the old shape
public class LegacyCache
{
    private readonly object _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

Migrieren Sie ihn auf .NET 11, indem Sie genau eine Zeile ändern:

```csharp
// .NET 11, C# 14 -- the new shape, single-line diff
public class ModernCache
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, byte[]> _store = new();

    public byte[]? Get(string key)
    {
        lock (_gate)
        {
            return _store.TryGetValue(key, out var v) ? v : null;
        }
    }

    public void Set(string key, byte[] value)
    {
        lock (_gate)
        {
            _store[key] = value;
        }
    }
}
```

Der Rumpf jeder `lock`-Anweisung bleibt unverändert. Der Compiler sieht, dass `_gate` ein `Lock` ist, und übersetzt `lock (_gate) { body }` zu:

```csharp
// What the compiler emits, simplified
using (_gate.EnterScope())
{
    // body
}
```

`EnterScope()` gibt einen `Lock.Scope`-Struct zurück, dessen `Dispose()` den Lock freigibt. Da `Scope` ein `ref struct` ist, kann er nicht geboxt, von einem Iterator erfasst, von einer async-Methode erfasst oder in einem Feld gespeichert werden. Diese letzte Einschränkung macht den neuen Lock günstig: keine Allokation, kein virtueller Dispatch, nur ein Stack-lokaler Handle.

Wenn Sie die Reihenfolge umkehren (`Lock _gate`, aber irgendein Tool ruft anderswo `Monitor.Enter(_gate)` auf), gibt der C#-Compiler ab C# 13 CS9216 aus: "A value of type `System.Threading.Lock` converted to a different type will use likely unintended monitor-based locking in `lock` statement". Die Konvertierung ist erlaubt (ein `Lock` ist immer noch ein `object`), aber der Compiler warnt, weil Sie damit jeden Vorteil des neuen Typs weggeworfen haben.

## Was `EnterScope` tatsächlich zurückgibt

Sie können den neuen Typ ohne das `lock`-Schlüsselwort nutzen, wenn nötig:

```csharp
// .NET 11, C# 14
public byte[] GetOrCompute(string key, Func<string, byte[]> factory)
{
    using (_gate.EnterScope())
    {
        if (_store.TryGetValue(key, out var existing))
            return existing;

        var fresh = factory(key);
        _store[key] = fresh;
        return fresh;
    }
}
```

`EnterScope()` blockiert, bis der Lock erworben ist. Es gibt auch `TryEnter()` (gibt ein `bool` zurück, ohne `Scope`) und `TryEnter(TimeSpan)` für zeitlich begrenztes Erwerben. Wenn Sie `TryEnter` aufrufen und es `true` zurückgibt, müssen Sie `Exit()` selbst aufrufen, genau einmal, auf demselben Thread. Wird `Exit` ausgelassen, ist der Lock geleakt; der nächste Erwerber blockiert für immer.

```csharp
// .NET 11, C# 14 -- TryEnter idiom for non-blocking back-pressure
if (_gate.TryEnter())
{
    try
    {
        DoWork();
    }
    finally
    {
        _gate.Exit();
    }
}
else
{
    // back off, reschedule, drop the message, etc.
}
```

`Lock.IsHeldByCurrentThread` ist eine `bool`-Eigenschaft, die nur dann `true` zurückgibt, wenn der aufrufende Thread den Lock aktuell hält. Sie ist für `Debug.Assert`-Aufrufe in Invarianten gedacht; nutzen Sie sie nicht als Steuerflussmechanismus. Sie ist `O(1)`, hat aber Acquire-Release-Semantik, also kostet Sie ein Aufruf in einer heißen Schleife.

## Die await-Falle, jetzt schlimmer

Sie konnten bei `Monitor` nie innerhalb einer `lock`-Anweisung `await` verwenden. Der Compiler verweigerte das direkt mit [CS1996](https://learn.microsoft.com/dotnet/csharp/misc/cs1996): "Cannot await in the body of a lock statement". Der Grund ist, dass `Monitor` Ownership über die verwaltete Thread-ID verfolgt, sodass das Fortsetzen eines `await` auf einem anderen Thread den Lock vom falschen Besitzer freigeben würde.

`Lock` hat dieselbe Einschränkung, und der Compiler erzwingt sie auf dieselbe Weise. Versuchen Sie das:

```csharp
// .NET 11, C# 14 -- DOES NOT COMPILE
public async Task DoIt()
{
    lock (_gate)
    {
        await Task.Delay(100); // CS1996
    }
}
```

Sie erhalten wieder `CS1996`. Gut. Die größere Falle ist `using (_gate.EnterScope())`, weil der Compiler nicht weiß, dass der `Scope` von einem `Lock` stammt. Mit .NET 11 SDK 11.0.100-preview.4 kompiliert dieser Code:

```csharp
// .NET 11, C# 14 -- COMPILES, but is broken at runtime
public async Task Broken()
{
    using (_gate.EnterScope())
    {
        await Task.Delay(100);
        // Resumes on a thread-pool thread, which does NOT hold _gate.
        // Disposing the Scope here calls Lock.Exit on a thread that
        // never entered, throwing SynchronizationLockException.
    }
}
```

Der Fix ist derselbe wie immer: Heben Sie den Lock so weit, dass er nur den synchronen kritischen Abschnitt umschließt, und verwenden Sie `SemaphoreSlim` (das async-fähig ist), wenn Sie wirklich gegenseitigen Ausschluss über ein `await` hinweg brauchen. `Lock` ist eine schnelle synchrone Primitive. Sie ist kein async-Lock und versucht auch keiner zu sein.

## Performance: was sich tatsächlich geändert hat

Die Release Notes von .NET 9 behaupten, dass das Erwerben mit Konkurrenz etwa 2-3x schneller ist als der entsprechende `Monitor.Enter`-Pfad und dass das Erwerben ohne Konkurrenz von einem einzigen interlocked Compare-Exchange dominiert wird. Stephen Toubs Beitrag [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) enthält Mikrobenchmarks, die genau das zeigen, und sie reproduzieren sich auf .NET 11.

Die Einsparung, die Sie in Ihrem eigenen Dienst messen können, ist kleiner als die synthetischen Zahlen vermuten lassen, weil reale Dienste selten den Großteil ihrer Zeit innerhalb eines `lock` verbringen. Die Stellen, an denen Sie einen Unterschied sehen werden:

- **Working Set**: Jedes Gate geht von "ein `object` plus Sync Block bei Konkurrenz" zu "ein `Lock`, ungefähr `object`-Größe plus 8 Bytes Zustand". Wenn Sie tausende Gates haben (eines pro Cache-Eintrag etwa), wächst die Sync-Block-Tabelle nicht mehr unter Konkurrenz.
- **GC2-Traversierung**: Der `Lock` ist immer noch ein Referenztyp, bläht aber nie eine externe Tabelle auf, die der GC separat durchlaufen muss.
- **Fast Path bei Konkurrenz**: Der neue Fast Path ist ein einzelnes `CMPXCHG` plus eine Memory Fence. Der alte Pfad ging über `Monitor`, der vor der Fence mehrere bedingte Verzweigungen ausführt.

Was sich nicht ändert: der Durchsatz des geschützten Abschnitts selbst, Fairness (der neue `Lock` ist auch unfair, mit einer dünnen Schicht Starvation-Prevention darüber) und Rekursion (`Lock` ist auf demselben Thread rekursiv, identisch zu `Monitor`).

## Stolperfallen, die Sie treffen werden

**`using static System.Threading;`** -- wenn irgendeine Datei in Ihrem Projekt das tut, wird der unqualifizierte Name `Lock` mehrdeutig mit jeder eigenen `Lock`-Klasse. Der Fix ist, das `using static` zu entfernen oder den Typ explizit zu qualifizieren: `System.Threading.Lock`. Der Compiler meldet [CS0104](https://learn.microsoft.com/dotnet/csharp/misc/cs0104), aber der Fehlerort liegt dort, wo Sie `Lock` verwenden, nicht dort, wo der Konflikt eingeführt wurde.

**`dynamic`** -- eine `lock`-Anweisung auf einem `dynamic`-typisierten Ausdruck kann nicht zu `Lock.EnterScope()` aufgelöst werden, weil das Binding zur Laufzeit passiert. Der Compiler gibt CS9216 aus und fällt auf `Monitor` zurück. Wenn Sie eine dieser seltenen `dynamic`-Codebasen haben, casten Sie vor dem `lock` zu `Lock`:

```csharp
// .NET 11, C# 14
dynamic d = GetGate();
lock ((Lock)d) { /* ... */ } // cast is required
```

**Boxing in `object`** -- da `Lock` von `object` erbt, können Sie ihn an jede API übergeben, die `object` annimmt, einschließlich `Monitor.Enter`. Das hebt den neuen Pfad auf. CS9216 ist Ihr Freund; machen Sie ihn in `Directory.Build.props` zum Fehler:

```xml
<PropertyGroup>
  <WarningsAsErrors>$(WarningsAsErrors);CS9216</WarningsAsErrors>
</PropertyGroup>
```

**`netstandard2.0`-Bibliotheken** -- wenn Ihre Bibliothek `netstandard2.0` und `net11.0` als Multi-Target hat, existiert `Lock` auf der `netstandard2.0`-Seite nicht. Sie haben zwei Optionen. Die saubere ist, ein `object`-Feld auf `netstandard2.0` und ein `Lock`-Feld auf `net11.0` zu behalten, geschützt durch `#if NET9_0_OR_GREATER`:

```csharp
// .NET 11, C# 14 -- multi-target gate
#if NET9_0_OR_GREATER
private readonly System.Threading.Lock _gate = new();
#else
private readonly object _gate = new();
#endif
```

Die schmutzige ist, `Lock` aus einem Polyfill-Paket per Type-Forwarding einzubringen; tun Sie das nicht, das endet in Tränen, sobald das Polyfill von der Semantik des echten Typs abweicht.

**WPF- und WinForms-`Dispatcher`** -- die interne Warteschlange des Dispatchers nutzt weiterhin `Monitor`. Sie können dessen Lock nicht ersetzen. Die Locks Ihrer Anwendung können sich bewegen; die des Frameworks nicht.

**Source Generator, die `lock(object)` emittieren** -- regenerieren Sie sie. CommunityToolkit.Mvvm 9 und mehrere andere sind Ende 2024 auf `Lock` umgestiegen. Prüfen Sie die generierte Datei auf `private readonly object`; wenn es noch da ist, aktualisieren Sie das Paket.

## Wann Sie `Lock` nicht verwenden sollten

Verwenden Sie `Lock` (oder einen anderen kurzlebigen Mutex) nicht, wenn die Antwort "gar kein Lock" lautet. `ConcurrentDictionary<TKey, TValue>` braucht kein externes Gate. `ImmutableArray.Builder` ebenfalls nicht. `Channel<T>` auch nicht. Die schnellste Synchronisation ist die, die Sie nicht schreiben.

Verwenden Sie `Lock` nicht, wenn der geschützte Abschnitt über ein `await` hinweg geht. Verwenden Sie `SemaphoreSlim(1, 1)` und `await semaphore.WaitAsync()`. Der Overhead pro Erwerb ist höher, aber das ist die einzig korrekte Option.

Verwenden Sie `Lock` nicht für prozessübergreifende oder maschinenübergreifende Koordination. Er funktioniert nur innerhalb eines Prozesses. Verwenden Sie dafür [`Mutex`](https://learn.microsoft.com/dotnet/api/system.threading.mutex) (benannt, kernel-gestützt), einen Datenbank-Row-Lock oder Redis `SETNX`.

## Verwandt

- [So nutzen Sie Channels statt BlockingCollection in C#](/de/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) behandelt das Producer/Consumer-Muster, das Locks oft komplett ersetzt.
- [So brechen Sie eine lang laufende Task in C# ohne Deadlock ab](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) ist die Cancellation-Ergänzung zu diesem Beitrag.
- [.NET 9: Das Ende von lock(object)](/2026/01/net-9-the-end-of-lockobject/) ist die News-artige Einführung in den Typ, geschrieben zur Veröffentlichung von .NET 9.
- [So schreiben Sie einen Source Generator für INotifyPropertyChanged](/de/2026/04/how-to-write-a-source-generator-for-inotifypropertychanged/) zeigt die Art von Generator, die Sie eventuell für `Lock`-Unterstützung aktualisieren müssen.

## Quellen

- [`System.Threading.Lock`-API-Referenz](https://learn.microsoft.com/dotnet/api/system.threading.lock) auf Microsoft Learn.
- [dotnet/runtime#34812](https://github.com/dotnet/runtime/issues/34812) -- Vorschlag und Design-Diskussion.
- [Performance Improvements in .NET 9](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-9/#system-threading) von Stephen Toub.
- [Was ist neu in C# 13](https://learn.microsoft.com/dotnet/csharp/whats-new/csharp-13) behandelt die Compiler-Mustererkennung.
