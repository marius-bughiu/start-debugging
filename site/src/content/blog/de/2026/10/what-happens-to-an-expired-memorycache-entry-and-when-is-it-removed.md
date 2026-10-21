---
title: "Was passiert mit einem abgelaufenen MemoryCache-Eintrag, und wann wird er tatsächlich aus dem Speicher entfernt?"
description: "Ein abgelaufener MemoryCache-Eintrag wird nicht per Timer entfernt. Er bleibt im Dictionary, bis ein Lesezugriff ihn berührt, ein gedrosselter Hintergrund-Scan läuft oder eine Compaction startet. Hier steht genau, wann jeder dieser Fälle eintritt und wie Sie eine sofortige Entfernung erreichen."
pubDate: 2026-10-21
tags:
  - "dotnet"
  - "dotnet-10"
  - "caching"
  - "memorycache"
  - "performance"
lang: "de"
translationOf: "2026/10/what-happens-to-an-expired-memorycache-entry-and-when-is-it-removed"
translatedBy: "claude"
translationDate: 2026-10-21
---

Mit einem abgelaufenen `MemoryCache`-Eintrag passiert im Moment des Ablaufs nichts. `Microsoft.Extensions.Caching.Memory` hat weder einen Timer pro Eintrag noch einen Hintergrund-Thread, der die Uhr beobachtet. Der Eintrag, sein Wert und alles, worauf der Wert verweist, bleiben deshalb im Dictionary des Caches, bis eines von drei Dingen ihn berührt: ein Lesezugriff auf diesen Schlüssel (`TryGetValue`, `Get`, `GetOrCreate`), ein Hintergrund-Scan nach abgelaufenen Einträgen, der nur durch eine andere Cache-Operation gestartet wird und höchstens einmal pro `ExpirationScanFrequency` läuft (standardmäßig 1 Minute), oder eine Compaction (`Compact()` oder der Überlaufpfad von `SizeLimit`). Erst nachdem der Eintrag das Dictionary verlassen hat, kann die GC den Wert freigeben. Die einzige Ausnahme ist ein Ablauf-Token wie `CancellationChangeToken`: Sobald es ausgelöst wird, wird der Eintrag sofort entfernt, ohne dass ein Lesezugriff nötig ist.

Alles Folgende wurde mit `Microsoft.Extensions.Caching.Memory` 10.0.13 und 11.0.0-rc.2.26504.105 auf .NET 10.0.10 (SDK 10.0.302) geprüft, der Quellcode stammt aus dem `main`-Branch von `dotnet/runtime`. Beide Pakete lieferten für jedes Szenario identische Ausgaben, und dieser Teil des Designs hat sich seit Jahren nicht geändert.

## Warum es keinen Ablauf-Timer gibt

`MemoryCache` speichert Einträge in einem `ConcurrentDictionary`. Jeder `CacheEntry` kennt seinen absoluten Ablauf, seinen gleitenden Ablauf und seine Ablauf-Token, plant aber nichts ein. Der Ablauf ist eine verzögerte Prüfung, `CacheEntry.CheckExpired(DateTime utcNow)`, die der Cache immer dann aufruft, wenn er zufällig einen Eintrag ansieht:

```csharp
// dotnet/runtime main, CacheEntry.cs (abridged)
internal bool CheckExpired(DateTime utcNow)
    => EvictionReason != EvictionReason.None
        || CheckForExpiredTime(utcNow)
        || (_tokens != null && _tokens.CheckForExpiredTokens(this));
```

Das ist ein bewusster Kompromiss. Ein Cache mit einer Million Einträgen und einem Timer pro Eintrag würde spürbar CPU und Speicher für Timer verbrauchen. Ein einzelner periodischer Timer würde einen sonst untätigen Prozess dauerhaft aufwecken. Das verzögerte Design kostet nichts, solange der Cache ruhig ist, hält dafür aber veraltete Daten länger vor, als man vielleicht annimmt.

Die eigentliche Frage lautet also nie "Wann läuft der Eintrag ab?", sondern "Wann sieht der Cache ihn sich als Nächstes an?". Dafür gibt es vier Antworten.

## Pfad 1: Ein Lesezugriff auf denselben Schlüssel entfernt ihn sofort

`TryGetValue` (über das auch `Get`, `GetOrCreate` und `GetOrCreateAsync` laufen) prüft den gefundenen Eintrag. Ist er abgelaufen, wird er auf der Stelle aus dem Dictionary entfernt, und der Aufruf meldet einen Miss:

