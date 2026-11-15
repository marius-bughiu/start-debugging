---
title: "Fix: Failed to fetch dynamically imported module Microsoft.DotNet.HotReload.WebAssembly.Browser lib.module.js after deploying a .NET 10 Blazor Web App"
description: "The app was published in Debug, so SDK 10.0.1xx/2xx wired the hot reload module into the boot config. Publish Release, or set WasmEnableHotReload to false."
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

If a deployed .NET 10 Blazor Web App logs `Failed to fetch dynamically imported module: .../_content/Microsoft.DotNet.HotReload.WebAssembly.Browser/...lib.module.js`, the app was published in the **Debug** configuration. With .NET SDK 10.0.1xx and 10.0.2xx, a Debug build of a WebAssembly client adds an implicit package reference to `Microsoft.DotNet.HotReload.WebAssembly.Browser` and registers its JavaScript module as a library initializer, so every browser tries to import it, whatever `ASPNETCORE_ENVIRONMENT` says. The fix is to publish in Release (check the `.pubxml`), or set `<WasmEnableHotReload>false</WasmEnableHotReload>` in the client project if you really need a Debug deployment. SDK 10.0.300 and later no longer publish the module at all. Everything below was reproduced with SDK 10.0.101 (runtime 10.0.1) and compared against SDK 10.0.302, on macOS, in a Chromium-based browser.

## The error in context

