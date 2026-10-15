---
title: "Migrate a Blazor App With Routable Components in Another Assembly from .NET 8 to .NET 10"
description: "Upgrading a Blazor Web App whose pages live in a Razor class library or a .Client project from .NET 8 to .NET 10: what stays the same (both AdditionalAssemblies registrations), and the four things that break, from a 404 on blazor.web.js in thin hosts to NotFoundPage pages that render blank. Measured on ASP.NET Core 8.0.32 and 10.0.10."
pubDate: 2026-10-15
updatedDate: 2026-10-15
template: migration
tags:
  - "migration"
  - "blazor"
  - "dotnet-10"
  - "dotnet-8"
  - "aspnet-core"
  - "razor-class-library"
---

If your .NET 8 Blazor Web App renders pages that live in another assembly (a Razor class library, a `.Client` project, a feature module), the routing contract does not change on .NET 10: the endpoint side still needs `MapRazorComponents<App>().AddAdditionalAssemblies(...)` and the interactive `Router` still needs its `AdditionalAssemblies` parameter. I ran the same seven-case registration matrix on ASP.NET Core 8.0.32 and 10.0.10 and every case gave the same result. What breaks is around it: a host with no `.razor` files of its own stops serving `blazor.web.js`, a `NotFoundPage` that lives in the library renders an empty 404 unless the library is registered on the endpoint side, the old `<NotFound>` fragment is obsolete, and the "Assembly already defined" error moves from your `Program.cs` line to app startup. For a typical solution with one or two page libraries, the upgrade takes under an hour. Everything below was built with SDK 10.0.302 and `Microsoft.AspNetCore.Components.Web` 10.0.13.

## Why move off .NET 8 now

- **.NET 8 support ends on 10 November 2026.** .NET 10 is the current LTS and is supported until November 2028. After that date, .NET 8 apps stop getting security patches.
- **`NotFoundPage` works across assemblies.** .NET 10 can render a routable not-found page from your shared library for unknown URLs, `NavigationManager.NotFound()` calls, and status code re-execution, instead of an inline fragment duplicated in every host.
- **Static assets get fingerprinted and compressed.** `MapStaticAssets` (added in .NET 9) serves the library's `_content/...` files and the Blazor script with build-time compression and ETags, which helps page libraries that ship their own CSS and JS.

## What changes between .NET 8 and .NET 10

| Area | Change | Severity |
| --- | --- | --- |
| Host with no `.razor` files | `blazor.web.js` is a static web asset in .NET 10 and is only emitted when the project contains a component. Thin hosts get a 404. | high |
| `NotFoundPage` in a library | The page must have `@page`, and its assembly must be passed to `AddAdditionalAssemblies`, or the 404 response is empty | medium |
| `<NotFound>` fragment | `[Obsolete]`, and throws if combined with `NotFoundPage` | medium |
| RCL package reference | `Microsoft.AspNetCore.Components.Web` 8.0.x must move to 10.0.x | low |
| Duplicate assembly registration | "Assembly already defined" is thrown during startup, not at the `AddAdditionalAssemblies` call | low |
| Member names in library components | `ComponentBase` gained `RendererInfo` and `AssignedRenderMode` in .NET 9; a component member with the same name now hides it (CS0108) | low |
| `UseStaticFiles` | Still works after publish, but the migration guide replaces it with `MapStaticAssets` | low |

## The two registrations, and what each one controls

This is the part most migrations get wrong, usually because the .NET 7 Blazor Server app only needed one of them. A Blazor Web App has two routers. ASP.NET Core endpoint routing handles the first HTTP request (and every enhanced navigation request) and needs to know which assemblies contain `@page` components. The Blazor `Router` component handles navigation once it runs interactively, and it builds its own route table from `AppAssembly` plus `AdditionalAssemblies`.

Here is the test setup: a host created from the .NET 8 `blazor` template with Interactive Server, and a Razor class library `Shared.Pages` with one page.

