---
title: "修正: System.InvalidOperationException: Headers are read-only, response has already started"
description: "ボディがすでにフラッシュされた後にヘッダー、ステータスコード、または content type を設定しています。最初の書き込みの前にすべてのヘッダーを設定するか、HttpResponse.HasStarted と OnStarting で保護してください。"
pubDate: 2026-07-17
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
lang: "ja"
translationOf: "2026/07/fix-headers-are-read-only-response-has-already-started-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-07-17
---

修正方法: 何かがすでにレスポンスボディに書き込み、その結果ヘッダーがクライアントへフラッシュされて読み取り専用になった後で、あなたのコードがヘッダー、ステータスコード、または content type を設定しようとしています。ASP.NET Core では、`HttpResponse.StatusCode`、`HttpResponse.ContentType`、そして `HttpResponse.Headers` にあるすべては、ボディの最初のバイトが書き込まれる**前**に設定しなければなりません。ヘッダーとステータスの代入をすべて、あらゆる `WriteAsync`、`Redirect`、またはボディを書き込む下流のミドルウェアより前に移動してください。順序を制御できない場合は、`if (!context.Response.HasStarted)` で代入を保護するか、`HttpResponse.OnStarting` に作業を登録して、ヘッダーがフラッシュされる直前の瞬間に実行されるようにします。このガイドは ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4)、C# 14、Kestrel 11.0.0-preview.4 に対して書かれています。この挙動は ASP.NET Core 3.0 まで遡って同一です。

```text
System.InvalidOperationException: Headers are read-only, response has already started.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpResponseHeaders.ThrowHeadersReadOnlyException()
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpHeaders.Microsoft.AspNetCore.Http.IHeaderDictionary.set_Item(String key, StringValues value)
   at MyApp.SecurityHeadersMiddleware.InvokeAsync(HttpContext context)
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpProtocol.ProcessRequests[TContext](IHttpApplication`1 application)
```

スタックトレースはほぼ常に Kestrel 内部の `ThrowHeadersReadOnlyException`(または HTTP.sys や IIS の相当物)で終わります。その直上のフレームが、ミューテーションを試みた行です。そのフレームが犯人です。レスポンスがすでに開始した後に、ヘッダー、`StatusCode`、`ContentType` を設定するか `Redirect` を呼び出しています。

## 最初の書き込みの後にヘッダーを設定するのが不可能な理由

HTTP はワイヤー上で順序付けられています。ステータス行、次にヘッダー、次に空行、次にボディです。サーバーがヘッダーブロックをクライアントに送信してしまうと、それを取り消すことはできません。ASP.NET Core はこれを、レスポンスが開始した瞬間にヘッダーコレクションを読み取り専用にすることでモデル化しており、変更を黙って破棄するのではなく例外を投げます。黙って無視されたセキュリティヘッダーや content type は、騒がしい例外よりもはるかに深刻なバグだからです。

レスポンスを開始するものは 2 つあります。ドキュメントははっきりとこう述べています。"An app can't modify headers after the response has started. Once the response starts, the headers are sent to the client. A response is started by flushing the response body or calling `HttpResponse.StartAsync(CancellationToken)`." そのうち最初のものが人々を噛みます。暗黙的だからです。ボディを書き込むとフラッシュされます。"Unless response buffering is enabled, all write operations (for example, `WriteAsync`) flush the response body internally and mark the response as started. Response buffering is disabled by default." したがって、最初の `WriteAsync`、`Response.Body` への最初の `CopyToAsync`、`Response.BodyWriter` 上の最初の `FlushAsync`、そしてコンテンツをストリームする結果を返すことは、`HttpResponse.HasStarted` を `true` に変え、ヘッダーを凍結します。

だからこそ `HttpResponse.StatusCode`、`HttpResponse.ContentType`、`HttpResponse.Headers` はそれぞれ "Must be set before writing to the response body." と文書化されています。これらは助言的な注記ではありません。契約であり、例外はその強制です。

## 最小限の再現

最小のバージョンはボディを書き込み、その後ヘッダーを設定しようとします。

```csharp
// ASP.NET Core 11, C# 14
using Microsoft.AspNetCore.Builder;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/broken", async (HttpContext context) =>
{
    await context.Response.WriteAsync("Processing...");   // flushes: HasStarted is now true
    context.Response.Headers["X-Trace-Id"] = "abc123";     // throws: headers are read-only
});

