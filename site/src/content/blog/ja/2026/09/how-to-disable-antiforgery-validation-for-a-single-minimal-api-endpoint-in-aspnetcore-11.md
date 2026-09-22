---
title: "ASP.NET Core 11 で単一の minimal API フォームエンドポイントだけ antiforgery 検証を無効化する方法"
description: "対象のエンドポイント、または MapGroup に .DisableAntiforgery() を付けます。ASP.NET Core 11 ではこれ 1 つでトークンミドルウェアと新しい自動 CSRF チェックの両方から除外されます。実測したマトリクス、優先順位の落とし穴、より範囲の狭い代替手段を解説します。"
pubDate: 2026-09-22
template: how-to
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "security"
  - "csrf"
lang: "ja"
translationOf: "2026/09/how-to-disable-antiforgery-validation-for-a-single-minimal-api-endpoint-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-09-22
---

**短い答え:** 対象の `MapPost` 呼び出し (またはマシン間通信のエンドポイントだけを含む `MapGroup`) に `.DisableAntiforgery()` をチェーンします。ASP.NET Core 11 では、この 1 回の呼び出しで、フォームの POST を拒否しうる **両方の** レイヤーからエンドポイントが除外されます。トークンベースの `UseAntiforgery()` ミドルウェアと、`WebApplication` が自動で差し込む新しいクロスオリジン CSRF チェックです。ハンドラーに `[RequireAntiforgeryToken(false)]` を付けても同じ効果があります。1 つのエンドポイントを直すためにアプリ全体の `DisableCsrfProtection` スイッチを使ってはいけません。`UseAntiforgery()` を一度も呼んでいないアプリでは、ほかのすべてのフォームエンドポイントが `500` になります。

以下はすべて .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`、ASP.NET Core `11.0.0-rc.1`) で計測し、比較用に .NET 10.0.10 でも実行しました。リクエストのマトリクス、優先順位の落とし穴、より範囲の狭い代替手段は、ドキュメントが自分で発見するよう任せている部分です。

## フォームエンドポイントが想定外のリクエストを拒否する理由

.NET 8 以降、フォームバインドされたパラメーター (`[FromForm]`、`IFormFile`、`IFormCollection`) を持つ minimal API ハンドラーには、antiforgery メタデータが自動的に追加されます。これは `RequestDelegateFactory.InferAntiforgeryMetadata` で確認できます。ファクトリーがフォームからパラメーターをバインドすると、`RequiresValidation = true` の `IAntiforgeryMetadata` がエンドポイントに追加されます。属性を書いたわけではなく、パラメーターの型がそうさせているのです。

このメタデータを読む側が .NET 11 で変わりました。

- **.NET 8 から 10**: これに反応するのは `app.UseAntiforgery()` だけです。これを呼んでいない場合、エンドポイントミドルウェアが `InvalidOperationException: Endpoint HTTP: POST /protected contains anti-forgery metadata, but a middleware was not found that supports anti-forgery.` をスローし、すべてのリクエストが `500` になります。呼んでいる場合は、有効なトークン (とそのクッキー) を持たない POST はすべて `400` になります。
- **.NET 11**: `WebApplication` がルーティングの後に `CsrfProtectionMiddleware` も自動で差し込みます (Preview 6 で追加。[ASP.NET Core 11 で自動 CSRF 保護が有効に](/ja/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/) を参照)。これは同じメタデータを読み、`Sec-Fetch-Site` と `Origin` をチェックして、判定結果を `IAntiforgeryValidationFeature` に記録します。その後、フォームバインダーがその判定を `400` で強制します。

つまり .NET 11 では、フォームの POST が拒否される経路が 2 つあり、それぞれ失敗するクライアントが異なります。トークンミドルウェアは、curl や決済プロバイダーのサーバーを含め、トークンを持たないものをすべて拒否します。CSRF チェックはブラウザー以外のクライアントを通しますが、クロスオリジンのブラウザーからの POST を拒否します。典型的なのは、サードパーティのページが HTML フォームをあなたのサーバーに POST し返すケースです (ホスト型の決済ページ、SAML 風のコールバック、パートナーの "submit to" フォームなど)。

## 各クライアントが実際に受け取るもの

5 つのエンドポイントを持つプローブアプリを 1 つ作り、4 つのパイプライン構成で、それぞれに 4 種類の形のリクエストを送りました。"plain" はブラウザーヘッダーなしの curl、"cross-site" は `Sec-Fetch-Site: cross-site` と外部の `Origin` を送信、"same-origin" は `Sec-Fetch-Site: same-origin` を送信、"外部 Origin のみ" は `Origin` は送るが Fetch Metadata を送らない古いブラウザーを模倣したものです。

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
app.MapPost("/protected", ([FromForm] string name) => $"hello {name}");

app.MapPost("/disabled", ([FromForm] string name) => $"hello {name}")
   .DisableAntiforgery();

app.MapPost("/attr",
    [RequireAntiforgeryToken(false)] ([FromForm] string name) => $"hello {name}");

var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => $"hello {name}");

app.MapPost("/manual", async (HttpRequest req) =>
    $"hello {(await req.ReadFormAsync())["name"]}");
```

