---
title: ".NET 11 がデッドロックなしのプロセス出力キャプチャを追加"
description: ".NET 11 Preview 4 では、stdout と stderr を並行して読み取る新しい System.Diagnostics.Process API、起動とキャプチャを 1 行で行うヘルパー、そして KillOnParentExit が登場します。"
pubDate: 2026-05-15
tags:
  - "dotnet"
  - "dotnet-11"
  - "csharp"
  - "process"
lang: "ja"
translationOf: "2026/05/dotnet-11-process-api-deadlock-free-capture"
translatedBy: "claude"
translationDate: 2026-05-15
---

Adam Sitnik 氏が、.NET 11 Preview 4 に入った `System.Diagnostics.Process` の一連の改善を[発表しました](https://devblogs.microsoft.com/dotnet/process-api-improvements-in-dotnet-11/)。注目すべきは、.NET 開発者なら誰しも一度は踏むデッドロックの罠が、ついに BCL レベルで解決されたことです。さらに「プロセスを起動して出力をキャプチャし、終了を待つ」というお決まりのボイラープレートが、たった 1 回の呼び出しにまとまります。

## 古いパターンがデッドロックする理由

古典的な書き方は一見安全に見えますが、そうではありません。

```csharp
var psi = new ProcessStartInfo("git", "log")
{
    RedirectStandardOutput = true,
    RedirectStandardError = true,
};
using var p = Process.Start(psi)!;
string stdout = p.StandardOutput.ReadToEnd();
string stderr = p.StandardError.ReadToEnd();
p.WaitForExit();
```

親プロセスが `stderr.ReadToEnd()` に到達する前に、子プロセスがパイプバッファ以上の量を `stderr` に書き込むと、子はいっぱいになったパイプで停止し、親は `stdout` のクローズを待ったまま停止します。両者は永遠に待ち続けます。これまでの公式の回避策は、`OutputDataReceived` を使うイベントベースの API、手動の `StringBuilder`、そして各ストリームに 1 つずつ用意した `ManualResetEvent` でした。動きはしますが、初回で正しく書ける人はいません。

## 新しいワンライナー

.NET 11 では `Process.RunAndCaptureText` と `Process.RunAndCaptureTextAsync` が追加され、両方のパイプを内部で多重化します。

```csharp
ProcessTextOutput result = await Process.RunAndCaptureTextAsync(
    "git",
    ["log", "--oneline", "-n", "20"]);

if (result.ExitStatus.ExitCode != 0)
    throw new InvalidOperationException(result.StandardError);

Console.WriteLine(result.StandardOutput);
```

`ProcessTextOutput` はキャプチャした stdout、stderr、プロセス ID、そして終了コードに加え Unix では終了シグナルも報告する `ProcessExitStatus` を保持します。すでに動作中の `Process` を持っている呼び出し元向けの `Process.ReadAllText`、各行に `StandardError` フラグを付けて `IEnumerable<ProcessOutputLine>` をストリーミングする `ReadAllLines/Async`、バイナリツール向けの `ReadAllBytes/Async` も用意されています。ブログによれば、同期版の `RunAndCaptureText` は Windows でイベントベースの同等ループに比べてメモリ割り当てが約 4.5 倍少ないとのことです。

## ライフタイムと切り離し

長年の落とし穴 2 つも、正式なサポートを得ました。`ProcessStartInfo.KillOnParentExit` は Windows、Linux、Android で子プロセスを親のライフタイムに紐付けるため、クラッシュした CLI ツールが孤児ワーカーを残すことはなくなります。`ProcessStartInfo.StartDetached` はその逆で、子プロセスは親プロセスと、それを起動した端末よりも長く生き続けます。`Process.StartAndForget` は PID だけを返して即座に親側のハンドルを解放するため、ファイア・アンド・フォーゲットの起動にぴったりです。

```csharp
int pid = Process.StartAndForget("notepad.exe");
```

## ハンドル配線

より低レイヤーのシナリオでは、`ProcessStartInfo.StandardInputHandle`、`StandardOutputHandle`、`StandardErrorHandle` が任意の `SafeFileHandle` を受け取れます。新しい `SafeFileHandle.CreateAnonymousPipe` から取得したパイプや、`File.OpenNullHandle` の破棄シンクも含まれます。`ProcessStartInfo.InheritedHandles` を使えば、フォーク境界を越えるハンドルをホワイトリストで厳密に指定でき、Windows でのファイルロックリークの実際の原因のひとつを塞ぐことができます。

[.NET 11 Preview 4](https://dotnet.microsoft.com/en-us/download/dotnet/11.0) で試して、`OutputDataReceived` ハンドラーを削除し始めましょう。
