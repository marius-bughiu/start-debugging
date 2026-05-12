---
title: "修正: InvalidOperationException: Synchronous operations are disallowed"
description: "Stream.Read または Write の呼び出しを ReadAsync/WriteAsync に置き換えます。最終手段として、Kestrel、IIS、または IHttpBodyControlFeature 経由でリクエスト単位に AllowSynchronousIO を設定します。"
pubDate: 2026-05-12
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "aspnetcore-11"
  - "kestrel"
lang: "ja"
translationOf: "2026/05/fix-invalidoperationexception-synchronous-operations-are-disallowed"
translatedBy: "claude"
translationDate: 2026-05-12
---

修正方法: ASP.NET Core 3.0 以降は `HttpRequest.Body` および `HttpResponse.Body` に対する同期の読み取り・書き込みをデフォルトで無効化しているため、`Stream.Read`、`Stream.Write`、`Stream.Flush`、`StreamReader.ReadToEnd`、`StreamWriter.Write`、または `JsonSerializer.Deserialize(stream)` を呼び出すコードはすべて `InvalidOperationException: Synchronous operations are disallowed` をスローします。クリーンな修正は、呼び出しを非同期の同等メソッド (`ReadAsync`、`WriteAsync`、`DeserializeAsync`) に切り替えて `await` することです。呼び出し側を変更できない場合は、Kestrel もしくは IIS で `AllowSynchronousIO = true` を有効にするか、問題となるリクエストに対してのみ `IHttpBodyControlFeature.AllowSynchronousIO` を切り替えてください。

```text
System.InvalidOperationException: Synchronous operations are disallowed. Call ReadAsync or set AllowSynchronousIO to true instead.
   at Microsoft.AspNetCore.Server.Kestrel.Core.Internal.Http.HttpRequestStream.Read(Byte[] buffer, Int32 offset, Int32 count)
   at System.IO.Stream.CopyTo(Stream destination, Int32 bufferSize)
   at Newtonsoft.Json.JsonSerializer.DeserializeInternal(JsonReader reader, Type objectType)
   at MyApp.LegacyHandler.Parse(HttpRequest request)
```

このガイドは ASP.NET Core 11 (`Microsoft.AspNetCore.App` 11.0.0-preview.4) と Kestrel 11.0.0-preview.4 を対象に書かれています。このチェックは 3.0.0-preview3 (2019 年 2 月) から有効で、Kestrel、HTTP.sys、IIS in-process、`TestServer` に適用されます。例外のテキストはバージョンを通じて同一であり、変わったのはデフォルトのサーバー設定とその周辺の便利な API だけです。

## なぜサーバーは同期 I/O をデフォルトでブロックするのか

リクエストハンドラー内でブロックされたスレッドはすべて、アプリケーションの残りの部分から利用できないスレッドです。遅いクライアント接続に対する同期の `Stream.Read` は、スレッドプールのスレッドを数秒間占有することがあります。負荷がかかるとプールがスレッドを使い切り、リクエストレイテンシが急上昇し、CPU はアイドルなのにプロセスがハングしているように見える状態になります。このパターン、すなわちスレッドプール飢餓は、ASP.NET Core 1.x や 2.x で、バースト的なトラフィックの下でアプリケーションが固まる長い尾を引く本番障害の原因でした。

3.0 のリリースでは、すべての組み込みサーバーで `AllowSynchronousIO` が `true` から `false` に切り替えられました。ランタイムは現在、同期呼び出しを黙ってブロックさせるのではなく、能動的に拒否します。この例外はバグではなく、サーバーがその呼び出しはネットワーク読み書きの所要時間の間スレッドをブロックすることになると伝えているのです。これを理解すれば、「修正」は「チェックをオフにする」ではなく「スレッドをブロックするのをやめる」になります。

ランタイムチームのアナウンスである [aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644) には、影響を受けるサーバーと推奨される `IHttpBodyControlFeature` の抜け道がリストされています。

## 最小再現

```csharp
// ASP.NET Core 11, C# 14, Newtonsoft.Json 13.0.4
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapPost("/legacy", (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = reader.ReadToEnd();                      // throws
    return Results.Ok(json.Length);
});

app.Run();
```

`StreamReader.ReadToEnd` は内部で `Stream.Read` を呼び出します。Kestrel の `HttpRequestStream` は `Read` をオーバーライドし、`AllowSynchronousIO` が `false` のときに即座にスローします。同じ形のエラーは次のいずれの呼び出し側でも発生します:

- `System.Text.Json` の `JsonSerializer.Deserialize<T>(request.Body)`。
- `request.Body` を渡したときの `Newtonsoft.Json` の `JsonSerializer.Create().Deserialize(...)`。
- リクエストボディを転送するための `request.Body.CopyTo(target)`。
- カスタムミドルウェアからの `response.Body.Write(buffer, 0, count)`。
- `XmlSerializer.Deserialize(request.Body)`。
- リクエスト/レスポンスストリームに対して内部で `Stream.Read` や `Stream.Write` を呼ぶサードパーティライブラリ全般。

