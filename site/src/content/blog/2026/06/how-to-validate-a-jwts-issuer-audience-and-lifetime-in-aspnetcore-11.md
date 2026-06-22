---
title: "How to validate a JWT's issuer, audience, and lifetime in ASP.NET Core 11"
description: "A complete guide to TokenValidationParameters in ASP.NET Core 11: how ValidateIssuer, ValidateAudience, and ValidateLifetime work, what the defaults actually are, why Authority auto-configures the issuer and signing keys, the 5-minute ClockSkew trap, and how to read the IDX error codes when a valid-looking token is rejected."
pubDate: 2026-06-22
template: how-to
tags:
  - "csharp"
  - "dotnet"
  - "dotnet-11"
  - "aspnetcore"
  - "jwt"
  - "security"
---

The JWT bearer handler in ASP.NET Core does not just check a signature. It runs a series of independent checks driven by `TokenValidationParameters`: the issuer (`iss`), the audience (`aud`), the lifetime (`exp` and `nbf`), and the signing key. The good news is that `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime`, and `ValidateIssuerSigningKey` all default to `true`, so a token is checked properly out of the box. The bad news is that "default to true" without a configured value means the handler still throws, and the most common production bug here is a token that lives five minutes past its `exp` because `ClockSkew` defaults to five minutes. This post targets .NET 11 (preview 5 at the time of writing) with `Microsoft.AspNetCore.Authentication.JwtBearer`, but the validation model is unchanged from .NET 8, 9, and 10.

## What the bearer handler actually validates

When a request arrives with `Authorization: Bearer <token>`, the `JwtBearerHandler` hands the raw token to a token handler (since .NET 8 the default is the faster `JsonWebTokenHandler` from `Microsoft.IdentityModel.JsonWebTokens`, not the older `JwtSecurityTokenHandler`). That handler reads `JwtBearerOptions.TokenValidationParameters` and runs each enabled check in turn. If any check fails, it raises an exception, the handler produces a 401, and the response carries a `WWW-Authenticate: Bearer error="invalid_token"` header with a description.

The four checks that matter for almost every API:

- **Signature** (`ValidateIssuerSigningKey`, on by default): the token's signature is verified against a key. This proves the token was minted by someone holding the private key and has not been tampered with.
- **Issuer** (`ValidateIssuer`, on by default): the `iss` claim must match `ValidIssuer` (or one of `ValidIssuers`). This stops a token from a different identity provider being replayed against your API.
- **Audience** (`ValidateAudience`, on by default): the `aud` claim must match `ValidAudience` (or one of `ValidAudiences`). This stops a token minted for a *different* API on the same issuer from being accepted by yours.
- **Lifetime** (`ValidateLifetime`, on by default): the current time must be at or after `nbf` (not-before) and before `exp` (expiration), within the `ClockSkew` tolerance.

The defaults live in `Microsoft.IdentityModel.Tokens.TokenValidationParameters`, and you can confirm them in the [source](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs): every `Validate*` flag initializes to `true`, and `RequireExpirationTime` and `RequireSignedTokens` are `true` as well. You do not turn validation *on*. You supply the values it validates *against*.

## The fastest correct setup: point at an authority

If your tokens come from an OpenID Connect provider (Entra ID, Auth0, Keycloak, Okta, an IdentityServer/Duende instance), you almost never set the signing key or issuer by hand. You set `Authority`, and the handler discovers everything else from the provider's metadata.

```csharp
// .NET 11, C# 14
// Microsoft.AspNetCore.Authentication.JwtBearer 11.0.0-preview
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        // Discovers issuer + JWKS signing keys from
        // {Authority}/.well-known/openid-configuration
        options.Authority = "https://login.example.com";

        // Maps to TokenValidationParameters.ValidAudience
        options.Audience = "api://my-api";

        // Everything below is already the default, shown for clarity:
        options.TokenValidationParameters.ValidateIssuer = true;
        options.TokenValidationParameters.ValidateAudience = true;
        options.TokenValidationParameters.ValidateLifetime = true;
        options.TokenValidationParameters.ValidateIssuerSigningKey = true;
    });

builder.Services.AddAuthorization();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/me", (ClaimsPrincipal user) => user.Identity!.Name)
    .RequireAuthorization();

app.Run();
```

Two things happen behind the scenes when you set `Authority`:

1. A `ConfigurationManager` fetches `{Authority}/.well-known/openid-configuration` and, from it, the JWKS (JSON Web Key Set) endpoint. The public signing keys returned there become the `IssuerSigningKeys`, and the metadata's `issuer` value becomes the `ValidIssuer`. The manager caches this and refreshes it periodically, so key rotation at the provider is handled without a redeploy.
2. `JwtBearerOptions.Audience` is copied into `TokenValidationParameters.ValidAudience`.

