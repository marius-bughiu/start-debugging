---
title: "期限切れの MemoryCache エントリはどうなるのか、そして実際にメモリから削除されるのはいつか"
description: "期限切れの MemoryCache エントリは、タイマーでは削除されません。読み取りが触れるか、スロットリングされたバックグラウンドスキャンが走るか、コンパクションが起動するまで、ディクショナリに残り続けます。それぞれがいつ起きるのか、そして積極的なエビクションを実現する方法を解説します。"
pubDate: 2026-10-21
tags:
  - "dotnet"
  - "dotnet-10"
  - "caching"
  - "memorycache"
  - "performance"
lang: "ja"
translationOf: "2026/10/what-happens-to-an-expired-memorycache-entry-and-when-is-it-removed"
translatedBy: "claude"
translationDate: 2026-10-21
---

`MemoryCache` のエントリは、期限が切れた時点では何も起きません。`Microsoft.Extensions.Caching.Memory` にはエントリごとのタイマーも、時計を監視するバックグラウンドスレッドもありません。そのため、エントリとその値、さらに値が参照するすべてのオブジェクトは、次の3つのいずれかが触れるまでキャッシュのディクショナリに残り続けます。そのキーの読み取り (`TryGetValue`、`Get`、`GetOrCreate`)、別のキャッシュ操作によってのみ開始され、かつ `ExpirationScanFrequency` (既定では1分) につき最大1回だけ実行される期限切れ項目のバックグラウンドスキャン、そしてコンパクション (`Compact()` または `SizeLimit` 超過時の経路) です。エントリがディクショナリから外れて初めて、GC が値を回収できるようになります。唯一の例外は `CancellationChangeToken` のような有効期限トークンです。トークンが発火すると、読み取りを待たずにエントリがただちに削除されます。

以下の内容はすべて、.NET 10.0.10 (SDK 10.0.302) 上の `Microsoft.Extensions.Caching.Memory` 10.0.13 と 11.0.0-rc.2.26504.105 で検証し、ソースは `dotnet/runtime` の `main` ブランチから読み取ったものです。どのシナリオでも両方のパッケージで出力は同一で、この部分の設計は長年変わっていません。

## 有効期限タイマーが存在しない理由

`MemoryCache` はエントリを `ConcurrentDictionary` に格納します。各 `CacheEntry` は絶対有効期限、スライディング有効期限、有効期限トークンを把握していますが、何かをスケジュールすることはありません。有効期限は遅延チェックで、キャッシュがたまたまエントリを参照したときに `CacheEntry.CheckExpired(DateTime utcNow)` が呼ばれます。

```csharp
// dotnet/runtime main, CacheEntry.cs (abridged)
internal bool CheckExpired(DateTime utcNow)
    => EvictionReason != EvictionReason.None
        || CheckForExpiredTime(utcNow)
        || (_tokens != null && _tokens.CheckForExpiredTokens(this));
```

これは意図的なトレードオフです。100万件のエントリに対してエントリごとにタイマーを持つと、タイマーのために実際の CPU とメモリを消費します。かといって単一の定期タイマーを使うと、本来アイドル状態のプロセスが永久に起こされ続けます。遅延方式ならキャッシュが静かなときのコストはゼロですが、その代わりに古いデータが想定より長く残ります。

したがって、本当の問いは"いつ期限が切れるか"ではなく"キャッシュが次にいつそれを見るか"です。答えは4つあります。

## 経路1: 同じキーの読み取りはただちに削除する

`TryGetValue` (`Get`、`GetOrCreate`、`GetOrCreateAsync` はすべてこれを経由します) は、見つけたエントリをチェックします。期限切れであれば、その場でディクショナリから削除され、呼び出しはミスを返します。

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

読み取りで期限切れの値が返ってくることはないため、正確性は問題になりません。問題になるのは、読み取らなかったすべてのエントリです。

## 経路2: スロットリングされたバックグラウンドスキャン

