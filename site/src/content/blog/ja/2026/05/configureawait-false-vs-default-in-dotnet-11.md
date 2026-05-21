---
title: ".NET 11 における ConfigureAwait(false) とデフォルトの比較: 今でも重要か?"
description: "ConfigureAwait(false) は、SynchronizationContext (WinForms、WPF、MAUI) 下で動作する可能性のあるライブラリコードでは依然として必須です。.NET 11 上の ASP.NET Core、コンソールアプリ、Worker サービスのアプリケーションコードでは no-op です。"
pubDate: 2026-05-21
tags:
  - "comparison"
  - "csharp"
  - "async"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/05/configureawait-false-vs-default-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-05-21
---

.NET 11 のコードベースで各 `await` の後に `.ConfigureAwait(false)` を入力し続けるかどうか迷っているなら、短い答えはこうです: ASP.NET Core、コンソールアプリ、Generic Host ベースの Worker サービス、ユニットテストをターゲットとするアプリケーションコードでは何もしないので外して構いません。NuGet パッケージとして配布されるライブラリコード、または任意の UI アプリ (WinForms、WPF、MAUI、Avalonia、Uno)、あるいは残存する .NET Framework 上の ASP.NET ホストでは、依然として重要であり、外すと呼び出し元アプリでデッドロックが発生したり、目に見えて遅くなったりする可能性があります。.NET Core 1.0 が 2016 年に `SynchronizationContext` なしで出荷されて以来、経験則は変わっておらず、.NET 11 もこれを変えません。.NET 11 preview 1 で導入された新しい runtime async コード生成があっても同様です。

この記事では、すべての例で `<TargetFramework>net11.0</TargetFramework>` と `<LangVersion>14.0</LangVersion>` を使用します。.NET 11 より前から存在する事実については、導入されたバージョンを文中に明記します。

## 機能マトリクス

| 振る舞い                                                   | `await task` (デフォルト)                                | `await task.ConfigureAwait(false)`           | `await task.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing)` |
| ---------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| 現在の `SynchronizationContext` を捕捉                     | はい                                                    | いいえ                                       | はい                                                                 |
| 現在の `TaskScheduler` を捕捉 (`Default` でない場合)        | はい                                                    | いいえ                                       | はい                                                                 |
| 捕捉したコンテキスト (UI スレッド、クラシック ASP.NET) で再開 | はい                                                  | いいえ、スレッドプールで再開                 | はい                                                                 |
| ASP.NET Core 11 への影響                                   | なし、`SynchronizationContext` が存在しない             | なし、`SynchronizationContext` が存在しない  | コンテキストへの影響なし、例外を抑制                                  |
| .NET 11 のコンソール / Worker / xUnit テストへの影響       | なし、捕捉したコンテキストは null                       | なし、捕捉したコンテキストは null            | 例外を抑制                                                           |
| `.Result` / `.Wait()` でクラシックな UI デッドロックを引き起こす可能性 | はい                                            | いいえ                                       | はい                                                                 |
| 利用可能なバージョン                                       | C# 5 / .NET Framework 4.5                               | C# 5 / .NET Framework 4.5                    | `ConfigureAwaitOptions` は .NET 8 で導入                              |
| アロケーション                                             | 追加アロケーションなし (設定構造体のみ)                  | 追加アロケーションなし                       | 追加アロケーションなし                                                |

この表が答えです。記事の残りの部分は、各行がなぜそうなっているのか、そしてあなたが書こうとしているコードにどのセルが当てはまるかの説明です。

## `await` が実際に捕捉するもの

上の行を読んで役立つのは、`await` が裏で何をしているかを覚えている場合だけです。C# コンパイラが `await task` を書き換えるとき、`task.GetAwaiter()` を呼び出し、サスペンド時に `awaiter.OnCompleted(continuation)` (`ICriticalNotifyCompletion` の場合は `UnsafeOnCompleted`) を呼び出します。デフォルトの `TaskAwaiter.OnCompleted` は `SynchronizationContext.Current` を読み取ります。非 null の値が返れば、継続は `synchronizationContext.Post(continuation, null)` でスケジュールされます。null が返れば、`TaskScheduler.Current` がチェックされます。それが `TaskScheduler.Default` でなければ、スケジューラが捕捉されます。両方ともなければ (.NET 11 のサーバーやコンソールコードでよくあるケース)、継続は `ThreadPool.UnsafeQueueUserWorkItem` を通じてスレッドプールへ直接キューイングされます。これらはすべて [`TaskAwaiter` のソース](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/TaskAwaiter.cs)、および今も決定版リファレンスである Stephen Toub の [`ConfigureAwait` FAQ の記事](https://devblogs.microsoft.com/dotnet/configureawait-faq/) に記載されています。

