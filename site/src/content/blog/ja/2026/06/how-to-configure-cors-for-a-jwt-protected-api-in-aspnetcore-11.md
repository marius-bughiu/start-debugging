---
title: "ASP.NET Core 11 で JWT 保護された API の CORS を設定する方法"
description: "ASP.NET Core 11 における bearer トークン API の CORS 完全ガイド。認証に対する UseCors の正しい順序、Authorization ヘッダーの bearer トークンが CORS の資格情報ではない理由、AllowAnyHeader は機能するのに手書きのワイルドカードが Authorization を含めない理由、そして preflight を失敗させない方法を解説します。"
pubDate: 2026-06-21
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "cors"
  - "jwt"
  - "security"
lang: "ja"
translationOf: "2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-21
---

シングルページアプリが別のオリジンから JWT 保護された ASP.NET Core API を呼び出し、ブラウザーのコンソールに "No 'Access-Control-Allow-Origin' header is present" や "Request header field authorization is not allowed" が表示される場合、修正箇所はほぼ認証側ではありません。必要なのは、`WithOrigins` でフロントエンドのオリジンを指定し、`Authorization` リクエストヘッダーを許可し、`app.UseCors(...)` を `app.UseAuthentication()` と `app.UseAuthorization()` の *前* に実行する CORS ポリシーです。多くのガイドが誤っている点は次のとおりです。自分で `Authorization` ヘッダーに設定する bearer トークンは CORS の資格情報では **ありません**。したがってヘッダーベースの JWT API には `AllowCredentials()` は **不要** であり、追加すると何の利点もなく `AllowAnyOrigin` を手放すことを強いられます。この記事は .NET 11（執筆時点では preview 5）を対象としていますが、CORS と JWT bearer の API は .NET 8、9、10 から変わっていません。

## CORS と JWT は無関係な 2 つのゲートであり、同時に失敗する

`https://app.example.com` から `https://api.example.com` へのクロスオリジンリクエストは、完全に独立した 2 つのチェックを通過します。この 2 つを混同することが、ここで無駄にする午後のほぼすべての根本原因です。

1 つ目は CORS です。これを強制するのはブラウザーであり、サーバーではありません。ブラウザーは、サーバーが送信する `Access-Control-Allow-*` ヘッダーに基づいて、*JavaScript がレスポンスを読み取ってよいか* を決定します。CORS はあなたが誰であるかを一切知りません。オリジン、メソッド、リクエストヘッダーだけを気にします。

2 つ目は認証です。ASP.NET Core の JWT bearer ハンドラーは `Authorization` ヘッダー内のトークンを検証し、401 または `ClaimsPrincipal` を生成します。オリジンについては一切知りません。

落とし穴は、設定を誤った CORS ポリシーと欠落したトークンが、DevTools では似たエラーを生成することです。CORS ヘッダーのない 401 はコンソールでは CORS の失敗として表示されます。なぜなら、ブラウザーはコードがレスポンスを見られるようになる前にそれを破棄するからです。そのため、本当の問題がポリシーの順序であるのにトークンに 1 時間を費やしたり、その逆になったりします。頭の中でこの 2 つのゲートを分けておきましょう。CORS はブラウザーがバイトをあなたに渡すかどうかを決め、認証はサーバーがそれを生成したかどうかを決めます。

## Authorization ヘッダーの bearer トークンは CORS の「資格情報」ではない

これは最も誤解されている点であり、これを正しく理解すると以降のすべてが単純になります。

CORS の仕様において「資格情報」とは、3 つの具体的なものを意味します。クッキー、TLS クライアント証明書、そして保存された HTTP 認証から *ユーザーエージェントが自動的に* 設定する `Authorization` ヘッダーです。`fetch(url, { headers: { Authorization: "Bearer " + token } })` と書く場合、あなたは作成者が定義したリクエストヘッダーを設定しています。これは資格情報付きのリクエストではありません。その fetch の `credentials` モードは依然としてデフォルトの `"same-origin"` であり、クロスオリジン呼び出しでは「クッキーを送らない」を意味します。

