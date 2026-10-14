---
title: "FileSystemWatcher とポーリングの比較: .NET でネットワーク共有上のファイル変更を検出する"
description: "SMB や NFS の共有では、ポーリングが信頼できる情報源であり、FileSystemWatcher はせいぜいヒントにすぎません。FileSystemWatcher は Linux と macOS ではリモートの変更を見逃し、ネットワーク上の 64 KB バッファーであふれ、接続が切れると完全に停止します。定期的なスナップショットの差分を使い、ウォッチャーは早めのスキャンを促すだけにしてください。.NET 10.0.10 で検証済みです。"
pubDate: 2026-10-14
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "csharp"
  - "filesystem"
  - "io"
lang: "ja"
translationOf: "2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-14
---

監視するフォルダーがネットワーク共有上にあるなら、ポーリングの勝ちです。ディレクトリのスナップショットを定期的に取り、前回のものと差分を取ってください。これは、あらゆる OS ですべての変更を検出でき、切断から復旧でき、挙動を推論しやすい唯一の方法です。`FileSystemWatcher` は SMB と通信する Windows クライアントでは今も役に立ちますが、それは次のスキャンを早めるヒントとしてだけです。ファイルが到着したことを知る唯一の経路にしてはいけません。

以下の内容はすべて、.NET 10 に含まれる `System.IO.FileSystemWatcher` と `Microsoft.Extensions.FileProviders.Physical` (コードは .NET 10.0.10、SDK 10.0.302、C# 14 で実行しました) および .NET 11 のリリース候補に当てはまります。関連するソースは .NET Core 3.1 以降、意味のある変更がないため、.NET 8 と 9 でも同じ助言が通用します。

## 比較の概要

| | 共有上の `FileSystemWatcher` | スナップショットのポーリング |
| --- | --- | --- |
| Windows クライアント、SMB 2/3 共有 | 動作します。`ReadDirectoryChangesW` がサーバーに転送されます | 動作します |
| Linux クライアント、CIFS または NFS マウント | ローカルマシンによる変更だけが見えます | 動作します |
| macOS クライアント、SMB または NFS マウント | 実際にはローカルの変更だけが見えます | 動作します |
| レイテンシ | 動作する場合は 1 秒未満 | ポーリング間隔に、クライアントのメタデータキャッシュ (Windows SMB では最大 10 秒、NFS では最大 60 秒) を加えたもの |
| 変更の集中 | ネットワークパスではバッファーが 64 KB に制限され、オーバーフローすると詳細がすべて失われます | 影響なし。次の差分が最終状態を見ます |
| 接続の切断 | `Error` イベントが発生し、`EnableRaisingEvents` が `false` になったまま戻りません | スキャンが失敗し、次の周期で再試行します |
| オフライン中に行われた変更 | 失われます | 最初に成功したスキャンで検出されます |
| 変更がないときのコスト | ほぼゼロ | 間隔ごとにディレクトリ一覧を 1 回取得 |
| *何が* 変わったかを伝えられるか | はい、イベントごとに | はい、スナップショットの差分で |

"ウォッチャー"列のすべての行には注意書きが付きますが、"ポーリング"列の行には付きません。この非対称性が議論のすべてです。

## ネットワーク共有で FileSystemWatcher が壊れやすい理由

`FileSystemWatcher` は OS が提供する機能の薄いラッパーです。Windows では `ReadDirectoryChangesW`、Linux では `inotify`、macOS では FSEvents を使います。これらはいずれもローカルのファイルシステムを前提に設計されています。ローカルでは、すべての書き込みがカーネルを通るため、カーネルがすべての書き込みを把握できます。ネットワーク共有はこの前提を崩します。

**Linux と macOS では、リモートの書き込みは見えません。** `inotify` は、ローカルのカーネルがファイルに対して操作を行ったときに発火します。別のマシンが同じ NFS エクスポートや SMB 共有に書き込んでも、自分のカーネルはその書き込みを処理しないため、イベントは生成されません。得られるのは自分のプロセスの書き込みに対するイベントだけで、他者の書き込みについては何も得られません。Linux カーネル開発者の J. Bruce Fields は [LWN の議論](https://lwn.net/Articles/757833/)で率直に述べています。他のクライアントによる変更をクライアント側の通知で知るには "very chatty" なプロトコルが必要になりますが、NFS にはそれがありません。CIFS マウントでも同じです。利用側が Linux コンテナーで動いていて、書き込み側が共有にファイルを置く Windows マシンの場合、`FileSystemWatcher` は永遠に沈黙したままです。

**Windows では、64 KB の上限が問題になります。** SMB 2 または SMB 3 サーバーに接続する Windows クライアントは、実際にリモートの通知を受け取れます。リダイレクターがサーバーに `CHANGE_NOTIFY` リクエストを送り、サーバーは何かが変わったときに応答します。しかし [`ReadDirectoryChangesW` のドキュメント](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)には、バッファー長が 64 KB を超え、かつアプリケーションがネットワーク越しのディレクトリを監視している場合、この呼び出しは "fails with ERROR_INVALID_PARAMETER" と明記されています。[`FileSystemWatcher` のドキュメント](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher)でも同じ制限が繰り返されています。既定の `InternalBufferSize` は 8 KB で、各 `FILE_NOTIFY_INFORMATION` レコードは 12 バイトに UTF-16 のファイル名を加えた大きさです。したがって 40 文字のファイル名なら、8 KB には約 90 件、64 KB には約 700 件のイベントが収まります。1 秒間に 2,000 ファイルを置くバッチジョブは、どちらのサイズでもオーバーフローさせます。

バッファーがあふれると、OS はバッチ全体を破棄します。`ReadDirectoryChangesW` は 0 バイトで成功を返し、ランタイムはそれを `InternalBufferOverflowException` ("Too many changes at once in directory") を伴う `Error` イベントに変換します。何かを見逃したことは分かりますが、何を見逃したかは分かりません。

**Windows では、接続が切れるとウォッチャーが無効になります。** これが午前 3 時の障害の原因になります。[`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs) にある `ReadDirectoryChangesCallback` の該当部分は次のとおりです。

```csharp
// dotnet/runtime main, System.IO.FileSystem.Watcher (unchanged since .NET Core 3.x)
if (errorCode != 0)
{
    const int ERROR_OPERATION_ABORTED = 995;
    if (errorCode != ERROR_OPERATION_ABORTED)
    {
        EnableRaisingEvents = false;
        OnError(new ErrorEventArgs(new Win32Exception((int)errorCode)));
    }
    return;
}
```

ファイルサーバーが再起動したとき、VPN が一瞬切れたとき、SMB セッションがタイムアウトしたときには、保留中の読み取りが `ERROR_NETNAME_DELETED` (64、"The specified network name is no longer available") のようなエラーで完了します。ウォッチャーは `Error` を 1 回発生させ、`EnableRaisingEvents = false` に設定し、自力では二度と復旧しません。誰も `Error` を購読していなければ、プロセスは動き続け、健全に見えるのに、何も処理しません。また、UNC パスで 64 KB を超えるバッファーを指定した場合のような初期の失敗も、同じ形で現れることに注意してください。つまり `EnableRaisingEvents = true` のセッターからの例外ではなく、`Error` イベントとして現れます。

## 無言の失敗を再現する最小のコード

"ウォッチャーが動かなくなった"という質問の大半に登場するのが、このコードです。

```csharp
// .NET 10, C# 14 -- the naive version. Do not ship this against a share.
using var watcher = new FileSystemWatcher(@"\\fileserver\drop", "*.csv");
watcher.Created += (_, e) => Process(e.FullPath);
watcher.EnableRaisingEvents = true;

Console.ReadLine();

static void Process(string path) => Console.WriteLine($"Got {path}");
```

Windows で実行して共有にファイルを置くと、動作します。ファイルサーバーを再起動するか、ネットワークケーブルを 1 分間抜くと、以後は永久に何も出力されなくなり、例外もログも出ません。`/mnt/drop` を CIFS でマウントした Linux コンテナーで同じコードを実行すると、同じコンテナー内からファイルを作らない限り、何も出力されません。

## ポーリングを正しく行う

ポーリングの評判が悪いのは、実装が悪いからです。ディレクトリを列挙し、すべてのファイルを開き、内容を比較してしまうのです。良いポーリングは、各エントリの名前、サイズ、最終書き込み時刻を取得するディレクトリ一覧を 1 回だけ取得し、前回の一覧と比較します。

.NET でそれを最も安価に実現する方法は、`System.IO.Enumeration` の `FileSystemEnumerable<T>` です。ファイルごとに `FileInfo` を割り当てることなく、各 `FileSystemEntry` を必要なタプルへ直接射影できます。Windows では、`Length` と `LastWriteTimeUtc` はディレクトリ列挙のデータ自体 (`FindFirstFileEx` など) から得られるため、SMB 越しでも一覧全体の取得は、ファイルごとの往復ではなく数回の `QUERY_DIRECTORY` のやり取りで済みます。Linux と macOS では、`readdir` は名前しか返さないため、各エントリに追加の `stat` が必要になりますが、CIFS や NFS のクライアントは通常、これを属性キャッシュから返します。

スキャンの CPU コストの下限を把握するため、以下の完全な実装から `TakeSnapshot` メソッドを取り出し、Apple M4 (macOS 26.6、.NET 10.0.10、Release ビルド、3 回のウォームアップ後に 20 回の平均) 上のローカル APFS ディレクトリで計測しました。

| ディレクトリ内のファイル数 | スキャン 1 回あたりの時間 | スキャン 1 回あたりの割り当て |
| --- | --- | --- |
| 1,000 | 1.8 ms | 0.29 MB |
| 10,000 | 20.5 ms | 2.83 MB |
| 50,000 | 93.1 ms | 13.39 MB |

ネットワーク越しでは、これらの数値はレイテンシと一覧のサイズに応じて増えますが、全体の形は同じで、間隔ごとに一覧を 1 回取得するだけです。数千ファイルのドロップフォルダーを 5 秒から 30 秒ごとにポーリングしても、誰も負荷に気づきません。50 万ファイルを毎秒ポーリングすれば気づきますが、その場合の答えはフォルダーの分割 (日ごと、または書き込み側ごとにサブフォルダーを作る) であり、ウォッチャーへの切り替えではありません。

## ハイブリッド: ポーリングを真実とし、ウォッチャーをヒントにする

本番で通用する設計は、両者を組み合わせたものです。

1. スナップショット (`path -> (length, lastWriteUtc)`) をメモリに保持します。
2. 一定の間隔で再スキャンし、スナップショットとの差分を取ります。`Created`、`Changed`、`Deleted` を発行するのは、このコードパスだけです。
3. `FileSystemWatcher` を開始できる場合は、そのイベントのいずれかでスキャンループを早めに起こします。SMB と通信する Windows クライアントでは、一般的なケースで 1 秒未満のレイテンシが得られます。
4. ウォッチャーの `Error` (オーバーフローまたは切断) が発生したら、ウォッチャーを破棄し、再スキャンを強制し、次の周期で再作成を試みます。
5. 共有に到達できずスキャン自体が失敗した場合は、古いスナップショットを保持し、次の周期で再試行します。障害は "すべてのファイルが削除された" ことと同じではありません。

完全な実装は次のとおりです。.NET 10 と .NET 11 でそのまま動作します。

```csharp
// .NET 10 / .NET 11, C# 14
using System.IO.Enumeration;

public enum ShareChangeKind { Created, Changed, Deleted }

public readonly record struct ShareChange(ShareChangeKind Kind, string Path);

public readonly record struct FileStamp(long Length, DateTime LastWriteUtc);

public sealed class ShareWatcher : IAsyncDisposable
{
    private readonly string _root;
    private readonly TimeSpan _reconcileInterval;
    private readonly Action<ShareChange> _onChange;
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly CancellationTokenSource _cts = new();
    private Dictionary<string, FileStamp> _snapshot = new(StringComparer.OrdinalIgnoreCase); // SMB is case-insensitive
    private volatile FileSystemWatcher? _watcher; // swapped from the Error callback
    private Task? _loop;

    public ShareWatcher(string root, TimeSpan reconcileInterval, Action<ShareChange> onChange)
    {
        _root = root;
        _reconcileInterval = reconcileInterval;
        _onChange = onChange;
    }

    public void Start()
    {
        // Baseline: whatever exists now is not a change.
        _snapshot = TakeSnapshot(_root) ?? _snapshot;
        TryStartWatcher();
        _loop = Task.Run(() => LoopAsync(_cts.Token));
    }

    private async Task LoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            // Wake on the reconcile timer OR early when the watcher hints at a change.
            try { await _wake.WaitAsync(_reconcileInterval, ct); }
            catch (OperationCanceledException) { return; }

            // Small settle delay so a burst of hints becomes one scan.
            try { await Task.Delay(250, ct); }
            catch (OperationCanceledException) { return; }

            Reconcile();

            if (_watcher is null) TryStartWatcher();
        }
    }

    private void Reconcile()
    {
        var current = TakeSnapshot(_root);
        if (current is null)
        {
            // Share unreachable. Keep the old snapshot: an outage is not "every file was deleted".
            return;
        }

        foreach (var (path, stamp) in current)
        {
            if (!_snapshot.TryGetValue(path, out var old))
                _onChange(new(ShareChangeKind.Created, path));
            else if (old != stamp)
                _onChange(new(ShareChangeKind.Changed, path));
        }

        foreach (var path in _snapshot.Keys)
        {
            if (!current.ContainsKey(path))
                _onChange(new(ShareChangeKind.Deleted, path));
        }

        _snapshot = current;
    }

    private static Dictionary<string, FileStamp>? TakeSnapshot(string root)
    {
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = false,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };

        try
        {
            // Length and LastWriteTimeUtc come from the directory listing itself on Windows,
            // so this is one QUERY_DIRECTORY exchange per batch, not one round trip per file.
            // The constructor opens the directory, so it must sit inside the try.
            var entries = new FileSystemEnumerable<KeyValuePair<string, FileStamp>>(
                root,
                (ref FileSystemEntry e) => new(
                    e.ToFullPath(),
                    new FileStamp(e.Length, e.LastWriteTimeUtc.UtcDateTime)),
                options)
            {
                ShouldIncludePredicate = (ref FileSystemEntry e) => !e.IsDirectory,
            };

            var result = new Dictionary<string, FileStamp>(StringComparer.OrdinalIgnoreCase);
            foreach (var (path, stamp) in entries) result[path] = stamp;
            return result;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private void TryStartWatcher()
    {
        try
        {
            var w = new FileSystemWatcher(_root)
            {
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                IncludeSubdirectories = false,
                InternalBufferSize = 64 * 1024, // hard ceiling for network paths
            };
            w.Created += (_, _) => Hint();
            w.Changed += (_, _) => Hint();
            w.Deleted += (_, _) => Hint();
            w.Renamed += (_, _) => Hint();
            w.Error += (_, e) => OnWatcherError(w, e.GetException());
            w.EnableRaisingEvents = true;
            _watcher = w;
        }
        catch (Exception ex) when (ex is IOException or ArgumentException or UnauthorizedAccessException)
        {
            // Share offline or path gone. Polling keeps running; we retry on the next pass.
            _watcher = null;
        }
    }

    private void OnWatcherError(FileSystemWatcher w, Exception ex)
    {
        // Overflow or a dropped connection: either way, events were lost.
        // Throw the watcher away, force a full rescan, and rebuild on the next pass.
        if (ReferenceEquals(_watcher, w)) _watcher = null;
        w.Dispose();
        Hint();
    }

    private void Hint()
    {
        try { _wake.Release(); }
        catch (SemaphoreFullException) { /* a scan is already pending */ }
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        if (_loop is not null) await _loop;
        _watcher?.Dispose();
        _cts.Dispose();
        _wake.Dispose();
    }
}
```

ワーカーやコンソールアプリからの使い方は次のとおりです。

```csharp
// .NET 10 / .NET 11, C# 14
await using var watcher = new ShareWatcher(
    @"\\fileserver\drop",
    reconcileInterval: TimeSpan.FromSeconds(15),
    onChange: c => Console.WriteLine($"{c.Kind}: {c.Path}"));

watcher.Start();
await Task.Delay(Timeout.Infinite);
```

これをローカルディレクトリで、再照合間隔を 3 秒にして試しました。ファイルの作成、追記、削除は、いずれも操作の約 265 ms 後に報告されました (ウォッチャーのヒントに 250 ms の待機遅延を加えた時間です)。障害を模擬するためにディレクトリを 4 秒間移動させている間は何も報告されず、復旧後に作成されたファイルは次の周期で報告されました。削除として誤って報告されたものはありませんでした。

注目すべき設計上の選択がいくつかあります。

- **起床シグナルとしての `SemaphoreSlim(0, 1)`** は、任意の数のヒントを 1 回の保留中スキャンにまとめます。`SemaphoreFullException` の catch が、まとめる処理そのものであり、エラー経路ではありません。
- **250 ms の待機遅延** により、ヒントの集中 (2,000 ファイルのバッチ) が 2,000 回ではなく 1 回のスキャンになります。
- **`_onChange` はスキャンループ上で** 1 回に 1 つずつ実行されます。処理が遅い場合は、変更を `Channel<ShareChange>` に渡し、別のコンシューマーに処理させてください。そうすれば、遅いハンドラーが次のスキャンを遅らせません。
- **隠しファイルとシステムファイルはスキップされる**ため、`Thumbs.db`、`desktop.ini`、macOS クライアントが残す `.DS_Store` ファイルが除外されます。

## ポーリングでも解決しない落とし穴

**クライアントのメタデータキャッシュが、意図しないレイテンシを加えます。** Windows の SMB クライアントは、ディレクトリ一覧とファイルのメタデータをキャッシュします。[ファイルサーバーのチューニングガイド](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/)によると、`DirectoryCacheLifetime` と `FileInfoCacheLifetime` の既定値は 10 秒、`FileNotFoundCacheLifetime` の既定値は 5 秒です (すべて `HKLM\System\CurrentControlSet\Services\LanmanWorkstation\Parameters` 配下)。SMB 3 のディレクトリリースによって状況はさらに変わります。Linux では、`mount.cifs` は既定で属性を 1 秒間キャッシュし (`actimeo`)、NFS クライアントは既定でディレクトリ属性を 30 秒から 60 秒キャッシュします (`acdirmin`/`acdirmax`、[`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html) を参照)。実質的なレイテンシは、ポーリング間隔にキャッシュの有効期間を加えたものです。それより速くしたい場合は、ポーリング間隔ではなくマウントオプションを調整してください。

