---
title: "修正: C# で Task.WhenAll を待機したときの AggregateException \"One or more errors occurred\""
description: "await Task.WhenAll は失敗のうち 1 つしか再スローしません。WhenAll のタスクを変数に保持し、Exception.InnerExceptions を読めばすべてのエラーを確認できます。"
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "ja"
translationOf: "2026/08/fix-aggregateexception-one-or-more-errors-occurred-when-awaiting-task-whenall"
translatedBy: "claude"
translationDate: 2026-08-05
---

`Task.WhenAll` の中で複数のタスクが失敗すると、返されたタスクは "One or more errors occurred" というメッセージを持つ `AggregateException` で失敗状態になりますが、`await` はそれを展開して内部例外のうち 1 つだけを再スローします。それ以外の失敗は黙って捨てられ、あなたの `catch` ブロックには届きません。修正方法は、`Task.WhenAll` が返すタスクをローカル変数に保持し、`try` の中で待機し、`catch` の中で `whenAll.Exception.InnerExceptions` を読むことです。`catch` で `AggregateException` という型そのものが見えている場合は、待機ではなく `.Wait()` や `.Result` でブロックしているということであり、それは別の、より深刻な問題です。.NET 11 (`Microsoft.NET.Sdk` 11.0.0、C# 14) で確認し、ランタイムの挙動は .NET 10.0.5 で計測しました。該当するランタイムのコードは `release/10.0` ブランチと `main` ブランチでバイト単位で同一です。

## エラーの実際の姿

`WhenAll` のタスクをブロックして待つと、ラッパーがそのまま返ってきます。

```
Unhandled exception. System.AggregateException: One or more errors occurred. (Connection refused) (The operation has timed out.)
 ---> System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   --- End of inner exception stack trace ---
   at System.Threading.Tasks.Task.ThrowIfExceptional(Boolean includeTaskCanceledExceptions)
   at System.Threading.Tasks.Task.Wait(Int32 millisecondsTimeout, CancellationToken cancellationToken)
```

`await` で待機すると `AggregateException` はまったく現れず、内部例外の 1 つだけが出てきます。

```
Unhandled exception. System.Net.Http.HttpRequestException: Connection refused
   at OrderSync.FetchAsync(String url)
   at OrderSync.SyncAllAsync()
```

どちらも根っこは同じ状況です。この 2 つの見え方があるせいで、このエラーを検索すると矛盾したアドバイスにたどり着きます。

## なぜ await は 1 つを除くすべての失敗を隠すのか

`Task.WhenAll` は `Faulted` 状態で完了し、「その例外には、渡された各タスクから取り出した展開済み例外の集合が集約されて含まれる」とドキュメントに記載されています。この集約は返されたタスクの `Exception` プロパティに存在し、実際にすべての失敗を保持しています。

失われるのは 1 つ上の層です。`await` はタスクの例外を展開して再スローすると仕様で決まっているため、単一のタスクが失敗したときは `AggregateException` ではなく `HttpRequestException` を捕捉することになります。この展開はデフォルトとして正しい挙動です。ほとんどの非同期 API はせいぜい 1 つのエラーしか生まないので、すべての await を `catch (AggregateException ae) { ae.InnerException ... }` で囲むのは苦痛でしかありません。`Task.WhenAll` はその前提が崩れる主要な API ですが、awaiter には「4 件ありました」と伝える手段がありません。リストから exception dispatch info を 1 つ取り出して再スローするだけです。これは [dotnet/runtime#31494](https://github.com/dotnet/runtime/issues/31494) で提起され、さらに [dotnet/runtime#47605](https://github.com/dotnet/runtime/issues/47605) でも集約全体を伝播するオプトインの await が要望されました。どちらも出荷されていないため、以下の回避策が今も答えです。

この帰結は `catch` 句にとって重要です。`await Task.WhenAll(...)` の後ろに置いた `catch (AggregateException)` は決して発火しません。書いてしまっている場合それはデッドコードであり、本物の例外はその横をすり抜けていきます。

## 最小の再現コード

```csharp
// .NET 11, C# 14
static async Task FailAsync(string message)
{
    await Task.Delay(10);
    throw new InvalidOperationException(message);
}

try
{
    await Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));
}
catch (Exception ex)
{
    Console.WriteLine(ex.Message);   // prints one message, not three
}
```

3 つの失敗が入って 1 つだけ出てきます。`catch` ブロックの中から残り 2 つを取り戻す方法はありません。集約への唯一の参照が、`Task.WhenAll` が返して `await` が消費した一時値だったからです。

## 修正 1: WhenAll のタスクを保持して InnerExceptions を読む

これが圧倒的多数のケースにおける修正であり、変更点はローカル変数 1 つだけです。

```csharp
// .NET 11, C# 14
Task whenAll = Task.WhenAll(FailAsync("first"), FailAsync("second"), FailAsync("third"));

try
{
    await whenAll;
}
catch
{
    // whenAll.Exception is the AggregateException the await threw away
    foreach (Exception inner in whenAll.Exception!.InnerExceptions)
    {
        _logger.LogError(inner, "Sync step failed");
    }
    throw;
}
```

`whenAll.Exception` が null でないのは `whenAll.Status == TaskStatus.Faulted` のときちょうどであり、その `InnerExceptions` コレクションは失敗したタスクごとに 1 件を保持し、いずれも元のスタックトレースが保たれています。空の `catch` と `throw` の組み合わせは呼び出し側の既存の挙動 (展開済みの単一例外が見える) を保ちつつ、ログには完全な情報を残します。

これを機械的に適用しても安全な理由が 2 つあります。1 つ目は、`Task.WhenAll(...)` の呼び出し自体を `try` の中に入れないことです。スローするのは `await` であって呼び出しではありませんが、代入を外に出しておくと `catch` から変数が見えるようになります。2 つ目は、前節の理由により `catch (AggregateException)` ではなく `catch` または `catch (Exception)` を使うことです。

## 修正 2: WhenAll のタスクをそもそも失敗させない

ファンアウトが部分的な失敗を前提とするバッチ処理なら、個々のタスクから例外を逃がさない設計のほうがきれいです。各作業単位をラップして、スローする代わりに結果を返すようにします。

```csharp
// .NET 11, C# 14
static async Task<(int Id, Exception? Error)> RunSafeAsync(int id, Func<Task> work)
{
    try
    {
        await work();
        return (id, null);
    }
    catch (Exception ex)
    {
        return (id, ex);
    }
}

var results = await Task.WhenAll(orders.Select(o => RunSafeAsync(o.Id, () => SyncAsync(o))));

foreach (var (id, error) in results.Where(r => r.Error is not null))
{
    _logger.LogError(error, "Order {OrderId} failed", id);
}
```

`Task.WhenAll` は常に完走するようになるので、展開すべき集約もなく、正しく書くべき例外フィルターもなく、各失敗とそれを引き起こした要素との対応関係が残ります。この対応関係こそ修正 1 では得られないものです。`InnerExceptions` は例外のフラットなリストであり、それを生んだタスクへの逆参照を持ちません。失敗分をリトライしたい場合や、どのレコードが拒否されたかを報告したい場合はこの形を使ってください。

代償として、本当に致命的なエラーが自力で伝播しなくなります。`results` にエラーが含まれるときどうするかを明示的に決めてください。決めなければ、それは黙って失敗する仕組みです。

## 修正 3: 集約全体を意図的に再スローする

呼び出し側が本当にすべての失敗を見るべきなら、`await` に 1 つ選ばせるのではなく集約を再スローします。`ExceptionDispatchInfo` は元のスタックトレースを保ちます。

```csharp
// .NET 11, C# 14
using System.Runtime.ExceptionServices;

public static async Task WhenAllWithAggregateAsync(IEnumerable<Task> tasks)
{
    Task whenAll = Task.WhenAll(tasks);
    try
    {
        await whenAll;
    }
    catch
    {
        ExceptionDispatchInfo.Capture(whenAll.Exception!).Throw();
    }
}
```

このヘルパーの呼び出し側はすべての内部例外を含む `AggregateException` を受け取ります。`await` の後ろに `catch (AggregateException)` を書く人が本当に求めているのはこれです。1 つの論理的な操作が実際に複数の形で同時に失敗する境界、たとえばすべてのバリデーションエラーを報告しなければならないバッチインポートなどで使ってください。デフォルトにはしないでください。すべての呼び出し側に `AggregateException` の処理を押し付けることになり、それこそ `await` の展開が取り除こうとしたエルゴノミクス上の問題です。

## await は実際にどの例外をスローするのか

ここは既存の回答の多くが間違っている箇所で、「最初の例外」と書いているものも含まれます。どのオーバーロードを呼んだかで決まり、その違いは決定的です。

```csharp
// .NET 10.0.5, C# 14 -- three tasks that fail at staggered times,
// slowest one first in argument order
static async Task FailAfterAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

static async Task<int> FailAfterIntAsync(int ms, string message)
{
    await Task.Delay(ms);
    throw new InvalidOperationException(message);
}

// non-generic overload -> Task
var nonGeneric = Task.WhenAll(
    FailAfterAsync(150, "index0-slow"),
    FailAfterAsync(80,  "index1-medium"),
    FailAfterAsync(10,  "index2-fast"));
// await throws:    index2-fast
// InnerExceptions: index2-fast, index1-medium, index0-slow

// generic overload -> Task<int[]>
var generic = Task.WhenAll(
    FailAfterIntAsync(150, "index0-slow"),
    FailAfterIntAsync(80,  "index1-medium"),
    FailAfterIntAsync(10,  "index2-fast"));
// await throws:    index0-slow
// InnerExceptions: index0-slow, index1-medium, index2-fast
```

非ジェネリックの `Task.WhenAll` は `InnerExceptions` を**完了時刻**順に並べます。ジェネリックの `Task.WhenAll<TResult>` は**引数の位置**順に並べます。どちらも `InnerExceptions[0]` をスローします。この結果は .NET 10.0.5 で繰り返し実行しても安定していました。

原因はランタイムのソースコードから読み取れます。どちらの promise も [`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs) にあります。非ジェネリックの `WhenAllPromise` は入力配列を意図的に保持せず、完了コールバックである `Invoke` が失敗したタスクを完了した順にリストへ追加し、最後にそのリストを走査します。

```csharp
// dotnet/runtime, Task.WhenAllPromise.Invoke
if (failedOrCanceled is List<Task> list)
{
    foreach (Task task in list) { HandleTask(task); }
}
```

ジェネリックの `WhenAllPromise<T>` は `T[]` の結果を順序どおりに生成する必要があるため配列を保持し、インデックスで走査します。

```csharp
// dotnet/runtime, Task.WhenAllPromise<T>.Invoke
for (int i = 0; i < m_tasks.Length; i++)
{
    Task<T>? task = m_tasks[i];
    if (task.IsFaulted) { observedExceptions ??= new(); observedExceptions.AddRange(task.GetExceptionDispatchInfos()); }
    ...
}
```

この乖離は .NET 8 で生じ、非ジェネリック側のパスがアロケーション削減のために書き直された後に [dotnet/runtime#93504](https://github.com/dotnet/runtime/issues/93504) として報告されました。この issue は "not planned" として閉じられており、破壊的変更のドキュメントにも記載されていません。実務上の結論は、`await Task.WhenAll` からどの失敗が表に出るかに依存するコードを決して書かないことです。修正 1 のとおり、リスト全体を読んでください。

## 何かが失敗するとキャンセルは消える

もう 1 つの静かな損失はキャンセルです。あるタスクがキャンセルされ、別のタスクが失敗した場合、キャンセルされたほうは何も寄与しません。

```csharp
// .NET 10.0.5
var mixed = Task.WhenAll(canceledTask, faultingTask);
try { await mixed; } catch (Exception ex) { /* InvalidOperationException */ }

// mixed.Status                          -> Faulted
// mixed.Exception.InnerExceptions.Count -> 1   (the cancellation is gone)
```

どちらの promise 実装も `canceledTask` を別のローカル変数で追跡し、例外リストが空のときだけ `TrySetCanceled` を呼びます。これはドキュメント化されたルール、つまり失敗がキャンセルに優先し、キャンセルが成功に優先するという規則と一致します。何も失敗せず少なくとも 1 つがキャンセルされた場合、`WhenAll` のタスクは `Canceled` で終わり、その `Exception` プロパティは `null` になり、`await` は `TaskCanceledException` をスローします。`Status` を確認せずに `whenAll.Exception!.InnerExceptions` としているコードは、まさにこのケースで `NullReferenceException` になるので、次のようにガードしてください。

```csharp
// .NET 11, C# 14
catch (Exception ex)
{
    if (whenAll.Exception is { } aggregate)
    {
        foreach (var inner in aggregate.InnerExceptions) _logger.LogError(inner, "Step failed");
    }
    else
    {
        _logger.LogWarning(ex, "Batch was canceled");
    }
    throw;
}
```

本物のキャンセルと、キャンセルの姿をしたタイムアウトを見分けるのはそれ自体が別の罠で、[HttpClient が TaskCanceledException をスローする理由](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)で扱っています。

## 落とし穴とバリエーション

- **`AggregateException` を捕捉していて、それが動いている場合。** そのときは `await` していません。`.Wait()`、`.Result`、`Task.WaitAll` はラッパーをそのままスローするので、`catch` に型名が現れるのはそれが理由です。同時にスレッドをブロックしているということでもあり、その影響については [.Result vs .Wait() vs GetAwaiter().GetResult() vs await](/ja/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) を参照してください。

- **ここでは `Flatten()` は何もしません。** `AggregateException.Flatten` は入れ子になった集約のために存在しますが、`Task.WhenAll` はすでに構成要素を展開しているので、`WhenAll` の上にさらに `WhenAll` を重ねてもフラットなリストになります。検証結果は、2 段に入れ子にした 3 件の失敗が `Flatten()` の前後どちらでも内部例外 3 件でした。`Flatten()` は入れ子が実在する `Parallel.ForEach` や PLINQ のために取っておいてください。

- **遅延 LINQ クエリを 2 回列挙すると処理も 2 回走ります。** `Enumerable.Range(0, 3).Select(_ => DoAsync())` はリストではなくクエリです。`Task.WhenAll` はこれを 1 回列挙しますが、同じクエリを 2 つ目の `WhenAll` に渡す (あるいはログ用に `.Count()` に渡す) とすべてが再実行されます。計測結果は、最初の `WhenAll` の後で開始されたタスクが 3 件、2 回目の後で 6 件でした。射影を `WhenAll` に渡す前に `.ToArray()` を呼んでください。

- **`Task.WhenAll` は最初の失敗で止まりません。** 1 つがスローした後も各タスクは最後まで走ります。だからこそ例外が複数出てくるのです。ファンアウトに残りを放棄させたいなら、タスク側が尊重する `CancellationTokenSource` が必要で、その配線は[非同期メソッドを通して CancellationToken を伝播する方法](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)のとおりです。

- **`Task.WhenAll` には同時実行数の上限がありません。** 集約がソケット例外とタイムアウトで埋まっているなら、本当のバグは 5,000 件のリクエストを一度に開始したことかもしれません。同時実行数を制限できる代替手段は [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll](/ja/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/) で比較しています。

- **失敗の通知は遅れて届きます。** `WhenAll` は最も遅いタスクが終わるまで何も教えてくれないので、速い失敗は遅い成功の陰に隠れて見えません。結果が届くたびに反応したい場合、[Task.WhenEach](/ja/2026/01/streaming-tasks-with-net-9-task-wheneach/) が完了順の `IAsyncEnumerable<Task>` を返します。

- **空のコレクションは成功します。** `Task.WhenAll(Array.Empty<Task>())` はそのまま `RanToCompletion` に遷移します。空の入力で成功を報告するバッチジョブは、たいてい上流のフィルタリングのバグであって `WhenAll` のバグではありません。

- **`WhenAll` のタスクを待機すると内部例外はすべて観測されます。** 見えなかった失敗について `TaskScheduler.UnobservedTaskException` が飛んでくることはありません。`WhenAll` がすでに代わりに観測しているからです。便利であると同時に、損失がこれほど静かである理由でもあります。

一行のメンタルモデルはこうです。`Task.WhenAll` はすべての失敗を忠実に集めており、情報を落としているのは `await` の側です。返されたタスクに名前を付ければ、何も失われません。

## 関連記事

- [Parallel.ForEach vs Parallel.ForEachAsync vs Task.WhenAll in C#](/ja/2026/05/parallel-foreach-vs-parallel-foreachasync-vs-task-whenall/)：適切なファンアウトのプリミティブを選び、同時実行数を制限する方法。
- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#](/ja/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)：ブロックすることが生の `AggregateException` を露出させる理由。
- [修正: HttpClient の TaskCanceledException: A task was canceled](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)：失敗した `WhenAll` が飲み込むキャンセルのケース。
- [.NET 9 の Task.WhenEach によるタスクのストリーミング](/ja/2026/01/streaming-tasks-with-net-9-task-wheneach/)：最も遅いタスクを待たずに完了した結果から順に処理する方法。
- [.NET 11 で非同期メソッドを通して CancellationToken を伝播する方法](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)：ファンアウトに残りの処理を放棄させる方法。

## 参考資料

- Microsoft Learn、[Task.WhenAll メソッド](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.whenall) (上で引用した Faulted、Canceled、`RanToCompletion` のルール)。
- Microsoft Learn、[AggregateException クラス](https://learn.microsoft.com/en-us/dotnet/api/system.aggregateexception) (`InnerExceptions`、`Flatten`、`Handle`、および "One or more errors occurred" というメッセージ)。
- Microsoft Learn、[Task の例外処理](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/task-exception-handling) および [TPL における例外処理](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/exception-handling-task-parallel-library)。
- dotnet/runtime、[`Task.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/Task.cs) (`WhenAllPromise` と `WhenAllPromise<T>`、完了順と引数順の違い)。
- dotnet/runtime、[Issue #93504: Awaiting nongeneric Task.WhenAll changes behavior in .NET 8](https://github.com/dotnet/runtime/issues/93504) ("not planned" として閉じられ、未文書化)。
- dotnet/runtime、[Issue #31494: Task.WhenAll inner exceptions are lost](https://github.com/dotnet/runtime/issues/31494) および [Issue #47605: Configure an await to propagate all errors](https://github.com/dotnet/runtime/issues/47605)。
