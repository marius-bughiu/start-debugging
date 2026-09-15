---
title: "Fix: ASP.NET Core API endpoints return 401 instead of redirecting to the login page after upgrading to .NET 10"
description: "In .NET 10 cookie auth answers API-style endpoints with 401/403 instead of a login redirect. Restore it per endpoint, globally, or with an AppContext switch."
pubDate: 2026-09-15
template: error-page
tags:
  - "errors"
  - "aspnetcore"
  - "dotnet-10"
  - "authentication"
  - "cookies"
  - "csharp"
---

In ASP.NET Core 10, unauthenticated requests to "API-shaped" endpoints behind cookie authentication get a `401` (and forbidden ones a `403`) instead of a `302` to your `LoginPath`. That covers `[ApiController]` controllers, minimal APIs that read or write JSON, `TypedResults` returns, and SignalR. The change is intentional. If a browser really navigates to such an endpoint, add `.AllowCookieRedirect()` (or `[AllowCookieRedirect]`) to that endpoint. To bring back the .NET 9 behaviour app-wide, override `OnRedirectToLogin`/`OnRedirectToAccessDenied`, or set the `Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata` AppContext switch. Everything below was measured on ASP.NET Core 10.0.10 (SDK 10.0.302) against 9.0.20.

## The error in context

After the upgrade there is no exception and nothing in the log. The login page just stops appearing. A request that used to bounce to `/login` now comes back like this:

```text
HTTP/1.1 401 Unauthorized
Content-Length: 0
Server: Kestrel
Location: http://localhost:5103/login?ReturnUrl=%2Fm%2Fdto
```

Notice that the `Location` header is still there. The cookie handler computes the login URL exactly as before and writes it to the response, but it sets the status to `401` instead of `302`, so browsers and `HttpClient` do not follow it. A signed-in user who fails an authorization policy gets the same treatment: `403 Forbidden` with `Location: /denied?ReturnUrl=...` instead of a redirect to `AccessDeniedPath`.

Typical symptoms:

- A Razor Pages or MVC app with a few minimal API endpoints: opening one of them in the browser tab shows a blank page (or the browser's own 401 page) instead of the login form.
- A frontend `fetch` that used to follow the `302`, land on the login HTML, and detect it with `res.redirected` now gets a `401` and throws in a different code path.
- Integration tests that asserted the login redirect (a `302` with `AllowAutoRedirect = false`, or a final URL on `/Account/Login` with the default client) now fail for exactly the endpoints listed above, while the rest still pass.

## Why .NET 10 stopped redirecting for these endpoints

This is the breaking change [Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints), shipped in .NET 10 Preview 7 and generally available since 10.0.0 (November 2025). It closes a request that dates back to 2019 ([dotnet/aspnetcore#9039, "ApiController redirects to login page"](https://github.com/dotnet/aspnetcore/issues/9039)): an HTML login page is useless to a JSON client.

The mechanism is endpoint metadata. The default `OnRedirectToLogin` delegate in `CookieAuthenticationEvents` now reads:

```csharp
// ASP.NET Core 10.0.0, src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs (abridged)
public Func<RedirectContext<CookieAuthenticationOptions>, Task> OnRedirectToLogin { get; set; } = context =>
{
    if (IsAjaxRequest(context.Request) || IsCookieRedirectDisabledByMetadata(context.HttpContext))
    {
        context.Response.Headers.Location = context.RedirectUri;
        context.Response.StatusCode = 401;
    }
    else
    {
        context.Response.Redirect(context.RedirectUri);
    }
    return Task.CompletedTask;
};

private static bool IsCookieRedirectDisabledByMetadata(HttpContext context)
{
    if (_ignoreCookieRedirectMetadata) // AppContext switch, read once
    {
        return false;
    }
    var endpoint = context.GetEndpoint();
    return endpoint?.Metadata.GetMetadata<IDisableCookieRedirectMetadata>() is not null &&
        endpoint?.Metadata.GetMetadata<IAllowCookieRedirectMetadata>() is null;
}
```

The `IsAjaxRequest` branch (an `X-Requested-With: XMLHttpRequest` header) has been there for years. The new part is `IDisableCookieRedirectMetadata`, which the framework attaches automatically in these places:

- `ApiControllerAttribute` now implements `IDisableCookieRedirectMetadata`, so every action on an `[ApiController]` controller carries it.
- `RequestDelegateFactory` (and the Request Delegate Generator used for Native AOT) adds it when a minimal API handler has a JSON body parameter, or when its return type is serialized as JSON.
- The API-oriented `TypedResults` types (`Ok`, `Ok<T>`, `Created`, `Accepted`, `NotFound<T>`, `BadRequest`, `Conflict`, `ValidationProblem`, `ProblemHttpResult`, `JsonHttpResult<T>`, `ServerSentEventsResult<T>` and friends) add it from their `PopulateMetadata`.
- `MapHub` and `MapConnectionHandler` add it for SignalR.

One detail trips people up when they search for this: the Microsoft Learn page still names the marker interface `IApiEndpointMetadata`. That was its name in Preview 7. API review renamed it before GA in [dotnet/aspnetcore#63283](https://github.com/dotnet/aspnetcore/pull/63283), which also added the opt-out `IAllowCookieRedirectMetadata`, the `AllowCookieRedirect`/`DisableCookieRedirect` extension methods, and the AppContext switch. In a shipped .NET 10 app, `IApiEndpointMetadata` does not exist. The types are `IDisableCookieRedirectMetadata` and `IAllowCookieRedirectMetadata` in `Microsoft.AspNetCore.Http.Metadata`.

## Minimal repro

One file-based app, run once against the .NET 9.0.20 runtime and once against 10.0.10:

```csharp
// .NET 10, ASP.NET Core 10.0.10, run with: dotnet run probe.cs
#:sdk Microsoft.NET.Sdk.Web

using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(o => { o.LoginPath = "/login"; o.AccessDeniedPath = "/denied"; });
builder.Services.AddAuthorization();
builder.Services.AddControllers();

var app = builder.Build();
app.UseAuthentication();
app.UseAuthorization();

var m = app.MapGroup("/m").RequireAuthorization();
m.MapGet("/string", () => "plain text");                          // text/plain
m.MapGet("/dto", () => new Todo(1, "json"));                       // JSON response
m.MapGet("/typed", () => TypedResults.Ok(new Todo(1, "typed")));   // TypedResults
m.MapGet("/iresult", () => Results.Ok(new Todo(1, "iresult")));    // returns IResult
m.MapPost("/body", (Todo t) => "got body");                        // JSON request body
app.MapControllers();
app.Run();

public record Todo(int Id, string Title);

[ApiController, Route("c/api"), Authorize]
public class ApiCtl : ControllerBase { [HttpGet] public Todo Get() => new(1, "api"); }

[Route("c/mvc"), Authorize]
public class MvcCtl : Controller { [HttpGet] public Todo Get() => new(1, "mvc"); }
```

These are the results from `curl -D -` with no cookie. The first two columns come from the same code; the third is 10.0.10 with `IgnoreRedirectMetadata` set to `true`:

| Endpoint | 9.0.20 | 10.0.10 | 10.0.10 + switch |
| --- | --- | --- | --- |
| `GET /m/string` (returns `string`) | 302 | 302 | 302 |
| `GET /m/dto` (returns a record) | 302 | **401** | 302 |
| `GET` async handler returning `Task<Todo>` | 302 | **401** | 302 |
| `GET /m/typed` (`TypedResults.Ok`) | 302 | **401** | 302 |
| `Results<Ok<Todo>, NotFound>` | 302 | **401** | 302 |
| `TypedResults.Json(...)` | 302 | **401** | 302 |
| `GET /m/iresult` (`Results.Ok`, declared `IResult`) | 302 | 302 | 302 |
| `TypedResults.Text`, `TypedResults.File`, `TypedResults.Redirect` | 302 | 302 | 302 |
| `POST /m/body` (JSON body) | 302 | **401** | 302 |
| `[ApiController]` action | 302 | **401** | 302 |
| Plain `Controller` action (no `[ApiController]`) | 302 | 302 | 302 |
| Any endpoint with `X-Requested-With: XMLHttpRequest` | 401 | 401 | 401 |
| Signed in, fails `RequireRole`, JSON endpoint | 302 to `/denied` | **403** | 302 to `/denied` |
| Signed in, fails `RequireRole`, `string` endpoint | 302 to `/denied` | 302 to `/denied` | 302 to `/denied` |

So the rule of thumb is not "APIs" in any architectural sense. What matters is the metadata on the endpoint. `Results.Ok(...)` keeps redirecting and `TypedResults.Ok(...)` does not, because `IResult` hides the concrete type from the metadata inference. The difference between the two factories is covered in [typed results vs IResult vs IActionResult](/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/).

## Fix, in detail

Pick the first option that matches what the endpoint actually is.

### 1. The endpoint is called from code: keep the 401 and fix the client

If the caller is `fetch`, `HttpClient`, or a mobile app, the new behaviour is the correct one, and the old `302` to an HTML page was a bug you had worked around. Handle the status code instead of sniffing redirects:

```javascript
// Browser fetch against an ASP.NET Core 10 cookie-authenticated API
const res = await fetch("/api/todos", { credentials: "same-origin" });
if (res.status === 401) {
  // Cookie missing or expired: send the user to the login page ourselves
  location.href = "/login?ReturnUrl=" + encodeURIComponent(location.pathname);
} else if (res.status === 403) {
  location.href = "/denied";
} else {
  const todos = await res.json();
}
```

Remove any `res.redirected` or `res.url.includes("/login")` checks while you are there: on .NET 10 they are dead code for these endpoints. If your SPA and API run on different origins, the credentials and CORS side is its own topic, covered in [JWT vs cookie authentication in ASP.NET Core](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/).

### 2. A browser navigates to the endpoint: opt it back in with `AllowCookieRedirect`

For the few endpoints a user really opens in a tab (an export link that returns JSON, a "view raw" link in an admin page, an `[ApiController]` action the old MVC views link to directly), restore the redirect per endpoint:

```csharp
// .NET 10, ASP.NET Core 10.0.10
app.MapGet("/export/orders", (OrderService s) => s.GetAll())
   .RequireAuthorization()
   .AllowCookieRedirect();

[ApiController, Route("api/reports"), Authorize]
public class ReportsController : ControllerBase
{
    [HttpGet("download"), AllowCookieRedirect]
    public ReportDto Download() => new(/* ... */);
}
```

`IAllowCookieRedirectMetadata` wins over `IDisableCookieRedirectMetadata` regardless of order, so it works on a group too (`app.MapGroup("/export").AllowCookieRedirect()`). In the probe, `/m/dto` with `.AllowCookieRedirect()` went back to `302`, and so did an `[ApiController]` action with `[AllowCookieRedirect]`. The reverse also exists. `.DisableCookieRedirect()` makes a `string`-returning endpoint answer `401`, which is useful for health or diagnostic endpoints that should never show a login page.

### 3. Mixed app: redirect only real browser navigations

If you have many endpoints of both kinds, it is cleaner to decide per request than per endpoint. All current major browsers (Chrome, Edge, Firefox, Safari 16.4+) send [`Sec-Fetch-Mode: navigate`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Sec-Fetch-Mode) on a top-level navigation and `cors`/`same-origin` on `fetch`:

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.LoginPath = "/login";
        options.AccessDeniedPath = "/denied";

        options.Events.OnRedirectToLogin = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            if (IsBrowserNavigation(context.Request))
                context.Response.Redirect(context.RedirectUri);
            else
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        };
    });

// ... app.Run();

static bool IsBrowserNavigation(HttpRequest request)
{
    var mode = request.Headers["Sec-Fetch-Mode"].ToString();
    if (mode.Length > 0)
        return mode == "navigate";

    // Clients without Fetch Metadata headers: fall back to the Accept header
    return HttpMethods.IsGet(request.Method)
        && request.Headers.Accept.ToString().Contains("text/html");
}
```

Measured on 10.0.10 against the `OnRedirectToLogin` half: `/m/dto` with `Sec-Fetch-Mode: navigate` got `302`, `/m/string` with `Sec-Fetch-Mode: cors` got `401`, and a bare `curl` (no Fetch Metadata, `Accept: */*`) got `401` on every endpoint, including the ones the framework would have redirected. Because this replaces the default delegate, the endpoint metadata is no longer consulted at all: the request decides, not the endpoint.

### 4. Always redirect, exactly like before

This is the snippet from the breaking-change page. Use it when the app is a server-rendered site and none of its endpoints has a non-browser caller:

```csharp
// .NET 10, ASP.NET Core 10.0.10
builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        options.Events.OnRedirectToLogin = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
        options.Events.OnRedirectToAccessDenied = context =>
        {
            context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };
    });
```

Note that this also redirects XHRs, which .NET 9 did not. If you want the exact .NET 9 semantics (`401` for `X-Requested-With: XMLHttpRequest`, redirect for everything else), the switch in option 5 does it with one line.

### 5. The AppContext switch: .NET 9 behaviour without writing events

The switch is not on the Microsoft Learn page, but it shipped in 10.0.0 (from PR #63283) and is the least invasive way back to .NET 9 semantics. Set it in the project file:

```xml
<!-- .NET 10, in the web project's .csproj -->
<ItemGroup>
  <RuntimeHostConfigurationOption Include="Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata"
                                  Value="true" />
</ItemGroup>
```

or as the first line of `Program.cs`:

```csharp
// .NET 10, must run before the cookie handler is first used
AppContext.SetSwitch("Microsoft.AspNetCore.Authentication.Cookies.IgnoreRedirectMetadata", true);
```

The `RuntimeHostConfigurationOption` item ends up as a `configProperties` entry in `bin/.../<app>.runtimeconfig.json`. I tested both that entry and the `SetSwitch` call, and each one produced the "10.0.10 + switch" column above: every endpoint redirects again and XHRs still get `401`. Treat it as a migration crutch, not a destination. It turns off the metadata for the whole app, including the marker on SignalR hubs, so an unauthenticated negotiate request is back to the pre-.NET 10 rule: only an `X-Requested-With: XMLHttpRequest` header keeps it from being redirected to an HTML page.

## Gotchas and lookalikes

**You already had a custom `OnRedirectToLogin`.** Then nothing changed for you, and you might wonder why a colleague's app behaves differently. The metadata check lives inside the *default* delegate. Any app that replaced `OnRedirectToLogin` or derived from `CookieAuthenticationEvents` and overrode `RedirectToLogin` bypasses it completely. It also works the other way: if you want the new behaviour *and* a custom event (for example to log failed logins), call your logic and then reproduce the `IDisableCookieRedirectMetadata` check yourself.

**The switch is read once.** `_ignoreCookieRedirectMetadata` is a `static readonly` field on `CookieAuthenticationEvents`. Setting the switch after the first request, or flipping it in a test after the host has started, has no effect.

**Only the cookie handler looks at this metadata.** In the aspnetcore repository the only consumer of `IDisableCookieRedirectMetadata` is `CookieAuthenticationEvents`. If your `DefaultChallengeScheme` is OpenID Connect (Microsoft.Identity.Web, Entra ID, Auth0), the OIDC handler issues the challenge and still redirects to the identity provider for every endpoint. If you see a `401` there, the cookie scheme is the challenge scheme for that endpoint, usually because of an explicit `[Authorize(AuthenticationSchemes = ...)]` or policy.

**Integration tests.** `WebApplicationFactory` clients follow redirects by default, so tests that asserted "unauthenticated request ends up on the login page" now see a `401` for API endpoints. Update the assertion instead of adding `AllowCookieRedirect` just to keep tests green; the setup patterns are in [integration tests with WebApplicationFactory](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/).

**Native AOT behaves the same.** The Request Delegate Generator emits a file-local `DisableCookieRedirectMetadata` class and adds it under the same JSON conditions as the reflection-based factory, so AOT and JIT builds agree.

**.NET 11 keeps it.** The same `IsCookieRedirectDisabledByMetadata` check is on `main`, so if you are going straight from .NET 8 or 9 to 11, this belongs on your list next to the other auth changes in [the .NET 8 to .NET 11 migration checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/).

**Not this issue: 401 with a bearer token, or 405.** If the endpoint uses JWT bearer and you get `401` with a `WWW-Authenticate: Bearer` header, the token itself is being rejected; see [why an ASP.NET Core JWT returns 401 even with a valid token](/2026/06/fix-aspnetcore-jwt-returns-401-even-with-valid-token/). If you get `405` with an `Allow` header, routing rejected the verb before authentication ran; see [405 Method Not Allowed instead of 401 with JWT bearer](/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/). The .NET 10 cookie change always produces `401`/`403` with a `Location` header and no `WWW-Authenticate` header.

## Related

- [JWT vs cookie authentication in ASP.NET Core](/2026/06/jwt-vs-cookie-authentication-in-aspnetcore-11/)
- [Typed results vs IResult vs IActionResult](/2026/07/typed-results-vs-iresult-vs-iactionresult-in-aspnetcore-11/)
- [How to write integration tests with WebApplicationFactory](/2026/07/how-to-write-integration-tests-with-webapplicationfactory-in-aspnetcore-11/)
- [Fix: 405 Method Not Allowed instead of 401 with JWT bearer](/2026/06/fix-405-method-not-allowed-instead-of-401-with-jwt-bearer-in-aspnetcore/)
- [Migrate from .NET 8 to .NET 11: the full checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/)

## Sources

- [Breaking change: Cookie login redirects are disabled for known API endpoints](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/cookie-authentication-api-endpoints) (Microsoft Learn) and the [aspnet/Announcements#525](https://github.com/aspnet/Announcements/issues/525) announcement.
- [dotnet/aspnetcore#62816: Avoid cookie login redirects for known API endpoints](https://github.com/dotnet/aspnetcore/pull/62816), the original change.
- [dotnet/aspnetcore#63283: Address API review feedback for what was IApiEndpointMetadata](https://github.com/dotnet/aspnetcore/pull/63283), the rename, `AllowCookieRedirect`, and the `IgnoreRedirectMetadata` switch.
- [`CookieAuthenticationEvents.cs` at v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Security/Authentication/Cookies/src/CookieAuthenticationEvents.cs) and [`RequestDelegateFactory.cs` at v10.0.12](https://github.com/dotnet/aspnetcore/blob/v10.0.12/src/Http/Http.Extensions/src/RequestDelegateFactory.cs).
- [dotnet/aspnetcore#9039: ApiController redirects to login page](https://github.com/dotnet/aspnetcore/issues/9039), the 2019 request behind the change.