**"新しいファイル" は "完成したファイル" を意味しません。** どちらの仕組みも、ファイルが現れたことを伝えるだけで、書き込み側が完了したことは伝えません。ネットワーク越しにコピーされる 2 GB のファイルは、コピーが始まった瞬間に一覧に現れます。選択肢については [how to detect when a file finishes being written to](/ja/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) で詳しく扱いました。最も堅牢なのは、書き込み側が一時的な名前で書き込み、最後にリネームする方法です。上記のハイブリッドでは、スタンプが 2 回のスキャンにわたって変化しなかった場合にだけファイルを準備完了とみなす、という方法も使えます。

**タイムスタンプを保持するコピーは、変更なしに見えます。** 既定の `/COPY:DAT` を使う `robocopy`、`cp -p`、`rsync -t` はいずれも、コピー元の最終書き込み時刻を保持します。同じサイズのファイルで置き換えられた場合、`(Length, LastWriteUtc)` のスタンプは変わりません。それが問題になる場合は、Windows では作成日時を、小さなファイルではコンテンツのハッシュを追加するか、書き込み側にバージョンごとに新しい名前で書き込むよう依頼してください。

**クライアントとサーバーの間の時計のずれ。** 読み取る最終書き込み時刻はサーバーのタイムスタンプです。スタンプは同じ共有から得た他のスタンプとだけ比較し、自分のマシンの `DateTime.UtcNow` とは決して比較しないでください。ファイルサーバーの時計がずれていると、"過去 5 分以内に変更された" というロジックは気づかないうちに壊れます。