```csharp
// dotnet/runtime main, MemoryCache.PostProcessTryGetValue (abridged)
if (!entry.CheckExpired(utcNow) || entry.EvictionReason == EvictionReason.Replaced)
{
    entry.LastAccessed = utcNow;
    result = entry.Value;
    StartScanForExpiredItemsIfNeeded(utcNow);
    return true; // hit
}
else
{
    coherentState.RemoveEntry(entry, _options); // expired: removed right here
}
```

Von einem Lesezugriff erhalten Sie nie einen abgelaufenen Wert zurück, die Korrektheit ist also nicht das Problem. Das Problem ist alles, was Sie nicht gelesen haben.

## Pfad 2: Der gedrosselte Hintergrund-Scan

Fast jede Cache-Operation (ein Treffer, ein Miss, ein `Set`, ein `Remove`, ein durch ein Token ausgelöster Ablauf) endet mit einem Aufruf von `StartScanForExpiredItemsIfNeeded`:

```csharp
// dotnet/runtime main, MemoryCache.cs
private void StartScanForExpiredItemsIfNeeded(DateTime utcNow)
{
    if (_options.ExpirationScanFrequency < utcNow - _lastExpirationScan)
    {
        _lastExpirationScan = utcNow;
        Task.Factory.StartNew(state => ((MemoryCache)state!).ScanForExpiredItems(), this,
            CancellationToken.None, TaskCreationOptions.DenyChildAttach, TaskScheduler.Default);
    }
}
```

`ScanForExpiredItems` durchläuft auf einem Thread-Pool-Thread jeden Eintrag und entfernt die abgelaufenen. Aus diesem Code folgen unmittelbar zwei Konsequenzen:

1. **Der Scan wird ausgelöst, nicht eingeplant.** Wenn nichts den Cache aufruft, startet nie ein Scan. Ein untätiger Cache voller abgelaufener Einträge behält sie alle unbegrenzt.
2. **Der Scan wird gedrosselt.** Selbst bei einem stark ausgelasteten Cache startet ein vollständiger Durchlauf höchstens einmal pro `ExpirationScanFrequency`, standardmäßig `TimeSpan.FromMinutes(1)`. Ein Eintrag, der direkt nach einem Scan abläuft, kann bei durchgehendem Datenverkehr bis zu eine Minute überleben, ohne Datenverkehr beliebig lange.

## Pfad 3: Compaction

Wenn Sie `SizeLimit` setzen und ein Einfügen die Gesamtgröße (`Size`) darüber hinaus treiben würde, reiht der Cache eine Compaction wegen Überkapazität im Thread-Pool ein. Sie können auch selbst `Compact(double percentage)` aufrufen. Beide laufen über dieselbe private Methode `Compact`, deren erster Schritt darin besteht, alle abgelaufenen Einträge zum Entfernen zu sammeln, bevor sie aktive Einträge nach Priorität verdrängt (`Low`, dann `Normal`, dann `High`, jeder Bereich nach `LastAccessed` sortiert; `NeverRemove` wird nie angetastet). `Compact(0)` entfernt daher alle abgelaufenen Einträge und sonst nichts, was sich als manueller Durchlauf anbietet.

## Pfad 4: Ablauf-Token sind der einzige sofortige Pfad

Hat ein Eintrag ein `IChangeToken` mit `ActiveChangeCallbacks == true` (ein `CancellationChangeToken`, ein File-Provider-Token, ein Token für das Neuladen der Konfiguration), registriert der Cache dort einen Callback. Wird das Token ausgelöst, reiht der Callback Arbeit ein, die den Eintrag mit `EvictionReason.TokenExpired` markiert und aus dem Dictionary entfernt, ganz ohne Lesezugriff:

```csharp
// dotnet/runtime main, CacheEntry.cs
private static void ExpirationTokensExpired(object obj)
{
    // start a new thread to avoid issues with callbacks called from RegisterChangeCallback
    Task.Factory.StartNew(state =>
    {
        var entry = (CacheEntry)state!;
        entry.SetExpired(EvictionReason.TokenExpired);
        entry._cache.EntryExpired(entry);
    }, obj, CancellationToken.None, TaskCreationOptions.DenyChildAttach, TaskScheduler.Default);
}
```

Zeitbasierter Ablauf (`AbsoluteExpiration`, `AbsoluteExpirationRelativeToNow`, `SlidingExpiration`) nimmt diesen Pfad nie.

