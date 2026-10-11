---
title: "別のプロセスが書き込み中のログファイルを C# で tail する方法"
description: "FileShare.ReadWrite | FileShare.Delete でログを開き、末尾にシークして新しいバイトをポーリングし、StreamReader ではなく自前の UTF-8 Decoder でデコードし、切り詰めとローテーションを明示的に処理します。.NET 10 と .NET 11 向けに検証済みの tail -F 実装です。"
pubDate: 2026-10-11
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "file-io"
  - "logging"
  - "async"
lang: "ja"
translationOf: "2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it"
translatedBy: "claude"
translationDate: 2026-10-11
---

別のプロセスが書き込み用に開いたままのログファイルを読むには、`new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)` で開きます。`IOException: The process cannot access the file because it is being used by another process` を防ぐのは `FileShare.ReadWrite` です。ライター側がすでに書き込みアクセスを保持しているため、こちらの共有モードでそれを許可する必要があります。`FileShare.Delete` は、ログローテーション中にライターがファイルをリネームまたは削除しても失敗しないようにします。そのうえで末尾にシークし、タイマーで新しいバイトをポーリングし、最後の `\n` までのテキストだけを出力します。バイト列を `StreamReader` 経由で読んではいけません。`StreamReader` はファイル末尾に達するとデコーダーをフラッシュするため、ライターが書きかけのマルチバイト UTF-8 文字を壊してしまいます。最後に、EOF に達するたびに切り詰め (`fs.Length < fs.Position`) とローテーション (パスが別のファイルを指すようになったか) を確認します。以下の内容はすべて macOS 上の .NET 10.0.10 (SDK 10.0.302) と .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128) で実行しています。Windows の共有ルールについては、ランタイムのソースと Win32 の仕様に基づいています。

## File.ReadAllText が使用中のログファイルで例外を投げる理由

Windows では、ファイルを開くたびに 2 つの情報が付きます。必要なアクセス (`FileAccess`) と、同時に他者へ許可するアクセス (`FileShare`) です。2 回目のオープンが成功するのは、両者が合意した場合だけです。つまり、要求するアクセスが既存のすべてのハンドルの共有モードで許可され、かつ既存のすべてのハンドルのアクセスがこちらの共有モードで許可されている必要があります。

ロガーはほとんどの場合、次のようにファイルを開きます。`shared: false` (既定値) のときの [Serilog.Sinks.File の `FileSink`](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs) の該当行です。

```csharp
// Serilog.Sinks.File, non-shared mode
System.IO.File.Open(path, FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read);
```

ライターは `FileAccess.Write` を保持し、他者には読み取りを許可しています。次に、便利な API が何をしているかを見てみましょう。`File.ReadAllText`、`File.ReadAllLines`、`File.ReadLines`、`new StreamReader(path)` は、いずれも [`StreamReader.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs) の同じヘルパーに行き着きます。

```csharp
// dotnet/runtime, StreamReader path constructor
new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, FileStream.DefaultBufferSize);
```

`FileShare.Read` は、これを開いている間は誰にも書き込ませないという意味です。しかし、すでに誰かが書き込んでいるため、Windows は `ERROR_SHARING_VIOLATION` (Win32 エラー 32、HResult `0x80070020`) でオープンを拒否し、.NET はそれを `IOException: The process cannot access the file 'app.log' because it is being used by another process.` として通知します。解決策はリトライループではありません。ライターを許容する共有モードを要求することです。

```csharp
// .NET 10 / .NET 11, C# 14
using var fs = new FileStream(
    "app.log",
    FileMode.Open,
    FileAccess.Read,
    FileShare.ReadWrite | FileShare.Delete);
```

ライターが `FileShare.None` でファイルを開いている場合は、こちら側でどの共有モードを指定しても意味がありません。そのライターは排他アクセスを要求しているので、ハンドルが閉じられるのを待つしかありません。

### Linux と macOS での違い

Unix には強制的な共有モードがないため、.NET がそれをエミュレートします。.NET 6 以降、[`SafeFileHandle.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs) は助言的な `flock` を取得します。`FileShare.None` を渡すと `LOCK_EX`、それ以外の共有値では `LOCK_SH` です。結果として次の 2 点が生じます。どちらも macOS 上の .NET 10.0.10 で再現しました。

