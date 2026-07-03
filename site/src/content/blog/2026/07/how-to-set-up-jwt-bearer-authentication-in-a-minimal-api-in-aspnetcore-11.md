---
title: "How to set up JWT bearer authentication in a minimal API in ASP.NET Core 11"
description: "A complete, working setup for JWT bearer authentication in an ASP.NET Core 11 minimal API: install the package, wire up AddAuthentication().AddJwtBearer(), issue a token, protect endpoints with RequireAuthorization, add role and claim policies, and test the whole thing with dotnet user-jwts."
pubDate: 2026-07-03
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "minimal-api"
  - "jwt"
  - "security"
---

To protect a minimal API in ASP.NET Core 11 with JWT bearer tokens you need three moving parts: register the bearer handler with `builder.Services.AddAuthentication().AddJwtBearer()`, tell it what a valid token looks like (issuer, audience, signing key), and mark the endpoints you want to protect with `.RequireAuthorization()`. The `WebApplication` host wires the authentication and authorization middleware for you, so a minimal setup is genuinely a handful of lines. This post walks the full path end to end: the package, the configuration, issuing a token, protecting endpoints, adding role and claim policies, and testing it with `dotnet user-jwts`. It targets .NET 11 (Preview 5 at the time of writing, GA in November 2026) with `Microsoft.AspNetCore.Authentication.JwtBearer` and C# 14, but every step here works unchanged back to .NET 8.

## Install the one package you need

Bearer support is not in the shared framework by default. Add the package:

```bash
# .NET 11 SDK
dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer
```

This pulls in the `JwtBearerHandler`, the `AddJwtBearer` extension methods, and the `Microsoft.IdentityModel` token stack that actually validates the token. You do not need `System.IdentityModel.Tokens.Jwt` separately for validation; the handler uses the faster `JsonWebTokenHandler` internally. You will want a token-creation type when you issue tokens yourself, covered further down.

## The smallest configuration that authenticates and authorizes

Here is a complete `Program.cs` that registers the bearer scheme, exposes one open endpoint, and one protected endpoint:

```csharp
// .NET 11, C# 14
// Microsoft.AspNetCore.Authentication.JwtBearer 11.0.0-preview
using System.Security.Claims;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication()
    .AddJwtBearer(); // reads options from configuration, see below

builder.Services.AddAuthorization();

var app = builder.Build();

app.MapGet("/", () => "public, no token needed");

app.MapGet("/me", (ClaimsPrincipal user) => $"hello {user.Identity!.Name}")
    .RequireAuthorization();

app.Run();
```

Two things are worth calling out because they trip up people coming from the older `Startup.cs` model.

First, there is no `app.UseAuthentication()` or `app.UseAuthorization()` in that file, and it still works. In the minimal hosting model, `WebApplication` inspects the service container at build time and, if it sees the authentication and authorization services registered, it inserts both middleware in the correct order for you. You only need to call `UseAuthentication` and `UseAuthorization` by hand when you must control ordering relative to other middleware, the classic case being CORS, which has to run first. If a browser SPA calls this API cross-origin, read [how to configure CORS for a JWT-protected API](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) before you assume the auth wiring is wrong; a preflight eating the header looks identical to a bad token.

Second, `AddJwtBearer()` with no lambda is not incomplete. It loads its `TokenValidationParameters` from configuration under the `Authentication:Schemes:Bearer` section. That is the modern, config-first pattern, and it is exactly what `dotnet user-jwts` writes for you.

## Where the token rules live: configuration vs code

You can tell the handler what a valid token looks like in two places. Pick one and be consistent.

The **configuration-first** approach keeps issuer and audience out of your code and in `appsettings.json`. The framework looks under `Authentication:Schemes:{SchemeName}`, and the default scheme name for `AddJwtBearer()` is `Bearer`:

```json
{
  "Authentication": {
    "Schemes": {
      "Bearer": {
        "ValidIssuer": "https://my-api.example.com",
        "ValidAudiences": [ "https://localhost:7259" ]
      }
    }
  }
}
```

The **code-first** approach sets the same values in the lambda, which you will reach for when you sign tokens with your own symmetric key:

```csharp
// .NET 11, C# 14
using Microsoft.IdentityModel.Tokens;
using System.Text;

var key = new SymmetricSecurityKey(
    Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)); // >= 32 bytes for HS256

builder.Services.AddAuthentication()
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://my-api.example.com",

            ValidateAudience = true,
            ValidAudience = "https://localhost:7259",

            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,
        };
    });
```

