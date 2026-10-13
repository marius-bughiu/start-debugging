---
title: "修正: Windows で書き込み中のファイルに対して FileInfo.Length が古いサイズを返す"
description: "FileInfo はサイズをキャッシュし、列挙では NTFS が遅延更新するディレクトリエントリを読み、さらに書き込み側が自前のバッファーにバイトを保持していることもあります。Refresh() を呼ぶか、より確実には共有ハンドルから RandomAccess.GetLength で長さを読み取ってください。"
pubDate: 2026-10-13
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-10"
  - "dotnet-11"
  - "csharp"
  - "filesystem"
lang: "ja"
translationOf: "2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows"
translatedBy: "claude"
translationDate: 2026-10-13
---

`FileInfo.Length` が嘘をつく理由は3つあり、それらは重なって現れます。第一に、`FileInfo` は最初にいずれかのプロパティを読んだ時点でデータをキャッシュし、`Refresh()` を呼ぶまで再読み込みしません。第二に、Windows で `DirectoryInfo.EnumerateFiles` や `GetFiles` から得た `FileInfo` は NTFS のディレクトリエントリから値が設定されますが、NTFS はそのサイズのコピーを、書き込み側が最後のハンドルを閉じたときにしか更新しません。第三に、書き込み側のプロセスが自前の `StreamWriter` / `FileStream` のバッファーにバイトを保持したままの場合があり、その場合 OS は本当にまだそれを受け取っていません。確実な修正方法は、パスに問い合わせるのをやめてハンドルに問い合わせることです: `using var h = File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete); long size = RandomAccess.GetLength(h);`。書き込み側を自分で制御できるなら、フラッシュしてください。以下のバッファリングの数値は .NET 10.0.10 (SDK 10.0.302) と .NET 11 RC1 (SDK 11.0.100-rc.1.26425.128) で測定したもので、結果は同一でした。Windows 固有のコードパスは dotnet/runtime の `main` ブランチのソースから引用しています。

## 症状の具体例

例外はスローされません。バグ報告は通常、次のような形になります。

```
// what people see, .NET 10 / .NET 11 on Windows
size = 0          // the log file is clearly growing in Notepad++
size = 4096       // the writer has logged 6000 characters
size = 1048576    // Explorer says 1 MB, the copy job says 37 MB
```

パターンは常に同じです。監視ループ、アップロードジョブ、あるいは"ファイルの増加が止まるまで待つ"チェックが、別のプロセス (または別のスレッド) が書き込み用に開いているファイルの `FileInfo.Length` を読みます。その数値は遅れており、ときには固定されたままで、書き込み側がファイルを閉じた途端に正しい値へ跳ね上がります。Explorer や `dir` も同じ固定された数値を表示するため、問題は自分のコードではなく Windows にあると考えがちです。実際には両方に原因があります。

## なぜ起こるのか

3つの層があり、それぞれが単独で問題を引き起こす可能性があります。

**1. `FileInfo` はライブビューではなくスナップショットです。** `FileSystemInfo` は内部に `WIN32_FILE_ATTRIBUTE_DATA` 構造体と `_dataInitialized` フラグを持っています。最初のプロパティアクセスでそれが設定され、以降のアクセスはキャッシュされた値を返します。[`FileInfo.Length` のドキュメント](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length)にもはっきり書かれています。インスタンスが `GetFiles` や `EnumerateFiles` から得られた場合、値はあらかじめキャッシュされており、最新の値を得るには `Refresh` を呼ぶ必要があります。細かい点ですが、設定は遅延されます。`new FileInfo(path)` を構築してもディスクには触れないため、"スナップショットの時刻"とは、コードが最初に `Length`、`Exists`、またはいずれかのタイムスタンプを読んだ時点であり、思っているよりずっと前であることがよくあります。

**2. 列挙はディレクトリエントリを読み、NTFS はそれを遅延更新します。** Windows では、`FileSystemEnumerator` が `FileFullDirectoryInformation` を指定して `NtQueryDirectoryFile` を呼び出し、`FileSystemInfo.Init(FILE_FULL_DIR_INFORMATION*)` が `EndOfFile` をそのままキャッシュされたサイズにコピーします。この数値はファイル自体ではなく、ディレクトリインデックスから来ています。Raymond Chen が [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813) で説明しているように、NTFS はサイズをファイルのプロパティとして扱い、一覧表示の最適化としてのみディレクトリエントリに複製します。Windows Vista 以降、その複製はファイルオブジェクトへの最後のハンドルが閉じられたときに更新されます。ログを何時間も開いたままにする書き込み側は、ディレクトリエントリをファイルを開いた時点のサイズ (多くの場合 0) のままにします。これはまさに、Explorer、`dir`、`Directory.GetFiles` の結果に対する `new FileInfo(...)`、そしてカスタム `FileSystemEnumerable` 内の `FileSystemEntry.Length` が報告する値です。

