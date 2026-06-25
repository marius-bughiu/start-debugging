---
title: "有効なトークンでも ASP.NET Core の JWT が 401 を返す理由"
description: "有効なトークンなのに 401 になる場合、ほぼ確実に bearer ハンドラーが実行されなかったか、間違ったスキームの下で実行されています。ミドルウェアの順序、既定のスキーム、スキーム名、そしてヘッダーがそもそもハンドラーに届いたかを確認しましょう。"
pubDate: 2026-06-25
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "ja"
translationOf: "2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token"
translatedBy: "claude"
translationDate: 2026-06-25
---

[jwt.io](https://jwt.io/) でトークンをデコードし、署名は正しく、`exp` は数時間先、`iss` と `aud` は設定したものと完全に一致しているのに、ASP.NET Core はそれでも `401 Unauthorized` を返します。トークン自体が確かに正しいことが証明できている場合、バグはほぼトークンにはありません。原因は、JWT bearer ハンドラーがこのリクエストでまったく実行されなかったか、`[Authorize]` 属性が要求していないスキームの下で実行されたかのどちらかです。よくある 4 つの原因を、影響が出る順に挙げます。`app.UseAuthentication()` が抜けているか `app.UseAuthorization()` の後に置かれている。既定の認証スキームが登録されていない。`AddJwtBearer` のスキーム名が `[Authorize]` がチャレンジするものと一致していない。あるいは `Authorization` ヘッダーがそもそもハンドラーに届いていない。この記事では .NET 11 と `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0-preview、C# 14 を使用しますが、診断方法は .NET 8 までさかのぼっても同一です。

トークンのクレームが実際に間違っているのではないかと疑っている場合（5 分間の `ClockSkew` ウィンドウ、対象オーディエンスの不一致など）、それは別の記事の話です。[JWT の発行者、オーディエンス、有効期限を検証する方法](/ja/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)では `TokenValidationParameters` 側を詳しく解説しています。ここでは、トークンが有効であることをすでに証明したうえで、それでも 401 が続くことを前提とします。

## 401 が実際に教えてくれること

返ってくるレスポンスは、意図的に情報が少なくなっています。

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

[RFC 9110](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2) によれば、401 はチャレンジを示す `WWW-Authenticate` ヘッダーを必ず含まなければならず、ASP.NET Core は `Bearer` を送信します。既定で送信しないのは理由です。ハンドラーが実行されてトークンを拒否した場合、本当の原因はハンドラーが握りつぶした `Microsoft.IdentityModel` の例外です。ハンドラーがまったく実行されなかった場合は例外はいっさいなく、認証済みユーザーを見つけられずチャレンジした認可ポリシーがあるだけです。この 2 つのケースを見分けることがすべてであり、それを行う最も速い方法はハンドラーに語らせることです（記事の終盤で扱います）。

すぐに除外しておくべきことが 1 つあります。401 は「あなたが誰なのか分かりません」を意味します。403 は「あなたが誰かは分かっていますが、許可されていません」を意味します。403 が返っている場合、トークンの検証は問題なく通っており、問題は認証ではなくポリシーやロールのチェックにあります。403 のためにトークン検証のデバッグで午後を費やさないでください。

## 原因 1: UseAuthentication が抜けているか UseAuthorization の後にある

これは最も多い原因であり、両方の行が存在していて順序だけが間違っているため、最も見落としやすいものです。認証ミドルウェアは `Authorization` ヘッダーを読み取り、bearer ハンドラーを実行し、`HttpContext.User` を設定する役割を担います。認可ミドルウェアは `[Authorize]` を強制する役割を担います。認可が先に実行されると、`HttpContext.User` はまだ匿名の既定値のままなので、トークンがどれだけ正しくても、保護されたエンドポイントはすべて 401 でチャレンジします。

```csharp
// .NET 11, C# 14 -- WRONG: authorization runs before the user is set
app.UseAuthorization();
app.UseAuthentication();   // too late, User is already anonymous
```

```csharp
// .NET 11, C# 14 -- correct order
app.UseAuthentication();   // reads the token, populates HttpContext.User
app.UseAuthorization();    // now enforces [Authorize] against a real user
```

ルールは機械的です。`UseAuthorization` の前に `UseAuthentication`、そして両方を `UseRouting` の後に置きます（最新のミニマルホスティングモデルでは `UseRouting` は自動的に追加されるため、ほとんどの場合は 2 つの認証呼び出しを正しい相対順序で置くだけで済みます）。リファクタリングの途中などで `UseAuthentication` を完全に削除してしまった場合も症状は同じです。`[Authorize]` の付いたものすべてで普遍的に 401 になります。ほかに手を付ける前に、まずこれを戻してください。

## 原因 2: 既定の認証スキームが登録されていない

スキーム名を指定していない `[Authorize]` 属性は、*既定の認証スキーム*を使用します。その既定が何かを `AddAuthentication` に伝えていなければ、実行するスキームが存在せず、ユーザーは匿名のままになり、401 になります。これは登録が*完全に見える*ため人々を引っかけます。

```csharp
// .NET 11, C# 14 -- WRONG: no default scheme, [Authorize] has nothing to run
builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

引数なしの `AddAuthentication()` はサービスを登録しますが、既定のスキームは設定しません。修正方法は、スキーム名を既定として渡すことです。これは `AddJwtBearer` に名前を付けなかったときに登録される名前とまったく同じです。

```csharp
// .NET 11, C# 14 -- correct: "Bearer" becomes the default scheme
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`JwtBearerDefaults.AuthenticationScheme` は文字列 `"Bearer"` です。これを `AddAuthentication` に渡すと、`DefaultAuthenticateScheme` と `DefaultChallengeScheme` の両方が一度に `"Bearer"` に設定されるため、素の `[Authorize]` が bearer ハンドラーを実行すべきだと分かるようになります。明示的に書きたい場合は、プロパティを直接設定します。

```csharp
// .NET 11, C# 14 -- the explicit form, equivalent to the above
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options => { /* ... */ });
```

## 原因 3: スキーム名が一致していない

`AddJwtBearer` にカスタムのスキーム名を与えた瞬間に、あなたは既定から外れ、その後はあらゆる場所でそのスキームを名前で要求しなければならなくなります。これは「有効なトークンなのに 401」の 2 番目に多い罠であり、設定がそれ以外は完璧なため厄介です。

```csharp
// .NET 11, C# 14 -- registers the handler under "MyApi", not "Bearer"
builder.Services.AddAuthentication()
    .AddJwtBearer("MyApi", options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

```csharp
// .NET 11, C# 14 -- a bare [Authorize] looks for the default scheme,
// which is unset, so the "MyApi" handler never runs -> 401
[Authorize]
public class OrdersController : ControllerBase { /* ... */ }
```

抜け出す方法は 2 つあります。`"MyApi"` を既定にして素の `[Authorize]` がそれを見つけられるようにするか、それを使うべきすべての属性にスキーム名を指定するかです。

```csharp
// .NET 11, C# 14 -- option A: make the named scheme the default
builder.Services.AddAuthentication("MyApi")
    .AddJwtBearer("MyApi", options => { /* ... */ });

// .NET 11, C# 14 -- option B: ask for the scheme by name
[Authorize(AuthenticationSchemes = "MyApi")]
public class OrdersController : ControllerBase { /* ... */ }
```

これが最も重要になるのは、実際に複数のスキームを運用している場合です。たとえば API 用の bearer スキームに加えて、サーバーレンダリングされる管理画面用の Cookie などです。複数のスキームがある場合、合理的な単一の既定は存在しないため、bearer のエンドポイントは `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]` と明記しなければなりません。これを省くと、リクエストはたまたま既定になっているスキーム（あなたのものではない）に対して検証され、トークンは無視されます。

## 原因 4: ヘッダーがハンドラーに届かなかった

ハンドラーが実行され、`Authorization` ヘッダーが見つからない（または不正な形式の）場合、誰も認証できず、トークンの中身とは無関係に 401 になります。Postman のタブにあるトークンは有効です。それがあなたの思っている方法で届いていないだけです。

形式は厳密です。ヘッダーの値は、文字どおりの `Bearer` という語、スペース 1 つ、そして生のトークンでなければならず、引用符は付けず、`Basic`／`Bearer` の取り違えもあってはなりません。

```text
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