app.Run();
```

`WriteAsync` の呼び出しがボディをフラッシュし、ヘッダーを送信します。次の行が `X-Trace-Id` を追加しようとし、Kestrel が `InvalidOperationException: Headers are read-only, response has already started` を投げます。同じ形がステータスコードでも現れます。

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-status", async (HttpContext context) =>
{
    await context.Response.WriteAsync("partial output");
    context.Response.StatusCode = 500;   // throws for the same reason
});
```

そしてリダイレクトでも現れます。`Redirect` は `Location` ヘッダーと 302 ステータスの両方を設定するからです。

```csharp
// ASP.NET Core 11, C# 14
app.MapGet("/broken-redirect", async (HttpContext context) =>
{
    await context.Response.WriteAsync("about to redirect");
    context.Response.Redirect("/login");   // throws: Location header is read-only
});
```

## ヘッダーが先に来るよう並べ替える

主要な修正であり、コードが自分の制御下にあるときは常に手を伸ばすべきものは、ボディに何かを書き込む前に、各ヘッダー、ステータスコード、content type を設定することです。エンドポイントやコントローラーでは、これは通常 1 行の移動です。

```csharp
// ASP.NET Core 11, C# 14 -- correct order
app.MapGet("/fixed", async (HttpContext context) =>
{
    context.Response.StatusCode = 200;
    context.Response.ContentType = "text/plain";
    context.Response.Headers["X-Trace-Id"] = "abc123";   // set before any write

    await context.Response.WriteAsync("Processing...");  // now safe to flush
});
```

`Response.Body` に手作業で書き込むよりも、`IResult`(minimal APIs)や `IActionResult`(MVC)を返すことを優先してください。`Results.Text`、`Results.Json`、`Results.File`、`TypedResults` はヘッダーを含むレスポンス全体を構築し、その後で初めて書き込むため、このエラーに躓くことは決してありません。[minimal API エンドポイントからの型付き Results ユニオン](/ja/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)に手を伸ばせば、ステータスとヘッダーが宣言的なままになり、手作業の順序という危険を完全に取り除けます。

## HasStarted でミドルウェアを保護する

より難しいケースは、`await next(context)` を実行した後にレスポンスに触れたいミドルウェアです。`next` が戻る頃には、下流のエンドポイントが通常すでにボディを書き込んでいるため、レスポンスは開始しており、どんなヘッダー変更も例外を投げます。これはこのエラーの最も一般的な発生源であり、典型的な犯人は次のように書かれた「security headers」や「correlation id」ミドルウェアです。

```csharp
// ASP.NET Core 11, C# 14 -- broken middleware
app.Use(async (context, next) =>
{
    await next(context);   // endpoint writes the body here; response starts
    context.Response.Headers["X-Frame-Options"] = "DENY";   // throws
});
```

正しいパターンは 2 つあり、選択はヘッダーを無条件に設定しなければならないかどうかによって決まります。

**作業を `OnStarting` に登録する。** `HttpResponse.OnStarting` は、ボディをあなたのミドルウェアが書くか下流の何かが書くかにかかわらず、ヘッダーをフラッシュする直前にサーバーがちょうど一度だけ実行するコールバックを受け取ります。`next` を呼び出す前にそれを登録すれば、ヘッダーは最後の安全な瞬間に書き込まれます。

```csharp
// ASP.NET Core 11, C# 14 -- correct: set headers just before they flush
app.Use(async (context, next) =>
{
    context.Response.OnStarting(() =>
    {
        context.Response.Headers["X-Frame-Options"] = "DENY";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        return Task.CompletedTask;
    });

    await next(context);
});
```

これは横断的なレスポンスヘッダーに適したツールです。下流のコードがすぐにストリームを始めても機能するからです。これは ASP.NET Core 自身のヘッダーミドルウェアが内部で使うのと同じメカニズムです。