That is why a minimal `Authority` + `Audience` configuration is fully validating: issuer, audience, lifetime, and signature are all covered. If your provider serves only HTTPS metadata (it should), keep `options.RequireHttpsMetadata = true`, which is the default outside of `Development`.

## Validating a token you signed yourself (symmetric key)

If you mint tokens in the same app, for example a small first-party API issuing its own access tokens, there is no OIDC metadata to discover. You supply the issuer, audience, and signing key explicitly.

```csharp
// .NET 11, C# 14
var key = new SymmetricSecurityKey(
    Encoding.UTF8.GetBytes(builder.Configuration["Jwt:Secret"]!)); // >= 32 bytes for HS256

builder.Services.AddAuthentication("Bearer")
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = "https://my-api.example.com",

            ValidateAudience = true,
            ValidAudience = "my-api-clients",

            ValidateLifetime = true,

            ValidateIssuerSigningKey = true,
            IssuerSigningKey = key,

            // Default is 5 minutes. See the next section.
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });
```

Note that assigning a brand-new `TokenValidationParameters` replaces the defaults wholesale, so list every flag you care about. The HMAC secret must be at least 256 bits (32 bytes) for `HS256`, or the signing layer throws `IDX10720` when you create the token.

## The five-minute ClockSkew trap

This is the single most surprising behavior, and it bites people who write a test that expects a token to be rejected the instant it expires.

`TokenValidationParameters.ClockSkew` defaults to **five minutes** (`DefaultClockSkew = TimeSpan.FromMinutes(5)`). It exists to absorb clock drift between the machine that issued the token and the machine validating it: without it, a one-second difference in system clocks could reject every freshly minted token as "not yet valid" or accept-then-reject inconsistently. The cost is that a token with `exp` of 12:00:00 is still accepted until 12:05:00 on the validating server.

For most APIs, five minutes of grace on an access token is harmless and the right default. But if you issue short-lived tokens (say, 60-second access tokens backed by a refresh flow, the pattern described in [how to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/)), the skew dominates the lifetime and the token effectively lives six minutes, not one. Tighten it deliberately:

```csharp
// .NET 11, C# 14
// Strict expiry. Only safe if your servers run NTP-synced clocks.
options.TokenValidationParameters.ClockSkew = TimeSpan.Zero;
```

Set `ClockSkew = TimeSpan.Zero` only when your issuer and API have synchronized clocks (NTP on both, which is normal in any cloud environment). If they can drift, a small non-zero value like 30 seconds is the sane middle ground. Do not "fix" an unexpected token rejection by *raising* skew. A token that is genuinely expired should be rejected; raising skew to hide a clock problem just widens your replay window.

## Why ValidateAudience = true with no audience is a startup-time landmine

A common mistake is leaving `ValidateAudience = true` (the default) while never setting `Audience` / `ValidAudience`. The handler has nothing to compare `aud` against, so it throws on the first request:

```text
IDX10208: Unable to validate audience. The 'audience' is null or whitespace
and validationParameters.ValidAudiences is also null or empty.
```

You have two correct responses, and exactly one wrong one:

- **Correct, and preferred**: set `Audience` (or `ValidAudiences` for several). Audience validation is a real security control. It is what stops a token issued for `api://billing` on your shared Entra tenant from being replayed against `api://reporting`.
- **Correct, only when you genuinely have no audience claim**: set `ValidateAudience = false` *explicitly*, and write a comment explaining why. Some legacy issuers do not stamp `aud`.
- **Wrong**: silencing the exception by catching it, or pointing `ValidAudience` at a value you do not control.

The same shape applies to `ValidateIssuer = true` with no `ValidIssuer` and no `Authority`: you get `IDX10204` ("Unable to validate issuer"). Setting `Authority` populates `ValidIssuer` from metadata, which is why the OIDC path rarely hits this.

## Accepting more than one issuer or audience

During a migration between identity providers, or when one API serves clients minted under several audience names, use the plural collections. They are additive with anything discovered from `Authority`.

```csharp
// .NET 11, C# 14
options.TokenValidationParameters.ValidIssuers = new[]
{
    "https://old-idp.example.com",
    "https://login.example.com",
};
options.TokenValidationParameters.ValidAudiences = new[]
{
    "api://my-api",
    "api://my-api-legacy",
};
```

A token passes if its `iss` matches *any* entry in `ValidIssuers` and its `aud` matches *any* entry in `ValidAudiences`. This lets you run both issuers in parallel during a cutover and remove the old one once traffic has drained, with no window where tokens are rejected.

