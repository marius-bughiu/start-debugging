---
title: "対処法: C# の CS1998 \"This async method lacks 'await' operators and will run synchronously\""
description: "CS1998 は async メソッドに await がなく同期的に実行されることを意味します。async を外して Task.FromResult を返すか、忘れていた await を追加してください。"
pubDate: 2026-08-05
template: error-page
tags:
  - "errors"
  - "csharp"
  - "csharp-14"
  - "dotnet"
  - "dotnet-10"
  - "async"
lang: "ja"
translationOf: "2026/08/fix-cs1998-this-async-method-lacks-await-operators-and-will-run-synchronously"
translatedBy: "claude"
translationDate: 2026-08-05
---

`CS1998` は、メソッドに `async` 修飾子が付いているのに本体に `await` 式が 1 つもない場合に出ます。その結果メソッド全体が同期的に実行され、非同期の仕組みのコストだけを払って非同期性は何も得られません。修正はほぼ常に、`async` を外して完了済みのタスクを返すことです。つまり `Task.CompletedTask`、`Task.FromResult(value)`、または `ValueTask.FromResult(value)` を使います。本来は何かを待機するはずだったのなら、抜けている `await` を追加してください。`await Task.CompletedTask` で黙らせるのはやめましょう。この警告が指摘しているコストがそのまま残ります。そして、多くの検索結果がまだ追いついていない変更が 1 つあります。.NET 10 SDK 以降、C# コンパイラーは `CS1998` をまったく出力しなくなりました。以下の内容はすべて SDK 10.0.201 (Roslyn 5.3.0) と .NET 10.0.5 で検証しています。

## 警告の全文

```
warning CS1998: This async method lacks 'await' operators and will run synchronously. Consider using the 'await' operator to await non-blocking API calls, or 'await Task.Run(...)' to do CPU-bound work on a background thread.
```

これはエラーではなく警告なので、`.csproj` に `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>` がない限りビルドは成功します。Microsoft は [async と await に関するコンパイラーメッセージのリファレンス](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) で `WRN_AsyncLacksAwaits` として文書化しており、公式のガイダンスは「メソッド本体に少なくとも 1 つの `await` 式を追加するか、`async` 修飾子を外してタスクを直接返す」というものです。

## コンパイラーがこれを指摘する理由

`await` のない `async` メソッドは決して中断しません。本体は同期メソッドとまったく同じように呼び出し元のスレッドで最初から最後まで実行され、そのあとコンパイラーが生成したステートマシンが、すでに `RanToCompletion` 状態のタスクを呼び出し元に渡します。バックグラウンドスレッドに移った処理はなく、重なって進んだ処理もありません。`async` キーワードはメソッドを非同期にしたのではなく、結果と例外の包み方を変えただけです。

その包み方はただではありません。コストは次のとおりで、.NET 10.0.5、x64、Release 構成、200 万回の呼び出しを単純な `Stopwatch` ループで計測し、割り当ては `GC.GetAllocatedBytesForCurrentThread` で取得しました。BenchmarkDotNet の数値ではないので、正確な値ではなく桁感として扱ってください。

| 形 | 1 回あたりのバイト数 | 1 回あたりの ns |
| --- | --- | --- |
| `await` なしの `async Task` | 0 | 12.1 |
| `Task.CompletedTask` | 0 | 2.3 |
| `await` なしの `async Task<string>` | 72 | 27.9 |
| `Task.FromResult("ok")` | 72 | 16.0 |
| `await` なしの `async ValueTask<int>` | 0 | 15.6 |
| `ValueTask.FromResult(42)` | 0 | 3.0 |

目を引く点が 2 つあります。割り当ての列はどのペアでも同じです。同期的に完了する非同期メソッドはステートマシンをボックス化しませんし (中断がなければ構造体はスタックに残ります)、非ジェネリックの `AsyncTaskMethodBuilder` はキャッシュ済みの完了タスクを返すからです。つまり「async は割り当てる」という俗説はここには当てはまりません。実際に払っているのは 1 回の呼び出しあたり 10 から 15 ナノ秒程度の builder の配管処理です。データベースにアクセスするメソッドでは無視できる差ですが、ホットループでは意味のある差になります。これがエラーではなく警告だった理由もそこにあります。

## 最小再現

.NET 9 までのどの SDK でもこの警告を出す最小のコードです。

```csharp
// C# 14, .NET SDK 9.0.x or earlier
public class UserService
{
    private readonly Dictionary<int, User> _cache = new();

    public async Task<User> GetUserAsync(int id)   // CS1998
    {
        return _cache[id];
    }
}
```

実際の現場でいちばん多いのは、最初は正しかったものが劣化した形です。

