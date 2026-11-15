---
title: "Fix: OnInitializedAsync not called with InteractiveWebAssemblyRenderMode(prerender: false) after upgrading Blazor to .NET 10"
description: "Upgraded to .NET 10 and the WASM page stays blank? blazor.web.js is a 404. Switch UseStaticFiles to MapStaticAssets, or set RequiresAspNetWebAssets for Docker builds."
pubDate: 2026-11-15
template: error-page
tags:
  - "errors"
  - "blazor"
  - "blazor-webassembly"
  - "dotnet-10"
  - "aspnet-core"
  - "migration"
---

When a Blazor Web App page with `@rendermode @(new InteractiveWebAssemblyRenderMode(prerender: false))` stops calling `OnInitialized`/`OnInitializedAsync` after a .NET 9 to .NET 10 upgrade, the lifecycle is not the problem. The browser never got `/_framework/blazor.web.js` (it returns 404), so Blazor never starts and the component is never created. On .NET 10 that script is a static web asset, no longer an endpoint built into the framework. Replace `app.UseStaticFiles()` with `app.MapStaticAssets()`. If your Docker build restores before copying the `.razor` files, also set `<RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>`. Everything below was measured with SDK 10.0.302 (ASP.NET Core 10.0.10) and SDK 9.0.321 (ASP.NET Core 9.0.23) on macOS, in a Chromium-based browser.

## The symptom in context

