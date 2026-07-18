---
title: "修正: ASP.NET Core エンドポイントへのファイルアップロードで発生する「413 Request Entity Too Large」"
description: "Kestrel はデフォルトでリクエストボディを 30,000,000 バイトに制限し、超過すると 413 を返します。MaxRequestBodySize をグローバル、エンドポイント単位、または IIS の背後では web.config で引き上げましょう。"
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "file-upload"
lang: "ja"
translationOf: "2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-17
---

アップロードが `413 Request Entity Too Large` を返すのは、Kestrel がすべてのリクエストボディをデフォルトで 30,000,000 バイト (約 28.6 MiB) に制限しており、ファイルがそれより大きいためです。上限は実際に効く場所で引き上げてください。Kestrel の `MaxRequestBodySize` をグローバルに設定し、コントローラーのアクションには `[RequestSizeLimit]` または `[DisableRequestSizeLimit]` を付与し、フォーム投稿では `FormOptions.MultipartBodyLengthLimit` を引き上げ、IIS の背後では `web.config` の `maxAllowedContentLength` を引き上げます。ASP.NET Core 11 (.NET 11、C# 14) で検証済みです。上限とデフォルト値は .NET 8 から .NET 11 まで同一です。

## このエラーが起きる状況

現れ方は 2 通りあります。1 つ目はクライアントが受け取る HTTP レスポンスです。

```
HTTP/1.1 413 Request Entity Too Large
Content-Length: 0
Connection: close
Date: Fri, 17 Jul 2026 10:04:11 GMT
```

2 つ目はサーバー側で Kestrel が書き出すログ行で、どの上限が発火したかを正確に教えてくれるのはこちらです。

```
Microsoft.AspNetCore.Server.Kestrel.Core.BadHttpRequestException:
Request body too large. The max request body size is 30000000 bytes.
```

この `30000000` が手がかりです。何も変更していなければ、メッセージ内の数値はフレームワークのデフォルトであり、修正はその上限を所有するレイヤーで上限を引き上げるか撤廃することです。数値が別の値なら、誰かがすでに上限を設定していて、それに引っかかっています。いずれにしても原因は同じで、リクエストボディが設定された最大値を超え、ハンドラーが読み終える前にサーバーが接続を拒否したのです。

## なぜこれが起きるのか

アップロードは 4 つの異なる上限のいずれかでブロックされ得ますが、それらは別々の場所に存在します。正しく修正するには、どれがあなたの `413` を生んだのかを知る必要があります。

- **Kestrel `MaxRequestBodySize`** はリクエストボディ全体をデフォルトで 30,000,000 バイトに制限します。これを超えると Kestrel は `BadHttpRequestException` をスローし、`413` を返します。上記の正確なメッセージを生むのはこれです。
- **`FormOptions.MultipartBodyLengthLimit`** はマルチパートフォームボディの長さをデフォルトで 134,217,728 バイト (128 MiB) に制限します。これを超えるとフォームリーダーが `InvalidDataException` をスローし、それは `413` ではなく `400 Bad Request` として現れます。この 2 つは常に混同されます。
- **IIS `maxAllowedContentLength`** (IIS の背後でホストする場合) は、リクエストがアプリに到達する前に IIS のリクエストフィルタリング層でリクエストを制限します。デフォルトは 30,000,000 バイトです。IIS はこれに対して独自のエラーを返すため、IIS の背後では Kestrel の上限だけを引き上げても何も起きません。
- **リバースプロキシ** (nginx、YARP、API ゲートウェイ、クラウドロードバランサー) は独自のボディ上限を強制し、Kestrel がリクエストを見る前に `413` を返すことがあります。

Kestrel に直接なら動くのにプロキシや IIS の背後で失敗する場合、変更すべき上限はあなたの C# コードにはありません。まず最も外側のレイヤーを確認してください。

## 最小限の再現

デフォルトの `413` を再現する最小のエンドポイントです。カスタムの上限はなく、フレームワークのデフォルトのみです。

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/upload", async (HttpRequest request) =>
{
    // Reading the body is what trips the limit
    using var reader = new StreamReader(request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});

app.Run();
```

30,000,000 バイトより大きいものを POST すると、読み取りがスローします。

```bash
# .NET 11 -- generate a 40 MB file and POST it
head -c 40000000 /dev/urandom > big.bin
curl -i -X POST http://localhost:5000/upload \
  -H "Content-Type: application/octet-stream" \
  --data-binary @big.bin
# -> HTTP/1.1 413 Request Entity Too Large
```

この 40 MB のペイロードは 128 MiB のマルチパート上限はクリアします (そもそもマルチパートではありません) が、30 MB の Kestrel ボディ上限を突破するため、`400` ではなく `413` が返ります。

## 上限を効く場所で引き上げる

`413` がどこから来ているかに応じて、次を順に確認してください。ほとんどの自己ホスト型 Kestrel アプリでは最初の 1 つだけで済みます。

### 1. Kestrel のグローバル上限を引き上げるか撤廃する

`KestrelServerOptions.Limits.MaxRequestBodySize` を起動時に設定します。特定のバイト数を設定するか、上限を完全に撤廃するには `null` を設定します。

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(options =>
{
    // 200 MB ceiling for the whole app
    options.Limits.MaxRequestBodySize = 200 * 1024 * 1024;
});

var app = builder.Build();
```

`null` よりも実際の上限値を優先してください。ボディサイズを無制限にするのはサービス妨害 (DoS) の攻撃経路です。1 つのクライアントがギガバイト単位をプロセスにストリーミングし、メモリやディスクを枯渇させ得ます。ガードを無効化するのではなく、想定される正当なアップロードの最大値を選び、余裕を持たせてください。

### 2. コントローラーに属性でエンドポイント単位の上限を設定する

大きなアップロードを受け付けるエンドポイントが 1 つだけなら、アプリ全体のグローバル上限を引き上げないでください。コントローラーのアクションや Razor Page では、`[RequestSizeLimit(bytes)]` で特定の上限を設定するか、`[DisableRequestSizeLimit]` でそのアクションだけ上限を撤廃します。どちらの属性も `IRequestSizeLimitMetadata` を実装しており、MVC パイプラインがリクエストごとにこれを読み取ります。

```csharp
// .NET 11, ASP.NET Core 11, C# 14
[ApiController]
[Route("api/[controller]")]
public sealed class FilesController : ControllerBase
{
    [HttpPost("upload")]
    [RequestSizeLimit(200 * 1024 * 1024)]   // 200 MB, this action only
    public async Task<IResult> Upload(IFormFile file)
    {
        await using var stream = System.IO.File.Create(
            Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return Results.Ok(new { file.FileName, file.Length });
    }
}
```

アクションが任意に大きいボディを受け付ける必要があり、別のガード (ストリーミングやクォータチェック) が用意されている場合は、`[RequestSizeLimit(...)]` を `[DisableRequestSizeLimit]` に置き換えてください。

### 3. minimal API でリクエストごとに上限を設定する

minimal API はコントローラーのようには `[RequestSizeLimit]` を尊重しません。これを読み取る MVC リソースフィルターがパイプラインに存在しないためです。ボディが読み取られる前に、`IHttpMaxRequestBodySizeFeature` を通じて命令的に上限を設定してください。

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload", async (HttpContext context) =>
{
    var sizeFeature = context.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (sizeFeature is not null && !sizeFeature.IsReadOnly)
    {
        sizeFeature.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
    }

    using var reader = new StreamReader(context.Request.Body);
    var content = await reader.ReadToEndAsync();
    return Results.Ok(new { bytes = content.Length });
});
```

まず `IsReadOnly` を確認してください。サーバーがボディの読み取りを開始すると上限はロックされ、代入すると `InvalidOperationException` がスローされます。これは、この手法が minimal API の `IFormFile` パラメーターでは機能しない理由でもあります。モデルバインディングがハンドラーの実行前にマルチパートボディを読み取るため、フィーチャーに触れられる頃にはすでに読み取り専用になっているのです (これは dotnet/aspnetcore の issue #50871 の根本原因で、minimal API への大きなマルチパートアップロードが切り詰められたファイルとともに `200` を暗黙に返していました)。minimal API のアップロードでは、`HttpContext` または `HttpRequest` をバインドし、上限を引き上げてから `request.ReadFormAsync()` で自分でフォームを読み取るか、`MapGroup` に小さなミドルウェアを付けてグループ全体の上限を設定してください。

### 4. フォーム投稿のためにマルチパートフォーム上限を引き上げる

あなたの `413` が実際にはマルチパートボディ長についての `InvalidDataException` を伴う `400` なら、発火した上限は Kestrel のものではなく `FormOptions.MultipartBodyLengthLimit` です。オプションを通じてグローバルに、またはコントローラーのアクション単位で `[RequestFormLimits]` を使って引き上げます。

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- global, in Program.cs
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = 200 * 1024 * 1024;   // 200 MB
});
```

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- per action
[HttpPost("upload")]
[RequestSizeLimit(200 * 1024 * 1024)]
[RequestFormLimits(MultipartBodyLengthLimit = 200 * 1024 * 1024)]
public async Task<IResult> Upload(IFormFile file) { /* ... */ }
```

大きなアップロードでは通常、両方を引き上げる必要があります。`MaxRequestBodySize` はリクエスト全体を、`MultipartBodyLengthLimit` はその中のフォームボディを支配します。両者を同じ値に設定してください。

### 5. IIS の背後では web.config で maxAllowedContentLength を引き上げる

IIS の背後 (in-process または out-of-process) でホストする場合、IIS のリクエストフィルタリングモジュールが、リクエストが Kestrel に到達する前に `maxAllowedContentLength` (デフォルト 30,000,000 バイト) を強制します。これも引き上げるまで、Kestrel の上限を引き上げても何も起きません。`web.config` に追加してください。

```xml
<!-- web.config -- value is in bytes; 200 MB here -->
<system.webServer>
  <security>
    <requestFiltering>
      <requestLimits maxAllowedContentLength="209715200" />
    </requestFiltering>
  </security>
