---
title: "大きなファイルをストリーミングで Azure Blob Storage にアップロードする方法"
description: ".NET 11 から数 GB のファイルをメモリに載せずに Azure Blob Storage へアップロードする方法。BlockBlobClient.UploadAsync と StorageTransferOptions、ASP.NET Core アップロードの MultipartReader、ペイロードを LOH に載せてしまうバッファリングの罠を解説します。"
pubDate: 2026-04-28
tags:
  - "azure"
  - "dotnet"
  - "dotnet-11"
  - "aspnet-core"
  - "streaming"
lang: "ja"
translationOf: "2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage"
translatedBy: "claude"
translationDate: 2026-04-28
---

ソースを `Stream` として開き、`StorageTransferOptions` を設定した `BlockBlobClient.UploadAsync(Stream, BlobUploadOptions)` にそのまま渡してください。Azure SDK はストリームを block-blob のブロックに分割し、並列でステージングし、ストリームが終了したらブロックリストをコミットします。`MaximumTransferSize` より大きな `byte[]` を確保することはなく、ソースストリームは前方向に一度だけ読み込まれます。これを静かに壊すパターンは次のとおりです: リクエストボディを `MemoryStream` に「長さを知るために」コピーすること、ASP.NET Core がフォームを既にメモリにバッファリングした後で `IFormFile.OpenReadStream` を呼ぶこと、そして `MaximumConcurrency` の設定を忘れて、20 並列のブロックステージングを喜んで受け入れてくれるサービスに対して 1 スレッドで 4 MiB ずつアップロードしてしまうことです。

この記事は `Azure.Storage.Blobs` 12.22+、.NET 11、ASP.NET Core 11 を対象としています。ここで使う block-blob プロトコルの上限 (1 ブロック 4000 MiB、ブロック数 50,000、blob 1 つあたり合計 ~190.7 TiB) には x-ms-version `2019-12-12` 以降が必要で、SDK はデフォルトでこれをネゴシエートします。

## デフォルトのアップロード経路は、ある意味すでにストリーミング

`BlobClient.UploadAsync(Stream)` は長さ不明のストリームに対して正しい動作をします: `InitialTransferSize` バイトまで読み込み、その範囲内でストリームが終わっていれば 1 回の `PUT Blob` リクエストを発行します。そうでなければステージングブロックアップロードに切り替わり、`MaximumTransferSize` バイトずつ読みつつ `MaximumConcurrency` まで並列に `PUT Block` を呼び出します。ソースストリームが 0 バイトを返したら、`PUT Block List` を発行して順序をコミットします。

12.22 で出荷されているデフォルトは `InitialTransferSize = 256 MiB`、`MaximumTransferSize = 8 MiB`、`MaximumConcurrency = 8` です。大きなアップロードでこれを放置するのは 2 つの点で間違っています。第一に、`InitialTransferSize = 256 MiB` だと、明らかに収まらない 50 GiB のストリームを渡しても、SDK は 1 回の PUT を使うかどうか決めるまでに内部で最大 256 MiB をバッファリングします。第二に、`MaximumConcurrency = 8` はコロケーションされたストレージアカウントへの 1 Gbps リンクには問題ありませんが、各 PUT のラウンドトリップに 80-200 ms かかるリージョン間アップロードではボトルネックになります。

```csharp
// .NET 11, Azure.Storage.Blobs 12.22
var transferOptions = new StorageTransferOptions
{
    InitialTransferSize = 8 * 1024 * 1024,   // 8 MiB. Always go via block uploads for large files.
    MaximumTransferSize = 8 * 1024 * 1024,   // 8 MiB blocks. Sweet spot for most networks.
    MaximumConcurrency  = 16                  // Parallel PUT Block calls.
};

var uploadOptions = new BlobUploadOptions
{
    TransferOptions = transferOptions,
    HttpHeaders     = new BlobHttpHeaders { ContentType = "application/octet-stream" }
};

await using FileStream source = File.OpenRead(localPath);
await blobClient.UploadAsync(source, uploadOptions, cancellationToken);
```