If your tokens come from an external OpenID Connect provider (Entra ID, Auth0, Keycloak, Okta, Duende IdentityServer), you skip the signing key entirely and set `options.Authority`, and the handler discovers the issuer and public signing keys from the provider's `/.well-known/openid-configuration` metadata. The full breakdown of what each `Validate*` flag does, and the five-minute `ClockSkew` trap that makes tokens live longer than their `exp`, is in [how to validate a JWT's issuer, audience, and lifetime](/2026/06/how-to-validate-a-jwts-issuer-audience-and-lifetime-in-aspnetcore-11/). For this setup guide, the key point is that assigning a brand-new `TokenValidationParameters` object replaces the defaults wholesale, so list every flag you care about.

## Set a default scheme, or bare [Authorize] does nothing

`RequireAuthorization()` (and the `[Authorize]` attribute) challenges the *default* authenticate scheme. `AddAuthentication()` with no argument registers services but sets no default. If you leave it that way, a protected endpoint has no scheme to run, the user stays anonymous, and every request 401s even with a perfect token. Naming the scheme fixes it:

```csharp
// .NET 11, C# 14
using Microsoft.AspNetCore.Authentication.JwtBearer;

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer();
```

`JwtBearerDefaults.AuthenticationScheme` is the string `"Bearer"`. Passing it to `AddAuthentication` sets both `DefaultAuthenticateScheme` and `DefaultChallengeScheme` in one call, so a bare `.RequireAuthorization()` now knows to run the bearer handler. When you register a *single* bearer scheme this is the correct default. This "silent 401 with a valid token" family of bugs, missing default scheme, wrong middleware order, mismatched scheme name, is common enough to have its own guide: [why your ASP.NET Core JWT returns 401 even with a valid token](/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/).

## Issue a token from a login endpoint

If your API is its own identity source, you need an endpoint that hands out signed tokens after checking a credential. Use `JsonWebTokenHandler.CreateToken` with a `SecurityTokenDescriptor`:

```csharp
// .NET 11, C# 14
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using System.Security.Claims;
using System.Text;

app.MapPost("/login", (LoginRequest req, IConfiguration config) =>
{
    // Replace with a real credential check against your user store.
    if (req is not { Username: "demo", Password: "demo" })
        return Results.Unauthorized();

    var key = new SymmetricSecurityKey(
        Encoding.UTF8.GetBytes(config["Jwt:Secret"]!));

    var descriptor = new SecurityTokenDescriptor
    {
        Issuer = "https://my-api.example.com",
        Audience = "https://localhost:7259",
        Expires = DateTime.UtcNow.AddMinutes(15),
        SigningCredentials = new SigningCredentials(
            key, SecurityAlgorithms.HmacSha256),
        Subject = new ClaimsIdentity(new[]
        {
            new Claim(ClaimTypes.Name, req.Username),
            new Claim(ClaimTypes.Role, "user"),
        }),
    };

    var token = new JsonWebTokenHandler().CreateToken(descriptor);
    return Results.Ok(new { access_token = token });
});

record LoginRequest(string Username, string Password);
```

The HMAC secret must be at least 256 bits (32 bytes) for `HS256`, or the signing layer throws `IDX10720`. Keep it out of source: use user secrets in development (`dotnet user-secrets set "Jwt:Secret" "<a-long-random-string>"`) and a real secret store in production. This is a self-issued access token with a 15-minute lifetime; when you want the client to stay logged in beyond that without re-entering credentials, pair it with a refresh flow as described in [how to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/).

## Protect endpoints, and read the caller's claims

`.RequireAuthorization()` with no argument means "any authenticated user." Inside the handler, inject `ClaimsPrincipal` to read who the caller is:

```csharp
// .NET 11, C# 14
app.MapGet("/orders", (ClaimsPrincipal user) =>
{
    var name = user.Identity!.Name;               // ClaimTypes.Name
    var isAdmin = user.IsInRole("admin");         // ClaimTypes.Role
    var sub = user.FindFirstValue(ClaimTypes.NameIdentifier);
    return Results.Ok(new { name, isAdmin, sub });
})
.RequireAuthorization();
```

One subtlety about claim names: `JwtBearerOptions.MapInboundClaims` defaults to `true`, which rewrites short JWT claim names like `sub` and `role` into the long WS-* URIs (`ClaimTypes.NameIdentifier`, `ClaimTypes.Role`). If you would rather work with the raw short names, set `options.MapInboundClaims = false` and then point `TokenValidationParameters.NameClaimType` and `RoleClaimType` at whatever your tokens actually carry. This mapping is why `user.Identity.Name` can be null even on a valid token: the token had no claim matching the configured `NameClaimType`.

## Add role and claim policies for finer access

"Any authenticated user" is rarely enough. For anything beyond a blanket gate, define named policies once and attach them by name. `AddAuthorizationBuilder` is the minimal-API-friendly way:

```csharp
// .NET 11, C# 14
builder.Services.AddAuthorizationBuilder()
    .AddPolicy("admin_only", policy =>
        policy.RequireRole("admin"))
    .AddPolicy("can_write_orders", policy =>
        policy
            .RequireRole("admin")
            .RequireClaim("scope", "orders_api"));

// ...

app.MapDelete("/orders/{id}", (int id) => Results.NoContent())
    .RequireAuthorization("admin_only");

app.MapPost("/orders", (object order) => Results.Created())
    .RequireAuthorization("can_write_orders");
```

A policy is a set of requirements the caller must satisfy. `RequireRole` checks the role claim; `RequireClaim("scope", "orders_api")` checks that a `scope` claim with that value is present. A caller who authenticates but fails the policy gets a **403**, not a 401. That distinction matters when you debug: 401 means "we do not know who you are" (authentication), 403 means "we know, and you are not allowed" (authorization). If you are seeing 403, stop looking at the token and look at the policy.

When several endpoints share a policy, do not repeat `.RequireAuthorization("...")` on each one. Group them so the requirement lives in a single place, which also keeps a scheme or policy from silently drifting between routes:

```csharp
// .NET 11, C# 14
var admin = app.MapGroup("/admin").RequireAuthorization("admin_only");
admin.MapGet("/stats", () => "admin stats");
admin.MapDelete("/orders/{id}", (int id) => Results.NoContent());
```

The grouping patterns, including nested groups and per-group filters, are covered in [how to organize minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

## Test it without building a login UI

You do not need a client or a real identity provider to exercise the setup. The `dotnet user-jwts` tool mints a token signed with a key it also wires into your development configuration, so validation cannot fail on a key mismatch:

```bash
# .NET 11 SDK, run in the project directory
dotnet user-jwts create
```

Run against a project, the tool writes the matching validation options (a `ValidIssuer` of `dotnet-user-jwts` plus your app's URLs as `ValidAudiences`) into `appsettings.Development.json`, and prints a ready-to-use token. To mint a token carrying the role and scope your policies require:

```bash
# .NET 11 SDK
dotnet user-jwts create --role "admin" --scope "orders_api"
```

Then send it:

```bash
# {token} is the value dotnet user-jwts printed
curl -i -H "Authorization: Bearer {token}" https://localhost:7259/orders
```

The header format is strict: the literal word `Bearer`, one space, then the raw token, no quotes. If a `user-jwts` token authenticates but your real provider's token does not, the difference is in the token's claims or signing key, not your wiring. If even the `user-jwts` token 401s, the wiring is still wrong, revisit the default scheme and middleware order.

## The setup in seven steps

To recap the whole flow as a checklist:

1. Add the package: `dotnet add package Microsoft.AspNetCore.Authentication.JwtBearer`.
2. Register the scheme and make it the default: `builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme).AddJwtBearer();`.
3. Add authorization: `builder.Services.AddAuthorization();` (or `AddAuthorizationBuilder()` if you define policies).
4. Configure what a valid token looks like, either in the `Authentication:Schemes:Bearer` config section, via `options.Authority` for an OIDC provider, or via `TokenValidationParameters` in code for self-signed tokens.
5. Protect endpoints with `.RequireAuthorization()`, adding a policy name for role or claim requirements.
6. Let `WebApplication` add the middleware automatically, or call `UseAuthentication` then `UseAuthorization` by hand only when ordering (for example CORS) demands it.
7. Test with `dotnet user-jwts create` and a `curl` request carrying the `Authorization: Bearer` header.

That is the entire happy path. The mental model that keeps it straight: authentication decides *who* the caller is by validating the token and populating `HttpContext.User`, and authorization decides *whether* that caller may proceed by evaluating policies. Keep those two jobs separate in your head and almost every JWT problem sorts itself into "the token is wrong" (a validation issue) or "the wiring is wrong" (a scheme, middleware, or policy issue). If you are still deciding whether bearer tokens are even the right choice for your app versus server-side sessions, weigh the trade-offs in [JWT vs cookie authentication in ASP.NET Core 11](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

## Sources

- [Authentication and authorization in Minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/security), Microsoft Learn, for the automatic middleware registration, `AddAuthorizationBuilder`, and `dotnet user-jwts` behavior.
- [Configure JWT bearer authentication in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), Microsoft Learn.
- [Generate tokens with dotnet user-jwts](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/jwt-authn), Microsoft Learn.
- [Microsoft.AspNetCore.Authentication.JwtBearer on NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
- [.NET 11 Preview 5 is now available](https://devblogs.microsoft.com/dotnet/dotnet-11-preview-5/), .NET Blog, for the current preview and November 2026 GA target.