スタックトレースはあなたの味方です。下から上に向かって読み、サーバーのストリームに到達した同期 API を見つけてください。

## 修正 1: 非同期 API に切り替える (推奨)

これが本当に根本原因を解決する唯一の修正です。一般的な API のほぼすべてに非同期版の姉妹メソッドがあります。

```csharp
// ASP.NET Core 11, C# 14
app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var json = await reader.ReadToEndAsync();
    return Results.Ok(json.Length);
});
```

JSON については、payload 全体を文字列として実体化することのない `System.Text.Json` のストリーミングデシリアライザーを優先してください:

```csharp
// ASP.NET Core 11, System.Text.Json 11.0.0-preview.4
using System.Text.Json;

app.MapPost("/orders", async (HttpRequest request) =>
{
    var order = await JsonSerializer.DeserializeAsync<Order>(
        request.Body,
        cancellationToken: request.HttpContext.RequestAborted);
    return Results.Ok(order);
});

record Order(string Sku, int Quantity);
```

最小 API でモデルを読み取る場合、最もシンプルな修正はフレームワークにバインドさせることです。最小 API および MVC の `[FromBody]` パラメーターはどちらも非同期にデシリアライズされるため、同期 I/O のチェックが発火することはありません。

```csharp
app.MapPost("/orders", (Order order) => Results.Ok(order));
```

Newtonsoft.Json の移行先は `System.Text.Json` とその非同期デシリアライザーです。移行できない場合は、まずボディを `MemoryStream` に非同期でコピーし、そのバッファを Newtonsoft に渡してください:

```csharp
// ASP.NET Core 11, Newtonsoft.Json 13.0.4
using Newtonsoft.Json;

app.MapPost("/legacy", async (HttpRequest request) =>
{
    using var ms = new MemoryStream();
    await request.Body.CopyToAsync(ms);
    ms.Position = 0;

    using var reader = new StreamReader(ms);
    using var jsonReader = new JsonTextReader(reader);
    var serializer = new JsonSerializer();
    var order = serializer.Deserialize<Order>(jsonReader);
    return Results.Ok(order);
});
```

Newtonsoft の同期 `Deserialize` は Kestrel のリクエストストリームではなく `MemoryStream` に対して動作するため、チェックを通過します。このパターンは同期専用のサードパーティパーサーをラップする場合にも有効です。より長期的な計画については [Newtonsoft.Json から System.Text.Json への移行](/ja/2026/04/how-to-write-a-custom-jsonconverter-in-system-text-json/) の観点を参照してください。

## 修正 2: AllowSynchronousIO をサーバー全体で有効にする

非同期 API をまったく持たないライブラリに縛られている場合は、サーバー側で同期 I/O を再び有効にすることができます。これはグローバルな抜け道であり、削除するための追跡可能な計画とセットにすべきです。設定は実行しているサーバーによって異なります。

**Kestrel:**

```csharp
// ASP.NET Core 11
builder.WebHost.ConfigureKestrel(options =>
{
    options.AllowSynchronousIO = true;
});
```

**IIS in-process:**

```csharp
// ASP.NET Core 11
builder.Services.Configure<IISServerOptions>(options =>
{
    options.AllowSynchronousIO = true;
});
```

**HTTP.sys:**

```csharp
// ASP.NET Core 11
builder.WebHost.UseHttpSys(options =>
{
    options.AllowSynchronousIO = true;
});
```

公式の Kestrel ドキュメントは、このプロパティが `KestrelServerOptions` 上にあり、デフォルトは `false` であることを確認しています。[Configure options for the ASP.NET Core Kestrel web server](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io) を参照してください。これをすべての箇所で設定するとチェックは消えますが、デフォルトが防ぐために追加されたスレッド飢餓のリスクも戻ってきます。このフラグは「非同期への移行がまだ終わっていない」というラベルとして扱い、恒久的な設定としては扱わないでください。

## 修正 3: 1 つのリクエストに対して同期 I/O を有効にする

同期依存があるエンドポイントが 1 つだけなら、サーバー全体のスイッチを切り替えないでください。`IHttpBodyControlFeature` を使ってそのリクエストに対してのみオプトインしましょう。理想的には、対象ルートにスコープを絞ったミドルウェア内で行います。

```csharp
// ASP.NET Core 11
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/legacy/export", (HttpContext ctx) =>
{
    var feature = ctx.Features.Get<IHttpBodyControlFeature>();
    if (feature is not null)
    {
        feature.AllowSynchronousIO = true;
    }

    using var writer = new StreamWriter(ctx.Response.Body);
    writer.Write("<huge legacy XML payload>");
    return Results.Empty;
});
```

この機能は、本来スローするはずだった最初の呼び出しよりも前に切り替えなければなりません。先にボディを読んだあとでフラグを立てても、読み取りはすでに失敗しています。MVC の場合の同等物は、`OnActionExecuting` で動作し、モデルバインダーがボディを読む前に機能を切り替えるフィルターです。