4 MiB から 16 MiB の間のブロックサイズが Standard ストレージアカウントのスイートスポットです。ブロックが小さすぎると `PUT Block` のオーバーヘッドでラウンドトリップを浪費し、大きすぎると一時的な 503 で SDK がブロック全体を再送するためリトライが高価になります。

## block-blob の上限がブロックサイズを決める

Azure の block blob には、「ストリームすればいい」という発想ではいずれぶつかる固い上限があります。blob 1 つあたり 50,000 ブロック、各ブロックは最大 4000 MiB、blob の最大サイズは 190.7 TiB (50,000 x 4000 MiB) です。200 GiB のアップロードを 4 MiB ブロックで行うと 51,200 ブロック必要で、上限を 1 つ超えてしまいます。したがって:

- ~195 GiB まで: 4 MiB 以上ならどのブロックサイズでも動きます。
- 195 GiB から ~390 GiB まで: 最低 8 MiB。
- 1 TiB: 最低 21 MiB。SDK のデフォルト 8 MiB ではアップロードの途中で `BlockCountExceedsLimit` で失敗します。

SDK はあなたのためにブロックサイズを引き上げてはくれません。ソースの長さが事前にわかっている場合は、必要なブロックサイズを計算して `MaximumTransferSize` にそれを設定してください:

```csharp
// .NET 11
static long PickBlockSize(long contentLength)
{
    const long maxBlocks = 50_000;
    const long minBlock  = 4 * 1024 * 1024;          // 4 MiB
    const long maxBlock  = 4000L * 1024 * 1024;      // 4000 MiB

    long required = (contentLength + maxBlocks - 1) / maxBlocks;
    long rounded  = ((required + minBlock - 1) / minBlock) * minBlock;
    return Math.Clamp(rounded, minBlock, maxBlock);
}
```

長さ不明のアップロード (生成されるアーカイブ、サーバ側の fan-in) ではデフォルトで 16 MiB ブロックを使ってください。あとから上限を引き上げる必要なく ~780 GiB まで余裕が出ます。

## ASP.NET Core: `IFormFile` ではなくリクエストボディをストリームしてください

このパイプライン全体を最も簡単に台無しにするのが `IFormFile` です。multipart アップロードが届くと、ASP.NET Core の `FormReader` はあなたのアクションが走る前にボディ全体をフォームコレクションに読み込みます。`FormOptions.MemoryBufferThreshold` (フォーム値あたりデフォルト 64 KiB ですが、ファイル部分は `MultipartBodyLengthLimit` の 128 MiB に従います) 未満のものはメモリに、それを超えるものは `Microsoft.AspNetCore.WebUtilities.FileBufferingReadStream` (ディスク上の一時ファイル) に行きます。どちらにせよ、ハンドラーが走る頃にはアップロードはすでに一度読まれてどこかにコピー済みです。`IFormFile.OpenReadStream()` はその一時コピー上の `FileStream` になっています。

これは 3 つのことを同時に殺します。必要のないバッファのためにディスク I/O を払います。バイトがソケットから一時ファイルへ、それから一時ファイルから SDK と Azure へと渡るのでリクエストに 2 倍の時間がかかります。そして `MultipartBodyLengthLimit` がデフォルトですべてのアップロードに 128 MiB の天井を置きます。

修正は、フォームバインディングを無効にして、自分で `MultipartReader` で multipart ストリームを読むことです:

```csharp
// .NET 11, ASP.NET Core 11
[HttpPost("upload")]
[DisableFormValueModelBinding]
[RequestSizeLimit(50L * 1024 * 1024 * 1024)]      // 50 GiB
[RequestFormLimits(MultipartBodyLengthLimit = 50L * 1024 * 1024 * 1024)]
public async Task<IActionResult> Upload(CancellationToken ct)
{
    if (!MediaTypeHeaderValue.TryParse(Request.ContentType, out var mediaType) ||
        !mediaType.MediaType.Equals("multipart/form-data", StringComparison.OrdinalIgnoreCase))
    {
        return BadRequest("Expected multipart/form-data.");
    }

    string boundary = HeaderUtilities.RemoveQuotes(mediaType.Boundary).Value!;
    var reader = new MultipartReader(boundary, Request.Body);

    MultipartSection? section;
    while ((section = await reader.ReadNextSectionAsync(ct)) != null)
    {
        var contentDisposition = section.GetContentDispositionHeader();
        if (contentDisposition is null || !contentDisposition.IsFileDisposition()) continue;

        string fileName = Path.GetFileName(contentDisposition.FileName.Value!);
        var blob = _container.GetBlockBlobClient(fileName);

        var options = new BlobUploadOptions
        {
            TransferOptions = new StorageTransferOptions
            {
                InitialTransferSize = 8 * 1024 * 1024,
                MaximumTransferSize = 16 * 1024 * 1024,
                MaximumConcurrency  = 16
            },
            HttpHeaders = new BlobHttpHeaders
            {
                ContentType = section.ContentType ?? "application/octet-stream"
            }
        };

        await blob.UploadAsync(section.Body, options, ct);
    }

    return Ok();
}
```

`section.Body` はリクエストボディから直接読むネットワークバックエンドのストリームです。Azure SDK はそこから読み、ブロックに切り分けてアップロードします。メモリは `MaximumTransferSize * MaximumConcurrency` (上の例では 256 MiB) で制限されます。`[DisableFormValueModelBinding]` 属性は、MVC があなたのアクションの実行前にボディをバインドしようとしないよう、フレームワークのデフォルトのフォーム値プロバイダを取り除く小さなカスタムフィルターです:

```csharp
// .NET 11, ASP.NET Core 11
public class DisableFormValueModelBindingAttribute : Attribute, IResourceFilter
{
    public void OnResourceExecuting(ResourceExecutingContext context)
    {
        var factories = context.ValueProviderFactories;
        factories.RemoveType<FormValueProviderFactory>();
        factories.RemoveType<FormFileValueProviderFactory>();
        factories.RemoveType<JQueryFormValueProviderFactory>();
    }

    public void OnResourceExecuted(ResourceExecutedContext context) { }
}
```

`[RequestSizeLimit]` と `[RequestFormLimits]` は両方とも必要です: 前者は Kestrel のリクエスト単位のボディキャップで、後者は `FormOptions.MultipartBodyLengthLimit` です。どちらか片方を忘れると、それぞれ 30 MiB または 128 MiB でアップロードが拒否され、エラーには multipart の文字すら出ません。

## SAS なしでの認証

`Azure.Identity` の `DefaultAzureCredential` は、Azure 上で動くあらゆるサービス (App Service、AKS、Functions、Container Apps) に対して正しいデフォルトです。コンテナにはストレージアカウントに対する `Storage Blob Data Contributor` ロールが必要です。ローカルでは同じコードが `az login` または VS Code の Azure アカウントに対して動きます。

```csharp
// .NET 11, Azure.Identity 1.13+, Azure.Storage.Blobs 12.22+
var serviceUri = new Uri($"https://{accountName}.blob.core.windows.net");
var service    = new BlobServiceClient(serviceUri, new DefaultAzureCredential());
var container  = service.GetBlobContainerClient("uploads");
await container.CreateIfNotExistsAsync(cancellationToken: ct);

var blob = container.GetBlockBlobClient(blobName);
```

アカウントキー付きの接続文字列をアプリ設定に保存するのは避けてください。キーはストレージアカウントレベルで認証するため、漏洩したキーはあらゆるコンテナとあらゆる blob への完全なアクセス、削除を含む権限を渡します。同じアップロード経路は、ブラウザがサーバーを介さず直接アップロードする場合、`BlobSasBuilder` でも動きます。

