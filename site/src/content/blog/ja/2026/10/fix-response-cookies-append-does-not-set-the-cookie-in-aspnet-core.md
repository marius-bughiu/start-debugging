---
title: "修正: ASP.NET Core で Response.Cookies.Append を呼んでもブラウザーに Cookie が設定されない"
description: "Set-Cookie ヘッダーは送信されているのに、ブラウザーが拒否するか保存しません。Secure なしの SameSite=None、credentials: 'include' と AllowCredentials の欠落、同意ポリシー、遅すぎる Append 呼び出しを修正します。"
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "cookies"
  - "cors"
lang: "ja"
translationOf: "2026/10/fix-response-cookies-append-does-not-set-the-cookie-in-aspnet-core"
translatedBy: "claude"
translationDate: 2026-10-28
---

結論から言うと、`Response.Cookies.Append` がサーバー側で失敗することはほとんどありません。このメソッドは `Set-Cookie` ヘッダーを書き込むだけで、その後ブラウザーが黙って保存を拒否しているのです。原因を可能性の高い順に挙げると、リクエストがクロスオリジンでクライアントが `credentials: 'include'` を送っていない (またはサーバーが `AllowCredentials()` を呼んでいない)、Cookie が `Secure` なしで `SameSite=None` になっている、`CookiePolicy` の同意チェックが `IsEssential` の付いていない Cookie を抑止した、`Append` がレスポンス開始後に実行された、のいずれかです。ブラウザーの DevTools で Network タブを開き、該当するレスポンスを選択して Cookies サブタブを確認してください。Chromium はどのルールでブロックしたかを正確に表示します。

以下の内容はすべて .NET 10 と ASP.NET Core 10 を対象としています (動作は .NET 11 のプレビューでも同一で、ASP.NET Core 3.1 以降変わっていません)。ブラウザーの動作は 2026 年 10 月時点の Chrome、Firefox、Safari の最新リリースに基づきます。

```text
// Roughly what Chrome DevTools shows under Network > (response) > Cookies
Set-Cookie: session=abc123; path=/; samesite=none
  ⚠ This attempt to set a cookie via a Set-Cookie header was blocked because it had the
    "SameSite=None" attribute but did not have the "Secure" attribute, which is required
    in order to use "SameSite=None".
```

また、`Microsoft.AspNetCore.Http.ResponseCookies` のロガーが `Warning` レベルで有効になっている場合、ASP.NET Core のログには次のように出力されます。

```text
warn: Microsoft.AspNetCore.Http.ResponseCookies
      The cookie 'session' has set 'SameSite=None' and must also set 'Secure'.
```

## Cookie が document.cookie にも次のリクエストにも届かない理由

`Response.Cookies.Append` は薄いラッパーです。ASP.NET Core のソース (`src/Http/Http/src/Internal/ResponseCookies.cs`) では、次の 3 つのことしか行いません。`SameSite` が `None` で `Secure` が `false` なら上記の警告をログに出力し、値を `Uri.EscapeDataString` で URL エンコードし、新しい `Set-Cookie` ヘッダーをレスポンスに追加します。それだけです。ドメインの検証も CORS のチェックもせず、Cookie が拒否される場合でも例外をスローしません。実際の失敗はすべてその後、ブラウザーの内部で起こります。ブラウザーは各 `Set-Cookie` ヘッダーに一連のルールを適用します。

1. **CORS の資格情報モード。** クロスオリジンの `fetch` や `XMLHttpRequest` では、リクエストが資格情報モード (`credentials: 'include'` / `withCredentials = true`) で送信され、かつレスポンスに `Access-Control-Allow-Credentials: true` と明示的な (`*` ではない) `Access-Control-Allow-Origin` が含まれていない限り、ブラウザーは `Set-Cookie` を完全に無視します。
2. **SameSite。** `Secure` のない `SameSite=None` の Cookie は、現行のすべてのブラウザーで拒否されます。クロスサイトのレスポンスで設定された `Lax` または `Strict` の Cookie は、サードパーティ Cookie として拒否されます。
3. **Secure。** プレーンな `http://` 経由で設定された `Secure` Cookie は拒否されますが、例外が 1 つあります。Chrome (89 以降) と Firefox (75 以降) は、この目的に関して `http://localhost` を安全なものとして扱います。Safari は扱いません。
4. **Domain と Path。** レスポンスのホストとドメインが一致しない `Domain` 属性は拒否されます。後でリクエストする URL をカバーしない `Path` の場合、Cookie は保存されても送り返されないため、"設定されていない" のとまったく同じに見えます。
5. **サイズ。** 1 つの Cookie (名前と値の合計) が 4096 バイトを超えると破棄されます。

