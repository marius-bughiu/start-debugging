---
title: "ASP.NET Core 11 における JWT vs Cookie 認証: どちらを選ぶべきか?"
description: "ブラウザが唯一のクライアントであるアプリには Cookie 認証を使い、JWT ベアラートークンはモバイルアプリ、他サービス、サードパーティから呼び出される API のために取っておきましょう。完全な意思決定マトリクスを示します。"
pubDate: 2026-06-26
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet"
  - "authentication"
  - "security"
lang: "ja"
translationOf: "2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11"
translatedBy: "claude"
translationDate: 2026-06-26
---

ASP.NET Core 11 アプリを呼び出すのがブラウザだけであれば、Cookie 認証を使いましょう。呼び出し元がモバイルアプリ、別のサービス、または Cookie を保持できないサードパーティのクライアントであれば、JWT ベアラートークンを使いましょう。これを決定づける唯一の軸はクライアントです。Cookie はサーバー側での失効とビルトインの CSRF 対策ツールを備えたブラウザのセッション機構である一方、JWT はステートレスで自己完結型の資格情報であり、あらゆる HTTP クライアントが持ち運べますが、有効期限が切れるまで失効させることはできません。サーバーレンダリングのサイトや同一オリジンのシングルページアプリに JWT を選ぶことは、.NET エコシステムで最もよくあるセキュリティ上の間違いです。なぜなら、何の利益もないまま、寿命の長いトークンを JavaScript からアクセス可能なストレージに押し込むことになるからです。この記事では、その推奨を機能マトリクス、.NET 11 における両者の配線、そして判断を強いる落とし穴で裏付けます。

ここで扱う内容はすべて .NET 11、ASP.NET Core 11、C# 14 を対象としています。両方式とも標準で同梱されています。Cookie 認証は `Microsoft.AspNetCore.Authentication.Cookies` にあり、JWT ベアラーは `Microsoft.AspNetCore.Authentication.JwtBearer` にあります。後者が、通常追加する唯一の NuGet 参照です。コアとなるトレードオフは .NET 11 でも何も変わっていませんが、フレームワークは正しいデフォルトへとあなたを後押しし続けています。ブラウザベースアプリ向けの OAuth ガイダンスと Backend-for-Frontend パターンは、どちらもトークンをブラウザから完全に排除するよう、助言をより強固にしています。

## 機能マトリクス

| 機能                          | Cookie 認証                           | JWT ベアラー                            |
| ----------------------------- | ------------------------------------- | --------------------------------------- |
| 運搬される場所                | `Cookie` ヘッダー (ブラウザ管理)      | `Authorization: Bearer` ヘッダー        |
| サーバー状態                  | ステートフル (チケットを再検証可能)   | ステートレス (自己完結型のクレーム)     |
| 有効期限前の失効可否          | 可 (即時)                             | 不可 (拒否リストか短い TTL が必要)      |
| ブラウザによる自動付与        | 可                                    | 不可 (クライアントが付与)               |
| CSRF への露出                 | あり、アンチフォージェリトークンが必要 | なし (ヘッダーは自動送信されない)       |
| 資格情報の XSS への露出       | 低 (`HttpOnly` が JS から隠す)        | JS から読めるストレージに保存すると高   |
| 非ブラウザクライアントでの動作 | やりにくい                            | ネイティブ                              |
| クロスドメイン / マルチ API   | 苦痛 (Cookie のスコープ規則)          | 容易 (どのホストも署名を検証する)       |
| リクエストごとのペイロードサイズ | 小さな不透明な id 風の値             | フルトークン、クレームとともに増える    |
| .NET 11 でのビルトイン        | 可                                    | 可 (`AddJwtBearer`)                     |

実際の設計を左右する行は、失効、CSRF、XSS です。それ以外はすべて配管です。

## それぞれの方式が実際には何なのか