```razor
@* Shared.Pages/Pages/Reports.razor, .NET 8 and .NET 10 *@
@page "/reports"
@rendermode InteractiveServer

<h1>Reports (from Shared.Pages)</h1>
<p>Rendered from @GetType().Assembly.GetName().Name</p>
<button @onclick="() => count++">Clicked @count</button>

@code {
    int count;
}
```

I toggled each registration and the render mode of `<Routes />` with environment variables, then requested `/reports` directly. The results were identical on 8.0.32 and 10.0.10:

| `Router.AdditionalAssemblies` | `AddAdditionalAssemblies` | `<Routes>` render mode | `GET /reports` |
| --- | --- | --- | --- |
| not set | not set | static | 404 |
| set | not set | static | 404 |
| not set | set | static | 200 |
| set | set | static | 200 |
| set | not set | `InteractiveServer` | 404 |
| not set | set | `InteractiveServer` | 200, then "not found" once the circuit starts |
| set | set | `InteractiveServer` | 200 |

The sixth row is the confusing one. The server prerenders the page correctly, the browser shows it for a moment, and then the interactive `Router` takes over, cannot find `/reports` in its own route table, and replaces the page with the not-found content. I confirmed that in a browser on both versions. The fifth row is the opposite mistake: the interactive router knows the page, but the very first request never reaches it, because no endpoint exists.

So the rule for both versions is simple: **register every assembly that contains routable components in both places.** If the `Routes` component lives in the server project, its `AdditionalAssemblies` must include the `.Client` assembly too.

## Pre-flight checklist

1. .NET 10 SDK installed (`dotnet --list-sdks` shows `10.0.1xx` or later; I used 10.0.302). If a `global.json` pins 8.0, update it.
2. A list of every assembly that contains `@page` components. `grep -rln "@page" --include=*.razor .` and group the hits by project.
3. Every place that registers them. `grep -rn "AdditionalAssemblies" --include=*.razor --include=*.cs .` should show one `Router` and one `MapRazorComponents` chain per host. If it shows only one, you already have the bug from the matrix above.
4. A list of the URLs that must keep working, including one URL from each library and one that should 404. You will curl these after each step.

## Migration steps

1. **Retarget every project and bump the library's package.** Change `<TargetFramework>net8.0</TargetFramework>` to `net10.0` in the host, the `.Client` project, and each Razor class library. The RCL template references `Microsoft.AspNetCore.Components.Web` as a package, so it also needs a new version:

   ```xml
   <!-- Shared.Pages.csproj, .NET 10 -->
   <Project Sdk="Microsoft.NET.Sdk.Razor">
     <PropertyGroup>
       <TargetFramework>net10.0</TargetFramework>
       <Nullable>enable</Nullable>
       <ImplicitUsings>enable</ImplicitUsings>
     </PropertyGroup>
     <ItemGroup>
       <SupportedPlatform Include="browser" />
     </ItemGroup>
     <ItemGroup>
       <PackageReference Include="Microsoft.AspNetCore.Components.Web" Version="10.0.13" />
     </ItemGroup>
   </Project>
   ```

   If other apps still consume the library on .NET 8, multi-target it with `<TargetFrameworks>net8.0;net10.0</TargetFrameworks>` and condition the package version on `$(TargetFramework)`. Verify with `dotnet build` and read the warnings: a CS0108 on a library component means it declares a member that now hides a `ComponentBase` member (see the gotchas).

