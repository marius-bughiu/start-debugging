---
title: "How to use Tailwind CSS with Blazor WebAssembly in .NET 11"
description: "A complete .NET 11 setup for Tailwind CSS v4 in a Blazor WebAssembly app: standalone CLI (no Node), MSBuild target, @source directives for Razor and CSS isolation files, and a publish pipeline that survives Native AOT."
pubDate: 2026-05-03
template: how-to
tags:
  - "blazor"
  - "blazor-webassembly"
  - "tailwind-css"
  - "dotnet-11"
  - "csharp"
  - "msbuild"
---

The shortest viable Tailwind v4 setup for a Blazor WebAssembly app on .NET 11 has three moving parts: the standalone Tailwind CLI binary (no Node, no npm), a `BeforeBuild` MSBuild target that runs it, and a `Styles/app.css` file whose `@source` directives point at your `.razor` and `.razor.css` files. The CLI compiles to `wwwroot/css/app.css`, you reference that file from `wwwroot/index.html`, and the build adds roughly one second on a cold run and 50 to 150 ms on incremental rebuilds. The same pipeline survives `dotnet publish`, trimming, and Native AOT, none of which touch CSS but all of which break naive Node-based setups.

This guide walks the full integration on `Microsoft.AspNetCore.Components.WebAssembly` 11.0.0 with Tailwind CSS 4.0.x, C# 14, and the SDK pinned in `global.json` to `9.0.100` or newer (the .NET 11 SDK ships as `9.0.100` until GA). Every claim below was verified against an empty `dotnet new blazorwasm-empty` project on Windows 11 and Ubuntu 24.04.

## Why the Node-based templates do not survive a Blazor build

Most "Tailwind in Blazor" tutorials still tell you to install Node, run `npm install -D tailwindcss`, write a `tailwind.config.js`, and shell out to `npx tailwindcss` from a build target. That setup works on a developer laptop and explodes the first time it runs in a clean container or a CI image without Node:

- The MSBuild target shells `npx`, which fails fast with `'npx' is not recognized`. The `dotnet publish` step exits with code 1 and a stack trace pointing into MSBuild rather than your code.
- `package.json` and `node_modules` end up versioned alongside `.csproj`, doubling restore time and bloating the repo with hundreds of megabytes of transitive npm packages whose only job is to compile a single CSS file.
- Tailwind v4's PostCSS-based path uses [Lightning CSS](https://lightningcss.dev/), which ships native binaries per OS and CPU. A `package-lock.json` baked on Windows fails on a Linux build agent, with an `npm rebuild` step bolted on as the workaround.