Cookie 認証は、サインイン後に暗号化された認証チケットを発行し、ASP.NET Core の Data Protection 層が署名・暗号化する Cookie に格納します。ブラウザはその Cookie を同一サイトのすべてのリクエストに自動的に付与します。サーバーはそれを復号して `ClaimsPrincipal` を再構築し、リクエストごとに `OnValidatePrincipal` を実行してデータベースに対してユーザーを再チェックできます。これが、ユーザーが無効化された瞬間にセッションを失効させる方法です。

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Cookie.HttpOnly = true;                 // hidden from document.cookie
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
        options.Cookie.SameSite = SameSiteMode.Strict;  // blocks most CSRF by default
        options.ExpireTimeSpan = TimeSpan.FromHours(8);
        options.SlidingExpiration = true;
        options.LoginPath = "/login";
    });
```

決定的な性質は、`HttpOnly` が設定されていると Cookie の値が JavaScript にとって不透明になること、そしてサーバーがそれを無効化するのに十分なコンテキスト (Data Protection キー、オプションでバッキングストア) を保持していることです。その代償は、ブラウザがクロスサイトリクエストで Cookie を自動的に送信するため、CSRF を引き継ぐことになり、アンチフォージェリトークンでそれを防御しなければならないことです。

JWT ベアラー認証は、`Authorization` ヘッダー上の自己完結型トークンを検証します。トークンは署名された (オプションで暗号化された) クレームのかたまりです。サーバー側のセッションは存在せず、検証は純粋に署名とクレームの計算であるため、署名キーや発行者の公開鍵を知っていれば、いくつのサービスでも同じトークンを受け入れられます。トークンを保存し、すべてのリクエストに付与する責任はクライアントにあります。

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";   // for key discovery
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://login.example.com",
            ValidateAudience = true,
            ValidAudience = "my-api",
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true
        };
    });
```

それらの `TokenValidationParameters` を正しく設定することが、ほとんどの JWT バグが潜む場所です。フレームワークが拒否するトークンをデバッグしている場合は、[ASP.NET Core 11 で JWT の発行者、対象者、有効期間を検証する方法](/ja/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) を参照してください。その裏返しとして、有効なトークンを発行取り消しすることはできません。いったん署名されてクライアントの手に渡れば、ユーザーアカウントに何が起ころうとも、`exp` を過ぎるまで受け入れられます。

## Cookie 認証を選ぶべき場面

- **サーバーレンダリングのアプリ: .NET 11 における MVC、Razor Pages、または Blazor Server。** ブラウザが唯一のクライアントであり、Cookie はブラウザが管理してくれます。そして `HttpOnly` が、注入されたスクリプトの手の届かないところに資格情報を保ちます。JavaScript が漏洩させるトークンが存在しません。
- **自身のバックエンドと通信する同一オリジンのシングルページアプリ。** これは人々が最も間違えやすいケースです。React や Angular のアプリが同じオリジンから配信され、同じオリジンを呼び出すのであれば、JWT を発行して `localStorage` にしまうよりも、Cookie のほうがシンプルかつ安全です。OAuth ワーキンググループのブラウザベースアプリ向けガイダンスは、ファーストパーティの SPA に対し、ブラウザ内のトークンではなく、Cookie に裏打ちされた Backend-for-Frontend を明確に推奨しています。
- **即時失効が必要。** ユーザーの無効化、パスワードのローテーション、グローバルなサインアウトの強制は、今すぐ有効になる必要があります。Cookie であれば、リクエストごとにプリンシパルを再検証する (`OnValidatePrincipal`) か、Data Protection キーを変更すれば、次のリクエストは未認証になります。トークンの有効期限切れを待つ必要はありません。
- **ローカルアカウントで ASP.NET Core Identity を使用している。** Identity のデフォルト UI と `SignInManager` は Cookie ベースであり、それがサポートされたファーストパーティの経路です。

Cookie で受け入れる税は CSRF です。ブラウザがクロスサイトのフォームポストで Cookie を送信するため、状態を変更するエンドポイントにはアンチフォージェリ保護が必要です。`SameSite=Strict` または `Lax` が一般的なケースをブロックし、ASP.NET Core のアンチフォージェリトークンが残りを塞ぎます。デプロイ後にそれらのトークンが検証されなくなった場合、それはたいてい Data Protection のキーリングの問題で、[アンチフォージェリトークンを復号できなかった理由](/ja/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/) で扱っています。

## JWT ベアラーを選ぶべき場面