## Ein Test, der alle vier Pfade zeigt

Am einfachsten sehen Sie das, ohne minutenlang zu warten, indem Sie dem Cache eine manuelle Uhr geben. `MemoryCacheOptions.Clock` erwartet eine `ISystemClock` (kein `TimeProvider`), und `MemoryCache.Count` liefert die rohe Anzahl im Dictionary, abgelaufene Einträge eingeschlossen. Speichern Sie dies als `probe.cs` und führen Sie es mit `dotnet run probe.cs` aus:

```csharp
#:package Microsoft.Extensions.Caching.Memory@10.0.13
#:property PublishAot=false
// .NET 10, C# 14, Microsoft.Extensions.Caching.Memory 10.0.13
using System.Runtime.CompilerServices;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Internal;
using Microsoft.Extensions.Primitives;

var clock = new ManualClock();
var cache = new MemoryCache(new MemoryCacheOptions
{
    Clock = clock,
    ExpirationScanFrequency = TimeSpan.FromMinutes(1),
});

// 1. Expired entries stay until something touches them
cache.Set("a", "A", TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromSeconds(30));
Console.WriteLine($"[1] after expiry, Count = {cache.Count}");
Console.WriteLine($"[1] TryGetValue = {cache.TryGetValue("a", out _)}, Count = {cache.Count}");

// 2. Idle cache: nobody reads, nothing is removed
for (int i = 0; i < 1000; i++)
    cache.Set($"k{i}", new byte[1024], TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromMinutes(10));
Thread.Sleep(500);
Console.WriteLine($"[2] 10 min later, nobody touched the cache, Count = {cache.Count}");
cache.TryGetValue("unrelated", out _); // any operation; >1 min since last scan
Thread.Sleep(200);
Console.WriteLine($"[2] after one unrelated TryGetValue, Count = {cache.Count}");

// 3. Scan throttling: a second expiry within ExpirationScanFrequency is not scanned
cache.Set("b", "B", TimeSpan.FromSeconds(10));
clock.Advance(TimeSpan.FromSeconds(30));
cache.TryGetValue("unrelated", out _);
Thread.Sleep(200);
Console.WriteLine($"[3] 30 s later (< scan frequency), Count = {cache.Count}");
clock.Advance(TimeSpan.FromSeconds(31));
cache.TryGetValue("unrelated", out _);
Thread.Sleep(200);
Console.WriteLine($"[3] 61 s since last scan, Count = {cache.Count}");

// 4. Post-eviction callback runs later, on a thread-pool thread
var done = new ManualResetEventSlim();
int callerThread = Environment.CurrentManagedThreadId;
cache.Set("c", "C", new MemoryCacheEntryOptions()
    .SetAbsoluteExpiration(TimeSpan.FromSeconds(10))
    .RegisterPostEvictionCallback((k, v, reason, _) =>
    {
        Console.WriteLine($"[4] callback key={k} reason={reason} thread={Environment.CurrentManagedThreadId} (caller {callerThread}) pool={Thread.CurrentThread.IsThreadPoolThread}");
        done.Set();
    }));
clock.Advance(TimeSpan.FromSeconds(30));
Console.WriteLine($"[4] TryGetValue = {cache.TryGetValue("c", out _)} returned before callback ran: {!done.IsSet}");
done.Wait(2000);

// 5. Expiration token: removed eagerly, no read required
var cts = new CancellationTokenSource();
var tokenDone = new ManualResetEventSlim();
cache.Set("d", "D", new MemoryCacheEntryOptions()
    .AddExpirationToken(new CancellationChangeToken(cts.Token))
    .RegisterPostEvictionCallback((k, _, reason, _) => { Console.WriteLine($"[5] callback key={k} reason={reason}"); tokenDone.Set(); }));
int before = cache.Count;
cts.Cancel();
tokenDone.Wait(2000);
Console.WriteLine($"[5] Count before cancel = {before}, after cancel (no reads) = {cache.Count}");

// 6. Memory: the value is reachable until the entry leaves the dictionary
var weak = Store(cache, clock);
clock.Advance(TimeSpan.FromSeconds(30));
GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
Console.WriteLine($"[6] expired but not removed, value alive after GC = {weak.IsAlive}");
cache.TryGetValue("big", out _);
GC.Collect(); GC.WaitForPendingFinalizers(); GC.Collect();
Console.WriteLine($"[6] removed by read, value alive after GC = {weak.IsAlive}");

// 7. Sliding expiration is measured from the last read
cache.Set("s", "S", new MemoryCacheEntryOptions { SlidingExpiration = TimeSpan.FromSeconds(20) });
for (int i = 0; i < 5; i++) { clock.Advance(TimeSpan.FromSeconds(15)); cache.TryGetValue("s", out _); }
Console.WriteLine($"[7] read every 15 s for 75 s with 20 s sliding: still there = {cache.TryGetValue("s", out _)}");
clock.Advance(TimeSpan.FromSeconds(21));
Console.WriteLine($"[7] after 21 s idle: still there = {cache.TryGetValue("s", out _)}");

// 8. Compact(0) removes expired entries only
cache.Set("e1", 1, TimeSpan.FromSeconds(5));
cache.Set("e2", 2, TimeSpan.FromSeconds(5));
cache.Set("live", 3, TimeSpan.FromHours(1));
clock.Advance(TimeSpan.FromSeconds(10));
Console.WriteLine($"[8] before Compact(0): Count = {cache.Count}");
cache.Compact(0);
Console.WriteLine($"[8] after Compact(0): Count = {cache.Count}");

[MethodImpl(MethodImplOptions.NoInlining)]
static WeakReference Store(MemoryCache cache, ManualClock clock)
{
    var value = new byte[10_000_000];
    cache.Set("big", value, TimeSpan.FromSeconds(10));
    return new WeakReference(value);
}

sealed class ManualClock : ISystemClock
{
    private DateTimeOffset _now = new(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);
    public DateTimeOffset UtcNow => _now;
    public void Advance(TimeSpan by) => _now += by;
}
```