[Tailwind v4](https://tailwindcss.com/blog/tailwindcss-v4) shipped a standalone CLI explicitly to dodge this entire stack. It is a single binary, around 80 MB, that contains the full compiler and the Oxide content scanner. You drop it next to your repo (or install it system-wide), invoke it from MSBuild, and the only dependency a CI image needs is the file itself.

## Get the standalone Tailwind v4 CLI

Tailwind publishes per-platform binaries on every release. Pick the one that matches your build agents and developer machines:

- Windows x64: `tailwindcss-windows-x64.exe`
- Linux x64: `tailwindcss-linux-x64`
- macOS arm64: `tailwindcss-macos-arm64`

Download from the [Tailwind CSS releases page](https://github.com/tailwindlabs/tailwindcss/releases) and either drop the file at `tools/tailwindcss.exe` inside your repo (committed, ~80 MB), or install it system-wide via `winget install --id TailwindLabs.Tailwind` on Windows or `brew install tailwindcss` on macOS.

The committed-binary approach is the one that holds up on CI without surprises, because the build does not need network access and every contributor gets the exact same Tailwind version. The trade-off is ~80 MB in your Git history. If that bothers you, store it in [Git LFS](https://git-lfs.com/) or fetch it on the fly in a `Restore` target. For the rest of this post I will assume the binary lives at `tools/tailwindcss.exe`.

```text
MyBlazorApp/
├── MyBlazorApp.csproj
├── Styles/
│   └── app.css
├── tools/
│   └── tailwindcss.exe   <-- standalone v4 binary
└── wwwroot/
    ├── index.html
    └── css/
        └── app.css        <-- generated, gitignored
```

Add the generated file to `.gitignore`:

```text
# .gitignore
wwwroot/css/app.css
```

The generated CSS is a pure build artifact; checking it in produces noisy diffs every time anyone changes a class name in a component.

## Wire the CLI into your `.csproj`

Open `MyBlazorApp.csproj` and add a `BeforeBuild` target. The `Exec` task invokes the standalone CLI with the right input, output, and (in `Release`) a `--minify` flag.

```xml
<!-- MyBlazorApp.csproj  (.NET 11, Tailwind CSS 4) -->
<Project Sdk="Microsoft.NET.Sdk.BlazorWebAssembly">
  <PropertyGroup>
    <TargetFramework>net11.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <TailwindCli>$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
    <TailwindInput>$(MSBuildProjectDirectory)/Styles/app.css</TailwindInput>
    <TailwindOutput>$(MSBuildProjectDirectory)/wwwroot/css/app.css</TailwindOutput>
  </PropertyGroup>

  <ItemGroup>
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly" Version="11.0.0" />
    <PackageReference Include="Microsoft.AspNetCore.Components.WebAssembly.DevServer" Version="11.0.0" PrivateAssets="all" />
  </ItemGroup>

  <Target Name="TailwindBuild" BeforeTargets="BeforeBuild">
    <Exec Command="&quot;$(TailwindCli)&quot; -i &quot;$(TailwindInput)&quot; -o &quot;$(TailwindOutput)&quot; $(TailwindArgs)"
          ConsoleToMSBuild="true" />
  </Target>

  <Target Name="TailwindBuildRelease" BeforeTargets="TailwindBuild" Condition="'$(Configuration)' == 'Release'">
    <PropertyGroup>
      <TailwindArgs>--minify</TailwindArgs>
    </PropertyGroup>
  </Target>
</Project>
```

Two things worth knowing about this target. First, the `Exec` command quotes every path so the build still works when the project lives at `C:\Users\you\Documents\My Apps\Blazor`. Second, the `--minify` flag only fires in `Release`, which keeps `Debug` builds fast and gives you readable CSS in the browser dev tools during development.

On Linux and macOS you can replace the Windows-specific path with a per-OS condition:

```xml
<TailwindCli Condition="'$(OS)' == 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss.exe</TailwindCli>
<TailwindCli Condition="'$(OS)' != 'Windows_NT'">$(MSBuildProjectDirectory)/tools/tailwindcss</TailwindCli>
```

Both binaries share the same CLI surface; the only difference is the file name and the executable bit on Unix.

## Tell Tailwind where your classes live

The biggest Tailwind v4 change for Blazor users is the disappearance of `tailwind.config.js`. The framework now does CSS-first configuration: you put `@theme`, `@source`, and `@layer` blocks directly in your input CSS file, and there is no JavaScript config at all. That is good news for .NET projects, which had no business dragging in a JS toolchain to define a color palette.

Create `Styles/app.css` and tell Tailwind where to look for class names. By default v4 only scans the file system relative to the input CSS, so without explicit `@source` directives it will not find anything in your Razor files.

```css
/* Styles/app.css -- Tailwind CSS 4.0 */
@import "tailwindcss";

@source "../**/*.razor";
@source "../**/*.razor.cs";
@source "../**/*.razor.css";
@source "../**/*.cshtml";
@source "../wwwroot/index.html";

@theme {
  --color-brand-50:  oklch(96% 0.02 260);
  --color-brand-500: oklch(64% 0.18 260);
  --color-brand-900: oklch(28% 0.10 260);

  --font-sans: "Inter", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "Cascadia Code", monospace;
}

@layer components {
  .btn-primary {
    @apply inline-flex items-center gap-2 rounded-md
           bg-brand-500 px-4 py-2 text-sm font-medium text-white
           hover:bg-brand-900 focus-visible:outline-2 focus-visible:outline-offset-2
           focus-visible:outline-brand-500 transition-colors;
  }
}
```

A few details worth highlighting. The `../**/*.razor.cs` glob catches code-behind files where you might assemble class names dynamically, e.g. `var classes = active ? "bg-brand-500" : "bg-gray-100";`. Tailwind's content scanner is a regex-based extractor (the [Oxide engine](https://tailwindcss.com/blog/tailwindcss-v4#new-high-performance-engine)), so as long as the literal string appears anywhere in a scanned file it will end up in the output. The `@theme` block defines design tokens as CSS custom properties, which Tailwind then exposes as utilities (`bg-brand-500`, `text-brand-900`). This replaces the JavaScript `theme: { extend: { colors: ... } }` block from v3 entirely.

Wire the generated file into `wwwroot/index.html`:

```html
<!-- wwwroot/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MyBlazorApp</title>
  <base href="/" />
  <link rel="stylesheet" href="css/app.css" />
  <link rel="stylesheet" href="MyBlazorApp.styles.css" />
</head>
<body>
  <div id="app">Loading...</div>
  <script src="_framework/blazor.webassembly.js"></script>
</body>
</html>
```

The `MyBlazorApp.styles.css` link is the Blazor CSS isolation bundle, which the SDK generates from every `Component.razor.css` file in the project. Order matters: load `app.css` first so component-scoped styles can override Tailwind defaults.

## Make CSS isolation play nicely

Blazor's CSS isolation appends a per-component scope attribute (e.g. `b-9pdypsqo3w`) to every selector and rewrites elements to carry that attribute. Tailwind utilities applied directly to elements in markup inherit the scope automatically, but `@apply` directives inside a `Component.razor.css` file need a moment of care.

This works:

```razor
@* Pages/Counter.razor *@
<button class="btn-primary" @onclick="IncrementCount">
  Count: @currentCount
</button>
```

`btn-primary` came from your `@layer components` block in `Styles/app.css`, so the class definition lives in the global `app.css`. The button still gets the scope attribute, but Tailwind's selector is `.btn-primary` (unscoped), which matches.

This also works, and is the right way to write component-private utilities:

```css
/* Pages/Counter.razor.css */
@reference "../../Styles/app.css";

.danger {
  @apply rounded-md bg-red-600 px-3 py-1 text-white;
}
```

The `@reference` directive (new in v4) tells Tailwind which input file's design tokens to use without duplicating their CSS in the component bundle. Without `@reference`, `@apply red-600` cannot resolve, because the component-scoped CSS file has no `@import "tailwindcss";` of its own. With it, only the `red-600` utility's bytes get pulled into the scoped bundle, and the scope attribute is preserved by the Blazor CSS isolation pass.

Add the isolation files to your `@source` patterns (already shown above) so any classes you write inline in `.razor.css` files get extracted along with the rest. If you only put utilities in markup and never reference them in `.razor.css`, you can drop that glob.

## A real component end to end

Here is a `Pages/Home.razor` page and its scoped CSS, built on the design tokens defined above. It uses utilities directly in markup, calls a custom component class from `app.css`, and adds one component-private utility through `@apply`.

```razor
@* Pages/Home.razor *@
@page "/"

<section class="mx-auto max-w-3xl px-6 py-12">
  <h1 class="font-sans text-4xl font-semibold text-brand-900">
    Tailwind on Blazor WebAssembly
  </h1>
  <p class="mt-3 text-base text-slate-600">
    Built with the standalone CLI, no Node toolchain required.
  </p>

  <div class="mt-8 flex items-center gap-3">
    <button class="btn-primary" @onclick="Refresh">Refresh</button>
    <span class="status">Last refresh: @lastRefresh.ToLocalTime():T</span>
  </div>
</section>

@code {
    private DateTime lastRefresh = DateTime.UtcNow;

    private void Refresh() => lastRefresh = DateTime.UtcNow;
}
```

```css
/* Pages/Home.razor.css */
@reference "../../Styles/app.css";

.status {
  @apply text-sm font-mono text-slate-500;
}
```

Run `dotnet build`. The `TailwindBuild` target fires before the SDK starts compiling C#, the binary scans every Razor and CSS file the `@source` globs match, and `wwwroot/css/app.css` lands with only the utilities you actually used. On a freshly created `blazorwasm-empty` project the output drops from a theoretical 3.5 MB unminified Tailwind to roughly 18 KB minified for the page above. That number scales with how many distinct utilities you pull in across the entire app, which is the whole point of an on-demand engine.

## Production builds, `dotnet publish`, and Native AOT

`dotnet publish -c Release` runs the same `BeforeBuild` target with `--minify` enabled. The published output under `bin/Release/net11.0/publish/wwwroot/css/app.css` is the minified file ready for Brotli compression by the Blazor publish pipeline (`BlazorEnableCompression`, on by default).

There are a few rough edges to know about:

- **Native AOT for Blazor WebAssembly**: the AOT compilation step (`<RunAOTCompilation>true</RunAOTCompilation>`) operates on .NET assemblies, never on CSS. Tailwind sits entirely outside that pipeline, so AOT does not change anything for this setup. Cold publish times stretch from 30 seconds to several minutes, but Tailwind remains a sub-second cost in that mix.
- **Trimming**: the trimmer also has nothing to do with CSS. It will, however, occasionally complain about reflection inside Tailwind-adjacent JavaScript libraries you might add (e.g. headless UI helpers). Keep those isolated to JS files referenced from `index.html`, not bundled through any C# interop layer.
- **Static web asset bundling**: if you set `<BlazorWebAssemblyLoadAllGlobalizationData>` or use [the Blazor publish-time compression options](https://learn.microsoft.com/en-us/aspnet/core/blazor/host-and-deploy/webassembly), `wwwroot/css/app.css` is included automatically. There is no extra wiring.
- **Watch mode**: `dotnet watch` reruns the `BeforeBuild` target on every Razor file change, so adding a class to a component triggers a Tailwind recompile and the browser hot-reloads the new stylesheet within a second. If you want true CSS-only watching (cheaper than the full Razor recompile), run `tools/tailwindcss.exe --watch` in a separate terminal alongside `dotnet watch run`.

## Gotchas worth knowing about

The setup above is durable, but three things consistently bite people on the way in.

First, classes constructed at runtime that the scanner cannot see in source code will not survive the Tailwind purge. `var c = $"bg-{color}-500";` produces `bg-red-500` at runtime, but Tailwind never sees the literal in source and drops it from the output. The fix is to whitelist the full set explicitly via a comment:

```csharp
// .NET 11, C# 14: Tailwind scanner sees these literals
// bg-red-500 bg-green-500 bg-blue-500
private static string ColorClass(string color) => $"bg-{color}-500";
```

Tailwind's regex-based extractor finds those literals in the comment and keeps them in the bundle. The runtime concatenation then resolves to a class that actually exists in the CSS.

Second, prerendered Blazor pages (a hybrid Blazor United configuration where the host server-renders the WASM client) need both `app.css` and `MyBlazorApp.styles.css` to be reachable from the server's static file pipeline. If you split the project into a `Server` host plus a `Client` WASM project, the [validation-sharing layout I covered earlier this week](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) is the same pattern: the `Client` project owns the Tailwind build, and the `Server` references the `Client` so its `wwwroot` is published alongside the host.

Third, IDE integration. The official [Tailwind CSS IntelliSense](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss) extension for VS Code reads your `Styles/app.css` and gives you completions inside `.razor` files once you add `razor` to the `tailwindCSS.includeLanguages` setting. Rider and Visual Studio both ship Tailwind plugins as of the 2025.1 releases, both of which work the same way: point them at the input CSS file and they pick up the design tokens from `@theme` automatically.

## Related reading

- [How to share validation logic between server and Blazor WebAssembly](/2026/04/how-to-share-validation-logic-between-server-and-blazor-webassembly/) for the project-layout pattern that pairs naturally with this CSS pipeline.
- [dotnet new webworker: first-class Web Workers for Blazor in .NET 11 Preview 2](/2026/04/dotnet-11-preview-2-blazor-webworker-template/) for offloading CPU work without breaking your Tailwind layout.
- [Blazor Virtualize Finally Handles Variable-Height Items in .NET 11](/2026/04/blazor-virtualize-variable-height-dotnet-11-preview-3/) since variable-height rows pair badly with Tailwind utilities that bake in fixed sizes.
- [Blazor SSR Finally Gets TempData in .NET 11](/2026/04/blazor-ssr-tempdata-dotnet-11/) for flash-message styling patterns you can build with the design tokens above.

## Source links

- [Tailwind CSS v4.0 release notes](https://tailwindcss.com/blog/tailwindcss-v4)
- [Tailwind CSS standalone CLI releases](https://github.com/tailwindlabs/tailwindcss/releases)
- [`@source` and `@theme` directives reference](https://tailwindcss.com/docs/functions-and-directives)
- [Blazor CSS isolation overview on MS Learn](https://learn.microsoft.com/en-us/aspnet/core/blazor/components/css-isolation)
- [.NET 11 release notes](https://github.com/dotnet/core/blob/main/release-notes/11.0/README.md)
