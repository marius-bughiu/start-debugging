---
title: "解決: CS4014 \"Because this call is not awaited, execution of the current method continues\" in C#"
description: "CS4014 は Task を返すメソッドを await せずに呼び出したことを意味します。await を追加するか、意図的な fire-and-forget なら _ = で破棄し、例外を処理してください。"
pubDate: 2026-07-21
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "ja"
translationOf: "2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-21
---

`CS4014` は、`Task` または `Task<T>` を返すメソッドを `async` メソッドの内部から呼び出したものの、`await` で待機しなかったときに発生します。コンパイラーは、呼び出しが完了する前に現在のメソッドの実行が続行されると警告します。呼び出しに `await` を追加して修正してください。ほとんどの場合、それが望む動作です。fire-and-forget の動作が本当に意図されている場合は、結果を破棄に代入して明示的にし (`_ = SomeAsyncCall();`)、タスクがスローする可能性のある例外を何かが処理するようにしてください。これは .NET 11 上の C# 14 に対して検証されています。この診断は `async`/`await` が C# 5 で導入されて以来この動作なので、このガイダンスはすべての最新の .NET バージョンに適用されます。

## コンテキストの中でのエラー

コンパイラーはこれをエラーではなく警告として出力します。

```
warning CS4014: Because this call is not awaited, execution of the current method continues before the call is completed. Consider applying the 'await' operator to the result of the call.
```

*warning* という語に注目してください。`CS4014` はデフォルトではビルドを止めません。まさにそれが危険な理由です。無視しやすく、それが指し示すバグ (タスクが観測されないまま実行され、その例外が黙って飲み込まれる) は本番環境になるまで現れません。多くのチームは、うっかり抜け落ちた `await` がコードレビューをすり抜けないよう、`.csproj` に `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` またはより限定的な `<WarningsAsErrors>CS4014</WarningsAsErrors>` を指定してこれをエラーに昇格させます。

この警告は `async` メソッドの内部でのみ現れます。コンパイラーは、囲んでいるメソッドをわざわざ `async` とマークしたのなら、await されていないタスク呼び出しはほぼ確実に見落としだと判断します。同じメソッドを `async` でないメソッドから呼び出しても `CS4014` はまったく出ません。これは関連する落とし穴で、後述します。

## なぜこれが起きるのか

`Task` を返す `async` メソッドは同期的に実行を開始し、最初の未完了の `await` に達した瞬間にタスクオブジェクトを返します。タスクはまだ実行中の操作を表します。`DoWorkAsync();` を単独の文として書くと、そのタスクオブジェクトを捨てることになります。ここから 2 つのことが起こり、どちらも悪いものです。

第一に、実行は待機しません。呼び出しの次の行はただちに実行され、`DoWorkAsync` が終わる前に走ります。操作の完了に依存するコード、つまりデータベースへの書き込み、ファイルのフラッシュ、キャッシュの更新などは、いまやそれと競合します。これがメッセージの "execution of the current method continues" の部分です。

第二に、さらに悪いことに、例外が消えます。タスクを `await` で待機すると、そのタスクが捕捉した例外はあなたのメソッドに再スローされ、`try`/`catch` がそれを見られます。タスクを破棄すると、再スローする先が何もありません。例外は破棄されたタスクオブジェクトの上に観測されないまま残り、ガベージコレクションが最終的にそれをファイナライズするまでそこにあります。.NET Framework 4.0 ではこれでプロセスがクラッシュしましたが、4.5 以降およびすべての最新の .NET ではデフォルトで完全に飲み込まれます。したがって、失敗した await されていないタスクは、呼び出し側から見ると成功とまったく同じに見えます。この黙った失敗こそが `CS4014` が存在する本当の理由であり、「警告を単に抑制する」がほぼ決して正しい対応ではない理由です。

