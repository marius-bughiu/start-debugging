---
title: "Что происходит с истёкшей записью MemoryCache и когда она на самом деле удаляется из памяти?"
description: "Истёкшая запись MemoryCache не удаляется по таймеру. Она остаётся в словаре, пока к ней не обратится чтение, не запустится фоновое сканирование с ограничением частоты или не начнётся уплотнение. Вот когда именно происходит каждое из этих событий и как добиться немедленного вытеснения."
pubDate: 2026-10-21
tags:
  - "dotnet"
  - "dotnet-10"
  - "caching"
  - "memorycache"
  - "performance"
lang: "ru"
translationOf: "2026/10/what-happens-to-an-expired-memorycache-entry-and-when-is-it-removed"
translatedBy: "claude"
translationDate: 2026-10-21
---

В момент истечения срока с записью `MemoryCache` ничего не происходит. В `Microsoft.Extensions.Caching.Memory` нет таймера на каждую запись и нет фонового потока, который следил бы за часами, поэтому запись, её значение и всё, на что значение ссылается, остаются в словаре кеша, пока к ним не обратится одно из трёх событий: чтение этого ключа (`TryGetValue`, `Get`, `GetOrCreate`), фоновое сканирование истёкших элементов, которое запускается только другой операцией кеша и не чаще одного раза за `ExpirationScanFrequency` (по умолчанию 1 минута), либо уплотнение (`Compact()` или путь переполнения `SizeLimit`). Только после того как запись покинула словарь, сборщик мусора может освободить значение. Единственное исключение: токен истечения, например `CancellationChangeToken`. Когда он срабатывает, запись удаляется сразу, без всякого чтения.

Всё ниже проверено на `Microsoft.Extensions.Caching.Memory` 10.0.13 и 11.0.0-rc.2.26504.105 на .NET 10.0.10 (SDK 10.0.302), исходный код читался из ветки `main` репозитория `dotnet/runtime`. Оба пакета вывели одинаковый результат во всех сценариях, а эта часть устройства не менялась годами.

## Почему нет таймера истечения

`MemoryCache` хранит записи в `ConcurrentDictionary`. Каждая `CacheEntry` знает свой абсолютный срок, скользящий срок и токены истечения, но ничего не планирует. Истечение проверяется лениво, через `CacheEntry.CheckExpired(DateTime utcNow)`, и кеш вызывает эту проверку всякий раз, когда ему случается посмотреть на запись:

```csharp
// dotnet/runtime main, CacheEntry.cs (abridged)
internal bool CheckExpired(DateTime utcNow)
    => EvictionReason != EvictionReason.None
        || CheckForExpiredTime(utcNow)
        || (_tokens != null && _tokens.CheckForExpiredTokens(this));
```

Это осознанный компромисс. Кеш с миллионом записей и таймером на каждую потратил бы заметное время процессора и память на таймеры. Один периодический таймер бесконечно будил бы иначе простаивающий процесс. Ленивая схема ничего не стоит, пока кеш неактивен, ценой того, что устаревшие данные хранятся дольше, чем можно предположить.

Поэтому настоящий вопрос звучит не "когда запись истекает", а "когда кеш в следующий раз на неё посмотрит". Ответов четыре.

## Путь 1: чтение того же ключа удаляет запись немедленно

`TryGetValue` (через него проходят `Get`, `GetOrCreate` и `GetOrCreateAsync`) проверяет найденную запись. Если она истекла, запись тут же удаляется из словаря, а вызов сообщает о промахе:

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

Вы никогда не получите из чтения истёкшее значение, так что с корректностью всё в порядке. Проблема во всём том, что вы не читали.

## Путь 2: фоновое сканирование с ограничением частоты

Почти любая операция кеша (попадание, промах, `Set`, `Remove`, истечение по токену) заканчивается вызовом `StartScanForExpiredItemsIfNeeded`:

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

`ScanForExpiredItems` обходит все записи в потоке пула потоков и удаляет истёкшие. Из этого кода напрямую следуют два вывода:

1. **Сканирование запускается событием, а не расписанием.** Если никто не обращается к кешу, сканирование не начнётся никогда. Простаивающий кеш, полный истёкших записей, хранит их все бесконечно.
2. **Сканирование ограничено по частоте.** Даже на загруженном кеше полный обход стартует не чаще одного раза за `ExpirationScanFrequency`, по умолчанию `TimeSpan.FromMinutes(1)`. Запись, истёкшая сразу после сканирования, может прожить до минуты при непрерывном трафике и сколь угодно долго без трафика.

## Путь 3: уплотнение

Если задан `SizeLimit` и вставка увеличила бы суммарный `Size` сверх него, кеш ставит в очередь пула потоков уплотнение из-за переполнения. Вы также можете сами вызвать `Compact(double percentage)`. Оба варианта проходят через один и тот же закрытый метод `Compact`, первым шагом которого собираются все истёкшие записи для удаления, и только потом начинается вытеснение живых записей по приоритету (`Low`, затем `Normal`, затем `High`, внутри каждой группы по `LastAccessed`; `NeverRemove` не затрагивается никогда). Поэтому `Compact(0)` удаляет все истёкшие записи и больше ничего, что удобно для ручной очистки.

