---
title: "ValueTask<T> とは何か、そしていつ使う価値があるのか"
description: "ValueTask と ValueTask<T> は、同期的に完了する場合に Task をヒープ割り当てせずに非同期メソッドが結果を返せるようにする構造体です。利点は、待機せずに完了することが多いホットパスで割り当てが 1 つ減ることです。代償は厳格な await-once 契約です。この型が実際に何であるか、どう動作するか、そしてその価値を発揮する狭い範囲のケースを解説します。"
pubDate: 2026-06-20
tags:
  - "csharp"
  - "dotnet"
  - "async"
  - "performance"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/06/what-is-valuetask-and-when-is-it-worth-it"
translatedBy: "claude"
translationDate: 2026-06-20
---

`ValueTask` と `ValueTask<T>` は、非同期メソッドが `Task` や `Task<T>` の代わりに返せる値型 (構造体) の awaitable です。その唯一の目的は、非同期メソッドが同期的に完了したときに `Task<T>` が発生させるヒープ割り当てを回避することです。これはキャッシュヒット、バッファ済みの読み取り、メモ化された計算などでよくあるケースです。メソッドが一度も待機せずに終了する場合、`ValueTask<T>` は結果をスタック上にインラインで保持し、何も割り当てません。実際の非同期処理を待たなければならない場合にのみ、`Task` をラップするフォールバックになります。ただしこの節約には契約が伴います。`ValueTask` は正確に一度だけ待機でき、それをブロックしたり、二度待機したり、後で待機するためにフィールドに保存したりしてはなりません。その契約のため、非同期メソッドの既定の戻り値型は依然として `Task` / `Task<T>` です。`ValueTask` はホットパスのためのプロファイラー駆動の最適化であって、より優れた `Task` ではありません。

ここで扱う内容はすべて .NET 11 (SDK `11.0.100`) と C# 14 を対象とし、2026 年 6 月時点で最新ですが、`ValueTask` の契約は .NET Core 2.1 でリリースされて以来安定しているため、その仕組みは 2.1 以降のすべてのバージョンに当てはまります。

## ValueTask が取り除くために存在する割り当て

まず `Task<T>` のコストから始めましょう。`Task<T>` を返す `async` メソッドを書くと、C# コンパイラーはステートマシンを構築し、メソッドが実際に中断するか保留中の操作を返す必要が生じた瞬間に、ヒープ上に `Task<T>` オブジェクトを割り当てます (64 ビットでオブジェクトヘッダーとフィールドで 24 バイト、継続状態を含む前の段階で)。ランタイムはよくある結果のいくつかをキャッシュしています。`Task.FromResult(true)`、`Task.FromResult(false)`、および小さなボックス化された整数はシングルトンのタスクを再利用します。しかし、あなたの `User` のような任意の参照型の場合、`Task<User>` を返す呼び出しはすべて新たな割り当てになります。たとえメソッドが答えをディクショナリの中に持っていて何も待機しなかったとしてもです。

1 秒間に数千回呼ばれるメソッドであれば、その割り当ては目に見えません。しかし、ほぼ常に同期的に完了する本当のホットパス上のメソッドでは、それらの `Task<T>` オブジェクトはガベージコレクターの負荷となり、プロファイラーでは gen-0 のチャーンとして現れます。`ValueTask<T>` はまさにその形のために設計されました。すなわち、*たいてい*はすでに持っている値を返し、*ときどき*だけ非同期に移行しなければならないメソッドです。

これが典型的な動機づけの例で、低速なフォールバックを持つキャッシュです。

```csharp
// .NET 11, C# 14
// Returns Task<User>: allocates a Task<User> even on the cache-hit fast path.
public Task<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return Task.FromResult(user);   // heap allocation on every cache hit

    return LoadFromDbAsync(id);          // genuinely async, allocates anyway
}
```

`Task.FromResult(user)` の行は、キャッシュヒットのたびに `Task<User>` を割り当てます。ヒット率が 99 パーセントでメソッドが数百万回実行される場合、すでにスタック上に持っていた値をラップするために、数百万個の短命なタスクオブジェクトを割り当てていることになります。

