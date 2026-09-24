---
title: "Fix: Conflicting assets with the same target path after upgrading to the .NET 10 SDK"
description: "On the .NET 10 SDK every Microsoft.NET.Sdk.Web project gets StaticWebAssetBasePath=/, so a web app referencing another web app collides. Set the base path on the referenced project. Disabling compression does not help."
pubDate: 2026-09-24
template: error-page
tags:
  - "errors"
  - "aspnet-core"
  - "blazor"
  - "dotnet-10"
  - "msbuild"
  - "static-web-assets"
---

Add `<StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>` to the **referenced** project, the one whose `wwwroot` used to show up under `/_content/...`. Since the .NET 10 SDK, every `Microsoft.NET.Sdk.Web` project gets a base path of `/`, so when one web app references another, both publish `css/site.css` to the same URL and the static web assets pipeline refuses to build. Turning compression off does nothing, because the check runs before compression. Everything below was measured on SDK 10.0.302 and SDK 9.0.318 on macOS.

## The error in context

The full message is long, because it dumps both asset records. Trimmed to the parts you need to read:

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'css/site#[.{fingerprint}]?.css'. For assets
'Identity: .../Common/wwwroot/css/site.css, SourceType: Project, SourceId: Common, ContentRoot: .../Common/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' and
'Identity: .../Main/wwwroot/css/site.css, SourceType: Discovered, SourceId: Main, ContentRoot: .../Main/wwwroot/,
 BasePath: /, RelativePath: css/site#[.{fingerprint}]?.css, ...' from different projects.
```

Three fields tell you which case you are in:

- **`SourceId`** names the two projects that produce the asset. Two different ids means a cross-project collision.
- **`SourceType`** is `Discovered` for the project being built, `Project` for a project reference, `Package` for a NuGet package.
- **`BasePath`** is the URL prefix. If the referenced project shows `BasePath: /` instead of `_content/<Name>`, you are looking at the .NET 10 change described below.

The target path sometimes ends in `.gz` or `.br`, which is why this error is usually blamed on the build-time compression that arrived with .NET 9. On the current SDK that is rarely the actual cause.

## Why this happens on the .NET 10 SDK

Static web assets decide at build time which file answers which URL, and the manifest can only map one file to one route. Before .NET 10, a web project that was *referenced* by another web project behaved like a class library: the SDK defaulted its `StaticWebAssetBasePath` to `_content/$(PackageId)`, so its `wwwroot/css/site.css` became `/_content/Common/css/site.css` inside the host, and nothing collided.

The .NET 10 SDK changed `Sdk.Server.props`, the props file every `Microsoft.NET.Sdk.Web` project imports, to set this unconditionally:

```xml
<!-- SDK 10.0.302: Sdks/Microsoft.NET.Sdk.Web/Targets/Sdk.Server.props -->
<PropertyGroup>
  <DebugSymbols Condition="'$(DebugSymbols)' == ''">true</DebugSymbols>
  <StaticWebAssetProjectMode>Root</StaticWebAssetProjectMode>
  <StaticWebAssetBasePath>/</StaticWebAssetBasePath>
