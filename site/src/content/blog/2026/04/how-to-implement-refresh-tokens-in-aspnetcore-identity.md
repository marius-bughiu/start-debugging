---
title: "How to implement refresh tokens in ASP.NET Core Identity"
description: "Two working paths in .NET 11: the built-in MapIdentityApi /refresh endpoint, and a custom JWT setup with refresh token rotation, family tracking, and reuse detection."
pubDate: 2026-04-28
tags:
  - "aspnetcore"
  - "identity"
  - "authentication"
  - "jwt"
  - "dotnet-11"
template: how-to
---

If you are on .NET 8 or later and the built-in opaque bearer tokens are good enough, call `app.MapIdentityApi<TUser>()` and POST to `/refresh` with the `refreshToken` from the login response. You get a new access token plus a new refresh token, the old refresh token is invalidated, and the security stamp is re-validated against the user store. If you need real JWTs, configurable lifetimes, multi-device revocation, or reuse detection, the built-in endpoints will not get you there. You roll your own: short-lived JWT + a server-side refresh token row, hashed at rest, rotated on every exchange, with a family id so a replay revokes the entire session chain.

This post covers both paths, when each is correct, and the gotchas that tend to bite people in production. Versions referenced: .NET 11 GA, ASP.NET Core 11, EF Core 11, `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0, and `Microsoft.AspNetCore.Authentication.JwtBearer` 11.0.

## What ASP.NET Core Identity actually ships in 2026

The single most important thing to internalise: **classic ASP.NET Core Identity (the cookie based UI) has never had refresh tokens**. It uses a session cookie. Refresh tokens only enter the picture when you authenticate via a bearer token, and Identity got first-party bearer support in .NET 8 via `AddIdentityApiEndpoints` and `MapIdentityApi`. That story is largely unchanged in .NET 11 - the API surface is stable, with small bug fixes and the security-stamp re-validation tightened up.

The Identity API endpoints register a custom bearer scheme (`IdentityConstants.BearerScheme`) backed by `BearerTokenHandler`. The "access token" it returns is **not** a JWT. It is an `AuthenticationTicket` serialised and protected by ASP.NET Data Protection. The client treats it as opaque. Same for the refresh token: opaque, data-protected blob with an `ExpiresUtc` baked in.

```csharp
// Program.cs, .NET 11
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o =>
    o.UseSqlServer(builder.Configuration.GetConnectionString("Default")));

builder.Services
    .AddIdentityApiEndpoints<IdentityUser>()
    .AddEntityFrameworkStores<AppDbContext>();

builder.Services.AddAuthorization();

