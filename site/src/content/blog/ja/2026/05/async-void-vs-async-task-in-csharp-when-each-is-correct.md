---
title: "C# における async void と async Task: それぞれが正しい場面"
description: "async Task がデフォルトで、async void は例外です。async void は、イベントハンドラー、メッセージループのトップレベルハンドラー、そして void シグネチャを要求する一部のフレームワークコールバックに限って使用してください。それ以外のすべてでは、例外処理、コンポーザビリティ、テスタビリティの観点から async Task が勝ります。"
pubDate: 2026-05-20
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-10"
lang: "ja"
translationOf: "2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct"
translatedBy: "claude"
translationDate: 2026-05-20
---

C# 14 / .NET 10 で書こうとしているメソッドに `async void` と `async Task` のどちらを使うか選んでいる場合、答えは `async Task` です。`async void` を宣言する正当な理由は、`+=` でイベントに接続されているイベントハンドラー、メッセージループのトップレベルハンドラー (WinForms のボタンクリック、WPF の `Loaded` ハンドラー、MAUI のページイベント)、そして外部の契約によってシグネチャが固定されているごく一部のフレームワークコールバック (`ICommand.Execute`、特定のテスト fixture、一部のテストランナー) だけです。自分で呼び出すあらゆるものについては `async Task` が正しい選択です。なぜなら、例外がキャッチ可能になり、呼び出し側が `await` で完了を待てるようになり、メソッドが `Task.WhenAll`、キャンセル、ユニットテストとコンポーザブルになるからです。

この記事はその回答の長いバージョンです。以下のすべては、特に明記しない限り `<TargetFramework>net10.0</TargetFramework>` と `<LangVersion>14.0</LangVersion>` を使用していますが、C# 5.0 で async が追加されて以来、ルールは変わっていません。

## 機能マトリクス

| 機能                                             | `async void`                                                   | `async Task`                                |
| ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------- |
| 呼び出し側が `await` 可能                        | 不可                                                           | 可                                          |
| 呼び出し側が投げられた例外を `catch` 可能        | 不可、`SynchronizationContext` / `AppDomain` に伝播            | 可、返された `Task` に保持される            |
| `Task.WhenAll` / `.WhenAny` とコンポーズ可能     | 不可                                                           | 可                                          |
| 完了 / 結果のテスト可能                          | 不可、即座に戻る                                               | 可、返された `Task` を `await`              |
| `SynchronizationContext.OperationStarted/Completed` を発火 | する                                                | しない                                      |
| ハンドルされない例外で生存                       | デフォルトで .NET Framework 4.5 以降はプロセスをクラッシュ     | しない、観察されるまで例外は `Task` に保持   |
| C# イベントと互換性のあるシグネチャ              | 互換 (`EventHandler` は `void` を返す)                         | 非互換                                      |
| 契約が `void` のインターフェース / 仮想オーバーライドで合法 | 合法                                              | 契約が `Task` を返す場合のみ                |

この表が記事です。以下はすべてその理由です。

## なぜ `async void` は呼び出し側に敵対的なのか

C# コンパイラーは `async` メソッドを `AsyncMethodBuilder` に作業を渡すステートマシンに書き換えます。`async Task` メソッドの場合、ビルダーは [`AsyncTaskMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder) であり、これは `Task` プロパティを公開します。ステートマシンが完了すると、ビルダーはその task に対して `SetResult` または `SetException` を呼び出し、参照を保持しているすべての呼び出し側が結果を観察します。

`async void` の場合、ビルダーは [`AsyncVoidMethodBuilder`](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder) です。返す `Task` がありません。ここから 3 つの具体的な結果が生まれます。

第一に、呼び出しサイトには待機するためのハンドルがありません。`DoStuffAsync();` と書き、`DoStuffAsync` が `void` を返す場合、その行はメソッド内の最初の `await` がサスペンドした時点で完了するのであって、メソッドの作業が終了した時点ではありません。次のステートメントはすぐに実行されます。メソッドが仕事を完了していなくてもです。これが古典的な「読み込んだ時にはデータがもう存在しない」バグの原因です。

