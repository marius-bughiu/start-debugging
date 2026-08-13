---
title: "Fix: 404 Not Found for blazor.server.js after installing a new .NET SDK"
description: "blazor.server.js 404s on .NET 10 because the script stopped being an embedded resource. Add RequiresAspNetWebAssets to the host project, or make sure it has a .razor file."
pubDate: 2026-08-13
template: error-page
tags:
  - "errors"
  - "blazor"
  - "aspnet-core"
  - "dotnet-10"
  - "dotnet-11"
  - "static-web-assets"
---

Add `<RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>` to the host project and restore. In .NET 10 the Blazor script stopped being an embedded resource in `Microsoft.AspNetCore.Components.Server` and became a file from the `Microsoft.AspNetCore.App.Internal.Assets` NuGet package, which the SDK only pulls in when the project contains at least one `.razor` file. No `.razor` file in the host, no script, 404. Everything below was measured on SDK 10.0.201 with ASP.NET Core 10.0.5 on Windows 11.

## The error in context

The browser console, from a `_Host.cshtml` that has worked unchanged since .NET 6:

```
GET https://localhost:5001/_framework/blazor.server.js net::ERR_ABORTED 404 (Not Found)
Uncaught ReferenceError: Blazor is not defined
```

The page renders its prerendered HTML and then does nothing. No circuit opens, no button works, and the server log is silent because a 404 from the static file middleware is not an exception. The same thing happens to `_framework/blazor.web.js` in a Blazor Web App.

The confusing part is the trigger. The project file did not change. Very often the target framework did not change either. Someone installed the .NET 10 SDK, and an app that built and ran yesterday now serves a 404 for one file.

## Why the script disappeared

Through .NET 9, `blazor.server.js` was an embedded resource inside the shared framework assembly, and `MapBlazorHub()` registered a dedicated endpoint that read it out of that assembly. That endpoint could not fail to find the file, because the file was inside the DLL that registered the endpoint.

