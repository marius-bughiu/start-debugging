---
title: ".NET 11 で Swagger UI に OpenAPI 認証フローを追加する方法"
description: ".NET 11 では OpenAPI ドキュメントは Microsoft.AspNetCore.OpenApi が生成し、Swagger UI はテンプレートに含まれません。Bearer、PKCE 付き OAuth2、OpenID Connect を Authorize ボタンが実際に動くように接続する方法を解説します。"
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "openapi"
  - "swagger"
  - "authentication"
  - "dotnet-11"
template: how-to
lang: "ja"
translationOf: "2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11"
translatedBy: "claude"
translationDate: 2026-04-28
---

.NET 11 では OpenAPI ドキュメントは `Microsoft.AspNetCore.OpenApi` が生成し、Swagger UI はプロジェクトテンプレートに含まれていません。Authorize ボタンが実際にヘッダーを送るようにするには、3 つのピースを連携させる必要があります。OpenAPI ドキュメントにセキュリティスキームを登録する document transformer、エンドポイントに必要な認証を宣言させるグローバルまたはオペレーション単位の security requirement、そして OAuth2 や OpenID Connect を使う場合は OAuth クライアント設定で構成された Swagger UI ミドルウェア（`Swashbuckle.AspNetCore.SwaggerUI`）です。本記事では Bearer JWT、PKCE 付き OAuth2 authorization code、OpenID Connect を、すべて .NET 11 GA 上で順に解説します。

本文中で参照するバージョン: .NET 11.0 GA、`Microsoft.AspNetCore.OpenApi` 11.0、`Swashbuckle.AspNetCore.SwaggerUI` 7.x、`Microsoft.AspNetCore.Authentication.JwtBearer` 11.0。サンプルは minimal API ですが、同じ transformer は MVC controller でもそのまま動きます。

## .NET 8 から何が変わったか

.NET 8 以前では `Swashbuckle.AspNetCore` が標準で同梱されていました。`AddSwaggerGen()` を呼ぶだけで、認証スキーム、要件、UI オプションをすべて 1 か所で構成できました。.NET 9 以降、テンプレートはドキュメント生成に `Microsoft.AspNetCore.OpenApi` を採用し、Swagger UI を完全に削除しています。.NET 11 もこの分離を維持しています。

これは認証フローにとって 2 つの意味を持ちます。

1. OpenAPI ドキュメントは Swashbuckle の責務ではなくなったため、Stack Overflow にある `OperationFilter` や `DocumentFilter` のサンプルはすべて古くなりました。新しい拡張ポイントは `IOpenApiDocumentTransformer` と `IOpenApiOperationTransformer` です。
2. Swagger UI はオプションになりました。再び使うなら `Swashbuckle.AspNetCore.SwaggerUI`（UI パッケージのみ、約 600 KB）をインストールし、新しいジェネレーターが出力する JSON ドキュメントを指し示します。

「試しに叩く UI」だけでよければ、[Scalar の方が軽量な選択肢](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) です。同じ OpenAPI ドキュメントを読みます。下の transformer は OpenAPI 3.x の有効なセキュリティモデルを生成するため、仕様に従う UI ならどれでも認証フローを拾います。

## 最小限の Bearer JWT 構成

最もシンプルなスキームから始めます: `http` に `bearer` と JWT 形式ヒントを付けたものです。OpenAPI ジェネレーター、UI、JWT bearer 認証をインストールします。

```bash
# .NET 11
dotnet add package Microsoft.AspNetCore.OpenApi
dotnet add package Swashbuckle.AspNetCore.SwaggerUI
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

スキームを登録する document transformer を追加します。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.OpenApi;
using Microsoft.OpenApi.Models;

internal sealed class BearerSecuritySchemeTransformer : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["Bearer"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.Http,
            Scheme = "bearer",
            BearerFormat = "JWT",
            In = ParameterLocation.Header,
            Description = "Paste a JWT issued by your IdP."
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "Bearer"
                }
            }] = []
        });

        return Task.CompletedTask;
    }
}
```

