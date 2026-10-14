---
title: "C# で待機するときの Thread.Sleep と Task.Delay と SpinWait の違い"
description: "非同期コードでの時間指定の待機には await Task.Delay を使い、Thread.Sleep は自分が所有する専用スレッドでのみ使い、SpinWait はロックフリーのコード内でのマイクロ秒未満の待機にだけ使います。条件を待つ場合は、この 3 つではなくシグナル (ManualResetEventSlim、SemaphoreSlim、TaskCompletionSource) を使ってください。.NET 10.0.10 で計測しています。"
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
  - "async"
  - "performance"
lang: "ja"
translationOf: "2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-14
---

時間指定の一時停止には、非同期コードであれば `await Task.Delay(...)` を使ってください。待機中にスレッドを解放するためです。`Thread.Sleep` は自分で作成したスレッド (コンソールのループや専用ワーカー) でのみ使い、スレッドプールや UI スレッドでは使わないでください。`SpinWait` は、待機が数マイクロ秒以内に終わると見込める場合、主にロックフリーのコード内でのみ使います。そして、時間の経過ではなく**何かが起こること**を待っているのであれば、この 3 つはどれも適切なツールではありません。`ManualResetEventSlim`、`SemaphoreSlim`、`TaskCompletionSource` などのシグナルを使ってください。私の計測では、どのポーリングループよりも約 50 倍速く起床しました。

この記事の数値はすべて、macOS 26.6 上の 10 コアの Apple M4 で、.NET 10.0.10 (SDK 10.0.302)、C# 14 を使って計測したものです。API 自体は何年も変わっていません。`Task.Delay` は .NET Framework 4.5 から、`SpinWait` は 4.0 から存在しており、ここで述べる内容は .NET 8、9、そして .NET 11 のプレビューにも同様に当てはまります。

## 比較の一覧

| | `Thread.Sleep` | `await Task.Delay` | `SpinWait` |
| --- | --- | --- | --- |
| 待機中にスレッドを占有するか | はい、ブロックされる | いいえ、スレッドはプールに戻る | はい、実行中または譲渡中 |
| 待機中の CPU 時間 (500 ms、計測値) | 0 ms | 0 ms | `SpinUntil` で 4 ms、`SpinOnce(-1)` で 500 ms |
| 実際の最短待機時間 (`1` ms を指定、macOS) | 約 1.5 ms | 約 1.3 ms | 早期のスピン 1 回あたり約 1 us |
| Windows での実際の最短待機時間 (既定のタイマー) | 約 1 から 15.6 ms | 約 15.6 ms | 早期のスピン 1 回あたり約 1 us |
| キャンセル可能か | いいえ | はい、`CancellationToken` 経由 | 自前の条件によってのみ |
| 偽の時刻でテストできるか | いいえ | はい、`Task.Delay(TimeSpan, TimeProvider)` (.NET 8 以降) | いいえ |
| スレッドプールのスレッドで安全か | いいえ | はい | マイクロ秒単位の間だけ |
| UI スレッドで安全か | いいえ、UI がフリーズする | はい | いいえ |
| 典型的な用途 | 専用スレッドのループ、簡単なコンソールツール | リトライのバックオフ、スロットリング、非同期コードでのポーリング | ロックフリーのリトライループ、スピンしてからブロックするプリミティブ |

## それぞれがスレッドに実際に行うこと

`Thread.Sleep(ms)` は、呼び出し元の OS スレッドを一時停止します。スケジューラーはそのスレッドを CPU から外し、指定した時間が経過するまで考慮しません。CPU は消費されませんが、スレッド自体は存在し続け、スタックを保持したままで、他のことは何もできません。待つことだけが仕事のスレッドであれば問題ありません。しかし、共有リソースに属するスレッドでは問題になります。

`Task.Delay(ms)` は、内部の `TimerQueueTimer` が発火したときに完了する `Task` を返します。これを `await` すると、メソッドは呼び出し元に戻り、スレッドはプール (または UI のメッセージループ) に戻り、メソッドの残りの部分はタイマーが発火したときに継続としてスケジュールされます。遅延が保留中の間は、メソッドに関連付けられたスレッドは一切ありません。

`SpinWait` はスレッドを CPU 上に保持したまま、繰り返し確認します。重要なメソッドは `SpinOnce()` の 1 つだけの構造体で、その動作はこれまでに何回呼び出したかによって変わります。[.NET 10 のソース](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs)を読むと、定数は `YieldThreshold = 10`、`Sleep0EveryHowManyYields = 5`、`DefaultSleep1Threshold = 20` です。

