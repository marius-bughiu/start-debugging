---
title: "C# プロセスの終了を待つには?"
description: "C# の WaitForExit と WaitForExitAsync で子プロセスの終了を待つ方法。.NET 8 と 10 で動くサンプルで終了コード、タイムアウト、キャンセル、後処理を確認します。"
pubDate: 2023-08-11
updatedDate: 2026-11-02
tags:
  - "csharp"
  - "dotnet"
lang: "ja"
translationOf: "2023/08/c-how-to-wait-for-a-process-to-end"
translatedBy: "claude"
translationDate: 2026-05-01
---
`process.WaitForExit()` は、起動したプロセスが終了するまで現在のスレッドをブロックします。非同期コードでは `await process.WaitForExitAsync()` を使うと、呼び出し元のスレッドをブロックせずに待機できます。`ExitCode` を読み取るのはプロセスの終了後です。

> 2026年11月2日更新: 元の `cmd.exe /C timeout 5` の例は Windows とそのコマンド環境に依存していました。以下の例は自分自身を子プロセスとして起動し、.NET 8 と .NET 10 で両方の待機方法、タイムアウト、キャンセルを確認します。

## 完全なサンプルを実行する

[実行可能な process-wait プロジェクトをダウンロード](/examples/process-wait.zip)して展開し、.NET 10 SDK を使ってプロジェクトのフォルダーで次のコマンドを実行します。.NET 8 のコマンドを実行するには .NET 8 ランタイムも必要です。

```sh
dotnet run -c Release -f net10.0
dotnet run -c Release -f net8.0
```

同じソースを両方のターゲットで実行します。シェルや外部の実行ファイルを使わず、自分自身のコピーを起動します。最初の2つの子プロセスは意図的に終了コード `7` を返します。親プロセスはその値を確認し、すべての確認に成功すると `0` を返します。3つ目の子プロセスは入力を待つため、タイムアウトとキャンセルの確認が、短時間のコマンドの終了速度に左右されません。

`Program.cs` の全体は次のとおりです。

```cs
using System.Diagnostics;
using System.Reflection;

if (args is ["--child"])
{
    await Task.Delay(100);
    return 7;
}

if (args is ["--child-until-input"])
{
    await Console.In.ReadLineAsync();
    return 0;
}

using (var process = StartChild("--child"))
{
    process.WaitForExit();
    Require(process.ExitCode == 7, "Synchronous child exit code.");
    Console.WriteLine($"sync exit: {process.ExitCode}");
}

using (var process = StartChild("--child"))
{
    await process.WaitForExitAsync();
    Require(process.ExitCode == 7, "Asynchronous child exit code.");
    Console.WriteLine($"async exit: {process.ExitCode}");
}

using (var process = StartChild("--child-until-input"))
{
    try
    {
        bool exited = process.WaitForExit(50);
        Require(!exited, "A timed-out wait must leave the child running.");
        Console.WriteLine($"timed wait exited: {exited}");

        using var cancellation = new CancellationTokenSource(50);
        bool canceled = false;
        try
        {
            await process.WaitForExitAsync(cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            canceled = true;
        }

        Require(canceled && !process.HasExited, "Canceling the wait must not kill the child.");
        Console.WriteLine("canceled wait; child still running");

        process.StandardInput.Close();
        await process.WaitForExitAsync();
        Require(process.ExitCode == 0, "The released child must exit normally.");
        Console.WriteLine($"released child exit: {process.ExitCode}");
    }
    finally
    {
        if (!process.HasExited)
        {
            try { process.Kill(); }
            catch (InvalidOperationException) when (process.HasExited) { }
            await process.WaitForExitAsync();
        }
    }
}

return 0;

static Process StartChild(string mode)
{
    var start = new ProcessStartInfo
    {
        FileName = Environment.ProcessPath ?? throw new InvalidOperationException("No process path."),
        UseShellExecute = false,
        RedirectStandardInput = mode == "--child-until-input"
    };

    if (string.Equals(Path.GetFileNameWithoutExtension(start.FileName), "dotnet", StringComparison.OrdinalIgnoreCase))
        start.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);

    start.ArgumentList.Add(mode);
    return Process.Start(start) ?? throw new InvalidOperationException("Child did not start.");
}

static void Require(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
```

期待される出力:

```text
sync exit: 7
async exit: 7
timed wait exited: False
canceled wait; child still running
released child exit: 0
```

## タイムアウト、キャンセル、後処理

`WaitForExit(50)` は、指定したミリ秒数以内に子プロセスが終了しなければ `false` を返します。`WaitForExitAsync(token)` は待機がキャンセルされると `OperationCanceledException` をスローします。どちらも子プロセスを終了させる操作ではありません。この例では子プロセスの入力を閉じることで正常終了させます。失敗後の後処理が必要な場合、`finally` ブロックが終了させるのは、この例が所有する子プロセスだけです。

実際のツールでは、待機を続けるか、そのツールのプロトコルで正常終了を要求するか、必要に応じてプロセスを強制終了するかを明確に決めてください。`Kill()` は強制終了を要求するので、その後もプロセスの終了を待ちます。`Process` の `Dispose` はコンポーネントのリソースを解放しますが、実行中のプログラムを停止するわけではありません。

[C# の using 宣言のガイド](/ja/2020/05/c-using-var-using-declaration/)では、スコープを抜けるときの破棄を `using` がどのように制御するかを説明しています。

標準出力や標準エラー出力をリダイレクトする場合は、終了を待つ前にそれらのストリームの読み取りを開始します。パイプがいっぱいになると、子が親を待つ一方で親が子を待つ状態になりかねません。[プロセス出力の取得ガイド](/ja/2026/05/dotnet-11-process-api-deadlock-free-capture/)では、この別の問題と新しい .NET 11 API を説明しています。このサンプルは .NET 8 ですでに利用できる API を使います。

macOS arm64 上で、実際の .NET 8.0.33 と .NET 10.0.10 ランタイムを使い、生成された apphost と `dotnet ProcessWait.dll` の両方でローカル検証しました。Windows や Linux で実行したという意味ではありません。ダウンロードには詳細な検証記録が含まれます。

API リファレンス: [WaitForExit](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexit)、[WaitForExitAsync](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.waitforexitasync)、[Kill](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.kill)。
