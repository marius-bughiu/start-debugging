---
title: "Migrate a Blazor Server app to Blazor United (Blazor Web App) in .NET 11"
description: "A step-by-step checklist to move a standalone Blazor Server app to the unified Blazor Web App template on .NET 11, keeping every page on InteractiveServer with zero behaviour change."
pubDate: 2026-06-05
updatedDate: 2026-06-05
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet"
  - "aspnetcore"
  - "csharp"
---

If you have a standalone Blazor Server app (`dotnet new blazorserver`) and you want to move it onto the unified template that was nicknamed "Blazor United" during the .NET 8 preview cycle and shipped as **Blazor Web App**, the migration is mostly mechanical and usually takes half a day for a small app, one to three days for a large one. Nothing about your component code has to change. What changes is the host: `_Host.cshtml` disappears, routing moves into a `Routes` component, `Program.cs` swaps `MapBlazorHub` for `MapRazorComponents`, and you declare a render mode explicitly. Keep every page on `@rendermode InteractiveServer` and behaviour stays identical to .NET 7-era Blazor Server. The single thing that bites is prerendering double-execution. This guide targets **.NET 11** (preview at time of writing, GA scheduled November 2026) and the `Microsoft.AspNetCore.Components` 11.0.x package set.

## Why move off the standalone Server template

The standalone `blazorserver` template still works in .NET 11, so this is not a forced migration. Move when one of these is a real outcome you want, not before:

- **Per-page render modes.** Once on the Web App template you can set a marketing page to `@rendermode StaticServer` (no SignalR circuit, no JavaScript, indexes like a Razor Page) while keeping the dashboard on `InteractiveServer`. You cannot mix modes at all in the standalone template.
- **A path to WebAssembly and Auto without a rewrite.** Adding an offline-capable widget later means adding a `.Client` project and one `@rendermode InteractiveWebAssembly`, not porting the whole app.
- **You are on Microsoft's recommended default.** Templates, docs samples, and new tutorials all lead with the Blazor Web App template since .NET 8. Staying on standalone Server is now a deviation you have to justify in code review.
- **Resilient circuit state in .NET 10+.** The Web App template plus the `[PersistentState]` attribute can restore component state when a dropped SignalR circuit reconnects, which the old `ServerPrerendered` model never did cleanly.

If none of those apply, a `<TargetFramework>net11.0</TargetFramework>` bump on your existing standalone Server app is a valid alternative and is not this migration.

## What breaks

| Area                       | Change                                                                                      | Severity |
| -------------------------- | ------------------------------------------------------------------------------------------- | -------- |
| Host page                  | `Pages/_Host.cshtml` and `_Layout.cshtml` are replaced by a root `App.razor` host component | high     |
| Routing                    | `<Router>` moves out of `App.razor` into a new `Routes.razor`                                | high     |
| `Program.cs` startup       | `AddServerSideBlazor()` + `MapBlazorHub()` + `MapFallbackToPage("/_Host")` replaced by `AddRazorComponents().AddInteractiveServerComponents()` + `MapRazorComponents<App>().AddInteractiveServerRenderMode()` | high     |
| Render mode                | Interactivity is opt-in per component or global; no implicit "whole app is interactive"      | high     |
| Prerendering               | `OnInitialized`/`OnInitializedAsync` run twice (prerender pass + interactive pass) by default | medium   |
| Client script              | `_framework/blazor.server.js` becomes `_framework/blazor.web.js`                             | medium   |
| Auth wiring                | `CascadingAuthenticationState` component is replaced by `AddCascadingAuthenticationState()` DI | medium   |
| `HttpContext` access       | `HttpContext` is only available during static SSR, not inside an interactive component       | medium   |
| `App.razor` semantics      | `App.razor` is no longer the router; it is the HTML document shell                            | low      |

## Pre-flight checklist

