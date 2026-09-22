---
title: "How to disable antiforgery validation for a single minimal API form endpoint in ASP.NET Core 11"
description: "Call .DisableAntiforgery() on the one endpoint, or on a MapGroup. In ASP.NET Core 11 that opts out of both the token middleware and the new automatic CSRF check. Measured matrix, precedence traps, and narrower alternatives."
pubDate: 2026-09-22
template: how-to
tags:
  - "aspnetcore"
  - "dotnet-11"
  - "minimal-apis"
  - "security"
  - "csrf"
---

**Short answer:** chain `.DisableAntiforgery()` onto the one `MapPost` call (or onto a `MapGroup` that holds only machine-to-machine endpoints). In ASP.NET Core 11 that single call opts the endpoint out of **both** layers that can reject a form post: the token-based `UseAntiforgery()` middleware and the new automatic cross-origin CSRF check that `WebApplication` injects for you. `[RequireAntiforgeryToken(false)]` on the handler does the same thing. Do not reach for the app-wide `DisableCsrfProtection` switch to fix one endpoint: on an app that never calls `UseAntiforgery()`, it turns every other form endpoint into a `500`.

Everything below was measured on the .NET 11 RC 1 SDK (`11.0.100-rc.1.26425.128`, ASP.NET Core `11.0.0-rc.1`), with a .NET 10.0.10 run for comparison. The request matrix, the precedence traps, and the narrower alternatives are the part the docs leave you to discover.

## Why a form endpoint rejects requests you did not expect

Since .NET 8, any minimal API handler with a form-bound parameter (`[FromForm]`, `IFormFile`, `IFormCollection`) gets antiforgery metadata added to it automatically. You can see it in `RequestDelegateFactory.InferAntiforgeryMetadata`: when the factory binds a parameter from the form, it adds an `IAntiforgeryMetadata` with `RequiresValidation = true` to the endpoint. You never wrote an attribute; the parameter type did it for you.

What reads that metadata changed in .NET 11.

- **.NET 8 to 10**: only `app.UseAntiforgery()` acts on it. If you never called it, the endpoint middleware throws `InvalidOperationException: Endpoint HTTP: POST /protected contains anti-forgery metadata, but a middleware was not found that supports anti-forgery.` and every request is a `500`. If you did call it, every post without a valid token (and its cookie) is a `400`.
- **.NET 11**: `WebApplication` also auto-injects a `CsrfProtectionMiddleware` after routing (added in Preview 6, see [ASP.NET Core 11 turning on automatic CSRF protection](/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)). It reads the same metadata, checks `Sec-Fetch-Site` and `Origin`, and records a verdict on `IAntiforgeryValidationFeature`. The form binder then enforces that verdict with a `400`.

So in .NET 11 there are two ways a form post can be rejected, and they fail for different clients. The token middleware rejects anything without a token, including curl and your payment provider's servers. The CSRF check lets non-browser clients through but rejects cross-origin browser posts: the classic case being a third-party page that posts an HTML form back to you (a hosted payment page, a SAML-style callback, a partner's "submit to" form).

## What each client actually gets

I built one probe app with five endpoints and hit each with four request shapes, in four pipeline configurations. "plain" is curl with no browser headers, "cross-site" sends `Sec-Fetch-Site: cross-site` plus a foreign `Origin`, "same-origin" sends `Sec-Fetch-Site: same-origin`, and "foreign Origin only" mimics an old browser that sends `Origin` but no Fetch Metadata.

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
app.MapPost("/protected", ([FromForm] string name) => $"hello {name}");

app.MapPost("/disabled", ([FromForm] string name) => $"hello {name}")
   .DisableAntiforgery();

app.MapPost("/attr",
    [RequireAntiforgeryToken(false)] ([FromForm] string name) => $"hello {name}");

var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => $"hello {name}");

app.MapPost("/manual", async (HttpRequest req) =>
    $"hello {(await req.ReadFormAsync())["name"]}");