コンパイラーが助けられない唯一のケースが `async void` です。`DoWorkAsync` が `Task` ではなく `void` を返す場合、await するタスクがなく `CS4014` も出ませんが、同じ問題がすべて当てはまり、さらにもう 1 つ加わります。`async void` メソッドからの例外は同期コンテキスト上で発生し、通常はプロセスを巻き添えにして落とします。これは別の診断で、[async void と async Task in C#](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) で扱っています。

## 最小限の再現

`CS4014` を引き起こす最小のコードです。

```csharp
// .NET 11, C# 14
public class OrderService
{
    public async Task PlaceOrderAsync(Order order)
    {
        SaveAsync(order);          // CS4014: not awaited
        Console.WriteLine("Order placed");   // runs before SaveAsync finishes
    }

    private async Task SaveAsync(Order order)
    {
        await Task.Delay(100);     // stand-in for a real DB write
        throw new InvalidOperationException("DB down");
    }
}
```

4 行に 2 つのバグがあります。`"Order placed"` は書き込みが走る前に出力され、`InvalidOperationException` は誰にも見られません。`PlaceOrderAsync` は、呼び出し側が知りうる限りでは成功として完了します。この警告は、注文が実際には一度も保存されなかったことをコンパイル時に得られる唯一の合図です。

よくある変種は、呼び出しを `Task.Run` やイベントハンドラーの内部に隠し、見落としやすくします。

```csharp
// .NET 11, C# 14
button.Clicked += async (s, e) =>
{
    RefreshAsync();   // CS4014: fire-and-forget by accident
};
```

## 修正方法の詳細

これらを順に検討してください。最初のものはほぼすべての実際の出現に対して正しく、残りは本物の例外的ケースのためのものです。

### 1. await を追加する (95% のケースで望む修正)

`async` メソッドの内部にいるなら、意図はほぼ常に呼び出しを待機することです。`await` を追加してください。

```csharp
// .NET 11, C# 14
public async Task PlaceOrderAsync(Order order)
{
    await SaveAsync(order);        // waits, and re-throws any exception
    Console.WriteLine("Order placed");
}
```

これで `"Order placed"` は書き込みが完了した後にのみ出力され、`SaveAsync` がスローすれば例外は `PlaceOrderAsync` の外へ伝播し、呼び出し側の `try`/`catch` (または ASP.NET Core のパイプライン) が処理できます。この 1 つの変更で、順序のバグと飲み込まれた例外のバグを一度に修正できます。他の選択肢に手を伸ばすのは、待機することがなぜ間違いなのかを説明できるときだけにしてください。

### 2. Task.WhenAll で複数の呼び出しをまとめて待機する

`await` で待機しなかった理由が、複数の操作を並行して走らせたかったからなら、タスクを捨てずに集めてまとめて待機してください。

```csharp
// .NET 11, C# 14
public async Task NotifyAllAsync(IEnumerable<User> users)
{
    var tasks = users.Select(u => SendEmailAsync(u));
    await Task.WhenAll(tasks);     // all run concurrently, all awaited
}
```

`Task.WhenAll` は観測を手放すことなく並行性を与えます。各タスクを開始し、最後のものが終わったときに完了し、いずれかが失敗すれば再スローします。これはファンアウト作業の正しいパターンであり、タスクが await されるため `CS4014` を解消します。これと他の並列アプローチとのトレードオフについては、[Parallel.ForEach と Parallel.ForEachAsync と Task.WhenAll](/ja/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) を参照してください。

### 3. 待機する代わりにタスクを返す

メソッドが呼び出しの後に何もしない薄い受け渡しなら、多くの場合 `async`/`await` はまったく必要ありません。両方を外してタスクを返してください。

```csharp
// .NET 11, C# 14
public Task PlaceOrderAsync(Order order)
{
    return SaveAsync(order);       // caller awaits; no state machine here
}
```

これで `async` 修飾子が外れるため `CS4014` はもはや適用されず (警告は `async` メソッドの内部でのみ発生します)、必要のないメソッドのためにステートマシンを生成するオーバーヘッドを省けます。呼び出し側は依然として `await` で待機するタスクを受け取ります。唯一の注意点として、`await` がないと例外は呼び出しの地点ではなく呼び出し側が返されたタスクを await したときに表面化し、`using` ブロックは返されたタスクが完了する前にそのリソースを破棄してしまいます。これは本物の受け渡しにのみ使ってください。

### 4. 明示的に破棄する (fire-and-forget が本当に意図されているときだけ)

作業を開始して待機したくない場合が実際にあります。メトリクスの記録、キャッシュのウォームアップ、ベストエフォートの通知の起動などです。その場合は、破棄で意図を明白にし、失われないよう例外を自分で処理してください。

```csharp
// .NET 11, C# 14
public void OnUserLoggedIn(User user)
{
    _ = LogAnalyticsAsync(user);   // intentional fire-and-forget, warning cleared
}

private async Task LogAnalyticsAsync(User user)
{
    try
    {
        await _analytics.RecordAsync(user.Id);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "Analytics failed for {UserId}", user.Id);
    }
}
```

破棄 `_ =` は、コンパイラーにも次の読み手にも「はい、これを await しないつもりです」と伝えます。重要なのは、破棄は警告を解消しますが、飲み込まれた例外の問題は解決*しない*ということです。ですから `LogAnalyticsAsync` の内部の `try`/`catch` が本当の仕事をしています。内部の例外処理を持たない fire-and-forget タスクは、いつか起きるクラッシュか、黙ったデータ損失のバグです。

破棄をつけても、Web アプリでの生の fire-and-forget は脆弱です。リクエストが完了し、タスクが途中の間にホストがシャットダウンを開始して、それをキャンセルまたは強制終了する可能性があります。本当に完了しなければならないものについては、リクエストから fire-and-forget をまったく行わず、作業をバックグラウンドのキューに渡してください。このパターンは [ASP.NET Core で BackgroundService を使って fire-and-forget 作業を安全に実行する方法](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/) で扱っています。

## 落とし穴と変種

いくつかの状況は、メッセージが明示しない理由で `CS4014` を生じさせたり、それを隠したりします。

- **`async` メソッドの外では警告は出ません。** まったく同じ await されていない呼び出しでも、通常の (`async` でない) メソッドでは `CS4014` はまったく出ません。コンパイラーは、async でないメソッドは正当にバックグラウンド作業を開始しているかもしれないと想定します。誰かが `await` と囲んでいる `async` 修飾子を同時に外したときにバグが忍び込むのはこのためです。それを捕まえたはずの警告が修飾子とともに消えます。警告を安全網として頼るなら、`<WarningsAsErrors>CS4014</WarningsAsErrors>` を有効にしたまま、Task を返す単独の呼び出しをすべて疑ってください。

- **破棄は警告を黙らせますが、バグは黙らせません。** `_ = DoAsync();` は `CS4014` を解消しますが、`DoAsync` がスローして内部で何もキャッチしなければ、例外は依然として失われます。破棄は意図の表明であって、観測されない例外の修正ではありません。fire-and-forget には常に内部の `try`/`catch` を添えてください。

- **`.Result` や `.Wait()` でブロックするのは修正ではありません。** 抜けている `await` を `SaveAsync(order).Result` に置き換えると警告は消え、タスクが終わるまでブロックしますが、UI や従来型 ASP.NET の同期コンテキストではデッドロックし、それ以外の場所ではスレッドを浪費します。呼び出し側を `async` にできないためブロックしたくなったら、まず [async メソッドに対して .Result や .Wait() を呼び出したときに得られるデッドロック](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) を読んでください。

- **`Task.Run(() => FooAsync())` は内側のタスクを飲み込みます。** デリゲートが `void` を返す `Task.Run` に `async` ラムダ (`async void` ラムダ) を渡すと、ラムダが最初の await を*開始した*ときに完了する `Task` が得られ、内側の作業が終わったときではありません。返されたタスクが本当の作業を追跡するよう、`Task.Run(FooAsync)` または `Task.Run(async () => await FooAsync())` を選び、そのタスクを `await` してください。

- **決して受け渡さない `CancellationToken`。** 居座る fire-and-forget タスクのよくある原因は、メソッドにキャンセルされる手段がないため、呼び出し側が先へ進んだ後も走り続けることです。await されていない呼び出しがバックグラウンド作業なら、きれいに停止できるようトークンをその中へ通してください。[async メソッドを通して CancellationToken を伝播する方法](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) を参照してください。

- **アナライザーの CA2012 と VSTHRD110 との重なり。** コンパイラーの `CS4014` に加えて、.NET のアナライザー (`ValueTask` 向けの `CA2012`) と Visual Studio のスレッド化アナライザー (`VSTHRD110`, "observe the awaitable result") は、同じ種類の見落としを、`CS4014` が沈黙する一部の `async` でないメソッドを含む、より多くの場所で指摘します。await されていないタスクのチェックを `async` メソッドの内部だけでなくあらゆる場所で欲しいなら、これらのアナライザーを有効にすることでコンパイラー警告が残す隙間を埋められます。

心に留めておくべきメンタルモデルは次のとおりです。`CS4014` は、タスクが観測されないまま実行されようとしているとコンパイラーが告げているものです。実際に何が正しいかを判断し、それに応じて行動してください。待機したかった (`await` を追加する)、複数のことを並行して走らせたかった (`Task.WhenAll`)、メソッドは受け渡しである (タスクを返す)、または本当に fire-and-forget したい (`_ =` で破棄し内部で例外を処理する) のいずれかです。例外を未処理のまま破棄で警告を抑制することは、コンパイル時の後押しを実行時の黙った失敗に変えるだけであり、それこそまさに警告が防ぐために存在するバグです。

## 関連記事

- [async void と async Task in C#: それぞれが正しいのはいつか](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)：この呼び出しの `void` を返すバージョンがなぜさらに危険で、警告を出さないのかについて。
- [解決: async メソッドに対して .Result や .Wait() を呼び出したときのデッドロック in C#](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)：ブロックが CS4014 を黙らせる妥当な方法でない理由について。
- [ASP.NET Core で BackgroundService を使って fire-and-forget 作業を安全に実行する方法](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)：リクエストより長く生きなければならない作業を開始する正しい方法について。
- [Parallel.ForEach と Parallel.ForEachAsync と Task.WhenAll](/ja/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/)：多数の非同期操作を並行して実行する方法を選ぶために。
- [.NET 11 で async メソッドを通して CancellationToken を伝播する方法](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)：バックグラウンド作業を孤立させるのではなくキャンセル可能にするために。

## 出典

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol (C# reference)](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs4014) (`CS4014` の正確なテキストと、await で待機するか `_ =` で明示的に破棄するというガイダンス)。
- Microsoft Learn, [Asynchronous programming with async and await](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/) (Task を返す async メソッドがどう実行され、例外がどこで捕捉されるか)。
- Microsoft Learn, [Task.WhenAll method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (すべての待機タスクが終わったときに完了し、集約された失敗を再スローすること)。
- Microsoft Learn, [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012) (コンパイラー警告が見逃す観測されない awaitable を捕まえるアナライザー)。