デフォルトの .NET 11 パイプライン (`AddAntiforgery` なし、`UseAntiforgery` なし)、Production 環境:

| エンドポイント | plain | cross-site | same-origin | 外部 Origin のみ |
|---|---|---|---|---|
| `/protected` | 200 | **400** | 200 | **400** |
| `/disabled` | 200 | 200 | 200 | 200 |
| `/attr` | 200 | 200 | 200 | 200 |
| `/hooks/payments` | 200 | 200 | 200 | 200 |
| `/manual` | 200 | 200 | 200 | 200 |

`builder.Services.AddAntiforgery()` と `app.UseAntiforgery()` を使った場合 (.NET 8-10 からアップグレードした Blazor や MVC アプリで一般的な構成):

| エンドポイント | plain | cross-site | same-origin | 外部 Origin のみ |
|---|---|---|---|---|
| `/protected` | **400** | **400** | **400** | **400** |
| `/disabled`, `/attr`, `/hooks/payments` | 200 | 200 | 200 | 200 |

`DisableCsrfProtection=true` かつ `UseAntiforgery()` なしの場合: `/protected` はすべてのリクエストで **500** になり、これは同じく計測した `UseAntiforgery()` なしの .NET 10.0.10 とまったく同じです。除外したエンドポイントは 200 のままです。

どのレイヤーが拒否したかはサーバーログでわかります。CSRF レイヤーは `Microsoft.AspNetCore.Antiforgery.CsrfProtectionMiddleware` の下に `Debug` レベルで `Cross-origin CSRF protection marked request POST /protected from origin 'https://evil.example' as invalid.` を記録し、続いてバインダーが内部例外 `CsrfValidationException` とともに `Antiforgery validation failed when reading parameter "string name" from the request body as form.` を記録します。トークンレイヤーは同じバインダーメッセージを、内部例外 `AntiforgeryValidationException: The required antiforgery cookie ".AspNetCore.Antiforgery.<suffix>" is not present.` とともに出力します。Production ではレスポンスボディが空なので、原因不明の `400` を追っているときは `Microsoft.AspNetCore.Http.RequestDelegateFactory` と `Microsoft.AspNetCore.Antiforgery` の `Debug` を有効にしてください。

## 1 つのエンドポイントで無効化する手順

1. そのエンドポイントが本当にブラウザーのクッキーを使うエンドポイントではないことを確認します。安全な候補は、ほかの方法で認証する呼び出し元だけです。HMAC 署名付きの Webhook、API キー、ベアラートークン、mTLS などです。ログイン済みユーザーのブラウザーから POST でき、ハンドラーがそのクッキーの ID に基づいて動作するなら、保護は残してください。
2. その `MapPost` に `.DisableAntiforgery()` をチェーンします。これは `Microsoft.AspNetCore.Builder` にある任意の `IEndpointConventionBuilder` 向けの拡張メソッドなので、Web プロジェクトでは追加の `using` は不要です。
3. 外した保護の代わりに、呼び出し元自身の証明を検証します。フォームエンコードされた Webhook であれば、生のボディに対する署名チェックを、フォームがバインドされる前に実行されるようミドルウェアで行います。
4. 上記の cross-site 形式のリクエスト (`-H 'Sec-Fetch-Site: cross-site' -H 'Origin: https://other.example'`) と plain な curl の両方で再テストし、両方のレイヤーが邪魔をしていないことを確認します。