```

Default .NET 11 pipeline (no `AddAntiforgery`, no `UseAntiforgery`), Production environment:

| Endpoint | plain | cross-site | same-origin | foreign Origin only |
|---|---|---|---|---|
| `/protected` | 200 | **400** | 200 | **400** |
| `/disabled` | 200 | 200 | 200 | 200 |
| `/attr` | 200 | 200 | 200 | 200 |
| `/hooks/payments` | 200 | 200 | 200 | 200 |
| `/manual` | 200 | 200 | 200 | 200 |

With `builder.Services.AddAntiforgery()` and `app.UseAntiforgery()` (what Blazor and MVC apps upgraded from .NET 8-10 usually have):

| Endpoint | plain | cross-site | same-origin | foreign Origin only |
|---|---|---|---|---|
| `/protected` | **400** | **400** | **400** | **400** |
| `/disabled`, `/attr`, `/hooks/payments` | 200 | 200 | 200 | 200 |

With `DisableCsrfProtection=true` and no `UseAntiforgery()`: `/protected` is a **500** for every request, exactly like .NET 10.0.10 without `UseAntiforgery()`, which I also measured. The opted-out endpoints stay at 200.

The server logs tell you which layer said no. The CSRF layer logs `Cross-origin CSRF protection marked request POST /protected from origin 'https://evil.example' as invalid.` at `Debug` under `Microsoft.AspNetCore.Antiforgery.CsrfProtectionMiddleware`, and the binder then logs `Antiforgery validation failed when reading parameter "string name" from the request body as form.` with an inner `CsrfValidationException`. The token layer produces the same binder message with an inner `AntiforgeryValidationException: The required antiforgery cookie ".AspNetCore.Antiforgery.<suffix>" is not present.` In Production the response body is empty, so turn on `Debug` for `Microsoft.AspNetCore.Http.RequestDelegateFactory` and `Microsoft.AspNetCore.Antiforgery` when you are chasing a mystery `400`.

## Disable it on one endpoint, step by step

1. Confirm the endpoint really is not a browser-cookie endpoint. The only safe candidates are callers that authenticate some other way: an HMAC-signed webhook, an API key, a bearer token, mTLS. If a logged-in user's browser can post to it and the handler acts on their cookie identity, keep the protection.
2. Chain `.DisableAntiforgery()` onto that `MapPost`. It is an extension on any `IEndpointConventionBuilder` in `Microsoft.AspNetCore.Builder`, so no extra `using` is needed in a web project.
3. Replace the protection you just removed with the caller's own proof. For a form-encoded webhook that is a signature check over the raw body, done in middleware so it runs before anything binds the form.
4. Re-test with the cross-site request shape above (`-H 'Sec-Fetch-Site: cross-site' -H 'Origin: https://other.example'`) and with plain curl, so you know both layers are out of the way.

Here is the whole thing for a provider that posts `application/x-www-form-urlencoded` and signs the raw body with HMAC-SHA256:

```csharp
// .NET 11 RC 1, ASP.NET Core 11.0.0-rc.1
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var secret = Encoding.UTF8.GetBytes(app.Configuration["Sms:WebhookSecret"]!);

// Verify the signature over the raw body before anything binds the form.
app.UseWhen(ctx => ctx.Request.Path.StartsWithSegments("/webhooks/sms"), branch =>
    branch.Use(async (ctx, next) =>
    {
        ctx.Request.EnableBuffering();
        using var ms = new MemoryStream();
        await ctx.Request.Body.CopyToAsync(ms);
        ctx.Request.Body.Position = 0;

        var expected = Convert.ToHexStringLower(HMACSHA256.HashData(secret, ms.ToArray()));
        var actual = ctx.Request.Headers["X-Signature"].ToString();

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(expected), Encoding.ASCII.GetBytes(actual)))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return;
        }

        await next(ctx);
    }));

app.MapPost("/webhooks/sms", ([FromForm] SmsStatus status) =>
        Results.Ok($"{status.MessageId}: {status.Status}"))
   .DisableAntiforgery();

app.Run();

record SmsStatus(string MessageId, string Status);
```

Measured: a correctly signed post returned 200 both as plain curl and with the cross-site browser headers, and a wrong signature returned 401.

My first draft put that check in an endpoint filter instead, and it failed every signed request. By the time an endpoint filter runs, the `[FromForm]` parameter has already been bound, the form reader has drained the request stream, and `EnableBuffering` at that point has nothing left to buffer: the filter hashed **0 bytes**. Raw-body signature checks belong in middleware, which is one of the concrete cases in [endpoint filters vs middleware](/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/). An endpoint filter is fine for header-only checks such as an API key.

## The attribute form, for handlers you keep in methods

If your handlers are static methods rather than lambdas, the attribute reads better and survives refactors that move the mapping:

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Mvc;

app.MapPost("/webhooks/payments", PaymentHooks.Handle);

static class PaymentHooks
{
    [RequireAntiforgeryToken(false)]
    public static IResult Handle([FromForm] string eventId) => Results.Ok(eventId);
}
```