Ausgabe, identisch mit dem Paket 10.0.13 und 11.0.0-rc.2.26504.105:

```text
[1] after expiry, Count = 1
[1] TryGetValue = False, Count = 0
[2] 10 min later, nobody touched the cache, Count = 1000
[2] after one unrelated TryGetValue, Count = 0
[3] 30 s later (< scan frequency), Count = 1
[3] 61 s since last scan, Count = 0
[4] TryGetValue = False returned before callback ran: True
[4] callback key=c reason=Expired thread=4 (caller 1) pool=True
[5] callback key=d reason=TokenExpired
[5] Count before cancel = 1, after cancel (no reads) = 0
[6] expired but not removed, value alive after GC = True
[6] removed by read, value alive after GC = False
[7] read every 15 s for 75 s with 20 s sliding: still there = True
[7] after 21 s idle: still there = False
[8] before Compact(0): Count = 3
[8] after Compact(0): Count = 1
```

Zeile `[2]` überrascht die Leute am meisten: Tausend abgelaufene Einträge liegen zehn Minuten nach ihrem Ablauf noch im Cache, bis eine Abfrage nach einem völlig unbeteiligten Schlüssel den Scan anstößt. Zeile `[6]` zeigt die Folge für den Speicher: Ein abgelaufenes 10-MB-Array ist weiterhin erreichbar, und eine vollständige blockierende GC kann es nicht freigeben, weil das Dictionary des Caches es noch referenziert.

## Was "aus dem Speicher entfernt" tatsächlich bedeutet

Das Entfernen aus dem Cache und das Freigeben durch die GC sind zwei getrennte Ereignisse:

1. Der Eintrag wird auf einem der vier oben genannten Pfade aus dem `ConcurrentDictionary` entfernt. Ab diesem Moment hält der Cache den Wert nicht mehr als Root.
2. Hat der Eintrag Post-Eviction-Callbacks, reiht der Cache sie mit `Task.Factory.StartNew` im Thread-Pool ein. Der `CacheEntry` (und damit sein `Value`) bleibt von diesem eingereihten Arbeitselement aus erreichbar, bis alle Callbacks gelaufen sind, und natürlich so lange, wie ein Callback den Wert irgendwo ablegt.
3. Die GC gibt den Wert bei ihrer nächsten Collection der Generation frei, in der der Wert liegt. Ein langlebiger Cache-Wert wurde meist nach Gen 2 befördert oder liegt auf dem Large Object Heap, wenn er 85.000 Bytes oder mehr umfasst. Die "nächste Collection" kann auf einem Server, der selten vollständige GCs ausführt, also eine Weile dauern.