ほぼすべてのキャッシュ操作 (ヒット、ミス、`Set`、`Remove`、トークンによる期限切れ) は、最後に `StartScanForExpiredItemsIfNeeded` を呼び出します。

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

`ScanForExpiredItems` はスレッドプールのスレッド上ですべてのエントリを走査し、期限切れのものを削除します。このコードから直接わかることが2つあります。

1. **スキャンはスケジュールされるのではなく、トリガーされます。** キャッシュを呼び出すものが何もなければ、スキャンは一度も始まりません。期限切れエントリでいっぱいのアイドル状態のキャッシュは、それらをすべて無期限に保持し続けます。
2. **スキャンはスロットリングされます。** 忙しいキャッシュでも、全体の走査は `ExpirationScanFrequency` (既定は `TimeSpan.FromMinutes(1)`) につき最大1回しか始まりません。スキャン直後に期限が切れたエントリは、トラフィックが続いていても最大1分、トラフィックがなければ任意の長さ残る可能性があります。

## 経路3: コンパクション

`SizeLimit` を設定していて、挿入によって `Size` の合計が上限を超える場合、キャッシュは容量超過のコンパクションをスレッドプールにキューイングします。`Compact(double percentage)` を自分で呼び出すこともできます。どちらも同じ private の `Compact` メソッドを通り、その最初のステップは、優先度順 (`Low`、`Normal`、`High` の順で、各バケットは `LastAccessed` 順。`NeverRemove` には決して触れません) に有効なエントリを削除し始める前に、期限切れのエントリをすべて削除対象として集めることです。したがって `Compact(0)` は期限切れエントリだけをすべて削除し、それ以外は何もしないため、手動スイープとして便利です。

## 経路4: 有効期限トークンが唯一の積極的な経路

エントリに `ActiveChangeCallbacks == true` の `IChangeToken` (`CancellationChangeToken`、ファイルプロバイダーのトークン、構成再読み込みトークンなど) がある場合、キャッシュはそのトークンにコールバックを登録します。トークンが発火すると、コールバックがエントリを `EvictionReason.TokenExpired` としてマークしてディクショナリから削除する処理をキューに入れます。読み取りは不要です。

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

時間ベースの有効期限 (`AbsoluteExpiration`、`AbsoluteExpirationRelativeToNow`、`SlidingExpiration`) がこの経路を通ることはありません。

## 4つの経路をすべて確認するプローブ

何分も待たずにこれを確認する最も簡単な方法は、キャッシュに手動クロックを与えることです。`MemoryCacheOptions.Clock` は `ISystemClock` を受け取り (`TimeProvider` ではありません)、`MemoryCache.Count` は期限切れエントリを含む生のディクショナリ件数を返します。次のコードを `probe.cs` として保存し、`dotnet run probe.cs` で実行してください。

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

出力は、パッケージ 10.0.13 でも 11.0.0-rc.2.26504.105 でも同一です。

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

`[2]` の行は、人が最も驚く部分です。1000件の期限切れエントリが、期限から10分経っても、まったく無関係なキーの検索がスキャンを起動するまでキャッシュに残っています。`[6]` の行はメモリへの影響を示しています。期限切れの 10 MB の配列がまだ到達可能であり、キャッシュのディクショナリがまだそれを参照しているため、ブロッキングの完全な GC でも回収できません。

## "メモリから削除される"が実際に意味すること

キャッシュからの削除と GC による回収は、別々のイベントです。

1. 上記4つの経路のいずれかによって、エントリが `ConcurrentDictionary` から削除されます。この時点から、キャッシュは値のルートではなくなります。
2. エントリに削除後コールバックがある場合、キャッシュは `Task.Factory.StartNew` でそれらをスレッドプールにキューイングします。`CacheEntry` (つまりその `Value`) は、すべてのコールバックが実行されるまで、そのキューイングされた作業項目から到達可能なままです。もちろん、コールバックが値をどこかに保存する限りも同様です。
3. GC は、その値が存在する世代の次回のコレクションで値を回収します。長寿命のキャッシュ値は通常 gen 2 に昇格しているか、85,000 バイト以上であれば Large Object Heap にあるため、完全な GC をあまり行わないサーバーでは"次回のコレクション"までしばらくかかることがあります。