`RequireAntiforgeryTokenAttribute` implements `IAntiforgeryMetadata` directly, and both middlewares ask the endpoint for `GetMetadata<IAntiforgeryMetadata>()`, so the result is identical to `.DisableAntiforgery()`. For MVC controllers the equivalent is `[IgnoreAntiforgeryToken]`; the `AntiforgeryMiddlewareAuthorizationFilter` in .NET 11 honours the verdict from either middleware.

## Disable it for a group of webhooks

When you have several provider callbacks, put them under one prefix and opt the group out once:

```csharp
// .NET 11 RC 1
var hooks = app.MapGroup("/hooks").DisableAntiforgery();
hooks.MapPost("/payments", ([FromForm] string name) => Results.Ok());
hooks.MapPost("/sms", ([FromForm] string name) => Results.Ok());
```

This keeps the security decision in one visible place instead of scattered across files, which is the main argument for [organizing minimal API endpoints with MapGroup](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/) in the first place.

## Precedence traps I hit in the probe

**A group opt-out beats an endpoint opt-in.** I expected this to re-enable protection for one endpoint inside the disabled group:

```csharp
// .NET 11 RC 1: does NOT re-enable validation
hooks.MapPost("/strict", ([FromForm] string name) => $"hello {name}")
     .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

It does not. `/hooks/strict` returned 200 for the cross-site request in both pipeline modes. The reason is in `DisableAntiforgery` itself: it registers its metadata with `builder.Finally(...)`, which runs after the endpoint's own conventions, and `GetMetadata<T>()` returns the last matching item. The group's "not required" lands last and wins. If one endpoint in a prefix must stay protected, do not disable at the group level; disable per endpoint instead, or split the prefix into two groups.

**The same `Finally` ordering is why `.DisableAntiforgery()` always wins over the inferred metadata.** The form binder adds `RequiresValidation = true` while building the endpoint; the `Finally` callback adds `false` after it. You do not need to worry about the order in which you chain calls.

**Handlers that read the form by hand get no protection at all.** The `/manual` endpoint above reads `req.ReadFormAsync()` without a form-bound parameter, so no metadata is inferred and neither middleware looks at it: cross-site posts got a 200 in every mode. If you want protection there, you have to opt in with `.WithMetadata(new RequireAntiforgeryTokenAttribute())`. But then the failure mode changes: when the verdict is invalid, `FormFeature` refuses to read the body and throws `InvalidOperationException: This form is being accessed with a failed antiforgery validation. Validate the IAntiforgeryValidationFeature on the request before reading from the form.`, which is a 500, not a 400. Check the feature yourself first:

```csharp
// .NET 11 RC 1
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http.Features;

app.MapPost("/manual-protected", async (HttpContext ctx) =>
    {
        if (ctx.Features.Get<IAntiforgeryValidationFeature>() is { IsValid: false })
            return Results.BadRequest();

        var form = await ctx.Request.ReadFormAsync();
        return Results.Ok(form["name"].ToString());
    })
    .WithMetadata(new RequireAntiforgeryTokenAttribute());
```

**`DisableCsrfProtection` is not a per-endpoint tool.** It removes the auto-injected middleware for the whole app. That middleware is also what satisfies the "a middleware was not found that supports anti-forgery" check for apps that never call `UseAntiforgery()`, so flipping the switch to fix one webhook breaks every other form endpoint with a 500 (measured above). The docs call it an escape hatch; treat it as one.

## Narrower alternatives before you disable anything

Disabling is right for signed server-to-server calls. For browser traffic there are two tighter options.

**Trust a specific cross-origin caller through CORS.** The default `ICsrfProtection` implementation consults the CORS policy that applies to the endpoint: if the request's `Origin` is allowed by a named or default policy, the post is accepted even when `Sec-Fetch-Site` is `cross-site`. `AllowAnyOrigin` is deliberately ignored.

```csharp
// .NET 11 RC 1
builder.Services.AddCors(o => o.AddPolicy("partner",
    p => p.WithOrigins("https://pay.partner.example")));

var app = builder.Build();
app.UseCors();

app.MapPost("/partner-callback", ([FromForm] string orderId) => Results.Ok(orderId))
   .RequireCors("partner");