**3. 書き込み側がまだバイトを書き込んでいません。** `StreamWriter` は文字を自前のバッファーに保持し、エンコードしたバイトを `FileStream` に渡します。`FileStream` もデフォルトで 4096 バイトの独自バッファーを持っています。バッファーが満杯になるか、誰かが `Flush()` を呼ぶまで、オペレーティングシステムは1バイトも受け取っていないため、どのプラットフォームのどの API も正しく古いサイズを報告します。この層は外から見ると他の2つと見分けがつかないため、多くの人が見落とします。

第4の層はネットワーク共有でのみ現れます。SMB クライアントのリダイレクターは、パスベースのクエリに対してファイルメタデータをキャッシュします。`FileInfoCacheLifetime` と `DirectoryCacheLifetime` は、現在の Windows ではどちらもデフォルトで10秒です ([Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server) を参照)。そのため、UNC パスでは `Refresh()` の後でも最大10秒前のサイズが表示されることがあります。

## 最小再現コード

このファイルベースアプリは、フラッシュせずに `StreamWriter` で書き込み、4通りの方法でサイズをサンプリングします。キャッシュされた `FileInfo`、`Refresh()` 後の同じ `FileInfo`、`RandomAccess.GetLength` による新しいハンドル、そしてディレクトリ列挙から得た `FileInfo` です。`dotnet run probe.cs` で実行します。

```csharp
// .NET 10 / .NET 11, C# 14, file-based app: dotnet run probe.cs
#:property PublishAot=false
using Microsoft.Win32.SafeHandles;

string path = Path.Combine(Path.GetTempPath(), "stale-probe.log");
File.Delete(path);

using var writer = new StreamWriter(new FileStream(path, FileMode.Create,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete));
var cached = new FileInfo(path);
Console.WriteLine($"start: cached={cached.Length}");   // first access: snapshot taken here

writer.Write(new string('a', 1000));
Report("after 1000 chars, no flush");
writer.Write(new string('a', 5000));
Report("after 6000 chars, no flush");
writer.Flush();
Report("after StreamWriter.Flush()");

var fromEnum = new DirectoryInfo(Path.GetTempPath())
    .EnumerateFiles("stale-probe.log").Single();
writer.Write(new string('b', 4000)); writer.Flush();
Console.WriteLine($"enumerated FileInfo (no Refresh) after +4000: {fromEnum.Length}");
fromEnum.Refresh();
Console.WriteLine($"enumerated FileInfo after Refresh: {fromEnum.Length}");

void Report(string label)
{
    long stale = cached.Length;
    cached.Refresh();
    long refreshed = cached.Length;
    using SafeFileHandle h = File.OpenHandle(path, FileMode.Open, FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);
    Console.WriteLine($"{label}: cached={stale} refreshed={refreshed} " +
        $"handle={RandomAccess.GetLength(h)} writer.BaseStream.Position={writer.BaseStream.Position}");
}
```

出力は .NET 10.0.10 と .NET 11.0.0 RC1 (macOS arm64、APFS) で同一でした。

```
start: cached=0
after 1000 chars, no flush: cached=0 refreshed=0 handle=0 writer.BaseStream.Position=0
after 6000 chars, no flush: cached=0 refreshed=4096 handle=4096 writer.BaseStream.Position=5120
after StreamWriter.Flush(): cached=4096 refreshed=6000 handle=6000 writer.BaseStream.Position=6000
enumerated FileInfo (no Refresh) after +4000: 6000
enumerated FileInfo after Refresh: 10000
```

1行ずつ読み解きます。

