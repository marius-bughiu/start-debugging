---
title: "デッドロックせずに C# の長時間 Task をキャンセルする方法"
description: ".NET 11 における CancellationToken、CancelAsync、Task.WaitAsync、リンクトークンを使った協調的キャンセル。そしてクリーンなキャンセルをデッドロックに変えてしまうブロッキングパターン。"
pubDate: 2026-04-23
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "cancellation"
lang: "ja"
translationOf: "2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking"
translatedBy: "claude"
translationDate: 2026-04-24
---

長時間実行される `Task` があり、ユーザーがキャンセルをクリックすると、アプリがハングするか、タスクが自分で終わるまで走り続けるかのどちらかになります。どちらの結果も同じ誤解を指しています。.NET でのキャンセルは協調的であり、それを機能させる部品は `CancellationTokenSource`、`CancellationToken`、そしてトークンを実際にチェックしようという意思です。この記事では、.NET 11 (`Microsoft.NET.Sdk` 11.0.0、C# 14) でそれをきれいにセットアップする方法と、クリーンなキャンセルを `Wait`-永久デッドロックに変えてしまうブロッキングパターンを避ける方法を説明します。すべてのサンプルは .NET 11 でコンパイルされます。

## 協調的キャンセル、1 段落のメンタルモデル

.NET に `Task.Kill()` はありません。CLR はコードの途中でスレッドを引き抜きません。作業をキャンセルしたいときは、`CancellationTokenSource` を作成し、その `Token` を呼び出しチェーンの各関数に渡します。そして各関数は `token.IsCancellationRequested` をチェックするか、`token.ThrowIfCancellationRequested()` を呼び出すか、それを尊重する非同期 API にトークンを渡します。`cts.Cancel()` (または `await cts.CancelAsync()`) が発火するとトークンが反転し、チェックしている各所が反応します。チェックするよう依頼されていないものは何もキャンセルされません。

だから、トークンなしの `Task.Run(() => LongLoop())` はキャンセルできません。コンパイラーは代わりにキャンセルを注入してくれません。

## 最小限の正しいパターン

```csharp
// .NET 11, C# 14
using var cts = new CancellationTokenSource();

Task work = DoWorkAsync(cts.Token);

// Later, from a Cancel button, a timeout, whatever:
await cts.CancelAsync();

try
{
    await work;
}
catch (OperationCanceledException)
{
    // Expected when cts triggers. Not an error.
}

static async Task DoWorkAsync(CancellationToken ct)
{
    for (int i = 0; i < 1_000_000; i++)
    {
        ct.ThrowIfCancellationRequested();
        await Task.Delay(10, ct); // async APIs should take the token
    }
}
```

ここでは 3 つのルールが働いています:

1. `CancellationTokenSource` は破棄されます (`using var`) ので、内部タイマーと wait handle が解放されます。
2. 呼び出しチェーンの各レベルが `CancellationToken` を受け取り、チェックするか転送します。
3. 呼び出し側はタスクを `await` し、`OperationCanceledException` をキャッチします。キャンセルは例外として表面化するため、`finally` ブロックでのクリーンアップは引き続き実行されます。

## CPU バウンドのループ: ThrowIfCancellationRequested

CPU バウンドの作業では、`ct.ThrowIfCancellationRequested()` を、応答性が受け入れられるがチェック自体をホットパスにしない程度の頻度で散りばめてください。チェックは安価 (`int` への `Volatile.Read`) ですが、数千万項目を処理するタイトな内側ループの中ではプロファイルに現れます。適切なデフォルトは、「1 単位の作業」を行う外側ループの 1 イテレーションごとに 1 回です。

```csharp
// .NET 11, C# 14
static long SumPrimes(int max, CancellationToken ct)
{
    long sum = 0;
    for (int n = 2; n <= max; n++)
    {
        if ((n & 0xFFFF) == 0) ct.ThrowIfCancellationRequested(); // every 65536 iterations
        if (IsPrime(n)) sum += n;
    }
    return sum;
}
```

作業が `Task.Run` で起動されたバックグラウンドスレッドにある場合、`Task.Run` 自体にもトークンを渡してください:

```csharp
var task = Task.Run(() => SumPrimes(10_000_000, cts.Token), cts.Token);
```

`Task.Run` にトークンを渡すということは、delegate が実行を開始する **前** にトークンがキャンセルされた場合、タスクは実行されずに直接 `Canceled` に遷移するということです。トークンなしだと delegate は完走し、内部チェックだけがそれを止められます。

## I/O バウンドの作業: すべての非同期 API にトークンを転送する

すべてのモダンな .NET I/O API は `CancellationToken` を受け取ります。`HttpClient.GetAsync`、`Stream.ReadAsync`、`DbCommand.ExecuteReaderAsync`、`SqlConnection.OpenAsync`、`File.ReadAllTextAsync`、`Channel.Reader.ReadAsync`。トークンを下まで渡さないと、キャンセルはあなたの層で止まり、その下の I/O は OS かリモート側が諦めるまで続きます。

```csharp
// .NET 11, C# 14
static async Task<string> FetchWithTimeoutAsync(string url, TimeSpan timeout, CancellationToken outer)
{
    using var http = new HttpClient();
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(outer);
    linked.CancelAfter(timeout);

    using HttpResponseMessage resp = await http.GetAsync(url, linked.Token);
    resp.EnsureSuccessStatusCode();
    return await resp.Content.ReadAsStringAsync(linked.Token);
}
```

このスニペットで取り上げる価値がある点が 2 つあります。`CreateLinkedTokenSource` は「呼び出し側がキャンセルしたい」と「`timeout` 後に諦めた」を 1 つのトークンに結合します。そして `CancelAfter` はタイムアウトを表現する正しい方法であり、作業と競合する `Task.Delay` ではありません。`Task` をフルにアロケートせず、タイマーキューに 1 エントリを使うからです。

## デッドロックの罠、私が見る頻度順

### 罠 1: キャプチャーするコンテキストから async メソッドでブロックする

```csharp
// BAD on WinForms, WPF, or any SynchronizationContext that runs on one thread
string html = FetchAsync(url).Result;
```

`FetchAsync` は内部で `await` し、継続を捕捉された `SynchronizationContext` にポストし返します。そのコンテキストは UI スレッドです。UI スレッドは `.Result` でブロックされています。継続は実行できません。デッドロックです。タスクが完了することは決してないので、キャンセルはここでは助けになりません。

解決策はコード内の `ConfigureAwait(false)` ではありません。解決策はそもそもブロックしないことです。呼び出し側を async にしてください:

```csharp
string html = await FetchAsync(url);
```

どうしても `await` できない場合 (たとえばコンストラクター)、まず `Task.Run` で捕捉されたコンテキストから抜け出してください。それは降伏であって解決ではありません。

### 罠 2: 外側の await だけに ConfigureAwait(false)

ライブラリ作者が 1 つの呼び出しを `ConfigureAwait(false)` でラップし、ユニットテストでデッドロックが消えるのを見て出荷します。そして呼び出し側が全体を `.Result` でラップするとデッドロックが戻ってきます。なぜなら呼び出される側の内側の `await` がコンテキストをキャプチャーしていたからです。

`ConfigureAwait(false)` は `await` ごとの設定です。すべてのライブラリメソッドのすべての `await` が使うか、どれも使わないかのいずれかです。`Nullable` アノテーションの世界は楽ですが、こちらはそうではありません。.NET 11 の C# 14 では、`CA2007` アナライザーをオンにしてライブラリで `ConfigureAwait(false)` を強制でき、タスクの例外を気にせず完了のためだけに待ちたいときは `ConfigureAwaitOptions.SuppressThrowing` を使えます。

### 罠 3: 同じトークンに登録されたコールバックから CancellationTokenSource.Cancel() を呼び出す

`CancellationTokenSource.Cancel()` はデフォルトで登録されたコールバックを呼び出し元スレッドで **同期的に** 実行します。これらのコールバックのいずれかが同じソースで `Cancel()` を呼び出したり、別のコールバックが保持しているロックでブロックしたりすると、再帰的または再入可能なデッドロックになります。.NET 11 では、ロックを保持しているとき、`SynchronizationContext` 上にいるとき、またはコールバックが非自明なときは、`await cts.CancelAsync()` を優先してください。`CancelAsync` はコールバックを非同期にディスパッチするため、`Cancel` は最初に制御を戻します。

```csharp
// .NET 11, C# 14
lock (_state)
{
    _state.MarkStopping();
}
await _cts.CancelAsync(); // callbacks fire after we are out of the lock
```

### 罠 4: トークンを無視するタスク

「キャンセルが何もしない」の最もよくある原因はデッドロックではなく、チェックしないタスクです。源で直してください:

```csharp
static async Task BadAsync(CancellationToken ct)
{
    await Task.Delay(5000); // no token, so unaffected by cancel
}

static async Task GoodAsync(CancellationToken ct)
{
    await Task.Delay(5000, ct); // throws OperationCanceledException on cancel
}
```

呼び出される側を変更できない場合 (トークンパラメーターのないサードパーティコード)、.NET 6+ の `Task.WaitAsync(CancellationToken)` が逃げ道をくれます。下の作業がキャンセル不能でも、待ち受け自体はキャンセル可能になります。

```csharp
// .NET 11, C# 14
Task<string> hardcoded = LegacyFetchThatIgnoresTokensAsync();
string result = await hardcoded.WaitAsync(ct); // returns immediately on cancel; the underlying work keeps running
```

これが何をするかについて正直になりましょう。あなたをブロック解除するだけで、作業を止めるわけではありません。.NET 11 では、下にある `HttpClient`、ファイルハンドル、またはレガシーコードがやっていることは終わるまで続き、その結果は捨てられます。排他リソースを保持する長時間ループでは、これはリークであってキャンセルではありません。

## リンクトークン: 呼び出し側のキャンセル + タイムアウト + shutdown

現実的なサーバーエンドポイントは 3 つの理由でキャンセルしたくなります。呼び出し側が切断した、リクエストあたりのタイムアウトが経過した、ホストが shutdown している。`CreateLinkedTokenSource` はそれらを合成します。

```csharp
// .NET 11, C# 14 - ASP.NET Core 11 minimal API
app.MapGet("/report", async (HttpContext ctx, IHostApplicationLifetime life, CancellationToken requestCt) =>
{
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(requestCt, life.ApplicationStopping);
    linked.CancelAfter(TimeSpan.FromSeconds(30));

    string report = await BuildReportAsync(linked.Token);
    return Results.Text(report);
});
```

ASP.NET Core は `HttpContext.RequestAborted` を既に提供しています (`CancellationToken` パラメーターを受け取ると公開されます)。`IHostApplicationLifetime.ApplicationStopping` とリンクさせて、graceful shutdown でも実行中の作業をキャンセルできるようにし、その上にエンドポイントごとのタイムアウトを追加してください。3 つのいずれかが発火すれば、`linked.Token` が反転します。

## OperationCanceledException 対 TaskCanceledException

両方存在します。`TaskCanceledException` は `OperationCanceledException` を継承しています。特に「タスクがキャンセルされた」を「呼び出し側が別の操作をキャンセルした」と区別する必要がない限り、`OperationCanceledException` をキャッチしてください。実務では常に基底クラスをキャッチしてください。

微妙なポイント: キャンセルされたタスクを `await` すると、戻ってくる例外には元のトークンが入っていないかもしれません。どのトークンが発火したか知る必要がある場合は、どのトークンをどの API に渡したかを検査するのではなく、`ex.CancellationToken == ct` をチェックしてください。

## CancellationTokenSource を dispose してください、特に CancelAfter を使うとき

`CancellationTokenSource.CancelAfter` は内部タイマーに作業をスケジュールします。CTS の dispose を忘れると、そのタイマーエントリは GC が到達するまで生き続けます。これは混雑したサーバーではクラッシュはしないもののメモリとタイマーのリークで、`dotnet-counters` ではゆっくりした成長として現れます。`using var cts = ...;` または `using (var cts = ...) { ... }` を毎回。

CTS をバックグラウンドの所有者に渡したい場合、dispose の責任者は正確に 1 箇所に決め、トークンを保持する全員が解放した後にのみ dispose してください。

## バックグラウンドサービス: stoppingToken はあなたの味方

`BackgroundService` では、`ExecuteAsync` はホストが shutdown を開始したときに反転する `CancellationToken stoppingToken` を受け取ります。サービス内のすべてのキャンセルチェーンのルートとしてこれを使ってください。shutdown と切り離された新しい CTS インスタンスを作らないでください。さもないと graceful な `Ctrl+C` はタイムアウトして、ホストはプロセスを強制終了します。

```csharp
// .NET 11, C# 14
public sealed class Crawler(IHttpClientFactory http, ILogger<Crawler> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var perItem = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                perItem.CancelAfter(TimeSpan.FromSeconds(10));

                await CrawlNextAsync(http.CreateClient(), perItem.Token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break; // host is stopping; exit cleanly
            }
            catch (OperationCanceledException)
            {
                log.LogWarning("Per-item timeout elapsed, continuing.");
            }
        }
    }
}
```

`when` フィルター付きの `catch` は「shutdown 中」と「1 単位の作業のタイムアウト」を区別します。shutdown は外側ループを break します。アイテムごとのタイムアウトはログして続行します。

## Thread.Abort、Task.Dispose、またはハードキルはどうなのか?

`Thread.Abort` は .NET Core でサポートされておらず、.NET 11 で `PlatformNotSupportedException` を投げます。`Task.Dispose` は存在しますが、あなたが思うものではありません。`WaitHandle` を解放するだけで、タスクをキャンセルしません。「このタスクを殺す」API は設計上ありません。もっとも近い逃がし弁は、本当にキャンセル不能な作業を別プロセス (`Process.Start` + `Process.Kill`) で実行し、プロセス間のオーバーヘッドを受け入れることです。それ以外のすべてにおいて、協調的キャンセルが API です。

## まとめ

機能するキャンセルボタンは 10 回中 9 回、小さな 3 つの習慣の結果です。すべての async メソッドが `CancellationToken` を受け取って転送する、すべての長いループが `ThrowIfCancellationRequested` を適切な頻度で呼び出す、そして呼び出しチェーンのどこも `.Result` や `.Wait()` でブロックしない。CTS に `using` を付け、タイムアウトには `CancelAfter`、ロック内では `await CancelAsync()`、そして変更できないコードの逃がし弁として `WaitAsync` を。

## 関連記事

- [IAsyncEnumerable でデータベースの行をストリーミングする](/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/)。同じトークン配線に大きく依存しています。
- [.NET 11 ランタイムでのよりクリーンな async スタックトレース](/2026/04/dotnet-11-runtime-async-cleaner-stack-traces/)。パイプラインの深いところで `OperationCanceledException` が浮かび上がるときに役立ちます。
- [C# 14 のメソッドから複数の値を返す方法](/ja/2026/04/how-to-return-multiple-values-from-a-method-in-csharp-14/) は、「結果またはキャンセル理由」を返したい async メソッドとよく組み合わさります。
- [.NET 9 における `lock (object)` の終焉](/2026/01/net-9-the-end-of-lockobject/)。キャンセルコードが動く、より広い threading コンテキストについて。

## 参考資料

- [Task Cancellation](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/task-cancellation), MS Learn.
- [Cancellation in Managed Threads](https://learn.microsoft.com/en-us/dotnet/standard/threading/cancellation-in-managed-threads), MS Learn.
- [Coalesce cancellation tokens from timeouts](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/coalesce-cancellation-tokens-from-timeouts), MS Learn.
- [`CancellationTokenSource.CancelAsync`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.cancellationtokensource.cancelasync), API リファレンス。
- [`Task.WaitAsync(CancellationToken)`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.waitasync), API リファレンス。