- 0 から 9 回目の呼び出しは `Thread.SpinWait(n)` を実行します。反復ごとに長くなる CPU の pause 命令によるビジーループです。
- 10 回目以降は、1 回おきに `Thread.Yield()` または `Thread.Sleep(0)` でタイムスライスを譲ります。
- 20 回目以降は、毎回 `Thread.Sleep(1)` を実行します。
- シングルプロセッサのマシンではスピンを完全に省略し、最初の呼び出しから譲渡します。そこでスピンしても、待っている相手のスレッドを遅らせるだけだからです。

つまり "`SpinWait`" は、スピンというよりも段階的にエスカレートするはしごです。この点が、以下で述べるトレードオフのほとんどを決めます。

## 計測: "1 ms 待つ" は実際にどれくらいかかるか

このプローブは、それぞれを 200 回呼び出して時間を計り、中央値と 99 パーセンタイルを出力します。

```csharp
// .NET 10.0.10, C# 14, dotnet run probe.cs
using System.Diagnostics;

foreach (var ms in new[] { 0, 1, 10, 15 })
{
    var sleep = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        Thread.Sleep(ms);
        sleep.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    var delay = new List<double>();
    for (int i = 0; i < 200; i++)
    {
        var t = Stopwatch.GetTimestamp();
        await Task.Delay(ms);
        delay.Add(Stopwatch.GetElapsedTime(t).TotalMilliseconds);
    }

    sleep.Sort(); delay.Sort();
    Console.WriteLine($"{ms} ms: Sleep p50={sleep[100]:F3} | Delay p50={delay[100]:F3}");
}
```

| 指定値 | `Thread.Sleep` p50 | `Thread.Sleep` p99 | `Task.Delay` p50 | `Task.Delay` p99 |
| --- | --- | --- | --- | --- |
| 0 ms | 0.000 ms | 0.015 ms | 0.000 ms | 0.001 ms |
| 1 ms | 1.510 ms | 1.633 ms | 1.297 ms | 1.513 ms |
| 10 ms | 12.012 ms | 12.033 ms | 12.043 ms | 12.083 ms |
| 15 ms | 16.763 ms | 17.071 ms | 17.023 ms | 17.215 ms |

ここから分かることが 2 つあります。1 つ目は、どちらも "少なくともこれだけの長さ" であり、"ぴったりこの長さ" ではないことです。macOS では、超過は一定して 0.3 から 2 ms でした。2 つ目は、`Task.Delay(0)` は同期的に完了することです。完了済みのタスクを返すため、`await Task.Delay(0)` はまったく譲渡しません。非同期コードで譲渡したい場合は、`await Task.Yield()` がそのための API です。

Windows では差がはるかに大きくなります。[`Task.Delay` のドキュメント](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay)には、遅延はシステムクロックに依存し、その分解能は Windows で約 15 ms であると記載されています。そのため、そこでの `Task.Delay(1)` は通常約 15.6 ms かかります。Windows 上の `Thread.Sleep(1)` は、マシン上のいずれかのプロセスがグローバルなタイマー分解能を引き上げているかどうかによって、1 ms に近くなることも 15.6 ms に近くなることもあります。どちらの API も高精度のタイマーではありません。ループが 1 ms のティックに依存している場合、既定の Windows マシンでは期待する速度のごく一部でしか動作しません。

## 計測: `Thread.Sleep` がスレッドプールに与える影響

`Thread.Sleep` が危険な本当の理由は、CPU でも精度でもありません。共有プールに与える影響です。このプローブは、それぞれ 1 秒待つ 200 個のワークアイテムをキューに入れ、その後、専用スレッドから、新しいワークアイテムが開始するまでにどれだけ待たされるかを計測します。

```csharp
// .NET 10.0.10, C# 14, dotnet run probe3.cs -- sleep|delay
using System.Diagnostics;

string mode = args[0];
var sw = Stopwatch.StartNew();

var tasks = Enumerable.Range(0, 200).Select(_ => Task.Run(async () =>
{
    if (mode == "sleep") Thread.Sleep(1000);
    else await Task.Delay(1000);
})).ToArray();

var sampler = new Thread(() =>
{
    using var started = new ManualResetEventSlim();
    var t = Stopwatch.GetTimestamp();
    ThreadPool.UnsafeQueueUserWorkItem(_ => started.Set(), null);
    started.Wait();
    Console.WriteLine($"new work item waited {Stopwatch.GetElapsedTime(t).TotalMilliseconds:F0} ms");
});
sampler.Start();

Task.WaitAll(tasks);
sampler.Join();
Console.WriteLine($"{mode}: 200 waits done in {sw.ElapsedMilliseconds} ms, pool threads = {ThreadPool.ThreadCount}");
```

