---
title: "修正: ASP.NET Core 11 の minimal API エンドポイントで「415 Unsupported Media Type」が返る"
description: "リクエストの Content-Type がエンドポイントのバインド対象と一致しないと、minimal API は 415 を返します。ボディにバインドする型には Content-Type: application/json を送信し、フォームやファイルアップロードには [FromForm] を使ってください。"
pubDate: 2026-07-06
template: error-page
tags:
  - "errors"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-apis"
lang: "ja"
translationOf: "2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-06
---

minimal API エンドポイントは、リクエストボディの `Content-Type` ヘッダーがルートハンドラーのバインドしようとしている対象と一致しないとき、`415 Unsupported Media Type` を返します。もっとも多い原因は、ハンドラーのパラメーターがボディからバインドされる複合型で、これには `Content-Type: application/json` が必要なのに、クライアントがコンテンツタイプを送らなかった、`text/plain` を送った、あるいはフォームデータを送った、というものです。修正するには、JSON ボディには `Content-Type: application/json` を送信し、クライアントが `application/x-www-form-urlencoded` または `multipart/form-data` を POST する場合はパラメーターに `[FromForm]` を付けてください。これは .NET 11 上の ASP.NET Core 11 と C# 14 で検証しています。この挙動は .NET 8 から .NET 10 まで同一です。

## このエラーが起きる状況

ほとんどの例外とは違い、これはあなたのコードには一切到達しません。minimal API のバインド層が、ハンドラーが実行される前にリクエストを拒否し、素の `415` をクライアントに書き戻します。スタックトレースもなく、デフォルトでは `ProblemDetails` ボディもなく、ステータス行だけが返ります。

```
HTTP/1.1 415 Unsupported Media Type
Content-Type: application/problem+json
Date: Mon, 06 Jul 2026 09:12:44 GMT

{
  "type": "https://tools.ietf.org/html/rfc9110#section-15.5.16",
  "title": "Unsupported Media Type",
  "status": 415
}
```

`AddProblemDetails()` を設定していない場合は、`415` ステータスだけの空のボディが返ります。いずれにせよ、スタックトレースが存在しないことが手がかりです。これはハンドラーの内部でスローされたものではなく、フレームワークレベルのコンテンツネゴシエーションの失敗です。Microsoft Learn のパラメーターバインドのリファレンスは、バインド失敗の表の中でこれをはっきりと記載しています。「間違ったコンテンツタイプ (`application/json` でない)、ボディ、415」。

## なぜこれが起きるのか

minimal API のルートハンドラーは、各パラメーターをある取得元からバインドします。ルート、クエリ文字列、ヘッダー、DI からのサービス、あるいはリクエストボディです。パラメーターが `[From*]` 属性を持たない複合型の場合、minimal API はそれがリクエストボディから来ると推論します。そして、デフォルトで組み込まれている唯一のボディリーダーは `System.Text.Json` のリーダーです。そのリーダーは、ちょうど 1 つのメディアタイプ、`application/json` に対して登録されています。

そのためフレームワークは、`JsonSerializer` を呼び出すよりも前にコンテンツタイプのチェックを行います。受信した `Content-Type` が `application/json` (または互換性のある `+json` サフィックスタイプ) でなければ、ボディリーダーはリクエストを拒否し、minimal API は `415` でショートサーキットします。フレームワークは推測を試みません。`Content-Type` の欠落、`text/plain`、`application/x-www-form-urlencoded`、`multipart/form-data` は、対象のパラメーターが JSON ボディを期待している場合、すべて同じように失敗します。

これは `400 Bad Request` とは別の失敗です。`400` はコンテンツタイプは正しかったが JSON ペイロードが不正だったか、バリデーションに違反したことを意味します。`415` はコンテンツタイプが間違っていたため、フレームワークがボディを読み取ろうとすらしなかったことを意味します。この 2 つを区別しておくと、本当の問題がヘッダーであるときに JSON をデバッグしてしまうのを避けられます。典型的なトリガーは 3 つです。