その結果として、JWT をメモリや `localStorage` に保存して手動で付与する一般的な SPA では、`AllowCredentials()` を呼び出す **べきではありません**。これが必要になるのは、トークン（あるいはリフレッシュトークン、あるいはセッション）がクッキーに乗る場合だけです。クッキーは本物の CORS の資格情報であり、レスポンスが `Access-Control-Allow-Credentials: true` と言わない限り、ブラウザーはクロスオリジンでそれを送りません。

これが些末な話を超えてなぜ重要なのでしょうか。それは `AllowCredentials()` が `AllowAnyOrigin()` と両立しないからです。資格情報を追加した瞬間、CORS の仕様はオリジンのワイルドカード `*` を禁止し、ASP.NET Core は起動時に例外をスローしてこれを強制します。

```csharp
// .NET 11, C# 14
// This throws ArgumentException at app build time:
// "The CORS protocol does not allow specifying a wildcard (any) origin
//  and credentials at the same time."
options.AddPolicy("bad", policy => policy
    .AllowAnyOrigin()
    .AllowCredentials());
```

したがって、ヘッダーベースの bearer API に反射的に `AllowCredentials()` を追加すると、何の利点もなくオリジン固定の制約だけを背負い込むことになります。実際にクッキーを使うのでない限り、これは外しておきましょう。

## 機能するポリシー

JWT を検証し、1 つまたは複数の既知のフロントエンドオリジンから呼び出される minimal API のための、完全で正しいセットアップを以下に示します。minimal API と MVC モデルのどちらにするかをまだ検討中であれば、トレードオフは [ASP.NET Core 11 における minimal API とコントローラーの比較](/ja/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/) で扱っています。CORS はどちらでも同一です。

```csharp
// .NET 11, C# 14
var builder = WebApplication.CreateBuilder(args);

const string SpaCors = "spa";

builder.Services.AddCors(options =>
{
    options.AddPolicy(SpaCors, policy => policy
        .WithOrigins("https://app.example.com", "http://localhost:5173")
        .WithHeaders("Authorization", "Content-Type")
        .WithMethods("GET", "POST", "PUT", "DELETE")
        .SetPreflightMaxAge(TimeSpan.FromMinutes(10)));
});

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
        // TokenValidationParameters tuned for your issuer here.
    });

builder.Services.AddAuthorization();

var app = builder.Build();

// Order is load-bearing. See the next section.
app.UseCors(SpaCors);
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/me", (ClaimsPrincipal user) => user.Identity!.Name)
    .RequireAuthorization();

app.Run();
```

このポリシーにおける 3 つの意図的な選択です。

- `WithOrigins` は、スキームとポートを含む正確なオリジンを列挙します。`http://localhost:5173` と `https://localhost:5173` は別のオリジンであり、同じホストの別ポートも同様です。
- `WithHeaders("Authorization", "Content-Type")` は、JSON+JWT の呼び出しが実際に送る 2 つのリクエストヘッダーを許可します。`Content-Type: application/json` は CORS のセーフリストに含まれる値ではないため、それ自体で preflight を引き起こします。
- `WithMethods` は API が公開する動詞を列挙します。`PUT` や `DELETE` は常に preflight を引き起こします。

これはヘッダーベースの bearer API なので、`AllowCredentials()` はありません。

## なぜ UseCors は UseAuthentication より前に実行する必要があるのか