## 進捗、リトライ、再開

SDK は各ブロックの後に `IProgress<long>` を呼びます。UI には使ってよいですが、会計用には使わないでください: 値はリトライされたバイトを含む累積転送バイト数です。

```csharp
// .NET 11
var progress = new Progress<long>(bytes =>
{
    Console.WriteLine($"{bytes:N0} bytes transferred");
});

var options = new BlobUploadOptions
{
    TransferOptions  = transferOptions,
    ProgressHandler  = progress
};
```

トランスポート層は `PUT Block` を指数バックオフで自動的にリトライします (`RetryOptions` のデフォルトは 3 リトライ、初回遅延 0.8 秒)。不安定なネットワークでの数時間にわたるアップロードでは、クライアントを構築する前に `BlobClientOptions` の `RetryOptions.MaxRetries` と `NetworkTimeout` を引き上げてください:

```csharp
// .NET 11
var clientOptions = new BlobClientOptions
{
    Retry =
    {
        MaxRetries     = 10,
        Delay          = TimeSpan.FromSeconds(2),
        MaxDelay       = TimeSpan.FromSeconds(60),
        Mode           = RetryMode.Exponential,
        NetworkTimeout = TimeSpan.FromMinutes(10)
    }
};

var service = new BlobServiceClient(serviceUri, new DefaultAzureCredential(), clientOptions);
```

`UploadAsync` はプロセスの再起動をまたいでの再開はできません。プロセスが死ぬと、ステージング済みでコミットされていないブロックは最大 7 日間ストレージアカウントに残り、その後ガベージコレクトされます。手動で再開するには、`BlockBlobClient.GetBlockListAsync(BlockListTypes.Uncommitted)` でステージング済みのものを調べ、そのオフセットからソースをストリーミングし、マージしたリストで `CommitBlockListAsync` を呼びます。ほとんどのアプリではこれは不要です。バイト 0 からアップロードを再開する方が単純で、SDK の並列性のおかげで安価です。

## CancellationToken: どこにでも渡す

`UploadAsync` に渡す `CancellationToken` はステージングする各ブロックで尊重されますが、ブロックとブロックの間でのみ尊重されます。1 回の `PUT Block` は飛行中に中断されません。SDK はそれが完了 (または失敗) するのを待ってからトークンを観測します。1 Gbps リンク上の 16 MiB ブロックなら ~130 ms なので問題ありません。10 Mbps リンクだと 13 秒です。素早いキャンセルが重要なら、最悪ケースの飛行中ブロックを小さくするために `MaximumTransferSize` を 4 MiB に下げてください。

`NetworkTimeout` を非常に大きくする場合も同じ警告が当てはまります。`CancellationToken` はハングしたソケットをプリエンプトしません。タイムアウトはします。`NetworkTimeout` は許容できるキャンセル遅延より小さく保ってください。協調的キャンセルのパターンは [長時間実行 Task をデッドロックなしでキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) で詳しく扱っているのと同じです: トークンを下に渡し、`OperationCanceledException` を伝播させ、`finally` で後始末する。

## アップロードの検証

block blob では、`TransactionalContentHash` を設定するとブロックごとの MD5 がサービスによって自動的に検証されますが、SDK が設定するのは単発 PUT の経路だけで、ステージングブロックの経路では設定されません。チャンクアップロードでエンドツーエンドの整合性を検証するには、blob 全体のハッシュを `BlobHttpHeaders.ContentHash` に設定してください。サービスはこれを保存し `Get Blob Properties` で返しますが、アップロード時には検証**しません**。クライアントで計算してダウンロード時に再チェックする必要があります。

