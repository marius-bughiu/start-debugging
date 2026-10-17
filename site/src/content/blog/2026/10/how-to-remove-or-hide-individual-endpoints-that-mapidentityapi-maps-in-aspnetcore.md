---
title: "How to Remove or Hide Individual Endpoints That MapIdentityApi Maps in ASP.NET Core"
description: "MapIdentityApi<TUser>() maps ten endpoints and has no switch to skip one. Here are four measured ways to deal with that on .NET 11: hide an endpoint from OpenAPI, make it return 404, shadow it, or remove it from routing entirely, plus the /confirmEmail trap that turns registration into a 500."
pubDate: 2026-10-17
template: how-to
tags:
  - "aspnetcore"
  - "aspnetcore-11"
  - "identity"
  - "minimal-apis"
  - "openapi"
  - "dotnet-11"
---

**Short answer:** `MapIdentityApi<TUser>()` has no parameter for choosing endpoints, and that is still true in .NET 11 RC 2. What you get back is an `IEndpointConventionBuilder`, and its conventions run on every endpoint with the final route pattern available, so you can match `/register` or `/manage/2fa` by pattern. To hide an endpoint from the OpenAPI document only, add `ExcludeFromDescriptionAttribute` in a convention. To make it unusable, also replace `EndpointBuilder.RequestDelegate` with one that returns 404. To remove it from routing completely, map Identity into a private `IEndpointRouteBuilder` and re-expose its endpoints through a filtering `EndpointDataSource` (about 30 lines, shown below). Never remove `/confirmEmail` while `/register` or `/resendConfirmationEmail` are live: both throw `NotSupportedException` and return 500.

Everything below was run on macOS against SDK 11.0.100-rc.1.26425.128 with `Microsoft.AspNetCore.Identity.EntityFrameworkCore` 11.0.0-rc.1.26425.128 and an EF Core InMemory store. I diffed `IdentityApiEndpointRouteBuilderExtensions.cs` between the `v8.0.0`, `v11.0.0-rc.1.26425.128` and `v11.0.0-rc.2.26504.105` tags: the route list is identical in all three, and the file did not change between RC 1 and RC 2, so the techniques apply to .NET 8, 9, 10 and 11.

## Why there is no built-in way to skip an endpoint

`MapIdentityApi<TUser>()` is one extension method that creates an empty route group and maps everything into it:

| Method | Route | Requires auth |
| --- | --- | --- |
| POST | `/register` | no |
| POST | `/login` | no |
| POST | `/refresh` | no |
| GET | `/confirmEmail` | no |
| POST | `/resendConfirmationEmail` | no |
| POST | `/forgotPassword` | no |
| POST | `/resetPassword` | no |
| POST | `/manage/2fa` | yes |
| GET | `/manage/info` | yes |
| POST | `/manage/info` | yes |

The source then wraps the group in a private `IdentityEndpointsConventionBuilder` type, with a comment saying it does so "to avoid a potential future behavioral breaking change". You cannot cast the return value back to `RouteGroupBuilder`, and the handlers are lambdas inside the method, so you cannot call them yourself either.

