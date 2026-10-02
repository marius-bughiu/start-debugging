---
title: "Volatile.Read vs Volatile.ReadBarrier in .NET 10"
description: "Volatile.Read ist ein Acquire-Load einer einzelnen Speicherstelle. Volatile.ReadBarrier, neu in .NET 10, ist ein Fence, der allen früheren Lesezugriffen Acquire-Semantik gibt. Verwenden Sie Volatile.Read für Flags und veröffentlichte Referenzen und ReadBarrier, wenn mehrere einfache oder nicht atomare Lesezugriffe abgeschlossen sein müssen, bevor der nächste Speicherzugriff erfolgt, etwa bei einem Seqlock."
pubDate: 2026-10-02
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "performance"
lang: "de"
translationOf: "2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10"
translatedBy: "claude"
translationDate: 2026-10-02
---

`Volatile.Read(ref x)` liest eine Speicherstelle mit Acquire-Semantik: Nichts, was im Code danach steht, kann vor diesen Lesezugriff wandern. `Volatile.ReadBarrier()`, neu in .NET 10, liest überhaupt nichts. Es ist ein Fence, der **jedem Lesezugriff davor** Acquire-Semantik gibt, sodass ein ganzer Stapel einfacher (auch nicht atomarer) Lesezugriffe abgeschlossen sein muss, bevor ein Speicherzugriff nach der Barriere stattfindet. Verwenden Sie `Volatile.Read` für den Normalfall eines Flags, eines Zählers oder einer veröffentlichten Referenz. Greifen Sie zu `ReadBarrier`, wenn mehrere gewöhnliche Lesezugriffe oder ein Lesezugriff, der zu groß für Atomarität ist, vor einer erneuten Prüfung abgeschlossen sein müssen. Der Lehrbuchfall ist die Leserseite eines Seqlocks.

Alles Folgende wurde mit .NET 10.0.10 (SDK 10.0.302), C# 14, auf einem Apple M4 (arm64) gemessen. Die Barrier-APIs gibt es in `System.Threading.Volatile` ab .NET 10. Unter .NET 9 und früher existiert außer `Interlocked.MemoryBarrier()` kein öffentliches Äquivalent.

## Der Vergleich auf einen Blick

| | `Volatile.Read(ref x)` | `Volatile.ReadBarrier()` |
| --- | --- | --- |
| Verfügbar seit | .NET Framework 4.5 | .NET 10 |
| Liest einen Wert | Ja, eine Speicherstelle | Nein |
| Was Acquire-Semantik erhält | Dieser eine Lesezugriff | Alle Lesezugriffe vor dem Aufruf |
| Verhindert, dass spätere Lese- und Schreibzugriffe nach oben wandern | Ja | Ja |
| Macht den Lesezugriff atomar | Ja, für unterstützte Typen (einschließlich `long`/`double` unter 32 Bit) | Nein, Atomarität ist Ihre Sache |
| Funktioniert mit beliebigem `T`, Structs, nativem Speicher | Nein, feste Menge an Überladungen | Ja, es ordnet beliebige vorangehende Lesezugriffe |
| arm64-Codegenerierung (gemessen, .NET 10.0.10) | `ldapur` (Load-Acquire) | `dmb ishld` (Load-Fence) |
| x64-Codegenerierung | einfaches `mov`, nur Ordnung durch den Compiler | keine Instruktion, nur Ordnung durch den Compiler |
| Typischer Einsatz | Flags, Double-Checked-Initialisierung, veröffentlichte Referenzen | Seqlocks, versionsvalidierte Caches, gebündelte Lesezugriffe |

## Was die beiden APIs garantieren

Die Spezifikation des .NET-Speichermodells (`docs/design/specs/Memory-model.md` in dotnet/runtime) führt beide unter "volatile reads have acquire semantics" auf, mit einer aufschlussreichen Fußnote zur Barriere: Sie "applies to all prior reads". Acquire bedeutet, dass kein Lese- oder Schreibzugriff, der in Programmreihenfolge später kommt, vor dem Acquire-Lesezugriff ausgeführt werden darf.