```csharp
// C# 14
public async Task<Report> BuildReportAsync(int id)
{
    // var rows = await _db.QueryAsync(id);   <- deleted during a refactor
    var rows = _cachedRows[id];
    return new Report(rows);                  // CS1998, and the method is now
}                                             // async for no reason at all
```

最初の版を意図して書く人はいません。2 つ目は絶えず現れます。これこそがこの警告の存在理由でした。スタイル規則ではなく、劣化の検出器だったのです。

## 対処 1: async を外して完了済みタスクを返す

圧倒的多数のケースではこれが正しい修正です。修飾子を外し、`Task` を返すシグネチャはそのまま維持して、値を包みます。

```csharp
// C# 14, .NET 10
public Task<User> GetUserAsync(int id)
{
    return Task.FromResult(_cache[id]);
}

public Task SaveAsync(User user)
{
    _cache[user.Id] = user;
    return Task.CompletedTask;          // the Task equivalent of FromResult
}

public ValueTask<int> CountAsync()
{
    return ValueTask.FromResult(_cache.Count);   // no Task allocation at all
}
```

シグネチャは変わらないので呼び出し側に手を入れる必要はなく、ステートマシンは消えます。メソッドがホットパス上にあり、結果がたいてい同期的に得られるなら、`ValueTask<T>` にすれば `Task<T>` の 72 バイトの割り当ても消えます。トレードオフは [ValueTask とは何か、いつ使う価値があるか](/ja/2026/06/what-is-valuetask-and-when-is-it-worth-it/) で扱っています。

ただし考慮すべき挙動の変化が 1 つあり、この修正が純粋に機械的でない理由でもあります。`async` メソッドでは、本体がスローした例外は捕捉されて返されたタスクに載せられます。`async` を外すと、例外は呼び出し箇所で同期的にスローされ、呼び出し元がタスクを受け取る前に飛びます。これは簡単に確認できます。

```csharp
// C# 14, .NET 10.0.5
static async Task ThrowsFromTaskAsync() => throw new InvalidOperationException("boom");
static Task ThrowsAtCallSiteAsync() => throw new InvalidOperationException("boom");

var t1 = ThrowsFromTaskAsync();   // returns a faulted task, no exception here
await t1;                          // InvalidOperationException surfaces here

var t2 = ThrowsAtCallSiteAsync();  // throws right here, before any await
```

呼び出し元がすぐに待機するコードでは、この違いはほとんど見えません。見えてくるのは、呼び出しをすぐに待機しない場合です。タスクをリストに集めて `Task.WhenAll` に渡す、タスクをフィールドに保持する、`await` だけを囲む `try`/`catch` を書く、といった場面です。値を返す前に例外をスローしうるメソッドなら、例外はタスクの中に留めてください。

```csharp
// C# 14, .NET 10
public Task<Stream> OpenAsync(string path)
{
    try
    {
        return Task.FromResult<Stream>(new FileStream(path, FileMode.Open));
    }
    catch (Exception ex)
    {
        return Task.FromException<Stream>(ex);   // same shape as async would produce
    }
}
```

まさにこのシナリオを Stephen Toub が [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001) で挙げ、`Task.FromResult` への素朴な書き換えはしばしば誤りだと論じています。

## 対処 2: 書くつもりだった await を追加する

リファクタリングのあとに警告が出たのなら、正直な修正はたいてい、待機するはずだった呼び出しを戻すことです。

```csharp
// C# 14, .NET 10
public async Task<Report> BuildReportAsync(int id, CancellationToken ct)
{
    var rows = await _db.QueryAsync(id, ct);
    return new Report(rows);
}
```

同じファイルに [CS4014 "because this call is not awaited"](/ja/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) が並んで出ていないか探してください。await が 1 つもないという警告と、タスクを捨てているという警告が同時に出ているなら、そのメソッドが元から同期的だったのではなく `await` が失われた可能性がほぼ確実です。

## 対処 3: Task.Run と、メッセージ自身の提案が多くの場合に誤りである理由

警告文は CPU バウンドな処理に `await Task.Run(...)` を勧めます。デスクトップクライアントではこの助言は正しく、狙いは UI スレッドから処理を追い出すことです。

```csharp
// C# 14, .NET 10, WPF or MAUI
private async void OnCalculateClicked(object sender, EventArgs e)
{
    var result = await Task.Run(() => CrunchNumbers(_input));   // UI stays responsive
    ResultLabel.Text = result.ToString();
}
```

ASP.NET Core の中では、同じ助言が誤りになります。解放すべき UI スレッドは存在せず、リクエストはすでにスレッドプールのスレッドで動いています。`Task.Run` は処理を別のスレッドプールスレッドに渡すだけで、コンテキストスイッチとタスクの割り当てを追加し、その一方で他のリクエストを捌くためのプールを削ります。サーバーアプリケーションでは、同期メソッドは同期のままにするか、実際の I/O を待機して本当に非同期にすべきです。

