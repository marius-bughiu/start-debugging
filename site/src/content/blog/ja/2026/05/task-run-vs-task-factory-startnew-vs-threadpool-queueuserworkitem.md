---
title: "Task.Run vs Task.Factory.StartNew vs ThreadPool.QueueUserWorkItem"
description: "C# でスレッドプールに作業を投げる 3 つの方法と、どれを選ぶべきか。ほとんどの場合は Task.Run を、アロケーションのない fire-and-forget には ThreadPool.QueueUserWorkItem<TState> を、LongRunning やカスタムスケジューラーのときだけ Task.Factory.StartNew を使います。"
pubDate: 2026-05-24
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "concurrency"
lang: "ja"
translationOf: "2026/05/task-run-vs-task-factory-startnew-vs-threadpool-queueuserworkitem"
translatedBy: "claude"
translationDate: 2026-05-24
---

最近の C# におけるほぼすべてのバックグラウンド作業には、`Task.Run` を使います。作業をスレッドプールにオフロードし、待機可能な `Task` を返し、例外を伝播し、非同期ラムダを代わりにアンラップしてくれます。`ThreadPool.QueueUserWorkItem<TState>` に手を伸ばすのは、`Task` のアロケーションがゼロの本物の fire-and-forget が欲しく、完了にも例外にも関心がないときだけです。`Task.Factory.StartNew` は、`Task.Run` では表現できない 2 つのケースのために取っておきます。すなわち `TaskCreationOptions.LongRunning`(プール上のスレッドではなく専用スレッド)と、カスタムの `TaskScheduler` です。そのデフォルト値は危険なので、汎用的な「これをバックグラウンドで実行する」呼び出しとしては使わないでください。

この記事は .NET 11(preview 4)、C# 14、および net11.0 で出荷される BCL を対象としています。`Task.Run` は .NET Framework 4.5 で登場しました。`Task.Factory.StartNew` と `ThreadPool.QueueUserWorkItem(WaitCallback, object)` はそれぞれ .NET Framework 4.0 と 1.0 にさかのぼります。アロケーションに優しいオーバーロード `ThreadPool.QueueUserWorkItem<TState>(Action<TState>, TState, bool)` は .NET Core 2.1 で追加され、それ以降のすべての .NET バージョンに存在します。

## 3 つの API は異なるレベルに位置します

ここでの混乱は、これら 3 つを同じ操作の交換可能な 3 つの書き方として扱うことから生じます。そうではありません。これらは 3 つの異なる抽象レベルに位置し、3 つの異なるものを返します。

`ThreadPool.QueueUserWorkItem` は 3 つの中で最も生のものです。デリゲートを渡すと、ランタイムがプール上のスレッドでそれを実行します。それで契約のすべてです。戻り値もなく、ハンドルもなく、完了を待つ方法もなく、例外を観測する方法もありません。コールバック内でスローされた未処理の例外はプロセスを倒します。これは他のどのスレッドプールのスレッドでも起こることとまったく同じです。これは文字どおりの意味での fire-and-forget です。いったんキューに入れたら、その作業との関係はそれ以上ありません。

`Task.Factory.StartNew` は Task Parallel Library の汎用的なタスク起動器です。`Task` を返すので、待機可能なハンドルと例外の捕捉が得られます。しかし汎用すぎるのが難点です。TPL が持つあらゆるつまみを公開しており、そのデフォルト値は 2010 年に別の世界向けに選ばれたものです。噛みついてくる 2 つのデフォルトは、`TaskScheduler.Current`(`Default` ではない)と、`DenyChildAttach` がないことです。

