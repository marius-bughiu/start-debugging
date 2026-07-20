---
title: "解決: C# で async メソッドに対して .Result や .Wait() を呼ぶとデッドロックする"
description: "SynchronizationContext が存在する場合、.Result や .Wait() で async の Task をブロックするとデッドロックします。なぜハングするのか、.NET 11 と C# 14 でどう解決するかを説明します。"
pubDate: 2026-07-20
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
  - "deadlock"
lang: "ja"
translationOf: "2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-20
---

`task.Result`、`task.Wait()`、あるいは `task.GetAwaiter().GetResult()` の呼び出しが永久にハングして例外もスローされない場合、それは sync-over-async のデッドロックです。これは、単一スレッドの `SynchronizationContext` を所有するスレッド（WPF や WinForms の UI スレッド、クラシック ASP.NET のリクエストスレッド）をブロックしている一方で、ブロック対象の async メソッドがその同じスレッドに継続を再開しようとするときに起こります。スレッドはタスクを待って止まり、タスクはスレッドを待って止まります。解決策はブロックをやめることです。呼び出しチェーン全体を最後まで非同期にして、`.Result` ではなく `await` を使います。この記事では .NET 11（`Microsoft.NET.Sdk` 11.0.0、C# 14）でのメカニズムを説明し、正しく見えるが機能しないものも含めて、各解決策を優先順位の高い順に解説します。

## なぜスレッドは自分自身を待つのか

`await` は、人が忘れがちな 2 つのことを行います。中断する前に、現在の `SynchronizationContext` を（`SynchronizationContext.Current` 経由で）キャプチャします。待機したタスクが完了すると、単にどれかのスレッドで再開するのではなく、既定では継続、つまり `await` の後のコードを、そのキャプチャしたコンテキストへポストして戻します。スレッドプールの汎用ワーカースレッドにはコンテキストがないため、継続は空いている任意のプールスレッドで実行され、特別なことは起きません。しかし UI スレッドやクラシック ASP.NET のリクエストでは、コンテキストは単一スレッドです。キューに入れた作業を実行できるスレッドがちょうど 1 つだけあります。

では、その 2 つの事実をブロッキング呼び出しの隣に並べてみます。

1. UI スレッドが `GetDataAsync().Result` を呼びます。これは UI スレッドをブロックして保持します。
2. `GetDataAsync` の内部で、`await SomeIoAsync()` が中断する前に UI の `SynchronizationContext` をキャプチャしました。
3. `SomeIoAsync` が完了します。ランタイムは、メソッドの残りを実行してタスクを完了させるために、`GetDataAsync` の継続を UI コンテキストへポストして戻そうとします。
4. UI コンテキストにはスレッドが 1 つあります。そのスレッドはステップ 1 でブロックされ、タスクの完了を待っています。継続を決して拾いません。
5. タスクは継続が実行されるまで完了できません。継続はスレッドが解放されるまで実行できません。スレッドはタスクが完了するまで解放されません。デッドロックです。

Stephen Cleary は何年も前に [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) でこのパターンを名付けましたが、メカニズムは変わっていません。ランタイムにバグはありません。ブロックしているスレッドを継続が必要とするようなタスクをブロックすることは、正真正銘の循環待ちです。

## ハングする最小の再現

必要なものは 2 つです。単一スレッドの `SynchronizationContext` と、それをキャプチャする `await` の上のブロッキング呼び出しです。WinForms のボタンハンドラーが古典的な再現ですが、UI プロジェクトは不要です。単一スレッドのコンテキストを手で設定して、ハングする様子を見ることができます。

```csharp
// .NET 11, C# 14 -- this deadlocks
using System.Threading;

var context = new SingleThreadedSyncContext();
SynchronizationContext.SetSynchronizationContext(context);

// Block on an async method from the context-owning thread:
string result = GetGreetingAsync().Result;   // hangs forever
Console.WriteLine(result);

static async Task<string> GetGreetingAsync()
{
    // Captures the current (single-threaded) context here:
    await Task.Delay(100);
    // The runtime tries to post THIS line back to the captured context,
    // but that thread is blocked on .Result above.
    return "hello";
}
```

実際の WPF や WinForms アプリでは、`SetSynchronizationContext` を自分で書くことはありません。フレームワークは、イベントハンドラーが実行される前に UI スレッドへ `DispatcherSynchronizationContext`（WPF）または `WindowsFormsSynchronizationContext`（WinForms）を設定するので、`SomethingAsync().Result` を行うハンドラーはどれもこれを即座に再現します。クラシック ASP.NET（ASP.NET Core ではなく System.Web）は、同じ単一スレッドの振る舞いで、リクエストスレッドに `AspNetSynchronizationContext` を設定します。

## 唯一の本当の解決策: 最後まで非同期にする