This post started from a [Stack Overflow question](https://stackoverflow.com/questions/79821695): a page that worked on .NET 9 stopped running its lifecycle methods on .NET 10. The only answer suggests a different `@rendermode` syntax, and it is downvoted. The render mode syntax does not matter. Here is what the broken page actually does in the browser:

- The page body is empty. With `prerender: false` the server renders only a placeholder comment, so there is nothing to see until WebAssembly takes over.
- The yellow "An unhandled error has occurred" bar does **not** appear (`#blazor-error-ui` stays `display: none`).
- `window.Blazor` is `undefined`.
- The console has exactly one error, and it does not mention Blazor:

```text
Failed to load resource: the server responded with a status of 404 (Not Found)
GET http://localhost:5310/_framework/blazor.web.js -> 404 Not Found
```

With `Logging__LogLevel__Microsoft.AspNetCore=Debug`, the server log shows where the request went:

```text
dbug: Microsoft.AspNetCore.Routing.Matching.DfaMatcher[1005]
      Endpoint '(null)' with route pattern '/_framework/{*path}' is valid for the request path '/_framework/blazor.web.js'
dbug: Microsoft.AspNetCore.StaticFiles.StaticFileMiddleware[15]
      Static files was skipped as the request already matched an endpoint.
info: Microsoft.AspNetCore.Hosting.Diagnostics[16]
      Request reached the end of the middleware pipeline without being handled by application code. Request path: GET http://localhost:5310/_framework/blazor.web.js, Response status code: 404
```

If your symptom has a .NET exception in the console instead, skip to the lookalikes section further down. You have a different problem.

## Why blazor.web.js disappears on .NET 10

On .NET 8 and 9, `blazor.web.js` was embedded in `Microsoft.AspNetCore.Components.Endpoints.dll`, and `MapRazorComponents<App>()` added a dedicated endpoint for `/_framework/blazor.web.js` that served it through a `ManifestEmbeddedFileProvider`. Your static file setup did not matter, because the framework handled that URL itself. You can see the endpoint in [`RazorComponentEndpointDataSource.cs` on `release/9.0`](https://github.com/dotnet/aspnetcore/blob/release/9.0/src/Components/Endpoints/src/Builder/RazorComponentEndpointDataSource.cs) (display name "Blazor web static files"). On `release/10.0` it is gone.

.NET 10 stopped embedding the scripts ([dotnet/aspnetcore#58783](https://github.com/dotnet/aspnetcore/issues/58783), implemented in [#58721](https://github.com/dotnet/aspnetcore/pull/58721)) so they can be compressed and fingerprinted like any other asset. They now ship in the `Microsoft.AspNetCore.App.Internal.Assets` package, which the SDK adds implicitly at restore time, and they reach the browser as static web assets. That breaks in two ways.

**Cause 1: `UseStaticFiles` without `MapStaticAssets`, plus the WebAssembly render mode.** When the app does not call `MapStaticAssets()`, `AddInteractiveWebAssemblyRenderMode()` falls back to "the 8.0 approach" (that is the source comment in [`WebAssemblyEndpointProvider.cs`](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/Server/src/WebAssemblyEndpointProvider.cs)). It maps a catch-all endpoint, `/_framework/{*path}`, whose branch serves only the client project's framework files. On .NET 9 the more specific `/_framework/blazor.web.js` endpoint won the match. On .NET 10 nothing more specific exists, so the catch-all takes the request and returns 404. Because the request has already matched an endpoint, your `UseStaticFiles()` never looks at it, even when `blazor.web.js` sits right there in `wwwroot/_framework` of the publish folder. Apps that started on .NET 8 often still have `UseStaticFiles()`, since only the .NET 9 template switched to `MapStaticAssets()`.

**Cause 2: the assets package was never restored.** The SDK only adds the implicit `Microsoft.AspNetCore.App.Internal.Assets` reference when the project contains `.razor` files *at restore time*. A Dockerfile that copies only `*.csproj`, runs `dotnet restore`, then copies the sources and builds with `--no-restore` produces a publish folder with no `blazor.web.js` at all ([dotnet/aspnetcore#69341](https://github.com/dotnet/aspnetcore/issues/69341)). Every command exits 0.

## Minimal repro

First I checked the premise. On fresh `dotnet new blazor -int WebAssembly` templates for 9.0 and 10.0, `OnInitializedAsync` runs with `prerender: false` on both. So did four "half-upgraded" variants of the .NET 9 app retargeted to `net10.0`, with every combination of `Microsoft.AspNetCore.Components.WebAssembly.Server` and `Microsoft.AspNetCore.Components.WebAssembly` left at 9.0.23 or bumped to 10.0.10. Leftover package versions do not cause this. The probe component, in the `.Client` project:

```razor
@* .NET 9.0.23 / .NET 10.0.10, App.Client/Pages/Probe.razor *@
@page "/probe"
@rendermode @(new InteractiveWebAssemblyRenderMode(prerender: false))

<h1>Probe</h1>
<p id="status">@status</p>

@code {
    private string status = "OnInitializedAsync has not run";

    protected override async Task OnInitializedAsync()
    {
        Console.WriteLine($"PROBE OnInitializedAsync: runtime {Environment.Version}, renderer {RendererInfo.Name}, interactive {RendererInfo.IsInteractive}");
        await Task.Yield();
        status = $"OnInitializedAsync ran on {RendererInfo.Name} (.NET {Environment.Version})";
    }
}
```

The break shows up as soon as the server project uses the pre-.NET 9 static file pipeline:

```csharp
// .NET 10.0.10, App/Program.cs: the .NET 8-era pipeline that breaks
builder.Services.AddRazorComponents()
    .AddInteractiveWebAssemblyComponents();

var app = builder.Build();
// ...
app.UseHttpsRedirection();
app.UseAntiforgery();

app.UseStaticFiles();          // not MapStaticAssets()

app.MapRazorComponents<App>()
    .AddInteractiveWebAssemblyRenderMode()
    .AddAdditionalAssemblies(typeof(App.Client._Imports).Assembly);

app.Run();
```

Here is the same source built for each target framework. `GET /_framework/blazor.web.js` was checked with curl, and the page was checked in the browser:

| Server pipeline | How it ran | .NET 9.0.23 | .NET 10.0.10 |
| --- | --- | --- | --- |
| `MapStaticAssets()` (template) | `dotnet run`, Development | 200, initializer runs | 200, initializer runs |
| `UseStaticFiles()` | `dotnet run`, Development | 200, initializer runs | **404, page blank** |
| `UseStaticFiles()` | `dotnet publish` folder, Production | n/a | **404, page blank** (file is on disk) |
| `UseStaticFiles()` before `UseRouting()` | `dotnet run` and publish folder | n/a | 200, initializer runs |
| `MapStaticAssets()`, restore before `.razor` copied | publish folder, Production | n/a | **404** (`blazor.web.js` missing) |
| same, with `RequiresAspNetWebAssets=true` | publish folder, Production | n/a | 200 (`blazor.web.f7fxoh55ae.js`) |

## Fix 1: switch to MapStaticAssets

This is the fix to use unless something forces you to stay on `UseStaticFiles`. It matches the .NET 9 and .NET 10 templates, and [Static files in ASP.NET Core Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) documents it.

1. Replace `app.UseStaticFiles();` with `app.MapStaticAssets();`. Keep it before `app.MapRazorComponents<App>()`.
2. Optionally, reference the script through the asset map in `App.razor` so it gets the fingerprinted URL and long cache headers: `<script src="@Assets["_framework/blazor.web.js"]"></script>`. The .NET 9 form `<script src="_framework/blazor.web.js"></script>` still works with `MapStaticAssets`. I left it in place in the upgraded test app and the initializer ran.
3. Rebuild (not just restart) and reload with the cache disabled.

```csharp
// .NET 10.0.10, App/Program.cs: fixed
app.UseHttpsRedirection();
app.UseAntiforgery();

app.MapStaticAssets();

app.MapRazorComponents<App>()
    .AddInteractiveWebAssemblyRenderMode()
    .AddAdditionalAssemblies(typeof(App.Client._Imports).Assembly);
```

`MapStaticAssets` registers an endpoint for every asset in the build manifest, including the framework scripts. The WebAssembly provider sees the resulting `ResourceAssetCollection` and skips its catch-all fallback entirely.

## Fix 2: keep UseStaticFiles, but run it before routing

Some apps cannot drop `UseStaticFiles`: files written to `wwwroot` at runtime, a custom `IFileProvider`, or a `StaticFileOptions.OnPrepareResponse` hook. In that case, make static files run before endpoint routing, so the catch-all endpoint has not matched yet. `WebApplication` inserts `UseRouting()` at the very start of the pipeline unless you call it yourself, so the explicit call is what makes this work:

```csharp
// .NET 10.0.10, App/Program.cs: UseStaticFiles kept, routing made explicit
app.UseHttpsRedirection();

app.UseStaticFiles();
app.UseRouting();      // must come after UseStaticFiles
app.UseAntiforgery();  // antiforgery still has to follow routing

app.MapRazorComponents<App>()
    .AddInteractiveWebAssemblyRenderMode()
    .AddAdditionalAssemblies(typeof(App.Client._Imports).Assembly);
```

Measured: `blazor.web.js` returned 200 under `dotnet run` and from a Production publish folder, `dotnet.js` was served too, and `OnInitializedAsync` ran. You lose compression negotiation and fingerprinting for the framework scripts. If you only need `UseStaticFiles` for a few runtime files, a cleaner option is to call both `MapStaticAssets()` and `UseStaticFiles()`, which the [static files docs](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/static-files?view=aspnetcore-10.0) describe for large or dynamic asset sets.

Do not expect this to be fixed in the framework. The upstream report of exactly this setup, [dotnet/aspnetcore#64381](https://github.com/dotnet/aspnetcore/issues/64381), was closed as "not planned" in July 2026.

## Fix 3: Docker builds that restore before copying sources

If the page works locally but is blank in the container, look at the publish output first:

```bash
# .NET 10, inside the build stage or against the extracted image
ls publish/wwwroot/_framework | grep '^blazor\.'
```

My reproduction of the layered pattern (copy only the two `.csproj` files, `dotnet restore`, copy everything else, `dotnet build --no-restore`, `dotnet publish --no-build`) produced only `blazor.webassembly.js*`. `blazor.web.js` and `blazor.server.js` were missing, and the page referenced the unfingerprinted `_framework/blazor.web.js`, which returned 404. Adding the documented opt-in to the server project fixed it with the same Dockerfile order:

```xml
<!-- .NET 10, App/App.csproj -->
<PropertyGroup>
  <TargetFramework>net10.0</TargetFramework>
  <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
</PropertyGroup>
```

After that, `obj/project.assets.json` listed `Microsoft.AspNetCore.App.Internal.Assets >= 10.0.10`, publish contained `blazor.web.js`, `.br` and `.gz`, and the page loaded `_framework/blazor.web.f7fxoh55ae.js` with a 200. The property is documented in [ASP.NET Core Blazor project structure](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0) for hosts with no `.razor` files, and it covers the restore-ordering case for the same reason. The other fix is a single `dotnet publish` without `--no-restore`, which loses Docker's restore-layer caching.

## Lookalikes that fail loudly on both versions

I ran these next to the real cause on 9.0.23 and 10.0.10. In each one `OnInitializedAsync` never runs, but the console says why, and the behavior is identical across versions. If one of these matches your console output, the upgrade is not the cause.

| What is wrong | Console error (as printed on 9.0.23) |
| --- | --- |
| A service injected with `@inject` is registered only in the server's `Program.cs` | `Cannot provide a value for property 'Greeter' on type '...NeedsService'. There is no registered service of type '...IGreeter'.` |
| The page lives in the server project but uses a WebAssembly render mode | `Root component type 'App.Components.Pages.ServerWasm' could not be found in the assembly 'App'.` |
| The client `Program.cs` throws before `RunAsync()` | your exception message, e.g. `PROBE client startup failed` |
| A server page and a client page share the same `@page` route | HTTP 500, `AmbiguousMatchException: The request matched multiple endpoints.` |

DI is the one most likely to hit the Stack Overflow code, which injects a custom `AuthenticationStateProvider`. Component activation resolves `@inject` properties before any lifecycle method runs, so a service registered only on the server stops the component before `OnInitialized`. Register it in the `.Client` project's `Program.cs`. Keep the server registration too if you ever turn prerendering back on, because the prerender pass resolves the same `@inject` on the server, and the initializer then runs once on each side. [The render mode explainer](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/) covers that double run in detail.

Two more traps that make a working initializer look dead:

- **`Console.WriteLine` goes to the browser console, not the terminal.** A WebAssembly component runs in the browser. If you are watching `dotnet run` output for your log line, you will never see it, on any version.
- **The .NET 10 Debug build printed a resource key instead of the outer exception message.** The same DI failure printed `ManagedError: One or more errors occurred. (...)` on 9.0.23 and `ManagedError: AggregateException_ctor_DefaultMessage (...)` on 10.0.10. The inner message is still there in the parentheses, so read those.

One more note on versions: on restore, SDK 10.0.302 flagged `Microsoft.AspNetCore.Components.WebAssembly.Server` 10.0.10 with NU1903 (high-severity advisories). The results above do not depend on the patch level, but while you upgrade, move to the current 10.0.x patch (10.0.15 on NuGet as of this writing).

## Related

- [Migrating a Blazor app whose pages live in another assembly from .NET 8 to .NET 10](/2026/10/migrate-blazor-routable-components-from-another-assembly-dotnet-8-to-dotnet-10/) covers the related thin-host 404 (a host project with no `.razor` files).
- [What a Blazor render mode is and which one runs your component](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/) explains `RendererInfo`, propagation, and double initialization.
- [Blazor WebAssembly on .NET 10 ignoring the Blazor-Environment header](/2026/11/fix-blazor-webassembly-dotnet-10-ignores-blazor-environment-header/) is another boot-time behavior change in the same release.
- [A 404 for blazor.server.js after installing a new .NET SDK](/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/) is the Blazor Server version of a missing framework script.
- [JavaScript interop calls cannot be issued at this time](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/) is the error to expect once the initializer runs again with prerendering on.

## Sources

- [Stack Overflow 79821695: lifecycle methods not triggered with `InteractiveWebAssemblyRenderMode(prerender: false)` on .NET 10](https://stackoverflow.com/questions/79821695)
- [dotnet/aspnetcore#58783: Stop embedding JS files in Endpoints and Server assemblies](https://github.com/dotnet/aspnetcore/issues/58783) and [PR #58721](https://github.com/dotnet/aspnetcore/pull/58721)
- [`WebAssemblyEndpointProvider.cs` on release/10.0](https://github.com/dotnet/aspnetcore/blob/release/10.0/src/Components/WebAssembly/Server/src/WebAssemblyEndpointProvider.cs)
- [dotnet/aspnetcore#63962: blazor.web.js not found after migrating to .NET 10](https://github.com/dotnet/aspnetcore/issues/63962)
- [dotnet/aspnetcore#64381: Blazor app with UseStaticFiles will not serve blazor.web.js in .NET 10](https://github.com/dotnet/aspnetcore/issues/64381)
- [dotnet/aspnetcore#69341: Internal.Assets only injected when .razor files exist at restore time](https://github.com/dotnet/aspnetcore/issues/69341)
- [ASP.NET Core Blazor project structure: `RequiresAspNetWebAssets`](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0)
- [Static files in ASP.NET Core Blazor](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0)