var app = builder.Build();
app.MapIdentityApi<IdentityUser>();
app.MapGet("/me", (ClaimsPrincipal u) => u.Identity!.Name).RequireAuthorization();
app.Run();
```

That single `MapIdentityApi<IdentityUser>()` call wires up `/register`, `/login`, `/refresh`, `/confirmEmail`, `/resendConfirmationEmail`, `/forgotPassword`, `/resetPassword`, `/manage/2fa`, `/manage/info`. The `/login` endpoint returns:

```json
{
  "tokenType": "Bearer",
  "accessToken": "CfDJ8...redacted...",
  "expiresIn": 3600,
  "refreshToken": "CfDJ8...redacted..."
}
```

To refresh, POST `{ "refreshToken": "..." }` to `/refresh`. The handler unprotects the ticket, checks `ExpiresUtc` against `TimeProvider.GetUtcNow()`, calls `signInManager.ValidateSecurityStampAsync` so a password change forces a re-login, rebuilds the principal via `CreateUserPrincipalAsync(user)`, and returns a fresh access + refresh pair via `TypedResults.SignIn`. If anything fails it returns `401 Unauthorized`. The exact code lives in [IdentityApiEndpointRouteBuilderExtensions.cs](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs).

## When MapIdentityApi is enough, and when it is not

The built-in flow is fine for a first-party SPA or mobile client where you control the API and the storage layer, the tokens are opaque to anyone but your server, and you do not need to inspect them as JWTs. It is **not** fine if any of the following apply:

- You need to share a token across multiple resource servers that validate by signature, not by data-protection key.
- You want JWTs that downstream services or gateways can introspect.
- You need to revoke individual sessions ("log me out of this iPad") without nuking the user's security stamp and signing every device out at once.
- You need server-side visibility into which refresh tokens are alive: who, when, from which IP, when was it last rotated.
- You need refresh token rotation with reuse detection.

The data-protection refresh ticket is opaque to you. There is no row in your database for it. Once issued, the only way to invalidate it before its `ExpiresUtc` is to bump the user's security stamp via `UserManager.UpdateSecurityStampAsync`, which signs them out of every device. That alone disqualifies the built-in path for most multi-device apps. The dotnet/aspnetcore team has acknowledged this in [issue #50009](https://github.com/dotnet/aspnetcore/issues/50009) and [#55792](https://github.com/dotnet/aspnetcore/issues/55792); finer-grained extensibility is a long-standing ask.

## A production-shaped custom flow with JWT and rotated refresh tokens

The pattern below is what most production .NET 11 codebases land on. The user authenticates with username + password against `UserManager`. On success you mint a short-lived JWT (typical: 5 to 15 minutes) plus a long-lived refresh token (7 to 30 days). The refresh token is stored server-side in a dedicated table and **only the SHA-256 hash is persisted**. On refresh you find the row by hash, mark it consumed, and issue a new pair.

### The schema

```csharp
// .NET 11, EF Core 11
public class RefreshToken
{
    public Guid Id { get; set; }
    public string UserId { get; set; } = default!;
    public string TokenHash { get; set; } = default!; // SHA-256 of opaque token
    public Guid FamilyId { get; set; }                // shared across one chain
    public DateTime CreatedUtc { get; set; }
    public DateTime ExpiresUtc { get; set; }
    public DateTime? ConsumedUtc { get; set; }        // set when rotated
    public DateTime? RevokedUtc { get; set; }
    public Guid? ReplacedByTokenId { get; set; }
    public string? CreatedByIp { get; set; }
}
```

`FamilyId` is the key idea. Every refresh token issued from the same login is linked into one family. When you rotate the chain, the new token inherits the parent's `FamilyId`. If anyone ever presents a refresh token whose row is already `ConsumedUtc != null`, that is reuse, almost always theft, and the only safe response is to revoke the entire family (every row with the same `FamilyId`).

Index aggressively: `(UserId, ExpiresUtc)` for cleanup, and a unique index on `TokenHash`. Hash, not encrypt: even if your DB leaks, an attacker cannot present the raw token.

### Issuing the pair

```csharp
// .NET 11, C# 14
public sealed class TokenService(
    IOptions<JwtOptions> jwtOptions,
    AppDbContext db,
    TimeProvider time)
{
    public async Task<TokenPair> IssueAsync(IdentityUser user, Guid? existingFamily, string? ip, CancellationToken ct)
    {
        var now = time.GetUtcNow().UtcDateTime;
        var jwt = BuildJwt(user, now);
        var raw = GenerateRefreshToken();
        var family = existingFamily ?? Guid.NewGuid();

        db.RefreshTokens.Add(new RefreshToken
        {
            Id = Guid.NewGuid(),
            UserId = user.Id,
            TokenHash = Sha256(raw),
            FamilyId = family,
            CreatedUtc = now,
            ExpiresUtc = now.AddDays(jwtOptions.Value.RefreshDays),
            CreatedByIp = ip,
        });
        await db.SaveChangesAsync(ct);

        return new TokenPair(jwt, raw, jwtOptions.Value.AccessMinutes * 60);
    }

    private static string GenerateRefreshToken()
    {
        Span<byte> bytes = stackalloc byte[64]; // 512 bits, well above guidance floor
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToBase64String(bytes);
    }

    private static string Sha256(string raw)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(Encoding.UTF8.GetBytes(raw), hash);
        return Convert.ToHexString(hash);
    }

    private string BuildJwt(IdentityUser user, DateTime now)
    {
        var opts = jwtOptions.Value;
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            new("name", user.UserName ?? string.Empty),
            new("stamp", user.SecurityStamp ?? string.Empty),
        };

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(opts.SigningKey));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(
            issuer: opts.Issuer,
            audience: opts.Audience,
            claims: claims,
            notBefore: now,
            expires: now.AddMinutes(opts.AccessMinutes),
            signingCredentials: creds);
        return new JwtSecurityTokenHandler().WriteToken(token);
    }
}