デッドロックが存在するのはブロックしたからです。ブロックを取り除けば消えます。最も外側の呼び出し元が `.Result` を読む代わりに `await` を使えるようになるまで、`async`/`await` を呼び出しチェーンの上へ伝播させます。

```csharp
// .NET 11, C# 14 -- no block, no deadlock
private async void OnLoadClick(object sender, EventArgs e)
{
    string greeting = await GetGreetingAsync();   // await, not .Result
    label.Text = greeting;
}
```

ここでも `await` は UI コンテキストをキャプチャしますが、UI スレッドをブロックするものは何もありません。ハンドラーは中断し、UI スレッドはメッセージループへ戻って空いたままになり、`GetGreetingAsync` が完了すると、その継続がポストされて戻り、いまはアイドル状態の UI スレッドできれいに実行されます。UI の `SynchronizationContext` はまさにこのためにあります。継続は UI スレッドへ戻って着地するので、マーシャリングなしで `label.Text` に触れることができます。

イベントハンドラーが `async void` を許される唯一の場所であるのは、まさにそれらが呼び出しスタックの最上部にあり、待機してくれる呼び出し元を持たないからです。その下にあるものはすべて `async Task` であるべきです。`async void` がどこで正当でどこがバグなのか分からない場合、その区別は [async void が正しいときと罠になるとき](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) で扱っています。

同じルールはサーバー側にも当てはまります。クラシック ASP.NET MVC のアクション、Razor Page ハンドラー、SignalR ハブメソッド。これらを `async Task` にして、ブロックする代わりに作業を `await` します。ここに部分点はありません。同期パスのどこか 1 か所にある単一の `.Result` は、他のすべての層が非同期であってもデッドロックを再導入し得ます。

## ライブラリ側の解決策: ConfigureAwait(false)

ブロッキング呼び出しが自分の所有していないコードにある場合など、チェーン全体を非同期にできないことがあります。もしあなたがブロックされている async ライブラリの作者であれば、各 `await` にコンテキストをキャプチャしないよう指示することで、自分の側からデッドロックを解除できます。

```csharp
// .NET 11, C# 14 -- library code that stays deadlock-safe under a blocking caller
public async Task<string> GetGreetingAsync()
{
    await Task.Delay(100).ConfigureAwait(false);
    // No captured context, so this continuation runs on a thread pool
    // thread, not the caller's blocked UI/request thread.
    return "hello";
}
```

`ConfigureAwait(false)` は「キャプチャしたコンテキストで再開する必要はない」と言います。継続は代わりにスレッドプールのスレッドで実行され、それはブロックされたスレッドではないので、循環待ちは決して形成されず、タスクは完了できます。共有ライブラリへの指針がすべての await に `.ConfigureAwait(false)` を付けることであるのはこのためで、Microsoft が [ConfigureAwait FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/) で詳しく説明しています。

2 つの注意点により、これは万能薬にはなりません。まず、ブロックされた呼び出しの推移的閉包にあるすべての `await` に適用されて初めて役に立ちます。依存関係の奥深くにある await を 1 つ見落とせばデッドロックは戻ってきます。これがまさに、これが呼び出し箇所に振りかける解決策ではなくライブラリの規律である理由です。次に、自分のアプリケーションコードではそもそもブロックすべきではないので、アプリケーションコードでの `ConfigureAwait(false)` は症状への対処です。いつまだ意味を持つのか、そしてコンパイラのアナライザーがいつそれを促すのかというニュアンスは、[.NET 11 における ConfigureAwait(false) と既定の挙動の比較](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/) にあります。

## 正しく見えるが機能しない解決策

**`.Result` を `.GetAwaiter().GetResult()` に置き換える。** 人々がこれに手を伸ばすのは、例外を `AggregateException` にラップする代わりにアンラップするからです。デッドロックについては何も変わりません。`GetAwaiter().GetResult()` はタスクが完了するまで呼び出し元スレッドをブロックし続け、タスクは継続がブロックの後ろでキューに入っているため依然として完了できません。例外は良くなりますが、ハングは同一です。

**`Wait(TimeSpan)` でタイムアウトを追加する。** `task.Wait(5000)` は永久にハングする代わりに 5 秒後に `false` を返しますが、それは解決策ではなく、より遅い失敗です。操作は依然として完了しておらず、設計上の問題をマジックナンバーで覆い隠しただけです。根底にある継続は依然として止まったままです。

**async メソッドを `Task.Run` でラップしてそれをブロックする。** これは実際にデッドロックを断ち切るので、それゆえに危険です。`Task.Run(() => GetGreetingAsync()).GetAwaiter().GetResult()` は async メソッドをスレッドプールのスレッドで開始します。そこには単一スレッドのコンテキストがないので、その継続はもうブロックされた UI スレッドを狙いません。ハングは消えます。

