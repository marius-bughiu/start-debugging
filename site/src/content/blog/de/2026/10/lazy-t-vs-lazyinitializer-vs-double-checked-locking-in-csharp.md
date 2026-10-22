---
title: "Lazy<T> vs LazyInitializer.EnsureInitialized vs Double-Checked Locking in C#"
description: "Verwenden Sie standardmäßig Lazy<T>: Es führt die Factory genau einmal aus, speichert Ausnahmen zwischen, und seine Lesezugriffe sind nach der Initialisierung zu billig, um messbar zu sein. Nutzen Sie LazyInitializer.EnsureInitialized, wenn Sie viele Felder oder Array-Elemente lazy befüllen und sich ein zusätzliches Objekt pro Wert nicht leisten können. Handgeschriebenes Double-Checked Locking lohnt sich unter .NET 10 fast nie."
pubDate: 2026-10-22
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
lang: "de"
translationOf: "2026/10/lazy-t-vs-lazyinitializer-vs-double-checked-locking-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-22
---

Verwenden Sie standardmäßig `Lazy<T>`. Mit dem Standardmodus des Konstruktors (`ExecutionAndPublication`) garantiert es, dass die Factory selbst bei Konkurrenz genau einmal läuft, es speichert die Ausnahme der Factory zwischen, und sobald der Wert existiert, besteht ein Lesezugriff aus einer Null-Prüfung und einem Feldzugriff, zu billig, als dass BenchmarkDotNet ihn messen könnte. Greifen Sie zu `LazyInitializer.EnsureInitialized`, wenn Sie viele lazy erzeugte Werte haben (ein Feld pro Eigenschaft in einem häufig instanziierten Typ oder Elemente in einem Array) und das zusätzliche `Lazy<T>`-Objekt pro Wert genau die Kosten sind, die Sie vermeiden wollen. Handgeschriebenes Double-Checked Locking bietet Ihnen nichts, was `LazyInitializer.EnsureInitialized(ref field, ref syncLock, factory)` nicht ohnehin bietet. Schreiben Sie es also nur, wenn Sie ein Verhalten brauchen, das keine der beiden APIs liefert.

Alles Folgende wurde auf .NET 10.0.10 (SDK 10.0.302), C# 14, BenchmarkDotNet 0.15.8 auf einem Apple M4 (arm64) gemessen. Die APIs haben seit .NET Core 3.0 ihre Form nicht geändert, daher gilt die Empfehlung für .NET 8, 9, 10 und 11.

## Der Vergleich auf einen Blick

| | `Lazy<T>` (Standard) | `LazyInitializer.EnsureInitialized(ref t, f)` | `EnsureInitialized(ref t, ref sync, f)` | Double-Checked Locking |
| --- | --- | --- | --- | --- |
| Factory läuft bei Konkurrenz höchstens einmal | Ja | Nein, jeder konkurrierende Thread kann sie ausführen | Ja | Ja, wenn korrekt geschrieben |
| Ausnahme aus der Factory | Zwischengespeichert, wird immer wieder geworfen | Nicht zwischengespeichert, der nächste Aufruf versucht es erneut | Nicht zwischengespeichert, der nächste Aufruf versucht es erneut | Je nach Ihrer Implementierung |
| Zusätzliche Allokation pro Lazy-Wert | `Lazy<T>`-Objekt plus Lock-Helfer | Keine | Ein Lock-Objekt, nur bei Konkurrenz oder beim ersten Aufruf | Ein Lock-Objekt (oder geteilt) |
| Heißer Lesezugriff nach Init (gemessen) | unter 1 ns, nicht messbar | unter 1 ns | unter 1 ns | unter 1 ns |
| Einmaliges Erzeugen + Init (gemessen) | 13,96 ns, 96 B | 6,19 ns, 48 B | 14,03 ns, 80 B | 8,96 ns, 72 B |
| Funktioniert mit Werttypen | Ja | Nein (`where T : class`) | Nein, nutzen Sie die Überladung mit `ref bool initialized` | Ja, mit separatem Flag |
| Factory darf `null` zurückgeben | Ja | Nein, wirft `InvalidOperationException` | Nein, wirft `InvalidOperationException` | Ja, mit separatem Flag |
| Reentranz aus der Factory | Wirft `InvalidOperationException` | Stack Overflow | Stack Overflow (`Monitor` ist reentrant) | Hängt vom Lock-Typ ab |
| Code, den Sie selbst pflegen | 1 Zeile | 1 Zeile | 2 Felder + 1 Aufruf | ca. 10 Zeilen |

