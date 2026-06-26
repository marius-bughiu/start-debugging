---
title: "JWT vs cookie authentication in ASP.NET Core 11: which should you pick?"
description: "Use cookie authentication for any app where the browser is the only client, and reserve JWT bearer tokens for APIs called by mobile apps, other services, or third parties. Here is the full decision matrix."
pubDate: 2026-06-26
template: vs
tags:
  - "comparison"
  - "aspnetcore"
  - "dotnet"
  - "authentication"
  - "security"
---

If the only thing calling your ASP.NET Core 11 app is a browser, use cookie authentication. If the caller is a mobile app, another service, or a third-party client that cannot hold a cookie, use JWT bearer tokens. The single axis that decides it is the client: cookies are a browser session mechanism with server-side revocation and built-in CSRF tooling, while JWTs are a stateless, self-contained credential that any HTTP client can carry but that you cannot revoke before it expires. Picking JWT for a server-rendered site or a same-origin single-page app is the most common security mistake in the .NET ecosystem, because it pushes a long-lived token into JavaScript-reachable storage for no benefit. This post backs that recommendation with the feature matrix, the wiring for both in .NET 11, and the gotcha that forces the call.

Everything here targets .NET 11, ASP.NET Core 11, and C# 14. Both schemes ship in box: cookie authentication lives in `Microsoft.AspNetCore.Authentication.Cookies` and JWT bearer lives in `Microsoft.AspNetCore.Authentication.JwtBearer`, the latter being the one NuGet reference you usually add. Nothing about the core trade-off changed in .NET 11, but the framework keeps nudging you toward the right default: the browser-based-apps OAuth guidance and the Backend-for-Frontend pattern have both hardened the advice to keep tokens out of the browser entirely.

## The feature matrix

| Feature                       | Cookie authentication                 | JWT bearer                              |
| ----------------------------- | ------------------------------------- | --------------------------------------- |
| Carried in                    | `Cookie` header (browser-managed)     | `Authorization: Bearer` header          |
| Server state                  | stateful (ticket can be re-validated) | stateless (self-contained claims)       |
| Revocable before expiry       | yes (immediately)                     | no (needs a denylist or short TTL)      |
| Set automatically by browser  | yes                                   | no (client attaches it)                 |
| CSRF exposure                 | yes, needs antiforgery tokens         | no (header is not auto-sent)            |
| XSS exposure of the credential| low (`HttpOnly` hides it from JS)     | high if stored in JS-readable storage   |
| Works for non-browser clients | awkward                               | native                                  |
| Cross-domain / multi-API      | painful (cookie scope rules)          | easy (any host validates the signature) |
| Payload size per request      | small opaque id-style value           | full token, grows with claims           |
| Built-in in .NET 11           | yes                                   | yes (`AddJwtBearer`)                     |

The rows that decide real designs are revocation, CSRF, and XSS. Everything else is plumbing.

## What each scheme actually is

Cookie authentication issues an encrypted authentication ticket after sign-in and stores it in a cookie that ASP.NET Core's Data Protection layer signs and encrypts. The browser attaches that cookie to every same-site request automatically. The server decrypts it, rebuilds the `ClaimsPrincipal`, and can run `OnValidatePrincipal` on each request to re-check the user against the database, which is how you revoke a session the instant a user is disabled.

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

The defining property is that the cookie value is opaque to JavaScript when `HttpOnly` is set, and the server holds enough context (the Data Protection keys, optionally a backing store) to invalidate it. The cost is that because the browser sends the cookie automatically on cross-site requests, you inherit CSRF and must defend against it with antiforgery tokens.

JWT bearer authentication validates a self-contained token on the `Authorization` header. The token is a signed (and optionally encrypted) blob of claims. There is no server-side session: validation is pure signature-plus-claims math, so any number of services can accept the same token by knowing the signing key or the issuer's public key. The client is responsible for storing the token and attaching it to every request.

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