ブラウザーのルールに加えて、ASP.NET Core 自体にも、Cookie が送信される前に消えてしまう場所が 2 つあります。`CookiePolicyMiddleware` の同意チェックと、"レスポンスがすでに開始されている" という境界です。

## 最小の再現: React の開発サーバーから ASP.NET Core API を呼び出す

Stack Overflow にある "Cookie が設定されない" という質問の大半は、この構成が背景にあります。SPA があるポートで動き、API が別のポートで動いている構成です。

```csharp
// .NET 10, ASP.NET Core 10 - Program.cs (broken)
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173")
     .AllowAnyHeader()
     .AllowAnyMethod()));

var app = builder.Build();
app.UseCors();

app.MapPost("/login", (HttpContext ctx) =>
{
    ctx.Response.Cookies.Append("session", "abc123", new CookieOptions
    {
        HttpOnly = true,
        SameSite = SameSiteMode.None
    });
    return Results.Ok();
});

app.MapGet("/me", (HttpContext ctx) =>
    ctx.Request.Cookies.TryGetValue("session", out var s)
        ? Results.Ok(s)
        : Results.Unauthorized());

app.Run();
```

```javascript
// Vite dev server on http://localhost:5173
await fetch("https://localhost:7001/login", { method: "POST" });
const me = await fetch("https://localhost:7001/me");
console.log(me.status); // 401
```

ここでは 3 つの別々のバグが重なっています。`fetch` の呼び出しはデフォルトの `credentials: 'same-origin'` を使っているため、ブラウザーはクロスオリジンのレスポンスからの `Set-Cookie` を破棄し、`/me` にも Cookie を付けません。CORS ポリシーに `AllowCredentials()` がありません。そして Cookie は `Secure` なしの `SameSite=None` です。どれか 1 つだけ直しても同じ 401 が返り続けるため、この問題はとても気まぐれに感じられるのです。

## 修正 1: 資格情報を送信し、CORS ポリシーで許可する

クロスオリジンの呼び出しでは、両側がオプトインする必要があります。クライアント側では次のようにします。

```javascript
// Browser, any framework
await fetch("https://localhost:7001/login", {
  method: "POST",
  credentials: "include"
});

// axios equivalent
axios.post("https://localhost:7001/login", null, { withCredentials: true });
```

サーバー側では、正確なオリジンを列挙して `AllowCredentials()` を呼び出します。

```csharp
// .NET 10, ASP.NET Core 10
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173", "https://app.example.com")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));
```

`AllowAnyOrigin()` と `AllowCredentials()` を組み合わせることはできません。CORS の仕様は資格情報付きのレスポンスで `Access-Control-Allow-Origin: *` を禁止しており、ASP.NET Core はポリシーの構築時に `InvalidOperationException: The CORS protocol does not allow specifying a wildcard (any) origin and credentials at the same time.` をスローしてこれを強制します。動的なオリジンが必要な場合は、実際のチェックを伴う `SetIsOriginAllowed(origin => ...)` を使ってください。`_ => true` は絶対に使わないでください。資格情報を有効にしたまま任意のオリジンを反映するのは、典型的な CSRF の穴だからです。プリフライトのキャッシュを含むポリシー設定の全体は、[ASP.NET Core 11 で JWT で保護された API の CORS を構成する](/ja/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) で解説しています。

