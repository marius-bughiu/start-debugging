---
title: ".NET でファイルの書き込みが完了したことを検知する方法"
description: "FileSystemWatcher は書き込み側が終わる前に Changed を発火します。.NET 11 でファイルが完全に書き込まれたことを知るための信頼できる 3 つのパターン: FileShare.None でオープンする、サイズの安定化でデバウンスする、そして問題そのものを回避するプロデューサー側の rename トリックです。"
pubDate: 2026-04-29
tags:
  - "dotnet"
  - "dotnet-11"
  - "filesystem"
  - "io"
  - "csharp"
lang: "ja"
translationOf: "2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet"
translatedBy: "claude"
translationDate: 2026-04-29
---

`FileSystemWatcher` はファイルが「完了した」ことを教えてくれません。OS が変更を観測したことを教えてくれるだけです。Windows では各 `WriteFile` 呼び出しが `Changed` イベントを発火し、`Created` はファイルが現れた瞬間に発火します。多くの場合、まだ 1 バイトも書き込まれていません。信頼できるパターンは次のとおりです: (1) `FileShare.None` でファイルを開こうとし、`IOException` 0x20 / 0x21 を「まだ書き込み中」として扱い、バックオフしながらリトライする、(2) `FileInfo.Length` と `LastWriteTimeUtc` をポーリングし、両方が連続した 2 サンプルで安定するまで待つ、または (3) プロデューサーと協調し、`name.tmp` に書いてから `File.Move` で最終的な名前にする。これは同じボリューム上で原子的です。パターン 3 だけがレースコンディションなしに正しく動作します。パターン 1 と 2 は、プロデューサーを制御できない場合に生き延びるための方法です。

この記事は .NET 11 (preview 4) と Windows / Linux / macOS を対象としています。下記の `FileSystemWatcher` のセマンティクスはどのプラットフォームでも .NET Core 3.1 以降変わっておらず、協調的な rename トリックは POSIX と NTFS で同じです。

## なぜ素朴なアプローチが間違っているのか

素朴なコードは次のように見え、あまりにも多くの場所で本番稼働しています:

```csharp
// .NET 11 -- BROKEN, do not ship
var watcher = new FileSystemWatcher(@"C:\inbox", "*.csv");
watcher.Created += (_, e) =>
{
    var rows = File.ReadAllLines(e.FullPath); // throws IOException
    Process(rows);
};
watcher.EnableRaisingEvents = true;
```

`Created` は OS がディレクトリエントリの存在を報告した時点で発火します。書き込み側プロセスは 1 バイトも flush していない可能性があります。Windows ではファイルが `FileShare.Read` で開かれている場合があり (この場合、読み取りは部分ファイルを返します)、または `FileShare.None` で開かれている場合があります (この場合、読み取りは `IOException: The process cannot access the file because it is being used by another process`、HRESULT `0x80070020`、win32 error 32 をスローします)。Linux ではデフォルトで強制ロックがないため、ほぼ常に部分読み取りになります。半分の CSV を黙って処理することになります。

`Changed` はもっと厄介です。プロデューサーの書き込み方によっては、`WriteFile` 呼び出しごとに 1 イベントが発生する場合があり、4 KB ブロックで書き込まれた 1 MB のファイルは 256 イベントを発火します。どれもライターが終わったことを教えてくれません。`WriteFileLastTimeIPromise` のような通知は存在しません。カーネルは書き込み側の意図を知らないからです。

3 つ目の問題: 多くのコピーツール (Explorer、`robocopy`、rsync) はまず隠しのテンポラリ名で書き込み、その後リネームします。テンポラリの `Created`、続いて最終ファイルの `Renamed` が見えます。これらのケースで反応すべきは `Renamed` イベントですが、`FileSystemWatcher.NotifyFilter` のデフォルトは .NET 11 で `LastWrite` を除外しており、一部のプラットフォームでは `FileName` を除外しているため、明示的にオプトインする必要があります。

## パターン 1: FileShare.None で開きバックオフする

プロデューサーを制御できない場合、唯一の観測チャネルは「ファイルを排他的に開けるか」です。プロデューサーは書き込み中、開いたハンドルを保持しています。ハンドルを閉じれば、排他オープンが成功します。これは Windows、Linux、macOS で機能します (Linux は `flock` 経由でアドバイザリロックを提供しますが、通常の `FileStream` のロックなしオープンセマンティクスで十分です。書き込み側がいなくなったことを確認するためだけに読み取るからです)。

