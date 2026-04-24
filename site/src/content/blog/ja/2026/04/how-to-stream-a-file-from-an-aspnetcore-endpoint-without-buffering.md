---
title: "ASP.NET Core エンドポイントからバッファリングなしでファイルをストリーミングする方法"
description: "ASP.NET Core 11 でファイル全体をメモリに読み込まずに大きなファイルを配信します。3 つのレベル: ディスク上のファイルには PhysicalFileResult、任意のストリームには Results.Stream、生成コンテンツには Response.BodyWriter -- それぞれのコード付き。"
pubDate: 2026-04-24
tags:
  - "aspnet-core"
  - "dotnet"
  - "dotnet-11"
  - "performance"
  - "streaming"
lang: "ja"
translationOf: "2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering"
translatedBy: "claude"
translationDate: 2026-04-24
---

ディスク上に既に存在するファイルには `PhysicalFileResult` (または Minimal APIs では `Results.File(path, contentType)`) を使用してください -- Kestrel は内部で OS の `sendfile` システムコールを呼び出すため、ファイルのバイトはマネージドメモリに触れることがありません。ディスク上に存在しないストリーム -- Azure Blob、S3 オブジェクト、動的に生成されるアーカイブ -- に対しては、`FileStreamResult` または `Results.Stream(factory, contentType)` を返し、ファクトリデリゲートの内部で基となる `Stream` を遅延開放してください。完全に生成されるコンテンツの場合は、`HttpContext.Response.BodyWriter` に直接書き込みます。3 つのケースすべてにおいて、スケーラビリティをサイレントに破壊するパターンが 1 つあります: ソースを先に `MemoryStream` にコピーすることです。これにより、1 バイトもクライアントに届く前に、ペイロード全体がマネージドヒープ (通常は Large Object Heap) に読み込まれます。

この記事は .NET 11 と ASP.NET Core 11 (preview 3) を対象としています。レベル 1 と 2 のすべては .NET 6 から機能しています; `BodyWriter` アプローチは .NET 5 で `System.IO.Pipelines` の安定 API が登場して以来使いやすくなり、それ以来変わっていません。

## レスポンスのバッファリングが思っているものと違う理由

「ファイルをストリーミングする」と言うとき、通常は「すべてをメモリに読み込まない」という意味です。それは正しいのですが、第 2 の側面があります: レスポンスもバッファリングしないことです。ASP.NET Core の出力キャッシュおよびレスポンス圧縮ミドルウェアは、透過的にバッファリングを再導入する可能性があります。`AddResponseCompression` を使用していてチューニングしていない場合、小さなファイル (デフォルトの 256 バイトのしきい値以下) は決して圧縮されませんが、大きなファイルは圧縮バイトが書き込まれる前に完全に `MemoryStream` にバッファリングされます。大きなファイルの解決策は、CDN レイヤーで圧縮するか、`ResponseCompressionOptions` の `MimeTypes` を保守的に設定してバイナリコンテンツタイプを圧縮から除外することです。