```csharp
// .NET 11, C# 14 -- avoids the deadlock, but it is a smell, not a solution
string greeting = Task.Run(() => GetGreetingAsync()).GetAwaiter().GetResult();
```

これは機能しますが、いまや別のスレッドをブロックするためにスレッドプールのスレッドを 1 つ消費しており、正当にコンテキストを必要とした継続のために UI コンテキストを失い、その呼び出しは非同期であるべきだったという事実を隠しています。Microsoft はこのオフロードパターンを [非同期メソッドの同期ラッパー](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/synchronous-wrappers-for-asynchronous-methods) で同じ警告とともに文書化しています。これは、真に同期のみのエントリポイントに対する最後の手段として扱い、ブロッキングコードを書き続ける方法としては扱わないでください。

## なぜ ASP.NET Core はここでデッドロックしないのか（そして別の形で噛みつくのか）

クラシック ASP.NET から ASP.NET Core へ移行して、古いデッドロックが消えたなら、理由はこれです。ASP.NET Core には `SynchronizationContext` がありません。リクエスト内で `SynchronizationContext.Current` は `null` なので、`await` は単一スレッドのコンテキストを決してキャプチャせず、継続は常にスレッドプールのスレッドで実行され、上で説明した特定の循環待ちは形成され得ません。これはまた、ASP.NET Core のリクエストハンドラーで `ConfigureAwait(false)` が効果を持たない理由でもあります。オプトアウトすべきコンテキストが存在しないのです。

これは ASP.NET Core でブロックが安全になることを意味しません。決定論的なデッドロックを、スレッドプール枯渇と呼ばれる確率的なものと交換するだけです。`.Result` でブロックする各リクエストは、待つだけで何もしないスレッドプールのスレッドを 1 つ占有します。負荷がかかると、プールは（既定では緩やかな）注入レートが占有されたスレッドを補充できるより速くスレッドを配り出すので、新しいリクエストは実行するスレッドがないままキューに入ります。アプリは最初のリクエストではハングしません。ノートパソコンでは再現できない同時実行数で崩れます。治療法は同一です。ブロックせず、最後まで非同期にします。そのブロックが長い操作を制限するためにあったのなら、代わりにキャンセルで行います。[デッドロックなしで長時間実行の Task をキャンセルする](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) のように、そして [CancellationToken をチェーンに伝播させる](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) ことで、トークンが実際に末端の呼び出しに届くようにします。

## ハングするブロックを狩るためのチェックリスト

何かがハングしてこれを疑う場合、async メソッドではなくブロックを探します。

1. **同期パスで `.Result`、`.Wait(`、`.GetAwaiter().GetResult()` を検索します。** そのうちの 1 つが、コンテキストを所有するスレッド上にあります。それが犯人であって、それがブロックしている無実の `await` ではありません。
2. **単一スレッドのコンテキストが絡んでいることを確認します。** UI スレッド、クラシック ASP.NET のリクエスト、あるいはカスタムコンテキストです。ASP.NET Core、またはコンテキストが設定されていない単純なコンソールアプリにいる場合、症状はハードなハングではなく、枯渇か遅い応答です。
3. **ブロックを `await` に置き換え、囲んでいるメソッドを `async Task` にします。** 非同期にできるエントリポイント（イベントハンドラー、`Main`、コントローラーのアクション）に到達するまで、スタックを上へ繰り返します。
4. **ある層が本当に非同期にできず**、その async ライブラリを所有しているなら、そのライブラリ全体に `ConfigureAwait(false)` を追加します。所有していないなら、`Task.Run` によるオフロードが最後の手段で、上記のコストを伴います。
5. **タイムアウトで「修正」しないでください。** false を返す `Wait(timeout)` は諦めるデッドロックであって、機能する設計ではありません。

一貫した筋道は単純です。async コードは async のままでいたいのです。その継続が必要とするスレッドから async コードをブロックした瞬間に、あなたは手作業で循環待ちを構築したことになります。ブロックをやめれば、デッドロックは存在し得ません。このページのそれ以外はすべて、まだブロックをやめられない場合のための被害対策です。

## Related

- [async void が正しいときと C# で罠になるとき](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [.NET 11 における ConfigureAwait(false) と既定の挙動の比較: まだ意味はあるのか](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [C# でデッドロックなしに長時間実行の Task をキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [.NET 11 で CancellationToken を async メソッド全体に伝播させる方法](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)

## Sources

- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
- [ConfigureAwait FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/) -- .NET Blog
- [ASP.NET Core SynchronizationContext](https://blog.stephencleary.com/2017/03/aspnetcore-synchronization-context.html) -- Stephen Cleary
- [Synchronous wrappers for asynchronous methods](https://learn.microsoft.com/en-us/dotnet/standard/asynchronous-programming-patterns/synchronous-wrappers-for-asynchronous-methods) -- Microsoft Learn
- [CA2007: Do not directly await a Task](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007) -- Microsoft Learn