- **モバイルまたはデスクトップアプリから消費される REST または gRPC API。** ネイティブクライアントには、あなたのドメインに紐づいた Cookie ジャーがなく、トークンを OS のキーチェーンやセキュアストレージに保存できます。それはブラウザよりも安全な置き場所です。ベアラートークンが自然に適合します。
- **サービス間呼び出しとマイクロサービス。** 中央の ID プロバイダーによって署名されたトークンは、セッションストアを一切共有しない十数個のサービスによって独立して検証できます。これは、ステートレス性が負債ではなく機能となるシナリオです。
- **クライアントを制御できないサードパーティの API アクセス。** 公開 API、パートナー連携、そして OAuth 2.0 のクライアントクレデンシャルや認可コードフローによって駆動されるものはすべて、設計上ベアラートークンに基づいています。
- **Cookie がきれいに到達できないクロスドメイン呼び出し。** `app.com` が `api.other.com` を呼び出さなければならない場合、Cookie のスコープがあなたと戦いますが、ベアラートークンはオリジンを気にしません。別のオリジンのブラウザから JWT で保護された API 呼び出しをルーティングする場合、難しいのはたいていトークンではなくプリフライトです。[ASP.NET Core 11 で JWT 保護された API 向けに CORS を構成する方法](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) を参照してください。

JWT で受け入れる税は失効です。漏洩または盗まれたトークンは有効期限が切れるまで有効であるため、標準的な緩和策は、サーバー側で失効させられる寿命の長いリフレッシュトークンと組み合わせた、短命のアクセストークン (5 分から 15 分) です。自身のトークンを発行している場合は、その仕組みを省かないでください。[ASP.NET Core Identity でリフレッシュトークンを実装する方法](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) が、ローテーションと失効の各要素を解説しています。

## なぜ「localStorage の JWT」がブラウザにとって誤ったデフォルトなのか

この比較が重要である理由は、人気の SPA チュートリアルのパターン、つまりログイン時に JWT を発行して `localStorage` に保存するというやり方が、問題ではないものを本物の問題と引き換えにしてしまうからです。同一オリジンの SPA にステートレス性は必要ありません。そのバックエンドはすぐそこにあり、セッションを保持できます。トークンと引き換えに得るのは、XSS で抜き取り可能な資格情報です。あなたのページで実行されるスクリプトは、侵害された npm 依存関係を通じて取り込まれたものを含め、どれもが `localStorage` を読み取り、トークンを持ち去り、有効期限が切れるまでどこからでも再生できます。

`HttpOnly` 付きの Cookie は `document.cookie` からはまったく読み取れないため、`localStorage` のトークンを枯渇させるのと同じ XSS が、Cookie を直接盗むことはできません。それこそが、業界が Backend-for-Frontend パターンへと移行した理由のすべてです。SPA は、セキュアで `HttpOnly`、`SameSite` な Cookie を使って自身のバックエンドに対して認証し、バックエンドはあらゆる上流の OAuth トークンをサーバー側で保持し、JavaScript には決して渡しません。IETF の現行のブラウザベースアプリ向けドラフトはまさにこれを推奨しており、Duende の BFF フレームワークはそれを ASP.NET Core 向けにパッケージ化しています。手短に言えば、トークンがブラウザに属するのは、それを保持してくれるサーバーが存在しない場合だけであり、ファーストパーティのアプリにとってそれは決してありません。

## 1 つのアプリで両方式を動かす

1 つの方式をグローバルに選ぶことは、1 つしか使えないという意味ではありません。よくある現実世界の形は、同じホスト内のサーバーレンダリングサイトと JSON API です。ページには Cookie、API には JWT、という具合です。両方を登録し、エンドポイントごとに選択しましょう。

```csharp
// .NET 11, C# 14
builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie()
    .AddJwtBearer();   // second scheme, not the default

// Pages use the default cookie scheme:
app.MapGet("/dashboard", () => Results.Ok("hello"))
   .RequireAuthorization();

// The API explicitly requires the bearer scheme:
app.MapGet("/api/orders", () => Results.Ok(orders))
   .RequireAuthorization(new AuthorizeAttribute
   {
       AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme
   });
```