第二に、`async void` メソッド内で投げられた例外はどこにも格納されません。`AsyncVoidMethodBuilder.SetException` は、メソッドが開始した時点でカレントだった `SynchronizationContext` にそれらをポストします。WinForms や WPF のプロセスでは、これは UI スレッドのメッセージループを意味し、`Application.ThreadException` (WinForms) または `Application.DispatcherUnhandledException` (WPF) を発生させます。コンソールアプリや ASP.NET Core のバックグラウンドコンテキストでは synchronization context が null なので、例外はスレッドプールにキューイングされ、それを `AppDomain.CurrentDomain.UnhandledException` で公開し、.NET Framework 4.5 と .NET 5+ のすべてのリリース以来、プロセスを終了させます。呼び出しサイトには救えるような `try/catch` はありません。例外が呼び出しサイトを通り抜けることがないからです。

第三に、メソッドは開始時に [`SynchronizationContext.OperationStarted`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted) を、終了時に `OperationCompleted` を呼び出します。ほとんどのコンテキストはこれらの呼び出しを無視します。例外は、`xUnit` や一部のテストフレームワークが使用する `AsyncOperationManager` スタイルのコンテキストです。これらは未処理の非同期作業をカウントし、テストランナーがテストを完了とみなすタイミングを知ります。`async void` メソッドの場合、ランナーは待ちます。通常の呼び出し側にとって、この作業は無駄です。

## 最小再現: キャッチできないクラッシュ

```csharp
// .NET 10, C# 14, console app
using System;
using System.Threading.Tasks;

try
{
    Boom();
    await Task.Delay(100);
}
catch (Exception ex)
{
    Console.WriteLine($"caught: {ex.Message}");
}

static async void Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async void");
}
```

これを実行してください。出力は "caught: from async void" ではありません。未処理の例外のトレースで、プロセスは非ゼロのコードで終了します。上の `catch` ブロックは例外を見ません。なぜなら、例外は `Task.Yield` 後にステートマシンを再開したスレッドプールワーカー上で投げられたのであり、元の呼び出し側のスタック上ではないからです。

キーワードを 1 つ変更します:

```csharp
// .NET 10, C# 14
static async Task Boom()
{
    await Task.Yield();
    throw new InvalidOperationException("from async Task");
}
```

これで呼び出しサイトの `await Boom();` は例外をキャッチし、`await` なしの `Boom();` でもプロセスはクラッシュしません。例外は誰かが観察するか `Task` がファイナライズされるまで未観察の `Task` に乗ったままです (これもデフォルトでは、.NET 4.5 の `<ThrowUnobservedTaskExceptions>` のデフォルトが `false` に切り替わって以来、プロセスをクラッシュさせません)。

## `async void` が正しい場面

`async void` が適切な場面はちょうど 3 つのカテゴリーがあります。その中に厳格にとどまってください。

**CLR イベントに接続されたイベントハンドラー。** `EventHandler` デリゲートは `void` を返します。メソッドを `Task` を返すようにして、なおかつ `+=` でサブスクライブすることはできません。`Button.Click` ハンドラー、`Window.Loaded` ハンドラー、MAUI の `Page.Appearing` ハンドラー、または `void (object?, EventArgs)` の形式のあらゆるシグネチャを書く場合、それは `async void` でなければなりません。フレームワーク (WinForms, WPF, MAUI, Avalonia, Uno) は UI スレッドでイベントを発生させ、synchronization context は未処理の例外を UI スレッドのディスパッチャー未処理例外イベントに戻し、ほとんどのアプリは既にそれをログに記録しています。ハンドラーは薄く保ち、引数の整形が終わったらすぐに `async Task` メソッドに委譲してください:

```csharp
// .NET 10, MAUI, C# 14
private async void OnSaveClicked(object? sender, EventArgs e)
{
    try
    {
        await SaveAsync(_viewModel.Form);
    }
    catch (Exception ex)
    {
        await DisplayAlert("Save failed", ex.Message, "OK");
    }
}

private async Task SaveAsync(FormData form)
{
    using var http = _httpFactory.CreateClient("api");
    var response = await http.PostAsJsonAsync("/forms", form);
    response.EnsureSuccessStatusCode();
}
```

ハンドラーには `try/catch` が必須です。ハンドラーは、ランタイムが例外をクラッシュに変える前に例外を観察できる唯一の場所なので、空のままにしないでください。