</system.webServer>
```

in-process ホスティングモジュールには、`IISServerOptions` を通じてコードで設定できる 2 つ目の別個の上限があります。

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- in-process IIS hosting
builder.Services.Configure<IISServerOptions>(options =>
{
    options.MaxRequestBodySize = 200 * 1024 * 1024;   // 200 MB
});
```

IIS の背後では、`web.config` の `maxAllowedContentLength`、`IISServerOptions.MaxRequestBodySize`、Kestrel の `MaxRequestBodySize` の 3 つすべてを揃える必要があるかもしれません。リクエストは最も小さいものによって拒否されます。

### 6. リバースプロキシの上限を引き上げる

アプリの前段にプロキシがある場合、それは独自の上限を持ち、アプリが関与する前に `413` を返します。nginx では、ディレクティブは `client_max_body_size` です (デフォルト 1 MiB で、これは Kestrel のデフォルトよりはるかに小さく、よくある落とし穴です)。

```nginx
# nginx.conf -- allow 200 MB uploads through the proxy
client_max_body_size 200M;
```

YARP、API ゲートウェイ、クラウドロードバランサーでは、そのレイヤーの設定で相当するリクエストサイズの設定を探してください。プロキシがボディを通すまで、アプリ側の上限を引き上げても役に立ちません。