`application/x-www-form-urlencoded` を POST し、生のボディに HMAC-SHA256 で署名するプロバイダー向けの全体像は次のとおりです。

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var secret = Encoding.UTF8.GetBytes(app.Configuration["Sms:WebhookSecret"]!);

// Verify the signature over the raw body before anything binds the form.
app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/webhooks/sms"), branch =>
    branch.Use(async (ctx, next) =>
    {
        ctx.Request.EnableBuffering();
        using var ms = new MemoryStream();
        await ctx.Request.Body.CopyToAsync(ms);
        ctx.Request.Body.Position = 0;

        var expected = Convert.ToHexStringLower(HMACSHA256.HashData(secret, ms.ToArray()));
        var actual = ctx.Request.Headers["X-Signature"].ToString();

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(actual)))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        await next(ctx);
    }));

app.MapPost("/webhooks/sms", ([FromForm] SmsStatus status) =>
        Results.Ok($"{status.MessageId}: {status.Status}"))
   .DisableAntiforgery();

app.Run();

record SmsStatus(string MessageId, string Status);
```

計測結果: 正しく署名された POST は、plain な curl でも cross-site のブラウザーヘッダー付きでも 200 を返し、誤った署名は 401 を返しました。

最初の草稿ではこのチェックをエンドポイントフィルターに置いていましたが、署名付きリクエストがすべて失敗しました。エンドポイントフィルターが実行される時点では `[FromForm]` パラメーターはすでにバインドされており、フォームリーダーがリクエストストリームを読み切っているため、その時点での `EnableBuffering` にはバッファーするものが何も残っていません。フィルターがハッシュしたのは **0 バイト** でした。生のボディに対する署名チェックはミドルウェアに置くべきで、これは [エンドポイントフィルターとミドルウェアの比較](/ja/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/) で取り上げている具体例の 1 つです。API キーのようなヘッダーだけのチェックであれば、エンドポイントフィルターで問題ありません。

## メソッドとして保持するハンドラー向けの属性形式

ハンドラーがラムダではなく static メソッドであれば、属性のほうが読みやすく、マッピングを移動するリファクタリングにも耐えられます。

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;

app.MapPost("/webhooks/payments", PaymentHooks.Handle);

static class PaymentHooks
{
    [RequireAntiforgeryToken(false)]
    public static IResult Handle([FromForm] string eventId) => Results.Ok(eventId);
}
```

`RequireAntiforgeryTokenAttribute` は `IAntiforgeryMetadata` を直接実装しており、両方のミドルウェアがエンドポイントに `GetMetadata<IAntiforgeryMetadata>()` を問い合わせるので、結果は `.DisableAntiforgery()` と同一です。MVC コントローラーでの同等のものは `[IgnoreAntiforgeryToken]` です。.NET 11 の `AntiforgeryMiddlewareAuthorizationFilter` は、どちらのミドルウェアの判定も尊重します。

## Webhook のグループ全体で無効化する

複数のプロバイダーコールバックがある場合は、1 つのプレフィックスの下にまとめ、グループを一度だけ除外します。

```csharp
// .NET 11 RC 1
var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => Results.Ok());
hooks.MapPost("/sms", ([FromForm] string name) => Results.Ok());
```

これにより、セキュリティ上の判断がファイルに散らばらず 1 か所に見える形で残ります。そもそもこれが [MapGroup で minimal API エンドポイントを整理する](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) 主な理由です。

## プローブで遭遇した優先順位の落とし穴

**グループの除外はエンドポイントの有効化より優先されます。** 無効化されたグループ内の 1 つのエンドポイントについて、次のコードで保護が再び有効になると期待していました。

