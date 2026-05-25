---
title: "C# における Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll"
description: "メモリ上のデータに対する CPU バウンドな処理には Parallel.ForEach を、多数の要素に対する非同期 I/O を並行数の上限付きで行うには Parallel.ForEachAsync を、すべての操作を一度に開始して結果が必要な小さく固定的なファンアウトには Task.WhenAll を使います。"
pubDate: 2026-05-25
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
lang: "ja"
translationOf: "2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall"
translatedBy: "claude"
translationDate: 2026-05-25
---

処理が CPU バウンドで、データがすでにメモリ上にある場合は `Parallel.ForEach` を使います。100,000 個のファイルをハッシュ化する、大きな配列を変換する、コアを使い切るようなあらゆる処理です。各要素が非同期 I/O（HTTP 呼び出し、データベースクエリ）を引き起こし、それらを一度に実行する数を抑えたい場合は `Parallel.ForEachAsync` を使います。一度にすべて開始して結果を集めたい、小さく固定的な非同期操作の集合がある場合は `Task.WhenAll` を使います。判断を決定づける唯一の間違いは、`Parallel.ForEach` の中で非同期 I/O を行わないことです。その同期的な本体の中で `.Result` や `.Wait()` でブロックすると、スレッドプールを枯渇させるからです。

この記事は .NET 11 と C# 14 を対象とします。`Parallel.ForEach` は .NET Framework 4.0（2010 年）から、`Task.WhenAll` は .NET Framework 4.5 から存在します。そして `Parallel.ForEachAsync` は新顔で、.NET 6（2021 年）で追加されました。ここで説明する挙動は .NET 6 から .NET 11 まで安定しています。

## この 3 つは異なる問題を解決します

この比較が扱いづらいのは、3 つが性能の異なる交換可能な API ではないからです。これらは 3 つの異なる問いへの答えです。

`Parallel.ForEach` はこう問います。「コレクションと、要素ごとの同期的で CPU バウンドな操作があります。これをコアに分散してください」。その本体は `Action<T>` です。ソースをパーティション分割し、本体をスレッドプールの複数のスレッドで実行し、各要素が完了するまで呼び出し元のスレッドをブロックします。Task Parallel Library のデータ並列処理の主力です。

`Parallel.ForEachAsync` はこう問います。「コレクションと、要素ごとの非同期操作があります。並行して実行しつつ、一度に走る数を制限してください」。その本体は `Func<TSource, CancellationToken, ValueTask>` です。待機する `Task` を返し、ブロックしません。重要なのは、スロットリングを行う点です。既定では最大 `Environment.ProcessorCount` 個の操作を並列に実行し、`ParallelOptions.MaxDegreeOfParallelism` で明示的に設定できます。

`Task.WhenAll` はこう問います。「すでに大量のタスクがあります。すべて完了したら教えてください」。何も開始せず、何もスロットリングせず、ソースをイテレートもしません。あなたがタスクを作成し（これが開始させます）、コレクションを `WhenAll` に渡し、それが返す単一のタスクを待機します。5,000 個のタスクを開始すれば、待機する時点で 5,000 個すべてが実行中です。

つまり本当の判断は、生の速度ではなく処理の形に関するものです。データに対する CPU バウンド（`Parallel.ForEach`）、上限付きで多数の要素に対する非同期 I/O（`Parallel.ForEachAsync`）、または一度にすべて行いたく結果が必要な、既知の一握りの非同期操作（`Task.WhenAll`）です。

## 判断マトリクス

以下の挙動は特記なき限り .NET 6 以降のものです。`Parallel.ForEachAsync` は .NET 6 より前には存在しません。