## Was jede Option tatsächlich tut

### `Lazy<T>`

`Lazy<T>` umhüllt eine Factory und einen Speicherplatz. Seine Eigenschaft `Value` besteht in .NET 10 aus einer Zeile:

```csharp
// System.Private.CoreLib, release/10.0, src/System/Lazy.cs
public T Value => _state == null ? _value! : CreateValue();
```

`_state` ist eine volatile `LazyHelper`-Referenz, die den Modus beschreibt und bei `ExecutionAndPublication` zugleich als Lock-Objekt dient. Der erste Aufruf geht in `CreateValue`, das `lock (executionAndPublication)` nimmt, erneut prüft, Ihre Factory ausführt, `_value` speichert und dann `_state = null` mit einem volatilen Schreibzugriff setzt. Jeder spätere Aufruf sieht `_state == null` und gibt das Feld zurück. Das ist Double-Checked Locking, einmal geschrieben von Leuten, die die Spezifikation des Speichermodells sorgfältiger gelesen haben als die meisten von uns.

Der Thread-Sicherheitsmodus wird über den Konstruktor gewählt:

```csharp
// .NET 10, C# 14
var a = new Lazy<Config>(LoadConfig);                                          // ExecutionAndPublication
var b = new Lazy<Config>(LoadConfig, isThreadSafe: true);                      // ExecutionAndPublication
var c = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.PublicationOnly);    // threads race, first publish wins
var d = new Lazy<Config>(LoadConfig, LazyThreadSafetyMode.None);               // single-threaded only
```

### `LazyInitializer.EnsureInitialized`

`LazyInitializer` ist eine statische Klasse, die über einen `ref` auf einem Feld arbeitet, das Ihnen gehört. Es gibt kein Wrapper-Objekt. Die Überladung mit zwei Argumenten lautet vollständig:

```csharp
// System.Private.CoreLib, release/10.0, src/System/Threading/LazyInitializer.cs
public static T EnsureInitialized<T>(ref T? target, Func<T> valueFactory) where T : class =>
    Volatile.Read(ref target!) ?? EnsureInitializedCore(ref target, valueFactory);

private static T EnsureInitializedCore<T>(ref T? target, Func<T> valueFactory) where T : class
{
    T value = valueFactory() ?? throw new InvalidOperationException(SR.Lazy_StaticInit_InvalidOperation);
    Interlocked.CompareExchange(ref target, value, null!);
    return target;
}
```

Kein Lock. Jeder Thread, der `null` sieht, führt die Factory aus, und `CompareExchange` entscheidet, dessen Ergebnis gespeichert wird. Die Objekte der Verlierer werden einfach verworfen (und die Dokumentation weist darauf hin, dass die Methode "will not dispose of the objects that were not stored"). Das sind `PublicationOnly`-Semantik ohne den Wrapper.

Die Überladung mit drei Argumenten, `EnsureInitialized(ref target, ref syncLock, valueFactory)`, fügt ein Lock hinzu. Sie erzeugt per `CompareExchange` lazy ein einfaches `object` in `syncLock` und führt dann `lock (syncLock) { if (Volatile.Read(ref target) == null) Volatile.Write(ref target, valueFactory()); }` aus. Das ist Double-Checked Locking im Lehrbuchstil, und die Factory läuft einmal.