2. **Put the assembly list in one place and use it for both registrations.** Most "page works on refresh but not on click" bugs come from two lists drifting apart. A small static class removes the drift:

   ```csharp
   // Host/RoutableAssemblies.cs, .NET 10
   using System.Reflection;

   namespace Host;

   public static class RoutableAssemblies
   {
       // Do NOT include typeof(Program).Assembly: it is already the app assembly.
       public static readonly Assembly[] Additional =
       [
           typeof(Shared.Pages._Imports).Assembly,
           // typeof(Host.Client._Imports).Assembly,
       ];
   }
   ```

   ```csharp
   // Host/Program.cs, .NET 10
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   ```razor
   @* Host/Components/Routes.razor, .NET 10 *@
   <Router AppAssembly="typeof(Program).Assembly"
           AdditionalAssemblies="RoutableAssemblies.Additional"
           NotFoundPage="typeof(Shared.Pages.Pages.NotFound)">
       <Found Context="routeData">
           <RouteView RouteData="routeData" DefaultLayout="typeof(Layout.MainLayout)" />
           <FocusOnNavigate RouteData="routeData" Selector="h1" />
       </Found>
   </Router>
   ```

   Verify with `curl -s -o /dev/null -w '%{http_code}' http://localhost:5000/reports` returning `200` for one URL per library, then open the same URL in a browser and wait for the circuit (or WebAssembly runtime) to start. The page must still be there afterwards.

3. **Replace `<NotFound>` with a routable `NotFoundPage`.** In .NET 10 the `NotFound` render fragment is marked `[Obsolete("NotFound is deprecated. Use NotFoundPage instead.")]`. The release notes go further and say it "isn't supported in .NET 10 or later", but in my test the fragment still rendered on 10.0.10 when no `NotFoundPage` was set, so this is a deprecation you can schedule rather than an outage. Setting both throws `InvalidOperationException: Setting NotFound and NotFoundPage properties simultaneously is not supported`. The page needs a route, because the router validates that it has a `[Route]` attribute:

   ```razor
   @* Shared.Pages/Pages/NotFound.razor, .NET 10 *@
   @page "/not-found"

   <h1>Not found (from Shared.Pages)</h1>
   ```

   Then add the status code re-execution middleware that the .NET 10 template uses, so unknown URLs from the first HTTP request also land on that page:

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
   app.UseAntiforgery();
   ```

   Verify that `GET /missing` returns `404` with your page's `<h1>` in the body, and that `GET /not-found` returns `200`. If the 404 body is empty, read the next step.

4. **Register the not-found page's assembly on the endpoint side.** Re-execution is a second request through endpoint routing to `/not-found`. If the page lives in a library that only the `Router` knows about, there is no endpoint for it. Measured on 10.0.10 with the page in `Shared.Pages`:

   | `AddAdditionalAssemblies(Shared.Pages)` | `GET /missing` | `GET /not-found` |
   | --- | --- | --- |
   | missing | 404, empty body | 404, empty body |
   | present | 404, "Not found (from Shared.Pages)" | 200 |

   Step 2 already fixes this if the library is in the shared list. Verify with the same two requests.

5. **Switch `UseStaticFiles` to `MapStaticAssets`.** The .NET 9 migration guide replaces `app.UseStaticFiles()` with `app.MapStaticAssets()`, and the .NET 10 template uses it. It serves the library's assets under `_content/Shared.Pages/...` with precompressed `.br` and `.gz` variants. I checked that keeping `UseStaticFiles` on .NET 10 still serves `blazor.web.js` from a publish folder, so this is not forced, but it is what the rest of the template (`@Assets["..."]`, `<ResourcePreloader />`, `<ImportMap />`) expects:

   ```csharp
   // Host/Program.cs, .NET 10
   app.UseAntiforgery();
   app.MapStaticAssets();
   app.MapRazorComponents<App>()
       .AddInteractiveServerRenderMode()
       .AddAdditionalAssemblies(RoutableAssemblies.Additional);
   ```

   Verify that `GET /_framework/blazor.web.js` returns `200` and that a library stylesheet such as `/_content/Shared.Pages/Shared.Pages.bundle.scp.css` still loads.

6. **If the host has no `.razor` files, force the Blazor script back in.** This is the break that only hits the cleanest architectures. When `App.razor`, the layout, and every page live in libraries and the host is just `Program.cs`, .NET 8 still served `blazor.web.js`, because it was an embedded resource in the shared framework. In .NET 10 the script is a static web asset that the SDK adds only if the project contains at least one component. My thin host, measured from a publish folder:

   | Host | `GET /reports` | `GET /_framework/blazor.web.js` |
   | --- | --- | --- |
   | .NET 8.0.32, `UseStaticFiles` | 200 | 200 |
   | .NET 10.0.10, `MapStaticAssets` | 200 | 404 |
   | .NET 10.0.10, `MapStaticAssets` + `RequiresAspNetWebAssets` | 200 | 200 |

   The page still prerenders, which is why this is easy to miss: nothing is interactive, and the only signal is a 404 in the browser's network tab. The fix is one MSBuild property:

   ```xml
   <!-- Host.csproj, .NET 10, host project without any .razor file -->
   <PropertyGroup>
     <TargetFramework>net10.0</TargetFramework>
     <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
   </PropertyGroup>
   ```

   Verify that `publish/wwwroot/_framework/blazor.web.js` exists after `dotnet publish`, then click something interactive in the browser.

7. **For WebAssembly and Auto pages in a library, check the `.Client` side too.** Nothing here changed between 8 and 10, but the migration is a good moment to fix it. A library page with `@rendermode InteractiveWebAssembly` has to be downloadable by the browser, so the `.Client` project must reference the library, and the server must still list it in `AddAdditionalAssemblies` for the first request. If `Routes` itself runs on WebAssembly (global interactivity), it lives in `.Client`, and its `Router` needs the library in `AdditionalAssemblies`. Verify by loading a WebAssembly page directly, then navigating to it from another page.

## Verification

Run this against the published app (`dotnet publish -c Release -o out`, then `dotnet out/Host.dll`), not against `bin/`:

```bash
#!/usr/bin/env bash
# .NET 10 smoke test for routable components from other assemblies
BASE=http://localhost:5000
for u in /reports /not-found /missing /_framework/blazor.web.js; do
  printf '%-30s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE$u")"