| 機能                                | `Parallel.ForEach`            | `Parallel.ForEachAsync`                       | `Task.WhenAll`                       |
| ----------------------------------- | ----------------------------- | --------------------------------------------- | ------------------------------------ |
| 最適な用途                          | CPU バウンドな処理            | 要素ごとの非同期 I/O                          | 固定的な非同期操作の集合             |
| 本体のデリゲート                    | `Action<T>`（同期）           | `Func<T, CancellationToken, ValueTask>`       | あなたがタスクを作成                 |
| 呼び出し元スレッドをブロック        | する                          | しない（`Task` を返す）                       | しない（`Task` を返す）              |
| 組み込みの並行数制限                | あり（`MaxDegreeOfParallelism`）| あり（`MaxDegreeOfParallelism`）            | なし -- すべてのタスクが一度に       |
| 既定の並列度                        | スケジューラ管理（`-1`）      | `Environment.ProcessorCount`                  | 無制限                               |
| 結果を返す                          | 返さない                      | 返さない（`Task` を返す、`Task<T[]>` ではない）| 返す（`Task<TResult[]>`、順序保持）  |
| `IAsyncEnumerable<T>` を受け付ける  | 受け付けない                  | 受け付ける                                    | 該当なし                             |
| キャンセル                          | `ParallelOptions`             | `ParallelOptions` + 本体に渡されるトークン    | 基になるタスクを自分でキャンセル     |
| 最初の例外で                        | 新しいイテレーションの起動を停止 | トークンをキャンセルし、新しい要素のスケジュールを停止 | 各タスクを最後まで走らせる   |
| 例外の表面化                        | `AggregateException`          | `AggregateException`（await は最初のものに展開）| `AggregateException`（await は展開） |
| 初出                                | .NET Framework 4.0            | .NET 6                                         | .NET Framework 4.5                   |

ほとんどの実際のケースを決めるのは「本体のデリゲート」と「組み込みの並行数制限」の行です。要素ごとの処理が `async` なら、`Parallel.ForEach` はすでに誤りです。並行数を制限する必要があるなら、`Task.WhenAll` はすでに誤りです。

## Parallel.ForEach を選ぶとき

要素ごとの処理が同期的で CPU バウンドであり、コレクションがすでにメモリ上に実体化されている場合は `Parallel.ForEach` に手を伸ばします。

- **メモリ上の大きな配列やリストの変換。** 50,000 枚の画像のリサイズ、チェックサムの計算、行のパース。処理はコアを忙しく保ち、ソースをコアに分割することはまさに `Parallel.ForEach` が作られた目的です。他の処理に余裕を残したい場合は `MaxDegreeOfParallelism` を設定します。
- **恥ずかしいほど並列な数値計算。** モンテカルロシミュレーション、ピクセルごとのフィルター、独立した行列演算のバッチ。共有状態なし、I/O なし、CPU だけです。
- **呼び出し元スレッドに待たせたい。** `Parallel.ForEach` は設計上同期的です。ブロックして問題ないコンソールツールやバックグラウンドジョブでは、その単純さが利点になります。

```csharp
// .NET 11, C# 14 -- CPU-bound work over an in-memory array.
// Parallel.ForEach partitions across cores and blocks until done.
var files = Directory.GetFiles(@"C:\data", "*.bin");
var hashes = new ConcurrentDictionary<string, string>();

Parallel.ForEach(
    files,
    new ParallelOptions { MaxDegreeOfParallelism = Environment.ProcessorCount },
    file =>
    {
        using var stream = File.OpenRead(file);
        byte[] hash = SHA256.HashData(stream);   // CPU + sync I/O, no await
        hashes[file] = Convert.ToHexString(hash);
    });
```

厳格なルール：本体が何かを `await` したいなら、`Parallel.ForEach` に手を伸ばさないことです。同期的な `Action<T>` を回避しようと、本体の中で `SomeAsyncCall().Result` や `.GetAwaiter().GetResult()` と書く人がいます。これは I/O の全期間にわたってスレッドプールのスレッドをブロックし、`Parallel.ForEach` はイテレーションの実行のためにすでにプールのスレッドを消費しているため、負荷がかかるとデッドロックを起こすかプールを枯渇させる可能性があります。このアンチパターンが、`Parallel.ForEachAsync` が存在する最も一般的な理由です。

## Parallel.ForEachAsync を選ぶとき