## 対処 4: 変更できないインターフェース実装やオーバーライド

この警告がもっともうまく扱えなかったのが、自分の実装には待機するものが何もないのに `Task` を返さなければならないインターフェースのメンバーや仮想メソッドです。

```csharp
// C# 14, .NET 10
public interface INotifier
{
    Task NotifyAsync(string message);
}

public sealed class NullNotifier : INotifier
{
    public Task NotifyAsync(string message) => Task.CompletedTask;   // no async, no warning
}
```

答えはやはり `async` を外すことです。それが本当に不可能な場合は、全体ではなく局所的に抑制してください。

```csharp
// C# 14, .NET SDK 9.0.x or earlier
#pragma warning disable CS1998 // required by INotifier, nothing to await here
public async Task NotifyAsync(string message) { _log.Info(message); }
#pragma warning restore CS1998
```

プロジェクトファイルの `<NoWarn>$(NoWarn);CS1998</NoWarn>` よりも、理由を書いたコメント付きの `#pragma` を選んでください。プロジェクト全体での抑制は、この警告が本当に得意としているリファクタリング劣化のケースも含め、将来の出現をすべて隠してしまいます。

## .NET 10 で警告が消えた理由

警告が出たからではなく、出なくなったからこの記事を読んでいるなら、答えはこうです。コンパイラーから削除されました。マイルストーン 18.0 P2 として 2025-09-19 にマージされた [dotnet/roslyn#80144](https://github.com/dotnet/roslyn/pull/80144) が、`WRN_AsyncLacksAwaits` を C# のコード修正プロバイダー "Remove async modifier" と "Make method synchronous" ごと完全に削除しました。理由は [dotnet/roslyn#77001](https://github.com/dotnet/roslyn/issues/77001) にあります。この警告は人々をより悪いコードへ誘導していました。`Task` を返す契約を満たさざるをえない開発者は、警告を黙らせるために `await Task.FromResult(result)` と書きます。これはステートマシンを残し、await を 1 つ増やし、安全性を上げないままメソッドを確実に高くします。議論を締めくくった判断は明快でした。議論の結果、とりわけ runtime async を踏まえて、この警告は完全に削除するというものです。

削除はビルド 1 回で確認できます。次のプロジェクトは SDK 10.0.201 で警告ゼロでコンパイルされます。

```csharp
// C# 14, .NET SDK 10.0.201 -> 0 warnings
public class C
{
    public async Task Empty() { }
    public async Task<int> Value() { return 42; }
    public async void VoidMethod() { }
    public async IAsyncEnumerable<int> Stream() { yield return 1; }
}
```

どれも診断を出しませんし、`-warnaserror:CS1998` も `.editorconfig` の `dotnet_diagnostic.CS1998.severity = error` も復活させられません。引き上げる対象の診断がもう存在しないからです。同じコンパイラーから `CS4014` は今も出るので、これは `CS1998` に固有の話であり、非同期関連の警告が全般に失われたわけではありません。

この機能は、マイルストーン 18.4 として 2026-01-07 にマージされた [dotnet/roslyn#81835](https://github.com/dotnet/roslyn/pull/81835) で、オプトイン方式の IDE アナライザーとして戻ってきました。インターフェース実装のケースを個別に調整できるよう、診断 ID は意図的に 2 つに分けられています。

- `IDE0390` (`RemoveUnnecessaryAsyncModifier`): 通常のメソッドとラムダ式。
- `IDE0391` (`RemoveUnnecessaryAsyncModifierInterfaceImplementationOrOverride`): インターフェースのメンバーを実装するメソッド、または基底メソッドをオーバーライドするメソッド。

どちらも "Make method synchronous" というタイトルと "Method can be made synchronous" というメッセージで表示され、どちらも既定では有効になっていません。必要な場所で以前の挙動を取り戻すには次のようにします。

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0390.severity = warning
dotnet_diagnostic.IDE0391.severity = suggestion
```

```xml
<!-- .csproj: required to see IDE rules in dotnet build, not just in the IDE -->
<PropertyGroup>
  <EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
</PropertyGroup>
```

検証して分かった注意点が 1 つあります。SDK 10.0.201 にはこの 2 つのアナライザーがまだ含まれていません。上の設定では何も出ませんが、同じように設定した対照ルールの `IDE0161` は正常に報告されるので、仕組み自体は正しく、ルールがその SDK 帯にまだ配布されていないだけです。マイルストーン 18.4 が対象なので、より新しい SDK か Visual Studio 2026 の更新が必要になります。

## 落とし穴とバリエーション

- **CI が失敗し、ローカルビルドは通る。** ビルドエージェントで `global.json` が SDK 9 を固定していると `CS1998` は今も出力され、`TreatWarningsAsErrors` を併用していれば、SDK 10 の開発マシンではきれいに通るコードが赤いビルドになります。もっと風変わりな原因を探す前に、SDK 帯を揃えてください。

- **ReSharper と Rider は今も報告する。** JetBrains の解析は Roslyn とは独立しているため、コンパイラーが出力をやめたあともエディター上の検査は残ります。コンパイラーのスイッチで変わることを期待せず、ReSharper の検査設定でオフにしてください。

- **`await Task.CompletedTask` は最悪の黙らせ方。** 本物の `await` を足して警告を消すので、ステートマシンも builder のコストもそのまま残り、さらに awaiter の往復が乗ります。警告を出したコードより確実に高くつきます。`await Task.FromResult(value)` も同じです。

- **await のない `async void`。** `async void SomeHandler()` から `async` を外すのは純粋な得です。待機するものがなければステートマシンの恩恵はありませんし、失敗が同期コンテキストで再スローされてプロセスを落としかねない [async void の例外挙動](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) からも解放されます。

- **「このメソッドはブロックする」という意味ではない。** `CS1998` が言っているのは `await` がないことであって、本体がブロックすることではありません。`async` の本体で `.Result` や `.Wait()` を呼ぶメソッドは、他に `await` があるときだけ警告が消えますが、問題としてははるかに深刻です。[.Result や .Wait() の呼び出しで起きるデッドロック](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/) を参照してください。

- **非同期イテレーター。** `yield return` があり `await` がない `async IAsyncEnumerable<T>` メソッドは、依然として正当な非同期ストリームであり、ここでは警告の削除はむしろ助かります。そうしたストリームを消費する側は、実際には何も待機しないストリームに対する `await foreach` が並行性をもたらさず、インターフェースを与えるだけである点に注意してください。

警告の削除後も残る考え方はこうです。`async` はコンパイル戦略であって API の契約ではありません。契約は `Task` を返すシグネチャのほうです。待機するものがないなら、契約は保ったまま戦略だけを捨て、スローしうる処理は呼び出し箇所で例外を飛ばすのではなく引き続きタスクを失敗させるように気をつけてください。`CS1998` が怒鳴っていたときも正解はそれでしたし、静かになった今も正解は変わりません。

## 関連記事

- [対処法: C# の CS4014 "Because this call is not awaited, execution of the current method continues"](/ja/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/)：`await` の抜けと一緒に出やすい警告について。
- [C# の async void と async Task：どちらが正しいか](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)：await のない `async void` メソッドを最初に直すべき理由について。
- [ValueTask とは何か、いつ使う価値があるか](/ja/2026/06/what-is-valuetask-and-when-is-it-worth-it/)：`ValueTask.FromResult` が `Task.FromResult` に勝つ同期完了のケースについて。
- [対処法: C# で async メソッドに .Result や .Wait() を呼んだときのデッドロック](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)：「この async メソッドは実は非同期ではない」の本当に危険な変種について。
- [.NET 11 の runtime async が EnablePreviewFeatures フラグを不要に](/ja/2026/07/dotnet-11-runtime-async-no-longer-needs-enablepreviewfeatures/)：コンパイラーチームがこの警告を手放せるようになったランタイム側の変更について。

## 出典

- Microsoft Learn, [Resolve errors and warnings that involve async, await and the task-asynchronous protocol](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/async-await-errors) (`CS1998` の正確な文言と、await を追加するか async を外すという公式ガイダンス)。
- dotnet/roslyn, [PR #80144: Remove CS1998 warning entirely and remove dependent C# code fix providers](https://github.com/dotnet/roslyn/pull/80144) (2025-09-19 マージ、マイルストーン 18.0 P2)。
- dotnet/roslyn, [Issue #77001: Consider not emitting CS1998 for interface implementations / method overrides](https://github.com/dotnet/roslyn/issues/77001) (`await Task.FromResult` というアンチパターンと、警告を削除する判断)。
- dotnet/roslyn, [PR #81835: Add back async fixers](https://github.com/dotnet/roslyn/pull/81835) (オプトインの `IDE0390` と `IDE0391` アナライザー、2026-01-07 マージ、マイルストーン 18.4)。
- dotnet/roslyn, [Issue #82692: Warnings (at least CS1998) are not showing with SDK 10 compared to SDK 9](https://github.com/dotnet/roslyn/issues/82692) (この挙動変更がターゲットフレームワークではなく SDK に伴うものだという確認)。
- Microsoft Learn, [Task.FromException method](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.fromexception) (`async` メソッドなしで失敗タスクを作る方法)。