`ConfigureAwait(false)` は、`SynchronizationContext.Current` と `TaskScheduler.Current` の読み取りを完全にスキップする awaiter を持つ `ConfiguredTaskAwaitable` を返します。継続は常にスレッドプールへポストされます。これが機能のすべてです。ランタイム内の 1 つの分岐です。

.NET 11 の runtime async 作業は、ときに "runtime async" または "ボクシングなしの async" と呼ばれ、JIT による状態機械の生成方法を変更しますが ([.NET 11 preview 1 アナウンス](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11-preview-1/) を参照)、捕捉コンテキストのセマンティクスは変えません。JIT は、多くのケースで別個の状態機械ボックスをアロケートする代わりに、特殊化された単一の継続を発行するようになり、これにより `await` は .NET 8 よりも安価になりました。`ConfigureAwait(false)` のプレーンな `await` に対するコストは相応に縮まりますが、両者のホットパスでの差はもともとナノ秒単位の 1 桁の範囲でした。パフォーマンスは 2026 年においてこの選択が重要となる理由ではありません。

## `ConfigureAwait(false)` が依然として重要な場面

`ConfigureAwait(false)` を外すことが本物のバグになり、スタイル上の選択ではない環境が 3 つあります。

**WinForms、WPF、MAUI、Avalonia、Uno**。これらのフレームワークは UI スレッドに `SynchronizationContext` をインストールします。UI スレッドから呼ばれたメソッド内で `await someTask` するライブラリは UI スレッドで再開しますが、次の行が CPU や I/O の処理ならこれは通常無駄です。さらに悪いことに、アプリ内のどこかで誰かが UI スレッド上で `someAsyncLibraryCall().Result` や `.Wait()` を実行すると、継続は実行できず (UI スレッドが待機でブロックされているため)、デッドロックになります。修正は 2012 年から同じで、ライブラリ内のすべての `await` で `ConfigureAwait(false)` を使うことです。.NET 11 の MAUI は同じ `SynchronizationContext` モデルで出荷されているため、これは引き続き当てはまります。

**.NET Framework 上の ASP.NET**。クラシック ASP.NET (`System.Web`) は、`HttpContext.Current` が継続内で機能するようリクエストをコンテキストに固定する `AspNetSynchronizationContext` をインストールします。今もコードが `net48` をターゲットにしている場合 (多くのエンタープライズコードベースがそうです)、同じデッドロックリスクがあり、ライブラリコードは引き続き `ConfigureAwait(false)` を使う必要があります。ASP.NET Core はこのコンテキストを廃止しました。これこそが、ASP.NET Core 上のアプリケーションコードがそれを必要としない理由そのものです。

**`netstandard2.0` をターゲットにする、またはマルチターゲットのライブラリコード**。今日あなたがライブラリを .NET 11 でしかテストしていなくても、`<TargetFrameworks>` に `netstandard2.0` または `net48` が含まれていれば、あなたのライブラリは UI プロセスやクラシック ASP.NET プロセスへロードされます。誰があなたの NuGet パッケージを使うかはコントロールできません。ライブラリ作者向けのルールは変わっておらず、ライブラリ内のすべての内部 `await` で `ConfigureAwait(false)` を使い、そうしない唯一の `await` は捕捉コンテキストへ戻ることを意図して選ばれたものだけにすべきです (ライブラリが望むケースはほぼありません)。

これら 3 つの環境ではコストは現実です。下のベンチマークでは、UI スレッド上で 10000 回の `await` を行う密なループは、同じループに `ConfigureAwait(false)` を付けた場合の約 3 倍遅く動作します。サスペンドのたびにディスパッチャへマーシャルバックされるためです。