- Install the **.NET 11 SDK** (`dotnet --version` reports `11.0.1xx`). Confirm with `dotnet --list-sdks`.
- Commit a clean checkpoint and **create a branch**. This migration deletes files; you want an easy way back.
- Note your current entry point. Standalone Blazor Server uses either `_Host.cshtml` (the common pre-.NET 8 layout) or already an `App.razor` host. The steps below assume `_Host.cshtml`.
- Inventory every `OnInitializedAsync` that has side effects (writes, analytics events, one-time fetches). These are the methods prerendering will run twice. You will revisit each one in step 7.
- Update your CI to a .NET 11 SDK image and confirm a baseline `dotnet build` and `dotnet test` pass on the current code before you touch anything.
- Scaffold a throwaway reference app with `dotnet new blazor --interactivity Server -o _ref` so you have a known-good `App.razor`, `Routes.razor`, and `Program.cs` to copy structure from.

## Migration steps

### 1. Bump the target framework and packages

Edit the `.csproj`. The SDK stays `Microsoft.NET.Sdk.Web`.

```xml
<!-- .NET 11 -->
<PropertyGroup>
  <TargetFramework>net11.0</TargetFramework>
  <Nullable>enable</Nullable>
  <ImplicitUsings>enable</ImplicitUsings>
</PropertyGroup>
```

Bump any `Microsoft.AspNetCore.Components.*` package references to `11.0.x`. Remove `Microsoft.AspNetCore.Components.Web` if it is referenced explicitly; it is part of the framework reference for web SDK projects.

Verify: `dotnet restore` succeeds and `dotnet build` fails only with errors about the host page and `Program.cs` (expected at this point), not package resolution errors.

### 2. Create the `App.razor` host component

In the standalone Server template, the HTML document lives in `Pages/_Host.cshtml` and `Pages/_Layout.cshtml`. Move that markup into a new root `App.razor` (delete the old `App.razor` router first, or rename it). The `<component>` tag helper that bootstrapped the root becomes `<Routes />`.

```razor
@* .NET 11 - App.razor is now the HTML document shell, not the router *@
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <base href="/" />
    <link rel="stylesheet" href="app.css" />
    <link rel="stylesheet" href="YourApp.styles.css" />
    <HeadOutlet />
</head>
<body>
    <Routes />
    <script src="_framework/blazor.web.js"></script>
</body>
</html>
```

Two changes that are easy to miss: the script is `blazor.web.js` (not `blazor.server.js`), and `<HeadOutlet />` plus `<Routes />` are components, so they pick up whatever render mode you assign in step 6.

Verify: the file compiles as a Razor component (no `@page` directive, no `@model`).

### 3. Move routing into `Routes.razor`

Create `Routes.razor` in the project root and paste the `<Router>` block that used to live in the old `App.razor`.

```razor
@* .NET 11 - Routes.razor holds the router that used to be in App.razor *@
<Router AppAssembly="@typeof(Program).Assembly">
    <Found Context="routeData">
        <RouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
        <FocusOnNavigate RouteData="@routeData" Selector="h1" />
    </Found>
    <NotFound>
        <PageTitle>Not found</PageTitle>
        <LayoutView Layout="@typeof(Layout.MainLayout)">
            <p role="alert">Sorry, there's nothing at this address.</p>
        </LayoutView>
    </NotFound>
</Router>
```

Verify: a `dotnet build` no longer complains about a missing `Routes` type.

### 4. Enable render-mode shorthands in `_Imports.razor`

Add this line to `_Imports.razor` so you can write `InteractiveServer` instead of fully qualifying it:

```razor
@* .NET 11 *@
@using static Microsoft.AspNetCore.Components.Web.RenderMode
```

Verify: `@rendermode InteractiveServer` in a component resolves without a using error.

### 5. Rewrite `Program.cs`

Swap the Blazor Server registration and endpoints for the Razor Components equivalents.