これを登録し、JSON と UI を提供します。

```csharp
// .NET 11, C# 14, Program.cs
using Microsoft.AspNetCore.Authentication.JwtBearer;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi(options =>
{
    options.AddDocumentTransformer<BearerSecuritySchemeTransformer>();
});

builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        o.Authority = "https://login.example.com/";
        o.Audience = "api://my-api";
    });

builder.Services.AddAuthorization();

var app = builder.Build();

app.MapOpenApi();           // serves /openapi/v1.json
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");
});

app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/secret", () => "hello").RequireAuthorization();
app.Run();
```

`/swagger` を開いて **Authorize** をクリックし、トークンを貼り付ければ、Swagger UI は以後すべての呼び出しで `Authorization: Bearer <token>` を送ります。グローバルな `SecurityRequirements` により全オペレーションが要件を継承します。公開エンドポイントが必要な場合は、オペレーション単位で上書きします（後述の「複数のスキーム」を参照）。

## PKCE 付き OAuth2 authorization code

Bearer 構成は「すでにトークンを持っているので貼り付ける」用途には十分ですが、多くのチームは Swagger UI に実際の OAuth ログインを案内させたいはずです。SPA 風のフローには PKCE 付き authorization code を使います。

別の transformer を追加します。

```csharp
// .NET 11, C# 14
internal sealed class OAuth2SecuritySchemeTransformer(IConfiguration config)
    : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        var authority = config["Auth:Authority"]!.TrimEnd('/');

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["oauth2"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.OAuth2,
            Flows = new OpenApiOAuthFlows
            {
                AuthorizationCode = new OpenApiOAuthFlow
                {
                    AuthorizationUrl = new Uri($"{authority}/oauth2/authorize"),
                    TokenUrl = new Uri($"{authority}/oauth2/token"),
                    Scopes = new Dictionary<string, string>
                    {
                        ["api://my-api/read"]  = "Read your data",
                        ["api://my-api/write"] = "Write your data"
                    }
                }
            }
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "oauth2"
                }
            }] = ["api://my-api/read", "api://my-api/write"]
        });

        return Task.CompletedTask;
    }
}
```

これで OpenAPI ドキュメント側は完成です。Swagger UI 側にも、自分自身が IdP に対して何者であるかを伝える必要があります。そうしないと authorize エンドポイントからのリダイレクトが `invalid_client` で失敗します。

```csharp
app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");

    c.OAuthClientId("swagger-ui");        // public client registered with the IdP
    c.OAuthUsePkce();                     // mandatory for public clients
    c.OAuthScopes("api://my-api/read");
    c.OAuthAppName("Swagger UI for My API");
});
```

IdP 側の登録で見落とされがちな 2 点があります。

- リダイレクト URI は厳密に `https://your-host/swagger/oauth2-redirect.html` でなければなりません。Swashbuckle がこのページを同梱しています。独自に作らないでください。
- クライアントは *public* クライアント（シークレットなし）である必要があります。IdP が public クライアントを拒否する場合は、マシン間通信用に client credentials へ切り替え、UI 上のフローは諦めましょう。

## discovery 経由の OpenID Connect

IdP が discovery ドキュメントを公開している場合は、URL をハードコードするより `openIdConnect` を選んでください。Swagger UI 7.x が discovery ドキュメントを読み、残りを推測してくれます。

```csharp
// .NET 11, C# 14
internal sealed class OidcSecuritySchemeTransformer(IConfiguration config)
    : IOpenApiDocumentTransformer
{
    public Task TransformAsync(
        OpenApiDocument document,
        OpenApiDocumentTransformerContext context,
        CancellationToken ct)
    {
        var authority = config["Auth:Authority"]!.TrimEnd('/');

        document.Components ??= new OpenApiComponents();
        document.Components.SecuritySchemes["oidc"] = new OpenApiSecurityScheme
        {
            Type = SecuritySchemeType.OpenIdConnect,
            OpenIdConnectUrl = new Uri($"{authority}/.well-known/openid-configuration")
        };

        document.SecurityRequirements.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = "oidc"
                }
            }] = ["openid", "profile", "api://my-api/read"]
        });

        return Task.CompletedTask;
    }
}
```

