---
title: "Fix: Response.Cookies.Append does not set the cookie in the browser in ASP.NET Core"
description: "The Set-Cookie header is sent, but the browser rejects or never stores it. Fix SameSite=None without Secure, missing credentials: 'include' plus AllowCredentials, consent policy, and late Append calls."
pubDate: 2026-10-28
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet"
  - "dotnet-10"
  - "cookies"
  - "cors"
---

The fix: `Response.Cookies.Append` almost never fails on the server. It writes a `Set-Cookie` header, and the browser then silently refuses to store it. In order of likelihood, the cause is: the request was cross-origin and the client did not send `credentials: 'include'` (or the server did not call `AllowCredentials()`), the cookie has `SameSite=None` without `Secure`, a `CookiePolicy` consent check suppressed a cookie that is not marked `IsEssential`, or `Append` ran after the response had already started. Open the browser DevTools Network tab, select the response, and look at the Cookies sub-tab: Chromium tells you exactly which rule blocked it.

Everything below targets .NET 10 and ASP.NET Core 10 (the behaviour is identical in .NET 11 previews and has been stable since ASP.NET Core 3.1). Browser behaviour refers to current Chrome, Firefox, and Safari releases as of October 2026.

```text
// Roughly what Chrome DevTools shows under Network > (response) > Cookies
Set-Cookie: session=abc123; path=/; samesite=none
  ⚠ This attempt to set a cookie via a Set-Cookie header was blocked because it had the
    "SameSite=None" attribute but did not have the "Secure" attribute, which is required
    in order to use "SameSite=None".
```

And in the ASP.NET Core log, when the logger for `Microsoft.AspNetCore.Http.ResponseCookies` is enabled at `Warning`:

```text
warn: Microsoft.AspNetCore.Http.ResponseCookies
      The cookie 'session' has set 'SameSite=None' and must also set 'Secure'.
```

## Why the cookie never reaches document.cookie or the next request

`Response.Cookies.Append` is a thin wrapper. In the ASP.NET Core source (`src/Http/Http/src/Internal/ResponseCookies.cs`) it does three things: if `SameSite` is `None` and `Secure` is `false` it logs the warning above, it URL-encodes the value with `Uri.EscapeDataString`, and it concatenates a new `Set-Cookie` header onto the response. That is it. It does not validate the domain, it does not check CORS, and it does not throw when the cookie is going to be rejected. Every one of the real failures happens later, inside the browser, which applies a stack of rules to each `Set-Cookie` header:

1. **CORS credentials mode.** For a cross-origin `fetch` or `XMLHttpRequest`, the browser ignores `Set-Cookie` entirely unless the request was made in credentials mode (`credentials: 'include'` / `withCredentials = true`) and the response carried `Access-Control-Allow-Credentials: true` with an explicit (non-`*`) `Access-Control-Allow-Origin`.
2. **SameSite.** A `SameSite=None` cookie without `Secure` is rejected by every current browser. A `Lax` or `Strict` cookie set on a cross-site response is rejected as a third-party cookie.
3. **Secure.** A `Secure` cookie set over plain `http://` is rejected, with one exception: Chrome (since 89) and Firefox (since 75) treat `http://localhost` as secure for this purpose. Safari does not.
4. **Domain and Path.** A `Domain` attribute that does not domain-match the response host is rejected. A `Path` that does not cover the URL you later request means the cookie is stored but never sent back, which looks identical to "not set".
5. **Size.** A single cookie (name plus value) over 4096 bytes is dropped.

On top of the browser rules, ASP.NET Core itself has two places where a cookie can vanish before it hits the wire: the `CookiePolicyMiddleware` consent check, and the "response has already started" boundary.

## Minimal repro: a React dev server calling an ASP.NET Core API

This is the setup behind most of the "cookie not set" questions on Stack Overflow: a SPA on one port, an API on another.

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

Three separate bugs stack up here. The `fetch` calls use the default `credentials: 'same-origin'`, so the browser discards `Set-Cookie` from the cross-origin response and does not attach cookies to `/me`. The CORS policy has no `AllowCredentials()`. And the cookie is `SameSite=None` without `Secure`. Fixing only one of them leaves you staring at the same 401, which is why this problem feels so random.

## Fix 1: send credentials and allow them in the CORS policy

For any cross-origin call, both sides must opt in. On the client:

```javascript
// Browser, any framework
await fetch("https://localhost:7001/login", {
  method: "POST",
  credentials: "include"
});

// axios equivalent
axios.post("https://localhost:7001/login", null, { withCredentials: true });
```

