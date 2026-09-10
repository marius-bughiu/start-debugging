---
title: "解決策: MSAL の更新後に Blazor WebAssembly で IsAuthenticated が false になり RemoteUserAccount が null になる"
description: "Microsoft.Authentication.WebAssembly.Msal 10.0.8、9.0.16、8.0.27 は msal.js 4 に移行し、その非同期 init が自分自身と競合します。Program.cs で MSAL を一度だけ初期化するか、10.0.7 に固定してください。"
pubDate: 2026-09-10
template: error-page
tags:
  - "errors"
  - "blazor"
  - "blazor-webassembly"
  - "authentication"
  - "msal"
  - "entra-id"
  - "dotnet-10"
  - "aspnet-core"
lang: "ja"
translationOf: "2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade"
translatedBy: "claude"
translationDate: 2026-09-10
---

`Microsoft.Authentication.WebAssembly.Msal` を 10.0.7 から 10.0.8 以降に (あるいは 9.0.15 から 9.0.16、8.0.26 から 8.0.27 に) 上げたときに Blazor WebAssembly アプリのサインインが壊れたのであれば、原因は構成ではありません。これらのリリースでは同梱の msal.js 2.39.0 が 4.30.0 に置き換えられ、パッケージの JavaScript の `init` が同時に 2 回実行されるようになり、互いに干渉する 2 つの MSAL クライアントが作られます。解決策は、最初のコンポーネントが描画される前に MSAL を正確に一度だけ初期化することです。`Program.cs` で `RunAsync()` の前に `GetAuthenticationStateAsync()` を await してください。パッケージを 10.0.7 に固定する方法でも直りますが、あくまで一時しのぎです。2026-09-10 時点で最新リリースは 10.0.12 で、依然として影響を受けます。

## エラーの状況