ミドルウェアの順序は見た目の問題ではありません。`app.UseCors(...)` は、`UseRouting`（`WebApplication` が暗黙的に呼び出します）の後、かつ `UseAuthentication` と `UseAuthorization` の **前** に置く必要があります。Microsoft の [CORS のドキュメント](https://learn.microsoft.com/en-us/aspnet/core/security/cors) がこのルールを定めています。これを無視すると実際に何が壊れるのかを以下に示します。

CORS の preflight は `OPTIONS` リクエストであり、ブラウザーはそれを `Authorization` ヘッダー **なしで** 送信します。これは設計上のものです。preflight は、資格情報が付与される前に「このリクエストをしてもよいか？」と尋ねます。認証や `[Authorize]`/`RequireAuthorization` のチェックが CORS ミドルウェアより前に実行されると、認証されていない `OPTIONS` リクエストは 401 を受け取り、ブラウザーは `Access-Control-Allow-*` ヘッダーを決して受け取らず、本来のリクエストは決して送信されません。Network タブで preflight の失敗を見て、トークンが不正だと誤って結論づけることになります。

`UseCors` を先に置くと、CORS ミドルウェアが preflight を認識し、204 と正しいヘッダーで応答して、認証が実行される前にショートサーキットします。続く本来の `GET`/`POST` はトークンを携え、通常どおり認証を通過します。

同じ順序は、本来のリクエストにおける「CORS ヘッダーのない 401」問題も修正します。トークンが欠落または期限切れのとき、ブラウザーがレスポンスを公開して SPA がステータスを読み取りログインへリダイレクトできるよう、401 が引き続き `Access-Control-Allow-Origin` を携えていて *ほしい* はずです。これは、401 を生成する認証ミドルウェアより前に CORS が実行される場合にのみ起こります。まさにこのギャップが ASP.NET Core の長年の課題（[dotnet/aspnetcore#16584](https://github.com/dotnet/aspnetcore/issues/16584)）の対象であり、順序がその解決策です。

## Authorization ヘッダーのワイルドカードの落とし穴

これは、開発時に寛容にしておいて後で締め付ける人を襲います。[Fetch 標準](https://fetch.spec.whatwg.org/) によれば、また [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers) に文書化されているとおり、`Access-Control-Allow-Headers: *` のワイルドカードは `Authorization` ヘッダーを **含めません**。ブラウザーは `Authorization` を特別扱いします。明示的に名前を挙げる必要があり、そうしないと bearer トークンを携えるあらゆるリクエストの preflight が "Request header field authorization is not allowed by Access-Control-Allow-Headers" で失敗します。

したがって、独自ミドルウェアでリテラルの `Access-Control-Allow-Headers: *` を使って CORS を手書きすると、ワイルドカードがすべてを許可しているように見えても、JWT の呼び出しは壊れます。

ASP.NET Core ユーザーにとって安心できる点があります。組み込みの `AllowAnyHeader()` はリテラルの `*` を出力 **しません**。`CorsService` はブラウザーが `Access-Control-Request-Headers` で要求したヘッダーをそのまま返すため、`Authorization` が反射され、preflight が成功します。これは [CorsService のソース](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs) で確認できます。許可ヘッダーの値は、定数の `*` ではなく `GetCommaSeparatedValues(CorsConstants.AccessControlRequestHeaders)` から来ています。

ここから導かれる実用的なルールです。

- `AllowAnyHeader()` は bearer トークンに対して問題なく機能します。ASP.NET Core はワイルドカードではなく反射するからです。
- `WithHeaders(...)` は、リストに `"Authorization"` を含めた場合にのみ機能します。それを忘れることは、JWT API で最も多い自滅的な CORS の失敗です。`Content-Type` だけでは完全に見え、403/preflight のエラーが具体性に欠けるためです。

迷ったら `Authorization` を明示的に列挙してください。コストはゼロで、ひとつのクラスのバグを取り除けます。

## 正しく設定する手順

1. `AddCors` で名前付きポリシーを使って CORS を登録し、`WithOrigins`（正確なスキーム、ホスト、ポート）でフロントエンドのオリジンを固定します。
2. クライアントが送るリクエストヘッダーを許可します。`WithHeaders` で `"Authorization"` と `"Content-Type"` を明示的に含めるか、`AllowAnyHeader()` を使って ASP.NET Core のヘッダー反射に頼ります。
3. エンドポイントが公開する HTTP メソッドを `WithMethods` で許可します。常に preflight を引き起こす動詞（`PUT`、`DELETE`）を含めます。
4. 資格情報について決めます。ヘッダーベースの bearer トークンでは `AllowCredentials()` を省きます。クッキーが関わる場合のみ追加し、その場合は `AllowAnyOrigin` を明示的な `WithOrigins` に置き換えます。
5. `app.UseCors("policy")` をルーティングの後、`app.UseAuthentication()` と `app.UseAuthorization()` の前に置きます。
6. ポリシーを `app.UseCors(...)` でグローバルに適用するか、エンドポイントごとに `.RequireCors("policy")`（またはコントローラーでは `[EnableCors("policy")]`）で適用します。同じアプリでグローバルなミドルウェア CORS と属性を混在させないでください。

## クッキー、リフレッシュトークン、そして資格情報付きのケース

設計上、アクセストークンをメモリに保持しつつリフレッシュトークンを `HttpOnly` クッキーに保存する場合（一般的で堅実なパターンです。[ASP.NET Core Identity でリフレッシュトークンを実装する方法](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) を参照）、リフレッシュ呼び出しは *資格情報付き* となり、ルールが逆転します。

```csharp
// .NET 11, C# 14
options.AddPolicy("spa-with-cookie", policy => policy
    .WithOrigins("https://app.example.com") // exact origins only, no AllowAnyOrigin
    .WithHeaders("Authorization", "Content-Type")
    .WithMethods("GET", "POST", "PUT", "DELETE")
    .AllowCredentials());                    // required so the browser sends the cookie
```

クライアント側では、まさにそのエンドポイントに `fetch(url, { credentials: "include" })` が必要です。サーバーは具体的な `Access-Control-Allow-Origin`（決して `*` ではない）と `Access-Control-Allow-Credentials: true` で応答する必要があり、上記のポリシーはまさにそれを生成します。ASP.NET Core は依然として許可ヘッダーをワイルドカードではなく反射するため、資格情報付きのケースでも `Authorization` は引き続き機能します。要点は、`AllowCredentials()` を実際にクッキーに触れるポリシーに限定し、API 全体には適用しないことです。

## preflight のおしゃべりを減らす

単純でないメソッドやヘッダーを伴うクロスオリジンリクエストは、すべて preflight の往復のコストを支払います。`SetPreflightMaxAge(TimeSpan.FromMinutes(10))` は、preflight の結果をキャッシュしてよいとブラウザーに伝えるため、同じエンドポイントへの繰り返しの呼び出しは `OPTIONS` のホップを省略します。ブラウザーはこの値を上限で制限します（Chromium は最大 2 時間、Firefox は最大 24 時間を尊重し、両者ともそれぞれの上限があります）。したがって、保証ではなくヒントとして扱ってください。それでも、おしゃべりな API では設定する価値があります。

フロントエンドのオリジンが少数で、どこでも同じポリシーでよいなら、`AddDefaultPolicy` とパラメーターなしの `app.UseCors()` のほうが、名前付きポリシーより少しだけ手間が少なくなります。エンドポイントのグループごとに異なるルールを持つ大きめの API では、名前付きポリシーを `MapGroup` 上の `.RequireCors(...)` と組み合わせます。これは [MapGroup で minimal API のエンドポイントを整理する](/ja/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) で説明した構造と自然に組み合わさります。

## トークンが拒否され、CORS が問題ではないとき

preflight が通過し、本来のリクエストが `Access-Control-Allow-Origin` を携えたら、残るどの 401 も本物の認証の失敗であり、CORS を見るのはやめるべきです。よくある容疑者は、一致しない `Audience` や `Authority`、トークン有効期限のクロックスキュー、あるいはヘッダーを黙って落とすツールです。Scalar や Swagger のような UI が、貼り付けたにもかかわらず bearer トークンなしでリクエストを送る場合、それは別の、よく文書化された問題であり、[Scalar で bearer トークンが無視される理由](/ja/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) と [Swagger UI に OpenAPI 認証フローを追加する](/ja/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/) で扱っています。

トラブルを避ける思考モデルはこうです。CORS は「このクロスオリジン呼び出しは許可されているか、そしてその答えを読んでよいか？」と尋ねるブラウザーであり、JWT bearer は「このトークンを信頼するか？」と尋ねるサーバーです。オリジンと `Authorization` ヘッダーを指定するようポリシーを設定し、`UseCors` を認証ミドルウェアの前に実行し、クッキーが関わらない限り `AllowCredentials` を省けば、この 2 つのゲートは互いに干渉しなくなります。

出典: [Enable Cross-Origin Requests (CORS) in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/cors), [Access-Control-Allow-Headers - MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers), [Fetch Standard - WHATWG](https://fetch.spec.whatwg.org/), [CorsService source - dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs), [aspnetcore#16584 - CORS headers and JWT bearer 401](https://github.com/dotnet/aspnetcore/issues/16584).