- 1000文字の時点では、何も OS に届いていません。`StreamWriter` がすべてを保持しているため、ハンドルでさえ 0 を返します。ここでは読み取り側の修正は役に立ちません。
- 6000文字の時点では、`StreamWriter` は 5120 文字 (1024 文字のチャンク5つ) を `FileStream` に渡し、`FileStream` は 4096 バイトのバッファー1つ分を OS に書き込んでいます。正直な API はすべて 4096 を返します。キャッシュされた `FileInfo` は依然として 0 を返します。
- `Flush()` の後、実際のサイズは 6000 です。キャッシュされた `FileInfo` は 4096 を返します。直前の `Report` 呼び出しで更新され、それ以降は誰も更新していないためです。
- 列挙された `FileInfo` は列挙時点で固定されており、追加された 4000 バイトを見るには `Refresh()` が必要でした。

macOS と Linux では、層1と層3がすべてです。`stat` は inode を読み、サイズの別個のディレクトリコピーは存在しないためです。Windows ではこれに層2が加わります。同じプログラムを Windows で実行し、待機中に Explorer でフォルダーを見ると、書き込み側が破棄されるまで、ディレクトリの一覧表示はハンドルの値より遅れたままになります。この記事のために Windows マシンでこちら側のベンチマークは行っていません。仕組みは Raymond Chen によって文書化されており、正確なコードパス (`NtQueryDirectoryFile` から `FileSystemInfo.Init`) は、末尾にリンクしたランタイムのソースで確認できます。

## 修正方法の詳細

直面している層に合った修正を選んでください。実際のコードでは、複数の層に当たっていることがほとんどです。

### 1. 推奨: パスではなくハンドルからサイズを読み取る

ハンドルベースのクエリは、NTFS が正式なファイル終端を保持している開いているファイルオブジェクトに対して行われます。これは Raymond Chen が正しいと述べている唯一の答え (ハンドルに対する `GetFileSize`) であり、`FileInfo` のキャッシュとディレクトリエントリの両方を回避します。.NET 6 以降は、`FileStream` なしでこれを行えます。

```csharp
// .NET 10 / .NET 11, C# 14
using Microsoft.Win32.SafeHandles;

static long GetLiveLength(string path)
{
    // FileShare.ReadWrite: the writer already holds write access, so we must allow it.
    // FileShare.Delete: do not break a writer that renames or deletes during rotation.
    using SafeFileHandle handle = File.OpenHandle(
        path,
        FileMode.Open,
        FileAccess.Read,
        FileShare.ReadWrite | FileShare.Delete);

    return RandomAccess.GetLength(handle);
}
```

`File.OpenHandle` と `RandomAccess.GetLength` の組み合わせは `new FileStream(...).Length` より軽量です。バッファーの割り当ても位置の追跡もなく、Windows では `RandomAccess.GetLength` がハンドルに対して `GetFileInformationByHandleEx(FileStandardInfo)` を呼び出し、`EndOfFile` を返します。すでにそのファイルに対して `FileStream` を開いている場合 (たとえば末尾を追跡している場合) は、そのストリームの `stream.Length` を使ってください。同じハンドルクエリを経由します。

ここにはもう1つキャッシュが隠れています。Windows では、`SafeFileHandle` はハンドルが読み取り専用で、かつ `FileShare.Write` なしで開かれた場合に `_lengthCanBeCached` を設定し、以降は最初に取得した長さを返し続けます。ハンドルが書き込み共有を拒否している間は誰もファイルに書き込めないため、これは正しい動作です。ただし、増え続けるファイルの監視には `FileShare.Read` を決して使うべきではないということでもあります。書き込み側がすでに動作中であれば、開く処理が失敗します。先に自分が開いた場合は書き込み側の open が失敗し、プロデューサーを壊してしまうのでさらに悪い結果になります。`FileShare.ReadWrite` (と `FileShare.Delete`) を使えば、ランタイムは呼び出しのたびに OS に問い合わせます。

共有モードは重要です。デフォルトの `FileShare.Read` で開くと、書き込み側がすでに書き込みアクセスを持っていて、こちらの共有モードがそれを許可しないため、`IOException: The process cannot access the file because it is being used by another process` で失敗します。このエラーは、ハンドル方式を諦めて `FileInfo` に戻ってしまう最も一般的な理由です。

知っておくと役立つ副作用があります。自分でハンドルを開いて閉じると、そのハンドルが閉じられたときに NTFS がディレクトリエントリも更新します (同じ Old New Thing の記事によります)。そのため、`GetLiveLength` を呼んだ後は、書き込み側が再び追記するまで、Explorer や列挙も追いつきます。

### 2. `FileInfo` を使う必要がある場合は、読む前に毎回 `Refresh()` を呼ぶ