This is the report from a [Stack Overflow question from January 2026](https://stackoverflow.com/questions/79861883), posted after an app was upgraded to .NET 10 and web-deployed to a server running the `Staging` environment:

```text
Failed to load module script: Expected a JavaScript-or-Wasm module script but the
server responded with a MIME type of "". Strict MIME type checking is enforced for
module scripts per HTML spec.

blazor.web.wmp8iwak4q.js:1 Uncaught (in promise) TypeError: Failed to fetch dynamically
imported module: https://mywebsite.com/_content/Microsoft.DotNet.HotReload.WebAssembly.Browser/Microsoft.DotNet.HotReload.WebAssembly.Browser.99zm1jdh75.lib.module.js
```

The fingerprint in that file name, `99zm1jdh75`, is the content hash of the module that ships in version 10.0.101 of the package. A fresh `dotnet new blazor -int WebAssembly` project published with `-c Debug` on SDK 10.0.101 produces exactly `Microsoft.DotNet.HotReload.WebAssembly.Browser.99zm1jdh75.lib.module.js`. That pins the cause down to the build configuration, not the hosting environment.

If your `App.razor` contains `<ImportMap />` (the default since the .NET 9 template), you get a different first line for the same problem, because the browser checks the import map's integrity hash before the MIME type:

```text
Failed to find a valid digest in the 'integrity' attribute for resource
'.../Microsoft.DotNet.HotReload.WebAssembly.Browser.99zm1jdh75.lib.module.js' with computed
SHA-256 integrity '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='. The resource has been blocked.
```

`47DEQpj8...` is the SHA-256 of an empty body, which is the giveaway that the server answered with nothing.

## Why a hot reload module is in a Staging deployment

The question's author reasoned that hot reload "should not even be trying to load" because the environment is Staging. The environment plays no part here. The decision is made by MSBuild when the client project is built, and it only looks at `Configuration`. This is the relevant block from `Microsoft.NET.Sdk.WebAssembly/Sdk/Sdk.targets` in SDK 10.0.101 (identical on the [`release/10.0.1xx`](https://github.com/dotnet/sdk/blob/release/10.0.1xx/src/WasmSdk/Sdk/Sdk.targets) and `release/10.0.2xx` branches):

```xml
<!-- .NET SDK 10.0.101, Microsoft.NET.Sdk.WebAssembly/Sdk/Sdk.targets -->
<!-- Implicit HotReload package reference for .NET 10+ if not explicitly turned off -->
<_WasmEnableHotReload>$(WasmEnableHotReload)</_WasmEnableHotReload>
<_WasmEnableHotReload Condition="'$(_WasmEnableHotReload)' == '' and '$(Configuration)' != 'Debug'">false</_WasmEnableHotReload>
<_WasmEnableHotReload Condition="'$(_WasmEnableHotReload)' == '' and '$(TargetFrameworkIdentifier)' == '.NETCoreApp' and $([MSBuild]::VersionGreaterThanOrEquals('$(TargetFrameworkVersion)', '10.0'))">true</_WasmEnableHotReload>

<Target Name="_ImplicitlyReferenceHotReload" BeforeTargets="ProcessFrameworkReferences">
  <ItemGroup Condition="'$(_WasmEnableHotReload)' == 'true'">
    <PackageReference Include="Microsoft.DotNet.HotReload.WebAssembly.Browser"
                      Version="$(NETCoreSdkVersion)" IsImplicitlyDefined="true" />
```

So any `net10.0` WebAssembly client built in Debug gets a `PackageReference` to [`Microsoft.DotNet.HotReload.WebAssembly.Browser`](https://www.nuget.org/packages/Microsoft.DotNet.HotReload.WebAssembly.Browser) at the same version as the SDK. That package carries a `lib.module.js` static web asset. Blazor treats any `*.lib.module.js` in a referenced package as a [JavaScript initializer](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/startup#javascript-initializers), and the Debug publish output wires it in at two places:

```json
// SDK 10.0.101, Debug publish: wwwroot/HrApp.modules.json
[
  "_content/Microsoft.DotNet.HotReload.WebAssembly.Browser/Microsoft.DotNet.HotReload.WebAssembly.Browser.99zm1jdh75.lib.module.js"
]
```

```json
// SDK 10.0.101, Debug publish: boot config inlined in wwwroot/_framework/dotnet.js
"libraryInitializers": [
  { "name": "_content/Microsoft.DotNet.HotReload.WebAssembly.Browser/Microsoft.DotNet.HotReload.WebAssembly.Browser.99zm1jdh75.lib.module.js" }
],
"modulesAfterConfigLoaded": [
  { "name": "../_content/Microsoft.DotNet.HotReload.WebAssembly.Browser/Microsoft.DotNet.HotReload.WebAssembly.Browser.99zm1jdh75.lib.module.js" }
]
```

Blazor's startup code imports that URL with a dynamic `import()` (the repro below logged the `Failed to fetch` line three times for one page load). A Release publish of the same project has neither entry, no `_content/Microsoft.DotNet.HotReload.WebAssembly.Browser` folder, and no `Microsoft.DotNet.HotReload.WebAssembly.Browser.wasm` in `_framework`.

When the file is there and served as JavaScript, it does nothing harmful. The module only switches hot reload on when the boot config's `debugLevel` is not 0 and the page contains the `aspnetcore-browser-refresh` script that `dotnet watch` injects:

```js
// Microsoft.DotNet.HotReload.WebAssembly.Browser 10.0.101, lib.module.js (excerpt)
export async function onRuntimeConfigLoaded(config) {
    if (config.debugLevel !== 0 && globalThis.window?.document?.querySelector("script[src*='aspnetcore-browser-refresh']")) {
        isHotReloadEnabled = true;
        // ...
    }
    config.environmentVariables["__BLAZOR_WEBASSEMBLY_LEGACY_HOTRELOAD"] = "false";
}
```

The error appears when the boot config references the module but the server cannot hand it back as JavaScript. That is a mismatch between what was built and what is on the server: a deployment step that skipped or cleaned `_content`, an incremental deploy that mixed outputs from two builds, or a host that strips unknown folders. The static assets endpoint manifest still claims the file exists, so the request does not fall through to a 404.

## Minimal repro

The steps below reproduce the exact two lines from the question. They need SDK 10.0.101 side by side with whatever you normally use; `dotnet-install.sh` puts it in a throwaway folder in about a minute.

```bash
# .NET SDK 10.0.101, macOS. Install into a scratch folder, not the global dotnet.
curl -sSL https://dot.net/v1/dotnet-install.sh -o di.sh
bash di.sh --version 10.0.101 --install-dir ./dn101 --no-path
export DOTNET_ROOT=$PWD/dn101 PATH=$PWD/dn101:$PATH

mkdir hr101 && cd hr101
echo '{"sdk":{"version":"10.0.101","rollForward":"disable"}}' > global.json
dotnet new blazor -int WebAssembly -n HrApp -o .

# Drop <ImportMap /> to match an app upgraded from .NET 8 (gives the MIME error,
# not the integrity error)
sed -i '' '/<ImportMap/d' HrApp/Components/App.razor

dotnet publish HrApp/HrApp.csproj -c Debug -o ../pub-debug
```

Now simulate a deployment that did not carry the `_content` folder for the package, and run the output as a Staging server:

```bash
# Remove the module from the published output only
rm ../pub-debug/wwwroot/_content/Microsoft.DotNet.HotReload.WebAssembly.Browser/*

cd ../pub-debug
ASPNETCORE_ENVIRONMENT=Staging dotnet HrApp.dll --urls http://localhost:5198
```

Request the module and look at the headers:

```bash
curl -s -D - -o /dev/null \
  http://localhost:5198/_content/Microsoft.DotNet.HotReload.WebAssembly.Browser/Microsoft.DotNet.HotReload.WebAssembly.Browser.99zm1jdh75.lib.module.js
```

```text
HTTP/1.1 200 OK
Content-Length: 0
Date: Sun, 15 Nov 2026 21:09:48 GMT
Server: Kestrel
```

`MapStaticAssets` still has an endpoint for the fingerprinted path (it lives in `HrApp.staticwebassets.endpoints.json`), so instead of a 404 the server answered `200` with an empty body and no `Content-Type`. That is the `MIME type of ""` the browser complains about. Opening `/counter` in the browser logged both lines from the question, and clicking the counter button left it at `Current count: 0`: the failed library initializer stopped the WebAssembly runtime from becoming interactive in this repro. With the module file put back into place and the server unchanged, the same Debug-published app in Staging loaded the module (`Content-Type: text/javascript`), and the counter went to 1.

## Fix 1: publish in Release

This is the right fix for nearly everyone. Since .NET 8, `dotnet publish` defaults to Release for projects targeting .NET 8 or later (`PublishRelease`), and running `dotnet publish HrApp/HrApp.csproj` with no `-c` on SDK 10.0.101 built into `bin/Release` and produced no hot reload files. The Debug output almost always comes from one of these places:

- A Visual Studio publish profile. Open `Properties/PublishProfiles/<name>.pubxml` and check both properties:

  ```xml
  <!-- Visual Studio publish profile, .NET 10 -->
  <PropertyGroup>
    <LastUsedBuildConfiguration>Release</LastUsedBuildConfiguration>
    <Configuration>Release</Configuration>
  </PropertyGroup>
  ```

  In the Publish dialog, this is the "Configuration" field under "Show all settings". Profiles created when the solution was on Debug keep that value.
- A CI script that passes `-c Debug` or `-c $(BuildConfiguration)` with a pipeline variable left on Debug.
- A Dockerfile that runs `dotnet publish -c Debug` for a "staging image".

After redeploying, verify the output rather than the browser cache:

```bash
# .NET SDK 10.x: both should print nothing for a Release publish
grep -o 'HotReload[^"]*lib.module.js' publish/wwwroot/_framework/dotnet.js
ls publish/wwwroot/_content | grep -i hotreload
```

Because `dotnet.js` is fingerprinted and the old one is cached as immutable, a browser that already has the Debug build can keep the old boot config until the page itself is reloaded and refers to the new `dotnet.<hash>.js`. A hard reload after the deployment is enough.

## Fix 2: keep Debug, turn the hot reload reference off

Sometimes a Debug deployment is deliberate, for example a test server where you attach a debugger or want full stack traces in the browser. The SDK honors an explicit `WasmEnableHotReload` before it looks at the configuration, so set it in the **client** project (the one with `Sdk="Microsoft.NET.Sdk.BlazorWebAssembly"`):

```xml
<!-- HrApp.Client.csproj, .NET 10, SDK 10.0.1xx / 10.0.2xx -->
<PropertyGroup>
  <WasmEnableHotReload>false</WasmEnableHotReload>
</PropertyGroup>
```

or only for publishing, from the command line:

```bash
# .NET SDK 10.0.101
dotnet publish HrApp/HrApp.csproj -c Debug -p:WasmEnableHotReload=false -o ../pub-debug-off
```

On SDK 10.0.101 that Debug publish has no `libraryInitializers`, no `HrApp.modules.json` entry for the package, and no `Microsoft.DotNet.HotReload.*` files anywhere. Do not put this in the csproj unconditionally if you use `dotnet watch` against the same project: it also disables WebAssembly hot reload locally. Condition it on your own property (for example `Condition="'$(DeployTarget)' == 'test'"`) or pass it only on publish.

## Fix 3: move to SDK 10.0.300 or later

In February 2026 the SDK team [embedded the hot reload agent in the WebAssembly SDK](https://github.com/dotnet/sdk/pull/52881) for the 10.0.3xx band (a backport of [dotnet/sdk#52816](https://github.com/dotnet/sdk/pull/52816), merged into main for .NET 11). The motivation in the PR was different (duplicate static web asset keys when one server hosts two WASM clients, and unpredictable package versions), but it also changes the shape of the problem. The 10.0.302 targets now copy the module from inside the SDK and register it as a build-only asset under `_framework`:

```xml
<!-- .NET SDK 10.0.302, Microsoft.NET.Sdk.WebAssembly/Sdk/Sdk.targets (excerpt) -->
<_WasmHotReloadModule Include="$(_WasmHotReloadIntermediatePath)Microsoft.DotNet.HotReload.WebAssembly.Browser.lib.module.js">
  <RelativePath>_framework/Microsoft.DotNet.HotReload.WebAssembly.Browser.lib.module.js</RelativePath>
</_WasmHotReloadModule>
...
<DefineStaticWebAssets ... AssetKind="Build" AssetTraitName="JSModule" AssetTraitValue="JSLibraryModule" />
```

`AssetKind="Build"` means it is served by `dotnet run` and `dotnet watch` but not copied by publish. Publishing the same template project with `-c Debug` on SDK 10.0.302 produced no `lib.module.js` and no `libraryInitializers` entry in `dotnet.js`, so there is nothing for the browser to fail on. One leftover worth knowing: that Debug publish still copied `Microsoft.DotNet.HotReload.WebAssembly.Browser.wasm` into `_framework` and listed it in the boot config's assembly list. It is downloaded and never used. Fix 1 removes it too.

The SDK band is chosen by `global.json` or by the newest SDK on the build agent, not by the `net10.0` target framework or the runtime on the server. A build server pinned to `10.0.1xx` keeps the old behavior even after you update the hosting bundle in IIS. If you pin, a `global.json` like this picks up the newer band:

```json
// global.json, .NET SDK 10.0.300+
{
  "sdk": {
    "version": "10.0.300",
    "rollForward": "latestPatch"
  }
}
```

## Fix 4: if the file should be there, deploy all of `wwwroot/_content`

If you keep publishing Debug on 10.0.1xx/2xx and do not want to change anything else, the module must at least reach the server, including the `.br` and `.gz` siblings that `MapStaticAssets` negotiates. Compare the publish folder with the server folder for `wwwroot/_content/Microsoft.DotNet.HotReload.WebAssembly.Browser/`. If it is missing on the server, look for an exclusion in the publish profile (`ExcludeFoldersFromDeployment`, `MsDeploySkipRules`), or a deployment that copies only `wwwroot` files changed since the last build. This is the weakest fix: it ships a development-only assembly and module to production and masks the real configuration problem.

## Gotchas and lookalikes

- **The `Staging` environment does not matter.** `ASPNETCORE_ENVIRONMENT` is a runtime setting of the server; whether this module is referenced is decided at build time by `Configuration`. The WebAssembly side has its own build-time environment too, which is the subject of [the .NET 10 Blazor-Environment header change](/2026/11/fix-blazor-webassembly-dotnet-10-ignores-blazor-environment-header/).
- **Other `_content/...lib.module.js` failures** (from component libraries) have the same mechanics but a different cause: the library's static web assets are not being served or were never part of the build. A close .NET 10 relative is the Blazor script itself going missing because it moved into a NuGet package, covered in [404 for blazor.server.js after installing a new SDK](/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/).
- **A duplicate-key build failure in `FilterStaticWebAssetEndpoints`** when one server project hosts two WASM clients is the other symptom of the package-based design on 10.0.1xx/2xx, and the bug the SDK change was written for. For the more common static web asset collision after an upgrade, see [the conflicting assets fix for ASP.NET Core 10](/2026/09/fix-conflicting-assets-with-the-same-target-path-in-aspnetcore-10/).
- **Hot reload itself not connecting during `dotnet watch`** is a separate problem with the browser refresh WebSocket, not this module. That case is in [the dotnet watch WebSocket fix for custom local domains](/2026/09/fix-dotnet-watch-blazor-hot-reload-websocket-fails-on-custom-local-domain/).
- **Integrity error instead of MIME error.** Same cause, different check order, as shown above. Do not "fix" it by removing `<ImportMap />`.

## Related

- [What is the difference between dotnet build and dotnet publish](/2026/07/what-is-the-difference-between-dotnet-build-and-dotnet-publish/) explains why build-only assets like the 10.0.3xx hot reload module never reach a publish folder.
- [dotnet watch vs dotnet run](/2026/07/what-is-the-difference-between-dotnet-watch-and-dotnet-run/) covers the tool that actually uses this module.
- [OnInitializedAsync not called with prerender: false after upgrading to .NET 10](/2026/11/fix-blazor-oninitializedasync-not-called-prerender-false-after-upgrading-to-dotnet-10/) is another upgrade-time Blazor Web App surprise.

## Sources

- [Stack Overflow: Errors in console after upgrading Blazor web app to .NET 10](https://stackoverflow.com/questions/79861883)
- [dotnet/sdk `src/WasmSdk/Sdk/Sdk.targets` on release/10.0.1xx](https://github.com/dotnet/sdk/blob/release/10.0.1xx/src/WasmSdk/Sdk/Sdk.targets)
- [dotnet/sdk#52881: [release/10.0.3xx] Embed HotReload in WebAssembly SDK](https://github.com/dotnet/sdk/pull/52881) and [dotnet/sdk#52816](https://github.com/dotnet/sdk/pull/52816)
- [Microsoft.DotNet.HotReload.WebAssembly.Browser on NuGet](https://www.nuget.org/packages/Microsoft.DotNet.HotReload.WebAssembly.Browser)
- [ASP.NET Core Blazor startup: JavaScript initializers](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/startup#javascript-initializers)