**`HasStarted` で保護する。** ヘッダーがレスポンスがまだコミットしていない場合にのみ重要なとき(たとえば、失敗を 500 に変えたい例外ハンドラー)は、まず `HttpResponse.HasStarted` を確認し、`true` のときはミューテーションをスキップします。

```csharp
// ASP.NET Core 11, C# 14 -- defensive guard
app.Use(async (context, next) =>
{
    try
    {
        await next(context);
    }
    catch (Exception)
    {
        if (!context.Response.HasStarted)
        {
            context.Response.Clear();
            context.Response.StatusCode = 500;
            await context.Response.WriteAsync("Something went wrong.");
        }
        throw;   // nothing safe to do if the response already started
    }
});
```

`HttpResponse.Clear()` はステータスコード、ヘッダー、バッファされたボディをリセットしますが、`HasStarted` が `false` の間だけ機能します。ボディがいったんストリームを始めたら、ステータスやヘッダーを変えるためにできることは本当に何もなく、正直な手は、例外を伝播させるか `HttpContext.Abort()` を呼び出して接続を断ち、クライアントが嘘ではなく壊れたレスポンスを見るようにすることです。だからこそ、組み込みの例外ハンドラーと[ASP.NET Core 11 のグローバル例外フィルター](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)はどちらも、problem-details ボディを書く前に `HasStarted` を確認し、すでに手遅れのときは再スローします。

## ミドルウェアがボディを書き換えなければならないときはボディをバッファする

一部のミドルウェアは、下流のレスポンスを本当に読み取ったり変換したりする必要があります。HTML を最小化する、script タグを注入する、コンテンツを圧縮するといった処理をし、その後で初めて `Content-Length` や `Content-Encoding` ヘッダーを設定します。ボディがすでにクライアントへフラッシュされていると、それはできません。修正方法は、レスポンスボディをバッファと入れ替え、下流にバッファへ書き込ませ、その後ヘッダーを設定してバッファを本物のボディへコピーすることです。

```csharp
// ASP.NET Core 11, C# 14 -- buffer downstream output, then set headers
app.Use(async (context, next) =>
{
    var originalBody = context.Response.Body;
    using var buffer = new MemoryStream();
    context.Response.Body = buffer;

    await next(context);   // downstream writes into the MemoryStream, not the socket

    // Response has NOT started: the real body was never touched.
    context.Response.Headers["Content-Length"] = buffer.Length.ToString();
    buffer.Position = 0;
    context.Response.Body = originalBody;
    await buffer.CopyToAsync(originalBody);
});
```

下流の書き込みが接続ではなく `MemoryStream` に行ったため、`HasStarted` は `false` のままで、ヘッダーの代入は成功します。これはレスポンスを変換するミドルウェアが行うことの手作業版です。フレームワークがサポートする方法は、`Response.Body` を直接代入するのではなく `IHttpResponseBodyFeature` を通して作業することですが、バッファリングの原則は同じです。目的が特に圧縮であれば、手作りしないでください。[ASP.NET Core 11 API でのレスポンス圧縮](/ja/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)に手を伸ばせば、レスポンス全体をメモリにバッファすることなく、ネゴシエーションと `Content-Encoding` ヘッダーを代わりに処理してくれます。

## 落とし穴とよく似たもの

**`Response.Redirect` はヘッダー書き込みに数えられます。** リダイレクトは `Location` ヘッダーと 3xx ステータスを設定するため、ボディを書き込んだ後にそれを呼び出すとまさにこの例外を投げます。すでに出力を書き込んだアクションの内部からリダイレクトしていることに気づいたら、本当のバグはリダイレクトの決定が遅すぎたことです。それを最初の書き込みの前に移動してください。

**ストリーミングエンドポイントのヘッダーの窓は極めて小さいです。** [バッファリングなしでエンドポイントからファイルをストリームする](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)とき、レスポンスは最初のチャンクがフラッシュされる瞬間に開始します。必要な `Content-Disposition` や `Content-Type` はすべて、その最初の `WriteAsync` の前に設定しなければなりません。ストリームの途中でエラーが起きても 500 に切り替えることはできません。200 のヘッダーブロックがすでにワイヤー上にあるからです。接続は単に終了します。ストリーミングハンドラーは、すべてを検証し、すべてのヘッダーを前もって設定するように設計してください。

