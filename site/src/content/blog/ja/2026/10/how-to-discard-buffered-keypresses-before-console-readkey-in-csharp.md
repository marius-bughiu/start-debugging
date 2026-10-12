---
title: "C# のコンソールゲームループで Console.ReadKey の前にバッファされたキー入力を破棄する方法"
description: "新しいキーを待つ前に while (Console.KeyAvailable) Console.ReadKey(true) で入力バッファを空にし、ゲームループでは毎フレーム空にしてキーリピートが溜まらないようにします。.NET 10 の Windows と Unix でのバッファの仕組み、キーを押し続けると遅延する理由、Unix のエコーの罠、FlushConsoleInputBuffer も解説します。"
pubDate: 2026-10-12
template: how-to
tags:
  - "csharp"
  - "dotnet-10"
  - "console"
  - "how-to"
lang: "ja"
translationOf: "2026/10/how-to-discard-buffered-keypresses-before-console-readkey-in-csharp"
translatedBy: "claude"
translationDate: 2026-10-12
---

**結論:** .NET には `Console.ClearInputBuffer()` がないため、自分で空にします: `while (Console.KeyAvailable) Console.ReadKey(intercept: true);`。"何かキーを押してください" の `ReadKey` の直前にこれを置けば、カットシーンやロード待ちの間に入力されたキーでプロンプトが飛ばされることはありません。ゲームループでは、同じ処理を毎フレーム1回実行し、フレームごとに1キーだけ読むのではなく、最後のキー (または必要なすべてのキー) に対して処理を行います。そうしないと、キーを押し続けたときのオートリピートが溜まり、プレイヤーは指を離した後も動き続けます。stdin がパイプやファイルの場合、`KeyAvailable` も `ReadKey` も `InvalidOperationException` をスローするため、`Console.IsInputRedirected` でガードしてください。

