---
title: "Fix: Blazor WebAssembly on .NET 10 ignores the Blazor-Environment header and the environment is always Production"
description: ".NET 10 inlines the WASM boot config into dotnet.js, so the header is never read. Set WasmApplicationEnvironmentName, or pass it to Blazor.start."
pubDate: 2026-11-15
template: error-page
tags:
  - "errors"
  - "blazor"
  - "blazor-webassembly"
  - "dotnet-10"
  - "aspnet-core"
  - "msbuild"
---

In .NET 10 the environment of a standalone Blazor WebAssembly app is fixed when you build: the server's `Blazor-Environment` response header no longer changes it. `dotnet build` writes `Development` into the boot configuration, and `dotnet publish` writes nothing, so the runtime falls back to `Production`. The header is still sent, but nothing reads it. There are two fixes. To build one artifact per environment, publish with `-p:WasmApplicationEnvironmentName=Staging`. To build once and deploy everywhere, start Blazor manually and pass the environment from the server with `Blazor.start({ environment })`. Everything below was measured with SDK 10.0.403, `Microsoft.AspNetCore.Components.WebAssembly` 10.0.14 and the `Microsoft.NET.Sdk.WebAssembly.Pack` 10.0.14 targets on macOS, in a Chromium-based browser.

## The symptom in context

The typical report comes from a standalone WASM app served by an ASP.NET Core host, or by any static host where someone added the header by hand. The response for `_framework/dotnet.js` carries the header, yet the client disagrees:

```text
HTTP/1.1 200 OK
Content-Type: text/javascript
Blazor-Environment: Staging
```

```csharp
// .NET 10, Program.cs of the WASM client
var builder = WebAssemblyHostBuilder.CreateDefault(args);
Console.WriteLine("Env: " + builder.HostEnvironment.Environment);
// Browser console: Env: Production
```

