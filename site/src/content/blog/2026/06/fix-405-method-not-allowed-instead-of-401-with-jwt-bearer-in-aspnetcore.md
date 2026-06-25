---
title: "Fix: 405 Method Not Allowed instead of 401 with JWT bearer in ASP.NET Core"
description: "A protected endpoint returning 405 instead of 401 almost always means routing rejected the HTTP verb before auth ran, or a cookie scheme stole the challenge. Here is how to tell which."
pubDate: 2026-06-25
template: error-page
tags:
  - "errors"
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
---

You added `[Authorize]` (or `RequireAuthorization()`) to an endpoint, sent a request with no token expecting a clean `401 Unauthorized`, and instead got `405 Method Not Allowed`. The 405 is misleading: it almost never means your auth is broken. It means the request never reached the authorization stage at all, because endpoint routing rejected the HTTP verb first and short-circuited with a 405, or, less often, a cookie authentication scheme is the default challenge and it answered instead of the JWT bearer handler. The fix for the common case is to send the verb the endpoint actually maps (`POST` to a `MapPost`, not `GET`); the fix for the scheme case is to set `DefaultChallengeScheme` to the bearer scheme. This post uses .NET 11 with `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.0 and C# 14, but the routing behaviour is identical back to .NET 6.

## The error in context

```text
HTTP/1.1 405 Method Not Allowed
Allow: POST
Content-Length: 0
```

That `Allow` header is the tell. A genuine authentication failure returns:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer
```

If you see `Allow` and no `WWW-Authenticate`, routing produced this response, not the JWT bearer handler. If you see `WWW-Authenticate: Bearer`, the handler ran and you have a real auth problem, which is a different post: [why your JWT returns 401 even with a valid token](/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/) covers that path.

## Why routing wins before authorization runs

ASP.NET Core's pipeline is ordered. In a default minimal-API or controller app it looks like this:

```csharp
// .NET 11, ASP.NET Core 11.0.0
var app = builder.Build();

app.UseRouting();        // 1. selects the endpoint (including method matching)
app.UseAuthentication(); // 2. reads the token, sets HttpContext.User
app.UseAuthorization();  // 3. enforces [Authorize] on the selected endpoint

app.MapControllers();
app.Run();
```

`UseRouting` runs first. Routing matches on the request path *and* the HTTP method. When a path matches a registered route but the method does not, routing does not fall through to "no endpoint." It selects a built-in synthetic endpoint produced by `HttpMethodMatcherPolicy`, whose entire job is to return `405 Method Not Allowed` with an `Allow` header listing the verbs that *are* mapped for that path. See the [routing fundamentals docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing) for how the matcher policies feed endpoint selection.

That synthetic 405 endpoint carries no authorization metadata. So when `UseAuthorization` looks at the selected endpoint, it finds nothing to enforce, lets the request through, and the 405 is written to the response. Your `[Authorize]`-decorated action was never a candidate, because the verb eliminated it during matching. Authorization literally cannot run on an endpoint that routing did not select.

This is why adding `[Authorize]` seems to "cause" the 405: it does not. The 405 was there before you added auth too, you just were not looking, because without `[Authorize]` a `GET` to a `POST`-only endpoint also returns 405. Adding `[Authorize]` changes your *expectation* to 401, which exposes the verb mismatch you already had.

## Minimal repro

```csharp
// .NET 11, C# 14, ASP.NET Core 11.0.0
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(); // appsettings supplies Authority/Audience

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

// Only POST is mapped for /orders
app.MapPost("/orders", () => Results.Ok())
   .RequireAuthorization();

app.Run();
```

Now call it with the wrong verb and no token:

```bash
curl -i http://localhost:5000/orders        # implicit GET
# HTTP/1.1 405 Method Not Allowed
# Allow: POST
```

There is a `POST /orders` endpoint, so the path matches, but `GET` is not allowed, so routing returns 405. You expected 401 because you forgot the endpoint only takes `POST`. Send the right verb and the 401 you wanted appears:

```bash
curl -i -X POST http://localhost:5000/orders
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer
```

## Fix 1: send the verb the endpoint maps (the usual cause)

Nine times out of ten the bug is on the caller. The front-end, Postman collection, or integration test is using a verb the route does not map. Check, in order:

1. **The HTTP method in the request.** A `fetch` defaulting to `GET` against a `MapPost`, a form posting where the API expects `PUT`, or a client hitting `/api/orders` with `GET` when the read endpoint is actually `/api/orders/{id}`. The `Allow` header tells you exactly which verbs the path supports, so read it.
2. **The verb attribute on the action.** In controllers, an action with `[Route("orders")]` but no `[HttpPost]` does not respond to every verb in the way you might assume under attribute routing. Pin the verb explicitly with `[HttpPost("orders")]` so a `GET` to the same path produces a deliberate 405, not a surprise.
3. **Route templates that collide.** Two endpoints on the same path with different verbs are fine. But a `MapGet("/orders/{id}")` and a `MapPost("/orders")` are different paths; a `POST /orders/5` matches neither cleanly and you can get a 405 or 404 depending on the template. Use `MapGroup` to keep a prefix's verbs visible in one place: [organizing minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) shows the pattern.

If you want a protected resource to answer 401 for *every* verb a client might try, including unmapped ones, you have to map a catch-all. That is rarely what you want, but it is possible with `MapMethods` covering the verbs you care about plus a fallback.

## Fix 2: stop a cookie scheme from answering the challenge

