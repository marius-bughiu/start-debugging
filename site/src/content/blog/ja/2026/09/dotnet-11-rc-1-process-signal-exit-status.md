---
title: ".NET 11 RC 1 では P/Invoke なしで子プロセスに SIGTERM を送れます"
description: ".NET 11 RC 1 で Signal、WaitForExitStatus、ProcessExitStatus が System.Diagnostics.Process に直接追加され、子プロセスのグレースフルな停止に kill の P/Invoke も SafeProcessHandle 経由の迂回も不要になりました。"
pubDate: 2026-09-09
tags:
  - "dotnet-11"
  - "csharp"
  - "process"
  - "dotnet"
lang: "ja"
translationOf: "2026/09/dotnet-11-rc-1-process-signal-exit-status"
translatedBy: "claude"
translationDate: 2026-09-09
---

[.NET 11 Release Candidate 1](https://devblogs.microsoft.com/dotnet/dotnet-11-rc-1/) が 2026-09-08 に go-live ライセンス付きでリリースされました。ライブラリのセクションの冒頭を飾るのは、C# から子プロセスを監視したことのある人なら誰もが煩わしく感じてきた点の解消です。`System.Diagnostics.Process` が POSIX シグナルを送信し、プロセスが実際にどう終了したかを報告できるようになりました。`SafeProcessHandle` まで降りる必要はありません ([dotnet/runtime#131165](https://github.com/dotnet/runtime/pull/131165))。

## Kill() は常に SIGKILL でした

Unix における `Process.Kill()` は `SIGKILL` です。子プロセスにはバッファーをフラッシュする機会も、ソケットを閉じる機会も、シャットダウンハンドラーを実行する機会もありません。暴走したプロセスにはそれで構いませんが、他のほとんどのケースでは不適切です。開発サーバー、`ffmpeg` のトランスコード、Postgres のコンテナー、きれいに停止したいテストハーネスなどが該当します。

回避策は P/Invoke でした。

```csharp
[LibraryImport("libc", SetLastError = true)]
private static partial int kill(int pid, int sig);

// 15 on Linux and macOS, but you had to know that
kill(process.Id, 15);
```

これは 3 行分のプラットフォーム前提とハードコードされたシグナル番号であり、しかもシグナルが実際に配送されたかどうかを知る手段がありません。

## RC 1 の API サーフェス

RC 1 は `Process` に 4 つのメンバーを追加します。

```csharp
public bool Signal(PosixSignal signal);
public ProcessExitStatus WaitForExitStatus();
public bool TryWaitForExitStatus(TimeSpan timeout, out ProcessExitStatus? exitStatus);
public Task<ProcessExitStatus> WaitForExitStatusAsync(
    CancellationToken cancellationToken = default);
```

これだけあれば、段階的にエスカレーションするパターンをきちんと書けます。

```csharp
using System.Diagnostics;
using System.Runtime.InteropServices;

using Process worker = Process.Start("./worker")!;

if (!worker.Signal(PosixSignal.SIGTERM))
{
    // false means the process is already gone, not that the call failed
    return;
}

if (!worker.TryWaitForExitStatus(TimeSpan.FromSeconds(10), out ProcessExitStatus? status))
{
    worker.Signal(PosixSignal.SIGKILL);
    status = worker.WaitForExitStatus();
}

Console.WriteLine($"exit={status.ExitCode} signal={status.Signal}");
```

## ProcessExitStatus が終了コードの当て推量を終わらせます

`ProcessExitStatus` は sealed が付いた小さなクラスで、`ExitCode`、`Canceled`、そして null 許容の `PosixSignal? Signal` という 3 つのプロパティを持ちます。有用なのは null 許容のシグナルです。これまではシグナルによる終了を、終了コードに埋め込まれた `128 + signal number` という慣習から推測するしかなく、それは 143 で正当に終了するプロセスと静かに衝突していました。今は `status.Signal is PosixSignal.SIGTERM` が直接答えを返し、`Canceled` は待機が子プロセスではなく自分のタイムアウトや `CancellationToken` で終わったことを教えてくれます。

これは `Process.RunAndCaptureText` などが返すものと同じ `ProcessExitStatus` で、[デッドロックのないキャプチャー API が Preview 4 に登場したとき](/ja/2026/05/dotnet-11-process-api-deadlock-free-capture/)に取り上げました。

## 動作しない場面

クロスプラットフォームの監視コードを書く前に知っておきたい制限が 3 つあります。

- `Signal` には `[UnsupportedOSPlatform("ios")]` と `[UnsupportedOSPlatform("tvos")]` が付いています。Mac Catalyst はサポートされます。
- Windows で受け付けられるのは `PosixSignal.SIGKILL` だけで、これは `TerminateProcess` にマップされます。それ以外のシグナルは `PlatformNotSupportedException` をスローするため、まず穏やかに、次に強制的にという経路には `OperatingSystem.IsWindows()` による分岐が必要です。
- Unix では `WaitForExitStatus` は現在のプロセスの子に対してのみ機能します。PID でアタッチした `Process` を待機するとスローされます。

一覧は [RC 1 のライブラリのリリースノート](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/rc1/libraries.md)にあります。go-live ライセンスが付いた今回の RC は、本番のプロセス監視の裏側に置ける最初の RC です。