Für Werttypen oder wenn `null` ein legitimes Ergebnis ist, gibt es Überladungen mit einem zusätzlichen Flag `ref bool initialized`. Sie nehmen immer den Lock-Pfad.

### Handgeschriebenes Double-Checked Locking

Die korrekte moderne Variante ab .NET 9 mit dem Typ `System.Threading.Lock`:

```csharp
// .NET 10, C# 14
public sealed class ReportCache
{
    private volatile Report? _report;
    private readonly Lock _lock = new();

    public Report Report
    {
        get
        {
            var r = _report;               // one volatile read on the fast path
            if (r is not null) return r;
            lock (_lock)
            {
                return _report ??= BuildReport();
            }
        }
    }

    private static Report BuildReport() => new();
}

public sealed class Report;
```

Das `volatile` leistet echte Arbeit. Die Spezifikation des .NET-Speichermodells (`docs/design/specs/Memory-model.md` in dotnet/runtime) besagt zwar, dass das Speichern einer Objektreferenz in gemeinsamen Speicher ein Release ist und datenabhängige Lesezugriffe darüber geordnet sind, sodass der klassische Fehler mit dem "halb konstruierten Objekt" auf CoreCLR nicht auftreten kann. Sie warnt aber auch ausdrücklich davor, die Ordnungs-Nebeneffekte der Referenzzuweisung für allgemeine Ordnungszwecke zu verwenden, und ein nicht-volatiles Feld erlaubt dem JIT, Lesezugriffe auf `_report` herauszuziehen oder zusammenzulegen. Markieren Sie es als `volatile` oder lesen Sie es mit `Volatile.Read`, und das Muster ist auf jeder Architektur korrekt, auf der .NET läuft.

## Das Verhalten bei Konkurrenz belegen

Die Dokumentation sagt "may run more than once". Ich wollte eine Zahl. Diese Probe startet 16 Threads an einer `Barrier`, lässt alle gleichzeitig auf den Lazy-Wert zugreifen, nutzt eine Factory, die etwa 20.000 Iterationen lang wartet, um das Race-Fenster zu vergrößern, und wiederholt das 200-mal, wobei die schlechteste Runde festgehalten wird:

```csharp
// .NET 10.0.10, C# 14, Apple M4, 10 cores
static int Race(Func<Func<object>, Func<object>> makeAccessor)
{
    int maxCalls = 0;
    for (int r = 0; r < 200; r++)
    {
        int calls = 0;
        Func<object> factory = () =>
        {
            Interlocked.Increment(ref calls);
            Thread.SpinWait(20_000);
            return new object();
        };
        var access = makeAccessor(factory);
        using var barrier = new Barrier(16);
        var results = new object[16];
        var threads = Enumerable.Range(0, 16)
            .Select(i => new Thread(() => { barrier.SignalAndWait(); results[i] = access(); }))
            .ToArray();
        foreach (var t in threads) t.Start();
        foreach (var t in threads) t.Join();
        if (results.Distinct().Count() != 1) throw new Exception("different instances returned");
        maxCalls = Math.Max(maxCalls, calls);
    }
    return maxCalls;
}
```

Ergebnisse, schlechteste Runde von 200:

| Option | Max. Factory-Aufrufe in einer Runde |
| --- | --- |
| `Lazy<T>` Standard (`ExecutionAndPublication`) | 1 |
| `Lazy<T>` `PublicationOnly` | 11 |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 12 |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 1 |

Jede Option lieferte in jeder Runde dieselbe Instanz an alle 16 Threads, keine davon ist also "unsicher". Der Unterschied ist verschwendete Arbeit. Wenn Ihre Factory einen Socket öffnet, eine 40 MB große Datei liest oder eine kostenpflichtige API aufruft, sind 12 parallele Ausführungen ein echter Fehler, auch wenn der veröffentlichte Wert korrekt ist.

## Die Falle beim Zwischenspeichern von Ausnahmen