done
```

Expected: `200`, `200`, `404`, `200`. Then, in a browser:

- Open a library page directly and wait two seconds. It must not turn into the not-found page.
- Navigate from a host page to a library page by clicking a link, and back.
- Trigger `NavigationManager.NotFound()` from a library page if you use it, and confirm the `NotFoundPage` renders.
- Check the network tab for any 404 on `_framework/` or `_content/`.

## Rolling back

The change is reversible as long as you keep the library compatible. If the library multi-targets `net8.0;net10.0`, you can roll the host back to `net8.0` by reverting its `.csproj`. Remember what does not exist on 8: `MapStaticAssets` (use `UseStaticFiles`), `NotFoundPage` (use the `<NotFound>` fragment), `UseStatusCodePagesWithReExecute`'s `createScopeForStatusCodePages` parameter, and `RequiresAspNetWebAssets` (harmless but unused). Keep those changes in a separate commit from the retarget so the rollback is a clean revert.

## Gotchas from the test runs

**"Assembly already defined" moved.** Adding the app's own assembly to `AddAdditionalAssemblies` has always been an error. On 8.0.32 the stack trace points straight at your code:

```text
Unhandled exception. System.InvalidOperationException: Assembly already defined.
   at Microsoft.AspNetCore.Components.Discovery.ComponentApplicationBuilder.AddLibrary(...)
   at Microsoft.AspNetCore.Builder.RazorComponentsEndpointConventionBuilderExtensions.AddAdditionalAssemblies(...)
   at Program.<Main>$(String[] args) in .../Host/Program.cs:line 29
