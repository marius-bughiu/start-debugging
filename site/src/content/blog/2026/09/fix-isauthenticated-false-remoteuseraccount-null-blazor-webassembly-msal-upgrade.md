---
title: "Fix: IsAuthenticated is false and RemoteUserAccount is null in Blazor WebAssembly after an MSAL upgrade"
description: "Microsoft.Authentication.WebAssembly.Msal 10.0.8, 9.0.16 and 8.0.27 moved to msal.js 4, whose async init races itself. Initialize MSAL once in Program.cs, or pin 10.0.7."
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
---

If sign-in in a Blazor WebAssembly app broke when you moved `Microsoft.Authentication.WebAssembly.Msal` from 10.0.7 to 10.0.8 or later (or from 9.0.15 to 9.0.16, or 8.0.26 to 8.0.27), you are not looking at a configuration problem. Those releases replaced the bundled msal.js 2.39.0 with 4.30.0, and the package's JavaScript `init` can now run twice at the same time, creating two MSAL clients that step on each other. The fix is to make MSAL initialize exactly once before the first component renders: await `GetAuthenticationStateAsync()` in `Program.cs` before `RunAsync()`. Pinning the package to 10.0.7 also works, but only as a stopgap. As of 2026-09-10, 10.0.12 is the latest release and it is still affected.

## The error in context

