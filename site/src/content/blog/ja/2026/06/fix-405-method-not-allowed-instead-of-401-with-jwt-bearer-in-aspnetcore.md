---
title: "修正: ASP.NET Core で JWT bearer なのに 401 ではなく 405 Method Not Allowed が返る"
description: "保護されたエンドポイントが 401 ではなく 405 を返すのは、ほぼ常に認証が実行される前にルーティングが HTTP 動詞を拒否したか、cookie スキームがチャレンジを横取りしたかのどちらかです。ここでは、どちらなのかを見分ける方法を解説します。"
pubDate: 2026-06-25
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "ja"
translationOf: "2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore"
translatedBy: "claude"
translationDate: 2026-06-25
---

エンドポイントに `[Authorize]` (または `RequireAuthorization()`) を追加し、トークンなしのリクエストを送ってきれいな `401 Unauthorized` を期待したのに、代わりに `405 Method Not Allowed` が返ってきた。この 405 は紛らわしいものです。認証が壊れていることを意味することはほとんどありません。これはリクエストが認可の段階に一切到達しなかったことを意味します。なぜなら、エンドポイントルーティングが先に HTTP 動詞を拒否して 405 でショートサーキットしたか、あるいはそれほど多くはありませんが、cookie 認証スキームがデフォルトのチャレンジになっていて、JWT bearer ハンドラーの代わりにそれが応答したからです。よくあるケースの修正方法は、エンドポイントが実際にマップしている動詞を送ること (`GET` ではなく `MapPost` には `POST`) であり、スキームのケースの修正方法は `DefaultChallengeScheme` を bearer スキームに設定することです。この記事では .NET 11 と `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0 および C# 14 を使用しますが、ルーティングの挙動は .NET 6 まで遡っても同一です。

## エラーの全体像

```text
HTTP/1.1 405 Method Not Allowed
Allow: POST
Content-Length: 0
```

その `Allow` ヘッダーが手がかりです。本物の認証失敗は次を返します。

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

`Allow` があって `WWW-Authenticate` がない場合、このレスポンスを生成したのは JWT bearer ハンドラーではなくルーティングです。`WWW-Authenticate: Bearer` が見える場合は、ハンドラーが実行されていて本物の認証の問題があります。それは別の記事の話です。[有効なトークンでも JWT が 401 を返す理由](/ja/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/) がその道筋をカバーしています。

## なぜ認可が実行される前にルーティングが優先されるのか

ASP.NET Core のパイプラインには順序があります。デフォルトの minimal API またはコントローラーアプリでは次のようになります。

```csharp
// .NET 11, ASP.NET Core 11.0.0
var app = builder.Build();

app.UseRouting();        // 1. selects the endpoint (including method matching)
app.UseAuthentication(); // 2. reads the token, sets HttpContext.User
app.UseAuthorization();  // 3. enforces [Authorize] on the selected endpoint

app.MapControllers();
app.Run();
```

`UseRouting` が最初に実行されます。ルーティングはリクエストのパス *と* HTTP メソッドの両方でマッチングを行います。パスが登録済みのルートにマッチするものの、メソッドがマッチしない場合、ルーティングは「エンドポイントなし」へフォールスルーしません。代わりに `HttpMethodMatcherPolicy` が生成する組み込みの合成エンドポイントを選択します。その唯一の役割は、そのパスに対して *実際に* マップされている動詞を列挙した `Allow` ヘッダー付きで `405 Method Not Allowed` を返すことです。マッチャーポリシーがどのようにエンドポイント選択に関与するかについては、[ルーティングの基礎ドキュメント](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing) を参照してください。

その合成された 405 エンドポイントは認可メタデータを一切持ちません。そのため `UseAuthorization` が選択されたエンドポイントを見るとき、強制すべきものが何も見つからず、リクエストを通過させ、405 がレスポンスに書き込まれます。`[Authorize]` で装飾されたアクションは候補にすらなりませんでした。マッチングの段階で動詞がそれを除外したからです。ルーティングが選択しなかったエンドポイントに対して、認可は文字通り実行できないのです。

これが、`[Authorize]` を追加すると 405 が「引き起こされる」ように見える理由です。実際には引き起こしていません。405 は認証を追加する前から存在していたのですが、あなたが見ていなかっただけです。なぜなら `[Authorize]` がなくても `POST` 専用のエンドポイントに `GET` を投げれば 405 が返るからです。`[Authorize]` を追加すると *期待値* が 401 に変わり、すでに存在していた動詞の不一致が露呈するのです。

## 最小再現

```csharp
// .NET 11, C# 14, ASP.NET Core 11.0.0
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(); // appsettings supplies Authority/Audience

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