```csharp
// .NET 11 RC 1: does NOT re-enable validation
hooks.MapPost("/strict", ([FromForm] string name) => $"hello {name}")
     .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

実際にはなりません。`/hooks/strict` はどちらのパイプラインモードでも cross-site リクエストに 200 を返しました。理由は `DisableAntiforgery` 自体にあります。これはメタデータを `builder.Finally(...)` で登録しており、エンドポイント自身の規約の後に実行されます。そして `GetMetadata<T>()` は最後に一致した項目を返します。グループの "not required" が最後に置かれ、勝つわけです。プレフィックス内の 1 つのエンドポイントを保護したままにする必要があるなら、グループ単位で無効化せず、エンドポイントごとに無効化するか、プレフィックスを 2 つのグループに分けてください。

**同じ `Finally` の順序があるからこそ、`.DisableAntiforgery()` は推論されたメタデータに常に勝ちます。** フォームバインダーはエンドポイントの構築中に `RequiresValidation = true` を追加し、`Finally` コールバックはその後に `false` を追加します。呼び出しをチェーンする順序を気にする必要はありません。

**フォームを手動で読むハンドラーには保護がまったくかかりません。** 上の `/manual` エンドポイントはフォームバインドされたパラメーターなしで `req.ReadFormAsync()` を読むため、メタデータが推論されず、どちらのミドルウェアもそれを見ません。cross-site の POST はすべてのモードで 200 を受け取りました。そこで保護が必要なら、`.WithMetadata(new RequireAntiforgeryTokenAttribute())` で明示的に有効化する必要があります。ただしそうすると失敗の仕方が変わります。判定が無効なとき、`FormFeature` はボディの読み取りを拒否して `InvalidOperationException: This form is being accessed with a failed antiforgery validation. Validate the IAntiforgeryValidationFeature on the request before reading from the form.` をスローし、これは 400 ではなく 500 になります。先にフィーチャーを自分でチェックしてください。

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/manual-protected", async (HttpContext ctx) =>
    {
        if (ctx.Features.Get<IAntiforgeryValidationFeature>() is { IsValid: false })
            return Results.BadRequest();

        var form = await ctx.Request.ReadFormAsync();
        return Results.Ok(form["name"].ToString());
    })
    .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

**`DisableCsrfProtection` はエンドポイント単位のツールではありません。** これはアプリ全体から自動で差し込まれるミドルウェアを取り除きます。そのミドルウェアは、`UseAntiforgery()` を一度も呼ばないアプリにとって "a middleware was not found that supports anti-forgery" チェックを満たす役割も担っているため、1 つの Webhook を直すためにこのスイッチを切り替えると、ほかのすべてのフォームエンドポイントが 500 で壊れます (上で計測したとおり)。ドキュメントはこれを非常口と呼んでいます。その扱いにしてください。

## 何かを無効化する前に検討すべき、より範囲の狭い代替手段

署名付きのサーバー間呼び出しなら、無効化が正解です。ブラウザーからのトラフィックには、より厳密な選択肢が 2 つあります。

**CORS を通じて特定のクロスオリジン呼び出し元を信頼する。** デフォルトの `ICsrfProtection` 実装は、エンドポイントに適用される CORS ポリシーを参照します。リクエストの `Origin` が名前付きポリシーまたはデフォルトポリシーで許可されていれば、`Sec-Fetch-Site` が `cross-site` であっても POST は受け入れられます。`AllowAnyOrigin` は意図的に無視されます。

```csharp
// .NET 11 RC 1
builder.Services.AddCors(o => o.AddPolicy("partner",
    p => p.WithOrigins("https://pay.partner.example")));

var app = builder.Build();
app.UseCors();

app.MapPost("/partner-callback", ([FromForm] string orderId) => Results.Ok(orderId))
   .RequireCors("partner");