```csharp
// .NET 11, C# 14
using System.IO;

static async Task<FileStream?> WaitForFileAsync(
    string path,
    TimeSpan timeout,
    CancellationToken ct)
{
    var deadline = DateTime.UtcNow + timeout;
    var delay = TimeSpan.FromMilliseconds(50);

    while (DateTime.UtcNow < deadline)
    {
        try
        {
            return new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.None);
        }
        catch (IOException ex) when (IsSharingViolation(ex))
        {
            await Task.Delay(delay, ct);
            delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, 1000));
        }
        catch (UnauthorizedAccessException)
        {
            // ACL problem, not a sharing problem -- do not retry
            throw;
        }
    }
    return null;
}

static bool IsSharingViolation(IOException ex)
{
    // ERROR_SHARING_VIOLATION = 0x20, ERROR_LOCK_VIOLATION = 0x21
    var hr = ex.HResult & 0xFFFF;
    return hr is 0x20 or 0x21;
}
```

3 つの細かいポイント:

- **`Exception` ではなく `IOException` をキャッチする**。`UnauthorizedAccessException` (ACL) と `FileNotFoundException` (プロデューサーが中断してファイルを削除した) は別のバグであり、リトライすべきではありません。
- **`HResult` を検査する**。.NET Core 以降では、`IOException.HResult` は Windows では `0x8007xxxx` でラップされた標準的な win32 エラーで、同じ数値コードがランタイムの変換層を通じて POSIX システムでも公開されます。共有違反は `0x20`、ロック違反は `0x21` です。メッセージ文字列でマッチしないでください -- ローカライズされています。
- **上限付きの指数バックオフ**。プロデューサーが詰まる場合 (ネットワークアップロード、遅い USB)、50 ミリ秒間隔のポーリングは無駄に CPU を使います。1 秒で打ち切ることで、高速書き込みのレイテンシを損なわずにワーカーを静かに保てます。

このパターンは特定のケースで失敗します: プロデューサーが `FileShare.Read | FileShare.Write` で開く場合 (バグのあるアップローダーがそうします)。書き込みの途中で排他オープンが成功し、ゴミを読むことになります。これが疑われる場合は、パターン 1 とパターン 2 を組み合わせてください。

## パターン 2: サイズの安定化によるデバウンス

ファイルロックに頼れない場合 (一部の Linux プロデューサー、一部の SMB シェア、一部のカメラのダンプ)、サイズと `LastWriteTimeUtc` をポーリングします。経験則: 妥当な間隔で 2 回連続のポーリングでサイズが変わらなければ、ライターは恐らく終わっています。

```csharp
// .NET 11, C# 14
static async Task<bool> WaitForStableSizeAsync(
    string path,
    TimeSpan pollInterval,
    int requiredStableSamples,
    CancellationToken ct)
{
    var fi = new FileInfo(path);
    long lastSize = -1;
    DateTime lastWrite = default;
    int stable = 0;

    while (stable < requiredStableSamples)
    {
        await Task.Delay(pollInterval, ct);
        fi.Refresh(); // FileInfo caches; Refresh forces a fresh stat call
        if (!fi.Exists) return false;

        if (fi.Length == lastSize && fi.LastWriteTimeUtc == lastWrite)
        {
            stable++;
        }
        else
        {
            stable = 0;
            lastSize = fi.Length;
            lastWrite = fi.LastWriteTimeUtc;
        }
    }
    return true;
}
```

書き込み側について分かっていることに基づいて `pollInterval` を選びます:

- ローカルの高速ディスク、小さいファイル: 100 ミリ秒、2 サンプル。
- 100 Mb リンク経由のネットワークアップロード: 1 秒、3 サンプル。
- USB / SD カード / SMB: 2 秒、3 サンプル (ファイルシステムのキャッシングが瞬間的な完了を覆い隠すことがあります)。

落とし穴は `FileInfo.Refresh()` です。これがないと、`FileInfo.Length` は `FileInfo` を構築したときにキャッシュされた値を返し、ループは永遠に回ります。コンパイラの警告はありません。よくあるサイレントバグです。

本番ではパターン 1 と組み合わせてください: サイズが安定するまでポーリングし、その後、最終確認として排他オープンを試みます。この組み合わせは行儀のよいプロデューサーと悪いプロデューサーの両方を扱えます。

## パターン 3: プロデューサーが協調する -- 書いてから rename する

