---
title: "ASP.NET Core 11 の minimal API で JWT bearer 認証を設定する方法"
description: "ASP.NET Core 11 の minimal API における JWT bearer 認証の完全で動作する設定です。パッケージのインストール、AddAuthentication().AddJwtBearer() の配線、トークンの発行、RequireAuthorization によるエンドポイントの保護、ロールと claim のポリシーの追加、そして dotnet user-jwts によるテストまでを扱います。"
pubDate: 2026-07-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "jwt"
  - "security"
lang: "ja"
translationOf: "2026/07/how-to-set-up-jwt-bearer-authentication-in-a-minimal-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-07-03
---

ASP.NET Core 11 の minimal API を JWT bearer トークンで保護するには、3 つの可動部分が必要です。`builder.Services.AddAuthentication().AddJwtBearer()` で bearer ハンドラーを登録し、有効なトークンがどのようなものか（issuer、audience、署名鍵）をハンドラーに伝え、保護したいエンドポイントを `.RequireAuthorization()` でマークします。`WebApplication` ホストが認証と認可のミドルウェアを自動で配線してくれるため、最小限の設定は実際にわずかな行数で済みます。この記事では、その全体像を最初から最後までたどります。パッケージ、設定、トークンの発行、エンドポイントの保護、ロールと claim のポリシー、そして `dotnet user-jwts` によるテストです。対象は .NET 11（執筆時点で Preview 5、GA は 2026 年 11 月）と `Microsoft.AspNetCore.Authentication.JwtBearer`、C# 14 ですが、ここでの各手順は .NET 8 まで遡って変更なく動作します。

## 必要な唯一のパッケージをインストールする

bearer のサポートはデフォルトでは共有フレームワークに含まれていません。パッケージを追加します。

```bash
# .NET 11 SDK
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

これにより `JwtBearerHandler`、`AddJwtBearer` 拡張メソッド、そして実際にトークンを検証する `Microsoft.IdentityModel` のトークンスタックが取り込まれます。検証のために `System.IdentityModel.Tokens.Jwt` を別途用意する必要はありません。ハンドラーは内部でより高速な `JsonWebTokenHandler` を使用します。トークンを自分で発行するときには、トークン作成用の型が必要になりますが、これは後ほど扱います。

## 認証と認可を行う最小の設定

以下は、bearer スキームを登録し、公開エンドポイントと保護されたエンドポイントを 1 つずつ公開する完全な `Program.cs` です。

```csharp
// .NET 11, C# 14
// Microsoft.AspNetCore.Authentication.JwtBearer 11.0.0-preview
using System.Security.Claims;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication()
    .AddJwtBearer(); // reads options from configuration, see below

builder.Services.AddAuthorization();

var app = builder.Build();

app.MapGet("/", () => "public, no token needed");

app.MapGet("/me", (ClaimsPrincipal user) => $"hello {user.Identity!.Name}")
    .RequireAuthorization();

app.Run();
```

2 つの点を指摘しておく価値があります。古い `Startup.cs` モデルから来た人がつまずくところだからです。

第 1 に、このファイルには `app.UseAuthentication()` も `app.UseAuthorization()` もありませんが、それでも動作します。最小ホスティングモデルでは、`WebApplication` がビルド時にサービスコンテナを調べ、認証と認可のサービスが登録されているのを見つけると、両方のミドルウェアを正しい順序であなたのために挿入します。`UseAuthentication` と `UseAuthorization` を手動で呼ぶ必要があるのは、他のミドルウェアとの相対的な順序を制御しなければならないときだけで、典型的なケースは CORS です。CORS は最初に実行される必要があります。ブラウザの SPA がこの API をクロスオリジンで呼び出す場合は、auth の配線が間違っていると決めつける前に [JWT で保護された API の CORS を設定する方法](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) を読んでください。ヘッダーを飲み込む preflight は、不正なトークンとまったく同じに見えます。

第 2 に、ラムダなしの `AddJwtBearer()` は不完全ではありません。それは `TokenValidationParameters` を設定から、`Authentication:Schemes:Bearer` セクションの下から読み込みます。これは現代的な、設定優先のパターンであり、`dotnet user-jwts` があなたのために書き込むのもまさにこれです。

## トークンのルールが存在する場所: 設定 vs コード

有効なトークンがどのようなものかをハンドラーに伝えるには 2 つの場所があります。1 つを選んで一貫させてください。

**設定優先**のアプローチは、issuer と audience をコードの外、`appsettings.json` に保ちます。フレームワークは `Authentication:Schemes:{SchemeName}` の下を探し、`AddJwtBearer()` のデフォルトのスキーム名は `Bearer` です。

```json
{
  "Authentication": {
    "Schemes": {
      "Bearer": {
        "ValidIssuer": "https://my-api.example.com",
        "ValidAudiences": [ "https://localhost:7259" ]
      }
    }
  }
}
```

**コード優先**のアプローチは、同じ値をラムダで設定します。自分の対称鍵でトークンに署名するときに使うことになります。

```csharp
// .NET 11, C# 14
using Microsoft.IdentityModel.Tokens;
using System.Text;

