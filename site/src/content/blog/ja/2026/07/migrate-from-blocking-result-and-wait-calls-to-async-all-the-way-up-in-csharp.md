---
title: "レガシーな C# コードベースでブロッキングな .Result/.Wait() 呼び出しを全面的な非同期へ移行する"
description: "既存の .NET コードベースから sync-over-async を取り除くための段階的な手順書です。アナライザーで棚卸しし、ThreadPool の枯渇を計測し、呼び出しチェーンを 1 本ずつ変換して、.NET 11 で件数をゼロまで削り込みます。"
pubDate: 2026-07-25
template: migration
tags:
  - "migration"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "async"
lang: "ja"
translationOf: "2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp"
translatedBy: "claude"
translationDate: 2026-07-25
---

実際のコードベースから sync-over-async を取り除く作業は、検索と置換では終わりません。数十万行規模のサービスなら 1 スプリントから 3 スプリントを見込み、作業は 1 本の巨大な PR ではなく、一連の垂直スライスの形になると考えてください。壊れるのは主にシグネチャです。ブロックをやめたメソッドはすべて `Task` を返す必要があり、それがインターフェース、コンストラクター、`Dispose`、`lock` ブロック、そして公開 API の表面まで上へ波及します。負荷時に ThreadPool の枯渇が見えている場合や、UI スレッドで深刻なデッドロックが起きている場合には取り組む価値があります。逆に、ブロッキング呼び出しが 1 回実行して終了するコマンドラインツールの中にある場合は後回しにしてかまいません。本稿は .NET 11 (`Microsoft.NET.Sdk` 11.0.0、C# 14) を対象にしています。紹介するツールはすべて .NET 6 以降で動作しますが、ランタイムのトレース手順だけは .NET 9 以降が必要です。

## ブロッキング呼び出しを取り除くべき理由

- **ThreadPool の枯渇が消えます。** リクエスト経路にある `.Result` は 1 つごとにプールのスレッドを止めます。Microsoft 自身の [ThreadPool 枯渇のチュートリアル](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-threadpool-starvation)では、同じエンドポイントを 125 並列接続で計測して、ブロックしている状態では平均レイテンシ 3.48 秒、呼び出しを待機するように変えた後は 532 ミリ秒という結果が出ています。これはチューニングの差ではなく、別のアプリケーションです。
- **深刻なデッドロックが起こりにくくなるのではなく、起こり得なくなります。** WPF、WinForms、従来の ASP.NET のスレッドでは、継続がそのスレッドを必要とするタスクをブロックして待つことは循環待機そのものです。その仕組みは[非同期メソッドをブロックするとデッドロックする理由](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)で解説しています。ブロックをなくせば、このバグの分類自体が消えます。
- **スレッド数とともにメモリが減ります。** ブロックを補うために 130 スレッドで安定しているプールは、130 個のスタックを保持しています。非同期化すると、通常はコア数の小さな倍数まで戻ります。
- **キャンセルが機能し始めます。** ブロックされたスレッドは `CancellationToken` を観測できません。チェーンが非同期になれば、タイムアウトやクライアントの切断が実際に伝播します。

## 非同期化で壊れるもの

| 領域                            | 変更内容                                                                                              | 深刻度 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------ | ------ |
| 公開 API の表面                 | `T Get()` が `Task<T> GetAsync()` になり、利用側にとってソースおよびバイナリの破壊的変更になります        | 高     |
| 自分の管理下にないインターフェース| サードパーティやフレームワークのインターフェースのメソッドに `Task` の戻り値型は与えられません             | 高     |
| コンストラクター、プロパティのゲッター| どちらも `async` にできないため、処理はファクトリメソッドか遅延初期化子へ移します                       | 高     |
| `lock` ステートメント           | `lock` の中の `await` はコンパイルエラー `CS1996` になり、`SemaphoreSlim` が必要です                      | 中     |
| 例外処理                        | `AggregateException` が現れなくなるため、`catch (AggregateException)` が黙って一致しなくなります           | 中     |
| `TransactionScope`              | `TransactionScopeAsyncFlowOption.Enabled` を指定して生成しない限り `await` をまたいで流れません            | 中     |
| `IDisposable`                   | `Dispose` での非同期クリーンアップには `IAsyncDisposable` と `await using` が必要です                     | 中     |
| テストスイート                  | 非同期になったコードを呼ぶ同期テストメソッドは `async Task` になります                                     | 低     |

深刻度が高い行が作業順序を決めます。それ以外は機械的な作業です。

## 事前チェックリスト

- ソリューションが .NET 6 以降でクリーンにビルドできること。ここで .NET 11 が必須になる箇所はありませんが、ランタイムのトレース手順は `WaitHandleWait` イベントのために .NET 9 以降が必要です。
- `Microsoft.VisualStudio.Threading.Analyzers` をすべてのプロジェクト、少なくともホットパス上のプロジェクトに追加すること。同期メソッドの中のブロッキング呼び出しを見つけられるのはこのパッケージであり、.NET 組み込みのアナライザーはそれをしません。
- `dotnet-counters`、`dotnet-trace`、`dotnet-stack` をグローバルツールとして導入すること。
- 症状を再現できる負荷テスト。これがないと、移行が効いたことも、悪化させていないことも証明できません。
- 小さな PR を数多く出せるブランチ戦略。ソリューション中のシグネチャをすべて変える 400 ファイルの PR はレビューされません。

## 移行手順

1. **棚卸しは grep ではなくアナライザーで行います。**

   `grep -r "\.Result"` は Result という名前のあらゆるプロパティアクセスを拾い、同期 I/O は完全に見落とします。このパターンを本当に理解している 2 つのルールを有効にしてください。

   ```ini
   # .editorconfig -- .NET 11 SDK 11.0.0
   [*.cs]
   # Avoid problematic synchronous waits (.Result, .Wait(), GetAwaiter().GetResult())
   dotnet_diagnostic.VSTHRD002.severity = warning
   # Call async methods when in an async method
   dotnet_diagnostic.VSTHRD103.severity = warning
   # Built-in equivalent; off by default through .NET 10
   dotnet_diagnostic.CA1849.severity = warning
   ```

   レガシーなコードベースではこの違いが効いてきます。[CA1849](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1849) は `Task` を返すメソッドの内側でしか発火しないため、まだ何も非同期になっていないコードではほとんど何も報告しません。`VSTHRD002` はブロッキング呼び出しがどこにあっても発火し、これこそが数えたい母集団です。

   **確認**: ソリューションをビルドし、出力中の `VSTHRD002` の行数を数えます。その数値を保存してください。それがバーンダウンチャートになります。

2. **1 行も変更する前に、負荷をかけたベースラインを取ります。**

   負荷テストを実行し、プールを観察します。

   ```bash
   dotnet-counters monitor -n YourApp System.Runtime
   ```

   .NET 9 以降で読むべきカウンターは `dotnet.thread_pool.thread.count`、`dotnet.thread_pool.queue.length`、`dotnet.thread_pool.work_item.count` です。枯渇のサインは、CPU 使用率が 100% を大きく下回ったままスレッド数がじりじり増えていくことです。プロセッサー数のおよそ 3 倍を超えた値で安定している場合は、コードがプールのスレッドをブロックしており、ランタイムがスレッドを増やして補っていることを意味します。

   **確認**: 安定したスレッド数、p95 レイテンシ、1 秒あたりのリクエスト数を記録します。検証手順でこれらと比較します。

3. **ソースコード解析では見えないブロッキング呼び出しを見つけます。**

   アナライザーは `File.ReadAllText` や `SqlCommand.ExecuteReader`、ソースを持っていない依存関係の奥に埋もれた `SemaphoreSlim.Wait()` を指摘できません。.NET 9 はまさにこのために `WaitHandleWait` イベントを追加しました。

   ```bash
   dotnet trace collect -n YourApp --clrevents waithandle --clreventlevel verbose --duration 00:00:30
   ```

   生成された `.nettrace` ファイルを PerfView かコミュニティ製の .NET Events Viewer で開き、`WaitHandleWaitStart` のスタックを展開します。底部のフレームに `ThreadPoolWorkQueue.Dispatch` や `WorkerThread.WorkerThreadStart` が現れるスタックは、ブロックされているプールのスレッドであり、待機の 1 つ上のフレームがあなたのメソッドを指しています。

   **確認**: トレース中のすべてのスタックが、手順 1 の棚卸しにすでにある呼び出し箇所と対応しているか、棚卸しに追加されるかのどちらかになります。

4. **ファイル単位ではなく、呼び出しチェーンを端から端まで変換します。**

   手順 3 で最もホットだった単一のエントリポイントを選びます。リーフ (実際に `HttpClient` や EF Core を呼ぶメソッド) から始めて非同期版の双子を用意し、呼び出し元を 1 段ずつ変換しながらスタックを上っていき、自分自身に呼び出し元を持たずに `await` できるメソッドに到達するまで続けます。コントローラーのアクション、`BackgroundService.ExecuteAsync`、イベントハンドラー、`Main` などがそれにあたります。

   ```csharp
   // .NET 11, C# 14 -- before: the block is three frames below the controller
   public IActionResult GetOrder(int id)
   {
       var order = _repository.Get(id);          // sync wrapper
       return Ok(order);
   }

   // after: no wrapper, no block, Task all the way to the framework
   public async Task<IActionResult> GetOrderAsync(int id, CancellationToken ct)
   {
       var order = await _repository.GetAsync(id, ct);
       return Ok(order);
   }
   ```

   この経路では、中途半端な変換は何もしないより悪い結果になります。同期区間のどこかに `.Result` が 1 つ残っているだけで、デッドロックも止まったスレッドも復活します。スライスはエントリポイントに到達して初めて完了です。

   **確認**: そのエンドポイントだけを対象に手順 3 のトレースをやり直します。そのスタックについて、プールのスレッド上の `WaitHandleWait` イベントがゼロになります。

5. **同期版の双子は残さずに削除します。**

   誘惑される近道は、`Get()` を `GetAsync().GetAwaiter().GetResult()` として残し、ほかを何も変えなくて済むようにすることです。それは Stephen Toub が [Should I expose synchronous wrappers for asynchronous methods?](https://devblogs.microsoft.com/dotnet/should-i-expose-synchronous-wrappers-for-asynchronous-methods/) で否定している同期ラッパーであり、移行の途中では積極的に有害です。ラッパーは残ったブロッキング呼び出しの隠れ場所になり、呼び出し元がこの作業を永久に回避できるようにしてしまいます。

   同期の利用側と非同期の利用側が本当に両方あり、どちらも捨てられない場合は、ラッパーではなく BCL が使っているフラグ引数のパターンを使ってください。

   ```csharp
   // .NET 11, C# 14 -- one implementation, two entry points, no sync-over-async
   public int Read(byte[] buffer) => ReadCoreAsync(buffer, sync: true).GetAwaiter().GetResult();
   public Task<int> ReadAsync(byte[] buffer) => ReadCoreAsync(buffer, sync: false);

   private async Task<int> ReadCoreAsync(byte[] buffer, bool sync)
   {
       // Every I/O call inside branches on `sync`, so the synchronous path
       // never awaits an incomplete task and cannot deadlock.
       return sync ? _stream.Read(buffer) : await _stream.ReadAsync(buffer);
   }
   ```

   **確認**: 同期のエントリポイントは未完了のタスクを待つことがないため、`WaitHandleWait` のトレースに現れなくなります。

6. **本当に非同期にできない継ぎ目を処理します。**

   どの移行でも 3 種類が出てきます。コンストラクターは `async` にできないため、初期化は静的ファクトリ (`public static async Task<Foo> CreateAsync()`) か、呼び出し元が待機する `Lazy<Task<T>>` フィールドへ移します。非同期のクリーンアップを行う `Dispose` は `IAsyncDisposable` を実装し、[await using](/ja/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) で消費すべきです。新たな非同期処理を含む `lock` ブロックは `CS1996` でコンパイルに失敗します。モニターは取得したのと同じスレッドで解放しなければならないからです。

   ```csharp
   // .NET 11, C# 14 -- lock cannot span an await; SemaphoreSlim can
   private readonly SemaphoreSlim _gate = new(1, 1);

   public async Task<Config> LoadAsync(CancellationToken ct)
   {
       await _gate.WaitAsync(ct);
       try { return _cached ??= await FetchAsync(ct); }
       finally { _gate.Release(); }
   }
   ```

   **確認**: プロジェクトが `CS1996` なしでコンパイルでき、イベントハンドラー以外に新しい `async void` がないことを確かめます。

7. **シグネチャを開いているうちに CancellationToken を通します。**

   どのみち変更するシグネチャに `CancellationToken ct = default` を足すコストはゼロですが、後から後付けするのは苦痛です。[CancellationToken を非同期メソッド越しに伝播させる](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)のルールに従い、最も外側だけでなくチェーン内のすべての非同期呼び出しに渡してください。

   **確認**: 処理の途中でリクエストをキャンセル (クライアント接続を切断) し、データベース呼び出しが最後まで走り切るのではなく実際に中断されることを確かめます。

8. **件数が減る方向にしか動かないよう、アナライザーをラチェットで固定します。**

   プロジェクトがゼロに到達したら固定します。

   ```xml
   <!-- Directory.Build.props -- .NET 11 SDK 11.0.0 -->
   <PropertyGroup>
     <TreatWarningsAsErrors>false</TreatWarningsAsErrors>
     <WarningsAsErrors>$(WarningsAsErrors);VSTHRD002;CA1849</WarningsAsErrors>
   </PropertyGroup>
   ```

   まだ移行の途中にあるプロジェクトでは、ルールを `warning` のままにして、あらゆる警告ではなく件数の増加で CI を落とします。古い負債を減らしながら新しい負債だけを止めるラチェットが、チームが実際に維持できる唯一の形です。

   **確認**: 変換済みのプロジェクトにわざと `.Result` を入れて、ビルドが失敗することを確かめます。

## 移行が本当に効いたかを検証する

シグネチャがコンパイルできることは証拠になりません。手順 2 と同じ負荷テストを実行し、4 つの数値を比較します。

- **ThreadPool のスレッド数**は数百まで上昇するのではなく、コア数の小さな倍数付近で安定するはずです。
- **負荷時の p95 レイテンシ**は単発リクエストのレイテンシに近づくはずです。枯渇チュートリアルのエンドポイントは 3.48 秒から、無負荷時のおよそ 500 ミリ秒まで戻りました。
- **スループット**は上がるはずで、同じスレッドがはるかに多くのリクエストを捌けるようになるため、しばしば桁違いに向上します。
- **プールのスレッド上の `WaitHandleWait` イベント**は、変換済みの経路ではほぼゼロになるはずです。

その後で機能面の確認を行います。`dotnet test` が 1 件も失敗しないこと、クライアントの切断で下流の呼び出しが中断されることを示すキャンセルのテスト、そして触れたコード内の `catch (AggregateException)` ブロックの手動レビューです。ブロッキング呼び出しがなくなった後は、それらはもう何にも一致しません。

## ロールバックの方針

スライス単位であれば、この移行はきれいに戻せます。垂直スライスはそれぞれ自己完結した PR であり、revert すればブロッキング呼び出しとそのシグネチャが復元されます。これがレイヤーではなく呼び出しチェーンで切るべき主な理由です。

きれいに戻せないのは公開済みのライブラリです。`T Get()` を `Task<T> GetAsync()` に変えることは、旧アセンブリに対してコンパイルしたすべての利用側にとってバイナリ破壊的変更です。したがって NuGet パッケージにとってはメジャーバージョンの移行であり、取り消しは `git revert` ではなく新しいリリースになります。パッケージが 1 つのメジャーバージョンのあいだ両方の API 表面を提供するのか (その場合は手順 5 のフラグ引数パターンを使い、同期ラッパーは決して使いません)、それとも一度に破壊するのかを、着手前に決めてください。

## 時間を取られた落とし穴

**`async void` はラムダ経由で戻ってきます。** `Action` 型のパラメーターに渡したラムダは `async void` になるため、その中の例外はタスクに現れずプロセスを落とします。`List<T>.ForEach(async x => ...)` と、非同期の本体を渡した `Parallel.ForEach` がよくある媒介です。デリゲートのケースは `VSTHRD101` が検出します。正当な使い方と壊れた使い方の境界は[async void が正しいときと罠になるとき](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)にまとめています。

**`.Select(async x => ...)` が返すのは `IEnumerable<Task>` であって結果ではありません。** コンパイルは通り、変換済みに見え、誰も待機しません。後ろに `await Task.WhenAll(...)` を付けるか、列挙自体を [IAsyncEnumerable](/ja/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) に切り替えてください。

**`TransactionScope` は黙って流れなくなります。** 既定のコンストラクターはアンビエントトランザクションを `await` をまたいで流さないため、最初の await 以降のコードはエラーひとつ出さずにトランザクションの外で実行されます。`TransactionScopeAsyncFlowOption.Enabled` を指定して生成してください。

**ASP.NET Core は移行が終わる前に例外を投げます。** 外側の層を変換すると、`AllowSynchronousIO` の既定値が false であるために、さらに下層の同期的な `Stream.Read` から `InvalidOperationException: Synchronous operations are disallowed` が表に出てくることがあります。この例外は残作業の地図であって、スイッチを戻す理由ではありません。詳細は [synchronous operations are disallowed を解決する](/ja/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)にあります。

**`ValueTask` をブロックするのは遅いだけでなく未定義動作です。** 変換したリーフが `ValueTask<T>` を返し、上流の呼び出し元がまだブロックしている場合、そこでの `.Result` はデッドロックのリスクという以前に未定義動作です。呼び出し元の変換が終わるまでは、その境界で `.AsTask()` を使って変換し、[ValueTask のコスト](/ja/2026/06/what-is-valuetask-and-when-is-it-worth-it/)にある制約を読んでください。

**`ConfigureAwait(false)` を作業完了の代替にしないでください。** 自分が所有するライブラリの内側でデッドロックを無力化はしますが、止まったスレッドについては何もしませんし、ASP.NET Core にはそもそも降りるべきコンテキストがありません。これは変更できないコードのための緩和策であって、移行の戦略ではありません。

成功の尺度はアナライザーの件数がゼロになったことではありません。負荷をかけてもプールのスレッド数が増え続けなくなったこと、そしてキャンセルしたリクエストが実際に何かをキャンセルするようになったことです。

## 関連記事

- [Fix: C# で非同期メソッドに .Result や .Wait() を呼んでデッドロックする](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [C# における .Result vs .Wait() vs GetAwaiter().GetResult() vs await](/ja/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)
- [.NET 11 で CancellationToken を非同期メソッド越しに伝播させる方法](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [C# で async void が正しいときと罠になるとき](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [C# における lock vs Monitor vs SemaphoreSlim vs System.Threading.Lock](/ja/2026/05/lock-vs-monitor-vs-semaphoreslim-vs-system-threading-lock-in-csharp/)

## 参考資料

- [Debug ThreadPool starvation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/debug-threadpool-starvation) -- Microsoft Learn
- [CA1849: Call async methods when in an async method](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/quality-rules/ca1849) -- Microsoft Learn
- [VSTHRD002: Avoid problematic synchronous waits](https://microsoft.github.io/vs-threading/analyzers/VSTHRD002.html) -- Microsoft.VisualStudio.Threading
- [Should I expose synchronous wrappers for asynchronous methods?](https://devblogs.microsoft.com/dotnet/should-i-expose-synchronous-wrappers-for-asynchronous-methods/) -- Stephen Toub
- [CS1996: Cannot await in the body of a lock statement](https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/compiler-messages/cs1996) -- Microsoft Learn
- [Don't Block on Async Code](https://blog.stephencleary.com/2012/07/dont-block-on-async-code.html) -- Stephen Cleary