書き込み側を制御できるなら、何も検知する必要はありません。`final.csv.tmp` に書き、fsync し、閉じて、`final.csv` にリネームします。コンシューマーの `FileSystemWatcher` は `Renamed` (または最終拡張子の `Created`) を観測して反応します。同じ NTFS または ext4 ボリュームでは、`File.Move` は原子的です: 宛先は完全なペイロードで存在するか、まったく存在しないかのいずれかです。

```csharp
// .NET 11, C# 14 -- producer side
static async Task WriteAtomicallyAsync(
    string finalPath,
    Func<Stream, Task> writeBody,
    CancellationToken ct)
{
    var tmpPath = finalPath + ".tmp";

    await using (var fs = new FileStream(
        tmpPath,
        FileMode.Create,
        FileAccess.Write,
        FileShare.None,
        bufferSize: 81920,
        useAsync: true))
    {
        await writeBody(fs, ct);
        await fs.FlushAsync(ct);
        // FlushAsync flushes the .NET buffer; FlushToDisk forces fsync.
        // For most use cases FlushAsync + closing the handle is enough,
        // because Windows Cached Manager and the Linux page cache will
        // serialize the rename after the writes. If you must survive a
        // crash mid-write, also call:
        //   fs.Flush(flushToDisk: true);
    }

    // File.Move with overwrite=true uses MoveFileEx with MOVEFILE_REPLACE_EXISTING
    // on Windows and rename(2) on POSIX. Both are atomic on the same volume.
    File.Move(tmpPath, finalPath, overwrite: true);
}
```

2 つの非自明なルール:

- **同じボリューム**。原子的なリネームは 1 つのファイルシステム内でのみ機能します。テンポラリを `C:\temp\x.tmp` に書いて `D:\inbox\x.csv` にリネームすると、裏ではコピーアンドデリートになり、コンシューマーは確実にコピーの途中で掴みます。常に宛先ディレクトリに `.tmp` をステージングしてください。
- **同じ拡張子ファミリ**。watcher のフィルタが `*.csv` でプロデューサーが `x.csv.tmp` を作る場合、watcher はテンポラリファイルでは発火しません。これが望みです。watcher のフィルタが `*` の場合、テンポラリの `Created` イベントを受け取ります。ハンドラ内で `.tmp` で終わるものを無視してください。

これは Git が ref の更新に使うのと同じパターン、SQLite がジャーナルに使うのと同じパターン、原子的な設定リローダー (nginx、HAProxy) が使うのと同じパターンです。理由があります。プロデューサーを変更できるなら、これを採用して読むのを止めてください。

## FileSystemWatcher への正しい接続

ハンドラは軽量で、キューに委ねるべきです。`FileSystemWatcher` はスレッドプールスレッド上でイベントを発火し、小さな内部バッファ (Windows ではデフォルト 8 KB) を持ちます。ハンドラ内でブロックするとバッファがあふれ、`InternalBufferOverflowException` を持つ `Error` イベントが発生し、イベントが静かに失われます。

```csharp
// .NET 11, C# 14
using System.IO;
using System.Threading.Channels;

var channel = Channel.CreateUnbounded<string>(
    new UnboundedChannelOptions { SingleReader = true });

var watcher = new FileSystemWatcher(@"C:\inbox")
{
    Filter = "*.csv",
    NotifyFilter = NotifyFilters.FileName
                 | NotifyFilters.LastWrite
                 | NotifyFilters.Size,
    InternalBufferSize = 64 * 1024, // 64 KB, max is 64 KB on most platforms
};

watcher.Created += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.Renamed += (_, e) => channel.Writer.TryWrite(e.FullPath);
watcher.EnableRaisingEvents = true;

// Dedicated consumer
_ = Task.Run(async () =>
{
    await foreach (var path in channel.Reader.ReadAllAsync())
    {
        if (path.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
        if (!await WaitForStableSizeAsync(path, TimeSpan.FromMilliseconds(250), 2, default))
            continue;
        await using var fs = await WaitForFileAsync(path, TimeSpan.FromSeconds(30), default);
        if (fs is null) continue;
        await ProcessAsync(fs);
    }
});
```

このコードで人々が引っ掛かる 3 つの点:

- **`InternalBufferSize`**。デフォルトの 8 KB は実際のワークロードには小さすぎます。プラットフォームの最大値 (Windows では 64 KB、Linux の inotify バックエンドは `/proc/sys/fs/inotify/max_queued_events` から取得) まで上げてください。コストは決して気付くことのないプロセスメモリです。
- **`NotifyFilter`**。.NET 11 のデフォルトは `LastWrite | FileName | DirectoryName` ですが、macOS の kqueue バックエンドは一部のフラグを無視します。サイズのみの変更 (メタデータ変更なしで `WriteFile` を使うライター) でイベントを発火させるには、`Size` を明示的にオプトインしてください。
- **`Channel<T>` は watcher とコンシューマーを切り離します**。コンシューマーが 1 ファイルの処理に 5 秒かかり、その間に 100 イベントが届く場合、watcher はすぐに戻り、channel がバッファリングします。[このようなプロデューサー / コンシューマーの分離で Channels が BlockingCollection を上回る理由](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) を参照してください。

## ファイルがネットワーク共有上にある場合

SMB と NFS には独自のタイミングがあります。Windows での UNC パスへの `FileSystemWatcher` は共有に対して `ReadDirectoryChangesW` を使いますが、イベントは SMB リダイレクタによって統合されます。1 GB のファイルが連続的に書かれていても、`Changed` イベントは 1 分に 1 回しか見えないことがあります。パターン 1 と 2 は依然として機能しますが、`pollInterval` を 5-10 秒のオーダーに設定すべきです。100 ミリ秒ごとにリモートの `FileInfo.Length` をポーリングするとポーリングごとにメタデータラウンドトリップが発生し、リンクを飽和させます。

NFS はもっと厄介です: `inotify` は他のクライアントで行われた変更には発火せず、ローカルプロセスがローカルマウントに加えた変更にのみ発火します。コンシューマーがホスト A に、プロデューサーがホスト B にあって NFS 経由で書き込む場合、`FileSystemWatcher` は何も見えません。解決策はポーリングのみ -- タイマー上で `Directory.EnumerateFiles` を実行し、各新規エントリにパターン 1 と 2 を適用します。ここで救ってくれるカーネルの通知パスはありません。

## よくあるエッジケース

- **プロデューサーが切り詰めて同じ場所に再書き込みする**。`FileSystemWatcher` は新しい内容が落ちたときに 1 つの `Changed` イベントを発火します。パターン 2 の安定サイズチェックは正しくこれを処理します。サイズは再書き込みが完了してから初めて安定するからです。パターン 1 はファイルが空である truncate ウィンドウ中、短時間成功する可能性があります。ドメインで最小期待サイズが分かっているなら、それと組み合わせてください。
- **作成後にアンチウィルスがファイルをロックする**。Defender (Windows) と多くのエンタープライズ AV 製品はファイルが現れた時点でスキャンのために開き、`FileShare.Read` を数十から数百ミリ秒保持します。パターン 1 のリトライループはこれを透過的に吸収します。ただ、タイムアウトを 100 ミリ秒に設定しないでください。
- **ファイルを作成したプロセスがクラッシュする**。`Created`、場合によっては `Changed` が見え、その後何もありません。パターン 2 の安定サイズチェックは、それ以上書き込みが起きないため、ポーリングウィンドウの後で true を返します。そして部分的なファイルを処理することになります。プロデューサーが協調する (パターン 3) か、最後にプロデューサーが触れるセンチネルファイル (`final.csv.done`) を用意してください。
- **複数のファイルが連動して書かれる** (例: `data.csv` と `data.idx`)。プライマリではなく、セカンダリファイルの出現を監視してください。プロデューサーはデータの後にインデックスを書く責任があるので、インデックスの出現はデータの完成を意味します。

## 関連する読み物

- [ASP.NET Core からファイルをバッファリングなしでストリームする](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) は、ファイルが完成したことを確認した後の読み取り側を扱います。
- [大きな CSV を OOM なしで読む](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) は、受信箱のファイルが大きい場合の自然な続編です。
- [長時間タスクをデッドロックなしでキャンセルする](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) は、上記の待機ループにシャットダウンを尊重させたいときに当てはまります。
- [BlockingCollection の代わりに Channels](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) は watcher とワーカーの間の正しいトランスポートです。

## 出典

- [`FileSystemWatcher` リファレンス、MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) -- プラットフォームノートのセクションが最も有用です。
- [`File.Move(string, string, bool)` MS Learn](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.move) -- .NET Core 3.0 で追加された原子的リネームのオーバーロードを文書化しています。
- [Win32 `MoveFileEx` ドキュメント](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa) -- `File.Move(overwrite: true)` が使う基盤プリミティブです。
- [`ReadDirectoryChangesW` API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) -- `InternalBufferOverflowException` に変換されるバッファオーバーフローの条件を説明しています。