ミドルウェアの順序も重要です。`app.UseCors()` は Cookie を追加するエンドポイントより前に、また `UseAuthentication()` / `UseAuthorization()` より前に実行する必要があります。

## 修正 2: SameSite=None には Secure を組み合わせるか、SameSite=None を避ける

`CookieOptions.SameSite` のデフォルトは `SameSiteMode.Unspecified` です。この場合 ASP.NET Core は `SameSite` 属性を出力せず、ブラウザーが独自のデフォルトを適用します。Chromium は属性がない場合を `Lax` として扱います。このデフォルトはほぼすべての同一サイトのアプリにとって正しく、`None` を使うべきなのは、Cookie が本当にクロスサイトのリクエストで送られる必要がある場合 (別サイトに埋め込まれた iframe、サードパーティのウィジェット、`form_post` を使う ID プロバイダーのコールバック) だけです。

`None` が必要な場合、`Secure` は必須です。

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("session", token, new CookieOptions
{
    HttpOnly = true,
    Secure = true,                  // required with SameSite=None
    SameSite = SameSiteMode.None,
    Path = "/",
    MaxAge = TimeSpan.FromHours(8)
});
```

ここでつまずく人が多い区別があります。**SameSite はサイトに関するもので、CORS はオリジンに関するものです。** サイトとはスキームと登録可能ドメインの組み合わせで、ポートは無視されます。したがって `http://localhost:5173` から `http://localhost:5001` を呼び出すのはクロスオリジン (CORS が適用され、修正 1 が必要) ですが、同一サイト (`Lax` の Cookie は機能します) です。`app.example.com` から `api.example.com` を呼び出すのも同一サイトです。こうした構成では `SameSite=None` はまったく不要です。`Lax` のままにして、資格情報だけを修正してください。

ただし、スキームは考慮されます。Chrome は Chrome 89 以降 "schemeful same-site" を採用しているため、`http://localhost:5173` から `https://localhost:7001` を呼び出すのはクロスサイトとなり、HTTPS の API が設定した `Lax` の Cookie は HTTP のページからのリクエストでは送信されません。両方の開発サーバーを同じスキームで動かす (Vite の `basicSsl` プラグインと `dotnet dev-certs https` のどちらでも可能です) か、API を開発サーバーのプロキシの背後に置いて、ブラウザーが常に 1 つのオリジンとだけ通信するようにしてください。プロキシを使う方法は本番環境の同一オリジンのデプロイを再現するため、最も堅牢です。

真にクロスサイトな Cookie (SPA が `myapp.com`、API が `myapi.net` にある場合) はサードパーティ Cookie です。2025 年 4 月に Google が廃止計画を撤回して以降、Chrome ではデフォルトで有効なままですが、Safari は完全にブロックし、Firefox は Total Cookie Protection によってパーティション化します。これに依存した設計はしないでください。API を同じ登録可能ドメインの下に移すか、Backend-for-Frontend に切り替えてブラウザーがファーストパーティ Cookie を保持するようにしてください。どうしてもクロスサイトで埋め込む必要がある場合は、パーティション化された Cookie (CHIPS) を検討してください。ASP.NET Core 10 の `CookieOptions` には `Partitioned` プロパティがありませんが、`Extensions` を使えば属性を自分で追加できます。

```csharp
// .NET 10, ASP.NET Core 10 - CHIPS partitioned cookie for a cross-site iframe
var options = new CookieOptions
{
    Secure = true,
    SameSite = SameSiteMode.None,
    HttpOnly = true
};
options.Extensions.Add("Partitioned");
ctx.Response.Cookies.Append("widget-state", value, options);
```

## 修正 3: Cookie を IsEssential にするか、同意の要求をやめる

アプリが `CheckConsentNeeded` が `true` を返す状態で `app.UseCookiePolicy()` を呼び出している場合、`CookiePolicyMiddleware` はレスポンスの Cookie コレクションをラップし、ユーザーが同意 Cookie を受け入れるまで、必須とマークされていないすべての Cookie を黙って破棄します。デフォルトのレベルでは何もログに出力されず、`Append` の呼び出しは成功したように見えます。ASP.NET Core 2.1 から 2.2 のテンプレートではこれが有効な状態で提供されていたため、段階的にアップグレードされてきた古いプロジェクトには今も残っていることがよくあります。