```csharp
// .NET 11, C# 14 - Blazor Web App startup
var builder = WebApplication.CreateBuilder(args);

builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

// keep your existing app services here (DbContext, HttpClient, etc.)

var app = builder.Build();

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    app.UseHsts();
}

app.UseHttpsRedirection();
app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
```

Delete `AddServerSideBlazor()`, `app.MapBlazorHub()`, and `app.MapFallbackToPage("/_Host")`. The `app.UseAntiforgery()` call is new and required; the Web App template enables antiforgery middleware by default and form posts fail without it.

Verify: `dotnet build` succeeds with zero errors.

### 6. Turn the app interactive (global render mode)

The lowest-risk migration makes the whole app `InteractiveServer`, reproducing the old behaviour exactly. Set the render mode on `<Routes />` and `<HeadOutlet />` in `App.razor`:

```razor
@* .NET 11 - global InteractiveServer, matches standalone Blazor Server behaviour *@
<HeadOutlet @rendermode="InteractiveServer" />
...
<Routes @rendermode="InteractiveServer" />
```

Verify: run `dotnet run`, open the app, and confirm interactive components (buttons, `@onclick`, `EditForm` submits) work and the browser holds an open WebSocket to `/_blazor`. Once this works, you can later drop individual pages to `@rendermode StaticServer` or escalate islands to WebAssembly, but that is post-migration work.

### 7. Handle prerendering double-execution

This is the one behavioural change that surprises people. With an interactive render mode, Blazor prerenders static HTML first, then renders again over the live circuit, so `OnInitialized` and `OnInitializedAsync` run twice. The old standalone Server default (`render-mode="ServerPrerendered"`) had the same property, but many apps used `render-mode="Server"` and never saw it.

You have three options. The cleanest in .NET 11 is the declarative `[PersistentState]` attribute (added in .NET 10): fetch once during prerender, serialize into the HTML, restore on the interactive pass.

```csharp
// .NET 11 - fetch once, survive the prerender-to-interactive handoff
public partial class Dashboard : ComponentBase
{
    [PersistentState]
    public List<Order>? Orders { get; set; }

    [Inject] public required IOrderService OrderService { get; init; }

    protected override async Task OnInitializedAsync()
    {
        // Orders is non-null on the interactive pass: state was restored,
        // so the service is not hit a second time.
        Orders ??= await OrderService.GetRecentAsync();
    }
}
```

If you do not want to fetch during prerender at all, disable prerendering for that boundary:

```razor
@* .NET 11 - skip the prerender pass entirely for this component tree *@
<Routes @rendermode="new InteractiveServerRenderMode(prerender: false)" />
```

Verify: put a breakpoint or log line in each side-effecting `OnInitializedAsync` and confirm it runs once per real navigation, not twice.

### 8. Re-wire authentication and authorization

If your app used `<CascadingAuthenticationState>` wrapping the router, remove that component and register it in DI instead, then switch `RouteView` to `AuthorizeRouteView` in `Routes.razor`.

```csharp
// .NET 11 - Program.cs
builder.Services.AddCascadingAuthenticationState();
```

```razor
@* .NET 11 - Routes.razor, authorized routing *@
<AuthorizeRouteView RouteData="@routeData" DefaultLayout="@typeof(Layout.MainLayout)" />
```

Verify: hit a `[Authorize]` page while signed out and confirm you are redirected, then signed in and confirm access.

### 9. Delete the dead host files

Remove `Pages/_Host.cshtml`, `Pages/_Layout.cshtml`, and any `app.MapRazorPages()` call that existed only to serve `_Host`. Drop `AddRazorPages()` from `Program.cs` if nothing else uses Razor Pages.

Verify: `dotnet build` is clean and the app still serves every route.

## Verification: the post-migration smoke test

Run all of these before you merge:

- `dotnet build -c Release` reports zero warnings related to render modes.
- `dotnet test` passes with the same count as your pre-migration baseline.
- The app starts with `dotnet run` and the home page renders.
- An interactive control (`@onclick`, `EditForm`) works and the browser keeps a `/_blazor` WebSocket open.
- A page navigation does not double-fire a side effect (the step 7 check, repeated end to end).
- An `[Authorize]`-protected route redirects when signed out.
- A form POST succeeds (this is the antiforgery middleware check from step 5).
- View source on a page: the markup is prerendered HTML, not an empty `<div id="app">`.

## Rollback plan

This migration is reversible only if you kept the branch from the pre-flight step. Once you delete `_Host.cshtml` and rewrite `Program.cs`, there is no in-place toggle back to the standalone Server model. Roll back by checking out the pre-migration commit, not by editing forward. Because the change is structural and not a data migration, there is nothing to undo in your database or storage. Branch, do the work, verify against the smoke test, and merge only when green.

## Gotchas we hit

- **Forgetting `app.UseAntiforgery()`.** The Web App template requires antiforgery middleware. Without the call, every `EditForm` POST returns a 400 with `Antiforgery token validation failed`. The standalone Server template did not need this because form handling went over the SignalR circuit, not HTTP POST.
- **`HttpContext` is null inside interactive components.** In standalone Server you could sometimes reach `IHttpContextAccessor` from a component. Under the Web App template, `HttpContext` exists only during the static SSR pass. Read what you need (headers, cookies, the authenticated user) during prerender and pass it down, or use the cascading `AuthenticationState`.
- **`blazor.server.js` left in the markup.** If you copy the old `_Host.cshtml` script tag verbatim, the page loads but no circuit opens and nothing is interactive. It must be `_framework/blazor.web.js`.
- **Scoped services behaving differently across the prerender boundary.** A service resolved during prerender and again during the interactive pass is two different scopes. If you cached per-request state in a scoped service expecting it to survive, it will not. This is the same class of problem covered in [Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/).
- **Static assets 404 after the move.** The Web App template serves component-scoped CSS as `YourApp.styles.css`. If your old `_Layout.cshtml` referenced a differently named bundle, the link breaks silently. Check the `<link>` hrefs in the new `App.razor`.

The destination here is almost always "every page on `InteractiveServer`, prerendering handled". That is the migration that changes nothing the user can see. Adding Static Server pages, WebAssembly islands, and Auto components is the payoff you collect afterwards, one component at a time, with no further structural churn.

## Related

- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11: which should you pick](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) for the decision behind the destination template.
- [How to share validation logic between server and Blazor WebAssembly](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) for the shared-project pattern you will want once you add WASM components.
- [Blazor SSR finally gets TempData in .NET 11](/2026/04/blazor-ssr-tempdata-dotnet-11/) for Post-Redirect-Get flows on the static SSR pages you can now add.
- [Fix: Cannot consume scoped service from singleton](/2026/05/fix-cannot-consume-scoped-service-from-singleton/) for the scope lifetime issues the prerender boundary exposes.
- [Migrate from .NET Framework 4.8 to .NET 11 in 2026](/2026/05/migrate-from-dotnet-framework-4-8-to-dotnet-11-in-2026/) if this Blazor move is part of a larger framework jump.

## Sources

- [ASP.NET Core Blazor render modes](https://learn.microsoft.com/aspnet/core/blazor/components/render-modes), Microsoft Learn, accessed 2026-06-05.
- [ASP.NET Core Blazor prerendered state persistence](https://learn.microsoft.com/aspnet/core/blazor/state-management/prerendered-state-persistence), Microsoft Learn, for the `[PersistentState]` attribute added in .NET 10.
- [Migrate from ASP.NET Core in .NET 7 to .NET 8](https://learn.microsoft.com/aspnet/core/migration/70-to-80), Microsoft Learn, for the original Blazor Server to Web App host restructuring steps.
- [ASP.NET Core Razor component lifecycle](https://learn.microsoft.com/aspnet/core/blazor/components/lifecycle), Microsoft Learn, for the prerender double-execution behaviour.
</content>
</invoke>