## ValueTask<T> が実際には何であるか

`ValueTask<T>` は `readonly struct` で、内部的に次の 3 つのうちのいずれかを保持します。直接の `TResult`、`Task<TResult>`、または `IValueTaskSource<TResult>` (これについては後述します) です。メソッドが同期的に完了すると、構造体は結果を直接保持し、`Task` は一切作成されません。メソッドが実際の処理を待機しなければならない場合、構造体は非同期の仕組みが生成した `Task<T>` をラップします。同じ例を書き直すと次のようになります。

```csharp
// .NET 11, C# 14
// Returns ValueTask<User>: zero allocation on the cache-hit fast path.
public ValueTask<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return new ValueTask<User>(user);     // no allocation, result is inline

    return new ValueTask<User>(LoadFromDbAsync(id)); // wraps the real Task
}
```

キャッシュヒット時には、`new ValueTask<User>(user)` がユーザーを内部に持つ構造体をスタック上に構築します。何もヒープに到達しません。ミス時には、`LoadFromDbAsync` からの `Task<User>` をラップするので、非同期パスのコストは以前とまったく同じです。`async` キーワードを直接使うこともでき、コンパイラーがラップを処理してくれます。

```csharp
// .NET 11, C# 14
// The async keyword builds a state machine that returns a ValueTask<User>.
// Synchronous completion still avoids the Task<User> allocation via a pooled
// state machine box when possible.
public async ValueTask<User> GetUserAsync(int id)
{
    if (_cache.TryGetValue(id, out var user))
        return user;                     // completes synchronously

    return await LoadFromDbAsync(id);    // suspends, goes async
}
```

非ジェネリックの `ValueTask` は、値を返さないメソッド (`async ValueTask DoWorkAsync()`) で同じ理由のために存在し、それさえ問題になるケースでシングルトン的な完了済みの `Task` の割り当てを回避します。

## 契約: 一度だけ待機、決してブロックせず、決して保存しない

`ValueTask` を安価にするものはすべて、同時にそれをより危険なものにもします。そして危険は完全に、*呼び出し側*がそれをどう消費するかにあります。`Task<T>` は耐久性のあるオブジェクトで、好きなだけ何度でも、好きなだけ多くのスレッドから待機でき、フィールドに保存でき、`.Result` でブロックできます。`ValueTask<T>` はそのいずれも保証しません。[公式の ValueTask&lt;TResult&gt; ドキュメント](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)によれば、ルールは次のとおりです。

- **待機は多くても一度だけ。** `ValueTask<T>` は、最初の待機後にリサイクルされるプール化された `IValueTaskSource<T>` をラップしている可能性があります。二度待機すると、今では別の操作に属する結果を観測してしまう恐れがあります。
- **同時に待機しないこと。** 2 つのスレッドが同じ `ValueTask<T>` を待機するのは、同じ理由で未定義の動作です。
- **完了前に `.Result` にアクセスしないこと。** `Task<T>` では `.Result` でブロックするのは単にデッドロックのリスクにすぎませんが、`ValueTask<T>` では、その値タスクがすでに完了していることが分かっている場合を除き、未定義の動作です。
- **後で待機するために保存しないこと。** `ValueTask<T>` をフィールドに代入し、他のコードが実行された後にそれを待機するのは、負荷の下でチームが結果を破壊する最もよくある方法です。

これらのいずれかを行う必要がある場合は、`.AsTask()` を一度呼び出して本物の `Task<T>` を実体化し、それを使ってください。

```csharp
// .NET 11, C# 14
// Need to await twice or fan out? Convert exactly once, then treat as a Task.
ValueTask<User> vt = repo.GetUserAsync(id);
Task<User> task = vt.AsTask();   // materialize the Task once
var a = await task;
var b = await task;              // safe: Task<T> is awaitable repeatedly
```