The request to split it up has been open since 2024 as [dotnet/aspnetcore#55792](https://github.com/dotnet/aspnetcore/issues/55792) ("Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled"), and the broader [dotnet/aspnetcore#50303](https://github.com/dotnet/aspnetcore/issues/50303) about extensibility goes back to the .NET 8 previews. Both sit in the Backlog milestone. Until one of them ships, the usual reasons people hit this (public sign-up must be off, 2FA is handled elsewhere, the OpenAPI document should not advertise password reset) all have to be handled from the outside.

## The test setup

This is the app every variant below plugs into. The Identity endpoints live under `/account`, because that is how most real apps mount them and because it affects how you match routes:

```csharp
// .NET 11 RC 1, Microsoft.AspNetCore.Identity.EntityFrameworkCore 11.0.0-rc.1.26425.128
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDbContext<AppDbContext>(o => o.UseInMemoryDatabase("ids"));
builder.Services.AddAuthorization();
builder.Services.AddIdentityApiEndpoints<IdentityUser>()
    .AddEntityFrameworkStores<AppDbContext>();
builder.Services.AddOpenApi();

var app = builder.Build();
app.MapOpenApi();

var account = app.MapGroup("/account");
account.MapIdentityApi<IdentityUser>();

app.Run();

class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<IdentityUser>(options);
```

With no changes, `/openapi/v1.json` lists all ten routes under `/account`, `POST /account/register` returns 200, and an anonymous `POST /account/manage/2fa` returns 401.

One detail matters for every technique below: inside a convention, `RouteEndpointBuilder.RoutePattern.RawText` is the **final** pattern, group prefix included. Logging it from a convention prints `/account/register`, `/account/manage/2fa`, and so on, not `/register`. Identity itself relies on this when it names the confirm-email endpoint. So match with `EndsWith`, or compare against the full prefixed path:

```csharp
// .NET 11 RC 1
string[] blocked = ["/register", "/manage/2fa"];

bool IsBlocked(EndpointBuilder b) =>
    b is RouteEndpointBuilder rb &&
    blocked.Any(p => rb.RoutePattern.RawText!.EndsWith(p, StringComparison.OrdinalIgnoreCase));
```

## Option 1: hide an endpoint from the OpenAPI document only

If the endpoint should keep working but stay out of your published contract (common for `/refresh` or `/manage/info` in a public API document), add the same metadata that `.ExcludeFromDescription()` adds:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (IsBlocked(b))
        b.Metadata.Add(new ExcludeFromDescriptionAttribute());
});
```

Measured result: `/account/register` and `/account/manage/2fa` disappear from `/openapi/v1.json`, and `POST /account/register` still returns 200. That is the point of this option, and also its limit. Hiding is documentation, not access control. Anyone who has read the Identity docs knows the route exists.

`ExcludeFromDescriptionAttribute` lives in `Microsoft.AspNetCore.Routing` and implements `IExcludeFromDescriptionMetadata`, which both the built-in `Microsoft.AspNetCore.OpenApi` generator and Swashbuckle's API explorer honour. If you would rather keep all of this in one place, you can do the same filtering in a document transformer, as shown in [the post on OpenAPI operation and schema transformers](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/), but the metadata approach is simpler and also covers other API explorer consumers.

## Option 2: keep the route but make it return 404

To actually switch an endpoint off, replace its request delegate in the same convention. Conventions receive the `EndpointBuilder` before the `RouteEndpoint` is built, and `RequestDelegate` is a settable property:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().Add(b =>
{
    if (!IsBlocked(b)) return;

    b.Metadata.Add(new ExcludeFromDescriptionAttribute());
    b.RequestDelegate = ctx =>
    {
        ctx.Response.StatusCode = StatusCodes.Status404NotFound;
        return Task.CompletedTask;
    };
});
```

Measured result: `POST /account/register` returns 404, both routes are gone from the OpenAPI document, and every other endpoint behaves as before. I got the same result with `.Finally(...)` instead of `.Add(...)`. `Finally` conventions run after all other conventions, which is the safer choice if something else in your pipeline also touches `RequestDelegate`.

The catch is that the endpoint still exists as far as routing and authorization are concerned. It keeps all its metadata, including the `RequireAuthorization()` that Identity puts on the `/manage` group. The authorization middleware runs before the endpoint's delegate, so an anonymous `POST /account/manage/2fa` still returns **401**, not 404. Only authenticated callers reach your 404. If the goal is "do not reveal that this exists", that difference is visible from outside.