- クライアントが JSON ボディを送るが、`Content-Type: application/json` ヘッダーを付け忘れる (またはプロキシがそれを取り除く)。
- クライアントが、パラメーターが JSON ボディからバインドされるハンドラーに対して、フォームデータ (`application/x-www-form-urlencoded` または `multipart/form-data`) を POST する。
- クライアントが、JSON リーダーが受け入れるように登録されていない、ベンダー独自の、または charset で修飾されたコンテンツタイプを送る。

## 最小限の再現

エラーを生み出す最小のエンドポイントを次に示します。`CreateProduct` はバインド属性を持たない複合型なので、minimal API はそれを JSON ボディからバインドします。

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- Program.cs
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddProblemDetails();   // so the 415 comes back as problem+json
var app = builder.Build();

app.MapPost("/products", (CreateProduct product) =>
    TypedResults.Created($"/products/{product.Sku}", product));

app.Run();

public record CreateProduct(string Sku, string Name, int Quantity);
```

では、コンテンツタイプヘッダーなしでボディを POST してみます。以下はどれも `415` を返します。

```bash
# .NET 11 -- no Content-Type header at all
curl -i -X POST http://localhost:5000/products \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- wrong Content-Type (curl defaults -d to x-www-form-urlencoded)
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d 'sku=A-100&name=Widget&quantity=5'

# .NET 11 -- text/plain, even though the payload is valid JSON
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: text/plain" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

1 番目と 3 番目の呼び出しのペイロードは完全に有効な JSON です。それは関係ありません。リーダーはバイトではなくヘッダーで判定されます。

## 詳細な修正方法

順番に進めてください。最初のものが大半のケースを解決します。

### 1. ボディにバインドする型には `Content-Type: application/json` を送信する

ハンドラーが複合型をボディからバインドするなら、クライアントは JSON のコンテンツタイプを宣言しなければなりません。`curl` では、`-d` (または `--data`) が黙って `application/x-www-form-urlencoded` を設定するという落とし穴があります。`--json` を使うか、ヘッダーを明示的に設定してください。

```bash
# .NET 11 -- curl 7.82+ has a --json shortcut that sets the header for you
curl -i -X POST http://localhost:5000/products \
  --json '{"sku":"A-100","name":"Widget","quantity":5}'

# .NET 11 -- or set it by hand
curl -i -X POST http://localhost:5000/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"A-100","name":"Widget","quantity":5}'
```

型付きの `HttpClient` からは `PostAsJsonAsync` を使ってください。これは 1 回の呼び出しでヘッダーの設定とシリアライズを行います。これはヘッダーをうっかり直したり、うっかり壊したりするもっとも一般的な方法です。

```csharp
// .NET 11, C# 14 -- sets Content-Type: application/json automatically
using System.Net.Http.Json;

var http = new HttpClient { BaseAddress = new Uri("http://localhost:5000") };
var response = await http.PostAsJsonAsync(
    "/products",
    new { sku = "A-100", name = "Widget", quantity = 5 });

response.EnsureSuccessStatusCode();   // 201 Created, no 415
```

`HttpContent` を手作業で構築する場合は、`JsonContent.Create(...)`、あるいはメディアタイプを設定した `StringContent` を使ってください。メディアタイプなしの `new StringContent(json)` はデフォルトで `text/plain` になり、`415` を返します。

```csharp
// .NET 11, C# 14
// WRONG -- StringContent defaults to text/plain -> 415
var bad = new StringContent(json);

// RIGHT -- declare the media type
var good = new StringContent(json, System.Text.Encoding.UTF8, "application/json");
```

JavaScript の `fetch` では、ヘッダーを明示的に設定してください。ボディが文字列のとき、`fetch` はヘッダーを付けてくれません。

```javascript
// browser fetch -- must set Content-Type or you get 415
await fetch("/products", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sku: "A-100", name: "Widget", quantity: 5 }),
});
```

### 2. フォーム POST やファイルアップロードには `[FromForm]` を使う

クライアントが実際にフォームデータを送る (HTML の `<form>` 送信や、ファイルアップロード) 場合は、それを無理に JSON に押し込まないでください。各パラメーターに `[FromForm]` を付けて、ボディではなくフォームからバインドするようハンドラーに指示します。これにより、エンドポイントが期待するコンテンツタイプが `application/x-www-form-urlencoded` と `multipart/form-data` に切り替わります。

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products",
    ([FromForm] string sku, [FromForm] string name, [FromForm] int quantity) =>
        TypedResults.Created($"/products/{sku}", new { sku, name, quantity }));
