---
title: "Fix: Unable to find the required 'IAuthenticationService' service with [Authorize(Policy = ...)] in Blazor"
description: "A Blazor Web App page with [Authorize] becomes an endpoint the AuthorizationMiddleware checks, and a failed check calls ChallengeAsync, which needs AddAuthentication. Register a real scheme, or pass component endpoints through to AuthorizeRouteView."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnetcore"
  - "dotnet-10"
  - "authorization"
---

`Unable to find the required 'IAuthenticationService' service` on a Blazor page with `@attribute [Authorize(Policy = "...")]` means the ASP.NET Core `AuthorizationMiddleware` evaluated your policy for the HTTP request, the check failed, and it tried to call `HttpContext.ChallengeAsync()` with no authentication services registered. The real fix is `builder.Services.AddAuthentication(...)` with a scheme (usually cookies) so a challenge has somewhere to go. If your app authenticates purely through a custom `AuthenticationStateProvider`, register an `IAuthorizationMiddlewareResultHandler` that lets Razor component endpoints through, and let `AuthorizeRouteView` enforce the policy.

Everything below was reproduced on .NET 10.0.10 (SDK 10.0.302) and .NET 11 RC 1 (SDK 11.0.100-rc.1.26425.128) with the stock `dotnet new blazor -int Server` template. Both runtimes gave identical results for every scenario.

## The error in context

The browser gets a 500 on the first request to the protected page. The log shows the challenge coming from the authorization middleware, not from Blazor:

```text
fail: Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddleware[1]
      An unhandled exception has occurred while executing the request.
      System.InvalidOperationException: Unable to find the required 'IAuthenticationService' service. Please add all the required services by calling 'IServiceCollection.AddAuthentication' in the application startup code.
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.GetAuthenticationService(HttpContext context)
         at Microsoft.AspNetCore.Authentication.AuthenticationHttpContextExtensions.ChallengeAsync(HttpContext context)
         at Microsoft.AspNetCore.Authorization.Policy.AuthorizationMiddlewareResultHandler.<>c__DisplayClass0_0.<<HandleAsync>g__Handle|0>d.MoveNext()
      --- End of stack trace from previous location ---
         at Microsoft.AspNetCore.Authorization.AuthorizationMiddleware.Invoke(HttpContext context)
         at Microsoft.AspNetCore.Diagnostics.DeveloperExceptionPageMiddlewareImpl.Invoke(HttpContext context)
```

The tell-tale pattern that sends people to Stack Overflow and to [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678): navigating to the page from inside the app works, but refreshing it, bookmarking it, or opening it as the first page of a session crashes.

## Why this happens

Three pieces of ASP.NET Core line up to produce the exception.

1. **A routable component is an HTTP endpoint.** Since .NET 8, `MapRazorComponents<App>()` creates one endpoint per `@page`. `RazorComponentEndpointFactory` copies every attribute on the component type into the endpoint metadata, including `[Authorize]` (see the comment "All attributes defined for the type are included as metadata" in the source).
2. **`UseAuthorization()` is added for you.** `WebApplicationBuilder` inserts the authorization middleware automatically whenever `IAuthorizationHandlerProvider` is registered, and `AddAuthorizationCore()` registers it. You do not need to call `app.UseAuthorization()` to be affected; my repro never calls it.
3. **A failed policy is turned into a challenge.** The default `AuthorizationMiddlewareResultHandler` calls `context.ChallengeAsync()` for an anonymous user and `context.ForbidAsync()` for an authenticated one who fails the policy. Both need `IAuthenticationService`, which only `AddAuthentication()` registers.

So the middleware runs your policy against `HttpContext.User`. Your custom `AuthenticationStateProvider` is not consulted at all on this path, which is why the next point surprises people: **the error also happens for users your provider considers signed in**. In my repro a provider that returns a principal with the `Admin` role still got a 500 on `/admin`, because `HttpContext.User` was anonymous.

Client-side navigation inside an interactive circuit never makes an HTTP request, so the middleware never sees it. `AuthorizeRouteView` evaluates `[Authorize]` there instead, using the `AuthenticationStateProvider`. That is the entire explanation for "works when I click the link, crashes on F5".

This used to work in .NET 7 Blazor Server because `_Host.cshtml` was the only endpoint and components were never mapped individually. [Migrating to a Blazor Web App](/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/) is exactly when most people meet this error.

## Minimal repro

A Blazor Web App that authenticates against an external API and exposes the result only through a custom `AuthenticationStateProvider`, with no ASP.NET Core authentication scheme:

```csharp
// .NET 10.0.10 / .NET 11 RC 1, Program.cs
using System.Security.Claims;
using AuthRepro.Components;
using Microsoft.AspNetCore.Components.Authorization;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorComponents().AddInteractiveServerComponents();
builder.Services.AddCascadingAuthenticationState();
builder.Services.AddScoped<AuthenticationStateProvider, ApiTokenAuthStateProvider>();
builder.Services.AddAuthorizationCore(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));

var app = builder.Build();
app.UseAntiforgery();
app.MapStaticAssets();
app.MapRazorComponents<App>().AddInteractiveServerRenderMode();
app.Run();

class ApiTokenAuthStateProvider : AuthenticationStateProvider
{
    public override Task<AuthenticationState> GetAuthenticationStateAsync() =>
        Task.FromResult(new AuthenticationState(new ClaimsPrincipal(new ClaimsIdentity())));
}
```

