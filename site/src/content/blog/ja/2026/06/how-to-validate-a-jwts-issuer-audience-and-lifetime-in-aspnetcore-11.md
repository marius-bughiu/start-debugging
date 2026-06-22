---
title: "ASP.NET Core 11 で JWT の発行者、対象者、有効期限を検証する方法"
description: "ASP.NET Core 11 における TokenValidationParameters の完全ガイド: ValidateIssuer、ValidateAudience、ValidateLifetime の動作、実際のデフォルト値、なぜ Authority が発行者と署名キーを自動構成するのか、5 分間の ClockSkew の罠、そして一見有効なトークンが拒否されたときに IDX エラーコードを読む方法を解説します。"
pubDate: 2026-06-22
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
lang: "ja"
translationOf: "2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-22
---

ASP.NET Core の JWT bearer ハンドラーは、署名を確認するだけではありません。`TokenValidationParameters` によって制御される一連の独立したチェック、すなわち発行者 (`iss`)、対象者 (`aud`)、有効期限 (`exp` と `nbf`)、そして署名キーを実行します。良いニュースは、`ValidateIssuer`、`ValidateAudience`、`ValidateLifetime`、`ValidateIssuerSigningKey` がすべてデフォルトで `true` であり、トークンが最初から正しくチェックされることです。悪いニュースは、設定値のない「デフォルトで true」はハンドラーがそれでも例外をスローすることを意味し、ここで最もよくある本番環境のバグは、`ClockSkew` がデフォルトで 5 分であるために `exp` を 5 分過ぎても生き続けるトークンだということです。この記事は `Microsoft.AspNetCore.Authentication.JwtBearer` を使った .NET 11 (執筆時点で preview 5) を対象としますが、検証モデルは .NET 8、9、10 から変わっていません。

## bearer ハンドラーが実際に検証するもの

`Authorization: Bearer <token>` を含むリクエストが到着すると、`JwtBearerHandler` は生のトークンをトークンハンドラーに渡します (.NET 8 以降、デフォルトは古い `JwtSecurityTokenHandler` ではなく、より高速な `Microsoft.IdentityModel.JsonWebTokens` の `JsonWebTokenHandler` です)。そのハンドラーは `JwtBearerOptions.TokenValidationParameters` を読み取り、有効化された各チェックを順番に実行します。いずれかのチェックが失敗すると、例外をスローし、ハンドラーは 401 を生成し、レスポンスには説明付きの `WWW-Authenticate: Bearer error="invalid_token"` ヘッダーが付きます。

ほぼすべての API にとって重要な 4 つのチェック:

- **署名** (`ValidateIssuerSigningKey`、デフォルトで有効): トークンの署名がキーに対して検証されます。これは、トークンが秘密キーを保持する者によって発行され、改ざんされていないことを証明します。
- **発行者** (`ValidateIssuer`、デフォルトで有効): `iss` クレームが `ValidIssuer` (または `ValidIssuers` のいずれか) と一致しなければなりません。これにより、別の ID プロバイダーのトークンがあなたの API に対して再送されるのを防ぎます。
- **対象者** (`ValidateAudience`、デフォルトで有効): `aud` クレームが `ValidAudience` (または `ValidAudiences` のいずれか) と一致しなければなりません。これにより、同じ発行者の*別の* API 向けに発行されたトークンがあなたの API に受け入れられるのを防ぎます。
- **有効期限** (`ValidateLifetime`、デフォルトで有効): 現在時刻が `nbf` (not-before) 以降かつ `exp` (有効期限) より前で、`ClockSkew` の許容範囲内でなければなりません。

デフォルト値は `Microsoft.IdentityModel.Tokens.TokenValidationParameters` にあり、[ソースコード](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs) で確認できます。各 `Validate*` フラグは `true` に初期化され、`RequireExpirationTime` と `RequireSignedTokens` も `true` です。検証を*オンにする*のではありません。検証が照合する値を提供するのです。

## 最速で正しいセットアップ: authority を指す

トークンが OpenID Connect プロバイダー (Entra ID、Auth0、Keycloak、Okta、IdentityServer/Duende のインスタンス) から来る場合、署名キーや発行者を手動で設定することはほとんどありません。`Authority` を設定すると、ハンドラーはプロバイダーのメタデータから残りすべてを検出します。