```

ファイルアップロードでは、`IFormFile` パラメーターは `multipart/form-data` を必要とします。minimal API のドキュメントによれば、minimal API はリクエストボディ全体を直接 `IFormFile` にバインドしません。フィールドはフォームエンコーディングを通じて来なければならず、パラメーター名がフォームフィールド名と一致していなければなりません。

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/upload",
    async ([FromForm] string title, IFormFile file, HttpContext ctx) =>
    {
        await using var stream = File.Create(Path.Combine("uploads", file.FileName));
        await file.CopyToAsync(stream);
        return TypedResults.Ok(new { title, file.FileName, file.Length });
    })
    .DisableAntiforgery();   // see the gotcha below before you copy this line
```

これを multipart として POST すれば、`415` は消えます。

```bash
# .NET 11 -- multipart, matches the [FromForm] + IFormFile handler
curl -i -X POST http://localhost:5000/upload \
  -F "title=Spec sheet" \
  -F "file=@./spec.pdf"
```

### 3. JSON リーダーが拒否する charset やベンダーサフィックスを取り除く

`application/json; charset=utf-8` のようなコンテンツタイプは受け入れられますが、`application/vnd.myapp+json` のような素のベンダータイプは、リーダーのメディアタイプがどう設定されているかによっては受け入れられないことがあります。カスタムの `+json` メディアタイプを送るクライアントを管理していて、それを変更できない場合は、そのメディアタイプを登録して JSON ボディリーダーが認識できるようにしてください。minimal API では、エンドポイントが受け入れるリクエストコンテンツタイプを `Accepts` で設定することでこれを行います。これは OpenAPI ドキュメントにも反映されます。

```csharp
// .NET 11, ASP.NET Core 11, C# 14
app.MapPost("/products", (CreateProduct product) =>
        TypedResults.Created($"/products/{product.Sku}", product))
    .Accepts<CreateProduct>("application/json", "application/vnd.myapp+json");
```

### 4. HttpRequest で JSON ではないボディを自分で読み取る

ペイロードがまったく JSON ではない (生のバイト列、CSV、カスタムのテキスト形式) 場合は、複合型のバインドをやめてストリームを直接読み取ってください。minimal API がコンテンツタイプのチェックなしに供給する `HttpRequest` (または `Stream`、`PipeReader`) をバインドし、ボディを自分の流儀でパースします。

```csharp
// .NET 11, ASP.NET Core 11, C# 14 -- accepts any content type
app.MapPost("/import", async (HttpRequest request) =>
{
    using var reader = new StreamReader(request.Body);
    var raw = await reader.ReadToEndAsync();
    // parse `raw` (CSV, custom format, whatever) here
    return TypedResults.Ok(new { bytes = raw.Length });
});
```

ボディを型付きパラメーターにデシリアライズするようフレームワークに一切依頼していないため、コンテンツタイプのゲートが存在せず、このエンドポイントで `415` が発生することはあり得ません。

## 落とし穴とバリエーション

いくつかのよく似たものが人々を誤ってこのページに導きますし、修正後でも刺さる鋭い落とし穴がいくつかあります。

- **`415` は `406` ではありません。** `415 Unsupported Media Type` はリクエストボディの `Content-Type` に関するものです。`406 Not Acceptable` はレスポンスに対するクライアントの `Accept` ヘッダーに関するものです。`406` が返っているなら、あなたは間違ったページにいます。サーバーがクライアントの受け入れる表現を生成できないという意味であり、これは入ってくる側ではなく出ていく側のフォーマッターの問題です。

- **`415` は `400` ではありません。** コンテンツタイプは正しいが JSON が不正であったりバリデーションに失敗したりすると、`415` ではなく `400` が返ります。その経路については [コントローラーなしで minimal API のリクエストボディをバリデーションする方法](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/) を参照してください。また、`400` のペイロードを整形したい場合は [IProblemDetailsService で minimal API のバリデーションエラーレスポンスをカスタマイズする方法](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/) を参照してください。特定の不正 JSON のバリエーション、つまりシリアライザーがパースできない日付文字列については [The JSON value could not be converted](/ja/2026/05/fix-jsonexception-the-json-value-could-not-be-converted/) で扱っています。