public record TokenPair(string AccessToken, string RefreshToken, int ExpiresInSeconds);
```

`RandomNumberGenerator.Fill` over `Guid.NewGuid().ToString()` is non-negotiable. Guids are 122 bits of randomness, leak ordering hints on some platforms, and were never designed to be unguessable. 64 bytes from the OS CSPRNG is the floor.

The `stamp` claim is a defensive copy of the user's `SecurityStamp`. You will check it on every refresh: if the persisted stamp no longer matches, the user changed their password or was force-logged-out, and you reject the refresh.

### The /refresh endpoint with reuse detection

```csharp
// .NET 11, ASP.NET Core 11
app.MapPost("/auth/refresh", async (
    RefreshRequest request,
    AppDbContext db,
    UserManager<IdentityUser> users,
    TokenService tokens,
    TimeProvider time,
    HttpContext http,
    CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(request.RefreshToken))
        return Results.Unauthorized();

    var hash = Sha256(request.RefreshToken);
    var existing = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash, ct);
    if (existing is null)
        return Results.Unauthorized();

    var now = time.GetUtcNow().UtcDateTime;

    // Reuse detection: a consumed token presented again means theft.
    if (existing.ConsumedUtc is not null || existing.RevokedUtc is not null)
    {
        await db.RefreshTokens
            .Where(t => t.FamilyId == existing.FamilyId && t.RevokedUtc == null)
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.RevokedUtc, now), ct);
        return Results.Unauthorized();
    }

    if (existing.ExpiresUtc <= now)
        return Results.Unauthorized();

    var user = await users.FindByIdAsync(existing.UserId);
    if (user is null) return Results.Unauthorized();

    var pair = await tokens.IssueAsync(user, existing.FamilyId, http.Connection.RemoteIpAddress?.ToString(), ct);

    existing.ConsumedUtc = now;
    existing.ReplacedByTokenId = await db.RefreshTokens
        .Where(t => t.UserId == user.Id && t.CreatedUtc == now)
        .Select(t => (Guid?)t.Id).FirstAsync(ct);
    await db.SaveChangesAsync(ct);

    return Results.Ok(pair);
});

public record RefreshRequest(string RefreshToken);
```

Walk through the failure cases. Token not in DB: 401, no signal to the caller about why. Token already consumed: 401 plus a family-wide revoke, because either the original was stolen or the legitimate client retried and lost the response. Either way, force the user to re-authenticate. Token expired: 401, no revoke needed. User missing: 401.

The `ExecuteUpdateAsync` on the family is a single SQL UPDATE in EF Core 11 - it does not load the rows into memory or run change tracking. That matters because in a contested race you want the revoke to be cheap and atomic.

### JWT validation on the API side

```csharp
// .NET 11
builder.Services
    .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(o =>
    {
        var jwt = builder.Configuration.GetSection("Jwt").Get<JwtOptions>()!;
        o.TokenValidationParameters = new TokenValidationParameters
        {
            ValidIssuer = jwt.Issuer,
            ValidAudience = jwt.Audience,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwt.SigningKey)),
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ClockSkew = TimeSpan.FromSeconds(30),
        };
    });