// Only POST is mapped for /orders
app.MapPost("/orders", () => Results.Ok())
   .RequireAuthorization();

app.Run();
```

次に、間違った動詞でトークンなしで呼び出します。

```bash
curl -i http://localhost:5000/orders        # implicit GET
# HTTP/1.1 405 Method Not Allowed
# Allow: POST
```

`POST /orders` エンドポイントが存在するのでパスはマッチしますが、`GET` は許可されていないため、ルーティングは 405 を返します。エンドポイントが `POST` しか受け付けないことを忘れていたので、401 を期待していたのです。正しい動詞を送れば、欲しかった 401 が現れます。

```bash
curl -i -X POST http://localhost:5000/orders
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer
```

## 修正 1: エンドポイントがマップする動詞を送る (通常の原因)

10 回中 9 回は、バグは呼び出し側にあります。フロントエンド、Postman コレクション、または統合テストが、ルートがマップしていない動詞を使っているのです。次の順序で確認してください。

1. **リクエスト内の HTTP メソッド。** `MapPost` に対してデフォルトで `GET` になっている `fetch`、API が `PUT` を期待しているのにフォームが POST している、あるいは読み取りエンドポイントが実際には `/api/orders/{id}` なのにクライアントが `GET` で `/api/orders` を叩いている、などです。`Allow` ヘッダーがそのパスでサポートされている動詞を正確に教えてくれるので、それを読みましょう。
2. **アクションの動詞属性。** コントローラーでは、`[Route("orders")]` があっても `[HttpPost]` がないアクションは、属性ルーティングのもとであなたが想定するような形ですべての動詞に応答するわけではありません。`[HttpPost("orders")]` で動詞を明示的に固定すれば、同じパスへの `GET` は不意打ちではなく意図された 405 を生成します。
3. **衝突するルートテンプレート。** 同じパス上に異なる動詞を持つ 2 つのエンドポイントがあるのは問題ありません。しかし `MapGet("/orders/{id}")` と `MapPost("/orders")` は異なるパスです。`POST /orders/5` はどちらにもきれいにはマッチせず、テンプレートによっては 405 または 404 になり得ます。`MapGroup` を使ってプレフィックスの動詞を 1 か所で見えるようにしましょう。[MapGroup で minimal API エンドポイントを整理する](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) がそのパターンを示しています。

クライアントが試す可能性のある *すべて* の動詞 (マップされていないものを含む) に対して、保護されたリソースに 401 を返させたい場合は、キャッチオールをマップする必要があります。それが望ましいことはめったにありませんが、対象としたい動詞をカバーする `MapMethods` とフォールバックで実現可能です。

## 修正 2: cookie スキームがチャレンジに応答するのを止める

2 つ目の原因は、ASP.NET Core Identity (cookie 認証を登録する) を JWT bearer と組み合わせ、明示的なデフォルトを一度も設定しなかったときに現れます。この [Microsoft Q&A スレッド](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u) に記載されているように、その場合チャレンジは bearer ハンドラーではなく Identity の cookie ハンドラーを通って実行されます。cookie ハンドラーのチャレンジはログインページへのリダイレクトであり、そのログインルートが元のリクエストの動詞を受け付けないとき、bearer の 401 ではなく 405 にたどり着くのです。

修正方法は、どのスキームが認証し、どのスキームがチャレンジするかを明示することです。

```csharp
// .NET 11, C# 14
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options =>
{
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true,
        ValidateAudience = true,
        ValidateLifetime = true,
        ValidateIssuerSigningKey = true,
        ValidIssuer = builder.Configuration["Jwt:Issuer"],
        ValidAudience = builder.Configuration["Jwt:Audience"],
        IssuerSigningKey = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Key"]!))
    };
});
```

`DefaultChallengeScheme` を bearer スキームに設定すると、認証されていないリクエストは 405 に劣化する cookie リダイレクトではなく、`WWW-Authenticate: Bearer` 付きの `401 Unauthorized` を受け取ります。両方のスキームを正当に持っていて、特定のエンドポイントで bearer を使うべき場合は、デフォルトに頼るのではなく属性でスキームを名指ししてください。`[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]` です。この同じスキーム不一致の罠は、多くの [有効なトークンでも 401 になる](/ja/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/) 問題の根本原因でもあるので、デフォルトを一度きちんと設定する価値があります。

## ログでどちらの原因かを確認する

推測する必要はありません。ルーティングと認可のログレベルを上げれば、レスポンスの出どころが明白になります。

```json
// appsettings.Development.json - .NET 11
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Routing": "Debug",
      "Microsoft.AspNetCore.Authentication": "Debug",
      "Microsoft.AspNetCore.Authorization": "Debug"
    }
  }
}
```

動詞が間違っている場合、ルーティングが method-not-allowed エンドポイントを選択し、認証のログ行が *まったく* ないのが見えます。ハンドラーが一度も実行されなかったからです。

```text
dbug: Microsoft.AspNetCore.Routing.Matching.DfaMatcher
      Endpoint selection: 405 HTTP Method Not Supported