`Task.Run` は、`StartNew` のデフォルトが落とし穴だったために、まさにその理由で Microsoft が .NET Framework 4.5 で追加した、主張のある便利ラッパーです。[.NET チーム自身のガイダンス](https://devblogs.microsoft.com/dotnet/task-run-vs-task-factory-startnew/)によれば、`Task.Run(someAction)` の呼び出しは次とまったく等価です。

```csharp
// .NET 11, C# 14 -- what Task.Run actually does under the hood
Task.Factory.StartNew(
    someAction,
    CancellationToken.None,
    TaskCreationOptions.DenyChildAttach,
    TaskScheduler.Default);
```

つまり `Task.Run` は `StartNew` とは別のメカニズムではありません。安全な引数をあらかじめ組み込んだ `StartNew` です。この 1 つの事実が、この比較のほとんどを決定します。

## 判断マトリクス

特に記載がない限り、各行は net11.0 の動作です。「プールのスレッド」は `ThreadPool` のワーカーを意味し、「専用スレッド」はプール外の新しいスレッドを意味します。

| 機能                                       | `Task.Run`              | `Task.Factory.StartNew`      | `ThreadPool.QueueUserWorkItem`      |
| ------------------------------------------ | ----------------------- | ---------------------------- | ----------------------------------- |
| 待機可能な `Task` を返す                   | はい                    | はい                         | いいえ                              |
| 例外を捕捉する                             | はい(`Task` 上で)     | はい(`Task` 上で)          | いいえ(プロセスを倒す)            |
| デフォルトのスケジューラー                 | `TaskScheduler.Default` | `TaskScheduler.Current`      | スレッドプール(スケジューラーなし) |
| デフォルトで `DenyChildAttach`             | はい                    | いいえ                       | 該当なし                            |
| 非同期ラムダ(`Func<Task>`)をアンラップ   | はい、`Task` を返す     | いいえ、`Task<Task>` を返す  | 該当なし(デリゲートは `async void`) |
| クロージャなしで状態を渡す                 | いいえ                  | はい(`object` の状態引数)  | はい(`TState` オーバーロード)      |
| `LongRunning`(専用スレッド)              | いいえ                  | はい                         | いいえ                              |
| カスタム `TaskScheduler`                   | いいえ                  | はい                         | いいえ                              |
| `Task` をアロケートする                    | はい                    | はい                         | いいえ                              |
| 起動時のキャンセルトークン                 | はい                    | はい                         | いいえ                              |
| 初出                                       | .NET Framework 4.5      | .NET Framework 4.0           | .NET Framework 1.0                  |

2 つの行がほとんどの重みを担います。「待機可能な Task を返す」は、待機が必要なものや結果が必要なものについて、あなたを 2 つの TPL メソッドへと押しやります。「Task をアロケートする」は、何百万もの小さなワークアイテムをキューに入れていて `Task` オブジェクトそのものが削りたいコストであるときに、あなたを `QueueUserWorkItem` へと引き寄せます。

## Task.Run を選ぶとき

これがデフォルトです。判断のためにこれを読んでいて、別のものを選ぶ特定の理由がないなら、答えは `Task.Run` です。

- CPU バウンドの作業を現在のスレッドからオフロードして結果を待ちたい場合。パース、ハッシュ、画像のリサイズなど、リクエストスレッドや UI スレッドをブロックしてしまうものすべてです。`Task.Run(() => Compute(input))` は `await` で待機できる `Task<TResult>` を返します。
- プール上で非同期ラムダを実行している場合。`Task.Run` はそれを代わりにアンラップするので、`Task.Run(async () => await DoAsync())` の型は `Task<Task>` ではなく `Task` です。これは `StartNew` のユーザーが最もよく火傷する箇所であり、下の落とし穴で扱います。
- UI アプリ(MAUI、WPF、Blazor)にいて、作業を UI スレッドで実行してはいけない場合。`Task.Run` は `TaskScheduler.Default` をハードコードしているため、どのスレッドから呼んでも常にプールに行きます。`StartNew` は UI のスケジューラーを継承し、「バックグラウンド」の作業を UI スレッドで実行してしまいます。

```csharp
// .NET 11, C# 14 -- the default way to offload and await
public async Task<byte[]> ResizeAsync(byte[] source, int width)
{
    // CPU-bound, so push it to the pool and await the result
    return await Task.Run(() => ImageResizer.Resize(source, width));
}

// async lambda: Task.Run unwraps, so the type is Task<int>, not Task<Task<int>>
Task<int> work = Task.Run(async () =>
{
    await Task.Delay(100);
    return 42;
});
```

`Task.Run` のコストは `Task` のアロケーション 1 つに加え、ラムダがローカルな状態をキャプチャする場合はクロージャのアロケーション 1 つです。ミリ秒以上動く通常のバックグラウンド作業にとって、そのアロケーションはノイズです。それが興味深くなるのは、非常に短いワークアイテムを非常に大量にキューに入れているときだけであり、それこそ `QueueUserWorkItem` が真価を発揮する唯一のシナリオです。

## ThreadPool.QueueUserWorkItem を選ぶとき

`QueueUserWorkItem` が正しい選択になるのは、ちょうど 1 つの状況です。すなわち、ハンドルが要らず、結果が要らず、待機する必要もなく、そして `Task` のアロケーションがプロファイルに現れるほど十分な量をキューに入れている、本物の fire-and-forget の作業です。

- 小さく独立したワークアイテムを大量に発火させていて、要素あたりの `Task` のアロケーションが測定可能な GC 圧になっている場合。テレメトリパイプライン、キャッシュ無効化のファンアウト、各行をプールに渡すログのシンクなど。
- 完了にも失敗にも本当に関心がない場合。ここでの未処理の例外はプロセスを倒すことを忘れないでください。したがってコールバックの本体は自分自身の例外を処理しなければなりません。
- ジェネリックの `QueueUserWorkItem<TState>` オーバーロードを使って、クロージャをアロケートせずに状態を渡せる場合。これがホットパスでこの API を選ぶ理由のすべてであり、変数のキャプチャを避けたときにのみ機能します。

```csharp
// .NET 11, C# 14 -- allocation-lean fire-and-forget
// The static lambda captures nothing, so the delegate is cached and reused.
// State flows through the TState parameter, so there is no closure object.
ThreadPool.QueueUserWorkItem(
    static state => state.Sink.Write(state.Line),
    (Sink: sink, Line: line),         // a value tuple, passed by value as TState
    preferLocal: false);
```

このオーバーロードを知っておく価値がある詳細が 2 つあります。第一に、`static` ラムダは何もキャプチャしないので、C# コンパイラは呼び出しごとに 1 つアロケートする代わりに、単一のデリゲートインスタンスをキャッシュします。第二に、状態は値タプルを含め、強く型付けされた `TState` パラメーターを通って流れるので、状態が値型だったときに古いオーバーロード `QueueUserWorkItem(WaitCallback, object)` が強制していたクロージャとボックス化の両方を避けられます。ジェネリックオーバーロードとともに .NET Core 2.1 で追加された `preferLocal` フラグは、アイテムを現在のワーカーのローカルキュー(`true`、キャッシュ局所性とワークスティーリングが良くなる)に入れるか、グローバルキュー(`false`)に入れるかを制御します。互いに無関係な fire-and-forget のアイテムには、通常 `false` が正しいです。

`QueueUserWorkItem` が欲しいが同時にバックプレッシャーや順序も欲しい、と気づいたら、立ち止まって [BlockingCollection の代わりに Channels](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) を見てください。単一のコンシューマーを持つ有界の `Channel<T>` は、プロデューサーがコンシューマーをどれだけ追い越すかが気になり始めたら、生のスレッドプールのキューイングよりほぼ常に優れた fire-and-forget のシンクです。

## Task.Factory.StartNew を選ぶとき

`StartNew` が生き残っている理由は 2 つ、それも 2 つだけです。どちらも当てはまらないなら、`Task.Run` を使うべきです。

- `TaskCreationOptions.LongRunning` が必要な場合。これはスケジューラーに対し、作業をプールのスレッドではなく専用スレッドで実行するようヒントを与えます。長時間ブロックし、そうでなければプールを枯渇させてしまう作業にとって重要です。メッセージループ、長命のコンシューマー、デバイスからのブロッキング読み取りなど。`Task.Run` には `TaskCreationOptions` を受け取るオーバーロードがないので、これは本当に `StartNew` だけのものです。
- カスタムの `TaskScheduler` が必要な場合。スケジューラー(シングルスレッドのアパートメントスケジューラー、優先度スケジューラー、並行数を制限したスケジューラー)を作っていて、このタスクをその上で実行したいなら、`StartNew` はスケジューラーを引数として取りますが、`Task.Run` は取りません。

```csharp
// .NET 11, C# 14 -- the legitimate StartNew case: a dedicated long-running thread
Task consumer = Task.Factory.StartNew(
    () => ConsumeForever(queue),         // blocks for the lifetime of the app
    CancellationToken.None,
    TaskCreationOptions.LongRunning,     // hint: give me my own thread, not a pool thread
    TaskScheduler.Default);              // ALWAYS pass Default explicitly
```

最後の引数に注目してください。正当な用途においてさえ、`TaskScheduler.Default` を明示的に渡すべきです。なぜなら `TaskScheduler.Current` というデフォルト値こそ、何気ない `StartNew` 呼び出しを誤動作させる落とし穴だからです。次のセクションが、`Task.Run` が存在する理由のすべてです。

## ベンチマーク:アロケーションはどこへ行くのか

測定する価値のあるパフォーマンスの主張は、生のレイテンシではなくアロケーションです。これら 3 つのいずれにとっても実時間はスレッドプールのスケジューリングと作業そのものに支配され、作業が走り始めてしまえばその両方は 3 つの API 間で同一です。決定論的に異なるのは、各呼び出しがプールへ向かう途中で何をアロケートするかです。

これらの数値は、BenchmarkDotNet 0.14 を `[MemoryDiagnoser]` 付きで、.NET 11 preview 4、x64、Windows 11、Ryzen 9 7950X 上で測定したものです。各ベンチマークは些末なワークアイテム 1 つ(`Interlocked.Increment`)をキューに入れ、ハーネスは外側のフィールドから状態をキャプチャするので、クロージャベースのバリアントは実際にクロージャをアロケートします。絶対バイト数はマシンとランタイムに依存します。順序と比率が安定した結果です。

| メソッド                                              | アロケーション / op |
| ----------------------------------------------------- | -------------- |
| `Task.Run(() => Work(state))`(`state` をキャプチャ)  | 192 B          |
| `Task.Factory.StartNew(() => Work(state))`(キャプチャ)| 192 B          |
| `QueueUserWorkItem(s => Work((State)s), state)`       | 80 B           |
| `QueueUserWorkItem(static s => Work(s), state, false)`| 56 B           |

パターンこそが頑健な結論です。`Task.Run` と `StartNew` は同じものをアロケートします。なぜなら `Task.Run` は内部では `StartNew` だからです。すなわち `Task` オブジェクトと、ラムダがキャプチャするときのクロージャです。古い `object` ベースの `QueueUserWorkItem` オーバーロードは `Task` を完全に飛ばしますが、それでも内部のコールバックラッパーをアロケートします。`static` ラムダを使ったジェネリックの `QueueUserWorkItem<TState>` は、`Task` もクロージャもアロケートせず、静的デリゲートが初回使用後にキャッシュされるため、最も軽量です。1 回の呼び出しなら、この差は無関係です。毎秒数百万のアイテムをキューに入れるホットループなら、要素あたりのアロケーションのおよそ 70% を削ることは、平坦な GC グラフとのこぎり歯状のグラフとの違いになります。

再現するには、些末なハーネスを自分で実行してください。上記の 4 つの `[Benchmark]` メソッドを持つクラス、そのクラスに `[MemoryDiagnoser]`、そして `Main` に `BenchmarkRunner.Run<T>()` です。自分のターゲットフレームワークで測定していないアロケーション値を信用しないでください。`Task` のレイアウトとスレッドプールの内部ラッパーはランタイムのバージョン間で変わるからです。

## あなたの代わりに決めてくれる落とし穴

3 つの制約が好みを完全に上書きします。

**非同期ラムダは `StartNew` より `Task.Run` を強制します。** これは古典的なバグです。`Task.Factory.StartNew(async () => await FooAsync())` は `Task` ではなく `Task<Task>` を返します。外側のタスクは非同期ラムダが最初の `await` に到達した瞬間に完了するので、`StartNew` の結果を待機すると、実際の作業ではなく、非同期メソッドの同期部分の前半だけを待つことになります。.NET チームが文書化している修正は `.Unwrap()` ですが、より良い修正は `Task.Run` を使うことです。これがそのアンラップを代わりにやってくれます。この落とし穴を生むのと同じスレッド再開のメカニズムは、[async void vs async Task in C#](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) で説明しています。

```csharp
// .NET 11, C# 14 -- the StartNew async trap
Task<Task<int>> wrong = Task.Factory.StartNew(async () =>
{
    await Task.Delay(1000);
    return 42;
}); // completes after ~0 ms, NOT 1000 ms

int value = await Task.Factory.StartNew(async () =>
{
    await Task.Delay(1000);
    return 42;
}).Unwrap(); // correct, but just write Task.Run instead
```

**`TaskScheduler.Current` は `StartNew` に「バックグラウンド」の作業を誤ったスレッドで実行させます。** 別のタスクの内部や UI のイベントハンドラーから `StartNew` を呼ぶと、`TaskScheduler.Current` はスレッドプールのスケジューラーではありません。UI スレッド上では UI の同期スケジューラーなので、「オフロードした」作業が UI スレッドで動き、アプリをフリーズさせます。別の `Task.Run` の中にネストされていれば、`Current` はプールのスケジューラーになりうるものの、それに頼るのは脆弱です。`Task.Run` は `TaskScheduler.Default` をハードコードすることでこれを完全に回避します。明示的なスケジューラー引数のない `StartNew` を見かけたら、潜在的なバグとして扱ってください。

**`QueueUserWorkItem` による fire-and-forget は何も飲み込みません。倒します。** 観測されなかった例外が捕捉され(古いランタイムでは)ファイナライザーで再スローされる `Task` とは異なり、`QueueUserWorkItem` のコールバックから抜け出した例外は、スレッドプールのスレッド上の未処理例外であり、プロセスを終了させます。この API を使うなら、コールバックの本体を自分自身の `try` / `catch` で包まなければなりません。失敗を運ぶ `Task` は存在しません。

## 推奨、再掲

実質的にすべてのバックグラウンドおよびオフロードする作業には、デフォルトで `Task.Run` を使ってください。待機可能な `Task` を返し、例外を捕捉し、常にスレッドプールを使い、非同期ラムダをアンラップします。これがまさに 95% の場面で欲しいものです。`ThreadPool.QueueUserWorkItem<TState>` に `static` ラムダ付きで降りるのは、`Task` のアロケーションが測定可能で、コールバックが自分自身の例外を捕まえなければならないと受け入れた、ホットパス上の本物の fire-and-forget のときだけにしてください。`Task.Factory.StartNew` は `TaskCreationOptions.LongRunning` かカスタムの `TaskScheduler` のためだけに使い、その際は現在のスケジューラーを継承しないよう、常に `TaskScheduler.Default` を明示的に渡してください。最短の正しい判断は、ハンドルが必要なら `Task.Run`、ゼロアロケーションでハンドルが不要なら `QueueUserWorkItem<TState>`、専用スレッドかカスタムスケジューラーが必要なら `Default` 付きの `StartNew` です。

## 関連

- [lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock in C#](/ja/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/) は、これらのバックグラウンドタスクが触れる共有状態を保護するための姉妹となる比較です。
- [async void vs async Task in C#: when each is correct](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) は、StartNew の非同期ラムダの落とし穴の背後にある再開の動作を説明します。
- [How to cancel a long-running Task in C# without deadlocking](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) は、Task.Run や StartNew に渡すキャンセルトークンを扱います。
- [How to use Channels instead of BlockingCollection in C#](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) は、fire-and-forget にバックプレッシャーが必要なときの構造化された代替です。
- [ConfigureAwait(false) vs default in .NET 11](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/) は、スレッドプールへのオフロードを正しく行うためのもう半分です。

## ソースリンク

- [Task.Run vs Task.Factory.StartNew](https://devblogs.microsoft.com/dotnet/task-run-vs-task-factory-startnew/) は .NET Blog にあり、等価性と非同期ラムダのアンラップに関する正典的な説明です。
- [StartNew is Dangerous](https://blog.stephencleary.com/2013/08/startnew-is-dangerous.html) は Stephen Cleary によるもので、`TaskScheduler.Current` と `LongRunning` の落とし穴についてです。
- [`ThreadPool.QueueUserWorkItem` API リファレンス](https://learn.microsoft.com/dotnet/api/system.threading.threadpool.queueuserworkitem) は Microsoft Learn にあり、ジェネリックの `TState` オーバーロードを含みます。
- [`Task.Run` API リファレンス](https://learn.microsoft.com/dotnet/api/system.threading.tasks.task.run) は Microsoft Learn にあります。
- [`TaskFactory.StartNew` API リファレンス](https://learn.microsoft.com/dotnet/api/system.threading.tasks.taskfactory.startnew) は Microsoft Learn にあり、デフォルトの `TaskScheduler.Current` を文書化しています。
- [dotnet/runtime#25193](https://github.com/dotnet/runtime/issues/25193) は、`QueueUserWorkItem` にアロケーションに優しいジェネリックオーバーロードを与えた提案です。