ポーリングループでは、1つの `FileInfo` を保持し、反復ごとに更新します。

```csharp
// .NET 10 / .NET 11, C# 14
var fi = new FileInfo(path);
long last = -1;
while (!ct.IsCancellationRequested)
{
    fi.Refresh();                       // without this, Length never changes
    if (fi.Exists && fi.Length != last)
    {
        Console.WriteLine($"{fi.Length:N0} bytes");
        last = fi.Length;
    }
    await Task.Delay(TimeSpan.FromSeconds(1), ct);
}
```

Windows では、パスから構築した `FileInfo` に対する `Refresh()` は `FileSystem.FillAttributeInfo` を経由し、パスに対して `GetFileAttributesEx` を呼び出します。その呼び出しが `ERROR_SHARING_VIOLATION` や `ERROR_ACCESS_DENIED` のようなエラーで失敗した場合にのみ、`FindFirstFile` (ディレクトリエントリの読み取り) にフォールバックします。このフォールバックは `pagefile.sys` や削除保留中のファイルのために存在します。`GetFileAttributesEx` が開いているファイルの実際のサイズを常に反映するかどうかは Microsoft が文書化していないため、`Refresh()` は"層1を修正し、ローカル NTFS では層2もおそらく修正する"ものとして扱い、正確さが重要な場面ではハンドル方式を使ってください。

### 3. 開かれている可能性のあるファイルについて、列挙から得たサイズを信用しない

パスを返す `Directory.EnumerateFiles` は問題ありません。`FileInfo` オブジェクトを返す `DirectoryInfo.EnumerateFiles` と、`FileSystemEnumerable<T>` の transform 内の `FileSystemEntry.Length` は、ディレクトリエントリが持つサイズのコピーを再利用するからこそ高速です。そして、それは NTFS が遅延更新するコピーです。列挙は候補ファイルを見つけるために使い、必要な各ファイルには個別に問い合わせてください。

```csharp
// .NET 10 / .NET 11, C# 14
foreach (FileInfo fi in new DirectoryInfo(inbox).EnumerateFiles("*.csv"))
{
    long listed = fi.Length;          // directory-entry copy on Windows, may be stale
    long live = GetLiveLength(fi.FullName);
    if (listed != live)
        Console.WriteLine($"{fi.Name}: listing says {listed:N0}, handle says {live:N0}");
}
```

ファイルごとに open を行うと、メタデータの往復が数回発生します。これが Explorer がそうしない理由です。数千のファイルがあるフォルダーでは、新規のファイルや最近変更されたファイルだけに問い合わせてください。

### 4. 書き込み側を制御できるなら、フラッシュする (そしてフラッシュの意味を知る)

書き込み側のプロセスから出ていないバイトは、読み取り側のどんなトリックでも見えません。モニターが進捗を確認する必要があるなら、書き込み側がバイトを OS に渡さなければなりません。

```csharp
// .NET 10 / .NET 11, C# 14
using var log = new StreamWriter(new FileStream(path, FileMode.Append,
    FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
{
    AutoFlush = true    // every Write call pushes through StreamWriter and FileStream to the OS
};
```

`AutoFlush = true` は `Write` ごとに1回のシステムコールを必要とします。大量のログを出力するロガーでは、代わりにタイマーで、または論理レコードごとに `Flush()` を呼んでください。`Flush()` (`FileStream` の場合は `Flush(false)`) はバイトを OS キャッシュに渡し、他のプロセスが新しいサイズを見るにはそれで十分です。`FileStream.Flush(flushToDisk: true)` はさらに物理ディスクへの書き込みを強制します。これは可視性ではなく耐久性のためのもので、はるかに低速です。

### 5. ネットワーク共有では、SMB クライアントのキャッシュを考慮する

UNC パスに対する `Refresh()` は、SMB リダイレクターのファイル情報キャッシュから、最大 `FileInfoCacheLifetime` 秒 (デフォルトは10) の間応答される場合があります。修正1のようにハンドルを開くとサーバーに open リクエストが送られるため、ここでもそちらが適切な選択です。コードを変更できない場合は、クライアント側で `Set-SmbClientConfiguration -FileInfoCacheLifetime 0` を使って有効期間を短くできますが、そのマシン上のすべてのパスベースのメタデータクエリが遅くなります。修正ではなく、診断手段として扱ってください。

## 落とし穴と似た症状