```

Measured on the default pipeline: the partner origin got 200, a foreign origin and a `same-site` sibling still got 400, plain curl got 200. Two caveats. Without `app.UseCors()` the endpoint throws `contains CORS metadata, but a middleware was not found that supports CORS` (500). And this only relaxes the Fetch Metadata layer: with `UseAntiforgery()` in the pipeline, token validation runs afterwards, overrides the verdict, and the partner post was a 400 again. If you already mix CORS with cookies or JWTs, the [CORS setup for a JWT-protected API](/2026/06/how-to-configure-cors-for-a-jwt-protected-api-in-aspnetcore-11/) post covers the policy side.

**Let the framework handle identity-provider callbacks.** OpenID Connect `response_mode=form_post` and WS-Federation callbacks are cross-site form posts by design. In .NET 11 the remote authentication handlers suppress an invalid verdict while they own the callback path (`RemoteAuthenticationAntiforgery` in the source), because the `state` parameter and correlation cookie already protect them. You do not need `.DisableAntiforgery()` on `/signin-oidc`, and you cannot put it there anyway, since the handler is middleware, not an endpoint.

## Gotchas when upgrading from .NET 8, 9 or 10

- **Apps that already call `UseAntiforgery()` see no change for same-origin traffic**, because token validation is authoritative and overwrites the CSRF verdict. The `.DisableAntiforgery()` calls you already have keep working unchanged.
- **Apps that never called `UseAntiforgery()` stop throwing 500s** on form endpoints in .NET 11 (the CSRF middleware satisfies the endpoint check), but start returning 400 to cross-origin browser posts. That can look like a random regression in a form that a sister subdomain posts to, since `same-site` is rejected too.
- **A 400 from a form endpoint is not always antiforgery.** A missing or wrong `Content-Type` gives [415 Unsupported Media Type](/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/), and binding shape mistakes give nulls, as in [the `[FromForm]` dictionary that is always null](/2026/08/fix-fromform-dictionary-is-always-null-in-a-minimal-api/). Check the log category before you disable anything.
- **Token errors after a deploy are a different bug.** If same-origin forms fail only after scaling out or restarting, you are looking at Data Protection keys, covered in [the antiforgery token could not be decrypted](/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/), not at a missing opt-out.
- **Short-circuited routes cannot carry required antiforgery metadata.** `.ShortCircuit()` on a form endpoint that still requires validation is a 500 at request time (`contains anti-forgery metadata, but this endpoint is marked with short circuit and it will execute on Routing Middleware`). Once the endpoint is disabled, the check no longer applies.

## Related

- [ASP.NET Core 11 Preview 6 turns on automatic CSRF protection](/2026/07/aspnetcore-11-automatic-csrf-protection-fetch-metadata-preview-6/)
- [How to organize minimal API endpoints with MapGroup in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [Endpoint filters vs middleware in ASP.NET Core 11](/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [Fix: "415 Unsupported Media Type" from a minimal API endpoint in ASP.NET Core 11](/2026/07/fix-415-unsupported-media-type-from-a-minimal-api-endpoint-in-aspnetcore-11/)
- [Fix: The antiforgery token could not be decrypted in ASP.NET Core](/2026/06/fix-the-antiforgery-token-could-not-be-decrypted-in-aspnetcore/)

## Sources

- [Prevent Cross-Site Request Forgery (XSRF/CSRF) attacks in ASP.NET Core](https://learn.microsoft.com/aspnet/core/security/anti-request-forgery) (MS Learn, sections on automatic CSRF protection and per-endpoint opt-out)
- [ASP.NET Core in .NET 11 Preview 6 release notes: automatic cross-origin (CSRF) protection](https://github.com/dotnet/core/blob/main/release-notes/11.0/preview/preview6/aspnetcore.md)
- [dotnet/aspnetcore #66585](https://github.com/dotnet/aspnetcore/pull/66585) and [#67082](https://github.com/dotnet/aspnetcore/pull/67082), the CSRF middleware PRs
- Source at tag `v11.0.0-rc.1.26425.128`: [`CsrfProtectionMiddleware.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/CsrfProtectionMiddleware.cs), [`DefaultCsrfProtection.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/DefaultBuilder/src/Internal/DefaultCsrfProtection.cs), [`RoutingEndpointConventionBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Http/Routing/src/Builder/RoutingEndpointConventionBuilderExtensions.cs), [`RequireAntiforgeryTokenAttribute.cs`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.1.26425.128/src/Antiforgery/src/RequireAntiforgeryTokenAttribute.cs)