重要なポイントは、`AddAuthentication` に最初に渡す方式がデフォルトであり、明示的な方式を持たない `[Authorize]` はすべてそれを使うことです。ベアラートークンを受け入れるべきエンドポイントは、`JwtBearerDefaults.AuthenticationScheme` を明示的に名指ししなければなりません。さもなければ、フレームワークは Cookie を検証しようとし、見つからず、`401` を返す代わりにログインページへのリダイレクトでチャレンジします。そのミスマッチ、つまり API がきれいな `401` の代わりに HTML のログインリダイレクトを返すことは、デフォルト方式の設定ミスの頻出する症状です。API が `401` の代わりに `405` を返す関連バリエーションや、「有効なトークンが依然として拒否される」というより広いクラスの問題は、混在構成を出荷する前に知っておく価値があります。[有効なトークンがあっても ASP.NET Core の JWT が 401 を返す理由](/ja/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/) を参照してください。

## あなたに代わって選んでくれる落とし穴

失効のレイテンシが決定要因です。1 つの問いを立てましょう。ユーザーのアクセスを遮断しなければならないとき、古い資格情報がまだ機能していることをどれだけ許容できますか?

- 答えが「ゼロ、即座に止まらなければならない」(銀行、管理コンソール、侵害されたアカウントや解雇されたアカウントが能動的な脅威となるあらゆるもの) であれば、Cookie が勝ちます。次のリクエストでセッションを無効化できるからです。JWT で同じ振る舞いを得るには、サーバー側の拒否リストを後付けしなければならず、それは JWT を採用して避けようとしたまさにそのステートフルな参照を再導入します。
- 答えが「数分なら問題ない」であれば、リフレッシュトークン付きの短命な JWT は許容でき、サービス間でそれらを魅力的にするステートレス性を保てます。

2 つ目の決定要因はクライアントです。Cookie はブラウザの構造物です。非ブラウザのクライアントが認証しなければならなくなった瞬間、Cookie は自然ではなくなり、ベアラートークンが明らかな運搬手段になります。アプリが両種類の呼び出し元を持つなら、それは引き分けではなく、上で示したように両方式を、それぞれが適合するエンドポイントで動かすべきだという信号です。

## 推奨、再述

唯一のクライアントが、同一オリジンの SPA を含むブラウザであるアプリには、Cookie 認証を使いましょう。`HttpOnly`、`Secure`、`SameSite` を付け、状態を変更するエンドポイントにはアンチフォージェリを付けます。JavaScript が読めない資格情報と、次のリクエストで有効になる失効が得られ、ファーストパーティの Web アプリが実際に必要とするものは何ひとつ手放しません。呼び出し元がモバイルまたはデスクトップアプリ、別のサービス、あるいはサードパーティであり、ステートレス性が真の利点となって、頼れるサーバー側のセッションが存在しない場合には、JWT ベアラーに手を伸ばしましょう。両種類のクライアントが存在する場合は、一方にもう一方の仕事を強いるのではなく、両方式を登録してエンドポイントごとに選択しましょう。この決定は、どちらの技術がよりモダンかという話ではありません。誰が資格情報を保持しているか、そしてそれをどれだけ速く取り上げる必要があるか、という話です。

## 関連記事

- [ASP.NET Core 11 で JWT の発行者、対象者、有効期間を検証する方法](/ja/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [有効なトークンがあっても ASP.NET Core の JWT が 401 を返す理由](/ja/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [ASP.NET Core 11 で JWT 保護された API 向けに CORS を構成する方法](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [ASP.NET Core Identity でリフレッシュトークンを実装する方法](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)
- [ASP.NET Core でアンチフォージェリトークンを復号できなかった理由](/ja/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## 出典

- [Overview of ASP.NET Core authentication (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/?view=aspnetcore-10.0)
- [Use cookie authentication without ASP.NET Core Identity (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/cookie?view=aspnetcore-10.0)
- [Authentication and authorization in minimal APIs / JWT bearer (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication?view=aspnetcore-10.0)
- [Prevent Cross-Site Request Forgery (XSRF/CSRF) attacks (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/anti-request-forgery?view=aspnetcore-10.0)
- [OAuth 2.0 for Browser-Based Apps (IETF draft)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
- [Securing SPAs using the BFF Pattern (Duende Software)](https://duendesoftware.com/blog/20210326-bff)