以下はすべて macOS 上の .NET 10 (SDK 10.0.302、ランタイム 10.0.10) で実行したもので、人間が入力するのと同じ経路をキー入力が通るように、実際の疑似端末経由でアプリを操作しています。Windows での動作は、[`v10.0.0` タグ](https://github.com/dotnet/runtime/tree/v10.0.0/src/libraries/System.Console/src/System)の `System.Console` のソースに基づいて説明しています。関連するコード (`KeyAvailable`、`ReadKey`、Unix のネイティブ端末セットアップ) は `main` でも変わっていないため、同じ答えが .NET 11 のリリース候補にも当てはまります。

## "バッファされた" キーが実際にある場所

キー入力が直接 `ReadKey` 呼び出しに届くわけではありません。キーはオペレーティングシステムによってキューに入れられ、誰かが読み取るまでそこに残ります。キーが押されたときにプログラムが何をしていたかは関係ありません。2秒の `Thread.Sleep` による "イントロ" の間にプレイヤーが Enter を連打すると、次の3つのプロンプトが飛ばされるのはそのためです。

キューの場所はプラットフォームごとに異なり、適切なフラッシュ方法を選ぶ上で重要になります。

- **Windows。** コンソールホストは `INPUT_RECORD` 構造体のキューを保持しています。キーダウンとキーアップのイベント、マウスイベント、ウィンドウのサイズ変更イベント、フォーカスイベントです。`Console.KeyAvailable` は `PeekConsoleInput` を呼び出し、先頭のレコードが `ReadKey` が返すキーダウンイベントでなければ、それを読み取って捨て、再度確認します。`Console.ReadKey` も同じループで `ReadConsoleInput` を呼び出します。もう1つ細かい点として、キーレコードのリピート回数が 1 より大きい場合、.NET はそれを private static フィールド (`_cachedInputRecord`) にキャッシュし、そのキャッシュからリピート1回につき1つの `ConsoleKeyInfo` を返します。
- **Linux と macOS。** バイトは端末のファイルディスクリプタに届きます。.NET の `StdInReader` はそれらをチャンク単位で独自の `char[]` バッファに読み込み、エスケープシーケンス (上矢印なら `ESC [ A` など) を `ConsoleKeyInfo` 値に解析します。`Console.KeyAvailable` は、そのマネージドバッファに未解析の文字が残っている場合、または stdin に対する `poll()` がカーネル側にまだバイトが待機していると示した場合に `true` を返します。

つまり、どちらのプラットフォームにも、オペレーティングシステムが所有するレイヤーと .NET が所有するレイヤーがあります。オペレーティングシステム側のレイヤーだけをクリアするフラッシュでは、.NET 側のレイヤーにキーが残る可能性があります。`ReadKey` 経由で空にすれば両方が空になるため、これが移植性のある答えです。

## 先行入力でプロンプトが飛ばされる最小の再現コード

```csharp
// .NET 10, C# 14 -- save as typeahead.cs and run with: dotnet run typeahead.cs
Console.WriteLine("Loading level (type some keys now)...");
Thread.Sleep(3000);                       // stands in for a cutscene, a save, a slow load

Console.WriteLine("Press any key to start.");
var key = Console.ReadKey(intercept: true);
Console.WriteLine($"Started by: {key.Key}");
```

3秒間の待機中に `abc` と矢印キーを入力してください。プログラムは "Press any key to start." と表示し、すぐに `Started by: A` と報告します。プロンプトが表示される前に、最初にバッファされたキーが `ReadKey` を満たしてしまったためです。これをファイルベースアプリとして使う場合、[`dotnet run file.cs` の解説](/ja/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/)で、そうした単一ファイルのプログラムがどのようにビルドされ、キャッシュされるかを説明しています。

## 移植性のある解決策: KeyAvailable と ReadKey で空にする

1. `Console.IsInputRedirected` を確認し、`true` の場合は空にする処理をスキップします。
2. `while (Console.KeyAvailable)` でループし、その中で `Console.ReadKey(intercept: true)` を呼び出して結果を破棄します。
3. その後で初めてプロンプトを表示し、本当に必要なキーのために `ReadKey` を呼び出します。

```csharp
// .NET 10, C# 14
static class ConsoleInput
{
    /// <summary>Discards every key that is already waiting. Returns how many were dropped.</summary>
    public static int DiscardPendingKeys()
    {
        if (Console.IsInputRedirected) return 0;

        int discarded = 0;
        while (Console.KeyAvailable)
        {
            Console.ReadKey(intercept: true);
            discarded++;
        }
        return discarded;
    }

    /// <summary>Waits for a key pressed after this call, ignoring type-ahead.</summary>
    public static ConsoleKeyInfo ReadFreshKey(bool intercept = true)
    {
        DiscardPendingKeys();
        return Console.ReadKey(intercept);
    }
}
```

再現コードのプロンプトは次のようになります。

```csharp
// .NET 10, C# 14
Console.WriteLine("Press any key to start.");
var key = ConsoleInput.ReadFreshKey();
Console.WriteLine($"Started by: {key.Key}");
```

スリープ中に `abc`、上矢印、下矢印を疑似端末に送り込み、数秒後に `z` を送って、次のプローブで破棄を検証しました。

```csharp
// .NET 10, C# 14
Console.WriteLine("busy for 3s, type ahead now...");
Thread.Sleep(3000);
int discarded = 0;
while (Console.KeyAvailable)
{
    var k = Console.ReadKey(intercept: true);
    discarded++;
    Console.WriteLine($"discarded: Key={k.Key} Char={(int)k.KeyChar}");
}
Console.WriteLine($"discarded {discarded} keys; press a key");
var key = Console.ReadKey(intercept: true);
Console.WriteLine($"got: {key.Key}");
```

```text
discarded: Key=A Char=97
discarded: Key=B Char=98
discarded: Key=C Char=99
discarded: Key=UpArrow Char=0
discarded: Key=DownArrow Char=0
discarded 5 keys; press a key
got: Z
```

注目すべき点が2つあります。矢印キーは、3つのバラバラの文字ではなく、それぞれ1つの `ConsoleKeyInfo` として出てきました。`ReadKey` がエスケープシーケンスのパーサーを通すためです。バイトレベルのフラッシュ (生の stdin の読み取りや `tcflush` の呼び出し) では、エスケープシーケンスが途中で切れて `[A` が残り、2つの印字可能なキーとして読み取られる可能性があります。もう1つは `intercept: true` が重要であることです。`false` の場合、破棄された各キーが画面にエコーされ、隠したかったはずの余計な文字が表示されてしまいます。

## キーを離した後もプレイヤーが動き続ける理由

同じバッファはリアルタイムのループでも問題を起こしますが、より目立たない形です。プレイヤーが矢印キーを押し続けると、端末またはコンソールホストは、最初の遅延の後、一般的に毎秒30回程度のオートリピートのキーダウンイベントを生成します。初心者がよく書くループは、フレームごとに最大1キーだけを読み取ります。

```csharp
// .NET 10, C# 14 -- one key per frame: input lags behind
while (running)
{
    if (Console.KeyAvailable)
        Handle(Console.ReadKey(intercept: true).Key);

    Update();
    Draw();
    Thread.Sleep(100);   // ~10 fps
}
```

キーの到着がフレームより速いと、キーを押し続けている間はバックログが増え続け、離した後はフレームごとに1キーずつ消化されます。実測しました。毎秒10フレームのループに、33 ms 間隔で右矢印のシーケンスを30個送り込みました (起動の約1秒後から始まる、1秒間のオートリピートのシミュレーションです)。

```csharp
// .NET 10, C# 14
bool drainAll = args.Length > 0 && args[0] == "drain";
_ = Console.KeyAvailable;
var sw = System.Diagnostics.Stopwatch.StartNew();
int x = 0; long lastMove = 0;
while (sw.ElapsedMilliseconds < 4000)
{
    if (drainAll)
    {
        ConsoleKey? last = null;
        while (Console.KeyAvailable) last = Console.ReadKey(intercept: true).Key;
        if (last == ConsoleKey.RightArrow) { x++; lastMove = sw.ElapsedMilliseconds; }
    }
    else if (Console.KeyAvailable)
    {
        if (Console.ReadKey(intercept: true).Key == ConsoleKey.RightArrow) { x++; lastMove = sw.ElapsedMilliseconds; }
    }
    Thread.Sleep(100); // 10 fps
}
Console.WriteLine($"{(drainAll ? "drain" : "one-per-frame")}: x={x}, last move at {lastMove} ms");
```

```text
one-per-frame: x=30, last move at 3739 ms
drain: x=13, last move at 2268 ms
```

フレームごとに1キーだと、プレイヤーは30マス移動し、キーが "離された" 後も約1.5秒間動き続けました。フレームごとに全部を空にすると、最後のリピートから1フレーム以内に動きが止まりました。空にするバージョンは、キーを押している間フレームごとに1マス移動します。ゲームでは通常これが望ましい動作で、速度はオペレーティングシステムのリピートレートではなく、フレームレートに結び付きます。

一般的なパターンは、毎フレーム空にして小さなフレーム単位の入力状態にまとめ、`Update` がその状態を読み取る方法です。

```csharp
// .NET 10, C# 14
sealed class FrameInput
{
    private readonly HashSet<ConsoleKey> _pressed = new();

    public bool WasPressed(ConsoleKey key) => _pressed.Contains(key);

    public void Poll()
    {
        _pressed.Clear();
        if (Console.IsInputRedirected) return;

        while (Console.KeyAvailable)
            _pressed.Add(Console.ReadKey(intercept: true).Key);
    }
}

// game loop
var input = new FrameInput();
while (running)
{
    input.Poll();
    if (input.WasPressed(ConsoleKey.Escape)) break;
    if (input.WasPressed(ConsoleKey.LeftArrow))  player.X--;
    if (input.WasPressed(ConsoleKey.RightArrow)) player.X++;
    if (input.WasPressed(ConsoleKey.Spacebar))   player.Jump();

    Draw();
    Thread.Sleep(16);
}
```

"最後のキーが勝つ" 方式ではなくセットを使うことで、方向転換と同じフレームで押されたジャンプが失われません。修飾キーが必要な場合は、`ConsoleKeyInfo` 全体、または `(ConsoleKey, ConsoleModifiers)` のペアを保存してください。

コンソールが教えてくれないのは、キーが *現在押され続けているか* どうかです。`ReadKey` が返すのはキーダウンイベントだけです (Windows ではキーアップのレコードはスキップされます。ただし合成文字を伴う Alt のキーアップは例外で、Shift、Ctrl、Alt を単独で押した場合も同様にスキップされます。Unix では、端末はそもそもキーアップを送信しません)。コンソールゲームでの "押し続けている" 状態は、リピートイベントの到着から推測するものであり、そのため連続した移動が始まる前には必ずオペレーティングシステムの最初のリピート遅延があります。Windows で本当のキー状態が必要な場合は、P/Invoke による `GetAsyncKeyState` が定番の抜け道ですが、その段階になったら本格的なゲームフレームワークの検討に値します。

## Unix のエコーの罠: 先行入力が画面に表示される

Linux と macOS には、空にする処理では解決できない2つ目の症状があります。最初のプローブでは、出力が実際には次のようになっていました。

```text
busy for 3s, type ahead now...
abc^[[A^[[Bdiscarded: Key=A Char=97
```

キーは正しく破棄されましたが、プログラムがスリープしている間に、端末がすでにそれらをエコーしていました。原因は `pal_console.c` にあります。.NET は、最初のコンソール *読み取り* の際に端末を非カノニカルでエコーなしのモード (`ECHO`、`ICANON`、`IEXTEN` をクリア) に切り替えます。これには `SystemNative_StdinReady` を呼び出す `Console.KeyAvailable` も含まれます。その最初の読み取りの前は、端末はまだデフォルトのクックドモードで、すべてをエコーします。一度設定されると、.NET はプロセス終了時に元の設定を復元するまで、端末をそのモードのままにします。

対処法は、起動時に入力側へ1回触れておくことです。

```csharp
// .NET 10, C# 14 -- first line of Main, before any long-running work
if (!Console.IsInputRedirected)
    _ = Console.KeyAvailable;   // puts the terminal in no-echo, non-canonical mode
```

この行を先頭に置くと、3秒間のスリープ中にキーを入力しても出力はきれいなままでした。キーはバッファに残り、何もエコーされず、後の破棄処理でそれらが取り除かれました。Windows では、コンソールアプリの先行入力は入力レコードとして保持され、行モードで何かが読み取るまでエコーされないため、この問題は起きません。

## Windows 限定: FlushConsoleInputBuffer

Win32 には、コンソールの入力レコードキューを一度に空にする直接的な呼び出し、[`FlushConsoleInputBuffer`](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer) があります。O(1) で、マウスやサイズ変更のレコードもクリアできるため魅力的です。

```csharp
// .NET 10, C# 14 -- needs <AllowUnsafeBlocks>true</AllowUnsafeBlocks> for LibraryImport
using System.Runtime.InteropServices;

static partial class WinConsole
{
    private const int StdInputHandle = -10;

    [LibraryImport("kernel32.dll", SetLastError = true)]
    private static partial nint GetStdHandle(int nStdHandle);

    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool FlushConsoleInputBuffer(nint hConsoleInput);

    public static bool TryFlush()
    {
        if (!OperatingSystem.IsWindows() || Console.IsInputRedirected) return false;
        return FlushConsoleInputBuffer(GetStdHandle(StdInputHandle));
    }
}
```

これは .NET 10 でコンパイルしました (`#:property AllowUnsafeBlocks=true` を使ったファイルベースアプリとして) が、実行できたのは macOS だけで、そこでは `TryFlush` は `kernel32` を呼び出さずに `false` を返します。それでも、この後にマネージドの破棄処理を呼び出します。ソースから分かる理由が1つあります。`FlushConsoleInputBuffer` は .NET の private な `_cachedInputRecord` に手が届かないのです。`ReadKey` が最後に取得したレコードのリピート回数が 1 を超えていた場合、残りのリピートはそのフィールドから供給され、`KeyAvailable` はコンソールに問い合わせる前にそれらに対して `true` を返します。`DiscardPendingKeys()` はそのキャッシュも空にします。`LibraryImport` とソース生成によるマーシャリングに不慣れな場合は、[Polars.NET の記事](/ja/2026/02/dotnet-polarsnet-rust-dataframe-engine-with-libraryimport/)で解説しています。また、[Windows のセッションのロック・ロック解除イベントの記事](/ja/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/)では、`wtsapi32.dll` に対して同じ `LibraryImport` のパターンを使い、`AllowUnsafeBlocks` の設定も説明しています。

## 注意点とエッジケース

**リダイレクトされた入力では例外がスローされます。** stdin がパイプされている場合 (`echo abc | dotnet run game.cs`)、どちらの呼び出しもスローします。.NET 10 の正確なメッセージは次のとおりです。

```text
KeyAvailable threw InvalidOperationException: Cannot see if a key has been pressed when either application does not have a console or when console input has been redirected from a file. Try Console.In.Peek.
ReadKey threw InvalidOperationException: Cannot read keys when either application does not have a console or when console input has been redirected. Try Console.Read.
```

これは CI、コンソールコードを実行する `dotnet test`、stdin をリダイレクトする一部の IDE の "実行" コンソールで問題になります。上記のヘルパーはすべて、`Console.IsInputRedirected` の場合は早期に return します。

**Console.In で空にしないでください。** `Console.In.Read()` と `Console.In.Peek()` は Unix では行指向です。戻る前に `StdInReader` 内の別のスタックへ1行全体を読み込むため、Enter が押されるまでブロックし、`KeyAvailable` が確認しない場所にキーを取り込んでしまいます。1つのプログラムで `ReadLine` と `ReadKey` を混在させるのは問題ありませんが、`TextReader` API で空にするのは避けてください。

**空にすることはデバウンスではありません。** 破棄の5 ms 後にユーザーがキーを押した場合、それは新しいキーであり、`ReadKey` はそれを返します。それは正しい動作ですが、メニューでの誤った二重押しが気になる場合は、破棄の前に短い遅延を入れてください。たとえば、プロンプトのきっかけとなった処理の直後に `Thread.Sleep(150)` を置きます。

**KeyAvailable をスピンしないでください。** `while (!Console.KeyAvailable) { }` は CPU コアを1つ使い切ります。フレームループでは、スリープするか次のフレームを待ってください。"キーを待つが N 秒で諦める" 場合は、短い `Task.Delay` と期限を使って `KeyAvailable` をポーリングするか、[`CancellationTokenSource.CancelAfter`](/ja/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/) のトークンで包みます。`Console.ReadKey` 自体は、ブロックしてしまうとキャンセルできないため、諦める唯一の方法は、`KeyAvailable` が読み取れるものがあると示すまで呼び出さないことです。トークンは、[キャンセルを尊重すべき非同期メソッド](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)と同じ方法で、呼び出しチェーンの下位へ渡してください。

**Ctrl+C はデフォルトではキーではありません。** `Console.TreatControlCAsInput = true` を設定しない限り、Ctrl+C は `Console.CancelKeyPress` を発生させ、バッファには入らないため、破棄処理はそれを見ることも、握りつぶすこともありません。ゲームのためにこれを `true` に設定した場合、一時停止中に押された Ctrl+C を破棄処理が黙って食べてしまうことを覚えておいてください。

**マルチスレッドでの読み取り。** Windows では `ReadKey` がロックを取得し、Unix では `KeyAvailable` と `ReadKey` が同期されたリーダーを経由します。そのため異なるスレッドから呼び出しても安全ですが、意味のある動作にはなりません。バックグラウンドの入力スレッドとメインスレッドでの破棄がお互いのキーを奪い合います。コンソール入力を所有するスレッドを1つに決めてください。

### 関連記事

- [How to run a file-based C# app with dotnet run in .NET 11](/ja/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/)
- [How to time out an async operation with CancellationTokenSource.CancelAfter in C#](/ja/2026/07/how-to-time-out-an-async-operation-with-cancellationtokensource-cancelafter-in-csharp/)
- [How to propagate a CancellationToken through async methods in .NET 11](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)
- [How to detect Windows session lock, unlock, logon and logoff events in a C# app](/ja/2026/10/how-to-detect-windows-session-lock-unlock-logon-and-logoff-events-in-csharp/)

## 参考資料

- [`Console.KeyAvailable` property](https://learn.microsoft.com/en-us/dotnet/api/system.console.keyavailable), Microsoft Learn.
- [`Console.ReadKey` method](https://learn.microsoft.com/en-us/dotnet/api/system.console.readkey), Microsoft Learn.
- [`FlushConsoleInputBuffer` function](https://learn.microsoft.com/en-us/windows/console/flushconsoleinputbuffer), Windows Console docs.
- [`ConsolePal.Windows.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/ConsolePal.Windows.cs) at `v10.0.0` (`KeyAvailable`, `ReadKey`, `_cachedInputRecord`).
- [`StdInReader.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/StdInReader.cs) and [`SyncTextReader.Unix.cs`](https://github.com/dotnet/runtime/blob/v10.0.0/src/libraries/System.Console/src/System/IO/SyncTextReader.Unix.cs) at `v10.0.0` (Unix buffering and `KeyAvailable`).
- [`pal_console.c`](https://github.com/dotnet/runtime/blob/v10.0.0/src/native/libs/System.Native/pal_console.c) at `v10.0.0` (terminal echo and canonical mode).
