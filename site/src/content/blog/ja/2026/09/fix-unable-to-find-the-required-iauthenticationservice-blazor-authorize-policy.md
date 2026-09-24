---
title: "修正: Blazor の [Authorize(Policy = ...)] で Unable to find the required 'IAuthenticationService' service が発生する"
description: "Blazor Web App で [Authorize] が付いたページは AuthorizationMiddleware がチェックするエンドポイントになり、チェックに失敗すると ChallengeAsync が呼ばれますが、これには AddAuthentication が必要です。実際の認証スキームを登録するか、コンポーネントのエンドポイントを AuthorizeRouteView まで通過させます。"
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-10"
  - "authorization"
lang: "ja"
translationOf: "2026/09/fix-unable-to-find-the-required-iauthenticationservice-blazor-authorize-policy"
translatedBy: "claude"
translationDate: 2026-09-24
---

`@attribute [Authorize(Policy = "...")]` を付けた Blazor ページで `Unable to find the required 'IAuthenticationService' service` が出る場合、ASP.NET Core の `AuthorizationMiddleware` が HTTP リクエストに対してポリシーを評価し、チェックに失敗し、認証サービスが登録されていない状態で `HttpContext.ChallengeAsync()` を呼び出そうとしたことを意味します。本当の修正は、チャレンジの行き先ができるように、スキーム (通常は Cookie) 付きで `builder.Services.AddAuthentication(...)` を呼ぶことです。アプリがカスタムの `AuthenticationStateProvider` だけで認証している場合は、Razor コンポーネントのエンドポイントを通過させる `IAuthorizationMiddlewareResultHandler` を登録し、ポリシーの適用は `AuthorizeRouteView` に任せます。

以下の内容はすべて、標準の `dotnet new blazor -int Server` テンプレートを使い、.NET 10.0.10 (SDK 10.0.302) と .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) で再現しました。どちらのランタイムでも、すべてのシナリオで同じ結果になりました。

## エラーが発生する状況

保護されたページへの最初のリクエストで、ブラウザーは 500 を受け取ります。ログを見ると、チャレンジは Blazor ではなく認可ミドルウェアから来ています。

```text
fail: Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddleware[1]
      An unhandled exception has occurred while executing the request.
      System.InvalidOperationException: Unable to find the required 'IAuthenticationService' service. Please add all the required services by calling 'IServiceCollection.AddAuthentication' in the application startup code.
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.GetAuthenticationService(HttpContext context)
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.ChallengeAsync(HttpContext context)
         at Microsoft.AspNetCore.Authorization.Policy.AuthorizationMiddlewareResultHandler.<>c__DisplayClass0_0.<<HandleAsync>g__Handle|0>d.MoveNext()
      --- End of stack trace from previous location ---
         at Microsoft.AspNetCore.Authorization.AuthorizationMiddleware.Invoke(HttpContext context)
         at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
```

多くの人を Stack Overflow や [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678) に向かわせる典型的なパターンは、アプリ内からそのページに移動すると動くのに、リロードしたり、ブックマークから開いたり、セッションの最初のページとして開いたりするとクラッシュする、というものです。

## なぜ発生するのか

ASP.NET Core の 3 つの仕組みが重なって、この例外が発生します。

1. **ルーティング可能なコンポーネントは HTTP エンドポイントです。** .NET 8 以降、`MapRazorComponents<App>()` は `@page` ごとに 1 つのエンドポイントを作成します。`RazorComponentEndpointFactory` はコンポーネント型に付いているすべての属性を、`[Authorize]` も含めてエンドポイントのメタデータにコピーします (ソース内のコメント "All attributes defined for the type are included as metadata" を参照してください)。
2. **`UseAuthorization()` は自動的に追加されます。** `WebApplicationBuilder` は `IAuthorizationHandlerProvider` が登録されていれば認可ミドルウェアを自動で挿入し、`AddAuthorizationCore()` がそれを登録します。影響を受けるのに `app.UseAuthorization()` を呼ぶ必要はありません。私の再現コードでは一度も呼んでいません。
3. **ポリシーの失敗はチャレンジに変換されます。** 既定の `AuthorizationMiddlewareResultHandler` は、匿名ユーザーには `context.ChallengeAsync()` を、認証済みだがポリシーを満たさないユーザーには `context.ForbidAsync()` を呼びます。どちらも `IAuthenticationService` が必要で、これを登録するのは `AddAuthentication()` だけです。