</PropertyGroup>
```

The same file in SDK 9.0.318 does not set either property. The `_content/$(PackageId)` default in `Microsoft.NET.Sdk.StaticWebAssets.targets` only applies when `StaticWebAssetBasePath` is empty, and on SDK 10 it never is for a web project. Both web apps now claim `/`, and every file that exists at the same relative path in both `wwwroot` folders is a conflict.

The ASP.NET Core team's position, from [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138), is that a web app referencing a web app was never a supported shape: "Only class libraries or Blazor apps can be referenced by webapps in a supported capacity." The issue was closed without a code change, and as of today the move is not listed on either the [.NET 10 breaking changes page](https://learn.microsoft.com/en-us/dotnet/core/compatibility/10) or the [ASP.NET Core 10 breaking changes page](https://learn.microsoft.com/en-us/aspnet/core/breaking-changes/10/overview). That is why so many upgrades hit it cold.

It is the **SDK** that decides this, not your target framework. A `net8.0` or `net9.0` project fails the same way the moment it builds on SDK 10.x, which is what [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726) reported for a `netcoreapp8.0` app.

## Minimal repro

Two empty web apps, each with its own `wwwroot/css/site.css`, one referencing the other:

```bash
# SDK 10.0.302
dotnet new web -o Main -n Main
dotnet new web -o Common -n Common
mkdir -p Main/wwwroot/css Common/wwwroot/css
echo "body{color:red}/*Main*/"   > Main/wwwroot/css/site.css
echo "body{color:red}/*Common*/" > Common/wwwroot/css/site.css
dotnet add Main/Main.csproj reference Common/Common.csproj
dotnet build Main
```

Measured results for this exact pair of projects:

| SDK | TargetFramework | Result |
| --- | --- | --- |
| 9.0.318 | net9.0 | Build succeeded. Routes: `css/site.css`, `_content/Common/css/site.css` |
| 10.0.302 | net9.0 | `Conflicting assets with the same target path 'css/site#[.{fingerprint}]?.css'` |
| 10.0.302 | net10.0 | Same error |
| 10.0.302 | net10.0, `-p:DisableBuildCompression=true` | Same error |
| 10.0.302 | net10.0, `-p:CompressionEnabled=false` | Same error |
| 10.0.302 | net10.0, after `rm -rf */bin */obj` | Same error |

The last three rows are the ones worth remembering. The advice that shows up first in search results for this error is to disable compression or delete `bin` and `obj`. Neither changes anything for this cause. The conflict is raised by `GenerateStaticWebAssetsManifest` at line 640 of the targets file, which runs whether compression is enabled or not.

## Fix: give the referenced project its old base path back

Put the property in the csproj of the project being referenced (`Common` here), not the host:

```xml
<!-- Common.csproj, SDK 10.0.302 -->
<Project Sdk="Microsoft.NET.Sdk.Web">

  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <StaticWebAssetBasePath>_content/$(MSBuildProjectName)</StaticWebAssetBasePath>
  </PropertyGroup>