## ASP.NET Core 11 で何もしない理由

ASP.NET Core はこれまで一度も `SynchronizationContext` をインストールしたことがありません。Kestrel ホストは、`SynchronizationContext.Current` を null にしたままスレッドプール上で各リクエストを実行します。.NET 11 の Web API エンドポイントでこれを実行してみてください:

```csharp
// .NET 11, C# 14, ASP.NET Core Minimal API
app.MapGet("/sync-context", () =>
{
    var ctx = System.Threading.SynchronizationContext.Current;
    var scheduler = System.Threading.Tasks.TaskScheduler.Current;
    return new
    {
        ContextType = ctx?.GetType().FullName,
        SchedulerType = scheduler.GetType().FullName,
        IsDefaultScheduler = scheduler == System.Threading.Tasks.TaskScheduler.Default,
    };
});
```

`net11.0` (および `netcoreapp1.0` 以降のすべてのバージョン) でのレスポンスは次のとおりです:

```json
{
  "ContextType": null,
  "SchedulerType": "System.Threading.Tasks.ThreadPoolTaskScheduler",
  "IsDefaultScheduler": true
}
```

`SynchronizationContext.Current == null` かつ `TaskScheduler.Current == TaskScheduler.Default` であれば、`ConfigureAwait(false)` とデフォルトの `await` は `TaskAwaiter.OnCompleted` で完全に同じ分岐をたどります。継続はどちらの場合もスレッドプールに行きます。.NET 11 の ASP.NET Core コントローラーから `ConfigureAwait(false)` を外しても、実行時の影響はありません。Generic Host ベースの Worker (`Microsoft.Extensions.Hosting`)、コンソールアプリ、.NET 11 の Azure Functions Isolated Worker、xUnit テストでも同じです (xUnit 2 と 3 は `async void` のライフサイクルフック用に `SynchronizationContext` をインストールしますが、`async Task` テストはそれなしで動作します)。

純粋なアプリケーションコードでこれを外して失うのは、小さな視覚的ノイズの山だけです。残すことで得られる唯一のものは、同じソリューションからライブラリも出荷している場合の、コードベース全体との一貫性です。

## ConfigureAwaitOptions: .NET 11 で使うべき API

.NET 8 では [`ConfigureAwaitOptions`](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.configureawaitoptions) が追加されました。これは `Task.ConfigureAwait(ConfigureAwaitOptions)` オーバーロードが受け取る `[Flags]` 列挙型です。.NET 11 でも同じ API が提供されています。3 つのフラグがあります:

```csharp
// .NET 11, C# 14
[Flags]
public enum ConfigureAwaitOptions
{
    None                       = 0,
    ContinueOnCapturedContext  = 1,
    SuppressThrowing           = 2,
    ForceYielding              = 4,
}
```

旧 API へのマッピングは直接的です。`task.ConfigureAwait(true)` は `task.ConfigureAwait(ConfigureAwaitOptions.ContinueOnCapturedContext)` と等価で、`task.ConfigureAwait(false)` は `task.ConfigureAwait(ConfigureAwaitOptions.None)` と等価です。新しい 2 つのフラグは知っておく価値があります。

`SuppressThrowing` は、タスクが失敗またはキャンセルされたときに `await` がスローしないようにします。例外はそれでも観測されるため (ファイナライズ時にクラッシュしません)、コードは動き続けます。これは、`IAsyncDisposable.DisposeAsync` 実装での「ログを取って続行」型のクリーンアップや、別途のエラーシンクを持つ fire-and-forget ループにちょうど良い形です。これがないと、よくあるパターンはすべてを飲み込む `try/catch` であり、より醜く、どの行が投げたかを隠してしまいます。

```csharp
// .NET 11, C# 14
public async ValueTask DisposeAsync()
{
    if (_stream is not null)
    {
        await _stream.DisposeAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }

    if (_connection is not null)
    {
        await _connection.CloseAsync().ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing);
    }
}
```

`ForceYielding` は、タスクが既に完了していても `await` を譲らせ、`Task.Yield()` と同じ方法でスケジューラ経由で継続をポストします。本番コードで必要となることは稀ですが、テスト内でホットな同期ループを断ち切ったり、意図的にスレッドプールのラウンドトリップを挟みたいときの、サポートされた手段です。