```

cookie スキームがチャレンジしている場合、cookie ハンドラーが明示的に名指しされているのが見えます。

```text
dbug: Microsoft.AspNetCore.Authentication.Cookies.CookieAuthenticationHandler
      AuthenticationScheme: Identity.Application was challenged.
```

その 1 行が、bearer ハンドラーがデフォルトのチャレンジスキームではないことを教えてくれ、まっすぐ修正 2 を指し示します。

## 落とし穴とそっくりさん

**CORS プリフライトが 405 を返す。** ブラウザはクロスオリジンの `POST` や `PUT` の前に `OPTIONS` プリフライトを送ります。そのメソッドを許可するポリシーで `app.UseCors(...)` を呼び出していない場合、ルーティングにはそのパス用の `OPTIONS` エンドポイントがなく 405 を返し、ブラウザはそれを CORS 失敗として表面化させます。修正は認証ではなく CORS の設定です。[JWT で保護された API 向けに CORS を設定する](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) がポリシーとミドルウェアの順序を解説しています。プリフライトの `OPTIONS` は意図的に認証されないことに注意してください。その前に `[Authorize]` を置かないでください。

**GET 専用エンドポイントへの HEAD リクエスト。** `MapGet` は自動的には `HEAD` に応答しません。ヘルスチェックや CDN が `MapGet` ルートに対して `HEAD` でプローブすると 405 になります。[ルートハンドラーのドキュメント](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers) に従って `app.MapMethods("/health", new[] { "GET", "HEAD" }, handler)` で両方の動詞をマップしてください。これは認証の問題ではなく動詞の不一致です。

**403 は 405 ではない。** 認証には成功したものの必要なロールやポリシークレームを欠いている場合、405 でも 401 でもなく `403 Forbidden` が返ります。403 はトークンが検証されハンドラーが実行されたことを意味します。問題はポリシーまたはロールのチェックであり、[JWT の発行者、対象者、有効期間を検証する](/ja/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) ときとそれが運ぶクレームでカバーされます。

**ルーティングより前にショートサーキットするカスタムミドルウェア。** `UseRouting` より前に実行され 405 を書き込むミドルウェア (たとえば手書きのメソッド許可リスト) を書いた場合、それが下流のすべてを覆い隠します。ルーティングより前に `context.Response.StatusCode = 405` を呼び出すものはすべて、マッチャー由来の `Allow` ヘッダーなしでこの症状を生み出します。

一貫した本質はこうです。405 は ASP.NET Core では *ルーティング* のステータスであり、認証と認可がリクエストを見る前に決定されます。401 を期待して 405 が返ってきたら、トークンではなく動詞と `Allow` ヘッダーから始めましょう。認証のデバッグは、実際に `WWW-Authenticate: Bearer` が見えるケースのために取っておいてください。

## 関連記事

- [有効なトークンでも ASP.NET Core の JWT が 401 を返す理由](/ja/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [ASP.NET Core 11 で JWT の発行者、対象者、有効期間を検証する方法](/ja/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [ASP.NET Core 11 で JWT で保護された API 向けに CORS を設定する方法](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [ASP.NET Core 11 で MapGroup を使って minimal API エンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [ASP.NET Core 11 でコントローラーなしの minimal API でリクエストボディを検証する方法](/ja/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)

## 出典

- [ASP.NET Core ルーティングの基礎](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing) - エンドポイントのマッチングとメソッドマッチャーポリシー
- [minimal API アプリのルートハンドラー](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers) - `MapMethods`、HEAD と OPTIONS
- [Microsoft Q&A: JWT で 401 ではなく 405 Method Not Allowed](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u) - cookie のデフォルトスキームが原因のケースと修正
- [RFC 9110, section 15.5.6 (405 Method Not Allowed)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.6) と [15.5.2 (401 Unauthorized)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2)
</content>
</invoke>