| | `Thread.Sleep(1000)` | `await Task.Delay(1000)` |
| --- | --- | --- |
| 1 秒の待機 200 件がすべて完了するまでの時間 | 18,034 ms | 1,005 ms |
| 終了時のプールのスレッド数 | 12 | 11 |
| 無関係なワークアイテムが開始するまでの遅延 | 17,030 ms | 1 ms |

`Task.Delay` では 200 件の待機がすべて重なり、バッチ全体が 10 スレッドで 1 秒かかります。`Thread.Sleep` では、プールが同時に実行できるスリープの数はスレッド数までなので、バッチは約 10 件ずつのグループに直列化されます。その後ろにキューされた他のすべての処理、ここでは単純な `started.Set()` が、**17 秒**もキューで待たされました。プールがスレッドを追加して状況を救ったわけではない点に注意してください。ワークアイテムは毎秒完了し続けていたため、山登り法のロジックによるスレッド数の増加は 10 から 12 までにとどまりました。

ASP.NET Core アプリでは、そのキューされたワークアイテムは次の HTTP リクエストです。これは典型的なスレッドプール枯渇のパターンであり、リクエストハンドラーや `BackgroundService` の内部での `Thread.Sleep` は、これを引き起こす最も簡単な方法の 1 つです。`Task.Delay(1000).Wait()` でも同じことが起こります。これは、アロケーションが増えただけの `Thread.Sleep` です。このパターンに見覚えがある場合は、sync-over-asyncの側面を扱った、[`.Result` と `.Wait()` によるデッドロックの修正](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)の記事を参照してください。

## 計測: `SpinWait` の CPU コストと起床レイテンシ

`SpinWait.SpinUntil(condition)` は、待っている間ずっとコアを使い切るように思えます。しかし、段階的なはしごのおかげで、そうはなりません。

| 待機方式、実時間 500 ms | 使用した CPU 時間 |
| --- | --- |
| `Thread.Sleep(500)` | 0 ms |
| `await Task.Delay(500)` | 0 ms |
| `SpinWait.SpinUntil(...)` | 4 ms |
| `SpinOnce(sleep1Threshold: -1)` ループ | 500 ms (コア 1 つ分すべて) |
| 空の `while` ループ | 499 ms |

最初の 10 回の純粋なスピンは合計で 9.8 us、10 から 19 回目のスピンはさらに 10 us かかりました。それ以降は、`SpinOnce()` の呼び出しがすべて `Thread.Sleep(1)` になり、1 回あたり約 1,265 us と計測しました。`sleep1Threshold: -1` を渡して `Sleep(1)` の段階を無効にすると、名前のとおりのもの、つまり張り付いたコアになります。

トレードオフのもう半分は、待っている対象が発生したことを各方式がどれだけ速く検知できるかです。ここでは、2 つ目のスレッドがランダムな 0 から 3 ms の後にフラグを設定し、メインスレッドがフラグの設定から検知までの時間を計測します (各 200 回)。

```csharp
// .NET 10.0.10, C# 14
int flag = 0;
using var ev = new ManualResetEventSlim();
// setter thread: busy-waits a random 0-3 ms, then
//   Volatile.Write(ref flag, 1); ev.Set();

SpinWait.SpinUntil(() => Volatile.Read(ref flag) == 1);       // "spinuntil"
while (Volatile.Read(ref flag) == 0) Thread.Sleep(1);         // "sleep1"
while (Volatile.Read(ref flag) == 0) await Task.Delay(1);     // "delay1"
ev.Wait();                                                    // "mres"
```

| 方式 | 起床遅延 p50 | 起床遅延 p90 |
| --- | --- | --- |
| `SpinWait.SpinUntil` | 745 us | 1,182 us |
| `Thread.Sleep(1)` によるポーリング | 710 us | 1,158 us |
| `await Task.Delay(1)` によるポーリング | 836 us | 1,205 us |
| `ManualResetEventSlim.Wait()` | 15 us | 37 us |

待機が約 20 us を超えると、`SpinUntil` は見栄えのよい名前をつけただけの `Thread.Sleep(1)` のポーリングループであり、起床も速くなりません。イベントベースの待機は中央値で 50 倍速く、待機中に CPU を使いませんでした。`ManualResetEventSlim` と `SemaphoreSlim` はブロックする前に短時間スピンするため、`SpinWait` の安価な高速パスと、カーネル待機の効率的な低速パスを 1 回の呼び出しで得られます。

