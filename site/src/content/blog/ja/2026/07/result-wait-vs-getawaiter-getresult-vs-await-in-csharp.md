---
title: "C# の .Result vs .Wait() vs GetAwaiter().GetResult() vs await: どれを使うべきか"
description: "await はほぼ常に正しい答えです。本当にブロックしなければならないときは、GetAwaiter().GetResult() が元の例外をスローするため .Result や .Wait() より優れています。.NET 11 と C# 14 のための判断マトリクスです。"
pubDate: 2026-07-24
template: vs
tags:
  - "comparison"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "ja"
translationOf: "2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-24
---

`Task<T>` があってそこから `T` を取り出したいとき、選択肢は 4 つあります。`task.Result`、`task.Wait()`、`task.GetAwaiter().GetResult()`、そして `await task` です。`await` を使ってください。スレッドをブロックしない唯一の選択肢であり、ラッパーではなくコードが実際にスローした例外をそのままスローします。他の 3 つはいずれも呼び出し元のスレッドをブロックし、デッドロックのリスクを伴います。その中では `GetAwaiter().GetResult()` が最もましです。`await` と同じように例外をアンラップするからです。これに頼るのは、`async` にできない同期メソッドの中で行き詰まったときだけにしてください。これは .NET 11 (`Microsoft.NET.Sdk` 11.0.0) と C# 14 で当てはまり、セマンティクスは .NET Framework 4.5 以降安定しています。

## 4 つを一覧で

| 挙動                                 | `await`            | `GetAwaiter().GetResult()` | `.Result`           | `.Wait()`           |
| ------------------------------------ | ------------------ | -------------------------- | ------------------- | ------------------- |
| 呼び出し元スレッドをブロックする     | いいえ             | はい                       | はい                | はい                |
| 値を返す                             | はい (`T`)         | はい (`T`)                 | はい (`T`)          | いいえ (void)       |
| 非ジェネリックの `Task` で動作する   | はい               | はい                       | いいえ (`Task<T>` のみ) | はい            |
| スローされる例外                     | 元の例外           | 元の例外                   | `AggregateException`| `AggregateException`|
| デッドロックのリスク (キャプチャされたコンテキスト) | いいえ | はい                       | はい                | はい                |
| 負荷時の thread pool 枯渇            | いいえ             | はい                       | はい                | はい                |
| `ValueTask<T>` で安全               | はい (1 回のみ)    | いいえ                     | 完了済みの場合のみ  | 該当なし            |

この表を `await` の列で上から下まで読むと、きれいな 1 列になります。ブロックなし、実際の値、元の例外、デッドロックなし。他のどの列にも、望まない行に少なくとも 1 つの「はい」があります。それが議論のすべてです。この記事の残りは、各行がなぜ真なのか、そしてそのトレードオフが実際にいつあなたの手を縛るのかを説明します。

## なぜ await がデフォルトで勝つのか

`await` は `.Result` を呼ぶより洗練された方法、というわけではありません。別の操作です。まだ完了していないタスクを `await` すると、メソッドは中断し、制御を呼び出し元に返します。どのスレッドも座って待つことはありません。ランタイムはメソッドの残りを継続 (continuation) としてスケジュールし、タスクが完了したときに実行します。ブロッキングメンバーはその逆をします。現在のスレッドを停め、タスクが完了するまで保持します。

その 1 つの違いが、`await` がスケールしブロックがスケールしない理由です。サーバーでは、ブロックされたスレッドは待つ以外に何もしない thread pool のスレッドであり、負荷時には枯渇します。UI スレッドでは、ブロックされたスレッドは固まったウィンドウです。`await` はスレッドを解放して他の作業 (別のリクエストの処理、メッセージループの回転) をさせ、後でメソッドを再開します。

```csharp
// .NET 11, C# 14 -- the default: no thread is blocked while the I/O runs
public async Task<string> GetGreetingAsync(HttpClient http)
{
    string body = await http.GetStringAsync("https://example.com/greeting");
    return body.Trim();
}
```

`await` は、あなたが実際にスローした例外も返します。`GetStringAsync` が `HttpRequestException` をスローすると、`await` はその `HttpRequestException` を、元のスタックトレースとともに、await したまさにその場所で再スローします。アンラップも `catch (AggregateException)` の体操も不要です。ブロックする具体的な理由がない限り、判断はここで終わりです。

## GetAwaiter().GetResult() が正しいブロッキング呼び出しになるとき

非同期にできないこともあります。クラスのコンストラクターは `async` にできません。C# 7.1 より前の `Main`、`Dispose` (`DisposeAsync` ではない)、シグネチャを制御できないインターフェイスメソッド、同期デリゲートを渡してくるサードパーティプラグインのエントリーポイント。これらは本当に同期的な継ぎ目です。その中から非同期コードを呼ぶ必要があり、再構成もできないなら、何かをブロックするしかありません。`GetAwaiter().GetResult()` でブロックしてください。