Das ist der Verhaltensunterschied, der in Produktion zuschlägt. Dieselbe Factory, die beim ersten Aufruf fehlschlägt und beim zweiten gelingt:

```csharp
// .NET 10.0.10, C# 14
int attempts = 0;
Func<string> flaky = () => ++attempts == 1 ? throw new InvalidOperationException("transient") : "ok";

var lazy = new Lazy<string>(flaky);
// lazy.Value -> InvalidOperationException: transient
// lazy.Value -> InvalidOperationException: transient   (factory not called again)

string? field = null;
// LazyInitializer.EnsureInitialized(ref field, flaky) -> InvalidOperationException: transient
// LazyInitializer.EnsureInitialized(ref field, flaky) -> "ok"
```

Die Probe bestätigte es: Das Standard-`Lazy<T>` rief die Factory einmal auf und warf danach bei jedem Zugriff dieselbe Ausnahme. `PublicationOnly` und `LazyInitializer` riefen sie zweimal auf und erholten sich.

Die Ausnahmetabelle von MS Learn nennt die Regel: Jeder `Lazy<T>`-Konstruktor, der eine `valueFactory` entgegennimmt, speichert Ausnahmen zwischen, außer der Modus ist `PublicationOnly`. Der parameterlose Konstruktor (der `Activator.CreateInstance` verwendet) tut das nicht. Ein `Lazy<HttpClient>`, dessen Factory einen beim Start fehlenden Konfigurationswert liest, wirft also für die gesamte Lebensdauer des Prozesses, selbst wenn die Konfiguration später auftaucht. Wenn der Fehler vorübergehend sein kann, verwenden Sie entweder `PublicationOnly`, verwenden Sie `LazyInitializer`, oder ersetzen Sie die `Lazy<T>`-Instanz in einem `catch`.

Dieselbe Falle ist bei `Lazy<Task<T>>` doppelt tückisch: Die Factory wirft nicht, sondern liefert einen fehlgeschlagenen `Task`, und dieser fehlgeschlagene Task wird in jedem Modus als erfolgreicher Wert zwischengespeichert. Wenn Sie asynchrone Arbeit zwischenspeichern, prüfen Sie `IsFaulted` und tauschen Sie die Instanz aus, oder nutzen Sie einen echten Cache.

## Der Benchmark

Zwei Fragen: Was kostet ein Lesezugriff, sobald der Wert existiert, und was kostet jede Option pro Instanz, wenn Sie den Besitzer erzeugen und den Wert einmal anfassen. Methodik: BenchmarkDotNet 0.15.8, Standard-Job, `[MemoryDiagnoser]`, .NET 10.0.10 arm64 RyuJIT, Apple M4, macOS. Jede Holder-Klasse stellt eine Eigenschaft `Value` bereit; `Expensive` ist eine winzige Klasse, sodass die Messung die Lazy-Mechanik erfasst und nicht die Factory. Der vollständige Quelltext sind die Klassen `HotPath` und `ColdPath` unten.

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8
public sealed class LazyHolder
{
    private readonly Lazy<Expensive> _value = new(() => new Expensive());
    public Expensive Value => _value.Value;
}

public sealed class LazyInitHolder
{
    private Expensive? _value;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, static () => new Expensive());
}

public sealed class LazyInitLockHolder
{
    private Expensive? _value;
    private object? _sync;
    public Expensive Value => LazyInitializer.EnsureInitialized(ref _value, ref _sync, static () => new Expensive());
}