`Parallel.ForEachAsync` は「多数の要素があり、それぞれが何か非同期なものを呼び出すが、一度に 1 万本の接続を開きたくない」への答えです。

- **多数の要素のそれぞれに対して HTTP API を呼び出す。** REST エンドポイントから 8,000 件のレコードを補完する場合、8,000 件のリクエストを同時に発行するとレート制限されるかソケットを使い果たします。`MaxDegreeOfParallelism = 20` を設定すると、20 件のリクエストを実行中に保ち、各々が完了するたびに次を開始します。
- **上限付きで、データベースやキューに対する要素ごとの処理。** 接続プールには有限のサイズがあります。`Parallel.ForEachAsync` を使えば、並列度をプールに合わせて、接続待ちでブロックしないようにできます。
- **ストリーミングソース。** `IAsyncEnumerable<T>` を受け付けるので、ページ分割された API やチャネルから到着する要素を、シーケンス全体を先にバッファリングせずに処理できます。

```csharp
// .NET 11, C# 14 -- async I/O per item, capped at 20 concurrent calls.
var ids = await db.Products.Select(p => p.Id).ToListAsync(ct);
var client = httpClientFactory.CreateClient("pricing");

await Parallel.ForEachAsync(
    ids,
    new ParallelOptions
    {
        MaxDegreeOfParallelism = 20,
        CancellationToken = ct
    },
    async (id, token) =>
    {
        var price = await client.GetFromJsonAsync<Price>($"/price/{id}", token);
        await SavePriceAsync(id, price, token);   // never blocks a pool thread
    });
```

重要な点が 2 つあります。第 1 に、本体は第 2 引数として `CancellationToken` を受け取ります。外側の `ct` ではなく、これを内部のすべての非同期呼び出しに渡してください。なぜなら `Parallel.ForEachAsync` は 1 つのイテレーションが失敗するとこの内部トークンをキャンセルし、残りが早期に中断できるようにするからです。第 2 に、既定の `MaxDegreeOfParallelism` は `Environment.ProcessorCount` で、これは I/O ではなく CPU 処理に合わせて調整されています。I/O バウンドな呼び出しでは、スレッドはほとんどの時間を計算ではなくネットワーク待ちに費やすため、ほぼ常にコア数より高く設定したくなります。単一の整数の上限より細かい制御が必要な場合は、[SemaphoreSlim ベースのゲート](/ja/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)を `Task.WhenAll` と組み合わせると、呼び出しごとに上限を変える余地を持ちつつ同じスロットリングが得られます。

## Task.WhenAll を選ぶとき

`Task.WhenAll` は、並行して実行したく結果を返してほしい、既知の、たいていは小さな非同期操作の集合のためのものです。

- **固定的なファンアウト。** ユーザーのプロファイル、注文、通知を並列に読み込む。重なり合うべき 3 つの独立した await です。3 つすべてを開始し、`await Task.WhenAll`、完了です。これは日常的な用途であり、正しい用途です。
- **結果が、順序付きで必要。** ジェネリックなオーバーロードは `Task<TResult[]>` を返し、配列は完了順に関係なく入力順を保持します。`Parallel.ForEachAsync` は結果のない素の `Task` を返すので、要素ごとに結果が必要なら `WhenAll`（またはスレッドセーフな構造への収集）が道です。
- **件数が有界で小さい。** 1 万本ではなく、十数本の呼び出し。`WhenAll` は一切スロットリングしないため、並行操作の数は開始したタスクの数に等しくなります。

```csharp
// .NET 11, C# 14 -- a small, fixed fan-out; results returned in order.
Task<Profile> profile = LoadProfileAsync(userId, ct);
Task<Order[]> orders = LoadOrdersAsync(userId, ct);
Task<Alert[]> alerts = LoadAlertsAsync(userId, ct);

await Task.WhenAll(profile, orders, alerts);

// Each task is complete here; .Result no longer blocks.
var dashboard = new Dashboard(profile.Result, orders.Result, alerts.Result);
```

