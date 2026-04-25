---
title: "C# で BlockingCollection の代わりに Channels を使う方法"
description: "System.Threading.Channels は .NET 11 における BlockingCollection の async ファーストの代替です。本ガイドでは、移行方法、bounded と unbounded の選び方、そしてデッドロックなしでバックプレッシャー、キャンセル、グレースフルシャットダウンを扱う方法を示します。"
pubDate: 2026-04-25
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "concurrency"
  - "async"
lang: "ja"
translationOf: "2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp"
translatedBy: "claude"
translationDate: 2026-04-25
---

.NET Core 3.0 以前に書かれた .NET アプリで `BlockingCollection<T>` を使っている場合、現代的な代替は `System.Threading.Channels` です。`new BlockingCollection<T>(capacity)` を `Channel.CreateBounded<T>(capacity)` に置き換え、`Add` / `Take` を `await WriteAsync` / `await ReadAsync` に置き換え、`CompleteAdding()` の代わりに `channel.Writer.Complete()` を呼びます。コンシューマーは `foreach (var item in collection.GetConsumingEnumerable(ct))` の代わりに `await foreach (var item in channel.Reader.ReadAllAsync(ct))` で反復します。すべてはスレッドセーフのままで、アイテムを待つあいだスレッドが一切ブロックされず、バックプレッシャーはワーカースレッドをパークさせるのではなく `await` を通じて機能します。

本ガイドは .NET 11 (preview 3) と C# 14 を対象にしていますが、`System.Threading.Channels` は .NET Core 3.0 以来の安定したインボックス API であり、[`System.Threading.Channels` NuGet パッケージ](https://www.nuget.org/packages/System.Threading.Channels) を介して .NET Standard 2.0 でも利用できます。ここに書いてあることに preview 限定のものはありません。

## なぜ BlockingCollection はもはやフィットしないのか

`BlockingCollection<T>` は 2010 年に .NET Framework 4.0 と共に登場しました。その設計は、コンシューマー 1 つあたり 1 スレッドが安価で、async/await が存在しない世界を前提にしていました。`Take()` はアイテムが利用可能になるまで呼び出し元スレッドをカーネル同期プリミティブにパークします。`Add()` は bounded な容量がいっぱいのとき同じことをします。1 秒間に 10 アイテムを処理するコンソールアプリでは問題ありません。ASP.NET Core のエンドポイント、ワーカーサービス、あるいは `ThreadPool` の圧力下で動く任意のコードでは、ブロックされたコンシューマー 1 つにつきスレッド 1 つが流通から外れます。`Take()` でブロックされたコンシューマー 20 個は、ランタイムが他に使えない 20 スレッドであり、スレッドプールの hill-climbing ヒューリスティックはさらにスレッドを生成して応答します。それらのスレッドは Windows のデフォルトでスタック約 1 MB と、それ自体が高価です。

`System.Threading.Channels` はそのコストを取り除くために .NET Core 3.0 で追加されました。`ReadAsync` で待機しているコンシューマーはスレッドをまったく保持しません。継続は実際にアイテムが書き込まれたときにのみスレッドプールにキューイングされます。これは `Task` と `ValueTask` を支えているのと同じ async ステートマシンのパターンであり、単一の ASP.NET Core プロセスが何万もの並行チャネルコンシューマーをスレッドプールを枯渇させずにホストできる理由です。Microsoft の .NET Blog にある [channels の公式紹介](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/) は明示的な推奨を示しています。I/O に触れる新規の producer-consumer パターンには channels を使い、スレッドをブロックすることが本当に許容できる同期 CPU バウンドのワーカーシナリオには `BlockingCollection<T>` を残してください。

