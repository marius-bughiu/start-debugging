---
title: "ASP.NET Core の UseExceptionHandler が 413 を 500 に変えなくなります"
description: "2026-08-19 に dotnet/aspnetcore の main へ取り込まれた PR により、ExceptionHandlerMiddleware は BadHttpRequestException.StatusCode を 500 で上書きせず尊重するようになります。"
pubDate: 2026-08-20
tags:
  - "aspnetcore"
  - "dotnet"
  - "error-handling"
  - "dotnet-11"
lang: "ja"
translationOf: "2026/08/aspnetcore-exception-handler-preserves-badhttprequestexception-status-codes"
translatedBy: "claude"
translationDate: 2026-08-20
---

本番環境で `app.UseExceptionHandler()` を使っている場合、Kestrel がサイズ超過で拒否したリクエストは、これまでテレメトリ上でサーバー障害として記録されてきました。[PR #68632](https://github.com/dotnet/aspnetcore/pull/68632) が 2026-08-19 に `dotnet/aspnetcore` の `main` へ入り、これを修正します。2022 年 9 月に登録された [issue #43831](https://github.com/dotnet/aspnetcore/issues/43831) をクローズするものです。

## 実体は 413 だった 500

`ExceptionHandlerMiddleware` は、あなたのハンドラーを呼び出す前にレスポンスのステータスコードを設定します。この PR までは、`ExceptionHandlerOptions.StatusCodeSelector` が null のとき 500 が固定で入っていました。`BadHttpRequestException` は独自の `StatusCode` を持っていますが、その値は捨てられていたのです。

ASP.NET Core 10.0.0、SDK 10.0.201 で確認した形は次のとおりです。

```csharp
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 100);

var app = builder.Build();
app.UseExceptionHandler();

app.MapPost("/upload", async (HttpContext ctx) =>
{
    using var ms = new MemoryStream();
    await ctx.Request.Body.CopyToAsync(ms);   // throws when the body exceeds 100 bytes
    return Results.Ok(ms.Length);
});

app.Run();
```

`/upload` に 500 バイトを `POST` してみてください。ミドルウェアに到達する例外は `StatusCode = 413` を持つ `BadHttpRequestException` で、メッセージは "Request body too large. The max request body size is 100 bytes." です。しかし実際に返ってくるレスポンスはこれです。

```
HTTP/1.1 500 Internal Server Error
Content-Type: application/problem+json

{"type":"https://tools.ietf.org/html/rfc9110#section-15.6.1",
 "title":"An error occurred while processing your request.","status":500,...}
```

クライアントは「あなたがサーバーを壊した」と伝えられます。5xx のダッシュボードも同じ見解です。[ファイルアップロード時の 413 Request Entity Too Large](/ja/2026/07/fix-413-request-entity-too-large-uploading-a-file-in-aspnetcore-11/) と同種の混乱ですが、こちらは正しいステータスがそもそもネットワークまで届きません。

## 何が変わったのか

ミドルウェアは 500 にフォールバックする前に、例外に対してパターンマッチングを行うようになりました。

```csharp
context.Response.StatusCode = _options.StatusCodeSelector?.Invoke(edi.SourceException)
    ?? (edi.SourceException switch
    {
        BadHttpRequestException badHttpRequestException => badHttpRequestException.StatusCode,
        _ => DefaultStatusCode,
    });
```

押さえておきたい点が 3 つあります。`StatusCodeSelector` を設定していればこれまでどおり優先されるので、既存の上書きは挙動が変わりません。独自の `ExceptionHandler` デリゲートや `IExceptionHandler` サービスは、その後でコードを変更できます。そして `BadHttpRequestException` が運ぶ 404 は、設定ミスのハンドラーではなく意図的なものとして扱われるようになり、生き残るために `AllowStatusCode404Response = true` を必要としなくなりました。

対象範囲は意図的に狭く、再マッピングされるのは `BadHttpRequestException` だけです。`text/plain` のボディで `Request.ReadFormAsync()` を呼ぶと `InvalidOperationException` ("Incorrect Content-Type") が発生しますが、これは変更の前後どちらでも 500 のままです。minimal API のモデルバインドも影響を受けません。不正な JSON ボディは、例外が外へ抜ける前に request delegate によって素の 400 に変換されるからです。

執筆時点で、このコミットは `main` にのみ存在します。`release/11.0-rc1` ブランチには入っていないため、RC1 ではなくそれ以降の .NET 11 ビルドで届くと考えてください。今日 .NET 8 から 11 を使っているなら、回避策は従来どおり、例外を自分で取り出す `StatusCodeSelector` です。