## Путь 4: токены истечения, единственный немедленный путь

Если у записи есть `IChangeToken` с `ActiveChangeCallbacks == true` (`CancellationChangeToken`, токен файлового провайдера, токен перезагрузки конфигурации), кеш регистрирует на нём обратный вызов. Когда токен срабатывает, вызов ставит в очередь работу, которая помечает запись как `EvictionReason.TokenExpired` и удаляет её из словаря, без всякого чтения:

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

Истечение по времени (`AbsoluteExpiration`, `AbsoluteExpirationRelativeToNow`, `SlidingExpiration`) этим путём никогда не идёт.

## Проба, показывающая все четыре пути

Проще всего увидеть это, не дожидаясь минутами, дав кешу ручные часы. `MemoryCacheOptions.Clock` принимает `ISystemClock` (а не `TimeProvider`), а `MemoryCache.Count` возвращает сырое количество элементов словаря, включая истёкшие записи. Сохраните это как `probe.cs` и запустите командой `dotnet run probe.cs`:

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

Вывод, одинаковый для пакетов 10.0.13 и 11.0.0-rc.2.26504.105:

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

Строка `[2]` удивляет больше всего: тысяча истёкших записей через десять минут после срока всё ещё в кеше, пока поиск совершенно постороннего ключа не запустит сканирование. Строка `[6]` показывает последствия для памяти: истёкший массив в 10 МБ остаётся достижимым, и полная блокирующая сборка мусора не может его собрать, потому что словарь кеша всё ещё на него ссылается.

## Что на самом деле значит "удалено из памяти"

Удаление из кеша и освобождение сборщиком мусора это два отдельных события:

1. Запись удаляется из `ConcurrentDictionary` одним из четырёх путей выше. С этого момента кеш больше не удерживает значение.
2. Если у записи есть обратные вызовы после вытеснения, кеш ставит их в очередь пула потоков через `Task.Factory.StartNew`. `CacheEntry` (а значит, и её `Value`) остаётся достижимой из этого элемента очереди, пока не выполнены все обратные вызовы, и, конечно, столько, сколько любой из них хранит значение где-либо ещё.
3. Сборщик мусора освобождает значение при ближайшей сборке того поколения, в котором оно находится. Долгоживущее значение кеша обычно уже переведено в поколение 2 или лежит в куче больших объектов, если его размер 85 000 байт или больше, поэтому "ближайшая сборка" на сервере, который редко делает полные сборки, может наступить нескоро.

Если дамп кучи показывает, что ваш кешируемый тип занимает основную часть памяти спустя долгое время после ожидаемого истечения, проверьте корни: путь через `MemoryCache` и `CoherentState` означает, что запись просто всё ещё в словаре, то есть проблема в сканировании, а не в утечке. [Разбор dotnet-gcdump и dotnet-dump](/ru/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/) показывает, как читать эти пути корней.

## Обратные вызовы после вытеснения запаздывают и идут в другом потоке

`RegisterPostEvictionCallback` обычно используют, чтобы наблюдать истечение, и он наследует всю описанную выше ленивость. Обратный вызов для записи, истёкшей по времени, срабатывает не в момент истечения. Он срабатывает, когда запись действительно удалена, то есть во время чтения, сканирования или уплотнения, и даже тогда выполняется позже, в потоке пула потоков (строка `[4]`: чтение вернуло промах раньше, чем выполнился обратный вызов). Обратный вызов получает `EvictionReason`: `Expired` при истечении по времени, `TokenExpired` для токенов, `Capacity` при уплотнении по размеру, `Removed` при явном `Remove` и `Replaced`, когда вы снова делаете `Set` с тем же ключом.

Исключения, выброшенные из обратного вызова, перехватываются и записываются как `EvictionCallback invoked failed` через `ILogger` кеша, поэтому процесс они не роняют, но и не видны, пока вы не посмотрите журналы.

Не стройте "обновление при истечении" на этих обратных вызовах вместе с истечением по времени. На спокойном сервере обновление не произойдёт, пока какой-нибудь запрос сам не заметит промах, а это лишает смысла всю затею.

## Как добиться немедленного вытеснения вовремя

Если запись должна покинуть кеш близко к моменту истечения и не зависеть от трафика, прикрепите токен, который срабатывает по таймеру. Проще всего взять `CancellationTokenSource` с задержкой:

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

Когда задержка проходит, токен срабатывает, кеш удаляет запись, а обратный вызов после вытеснения освобождает `CancellationTokenSource` (он же выполняется, если запись заменена или удалена раньше, так что таймер не утекает). Цена: один таймер на запись, поэтому используйте это для горстки крупных или чувствительных записей, которые должны уйти вовремя, а не для кеша с миллионом мелких элементов.