実際にこれがうまくいかなくなるよくあるパターン:

- **クライアントがそもそも付けていない。** 型付きの `HttpClient` で `DefaultRequestHeaders.Authorization` が*別の*クライアントインスタンスに設定されていた、あるいは再試行時にヘッダーを忘れた fetch 呼び出しなど。サーバー側で受信ヘッダーをログ出力して、実際に何が届いたかを確認しましょう。
- **CORS のプリフライトが拒否されており、本来のリクエストではない。** ブラウザは本来の呼び出しの前に、`Authorization` ヘッダーなしの `OPTIONS` プリフライトを送信します。CORS の設定が誤っていると、ブラウザは本来のリクエストをブロックし、ネットワークタブには認証失敗のように見えるものが表示されます。修正はトークン側ではなく CORS 側です。正しいミドルウェアの順序とポリシーについては [JWT で保護された API に CORS を設定する方法](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)を参照してください。
- **リバースプロキシまたはロードバランサーが除去している。** 一部のプロキシは、明示的に保持するよう指定されない限り、転送時に `Authorization` を落とします。ローカルでは動作し、nginx、IIS、または ingress コントローラーの背後でのみ 401 になる場合は、まずこれを疑ってください。
- **API エクスプローラーが落としている。** Swagger UI や Scalar は、認証の連携が組み込まれていなければ、トークンなしのリクエストを黙って送信します。`curl` は動くのにドキュメント UI が動かない場合、それが手がかりです。[Scalar で bearer トークンが無視される理由](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)で扱っています。

