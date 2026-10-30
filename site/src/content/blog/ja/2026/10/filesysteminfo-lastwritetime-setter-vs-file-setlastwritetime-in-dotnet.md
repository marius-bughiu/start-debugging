---
title: ".NET における FileSystemInfo.LastWriteTime セッターと File.SetLastWriteTime の違い"
description: "どちらも最終的には同じ OS 呼び出しに行き着くため、書き込まれるタイムスタンプは同一です。違いはその周辺にあります。どのキャッシュが無効化されるか、Windows でディレクトリを扱えるか、UTC 以外の DateTime がどう変換されるか、開いているハンドルを対象にできるか、です。File.SetLastWriteTimeUtc を使い、ファイルが開いている場合はハンドル経由で設定してください。.NET 10.0.10 で検証済みです。"
pubDate: 2026-10-30
template: vs
tags:
  - "comparison"
  - "dotnet"
  - "dotnet-10"
  - "csharp"
  - "filesystem"
  - "io"
lang: "ja"
translationOf: "2026/10/filesysteminfo-lastwritetime-setter-vs-file-setlastwritetime-in-dotnet"
translatedBy: "claude"
translationDate: 2026-10-30
---

`File.SetLastWriteTimeUtc` (フォルダーの場合は `Directory.SetLastWriteTimeUtc`) を使ってください。まだ書き込み中のファイルに時刻を設定する場合は、`SafeFileHandle` オーバーロードを使います。`FileInfo.LastWriteTimeUtc` セッターを使うのは、すでにその `FileInfo` を保持していて、後でそのプロパティを再度読む場合だけにしてください。そのインスタンスのキャッシュも更新するのはセッターだけだからです。どちらの経路も内部の同じ `FileSystem.SetLastWriteTime` を呼び出すため、ディスクに届くビットは同一です。違うのは、その呼び出しの周辺のすべてです。どちらの場合でも、`...Utc` メンバーには `Kind = Utc` の `DateTime` を渡し、UTC ではない側のメンバーにローカル時刻や Unspecified の時刻を渡すことは避けてください。