これが `.Result` や `.Wait()` に勝る理由は、例外の忠実さです。`Task.Result` と `Task.Wait()` は `async`/`await` より前からあり、.NET 4.0 の Task Parallel Library に由来します。そこでは 1 つの `Task` (`Task.WhenAll` を思い浮かべてください) が一度に複数の例外で失敗することがありました。それを表現するため、内部例外がちょうど 1 つのときでも、失敗した内容を `AggregateException` にラップします。`GetAwaiter().GetResult()` は `async`/`await` とともに .NET 4.5 で追加され、`await` の規約に従います。最初の例外をラップせずに直接スローします。

```csharp
// .NET 11, C# 14 -- same failing task, three different exceptions surfaced
static async Task<int> FailAsync()
{
    await Task.Yield();
    throw new InvalidOperationException("boom");
}

// .Result -> throws AggregateException wrapping InvalidOperationException
try { _ = FailAsync().Result; }
catch (Exception ex) { Console.WriteLine(ex.GetType().Name); } // AggregateException

// GetAwaiter().GetResult() -> throws InvalidOperationException directly
try { _ = FailAsync().GetAwaiter().GetResult(); }
catch (Exception ex) { Console.WriteLine(ex.GetType().Name); } // InvalidOperationException
```

`catch` ブロックを `InvalidOperationException` 向けに書いている場合 (そうすべきです)、`.Result` は例外がラップされて届くため、それらを黙ってすり抜けます。結果として `AggregateException` を捕捉して `.InnerException` を呼ぶことになるか、もっと悪ければ、誰もラッパーを予期していなかったために例外が未処理のままになります。`GetAwaiter().GetResult()` はそのすべてを避けます。だからこそ、Stephen Cleary の「A Tour of Task」シリーズにさかのぼる標準的な指針はこうです。ブロックするしか選択肢がないなら、`GetAwaiter().GetResult()` でブロックせよ。

これは非ジェネリックの `Task` でも動作するため、「これを実行して待つ」と「これを実行して値をよこせ」の両方をカバーする唯一のブロッキング呼び出しです。

```csharp
// .NET 11, C# 14 -- blocks and unwraps, whether or not there is a return value
SaveAsync().GetAwaiter().GetResult();               // Task, no value
int count = CountAsync().GetAwaiter().GetResult();   // Task<int>, value
```

## なぜ .Result と .Wait() は厳密に劣るのか

`.Result` と `.Wait()` は `GetAwaiter().GetResult()` がすることをすべて行い (スレッドをブロックし、同じデッドロックの危険にさらされる)、その上に `AggregateException` ラッパーを付け加えます。タスクが 1 つの論理的な操作であるとき、ラッパーが役に立つシナリオはありません。`.Result` が許容できる読み方になる唯一の場所は、すでに完了していると分かっているタスク、つまりブロックしないタスクの上です。

```csharp
// .NET 11, C# 14 -- .Result on a known-completed task does not block
if (task.IsCompletedSuccessfully)
{
    var value = task.Result;   // safe: completed, so no wait, no deadlock
}
```

そこでも `GetAwaiter().GetResult()` は申し分ない代替であり、完了についての前提がいつか誤りだった場合でも例外処理を統一的に保ちます。`.Wait()` には最も狭い正当な用途があります。意図的に戻り値を求めず、`AggregateException` を明示的に処理する、撃ちっぱなし (fire-and-forget) の `Task` を待つ場合です。実際にはこれは稀で、たいていはその作業を独立したバックグラウンドジョブとして構成すべきだった兆候です。リクエストスレッドの外で作業を実行しているなら、ゆるいタスクをブロックするのではなく、[BackgroundService で撃ちっぱなしの作業を安全に実行する](/ja/2026/05/how-to-run-fire-and-forget-work-safely-in-aspnetcore-with-backgroundservice/)のパターンで行ってください。

`.Wait(timeout)` と `.Wait(cancellationToken)` には本当の罠があります。これらは待機を早めに諦めさせ、回復力があるように見えますが、そうではありません。`false` を返す `Wait(5000)` は基盤の操作をキャンセルしていません。タスクはまだ実行中で、その継続はまだキューにあり、あなたは単に待つのをやめただけです。ハングをマジックナンバーで覆い隠したにすぎません。操作に上限を設ける必要があるなら、[CancellationTokenSource.CancelAfter で非同期操作をタイムアウトさせる](/ja/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)で説明しているように、正しくキャンセルしてください。

## あなたの代わりに決めてしまう要因: デッドロックと ValueTask

2 つの要因が、選択の余地を完全に奪うことがあります。