`openIdConnect` スキームは OpenAPI 3.0.1 以降で有効であり、Swagger UI に対して `authorization_endpoint`、`token_endpoint`、`scopes_supported` の単一の真実の源を提供します。実務的には、Microsoft Entra ID、Auth0、Keycloak など `/.well-known/openid-configuration` を公開する IdP に対する最もクリーンな構成です。それでも Swagger UI 側の `OAuthClientId` と `OAuthUsePkce` は必要です。discovery ドキュメントが扱うのは契約の *サーバー* 側だけです。

## 複数のスキームとオペレーション単位の要件

実際の API はたいてい混在しています。いくつかのエンドポイントは API key を受け付け、その他は OAuth を要求し、health プローブは匿名アクセスを許可、といった具合です。document transformer からグローバルな `SecurityRequirements.Add(...)` 呼び出しを外し、要件をオペレーションごとに付与します。

エンドポイントのメタデータを読む operation transformer を追加します。

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authorization;

internal sealed class SecurityRequirementOperationTransformer
    : IOpenApiOperationTransformer
{
    public Task TransformAsync(
        OpenApiOperation operation,
        OpenApiOperationTransformerContext context,
        CancellationToken ct)
    {
        var endpoint = context.Description.ActionDescriptor.EndpointMetadata;
        var hasAuth   = endpoint.OfType<IAuthorizeData>().Any();
        var anonymous = endpoint.OfType<IAllowAnonymous>().Any();

        if (!hasAuth || anonymous) return Task.CompletedTask;

        var schemeId = endpoint
            .OfType<AuthorizeAttribute>()
            .Select(a => a.AuthenticationSchemes)
            .FirstOrDefault(s => !string.IsNullOrEmpty(s)) ?? "oauth2";

        operation.Security.Add(new OpenApiSecurityRequirement
        {
            [new OpenApiSecurityScheme
            {
                Reference = new OpenApiReference
                {
                    Type = ReferenceType.SecurityScheme,
                    Id = schemeId
                }
            }] = []
        });

        return Task.CompletedTask;
    }
}
```

両方の transformer を一緒に登録します。

```csharp
builder.Services.AddOpenApi(o =>
{
    o.AddDocumentTransformer<OAuth2SecuritySchemeTransformer>();
    o.AddDocumentTransformer<ApiKeySecuritySchemeTransformer>();
    o.AddOperationTransformer<SecurityRequirementOperationTransformer>();
});
```

これで `[Authorize]` はオペレーションに鍵マークを描き、`[AllowAnonymous]` はそれをスキップし、`[Authorize(AuthenticationSchemes = "ApiKey")]` は対応するスキームの鍵マークを描きます。OpenAPI ドキュメントは Swashbuckle の旧 `AddSecurityRequirement` オーバーロードと同じ振る舞いに戻りますが、メンテナンス対象の `OperationFilter` はありません。

## 本番で噛みつく落とし穴

公式ドキュメントには載らないものの、トリアージのたびに浮上する事項があります。

**`document.Components` は null になりうる。** 新しく作られた `OpenApiDocument` の `Components` は、何かが値を割り当てるまで `null` です。上記の各 transformer に入っている `document.Components ??= new OpenApiComponents();` という防御的な行はオプションではありません。セクションが欠けているとシリアライザーは `components.securitySchemes` を出力せず、Swagger UI は要件の参照先スキームが存在しないため、警告も出さずに無視します。

**`Reference.Id` はディクショナリのキーと完全一致でなければならない。** スキームを `"Bearer"` で登録しているのに要件が `"bearer"` を使っていると、OpenAPI 3.x からは未解決の `$ref` と見なされ、Swagger UI は鍵アイコンを表示しつつヘッダーを送りません。アプリ単位で大文字小文字を統一してください。

**Persisted authorization は既定でオフ。** ページをリロードするたびにトークンは消えます。開発時の使い勝手のためには `c.EnablePersistAuthorization()` を有効にします。トークンは `localStorage` に保存されるので、本番デプロイメントでは絶対に有効にしないでください。

**ルート以外の path base での OAuth リダイレクト URL。** リバースプロキシの `/api` 配下でアプリが動いている場合、Swagger UI はリダイレクト先を `/api/swagger/oauth2-redirect.html` として組み立てます。IdP 側の登録にもまったく同じパスが含まれていないと、コールバックは `redirect_uri_mismatch` で失敗します。リダイレクトがおかしく見えたら、`Forwarded` ヘッダーと `UsePathBase` を確認してください。

**Native AOT。** .NET 11 時点では、新しい OpenAPI ジェネレーターは任意の transformer に対して trim-safe としてアノテートされていません。`Swashbuckle.AspNetCore.SwaggerUI` の静的ファイル配信は AOT 下でも動きますが、transformer 側はクローズドジェネリックに対する reflection を避けるべきです。`RequiresUnreferencedCode` 警告に当たったら、[minimal API における Native AOT のガイド](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/) を参照してください。

**オペレーション単位の要件は追加されるだけで、置き換えではない。** ドキュメントにグローバルな `SecurityRequirements` *と* operation transformer の追加要件の両方があると、両者は OpenAPI の OR セマンティクスで代替として評価されます。公開エンドポイントを作るには、`operation.Security` を明示的にクリアする必要があり、transformer をそのまま放置するだけでは足りません。

## 複数ドキュメントでの SwaggerUI の配線

API をバージョニングし、バージョンごとに OpenAPI ドキュメントを発行する場合、Swagger UI のドロップダウンには各バージョンのエンドポイントが必要です。

```csharp
app.MapOpenApi("/openapi/{documentName}.json");