その `.AsTask()` の呼び出しは、まさに回避しようとしていた `Task<T>` を割り当てます。そしてそれが要点です。呼び出し側が `Task` のセマンティクスを必要とするなら、最初から節約は得られなかったのであり、`ValueTask` は純粋なリスクでしかありませんでした。同じ摩擦はコンビネーターでも現れます。`Task.WhenAll` と `Task.WhenAny` は `Task` を取るので、`ValueTask` を返す API は、ファンアウトするすべての呼び出し側にまず `.AsTask()` を書くことを強制し、項目ごとに割り当てを行って利点を消し去ります。

## 違反を捕捉するアナライザー

契約を目視で取り締まる必要はありません。.NET SDK には **CA2012 ("Use ValueTasks correctly")** が同梱されており、二度の待機、保存された値タスク、直接の `.Result` アクセスをフラグします。.NET 10 以降では既定で提案として有効になっています。誤用でビルドが失敗するように、これを警告に昇格させましょう。

```ini
# .editorconfig - .NET 11 SDK, CA2012 ships in the built-in analyzers
[*.cs]
dotnet_diagnostic.CA2012.severity = warning
```

どこかで `ValueTask` を採用するなら、CA2012 を警告にすることは任意ではありません。これは、全員が Stephen Toub のルールを読んでいるとは限らないチーム全体でこの型を安全に使えるようにするガードレールです。CA2012 を昇格させずに `ValueTask` を返すコードベースは、不注意な二度待機がひとつあれば、並行処理の下でしか現れないハイゼンバグに陥る一歩手前にあります。

## IValueTaskSource<T>: 本当に元が取れるようにするプーリング

`ValueTask<T>` がラップできる 3 つ目のものが `IValueTaskSource<T>` です。これは上級者向けのケースであり、最大の利点をもたらすものでもあります。`IValueTaskSource<T>` を実装する単一の裏付けオブジェクトを、多くの操作にわたって再利用できるので、非同期パスでさえ呼び出しごとに何も割り当てません。ランタイムは `Socket`、`NetworkStream`、および `System.IO.Pipelines` の仕組みで内部的にこれを使用しており、そこでは 1 つの接続が数百万回の読み取りを行い、読み取りごとに `Task` を割り当てる余裕はありません。

手書きで書くことはめったにありません。書く場合には、`ManualResetValueTaskSourceCore<T>` が難しい部分 (継続のスケジューリング、await-once を強制するためのトークンのバージョン管理) を実装してくれるヘルパーです。

```csharp
// .NET 11, C# 14
// A reusable async signal: one backing source serves many awaits over its
// lifetime, allocation-free per operation. ManualResetValueTaskSourceCore
// handles version tokens so a stale await throws instead of silently aliasing.
public sealed class Signaller : IValueTaskSource<int>
{
    private ManualResetValueTaskSourceCore<int> _core;

    public ValueTask<int> WaitAsync() => new(this, _core.Version);

    public void Complete(int value) => _core.SetResult(value);

    public int GetResult(short token) => _core.GetResult(token);
    public ValueTaskSourceStatus GetStatus(short token) => _core.GetStatus(token);
    public void OnCompleted(Action<object?> cont, object? state, short token,
        ValueTaskSourceOnCompletedFlags flags)
        => _core.OnCompleted(cont, state, token, flags);
}
```

これは、`ValueTask` が同期的なファストパスだけでなく*非同期*パスでも確実に `Task` を上回る唯一の状況です。このようにソースをプールしていない場合、メソッドの非同期分岐はいずれにせよ `Task` を割り当て、`ValueTask` が節約してくれたのは同期完了の割り当てだけということになります。

## いつ使う価値があるのか、具体的に

`ValueTask<T>` に手を伸ばすのは、次のすべてが成り立つ場合だけにしてください。

1. **プロファイラーが、このパスで `Task<T>` の割り当てが実際のコストであることを示している。** 「かもしれない」ではなく、メモリトレース上の gen-0 の行として示されているということです。`ValueTask` は測定の後で適用する最適化であり、理由なく `Span<T>` や [Native AOT](/ja/2026/06/what-is-native-aot-and-what-does-it-cost-you/) に手を伸ばさないのとまったく同じです。
2. **同期完了がよくあるケースである。** キャッシュヒット、バッファ済みの読み取り、メモ化された結果です。メソッドがたいてい実際の I/O を待機するなら、ほとんどの呼び出しでいずれにせよ裏付けの `Task` を割り当てることになり、何も得られません。
3. **呼び出し箇所が単純な待機である。** 各消費側で 1 つの `await`、ファンアウトなし、awaitable のキャッシュなし、ブロックなし。呼び出し側が `.AsTask()` を必要とした瞬間に、節約は消えます。
4. **CA2012 を警告に昇格させている。** 将来の貢献者が契約をひそかに破れないようにするためです。