var key = new SymmetricSecurityKey(
    Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)); // >= 32 bytes for HS256

builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://my-api.example.com",

            ValidateAudience = true,
            ValidAudience = "https://localhost:7259",

            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,
        };
    });
```

トークンが外部の OpenID Connect プロバイダー（Entra ID、Auth0、Keycloak、Okta、Duende IdentityServer）から来る場合は、署名鍵を完全に省略して `options.Authority` を設定します。するとハンドラーは、プロバイダーの `/.well-known/openid-configuration` メタデータから issuer と公開署名鍵を検出します。各 `Validate*` フラグが何をするか、そしてトークンを `exp` を超えて生存させてしまう 5 分間の `ClockSkew` の罠の完全な内訳は、[JWT の issuer、audience、lifetime を検証する方法](/ja/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) にあります。この設定ガイドにとって重要な点は、真新しい `TokenValidationParameters` オブジェクトを代入するとデフォルト値が丸ごと置き換わることです。したがって、気にかけるフラグをすべて列挙してください。

## デフォルトスキームを設定する。さもないと素の [Authorize] は何もしない

`RequireAuthorization()`（および `[Authorize]` 属性）は*デフォルト*の認証スキームにチャレンジします。引数なしの `AddAuthentication()` はサービスを登録しますが、デフォルトを設定しません。そのままにしておくと、保護されたエンドポイントには実行するスキームがなく、ユーザーは匿名のままとなり、完璧なトークンがあってもすべてのリクエストが 401 を返します。スキームに名前を付けることでこれが解決します。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication.JwtBearer;

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer();
```

`JwtBearerDefaults.AuthenticationScheme` は文字列 `"Bearer"` です。それを `AddAuthentication` に渡すと、`DefaultAuthenticateScheme` と `DefaultChallengeScheme` の両方が 1 回の呼び出しで設定されるため、素の `.RequireAuthorization()` が bearer ハンドラーを実行すべきだと分かるようになります。*単一*の bearer スキームを登録するとき、これが正しいデフォルトです。この「有効なトークンなのに黙って 401」というバグの一群、デフォルトスキームの欠落、ミドルウェアの順序の誤り、スキーム名の不一致は、独自のガイドを持つほど一般的です。[ASP.NET Core の JWT が有効なトークンでも 401 を返す理由](/ja/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/) を参照してください。

## login エンドポイントからトークンを発行する

API が自身の ID ソースである場合、資格情報を確認した後に署名済みトークンを渡すエンドポイントが必要です。`SecurityTokenDescriptor` を使って `JsonWebTokenHandler.CreateToken` を呼び出します。

