---
title: ".NET 11 の ZipArchive 非同期 API で ZIP ファイルを非同期に作成・展開する方法"
description: "ZipFile.CreateFromDirectoryAsync、ExtractToDirectoryAsync、ZipArchive.CreateAsync、ZipArchiveEntry.OpenAsync を、隠れた同期 I/O なしで使う方法を解説します。.NET 11 RC 1 と .NET 10.0.12 で計測し、今も Kestrel をブロックする .NET 10 のバグも取り上げます。"
pubDate: 2026-09-14
template: how-to
tags:
  - "dotnet-11"
  - "dotnet"
  - "csharp"
  - "aspnetcore"
  - "async"
lang: "ja"
translationOf: "2026/09/how-to-create-and-extract-zip-files-asynchronously-with-ziparchive-in-dotnet-11"
translatedBy: "claude"
translationDate: 2026-09-14
---

**結論:** フォルダー全体を扱うなら、`await ZipFile.CreateFromDirectoryAsync(dir, zipPathOrStream, ct)` と `await ZipFile.ExtractToDirectoryAsync(zipPathOrStream, dir, ct)` を呼び出します。エントリ単位で制御したい場合は、コンストラクターではなく `await ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding: null, ct)` でアーカイブを開き、エントリは `await entry.OpenAsync(ct)` で開き、エントリのストリームとアーカイブの両方を `await using` で破棄します。この 3 つの `await` のどれか 1 つでも抜けると、`System.IO.Compression` は黙って同期 I/O にフォールバックします。非同期 API は .NET 10 で導入されましたが、.NET 10 (10.0.12 でも同じ) では、`await using` を使っていてもエントリのストリームを破棄する際に同期書き込みが行われます。最初から最後まで非同期になるのは .NET 11 だけです (RC 1、`11.0.0-rc.1.26425.128` で計測)。

以下の内容はすべて Apple M4 上で 2 つのランタイムを対象に実行しました。.NET 10.0.12 (現行のサービスリリースで、SDK 10.0.302 でビルド) と .NET 11 RC 1 です。検証用のプローブは、対象のストリームを、同期的な `Read`、`Write`、`Flush` のたびに例外をスローする `Stream` でラップしています。これは Kestrel がリクエストとレスポンスのボディに課しているのと同じ制約なので、隠れた同期呼び出しは、気付かないうちにブロックされるスレッドとしてではなく、例外として表面化します。

## 非同期 API の全体像と、非同期コンストラクターが存在しない理由