</Project>
```

Setting it in the project file works because the SDK sets `/` in a props file, which is evaluated before your project body, so your value wins. After the change, `dotnet build Main` succeeds and `Main.staticwebassets.endpoints.json` contains both sets of routes:

```text
_content/Common/css/site.css
_content/Common/css/site.css.gz
css/site.css
css/site.css.gz
(plus the fingerprinted variants of each)
```

I ran the host with `app.MapStaticAssets()` and requested both URLs. `/css/site.css` returned the `Main` file and `/_content/Common/css/site.css` returned the `Common` file, each with `Content-Encoding: gzip` when the request allowed it. So the compressed variants are generated per project exactly as before.

The base path only applies to consumers. I ran `Common` on its own after the change and `/css/site.css` still returned 200, while `/_content/Common/css/site.css` returned 404. A project that is both a standalone app and a reference keeps working in both roles.

### Do not use `$(PackageId)` here

The obvious way to recreate the old default is `_content/$(PackageId)`, since that is what the SDK used to compute. It does not work from the csproj. `PackageId` is assigned later, in the NuGet targets, so at the point your `PropertyGroup` is evaluated it is still empty. I tried it: the build succeeded, but the routes became `_content/css/site.css`. That silently breaks every `<link href="_content/Common/...">` in your views while looking like a fix. Use `$(MSBuildProjectName)`, or write the name out literally if your `AssemblyName` differs from the project file name and your markup uses the assembly name.

### Better: stop referencing a web app

If `Common` exists only to share Razor views, components, and `wwwroot` files, turn it into a Razor class library (`Microsoft.NET.Sdk.Razor`). That is the supported shape, it gets `_content/{PackageId}` by default, and it is how the [Blazor static files docs](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) describe sharing assets. Keep the base-path property for the cases where the referenced project genuinely has to run as an app too, such as an integration test host built on `Microsoft.NET.Sdk.Web` that references the real app.

## The same file in two projects of a Blazor Web App

The second common trigger has nothing to do with web-to-web references. In a Blazor Web App with interactive WebAssembly, the server project and the `.Client` project both contribute to `/`. That is by design: the client's assets are served from the root of the host.

So a file that exists in both `wwwroot` folders collides. I reproduced it with the `dotnet new blazor -int WebAssembly` template on SDK 10.0.302 by copying `favicon.png` into `W.Client/wwwroot`:

```text
Microsoft.NET.Sdk.StaticWebAssets.targets(640,5): error : Conflicting assets with the same target path
'favicon#[.{fingerprint}]?.png'. For assets 'Identity: .../W.Client/wwwroot/favicon.png, SourceType: Project, ...
```

Here the fix is not a base path. You do not want the client's files moved under `_content/`. Keep each file in exactly one of the two projects. A useful rule: assets needed only by server-rendered markup live in the server project; assets the WebAssembly code loads at runtime live in `.Client`. If you migrated from the old hosted Blazor WebAssembly template, where the client project owned `index.html`, `favicon`, and the CSS, this is the usual leftover. The [comparison of Blazor hosting models](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/) covers why the two projects share a root.

## When compression really is the cause

Build-time compression landed in .NET 9, and during the .NET 9 previews it did cause this error. Packages such as `Z.Blazor.Diagrams` 3.0.2 and some bundler setups shipped their own `.gz` files in `wwwroot`. The SDK then tried to generate `app.js.gz` for the same asset and collided with the one that was already there ([dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512), [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413)).

That was fixed by [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518), closed in November 2024. The current SDK runs a `DiscoverPrecompressedAssets` task that recognizes an existing `.gz` or `.br` sibling and treats it as the compressed variant instead of producing its own. I checked both cases on SDK 10.0.302:

- A web app with `wwwroot/js/app.js`, `app.js.gz`, and `app.js.br` checked in: build and publish succeed with zero warnings. The endpoints manifest maps `js/app.js` to `js/app.js.gz` with a `gzip` selector, and the published `app.js.gz` is byte-identical to the file I created. Your file is served, not a regenerated one.
- A web app referencing `Z.Blazor.Diagrams` 3.0.2, the package from #57512: builds cleanly.

So if you are on an SDK 9.0.1xx preview, update the SDK. If you still need to exclude specific files from compression, for example because a bundler already writes its own `.br` with better settings, use the exclusion list rather than turning the feature off. I verified this one on SDK 10.0.302: after publish, `app.bundle.js` had no `.gz` or `.br` sibling while `other.js` in the same folder had both.

```xml
<!-- Host .csproj, SDK 9.0.100 and later -->
<PropertyGroup>
  <CompressionExcludePatterns>$(CompressionExcludePatterns);**/*.bundle.js</CompressionExcludePatterns>
</PropertyGroup>
```

`DisableBuildCompression=true` skips compression for `dotnet build` only (publish still compresses), and `CompressionEnabled=false` removes the compression targets entirely. Both are reasonable for build speed. Neither fixes a base-path collision, as the table above shows. Runtime response compression is a separate feature again; see [adding response compression to an ASP.NET Core API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/) for that side.

## Gotchas and lookalikes

**"Two assets found targeting the same path with incompatible asset kinds" is a different error.** You get it inside a *single* project, for example when a `<Content Include="shared/app.js" Link="wwwroot/js/app.js" />` item points at the same route as a real `wwwroot/js/app.js`. I reproduced it on SDK 10.0.302 from line 706 of the same targets file. Remove one of the two items.

**`The "DiscoverPrecompressedAssets" task failed unexpectedly` with `An item with the same key has already been added`** is a related .NET 10 bug, also triggered by one web project referencing another, often with the key pointing at `blazor.web.js` in `microsoft.aspnetcore.app.internal.assets`. It is still open as [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089). The base-path fix above is the first thing to try, because it removes the duplicate registration at the source. If you are also chasing a missing Blazor script after the upgrade, that package is explained in [the blazor.server.js 404 post](/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/).

**If the error comes and goes between builds**, suspect a build step that writes into `wwwroot` (TypeScript, LibMan, a JS bundler) while the static web assets targets are reading it. [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014) documents a race that surfaces as this error, `No file exists for the asset`, or `The asset ... can not be found`. It reproduces with a single target framework too. The reliable fix is to run the generator as its own step before MSBuild (`npm run build && dotnet build` in CI and in your launch profile) instead of from a `BeforeTargets="Build"` target, so the files are already on disk when the SDK evaluates the `wwwroot` glob. A binlog (`dotnet build -bl`) shows the ordering; the [binlog MCP server](/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/) is a quick way to query it.

**Pinning SDK 9 with `global.json` works, but only as a stopgap.** The repro builds fine on 9.0.318 even with the .NET 10 SDK installed side by side. It also means you cannot build `net10.0` projects, and it leaves the actual collision for later. [dotnetup](/2026/06/dotnetup-official-dotnet-sdk-version-manager/) makes switching SDKs cheap if you need to bisect which SDK introduced a failure in your repo.

**The old "remove every `.gz` StaticWebAsset" target is obsolete.** The workaround from #57512 that deletes `StaticWebAsset` items with extension `.gz` before `ResolveStaticWebAssetsConfiguration` was for .NET 9 previews. On SDK 10 it throws away pre-compressed files the SDK now handles correctly, and it does nothing for the base-path case.

## Related

- [Fix: 404 Not Found for blazor.server.js after installing a new .NET SDK](/2026/08/fix-404-not-found-for-blazor-server-js-after-installing-a-new-dotnet-sdk/), another static web assets change that arrives with the SDK rather than the target framework.
- [Blazor Server vs Blazor WebAssembly vs Blazor United in .NET 11](/2026/05/blazor-server-vs-webassembly-vs-united-in-dotnet-11/), for why the server and `.Client` projects share `/`.
- [How to add response compression to an ASP.NET Core 11 API](/2026/07/how-to-add-response-compression-to-an-aspnetcore-11-api/), the runtime counterpart to build-time asset compression.
- [An MCP server for .NET binlogs](/2026/06/dotnet-binlog-mcp-server-ai-investigates-msbuild-builds/), for tracing which target produced a conflicting asset.
- [dotnetup, the official .NET SDK version manager](/2026/06/dotnetup-official-dotnet-sdk-version-manager/), for testing a repo against several SDKs.

## Sources

- [dotnet/aspnetcore#62138](https://github.com/dotnet/aspnetcore/issues/62138): SDK 10 preview 5 regression, the `StaticWebAssetBasePath` workaround, and the "not supported" resolution.
- [dotnet/aspnetcore#64726](https://github.com/dotnet/aspnetcore/issues/64726): the same error on a `netcoreapp8.0` app after installing the new SDK.
- [dotnet/aspnetcore#57512](https://github.com/dotnet/aspnetcore/issues/57512) and [dotnet/aspnetcore#57518](https://github.com/dotnet/aspnetcore/issues/57518): pre-compressed package assets in .NET 9 and the fix.
- [dotnet/sdk#40413](https://github.com/dotnet/sdk/issues/40413): compression settings (`DisableBuildCompression`, `BuildCompressionFormats`, `CompressionExcludePatterns`).
- [dotnet/sdk#52089](https://github.com/dotnet/sdk/issues/52089) and [dotnet/sdk#52014](https://github.com/dotnet/sdk/issues/52014): open .NET 10 static web assets bugs with overlapping symptoms.
- [ASP.NET Core Blazor static files](https://learn.microsoft.com/en-us/aspnet/core/blazor/fundamentals/static-files?view=aspnetcore-10.0) on Microsoft Learn.
- SDK sources inspected locally: `Sdk.Server.props`, `Microsoft.NET.Sdk.StaticWebAssets.targets`, and `Microsoft.NET.Sdk.StaticWebAssets.Compression.targets` from SDK 10.0.302 and 9.0.318.
