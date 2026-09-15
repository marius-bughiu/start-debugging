---
title: "修正: .NET 10 へのアップグレード後、ASP.NET Core の API エンドポイントがログインページへリダイレクトせず 401 を返す"
description: ".NET 10 の Cookie 認証は、API 形のエンドポイントに対してログインへのリダイレクトではなく 401/403 を返します。エンドポイント単位、アプリ全体、または AppContext スイッチで元の動作に戻す方法を解説します。"
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "authentication"
  - "cookies"
  - "csharp"
lang: "ja"
translationOf: "2026/09/fix-aspnetcore-api-endpoints-return-401-instead-of-redirecting-to-login-dotnet-10"
translatedBy: "claude"
translationDate: 2026-09-15
---

ASP.NET Core 10 では、Cookie 認証の背後にある「API 形」のエンドポイントへの未認証リクエストは、`LoginPath` への `302` ではなく `401` (禁止されたリクエストは `403`) を受け取ります。対象は `[ApiController]` コントローラー、JSON を読み書きする Minimal API、`TypedResults` を返すもの、そして SignalR です。この変更は意図的なものです。ブラウザーが実際にそのようなエンドポイントへ遷移する場合は、そのエンドポイントに `.AllowCookieRedirect()` (または `[AllowCookieRedirect]`) を追加します。.NET 9 の動作をアプリ全体で取り戻すには、`OnRedirectToLogin`/`OnRedirectToAccessDenied` をオーバーライドするか、`Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata` AppContext スイッチを設定します。以下の内容はすべて ASP.NET Core 10.0.10 (SDK 10.0.302) で、9.0.20 と比較して計測したものです。

## エラーの状況

アップグレード後、例外は発生せず、ログにも何も出ません。ただログインページが表示されなくなります。以前は `/login` へ転送されていたリクエストが、今は次のように返ってきます。

```text
HTTP/1.1 401 Unauthorized
Content-Length: 0
Server: Kestrel
Location: http://localhost:5103/login?ReturnUrl=%2Fm%2Fdto
```

`Location` ヘッダーがまだ残っている点に注目してください。Cookie ハンドラーはログイン URL を以前とまったく同じように計算してレスポンスに書き込みますが、ステータスを `302` ではなく `401` に設定するため、ブラウザーも `HttpClient` もそれをたどりません。サインイン済みでも認可ポリシーを満たさないユーザーも同じ扱いを受けます。`AccessDeniedPath` へのリダイレクトではなく、`Location: /denied?ReturnUrl=...` 付きの `403 Forbidden` が返ります。

典型的な症状は次のとおりです。

- いくつかの Minimal API エンドポイントを持つ Razor Pages または MVC アプリで、そのうちの 1 つをブラウザーのタブで開くと、ログインフォームではなく空白ページ (またはブラウザー独自の 401 ページ) が表示されます。
- 以前は `302` をたどってログイン HTML にたどり着き、`res.redirected` でそれを検出していたフロントエンドの `fetch` が、今は `401` を受け取り、別のコードパスで例外を投げます。
- ログインへのリダイレクトをアサートしていた統合テスト (`AllowAutoRedirect = false` での `302`、またはデフォルトクライアントでの `/Account/Login` という最終 URL) が、上に挙げたエンドポイントに限って失敗し、残りは引き続き成功します。

## .NET 10 がこれらのエンドポイントでリダイレクトをやめた理由