レスポンスのバッファリングは、コントローラアクションから `IResult` または `ActionResult` を返すときにもフレームワーク内部で発生します: フレームワークはまずステータスとヘッダーを書き込み、その後結果の `ExecuteAsync` を呼び出します。ここで実際のバイト転送が行われます。.NET 6 では `Results.File(path, ...)` が `PhysicalFileResultExecutor.WriteFileAsync` を呼び出し、これが `IHttpSendFileFeature.SendFileAsync` -- ゼロコピーパス -- に委譲していました。.NET 7 ではリファクタリングにより、`Results.File` が `FileStream` を `StreamPipeWriter` でラップし `IHttpSendFileFeature` をバイパスして、カーネルがファイルページを不必要にユーザー空間にコピーする問題が発生する退行が導入されました ([issue #45037](https://github.com/dotnet/aspnetcore/issues/45037) として追跡)。この退行は修正されましたが、「正しい」結果タイプが正確さだけでなくパフォーマンスにとっても重要であることを示しています。

## レベル 1: ディスク上に既に存在するファイル

ディスク上のファイルには、MVC コントローラでは `PhysicalFileResult`、Minimal APIs では `Results.File(physicalPath, contentType)` が正しい戻り値の型です。どちらも `Stream` ではなく物理パス文字列を受け取るため、エグゼキューターは現在のトランスポートで `IHttpSendFileFeature` が利用可能かどうかを確認できます。Linux 上の Kestrel はこの機能を公開し `sendfile(2)` を使用します -- バイトは .NET プロセスにコピーされることなく OS のページキャッシュからソケットバッファに直接転送されます。Windows では、Kestrel は同じ効果のある I/O 完了ポートを通じて `TransmitFile` を使用します。

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API
app.MapGet("/downloads/{filename}", (string filename, IWebHostEnvironment env) =>
{
    string physicalPath = Path.Combine(env.ContentRootPath, "downloads", filename);

    if (!File.Exists(physicalPath))
        return Results.NotFound();

    return Results.File(
        physicalPath,
        contentType: "application/octet-stream",
        fileDownloadName: filename,
        enableRangeProcessing: true);
});
```

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller
[HttpGet("downloads/{filename}")]
public IActionResult Download(string filename)
{
    string physicalPath = Path.Combine(_env.ContentRootPath, "downloads", filename);

    if (!System.IO.File.Exists(physicalPath))
        return NotFound();

    return PhysicalFile(
        physicalPath,
        "application/octet-stream",
        fileDownloadName: filename,
        enableRangeProcessing: true);
}
```

パスについて 2 点注意が必要です。まず、ユーザーが指定したファイル名をサニタイズせずに `Path.Combine` に直接渡さないでください。上記のコードはスケルトンです: `File.Exists` を呼び出す前に、解決されたパスがまだ許可されたディレクトリ内にあることを確認してください。次に、`IWebHostEnvironment.ContentRootPath` はアプリの作業ディレクトリに解決され、`wwwroot` ではありません。パブリックな静的アセットには、`app.UseStaticFiles()` を使用した静的ファイルミドルウェアが既にレンジリクエストと ETag を処理しており、`wwwroot` 内のファイルに対する手動エンドポイントよりそちらを優先すべきです。

## レベル 2: 任意のストリームからのストリーミング

S3 オブジェクト、Azure Blob、データベースの `varbinary(max)` カラム -- これらはすべて、ディスク上に対応するパスがない `Stream` を返すため、`PhysicalFileResult` は適用できません。コントローラでは `FileStreamResult`、Minimal APIs では `Results.Stream` が正しい型です。

重要な点は、`Stream` を遅延して開くことです。`Results.Stream` はファクトリのオーバーロード `Func<Stream>` を受け付けます; レスポンスヘッダーが書き込まれ接続が生きていることが確認されるまでストリームが開かれないよう、これを使用してください。ファクトリが例外をスローした場合 (例えば、blob がもう存在しない場合)、フレームワークはヘッダーがコミットされる前にまだ 404 を返せます。

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- Azure Blob Storage からのストリーミング
app.MapGet("/blobs/{blobName}", async (
    string blobName,
    BlobServiceClient blobService,
    CancellationToken ct) =>
{
    var container = blobService.GetBlobContainerClient("exports");
    var blob = container.GetBlobClient(blobName);

    if (!await blob.ExistsAsync(ct))
        return Results.NotFound();

    BlobProperties props = await blob.GetPropertiesAsync(cancellationToken: ct);

    return Results.Stream(
        streamWriterCallback: async responseStream =>
        {
            await blob.DownloadToAsync(responseStream, ct);
        },
        contentType: props.ContentType,
        fileDownloadName: blobName,
        lastModified: props.LastModified,
        enableRangeProcessing: false); // Azure はソースでレンジを処理するため、二重処理を無効化
});
```

`Results.Stream` には 2 つのオーバーロードがあります: 1 つは `Stream` を直接受け取り、もう 1 つはコールバック `Func<Stream, Task>` を受け取ります (上記参照)。ソースがネットワークストリームの場合は、フレームワークがレスポンスボディを書き込む準備ができるまで I/O を延期するコールバック形式を優先してください。コールバックはレスポンスボディの `Stream` を引数として受け取ります; ソースデータをそこに書き込みます。

コントローラの場合、`FileStreamResult` はストリームを直接渡すことを要求します。アクションメソッドでできるだけ遅くオープンし、スレッドプールのブロッキングを避けるために `FileStream` インスタンスを開く際は `FileOptions.Asynchronous | FileOptions.SequentialScan` を使用してください:

```csharp
// .NET 11, ASP.NET Core 11
// MVC controller -- FileStreamResult 経由でローカルファイルシステムからストリーミング
[HttpGet("exports/{id}")]
public async Task<IActionResult> GetExport(Guid id, CancellationToken ct)
{
    string? path = await _exportService.GetPathAsync(id, ct);

    if (path is null)
        return NotFound();

    var fs = new FileStream(
        path,
        new FileStreamOptions
        {
            Mode    = FileMode.Open,
            Access  = FileAccess.Read,
            Share   = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
            BufferSize = 64 * 1024,
        });

    return new FileStreamResult(fs, "application/octet-stream")
    {
        FileDownloadName    = $"{id}.bin",
        EnableRangeProcessing = true,
    };
}
```

フレームワークはレスポンス送信後に `fs` を破棄します。その周りに `using` ブロックは必要ありません。

## レベル 3: 生成コンテンツをレスポンスパイプに書き込む

コンテンツがどこにも存在しない場合があります -- PDF にレンダリングされたレポート、クエリ結果から組み立てられた CSV、選択したファイルから作成された ZIP など、オンザフライで生成されます。単純なアプローチは `MemoryStream` にレンダリングして `FileStreamResult` として返すことです。それは機能しますが、クライアントが最初のバイトを受け取る前に、ペイロード全体がメモリに存在する必要があります。200 MB のエクスポートの場合、同時リクエストごとに Large Object Heap 上の 200 MB になります。

正しいアプローチは、4 KB バッファのプールに支えられた `PipeWriter` である `HttpContext.Response.BodyWriter` に直接書き込むことです。フレームワークはソケットにインクリメンタルにフラッシュします; メモリ使用量はファイルサイズではなくインフライトウィンドウに制限されます。

```csharp
// .NET 11, ASP.NET Core 11
// Minimal API -- 生成された CSV レポートのストリーミング
app.MapGet("/reports/{year:int}", async (
    int year,
    ReportService reports,
    HttpContext ctx,
    CancellationToken ct) =>
{
    ctx.Response.ContentType = "text/csv";
    ctx.Response.Headers.ContentDisposition = $"attachment; filename=\"report-{year}.csv\"";

    var writer = ctx.Response.BodyWriter;

    await writer.WriteAsync("id,date,amount\n"u8.ToArray(), ct);

    await foreach (ReportRow row in reports.GetRowsAsync(year, ct))
    {
        string line = $"{row.Id},{row.Date:yyyy-MM-dd},{row.Amount:F2}\n";
        await writer.WriteAsync(Encoding.UTF8.GetBytes(line), ct);
    }

    await writer.CompleteAsync();
    return Results.Empty;
});
```

`"id,date,amount\n"u8.ToArray()` の使用に注目してください -- C# 11 で導入された UTF-8 文字列リテラルで、アロケーションなしで `byte[]` を生成します。行の場合、`Encoding.UTF8.GetBytes(line)` はまだアロケーションします; これをなくすには、ライターから直接バッファをリクエストします:

```csharp
// .NET 11, C# 14 -- PipeWriter.GetMemory を使用したアロケーションなし書き込み
await foreach (ReportRow row in reports.GetRowsAsync(year, ct))
{
    string line = $"{row.Id},{row.Date:yyyy-MM-dd},{row.Amount:F2}\n";
    int byteCount = Encoding.UTF8.GetByteCount(line);
    Memory<byte> buffer = writer.GetMemory(byteCount);
    int written = Encoding.UTF8.GetBytes(line, buffer.Span);
    writer.Advance(written);
    await writer.FlushAsync(ct);
}
```

`GetMemory` / `Advance` / `FlushAsync` は `PipeWriter` の標準パターンです。`FlushAsync` は下流のコンシューマーがキャンセルまたは完了したかどうかを示す `FlushResult` を返します (`FlushResult.IsCompleted`); 正常に動作するクライアントではダウンロード中にこれが真になることはほとんどありませんが、ループ内でチェックすることでクライアントが切断した場合に早期終了できます。

レスポンスボディを直接書き込んでいるため、最初の `FlushAsync` 呼び出しでヘッダーがコミットされた後はステータスコードを返せません。バイトを書き込む前に `ctx.Response.StatusCode` を設定してください。サービス呼び出しが 500 を返すような形で失敗する可能性がある場合は、`BodyWriter` に触れる前にそれを確認してください。

ZIP 生成については、.NET 11 (`System.IO.Compression` を通じて) で任意の書き込み可能なストリームに書き込む `ZipArchive` を作成できます。`ctx.Response.Body` をラップする `StreamWriter` を渡してください (`ZipArchive` は `PipeWriter` ではなく `Stream` を期待するため、`BodyWriter` を直接渡さないでください)。このアプローチは [C# ZIP files to Stream](/2023/11/c-zip-files-to-stream/) の記事でカバーされており、.NET 8 で追加された新しい `CreateFromDirectory` オーバーロードを使用しています。同様に、エクスポートが Zstandard で圧縮されている場合は、レスポンスボディの前に圧縮ストリームをチェーンしてください -- [.NET 11 の Zstandard 圧縮サポート](/2026/04/dotnet-11-zstandard-compression-system-io/) の新しいビルトイン `ZstandardStream` は NuGet 依存関係を避けます。

## レンジリクエスト: 無料で再開可能なダウンロード

`FileStreamResult` または `Results.File` の `EnableRangeProcessing = true` は、ASP.NET Core に `Range` リクエストヘッダーを解析して `206 Partial Content` で応答するよう指示します。フレームワークはすべてを処理します: `Range` ヘッダーの解析、ストリームのシーク (シーク可能なストリームの場合)、`Content-Range` および `Accept-Ranges` レスポンスヘッダーの設定、リクエストされたバイト範囲のみの送信。

`PhysicalFileResult` では、フレームワークがファイルハンドルを制御しているため、レンジ処理は常に利用可能です。`FileStreamResult` では、レンジ処理は基となる `Stream.CanSeek` が `true` の場合にのみ機能します。`BlobClient.OpenReadAsync` から返される Azure Blob ストリームはシーク可能です; 生の `HttpResponseMessage.Content` ストリームは通常シーク可能ではありません。シークが利用できない場合は、`EnableRangeProcessing = false` (デフォルト) を設定して、レンジサポートなしで配信するか、関連するレンジを自分でバッファリングしてください。

## サイレントにバッファリングを再導入する一般的なミス

**コントローラアクションから `byte[]` を返す。** ASP.NET Core はそれを `FileContentResult` でラップします。小さなファイルには問題ありませんが、大きなファイルには致命的です。アクションメソッドが返す前にバイト配列がアロケーションされるからです。

**ソースストリームで `stream.ToArray()` または `MemoryStream.GetBuffer()` を呼び出す。** どちらもストリーム全体を実体化します。`Results.Stream` を呼び出す前にこれを行っているなら、ストリーミングを否定しています。

**`Response.ContentLength` を誤って設定する。** `ContentLength` が設定されているがストリームがより少ないバイトを生成する場合 (早期に中断したため)、Kestrel は接続エラーをログに記録します。小さすぎる場合、クライアントは `ContentLength` バイト後に読み取りを停止し、バイトが残っていてもダウンロードが完了したとみなす可能性があります。事前にサイズが不明な動的に生成されるコンテンツの場合は、`ContentLength` を省略してクライアントにチャンクエンコーディングを使用させてください。

**キャンセルを忘れる。** 2 GB のエクスポートには数分かかります。`PipeWriter` のフラッシュループを通じて `CancellationToken` を接続することで、クライアントが接続を閉じたときにサーバーが即座にクリーンアップできます。ストリームのティアダウン時のデッドロックを防ぐキャンセルパターンについては、[C# で長時間実行タスクをデッドロックなしでキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) の記事を参照してください。

**コントローラから `IAsyncEnumerable<byte[]>` を使用する。** ASP.NET Core の JSON フォーマッターは、バイト配列を生のバイトとして書き込む代わりに Base64 JSON トークンとしてシリアライズしようとします。`IAsyncEnumerable` はアプリケーションレイヤーでより低レベルの書き込みループにフィードするためだけに使用し、バイナリコンテンツのアクション結果として直接返さないでください。

**圧縮出力のバッファリング。** デフォルト設定の `AddResponseCompression` はレスポンス全体をバッファリングして圧縮するため、テキストコンテンツタイプの場合は上記のすべてが無効になります。ダウンロードコンテンツタイプを圧縮から除外するか、ストリーミング前にソースを圧縮するか (レスポンスパイプの前に `DeflateStream` または `ZstandardStream` をチェーン)、CDN で事前圧縮してください。

## 適切なレベルの選択

既知のパスを持つディスク上のファイル: `Results.File(physicalPath, contentType, enableRangeProcessing: true)`。

Blob または外部ストリーム: `Results.Stream(callback, contentType)` またはシーク可能なストリームの `FileStreamResult`。

生成されたコンテンツ: `ctx.Response.BodyWriter` に書き込み、最初の `FlushAsync` の前にヘッダーを設定し、ループを通じて `CancellationToken` を渡す。

共通のテーマはパイプラインを開いたままにしてデータを流すことです。ペイロード全体をバッファリングした瞬間、O(1) メモリのエンドポイントから O(N) メモリのエンドポイントに変わり、同時負荷下ではそれらの N 値が積み重なってプロセスがクラッシュするまで続きます。

ここでストリーミングが重要なのと同じ理由で、大きな入力を読み取る際にも重要です: [.NET 11 でメモリ不足にならずに大きな CSV を読み取る方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) の記事では、インジェスト側からの同じトレードオフを示しています。

## ソース

- [MS Learn の FileStreamResult](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.mvc.filestreamresult)
- [MS Learn の Results.Stream](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.results.stream)
- [MS Learn の IHttpSendFileFeature.SendFileAsync](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpsendfilefeature.sendfileasync)
- [MS Learn の System.IO.Pipelines](https://learn.microsoft.com/en-us/dotnet/standard/io/pipelines)
- [dotnet/aspnetcore issue #45037 -- .NET 7 の Results.File 退行](https://github.com/dotnet/aspnetcore/issues/45037)
- [dotnet/aspnetcore issue #55606 -- FileStreamResult の過剰な I/O](https://github.com/dotnet/aspnetcore/issues/55606)
- [MS Learn の ASP.NET Core でのレスポンス圧縮](https://learn.microsoft.com/en-us/aspnet/core/performance/response-compression)