```csharp
// .NET 11, C# 14
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using System.Security.Claims;
using System.Text;

app.MapPost("/login", (LoginRequest req, IConfiguration config) =>
{
    // Replace with a real credential check against your user store.
    if (req is not { Username: "demo", Password: "demo" })
        return Results.Unauthorized();

    var key = new SymmetricSecurityKey(
        Encoding.UTF8.GetBytes(config["Jwt:Secret"]!));

    var descriptor = new SecurityTokenDescriptor
    {
        Issuer = "https://my-api.example.com",
        Audience = "https://localhost:7259",
        Expires = DateTime.UtcNow.AddMinutes(15),
        SigningCredentials = new SigningCredentials(
            key, SecurityAlgorithms.HmacSha256),
        Subject = new ClaimsIdentity(new[]
        {
            new Claim(ClaimTypes.Name, req.Username),
            new Claim(ClaimTypes.Role, "user"),
        }),
    };

    var token = new JsonWebTokenHandler().CreateToken(descriptor);
    return Results.Ok(new { access_token = token });
});

record LoginRequest(string Username, string Password);
```

HMAC シークレットは `HS256` の場合、少なくとも 256 ビット（32 バイト）でなければなりません。さもないと署名層が `IDX10720` をスローします。それをソースコードの外に保ってください。開発では user secrets を使い（`dotnet user-secrets set "Jwt:Secret" "<a-long-random-string>"`）、本番では本物のシークレットストアを使います。これは lifetime が 15 分の自己発行 access トークンです。資格情報を再入力せずにクライアントをそれ以上ログイン状態に保ちたい場合は、[ASP.NET Core Identity で refresh トークンを実装する方法](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) で説明されている refresh フローと組み合わせてください。

## エンドポイントを保護し、呼び出し元の claim を読む

引数なしの `.RequireAuthorization()` は「任意の認証済みユーザー」を意味します。ハンドラー内で `ClaimsPrincipal` を注入して、呼び出し元が誰かを読み取ります。

```csharp
// .NET 11, C# 14
app.MapGet("/orders", (ClaimsPrincipal user) =>
{
    var name = user.Identity!.Name;               // ClaimTypes.Name
    var isAdmin = user.IsInRole("admin");         // ClaimTypes.Role
    var sub = user.FindFirstValue(ClaimTypes.NameIdentifier);
    return Results.Ok(new { name, isAdmin, sub });
})
.RequireAuthorization();
```

claim 名についての 1 つの細かな点です。`JwtBearerOptions.MapInboundClaims` はデフォルトで `true` であり、`sub` や `role` のような短い JWT claim 名を、長い WS-* URI（`ClaimTypes.NameIdentifier`、`ClaimTypes.Role`）に書き換えます。生の短い名前で作業したい場合は、`options.MapInboundClaims = false` を設定し、それから `TokenValidationParameters.NameClaimType` と `RoleClaimType` を、トークンが実際に持っているものに向けてください。このマッピングこそ、有効なトークンでも `user.Identity.Name` が null になり得る理由です。トークンに、設定された `NameClaimType` に一致する claim がなかったのです。

## より細かいアクセスのためにロールと claim のポリシーを追加する

「任意の認証済みユーザー」で十分なことはめったにありません。一括のゲート以上の何かには、名前付きポリシーを一度定義し、名前で付与してください。`AddAuthorizationBuilder` は minimal API に優しい方法です。

```csharp
// .NET 11, C# 14
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("admin_only", policy =>
        policy.RequireRole("admin"))
    .AddPolicy("can_write_orders", policy =>
        policy
            .RequireRole("admin")
            .RequireClaim("scope", "orders_api"));

// ...

app.MapDelete("/orders/{id}", (int id) => Results.NoContent())
    .RequireAuthorization("admin_only");

app.MapPost("/orders", (object order) => Results.Created())
    .RequireAuthorization("can_write_orders");
```

ポリシーとは、呼び出し元が満たさなければならない要件の集合です。`RequireRole` はロール claim を確認し、`RequireClaim("scope", "orders_api")` はその値を持つ `scope` claim が存在することを確認します。認証はされたがポリシーで落ちた呼び出し元は、401 ではなく **403** を得ます。この区別はデバッグ時に重要です。401 は「あなたが誰か分からない」（認証）を意味し、403 は「分かっているが、許可されていない」（認可）を意味します。403 が見えているなら、トークンを見るのをやめてポリシーを見てください。