## `await Task.Delay` を選ぶとき

- **非同期コードでのリトライとバックオフ。** 429 の後にリトライする HTTP クライアントや、データベースの再接続ループなどです。リクエストの `CancellationToken` を渡して、シャットダウンやクライアントの切断によって、待機が保留されたままにならずキャンセルされるようにします。
- **`BackgroundService` での定期処理。** ループ内の `await Task.Delay(interval, stoppingToken)` で問題ありません。処理時間の分だけずれないティックが必要な場合は、`PeriodicTimer` (.NET 6 以降) のほうが適しています。
- **UI スレッドでのスロットリングやデバウンス。** WPF、WinForms、MAUI、Blazor はいずれも、遅延が保留中の間 UI スレッドが空いているため、応答性を保てます。
- **ユニットテストしたいあらゆる処理。** オーバーロード `Task.Delay(TimeSpan, TimeProvider, CancellationToken)` (.NET 8 以降) を使うと、テストで `FakeTimeProvider` により時間を即座に進められます。これについては、[`TimeProvider` を使った時間依存コードのテスト](/ja/2026/07/how-to-test-time-dependent-code-with-timeprovider-and-faketimeprovider-in-dotnet-11/)の記事で解説しました。

```csharp
// .NET 10, C# 14
async Task<HttpResponseMessage> GetWithRetryAsync(
    HttpClient http, string url, TimeProvider time, CancellationToken ct)
{
    for (int attempt = 0; ; attempt++)
    {
        var response = await http.GetAsync(url, ct);
        if (response.StatusCode != System.Net.HttpStatusCode.TooManyRequests || attempt == 4)
            return response;

        response.Dispose();
        var backoff = TimeSpan.FromMilliseconds(200 * Math.Pow(2, attempt));
        await Task.Delay(backoff, time, ct); // cancellable, testable, holds no thread
    }
}
```

## `Thread.Sleep` を選ぶとき

- **自分で作成して所有するスレッド。** ハードウェアやファイルを毎秒ポーリングする `new Thread(...)` で、そのスレッド上には他に何もスケジュールされていない場合です。ブロックしても、他の誰かが必要とするものは何も失われません。
- **同期的なコンソールツールやスクリプト。** 非同期ではない `Main` で、手順の間に一時停止するだけでよい場合です。枯渇させるプールや UI スレッドがありません。
- **ブロッキングを意図的に再現する場合。** 上記のプール枯渇のプローブのように、遅い同期呼び出しをシミュレートする必要があるテストやデモです。

専用スレッドであっても、代わりに `WaitHandle.WaitOne(timeout)` や `CancellationToken.WaitHandle.WaitOne(timeout)` を検討してください。同じ時間だけ待機しますが、誰かがスレッドの停止を要求すると早期に戻ります。これは `Thread.Sleep` にはできないことです。

```csharp
// .NET 10, C# 14: a dedicated worker thread that can be stopped promptly
void PollLoop(CancellationToken ct)
{
    while (!ct.IsCancellationRequested)
    {
        PollDevice();
        ct.WaitHandle.WaitOne(TimeSpan.FromSeconds(1)); // returns immediately on Cancel()
    }
}
```

## `SpinWait` を選ぶとき

- **ロックフリーのリトライループ。** 別のスレッドが更新の途中だったために失敗した compare-and-swap のループです。相手のスレッドはナノ秒で終わるため、コンテキストスイッチのほうが待機よりもコストがかかります。
- **自作の同期プリミティブの高速パス。** `NextSpinWillYield` が false の間は `SpinOnce()` で数回スピンし、その後は実際のブロッキング待機にフォールバックします。これは `ManualResetEventSlim` が内部で使っているのと同じ構造です。

```csharp
// .NET 10, C# 14: spin briefly, then block
var spinner = new SpinWait();
while (!IsReady())
{
    if (spinner.NextSpinWillYield)
    {
        readyEvent.Wait(); // stop spinning, let the OS park the thread
        break;
    }
    spinner.SpinOnce();
}
```