```csharp
// .NET 11, C# 14
// Microsoft.AspNetCore.Authentication.JwtBearer 11.0.0-preview
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        // Discovers issuer + JWKS signing keys from
        // {Authority}/.well-known/openid-configuration
        options.Authority = "https://login.example.com";

        // Maps to TokenValidationParameters.ValidAudience
        options.Audience = "api://my-api";

        // Everything below is already the default, shown for clarity:
        options.TokenValidationParameters.ValidateIssuer = true;
        options.TokenValidationParameters.ValidateAudience = true;
        options.TokenValidationParameters.ValidateLifetime = true;
        options.TokenValidationParameters.ValidateIssuerSigningKey = true;
    });

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/me", (ClaimsPrincipal user) => user.Identity!.Name)
    .RequireAuthorization();

app.Run();
```

`Authority` を設定すると、舞台裏で 2 つのことが起こります:

1. `ConfigurationManager` が `{Authority}/.well-known/openid-configuration` を取得し、そこから JWKS (JSON Web Key Set) エンドポイントを取得します。そこで返される公開署名キーが `IssuerSigningKeys` になり、メタデータの `issuer` 値が `ValidIssuer` になります。マネージャーはこれをキャッシュし定期的に更新するため、プロバイダーでのキーローテーションは再デプロイなしで処理されます。
2. `JwtBearerOptions.Audience` が `TokenValidationParameters.ValidAudience` にコピーされます。

これが、最小限の `Authority` + `Audience` 構成で完全に検証される理由です。発行者、対象者、有効期限、署名がすべてカバーされます。プロバイダーが HTTPS でのみメタデータを提供する場合 (そうあるべきです)、`options.RequireHttpsMetadata = true` を維持してください。これは `Development` 以外でのデフォルトです。

## 自分で署名したトークンを検証する (対称キー)

同じアプリケーションでトークンを発行する場合、たとえば独自のアクセストークンを発行する小さなファーストパーティ API では、検出すべき OIDC メタデータはありません。発行者、対象者、署名キーを明示的に提供します。

```csharp
// .NET 11, C# 14
var key = new SymmetricSecurityKey(
    Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)); // >= 32 bytes for HS256

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://my-api.example.com",

            ValidateAudience = true,
            ValidAudience = "my-api-clients",

            ValidateLifetime = true,

            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,

            // Default is 5 minutes. See the next section.
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });
```

まったく新しい `TokenValidationParameters` を割り当てると、デフォルト値が丸ごと置き換えられることに注意してください。したがって、気にするフラグはすべて列挙してください。HMAC シークレットは `HS256` の場合、少なくとも 256 ビット (32 バイト) でなければなりません。そうでないと、署名レイヤーがトークン作成時に `IDX10720` をスローします。

## ClockSkew の 5 分間の罠

これは最も意外な挙動であり、トークンが有効期限切れになった瞬間に拒否されることを期待するテストを書く人を悩ませます。

`TokenValidationParameters.ClockSkew` はデフォルトで **5 分** (`DefaultClockSkew = TimeSpan.FromMinutes(5)`) です。これは、トークンを発行したマシンと検証するマシンの間の時計のずれを吸収するために存在します。これがないと、システム時計の 1 秒の差が、新しく発行されたトークンを「まだ有効でない」として拒否したり、受け入れたり拒否したりを一貫性なく行ったりする可能性があります。その代償として、`exp` が 12:00:00 のトークンは、検証側サーバーで 12:05:00 まで受け入れられます。

ほとんどの API では、アクセストークンに対する 5 分間の猶予は無害であり、正しいデフォルトです。しかし、短命なトークンを発行する場合 (たとえば、リフレッシュフローに支えられた 60 秒のアクセストークン。[ASP.NET Core Identity でリフレッシュトークンを実装する方法](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) で説明されているパターン)、skew が有効期限を支配し、トークンは実質的に 1 分ではなく 6 分間生き続けます。意図的に厳しくしてください:

```csharp
// .NET 11, C# 14
// Strict expiry. Only safe if your servers run NTP-synced clocks.
options.TokenValidationParameters.ClockSkew = TimeSpan.Zero;
```