```csharp
// .NET 10, ASP.NET Core 10 - the configuration that eats cookies
builder.Services.Configure<CookiePolicyOptions>(o =>
{
    o.CheckConsentNeeded = _ => true;
    o.MinimumSameSitePolicy = SameSiteMode.Lax;
});
// ...
app.UseCookiePolicy();
```

その Cookie がアプリの動作に必須であれば `IsEssential = true` を設定します (プライバシーポリシーでもそのことを正直に記載してください)。必須でなければ、同意を待つのが正しい動作です。

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("cart", cartId, new CookieOptions
{
    IsEssential = true,
    HttpOnly = true,
    Secure = true
});
```

同意の状態は `ctx.Features.Get<ITrackingConsentFeature>()` で明示的に確認できます。その `CanTrack` プロパティが、必須でない Cookie が書き込まれるかどうかを示します。同じオプションの `MinimumSameSitePolicy` は、Cookie の `SameSite` を渡した値より厳しいものに書き換えることもあります。設定したものと異なる `SameSite` で Cookie が現れた場合は、ここを確認してください。

## 修正 4: レスポンスの開始前に追加する

レスポンスヘッダーは、本文の最初のバイトがフラッシュされた瞬間に送信されます。それ以降に `Response.Cookies.Append` を呼ぶと `InvalidOperationException: Headers are read-only, response has already started.` がスローされます。これが起こる典型的な場所は、`await next()` の後で Cookie を追加するミドルウェア、`Response.Body` に書き込んでから Cookie を設定するエンドポイント、ストリーミングレスポンスや SSE のループ内のコードです。

```csharp
// .NET 10, ASP.NET Core 10 - broken: the endpoint already wrote the body
app.Use(async (ctx, next) =>
{
    await next();
    ctx.Response.Cookies.Append("last-seen", DateTimeOffset.UtcNow.ToString("O"));
});

// fixed: register a callback that runs just before headers are flushed
app.Use(async (ctx, next) =>
{
    ctx.Response.OnStarting(() =>
    {
        ctx.Response.Cookies.Append("last-seen", DateTimeOffset.UtcNow.ToString("O"));
        return Task.CompletedTask;
    });
    await next();
});
```

例外がどこかで握りつぶされている場合 (例外フィルターや fire-and-forget のタスクなど)、目に見える症状は Cookie がないことだけです。これが疑われるときは、ブレークポイントで `ctx.Response.HasStarted` を確認してください。

## "Cookie が設定されていない" ように見える落とし穴

**Cookie は設定されているが、JavaScript から見えない。** `HttpOnly = true` は設計上、Cookie を `document.cookie` から隠します。代わりに DevTools の Application タブを確認してください。[ASP.NET Core 11 における JWT 認証と Cookie 認証の比較](/ja/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) で解説しているとおり、セッショントークンにはこの動作が望ましいものです。

**Cookie は保存されているが、送り返されない。** `CookieOptions` は `Path` のデフォルトを `/` にしており、これは問題ありません。しかし `Path = "/api/auth"` を設定すると、ブラウザーはそのパス以下の URL にしか Cookie を付けません。開発ホストと一致しない親ドメインを `Domain` に設定した場合も同様です。サブドメイン間で共有する必要がない限り、`Domain` は未設定のままにしてください。ホスト限定の Cookie のほうが厳格で安全です。

**値が壊れて見える。** `Append` は値を `Uri.EscapeDataString` に通すため、`a b=c` は `document.cookie` では `a%20b%3Dc` として届きます。サーバー側では `Request.Cookies` がデコードしてくれますが、JavaScript で読み取る場合は `decodeURIComponent` が必要です。

**Safari で本番環境では動くが localhost では動かない。** Safari は `http://localhost` 経由の `Secure` Cookie を拒否しますが、Chrome と Firefox は受け入れます。`dotnet dev-certs https --trust` を使って開発サーバーを HTTPS で動かしてください。

