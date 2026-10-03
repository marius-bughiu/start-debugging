---
title: "非 async メソッドでアロケーションなしに ValueTask を同期的に待機する方法"
description: "まず IsCompleted を確認し、GetAwaiter().GetResult() で結果を読み取れば、コストは 0 バイトです。ValueTask がまだ保留中の場合に限ってブロックし、その際は呼び出しごとに 72 から 208 バイトを割り当てる AsTask() ではなく、キャッシュしたイベントと UnsafeOnCompleted を使います。.NET 10 と .NET 11 RC1 で計測しました。"
pubDate: 2026-10-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "valuetask"
  - "performance"
lang: "ja"
translationOf: "2026/10/how-to-wait-for-a-valuetask-synchronously-without-allocating"
translatedBy: "claude"
translationDate: 2026-10-03
---

同期メソッドからアロケーションなしで `ValueTask<T>` を読み取るには、まず `IsCompleted` を確認します。すでに完了していれば、`vt.GetAwaiter().GetResult()` を 1 回呼ぶだけで終わりです。0 バイト、約 3 ns です。まだ保留中の場合はブロックするしかありません。`vt.AsTask().GetAwaiter().GetResult()` は標準的で安全なフォールバックですが、呼び出しのたびに `Task<T>` ラッパーを割り当てます。短時間スピンしたあと、`UnsafeOnCompleted` 経由でキャッシュした `ManualResetEventSlim` を待機する小さなヘルパーなら、アロケーションゼロでブロックできます。完了していない `ValueTask` に対して `.Result` や `.GetAwaiter().GetResult()` を呼んではいけません。`IValueTaskSource` が裏にあるインスタンスでは未定義の動作となり、実際には `InvalidOperationException` がスローされます。以下の数値はすべて、Apple M4 上の SDK 10.0.302 (.NET 10, C# 14) で計測し、SDK 11.0.100-rc.1.26425.128 (.NET 11 RC1) でも再計測したものです。

## ValueTask のブロックが Task のブロックと異なる理由

`Task<T>` はブロッキングをサポートする参照型です。`Task.Wait()`、`.Result`、`GetAwaiter().GetResult()` はいずれも、しばらくスピンしてから、タスクが完了するまでイベントでスレッドを待機状態にします。未完了の `Task` に対してこれらを呼ぶのは低速で危険ですが (デッドロック、スレッドプールの枯渇)、呼び出し自体の動作は定義されています。待機するのです。

`ValueTask<T>` は構造体で、次の 3 つのうちのいずれかをラップします。単なる `T` の結果、`Task<T>`、あるいは `IValueTaskSource<T>` と `short` のトークンです。ブロッキングを壊すのは 3 番目のケースです。`IValueTaskSource<T>` は `GetStatus`、`OnCompleted`、`GetResult` を公開しますが、`GetResult` が待機しなければならないとはこの契約のどこにも書かれていません。[ValueTask&lt;TResult&gt; のドキュメント](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)には、インスタンスに対して決してやってはいけないことが 4 つ挙げられており、その中に "Using `.Result` or `.GetAwaiter().GetResult()` when the operation hasn't yet completed" があります。そして、そうした場合 "the results are undefined" であると明記されています。Stephen Toub による [ValueTask の設計に関する記事](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)は理由を説明しています。ソースは "need not support blocking until the operation completes, and likely doesn't" というわけです。

実際によく使われるソースは、ブロッキングをサポートしていません。`Socket`、`NetworkStream`、`System.IO.Pipelines`、`System.Threading.Channels` はいずれも、プールされた `IValueTaskSource` オブジェクトを裏に持つ `ValueTask` を返します。また、手書きのソースの多くは `ManualResetValueTaskSourceCore<T>` を使っており、結果を早すぎるタイミングで要求すると例外をスローします。

## 未定義のケースを再現する最小コード

次は、スレッドプール上で完了するプール型のソースです。`Socket` が内部で使っているものと同じ形です。

```csharp
// .NET 10 / .NET 11 RC1, C# 14
using System.Threading.Tasks.Sources;

sealed class PooledSource : IValueTaskSource<int>, IThreadPoolWorkItem
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> StartAsync()
    {
        _core.Reset();
        ThreadPool.UnsafeQueueUserWorkItem(this, preferLocal: false);
        return new ValueTask<int>(this, _core.Version);
    }

    void IThreadPoolWorkItem.Execute() { Thread.SpinWait(50); _core.SetResult(42); }

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> c, object? s, short token,
        ValueTaskSourceOnCompletedFlags f) => _core.OnCompleted(c, s, token, f);
}
```

`Task` をブロックするのと同じ要領でブロックしてみます。

```csharp
// .NET 10 / .NET 11 RC1, C# 14
var src = new PooledSource();
int r = src.StartAsync().GetAwaiter().GetResult();
// System.InvalidOperationException:
//   Operation is not valid due to the current state of the object.
```

どちらの SDK でも、これは即座にスローされます。`ManualResetValueTaskSourceCore<T>.GetResult` は操作が完了しているかどうかを確認し、未完了ならスローするからです。これはまだ親切な結果です。この点を保護していないカスタムソースでは、`default(T)` を返したり、同じプール済みオブジェクトを再利用した前の操作の結果を返したり、自身の状態を壊したりする可能性があります。操作がたまたますぐ終わるため開発中は "動く" コードが、負荷のかかった本番環境では失敗することもあります。これは非ジェネリックの `ValueTask` にも当てはまります。

## ステップ 1: 完了済みの ValueTask を無料で読み取る

`ValueTask` を返す API の多くは、通常は同期的に完了するからこそ存在します。キャッシュヒット、バッファー済みの読み取り、すでに要素が入っているチャネルなどです。そうであれば待つものは何もなく、インスタンスが完了したあとなら `.Result` や `GetAwaiter().GetResult()` を読み取ってよいとドキュメントにも書かれています。`System.Net.Http` の `SocketsHttpHandler` は、`IsCompletedSuccessfully` を使ってまさにこの高速パスを利用しています。

```csharp
// .NET 10 / .NET 11 RC1, C# 14
ValueTask<int> vt = cache.GetAsync(key);

if (vt.IsCompleted)
{
    // Allowed: the operation is finished, and we consume it exactly once.
    int value = vt.GetAwaiter().GetResult();
}
```

同期ヘルパーでは、`IsCompletedSuccessfully` と `.Result` の組み合わせよりも、`IsCompleted` と `GetAwaiter().GetResult()` の組み合わせを優先してください。`IsCompleted` はフォールトまたはキャンセルされたインスタンスでも true になり、`GetAwaiter().GetResult()` は `await` と同じように元の例外を再スローします (`InvalidOperationException` は `InvalidOperationException` のままです)。`IsCompletedSuccessfully` だけを確認すると、フォールトした `ValueTask` は低速パスに落ち、例外を観測するためだけに `Task` でラップされてしまいます。

次の表は、すでに値 42 を保持している `ValueTask<int>` について、高速パスが"まず `AsTask()` を呼ぶ"という一般的な助言に比べて何を節約するかを示します (200,000 回の反復、前後で `GC.GetTotalAllocatedBytes(precise: true)` を測定)。

| アプローチ (完了済みの `ValueTask<int>`) | .NET 10 | .NET 11 RC1 |
| --- | --- | --- |
| `vt.AsTask().GetAwaiter().GetResult()` | 72 B, ~22 ns | 72 B, ~20 ns |
| `vt.IsCompleted` の後に `vt.GetAwaiter().GetResult()` | 0 B, ~3 ns | 0 B, ~3 ns |

値をラップした `ValueTask` に対する `AsTask()` は、`Task.FromResult` を通じて `Task<T>` を作り出す必要があります。ランタイムがキャッシュしているのはごく一部の値 (`true`、`false`、-1 から 8 までの小さな整数) だけです。あなたの `User` オブジェクトや整数 42 では、毎回新しい 72 バイトのタスクが割り当てられます。そもそも待つ必要のなかった値に対して、このアロケーションは何の役にも立ちません。

## ステップ 2: AsTask を使わずに保留中の ValueTask をブロックする

`IsCompleted` が false の場合は、待つしかありません。ドキュメントで示されている安全な選択肢は `vt.AsTask().GetAwaiter().GetResult()` で、[.Result と GetAwaiter().GetResult() の比較](/ja/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)でもまさにこの状況で推奨されています。これは正しい方法ですが、`IValueTaskSource` を裏に持つインスタンスでは、`AsTask()` がソースに自身を登録する専用の `Task<T>` サブクラスを割り当てます。さらに、待機が長引いて `Task` がスピンをやめスレッドを待機状態にする場合は、ブロッキングの仕組みがイベント用にもう 1 つオブジェクトを割り当てます。

awaiter を直接使えば、この両方を避けられます。awaiter の `UnsafeOnCompleted` は、単純な `Action` の継続を基になるソースまたはタスクに登録し、`ExecutionContext` をキャプチャしません。この `Action` がキャッシュ済みの `ManualResetEventSlim.Set` へのキャッシュ済みデリゲートであれば、登録時のアロケーションはゼロです。

```csharp
// .NET 10 / .NET 11 RC1, C# 14
public static class ValueTaskSyncExtensions
{
    [ThreadStatic] private static ManualResetEventSlim? t_event;
    [ThreadStatic] private static Action? t_set;

    public static T WaitSync<T>(this ValueTask<T> task)
    {
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();   // fast path, 0 bytes

        // Short spin: many pending operations finish within microseconds.
        // Polling IsCompleted calls GetStatus, which may be called repeatedly.
        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted)
            return task.GetAwaiter().GetResult();

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);             // no ExecutionContext capture
        mres.Wait();
        return awaiter.GetResult();                 // consume exactly once
    }

    public static void WaitSync(this ValueTask task)
    {
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var spinner = new SpinWait();
        while (!task.IsCompleted && !spinner.NextSpinWillYield)
            spinner.SpinOnce();
        if (task.IsCompleted) { task.GetAwaiter().GetResult(); return; }

        var mres = t_event ??= new ManualResetEventSlim(false, spinCount: 0);
        var set = t_set ??= mres.Set;
        mres.Reset();

        var awaiter = task.ConfigureAwait(false).GetAwaiter();
        awaiter.UnsafeOnCompleted(set);
        mres.Wait();
        awaiter.GetResult();
    }
}
```

これを正しく動作させている要点は次のとおりです。

1. **消費は 1 回だけ。** `ValueTask` は、継続が実行されたあとに `GetResult()` を通じてちょうど 1 回だけ読み取られます。`IsCompleted` のポーリングは消費にはカウントされません。これはソースの `GetStatus` を呼び出すもので、結果を読み取る前なら繰り返し呼んでも構いません。
2. **スレッドごとに 1 つのイベント。** ブロックされたスレッドは同時に 1 つのものしか待てないため、`[ThreadStatic]` のイベントで十分です。そのスレッドがブロックされている間に、同じスレッドで待機がネストすることはありません。キャッシュした `Action` デリゲートもスレッドごとに 1 回だけ作成されます。
3. **`ConfigureAwait(false)`。** これがないと、ソースはキャプチャされた `SynchronizationContext` 上で継続を実行するよう指示されます。UI スレッドではそのコンテキストがいまブロックしているスレッドそのものなので、`Set` が実行されることはありません。`ConfigureAwait(false)` を付ければ、継続はソースが完了した場所で実行されます。
4. **`OnCompleted` ではなく `UnsafeOnCompleted`。** 安全なほうは `ExecutionContext` をキャプチャして復元しますが、イベントを設定するだけのデリゲートにとっては無意味です。
5. **待機状態にする前にスピンする。** `Task` のブロッキングはスリープの前にスピンしますし、このヘルパーもそうすべきです。ベンチマークの最初のバージョンでは、すぐに待機状態にしていました (`spinCount: 0`、スピンループなし)。すると、短い操作では `AsTask()` の約 2 倍遅くなりました。待機のたびにカーネルへの遷移が発生したためです。

## 数値から分かること

同じハーネスで、短い操作は 200,000 回、1 ms のケースは 2,000 回の反復を行い、呼び出しごとのバイト数を全スレッドにわたって計測しました。

| 保留中の `ValueTask<int>` | アプローチ | .NET 10 | .NET 11 RC1 |
| --- | --- | --- | --- |
| `IValueTaskSource`, マイクロ秒で完了 | `AsTask().GetAwaiter().GetResult()` | 80 B | 80 B |
| `IValueTaskSource`, マイクロ秒で完了 | `WaitSync()` | 0 B | 0 B |
| `IValueTaskSource`, 約 1 ms 後に完了 | `AsTask().GetAwaiter().GetResult()` | 144 B | 208 B |
| `IValueTaskSource`, 約 1 ms 後に完了 | `WaitSync()` | 0 B | 0 B |
| `Task` ベース (`Task.Run`) | `AsTask().GetAwaiter().GetResult()` | 72 B | 72 B |
| `Task` ベース (`Task.Run`) | `WaitSync()` | 72 B | 72 B |

ハーネスが `WaitSync()` について報告した小数のバイト数 (呼び出しあたり 0.1 から 0.3 B) は、スレッドプールの内部管理によるもので、呼び出しごとのアロケーションではありません。`Task` ベースの行にある 72 B は、`Task.Run` 自体が作成する `Task<int>` です。`Task` ベースの `ValueTask` では、`AsTask()` はラップされているタスクをそのまま返すだけなので、どちらのアプローチでも追加のアロケーションはありません。

このヘルパーが勝つのはレイテンシではありません。短い操作では、どちらのアプローチも呼び出しあたり 1 から 6 マイクロ秒で、実行ごとのばらつきが両者の差より大きくなりました。1 ms のケースでは、待機が支配的になるため、両者の差は 1% 以内でした。目的がアロケーションではなく速度なら、実際に効果があるのはステップ 1 の高速パスだけで、その次はそもそもブロックしないことです。

したがって正直な要約はこうなります。`IsCompleted` の確認はコストがかからず、同期的に完了するたびに 72 バイトを節約します。`ValueTask` という戻り値の型にふさわしい API であれば、これが一般的なケースです。ブロッキングヘルパーは低速パスでさらに 80 から 208 バイトを節約しますが、それが意味を持つのは低速パス自体がホットパスである場合だけです。

## 注意点とエッジケース

**これは sync-over-async のデッドロックを解決しません。** *あなたの* awaiter に付けた `ConfigureAwait(false)` が制御するのは、*あなたの* 継続がどこで実行されるかだけです。ブロック対象の async メソッドの内部に `ConfigureAwait(false)` のない `await` があり、WPF、WinForms、MAUI、あるいは従来の ASP.NET のスレッドから `WaitSync()` を呼ぶと、その内部の継続はいまブロックしたスレッドにキューされ、`.Result` とまったく同じようにデッドロックします。仕組みと対処法は[非同期メソッドのブロックがデッドロックする理由](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)で解説しています。

**スレッドプールの枯渇も解決しません。** `mres.Wait()` で待機状態になったスレッドプールのスレッドは、そのスレッドを起こすはずの継続を実行するためにプールが使えないスレッドです。アロケーションがゼロであることは、コストがゼロであることを意味しません。これを使うのは、本当に同期である境界 (`Dispose` メソッド、自分では変更できない同期インターフェース、非同期のコアの上に実装した `Stream.Read` のオーバーライドなど) に限り、呼び出しチェーンを async にしなくて済ませる手段としては使わないでください。境界を動かせるなら、[ブロッキング呼び出しを上位まですべて async に移行する](/ja/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)ことが、依然として本当の解決策です。

**`WaitSync()` のあとで ValueTask に再び触れないでください。** `GetResult` が呼ばれた時点で、プールされたソースはすでに別の操作に使われている可能性があります。構造体をコピーしてあとでそのコピーを待機するのは、2 回 await するのと同じバグです。CA2012 ("Use ValueTasks correctly") は明白なパターンを検出しますが、すべてではありません。アナライザーは、このようなヘルパーメソッドを経由する `ValueTask` を追跡できないためです。await は 1 回だけという契約の全体像は、[ValueTask の解説](/ja/2026/06/what-is-valuetask-and-when-is-it-worth-it/)で扱っています。

**`Preserve()` は近道ではありません。** `ValueTask<T>.Preserve()` は複数回消費できるインスタンスを返しますが、保留中の `IValueTaskSource` ベースのインスタンスでは内部で `AsTask()` を呼ぶことで実現しています。そのため、避けようとしていたのと同じラッパーが割り当てられます。

**例外はラップされずに出てきます。** ヘルパーは `GetAwaiter().GetResult()` で終わるため、フォールトした操作は `await` と同様に元の例外の型をスローします。ハーネスでは、`Task.Yield()` のあとで `InvalidOperationException` をスローした `ValueTask<int>` は、`WaitSync()` から `AggregateException` ではなく `InvalidOperationException` として現れました。

**キャンセルは `OperationCanceledException` として現れます。** 操作がキャンセルされた場合、`GetResult` はソースに応じて `TaskCanceledException` または `OperationCanceledException` をスローします。上記のヘルパーにはタイムアウトのオーバーロードがありません。必要な場合は `mres.Wait` にタイムアウトを渡します。そしてタイムアウトした場合は `ValueTask` に再び触れてはいけません。その継続はまだ登録されたままで、あとでスレッド静的なイベントに対して `Set` を呼び出すためです。したがって、そのスレッドで次に待機する前に、`t_event` と `t_set` も新しいインスタンスに置き換える必要があります。

**API の所有者なら、そもそも `ValueTask` であるべきかを検討してください。** 日常的に同期的に消費されるメソッドは、呼び出し側が戻り値の型と戦っているメソッドです。高速パス用に同期版の `TryGet` を用意するか、[ValueTask から Task に戻す移行](/ja/2026/06/migrate-from-valuetask-back-to-task-when-and-why/)で説明されているように `Task<T>` に戻してください。

## 判断の手順

1. `await` できるなら `await` します。この記事の内容はすべて、取り除けない同期の境界のためのものです。
2. `IsCompleted` を確認します。true なら `GetAwaiter().GetResult()` を 1 回だけ呼びます。アロケーションはゼロで、元の例外の型が保たれます。
3. 保留中で、その呼び出しがホットパスでなければ、`AsTask().GetAwaiter().GetResult()` が正しく、地味で、安全です。それを使います。
4. 保留中で、呼び出しあたり 80 から 208 バイトがプロファイラーに現れるほどホットなら、上記の `WaitSync()` ヘルパーを使います。
5. 保留中の `ValueTask` に対して `.Result` や `GetAwaiter().GetResult()` を呼んではいけません。未定義であり、`ManualResetValueTaskSourceCore<T>` ではスローされます。

## 関連記事

- [.Result vs .Wait() vs GetAwaiter().GetResult() vs await in C#](/ja/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/) は、同じ問いを `Task` の側から扱っています。
- [What is ValueTask and when is it worth it](/ja/2026/06/what-is-valuetask-and-when-is-it-worth-it/) は、`IValueTaskSource` のプーリングと await は 1 回だけというルールを説明しています。
- [Migrate from ValueTask back to Task](/ja/2026/06/migrate-from-valuetask-back-to-task-when-and-why/) は、呼び出し側が同期アクセスを必要とし続ける場合の選択肢です。
- [Fix the deadlock when calling .Result or .Wait() on an async method](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) は、UI スレッドでこれらがいずれも安全でない理由を説明しています。

## 参考資料

- [ValueTask&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1), Microsoft Learn (未定義の使い方に関する注記)
- [Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/), Stephen Toub, .NET Blog
- [IValueTaskSource&lt;TResult&gt; Interface](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.ivaluetasksource-1), Microsoft Learn
- [ManualResetValueTaskSourceCore&lt;TResult&gt; Struct](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1), Microsoft Learn
- [CA2012: Use ValueTasks correctly](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012), Microsoft Learn
- [ValueTask.cs in dotnet/runtime](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Threading/Tasks/ValueTask.cs)