`Task.WhenAll` の罠は、これを有界でないリストに使うことです。10,000 件の id に対する `Task.WhenAll(ids.Select(id => CallApiAsync(id)))` は、LINQ が列挙された瞬間に 10,000 件すべての呼び出しを開始します。`Select` がタスクを実体化し、各タスクは作成時に開始するからです。これは自分自身の下流サービスへのサービス拒否攻撃です。リストが大きいか有界でない時点で、代わりに `Parallel.ForEachAsync`（または `SemaphoreSlim` ゲート）が欲しくなります。

## ベンチマーク：500 件の擬似 I/O 呼び出し

ここでは生の速度は誤解を招く軸です。最速の選択肢はたいてい最も危険なものだからです。誠実な比較は、速度対ピーク並行数です。以下の各「要素」は、20 ms のネットワーク呼び出しを表すために `Task.Delay(20)` を待機し、500 要素に対して実行されます。

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.14.x, dotnet run -c Release
// Each item simulates a 20 ms I/O call.
[MemoryDiagnoser]
public class FanOutBench
{
    private readonly int[] _items = Enumerable.Range(0, 500).ToArray();
    private static Task IoAsync(CancellationToken ct = default) => Task.Delay(20, ct);

    [Benchmark]
    public Task WhenAll_Unbounded() =>
        Task.WhenAll(_items.Select(_ => IoAsync()));

    [Benchmark]
    public Task ForEachAsync_DefaultDop() =>
        Parallel.ForEachAsync(_items, async (_, ct) => await IoAsync(ct));

