---
title: ".NET 11 の Process.Run と Process.Start: どちらを使うべきか"
description: "ツールを起動して終了の仕方だけが気になるなら Process.Run を使います。1 回の呼び出しで済み、タイムアウトで子プロセスを強制終了し、シグナルを含む ProcessExitStatus を返します。stdin への書き込み、出力を届いたそばから読む処理、UseShellExecute、プロセスツリー全体の強制終了など、Process オブジェクトが必要な場合は Process.Start を使い続けます。"
pubDate: 2026-09-17
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
lang: "ja"
translationOf: "2026/09/process-run-vs-process-start-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-17
---

**プロセスを起動して終了まで待ち、どう終了したかだけを知りたい場合は、常に `Process.Run` (または `Process.RunAsync`) を使います。** 1 回の呼び出しで済み、`Process` ハンドルをリークすることがなく、タイムアウトや `CancellationToken` は実際に子プロセスを強制終了し、子プロセスが正常終了したのか、シグナルで強制終了されたのか、自分で強制終了したのかがわかる `ProcessExitStatus` を返します。**生きた `Process` オブジェクトが必要な場合は `Process.Start` を使い続けます**: stdin への書き込み、プロセスの実行中に出力を 1 行ずつ読む処理、URL やドキュメントを開くための `UseShellExecute`、`Exited` イベント、自前のワーカーを起動するツールに対する `Kill(entireProcessTree: true)` などです。パフォーマンスは判断材料になりません。.NET 11 RC 1 ではどちらも 1 回の起動あたり約 740 マイクロ秒でした。以下の内容はすべて、Apple M4 搭載の macOS 26.6 上で .NET 11 RC 1 (SDK `11.0.100-rc.1.26425.128`、ランタイム `11.0.0-rc.1.26425.128`、C# 15) を使って検証しています。

## 2 つの API の比較

| 動作 (.NET 11 RC 1)                       | `Process.Run` / `RunAsync`                          | `Process.Start` + `WaitForExit`                  |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------ |
| 利用可能なバージョン                      | .NET 11 以降                                        | すべての .NET バージョン                         |
| 戻り値                                    | `ProcessExitStatus`                                 | `Process` (破棄が必要)                           |
| 既定の stdin/stdout/stderr                | 親から継承 (`silent: true` の場合は null)           | 親から継承                                       |
| `RedirectStandardOutput = true`           | `InvalidOperationException`                         | 可                                               |
| 実行中の stdin への書き込み               | 不可                                                | 可                                               |
| `UseShellExecute = true`                  | `InvalidOperationException`                         | 可                                               |
| タイムアウト                              | 子プロセスを強制終了、`Canceled = true`             | `WaitForExit(TimeSpan)` が `false` を返し、子プロセスは実行を続ける |
| キャンセル (非同期)                       | 子プロセスを強制終了、例外なし                      | `WaitForExitAsync(ct)` が例外をスローし、子プロセスは実行を続ける |
| 終了させたシグナル                        | `ProcessExitStatus.Signal`                          | `ExitCode` (137、143) から推測                   |
| タイムアウト時に孫プロセスを強制終了      | 不可、直接の子プロセスのみ                          | `Kill(entireProcessTree: true)`                  |
| プロセス ID                               | 返されない                                          | `Process.Id`                                     |
| `/usr/bin/true` の起動、同期              | 737.0 us, 16.56 KB                                  | 739.4 us, 16.84 KB                               |

ほとんどのケースは最初の 5 行で決まります。呼び出し箇所で `StandardInput`、`BeginOutputReadLine`、`UseShellExecute` のいずれかを使っているなら、`Process.Run` はそもそも選択肢になりません。どれも使っていないなら、`Process.Run` のほうが短く書けて、既定値もより安全です。

## Process.Run が実際に行っていること

`Process.Run` は .NET 11 Preview 4 で `RunAndCaptureText` や `StartAndForget` と一緒に、[Process API の刷新](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/)の一部として登場しました。この刷新については[デッドロックしない出力キャプチャが入ったとき](/ja/2026/05/dotnet-11-process-api-deadlock-free-capture/)に取り上げています。RC 1 の API は次のとおりです。

```csharp
// .NET 11 RC 1, System.Diagnostics.Process
public static ProcessExitStatus Run(ProcessStartInfo startInfo, TimeSpan? timeout = default);
public static ProcessExitStatus Run(string fileName, IEnumerable<string>? arguments = null,
    bool silent = false, TimeSpan? timeout = default);

public static Task<ProcessExitStatus> RunAsync(ProcessStartInfo startInfo,
    CancellationToken cancellationToken = default);
public static Task<ProcessExitStatus> RunAsync(string fileName, IEnumerable<string>? arguments = null,
    bool silent = false, CancellationToken cancellationToken = default);
```

Preview 4 のブログ記事とは 2 点が異なります。Preview 7 で `arguments` が `IList<string>?` から `IEnumerable<string>?` に変わり ([dotnet/runtime#130630](https://github.com/dotnet/runtime/pull/130630))、`fileName` を受け取るオーバーロードには stdin、stdout、stderr を null デバイスに向ける `silent` フラグが追加されました。

[`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) の実装は、正確に要約できるほど短いものです。`Process` オブジェクトは一切作りません。`SafeProcessHandle.Start(startInfo)` を呼び出し、続けて `WaitForExit()` または `WaitForExitOrKillOnTimeout(timeout)` を呼び、戻る前にハンドルを破棄します。`RunAsync` も `WaitForExitOrKillOnCancellationAsync` を使って同じことをします。ハンドルをリークしえないのはこのためであり、`Process` による操作を必要とするものを拒否するのもこのためです。`RedirectStandard*` フラグは、誰かが `Process.StandardOutput` を保持して読み切る場合にしか意味がありません。

`ProcessExitStatus` には `ExitCode`、`Canceled`、null 許容の `PosixSignal? Signal` の 3 つのプロパティがあります。同じ型は [RC 1 で追加された `Process.WaitForExitStatus` メソッド](/ja/2026/09/dotnet-11-rc-1-process-signal-exit-status/)からも返されます。

## 同じ処理を両方の方法で書く

日常的なケースを見てみます。`dotnet build` を実行し、出力はそのままコンソールに流し、失敗したら失敗扱いにし、5 分で打ち切ります。

```csharp
// .NET 11 RC 1, C# 15 -- before: Process.Start
using System.Diagnostics;

using Process build = Process.Start("dotnet", ["build", "-c", "Release"]);

if (!build.WaitForExit(TimeSpan.FromMinutes(5)))
{
    build.Kill(entireProcessTree: true);
    build.WaitForExit();
    throw new TimeoutException("dotnet build took longer than 5 minutes");
}

if (build.ExitCode != 0)
    throw new InvalidOperationException($"dotnet build failed with {build.ExitCode}");
```

```csharp
// .NET 11 RC 1, C# 15 -- after: Process.Run
using System.Diagnostics;

ProcessExitStatus status = Process.Run(
    "dotnet", ["build", "-c", "Release"],
    timeout: TimeSpan.FromMinutes(5));

if (status.Canceled)
    throw new TimeoutException("dotnet build took longer than 5 minutes");

if (status.ExitCode != 0)
    throw new InvalidOperationException($"dotnet build failed with {status.ExitCode}");
```

`Process.Start` 版も正しいのですが、それはよく忘れられる 2 つの点をきちんと押さえているからにすぎません。`WaitForExit(TimeSpan)` はタイムアウトしても何も強制終了しないこと、そして `Process` は破棄しなければならないことです。`Process.Run` 版では、そのどちらも間違えようがありません。ただし、最初の版で `entireProcessTree: true` を残しているのは意図的です。これについては注意点のセクションで説明します。

## タイムアウトとキャンセルの動作は異なる

検索と置換で移行した人がつまずくのはこの違いです。.NET 11 RC 1 で、`sleep 10` に対して 500 ms の制限時間で両方を実行しました。

```csharp
// .NET 11 RC 1, C# 15, macOS 26.6
using System.Diagnostics;

using var cts = new CancellationTokenSource(500);
ProcessExitStatus s = await Process.RunAsync("sleep", ["10"], cancellationToken: cts.Token);
Console.WriteLine($"ExitCode={s.ExitCode} Canceled={s.Canceled} Signal={s.Signal}");
// ExitCode=137 Canceled=True Signal=SIGKILL   (returned after 505 ms, no exception)

using var cts2 = new CancellationTokenSource(500);
using Process p = Process.Start("sleep", ["10"]);
try { await p.WaitForExitAsync(cts2.Token); }
catch (TaskCanceledException) { Console.WriteLine($"HasExited={p.HasExited}"); }
// HasExited=False   (the child is still running)
```

この出力から読み取れることは 3 つです。

1. **`RunAsync` はキャンセル時に例外をスローしません。** 子プロセスを `SIGKILL` (Windows では `TerminateProcess`) で強制終了し、終了を待ってから `Canceled = true` のステータスを返します。`catch (OperationCanceledException)` で囲んだコードが catch ブロックに入ることはありません。代わりに `status.Canceled` を確認します。
2. **`Process.WaitForExitAsync(ct)` がキャンセルするのは待機だけです。** `TaskCanceledException` をスローし、プロセスは生きたままです。終了させたいなら、自分で `Kill()` を呼び出します。
3. **`Signal` によって終了コードの推測が不要になります。** Unix では、`SIGKILL` で強制終了されたプロセスは終了コード 137、`SIGTERM` で強制終了されたプロセスは 143 を報告しますが、プロセスが単に `exit 137` することもあります。`ProcessExitStatus.Signal` を見れば、どちらが起きたのかがわかります。`Process.Run` の呼び出しでは、`Canceled` によってその強制終了が自分によるものかどうかがわかります。

同期版の `Run` は `TimeSpan? timeout` を受け取り、トークンは受け取りません。`RunAsync` はトークンを受け取り、タイムアウトは受け取りません。非同期でタイムアウトを設定するには、上の例のように `new CancellationTokenSource(TimeSpan)` を使います。キャンセルが ASP.NET Core のリクエストやホステッドサービスから流れてくる場合は、[長時間実行される Task をデッドロックさせずにキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)のパターンがそのまま使えます。

## Process.Run を選ぶべき場面

- **ビルドスクリプトや CLI ラッパー**で、`git`、`dotnet`、`npm`、`docker` を実行し、出力をそのままコンソールに流す場合。既定の `silent: false` では子プロセスが親のハンドルを継承するため、色付けやプログレスバーもそのまま動作します。
- **ヘルスチェックやプローブ**で、終了コードだけが重要な場合。`Process.Run("pg_isready", ["-h", host], silent: true, timeout: TimeSpan.FromSeconds(3))` だけで実装が完結します。
- **サービスを決してハングさせてはならないツール。** タイムアウトとキャンセルの経路が子プロセスを強制終了してくれるので、固まった `ffprobe` がリクエストの後ろに積み上がることはありません。
- **出力をコンソールではなくファイルに書き出す場合。** `ProcessStartInfo.StandardOutputHandle` は任意の `SafeFileHandle` を受け付け、`Run(ProcessStartInfo)` もこれをサポートしています。

```csharp
// .NET 11 RC 1, C# 15
using System.Diagnostics;
using Microsoft.Win32.SafeHandles;

using SafeFileHandle log = File.OpenHandle("build.log", FileMode.Create, FileAccess.Write);

ProcessExitStatus status = Process.Run(new ProcessStartInfo("dotnet", ["build"])
{
    StandardOutputHandle = log,
    StandardErrorHandle = log,
    WorkingDirectory = "/src/app",
});
```

出力をファイルではなくメモリ上に取りたい場合は、どちらの API も使わずに `Process.RunAndCaptureText` を呼び出します。stdout と stderr を並行して読み切るので、リダイレクトにまつわる古典的なデッドロックは起こりえません。

## Process.Start を使い続けるべき場面

- **対話的な stdin。** `ssh-keygen` にパスワードを渡す、`psql` に SQL をパイプで流す、REPL とやり取りするといった処理には `RedirectStandardInput` と `Process.StandardInput` が必要です。`Run` はどの `RedirectStandard*` フラグに対しても例外をスローします。
- **プロセス実行中の出力のストリーミング。** `ffmpeg` の出力行を表示されたそばから見せる進捗 UI には `Process` が必要です。.NET 11 では少なくともイベントハンドラーをやめて `process.ReadAllLinesAsync(ct)` を使えます。これは両方のストリームから `ProcessOutputLine` の値をデッドロックなしで返します。
- **シェル実行。** URL やドキュメントを既定のアプリで開くには、今でも `Process.Start(new ProcessStartInfo("https://startdebugging.net") { UseShellExecute = true })` を使います。`Run`、`RunAsync`、`StartAndForget` はいずれも例外をスローします。Windows のシェル実行では新しいプロセスがまったく作られない場合があるためです。
- **プロセスツリー。** 子プロセスがワーカー (MSBuild ノード、`node` を実行する `npm`、シェルスクリプト) を起動する場合、それらを片付けられるのは `Process.Kill(entireProcessTree: true)` だけです。次のセクションを参照してください。
- **`Process` そのものが必要な場合**: ログ用の `Id`、`Exited` イベント、`PriorityClass`、Windows 専用の `userName`/`password` オーバーロードなどです。
- **.NET 11 より前をターゲットにしている場合。** `Process.Run` は .NET 10 には存在しません。マルチターゲットのライブラリでは `#if NET11_0_OR_GREATER` が必要です。

## ベンチマーク

パフォーマンスはどちらかを選ぶ理由にはなりません。迷わずに済むように測定しておきました。環境: .NET 11 RC 1 (`11.0.0-rc.1.26425.128`)、インプロセス emit ツールチェーンを使った BenchmarkDotNet 0.15.8 (0.15.8 はアウトオブプロセス実行でまだ `net11.0` を認識しないため)、ウォームアップ 3 回と計測 15 回、macOS 26.6.2、10 コアの Apple M4。各ベンチマークは `/usr/bin/true` を起動し、その終了を待ちます。

```csharp
// .NET 11 RC 1, BenchmarkDotNet 0.15.8
[MemoryDiagnoser]
[InProcess, WarmupCount(3), IterationCount(15)]
public class SpawnBenchmarks
{
    private const string Exe = "/usr/bin/true";

    [Benchmark(Baseline = true)]
    public int Start_WaitForExit()
    {
        using Process p = Process.Start(Exe);
        p.WaitForExit();
        return p.ExitCode;
    }

    [Benchmark]
    public int Run() => Process.Run(Exe).ExitCode;

    [Benchmark]
    public async Task<int> Start_WaitForExitAsync()
    {
        using Process p = Process.Start(Exe);
        await p.WaitForExitAsync();
        return p.ExitCode;
    }

    [Benchmark]
    public async Task<int> RunAsync() => (await Process.RunAsync(Exe)).ExitCode;
}
```

| メソッド                 | Mean     | StdDev   | Allocated |
| ------------------------ | -------: | -------: | --------: |
| `Start_WaitForExit`      | 739.4 us | 6.26 us  | 16.84 KB  |
| `Run`                    | 737.0 us | 2.76 us  | 16.56 KB  |
| `Start_WaitForExitAsync` | 768.5 us | 13.89 us | 17.89 KB  |
| `RunAsync`               | 762.6 us | 2.56 us  | 17.47 KB  |

差は誤差の範囲内です。コストのほぼすべては OS によるプロセス作成であり、どちらの API も同じ `SafeProcessHandle` の起動経路を共有しています。`Process` オブジェクトを省くことで節約できるのは約 300 バイトです。.NET 11 の大きな改善 (.NET チームの測定によると Apple Silicon でプロセス起動が 98 倍高速) は、このレイヤーより下にあるため、どちらの API にも等しく効きます。

## 判断を左右する注意点

**タイムアウトで強制終了されるのは直接の子プロセスだけです。** `Process.Run("sh", ["-c", "sleep 31; true"], timeout: TimeSpan.FromMilliseconds(500))` を実行したところ、`Run` は `Canceled=True Signal=SIGKILL` を返しましたが、その後も `pgrep -f "sleep 31"` で `sleep` プロセスが見つかり、親が付け替えられて実行を続けていました。`Process.Start` と `Kill(entireProcessTree: true)` で同じテストをすると、何も残りませんでした。`dotnet build`、`npm run`、`docker compose`、そしてほとんどのシェルスクリプトは子プロセスを起動するので、タイムアウト後にマシンをきれいな状態にしておく必要があるなら、今でもツリーごと強制終了する `Process.Start` が正しい道具です。`ProcessStartInfo.KillOnParentExit` (Windows、Linux、Android のみ) は代わりになりません。これは自分のプロセスが終了したときに発動するもので、タイムアウトが切れたときではありません。

**文字列の引数を受け取るオーバーロードはありません。** `string` は `IEnumerable<string>` ではないため、`Process.Run("git", "status")` はコンパイルできません。`["status"]` を渡すか、`ProcessStartInfo("git", "status")` を作って `Run(ProcessStartInfo)` オーバーロードを使います。

**`silent: true` は stdin も null にします。** `git` が資格情報を尋ねるような入力を求める子プロセスは、ハングする代わりにすぐに end-of-file を読み取ります。サービスではたいていそれが望ましい動作ですが、開発用スクリプトでは驚くことになります。

**`Run(ProcessStartInfo)` は既存の start info を拒否します。** `RedirectStandardOutput = true` が残ったままの `ProcessStartInfo` を移行すると、`InvalidOperationException: The RedirectStandardInput, RedirectStandardOutput, and RedirectStandardError properties cannot be used by SafeProcessHandle.Start or Process.StartAndForget` が発生します。メッセージには `Run` も `RunAsync` も出てきませんが、同じチェックです。フラグを `StandardOutputHandle` に置き換えるか、`RunAndCaptureText` に切り替えます。

**起動失敗の挙動は同じです。** 実行ファイルが見つからない場合、どちらの API も同じ `Win32Exception` ("No such file or directory") をスローするので、既存のエラー処理はそのまま使えます。

**どちらも iOS と tvOS ではサポートされていません。** どちらにも `[UnsupportedOSPlatform("ios")]` と `[UnsupportedOSPlatform("tvos")]` が付いており、Mac Catalyst はサポートされています。MAUI プロジェクトでは、どちらを使ってもプラットフォームアナライザーが呼び出しを警告します。

## 結論

プロセスを完了まで実行する新しい .NET 11 のコードでは、`Process.Run` か `Process.RunAsync` を既定にします。プロセス関連のコードで最もよくある 3 つのミス (破棄されない `Process`、強制終了しないタイムアウト、シグナルを隠してしまう終了コード) を、測定可能なコストなしに取り除いてくれます。出力を文字列として必要になった時点で `Process.RunAndCaptureText` に移ります。`Process.Start` を使うのは、プロセスを実行中に操作する必要がある場合、シェル経由で開く場合、ツリー全体として終了させる場合だけです。最後のケースは見た目以上に重要です。`Process.Run` でラップしたくなるツールの多くは、そのタイムアウトが届かない子プロセスを黙って起動するからです。`WaitForExit` でブロックする古いコードをまだ保守しているなら、[基本的な終了待ちのパターン](/ja/2023/08/c-how-to-wait-for-a-process-to-end/)は `Process.Start` のコードがたいてい出発点にしているものであり、これらの既定値を念頭に置いて見直す価値があります。

### 関連記事

- [.NET 11 でデッドロックしないプロセス出力キャプチャが追加されました](/ja/2026/05/dotnet-11-process-api-deadlock-free-capture/)
- [.NET 11 RC 1 では P/Invoke なしで子プロセスに SIGTERM を送れます](/ja/2026/09/dotnet-11-rc-1-process-signal-exit-status/)
- [C#: プロセスの終了を待つ方法](/ja/2023/08/c-how-to-wait-for-a-process-to-end/)
- [C# で長時間実行される Task をデッドロックさせずにキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/)
- [C# の .Result と .Wait() vs GetAwaiter().GetResult() vs await](/ja/2026/07/result-wait-vs-getawaiter-getresult-vs-await-in-csharp/)

### 出典

- [Process API improvements in .NET 11](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/)、.NET Blog
- `v11.0.0-rc.1.26425.128` タグ時点の [`Process.Scenarios.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/Process.Scenarios.cs) と [`SafeProcessHandle.cs`](https://github.com/dotnet/runtime/blob/v11.0.0-rc.1.26425.128/src/libraries/System.Diagnostics.Process/src/Microsoft/Win32/SafeHandles/SafeProcessHandle.cs)、dotnet/runtime
- [Implement Process.Run, RunAsync, RunAndCaptureText, RunAndCaptureTextAsync](https://github.com/dotnet/runtime/pull/127210)、dotnet/runtime PR
- [.NET 11 Preview 7 libraries release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview7/libraries.md) (`IEnumerable<string>` 引数への変更)、dotnet/core
- [What's new in .NET libraries for .NET 11](https://learn.microsoft.com/en-us/dotnet/core/whats-new/dotnet-11/libraries)、MS Learn
- [`Process.Start` メソッド](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.start)、MS Learn