ミリ秒単位の待機に `SpinWait` を使わないでください。また、大きな `n` を指定して `Thread.SpinWait(n)` を直接使うのも避けてください。[`SpinWait` のドキュメント](https://learn.microsoft.com/dotnet/api/system.threading.spinwait)は、これを同期コード向けの低レベルな構成要素と位置づけており、スピンが有効なのは、予想される待機がコンテキストスイッチのコストより短い場合だけです。ロックフリーのデータ構造や同期プリミティブを書いているのでなければ、おそらく必要ありません。すでにこのスピンを肩代わりしてくれる高レベルのプリミティブについては、[`lock` と `Monitor` と `SemaphoreSlim` と `System.Threading.Lock` の比較](/ja/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)の記事で扱っています。

## 選択を決める落とし穴: 待っているのは時間か、イベントか

コードレビューで目にする `Thread.Sleep` や `Task.Delay` の呼び出しの多くは、実は時間指定の待機ではありません。ポーリングループです。"100 ms スリープして、ジョブが終わったか確認し、繰り返す" というパターンです。このパターンは、どちらの軸でも必ず負けます。イベントの後に最大で 1 回分の間隔のレイテンシが加わり、その間は無駄に起床し続けます。

イベントを起こすのがプログラムの別の部分であれば、直接シグナルを送ってください。

```csharp
// .NET 10, C# 14: replace "while (!done) await Task.Delay(100);"
var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

_ = Task.Run(async () =>
{
    await DoWorkAsync();
    completion.TrySetResult();
});

await completion.Task.WaitAsync(TimeSpan.FromSeconds(30)); // a real timeout, no polling
```

`RunContinuationsAsynchronously` は、`completion.Task` を待機しているコードが、`TrySetResult` を呼び出したスレッド上でインライン実行されないようにします。`WaitAsync(TimeSpan)` (.NET 6 以降) を使うと、手作業で書く `Task.WhenAny(task, Task.Delay(...))` なしでタイムアウトを設定できます。プロデューサー/コンシューマーの受け渡しには `Channel<T>` を、"同時に最大 N 件" には `SemaphoreSlim.WaitAsync` を使ってください。ポーリングするのは、イベントがプロセスの外で発生し、通知を受け取る手段がない場合だけです。たとえばリモートのジョブ状態エンドポイントなどです。その場合は、`CancellationToken` 付きの `await Task.Delay` が適切なポーリング間隔になります。

## 推奨

既定では `await Task.Delay(interval, cancellationToken)` を使ってください。スレッドを占有せず、CPU も使わず、キャンセルでき、`TimeProvider` を使えば実際に待たずにテストできます。上の計測では、200 件の 1 秒待機が 1 秒で終わりましたが、`Thread.Sleep` では 18 秒かかり、そのうち 17 秒間、無関係な処理が止まりました。

`Thread.Sleep` は、他に誰も共有していないスレッドでのみ使い、そこでもキャンセル可能な `WaitHandle.WaitOne(timeout)` を優先してください。`SpinWait` は、ロックフリーのコードや同期コードの中で、コンテキストスイッチより短い待機にだけ使ってください。それより長い場合は、結局 `Sleep(1)` のループに退化します。そして、どれを選ぶ前にも、待っているのは時間なのか、何かが起こることなのかを自問してください。後者であれば、`TaskCompletionSource`、`ManualResetEventSlim`、`SemaphoreSlim`、`Channel<T>` のほうが約 50 倍速く起床します。

### 関連記事

- [C# で `CancellationTokenSource.CancelAfter` を使って非同期操作をタイムアウトさせる方法](/ja/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [C# で長時間実行されるタスクをデッドロックなしでキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [`Task.Run` と `Task.Factory.StartNew` と `ThreadPool.QueueUserWorkItem` の比較](/ja/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/)
- [.NET 10 における `Volatile.Read` と `Volatile.ReadBarrier` の比較](/ja/2026/10/volatile-read-vs-volatile-readbarrier-in-dotnet-10/)

### 出典

- [`Thread.Sleep` API リファレンス](https://learn.microsoft.com/dotnet/api/system.threading.thread.sleep) (Microsoft Learn)
- [`Task.Delay` API リファレンス](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.delay) (システムクロックの分解能に関する注記を含む)
- [`SpinWait` API リファレンス](https://learn.microsoft.com/dotnet/api/system.threading.spinwait) (Microsoft Learn)
- [v10.0.0 の `SpinWait.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Private.CoreLib/src/System/Threading/SpinWait.cs) (dotnet/runtime)
- [スレッドプール枯渇のデバッグ](https://learn.microsoft.com/dotnet/core/diagnostics/debug-threadpool-starvation) (.NET 診断ドキュメント)
- [`TimeProvider` の概要](https://learn.microsoft.com/dotnet/standard/datetime/timeprovider-overview) (Microsoft Learn)