```csharp
// .NET 11
using var sha = SHA256.Create();
await using var hashed = new CryptoStream(source, sha, CryptoStreamMode.Read, leaveOpen: true);

await blob.UploadAsync(hashed, options, ct);

byte[] hash = sha.Hash!;
await blob.SetHttpHeadersAsync(new BlobHttpHeaders { ContentHash = hash }, cancellationToken: ct);
```

ソースを `CryptoStream` で包むと CPU コストが増えます (現代のハードウェアで SHA-256 で ~600 MB/s) が、バッファリングなしでハッシュを計算する唯一の方法です。チャネルが HTTPS で Azure のトランスポートレベルの整合性を信頼できるならスキップしてください。

## 静かにバッファリングするもの

正しい SDK 呼び出しを使っていても、3 つのパターンが避けようとしていたメモリ問題を蘇らせます:

1. ヘッダを調べるための `Stream.CopyToAsync(memoryStream)`。数 MiB を超えるものではこれをやらないでください。先頭バイトが必要なら、スタック確保した `Span<byte>` に読み込み、ストリームが seek をサポートする場合に限り `Stream.Position = 0` してください。ほとんどのネットワークバックエンドのストリームはサポートしないので、その場合は小さな `BufferedStream` を使ってください。
2. リクエストボディのロギング。Serilog/NLog のボディキャプチャ用ミドルウェアはペイロード全体をログ可能にするためにバッファリングする可能性があります。アップロードルートでは無効にしてください。
3. アップロード後に `Response.Body` のヘッダを設定して `IActionResult` を返す。フレームワークの `ObjectResult` フォーマッタはステータスオブジェクトをバッファリングされたレスポンスにシリアライズし得ます。ストリーミングアップロードの後は大きなオブジェクトではなく `Results.Ok()` または `NoContent()` を返してください。

「本当にストリーミングしているか」のサニティチェックは、5 GiB アップロード中のプロセスのワーキングセットを観察することです。この記事のとおりに SDK と `StorageTransferOptions` を設定していれば、ワーキングセットは `MaximumTransferSize * MaximumConcurrency + ~50 MiB` のオーバーヘッド付近で推移するはずです。アップロードサイズに対して線形に増加するものは、パイプラインのどこかにあるバグです。

## 関連

- [ASP.NET Core エンドポイントからバッファリングなしでファイルをストリーム配信する方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) はこの記事のダウンロード側の鏡像を扱います。
- [.NET 11 で大きな CSV をメモリを使い切らずに読む方法](/ja/2026/04/how-to-read-a-large-csv-in-dotnet-11-without-running-out-of-memory/) はパースのためのバウンデッドバッファのストリーミングを扱い、blob storage への途中で変換するときにここのアップロードパターンとよく組み合わさります。
- [長時間実行 Task をデッドロックなしで C# でキャンセルする方法](/ja/2026/04/how-to-cancel-a-long-running-task-in-csharp-without-deadlocking/) は `CancellationToken` の伝播をより深く掘り下げており、複数分にわたるアップロードには重要です。
- [EF Core 11 で `IAsyncEnumerable<T>` を使う方法](/ja/2026/04/how-to-use-iasyncenumerable-with-ef-core-11/) は EF Core からの行が直接 blob に流れるストリーミングエクスポートのケース向けです。

## ソースリンク

- [Azure.Storage.Blobs 12.22 リリースノート](https://github.com/Azure/azure-sdk-for-net/blob/main/sdk/storage/Azure.Storage.Blobs/CHANGELOG.md)
- [block blob のスケーラビリティ目標](https://learn.microsoft.com/en-us/rest/api/storageservices/scalability-targets-for-the-azure-blob-storage-service)
- [Put Block REST API](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block)
- [`StorageTransferOptions` リファレンス](https://learn.microsoft.com/en-us/dotnet/api/azure.storage.storagetransferoptions)
- [ASP.NET Core 大きなファイルアップロードのガイダンス](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads)