以下はすべて、macOS 27 (APFS) 上の .NET 10.0.10 (SDK 10.0.302、C# 14) で、ローカルタイムゾーンが `Europe/Bucharest` (テスト日は UTC+2) のマシンで実行しました。Windows の挙動は dotnet/runtime の `release/10.0` ブランチから引用しています。関連するコードは、ハンドルオーバーロードが追加された .NET 7 以降ほとんど変わっていないため、同じルールが .NET 8、9、そして .NET 11 プレビューにも当てはまります。

## 比較の概要

| | `fileInfo.LastWriteTimeUtc = t` | `File.SetLastWriteTimeUtc(path, t)` |
| --- | --- | --- |
| OS 呼び出し (Windows) | `SetFileInformationByHandle(FileBasicInfo)` | 同じ |
| OS 呼び出し (Unix) | `utimensat(..., AT_SYMLINK_NOFOLLOW)` | 同じ |
| キャッシュが無効化される対象 | その `FileInfo` インスタンスのみ | なし (キャッシュを持たない) |
| 同じパスを指す他の `FileInfo` オブジェクト | `Refresh()` するまで古いまま | `Refresh()` するまで古いまま |
| Windows でディレクトリを対象にする場合 | `DirectoryInfo` 経由のみ | 失敗します。`Directory.SetLastWriteTimeUtc` を使います |
| 開いている `SafeFileHandle` を受け取る | いいえ | はい (.NET 7 以降) |
| UTC+ のタイムゾーンで、ローカル時刻のセッターに `DateTime.MinValue` を渡した場合 | 暗黙のうちに丸められます | `ArgumentOutOfRangeException` をスローします |
| ファイルが存在しない場合 | `FileNotFoundException` | `FileNotFoundException` |
| 1 回あたりのコスト (1 万回、APFS、M4) | 10.4 us | 10.7 us (ハンドル経由: 8.6 us) |

## 2 つの API が実際に行っていること

公開されている表面を取り除くと、両者は 1 か所で合流します。以下は `FileSystemInfo.cs` と `FileSystemInfo.Windows.cs` にある `FileSystemInfo` 側です。

```csharp
// dotnet/runtime release/10.0, System.Private.CoreLib
public DateTime LastWriteTime
{
    get => LastWriteTimeUtc.ToLocalTime();
    set => LastWriteTimeUtc = value.ToUniversalTime();
}

public DateTime LastWriteTimeUtc
{
    get => LastWriteTimeCore.UtcDateTime;
    set => LastWriteTimeCore = File.GetUtcDateTimeOffset(value);
}

internal DateTimeOffset LastWriteTimeCore   // Windows
{
    set
    {
        FileSystem.SetLastWriteTime(FullPath, value, (this is DirectoryInfo));
        _dataInitialized = -1;   // invalidate this instance's cache
    }
}
```

そして `File` 側です。

```csharp
// dotnet/runtime release/10.0, File.cs
public static void SetLastWriteTime(string path, DateTime lastWriteTime)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), lastWriteTime, false);

public static void SetLastWriteTimeUtc(string path, DateTime lastWriteTimeUtc)
    => FileSystem.SetLastWriteTime(Path.GetFullPath(path), GetUtcDateTimeOffset(lastWriteTimeUtc), false);
```

末尾の `false` は `asDirectory` フラグで、Windows では重要になります (詳細は後述します)。Unix では、`FileInfo` セッターは独自の `FileStatus` 構造体を経由し、`File` は使い捨ての `default(FileStatus)` を使いますが、どちらも同じ `SetAccessOrWriteTimeCore` を呼び出します。このメソッドはまずファイルを再度 stat して現在のアクセス時刻をそのまま書き戻せるようにし、次に `AT_SYMLINK_NOFOLLOW` 付きで `utimensat` を呼び出し、最後にステータスキャッシュを無効化します。Windows では、どちらも `FILE_WRITE_ATTRIBUTES` でパスを開き、`LastWriteTime` 以外のすべてのフィールドをゼロにした `FILE_BASIC_INFO` を指定して `SetFileInformationByHandle` を呼び出します。ゼロは Windows では"変更しない"と解釈されます。

つまり、"`FileInfo` セッターは遅延される"あるいは"メモリ上のオブジェクトだけを変更する"という挙動は存在しません。これはよくある思い込みです。セッターも静的メソッドと同様に、直ちにディスクへ書き込みます。

## キャッシュの無効化: 実際に遭遇する違い

`FileSystemInfo` は読み取ったものをすべてキャッシュします。最初のプロパティアクセスでファイルを stat し、以降のアクセスは `Refresh()` が呼ばれるまでスナップショットを返します。セッターが無効化するのは、呼び出したインスタンスのキャッシュだけで、それ以外は無効化しません。次のプローブで 3 つのケースがすべて確認できます。

```csharp
// .NET 10.0.10, C# 14 - run with: dotnet run probe.cs
var path = Path.Combine(Path.GetTempPath(), "a.txt");
File.WriteAllText(path, "hello");
var target = new DateTime(2020, 1, 2, 3, 4, 5, DateTimeKind.Utc);

var fi1 = new FileInfo(path);
var fi2 = new FileInfo(path);
_ = fi1.LastWriteTimeUtc; _ = fi2.LastWriteTimeUtc; // populate both caches

fi1.LastWriteTimeUtc = target;
Console.WriteLine(fi1.LastWriteTimeUtc.ToString("O")); // 2020-01-02T03:04:05.0000000Z
Console.WriteLine(fi2.LastWriteTimeUtc.ToString("O")); // 2026-10-30T12:04:26.3262150Z (stale)
fi2.Refresh();
Console.WriteLine(fi2.LastWriteTimeUtc.ToString("O")); // 2020-01-02T03:04:05.0000000Z

var fi3 = new FileInfo(path); _ = fi3.Length;          // snapshot now
File.SetLastWriteTimeUtc(path, target.AddYears(1));
Console.WriteLine(fi3.LastWriteTimeUtc.ToString("O")); // 2020-01-02... (stale)
Console.WriteLine(File.GetLastWriteTimeUtc(path).ToString("O")); // 2021-01-02...
```

これがセッターを選ぶ唯一の実質的な理由です。メソッドが `FileInfo` を受け取ってタイムスタンプを設定し、その後に呼び出し元が `fileInfo.LastWriteTime` をログに出したり別のファイルと比較したりする場合、セッターを使えばそのオブジェクトの値が正しく保たれます。同じ場所で `File.SetLastWriteTimeUtc(fileInfo.FullName, t)` を呼ぶと、呼び出し元には古い値が残り、このバグは誰かがもう一度プロパティを読んだときにしか表に出ません。その方法を取る場合は、後に `fileInfo.Refresh()` を追加してください。

逆も同様に重要です。セッターは他の `FileInfo` インスタンスには影響しません。`DirectoryInfo.EnumerateFiles` から得られたインスタンスも含まれます。それらは列挙中に値が埋められ、そのまま固定されます。同じスナップショットの挙動が、書き込み中のファイルについて `FileInfo.Length` が実際とずれる原因でもあり、これについては [Windows で FileInfo.Length が古いサイズを返す理由](/ja/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) で詳しく扱いました。

## ディレクトリ: File.SetLastWriteTime の Windows 限定の落とし穴

`File.SetLastWriteTime` は常に `asDirectory: false` を渡します。Windows では、このフラグによって `OpenHandleToWriteAttributes` が `CreateFile` 呼び出しに `FILE_FLAG_BACKUP_SEMANTICS` を追加するかどうかが決まります。

```csharp
// dotnet/runtime release/10.0, FileSystem.Windows.cs
int dwFlagsAndAttributes = Interop.Kernel32.FileOperations.FILE_FLAG_OPEN_REPARSE_POINT;
if (asDirectory)
{
    dwFlagsAndAttributes |= Interop.Kernel32.FileOperations.FILE_FLAG_BACKUP_SEMANTICS;
}
```

[`CreateFile` のドキュメント](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) には、ディレクトリへのハンドルを取得するには `FILE_FLAG_BACKUP_SEMANTICS` を設定する必要があると明記されています。そのため、Windows では `File.SetLastWriteTimeUtc(@"C:\data\folder", t)` はアクセス拒否エラーで失敗します。`DirectoryInfo.LastWriteTimeUtc = t` は `this is DirectoryInfo` を渡すので動作し、`Directory.SetLastWriteTimeUtc` も同様に動作します。

Linux と macOS では、このフラグはパスが存在しない場合にスローされる例外の型にしか影響しないため、ディレクトリに対する同じ `File` 呼び出しも成功します。APFS でプローブを実行して確認しました。Linux ランナー上の CI は通るのに、開発者の Windows ノート PC で失敗する、まさにその種のコードです。ファイルとフォルダーのどちらも受け取る可能性がある場合は、`Directory.Exists` で分岐して対応する静的クラスを呼び出すか、適切な `FileSystemInfo` サブタイプを生成してください。

関連する奇妙な点があります。`new FileInfo(directoryPath).Exists` は `false` ですが、Unix では `new FileInfo(directoryPath).LastWriteTimeUtc = t` は成功してディレクトリにタイムスタンプを設定します。これに頼らないでください。

## ローカル時刻と UTC: 2 つの経路が端の値で分かれる場所

UTC ではないメンバーは、2 つの API が対称ではなくなる場所です。`File.SetLastWriteTime(string, DateTime)` は `DateTime` をそのまま `DateTimeOffset` パラメーターに渡すため、`DateTime` から `DateTimeOffset` への暗黙の変換が実行されます。一方、`FileInfo.LastWriteTime` セッターは代わりに `value.ToUniversalTime()` を呼び出します。通常の日付では両者は一致し、どちらも `DateTimeKind.Unspecified` をローカル時刻として扱います。

```text
File.SetLastWriteTime(Unspecified 12:00)    -> 09:00Z   (treated as local, UTC+3 in June)
File.SetLastWriteTimeUtc(Unspecified 12:00) -> 12:00Z   (treated as UTC)
File.SetLastWriteTime(Utc-kind 03:04:05Z)   -> 03:04:05Z (Kind honoured)
fi.LastWriteTime = Unspecified 12:00        -> 09:00Z
fi.LastWriteTimeUtc = Local-kind 12:00      -> 09:00Z   (Local converted, not reinterpreted)
```

端の値では挙動が異なります。UTC より東のタイムゾーンでは、`DateTime.MinValue` に対応する有効な UTC 値がありません。`ToUniversalTime()` は黙って `DateTime.MinValue` に丸めますが、`DateTimeOffset` への暗黙の変換は拒否します。

```csharp
// .NET 10.0.10, Europe/Bucharest (UTC+2)
File.SetLastWriteTime(path, DateTime.MinValue);
// ArgumentOutOfRangeException: The UTC time represented when the offset is applied
// must be between year 0 and 10,000. (Parameter 'offset')

new FileInfo(path).LastWriteTime = DateTime.MinValue; // no exception here
```

UTC より西では、`DateTime.MaxValue` が同様にスローされます。これらの値を意図的に使うことはないでしょうが、"デフォルトにリセットする"コードパスや未初期化のフィールドが、思いのほか頻繁にこれらの値を持ち込みます。

変換を通過できたからといって、その値が保存可能とは限りません。Windows の `FILETIME` は 1601 年から始まり、それより前の値では `DateTimeOffset.ToFileTime()` が `ArgumentOutOfRangeException: Not a valid Win32 FileTime.` をスローするため、Windows では `DateTime.MinValue` に対してどちらの API もスローします。APFS は 1970 年からのナノ秒数を符号付き 64 ビット整数で保持するため、macOS で"成功"した `DateTime.MinValue` の書き込みは `1677-09-21T00:12:43.1452241Z`、つまり APFS が表現できる最も早い時刻になります。どちらも意図した結果ではありません。どちらの API を呼ぶ前にも、範囲を自分で検証してください。

夏時間も、`...Utc` メンバーを使い続けるもう 1 つの理由です。秋に時計が戻る時間帯のローカル時刻は曖昧で、`ToUniversalTime()` は何も知らせずに標準時の解釈を選びます。タイムスタンプが別のマシン、データベース、アーカイブのエントリーから来たものであれば、元々ほぼ確実に UTC でした。ディスクに届くまでずっとそのままにしてください。同じ助言は [JSON ペイロード内の `DateTime` 値](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) にも当てはまります。

## ハンドルオーバーロードと、開いているファイルがタイムスタンプを元に戻す理由

`File.SetLastWriteTime(SafeFileHandle, DateTime)` と `File.SetLastWriteTimeUtc(SafeFileHandle, DateTime)` は静的クラスにしかなく、.NET 7 で追加されました。すでに保持しているハンドルに対して `SetFileInformationByHandle` または `futimens` を呼び出すため、パスの検索と余分なオープンを省けます。

これらを使うより重要な理由は順序です。自分の `FileStream` にまだバッファー済みのバイトが残っている状態でタイムスタンプを設定するのは典型的なバグです。`Dispose` でそのバイトがフラッシュされるときに、OS が更新時刻をもう一度進めてしまうからです。

```csharp
// .NET 10.0.10, C# 14
using (var fs = new FileStream(p, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
{
    fs.Write(new byte[100]);               // sits in FileStream's 4 KB buffer
    File.SetLastWriteTimeUtc(p, target);
    // File.GetLastWriteTimeUtc(p) here: 2020-01-02T03:04:05Z
}
// File.GetLastWriteTimeUtc(p) here: 2026-10-30T12:04:26Z  <- your value is gone

using (var fs = new FileStream(p, FileMode.Create, FileAccess.Write, FileShare.ReadWrite))
{
    fs.Write(new byte[100]);
    fs.Flush();                            // all writes reach the OS first
    File.SetLastWriteTimeUtc(fs.SafeFileHandle, target);
}
// File.GetLastWriteTimeUtc(p) here: 2020-01-02T03:04:05Z  <- kept
```

ルールは"最後の書き込みが勝つ"です。タイムスタンプの設定が、ファイルに触れる最後の操作でなければなりません。フラッシュし、ハンドル経由で設定し、閉じる、という順序です。`using` ブロックの後でパス経由で設定してもうまくいきますが、2 回目のオープンが必要になり、別のプロセスがファイルを誤った時刻のまま見られる時間帯が生じます。コンシューマーが [ファイルの書き込み完了を監視](/ja/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) していたり、[ネットワーク共有に対するスナップショット比較方式](/ja/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/) のようにタイムスタンプをポーリングしていたりする場合、これは重要です。

`FileSystemInfo` にはハンドルベースの同等機能がないため、このパターンが必要な場合は、好みに関係なく `File` を使うことになります。

## シンボリックリンク、作成日時、精度

次の 3 点は両方の経路で同じですが、誤解されがちです。

- **シンボリックリンク**: Windows は `FILE_FLAG_OPEN_REPARSE_POINT` で開き、Unix は `AT_SYMLINK_NOFOLLOW` 付きで `utimensat` を呼び出すため、どちらの API もリンク自体にタイムスタンプを設定し、ターゲットには触れません。ターゲットに設定したい場合は、まず `FileSystemInfo.ResolveLinkTarget(returnFinalTarget: true)` で解決し、その結果に対して時刻を設定してください。
- **macOS の作成日時**: 更新時刻を作成時刻 (birth time) より前に設定すると、カーネルは作成時刻も合わせて前に戻します。.NET は macOS でこれを検出し、`setattrlist` で元の作成日時を復元するため、`LastWriteTime` を過去日付にしても `File.GetCreationTimeUtc` は変わりません。Linux には設定可能な birth time がなく、.NET は `ctime` と `mtime` のうち古い方を作成日時として報告します。
- **精度**: `DateTime` は 100 ns 単位のティックを持ちます。NTFS、APFS、ext4 はそのすべてを保持し (`...07.1234567Z` のラウンドトリップは完全に一致しました)、FAT32 は 2 秒単位に丸め、exFAT は 10 ms を保持します。バックアップや同期ツールなど、ボリューム間でタイムスタンプを比較する場合は、`==` ではなく許容誤差付きで比較してください。

どちらの API も、ファイルが存在しない場合は `FileNotFoundException` をスローします。これはゲッターとは非対称で、ゲッターはスローせずに `1601-01-01T00:00:00Z` を返します。そのため、時刻を読み、判断し、書き込むコードでは、2 つの呼び出しの間にファイルが消えて、無害に見えるメソッドから例外が出ることがあります。ファイルが同時に削除される可能性がある場合は、書き込みを `FileNotFoundException` の catch で囲んでください。

## 重要ではないベンチマーク

念のため記載します。ウォームな APFS ボリューム (Apple M4、.NET 10.0.10、Release、ループを `Stopwatch` で計測) で各 1 万回呼び出した結果、1 回あたり `File.SetLastWriteTimeUtc(path, t)` が 10.72 us、`FileInfo` セッターが 10.40 us、すでに開いているハンドルに対するハンドルオーバーロードが 8.60 us でした。パス経由の各バリアントは誤差の範囲で同等です。どれも stat と `utimensat` を行い、`FileInfo` 側ではさらにキャッシュのリセットを行うためです。ハンドルはパス解決の分だけ節約します。これらが選択の決め手になるべきではありません。数千のファイルにタイムスタンプを設定する場合は、各 set 呼び出し内の stat が支配的なので、API を切り替えるよりファイル単位で並列化する方がはるかに効果的です。

## 推奨事項のまとめ

デフォルトでは `File.SetLastWriteTimeUtc(path, utc)` と `Directory.SetLastWriteTimeUtc(path, utc)` を使ってください。対象がどの種類のエントリーかが明示的で、キャッシュされたオブジェクトが残ることがなく、ほとんどのタイムスタンプのバグの原因である"いま書いたファイルに設定する"場合のためのハンドルオーバーロードもあります。コード内で `FileInfo` が作業単位になっていて、誰かがそのプロパティを再度読む場合は `fileInfo.LastWriteTimeUtc = utc` に切り替えてください。そのインスタンスを同期した状態に保てるのはセッターだけだからです。両方とも UTC ではないメンバーは避け、書き込む前に、その値が対象ファイルシステムの範囲に収まっているかを検証してください。

## 関連記事

- [Windows で FileInfo.Length が古いサイズを返す理由](/ja/2026/10/fix-fileinfo-length-returns-stale-size-for-a-file-still-being-written-on-windows/) では、サイズの観点から同じ `FileSystemInfo` のキャッシュを掘り下げています。
- [.NET でファイルの書き込み完了を検出する方法](/ja/2026/04/how-to-detect-when-a-file-finishes-being-written-to-in-dotnet/) では、"最後の書き込みが勝つ"のコンシューマー側を扱っています。
- [ネットワーク共有における FileSystemWatcher とポーリングの比較](/ja/2026/10/filesystemwatcher-vs-polling-for-detecting-file-changes-on-a-network-share-in-dotnet/) は、ここで正しい設定方法を学んだタイムスタンプに依存しています。
- [別のプロセスが書き込み中のログファイルを tail する方法](/ja/2026/10/how-to-tail-a-log-file-in-csharp-while-another-process-is-writing-to-it/) では、上記のプローブで使った `FileShare` フラグを示しています。
- [dotnet run でファイルベースの C# アプリを実行する方法](/ja/2026/08/how-to-run-a-file-based-csharp-app-with-dotnet-run-in-dotnet-11/) は、`probe.cs` を自分で再実行したい場合に役立ちます。

## 参考資料

- [`FileSystemInfo.LastWriteTime`](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesysteminfo.lastwritetime) と [`File.SetLastWriteTimeUtc`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.setlastwritetimeutc) (Microsoft Learn)
- [`FileSystemInfo.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.cs)、[`FileSystemInfo.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystemInfo.Windows.cs)、[`File.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/File.cs) (dotnet/runtime)
- [`FileSystem.Windows.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileSystem.Windows.cs)、[`FileStatus.Unix.cs`](https://github.com/dotnet/runtime/blob/release/10.0/src/libraries/System.Private.CoreLib/src/System/IO/FileStatus.Unix.cs)、[`pal_time.c`](https://github.com/dotnet/runtime/blob/release/10.0/src/native/libs/System.Native/pal_time.c) (dotnet/runtime)
- [`CreateFileW`、`FILE_FLAG_BACKUP_SEMANTICS`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) と [`FILE_BASIC_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info) (Microsoft Learn)
- [`utimensat(2)`](https://man7.org/linux/man-pages/man2/utimensat.2.html) (Linux man pages)
- [ファイルシステムごとのファイル時刻と分解能](https://learn.microsoft.com/en-us/windows/win32/sysinfo/file-times) (Microsoft Learn)