**キャプチャされた `SynchronizationContext`。** ブロックするスレッドがシングルスレッドのコンテキスト (WPF や WinForms の UI スレッド、クラシック ASP.NET のリクエストスレッド) を所有している場合、この比較のどのブロッキング選択肢もデッドロックし得ますし、それらを切り替えても助けになりません。`GetAwaiter().GetResult()` は `.Result` とまったく同じ地点でデッドロックします。アプリケーションがハングしているとき、より良い例外の挙動は乏しい慰めです。そのメカニズムと、優先順位順のすべての修正は、[非同期メソッドでブロックするとなぜデッドロックするのか、どう直すのか](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)にあります。短く言えば、UI スレッドやクラシック ASP.NET スレッドでは、そもそもブロックしないことです。ASP.NET Core には `SynchronizationContext` がないため、この特定のデッドロックは起きませんが、ブロックは依然として負荷時に thread pool 枯渇を引き起こし、並行性でしか現れないため診断が難しくなります。

**`ValueTask<T>`。** メソッドが `Task<T>` ではなく `ValueTask<T>` を返す場合、どのブロッキングメンバーも直接使うのは安全ではありません。`ValueTask` は、値が消費された後に再利用され得る `IValueTaskSource` に裏打ちされている場合があり、消費できるのは 1 回だけです。完了していない `ValueTask` に対して `.Result` や `.GetAwaiter().GetResult()` を呼ぶのは未定義動作であり、2 回 await するのはバグです。`ValueTask<T>` を渡されて本当に await できないなら、まず `.AsTask()` で `Task<T>` に変換し、それをブロックしてください。

```csharp
// .NET 11, C# 14 -- never block a ValueTask directly; materialize a Task first
ValueTask<int> vt = ReadValueAsync();
int value = vt.AsTask().GetAwaiter().GetResult();   // safe
// int bad = vt.Result;                              // undefined if not completed
```

より明快なルールはこうです。`ValueTask` はちょうど 1 回だけ `await` し、決して保存しないこと。それをブロックするのは、設計のにおいの上にさらに設計のにおいを重ねることです。制約の全体像については、[ValueTask に価値があるのはいつか](/ja/2026/06/what-is-valuetask-and-when-is-it-worth-it/)の注記を参照してください。

## ブロックを不要にする

たいていの場合、正直な修正は最も害の少ないものを選ぶことではなく、ブロッキング呼び出しを削除することです。ブロックがほぼ常に存在するのは、続けられたはずの層で誰かが `async` の伝播をやめたからです。非同期リポジトリを呼ぶ同期コントローラーアクション、「今すぐ値が要るだけ」の `void` イベントハンドラー。どちらも通常 `async Task` (ハンドラーなら、それが正当な唯一の場所である `async void`) にできます。正しい `async void` とバグの境界は、[async void が正しいときと罠になるとき](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)で示しています。

チェーンを上から下まで非同期にすると、この記事の比較全体が蒸発します。常に `await` が使えるので、`.Result`、`.Wait()`、`GetAwaiter().GetResult()` に触れることはありません。それが判断マトリクスの裏に隠れた本当の推奨です。最良のブロッキング呼び出しは、リファクタリングで消し去ったものです。

## 推奨、あらためて

- **デフォルトは `await`。** ブロックせず、スケールし、元の例外をスローします。囲んでいるメソッドが `async` にできるなら、これが答えです。以上。
- **本当に非同期にできないなら、`GetAwaiter().GetResult()` でブロックする。** 他と同じようにブロックしますが、`AggregateException` ではなく実際の例外をスローし、`Task` と `Task<T>` の両方で動作します。
- **`.Result` と `.Wait()` は避ける。** すでに完了していると分かっているタスクの上を除いてです。単一の操作では利点なしに `AggregateException` ラッパーを付け加えます。
- **UI スレッドやクラシック ASP.NET スレッドでは決してブロックしない。** そして `ValueTask` を直接ブロックしないこと。前者はデッドロックし、後者は未定義動作です。代替がないなら `.AsTask()` で `ValueTask` を `Task` に変換してください。

すべてのブロッキング呼び出しを、呼び出し元を非同期にするための `TODO` として扱ってください。決してブロックしないバージョンのコードは、より速く、デッドロックに強く、そしておまけにより整った例外を持ちます。

## 関連記事

- [Fix: C# で非同期メソッドに対して .Result や .Wait() を呼ぶとデッドロックする](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [C# で async void が正しいときと罠になるとき](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [.NET 11 における ConfigureAwait(false) とデフォルトの比較: 今でも重要か](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [ValueTask とは何か、いつ価値があるのか](/ja/2026/06/what-is-valuetask-and-when-is-it-worth-it/)
- [C# で CancellationTokenSource.CancelAfter を使って非同期操作をタイムアウトさせる方法](/ja/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)

## 出典

- [A Tour of Task, Part 6: Results](https://blog.stephencleary.com/2014/12/a-tour-of-task-part-6-results.html) -- Stephen Cleary
- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
- [TaskAwaiter.GetResult Method](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.taskawaiter.getresult) -- Microsoft Learn
- [Task exception handling in .NET](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) -- Microsoft Learn
- [ValueTask Restrictions](https://blog.stephencleary.com/2020/03/valuetask.html) -- Stephen Cleary