つまり、ミドルウェアはポリシーを `HttpContext.User` に対して実行します。この経路ではカスタムの `AuthenticationStateProvider` はまったく参照されません。そのため、次の点に多くの人が驚きます。**プロバイダーがサインイン済みとみなしているユーザーでもエラーが発生します**。私の再現コードでは、`Admin` ロールを持つプリンシパルを返すプロバイダーでも `/admin` で 500 になりました。`HttpContext.User` が匿名だったからです。

対話型サーキット内でのクライアント側ナビゲーションは HTTP リクエストを発行しないため、ミドルウェアはそれを見ることがありません。そこでは代わりに `AuthorizeRouteView` が `AuthenticationStateProvider` を使って `[Authorize]` を評価します。「リンクをクリックすると動くのに F5 でクラッシュする」の説明はこれですべてです。

.NET 7 の Blazor Server では `_Host.cshtml` が唯一のエンドポイントで、コンポーネントが個別にマップされることはなかったため、これは問題なく動いていました。多くの人がこのエラーに出会うのは、まさに [Blazor Web App への移行](/ja/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) のタイミングです。

## 最小限の再現コード

外部 API に対して認証し、その結果をカスタムの `AuthenticationStateProvider` を通じてのみ公開する Blazor Web App で、ASP.NET Core の認証スキームはありません。

```csharp
// .NET 10.0.10 / .NET 11 RC 1, Program.cs
using System.Security.Claims;
using AuthRepro.Components;
using Microsoft.AspNetCore.Components.Authorization;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorComponents().AddInteractiveServerComponents();
builder.Services.AddCascadingAuthenticationState();
builder.Services.AddScoped<AuthenticationStateProvider, ApiTokenAuthStateProvider>();
builder.Services.AddAuthorizationCore(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));

var app = builder.Build();
app.UseAntiforgery();
app.MapStaticAssets();
app.MapRazorComponents<App>().AddInteractiveServerRenderMode();
app.Run();

class ApiTokenAuthStateProvider : AuthenticationStateProvider
{
    public override Task<AuthenticationState> GetAuthenticationStateAsync() =>
        Task.FromResult(new AuthenticationState(new ClaimsPrincipal(new ClaimsIdentity())));
}
```

```razor
@* .NET 10 / 11, Components/Pages/Admin.razor *@
@page "/admin"
@attribute [Authorize(Policy = "Admins")]
<h1>Admin area</h1>
```

`Routes.razor` は `<NotAuthorized>` ブロック付きの `<AuthorizeRouteView>` を使っています。実行中のアプリに curl でアクセスすると、次のようになります。

| リクエスト | 結果 |
| --- | --- |
| `GET /` | 200 |
| `GET /admin` | 500、`IAuthenticationService` の例外 |
| `GET /admin`、プロバイダーが Admin を返す | 500、同じ例外 |

## 修正 1: 実際の認証スキームを登録する (推奨)

ユーザーがアプリに何らかの形でサインインするのであれば、HTTP リクエスト上でユーザーが誰なのかを把握できるスキームを ASP.NET Core に与えます。サーバーレンダリングの Blazor アプリでは、ほぼ常に Cookie です。

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authentication.Cookies;

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.LoginPath = "/login";
        o.AccessDeniedPath = "/access-denied";
    });