app.UseSwaggerUI(c =>
{
    c.SwaggerEndpoint("/openapi/v1.json", "API v1");
    c.SwaggerEndpoint("/openapi/v2.json", "API v2");

    c.OAuthClientId("swagger-ui");
    c.OAuthUsePkce();
});
```

各ドキュメントは固有の `securitySchemes` を持つため、ドキュメント単位で動く transformer はバージョンごとに 1 回呼ばれます。よい点は、共有状態を追いかける必要がないこと。悪い点は、v2 ドキュメント向けの transformer 登録を忘れると鍵マークが v1 にしか付かないこと。このパターンは `Asp.Versioning` 10.0 の `WithDocumentPerVersion()`（[API バージョニング記事](/2026/04/api-versioning-openapi-dotnet-10/) で扱っています）と素直にかみ合います。

## 関連記事

- [Scalar in ASP.NET Core: why your Bearer token is ignored (.NET 10)](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/)
- [Asp.Versioning 10.0 finally plays nicely with built-in OpenAPI in .NET 10](/2026/04/api-versioning-openapi-dotnet-10/)
- [How to generate strongly-typed client code from an OpenAPI spec in .NET 11](/2026/04/how-to-generate-strongly-typed-client-from-openapi-spec-dotnet-11/)
- [How to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)
- [How to use Native AOT with ASP.NET Core minimal APIs](/2026/04/how-to-use-native-aot-with-aspnetcore-minimal-apis/)

## 出典

- [Microsoft.AspNetCore.OpenApi カスタマイズドキュメント](https://learn.microsoft.com/aspnet/core/fundamentals/openapi/customize-openapi)
- [`IOpenApiDocumentTransformer` API リファレンス](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.openapi.iopenapidocumenttransformer)
- [Swashbuckle.AspNetCore.SwaggerUI 7.x ソース](https://github.com/domaindrivendev/Swashbuckle.AspNetCore/tree/master/src/Swashbuckle.AspNetCore.SwaggerUI)
- [OpenAPI 3.0.3 security requirement object](https://spec.openapis.org/oas/v3.0.3#security-requirement-object)