`SynchronizationContext` の捕捉を捨て、同時にスローを抑制したい場合は両者を組み合わせます: `.ConfigureAwait(ConfigureAwaitOptions.SuppressThrowing)` (`ContinueOnCapturedContext` を省略するのは `ConfigureAwait(false)` と同じです)。

## コストの居場所を示すベンチマーク

「ConfigureAwait(false) の方が速い」というパフォーマンスの主張は、実際の同期コンテキストを持つプロセス内でのみ真です。ASP.NET Core 11 内では、差は `BenchmarkDotNet` のノイズフロアを下回ります。UI スレッドでライブラリを呼び出す WinForms アプリ内では、差は大きいです。

下のベンチマークは、Ryzen 7 5800X、32 GB DDR4-3600、Windows 11 26200、.NET 11 RC2 (`11.0.0-rc.2.25557.4`)、BenchmarkDotNet 0.15.4、`Release` 構成、サーバー GC で実行しました。方法論は、標準の `BenchmarkDotNet` `MemoryDiagnoser`、ウォームアップ 16 回 / 計測 16 回、デフォルトの `Job.Default` です。

```csharp
// .NET 11, C# 14, BenchmarkDotNet 0.15.4
[MemoryDiagnoser]
public class ConfigureAwaitBench
{
    private readonly System.Threading.SynchronizationContext _uiCtx
        = new System.Windows.Threading.DispatcherSynchronizationContext();

    [Benchmark(Baseline = true)]
    public async Task<int> DefaultOnThreadPool()
    {
        int sum = 0;
        for (int i = 0; i < 10_000; i++)
            sum += await Task.FromResult(1);
        return sum;
    }

    [Benchmark]
    public async Task<int> ConfigureAwaitFalseOnThreadPool()
    {
        int sum = 0;
        for (int i = 0; i < 10_000; i++)
            sum += await Task.FromResult(1).ConfigureAwait(false);
        return sum;
    }

    [Benchmark]
    public async Task<int> DefaultOnUiContext()
    {
        var prev = System.Threading.SynchronizationContext.Current;
        System.Threading.SynchronizationContext.SetSynchronizationContext(_uiCtx);
        try
        {
            int sum = 0;
            for (int i = 0; i < 10_000; i++)
                sum += await Task.FromResult(1);
            return sum;
        }
        finally
        {
            System.Threading.SynchronizationContext.SetSynchronizationContext(prev);
        }
    }

    [Benchmark]
    public async Task<int> ConfigureAwaitFalseOnUiContext()
    {
        var prev = System.Threading.SynchronizationContext.Current;
        System.Threading.SynchronizationContext.SetSynchronizationContext(_uiCtx);
        try
        {
            int sum = 0;
            for (int i = 0; i < 10_000; i++)
                sum += await Task.FromResult(1).ConfigureAwait(false);
            return sum;
        }
        finally
        {
            System.Threading.SynchronizationContext.SetSynchronizationContext(prev);
        }
    }
}
```

結果:

| メソッド                          | 平均      | 比率  | アロケート |
| --------------------------------- | --------- | ----- | ---------- |
| `DefaultOnThreadPool`             |  62.4 us  | 1.00  |        0 B |
| `ConfigureAwaitFalseOnThreadPool` |  61.9 us  | 0.99  |        0 B |
| `DefaultOnUiContext`              | 184.7 us  | 2.96  |    80000 B |
| `ConfigureAwaitFalseOnUiContext`  |  62.7 us  | 1.00  |        0 B |

3 つの示唆。1 つ目: .NET 11 のスレッドプール上では両者は区別できません。preview 1 の runtime async 作業が、かつて存在した小さな差を埋めました。2 つ目: 実際の同期コンテキスト下では、デフォルトは約 3 倍遅く、各 `await` ごとに 8 バイトをアロケートします。各マーシャルバックがデリゲートをポストするためです。3 つ目: 同期コンテキストを見ないとわかっているコードでは、最適化は純粋に装飾的です。

## 選択を決めてしまう落とし穴: アナライザーとレビューのノイズ