Wenn ein Heap-Dump zeigt, dass Ihr gecachter Typ lange nach dem erwarteten Ablauf den Speicher dominiert, prüfen Sie die Roots: Ein Pfad über `MemoryCache` und `CoherentState` bedeutet, dass der Eintrag schlicht noch im Dictionary liegt. Das ist ein Scan-Problem, kein Speicherleck. Die [Anleitung zu dotnet-gcdump und dotnet-dump](/de/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) zeigt, wie Sie diese Root-Pfade lesen.

## Post-Eviction-Callbacks kommen spät und auf einem anderen Thread

`RegisterPostEvictionCallback` ist der übliche Weg, um einen Ablauf zu beobachten, und erbt die gesamte oben beschriebene Verzögerung. Ein Callback für einen zeitlich abgelaufenen Eintrag wird nicht zum Ablaufzeitpunkt ausgelöst. Er wird ausgelöst, wenn der Eintrag tatsächlich entfernt wird, also bei einem Lesezugriff, einem Scan oder einer Compaction, und selbst dann läuft er später auf einem Thread-Pool-Thread (Zeile `[4]`: Der Lesezugriff lieferte einen Miss, bevor der Callback gelaufen war). Der Callback erhält den `EvictionReason`: `Expired` für zeitbasierten Ablauf, `TokenExpired` für Token, `Capacity` für größenbasierte Compaction, `Removed` für ein explizites `Remove` und `Replaced`, wenn Sie denselben Schlüssel erneut mit `Set` setzen.

Ausnahmen aus einem Callback werden abgefangen und über den `ILogger` des Caches als `EvictionCallback invoked failed` protokolliert. Sie bringen den Prozess also nie zum Absturz, treten aber auch nie in Erscheinung, wenn Sie nicht in die Logs schauen.

Bauen Sie auf diesen Callbacks bei zeitbasiertem Ablauf kein "Aktualisieren beim Ablauf" auf. Auf einem ruhigen Server fände die Aktualisierung erst statt, wenn eine Anfrage den Miss bemerkt, was den Zweck verfehlt.

## Sofortige, pünktliche Entfernung erreichen

Wenn ein Eintrag den Cache nahe an seinem Ablaufzeitpunkt verlassen soll, unabhängig vom Datenverkehr, hängen Sie ein Token an, das per Timer ausgelöst wird. Am einfachsten ist eine `CancellationTokenSource` mit Verzögerung:

```csharp
// .NET 10, C# 14, Microsoft.Extensions.Caching.Memory 10.0.13
public static void SetWithEagerExpiry<T>(IMemoryCache cache, object key, T value, TimeSpan ttl)
{
    var cts = new CancellationTokenSource(ttl);
    var options = new MemoryCacheEntryOptions()
        .SetAbsoluteExpiration(ttl) // still enforced lazily on reads
        .AddExpirationToken(new CancellationChangeToken(cts.Token))
        .RegisterPostEvictionCallback(static (_, _, _, state) => ((CancellationTokenSource)state!).Dispose(), cts);

    cache.Set(key, value, options);
}
```

Sobald die Verzögerung verstrichen ist, wird das Token ausgelöst, der Cache entfernt den Eintrag, und der Post-Eviction-Callback gibt die `CancellationTokenSource` frei (er läuft auch dann, wenn der Eintrag früher ersetzt oder entfernt wird, sodass der Timer nicht leckt). Der Preis ist ein Timer pro Eintrag. Setzen Sie das also für die wenigen großen oder sensiblen Einträge ein, die pünktlich verschwinden müssen, nicht für einen Cache mit einer Million kleiner Elemente.

Für alles andere genügen meist zwei Stellschrauben:

- **`ExpirationScanFrequency` senken.** In ASP.NET Core: `services.AddMemoryCache(o => o.ExpirationScanFrequency = TimeSpan.FromSeconds(10));`. Jeder Scan durchläuft das gesamte Dictionary, bei sehr großen Caches tauschen Sie also CPU gegen Zeitnähe. Es braucht weiterhin irgendeine Operation, die den Scan auslöst.
- **Nach eigenem Zeitplan aufräumen.** Ein `BackgroundService` oder `PeriodicTimer`, der alle N Sekunden `cache.Compact(0)` aufruft, entfernt alle abgelaufenen Einträge auch bei untätigem Cache. `Compact` ist auf der konkreten Klasse `MemoryCache` definiert, nicht auf `IMemoryCache`, Sie müssen also casten oder `MemoryCache` injizieren.

## Stolperfallen, die Sie kennen sollten

