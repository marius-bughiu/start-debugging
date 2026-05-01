---
title: "C# プロセスの終了を待つには?"
description: "プロセスの終了を待つには WaitForExit メソッドが使えます。コードは同期的にプロセスの終了を待ち、その後で実行を再開します。例を見てみましょう。上のコードは新しい cmd.exe プロセスを開始し、timeout 5 コマンドを実行します。process.WaitForExit() の呼び出しによって、プログラムは..."
pubDate: 2023-08-11
updatedDate: 2023-11-05
tags:
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2023/08/c-how-to-wait-for-a-process-to-end"
translatedBy: "claude"
translationDate: 2026-05-01
---
プロセスの終了を待つには `WaitForExit` メソッドが使えます。コードは同期的にプロセスの終了を待ち、その後で実行を再開します。

例を見てみましょう。

```cs
var process = new Process
{
    StartInfo = new ProcessStartInfo
    {
        WindowStyle = ProcessWindowStyle.Hidden,
        FileName = "cmd.exe",
        Arguments = "/C timeout 5"
    }
};

process.Start();
process.WaitForExit();
```

上のコードは新しい `cmd.exe` プロセスを開始し、`timeout 5` コマンドを実行します。`process.WaitForExit()` の呼び出しによって、プログラムは `timeout` コマンドの実行が終わるまで待機します。その後、スレッドの実行が再開されます。