- **`[FromForm]` エンドポイントはデフォルトで偽造防止 (antiforgery) トークンを必要とします。** .NET 8 以降、フォームにバインドされる minimal API のパラメーターは antiforgery のバリデーションをトリガーします。有効なトークンなしでフォームを POST するプログラム的なクライアント (curl、`HttpClient`) は拒否されます。これはコンテンツタイプの問題のように見えますが、そうではありません。antiforgery トークンを送るか、上のアップロード例のようにブラウザ駆動でないエンドポイントで `.DisableAntiforgery()` を呼んでください。ブラウザが POST するエンドポイントで無差別に無効化しないでください。

- **`Content-Type` の欠落は、間違ったものと同じように振る舞います。** 一部の HTTP クライアントは、ボディ付きの `POST` に対してヘッダーを完全に省略します。フレームワークの観点からは、コンテンツタイプがないことは `application/json` ではないので、同じ `415` チェックに失敗します。クライアントのデフォルトに頼るのではなく、常にヘッダーを明示的に設定してください。

- **リバースプロキシや API ゲートウェイがヘッダーを書き換えたり削除したりすることがあります。** Kestrel に直接投げると同じリクエストが通るのに、nginx、YARP、または API ゲートウェイの背後では `415` が返る場合は、実際にアプリに届く `Content-Type` を確認してください。パイプラインの先頭で `HttpContext.Request.ContentType` をログ出力すると、自分が送ったと思っている値ではなく本当の値を確認できます。

- **`[ApiController]` の推論はコントローラーの概念であり、minimal API のものではありません。** コントローラーから移行した場合、minimal API も複合型に対して同じようにボディバインドを推論しますが、`Accepts` を追加しない限りメディアタイプをフィルタリングする `[Consumes]` 属性はないことを覚えておいてください。コンテンツタイプを制御するのは属性ではなくバインドの取得元です。

覚えておくべきメンタルモデルはこうです。minimal API の `415` は、クライアントが送った `Content-Type` とエンドポイントが期待するボディリーダーの不一致です。エンドポイントが何を受け入れるべきか、JSON ボディ、フォーム、ファイル、生のストリームのどれかを決め、クライアントのヘッダーとハンドラーのバインドを一致させてください。一致すれば `415` は消え、通常の `400`/`200` の領域に戻ります。

## 関連

- [ASP.NET Core 11 でコントローラーなしで minimal API のリクエストボディをバリデーションする方法](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)：コンテンツタイプが正しくなった後の `400` の経路について。
- [ASP.NET Core 11 で IProblemDetailsService により minimal API のバリデーションエラーレスポンスをカスタマイズする方法](/ja/2026/07/how-to-customize-minimal-api-validation-error-responses-with-iproblemdetailsservice-in-aspnetcore-11/)：クライアントが見るエラーボディを整形することについて。
- [ASP.NET Core 11 で MapGroup を使って minimal API エンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)：エンドポイントのグループ全体に `Accepts` やフィルターを適用することについて。
- [ASP.NET Core 11 における minimal API とコントローラーの比較](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/)：2 つのモデルでコンテンツタイプの扱いがどう異なるかについて。
- [ASP.NET Core 11 で minimal API に JWT ベアラー認証をセットアップする方法](/ja/2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11/)：これらのエンドポイントの前段に位置する認証層について。

## 出典

- Microsoft Learn, [Parameter binding in Minimal API applications](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/parameter-binding?view=aspnetcore-9.0) (バインド失敗の表: ボディパラメーターで間違ったコンテンツタイプは 415 を返す。`[FromForm]`、`IFormFile`、`multipart/form-data` の要件。フォームバインドでの antiforgery)。
- Microsoft Learn, [Minimal APIs quick reference](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis?view=aspnetcore-9.0) (`Accepts` メタデータ、ボディとフォームのバインド取得元)。
- MDN, [415 Unsupported Media Type](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/415) (HTTP のセマンティクス: サーバーがリクエストペイロードのメディアタイプを拒否する)。