**大文字と小文字の区別。** SMB 共有は大文字と小文字を区別しないため、スナップショットの辞書には `StringComparer.OrdinalIgnoreCase` を使っています。大文字と小文字を区別するファイルシステムの NFS エクスポートでは `StringComparer.Ordinal` に切り替えてください。そうしないと、大文字小文字だけが異なる 2 つのファイルが 1 つのエントリにまとまってしまいます。

**Docker Desktop のコンテナーのバインドマウント。** Windows や macOS 上の Linux コンテナーにホストのフォルダーをバインドマウントした場合にも、同じ規則が当てはまります。ホストからの変更通知は信頼できないため、ここでもポーリングが唯一の安全な既定です。

## 共有上の設定リロード: DOTNET_USE_POLLING_FILE_WATCHER

関心のある "ファイル変更" が `reloadOnChange: true` を指定した `appsettings.json` や、`PhysicalFileProvider` の他の利用者によるものであれば、上記のコードは必要ありません。`PhysicalFileProvider` はコンストラクターで環境変数 `DOTNET_USE_POLLING_FILE_WATCHER` を読み取ります。

```bash
# .NET 8, 9, 10, 11: switches PhysicalFileProvider to polling
export DOTNET_USE_POLLING_FILE_WATCHER=1
```

`1` または `true` を指定すると、`UsePollingFileWatcher` と `UseActivePolling` の両方が設定され、`FileSystemWatcher` はまったく作成されず、監視対象の各ファイルの `LastWriteTimeUtc` がタイマーで確認されます。間隔は `PhysicalFilesWatcher.DefaultPollingInterval` で、4 秒に固定されています。コードでプロバイダーごとに有効にすることもできます。

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);