Getting those `TokenValidationParameters` right is where most JWT bugs live; if you are debugging a token that the framework rejects, see [how to validate a JWT's issuer, audience, and lifetime in ASP.NET Core 11](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). The flip side is that you cannot un-issue a valid token: once it is signed and in the client's hands, it is accepted until `exp` passes, no matter what happens to the user account.

## When to pick cookie authentication

- **Server-rendered apps: MVC, Razor Pages, or Blazor Server in .NET 11.** The browser is the only client, it manages the cookie for you, and `HttpOnly` keeps the credential out of reach of any injected script. There is no token for JavaScript to leak.
- **A same-origin single-page app talking to its own backend.** This is the case people most often get wrong. If your React or Angular app is served from and calls the same origin, a cookie is both simpler and safer than minting a JWT and stashing it in `localStorage`. The OAuth working group's browser-based-apps guidance explicitly steers first-party SPAs toward a cookie-backed Backend-for-Frontend rather than tokens in the browser.
- **You need instant revocation.** Disabling a user, rotating a password, or forcing a global sign-out must take effect now. With cookies you re-validate the principal per request (`OnValidatePrincipal`) or change the Data Protection key, and the next request is unauthenticated. There is no waiting for a token to expire.
- **You are using ASP.NET Core Identity with local accounts.** Identity's default UI and `SignInManager` are cookie-based, and that is the supported, first-party path.

The tax you accept with cookies is CSRF. Because the browser sends the cookie on cross-site form posts, you need antiforgery protection on state-changing endpoints. `SameSite=Strict` or `Lax` blocks the common cases, and ASP.NET Core's antiforgery tokens close the rest. If those tokens stop validating after a deploy, that is usually a Data Protection key-ring problem, covered in [why the antiforgery token could not be decrypted](/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/).

## When to pick JWT bearer

- **A REST or gRPC API consumed by a mobile or desktop app.** A native client has no cookie jar tied to your domain and can store a token in the OS keychain or secure storage, which is a safer home than a browser. Bearer tokens are the natural fit.
- **Service-to-service calls and microservices.** A token signed by a central identity provider can be validated independently by a dozen services that never share a session store. This is the scenario where statelessness is a feature, not a liability.
- **Third-party API access where you do not control the client.** Public APIs, partner integrations, and anything driven by OAuth 2.0 client-credentials or authorization-code flows live on bearer tokens by design.
- **Cross-domain calls a cookie cannot cleanly reach.** If `app.com` must call `api.other.com`, cookie scoping fights you while a bearer token does not care about origin. If you do route a JWT-protected API call from a browser on another origin, the hard part is usually the preflight, not the token; see [how to configure CORS for a JWT-protected API in ASP.NET Core 11](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

The tax you accept with JWTs is revocation. A leaked or stolen token is valid until it expires, so the standard mitigation is short-lived access tokens (5 to 15 minutes) paired with longer-lived refresh tokens you can revoke server-side. If you are issuing your own tokens, do not skip that machinery; [how to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) walks through the rotation and revocation pieces.

## Why "JWT in localStorage" is the wrong default for browsers

The reason this comparison matters is that the popular SPA tutorial pattern, mint a JWT on login and save it in `localStorage`, trades a non-problem for a real one. A same-origin SPA does not need statelessness; its backend is right there and can keep a session. What it gets in exchange for the token is an XSS-exfiltratable credential. Any script that runs on your page, including one pulled in through a compromised npm dependency, can read `localStorage`, lift the token, and replay it from anywhere until it expires.

A cookie with `HttpOnly` cannot be read by `document.cookie` at all, so the same XSS that drains a `localStorage` token cannot directly steal a cookie. That is the entire reason the industry moved toward the Backend-for-Frontend pattern: the SPA authenticates against its own backend with a secure, `HttpOnly`, `SameSite` cookie, and the backend holds any upstream OAuth tokens server-side, never handing them to JavaScript. The IETF's current browser-based-apps draft recommends exactly this, and Duende's BFF framework packages it for ASP.NET Core. The short version: tokens belong in the browser only when there is no server to hold them for you, which for a first-party app is never.

## Running both schemes in one app

Picking one scheme globally does not mean you can only use one. A common real-world shape is a server-rendered site plus a JSON API in the same host: cookies for the pages, JWT for the API. Register both and select per endpoint.

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

The key detail: the scheme you pass first to `AddAuthentication` is the default, and any `[Authorize]` without an explicit scheme uses it. Endpoints that should accept a bearer token must name `JwtBearerDefaults.AuthenticationScheme` explicitly, or the framework will try to validate a cookie, find none, and challenge with a redirect to the login page instead of returning `401`. That mismatch, an API returning an HTML login redirect instead of a clean `401`, is a frequent symptom of a misconfigured default scheme. A related variant, where the API answers `405` instead of `401`, and the broader class of "valid token still rejected" problems, are worth knowing before you ship a mixed setup: see [why an ASP.NET Core JWT returns 401 even with a valid token](/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/).

## The gotcha that picks for you

Revocation latency is the forcing function. Ask one question: when a user's access must be cut off, how long can you tolerate the old credential still working?

- If the answer is "zero, it must stop immediately" (banking, admin consoles, anything where a compromised or fired account is an active threat), cookies win, because you can invalidate the session on the next request. To get the same behavior from JWTs you have to bolt on a server-side denylist, which reintroduces exactly the stateful lookup you adopted JWTs to avoid.
- If the answer is "a few minutes is fine," short-lived JWTs with refresh tokens are acceptable, and you keep the statelessness that makes them attractive across services.

The second forcing function is the client. A cookie is a browser construct. The moment a non-browser client must authenticate, a cookie stops being natural and a bearer token becomes the obvious carrier. If your app has both kinds of caller, that is not a tie, it is a signal to run both schemes as shown above, each on the endpoints it fits.

## The recommendation, restated

For an app whose only client is a browser, including a same-origin SPA, use cookie authentication: `HttpOnly`, `Secure`, `SameSite`, with antiforgery on state-changing endpoints. You get a credential JavaScript cannot read and revocation that takes effect on the next request, and you give up nothing a first-party web app actually needs. Reach for JWT bearer when the caller is a mobile or desktop app, another service, or a third party, where statelessness is a genuine advantage and there is no server-side session to lean on. When both kinds of client exist, register both schemes and select per endpoint rather than forcing one to do the other's job. The decision is not about which technology is more modern; it is about who is holding the credential and how fast you need to take it away.

## Related

- [How to validate a JWT's issuer, audience, and lifetime in ASP.NET Core 11](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [Why an ASP.NET Core JWT returns 401 even with a valid token](/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [How to configure CORS for a JWT-protected API in ASP.NET Core 11](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [How to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)
- [Why the antiforgery token could not be decrypted in ASP.NET Core](/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## Sources

- [Overview of ASP.NET Core authentication (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/?view=aspnetcore-10.0)
- [Use cookie authentication without ASP.NET Core Identity (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/cookie?view=aspnetcore-10.0)
- [Authentication and authorization in minimal APIs / JWT bearer (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication?view=aspnetcore-10.0)
- [Prevent Cross-Site Request Forgery (XSRF/CSRF) attacks (Microsoft Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/anti-request-forgery?view=aspnetcore-10.0)
- [OAuth 2.0 for Browser-Based Apps (IETF draft)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
- [Securing SPAs using the BFF Pattern (Duende Software)](https://duendesoftware.com/blog/20210326-bff)