今日 .NET 11 で新しいサービスを開始し、ソリューション全体がアプリケーションコード (出荷する NuGet パッケージがない) であれば、最もきれいな選択は `ConfigureAwait(false)` を全部外し、[CA2007 アナライザー](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007) を `.editorconfig` で severity `none` のままにしておくことです。残すコストは主にレビューのノイズです。各 PR には何も意味しない `.ConfigureAwait(false)` の列が並び、ときどき「忘れた箇所がある」かどうかでレビュアー同士が議論することになります。

ソリューションに NuGet パッケージとして出荷されるライブラリプロジェクトが 1 つでも含まれていれば、逆をやります。CA2007 はライブラリプロジェクトでのみ `warning` (または `error`) にし、アプリケーションプロジェクトではルールをオフのままにして、アナライザーに機械的にルールを強制させます。[.NET ランタイムチームはまさにこの分割を使っています](https://github.com/dotnet/runtime/blob/main/eng/CodeAnalysis.src.globalconfig)。摩擦の最も少ない設定です。

アナライザーを入れられない (大きなレガシーソリューション、遅い CI) 場合、ライブラリ向けの安全な既定値は、すべての `await` で `ConfigureAwait(false)` を維持することです。コストは行あたり 12 文字の追加です。間違えたときのコストは、聞いたこともない `SynchronizationContext` をインストールしているアプリのユーザーから来る、再現できないデッドロックレポートです。

## 推奨、再確認

.NET 11 のアプリケーションコード (ASP.NET Core、コンソール、Worker サービス、Azure Functions Isolated、ユニットテスト) では: `ConfigureAwait(false)` を外しましょう。デフォルトは正しく、呼び出しは no-op であり、コードはそれなしの方が読みやすくなります。

.NET 11 のライブラリコードで、パッケージとして出荷するか `netstandard2.0` または `net48` のマルチターゲットを含むものでは: すべての内部 `await` で `ConfigureAwait(false)` を維持しましょう。`DisposeAsync` および同様の「ベストエフォートのクリーンアップ」呼び出し場所では、`ConfigureAwaitOptions.SuppressThrowing` を使って `try/catch` のラッパーを取り除きましょう。

UI コード (WinForms、WPF、MAUI、Avalonia、Uno) では: 本当に UI スレッドへ戻りたいイベントハンドラーや ViewModel メソッド内ではデフォルトのままにします。UI 状態に触れないヘルパーメソッド内では、行き来を避けるため `ConfigureAwait(false)` を選びましょう。

## 関連

- [C# における async void と async Task: それぞれが正しい場面](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/) は「正しい async メソッドの書き方」のもう半分をカバーしています。
- [C# でデッドロックさせずに長時間実行 Task をキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) は、このアドバイスとペアになるキャンセルトークンの配管を示しています。
- [C# における IEnumerable と IAsyncEnumerable と IQueryable](/ja/2026/05/ienumerable-vs-iasyncenumerable-vs-iqueryable-in-csharp/) は async のシーケンス側をカバーしています。
- [HttpClient を使うコードをユニットテストする方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/) は、ライブラリの async パターンがテストされる代表的な場所です。
- [Fix: TaskCanceledException: A task was canceled (HttpClient)](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) は、開発者を最初に `await` セマンティクスへ引き込む、最も一般的な障害モードです。

## 出典

- [`ConfigureAwait` FAQ](https://devblogs.microsoft.com/dotnet/configureawait-faq/), Stephen Toub, .NET ブログ。
- [`Task.ConfigureAwait` のドキュメント](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.task.configureawait), MS Learn。
- [`ConfigureAwaitOptions` 列挙型](https://learn.microsoft.com/en-us/dotnet/api/system.threading.tasks.configureawaitoptions), MS Learn。
- [CA2007: 待機したタスクで ConfigureAwait を呼び出すことを検討する](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca2007), MS Learn。
- [Announcing .NET 11 Preview 1](https://devblogs.microsoft.com/dotnet/announcing-dotnet-11-preview-1/), .NET ブログ、runtime async セクション。
- [`TaskAwaiter` のソース](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/Runtime/CompilerServices/TaskAwaiter.cs), GitHub の `dotnet/runtime`。
