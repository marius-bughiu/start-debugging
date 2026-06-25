---
title: "Why your ASP.NET Core JWT returns 401 even with a valid token"
description: "A valid token that still 401s almost always means the bearer handler never ran or ran under the wrong scheme. Check middleware order, the default scheme, the scheme name, and whether the header even reached the handler."
pubDate: 2026-06-25
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
---

You decoded the token on [jwt.io](https://jwt.io/), the signature checks out, the `exp` is hours away, the `iss` and `aud` are exactly what you configured, and ASP.NET Core still answers `401 Unauthorized`. When the token itself is provably good, the bug is almost never in the token. It is that the JWT bearer handler either never ran for this request, or it ran under a scheme your `[Authorize]` attribute is not asking for. The four usual culprits, in the order they bite: `app.UseAuthentication()` is missing or sits after `app.UseAuthorization()`; no default authentication scheme is registered; the scheme name on `AddJwtBearer` does not match what `[Authorize]` challenges; or the `Authorization` header never reached the handler at all. This post uses .NET 11 with `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0-preview and C# 14, but the diagnosis is identical back to .NET 8.

If you suspect the token's claims are actually wrong (a five-minute `ClockSkew` window, a mismatched audience), that is a different post: [how to validate a JWT's issuer, audience, and lifetime](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) walks the `TokenValidationParameters` side in detail. Here we assume you have already proven the token is valid and the 401 persists anyway.

## What the 401 actually tells you

The response you see is sparse on purpose:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

Per [RFC 9110](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2), a 401 must carry a `WWW-Authenticate` header naming a challenge, and ASP.NET Core sends `Bearer`. What it does not send by default is a reason. If the handler ran and rejected the token, the real cause is a `Microsoft.IdentityModel` exception that the handler swallowed. If the handler never ran, there is no exception at all, just an authorization policy that found no authenticated user and challenged. Telling those two cases apart is the whole game, and the fastest way to do it is to make the handler talk (covered near the end).

One thing to rule out immediately: a 401 means "we do not know who you are." A 403 means "we know who you are, you just are not allowed." If you are getting 403, the token validated fine and your problem is a policy or role check, not authentication. Do not spend an afternoon debugging token validation for a 403.

## Cause 1: UseAuthentication is missing or after UseAuthorization

This is the single most common cause and the easiest to miss because both lines are present, just in the wrong order. Authentication middleware is what reads the `Authorization` header, runs the bearer handler, and sets `HttpContext.User`. Authorization middleware is what enforces `[Authorize]`. If authorization runs first, `HttpContext.User` is still the anonymous default, so every protected endpoint challenges with a 401 no matter how good the token is.

```csharp
// .NET 11, C# 14 -- WRONG: authorization runs before the user is set
app.UseAuthorization();
app.UseAuthentication();   // too late, User is already anonymous
```

```csharp
// .NET 11, C# 14 -- correct order
app.UseAuthentication();   // reads the token, populates HttpContext.User
app.UseAuthorization();    // now enforces [Authorize] against a real user
```

The rule is mechanical: `UseAuthentication` before `UseAuthorization`, and both after `UseRouting` (in the modern minimal hosting model `UseRouting` is added for you, so you mostly just need the two auth calls in the right relative order). If you removed `UseAuthentication` entirely, perhaps while refactoring, the symptom is identical: a universal 401 on anything with `[Authorize]`. Add it back first before touching anything else.

## Cause 2: no default authentication scheme is registered

A `[Authorize]` attribute with no scheme named uses the *default authenticate scheme*. If you never told `AddAuthentication` what that default is, there is no scheme to run, the user stays anonymous, and you get a 401. This trips people because the registration *looks* complete:

```csharp
// .NET 11, C# 14 -- WRONG: no default scheme, [Authorize] has nothing to run
builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`AddAuthentication()` with no argument registers the services but sets no default scheme. The fix is to pass the scheme name as the default, which is exactly what `AddJwtBearer` registers under when you do not name it:

```csharp
// .NET 11, C# 14 -- correct: "Bearer" becomes the default scheme
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

`JwtBearerDefaults.AuthenticationScheme` is the string `"Bearer"`. Passing it to `AddAuthentication` sets `DefaultAuthenticateScheme` and `DefaultChallengeScheme` to `"Bearer"` in one move, so a bare `[Authorize]` now knows to run the bearer handler. If you prefer to be explicit, set the properties directly:

```csharp
// .NET 11, C# 14 -- the explicit form, equivalent to the above
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options => { /* ... */ });
```

## Cause 3: the scheme name does not match

The moment you give `AddJwtBearer` a custom scheme name, you have opted out of the default and you now have to ask for that scheme by name everywhere. This is the second-most-common "valid token, still 401" trap, and it is sneaky because the configuration is otherwise perfect.

```csharp
// .NET 11, C# 14 -- registers the handler under "MyApi", not "Bearer"
builder.Services.AddAuthentication()
    .AddJwtBearer("MyApi", options =>
    {
        options.Authority = "https://login.example.com";
        options.Audience = "api://my-api";
    });
```

```csharp
// .NET 11, C# 14 -- a bare [Authorize] looks for the default scheme,
// which is unset, so the "MyApi" handler never runs -> 401
[Authorize]
public class OrdersController : ControllerBase { /* ... */ }
```

You have two ways out. Either make `"MyApi"` the default so bare `[Authorize]` finds it, or name the scheme on every attribute that should use it:

```csharp
// .NET 11, C# 14 -- option A: make the named scheme the default
builder.Services.AddAuthentication("MyApi")
    .AddJwtBearer("MyApi", options => { /* ... */ });

// .NET 11, C# 14 -- option B: ask for the scheme by name
[Authorize(AuthenticationSchemes = "MyApi")]
public class OrdersController : ControllerBase { /* ... */ }
```

This matters most when you genuinely run more than one scheme, say a bearer scheme for your API plus cookies for a server-rendered admin area. With multiple schemes there is no sensible single default, so the bearer endpoints must spell out `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]`. Skip that and the request gets validated against whatever scheme happens to be default, which is not yours, and the token is ignored.

## Cause 4: the header never reached the handler

If the handler ran, found no `Authorization` header (or a malformed one), it cannot authenticate anyone, and you get a 401 that has nothing to do with the token's contents. The token in your Postman tab is valid; it just is not arriving the way you think.

The format is strict. The header value must be the literal word `Bearer`, one space, then the raw token, with no quotes and no `Basic`/`Bearer` confusion:

```text
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

Common ways this goes wrong in practice:

- **The client never attaches it.** A typed `HttpClient` whose `DefaultRequestHeaders.Authorization` was set on a *different* client instance, or a fetch call that forgot the header on retries. Log the inbound headers on the server to see what actually arrived.
- **A CORS preflight is being rejected, not your real request.** A browser sends an `OPTIONS` preflight with no `Authorization` header before the real call. If CORS is misconfigured the browser blocks the real request and your network tab shows what looks like an auth failure. The fix is on the CORS side, not the token side: see [how to configure CORS for a JWT-protected API](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) for the correct middleware order and policy.
- **A reverse proxy or load balancer strips it.** Some proxies drop `Authorization` on forward unless explicitly told to preserve it. If it works locally and 401s only behind nginx, IIS, or an ingress controller, suspect this first.
- **An API explorer is dropping it.** Swagger UI and Scalar will silently send requests without the token if their auth integration is not wired up. If your `curl` works but the docs UI does not, that is the tell, covered in [why your bearer token is ignored in Scalar](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/).

## Make the handler tell you why

Stop guessing. Wire up `JwtBearerEvents` so the handler logs the actual outcome, then you will know within one request whether it ran at all and, if it did, which check failed.

```csharp
// .NET 11, C# 14
.AddJwtBearer(options =>
{
    options.Authority = "https://login.example.com";
    options.Audience = "api://my-api";

    options.Events = new JwtBearerEvents
    {
        OnAuthenticationFailed = ctx =>
        {
            // Fires only if the handler RAN and the token was rejected.
            // ctx.Exception carries the IDX code (expired, bad audience, etc.)
            var log = ctx.HttpContext.RequestServices
                .GetRequiredService<ILogger<Program>>();
            log.LogWarning(ctx.Exception, "JWT rejected");
            return Task.CompletedTask;
        },
        OnChallenge = ctx =>
        {
            // Fires whenever a 401 is about to be sent, INCLUDING the
            // "no token / handler never validated anything" case.
            var log = ctx.HttpContext.RequestServices
                .GetRequiredService<ILogger<Program>>();
            log.LogWarning("JWT challenge: {Error} {Desc}",
                ctx.Error, ctx.ErrorDescription);
            return Task.CompletedTask;
        },
        OnTokenValidated = ctx =>
        {
            // Fires when a token validated successfully. If you see THIS
            // and still get a 401, the problem is authorization, not auth.
            return Task.CompletedTask;
        },
    };
});
```

The decision tree this gives you is precise. If `OnAuthenticationFailed` fires, the handler ran and rejected a real token; read `ctx.Exception` for the `IDX` code and jump to the [token validation guide](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). If only `OnChallenge` fires with no preceding failure, the handler never had a token to validate, so you are looking at causes 1 through 4 above, not the token. If `OnTokenValidated` fires and you *still* get a non-200, you have a 403-shaped authorization problem wearing a 401 costume, and no amount of token tweaking will help.

You can get the same signal without code by turning up the log category in `appsettings.Development.json`:

```json
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Authentication": "Debug"
    }
  }
}
```

That surfaces lines like "Bearer was not authenticated. Failure message: ..." straight in the console, which alone resolves most of these in under a minute.

## A reliable known-good token to test against

Half the time spent on this bug is doubt about whether the token is really valid. Remove the doubt with the `dotnet user-jwts` tool, which mints a token signed with a key it also wires into your development configuration, so validation cannot fail on a key mismatch:

```bash
# .NET 11 SDK -- creates a local-dev JWT and configures the app to accept it
dotnet user-jwts create
```

If a `user-jwts` token authenticates but your real provider's token does not, the token's claims or signing key are the difference and you are back to validation parameters. If even the `user-jwts` token 401s, the token was never the problem, and one of the four wiring causes above is. That single experiment splits the search space cleanly in half.

## Diagnose it in order

When a valid token 401s, work this checklist top to bottom. The early steps catch the overwhelming majority, so do not skip ahead.

1. **Confirm it is a 401, not a 403.** A 403 means authentication already succeeded; stop here and look at your authorization policies instead.
2. **Check middleware order.** `app.UseAuthentication()` must be present and must come before `app.UseAuthorization()`. This alone fixes most cases.
3. **Check the default scheme.** Either pass `JwtBearerDefaults.AuthenticationScheme` to `AddAuthentication`, or set `DefaultAuthenticateScheme` explicitly. A bare `AddAuthentication()` with a bare `[Authorize]` cannot work.
4. **Check the scheme name.** If you named the scheme on `AddJwtBearer("X")`, either make `"X"` the default or use `[Authorize(AuthenticationSchemes = "X")]` everywhere.
5. **Confirm the header arrives.** Log inbound request headers on the server. Verify the exact `Authorization: Bearer <token>` shape, and rule out a proxy or CORS preflight eating it.
6. **Mint a `dotnet user-jwts` token and retry.** If that authenticates, your real token's claims or key are the issue; move to the [validation parameters guide](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). If it also 401s, the wiring is still wrong; re-check steps 2 through 4.
7. **Turn on `Microsoft.AspNetCore.Authentication` debug logging** or wire `JwtBearerEvents` and read which event fires. That tells you definitively whether the handler ran.

## The one distinction that ends the search

Every "valid token but 401" reduces to a single question: did the bearer handler run and reject the token, or did it never get a chance to run? Validation parameters, `ClockSkew`, issuer and audience mismatches all live on the first branch, and they only matter if `OnAuthenticationFailed` fires. Middleware order, the default scheme, the scheme name, and a missing header all live on the second branch, where there is no validation failure to find because there was nothing to validate. Make the handler emit one log line and you have answered the question; from there the fix is mechanical. When you go to lock the endpoints down, grouping the protected routes with [MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) keeps the scheme requirement in one place instead of scattered across every `[Authorize]`, which is how the scheme-name mismatch sneaks in to begin with.

## Sources

- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn, including the 401 vs 403 breakdown and the default-scheme guidance.
- [Authorize with a specific scheme in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authorization/limitingidentitybyscheme), Microsoft Learn, on `[Authorize(AuthenticationSchemes = ...)]`.
- [RFC 9110, section 15.5.2](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2), which requires the `WWW-Authenticate` header on a 401.
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn.
