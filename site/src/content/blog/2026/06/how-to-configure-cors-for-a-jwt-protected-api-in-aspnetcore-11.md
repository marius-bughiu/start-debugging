---
title: "How to configure CORS for a JWT-protected API in ASP.NET Core 11"
description: "A complete guide to CORS for a bearer-token API in ASP.NET Core 11: the correct UseCors ordering relative to authentication, why a bearer token in the Authorization header is not a CORS credential, why AllowAnyHeader works but a manual wildcard does not cover Authorization, and how to keep preflight from failing."
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
---

If your single-page app calls a JWT-protected ASP.NET Core API from a different origin and the browser console shows "No 'Access-Control-Allow-Origin' header is present" or "Request header field authorization is not allowed", the fix is almost never on the authentication side. You need a CORS policy that names your front-end origin with `WithOrigins`, allows the `Authorization` request header, and runs `app.UseCors(...)` *before* `app.UseAuthentication()` and `app.UseAuthorization()`. The one thing most guides get wrong: a bearer token you set yourself in the `Authorization` header is **not** a CORS credential, so you do **not** need `AllowCredentials()` for a header-based JWT API, and adding it forces you to drop `AllowAnyOrigin` for no benefit. This post targets .NET 11 (preview 5 at the time of writing), but the CORS and JWT bearer APIs are unchanged from .NET 8, 9, and 10.

## CORS and JWT are two unrelated gates that fail at the same time

A cross-origin request from `https://app.example.com` to `https://api.example.com` passes through two completely independent checks, and confusing them is the root of almost every wasted afternoon here.

The first is CORS. It is enforced by the browser, not your server. The browser decides whether JavaScript is *allowed to read the response* based on the `Access-Control-Allow-*` headers your server sends. CORS knows nothing about who you are. It only cares about origins, methods, and request headers.

The second is authentication. ASP.NET Core's JWT bearer handler validates the token in the `Authorization` header and produces a 401 or a `ClaimsPrincipal`. It knows nothing about origins.

The trap is that a misconfigured CORS policy and a missing token produce errors that look alike in DevTools. A 401 with no CORS headers shows up in the console as a CORS failure, because the browser strips the response before your code can see the status. So you spend an hour on the token when the real problem is policy ordering, or vice versa. Keep the two gates separate in your head: CORS decides whether the browser hands you the bytes, auth decides whether the server produced them.

## A bearer token in the Authorization header is not a CORS "credential"

This is the single most misunderstood point, and getting it right simplifies everything downstream.

In the CORS spec, "credentials" means three specific things: cookies, TLS client certificates, and the `Authorization` header *that the user agent populates automatically* from stored HTTP authentication. When you write `fetch(url, { headers: { Authorization: "Bearer " + token } })`, you are setting an author-defined request header. That is not a credentialed request. The `credentials` mode of that fetch is still the default `"same-origin"`, which for a cross-origin call means "send no cookies".

The consequence: for a typical SPA that stores its JWT in memory or `localStorage` and attaches it manually, you should **not** call `AllowCredentials()`. You only need it when the token (or a refresh token, or a session) rides in a cookie, because cookies are real CORS credentials and the browser will not send them cross-origin unless the response says `Access-Control-Allow-Credentials: true`.

Why does this matter beyond pedantry? Because `AllowCredentials()` is incompatible with `AllowAnyOrigin()`. The moment you add credentials, the CORS spec forbids the `*` origin wildcard, and ASP.NET Core enforces this by throwing at startup:

```csharp
// .NET 11, C# 14
// This throws ArgumentException at app build time:
// "The CORS protocol does not allow specifying a wildcard (any) origin
//  and credentials at the same time."
options.AddPolicy("bad", policy => policy
    .AllowAnyOrigin()
    .AllowCredentials());
```

So if you reflexively add `AllowCredentials()` for a header-based bearer API, you have taken on the origin-pinning constraint with none of the benefit. Leave it off unless you actually use cookies.

## The policy that works