**メッセージループのトップレベルコールバック。** 一部のフレームワークは、イベントのように見えるが実際は `void` シグネチャのデリゲートであるフックポイントを公開しています: routed command の `Executed` ハンドラー、`ICommand.Execute(object)` のオーバーライド (インターフェースは `void` を返す)、`BackgroundWorker.DoWork` ハンドラー、`System.Timers.Timer` スタイルのシグネチャを持つ `Timer.Elapsed` ハンドラーなどです。ルールはイベントと同じです: 薄く保ち、`try/catch` でラップしてください。

**契約が固定されているフレームワークコールバック。** xUnit 2 は `IAsyncLifetime.InitializeAsync` と `DisposeAsync` を `Task` として呼びますが、テストランナーの一部の属性スタイルのフックはまだ `void` メソッドを期待し、一部の IoC コンテナーのフック (`Microsoft.Extensions.Hosting` の `IHostedService` は `Task` を返しますが、古い `IApplicationLifetime.ApplicationStarted` コールバックは `void` を返します) もそうです。サードパーティのシグネチャが `void` と言っている場合、選択肢はありません。将来の読者が「修正」しないよう、コメントで文書化してください。

それ以外のすべては `async Task` です。

## `async void` に頼ると失うもの

何かがうまくいかないときに大声で失敗する必要があり、意味のあるものを返さないメソッドで、`await` の儀式を省略するために `async void` に頼った場合、あなたが受け入れたものは:

- **失われたスタックトレース。** synchronization context に現れる例外は元の呼び出しサイトのスタックを失います。再スローされたフレームは見えますが、「これは `OnSaveClicked` から呼ばれました」は見えません。
- **キャンセルなし。** 呼び出し側が待つ `Task` を持たないので、キャンセルを通過させることはできません。`CancellationToken` 引数はメソッド内では機能しますが、呼び出し側は `OperationCanceledException` に反応できません。後ろに伝播することがないからです。
- **`Task.WhenAny` 経由のタイムアウトなし。** 一般的なパターンは `await Task.WhenAny(work, Task.Delay(timeout, ct))` です。これには `Task` が必要です。`async void` には存在しません。
- **完了に対するテストなし。** xUnit, NUnit, MSTest は `async Task` テストメソッドを `await` でき、その結果を観察できます。それらは `async void` テストを `await` できません。一部のフレームワークは `async void` テストメソッドを特別扱いします (古い NUnit、アダプターのクセを持つ MSTest v2)。いずれも推奨はしていません。より詳細なパターンを [HttpClient を使うコードをユニットテストする方法](/2026/04/how-to-unit-test-code-that-uses-httpclient/) で見てください。そこではすべてのテストが `async Task` です。
- **fire-and-crash でもある fire-and-forget。** 多くの「fire-and-forget」パターンは、開発者が `await` を忘れたときに静かに `async void` 呼び出しになります。修正は `async void` ではありません。修正は明示的な `_ = SomeAsync();` ディスカードであり、結果の `Task` が観察されないことを受け入れることです。あるいはより良いのは、それを観察する既知の場所 (ロガー、バックグラウンドキュー) に task を渡すことです。

## ベンチマーク: `async void` は何かを節約するのか?

`async void` の主張がときどき「`Task` のアロケーションがないから安い」というものになります。測ってみましょう。

```csharp
// .NET 10, C# 14, BenchmarkDotNet 0.14.0
// dotnet add package BenchmarkDotNet
using BenchmarkDotNet.Attributes;
using BenchmarkDotNet.Running;

BenchmarkRunner.Run<AsyncShapes>();

[MemoryDiagnoser]
public class AsyncShapes
{
    [Benchmark(Baseline = true)]
    public async Task ReturnsTask()
    {
        await Task.Yield();
    }

    [Benchmark]
    public void ReturnsVoid()
    {
        DoVoid();

        static async void DoVoid() => await Task.Yield();
    }
}
```

メソドロジー: BenchmarkDotNet 0.14.0, .NET 10.0.0 RTM, Windows 11 24H2, AMD Ryzen 9 7900X, 単一スレッド同期ベンチマークハーネス。両メソッドとも 1 回の `Task.Yield` を実行し、これによりスレッドプールでの continuation が強制されます。

| メソッド    | 平均       | アロケート |
| ----------- | ---------- | ---------- |
| ReturnsTask | 1.34 us    | 152 B      |
| ReturnsVoid | 1.29 us    | 136 B      |