```razor
@* .NET 10 / 11, Components/Pages/Admin.razor *@
@page "/admin"
@attribute [Authorize(Policy = "Admins")]
<h1>Admin area</h1>
```

`Routes.razor` uses `<AuthorizeRouteView>` with a `<NotAuthorized>` block. Curling the running app gives:

| Request | Result |
| --- | --- |
| `GET /` | 200 |
| `GET /admin` | 500, `IAuthenticationService` exception |
| `GET /admin`, provider returns an Admin | 500, same exception |

## Fix 1: register a real authentication scheme (recommended)

If users sign in to your app at all, give ASP.NET Core a scheme that knows who they are on the HTTP request. For a server-rendered Blazor app that is almost always cookies:

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authentication.Cookies;

builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o =>
    {
        o.LoginPath = "/login";
        o.AccessDeniedPath = "/access-denied";
    });

builder.Services.AddAuthorization(o =>
    o.AddPolicy("Admins", p => p.RequireRole("Admin")));
```

With that in place, `GET /admin` as an anonymous user returns `302` to `/login?ReturnUrl=%2Fadmin` instead of throwing. A user who is signed in but lacks the role is sent to `AccessDeniedPath`.

Two follow-ups make this correct rather than just quiet:

- **Sign in with the cookie.** If your login flow calls an external API and gets a token back, finish it with `HttpContext.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme, principal)` from a static SSR page or a minimal API endpoint, with the claims you care about (roles, user id). You can store the API token in the cookie's `AuthenticationProperties` if later calls need it.
- **Drop the custom `AuthenticationStateProvider` if it only duplicated that work.** Blazor's built-in `ServerAuthenticationStateProvider` reads `HttpContext.User` during prerendering and flows it into the circuit, so pages, `AuthorizeView`, and the middleware all agree on who the user is.

If you are unsure whether cookies or tokens fit your app, [JWT vs cookie authentication in ASP.NET Core](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/) walks through the trade-off. For a Blazor Web App that serves its own UI, cookies win almost every time.

A detail worth knowing: since .NET 7, when exactly one scheme is registered it becomes the default automatically. `AddAuthentication().AddCookie()` with no default scheme argument worked in my repro too, redirecting to the cookie handler's default `/Account/Login`. Once you add a second scheme (OpenID Connect, JWT bearer), name the defaults explicitly or you trade this error for `No authenticationScheme was specified, and there was no DefaultChallengeScheme found`.

## Fix 2: let component endpoints through to AuthorizeRouteView

Some apps genuinely have no HTTP-level identity: the Blazor Server app calls a separate Web API, holds the token in circuit state, and exposes the user only through a custom `AuthenticationStateProvider`. Adding a cookie scheme there means rebuilding the login flow. The alternative is to change what the authorization middleware does when a policy fails, using the documented [`IAuthorizationMiddlewareResultHandler`](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse) extension point:

```csharp
// .NET 10 / 11, Program.cs
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.AspNetCore.Components.Endpoints;

builder.Services.AddSingleton<IAuthorizationMiddlewareResultHandler,
    BlazorAuthorizationMiddlewareResultHandler>();

sealed class BlazorAuthorizationMiddlewareResultHandler : IAuthorizationMiddlewareResultHandler
{
    private readonly AuthorizationMiddlewareResultHandler _default = new();

    public Task HandleAsync(RequestDelegate next, HttpContext context,
        AuthorizationPolicy policy, PolicyAuthorizationResult authorizeResult)
    {
        // Razor component pages: let the request through. AuthorizeRouteView
        // re-checks [Authorize] against the AuthenticationStateProvider.
        if (context.GetEndpoint()?.Metadata.GetMetadata<ComponentTypeMetadata>() is not null)
            return next(context);

        return _default.HandleAsync(next, context, policy, authorizeResult);
    }
}
```

`ComponentTypeMetadata` (public, in `Microsoft.AspNetCore.Components.Endpoints`) is attached to every endpoint that `MapRazorComponents` creates, so the pass-through applies only to pages. Everything else keeps the default behaviour.

Measured results with this handler and no `AddAuthentication()` call:

| Request | Provider user | Result |
| --- | --- | --- |
| `GET /admin` | anonymous | 200, `<NotAuthorized>` content rendered |
| `GET /admin` | has `Admin` role | 200, page rendered |
| `GET /api/secret` (`RequireAuthorization("Admins")`) | either | 500, `IAuthenticationService` exception |

Understand what you are signing up for with this fix:

- **The page is protected by `AuthorizeRouteView`, not by the middleware.** It renders `<NotAuthorized>` instead of the page, during prerendering and in the circuit. Your `Routes.razor` must use `AuthorizeRouteView` (the plain `RouteView` ignores `[Authorize]`), and the `<NotAuthorized>` content is what anonymous users see, so put a login link there.
- **The response is 200, not 401 or 302.** Crawlers and uptime monitors see a successful page. If you need a redirect, do it from the `<NotAuthorized>` block with `NavigationManager.NavigateTo("/login")`, or use Fix 1.
- **Non-component endpoints still need Fix 1.** The last row of the table is deliberate: a minimal API or controller behind a policy has no `AuthorizeRouteView` to fall back on. If you have those, you need a real scheme anyway.

Do not "fix" this by registering a no-op authentication handler whose challenge does nothing. The middleware short-circuits after a challenge, so users get an empty 200 page with no explanation, which is worse than the exception.

## Fix 3: move the check into the component

If only a section of a page is restricted, the attribute is the wrong tool. Remove `@attribute [Authorize(...)]` and wrap the protected markup:

```razor
@* .NET 10 / 11 *@
@page "/admin"