Для всего остального обычно хватает двух рычагов:

- **Уменьшите `ExpirationScanFrequency`.** В ASP.NET Core: `services.AddMemoryCache(o => o.ExpirationScanFrequency = TimeSpan.FromSeconds(10));`. Каждое сканирование обходит весь словарь, поэтому на очень большом кеше вы меняете процессорное время на скорость реакции. Для запуска сканирования всё равно нужна какая-то операция.
- **Очищайте по собственному расписанию.** `BackgroundService` или `PeriodicTimer`, который каждые N секунд вызывает `cache.Compact(0)`, удаляет все истёкшие записи, даже когда кеш простаивает. `Compact` определён в конкретном классе `MemoryCache`, а не в `IMemoryCache`, поэтому приведите тип или внедрите `MemoryCache`.

## Подводные камни, о которых стоит знать

**`Count` включает истёкшие записи.** `MemoryCache.Count`, `MemoryCache.Keys` (добавлен в .NET 9) и `GetCurrentStatistics().CurrentEntryCount` отражают сырой словарь, поэтому на панели могут отображаться тысячи "живых" записей, которые все давно истекли. Встроенная метрика OpenTelemetry, описанная в [статье о метриках MemoryCache в .NET 11](/ru/2026/06/dotnet-11-memorycache-opentelemetry-metrics/), читает ту же статистику с той же оговоркой.

**Скользящее истечение сбрасывается чтениями, а не сканированиями.** Каждое попадание обновляет `LastAccessed`, от которого и отсчитывается скользящее истечение (строка `[7]`). Сканирование не считается обращением, но удаляет запись, когда скользящее окно прошло.

**Установка уже истёкшей записи её не добавляет.** Если параметры, переданные в `Set`, уже истекли на момент вставки (например, абсолютный срок в прошлом), запись никогда не попадает в словарь, а её обратные вызовы сразу срабатывают с `EvictionReason.Expired`.

**Уплотнение по `SizeLimit` тоже асинхронно.** Вставка, пересекающая лимит, отклоняется (её обратные вызовы срабатывают с `EvictionReason.Capacity`), а уплотнение ставится в очередь пула потоков. Пока оно не выполнилось, последующие вставки, которые не помещаются, тоже отклоняются. Истёкшие записи удаляются первыми, поэтому кеш, полный устаревших записей, очищается до вытеснения любой живой.

**Тестирование истечения с `FakeTimeProvider` напрямую не подключается.** `MemoryCacheOptions.Clock` это `ISystemClock` (из `Microsoft.Extensions.Internal`), а не `TimeProvider`. Мостом служит адаптер в пять строк вроде `ManualClock` выше или обёртка над `FakeTimeProvider.GetUtcNow()`; об остальном наборе инструментов рассказывает статья [тестирование кода, зависящего от времени, с TimeProvider и FakeTimeProvider](/ru/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/). Помните, что сканирование и обратные вызовы по-прежнему выполняются в настоящем пуле потоков, поэтому тестам нужно короткое ожидание или сигнал, как в пробе.

**HybridCache ничего из этого не меняет для L1.** Внутрипроцессный уровень `HybridCache` по умолчанию построен на `IMemoryCache`, поэтому истёкшие записи L1 проходят точно такой же жизненный цикл. Если вы выбираете между API, [сравнение HybridCache, IMemoryCache и IDistributedCache](/ru/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/) объясняет, какие средства управления вытеснением даёт каждый из них.

## Связанные материалы

- [HybridCache, IMemoryCache и IDistributedCache в .NET 11](/ru/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [В .NET 11 в MemoryCache добавлены метрики OpenTelemetry](/ru/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [Как использовать HybridCache в ASP.NET Core 11 с Redis в роли кеша L2](/ru/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [Как диагностировать утечку управляемой памяти с помощью dotnet-gcdump и dotnet-dump](/ru/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)
- [Как тестировать код, зависящий от времени, с TimeProvider и FakeTimeProvider в .NET 11](/ru/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)

## Источники

- [`MemoryCache.cs` в dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/MemoryCache.cs) (`PostProcessTryGetValue`, `StartScanForExpiredItemsIfNeeded`, `ScanForExpiredItems`, `Compact`)
- [`CacheEntry.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.cs) и [`CacheEntry.CacheEntryTokens.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.CacheEntryTokens.cs) (`CheckExpired`, обратные вызовы токенов, диспетчеризация обратных вызовов после вытеснения)
- [`MemoryCacheOptions.ExpirationScanFrequency`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.memory.memorycacheoptions.expirationscanfrequency) в MS Learn
- [Caching in .NET](https://learn.microsoft.com/dotnet/core/extensions/caching) в MS Learn
- [Microsoft.Extensions.Caching.Memory на NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Caching.Memory)