**Blazor のインタラクティブコンポーネント。** Blazor Server やインタラクティブレンダーモードでは、最初の HTTP レスポンスが終わった後、コンポーネントは SignalR の回線上で動作します。そのため追加先となるレスポンスが存在せず、`HttpContext` は null または古いものになっています。Cookie は Razor Page、クライアントが呼び出す minimal API のエンドポイント、または静的 SSR のフォーム送信から設定してください。[静的 SSR における `[SupplyParameterFromSession]`](/ja/2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5/) の設計も、同じ制約に基づいています。

**Cookie が大きすぎる。** ブラウザーは名前と値の合計が 4096 バイトを超える Cookie を破棄します。ASP.NET Core の Cookie 認証ハンドラーは、`ChunkingCookieManager` を通じて大きなチケットを `.AspNetCore.Cookies`、`C1`、`C2` に自動的に分割しますが、素の `Response.Cookies.Append` はそうしません。多数のクレームを持つ JWT を Cookie に詰め込んでいる場合は、クレームを削るか、トークンをサーバー側に保持して Cookie には短いハンドルだけを入れてください。リフレッシュトークンのフローはこの問題のよくある原因です。Cookie を小さく保つ構成については [ASP.NET Core Identity でリフレッシュトークンを実装する](/ja/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) を参照してください。

**デプロイ後に antiforgery Cookie が消える** のは、症状は同じでも別の問題です。Cookie は設定されていますが、次のインスタンスで復号できません。これについては ["The antiforgery token could not be decrypted" の修正](/ja/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/) で解説しています。

## 1 分以内に原因を突き止めるチェックリスト

Cookie が保持されないときは、次の項目を順に確認してください。各ステップでバグが見つかるか、カテゴリー全体を除外できます。

1. DevTools を開き、Network タブで Cookie を設定するはずのレスポンスを選択し、`Set-Cookie` ヘッダーがあることを確認します。ない場合、問題はサーバー側にあります。同意ポリシー、レスポンス開始後の例外、またはそのコードパスが一度も実行されていない、のいずれかです。
2. ヘッダーがある場合は、そのリクエストの Cookies サブタブを開きます。Chromium はブロックされた Cookie に警告アイコンと正確な理由 (SameSite、Secure、Domain、またはサードパーティのブロック) を表示します。
3. 呼び出しがクロスオリジンの場合は、リクエストに `credentials: 'include'` があること、レスポンスに `Access-Control-Allow-Credentials: true` と具体的な `Access-Control-Allow-Origin` があることを確認します。
4. Cookie は保存されているのに次のリクエストに含まれない場合は、その `Path`、`Domain`、`SameSite`、`Secure` を、次のリクエストの URL とスキームと比較します。
5. Chrome では動作して Safari で失敗する場合、原因は `http://localhost` 経由の `Secure` か、サードパーティ Cookie のどちらかです。

サーバーのコードがバグであることはまれです。`Append` は "これを保存することを検討してください" というお願いだと捉え、ブラウザーの返答をデバッグしてください。

## 参考資料

- [dotnet/aspnetcore の ResponseCookies.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http/src/Internal/ResponseCookies.cs) (`SameSite=None` の警告と値のエンコード)
- [MS Learn の CookieOptions クラス](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.cookieoptions)
- [ASP.NET Core で CORS を有効にする: クロスオリジンリクエストにおける資格情報](https://learn.microsoft.com/en-us/aspnet/core/security/cors#credentials-in-cross-origin-requests)
- [ASP.NET Core での EU 一般データ保護規則 (GDPR) のサポート](https://learn.microsoft.com/en-us/aspnet/core/security/gdpr)
- [ASP.NET Core で SameSite Cookie を使用する](https://learn.microsoft.com/en-us/aspnet/core/security/samesite)
- [MDN: Set-Cookie](https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie)
- [dotnet/aspnetcore#55370: Partitioned Cookie のサポートを追加](https://github.com/dotnet/aspnetcore/issues/55370)