## 落とし穴とバリエーション

- **`413` は `400` ではありません。** `413 Request Entity Too Large` は Kestrel の `MaxRequestBodySize` から来ます。`InvalidDataException: Multipart body length limit ... exceeded` を伴う `400 Bad Request` は `FormOptions.MultipartBodyLengthLimit` から来ます。これらは異なるデフォルト値 (30 MB 対 128 MiB) を持つ別々の上限です。ステータスコードだけでなく例外の型を読んでください。
- **HttpSys は `413` ではなく `500` を返します。** Kestrel の代わりに `HttpSys` でホストする場合、`HttpSysOptions.MaxRequestBodySize` を超えると `413` ではなく `500 Internal Server Error` が生じます。根本原因は同じで、現れる場所が違うだけです。
- **メビバイトではなくバイトです。** デフォルトは `30000000` (3000 万) バイトで、これは 30 MiB ではなく約 28.6 MiB です。「メガバイト」から上限を計算する場合、`1024 * 1024` と `1000 * 1000` のどちらを意味するかを決めて一貫させ、30 MB のファイルが「30 MB」の上限に対して失敗しないようにしてください。
- **本番で `null` に手を伸ばさないでください。** 上限を完全に撤廃すると、すべてのアップロードエンドポイントがメモリやディスクの枯渇の標的になります。寛大な上限とストリーミングを組み合わせ、ファイル全体をバッファリングしないようにしてください。[ASP.NET Core エンドポイントからバッファリングせずにファイルをストリーミングする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) と [大きなファイルをストリーミングで Azure Blob Storage にアップロードする方法](/ja/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) を参照してください。
- **Blazor Server と SignalR には独自の上限があります。** SignalR や Blazor Server の回線を通じた大きなアップロードは、`MaxRequestBodySize` ではなく `HubOptions.MaximumReceiveMessageSize` (デフォルト 32 KB) によって制限されます。それは別の場所にある別の修正です。
- **クライアントが先に接続を閉じることがあります。** `413` はしばしば `Connection: close` とともに届き、一部の HTTP クライアントはそれをきれいな `413` ではなくソケットエラーとして報告します。クライアントのエラー文字列を信じるのではなく、サーバー側の `BadHttpRequestException` をログに記録して実際の原因を確認してください。