<AuthorizeView Policy="Admins">
    <Authorized><h1>Admin area</h1></Authorized>
    <NotAuthorized><p>You need the Admin role.</p></NotAuthorized>
</AuthorizeView>
```

No endpoint metadata, no middleware check, no exception: in the same repro (still without `AddAuthentication()`), this page returned 200 with the `<NotAuthorized>` content for an anonymous user and the admin markup for an Admin. This matches the reporter's observation in #55678 that `<AuthorizeView>` on the first page never failed. It is fine for UI gating, but remember that anything rendered server-side is still sent to users who pass the check, so data access in the component should also check authorization, not just the markup.

## Gotchas and lookalikes

**A `FallbackPolicy` breaks every page, including the home page.** `AddAuthorization(o => o.FallbackPolicy = ...RequireAuthenticatedUser()...)` applies to every endpoint without its own authorization metadata. In my repro `GET /` went from 200 to 500 with the same exception. Classic Blazor Server apps that still use `_Host.cshtml` and `MapBlazorHub()` hit the error this way (or through `MapBlazorHub().RequireAuthorization()`), since their components are not individual endpoints.

**`AddAuthorizationCore()` vs `AddAuthorization()` is not the cause.** Both register the handler provider that makes `WebApplicationBuilder` insert `UseAuthorization()`. Switching between them changes nothing here.

**Blazor WebAssembly standalone never shows this error.** There is no ASP.NET Core pipeline on the client. If a WebAssembly app thinks the user is anonymous after sign-in, that is a different problem, covered in [IsAuthenticated is false after an MSAL upgrade](/2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade/).

**Render mode does not matter.** The failing request is the initial HTTP GET that serves the page, before any interactivity starts. Static SSR, Interactive Server, WebAssembly, and Auto pages behave the same. If render modes still feel fuzzy, [which render mode runs my component](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/) explains where each one executes.

**The `AuthenticationStateProvider` user does not reach `HttpContext.User`.** The flow only goes the other way: `ServerAuthenticationStateProvider` reads from `HttpContext`. Anything that runs before components render (middleware, endpoint filters, rate limiting partitioned by user) only sees what an authentication handler put there.

## Related

- [Migrate a Blazor Server app to a Blazor Web App in .NET 11](/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/), the migration that usually surfaces this error.
- [JWT vs cookie authentication in ASP.NET Core 11](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/), for picking the scheme in Fix 1.
- [What is a Blazor render mode and which one runs my component?](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/)
- [Fix: JavaScript interop calls cannot be issued at this time during Blazor prerendering](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/), another error that only appears on the first HTTP request.

## Sources

- [dotnet/aspnetcore#55678](https://github.com/dotnet/aspnetcore/issues/55678), "Exception triggered by AuthorizeAttribute on the first page loaded in a circuit", and [#53732](https://github.com/dotnet/aspnetcore/issues/53732) on `AddAuthorizationCore` without authentication in .NET 8 Blazor Web Apps.
- [`RazorComponentEndpointFactory.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/RazorComponentEndpointFactory.cs) and [`ComponentTypeMetadata.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Endpoints/src/Builder/ComponentTypeMetadata.cs) at the `v10.0.0` tag.
- [`WebApplicationBuilder.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/DefaultBuilder/src/WebApplicationBuilder.cs) (automatic `UseAuthentication` / `UseAuthorization`) and [`AuthorizationMiddlewareResultHandler.cs`](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authorization/Policy/src/AuthorizationMiddlewareResultHandler.cs).
- [Customize the behavior of AuthorizationMiddleware](https://learn.microsoft.com/aspnet/core/security/authorization/customizingauthorizationmiddlewareresponse) and [ASP.NET Core Blazor authentication and authorization](https://learn.microsoft.com/aspnet/core/blazor/security/) on Microsoft Learn.
- [Authentication uses single scheme as DefaultScheme](https://learn.microsoft.com/aspnet/core/release-notes/aspnetcore-7.0#authentication-uses-single-scheme-as-defaultscheme) in What's new in ASP.NET Core 7.0.