非同期ストリームの仕組みは、`ValueTask` が測定によってではなく既定で正しい唯一の場所です。`IAsyncEnumerator<T>.MoveNextAsync` は `ValueTask<bool>` を返し、`DisposeAsync` は `ValueTask` を返します。これはまさに、列挙子がすべての反復にわたって 1 つの裏付けソースを再利用するからです。ストリームを少しでも扱うなら、[EF Core 11 で IAsyncEnumerable<T> を使う](/ja/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/)がそのパターンを文脈の中で示しており、これらのシグネチャを `Task` に「戻す」べきではありません。

## いつ Task<T> のままにするか

非同期メソッドの圧倒的多数では、`Task` / `Task<T>` を返してください。Stephen Toub の定番の[Understanding the Whys, Whats, and Whens of ValueTask](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)は、それを率直にこう述べています。「既定の選択は依然として `Task` / `Task<TResult>` である」。証拠ではなく反射で `ValueTask` に手を伸ばしている具体的なサインは次のとおりです。

- メソッドがほとんどの呼び出しで実際の I/O を行う。いずれにせよよくあるパスで `Task` を割り当てているので、構造体は何も買わず、注意というコストだけがかかります。
- 呼び出し側が二度待機したり、結果をキャッシュしたり、`Task.WhenAll` でファンアウトしたりする必要がある。`.AsTask()` のたびに割り当てが再導入され、コードが 1 行増えます。
- 取り除くべき割り当てがあったことを確認するために `BenchmarkDotNet` の `[MemoryDiagnoser]` パスを一度も実行していない。数値が横ばいなら、その型は純粋なオーバーヘッドです。
- メソッドが NuGet パッケージの公開 API である。後で `ValueTask` を `Task` に戻すのはバイナリの破壊的変更なので、データなしにそれにコミットしないでください。

すでにコードベースに `ValueTask` があり、データがそれを正当化しない場合、逆向きの変更は安全で機械的な編集です。[ValueTask<T> を Task<T> に戻す移行](/ja/2026/06/migrate-from-valuetask-back-to-task-when-and-why/)が、手書きの `IValueTaskSource<T>` をどう扱うかを含め、チェックリスト全体を案内します。そしてどちらの型を返すにせよ、スレッドプールをブロックしないためのルールは同じです。[デッドロックせずに長時間実行される Task をキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)、および [.NET 11 で ConfigureAwait(false) は重要か](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)という依然として関連する問いを参照してください。

## 一行での判断

`ValueTask<T>` は同期完了パスで `Task<T>` の割り当てを取り除きますが、その代償としてチーム全体が尊重しなければならない await-once 契約が伴います。割り当てが重要であることと同期完了がよくあるケースであることをプロファイラーが証明したときに使い、裏付けソースをプールできるなら `IValueTaskSource<T>` に頼り、CA2012 を警告にし、設計上正しい非同期ストリームではそのまま使い続けてください。それ以外のあらゆる場所では、`Task<T>` を返し、実際に数値を動かす何かに注意の予算を使ってください。

## 出典

- [ValueTask&lt;TResult&gt; Struct -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.valuetask-1)
- [Understanding the Whys, Whats, and Whens of ValueTask -- .NET Blog (Stephen Toub)](https://devblogs.microsoft.com/dotnet/understanding-the-whys-whats-and-whens-of-valuetask/)
- [CA2012: Use ValueTasks correctly -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2012)
- [ManualResetValueTaskSourceCore&lt;TResult&gt; -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.sources.manualresetvaluetasksourcecore-1)
- [ValueTask Restrictions -- Stephen Cleary](https://blog.stephencleary.com/2020/03/valuetask.html)