The same regression reaches people through different symptoms, and each one has its own issue in `dotnet/aspnetcore`. The original report, [dotnet/aspnetcore#66978](https://github.com/dotnet/aspnetcore/issues/66978), describes a working 10.0.7 app where, after the upgrade to 10.0.8 with no other change, `User.Identity.IsAuthenticated` is always `false` and the `RemoteUserAccount` passed to a custom `AccountClaimsPrincipalFactory.CreateUserAsync` during the login callback is `null`. The only thing in the console is the authorization log:

```
info: Microsoft.AspNetCore.Authorization.DefaultAuthorizationService[2]
      Authorization failed. These requirements were not met:
      DenyAnonymousAuthorizationRequirement: Requires an authenticated user.
```

The reporter then did the decisive experiment: copying the 10.0.7 `AuthenticationService.js` into the 10.0.8 app fixed it with no other change. The bug lives in the JavaScript layer.

[dotnet/aspnetcore#68549](https://github.com/dotnet/aspnetcore/issues/68549) shows the loud variant. On 10.0.10, refreshing an authenticated page in Firefox fails with an exception thrown from `_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js`:

```
uninitialized_public_client_application: You must call and await the initialize function before attempting to call any other MSAL API.
```

Edge did not reproduce it. [dotnet/aspnetcore#68136](https://github.com/dotnet/aspnetcore/issues/68136) is the quiet variant: sign-in succeeds, but `InteractiveRequestOptions.ReturnUrl` is ignored and every user lands on `/`. Comments on #66978 add sign-out hanging on 10.0.8 through 10.0.10. All four symptoms share one cause.

## What changed in 10.0.8

`Microsoft.Authentication.WebAssembly.Msal` does not reference msal.js from a CDN. It compiles `@azure/msal-browser` into the `AuthenticationService.js` static asset that your `index.html` loads. msal.js 2.x reached end of life and was flagged by Microsoft's component governance scanning, so [dotnet/aspnetcore#66055](https://github.com/dotnet/aspnetcore/pull/66055) moved it to `^4.30.0` for .NET 11 preview 4 and it was backported to every supported line: [#66094](https://github.com/dotnet/aspnetcore/pull/66094) for 10.0, [#66234](https://github.com/dotnet/aspnetcore/pull/66234) for 9.0 and [#66236](https://github.com/dotnet/aspnetcore/pull/66236) for 8.0. All three servicing releases shipped on 2026-05-12. I checked the shipped files instead of trusting the milestones: the 10.0.7 `AuthenticationService.js` embeds msal-browser 2.39.0, the 10.0.12 one embeds 4.30.0.

| Line | Last version with msal.js 2 | First version with msal.js 4 |
| ---- | --------------------------- | ---------------------------- |
| .NET 8 | 8.0.26 | 8.0.27 |
| .NET 9 | 9.0.15 | 9.0.16 |
| .NET 10 | 10.0.7 | 10.0.8 |
| .NET 11 | 11.0.0-preview.3 | 11.0.0-preview.4 (RC 1 included) |

## Why the msal.js upgrade breaks sign-in

msal-browser 3.0 made one change that matters here: a `PublicClientApplication` is no longer usable after construction. You have to call and await `initialize()` first, per the [v2 to v3 migration guide](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md). The Blazor package added that call in the obvious place, in the middle of its static `init`:

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

In 10.0.7 the `await` line did not exist. Between reading `_initialized` and setting it there was no suspension point, and because JavaScript runs on one thread, the whole block was atomic. A second call always saw `_initialized === true` and did nothing. Now the flag is set only after an `await`, so a second call that arrives while the first is suspended passes the check too.

A second call does arrive, because the C# side has the same shape and has had it for years. This is `RemoteAuthenticationService` in `Microsoft.AspNetCore.Components.WebAssembly.Authentication` 10.0.x:

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

Every entry point calls it: `GetAuthenticationStateAsync`, `RequestAccessToken`, `SignInAsync`, `CompleteSignInAsync`, `SignOutAsync` and `CompleteSignOutAsync`. If two of them start before the first JS `init` finishes, both invoke it. That was harmless while the JS was atomic. With msal.js 4 each call builds its own `MsalAuthorizeService`, each one calls `initialize()` and then `handleRedirectPromise()`, and the second assignment overwrites `AuthenticationService.instance`. From then on every static method, `getUser`, `completeSignIn` and `signOut`, talks to whichever instance was assigned last. That instance may still be initializing, or it may be the one that lost the race to process the redirect response.

That explains the symptoms. `getUser` hitting the second instance before its `initialize()` resolves throws `uninitialized_public_client_application`, and whether that happens depends on promise timing, which is why Firefox shows it and Edge does not. The return URL is stored by Blazor in `sessionStorage` and deleted on first read, so when two instances handle one callback, one of them gets no state and `RemoteAuthenticatorView` falls back to `/`, which is the diagnosis a commenter posted on #68136 along with a draft fix that makes `init` return a single shared promise. And when `completeSignIn` asks the instance that did not process the response, no account comes back, `CreateUserAsync` receives `null`, and the user stays anonymous.

## Minimal repro

The double initialization is easy to prove without an Entra tenant. Create the template with placeholder IDs, on .NET SDK 10.0.302:

```bash
dotnet new blazorwasm -au SingleOrg --client-id "00001111-aaaa-2222-bbbb-3333cccc4444" --tenant-id "aaaabbbb-0000-cccc-1111-dddd2222eeee" -o MsalRepro
```

Set all three package references to 10.0.12. The bare template does not race: `AuthorizeRouteView` waits for the authentication state before it renders `RemoteAuthenticatorView`, so the first `init` has finished by the time anything else asks. Real apps rarely stay that simple. Anything outside the authorization gate that touches authentication at startup is enough, for example a layout component that loads data through the authorized `HttpClient`. `AuthorizeRouteView` renders the layout while it is still authorizing, so this runs concurrently with the first `GetAuthenticationStateAsync`:

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

To count what happens, load a small diagnostic script right after `AuthenticationService.js` that wraps `init` and watches assignments to `AuthenticationService.instance`:

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

I loaded `/` and `/authentication/login-callback` in a Chromium-based browser and read `window.__probe` after startup. Both routes gave the same numbers:

| Setup | `init` calls | MSAL instances created |
| ----- | ------------ | ---------------------- |
| Msal 10.0.12 | 2 | 2 |
| Msal 10.0.7 (msal.js 2.39.0) | 2 | 1 |
| Msal 10.0.12 + `Program.cs` pre-init (fix 1) | 1 | 1 |
| Msal 10.0.12 + idempotent `init` shim (fix 2) | 2 | 1 |

The 10.0.7 row is the useful one: the double call from C# always existed, and msal.js 2's synchronous `init` absorbed it. Without a disposable Entra app registration I could not drive a real sign-in through the broken build, so the mapping from the second instance to each symptom comes from the code and the issue threads above. The double instance itself is measured.

## Fix, in detail

### 1. Initialize MSAL once in Program.cs

Call the authentication state provider once, after `Build()` and before `RunAsync()`:

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

No component exists yet at that point, so nothing can overlap with the call. It runs `EnsureAuthService` to completion, which sets the C# `_initialized` flag and the JavaScript one, and every later caller skips `init` entirely. JavaScript interop is available in a WebAssembly host before `RunAsync`, and in my repro this dropped the count to one `init` call and one instance on both routes.

The cost is that the first render waits for MSAL to initialize and read its cache, which is work the app did anyway a few milliseconds later. If your `AccountClaimsPrincipalFactory` calls Microsoft Graph or your own API in `CreateUserAsync`, that call also moves ahead of the first render. Keep it cheap or accept a slightly later first paint.

### 2. Or make init idempotent in JavaScript

If you cannot control startup, for example because a shared component library triggers token requests you do not own, fix the race where it is: in `init`. This shim memoizes the promise, which is also what the draft fix on #68136 does inside the package:

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

Script order matters. It has to run after the package script defines `window.AuthenticationService` and before Blazor starts:

```html
<!-- wwwroot/index.html -->
<script src="_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js"></script>
<script src="msal-init-fix.js"></script>
<script src="_framework/blazor.webassembly#[.{fingerprint}].js"></script>
```

C# still calls `init` twice, but both calls now await the same promise and only one `MsalAuthorizeService` is ever created. The `.catch` resets the cache so a failed initialization can be retried instead of failing forever. It works because Blazor invokes `AuthenticationService.init` by name through `window` on every call, so replacing the property is enough.

### 3. Or pin the package to 10.0.7

```xml
<!-- .NET 10: last Msal release that bundles msal.js 2.39.0 -->
<PackageReference Include="Microsoft.Authentication.WebAssembly.Msal" Version="10.0.7" />
```

The equivalents are 9.0.15 and 8.0.26. You can keep `Microsoft.AspNetCore.Components.WebAssembly` on 10.0.12: that combination builds, and the app serves the 2.39.0 bundle. Note that the pin drags `Microsoft.AspNetCore.Components.WebAssembly.Authentication` down to 10.0.7 as a transitive dependency. The price is that you ship an end-of-life msal.js, which is the reason Microsoft upgraded in the first place, so treat this as a bridge. Confirm what the browser actually receives:

```bash
curl -s http://localhost:5117/_content/Microsoft.Authentication.WebAssembly.Msal/AuthenticationService.js | grep -oE '"(2\.39\.0|4\.30\.0)"'
```

After any version change, clear the site data in the browser you test with. MSAL's cache and Blazor's saved state in `sessionStorage` survive app updates, which the [Microsoft Learn troubleshooting section](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id#cookies-and-site-data) calls out for exactly this kind of testing.

## Gotchas and lookalikes

**Users signed out after closing the browser, with `CacheLocation = "localStorage"`.** This is msal.js 4 working as designed, not the race. From v4, MSAL encrypts the `localStorage` cache with AES-GCM and keeps the key in a session cookie named `msal.cache.encryption` (present in the 10.0.12 bundle). The [v3 to v4 migration guide](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md) says the key is removed when the browser closes, so `localStorage` "will no longer persist across browser sessions". Neither fix above changes that. Plan for a silent or interactive sign-in after a browser restart.

**Silent sign-in fails only on hosts with private IPs.** If the app runs on `192.168.x.x` or `10.x.x.x` and Chrome 142 or later blocks the hidden iframe with `LocalNetworkAccessPermissionDenied`, that is Chrome's Local Network Access restriction, tracked in [dotnet/aspnetcore#64699](https://github.com/dotnet/aspnetcore/issues/64699). It appears on any package version.

**`AddOidcAuthentication` apps are not affected by this change.** The msal.js swap touched only the Msal package's interop script. If you use the generic OIDC provider, or a Blazor Web App that authenticates on the server, look elsewhere.

**When the fix ships, the workarounds are harmless.** The three issues are open against the 10.0.x milestone with no merged fix as of 2026-09-10. Leaving the `Program.cs` call in place costs nothing after that. The shim becomes a no-op wrapper, and you can delete it once `AuthenticationService.init` stores a promise instead of a boolean.

If this is a new app rather than a broken one, [Blazor Server vs WebAssembly vs United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) is worth reading first. Server-side authentication avoids browser-held tokens altogether.

## Related

- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/)
- [JWT vs cookie authentication in ASP.NET Core 11](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/), for the API side of a WebAssembly client.
- [What is a Blazor render mode and which one runs my component?](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [SignalR in .NET 11 RC 1 swaps an expiring token without dropping the connection](/2026/09/signalr-authentication-refresh-finalized-dotnet-11-rc-1/)

## Sources

- [dotnet/aspnetcore#66978, MSAL authentication issue after upgrading to 10.0.8](https://github.com/dotnet/aspnetcore/issues/66978)
- [dotnet/aspnetcore#68549, `uninitialized_public_client_application` after a Firefox refresh on 10.0.10](https://github.com/dotnet/aspnetcore/issues/68549)
- [dotnet/aspnetcore#68136, `RemoteAuthenticatorView` ignores `ReturnUrl` on 10.0.10](https://github.com/dotnet/aspnetcore/issues/68136)
- [dotnet/aspnetcore#66055, update `@azure/msal-browser` to 4.x](https://github.com/dotnet/aspnetcore/pull/66055), and its backports [#66094](https://github.com/dotnet/aspnetcore/pull/66094), [#66234](https://github.com/dotnet/aspnetcore/pull/66234), [#66236](https://github.com/dotnet/aspnetcore/pull/66236)
- [`AuthenticationService.ts` on `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/Authentication.Msal/src/Interop/AuthenticationService.ts)
- [`RemoteAuthenticationService.cs` on `release/10.0`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/WebAssembly.Authentication/src/Services/RemoteAuthenticationService.cs)
- [Secure a Blazor WebAssembly standalone app with Microsoft Entra ID](https://learn.microsoft.com/en-us/aspnet/core/blazor/security/webassembly/standalone-with-microsoft-entra-id)
- [msal-browser v2 to v3 migration guide](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v2-migration.md) and [v3 to v4 migration guide](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/v3-migration.md)
- [Microsoft.Authentication.WebAssembly.Msal on NuGet](https://www.nuget.org/packages/Microsoft.Authentication.WebAssembly.Msal)