同じリグレッションが異なる症状として現れ、それぞれに `dotnet/aspnetcore` の issue があります。最初の報告である [dotnet/aspnetcore#66978](https://github.com/dotnet/aspnetcore/issues/66978) では、10.0.7 で動いていたアプリを他に何も変えずに 10.0.8 に更新したところ、`User.Identity.IsAuthenticated` が常に `false` になり、ログインのコールバック中にカスタムの `AccountClaimsPrincipalFactory.CreateUserAsync` に渡される `RemoteUserAccount` が `null` になったと説明されています。コンソールに出るのは承認のログだけです。

```
info: Microsoft.AspNetCore.Authorization.DefaultAuthorizationService[2]
      Authorization failed. These requirements were not met:
      DenyAnonymousAuthorizationRequirement: Requires an authenticated user.
```

その後、報告者は決定的な実験を行いました。10.0.7 の `AuthenticationService.js` を 10.0.8 のアプリにコピーしただけで、他に何も変えずに直ったのです。バグは JavaScript 層にあります。

[dotnet/aspnetcore#68549](https://github.com/dotnet/aspnetcore/issues/68549) は目に見える形の症状です。10.0.10 で、認証済みのページを Firefox で再読み込みすると、`_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js` から例外がスローされて失敗します。

```
uninitialized_public_client_application: You must call and await the initialize function before attempting to call any other MSAL API.
```

Edge では再現しませんでした。[dotnet/aspnetcore#68136](https://github.com/dotnet/aspnetcore/issues/68136) は静かな形の症状です。サインイン自体は成功しますが、`InteractiveRequestOptions.ReturnUrl` が無視され、すべてのユーザーが `/` に着地します。#66978 のコメントでは、10.0.8 から 10.0.10 でサインアウトがハングすることも報告されています。4 つの症状の原因は 1 つです。

## 10.0.8 で何が変わったのか

`Microsoft.Authentication.WebAssembly.Msal` は msal.js を CDN から参照しません。`@azure/msal-browser` を、`index.html` が読み込む静的アセット `AuthenticationService.js` にコンパイルして同梱しています。msal.js 2.x はサポート終了を迎え、Microsoft の component governance スキャンで警告対象になったため、[dotnet/aspnetcore#66055](https://github.com/dotnet/aspnetcore/pull/66055) が .NET 11 preview 4 で `^4.30.0` に移行し、その変更はサポート中のすべてのラインにバックポートされました。10.0 は [#66094](https://github.com/dotnet/aspnetcore/pull/66094)、9.0 は [#66234](https://github.com/dotnet/aspnetcore/pull/66234)、8.0 は [#66236](https://github.com/dotnet/aspnetcore/pull/66236) です。3 つのサービスリリースはいずれも 2026-05-12 に公開されました。milestone を鵜呑みにせず出荷されたファイルを確認したところ、10.0.7 の `AuthenticationService.js` には msal-browser 2.39.0 が、10.0.12 のものには 4.30.0 が含まれていました。

| ライン | msal.js 2 を含む最後のバージョン | msal.js 4 を含む最初のバージョン |
| ---- | --------------------------- | ---------------------------- |
| .NET 8 | 8.0.26 | 8.0.27 |
| .NET 9 | 9.0.15 | 9.0.16 |
| .NET 10 | 10.0.7 | 10.0.8 |
| .NET 11 | 11.0.0-preview.3 | 11.0.0-preview.4 (RC 1 を含む) |

## msal.js の更新でサインインが壊れる理由

msal-browser 3.0 では、ここで重要になる変更が 1 つ入りました。`PublicClientApplication` は、生成した直後にはもう使えません。[v2 から v3 への移行ガイド](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md) にあるとおり、先に `initialize()` を呼び出して完了を待つ必要があります。Blazor のパッケージはその呼び出しを、ごく自然な場所、つまり静的な `init` の途中に追加しました。

```ts
// Microsoft.Authentication.WebAssembly.Msal 10.0.8 through 10.0.12 (msal-browser 4.30.0)
public static async init(settings: AuthorizeServiceConfiguration, jsLoggingOptions: JavaScriptLoggingOptions) {
    if (!AuthenticationService._initialized) {
        AuthenticationService.instance = new MsalAuthorizeService(settings, new Logger(jsLoggingOptions));
        await AuthenticationService.instance.initialize(); // new in 10.0.8
        AuthenticationService.instance.initializeMsalHandler();
        AuthenticationService._initialized = true;
    }
    return Promise.resolve();
}
```

10.0.7 には `await` の行がありませんでした。`_initialized` を読んでから設定するまでの間に中断ポイントがなく、JavaScript は単一のスレッドで動くため、ブロック全体がアトミックでした。2 回目の呼び出しは常に `_initialized === true` を見て何もしませんでした。現在はフラグが `await` の後にしか設定されないため、最初の呼び出しが中断している間に届いた 2 回目の呼び出しもチェックを通過します。

そして 2 回目の呼び出しは実際に届きます。C# 側も何年も前から同じ形をしているからです。これは `Microsoft.AspNetCore.Components.WebAssembly.Authentication` 10.0.x の `RemoteAuthenticationService` です。

```csharp
// Microsoft.AspNetCore.Components.WebAssembly.Authentication 10.0.x
private async ValueTask EnsureAuthService()
{
    if (!_initialized)
    {
        await JsRuntime.InvokeVoidAsync("AuthenticationService.init", Options.ProviderOptions, _loggingOptions);
        _initialized = true;
    }
}
```

`GetAuthenticationStateAsync`、`RequestAccessToken`、`SignInAsync`、`CompleteSignInAsync`、`SignOutAsync`、`CompleteSignOutAsync` のすべてのエントリポイントがこれを呼び出します。最初の JS の `init` が終わる前に 2 つが始まると、両方が `init` を呼び出します。JavaScript がアトミックだった間は無害でした。msal.js 4 では、呼び出しごとに独自の `MsalAuthorizeService` が作られ、それぞれが `initialize()`、続いて `handleRedirectPromise()` を呼び、2 回目の代入が `AuthenticationService.instance` を上書きします。以降、`getUser`、`completeSignIn`、`signOut` といったすべての静的メソッドは、最後に代入されたインスタンスとやり取りします。そのインスタンスはまだ初期化中かもしれませんし、リダイレクト応答の処理競争に負けたほうかもしれません。

これで症状の説明がつきます。`getUser` が、`initialize()` の完了前に 2 つ目のインスタンスに到達すると `uninitialized_public_client_application` がスローされます。これが起きるかどうかは Promise の実行順序に左右されるため、Firefox では発生し Edge では発生しません。Blazor は戻り先の URL を `sessionStorage` に保存し、最初に読み取ったときに削除します。そのため 2 つのインスタンスが同じコールバックを処理すると、片方は状態を得られず、`RemoteAuthenticatorView` は `/` にフォールバックします。これは #68136 でコメント投稿者が示した診断で、`init` が 1 つの共有 Promise を返すようにする修正案も添えられています。さらに、応答を処理しなかったインスタンスに `completeSignIn` が問い合わせると、アカウントは返らず、`CreateUserAsync` は `null` を受け取り、ユーザーは匿名のままになります。

## 最小限の再現

二重初期化は Entra のテナントがなくても簡単に証明できます。.NET SDK 10.0.302 で、ダミーの ID を指定してテンプレートを作成します。

```bash
dotnet new blazorwasm -au SingleOrg --client-id "00001111-aaaa-2222-bbbb-3333cccc4444" --tenant-id "aaaabbbb-0000-cccc-1111-dddd2222eeee" -o MsalRepro
```

3 つのパッケージ参照をすべて 10.0.12 にします。素のテンプレートでは競合状態は起きません。`AuthorizeRouteView` は `RemoteAuthenticatorView` を描画する前に認証状態を待つので、他の何かが問い合わせる時点では最初の `init` が完了しています。実際のアプリがそこまで単純なままであることはまれです。承認のゲートの外側で、起動時に認証に触れるものが 1 つあれば十分です。たとえば、承認済みの `HttpClient` 経由でデータを読み込むレイアウトコンポーネントです。`AuthorizeRouteView` は承認中もレイアウトを描画するため、これは最初の `GetAuthenticationStateAsync` と並行して実行されます。

```razor
@* Layout/NavMenu.razor, .NET 10, Microsoft.Authentication.WebAssembly.Msal 10.0.12 *@
@using Microsoft.AspNetCore.Components.WebAssembly.Authentication
@inject IAccessTokenProvider TokenProvider

@code {
    protected override async Task OnInitializedAsync()
    {
        // Same effect as any startup call through the authorized HttpClient.
        await TokenProvider.RequestAccessToken();
    }
}
```

何が起きているかを数えるには、`AuthenticationService.js` の直後に小さな診断スクリプトを読み込み、`init` をラップして `AuthenticationService.instance` への代入を監視します。

```js
// wwwroot/probe.js, diagnostic only. Load after AuthenticationService.js.
(() => {
  const svc = window.AuthenticationService;
  const probe = window.__probe = { initCalls: 0, instances: 0 };
  let current;
  Object.defineProperty(svc, 'instance', {
    configurable: true,
    get: () => current,
    set: v => { probe.instances++; current = v; }
  });
  const init = svc.init;
  svc.init = function (...args) { probe.initCalls++; return init.apply(svc, args); };
})();
```

Chromium ベースのブラウザーで `/` と `/authentication/login-callback` を開き、起動後に `window.__probe` を読み取りました。どちらのルートでも同じ数値になりました。

| 構成 | `init` の呼び出し回数 | 作成された MSAL インスタンス数 |
| ----- | ------------ | ---------------------- |
| Msal 10.0.12 | 2 | 2 |
| Msal 10.0.7 (msal.js 2.39.0) | 2 | 1 |
| Msal 10.0.12 + `Program.cs` での事前初期化 (解決策 1) | 1 | 1 |
| Msal 10.0.12 + 冪等な `init` シム (解決策 2) | 2 | 1 |

注目すべきは 10.0.7 の行です。C# からの二重呼び出しは以前から存在し、msal.js 2 の同期的な `init` がそれを吸収していました。使い捨ての Entra アプリ登録がなかったため、壊れたビルドで実際のサインインを通すことはできませんでした。そのため、2 つ目のインスタンスと各症状の対応関係は、コードと上記の issue のスレッドから導いたものです。二重インスタンスそのものは実測です。

## 解決策の詳細

### 1. Program.cs で MSAL を一度だけ初期化する

`Build()` の後、`RunAsync()` の前に、認証状態プロバイダーを一度だけ呼び出します。

```csharp
// .NET 10, Microsoft.Authentication.WebAssembly.Msal 10.0.12
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using MsalRepro;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

builder.Services.AddScoped(sp => new HttpClient { BaseAddress = new Uri(builder.HostEnvironment.BaseAddress) });

builder.Services.AddMsalAuthentication(options =>
{
    builder.Configuration.Bind("AzureAd", options.ProviderOptions.Authentication);
});

var host = builder.Build();

// Run AuthenticationService.init to completion before any component can race it.
await host.Services.GetRequiredService<AuthenticationStateProvider>().GetAuthenticationStateAsync();

await host.RunAsync();
```

この時点ではまだコンポーネントが 1 つも存在しないため、この呼び出しと重なるものはありません。`EnsureAuthService` が最後まで実行され、C# 側と JavaScript 側の両方の `_initialized` フラグが設定され、以降の呼び出しはすべて `init` を完全にスキップします。WebAssembly ホストでは `RunAsync` の前でも JavaScript 相互運用が使えます。私の再現では、これで両方のルートとも `init` の呼び出しが 1 回、インスタンスが 1 つになりました。

代償は、最初の描画が MSAL の初期化とキャッシュの読み取りを待つことです。もっとも、これはアプリがどのみち数ミリ秒後に行っていた処理です。`AccountClaimsPrincipalFactory` が `CreateUserAsync` の中で Microsoft Graph や独自の API を呼んでいる場合、その呼び出しも最初の描画より前に移動します。軽く保つか、最初の描画が少し遅れることを受け入れてください。

### 2. または JavaScript で init を冪等にする

起動処理を制御できない場合、たとえば共有のコンポーネントライブラリが自分の管理外でトークン要求を発行する場合は、競合状態が起きている場所、つまり `init` で修正します。このシムは Promise をメモ化します。これは #68136 の修正案がパッケージ内部で行っていることと同じです。

```js
// wwwroot/msal-init-fix.js
// Workaround for dotnet/aspnetcore#66978, #68549, #68136
// (Microsoft.Authentication.WebAssembly.Msal 8.0.27+, 9.0.16+, 10.0.8+).
(() => {
  const svc = window.AuthenticationService;
  if (!svc || svc.__initFixApplied) return;
  const originalInit = svc.init;
  let pending;
  svc.init = function (settings, loggingOptions) {
    pending ??= originalInit.call(svc, settings, loggingOptions)
      .catch(e => { pending = undefined; throw e; });
    return pending;
  };
  svc.__initFixApplied = true;
})();
```

スクリプトの順序が重要です。パッケージのスクリプトが `window.AuthenticationService` を定義した後、Blazor が起動する前に実行する必要があります。

```html
<!-- wwwroot/index.html -->
<script src="_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js"></script>
<script src="msal-init-fix.js"></script>
<script src="_framework/blazor.webassembly#[.{fingerprint}].js"></script>
```

C# は相変わらず `init` を 2 回呼び出しますが、両方の呼び出しが同じ Promise を待機するようになり、作成される `MsalAuthorizeService` は 1 つだけです。`.catch` はキャッシュをリセットするので、初期化に失敗しても永久に失敗し続けることはなく、再試行できます。Blazor は呼び出しのたびに `window` 経由で `AuthenticationService.init` を名前で解決するため、プロパティを置き換えるだけで機能します。

### 3. またはパッケージを 10.0.7 に固定する

```xml
<!-- .NET 10: last Msal release that bundles msal.js 2.39.0 -->
<PackageReference Include="Microsoft.Authentication.WebAssembly.Msal" Version="10.0.7" />
```

対応するバージョンは 9.0.15 と 8.0.26 です。`Microsoft.AspNetCore.Components.WebAssembly` は 10.0.12 のままで構いません。この組み合わせはビルドでき、アプリは 2.39.0 のバンドルを配信します。なお、固定すると `Microsoft.AspNetCore.Components.WebAssembly.Authentication` も推移的な依存関係として 10.0.7 に引き下げられます。代償はサポートの終了した msal.js を出荷することで、これはまさに Microsoft が更新した理由です。あくまでつなぎとして扱ってください。ブラウザーが実際に何を受け取っているかを確認します。

```bash
curl -s http://localhost:5117/_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js | grep -oE '"(2\.39\.0|4\.30\.0)"'
```

バージョンを変更したら、テストに使うブラウザーのサイトデータを消去してください。MSAL のキャッシュと、Blazor が `sessionStorage` に保存する状態はアプリの更新後も残ります。[Microsoft Learn のトラブルシューティングのセクション](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id#cookies-and-site-data) でも、まさにこの種のテストについて注意喚起されています。

## 落とし穴と似たエラー

**`CacheLocation = "localStorage"` で、ブラウザーを閉じるとユーザーがサインアウトされる。** これは msal.js 4 の設計どおりの動作で、競合状態ではありません。v4 以降、MSAL は `localStorage` のキャッシュを AES-GCM で暗号化し、鍵を `msal.cache.encryption` という名前のセッション cookie に保存します (10.0.12 のバンドルに含まれています)。[v3 から v4 への移行ガイド](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md) によると、この鍵はブラウザーを閉じると削除されるため、`localStorage` はブラウザーのセッションをまたいで保持されなくなります。上記のどの解決策もこれを変えません。ブラウザーの再起動後は、サイレントまたは対話型のサインインが発生する前提で設計してください。

**プライベート IP のホストでだけサイレントサインインが失敗する。** アプリが `192.168.x.x` や `10.x.x.x` で動いていて、Chrome 142 以降が非表示の iframe を `LocalNetworkAccessPermissionDenied` でブロックする場合は、Chrome の Local Network Access 制限によるもので、[dotnet/aspnetcore#64699](https://github.com/dotnet/aspnetcore/issues/64699) で追跡されています。これはどのパッケージバージョンでも発生します。

**`AddOidcAuthentication` を使うアプリはこの変更の影響を受けません。** msal.js の置き換えで変更されたのは、Msal パッケージの相互運用スクリプトだけです。汎用の OIDC プロバイダーや、サーバー側で認証する Blazor Web App を使っている場合は、原因は別のところにあります。

**修正が出荷されても、回避策は害になりません。** 3 つの issue はいずれも 10.0.x の milestone で開いたままで、2026-09-10 時点で修正はマージされていません。`Program.cs` の呼び出しは、修正後も何のコストもかかりません。シムは何もしないラッパーになるので、`AuthenticationService.init` がブール値の代わりに Promise を保持するようになったら削除できます。

壊れたアプリではなく新しいアプリなら、先に [.NET 11 における Blazor Server vs WebAssembly vs United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) を読んでおく価値があります。サーバー側の認証なら、ブラウザーにトークンを置くこと自体を避けられます。

## 関連記事

- [.NET 11 における Blazor Server vs Blazor WebAssembly vs Blazor United](/ja/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [ASP.NET Core 11 における JWT 認証と cookie 認証の比較](/ja/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)。WebAssembly クライアントの API 側について。
- [Blazor のレンダーモードとは何か、どのモードがコンポーネントを実行するのか](/ja/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [.NET 11 RC 1 の SignalR は接続を切らずに期限切れ間近のトークンを差し替える](/ja/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/)

## 出典

- [dotnet/aspnetcore#66978、10.0.8 への更新後の MSAL 認証の問題](https://github.com/dotnet/aspnetcore/issues/66978)
- [dotnet/aspnetcore#68549、10.0.10 で Firefox を再読み込みした後の `uninitialized_public_client_application`](https://github.com/dotnet/aspnetcore/issues/68549)
- [dotnet/aspnetcore#68136、10.0.10 で `RemoteAuthenticatorView` が `ReturnUrl` を無視する](https://github.com/dotnet/aspnetcore/issues/68136)
- [dotnet/aspnetcore#66055、`@azure/msal-browser` を 4.x に更新](https://github.com/dotnet/aspnetcore/pull/66055)、およびそのバックポート [#66094](https://github.com/dotnet/aspnetcore/pull/66094)、[#66234](https://github.com/dotnet/aspnetcore/pull/66234)、[#66236](https://github.com/dotnet/aspnetcore/pull/66236)
- [`release/10.0` の `AuthenticationService.ts`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/Authentication.Msal/src/Interop/AuthenticationService.ts)
- [`release/10.0` の `RemoteAuthenticationService.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/WebAssembly.Authentication/src/Services/RemoteAuthenticationService.cs)
- [Microsoft Entra ID を使用して ASP.NET Core Blazor WebAssembly スタンドアロン アプリをセキュリティで保護する](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id)
- [msal-browser の v2 から v3 への移行ガイド](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md) と [v3 から v4 への移行ガイド](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md)
- [NuGet の Microsoft.Authentication.WebAssembly.Msal](https://www.nuget.org/packages/Microsoft.Authentication.WebAssembly.Msal)