**`Count` schließt abgelaufene Einträge ein.** `MemoryCache.Count`, `MemoryCache.Keys` (neu in .NET 9) und `GetCurrentStatistics().CurrentEntryCount` melden alle das rohe Dictionary. Ein Dashboard kann daher Tausende "aktive" Einträge zeigen, die alle über ihren Ablauf hinaus sind. Das eingebaute OpenTelemetry-Meter, das im [Beitrag zu den MemoryCache-Metriken in .NET 11](/de/2026/06/dotnet-11-memorycache-opentelemetry-metrics/) beschrieben wird, liest dieselben Statistiken, mit demselben Vorbehalt.

**Gleitender Ablauf wird durch Lesezugriffe zurückgesetzt, nicht durch Scans.** Jeder Treffer aktualisiert `LastAccessed`, woran der gleitende Ablauf gemessen wird (Zeile `[7]`). Ein Scan zählt nicht als Zugriff, entfernt den Eintrag aber, sobald das gleitende Fenster verstrichen ist.

**Das Setzen eines bereits abgelaufenen Eintrags fügt ihn nicht hinzu.** Sind die an `Set` übergebenen Optionen beim Einfügen bereits abgelaufen (zum Beispiel ein absoluter Ablauf in der Vergangenheit), gelangt der Eintrag nie ins Dictionary, und seine Callbacks werden sofort mit `EvictionReason.Expired` ausgelöst.

**Die `SizeLimit`-Compaction ist ebenfalls asynchron.** Das Einfügen, das die Grenze überschreitet, wird abgelehnt (seine Callbacks werden mit `EvictionReason.Capacity` ausgelöst), und die Compaction wird im Thread-Pool eingereiht. Bis sie läuft, werden weitere Einfügungen, die nicht hineinpassen, ebenfalls abgelehnt. Abgelaufene Einträge werden zuerst entfernt, ein Cache voller veralteter Einträge wird also freigeräumt, bevor ein aktiver Eintrag verdrängt wird.

**Ablauf mit `FakeTimeProvider` zu testen, funktioniert nicht direkt.** `MemoryCacheOptions.Clock` ist eine `ISystemClock` (aus `Microsoft.Extensions.Internal`), kein `TimeProvider`. Ein Adapter von fünf Zeilen wie `ManualClock` oben, oder einer, der `FakeTimeProvider.GetUtcNow()` umschließt, schlägt die Brücke. Der Beitrag [zeitabhängigen Code mit TimeProvider und FakeTimeProvider testen](/de/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/) behandelt den Rest dieses Werkzeugkastens. Denken Sie daran, dass Scan und Callbacks weiterhin im echten Thread-Pool laufen, Tests also eine kurze Wartezeit oder ein Signal brauchen, wie es der Test oben tut.

**HybridCache ändert für L1 nichts davon.** Die standardmäßige In-Process-Ebene von `HybridCache` baut auf `IMemoryCache` auf, abgelaufene L1-Einträge folgen also exakt demselben Lebenszyklus. Wenn Sie zwischen den APIs wählen, erklärt der [Vergleich von HybridCache, IMemoryCache und IDistributedCache](/de/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/), welche Eviction-Steuerungen jede davon bietet.

## Verwandte Beiträge

- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/de/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [.NET 11 ergänzt MemoryCache um OpenTelemetry-Metriken](/de/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [HybridCache in ASP.NET Core 11 mit Redis als L2-Cache verwenden](/de/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [Ein Speicherleck im verwalteten Speicher mit dotnet-gcdump und dotnet-dump diagnostizieren](/de/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)
- [Zeitabhängigen Code mit TimeProvider und FakeTimeProvider in .NET 11 testen](/de/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)

## Quellen

- [`MemoryCache.cs` in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/MemoryCache.cs) (`PostProcessTryGetValue`, `StartScanForExpiredItemsIfNeeded`, `ScanForExpiredItems`, `Compact`)
- [`CacheEntry.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.cs) und [`CacheEntry.CacheEntryTokens.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.CacheEntryTokens.cs) (`CheckExpired`, Token-Callbacks, Dispatch der Post-Eviction-Callbacks)
- [`MemoryCacheOptions.ExpirationScanFrequency`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.memory.memorycacheoptions.expirationscanfrequency) auf MS Learn
- [Caching in .NET](https://learn.microsoft.com/dotnet/core/extensions/caching) auf MS Learn
- [Microsoft.Extensions.Caching.Memory auf NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Caching.Memory)