期限切れのはずの時間をかなり過ぎても、ヒープダンプでキャッシュしている型がメモリを支配している場合は、ルートを確認してください。`MemoryCache` と `CoherentState` を通る経路があるなら、エントリは単にまだディクショナリに残っているだけで、これはリークではなくスキャンの問題です。[dotnet-gcdump と dotnet-dump の解説](/ja/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)では、こうしたルートパスの読み方を説明しています。

## 削除後コールバックは遅く、別スレッドで実行される

`RegisterPostEvictionCallback` は、期限切れを観測するためによく使われる方法ですが、上記の遅延性をすべて引き継ぎます。時間ベースで期限切れになったエントリのコールバックは、期限の時刻には発火しません。エントリが実際に削除されたとき、つまり読み取り、スキャン、コンパクションの最中に発火し、それでもさらに遅れてスレッドプールのスレッド上で実行されます (`[4]` の行: コールバックが実行される前に、読み取りはミスを返しました)。コールバックは `EvictionReason` を受け取ります。時間ベースの期限切れは `Expired`、トークンは `TokenExpired`、サイズベースのコンパクションは `Capacity`、明示的な `Remove` は `Removed`、同じキーに再度 `Set` した場合は `Replaced` です。

コールバックからスローされた例外はキャッチされ、キャッシュの `ILogger` を通じて `EvictionCallback invoked failed` としてログ出力されるため、プロセスがクラッシュすることはありませんが、ログを見ない限り表面化することもありません。

時間ベースの有効期限で、これらのコールバックを土台に"期限切れ時の更新"を組み立ててはいけません。静かなサーバーでは、何らかのリクエストが最初にミスを観測するまで更新は行われず、本来の目的が果たせません。

## 期限どおりの積極的なエビクションを実現する

トラフィックに依存せず、期限に近いタイミングでエントリをキャッシュから外したい場合は、タイマーで発火するトークンを付けます。遅延付きの `CancellationTokenSource` が最も簡単です。

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

遅延時間が経過するとトークンが発火し、キャッシュがエントリを削除し、削除後コールバックが `CancellationTokenSource` を破棄します (エントリがそれ以前に置き換えられたり削除されたりした場合にも実行されるため、タイマーがリークすることはありません)。コストはエントリごとに1つのタイマーなので、100万件の小さな項目を持つキャッシュではなく、期限どおりに消えなければならない少数の大きなエントリや機密性の高いエントリに使ってください。

それ以外の場合は、通常は次の2つの調整で十分です。

- **`ExpirationScanFrequency` を下げる。** ASP.NET Core では `services.AddMemoryCache(o => o.ExpirationScanFrequency = TimeSpan.FromSeconds(10));` とします。各スキャンはディクショナリ全体を走査するため、非常に大きなキャッシュでは、即時性と引き換えに CPU を消費します。また、スキャンを起動するには何らかの操作が必要な点は変わりません。
- **独自のスケジュールでスイープする。** `BackgroundService` または `PeriodicTimer` で N 秒ごとに `cache.Compact(0)` を呼び出せば、キャッシュがアイドル状態でも期限切れエントリをすべて削除できます。`Compact` は `IMemoryCache` ではなく具象クラスの `MemoryCache` に定義されているため、キャストするか、`MemoryCache` を注入してください。

## 知っておくべき落とし穴

**`Count` には期限切れエントリが含まれます。** `MemoryCache.Count`、`MemoryCache.Keys` (.NET 9 で追加)、`GetCurrentStatistics().CurrentEntryCount` はいずれも生のディクショナリを報告するため、ダッシュボードには、すべて期限を過ぎた何千もの"有効な"エントリが表示されることがあります。[.NET 11 の MemoryCache メトリクスの記事](/ja/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)で説明している組み込みの OpenTelemetry メーターも同じ統計を読み取るため、同じ注意点があります。