Bei `Volatile.Read(ref _version)` hängt das Acquire am Laden von `_version` und an nichts sonst. Lesezugriffe, die in Programmreihenfolge *davor* stattfanden, werden überhaupt nicht eingeschränkt. Sie können weiterhin nach unten rutschen.

Bei `Volatile.ReadBarrier()` hängt das Acquire an jedem Ladevorgang, der dem Aufruf vorausgeht. Der API-Vorschlag ([dotnet/runtime#98837](https://github.com/dotnet/runtime/issues/98837)) nennt das eine `Read-ReadWrite`-Barriere: Alle vorangehenden Lesezugriffe müssen abgeschlossen sein, bevor eine nachfolgende Speicheroperation stattfindet. Das Gegenstück, `Volatile.WriteBarrier()`, ist eine `ReadWrite-Write`-Barriere: Alle vorangehenden Speicheroperationen sind abgeschlossen, bevor ein nachfolgender Schreibzugriff stattfindet.

Die beiden APIs sind also keine zwei Stärken derselben Sache. Sie beantworten unterschiedliche Fragen:

- `Volatile.Read`: "Lies diesen Wert und stelle sicher, dass alles danach den Speicher mindestens so aktuell sieht."
- `Volatile.ReadBarrier`: "Stelle sicher, dass alles, was ich bereits gelesen habe, abgeschlossen ist, bevor ich wieder auf den Speicher zugreife."

Keine von beiden ist ein vollständiger Fence. Eine `ReadBarrier` tut nichts dagegen, dass ein früherer *Schreibzugriff* mit einem späteren Lesezugriff umsortiert wird (der Store-Load-Fall). Wenn Sie das brauchen, benötigen Sie weiterhin `Interlocked.MemoryBarrier()` oder eine `Interlocked`-Operation.

## Was der JIT tatsächlich erzeugt

Der JIT behandelt beide Methoden als Intrinsics. Der Quelltext von `Volatile.cs` ist lediglich `[Intrinsic] public static void ReadBarrier() => ReadBarrier();`, und der Importer ersetzt den Aufruf durch einen Memory-Barrier-Knoten, der als nur ladend markiert ist ([PR #107843](https://github.com/dotnet/runtime/pull/107843)). Um zu sehen, was daraus wird, habe ich eine kleine Klasse mit voller Optimierung kompiliert und mit `DOTNET_JitDisasm` ausgegeben:

```csharp
// .NET 10.0.10, C# 14
// DOTNET_TieredCompilation=0 DOTNET_JitDisasm='Codegen:*' dotnet vb.dll
sealed class Codegen
{
    private int _x;
    private long _a, _b, _c, _d;

    [MethodImpl(MethodImplOptions.NoInlining)]
    public long AcquireFour() =>
        Volatile.Read(ref _a) + Volatile.Read(ref _b) +
        Volatile.Read(ref _c) + Volatile.Read(ref _d);

    [MethodImpl(MethodImplOptions.NoInlining)]
    public long PlainFourThenBarrier()
    {
        long sum = _a + _b + _c + _d;
        Volatile.ReadBarrier();
        return sum;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    public void BarrierThenPlainFour(long v)
    {
        Volatile.WriteBarrier();
        _a = v; _b = v; _c = v; _d = v;
    }
}
```

Auf dem M4 waren dies die interessanten Instruktionen:

```text
; AcquireFour: four separate load-acquire instructions
ldapur  x1, [x0, #0x08]
ldapur  x2, [x0, #0x10]
ldapur  x2, [x0, #0x18]
ldapur  x0, [x0, #0x20]

; PlainFourThenBarrier: two paired loads, then one load fence
ldp     x1, x2, [x0, #0x08]
ldp     x2, x0, [x0, #0x18]
dmb     ishld

; BarrierThenPlainFour: a full fence, then two paired stores
dmb     ish
stp     x1, x1, [x0, #0x08]
stp     x1, x1, [x0, #0x18]
```

Drei Dinge fallen auf.

Erstens wird `Volatile.Read` zu `ldapur` kompiliert, einem RCpc-Load-Acquire (die RCpc-Erweiterungen kamen mit ARMv8.3 und v8.4), den der M4 unterstützt. Kerne ohne RCpc erhalten stattdessen das ältere `ldar`. In beiden Fällen gibt es keine separate Fence-Instruktion.

Zweitens bleiben die einfachen Lesezugriffe vor `ReadBarrier` einfach, sodass der JIT sie frei zu `ldp` paaren kann (und bei einer 32-Byte-Struct-Kopie zu einem Paar 128-Bit-`ldp q`-Ladevorgängen). Bei vier Acquire-Ladevorgängen geht diese Freiheit verloren. Das ist das Effizienzargument des Vorschlags: ein Fence für N Lesezugriffe statt N geordneter Lesezugriffe.

Drittens ist `Volatile.WriteBarrier()` unter arm64 ein vollständiges `dmb ish`, genau das, was `Interlocked.MemoryBarrier()` erzeugt. Im JIT steht ein Kommentar, dass er unter arm64 derzeit keine reine Store-Barriere besser als eine vollständige erzeugen kann. Erwarten Sie also nicht, dass `WriteBarrier` dort günstiger ist als ein vollständiger Fence.

Unter x64 erzeugen beide Barrieren überhaupt keine Instruktion. Der Codegen-Kommentar des PR ist eindeutig: Load-only- und Store-only-Barrieren "are no-ops on xarch", weil das TSO-Modell von x86 Ladevorgänge ohnehin gegenüber späteren Lade- und Speichervorgängen geordnet hält und Speichervorgänge gegenüber früheren Speicheroperationen. Wichtig sind sie auf x64 trotzdem: Sie hindern den JIT selbst daran, Speicherzugriffe über die Barriere hinweg umzusortieren, zwischenzuspeichern oder zu eliminieren. Für diesen Durchlauf hatte ich keine x64-Maschine, daher stammt die x64-Zeile der Tabelle aus dem JIT-Quelltext, nicht aus einem Disassembly.

## Ein Seqlock: der Fall, für den ReadBarrier gebaut wurde

Der erste Kunde war die Runtime selbst. `GenericCache` und `CastCache` in CoreLib verwendeten ein internes `Interlocked.ReadMemoryBarrier()` und wurden im selben PR auf `Volatile.ReadBarrier()` umgestellt. Ihr Kommentar beschreibt das Muster: "we must read in this order: version -> [entry parts] -> version".

Das ist ein Seqlock. Ein einzelner Schreiber erhöht eine Version auf eine ungerade Zahl, schreibt die Daten und erhöht sie dann auf die nächste gerade Zahl. Leser lesen die Version, kopieren die Daten mit gewöhnlichen Ladevorgängen und lesen die Version erneut. Stimmen beide Lesezugriffe überein und sind gerade, ist die Kopie konsistent. Die Daten können beliebig groß sein: Ein 32-Byte-Struct ist auf keiner Plattform atomar, und das ist in Ordnung, weil die Versionsprüfung zerrissene Kopien erkennt.

Hier die minimale Version, mit beiden Barrieren an den Stellen, an die sie gehören:

```csharp
// .NET 10, C# 14
struct Snapshot { public long A, B, C, D; }

sealed class SeqLockBox
{
    private int _version;          // even = stable, odd = write in progress
    private Snapshot _data;

    // Single writer only.
    public void Write(long n)
    {
        int v = _version;
        _version = v + 1;          // mark "writing" (odd)
        Volatile.WriteBarrier();   // odd version is published before any data write below
        _data.A = n; _data.B = n; _data.C = n; _data.D = n;
        Volatile.Write(ref _version, v + 2); // release: data writes complete before the even version
    }

    public bool TryRead(out Snapshot snapshot)
    {
        int v1 = Volatile.Read(ref _version); // acquire: the data reads below cannot move above this
        snapshot = _data;                     // plain, non-atomic 32-byte copy
        Volatile.ReadBarrier();               // every read above completes before the re-check
        return (v1 & 1) == 0 && _version == v1;
    }
}
```

Beachten Sie, wie der Leser beide APIs verwendet. Der erste Versions-Lesezugriff ist ein `Volatile.Read`, weil die Datenzugriffe *unterhalb* davon bleiben müssen. Die Datenkopie ist einfach. Dann hält `ReadBarrier` die Datenzugriffe *oberhalb* des zweiten Versions-Lesezugriffs. Kein einzelnes `Volatile.Read` kann diese zweite Einschränkung ausdrücken, denn `Volatile.Read` schränkt nur ein, was nach der gelesenen Speicherstelle kommt, und hier muss geordnet werden, was davor kam.

Der Schreiber spiegelt das. `Volatile.Write` auf die letzte gerade Version ist ein Release, sodass die Datenschreibzugriffe nicht darunter absinken können. Ein Release verhindert aber nicht, dass die Datenschreibzugriffe über den früheren Store der ungeraden Version steigen. `WriteBarrier` deckt diese Seite ab.

## Beweis, dass jede Hälfte notwendig ist

Ich habe Leser und Schreiber auf zwei Threads je fünf Sekunden pro Szenario laufen lassen und gezählt, wie viele akzeptierte Snapshots widersprüchliche `A`, `B`, `C`, `D` hatten. Jedes Szenario entfernt ein Stück der Ordnung:

```csharp
// .NET 10, C# 14: the reader variants in the stress test
public bool TryReadAcquireOnly(out Snapshot snapshot)   // no ReadBarrier
{
    int v1 = Volatile.Read(ref _version);
    snapshot = _data;
    return (v1 & 1) == 0 && _version == v1;
}

public bool TryReadBarrierOnly(out Snapshot snapshot)   // no acquire on the first read
{
    int v1 = _version;
    snapshot = _data;
    Volatile.ReadBarrier();
    return (v1 & 1) == 0 && _version == v1;
}
```

Ergebnisse auf dem M4, .NET 10.0.10, Release-Build, zwei Läufe:

| Szenario | Akzeptierte Snapshots (Lauf 1 / Lauf 2) | Zerrissen und akzeptiert (Lauf 1 / Lauf 2) |
| --- | --- | --- |
| Überhaupt keine Ordnung (einfache Lesezugriffe) | 1,014,876,206 / 1,003,303,309 | 547,804 / 515,135 |
| Nur `Volatile.Read`, keine `ReadBarrier` | 164,358,676 / 152,032,561 | 99 / 357 |
| Nur `ReadBarrier`, einfacher erster Lesezugriff | 34,543,735 / 27,982,884 | 54 / 62 |
| Schreiber ohne `WriteBarrier`, korrekter Leser | 354,942,744 / 384,287,324 | 66,155,404 / 54,597,163 |
| Beide Barrieren (der Code oben) | 62,659,697 / 66,048,738 | 0 / 0 |

Jede Halbheit lieferte zerrissene Daten, die die Validierung bestanden. Die seltenen sind die gefährlichen: 99 fehlerhafte Lesezugriffe aus 164 Millionen sind genau die Art von Bug, die jeden Testlauf übersteht und in Produktion auf einer Graviton- oder Ampere-Maschine auftaucht. Die fehlende `WriteBarrier` war der lauteste Fehler, und das Disassembly zeigt warum: Die beiden Schreibermethoden kompilieren bis auf das einzelne `dmb ish` zu identischem Code, sodass jeder dieser über 54 Millionen Risse darauf beruht, dass der arm64-Kern die Datenspeicherungen vor dem Store der ungeraden Version sichtbar macht.

Unter x64 würden Sie bei den meisten dieser Zeilen sehr wahrscheinlich null Risse sehen, weil die Hardware in diesen Richtungen nicht umsortiert. Genau deshalb werden diese Bugs ausgeliefert. Der Code ist auf x64 trotzdem falsch, da der JIT einfache Zugriffe umsortieren darf, und er wird sichtbar falsch, sobald er auf arm64 läuft.

## Auch der JIT sortiert um, nicht nur die CPU

Die erste Version meines Stresstest-Harness hing endlos, und es lohnt sich zu zeigen, warum. Der fehlerhafte Leser lief in einer Schleife, bis er eine gerade Version sah:

```csharp
// .NET 10, C# 14: do not do this
public void WaitForEvenBroken()
{
    while ((_version & 1) != 0) { }
}
```

Der JIT kompilierte das zu einem Ladevorgang und einem Sprung auf sich selbst:

```text
ldr     w0, [x0, #0x08]
and     w0, w0, #1
G_M000_IG03:
cbnz    w0, G_M000_IG03
```

Das Laden von `_version` wurde aus der Schleife herausgezogen, was bei einem gewöhnlichen Feldzugriff ohne dazwischenliegende Synchronisierung zulässig ist. Landet der erste Lesezugriff zufällig auf einer ungeraden Version, dreht sich der Thread für immer. Ein `Volatile.Read(ref _version)` in der Bedingung behebt das, ebenso eine `ReadBarrier` im Schleifenrumpf. Das ist der Teil von "volatile", den x64-Entwickler tatsächlich erleben, und er ist der Grund, warum die Barrieren keine leeren Aufrufe sind, selbst wenn sie keine Instruktion erzeugen.

## Wann Sie Volatile.Read wählen

- **Ein Flag oder ein Stoppsignal.** `while (!Volatile.Read(ref _stop))` ist der klassische Fall. Eine Speicherstelle, ein Wert, und spätere Lesezugriffe sollen sehen, was der Schreiber vor dem Setzen veröffentlicht hat.
- **Eine Referenz veröffentlichen.** Der Schreiber baut ein Objekt auf und ruft dann `Volatile.Write(ref _instance, obj)` auf. Der Leser ruft `Volatile.Read(ref _instance)` auf und liest dann Felder darüber. Das Acquire auf dem Referenz-Lesezugriff ist alles, was Sie brauchen.
- **Double-Checked-Lazy-Initialisierung.** Gleiche Form wie das Veröffentlichen, und der Grund, warum `LazyInitializer` intern volatile Lesezugriffe verwendet.
- **Sie zielen auf .NET 9 oder früher.** `ReadBarrier` existiert dort nicht.

In all diesen Fällen ist die Ordnung an einen einzelnen Lesezugriff gebunden, sodass `Volatile.Read` genau ausdrückt, was Sie meinen, und auf keiner Architektur einen Fence erzeugt.

## Wann Sie Volatile.ReadBarrier wählen

- **Seqlock-Leser und versionsvalidierte Caches.** Das obige Muster, und das, das `CastCache` und `GenericCache` in CoreLib verwenden.
- **Daten, die nicht atomar gelesen werden können.** Structs, die größer als ein Zeiger sind, `Int128`, Byte-Spans oder ein Struct mit mehreren Feldern. Für sie gibt es keine `Volatile.Read`-Überladung, und mit `ReadBarrier` können Sie sie mit gewöhnlichen Ladevorgängen kopieren und anschließend validieren.
- **Lesezugriffe aus nativem Speicher oder über `Unsafe`.** Wenn Sie über einen Zeiger oder eine `ref` in einen nicht verwalteten Puffer lesen, gibt es möglicherweise kein verwaltetes Feld, das Sie an `Volatile.Read` übergeben könnten. Die Barriere ordnet diese Ladevorgänge trotzdem.
- **Viele Lesezugriffe, die einen Ordnungspunkt brauchen.** Ein `dmb ishld` nach N einfachen Ladevorgängen statt N Acquire-Ladevorgängen, während der JIT die einfachen Ladevorgänge paaren darf.

## Die Kosten, gemessen

Es gibt zwei korrekte Wege, den Seqlock-Leser ohne `ReadBarrier` zu schreiben: jeden Datenzugriff zu einem `Volatile.Read` machen oder dort, wo die Barriere hingehört, ein vollständiges `Interlocked.MemoryBarrier()` verwenden. Ich habe alle gegen den ungeordneten (fehlerhaften) Leser mit BenchmarkDotNet 0.15.8 verglichen. Jeder Aufruf führt 1,024 Einzelthread-Lesezugriffe auf den 32-Byte-Snapshot aus, und die Tabelle nennt die Kosten pro Lesezugriff:

```csharp
// .NET 10.0.10, C# 14, BenchmarkDotNet 0.15.8, Apple M4 (arm64)
[Benchmark(OperationsPerInvoke = N)]
public long VolatileReadPlusReadBarrier()
{
    long sum = 0;
    for (int i = 0; i < N; i++)
    {
        int v1 = Volatile.Read(ref _version);
        Snapshot s = _data;
        Volatile.ReadBarrier();
        if ((v1 & 1) == 0 && _version == v1) sum += s.A + s.B + s.C + s.D;
    }
    return sum;
}
```

| Leser (pro Snapshot-Lesezugriff) | Mittelwert | Verhältnis |
| --- | --- | --- |
| Keine Ordnung (fehlerhaft) | 0.916 ns | 1.00 |
| `Volatile.Read` auf die Version und auf alle vier Felder | 1.135 ns | 1.24 |
| `Volatile.Read` + `Volatile.ReadBarrier` | 0.929 ns | 1.01 |
| `Volatile.Read` + `Interlocked.MemoryBarrier` | 0.930 ns | 1.02 |

Die Barrier-Version kostet etwa so viel wie die fehlerhafte. Die Version mit durchgehend volatilen Lesezugriffen ist rund 24% langsamer, hauptsächlich weil vier geordnete `ldapur`-Ladevorgänge nicht wie die einfache Kopie zu zwei breiten Ladevorgängen verschmolzen werden können. Bei einem größeren Struct wächst die Lücke mit der Feldanzahl, während die Barriere eine Instruktion bleibt.

Zwei ehrliche Einschränkungen. Dies ist eine unkonkurrierte Einzelthread-Schleife: Ein `dmb` ist billig, wenn der Kern keinen ausstehenden Speicherverkehr abwarten muss, weshalb auch der vollständige Fence hier kostenlos aussieht. Unter echter Schreibkonkurrenz kostet ein vollständiger Fence typischerweise mehr als ein reiner Load-Fence, aber ich habe keinen Benchmark mit Konkurrenz durchgeführt und nenne deshalb keine Zahl. Und all das gilt für arm64. Unter x64 erzeugen beide Barrieren keine Instruktion, sodass Sie nur vergleichen, was der JIT um sie herum tun darf.

## Fallstricke

**Die Platzierung ist alles.** `ReadBarrier` ordnet Lesezugriffe *vor* ihr gegenüber Zugriffen *nach* ihr. Sie am Anfang eines Lesers zu platzieren, wo man instinktiv einen "volatile"-Lesezugriff hinsetzt, ordnet nichts, was Sie interessiert. In einem Seqlock steht sie nach der Datenkopie und vor dem zweiten Versions-Lesezugriff.

**Sie ist kein vollständiger Fence.** Ein Store, gefolgt von `ReadBarrier`, gefolgt von einem Load, kann weiterhin umsortiert werden. Dekker-artiger Code, bei dem jeder Thread sein eigenes Flag schreibt und dann das des anderen liest, braucht `Interlocked.MemoryBarrier()` oder eine `Interlocked`-Operation.

**Sie macht nichts atomar.** Die Spezifikation des Speichermodells ist deutlich: Volatile-Semantik impliziert keine Atomarität. Wenn Sie die Versionsvalidierung weglassen, ordnet eine Barriere bereitwillig einen zerrissenen Lesezugriff.

**Sie ist kein Lock.** Ein Seqlock wie hier geschrieben unterstützt genau einen Schreiber. Zwei Schreiber müssen sich mit einem `Interlocked.CompareExchange` auf die Version serialisieren (so macht es `GenericCache`) oder mit einem echten Lock. Wenn Sie zu Barrieren greifen, weil sich ein Lock langsam anfühlte, messen Sie zuerst: Der Beitrag zu [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/de/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) zeigt, wie günstig ein unkonkurrierter Lock bereits ist.

**C#-`volatile`-Felder sind nicht dasselbe Werkzeug.** Ein `volatile`-Feld veranlasst den C#-Compiler, jeden Zugriff mit dem IL-Präfix `volatile.` auszugeben, sodass jeder Lesezugriff ein Acquire und jeder Schreibzugriff ein Release ist. Das ist die Semantik von `Volatile.Read`/`Volatile.Write` pro Zugriff, niemals eine Barriere über einen Stapel, und sie deaktiviert die oben gezeigte Paarung von Ladevorgängen.

## Das Fazit

Verwenden Sie standardmäßig `Volatile.Read`. Es ist das richtige Werkzeug für nahezu jedes lockfreie Flag-, Veröffentlichungs- und Lazy-Init-Muster, kostet auf x64 nichts und ist auf moderner arm64-Hardware eine einzige Load-Acquire-Instruktion. Verwenden Sie `Volatile.ReadBarrier` (ab .NET 10) nur, wenn das, was Sie ordnen müssen, ein Stapel früherer Lesezugriffe ist, typischerweise eine nicht atomare Kopie, die Sie anschließend validieren. Kombinieren Sie sie dann auf der Schreiberseite mit `Volatile.WriteBarrier`, testen Sie auf arm64 und denken Sie daran, dass `WriteBarrier` unter arm64 so teuer ist wie ein vollständiger Fence.

## Verwandte Themen

- [How to use the new System.Threading.Lock type](/de/2026/04/how-to-use-the-new-system-threading-lock-type-in-dotnet-11/), die richtige Antwort, wenn Sie gar keinen lockfreien Code brauchen.
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#](/de/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) zur Auswahl eines Synchronisierungsprimitivs.
- [How to cancel a long-running Task without deadlocking](/de/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/), wo hinter jeder Abbruchprüfung ein `Volatile.Read` sitzt.
- [record vs class vs struct in C#](/de/2026/05/record-vs-class-vs-struct-in-csharp-a-decision-matrix/), relevant, sobald Ihr gemeinsamer Zustand ein Struct mit mehreren Feldern ist, das nicht atomar gelesen werden kann.

## Quellen

- [Volatile.ReadBarrier method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.volatile.readbarrier?view=net-10.0) und [Volatile class](https://learn.microsoft.com/en-us/dotnet/api/system.threading.volatile?view=net-10.0) auf MS Learn.
- [API proposal: Volatile barrier APIs, dotnet/runtime#98837](https://github.com/dotnet/runtime/issues/98837).
- [Implement volatile barrier APIs, dotnet/runtime#107843](https://github.com/dotnet/runtime/pull/107843), einschließlich der JIT-Codegenerierung und der CoreLib-Cache-Änderungen.
- [.NET memory model specification](https://github.com/dotnet/runtime/blob/main/docs/design/specs/Memory-model.md).
- [GenericCache.cs on release/10.0](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/GenericCache.cs), ein Seqlock-Leser aus der Produktion, der `Volatile.ReadBarrier` verwendet.