The same thing shows up as `appsettings.Staging.json` never being applied, `IsDevelopment()` returning `false` during local `dotnet run` when you expected the `launchSettings.json` value, or a feature flag that only turns on in one slot never turning on. A [Stack Overflow question from January 2026](https://stackoverflow.com/questions/79860615) shows the confusing part: the minified `dotnet.js` still has code that reads `Blazor-Environment` and `DotNet-Environment`, so it looks as if the header should work.

## Why the header stopped working in .NET 10

Before .NET 10 the runtime fetched `_framework/blazor.boot.json` over HTTP at startup. Because it was a real HTTP response, the loader could read its headers, and if the boot JSON had no `applicationEnvironment` it took the value from `Blazor-Environment`. The [ASP.NET Core 10 release notes](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0) list two changes that remove both conditions.

1. **The boot configuration is inlined into `dotnet.js`.** The JSON that used to be `blazor.boot.json` is now a literal object in the fingerprinted `dotnet.<hash>.js`. The release notes say the boot manifest "has been inlined into the `dotnet.js` script". There is no separate fetch, so no response whose headers could be read.
2. **The environment became a build-time MSBuild property.** The release notes say the `Blazor-Environment` header and `Properties/launchSettings.json` "are no longer used to control the environment in standalone Blazor WebAssembly apps". The value comes from `WasmApplicationEnvironmentName`.

The bundled loader shows exactly where the header path survives. Here is the relevant function from the published `dotnet.js` (SDK 10.0.403, minified names as shipped):

```js
// dotnet.js, .NET 10.0.14 runtime (minified, as shipped)
async function Ae(e) {               // e is a fetch Response for a *.json manifest
  const t = Pe.config, o = await e.json();
  t.applicationEnvironment || o.applicationEnvironment ||
    (o.applicationEnvironment = e.headers.get("Blazor-Environment")
                             || e.headers.get("DotNet-Environment") || void 0);
  /* ... */
}
```

`Ae` runs only when the configured manifest name ends in `.json`. With the inlined config, the loader sees that `Pe.config.resources` is already populated and never fetches a manifest. If the config is missing, the loader falls back to `dotnet.boot.js`, which it loads with `import()`, not `fetch()`. Neither path reaches `Ae`. Later in startup, a plain fallback applies:

```js
// dotnet.js, .NET 10.0.14 runtime
e.applicationEnvironment || (e.applicationEnvironment = "Production")
```

That fallback is why the symptom is always `Production` and never an empty string.

## Minimal repro

Create a standalone app with the stock template, show the environment on the home page, and publish it three ways.

```bash
# SDK 10.0.403
dotnet new blazorwasm -n EnvApp
```

```razor
@* .NET 10, Pages/Home.razor *@
@page "/"
@using Microsoft.AspNetCore.Components.WebAssembly.Hosting
@inject IWebAssemblyHostEnvironment HostEnv
<h1 id="env">@HostEnv.Environment</h1>
```

```bash
dotnet build
dotnet publish -c Release -o pub-default
dotnet publish -c Release -p:WasmApplicationEnvironmentName=Staging -o pub-staging
```

Next, look at what each output baked into `dotnet.js`:

```bash
grep -n '"applicationEnvironment"' bin/Debug/net10.0/wwwroot/_framework/dotnet.*.js
#   6:  "applicationEnvironment": "Development",
grep -n '"applicationEnvironment"' pub-default/wwwroot/_framework/dotnet.*.js
#   (no match: the key is omitted, the runtime falls back to "Production")
grep -n '"applicationEnvironment"' pub-staging/wwwroot/_framework/dotnet.*.js
#   6:  "applicationEnvironment": "Staging",
```

To rule out the host, each publish folder was served by a minimal Python static server that adds a `Blazor-Environment` header to every response. Then the `#env` text was read back in the browser:

| Publish | Header sent | `HostEnvironment.Environment` |
| --- | --- | --- |
| `pub-default` | `Blazor-Environment: Staging` | `Production` |
| `pub-staging` (`WasmApplicationEnvironmentName=Staging`) | `Blazor-Environment: Production` | `Staging` |

The header loses both times. The baked value wins, and when nothing was baked, the hard-coded fallback wins. Swapping the Python server for ASP.NET Core changes nothing: the server can send whatever headers it likes, and the client never looks.

## Fix 1: bake the environment in with WasmApplicationEnvironmentName

This is the documented route, and the right one if you already build one artifact per environment. The WebAssembly SDK targets (`Microsoft.NET.Sdk.WebAssembly.Browser.targets`, 10.0.14) read `$(WasmApplicationEnvironmentName)` in two places. The build target defaults it to `Development` when empty. The publish target passes it through as-is, so an empty value means the key is omitted.

Pass it on the command line in CI:

```bash
# SDK 10.0.403
dotnet publish -c Release -p:WasmApplicationEnvironmentName=Staging
```

Or put it in the project file, keyed off whatever already tells your environments apart:

```xml
<!-- .NET 10, EnvApp.csproj -->
<PropertyGroup Condition="'$(Configuration)' == 'Debug'">
  <WasmApplicationEnvironmentName>Development</WasmApplicationEnvironmentName>
</PropertyGroup>
<PropertyGroup Condition="'$(Configuration)' == 'Release'">
  <WasmApplicationEnvironmentName>Production</WasmApplicationEnvironmentName>
</PropertyGroup>
```

The [environments article](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/environments?view=aspnetcore-10.0) also shows a variant keyed on `$(PublishProfile)`. Publish profiles are the cleanest place for it, because a `.pubxml` for "Staging" can set `WasmApplicationEnvironmentName` next to the target URL.

The cost is that the environment name now lives inside the fingerprinted `dotnet.<hash>.js`. A Staging build and a Production build are different artifacts with different hashes. You cannot promote one build from a staging slot to production and expect it to switch.

## Fix 2: pass the environment to Blazor.start at runtime

If your pipeline builds once and promotes the same files through environments (Azure App Service slots, one container image across stages, a CDN with per-environment origins), the environment has to arrive at runtime. The supported hook is the `environment` start option. Turn off autostart, ask the server which environment it is, then start:

```html
<!-- .NET 10, wwwroot/index.html (standalone Blazor WebAssembly) -->
<script src="_framework/blazor.webassembly#[.{fingerprint}].js" autostart="false"></script>
<script>
  (async () => {
    let environment;
    try {
      const r = await fetch("environment.txt", { cache: "no-store" });
      if (r.ok) environment = (await r.text()).trim();
    } catch { }
    await Blazor.start(environment ? { environment } : {});
  })();
</script>
```

The `#[.{fingerprint}]` placeholder is what the .NET 10 template ships with `OverrideHtmlAssetPlaceholders`. Leave it as it is in your own `index.html`.

`environment.txt` is just a file your deployment step writes into `wwwroot`, one line per slot. If the app is hosted by an ASP.NET Core server, an endpoint works just as well and needs no deployment step:

```csharp
// .NET 10, server Program.cs hosting the WASM client
app.MapGet("/environment.txt", (IWebHostEnvironment env) => env.EnvironmentName);
```

With `environment.txt` containing `Staging`, the default `dotnet publish` output (nothing baked in) reported `Staging`. The value from `Blazor.start` is applied before the runtime builds its resource list, so per-environment config files still load. With `wwwroot/appsettings.json` set to `{ "Banner": "base" }` and `wwwroot/appsettings.Staging.json` set to `{ "Banner": "staging-file" }`, `IConfiguration["Banner"]` returned `staging-file`.

Two details matter here. First, always fall back to `Blazor.start({})` when the fetch fails. Otherwise a network error at startup leaves you with a blank page instead of a `Production` app. Second, keep the response uncached (`cache: "no-store"` on the client, no long `Cache-Control` on the server). A cached `Staging` answer that survives a slot swap is exactly the bug you are trying to fix.

## The undocumented escape hatch: go back to a JSON manifest

The targets still have an opt-out from inlining. Setting `WasmBootConfigFileName` turns off `_WasmInlineBootConfig`, and naming the file `blazor.boot.json` produces a real JSON manifest again:

```bash
# SDK 10.0.403
dotnet publish -c Release -p:WasmBootConfigFileName=blazor.boot.json -o pub-json
```

On its own, this breaks the app. The loader still defaults to `dotnet.boot.js`, which no longer exists, and startup dies with `Failed to load config file dotnet.boot.js ... Failed to fetch dynamically imported module`. Pointing the loader at the JSON through `loadBootResource` gets it running, and because the manifest now comes from `fetch()`, the `Ae` function above reads the header again:

```html
<!-- .NET 10, wwwroot/index.html: reverts to a fetched JSON manifest -->
<script src="_framework/blazor.webassembly#[.{fingerprint}].js" autostart="false"></script>
<script>
  Blazor.start({
    loadBootResource: (type, name, defaultUri) =>
      type === "manifest" ? "_framework/blazor.boot.json" : null
  });
</script>
```

Served with `Blazor-Environment: Staging`, this build reported `Staging`. It works, but nothing documents it. It relies on an internal property (`_WasmInlineBootConfig`) and on the `"manifest"` resource type keeping its current behavior. It also brings back the extra round trip that inlining removed. Treat it as a stopgap while you move to fix 1 or fix 2, not as the answer.

## Gotchas and lookalikes

- **`dotnet run` ignores `launchSettings.json` too.** A local `ASPNETCORE_ENVIRONMENT=Staging` profile has no effect on a standalone WASM client in .NET 10, because `dotnet build` bakes in `Development`. [dotnet/aspnetcore#64598](https://github.com/dotnet/aspnetcore/issues/64598) asked for the old behavior back and was closed. The maintainer's reply says the environment "has to be a build-time setting". For local overrides, use `-p:WasmApplicationEnvironmentName=...` or a git-ignored `Directory.Build.props`.
- **Blazor Web Apps are not affected in the same way.** In a Blazor Web App (server project plus `.Client` project), the server writes the environment into a `<!--Blazor-WebAssembly:{"environmentName":...}-->` comment in the prerendered HTML, and the client reads it from there. If you start that kind of app manually, the option is nested: `Blazor.start({ webAssembly: { environment: "Staging" } })`, not the top-level `environment` used by standalone apps. If you are not sure which kind you have, the [render mode explainer](/2026/09/what-is-a-blazor-render-mode-and-which-one-runs-my-component/) and the [Server vs WebAssembly vs United comparison](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) cover how the hosting models differ.
- **Every `appsettings.*.json` in `wwwroot` is public.** Fix 2 only works because all the per-environment files ship to every environment. That has always been true for WASM, but a runtime switch makes it easy to forget that `appsettings.Production.json` is downloadable from your staging site too. Never put secrets there.
- **Different hashes per environment are expected with fix 1.** If a deploy script compares `dotnet.<hash>.js` names across environments, it will see different files. That is the environment name inside the boot config changing the fingerprint, not a broken build. The [.NET 10 static web assets changes](/2026/09/fix-conflicting-assets-with-the-same-target-path-in-aspnetcore-10/) are a related source of surprises when upgrading the same solution.
- **Upgrading auth at the same time?** If the environment fix exposes environment-specific MSAL settings that never loaded before, the [`IsAuthenticated` false after an MSAL upgrade](/2026/09/fix-isauthenticated-false-remoteuseraccount-null-blazor-webassembly-msal-upgrade/) post covers the next thing likely to go wrong.

## Sources

- [What's new in ASP.NET Core in .NET 10](https://learn.microsoft.com/en-us/aspnet/core/release-notes/aspnetcore-10.0): boot configuration inlined into `dotnet.js`, `WasmApplicationEnvironmentName`, header and `launchSettings.json` no longer used.
- [ASP.NET Core Blazor environments (.NET 10 view)](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/environments?view=aspnetcore-10.0): MSBuild property examples, `Blazor.start` options for standalone apps and Blazor Web Apps.
- [dotnet/aspnetcore#64598](https://github.com/dotnet/aspnetcore/issues/64598): request to restore `launchSettings.json` support, closed with the build-time rationale.
- [Stack Overflow 79860615](https://stackoverflow.com/questions/79860615): the original report of the header being sent but ignored on .NET 10.
- `Microsoft.NET.Sdk.WebAssembly.Browser.targets` from the `Microsoft.NET.Sdk.WebAssembly.Pack` 10.0.14 package, and the published `dotnet.js` of the 10.0.14 runtime, read directly for the defaults and the header code path quoted above.