var provider = new PhysicalFileProvider(@"\\fileserver\config")
{
    UsePollingFileWatcher = true,
    UseActivePolling = true,
};

builder.Configuration.AddJsonFile(provider, "appsettings.shared.json",
    optional: false, reloadOnChange: true);
```

同じ注意点が当てはまります。比較するのは最終書き込み時刻だけなので、タイムスタンプを保持するコピーは検出できず、SMB のメタデータキャッシュにより 4 秒の間隔の上にさらに最大 10 秒が加わることがあります。リロードが発火した後の下流の動作については、[`IOptionsMonitor` の比較記事](/ja/2026/08/ioptions-vs-ioptionssnapshot-vs-ioptionsmonitor-in-dotnet-11/)で扱っています。

## 推奨事項のまとめ

SMB 共有、NFS エクスポート、バインドマウント上のどのフォルダーでも、ポーリングによるスナップショットの差分を唯一の信頼できる情報源として使ってください。レイテンシの許容範囲から間隔を決め、そこにクライアントのメタデータキャッシュの有効期間を加えます。Windows で動かしていて低レイテンシが必要なら、ポーラーを早めに起こすだけの `FileSystemWatcher` を追加し、その `InternalBufferSize` は 64 KB までに抑え、`Error` イベントはすべて "再スキャンして再構築する" 合図として扱ってください。素の `FileSystemWatcher` が許容されるのはローカルディスクだけで、その場合でも `Error` は購読すべきです。

## 関連記事

- [How to detect when a file finishes being written to in .NET](/ja/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) は、"現れたが未完成" という問題のもう半分を扱っています。
- [How to tail a log file in C# while another process is writing to it](/ja/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) は、単一の増え続けるファイルに対して同じ"ポーリング優先"の考え方を使っています。
- [Why FileInfo.Length returns a stale size on Windows](/ja/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) は、ディレクトリ一覧のメタデータが実際のファイルより遅れうる理由を説明しています。
- [Thread.Sleep vs Task.Delay vs SpinWait](/ja/2026/10/thread-sleep-vs-task-delay-vs-spinwait-for-waiting-in-csharp/) は、ポーリングループがスリープではなく await を使う理由を説明しています。
- [Channels instead of BlockingCollection](/ja/2026/04/how-to-use-channels-instead-of-blockingcollection-in-csharp/) は、スキャンループから遅いコンシューマーへ変更を渡すための記事です。

## 出典

- [`FileSystemWatcher` class, remarks on buffer size and network paths](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher) (Microsoft Learn)
- [`ReadDirectoryChangesW` function](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw) (Microsoft Learn)
- [`FileSystemWatcher.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Windows.cs) と [`FileSystemWatcher.Linux.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.IO.FileSystem.Watcher/src/System/IO/FileSystemWatcher.Linux.cs) (dotnet/runtime)
- [`PhysicalFileProvider.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFileProvider.cs) と [`PhysicalFilesWatcher.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Microsoft.Extensions.FileProviders.Physical/src/PhysicalFilesWatcher.cs) (dotnet/runtime)
- [`FileSystemEnumerable<TResult>`](https://learn.microsoft.com/en-us/dotnet/api/system.io.enumeration.filesystemenumerable-1) (Microsoft Learn)
- [Performance tuning for file servers, SMB client cache settings](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server/) (Microsoft Learn)
- [`nfs(5)`](https://man7.org/linux/man-pages/man5/nfs.5.html) と [`mount.cifs(8)`](https://man7.org/linux/man-pages/man8/mount.cifs.8.html) の man ページ
- [J. Bruce Fields on NFS change notification (LWN comment)](https://lwn.net/Articles/757833/)