**"ファイルが完成した"は別の問題です。** サイズが安定していても、書き込み側が終了した証拠にはなりません。単に一時停止しているだけかもしれません。本当に必要なのが"このファイルを今処理してよいか"であれば、完了時リネームのパターンか、排他オープンのプローブを使ってください。詳しくは [.NET でファイルの書き込み完了を検出する方法](/ja/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) を参照してください。

**新しく届いたバイトを読むこと**も別の問題です。そのためには、共有読み取りの `FileStream` を1つ開いたままにして `fs.Length` と `fs.Position` を比較します。方法は [別のプロセスが書き込み中のログファイルを C# で tail する方法](/ja/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) で紹介しています。その記事では、切り詰めやローテーションも扱っています。そこではサイズが小さくなることは"古い"ではなく"最初からやり直し"を意味します。

**`LastWriteTime` も同じ理由で古くなります。** ディレクトリエントリのタイムスタンプはサイズと同様に複製され、`FileInfo` は同じ構造体にそれをキャッシュします。上記のすべては `LastWriteTimeUtc` にも当てはまり、さらに NTFS 自身がタイムスタンプの更新を遅延させることもあります。タイムスタンプだけで増加を検出しないでください。

**事前割り当てされたファイル。** 一部の書き込み側 (データベース、ダウンロードマネージャー、`preallocationSize` を指定した `FileStream`、`SetLength` の呼び出し) は、最初にファイルを最終サイズまで拡張し、後から中身を埋めます。ハンドルは実際のファイル終端を報告しますが、それはすでに最終サイズです。この場合、"サイズが変わらない"ことは進捗について何も教えてくれません。書き込み側自身の進捗シグナルを使ってください。

**メモリマップト書き込み。** ファイルをマップしてビュー経由で書き込む書き込み側は、サイズを変えずに内容を変更し、ファイル終端はマッピング作成時に固定されています。サイズベースのポーリングでは、そうした書き込みをまったく検出できません。

**ハンドルを開くときの `IOException`。** 書き込み側が `FileShare.None` (`File.Create` / `File.OpenWrite` のデフォルト) でファイルを開いた場合、他のどの open も許可されず、`FileShare.ReadWrite` を指定したこちらの open も失敗します。その場合は、古い可能性のあるパスベースのサイズを読むか、書き込み側を変更するしかありません。この共有違反を捕捉することが、上記の関連記事にある"まだ書き込み中か"のプローブの基本です。

## 関連記事

- [.NET でファイルの書き込み完了を検出する方法](/ja/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) では、安定性のポーリング、排他オープンのプローブ、プロデューサー側のリネーム手法を扱っています。
- [別のプロセスが書き込み中のログファイルを C# で tail する方法](/ja/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) は、ローテーション処理を含むハンドルベースのリーダーの完全版です。
- [.NET 11 でメモリ不足にならずに大きな CSV を読み込む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) は、ファイルが完成して処理が必要になった後に役立ちます。
- [.NET 11 で dotnet run を使ってファイルベースの C# アプリを実行する方法](/ja/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) では、上記のプローブで使った `#:property` ディレクティブを説明しています。

## 参考資料

- Raymond Chen, [Why is the file size reported incorrectly for files that are still being written to?](https://devblogs.microsoft.com/oldnewthing/20111226-00/?p=8813), The Old New Thing.
- [`FileInfo.Length` property](https://learn.microsoft.com/en-us/dotnet/api/system.io.fileinfo.length) and [`FileSystemInfo.Refresh`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.refresh), Microsoft Learn.
- [`RandomAccess.GetLength`](https://learn.microsoft.com/en-us/dotnet/api/system.io.randomaccess.getlength) and [`File.OpenHandle`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.openhandle), Microsoft Learn.
- dotnet/runtime source: [`FileSystem.Attributes.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/Common/src/System/IO/FileSystem.Attributes.Windows.cs) (`FillAttributeInfo`), [`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs) (`Init` from `FILE_FULL_DIR_INFORMATION`), [`FileSystemEnumerator.Windows.cs`](https://github.com/dotnet/runtime/blob/main/src/libraries/System.Private.CoreLib/src/System/IO/Enumeration/FileSystemEnumerator.Windows.cs) (`NtQueryDirectoryFile`).
- [Performance tuning for file servers](https://learn.microsoft.com/en-us/windows-server/administration/performance-tuning/role/file-server), SMB client `FileInfoCacheLifetime` and `DirectoryCacheLifetime`.