An [endpoint filter](/2026/07/how-to-add-an-endpoint-filter-to-a-minimal-api-in-aspnetcore-11/) gets you to the same place, because `AddEndpointFilter` works on any `IEndpointConventionBuilder`:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>().AddEndpointFilter(async (ctx, next) =>
{
    var route = (ctx.HttpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "";
    if (blocked.Any(p => route.EndsWith(p))) return Results.NotFound();
    return await next(ctx);
});
```

It returned 404 for `/account/register` too, but it is strictly worse here: the filter runs on every Identity request, the endpoints stay in the OpenAPI document unless you add the metadata as well, and the model binding of the request body has already happened by the time the filter runs. The [endpoint filters vs middleware comparison](/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/) explains that ordering in more detail. Use the delegate swap.

## Option 3: shadow the route with a higher-priority endpoint

A lot of answers online suggest mapping your own endpoint on the same route. Mapped naively, with `account.MapPost("/register", () => Results.NotFound())` after `MapIdentityApi`, it does nothing useful: I expected an `AmbiguousMatchException`, but a JSON `POST /account/register` still returned 200 from Identity's handler. Identity's endpoint binds a `[FromBody]` parameter, so it carries `application/json` accepts metadata, and the content-type matcher policy ranks it above your endpoint, which declares nothing. Your endpoint silently never runs. Give it a lower `Order` and the matcher prefers it before any of that tie-breaking happens:

```csharp
// .NET 11 RC 1
account.MapIdentityApi<IdentityUser>();
account.MapPost("/register", () => Results.NotFound())
    .WithOrder(-1)
    .ExcludeFromDescription();
```

Measured result: `POST /account/register` returns 404, and the endpoint list now contains both `POST /account/register order=0` and `POST /account/register order=-1`. The original endpoint is still in the OpenAPI document, because `ExcludeFromDescription()` only applies to your shadow endpoint. You need option 1 on top to hide it.

Shadowing is the right tool when you want to **replace** an endpoint rather than remove it, for example a `/register` that also requires an invite code, while the rest of `MapIdentityApi` stays stock. For plain removal it is the messiest of the four options.

## Option 4: remove endpoints from routing entirely

To make an endpoint truly not exist (no route, no OpenAPI entry, no 401 for anonymous callers, just the same 404 as any unknown URL), you have to stop its `RouteEndpoint` from reaching the routing system. `MapIdentityApi` only uses two members of the `IEndpointRouteBuilder` you pass in: `ServiceProvider`, to resolve its services, and `DataSources`, which `MapGroup("")` adds its endpoint source to. That gives you a seam:

1. Pass `MapIdentityApi` a small `IEndpointRouteBuilder` of your own whose `DataSources` collection is private.
2. Wrap that private collection in an `EndpointDataSource` that drops the endpoints you do not want.
3. Add the wrapper to the real route builder's `DataSources`.

```csharp
// .NET 11 RC 1, works the same on .NET 8, 9 and 10
using Microsoft.Extensions.Primitives;

static class IdentityApiExceptExtensions
{
    public static IEndpointConventionBuilder MapIdentityApiExcept<TUser>(
        this IEndpointRouteBuilder endpoints, params string[] excludedRoutes)
        where TUser : class, new()
    {
        var capture = new CapturingRouteBuilder(endpoints);
        var conventions = capture.MapIdentityApi<TUser>();

        bool Keep(Endpoint e) =>
            e is not RouteEndpoint re ||
            !excludedRoutes.Any(r =>
                re.RoutePattern.RawText!.EndsWith(r, StringComparison.OrdinalIgnoreCase));

        endpoints.DataSources.Add(new FilteringEndpointDataSource(capture.DataSources, Keep));
        return conventions;
    }

    private sealed class CapturingRouteBuilder(IEndpointRouteBuilder inner) : IEndpointRouteBuilder
    {
        public ICollection<EndpointDataSource> DataSources { get; } = new List<EndpointDataSource>();
        public IServiceProvider ServiceProvider => inner.ServiceProvider;
        public IApplicationBuilder CreateApplicationBuilder() => inner.CreateApplicationBuilder();
    }

    private sealed class FilteringEndpointDataSource(
        ICollection<EndpointDataSource> sources, Func<Endpoint, bool> keep) : EndpointDataSource
    {
        private readonly CompositeEndpointDataSource _inner = new(sources);

        public override IReadOnlyList<Endpoint> Endpoints =>
            _inner.Endpoints.Where(keep).ToList();

        public override IReadOnlyList<Endpoint> GetGroupedEndpoints(RouteGroupContext context) =>
            _inner.GetGroupedEndpoints(context).Where(keep).ToList();

        public override IChangeToken GetChangeToken() => _inner.GetChangeToken();
    }
}
```

Usage is a one-line change:

```csharp
// .NET 11 RC 1
var account = app.MapGroup("/account");
account.MapIdentityApiExcept<IdentityUser>("/register", "/manage/2fa");
```

Measured result: the endpoint list has eight entries instead of ten, `/openapi/v1.json` lists eight paths, and both `POST /account/register` and an anonymous `POST /account/manage/2fa` return 404. The other eight endpoints work as before, and the returned convention builder still applies to them, so `.RequireRateLimiting(...)` or `.WithTags(...)` chained on the result behaves as usual.

Two parts of that code are easy to get wrong:

- **Override `GetGroupedEndpoints`.** When you call the extension on a group such as `account`, the outer group does not read `Endpoints`. It calls `GetGroupedEndpoints` with the prefix and the group's conventions. Delegating that call to the inner sources lets them build each endpoint once with the full prefix and all conventions applied, instead of relying on the base class to re-wrap endpoints that were already built without the prefix. It is also why `RawText` already carries `/account` when `Keep` runs.
- **Pass the change token through.** Identity's endpoints are static, but returning a real token from the inner composite keeps the data source correct if anything else ever adds endpoints to the captured collection.

This relies on `MapIdentityApi` using only `ServiceProvider` and `DataSources`. That is true in every version from 8.0 to 11 RC 2, but it is an implementation detail. A future version that, say, called `CreateApplicationBuilder()` would still work through the delegation above. One that maps into some other builder would not. A test that asserts the expected route list (the `IEnumerable<EndpointDataSource>` dump I used is three lines) will catch that on upgrade.

## The `/confirmEmail` trap

The one endpoint you cannot drop on its own is `GET /confirmEmail`. `/register`, `/resendConfirmationEmail` and the email-change branch of `POST /manage/info` all generate the confirmation link by endpoint name, with `LinkGenerator.GetUriByName`. The name is assigned in a `Finally` convention on `/confirmEmail`, as `MapIdentityApi-` followed by the final route pattern.

With option 4 and `MapIdentityApiExcept<IdentityUser>("/confirmEmail")`, the convention still runs (the endpoint is built, then filtered out), so the name is set, but the link generator cannot find an endpoint with that name. Registration then fails:

```text
System.NotSupportedException: Could not find endpoint named 'MapIdentityApi-/account/confirmEmail'.
```

Measured result: `POST /account/register` returns **500** and so does `POST /account/resendConfirmationEmail`, while `/login` keeps working. If you do not want email confirmation through this API at all, remove `/register` and `/resendConfirmationEmail` together with `/confirmEmail`, or keep `/confirmEmail` routed and only hide it from OpenAPI with option 1.

Option 2 does not have this problem, because the endpoint still exists for link generation. It just answers 404.

## Which option to use

- **The endpoint is fine, it just should not be in the published document:** option 1.
- **The endpoint must not work, and a 401 for anonymous callers on `/manage/*` is acceptable:** option 2 with the delegate swap in `Finally`. It is a few lines and does not depend on Identity internals.
- **The endpoint must not exist at all:** option 4.
- **You need a different implementation of one endpoint:** option 3, plus option 1 to hide the original.
- **You need to change behaviour inside several endpoints** (extra registration fields, username login, different token responses): copy [`IdentityApiEndpointRouteBuilderExtensions.cs`](https://github.com/dotnet/aspnetcore/blob/main/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs) into your project and edit it. It is MIT-licensed, about 490 lines, and the request and response DTOs it uses (`RegisterRequest`, `LoginRequest`, `AccessTokenResponse` and so on) are public types in `Microsoft.AspNetCore.Identity.Data`. You lose automatic fixes from future framework updates, so watch the file's history when you upgrade.

If you are already at the point of replacing several endpoints, compare the trade-offs in [JWT vs cookie authentication in ASP.NET Core 11](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) first. The bearer tokens `MapIdentityApi` issues are opaque Data Protection tokens, not JWTs, and that is often the real reason a team outgrows these endpoints.

## Gotchas

- **Match the full route, or use `EndsWith` carefully.** `EndsWith("/info")` matches both `GET` and `POST /manage/info`. If you only want to block the `POST` (it is the one that can change the email and password), also check `b.Metadata.OfType<HttpMethodMetadata>()` in the convention, or `re.Metadata.GetMetadata<HttpMethodMetadata>()` in option 4.
- **`/login` and `/refresh` belong together.** Removing `/refresh` while keeping `/login` leaves clients with a `refreshToken` they can never use. The [refresh token walkthrough](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/) covers what `/refresh` actually validates.
- **Removing `/register` does not stop account creation.** `UserManager<TUser>.CreateAsync` is still available to your own code, and external login flows can still create users. Blocking the endpoint only removes the anonymous public sign-up route.
- **Do not reach for path-based middleware first.** A middleware that returns 404 for paths starting with `/account/register` works, but it hard-codes the group prefix, runs for every request in the app, and leaves the OpenAPI entry in place. Endpoint conventions know the final pattern and run once, when the endpoints are built.
- **Mount Identity in its own group.** Calling `MapIdentityApi` directly on `app` puts `/login` and `/register` at the root of your API. A dedicated group, as described in [organizing minimal API endpoints with `MapGroup`](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/), also lets you attach rate limiting and tags to Identity only.

## Related

- [How to implement refresh tokens in ASP.NET Core Identity](/2026/04/how-to-implement-refresh-tokens-in-aspnetcore-identity/), including when `MapIdentityApi` stops being enough.
- [How to organize minimal API endpoints with `MapGroup` in ASP.NET Core 11](/2026/06/how-to-organize-minimal-api-endpoints-with-mapgroup-in-aspnetcore-11/)
- [How to customize OpenAPI with operation and schema transformers in ASP.NET Core 11](/2026/07/how-to-customize-openapi-with-operation-and-schema-transformers-in-aspnetcore-11/)
- [Endpoint filters vs middleware in ASP.NET Core 11](/2026/07/endpoint-filters-vs-middleware-in-aspnetcore-11/)
- [JWT vs cookie authentication in ASP.NET Core 11](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)

## Sources

- [`IdentityApiEndpointRouteBuilderExtensions.cs` at `v11.0.0-rc.2.26504.105`](https://github.com/dotnet/aspnetcore/blob/v11.0.0-rc.2.26504.105/src/Identity/Core/src/IdentityApiEndpointRouteBuilderExtensions.cs), dotnet/aspnetcore.
- [dotnet/aspnetcore#55792: Split MapIdentityApi<TUser>() into multiple APIs and allow selective end points to be enabled](https://github.com/dotnet/aspnetcore/issues/55792)
- [dotnet/aspnetcore#50303: Extensibility for Identity Endpoints](https://github.com/dotnet/aspnetcore/issues/50303)
- [Use Identity to secure a Web API backend for SPAs](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/identity-api-authorization), Microsoft Learn.
- [Route groups and endpoint conventions in minimal APIs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/minimal-apis/route-handlers#route-groups), Microsoft Learn.
- [`EndpointDataSource` class](https://learn.microsoft.com/en-us/dotnet/api/microsoft.aspnetcore.routing.endpointdatasource), Microsoft Learn.