1. .NET のライターが `FileShare.Read` で保持しているファイルに対する `File.ReadAllText` は、Unix では成功します。そのため、自分の Mac では動くコードが、本番の Windows では例外を投げることがあります。
2. tail 側がファイルを開いている間に、.NET のライターが `FileShare.None` で開こうとすると `IOException` で失敗します (macOS では HResult `0x23`)。こちらの共有ロックがライターの排他ロックを妨げるためです。.NET 以外のライターは `flock` にまったく関与しません。

このロックは、ランタイムスイッチ `System.IO.DisableFileLocking` (環境変数 `DOTNET_SYSTEM_IO_DISABLEFILELOCKING=1`) で無効にできます。ロックデーモンのない NFS マウントで必要になるチームもあります。それでも Unix では `FileShare.ReadWrite | FileShare.Delete` を指定するのが正解です。意図が明確になり、Windows と同じ動作になります。

## 単純な tail ループが抱える 2 つのバグ

オープンが通るようになれば、`StreamReader` と `ReadLine()` のループという素朴な実装が思い浮かびます。`StreamReader` は EOF を保持し続けないので、ライターがデータを追記すれば、次の `ReadLine` はそれを返します。その部分は問題ありません。問題は別の 2 点です。

1 つ目は行の途中までのデータです。ライターが `"line1\npart"` をフラッシュした状態で `ReadLine()` を 2 回呼ぶと、`"line1"` と `"part"` が返ります。その後ライターが `"ial2\n"` を追記すると、`"ial2"` が返ります。1 行のログが 2 件のレコードになってしまいます。実際にこの手順を実行したところ、`[line1] [part]` が返り、追記後に `[ial2]` が返りました。

2 つ目は、あまり知られていませんが、分割された文字の問題です。`StreamReader` はバイト列を UTF-8 の `Decoder` に渡します。Decoder はマルチバイト文字の先頭バイトを、残りが届くまで保持できます。ところが、基になるストリームが 0 バイトを返すと、StreamReader はそれをストリームの終端とみなし、`_decoder.GetChars(..., flush: true)` を呼びます。フラッシュされたデコーダーは、不完全なシーケンスを `U+FFFD` に変えてしまいます。成長中のファイルでは、ストリームの終端とは単にライターがまだ追いついていないという意味でしかありません。次の再現コードは、`"żółć\n"` を 2 回に分けて書き込み、`ó` の最初のバイトの後で分割します。

```csharp
// .NET 10 / .NET 11, C# 14
using System.Text;

var path = Path.GetTempFileName();
var bytes = Encoding.UTF8.GetBytes("żółć\n");

using var writer = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read);
using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
using var reader = new StreamReader(fs, Encoding.UTF8);

var buf = new char[100];
var sb = new StringBuilder();
void Drain() { int n; while ((n = reader.Read(buf, 0, buf.Length)) > 0) sb.Append(buf, 0, n); }

writer.Write(bytes, 0, 3); writer.Flush(); Drain();               // "ż" + first byte of "ó"
writer.Write(bytes, 3, bytes.Length - 3); writer.Flush(); Drain();
Console.WriteLine(sb.ToString()); // prints "ż��łć"
```

出力は .NET 10.0.10 でも .NET 11 RC1 でも `ż��łć` となり、`Read` と `ReadAsync` のどちらでも同じです。ASCII 以外のユーザー名、ファイルパス、メッセージを含むログでは、ライターが文字の途中でフラッシュした時点でこの問題に当たります。バッファリングするライターは、バッファの境界が文字の途中に来るたびにフラッシュします。

2 つの問題への対処は同じです。`FileStream` からバイト列を自分で読み、自前の `Decoder` で `flush: false` を指定してデコードし、最後の改行より後のテキストは、行の残りが届くまでバッファに保持します。

## ローテーションに耐える tail -F 実装

完全なヘルパーを示します。行のストリームを `IAsyncEnumerable<string>` として公開するので、呼び出し側は `await foreach` を使い、トークンでキャンセルできます。