## ハンドラーに理由を語らせる

当て推量はやめましょう。`JwtBearerEvents` を組み込んでハンドラーに実際の結果をログ出力させれば、1 回のリクエストで、そもそも実行されたのか、そして実行された場合はどのチェックが失敗したのかが分かります。

```csharp
// .NET 11, C# 14
.AddJwtBearer(options =>
{
    options.Authority = "https://login.example.com";
    options.Audience = "api://my-api";

    options.Events = new JwtBearerEvents
    {
        OnAuthenticationFailed = ctx =>
        {
            // Fires only if the handler RAN and the token was rejected.
            // ctx.Exception carries the IDX code (expired, bad audience, etc.)
            var log = ctx.HttpContext.RequestServices
                .GetRequiredService<ILogger<Program>>();
            log.LogWarning(ctx.Exception, "JWT rejected");
            return Task.CompletedTask;
        },
        OnChallenge = ctx =>
        {
            // Fires whenever a 401 is about to be sent, INCLUDING the
            // "no token / handler never validated anything" case.
            var log = ctx.HttpContext.RequestServices
                .GetRequiredService<ILogger<Program>>();
            log.LogWarning("JWT challenge: {Error} {Desc}",
                ctx.Error, ctx.ErrorDescription);
            return Task.CompletedTask;
        },
        OnTokenValidated = ctx =>
        {
            // Fires when a token validated successfully. If you see THIS
            // and still get a 401, the problem is authorization, not auth.
            return Task.CompletedTask;
        },
    };
});
```

これによって得られる判断ツリーは正確です。`OnAuthenticationFailed` が発火すれば、ハンドラーは実行され、実在するトークンを拒否したということです。`ctx.Exception` から `IDX` コードを読み取り、[トークン検証ガイド](/ja/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)へ進んでください。先行する失敗なしに `OnChallenge` だけが発火するなら、ハンドラーには検証すべきトークンがそもそもなかったということなので、見るべきはトークンではなく上記の原因 1 から 4 です。`OnTokenValidated` が発火しても*なお*非 200 になる場合は、401 の衣装をまとった 403 的な認可の問題を抱えており、トークンをいくらいじっても解決しません。