builder.Services.AddAuthorization(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));
```

これを入れると、匿名ユーザーでの `GET /admin` は例外を投げる代わりに `/login?ReturnUrl=%2Fadmin` への `302` を返します。サインイン済みでもロールを持たないユーザーは `AccessDeniedPath` に送られます。

単にエラーを黙らせるのではなく正しく動かすために、次の 2 つの対応が必要です。

- **Cookie でサインインします。** ログインフローが外部 API を呼んでトークンを受け取る場合は、静的 SSR ページかミニマル API のエンドポイントから、必要なクレーム (ロール、ユーザー ID) を付けて `HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal)` を呼んでフローを完了させます。後続の呼び出しで API トークンが必要なら、Cookie の `AuthenticationProperties` に保存できます。
- **カスタムの `AuthenticationStateProvider` がその処理を重複して行っていただけなら削除します。** Blazor 組み込みの `ServerAuthenticationStateProvider` はプリレンダリング中に `HttpContext.User` を読み取ってサーキットに引き継ぐため、ページ、`AuthorizeView`、ミドルウェアのすべてがユーザーについて同じ認識を持ちます。

Cookie とトークンのどちらがアプリに合うか迷う場合は、[ASP.NET Core における JWT と Cookie 認証の比較](/ja/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) でトレードオフを説明しています。自身の UI を提供する Blazor Web App なら、ほぼ常に Cookie が有利です。

知っておくべき細かな点として、.NET 7 以降、スキームが 1 つだけ登録されている場合はそれが自動的に既定になります。既定スキームの引数なしの `AddAuthentication().AddCookie()` も私の再現コードで動作し、Cookie ハンドラーの既定である `/Account/Login` にリダイレクトされました。2 つ目のスキーム (OpenID Connect、JWT bearer) を追加したら、既定を明示的に指定してください。そうしないと、このエラーが `No authenticationScheme was specified, and there was no DefaultChallengeScheme found` に置き換わるだけです。

## 修正 2: コンポーネントのエンドポイントを AuthorizeRouteView まで通過させる

本当に HTTP レベルの ID を持たないアプリもあります。Blazor Server アプリが別の Web API を呼び、トークンをサーキットの状態に保持し、ユーザーをカスタムの `AuthenticationStateProvider` を通じてのみ公開するケースです。そこに Cookie スキームを追加するとログインフローを作り直すことになります。代替手段は、ドキュメント化された [`IAuthorizationMiddlewareResultHandler`](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse) の拡張ポイントを使って、ポリシーが失敗したときの認可ミドルウェアの動作を変えることです。

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Components.Endpoints;

builder.Services.AddSingleton<IAuthorizationMiddlewareResultHandler,
    BlazorAuthorizationMiddlewareResultHandler>();

sealed class BlazorAuthorizationMiddlewareResultHandler : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public Task HandleAsync(RequestDelegate next, HttpContext context,
        AuthorizationPolicy policy, PolicyAuthorizationResult authorizeResult)
    {
        // Razor component pages: let the request through. AuthorizeRouteView
        // re-checks [Authorize] against the AuthenticationStateProvider.
        if (context.GetEndpoint()?.Metadata.GetMetadata<ComponentTypeMetadata>() is not null)
            return next(context);

        return _default.HandleAsync(next, context, policy, authorizeResult);
    }
}
```

`ComponentTypeMetadata` (public で、`Microsoft.AspNetCore.Components.Endpoints` にあります) は `MapRazorComponents` が作成するすべてのエンドポイントに付与されるため、この通過処理はページにのみ適用されます。それ以外はすべて既定の動作のままです。

このハンドラーを使い、`AddAuthentication()` を呼ばない状態で計測した結果です。

| リクエスト | プロバイダーのユーザー | 結果 |
| --- | --- | --- |
| `GET /admin` | 匿名 | 200、`<NotAuthorized>` の内容がレンダリングされる |
| `GET /admin` | `Admin` ロールあり | 200、ページがレンダリングされる |
| `GET /api/secret` (`RequireAuthorization("Admins")`) | どちらでも | 500、`IAuthenticationService` の例外 |

この修正で何を引き受けることになるのかを理解しておいてください。

- **ページを保護するのはミドルウェアではなく `AuthorizeRouteView` です。** プリレンダリング中もサーキット内でも、ページの代わりに `<NotAuthorized>` をレンダリングします。`Routes.razor` では `AuthorizeRouteView` を使う必要があり (通常の `RouteView` は `[Authorize]` を無視します)、匿名ユーザーに表示されるのは `<NotAuthorized>` の内容なので、そこにログインリンクを置いてください。
- **レスポンスは 401 や 302 ではなく 200 です。** クローラーや死活監視ツールには成功したページに見えます。リダイレクトが必要なら、`<NotAuthorized>` ブロックから `NavigationManager.NavigateTo("/login")` で行うか、修正 1 を使ってください。
- **コンポーネント以外のエンドポイントには引き続き修正 1 が必要です。** 表の最終行は意図的なものです。ポリシーで保護されたミニマル API やコントローラーには、頼れる `AuthorizeRouteView` がありません。そうしたエンドポイントがあるなら、いずれにせよ実際のスキームが必要です。

チャレンジで何もしない no-op の認証ハンドラーを登録してこれを「修正」してはいけません。ミドルウェアはチャレンジ後に処理を打ち切るため、ユーザーには説明のない空の 200 ページが返り、例外よりも悪い結果になります。

## 修正 3: チェックをコンポーネント内に移す

ページの一部だけを制限したいのであれば、属性は適切な手段ではありません。`@attribute [Authorize(...)]` を削除し、保護したいマークアップを囲みます。

```razor
@* .NET 10 / 11 *@
@page "/admin"

<AuthorizeView Policy="Admins">
    <Authorized><h1>Admin area</h1></Authorized>
    <NotAuthorized><p>You need the Admin role.</p></NotAuthorized>
</AuthorizeView>
```