```csharp
// .NET 10 / .NET 11, C# 14
using System.Runtime.CompilerServices;
using System.Text;

public static class LogTail
{
    public static async IAsyncEnumerable<string> FollowAsync(
        string path,
        bool fromStart = false,
        TimeSpan? pollInterval = null,
        [EnumeratorCancellation] CancellationToken ct = default)
    {
        var interval = pollInterval ?? TimeSpan.FromMilliseconds(250);
        var bytes = new byte[16 * 1024];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        var decoder = Encoding.UTF8.GetDecoder();
        var pending = new StringBuilder();
        FileStream? fs = null;

        try
        {
            while (!ct.IsCancellationRequested)
            {
                if (fs is null)
                {
                    fs = TryOpen(path);
                    if (fs is null)
                    {
                        await Task.Delay(interval, ct);
                        continue;
                    }
                    if (!fromStart) fs.Seek(0, SeekOrigin.End);
                    fromStart = true; // a rotated-in file is read from the top
                    decoder.Reset();
                    pending.Clear();
                }

                int read = await fs.ReadAsync(bytes, ct);
                if (read > 0)
                {
                    // flush: false keeps a half-written multi-byte character
                    // inside the decoder until the rest of it arrives.
                    int n = decoder.GetChars(bytes, 0, read, chars, 0, flush: false);
                    pending.Append(chars, 0, n);
                    foreach (var line in DrainCompleteLines(pending))
                        yield return line;
                    continue;
                }

                // At EOF. Truncated in place (copytruncate)?
                if (fs.Length < fs.Position)
                {
                    fs.Seek(0, SeekOrigin.Begin);
                    decoder.Reset();
                    pending.Clear();
                    continue;
                }

                // Path now points at a different file (rename-and-recreate)?
                if (WasReplaced(path, fs))
                {
                    await fs.DisposeAsync();
                    fs = null;
                    continue;
                }

                await Task.Delay(interval, ct);
            }
        }
        finally
        {
            if (fs is not null) await fs.DisposeAsync();
        }
    }

    static FileStream? TryOpen(string path)
    {
        try
        {
            return new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 0, FileOptions.Asynchronous);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        catch (IOException) { return null; } // writer holds FileShare.None right now
    }

    static IEnumerable<string> DrainCompleteLines(StringBuilder pending)
    {
        int start = 0;
        for (int i = 0; i < pending.Length; i++)
        {
            if (pending[i] != '\n') continue;
            int end = i > start && pending[i - 1] == '\r' ? i - 1 : i;
            yield return pending.ToString(start, end - start);
            start = i + 1;
        }
        pending.Remove(0, start);
    }

    static bool WasReplaced(string path, FileStream current)
    {
        // Measure the path through a fresh handle, not FileInfo, and do it
        // before reading the current handle's length.
        using var probe = TryOpen(path);
        if (probe is null) return false; // rotated, new file not created yet
        long pathLength = probe.Length;
        // Same append-only file: pathLength == current.Position (we are at EOF)
        // or current.Length grew past it in the meantime. Anything else means
        // the name now belongs to another file.
        return pathLength < current.Position || pathLength > current.Length;
    }
}
```

コンソールアプリや `BackgroundService` からは、次のように使います。

```csharp
// .NET 10 / .NET 11, C# 14
using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

try
{
    await foreach (var line in LogTail.FollowAsync("/var/log/myapp/app.log", ct: cts.Token))
        Console.WriteLine(line);
}
catch (OperationCanceledException) { }
```

テストは、別プロセスから行を 2 回に分けて書き込む形で行いました (2 バイト文字の途中で分割し、フラッシュと 120 ms の待機を挟みます)。その後ファイルを `app.log.1` にリネームして新しいファイルを作成し、さらに新しいファイルを切り詰めて書き込みを続けました。tail 側はすべての行を壊さずに出力し、置換文字は現れず、リネーム後は新しいファイルに追従し、切り詰め後は先頭からやり直しました。これは .NET 10.0.10 と .NET 11 RC1 の両方で確認しています。

## 各部分が必要な理由

順に見ると、このループは 5 つのことをしています。

1. **`FileShare.ReadWrite | FileShare.Delete` で開く。** `ReadWrite` はライターを許容します。`Delete` は Windows でのローテーションに関わります。`app.log` を `app.log.1` にリネームしてアーカイブするロガーは `MoveFile` を呼びますが、開いているハンドルのどれかに `FILE_SHARE_DELETE` がないと共有違反で失敗します。これがないと、tail がアプリケーションのログローテーションを壊すことになり、行を 1 つ取りこぼすよりはるかに悪いバグです。
2. **最初のオープン時に末尾へシークする。** これが `tail -f` の動作で、今から起こることだけを表示します。ファイル全体を再生するには `fromStart: true` を渡します。ローテーション後は、新しいファイルの内容がすべて新規なので、ヘルパーは常に先頭から読みます。
3. **`Task.Delay` でポーリングする。** EOF での 250 ms ごとのポーリングは、0 を返す `read` システムコール 1 回と、ローテーション判定のための `open` と `fstat` 各 1 回です。この負荷は無視できます。`FileSystemWatcher` は魅力的に見えますが、多くのネットワーク共有やコンテナーのバインドマウントでは動作せず、内部バッファはバースト時にあふれてイベントを取りこぼし、追記中のライターの `Changed` 通知は OS によってまとめられ遅延します。使うとしても、待機時間を短縮するヒントとして使い、唯一のトリガーにはしないでください。
4. **`flush: false` でデコードし、途中の行をバッファする。** `DrainCompleteLines` は `\n` で終わるテキストだけを返し、末尾の `\r` を取り除いて CRLF のログもきれいに出力し、未完了の末尾部分は `pending` に残します。
5. **切り詰めとローテーションは EOF のときだけ確認する。** 読めるバイトがある間は、他のことは関係ありません。読めるバイトがなくなったとき、ハンドルベースの `fs.Length < fs.Position` が `copytruncate` を検出し、`WasReplaced` がリネームして再作成するパターンを検出します。