Here is the complete, correct setup for a minimal API that validates JWTs and is called from one or more known front-end origins. If you are still choosing between minimal APIs and the MVC model, the trade-offs are covered in [minimal APIs vs controllers in ASP.NET Core 11](/2026/05/minimal-apis-vs-controllers-in-aspnetcore-11/); CORS is identical either way.

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

Three deliberate choices in that policy:

- `WithOrigins` lists exact origins, scheme and port included. `http://localhost:5173` and `https://localhost:5173` are different origins, and so is the same host on a different port.
- `WithHeaders("Authorization", "Content-Type")` allows the two request headers a JSON+JWT call actually sends. `Content-Type: application/json` is not a CORS-safelisted value, so it triggers preflight on its own.
- `WithMethods` lists the verbs the API exposes. A `PUT` or `DELETE` always triggers preflight.

No `AllowCredentials()`, because this is a header-based bearer API.

## Why UseCors has to run before UseAuthentication

The middleware order is not stylistic. `app.UseCors(...)` must sit after `UseRouting` (which `WebApplication` calls implicitly) and **before** `UseAuthentication` and `UseAuthorization`. Microsoft's [CORS documentation](https://learn.microsoft.com/en-us/aspnet/core/security/cors) states the rule; here is what actually breaks if you ignore it.

A CORS preflight is an `OPTIONS` request, and the browser sends it **without** the `Authorization` header. That is by design: preflight asks "may I make this request?" before any credentials are attached. If authentication or an `[Authorize]`/`RequireAuthorization` gate runs before the CORS middleware, the unauthenticated `OPTIONS` request gets a 401, the browser never receives the `Access-Control-Allow-*` headers, and the real request is never sent. You will see a preflight failure in the Network tab and conclude, wrongly, that your token is bad.

With `UseCors` placed first, the CORS middleware recognizes the preflight, answers it with a 204 and the right headers, and short-circuits before auth ever runs. The actual `GET`/`POST` that follows carries the token and flows through authentication normally.