```

On 10.0.10 the registration is deferred until endpoints are first built, so the same mistake is logged as `Application startup exception` from `RazorComponentEndpointDataSource.UpdateEndpoints()`, and no frame mentions `Program.cs`. If you see that message after the upgrade, search for `typeof(Program).Assembly` in your additional assembly list, or for the same library added twice from two helper methods.

**Duplicate routes across assemblies fail at request time, not startup.** When the host and a library both declared `@page "/reports"`, the app started fine on 10.0.10 and the request returned `500` with `AmbiguousMatchException: The request matched multiple endpoints`. Only the colliding URL breaks, so a smoke test that skips it will pass. The `grep -rn '@page "' --include=*.razor` output from the pre-flight checklist, sorted by route, finds these before they ship.

**A library member named `RendererInfo` now hides a framework member.** My first version of the test page had a `string RendererInfo` property. It compiled cleanly on .NET 8 and produced `warning CS0108: 'Reports.RendererInfo' hides inherited member 'ComponentBase.RendererInfo'` on .NET 10, because `ComponentBase` gained `RendererInfo` and `AssignedRenderMode` in .NET 9. The warning is harmless until a teammate reads `RendererInfo.IsInteractive` in that component and gets your string instead. Rename the member.

**Keeping `UseStaticFiles` and testing from `bin/` gives a false 404.** With the .NET 8 pipeline left in place (`UseStaticFiles`, no `MapStaticAssets`), running `dotnet bin/Release/net10.0/Host.dll` in the Production environment returned 404 for `blazor.web.js` even in a normal host with components, while the same thing on .NET 8 returned 200. `UseStaticFiles` only sees the files physically in `wwwroot`, and outside Development nothing adds the static web assets from referenced projects and the SDK. On .NET 8 the Blazor script came from an embedded resource, so it did not care; on .NET 10 it is a static web asset. The same `bin/` run with `MapStaticAssets` returned 200, because it reads the generated endpoints manifest, and the publish folder returned 200 with either middleware. Test from a `dotnet publish` folder or with `dotnet run`, or you will chase the wrong problem.

**Prerendering hides a missing `Router` registration.** As the matrix shows, a page that is only registered on the endpoint side renders perfectly in `curl` and in automated HTML snapshot tests. The failure appears only after the interactive router starts. Any end-to-end test for library pages has to wait for interactivity, for example by clicking a button and asserting on the result.

## Related

- If you are still on the .NET 7 hosting model, start with [migrating a Blazor Server app to Blazor United](/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/), then come back for the multi-assembly part.
- For which render mode a library page actually runs in once it is routed, see [what a Blazor render mode is and which one runs my component](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/).
- A related static asset failure with a different cause: [404 Not Found for blazor.server.js after installing a new .NET SDK](/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/).
- If a library page declares a render mode its parent cannot host, you will hit [the "render mode is not supported by the parent component's render mode" error](/2026/06/fix-render-mode-is-not-supported-by-the-parent-components-render-mode-blazor/).
- The project layout behind `.Client` and `AddAdditionalAssemblies` is compared in [Blazor Server vs WebAssembly vs United](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/).

## Sources

- [Route to components from multiple assemblies](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/routing) (Microsoft Learn, ASP.NET Core Blazor routing)
- [Migrate from ASP.NET Core in .NET 8 to ASP.NET Core in .NET 9](https://learn.microsoft.com/en-us/aspnet/core/migration/80-to-90), including "Replace UseStaticFiles with MapStaticAssets" (Microsoft Learn)
- [Migrate from ASP.NET Core in .NET 9 to ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/migration/90-to-100) (Microsoft Learn)
- [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0): "Blazor router has a NotFoundPage parameter" and "Blazor script as static web asset"
- [Map static files in ASP.NET Core](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/map-static-files) (Microsoft Learn)
- [ASP.NET Core Razor class libraries](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/class-libraries) (Microsoft Learn)
- [`Router.cs` at v10.0.0](https://github.com/dotnet/aspnetcore/blob/v10.0.0/src/Components/Components/src/Routing/Router.cs), the source of the `NotFoundPage` validation and the obsolete `NotFound` parameter (dotnet/aspnetcore)
- [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy/dotnet-core) for the .NET 8 and .NET 10 end-of-support dates
