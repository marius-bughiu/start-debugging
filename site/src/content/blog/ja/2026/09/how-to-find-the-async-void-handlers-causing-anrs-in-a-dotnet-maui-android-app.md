---
title: ".NET MAUI の Android アプリで ANR を引き起こす async void ハンドラーを見つける方法"
description: "Play Console は ANR 率が 0.47% を超えたと伝え、libcoreclr.so のフレームだらけのネイティブスタックトレースを渡してきます。その役に立たないトレースから、メインスレッドをブロックした async void イベントハンドラーそのものへたどり着く方法を、Looper の printer、状態マシン名を出す SynchronizationContext ラッパー、dsrouter 経由の dotnet-trace で解説します。"
pubDate: 2026-09-07
template: how-to
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "maui"
  - "android"
  - "async"
  - "performance"
  - "how-to"
lang: "ja"
translationOf: "2026/09/how-to-find-the-async-void-handlers-causing-anrs-in-a-dotnet-maui-android-app"
translatedBy: "claude"
translationDate: 2026-09-07
---

短い答え: Google Play が渡してくる ANR のトレースはあなたの C# メソッド名を教えてくれないので、教えてくれる前提で読むのはやめましょう。まず VSTHRD100 でコードベース内のすべての `async void` を列挙し、UI イベントに紐づいているものへ絞り込みます。次に Release ビルドへ 2 つを組み込みます。メインスレッドの各メッセージを計測する `Android.Util.IPrinter` をメインの `Looper` に設定すること、そして投稿された継続からボックス化された非同期状態マシンを読み取る `SynchronizationContext` ラッパーを入れて、ログ行が匿名の Runnable ではなく `MainPage+<OnSyncClicked>d__7` と出るようにすることです。前者は最初の `await` より前の処理を、後者はその後の処理を捕まえます。この 2 つでメソッド名が得られます。

この記事は `net11.0-android` 上の .NET MAUI 11 と .NET 11 (`11.0.100-preview.7`、2026-08-11 リリース、GA は 2026-11-10 予定) を対象としています。ここでは CoreCLR が唯一のモバイルランタイムです。内容は Mono を使う .NET 10 でも動作し、違いが重要な箇所は明記します。

## そもそもなぜ `async void` が ANR レポートに現れるのか

`async void` 自体がスレッドをブロックするわけではありません。ANR を間接的に引き起こす経路が 3 つあり、いずれも同じ場所に行き着きます。

**同期部分は呼び出し元のスレッドで実行されます。** `async` メソッドは開き波かっこの時点では制御を譲りません。まだ完了していない何かに対する `await` に到達するまで、そのまま走り続けます。Android のメインスレッド上のクリックハンドラーでは、その最初の実質的な中断点より前の各行はすべてメインスレッドの処理であり、シグネチャの `async` キーワードはそう見えないようにしてしまいます。

```csharp
// MainPage.xaml.cs, .NET 11, net11.0-android, MAUI 11
private async void OnSyncClicked(object sender, EventArgs e)
{
    using var db = new SqliteConnection(_dbPath);   // opens the file, ~40 ms cold
    var orders = db.Query<Order>(
        "select * from Orders where Status = 0");    // 3-9 s on a 40k-row table
    await RenderAsync(orders);                       // the first real await, far too late
}
```

これが 5 秒続けば Android の入力ディスパッチャーは諦めます。最終行の `await` は何の役にも立っていません。

**呼び出し元が待機する手段を奪うので、誰かがブロックを足します。** `async void` メソッドは待機可能な値を返さないため、2 つ目のコードがその結果を必要とした瞬間に、最も抵抗の少ない道が `.Result` か `.Wait()` になります。継続を自分自身へ戻す `SynchronizationContext` を持つスレッドでは、これは[典型的な非同期デッドロック](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)であり、Android ではデッドロックしたスレッドこそが Android の計測対象です。

```csharp
private async void OnRefreshClicked(object sender, EventArgs e)
{
    // The handler could not be awaited, so this got "fixed" by blocking.
    var settings = _settings.LoadAsync().Result;   // main thread parked, permanently
    await ReloadAsync(settings);
}
```