The second cause shows up when you combine ASP.NET Core Identity (which registers cookie authentication) with JWT bearer and never set an explicit default. As documented in this [Microsoft Q&A thread](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u), the challenge then runs through the Identity cookie handler instead of the bearer handler. The cookie handler's challenge is a redirect to a login page, and when that login route does not accept the verb of the original request, you land on a 405 instead of the bearer's 401.

The fix is to be explicit about which scheme authenticates and which scheme challenges:

```csharp
// .NET 11, C# 14
builder.Services.AddAuthentication(options =>
{
    options.DefaultAuthenticateScheme = JwtBearerDefaults.AuthenticationScheme;
    options.DefaultChallengeScheme = JwtBearerDefaults.AuthenticationScheme;
})
.AddJwtBearer(options =>
{
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuer = true,
        ValidateAudience = true,
        ValidateLifetime = true,
        ValidateIssuerSigningKey = true,
        ValidIssuer = builder.Configuration["Jwt:Issuer"],
        ValidAudience = builder.Configuration["Jwt:Audience"],
        IssuerSigningKey = new SymmetricSecurityKey(
            Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Key"]!))
    };
});
```

With `DefaultChallengeScheme` set to the bearer scheme, an unauthenticated request gets `401 Unauthorized` with `WWW-Authenticate: Bearer`, not a cookie redirect that degrades into a 405. If you legitimately have both schemes and some endpoints should use bearer specifically, name the scheme on the attribute instead of relying on the default: `[Authorize(AuthenticationSchemes = JwtBearerDefaults.AuthenticationScheme)]`. The same scheme-mismatch trap is the root cause behind a lot of [valid tokens that still 401](/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/), so it is worth getting the defaults right once.

## Confirming which cause you have with logs

You do not have to guess. Turn up logging for routing and authorization and the response source becomes obvious:

```json
// appsettings.Development.json - .NET 11
{
  "Logging": {
    "LogLevel": {
      "Microsoft.AspNetCore.Routing": "Debug",
      "Microsoft.AspNetCore.Authentication": "Debug",
      "Microsoft.AspNetCore.Authorization": "Debug"
    }
  }
}
```

If the verb is wrong, you will see routing select the method-not-allowed endpoint and *no* authentication log lines, because the handler never ran:

```text
dbug: Microsoft.AspNetCore.Routing.Matching.DfaMatcher
      Endpoint selection: 405 HTTP Method Not Supported
```

If a cookie scheme is challenging, you will see the cookie handler named explicitly:

```text
dbug: Microsoft.AspNetCore.Authentication.Cookies.CookieAuthenticationHandler
      AuthenticationScheme: Identity.Application was challenged.
```

That single line tells you the bearer handler is not your default challenge scheme, which points straight at Fix 2.

## Gotchas and lookalikes

**CORS preflight returns 405.** A browser sends an `OPTIONS` preflight before a cross-origin `POST` or `PUT`. If you never called `app.UseCors(...)` with a policy that allows the method, routing has no `OPTIONS` endpoint for the path and answers 405, which the browser surfaces as a CORS failure. The fix is configuring CORS, not auth: [configuring CORS for a JWT-protected API](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) walks the policy and middleware order. Note the preflight `OPTIONS` is intentionally unauthenticated; do not put `[Authorize]` in front of it.

**HEAD requests to a GET-only endpoint.** `MapGet` does not automatically answer `HEAD`. A health check or CDN probing with `HEAD` against a `MapGet` route gets 405. Map both verbs with `app.MapMethods("/health", new[] { "GET", "HEAD" }, handler)` per the [route handlers docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers). This is a verb mismatch, not an auth issue.

**403 is not 405.** If you authenticated successfully but lack a required role or policy claim, you get `403 Forbidden`, not 405 and not 401. A 403 means the token validated and the handler ran; your problem is a policy or role check, covered when you [validate a JWT's issuer, audience, and lifetime](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/) and the claims it carries.

**A custom middleware short-circuiting before routing.** If you wrote middleware that runs before `UseRouting` and writes a 405 (for example a hand-rolled method allowlist), it will mask everything downstream. Anything that calls `context.Response.StatusCode = 405` ahead of routing produces this symptom with no `Allow` header from the matcher.

The throughline: 405 is a *routing* status in ASP.NET Core, decided before authentication and authorization ever look at the request. When you expected 401 and got 405, start at the verb and the `Allow` header, not at your token. Reserve the auth debugging for the case where you actually see `WWW-Authenticate: Bearer`.

## Related

- [Why your ASP.NET Core JWT returns 401 even with a valid token](/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/)
- [How to validate a JWT's issuer, audience, and lifetime in ASP.NET Core 11](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/)
- [How to configure CORS for a JWT-protected API in ASP.NET Core 11](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/)
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to validate request bodies in minimal APIs without controllers in ASP.NET Core 11](/2026/06/how-to-validate-request-bodies-in-minimal-apis-without-controllers-in-aspnetcore-11/)

## Sources

- [ASP.NET Core routing fundamentals](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/routing) - endpoint matching and method matcher policies
- [Route handlers in minimal API apps](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers) - `MapMethods`, HEAD and OPTIONS
- [Microsoft Q&A: 405 Method Not Allowed instead of 401 with JWT](https://learn.microsoft.com/en-us/answers/questions/2136683/issue-with-405-method-not-allowed-instead-of-401-u) - the cookie default-scheme cause and fix
- [RFC 9110, section 15.5.6 (405 Method Not Allowed)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.6) and [15.5.2 (401 Unauthorized)](https://datatracker.ietf.org/doc/html/rfc9110#section-15.5.2)