### ローテーションに専用の確認が必要な理由

`logrotate` (あるいは NLog のアーカイブ機能や自前のコード) が `app.log` をリネームして新しいファイルを作ると、ハンドルは名前には追従しません。ハンドルが指すのはパスではなくファイルです。Unix でも、`FILE_SHARE_DELETE` を指定した Windows でも、古いハンドルはリネームされたファイルを読み続けますが、そのファイルはもう成長しません。アプリケーションは新しい `app.log` に書き込み続けるのに、tail は永久に EOF で待ち続けることになります。

`WasReplaced` はパスをもう一度開いて長さを比較します。追記専用のログでは、パスがまだ読んでいるファイルを指していれば、その長さはこちらの位置と等しい (EOF にいるため) か、その後にライターが追記した場合は `current.Length` が後から読まれるので同じかそれ以上になります。パスの長さが位置より小さい、またはハンドルの長さより大きい場合は、別のファイルを意味します。`FileInfo.Length` ではなく新しいハンドル経由で測定するのは、Windows ではディレクトリエントリ由来のサイズ情報が、書き込み用に開かれたままのファイルに対して遅れることがあるためです。

この確認には盲点が 1 つあります。新しいファイルの長さが、すべての判定時点で古いファイルとまったく同じ場合です。この状況は新しいファイルが成長した時点で解消します。厳密な同一性が必要なら、P/Invoke でファイル ID (Windows では `GetFileInformationByHandle`、Unix では `fstat` の `st_dev` と `st_ino`) を比較してください。.NET 11 時点では、どちらも公開 API としては提供されていません。

## 最後の N 行を先に読む

`tail -n 50 -f` は、追跡を始める前に直近の内容を表示します。2 GB のファイルを丸ごと読んで最後の 50 行を探すのは無駄なので、代わりに末尾からウィンドウを読みます。

```csharp
// .NET 10 / .NET 11, C# 14
public static async Task<IReadOnlyList<string>> ReadLastLinesAsync(
    string path, int count, int maxBytes = 64 * 1024)
{
    await using var fs = new FileStream(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);
    long start = Math.Max(0, fs.Length - maxBytes);
    fs.Seek(start, SeekOrigin.Begin);
    using var reader = new StreamReader(fs, Encoding.UTF8);
    var lines = new Queue<string>(count + 1);
    bool skipFirst = start > 0; // we probably landed mid-line
    string? line;
    while ((line = await reader.ReadLineAsync()) is not null)
    {
        if (skipFirst) { skipFirst = false; continue; }
        lines.Enqueue(line);
        if (lines.Count > count) lines.Dequeue();
    }
    return lines.ToArray();
}
```

ここでは `StreamReader` で問題ありません。1 回限りの読み取りであり、不完全なデータがあるのは先頭 (スキップします) と、場合によっては最終行 (そのまま表示して構いません) だけだからです。ファイルの途中にシークすると UTF-8 シーケンスの途中に着地することがあり、これも最初の行を捨てる理由の 1 つです。64 KB に `count` 行が含まれていない場合は、`maxBytes` を倍にして再試行してください。これを呼び出して結果を表示し、その後 `fromStart: false` で `FollowAsync` を開始します。2 つの呼び出しの間に書き込まれた数行が失われることがあります。それが問題になる場合は、`ReadLastLinesAsync` が読み終えたオフセットを返すようにして、そこから追跡を始めてください。

## リーダー側の責任ではない落とし穴