これは破壊的変更 [Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints) であり、.NET 10 Preview 7 で導入され、10.0.0 (2025 年 11 月) から一般提供されています。これは 2019 年にさかのぼる要望 ([dotnet/aspnetcore#9039, "ApiController redirects to login page"](https://github.com/dotnet/aspnetcore/issues/9039)) に応えるものです。HTML のログインページは JSON クライアントにとって役に立ちません。

仕組みはエンドポイントのメタデータです。`CookieAuthenticationEvents` のデフォルトの `OnRedirectToLogin` デリゲートは、現在次のようになっています。

```csharp
// ASP.NET Core 10.0.0, src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs (abridged)
public Func<RedirectContext<CookieAuthenticationOptions>, Task> OnRedirectToLogin { get; set; } = context =>
{
    if (IsAjaxRequest(context.Request) || IsCookieRedirectDisabledByMetadata(context.HttpContext))
    {
        context.Response.Headers.Location = context.RedirectUri;
        context.Response.StatusCode = 401;
    }
    else
    {
        context.Response.Redirect(context.RedirectUri);
    }
    return Task.CompletedTask;
};

private static bool IsCookieRedirectDisabledByMetadata(HttpContext context)
{
    if (_ignoreCookieRedirectMetadata) // AppContext switch, read once
    {
        return false;
    }
    var endpoint = context.GetEndpoint();
    return endpoint?.Metadata.GetMetadata<IDisableCookieRedirectMetadata>() is not null &&
        endpoint?.Metadata.GetMetadata<IAllowCookieRedirectMetadata>() is null;
}
```

`IsAjaxRequest` の分岐 (`X-Requested-With: XMLHttpRequest` ヘッダー) は何年も前から存在します。新しいのは `IDisableCookieRedirectMetadata` で、フレームワークは次の箇所で自動的にこれを付与します。

- `ApiControllerAttribute` が `IDisableCookieRedirectMetadata` を実装するようになったため、`[ApiController]` コントローラーのすべてのアクションがこれを持ちます。
- `RequestDelegateFactory` (および Native AOT で使われる Request Delegate Generator) は、Minimal API ハンドラーが JSON ボディのパラメーターを持つ場合、または戻り値の型が JSON としてシリアル化される場合にこれを追加します。
- API 向けの `TypedResults` 型 (`Ok`、`Ok<T>`、`Created`、`Accepted`、`NotFound<T>`、`BadRequest`、`Conflict`、`ValidationProblem`、`ProblemHttpResult`、`JsonHttpResult<T>`、`ServerSentEventsResult<T>` など) は、`PopulateMetadata` からこれを追加します。
- `MapHub` と `MapConnectionHandler` は SignalR 用にこれを追加します。

この件を検索するときに多くの人がつまずく細かい点があります。Microsoft Learn のページでは、マーカーインターフェースの名前がいまだに `IApiEndpointMetadata` になっています。これは Preview 7 での名前でした。API レビューにより GA 前に [dotnet/aspnetcore#63283](https://github.com/dotnet/aspnetcore/pull/63283) で名前が変更され、同じ PR でオプトアウト用の `IAllowCookieRedirectMetadata`、`AllowCookieRedirect`/`DisableCookieRedirect` 拡張メソッド、そして AppContext スイッチも追加されました。リリース済みの .NET 10 アプリには `IApiEndpointMetadata` は存在しません。型は `Microsoft.AspNetCore.Http.Metadata` にある `IDisableCookieRedirectMetadata` と `IAllowCookieRedirectMetadata` です。

## 最小限の再現コード

ファイルベースのアプリを 1 つ用意し、.NET 9.0.20 ランタイムと 10.0.10 でそれぞれ 1 回ずつ実行します。

```csharp
// .NET 10, ASP.NET Core 10.0.10, run with: dotnet run probe.cs
#:sdk Microsoft.NET.Sdk.Web

using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o => { o.LoginPath = "/login"; o.AccessDeniedPath = "/denied"; });
builder.Services.AddAuthorization();
builder.Services.AddControllers();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

var m = app.MapGroup("/m").RequireAuthorization();
m.MapGet("/string", () => "plain text");                          // text/plain
m.MapGet("/dto", () => new Todo(1, "json"));                       // JSON response
m.MapGet("/typed", () => TypedResults.Ok(new Todo(1, "typed")));   // TypedResults
m.MapGet("/iresult", () => Results.Ok(new Todo(1, "iresult")));    // returns IResult
m.MapPost("/body", (Todo t) => "got body");                        // JSON request body
app.MapControllers();
app.Run();

public record Todo(int Id, string Title);

[ApiController, Route("c/api"), Authorize]
public class ApiCtl : ControllerBase { [HttpGet] public Todo Get() => new(1, "api"); }

[Route("c/mvc"), Authorize]
public class MvcCtl : Controller { [HttpGet] public Todo Get() => new(1, "mvc"); }
```

以下は Cookie なしで `curl -D -` を実行した結果です。最初の 2 列は同じコードから得たもので、3 列目は `IgnoreRedirectMetadata` を `true` に設定した 10.0.10 の結果です。

| エンドポイント | 9.0.20 | 10.0.10 | 10.0.10 + スイッチ |
| --- | --- | --- | --- |
| `GET /m/string` (`string` を返す) | 302 | 302 | 302 |
| `GET /m/dto` (record を返す) | 302 | **401** | 302 |
| `Task<Todo>` を返す `GET` 非同期ハンドラー | 302 | **401** | 302 |
| `GET /m/typed` (`TypedResults.Ok`) | 302 | **401** | 302 |
| `Results<Ok<Todo>, NotFound>` | 302 | **401** | 302 |
| `TypedResults.Json(...)` | 302 | **401** | 302 |
| `GET /m/iresult` (`Results.Ok`、`IResult` として宣言) | 302 | 302 | 302 |
| `TypedResults.Text`、`TypedResults.File`、`TypedResults.Redirect` | 302 | 302 | 302 |
| `POST /m/body` (JSON ボディ) | 302 | **401** | 302 |
| `[ApiController]` のアクション | 302 | **401** | 302 |
| 通常の `Controller` のアクション (`[ApiController]` なし) | 302 | 302 | 302 |
| `X-Requested-With: XMLHttpRequest` 付きの任意のエンドポイント | 401 | 401 | 401 |
| サインイン済み、`RequireRole` を満たさない、JSON エンドポイント | `/denied` への 302 | **403** | `/denied` への 302 |
| サインイン済み、`RequireRole` を満たさない、`string` エンドポイント | `/denied` への 302 | `/denied` への 302 | `/denied` への 302 |

つまり、判断基準はアーキテクチャ的な意味での「API」ではありません。重要なのはエンドポイントに付いているメタデータです。`Results.Ok(...)` はリダイレクトを続け、`TypedResults.Ok(...)` はリダイレクトしません。`IResult` がメタデータの推論から具体的な型を隠してしまうためです。この 2 つのファクトリーの違いは [typed results vs IResult vs IActionResult](/ja/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/) で解説しています。

## 修正方法の詳細

エンドポイントの実際の性質に合う最初の選択肢を選んでください。

### 1. エンドポイントがコードから呼ばれる場合: 401 のままにしてクライアントを修正する

呼び出し元が `fetch`、`HttpClient`、またはモバイルアプリであれば、新しい動作のほうが正しく、以前の HTML ページへの `302` は回避策を講じていたバグでした。リダイレクトを嗅ぎ分けるのではなく、ステータスコードを処理してください。

```javascript
// Browser fetch against an ASP.NET Core 10 cookie-authenticated API
const res = await fetch("/api/todos", { credentials: "same-origin" });
if (res.status === 401) {
  // Cookie missing or expired: send the user to the login page ourselves
  location.href = "/login?ReturnUrl=" + encodeURIComponent(location.pathname);
} else if (res.status === 403) {
  location.href = "/denied";
} else {
  const todos = await res.json();
}
```

ついでに `res.redirected` や `res.url.includes("/login")` のチェックも削除しましょう。.NET 10 では、これらのエンドポイントに対してはデッドコードになります。SPA と API が異なるオリジンで動いている場合、資格情報と CORS の話は別のトピックで、[JWT vs cookie authentication in ASP.NET Core](/ja/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) で扱っています。

### 2. ブラウザーがエンドポイントへ遷移する場合: `AllowCookieRedirect` で再びオプトインする

ユーザーが実際にタブで開く少数のエンドポイント (JSON を返すエクスポートリンク、管理ページの「view raw」リンク、古い MVC ビューが直接リンクしている `[ApiController]` のアクションなど) については、エンドポイント単位でリダイレクトを復元します。

```csharp
// .NET 10, ASP.NET Core 10.0.10
app.MapGet("/export/orders", (OrderService s) => s.GetAll())
   .RequireAuthorization()
   .AllowCookieRedirect();

[ApiController, Route("api/reports"), Authorize]
public class ReportsController : ControllerBase
{
    [HttpGet("download"), AllowCookieRedirect]
    public ReportDto Download() => new(/* ... */);
}
```

`IAllowCookieRedirectMetadata` は順序に関係なく `IDisableCookieRedirectMetadata` より優先されるため、グループに対しても機能します (`app.MapGroup("/export").AllowCookieRedirect()`)。検証では、`.AllowCookieRedirect()` を付けた `/m/dto` は `302` に戻り、`[AllowCookieRedirect]` を付けた `[ApiController]` のアクションも同様でした。逆方向も用意されています。`.DisableCookieRedirect()` を使うと、`string` を返すエンドポイントでも `401` を返すようになります。ログインページを決して表示すべきでないヘルスチェックや診断用のエンドポイントに便利です。

### 3. 混在したアプリ: 実際のブラウザー遷移だけをリダイレクトする

両方の種類のエンドポイントが多数ある場合は、エンドポイント単位ではなくリクエスト単位で判断するほうがすっきりします。現在の主要ブラウザー (Chrome、Edge、Firefox、Safari 16.4+) はすべて、トップレベルの遷移では [`Sec-Fetch-Mode: navigate`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-Fetch-Mode) を、`fetch` では `cors`/`same-origin` を送信します。

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.LoginPath = "/login";
        options.AccessDeniedPath = "/denied";

        options.Events.OnRedirectToLogin = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    });

// ... app.Run();

static bool IsBrowserNavigation(HttpRequest request)
{
    var mode = request.Headers["Sec-Fetch-Mode"].ToString();
    if (mode.Length > 0)
        return mode == "navigate";

    // Clients without Fetch Metadata headers: fall back to the Accept header
    return HttpMethods.IsGet(request.Method)
        && request.Headers.Accept.ToString().Contains("text/html");
}
```

10.0.10 で `OnRedirectToLogin` 側を計測した結果、`Sec-Fetch-Mode: navigate` 付きの `/m/dto` は `302` を、`Sec-Fetch-Mode: cors` 付きの `/m/string` は `401` を受け取り、素の `curl` (Fetch Metadata なし、`Accept: */*`) はフレームワークならリダイレクトしていたものも含め、すべてのエンドポイントで `401` を受け取りました。これはデフォルトのデリゲートを置き換えるため、エンドポイントのメタデータはまったく参照されなくなります。判断するのはエンドポイントではなくリクエストです。

### 4. 以前とまったく同じように常にリダイレクトする

これは破壊的変更のページに載っているスニペットです。アプリがサーバーレンダリングのサイトで、ブラウザー以外から呼ばれるエンドポイントが 1 つもない場合に使います。

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
    });
```

これは .NET 9 ではリダイレクトされなかった XHR もリダイレクトする点に注意してください。.NET 9 とまったく同じセマンティクス (`X-Requested-With: XMLHttpRequest` には `401`、それ以外はすべてリダイレクト) が必要なら、選択肢 5 のスイッチが 1 行で実現します。

### 5. AppContext スイッチ: イベントを書かずに .NET 9 の動作に戻す

このスイッチは Microsoft Learn のページには載っていませんが、10.0.0 で (PR #63283 から) 出荷されており、.NET 9 のセマンティクスに戻る最も影響の小さい方法です。プロジェクトファイルで設定します。

```xml
<!-- .NET 10, in the web project's .csproj -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata"
                                  Value="true" />
</ItemGroup>
```

または `Program.cs` の 1 行目に書きます。

```csharp
// .NET 10, must run before the cookie handler is first used
AppContext.SetSwitch("Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata", true);
```

`RuntimeHostConfigurationOption` の項目は、`bin/.../<app>.runtimeconfig.json` 内の `configProperties` エントリになります。そのエントリと `SetSwitch` 呼び出しの両方をテストしたところ、どちらも上の「10.0.10 + スイッチ」列の結果になりました。すべてのエンドポイントが再びリダイレクトし、XHR は引き続き `401` を受け取ります。これは移行のための一時しのぎであり、最終的な到達点ではないと考えてください。このスイッチはアプリ全体でメタデータを無効にし、SignalR ハブのマーカーも無効になります。そのため、未認証の negotiate リクエストは .NET 10 より前のルールに戻り、`X-Requested-With: XMLHttpRequest` ヘッダーがある場合にしか HTML ページへのリダイレクトを避けられません。

## 注意点と似た症状

**すでにカスタムの `OnRedirectToLogin` を持っていた場合。** その場合は何も変わっておらず、同僚のアプリがなぜ違う動作をするのか不思議に思うかもしれません。メタデータのチェックは *デフォルトの* デリゲートの中にあります。`OnRedirectToLogin` を置き換えたアプリや、`CookieAuthenticationEvents` を継承して `RedirectToLogin` をオーバーライドしたアプリは、このチェックを完全に迂回します。逆もまた然りです。新しい動作 *と* カスタムイベント (たとえばログイン失敗をログに記録するため) の両方が必要な場合は、自分のロジックを呼び出してから、`IDisableCookieRedirectMetadata` のチェックを自分で再現してください。

**スイッチは 1 回しか読み込まれません。** `_ignoreCookieRedirectMetadata` は `CookieAuthenticationEvents` の `static readonly` フィールドです。最初のリクエストの後にスイッチを設定したり、ホストの起動後にテスト内で切り替えたりしても効果はありません。

**このメタデータを見るのは Cookie ハンドラーだけです。** aspnetcore リポジトリで `IDisableCookieRedirectMetadata` を使っているのは `CookieAuthenticationEvents` だけです。`DefaultChallengeScheme` が OpenID Connect (Microsoft.Identity.Web、Entra ID、Auth0) の場合、チャレンジを発行するのは OIDC ハンドラーであり、すべてのエンドポイントで引き続き ID プロバイダーへリダイレクトします。そこで `401` が返る場合は、そのエンドポイントで Cookie スキームがチャレンジスキームになっています。通常は明示的な `[Authorize(AuthenticationSchemes = ...)]` やポリシーが原因です。

**統合テスト。** `WebApplicationFactory` のクライアントはデフォルトでリダイレクトをたどるため、「未認証リクエストはログインページにたどり着く」とアサートしていたテストは、API エンドポイントに対して `401` を受け取るようになります。テストを通すためだけに `AllowCookieRedirect` を追加するのではなく、アサーションを更新してください。セットアップのパターンは [integration tests with WebApplicationFactory](/ja/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/) にあります。

**Native AOT でも同じ動作です。** Request Delegate Generator はファイルローカルな `DisableCookieRedirectMetadata` クラスを生成し、リフレクションベースのファクトリーと同じ JSON の条件でそれを追加するため、AOT ビルドと JIT ビルドの動作は一致します。

**.NET 11 でも維持されます。** 同じ `IsCookieRedirectDisabledByMetadata` のチェックが `main` にもあるため、.NET 8 や 9 から 11 へ直接移行する場合は、[.NET 8 から .NET 11 への移行チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/) にある他の認証関連の変更と並べて、この項目もリストに加えてください。

**この問題ではないもの: Bearer トークンでの 401、または 405。** エンドポイントが JWT Bearer を使っていて、`WWW-Authenticate: Bearer` ヘッダー付きの `401` が返る場合は、トークン自体が拒否されています。[有効なトークンでも ASP.NET Core の JWT が 401 を返す理由](/ja/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/) を参照してください。`Allow` ヘッダー付きの `405` が返る場合は、認証が実行される前にルーティングが HTTP メソッドを拒否しています。[JWT Bearer で 401 ではなく 405 Method Not Allowed が返る](/ja/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/) を参照してください。.NET 10 の Cookie の変更は、常に `Location` ヘッダー付きで `WWW-Authenticate` ヘッダーなしの `401`/`403` を返します。

## 関連記事

- [JWT vs cookie authentication in ASP.NET Core](/ja/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)
- [Typed results vs IResult vs IActionResult](/ja/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [WebApplicationFactory で統合テストを書く方法](/ja/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [修正: JWT Bearer で 401 ではなく 405 Method Not Allowed が返る](/ja/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/)
- [.NET 8 から .NET 11 への移行: 完全チェックリスト](/ja/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## 出典

- [Breaking change: Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints) (Microsoft Learn) と、[aspnet/Announcements#525](https://github.com/aspnet/Announcements/issues/525) のアナウンス。
- [dotnet/aspnetcore#62816: Avoid cookie login redirects for known API endpoints](https://github.com/dotnet/aspnetcore/pull/62816)、元になった変更。
- [dotnet/aspnetcore#63283: Address API review feedback for what was IApiEndpointMetadata](https://github.com/dotnet/aspnetcore/pull/63283)、名前の変更、`AllowCookieRedirect`、および `IgnoreRedirectMetadata` スイッチ。
- [v10.0.0 時点の `CookieAuthenticationEvents.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs) と [v10.0.12 時点の `RequestDelegateFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.12/src/Http/Http.Extensions/src/RequestDelegateFactory.cs)。
- [dotnet/aspnetcore#9039: ApiController redirects to login page](https://github.com/dotnet/aspnetcore/issues/9039)、この変更の背景にある 2019 年の要望。