**再入可能です。** 1 回目が中断している間に 2 回目のタップが 2 度目の呼び出しを始めるのを止めるものはありません。重なった 2 つの実行が同じ `SemaphoreSlim` や同じ `SQLiteConnection` を奪い合い、その競合は素早いダブルタップでしか再現しないメインスレッドの停止として現れます。この構文がどんなときに正当なのかを詳しく知りたい場合は [C# における async void と async Task: それぞれが正しい場面](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)を参照してください。

## Android が実際に測っているもの

正確な予算を知れば、どのハンドラーを調べる価値があるかが分かります。[Android の ANR ドキュメント](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs)によれば次のとおりです。

| トリガー | 制限時間 |
| --- | --- |
| 入力ディスパッチ (タッチ、キー) | 5 秒 |
| `FLAG_RECEIVER_FOREGROUND` 付きの broadcast receiver | Android 13 以前で 10 秒、Android 14 以降で 10-20 秒 |
| バックグラウンド優先度の broadcast receiver | Android 13 以前で 60 秒、Android 14 以降で 60-120 秒 |
| フォアグラウンドサービスの `onCreate` / `onStartCommand` / `onBind` | 20 秒 |
| バックグラウンドサービス | 200 秒 |

MAUI アプリを痛めつけるのは入力ディスパッチであり、ユーザーが目にするのもこれです。定義上、アプリはフォアグラウンドにあり、タッチされていたからです。基準を決めるのは Play です。ユーザー認知 ANR 率はコアバイタルであり、全体で 0.47% という不良動作のしきい値が 28 日間のローリングウィンドウで評価され、これを超えるとすべてのデバイスでアプリが見つけられにくくなります ([Play Console の技術品質要件](https://support.google.com/googleplay/android-developer/answer/17492799))。

## Play が渡してくるトレースでは足りない理由

ANR のレコードを取得してメインスレッドを見てみます。手元にあるデバイスなら次のとおりです。

```sh
# Everything in the device's dropbox, newest last
adb shell dumpsys dropbox --print data_app_anr | tail -300

# Or the full set, which is what you want for a device that has been running a while
adb bugreport anr.zip
unzip -o anr.zip -d anr && ls anr/FS/data/anr/
```

ヘッダーがトリガーを教えてくれます。

```
ANR in com.example.orders (com.example.orders/crc64e1fb321c08285b90.MainActivity)
PID: 14882
Reason: Input dispatching timed out (Waited 5003ms for MotionEvent)
```

一方、メインスレッドのスタックをダンプするのは ART であり、シンボル化できるのは Java のフレームです。あなたのハンドラーは Java のフレームではありません。CoreCLR 上の Android アプリでは次のような形になります。

```
"main" prio=5 tid=1 Native
  #00 pc 00000000000a1b3c  /apex/com.android.runtime/lib64/bionic/libc.so (syscall+28)
  #01 pc 00000000004f21d8  /data/app/.../lib/arm64/libcoreclr.so (???)
  #02 pc 00000000004e0a44  /data/app/.../lib/arm64/libcoreclr.so (???)
  at crc64e1fb321c08285b90.MainActivity.n_onCreate(Native method)
  at android.os.Handler.dispatchMessage(Handler.java:106)
  at android.os.Looper.loop(Looper.java:294)
```

得られる情報はこれだけです。`libcoreclr.so` 内の名前のないネイティブフレーム (.NET 10 でまだ Mono を使っているなら `libmonosgen-2.0.so`) です。無価値ではありません。問題を次の 3 つのいずれかに分類してくれます。

- ランタイムの下で `syscall`、`futex_wait`、`pthread_cond_wait` に留まっているフレーム: メインスレッドは**ブロックされて**います。つまりロック、`.Result`、`.Wait()`、`SemaphoreSlim.Wait()` のいずれかです。
- 上にシステムコールがないまま `libcoreclr.so` 内で回っているフレーム: メインスレッドは**マネージドコードを実行中**です。つまりハンドラー内の CPU バウンドな処理です。
- 最上位が `android.os.MessageQueue.nativePollOnce`: ダンプ取得時点でメインスレッドは**アイドル**でした。ANR は別の場所にあるか、ダンプが遅れて届いたかです。Android はこれを明示的に文書化しており、このシグネチャでハンドラーを追うのは労力の無駄です。

始める前に見分けておきたい 4 つ目の形もあります。コールドスタート直後に `coreclr_initialize` 内で止まっているスタックです。これはあなたのコードではなく、[dotnet/android#10588](https://github.com/dotnet/android/issues/10588) で追跡されている CoreCLR の起動リグレッションです。Mono では 1 秒で起動していた大規模アプリが CoreCLR では約 6 秒かかり、OS の予算を超えてしまいます。これらは vitals では `handleBindApplication` の下に別クラスターとしてまとまります。この形であれば、対処は[MAUI の Android アプリを Mono から CoreCLR へ移行する](/ja/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/)で扱う起動時間の作業であって、ハンドラーの切り分けではありません。

## 5 ステップの切り分け手順

1. **ソリューション内のすべての `async void` 宣言とデリゲートを列挙します。** `Microsoft.VisualStudio.Threading.Analyzers` を追加し、VSTHRD100 (async void メソッド) と VSTHRD101 (async void のデリゲートとラムダ) をビルド警告に設定します。これで候補の全体像が 1 回のビルドで得られ、テキスト検索では見落とす `EventHandler` へ代入された `async` ラムダも含まれます。
2. **メインスレッドで実行され得るかどうかで候補を並べ替えます。** 入力ディスパッチの ANR を起こし得るのは、UI イベント、`Loaded`/`Appearing` のライフサイクルコールバック、`MainThread.BeginInvokeOnMainThread` の本体から到達できるハンドラーだけです。それ以外は正しさの問題であって ANR ではありません。
3. **Release ビルドでメインの `Looper` を計測します。** しきい値を超えたメインスレッドのメッセージが、その所要時間とともにログへ出るようにします。これは同期部分を捕まえます。同期部分は `SynchronizationContext` に一切触れないため、ここで挙げた他のどの手法からも見えません。
4. **メインスレッドの `SynchronizationContext` をラップします。** 再開された遅い継続が、それを所有する非同期状態マシンの名前をログへ出すようにします。所要時間をメソッド名に変えるのがこのステップです。
5. **`dotnet-dsrouter` 経由の `dotnet-trace` で確認します。** メインスレッドのフレームグラフを読み、修正を推測ではなく計測に基づいたものにします。

## ステップ 1 と 2: 静的な洗い出し

```xml
<!-- MyApp.csproj, .NET 11 -->
<ItemGroup>
  <PackageReference Include="Microsoft.VisualStudio.Threading.Analyzers" Version="17.14.15">
    <PrivateAssets>all</PrivateAssets>
  </PackageReference>
</ItemGroup>
```

```ini
# .editorconfig
dotnet_diagnostic.VSTHRD100.severity = warning   # Avoid async void methods
dotnet_diagnostic.VSTHRD101.severity = warning   # Avoid unsupported async delegates
```

そのうえで一覧を出力します。

```sh
dotnet build -c Release -f net11.0-android -warnaserror:none \
  | grep -E 'VSTHRD10[01]' | sort -u
```

ノイズは覚悟してください。VSTHRD100 は正当なイベントハンドラーにも反応します。これは [microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510) で長く続いている不満で、シグネチャが `(object, EventArgs)` のメソッドが `void` でなければならないことを、アナライザーは知りようがありません。抑制して先へ進んではいけません。ステップ 1 の目的は棚卸しであり、ステップ 2 で手作業により、メインスレッドで実行され得るハンドラーへ絞り込みます。中規模の典型的な MAUI アプリなら、60 件の VSTHRD100 のリストが実質 8 件から 10 件の候補にまで縮みます。

vs-threading への依存を追加したくない場合は、AsyncFixer パッケージの `AsyncFixer03` が同じ投げっぱなしの形を報告します。どちらでも構いませんが、両方を動かしてはいけません。すべての指摘を二度切り分けることになります。

## ステップ 3: メインスレッドの各メッセージを計測する

`Looper.setMessageLogging` は各メッセージのディスパッチの開始時と終了時に 1 行ずつ書き出します。タイムスタンプの差を取れば、ハンドラーの同期部分を含めて、メインスレッドの作業単位ごとの正確な所要時間が得られます。

```csharp
// Platforms/Android/MainThreadWatchdog.cs, .NET 11, net11.0-android
using Android.OS;
using Android.Util;

sealed class MainThreadWatchdog(long thresholdMs) : Java.Lang.Object, IPrinter
{
    private long _startedAt;
    private string? _current;

    public void Println(string? message)
    {
        if (string.IsNullOrEmpty(message))
            return;

        // Looper emits ">>>>> Dispatching to <handler> <callback>: <what>"
        // then "<<<<< Finished to <handler> <callback>".
        if (message[0] == '>')
        {
            _current = message;
            _startedAt = SystemClock.UptimeMillis();
            return;
        }

        var elapsed = SystemClock.UptimeMillis() - _startedAt;
        if (elapsed >= thresholdMs)
            Log.Warn("anr-hunt", $"main thread busy {elapsed} ms: {_current}");
        _current = null;
    }
}
```

早い段階で、しかも捨てるつもりのビルドにだけ組み込みます。

```csharp
// Platforms/Android/MainActivity.cs
protected override void OnCreate(Bundle? savedInstanceState)
{
    base.OnCreate(savedInstanceState);
#if ANR_HUNT
    Looper.MainLooper!.SetMessageLogging(new MainThreadWatchdog(thresholdMs: 300));
#endif
}
```

そのうえで実利用の状況を観察します。

```sh
adb logcat -s anr-hunt:W
```

300 ms というしきい値は意図的に厳しめです。入力ディスパッチの ANR には 5000 ms 必要ですが、開発用の端末で 400 ms かかるハンドラーは、ページキャッシュが冷えた 4 年前の端末では数秒かかります。そして vitals の数値はまさにそうした端末から来ています。

これで得られるのは所要時間と Looper のターゲット文字列です。得られないのは C# のメソッド名です。ランタイムが投稿した継続は汎用の `Java.Lang.IRunnable` ラッパーとして届くため、`<callback>` の欄は不透明な `crc64...` 型として読めます。そのためのステップ 4 です。

## ステップ 4: 状態マシンに名前を付ける

`Task` は継続を `SynchronizationContext.Post` 経由で投稿し、Android のメインスレッドではそのコンテキストがメインの `Handler` へマーシャリングします。これをラップすれば、渡す前に投稿された状態を調べられます。

微妙な点は、`SendOrPostCallback` デリゲートがあなたのメソッドではないことです。ランタイムは共有された単一の静的コールバックを使い、本当の継続を `state` として、ボックス化された非同期状態マシンをターゲットに持つ `Action` の形で渡します。このボックスはジェネリック型で、その型引数はあなたのメソッドに対してコンパイラーが生成した構造体であり、その名前には元のメソッド名が含まれています。

```csharp
// Platforms/Android/AnrHuntingSyncContext.cs, .NET 11
using System.Diagnostics;
using Android.Util;

sealed class AnrHuntingSyncContext(SynchronizationContext inner, long thresholdMs)
    : SynchronizationContext
{
    public override void Post(SendOrPostCallback d, object? state)
    {
        var origin = Describe(d, state);
        inner.Post(_ =>
        {
            var sw = Stopwatch.StartNew();
            d(state);
            if (sw.ElapsedMilliseconds >= thresholdMs)
                Log.Warn("anr-hunt", $"continuation {sw.ElapsedMilliseconds} ms: {origin}");
        }, null);
    }

    public override SynchronizationContext CreateCopy() =>
        new AnrHuntingSyncContext(inner.CreateCopy(), thresholdMs);

    // Best effort. Reads the boxed state machine the runtime passes as `state`;
    // this is an implementation detail, so fall back to the delegate's method.
    private static string Describe(SendOrPostCallback d, object? state)
    {
        if (state is Action a && a.Target is { } box)
        {
            var t = box.GetType();
            if (t.IsGenericType)
                // AsyncStateMachineBox`1[MyApp.MainPage+<OnSyncClicked>d__7]
                return t.GetGenericArguments()[0].FullName ?? t.Name;
            return t.FullName ?? t.Name;
        }
        return $"{d.Method.DeclaringType?.FullName}.{d.Method.Name}";
    }
}
```

MAUI が自身のコンテキストを設定した後に、メインスレッドで組み込みます。

```csharp
// Platforms/Android/MainActivity.cs
protected override void OnCreate(Bundle? savedInstanceState)
{
    base.OnCreate(savedInstanceState);
#if ANR_HUNT
    Looper.MainLooper!.SetMessageLogging(new MainThreadWatchdog(300));
    SynchronizationContext.SetSynchronizationContext(
        new AnrHuntingSyncContext(SynchronizationContext.Current!, thresholdMs: 300));
#endif
}
```

探しているログ行はこの形で、これこそがこの作業全体の目的です。

```
W anr-hunt: continuation 4412 ms: MyApp.MainPage+<OnSyncClicked>d__7
```

制約が 3 つあり、いずれも重要です。

- ラッパーを通るのは、その `await` がコンテキストを取得したのがラッパーの設置**より後**である継続だけです。最初のページが構築される前に、`OnCreate` で設置してください。
- `MainThread.BeginInvokeOnMainThread` と MAUI の `IDispatcher` は `SynchronizationContext` ではなく Android の `Handler` へ直接投稿するため、このラッパーを完全に迂回します。ステップ 3 の Looper の printer はそれらも見えるので、両方を動かします。
- [`ConfigureAwait(false)`](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/) で待機するコードはコンテキストをまったく取得せず、その継続はここでは正しく見えません。それが望ましい挙動です。メインスレッドで再開していないからです。

## ステップ 5: `dotnet-trace` で裏を取る

容疑者が決まったら計測します。.NET 11 の CoreCLR では診断コンポーネントがランタイムに組み込まれているため、`EnableDiagnostics` は不要です (Mono を使う .NET 10 では必要で、`libmono-component-diagnostics_tracing.so` がパッケージへ入ります)。

```sh
# .NET 11, dotnet-trace and dotnet-dsrouter 9.0.652701 or newer
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-dsrouter

# Physical Android device. Use 10.0.2.2 instead of 127.0.0.1 on an emulator.
dotnet build -t:Run -c Release -f net11.0-android \
  -p:DiagnosticAddress=127.0.0.1 -p:DiagnosticPort=9000 \
  -p:DiagnosticSuspend=false -p:DiagnosticListenMode=connect

dotnet-trace collect --dsrouter android --format speedscope
```

対象の画面まで進み、ボタンをタップし、Enter で停止して `.speedscope.json` を [speedscope.app](https://speedscope.app/) で開きます。メインスレッドを選び、sandwich ビューに切り替えて self time で並べ替えます。探しているフレームは幅の広い連続したブロックを持つ `MainPage.OnSyncClicked` で、そのすぐ下に実際に時間を消費しているものがあります。

プロファイリングは `Release` ビルドだけで行ってください。Android の Debug ビルドはホットリロードのためインタープリター (`UseInterpreter=true`) で動作し、そこから得られる時間は作り話です。

## 試すべき順に並べた修正

ハンドラーが特定できれば、修正はほぼ次の 4 つのいずれかです。

**ハンドラーを `Task` を返すメソッドの薄い皮にします。** イベントのシグネチャは `void` を強制しますが、本体が長いことを強制するものはありません。

```csharp
// The only line allowed to be async void.
private void OnSyncClicked(object sender, EventArgs e) => _ = SyncAsync();

private async Task SyncAsync()
{
    _syncButton.IsEnabled = false;                    // re-entrancy guard
    try
    {
        var orders = await Task.Run(() => _repo.LoadPendingOrders());
        await RenderAsync(orders);
    }
    catch (Exception ex)
    {
        _logger.LogError(ex, "sync failed");           // an async void body cannot do this
    }
    finally
    {
        _syncButton.IsEnabled = true;
    }
}
```

**同期部分をスレッドプールへ押し出します。** ここで `Task.Run` が正しい道具であるのは、その処理が CPU バウンドまたはブロッキング IO バウンドでありながら、現状 UI スレッドで動いているからです。`Task.Run` はまさにこのために存在します。

**ブロッキング呼び出しを削除します。** ハンドラーに `.Result`、`.Wait()`、`GetAwaiter().GetResult()` があるなら、それが消えるまで上記の計測はどれも意味を持ちません。機械的な進め方は[ブロッキングな .Result/.Wait() 呼び出しを全面的な非同期へ移行する](/ja/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)で扱っています。

**イベントではなくコマンドへバインドします。** MVVM Community Toolkit の `AsyncRelayCommand` はフレームワークが監視する `Task` を返すため、コードから `async void` が完全になくなり、再入防止として `IsRunning` も無料で手に入ります。

## 半日を無駄にする落とし穴

**投げっぱなしの `_ =` による破棄でも例外は飲み込まれます。** 上記の皮が安全なのは `SyncAsync` の内側でログを出しているからです。内側に `try` のない裸の `_ = SomethingAsync()` は `async void` と同じ未観測例外の危険をより静かに抱え、破棄が [CS4014](/ja/2026/07/fix-cs4014-because-this-call-is-not-awaited-execution-continues-in-csharp/) を抑制するのでコンパイラーも警告しません。

**`StrictMode` ではこれを見つけられません。** `DetectAll()` を指定した `StrictMode.ThreadPolicy` はメインスレッドでのディスクアクセスとネットワークアクセスを検出し、隣接するチェックとしては有用ですが、CPU バウンドのマネージド処理と、マネージドなロックでブロックされたスレッドには無力です。どちらも ANR の原因です。

**その ANR クラスターはそもそもハンドラーではないかもしれません。** ここに 1 日を費やす前に、vitals のクラスターの最上位フレームを確認してください。`handleBindApplication` は起動の遅さを意味します。`nativePollOnce` はメインスレッドがアイドルだったことを意味します。ハンドラーを指しているのはビジー状態かブロック状態の形だけです。

**この計測コードはどこにも出荷しないでください。** `Looper` の printer はメッセージごとに文字列を確保し、`SynchronizationContext` ラッパーは投稿された継続ごとに `Stopwatch` とクロージャーを増やします。どちらも Release ビルド上のデバッグセッション中に有効にしておく程度には安く、どちらも本番には受け入れられません。MSBuild で定義した定数 (専用のビルド構成に `<DefineConstants>$(DefineConstants);ANR_HUNT</DefineConstants>`) で囲み、誤って Play ストアへ届かないようにしてください。

**API レベルに注意してください。** broadcast receiver の予算は Android 14 で厳しくなり、余裕をもって 10 秒に収まっていたレシーバーが、CPU 逼迫時には 10-20 秒の枠へ押し込まれることがあります。最近ターゲットを変更したなら、[API レベル 36 で何が変わるか](/ja/2026/09/migrate-a-dotnet-maui-android-app-to-target-android-api-level-36/)と照らし合わせてください。

すべての根底にあるのは、`async void` はバグではないということです。それはバグを見えなくする構文です。呼び出し元が待機できたはずの戻り値を、失敗を伝えたはずの例外経路を、問題を指摘したはずのコンパイラー警告を取り除きます。状態マシンに名前を付けることが、その可視性を取り戻す方法です。

## 関連記事

- [C# における async void と async Task: それぞれが正しい場面](/ja/2026/05/async-void-vs-async-task-in-csharp-when-each-is-correct/)
- [解決: C# で async メソッドに対して .Result や .Wait() を呼ぶとデッドロックする](/ja/2026/07/fix-deadlock-when-calling-result-or-wait-on-an-async-method-in-csharp/)
- [.NET 11 で .NET MAUI の Android アプリを Mono から CoreCLR へ移行する](/ja/2026/09/migrate-a-dotnet-maui-android-app-from-mono-to-coreclr-in-dotnet-11/)
- [.NET 11 における ConfigureAwait(false) とデフォルトの比較: 今でも重要か?](/ja/2026/05/configureawait-false-vs-default-in-dotnet-11/)
- [レガシーな C# コードベースでブロッキングな .Result/.Wait() 呼び出しを全面的な非同期へ移行する](/ja/2026/07/migrate-from-blocking-result-and-wait-calls-to-async-all-the-way-up-in-csharp/)

## 参照元

- [Diagnose and fix ANRs, Android Developers](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs)
- [ANRs, Android のアプリ品質ドキュメント](https://developer.android.com/topic/performance/vitals/anr)
- [Play Console の技術品質要件](https://support.google.com/googleplay/android-developer/answer/17492799)
- [.NET MAUI のパフォーマンスプロファイリング, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/maui/fundamentals/profiling)
- [dotnet-dsrouter のドキュメント, Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dsrouter)
- [Tracing .NET for Android applications, dotnet/android](https://github.com/dotnet/android/blob/main/Documentation/guides/tracing.md)
- [VSTHRD100 と VSTHRD101 のアナライザードキュメント, microsoft/vs-threading](https://github.com/microsoft/vs-threading/blob/main/docfx/analyzers/index.md)
- [イベントハンドラーでの VSTHRD100 の誤検出, microsoft/vs-threading#510](https://github.com/microsoft/vs-threading/issues/510)
- [CoreCLR ANR while running large app, dotnet/android#10588](https://github.com/dotnet/android/issues/10588)
- [バグレポートの取得と読み方, Android Studio のドキュメント](https://developer.android.com/studio/debug/bug-report)