## Reading the failure: turn on the IDX codes

When a token that looks fine gets a 401, the response body is empty and the `WWW-Authenticate` header is terse. The real reason is in the exception the handler swallowed. Wire up `OnAuthenticationFailed` to surface it while debugging:

```csharp
// .NET 11, C# 14
options.Events = new JwtBearerEvents
{
    OnAuthenticationFailed = context =>
    {
        // Logs the underlying SecurityTokenException, e.g. IDX10223
        context.NoResult();
        var logger = context.HttpContext.RequestServices
            .GetRequiredService<ILogger<Program>>();
        logger.LogWarning(context.Exception, "JWT validation failed");
        return Task.CompletedTask;
    },
};
```

The `Microsoft.IdentityModel` `IDX` codes map directly to the four checks, and knowing them ends most debugging sessions in seconds:

- `IDX10223`: lifetime validation failed, the token is expired. Check `exp` and `ClockSkew`.
- `IDX10205` / `IDX10204`: issuer is invalid or could not be validated. The `iss` claim does not match `ValidIssuer`/`ValidIssuers`, or none was configured.
- `IDX10214` / `IDX10208`: audience is invalid or could not be validated. The `aud` claim does not match, or none was configured.
- `IDX10503` / `IDX10500`: signature validation failed, often a key the API does not have. With `Authority`, this usually means a stale metadata cache or a provider that rotated keys; the `ConfigurationManager` refresh resolves it.

If the token validates but `User.Identity?.Name` is null or your `[Authorize(Roles = ...)]` checks fail, the issue is claim mapping, not validation. `JwtBearerOptions.MapInboundClaims` defaults to `true`, which rewrites short JWT claim names like `sub` and `role` into the long WS-* URIs. Set `options.MapInboundClaims = false` to keep the original short names, then set `TokenValidationParameters.NameClaimType` and `RoleClaimType` to whatever your tokens actually use.

## Putting it together, step by step

1. Choose your trust anchor. For an OIDC provider, set `options.Authority`; the issuer and signing keys come from metadata. For self-signed tokens, set `ValidIssuer` and `IssuerSigningKey` by hand.
2. Set the audience. Assign `options.Audience` (or `ValidAudiences`) so `ValidateAudience = true` has something to check. Do not disable audience validation unless your tokens truly carry no `aud`.
3. Leave `ValidateIssuer`, `ValidateAudience`, `ValidateLifetime`, and `ValidateIssuerSigningKey` at their default `true`. You are configuring values, not switches.
4. Set `ClockSkew` to match your token lifetime. Keep the 5-minute default for normal access tokens; drop to `TimeSpan.Zero` or 30 seconds for short-lived tokens on NTP-synced clocks.
5. For multi-provider or multi-audience scenarios, use the plural `ValidIssuers` / `ValidAudiences` collections during the cutover.
6. Add `JwtBearerEvents.OnAuthenticationFailed` logging in non-production so the `IDX` code tells you which of the four checks failed.
7. Place `app.UseAuthentication()` before `app.UseAuthorization()`, and if a browser SPA calls the API cross-origin, get the middleware order right per [how to configure CORS for a JWT-protected API](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/).

## When validation passes but the request still fails

Once the four checks pass, any remaining failure is no longer a token-validation problem. A 403 (not 401) means the token was valid but an authorization policy or role requirement was not met, which is a separate layer entirely. A request that works in code but fails from a docs UI is usually the tooling dropping the header, covered in [why your bearer token is ignored in Scalar](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) and in [adding OpenAPI authentication flows to Swagger UI](/2026/04/how-to-add-openapi-authentication-flows-to-swagger-ui-dotnet-11/). And if you are wiring auth onto a minimal API, group the protected endpoints so the policy applies in one place, as shown in [organizing minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/).

The mental model that keeps this simple: `TokenValidationParameters` is four independent questions the handler asks of every token. Who signed it? Who issued it? Who is it for? Is it still in date? The defaults make all four mandatory, so your only job is to give each one a correct value, and to remember that "still in date" carries a five-minute cushion until you say otherwise.

Sources: [TokenValidationParameters source - AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet](https://github.com/AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet/blob/dev/src/Microsoft.IdentityModel.Tokens/TokenValidationParameters.cs), [Configure JWT bearer authentication in ASP.NET Core - Microsoft Learn](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/configure-jwt-bearer-authentication), [JwtBearerOptions - Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.authentication.jwtbearer.jwtbeareroptions), [Microsoft.AspNetCore.Authentication.JwtBearer - NuGet](https://www.nuget.org/packages/Microsoft.AspNetCore.Authentication.JwtBearer).