    [Benchmark]
    public Task ForEachAsync_Dop50() =>
        Parallel.ForEachAsync(
            _items,
            new ParallelOptions { MaxDegreeOfParallelism = 50 },
            async (_, ct) => await IoAsync(ct));
}
```

16 コアの Ryzen 7 / Windows 11 / .NET 11 での代表的な結果です。ピーク並行数の列は構成から手作業で追加しています。

| メソッド                   | 平均    | ピーク並行操作数      | 備考                               |
| -------------------------- | ------- | --------------------- | ---------------------------------- |
| `WhenAll_Unbounded`        | ~24 ms  | 500                   | 最速だが 500 本の接続が開く        |
| `ForEachAsync_Dop50`       | ~210 ms | 50                    | 50 件 × 10 バッチ                  |
| `ForEachAsync_DefaultDop`  | ~640 ms | 16 (`ProcessorCount`) | 既定の上限は CPU 数で、I/O には低い |

ここでは `WhenAll` は既定の `ForEachAsync` より約 25 倍高速で、まさにそこが要点です。500 本の接続を一度に開くことでその速度を得ています。下流がそれに耐えられるなら結構です。レート制限のあるサードパーティ API なら、429 や `SocketException` をもたらさないのは「遅い」スロットリングされた実行のほうです。既定の `Parallel.ForEachAsync` が最も遅いのは、既定の並列度が CPU 処理に合わせて調整された `Environment.ProcessorCount` だからです。I/O では `Dop50` が示すように意図的に上げます。結論は「WhenAll が勝つ」ではなく、「許容できる並行数を選び、それを強制する API を選ぶ」です。

## あなたの代わりに決める落とし穴

いくつかの制約は、好みを完全に上書きします。

**非同期の本体は `Parallel.ForEach` ではないことを意味します。** その本体は `Action<T>` です。非同期のオーバーロードはありません。中で `.Result` や `.GetAwaiter().GetResult()` でブロックすると、イテレーションごとにプールのスレッドを占有し、枯渇を招きます。処理が await で待機するなら、`Parallel.ForEachAsync` か `Task.WhenAll` です。`async` ラムダが `Action<T>` に代入されると黙って `async void` になり、例外を飲み込んでループを完全に台無しにする理由については [async void vs async Task](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) を参照してください。

**有界でないリストは `Task.WhenAll` ではないことを意味します。** `WhenAll` にはスロットリングがありません。大きいか不明な数の要素に対しては、すべてを一度に開始します。件数が小さいと保証できないなら、`MaxDegreeOfParallelism` 付きの `Parallel.ForEachAsync` を使います。

**複数の失敗は異なる形で表面化します。** 3 つとも例外を `AggregateException` に集めますが、それをどう観測するかは異なります。`Parallel.ForEach`（同期）は `AggregateException` を直接スローするので、`catch (AggregateException ae)` ですべての内部例外が見えます。`Parallel.ForEachAsync` と `Task.WhenAll` では `await` を使い、`await` は *最初の* 例外だけに展開します。すべてを見るには、失敗したタスクの `.Exception` プロパティを調べます。より深い違いはタイミングです。`Task.WhenAll` は 1 つが失敗した後も各タスクを最後まで走らせるので、すべてから失敗を得られます。一方 `Parallel.ForEachAsync` は最初の失敗で内部トークンをキャンセルし、新しいイテレーションのスケジュールを止めるので、短絡します。「すべて試し、すべての失敗を報告する」が要件なら `WhenAll` を指し、「1 つでも失敗したら止める」が要件なら `ForEachAsync` を指します。

**.NET 6 より前は `Parallel.ForEachAsync` がないことを意味します。** .NET Framework や .NET Core 3.1 に縛られているなら、この API は存在しません。慣用的な代替は `Task.WhenAll` を囲む `SemaphoreSlim` ゲート、または生産者/消費者の形なら [BlockingCollection の代わりに Channel](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) です。

もう 1 つ横断的な注意点として、これらのいずれかが非同期処理を実行するとき、キャンセルは貫流すべきです。`Parallel.ForEachAsync` はあなたの本体にトークンを渡します。`Task.WhenAll` は、あなたが作成したタスクがトークンを尊重する場合にのみキャンセルされます。これを正しく配線するのはそれ自体が 1 つのトピックで、[デッドロックを起こさずに長時間実行の Task をキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) で扱っています。

## 推奨、再掲

処理の形で決めます。メモリ上のコレクションに対する CPU バウンド：`Parallel.ForEach`、コアを空けたいなら `MaxDegreeOfParallelism` を付けて。並行数を制限しなければならない、多数の要素に対する非同期 I/O：`Parallel.ForEachAsync`、I/O では `MaxDegreeOfParallelism` をコア数より上に引き上げ、本体のトークンを内部のすべての呼び出しに渡すことを忘れずに。すべてを実行中にして結果が必要な、小さく固定的なファンアウト：`Task.WhenAll`、ただし有界でないリストには決して使わないこと。最短の正しい版：CPU とデータなら `Parallel.ForEach`、スケールする非同期 I/O なら `Parallel.ForEachAsync`、既知の一握りの await なら `Task.WhenAll`。

## 関連記事

- [Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem](/ja/2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem/) は、これらの高レベル API が構築されている低レベルのプリミティブを扱います。
- [C# における async void vs async Task：それぞれが正しいとき](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) は、非同期ラムダを `Parallel.ForEach` に渡したときに噛みつく `async void` の罠を説明します。
- [デッドロックを起こさずに C# で長時間実行の Task をキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) は、3 つすべてのキャンセル側の半分です。
- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/ja/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) は、`Parallel.ForEachAsync` が与える以上の制御が必要なときに `Task.WhenAll` をスロットリングする SemaphoreSlim ゲートを示します。
- [C# で BlockingCollection の代わりに Channels を使う方法](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) は、処理がフラットなファンアウトではなくパイプラインのときの生産者/消費者の代替です。

## 出典

- [Parallel.ForEachAsync メソッドリファレンス (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreachasync)
- [Task.WhenAll メソッドリファレンス (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.whenall)
- [Parallel.ForEach メソッドリファレンス (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.parallel.foreach)
- [ParallelOptions.MaxDegreeOfParallelism (MS Learn)](https://learn.microsoft.com/dotnet/api/system.threading.tasks.paralleloptions.maxdegreeofparallelism)
- [Parallel.ForEachAsync and Exceptions (Jeremy Bytes)](https://jeremybytes.blogspot.com/2024/02/parallelforeachasync-and-exceptions.html)