.NET 10 removed it. Javier Calvarro Nelson, on the ASP.NET Core team, [put it plainly](https://github.com/dotnet/aspnetcore/issues/64381#issuecomment-3546832403) when this was first reported:

"In 10.0, we stopped embedding the `server.js` and the `.web.js` files inside their respective assemblies so that we can compress and fingerprint them like any other files."

That is a real win. The script now gets build-time Gzip, publish-time Brotli, a content hash in its URL, and a one-year immutable `Cache-Control`. But it changes where the file comes from. It is now a static web asset, delivered by a NuGet package that the SDK adds to your restore graph behind your back. On my machine:

```
C:\Users\mariu\.nuget\packages\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
  blazor.server.js
  blazor.server.js.map
  blazor.web.js
  blazor.web.js.map
  blazor.webassembly.js
  blazor.webassembly.js.map
```

The version is pinned by the SDK, not by your project. `Microsoft.NETCoreSdk.BundledVersions.props` in the SDK install decides it:

```xml
<!-- C:\Program Files\dotnet\sdk\10.0.201\Microsoft.NETCoreSdk.BundledVersions.props -->
<KnownAspNetCorePack Include="Microsoft.AspNetCore.App.Internal.Assets"
                     TargetFramework="net10.0"
                     AspNetCorePackVersion="10.0.5" />
```

And here is the part that actually causes the 404. The SDK does not add that package to every web project, because most web projects are not Blazor apps and nobody wants a Blazor script downloaded into a minimal API. It guesses, using one heuristic:

```xml
<!-- Sdks\Microsoft.NET.Sdk.Web.ProjectSystem\targets\Microsoft.NET.Sdk.Web.ProjectSystem.targets -->
<Target Name="ResolveRequiredWebAssets" BeforeTargets="ProcessFrameworkReferences">
  <PropertyGroup>
    <RequiresAspNetWebAssets
      Condition="'$(RequiresAspNetWebAssets)' == '' and @(Content->AnyHaveMetadataValue(Extension, .razor))">true</RequiresAspNetWebAssets>
  </PropertyGroup>
</Target>
```

If the host project has a `.razor` file in its `Content` items, the package comes in. Otherwise `RequiresAspNetWebAssets` falls back to its default of `false`, the package is never restored, and `_framework/blazor.server.js` is simply not in the app's static web asset manifest. There is no warning at build time. The build succeeds.

Plenty of real Blazor Server apps have no `.razor` file in the host project. If your components live in a Razor Class Library and the host is nothing but `Program.cs`, `_Host.cshtml`, and a project reference, the heuristic says "not a Blazor app" and you get a 404.

## Minimal repro

An ASP.NET Core host that serves Blazor Server components out of an RCL. Nothing exotic:

```xml
<!-- BzSrv.csproj, .NET 10, SDK 10.0.201 -->
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="..\BzLib\BzLib.csproj" />
  </ItemGroup>
</Project>
```

```csharp
// Program.cs, .NET 10, ASP.NET Core 10.0.5
var builder = WebApplication.CreateBuilder(args);
builder.Services.AddRazorPages();
builder.Services.AddServerSideBlazor();

var app = builder.Build();
app.UseStaticFiles();
app.MapBlazorHub();
app.MapFallbackToPage("/_Host");
app.Run();
```

```html
<!-- Pages/_Host.cshtml -->
<component type="typeof(App)" render-mode="ServerPrerendered" />
<script src="_framework/blazor.server.js"></script>
```

Build it and look at what restore decided:

```bash
dotnet build
grep -o "Microsoft.AspNetCore.App.Internal.Assets/[0-9.]*" obj/project.assets.json
# (no output)
grep -c "blazor.server.js" bin/Debug/net10.0/BzSrv.staticwebassets.runtime.json
# 0
```

The package is absent from the restore graph and the script is absent from the manifest. Requesting it returns HTTP 404 with a zero-byte body. Move a single `.razor` file into the host project, or set the property below, and both counts become non-zero.

## The fix

**Set the property in the host project.** This is the supported escape hatch and the one the ASP.NET Core team points people at. It goes in the project that uses `Microsoft.NET.Sdk.Web`, the one that actually serves the requests, not the RCL:

```xml
<!-- BzSrv.csproj, .NET 10 / .NET 11 -->
<PropertyGroup>
  <RequiresAspNetWebAssets>true</RequiresAspNetWebAssets>
</PropertyGroup>
```

Then restore, because the package enters the graph during restore, not during build:

```bash
dotnet restore
```

`dotnet build` runs an implicit restore, so a plain rebuild usually picks it up. A CI step that runs `dotnet build --no-restore` against a restore performed before the property was added will not. After the change, the same two checks come back positive and the file is served at 164,838 bytes.

**Or add a `.razor` file to the host.** Moving `App.razor` (or any component) back into the host project satisfies the heuristic with no MSBuild property. Fine if you were going to have one anyway, but it is a strange reason to move code, and the property states the intent better.

**Do not reach for `MapStaticAssets()`.** This is the most common piece of bad advice on this error, and it is worth being specific because it wastes hours. Migrating a working pipeline to `MapStaticAssets()` does not fix a missing package, and `UseStaticFiles()` was never the problem. The team [closed a community PR](https://github.com/dotnet/aspnetcore/pull/66060#issuecomment-5068880296) that was built on that diagnosis:

"`blazor.web.js` and `blazor.server.js` are shipped as static web assets, and `app.UseStaticFiles()` already serves them without `MapStaticAssets()` (this is what our own server-side Blazor E2E tests exercise, using `UseStaticFiles()` and `MapBlazorHub()` with no `MapStaticAssets()` call)."

That matches what I measured. With the package present, `UseStaticFiles()` and `MapBlazorHub()` serve the script in Development and from published output, no `MapStaticAssets()` anywhere.

## What each configuration actually returns

Nine runs against the same repro, each one an HTTP request to `/_framework/blazor.server.js` on a real Kestrel process:

| Host project | Pipeline | Environment | Running from | Result |
| --- | --- | --- | --- | --- |
| has `.razor` | `UseStaticFiles()` | Development | `dotnet run` | 200, 164838 bytes |
| has `.razor` | `UseStaticFiles()` | Development | build output | 200 |
| has `.razor` | `UseStaticFiles()` | Production | build output | **404** |
| has `.razor` | `UseStaticFiles()` | Production | publish output | 200 |
| has `.razor` | `MapStaticAssets()` | Development | build output | 200 |
| has `.razor` | `MapStaticAssets()` | Production | build output | **500** |
| no `.razor` | `UseStaticFiles()` | Development | build output | **404** |
| no `.razor`, property set | `UseStaticFiles()` | Development | build output | 200 |
| `EnableDefaultContentItems=false` | any | any | any | package never restored |

Two rows deserve their own explanation.

**Production against build output 404s even when the project is configured correctly.** `WebApplication.CreateBuilder` only calls `UseStaticWebAssets()` in the Development environment. In Development the static web asset manifest maps `_framework/` straight into the NuGet cache folder shown earlier. In any other environment that mapping is not applied, and build output has no `wwwroot/_framework/` of its own, so there is nothing to serve. Published output is fine because `dotnet publish` copies the real files (plus `.gz` and `.br` variants) into `wwwroot/_framework/`. This bites CI smoke tests and container images that run `dotnet build` output with `ASPNETCORE_ENVIRONMENT=Staging`. It is not new in .NET 10, but before .NET 10 the embedded-resource endpoint hid it for this one file.

**The same setup under `MapStaticAssets()` returns 500, not 404**, which is a useful diagnostic. The endpoint is registered from `BzSrv.staticwebassets.endpoints.json`, which is copied to the output directory and read regardless of environment, so routing matches. The file provider then cannot produce the bytes:

```
System.IO.FileNotFoundException: Could not find file '...\BzSrv\wwwroot\_framework\blazor.server.js'.
   at System.IO.FileInfo.get_Length()
   at Microsoft.AspNetCore.Builder.StaticAssetDevelopmentRuntimeHandler...
```

A 500 with that stack means the manifest knows about the script and the file provider cannot reach it, so the package is fine and your environment or output directory is wrong. A flat 404 means the manifest never had it, so the package is missing and `RequiresAspNetWebAssets` is your fix.

## Gotchas and lookalikes

**`EnableDefaultContentItems=false` silently disables the heuristic.** The MSBuild condition tests `Content` items, not files on disk. A host project with `App.razor` sitting right next to `Program.cs` still fails to restore the package if default content globs are off. Verified: same project, same file, package absent. Set the property explicitly in any project that customizes content items.

**A `Microsoft.NET.Sdk.Razor` project never auto-detects.** The `ResolveRequiredWebAssets` target ships only in `Microsoft.NET.Sdk.Web.ProjectSystem.targets`. If your host uses the Razor SDK, or sets `<OutputType>Library</OutputType>`, nothing sets `RequiresAspNetWebAssets` for you no matter how many components it contains. That is the shape reported in [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545). Set the property by hand.

**`packages.lock.json` turns the fix into a build failure.** Adding the property changes the restore graph, so a locked restore refuses it with an exact message worth recognizing:

```
error NU1004: The package references have changed for net10.0. Lock file's package references: None,
project's package references: Microsoft.AspNetCore.App.Internal.Assets >= 10.0.5. The packages lock
file is inconsistent with the project dependencies so restore can't be run in locked mode.
```

Regenerate the lock file once and commit it:

```bash
dotnet restore --force-evaluate
```

**Restore has to be able to reach the package.** It is a real package from nuget.org, not something bundled in the SDK install. Air-gapped builds and private feeds without an upstream mirror will not find it, and the SDK version, not your target framework, decides which version is requested. Install a new SDK patch and your offline feed needs a new `Microsoft.AspNetCore.App.Internal.Assets` version to match.

**If the package folder disappears, the app does not 404, it fails to start.** Clearing the NuGet cache while stale build output remains gives you this at startup, before Kestrel binds:

```
Unhandled exception. System.IO.DirectoryNotFoundException: ...\microsoft.aspnetcore.app.internal.assets\10.0.5\_framework\
   at Microsoft.AspNetCore.Hosting.StaticWebAssets.StaticWebAssetsLoader.UseStaticWebAssetsCore(...)
   at Microsoft.AspNetCore.Builder.WebApplication.CreateBuilder(String[] args)
```

The manifest in `bin` holds an absolute path into the package cache. Delete `bin` and `obj`, then rebuild.

**A .NET 9 app can hit this without being upgraded.** [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353) is a `net9.0` Blazor app that started 404ing the moment the .NET 10 SDK was installed. The cause was `DOTNET_ROLL_FORWARD=LatestMajor` in the environment: the app was rolling forward onto the 10.0 runtime, where the script is no longer embedded, while still building as a .NET 9 project that never restores the package. Check `dotnet --info` for that variable before you touch the project file. Run on the 9.0 runtime and the embedded resource is still there and everything works, .NET 10 SDK or not.

**The docs understate the scope.** The [Blazor project structure article](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0) says the `.razor` file is needed "in order to automatically include the Blazor script when the app is published." It affects `dotnet build` too: the repro above 404s under `dotnet run` in Development, long before anyone publishes anything.

**This is unchanged in .NET 11.** The static-asset delivery model and the `RequiresAspNetWebAssets` property both carry forward, and the docs page above applies to the `aspnetcore-10.0` and `aspnetcore-11.0` monikers alike. Upgrading past 10 does not remove the requirement.

## Related

If you are working through an upgrade and this is one of several things that broke at once, the Blazor items are collected in the [.NET 8 to .NET 11 checklist](/2026/05/migrate-from-dotnet-8-to-dotnet-11-full-checklist/), and the render-mode side of the same move is in [migrating a Blazor Server app to Blazor United](/2026/06/migrate-a-blazor-server-app-to-blazor-united-in-dotnet-11/). Once the script loads and a circuit actually opens, the next two failures people hit are [the reconnect banner after a circuit disconnects](/2026/08/fix-attempting-to-reconnect-to-the-server-after-a-blazor-circuit-disconnects/) and [JavaScript interop calls cannot be issued at this time during prerendering](/2026/07/fix-javascript-interop-calls-cannot-be-issued-at-this-time-blazor-prerendering/). If you are deciding whether the host should keep hosting components at all, [Blazor Server vs WebAssembly vs United](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) covers the trade.

## Sources

- [ASP.NET Core Blazor project structure](https://learn.microsoft.com/en-us/aspnet/core/blazor/project-structure?view=aspnetcore-10.0), for the `RequiresAspNetWebAssets` property and the at-least-one-`.razor`-file rule.
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0), for `MapStaticAssets` versus `UseStaticFiles` and what each one can and cannot serve.
- [dotnet/aspnetcore#64381](https://github.com/dotnet/aspnetcore/issues/64381), the original report, with the team's explanation of why the scripts stopped being embedded resources.
- [dotnet/aspnetcore#66175](https://github.com/dotnet/aspnetcore/issues/66175), the same 404 on SDK 10.0.201 after a Blazor Server upgrade, closed by adding the property.
- [dotnet/aspnetcore#66059](https://github.com/dotnet/aspnetcore/issues/66059) and [the PR it proposed](https://github.com/dotnet/aspnetcore/pull/66060), for why re-adding the old embedded-resource endpoints was declined and the confirmation that `UseStaticFiles()` serves these files today.
- [dotnet/aspnetcore#65353](https://github.com/dotnet/aspnetcore/issues/65353), for the roll-forward variant that breaks `net9.0` apps after an SDK install.
- [dotnet/aspnetcore#64545](https://github.com/dotnet/aspnetcore/issues/64545), for the `OutputType` / non-Web-SDK variant.