The same ordering also fixes the "401 with no CORS headers" problem for real requests. When a token is missing or expired, you *want* the 401 to still carry `Access-Control-Allow-Origin` so the browser exposes the response and your SPA can read the status and redirect to login. That only happens if CORS runs before the auth middleware that produces the 401. This exact gap was the subject of a long-standing ASP.NET Core issue ([dotnet/aspnetcore#16584](https://github.com/dotnet/aspnetcore/issues/16584)) and ordering is the resolution.

## The Authorization-header wildcard gotcha

This one bites people who try to be permissive in development and then tighten up. Per the [Fetch standard](https://fetch.spec.whatwg.org/), and documented on [MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers), the wildcard in `Access-Control-Allow-Headers: *` does **not** cover the `Authorization` header. The browser treats `Authorization` as special: it must be named explicitly, or the preflight for any request carrying a bearer token fails with "Request header field authorization is not allowed by Access-Control-Allow-Headers".

So if you hand-roll CORS in custom middleware with a literal `Access-Control-Allow-Headers: *`, your JWT calls break even though the wildcard looks like it allows everything.

Here is the reassuring part for ASP.NET Core users: the built-in `AllowAnyHeader()` does **not** emit a literal `*`. The `CorsService` echoes back the exact headers the browser asked for in `Access-Control-Request-Headers`, which means `Authorization` is reflected and the preflight succeeds. You can verify this in the [CorsService source](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs): the allowed-headers value comes from `GetCommaSeparatedValues(CorsConstants.AccessControlRequestHeaders)`, not a constant `*`.

The practical rule that falls out of this:

- `AllowAnyHeader()` works fine for bearer tokens, because ASP.NET Core echoes rather than wildcards.
- `WithHeaders(...)` works only if you include `"Authorization"` in the list. Forgetting it is the most common self-inflicted CORS failure on a JWT API, because `Content-Type` alone looks complete and the 403/preflight error is unspecific.

When in doubt, list `Authorization` explicitly. It costs nothing and removes a class of bugs.

## Configuring it correctly, step by step

1. Register CORS with a named policy in `AddCors`, pinning your front-end origins with `WithOrigins` (exact scheme, host, and port).
2. Allow the request headers your client sends. Include `"Authorization"` and `"Content-Type"` explicitly with `WithHeaders`, or use `AllowAnyHeader()` and rely on ASP.NET Core's header echo.
3. Allow the HTTP methods your endpoints expose with `WithMethods`, including the verbs (`PUT`, `DELETE`) that always trigger preflight.
4. Decide on credentials: omit `AllowCredentials()` for a header-based bearer token; add it only if a cookie is involved, and in that case replace `AllowAnyOrigin` with explicit `WithOrigins`.
5. Place `app.UseCors("policy")` after routing and before `app.UseAuthentication()` and `app.UseAuthorization()`.
6. Apply the policy globally with `app.UseCors(...)`, or per endpoint with `.RequireCors("policy")` (or `[EnableCors("policy")]` on controllers). Do not mix global middleware CORS with the attribute on the same app.

## Cookies, refresh tokens, and the credentialed case

If your design keeps the access token in memory but stores a refresh token in an `HttpOnly` cookie (a common and sound pattern, see [how to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)), then the refresh call *is* credentialed and the rules flip:

```csharp
// .NET 11, C# 14
options.AddPolicy("spa-with-cookie", policy => policy
    .WithOrigins("https://app.example.com") // exact origins only, no AllowAnyOrigin
    .WithHeaders("Authorization", "Content-Type")
    .WithMethods("GET", "POST", "PUT", "DELETE")
    .AllowCredentials());                    // required so the browser sends the cookie
```

On the client, that one endpoint needs `fetch(url, { credentials: "include" })`. The server must answer with a specific `Access-Control-Allow-Origin` (never `*`) and `Access-Control-Allow-Credentials: true`, which is exactly what the policy above produces. ASP.NET Core still echoes the allowed headers rather than wildcarding them, so `Authorization` continues to work in the credentialed case too. The takeaway: scope `AllowCredentials()` to the policy that actually touches cookies, not to your whole API.

## Reducing preflight chatter

Every cross-origin request with a non-simple method or header pays for a preflight round trip. `SetPreflightMaxAge(TimeSpan.FromMinutes(10))` tells the browser it may cache the preflight result, so repeated calls to the same endpoint skip the `OPTIONS` hop. Browsers cap this value (Chromium honors up to two hours, Firefox up to 24, and both have their own ceilings), so treat it as a hint rather than a guarantee. It is still worth setting on a chatty API.

If you only need a couple of front-end origins and the same policy everywhere, `AddDefaultPolicy` plus a parameterless `app.UseCors()` is slightly less ceremony than a named policy. For a larger API where different endpoint groups have different rules, combine a named policy with `.RequireCors(...)` on a `MapGroup`, which pairs naturally with the structure described in [organizing minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## When the token is rejected and CORS is not the problem

Once preflight passes and the real request carries `Access-Control-Allow-Origin`, any remaining 401 is a genuine authentication failure, and you should stop looking at CORS. The usual suspects are a mismatched `Audience` or `Authority`, a clock skew on token lifetime, or tooling that silently drops the header. If a UI like Scalar or Swagger sends requests without the bearer token even though you pasted it in, that is a separate, well-documented issue covered in [why your bearer token is ignored in Scalar](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) and in [adding OpenAPI authentication flows to Swagger UI](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/).

The mental model that keeps you out of trouble: CORS is the browser asking "is this cross-origin call allowed, and may I read the answer?" and JWT bearer is the server asking "do I trust this token?" Configure the policy to name your origins and the `Authorization` header, run `UseCors` before the auth middleware, skip `AllowCredentials` unless a cookie is in play, and the two gates stop interfering with each other.

Sources: [Enable Cross-Origin Requests (CORS) in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/cors), [Access-Control-Allow-Headers - MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Access-Control-Allow-Headers), [Fetch Standard - WHATWG](https://fetch.spec.whatwg.org/), [CorsService source - dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Middleware/CORS/src/Infrastructure/CorsService.cs), [aspnetcore#16584 - CORS headers and JWT bearer 401](https://github.com/dotnet/aspnetcore/issues/16584).