測定可能なスループットの差もあります。Microsoft 自身のベンチマークと複数の独立した比較 (Michael Shpilt の [producer/consumer パフォーマンス対決](https://michaelscodingspot.com/performance-of-producer-consumer/) を参照) では、典型的なメッセージサイズで `Channel<T>` は `BlockingCollection<T>` の約 4 倍のスループットを示します。これはチャネルがファストパスでロックフリーな `Interlocked` 操作を使い、`BlockingCollection` が招くカーネル遷移を回避するためです。

## BlockingCollection パターンの最小再現

ほとんどのレガシーコードが従う `BlockingCollection<T>` の標準的なセットアップを示します。bounded な容量 (コンシューマーが遅れたときにプロデューサーが絞られるよう)、`CancellationToken`、コンシューマーがクリーンに終了できるようにする `CompleteAdding` を使っています。

```csharp
// .NET 11, C# 14 -- legacy pattern, do not write new code like this
using System.Collections.Concurrent;

var queue = new BlockingCollection<int>(boundedCapacity: 100);
using var cts = new CancellationTokenSource();

var producer = Task.Run(() =>
{
    for (int i = 0; i < 10_000; i++)
        queue.Add(i, cts.Token);

    queue.CompleteAdding();
});

var consumer = Task.Run(() =>
{
    foreach (int item in queue.GetConsumingEnumerable(cts.Token))
        Process(item);
});

await Task.WhenAll(producer, consumer);

static void Process(int item) { /* work */ }
```

このパイプラインのライフタイム中、2 つのスレッドが専有されます。`Process` が I/O を行う場合、コンシューマースレッドは `await` 等価の待機のたびにアイドル状態で居座り、チャネルならもっと良くできます。プロデューサー 4、コンシューマー 8 にスケールすると、12 スレッドが消費されます。

## Channels での同等品

`System.Threading.Channels` を使った同じパイプラインです。コードの形は似ていますが、違いはどのスレッドもブロックされない点です。

```csharp
// .NET 11, C# 14 -- modern replacement
using System.Threading.Channels;

var channel = Channel.CreateBounded<int>(new BoundedChannelOptions(100)
{
    FullMode = BoundedChannelFullMode.Wait,
    SingleReader = false,
    SingleWriter = false
});

using var cts = new CancellationTokenSource();

var producer = Task.Run(async () =>
{
    for (int i = 0; i < 10_000; i++)
        await channel.Writer.WriteAsync(i, cts.Token);

    channel.Writer.Complete();
});

var consumer = Task.Run(async () =>
{
    await foreach (int item in channel.Reader.ReadAllAsync(cts.Token))
        await ProcessAsync(item);
});

await Task.WhenAll(producer, consumer);

static ValueTask ProcessAsync(int item) => ValueTask.CompletedTask;
```

3 つの違いを直接指摘する価値があります。`WriteAsync` はバッファが満杯のときブロックする代わりに `ValueTask` を返します。プロデューサーの継続は空きができたときだけ再開します。`ReadAllAsync` は `IAsyncEnumerable<T>` を返し、`Writer.Complete()` が呼ばれると完了し、`CompleteAdding` 後の `GetConsumingEnumerable` の振る舞いを正確に映します。そして `Channel.CreateBounded` は `FullMode` の明示的な宣言を要求し、`BlockingCollection` が暗黙にあなたの代わりに行っていた決定 (常にブロックする) を強制的に判断させます。

## Bounded と unbounded: 意図的に選ぶ

`Channel.CreateBounded(capacity)` はバッファ済みアイテム数に厳格な上限を持ち、バッファが満杯のときプロデューサーをバックプレッシャーで押し戻します。`Channel.CreateUnbounded()` には上限がないため、書き込みは同期的に完了し、決して待ちません。Unbounded チャネルはマイクロベンチマークでは速く見えるため魅力的ですが、起こるのを待っているメモリリークです。高スループットなパイプラインでコンシューマーが数秒でも遅れると、誰かが気づく前にチャネルは喜んでギガバイト分の作業アイテムをバッファします。デフォルトでは `CreateBounded` を使ってください。コンシューマーがプロデューサーより速いと証明できる場合か、プロデューサーのレートが他の何か (例: スループットが上流の送信者に縛られる Webhook レシーバ) で本質的に制限されている場合にのみ `CreateUnbounded` に手を伸ばしてください。

`BoundedChannelFullMode` は bounded チャネルが満杯のときにプロデューサーが `WriteAsync` を呼んだら何が起こるかを制御します。4 つの選択肢:

- `Wait` (デフォルト): プロデューサーの `ValueTask` は空きが出るまで完了しません。`BlockingCollection.Add` のブロッキング動作の直接的な等価物であり、正しいデフォルトです。
- `DropOldest`: バッファ内で最も古いアイテムが空きを作るために削除されます。古いデータが欠損より悪いテレメトリで使用してください。
- `DropNewest`: バッファ内で最も新しい既存アイテムが削除されます。めったに有用ではありません。
- `DropWrite`: 新しいアイテムは黙って破棄されます。プロデューサーをバックプレッシャーするより新規書き込みを捨てたほうが安い fire-and-forget なロギングで使用してください。

`DropOldest` / `DropNewest` / `DropWrite` を選ぶと、`WriteAsync` は常に同期的に完了するため、プロデューサーは決して絞られません。これらのモードを「バックプレッシャーが欲しい」という期待と混ぜることは、よくあるバグの原因です。`Wait` が実際にバックプレッシャーをかける唯一のモードです。

## 既存の BlockingCollection パイプラインを移行する

ほとんどの BlockingCollection コードは機械的にマッピングできます。変換テーブル:

- `new BlockingCollection<T>(capacity)` -> `Channel.CreateBounded<T>(new BoundedChannelOptions(capacity) { FullMode = BoundedChannelFullMode.Wait })`
- `new BlockingCollection<T>()` (unbounded) -> `Channel.CreateUnbounded<T>()`
- `collection.Add(item, token)` -> `await channel.Writer.WriteAsync(item, token)`
- `collection.TryAdd(item)` -> `channel.Writer.TryWrite(item)` (`bool` を返し、決してブロックしない)
- `collection.Take(token)` -> `await channel.Reader.ReadAsync(token)`
- `collection.TryTake(out var item)` -> `channel.Reader.TryRead(out var item)`
- `collection.GetConsumingEnumerable(token)` -> `channel.Reader.ReadAllAsync(token)` (`await foreach` と共に)
- `collection.CompleteAdding()` -> `channel.Writer.Complete()` (または失敗を通知する `Complete(exception)`)
- `collection.IsCompleted` -> `channel.Reader.Completion.IsCompleted`
- `BlockingCollection.AddToAny / TakeFromAny` -> 直接の等価物なし。下記「落とし穴」を参照

非ブロッキングな `TryWrite` と `TryRead` は 1 つの特定シナリオに重要です。`await` を導入してはいけない同期コードパスです。これらは待機する代わりに `false` を返すので、ポーリングするか別のコードパスにフォールバックできます。ほとんどのコードでは必要ありません。async 形式を優先してください。

プロデューサーがスレッドプール上で動き、チャネルがホットなら、`SingleWriter = true` (または `SingleReader = true`) を設定したいかもしれません。Channels はちょうど 1 つのプロデューサーまたはコンシューマーがあると分かっているとき、別のより速い内部実装を使います。チェックは便宜的なものに過ぎず、ランタイムは強制しないので、このフラグは正直に設定してください。`SingleWriter = true` を設定して誤って 2 つのプロデューサーを持つと、`WriteAsync` は微妙な仕方で誤動作します (アイテムの紛失、completion の破損)。

## バックプレッシャー、キャンセル、グレースフルシャットダウン

バックプレッシャーは `WriteAsync` の `ValueTask` を通じて機能します。バッファが満杯のとき、プロデューサーのタスクはコンシューマーがアイテムを読むまで未完了で、その時点で待機中の writer が 1 つだけ解放されます。これはセマフォと同じ形ですが、セマンティクスが別個のカウンタではなくバッファの状態に結び付けられています。

キャンセルは任意の async API と同じ方法で伝播します。`WriteAsync`、`ReadAsync`、`ReadAllAsync` に `CancellationToken` を渡します。トークンが発火すると、進行中の `ValueTask` は `OperationCanceledException` を投げます。チャネル自体はトークンによってキャンセルされません。そのトークンを渡さなかった他のプロデューサーやコンシューマーは通常通り続行します。パイプライン全体をキャンセルしたいなら、`channel.Writer.Complete()` (または `Complete(exception)`) を呼びます。これにより現在および将来のすべてのリーダーに、これ以上データが来ないことが伝わります。より広範なパターンについては [C# で長時間タスクをデッドロックなしにキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) を参照してください。

ワーカーサービスでのグレースフルシャットダウンはこんな感じです:

```csharp
// .NET 11, C# 14
public class ImportWorker : BackgroundService
{
    private readonly Channel<ImportJob> _channel =
        Channel.CreateBounded<ImportJob>(new BoundedChannelOptions(500)
        {
            FullMode = BoundedChannelFullMode.Wait
        });

    public ChannelWriter<ImportJob> Writer => _channel.Writer;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var job in _channel.Reader.ReadAllAsync(stoppingToken))
                await ProcessAsync(job, stoppingToken);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // expected on host shutdown
        }
        finally
        {
            _channel.Writer.TryComplete();
        }
    }

    private static ValueTask ProcessAsync(ImportJob job, CancellationToken ct)
        => ValueTask.CompletedTask;
}

public record ImportJob(string Id);
```

注意 2 つ。`TryComplete` は (`Complete` と違って) 冪等で `finally` から呼んでも安全です。`OperationCanceledException` フィルタはキャンセルが実際に `stoppingToken` から来たときだけ飲み込みます。別のトークンで起きたキャンセルは依然として伝播し、それが期待する挙動です。

プロデューサーが失敗しうるなら、`channel.Writer.Complete(exception)` を優先してください。次のコンシューマーの `ReadAsync` または `ReadAllAsync` の呼び出しでその例外が再スローされます。これは、失敗のあとに `CompleteAdding` が呼ばれた後の `BlockingCollection.GetConsumingEnumerable` が再スローするのと同じチャネル等価物です。

## 遭遇する落とし穴

`Channel.Writer.WriteAsync` は `Task` ではなく `ValueTask` を返します。結果を保存して 2 回以上 await すると、未定義の動作が発生します。`ValueTask` は single-await として文書化されています。99% のケースはインラインの `await channel.Writer.WriteAsync(item)` であり、戻り値を渡し回し始めない限り懸念事項ではありません。

`Reader.Completion` は `Writer.Complete` が呼ばれてすべてのアイテムが排出されたときに完了する `Task` です。チャネルが完全に空で閉じたタイミングを知りたいなら、`Reader.Completion` を await してください。`Reader.Count == 0` をチェックしないでください。これは存在しますが、進行中の書き込みと競合します。

`ChannelReader<T>.WaitToReadAsync` はチャネルが完了し空のときだけ `false` を返します。これは `await foreach` がフィットしない手書きのコンシューマーループ、たとえばバッチで読みたい場合の正しいプリミティブです:

```csharp
// .NET 11, C# 14 -- batched consumer
while (await channel.Reader.WaitToReadAsync(ct))
{
    var batch = new List<int>(capacity: 100);
    while (batch.Count < 100 && channel.Reader.TryRead(out int item))
        batch.Add(item);

    if (batch.Count > 0)
        await ProcessBatchAsync(batch, ct);
}

static ValueTask ProcessBatchAsync(IReadOnlyList<int> items, CancellationToken ct)
    => ValueTask.CompletedTask;
```

`BlockingCollection` には複数のコレクションをまたいで動作する `AddToAny` と `TakeFromAny` がありました。Channels には直接の等価物はありません。本当に N 個のチャネルからの fan-in が必要なら、慣用的なパターンはソースチャネルごとに 1 つのコンシューマータスクを生成し、すべてが単一のダウンストリームチャネルに書き込むことです。これはキャンセルモデルと綺麗にコンポーズし、async フレンドリーなままです。本当に fan-out (1 プロデューサーが N コンシューマーに供給) が必要なら、同じ `Reader` に対して N 個のリーダータスクを生成してください。`SingleReader = true` を設定しない限り、channels は複数のリーダーに対して安全です。

`System.Threading.Channels` は Go の `chan` のようなシリアライズチャネルでも、分散メッセージングプリミティブでもありません。インプロセス専用です。プロセス間またはマシン間のメッセージングが必要なら、本物のメッセージブローカー (Azure Service Bus, RabbitMQ, Kafka) を使ってください。Channels は単一プロセス内では正しいツールであり、ネットワークが関与した瞬間に間違ったツールになります。

## BlockingCollection が今でも擁護できるとき

`BlockingCollection<T>` を残すのが妥当な狭いケースが 1 つあります。コンソールアプリやバッチジョブの中の同期 CPU バウンドなワーカープールで、スレッド数を自分で制御し、スレッドプールの圧力を気にする必要がないケースです (気にすべきスレッドプールの圧力がないため)。Microsoft Learn の [Channels overview](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels) はこの点について明示的です。それ以外のあらゆる場所 (ASP.NET Core、ワーカーサービス、I/O に触れる任意のコード、async 対応のコンシューマーと共有される任意のコード) では `System.Threading.Channels` を優先してください。

## 関連

- [C# で長時間タスクをデッドロックなしにキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [EF Core 11 で IAsyncEnumerable&lt;T&gt; を使う方法](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)
- [.NET 11 でメモリ不足にならずに大きな CSV を読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/)
- [ASP.NET Core エンドポイントからファイルをバッファリングなしでストリームする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)

## 出典

- [An Introduction to System.Threading.Channels (Microsoft .NET Blog)](https://devblogs.microsoft.com/dotnet/an-introduction-to-system-threading-channels/)
- [Channels overview (Microsoft Learn)](https://learn.microsoft.com/en-us/dotnet/core/extensions/channels)
- [BoundedChannelOptions class reference](https://learn.microsoft.com/en-us/dotnet/api/system.threading.channels.boundedchanneloptions)
- [Performance Showdown of Producer/Consumer Implementations in .NET (Michael Shpilt)](https://michaelscodingspot.com/performance-of-producer-consumer/)
- [System.Threading.Channels source on GitHub](https://github.com/dotnet/runtime/tree/main/src/libraries/System.Threading.Channels)