[MemoryDiagnoser]
public class ColdPath
{
    [Benchmark(Baseline = true)] public int Plain() => new PlainHolder().Value.Id;
    [Benchmark] public int Lazy_ExecutionAndPublication() => new LazyHolder().Value.Id;
    [Benchmark] public int LazyInitializer_Factory() => new LazyInitHolder().Value.Id;
    [Benchmark] public int LazyInitializer_SyncLock() => new LazyInitLockHolder().Value.Id;
    [Benchmark] public int DoubleChecked_Lock() => new DoubleCheckedHolder().Value.Id;
    [Benchmark] public int Lazy_NeverTouched() => new LazyHolder() is null ? 0 : 1;
}
```

Heißer Pfad (Wert bereits erzeugt, ein Lesezugriff):

| Methode (.NET 10.0.10, arm64) | Mittelwert | Allocated |
| --- | --- | --- |
| Einfaches Feld (`??=`, nicht Thread-sicher) | 0,000 ns | 0 B |
| `Lazy<T>` `ExecutionAndPublication` | 0,000 ns | 0 B |
| `Lazy<T>` `PublicationOnly` | 0,000 ns | 0 B |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 0,495 ns | 0 B |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 0,289 ns | 0 B |
| Double-Checked Locking (`volatile` + `Lock`) | 0,314 ns | 0 B |

Kalter Pfad (Besitzer allokieren, Wert einmal lesen):

| Methode (.NET 10.0.10, arm64) | Mittelwert | Verhältnis | Allocated |
| --- | --- | --- | --- |
| Einfaches Feld (`??=`, nicht Thread-sicher) | 1,53 ns | 1,00 | 24 B |
| `LazyInitializer.EnsureInitialized(ref t, f)` | 6,19 ns | 4,04 | 48 B |
| Double-Checked Locking (`volatile` + `Lock`) | 8,96 ns | 5,85 | 72 B |
| `Lazy<T>` `PublicationOnly` | 9,68 ns | 6,32 | 64 B |
| `Lazy<T>` `ExecutionAndPublication` | 13,96 ns | 9,12 | 96 B |
| `LazyInitializer.EnsureInitialized(ref t, ref sync, f)` | 14,03 ns | 9,16 | 80 B |
| `Lazy<T>` erzeugt, `Value` nie gelesen | 6,17 ns | 4,03 | 72 B |

Der heiße Pfad ist ein Unentschieden. Jede Option liegt unterhalb der Auflösung von BenchmarkDotNet, sobald der Wert existiert: Der Tier-1-JIT inlined `Lazy<T>.Value` zu einer Null-Prüfung auf `_state` und einem Feldzugriff, und BenchmarkDotNet weist es als nicht unterscheidbar von einer leeren Methode aus. Die Werte unter einer Nanosekunde in den anderen Zeilen liegen im Rauschen. Wenn Ihnen jemand rät, `Lazy<T>` "wegen der Lese-Performance" durch handgeschriebenen Code zu ersetzen, zeigt die Messung, dass es nichts zu gewinnen gibt.

Der kalte Pfad ist der Ort, an dem sich die Optionen unterscheiden, und das liegt vor allem an Allokationen. Die `Lazy<T>`-Zeilen erzählen die Geschichte: Ein `Lazy<T>` kostet 72 Byte, bevor es jemand liest (das `Lazy<T>`-Objekt selbst plus der `LazyHelper`, den `ExecutionAndPublication` im Konstruktor allokiert, um darauf zu sperren), und etwa 14 ns, um es einmal zu erzeugen und zu initialisieren. `PublicationOnly` verzichtet auf den Helper und ist daher 8 Byte und 4 ns günstiger. Die lock-freie `LazyInitializer`-Überladung ist mit 6,2 ns die günstigste Thread-sichere Option, weil sie außer dem Wert nichts allokiert. Die Überladung mit `ref syncLock` bezahlt für das Lock-Objekt, das sie beim ersten Aufruf erzeugt, daher liegen ihre einmaligen Kosten neben denen von `Lazy<T>`.

Ein Vorbehalt zur Spalte `Allocated`: Die Escape-Analyse von .NET 10 allokiert Holder-Objekte, die nachweislich nicht entweichen, auf dem Stack, weshalb die einfache Baseline nur 24 Byte zeigt. Lesen Sie die Spalte relativ zur Baseline, nicht als absolute Objektgrößen.

In absoluten Zahlen spielen 8 ns und 48 Byte pro Lazy-Wert nur eine Rolle, wenn Sie Millionen von Besitzern erzeugen. Ein Dienst mit einem `Lazy<T>`-Feld, das einmal beim Start konstruiert wird, bekommt davon nie etwas zu spüren.

## Wann Sie `Lazy<T>` wählen

- **Eine Singleton-artige Abhängigkeit innerhalb einer Klasse**: eine geparste Konfiguration, ein kompiliertes `Regex`, ein aus Optionen gebauter Client. Ein `Lazy<T>`-Feld, eine Zeile, die Factory läuft einmal.
- **Teure Factories oder solche mit Seiteneffekten**: alles, was eine Verbindung öffnet oder eine API aufruft. Der Standardmodus ist die einzige Option ohne Zusatzaufwand, die genau eine Ausführung garantiert.
- **Werttypen oder `null`-Ergebnisse**: `Lazy<int>` und `Lazy<string?>` funktionieren einfach. Die Probe bestätigte, dass `new Lazy<string?>(() => null).Value` `null` mit `IsValueCreated == true` zurückgibt.
- **Sie wollen bei Rekursion einen klaren Fehler**: Eine Factory, die ihr eigenes `Value` anfasst, erhält `InvalidOperationException: ValueFactory attempted to access the Value property of this instance.` statt eines Stack Overflows.

## Wann Sie `LazyInitializer.EnsureInitialized` wählen

- **Viele Lazy-Felder in einem Typ mit vielen Instanzen**: Der `Lazy<T>`-Wrapper ist ein Objekt pro Wert, und er wird auch dann erzeugt, wenn ihn nie jemand liest (72 Byte in der Zeile "nie gelesen" der Tabelle für den kalten Pfad). Das ist der Fall, den die Richtlinie von MS Learn für `LazyInitializer` nennt: Lazy-Initialisierung "without the overhead of a class".
- **Arrays aus lazy gebauten Einträgen**: `LazyInitializer.EnsureInitialized(ref _slots[i], () => Build(i))` funktioniert auf Array-Elementen, weil sie sich per `ref` übergeben lassen. Es gibt kein `Lazy<T>[]`-Äquivalent, das nicht vorab einen Wrapper pro Element allokiert.
- **Billige, reine Factories**: Wenn es nichts kostet, die Factory bei einem Race zweimal auszuführen, ist die lock-freie Überladung mit zwei Argumenten die günstigste korrekte Option.
- **Sie wollen nach einem Fehler erneut versuchen**: Keine Überladung speichert Ausnahmen zwischen.

Verwenden Sie die Überladung mit `ref syncLock`, wenn die Factory einmal laufen muss. Übergeben Sie ein Feld vom Typ `object?`, das mit `null` startet: Es wird erst beim ersten Aufruf allokiert, der den langsamen Pfad erreicht.

## Wann handgeschriebenes Double-Checked Locking noch gerechtfertigt ist

Selten. Zwei Fälle, in denen ich es tatsächlich gebraucht habe:

- **Sie müssen den Wert zurücksetzen oder austauschen**. Weder `Lazy<T>` noch `LazyInitializer` erlaubt es, einen Wert zu invalidieren. Ein Cache, der sich bei einem Signal neu aufbaut, braucht ein eigenes Lock und ein volatiles Feld.
- **Der langsame Pfad braucht mehr als eine Factory**: zwei Felder atomar zu initialisieren oder eine asynchrone API unter einem `SemaphoreSlim` aufzurufen. An diesem Punkt ist es keine Lazy-Initialisierung mehr, sondern eine kleine Zustandsmaschine, und Sie sollten sie explizit schreiben.

Wenn Sie es schreiben, verwenden Sie ab .NET 9 `System.Threading.Lock`, halten Sie das Feld `volatile`, lesen Sie es auf dem schnellen Pfad einmal in eine lokale Variable und sperren Sie niemals auf `this`.

## Der Stolperstein, der für Sie entscheidet

Für **statische** Lazy-Werte brauchen Sie wahrscheinlich keine der drei Optionen. Ein `static readonly`-Feld, das vom Typinitialisierer gesetzt wird, ist lazy (die Runtime führt ihn vor dem ersten Zugriff auf das Feld aus), Thread-sicher und auf dem heißen Pfad kostenlos, weil der Tier-1-JIT `static readonly`-Felder einer bereits initialisierten Klasse als Konstanten behandelt:

```csharp
// .NET 10, C# 14
public static class Pricing
{
    public static readonly FrozenDictionary<string, decimal> Table = LoadTable();
    private static FrozenDictionary<string, decimal> LoadTable() => /* ... */ FrozenDictionary<string, decimal>.Empty;
}
```

Der Haken: Wenn `LoadTable` wirft, ist der Typ für die Lebensdauer des Prozesses defekt, und jeder Zugriff wirft `TypeInitializationException`. Das ist dasselbe Zwischenspeicherverhalten wie bei `Lazy<T>`, nur schwerer zu beheben. Verwenden Sie ein statisches `Lazy<T>`, wenn Sie die Wiederholungssemantik von `PublicationOnly` brauchen oder wenn der Typ weitere statische Member hat, die auch bei fehlgeschlagenem Laden nutzbar bleiben sollen.

## Die Empfehlung noch einmal

Beginnen Sie mit `Lazy<T>` und dem Standardmodus. Es führt die Factory einmal aus, auf dem heißen Pfad ist es eine einzelne Null-Prüfung, und sein einziger echter Nachteil (zwischengespeicherte Ausnahmen) lässt sich mit `PublicationOnly` abwählen. Wechseln Sie zu `LazyInitializer.EnsureInitialized`, wenn das Profiling zeigt, dass die Wrapper-Allokationen ins Gewicht fallen, was in der Praxis viele Instanzen mit jeweils mehreren Lazy-Feldern bedeutet. Verwenden Sie die Überladung mit `ref syncLock`, wenn die Factory einmal laufen muss. Schreiben Sie Double-Checked Locking nur dann selbst, wenn Sie den Wert zurücksetzen oder mehr als eine Sache atomar initialisieren müssen.

## Verwandte Artikel

- Wenn Sie den gesperrten langsamen Pfad selbst schreiben, zeigt [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/de/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/), welches Primitiv Sie wählen sollten.
- Der [Überblick zum Typ System.Threading.Lock](/de/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/) erklärt, warum `lock` auf einem `Lock`-Feld schneller ist als das Sperren auf einem `object`.
- Was `volatile` und `Volatile.Read` auf arm64 tatsächlich erzeugen, steht in [Volatile.Read vs Volatile.ReadBarrier in .NET 10](/de/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/).
- Wenn der Lazy-Wert in Wahrheit ein Cache-Eintrag ist, der ablaufen oder asynchron sein soll, ist [HybridCache vs IMemoryCache vs IDistributedCache](/de/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) das bessere Werkzeug.
- Ein `Lazy<T>` in einem Singleton, das einen Scoped-Dienst einfängt, ist derselbe Captive-Dependency-Fehler, der in [fixing "Cannot consume scoped service from singleton"](/de/2026/05/fix-cannot-consume-scoped-service-from-singleton/) beschrieben wird.

## Quellen

- [Lazy initialization](https://learn.microsoft.com/en-us/dotnet/framework/performance/lazy-initialization) auf MS Learn, einschließlich der Tabelle zum Zwischenspeichern von Ausnahmen.
- [`LazyInitializer.EnsureInitialized`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazyinitializer.ensureinitialized) API-Referenz.
- [`LazyThreadSafetyMode`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.lazythreadsafetymode) API-Referenz.
- [`Lazy.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Lazy.cs) und [`LazyInitializer.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Threading/LazyInitializer.cs) in dotnet/runtime `release/10.0`.
- [.NET memory model spec](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md), Abschnitte "Object assignment" und "Data-dependent reads are ordered".