複数のエンドポイントが 1 つのポリシーを共有する場合は、`.RequireAuthorization("...")` を各エンドポイントで繰り返さないでください。それらをグループ化して要件が 1 か所に存在するようにします。これはまた、スキームやポリシーがルート間で黙ってずれるのを防ぎます。

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin").RequireAuthorization("admin_only");
admin.MapGet("/stats", () => "admin stats");
admin.MapDelete("/orders/{id}", (int id) => Results.NoContent());
```

ネストしたグループやグループ単位のフィルターを含むグループ化のパターンは、[MapGroup で minimal API のエンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) で扱っています。

## login の UI を作らずにテストする

設定を試すのに、クライアントも本物の ID プロバイダーも必要ありません。`dotnet user-jwts` ツールは、開発設定にも組み込む鍵で署名されたトークンを鋳造するため、検証が鍵の不一致で失敗することはありません。

```bash
# .NET 11 SDK, run in the project directory
dotnet user-jwts create
```

プロジェクトに対して実行すると、ツールは対応する検証オプション（`dotnet-user-jwts` という `ValidIssuer` に加えて、アプリの URL を `ValidAudiences` として）を `appsettings.Development.json` に書き込み、すぐ使えるトークンを出力します。ポリシーが要求するロールと scope を持つトークンを鋳造するには次のようにします。

```bash
# .NET 11 SDK
dotnet user-jwts create --role "admin" --scope "orders_api"
```

そして送信します。

```bash
# {token} is the value dotnet user-jwts printed
curl -i -H "Authorization: Bearer {token}" https://localhost:7259/orders
```

ヘッダーの形式は厳密です。文字どおりの単語 `Bearer`、1 つのスペース、それから生のトークンで、引用符はありません。`user-jwts` のトークンは認証されるのに本物のプロバイダーのトークンは認証されない場合、違いはトークンの claim か署名鍵にあり、あなたの配線にはありません。`user-jwts` のトークンさえ 401 を返すなら、配線がまだ間違っています。デフォルトスキームとミドルウェアの順序を再確認してください。

## 7 ステップでの設定

全体の流れをチェックリストとしてまとめます。

1. パッケージを追加します: `dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer`。
2. スキームを登録してデフォルトにします: `builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();`。
3. 認可を追加します: `builder.Services.AddAuthorization();`（ポリシーを定義するなら `AddAuthorizationBuilder()`）。
4. 有効なトークンがどのようなものかを設定します。`Authentication:Schemes:Bearer` の設定セクション、OIDC プロバイダー向けの `options.Authority`、または自己署名トークン向けのコード内 `TokenValidationParameters` のいずれかで行います。
5. `.RequireAuthorization()` でエンドポイントを保護し、ロールや claim の要件にはポリシー名を追加します。
6. `WebApplication` にミドルウェアを自動追加させるか、順序（たとえば CORS）が要求するときだけ `UseAuthentication` に続けて `UseAuthorization` を手動で呼びます。
7. `dotnet user-jwts create` と、`Authorization: Bearer` ヘッダーを持つ `curl` リクエストでテストします。

これがハッピーパスの全体です。これを整理して保つメンタルモデルはこうです。認証はトークンを検証して `HttpContext.User` を埋めることで呼び出し元が*誰*かを決め、認可はポリシーを評価することでその呼び出し元が続行して*よいか*を決めます。この 2 つの仕事を頭の中で分けておけば、ほぼすべての JWT の問題は「トークンが間違っている」（検証の問題）か「配線が間違っている」（スキーム、ミドルウェア、ポリシーの問題）に整理されます。bearer トークンがサーバーサイドセッションに対してアプリにとって正しい選択かどうかをまだ決めかねているなら、[ASP.NET Core 11 における JWT vs cookie 認証](/ja/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) でトレードオフを比較してください。

## 出典

- [Authentication and authorization in Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security)、Microsoft Learn。ミドルウェアの自動登録、`AddAuthorizationBuilder`、`dotnet user-jwts` の挙動について。
- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication)、Microsoft Learn。
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn)、Microsoft Learn。
- [Microsoft.AspNetCore.Authentication.JwtBearer（NuGet）](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer)。
- [.NET 11 Preview 5 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/)、.NET Blog。現在の preview と 2026 年 11 月の GA 目標について。