この API は、corefx 時代に提出された要望 [dotnet/runtime#1541](https://github.com/dotnet/runtime/issues/1541) から生まれ、.NET 10 向けに [PR #114421](https://github.com/dotnet/runtime/pull/114421) で実装されました。[承認された API の形](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236) は当初の提案より小さく、その理由を知ると落とし穴のほとんどが説明できます。

- `ZipArchive` のコンストラクターは I/O を行います (読み取りモードでは end-of-central-directory レコードを読み込みます) が、コンストラクターは待機できません。そのため、静的ファクトリーの `ZipArchive.CreateAsync` が用意されています。
- `GetEntriesAsync` は存在しません。`CreateAsync` は戻る前にセントラルディレクトリを読み込むことになっているので、同期の `Entries` プロパティはすでにメモリ上にあるものを返すだけです。
- `CreateEntry` と `Delete` は I/O を行わないため、`CreateEntryAsync` や `DeleteAsync` は存在しません。
- 書き込み可能なアーカイブを破棄するとセントラルディレクトリが書き込まれるため、`ZipArchive` は `IAsyncDisposable` を実装しています。

同期呼び出しと非同期版の対応は次のとおりです (いずれも省略可能な `CancellationToken` を受け取ります)。

| 同期 | 非同期 (.NET 10+) |
| --- | --- |
| `new ZipArchive(stream, mode, ...)` | `ZipArchive.CreateAsync(stream, mode, leaveOpen, entryNameEncoding, ct)` |
| `archive.Dispose()` | `archive.DisposeAsync()` |
| `entry.Open()` | `entry.OpenAsync(ct)` |
| `ZipFile.Open` / `OpenRead` | `ZipFile.OpenAsync` / `OpenReadAsync` |
| `ZipFile.CreateFromDirectory` | `ZipFile.CreateFromDirectoryAsync` (パスまたは `Stream` の出力先) |
| `ZipFile.ExtractToDirectory` | `ZipFile.ExtractToDirectoryAsync` (パスまたは `Stream` の入力元) |
| `archive.CreateEntryFromFile` | `archive.CreateEntryFromFileAsync` |
| `archive.ExtractToDirectory` | `archive.ExtractToDirectoryAsync` |
| `entry.ExtractToFile` | `entry.ExtractToFileAsync` |

.NET 11 ではこれに加えてオーバーロードが増えています。`OpenAsync(ReadOnlySpan<char> password, ...)`、`OpenAsync(FileAccess, ...)`、パスワードと `ZipEncryptionMethod` を受け取る `CreateEntryFromFileAsync`、そしてディレクトリ用ヘルパーの `ZipFileCreationOptions` / `ZipExtractionOptions` オーバーロードです。これらはすべて、両方のランタイムで `System.IO.Compression` をリフレクションで調べて洗い出しました。パスワード関連については [.NET 11 の暗号化 ZIP に関する記事](/ja/2026/08/dotnet-11-preview-7-password-protected-zip-archives/) で扱っています。

## 完全に非同期にするための手順

1. エントリ単位の制御が不要なら、`ZipFile.*Async` のディレクトリ用ヘルパーを使います。
2. それ以外の場合は、`await ZipArchive.CreateAsync(...)` または `await ZipFile.OpenAsync(...)` でアーカイブを作成し、`new ZipArchive(...)` は決して使いません。
3. すべてのエントリを `await entry.OpenAsync(ct)` で開くか、`CreateEntryFromFileAsync` / `ExtractToFileAsync` を使います。
4. 各エントリのストリームは、アーカイブを破棄する前に `await using` で破棄します。
5. アーカイブは `await using` で破棄します。
6. 1 つの `CancellationToken` を全体に渡し、展開がキャンセルされたときにディスク上に何を残すかを決めておきます。

## フォルダー全体を圧縮・展開する

アーカイブがディレクトリをそのまま反映するなら、静的ヘルパーがすべてを処理します。

```csharp
// .NET 10+, C# 14 (tested on .NET 11 RC 1 and .NET 10.0.12)
using System.IO.Compression;

using var cts = new CancellationTokenSource(TimeSpan.FromMinutes(2));

// Folder -> .zip file
await ZipFile.CreateFromDirectoryAsync(
    "out/reports", "reports.zip",
    CompressionLevel.Optimal, includeBaseDirectory: false,
    cancellationToken: cts.Token);

// .zip file -> folder
await ZipFile.ExtractToDirectoryAsync(
    "reports.zip", "in/reports",
    overwriteFiles: true, cancellationToken: cts.Token);
```

どちらのヘルパーにも `Stream` のオーバーロードがあり、一時ファイルを使わずにネットワークストリームへ直接圧縮したり、アップロードされたファイルを展開したりできます。同期の `Stream` オーバーロードは [ZIP ファイルを Stream に書き出す .NET 8 の記事](/ja/2023/11/c-zip-files-to-stream/) で紹介しましたが、非同期版も同じ形にトークンが加わっただけです。

## エントリを 1 つずつ追加してアーカイブを作る

フィルター、名前の変更、コンテンツの生成が必要になったら、すぐに `ZipArchive` を直接使います。ここでは 3 つの `await` すべてが重要です。

```csharp
// .NET 11 RC 1, C# 14
using System.IO.Compression;
using System.Text;

static async Task WriteExportAsync(Stream destination, IEnumerable<string> files, CancellationToken ct)
{
    await using ZipArchive zip = await ZipArchive.CreateAsync(
        destination, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);

    // Files from disk, renamed and filtered
    foreach (string path in files.Where(f => !f.EndsWith(".tmp")))
    {
        await zip.CreateEntryFromFileAsync(
            path, $"data/{Path.GetFileName(path)}", CompressionLevel.Fastest, ct);
    }

    // Generated content
    ZipArchiveEntry manifest = zip.CreateEntry("manifest.txt", CompressionLevel.Optimal);
    await using (Stream s = await manifest.OpenAsync(ct))
    {
        await s.WriteAsync(Encoding.UTF8.GetBytes($"created={DateTime.UtcNow:O}\n"), ct);
    }
}
```

上の例のように、エントリのストリームは専用の `await using` ブロックにスコープを限定し、次のエントリを作成する前に破棄されるようにします。`Create` モードでは同時に開けるエントリは 1 つだけで、エントリのストリームを破棄すると最後の圧縮ブロックがフラッシュされ、エントリのサイズと CRC が書き込まれます。

読み取りも同じ要領です。`Entries` は普通のプロパティで、.NET 11 では `CreateAsync` の後に I/O を行うことはなくなりました。

```csharp
// .NET 11 RC 1, C# 14
await using ZipArchive zip = await ZipFile.OpenReadAsync("reports.zip", ct);

foreach (ZipArchiveEntry entry in zip.Entries)
{
    if (entry.FullName.EndsWith('/')) continue; // directory entry

    await using Stream source = await entry.OpenAsync(ct);
    await using FileStream target = new(
        Path.Combine("in", entry.Name), FileMode.Create, FileAccess.Write,
        FileShare.None, bufferSize: 81920, FileOptions.Asynchronous);
    await source.CopyToAsync(target, ct);
}
```

`entry.FullName` からパスを自分で組み立てて書き込む場合、`ExtractToDirectoryAsync` が代わりに行ってくれるパス検証も自分で引き受けることになります。ヘルパーは出力先ディレクトリの外に出てしまうエントリを拒否しますが、手書きのコードは `Path.Combine` が返したとおりに動きます。

## それぞれの `await` が実際に何をもたらすのか、計測結果

プローブの結果をまとめた表です。"例外" は、同期呼び出しを禁止しているストリームに対して、アーカイブのコードが少なくとも 1 回同期呼び出しを行ったことを意味します。行に特に記載がない限り、ストリームは Kestrel のボディと同様にシーク不可です。

| シナリオ | .NET 10.0.12 | .NET 11 RC 1 |
| --- | --- | --- |
| `new ZipArchive` (Create) + `Open()` + `using` | 例外 | 例外 |
| `CreateAsync` + `OpenAsync` + すべてで `await using` | **例外** | 動作 |
| 同上、ただしアーカイブに `using` | 例外 | 例外 |
| 同上、ただしエントリのストリームに `using` | 例外 | 例外 |
| `ZipFile.CreateFromDirectoryAsync(dir, stream)` | **例外** | 動作 |
| `new ZipArchive` (Read) | 例外 | 例外 |
| `CreateAsync` (Read) | 動作 | 動作 |
| `CreateAsync` (Read)、シーク可能なストリーム | **例外** | 動作 |
| `CreateAsync` (Read)、シーク可能、同期の `entry.Open()` | 例外 | 例外 |
| `ZipFile.ExtractToDirectoryAsync(stream, dir)` | 動作 | 動作 |
| シーク不可のストリームで `CreateAsync` (Update) | `ArgumentException` | `ArgumentException` |

ポイントは 2 つです。1 つ目に、.NET 11 で例外になる行は、どれも同期呼び出しを残したケースです。コンストラクター、読み取りモードでの `Open()`、あるいは普通の `using` です。`Dispose()` は圧縮データをフラッシュしてセントラルディレクトリを書き込む必要がありますが、それを非同期に行うことはできません。2 つ目に、太字の行は .NET 10 のバグであり、あなたのミスではありません。

## .NET 10 のバグ: `await using` でも同期的に書き込まれる

.NET 10 では、作成モードで `OpenAsync` が返す内部の `WrappedStream` が `DisposeAsync` をオーバーライドしていません。基底の `Stream.DisposeAsync` は `Dispose()` を呼び出すため、その下のチェーン全体が同期的に破棄され、`DeflateStream` は最後のブロックを同期の `Write` でフラッシュします。.NET 10.0.12 のプローブで得たスタックは次のとおりです。

```text
at System.IO.Compression.DeflateStream.PurgeBuffers(Boolean disposing)
at System.IO.Compression.DeflateStream.Dispose(Boolean disposing)
at System.IO.Compression.CheckSumAndSizeWriteStream.Dispose(Boolean disposing)
at System.IO.Compression.ZipArchiveEntry.DirectToArchiveWriterStream.Dispose(Boolean disposing)
at System.IO.Compression.WrappedStream.Dispose(Boolean disposing)
```

読み取り側のバグも似ています。シーク可能なストリームでは、.NET 10 の `CreateAsync` は end-of-central-directory レコードだけを読み込み、セントラルディレクトリの読み込みは最初の `Entries` アクセスまで先送りします。そのアクセスで `ReadCentralDirectory()` が同期的に実行されます。シーク不可のストリームがこのバグを免れているのは偶然で、`CreateAsync` がまず非同期の読み取りでそれを `MemoryStream` にコピーするからです。

どちらも [dotnet/runtime#121624](https://github.com/dotnet/runtime/issues/121624) ("Asynchronous Zip Methods still have synchronous calls") として報告され、[PR #121938](https://github.com/dotnet/runtime/pull/121938) で修正されました。この PR は 2025-12-01 に 11.0.0 マイルストーンでマージされています。修正はわずか 18 行で、`WrappedStream` に本物の `DisposeAsync` を追加し、読み取りモードの `CreateAsync` で `EnsureCentralDirectoryReadAsync` を先行して呼び出すというものです。`release/10.0` へのバックポートはありません。10.0.12 までの .NET 10 サービスリリースは依然として失敗し、10.0.10 と 10.0.12 で再現を確認しました。

`FileStream` なら気付くことはありません。同期書き込みはスレッドプールのスレッドを一瞬ブロックするだけだからです。Kestrel では事情が異なります。

## ASP.NET Core のエンドポイントから ZIP をストリーミングする

多くの人が本当に気にしているのはこのケースでしょう。一時ファイルも `MemoryStream` も使わず、アーカイブを `Response.Body` に直接構築します。

```csharp
// .NET 11 RC 1, ASP.NET Core 11 minimal API
using System.IO.Compression;

app.MapGet("/export", async (HttpContext ctx, CancellationToken ct) =>
{
    ctx.Response.ContentType = "application/zip";
    ctx.Response.Headers.ContentDisposition = "attachment; filename=\"export.zip\"";

    await using ZipArchive zip = await ZipArchive.CreateAsync(
        ctx.Response.Body, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct);

    foreach (string file in Directory.EnumerateFiles(exportFolder))
        await zip.CreateEntryFromFileAsync(file, Path.GetFileName(file), CompressionLevel.Fastest, ct);
});
```

100 ファイル (各 64 KB) のフォルダーを対象に、両方のランタイムで実行しました。

- **.NET 11 RC 1:** `200`、3,499,034 バイトで、`unzip -l` は 100 ファイルすべてを一覧表示します。
- **.NET 10.0.10:** `200`、**130 バイト**。最初のエントリのローカルヘッダーが送信された後、`DisposeAsync` が同期書き込みに到達し、Kestrel が `InvalidOperationException: Synchronous operations are disallowed. Call WriteAsync or set AllowSynchronousIO to true instead.` をログに出力して、接続が切断されました。`unzip -t` は `invalid compressed data to inflate` と報告します。

危険なのは 2 つ目の結果です。ステータスコードはすでに送信済みなので、クライアントからは壊れたファイルのダウンロードが成功したように見えます。同じエンドポイントを `new ZipArchive(...)` で書くと両方のランタイムで失敗しますが、少なくとも 1 バイトも書き込まれる前に `500` で失敗します。この例外について詳しくは、["Synchronous operations are disallowed" の修正方法](/ja/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/) を参照してください。

.NET 10 から移行できない場合は、非同期の一時ファイルにアーカイブを構築してから、それをコピーして送り出します。

```csharp
// .NET 10 workaround (verified on 10.0.10): the ZIP code does sync I/O against the temp file, never against Kestrel
app.MapGet("/export", async (HttpContext ctx, CancellationToken ct) =>
{
    await using var tmp = new FileStream(Path.GetTempFileName(), FileMode.Create, FileAccess.ReadWrite,
        FileShare.None, bufferSize: 81920, FileOptions.Asynchronous | FileOptions.DeleteOnClose);

    await using (ZipArchive zip = await ZipArchive.CreateAsync(tmp, ZipArchiveMode.Create, leaveOpen: true, entryNameEncoding: null, ct))
    {
        foreach (string file in Directory.EnumerateFiles(exportFolder))
            await zip.CreateEntryFromFileAsync(file, Path.GetFileName(file), CompressionLevel.Fastest, ct);
    }

    tmp.Position = 0;
    ctx.Response.ContentType = "application/zip";
    ctx.Response.ContentLength = tmp.Length;
    await tmp.CopyToAsync(ctx.Response.Body, ct);
});
```

これで .NET 10.0.10 でも有効な 3.5 MB のアーカイブが返り、正しい `Content-Length` も付けられます。代替策として、リクエストに対して `IHttpBodyControlFeature.AllowSynchronousIO = true` を設定する方法もあり、これも動作しますが、ダウンロード 1 件ごとにスレッドを 1 つブロックします。大きなレスポンスをヒープに載せない方法について詳しくは、[ASP.NET Core のエンドポイントからバッファリングせずにファイルをストリーミングする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) を参照してください。

## リクエストボディからアップロードされた ZIP を展開する

逆方向はどちらのランタイムでも動作します。リクエストボディはシーク不可だからです。

```csharp
// .NET 10+ (tested on 10.0.10 and 11 RC 1)
app.MapPost("/import", async (HttpRequest req, CancellationToken ct) =>
{
    await using ZipArchive zip = await ZipArchive.CreateAsync(
        req.Body, ZipArchiveMode.Read, leaveOpen: false, entryNameEncoding: null, ct);

    long total = 0;
    foreach (ZipArchiveEntry entry in zip.Entries)
    {
        await using Stream s = await entry.OpenAsync(ct);
        var buffer = new byte[81920];
        int read;
        while ((read = await s.ReadAsync(buffer, ct)) > 0) total += read;
    }
    return Results.Ok(new { entries = zip.Entries.Count, bytes = total });
});
```

100 ファイルのアーカイブを POST すると `{"entries":100,"bytes":6553600}` が返りました。一方、`new ZipArchive(req.Body, ZipArchiveMode.Read)` 版は、同じ例外の `ReadAsync` 版とともに `500` を返しました。ただし注意点があります。ZIP のインデックスはファイルの末尾にあるため、シーク不可のストリームに対する読み取りモードでは、まず **アーカイブ全体をメモリにコピー** します。32 MB のテスト用アーカイブでは、最初のエントリが利用可能になるまでに 253 回の非同期読み取りがかかりました。大きなアップロードの場合は、まずボディを `FileOptions.Asynchronous` の一時ファイルにストリーミングし (そして [リクエストサイズの上限](/ja/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) も確認し)、それから開くようにします。ただし .NET 10 では、シーク可能な入力元にすると同期の `Entries` 読み込みが復活することを忘れないでください。

## リリース前に知っておきたい落とし穴

**キャンセルすると展開途中のディレクトリが残ります。** 1,000 エントリのアーカイブに対する `ExtractToDirectoryAsync` を 20 ms 後にキャンセルしました。`OperationCanceledException` がスローされ、ディスク上には 129 ファイルが残り、そのうち 1 つは途中で切れていました (.NET 10.0.12 では 181 ファイル)。その後 `overwriteFiles: true` なしで 2 回目を呼び出すと、`IOException: The file '.../f539.bin' already exists.` で失敗します。中途半端な出力が問題になるなら、隣に一時ディレクトリを作ってそこへ展開し、タスクが完了してから `Directory.Move` で所定の場所へ移動します。トークンの受け渡し方については、[非同期メソッド全体に CancellationToken を伝播させる方法](/ja/2026/07/how-to-propagate-a-cancellationtoken-through-async-methods-in-dotnet-11/) で解説しています。

**非同期だから速いわけではありません。** 非同期は I/O を待つ間スレッドを解放するだけで、それ以上のことはしません。1,000 ファイル (64 MB) を圧縮し、その結果を展開したときの、ローカル SSD 上での `Stopwatch` 計測 7 回の中央値です (BenchmarkDotNet による計測ではありません)。

| 操作 | .NET 11 RC 1 同期 | .NET 11 RC 1 非同期 | .NET 10.0.12 同期 | .NET 10.0.12 非同期 |
| --- | --- | --- | --- | --- |
| `CreateFromDirectory` | 249 ms | 268 ms | 252 ms | 259 ms |
| `ExtractToDirectory` | 103 ms | 108 ms | 84 ms | 101 ms |

圧縮は CPU の仕事であり、高速なローカルディスクでは非同期ファイル I/O がわずかなオーバーヘッドを加えます。非同期 API は、スレッドがブロックされるとコストになるサーバーや UI スレッドで使いましょう。ビルド出力を圧縮するだけのコンソールツールでは、得るものはありません。

**Update モードは今でも特殊なケースです。** `ZipArchiveMode.Update` には読み取り、書き込み、シークが可能なストリームが必要で (`ArgumentException: Update mode requires a stream with read, write, and seek capabilities.`)、エントリを開くたびにそれをメモリに読み込みます。シーク可能なストリーム上で `CreateAsync` と `await using` を使えば動作しますが、大きなアーカイブでは新しいアーカイブを書き出す方が通常は安上がりです。

**同期の `Open()` が常に無害とは限りません。** .NET 11 の作成モードでは、新しいエントリを開く処理が I/O を行わないため、同期の `entry.Open()` がたまたまプローブで動作しました。読み取りモードでは、同期禁止のストリームに対して両方のランタイムで例外になります。どこでも `OpenAsync` を使い、いちいち気にしないのが一番です。

**`IAsyncDisposable` を自分で実装していますか?** .NET 10 のバグは、`DisposeAsync` の転送を忘れたラッパーの典型例です。正しく実装する方法は [IAsyncDisposable の実装と利用](/ja/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/) で順を追って説明しています。

### 次に読む

- [修正方法: ASP.NET Core の InvalidOperationException: Synchronous operations are disallowed](/ja/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed/)
- [ASP.NET Core のエンドポイントからバッファリングせずにファイルをストリーミングする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)
- [.NET 11 の System.IO.Compression は暗号化 ZIP の読み書きに対応](/ja/2026/08/dotnet-11-preview-7-password-protected-zip-archives/)
- [C# で await using を使って IAsyncDisposable を実装・利用する方法](/ja/2026/07/how-to-implement-and-consume-iasyncdisposable-with-await-using-in-csharp/)

### 出典

- [dotnet/runtime#1541: Add async ZipFile APIs](https://github.com/dotnet/runtime/issues/1541) と [承認された API の形](https://github.com/dotnet/runtime/issues/1541#issuecomment-2715269236)
- [dotnet/runtime PR #114421: Zip async implementation](https://github.com/dotnet/runtime/pull/114421)
- [dotnet/runtime#121624: Asynchronous Zip Methods still have synchronous calls](https://github.com/dotnet/runtime/issues/121624)
- [dotnet/runtime PR #121938: Fix async ZipArchive calling non-async Stream methods](https://github.com/dotnet/runtime/pull/121938)
- [Microsoft Learn の ZipArchive.CreateAsync](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.ziparchive.createasync)
- [Microsoft Learn の ZipFile.ExtractToDirectoryAsync](https://learn.microsoft.com/en-us/dotnet/api/system.io.compression.zipfile.extracttodirectoryasync)