```

Default `ClockSkew` is five minutes, which means a "five minute" access token is in practice valid for ten. Pin it down to thirty seconds unless you have a good reason. The pattern of hitting your refresh endpoint with a still-valid-looking access token because of skew is a real source of subtle replay windows.

## Where to store the refresh token on the client

Three options, in decreasing order of how much I trust them.

**HttpOnly, Secure, SameSite=Strict cookie set by the server.** Best default for browser SPAs. JavaScript cannot read it, so XSS cannot exfiltrate. CSRF only matters on the refresh endpoint, and you mitigate that with `SameSite=Strict` plus an explicit anti-forgery header. Return the access token in the JSON body for the SPA to keep in memory; never persist it.

**Native secure storage on mobile.** iOS Keychain, Android Keystore, accessed through MAUI's `SecureStorage`. The OS guards the secret behind device unlock.

**LocalStorage / sessionStorage.** Easy and wrong. Any XSS lifts both tokens.

Returning the refresh token in the JSON body, as `MapIdentityApi` does, is a defensible choice when the client is a native app or your SPA is hardened with a strict CSP. It is the wrong choice if you have any third-party scripts on the page.

## The gotchas that bite people

**Race conditions on rotation.** A spotty mobile network often retries the refresh call. Without idempotency, the second call lands on a now-consumed token and you revoke the family. Two fixes work in practice: a short grace window (accept a `ConsumedUtc` token if `ConsumedUtc + 30s > now` and the same client fingerprint is presenting it), or making the refresh response cacheable client-side for a few seconds keyed by the request token. Most teams take the grace window.

**Background refresh storms.** A SPA with several open tabs all notice the access token is about to expire and all hit `/refresh` at the same time with the same refresh token. Same race, same fix. A `BroadcastChannel`-based leader election in the browser is the cleanest answer when you control the SPA.

**Forgetting to clean up.** A cron or `IHostedService` should run nightly: `db.RefreshTokens.Where(t => t.ExpiresUtc < cutoff || t.ConsumedUtc < cutoff).ExecuteDeleteAsync()`. Without it the table grows linearly with active users. EF Core 11's `ExecuteDeleteAsync` makes this a single statement.

**Mixing the two flows.** If you call `MapIdentityApi` and also implement your own `/auth/refresh`, you now have two incompatible bearer schemes and `[Authorize]` will resolve to whichever is the default. Pick one. If you adopt the custom flow, do not register `AddIdentityApiEndpoints`; use `AddIdentity` (cookie-less variant) plus `AddJwtBearer`.

**Security stamp drift.** If you embed `SecurityStamp` in the JWT, you must re-check it on refresh against the current value in the DB. Otherwise a password reset does not actually invalidate live access tokens until they expire, which can be 15 minutes of unauthorised access. The built-in `MapIdentityApi` does this for you via the bearer handler; the custom flow does not unless you write it.

**Rate limit `/auth/refresh`.** It is a public endpoint that takes a guessable shape and does a DB lookup per call. ASP.NET Core 11's [per-endpoint rate limiter](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) makes this a one-liner. A token-bucket of 10 per minute per IP is generous and stops the dumb attacks.

## Related

- [How to unit-test code that uses HttpClient](/2026/04/how-to-unit-test-code-that-uses-httpclient/) covers testing the client side of a token-aware `DelegatingHandler`, which is exactly where refresh logic lives in most consumers.
- [How to add a global exception filter in ASP.NET Core 11](/2026/04/how-to-add-a-global-exception-filter-in-aspnetcore-11/) is a clean place to translate `SecurityTokenExpiredException` into a 401 with a hint to refresh.
- [How to mock DbContext without breaking change tracking](/2026/04/how-to-mock-dbcontext-without-breaking-change-tracking/) matters here because the rotation logic is the single place you most want a real EF Core integration test.
- [Scalar in ASP.NET Core: why your bearer token is ignored on .NET 10](/2026/01/scalar-in-asp-net-core-why-your-bearer-token-is-ignored-net-10/) is the rabbit hole most people fall into the first time the new flow does not behave like Swashbuckle.

## Sources

- [IdentityApiEndpointRouteBuilderExtensions.cs in dotnet/aspnetcore](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs) - the actual `/refresh` implementation.
- [Use Identity to secure a Web API backend for SPAs (MS Learn)](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization).
- [dotnet/aspnetcore #50009: MapIdentityApi HTTP endpoints](https://github.com/dotnet/aspnetcore/issues/50009) and [#55792: split MapIdentityApi into multiple APIs](https://github.com/dotnet/aspnetcore/issues/55792) for the long-standing extensibility gaps.
- [Andrew Lock: introducing the Identity API endpoints](https://andrewlock.net/exploring-the-dotnet-8-preview-introducing-the-identity-api-endpoints/) for the design rationale.
- [OWASP cheat sheet on JSON Web Tokens](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html) for the storage and rotation guidance.