メンタルモデルはこうです。アップロードはサイズのゲートのスタック (プロキシ、IIS、Kestrel のボディサイズ、マルチパートフォームサイズ) を通過し、最初に超過したゲートで拒否されます。あなたの `413` を生んだレイヤーを見つけ、その上限を実際の有界な値に引き上げ、より大きな上限がより大きな負債にならないようストリーミングと組み合わせてください。

## 関連

- [ASP.NET Core エンドポイントからバッファリングせずにファイルをストリーミングする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)：大きなファイルをメモリに読み込まずに配信するために。
- [大きなファイルをストリーミングで Azure Blob Storage にアップロードする方法](/ja/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/)：大きなアップロードを直接 blob storage に送るために。
- [修正: ASP.NET Core 11 の minimal API エンドポイントで「415 Unsupported Media Type」が返る](/ja/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/)：リクエストの Content-Type が誤っている場合の兄弟エラーのために。
- [ASP.NET Core 11 で IProblemDetailsService を使って minimal API の検証エラーレスポンスをカスタマイズする方法](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)：素のステータスコードを役立つエラーボディに変えるために。
- [ASP.NET Core 11 の API にレスポンス圧縮を追加する方法](/ja/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)：受信ボディ上限の送信側の対応物のために。

## 出典

- ASP.NET Announcements, [New default 30 MB (~28.6 MiB) max request body size limit](https://github.com/aspnet/Announcements/issues/267) (Kestrel と HttpSys のデフォルト 30,000,000 バイト、Kestrel での `413` と HttpSys での `500`、`MaxRequestBodySize`、`IHttpMaxRequestBodySizeFeature`、`[RequestSizeLimit]` / `[DisableRequestSizeLimit]`、IIS の挙動)。
- Microsoft Learn, [Upload files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/mvc/models/file-uploads?view=aspnetcore-10.0) (`FormOptions.MultipartBodyLengthLimit` のデフォルト 134,217,728 バイト、`[RequestFormLimits]`、`IISServerOptions.MaxRequestBodySize`、`web.config` の `maxAllowedContentLength`)。
- Microsoft Learn, [IRequestSizeLimitMetadata.MaxRequestBodySize](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.metadata.irequestsizelimitmetadata.maxrequestbodysize?view=aspnetcore-10.0) (サイズ上限属性が実装するメタデータインターフェース)。
- dotnet/aspnetcore, [Minimal API endpoints accepting IFormFile terminating with HTTP 200 for large files](https://github.com/dotnet/aspnetcore/issues/50871) (minimal API でマルチパートボディがバインドされた後に `IHttpMaxRequestBodySizeFeature` を設定できない理由)。