エンドポイントのメタデータも、ミドルウェアのチェックも、例外もありません。同じ再現コード (`AddAuthentication()` はまだなし) で、このページは匿名ユーザーには `<NotAuthorized>` の内容を、Admin には管理者用のマークアップを付けて 200 を返しました。これは、最初のページの `<AuthorizeView>` は一度も失敗しなかったという #55678 の報告者の観察と一致します。UI の出し分けには問題ありませんが、サーバー側でレンダリングされるものはチェックを通過したユーザーに送られることを忘れないでください。コンポーネント内のデータアクセスでも、マークアップだけでなく認可をチェックする必要があります。

## 注意点と似たエラー

**`FallbackPolicy` はホームページを含むすべてのページを壊します。** `AddAuthorization(o => o.FallbackPolicy = ...RequireAuthenticatedUser()...)` は、独自の認可メタデータを持たないすべてのエンドポイントに適用されます。私の再現コードでは、`GET /` が 200 から同じ例外による 500 に変わりました。`_Host.cshtml` と `MapBlazorHub()` を使い続けている従来の Blazor Server アプリは、コンポーネントが個別のエンドポイントではないため、この経路 (または `MapBlazorHub().RequireAuthorization()` 経由) でエラーに遭遇します。

**`AddAuthorizationCore()` と `AddAuthorization()` の違いは原因ではありません。** どちらも、`WebApplicationBuilder` に `UseAuthorization()` を挿入させるハンドラープロバイダーを登録します。どちらに切り替えてもここでは何も変わりません。

**スタンドアロンの Blazor WebAssembly ではこのエラーは発生しません。** クライアント側には ASP.NET Core のパイプラインがありません。WebAssembly アプリがサインイン後もユーザーを匿名とみなしている場合は別の問題で、[MSAL のアップグレード後に IsAuthenticated が false になる](/ja/2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade/) で扱っています。

**レンダーモードは関係ありません。** 失敗するリクエストは、対話性が始まる前にページを返す最初の HTTP GET です。静的 SSR、Interactive Server、WebAssembly、Auto のどのページでも同じ動作になります。レンダーモードがまだ曖昧に感じるなら、[どのレンダーモードがコンポーネントを実行するのか](/ja/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/) でそれぞれがどこで実行されるかを説明しています。

**`AuthenticationStateProvider` のユーザーは `HttpContext.User` には届きません。** 流れは逆方向にしか進みません。`ServerAuthenticationStateProvider` が `HttpContext` から読み取るだけです。コンポーネントのレンダリング前に実行されるもの (ミドルウェア、エンドポイントフィルター、ユーザー単位でパーティション分割されたレート制限) は、認証ハンドラーがそこに設定したものしか見えません。

## 関連記事

- [.NET 11 で Blazor Server アプリを Blazor Web App に移行する](/ja/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/)。このエラーが表面化するきっかけとなることが多い移行です。
- [ASP.NET Core 11 における JWT と Cookie 認証の比較](/ja/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)。修正 1 でスキームを選ぶ際に役立ちます。
- [Blazor のレンダーモードとは何か、どれがコンポーネントを実行するのか](/ja/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [修正: Blazor のプリレンダリング中に JavaScript interop calls cannot be issued at this time が発生する](/ja/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/)。こちらも最初の HTTP リクエストでのみ発生するエラーです。

## 出典

- [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678) "Exception triggered by AuthorizeAttribute on the first page loaded in a circuit"、および .NET 8 の Blazor Web App で認証なしに `AddAuthorizationCore` を使う件についての [#53732](https://github.com/dotnet/aspnetcore/issues/53732)。
- `v10.0.0` タグ時点の [`RazorComponentEndpointFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/RazorComponentEndpointFactory.cs) と [`ComponentTypeMetadata.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/ComponentTypeMetadata.cs)。
- [`WebApplicationBuilder.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/DefaultBuilder/src/WebApplicationBuilder.cs) (`UseAuthentication` / `UseAuthorization` の自動追加) と [`AuthorizationMiddlewareResultHandler.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authorization/Policy/src/AuthorizationMiddlewareResultHandler.cs)。
- Microsoft Learn の [AuthorizationMiddleware の動作をカスタマイズする](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse) と [ASP.NET Core Blazor の認証と承認](https://learn.microsoft.com/aspnet/core/blazor/security/)。
- ASP.NET Core 7.0 の新機能にある [認証で単一のスキームが DefaultScheme として使用される](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-7.0#authentication-uses-single-scheme-as-defaultscheme)。