このリクエスト単位のアプローチは、アプリケーションの残りの部分をデフォルトの保護下に置いたままにします。モダンな非同期エンドポイントに囲まれたレガシーエンドポイントが 1 つだけある、という状況での正解です。

## 落とし穴と似た例

**例外が別の問題を覆い隠していることがあります。** `await Response.WriteAsync(...)` の後の `Response.Body.Write(...)` は、開発者がすべて非同期だと思っていても同じ例外をスローすることがあります。原因はたいてい、ロガーの内部に隠れた `Flush` 呼び出しや、キャンセルトークンを受け取らない `JsonSerializer` です。一番上のフレームだけでなく、スタックトレース全体を読みましょう。

**`HttpRequest.ReadFormAsync` がフォームデータの安全な形式です。** このエラーに至るよくある経路が `request.Form["..."]` で、これは内部で `Read` を呼ぶ同期のアクセサーです。`await request.ReadFormAsync()` に切り替え、その結果の `IFormCollection` にアクセスしてください。

**`Response.Body.Seek` や `CopyTo` を呼ぶログ出力ミドルウェア。** レスポンスをキャプチャするカスタムミドルウェアは、ほぼ必ずこのチェックに引っかかります。`CopyTo` を `CopyToAsync` に置き換え、ラッパーストリーム上のブロッキング読み取りを非同期オーバーロードに置き換えてください。

**TestServer の一部のシナリオではチェックが発火しません。** `TestServer` は必ずしも Kestrel と同じ `IHttpBodyControlFeature` をセットアップしません。テストでは動くコードが本番ではスローすることがあります。リリース前に Kestrel に対するスモークテストをローカルで実施してください。

**`AllowSynchronousIO = true` を設定しても、非同期関連のエラーがすべて沈黙するわけではありません。** これは同期 I/O チェックだけを変えます。クライアント切断による `TaskCanceledException` は別の問題です。このファミリーのエラーについては [TaskCanceledException: A task was canceled in HttpClient の記事](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) を参照してください。

**JSON 特有の似たエラー。** `JsonException: The JSON value could not be converted to System.DateTime` はデシリアライゼーションのフォーマットエラーであって I/O エラーではありませんが、どちらもリクエストハンドラーの内部で表面化します。スタックフレームが `System.Text.Json` で終わっている場合は、代わりに [DateTime デシリアライゼーションのガイド](/ja/2026/05/fix-the-json-value-could-not-be-converted-to-system-datetime/) を見てください。

**`DisposeAsync` は重要です。** サーバーが渡してきたストリームに対して同期の `Dispose` を呼ぶと、暗黙的に `Flush` (つまり書き込み) を呼ぶことがあります。`HttpContext` から取得するストリームには `await using` を使ってください。

```csharp
// ASP.NET Core 11
await using var writer = new StreamWriter(response.Body);
await writer.WriteAsync("done");
```

`await using` パターンは、この例外からリクエストを救う最初の場面で元が取れる、小さな良い習慣の 1 つです。

## 関連

- [ASP.NET Core エンドポイントからバッファなしでファイルをストリーミングする方法](/ja/2026/04/how-to-stream-a-file-from-an-aspnetcore-endpoint-without-buffering/) は、大きなレスポンスを書き出すときにランタイムが期待する非同期パターンを扱います。
- [Azure Blob Storage に大きなファイルをストリーミングでアップロードする方法](/ja/2026/04/how-to-upload-a-large-file-with-streaming-to-azure-blob-storage/) は、書き込み側の対応するガイドです。
- [HttpClient を使うコードをユニットテストする方法](/ja/2026/04/how-to-unit-test-code-that-uses-httpclient/) は、リクエストやレスポンスのボディを触る任意のハンドラーの周りに用意したい非同期のテスト基盤を示します。
- [修正: A second operation was started on this context instance before a previous operation completed](/ja/2026/05/fix-second-operation-was-started-on-this-context-instance/) は、このエラーの EF Core 版のいとこです。ランタイムが sync-over-async のミスを捕捉するもう 1 つのケースです。
- [修正: TaskCanceledException: A task was canceled in HttpClient](/ja/2026/05/fix-taskcanceledexception-a-task-was-canceled-httpclient/) は、クライアント側のタイムアウトという関連するファミリーです。

## 参考資料

- [Configure options for the ASP.NET Core Kestrel web server, Synchronous I/O](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/servers/kestrel/options?view=aspnetcore-10.0#synchronous-io) (MS Learn, .NET 10 / 11)
- [Announcement: AllowSynchronousIO disabled in all servers, dotnet/aspnetcore#7644](https://github.com/dotnet/aspnetcore/issues/7644)
- [ASP.NET Core breaking changes for versions 3.0 and 3.1](https://learn.microsoft.com/en-us/dotnet/core/compatibility/aspnetcore)
- [`KestrelServerOptions.AllowSynchronousIO` API リファレンス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.server.kestrel.core.kestrelserveroptions.allowsynchronousio)
- [`IHttpBodyControlFeature` インターフェイス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.features.ihttpbodycontrolfeature)