**スライディング有効期限は、読み取りでリセットされ、スキャンではリセットされません。** ヒットのたびに `LastAccessed` が更新され、スライディング有効期限はこれを基準に測定されます (`[7]` の行)。スキャンはアクセスとして数えられませんが、スライディングウィンドウを過ぎたエントリは削除します。

**すでに期限切れのエントリを設定しても追加されません。** `Set` に渡したオプションが挿入時点ですでに期限切れ (たとえば過去の絶対有効期限) の場合、エントリはディクショナリに入らず、そのコールバックは `EvictionReason.Expired` ですぐに発火します。

**`SizeLimit` のコンパクションも非同期です。** 上限を超える挿入は拒否され (そのコールバックは `EvictionReason.Capacity` で発火します)、コンパクションはスレッドプールにキューイングされます。それが実行されるまでは、収まらない挿入は引き続き拒否されます。期限切れのエントリが最初に削除されるため、古いエントリでいっぱいのキャッシュは、有効なエントリがエビクションされる前に回収されます。

**`FakeTimeProvider` による有効期限のテストは、そのままでは接続できません。** `MemoryCacheOptions.Clock` は `TimeProvider` ではなく、(`Microsoft.Extensions.Internal` の) `ISystemClock` です。上の `ManualClock` のような5行ほどのアダプター、または `FakeTimeProvider.GetUtcNow()` をラップするアダプターが橋渡しになります。このツール群の残りの部分については、[TimeProvider と FakeTimeProvider で時間依存コードをテストする方法](/ja/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)で扱っています。スキャンとコールバックは依然として実際のスレッドプール上で実行されるため、プローブのように、テストでは短い待機かシグナルが必要です。

**HybridCache は L1 に関するこれらの挙動を何も変えません。** `HybridCache` の既定のインプロセス階層は `IMemoryCache` 上に構築されているため、期限切れの L1 エントリはまったく同じライフサイクルをたどります。どの API を選ぶか迷っている場合は、[HybridCache、IMemoryCache、IDistributedCache の比較](/ja/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)で、それぞれがどのエビクション制御を公開しているかを説明しています。

## 関連記事

- [HybridCache vs IMemoryCache vs IDistributedCache in .NET 11](/ja/2026/06/hybridcache-vs-imemorycache-vs-idistributedcache-in-dotnet-11/)
- [.NET 11 adds OpenTelemetry metrics to MemoryCache](/ja/2026/06/dotnet-11-memorycache-opentelemetry-metrics/)
- [How to use HybridCache in ASP.NET Core 11 with Redis as the L2 cache](/ja/2026/06/how-to-use-hybridcache-in-aspnetcore-11-with-redis-as-the-l2-cache/)
- [How to diagnose a managed memory leak with dotnet-gcdump and dotnet-dump](/ja/2026/07/how-to-diagnose-a-managed-memory-leak-with-dotnet-gcdump-and-dotnet-dump/)
- [How to test time-dependent code with TimeProvider and FakeTimeProvider in .NET 11](/ja/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)

## 出典

- [`MemoryCache.cs` in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/MemoryCache.cs) (`PostProcessTryGetValue`、`StartScanForExpiredItemsIfNeeded`、`ScanForExpiredItems`、`Compact`)
- [`CacheEntry.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.cs) と [`CacheEntry.CacheEntryTokens.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.Caching.Memory/src/CacheEntry.CacheEntryTokens.cs) (`CheckExpired`、トークンコールバック、削除後コールバックのディスパッチ)
- MS Learn の [`MemoryCacheOptions.ExpirationScanFrequency`](https://learn.microsoft.com/dotnet/api/microsoft.extensions.caching.memory.memorycacheoptions.expirationscanfrequency)
- MS Learn の [Caching in .NET](https://learn.microsoft.com/dotnet/core/extensions/caching)
- [Microsoft.Extensions.Caching.Memory on NuGet](https://www.nuget.org/packages/Microsoft.Extensions.Caching.Memory)