`async void` 版は 16 バイト (1 つの `Task` インスタンス) を節約し、約 4% 高速ですが、これはスレッドプールホップの隣では意味がありません。最新のランタイムは非ジェネリックな完了済みタスクに対して `AsyncTaskMethodBuilder.Task` をプールするので、定常状態のアロケーション差はマイクロベンチマークが示すよりさらに小さくなります。`async void` のパフォーマンス上の主張は実体がありません。

## あなたの代わりに決めるくらいの落とし穴

イベントでないメソッドに対して `async void` に惹かれているなら、その場で考えを変えるべき 2 つの事柄があります。

1 つ目はリクエストのライフタイムにまたがる fire-and-forget タスクです。ASP.NET Core はデフォルトで `SynchronizationContext` を提供しないので、`async void` の例外は `ThreadPool.UnobservedExceptionEvent` に上がり、`<ServerGarbageCollection>` の設定によってはワーカープロセスごと落とすことができます。「コントローラーからバックグラウンド作業を起動する」と決めた瞬間、`IHostedService` に切り替えるか、一回限りのものについては、それを観察するもの (`BackgroundService`、`IHostApplicationLifetime` を意識したキュー、[Channels](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)) 経由でフレームワークに `Task` を返してください。

2 つ目はインターフェースです。メソッドをモックできるようにしたい、あるいは契約の一部にしたいなら、何かを返さなければなりません。`Task` は、値を生成しない非同期操作の標準的な戻り値の型です。`void` はモックや fake が `await` できず、そのまわりでテストセットアップを調整できません。[変更追跡を壊さずに DbContext をモックする方法](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) のモックパターンは、同じ理由で `Task` を返すメンバーに依存しています。

## 主張のあるおすすめ、再び

デフォルトは `async Task`。`async void` は上の正確な 3 つのカテゴリーに使ってください: CLR イベントハンドラー、フレームワークによってシグネチャが固定されているメッセージループまたはコマンドスタイルのコールバック、`void` を要求するサードパーティフック。すべての `async void` を `try/catch` でラップし、呼び出しの引数整形ができたらすぐに `async Task` ヘルパーに委譲してください。他の理由で自分で書いたメソッドに `async void` を見たら、潜在的なプロセスクラッシュとして扱い、変更してください。

筋肉記憶に刻む価値のある 2 つの系:

- `I/O` を実行して `try/catch` を忘れた `async void` は、`await` を待っているクラッシュです。ステートマシンには投げられた例外を置く場所が synchronization context 以外になく、最新の .NET のほとんどのコンテキストはそれを致命的として扱います。
- 決して `await` しない `async Task` は `async void` と同じではありません。`Task` は引き続き例外をキャプチャします。観察またはファイナライゼーションまでそこに座っているだけです。ライフタイムに自信があるときのみ `_ = SomeAsync();` を使い、その所有者となるバックグラウンドキューインフラストラクチャに `Task` を渡すことを優先してください。

## 関連

- [C# で長時間実行される Task をデッドロックなしでキャンセルする方法](/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [C# で BlockingCollection の代わりに Channels を使う方法](/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)
- [HttpClient を使うコードをユニットテストする方法](/2026/04/how-to-unit-test-code-that-uses-httpclient/)
- [Fix: TaskCanceledException: A task was canceled in HttpClient](/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/)
- [Fix: InvalidOperationException: Synchronous operations are disallowed in ASP.NET Core](/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)

## ソース

- [非同期戻り値型 -- Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/async-return-types)
- [Stephen Cleary, "Async/Await -- Best Practices in Asynchronous Programming"](https://learn.microsoft.com/en-us/archive/msdn-magazine/2013/march/async-await-best-practices-in-asynchronous-programming)
- [Stephen Cleary, "Async OOP 5: Events"](https://blog.stephencleary.com/2013/02/async-oop-5-events.html)
- [`AsyncVoidMethodBuilder` リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asyncvoidmethodbuilder)
- [`AsyncTaskMethodBuilder` リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.compilerservices.asynctaskmethodbuilder)
- [`SynchronizationContext.OperationStarted` リファレンス](https://learn.microsoft.com/en-us/dotnet/api/system.threading.synchronizationcontext.operationstarted)