**ライターはフラッシュする必要があります。** 見えるのは OS に届いた分だけです。Serilog のファイルシンクは既定で `buffered: false`、NLog のファイルターゲットは既定で `autoFlush="true"` ですが、`AutoFlush = false` の `StreamWriter` はバッファサイズまでのデータをメモリに保持します。tail が最後の行を取りこぼすという報告の多くは、ライターがまだフラッシュしていないだけです。

**`copytruncate` は仕様としてデータを失います。** 私のテストでは、ライターは最後の書き込みの 120 ms 後にファイルを切り詰め、250 ms ごとにポーリングしていた tail はその行を一度も見ませんでした。`logrotate` 自身のドキュメントも、コピーから切り詰めまでの間に書き込まれた行は失われると警告しています。ファイルを再オープンするアプリケーションと組み合わせたリネーム方式のローテーション (`create`) を使うか、ポーリング間隔を短くしてください。

**`FileAccess.ReadWrite` で開かないでください。** ライターに合わせるつもりなのか、オンラインのスニペットにはそうしているものがあります。必要なのは読み取りアクセスだけです。Windows では、ライターが `FileShare.Read` で開いていると、書き込みアクセスの要求は失敗します。

**エンコーディングと BOM。** このヘルパーは UTF-8 を前提としています。Serilog、NLog、Microsoft.Extensions.Logging のコンソールリダイレクト、そしてほぼすべての Unix ツールが UTF-8 で出力します。UTF-16 のログを追う場合は `Decoder` を差し替えてください。また、UTF-8 BOM で始まるファイルを `fromStart: true` で再生する場合は、最初の行から `'\uFEFF'` を取り除いてください。

**非常に長い行。** `pending` は改行が届くまで増え続けます。ライターが無制限の長さの行 (バイナリのゴミや圧縮された JSON の塊など) を出力しうる場合は、`pending.Length` に上限を設け、超えた時点で、その時点の内容を出力するか破棄してください。

**複数のライター。** Serilog の `shared: true` や、複数のプロセスが 1 つのファイルに追記する構成が成り立つのは、各書き込みがファイル末尾に対してアトミックに行われるからです。tail 側はライターが何台あっても気にしませんが、それぞれの部分的な書き込みの間でのインターリーブはライター側の問題であり、あなたの問題ではありません。

## 関連記事

- 問題が追記された内容ではなく、このファイルの書き込みが終わったかどうかである場合は、`FileShare.None` によるプローブとサイズの安定化を扱った [.NET でファイルの書き込み完了を検出する方法](/ja/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) を参照してください。
- `FollowAsync` は非同期ストリームです。[`IAsyncEnumerable` とは何か、いつ使うべきか](/ja/2026/06/what-is-iasyncenumerable-and-when-should-i-use-it/) では、トークンパラメーターに `[EnumeratorCancellation]` が付いている理由を説明しています。
- ホステッドサービスから tail をきれいに停止するには、[非同期呼び出しチェーン全体で `CancellationToken` を伝播させます](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/)。
- 行を複数のコンシューマーに振り分けたい場合は、[tail 側と処理側の間に `Channel<T>` を置きます](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/)。
- ライター側については、[.NET 11 での Serilog と Seq による構造化ログの設定](/ja/2026/05/how-to-set-up-structured-logging-with-serilog-and-seq-in-dotnet-11/) で、この記事が読み取る対象のファイルシンク設定を紹介しています。

## 参考資料

- [dotnet/runtime の `StreamReader.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/StreamReader.cs): `FileShare.Read` を使うパスのコンストラクターと、ストリーム終端での `flush: true` によるデコード。
- [dotnet/runtime の `SafeFileHandle.Unix.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/Microsoft/Win32/SafeHandles/SafeFileHandle.Unix.cs): `FileShare` の `LOCK_SH` / `LOCK_EX` によるエミュレーションと `System.IO.DisableFileLocking` スイッチ。
- [serilog-sinks-file の `FileSink.cs`](https://github.com/serilog/serilog-sinks-file/blob/main/src/Serilog.Sinks.File/Sinks/File/FileSink.cs): Serilog がログファイルを開く方法。
- [Microsoft Learn の `FileShare` 列挙型](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileshare)。
- [Microsoft Learn の `Decoder.GetChars`](https://learn.microsoft.com/en-us/dotnet/api/system.text.decoder.getchars): `flush` パラメーターを含みます。
- [dotnet/runtime issue 48757](https://github.com/dotnet/runtime/issues/48757): NFS でのファイルロックと `DOTNET_SYSTEM_IO_DISABLEFILELOCKING`。