**これは同期 I/O のエラーではありません。** `Headers are read-only, response has already started` は*順序*についてであり、同期か非同期かについてではありません。メッセージが代わりに `Synchronous operations are disallowed` と読める場合、それは別の修正を持つ別の問題であり、[InvalidOperationException: Synchronous operations are disallowed](/ja/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed)で扱っています。この 2 つを混同しないでください。`WriteAsync` を `Write` に切り替えてもここでは役立たず、並べ替えてもあちらでは役立ちません。

**Blazor と Identity は間接的にこれを表面化させます。** インタラクティブな Blazor コンポーネントと ASP.NET Core Identity のフローは、フレームワークコードからこれを引き起こすことがあります。典型的には、コンポーネントがレンダー開始後に cookie を設定したりリダイレクトしようとしたとき、または render mode の不一致が認証の実行前に出力を強制したときです。スタックトレースが自分のミドルウェアではなく Blazor のレンダーを指している場合は、最初のレンダーの後に起きている `NavigationManager.NavigateTo` や cookie の書き込みを確認し、隣接する render mode の問題については[a render mode is not supported by the parent component's render mode](/ja/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor)を参照してください。

**ミドルウェアの順序が勝者を決めます。** ヘッダーを設定するミドルウェアは、終端のミドルウェアがボディを書き込む前に、`OnStarting` コールバックを登録するかヘッダーを設定した場合にのみ機能します。カスタムのヘッダーミドルウェアが、それに到達するパスについてパイプライン内で `UseStaticFiles` やエンドポイントミドルウェアの*後*に位置していると、すでに手遅れです。横断的なレスポンスミドルウェアは `Program.cs` の早い段階で登録してください。

**例外パスでの二重書き込み。** 頻出する本番のトリガーは、部分的な成功レスポンスを書き込み、その後例外に遭遇し、外側のハンドラーがエラーでそれを上書きしようとするコードです。最初の書き込みがすでにレスポンスを開始しています。失敗しうるものすべてを最初のバイトを書き込む前に検証して集めておき、書き込みがハンドラーの最後にすることであって最初ではないようにしてください。

## 関連記事

- [ASP.NET Core 11 でグローバル例外フィルターを追加する方法](/ja/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/)は、実際の例外ハンドラーでの `HasStarted` 保護を示します。
- [バッファリングなしで ASP.NET Core エンドポイントからファイルをストリームする方法](/2026/07/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/)は、ストリームされるレスポンスがいつヘッダーをコミットするかを正確に説明します。
- [ASP.NET Core 11 API にレスポンス圧縮を追加する方法](/ja/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/)は、手作業のバッファなしにボディを変換するサポートされた方法です。
- [minimal API エンドポイントから型付き Results ユニオンを返す方法](/ja/2026/07/how-to-return-a-typed-results-union-from-a-minimal-api-endpoint-in-aspnetcore-11/)は、ステータスとヘッダーを宣言的に保ち、順序が誤りようがないようにします。
- [修正: InvalidOperationException: Synchronous operations are disallowed](/ja/2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed)は、似て見えるが別物であるもう一つの InvalidOperationException です。

## 出典

- [Use HttpContext in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/use-http-context?view=aspnetcore-10.0)、Microsoft Learn。ヘッダー、`StatusCode`、`ContentType` は書き込みの前に設定しなければならないというルール、正確な例外テキスト、バッファリングがデフォルトで無効なため `WriteAsync` がレスポンスをフラッシュして開始するという注記について。
- [HttpResponse.HasStarted](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.hasstarted)、.NET API ドキュメント。レスポンスがコミットしたかどうかを検出することについて。
- [HttpResponse.OnStarting](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.httpresponse.onstarting)、.NET API ドキュメント。ヘッダーがフラッシュされる直前に実行される作業を登録することについて。
- [Write custom ASP.NET Core middleware](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/middleware/write?view=aspnetcore-10.0)、Microsoft Learn。誰が最初にボディを書き込むかを決めるパイプラインの順序について。