`ClockSkew = TimeSpan.Zero` を設定するのは、発行者と API の時計が同期している場合 (両方で NTP。これはどのクラウド環境でも通常です) のみにしてください。ずれる可能性がある場合は、30 秒のような小さな非ゼロ値が妥当な中間点です。予期しないトークン拒否を skew を*上げて*「修正」しないでください。本当に有効期限切れのトークンは拒否されるべきです。時計の問題を隠すために skew を上げるのは、再送ウィンドウを広げるだけです。

## なぜ対象者なしの ValidateAudience = true は起動時の地雷なのか

よくある間違いは、`Audience` / `ValidAudience` を一切設定しないまま `ValidateAudience = true` (デフォルト) を残すことです。ハンドラーには `aud` を比較するものが何もないため、最初のリクエストでスローします:

```text
IDX10208: Unable to validate audience. The 'audience' is null or whitespace
and validationParameters.ValidAudiences is also null or empty.
```

正しい対応が 2 つ、間違った対応がちょうど 1 つあります:

- **正しく、推奨**: `Audience` (または複数の場合は `ValidAudiences`) を設定します。対象者の検証は本物のセキュリティ制御です。これは、共有 Entra テナントで `api://billing` 向けに発行されたトークンが `api://reporting` に対して再送されるのを防ぎます。
- **正しいが、本当に対象者クレームがない場合のみ**: `ValidateAudience = false` を*明示的に*設定し、理由を説明するコメントを書きます。一部のレガシー発行者は `aud` を付与しません。
- **間違い**: 例外をキャッチして黙らせること、または `ValidAudience` を自分が制御しない値に向けること。

同じ形が `ValidIssuer` も `Authority` もない `ValidateIssuer = true` にも当てはまります。`IDX10204` ("Unable to validate issuer") が出ます。`Authority` を設定するとメタデータから `ValidIssuer` が埋められるため、OIDC の経路はこれにめったに当たりません。

## 複数の発行者または対象者を受け入れる

ID プロバイダー間の移行中、または 1 つの API が複数の対象者名で発行されたクライアントにサービスを提供する場合は、複数形のコレクションを使用します。これらは `Authority` から検出されたものに対して加算的です。

```csharp
// .NET 11, C# 14
options.TokenValidationParameters.ValidIssuers = new[]
{
    "https://old-idp.example.com",
    "https://login.example.com",
};
options.TokenValidationParameters.ValidAudiences = new[]
{
    "api://my-api",
    "api://my-api-legacy",
};
```

トークンは、その `iss` が `ValidIssuers` の*いずれか*のエントリと一致し、その `aud` が `ValidAudiences` の*いずれか*のエントリと一致すれば通過します。これにより、切り替え中に両方の発行者を並行して稼働させ、トラフィックが枯渇したら古い方を削除でき、トークンが拒否されるウィンドウは生じません。

## 失敗を読む: IDX コードをオンにする

問題なさそうなトークンが 401 を受け取ると、レスポンスボディは空で、`WWW-Authenticate` ヘッダーは簡潔です。本当の理由は、ハンドラーが飲み込んだ例外の中にあります。デバッグ中にそれを表に出すために `OnAuthenticationFailed` を配線してください:

```csharp
// .NET 11, C# 14
options.Events = new JwtBearerEvents
{
    OnAuthenticationFailed = context =>
    {
        // Logs the underlying SecurityTokenException, e.g. IDX10223
        context.NoResult();
        var logger = context.HttpContext.RequestServices
            .GetRequiredService<ILogger<Program>>();
        logger.LogWarning(context.Exception, "JWT validation failed");
        return Task.CompletedTask;
    },
};
```

`Microsoft.IdentityModel` の `IDX` コードは 4 つのチェックに直接対応しており、これらを知っていればほとんどのデバッグセッションは数秒で終わります:

- `IDX10223`: 有効期限の検証が失敗、トークンは期限切れです。`exp` と `ClockSkew` を確認してください。
- `IDX10205` / `IDX10204`: 発行者が無効、または検証できませんでした。`iss` クレームが `ValidIssuer`/`ValidIssuers` と一致しないか、いずれも構成されていません。
- `IDX10214` / `IDX10208`: 対象者が無効、または検証できませんでした。`aud` クレームが一致しないか、いずれも構成されていません。
- `IDX10503` / `IDX10500`: 署名の検証が失敗、多くの場合 API が持っていないキーです。`Authority` を使っている場合、これは通常、古いメタデータキャッシュか、キーをローテーションしたプロバイダーを意味します。`ConfigurationManager` の更新で解決します。

トークンは検証されるのに `User.Identity?.Name` が null だったり、`[Authorize(Roles = ...)]` チェックが失敗したりする場合、問題は検証ではなくクレームのマッピングです。`JwtBearerOptions.MapInboundClaims` はデフォルトで `true` であり、`sub` や `role` のような短い JWT クレーム名を長い WS-* URI に書き換えます。元の短い名前を保持するには `options.MapInboundClaims = false` を設定し、その後 `TokenValidationParameters.NameClaimType` と `RoleClaimType` をトークンが実際に使うものに設定してください。

## 手順を追ってまとめる

1. 信頼の起点を選びます。OIDC プロバイダーの場合は `options.Authority` を設定します。発行者と署名キーはメタデータから来ます。自己署名トークンの場合は `ValidIssuer` と `IssuerSigningKey` を手動で設定します。
2. 対象者を設定します。`options.Audience` (または `ValidAudiences`) を割り当て、`ValidateAudience = true` がチェックする対象を持つようにします。トークンが本当に `aud` を持たない場合を除き、対象者の検証を無効にしないでください。
3. `ValidateIssuer`、`ValidateAudience`、`ValidateLifetime`、`ValidateIssuerSigningKey` をデフォルトの `true` のままにします。あなたが構成しているのは値であって、スイッチではありません。
4. `ClockSkew` をトークンの有効期限に合わせて設定します。通常のアクセストークンには 5 分のデフォルトを維持し、NTP 同期された時計上の短命なトークンには `TimeSpan.Zero` または 30 秒に下げます。
5. 複数プロバイダーまたは複数対象者のシナリオでは、切り替え中に複数形のコレクション `ValidIssuers` / `ValidAudiences` を使用します。
6. 本番以外で `JwtBearerEvents.OnAuthenticationFailed` のログを追加し、`IDX` コードが 4 つのチェックのどれが失敗したかを教えてくれるようにします。
7. `app.UseAuthentication()` を `app.UseAuthorization()` の前に配置し、ブラウザの SPA が API をクロスオリジンで呼び出す場合は、[JWT で保護された API の CORS を構成する方法](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) に従ってミドルウェアの順序を正しくします。

## 検証は通過するのにリクエストがまだ失敗するとき

4 つのチェックを通過すれば、残りの失敗はもはやトークン検証の問題ではありません。401 ではなく 403 は、トークンは有効だったが認可ポリシーまたはロール要件が満たされなかったことを意味し、これはまったく別のレイヤーです。コードでは動くのにドキュメント UI から失敗するリクエストは、通常、ツールがヘッダーを落としているもので、[なぜ Scalar で bearer トークンが無視されるのか](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) と [Swagger UI に OpenAPI 認証フローを追加する](/ja/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) で扱っています。そして minimal API に認証を配線している場合は、ポリシーが一箇所で適用されるよう保護されたエンドポイントをグループ化してください。[MapGroup で minimal API エンドポイントを整理する](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) に示すとおりです。

これをシンプルに保つメンタルモデル: `TokenValidationParameters` は、ハンドラーがすべてのトークンに尋ねる 4 つの独立した質問です。誰が署名したか? 誰が発行したか? 誰のためのものか? まだ有効期限内か? デフォルト値は 4 つすべてを必須にするので、あなたの唯一の仕事は、それぞれに正しい値を与えること、そして「まだ有効期限内か」はあなたが別途指定するまで 5 分のクッションを持つことを覚えておくことです。

出典: [TokenValidationParameters source - AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs), [Configure JWT bearer authentication in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), [JwtBearerOptions - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.authentication.jwtbearer.jwtbeareroptions), [Microsoft.AspNetCore.Authentication.JwtBearer - NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