```

デフォルトパイプラインでの計測結果: パートナーのオリジンは 200、外部オリジンと `same-site` の兄弟サイトは引き続き 400、plain な curl は 200 でした。注意点が 2 つあります。`app.UseCors()` がないと、エンドポイントは `contains CORS metadata, but a middleware was not found that supports CORS` をスローします (500)。また、これが緩めるのは Fetch Metadata レイヤーだけです。パイプラインに `UseAntiforgery()` があると、トークン検証がその後に実行されて判定を上書きし、パートナーからの POST は再び 400 になりました。すでに CORS とクッキーや JWT を組み合わせているなら、ポリシー側については [JWT で保護された API の CORS 設定](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) の記事で扱っています。

**ID プロバイダーのコールバックはフレームワークに任せる。** OpenID Connect の `response_mode=form_post` や WS-Federation のコールバックは、設計上クロスサイトのフォーム POST です。.NET 11 では、リモート認証ハンドラーが自身のコールバックパスを担当している間は無効な判定を抑制します (ソース上の `RemoteAuthenticationAntiforgery`)。`state` パラメーターと相関クッキーがすでにそれらを保護しているからです。`/signin-oidc` に `.DisableAntiforgery()` を付ける必要はありませんし、ハンドラーはエンドポイントではなくミドルウェアなので、そもそも付けることもできません。

## .NET 8、9、10 からアップグレードする際の注意点

- **すでに `UseAntiforgery()` を呼んでいるアプリでは、same-origin のトラフィックに変化はありません**。トークン検証が決定権を持ち、CSRF の判定を上書きするからです。既存の `.DisableAntiforgery()` 呼び出しもそのまま動作し続けます。
- **`UseAntiforgery()` を一度も呼んでいなかったアプリは、.NET 11 でフォームエンドポイントが 500 をスローしなくなります** (CSRF ミドルウェアがエンドポイントのチェックを満たすため)。ただし、クロスオリジンのブラウザーからの POST に 400 を返し始めます。`same-site` も拒否されるため、姉妹サブドメインから POST されるフォームでは、原因不明のリグレッションのように見えることがあります。
- **フォームエンドポイントからの 400 が常に antiforgery によるものとは限りません。** `Content-Type` が欠けているか誤っていると [415 Unsupported Media Type](/ja/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/) になり、バインドの形の誤りは null を生みます。[常に null になる `[FromForm]` ディクショナリ](/ja/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/) がその例です。何かを無効化する前にログカテゴリを確認してください。
- **デプロイ後のトークンエラーは別のバグです。** same-origin のフォームがスケールアウトや再起動の後にだけ失敗するなら、それは除外の不足ではなく Data Protection キーの問題で、[antiforgery トークンを復号できない](/ja/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/) で扱っています。
- **ショートサーキットされたルートは、必須の antiforgery メタデータを持てません。** 検証が必須のままのフォームエンドポイントに `.ShortCircuit()` を付けると、リクエスト時に 500 になります (`contains anti-forgery metadata, but this endpoint is marked with short circuit and it will execute on Routing Middleware`)。エンドポイントを無効化すれば、このチェックは適用されなくなります。

## 関連記事

- [ASP.NET Core 11 Preview 6 で自動 CSRF 保護が有効に](/ja/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)
- [ASP.NET Core 11 で MapGroup を使って minimal API エンドポイントを整理する方法](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [ASP.NET Core 11 におけるエンドポイントフィルターとミドルウェアの比較](/ja/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [修正: ASP.NET Core 11 の minimal API エンドポイントから返される "415 Unsupported Media Type"](/ja/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [修正: ASP.NET Core で antiforgery トークンを復号できない](/ja/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## 出典

- [ASP.NET Core でのクロスサイトリクエストフォージェリ (XSRF/CSRF) 攻撃の防止](https://learn.microsoft.com/aspnet/core/security/anti-request-forgery) (MS Learn、自動 CSRF 保護とエンドポイント単位の除外に関するセクション)
- [.NET 11 Preview 6 の ASP.NET Core リリースノート: 自動クロスオリジン (CSRF) 保護](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md)
- [dotnet/aspnetcore #66585](https://github.com/dotnet/aspnetcore/pull/66585) と [#67082](https://github.com/dotnet/aspnetcore/pull/67082)、CSRF ミドルウェアの PR
- タグ `v11.0.0-rc.1.26425.128` 時点のソース: [`CsrfProtectionMiddleware.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/CsrfProtectionMiddleware.cs)、[`DefaultCsrfProtection.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/DefaultCsrfProtection.cs)、[`RoutingEndpointConventionBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Routing/src/Builder/RoutingEndpointConventionBuilderExtensions.cs)、[`RequireAntiforgeryTokenAttribute.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Antiforgery/src/RequireAntiforgeryTokenAttribute.cs)