On the server, list the exact origins and call `AllowCredentials()`:

```csharp
// .NET 10, ASP.NET Core 10
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173", "https://app.example.com")
     .AllowAnyHeader()
     .AllowAnyMethod()
     .AllowCredentials()));
```

You cannot combine `AllowAnyOrigin()` with `AllowCredentials()`. The CORS specification forbids `Access-Control-Allow-Origin: *` on a credentialed response, and ASP.NET Core enforces this when it builds the policy by throwing `InvalidOperationException: The CORS protocol does not allow specifying a wildcard (any) origin and credentials at the same time.` If you need dynamic origins, use `SetIsOriginAllowed(origin => ...)` with a real check, never `_ => true`, because reflecting any origin with credentials enabled is a textbook CSRF hole. The full policy setup, including preflight caching, is covered in [configuring CORS for a JWT-protected API in ASP.NET Core 11](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

The middleware order matters too: `app.UseCors()` must run before the endpoint that appends the cookie, and before `UseAuthentication()` / `UseAuthorization()`.

## Fix 2: pair SameSite=None with Secure, or avoid SameSite=None

The default `CookieOptions.SameSite` is `SameSiteMode.Unspecified`, which means ASP.NET Core emits no `SameSite` attribute and the browser applies its own default. Chromium treats a missing attribute as `Lax`. That default is correct for almost every same-site app, and you should only reach for `None` when the cookie genuinely has to travel on cross-site requests (an iframe embedded on another site, a third-party widget, an identity provider callback that uses `form_post`).

If you do need `None`, `Secure` is mandatory:

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

Here is the distinction that trips people up: **SameSite is about the site, CORS is about the origin.** A site is the scheme plus the registrable domain, and it ignores the port. So `http://localhost:5173` calling `http://localhost:5001` is cross-origin (CORS applies, you need Fix 1) but same-site (`Lax` cookies work). `app.example.com` calling `api.example.com` is also same-site. In those setups you do not need `SameSite=None` at all; keep `Lax` and just fix credentials.

The scheme does count, though. Chrome has used "schemeful same-site" since Chrome 89, so `http://localhost:5173` calling `https://localhost:7001` is cross-site, and a `Lax` cookie set by the HTTPS API will not be sent from the HTTP page's requests. Either run both dev servers on the same scheme (the Vite `basicSsl` plugin or `dotnet dev-certs https` both work) or put the API behind the dev server's proxy so the browser only ever talks to one origin. The proxy option is the most robust because it reproduces the production same-origin deployment.

Truly cross-site cookies (the SPA on `myapp.com`, the API on `myapi.net`) are third-party cookies. Chrome kept them enabled by default after Google dropped its deprecation plan in April 2025, but Safari blocks them outright and Firefox partitions them under Total Cookie Protection. Do not build on them. Move the API under the same registrable domain, or switch to a Backend-for-Frontend so the browser holds a first-party cookie. If you must embed cross-site, look at partitioned cookies (CHIPS). `CookieOptions` in ASP.NET Core 10 has no `Partitioned` property, but `Extensions` lets you add the attribute yourself:

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

## Fix 3: mark the cookie IsEssential, or stop requiring consent

If your app calls `app.UseCookiePolicy()` with `CheckConsentNeeded` returning `true`, the `CookiePolicyMiddleware` wraps the response cookie collection and silently drops every cookie that is not marked essential until the user has accepted the consent cookie. Nothing is logged at the default level, and the call to `Append` looks like it worked. ASP.NET Core 2.1 to 2.2 templates shipped with this enabled, so older projects that were upgraded step by step often still carry it.

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

Either the cookie is required for the app to work, in which case set `IsEssential = true` (and be honest about it in your privacy policy), or it is not, and the correct behaviour is to wait for consent:

```csharp
// .NET 10, ASP.NET Core 10
ctx.Response.Cookies.Append("cart", cartId, new CookieOptions
{
    IsEssential = true,
    HttpOnly = true,
    Secure = true
});
```

You can check consent state explicitly with `ctx.Features.Get<ITrackingConsentFeature>()`, whose `CanTrack` property tells you whether non-essential cookies will be written. `MinimumSameSitePolicy` on the same options can also rewrite your cookie's `SameSite` to something stricter than what you passed, so if a cookie shows up with a different `SameSite` than you set, look here.

## Fix 4: append before the response starts

Response headers are sent the moment the first byte of the body is flushed. After that point `Response.Cookies.Append` throws `InvalidOperationException: Headers are read-only, response has already started.` The classic places this happens are middleware that appends a cookie after `await next()`, an endpoint that writes to `Response.Body` and then sets a cookie, and code inside a streaming response or SSE loop.

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

If the exception is swallowed somewhere (an exception filter, a fire-and-forget task), the visible symptom is just a missing cookie, so check `ctx.Response.HasStarted` in a breakpoint when you suspect this.

## Gotchas that look like "the cookie was not set"

**The cookie is set, but your JavaScript cannot see it.** `HttpOnly = true` hides it from `document.cookie` by design. Check the Application tab in DevTools instead. This is the behaviour you want for session tokens, as discussed in [JWT vs cookie authentication in ASP.NET Core 11](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

**The cookie is stored but not sent back.** `CookieOptions` defaults `Path` to `/`, which is fine, but if you set `Path = "/api/auth"` the browser will only attach it to URLs under that path. The same applies to a `Domain` set to a parent domain that your dev host does not match. Leave `Domain` unset unless you need subdomain sharing; a host-only cookie is stricter and safer.

**The value looks mangled.** `Append` runs the value through `Uri.EscapeDataString`, so `a b=c` arrives in `document.cookie` as `a%20b%3Dc`. `Request.Cookies` decodes it for you on the server; JavaScript readers need `decodeURIComponent`.

**Safari works in production but not on localhost.** Safari rejects `Secure` cookies over `http://localhost`, while Chrome and Firefox accept them. Run the dev server on HTTPS with `dotnet dev-certs https --trust`.

**Blazor interactive components.** In Blazor Server or interactive render modes, the component runs over a SignalR circuit after the initial HTTP response is gone, so there is no response to append to and `HttpContext` is null or stale. Set cookies from a Razor Page, a minimal API endpoint the client calls, or a static SSR form post. The same restriction drives the design behind [`[SupplyParameterFromSession]` in static SSR](/2026/06/blazor-supplyparameterfromsession-static-ssr-dotnet-11-preview-5/).

**The cookie is too big.** Browsers drop a cookie whose name plus value exceeds 4096 bytes. ASP.NET Core's cookie authentication handler chunks large tickets across `.AspNetCore.Cookies`, `C1`, `C2` automatically through `ChunkingCookieManager`, but a plain `Response.Cookies.Append` does not. If you are stuffing a JWT with many claims into a cookie, either trim the claims or keep the token server-side and put a short handle in the cookie. Refresh-token flows are a common source of this; see [implementing refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) for a layout that keeps cookies small.

**Antiforgery cookies vanishing after a deploy** are a different problem with the same symptom. The cookie is set, but it cannot be decrypted by the next instance. That one is covered in [fixing "The antiforgery token could not be decrypted"](/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## A checklist that finds the cause in under a minute

When a cookie does not stick, go through these in order. Each step either finds the bug or rules out a whole category:

1. Open DevTools, Network tab, select the response that should set the cookie, and confirm the `Set-Cookie` header is present. If it is missing, the problem is server-side: consent policy, an exception after the response started, or the code path never ran.
2. If the header is present, open the Cookies sub-tab of that request. Chromium flags blocked cookies with a warning icon and the exact reason (SameSite, Secure, Domain, or third-party blocking).
3. If the call is cross-origin, check the request for `credentials: 'include'` and the response for `Access-Control-Allow-Credentials: true` plus a concrete `Access-Control-Allow-Origin`.
4. If the cookie is stored but the next request lacks it, compare its `Path`, `Domain`, `SameSite`, and `Secure` against the URL and scheme of that next request.
5. If it works in Chrome and fails in Safari, it is either `Secure` over `http://localhost` or a third-party cookie.

The server code is rarely the bug. Treat `Append` as "please consider storing this", and debug the browser's answer.

## Sources

- [ResponseCookies.cs in dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Http/Http/src/Internal/ResponseCookies.cs) (the `SameSite=None` warning and value encoding)
- [CookieOptions class on MS Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.http.cookieoptions)
- [Enable CORS in ASP.NET Core: credentials in cross-origin requests](https://learn.microsoft.com/en-us/aspnet/core/security/cors#credentials-in-cross-origin-requests)
- [EU General Data Protection Regulation (GDPR) support in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/gdpr)
- [Work with SameSite cookies in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/samesite)
- [MDN: Set-Cookie](https://developer.mozilla.org/docs/Web/HTTP/Headers/Set-Cookie)
- [dotnet/aspnetcore#55370: Add support for Partitioned cookies](https://github.com/dotnet/aspnetcore/issues/55370)