`appsettings.Development.json` でログカテゴリのレベルを上げれば、コードなしで同じシグナルを得られます。

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Authentication": "Debug"
    }
  }
}
```

これにより「Bearer was not authenticated. Failure message: ...」のような行がコンソールに直接表示され、それだけでこれらの大半が 1 分以内に解決します。

## テスト用の信頼できる正常なトークン

このバグに費やす時間の半分は、トークンが本当に有効かどうかという疑念です。`dotnet user-jwts` ツールでその疑念を取り除きましょう。このツールはキーで署名したトークンを発行し、そのキーを開発用構成にも組み込むため、キーの不一致で検証が失敗することがありません。

```bash
# .NET 11 SDK -- creates a local-dev JWT and configures the app to accept it
dotnet user-jwts create
```

`user-jwts` のトークンは認証されるのに本物のプロバイダーのトークンは認証されない場合、トークンのクレームか署名キーが違いであり、検証パラメーターの話に戻ります。`user-jwts` のトークンですら 401 になる場合は、トークンはそもそも問題ではなく、上記の 4 つの配線の原因のいずれかが問題です。このたった 1 つの実験で、探索範囲をきれいに半分に分けられます。

## 順番どおりに診断する

有効なトークンが 401 になったら、このチェックリストを上から下へ進めてください。最初のステップで圧倒的大多数が捕まるので、飛ばさないでください。

1. **403 ではなく 401 であることを確認する。** 403 は認証がすでに成功していることを意味します。ここで止めて、代わりに認可ポリシーを見てください。
2. **ミドルウェアの順序を確認する。** `app.UseAuthentication()` が存在し、かつ `app.UseAuthorization()` より前にある必要があります。これだけでほとんどのケースが直ります。
3. **既定のスキームを確認する。** `JwtBearerDefaults.AuthenticationScheme` を `AddAuthentication` に渡すか、`DefaultAuthenticateScheme` を明示的に設定します。素の `AddAuthentication()` と素の `[Authorize]` の組み合わせは機能しません。
4. **スキーム名を確認する。** `AddJwtBearer("X")` でスキームに名前を付けた場合は、`"X"` を既定にするか、あらゆる場所で `[Authorize(AuthenticationSchemes = "X")]` を使います。
5. **ヘッダーが届いていることを確認する。** サーバー側で受信リクエストヘッダーをログ出力します。正確な `Authorization: Bearer <token>` の形を検証し、プロキシや CORS プリフライトが食べていないかを除外します。
6. **`dotnet user-jwts` のトークンを発行して再試行する。** それで認証されるなら、本物のトークンのクレームかキーが問題です。[検証パラメーターガイド](/ja/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)へ進んでください。それも 401 になるなら、配線がまだ間違っています。ステップ 2 から 4 を再確認してください。
7. **`Microsoft.AspNetCore.Authentication` のデバッグログを有効にする** か `JwtBearerEvents` を組み込んで、どのイベントが発火するかを読みます。それでハンドラーが実行されたかどうかが確定的に分かります。

## 探索を終わらせるたった 1 つの区別

すべての「有効なトークンなのに 401」は、たった 1 つの問いに帰着します。bearer ハンドラーは実行されてトークンを拒否したのか、それとも実行される機会すらなかったのか。検証パラメーター、`ClockSkew`、発行者やオーディエンスの不一致はすべて最初の枝に属し、それらが意味を持つのは `OnAuthenticationFailed` が発火する場合だけです。ミドルウェアの順序、既定のスキーム、スキーム名、ヘッダーの欠落はすべて 2 番目の枝に属し、そこでは検証すべきものがなかったため、見つけるべき検証の失敗も存在しません。ハンドラーにログ行を 1 つ出させれば、その問いには答えが出ます。そこから先、修正は機械的です。エンドポイントを締めにかかるときは、保護されたルートを [MapGroup](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) でまとめると、スキームの要件をすべての `[Authorize]` に散らばせる代わりに 1 か所に保てます。スキーム名の不一致は、そもそもそうやって紛れ込んでくるのです。

## 出典

- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn。401 対 403 の整理と既定スキームのガイダンスを含みます。
- [Authorize with a specific scheme in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authorization/limitingidentitybyscheme), Microsoft Learn。`[Authorize(AuthenticationSchemes = ...)]` について。
- [RFC 9110, section 15.5.2](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2)。401 で `WWW-Authenticate` ヘッダーを必須とする規定。
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn。
